// Warehouse (R-326): stock Jack physically holds, counted in boxes, and the truckload
// packer that tells him how many boxes of each section to pull so what is left stays
// even. The rule itself lives in lib/warehouse.ts (planPick) with its tests; this file
// is the screen around it.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Archive, ArchiveRestore, ClipboardPaste, FileText, Pencil, Plus, Trash2, Undo2, Warehouse as WarehouseIcon } from "lucide-react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  INVOICE_PREFILL_KEY,
  afterPick,
  invoiceLines,
  itemTotals,
  parseSectionList,
  perPallet,
  planPick,
  sectionUnits,
  shares,
  type InvoicePrefill,
  type WarehouseItem,
  type WhMove,
  type WhSection,
} from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";

const INPUT =
  "w-full border border-line px-3 h-9 rounded-lg text-[13px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const INPUT_BG = { background: "var(--t-input-bg)" };
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40";
const BTN_SECONDARY =
  "inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[13px] transition-colors disabled:opacity-40";
const CARD = "bg-surface border border-line rounded-xl";
const BAR = { background: "rgb(var(--c-chart-1))" };

const n0 = (n: number) => n.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "Team" -> "teams", "Category" -> "categories". */
function plural(label: string): string {
  const l = (label || "Section").trim().toLowerCase();
  if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/.test(l)) return l + "es";
  return l + "s";
}

