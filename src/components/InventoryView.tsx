import { useEffect, useMemo, useRef, useState } from "react";
import { api, Lot, Deal, ParsedLoad, Client, LotDetails, LotOption, LotVariant, CompanyInfo, StorefrontConfig, Offer, FbStatus } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { normalizeLocation } from "../lib/location";
import { Plus, X, Package, ChevronDown, Link2, Upload, Clipboard, FileDown, Image, ChevronLeft, ChevronRight, MessageCircle, Mail, DollarSign, Ban, Trash2, RefreshCw, CheckSquare, Check, Send, FileText, MoreVertical, MoreHorizontal, Search, Users, Pencil, RotateCcw, Lock, ExternalLink, GitBranch, Facebook } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
// Pill tokens for a deal stage — negotiating leans on the accent, earlier stages
// read as informational. Shared by the link picker and the linked-deal row.
const dealStageColor = (s: string) => s === "negotiating" ? "bg-accent/10 text-accent" : "bg-info-bg text-info-ink";
const dealStageLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const inp = "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
// Grid-cell input WITHOUT w-full — for side-by-side boxes whose width comes from an
// explicit class (the old form's w-full fought flex/fixed widths and collapsed boxes).
const cellInp = "border border-line rounded-lg h-9 px-2.5 text-[13px] focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors";

// A lot's "needs attention" list: missing info a buyer would expect, plus media that
// hasn't fully synced (a photo missing on this device, or still uploading to the server).
type MediaIssue = { missing_local: boolean; pending_upload: boolean };
function lotWarnings(lot: Lot, issue?: MediaIssue): string[] {
  const w: string[] = [];
  let photos: string[] = [];
  try { photos = JSON.parse(lot.photos_json || "[]") ?? []; } catch { photos = []; }
  let details: any = {};
  try { details = JSON.parse(lot.details_json || "{}") ?? {}; } catch { details = {}; }
  if (photos.length === 0) w.push("No photos");
  const hasPrice = lot.asking_price > 0 || (lot.price_type === "custom" && !!details.price_text)
    || (Array.isArray(details.variants) && details.variants.some((v: any) => v && v.price > 0));
  if (!hasPrice) w.push("No price set");
  if (!(lot.category || "").trim()) w.push("No category");
  if (issue?.missing_local) w.push("Photos haven’t synced to this device");
  if (issue?.pending_upload) w.push("Photos still uploading to your devices");
  return w;
}
// Common wholesale/liquidation conditions offered as quick-picks (free text still allowed).
const CONDITIONS = ["New", "Open box", "Refurbished", "Customer returns", "Shelf pulls", "Overstock", "Salvage / damaged", "Mixed"];

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
// Normalize backslashes so a Windows base ("C:\…\sync") + a forward-slash relative
// photo path don't produce a mixed-separator path that convertFileSrc mishandles.
// Tolerates a falsy path (a stale index after photos shrink) instead of throwing.
const resolvePhoto = (p: string, base: string) => {
  if (!p) return "";
  return (isAbsPath(p) || !base) ? p.replace(/\\/g, "/") : `${base.replace(/\\/g, "/")}/${p}`;
};

// A background media download writes the byte to disk but a re-render with the SAME
// <img src> won't re-request a URL that already 404'd this session. Bumping this
// module-level counter (on an `inventory-media-updated` event) and appending it as a
// cache-buster forces every photo to re-fetch, so newly-arrived images appear live
// instead of staying blank until the tab is reopened. It's a plain module var read at
// render time, so no prop-threading through LotCard/LotDetail/LotForm is needed.
let mediaBust = 0;
const photoSrc = (p: string, base: string): string => {
  const u = convertFileSrc(resolvePhoto(p, base));
  return mediaBust ? `${u}${u.includes("?") ? "&" : "?"}mv=${mediaBust}` : u;
};

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

