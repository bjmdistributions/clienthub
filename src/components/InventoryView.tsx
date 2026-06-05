import { useEffect, useState } from "react";
import { api, Lot, Deal, ManifestAnalysis } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, Package, ChevronDown, Link2, Upload, Clipboard, BarChart3, FileDown, Image, ChevronLeft, ChevronRight, MessageCircle, Mail, ShieldCheck, Truck, MapPin, DollarSign, Ban, Trash2, RefreshCw, CheckSquare, Check } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";

const STATUS_FILTERS = ["all", "available", "reserved", "sold", "archived"] as const;
type StatusFilter = typeof STATUS_FILTERS[number] | "all";

const statusColor = (s: string) => {
  switch (s) { case "available": return "bg-emerald-100 text-emerald-800"; case "reserved": return "bg-blue-100 text-blue-800"; case "sold": return "bg-gray-100 text-gray-600"; case "archived": return "bg-amber-100 text-amber-800"; default: return "bg-gray-100 text-gray-700"; }
};

const inp = "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

// Photos are stored as device-independent relative paths ("media/<uuid>.jpg")
// inside the synced folder. Legacy absolute paths are passed through as-is.
const isAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
const resolvePhoto = (p: string, base: string) => (isAbsPath(p) || !base) ? p : `${base}/${p}`;

