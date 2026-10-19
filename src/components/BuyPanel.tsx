// R-488: what one warehouse product or delivery cost, and every order taken from it.
//   No buy yet: what was paid for it (the supplier, how many, the price, the shipping in).
//   With a buy: what it has made, the payments that paid it, and every order with its share.
// Every share and figure is worked out by buy_core.rs (the same file on the desktop and the server);
// this screen only draws them and sends what was typed.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Banknote, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { api, type BuyDetail, type BuyInput, type BuyKind, type BuyOrder, type UnallocatedTxn } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { canSeePayments } from "../lib/dealPayments";
import { useSessionMe } from "../lib/useSessionMe";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

type Unit = "units" | "pairs";
const one = (u: Unit) => (u === "pairs" ? "pair" : "unit");
/** A price a unit: cents as usual, and up to four places under a dollar ($0.0273), never fewer than two. */
const per = (n: number) => (Math.abs(n) < 1 && Math.abs(n) > 0 ? `$${n.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1")}` : fmtAmount(n));

export default function BuyPanel({ itemId, loadId, stockName, unit, defaultUnits, onChanged }: {
  itemId?: string; loadId?: string; stockName: string; unit: Unit; defaultUnits: number; onChanged?: () => void;
}) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [detail, setDetail] = useState<BuyDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { buy } = await api.warehouseBuyFor({ itemId, loadId });
      setDetail(buy ? await api.getWarehouseBuy(buy.id) : null);
    } catch (e) { toast(`Couldn't load what this cost: ${e}`, "error"); setDetail(null); }
  }, [itemId, loadId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { if (!editing) load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load, editing]);

  const changed = (d: BuyDetail) => { setDetail(d); onChanged?.(); };

  if (detail === undefined) return <div className="text-[13px] text-muted py-10 text-center">Loading…</div>;
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
  return <BuyView d={detail} unit={unit} numbers={numbers} onEdit={() => setEditing(true)} onChanged={changed} onRemoved={() => { setDetail(null); onChanged?.(); }} />;
}

// ─── Recording or changing what was paid ─────────────────────────────────────────

