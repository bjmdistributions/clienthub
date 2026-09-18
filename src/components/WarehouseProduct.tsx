// One warehouse product (R-326..R-329), as four tasks rather than one long page:
//   On the shelf  — the counts by team and box size, edited in place ("Update counts").
//   Pick an order — what was actually pulled: boxes of each size from each team, a sale
//                   price, then an invoice or a take-out. The main way stock leaves.
//   Plan a load   — the evening-out packer (planUnits), whose answer can be sent as it is
//                   or opened in Pick an order to adjust box by box.
//   History       — every move, with Put back.
import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Archive, ArchiveRestore, FileText, MoreHorizontal, Pencil, Search, SlidersHorizontal, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  INVOICE_PREFILL_KEY, describePick, emptyPick, invoiceLines, itemTotals, looseRoom, pickFromPlan, pickUnits, planUnits, sectionBoxes, sectionUnits,
  setPicked, shares, type BoxType, type HandPick, type InvoicePrefill, type WarehouseItem, type WhMove, type WhSection,
} from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, plural } from "./warehouseUi";

const BAR = { background: "rgb(var(--c-chart-1))" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
type Tab = "shelf" | "pick" | "plan" | "history";

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
          className={`px-3 ${size === "md" ? "h-8 text-[13px]" : "h-7 text-[12px]"} rounded-md transition-colors ${value === o.key ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
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

      {tab === "shelf" && <ShelfTab item={item} onChanged={onChanged} />}
      {tab === "pick" && <PickTab item={item} pick={pick} setPick={setPick} onChanged={onChanged} />}
      {tab === "plan" && <PlanTab item={item} onChanged={onChanged} onAdjust={(p) => { setPick(p); setTab("pick"); }} />}
      {tab === "history" && <History item={item} onChanged={onChanged} />}
    </div>
  );
}

// ---------- On the shelf ----------

function ShelfTab({ item, onChanged }: { item: WarehouseItem; onChanged: (it: WarehouseItem) => void }) {
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

function PickTab({ item, pick, setPick, onChanged }: {
  item: WarehouseItem; pick: HandPick; setPick: React.Dispatch<React.SetStateAction<HandPick>>; onChanged: (it: WarehouseItem) => void;
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
                    <td className="py-2 pl-5 pr-3">
                      <div className="text-ink font-medium truncate max-w-[180px]" title={s.name}>{s.name}</div>
                      <div className="text-[11.5px] text-muted tabular-nums">
                        {n0(sectionUnits(types, s))} on the shelf ·{" "}
                        {u ? <button onClick={() => clearRow(s)} className="text-accent hover:text-accent-hover">Clear</button>
                          : <button onClick={() => takeAll(s)} className="text-accent hover:text-accent-hover">Take all</button>}
                      </div>
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

function PlanTab({ item, onChanged, onAdjust }: { item: WarehouseItem; onChanged: (it: WarehouseItem) => void; onAdjust: (p: HandPick) => void }) {
  const types = item.box_types;
  const label = item.section_label || "Section";
  const [mode, setMode] = useState<"pallets" | "units">(item.units_per_pallet > 0 ? "pallets" : "units");
  const [count, setCount] = useState(0);
  const [finish, setFinish] = useState<"exact" | "whole">("exact");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [upp, setUpp] = useState(item.units_per_pallet);

  const target = mode === "pallets" ? count * (upp || 0) : count;
  const plan = useMemo(
    () => planUnits(types, item.sections, target, { skip, finish: mode === "pallets" ? "under" : finish }),
    [types, item.sections, target, skip, finish, mode],
  );
  const grabUnits = Object.values(plan.units).reduce((a, b) => a + b, 0);
  const grabBoxes = Object.values(plan.take).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const grabLoose = Object.values(plan.loose).reduce((a, b) => a + b, 0);
  const picking = grabUnits > 0;
  const shNow = shares(types, item.sections);
  const shAfter = shares(types, plan.left);
  const leftOf = (id: string) => plan.left.find((s) => s.id === id)!;
  const rows = [...item.sections].filter((s) => sectionUnits(types, s) > 0).sort((a, b) => (shNow[b.id] - shNow[a.id]) || a.name.localeCompare(b.name));
  const biggest = rows.find((s) => !skip.has(s.id));
  const story = picking && biggest && Math.round(shNow[biggest.id] * 100) !== Math.round(shAfter[biggest.id] * 100)
    ? `${biggest.name} goes from ${pct(shNow[biggest.id])} to ${pct(shAfter[biggest.id])} of what is left.` : "";
  const openings = Object.entries(plan.opened).flatMap(([sid, m]) =>
    Object.entries(m).map(([tid, n]) => `${n} × ${types.find((t) => t.id === tid)?.name ?? "box"} of ${item.sections.find((s) => s.id === sid)?.name ?? ""}`));

  const saveUpp = async () => {
    if (upp === item.units_per_pallet) return;
    try {
      onChanged(await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: item.sections,
        units_per_pallet: upp, unit_price: item.unit_price, notes: item.notes,
      }));
    } catch (e) { toast(String(e), "error"); setUpp(item.units_per_pallet); }
  };

  const sendToInvoice = () => {
    const prefill: InvoicePrefill = { lines: invoiceLines(item, plan), warehouse: { item_id: item.id, item_name: item.name } };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  return (
    <div className="space-y-4">
      <div className={`${WH_CARD} p-5`}>
        <div className="text-[14px] font-semibold text-ink">Plan a load</div>
        <p className="text-[12px] text-muted mt-0.5 mb-4">
          Say how much is going out and it picks the boxes for you: the biggest {plural(label)} first, biggest boxes first, so what stays on the shelf evens out.
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
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Units per pallet</label>
              <NumberInput integer value={upp || ""} onValue={setUpp} onBlur={saveUpp} placeholder="e.g. 1,500" style={WH_INPUT_BG}
                className="w-28 border border-line px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
            </div>
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

      <div className={`${WH_CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead>
              <tr className="text-[12px] text-muted border-b border-line bg-surface-2/60">
                <th className="w-9 pl-5" />
                <th className="text-left font-medium py-2.5 pr-3">{label}</th>
                <th className="text-left font-medium py-2.5 px-3">Grab</th>
                <th className="text-right font-medium py-2.5 px-3">Units</th>
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
                      {u > 0 ? <>{describePick(types, plan.take[s.id] || {}, plan.loose[s.id] || 0)}{openTxt && <div className="text-[11.5px] text-muted">opens {openTxt}</div>}</> : <span className="text-faint">—</span>}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{u ? <span className="text-ink font-semibold">{n0(u)}</span> : <span className="text-faint">—</span>}</td>
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
              {rows.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-[13px] text-muted">Nothing is on the shelf yet.</td></tr>}
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
