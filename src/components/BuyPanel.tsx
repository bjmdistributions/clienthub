// R-488: what one warehouse product or delivery cost, and every order taken from it.
//   No buy yet: what was paid for it (the supplier, how many, the price, the shipping in).
//   With a buy: what it has made, the payments that paid it, and every order with its share.
// Every share and figure is worked out by buy_core.rs (the same file on the desktop and the server);
// this screen only draws them and sends what was typed.
// R-551: a buy may be opened by itself (`buyId`), before its stock is here: it then has no product or delivery. Across the
// top four steps (Paid, Shipping in, Arrived, Selling), then the Shipping in section with its trucks (BuyShipping).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Banknote, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, type BuyDetail, type BuyInput, type BuyKind, type BuyOrder, type UnallocatedTxn } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { buySteps, costEachLine, perUnit, type StepKey } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { can, isAdmin } from "../lib/permissions";
import { useSessionMe } from "../lib/useSessionMe";
import BuyShipping from "./BuyShipping";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

type Unit = "units" | "pairs";
const one = (u: Unit) => (u === "pairs" ? "pair" : "unit");
/** A price a unit: cents as usual, and up to four places under $10 ($1.2827), never fewer than two. */
const per = perUnit;

export default function BuyPanel({ itemId, loadId, buyId, stockName, unit = "units", defaultUnits = 0, onChanged, onAddManifest, onOpenWarehouse }: {
  itemId?: string; loadId?: string;
  /** R-551: open this buy itself. A buy still on the way has no product or delivery to find it by. */
  buyId?: string;
  stockName: string; unit?: Unit; defaultUnits?: number; onChanged?: () => void;
  /** R-551: Add the manifest, on a buy still on the way (the Warehouse's one import, for this buy). */
  onAddManifest?: (b: { id: string; name: string }) => void;
  /** R-551: Open in the Warehouse, once the buy is on its stock. Absent where the screen is the Warehouse itself. */
  onOpenWarehouse?: (d: BuyDetail) => void;
}) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [detail, setDetail] = useState<BuyDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const id = buyId ?? (await api.warehouseBuyFor({ itemId, loadId })).buy?.id;
      setDetail(id ? await api.getWarehouseBuy(id) : null);
    } catch (e) { toast(`Couldn't load what this cost: ${e}`, "error"); setDetail(null); }
  }, [itemId, loadId, buyId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { if (!editing) load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load, editing]);

  const changed = (d: BuyDetail) => { setDetail(d); onChanged?.(); };

  if (detail === undefined) return <div className="text-[13px] text-muted py-10 text-center">Loading…</div>;
  if (detail === null && buyId) return <div className="text-[13px] text-muted py-10 text-center">That buy is no longer here.</div>;
  if (detail === null || editing) {
    return (
      <BuyForm
        unit={unit} stockName={stockName} defaultUnits={defaultUnits} detail={detail}
        onCancel={detail ? () => setEditing(false) : undefined}
        onSave={async (input) => {
          const d = detail
            ? await api.updateWarehouseBuy(detail.buy.id, input)
            : await api.createWarehouseBuy({ ...input, item_id: itemId, load_id: loadId });
          setEditing(false);
          changed(d);
          if (!detail && d.orders.length) toast(`Saved. ${d.orders.length} ${d.orders.length === 1 ? "order already sold from it has" : "orders already sold from it have"} their cost now.`);
        }}
      />
    );
  }
  return (
    <BuyView
      d={detail} unit={detail.buy.load_id ? "pairs" : detail.buy.item_id ? "units" : unit} numbers={numbers}
      onEdit={() => setEditing(true)} onChanged={changed} onReload={load} onRemoved={() => { setDetail(null); onChanged?.(); }}
      onAddManifest={isAdmin(me) || can(me, "deal_flow:edit") ? onAddManifest : undefined} onOpenWarehouse={onOpenWarehouse}
    />
  );
}

// ─── Recording or changing what was paid ─────────────────────────────────────────

