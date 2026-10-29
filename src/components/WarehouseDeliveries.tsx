// R-519: deliveries. A truckload read from its manifest (every tab: brand, group, style, colour,
// cost, MSRP and the pairs expected in each size), then every case received onto its numbered
// pallet, and what came in against what the manifest lists. Reading, checking a case and every
// count are case_core.rs (byte-identical on the server); this only draws. The phone twin is
// www/app.js whd*.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FileSpreadsheet, Plus, Search, X } from "lucide-react";
import { api, type ComingBuy, type Invoice } from "../lib/api";
import { isNoiseItem, parseLineItems } from "../lib/itemSearch";
import { bucketLine, bucketName, buckets, byStyle, defaultTabs, groupsOf, layoutText, lineDesc, lineMatches, lineQty, linesOfTabs, lineStatus, offText, lineTitle, rowsText, palletMeta, palletNames, pctRate, pendingTakeKey, pickKey, sizesText, tabKind, type Bucket, type PalletView, type CaseLine, type LineCount, type LineLeft, type LoadDetail, type LoadLine, type LoadOut, type LoadSummary, type ManifestRead, type Pick, type PickPlan, type PicturesAdded, type WhCase } from "../lib/deliveries";
import { INVOICE_PREFILL_KEY, WAREHOUSE_OPEN_KEY, type InvoicePrefill } from "../lib/warehouse";
import { standsOn, type DeliveryOpen, type FloorRequest } from "../lib/floor";
import BuyPanel from "./BuyPanel";
import ComingBuys from "./ComingBuys";
import { canSeePayments } from "../lib/dealPayments";
import { openBuyInDealFlow } from "../lib/buyLoads";
import { can, isAdmin } from "../lib/permissions";
import { useSessionMe } from "../lib/useSessionMe";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import Switch from "./Switch";
import { Seg } from "./WarehouseProduct";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

const BAR = { background: "rgb(var(--c-chart-1))" };
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const many = (n: number, one: string, more: string) => `${n0(n)} ${n === 1 ? one : more}`;

type Block = { line_id: string; qty: Record<string, number>; all?: boolean };
type Draft = { id: string | null; number: number | null; kind: "box" | "loose"; pallet: string; blocks: Block[]; notes: string; copies: string;
  /** R-554: the code on the box (A3-7), shown and changeable on a box that exists. */
  code?: string };
/** A box as the screens name it: its code when it has one (R-554), else its number. */
const boxName = (c: { kind?: string; code?: string; number: number }) => (c.kind === "loose" ? "Loose items" : `Box ${c.code || c.number}`);

const blocksOf = (contents: CaseLine[]): Block[] => byStyle(contents).map((g) => ({ line_id: g.line_id, qty: Object.fromEntries(g.sizes) }));
const draftTotal = (d: Draft) => d.blocks.reduce((a, b) => a + Object.values(b.qty).reduce((x, y) => x + (y || 0), 0), 0);

export default function WarehouseDeliveries({ dropped, onDropUsed, onImport, onAsStock, onImportEnded, open: openReq, onOpenUsed, onFloor, forBuy, onAddManifest, attachBuy }: {
  dropped: { path: string; n: number; read: ManifestRead } | null;
  /** The sheet was opened: forget it, so coming back to Deliveries never opens it again. */
  onDropUsed: () => void;
  /** R-539: the Warehouse's one import (a manifest opens here; any other sheet, the column picker). */
  onImport: () => void;
  /** R-539: this sheet is stock, not a delivery: the column picker for it. */
  onAsStock: (path: string) => void;
  /** R-539: the delivery import was saved or cancelled. */
  onImportEnded: (how: "saved" | "cancelled") => void;
  /** R-550: the floor plan asked for a delivery on one of its pallets (into the box editor when `kind` is set, and back to the floor plan after). */
  open: DeliveryOpen | null;
  onOpenUsed: () => void;
  /** R-550: show a pallet on the floor plan, or get ready to place it there. */
  onFloor: (r: FloorRequest) => void;
  /** R-551: the buy the manifest being imported is for, if it was started from one still on the way. */
  forBuy: { id: string; name: string } | null;
  /** R-551: Add the manifest on a buy still on the way: the one import, for that buy. */
  onAddManifest: (b: { id: string; name: string }) => void;
  /** R-551: the delivery the import made becomes that buy's stock. true once it has. */
  attachBuy: (o: { loadId: string }) => Promise<boolean>;
}) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [coming, setComing] = useState<ComingBuy[]>([]);
  const [onBuyTab, setOnBuyTab] = useState(false);
  const [list, setList] = useState<LoadSummary[] | null>(null);
  const [detail, setDetail] = useState<LoadDetail | null>(null);
  const [start, setStart] = useState<DeliveryOpen | null>(null);
  const [preview, setPreview] = useState<{ read: ManifestRead; fileName: string; path: string; n: number } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState(false);

  const loadList = useCallback(() => {
    // R-551: the buys still on the way sit above the deliveries.
    api.listWarehouseBuys().then((r) => setComing(r.coming ?? [])).catch(() => {});
    return api.listWarehouseLoads().then(setList).catch((e) => { toast(`Couldn't load the deliveries: ${e}`, "error"); setList([]); });
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  // A case save answers without the lines (they did not change): keep the ones on hand.
  const merge = useCallback((next: LoadDetail) => setDetail((prev) => (prev && prev.load.id === next.load.id ? { ...next, load: { ...next.load, lines: next.load.lines ?? prev.load.lines } } : prev)), []);

  // Live: cases added on the phone (or another desktop) land here as soon as they sync.
  const openId = detail?.load.id ?? null;
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => {
      loadList();
      if (openId && !editing) api.getWarehouseLoad(openId).then(merge).catch(() => {});
    }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [loadList, openId, editing, merge]);

  // A sheet the Warehouse read as a manifest opens here, once.
  useEffect(() => {
    if (!dropped) return;
    const read = dropped.read;
    setPreview((p) => ({ read, fileName: dropped.path.split(/[\\/]/).pop() || "Manifest", path: dropped.path, n: (p?.n ?? 0) + 1 }));
    onDropUsed();
  }, [dropped, onDropUsed]);
  const open = (id: string) => api.getWarehouseLoad(id).then((d) => setDetail(d)).catch((e) => toast(String(e), "error"));
  // R-550: the floor plan asked for this delivery on one pallet, once.
  useEffect(() => {
    if (!openReq) return;
    onOpenUsed();
    api.getWarehouseLoad(openReq.loadId).then((d) => { setStart(openReq); setDetail(d); }).catch((e) => toast(String(e), "error"));
  }, [openReq, onOpenUsed]);
  // R-488: Deal Flow's Inventory view (or the Inventory screen) asked for one delivery.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WAREHOUSE_OPEN_KEY);
      const want = raw ? JSON.parse(raw) : null;
      if (want?.kind === "load" && want.id) { localStorage.removeItem(WAREHOUSE_OPEN_KEY); open(want.id); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (preview) {
    return <ManifestPreview key={preview.n} read={preview.read} fileName={preview.fileName} path={preview.path} forBuyName={forBuy?.name} onCancel={() => { setPreview(null); onImportEnded("cancelled"); }}
      onSaved={(d, msg) => {
        setPreview(null); setDetail(d); loadList(); toast(msg); onImportEnded("saved");
        // R-551: the delivery is the buy's stock now, and opens on the buy.
        if (forBuy) attachBuy({ loadId: d.load.id }).then((ok) => { if (ok) setOnBuyTab(true); });
      }}
      onLate={(msg) => { loadList(); toast(msg); }}
      onAsStock={() => { const p = preview.path; setPreview(null); onAsStock(p); }} />;
  }
  if (detail) {
    return <DeliveryScreen d={detail} merge={merge} setEditing={setEditing} start={start} onFloor={onFloor} openOnBuy={onBuyTab} onBack={() => { setDetail(null); setStart(null); setOnBuyTab(false); loadList(); }} />;
  }

  const live = (list || []).filter((d) => !d.archived), gone = (list || []).filter((d) => d.archived);
  const card = (d: LoadSummary) => {
    const t = d.totals, pct = t.expected > 0 ? Math.min(1, t.received / t.expected) : 0;
    return (
      <button key={d.id} onClick={() => open(d.id)} className={`${WH_CARD} w-full text-left p-4 hover:border-accent/40 transition-colors`}>
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[14px] font-semibold text-ink truncate">{d.name}</div>
          <div className="text-[12px] text-muted whitespace-nowrap"><span className="text-[15px] font-semibold text-ink tabular-nums">{n0(t.received)}</span> of {n0(t.expected)} pairs</div>
        </div>
        <div className="text-[12px] text-muted mt-0.5">{many(t.lines, "style", "styles")} · {many(t.cases, "box", "boxes")} on {many(t.pallets, "pallet", "pallets")}{d.source ? ` · ${d.source}` : ""}</div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-3"><div className="h-full rounded-full" style={{ ...BAR, width: `${pct * 100}%` }} /></div>
      </button>
    );
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-[12.5px] text-muted max-w-[640px]">Import a delivery's manifest: every page is read, each style and colour with its cost, MSRP and the pairs expected in each size, whichever rows it takes on the sheet. Then add each box onto its pallet as the truck is unloaded.</p>
        <button onClick={onImport} className={WH_BTN_PRIMARY} title="Or drop the file anywhere on this screen"><FileSpreadsheet size={14} /> Import a sheet</button>
      </div>
      {coming.length > 0 && (
        <div className="mb-4">
          <ComingBuys items={coming} numbers={numbers} onOpen={(b) => openBuyInDealFlow(b.id)}
            action={isAdmin(me) || can(me, "deal_flow:edit") ? (b) => (
              <button type="button" onClick={(e) => { e.stopPropagation(); onAddManifest({ id: b.id, name: b.name }); }} className={WH_BTN_PRIMARY}>Add the manifest</button>
            ) : undefined} />
        </div>
      )}
      {list === null ? <div className="text-[13px] text-muted">Loading…</div> : live.length ? (
        <div className="grid gap-3 grid-cols-1 xl:grid-cols-2">{live.map(card)}</div>
      ) : <div className={`${WH_CARD} p-6 text-[13px] text-muted text-center`}>No deliveries yet. Drop a manifest here or use Import a sheet.</div>}
      {gone.length > 0 && <>
        <button onClick={() => setShowRemoved((v) => !v)} className={`${WH_BTN_SECONDARY} mt-4`}>{showRemoved ? "Hide" : "Show"} removed ({gone.length})</button>
        {showRemoved && <div className="grid gap-3 grid-cols-1 xl:grid-cols-2 mt-3 opacity-80">{gone.map(card)}</div>}
      </>}
    </div>
  );
}

// ---- Pictures from the sheet (R-537) ----------------------------------------------------
// A line's `image` is a path inside the synced media folder ("media/deliveries/<load>/<line>.jpg").
// A line with no picture shows nothing; a picture this computer does not have yet is fetched
// when the delivery opens (ensure_delivery_pictures) and `v` re-asks for every image then.

/** False once the component is gone: an answer that comes back after the screen was left changes nothing on it. */
function useAlive() {
  const ref = useRef(true);
  useEffect(() => { ref.current = true; return () => { ref.current = false; }; }, []);
  return ref;
}

let mediaBase: Promise<string> | null = null;
function useMediaBase() {
  const [base, setBase] = useState("");
  useEffect(() => { (mediaBase ??= api.mediaBaseDir().catch(() => "")).then(setBase); }, []);
  return base;
}
const picSrc = (base: string, rel: string | undefined, v: number) =>
  base && rel ? `${convertFileSrc(`${base.replace(/\\/g, "/")}/${rel}`)}${v ? `?v=${v}` : ""}` : "";

const PicCtx = createContext<{ base: string; v: number; show: (l: LoadLine) => void }>({ base: "", v: 0, show: () => {} });

/** A style's picture, or nothing when it has none. `zoom`: a click shows it large. */
function Thumb({ l, size = 40, zoom = false }: { l: LoadLine; size?: number; zoom?: boolean }) {
  const { base, v, show } = useContext(PicCtx);
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [v, l.image]);
  const src = picSrc(base, l.image, v);
  if (!src || bad) return null;
  const img = <img src={src} alt="" loading="lazy" className="w-full h-full object-contain" onError={() => setBad(true)} />;
  const cls = "flex-shrink-0 rounded-md overflow-hidden bg-surface-2 ring-1 ring-line";
  // A span, not a button: it can sit inside a row that is itself a button.
  return zoom
    ? <span role="button" tabIndex={0} aria-label={`See the picture of ${lineTitle(l)}`} className={`${cls} cursor-zoom-in`} style={{ width: size, height: size }}
        onClick={(e) => { e.stopPropagation(); show(l); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); show(l); } }}>{img}</span>
    : <span className={cls} style={{ width: size, height: size }}>{img}</span>;
}