function BuyForm({ unit, stockName, defaultUnits, detail, onSave, onCancel }: {
  unit: Unit; stockName: string; defaultUnits: number; detail: BuyDetail | null;
  onSave: (input: BuyInput) => Promise<void>; onCancel?: () => void;
}) {
  const b = detail?.buy;
  const [supplier, setSupplier] = useState(b?.supplier_name ?? "");
  const [supplierId, setSupplierId] = useState(b?.supplier_id ?? "");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [units, setUnits] = useState<number>(b?.units_bought ?? Math.max(0, Math.round(defaultUnits)));
  const [total, setTotal] = useState<number>(b?.goods_total ?? 0);
  const [each, setEach] = useState<number>(b && b.units_bought > 0 ? Math.round((b.goods_total / b.units_bought) * 10000) / 10000 : 0);
  const [ship, setShip] = useState<number>(b?.ship_total ?? 0);
  const [name, setName] = useState(b?.name ?? stockName);
  const [notes, setNotes] = useState(b?.notes ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supplier.trim() || supplier === b?.supplier_name) { setResults([]); return; }
    const t = setTimeout(() => api.searchSuppliers(supplier).then((r) => setResults(r.slice(0, 6))).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [supplier, b?.supplier_name]);

  // A corrected count never changes what was paid: the price a unit follows the total.
  const setUnitsKeep = (n: number) => {
    setUnits(n);
    if (total > 0) setEach(n > 0 ? Math.round((total / n) * 10000) / 10000 : 0);
    else setTotal(Math.round(n * each * 100) / 100);
  };
  const setEachKeep = (v: number) => { setEach(v); setTotal(Math.round(units * v * 100) / 100); };
  const setTotalKeep = (v: number) => { setTotal(v); setEach(units > 0 ? Math.round((v / units) * 10000) / 10000 : 0); };
  const landed = units > 0 ? (total + ship) / units : 0;

  const save = async () => {
    if (!(units > 0)) { toast(`Enter how many ${unit} were bought.`, "error"); return; }
    setBusy(true);
    try {
      await onSave({ name: name.trim() || stockName, supplier_name: supplier.trim(), supplier_id: supplierId || undefined, units_bought: units, goods_total: total, ship_total: ship, notes });
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
        <label className="block relative">
          <span className="text-[12px] font-medium text-ink-2">Supplier</span>
          <input value={supplier} onChange={(e) => { setSupplier(e.target.value); setSupplierId(""); }} placeholder="Who you bought it from"
            className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
          {results.length > 0 && (
            <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg overflow-hidden">
              {results.map((s) => (
                <button key={s.id} onClick={() => { setSupplier(s.name); setSupplierId(s.id); setResults([]); }}
                  className="w-full text-left px-3 py-2 text-[13px] text-ink hover:bg-surface-2">{s.name}</button>
              ))}
            </div>
          )}
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">How many {unit} you bought</span>
          <NumberInput integer value={units} onValue={setUnitsKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">Paid a {one(unit)}</span>
            <NumberInput value={each} onValue={setEachKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">Paid in all</span>
            <NumberInput value={total} onValue={setTotalKeep} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          </label>
        </div>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Shipping in</span>
          <NumberInput value={ship} onValue={setShip} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
          <span className="block text-[11.5px] text-muted mt-1">What it cost to get it here. Leave it at 0 until you know it: adding it later updates every order already sold.</span>
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap border-t border-line pt-4">
        <div className="text-[13px] text-ink-2 tabular-nums">
          {units > 0 ? <>Each {one(unit)} costs <span className="font-semibold text-ink">{per(landed)}</span>{ship > 0 ? " with the shipping in" : ""}</> : "Enter how many were bought"}
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

function BuyView({ d, unit, numbers, onEdit, onChanged, onRemoved }: {
  d: BuyDetail; unit: Unit; numbers: boolean; onEdit: () => void; onChanged: (d: BuyDetail) => void; onRemoved: () => void;
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
  const canRemove = live.length === 0 && d.payments.length === 0;
  const m = (n: number) => (numbers ? fmtAmount(n) : "–");

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{b.name}</h3>
          <p className="text-[12.5px] text-muted mt-0.5">
            {b.supplier_name ? `Bought from ${b.supplier_name}: ` : "Bought: "}
            {n0(r.bought)} {unit} for {m(r.goods_total)}{r.ship_total > 0 ? `, and ${m(r.ship_total)} shipping in` : ", shipping in not added yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {r.sold_out && <StatusPill tone="success" size="md">Sold out</StatusPill>}
          <button onClick={onEdit} className={WH_BTN_SECONDARY}><Pencil size={13} /> Change</button>
        </div>
      </div>

      {numbers && (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Tile label="Made on what is sold" value={fmtAmount(r.made_on_sold)} tone={r.made_on_sold >= 0 ? "good" : "bad"}
            sub={`${m(r.sales)} sold, ${m(r.cost_sold)} of it cost`} />
          <Tile label={r.sold_out ? "Made on this buy" : "Made so far"} value={fmtAmount(r.made_so_far)} tone={r.made_so_far >= 0 ? "good" : "bad"}
            sub={r.sold_out ? "Everything is sold: this is the exact profit, once every buyer has paid" : "Money in less everything it cost, with what is left counted at nothing"} />
          <Tile label={`Cost a ${one(unit)}`} value={per(r.unit_cost)}
            sub={r.ship_total > 0 ? `${per(d.unit_goods)} paid, ${per(d.unit_ship)} shipping in` : "Shipping in not added yet"} />
          <Tile label="Sold" value={`${n0(r.sold)} of ${n0(r.bought)}`} sub={`${n0(r.left)} ${unit} left on hand`} />
        </div>
      )}
      {!numbers && <Tile label="Sold" value={`${n0(r.sold)} of ${n0(r.bought)}`} sub={`${n0(r.left)} ${unit} left on hand`} />}

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

      {numbers && <Payments d={d} busy={busy} run={run} />}

      <div className={`${WH_CARD} overflow-hidden`}>
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
  const group = (kind: BuyKind) => d.payments.filter((p) => p.kind === kind);
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
        {d.can_book_bank !== false && (
          adding === kind
            ? <PayPicker kind={kind} buyId={d.buy.id} onDone={(v) => { setAdding(null); if (v) run("pay", async () => v); }} onCancel={() => setAdding(null)} />
            : <button onClick={() => setAdding(kind)} className="inline-flex items-center gap-1.5 text-[12.5px] text-accent-hover hover:underline"><Plus size={13} /> Add a payment</button>
        )}
      </div>
    </div>
  );
  return (
    <div className={`${WH_CARD} p-4`}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {section("goods", "Paid to the supplier", r.goods_paid, r.goods_total)}
        {section("ship", "Shipping in", r.ship_paid, r.ship_total)}
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
