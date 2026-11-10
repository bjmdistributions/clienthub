// R-596: one purchase order. It is a buy (warehouse_buys) shown plainly: the invoice, what was counted in and the day, the refund
// owed for what never came and what has come in, the money, the payments, the trucks that bring it in, and every sale from it.
// buy_core.rs works every figure out (the same file on the desktop and the server); this screen only draws them and sends what
// was typed. Nothing goes in the warehouse unless Put in the warehouse is pressed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadDetail } from "../lib/deliveries";
import { listen } from "@tauri-apps/api/event";
import { Paperclip, Pencil, Plus, X } from "lucide-react";
import { api, type BuyDetail, type DealFlow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { openManifestForBuy, perUnit } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { can, isAdmin } from "../lib/permissions";
import { csvRowCount, dayWord, receivedProblem, STATE_TONE, STATE_WORD } from "../lib/purchases";
import { useSessionMe } from "../lib/useSessionMe";
import { MoneyPicture, Notice, OrderRow, PayPicker, Payments, RemoveBuy, Tile } from "./BuyPanel";
import BuyShipping from "./BuyShipping";
import NumberInput from "./NumberInput";
import PurchaseForm from "./PurchaseForm";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

type Run = (key: string, f: () => Promise<BuyDetail | void>) => Promise<void>;

export default function PurchasePanel({ buyId, onChanged, onOpenWarehouse, onRemoved, onShowPallets, onAddManifest }: {
  buyId: string; onChanged?: () => void; onOpenWarehouse?: (d: BuyDetail) => void; onRemoved: () => void;
  /** R-648: show this load's pallets on the map (Warehouse > Map). */
  onShowPallets?: (loadId: string) => void;
  /** R-648: import this load's manifest box by box, from inside the Warehouse (else it goes there). */
  onAddManifest?: (b: { id: string; name: string }) => void;
}) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [d, setD] = useState<BuyDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setD(await api.getWarehouseBuy(buyId)); }
    catch (e) { toast(`Couldn't load this order: ${e}`, "error"); setD(null); }
  }, [buyId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { if (!editing) load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load, editing]);

  const changed = (v: BuyDetail) => { setD(v); onChanged?.(); };
  const run: Run = async (key, f) => {
    setBusy(key);
    try { const v = await f(); if (v) changed(v); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };

  if (d === undefined) return <div className="text-[13px] text-muted py-10 text-center">Loading…</div>;
  if (d === null) return <div className="text-[13px] text-muted py-10 text-center">That order is no longer here.</div>;
  if (editing) return <PurchaseForm detail={d} onCancel={() => setEditing(false)} onSaved={(v) => { setEditing(false); changed(v); }} />;

  const b = d.buy;
  const r = d.rollup;
  const unit = b.load_id ? "pairs" : "units";
  const live = d.orders.filter((o) => !o.undone);
  const canRemove = live.length === 0 && d.payments.length === 0 && d.truck_cost.live === 0 && !b.from_deal_id;
  const canEdit = isAdmin(me) || can(me, "deal_flow:edit");

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-ink">{b.name}</h3>
            <StatusPill tone={STATE_TONE[r.state]} size="md">{STATE_WORD[r.state]}</StatusPill>
          </div>
          <p className="text-[12.5px] text-muted mt-0.5">
            {[b.supplier_name ? `From ${b.supplier_name}` : "", b.invoice_no ? `Invoice ${b.invoice_no}` : "", dayWord(b.invoice_date)].filter(Boolean).join(" · ") || "No supplier or invoice number yet"}
          </p>
        </div>
        <button onClick={() => setEditing(true)} className={WH_BTN_SECONDARY}><Pencil size={13} /> Change</button>
      </div>

      {b.from_deal_id && <MovedFromDeal d={d} canEdit={canEdit} onUndone={() => { onChanged?.(); onRemoved(); }} />}

      {numbers && (
        // R-648: what Jack asked to see first: how much product, the goods and the shipping, and what each unit cost.
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Tile label="Units" value={`${n0(Math.max(0, r.left))} left`} sub={`of ${n0(r.bought)} ${unit === "pairs" ? "pairs" : "units"}, ${n0(r.sold)} sold`} />
          <Tile label="Goods" value={fmtAmount(r.goods_total)} sub={b.lines.length > 0 ? `${b.lines.length} ${b.lines.length === 1 ? "line" : "lines"} on the invoice` : "The invoice total"} />
          <Tile label="Shipping in" value={fmtAmount(r.ship_total)} sub={d.truck_cost.live > 0 ? `${d.truck_cost.live} ${d.truck_cost.live === 1 ? "truck" : "trucks"}` : "Typed, no truck linked"} />
          <Tile label="Average a unit" value={r.bought > 0 ? perUnit(r.unit_cost) : "Not known yet"} faded={r.cost_projected}
            sub={r.cost_projected ? "Refund owed: it settles when the money comes in" : r.bought > 0 ? "Goods and shipping, over every unit" : "Enter how many came"} />
        </div>
      )}
      {numbers && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tile label="Money spent" value={fmtAmount(r.spent)} sub={r.refund_received > 0.005 ? `Paid, less ${fmtAmount(r.refund_received)} refunded` : "Paid to the supplier and for the shipping in"} />
          <Tile label="Still owed to the supplier" value={fmtAmount(r.owed_supplier)} tone={r.owed_supplier > 0.005 ? "bad" : undefined}
            sub={r.owed_supplier > 0.005 ? `${fmtAmount(r.goods_paid)} of ${fmtAmount(r.goods_total)} paid` : "The invoice is paid"} />
          <Tile label="Refund owed to you" value={fmtAmount(r.refund_left)} tone={r.refund_left > 0.005 ? "bad" : undefined}
            sub={r.refund_owed > 0.005 ? `${fmtAmount(r.refund_owed)} owed, ${fmtAmount(r.refund_received)} in` : "Nothing owed"} />
        </div>
      )}

      {r.oversold && <Notice tone="warning">More {unit} were sold than this order counted in. Check how many arrived: the sales past it carry no cost.</Notice>}
      {!d.in_step && (
        <Notice tone="warning" action={<button onClick={() => run("apply", () => api.applyWarehouseBuy(b.id))} disabled={!!busy} className={WH_BTN_SECONDARY}>Bring up to date</button>}>
          {d.can_book_bank === false
            ? "The bank payment is not tied to every sale yet. Someone with the Financials switch can bring it up to date."
            : "The costs on some deals are not what this order says. Bring them up to date."}
        </Notice>
      )}

      <InvoiceCard d={d} numbers={numbers} />
      <ReceivedCard d={d} canEdit={canEdit} busy={busy} run={run} />
      <RefundCard d={d} numbers={numbers} canEdit={canEdit} busy={busy} run={run} />

      {numbers && <Payments d={d} busy={busy} run={run} />}
      <BuyShipping d={d} numbers={numbers} onChanged={load} />

      <Pallets buyId={b.id} name={b.name} canEdit={canEdit} onShow={onShowPallets} />

      {b.on_the_way ? (
        // R-648: boxes are never needed. Importing a manifest box by box stays one quiet line away.
        canEdit && <p className="text-[12px] text-muted px-1">Need it box by box? <button type="button" onClick={() => (onAddManifest ?? openManifestForBuy)({ id: b.id, name: b.name })} className="text-ink-2 hover:text-ink hover:underline">Import its manifest</button></p>
      ) : (
        <div className={`${WH_CARD} px-4 py-3`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">Older stock</div>
              <p className="text-[12.5px] text-muted mt-0.5">{`Counted box by box in the warehouse${b.stock_name ? `: ${b.stock_name}` : ""}.`}</p>
            </div>
            {onOpenWarehouse && <button type="button" onClick={() => onOpenWarehouse(d)} className={WH_BTN_SECONDARY}>Open it</button>}
          </div>
        </div>
      )}

      {numbers && r.bought > 0 && <MoneyPicture d={d} unit={unit} />}

      <div className={`${WH_CARD} overflow-hidden`}>
        <div className="px-4 py-3 border-b border-line flex items-center justify-between">
          <span className="text-[13px] font-semibold text-ink">Sales from this load</span>
          <span className="text-[12px] text-muted">{n0(r.sold)} of {n0(r.bought)} sold, {n0(r.left)} left{numbers && r.sold > 0 ? `, made ${fmtAmount(r.made_so_far)}` : ""}</span>
        </div>
        {live.length === 0 ? (
          <p className="text-[12.5px] text-muted px-4 py-6">No sales yet. On an invoice, choose this load under From purchase order and say how many, or import Whatnot sales from the Loads list.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted border-b border-line">
                  <th className="font-medium px-4 py-2">Invoice</th>
                  <th className="font-medium px-3 py-2">Buyer</th>
                  <th className="font-medium px-3 py-2 text-right">Units</th>
                  {numbers && <th className="font-medium px-3 py-2 text-right">Cost</th>}
                  {numbers && <th className="font-medium px-3 py-2 text-right">Sold for</th>}
                  {numbers && <th className="font-medium px-3 py-2 text-right">Made</th>}
                  <th className="font-medium px-3 py-2">Supplier paid</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>{live.map((o) => <OrderRow key={o.id} o={o} d={d} unit="units" numbers={numbers} busy={busy} run={run} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      {canRemove && <RemoveBuy id={b.id} onRemoved={onRemoved} />}
      {b.notes && <p className="text-[12.5px] text-muted">Notes: {b.notes}</p>}
    </div>
  );
}

/** R-648: the pallets the load stands on (made by Receive a load, a delivery that holds only them), shown on the map; or,
 *  when it has none, Put it on pallets, asked the same way. */
function Pallets({ buyId, name, canEdit, onShow }: { buyId: string; name: string; canEdit: boolean; onShow?: (loadId: string) => void }) {
  const [held, setHeld] = useState<LoadDetail | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [count, setCount] = useState(0);
  const [spot, setSpot] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    try {
      const mine = (await api.listWarehouseLoads()).find((l) => l.buy_id === buyId && !l.archived);
      setHeld(mine ? await api.getWarehouseLoad(mine.id) : null);
    } catch { setHeld(null); }
  }, [buyId]);
  useEffect(() => { read(); }, [read]);
  if (held === undefined) return null;
  const pallets = held ? held.pallets.filter((p) => p.recorded) : [];
  const places = [...new Set(pallets.map((p) => p.location).filter(Boolean))];
  const save = async () => {
    if (!(count >= 1 && count <= 60)) { toast("Say how many pallets, 1 to 60.", "error"); return; }
    setBusy(true);
    try { await api.createLoadPallets(name, buyId, count, spot.trim()); setAsking(false); await read(); toast(`${count} ${count === 1 ? "pallet" : "pallets"} on the map. Place them on the Map tab.`); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className={`${WH_CARD} px-4 py-3`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">Pallets</div>
          <p className="text-[12.5px] text-muted mt-0.5">
            {held ? `On ${pallets.length} ${pallets.length === 1 ? "pallet" : "pallets"}${places.length ? `, at ${places.join(", ")}` : ""}.` : "Not on pallets. It sits loose, so it is not on the map."}
          </p>
        </div>
        {held && onShow && <button type="button" onClick={() => onShow(held.load.id)} className={WH_BTN_SECONDARY}>Show on the map</button>}
        {!held && canEdit && !asking && <button type="button" onClick={() => setAsking(true)} className={WH_BTN_SECONDARY}>Put it on pallets</button>}
      </div>
      {asking && (
        <div className="flex items-end gap-3 flex-wrap mt-3">
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">How many pallets</span>
            <NumberInput integer value={count || ""} onValue={setCount} className={`${WH_INPUT} mt-1 tabular-nums w-28`} style={WH_INPUT_BG} />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">Where is it? (if you want)</span>
            <input value={spot} onChange={(e) => setSpot(e.target.value)} placeholder="Like: Bay 4" className={`${WH_INPUT} mt-1 w-48`} style={WH_INPUT_BG} />
          </label>
          <button type="button" onClick={() => setAsking(false)} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
          <button type="button" onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : "Put it on pallets"}</button>
        </div>
      )}
    </div>
  );
}

function InvoiceCard({ d, numbers }: { d: BuyDetail; numbers: boolean }) {
  const b = d.buy;
  return (
    <div className={`${WH_CARD} overflow-hidden`}>
      <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[13px] font-semibold text-ink">The invoice</span>
        <span className="text-[12.5px] text-ink-2 tabular-nums">{numbers ? fmtAmount(b.goods_total) : "-"} for {n0(b.units_bought)} {b.units_bought === 1 ? "unit" : "units"}</span>
      </div>
      {b.lines.length === 0 ? (
        <p className="text-[12.5px] text-muted px-4 py-4">Entered as a total. Change the order to type it line by line.</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-muted border-b border-line">
              <th className="font-medium px-4 py-2">What it is</th>
              <th className="font-medium px-3 py-2 text-right">How many</th>
              {numbers && <th className="font-medium px-3 py-2 text-right">Price each</th>}
              {numbers && <th className="font-medium px-4 py-2 text-right">Line total</th>}
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-ink">{l.what}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n0(l.qty)}</td>
                {numbers && <td className="px-3 py-2 text-right tabular-nums">{perUnit(l.price)}</td>}
                {numbers && <td className="px-4 py-2 text-right tabular-nums">{fmtAmount(l.qty * l.price)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** What was counted in, and the day. The day is always asked for. Attaching the manifest keeps only its file name. */
function ReceivedCard({ d, canEdit, busy, run }: { d: BuyDetail; canEdit: boolean; busy: string | null; run: Run }) {
  const b = d.buy;
  const r = d.rollup;
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState<number | null>(b.units_received);
  const [day, setDay] = useState(b.received_at);
  const [fromFile, setFromFile] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const startEdit = () => { setUnits(b.units_received); setDay(b.received_at); setOpen(true); };
  const save = () => {
    const bad = receivedProblem(units, day);
    if (bad) { toast(bad, "error"); return; }
    void run("received", () => api.updateWarehouseBuy(b.id, { units_received: units, received_at: day })).then(() => setOpen(false));
  };
  const attach = async (f: File | undefined) => {
    if (!f) return;
    // Only the file's name is kept. A spreadsheet saved as CSV can also give its row count as the unit count.
    let count: number | null = null;
    if (/\.(csv|txt)$/i.test(f.name)) { try { count = csvRowCount(await f.text()); } catch { count = null; } }
    setFromFile(count != null && count > 0 ? count : null);
    void run("manifest", () => api.updateWarehouseBuy(b.id, { manifest_name: f.name }));
    if (file.current) file.current.value = "";
  };

  return (
    <div className={`${WH_CARD} px-4 py-3`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">Received</div>
          <p className="text-[12.5px] text-muted mt-0.5">
            {b.units_received == null
              ? `Not counted yet. ${n0(r.units_ordered)} ordered.`
              : r.short > 0
                ? `${n0(b.units_received)} of ${n0(r.units_ordered)} got here on ${dayWord(b.received_at)}: ${n0(r.short)} short.`
                : `${n0(b.units_received)} of ${n0(r.units_ordered)} got here on ${dayWord(b.received_at)}.`}
          </p>
          {b.manifest_name && <p className="text-[12.5px] text-ink-2 mt-1 inline-flex items-center gap-1.5"><Paperclip size={12} /> Manifest: {b.manifest_name}</p>}
        </div>
        {canEdit && !open && (
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => file.current?.click()} disabled={!!busy} className={WH_BTN_SECONDARY}><Paperclip size={13} /> {b.manifest_name ? "Change manifest" : "Attach the manifest"}</button>
            <button type="button" onClick={startEdit} className={WH_BTN_PRIMARY}>{b.units_received == null ? "Count it in" : "Change the count"}</button>
          </div>
        )}
        <input ref={file} type="file" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} aria-label="Attach the manifest" />
      </div>
      {fromFile != null && !open && (
        <div className="mt-2 text-[12.5px] text-ink-2 flex items-center gap-2 flex-wrap">
          The file has {n0(fromFile)} rows.
          <button type="button" className="text-accent-hover hover:underline" onClick={() => { setUnits(fromFile); setDay(b.received_at); setOpen(true); }}>Use {n0(fromFile)} as the count</button>
          <button type="button" className="text-muted hover:text-ink-2" onClick={() => setFromFile(null)}>No thanks</button>
        </div>
      )}
      {open && (
        <div className="mt-3 flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="text-[12px] text-muted">How many arrived</span>
            <NumberInput integer value={units ?? ""} onValue={(n, raw) => setUnits(raw.trim() === "" ? null : n)} autoFocus className={`${WH_INPUT} w-32 mt-1 tabular-nums`} style={WH_INPUT_BG} />
          </label>
          <label className="block">
            <span className="text-[12px] text-muted">The day it was counted</span>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={`${WH_INPUT} w-44 mt-1`} style={WH_INPUT_BG} />
          </label>
          <button type="button" onClick={save} disabled={busy === "received"} className={WH_BTN_PRIMARY}>{busy === "received" ? "Saving…" : "Save"}</button>
          {b.units_received != null && (
            <button type="button" onClick={() => void run("received", () => api.updateWarehouseBuy(b.id, { units_received: null })).then(() => setOpen(false))} className="text-[12.5px] text-muted hover:text-ink-2">Not counted yet</button>
          )}
          <button type="button" onClick={() => setOpen(false)} className="text-[12.5px] text-muted hover:text-ink-2">Cancel</button>
        </div>
      )}
    </div>
  );
}

/** The refund owed for what never came: worked out from the short unless typed over, then what has come in. */
function RefundCard({ d, numbers, canEdit, busy, run }: { d: BuyDetail; numbers: boolean; canEdit: boolean; busy: string | null; run: Run }) {
  const b = d.buy;
  const r = d.rollup;
  const [typing, setTyping] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const refunds = d.payments.filter((p) => p.kind === "refund");
  if (b.units_received == null && r.refund_owed < 0.005 && refunds.length === 0 && b.refund_owed_typed == null) {
    return (
      <div className={`${WH_CARD} px-4 py-3`}>
        <div className="text-[13px] font-semibold text-ink">Refund</div>
        <p className="text-[12.5px] text-muted mt-0.5">Nothing is owed. If fewer arrive than you ordered, count them in above and the refund you are owed shows here.</p>
        {canEdit && d.can_book_bank !== false && <TieRefund d={d} adding={adding} setAdding={setAdding} run={run} />}
      </div>
    );
  }
  const worked = b.refund_owed_typed == null;
  return (
    <div className={`${WH_CARD} px-4 py-3 space-y-3`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">Refund</div>
          <p className="text-[12.5px] text-muted mt-0.5">
            {numbers ? <>
              Owed {fmtAmount(r.refund_owed)}{worked ? (r.short > 0 ? `, worked out from the ${n0(r.short)} short` : "") : ", the figure you typed"}.
              {" "}Received {fmtAmount(r.refund_received)}. Still owed {fmtAmount(r.refund_left)}.
            </> : "Owed to you for what never came."}
          </p>
        </div>
        {numbers && canEdit && typing === null && (
          <div className="flex items-center gap-2">
            {!worked && <button type="button" disabled={!!busy} onClick={() => void run("refund", () => api.updateWarehouseBuy(b.id, { refund_owed: null }))} className={WH_BTN_SECONDARY}>Work it out from the short</button>}
            <button type="button" onClick={() => setTyping(r.refund_owed)} className={WH_BTN_SECONDARY}><Pencil size={13} /> Change</button>
          </div>
        )}
      </div>
      {typing !== null && (
        <div className="flex items-end gap-2 flex-wrap">
          <label className="block">
            <span className="text-[12px] text-muted">Refund owed</span>
            <NumberInput value={typing} onValue={setTyping} autoFocus className={`${WH_INPUT} w-36 mt-1 tabular-nums`} style={WH_INPUT_BG} />
          </label>
          <button type="button" disabled={busy === "refund"} onClick={() => void run("refund", () => api.updateWarehouseBuy(b.id, { refund_owed: typing })).then(() => setTyping(null))} className={WH_BTN_PRIMARY}>Save</button>
          <button type="button" onClick={() => setTyping(null)} className="text-[12.5px] text-muted hover:text-ink-2">Cancel</button>
        </div>
      )}
      {numbers && refunds.length > 0 && (
        <div className="space-y-1.5">
          {refunds.map((p) => (
            <div key={p.txn_id} className="flex items-center justify-between gap-2 text-[12.5px] bg-surface-2 rounded-lg px-3 py-2">
              <span className="min-w-0 truncate text-ink-2">{p.posted_at.slice(0, 10)} · {p.name || "Bank deposit"}</span>
              <span className="flex items-center gap-2 flex-shrink-0">
                <span className="tabular-nums text-ink">{p.booked_here < p.amount - 0.005 ? `${fmtAmount(p.booked_here)} of ${fmtAmount(p.amount)}` : fmtAmount(p.amount)}</span>
                {d.can_book_bank !== false && (
                  <button title="Take this refund off the order" disabled={busy === p.txn_id} onClick={() => void run(p.txn_id, () => api.unpayWarehouseBuy(b.id, p.txn_id))} className="text-faint hover:text-danger-ink"><X size={13} /></button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {canEdit && d.can_book_bank !== false && <TieRefund d={d} adding={adding} setAdding={setAdding} run={run} />}
    </div>
  );
}

function TieRefund({ d, adding, setAdding, run }: { d: BuyDetail; adding: boolean; setAdding: (v: boolean) => void; run: Run }) {
  if (!adding) {
    return <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-[12.5px] text-accent-hover hover:underline mt-2"><Plus size={13} /> Tie a refund</button>;
  }
  return (
    <div className="mt-2">
      <PayPicker kind="refund" buy={{ id: d.buy.id, supplier: d.buy.supplier_name, total: d.rollup.refund_owed, paid: d.rollup.refund_received }}
        onDone={(v) => { setAdding(false); if (v) void run("refund-in", async () => v); }} onCancel={() => setAdding(false)} />
    </div>
  );
}

/** An order made from a deal flow says so, and Undo puts the deal and its bank payments back as they were. */
function MovedFromDeal({ d, canEdit, onUndone }: { d: BuyDetail; canEdit: boolean; onUndone: () => void }) {
  const [deal, setDeal] = useState<DealFlow | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getDealFlow(d.buy.from_deal_id).then(setDeal).catch(() => setDeal(null)); }, [d.buy.from_deal_id]);
  const undo = async () => {
    if (!confirm("Put this back as a deal? Its bank payments go back on the deal, the deal comes back, and this order is removed. Anything sold from this order or any truck on it has to be taken off first.")) return;
    setBusy(true);
    try { await api.undoBuyFromDeal(d.buy.id); toast("Put back as a deal."); onUndone(); }
    catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className={`${WH_CARD} px-4 py-3 flex items-center justify-between gap-3 flex-wrap`}>
      <span className="text-[12.5px] text-ink-2 min-w-0 leading-relaxed">
        Moved from deal {deal?.name?.trim() || deal?.client_name?.trim() || "a deal"}. Its payments are on this order now and the deal is archived.
      </span>
      {canEdit && <button type="button" disabled={busy} onClick={undo} className={WH_BTN_SECONDARY}>{busy ? "Putting back…" : "Undo"}</button>}
    </div>
  );
}
