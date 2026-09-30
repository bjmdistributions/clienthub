import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Plus, Send, Truck, X } from "lucide-react";
import { api, type DealFlow, type DealLogisticsPay, type FreightBooking, type FreightPrefill, type SupplierPayment } from "../lib/api";
import { fmtAmount, parseAmount, shippingChargedOf, shippingEstimateOf } from "../lib/format";
import StatusPill from "./StatusPill";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";
import LogisticsBookingForm, {
  AmountNeededPill, FreightStatusPill, fmtDay, needsAmount, useNetsyncApplied,
} from "./LogisticsBookingForm";

// R-400: the deal's Shipping step. Freight is its own leg of the deal, separate from what is
// owed to the supplier: the bookings the person doing logistics fills in are the truth, and a
// freight line typed on the deal only counts while the deal has no booking. Everything a booking
// holds is written through the server's Logistics routes; this step reads the local copy, which
// sync keeps current.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const day = (v?: string | null) => (v || "").trim();
const fmtSigned = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <span className="text-muted">{label}{sub ? <span className="block text-[11px] text-faint">{sub}</span> : null}</span>
      <span className="text-ink font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── Send to logistics ─────────────────────────────────────────────────────
// A sheet prefilled from the deal: the buyer is where it goes, the supplier on the cost lines
// is where it comes from (one pick when several are owed). Everything can be changed before it
// is sent, and the person doing logistics can fill in the rest.
function SendSheet({ flow, onClose, onSent }: { flow: DealFlow; onClose: () => void; onSent: () => void }) {
  const [pre, setPre] = useState<FreightPrefill | null>(null);
  const [err, setErr] = useState("");
  const [pickup, setPickup] = useState({ name: "", address: "" });
  const [delivery, setDelivery] = useState({ name: "", address: "" });
  const [pallets, setPallets] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    api.logistics.prefill(flow.id)
      .then((p) => {
        if (dead) return;
        setPre(p);
        setPickup({ name: p.pickup_name, address: p.pickup_address });
        setDelivery({ name: p.delivery_name, address: p.delivery_address });
      })
      .catch((e) => { if (!dead) { setErr(String(e)); setPre({ pickup_name: "", pickup_address: "", delivery_name: "", delivery_address: "", pickup_options: [] }); } });
    return () => { dead = true; };
  }, [flow.id]);

  const send = async () => {
    setBusy(true); setErr("");
    try {
      await api.logistics.create(flow.id, {
        pickup_name: pickup.name, pickup_address: pickup.address,
        delivery_name: delivery.name, delivery_address: delivery.address,
        pallets: pallets.trim(), request_note: note.trim(),
      });
      toast("Sent to logistics");
      onSent();
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const options = pre?.pickup_options ?? [];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Send to logistics"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink">Send to logistics</h2>
            <p className="text-[12px] text-muted mt-0.5">
              {flow.invoice_number ? `${flow.invoice_number}. ` : ""}Logistics books the truck and fills in the rest.
            </p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {pre === null ? <div className="text-[12.5px] text-muted">Loading...</div> : (
            <>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Pickup</div>
                {options.length > 1 && (
                  <select className={inp} aria-label="Pickup from"
                    value={options.findIndex((o) => o.name === pickup.name && o.address === pickup.address)}
                    onChange={(e) => { const o = options[Number(e.target.value)]; if (o) setPickup({ name: o.name, address: o.address }); }}>
                    {options.findIndex((o) => o.name === pickup.name && o.address === pickup.address) < 0 && <option value={-1}>Edited</option>}
                    {options.map((o, i) => <option key={i} value={i}>{o.name || o.address || "Pickup"}</option>)}
                  </select>
                )}
                <input className={inp} placeholder="Name" value={pickup.name} onChange={(e) => setPickup({ ...pickup, name: e.target.value })} />
                <input className={inp} placeholder="Address" value={pickup.address} onChange={(e) => setPickup({ ...pickup, address: e.target.value })} />
              </div>
              <div className="space-y-2">
                <div className="text-[12px] font-medium text-ink-2">Delivery</div>
                <input className={inp} placeholder="Name" value={delivery.name} onChange={(e) => setDelivery({ ...delivery, name: e.target.value })} />
                <input className={inp} placeholder="Address" value={delivery.address} onChange={(e) => setDelivery({ ...delivery, address: e.target.value })} />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-ink-2 mb-1">Pallets</label>
                <NumberInput integer className={inp} value={pallets} placeholder="How many" onValue={(_n, raw) => setPallets(raw)} />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-ink-2 mb-1">Note for logistics</label>
                <textarea
                  className="border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[72px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                  placeholder="Dock hours, who to call, anything that helps" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </>
          )}
          {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2 border-t border-line">
          <button onClick={onClose} className="px-4 h-9 rounded-lg text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
          <button onClick={send} disabled={busy || pre === null}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap">
            <Send size={13} /> {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Typed freight (R-401) ─────────────────────────────────────────────────
// A freight line typed on the deal is shipping, so it lives here and not among the supplier
// costs. It can be edited or removed, and it has no "paid" toggle: a supplier or a carrier is
// paid outside the deal, and the bank link is what ties the money to it.
function TypedFreightRow({ flow, p, struck, locked, onChanged }: {
  flow: DealFlow; p: SupplierPayment; struck: boolean; locked: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.supplier_name);
  const [amt, setAmt] = useState(String(p.amount));
  const [busy, setBusy] = useState(false);

  // A completed deal keeps its recorded figures in step with a changed cost line.
  const settle = async () => {
    if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch { /* the save already went through */ } }
    onChanged();
  };
  const save = async () => {
    const amount = parseAmount(amt);
    if (!name.trim()) { toast("Name who this freight went to", "error"); return; }
    if (!(amount > 0)) { toast("Add the amount for this freight", "error"); return; }
    setBusy(true);
    try {
      await api.updateSupplierPayment(flow.id, p.id, {
        supplier_name: name.trim(), supplier_id: p.supplier_id ?? null, amount,
        quantity: 1, unit_price: amount, method: p.method ?? null, notes: p.notes ?? null,
        category: "freight", supplier_billed: p.supplier_billed,
      });
      setEditing(false);
      await settle();
    } catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };
  const remove = async () => {
    if (!confirm(`Remove ${fmtAmount(p.amount)} of freight for ${p.supplier_name || "this line"}? It stops counting as this deal's shipping cost.`)) return;
    setBusy(true);
    try { await api.removeSupplierPayment(flow.id, p.id); await settle(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };

  if (editing) {
    return (
      <div className="space-y-2 py-1">
        <input className={inp} aria-label="Paid to" placeholder="Who this went to" value={name} onChange={(e) => setName(e.target.value)} />
        <NumberInput className={inp} aria-label="Amount" placeholder="0.00" value={amt} onValue={(_n, raw) => setAmt(raw)} />
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium disabled:opacity-40">
            <Check size={12} strokeWidth={2.5} /> Save
          </button>
          <button type="button" onClick={() => { setEditing(false); setName(p.supplier_name); setAmt(String(p.amount)); }}
            className="px-3 h-8 rounded-lg text-[12px] text-ink-2 hover:bg-surface-3">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 text-[12.5px]">
      <div className="min-w-0">
        <div className={`truncate ${struck || p.kept ? "text-faint line-through" : "text-ink-2"}`}>{p.supplier_name || "Freight"}</div>
        {p.kept && <div className="text-[11px] text-muted">Kept: didn't pay, not counted</div>}
        {!locked && (
          <div className="flex items-center gap-2.5 mt-0.5">
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className="text-[11px] text-muted hover:text-ink-2 disabled:opacity-40">Edit</button>
            <button type="button" onClick={remove} disabled={busy} className="text-[11px] text-muted hover:text-danger-ink disabled:opacity-40">Remove</button>
          </div>
        )}
      </div>
      <span className={`tabular-nums flex-shrink-0 ${struck || p.kept ? "text-faint line-through" : "text-ink-2"}`}>{fmtAmount(p.amount)}</span>
    </div>
  );
}

const PAY_RULE_WORD: Record<string, string> = {
  share: "share of the shipping profit",
  loss_cover: "covering a load that lost money",
  loss_share: "share of the loss",
};

// ── The step ──────────────────────────────────────────────────────────────
export default function DealShipping({ flow, onReload, locked, onAdvance }: { flow: DealFlow; onReload: () => void; locked: boolean; onAdvance?: () => void }) {
  const [bookings, setBookings] = useState<FreightBooking[]>([]);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<FreightBooking | null>(null);
  // R-401: what the invoice charged for shipping, and the logistics pay that comes of it.
  const [charged, setCharged] = useState<{ amount: number; source: "lines" | "field" | "none" }>({ amount: 0, source: "none" });
  const [pay, setPay] = useState<DealLogisticsPay | null>(null);

  const loadBookings = useCallback(async () => {
    try { setBookings(await api.listFreightBookings(flow.id)); }
    catch (e) { console.error(e); }
    setReady(true);
  }, [flow.id]);
  useEffect(() => { loadBookings(); }, [loadBookings, flow.updated_at, flow.logistics_bookings, flow.logistics_paid]);
  useNetsyncApplied(loadBookings);

  useEffect(() => {
    let dead = false;
    api.getInvoice(flow.invoice_id)
      .then((inv) => { if (!dead) setCharged(shippingChargedOf(inv.line_items_json, inv.shipping_charged)); })
      .catch(() => {});
    return () => { dead = true; };
  }, [flow.invoice_id]);
  // The pay line is worked out on the desktop by the same rule the server uses, so it moves as
  // soon as a booking or a bank link does.
  useEffect(() => {
    let dead = false;
    api.getDealLogisticsPay(flow.id).then((r) => { if (!dead) setPay(r); }).catch(() => { if (!dead) setPay(null); });
    return () => { dead = true; };
  }, [flow.id, flow.updated_at, flow.logistics_paid, flow.logistics_quoted, flow.logistics_bookings, flow.shipping_linked]);

  const refresh = () => { loadBookings(); onReload(); };

  const live = bookings.filter((b) => b.status !== "cancelled");
  const cancelled = bookings.filter((b) => b.status === "cancelled");
  const typed = (flow.supplier_payments || []).filter((p) => p.category === "freight");
  const typedTotal = typed.filter((p) => !p.kept).reduce((s, p) => s + (p.amount || 0), 0);
  const mode = !!flow.shipping_mode;
  const paid = flow.logistics_paid ?? 0;
  const linked = flow.shipping_linked ?? 0;
  const quoted = flow.logistics_quoted ?? 0;
  const gap = Math.abs(paid - linked);
  const complete = flow.stage === "complete";

  const addTruck = async () => {
    const from = live[live.length - 1] ?? bookings[bookings.length - 1];
    if (!from) return;
    try { await api.logistics.copy(from.id); toast("Another truck is on the list"); refresh(); }
    catch (e) { toast(String(e), "error"); }
  };

  const undoDirect = async () => {
    try {
      await api.setDealFlowShipping(flow.id, day(flow.pickup_date) || null, day(flow.expected_delivery_date) || null, false);
      onReload();
    } catch (e) { toast(String(e), "error"); }
  };

  const card = (b: FreightBooking) => {
    const who = [b.carrier, b.broker && (b.carrier ? `via ${b.broker}` : b.broker)].filter(Boolean).join(" ");
    const refs = [b.bol && `BOL ${b.bol}`, b.pro && `PRO ${b.pro}`].filter(Boolean).join(", ");
    const dates = [
      b.pickup_date && `Pickup ${fmtDay(b.pickup_date)}`,
      (b.delivered_at || b.delivery_date) && `${b.delivered_at ? "Delivered" : "Delivery"} ${fmtDay(b.delivered_at || b.delivery_date)}`,
    ].filter(Boolean).join(", ");
    const money = [
      b.paid_amount != null && `Amount paid ${fmtAmount(b.paid_amount)}${b.paid_at ? ` on ${fmtDay(b.paid_at)}` : ""}`,
      b.paid_amount == null && b.quoted_cost != null && `Quote ${fmtAmount(b.quoted_cost)}`,
    ].filter(Boolean).join(", ");
    return (
      <button
        key={b.id} type="button" onClick={() => setOpen(b)}
        className={`w-full text-left bg-surface border border-line rounded-xl px-4 py-3 hover:border-accent/40 transition-colors min-w-0 ${b.status === "cancelled" ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-mono text-[12px] text-muted">{b.code}</span>
          <FreightStatusPill status={b.status} />
          {needsAmount(b) && <AmountNeededPill />}
          {who && <span className="text-[13px] font-medium text-ink truncate min-w-0">{who}</span>}
        </div>
        {(refs || dates) && <div className="text-[12px] text-ink-2 mt-1">{[refs, dates].filter(Boolean).join(" · ")}</div>}
        {b.status === "requested" && !refs && !dates && <div className="text-[12px] text-muted mt-1">Waiting for logistics to book it.</div>}
        {money && <div className="text-[12px] text-ink-2 mt-0.5 tabular-nums">{money}</div>}
        {b.updated_by_name && <div className="text-[11px] text-muted mt-1">Updated by {b.updated_by_name} {fmtDay(b.updated_at)}</div>}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {flow.ships_direct ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface border border-line px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">This deal ships direct</div>
            <div className="text-[12px] text-muted mt-0.5">The supplier sends it, so there is no truck to book.</div>
          </div>
          <button type="button" onClick={undoDirect} disabled={locked}
            className="px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 disabled:opacity-50 whitespace-nowrap">
            Undo ships direct
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[12.5px] text-muted">
              {live.length === 0 ? "Nothing sent to logistics yet." : `${live.length} ${live.length === 1 ? "truck" : "trucks"} with logistics.`}
            </div>
            <div className="flex items-center gap-2">
              {live.length > 0 && (
                <button type="button" onClick={addTruck}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                  <Plus size={13} /> Add another truck
                </button>
              )}
              <button type="button" onClick={() => setSending(true)}
                className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium whitespace-nowrap">
                <Truck size={13} /> Send to logistics
              </button>
            </div>
          </div>

          {ready && live.length > 0 && <div className="space-y-2">{live.map(card)}</div>}

          {(mode || paid > 0 || linked > 0 || quoted > 0 || charged.amount > 0.005) && (
            <div className="rounded-xl bg-surface border border-line px-4 py-3 space-y-1.5">
              {charged.amount > 0.005 && (
                <Row label="Charged to the customer" value={fmtAmount(pay?.charged ?? charged.amount)}
                  sub={(pay?.charged_source ?? charged.source) === "lines" ? "From the invoice's shipping line" : "From the invoice's shipping charge"} />
              )}
              <Row label="Shipping paid" value={fmtAmount(paid)} />
              {linked > 0.005 && (
                <Row
                  label="Linked from the bank"
                  value={fmtAmount(linked)}
                  sub={gap > 0.5 ? `${fmtAmount(gap)} ${linked > paid ? "more" : "less"} than the amount paid` : undefined}
                />
              )}
              {quoted > 0.005 && <Row label="Quoted, not paid yet" value={fmtAmount(quoted)} />}
              {charged.amount > 0.005 && (mode || linked > 0.005 || typedTotal > 0.005) && (
                <Row label="Shipping profit" value={fmtSigned(pay ? pay.surplus : charged.amount - shippingEstimateOf(flow))} />
              )}
              {pay && (
                pay.pay == null
                  ? <Row label="Logistics pay" value="Waiting on the freight amount" />
                  : <Row label="Logistics pay" value={fmtAmount(pay.pay)}
                      sub={`${PAY_RULE_WORD[pay.rule] ?? pay.rule}${pay.due_date ? `, due ${fmtDay(pay.due_date)}` : ""}`} />
              )}
              {complete && flow.shipping_cost != null && <Row label="Recorded on the completed deal" value={fmtAmount(flow.shipping_cost)} />}
            </div>
          )}

          {ready && cancelled.length > 0 && (
            <div className="space-y-2">
              <div className="text-[12px] font-medium text-muted flex items-center gap-1.5">Cancelled <StatusPill tone="neutral">{cancelled.length}</StatusPill></div>
              {cancelled.map(card)}
            </div>
          )}
        </>
      )}

      {/* Typed freight stays reachable even when the deal ships direct. */}
      {typed.length > 0 && (
        <div className="rounded-xl bg-surface border border-line px-4 py-3 space-y-1.5">
          <div className="text-[12px] font-medium text-ink-2">
            {mode ? "Typed freight (replaced by the logistics booking)" : "Typed on the deal"}
          </div>
          {typed.map((p) => <TypedFreightRow key={p.id} flow={flow} p={p} struck={mode} locked={locked} onChanged={refresh} />)}
          {!mode && (
            <div className="flex items-baseline justify-between gap-3 text-[12.5px] pt-1.5 border-t border-line">
              <span className="text-muted">Counts as the shipping cost</span>
              <span className="text-ink font-medium tabular-nums">{fmtAmount(typedTotal)}</span>
            </div>
          )}
        </div>
      )}

      {onAdvance && (
        <div className="flex items-center justify-end pt-1">
          <button type="button" onClick={onAdvance}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
            Continue to profit <Check size={14} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {sending && (
        <SendSheet flow={flow} onClose={() => setSending(false)} onSent={() => { setSending(false); refresh(); }} />
      )}
      {open && (
        <LogisticsBookingForm
          booking={open}
          onClose={() => setOpen(null)}
          onSaved={(b) => { setOpen(b); refresh(); }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
