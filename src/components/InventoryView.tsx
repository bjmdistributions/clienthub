import { useEffect, useMemo, useRef, useState } from "react";
import { api, Lot, Deal, ManifestAnalysis, ParsedLoad, Client, LotDetails, CompanyInfo } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, Package, ChevronDown, Link2, Upload, Clipboard, BarChart3, FileDown, Image, ChevronLeft, ChevronRight, MessageCircle, Mail, DollarSign, Ban, Trash2, RefreshCw, CheckSquare, Check, Send, FileText, MoreVertical, MoreHorizontal, Search, Users, Pencil, RotateCcw, Lock } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "./Toast";

const STATUS_FILTERS = ["all", "available", "reserved", "sold", "archived"] as const;
type StatusFilter = typeof STATUS_FILTERS[number] | "all";
type SortKey = "newest" | "profit" | "margin" | "value" | "stale";

// A lot goes "stale" and should be re-blasted once it's been > 2 days since it
// last changed. There's no dedicated last_blasted_at, so updated_at is the proxy.
const STALE_DAYS = 2;
const daysSince = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
};
const isStale = (lot: Lot) => lot.status === "available" && daysSince(lot.updated_at) > STALE_DAYS;

const statusColor = (s: string) => {
  switch (s) { case "available": return "bg-success-bg text-success-ink"; case "reserved": return "bg-info-bg text-info-ink"; case "sold": return "bg-surface-3 text-ink-2"; case "archived": return "bg-warning-bg text-warning-ink"; default: return "bg-surface-3 text-ink-2"; }
};
// The leading status dot on the pill — single source of the per-status colour.
const statusDot = (s: string) => {
  switch (s) { case "available": return "bg-success"; case "reserved": return "bg-info"; case "sold": return "bg-ink-2"; case "archived": return "bg-warning"; default: return "bg-ink-2"; }
};

const inp = "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// ── Scoped motion (respects prefers-reduced-motion) ─────────────────────────
// Kept local so it doesn't touch global CSS. Standard easing/durations only.
const INV_MOTION_CSS = `
@keyframes invRise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes invFade { from { opacity: 0; } to { opacity: 1; } }
.inv-rise { animation: invRise 0.2s cubic-bezier(0.16,1,0.3,1) both; }
.inv-fade { animation: invFade 0.2s cubic-bezier(0.16,1,0.3,1) both; }
.inv-slideover { transition: transform 0.2s cubic-bezier(0.16,1,0.3,1); }
@media (prefers-reduced-motion: reduce) {
  .inv-rise { animation: invFade 0.2s ease both; }
  .inv-slideover { transition: none; }
  .inv-photo-zoom { transform: none !important; }
}
`;

// Photos are stored as device-independent relative paths ("media/<uuid>.jpg")
// inside the synced folder. Legacy absolute paths are passed through as-is.
const isAbsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
const resolvePhoto = (p: string, base: string) => (isAbsPath(p) || !base) ? p : `${base}/${p}`;

// Close a popover when clicking outside its container or pressing Escape.
function useDismiss(ref: React.RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close, ref]);
}

