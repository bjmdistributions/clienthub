// One warehouse product (R-326..R-329), as four tasks rather than one long page:
//   On the shelf  — the counts by team and box size, edited in place ("Update counts").
//   Pick an order — what was actually pulled: boxes of each size from each team, a sale
//                   price, then an invoice or a take-out. The main way stock leaves.
//   Plan a load   — the packer (planUnits): how much, and how it spreads across the teams
//                   (R-334's lean), sent as it is or opened in Pick an order to adjust.
//   Pallets       — the pallet and each box size measured; what fits, in 3D (R-346).
//   History       — every move, with Put back.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Archive, ArchiveRestore, Check, FileText, MoreHorizontal, Pencil, Search, SlidersHorizontal, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  FILL_SHORT, INVOICE_PREFILL_KEY, LEAN_STOPS, bigBox, boxesLeaving, buildKey, buildLot, builtUnits, countCheck, describePick, emptyPick, invoiceLines, itemTotals, looseRoom,
  matchToPallets,
  pickFromPlan, pickUnits, placesHolding, planUnits, sectionBoxes, sectionUnits, takeFromPlaces, type BuildState, type GrabLine, type LooseGrab, type PickPlan,
  type WarehouseLayout,
  setPicked, shares, type BoxType, type HandPick, type InvoicePrefill, type WarehouseItem, type WhMove, type WhSection,
} from "../lib/warehouse";
import { toast } from "./Toast";
import PalletsTab from "./WarehousePallets";
import { feet, fitTypes, inches, readyFor, type FitPallet } from "../lib/palletFit";

const PalletView3D = lazy(() => import("./PalletView3D"));
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, plural, teamColor } from "./warehouseUi";

const BAR = { background: "rgb(var(--c-chart-1))" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
type Tab = "shelf" | "pick" | "plan" | "pallets" | "history";

/**
 * Where a team's boxes are on the maps (R-339, R-340). With boxes recorded on its pallets, the
 * exact boxes off each, part pallets first — the same places the pick will take them off; with
 * none recorded, the places marked with the team, part-full first.
 */
function WhereFrom({ item, layouts, sectionId, take }: { item: WarehouseItem; layouts: WarehouseLayout[]; sectionId: string; take: Record<string, number> }) {
  const places = placesHolding(layouts, item.id, sectionId);
  if (!places.length) return null;
  const exact = takeFromPlaces(layouts, item.id, sectionId, take);
  const wanted = Object.values(take).reduce((a, b) => a + b, 0);
  const found = exact.reduce((a, x) => a + Object.values(x.boxes).reduce((p, q) => p + q, 0), 0);
  const text = exact.length
    ? `From ${exact.map((x) => `${x.name}: ${describePick(item.box_types, x.boxes, 0)}`).join(" · ")}${found < wanted ? ` · ${n0(wanted - found)} more ${wanted - found === 1 ? "box" : "boxes"} not on a counted pallet` : ""}`
    : `On the map: ${places.slice(0, 4).map((p) => `${p.name}${p.fill === 0 ? " (empty)" : p.fill < 4 ? ` (${FILL_SHORT[p.fill]})` : ""}`).join(", ")}${places.length > 4 ? `, +${places.length - 4} more` : ""}`;
  return <div className="text-[11.5px] text-muted leading-snug line-clamp-2" title={text}>{text}</div>;
}

/** The maps, kept fresh — a pick changes the boxes on their pallets. */
function useLayouts(stamp: string) {
  const [layouts, setLayouts] = useState<WarehouseLayout[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.listWarehouseLayouts().then((l) => { if (alive) setLayouts(l); }).catch(() => {});
    load();
    let un: (() => void) | undefined;
    listen("netsync-applied", load).then((u) => { un = u; }).catch(() => {});
    return () => { alive = false; un?.(); };
  }, [stamp]);
  return layouts;
}

