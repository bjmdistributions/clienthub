import { Check, Paperclip, Plus, Truck } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, type DealFlow, type DealLogisticsPay, type FreightBooking, type FreightDraft, type SupplierPayment } from "../lib/api";
import { fmtAmount, localDay, parseAmount, shippingChargedOf, shippingEstimateOf } from "../lib/format";
import { canAttachPayments, canChangePaidOn, canRecordOn } from "../lib/logisticsCarriers";
import { PAID_BANNER, dealPaid as isDealPaid, isLiveTruck, isQuoteStage, loadNumber, paidStateOf, paidView, pickupNumberUnconfirmed } from "../lib/logisticsLoad";
import { invoiceWasSent, loadProgress, withDealFacts } from "../lib/loadProgress";
import { useSessionMe } from "../lib/useSessionMe";
import StatusPill from "./StatusPill";
import { PaidButtons, PaidSummary, usePaidControls } from "./LogisticsPayCarriers";
import { LoadTrackerCompact } from "./LoadTracker";
import NumberInput from "./NumberInput";
import SendToLogistics from "./SendToLogistics";
import { toast } from "./Toast";
import LogisticsBookingForm, {
  AmountNeededPill, FreightStatusPill, PickupNumberPill, UrgentPill, fmtDay, isHot,
  needsAmount, timingLine, useNetsyncApplied,
} from "./LogisticsBookingForm";

// R-400: the deal's Shipping step. Freight is its own leg of the deal, separate from what is
// owed to the supplier: the bookings the person doing logistics fills in are the truth, and a
// freight line typed on the deal only counts while the deal has no booking. Everything a booking
// holds is written through the server's Logistics routes; this step reads the local copy, which
// sync keeps current.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:border-ink transition-colors duration-150";

const day = (v?: string | null) => (v || "").trim();
const fmtSigned = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <span className="text-muted">{label}{sub ? <span className="block text-[12px] text-faint">{sub}</span> : null}</span>
      <span className="text-ink font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── Send to logistics ─────────────────────────────────────────────────────
// R-651: the full screen in SendToLogistics.tsx (it replaced the R-400 pop-up here, and its R-479 "Already moving"
// mode). DayChips moved with it and is re-exported for the buy sheet.
export { DayChips } from "./SendToLogistics";

/** R-479: "Move to Logistics" for a deal whose load was never sent and is already moving. Opens the Send to
 *  logistics sheet in its "Already moving" mode. `onMoved` gets the load the server made, so the caller can show its
 *  number at once instead of waiting for sync. */