function PhotoView({ l, onClose }: { l: LoadLine; onClose: () => void }) {
  const { base, v } = useContext(PicCtx);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className={`${WH_CARD} p-3 w-full max-w-[640px]`} onClick={(e) => e.stopPropagation()}>
        <img src={picSrc(base, l.image, v)} alt={lineTitle(l)} className="w-full max-h-[70vh] object-contain rounded-md bg-surface-2" />
        <div className="flex items-start justify-between gap-3 mt-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink">{lineTitle(l)}</div>
            <div className="text-[12px] text-muted">{[l.brand, l.group, lineDesc(l)].filter(Boolean).join(" · ")}</div>
            <div className="text-[12px] text-ink-2 tabular-nums mt-0.5">{sizesText(l)}</div>
          </div>
          <button onClick={onClose} className={WH_BTN_SECONDARY}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---- The preview: nothing is saved until Save delivery ---------------------------------

// R-537: one card a page, each saying plainly whether it is imported. A totals page is never
// imported; each page of styles has its own switch, on at first; a page that repeats all the
// others is off at first. Only the pages switched on are saved, and their pictures with them.
function ManifestPreview({ read, fileName, path, forBuyName, onCancel, onSaved, onLate, onAsStock }: { read: ManifestRead; fileName: string; path: string; forBuyName?: string; onCancel: () => void; onSaved: (d: LoadDetail, msg: string) => void; onLate: (msg: string) => void; onAsStock: () => void }) {
  const [listed, setListed] = useState<string | null>(null);
  const [name, setName] = useState(fileName.replace(/\.[^.]+$/, ""));
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState<Set<string>>(() => defaultTabs(read));
  const idx = useMemo(() => Object.fromEntries(read.lines.map((l) => [l.id, l])) as Record<string, LoadLine>, [read.lines]);
  const chosen = useMemo(() => linesOfTabs(read, on), [read, on]);
  const chosenIds = useMemo(() => new Set(chosen.map((l) => l.id)), [chosen]);
  const pairs = chosen.reduce((a, l) => a + lineQty(l), 0);
  const totalCol = chosen.reduce((a, l) => a + (l.sheet_total || 0), 0);
  const pics = read.tabs.filter((t) => on.has(t.name)).reduce((a, t) => a + (t.pictures ?? 0), 0);
  const mism = read.mismatches.filter((m) => chosenIds.has(m.line_id));
  const groups = groupsOf(chosen);
  const pages = read.tabs.filter((t) => ["items", "copy"].includes(tabKind(t)));
  const ignored = read.tabs.filter((t) => !["items", "copy"].includes(tabKind(t)));
  const tabWarnings = new Set(read.tabs.flatMap((t) => t.warnings ?? []));
  const otherWarnings = read.warnings.filter((w) => !tabWarnings.has(w));
  const st = read.stated;
  const stLines = st?.lines ?? null;
  const linesAgree = stLines == null || stLines === chosen.length;
  const flip = (t: string) => setOn((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  const alive = useAlive();
  const save = async () => {
    setBusy(true);
    try {
      const d: LoadDetail & { pictures?: PicturesAdded; pictures_error?: string } = pics > 0 ? await api.createLoadWithPictures(name, fileName, chosen, path) : await api.createWarehouseLoad(name, fileName, chosen);
      const msg = !pics ? "Delivery saved"
        : d.pictures ? `Delivery saved, with pictures on ${many(d.pictures.on_lines, "style", "styles")}`
        : `Delivery saved. The pictures did not come in (${d.pictures_error ?? "no reason given"}). Use Add pictures from the sheet on the delivery.`;
      // Saved after this preview was replaced: the list still learns of it.
      if (alive.current) onSaved(d, msg); else onLate(msg);
    } catch (e) { toast(String(e), "error"); if (alive.current) setBusy(false); }
  };

  return (
    <div className="max-w-[920px]">
      <button onClick={onCancel} disabled={busy} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink-2 mb-3 disabled:opacity-50"><ArrowLeft size={13} /> Deliveries</button>
      <h2 className="text-[18px] font-semibold text-ink tracking-tight">Import a delivery</h2>
      {forBuyName && <p className="text-[13px] text-ink-2 mt-1">The delivery this makes becomes the stock of {forBuyName}.</p>}
      <p className="text-[13px] text-ink-2 mt-1">{fileName} has {many(read.tabs.length, "page", "pages")}. {pages.length ? `${many(pages.length, "page has", "pages have")} styles to import` : "No page has styles to import"}{ignored.length ? `, and ${many(ignored.length, "page is", "pages are")} ignored` : ""}. Check each page below.</p>
      <p className="text-[12.5px] text-muted mt-1">Each style is read from its own rows, however many it takes: the row of sizes above it, or one size a row. Every style below says which rows. <button onClick={onAsStock} disabled={busy} className="text-accent hover:underline disabled:opacity-50">Not a delivery? Choose the columns of a stock sheet instead</button></p>

      <div className="space-y-3 mt-4">
        {read.tabs.map((t) => {
          const kind = tabKind(t);
          if (kind !== "items" && kind !== "copy") {
            return (
              <div key={t.name} className={`${WH_CARD} p-4 bg-surface-2/60`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[14px] font-semibold text-ink-2">{t.name}</div>
                  <StatusPill tone="neutral">Ignored</StatusPill>
                </div>
                <p className="text-[12.5px] text-muted mt-1">{kind === "totals"
                  ? `This is a totals page. Nothing on it is imported.${st && st.tab === t.name ? ` It is only used to check the count: it says ${stLines != null ? `${many(stLines, "style", "styles")} and ` : ""}${n0(st.pairs)} pairs.` : ""}`
                  : t.note || "Nothing on this page is imported."}</p>
              </div>
            );
          }
          const isOn = on.has(t.name);
          return (
            <div key={t.name} className={`${WH_CARD} p-4 ${isOn ? "" : "opacity-75"}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-ink">{t.name}</div>
                  <div className="text-[12.5px] text-muted tabular-nums">{many(t.lines, "style", "styles")} · {n0(t.pairs)} pairs{t.pictures ? ` · ${many(t.pictures, "picture", "pictures")}` : ""}</div>
                </div>
                <div className="flex items-center gap-2.5">
                  {isOn ? <StatusPill tone="success">Imported</StatusPill> : <StatusPill tone="neutral">Left out</StatusPill>}
                  <span className="text-[12.5px] text-ink-2">Import this page</span>
                  <Switch on={isOn} onToggle={() => flip(t.name)} label={`Import ${t.name}`} />
                </div>
              </div>
              {kind === "copy" && <p className="text-[12.5px] text-warning-ink mt-1.5">{t.note}</p>}
              {layoutText(t.layout) && <p className="text-[12px] text-muted mt-1.5">{layoutText(t.layout)}</p>}
              {(t.samples ?? []).length > 0 && <div className="mt-2.5 rounded-lg border border-line divide-y divide-line">
                {(t.samples ?? []).map((id) => {
                  const l = idx[id];
                  if (!l) return null;
                  const src = read.previews?.[id];
                  return (
                    <div key={id} className="flex items-center gap-3 px-3 py-2">
                      {src && <img src={src} alt="" className="w-14 h-14 rounded-md object-contain bg-surface-2 ring-1 ring-line flex-shrink-0" />}
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ink">{lineTitle(l)}{l.group ? <span className="font-normal text-muted"> · {l.group}</span> : null}</div>
                        {lineDesc(l) && <div className="text-[12px] text-muted truncate">{lineDesc(l)}</div>}
                        <div className="text-[12px] text-ink-2 tabular-nums">{sizesText(l) || "No pairs listed"}</div>
                        {rowsText(l) && <div className="text-[11.5px] text-muted tabular-nums">{rowsText(l)}</div>}
                      </div>
                    </div>
                  );
                })}
                {t.lines > (t.samples ?? []).length && <div className="px-3 py-1.5 text-[12px] text-muted">
                  and {many(t.lines - (t.samples ?? []).length, "more style", "more styles")}.{" "}
                  <button onClick={() => setListed(listed === t.name ? null : t.name)} className="text-accent hover:underline">{listed === t.name ? "Hide the list" : `Show every style on this page (${n0(t.lines)})`}</button>
                </div>}
                {listed === t.name && <div className="max-h-[360px] overflow-auto border-t border-line">
                  {read.lines.filter((x) => x.sheet === t.name).map((x) => (
                    <div key={x.id} className="px-3 py-1.5 border-b border-line last:border-b-0 text-[12px]">
                      <span className="font-medium text-ink">{lineTitle(x)}</span>{x.group ? <span className="text-muted"> · {x.group}</span> : null}
                      <span className="text-ink-2 tabular-nums"> · {sizesText(x) || "No pairs listed"}</span>
                      {rowsText(x) && <span className="block text-[11.5px] text-muted tabular-nums">{rowsText(x)}</span>}
                    </div>
                  ))}
                </div>}
              </div>}
              {(t.mismatches ?? 0) > 0 && <p className="text-[12.5px] text-warning-ink mt-2">{offText(t.mismatches ?? 0)}. {(t.mismatches ?? 0) === 1 ? "It is" : "They are"} listed below.</p>}
              {(t.warnings ?? []).map((w, k) => <p key={k} className="text-[12.5px] text-warning-ink mt-1.5">{w}</p>)}
            </div>
          );
        })}
      </div>

      <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[14px] text-ink">{chosen.length
          ? <>Importing {many(pages.filter((t) => on.has(t.name)).length, "page", "pages")}: <span className="font-semibold tabular-nums">{many(chosen.length, "style", "styles")}</span>, <span className="font-semibold tabular-nums">{n0(pairs)} pairs</span>{pics ? `, ${many(pics, "picture", "pictures")}` : ""}.</>
          : "No page is switched on, so nothing would be imported."}</div>
        {st && chosen.length > 0 && <p className={`text-[12.5px] mt-1 ${pairs === st.pairs && linesAgree ? "text-success-ink" : "text-warning-ink"}`}>{
          pairs === st.pairs && linesAgree
            ? `This matches the totals page: ${stLines != null ? `${many(stLines, "style", "styles")} and ` : ""}${n0(st.pairs)} pairs.`
            : totalCol === st.pairs && linesAgree && mism.length
              ? `The totals page says ${n0(st.pairs)} pairs. The sizes add up to ${n0(pairs)}, ${n0(Math.abs(st.pairs - pairs))} ${pairs < st.pairs ? "fewer" : "more"}, because ${offText(mism.length)} (listed below). Boxes are counted by size, so ${n0(pairs)} is what is expected.`
              : `The totals page says ${stLines != null ? `${many(stLines, "style", "styles")} and ` : ""}${n0(st.pairs)} pairs. The pages switched on have ${many(chosen.length, "style", "styles")} and ${n0(pairs)} pairs.`
        }</p>}
        {(read.pictures_left_out ?? 0) > 0 && <p className="text-[12px] text-muted mt-1">{many(read.pictures_left_out ?? 0, "picture is", "pictures are")} left out: on a row with no style, a second picture for a style, or a picture that could not be read.</p>}
        <label className="block mt-3 max-w-[420px]"><span className="text-[12px] text-muted">Name of the delivery</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>
        <div className="flex gap-2 mt-3">
          <button onClick={save} disabled={busy || !chosen.length || !name.trim()} className={WH_BTN_PRIMARY}>{busy ? (pics ? "Saving, with pictures…" : "Saving…") : "Save delivery"}</button>
          <button onClick={onCancel} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
        </div>
      </div>

      {groups.length > 0 && <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[13px] font-semibold text-ink mb-2">By brand and group</div>
        {groups.map((g, k) => (
          <div key={k} className="flex justify-between gap-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px]">
            <span className="text-ink-2">{g.brand}{g.group ? ` · ${g.group}` : ""}</span>
            <span className="text-muted tabular-nums whitespace-nowrap">{many(g.lines, "style", "styles")} · <span className="text-ink font-medium">{n0(g.pairs)}</span> pairs</span>
          </div>
        ))}
      </div>}

      {mism.length > 0 && <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[13px] font-semibold text-ink">{offText(mism.length)}</div>
        <p className="text-[12px] text-muted mt-0.5 mb-2">Boxes are counted by size, so the sizes are kept. Check these when they come off the truck.</p>
        {mism.map((m) => (
          <div key={m.line_id} className="flex justify-between gap-3 py-1.5 border-t border-line text-[12.5px]">
            <span className="text-ink-2">{[m.style, m.color].filter(Boolean).join(" ")} <span className="text-muted">· {m.source}</span></span>
            <span className="text-muted tabular-nums whitespace-nowrap">sizes {n0(m.sizes)}, Total {n0(m.total)}</span>
          </div>
        ))}
      </div>}
      {otherWarnings.length > 0 && <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[13px] font-semibold text-ink mb-1">Left out</div>
        {otherWarnings.map((w, k) => <p key={k} className="text-[12px] text-muted">{w}</p>)}
      </div>}
    </div>
  );
}

// ---- One delivery: its pallets, and against the manifest -------------------------------

/** R-550: which of a delivery's pallets stand on a live building (pallet number to building id). */
function useOnFloor(loadId: string): Record<number, string> {
  const [placed, setPlaced] = useState<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    const load = () => api.listWarehouseFloors().then((f) => {
      if (!alive) return;
      const buildings = f.floors.filter((x) => !x.archived);
      setPlaced(Object.fromEntries(f.pallets.filter((p) => p.load_id === loadId && standsOn(p, buildings)).map((p) => [p.number, p.floor_id])));
    }).catch(() => {});
    void load();
    listen("netsync-applied", () => { void load(); }).then((u) => { if (alive) un = u; else u(); }).catch(() => {});
    return () => { alive = false; un?.(); };
  }, [loadId]);
  return placed;
}

function DeliveryScreen({ d, merge, setEditing, onBack, start, onFloor, openOnBuy }: { d: LoadDetail; merge: (d: LoadDetail) => void; setEditing: (b: boolean) => void; onBack: () => void; start: DeliveryOpen | null; onFloor: (r: FloorRequest) => void; openOnBuy?: boolean }) {
  const L = d.load, T = d.tally.totals;
  const lines = useMemo(() => L.lines ?? [], [L.lines]);
  const idx = useMemo(() => Object.fromEntries(lines.map((l) => [l.id, l])) as Record<string, LoadLine>, [lines]);
  const counts = useMemo(() => Object.fromEntries(d.tally.counts.map((c) => [c.line_id, c])) as Record<string, LineCount>, [d.tally.counts]);
  const [tab, setTab] = useState<"pallets" | "check" | "sell" | "buy">("pallets");
  // R-551: a buy was just attached to this delivery (Add the manifest): show it.
  useEffect(() => { if (openOnBuy) setTab("buy"); }, [openOnBuy]);
  const pallets: PalletView[] = d.pallets ?? [];
  const [pallet, setPallet] = useState<number | null>(() => start?.pallet ?? (d.pallets ?? [])[0]?.pallet ?? null);
  // R-550: opened from the floor plan on one pallet, straight into the box editor, and back there after.
  // R-554: or straight into one box (filling a box counted on from the floor plan).
  const [draft, setDraftRaw] = useState<Draft | null>(() => {
    const c = start?.caseId ? d.cases.find((x) => x.id === start.caseId) : undefined;
    if (c) return { id: c.id, number: c.number, kind: c.kind === "loose" ? "loose" : "box", pallet: String(c.pallet), blocks: blocksOf(c.contents), notes: c.notes, copies: "1", code: c.code ?? "" };
    return start?.kind ? { id: null, number: null, kind: start.kind, pallet: String(start.pallet), blocks: [], notes: "", copies: "1" } : null;
  });
  const [back, setBack] = useState(!!start?.back);
  useEffect(() => { if (start?.kind || start?.caseId) setEditing(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [saved, setSaved] = useState<number[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingLine, setAddingLine] = useState<string | null>(null);
  const [sureRemove, setSureRemove] = useState(false);
  const setDraft = (x: Draft | null) => { setDraftRaw(x); setEditing(!!x); };
  const live = !L.archived;
  const nextPallet = pallets.reduce((a, p) => Math.max(a, p.pallet), 0) + 1;
  // R-550: back to the floor plan with the pallet selected, and each pallet's line to it.
  const toFloor = (n: number) => { setBack(false); onFloor({ kind: "show", palletId: `pal-${L.id}-${n}` }); };
  const placed = useOnFloor(L.id);
  const floorLine = (n: number) => (live ? (placed[n]
    ? <button onClick={() => onFloor({ kind: "show", palletId: `pal-${L.id}-${n}` })} className="text-[12px] text-accent hover:text-accent-hover">On the floor plan</button>
    : <button onClick={() => onFloor({ kind: "place", palletId: `pal-${L.id}-${n}` })} className="text-[12px] text-muted hover:text-ink-2">Put on the floor plan</button>) : null);

  // R-537: the sheet's pictures. Fetch the ones this computer lacks (a phone added them), then
  // show them; Add pictures from the sheet puts them on a delivery saved without.
  const base = useMediaBase();
  const [picV, setPicV] = useState(0);
  const [big, setBig] = useState<LoadLine | null>(null);
  const picKey = useMemo(() => lines.map((l) => l.image || "").join("|"), [lines]);
  useEffect(() => {
    if (!picKey.replace(/\|/g, "")) return;
    // Pictures another device has not uploaded yet are asked for again, every 30 seconds, ten times.
    let live = true, tries = 0, timer: number | undefined;
    const run = () => api.ensureDeliveryPictures(L.id).then((r) => {
      if (r.arrived > 0) setPicV((v) => v + 1);
      if (live && r.missing > 0 && ++tries < 10) timer = window.setTimeout(run, 30_000);
    }).catch(() => {});
    run();
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [L.id, picKey]);
  const pic = useMemo(() => ({ base, v: picV, show: setBig }), [base, picV]);
  const [picBusy, setPicBusy] = useState(false);
  const screenAlive = useAlive();
  const addPictures = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest with pictures", extensions: ["xlsx", "xlsm"] }] });
    if (typeof f !== "string") return;
    setPicBusy(true);
    try {
      const r = await api.addLoadPictures(L.id, f);
      merge(r);
      if (screenAlive.current) setPicV((v) => v + 1);
      const p = r.pictures;
      if (!p.on_lines) toast("No picture in that file sits beside a style on this delivery.", "error");
      else toast(`Pictures on ${many(p.on_lines, "style", "styles")}${p.not_on_delivery ? `. ${many(p.not_on_delivery, "picture is", "pictures are")} for styles not on this delivery` : ""}.`);
    } catch (e) { toast(String(e), "error"); }
    finally { if (screenAlive.current) setPicBusy(false); }
  };

  const update = async (patch: { name?: string; archived?: boolean }) => {
    try { merge(await api.updateWarehouseLoad(L.id, patch)); return true; } catch (e) { toast(String(e), "error"); return false; }
  };
  const startCase = (c: WhCase | null, kind: "box" | "loose" = "box") => {
    setSaved(null);
    setDraft(c ? { id: c.id, number: c.number, kind: c.kind === "loose" ? "loose" : "box", pallet: String(c.pallet), blocks: blocksOf(c.contents), notes: c.notes, copies: "1", code: c.code ?? "" }
      : { id: null, number: null, kind, pallet: String(pallet ?? nextPallet), blocks: [], notes: "", copies: "1" });
  };
  // R-535: pallets as records: start one, set where it stands, mark it full.
  const [palletBusy, setPalletBusy] = useState(false);
  const startPallet = async () => {
    if (palletBusy) return;
    setPalletBusy(true);
    try {
      const next = await api.startLoadPallet(L.id);
      merge(next);
      setPallet(Math.max(...(next.pallets ?? []).map((p) => p.pallet)));
      setDraft(null); setSaved(null);
    } catch (e) { toast(String(e), "error"); }
    finally { setPalletBusy(false); }
  };
  const savePallet = async (n: number, patch: { location?: string; closed?: boolean; startNext?: boolean; archived?: boolean }) => {
    if (palletBusy) return null;
    setPalletBusy(true);
    try { const next = await api.saveLoadPallet(L.id, n, patch); merge(next); return next; } catch (e) { toast(String(e), "error"); return null; }
    finally { setPalletBusy(false); }
  };
  const [locDraft, setLocDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const saveCase = async () => {
    if (!draft) return;
    const contents: CaseLine[] = [];
    draft.blocks.forEach((b) => Object.entries(b.qty).forEach(([size, pairs]) => { if (pairs > 0) contents.push({ line_id: b.line_id, size, pairs }); }));
    // R-554: a box that exists may be saved empty (counted on its pallet, not filled yet).
    if (!contents.length && !(draft.id && draft.kind === "box")) { toast(draft.kind === "loose" ? "Put at least one pair in." : "Put at least one pair in the box.", "error"); return; }
    const p = parseInt(draft.pallet, 10);
    if (!(p >= 1)) { toast("Type the pallet number.", "error"); return; }
    try {
      const before = new Set(d.cases.map((c) => c.id));
      const was = draft.id ? d.cases.find((c) => c.id === draft.id) : undefined;
      const code = was && draft.kind === "box" && (draft.code ?? "") !== (was.code ?? "") ? draft.code ?? "" : undefined;
      const next = await api.saveWarehouseCase(L.id, { caseId: draft.id, pallet: p, contents, notes: draft.notes, copies: draft.id || draft.kind === "loose" ? 1 : Math.max(1, parseInt(draft.copies, 10) || 1), kind: draft.kind, code });
      merge(next);
      setPallet(p);
      const mine = draft.id ? next.cases.find((c) => c.id === draft.id) : undefined;
      const mc = (mine?.code ?? "").toLowerCase();
      const dupe = !!mc && next.cases.some((c) => c.id !== mine?.id && c.kind !== "loose" && (c.code ?? "").toLowerCase() === mc);
      // R-550: a box or loose items added from the floor plan are saved once, and it comes back. R-554: so is a box filled from there.
      if (back) {
        const added = next.cases.filter((c) => !before.has(c.id));
        setDraft(null); setSaved(null);
        toast(mine ? (dupe ? `${boxName(mine)} saved. Another box has the code ${mine.code} too.` : `${boxName(mine)} saved`)
          : draft.kind === "loose" ? `Loose items saved on pallet ${p}` : added.length === 1 ? `${boxName(added[0])} saved on pallet ${p}` : `${added.length} boxes saved on pallet ${p}`, dupe ? "error" : undefined);
        toFloor(p);
        return;
      }
      if (draft.id) { setDraft(null); toast(dupe && mine ? `Saved. Another box has the code ${mine.code} too.` : "Saved", dupe ? "error" : undefined); return; }
      // Loose items are one row a save: back to the pallet, so the same items are not saved twice.
      if (draft.kind === "loose") { setDraft(null); toast(`Loose items saved on pallet ${p}`); return; }
      // The next case starts with the same pairs: most cases off one truck are the same pack.
      setSaved(next.cases.filter((c) => !before.has(c.id)).map((c) => c.number).sort((a, b) => a - b));
      setDraft({ ...draft, pallet: String(p), notes: "", copies: "1" });
    } catch (e) { toast(String(e), "error"); }
  };
  const removeCase = async () => {
    if (!draft?.id) return;
    try { merge(await api.removeWarehouseCase(L.id, draft.id)); setDraft(null); toast("Removed"); } catch (e) { toast(String(e), "error"); }
  };

  const cs = pallet != null ? d.cases.filter((c) => c.pallet === pallet).sort((a, b) => (a.kind === "loose" ? 1 : 0) - (b.kind === "loose" ? 1 : 0) || a.number - b.number) : [];
  const ps = pallets.find((p) => p.pallet === pallet);
  const recentLocs = [...new Set([...pallets.map((p) => p.location).filter(Boolean), ...(d.recent_locations ?? [])])].filter((l) => l !== ps?.location).slice(0, 10);

  return (
    <PicCtx.Provider value={pic}>
    <div>
      {big && <PhotoView l={big} onClose={() => setBig(null)} />}
      <button onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={13} /> Deliveries</button>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          {renaming != null ? (
            <div className="flex gap-2 items-center">
              <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} w-[320px]`} />
              <button onClick={async () => { if (await update({ name: renaming })) setRenaming(null); }} className={WH_BTN_PRIMARY}>Save</button>
              <button onClick={() => setRenaming(null)} className={WH_BTN_SECONDARY}>Cancel</button>
            </div>
          ) : <h2 className="text-[18px] font-semibold text-ink tracking-tight">{L.name}</h2>}
          <p className="text-[12px] text-muted mt-0.5 tabular-nums">
            <span className="text-ink-2 font-medium">{n0(T.received)}</span> of {n0(T.expected)} pairs in · {many(T.cases, "box", "boxes")} on {many(pallets.length, "pallet", "pallets")}
            {T.received > 0 && <> · {money(T.cost)} cost, {money(T.msrp)} MSRP in</>}
          </p>
          {L.archived && <p className="text-[12px] text-warning-ink mt-1">This delivery was removed. Bring it back to add cases.</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Seg size="md" value={tab} onChange={setTab} options={[{ key: "pallets", label: "Pallets" }, { key: "check", label: "Against the manifest" }, { key: "sell", label: "Sell" }, { key: "buy", label: "Buy" }]} />
          {renaming == null && <button onClick={() => setRenaming(L.name)} className={WH_BTN_SECONDARY}>Rename</button>}
          {live && <button onClick={() => setAddingLine("")} className={WH_BTN_SECONDARY}>Add a style not on the manifest</button>}
          {live && <button onClick={addPictures} disabled={picBusy} className={WH_BTN_SECONDARY} title="Choose the manifest file: each picture goes on the style on its row">{picBusy ? "Adding pictures…" : "Add pictures from the sheet"}</button>}
          {L.archived ? <button onClick={() => update({ archived: false })} className={WH_BTN_SECONDARY}>Bring it back</button>
            : sureRemove ? <>
              <button onClick={async () => { if (await update({ archived: true })) onBack(); }} className={WH_BTN_PRIMARY}>Remove it</button>
              <button onClick={() => setSureRemove(false)} className={WH_BTN_SECONDARY}>Keep it</button>
            </> : <button onClick={() => setSureRemove(true)} className={WH_BTN_SECONDARY} title="It moves under Removed with its cases, and can be brought back">Remove</button>}
        </div>
      </div>

      {addingLine != null && <NewLineForm lines={lines} guess={addingLine} onCancel={() => setAddingLine(null)} onAdd={async (nl) => {
        try {
          const before = new Set(lines.map((l) => l.id));
          const next = await api.addWarehouseLoadLine(L.id, nl);
          merge(next);
          setAddingLine(null);
          const added = (next.load.lines ?? []).find((l) => !before.has(l.id));
          if (draft && added) setDraft({ ...draft, blocks: [...draft.blocks, { line_id: added.id, qty: {} }] });
          else toast("Added to the delivery");
        } catch (e) { toast(String(e), "error"); }
      }} />}

      {tab === "buy" ? <BuyPanel loadId={L.id} stockName={L.name} unit="pairs" defaultUnits={T.expected} /> : tab === "check" ? <CheckView lines={lines} counts={counts} totals={T} pallets={pallets} /> : tab === "sell" ? <SellView d={d} lines={lines} merge={merge} live={live} /> : (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            {live && <button onClick={startPallet} disabled={palletBusy} className={`${WH_BTN_SECONDARY} w-full justify-center`}><Plus size={14} /> Start pallet {nextPallet}</button>}
            {pallets.map((p) => (
              <div key={p.pallet} className={`${WH_CARD} transition-colors ${pallet === p.pallet ? "ring-2 ring-accent/40 border-accent/40" : "hover:border-accent/30"}`}>
                <button onClick={() => { setPallet(p.pallet); setDraft(null); setSaved(null); setLocDraft(null); setAsking(null); }}
                  className={`w-full text-left px-3 pt-2.5 ${live ? "pb-1.5" : "pb-2.5"}`}>
                  <div className="flex justify-between items-baseline gap-2"><span className="text-[13px] font-semibold text-ink">Pallet {p.pallet}{p.location && <span className="font-normal text-muted"> at {p.location}</span>}</span><span className="text-[12px] text-muted tabular-nums"><span className="text-ink font-medium">{n0(p.pairs)}</span> pairs</span></div>
                  <div className="text-[11.5px] text-muted mt-0.5">{palletMeta(p, money)}</div>
                  <div className="flex gap-1 mt-1">{p.closed ? <StatusPill tone="neutral">Full</StatusPill> : <StatusPill tone="success">Open</StatusPill>}{!p.location && <StatusPill tone="warning">No location</StatusPill>}</div>
                </button>
                {live && <div className="px-3 pb-2.5">{floorLine(p.pallet)}</div>}
              </div>
            ))}
            {!pallets.length && <p className="text-[12.5px] text-muted px-1">No pallets yet. Start pallet 1, then add each box on it as it comes off the truck.</p>}
          </div>

          <div className="min-w-0 space-y-3">
            {draft ? (
              <CaseEditor draft={draft} setDraft={setDraft} lines={lines} idx={idx} counts={counts} cases={d.cases} saved={saved}
                onSave={saveCase} onRemove={draft.id ? removeCase : undefined} onClose={() => { setDraft(null); setSaved(null); if (back && start) toFloor(start.pallet); }}
                onNotListed={(q) => setAddingLine(q)} />
            ) : pallet != null && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold text-ink">Pallet {pallet}{ps?.location && <span className="font-normal text-muted"> at {ps.location}</span>}</div>
                    {ps && <div className="text-[12px] text-muted tabular-nums">{palletMeta(ps, money)}{ps.pairs ? ` · ${n0(ps.pairs)} pairs · ${money(ps.msrp)} MSRP` : ""} · {ps.closed ? "full" : "open"}</div>}
                    {floorLine(pallet)}
                  </div>
                  {live && <div className="flex gap-2">
                    <button onClick={() => startCase(null, "box")} className={WH_BTN_PRIMARY}><Plus size={14} /> Add a box</button>
                    <button onClick={() => startCase(null, "loose")} className={WH_BTN_SECONDARY}>Add loose items</button>
                  </div>}
                </div>
                {live && (
                  <div className={`${WH_CARD} p-3`}>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-[12px] text-muted">Where it stands
                        <div className="w-56"><input value={locDraft ?? ps?.location ?? ""} maxLength={40} placeholder="For example A2, or Dock door" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}
                          onChange={(e) => setLocDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          onBlur={async () => { if (locDraft != null && locDraft.trim() !== (ps?.location ?? "")) { if (await savePallet(pallet, { location: locDraft })) toast(`Saved: pallet ${pallet}${locDraft.trim() ? ` at ${locDraft.trim()}` : " has no location"}`); } setLocDraft(null); }} /></div>
                      </label>
                      {recentLocs.map((l) => <button key={l} onClick={() => savePallet(pallet, { location: l })} className={`${WH_BTN_SECONDARY} h-8 px-2.5 text-[12px]`}>{l}</button>)}
                    </div>
                  </div>
                )}
                {cs.map((c) => (
                  <button key={c.id} onClick={() => live && startCase(c)} disabled={!live} className={`${WH_CARD} w-full text-left p-3.5 hover:border-accent/30 transition-colors disabled:hover:border-line`}>
                    <div className="flex justify-between items-baseline gap-3"><span className="text-[13px] font-semibold text-ink">{boxName(c)}</span>{c.contents.length ? <span className="text-[12px] text-muted tabular-nums"><span className="text-ink font-medium">{n0(c.contents.reduce((a, x) => a + x.pairs, 0))}</span> {c.contents.reduce((a, x) => a + x.pairs, 0) === 1 ? "pair" : "pairs"}</span> : <StatusPill tone="neutral">Empty</StatusPill>}</div>
                    {byStyle(c.contents).map((g) => {
                      const l = idx[g.line_id];
                      return <div key={g.line_id} className="text-[12px] text-muted mt-1"><span className="text-ink-2 font-medium">{l ? lineTitle(l) : "A style no longer listed"}</span>{l?.description ? ` ${l.description}` : ""}: {g.sizes.map(([s, n]) => `${s} × ${n}`).join(" · ")}</div>;
                    })}
                    {c.notes && <div className="text-[12px] text-muted mt-1 italic">{c.notes}</div>}
                  </button>
                ))}
                {!cs.length && <p className="text-[12.5px] text-muted">Nothing on this pallet yet. Add each box as it goes on, or the loose items if there is no box.</p>}
                {live && ps && (ps.closed
                  ? <button onClick={() => savePallet(pallet, { closed: false })} className={WH_BTN_SECONDARY}>Reopen this pallet</button>
                  : asking != null
                    ? <div className={`${WH_CARD} p-3 flex flex-wrap items-end gap-2`}>
                        <label className="text-[12px] text-muted">Pallet {pallet} is full. Where does it stand?
                          <div className="w-56"><input autoFocus value={asking} maxLength={40} onChange={(e) => setAsking(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></div>
                        </label>
                        <button className={WH_BTN_PRIMARY} disabled={palletBusy} onClick={async () => {
                          const next = await savePallet(pallet, { location: asking, closed: true, startNext: true });
                          if (!next) return;
                          const open = (next.pallets ?? []).filter((x) => !x.closed).map((x) => x.pallet);
                          setAsking(null);
                          if (open.length) setPallet(Math.max(...open));
                          toast(`Pallet ${pallet} is full.${open.length ? ` Now on pallet ${Math.max(...open)}.` : ""}`);
                        }}>Save, start the next pallet</button>
                        <button className={WH_BTN_SECONDARY} onClick={() => setAsking(null)}>Cancel</button>
                      </div>
                    : <button onClick={() => setAsking(ps.location || "")} className={WH_BTN_SECONDARY}>Pallet full, start the next one</button>)}
                {live && ps && !cs.length && (
                  <button disabled={palletBusy} className={`${WH_BTN_SECONDARY} ml-2`} title="It is empty. Its number comes back the next time a pallet is started."
                    onClick={async () => { const n = pallet; if (await savePallet(n, { archived: true })) { setPallet(null); toast(`Pallet ${n} removed`); } }}>Remove this empty pallet</button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
    </PicCtx.Provider>
  );
}

// ---- A case being entered ----------------------------------------------------------------

function CaseEditor({ draft, setDraft, lines, idx, counts, cases, saved, onSave, onRemove, onClose, onNotListed }: {
  draft: Draft; setDraft: (d: Draft) => void; lines: LoadLine[]; idx: Record<string, LoadLine>; counts: Record<string, LineCount>; cases: WhCase[];
  saved: number[] | null; onSave: () => void; onRemove?: () => void; onClose: () => void; onNotListed: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sure, setSure] = useState(false);
  const hits = useMemo(() => (q.trim() ? lines.filter((l) => lineMatches(l, q)).slice(0, 20) : []), [q, lines]);
  const setBlock = (k: number, b: Block) => setDraft({ ...draft, blocks: draft.blocks.map((x, i) => (i === k ? b : x)) });
  const add = (id: string) => { if (!draft.blocks.some((b) => b.line_id === id)) setDraft({ ...draft, blocks: [...draft.blocks, { line_id: id, qty: {} }] }); setQ(""); };
  const recent = useMemo(() => cases.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 15), [cases]);
  const total = draftTotal(draft);

  return (
    <div className={`${WH_CARD} p-4`}>
      {saved && saved.length > 0 && <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 mb-3">
        <div className="text-[13px] font-medium text-success-ink">{saved.length === 1 ? `Case ${saved[0]}` : `Cases ${saved[0]} to ${saved[saved.length - 1]}`} saved on pallet {draft.pallet}</div>
        <div className="text-[12px] text-muted">The next case starts with the same pairs. Change what differs, or save it as it is.</div>
      </div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">{draft.kind === "loose" ? `Loose items on pallet ${draft.pallet}` : draft.id ? `Box ${draft.code || draft.number}` : "New box"}</div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-[12px] text-muted">Pallet<input value={draft.pallet} inputMode="numeric" onChange={(e) => setDraft({ ...draft, pallet: e.target.value.replace(/\D/g, "") })} style={WH_INPUT_BG} className={`${WH_INPUT} w-20 mt-1 tabular-nums`} /></label>
          {draft.id && draft.kind === "box" && <label className="text-[12px] text-muted">Code on the box<input value={draft.code ?? ""} maxLength={16} onChange={(e) => setDraft({ ...draft, code: e.target.value })} style={WH_INPUT_BG} className={`${WH_INPUT} w-28 mt-1`} /></label>}
          {!draft.id && draft.kind !== "loose" && <label className="text-[12px] text-muted">Boxes exactly like this<input value={draft.copies} inputMode="numeric" onChange={(e) => setDraft({ ...draft, copies: e.target.value.replace(/\D/g, "") })} style={WH_INPUT_BG} className={`${WH_INPUT} w-24 mt-1 tabular-nums`} /></label>}
          {!draft.id && recent.length > 0 && <label className="text-[12px] text-muted">Same as an earlier box
            <select value="" onChange={(e) => { const c = cases.find((x) => x.id === e.target.value); if (c) setDraft({ ...draft, blocks: blocksOf(c.contents) }); }} style={WH_INPUT_BG} className={`${WH_INPUT} w-56 mt-1`}>
              <option value="">Choose a case…</option>
              {recent.map((c) => <option key={c.id} value={c.id}>Pallet {c.pallet}, {c.kind === "loose" ? "loose items" : `box ${c.code || c.number}`}: {c.contents.reduce((a, x) => a + x.pairs, 0)} pairs</option>)}
            </select></label>}
        </div>
      </div>

      <div className="space-y-3 mt-4">
        {draft.blocks.map((b, k) => {
          const l = idx[b.line_id];
          if (!l) return null;
          const cnt = counts[l.id];
          const got = (s: string) => cnt?.sizes.find((x) => x.size === s)?.received ?? 0;
          const anyListed = l.sizes.some((s) => s.qty > 0);
          const shown = b.all || !anyListed ? l.sizes : l.sizes.filter((s) => s.qty > 0 || (b.qty[s.size] || 0) > 0 || got(s.size) > 0);
          const hidden = l.sizes.length - shown.length;
          return (
            <div key={b.line_id} className="rounded-lg border border-line p-3">
              <div className="flex justify-between gap-3">
                <div className="min-w-0 flex items-center gap-3"><Thumb l={l} size={64} zoom /><div className="min-w-0"><div className="text-[13px] font-semibold text-ink">{lineTitle(l)}</div><div className="text-[12px] text-muted truncate">{[l.brand, l.group, lineDesc(l)].filter(Boolean).join(" · ")}</div></div></div>
                <button onClick={() => setDraft({ ...draft, blocks: draft.blocks.filter((_, i) => i !== k) })} className="text-muted hover:text-ink-2 h-7 w-7 grid place-items-center" aria-label="Take this style out of the case"><X size={14} /></button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {shown.map((s) => (
                  <label key={s.size} className="w-[76px] text-center">
                    <span className="block text-[12px] font-medium text-ink-2">{s.size}</span>
                    <input value={b.qty[s.size] || ""} inputMode="numeric" placeholder="0" aria-label={`Pairs in size ${s.size}`}
                      onChange={(e) => setBlock(k, { ...b, qty: { ...b.qty, [s.size]: Math.max(0, parseInt(e.target.value.replace(/\D/g, ""), 10) || 0) } })}
                      style={WH_INPUT_BG} className={`${WH_INPUT} text-center tabular-nums mt-0.5 px-1`} />
                    <span className="block text-[11px] text-muted mt-0.5 tabular-nums">{s.qty ? `${n0(got(s.size))} of ${n0(s.qty)} in` : got(s.size) ? `${n0(got(s.size))} in` : "none listed"}</span>
                  </label>
                ))}
              </div>
              {hidden > 0 && <button onClick={() => setBlock(k, { ...b, all: true })} className="text-[12px] text-accent hover:underline mt-2">Sizes not on the manifest ({hidden})</button>}
            </div>
          );
        })}
      </div>

      <div className="relative mt-3 max-w-[560px]">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={draft.blocks.length ? "Another style: type a style, colour or name" : (draft.kind === "loose" ? "What is loose on the pallet" : "What is in the box") + ": type a style, colour or name"} style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        {q.trim() && <div className={`${WH_CARD} absolute z-10 left-0 right-0 mt-1 max-h-[420px] overflow-auto shadow-[0_8px_24px_rgba(0,0,0,0.12)]`}>
          {hits.map((l) => (
            <button key={l.id} onClick={() => add(l.id)} className="w-full text-left px-3 py-2 hover:bg-surface-2 border-b border-line last:border-b-0 flex items-center justify-between gap-3">
              <span className="min-w-0 flex items-center gap-3"><Thumb l={l} size={44} /><span className="min-w-0"><span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span><span className="block text-[12px] text-muted truncate">{[l.brand, l.group, lineDesc(l)].filter(Boolean).join(" · ")}</span></span></span>
              <span className="text-[12px] text-muted tabular-nums whitespace-nowrap">{n0(counts[l.id]?.received ?? 0)} of {n0(l.sizes.reduce((a, s) => a + s.qty, 0))}</span>
            </button>
          ))}
          {!hits.length && <div className="px-3 py-2 text-[12.5px] text-muted">Nothing on the manifest matches. <button onClick={() => onNotListed(q)} className="text-accent hover:underline">Add it as a style not on the manifest</button></div>}
        </div>}
      </div>

      <label className="block mt-3 max-w-[560px] text-[12px] text-muted">Note<input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional, for example the label on the case" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button onClick={onSave} disabled={!total && !(draft.id && draft.kind === "box")} className={WH_BTN_PRIMARY}>{draft.id ? "Save changes" : draft.kind === "loose" ? "Save loose items" : "Save box"}</button>
        <button onClick={onClose} className={WH_BTN_SECONDARY}>{draft.id || !saved ? "Cancel" : "Done"}</button>
        {onRemove && (sure ? <><button onClick={onRemove} className={WH_BTN_SECONDARY}>{draft.kind === "loose" ? "Remove these loose items" : `Remove box ${draft.number}`}</button><button onClick={() => setSure(false)} className={WH_BTN_SECONDARY}>Keep it</button></>
          : <button onClick={() => setSure(true)} className={WH_BTN_SECONDARY} title="Its pairs come off the received counts. The other boxes keep their numbers.">Remove</button>)}
        <span className="text-[12.5px] text-muted ml-auto tabular-nums">Pairs in this case: <span className="text-ink font-semibold">{n0(total)}</span></span>
      </div>
    </div>
  );
}

function NewLineForm({ lines, guess, onCancel, onAdd }: { lines: LoadLine[]; guess: string; onCancel: () => void; onAdd: (l: { brand: string; group: string; style: string; color: string; description: string; cost: number; msrp: number; sizes: string }) => void }) {
  const brands = useMemo(() => [...new Set(lines.map((l) => l.brand).filter(Boolean))], [lines]);
  const [f, setF] = useState({ brand: brands.length === 1 ? brands[0] : "", style: guess, color: "", description: "", sizes: "", cost: "", msrp: "" });
  const num = (s: string) => Number(s.replace(/[$,\s]/g, "")) || 0;
  const field = (k: keyof typeof f, label: string, ph = "", w = "") => (
    <label className={`text-[12px] text-muted ${w}`}>{label}<input value={f[k]} placeholder={ph} list={k === "brand" ? "r519-brands" : undefined} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>
  );
  return (
    <div className={`${WH_CARD} p-4 mb-4`}>
      <div className="text-[14px] font-semibold text-ink mb-2">A style not on the manifest</div>
      <datalist id="r519-brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {field("brand", "Brand")}{field("style", "Style")}{field("color", "Colour")}{field("description", "Name", "Optional")}
        {field("sizes", "Sizes", "For example 6, 7, 8, 9, 10", "col-span-2")}{field("cost", "Cost a pair", "Optional")}{field("msrp", "MSRP", "Optional")}
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => onAdd({ brand: f.brand, group: "", style: f.style, color: f.color, description: f.description, sizes: f.sizes, cost: num(f.cost), msrp: num(f.msrp) })} className={WH_BTN_PRIMARY}>Add it</button>
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
      </div>
    </div>
  );
}

// ---- Against the manifest ------------------------------------------------------------------

type Filter = "all" | "none" | "short" | "over" | "done";

function CheckView({ lines, counts, totals: T, pallets }: { lines: LoadLine[]; counts: Record<string, LineCount>; totals: LoadDetail["tally"]["totals"]; pallets: PalletView[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [openLine, setOpenLine] = useState<string | null>(null);
  const rows = useMemo(() => lines.filter((l) => {
    const c = counts[l.id];
    if (!c || !lineMatches(l, q)) return false;
    const s = lineStatus(c);
    if (filter === "none") return c.received === 0 && c.expected > 0;
    if (filter === "short") return s.short > 0 && c.received > 0;
    if (filter === "over") return s.over > 0;
    if (filter === "done") return s.short === 0 && s.over === 0 && c.received > 0;
    return true;
  }), [lines, counts, filter, q]);
  let head = "";
  return (
    <div>
      <div className={`${WH_CARD} p-4 mb-3`}>
        <div className="text-[14px] text-ink tabular-nums"><span className="font-semibold">{n0(T.received)}</span> of {n0(T.expected)} pairs in</div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-2"><div className="h-full rounded-full" style={{ ...BAR, width: `${T.expected > 0 ? Math.min(100, (T.received / T.expected) * 100) : 0}%` }} /></div>
        <div className="text-[12px] text-muted mt-2 tabular-nums">{n0(T.short)} pairs still to come, size by size{T.over ? ` · ${n0(T.over)} more than the manifest lists` : ""}</div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Seg value={filter} onChange={setFilter} options={[{ key: "all", label: "All" }, { key: "none", label: "Not in" }, { key: "short", label: "Short" }, { key: "over", label: "Over" }, { key: "done", label: "All in" }]} />
        <div className="relative w-[320px] max-w-full">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a style, colour or name" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        </div>
        <span className="text-[12px] text-muted">{many(rows.length, "style", "styles")}</span>
      </div>
      <div className={`${WH_CARD} overflow-hidden`}>
        {rows.map((l) => {
          const c = counts[l.id], s = lineStatus(c);
          const h = l.brand + (l.group ? ` · ${l.group}` : "");
          const showHead = h !== head; head = h;
          const open = openLine === l.id;
          return (
            <div key={l.id}>
              {showHead && <div className="px-4 py-2 text-[12px] font-semibold text-ink-2 bg-surface-2 border-b border-line">{h}</div>}
              <button onClick={() => setOpenLine(open ? null : l.id)} className="w-full text-left px-4 py-2.5 border-b border-line hover:bg-surface-2/60 transition-colors">
                <div className="flex items-center gap-3">
                  <Thumb l={l} size={36} />
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span>
                    <span className="text-[12px] text-muted"> {lineDesc(l)}{c.pallets.length ? ` · ${palletNames(c.pallets, pallets)}` : ""}</span>
                  </div>
                  <span className="text-[12.5px] text-muted tabular-nums whitespace-nowrap"><span className="text-ink font-medium">{n0(c.received)}</span> of {n0(c.expected)}</span>
                  <span className="w-[150px] flex justify-end">
                    {c.received === 0 && c.expected > 0 ? <StatusPill tone="neutral">Not in yet</StatusPill>
                      : s.short > 0 ? <StatusPill tone="warning">Short {n0(s.short)}{s.over ? `, over ${n0(s.over)}` : ""}</StatusPill>
                      : s.over > 0 ? <StatusPill tone="accent">Over {n0(s.over)}</StatusPill>
                      : <StatusPill tone="success">All in</StatusPill>}
                  </span>
                </div>
                {open && <div className="flex flex-wrap items-start gap-1.5 mt-2">
                  <Thumb l={l} size={120} zoom />
                  {c.sizes.filter((z) => z.expected || z.received).map((z) => (
                    <span key={z.size} className={`w-[64px] rounded-md px-1 py-1 text-center bg-surface-2 ${z.received < z.expected ? "ring-1 ring-warning/50" : z.received > z.expected ? "ring-1 ring-accent/50" : ""}`}>
                      <span className="block text-[11px] text-muted">{z.size}</span>
                      <span className="block text-[13px] font-semibold text-ink tabular-nums">{n0(z.received)}</span>
                      <span className="block text-[11px] text-muted tabular-nums">of {n0(z.expected)}</span>
                    </span>
                  ))}
                </div>}
                {open && rowsText(l) && <div className="text-[11.5px] text-muted mt-1.5 tabular-nums">From {rowsText(l)}</div>}
              </button>
            </div>
          );
        })}
        {!rows.length && <div className="px-4 py-6 text-[13px] text-muted text-center">Nothing here.</div>}
      </div>
    </div>
  );
}

// ---- Sell (R-519 phase 2): pick by brand and group, price per pair, send to an invoice -----
// What is left comes from case_core::stock. The pick is a draft kept on this device until its
// invoice exists; the invoice form then takes the pairs (take_load_pairs). The phone twin is
// whdSell* in www/app.js.

/** R-554: a pick list, pallet by pallet in the order they stand. A tick only says you have it: it is kept on this computer. */
function PickListView({ plan, title, tickKey, loadId, lines, backLabel, onBack }: {
  plan: PickPlan; title: string; tickKey: string; loadId: string; lines: LoadLine[]; backLabel: string; onBack: () => void;
}) {
  const store = `warehouse_pick_ticks:${loadId}`;
  const [ticks, setTicks] = useState<string[]>(() => { const v = readJson<{ key?: string; ids?: string[] }>(store, {}); return v.key === tickKey && Array.isArray(v.ids) ? v.ids : []; });
  const toggle = (id: string) => {
    const next = ticks.includes(id) ? ticks.filter((x) => x !== id) : [...ticks, id];
    setTicks(next);
    try { localStorage.setItem(store, JSON.stringify({ key: tickKey, ids: next })); } catch { /* ignore */ }
  };
  const idx = useMemo(() => Object.fromEntries(lines.map((l) => [l.id, l])) as Record<string, LoadLine>, [lines]);
  const name = (id: string) => (idx[id] ? lineTitle(idx[id]) : "A style no longer listed");
  const groups: { pallet: number; location: string; boxes: PickPlan["boxes"] }[] = [];
  for (const b of plan.boxes) {
    let g = groups.find((x) => x.pallet === b.pallet);
    if (!g) { g = { pallet: b.pallet, location: b.location, boxes: [] }; groups.push(g); }
    g.boxes.push(b);
  }
  const nBoxes = plan.boxes.filter((b) => !b.loose).length;
  const left = plan.short.filter((x) => x.asked > x.taken);
  return (
    <div className="max-w-[760px]">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={13} /> {backLabel}</button>
      <div className={`${WH_CARD} p-4 mb-4`}>
        <div className="text-[15px] font-semibold text-ink">{title}</div>
        <p className="text-[12.5px] text-muted mt-0.5 tabular-nums">{many(plan.pallets, "pallet", "pallets")}, {many(nBoxes, "box", "boxes")}, {n0(plan.pairs)} {plan.pairs === 1 ? "pair" : "pairs"}. Click a box when you have it.</p>
        {plan.boxes.some((b) => b.assumed) && <p className="text-[12.5px] text-warning-ink mt-1">Some boxes say Count this box first: an older sale took pairs without saying from which box, so what is in them is a guess.</p>}
      </div>
      {groups.map((g) => (
        <div key={g.pallet} className="mb-4">
          <div className="text-[13.5px] font-semibold text-ink mb-1.5">Go to {g.location || `pallet ${g.pallet}`}{g.location && <span className="font-normal text-muted"> pallet {g.pallet}</span>}</div>
          <div className={`${WH_CARD} overflow-hidden`}>
            {g.boxes.map((b) => {
              const on = ticks.includes(b.case_id);
              return (
                <button key={b.case_id} onClick={() => toggle(b.case_id)} aria-pressed={on} className="w-full text-left flex gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface-2 transition-colors">
                  <span className={`mt-0.5 w-5 h-5 rounded-md border-2 flex-shrink-0 ${on ? "bg-success border-success" : "border-line-3"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between items-baseline gap-3">
                      <span className={`text-[13.5px] font-semibold ${on ? "text-muted line-through" : "text-ink"}`}>{b.loose ? "Loose items" : `Box ${b.code || b.number}`}</span>
                      <span className="text-[13px] font-semibold text-ink whitespace-nowrap">{b.whole ? "Take the whole box" : b.loose ? `Take ${n0(b.pairs)}` : `Open it, take ${n0(b.pairs)}`}</span>
                    </span>
                    {byStyle(b.takes).map((s) => <span key={s.line_id} className="block text-[12px] text-muted mt-0.5"><span className="text-ink-2 font-medium">{name(s.line_id)}</span>: {s.sizes.map(([z, n]) => `${z} × ${n}`).join(" · ")}</span>)}
                    {b.assumed && <span className="block mt-1"><StatusPill tone="warning">Count this box first</StatusPill></span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {left.length > 0 && (
        <div className={`${WH_CARD} p-4 mb-4`}>
          <div className="text-[13.5px] font-semibold text-ink">Not on any box</div>
          <p className="text-[12px] text-muted mt-0.5">These pairs were sold since, are not in a box yet, or never came in.</p>
          {left.map((x) => <div key={`${x.line_id}/${x.size}`} className="text-[12.5px] text-muted mt-1"><span className="text-ink-2 font-medium">{name(x.line_id)}</span> size {x.size}: {n0(x.asked - x.taken)} of {n0(x.asked)} not found</div>)}
        </div>
      )}
      {plan.unnamed.length > 0 && (
        <div className={`${WH_CARD} p-4 mb-4`}>
          <div className="text-[13.5px] font-semibold text-ink">Taken before boxes were tracked</div>
          {byStyle(plan.unnamed).map((s) => <div key={s.line_id} className="text-[12.5px] text-muted mt-1"><span className="text-ink-2 font-medium">{name(s.line_id)}</span>: {s.sizes.map(([z, n]) => `${z} × ${n}`).join(" · ")}</div>)}
          <p className="text-[12px] text-muted mt-1">This order did not say which boxes these came from.</p>
        </div>
      )}
      {!plan.boxes.length && !left.length && !plan.unnamed.length && <p className="text-[13px] text-muted">Nothing to pick.</p>}
    </div>
  );
}

function readJson<T>(key: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; } catch { return fallback; }
}

function SellView({ d, lines, merge, live }: { d: LoadDetail; lines: LoadLine[]; merge: (d: LoadDetail) => void; live: boolean }) {
  const loadId = d.load.id;
  const left = useMemo(() => Object.fromEntries(d.stock.lines.map((l) => [l.line_id, l])) as Record<string, LineLeft>, [d.stock.lines]);
  const leftOf = useCallback((lid: string, size: string) => left[lid]?.sizes.find((z) => z.size === size)?.left ?? 0, [left]);
  const [pick, setPickRaw] = useState<Pick>(() => readJson<Pick>(pickKey(loadId), {}));
  const [tray, setTray] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [pct, setPct] = useState("");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [group, setGroup] = useState("");
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [sureClear, setSureClear] = useState(false);
  const [sureUndo, setSureUndo] = useState<string | null>(null);
  type Pending = { invoice_id: string; reference: string; takes: CaseLine[] };
  const [pendingAll, setPendingAll] = useState<Pending[]>(() => { const v = readJson<unknown>(pendingTakeKey(loadId), []); return Array.isArray(v) ? (v as Pending[]).filter((x) => x && x.invoice_id && Array.isArray(x.takes)) : []; });
  const pending = pendingAll[0] ?? null;
  const dropPending = (invoiceId: string) => {
    const rest = pendingAll.filter((x) => x.invoice_id !== invoiceId);
    setPendingAll(rest);
    try { if (rest.length) localStorage.setItem(pendingTakeKey(loadId), JSON.stringify(rest)); else localStorage.removeItem(pendingTakeKey(loadId)); } catch { /* ignore */ }
  };
  const [sureDrop, setSureDrop] = useState(false);
  const setPick = (p: Pick) => { setPickRaw(p); try { localStorage.setItem(pickKey(loadId), JSON.stringify(p)); } catch { /* ignore */ } };
  // R-554: where to pick, box by box (case_core::allocate); the order records the same boxes.
  const [pickList, setPickList] = useState<{ plan: PickPlan; title: string; key: string; from: "list" | "tray" } | null>(null);
  const openPickList = async (outId?: string) => {
    try {
      if (outId) {
        const o = d.outs.find((x) => x.id === outId);
        setPickList({ plan: await api.loadOutPick(loadId, outId), title: `Pick list for ${o?.reference || "this order"}`, key: `out:${outId}`, from: tray ? "tray" : "list" });
      } else {
        const takes: CaseLine[] = Object.entries(pick).flatMap(([lid, sizes]) => Object.entries(sizes).filter(([, n]) => n > 0).map(([size, pairs]) => ({ line_id: lid, size, pairs })));
        setPickList({ plan: await api.planLoadPick(loadId, takes), title: "Where to pick", key: `pick:${takes.map((t) => `${t.line_id}/${t.size}/${t.pairs}`).sort().join("|")}`, from: tray ? "tray" : "list" });
      }
      setTray(false);
    } catch (e) { toast(String(e), "error"); }
  };

  // R-565: a pick may ask for more than the boxes hold (cases not recorded yet). What no box
  // holds is sold all the same and shows as not in a box yet until its cases go in.
  const [everyStyle, setEveryStyle] = useState(false);
  const setSize = (lid: string, size: string, n: number) => {
    const v = Math.max(0, Math.min(1_000_000, Math.floor(n) || 0));
    const sizes = { ...(pick[lid] || {}) };
    if (v > 0) sizes[size] = v; else delete sizes[size];
    const next = { ...pick };
    if (Object.keys(sizes).length) next[lid] = sizes; else delete next[lid];
    setPick(next);
  };
  const allLeft = (p: Pick, lid: string) => {
    const l = left[lid];
    if (!l) return p;
    const sizes: Record<string, number> = {};
    for (const z of l.sizes) if (z.left > 0) sizes[z.size] = z.left;
    const next = { ...p };
    if (Object.keys(sizes).length) next[lid] = sizes; else delete next[lid];
    return next;
  };
  const pickedOf = (lid: string) => Object.values(pick[lid] || {}).reduce((a, b) => a + b, 0);
  const matches = (l: LoadLine) => (!brand || l.brand === brand) && (!group || l.group === group) && lineMatches(l, q);
  const shown = lines.filter((l) => (everyStyle || (left[l.id]?.left ?? 0) > 0 || pickedOf(l.id) > 0) && matches(l));
  const withLeft = everyStyle ? lines : lines.filter((l) => (left[l.id]?.left ?? 0) > 0);
  const brands = [...new Set(withLeft.map((l) => l.brand).filter(Boolean))];
  const groups = [...new Set(withLeft.filter((l) => !brand || l.brand === brand).map((l) => l.group).filter(Boolean))];
  const bs = buckets(lines, pick);
  const totalPairs = bs.reduce((a, b) => a + b.pairs, 0), totalStyles = bs.reduce((a, b) => a + b.styles, 0);
  const rateOf = (b: Bucket) => { const v = Number(String(rates[b.key] ?? "").replace(/[$,\s]/g, "")); return v > 0 ? Math.round(v * 100) / 100 : 0; };
  const orderTotal = bs.reduce((a, b) => a + Math.round(b.pairs * rateOf(b) * 100) / 100, 0);
  const orderCost = bs.reduce((a, b) => a + b.cost, 0);
  const ready = bs.length > 0 && bs.every((b) => rateOf(b) > 0);
  const pastBoxes = Object.entries(pick).reduce((a, [lid, sizes]) => a + Object.entries(sizes).reduce((b, [z, n]) => b + Math.max(0, n - leftOf(lid, z)), 0), 0);

  // R-565: an invoice made outside this tab is linked here, by its pair count or by the pick.
  // Its pairs leave the delivery, and the delivery's buy writes its cost share on the invoice's deal.
  const [linking, setLinking] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [linkId, setLinkId] = useState("");
  const [linkPairs, setLinkPairs] = useState("");
  const [linkBy, setLinkBy] = useState<"count" | "pick">("count");
  const [linkBusy, setLinkBusy] = useState(false);
  const linked = new Set(d.outs.filter((o) => !o.undone && o.invoice_id).map((o) => o.invoice_id));
  const linkable = invoices.filter((i) => !i.voided && !linked.has(i.id)).sort((a, b) => (b.issue_date || "").localeCompare(a.issue_date || ""));
  const pairsOn = (i: Invoice) => parseLineItems(i.line_items_json).filter((it) => !isNoiseItem(it.description || "")).reduce((a, it) => a + Math.max(0, Math.round(Number(it.qty) || 0)), 0);
  const openLink = async () => {
    setLinking(true); setLinkId(""); setLinkPairs(""); setLinkBy(totalPairs > 0 ? "pick" : "count");
    try { setInvoices(await api.listInvoices()); } catch (e) { toast(String(e), "error"); }
  };
  const linkCount = Math.max(0, Math.floor(Number(linkPairs.replace(/[,\s]/g, "")) || 0));
  const linkReady = !!linkId && (linkBy === "pick" ? totalPairs > 0 : linkCount > 0);
  const link = async () => {
    const inv = linkable.find((i) => i.id === linkId);
    if (!inv || !linkReady) return;
    setLinkBusy(true);
    try {
      const takes: CaseLine[] = linkBy === "pick" ? Object.entries(pick).flatMap(([lid, sizes]) => Object.entries(sizes).filter(([, n]) => n > 0).map(([size, pairs]) => ({ line_id: lid, size, pairs }))) : [];
      const pairs = linkBy === "pick" ? totalPairs : linkCount;
      merge(await api.takeLoadPairs(loadId, { invoiceId: inv.id, reference: inv.number, note: "Linked", takes, over: true, pairs: linkBy === "count" ? linkCount : undefined }));
      if (linkBy === "pick") setPick({});
      setLinking(false);
      const buy = await api.warehouseBuyFor({ loadId }).then((r) => r.buy).catch(() => null);
      if (!buy) { toast(`${inv.number} linked: ${n0(pairs)} pairs off this delivery. No buy is recorded on this delivery, so no cost went on the deal. Record it on the Buy tab.`, "error"); return; }
      // The buy's missing orders: a deal that already carries a cost typed by hand keeps it.
      await api.addMissingWarehouseBuyOrders(buy.id)
        .then(() => toast(`${inv.number} linked: ${n0(pairs)} pairs off this delivery, its cost from ${buy.name} written on the deal.`))
        .catch((e: any) => toast(`${inv.number} linked, but its cost did not reach the deal (${e}). The Buy tab can add it.`, "error"));
    } catch (e) { toast(String(e), "error"); }
    finally { setLinkBusy(false); }
  };

  const send = () => {
    if (!ready) { toast("Give every line a price per pair.", "error"); return; }
    const prefill: InvoicePrefill = {
      lines: bs.map((b) => { const rate = rateOf(b); return { description: bucketLine(b), qty: b.pairs, rate, amount: Math.round(b.pairs * rate * 100) / 100, dl: { takes: b.takes, cost: b.cost } }; }),
      delivery: { load_id: loadId, load_name: d.load.name },
    };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };
  const finishPending = async () => {
    if (!pending) return;
    try {
      merge(await api.takeLoadPairs(loadId, { invoiceId: pending.invoice_id, reference: pending.reference, note: "Invoiced", takes: pending.takes, over: true }));
      dropPending(pending.invoice_id);
      toast("Done: the pairs left the delivery");
    } catch (e) { toast(String(e), "error"); }
  };
  const undo = async (o: LoadOut) => {
    try { merge(await api.undoLoadOut(loadId, o.id)); setSureUndo(null); toast("Put back"); } catch (e) { toast(String(e), "error"); }
  };

  if (pickList) return <PickListView plan={pickList.plan} title={pickList.title} tickKey={pickList.key} loadId={loadId} lines={lines}
    backLabel={pickList.from === "tray" ? "Price the order" : "Back to picking"} onBack={() => { setTray(pickList.from === "tray"); setPickList(null); }} />;

  if (tray) {
    return (
      <div className="max-w-[760px]">
        <div className={`${WH_CARD} p-4 mb-3`}>
          <div className="text-[15px] font-semibold text-ink">Price the order</div>
          <p className="text-[12.5px] text-muted mt-0.5">{n0(totalPairs)} pairs, {many(totalStyles, "style", "styles")}. One invoice line for each brand and group, priced per pair.</p>
          <label className="block mt-3 text-[12px] text-muted w-[220px]">% of MSRP for every line
            <input value={pct} inputMode="decimal" placeholder="Optional, e.g. 20" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}
              onChange={(e) => {
                setPct(e.target.value);
                const p = Number(e.target.value.replace(/[%\s]/g, ""));
                if (p > 0) setRates(Object.fromEntries(bs.map((b) => { const r = pctRate(b, p); return [b.key, r > 0 ? r.toFixed(2) : ""]; })));
              }} />
          </label>
        </div>
        <div className={`${WH_CARD} overflow-hidden`}>
          {bs.map((b) => (
            <div key={b.key} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-ink">{bucketName(b)}</div>
                <div className="text-[12px] text-muted tabular-nums">{n0(b.pairs)} pairs, {many(b.styles, "style", "styles")} · cost {money(b.cost)} · MSRP {money(b.msrp)}</div>
              </div>
              <label className="text-[12px] text-muted">Price a pair
                <input value={rates[b.key] ?? ""} inputMode="decimal" placeholder="0.00" style={WH_INPUT_BG} className={`${WH_INPUT} w-28 mt-1 tabular-nums`}
                  onChange={(e) => setRates({ ...rates, [b.key]: e.target.value })} />
              </label>
              <div className="w-28 text-right text-[13px] font-semibold text-ink tabular-nums">{money(Math.round(b.pairs * rateOf(b) * 100) / 100)}</div>
            </div>
          ))}
        </div>
        <div className={`${WH_CARD} p-4 mt-3`}>
          <div className="flex justify-between text-[13.5px]"><span className="text-ink-2">Order total</span><span className="font-semibold text-ink tabular-nums">{money(orderTotal)}</span></div>
          <div className="flex justify-between text-[12.5px] text-muted mt-1"><span>What the pairs cost</span><span className="tabular-nums">{money(orderCost)}</span></div>
          {orderTotal > 0 && orderTotal < orderCost && <p className="text-[12.5px] text-warning-ink mt-1">This order is {money(Math.round((orderCost - orderTotal) * 100) / 100)} below what the pairs cost.</p>}
          <p className="text-[12px] text-muted mt-2">The cost is shown so you can enter it in Deal Flow. Pairs leave this delivery only when the invoice is created.</p>
          <div className="flex gap-2 mt-3">
            <button onClick={send} disabled={!ready} className={WH_BTN_PRIMARY}>Send to invoice</button>
            <button onClick={() => setTray(false)} className={WH_BTN_SECONDARY}>Back to picking</button>
            <button onClick={() => { void openPickList(); }} className={WH_BTN_SECONDARY}>Where to pick</button>
          </div>
        </div>
      </div>
    );
  }

  if (!live) return (
    <div>
      <p className="text-[12.5px] text-muted mb-3">{d.load.archived ? "This delivery was removed. Bring it back to sell from it." : "Selling needs the Inventory edit permission."}</p>
    </div>
  );

  let head = "";
  return (
    <div>
      {pending && (
        <div className={`${WH_CARD} p-4 mb-3 border-warning/40`}>
          <div className="text-[13.5px] font-semibold text-ink">Invoice {pending.reference} is saved, its pairs have not left yet</div>
          <p className="text-[12.5px] text-muted mt-0.5">The call failed after the invoice was created. Finish it so the {n0(pending.takes.reduce((a, x) => a + x.pairs, 0))} pairs come off this delivery.</p>
          <div className="flex gap-2 mt-2">
            <button onClick={finishPending} className={WH_BTN_PRIMARY}>Take them out now</button>
            {sureDrop
              ? <><button onClick={() => { dropPending(pending.invoice_id); setSureDrop(false); }} className={WH_BTN_SECONDARY} title="The invoice stays. Its pairs stay counted as on this delivery.">Discard it</button><button onClick={() => setSureDrop(false)} className={WH_BTN_SECONDARY}>Keep it</button></>
              : <button onClick={() => setSureDrop(true)} className={WH_BTN_SECONDARY}>Discard</button>}
          </div>
        </div>
      )}
      <div className={`${WH_CARD} p-3.5 mb-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-10`}>
        <div>
          <div className="text-[14px] text-ink tabular-nums"><span className="font-semibold">{n0(totalPairs)}</span> pairs picked <span className="text-muted text-[12.5px]">· {many(totalStyles, "style", "styles")}</span></div>
          <div className="text-[12px] text-muted tabular-nums">{n0(d.stock.left)} of {n0(d.stock.received)} pairs in boxes left to sell{d.stock.unnamed > 0 ? ` · ${n0(d.stock.unnamed)} sold with no style named` : ""}</div>
          {pastBoxes > 0 && <div className="text-[12px] text-muted tabular-nums">{n0(pastBoxes)} of the picked pairs are not in a box yet</div>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => { void openLink(); }} disabled={!!pending} className={WH_BTN_SECONDARY}>Link an invoice</button>
          {totalPairs > 0 && (sureClear
            ? <><button onClick={() => { setPick({}); setSureClear(false); }} className={WH_BTN_SECONDARY}>Clear the pick</button><button onClick={() => setSureClear(false)} className={WH_BTN_SECONDARY}>Keep it</button></>
            : <button onClick={() => setSureClear(true)} className={WH_BTN_SECONDARY}>Clear</button>)}
          <button onClick={() => { void openPickList(); }} disabled={!totalPairs} className={WH_BTN_SECONDARY}>Where to pick</button>
          <button onClick={() => setTray(true)} disabled={!totalPairs || !live || !!pending} className={WH_BTN_PRIMARY} title={pending ? "Finish the saved invoice above first" : undefined}>Price it</button>
        </div>
      </div>
      {linking && (
        <div className={`${WH_CARD} p-4 mb-3`}>
          <div className="text-[14px] font-semibold text-ink">Link an invoice to this delivery</div>
          <p className="text-[12.5px] text-muted mt-0.5">For an invoice made outside this tab. Its pairs come off this delivery, even past what is in boxes, and the delivery's buy puts its cost on the invoice's deal. The invoice itself is not changed.</p>
          <label className="block mt-3 text-[12px] text-muted max-w-[460px]">Invoice
            <select value={linkId} onChange={(e) => { setLinkId(e.target.value); const i = linkable.find((x) => x.id === e.target.value); if (i) setLinkPairs(String(pairsOn(i) || "")); }} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}>
              <option value="">Choose an invoice</option>
              {linkable.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.issue_date} · {money(i.total)}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-4 mt-3 text-[13px] text-ink-2">
            <label className="flex items-center gap-2"><input type="radio" checked={linkBy === "count"} onChange={() => setLinkBy("count")} /> By the pair count</label>
            <label className={`flex items-center gap-2 ${totalPairs ? "" : "text-faint"}`}><input type="radio" checked={linkBy === "pick"} disabled={!totalPairs} onChange={() => setLinkBy("pick")} /> The styles I picked ({n0(totalPairs)} pairs)</label>
          </div>
          {linkBy === "count" && (
            <label className="block mt-2 text-[12px] text-muted w-[200px]">Pairs on the invoice
              <input value={linkPairs} onChange={(e) => setLinkPairs(e.target.value)} inputMode="numeric" placeholder="0" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} />
            </label>
          )}
          {linkBy === "count" && <p className="text-[12px] text-muted mt-1">No style is named, so the delivery's total goes down but no one style does.</p>}
          <div className="flex gap-2 mt-3">
            <button onClick={() => { void link(); }} disabled={!linkReady || linkBusy} className={WH_BTN_PRIMARY}>{linkBusy ? "Linking" : "Link it"}</button>
            <button onClick={() => setLinking(false)} className={WH_BTN_SECONDARY}>Cancel</button>
          </div>
        </div>
      )}
      {d.stock.not_boxed > 0 && <p className="text-[12.5px] text-muted mb-3">{n0(d.stock.not_boxed)} pairs are sold but not in a box yet. They come off as their cases are recorded.</p>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative w-[300px] max-w-full">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a style, colour or name" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        </div>
        {brands.length > 1 && <div className="w-48"><select value={brand} onChange={(e) => { setBrand(e.target.value); setGroup(""); }} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Brand">
          <option value="">Every brand</option>{brands.map((b) => <option key={b} value={b}>{b}</option>)}</select></div>}
        {groups.length > 1 && <div className="w-44"><select value={group} onChange={(e) => setGroup(e.target.value)} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Group">
          <option value="">Every group</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select></div>}
        <span className="flex items-center gap-2 text-[12.5px] text-ink-2"><Switch on={everyStyle} onToggle={() => setEveryStyle(!everyStyle)} label="Show styles not in a box yet" /> Styles not in a box yet</span>
      </div>
      <div className={`${WH_CARD} overflow-hidden`}>
        {shown.map((l) => {
          const h = `${l.brand}\u0001${l.group}`;
          const showHead = h !== head; head = h;
          const ll = left[l.id];
          const picked = pickedOf(l.id);
          const open = openLine === l.id;
          const groupLeft = showHead ? shown.filter((x) => x.brand === l.brand && x.group === l.group).reduce((a, x) => a + (left[x.id]?.left ?? 0), 0) : 0;
          return (
            <div key={l.id}>
              {showHead && (
                <div className="flex items-center justify-between gap-3 px-4 py-2 bg-surface-2 border-b border-line">
                  <span className="text-[12.5px] font-semibold text-ink-2">{[l.brand, l.group].filter(Boolean).join(" · ")} <span className="font-normal text-muted">· {n0(groupLeft)} left</span></span>
                  {live && <button onClick={() => setPick(shown.filter((x) => x.brand === l.brand && x.group === l.group).reduce((p, x) => allLeft(p, x.id), pick))} className="text-[12.5px] text-accent hover:underline">Take all</button>}
                </div>
              )}
              <div className="px-4 py-2.5 border-b border-line">
                <button onClick={() => setOpenLine(open ? null : l.id)} className="w-full text-left flex items-center gap-3">
                  <Thumb l={l} size={36} />
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span>
                    <span className="text-[12px] text-muted"> {lineDesc(l)}{ll?.pallets.length ? ` · ${palletNames(ll.pallets, d.pallets ?? [])}` : ""}</span>
                  </div>
                  <span className="text-[12.5px] text-muted tabular-nums whitespace-nowrap"><span className="text-ink font-medium">{n0(ll?.left ?? 0)}</span> left</span>
                  <span className="w-[100px] flex justify-end">{picked > 0 && <StatusPill tone="success">{n0(picked)} picked</StatusPill>}</span>
                </button>
                {open && ll && (
                  <div className="mt-2">
                    <div className="flex flex-wrap items-start gap-2">
                      <Thumb l={l} size={120} zoom />
                      {ll.sizes.filter((z) => everyStyle || z.left > 0 || (pick[l.id]?.[z.size] ?? 0) > 0).map((z) => (
                        <label key={z.size} className="w-[76px] text-center">
                          <span className="block text-[12px] font-medium text-ink-2">{z.size}</span>
                          <input value={pick[l.id]?.[z.size] || ""} inputMode="numeric" placeholder="0" aria-label={`Pairs of size ${z.size}`} disabled={!live}
                            onChange={(e) => setSize(l.id, z.size, parseInt(e.target.value.replace(/\D/g, ""), 10) || 0)}
                            style={WH_INPUT_BG} className={`${WH_INPUT} text-center tabular-nums mt-0.5 px-1`} />
                          <span className="block text-[11px] text-muted mt-0.5 tabular-nums">{n0(z.left)} left</span>
                          {(pick[l.id]?.[z.size] ?? 0) > z.left && <span className="block text-[11px] text-muted tabular-nums">{n0((pick[l.id]?.[z.size] ?? 0) - z.left)} not boxed</span>}
                        </label>
                      ))}
                    </div>
                    {live && <div className="flex gap-3 mt-2">
                      <button onClick={() => setPick(allLeft(pick, l.id))} className="text-[12.5px] text-accent hover:underline">All left</button>
                      {picked > 0 && <button onClick={() => { const next = { ...pick }; delete next[l.id]; setPick(next); }} className="text-[12.5px] text-muted hover:text-ink-2">Clear</button>}
                    </div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!shown.length && <div className="px-4 py-6 text-[13px] text-muted text-center">Nothing left in boxes here. Clear the filters, or show the styles not in a box yet.</div>}
      </div>

      {d.outs.length > 0 && <>
        <div className="text-[13px] font-semibold text-ink mt-5 mb-2">Sold from this delivery</div>
        <div className={`${WH_CARD} overflow-hidden`}>
          {d.outs.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-ink">{o.reference || "Taken out"}</span>
                <span className="text-[12px] text-muted tabular-nums"> · {n0(o.pairs)} pairs · {o.takes.length ? `${money(o.cost)} cost` : "styles not named"} · {new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </div>
              {o.undone ? <StatusPill tone="neutral">Back on the delivery</StatusPill>
                : o.invoice_state === "voided" ? <StatusPill tone="warning">Invoice voided, pairs still out</StatusPill>
                : o.invoice_state === "removed" || o.invoice_state === "gone" ? <StatusPill tone="warning">Invoice removed, pairs still out</StatusPill> : null}
              {live && !o.undone && (sureUndo === o.id
                ? <><button onClick={() => undo(o)} className={WH_BTN_SECONDARY} title="The pairs count as on this delivery again. The invoice is not changed.">Put {n0(o.pairs)} pairs back</button><button onClick={() => setSureUndo(null)} className={WH_BTN_SECONDARY}>Keep them out</button></>
                : <button onClick={() => setSureUndo(o.id)} className={WH_BTN_SECONDARY}>Put back</button>)}
              {!o.undone && o.takes.length > 0 && <button onClick={() => { void openPickList(o.id); }} className={WH_BTN_SECONDARY}>Pick list</button>}
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}