// R-334: how a load spreads across the teams, remembered on this computer. Matching the stock
// is the default: every team is in the load, the bigger ones give more.
const LEAN_KEY = "warehouse_lean";
function readLean(): number {
  try { const v = Number(localStorage.getItem(LEAN_KEY)); return localStorage.getItem(LEAN_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5; } catch { return 0.5; }
}
function leanWords(lean: number, label: string): string {
  const one = label.toLowerCase(), many = plural(label);
  if (lean <= 0.02) return `Every ${one} gives about the same number of units.`;
  if (Math.abs(lean - 0.5) <= 0.02) return `Every ${one} gives in proportion to what it holds, so the load looks like your shelf.`;
  if (lean >= 0.98) return `The biggest ${many} give until your shelf is even; the rest give only once they are level.`;
  return lean < 0.5
    ? `Between the same from every ${one} and matching your stock.`
    : `Between matching your stock and evening it out: the bigger ${many} give more than their share.`;
}

function fmtWhen(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function Seg<T extends string>({ value, options, onChange, size = "sm" }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  return (
    <div className="flex rounded-lg border border-line p-0.5 bg-surface-2 w-fit" role="tablist">
      {options.map((o) => (
        <button key={o.key} role="tab" aria-selected={value === o.key} onClick={() => onChange(o.key)}
          className={`px-3 whitespace-nowrap ${size === "md" ? "h-8 text-[13px]" : "h-7 text-[12px]"} rounded-md transition-colors ${value === o.key ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass rounded-2xl px-5 py-4 min-w-0">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="text-[22px] font-semibold text-ink tracking-tight tabular-nums mt-0.5 truncate">{value}</div>
      {sub && <div className="text-[12px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export default function ProductScreen({ item, importButtons, onBack, onEdit, onChanged }: {
  item: WarehouseItem; importButtons: ReactNode; onBack: () => void; onEdit: () => void; onChanged: (it: WarehouseItem) => void;
}) {
  const [tab, setTab] = useState<Tab>("shelf");
  const [pick, setPick] = useState<HandPick>(emptyPick());
  const [menu, setMenu] = useState(false);
  const layouts = useLayouts(item.updated_at);
  const label = item.section_label || "Section";
  const t = itemTotals(item);

  const archive = async (archived: boolean) => {
    setMenu(false);
    try {
      await api.archiveWarehouseItem(item.id, archived);
      onChanged({ ...item, archived });
      toast(archived ? "Archived. It stays under Show archived." : "Back in the warehouse");
      if (archived) onBack();
    } catch (e) { toast(String(e), "error"); }
  };

  const pickedUnits = Object.values(pickUnits(item.box_types, pick)).reduce((a, b) => a + b, 0);
  const TABS: { key: Tab; label: string }[] = [
    { key: "shelf", label: "On the shelf" },
    { key: "pick", label: pickedUnits ? `Pick an order · ${n0(pickedUnits)}` : "Pick an order" },
    { key: "plan", label: "Plan a load" },
    { key: "pallets", label: "Pallets" },
    { key: "history", label: "History" },
  ];

  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> Warehouse
      </button>
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[20px] font-semibold text-ink tracking-tight truncate">{item.name}</h2>
            {item.archived && <StatusPill>Archived</StatusPill>}
          </div>
          <p className="text-[12px] text-muted mt-0.5">
            {item.sections.length} {plural(label)} · {item.box_types.length} box {item.box_types.length === 1 ? "size" : "sizes"}
            {item.box_types.length > 0 && <>: {item.box_types.map((b) => `${b.name} ${b.per_box}`).join(", ")}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {importButtons}
          <button onClick={onEdit} className={WH_BTN_SECONDARY}><Pencil size={13} /> Edit product</button>
          <div className="relative">
            <button onClick={() => setMenu((v) => !v)} title="More" className="flex items-center justify-center border border-line text-ink-2 w-9 h-9 rounded-lg hover:bg-surface-2 transition-colors">
              <MoreHorizontal size={16} />
            </button>
            {menu && (
              <div className="absolute right-0 mt-1 z-30 w-48 bg-surface border border-line rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.10)] py-1">
                <button onClick={() => archive(!item.archived)} className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center gap-2">
                  {item.archived ? <><ArchiveRestore size={13} className="text-muted" /> Bring back</> : <><Archive size={13} className="text-muted" /> Archive</>}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        <Tile label="Units on the shelf" value={n0(t.units)} sub={item.unit_price > 0 ? `${fmtAmount(t.units * item.unit_price)} at ${fmtAmount(item.unit_price)}` : undefined} />
        <Tile label="Boxes" value={n0(t.boxes)} sub={`${item.box_types.length} ${item.box_types.length === 1 ? "size" : "sizes"}`} />
        <Tile label={cap(plural(label))} value={n0(item.sections.filter((s) => sectionUnits(item.box_types, s) > 0).length)} sub={`of ${item.sections.length} with stock`} />
        <Tile label="Pallets" value={t.pallets !== null ? t.pallets.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—"}
          sub={item.units_per_pallet > 0 ? `at ${n0(item.units_per_pallet)} a pallet` : "Set units per pallet"} />
      </div>

      <div className="flex items-center gap-1 border-b border-line mb-5 overflow-x-auto" role="tablist">
        {TABS.map((x) => (
          <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)}
            className={`relative px-3.5 h-10 text-[13px] whitespace-nowrap transition-colors ${tab === x.key ? "text-ink font-medium" : "text-muted hover:text-ink-2"}`}>
            {x.label}
            {tab === x.key && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {tab === "shelf" && <ShelfTab item={item} layouts={layouts} onChanged={onChanged} />}
      {tab === "pick" && <PickTab item={item} layouts={layouts} pick={pick} setPick={setPick} onChanged={onChanged} />}
      {tab === "plan" && <PlanTab item={item} layouts={layouts} onChanged={onChanged} onAdjust={(p) => { setPick(p); setTab("pick"); }} />}
      {tab === "pallets" && <PalletsTab item={item} onChanged={onChanged} />}
      {tab === "history" && <History item={item} onChanged={onChanged} />}
    </div>
  );
}

// ---------- On the shelf ----------

function ShelfTab({ item, layouts, onChanged }: { item: WarehouseItem; layouts: WarehouseLayout[]; onChanged: (it: WarehouseItem) => void }) {
  const [counting, setCounting] = useState<WhSection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const label = item.section_label || "Section";
  const sh = shares(item.box_types, item.sections);
  const rows = [...item.sections].sort((a, b) => (sh[b.id] - sh[a.id]) || a.name.localeCompare(b.name));

  const save = async () => {
    if (!counting) return;
    setBusy(true);
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: counting,
        units_per_pallet: item.units_per_pallet, unit_price: item.unit_price, notes: item.notes,
      });
      onChanged(it);
      setCounting(null);
      toast("Counts saved");
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
    {!counting && <CountCheckCard item={item} layouts={layouts} onChanged={onChanged} />}
    <div className={`${WH_CARD} overflow-hidden`}>
      <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[14px] font-semibold text-ink">{counting ? "Update counts" : "What is on the shelf"}</div>
          <div className="text-[12px] text-muted">
            {counting ? "Type what is there now. Saving writes one recount to the history." : `Boxes of each size by ${label.toLowerCase()}, and what is loose in an opened box.`}
          </div>
        </div>
        {counting ? (
          <div className="flex items-center gap-2">
            <button onClick={() => setCounting(null)} className={WH_BTN_SECONDARY}>Cancel</button>
            <button onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>Save counts</button>
          </div>
        ) : (
          <button onClick={() => setCounting(rows.map((s) => ({ ...s, counts: { ...s.counts } })))} className={WH_BTN_SECONDARY}
            disabled={item.box_types.length === 0} title={item.box_types.length === 0 ? "Add a box size first (Edit product)" : undefined}>
            <SlidersHorizontal size={13} /> Update counts
          </button>
        )}
      </div>
      <CountsGrid types={item.box_types} sections={counting ?? rows} label={label} editing={!!counting} share={counting ? undefined : sh}
        onChange={(next) => setCounting(next)} />
    </div>
    </div>
  );
}

/** Sections by box size. Read-only (with each section's share), or editable counts and names. */
export function CountsGrid({ types, sections, label, editing, withNames, share, onChange, onRemove }: {
  types: BoxType[]; sections: WhSection[]; label: string; editing?: boolean; withNames?: boolean;
  share?: Record<string, number>; onChange?: (next: WhSection[]) => void; onRemove?: (id: string) => void;
}) {
  const set = (id: string, patch: Partial<WhSection>) => onChange?.(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const cell = "w-[72px] border border-line px-2 h-8 rounded-md text-right tabular-nums text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent";
  const tot = (tid: string) => sections.reduce((a, s) => a + (s.counts[tid] || 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]" style={{ minWidth: 300 + types.length * 96 + (share ? 150 : 0) }}>
        <thead>
          <tr className="text-[12px] text-muted border-y border-line bg-surface-2/60">
            <th className="text-left font-medium py-2.5 pl-5 pr-3">{label}</th>
            {types.map((t) => (
              <th key={t.id} className="text-right font-medium py-2.5 px-2 whitespace-nowrap">
                {t.name}<div className="text-[11px] font-normal text-faint">of {t.per_box}</div>
              </th>
            ))}
            <th className="text-right font-medium py-2.5 px-2">Loose</th>
            <th className="text-right font-medium py-2.5 px-3">Boxes</th>
            <th className="text-right font-medium py-2.5 px-3">Units</th>
            {share && <th className="text-left font-medium py-2.5 pl-3 pr-5 w-[150px]">Share</th>}
            {withNames && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {sections.map((s) => (
            <tr key={s.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2/40 transition-colors">
              <td className="py-1.5 pl-5 pr-3 text-ink font-medium">
                {withNames ? (
                  <input value={s.name} onChange={(e) => set(s.id, { name: e.target.value })} placeholder={label} style={WH_INPUT_BG}
                    className={`${WH_INPUT} h-8 min-w-[140px]`} />
                ) : <span className="truncate block max-w-[200px]" title={s.name}>{s.name}</span>}
              </td>
              {types.map((t) => (
                <td key={t.id} className="py-1.5 px-2 text-right tabular-nums text-ink-2">
                  {editing ? (
                    <NumberInput integer value={s.counts[t.id] || ""} placeholder="0" style={WH_INPUT_BG} className={cell}
                      onValue={(n) => set(s.id, { counts: { ...s.counts, [t.id]: Math.max(0, n) } })} />
                  ) : (s.counts[t.id] ? n0(s.counts[t.id]) : <span className="text-faint">·</span>)}
                </td>
              ))}
              <td className="py-1.5 px-2 text-right tabular-nums text-ink-2">
                {editing ? (
                  <NumberInput integer value={s.loose || ""} placeholder="0" style={WH_INPUT_BG} className={cell}
                    onValue={(n) => set(s.id, { loose: Math.max(0, n) })} />
                ) : (s.loose ? n0(s.loose) : <span className="text-faint">·</span>)}
              </td>
              <td className="py-1.5 px-3 text-right tabular-nums text-ink-2">{n0(sectionBoxes(s))}</td>
              <td className="py-1.5 px-3 text-right tabular-nums text-ink font-medium">{n0(sectionUnits(types, s))}</td>
              {share && (
                <td className="py-1.5 pl-3 pr-5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <div className="h-full rounded-full" style={{ ...BAR, width: `${(share[s.id] || 0) * 100}%` }} />
                    </div>
                    <span className="w-9 text-right tabular-nums text-[12px] text-ink-2">{pct(share[s.id] || 0)}</span>
                  </div>
                </td>
              )}
              {withNames && (
                <td className="pr-3">
                  <button onClick={() => onRemove?.(s.id)} aria-label={`Remove ${s.name || "row"}`}
                    className="h-8 w-8 flex items-center justify-center text-faint hover:text-danger-ink transition-colors">×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {sections.length > 0 && (
          <tfoot>
            <tr className="border-t border-line text-[12.5px] font-semibold text-ink">
              <td className="py-2.5 pl-5 pr-3">Total</td>
              {types.map((t) => <td key={t.id} className="py-2.5 px-2 text-right tabular-nums">{n0(tot(t.id))}</td>)}
              <td className="py-2.5 px-2 text-right tabular-nums">{n0(sections.reduce((a, s) => a + (s.loose || 0), 0))}</td>
              <td className="py-2.5 px-3 text-right tabular-nums">{n0(sections.reduce((a, s) => a + sectionBoxes(s), 0))}</td>
              <td className="py-2.5 px-3 text-right tabular-nums">{n0(sections.reduce((a, s) => a + sectionUnits(types, s), 0))}</td>
              {share && <td />}
              {withNames && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ---------- Pick an order ----------

function Stepper({ value, max, onChange, onStep, label, caption }: {
  value: number; max: number; onChange: (n: number) => void; onStep: (d: number) => void; label: string; caption?: string;
}) {
  if (max <= 0) return <span className="text-faint">·</span>;
  const on = value > 0;
  return (
    <div className="inline-flex flex-col items-center">
      <div className={`inline-flex items-center rounded-lg border overflow-hidden transition-colors ${on ? "border-accent/60 bg-accent/10" : "border-line bg-surface"}`}>
        <button onClick={() => onStep(-1)} disabled={value <= 0} aria-label={`One less ${label}`}
          className="w-7 h-8 text-[15px] text-ink-2 hover:bg-surface-2 disabled:opacity-30 transition-colors">−</button>
        <NumberInput integer value={value || ""} placeholder="0" onValue={(n) => onChange(n)} aria-label={label}
          className={`w-9 h-8 text-center tabular-nums bg-transparent text-[13px] focus:outline-none ${on ? "text-ink font-semibold" : "text-muted"}`} />
        <button onClick={() => onStep(1)} disabled={value >= max} aria-label={`One more ${label}`}
          className="w-7 h-8 text-[15px] text-ink-2 hover:bg-surface-2 disabled:opacity-30 transition-colors">+</button>
      </div>
      <div className="text-[10.5px] text-faint mt-0.5 tabular-nums whitespace-nowrap">{caption ?? `of ${n0(max)}`}</div>
    </div>
  );
}

function PickTab({ item, layouts, pick, setPick, onChanged }: {
  item: WarehouseItem; layouts: WarehouseLayout[]; pick: HandPick; setPick: React.Dispatch<React.SetStateAction<HandPick>>; onChanged: (it: WarehouseItem) => void;
}) {
  const types = item.box_types;
  const label = item.section_label || "Section";
  const [q, setQ] = useState("");
  const [price, setPrice] = useState(item.unit_price || 0);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [takingOut, setTakingOut] = useState(false);
  const [busy, setBusy] = useState(false);

  const units = pickUnits(types, pick);
  const picked = item.sections.filter((s) => units[s.id]);
  const totalUnits = Object.values(units).reduce((a, b) => a + b, 0);
  const totalBoxes = Object.values(pick.take).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const totalLoose = Object.values(pick.loose).reduce((a, b) => a + b, 0);
  const rateOf = (id: string) => rates[id] ?? price;
  const total = picked.reduce((a, s) => a + units[s.id] * rateOf(s.id), 0);
  const withStock = item.sections.filter((s) => sectionUnits(types, s) > 0);
  const shown = withStock.filter((s) => !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()));

  // Every change builds on the latest pick, so quick clicks never undo each other.
  const takeAll = (s: WhSection) => setPick((cur) => {
    let p = cur;
    for (const t of types) p = setPicked(p, s, t.id, s.counts[t.id] || 0);
    return setPicked(p, s, null, s.loose || 0);
  });
  const clearRow = (s: WhSection) => setPick((cur) => {
    let p = cur;
    for (const t of types) p = setPicked(p, s, t.id, 0);
    return setPicked(p, s, null, 0);
  });
  const setOne = (s: WhSection, t: string | null, n: number) => setPick((cur) => setPicked(cur, s, t, n, looseRoom(types, cur, s)));
  const step = (s: WhSection, t: string | null, d: number) =>
    setPick((cur) => setPicked(cur, s, t, (t === null ? cur.loose[s.id] || 0 : cur.take[s.id]?.[t] || 0) + d, looseRoom(types, cur, s)));
  const reset = () => { setPick(emptyPick()); setRates({}); setNote(""); setTakingOut(false); };

  const sendToInvoice = () => {
    const lines = invoiceLines({ ...item, unit_price: price }, { ...pick, units }, rates);
    const prefill: InvoicePrefill = { lines, warehouse: { item_id: item.id, item_name: item.name } };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    reset();
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  const takeOut = async () => {
    setBusy(true);
    try {
      const changes = picked.map((s) => ({
        section_id: s.id,
        boxes: Object.fromEntries(Object.entries(pick.take[s.id] || {}).map(([t, n]) => [t, -n])),
        loose: pick.loose[s.id] ? -pick.loose[s.id] : 0,
      }));
      const r = await api.warehouseAdjust(item.id, changes, { note: note.trim() || undefined });
      onChanged(r.item);
      if (r.short.length) toast(`Taken out, but short: ${r.short.map((s) => `${s.name} had ${s.taken} of ${s.wanted}`).join(", ")}`, "error");
      else toast(`${n0(totalUnits)} units taken off the shelf`);
      reset();
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  const colW = 230 + types.length * 100 + 170;
  return (
    <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
      <div className={`${WH_CARD} overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[14px] font-semibold text-ink">What did you take?</div>
            <div className="text-[12px] text-muted">Set how many boxes of each size came off each {label.toLowerCase()}. It never lets you take more than is there.</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a ${label.toLowerCase()}`} style={WH_INPUT_BG}
                className={`${WH_INPUT} pl-8 w-[190px]`} />
            </div>
            {totalUnits > 0 && <button onClick={reset} className="text-[12px] text-muted hover:text-ink-2 px-2">Clear all</button>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" style={{ minWidth: colW }}>
            <thead>
              <tr className="text-[12px] text-muted border-y border-line bg-surface-2/60">
                <th className="text-left font-medium py-2.5 pl-5 pr-3">{label}</th>
                {types.map((t) => (
                  <th key={t.id} className="text-center font-medium py-2.5 px-1.5 whitespace-nowrap">
                    {t.name}<div className="text-[11px] font-normal text-faint">of {t.per_box}</div>
                  </th>
                ))}
                <th className="text-center font-medium py-2.5 px-1.5">Loose</th>
                <th className="text-right font-medium py-2.5 pl-3 pr-5">Taken</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const u = units[s.id] || 0;
                return (
                  <tr key={s.id} className={`border-b border-line-2 last:border-0 transition-colors ${u ? "bg-accent/[0.04]" : ""}`}>
                    <td className="py-2 pl-5 pr-3 max-w-[260px]">
                      <div className="text-ink font-medium truncate max-w-[180px]" title={s.name}>{s.name}</div>
                      <div className="text-[11.5px] text-muted tabular-nums">
                        {n0(sectionUnits(types, s))} on the shelf ·{" "}
                        {u ? <button onClick={() => clearRow(s)} className="text-accent hover:text-accent-hover">Clear</button>
                          : <button onClick={() => takeAll(s)} className="text-accent hover:text-accent-hover">Take all</button>}
                      </div>
                      <WhereFrom item={item} layouts={layouts} sectionId={s.id} take={pick.take[s.id] || {}} />
                    </td>
                    {types.map((t) => (
                      <td key={t.id} className="py-2 px-1.5 text-center">
                        <Stepper value={pick.take[s.id]?.[t.id] || 0} max={s.counts[t.id] || 0} label={`${t.name} of ${s.name}`}
                          onChange={(n) => setOne(s, t.id, n)} onStep={(d) => step(s, t.id, d)} />
                      </td>
                    ))}
                    <td className="py-2 px-1.5 text-center">
                      <Stepper value={pick.loose[s.id] || 0} max={looseRoom(types, pick, s)} label={`loose of ${s.name}`}
                        caption={(pick.loose[s.id] || 0) > (s.loose || 0) ? "opens a box" : s.loose ? `of ${n0(s.loose)} loose` : "opens a box"}
                        onChange={(n) => setOne(s, null, n)} onStep={(d) => step(s, null, d)} />
                    </td>
                    <td className="py-2 pl-3 pr-5 text-right tabular-nums">
                      {u ? <span className="text-ink font-semibold">{n0(u)}</span> : <span className="text-faint">—</span>}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={types.length + 3} className="py-6 text-center text-[13px] text-muted">
                  {withStock.length ? `No ${label.toLowerCase()} matches “${q}”.` : "Nothing is on the shelf yet."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Below 2xl the order sits under the grid, so its totals and send ride along the bottom. */}
      {picked.length > 0 && (
        <div className="2xl:hidden sticky bottom-3 z-20">
          <div className="glass rounded-2xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="text-[13px] text-ink tabular-nums min-w-0 flex-1">
              <span className="font-semibold">{n0(totalUnits)}</span> units · <span className="font-semibold">{n0(totalBoxes)}</span> boxes{totalLoose ? ` + ${n0(totalLoose)} loose` : ""} ·{" "}
              <span className="font-semibold">{fmtAmount(total)}</span>
              <span className="text-muted"> from {picked.length} {picked.length === 1 ? label.toLowerCase() : plural(label)}</span>
            </div>
            <button onClick={() => document.getElementById("wh-order")?.scrollIntoView({ behavior: "smooth", block: "start" })} className={WH_BTN_SECONDARY}>Prices</button>
            <button onClick={sendToInvoice} className={WH_BTN_PRIMARY}><FileText size={14} /> Send to invoice</button>
          </div>
        </div>
      )}

      {/* The order, always in reach */}
      <div id="wh-order" className={`${WH_CARD} p-5 2xl:sticky 2xl:top-4`}>
        <div className="text-[14px] font-semibold text-ink">This order</div>
        {picked.length === 0 ? (
          <p className="text-[12.5px] text-muted mt-1">Nothing picked yet. Use the − and + on the left, or plan a load and adjust it here.</p>
        ) : (
          <>
            <div className="mt-3">
              <label className="block text-[12px] text-muted mb-1.5">Sale price per unit</label>
              <div className="relative w-[160px]">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                <NumberInput value={price || ""} onValue={setPrice} placeholder="0.00" style={WH_INPUT_BG} className={`${WH_INPUT} pl-7 tabular-nums`} />
              </div>
            </div>
            <div className="mt-4 divide-y divide-line-2 border-y border-line-2">
              {picked.map((s) => (
                <div key={s.id} className="py-2.5 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink font-medium truncate">{s.name}</div>
                    <div className="text-[11.5px] text-muted">{describePick(types, pick.take[s.id] || {}, pick.loose[s.id] || 0)}</div>
                    <div className="text-[11.5px] text-muted tabular-nums">{n0(units[s.id])} units · {fmtAmount(units[s.id] * rateOf(s.id))}</div>
                  </div>
                  <div className="relative w-[92px] flex-shrink-0" title="Price for this one only">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-faint text-[12px]">$</span>
                    <NumberInput value={rates[s.id] ?? ""} placeholder={String(price || 0)} style={WH_INPUT_BG}
                      onValue={(n, raw) => setRates((r) => { const x = { ...r }; if (raw.trim() === "") delete x[s.id]; else x[s.id] = n; return x; })}
                      className={`${WH_INPUT} h-8 pl-5 pr-2 text-right tabular-nums text-[12.5px] ${s.id in rates ? "ring-1 ring-accent/40" : ""}`} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-[13px] tabular-nums">
              <div className="flex justify-between text-muted"><span>Boxes</span><span>{n0(totalBoxes)}{totalLoose ? ` + ${n0(totalLoose)} loose` : ""}</span></div>
              <div className="flex justify-between text-muted"><span>Units</span><span>{n0(totalUnits)}</span></div>
              <div className="flex justify-between text-ink font-semibold text-[15px] pt-1"><span>Total</span><span>{fmtAmount(total)}</span></div>
            </div>
            <div className="flex flex-col gap-2 mt-4">
              <button onClick={sendToInvoice} className={`${WH_BTN_PRIMARY} justify-center`}><FileText size={14} /> Send to invoice</button>
              {takingOut ? (
                <div className="p-3 rounded-lg bg-surface-2 border border-line space-y-2">
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for (optional)" style={WH_INPUT_BG} className={WH_INPUT} autoFocus />
                  <div className="flex gap-2">
                    <button onClick={takeOut} disabled={busy} className={`${WH_BTN_PRIMARY} flex-1 justify-center`}>Take out {n0(totalUnits)} units</button>
                    <button onClick={() => setTakingOut(false)} className={WH_BTN_SECONDARY}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setTakingOut(true)} className={`${WH_BTN_SECONDARY} justify-center`}>Take out without an invoice</button>
              )}
              <p className="text-[11.5px] text-muted">The invoice takes these exact boxes off the shelf when you create it, at these prices.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Plan a load ----------

function PlanTab({ item, layouts, onChanged, onAdjust }: { item: WarehouseItem; layouts: WarehouseLayout[]; onChanged: (it: WarehouseItem) => void; onAdjust: (p: HandPick) => void }) {
  const types = item.box_types;
  const label = item.section_label || "Section";
  const [mode, setMode] = useState<"pallets" | "units">(item.units_per_pallet > 0 ? "pallets" : "units");
  const [count, setCount] = useState(0);
  const [finish, setFinish] = useState<"exact" | "whole">("exact");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [upp, setUpp] = useState(item.units_per_pallet);
  const uppNow = useRef(upp);
  uppNow.current = upp;
  const [, setBuildRev] = useState(0);
  const big = bigBox(types);
  const [lean, setLeanState] = useState(readLean);
  const setLean = (v: number) => { setLeanState(v); try { localStorage.setItem(LEAN_KEY, String(v)); } catch { /* ignore */ } };

  const target = mode === "pallets" ? count * (upp || 0) : count;
  const plan = useMemo(
    () => planUnits(types, item.sections, target, { skip, finish: mode === "pallets" ? "under" : finish, lean }),
    [types, item.sections, target, skip, finish, mode, lean],
  );
  const grabUnits = Object.values(plan.units).reduce((a, b) => a + b, 0);
  const grabBoxes = Object.values(plan.take).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const grabLoose = Object.values(plan.loose).reduce((a, b) => a + b, 0);
  const picking = grabUnits > 0;
  const shNow = shares(types, item.sections);
  const shAfter = shares(types, plan.left);
  const leftOf = (id: string) => plan.left.find((s) => s.id === id)!;
  const rows = [...item.sections].filter((s) => sectionUnits(types, s) > 0).sort((a, b) => (shNow[b.id] - shNow[a.id]) || a.name.localeCompare(b.name));
  const inLoad = rows.filter((s) => (plan.units[s.id] || 0) > 0).length;
  const biggest = rows.find((s) => !skip.has(s.id));
  const story = picking && biggest && Math.round(shNow[biggest.id] * 100) !== Math.round(shAfter[biggest.id] * 100)
    ? `${biggest.name} goes from ${pct(shNow[biggest.id])} to ${pct(shAfter[biggest.id])} of what is left.` : "";
  const openings = Object.entries(plan.opened).flatMap(([sid, m]) =>
    Object.entries(m).map(([tid, n]) => `${n} × ${types.find((t) => t.id === tid)?.name ?? "box"} of ${item.sections.find((s) => s.id === sid)?.name ?? ""}`));

  const saveUpp = async () => {
    if (upp === item.units_per_pallet) return;
    const sent = upp;
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: item.sections,
        units_per_pallet: sent, unit_price: item.unit_price, notes: item.notes,
      });
      onChanged(it);
      // A cleared field comes back as the default, 21 of the biggest box (R-345) — unless a newer
      // number was typed while this one saved.
      if (uppNow.current === sent) setUpp(it.units_per_pallet);
    } catch (e) { toast(String(e), "error"); setUpp(item.units_per_pallet); }
  };

  const sendToInvoice = () => {
    const prefill: InvoicePrefill = { lines: invoiceLines(item, plan), warehouse: { item_id: item.id, item_name: item.name } };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  // While a lot is being built, only the build shows: its list is frozen, and the plan above it
  // would reshuffle as every tick takes stock.
  const building = !!readBuild(item.id);
  const buildCard = <BuildCard item={item} layouts={layouts} plan={plan} perPallet={big && upp > 0 ? Math.round(upp / big.per_box) : 0} onChanged={onChanged} onBuild={() => setBuildRev((r) => r + 1)} />;
  if (building) return <div className="space-y-4">{buildCard}</div>;

  return (
    <div className="space-y-4">
      <div className={`${WH_CARD} p-5`}>
        <div className="text-[14px] font-semibold text-ink">Plan a load</div>
        <p className="text-[12px] text-muted mt-0.5 mb-4">
          Say how much is going out and how to spread it across your {plural(label)}; it picks the boxes, biggest first.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1.5"><Seg value={mode} onChange={(m) => { setMode(m); setCount(0); }} options={[{ key: "pallets", label: "Pallets" }, { key: "units", label: "Units" }]} /></div>
            <div className="flex items-center gap-1.5">
              {mode === "pallets" && <button onClick={() => setCount(Math.max(0, count - 1))} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px]" aria-label="One less">−</button>}
              <NumberInput integer value={count || ""} onValue={(n) => setCount(Math.max(0, n))} placeholder="0" style={WH_INPUT_BG}
                className={`${mode === "units" ? "w-32" : "w-20"} border border-line h-9 rounded-lg text-[15px] font-semibold text-ink text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent`} />
              {mode === "pallets" && <button onClick={() => setCount(count + 1)} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px]" aria-label="One more">+</button>}
            </div>
          </div>
          {mode === "pallets" ? (
            big && readyFor(item, [big.id]) && item.units_per_pallet > 0 ? (
              // R-346: measured, the pallet size is the fitter's, not a typed number.
              <div>
                <div className="text-[12px] text-muted mb-1.5">{big.name} per pallet</div>
                <div className="h-9 flex items-center text-[13px] text-ink tabular-nums"><span className="font-semibold">{n0(Math.round(item.units_per_pallet / big.per_box))}</span></div>
                <div className="text-[11px] text-muted mt-1">Worked out from the measurements (Pallets tab)</div>
              </div>
            ) : big ? (
              <div>
                <label className="block text-[12px] text-muted mb-1.5">{big.name} per pallet</label>
                <NumberInput integer value={upp > 0 ? Math.round(upp / big.per_box) : ""} onValue={(n) => setUpp(Math.max(0, n) * big.per_box)} onBlur={saveUpp} placeholder="e.g. 21" style={WH_INPUT_BG}
                  className="w-24 border border-line px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
                {upp > 0 && <div className="text-[11px] text-muted mt-1 tabular-nums">about {n0(upp)} units a pallet</div>}
              </div>
            ) : (
              <div>
                <label className="block text-[12px] text-muted mb-1.5">Units per pallet</label>
                <NumberInput integer value={upp || ""} onValue={setUpp} onBlur={saveUpp} placeholder="e.g. 1,500" style={WH_INPUT_BG}
                  className="w-28 border border-line px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
              </div>
            )
          ) : (
            <div>
              <label className="block text-[12px] text-muted mb-1.5">If it does not come out even</label>
              <Seg value={finish} onChange={setFinish} options={[{ key: "exact", label: "Open a box" }, { key: "whole", label: "Whole boxes only" }]} />
            </div>
          )}
          <div className="min-w-0 pb-1.5 text-[13px] text-ink tabular-nums">
            {picking ? (
              <><span className="font-semibold">{n0(grabUnits)}</span> units · <span className="font-semibold">{n0(grabBoxes)}</span> boxes
                {grabLoose > 0 && <> + <span className="font-semibold">{n0(grabLoose)}</span> loose</>}
                {item.unit_price > 0 && <> · <span className="font-semibold">{fmtAmount(grabUnits * item.unit_price)}</span></>}</>
            ) : mode === "pallets" && !(upp > 0) ? <span className="text-[12px] text-warning-ink">Say how many units fit on a pallet to plan by pallet.</span>
              : <span className="text-[12px] text-muted">Type how many.</span>}
          </div>
        </div>
        <div className="mt-5 max-w-[640px]">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <label htmlFor="wh-lean" className="text-[12px] text-muted">How the load is spread</label>
            {picking && <span className="text-[12px] text-ink-2 tabular-nums">{inLoad} of {rows.length} {plural(label)} in this load</span>}
          </div>
          <input id="wh-lean" type="range" min={0} max={100} step={5} value={Math.round(lean * 100)}
            onChange={(e) => setLean(Number(e.target.value) / 100)} className="w-full accent-accent cursor-pointer" />
          <div className="flex justify-between gap-2 mt-0.5">
            {LEAN_STOPS.map((st) => (
              <button key={st.at} onClick={() => setLean(st.at)}
                className={`text-[12px] transition-colors ${Math.abs(lean - st.at) < 0.03 ? "text-ink font-medium" : "text-muted hover:text-ink-2"}`}>{st.label}</button>
            ))}
          </div>
          <p className="text-[12px] text-ink-2 mt-1.5">{leanWords(lean, label)}</p>
        </div>
        {(story || openings.length > 0 || (plan.short !== 0 && target > 0)) && (
          <div className="mt-4 text-[13px] space-y-1">
            {story && <div className="text-ink-2">{story}</div>}
            {openings.length > 0 && <div className="text-ink-2">Open {openings.join(", ")} for the last {n0(grabLoose)}.</div>}
            {plan.short > 0 && target > 0 && (
              <div className="text-warning-ink">{mode === "pallets" && grabUnits > 0
                ? `Whole boxes come to ${n0(grabUnits)} of the ${n0(target)} — ${n0(plan.short)} under.`
                : `Only ${n0(target - plan.short)} of the ${n0(target)} units are on the shelf for the ${plural(label)} you picked.`}</div>
            )}
            {plan.short < 0 && <div className="text-ink-2">Whole boxes come to {n0(grabUnits)} — {n0(-plan.short)} over.</div>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button onClick={sendToInvoice} disabled={!picking} className={WH_BTN_PRIMARY}><FileText size={14} /> Send to invoice</button>
          <button onClick={() => onAdjust(pickFromPlan(plan))} disabled={!picking} className={WH_BTN_SECONDARY}>Adjust by hand</button>
          {picking && <span className="text-[12px] text-muted">Adjust by hand opens this pick in Pick an order, box by box.</span>}
        </div>
      </div>

      {buildCard}

      <div className={`${WH_CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[780px]">
            <thead>
              <tr className="text-[12px] text-muted border-b border-line bg-surface-2/60">
                <th className="w-9 pl-5" />
                <th className="text-left font-medium py-2.5 pr-3">{label}</th>
                <th className="text-left font-medium py-2.5 px-3">Grab</th>
                <th className="text-right font-medium py-2.5 px-3">Units</th>
                <th className="text-right font-medium py-2.5 px-3">Of the load</th>
                <th className="text-left font-medium py-2.5 px-3 w-[140px]">Share now</th>
                <th className="text-right font-medium py-2.5 pl-3 pr-5">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const off = skip.has(s.id);
                const u = plan.units[s.id] || 0;
                const op = plan.opened[s.id] || {};
                const openTxt = Object.entries(op).map(([tt, n]) => `${n} × ${types.find((x) => x.id === tt)?.name ?? "box"}`).join(", ");
                return (
                  <tr key={s.id} className={`border-b border-line-2 last:border-0 ${off ? "opacity-50" : ""}`}>
                    <td className="pl-5">
                      <input type="checkbox" className="accent-accent" checked={!off} aria-label={`Include ${s.name}`}
                        onChange={() => setSkip((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                    </td>
                    <td className="py-2 pr-3 text-ink font-medium truncate max-w-[180px]" title={s.name}>{s.name}</td>
                    <td className="py-2 px-3 text-ink-2">
                      {u > 0 ? <>{describePick(types, plan.take[s.id] || {}, plan.loose[s.id] || 0)}{openTxt && <div className="text-[11.5px] text-muted">opens {openTxt}</div>}
                        <WhereFrom item={item} layouts={layouts} sectionId={s.id} take={boxesLeaving(plan, s.id)} /></> : <span className="text-faint">—</span>}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{u ? <span className="text-ink font-semibold">{n0(u)}</span> : <span className="text-faint">—</span>}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-2">{u && grabUnits ? pct(u / grabUnits) : ""}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden"><div className="h-full rounded-full" style={{ ...BAR, width: `${shNow[s.id] * 100}%` }} /></div>
                        <span className="w-9 text-right tabular-nums text-[12px] text-ink-2">{pct(shNow[s.id])}</span>
                      </div>
                    </td>
                    <td className="py-2 pl-3 pr-5 text-right tabular-nums text-ink-2">{picking ? `${n0(sectionUnits(types, leftOf(s.id)))} · ${pct(shAfter[s.id])}` : ""}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-[13px] text-muted">Nothing is on the shelf yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------- History ----------

function History({ item, onChanged }: { item: WarehouseItem; onChanged: (it: WarehouseItem) => void }) {
  const [all, setAll] = useState(false);
  const moves = all ? item.log : item.log.slice(0, 15);
  const kindLabel = (m: WhMove) => (m.kind === "out" ? "Out" : m.kind === "in" ? "In" : "Recount");
  const abs = (m: Record<string, number>) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, Math.abs(v)]));
  const putBack = async (m: WhMove) => {
    try {
      const r = await api.warehouseAdjust(item.id, [], { note: `Put back${m.reference ? ` from ${m.reference}` : ""}`, undoOf: m.id });
      onChanged(r.item);
      toast("Put back on the shelf");
    } catch (e) { toast(String(e), "error"); }
  };
  if (item.log.length === 0) return <div className={`${WH_CARD} px-5 py-8 text-center text-[13px] text-muted`}>Nothing has moved yet.</div>;
  return (
    <div className={`${WH_CARD} p-5`}>
      <div className="divide-y divide-line-2">
        {moves.map((m) => {
          const units = m.lines.reduce((a, l) => a + (l.units || 0), 0);
          const detail = m.lines.map((l) => {
            const what = describePick(item.box_types, abs(l.boxes), Math.abs(l.loose || 0));
            return `${l.name} ${(l.units || 0) >= 0 ? "+" : "−"}${n0(Math.abs(l.units || 0))}${what ? ` (${what})` : ""}`;
          }).join(" · ");
          return (
            <div key={m.id} className="py-2.5 flex items-start gap-3 min-w-0">
              <div className="w-[118px] flex-shrink-0 text-[12px] text-muted tabular-nums">{fmtWhen(m.at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink">
                  <span className="font-medium">{kindLabel(m)}</span>
                  <span className="tabular-nums text-ink-2">{units >= 0 ? "+" : "−"}{n0(Math.abs(units))} units</span>
                  {m.reference && <StatusPill tone="accent">{m.reference}</StatusPill>}
                  {m.undone && <StatusPill>Put back</StatusPill>}
                </div>
                <div className="text-[12px] text-muted truncate" title={detail}>{m.note ? `${m.note} · ` : ""}{detail}</div>
              </div>
              {m.kind === "out" && !m.undone && (
                <button onClick={() => putBack(m)} className="flex-shrink-0 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 px-2 h-7 rounded-md hover:bg-surface-2 transition-colors">
                  <Undo2 size={12} /> Put back
                </button>
              )}
            </div>
          );
        })}
      </div>
      {item.log.length > 15 && (
        <button onClick={() => setAll((v) => !v)} className="text-[12px] text-accent hover:text-accent-hover mt-2">{all ? "Show less" : `Show all ${item.log.length}`}</button>
      )}
    </div>
  );
}

// ---------- Build this lot (R-342) ----------

function readBuild(itemId: string): BuildState | null {
  try { const raw = localStorage.getItem(buildKey(itemId)); return raw ? (JSON.parse(raw) as BuildState) : null; } catch { return null; }
}

/**
 * The plan as pallets to build: boxes of each size, then each pallet with what goes on it and
 * where it comes off. Start building freezes that list on this computer; each tick takes those
 * boxes off that pallet and the shelf at once (untick puts them back), so the counts are live
 * everywhere. Make the invoice fills it from what was ticked, without taking anything twice.
 */
function BuildCard({ item, layouts, plan, perPallet, onChanged, onBuild }: {
  item: WarehouseItem; layouts: WarehouseLayout[]; plan: PickPlan; perPallet: number; onChanged: (it: WarehouseItem) => void; onBuild: () => void;
}) {
  const [state, setStateRaw] = useState<BuildState | null>(() => readBuild(item.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const setState = (s: BuildState | null) => {
    setStateRaw(s);
    try { if (s) localStorage.setItem(buildKey(item.id), JSON.stringify(s)); else localStorage.removeItem(buildKey(item.id)); } catch { /* ignore */ }
    onBuild();
  };
  // R-346: with the pallet and the load's box sizes measured, the pallets come from the fitter —
  // every box placed and checked — and each can be seen in 3D, layer by layer.
  const groups = useMemo(() => item.sections.flatMap((s) => Object.entries(plan.take[s.id] || {})
    .filter(([, n]) => n > 0).map(([type_id, boxes]) => ({ section_id: s.id, name: s.name, type_id, boxes }))), [item.sections, plan]);
  const measured = groups.length > 0 && readyFor(item, [...new Set(groups.map((g) => g.type_id))]);
  const fitKey = JSON.stringify([item.pallet, item.box_types, groups]);
  const [fit, setFit] = useState<{ key: string; pallets: FitPallet[] } | null>(null);
  const [fitError, setFitError] = useState("");
  const [open3d, setOpen3d] = useState<number | null>(null);
  useEffect(() => {
    if (state || !measured || !item.pallet) return;
    let stale = false;
    setFitError("");
    api.warehouseFitPallets({ pallet: item.pallet.pallet, types: fitTypes(item), groups, big_alone: true })
      .then((r) => { if (!stale) setFit({ key: fitKey, pallets: r.pallets }); })
      .catch((e) => { if (!stale) { setFit(null); setFitError(String(e)); } });
    return () => { stale = true; };
    // fitKey stands for item.pallet, item.box_types and groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, measured, !!state]);
  const liveFit = measured && fit?.key === fitKey ? fit.pallets : undefined;
  const fitting = !state && measured && !liveFit && !fitError;
  const preview = useMemo(() => buildLot(item, layouts, plan, perPallet, liveFit), [item, layouts, plan, perPallet, liveFit]);
  const build = state?.build ?? preview;
  const shown3d = state ? state.fit : liveFit && item.pallet ? { pallet: item.pallet.pallet, pallets: liveFit } : undefined;
  // Only when buildLot really used the fitter's pallets (it drops them if they disagree by a box).
  const fitted = !!shown3d && !!build.fitted && shown3d.pallets.length === build.pallets.length;
  const keyOf = (sid: string) => `s:${item.id}:${sid}`;
  const shortOf = (sid: string) => {
    for (const l of layouts) { const n = l.shape?.short_names?.[keyOf(sid)]; if (n) return n; }
    return item.sections.find((x) => x.id === sid)?.name ?? "";
  };
  const typeName = (tid: string) => item.box_types.find((t) => t.id === tid)?.name ?? "Box";
  const size = state ? state.per_pallet : perPallet;
  const grabs = build.pallets.flatMap((p) => p.lines);
  const doneCount = state ? grabs.filter((g) => state.done[g.id]).length + build.loose.filter((l) => state.done[l.id]).length : 0;
  const total = grabs.length + build.loose.length;
  if (!state && build.units === 0) return null;

  const take = async (g: GrabLine | LooseGrab) => {
    if (!state || busy) return;
    setBusy(g.id);
    try {
      const moveId = state.done[g.id];
      if (moveId) {
        const r = await api.warehouseAdjust(item.id, [], { undoOf: moveId, note: "Put back while building" });
        onChanged(r.item);
        const done = { ...state.done };
        delete done[g.id];
        setState({ ...state, done });
      } else {
        const isLoose = !("type_id" in g);
        const r = isLoose
          ? await api.warehouseAdjust(item.id, [{ section_id: g.section_id, loose: -(g as LooseGrab).units }], { note: "Built a lot" })
          : await api.warehouseAdjust(item.id, [{ section_id: g.section_id, boxes: { [(g as GrabLine).type_id]: -(g as GrabLine).boxes } }], {
            note: `Built pallet ${(g as GrabLine).pallet}`,
            places: (g as GrabLine).place ? [{ layout_id: (g as GrabLine).place!.layout_id, place: (g as GrabLine).place!.place, item_id: item.id, section_id: g.section_id, boxes: { [(g as GrabLine).type_id]: (g as GrabLine).boxes } }] : [],
          });
        onChanged(r.item);
        if (r.short.length) toast(`Short on the shelf: ${r.short.map((x) => `${x.name} had ${x.taken} of ${x.wanted} units`).join(", ")}`, "error");
        setState({ ...state, done: { ...state.done, [g.id]: r.item.log[0].id } });
      }
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };

  const makeInvoice = () => {
    if (!state) return;
    const rate = item.unit_price || 0;
    const lines = builtUnits(state).map((x) => ({
      description: `${item.name} — ${x.name}: ${describePick(item.box_types, x.boxes, x.loose)}`,
      qty: x.units, rate, amount: Math.round(x.units * rate * 100) / 100,
    }));
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify({ lines, warehouse: { item_id: item.id, item_name: item.name }, built: true })); } catch { /* ignore */ }
    setState(null);
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  const putAllBack = async () => {
    if (!state) return;
    setBusy("all");
    const done = { ...state.done };
    try {
      for (const id of Object.keys(done).reverse()) {
        const r = await api.warehouseAdjust(item.id, [], { undoOf: done[id], note: "Put back — stopped building" });
        onChanged(r.item);
        delete done[id];
      }
      setState(null);
      toast("Everything is back on the shelf");
    } catch (e) { toast(String(e), "error"); setState({ ...state, done }); }
    finally { setBusy(null); setStopping(false); }
  };

  const line = (g: GrabLine) => {
    const on = !!state?.done[g.id];
    return (
      <li key={g.id} className="flex items-center gap-3 py-1.5">
        {state && (
          <button onClick={() => take(g)} disabled={!!busy} aria-pressed={on} aria-label={on ? `Put back ${g.boxes} ${g.type_name} of ${g.name}` : `Grabbed ${g.boxes} ${g.type_name} of ${g.name}`}
            className={`w-6 h-6 flex-shrink-0 rounded-md border flex items-center justify-center transition-colors ${on ? "bg-accent border-accent text-on-accent" : "border-line-3 hover:border-accent"} ${busy === g.id ? "opacity-50" : ""}`}>
            {on && <Check size={14} strokeWidth={3} />}
          </button>
        )}
        <span className={`min-w-0 flex-1 text-[13px] ${on ? "text-muted line-through" : "text-ink"}`}>
          <span className="font-medium">{g.boxes} × {g.type_name}</span> of {g.name}
          <span className="text-muted"> — {g.place ? g.place.name : "not on a counted pallet"}</span>
        </span>
      </li>
    );
  };

  return (
    <div className={`${WH_CARD} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{state ? "Building this lot" : "Build this lot"}</div>
          <p className="text-[12px] text-muted mt-0.5">
            {state ? `${doneCount} of ${total} grabs done. Each tick takes those boxes off that pallet and the shelf now; untick to put them back.`
              : fitted ? "Fitted to your pallet box by box: the big boxes on their own, the smaller ones together, nothing past the edge and every box standing on the one below. Start building to tick off each grab as you pull it."
              : fitting ? "Fitting the boxes onto your pallet…"
              : perPallet > 0 ? `${bigBox(item.box_types)?.name ?? "Big boxes"} ${perPallet} to a pallet, the smaller boxes together on their own pallets. Measure the pallet and the boxes (Pallets tab) to have each pallet fitted and drawn. Start building to tick off each grab as you pull it.`
              : "Say how many big boxes fit on a pallet (Pallets, above) to split this into pallets. Start building to tick off each grab as you pull it."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!state && <button onClick={() => setState({ item_id: item.id, started_at: new Date().toISOString(), per_pallet: perPallet, build: preview, done: {}, ...(shown3d && fitted ? { fit: shown3d } : {}) })}
            disabled={fitting} className={WH_BTN_PRIMARY}>Start building</button>}
          {state && <button onClick={makeInvoice} disabled={doneCount === 0 || !!busy} className={WH_BTN_PRIMARY}><FileText size={14} /> Make the invoice</button>}
          {state && !stopping && <button onClick={() => (doneCount ? setStopping(true) : setState(null))} disabled={!!busy} className={WH_BTN_SECONDARY}>Stop building</button>}
        </div>
      </div>
      {fitError && !state && (
        <div className="mt-3 p-3 rounded-lg border border-danger/40 bg-danger/5 text-[12.5px] text-danger-ink">
          These boxes could not be fitted to the pallet: {fitError} The pallets below are split by count only — fix the measurements on the Pallets tab to see them fitted.
        </div>
      )}
      {stopping && state && (
        <div className="mt-3 p-3 rounded-lg bg-surface-2 border border-line text-[12.5px] text-ink-2 flex flex-wrap items-center gap-2">
          {doneCount} {doneCount === 1 ? "grab is" : "grabs are"} already off the shelf.
          <button onClick={putAllBack} disabled={!!busy} className={WH_BTN_SECONDARY}>Put them all back</button>
          <button onClick={() => { setState(null); setStopping(false); }} disabled={!!busy} className={WH_BTN_SECONDARY}>Leave them out</button>
          <button onClick={() => setStopping(false)} className="text-[12px] text-muted hover:text-ink-2 px-1">Keep building</button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {build.totals.map((t) => (
          <span key={t.type_id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12.5px] text-ink-2">
            <span className="font-semibold text-ink tabular-nums">{n0(t.boxes)}</span> × {t.name}
          </span>
        ))}
        {build.loose.length > 0 && <span className="inline-flex items-center rounded-md border border-line bg-surface-2 px-2 py-1 text-[12.5px] text-ink-2">{n0(build.loose.reduce((a, l) => a + l.units, 0))} loose</span>}
        <span className="inline-flex items-center rounded-md px-1 py-1 text-[12.5px] text-muted tabular-nums">{n0(build.units)} units · {build.pallets.length} {build.pallets.length === 1 ? "pallet" : "pallets"}{fitted && shown3d ? ` · tallest ${feet(Math.max(...shown3d.pallets.map((p) => p.total_height)))}` : ""}</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-4">
        {build.pallets.map((p) => {
          const left = p.lines.filter((g) => !state?.done[g.id]).length;
          const fp = fitted && shown3d ? shown3d.pallets[p.n - 1] : undefined;
          return (
            <div key={p.n} className={`rounded-lg border border-line p-3 ${open3d === p.n ? "xl:col-span-2" : ""}`}>
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div className="text-[13px] font-semibold text-ink">Pallet {p.n}{fp
                  ? <span className="font-normal text-ink-2"> · {n0(p.boxes)} boxes, {fp.layers.length} {fp.layers.length === 1 ? "layer" : "layers"}, {inches(fp.total_height)} in from the floor</span>
                  : size > 0 ? ` · ${p.big ? `${p.boxes} of ${size} ${bigBox(item.box_types)?.name ?? "big boxes"}` : `smaller boxes, ${n0(p.units)} units`}` : ""}</div>
                <div className="flex items-center gap-3">
                  {fp && <button onClick={() => setOpen3d(open3d === p.n ? null : p.n)} className="text-[12px] text-accent hover:underline">{open3d === p.n ? "Hide the picture" : "See it in 3D"}</button>}
                  {state && <span className={`text-[12px] ${left ? "text-muted" : "text-ink font-medium"}`}>{left ? `${left} to grab` : "Built"}</span>}
                </div>
              </div>
              <ul className="mt-1 divide-y divide-line-2">{p.lines.map(line)}</ul>
              {fp && open3d === p.n && shown3d && (
                <div className="mt-3">
                  <Suspense fallback={<div className="h-[340px] rounded-lg border border-line grid place-items-center text-[12px] text-muted">Drawing the pallet…</div>}>
                    <PalletView3D pallet={fp} spec={shown3d.pallet} colorOf={(sid) => teamColor(keyOf(sid))} labelOf={shortOf} typeName={typeName} />
                  </Suspense>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {build.loose.length > 0 && (
        <div className="mt-3 rounded-lg border border-line p-3">
          <div className="text-[13px] font-semibold text-ink">Loose units</div>
          <ul className="mt-1 divide-y divide-line-2">
            {build.loose.map((l) => {
              const on = !!state?.done[l.id];
              return (
                <li key={l.id} className="flex items-center gap-3 py-1.5">
                  {state && (
                    <button onClick={() => take(l)} disabled={!!busy} aria-pressed={on} aria-label={`${on ? "Put back" : "Grabbed"} ${l.units} loose of ${l.name}`}
                      className={`w-6 h-6 flex-shrink-0 rounded-md border flex items-center justify-center ${on ? "bg-accent border-accent text-on-accent" : "border-line-3 hover:border-accent"}`}>
                      {on && <Check size={14} strokeWidth={3} />}
                    </button>
                  )}
                  <span className={`text-[13px] ${on ? "text-muted line-through" : "text-ink"}`}><span className="font-medium">{l.units} loose</span> of {l.name} <span className="text-muted">— out of an open box, or open one</span></span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Check the counts against the pallets (R-343) ----------

/**
 * Each team's master count next to the boxes recorded on its pallets and shelf levels, size by
 * size. A team whose every spot is counted can be set to what its pallets hold (one recount);
 * after that, every pick takes boxes off both, so they stay together.
 */
function CountCheckCard({ item, layouts, onChanged }: { item: WarehouseItem; layouts: WarehouseLayout[]; onChanged: (it: WarehouseItem) => void }) {
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const check = useMemo(() => countCheck(item, layouts), [item, layouts]);
  const label = item.section_label || "Section";
  if (!check.teams.some((t) => t.places > 0)) return null; // nothing on a map yet — nothing to check against

  const matchTeams = async (ids: string[]) => {
    setBusy(true);
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: matchToPallets(item, layouts, ids),
        units_per_pallet: item.units_per_pallet, unit_price: item.unit_price, notes: item.notes,
      });
      onChanged(it);
      toast(ids.length === 1 ? "Set to what its pallets hold" : `${ids.length} ${plural(label)} set to what their pallets hold`);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  const shown = all ? check.teams : check.off;
  return (
    <div className={`${WH_CARD} overflow-hidden`}>
      <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[14px] font-semibold text-ink">Check against the pallets</div>
          <div className={`text-[12.5px] mt-0.5 ${check.off.length ? "text-warning-ink" : "text-ink-2"}`}>
            {check.off.length === 0 ? `Every ${label.toLowerCase()} matches the boxes on its pallets. Every pick now takes boxes off both.`
              : `${check.off.length} of ${check.teams.length} ${plural(label)} do not match their pallets (${n0(check.boxesOff)} ${check.boxesOff === 1 ? "box" : "boxes"} apart).`}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {check.matchable.length > 0 && <button onClick={() => matchTeams(check.matchable.map((t) => t.section_id))} disabled={busy} className={WH_BTN_PRIMARY}>Set {check.matchable.length === 1 ? "it" : `all ${check.matchable.length}`} to the pallets</button>}
          <button onClick={() => setAll((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 px-1">{all ? "Only the ones off" : "Show every one"}</button>
        </div>
      </div>
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[640px]">
            <thead>
              <tr className="text-[12px] text-muted border-y border-line bg-surface-2/60">
                <th className="text-left font-medium py-2 pl-5 pr-3">{label}</th>
                <th className="text-left font-medium py-2 px-3">Size</th>
                <th className="text-right font-medium py-2 px-3">In stock</th>
                <th className="text-right font-medium py-2 px-3">On pallets</th>
                <th className="text-right font-medium py-2 px-3">Off by</th>
                <th className="py-2 pl-3 pr-5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const rows = t.sizes.length ? t.sizes : [{ type_id: "", type_name: "—", stock: 0, onMaps: 0, diff: 0 }];
                const why = t.places === 0 ? "Not on the map — mark its pallets and enter their boxes."
                  : t.uncounted.length ? `No boxes entered on ${t.uncounted.slice(0, 3).join(", ")}${t.uncounted.length > 3 ? ` and ${t.uncounted.length - 3} more` : ""}.` : "";
                const canMatch = check.matchable.some((m) => m.section_id === t.section_id);
                return rows.map((x, i) => (
                  <tr key={`${t.section_id}:${x.type_id}`} className={i === rows.length - 1 ? "border-b border-line-2" : ""}>
                    {i === 0 && <td rowSpan={rows.length} className="py-2 pl-5 pr-3 align-top">
                      <div className="text-ink font-medium">{t.name}</div>
                      {why && <div className="text-[11.5px] text-warning-ink max-w-[220px]">{why}</div>}
                      {t.matches && <div className="text-[11.5px] text-muted">Matches</div>}
                    </td>}
                    <td className="py-2 px-3 text-ink-2">{x.type_name}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{n0(x.stock)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{n0(x.onMaps)}</td>
                    <td className={`py-2 px-3 text-right tabular-nums ${x.diff ? "text-warning-ink font-semibold" : "text-faint"}`}>{x.diff ? `${x.diff > 0 ? "+" : "−"}${n0(Math.abs(x.diff))}` : "—"}</td>
                    {i === 0 && <td rowSpan={rows.length} className="py-2 pl-3 pr-5 text-right align-top">
                      {canMatch && <button onClick={() => matchTeams([t.section_id])} disabled={busy} className={WH_BTN_SECONDARY}>Use the pallets</button>}
                    </td>}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-5 py-3 text-[11.5px] text-muted">"Use the pallets" sets the master count to what the pallets hold — one recount in the history. Loose units in an opened box are not on pallets and stay as they are. To fix a pallet instead, change its boxes on the Map.</p>
    </div>
  );
}