/** The supplier, searched as it is typed. The one field a buy has for who it was bought from (R-551: a new buy uses it too). */
export function SupplierField({ name, saved, onChange }: {
  name: string; /** The name already saved on the buy, which needs no search. */ saved?: string; onChange: (name: string, id: string) => void;
}) {
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!name.trim() || name === saved) { setResults([]); return; }
    const t = setTimeout(() => api.searchSuppliers(name).then((r) => setResults(r.slice(0, 6))).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [name, saved]);
  return (
    <label className="block relative">
      <span className="text-[12px] font-medium text-ink-2">Supplier</span>
      <input value={name} onChange={(e) => onChange(e.target.value, "")} placeholder="Who you bought it from"
        className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
      {results.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg overflow-hidden">
          {results.map((s) => (
            <button key={s.id} type="button" onClick={() => { onChange(s.name, s.id); setResults([]); }}
              className="w-full text-left px-3 py-2 text-[13px] text-ink hover:bg-surface-2">{s.name}</button>
          ))}
        </div>
      )}
    </label>
  );
}

/** R-551: start a buy before its stock is here: what it is, who from, what you pay for the load, and how many if you know. */
export function NewBuyForm({ onSaved, onCancel }: { onSaved: (d: BuyDetail) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [supplier, setSupplier] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [total, setTotal] = useState<number>(0);
  const [units, setUnits] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { toast("Say what it is.", "error"); return; }
    setBusy(true);
    try {
      onSaved(await api.createWarehouseBuy({ name: name.trim(), supplier_name: supplier.trim(), supplier_id: supplierId || undefined, goods_total: total, units_bought: units > 0 ? units : 0 }));
    } catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className={`${WH_CARD} p-5 space-y-5 max-w-[720px]`}>
      <div>
        <h3 className="text-[15px] font-semibold text-ink">New buy</h3>
        <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
          Start it before the stock is here. Send it to logistics to bring it in, then add its manifest when it arrives: the delivery it makes becomes this buy's stock.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">What it is</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Like: Nike shoes, 110 pallets" className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
        <SupplierField name={supplier} onChange={(n, i) => { setSupplier(n); setSupplierId(i); }} />
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">What you pay for the load</span>
          <NumberInput value={total} onValue={setTotal} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          <span className="block text-[11.5px] text-muted mt-1">The total for the goods, without the shipping.</span>
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">How many (if you know)</span>
          <NumberInput integer value={units || ""} onValue={setUnits} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          <span className="block text-[11.5px] text-muted mt-1">Leave it empty and the manifest fills it in.</span>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <button onClick={onCancel} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : "Save the buy"}</button>
      </div>
    </div>
  );
}