export function MoveToLogistics({ flow, onMoved }: { flow: DealFlow; onMoved: (made: FreightBooking) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap transition-colors duration-150">
        <Truck size={13} /> Move to Logistics
      </button>
      {open && (
        <SendToLogistics flow={flow} billed={null} moving onClose={() => setOpen(false)}
          onSent={(made) => { setOpen(false); if (made) onMoved(made); }} />
      )}
    </>
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
            className="ui-btn ui-btn-ink">
            <Check size={12} /> Save
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
        {p.kept && <div className="text-[12px] text-muted">Kept: didn't pay, not counted</div>}
        {!locked && (
          <div className="flex items-center gap-2.5 mt-0.5">
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className="text-[12px] text-muted hover:text-ink-2 disabled:opacity-40">Edit</button>
            <button type="button" onClick={remove} disabled={busy} className="text-[12px] text-muted hover:text-danger-ink disabled:opacity-40">Remove</button>
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
  markup: "markup on the freight",
};

// ── The step ──────────────────────────────────────────────────────────────
export default function DealShipping({ flow, onReload, locked, onAdvance, dealPaid }: {
  flow: DealFlow; onReload: () => void; locked: boolean; onAdvance?: () => void;
  /** R-459: whether the buyer has paid, as the deal card reads it (the stage and the bank link). */
  dealPaid?: boolean;
}) {
  const [bookings, setBookings] = useState<FreightBooking[]>([]);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  // R-651: the deal's saved Send to logistics form, when there is one (kept on the server for every device).
  const [draft, setDraft] = useState<FreightDraft | null>(null);
  const [open, setOpen] = useState<FreightBooking | null>(null);
  // R-401: what the invoice charged for shipping, and the logistics pay that comes of it.
  const [charged, setCharged] = useState<{ amount: number; source: "lines" | "field" | "none" }>({ amount: 0, source: "none" });
  const [chargedReady, setChargedReady] = useState(false);
  const [pay, setPay] = useState<DealLogisticsPay | null>(null);
  // R-464: whether the deal's invoice has gone out (the loads' tracker and the gate need it) and who may change a payment.
  const [invoiceSent, setInvoiceSent] = useState<boolean | undefined>(undefined);
  // R-470: the server's word on each load's payment. The local copy does not know whether a payment is linked to the
  // bank, and a load is Paid only when it is, so these fields are laid over the local copy.
  const [fresh, setFresh] = useState<Record<string, FreightBooking>>({});
  const me = useSessionMe();
  // R-527: attaching or detaching the bank payment is for an admin or the Financials edit switch.
  const attach = canAttachPayments(me);

  const loadBookings = useCallback(async () => {
    try { setBookings(await api.listFreightBookings(flow.id)); }
    catch (e) { console.error(e); }
    setReady(true);
    try {
      const r = await api.logistics.list({ includeDone: true, dealFlowId: flow.id });
      setFresh(Object.fromEntries(r.bookings.map((x) => [x.id, x])));
    } catch { /* the local copy is shown, and a payment with no link reads as marked, never as paid */ }
  }, [flow.id]);
  useEffect(() => { loadBookings(); }, [loadBookings, flow.updated_at, flow.logistics_bookings, flow.logistics_paid]);
  useNetsyncApplied(loadBookings);

  useEffect(() => {
    let dead = false;
    api.getInvoice(flow.invoice_id)
      .then((inv) => { if (!dead) { setCharged(shippingChargedOf(inv.line_items_json, inv.shipping_charged)); setChargedReady(true); setInvoiceSent(invoiceWasSent(inv)); } })
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

  const loadDraft = useCallback(() => {
    api.logistics.drafts.get(flow.id).then((r) => setDraft(r.draft)).catch(() => setDraft(null));
  }, [flow.id]);
  useEffect(() => { if (!flow.ships_direct) loadDraft(); }, [loadDraft, flow.ships_direct]);

  // R-459: a quote is a load asked about, not a truck. It shows here with its stage and is never counted
  // as a truck (the money rows below come from the deal, which leaves quotes out the same way).
  const withPayment = (b: FreightBooking): FreightBooking => {
    const f = fresh[b.id];
    return f ? { ...b, paid_state: f.paid_state, bank_linked: f.bank_linked, paid_amount: f.paid_amount, paid_at: f.paid_at, paid_method: f.paid_method, paid_note: f.paid_note, pay_due_date: f.pay_due_date ?? b.pay_due_date } : b;
  };
  const shown = bookings.map(withPayment);
  const live = shown.filter(isLiveTruck);
  const quotes = shown.filter((b) => isQuoteStage(b.status));
  const cancelled = shown.filter((b) => b.status === "cancelled");
  const typed = (flow.supplier_payments || []).filter((p) => p.category === "freight");
  const typedTotal = typed.filter((p) => !p.kept).reduce((s, p) => s + (p.amount || 0), 0);
  const mode = !!flow.shipping_mode;
  const paid = flow.logistics_paid ?? 0;
  const linked = flow.shipping_linked ?? 0;
  const quoted = flow.logistics_quoted ?? 0;
  const gap = Math.abs(paid - linked);
  const complete = flow.stage === "complete";

  // R-470: a load is paid only by linking its bank payment, from where the payment is seen. After a link, an unlink or an
  // undo the server's copy is read again at once; sync brings the local rows in a moment later.
  const paidControls = usePaidControls(() => refresh());
  const payTarget = (b: FreightBooking) => ({ bookingId: b.id, label: `${b.carrier || "Carrier"}, ${loadNumber(b)}`, rate: b.quoted_cost, linked: paidStateOf(b) === "part" ? b.paid_amount : null });

  const addTruck = async () => {
    const from = live[live.length - 1] ?? bookings[bookings.length - 1];
    if (!from) return;
    try { await api.logistics.copy(from.id); toast("Another truck is on the list"); refresh(); }
    catch (e) { toast(String(e), "error"); }
  };

  // R-458: Shipping is the second step, so a deal with no truck to book answers it here too.
  const shipsDirect = async () => {
    try {
      await api.setDealFlowShipping(flow.id, day(flow.pickup_date) || null, day(flow.expected_delivery_date) || null, true);
      onReload();
    } catch (e) { toast(String(e), "error"); }
  };

  const undoDirect = async () => {
    try {
      await api.setDealFlowShipping(flow.id, day(flow.pickup_date) || null, day(flow.expected_delivery_date) || null, false);
      onReload();
    } catch (e) { toast(String(e), "error"); }
  };

  // The drawer needs the server's copy (the paperwork, BOLs and the paid flag are not in the local mirror).
  // It opens at once on the local one and swaps in the server's unless something was saved in between.
  const openBooking = (b: FreightBooking) => {
    setOpen(b);
    api.logistics.get(b.id).then((s) => setOpen((cur) => (cur === b ? s : cur))).catch(() => {});
  };

  const card = (b: FreightBooking) => {
    const quoteStage = isQuoteStage(b.status);
    const who = [b.carrier, b.broker && (b.carrier ? `via ${b.broker}` : b.broker)].filter(Boolean).join(" ");
    const refs = [b.bol && `BOL ${b.bol}`, b.pro && `PRO ${b.pro}`].filter(Boolean).join(", ");
    // R-458: the times the team set and the ETA logistics typed, in one line.
    const dates = timingLine(b);
    const nFiles = b.files?.length ?? 0;
    const money = [
      paidStateOf(b) !== "unpaid" && paidView(b, localDay()).text,
      paidStateOf(b) === "unpaid" && b.quoted_cost != null && `Carrier rate ${fmtAmount(b.quoted_cost)}`,
      b.status === "quoted" && b.quote_amount != null && `Quote ${fmtAmount(b.quote_amount)}, ${(b.quote_invoiced_at || "").trim() ? "on the invoice" : "not on the invoice yet"}`,
    ].filter(Boolean).join(", ");
    return (
      <button
        key={b.id} type="button" onClick={() => openBooking(b)}
        className={`w-full text-left py-1 hover:border-line-3 transition-colors duration-150 min-w-0 ${b.status === "cancelled" ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="tabular-nums text-[12px] text-muted">{loadNumber(b)}</span>
          <FreightStatusPill status={b.status} />
          {isHot(b) && <UrgentPill />}
          {pickupNumberUnconfirmed(b, localDay()) && <PickupNumberPill />}
          {needsAmount(b) && <AmountNeededPill />}
          {who && <span className="text-[13px] font-medium text-ink truncate min-w-0">{who}</span>}
          {nFiles > 0 && <span className="ml-auto inline-flex items-center gap-0.5 text-[12px] text-muted"><Paperclip size={11} />{nFiles} {nFiles === 1 ? "file" : "files"}</span>}
        </div>
        {b.status !== "cancelled" && (
          <div className="mt-1.5"><LoadTrackerCompact stages={loadProgress(withDealFacts(b, { invoiceSent, dealPaid }), true)} /></div>
        )}
        {(refs || dates) && <div className="text-[12px] text-ink-2 mt-1">{[refs, dates].filter(Boolean).join(" · ")}</div>}
        {b.status === "requested" && !refs && !dates && <div className="text-[12px] text-muted mt-1">Waiting for logistics to book it.</div>}
        {b.status === "quote" && <div className="text-[12px] text-muted mt-1">Waiting for logistics to quote it.</div>}
        {quoteStage && isDealPaid(b, dealPaid) && <div className="text-[12px] text-success-ink mt-1">{PAID_BANNER}</div>}
        {money && <div className="text-[12px] text-ink-2 mt-0.5 tabular-nums">{money}</div>}
        {b.updated_by_name && <div className="text-[12px] text-muted mt-1">Updated by {b.updated_by_name} {fmtDay(b.updated_at)}</div>}
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
              {live.length === 0 && quotes.length === 0
                ? "Nothing sent to logistics yet."
                : [
                  live.length > 0 && `${live.length} ${live.length === 1 ? "truck" : "trucks"} with logistics.`,
                  quotes.length > 0 && `${quotes.length} ${quotes.length === 1 ? "quote" : "quotes"} with logistics.`,
                ].filter(Boolean).join(" ")}
            </div>
            <div className="flex items-center gap-2">
              {live.length > 0 && (
                <button type="button" onClick={addTruck}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                  <Plus size={13} /> Add another truck
                </button>
              )}
              {live.length === 0 && quotes.length === 0 && !locked && (
                <button type="button" onClick={shipsDirect}
                  className="px-3 h-8 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">
                  It ships direct
                </button>
              )}
              <button type="button" onClick={() => setSending(true)}
                className="ui-btn ui-btn-ink">
                <Truck size={13} /> {draft ? "Continue the draft" : "Send to logistics"}
              </button>
            </div>
          </div>
          {draft && (
            <div className="text-[12px] text-muted -mt-2">
              A Send to logistics draft is saved{draft.updated_by_name ? ` by ${draft.updated_by_name}` : ""}, {fmtDay(draft.updated_at)}. It has not gone to logistics yet.
            </div>
          )}

          {ready && (quotes.length > 0 || live.length > 0) && <div className="space-y-2">{[...quotes, ...live].map(card)}</div>}

          {(mode || paid > 0 || linked > 0 || quoted > 0 || charged.amount > 0.005 || live.length > 0) && (
            <div className="rounded-xl bg-surface border border-line px-4 py-3 space-y-1.5">
              {charged.amount > 0.005 && (
                <Row label="Charged to the customer for shipping" value={fmtAmount(pay?.charged ?? charged.amount)}
                  sub={(pay?.charged_source ?? charged.source) === "lines" ? "From the invoice's shipping line" : "From the invoice's shipping charge"} />
              )}
              <Row label="Shipping paid" value={fmtAmount(paid)} />
              {live.length > 0 && (
                <ul className="list-none m-0 pl-3 border-l-2 border-line space-y-2" aria-label="Shipping paid by load">
                  {live.map((b) => (
                    <li key={b.id} className="min-w-0 space-y-1">
                      <div className="text-[12px] truncate text-ink-2">
                        <span className="tabular-nums text-muted">{loadNumber(b)}</span>{b.carrier ? `, ${b.carrier}` : ""}
                      </div>
                      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap">
                        <PaidSummary b={b} today={localDay()} />
                        <PaidButtons state={paidStateOf(b)} bankLinked={b.bank_linked} amount={b.paid_amount} canLink={canRecordOn(b, attach)} canChange={canChangePaidOn(b, attach)}
                          target={payTarget(b)} controls={paidControls} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {linked > 0.005 && (
                <Row
                  label="Linked from the bank"
                  value={fmtAmount(linked)}
                  sub={gap > 0.5 ? `${fmtAmount(gap)} ${linked > paid ? "more" : "less"} than the amount paid` : undefined}
                />
              )}
              {quoted > 0.005 && <Row label="Still to pay the carrier" value={fmtAmount(quoted)} />}
              {charged.amount > 0.005 && (mode || linked > 0.005 || typedTotal > 0.005) && (
                // The surplus is known only once every live truck has its amount paid (R-415), as on the phone.
                // R-533: the trucks still owed money (carrier_owing), not the gate's count: a typed figure's amount is known.
                (pay ? !pay.pending : (flow.carrier_owing ?? flow.logistics_unpaid ?? 0) === 0)
                  ? <Row label="Shipping profit" value={fmtSigned(pay ? pay.surplus : charged.amount - shippingEstimateOf(flow))} />
                  : <Row label="Shipping profit" value="Waiting on the amount paid" />
              )}
              {pay && (
                pay.rule === "tracked"
                  ? <Row label="Logistics pay" value="Tracked, not paid" sub={pay.markup != null ? `Markup of ${fmtAmount(pay.markup)}, shows in the Brief` : "The surplus shows in the Brief"} />
                : pay.pay == null
                  ? <Row label="Logistics pay" value="Waiting on the amount paid" />
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
            className="ui-btn ui-btn-ink">
            Continue to link financials <Check size={14} />
          </button>
        </div>
      )}

      {sending && (
        <SendToLogistics flow={flow} billed={chargedReady ? ((flow.shipping_billed ?? 0) > 0 ? (flow.shipping_billed as number) : charged.amount) : null}
          onClose={() => { setSending(false); loadDraft(); }} onSent={() => { setSending(false); setDraft(null); refresh(); }} />
      )}
      {paidControls.sheet}
      {open && (
        <LogisticsBookingForm
          booking={open}
          dealPaid={dealPaid}
          invoiceSent={invoiceSent}
          onClose={() => setOpen(null)}
          onSaved={(b) => { setOpen(b); refresh(); }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