export default function InventoryView() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Lot | null>(null);
  const [showSold, setShowSold] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [linkModal, setLinkModal] = useState<string | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [mediaBase, setMediaBase] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const load = async () => { const l = await api.listInventory(); setLots(l); };
  useEffect(() => {
    load();
    api.listSuppliers().then((s) => setSuppliers(s.map((x) => x.name).filter(Boolean))).catch(() => {});
    api.mediaBaseDir().then(setMediaBase).catch(() => {});
  }, []);

  const setStatus = async (lot: Lot, status: string) => {
    try { await api.setLotStatus(lot.id, status); load(); }
    catch (e: any) { alert(e); }
  };

  // Toggle the "sent on WhatsApp / email" flags right from the card.
  // Optimistic update for snappy UX, then persist (and sync).
  const toggleSent = async (lot: Lot, channel: "whatsapp" | "email") => {
    const prop = channel === "whatsapp" ? "sent_whatsapp" : "sent_email";   // Lot property (snake)
    const arg  = channel === "whatsapp" ? "sentWhatsapp" : "sentEmail";       // Tauri arg (camel)
    const next = !lot[prop];
    setLots((prev) => prev.map((l) => (l.id === lot.id ? { ...l, [prop]: next } : l)));
    try { await api.updateLot(lot.id, { [arg]: next }); }
    catch (e: any) { alert(e); load(); }
  };

  const openLink = async (lotId: string) => {
    setLinkModal(lotId);
    try { setDeals(await api.listDeals()); } catch {}
  };

  // ── Multi-select / bulk actions ──
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelected((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };

  const deleteOne = async (lot: Lot) => {
    if (!confirm(`Delete "${lot.name}"? This cannot be undone.`)) return;
    try { await api.deleteLot(lot.id); setDetailId(null); load(); } catch (e: any) { alert(e); }
  };
  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected lot${selected.size !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    try { await api.deleteLots([...selected]); exitSelect(); load(); } catch (e: any) { alert(e); }
  };
  const bulkStatus = async (status: string) => {
    if (selected.size === 0) return;
    try { for (const id of selected) await api.setLotStatus(id, status); exitSelect(); load(); } catch (e: any) { alert(e); }
  };
  const bulkSent = async (channel: "whatsapp" | "email", val: boolean) => {
    if (selected.size === 0) return;
    const arg = channel === "whatsapp" ? "sentWhatsapp" : "sentEmail";
    try { for (const id of selected) await api.updateLot(id, { [arg]: val }); exitSelect(); load(); } catch (e: any) { alert(e); }
  };
  const resync = async () => {
    try { const n = await api.resyncInventory(); showToast(`Re-synced ${n} lot${n !== 1 ? "s" : ""} to your devices`); }
    catch (e: any) { alert(e); }
  };
  // In select mode the card click selects instead of opening detail.
  const onCardOpen = (id: string) => { if (selectMode) toggleSelect(id); else setDetailId(id); };

  // "All" hides sold/archived unless their toggles are on, so its count must
  // match what's actually visible — otherwise it shows e.g. "2" with an empty list.
  const visibleUnderAll = lots.filter(l => {
    if (l.status === "sold" && !showSold) return false;
    if (l.status === "archived" && !showArchived) return false;
    return true;
  }).length;
  const counts = { all: visibleUnderAll, available: lots.filter(l => l.status === "available").length, reserved: lots.filter(l => l.status === "reserved").length, sold: lots.filter(l => l.status === "sold").length, archived: lots.filter(l => l.status === "archived").length };
  const totalUnits = lots.reduce((sum, l) => sum + (l.quantity || 0), 0);
  const filtered = lots.filter(l => {
    if (filter !== "all" && l.status !== filter) return false;
    if ((l.status === "sold" || l.status === "archived") && filter === "all") {
      if (l.status === "sold" && !showSold) return false;
      if (l.status === "archived" && !showArchived) return false;
    }
    return true;
  });

  const margin = (lot: Lot) => lot.total_cost > 0 ? `${(((lot.asking_price - lot.total_cost) / lot.total_cost) * 100).toFixed(0)}%` : "—";
  const marginPct = (lot: Lot) => lot.total_cost > 0 ? ((lot.asking_price - lot.total_cost) / lot.total_cost) * 100 : 0;
  // Cost & price are per-unit, so total profit = per-unit margin × quantity.
  const profit = (lot: Lot) => (lot.asking_price - lot.total_cost) * lot.quantity;

  const handleExportInventory = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "inventory.csv" });
    if (!path) return;
    const count = await api.exportInventoryCsv(filter === "all" ? null : filter, path as string);
    alert(`Exported ${count} inventory lots to CSV.`);
  };

  return (
    <div>
      {toast && (
        <div className="fixed bottom-5 right-5 bg-[#1A1A1E] text-white px-4 py-2.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[13px] z-50 animate-fade-in">
          {toast}
        </div>
      )}
      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Inventory</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">{counts.all} lots · {totalUnits.toLocaleString()} units total</p>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <button onClick={exitSelect} className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          ) : (
            <>
              <button onClick={resync} title="Re-sync all inventory to your other devices"
                className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50 transition-colors">
                <RefreshCw size={13} /> Sync
              </button>
              <button onClick={() => setSelectMode(true)}
                className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50 transition-colors">
                <CheckSquare size={13} /> Select
              </button>
              <button onClick={handleExportInventory}
                className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50 transition-colors">
                <FileDown size={13} /> Export
              </button>
              <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
                <Plus size={14} /> Add Lot
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectMode && (
        <div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 shadow-sm">
          <span className="text-[13px] font-semibold text-gray-700 mr-1">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set(filtered.map((l) => l.id)))} className="text-[12px] text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded hover:bg-indigo-50">Select all</button>
          <div className="flex-1" />
          <button onClick={() => bulkStatus("sold")} disabled={!selected.size} className="text-[12px] text-emerald-700 border border-emerald-200 px-2.5 h-8 rounded-lg hover:bg-emerald-50 disabled:opacity-40 flex items-center gap-1"><DollarSign size={12} /> Sold</button>
          <button onClick={() => bulkStatus("archived")} disabled={!selected.size} className="text-[12px] text-red-600 border border-red-200 px-2.5 h-8 rounded-lg hover:bg-red-50 disabled:opacity-40 flex items-center gap-1"><Ban size={12} /> Unavailable</button>
          <button onClick={() => bulkSent("whatsapp", true)} disabled={!selected.size} className="text-[12px] text-gray-600 border border-gray-200 px-2.5 h-8 rounded-lg hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1"><MessageCircle size={12} /> WA sent</button>
          <button onClick={() => bulkSent("email", true)} disabled={!selected.size} className="text-[12px] text-gray-600 border border-gray-200 px-2.5 h-8 rounded-lg hover:bg-gray-50 disabled:opacity-40 flex items-center gap-1"><Mail size={12} /> Emailed</button>
          <button onClick={bulkDelete} disabled={!selected.size} className="text-[12px] text-white bg-red-600 hover:bg-red-700 px-2.5 h-8 rounded-lg disabled:opacity-40 flex items-center gap-1"><Trash2 size={12} /> Delete</button>
        </div>
      )}

      <div className="mb-5 bg-white border border-gray-100 rounded-xl overflow-hidden">
        <button onClick={() => setShowManifest(!showManifest)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50/50 transition-colors">
          <div className="flex items-center gap-2">
            <BarChart3 size={15} className="text-indigo-500" />
            <h3 className="text-[13px] font-semibold text-gray-900">Manifest Analyzer</h3>
          </div>
          <ChevronDown size={13} className={`text-gray-400 transition-transform ${showManifest ? "rotate-180" : ""}`} />
        </button>
        {showManifest && (
          <div className="px-5 pb-4 border-t border-gray-50">
            <p className="text-[11px] text-gray-400 mt-3 mb-3">Upload a manifest CSV to analyze categories, estimate margins, and calculate a suggested bid.</p>
            {!manifest && (
              <button onClick={async () => {
                const f = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
                if (typeof f !== "string") return;
                setManifestBusy(true);
                try { setManifest(await api.analyzeManifest(f)); } catch (e: any) { alert(e); }
                setManifestBusy(false);
              }} disabled={manifestBusy} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-8 rounded-lg text-[12px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                <Upload size={12} /> {manifestBusy ? "Analyzing..." : "Upload CSV"}
              </button>
            )}
            {manifest && (
              <div>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  {[
                    { label: "Total Items", value: manifest.total_items },
                    { label: "Total Retail", value: fmtAmount(manifest.total_retail) },
                    { label: "Avg Margin", value: `${manifest.overall_margin_pct.toFixed(0)}%` },
                    { label: "Suggested Bid", value: fmtAmount(manifest.suggested_bid) },
                  ].map((s) => (
                    <div key={s.label} className="bg-gray-50 rounded-lg px-3 py-2.5">
                      <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-widest">{s.label}</p>
                      <p className="text-[15px] font-bold text-gray-900 tabular-nums">{s.value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 mb-3 bg-amber-50 border border-amber-100 px-3 py-2 rounded-lg">{manifest.formula}</p>
                {manifest.skipped_rows > 0 && <p className="text-[11px] text-amber-600 mb-3">{manifest.skipped_rows} rows skipped (missing price).</p>}
                <table className="w-full text-[12px] mb-3">
                  <thead className="bg-gray-50">
                    <tr><th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest rounded-l-lg">Category</th><th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Items</th><th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest rounded-r-lg">Retail</th></tr>
                  </thead>
                  <tbody>
                    {manifest.categories.map((c) => (
                      <tr key={c.category} className="border-t border-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-700">{c.category}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{c.items}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(c.total_retail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <button onClick={() => navigator.clipboard.writeText(manifest.suggested_bid.toString()).then(() => showToast("Suggested bid copied — paste into your deal."))}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-8 rounded-lg text-[11px] font-medium flex items-center gap-1.5">
                    <Clipboard size={11} /> Copy Bid
                  </button>
                  <button onClick={() => { setManifest(null); }} className="text-[11px] text-gray-500 hover:text-gray-700 px-3 h-8 rounded-lg hover:bg-gray-50">
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-5">
        <div className="w-40 flex-shrink-0 space-y-1">
          {STATUS_FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] capitalize flex justify-between transition-colors ${filter === f ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"}`}>
              <span>{f}</span><span className="text-gray-400">{counts[f]}</span>
            </button>
          ))}
          {(filter === "all" || filter === "sold" || filter === "archived") && filter === "all" && (
            <div className="pt-3 space-y-1">
              <button onClick={() => setShowSold(!showSold)} className="text-[11px] text-gray-500 flex items-center gap-1">
                <ChevronDown size={10} className={`${showSold ? "" : "-rotate-90"} transition-transform`} /> Sold ({counts.sold})
              </button>
              <button onClick={() => setShowArchived(!showArchived)} className="text-[11px] text-gray-500 flex items-center gap-1">
                <ChevronDown size={10} className={`${showArchived ? "" : "-rotate-90"} transition-transform`} /> Archived ({counts.archived})
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 content-start">
          {filtered.map((lot) => {
            const lotPhotos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
            const isSel = selected.has(lot.id);
            return (
            <div key={lot.id} className={`bg-white border rounded-xl overflow-hidden hover:shadow-md transition-shadow flex flex-col ${isSel ? "border-indigo-400 ring-2 ring-indigo-200" : "border-gray-100"}`}>
              {/* Photo on top */}
              <div onClick={() => onCardOpen(lot.id)} title={selectMode ? "Select" : "View details"} className="relative w-full h-44 bg-gray-50 flex items-center justify-center overflow-hidden cursor-pointer">
                {selectMode && (
                  <span className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-md flex items-center justify-center border-2 ${isSel ? "bg-indigo-600 border-indigo-600" : "bg-white/90 border-gray-300"}`}>
                    {isSel && <Check size={14} className="text-white" />}
                  </span>
                )}
                {lotPhotos.length > 0 ? (
                  <img src={convertFileSrc(resolvePhoto(lotPhotos[0], mediaBase))} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  <Image size={30} className="text-gray-300" />
                )}
                <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase shadow-sm ${statusColor(lot.status)}`}>{lot.status}</span>
                  {lot.category && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/90 text-indigo-600 font-semibold uppercase shadow-sm">{lot.category}</span>}
                </div>
                {lotPhotos.length > 0 && (
                  <span className="absolute bottom-2 right-2 text-[9px] px-1.5 py-0.5 rounded-full bg-black/55 text-white font-medium flex items-center gap-1"><Image size={9} /> {lotPhotos.length}</span>
                )}
                {lot.manifest_path && (
                  <span className="absolute bottom-2 left-2 text-[9px] px-1.5 py-0.5 rounded-full bg-violet-600/80 text-white font-medium flex items-center gap-1" title={lot.manifest_path}>📄 Manifest</span>
                )}
              </div>

              {/* Info */}
              <div className="p-4 flex flex-col flex-1">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 onClick={() => onCardOpen(lot.id)} className="text-[14px] font-semibold text-gray-900 leading-tight cursor-pointer hover:text-indigo-600 transition-colors">{lot.name}</h3>
                  <span className="text-[11px] text-gray-400 whitespace-nowrap flex-shrink-0">{lot.quantity} units</span>
                </div>
                {lot.notes && (
                  <span className="inline-flex self-start items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 font-semibold mb-1.5 max-w-full truncate" title={lot.notes}>
                    <ShieldCheck size={9} className="flex-shrink-0" /> {lot.notes}
                  </span>
                )}
                {(lot.supplier || lot.location) && (
                  <div className="flex items-center gap-3 text-[11px] text-gray-500 mb-2 flex-wrap">
                    {lot.supplier && <span className="inline-flex items-center gap-1"><Truck size={11} className="text-gray-400" /> {lot.supplier}</span>}
                    {lot.location && <span className="inline-flex items-center gap-1"><MapPin size={11} className="text-gray-400" /> {lot.location}</span>}
                  </div>
                )}
                {lot.description && <p className="text-[11px] text-gray-400 mb-2 truncate" title={lot.description}>{lot.description}</p>}

                <div className="flex items-center gap-3 text-[12px] mb-2 flex-wrap">
                  <span className="text-gray-500">Cost/u: <span className="font-medium text-gray-700">{fmtAmount(lot.total_cost)}</span></span>
                  <span className="text-gray-500">Ask/u: <span className="font-medium text-gray-700">{fmtAmount(lot.asking_price)}</span></span>
                  <span className={`font-semibold ${profit(lot) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{margin(lot)} · {fmtAmount(profit(lot))}</span>
                </div>
                <div className="w-full h-1.5 bg-gray-100 rounded-full mb-3 overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${marginPct(lot) > 40 ? "bg-emerald-500" : marginPct(lot) > 20 ? "bg-lime-500" : marginPct(lot) >= 0 ? "bg-amber-400" : "bg-red-400"}`}
                    style={{ width: `${Math.min(Math.max(marginPct(lot), 0), 100)}%` }} />
                </div>

                {/* Send status — clear text, click to toggle */}
                <div className="flex items-center gap-1.5 mb-2.5 flex-wrap">
                  <button onClick={() => toggleSent(lot, "whatsapp")} title="Click to toggle WhatsApp status"
                    className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors ${lot.sent_whatsapp ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"}`}>
                    <MessageCircle size={11} /> {lot.sent_whatsapp ? "WhatsApp sent" : "Needs WhatsApp"}
                  </button>
                  <button onClick={() => toggleSent(lot, "email")} title="Click to toggle email status"
                    className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border transition-colors ${lot.sent_email ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"}`}>
                    <Mail size={11} /> {lot.sent_email ? "Emailed" : "Needs email"}
                  </button>
                </div>

                {/* Actions — tidy single row; full set lives in the detail panel */}
                <div className="flex items-center gap-1 flex-wrap mt-auto pt-1 border-t border-gray-50">
                  <button onClick={() => { setEditing(lot); setShowForm(true); }} className="text-[11px] text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-50">Edit</button>
                  {lot.status !== "sold" && (
                    <button onClick={() => setStatus(lot, "sold")} className="text-[11px] text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded hover:bg-emerald-50 flex items-center gap-1"><DollarSign size={11} /> Sold</button>
                  )}
                  {lot.status !== "archived" ? (
                    <button onClick={() => setStatus(lot, "archived")} className="text-[11px] text-amber-600 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50 flex items-center gap-1"><Ban size={11} /> N/A</button>
                  ) : (
                    <button onClick={() => setStatus(lot, "available")} className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-50">Restore</button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => deleteOne(lot)} title="Delete lot" className="text-gray-300 hover:text-red-500 p-1 rounded hover:bg-red-50"><Trash2 size={13} /></button>
                </div>
              </div>
            </div>
          )})}
          {filtered.length === 0 && (
            <div className="col-span-2 text-center py-12">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3"><Package size={16} className="text-gray-400" /></div>
              <p className="text-[14px] font-semibold text-gray-800 mb-1">No lots found</p>
              <p className="text-[12px] text-gray-400">Add a lot to start tracking inventory</p>
            </div>
          )}
        </div>
      </div>

      {showForm && <LotForm initial={editing} onClose={() => { setShowForm(false); setEditing(null); load(); }} deals={deals} suppliers={suppliers} mediaBase={mediaBase} />}

      {detailId && (() => {
        const detail = lots.find((l) => l.id === detailId);
        if (!detail) return null;
        return (
          <LotDetail
            lot={detail}
            mediaBase={mediaBase}
            onClose={() => setDetailId(null)}
            onEdit={() => { setEditing(detail); setShowForm(true); setDetailId(null); }}
            onStatus={(s) => setStatus(detail, s)}
            onToggleSent={(c) => toggleSent(detail, c)}
            onLink={() => openLink(detail.id)}
            onDelete={() => deleteOne(detail)}
          />
        );
      })()}

      {linkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[3px]" onClick={() => setLinkModal(null)}>
          <div className="bg-white rounded-xl shadow-xl w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-gray-900 mb-3">Link to Deal</h3>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {deals.filter(d => d.stage !== "lost" && d.stage !== "won").map((d) => (
                <button key={d.id} onClick={async () => { try { await api.linkLotToDeal(linkModal, d.id); setLinkModal(null); load(); } catch (e: any) { alert(e); } }}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-indigo-50 text-[13px] text-gray-700">{d.title}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LotForm({ initial, onClose, suppliers, mediaBase }: { initial?: Lot | null; onClose: () => void; deals: Deal[]; suppliers: string[]; mediaBase: string }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [qty, setQty] = useState(initial?.quantity ?? 1);
  const [cost, setCost] = useState(initial?.total_cost ?? 0);
  const [ask, setAsk] = useState(initial?.asking_price ?? 0);
  const [supplier, setSupplier] = useState(initial?.supplier ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [sentWa, setSentWa] = useState(initial?.sent_whatsapp ?? false);
  const [sentEmail, setSentEmail] = useState(initial?.sent_email ?? false);
  const [photos, setPhotos] = useState<string[]>(() => { try { return JSON.parse(initial?.photos_json ?? "[]") ?? []; } catch { return []; } });
  const [manifestPath, setManifestPath] = useState<string | null>(initial?.manifest_path ?? null);
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<{ photos: string[]; index: number } | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight") setLightbox((prev) => prev ? { ...prev, index: Math.min(prev.index + 1, prev.photos.length - 1) } : null);
      if (e.key === "ArrowLeft") setLightbox((prev) => prev ? { ...prev, index: Math.max(prev.index - 1, 0) } : null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightbox]);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (initial) await api.updateLot(initial.id, { name: name.trim(), description: desc || null, category: category || null, quantity: qty, totalCost: cost, askingPrice: ask, photos, notes: notes.trim() || null, sentWhatsapp: sentWa, sentEmail: sentEmail, supplier: supplier.trim() || null, location: location.trim() || null });
      else {
        const lot = await api.createLot({ name: name.trim(), quantity: qty, totalCost: cost, askingPrice: ask, description: desc || undefined, category: category || undefined, photos, notes: notes.trim() || undefined, supplier: supplier.trim() || undefined, location: location.trim() || undefined });
        if (sentWa || sentEmail) await api.updateLot(lot.id, { sentWhatsapp: sentWa, sentEmail: sentEmail });
      }
      onClose();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-[440px] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-[14px] font-semibold text-gray-900">{initial ? "Edit Lot" : "New Lot"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Name *</label>
            <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Lot name" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Description</label>
            <input className={inp} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Category</label>
              <input className={inp} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Electronics" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Qty</label>
              <input className={inp} type="number" value={qty} onChange={(e) => setQty(parseInt(e.target.value) || 0)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Supplier</label>
              <input className={inp} list="lot-supplier-options" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type or pick a supplier" />
              <datalist id="lot-supplier-options">
                {suppliers.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Location</label>
              <input className={inp} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Warehouse A, Shelf 3" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Total Cost</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={cost || ""} onChange={(e) => setCost(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Asking Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={ask || ""} onChange={(e) => setAsk(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Notes</label>
            <input className={inp} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Authentic, sealed, minor box damage" />
          </div>
          <div className="flex items-center gap-5 pt-0.5">
            <label className="flex items-center gap-2 text-[12px] text-gray-600 cursor-pointer select-none">
              <input type="checkbox" className="accent-emerald-600" checked={sentWa} onChange={(e) => setSentWa(e.target.checked)} />
              <MessageCircle size={13} className="text-emerald-600" /> Sent on WhatsApp
            </label>
            <label className="flex items-center gap-2 text-[12px] text-gray-600 cursor-pointer select-none">
              <input type="checkbox" className="accent-blue-600" checked={sentEmail} onChange={(e) => setSentEmail(e.target.checked)} />
              <Mail size={13} className="text-blue-600" /> Emailed
            </label>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Photos</label>
            <div className="flex flex-wrap gap-2 mb-1">
              {photos.map((p, i) => (
                <div key={i} className="relative group" draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData("text/plain")); const to = i; if (from !== to) { const copy = [...photos]; const [moved] = copy.splice(from, 1); copy.splice(to, 0, moved); setPhotos(copy); } }}>
                  <img src={convertFileSrc(resolvePhoto(p, mediaBase))} alt="" className="w-[72px] h-[72px] object-cover rounded-lg border border-gray-200 cursor-pointer hover:border-indigo-400 transition-colors" onClick={() => setLightbox({ photos, index: i })} onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect fill='%23f3f4f6' width='72' height='72'/%3E%3Ctext x='36' y='36' text-anchor='middle' dy='.3em' fill='%239ca3af' font-size='10'%3E?%3C/text%3E%3C/svg%3E"; }} />
                   <button onClick={async () => {
                     if (initial) {
                       try { await api.removeLotPhoto(initial.id, p); } catch (e: any) { alert(e); }
                     }
                     setPhotos(photos.filter((_, idx) => idx !== i));
                   }} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X size={10} /></button>
                </div>
              ))}
              <button onClick={async () => {
                const f = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
                const picked = Array.isArray(f) ? f : (typeof f === "string" ? [f] : []);
                if (picked.length === 0) return;
                try {
                  if (initial) {
                    const rel = await api.importLotPhotos(initial.id, picked);
                    setPhotos([...photos, ...rel]);
                  } else {
                    setPhotos([...photos, ...picked]);
                  }
                } catch (e: any) { alert(e); }
              }} className="w-[72px] h-[72px] border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors group">
                <Plus size={18} className="text-gray-400 group-hover:text-indigo-500 transition-colors" />
              </button>
            </div>
            <p className="text-[9px] text-gray-400 flex items-center gap-1">
              <Image size={10} /> Photos are copied into your synced folder, so they show on all your devices.
            </p>
          </div>

          {initial && (
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Manifest</label>
              {manifestPath ? (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-gray-600 truncate max-w-[260px]">{manifestPath.split(/[/\\]/).pop()!.length > 20 ? manifestPath.split(/[/\\]/).pop()!.slice(0, 17) + "..." : manifestPath.split(/[/\\]/).pop()}</span>
                  <button onClick={async () => {
                    try { await api.removeLotManifest(initial.id); setManifestPath(null); } catch (e: any) { alert(e); }
                  }} className="text-[11px] text-red-400 hover:text-red-600">Remove</button>
                </div>
              ) : (
                <button onClick={async () => {
                  const f = await openDialog({ multiple: false, filters: [{ name: "Documents", extensions: ["pdf", "csv"] }] });
                  if (typeof f !== "string") return;
                  try {
                    const rel = await api.attachLotManifest(initial.id, f);
                    setManifestPath(rel);
                  } catch (e: any) { alert(e); }
                }} className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium">+ Attach Manifest (PDF or CSV)</button>
              )}
            </div>
          )}

        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 h-9 text-[13px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving..." : initial ? "Save" : "Create Lot"}
          </button>
        </div>
      </div>
    </div>
    {lightbox && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setLightbox(null)}>
        <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
        <button onClick={() => setLightbox((prev) => prev && prev.index > 0 ? { ...prev, index: prev.index - 1 } : prev)} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white disabled:opacity-30 p-2" disabled={lightbox.index === 0}><ChevronLeft size={32} /></button>
        <button onClick={() => setLightbox((prev) => prev && prev.index < prev.photos.length - 1 ? { ...prev, index: prev.index + 1 } : prev)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white disabled:opacity-30 p-2" disabled={lightbox.index === lightbox.photos.length - 1}><ChevronRight size={32} /></button>
        <img src={convertFileSrc(resolvePhoto(lightbox.photos[lightbox.index], mediaBase))} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
        <div className="absolute bottom-4 text-white/60 text-[13px]">{lightbox.index + 1} / {lightbox.photos.length}</div>
      </div>
    )}
    </>
  );
}

function LotDetail({ lot, mediaBase, onClose, onEdit, onStatus, onToggleSent, onLink, onDelete }: {
  lot: Lot; mediaBase: string; onClose: () => void; onEdit: () => void;
  onStatus: (s: string) => void; onToggleSent: (c: "whatsapp" | "email") => void; onLink: () => void; onDelete: () => void;
}) {
  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  const [big, setBig] = useState(0);
  const [zoom, setZoom] = useState(false);
  // Cost & price are per-unit; total profit = per-unit margin × quantity.
  const profit = (lot.asking_price - lot.total_cost) * lot.quantity;
  const marginPct = lot.total_cost > 0 ? ((lot.asking_price - lot.total_cost) / lot.total_cost) * 100 : 0;
  const marginStr = lot.total_cost > 0 ? `${marginPct.toFixed(0)}%` : "—";

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div>
      <p className="text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-0.5">{label}</p>
      <p className="text-[13px] text-gray-800 break-words">{value}</p>
    </div>
  );

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/30 backdrop-blur-[3px] overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-[560px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-100">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase ${statusColor(lot.status)}`}>{lot.status}</span>
              {lot.category && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-semibold uppercase">{lot.category}</span>}
            </div>
            <h3 className="text-[17px] font-semibold text-gray-900 leading-tight">{lot.name}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 flex-shrink-0"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Photos */}
          {photos.length > 0 ? (
            <div>
              <div className="w-full h-64 bg-gray-50 rounded-xl overflow-hidden flex items-center justify-center cursor-zoom-in" onClick={() => setZoom(true)}>
                <img src={convertFileSrc(resolvePhoto(photos[big], mediaBase))} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.2"; }} />
              </div>
              {photos.length > 1 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {photos.map((p, i) => (
                    <img key={i} src={convertFileSrc(resolvePhoto(p, mediaBase))} alt="" onClick={() => setBig(i)}
                      className={`w-14 h-14 object-cover rounded-lg border cursor-pointer transition-colors ${i === big ? "border-indigo-400 ring-2 ring-indigo-200" : "border-gray-200 hover:border-gray-300"}`} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="w-full h-40 bg-gray-50 rounded-xl flex items-center justify-center"><Image size={28} className="text-gray-300" /></div>
          )}

          {/* Sent indicators */}
          <div className="flex items-center gap-2">
            <button onClick={() => onToggleSent("whatsapp")} className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_whatsapp ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"}`}>
              <MessageCircle size={12} /> {lot.sent_whatsapp ? "WhatsApp sent" : "Needs WhatsApp"}
            </button>
            <button onClick={() => onToggleSent("email")} className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_email ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"}`}>
              <Mail size={12} /> {lot.sent_email ? "Emailed" : "Needs email"}
            </button>
          </div>

          {/* Financials */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-semibold">Cost/unit</p><p className="text-[14px] font-bold text-gray-900 tabular-nums">{fmtAmount(lot.total_cost)}</p></div>
            <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-semibold">Ask/unit</p><p className="text-[14px] font-bold text-gray-900 tabular-nums">{fmtAmount(lot.asking_price)}</p></div>
            <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-semibold">Margin</p><p className={`text-[14px] font-bold tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-red-500"}`}>{marginStr}</p></div>
            <div className="bg-gray-50 rounded-lg px-3 py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-semibold">Profit ×{lot.quantity}</p><p className={`text-[14px] font-bold tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtAmount(profit)}</p></div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-4">
            <Row label="Quantity" value={`${lot.quantity} units`} />
            <Row label="Supplier" value={lot.supplier || "—"} />
            <Row label="Location" value={lot.location || "—"} />
            <Row label="Notes" value={lot.notes || "—"} />
          </div>
          {lot.description && (
            <div>
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-0.5">Description</p>
              <p className="text-[13px] text-gray-700 whitespace-pre-wrap">{lot.description}</p>
            </div>
          )}
          <div className="flex items-center gap-4 text-[11px] text-gray-400">
            <span>Added {lot.created_at.slice(0, 10)}</span>
            <span>Updated {lot.updated_at.slice(0, 10)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap p-5 border-t border-gray-100">
          <button onClick={onEdit} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium">Edit</button>
          {lot.status !== "sold" && lot.status !== "archived" && (
            <button onClick={onLink} className="flex items-center gap-1 border border-gray-200 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50"><Link2 size={13} /> Link to Deal</button>
          )}
          {lot.status !== "sold" && (
            <button onClick={() => onStatus("sold")} className="flex items-center gap-1 border border-emerald-200 text-emerald-700 px-3 h-9 rounded-lg text-[12px] hover:bg-emerald-50"><DollarSign size={13} /> Mark Sold</button>
          )}
          {lot.status !== "archived" && (
            <button onClick={() => onStatus("archived")} className="flex items-center gap-1 border border-red-200 text-red-600 px-3 h-9 rounded-lg text-[12px] hover:bg-red-50"><Ban size={13} /> Not Available</button>
          )}
          {(lot.status === "sold" || lot.status === "archived") && (
            <button onClick={() => onStatus("available")} className="border border-gray-200 text-gray-600 px-3 h-9 rounded-lg text-[12px] hover:bg-gray-50">Restore</button>
          )}
          <button onClick={onDelete} className="flex items-center gap-1 border border-red-200 text-red-600 px-3 h-9 rounded-lg text-[12px] hover:bg-red-50 ml-auto"><Trash2 size={13} /> Delete</button>
        </div>
      </div>
    </div>
    {zoom && photos.length > 0 && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setZoom(false)}>
        <button onClick={() => setZoom(false)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
        <img src={convertFileSrc(resolvePhoto(photos[big], mediaBase))} alt="" className="max-w-[92vw] max-h-[92vh] object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    )}
    </>
  );
}