function fmtWhen(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------

export default function WarehouseView() {
  const [items, setItems] = useState<WarehouseItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WarehouseItem | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = () =>
    api.listWarehouseItems()
      .then(setItems)
      .catch((e) => { toast(`Couldn't load the warehouse: ${e}`, "error"); setItems([]); });
  useEffect(() => { load(); }, []);

  const put = (it: WarehouseItem) =>
    setItems((prev) => (prev ? (prev.some((p) => p.id === it.id) ? prev.map((p) => (p.id === it.id ? it : p)) : [...prev, it]) : [it]));

  if (editing) {
    return (
      <ProductForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={(it) => { put(it); setEditing(null); setOpenId(it.id); }}
      />
    );
  }

  const open = items?.find((i) => i.id === openId);
  if (open) {
    return (
      <ProductScreen
        key={open.id}
        item={open}
        onBack={() => setOpenId(null)}
        onEdit={() => setEditing(open)}
        onChanged={put}
      />
    );
  }

  const live = (items || []).filter((i) => !i.archived);
  const archived = (items || []).filter((i) => i.archived);
  const all = live.reduce((a, i) => { const t = itemTotals(i); return { boxes: a.boxes + t.boxes, units: a.units + t.units }; }, { boxes: 0, units: 0 });

  return (
    <div>
      <div className="flex flex-wrap justify-between items-start gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Warehouse</h2>
          <p className="text-[12px] text-muted mt-0.5">
            <span className="text-ink-2 font-medium tabular-nums">{live.length}</span> {live.length === 1 ? "product" : "products"}
            <span className="text-faint"> · </span>
            <span className="text-ink-2 font-medium tabular-nums">{n0(all.boxes)}</span> boxes
            <span className="text-faint"> · </span>
            <span className="text-ink-2 font-medium tabular-nums">{n0(all.units)}</span> units on the shelf
          </p>
        </div>
        <button onClick={() => setEditing("new")} className={BTN_PRIMARY}><Plus size={14} /> Add product</button>
      </div>

      {items === null ? (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
          {[0, 1].map((i) => <div key={i} className="h-[112px] bg-surface-2 rounded-xl animate-pulse" />)}
        </div>
      ) : live.length === 0 ? (
        <div className={`${CARD} px-6 py-10 text-center`}>
          <WarehouseIcon size={22} className="text-faint mx-auto mb-3" />
          <div className="text-[14px] font-semibold text-ink">Count what is on your shelves</div>
          <p className="text-[13px] text-muted mt-1 max-w-[440px] mx-auto">
            Add a product, split it into sections such as teams, and say how many boxes of each you hold.
            The packer then tells you what to pull for a truckload so the stock left behind stays even.
          </p>
          <button onClick={() => setEditing("new")} className={`${BTN_PRIMARY} mt-4`}><Plus size={14} /> Add product</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
          {live.map((it) => <ProductCard key={it.id} item={it} onOpen={() => setOpenId(it.id)} />)}
        </div>
      )}

      {archived.length > 0 && (
        <div className="mt-5">
          <button onClick={() => setShowArchived((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 transition-colors">
            {showArchived ? "Hide" : "Show"} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3 mt-3 opacity-80">
              {archived.map((it) => <ProductCard key={it.id} item={it} onOpen={() => setOpenId(it.id)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- List card ----------

function ProductCard({ item, onOpen }: { item: WarehouseItem; onOpen: () => void }) {
  const t = itemTotals(item);
  const sh = shares(item.sections);
  const ranked = [...item.sections].filter((s) => s.boxes > 0).sort((a, b) => sectionUnits(b) - sectionUnits(a));
  const top = ranked[0];
  return (
    <button onClick={onOpen} className={`${CARD} text-left px-5 py-4 hover:border-line-3 transition-colors min-w-0`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink truncate">{item.name}</div>
          <div className="text-[12px] text-muted mt-0.5">
            {item.sections.length} {plural(item.section_label)} · {n0(t.boxes)} boxes · {n0(t.units)} units
            {t.pallets !== null && <> · {t.pallets.toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets</>}
          </div>
        </div>
        {item.archived && <StatusPill>Archived</StatusPill>}
      </div>
      {/* Every section as a slice of one bar, biggest first — the lopsided product is
          obvious before you open it. */}
      <div className="flex h-2 rounded-full overflow-hidden bg-surface-3 mt-3 gap-px">
        {ranked.map((s) => (
          <div key={s.id} title={`${s.name} ${pct(sh[s.id])}`} style={{ ...BAR, width: `${sh[s.id] * 100}%`, opacity: 0.35 + 0.65 * (sh[s.id] / (sh[ranked[0].id] || 1)) }} />
        ))}
      </div>
      <div className="text-[12px] text-muted mt-2">
        {top ? <>Largest: <span className="text-ink-2 font-medium">{top.name}</span> at {pct(sh[top.id])}</> : "Nothing on the shelf"}
      </div>
    </button>
  );
}

// ---------- Product screen: packer, stock, history ----------

function ProductScreen({ item, onBack, onEdit, onChanged }: {
  item: WarehouseItem; onBack: () => void; onEdit: () => void; onChanged: (it: WarehouseItem) => void;
}) {
  const label = item.section_label || "Section";
  const [mode, setMode] = useState<"pallets" | "boxes">(item.boxes_per_pallet > 0 ? "pallets" : "boxes");
  const [count, setCount] = useState(0);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [bpp, setBpp] = useState(item.boxes_per_pallet);
  const [takeOut, setTakeOut] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const totals = itemTotals(item);
  const target = mode === "pallets" ? count * (bpp || 0) : count;
  const plan = useMemo(() => planPick(item.sections, target, skip), [item.sections, target, skip]);
  const take = useMemo(() => {
    const t: Record<string, number> = { ...plan.take };
    for (const [id, v] of Object.entries(overrides)) {
      const s = item.sections.find((x) => x.id === id);
      t[id] = Math.max(0, Math.min(v, s?.boxes ?? 0));
    }
    return t;
  }, [plan.take, overrides, item.sections]);
  const edited = Object.keys(overrides).length > 0;
  const grabBoxes = item.sections.reduce((a, s) => a + (take[s.id] || 0), 0);
  const grabUnits = item.sections.reduce((a, s) => a + (take[s.id] || 0) * s.per_box, 0);
  const pallets = mode === "pallets" ? count : (bpp > 0 ? Math.ceil(grabBoxes / bpp) : 0);
  const left = afterPick(item.sections, take);
  const shNow = shares(item.sections);
  const shAfter = shares(left);
  const rows = [...item.sections].sort((a, b) => (sectionUnits(b) - sectionUnits(a)) || a.name.localeCompare(b.name));
  const picking = grabBoxes > 0;

  // The sentence that says what the pick does to the stock, on the team it matters most.
  const biggest = rows.find((s) => !skip.has(s.id) && s.boxes > 0);
  const story = picking && biggest && Math.round(shNow[biggest.id] * 100) !== Math.round(shAfter[biggest.id] * 100)
    ? `${biggest.name} goes from ${pct(shNow[biggest.id])} to ${pct(shAfter[biggest.id])} of what is left.`
    : "";

  const resetPlan = () => { setOverrides({}); };
  const setTarget = (n: number) => { setCount(Math.max(0, n)); setOverrides({}); };

  const saveBpp = async () => {
    if (bpp === item.boxes_per_pallet) return;
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, sections: item.sections,
        boxes_per_pallet: bpp, unit_price: item.unit_price, notes: item.notes,
      });
      onChanged(it);
    } catch (e) { toast(String(e), "error"); setBpp(item.boxes_per_pallet); }
  };

  const sendToInvoice = () => {
    const prefill: InvoicePrefill = {
      lines: invoiceLines(item, take),
      warehouse: { item_id: item.id, item_name: item.name },
    };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  const doTakeOut = async () => {
    setBusy(true);
    try {
      const changes = item.sections.filter((s) => (take[s.id] || 0) > 0).map((s) => ({ section_id: s.id, boxes: -take[s.id] }));
      const r = await api.warehouseAdjust(item.id, changes, { note: note.trim() || undefined });
      onChanged(r.item);
      setTakeOut(false); setNote(""); setCount(0); setOverrides({});
      if (r.short.length) toast(`Taken out, but short: ${r.short.map((s) => `${s.name} had ${s.taken} of ${s.wanted}`).join(", ")}`, "error");
      else toast(`${n0(grabBoxes)} boxes taken out of the warehouse`);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  const putBack = async (m: WhMove) => {
    try {
      const changes = m.lines.map((l) => ({ section_id: l.section_id, boxes: -l.boxes }));
      const r = await api.warehouseAdjust(item.id, changes, { note: `Put back${m.reference ? ` from ${m.reference}` : ""}`, undoOf: m.id });
      onChanged(r.item);
      toast("Put back on the shelf");
    } catch (e) { toast(String(e), "error"); }
  };

  const archive = async (archived: boolean) => {
    try {
      await api.archiveWarehouseItem(item.id, archived);
      onChanged({ ...item, archived });
      toast(archived ? "Archived. It stays under Show archived." : "Back in the warehouse");
      if (archived) onBack();
    } catch (e) { toast(String(e), "error"); }
  };

  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> Warehouse
      </button>
      <div className="flex flex-wrap justify-between items-start gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">{item.name}</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {item.sections.length} {plural(label)} · {n0(totals.boxes)} boxes · {n0(totals.units)} units
            {totals.pallets !== null && <> · {totals.pallets.toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets at {item.boxes_per_pallet} boxes</>}
            {item.unit_price > 0 && <> · {fmtAmount(item.unit_price)} a unit</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => archive(!item.archived)} className={BTN_SECONDARY} title={item.archived ? "Bring back" : "Archive — nothing is deleted"}>
            {item.archived ? <><ArchiveRestore size={13} /> Bring back</> : <><Archive size={13} /> Archive</>}
          </button>
          <button onClick={onEdit} className={BTN_SECONDARY}><Pencil size={13} /> Edit stock</button>
        </div>
      </div>

      {/* Packer */}
      <div className={`${CARD} p-5 mb-4`}>
        <div className="text-[14px] font-semibold text-ink">Truckload packer</div>
        <p className="text-[12px] text-muted mt-0.5 mb-4">
          Say how much is going out. Boxes come from the biggest {plural(label)} first, so what stays on the shelf evens out.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="flex rounded-lg border border-line p-0.5 bg-surface-2 w-fit mb-1.5" role="tablist">
              {(["pallets", "boxes"] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setTarget(0); }}
                  className={`px-3 h-7 rounded-md text-[12px] transition-colors ${mode === m ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                  {m === "pallets" ? "Pallets" : "Boxes"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setTarget(count - 1)} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px] leading-none" aria-label="One less">−</button>
              <NumberInput integer value={count || ""} onValue={(n) => setTarget(n)} placeholder="0" style={INPUT_BG}
                className="w-20 border border-line h-9 rounded-lg text-[15px] font-semibold text-ink text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
              <button onClick={() => setTarget(count + 1)} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px] leading-none" aria-label="One more">+</button>
            </div>
          </div>
          {mode === "pallets" && (
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Boxes per pallet</label>
              <NumberInput integer value={bpp || ""} onValue={(n) => { setBpp(n); setOverrides({}); }} onBlur={saveBpp} placeholder="e.g. 40" style={INPUT_BG}
                className="w-28 border border-line px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
            </div>
          )}
          <div className="min-w-0 pb-1.5">
            {picking ? (
              <div className="text-[13px] text-ink">
                <span className="font-semibold tabular-nums">{n0(grabBoxes)}</span> boxes ·{" "}
                <span className="font-semibold tabular-nums">{n0(grabUnits)}</span> units
                {item.unit_price > 0 && <> · <span className="font-semibold tabular-nums">{fmtAmount(grabUnits * item.unit_price)}</span></>}
                {mode === "boxes" && bpp > 0 && <span className="text-muted"> · about {(grabBoxes / bpp).toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets</span>}
              </div>
            ) : mode === "pallets" && !(bpp > 0) ? (
              <div className="text-[12px] text-warning-ink">Set how many boxes fit on a pallet to plan by pallet.</div>
            ) : (
              <div className="text-[12px] text-muted">{n0(totals.boxes)} boxes on the shelf.</div>
            )}
          </div>
        </div>

        {(story || plan.short > 0 || edited) && (
          <div className="mt-4 text-[13px] space-y-1">
            {story && <div className="text-ink-2">{story}</div>}
            {plan.short > 0 && (
              <div className="text-warning-ink">
                Only {n0(target - plan.short)} of the {n0(target)} boxes are on the shelf for the {plural(label)} you picked.
              </div>
            )}
            {edited && (
              <div className="text-muted">
                You changed the pick by hand.{" "}
                <button onClick={resetPlan} className="text-accent hover:text-accent-hover">Back to the even pick</button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button onClick={sendToInvoice} disabled={!picking} className={BTN_PRIMARY}>
            <FileText size={14} /> Send to invoice
          </button>
          <button onClick={() => setTakeOut((v) => !v)} disabled={!picking} className={BTN_SECONDARY}>
            Take out without an invoice
          </button>
          {picking && <span className="text-[12px] text-muted">The invoice takes the boxes off the shelf when you create it.</span>}
        </div>
        {takeOut && picking && (
          <div className="mt-3 flex flex-wrap items-center gap-2 p-3 rounded-lg bg-surface-2 border border-line">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for (optional)" style={INPUT_BG} className={`${INPUT} flex-1 min-w-[200px]`} />
            <button onClick={doTakeOut} disabled={busy} className={BTN_PRIMARY}>Take out {n0(grabBoxes)} boxes</button>
            <button onClick={() => setTakeOut(false)} className="text-[12px] text-muted hover:text-ink-2 px-2">Cancel</button>
          </div>
        )}
      </div>

      {/* Sections: the stock, and what the pick does to it */}
      <div className={`${CARD} mb-4 overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead>
              <tr className="text-[12px] text-muted border-b border-line">
                <th className="w-9 pl-4" />
                <th className="text-left font-medium py-2.5 pr-3">{label}</th>
                <th className="text-right font-medium py-2.5 px-3">Boxes</th>
                <th className="text-right font-medium py-2.5 px-3">Units</th>
                <th className="text-left font-medium py-2.5 px-3 w-[150px]">Share</th>
                <th className="text-right font-medium py-2.5 px-3">Grab</th>
                <th className="text-right font-medium py-2.5 px-3">Per pallet</th>
                <th className="text-right font-medium py-2.5 px-3">Left</th>
                <th className="text-right font-medium py-2.5 pl-3 pr-5">Share after</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const off = skip.has(s.id);
                const g = take[s.id] || 0;
                const l = left.find((x) => x.id === s.id)!;
                return (
                  <tr key={s.id} className={`border-b border-line-2 last:border-0 ${off ? "opacity-50" : ""}`}>
                    <td className="pl-4">
                      <input type="checkbox" className="accent-accent" checked={!off} aria-label={`Include ${s.name}`}
                        onChange={() => {
                          setSkip((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; });
                          setOverrides((o) => { const n = { ...o }; delete n[s.id]; return n; });
                        }} />
                    </td>
                    <td className="py-2 pr-3 text-ink font-medium truncate max-w-[220px]" title={s.name}>{s.name}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-2">{n0(s.boxes)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-muted">{n0(sectionUnits(s))}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                          <div className="h-full rounded-full" style={{ ...BAR, width: `${shNow[s.id] * 100}%` }} />
                        </div>
                        <span className="w-9 text-right tabular-nums text-[12px] text-ink-2">{pct(shNow[s.id])}</span>
                      </div>
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <NumberInput integer value={g || ""} disabled={off || s.boxes === 0} placeholder="0" style={INPUT_BG}
                        onValue={(n) => setOverrides((o) => ({ ...o, [s.id]: n }))}
                        className={`w-16 border px-2 h-8 rounded-md text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent ${g > 0 ? "border-accent/40 text-ink font-semibold" : "border-line text-muted"} ${s.id in overrides ? "ring-1 ring-accent/30" : ""}`} />
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-muted">{perPallet(g, pallets)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-2">{picking ? n0(l.boxes) : ""}</td>
                    <td className="py-2 pl-3 pr-5 text-right tabular-nums text-ink-2">{picking ? pct(shAfter[s.id]) : ""}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="py-6 text-center text-[13px] text-muted">
                  No {plural(label)} yet. <button onClick={onEdit} className="text-accent hover:text-accent-hover">Add them</button>
                </td></tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-line text-[12.5px] font-semibold text-ink">
                  <td />
                  <td className="py-2.5 pr-3">Total</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{n0(totals.boxes)}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{n0(totals.units)}</td>
                  <td />
                  <td className="py-2.5 px-3 text-right tabular-nums">{picking ? n0(grabBoxes) : ""}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-muted font-normal">{picking && pallets > 0 ? `${pallets} ${pallets === 1 ? "pallet" : "pallets"}` : ""}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums">{picking ? n0(totals.boxes - grabBoxes) : ""}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <History item={item} onPutBack={putBack} />
    </div>
  );
}

function History({ item, onPutBack }: { item: WarehouseItem; onPutBack: (m: WhMove) => void }) {
  const [all, setAll] = useState(false);
  const moves = all ? item.log : item.log.slice(0, 8);
  if (item.log.length === 0) return null;
  const kindLabel = (m: WhMove) => (m.kind === "out" ? "Out" : m.kind === "in" ? "In" : "Recount");
  return (
    <div className={`${CARD} p-5`}>
      <div className="text-[14px] font-semibold text-ink mb-3">History</div>
      <div className="divide-y divide-line-2">
        {moves.map((m) => {
          const boxes = m.lines.reduce((a, l) => a + l.boxes, 0);
          const units = m.lines.reduce((a, l) => a + l.units, 0);
          const detail = m.lines.map((l) => `${l.name} ${l.boxes > 0 ? "+" : "−"}${n0(Math.abs(l.boxes))}`).join(", ");
          return (
            <div key={m.id} className="py-2.5 flex items-start gap-3 min-w-0">
              <div className="w-[118px] flex-shrink-0 text-[12px] text-muted tabular-nums">{fmtWhen(m.at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink">
                  <span className="font-medium">{kindLabel(m)}</span>
                  <span className="tabular-nums text-ink-2">{boxes > 0 ? "+" : "−"}{n0(Math.abs(boxes))} boxes · {n0(Math.abs(units))} units</span>
                  {m.reference && <StatusPill tone="accent">{m.reference}</StatusPill>}
                  {m.undone && <StatusPill>Put back</StatusPill>}
                </div>
                <div className="text-[12px] text-muted truncate" title={detail}>{m.note ? `${m.note} · ` : ""}{detail}</div>
              </div>
              {m.kind === "out" && !m.undone && (
                <button onClick={() => onPutBack(m)} className="flex-shrink-0 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 px-2 h-7 rounded-md hover:bg-surface-2 transition-colors">
                  <Undo2 size={12} /> Put back
                </button>
              )}
            </div>
          );
        })}
      </div>
      {item.log.length > 8 && (
        <button onClick={() => setAll((v) => !v)} className="text-[12px] text-accent hover:text-accent-hover mt-2">
          {all ? "Show less" : `Show all ${item.log.length}`}
        </button>
      )}
    </div>
  );
}

// ---------- Add / edit a product ----------

function ProductForm({ initial, onCancel, onSaved }: {
  initial: WarehouseItem | null; onCancel: () => void; onSaved: (it: WarehouseItem) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [label, setLabel] = useState(initial?.section_label && initial.section_label !== "Section" ? initial.section_label : "");
  const [bpp, setBpp] = useState(initial?.boxes_per_pallet ?? 0);
  const [price, setPrice] = useState(initial?.unit_price ?? 0);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [sections, setSections] = useState<WhSection[]>(
    initial?.sections.length ? initial.sections.map((s) => ({ ...s })) : [{ id: "", name: "", boxes: 0, per_box: 0 }],
  );
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, setSaving] = useState(false);

  const shown = label.trim() || "Section";
  const lastPerBox = [...sections].reverse().find((s) => s.per_box > 0)?.per_box ?? 0;
  const set = (i: number, patch: Partial<WhSection>) => setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addRow = () => setSections((prev) => [...prev, { id: "", name: "", boxes: 0, per_box: lastPerBox }]);
  const units = sections.reduce((a, s) => a + s.boxes * s.per_box, 0);
  const boxes = sections.reduce((a, s) => a + s.boxes, 0);

  const applyPaste = () => {
    const rows = parseSectionList(pasteText, lastPerBox);
    if (!rows.length) { toast("Nothing in that list to add", "error"); return; }
    // A pasted name that is already on the product updates its counts instead of adding a twin.
    setSections((prev) => {
      const next = prev.filter((s) => s.name.trim() || s.boxes > 0);
      for (const r of rows) {
        const hit = next.findIndex((s) => s.name.trim().toLowerCase() === r.name.toLowerCase());
        if (hit >= 0) next[hit] = { ...next[hit], boxes: r.boxes, per_box: r.per_box || next[hit].per_box };
        else next.push(r);
      }
      return next;
    });
    setPasteText(""); setPasting(false);
    toast(`${rows.length} ${rows.length === 1 ? "row" : "rows"} added`);
  };

  const save = async () => {
    if (!name.trim()) { toast("Give the product a name", "error"); return; }
    setSaving(true);
    try {
      const it = await api.saveWarehouseItem({
        id: initial?.id ?? null, name: name.trim(), section_label: label.trim() || "Section",
        sections, boxes_per_pallet: bpp, unit_price: price, notes,
      });
      toast(initial ? "Saved" : "Product added");
      onSaved(it);
    } catch (e) { toast(String(e), "error"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-[860px]">
      <button onClick={onCancel} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> {initial ? initial.name : "Warehouse"}
      </button>
      <h2 className="text-[18px] font-semibold text-ink tracking-tight mb-5">{initial ? "Edit stock" : "Add a product"}</h2>

      <div className={`${CARD} p-5 mb-4`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="lg:col-span-2">
            <label className="block text-[12px] text-muted mb-1.5">Product</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Era 59FIFTY fitted hats" style={INPUT_BG} className={INPUT} autoFocus={!initial} />
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">What each section is</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Team, size, colour…" style={INPUT_BG} className={INPUT} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Boxes per pallet</label>
              <NumberInput integer value={bpp || ""} onValue={setBpp} placeholder="e.g. 40" style={INPUT_BG} className={INPUT} />
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Price per unit</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                <NumberInput value={price || ""} onValue={setPrice} placeholder="0.00" style={INPUT_BG} className={`${INPUT} pl-7`} />
              </div>
            </div>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-[12px] text-muted mb-1.5">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where it sits, condition, anything worth knowing" style={INPUT_BG} className={INPUT} />
          </div>
        </div>
      </div>

      <div className={`${CARD} p-5 mb-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <div className="text-[14px] font-semibold text-ink">{plural(shown).replace(/^./, (c) => c.toUpperCase())}</div>
            <div className="text-[12px] text-muted tabular-nums">{n0(boxes)} boxes · {n0(units)} units</div>
          </div>
          <button onClick={() => setPasting((v) => !v)} className={BTN_SECONDARY}><ClipboardPaste size={13} /> Paste a list</button>
        </div>

        {pasting && (
          <div className="mb-4 p-3 rounded-lg bg-surface-2 border border-line">
            <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={5} autoFocus
              placeholder={"One per line: name, boxes, units per box\nYankees, 40, 24\nDodgers\t20\t24"}
              style={INPUT_BG} className="w-full border border-line px-3 py-2 rounded-lg text-[13px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
            <div className="flex items-center gap-2 mt-2">
              <button onClick={applyPaste} disabled={!pasteText.trim()} className={BTN_PRIMARY}>Add these</button>
              <span className="text-[12px] text-muted">
                Straight from a spreadsheet or a message. A name already listed gets its counts updated.
                {lastPerBox > 0 && ` Rows with no box size use ${lastPerBox}.`}
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_96px_110px_90px_32px] gap-2 text-[12px] text-muted px-1 mb-1.5">
          <div>Name</div><div className="text-right">Boxes</div><div className="text-right">Units per box</div><div className="text-right">Units</div><div />
        </div>
        {sections.map((s, i) => (
          <div key={s.id || `new-${i}`} className="grid grid-cols-[minmax(0,1fr)_96px_110px_90px_32px] gap-2 mb-1.5 items-center">
            <input value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={shown === "Section" ? "Name" : shown} style={INPUT_BG} className={INPUT} />
            <NumberInput integer value={s.boxes || ""} onValue={(n) => set(i, { boxes: n })} placeholder="0" style={INPUT_BG} className={`${INPUT} text-right tabular-nums`} />
            <NumberInput integer value={s.per_box || ""} onValue={(n) => set(i, { per_box: n })} placeholder="0" style={INPUT_BG} className={`${INPUT} text-right tabular-nums`} />
            <div className="text-right text-[13px] tabular-nums text-muted pr-1">{n0(s.boxes * s.per_box)}</div>
            <button onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${s.name || "row"}`}
              className="h-9 flex items-center justify-center text-faint hover:text-danger-ink transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button onClick={addRow} className="mt-1 text-[12px] font-medium text-accent hover:text-accent-hover inline-flex items-center gap-1">
          <Plus size={13} /> Add {shown === "Section" ? "a section" : shown.toLowerCase()}
        </button>
        {initial && (
          <p className="text-[12px] text-muted mt-3">A changed box count is saved to the history as a recount.</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={saving || !name.trim()} className={BTN_PRIMARY}>{saving ? "Saving…" : initial ? "Save" : "Add product"}</button>
      </div>
    </div>
  );
}