function BuyForm({ unit, stockName, defaultUnits, detail, onSave, onCancel }: {
  unit: Unit; stockName: string; defaultUnits: number; detail: BuyDetail | null;
  onSave: (input: BuyInput) => Promise<void>; onCancel?: () => void;
}) {
  const b = detail?.buy;
  // R-551: a buy still on the way may leave how many were bought empty, and a buy with a live truck takes its shipping in from them.
  const onTheWay = !!b?.on_the_way;
  const shipLocked = (detail?.truck_cost.live ?? 0) > 0;
  const [supplier, setSupplier] = useState(b?.supplier_name ?? "");
  const [supplierId, setSupplierId] = useState(b?.supplier_id ?? "");
  const [units, setUnits] = useState<number>(b?.units_bought ?? Math.max(0, Math.round(defaultUnits)));
  const [total, setTotal] = useState<number>(b?.goods_total ?? 0);
  const [each, setEach] = useState<number>(b && b.units_bought > 0 ? Math.round((b.goods_total / b.units_bought) * 10000) / 10000 : 0);
  const [ship, setShip] = useState<number>(b?.ship_typed ?? 0);
  const [name, setName] = useState(b?.name ?? stockName);
  const [notes, setNotes] = useState(b?.notes ?? "");
  const [busy, setBusy] = useState(false);

  // A corrected count never changes what was paid: the price a unit follows the total.
  const setUnitsKeep = (n: number) => {
    setUnits(n);
    if (total > 0) setEach(n > 0 ? Math.round((total / n) * 10000) / 10000 : 0);
    else setTotal(Math.round(n * each * 100) / 100);
  };
  const setEachKeep = (v: number) => { setEach(v); setTotal(Math.round(units * v * 100) / 100); };
  const setTotalKeep = (v: number) => { setTotal(v); setEach(units > 0 ? Math.round((v / units) * 10000) / 10000 : 0); };
  const landed = units > 0 ? (total + (shipLocked ? (b?.ship_total ?? 0) : ship)) / units : 0;

  const save = async () => {
    if (!(units > 0) && !onTheWay) { toast(`Enter how many ${unit} were bought.`, "error"); return; }
    setBusy(true);
    try {
      await onSave({
        name: name.trim() || stockName, supplier_name: supplier.trim(), supplier_id: supplierId || undefined, units_bought: units > 0 ? units : 0, goods_total: total,
        ...(shipLocked ? {} : { ship_total: ship }), notes,
      });
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className={`${WH_CARD} p-5 space-y-5 max-w-[720px]`}>
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{b ? "Change what this cost" : "What did you pay for this?"}</h3>
        <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
          Every order you send to an invoice from this stock gets its share of the cost on its deal, so you can see what each sale and the whole buy made.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SupplierField name={supplier} saved={b?.supplier_name} onChange={(n, i) => { setSupplier(n); setSupplierId(i); }} />
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">How many {unit} you bought{onTheWay ? " (if you know)" : ""}</span>
          <NumberInput integer value={onTheWay && !units ? "" : units} onValue={setUnitsKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          {onTheWay && <span className="block text-[11.5px] text-muted mt-1">Leave it empty and the manifest fills it in.</span>}
        </label>
        <div className="grid grid-cols-2 gap-3">
          {!onTheWay && (
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">Paid a {one(unit)}</span>
              <NumberInput value={each} onValue={setEachKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
            </label>
          )}
          <label className={`block ${onTheWay ? "col-span-2" : ""}`}>
            <span className="text-[12px] font-medium text-ink-2">Paid in all</span>
            <NumberInput value={total} onValue={setTotalKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          </label>
        </div>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Shipping in</span>
          {shipLocked ? (
            <>
              <div className={`${WH_INPUT} mt-1 flex items-center tabular-nums text-ink-2 bg-surface-2`}>{fmtAmount(b?.ship_total ?? 0)}</div>
              <span className="block text-[11.5px] text-muted mt-1">From the trucks. It follows what each one costs, so there is nothing to type here.</span>
            </>
          ) : (
            <>
              <NumberInput value={ship} onValue={setShip} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
              <span className="block text-[11.5px] text-muted mt-1">What it cost to get it here. Leave it at 0 until you know it: adding it later updates every order already sold. Once you send it to logistics, the trucks set it.</span>
            </>
          )}
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap border-t border-line pt-4">
        <div className="text-[13px] text-ink-2 tabular-nums">
          {units > 0 ? <>Each {one(unit)} costs <span className="font-semibold text-ink">{per(landed)}</span>{(shipLocked ? (b?.ship_total ?? 0) : ship) > 0 ? " with the shipping in" : ""}</> : onTheWay ? "The manifest fills in how many were bought" : "Enter how many were bought"}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>}
          <button onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : b ? "Save changes" : "Save the buy"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── A recorded buy ──────────────────────────────────────────────────────────────

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  const clr = tone === "good" ? "text-success-ink" : tone === "bad" ? "text-danger-ink" : "text-ink";
  return (
    <div className={`${WH_CARD} px-4 py-3 min-w-0`}>
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={`text-[20px] font-bold tabular-nums mt-0.5 ${clr}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-muted mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}

/** R-551: where each step of a buy lives on its screen; clicking a step scrolls to it. */
const SECTION: Record<StepKey, string> = { paid: "buy-sec-paid", ship: "buy-sec-ship", arrived: "buy-sec-arrived", selling: "buy-sec-selling" };

function BuyView({ d, unit, numbers, onEdit, onChanged, onReload, onRemoved, onAddManifest, onOpenWarehouse }: {
  d: BuyDetail; unit: Unit; numbers: boolean; onEdit: () => void; onChanged: (d: BuyDetail) => void; onReload: () => void; onRemoved: () => void;
  onAddManifest?: (b: { id: string; name: string }) => void; onOpenWarehouse?: (d: BuyDetail) => void;
}) {
  const r = d.rollup;
  const b = d.buy;
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, f: () => Promise<BuyDetail | void>) => {
    setBusy(key);
    try { const v = await f(); if (v) onChanged(v); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };
  const live = d.orders.filter((o) => !o.undone);
  const back = d.orders.filter((o) => o.undone);
  const canRemove = live.length === 0 && d.payments.length === 0 && d.truck_cost.live === 0;
  const m = (n: number) => (numbers ? fmtAmount(n) : "–");
  const steps = buySteps(d, numbers);
  const goTo = (k: StepKey) => document.getElementById(SECTION[k])?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{b.name}</h3>
          <p className="text-[12.5px] text-muted mt-0.5">
            {b.on_the_way
              ? <>{b.supplier_name ? `Bought from ${b.supplier_name}: ` : "Bought: "}{b.units_bought > 0 ? `${n0(r.bought)} ${unit} for ` : ""}{m(r.goods_total)}{r.ship_total > 0 ? `, and ${m(r.ship_total)} shipping in so far` : ", no truck yet"}</>
              : <>{b.supplier_name ? `Bought from ${b.supplier_name}: ` : "Bought: "}{n0(r.bought)} {unit} for {m(r.goods_total)}{r.ship_total > 0 ? `, and ${m(r.ship_total)} shipping in` : ", shipping in not added yet"}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {r.sold_out && <StatusPill tone="success" size="md">Sold out</StatusPill>}
          <button onClick={onEdit} className={WH_BTN_SECONDARY}><Pencil size={13} /> Change</button>
        </div>
      </div>

      <ol className="grid grid-cols-2 xl:grid-cols-4 gap-2 list-none m-0 p-0" aria-label="Where this buy is">
        {steps.map((s) => (
          <li key={s.key} className="min-w-0">
            <button type="button" onClick={() => goTo(s.key)}
              className={`${WH_CARD} w-full text-left px-3.5 py-2.5 hover:bg-surface-2/60 transition-colors duration-[130ms]`}>
              <span className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold text-ink">{s.label}</span>
                <StatusPill tone={s.tone}>{s.word}</StatusPill>
              </span>
              <span className="block text-[12px] text-muted mt-1 truncate min-h-[16px]">{s.line}</span>
            </button>
          </li>
        ))}
      </ol>

      {b.on_the_way ? (
        numbers && (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Tile label="You pay for the load" value={fmtAmount(b.goods_total)} sub={r.goods_paid > 0 ? `${fmtAmount(r.goods_paid)} paid` : "Not paid yet"} />
            <Tile label="Shipping in so far" value={fmtAmount(b.ship_total)} sub={d.truck_cost.live > 0 ? `${d.truck_cost.live} ${d.truck_cost.live === 1 ? "truck" : "trucks"}` : "No truck yet"} />
            {b.markup_total > 0 && <Tile label="His markup on the trucks" value={fmtAmount(b.markup_total)} sub="Counted in the cost" />}
            <Tile label={`Cost a ${one(unit)}`} value={b.units_bought > 0 ? per(r.unit_cost) : "Not known yet"} sub={b.units_bought > 0 ? undefined : "The manifest fills in how many"} />
          </div>
        )
      ) : (
        <>
          {numbers && (
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <Tile label="Made on what is sold" value={fmtAmount(r.made_on_sold)} tone={r.made_on_sold >= 0 ? "good" : "bad"}
                sub={`${m(r.sales)} sold, ${m(r.cost_sold)} of it cost`} />
              <Tile label={r.sold_out ? "Made on this buy" : "Made so far"} value={fmtAmount(r.made_so_far)} tone={r.made_so_far >= 0 ? "good" : "bad"}
                sub={r.sold_out ? "Everything is sold: this is the exact profit, once every buyer has paid" : "Money in less everything it cost, with what is left counted at nothing"} />
              <Tile label={`Cost a ${one(unit)}`} value={per(r.unit_cost)}
                sub={r.ship_total > 0 ? undefined : "Shipping in not added yet"} />
              <Tile label="Sold" value={`${n0(r.sold)} of ${n0(r.bought)}`} sub={`${n0(r.left)} ${unit} left on hand`} />
            </div>
          )}
          {!numbers && <Tile label="Sold" value={`${n0(r.sold)} of ${n0(r.bought)}`} sub={`${n0(r.left)} ${unit} left on hand`} />}
        </>
      )}
      {numbers && b.units_bought > 0 && (
        <p className="text-[12.5px] text-ink-2 tabular-nums">{costEachLine({ goods: d.unit_goods, ship: d.unit_ship, markup: d.unit_markup }, one(unit))}</p>
      )}

      {r.oversold && (
        <Notice tone="warning">More {unit} were sold than this buy says were bought. Check how many were bought: the orders past it carry no cost.</Notice>
      )}
      {d.missing.length > 0 && (
        <Notice tone="warning" action={<button onClick={() => run("missing", () => api.addMissingWarehouseBuyOrders(b.id))} disabled={!!busy} className={WH_BTN_SECONDARY}>{busy === "missing" ? "Adding…" : "Add them"}</button>}>
          {d.missing.length === 1 ? `Invoice ${d.missing[0].number || "without a number"} took` : `${d.missing.length} invoices (${d.missing.map((x) => x.number).filter(Boolean).slice(0, 4).join(", ")}) took`} stock from here without its cost reaching the deal.
          {d.missing.some((x) => x.own_cost) ? " A deal with a supplier cost already typed keeps it." : ""}
        </Notice>
      )}
      {!d.in_step && (
        <Notice tone="warning" action={<button onClick={() => run("apply", () => api.applyWarehouseBuy(b.id))} disabled={!!busy} className={WH_BTN_SECONDARY}><RefreshCw size={13} className={busy === "apply" ? "animate-spin" : ""} /> Bring up to date</button>}>
          {d.can_book_bank === false
            ? "The bank payment is not tied to every order yet. Someone with the Financials switch can bring it up to date."
            : "The costs on some deals are not what this buy says. Bring them up to date."}
        </Notice>
      )}

      <div id={SECTION.paid} className="scroll-mt-4">{numbers && <Payments d={d} busy={busy} run={run} />}</div>

      <BuyShipping d={d} numbers={numbers} onChanged={onReload} />

      <div id={SECTION.arrived} className={`${WH_CARD} px-4 py-3 scroll-mt-4`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">Arrived</div>
            <p className="text-[12.5px] text-muted mt-0.5">
              {b.on_the_way
                ? "The stock is not here yet. When the truck is unloaded, add the manifest: the delivery it makes becomes this buy's stock."
                : `In the warehouse${b.stock_name ? `: ${b.stock_name}` : ""}.`}
            </p>
          </div>
          {b.on_the_way && onAddManifest && <button type="button" onClick={() => onAddManifest({ id: b.id, name: b.name })} className={WH_BTN_PRIMARY}>Add the manifest</button>}
          {!b.on_the_way && onOpenWarehouse && <button type="button" onClick={() => onOpenWarehouse(d)} className={WH_BTN_SECONDARY}>Open in the Warehouse</button>}
        </div>
      </div>

      <div id={SECTION.selling} className={`${WH_CARD} overflow-hidden scroll-mt-4`}>
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <span className="text-[13px] font-semibold text-ink">Orders from this buy</span>
          <span className="text-[12px] text-muted">{live.length} {live.length === 1 ? "order" : "orders"}</span>
        </div>
        {live.length === 0 ? (
          <p className="text-[12.5px] text-muted px-4 py-6">No orders yet. Send an order to an invoice from this stock and it shows here with its cost.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted border-b border-line">
                  <th className="font-medium px-4 py-2">Invoice</th>
                  <th className="font-medium px-3 py-2">Buyer</th>
                  <th className="font-medium px-3 py-2 text-right">{unit === "pairs" ? "Pairs" : "Units"}</th>
                  {numbers && <th className="font-medium px-3 py-2 text-right">Cost</th>}
                  {numbers && <th className="font-medium px-3 py-2 text-right">Sold for</th>}
                  {numbers && <th className="font-medium px-3 py-2 text-right">Made</th>}
                  <th className="font-medium px-3 py-2">Supplier paid</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {live.map((o) => <OrderRow key={o.id} o={o} d={d} numbers={numbers} busy={busy} run={run} />)}
              </tbody>
            </table>
          </div>
        )}
        {back.length > 0 && (
          <div className="px-4 py-3 border-t border-line text-[12px] text-muted">
            Put back: {back.map((o) => `${o.number || "an invoice"} (${n0(o.count)})`).join(", ")}. Their cost went back to this buy.
          </div>
        )}
      </div>

      {canRemove && <RemoveBuy id={b.id} onRemoved={onRemoved} />}
    </div>
  );
}

function Notice({ tone, children, action }: { tone: "warning"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 flex-wrap rounded-xl border px-4 py-3 text-[12.5px] ${tone === "warning" ? "border-warning/30 bg-warning-bg text-warning-ink" : ""}`}>
      <span className="min-w-0 leading-relaxed">{children}</span>
      {action}
    </div>
  );
}

function OrderRow({ o, d, numbers, busy, run }: {
  o: BuyOrder; d: BuyDetail; numbers: boolean; busy: string | null; run: (k: string, f: () => Promise<BuyDetail | void>) => Promise<void>;
}) {
  const [typing, setTyping] = useState<number | null>(null);
  const status = o.own_cost
    ? <StatusPill tone="neutral" title="This deal had its supplier cost typed by hand before the buy was recorded, and keeps it">Own cost kept</StatusPill>
    : o.goods_paid ? <StatusPill tone="success">Paid</StatusPill>
    : <StatusPill tone="warning" title="No payment to the supplier covers this order yet">Not paid yet</StatusPill>;
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-2.5 whitespace-nowrap text-ink">{o.number || "No number"}{o.voided ? <span className="text-muted"> (voided)</span> : null}</td>
      <td className="px-3 py-2.5 text-ink-2 max-w-[220px] truncate">{o.client || "–"}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{n0(o.count)}</td>
      {numbers && (
        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
          {typing !== null ? (
            <span className="inline-flex items-center gap-1">
              <NumberInput value={typing} onValue={setTyping} autoFocus className={`${WH_INPUT} w-24 h-8 text-right`} style={WH_INPUT_BG}
                onKeyDown={(e) => { if (e.key === "Enter") run(o.id, () => api.updateWarehouseBuyOrder(d.buy.id, o.id, { goodsTyped: typing })).then(() => setTyping(null)); if (e.key === "Escape") setTyping(null); }} />
              <button onClick={() => run(o.id, () => api.updateWarehouseBuyOrder(d.buy.id, o.id, { goodsTyped: typing })).then(() => setTyping(null))} className="text-[12px] text-accent-hover px-1">Save</button>
            </span>
          ) : (
            <button disabled={o.own_cost} onClick={() => setTyping(o.goods)} className="hover:underline disabled:no-underline disabled:cursor-default"
              title={o.own_cost ? undefined : o.typed ? "Typed by hand. Click to change it." : "Worked out from the buy. Click to type a different cost for this order."}>
              {fmtAmount(o.cost)}{o.typed ? "*" : ""}
            </button>
          )}
        </td>
      )}
      {numbers && <td className="px-3 py-2.5 text-right tabular-nums">{fmtAmount(o.sales)}</td>}
      {numbers && <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${o.made >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(o.made)}</td>}
      <td className="px-3 py-2.5">{status}</td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap">
        {o.typed && numbers && (
          <button onClick={() => run(o.id, () => api.updateWarehouseBuyOrder(d.buy.id, o.id, { clearTyped: true }))} disabled={busy === o.id}
            className="text-[12px] text-muted hover:text-ink-2">Use the buy's cost</button>
        )}
      </td>
    </tr>
  );
}

function Payments({ d, busy, run }: { d: BuyDetail; busy: string | null; run: (k: string, f: () => Promise<BuyDetail | void>) => Promise<void> }) {
  const [adding, setAdding] = useState<BuyKind | null>(null);
  const r = d.rollup;
  // R-551: a bank row a truck's carrier was paid with is shown (and taken off) on that truck, in Shipping in.
  const onTruck = new Set(d.trucks.filter((t) => t.status !== "cancelled" && t.bank_txn_id).map((t) => t.bank_txn_id));
  const group = (kind: BuyKind) => d.payments.filter((p) => p.kind === kind && !(kind === "ship" && onTruck.has(p.txn_id)));
  const section = (kind: BuyKind, title: string, paid: number, total: number) => (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        <span className={`text-[12px] tabular-nums ${total > 0 && paid + 0.005 >= total ? "text-success-ink" : "text-muted"}`}>
          {total > 0 ? `${fmtAmount(paid)} of ${fmtAmount(total)} paid` : "Nothing to pay yet"}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {group(kind).map((p) => (
          <div key={p.txn_id} className="flex items-center justify-between gap-2 text-[12.5px] bg-surface-2 rounded-lg px-3 py-2">
            <span className="min-w-0 truncate text-ink-2">{p.posted_at.slice(0, 10)} · {p.name || (p.cash ? "Cash" : "Bank payment")}{p.cash ? " (cash)" : ""}</span>
            <span className="flex items-center gap-2 flex-shrink-0">
              <span className="tabular-nums text-ink">{fmtAmount(p.amount)}</span>
              {d.can_book_bank !== false && (
                <button title="Take this payment off the buy" disabled={busy === p.txn_id}
                  onClick={() => run(p.txn_id, () => api.unpayWarehouseBuy(d.buy.id, p.txn_id))} className="text-faint hover:text-danger-ink"><X size={13} /></button>
              )}
            </span>
          </div>
        ))}
        {d.can_book_bank !== false && !(kind === "ship" && d.truck_cost.live > 0) && (
          adding === kind
            ? <PayPicker kind={kind} buyId={d.buy.id} onDone={(v) => { setAdding(null); if (v) run("pay", async () => v); }} onCancel={() => setAdding(null)} />
            : <button onClick={() => setAdding(kind)} className="inline-flex items-center gap-1.5 text-[12.5px] text-accent-hover hover:underline"><Plus size={13} /> Add a payment</button>
        )}
      </div>
    </div>
  );
  // R-551: with trucks the shipping in is paid per truck (Tie the bank payment, in the Shipping in section below).
  const byTruck = d.truck_cost.live > 0;
  return (
    <div className={`${WH_CARD} p-4`}>
      <div className={`grid grid-cols-1 ${byTruck && group("ship").length === 0 ? "" : "md:grid-cols-2"} gap-5`}>
        {section("goods", "Paid to the supplier", r.goods_paid, r.goods_total)}
        {(!byTruck || group("ship").length > 0) && section("ship", "Paid for the shipping in", r.ship_paid, r.ship_total)}
      </div>
      {d.can_book_bank === false && <p className="text-[12px] text-muted mt-3">Tying a bank payment to a buy needs the Financials switch on your role.</p>}
    </div>
  );
}

/** Pick the bank row that paid it, or say it was paid in cash. */
function PayPicker({ kind, buyId, onDone, onCancel }: { kind: BuyKind; buyId: string; onDone: (d: BuyDetail | null) => void; onCancel: () => void }) {
  const [rows, setRows] = useState<UnallocatedTxn[] | null>(null);
  const [q, setQ] = useState("");
  const [cash, setCash] = useState(false);
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(localDay());
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.unallocatedBankTxns().then((r) => setRows(r.money_out.filter((t) => t.unallocated > 0.005))).catch(() => setRows([])); }, []);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows || []).filter((t) => words.every((w) => `${t.counterparty_name} ${t.description} ${t.amount.toFixed(2)} ${t.posted_at}`.toLowerCase().includes(w))).slice(0, 30);
  const pay = async (o: { txnId?: string; cashAmount?: number; cashDate?: string }) => {
    setBusy(true);
    try { onDone(await api.payWarehouseBuy(buyId, kind, o)); }
    catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className="border border-line rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setCash(false)} aria-pressed={!cash} className={`text-[12px] px-2.5 h-7 rounded-md ${!cash ? "bg-surface-2 text-ink font-medium" : "text-muted"}`}>A bank payment</button>
        <button onClick={() => setCash(true)} aria-pressed={cash} className={`text-[12px] px-2.5 h-7 rounded-md ${cash ? "bg-surface-2 text-ink font-medium" : "text-muted"}`}>Paid in cash</button>
        <button onClick={onCancel} className="ml-auto text-faint hover:text-ink-2"><X size={14} /></button>
      </div>
      {cash ? (
        <div className="flex items-end gap-2 flex-wrap">
          <label className="block"><span className="text-[12px] text-muted">Amount</span>
            <NumberInput value={amount} onValue={setAmount} className={`${WH_INPUT} w-32 mt-1 tabular-nums`} style={WH_INPUT_BG} /></label>
          <label className="block"><span className="text-[12px] text-muted">Paid on</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${WH_INPUT} w-40 mt-1`} style={WH_INPUT_BG} /></label>
          <button disabled={busy || !(amount > 0)} onClick={() => pay({ cashAmount: amount, cashDate: date })} className={WH_BTN_PRIMARY}><Banknote size={13} /> Save</button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, amount or date" className={`${WH_INPUT} pl-8`} style={WH_INPUT_BG} />
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {rows === null ? <p className="text-[12px] text-muted py-2">Loading…</p>
              : shown.length === 0 ? <p className="text-[12px] text-muted py-2">No money out that is not booked yet{q ? " matches that" : ""}.</p>
              : shown.map((t) => (
                <button key={t.id} disabled={busy} onClick={() => pay({ txnId: t.id })}
                  className="w-full flex items-center justify-between gap-2 text-left text-[12.5px] px-3 py-2 rounded-lg hover:bg-surface-2">
                  <span className="min-w-0 truncate text-ink-2">{t.posted_at.slice(0, 10)} · {t.counterparty_name || t.description}</span>
                  <span className="tabular-nums text-ink flex-shrink-0">{fmtAmount(t.unallocated)}{t.unallocated < t.original - 0.005 ? ` of ${fmtAmount(t.original)}` : ""}</span>
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function RemoveBuy({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="flex justify-end">
      {sure ? (
        <span className="inline-flex items-center gap-2">
          <span className="text-[12.5px] text-muted">Remove this buy? Nothing is on it yet.</span>
          <button onClick={async () => { try { await api.archiveWarehouseBuy(id); onRemoved(); } catch (e) { toast(String(e), "error"); } }} className={WH_BTN_PRIMARY}>Remove it</button>
          <button onClick={() => setSure(false)} className={WH_BTN_SECONDARY}>Keep it</button>
        </span>
      ) : (
        <button onClick={() => setSure(true)} className="text-[12.5px] text-muted hover:text-ink-2">Remove this buy</button>
      )}
    </div>
  );
}