// ── Category combobox ───────────────────────────────────────────────────────
// Text input that filters `options` in a popover, arrow-key navigable, Enter to
// pick, free-typed text becomes a new category on save. Replaces the old
// <datalist>, which couldn't be keyboard-driven or show a "create new" affordance.
function CategoryCombobox({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const q = value.trim().toLowerCase();
  const matches = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(q)),
    [options, q]
  );
  // Offer "create" when the typed value isn't an exact existing option.
  const exact = options.some((o) => o.toLowerCase() === q);
  const showCreate = q.length > 0 && !exact;
  const rows: { label: string; value: string; create?: boolean }[] = [
    ...matches.map((m) => ({ label: m, value: m })),
    ...(showCreate ? [{ label: `Create "${value.trim()}"`, value: value.trim(), create: true }] : []),
  ];

  useEffect(() => { setActive(0); }, [q, open]);

  const pick = (v: string) => { onChange(v); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (open && rows[active]) { e.preventDefault(); pick(rows[active].value); } }
    else if (e.key === "Escape") { if (open) { e.preventDefault(); setOpen(false); } }
  };

  return (
    <div className="relative" ref={ref}>
      <input
        className={inp}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder ?? "Type or pick a category"}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
      />
      {value && (
        <button type="button" onClick={() => onChange("")} tabIndex={-1}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ink-2 transition-colors" title="Clear category">
          <X size={13} />
        </button>
      )}
      {open && rows.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-52 overflow-y-auto bg-surface border border-line rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.10)] py-1 inv-fade">
          {rows.map((r, i) => (
            <button key={`${r.value}-${r.create ? "new" : "opt"}`} type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r.value)}
              className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 transition-colors ${i === active ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
              {r.create ? <Plus size={12} className="flex-shrink-0" /> : <span className="w-3 flex-shrink-0" />}
              <span className="truncate">{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function InventoryView() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Lot | null>(null);
  const [prefill, setPrefill] = useState<Partial<Lot> | null>(null);
  const [prefillQueue, setPrefillQueue] = useState<Partial<Lot>[]>([]); // remaining pasted loads to step through
  const [prefillSeq, setPrefillSeq] = useState(0);                       // bumps to remount LotForm per queued load
  const [pasting, setPasting] = useState(false);
  const [blastLot, setBlastLot] = useState<Lot | null>(null);
  const [showSold, setShowSold] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [linkModal, setLinkModal] = useState<string | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [showManifest, setShowManifest] = useState(false); // manifest analyzer slide-over

  // Toolbar state
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [renewOnly, setRenewOnly] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false); // header overflow menu
  const overflowRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  useDismiss(overflowRef, overflowOpen, () => setOverflowOpen(false));
  useDismiss(sortRef, sortOpen, () => setSortOpen(false));
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim().toLowerCase()), 120); return () => clearTimeout(t); }, [search]);

  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [mediaBase, setMediaBase] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const load = async () => { const l = await api.listInventory(); setLots(l); };
  useEffect(() => {
    load();
    api.listSuppliers().then((s) => setSuppliers(s.map((x) => x.name).filter(Boolean))).catch(() => {});
    api.listCategories().then((cs) => setCategories(cs.map((c) => c.label).filter(Boolean))).catch(() => {});
    api.mediaBaseDir().then(setMediaBase).catch(() => {});
  }, []);
  // Category suggestions = the org's managed categories (buyer segments) plus any
  // category already used on a lot, so picking one keeps blasts aligned to a segment.
  const categoryOptions = Array.from(new Set([
    ...categories,
    ...lots.map((l) => (l.category || "").trim()).filter(Boolean),
  ])).sort((a, b) => a.localeCompare(b));

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

  const unitCost = (lot: Lot) => lot.price_type === "total" && lot.quantity > 0 ? lot.total_cost / lot.quantity : lot.total_cost;
  const unitAsk = (lot: Lot) => lot.price_type === "total" && lot.quantity > 0 ? lot.asking_price / lot.quantity : lot.asking_price;
  const margin = (lot: Lot) => unitCost(lot) > 0 ? `${(((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100).toFixed(0)}%` : "—";
  const marginPct = (lot: Lot) => unitCost(lot) > 0 ? ((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100 : 0;
  const totalProfit = (lot: Lot) => lot.price_type === "total" ? lot.asking_price - lot.total_cost : (lot.asking_price - lot.total_cost) * lot.quantity;
  const totalAsk = (lot: Lot) => lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;
  const totalCostAll = (lot: Lot) => lot.price_type === "per_unit" ? lot.total_cost * lot.quantity : lot.total_cost;

  // "All" hides sold/archived unless the include-toggle is on, so its count must
  // match what's actually visible — otherwise it shows e.g. "2" with an empty list.
  const includeDone = showSold && showArchived; // single "include sold & archived" toggle drives both
  const visibleUnderAll = lots.filter(l => (l.status === "sold" || l.status === "archived") ? includeDone : true).length;
  const counts = { all: visibleUnderAll, available: lots.filter(l => l.status === "available").length, reserved: lots.filter(l => l.status === "reserved").length, sold: lots.filter(l => l.status === "sold").length, archived: lots.filter(l => l.status === "archived").length };
  const totalUnits = lots.reduce((sum, l) => sum + (l.quantity || 0), 0);
  const totalValue = lots.reduce((sum, l) => sum + totalAsk(l), 0); // Σ total ask across all lots
  const staleCount = lots.filter(isStale).length;

  const matchesSearch = (l: Lot) => {
    if (!debounced) return true;
    return [l.name, l.supplier, l.category, l.location, l.notes]
      .some((f) => (f || "").toLowerCase().includes(debounced));
  };
  const filtered = lots
    .filter(l => {
      if (filter !== "all" && l.status !== filter) return false;
      if (filter === "all" && (l.status === "sold" || l.status === "archived") && !includeDone) return false;
      if (renewOnly && !isStale(l)) return false;
      return matchesSearch(l);
    })
    .sort((a, b) => {
      switch (sort) {
        case "profit": return totalProfit(b) - totalProfit(a);
        case "margin": return marginPct(b) - marginPct(a);
        case "value": return totalAsk(b) - totalAsk(a);
        case "stale": return daysSince(b.updated_at) - daysSince(a.updated_at);
        default: return Date.parse(b.created_at) - Date.parse(a.created_at); // newest
      }
    });

  const handleExportInventory = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "inventory.csv" });
    if (!path) return;
    const count = await api.exportInventoryCsv(filter === "all" ? null : filter, path as string);
    toast(`Exported ${count} inventory lot${count !== 1 ? "s" : ""} to CSV`);
  };

  const startAdd = () => { setEditing(null); setPrefill(null); setShowForm(true); };
  const clearFilters = () => { setSearch(""); setFilter("all"); setRenewOnly(false); };

  return (
    <div>
      <style>{INV_MOTION_CSS}</style>

      {/* Band A — header */}
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Inventory</h2>
          <p className="text-[12px] text-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span className="text-ink-2 font-medium tabular-nums">{counts.all}</span> lots
            <span className="text-faint">·</span>
            <span className="text-ink-2 font-medium tabular-nums">{totalUnits.toLocaleString()}</span> units
            <span className="text-faint">·</span>
            <span className="text-ink-2 font-medium tabular-nums">{fmtAmount(totalValue)}</span> total value
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <button onClick={exitSelect} className="flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2 transition-colors">
              Cancel
            </button>
          ) : (
            <>
              <button onClick={() => setPasting(true)} title="Paste a supplier load message — it fills the form for you"
                className="flex items-center gap-1.5 border border-accent/40 text-accent px-3 h-9 rounded-lg text-[13px] font-medium hover:bg-accent/10 transition-colors">
                <Clipboard size={13} /> Paste a load
              </button>
              <button onClick={startAdd} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
                <Plus size={14} /> Add lot
              </button>
              {/* Overflow — low-emphasis utilities */}
              <div className="relative" ref={overflowRef}>
                <button onClick={() => setOverflowOpen((o) => !o)} title="More"
                  className="flex items-center justify-center border border-line-3 text-ink-2 w-9 h-9 rounded-lg hover:bg-surface-2 transition-colors">
                  <MoreHorizontal size={16} />
                </button>
                {overflowOpen && (
                  <div className="absolute right-0 mt-1 z-30 w-52 bg-surface border border-line rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.10)] py-1 inv-fade">
                    <button onClick={() => { setOverflowOpen(false); resync(); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><RefreshCw size={13} className="text-muted" /> Sync to devices</button>
                    <button onClick={() => { setOverflowOpen(false); setSelectMode(true); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><CheckSquare size={13} className="text-muted" /> Select</button>
                    <button onClick={() => { setOverflowOpen(false); handleExportInventory(); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><FileDown size={13} className="text-muted" /> Export CSV</button>
                    <div className="my-1 border-t border-line" />
                    <button onClick={() => { setOverflowOpen(false); setShowManifest(true); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><BarChart3 size={13} className="text-muted" /> Analyze manifest</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {selectMode && (
        <div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-2 bg-surface border border-line rounded-xl px-4 py-2.5 shadow-sm">
          <span className="text-[13px] font-semibold text-ink-2 mr-1 tabular-nums">{selected.size} selected</span>
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

      {/* Band B — toolbar */}
      {!selectMode && (
        <div className="flex flex-wrap items-center gap-2.5 pb-3 mb-4 border-b border-line">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, supplier, category, location…"
              className="w-full border border-line rounded-lg h-9 pl-9 pr-8 text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-ink-2 transition-colors" title="Clear search"><X size={14} /></button>
            )}
          </div>

          {/* Status segmented control */}
          <div className="flex items-center bg-surface-3 rounded-lg p-0.5">
            {STATUS_FILTERS.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`text-[12px] font-medium px-2.5 h-8 rounded-md transition-all duration-[140ms] flex items-center gap-1 ${filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                <span>{f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}</span>
                <span className="text-faint tabular-nums">{counts[f]}</span>
              </button>
            ))}
          </div>

          {/* Need renewing */}
          {staleCount > 0 && (
            <button onClick={() => setRenewOnly((r) => !r)}
              title="Available lots not re-shared in over 2 days"
              className={`flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] font-medium border transition-colors ${renewOnly ? "bg-warning-bg text-warning-ink border-warning" : "bg-surface text-warning-ink border-warning/50 hover:bg-warning-bg"}`}>
              <RefreshCw size={12} /> <span className="tabular-nums">{staleCount}</span> need renewing
            </button>
          )}

          {/* Sort */}
          <div className="relative" ref={sortRef}>
            <button onClick={() => setSortOpen((o) => !o)}
              className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] text-ink-2 border border-line-3 hover:bg-surface-2 transition-colors">
              {({ newest: "Newest", profit: "Profit", margin: "Margin", value: "Value", stale: "Stale first" } as Record<SortKey, string>)[sort]}
              <ChevronDown size={13} className={`text-muted transition-transform ${sortOpen ? "rotate-180" : ""}`} />
            </button>
            {sortOpen && (
              <div className="absolute right-0 mt-1 z-30 w-40 bg-surface border border-line rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.10)] py-1 inv-fade">
                {([["newest", "Newest"], ["profit", "Profit"], ["margin", "Margin"], ["value", "Value"], ["stale", "Stale first"]] as [SortKey, string][]).map(([k, label]) => (
                  <button key={k} onClick={() => { setSort(k); setSortOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center justify-between transition-colors ${sort === k ? "text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
                    {label} {sort === k && <Check size={13} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Include sold & archived — only meaningful under "all" */}
          {filter === "all" && (
            <button onClick={() => { const next = !includeDone; setShowSold(next); setShowArchived(next); }}
              className={`h-9 px-2.5 rounded-lg text-[12px] transition-colors ${includeDone ? "text-accent" : "text-muted hover:text-ink-2"}`}>
              {includeDone ? "Hide sold & archived" : "Include sold & archived"}
            </button>
          )}
        </div>
      )}

      {/* Band C — content */}
      <div className="min-w-0 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 content-start">
        {filtered.map((lot, i) => (
          <LotCard
            key={lot.id}
            lot={lot}
            index={i}
            mediaBase={mediaBase}
            selectMode={selectMode}
            selected={selected.has(lot.id)}
            onOpen={() => onCardOpen(lot.id)}
            onToggleSent={(c) => toggleSent(lot, c)}
            onEdit={() => { setEditing(lot); setShowForm(true); }}
            onStatus={(s) => setStatus(lot, s)}
            onDelete={() => deleteOne(lot)}
            onBlast={() => setBlastLot(lot)}
            unitCost={unitCost(lot)}
            unitAsk={unitAsk(lot)}
            marginPct={marginPct(lot)}
            marginStr={margin(lot)}
            profit={totalProfit(lot)}
          />
        ))}

        {filtered.length === 0 && lots.length === 0 && (
          <div className="col-span-full flex flex-col items-center text-center py-16 inv-rise">
            <div className="w-12 h-12 rounded-xl bg-surface-3 flex items-center justify-center mb-3"><Package size={22} className="text-muted" strokeWidth={1.5} /></div>
            <p className="text-[15px] font-semibold text-ink mb-1">No inventory yet</p>
            <p className="text-[13px] text-muted max-w-xs">Add your first lot, or paste a supplier message and let it fill the form.</p>
            <div className="flex items-center gap-2 mt-4">
              <button onClick={() => setPasting(true)} className="flex items-center gap-1.5 border border-accent/40 text-accent px-3 h-9 rounded-lg text-[13px] font-medium hover:bg-accent/10 transition-colors"><Clipboard size={13} /> Paste a load</button>
              <button onClick={startAdd} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5"><Plus size={14} /> Add lot</button>
            </div>
          </div>
        )}
        {filtered.length === 0 && lots.length > 0 && (
          <div className="col-span-full flex flex-col items-center text-center py-16 inv-rise">
            <div className="w-12 h-12 rounded-xl bg-surface-3 flex items-center justify-center mb-3"><Package size={22} className="text-muted" strokeWidth={1.5} /></div>
            <p className="text-[15px] font-semibold text-ink mb-1">No lots match</p>
            <p className="text-[13px] text-muted max-w-xs">Try a different status or clear your search.</p>
            <button onClick={clearFilters} className="mt-4 text-[13px] text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2 transition-colors">Clear filters</button>
          </div>
        )}
      </div>

      {/* Manifest analyzer — right slide-over */}
      {showManifest && (
        <ManifestSlideOver
          manifest={manifest} busy={manifestBusy}
          onClose={() => setShowManifest(false)}
          onUpload={async () => {
            const f = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
            if (typeof f !== "string") return;
            setManifestBusy(true);
            try { setManifest(await api.analyzeManifest(f)); } catch (e: any) { toast(String(e), "error"); }
            setManifestBusy(false);
          }}
          onClear={() => setManifest(null)}
          onCreateLot={() => {
            // Bridge the analyzer into inventory: prefill a new lot with the manifest's numbers.
            if (!manifest) return;
            setShowManifest(false);
            setEditing(null);
            setPrefill({ quantity: manifest.total_items || 1, total_cost: manifest.suggested_bid || 0, price_type: "total" });
            setShowForm(true);
          }}
        />
      )}

      {showForm && <LotForm key={editing ? editing.id : `pf-${prefillSeq}`} initial={editing} prefill={prefill}
        onClose={() => {
          setShowForm(false); setEditing(null); load();
          // Step to the next pasted load, if any, in a freshly-prefilled form.
          if (prefillQueue.length > 0) {
            setPrefill(prefillQueue[0]); setPrefillQueue(prefillQueue.slice(1)); setPrefillSeq((s) => s + 1); setShowForm(true);
          } else { setPrefill(null); }
        }}
        deals={deals} suppliers={suppliers} categories={categoryOptions} mediaBase={mediaBase} />}

      {pasting && <PasteLoadModal
        onClose={() => setPasting(false)}
        onParsed={(pfs) => { setPasting(false); setEditing(null); setPrefill(pfs[0] ?? null); setPrefillQueue(pfs.slice(1)); setPrefillSeq((s) => s + 1); setShowForm(true); }}
      />}

      {blastLot && <BlastLoadModal lot={blastLot} onClose={() => setBlastLot(null)} onSent={() => { setBlastLot(null); load(); }} />}

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

// ── Lot card ────────────────────────────────────────────────────────────────
// Calm card with progressive disclosure: numbers always visible, actions tuck
// behind a hover bar + a MoreVertical menu so the grid reads quiet.
function LotCard({
  lot, index, mediaBase, selectMode, selected,
  onOpen, onToggleSent, onEdit, onStatus, onDelete, onBlast,
  unitCost, unitAsk, marginPct, marginStr, profit,
}: {
  lot: Lot; index: number; mediaBase: string; selectMode: boolean; selected: boolean;
  onOpen: () => void; onToggleSent: (c: "whatsapp" | "email") => void;
  onEdit: () => void; onStatus: (s: string) => void; onDelete: () => void; onBlast: () => void;
  unitCost: number; unitAsk: number; marginPct: number; marginStr: string; profit: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));

  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  const stale = isStale(lot);
  const sold = lot.status === "sold";
  const archived = lot.status === "archived";
  const reserved = lot.status === "reserved";
  // Stagger cap 8, +20ms each — enter feedback, not decoration.
  const delay = `${Math.min(index, 8) * 20}ms`;
  // Margin bar: honest three-band. <0 danger / 0–25 warning / >25 success.
  const barColor = marginPct < 0 ? "bg-danger" : marginPct <= 25 ? "bg-warning" : "bg-success";

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div onClick={onOpen} title={selectMode ? "Select" : "Open lot"}
      style={{ animationDelay: delay }}
      className={`group relative bg-surface border rounded-xl overflow-hidden transition-[box-shadow,border-color] duration-150 cursor-pointer flex flex-col inv-rise hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] ${selected ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-line-3"} ${reserved ? "border-l-2 border-l-info" : ""}`}>
      {/* Media */}
      <div className="relative w-full h-36 bg-surface-2 flex items-center justify-center overflow-hidden">
        {photos.length > 0 ? (
          <img src={convertFileSrc(resolvePhoto(photos[0], mediaBase))} alt=""
            className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03] inv-photo-zoom ${sold ? "opacity-70" : archived ? "opacity-60 grayscale-[0.3]" : ""}`}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <Package size={26} className={`text-faint ${archived ? "opacity-60" : ""}`} strokeWidth={1.5} />
        )}

        {/* Status pill — sentence case, static leading dot */}
        <span className={`absolute top-2.5 left-2.5 text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1.5 bg-surface/85 backdrop-blur-sm ${statusColor(lot.status)}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot(lot.status)}`} />
          {lot.status.charAt(0).toUpperCase() + lot.status.slice(1)}
        </span>

        {/* Bottom-right meta chips */}
        <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5">
          {lot.manifest_path && (
            <span className="w-5 h-5 rounded-full bg-black/55 text-white flex items-center justify-center" title="Manifest attached"><FileText size={11} /></span>
          )}
          {photos.length > 1 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-black/55 text-white font-medium flex items-center gap-1"><Image size={9} /> {photos.length}</span>
          )}
        </div>

        {/* Top-right: select checkbox, or hover menu button */}
        {selectMode ? (
          <span className={`absolute top-2.5 right-2.5 z-10 w-6 h-6 rounded-md flex items-center justify-center border-2 ${selected ? "bg-accent border-accent" : "bg-surface/95 border-line-3"}`}>
            {selected && <Check size={14} className="text-on-accent" />}
          </span>
        ) : (
          <div className="absolute top-2.5 right-2.5 z-10" ref={menuRef} onClick={stop}>
            <button onClick={() => setMenuOpen((o) => !o)} title="Actions"
              className={`w-7 h-7 rounded-md bg-surface/90 backdrop-blur-sm border border-line-3 text-ink-2 flex items-center justify-center transition-opacity duration-150 hover:bg-surface ${menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              style={{ transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}>
              <MoreVertical size={15} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-44 bg-surface border border-line rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.12)] py-1 inv-fade">
                {!sold && (
                  <button onClick={() => { setMenuOpen(false); onEdit(); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><Pencil size={13} className="text-muted" /> Edit</button>
                )}
                {!sold && !archived && (
                  <>
                    <button onClick={() => { setMenuOpen(false); onStatus("sold"); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><DollarSign size={13} className="text-muted" /> Mark sold</button>
                    <button onClick={() => { setMenuOpen(false); onStatus("archived"); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><Ban size={13} className="text-muted" /> Mark unavailable</button>
                  </>
                )}
                {(sold || archived) && (
                  <button onClick={() => { setMenuOpen(false); onStatus("available"); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><RotateCcw size={13} className="text-muted" /> Restore</button>
                )}
                <div className="my-1 border-t border-line" />
                <button onClick={() => { setMenuOpen(false); onDelete(); }} className="w-full text-left px-3 py-2 text-[13px] text-danger-ink hover:bg-danger-bg flex items-center gap-2 transition-colors"><Trash2 size={13} /> Delete</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3.5 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-ink leading-snug line-clamp-1 group-hover:text-accent transition-colors duration-[140ms]">{lot.name}</h3>
          <span className="text-[11px] text-muted whitespace-nowrap flex-shrink-0 mt-px tabular-nums">{lot.quantity.toLocaleString()} units</span>
        </div>
        {[lot.category, lot.supplier, lot.location].some(Boolean) && (
          <p className="text-[11px] text-muted truncate mt-0.5">{[lot.category, lot.supplier, lot.location].filter(Boolean).join(" · ")}</p>
        )}

        {/* Money block */}
        <div className={`flex items-end justify-between mt-3 ${sold ? "opacity-90" : ""}`}>
          <div>
            <div className="text-[11px] text-muted">Unit cost → ask</div>
            <div className={`text-[13px] tabular-nums mt-0.5 ${sold ? "text-muted" : "text-ink-2"}`}>
              <span className="font-semibold">{fmtAmount(unitCost)}</span>
              <span className="text-faint mx-1">→</span>
              <span className="font-semibold">{fmtAmount(unitAsk)}</span>
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[11px] text-muted">Profit</div>
            <div className={`text-[15px] font-bold tabular-nums mt-0.5 leading-none ${profit >= 0 ? "text-success-ink" : "text-danger-ink"} ${sold ? "opacity-80" : ""}`}>{fmtAmount(profit)}</div>
          </div>
        </div>

        {/* Margin bar */}
        <div className="flex items-center gap-2 mt-2.5">
          <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-[width] duration-[400ms] ease-out ${barColor}`}
              style={{ width: `${Math.min(Math.max(marginPct, 0), 100)}%` }} />
          </div>
          <span className="text-[10px] font-semibold tabular-nums text-muted w-9 text-right">{marginStr}</span>
        </div>

        {/* Footer strip — sent readouts + stale, always visible & quiet */}
        <div className="relative flex items-center gap-3 mt-2.5 pt-2.5 border-t border-line">
          <span className={`flex items-center gap-1 text-[10px] ${lot.sent_whatsapp ? "text-success-ink" : "text-faint"}`} title={lot.sent_whatsapp ? "Sent on WhatsApp" : "Not sent on WhatsApp"}>
            <MessageCircle size={11} /> WhatsApp {lot.sent_whatsapp && <Check size={10} />}
          </span>
          <span className={`flex items-center gap-1 text-[10px] ${lot.sent_email ? "text-info-ink" : "text-faint"}`} title={lot.sent_email ? "Emailed" : "Not emailed"}>
            <Mail size={11} /> Email {lot.sent_email && <Check size={10} />}
          </span>
          <div className="flex-1" />
          {stale && (
            <button onClick={(e) => { stop(e); onBlast(); }}
              title={`Last shared ${daysSince(lot.updated_at)} days ago — re-share to keep buyers warm.`}
              className="flex items-center gap-1 text-[10px] text-warning-ink bg-warning-bg border border-warning px-2 py-0.5 rounded-full hover:opacity-90 transition-opacity">
              <RefreshCw size={11} /> Renew
            </button>
          )}
        </div>

        {/* Hover action bar — slides up over the footer */}
        {!selectMode && !sold && !archived && (
          <div onClick={stop}
            className="pointer-events-none group-hover:pointer-events-auto flex items-center gap-1.5 mt-2.5 opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150"
            style={{ transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}>
            <button onClick={() => window.dispatchEvent(new CustomEvent("share-whatsapp", { detail: [lot.id] }))}
              className="flex-1 flex items-center justify-center gap-1.5 text-[12px] font-medium text-success-ink border border-success bg-success-bg hover:opacity-90 h-8 rounded-lg transition-opacity">
              <Send size={13} /> WhatsApp
            </button>
            <button onClick={onBlast}
              className="flex-1 flex items-center justify-center gap-1.5 text-[12px] font-medium text-accent border border-accent/40 bg-accent/5 hover:bg-accent/10 h-8 rounded-lg transition-colors">
              <Mail size={13} /> Blast
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Manifest analyzer — right slide-over ────────────────────────────────────
function ManifestSlideOver({ manifest, busy, onClose, onUpload, onClear, onCreateLot }: {
  manifest: ManifestAnalysis | null; busy: boolean;
  onClose: () => void; onUpload: () => void; onClear: () => void; onCreateLot: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setMounted(true)); return () => cancelAnimationFrame(r); }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className={`inv-slideover w-[520px] max-w-[94vw] h-full bg-surface border-l border-line overflow-y-auto ${mounted ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-surface z-10">
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><BarChart3 size={15} className="text-accent" /> Manifest analyzer</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <div className="p-5">
          <p className="text-[12px] text-muted mb-4">Upload a manifest CSV to break down items &amp; retail by the manifest's own categories and brands, estimate margins, and calculate a suggested bid.</p>
          {!manifest && (
            <button onClick={onUpload} disabled={busy} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
              <Upload size={13} /> {busy ? "Analyzing…" : "Upload CSV"}
            </button>
          )}
          {manifest && (
            <div>
              <div className="grid grid-cols-2 gap-3 mb-4">
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
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold text-ink-2">By category</p>
                <span className="text-[9.5px] text-muted">{manifest.categories_from_manifest ? "from manifest" : "estimated — no category column found"}</span>
              </div>
              <div className="overflow-x-auto">
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
              </div>
              {manifest.brands.length > 0 && (
                <>
                  <p className="text-[11px] font-semibold text-ink-2 mb-1.5">By brand <span className="text-[9.5px] font-normal text-muted">from manifest</span></p>
                  <div className="overflow-x-auto">
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
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => navigator.clipboard.writeText(manifest.suggested_bid.toString()).then(() => toast("Suggested bid copied — paste into your deal."))}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[11px] font-medium flex items-center gap-1.5">
                  <Clipboard size={11} /> Copy bid
                </button>
                <button onClick={onClear} className="text-[11px] text-muted hover:text-ink-2 px-3 h-8 rounded-lg hover:bg-surface-2">Clear</button>
              </div>
              <div className="mt-4 pt-4 border-t border-line">
                <button onClick={onCreateLot}
                  className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors">
                  <Plus size={13} /> Create lot from this manifest
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Paste-to-load: paste one or more supplier messages; the free rule-based parser
// (server /api/tools/parse-loads, no AI) fills a New-lot form per load to review.
function PasteLoadModal({ onClose, onParsed }: { onClose: () => void; onParsed: (pfs: Partial<Lot>[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parse = async () => {
    setBusy(true); setErr(null);
    try {
      const loads: ParsedLoad[] = await api.parseLoads(text);
      if (!loads.length) { setErr("Couldn't find a load in that text — add a bit more detail and retry."); setBusy(false); return; }
      const prefills: Partial<Lot>[] = loads.map((p) => {
        const notes = [p.notes, p.condition ? `Condition: ${p.condition}` : ""].filter(Boolean).join(" · ");
        const pt = p.price_type === "per_unit" || p.price_type === "total" ? p.price_type : undefined;
        const sizeRun = p.size_run && p.size_run.length ? p.size_run : null;
        const hasDetails = p.pallets != null || p.msrp != null || p.avg_msrp != null || p.moq != null || sizeRun != null;
        const detailsJson = hasDetails
          ? JSON.stringify({ pallets: p.pallets ?? null, msrp: p.msrp ?? null, avg_msrp: p.avg_msrp ?? null, moq: p.moq ?? null, size_run: sizeRun })
          : undefined;
        return {
          name: p.title ?? "",
          description: p.description ?? "",
          category: p.category ?? "",
          quantity: p.quantity ?? 1,
          total_cost: p.total_cost ?? p.unit_price ?? 0,
          asking_price: p.asking_price ?? 0,
          price_type: pt,
          supplier: p.supplier ?? "",
          location: p.location ?? "",
          notes: notes || undefined,
          details_json: detailsJson,
        };
      });
      onParsed(prefills);
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
        <p className="text-[12px] text-muted mb-3">Paste one or more loads — whole WhatsApp messages are fine. It strips the junk, splits multiple loads, and fills a form for each. Review, add photos and category, then save. Free — no AI, no key.</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          autoFocus
          placeholder="Paste the supplier message(s) here…"
          className="w-full border border-line px-3 py-2.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-none"
        />
        {err && <div className="text-[11.5px] text-danger-ink mt-2">{err}</div>}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9">Cancel</button>
          <button onClick={parse} disabled={busy || !text.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <><RefreshCw size={14} className="animate-spin" /> Reading…</> : <>Format loads →</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Build 2 — Blast this load: auto-draft an email from the lot, auto-pick the
// buyer segment by the lot's category (or all eligible buyers), review, send.
function BlastLoadModal({ lot, onClose, onSent }: { lot: Lot; onClose: () => void; onSent: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [mode, setMode] = useState<"category" | "all">("category");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [storeUrl, setStoreUrl] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.listClients().catch(() => [] as Client[]),
      api.getStorefrontConfig().then((c) => (c.enabled ? c.url : null)).catch(() => null),
      api.getCompanyInfo().catch(() => null),
    ]).then(([cs, url, company]) => {
      setClients(cs); setStoreUrl(url);

      // Public structured extras from the lot (never supplier/cost).
      const details: LotDetails = (() => { try { return JSON.parse(lot.details_json || "{}") ?? {}; } catch { return {}; } })();
      const pallets = details.pallets ?? null;
      const msrp = details.msrp ?? null;
      const avgMsrp = details.avg_msrp ?? null;
      const sizeRun = (details.size_run || []).filter((r) => r.size.trim());

      // Company contact block — read from org company settings, never hardcoded.
      const co: CompanyInfo | null = company;
      const phone = co?.phone?.trim() || "";
      const website = url || "";

      setSubject(`New load: ${lot.name}`);

      const price = lot.asking_price > 0
        ? `${lot.price_type === "per_unit" ? "Price per unit" : "Price for the lot"} - $${fmtAmount(lot.asking_price).replace(/^\$/, "")}`
        : "";
      // Header summary line: "<pallets> pallets · <units> units · <brand mix>".
      const summary = [
        pallets ? `${pallets} pallets` : "",
        lot.quantity > 0 ? `${lot.quantity} units` : "",
        lot.description || "",
      ].filter(Boolean).join(" · ");

      // Compose the outbound template; every line is dropped when its value is missing.
      const lines: string[] = [];
      lines.push("Hey {{first_name}},");
      lines.push("");
      lines.push(lot.name);
      if (summary) { lines.push(""); lines.push(summary); }
      lines.push("");
      if (lot.quantity > 0) lines.push(`UNITS - ${lot.quantity}`);
      if (pallets) lines.push(`PALLETS - ${pallets}`);
      if (msrp) lines.push(`TOTAL MSRP - $${fmtAmount(msrp).replace(/^\$/, "")}`);
      if (avgMsrp) lines.push(`AVG MSRP - $${fmtAmount(avgMsrp).replace(/^\$/, "")}`);
      if (price) lines.push(price);
      if (sizeRun.length) {
        lines.push("");
        lines.push("Sizes:");
        for (const r of sizeRun) lines.push(`${r.size} - ${r.qty}`);
      }
      lines.push("");
      lines.push(`If you want any specifics or the manifest, reply here${phone ? ` or text/call me at ${phone}` : ""}.`);
      lines.push("");
      lines.push("Thanks,");
      lines.push("");
      // Contact/signature block — omit any missing field.
      if (co?.name?.trim()) lines.push(co.name.trim());
      if (co?.email?.trim()) lines.push(co.email.trim());
      if (phone) lines.push(phone);
      if (website) lines.push(website);

      setBody(lines.join("\n"));
      setLoaded(true);
    });
  }, [lot]);

  // Eligible = has email, not blacklisted, not do-not-bulk. Matched = same category.
  const eligible = clients.filter((c) => c.email && !c.is_blacklisted && !c.exclusive);
  const cat = (lot.category || "").trim().toLowerCase();
  const matched = eligible.filter((c) => cat && (c.category || "").trim().toLowerCase() === cat);
  const recipients = mode === "category" ? matched : eligible;
  const topBuyers = [...eligible].sort((a, b) => (b.total_revenue || 0) - (a.total_revenue || 0)).slice(0, 3);

  const send = async () => {
    if (!recipients.length) { toast("No matching buyers to send to.", "error"); return; }
    if (!subject.trim() || !body.trim()) { toast("Subject and message are required.", "error"); return; }
    if (!confirm(`Send this load to ${recipients.length} buyer${recipients.length === 1 ? "" : "s"}? Each gets an individual email.`)) return;
    setSending(true);
    try {
      const nl = await api.saveNewsletter(null, subject.trim(), body);
      await api.sendNewsletter(nl.id, recipients.map((c) => c.id), subject.trim(), body, null);
      toast(`Blasting to ${recipients.length} buyers…`);
      onSent();
    } catch (e: any) { toast(String(e), "error"); setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[9vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[520px] max-w-[94vw] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><Mail size={15} className="text-accent" /> Blast this load</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <p className="text-[12px] text-muted mb-3 truncate">{lot.name}</p>

        {!loaded ? (
          <div className="text-sm text-muted py-8 text-center">Loading buyers…</div>
        ) : (
          <>
            {/* Audience */}
            <div className="bg-surface-2 border border-line rounded-lg p-2.5 mb-3">
              <div className="flex items-center gap-1.5 mb-2">
                <button onClick={() => setMode("category")} disabled={!matched.length}
                  className={`flex-1 text-[12px] font-medium h-8 rounded-lg border transition-colors disabled:opacity-40 ${mode === "category" ? "bg-accent text-on-accent border-accent" : "border-line text-ink-2 hover:bg-surface-3"}`}>
                  {lot.category || "Category"} · {matched.length}
                </button>
                <button onClick={() => setMode("all")}
                  className={`flex-1 text-[12px] font-medium h-8 rounded-lg border transition-colors ${mode === "all" ? "bg-accent text-on-accent border-accent" : "border-line text-ink-2 hover:bg-surface-3"}`}>
                  All buyers · {eligible.length}
                </button>
              </div>
              <div className="text-[11.5px] text-muted">
                <span className="flex items-center gap-1.5">
                  <Users size={12} className="text-muted flex-shrink-0" />
                  <span><span className="tabular-nums">{recipients.length}</span> buyer{recipients.length === 1 ? "" : "s"} will receive this.
                  {topBuyers.length > 0 && <> Top: {topBuyers.map((b) => b.name).join(", ")}.</>}</span>
                </span>
                <span className="block mt-0.5">Blacklisted &amp; do-not-bulk buyers are always excluded.</span>
              </div>
            </div>

            <div className="space-y-2">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
                className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9}
                className="w-full bg-surface-2 border border-line rounded-lg px-2.5 py-2 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none leading-relaxed" />
              <p className="text-[11px] text-muted"><code>{"{{first_name}}"}</code> is personalized per buyer.</p>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={onClose} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9">Cancel</button>
              <button onClick={send} disabled={sending || !recipients.length}
                className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                {sending ? <><RefreshCw size={14} className="animate-spin" /> Sending…</> : <><Send size={14} /> Send to {recipients.length}</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LotForm({ initial, prefill, onClose, suppliers, categories, mediaBase }: { initial?: Lot | null; prefill?: Partial<Lot> | null; onClose: () => void; deals: Deal[]; suppliers: string[]; categories: string[]; mediaBase: string }) {
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

  // Structured extras (details_json). Public: pallets/msrp/sizeRun. Internal: moq.
  // Seed from the edited lot, or from a pasted-load prefill.
  const seedDetails = (): LotDetails => {
    try { return JSON.parse((initial?.details_json ?? (prefill as any)?.details_json) || "{}") ?? {}; }
    catch { return {}; }
  };
  const [details0] = useState<LotDetails>(seedDetails);
  const [pallets, setPallets] = useState<number>(details0.pallets ?? 0);
  const [msrp, setMsrp] = useState<number>(details0.msrp ?? 0);
  const [moq, setMoq] = useState<number>(details0.moq ?? 0);
  const [sizeRun, setSizeRun] = useState<{ size: string; qty: number }[]>(details0.size_run ?? []);

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
      // Build the public/internal extras blob. Undefined when everything's empty
      // so we don't persist an empty object.
      const cleanRun = sizeRun.filter((r) => r.size.trim());
      const hasDetails = !!pallets || !!msrp || !!moq || cleanRun.length > 0;
      const detailsJson = hasDetails
        ? JSON.stringify({ pallets: pallets || null, msrp: msrp || null, moq: moq || null, size_run: cleanRun })
        : undefined;
      if (initial) {
        await api.updateLot(initial.id, { name: name.trim(), description: desc || null, category: category || null, quantity: qty, totalCost: cost, askingPrice: ask, photos, notes: notes.trim() || null, sentWhatsapp: sentWa, sentEmail: sentEmail, supplier: supplier.trim() || null, location: location.trim() || null, priceType, detailsJson });
      } else {
        const lot = await api.createLot({ name: name.trim(), quantity: qty, totalCost: cost, askingPrice: ask, description: desc || undefined, category: category || undefined, notes: notes.trim() || undefined, supplier: supplier.trim() || undefined, location: location.trim() || undefined, priceType, detailsJson });
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[440px] max-w-[92vw] max-h-[82vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
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
            <label className="block text-[12.5px] font-medium text-muted mb-1">Category</label>
            <CategoryCombobox value={category} onChange={setCategory} options={categories} />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Description</label>
            <input className={inp} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Quantity (units)</label>
              <input className={inp} type="number" value={qty} onChange={(e) => setQty(parseInt(e.target.value) || 0)} />
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Pallets</label>
              <input className={inp} type="number" value={pallets || ""} onChange={(e) => setPallets(parseInt(e.target.value) || 0)} placeholder="0" />
            </div>
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Location</label>
            <input className={inp} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Warehouse A, Shelf 3" />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">MSRP (total retail)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
              <input className={inp + " pl-6"} type="number" step="0.01" value={msrp || ""} onChange={(e) => setMsrp(parseFloat(e.target.value) || 0)} placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Selling price</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={ask || ""} onChange={(e) => setAsk(parseFloat(e.target.value) || 0)} placeholder="0.00" />
              </div>
              <div className="flex gap-1 bg-surface-3 rounded-lg p-0.5 flex-shrink-0">
                {(["per_unit", "total"] as const).map(pt => (
                  <button key={pt} onClick={() => setPriceType(pt)}
                    className={`text-[12px] font-medium px-2.5 rounded-md transition-colors ${priceType === pt ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                    {pt === "per_unit" ? "Per unit" : "Fixed total"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Size run editor */}
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Size run (size → quantity)</label>
            <div className="space-y-1.5">
              {sizeRun.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className={inp + " flex-1"} value={r.size} placeholder='Size (e.g. "10.5")'
                    onChange={(e) => setSizeRun(sizeRun.map((row, idx) => idx === i ? { ...row, size: e.target.value } : row))} />
                  <input className={inp + " w-24 tabular-nums"} type="number" value={r.qty || ""} placeholder="Qty"
                    onChange={(e) => setSizeRun(sizeRun.map((row, idx) => idx === i ? { ...row, qty: parseInt(e.target.value) || 0 } : row))} />
                  <button onClick={() => setSizeRun(sizeRun.filter((_, idx) => idx !== i))} title="Remove size"
                    className="w-8 h-9 flex items-center justify-center text-muted hover:text-danger-ink transition-colors flex-shrink-0"><X size={14} /></button>
                </div>
              ))}
              <button onClick={() => setSizeRun([...sizeRun, { size: "", qty: 0 }])}
                className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-dashed border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors">
                <Plus size={13} /> Add size
              </button>
            </div>
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

          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Notes</label>
            <input className={inp} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Authentic, sealed, minor box damage" />
          </div>

          {/* Internal — never shown to buyers. Supplier, your cost, and MOQ stay private. */}
          <div className="bg-surface-2 border border-line rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
              <Lock size={13} className="text-muted" /> Internal — never shown to buyers
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Supplier</label>
              <input className={inp} list="lot-supplier-options" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Type or pick a supplier" />
              <datalist id="lot-supplier-options">
                {suppliers.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1">Your cost</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                  <input className={inp + " pl-6"} type="number" step="0.01" value={cost || ""} onChange={(e) => setCost(parseFloat(e.target.value) || 0)} placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1">MOQ (min order qty)</label>
                <input className={inp + " tabular-nums"} type="number" value={moq || ""} onChange={(e) => setMoq(parseInt(e.target.value) || 0)} placeholder="0" />
              </div>
            </div>
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
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex items-center gap-1.5 ${statusColor(lot.status)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot(lot.status)}`} />
                {lot.status.charAt(0).toUpperCase() + lot.status.slice(1)}
              </span>
              {lot.category && <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">{lot.category}</span>}
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
            <div className="w-full h-40 bg-surface-2 rounded-xl flex items-center justify-center"><Package size={28} className="text-faint" strokeWidth={1.5} /></div>
          )}

          {/* Sent indicators — quiet flags, click to toggle (same language as the card) */}
          <div className="flex items-center gap-2">
            <button onClick={() => onToggleSent("whatsapp")} title={lot.sent_whatsapp ? "Sent on WhatsApp — click to unmark" : "Not sent on WhatsApp — click to mark sent"}
              className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_whatsapp ? "bg-success-bg text-success-ink border-success" : "bg-surface-2 text-muted border-line hover:bg-surface-3"}`}>
              <MessageCircle size={12} /> WhatsApp {lot.sent_whatsapp && <Check size={11} />}
            </button>
            <button onClick={() => onToggleSent("email")} title={lot.sent_email ? "Emailed — click to unmark" : "Not emailed — click to mark sent"}
              className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-full border transition-colors ${lot.sent_email ? "bg-info-bg text-info-ink border-info" : "bg-surface-2 text-muted border-line hover:bg-surface-3"}`}>
              <Mail size={12} /> Email {lot.sent_email && <Check size={11} />}
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
