import { useEffect, useState } from "react";
import { api, Lot, Deal, ManifestAnalysis } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, Package, ChevronDown, Link2, Upload, Clipboard, BarChart3 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const STATUS_FILTERS = ["all", "available", "reserved", "sold", "archived"] as const;
type StatusFilter = typeof STATUS_FILTERS[number] | "all";

const statusColor = (s: string) => {
  switch (s) { case "available": return "bg-emerald-100 text-emerald-800"; case "reserved": return "bg-blue-100 text-blue-800"; case "sold": return "bg-gray-100 text-gray-600"; case "archived": return "bg-amber-100 text-amber-800"; default: return "bg-gray-100 text-gray-700"; }
};

const inp = "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

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

  const load = async () => { const l = await api.listInventory(); setLots(l); };
  useEffect(() => { load(); }, []);

  const openLink = async (lotId: string) => {
    setLinkModal(lotId);
    try { setDeals(await api.listDeals()); } catch {}
  };

  const counts = { all: lots.length, available: lots.filter(l => l.status === "available").length, reserved: lots.filter(l => l.status === "reserved").length, sold: lots.filter(l => l.status === "sold").length, archived: lots.filter(l => l.status === "archived").length };
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
  const profit = (lot: Lot) => lot.asking_price - lot.total_cost;

  return (
    <div>
      {toast && (
        <div className="fixed bottom-5 right-5 bg-[#1A1A1E] text-white px-4 py-2.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[13px] z-50 animate-fade-in">
          {toast}
        </div>
      )}
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Inventory</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">{counts.all} lots total</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
          <Plus size={14} /> Add Lot
        </button>
      </div>

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

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((lot) => (
            <div key={lot.id} className="bg-white border border-gray-100 rounded-xl p-4 hover:shadow-sm transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    {lot.category && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-semibold uppercase">{lot.category}</span>}
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase ${statusColor(lot.status)}`}>{lot.status}</span>
                  </div>
                  <h3 className="text-[14px] font-semibold text-gray-900">{lot.name}</h3>
                  <p className="text-[11px] text-gray-400">{lot.quantity} units{lot.description && ` · ${lot.description.slice(0, 40)}`}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-[12px] mb-2">
                <span className="text-gray-500">Cost: <span className="font-medium text-gray-700">{fmtAmount(lot.total_cost)}</span></span>
                <span className="text-gray-500">Ask: <span className="font-medium text-gray-700">{fmtAmount(lot.asking_price)}</span></span>
                <span className={`font-semibold ${profit(lot) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{margin(lot)}</span>
              </div>
              <div className="w-full h-1.5 bg-gray-100 rounded-full mb-3 overflow-hidden">
                <div className={`h-full rounded-full transition-all ${marginPct(lot) > 40 ? "bg-emerald-500" : marginPct(lot) > 20 ? "bg-lime-500" : marginPct(lot) >= 0 ? "bg-amber-400" : "bg-red-400"}`}
                  style={{ width: `${Math.min(Math.max(marginPct(lot), 0), 100)}%` }} />
              </div>
              <div className="flex items-center gap-1.5">
                {lot.status !== "sold" && lot.status !== "archived" && (
                  <button onClick={() => openLink(lot.id)} title="Link to deal" className="text-[11px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1 px-2 py-1 rounded hover:bg-indigo-50">
                    <Link2 size={11} /> Link to Deal
                  </button>
                )}
                <button onClick={() => { setEditing(lot); setShowForm(true); }} className="text-[11px] text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-50">Edit</button>
                {lot.status !== "archived" && (
                  <button onClick={async () => { try { await api.archiveLot(lot.id); load(); } catch (e: any) { alert(e); } }}
                    className="text-[11px] text-amber-500 hover:text-amber-700 px-2 py-1 rounded hover:bg-amber-50">Archive</button>
                )}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-2 text-center py-12">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3"><Package size={16} className="text-gray-400" /></div>
              <p className="text-[14px] font-semibold text-gray-800 mb-1">No lots found</p>
              <p className="text-[12px] text-gray-400">Add a lot to start tracking inventory</p>
            </div>
          )}
        </div>
      </div>

      {showForm && <LotForm initial={editing} onClose={() => { setShowForm(false); setEditing(null); load(); }} deals={deals} />}

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

function LotForm({ initial, onClose, deals }: { initial?: Lot | null; onClose: () => void; deals: Deal[] }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [qty, setQty] = useState(initial?.quantity ?? 1);
  const [cost, setCost] = useState(initial?.total_cost ?? 0);
  const [ask, setAsk] = useState(initial?.asking_price ?? 0);
  const [photos, setPhotos] = useState<string[]>(() => { try { return JSON.parse(initial?.photos_json ?? "[]") ?? []; } catch { return []; } });
  const [saving, setSaving] = useState(false);

  const pickPhoto = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (typeof f === "string") setPhotos([...photos, f]);
  };

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (initial) await api.updateLot(initial.id, { name: name.trim(), description: desc || null, category: category || null, quantity: qty, total_cost: cost, asking_price: ask, photos });
      else await api.createLot({ name: name.trim(), quantity: qty, total_cost: cost, asking_price: ask, description: desc || undefined, category: category || undefined, photos });
      onClose();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
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
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Photos</label>
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => <span key={i} className="text-[11px] bg-gray-100 px-2 py-1 rounded text-gray-600 truncate max-w-[150px]">{p.split(/[\\/]/).pop()}</span>)}
              <button onClick={pickPhoto} className="text-[11px] text-indigo-600 hover:text-indigo-800">+ Add</button>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 h-9 text-[13px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving..." : initial ? "Save" : "Create Lot"}
          </button>
        </div>
      </div>
    </div>
  );
}