export default function InventoryView() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [staleModal, setStaleModal] = useState<{ id: string; name: string; status: string }[] | null>(null);
  const [staleBusy, setStaleBusy] = useState(false);
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
  const [clients, setClients] = useState<Client[]>([]);

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
  const [storefront, setStorefront] = useState<StorefrontConfig | null>(null);
  const [mediaIssues, setMediaIssues] = useState<Record<string, MediaIssue>>({});
  const [attentionOnly, setAttentionOnly] = useState(false);
  const loadOffers = () => api.listOffers().then(setOffers).catch(() => {});
  const loadIssues = () => api.listMediaSyncIssues()
    .then((rows) => setMediaIssues(Object.fromEntries(rows.map((r) => [r.lot_id, { missing_local: r.missing_local, pending_upload: r.pending_upload }]))))
    .catch(() => {});
  const load = async () => { const l = await api.listInventory(); setLots(l); loadOffers(); loadIssues(); };
  const checkStaleLots = async () => {
    setStaleBusy(true);
    try {
      const stale = await api.listStaleServerLots();
      if (stale.length === 0) toast("Everything's in sync — no removed lots to clean up.");
      else setStaleModal(stale);
    } catch (e: any) { toast(String(e), "error"); }
    setStaleBusy(false);
  };
  const pruneStale = async () => {
    if (!staleModal) return;
    setStaleBusy(true);
    try {
      const n = await api.deleteLots(staleModal.map((s) => s.id));
      toast(`Cleaned up ${n} removed lot${n !== 1 ? "s" : ""} — they'll drop off mobile shortly.`);
      setStaleModal(null);
      load();
    } catch (e: any) { toast(String(e), "error"); }
    setStaleBusy(false);
  };
  useEffect(() => {
    load();
    api.listSuppliers().then((s) => setSuppliers(s.map((x) => x.name).filter(Boolean))).catch(() => {});
    api.listCategories().then((cs) => setCategories(cs.map((c) => c.label).filter(Boolean))).catch(() => {});
    api.mediaBaseDir().then(setMediaBase).catch(() => {});
    api.getStorefrontConfig().then(setStorefront).catch(() => {});
    api.listDeals().then(setDeals).catch(() => {});
    api.listClients().then(setClients).catch(() => {});
  }, []);
  // The standalone Manifest analyzer (its own tab) sends a lot here via this event: open
  // a new lot form prefilled with the manifest's numbers, carrying the manifest summary in
  // details_json so it persists to the lot and shows on the storefront.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setEditing(null);
      setPrefill({
        quantity: d.quantity ?? 1,
        total_cost: d.total_cost ?? 0,
        price_type: d.price_type ?? "total",
        details_json: d.manifest ? JSON.stringify({ manifest: d.manifest }) : undefined,
      } as Partial<Lot>);
      setPrefillSeq((s) => s + 1);
      setShowForm(true);
    };
    window.addEventListener("inventory-prefill-lot", onPrefill as EventListener);
    return () => window.removeEventListener("inventory-prefill-lot", onPrefill as EventListener);
  }, []);
  // Re-read inventory when a background sync lands so remote row edits AND freshly
  // downloaded photos appear live in the open view (previously they only showed after
  // reopening the tab). `inventory-media-updated` fires when the reconcile pulls image
  // bytes — bump the cache-buster so already-blank <img> elements actually re-fetch.
  useEffect(() => {
    let active = true;
    const subs: Array<() => void> = [];
    (async () => {
      const a = await listen("netsync-applied", () => load());
      const b = await listen("inventory-media-updated", () => { mediaBust++; load(); });
      if (!active) { a(); b(); return; }
      subs.push(a, b);
    })();
    return () => { active = false; subs.forEach((u) => u()); };
  }, []);
  // Live storefront link (null unless the storefront is on) — powers the header bar
  // and the per-lot "copy storefront link" actions.
  const storeUrl = storefront?.enabled ? (storefront.url ?? null) : null;
  const copyStoreLink = (lotId?: string) => {
    if (!storeUrl) return;
    const link = lotId ? `${storeUrl}?lot=${lotId}` : storeUrl;
    navigator.clipboard.writeText(link).then(() => toast("Link copied")).catch(() => {});
  };
  // Open the product's storefront listing in the browser (the buyer-facing page).
  const openStoreLink = (lotId?: string) => {
    if (!storeUrl) return;
    const link = lotId ? `${storeUrl}?lot=${lotId}` : storeUrl;
    api.openExternal(link).catch(() => {});
  };
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

  // Renew = refresh the listing's freshness only. update_lot always bumps
  // updated_at server-side (which clears the stale flag) and sends no email —
  // that's deliberately separate from the Blast action, which emails buyers.
  const renewLot = async (lot: Lot) => {
    try { await api.updateLot(lot.id, {}); toast("Renewed — freshness reset."); load(); }
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
  const [photoSyncBusy, setPhotoSyncBusy] = useState(false);
  const syncPhotos = async () => {
    setPhotoSyncBusy(true);
    try {
      const r = await api.reconcileInventoryMedia();
      const parts = [];
      if (r.downloaded) parts.push(`pulled ${r.downloaded}`);
      if (r.uploaded) parts.push(`uploaded ${r.uploaded}`);
      toast(parts.length ? `Photos synced — ${parts.join(", ")}` : "Photos already in sync");
      if (r.downloaded) { mediaBust++; load(); }
    } catch (e: any) { toast(String(e), "error"); }
    setPhotoSyncBusy(false);
  };
  // In select mode the card click selects instead of opening detail.
  const onCardOpen = (id: string) => { if (selectMode) toggleSelect(id); else setDetailId(id); };

  // Custom-priced lots have no numeric ask, so every ask/profit/margin helper
  // returns a neutral zero/dash for them — the display never renders those lines.
  const unitCost = (lot: Lot) => lot.price_type === "total" && lot.quantity > 0 ? lot.total_cost / lot.quantity : lot.total_cost;
  const unitAsk = (lot: Lot) => lot.price_type === "custom" ? 0 : lot.price_type === "total" && lot.quantity > 0 ? lot.asking_price / lot.quantity : lot.asking_price;
  const margin = (lot: Lot) => lot.price_type === "custom" ? "—" : unitCost(lot) > 0 ? `${(((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100).toFixed(0)}%` : "—";
  const marginPct = (lot: Lot) => lot.price_type === "custom" ? 0 : unitCost(lot) > 0 ? ((unitAsk(lot) - unitCost(lot)) / unitCost(lot)) * 100 : 0;
  const totalProfit = (lot: Lot) => lot.price_type === "custom" ? 0 : lot.price_type === "total" ? lot.asking_price - lot.total_cost : (lot.asking_price - lot.total_cost) * lot.quantity;
  const totalAsk = (lot: Lot) => lot.price_type === "custom" ? 0 : lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;
  const totalCostAll = (lot: Lot) => lot.price_type === "per_unit" ? lot.total_cost * lot.quantity : lot.total_cost;

  // "All" hides sold/archived unless the include-toggle is on, so its count must
  // match what's actually visible — otherwise it shows e.g. "2" with an empty list.
  const includeDone = showSold && showArchived; // single "include sold & archived" toggle drives both
  const visibleUnderAll = lots.filter(l => (l.status === "sold" || l.status === "archived") ? includeDone : true).length;
  const counts = { all: visibleUnderAll, available: lots.filter(l => l.status === "available").length, reserved: lots.filter(l => l.status === "reserved").length, sold: lots.filter(l => l.status === "sold").length, archived: lots.filter(l => l.status === "archived").length };
  const totalUnits = lots.reduce((sum, l) => sum + (l.quantity || 0), 0);
  const newOffers = offers.filter((o) => o.status === "new");
  const newOfferByLot = newOffers.reduce((m, o) => { m[o.lot_id] = (m[o.lot_id] || 0) + 1; return m; }, {} as Record<string, number>);
  const totalValue = lots.reduce((sum, l) => sum + totalAsk(l), 0); // Σ total ask across all lots
  const staleCount = lots.filter(isStale).length;

  const matchesSearch = (l: Lot) => {
    if (!debounced) return true;
    return [l.name, l.supplier, l.category, l.location, l.notes]
      .some((f) => (f || "").toLowerCase().includes(debounced));
  };
  // Lots with a "needs attention" flag (missing info or unsynced media) — powers the banner + filter.
  const attentionCount = lots.filter((l) => l.status !== "archived" && lotWarnings(l, mediaIssues[l.id]).length > 0).length;
  const filtered = lots
    .filter(l => {
      if (filter !== "all" && l.status !== filter) return false;
      if (filter === "all" && (l.status === "sold" || l.status === "archived") && !includeDone) return false;
      if (renewOnly && !isStale(l)) return false;
      if (attentionOnly && lotWarnings(l, mediaIssues[l.id]).length === 0) return false;
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
                    <button onClick={() => { setOverflowOpen(false); syncPhotos(); }} disabled={photoSyncBusy} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors disabled:opacity-50"><Image size={13} className="text-muted" /> {photoSyncBusy ? "Syncing photos…" : "Sync photos now"}</button>
                    <button onClick={() => { setOverflowOpen(false); checkStaleLots(); }} disabled={staleBusy} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors disabled:opacity-50"><Trash2 size={13} className="text-muted" /> Clean up removed lots</button>
                    <button onClick={() => { setOverflowOpen(false); setSelectMode(true); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><CheckSquare size={13} className="text-muted" /> Select</button>
                    <button onClick={() => { setOverflowOpen(false); handleExportInventory(); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><FileDown size={13} className="text-muted" /> Export CSV</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Storefront link — one calm row; live link when on, quiet hint when off */}
      {storefront && !selectMode && (
        storeUrl ? (
          <div className="flex items-center gap-2 mb-4 bg-surface-2 border border-line rounded-lg px-3 h-10">
            <Link2 size={13} className="text-muted flex-shrink-0" />
            <span className="text-[12px] text-muted flex-shrink-0">Storefront</span>
            <span className="text-[12px] text-ink-2 truncate min-w-0 flex-1" title={storeUrl}>{storeUrl}</span>
            <button onClick={() => copyStoreLink()}
              className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 px-2.5 h-7 rounded-md hover:bg-surface-2 transition-colors flex-shrink-0">
              <Clipboard size={12} /> Copy link
            </button>
            <button onClick={() => api.openExternal(storeUrl)}
              className="flex items-center gap-1.5 text-[12px] text-accent px-2.5 h-7 rounded-md hover:bg-accent/10 transition-colors flex-shrink-0">
              <ExternalLink size={12} /> Open
            </button>
          </div>
        ) : (
          <p className="text-[12px] text-muted flex items-center gap-1.5 mb-4">
            <Link2 size={13} className="text-faint flex-shrink-0" /> Your public storefront is off — turn it on in Settings → Storefront.
          </p>
        )
      )}

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

      {/* New buyer offers — surfaced so you don't miss them */}
      {newOffers.length > 0 && (() => {
        const names = Object.keys(newOfferByLot).map((id) => lots.find((l) => l.id === id)?.name).filter(Boolean) as string[];
        const first = names[0] || "a lot";
        return (
          <button
            onClick={() => { const id = Object.keys(newOfferByLot)[0]; if (id) setDetailId(id); }}
            className="w-full flex items-center gap-2.5 mb-4 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-left hover:bg-accent/15 transition-colors">
            <DollarSign size={16} className="text-accent flex-shrink-0" />
            <span className="text-[13px] text-ink min-w-0">
              <span className="font-semibold">{newOffers.length} new offer{newOffers.length !== 1 ? "s" : ""}</span>
              <span className="text-muted"> · {first}{names.length > 1 ? ` +${names.length - 1} more` : ""} — review {newOffers.length !== 1 ? "them" : "it"} on the lot</span>
            </span>
          </button>
        );
      })()}

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
              <button key={f} onClick={() => { setFilter(f); if (f !== "all" && f !== "available") setRenewOnly(false); }}
                className={`text-[12px] font-medium px-2.5 h-8 rounded-md transition-all duration-[140ms] flex items-center gap-1 ${filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                <span>{f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}</span>
                <span className="text-faint tabular-nums">{counts[f]}</span>
              </button>
            ))}
          </div>

          {/* Need renewing */}
          {staleCount > 0 && (
            <button onClick={() => { const next = !renewOnly; setRenewOnly(next); if (next && filter !== "all" && filter !== "available") setFilter("available"); }}
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

      {/* Needs-attention banner — missing info or media that hasn't fully synced */}
      {attentionCount > 0 && (
        <button type="button" onClick={() => setAttentionOnly((v) => !v)}
          className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border text-left transition-colors mb-3 ${attentionOnly ? "border-warning bg-warning-bg" : "border-warning/40 bg-warning-bg/50 hover:bg-warning-bg"}`}>
          <RefreshCw size={14} className="text-warning-ink flex-shrink-0" />
          <span className="text-[12.5px] text-ink-2 flex-1 min-w-0">
            <span className="font-semibold text-ink">{attentionCount} lot{attentionCount !== 1 ? "s" : ""}</span> need attention — missing photos, price, category, or media that hasn’t synced across devices.
          </span>
          <span className="text-[11.5px] font-medium text-warning-ink flex-shrink-0">{attentionOnly ? "Show all" : "Show these"}</span>
        </button>
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
            warnings={lotWarnings(lot, mediaIssues[lot.id])}
            onOpen={() => onCardOpen(lot.id)}
            onToggleSent={(c) => toggleSent(lot, c)}
            onEdit={() => { setEditing(lot); setShowForm(true); }}
            onStatus={(s) => setStatus(lot, s)}
            onDelete={() => deleteOne(lot)}
            onBlast={() => setBlastLot(lot)}
            onRenew={() => renewLot(lot)}
            storeUrl={storeUrl}
            onCopyStoreLink={() => copyStoreLink(lot.id)}
            unitCost={unitCost(lot)}
            unitAsk={unitAsk(lot)}
            loadPrice={totalAsk(lot)}
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

      {showForm && <LotForm key={editing ? editing.id : `pf-${prefillSeq}`} initial={editing} prefill={prefill}
        onClose={() => {
          setShowForm(false); setEditing(null); load();
          // Step to the next pasted load, if any, in a freshly-prefilled form.
          if (prefillQueue.length > 0) {
            setPrefill(prefillQueue[0]); setPrefillQueue(prefillQueue.slice(1)); setPrefillSeq((s) => s + 1); setShowForm(true);
          } else { setPrefill(null); }
        }}
        deals={deals} suppliers={suppliers} categories={categoryOptions} mediaBase={mediaBase} lots={lots} />}

      {pasting && <PasteLoadModal
        onClose={() => setPasting(false)}
        onParsed={(pfs) => { setPasting(false); setEditing(null); setPrefill(pfs[0] ?? null); setPrefillQueue(pfs.slice(1)); setPrefillSeq((s) => s + 1); setShowForm(true); }}
      />}

      {blastLot && <BlastLoadModal lot={blastLot} onClose={() => setBlastLot(null)} onSent={() => { setBlastLot(null); load(); }} />}

      {staleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !staleBusy && setStaleModal(null)}>
          <div className="bg-surface border border-line rounded-2xl w-full max-w-md shadow-xl flex flex-col max-h-[82vh]" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line">
              <h3 className="text-[15px] font-semibold text-ink">Clean up removed lots</h3>
              <p className="text-[12px] text-muted mt-0.5">These {staleModal.length} lot{staleModal.length !== 1 ? "s are" : " is"} on the server (so they still show on mobile &amp; your storefront) but no longer on this computer. Removing them clears them everywhere.</p>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3 divide-y divide-line-2">
              {staleModal.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-[13px] text-ink truncate">{s.name}</span>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted flex-shrink-0">{s.status}</span>
                </div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
              <button onClick={() => setStaleModal(null)} disabled={staleBusy} className="px-4 h-9 rounded-lg border border-line text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-50">Cancel</button>
              <button onClick={pruneStale} disabled={staleBusy} className="px-5 h-9 rounded-lg bg-danger hover:opacity-90 text-white text-[13px] font-medium disabled:opacity-50">
                {staleBusy ? "Removing…" : `Remove ${staleModal.length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailId && (() => {
        const detail = lots.find((l) => l.id === detailId);
        if (!detail) return null;
        return (
          <LotDetail
            lot={detail}
            deals={deals}
            mediaBase={mediaBase}
            warnings={lotWarnings(detail, mediaIssues[detail.id])}
            offers={offers.filter((o) => o.lot_id === detail.id)}
            onOffersChanged={loadOffers}
            onClose={() => setDetailId(null)}
            onEdit={() => { setEditing(detail); setShowForm(true); setDetailId(null); }}
            onStatus={(s) => setStatus(detail, s)}
            onToggleSent={(c) => toggleSent(detail, c)}
            onLink={() => openLink(detail.id)}
            onDelete={() => deleteOne(detail)}
            onChanged={load}
            storeUrl={storeUrl}
            onCopyStoreLink={() => copyStoreLink(detail.id)}
            onOpenStoreLink={() => openStoreLink(detail.id)}
          />
        );
      })()}

      {linkModal && (() => {
        const lot = lots.find((l) => l.id === linkModal);
        if (!lot) return null;
        return (
          <LinkDealModal
            lot={lot}
            deals={deals}
            clients={clients}
            mediaBase={mediaBase}
            onClose={() => setLinkModal(null)}
            onLink={async (dealId) => {
              try { await api.linkLotToDeal(lot.id, dealId); setLinkModal(null); load(); }
              catch (e: any) { toast(String(e), "error"); }
            }}
          />
        );
      })()}
    </div>
  );
}

// ── Lot card ────────────────────────────────────────────────────────────────
// Calm card with progressive disclosure: numbers always visible, actions tuck
// behind a hover bar + a MoreVertical menu so the grid reads quiet.
function LotCard({
  lot, index, mediaBase, selectMode, selected, warnings,
  onOpen, onToggleSent, onEdit, onStatus, onDelete, onBlast, onRenew, storeUrl, onCopyStoreLink,
  unitCost, unitAsk, loadPrice, marginStr, profit,
}: {
  lot: Lot; index: number; mediaBase: string; selectMode: boolean; selected: boolean; warnings: string[];
  onOpen: () => void; onToggleSent: (c: "whatsapp" | "email") => void;
  onEdit: () => void; onStatus: (s: string) => void; onDelete: () => void; onBlast: () => void; onRenew: () => void;
  storeUrl: string | null; onCopyStoreLink: () => void;
  unitCost: number; unitAsk: number; loadPrice: number; marginStr: string; profit: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, menuOpen, () => setMenuOpen(false));

  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  // Custom-priced lots show a free-text price verbatim (no per-unit / profit math).
  const isCustom = lot.price_type === "custom";
  const priceText = isCustom ? (() => { try { return (JSON.parse(lot.details_json || "{}") as LotDetails)?.price_text || ""; } catch { return ""; } })() : "";
  const stale = isStale(lot);
  const sold = lot.status === "sold";
  const archived = lot.status === "archived";
  const reserved = lot.status === "reserved";
  // Stagger cap 8, +20ms each — enter feedback, not decoration.
  const delay = `${Math.min(index, 8) * 20}ms`;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div onClick={onOpen} title={selectMode ? "Select" : "Open lot"}
      style={{ animationDelay: delay }}
      className={`group relative bg-surface border rounded-xl overflow-hidden transition-[box-shadow,border-color] duration-150 cursor-pointer flex flex-col inv-rise hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] ${selected ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-line-3"} ${reserved ? "border-l-2 border-l-info" : ""}`}>
      {/* Media */}
      <div className="relative w-full h-36 bg-surface-2 flex items-center justify-center overflow-hidden">
        {photos.length > 0 && !imgErr ? (
          <img src={photoSrc(photos[0], mediaBase)} alt=""
            className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03] inv-photo-zoom ${sold ? "opacity-70" : archived ? "opacity-60 grayscale-[0.3]" : ""}`}
            onError={() => setImgErr(true)} />
        ) : (
          <Package size={26} className={`text-faint ${archived ? "opacity-60" : ""}`} strokeWidth={1.5} />
        )}

        {/* Status pill — sentence case, static leading dot */}
        <span className={`absolute top-2.5 left-2.5 text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1.5 bg-surface/85 backdrop-blur-sm ${statusColor(lot.status)}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot(lot.status)}`} />
          {lot.status.charAt(0).toUpperCase() + lot.status.slice(1)}
        </span>

        {/* Needs-attention chip — missing info or unsynced media (tooltip lists them) */}
        {!archived && warnings.length > 0 && (
          <span className="absolute bottom-2.5 left-2.5 text-[10px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1.5 bg-warning-bg/95 backdrop-blur-sm text-warning-ink border border-warning/40" title={warnings.join(" · ")}>
            <span className="w-1.5 h-1.5 rounded-full bg-warning" /> {warnings.length} to fix
          </span>
        )}

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
                {storeUrl && lot.status !== "archived" && (
                  <button onClick={() => { setMenuOpen(false); onCopyStoreLink(); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2 transition-colors"><Link2 size={13} className="text-muted" /> Copy product link</button>
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

        {/* Money block — load price is the headline, per-unit muted under it,
            profit a discreet internal line (hidden when cost is unset).
            Custom-priced lots show their free text verbatim, no per-unit / profit. */}
        <div className={`mt-3 ${sold ? "opacity-90" : ""}`}>
          {isCustom ? (
            <div className={`text-[19px] font-semibold leading-snug line-clamp-2 ${sold ? "text-muted" : "text-ink"}`}>{priceText || "—"}</div>
          ) : (
            <>
              <div className={`text-[19px] font-semibold tabular-nums leading-none ${sold ? "text-muted" : "text-ink"}`}>{fmtAmount(loadPrice)}</div>
              <div className="text-[11px] text-muted tabular-nums mt-1">{fmtAmount(unitAsk)} / unit</div>
              {unitCost > 0 && (
                <div className="text-[11px] text-muted tabular-nums mt-1.5">
                  Profit {fmtAmount(profit)} · {marginStr}
                </div>
              )}
            </>
          )}
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
            <button onClick={(e) => { stop(e); onRenew(); }}
              title={`Last shared ${daysSince(lot.updated_at)} days ago — renew to reset freshness (no email sent).`}
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
              className="flex-1 flex items-center justify-center gap-1.5 text-[12px] font-medium bg-accent hover:bg-accent-hover text-on-accent h-8 rounded-lg transition-colors">
              <Mail size={13} /> Blast
            </button>
          </div>
        )}
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
  // Guard against losing a half-typed paste — confirm only when there's content.
  const requestClose = () => {
    if (text.trim() && !confirm("Discard this load? Your text will be lost.")) return;
    onClose();
  };

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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/25 backdrop-blur-[3px]">
      <div className="bg-surface rounded-2xl shadow-xl w-[480px] max-w-[92vw] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><Clipboard size={15} className="text-accent" /> Paste a load</h3>
          <button onClick={requestClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
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
          <button onClick={requestClose} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9">Cancel</button>
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

// Pick one or more categories: shows current picks as removable chips, and a type-to-add
// box that both filters existing categories and offers to create a new one.
function CategoryMultiSelect({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const add = (c: string) => {
    const v = c.trim();
    setDraft("");
    if (!v || value.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
  };
  const remove = (c: string) => onChange(value.filter((x) => x !== c));
  const matches = options.filter((o) => o && !value.some((v) => v.toLowerCase() === o.toLowerCase()) && o.toLowerCase().includes(draft.toLowerCase())).slice(0, 8);
  const canCreate = draft.trim() && !options.some((o) => o.toLowerCase() === draft.trim().toLowerCase()) && !value.some((v) => v.toLowerCase() === draft.trim().toLowerCase());
  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 min-h-9 border border-line rounded-lg px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40 transition-colors">
        {value.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 pl-2.5 pr-1 h-[26px] rounded-full bg-accent/10 text-accent text-[12px] font-medium">
            {c}<button type="button" onClick={() => remove(c)} className="w-[18px] h-[18px] flex items-center justify-center rounded-full hover:bg-accent/20"><X size={10} /></button>
          </span>
        ))}
        <input className="flex-1 min-w-[110px] h-[26px] bg-transparent text-[13px] focus:outline-none"
          value={draft} placeholder={value.length ? "Add another…" : "Type or pick categories"}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setDraft(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } if (e.key === "Backspace" && !draft && value.length) remove(value[value.length - 1]); }} />
      </div>
      {open && (canCreate || matches.length > 0) && (
        <div className="absolute left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg z-[70] max-h-56 overflow-y-auto py-1">
          {canCreate && (
            <button type="button" onMouseDown={(e) => { e.preventDefault(); add(draft); }} className="w-full text-left px-3 py-2 text-[13px] text-accent hover:bg-surface-2">Create “{draft.trim()}”</button>
          )}
          {matches.map((o) => (
            <button key={o} type="button" onMouseDown={(e) => { e.preventDefault(); add(o); }} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2">{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// Condition quick-picks + free text. Clicking a pill sets the value; typing overrides it.
function ConditionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {CONDITIONS.map((c) => (
          <button key={c} type="button" onClick={() => onChange(value === c ? "" : c)}
            className={`px-3 h-8 rounded-full text-[12px] font-medium border transition-colors ${value === c ? "bg-accent text-on-accent border-accent" : "border-line text-ink-2 hover:border-accent hover:text-accent"}`}>{c}</button>
        ))}
      </div>
      <input className={inp} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Or type a condition (e.g. A/B grade, tested working)" />
    </div>
  );
}

// Split a lot's quantity by one or more attributes (Brand, Size, Color…). Add values as
// chips; the grid of combinations gets a labeled Qty (+ optional Price) per row and the
// total auto-sums. Every box is full-width and labeled — the fix for the old collapsed UI.
function VariantSplitEditor({ options, variants, onOptions, onVariants }: {
  options: LotOption[]; variants: LotVariant[]; onOptions: (o: LotOption[]) => void; onVariants: (v: LotVariant[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const kof = (o: any) => o._key as string;
  const combos: string[][] = (() => {
    const clean = options.map((o) => o.values.map((v) => v.trim()).filter(Boolean));
    if (!clean.length || clean.some((vs) => vs.length === 0)) return [];
    return clean.reduce<string[][]>((acc, vals) => acc.flatMap((c) => vals.map((v) => [...c, v])), [[]]);
  })();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const varFor = (c: string[]) => variants.find((v) => same(v.values, c));
  const upsert = (c: string[], patch: Partial<LotVariant>) => {
    const cur = variants.find((v) => same(v.values, c)) || { values: c, qty: 0, price: null };
    onVariants([...variants.filter((v) => !same(v.values, c)), { ...cur, ...patch }]);
  };
  const total = combos.reduce((s, c) => s + (varFor(c)?.qty || 0), 0);
  const addValue = (o: any, val: string) => {
    const v = val.trim();
    if (!v || o.values.some((x: string) => x.toLowerCase() === v.toLowerCase())) return;
    onOptions(options.map((x: any) => kof(x) === kof(o) ? { ...x, values: [...x.values, v] } : x));
  };
  const removeValue = (o: any, val: string) => onOptions(options.map((x: any) => kof(x) === kof(o) ? { ...x, values: x.values.filter((y: string) => y !== val) } : x));

  return (
    <div className="space-y-3">
      {options.map((o: any) => (
        <div key={kof(o)} className="rounded-xl border border-line bg-surface-2/40 p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <label className="text-[11.5px] font-medium text-muted w-[70px] flex-shrink-0">Attribute</label>
            <input list="variant-attr-names" className={cellInp + " flex-1"} value={o.name} placeholder="Brand, Size, Color…"
              onChange={(e) => onOptions(options.map((x: any) => kof(x) === kof(o) ? { ...x, name: e.target.value } : x))} />
            <button type="button" onClick={() => onOptions(options.filter((x: any) => kof(x) !== kof(o)))} title="Remove attribute"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-danger-ink hover:bg-danger-bg transition-colors flex-shrink-0"><X size={14} /></button>
          </div>
          <div className="flex items-start gap-2">
            <label className="text-[11.5px] font-medium text-muted w-[70px] flex-shrink-0 pt-1.5">Values</label>
            <div className="flex-1 flex flex-wrap items-center gap-1.5 min-h-9 border border-line rounded-lg px-2 py-1.5 bg-surface">
              {o.values.map((v: string) => (
                <span key={v} className="inline-flex items-center gap-1 pl-2.5 pr-1 h-[26px] rounded-full bg-accent/10 text-accent text-[12px] font-medium">
                  {v}<button type="button" onClick={() => removeValue(o, v)} className="w-[18px] h-[18px] flex items-center justify-center rounded-full hover:bg-accent/20"><X size={10} /></button>
                </span>
              ))}
              <input className="flex-1 min-w-[120px] h-[26px] bg-transparent text-[13px] focus:outline-none"
                value={draft[kof(o)] ?? ""} placeholder={o.values.length ? "Add another…" : "Type a value, press Enter"}
                onChange={(e) => setDraft((d) => ({ ...d, [kof(o)]: e.target.value }))}
                onBlur={() => { if ((draft[kof(o)] ?? "").trim()) { addValue(o, draft[kof(o)]); setDraft((d) => ({ ...d, [kof(o)]: "" })); } }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addValue(o, draft[kof(o)] ?? ""); setDraft((d) => ({ ...d, [kof(o)]: "" })); }
                  if (e.key === "Backspace" && !(draft[kof(o)] ?? "") && o.values.length) removeValue(o, o.values[o.values.length - 1]);
                }} />
            </div>
          </div>
        </div>
      ))}
      {options.length < 3 && (
        <button type="button" onClick={() => onOptions([...options, { name: "", values: [], _key: crypto.randomUUID() } as any])}
          className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-dashed border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors">
          <Plus size={13} /> {options.length ? "Add another attribute (nest, e.g. Brand × Size)" : "Split by an attribute"}
        </button>
      )}
      <datalist id="variant-attr-names"><option value="Brand" /><option value="Size" /><option value="Color" /><option value="Style" /><option value="Model" /><option value="Condition" /></datalist>

      {combos.length > 0 && (
        <div className="border border-line rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 bg-surface-2 text-[11px] font-semibold text-muted">
            <span className="flex-1 min-w-0 truncate">{options.map((o: any) => o.name || "Attribute").join(" / ")}</span>
            <span className="w-24 text-right">Qty</span>
            <span className="w-32 text-right">Price (optional)</span>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-line-2">
            {combos.map((c, ci) => {
              const v = varFor(c);
              return (
                <div key={ci} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 min-w-0 text-[13px] text-ink truncate">{c.join(" / ")}</span>
                  <input className={cellInp + " w-24 text-right tabular-nums"} type="number" inputMode="numeric" value={v?.qty || ""} placeholder="0"
                    onChange={(e) => upsert(c, { qty: parseInt(e.target.value) || 0 })} />
                  <div className="relative w-32">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                    <input className={cellInp + " w-32 pl-6 text-right tabular-nums"} type="number" step="0.01" value={v?.price ?? ""} placeholder="—"
                      onChange={(e) => upsert(c, { price: e.target.value === "" ? null : (parseFloat(e.target.value) || 0) })} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between px-3 py-2 bg-surface-2/60 text-[12px]">
            <span className="text-muted">{combos.length} variant{combos.length !== 1 ? "s" : ""} · blank price uses the lot's asking price</span>
            <span className="font-semibold text-ink tabular-nums">Total: {total.toLocaleString()} units</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LotForm({ initial, prefill, onClose, suppliers, categories, mediaBase, lots }: { initial?: Lot | null; prefill?: Partial<Lot> | null; onClose: () => void; deals: Deal[]; suppliers: string[]; categories: string[]; mediaBase: string; lots: Lot[] }) {
  const [name, setName] = useState(initial?.name ?? prefill?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? prefill?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? prefill?.category ?? "");
  const [qty, setQty] = useState(initial?.quantity ?? prefill?.quantity ?? 1);
  const [cost, setCost] = useState(initial?.total_cost ?? prefill?.total_cost ?? 0);
  const [ask, setAsk] = useState(initial?.asking_price ?? prefill?.asking_price ?? 0);
  const [priceType, setPriceType] = useState(initial?.price_type ?? prefill?.price_type ?? "per_unit");
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
  // Multi-category: seed from details.categories, else the single legacy category column.
  const [cats, setCats] = useState<string[]>(() => {
    const list = details0.categories && details0.categories.length ? details0.categories : (category ? [category] : []);
    return Array.from(new Set(list.map((c) => c.trim()).filter(Boolean)));
  });
  const [condition, setCondition] = useState<string>(details0.condition ?? (prefill as any)?.condition ?? "");
  const [pallets, setPallets] = useState<number>(details0.pallets ?? 0);
  const [msrp, setMsrp] = useState<number>(details0.msrp ?? 0);
  const [moq, setMoq] = useState<number>(details0.moq ?? 0);
  // Legacy size_run is preserved on old lots (read-only now — the variant splitter below
  // supersedes it), so editing a pre-existing lot never drops its sizes.
  const [sizeRun] = useState<any[]>(() => (details0.size_run ?? []).map((r: any) => ({ ...r, _key: r._key || crypto.randomUUID() })));
  // Shopify-style variants: attribute types (Brand/Size/Color) + a row per combination.
  const [options, setOptions] = useState<LotOption[]>(() => (details0.options ?? []).map((o: any) => ({ ...o, _key: o._key || crypto.randomUUID() })));
  const [variants, setVariants] = useState<LotVariant[]>(details0.variants ?? []);
  // Every combination of option values (the cartesian product) — the variant grid.
  // Variants are stored sparsely (only rows the seller filled in); the grid looks
  // each combo up by its values, so adding/removing options never orphans data.
  const variantCombos: string[][] = (() => {
    const clean = options.map((o) => o.values.map((v) => v.trim()).filter(Boolean));
    if (!clean.length || clean.some((vs) => vs.length === 0)) return [];
    return clean.reduce<string[][]>((acc, vals) => acc.flatMap((combo) => vals.map((v) => [...combo, v])), [[]]);
  })();
  const sameVals = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const variantFor = (combo: string[]) => variants.find((v) => sameVals(v.values, combo));
  // When the lot is split into variants, its total quantity IS the sum of the splits.
  const variantTotal = variantCombos.reduce((s, c) => s + (variantFor(c)?.qty || 0), 0);
  // Third price mode: a free-text price shown verbatim (no per-unit math).
  const [priceText, setPriceText] = useState<string>(details0.price_text ?? "");
  const [openToOffers, setOpenToOffers] = useState<boolean>(details0.open_to_offers ?? false);
  const [dragActive, setDragActive] = useState(false); // dropzone highlight while dragging files

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

  // Import photos (drag-dropped or dialog-picked). For an existing lot, copy into
  // the synced media folder now; for a new lot, stage raw paths until it's created.
  const importPhotos = async (picked: string[]) => {
    if (picked.length === 0) return;
    try {
      if (initial) {
        const rel = await api.importLotPhotos(initial.id, picked);
        setPhotos((prev) => [...prev, ...rel]);
      } else {
        setPhotos((prev) => [...prev, ...picked]);
      }
    } catch (e: any) { toast(String(e), "error"); }
  };
  const openPicker = async () => {
    const f = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    const picked = Array.isArray(f) ? f : (typeof f === "string" ? [f] : []);
    importPhotos(picked);
  };

  // Native file drag-drop onto the form (Tauri webview). Registered while the form
  // is open; the highlight tracks enter/over, drop imports the image files.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragActive(true);
      else if (p.type === "leave") setDragActive(false);
      else if (p.type === "drop") {
        setDragActive(false);
        const imgs = p.paths.filter((path) => /\.(jpe?g|png|webp|gif)$/i.test(path));
        if (imgs.length) importPhotos(imgs);
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  // Confirm before discarding an edited form — a stray backdrop click can't close it.
  const initialSnapshot = useRef({
    name, desc, category, qty, cost, ask, priceType, priceText, openToOffers,
    supplier, location, notes, sentWa, sentEmail,
    photos: photos.length, pallets, msrp, moq, sizeRun: JSON.stringify(sizeRun),
    variants: JSON.stringify({ options, variants }),
    cats: JSON.stringify(cats), condition,
  }).current;
  const isDirty = () =>
    name !== initialSnapshot.name || desc !== initialSnapshot.desc || category !== initialSnapshot.category ||
    qty !== initialSnapshot.qty || cost !== initialSnapshot.cost || ask !== initialSnapshot.ask ||
    priceType !== initialSnapshot.priceType || priceText !== initialSnapshot.priceText || openToOffers !== initialSnapshot.openToOffers ||
    supplier !== initialSnapshot.supplier || location !== initialSnapshot.location || notes !== initialSnapshot.notes ||
    sentWa !== initialSnapshot.sentWa || sentEmail !== initialSnapshot.sentEmail ||
    photos.length !== initialSnapshot.photos || pallets !== initialSnapshot.pallets || msrp !== initialSnapshot.msrp ||
    moq !== initialSnapshot.moq || JSON.stringify(sizeRun) !== initialSnapshot.sizeRun || !!newManifestFile ||
    JSON.stringify({ options, variants }) !== initialSnapshot.variants ||
    JSON.stringify(cats) !== initialSnapshot.cats || condition !== initialSnapshot.condition;
  const requestClose = () => {
    if (isDirty() && !confirm("Discard this lot? Your changes will be lost.")) return;
    onClose();
  };

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Build the public/internal extras blob. Undefined when everything's empty
      // so we don't persist an empty object.
      const cleanRun = sizeRun.filter((r) => r.size.trim());
      // Carry avg_msrp through (it's parser-derived, not an editable field) so an
      // edit-save doesn't silently drop it from the blast.
      const avgMsrp = details0.avg_msrp ?? null;
      // Custom price: persist the free text in details_json; the numeric ask is 0/ignored.
      const isCustom = priceType === "custom";
      const priceTextClean = isCustom ? priceText.trim() : "";
      const effAsk = isCustom ? 0 : ask;
      // Variants: keep only fully-named option types with values, and only variant
      // rows the seller actually stocks (a qty or a price).
      const cleanOptions = options
        .map((o) => ({ name: o.name.trim(), values: o.values.map((v) => v.trim()).filter(Boolean) }))
        .filter((o) => o.name && o.values.length > 0);
      const cleanVariants: LotVariant[] = cleanOptions.length > 0
        ? variants.filter((v) => v.qty > 0 || (v.price != null && v.price > 0))
                  .map((v) => ({ values: v.values, qty: v.qty || 0, price: v.price != null && v.price > 0 ? v.price : null }))
        : [];
      const hasVariants = cleanOptions.length > 0 && cleanVariants.length > 0;
      // When the lot is split into variants, the total quantity IS the sum of the splits
      // (Jack: "do variants then quantity"). Otherwise the plain Quantity box wins.
      const variantQtyTotal = cleanVariants.reduce((s, v) => s + (v.qty || 0), 0);
      const effQty = hasVariants ? variantQtyTotal : qty;
      const cleanCats = Array.from(new Set(cats.map((c) => c.trim()).filter(Boolean)));
      const primaryCat = cleanCats[0] || category.trim() || "";
      const conditionClean = condition.trim();
      const detailsObj: LotDetails = { pallets: pallets || null, msrp: msrp || null, avg_msrp: avgMsrp, moq: moq || null, size_run: cleanRun };
      if (priceTextClean) detailsObj.price_text = priceTextClean;
      if (openToOffers) detailsObj.open_to_offers = true;
      if (hasVariants) { detailsObj.options = cleanOptions; detailsObj.variants = cleanVariants; }
      if (cleanCats.length) detailsObj.categories = cleanCats;
      if (conditionClean) detailsObj.condition = conditionClean;
      // Preserve a manifest summary seeded from the analyzer (or a prior save) — the save
      // rebuilds detailsObj from fields, so it would otherwise be dropped.
      if (details0.manifest) detailsObj.manifest = details0.manifest;
      const hasDetails = !!pallets || !!msrp || !!moq || avgMsrp != null || cleanRun.length > 0 || !!priceTextClean || hasVariants || openToOffers || !!details0.manifest || cleanCats.length > 0 || !!conditionClean;
      const detailsJson = hasDetails ? JSON.stringify(detailsObj) : undefined;
      const locClean = normalizeLocation(location);
      if (initial) {
        await api.updateLot(initial.id, { name: name.trim(), description: desc || null, category: primaryCat || null, quantity: effQty, totalCost: cost, askingPrice: effAsk, photos, notes: notes.trim() || null, sentWhatsapp: sentWa, sentEmail: sentEmail, supplier: supplier.trim() || null, location: locClean || null, priceType, detailsJson });
      } else {
        // Duplicate guard: warn (don't block) if a still-listed lot already has this
        // name — a legitimate re-buy of the same product can recur.
        const dupe = lots.find((l) => (l.name || "").trim().toLowerCase() === name.trim().toLowerCase() && l.status !== "archived");
        if (dupe && !confirm(`A lot named "${dupe.name}" already exists (${dupe.status}). Add another anyway?`)) { setSaving(false); return; }
        const lot = await api.createLot({ name: name.trim(), quantity: effQty, totalCost: cost, askingPrice: effAsk, description: desc || undefined, category: primaryCat || undefined, notes: notes.trim() || undefined, supplier: supplier.trim() || undefined, location: locClean || undefined, priceType, detailsJson });
        // Photos were picked as raw paths; copy them into the lot's synced media folder now that it has an id.
        if (photos.length > 0) {
          const rel = await api.importLotPhotos(lot.id, photos);
          await api.updateLot(lot.id, { photos: rel });
        }
        if (newManifestFile) await api.attachLotManifest(lot.id, newManifestFile);
        if (sentWa || sentEmail) await api.updateLot(lot.id, { sentWhatsapp: sentWa, sentEmail: sentEmail });
      }
      // Persist every typed-in category so each is a reusable pick next time (idempotent —
      // create_category dedupes case-insensitively).
      cleanCats.forEach((c) => api.createCategory({ label: c }).catch(() => {}));
      onClose();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <>
    <div className="fixed inset-0 z-50 bg-surface flex flex-col inv-form-in">
      <div className="w-full h-full flex flex-col">
        <div className="border-b border-line flex-shrink-0">
          <div className="max-w-[860px] mx-auto w-full flex justify-between items-center gap-3 px-6 py-3.5">
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-ink">{initial ? "Edit lot" : "New lot"}</h3>
              <p className="text-[11.5px] text-muted mt-0.5">{initial ? "Update this inventory lot." : "Add a lot to your inventory — only a name is required."}</p>
            </div>
            <button onClick={requestClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"><X size={16} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[860px] mx-auto px-6 py-6 space-y-6">

          <div className="space-y-3">
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Name</label>
              <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nike overstock — mixed sneakers" autoFocus />
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Categories</label>
              <CategoryMultiSelect value={cats} onChange={setCats} options={categories} />
              <p className="text-[10.5px] text-muted mt-1">Pick one or more — type to add a new category. The first is used for buyer segments.</p>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Description</label>
              <input className={inp} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="A short summary buyers will see" />
            </div>
          </div>

          <div className="pt-5 border-t border-line-2 space-y-3">
            <div className="text-[12px] font-semibold text-ink">Condition &amp; location</div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Condition <span className="font-normal text-muted">— optional</span></label>
              <ConditionField value={condition} onChange={setCondition} />
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Location</label>
              <input className={inp} value={location} list="lot-location-options"
                onChange={(e) => setLocation(e.target.value)}
                onBlur={(e) => setLocation(normalizeLocation(e.target.value))}
                placeholder="City, state (auto-formats) — or a warehouse name" />
              <datalist id="lot-location-options">
                {Array.from(new Set(lots.map((l) => (l.location || "").trim()).filter(Boolean))).slice(0, 30).map((l) => <option key={l} value={l} />)}
              </datalist>
              <p className="text-[10.5px] text-muted mt-1">Type a city/state (e.g. “los angeles ca”) and it becomes “Los Angeles, CA” for consistency.</p>
            </div>
          </div>

          <div className="pt-5 border-t border-line-2 space-y-3">
            <div className="text-[12px] font-semibold text-ink">Quantity &amp; variants</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Total quantity (units)</label>
                {variantTotal > 0 ? (
                  <div className={inp + " tabular-nums bg-surface-2 text-ink flex items-center justify-between"}>
                    <span>{variantTotal.toLocaleString()}</span>
                    <span className="text-[10.5px] text-muted font-normal">auto from variants</span>
                  </div>
                ) : (
                  <input className={inp + " tabular-nums"} type="number" inputMode="numeric" value={qty || ""} onChange={(e) => setQty(parseInt(e.target.value) || 0)} placeholder="0" />
                )}
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Pallets</label>
                <input className={inp + " tabular-nums"} type="number" inputMode="numeric" value={pallets || ""} onChange={(e) => setPallets(parseInt(e.target.value) || 0)} placeholder="0" />
              </div>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Split into variants <span className="font-normal text-muted">— optional (e.g. 2 brands in one deal)</span></label>
              <VariantSplitEditor options={options} variants={variants} onOptions={setOptions} onVariants={setVariants} />
            </div>
          </div>

          <div className="pt-5 border-t border-line-2 space-y-3">
            <div className="text-[12px] font-semibold text-ink">Pricing</div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">MSRP (total retail)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input className={inp + " pl-6 tabular-nums"} type="number" step="0.01" value={msrp || ""} onChange={(e) => setMsrp(parseFloat(e.target.value) || 0)} placeholder="0.00" />
              </div>
            </div>
            <div>
            <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Selling price</label>
            <div className="flex gap-1 bg-surface-3 rounded-lg p-0.5 mb-2">
              {(["per_unit", "total", "custom"] as const).map(pt => (
                <button key={pt} onClick={() => setPriceType(pt)}
                  className={`flex-1 text-[12px] font-medium h-8 rounded-md transition-colors ${priceType === pt ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                  {pt === "per_unit" ? "Per unit" : pt === "total" ? "Fixed total" : "Custom text"}
                </button>
              ))}
            </div>
            {priceType === "custom" ? (
              <input className={inp} value={priceText} maxLength={80} onChange={(e) => setPriceText(e.target.value)}
                placeholder="e.g. 10,000+ units at $10/unit, or Best offer" />
            ) : (
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input className={inp + " pl-6"} type="number" step="0.01" value={ask || ""} onChange={(e) => setAsk(parseFloat(e.target.value) || 0)} placeholder="0.00" />
              </div>
            )}
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer mt-1 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
              <input type="checkbox" className="accent-accent mt-0.5 flex-shrink-0" checked={openToOffers} onChange={(e) => setOpenToOffers(e.target.checked)} />
              <span className="min-w-0">
                <span className="text-[12.5px] font-medium text-ink">Open to offers</span>
                <span className="block text-[11px] text-muted mt-0.5">Shows a “Make an offer” form on your storefront so buyers can send you a price.</span>
              </span>
            </label>
          </div>

          <div className="pt-5 border-t border-line-2 space-y-3">
            <div className="text-[12px] font-semibold text-ink">Photos &amp; files</div>
          <div>
            <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Photos</label>
            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {photos.map((p, i) => (
                  <div key={i} className="relative group" draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData("text/plain")); const to = i; if (from !== to) { const copy = [...photos]; const [moved] = copy.splice(from, 1); copy.splice(to, 0, moved); setPhotos(copy); } }}>
                    <img src={photoSrc(p, mediaBase)} alt="" className="w-[72px] h-[72px] object-cover rounded-lg border border-line cursor-pointer hover:border-accent transition-colors" onClick={() => setLightbox({ photos, index: i })} onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect fill='%23f3f4f6' width='72' height='72'/%3E%3Ctext x='36' y='36' text-anchor='middle' dy='.3em' fill='%239ca3af' font-size='10'%3E?%3C/text%3E%3C/svg%3E"; }} />
                     <button onClick={async () => {
                       if (initial) {
                         try { await api.removeLotPhoto(initial.id, p); } catch (e: any) { toast(String(e), "error"); }
                       }
                       setPhotos(photos.filter((_, idx) => idx !== i));
                     }} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-danger text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
            {/* Dropzone — click to pick, or drag image files onto the form */}
            <button type="button" onClick={openPicker}
              className={`w-full border-2 border-dashed rounded-lg px-3 py-4 flex flex-col items-center justify-center gap-1.5 text-[12px] transition-colors ${dragActive ? "border-accent bg-accent/10 text-accent" : "border-line-3 text-muted hover:border-accent hover:text-accent hover:bg-accent/5"}`}>
              <Upload size={16} />
              <span>Drag photos here or choose files</span>
            </button>
            <p className="text-[9px] text-muted flex items-center gap-1 mt-1.5">
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

          <div className="pt-5 border-t border-line-2 space-y-3">
            <div className="text-[12px] font-semibold text-ink">Notes &amp; status</div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Notes</label>
              <input className={inp} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Authentic, sealed, minor box damage" />
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
              <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
                <input type="checkbox" className="accent-accent" checked={sentWa} onChange={(e) => setSentWa(e.target.checked)} />
                <MessageCircle size={13} className="text-success-ink" /> Sent on WhatsApp
              </label>
              <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
                <input type="checkbox" className="accent-accent" checked={sentEmail} onChange={(e) => setSentEmail(e.target.checked)} />
                <Mail size={13} className="text-info-ink" /> Emailed
              </label>
            </div>
          </div>

          {/* Internal — never shown to buyers. Supplier, your cost, and MOQ stay private. */}
          <div className="bg-surface-2 border border-line rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
              <Lock size={13} className="text-muted" /> Internal — never shown to buyers
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Supplier</label>
              <div className="relative" id="lot-supplier-dropdown">
                <input className={inp} value={supplier} onChange={(e) => setSupplier(e.target.value)} onFocus={(e) => { const dd = document.querySelector("#lot-supplier-opt") as HTMLElement; if (dd) dd.style.display = "block"; }} onBlur={() => setTimeout(() => { const dd = document.querySelector("#lot-supplier-opt") as HTMLElement; if (dd) dd.style.display = "none"; }, 150)}
                  placeholder="Type or pick a supplier" autoComplete="off" />
                <div id="lot-supplier-opt" className="absolute left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg z-[60] max-h-[200px] overflow-y-auto hidden">
                  {suppliers.filter(s => s.toLowerCase().includes(supplier.toLowerCase())).slice(0, 20).map(s => (
                    <button key={s} type="button" className="w-full text-left px-3 py-2 text-[13px] hover:bg-surface-2 text-ink" onMouseDown={(e) => { e.preventDefault(); setSupplier(s); }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
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
        </div>
        <div className="border-t border-line flex-shrink-0">
          <div className="max-w-[860px] mx-auto w-full flex justify-end gap-2 px-6 py-3.5">
            <button onClick={requestClose} className="px-4 h-9 text-[13px] text-ink-2 border border-line rounded-lg hover:bg-surface-2 transition-colors">Cancel</button>
            <button onClick={submit} disabled={saving || !name.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
              {saving ? "Saving…" : initial ? "Save changes" : "Create lot"}
            </button>
          </div>
        </div>
      </div>
    </div>
    {lightbox && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setLightbox(null)}>
        <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
        <button onClick={() => setLightbox((prev) => prev && prev.index > 0 ? { ...prev, index: prev.index - 1 } : prev)} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white disabled:opacity-30 p-2" disabled={lightbox.index === 0}><ChevronLeft size={32} /></button>
        <button onClick={() => setLightbox((prev) => prev && prev.index < prev.photos.length - 1 ? { ...prev, index: prev.index + 1 } : prev)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white disabled:opacity-30 p-2" disabled={lightbox.index === lightbox.photos.length - 1}><ChevronRight size={32} /></button>
        <img src={photoSrc(lightbox.photos[lightbox.index], mediaBase)} alt="" className="max-w-[90vw] max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
        <div className="absolute bottom-4 text-white/60 text-[13px]">{lightbox.index + 1} / {lightbox.photos.length}</div>
      </div>
    )}
    </>
  );
}

// Compose + post a lot to the connected Facebook Page. Meta blocks app-posting to
// groups, so this targets a Page. The caption is prefilled from the lot's numbers.
function FbPostModal({ lot, photos, onClose }: { lot: Lot; photos: string[]; onClose: () => void }) {
  const [status, setStatus] = useState<FbStatus | null | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api.fbStatus().then(setStatus).catch(() => setStatus(null));
    const qty = lot.quantity || 0;
    const isTotal = lot.price_type === "total";
    const isCustom = lot.price_type === "custom";
    const priceText = isCustom ? (() => { try { return (JSON.parse(lot.details_json || "{}") as LotDetails)?.price_text || ""; } catch { return ""; } })() : "";
    const perUnit = isTotal && qty > 0 ? lot.asking_price / qty : lot.asking_price;
    const total = lot.price_type === "per_unit" ? lot.asking_price * qty : lot.asking_price;
    const bits: string[] = [];
    if (qty) bits.push(`${qty.toLocaleString()} units`);
    if (isCustom && priceText) bits.push(priceText);
    else if (lot.asking_price > 0) { bits.push(`${fmtAmount(perUnit)}/unit`); bits.push(`${fmtAmount(total)} total`); }
    if (lot.category) bits.push(lot.category);
    const lines = [lot.name || "New lot"];
    if (bits.length) lines.push(bits.join(" · "));
    if (lot.description) { lines.push(""); lines.push(lot.description); }
    setMessage(lines.join("\n"));
  }, [lot]);

  const post = async () => {
    setBusy(true);
    try { setDone(await api.fbPostLot(message, photos)); toast("Posted to Facebook"); }
    catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-[3px] p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[440px] max-w-full bg-surface border border-line rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.18)] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2"><Facebook size={15} className="text-accent" /> Post to Facebook</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={16} /></button>
        </div>
        <div className="p-5">
          {status === undefined ? (
            <p className="text-[13px] text-muted">Checking your Facebook connection…</p>
          ) : !status || !status.connected ? (
            <div className="text-[13px] text-ink-2 space-y-2">
              <p>No Facebook Page is connected yet.</p>
              <p className="text-muted">Open <span className="font-medium text-ink-2">Settings → Facebook</span> to connect a Page you manage, then post from here. Facebook doesn’t allow apps to post into groups, so this posts to a Page.</p>
            </div>
          ) : done ? (
            <div className="text-[13px] text-ink-2 space-y-3">
              <p>Posted to <span className="font-medium text-ink">{status.page_name}</span>.</p>
              <div className="flex gap-2">
                <button onClick={() => api.openExternal(`https://www.facebook.com/${done}`).catch(() => {})} className="flex items-center gap-1.5 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><ExternalLink size={13} /> View post</button>
                <button onClick={onClose} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[12px] font-medium">Done</button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={7}
                className="w-full text-[13px] bg-surface-2 border border-line rounded-lg px-3 py-2.5 text-ink resize-y focus:outline-none focus:border-accent" placeholder="Write a caption…" />
              <p className="text-[11.5px] text-muted">
                {photos.length > 0 ? `${photos.length} photo${photos.length !== 1 ? "s" : ""} attached · ` : "No photos · "}
                posting to <span className="font-medium text-ink-2">{status.page_name}</span>
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Cancel</button>
                <button onClick={post} disabled={busy || !message.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
                  {busy ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />} {busy ? "Posting…" : "Post to Page"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LotDetail({ lot, deals, mediaBase, warnings, offers, onOffersChanged, onClose, onEdit, onStatus, onToggleSent, onLink, onDelete, onChanged, storeUrl, onCopyStoreLink, onOpenStoreLink }: {
  lot: Lot; deals: Deal[]; mediaBase: string; warnings: string[]; offers: Offer[]; onOffersChanged: () => void; onClose: () => void; onEdit: () => void;
  onStatus: (s: string) => void; onToggleSent: (c: "whatsapp" | "email") => void; onLink: () => void; onDelete: () => void; onChanged: () => void;
  storeUrl: string | null; onCopyStoreLink: () => void; onOpenStoreLink: () => void;
}) {
  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  const [big, setBig] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [mBusy, setMBusy] = useState(false);
  const [fbOpen, setFbOpen] = useState(false);
  // If the photo set shrinks (sync/edit elsewhere) while the detail is open, keep
  // the selected index in range so photos[big] never becomes undefined.
  useEffect(() => { if (big > photos.length - 1) setBig(0); }, [photos.length, big]);

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
  // Custom-priced lots show a free-text price verbatim (no per-unit / profit math).
  const isCustom = lot.price_type === "custom";
  const det: LotDetails = (() => { try { return (JSON.parse(lot.details_json || "{}") as LotDetails) ?? {}; } catch { return {} as LotDetails; } })();
  const priceText = isCustom ? (det.price_text || "") : "";
  // All categories (multi) + condition + variant breakdown for display.
  const allCats = Array.from(new Set([...(det.categories ?? []), ...(lot.category ? [lot.category] : [])].map((c) => c.trim()).filter(Boolean)));
  const condition = (det.condition || "").trim();
  const variantRows = (det.variants ?? []).filter((v) => v && (v.qty > 0 || (v.price != null && v.price > 0)));
  // Resolve the linked deal (if any) so the link is visible, not just stored.
  const linkedDeal = lot.linked_deal_id ? deals.find((d) => d.id === lot.linked_deal_id) : null;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div>
      <p className="text-[12.5px] font-medium text-muted mb-0.5">{label}</p>
      <p className="text-[13px] text-ink break-words">{value}</p>
    </div>
  );

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/30 backdrop-blur-[3px] overflow-y-auto" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-[720px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-line">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex items-center gap-1.5 ${statusColor(lot.status)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusDot(lot.status)}`} />
                {lot.status.charAt(0).toUpperCase() + lot.status.slice(1)}
              </span>
              {allCats.map((c) => <span key={c} className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">{c}</span>)}
              {condition && <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-3 text-ink-2 font-semibold border border-line">{condition}</span>}
            </div>
            <h3 className="text-[17px] font-semibold text-ink leading-tight">{lot.name}</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 flex-shrink-0"><X size={18} /></button>
        </div>

        {/* Needs-attention checklist — what to fix before this lot is buyer-ready */}
        {warnings.length > 0 && lot.status !== "archived" && (
          <div className="px-5 py-3 bg-warning-bg/60 border-b border-warning/30">
            <p className="text-[12px] font-semibold text-warning-ink mb-1.5">Needs attention</p>
            <div className="flex flex-wrap gap-1.5">
              {warnings.map((w) => (
                <span key={w} className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2 bg-surface border border-warning/30 rounded-full px-2.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-warning" /> {w}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Linked deal — surfaces the otherwise-invisible link, with the deal's stage. */}
        {linkedDeal && (
          <div className="flex items-center gap-2 px-5 py-2.5 bg-surface-2 border-b border-line">
            <Link2 size={13} className="text-muted flex-shrink-0" />
            <span className="text-[12px] text-muted flex-shrink-0">Linked to</span>
            <span className="text-[12.5px] font-medium text-ink truncate">{linkedDeal.title}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${dealStageColor(linkedDeal.stage)}`}>{dealStageLabel(linkedDeal.stage)}</span>
          </div>
        )}

        <div className="p-5 space-y-5">
          {/* Photos */}
          {photos.length > 0 ? (
            <div>
              <div className="w-full h-64 bg-surface-2 rounded-xl overflow-hidden flex items-center justify-center cursor-zoom-in" onClick={() => setZoom(true)}>
                <img src={photoSrc(photos[big], mediaBase)} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.2"; }} />
              </div>
              {photos.length > 1 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {photos.map((p, i) => (
                    <img key={i} src={photoSrc(p, mediaBase)} alt="" onClick={() => setBig(i)}
                      onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.2"; }}
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

          {/* Financials — load price is the headline, per-unit under it.
              Custom-priced lots show the free text verbatim (no per-unit / profit). */}
          <div className="bg-surface-2 rounded-xl px-4 py-3.5">
            {isCustom ? (
              <>
                <p className="text-[12px] font-medium text-muted">Price</p>
                <p className="text-[20px] font-semibold text-ink leading-snug mt-1 break-words">{priceText || "—"}</p>
                {/* Cost may still show internally; no profit/margin without a numeric ask. */}
                {uCost > 0 && (
                  <div className="mt-3 pt-3 border-t border-line text-[12px] text-muted tabular-nums">
                    Your cost {fmtAmount(totalCostAll)}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-[12px] font-medium text-muted">Load price</p>
                <p className="text-[26px] font-semibold text-ink tabular-nums leading-none mt-1">{fmtAmount(totalAskAll)}</p>
                <p className="text-[12.5px] text-muted tabular-nums mt-1.5">{fmtAmount(uAsk)} / unit · {lot.quantity.toLocaleString()} units</p>
                {/* Internal margin — discreet, our-eyes-only. Hidden if cost is unset. */}
                {uCost > 0 && (
                  <div className="mt-3 pt-3 border-t border-line flex items-center justify-between text-[12px] text-muted tabular-nums">
                    <span>Your cost {fmtAmount(totalCostAll)} · {fmtAmount(uCost)} / unit</span>
                    <span>Profit {fmtAmount(profit)} · {marginStr}</span>
                  </div>
                )}
              </>
            )}
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
              <p className="text-[12.5px] font-medium text-muted mb-0.5">Description</p>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap">{lot.description}</p>
            </div>
          )}

          {/* Variant breakdown — how the units split (brands/sizes/…) */}
          {variantRows.length > 0 && (
            <div>
              <p className="text-[12.5px] font-medium text-muted mb-1.5">Breakdown</p>
              <div className="border border-line rounded-lg overflow-hidden divide-y divide-line-2">
                {variantRows.map((v, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 min-w-0 text-[13px] text-ink truncate">{(v.values || []).join(" / ")}</span>
                    <span className="text-[13px] text-ink-2 tabular-nums">{(v.qty || 0).toLocaleString()} units</span>
                    {v.price != null && v.price > 0 && <span className="text-[13px] font-medium text-ink tabular-nums w-20 text-right">{fmtAmount(v.price)}</span>}
                  </div>
                ))}
              </div>
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

          {/* Offers — buyer submissions from the public storefront listing */}
          <div>
            <p className="text-[12.5px] font-medium text-muted mb-1.5">Offers{offers.length > 0 ? ` · ${offers.length}` : ""}</p>
            {offers.length === 0 ? (
              <p className="text-[12px] text-muted">No offers yet. Buyers can send one from your storefront listing.</p>
            ) : (
              <div className="space-y-2">
                {offers.map((o) => (
                  <div key={o.id} className={`rounded-lg border px-3 py-2.5 ${o.status === "accepted" ? "border-success/40 bg-success-bg/40" : o.status === "declined" ? "border-line bg-surface-2/40 opacity-70" : "border-line bg-surface-2"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap text-[13px]">
                          <span className="font-medium text-ink truncate">{o.name || "Anonymous"}</span>
                          {o.amount != null && <span className="font-semibold text-accent tabular-nums">{fmtAmount(o.amount)}<span className="text-[10px] font-normal text-muted ml-0.5">{o.offer_type === "per_unit" ? "/unit" : " for the lot"}</span></span>}
                          {o.status === "accepted" && <span className="text-[10px] font-bold uppercase tracking-wide text-success-ink">Accepted</span>}
                          {o.status === "declined" && <span className="text-[10px] font-bold uppercase tracking-wide text-muted">Declined</span>}
                        </div>
                        <a href={`mailto:${o.email}`} className="text-[11.5px] text-muted hover:text-accent break-all">{o.email}</a>
                        {o.message && <p className="text-[12px] text-ink-2 whitespace-pre-wrap mt-1">{o.message}</p>}
                        <div className="text-[10.5px] text-faint mt-1">{new Date(o.created_at).toLocaleString()}</div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {o.status !== "accepted" && <button onClick={() => api.setOfferStatus(o.id, "accepted").then(onOffersChanged).catch((e) => toast(String(e), "error"))} title="Mark accepted" className="w-7 h-7 flex items-center justify-center rounded-md text-success-ink hover:bg-success-bg transition-colors"><Check size={14} /></button>}
                        {o.status !== "declined" && <button onClick={() => api.setOfferStatus(o.id, "declined").then(onOffersChanged).catch((e) => toast(String(e), "error"))} title="Decline" className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-danger-ink hover:bg-danger-bg transition-colors"><Ban size={13} /></button>}
                        <button onClick={() => { if (confirm("Delete this offer?")) api.deleteOffer(o.id).then(onOffersChanged).catch((e) => toast(String(e), "error")); }} title="Delete" className="w-7 h-7 flex items-center justify-center rounded-md text-faint hover:text-danger-ink hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 text-[11px] text-muted">
            <span>Added {lot.created_at.slice(0, 10)}</span>
            <span>Updated {lot.updated_at.slice(0, 10)}</span>
          </div>
        </div>

        {/* Actions — grouped by concern (each cluster wraps as a unit) so the row
            reads as edit · storefront · link · status · delete, not a flat wall. */}
        <div className="flex items-center gap-2 flex-wrap p-5 border-t border-line">
          <button onClick={onEdit} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Edit</button>
          {storeUrl && lot.status !== "archived" && (
            <div className="flex items-center gap-2">
              <button onClick={onOpenStoreLink} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><ExternalLink size={13} /> Open listing</button>
              <button onClick={onCopyStoreLink} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><Link2 size={13} /> Copy product link</button>
            </div>
          )}
          {lot.status !== "archived" && (
            <button onClick={() => window.dispatchEvent(new CustomEvent("share-whatsapp", { detail: [lot.id] }))} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><MessageCircle size={13} /> Send to WhatsApp</button>
          )}
          {lot.status !== "archived" && (
            <button onClick={() => setFbOpen(true)} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><Facebook size={13} /> Post to Facebook</button>
          )}
          {lot.status !== "sold" && lot.status !== "archived" && (
            <button onClick={onLink} className="flex items-center gap-1 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><Link2 size={13} /> Link to deal</button>
          )}
          <div className="flex items-center gap-2">
            {lot.status !== "sold" && (
              <button onClick={() => onStatus("sold")} className="flex items-center gap-1 border border-success text-success-ink px-3 h-9 rounded-lg text-[12px] hover:bg-success-bg"><DollarSign size={13} /> Mark sold</button>
            )}
            {lot.status !== "archived" && (
              <button onClick={() => onStatus("archived")} className="flex items-center gap-1 border border-danger text-danger-ink px-3 h-9 rounded-lg text-[12px] hover:bg-danger-bg"><Ban size={13} /> Mark unavailable</button>
            )}
            {(lot.status === "sold" || lot.status === "archived") && (
              <button onClick={() => onStatus("available")} className="border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2">Restore</button>
            )}
          </div>
          <button onClick={onDelete} className="flex items-center gap-1 border border-danger text-danger-ink px-3 h-9 rounded-lg text-[12px] hover:bg-danger-bg ml-auto"><Trash2 size={13} /> Delete</button>
        </div>
      </div>
    </div>
    {zoom && photos.length > 0 && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setZoom(false)}>
        <button onClick={() => setZoom(false)} className="absolute top-4 right-4 text-white/70 hover:text-white p-2"><X size={24} /></button>
        <img src={photoSrc(photos[big], mediaBase)} alt="" className="max-w-[92vw] max-h-[92vh] object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    )}
    {fbOpen && <FbPostModal lot={lot} photos={photos} onClose={() => setFbOpen(false)} />}
    </>
  );
}

// ── Link-to-deal picker ───────────────────────────────────────────────────────
// Picks the open deal to attach this lot to. Carries the product's identity (so
// you can't misfire onto the wrong lot), shows each deal's stage + client + ask,
// and highlights the current link. Re-linking is a click; unlink needs a backend
// command that doesn't exist yet, so it's intentionally omitted for now.
function LinkDealModal({ lot, deals, clients, mediaBase, onClose, onLink }: {
  lot: Lot; deals: Deal[]; clients: Client[]; mediaBase: string;
  onClose: () => void; onLink: (dealId: string) => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name || "";
  // Only open deals are linkable — a won/lost deal is settled.
  const open = deals.filter((d) => d.stage !== "lost" && d.stage !== "won");
  const query = q.trim().toLowerCase();
  const matches = open.filter((d) =>
    !query || d.title.toLowerCase().includes(query) || clientName(d.client_id).toLowerCase().includes(query)
  );

  const photos: string[] = (() => { try { return JSON.parse(lot.photos_json || "[]") ?? []; } catch { return []; } })();
  const thumb = photos[0] ? photoSrc(photos[0], mediaBase) : "";
  // Headline price for the identity row — custom lots show their free text verbatim.
  const isCustom = lot.price_type === "custom";
  const priceText = isCustom ? (() => { try { return (JSON.parse(lot.details_json || "{}") as LotDetails)?.price_text || ""; } catch { return ""; } })() : "";
  const totalAsk = lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;
  const priceLabel = isCustom ? (priceText || "—") : fmtAmount(totalAsk);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[3px]" onClick={onClose}>
      <div ref={ref} className="bg-surface rounded-2xl border border-line shadow-[0_8px_24px_rgba(0,0,0,0.12)] w-[420px] max-w-[92vw] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Link2 size={15} className="text-muted flex-shrink-0" />
            <h3 className="text-[14px] font-semibold text-ink">Link to deal</h3>
            <span className="text-[11px] text-muted flex-shrink-0">{open.length} open</span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 flex-shrink-0"><X size={16} /></button>
        </div>

        {/* Product identity — never leaves you guessing which lot you're linking. */}
        <div className="flex items-center gap-3 px-5 py-3 bg-surface-2 border-b border-line">
          <div className="w-10 h-10 rounded-lg bg-surface-3 overflow-hidden flex items-center justify-center flex-shrink-0">
            {thumb ? <img src={thumb} alt="" className="w-full h-full object-cover" /> : <Package size={16} className="text-faint" strokeWidth={1.5} />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink truncate">{lot.name}</p>
            <p className="text-[12px] text-muted tabular-nums truncate">{priceLabel}</p>
          </div>
        </div>

        {/* Search — only when the list is long enough to warrant it. */}
        {open.length > 6 && (
          <div className="px-5 pt-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search deals or clients" autoFocus
                className="border border-line pl-9 pr-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" />
            </div>
          </div>
        )}

        {open.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <div className="w-11 h-11 rounded-xl bg-surface-2 flex items-center justify-center mx-auto mb-3"><GitBranch size={18} className="text-faint" strokeWidth={1.5} /></div>
            <p className="text-[13px] font-medium text-ink">No open deals yet</p>
            <p className="text-[12px] text-muted mt-1">Create a deal in Deals to link this product.</p>
          </div>
        ) : matches.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] text-muted">No deals match your search.</div>
        ) : (
          <div className="max-h-72 overflow-y-auto p-2">
            {matches.map((d) => {
              const linked = lot.linked_deal_id === d.id;
              const client = clientName(d.client_id);
              return (
                <button key={d.id} onClick={() => onLink(d.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition-colors ${linked ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-surface-2"}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-medium text-ink truncate">{d.title}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${dealStageColor(d.stage)}`}>{dealStageLabel(d.stage)}</span>
                    </div>
                    {client && <p className="text-[11px] text-muted truncate mt-0.5">{client}</p>}
                  </div>
                  {d.asking_price > 0 && <span className="text-[12px] text-ink-2 tabular-nums flex-shrink-0">{fmtAmount(d.asking_price)}</span>}
                  {linked && <Check size={15} className="text-accent flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
