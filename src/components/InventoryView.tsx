import { useEffect, useState } from "react";
import { api, Lot, Deal, ManifestAnalysis, ParsedLoad } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, Package, ChevronDown, Link2, Upload, Clipboard, BarChart3, FileDown, Image, ChevronLeft, ChevronRight, MessageCircle, Mail, DollarSign, Ban, Trash2, RefreshCw, CheckSquare, Check, Send, FileText } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "./Toast";

const STATUS_FILTERS = ["all", "available", "reserved", "sold", "archived"] as const;
type StatusFilter = typeof STATUS_FILTERS[number] | "all";

const statusColor = (s: string) => {
  switch (s) { case "available": return "bg-success-bg text-success-ink"; case "reserved": return "bg-info-bg text-info-ink"; case "sold": return "bg-surface-3 text-ink-2"; case "archived": return "bg-warning-bg text-warning-ink"; default: return "bg-surface-3 text-ink-2"; }
};

const inp = "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Photos are stored as device-independent relative paths ("media/<uuid>.jpg")
// inside the synced folder. Legacy absolute paths are passed through as-is.
const isAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
const resolvePhoto = (p: string, base: string) => (isAbsPath(p) || !base) ? p : `${base}/${p}`;

export default function InventoryView() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Lot | null>(null);
  const [prefill, setPrefill] = useState<Partial<Lot> | null>(null);
  const [pasting, setPasting] = useState(false);
  const [showSold, setShowSold] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [linkModal, setLinkModal] = useState<string | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [showManifest, setShowManifest] = useState(false);

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
    catch (e: any) { toast(String(e), "error"); }
  };

  // Toggle the "sent on WhatsApp / email" flags right from the card.
  // Optimistic update for snappy UX, then persist (and sync).
  const toggleSent = async (lot: Lot, channel: "whatsapp" | "email") => {
    const prop = channel === "whatsapp" ? "sent_whatsapp" : "sent_email";   // Lot property (snake)
    const arg  = channel === "whatsapp" ? "sentWhatsapp" : "sentEmail";       // Tauri arg (camel)
    const next = !lot[prop];
    setLots((prev) => prev.map((l) => (l.id === lot.id ? { ...l, [prop]: next } : l)));
    try { await api.updateLot(lot.id, { [arg]: next }); }
    catch (e: any) { toast(String(e), "error"); load(); }
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
    try { await api.deleteLot(lot.id); setDetailId(null); load(); } catch (e: any) { toast(String(e), "error"); }
  };
  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected lot${selected.size !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    try { await api.deleteLots([...selected]); exitSelect(); load(); } catch (e: any) { toast(String(e), "error"); }
  };
  const bulkStatus = async (status: string) => {
    if (selected.size === 0) return;
    try { for (const id of selected) await api.setLotStatus(id, status); exitSelect(); load(); } catch (e: any) { toast(String(e), "error"); }
  };
  const bulkSent = async (channel: "whatsapp" | "email", val: boolean) => {
    if (selected.size === 0) return;
    const arg = channel === "whatsapp" ? "sentWhatsapp" : "sentEmail";
    try { for (const id of selected) await api.updateLot(id, { [arg]: val }); exitSelect(); load(); } catch (e: any) { toast(String(e), "error"); }
  };
  const resync = async () => {
    try { const n = await api.resyncInventory(); toast(`Re-synced ${n} lot${n !== 1 ? "s" : ""} to your devices`); }
    catch (e: any) { toast(String(e), "error"); }
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

  const unitCost = (lot: Lot) => lot.price_type === "total" && lot.quantity > 0 ? lot.total_cost / lot.quantity : lot.total_cost;
  const unitAsk = (lot: Lot) => lot.price_type === "total" && lot.quantity > 0 ? lot.asking_price / lot.quantity : lot.asking_price;
  const margin = (lot: Lot) => unitCost(lot) > 0 ? `${(((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100).toFixed(0)}%` : "—";
  const marginPct = (lot: Lot) => unitCost(lot) > 0 ? ((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100 : 0;
  const totalProfit = (lot: Lot) => lot.price_type === "total" ? lot.asking_price - lot.total_cost : (lot.asking_price - lot.total_cost) * lot.quantity;
  const totalAsk = (lot: Lot) => lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;
  const totalCostAll = (lot: Lot) => lot.price_type === "per_unit" ? lot.total_cost * lot.quantity : lot.total_cost;

  const handleExportInventory = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "inventory.csv" });
    if (!path) return;
    const count = await api.exportInventoryCsv(filter === "all" ? null : filter, path as string);
    toast(`Exported ${count} inventory lot${count !== 1 ? "s" : ""} to CSV`);
  };

  return (
    <div>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Inventory</h2>
          <p className="text-[12px] text-muted mt-0.5">{counts.all} lots · {totalUnits.toLocaleString()} units total</p>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <button onClick={exitSelect} className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
              Cancel
            </button>
          ) : (
            <>
              <button onClick={resync} title="Re-sync all inventory to your other devices"
                className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
                <RefreshCw size={13} /> Sync
              </button>
              <button onClick={() => setSelectMode(true)}
                className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
                <CheckSquare size={13} /> Select
              </button>
              <button onClick={handleExportInventory}
                className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
                <FileDown size={13} /> Export
              </button>
              <button onClick={() => setPasting(true)} title="Paste a supplier load message or drop a manifest — AI fills the form"
                className="flex items-center gap-1.5 border border-accent/40 text-accent px-3 h-9 rounded-lg text-[12px] font-medium hover:bg-accent/10 transition-colors">
                <Clipboard size={13} /> Paste a load
              </button>
              <button onClick={() => { setEditing(null); setPrefill(null); setShowForm(true); }} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
                <Plus size={14} /> Add lot
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectMode && (
        <div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-2 bg-surface border border-line rounded-xl px-4 py-2.5 shadow-sm">
          <span className="text-[13px] font-semibold text-ink-2 mr-1">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set(filtered.map((l) => l.id)))} className="text-[12px] text-accent hover:text-accent-hover px-2 py-1 rounded hover:bg-accent/10">Select all</button>
          <div className="flex-1" />
          <button onClick={() => bulkStatus("sold")} disabled={!selected.size} className="text-[12px] text-success-ink border border-success px-2.5 h-8 rounded-lg hover:bg-success-bg disabled:opacity-40 flex items-center gap-1"><DollarSign size={12} /> Sold</button>
          <button onClick={() => bulkStatus("archived")} disabled={!selected.size} className="text-[12px] text-danger-ink border border-danger px-2.5 h-8 rounded-lg hover:bg-danger-bg disabled:opacity-40 flex items-center gap-1"><Ban size={12} /> Unavailable</button>
          <button onClick={() => bulkSent("whatsapp", true)} disabled={!selected.size} className="text-[12px] text-ink-2 border border-line px-2.5 h-8 rounded-lg hover:bg-surface-2 disabled:opacity-40 flex items-center gap-1"><MessageCircle size={12} /> WA sent</button>
          <button onClick={() => bulkSent("email", true)} disabled={!selected.size} className="text-[12px] text-ink-2 border border-line px-2.5 h-8 rounded-lg hover:bg-surface-2 disabled:opacity-40 flex items-center gap-1"><Mail size={12} /> Emailed</button>
          <button onClick={bulkDelete} disabled={!selected.size} className="text-[12px] text-danger-ink bg-danger-bg border border-danger px-2.5 h-8 rounded-lg hover:opacity-90 disabled:opacity-40 flex items-center gap-1"><Trash2 size={12} /> Delete</button>
          <button onClick={() => {
            window.dispatchEvent(new CustomEvent("share-whatsapp", { detail: Array.from(selected) }));
          }} disabled={!selected.size} className="text-[12px] text-success-ink bg-success-bg border border-success px-2.5 h-8 rounded-lg hover:opacity-90 disabled:opacity-40 flex items-center gap-1"><Send size={12} /> Share WA</button>
        </div>
      )}

      <div className="mb-5 bg-surface border border-line rounded-xl overflow-hidden">
        <button onClick={() => setShowManifest(!showManifest)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-2/50 transition-colors">
          <div className="flex items-center gap-2">
            <BarChart3 size={15} className="text-accent" />
            <h3 className="text-[13px] font-semibold text-ink">Manifest analyzer</h3>
          </div>
          <ChevronDown size={13} className={`text-muted transition-transform ${showManifest ? "rotate-180" : ""}`} />
        </button>
        {showManifest && (
          <div className="px-5 pb-4 border-t border-line">
            <p className="text-[11px] text-muted mt-3 mb-3">Upload a manifest CSV to break down items & retail by the manifest's own categories and brands, estimate margins, and calculate a suggested bid.</p>
            {!manifest && (
              <button onClick={async () => {
                const f = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
                if (typeof f !== "string") return;
                setManifestBusy(true);
                try { setManifest(await api.analyzeManifest(f)); } catch (e: any) { toast(String(e), "error"); }
                setManifestBusy(false);
              }} disabled={manifestBusy} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[12px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                <Upload size={12} /> {manifestBusy ? "Analyzing…" : "Upload CSV"}
              </button>
            )}
            {manifest && (
              <div>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
                  {[
                    { label: "Total items", value: manifest.total_items },
                    { label: "Total retail", value: fmtAmount(manifest.total_retail) },
                    { label: "Avg margin", value: `${manifest.overall_margin_pct.toFixed(0)}%` },
                    { label: "Suggested bid", value: fmtAmount(manifest.suggested_bid) },
                  ].map((s) => (
                    <div key={s.label} className="bg-surface-2 rounded-lg px-3 py-2.5">
                      <p className="text-[11.5px] font-medium text-muted">{s.label}</p>
                      <p className="text-[15px] font-bold text-ink tabular-nums">{s.value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted mb-3 bg-warning-bg border border-warning px-3 py-2 rounded-lg">{manifest.formula}</p>
                {manifest.skipped_rows > 0 && <p className="text-[11px] text-warning-ink mb-3">{manifest.skipped_rows} rows skipped (missing price).</p>}
                {/* By category — grouped by the manifest's OWN category column when present */}
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[11px] font-semibold text-ink-2">By category</p>
                  <span className="text-[9.5px] text-muted">{manifest.categories_from_manifest ? "from manifest" : "estimated — no category column found"}</span>
                </div>
                <table className="w-full text-[12px] mb-4">
                  <thead className="bg-surface-2">
                    <tr><th className="text-left px-3 py-2 text-[12px] font-medium text-muted rounded-l-lg">Category</th><th className="text-right px-3 py-2 text-[12px] font-medium text-muted">Items</th><th className="text-right px-3 py-2 text-[12px] font-medium text-muted rounded-r-lg">Retail</th></tr>
                  </thead>
                  <tbody>
                    {manifest.categories.map((c) => (
                      <tr key={c.name} className="border-t border-line">
                        <td className="px-3 py-2 font-medium text-ink-2">{c.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{c.items}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(c.total_retail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* By brand — only shown when the manifest actually has a brand column */}
                {manifest.brands.length > 0 && (
                  <>
                    <p className="text-[11px] font-semibold text-ink-2 mb-1.5">By brand <span className="text-[9.5px] font-normal text-muted">from manifest</span></p>
                    <table className="w-full text-[12px] mb-3">
                      <thead className="bg-surface-2">
                        <tr><th className="text-left px-3 py-2 text-[12px] font-medium text-muted rounded-l-lg">Brand</th><th className="text-right px-3 py-2 text-[12px] font-medium text-muted">Items</th><th className="text-right px-3 py-2 text-[12px] font-medium text-muted rounded-r-lg">Retail</th></tr>
                      </thead>
                      <tbody>
                        {manifest.brands.map((b) => (
                          <tr key={b.name} className="border-t border-line">
                            <td className="px-3 py-2 font-medium text-ink-2">{b.name}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted">{b.items}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(b.total_retail)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                <div className="flex gap-2">
                  <button onClick={() => navigator.clipboard.writeText(manifest.suggested_bid.toString()).then(() => toast("Suggested bid copied — paste into your deal."))}
                    className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[11px] font-medium flex items-center gap-1.5">
                    <Clipboard size={11} /> Copy bid
                  </button>
                  <button onClick={() => { setManifest(null); }} className="text-[11px] text-muted hover:text-ink-2 px-3 h-8 rounded-lg hover:bg-surface-2">
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
            <button key={f} onClick={() => setFilter(f)} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] capitalize flex justify-between transition-colors ${filter === f ? "bg-accent/10 text-accent-hover font-medium" : "text-ink-2 hover:bg-surface-2"}`}>
              <span>{f}</span><span className="text-muted">{counts[f]}</span>
            </button>
          ))}
          {(filter === "all" || filter === "sold" || filter === "archived") && filter === "all" && (
            <div className="pt-3 space-y-1">
              <button onClick={() => setShowSold(!showSold)} className="text-[11px] text-muted flex items-center gap-1">
                <ChevronDown size={10} className={`${showSold ? "" : "-rotate-90"} transition-transform`} /> Sold ({counts.sold})
              </button>
              <button onClick={() => setShowArchived(!showArchived)} className="text-[11px] text-muted flex items-center gap-1">
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
            <div key={lot.id} onClick={() => onCardOpen(lot.id)} title={selectMode ? "Select" : "Open lot"}
              className={`group bg-surface border rounded-xl overflow-hidden transition-all cursor-pointer flex flex-col hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)] ${isSel ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-line-3"}`}>
              {/* Photo */}
              <div className="relative w-full h-40 bg-surface-2 flex items-center justify-center overflow-hidden">
                {lotPhotos.length > 0 ? (
                  <img src={convertFileSrc(resolvePhoto(lotPhotos[0], mediaBase))} alt="" className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  <Image size={28} className="text-faint" strokeWidth={1.5} />
                )}
                {selectMode && (
                  <span className={`absolute top-2.5 right-2.5 z-10 w-6 h-6 rounded-md flex items-center justify-center border-2 ${isSel ? "bg-accent border-accent" : "bg-surface/95 border-line-3"}`}>
                    {isSel && <Check size={14} className="text-on-accent" />}
                  </span>
                )}
                <span className={`absolute top-2.5 left-2.5 text-[9px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide backdrop-blur-sm ${statusColor(lot.status)}`}>{lot.status}</span>
                <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5">
                  {lot.manifest_path && (
                    <span className="w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center" title="Manifest attached"><FileText size={11} /></span>
                  )}
                  {lotPhotos.length > 1 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-black/55 text-white font-medium flex items-center gap-1"><Image size={9} /> {lotPhotos.length}</span>
                  )}
                </div>
              </div>

              {/* Info */}
              <div className="p-3.5 flex flex-col flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-ink leading-snug line-clamp-1 group-hover:text-accent transition-colors">{lot.name}</h3>
                  <span className="text-[11px] text-muted whitespace-nowrap flex-shrink-0 mt-px tabular-nums">{lot.quantity.toLocaleString()} units</span>
                </div>
                {[lot.category, lot.supplier, lot.location].some(Boolean) && (
                  <p className="text-[11px] text-muted truncate mt-0.5">{[lot.category, lot.supplier, lot.location].filter(Boolean).join(" · ")}</p>
                )}
                {lot.notes && <p className="text-[11px] text-muted truncate mt-1.5">{lot.notes}</p>}

                {/* Metrics */}
                <div className="flex items-end justify-between mt-3">
                  <div>
                    <div className="text-[11.5px] font-medium text-muted">Unit cost → ask</div>
                    <div className="text-[13px] text-ink-2 tabular-nums mt-0.5">
                      <span className="font-semibold">{fmtAmount(unitCost(lot))}</span>
                      <span className="text-faint mx-1">→</span>
                      <span className="font-semibold">{fmtAmount(unitAsk(lot))}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-[11.5px] font-medium text-muted">Profit</div>
                    <div className={`text-[15px] font-bold tabular-nums mt-0.5 leading-none ${totalProfit(lot) >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(totalProfit(lot))}</div>
                  </div>
                </div>

                {/* Margin bar */}
                <div className="flex items-center gap-2 mt-2.5">
                  <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${marginPct(lot) > 40 ? "bg-success" : marginPct(lot) > 20 ? "bg-success" : marginPct(lot) >= 0 ? "bg-warning" : "bg-danger"}`}
                      style={{ width: `${Math.min(Math.max(marginPct(lot), 0), 100)}%` }} />
                  </div>
                  <span className="text-[10px] font-semibold tabular-nums text-muted w-9 text-right">{margin(lot)}</span>
                </div>

                {/* Send status — quiet chips */}
                <div className="flex items-center gap-1.5 mt-3" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => toggleSent(lot, "whatsapp")} title={lot.sent_whatsapp ? "Sent on WhatsApp" : "Not sent on WhatsApp"}
                    className={`flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border transition-colors ${lot.sent_whatsapp ? "bg-success-bg text-success-ink border-success" : "bg-surface-2 text-muted border-line hover:bg-surface-3"}`}>
                    <MessageCircle size={11} /> WhatsApp {lot.sent_whatsapp && <Check size={10} />}
                  </button>
                  <button onClick={() => toggleSent(lot, "email")} title={lot.sent_email ? "Emailed" : "Not emailed"}
                    className={`flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border transition-colors ${lot.sent_email ? "bg-info-bg text-info-ink border-info" : "bg-surface-2 text-muted border-line hover:bg-surface-3"}`}>
                    <Mail size={11} /> Email {lot.sent_email && <Check size={10} />}
                  </button>
                </div>

                {/* Primary action — share this lot to WhatsApp directly */}
                <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => window.dispatchEvent(new CustomEvent("share-whatsapp", { detail: [lot.id] }))}
                    className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-success-ink border border-success bg-success-bg hover:bg-success-bg h-8 rounded-lg transition-colors">
                    <Send size={13} /> Send to WhatsApp
                  </button>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-0.5 mt-2 pt-2.5 border-t border-line" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => { setEditing(lot); setShowForm(true); }} className="text-[11px] text-muted hover:text-ink px-2 py-1 rounded-md hover:bg-surface-3 transition-colors">Edit</button>
                  {lot.status !== "sold" && (
                    <button onClick={() => setStatus(lot, "sold")} className="text-[11px] text-muted hover:text-success-ink px-2 py-1 rounded-md hover:bg-success-bg transition-colors">Mark sold</button>
                  )}
                  {lot.status !== "archived" ? (
                    <button onClick={() => setStatus(lot, "archived")} className="text-[11px] text-muted hover:text-warning-ink px-2 py-1 rounded-md hover:bg-warning-bg transition-colors">Unavailable</button>
                  ) : (
                    <button onClick={() => setStatus(lot, "available")} className="text-[11px] text-muted hover:text-ink px-2 py-1 rounded-md hover:bg-surface-3 transition-colors">Restore</button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => deleteOne(lot)} title="Delete lot" className="text-faint hover:text-danger-ink p-1 rounded-md hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
                </div>
              </div>
            </div>
          )})}
          {filtered.length === 0 && (
            <div className="col-span-2 text-center py-12">
              <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3"><Package size={16} className="text-muted" /></div>
              <p className="text-[14px] font-semibold text-ink mb-1">No lots found</p>
              <p className="text-[12px] text-muted">Add a lot to start tracking inventory</p>
            </div>
          )}
        </div>
      </div>

      {showForm && <LotForm initial={editing} prefill={prefill} onClose={() => { setShowForm(false); setEditing(null); setPrefill(null); load(); }} deals={deals} suppliers={suppliers} mediaBase={mediaBase} />}

      {pasting && <PasteLoadModal
        onClose={() => setPasting(false)}
        onParsed={(pf) => { setPasting(false); setEditing(null); setPrefill(pf); setShowForm(true); }}
      />}

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
            onChanged={load}
          />
        );
      })()}

      {linkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-[3px]" onClick={() => setLinkModal(null)}>
          <div className="bg-surface rounded-xl shadow-xl w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-ink mb-3">Link to deal</h3>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {deals.filter(d => d.stage !== "lost" && d.stage !== "won").map((d) => (
                <button key={d.id} onClick={async () => { try { await api.linkLotToDeal(linkModal, d.id); setLinkModal(null); load(); } catch (e: any) { toast(String(e), "error"); } }}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-accent/10 text-[13px] text-ink-2">{d.title}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Paste-to-load: paste a supplier's WhatsApp message (and/or Ctrl+V a manifest
// screenshot) → AI parses it into lot fields → opens the New-lot form prefilled.
function PasteLoadModal({ onClose, onParsed }: { onClose: () => void; onParsed: (pf: Partial<Lot>) => void }) {
  const [text, setText] = useState("");
  const [img, setImg] = useState<{ b64: string; mt: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");

  useEffect(() => { api.loadAiStatus().then(setHasKey).catch(() => setHasKey(false)); }, []);

  const onPaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return; // let normal text paste happen
    const file = item.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const b64 = dataUrl.split(",")[1] || "";
      const mt = (dataUrl.match(/data:(.*?);/) || [])[1] || "image/png";
      setImg({ b64, mt, preview: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    try { await api.setAnthropicKey(keyInput.trim()); setHasKey(true); setKeyInput(""); }
    catch (e: any) { setErr(String(e)); }
  };

  const parse = async () => {
    setBusy(true); setErr(null);
    try {
      const p: ParsedLoad = await api.parseLoad(text, img?.b64, img?.mt);
      const notes = [p.notes, p.condition ? `Condition: ${p.condition}` : ""].filter(Boolean).join(" · ");
      onParsed({
        name: p.title ?? "",
        description: p.description ?? "",
        category: p.category ?? "",
        quantity: p.quantity ?? 1,
        total_cost: p.total_cost ?? p.unit_price ?? 0,
        asking_price: p.asking_price ?? 0,
        supplier: p.supplier ?? "",
        location: p.location ?? "",
        notes: notes || undefined,
      });
    } catch (e: any) { setErr(String(e)); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[480px] max-w-[92vw] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><Clipboard size={15} className="text-accent" /> Paste a load</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <p className="text-[12px] text-muted mb-3">Paste the supplier's message, and/or press <b>Ctrl/⌘+V</b> to drop a manifest screenshot. AI fills the new-lot form — you review before saving.</p>

        {hasKey === false ? (
          <div className="bg-warning-bg border border-warning rounded-lg p-3 mb-3">
            <div className="text-[12.5px] text-warning-ink font-medium mb-1.5">Add your AI key to enable paste-to-load</div>
            <div className="text-[11.5px] text-warning-ink/90 mb-2">Get one at console.anthropic.com → API keys. Stored on this device only. Parsing costs a fraction of a cent.</div>
            <div className="flex gap-2">
              <input value={keyInput} onChange={(e) => setKeyInput(e.target.value)} type="password" placeholder="sk-ant-…" className={inp} />
              <button onClick={saveKey} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-9 rounded-lg text-[12px] font-medium whitespace-nowrap">Save key</button>
            </div>
          </div>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={onPaste}
              rows={6}
              autoFocus
              placeholder="Paste the load details here…"
              className="w-full border border-line px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-none"
            />
            {img && (
              <div className="mt-2 flex items-center gap-2">
                <img src={img.preview} alt="manifest" className="h-14 w-14 object-cover rounded-lg border border-line" />
                <span className="text-[12px] text-muted">Manifest image attached</span>
                <button onClick={() => setImg(null)} className="text-muted hover:text-danger-ink ml-auto"><X size={14} /></button>
              </div>
            )}
            {err && <div className="text-[11.5px] text-danger-ink mt-2">{err}</div>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={onClose} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9">Cancel</button>
              <button onClick={parse} disabled={busy || (!text.trim() && !img)}
                className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <><RefreshCw size={14} className="animate-spin" /> Reading…</> : <>Parse load →</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LotForm({ initial, prefill, onClose, suppliers, mediaBase }: { initial?: Lot | null; prefill?: Partial<Lot> | null; onClose: () => void; deals: Deal[]; suppliers: string[]; mediaBase: string }) {
  const [name, setName] = useState(initial?.name ?? prefill?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? prefill?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? prefill?.category ?? "");
  const [qty, setQty] = useState(initial?.quantity ?? prefill?.quantity ?? 1);
  const [cost, setCost] = useState(initial?.total_cost ?? prefill?.total_cost ?? 0);
  const [ask, setAsk] = useState(initial?.asking_price ?? prefill?.asking_price ?? 0);
  const [priceType, setPriceType] = useState(initial?.price_type ?? "per_unit");
  const [supplier, setSupplier] = useState(initial?.supplier ?? prefill?.supplier ?? "");
  const [location, setLocation] = useState(initial?.location ?? prefill?.location ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? prefill?.notes ?? "");
  const [sentWa, setSentWa] = useState(initial?.sent_whatsapp ?? false);
  const [sentEmail, setSentEmail] = useState(initial?.sent_email ?? false);
  const [photos, setPhotos] = useState<string[]>(() => { try { return JSON.parse(initial?.photos_json ?? "[]") ?? []; } catch { return []; } });
  const [manifestPath, setManifestPath] = useState<string | null>(initial?.manifest_path ?? null);
  const [newManifestFile, setNewManifestFile] = useState<string | null>(null); // picked file for a not-yet-created lot
  const [saving, setSaving] = useState(false);

  const pickManifest = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: ["pdf", "csv", "xlsx", "xls"] }] });
    if (typeof f !== "string") return;
    if (initial) {
      try { const rel = await api.attachLotManifest(initial.id, f); setManifestPath(rel); } catch (e: any) { toast(String(e), "error"); }
    } else {
      setNewManifestFile(f);
    }
  };
  const clearManifest = async () => {
    if (initial && manifestPath) {
      try { await api.removeLotManifest(initial.id); setManifestPath(null); } catch (e: any) { toast(String(e), "error"); }
    } else {
      setNewManifestFile(null);
    }
  };
  const manifestLabel = (manifestPath || newManifestFile)?.split(/[/\\]/).pop() || "";
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
      if (initial) {
        await api.updateLot(initial.id, { name: name.trim(), description: desc || null, category: category || null, quantity: qty, totalCost: cost, askingPrice: ask, photos, notes: notes.trim() || null, sentWhatsapp: sentWa, sentEmail: sentEmail, supplier: supplier.trim() || null, location: location.trim() || null, priceType });
      } else {
        const lot = await api.createLot({ name: name.trim(), quantity: qty, totalCost: cost, askingPrice: ask, description: desc || undefined, category: category || undefined, notes: notes.trim() || undefined, supplier: supplier.trim() || undefined, location: location.trim() || undefined, priceType });
        // Photos were picked as raw paths; copy them into the lot's synced media folder now that it has an id.
        if (photos.length > 0) {
          const rel = await api.importLotPhotos(lot.id, photos);
          await api.updateLot(lot.id, { photos: rel });
        }
        if (newManifestFile) await api.attachLotManifest(lot.id, newManifestFile);
        if (sentWa || sentEmail) await api.updateLot(lot.id, { sentWhatsapp: sentWa, sentEmail: sentEmail });
      }
      onClose();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[440px] max-w-[92vw] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-[14px] font-semibold text-ink">{initial ? "Edit lot" : "New lot"}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Name *</label>
            <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Lot name" />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Description</label>
            <input className={inp} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Category</label>
              <input className={inp} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Electronics" />
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Qty</label>
              <input className={inp} type="number" value={qty} onChange={(e) => setQty(parseInt(e.target.value) || 0)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Supplier</label>
              <input className={inp} list="lot-supplier-options" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type or pick a supplier" />
              <datalist id="lot-supplier-options">
                {suppliers.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Location</label>
              <input className={inp} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Warehouse A, Shelf 3" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Cost price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={cost || ""} onChange={(e) => setCost(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Selling price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={ask || ""} onChange={(e) => setAsk(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Price type</label>
            <div className="flex gap-1 bg-surface-3 rounded-lg p-0.5">
              {(["per_unit", "total"] as const).map(pt => (
                <button key={pt} onClick={() => setPriceType(pt)}
                  className={`flex-1 text-[12px] font-medium py-1.5 rounded-md transition-colors ${priceType === pt ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                  {pt === "per_unit" ? "Per unit" : "Total"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Notes</label>
            <input className={inp} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Authentic, sealed, minor box damage" />
          </div>
          <div className="flex items-center gap-5 pt-0.5">
            <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-accent" checked={sentWa} onChange={(e) => setSentWa(e.target.checked)} />
              <MessageCircle size={13} className="text-success-ink" /> Sent on WhatsApp
            </label>
            <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
              <input type="checkbox" className="accent-accent" checked={sentEmail} onChange={(e) => setSentEmail(e.target.checked)} />
              <Mail size={13} className="text-info-ink" /> Emailed
            </label>
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Photos</label>
            <div className="flex flex-wrap gap-2 mb-1">
              {photos.map((p, i) => (
                <div key={i} className="relative group" draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData("text/plain")); const to = i; if (from !== to) { const copy = [...photos]; const [moved] = copy.splice(from, 1); copy.splice(to, 0, moved); setPhotos(copy); } }}>
                  <img src={convertFileSrc(resolvePhoto(p, mediaBase))} alt="" className="w-[72px] h-[72px] object-cover rounded-lg border border-line cursor-pointer hover:border-accent transition-colors" onClick={() => setLightbox({ photos, index: i })} onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect fill='%23f3f4f6' width='72' height='72'/%3E%3Ctext x='36' y='36' text-anchor='middle' dy='.3em' fill='%239ca3af' font-size='10'%3E?%3C/text%3E%3C/svg%3E"; }} />
                   <button onClick={async () => {
                     if (initial) {
                       try { await api.removeLotPhoto(initial.id, p); } catch (e: any) { toast(String(e), "error"); }
                     }
                     setPhotos(photos.filter((_, idx) => idx !== i));
                   }} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-danger text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X size={10} /></button>
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
                } catch (e: any) { toast(String(e), "error"); }
              }} className="w-[72px] h-[72px] border-2 border-dashed border-line-3 rounded-lg flex items-center justify-center hover:border-accent hover:bg-accent/10 transition-colors group">
                <Plus size={18} className="text-muted group-hover:text-accent transition-colors" />
              </button>
            </div>
            <p className="text-[9px] text-muted flex items-center gap-1">
              <Image size={10} /> Photos are copied into your synced folder, so they show on all your devices.
            </p>
          </div>

          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Manifest</label>
            {(manifestPath || newManifestFile) ? (
              <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                <FileText size={14} className="text-muted flex-shrink-0" />
                <span className="text-[12px] text-ink-2 truncate flex-1" title={manifestLabel}>{manifestLabel}</span>
                <button onClick={clearManifest} className="text-[11px] text-muted hover:text-danger-ink">Remove</button>
              </div>
            ) : (
              <button onClick={pickManifest}
                className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-dashed border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors">
                <Plus size={13} /> Add manifest (PDF / CSV)
              </button>
            )}
          </div>

        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving…" : initial ? "Save" : "Create lot"}
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

function LotDetail({ lot, mediaBase, onClose, onEdit, onStatus, onToggleSent, onLink, onDelete, onChanged }: {
  lot: Lot; mediaBase: string; onClose: () => void; onEdit: () => void;
  onStatus: (s: string) => void; onToggleSent: (c: "whatsapp" | "email") => void; onLink: () => void; onDelete: () => void; onChanged: () => void;
}) {
  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  const [big, setBig] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [mBusy, setMBusy] = useState(false);

  const addManifest = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: ["pdf", "csv", "xlsx", "xls"] }] });
    if (typeof f !== "string") return;
    setMBusy(true);
    try { await api.attachLotManifest(lot.id, f); onChanged(); } catch (e: any) { toast(String(e), "error"); }
    setMBusy(false);
  };
  const removeManifest = async () => {
    setMBusy(true);
    try { await api.removeLotManifest(lot.id); onChanged(); } catch (e: any) { toast(String(e), "error"); }
    setMBusy(false);
  };
  const manifestName = lot.manifest_path ? (lot.manifest_path.split(/[/\\]/).pop() || "manifest") : "";
  const uCost = lot.price_type === "total" && lot.quantity > 0 ? lot.total_cost / lot.quantity : lot.total_cost;
  const uAsk = lot.price_type === "total" && lot.quantity > 0 ? lot.asking_price / lot.quantity : lot.asking_price;
  const profit = lot.price_type === "total" ? lot.asking_price - lot.total_cost : (lot.asking_price - lot.total_cost) * lot.quantity;
  const marginPct = uCost > 0 ? ((uAsk - uCost) / uCost) * 100 : 0;
  const marginStr = uCost > 0 ? `${marginPct.toFixed(0)}%` : "—";
  const totalCostAll = lot.price_type === "per_unit" ? lot.total_cost * lot.quantity : lot.total_cost;
  const totalAskAll = lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div>
      <p className="text-[12.5px] font-medium text-muted mb-0.5">{label}</p>
      <p className="text-[13px] text-ink break-words">{value}</p>
    </div>
  );

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/30 backdrop-blur-[3px] overflow-y-auto" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[560px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-line">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase ${statusColor(lot.status)}`}>{lot.status}</span>
              {lot.category && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-semibold uppercase">{lot.category}</span>}
            </div>
            <h3 className="text-[17px] font-semibold text-ink leading-tight">{lot.name}</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 flex-shrink-0"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Photos */}
          {photos.length > 0 ? (
            <div>
              <div className="w-full h-64 bg-surface-2 rounded-xl overflow-hidden flex items-center justify-center cursor-zoom-in" onClick={() => setZoom(true)}>
                <img src={convertFileSrc(resolvePhoto(photos[big], mediaBase))} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.2"; }} />
              </div>
              {photos.length > 1 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {photos.map((p, i) => (
                    <img key={i} src={convertFileSrc(resolvePhoto(p, mediaBase))} alt="" onClick={() => setBig(i)}
                      className={`w-14 h-14 object-cover rounded-lg border cursor-pointer transition-colors ${i === big ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-line-3"}`} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="w-full h-40 bg-surface-2 rounded-xl flex items-center justify-center"><Image size={28} className="text-faint" /></div>
          )}

          {/* Sent indicators */}
          <div className="flex items-center gap-2">
            <button onClick={() => onToggleSent("whatsapp")} className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_whatsapp ? "bg-success-bg text-success-ink border-success" : "bg-danger-bg text-danger-ink border-danger hover:bg-danger-bg"}`}>
              <MessageCircle size={12} /> {lot.sent_whatsapp ? "WhatsApp sent" : "Needs WhatsApp"}
            </button>
            <button onClick={() => onToggleSent("email")} className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_email ? "bg-info-bg text-info-ink border-info" : "bg-danger-bg text-danger-ink border-danger hover:bg-danger-bg"}`}>
              <Mail size={12} /> {lot.sent_email ? "Emailed" : "Needs email"}
            </button>
          </div>

          {/* Financials */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Cost/unit</p><p className="text-[14px] font-bold text-ink tabular-nums">{fmtAmount(uCost)}</p></div>
            <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Ask/unit</p><p className="text-[14px] font-bold text-ink tabular-nums">{fmtAmount(uAsk)}</p></div>
            <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Margin</p><p className={`text-[14px] font-bold tabular-nums ${profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{marginStr}</p></div>
            <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Profit total</p><p className={`text-[14px] font-bold tabular-nums ${profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(profit)}</p></div>
          </div>
          {lot.price_type === "total" && lot.quantity > 1 && (
            <div className="grid grid-cols-3 gap-3 mt-0.5">
              <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Cost total</p><p className="text-[13px] font-bold text-ink tabular-nums">{fmtAmount(totalCostAll)}</p></div>
              <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Ask total</p><p className="text-[13px] font-bold text-ink tabular-nums">{fmtAmount(totalAskAll)}</p></div>
              <div className={inp + " text-[11px] text-muted bg-surface-2 flex items-center justify-center rounded-lg"}>×{lot.quantity} units</div>
            </div>
          )}
          {lot.price_type === "per_unit" && (
            <div className="grid grid-cols-3 gap-3 mt-0.5">
              <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Cost total</p><p className="text-[13px] font-bold text-ink tabular-nums">{fmtAmount(totalCostAll)}</p></div>
              <div className="bg-surface-2 rounded-lg px-3 py-2"><p className="text-[11.5px] font-medium text-muted">Ask total</p><p className="text-[13px] font-bold text-ink tabular-nums">{fmtAmount(totalAskAll)}</p></div>
            </div>
          )}

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-4">
            <Row label="Quantity" value={`${lot.quantity} units`} />
            <Row label="Supplier" value={lot.supplier || "—"} />
            <Row label="Location" value={lot.location || "—"} />
            <Row label="Notes" value={lot.notes || "—"} />
          </div>
          {lot.description && (
            <div>
              <p className="text-[12.5px] font-medium text-muted mb-0.5">Description</p>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap">{lot.description}</p>
            </div>
          )}

          {/* Manifest */}
          <div>
            <p className="text-[12.5px] font-medium text-muted mb-1.5">Manifest</p>
            {lot.manifest_path ? (
              <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                <FileText size={15} className="text-muted flex-shrink-0" />
                <span className="text-[13px] text-ink-2 truncate flex-1" title={manifestName}>{manifestName}</span>
                <button onClick={addManifest} disabled={mBusy} className="text-[11px] text-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-3">Replace</button>
                <button onClick={removeManifest} disabled={mBusy} className="text-[11px] text-muted hover:text-danger-ink px-2 py-1 rounded hover:bg-danger-bg">Remove</button>
              </div>
            ) : (
              <button onClick={addManifest} disabled={mBusy}
                className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-dashed border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors disabled:opacity-50">
                {mBusy ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />} Add manifest (PDF / CSV)
              </button>
            )}
          </div>

          <div className="flex items-center gap-4 text-[11px] text-muted">
            <span>Added {lot.created_at.slice(0, 10)}</span>
            <span>Updated {lot.updated_at.slice(0, 10)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap p-5 border-t border-line">
          <button onClick={onEdit} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Edit</button>
          {lot.status !== "sold" && lot.status !== "archived" && (
            <button onClick={onLink} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><Link2 size={13} /> Link to Deal</button>
          )}
          {lot.status !== "sold" && (
            <button onClick={() => onStatus("sold")} className="flex items-center gap-1 border border-success text-success-ink px-3 h-9 rounded-lg text-[12px] hover:bg-success-bg"><DollarSign size={13} /> Mark Sold</button>
          )}
          {lot.status !== "archived" && (
            <button onClick={() => onStatus("archived")} className="flex items-center gap-1 border border-danger text-danger-ink px-3 h-9 rounded-lg text-[12px] hover:bg-danger-bg"><Ban size={13} /> Not Available</button>
          )}
          {(lot.status === "sold" || lot.status === "archived") && (
            <button onClick={() => onStatus("available")} className="border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2">Restore</button>
          )}
          <button onClick={onDelete} className="flex items-center gap-1 border border-danger text-danger-ink px-3 h-9 rounded-lg text-[12px] hover:bg-danger-bg ml-auto"><Trash2 size={13} /> Delete</button>
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
