import { Check, ChevronRight, ExternalLink, FileDown, Link2, Package, Plus, RefreshCw, RotateCcw, Search, Tag, Trash2, X, XCircle } from "lucide-react";
import { Fragment, useEffect, useState, useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";

import {
  api, DealFlow, SupplierPayment, Invoice, Supplier, PayoutShare, dealPayoutSplit, isResoldLine, isBuyLine, removeLineAsk, allocateDealPayout, dealPayoutIncluded, dealPayoutRecipients,
  type FreightBooking, type FreightFile, type DealReconciliation,
} from "../lib/api";
import { fmtAmount, primarySupplierLabel, localDay, parseLocalDay, parseAmount, projectedCostOf, shippingEstimateOf, isShippingLine, owedToSupplier } from "../lib/format";
import { legLine, openLegs, type LegKey } from "../lib/dealLegs";
import { toast } from "./Toast";
import { LinkDeliveryModal } from "./LinkDelivery";
import ReconciliationPanel from "./ReconciliationPanel";
import OpenLegReasons from "./OpenLegReasons";
import RefundWorkspace from "./RefundWorkspace";
import ResoldNote from "./ResoldNote";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import StatusPill from "./StatusPill";
import { DealPayoutsBox } from "./PayoutLedger";
import { FreightChip, FreightPanel, UnlinkedShipments, useShipmentChanges, useDeliveredDeals } from "./FreightTracking";
import DealShipping, { MoveToLogistics } from "./DealShipping";
import StepBar from "./StepBar";
import DealLabelsModal from "./DealLabelsModal";
import Switch from "./Switch";
import { Button, Kpi, PageActions, Tabs, useCountUp } from "./ui";
import { unitFigures, unitGap } from "../lib/dealUnits";
import BuysView from "./BuysView";
import { openLoadInLogistics } from "./LogisticsPayCarriers";
import { dealMatchesQuery } from "../lib/logisticsSearch";
import { canPayCarriers } from "../lib/logisticsCarriers";
import { loadNumber } from "../lib/logisticsLoad";
import { OPEN_BUY_KEY } from "../lib/buyLoads";
import { pipelineSplit } from "../lib/dealLane";
import { SECTIONS as DEAL_SECTIONS, carrierHold, describeDeal, payFactsOf, type DealCtx, type DealDescription, type DealSection, type LineTone } from "../lib/dealSections";
import { useSessionMe } from "../lib/useSessionMe";
import { noteChimedDeal } from "../lib/notices";
import {
  buyerLeg, canMoveDeal, canSeePayments, groupPayments, groupSummary, loadNumbersOf, money, paymentFiguresOf, supplierLeg,
  type LegTone, type PaymentEntry, type PaymentLeg,
} from "../lib/dealPayments";
import { useNetsyncApplied, FreightStatusPill, AmountNeededPill, fileBase64, fileSize, keepSmall, FileDrop } from "./LogisticsBookingForm";
import { LogisticsPayCell, useDealLogisticsPay } from "./LogisticsPay";

// ─── helpers ──────────────────────────────────────────────────────────────

/** A drawer bar opens from anywhere along it, not just the label and the arrow
 *  (R-205). Buttons that sit inside the bar stop the click themselves. */
const barToggle = (toggle: () => void) => ({
  role: "button",
  tabIndex: 0,
  onClick: toggle,
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
    // A button inside the bar keeps its own Enter and Space.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  },
});

const STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"] as const;
type Stage = typeof STAGES[number];
function si(s: string): number { return STAGES.indexOf(s as Stage); }

const inp =
  "border border-line-3 px-3 h-9 rounded-lg text-[13px] w-full bg-transparent " +
  "focus:outline-none focus:border-ink transition-colors duration-150";

// Freight and wire fees are no longer entered here (R-205) — everything a deal is
// charged rides the invoice, and the invoice screen's cost editor
// (`InvoiceCostSection`) still writes these same rows for anything that does not.
// Existing cost lines keep their category badge, so nothing recorded is hidden.
const catLabel = (c?: string | null) =>
  c === "freight" ? "Freight" : c === "wire_in" ? "Wire in" :
  c === "wire_out" ? "Wire out" : c === "other" ? "Other" :
  c === "partner" ? "Partner split" : "Supplier";

// ─── Shipping lifecycle (R-154) ───────────────────────────────────────────
// The four stages are all about money, so none of them says "agreed, paid for,
// truck hasn't come yet" — which is most of the life of a deal and the state
// nobody could report on when the salesman was out.

const day = (v?: string | null) => (v || "").trim();

/** `pickup_date` / `expected_delivery_date` are bare `YYYY-MM-DD`, which
 *  `new Date()` reads as UTC midnight — rendered in Central that lands on the
 *  PREVIOUS day. Parse date-only strings as local (same fix as v0.15.135). */
const parseDay = (d: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
};
const dayLabel = (d: string) =>
  parseDay(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
/** Whole days from today, negative in the past. */
const daysUntil = (d: string): number => {
  const n = new Date();
  const midnight = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return Math.round((parseDay(d).getTime() - midnight) / 86400000);
};

type ShipState =
  | { kind: "direct" }
  | { kind: "unset" }
  | { kind: "scheduled" | "overdue"; date: string; basis: "delivery" | "pickup"; days: number };

/** Mirrors `gate_basis` / `shipping_gate` in commands.rs: expected delivery when
 *  it is set, otherwise pickup — a deal is finished when the goods land, not when
 *  the truck leaves. `direct` is the explicit "no pickup" answer; `unset` is a
 *  genuine unanswered question the card has to show, which is the only reason the
 *  ships-direct flag exists at all. */
function shipState(f: DealFlow): ShipState {
  if (f.ships_direct) return { kind: "direct" };
  const del = day(f.expected_delivery_date), pick = day(f.pickup_date);
  const date = del || pick;
  if (!date) return { kind: "unset" };
  const days = daysUntil(date);
  return { kind: days < 0 ? "overdue" : "scheduled", date, basis: del ? "delivery" : "pickup", days };
}

/** The date completion is held for, or null. Today counts as arrived — the same
 *  rule as the Rust gate, which is the one that actually enforces it. */
function shipGate(f: DealFlow): { date: string; basis: "delivery" | "pickup" } | null {
  const s = shipState(f);
  return s.kind === "scheduled" && s.days > 0 ? { date: s.date, basis: s.basis } : null;
}

const basisWord = (b: "delivery" | "pickup") => (b === "delivery" ? "expected delivery" : "pickup");

// ─── What is paid and what is still due (R-303, R-401) ───────────────────
// The card's pill is about the buyer only. Whether the supplier has been sent money is not
// tracked on the deal any more (R-401): a deal has a supplier cost or it does not, and the
// buyer has paid or has not. The buyer test reads every place it can be recorded: the stage
// and the bank link (`reconciliation_status_all`).
type PaymentFlags = { payment_received_paired?: boolean; supplier_paid_paired?: boolean };

function paymentState(f: DealFlow, recon?: PaymentFlags) {
  const hasCost = (f.supplier_payments || []).length > 0;
  const buyerIn = si(f.stage) >= si("payment_received") || !!recon?.payment_received_paired;
  const label = !hasCost ? "Supplier cost needed" : buyerIn ? "Buyer paid" : "Buyer payment due";
  const title = `Buyer: ${buyerIn ? "paid" : "not paid yet"}${hasCost ? "" : " · Supplier: no cost entered yet"}`;
  return { hasCost, buyerIn, label, title };
}

// ─── Main view ────────────────────────────────────────────────────────────
// R-590: when this computer first saw each invoice without a deal flow (kept across visits to the screen), and the
// one pending look-again.
const flowlessSince = new Map<string, number>();
let flowlessRetry = 0;

export default function DealFlowView() {
  const [flows,        setFlows]        = useState<DealFlow[]>([]);
  const [invoices,     setInvoices]     = useState<Invoice[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [syncing,      setSyncing]      = useState(false);
  const [recon, setRecon] = useState<Record<string, { payment_received_paired: boolean; supplier_paid_paired: boolean; fully_reconciled: boolean; has_payment: boolean; has_financials: boolean; no_buyer_link: boolean; no_supplier_link: boolean; needs_financials: boolean; buyer_missing: boolean; supplier_missing: boolean; needs_review: boolean; shipping_missing?: boolean;
    buyer_target?: number; buyer_paired?: number; buyer_left?: number; supplier_target?: number; supplier_paired?: number; supplier_left?: number; cost_kept?: boolean;
    buyer_due?: boolean; supplier_due?: boolean; supplier_cost_missing?: boolean; supplier_kept?: boolean }>>({});
  // R-479: Pipeline (the lists below) or Payments (the same active deals, grouped by what payment is still needed).
  // R-488: Inventory, the stock in hand with what each buy cost and made; its sales are deals in the pipeline.
  const [view, setView] = useState<"pipeline" | "payments" | "inventory">("pipeline");
  // R-479: loads made by "Move to Logistics" in this session, so the row shows its number before sync brings the load in.
  const [moved, setMoved] = useState<Record<string, { id: string; number: string }>>({});
  const me = useSessionMe();
  // Refund mode per deal (refund_owed > 0 OR any refund recorded), at any stage.
  const [refundMap, setRefundMap] = useState<Record<string, { refund_owed: number; refunded: number; remaining: number; done: boolean }>>({});
  // R-486: the six Pipeline sections, all open by default: this is the answer to "what is live right now", not an
  // archive somebody has to go looking for.
  const [sectionsOpen, setSectionsOpen] = useState<Record<DealSection, boolean>>(
    () => Object.fromEntries(DEAL_SECTIONS.map((s) => [s.key, true])) as Record<DealSection, boolean>);
  // Closed by default (R-305, second pass): "theyre not important. my active ones are
  // the most important thing on the entire page."
  const [refundsOpen, setRefundsOpen] = useState(false);
  // R-438: closed refunds sit in their own group at the foot of the Refunds list, folded.
  const [closedRefundsOpen, setClosedRefundsOpen] = useState(false);
  // R-438: bumped when another screen (or a resold row on a refund step) asks for one deal
  // while this view is already open, so the cards remount and the asked-for one opens.
  const [openNonce, setOpenNonce] = useState(0);
  // R-402: the category and brand each deal carries (R-583: open deals too, from list_open_deal_labels).
  const [labels, setLabels] = useState<Record<string, { category: string; brand: string }>>({});
  const [labelsOpen, setLabelsOpen] = useState(false);
  const loadLabels = useCallback(() => {
    // R-583: open deals carry the same labels, so every row says what it sells.
    Promise.all([api.listDealLabels(), api.listOpenDealLabels().catch(() => ({ deals: [] }))]).then(([done, open]) => {
      setLabels(Object.fromEntries([...open.deals, ...done.deals].map((d) => [d.id, { category: d.category_from ? d.category : "", brand: d.brand_from ? d.brand : "" }])));
    }).catch(() => { /* the list reads fine without labels */ });
  }, []);

  const reloadRef = useRef<() => void>();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      let [f, inv, reconList, refundList] = await Promise.all([
        api.listDealFlows(), api.listInvoices(), api.reconciliationStatusAll().catch(() => []),
        api.refundStatusAll().catch(() => []),
      ]);
      setRecon(Object.fromEntries(reconList.map((r) => [r.deal_flow_id, r])));
      setRefundMap(Object.fromEntries(refundList.map((r) => [r.deal_flow_id, r])));

      // Deduplicate: keep only one flow per invoice_id (the most-progressed one).
      // This handles stale duplicate records that may exist in the DB.
      const deduped = Object.values(
        f.reduce<Record<string, DealFlow>>((acc, fl) => {
          const prev = acc[fl.invoice_id];
          if (!prev || si(fl.stage) > si(prev.stage)) acc[fl.invoice_id] = fl;
          return acc;
        }, {})
      );

      // Auto-create deal flows for ALL invoices that aren't already complete —
      // includes drafts so invoices and deal flow stay fully in sync. Exclude
      // VOIDED invoices: list_deal_flows hides their flows, so they're never
      // "covered" and would retrigger createDealFlow every load — which errors
      // ("deal flow already exists") and, via Promise.all, blanked the whole view.
      const coveredIds = new Set(deduped.map((fl) => fl.invoice_id));
      // R-590: not for an invoice that names a flow (it was made on another device and is still arriving by
      // sync), nor before this screen has seen it without one for two minutes (its flow may arrive in the next
      // pull). Creating one there gave an invoice a second and third flow, and a late copy could undo progress.
      // An invoice made on this computer has its flow from the start (create_invoice).
      const now = Date.now();
      let waiting = false;
      const settled = (i: Invoice) => {
        if (i.deal_flow_id) return false;
        const first = flowlessSince.get(i.id) ?? now;
        flowlessSince.set(i.id, first);
        if (now - first < 120_000) waiting = true;
        return now - first >= 120_000;
      };
      const missing = inv.filter((i) => !i.is_complete && !i.voided && !coveredIds.has(i.id) && settled(i));
      // Look again once the two minutes are up, so an invoice is never left without a flow for want of a reload.
      if (waiting && !flowlessRetry) flowlessRetry = window.setTimeout(() => { flowlessRetry = 0; reloadRef.current?.(); }, 125_000);
      if (missing.length > 0) {
        // allSettled, not all: one failed create must never blank the pipeline.
        await Promise.allSettled(missing.map((i) => api.createDealFlow(i.id, null, i.number)));
        const fresh = await api.listDealFlows();
        // Re-deduplicate after creation
        const freshDeduped = Object.values(
          fresh.reduce<Record<string, DealFlow>>((acc, fl) => {
            const prev = acc[fl.invoice_id];
            if (!prev || si(fl.stage) > si(prev.stage)) acc[fl.invoice_id] = fl;
            return acc;
          }, {})
        );
        setFlows(freshDeduped);
      } else {
        setFlows(deduped);
      }
      setInvoices(inv);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  reloadRef.current = load;
  useEffect(() => { load(); loadLabels(); }, [load, loadLabels]);
  // R-400: the person doing logistics changes bookings, dates and amounts from another
  // device. Sync applies them here, and the deal figures they move (cost, profit, the
  // shipping pill) must show without a restart. Debounced: a burst is one reload.
  useNetsyncApplied(load);
  // R-279: a Priority1 update can move a deal's pickup or delivery date.
  useShipmentChanges(load);
  // R-318: the deals Priority1 says have landed.
  const deliveredIds = useDeliveredDeals();

  // Self-heal: re-point payments stranded on duplicate deal_flow rows, then archive
  // the duplicate/orphan rows themselves so no aggregate counts them. Idempotent.
  useEffect(() => {
    api.cleanupGhostDealFlows().then((n) => { if (n > 0) load(); }).catch(() => {});
    // NOTE: cleanupOrphanAllocations is deliberately NOT run here any more. It DELETES
    // bank_allocation rows org-wide with no recovery copy and then rewrites the deal's
    // recorded profit — far too destructive to fire from merely opening a screen, and
    // it ran on every mount. The allocations it targets point at a transaction that is
    // currently missing, which is often temporary (a re-import in progress, a sync that
    // has not landed yet), so "clean" could mean "throw away the only record of which
    // deal a payment belonged to" the moment a page was opened. Every money SUM is
    // already guarded with EXISTS(bank_txn), so a stale link cannot inflate a figure —
    // it is untidy, not dangerous, and tidying it is a deliberate act, not a side
    // effect. Same reasoning removed the over-allocation healer from Financials.
  }, [load]);

  // Cross-tab navigation restore
  useEffect(() => {
    const stored = localStorage.getItem("dealflow_invoice_filter");
    if (stored) { setSearch(stored); localStorage.removeItem("dealflow_invoice_filter"); }
    try {
      const raw = localStorage.getItem("dealflow_open_section");
      if (raw) { openTarget = JSON.parse(raw); localStorage.removeItem("dealflow_open_section"); }
    } catch { openTarget = null; }
    // R-551: a truck in Logistics (or the Warehouse) asked for its buy: Inventory opens on it, and reads the key itself.
    try { if (localStorage.getItem(OPEN_BUY_KEY)) setView("inventory"); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    const onOpen = () => {
      const stored = localStorage.getItem("dealflow_invoice_filter");
      if (stored) { setSearch(stored); localStorage.removeItem("dealflow_invoice_filter"); }
      try {
        const raw = localStorage.getItem("dealflow_open_section");
        if (raw) { openTarget = JSON.parse(raw); localStorage.removeItem("dealflow_open_section"); }
      } catch { openTarget = null; }
      setOpenNonce((n) => n + 1);
    };
    window.addEventListener("dealflow-open", onOpen);
    return () => window.removeEventListener("dealflow-open", onOpen);
  }, []);

  const q        = search.toLowerCase();
  const matchFl  = (f: DealFlow) => dealMatchesQuery(f, q);

  // An active deal flow must have a corresponding invoice that is still live
  // (not is_complete, not draft). This prevents stale flows from counting.
  // Active = any invoice not yet marked complete (drafts included — all invoices track through deal flow)
  const isInvoiceActive = (flow: DealFlow) => {
    const inv = invoices.find((i) => i.id === flow.invoice_id);
    if (!inv) return false;
    return !inv.is_complete;
  };

  // Only a FULLY refunded deal leaves the pipeline. Every deal with any refund
  // activity used to be pulled out into the Refunds section, which exiled a
  // part-refunded deal: it was gone from the active list and — never having been
  // marked complete — absent from Completed too, so the only way to find it was to
  // know to look under Refunds. A part-refunded deal is still live work and stays
  // where you can finish it; handed-back money is marked by the struck-through
  // amounts on the card, not by hiding the deal.
  // "Fully refunded" means the refund covers the WHOLE DEAL — not that the refund
  // has been fully paid. The first version tested `remaining <= 0.01`, which is the
  // second thing, so attaching every payment for a PARTIAL refund is what exiled the
  // deal: owe $7,890 back on a $52,890 deal, pay all $7,890, remaining hits 0, and
  // the deal got filed as fully refunded. Doing the book-keeping properly is exactly
  // what made the deal disappear. Scope, not settlement.
  const dealValueOf = (f: DealFlow) =>
    f.gross_revenue > 0 ? f.gross_revenue
    : f.payment_received_amount > 0 ? f.payment_received_amount
    : f.invoice_total;
  const isFullyRefunded = (f: DealFlow) => {
    const r = refundMap[f.id];
    if (!r) return false;
    // Owed is the intent, refunded is the fact; a refund entered as payments with no
    // owed figure is still a refund of that size, so take whichever is larger.
    const scope = Math.max(r.refund_owed, r.refunded);
    return scope > 0.01 && scope + 0.01 >= dealValueOf(f);
  };
  // A PART refund is not a refund as far as these lists are concerned. Jack's rule:
  // "if the amount refunded is not the entire thing, i want it to show in deal flow
  // completed" — the lot did not go back, so some of it was sold and the deal is
  // concluded, not a lot sitting in a returns queue. The Refunds drawer is reserved
  // for a deal that went back WHOLE. A part-refunded deal is therefore listed under
  // Completed with its pre-refund figures struck through, and nowhere else.
  // It turns on money actually RETURNED, not merely owed — "if the amount refunded is
  // not the entire thing". A part refund entered but not yet paid is still live work and
  // stays in the pipeline; it moves across the moment its payments are attached.
  const isPartlyRefunded = (f: DealFlow) => {
    const r = refundMap[f.id];
    return !!r && !isFullyRefunded(f) && r.refunded > 0.01;
  };
  const active    = flows.filter(
    (f) => f.stage !== "complete" && !isFullyRefunded(f) && !isPartlyRefunded(f) && isInvoiceActive(f) && matchFl(f)
  );
  const completed = flows.filter((f) => f.stage === "complete" || isPartlyRefunded(f));
  // Completed deals, most recent completion first, so the list always reads top-down
  // by date. A part-refunded deal that was never marked complete has no completion
  // date, so it dates from when it was last touched rather than sinking to the bottom.
  const completedFiltered = completed.filter(matchFl).sort((a, b) => {
    const ta = Date.parse(a.completed_at || a.updated_at || "") || 0;
    const tb = Date.parse(b.completed_at || b.updated_at || "") || 0;
    return tb - ta;
  });
  const totalCompleted    = completed.length;
  // A completed deal "needs review" when a money leg has no linked bank transaction
  // and hasn't been marked "no record" — so we flag exactly which side is missing.
  const needsWorkCount    = completed.filter((f) => recon[f.id]?.needs_review).length;

  // Pending profit (R-304): what the open deals will make once they close, over the
  // deals whose supplier cost is in. The same projection each card prints — invoice
  // total minus supplier cost minus anything refunded — so the box is the sum of the
  // cards and never a second opinion. Counted before the search box filters anything.
  const openDeals    = flows.filter((f) =>
    f.stage !== "complete" && !isFullyRefunded(f) && !isPartlyRefunded(f) && isInvoiceActive(f));
  const pricedDeals  = openDeals.filter((f) => (f.supplier_payments || []).length > 0);
  const pendingRev   = pricedDeals.reduce((s, f) => s + f.invoice_total - (refundMap[f.id]?.refunded ?? 0), 0);
  // R-400: shipping is its own figure, and the cost beside it leaves it out, so the two add
  // up to what the cards subtract (`projected_cost`).
  const pendingShip  = pricedDeals.reduce((s, f) => s + shippingEstimateOf(f), 0);
  const pendingCost  = pricedDeals.reduce((s, f) => s + projectedCostOf(f), 0) - pendingShip;
  const pendingProfit = pendingRev - pendingCost - pendingShip;
  const unpricedCount = openDeals.length - pricedDeals.length;

  // Refunds section: every deal that went back whole, open ones first (most still owed
  // at the top), closed-out ones after them. Nothing is hidden behind a "Show done"
  // toggle any more (R-305) — a closed refund is still a deal somebody asks about.
  //
  // "Done" means done AND nothing left owed. The flag was written once and never
  // re-checked against the numbers, so a refund closed out while it looked settled —
  // then given a higher refund_owed, or whose refund payment later vanished — stopped
  // being anyone's problem while money was still owed. It comes back to the open list.
  const isRefundDone = (id: string) => !!refundMap[id]?.done && refundMap[id].remaining <= 0.01;
  // ── The six sections (R-486) ────────────────────────────────────────────
  // Every active deal is in exactly one: Ready to complete, Delivered with payment still missing, On the way,
  // Waiting on pickup, With Logistics, or Shipping not set up (src/lib/dealSections.ts, the rule the website shares).
  // They are pulled out of one another rather than shown twice, so the counts stay mutually exclusive, the same rule
  // the Refunds section follows. A deal leaves the moment it is completed. R-318: the delivered set is what the carrier
  // says has landed. A buyer payment the stage says was received counts as paid even with no bank payment linked.
  const today = localDay();
  const numbers = canSeePayments(me);
  const ctxOf = (f: DealFlow): DealCtx => ({
    delivered: deliveredIds.has(f.id), today, numbers,
    pay: payFactsOf(recon[f.id], si(f.stage) >= si("payment_received"), numbers),
  });
  const split = pipelineSplit(active, ctxOf);
  const described = new Map(active.map((f) => [f.id, describeDeal(f, ctxOf(f))]));

  // This week — counted as EVENTS, not deals, because one deal can both pick up
  // and land inside the window. Ships-direct deals have no pickup to count. R-486: a load not yet picked up (or on the road)
  // counts by its own day too, the one its card shows.
  const soon = (d?: string | null) => { const v = day(d); if (!v) return false; const n = daysUntil(v); return n >= 0 && n <= 7; };
  const pickupsSoon    = active.filter((f) => !f.ships_direct
    && (soon(f.pickup_date) || ((f.logistics_stage === "requested" || f.logistics_stage === "booked") && soon(f.logistics_pickup_day)))).length;
  const deliveriesSoon = active.filter((f) => !f.ships_direct
    && (soon(f.expected_delivery_date) || (f.logistics_stage === "picked_up" && soon(f.logistics_delivery_day)))).length;

  // Whole-lot refunds only — see `isPartlyRefunded`.
  const refundAll   = flows.filter((f) => refundMap[f.id] && isFullyRefunded(f));
  const refundFlows = [...refundAll].sort((a, b) =>
    (isRefundDone(a.id) ? 1 : 0) - (isRefundDone(b.id) ? 1 : 0)
    || refundMap[b.id].remaining - refundMap[a.id].remaining);
  const doneRefundCount = refundAll.filter((f) => isRefundDone(f.id)).length;

  // R-438: a deal asked for by name (a resold note, another screen) opens wherever it lives.
  // A card takes the request when it mounts, so a deal in a folded group (Refunds, Closed
  // refunds, Completed, a Pipeline section) needs its group unfolded first; its card then mounts
  // and opens. A request for a deal that is not on this screen is dropped, so it can never
  // open something later by surprise.
  useEffect(() => {
    if (!openTarget || loading) return;
    const f = flows.find((x) => x.invoice_number === openTarget!.invoice);
    if (!f) { if (flows.length) openTarget = null; return; }
    if (isFullyRefunded(f)) { setRefundsOpen(true); if (isRefundDone(f.id)) setClosedRefundsOpen(true); }
    else if (f.stage === "complete" || isPartlyRefunded(f)) setDrawerOpen(true);
    else if (described.has(f.id)) { const sec = described.get(f.id)!.section; setSectionsOpen((o) => (o[sec] ? o : { ...o, [sec]: true })); }
    else openTarget = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows, refundMap, openNonce, loading]);
  const openRefundCount = refundAll.length - doneRefundCount;

  // R-479: the Payments view is all dollars, so its switch shows only to whoever may see deal dollars.
  const showPayments = canSeePayments(me);
  const mode = view === "payments" && !showPayments ? "pipeline" : view;
  // A row on the Payments view opens its deal on Link financials. The card lives in the pipeline, so this goes back
  // there and asks for the card the way another screen does (`openTarget`); a card in a folded group is unfolded by
  // the effect above, and linking a payment reloads `recon`, so the Payments view is current when it is switched back.
  const openOnLink = (f: DealFlow) => {
    if (!f.invoice_number) return;
    openTarget = { invoice: f.invoice_number, section: "link" };
    setView("pipeline");
    setOpenNonce((n) => n + 1);
  };

  // Skeleton mirrors the real layout (header, key figures, deal rows), and only on first load, so refreshes after an action
  // don't blank the whole view.
  if (loading && flows.length === 0) return (
    <div>
      <div className="h-4 w-72 bg-surface-2 rounded animate-pulse mb-3.5 ml-1" />
      <div className="hsep" />
      <div className="grid grid-cols-4 gap-4 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-20 bg-surface-2 rounded animate-pulse" />
            <div className="h-6 w-28 bg-surface-2 rounded animate-pulse" />
          </div>
        ))}
      </div>
      <div className="hsep" />
      <div className="mt-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-t border-line first:border-t-0 px-3 py-4 flex items-center gap-4">
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-1/3 bg-surface-2 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-surface-2 rounded animate-pulse" />
            </div>
            <div className="h-8 w-44 bg-surface-2 rounded animate-pulse" />
            <div className="h-8 w-28 bg-surface-2 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );

  const syncCompleted = async () => {
    setSyncing(true);
    try {
      const n = await api.resyncAllCompletedDeals();
      toast(`Synced ${n} completed deal${n !== 1 ? "s" : ""} from bank: numbers and dates updated`);
      await load();
    } catch (e: any) { toast(String(e), "error"); }
    setSyncing(false);
  };

  // R-467: every deal with its items, dated money movements and dates, in one workbook.
  const handleExportDealFlows = async () => {
    const day = new Date().toLocaleDateString("en-CA");
    const path = await saveDialog({ filters: [{ name: "Excel", extensions: ["xlsx"] }], defaultPath: `deal-records-${day}.xlsx` });
    if (!path) return;
    try {
      const count = await api.exportDealRecords(path as string);
      toast(`Exported ${count} deal${count !== 1 ? "s" : ""} with their items and payments`);
    } catch (e: any) { toast(String(e), "error"); }
  };

  // R-486: one Pipeline section, hidden when it is empty. Ready to complete keeps its success tint, and the two sections
  // for loads that are late show how many are past their date.
  const renderSection = ({ key, title }: { key: DealSection; title: string }) => {
    const list = split[key];
    if (list.length === 0) return null;
    const late = key === "onTheWay" || key === "waitingPickup" ? list.filter((f) => described.get(f.id)?.shipping.tone === "danger").length : 0;
    return (
      <Fragment key={key}>
      <div className="hsep my-2" />
      <PipelineSection title={title} count={list.length} success={key === "ready"} open={sectionsOpen[key]}
        onToggle={() => setSectionsOpen((o) => ({ ...o, [key]: !o[key] }))}
        badge={late > 0 ? (
          <StatusPill tone="danger">{late} past {late === 1 ? "its" : "their"} date</StatusPill>
        ) : null}
        note={key === "waitingPickup" ? (
          // This week. Counted as events among active deals: one deal can both pick up and land inside the window,
          // so these are not deal counts.
          <div className="px-3 pb-2 pl-[42px] text-[12px] text-muted">
            Next 7 days: {pickupsSoon} pickup{pickupsSoon === 1 ? "" : "s"}, {deliveriesSoon} {deliveriesSoon === 1 ? "delivery" : "deliveries"}.
          </div>
        ) : null}>
        {list.map((f) => (
          <DealFlowCard key={`${f.id}:${openNonce}`} flow={f} onReload={load} refund={refundMap[f.id]}
            reconStatus={recon[f.id]} lines={described.get(f.id)} label={labels[f.id]} />
        ))}
      </PipelineSection>
      </Fragment>
    );
  };

  // R-583: the same three view switches, as the shared tab chips.
  const viewTabs = [
    { id: "pipeline", label: "Pipeline" },
    ...(showPayments ? [{ id: "payments", label: "Payments" }] : []),
    { id: "inventory", label: "Inventory" },
  ];

  return (
    <div>
      <style>{`
        @keyframes dfIn  { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes dfPop { 0% { transform: scale(.55); } 55% { transform: scale(1.2); } 100% { transform: scale(1); } }
        .df-anim { animation: dfIn .18s cubic-bezier(.23,1,.32,1) both; }
        .df-pop  { animation: dfPop .5s cubic-bezier(.2,.7,.3,1.4); }
        @media (prefers-reduced-motion: reduce) { .df-anim, .df-pop { animation: none !important; } }
      `}</style>

      <PageActions>
        <label className="ui-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search invoice, client or load number"
            aria-label="Search deals"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search" className="text-faint hover:text-ink transition-colors duration-150">
              <X size={12} />
            </button>
          )}
        </label>
        <Button onClick={load} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>Refresh</Button>
        <Button onClick={() => setLabelsOpen(true)} icon={<Tag size={14} />} title="Give every closed deal one category and one brand">Categories and brands</Button>
        <Button onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }))} icon={<Link2 size={14} />}
          title="Open Financials to match a bank payment to a deal">Match a payment</Button>
        <Button onClick={handleExportDealFlows} icon={<FileDown size={14} />}>Export</Button>
      </PageActions>

      {labelsOpen && (
        <DealLabelsModal focus={null} onClose={(changed) => { setLabelsOpen(false); if (changed) loadLabels(); }} />
      )}

      <p className="m-0 mb-3.5 ml-1 text-[14px] text-muted">
        {active.length} active deal{active.length !== 1 ? "s" : ""}
        {split.ready.length > 0 ? `, ${split.ready.length} ready to complete` : ""}
        {split.paymentMissing.length > 0 ? `, ${split.paymentMissing.length} delivered with payment missing` : ""}
        {totalCompleted > 0 ? ` · ${totalCompleted} completed` : ""}
      </p>

      {/* ── Pending profit (R-304) ─────────────────────────────────────── */}
      {pricedDeals.length > 0 && (
        <>
          <div className="hsep" />
          <div className="grid grid-cols-2 gap-x-2 py-1.5 lg:grid-cols-[minmax(0,1.3fr)_1px_repeat(3,minmax(0,1fr))]">
            <div className="p-4 col-span-2 lg:col-span-1 min-w-0">
              <div className="ui-label">Pending profit</div>
              <div className="ui-fig mt-1.5"><Figure value={pendingProfit} tone={pendingProfit >= 0 ? "up" : "down"} /></div>
              <div className="ui-note mt-1.5">
                From {pricedDeals.length} open deal{pricedDeals.length === 1 ? "" : "s"} with supplier cost entered
                {unpricedCount > 0 && ` · ${unpricedCount} still need${unpricedCount === 1 ? "s" : ""} supplier cost`}
              </div>
            </div>
            <div className="vsep hidden lg:block mt-4" />
            <Kpi label="Revenue" value={pendingRev} format={fmtAmount} />
            <Kpi label="Supplier cost" value={pendingCost} format={fmtAmount} />
            <Kpi label="Shipping" value={pendingShip} format={fmtAmount} />
          </div>
        </>
      )}
      <div className="hsep" />

      {/* The Pipeline | Payments | Inventory switch (R-479) */}
      <div className="flex items-center justify-between gap-3 flex-wrap mt-4 mb-3">
        <Tabs label="View" value={mode} onChange={(id) => setView(id as typeof view)} tabs={viewTabs} />
      </div>

      {mode === "inventory" && <div className="df-anim"><BuysView search={search} /></div>}

      {/* Priority1 shipments that arrived by email and are not on a deal yet (R-277). Above the six sections so they run
          on without a break (R-486). */}
      {mode !== "inventory" && <UnlinkedShipments onChange={load} />}

      {/* ── The six Pipeline sections (R-486) ───────────────────────────────────────── */}
      {mode === "pipeline" && DEAL_SECTIONS.map(renderSection)}

      {/* ── Active deals ──────────────────────────────────────────────── */}
      {mode === "inventory" ? null : mode === "payments" ? (
        <PaymentsView deals={active} recon={recon} invoices={invoices} searching={!!search}
          canMove={canPayCarriers(me)} moved={moved} onOpen={openOnLink}
          onMoved={(f, made) => { setMoved((m) => ({ ...m, [f.id]: { id: made.id, number: loadNumber(made) } })); load(); }} />
      ) : active.length === 0 ? (
        <div className="py-16 flex flex-col items-center">
          <div className="text-[14px] text-muted">
            {search
              ? "No active deals match your search"
              : "No active deals. Deals appear automatically when invoices are sent"}
          </div>
        </div>
      ) : null}

      {/* ── Completed deals drawer ──────────────────────────────────────── */}
      {mode !== "inventory" && totalCompleted > 0 && (
        <>
          <div className="hsep my-2" />
          <PipelineSection title="Completed deals" count={totalCompleted} open={drawerOpen} onToggle={() => setDrawerOpen(!drawerOpen)}
            badge={needsWorkCount > 0 ? <StatusPill tone="warning">{needsWorkCount} need review</StatusPill> : null}
            action={
              <button onClick={(e) => { e.stopPropagation(); syncCompleted(); }} disabled={syncing}
                className="ui-btn ui-btn-sm !border-transparent text-muted"
                title="Re-pull recorded numbers from the bank and date each completed deal to when the supplier was actually paid">
                <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> Sync from bank
              </button>}>
            {completedFiltered.length === 0 ? (
              <p className="text-[13px] text-faint text-center py-8">
                {search ? "No completed deals match your search" : "No completed deals yet"}
              </p>
            ) : (
              completedFiltered.map((flow) => (
                <DealFlowCard key={`${flow.id}:${openNonce}`} flow={flow} onReload={load} refund={refundMap[flow.id]} reconStatus={recon[flow.id]} label={labels[flow.id]} />
              ))
            )}
          </PipelineSection>
        </>
      )}

      {/* ── Refunds ─────────────────────────────────────────────────────── */}
      {/* Last on the page and closed by default: a refunded deal is history, and the
          active list above it is the screen's whole job. Inside, a refunded deal is an
          ordinary card whose pill carries the refund amount: the refund itself is a
          step inside that card, beside Link financials, so the deal's payments and
          links are still there to read. */}
      {mode !== "inventory" && refundAll.length > 0 && (
        <>
          <div className="hsep my-2" />
          <PipelineSection title="Refunds" count={refundAll.length} open={refundsOpen} onToggle={() => setRefundsOpen(!refundsOpen)}
            badge={<span className="text-[12.5px] text-muted truncate">{openRefundCount > 0 ? `${openRefundCount} still open` : "Every refund is closed out"}</span>}>
            {refundFlows.filter((f) => !isRefundDone(f.id)).map((flow) => (
              <DealFlowCard key={`${flow.id}:${openNonce}`} flow={flow} onReload={load} refund={refundMap[flow.id]} reconStatus={recon[flow.id]} label={labels[flow.id]} />
            ))}
            {openRefundCount === 0 && <div className="text-[13px] text-muted px-3 py-3">No refund is open.</div>}
            {/* R-438: a closed refund is still a deal somebody asks about, so it stays in the
                list (R-305), in its own folded group, where closing one visibly moves it. */}
            {doneRefundCount > 0 && (
              <div className="mt-1">
                <button onClick={() => setClosedRefundsOpen(!closedRefundsOpen)} aria-expanded={closedRefundsOpen}
                  className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink px-3 h-10 transition-colors duration-150">
                  <ChevronRight size={14} className={`transition-transform duration-200 ${closedRefundsOpen ? "rotate-90" : ""}`} />
                  Closed refunds · {doneRefundCount}
                </button>
                {closedRefundsOpen && <div className="df-anim">{refundFlows.filter((f) => isRefundDone(f.id)).map((flow) => (
                  <DealFlowCard key={`${flow.id}:${openNonce}`} flow={flow} onReload={load} refund={refundMap[flow.id]} reconStatus={recon[flow.id]} label={labels[flow.id]} />
                ))}</div>}
              </div>
            )}
          </PipelineSection>
        </>
      )}
    </div>
  );
}

// ─── A figure that counts to its new value ────────────────────────────────────────────────────────
function Figure({ value, tone, className = "" }: { value: number; tone?: "up" | "down"; className?: string }) {
  const n = useCountUp(value);
  const shown = n ?? value;
  return (
    <span className={`tabular-nums ${tone === "up" ? "text-success-ink" : tone === "down" ? "text-danger-ink" : ""} ${className}`}>
      {shown < 0 ? "−" : ""}{fmtAmount(Math.abs(shown))}
    </span>
  );
}

// ─── A Pipeline section (R-486) ─────────────────────────────────────────────────────────────
// A bar that folds the rows under it: a chevron, the title with its count, and a quiet note. Ready to complete wears the success tint
// the delivered box had (R-318). The sections are divided by the fading hairline, not boxed.
function PipelineSection({ title, count, success, open, onToggle, badge, note, action, children }: {
  title: string; count: number; success?: boolean; open: boolean; onToggle: () => void;
  badge?: ReactNode; note?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div {...barToggle(onToggle)} aria-expanded={open}
        className={`flex items-center justify-between gap-3 min-h-[48px] px-3 rounded-lg cursor-pointer transition-colors duration-150 ${success ? "bg-success-bg" : "hover:bg-surface-2"}`}>
        <div className="flex items-center gap-2.5 text-left min-w-0 flex-wrap">
          <ChevronRight size={16} className={`flex-shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
          <span className={`text-[14px] font-medium ${success ? "text-success-ink" : "text-ink"}`}>{title}</span>
          <span className={`text-[14px] tabular-nums ${success ? "text-success-ink" : "text-muted"}`}>({count})</span>
          {badge}
        </div>
        {action}
      </div>
      {note}
      {open && <div className="df-anim">{children}</div>}
    </section>
  );
}

// ─── The two lines under a card's client and invoice (R-486) ────────────────────────────────
// Where shipping stands, and what the deal still needs. The words come from lib/dealSections.ts; this only paints them.
// The late part of the shipping line is in the danger tone, and the amounts on the still-needed line are medium weight.
const LINE_TONE: Record<LineTone, string> = { ink: "text-ink", muted: "text-muted", success: "text-success-ink", danger: "text-danger-ink" };
const AMOUNT = /(\$[\d,]+(?:\.\d{2})?)/;

function DealLines({ lines }: { lines: DealDescription }) {
  const { shipping, needed } = lines;
  return (
    <div className="mt-1 space-y-0.5">
      <div className="text-[12.5px] leading-snug">
        {shipping.parts.map((p, i) => <span key={i} className={LINE_TONE[p.tone]}>{p.text}</span>)}
      </div>
      {needed && (
        <div className={`text-[12.5px] leading-snug ${LINE_TONE[needed.tone]}`}>
          {needed.text.split(AMOUNT).map((t, i) => (i % 2 === 1 ? <span key={i} className="font-medium">{t}</span> : t))}
        </div>
      )}
    </div>
  );
}

// ─── Payments view (R-479) ────────────────────────────────────────────────
// The same active deals as the pipeline, grouped by what payment is still needed: nothing linked yet, waiting on the
// buyer, the supplier to pay, or all linked. It reads the bank links only (`reconciliation_status_all`), the same truth as
// the Link financials step, so a deal is never "All linked" here and flagged on the Completed drawer later. Shipping is
// tracked in Logistics and is not part of any figure. The grouping rule and the wording live in lib/dealPayments.ts.
// R-555: a payment with nothing linked reads red, one part linked amber.
const LEG_TONE: Record<LegTone, string> = { owed: "text-danger-ink", part: "text-warning-ink", done: "text-success-ink", quiet: "text-muted" };

function LegLine({ leg }: { leg: PaymentLeg }) {
  return (
    <div className={`text-[12.5px] leading-snug ${LEG_TONE[leg.tone]}`}>
      {leg.text}
      {leg.note && <span className="text-muted"> · {leg.note}</span>}
    </div>
  );
}

function PaymentsView({ deals, recon, invoices, searching, canMove, moved, onOpen, onMoved }: {
  deals: DealFlow[]; recon: Record<string, Partial<Record<string, unknown>>>; invoices: Invoice[]; searching: boolean;
  canMove: boolean; moved: Record<string, { id: string; number: string }>;
  onOpen: (f: DealFlow) => void; onMoved: (f: DealFlow, made: FreightBooking) => void;
}) {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  // A draft invoice has nothing to be paid yet, so it would read "No payments yet" for as long as it stayed a draft.
  const live = deals.filter((f) => (byId.get(f.invoice_id)?.status ?? "").toLowerCase() !== "draft");
  const drafts = deals.length - live.length;
  let unread = 0;
  const entries: PaymentEntry<DealFlow>[] = [];
  for (const f of live) {
    const figures = paymentFiguresOf(recon[f.id]);
    if (!figures) { unread += 1; continue; }
    entries.push({ item: f, figures, since: byId.get(f.invoice_id)?.issue_date || f.created_at || "" });
  }
  const groups = groupPayments(entries).filter((g) => g.entries.length > 0);

  // A load number opens the load in Logistics. The number is on the deal, the id is on the booking, so it is looked up.
  const openLoad = async (f: DealFlow, ld: string) => {
    const made = moved[f.id];
    if (made && made.number === ld) { openLoadInLogistics(made.id); return; }
    try {
      const hit = (await api.listFreightBookings(f.id)).find((b) => (b.load_number || "").trim() === ld);
      if (hit) openLoadInLogistics(hit.id);
      else toast("That load has not reached this computer yet. Try again in a moment.", "error");
    } catch (e) { toast(String(e), "error"); }
  };

  if (live.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center">
        <div className="text-[14px] text-muted">
          {searching ? "No active deals match your search" : drafts > 0 ? "Every active deal is still a draft" : "No active deals"}
        </div>
        {drafts > 0 && <div className="text-[12px] text-muted mt-1">{drafts} {drafts === 1 ? "draft" : "drafts"} not shown</div>}
      </div>
    );
  }
  return (
    <div className="df-anim">
      <p className="text-[12px] text-muted mb-3">
        {live.length} active {live.length === 1 ? "deal" : "deals"}, grouped by what the bank links do not cover yet
        {drafts > 0 ? ` · ${drafts} ${drafts === 1 ? "draft" : "drafts"} not shown` : ""}
        {unread > 0 ? ` · ${unread} ${unread === 1 ? "deal is" : "deals are"} still loading payment figures` : ""}
      </p>
      {groups.map((g, gi) => (
        <section key={g.key} aria-label={g.title}>
          {gi > 0 && <div className="hsep my-3" />}
          <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap px-3 py-2">
            <h3 className="text-[14px] font-medium text-ink m-0">{g.title}</h3>
            <span className="text-[12px] text-muted tabular-nums">{groupSummary(g)}</span>
          </div>
          <ul className="list-none m-0 p-0">
            {g.entries.map(({ item: f, figures }) => {
              const loads = loadNumbersOf(f);
              const made = moved[f.id];
              if (made && !loads.includes(made.number)) loads.push(made.number);
              const sup = primarySupplierLabel(f.supplier_payments);
              return (
                <li key={f.id} className="flex items-stretch border-t border-line transition-colors duration-150 hover:bg-surface-2">
                  <button type="button" onClick={() => onOpen(f)} title="Open on Link financials"
                    className="flex-1 min-w-0 flex items-start gap-3 pl-3 pr-3 py-3 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="text-[12.5px] tabular-nums text-muted flex-shrink-0">{f.invoice_number}</span>
                        <span className="text-[14px] text-ink truncate min-w-0">
                          <span className="font-medium">{f.client_name || "Unknown"}</span>
                          {sup ? <span className="text-[12.5px] text-muted"> to {sup}</span> : null}
                        </span>
                      </div>
                      <div className="mt-1 space-y-0.5">
                        <LegLine leg={buyerLeg(figures, si(f.stage) >= si("payment_received"))} />
                        <LegLine leg={supplierLeg(figures)} />
                      </div>
                    </div>
                    <span className="text-[14px] font-medium text-ink tabular-nums flex-shrink-0" title="Invoice total">{money(f.invoice_total)}</span>
                  </button>
                  {/* A fixed column, so the totals line up whether the row has a button, a load number or neither. */}
                  <div className="w-[168px] flex-shrink-0 flex items-center justify-end gap-3 flex-wrap pl-1 pr-3 py-2">
                    {loads.length > 0 ? loads.map((ld) => (
                      <button key={ld} type="button" onClick={() => openLoad(f, ld)} title="Open the load in Logistics"
                        className="tabular-nums text-[12.5px] text-ship-ink hover:underline">{ld}</button>
                    )) : canMove && canMoveDeal(f) ? (
                      <MoveToLogistics flow={f} onMoved={(made) => onMoved(f, made)} />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Deal flow card ───────────────────────────────────────────────────────
/** R-400: where the deal's trucks are. The least advanced live booking names the stage; once
 *  every truck is at least picked up and one has no amount paid yet, the word is the ask. */
function ShippingPill({ flow, askOnly }: { flow: DealFlow; askOnly?: boolean }) {
  const stage = flow.logistics_stage || "";
  const ask = (flow.logistics_unpaid ?? 0) > 0 && (stage === "picked_up" || stage === "delivered");
  if (ask) return <AmountNeededPill />;
  // R-486: on a Pipeline card the shipping line names the stage, so only the carrier ask stays.
  return stage && !askOnly ? <FreightStatusPill status={stage} /> : null;
}

function invoiceStatusPill(status: string | undefined): { label: string; tone: "neutral" | "success" | "danger" } {
  const s = (status ?? "").toLowerCase();
  if (s === "draft")           return { label: "Draft",   tone: "neutral" };
  if (s === "sent")            return { label: "Sent",    tone: "neutral" };
  if (s === "deposit_pending") return { label: "Sent",    tone: "neutral" };
  if (s === "paid")            return { label: "Paid",    tone: "success" };
  if (s === "overdue")         return { label: "Overdue", tone: "danger" };
  return { label: status ?? "None", tone: "neutral" };
}

// ─── Section model ────────────────────────────────────────────────────────
// Four focused steps. The DB keeps its four stages; these sections just present
// them (plus the bank-linking + profit review) one screen at a time.
//
// "Money movement" was folded away (R-132) — the money is tracked in Financials
// now, so a step that re-stated it was a second place to look. Its two halves
// moved to where each already belonged: the supplier legs' paid/kept state onto
// the cost lines in Supplier & cost, and the buyer payment onto Link financials
// beside the bank transaction it is paired to. Since R-302 there is no button for the
// buyer payment at all: `complete_deal_flow` records it (amount, date, invoice paid)
// when a deal completes straight from `invoiced`, and a reopened deal still unwinds
// through `uncomplete_deal_flow` as before.
// R-458: Shipping is the second step: once the supplier is in, the truck is the next thing to arrange.
const SECTIONS = [
  { key: "supplier", label: "Supplier & cost" },
  { key: "shipping", label: "Shipping" },
  { key: "link",     label: "Link financials" },
  { key: "profit",   label: "Profit" },
  { key: "complete", label: "Review & complete" },
] as const;
type SectionKey = typeof SECTIONS[number]["key"] | "refund";
const sIdx = (k: SectionKey) => SECTIONS.findIndex((s) => s.key === k);

// R-401: a screen elsewhere (Payables) can ask for one deal to open on one step. The request
// is stashed under `dealflow_open_section` with the invoice number, read once when this view
// mounts, and taken by the card for that invoice.
let openTarget: { invoice: string; section: SectionKey } | null = null;

// R-513: the supplier invoice files on one deal. The list syncs on the deal row; the bytes come
// from the server. Adding and removing ride the server's routes, which enforce deal edit access
// (the UI hides both while the card is edit-locked).
function SupplierInvoices({ flow, locked, onReload }: { flow: DealFlow; locked: boolean; onReload: () => void }) {
  const files = (flow.files ?? []).filter((f) => f && f.id);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const open = async (f: FreightFile) => {
    try {
      const got = await api.dealFiles.get(flow.id, f.id);
      const bin = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
      setPreview({ url: URL.createObjectURL(new Blob([bin], { type: got.mime })), name: got.name });
    } catch (e) { toast(String(e), "error"); }
  };
  const save = async (f: FreightFile) => {
    const dest = await saveDialog({ defaultPath: f.name });
    if (!dest) return;
    try { await api.dealFiles.saveAs(flow.id, f.id, dest); toast("Saved"); } catch (e) { toast(String(e), "error"); }
  };
  const remove = async (f: FreightFile) => {
    if (!confirm(`Remove ${f.name} from this deal?`)) return;
    try { await api.dealFiles.remove(flow.id, f.id); toast("Invoice removed"); onReload(); } catch (e) { toast(String(e), "error"); }
  };
  const add = async (list: File[]) => {
    setBusy(true);
    let ok = 0;
    for (const f of list) {
      try { await api.dealFiles.add(flow.id, f.name, await fileBase64(f)); ok++; }
      catch (e) { toast(`${f.name}: ${String(e)}`, "error"); }
    }
    setBusy(false);
    if (ok > 0) { toast(ok === 1 ? "Invoice attached" : `${ok} invoices attached`); onReload(); }
  };
  return (
    <div className="px-5 py-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[14px] font-medium text-ink">Supplier invoices</span>
        <StatusPill tone={files.length ? "success" : "neutral"}>{files.length ? `${files.length} on file` : "None yet"}</StatusPill>
      </div>
      {files.length > 0 && (
        <div>
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 py-2 min-w-0 border-t border-line first:border-t-0">
              <FileDown size={16} className="text-muted flex-shrink-0" />
              <button type="button" onClick={() => open(f)} className="min-w-0 flex-1 text-left">
                <div className="text-[13px] text-ink truncate hover:underline">{f.name}</div>
                <div className="text-[12px] text-muted truncate">{[fileSize(f.size || 0), f.by, f.at ? parseLocalDay(f.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""].filter(Boolean).join(", ")}</div>
              </button>
              {!locked && (
                <>
                  <button type="button" onClick={() => save(f)} title="Save a copy" aria-label="Save a copy"
                    className="ui-ib flex-shrink-0"><FileDown size={16} /></button>
                  <button type="button" onClick={() => remove(f)} title="Remove" aria-label="Remove"
                    className="ui-ib flex-shrink-0 hover:!text-danger-ink"><Trash2 size={16} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!locked && (
        <FileDrop onFiles={add} busy={busy} prompt="a supplier invoice PDF" hint="Each file up to 15 MB" />
      )}
      {preview && (
        <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-6 df-anim" onClick={() => setPreview(null)}>
          <div className="bg-surface rounded-xl shadow-xl ring-1 ring-line w-full max-w-3xl h-[80vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line">
              <span className="text-[13px] font-medium text-ink truncate">{preview.name}</span>
              <button onClick={() => setPreview(null)} aria-label="Close" className="ui-ib ml-auto"><X size={16} /></button>
            </div>
            <iframe src={preview.url} title={preview.name} className="flex-1 w-full bg-surface" />
          </div>
        </div>
      )}
    </div>
  );
}

function DealFlowCard({
  flow, onReload, refund, reconStatus, lines, label,
}: { flow: DealFlow; onReload: () => void; lines?: DealDescription; label?: { category: string; brand: string }; refund?: { refund_owed: number; refunded: number; remaining: number; done?: boolean }; reconStatus?: PaymentFlags & { needs_financials: boolean; has_financials: boolean; fully_reconciled: boolean; buyer_missing: boolean; supplier_missing: boolean; needs_review: boolean; shipping_missing?: boolean } }) {  // Collapsed by default, unless another screen asked for this deal on a step (R-401).
  const [wanted] = useState<SectionKey | null>(() => {
    if (openTarget && openTarget.invoice === flow.invoice_number) { const s = openTarget.section; openTarget = null; return s; }
    return null;
  });
  const navigated = useRef(false);
  const [isOpen,    setIsOpen]    = useState(wanted !== null);
  // R-438: a card opened by request scrolls into view (it may be at the foot of the page).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (wanted) rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, []);
  // Two independent questions, and collapsing them is what made a properly booked
  // partial refund read as a full one (same ladder as mobile's `refundBadgeHTML`):
  //   SCOPE  — how much of the deal is being given back: all of it, or part of it?
  //   SETTLED — has the money owed back actually gone out?
  // A deal can be partially refunded AND fully settled, which is the ordinary case
  // once the refund payments are attached, and it must not say "Refunded".
  const refundOwed = refund?.refund_owed ?? 0;
  const refundPaid = refund?.refunded ?? 0;
  const refundScope = Math.max(refundOwed, refundPaid);
  const dealValue = flow.gross_revenue > 0 ? flow.gross_revenue
    : flow.payment_received_amount > 0 ? flow.payment_received_amount
    : flow.invoice_total;
  const wholeDeal = refundScope > 0.01 && refundScope + 0.01 >= dealValue;
  const settled   = refundScope > 0.01 && refundPaid + 0.01 >= refundScope;
  const refundLeft = Math.max(Math.round((refundScope - refundPaid) * 100) / 100, 0);
  const refundState: "full" | "full-owed" | "part" | "part-owed" | null =
    !refund ? null
    : wholeDeal ? (settled ? "full" : "full-owed")
    : (settled ? "part" : "part-owed");
  const [invStatus, setInvStatus] = useState<string | undefined>(undefined);
  const [invItems,  setInvItems]  = useState<{ description: string; qty: number; rate: number; amount: number }[]>([]);
  const [invMeta,   setInvMeta]   = useState<{ subtotal: number; tax: number; total: number; number: string; issued: string; due: string } | null>(null);
  // True once the invoice has been read (or failed to), so the per-unit figures show a skeleton, not a wrong "unknown".
  const [invDone, setInvDone] = useState(false);
  // R-489: Schedule and Freight fold into one line until opened.
  const [showSched, setShowSched] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [reconLinked, setReconLinked] = useState(false);

  // Derived section-completion from the deal's real state.
  const payments      = flow.supplier_payments || [];
  const hasSuppliers  = payments.length > 0;
  const isComplete    = flow.stage === "complete";
  const supplierDone  = hasSuppliers || si(flow.stage) > si("invoiced");
  const pay           = paymentState(flow, reconStatus);
  const refundDone    = !!refund?.done && (refund?.remaining ?? 0) <= 0.01;

  // `reconStatus` comes from the list-level fetch and covers EVERY live deal, so the
  // dots are right on a collapsed card. `reconLinked` is this card's own fetch, which
  // only runs once opened — it's OR'd in so pairing inside the card fills the dot
  // straight away instead of waiting for a reload.
  const hasLinks = !!reconStatus?.has_financials || reconLinked;

  const done: Record<typeof SECTIONS[number]["key"], boolean> = {
    // Filled the moment a supplier cost is entered (R-302). Whether each leg has gone
    // out is a payment question, answered by the payment pill on the card — holding
    // this dot for it left it empty on every deal whose supplier was not yet paid.
    supplier: supplierDone,
    // R-400: a truck sent to logistics, a shipping payment linked, freight typed on the
    // deal, or the answer "it ships direct". Any of them is an answered question.
    // R-459: a load still at the quote stage is a truck not yet, but asking for it answers the question too.
    shipping: !!flow.ships_direct || (flow.logistics_bookings ?? 0) > 0 || flow.logistics_stage === "quote" || flow.logistics_stage === "quoted" || (flow.shipping_linked ?? 0) > 0.005 || (flow.freight_typed ?? 0) > 0.005,
    // The link dot fills only when there's nothing left to link — every money leg
    // that's owed is either paired to the bank or explicitly marked "no record"
    // (reconStatus.needs_review === false). Being complete is NOT enough on its own:
    // you can complete now and reconcile later, and the dot must stay empty until you do.
    link:     isComplete ? (!!reconStatus && !reconStatus.needs_review) : hasLinks,
    profit:   hasLinks || isComplete,
    complete: isComplete,
  };

  const firstOpen = (): SectionKey => {
    // A refunded deal opens on its refund: it is what you came to read. Every other
    // step stays one click away, which is the whole reason the refund is a step.
    if (wanted && !navigated.current) return wanted;
    if (refundState !== null) return "refund";
    if (isComplete) return "complete";
    if (!supplierDone) return "supplier";
    // R-458: the truck comes next until it is sent, or the deal ships direct.
    if (!done.shipping) return "shipping";
    return "link";
  };
  const [section, setSection] = useState<SectionKey>(firstOpen);
  const [animKey, setAnimKey] = useState(0);
  const [flash,   setFlash]   = useState<SectionKey | null>(null);

  const go = (k: SectionKey) => { navigated.current = true; setSection(k); setAnimKey((a) => a + 1); };
  // Advance to the next section with a little "step complete" flourish.
  const advance = (from: SectionKey) => {
    const next = SECTIONS[Math.min(sIdx(from) + 1, SECTIONS.length - 1)].key;
    setFlash(from);
    setTimeout(() => setFlash(null), 550);
    go(next);
  };

  // When the deal's stage changes underneath us, keep the view on a sensible step.
  useEffect(() => { setSection(firstOpen()); /* eslint-disable-next-line */ }, [flow.stage, refundState]);

  // R-574: the invoice being linked to a delivery, while its card is open.
  const [linkInv, setLinkInv] = useState<Invoice | null>(null);

  // Fetch invoice status + line items for the header / breakdown.
  useEffect(() => {
    api.getInvoice(flow.invoice_id)
      .then((inv) => {
        setInvStatus(inv.status);
        setInvMeta({ subtotal: inv.subtotal ?? 0, tax: inv.tax ?? 0, total: inv.total ?? 0, number: inv.number ?? "", issued: inv.issue_date ?? "", due: inv.due_date ?? "" });
        try {
          const li: any[] = JSON.parse(inv.line_items_json || "[]");
          setInvItems(li.map((it: any) => ({ description: it.description, qty: it.qty, rate: it.rate ?? 0, amount: it.amount ?? 0 })));
        } catch {}
        setInvDone(true);
      })
      .catch(() => { setInvDone(true); });
  }, [flow.invoice_id]);

  // Know whether any bank transaction is linked, so the Link/Profit steps show as done.
  useEffect(() => {
    if (!isOpen) return;
    api.dealReconciliation(flow.id)
      .then((r) => {
        const p = r?.pieces;
        setReconLinked(!!p && ((p.buyer_paired || 0) + (p.supplier_paired || 0) + (p.fee_paired || 0) + (p.shipping_paired || 0) + (p.refund_total || 0) + (p.refund_in || 0) > 0.005));
      })
      .catch(() => {});
  }, [flow.id, isOpen, flow.stage]);

  const invPill = invoiceStatusPill(invStatus);
  const locked  = isComplete && !editMode; // completed deals are read-only until "Edit" is pressed
  // R-480: the blue dot is the step the deal is on. A collapsed card shows the deal's own step, whichever tab was last
  // looked at; the open card shows the step being viewed, as its step bar does.
  const here = isOpen ? section : firstOpen();

  const goodsLines = invItems.filter((it) => !isShippingLine(it.description));
  const units = unitFigures(invItems, flow);
  const dayShort = (v: string) => parseLocalDay(v.slice(0, 10)).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // The status chips that are not the buyer payment or the invoice: where the freight is, the date, what is missing, the refund.
  const statusChips: ReactNode[] = [];
  if ((flow.logistics_bookings ?? 0) > 0) statusChips.push(<ShippingPill key="ship" flow={flow} askOnly={!!lines} />);
  if (!isComplete && !lines) statusChips.push(<ShipChip key="date" flow={flow} />);
  statusChips.push(<FreightChip key="freight" dealFlowId={flow.id} />);
  if (isComplete && flow.completed_at) statusChips.push(
    <span key="done" className="text-[12px] text-muted tabular-nums whitespace-nowrap">
      {parseLocalDay(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
    </span>);
  if (isComplete && reconStatus?.needs_review) statusChips.push(
    <StatusPill key="miss" tone="warning">
      {[reconStatus.buyer_missing, reconStatus.supplier_missing, !!reconStatus.shipping_missing].filter(Boolean).length > 1 ? "Missing links"
        : reconStatus.buyer_missing ? "Missing buyer payment"
        : reconStatus.supplier_missing ? "Missing supplier payment"
        : "Missing shipping payment"}
    </StatusPill>);
  if (isComplete && reconStatus && !reconStatus.needs_review && reconStatus.fully_reconciled) statusChips.push(
    <StatusPill key="rec" tone="success">Reconciled</StatusPill>);
  // R-489: shown when there is a refund to read; a deal without one starts it from the Refund step.
  if (refundState !== null) statusChips.push(
    <button key="refund" type="button"
      onClick={(e) => { e.stopPropagation(); setIsOpen(true); go("refund"); }}
      title={refund ? `${fmtAmount(refundPaid)} of ${fmtAmount(refundOwed)} refunded` : undefined}
      className="rounded-full transition-[filter] duration-150 hover:brightness-110">
      <StatusPill tone={refundState === "full" ? "danger" : refundState === "part" || refundState === "full-owed" || refundState === "part-owed" ? "warning" : "neutral"}>
        {refundState === "full" ? (refundDone ? "Refund closed" : "Refunded")
          : refundState === "part" ? `Partially refunded ${fmtAmount(refundPaid)}${refundDone ? " · closed" : ""}`
          : refundState === "part-owed" ? `Partial refund owed ${fmtAmount(refundLeft)}`
          : refundState === "full-owed" ? `Refund owed ${fmtAmount(refundLeft)}`
          : "Refund"}
      </StatusPill>
    </button>);

  return (
    <div ref={rootRef} className={`border-t border-line first:border-t-0 transition-colors duration-150 ${isOpen ? "bg-surface-2" : ""}`}>
      {linkInv && <LinkDeliveryModal invoice={linkInv} onClose={() => { setLinkInv(null); onReload(); }} />}

      {/* The row: what the deal is, what each unit cost and was billed at, and the money, in three divided groups. */}
      <div {...barToggle(() => setIsOpen((v) => !v))} aria-expanded={isOpen}
        className={`grid gap-x-5 gap-y-3 px-3 py-4 cursor-pointer transition-colors duration-150 lg:grid-cols-[minmax(0,1fr)_1px_236px_1px_168px] ${isOpen ? "" : "hover:bg-surface-2"}`}>

        {/* What it is */}
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <ChevronRight size={16} className={`flex-shrink-0 text-muted transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`} />
            <span className="text-[12.5px] tabular-nums text-muted flex-shrink-0">{flow.invoice_number}</span>
            <span className="text-[14px] text-ink truncate min-w-0">
              <span className="font-medium">{flow.client_name || "Unknown"}</span>
              {(() => {
                const sup = primarySupplierLabel(flow.supplier_payments);
                return sup ? <span className="text-[12.5px] text-muted"> to {sup}</span> : null;
              })()}
            </span>
          </div>
          <div className="pl-[26px]">
            {lines && <DealLines lines={lines} />}
            {/* R-489: what was sold, at reading size; freight and shipping lines are charges, not goods. */}
            <div className="mt-1.5 flex items-center gap-2 min-w-0">
              {label && (label.category || label.brand) && (
                <span className="flex items-center gap-1.5 flex-shrink-0">
                  {label.category && <StatusPill tone="neutral" title="Category">{label.category}</StatusPill>}
                  {label.brand && <StatusPill tone="neutral" title="Brand">{label.brand}</StatusPill>}
                </span>
              )}
              {goodsLines.length > 0 && (
                <span className="text-[13px] text-ink-2 truncate">
                  {goodsLines.map((it) => it.qty > 1 ? `${it.qty}× ${it.description}` : it.description).join(" · ")}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-x-2.5 gap-y-1.5 flex-wrap">
              {/* R-480: the bar for the step the deal is on (`here`) is lit, finished steps are grey, the rest empty. */}
              <div className="flex items-center gap-[2px] flex-shrink-0" title={`On step: ${here === "refund" ? "Refund" : SECTIONS.find((s) => s.key === here)?.label ?? ""}`}>
                {SECTIONS.map((s) => (
                  <i key={s.key} className={`block w-3 h-[3px] rounded-sm transition-colors duration-200 ${
                    s.key === here ? "bg-ink" : done[s.key] ? "bg-faint" : "bg-surface-3"}`} />
                ))}
              </div>
              {statusChips}
            </div>
          </div>
        </div>

        <div className="vsep hidden lg:block self-stretch" />

        {/* Cost per unit and charged per unit, side by side */}
        <div className="min-w-0 pl-[26px] lg:pl-0">
          {!invDone ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><div className="h-3 w-14 bg-surface-3 rounded animate-pulse" /><div className="h-4 w-16 bg-surface-3 rounded animate-pulse" /></div>
              <div className="space-y-1.5"><div className="h-3 w-14 bg-surface-3 rounded animate-pulse" /><div className="h-4 w-16 bg-surface-3 rounded animate-pulse" /></div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0" title="What you paid the supplier for the goods, per unit. Shipping is not in it.">
                  <div className="ui-label">Cost per unit</div>
                  {units.costPerUnit !== null
                    ? <div className="text-[14px] font-medium tabular-nums text-ink mt-0.5">{fmtAmount(units.costPerUnit)}</div>
                    : <div className="text-[12px] text-faint mt-1">{unitGap(units, "cost")}</div>}
                </div>
                <div className="min-w-0" title="What the customer was billed for the goods, per unit. Shipping is not in it.">
                  <div className="ui-label">Charged per unit</div>
                  {units.chargedPerUnit !== null
                    ? <div className="text-[14px] font-medium tabular-nums text-ink mt-0.5">{fmtAmount(units.chargedPerUnit)}</div>
                    : <div className="text-[12px] text-faint mt-1">{unitGap(units, "charged")}</div>}
                </div>
              </div>
              {units.units !== null && <div className="ui-note mt-1.5 tabular-nums">{units.units.toLocaleString("en-US")} {units.units === 1 ? "unit" : "units"}</div>}
            </>
          )}
        </div>

        <div className="vsep hidden lg:block self-stretch" />

        {/* The money. Refunded money is gone, so the deal's real figures are the originals minus what went back, and a deal
            can end up negative. The original stays on screen with a red line through it rather than being rewritten. */}
        <div className="min-w-0 pl-[26px] lg:pl-0 lg:text-right">
          {(() => {
            const struck = refundPaid > 0.005;
            return (
              <div className="flex items-baseline gap-1.5 lg:justify-end">
                {struck && (
                  <span className="text-[12px] tabular-nums text-muted line-through decoration-danger-ink decoration-[1.5px]">
                    {fmtAmount(flow.invoice_total)}
                  </span>
                )}
                <span className="text-[14px] font-medium text-ink tabular-nums">{fmtAmount(flow.invoice_total - refundPaid)}</span>
              </div>
            );
          })()}
          {!isComplete && (() => {
            const raw  = flow.invoice_total - projectedCostOf(flow);
            const proj = raw - refundPaid;
            return (
              // R-555: green is only ever linked money, so a projection reads faded.
              <div className="flex items-baseline gap-1.5 text-[12px] tabular-nums text-faint mt-0.5 lg:justify-end"
                title="Projected profit: revenue minus supplier and shipping costs entered so far, minus anything refunded. What gets booked is the linked payments.">
                {refundPaid > 0.005 && (
                  <span className="text-[12px] text-muted line-through decoration-danger-ink decoration-[1.5px]">{fmtAmount(raw)}</span>
                )}
                <span>{fmtAmount(proj)} proj</span>
              </div>
            );
          })()}
          {isComplete && (() => {
            const net = flow.net_profit    - refundPaid;
            const rev = flow.gross_revenue - refundPaid;
            const mgn = rev > 0 ? (net / rev) * 100 : 0;
            return (
              <div className={`flex items-baseline gap-1.5 text-[12px] font-medium tabular-nums mt-0.5 lg:justify-end ${net >= 0 ? "text-success-ink" : "text-danger-ink"}`}
                title="Recorded profit · margin (net profit ÷ revenue), after refunds">
                {refundPaid > 0.005 && (
                  <span className="text-[12px] font-normal text-muted line-through decoration-danger-ink decoration-[1.5px]">{fmtAmount(flow.net_profit)}</span>
                )}
                <span>{fmtAmount(net)} <span className="font-normal text-muted">{mgn.toFixed(0)}% margin</span></span>
              </div>
            );
          })()}
          <div className="mt-2 flex items-center gap-1.5 flex-wrap lg:justify-end">
            <StatusPill tone={invPill.tone}>{invPill.label}</StatusPill>
            {/* Whether the buyer has paid (R-303, R-401). R-486: a Pipeline card's "Still needed" line says it already, so the
                pill shows only where the card has no lines. */}
            {!isComplete && !lines && (
              <StatusPill tone={pay.hasCost && pay.buyerIn ? "success" : "warning"} title={pay.title}>{pay.label}</StatusPill>
            )}
          </div>
        </div>
      </div>

      {/* The open deal, in divided groups: refund, invoice, schedule, supplier invoices, steps. */}
      {isOpen && (
        <div className="df-anim">
          {refundState === "full" && (
            <>
              <div className="hsep" />
              <div className="flex items-center gap-3 px-5 py-3 text-danger-ink">
                <span className="text-[14px] font-medium">Fully refunded</span>
                <span className="ml-auto text-[12.5px] tabular-nums">
                  {fmtAmount(refundPaid)} of {fmtAmount(refundOwed > 0.005 ? refundOwed : dealValue)} refunded
                  {refundLeft > 0.01 ? ` · ${fmtAmount(refundLeft)} still owed` : refundDone ? " · refund closed" : ""}
                </span>
              </div>
            </>
          )}
          {(refundState === "full-owed" || refundState === "part-owed") && (
            <>
              <div className="hsep" />
              <div className="flex items-center gap-3 px-5 py-3 text-warning-ink">
                <span className="text-[14px] font-medium">{refundState === "full-owed" ? "Refund owed" : "Partial refund owed"}</span>
                <span className="ml-auto text-[12.5px] tabular-nums">
                  {fmtAmount(refundLeft)} still owed{refundPaid > 0.005 ? ` · ${fmtAmount(refundPaid)} sent` : ""}
                </span>
              </div>
            </>
          )}
          {refundState === "part" && (
            <>
              <div className="hsep" />
              <div className="flex items-center gap-3 px-5 py-3 text-warning-ink">
                <span className="text-[14px] font-medium">Partially refunded</span>
                <span className="ml-auto text-[12.5px] tabular-nums">
                  {fmtAmount(refundPaid)} of {fmtAmount(dealValue)} returned
                  {refundLeft > 0.005 ? ` · ${fmtAmount(refundLeft)} still owed` : ""}
                </span>
              </div>
            </>
          )}

          {/* R-489: the invoice at a glance, first: what was sold, the total, whether the buyer has paid. */}
          {invItems.length > 0 && (
            <>
              <div className="hsep" />
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[14px] font-medium text-ink">Invoice <span className="tabular-nums">{invMeta?.number || flow.invoice_number}</span></span>
                  <StatusPill tone={invPill.tone}>{invPill.label}</StatusPill>
                  {invMeta && (invMeta.issued || invMeta.due) && (
                    <span className="text-[12.5px] text-muted">
                      {[invMeta.issued && `Issued ${dayShort(invMeta.issued)}`, invMeta.due && `due ${dayShort(invMeta.due)}`].filter(Boolean).join(", ")}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <button className="ui-btn ui-btn-sm" onClick={() => {
                        try { localStorage.setItem("invoices_open_id", flow.invoice_id); } catch { /* storage blocked: Invoices just opens */ }
                        window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
                      }}>
                      <ExternalLink size={14} /> Open invoice
                    </button>
                    {/* R-574: link this deal's invoice to a shoe delivery, the same card as the delivery's Sell tab. */}
                    <button className="ui-btn ui-btn-sm" onClick={() => { api.getInvoice(flow.invoice_id).then(setLinkInv).catch((e) => toast(String(e), "error")); }}>
                      <Link2 size={14} /> Link to a delivery
                    </button>
                  </span>
                </div>
                <table className="ui-table ui-table-sm mt-2">
                  <tbody>
                    {invItems.map((it, i) => (
                      <tr key={i}>
                        <td className="w-16 tabular-nums text-muted">{it.qty} ×</td>
                        <td className="text-ink">{it.description}</td>
                        <td className="r text-muted w-28" title="Charged per unit">{fmtAmount(it.rate)}</td>
                        <td className="r font-medium text-ink w-32">{fmtAmount(it.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 pt-2.5 flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1 text-[13px]">
                  {!isComplete && (
                    <span className={pay.hasCost && pay.buyerIn ? "text-success-ink font-medium" : "text-warning-ink font-medium"} title={pay.title}>
                      {pay.buyerIn ? "Buyer paid" : pay.label}
                    </span>
                  )}
                  {invMeta && invMeta.tax > 0.005 && <span className="text-muted">Tax <span className="tabular-nums text-ink-2">{fmtAmount(invMeta.tax)}</span></span>}
                  <span className="text-muted">Total <span className="tabular-nums font-medium text-ink">{fmtAmount(invMeta?.total ?? flow.invoice_total)}</span></span>
                </div>
              </div>
            </>
          )}

          {/* R-489: Schedule and Freight, one line that says where the deal stands until it is opened. */}
          <div className="hsep" />
          <div className="px-5">
            <button onClick={() => setShowSched((v) => !v)} aria-expanded={showSched}
              className="w-full flex items-center gap-2 h-11 text-left">
              <ChevronRight size={14} className={`text-muted flex-shrink-0 transition-transform duration-200 ${showSched ? "rotate-90" : ""}`} />
              <span className="text-[14px] font-medium text-ink flex-shrink-0">Schedule and freight</span>
              <span className="text-[12.5px] text-muted truncate min-w-0">
                {flow.ships_direct ? "Ships direct"
                  : [flow.pickup_date && `Pickup ${dayShort(flow.pickup_date)}`,
                     flow.expected_delivery_date && `delivery ${dayShort(flow.expected_delivery_date)}`].filter(Boolean).join(", ") || "No dates set"}
              </span>
            </button>
          </div>
          {showSched && <>
            <ShippingStrip flow={flow} onReload={onReload} locked={locked} />
            <FreightPanel dealFlowId={flow.id} locked={locked} onReload={onReload} />
          </>}

          {/* Supplier invoices: R-513, the PDFs for the deal's supplier paperwork */}
          <div className="hsep" />
          <SupplierInvoices flow={flow} locked={locked} onReload={onReload} />

          {/* The steps: always visible, click any step */}
          <div className="hsep" />
          <SectionNav current={section} done={done} flash={flash} onGo={go}
            refundLabel={refundState === null ? "Refund" : `Refund · ${fmtAmount(refundPaid > 0.005 ? refundPaid : refundLeft)}`}
            refundTone={refundState === "full" ? "danger" : refundState === null ? "quiet" : "warning"} />

          {/* Completed banner + edit toggle */}
          {isComplete && (
            <div className="mx-5 mb-2 flex items-center justify-between gap-2">
              <div className="text-[12.5px] text-success-ink font-medium">
                Completed{flow.completed_at ? ` ${parseLocalDay(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}, every section stays editable
              </div>
              <button onClick={() => setEditMode((v) => !v)} className={`ui-btn ui-btn-sm ${editMode ? "ui-btn-ink" : ""}`}>
                {editMode ? "Done editing" : "Edit"}
              </button>
            </div>
          )}

          {/* Active section body */}
          <div className="px-5 py-4">
            <div key={animKey} className="df-anim">
              {section === "supplier" && <SectionSupplier flow={flow} onReload={onReload} onAdvance={() => advance("supplier")} locked={locked} />}
              {section === "link"     && <SectionLink     flow={flow} onReload={onReload} onAdvance={() => advance("link")} />}
              {section === "shipping" && <DealShipping flow={flow} onReload={onReload} locked={locked} dealPaid={pay.buyerIn} onAdvance={() => advance("shipping")} />}
              {section === "profit"   && <SectionProfit   flow={flow} onReload={onReload} onAdvance={() => advance("profit")} />}
              {section === "complete" && <PanelComplete   flow={flow} onReload={onReload} />}
              {section === "refund"   && <SectionRefund   flow={flow} onReload={onReload} />}
            </div>

            {/* Row actions */}
            <div className="hsep mt-5" />
            <div className="flex justify-end gap-1.5 pt-3">
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm("Mark this deal as fallen through? It drops from the pipeline and its invoice is voided. You can restore it from the Archive.")) return;
                  try { await api.setDealFlowFellThrough(flow.id, true); toast("Deal marked as fell through"); onReload(); }
                  catch (err: any) { toast(String(err), "error"); }
                }}
                className="ui-btn ui-btn-sm !border-transparent text-muted hover:text-warning-ink"
              >
                <XCircle size={14} /> Mark deal fell through
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm("Move to Archive? You can restore it anytime.")) return;
                  try { await api.deleteDealFlow(flow.id); toast("Moved to Archive"); onReload(); }
                  catch (err: any) { toast(String(err), "error"); }
                }}
                className="ui-btn ui-btn-sm !border-transparent text-muted hover:text-danger-ink"
              >
                <Trash2 size={14} /> Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Schedule chip (R-154) ──
// On the COLLAPSED row, always. An empty date has to be a question you can see
// without opening anything, or it never gets answered and the gate below it is
// enforcing nothing.
function ShipChip({ flow }: { flow: DealFlow }) {
  const s = shipState(flow);
  const pick = day(flow.pickup_date), del = day(flow.expected_delivery_date);
  const moved = [
    day(flow.pickup_date_prev) && `pickup moved from ${dayLabel(day(flow.pickup_date_prev))}`,
    day(flow.expected_delivery_date_prev) && `delivery moved from ${dayLabel(day(flow.expected_delivery_date_prev))}`,
  ].filter(Boolean).join(" · ");

  if (s.kind === "direct") return (
    <StatusPill tone="neutral"
      title={`Ships direct, no pickup, so completion is not held for a date.${moved ? ` (${moved})` : ""}`}>
      Ships direct
    </StatusPill>
  );
  if (s.kind === "unset") return (
    <StatusPill tone="warning"
      title="No pickup date, no expected delivery, and no ships-direct answer: this deal has no schedule">
      No date set
    </StatusPill>
  );

  const label = s.kind === "overdue"
    ? `${s.basis === "delivery" ? "Delivery" : "Pickup"} was ${dayLabel(s.date)}`
    : [pick && `Picks up ${dayLabel(pick)}`, del && `lands ${dayLabel(del)}`].filter(Boolean).join(" · ");
  const detail = [pick && `pickup ${dayLabel(pick)}`, del && `expected delivery ${dayLabel(del)}`].filter(Boolean).join(" · ");

  return (
    <StatusPill
      tone={s.kind === "overdue" ? "danger" : "shipping"}
      title={s.kind === "overdue"
        ? `${detail}. That date has passed and the deal is not complete.${moved ? ` (${moved})` : ""}`
        : `${detail}. Completion is held until ${dayLabel(s.date)}.${moved ? ` (${moved})` : ""}`}
    >
      {label}
    </StatusPill>
  );
}

// ── Schedule editor (R-154) ──
function ShippingStrip({ flow, onReload, locked }: { flow: DealFlow; onReload: () => void; locked: boolean }) {
  const [pickup,   setPickup]   = useState(day(flow.pickup_date));
  const [delivery, setDelivery] = useState(day(flow.expected_delivery_date));
  const [direct,   setDirect]   = useState(!!flow.ships_direct);
  const [saving,   setSaving]   = useState(false);

  // Re-seed when the deal reloads underneath — a save here, or another device.
  useEffect(() => {
    setPickup(day(flow.pickup_date));
    setDelivery(day(flow.expected_delivery_date));
    setDirect(!!flow.ships_direct);
  }, [flow.pickup_date, flow.expected_delivery_date, flow.ships_direct]);

  const dirty = pickup !== day(flow.pickup_date)
    || delivery !== day(flow.expected_delivery_date)
    || direct !== !!flow.ships_direct;
  const s    = shipState(flow);
  const gate = shipGate(flow);
  const prevPick = day(flow.pickup_date_prev), prevDel = day(flow.expected_delivery_date_prev);

  const save = async () => {
    setSaving(true);
    try {
      await api.setDealFlowShipping(flow.id, pickup || null, delivery || null, direct);
      toast("Schedule saved");
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  const reset = () => {
    setPickup(day(flow.pickup_date));
    setDelivery(day(flow.expected_delivery_date));
    setDirect(!!flow.ships_direct);
  };

  const lbl = "block text-[12px] text-muted font-medium mb-1";
  return (
    <div className="px-5 py-4 df-anim">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[14px] font-medium text-ink">Schedule</span>
        {s.kind === "unset" && (
          <span className="text-[12px] text-warning-ink">
            Not answered yet: set a date, or say it ships direct
          </span>
        )}
      </div>

      <div className="flex items-end gap-3 flex-wrap mt-2.5">
        <div className="w-40">
          <label className={lbl}>Pickup date</label>
          <input type="date" className={inp} value={pickup} disabled={locked}
            onChange={(e) => setPickup(e.target.value)} />
        </div>
        <div className="w-40">
          <label className={lbl}>Expected delivery</label>
          <input type="date" className={inp} value={delivery} disabled={locked}
            onChange={(e) => setDelivery(e.target.value)} />
        </div>
        <button type="button" onClick={() => setDirect((v) => !v)} disabled={locked}
          title="The explicit 'there is no pickup' answer. A deal that ships direct is never held for a date."
          className={`ui-btn ${direct ? "ui-btn-ink" : ""}`}>
          {direct ? <Check size={14} /> : <Package size={14} />} No pickup, ships direct
        </button>
        {dirty && !locked && (
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={saving} className="ui-btn ui-btn-ink">Save</button>
            <button onClick={reset} className="ui-btn !border-transparent text-muted">Cancel</button>
          </div>
        )}
      </div>

      {(prevPick || prevDel) && (
        <div className="text-[12px] text-muted mt-2">
          {[prevPick && `Pickup moved from ${dayLabel(prevPick)}`,
            prevDel && `delivery moved from ${dayLabel(prevDel)}`].filter(Boolean).join(" · ")}
        </div>
      )}
      {gate && (
        <div className="text-[12px] text-muted mt-1.5">
          Completing this deal is held until {dayLabel(gate.date)}: its {basisWord(gate.basis)} date. You can override it in Review &amp; complete, with a reason.
        </div>
      )}
      {s.kind === "direct" && (
        <div className="text-[12px] text-muted mt-1.5">Ships direct. Completion is not held for a date.</div>
      )}
    </div>
  );
}

// ── Section switcher ──
function SectionNav({ current, done, flash, onGo, refundLabel, refundTone }: {
  current: SectionKey; done: Record<typeof SECTIONS[number]["key"], boolean>;
  flash: SectionKey | null; onGo: (k: SectionKey) => void;
  refundLabel: string; refundTone: "quiet" | "warning" | "danger";
}) {
  return (
    <StepBar steps={SECTIONS} current={current} done={done} flash={flash} onGo={onGo}>
      {/* Refunds are a step of the deal, not a view that replaces it (R-305): the money
          in, the linked transactions and the profit all stay one click away. Set apart
          from the numbered four because a deal is not meant to end here. */}
      <div className="vsep h-6 mx-2 flex-shrink-0" />
      <button
        onClick={() => onGo("refund")}
        className={`flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium flex-shrink-0 transition-colors duration-150 ${
          current === "refund" ? "bg-surface-3 text-ink"
          : refundTone === "danger" ? "text-danger-ink hover:bg-surface-3"
          : refundTone === "warning" ? "text-warning-ink hover:bg-surface-3"
          : "text-muted hover:text-ink hover:bg-surface-3"}`}
      >
        <RotateCcw size={14} /> <span className="whitespace-nowrap">{refundLabel}</span>
      </button>
    </StepBar>
  );
}

// ─── The refund step ──────────────────────────────────────────────────────
function SectionRefund({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  // R-438: closing the refund lives inside the workspace, at the foot of the step, on every
  // screen that shows it. It used to be a header button here, above the step and missing
  // from the Invoices and Supplier pages.
  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">Refund</div>
      </div>
      <RefundWorkspace dealFlowId={flow.id} primary onChange={onReload} />
    </div>
  );
}

// ─── Section 1: Supplier & cost ───────────────────────────────────────────
function SectionSupplier({ flow, onReload, onAdvance, locked }: { flow: DealFlow; onReload: () => void; onAdvance: () => void; locked: boolean }) {
  const [suppName,    setSuppName]    = useState("");
  const [suppResults, setSuppResults] = useState<Supplier[]>([]);
  const [selSupplier, setSelSupplier] = useState<Supplier | null>(null);
  const [items, setItems] = useState<{ description: string; qty: number; clientRate: number; myRate: string }[]>([]);
  // R-315 (completed 2026-09-16): a cost entered HERE could only ever be supplier
  // goods — the switch existed on the invoice's cost section and nowhere else, so the
  // one screen Jack asked for it on could not mark a shipping line as his own money.
  const [costType, setCostType] = useState("supplier");
  const [supplierBilled, setSupplierBilled] = useState(false);
  const [ownAmount, setOwnAmount] = useState("");
  // R-324: a partner who brought the buyer is paid a share of the spread over the cost
  // he was SHOWN, which need not be the cost actually paid. The four inputs are typed
  // here and travel with the line, so the amount and the basis behind it stay together.
  const [splitUnits, setSplitUnits] = useState("");
  const [splitSale,  setSplitSale]  = useState("");
  const [splitBasis, setSplitBasis] = useState("");
  const [splitPct,   setSplitPct]   = useState("50");
  const isPartner = costType === "partner";
  const isOwnKind = costType !== "supplier";
  // Open on the form when there is nothing recorded yet — that is the whole reason
  // this section is on screen. Once a cost line exists it collapses to one button,
  // so a settled deal is not sitting under an empty form (R-205).
  const [showForm, setShowForm] = useState((flow.supplier_payments || []).length === 0);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    api.getInvoice(flow.invoice_id).then((inv) => {
      try {
        const li: any[] = JSON.parse(inv.line_items_json || "[]");
        // R-401: only the items. A shipping line is money the customer was charged for the
        // truck, never a cost the supplier is paid, and a line with no description names
        // nothing to buy. Shipping is the logistics booking's business.
        setItems(li.filter((it) => !isShippingLine(it.description))
          .map((it) => ({ description: it.description, qty: it.qty, clientRate: it.rate, myRate: "" })));
      } catch {}
    }).catch(() => {});
  }, [flow.invoice_id]);

  useEffect(() => {
    if (!suppName || selSupplier?.name === suppName) { setSuppResults([]); return; }
    const t = setTimeout(() => api.searchSuppliers(suppName).then(setSuppResults).catch(() => setSuppResults([])), 250);
    return () => clearTimeout(t);
  }, [suppName, selSupplier?.name]);

  const existingPayments = flow.supplier_payments || [];
  // R-324: the same arithmetic the backend re-runs on save (`PartnerSplit::cut`), so the
  // figure read here is the figure stored. Floored at 0 — a sale below the cost he was
  // shown does not make the partner owe money back.
  const splitU    = parseAmount(splitUnits);
  const splitS    = parseAmount(splitSale);
  const splitB    = parseAmount(splitBasis);
  const splitP    = parseAmount(splitPct);
  const splitCut  = Math.max(0, splitU * (splitS - splitB) * splitP / 100);
  const splitReady = splitU > 0 && splitS > 0 && splitP > 0;
  const splitPctLabel = splitPct + "% of " + fmtAmount(Math.max(0, splitS - splitB))
    + " a unit on " + splitU.toLocaleString() + " units";
  const anyRateEntered   = items.some((it) => parseAmount(it.myRate) > 0);
  const suppTotal        = items.reduce((s, it) => s + it.qty * parseAmount(it.myRate), 0);
  // Something typed and not yet saved — what Continue has to deal with.
  const formDirty        = showForm && (suppName.trim() !== "" || ownAmount.trim() !== ""
                                        || (isPartner && splitReady) || items.some((it) => it.myRate.trim() !== ""));
  // A kept leg was never paid, so it is not a cost — same rule as
  // `total_supplier_cost`, and now visible here because the kept toggle lives on
  // these rows (R-132).
  // R-400/R-401: freight is the shipping leg. Typed freight lines are listed and edited in
  // the Shipping section, so they are left out of this list and this total.
  const goodsLines       = existingPayments.filter((p) => p.category !== "freight");
  const totalCost        = goodsLines.filter((p) => !p.kept).reduce((s, p) => s + p.amount, 0);
  // The header's own-cost figures come from the lines shown here: typed freight is on the Shipping step.
  const ownCosts         = goodsLines.filter((p) => !p.kept && !owedToSupplier(p));
  const ownCostsTotal    = ownCosts.reduce((s, p) => s + p.amount, 0);
  const ownCostsUnpaid   = ownCosts.filter((p) => !p.paid).reduce((s, p) => s + p.amount, 0);

  const pickSupplier = (s: Supplier) => { setSelSupplier(s); setSuppName(s.name); setSuppResults([]); };

  /** Returns false when nothing was saved, so Continue can stay put instead of
   *  advancing away from work that is still sitting in the form. */
  const handleAddSupplier = async (): Promise<boolean> => {
    if (!suppName.trim()) return false;
    // A freight/wire/other line is one amount paid to one payee — the itemized grid
    // (our cost vs the client quote per line) describes goods and says nothing here.
    // R-324: a partner line's amount is never typed — it is derived from the split, here
    // and again on the backend, so the cut and the basis printed beside it agree.
    if (isPartner) {
      if (!splitReady) { toast("Add the units, the sale price and their share", "error"); return false; }
      setSaving(true);
      try {
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
          amount: splitCut, category: "partner", supplier_billed: false,
          split: { units: splitU, sale_unit_price: splitS, basis_unit_cost: splitB, share_pct: splitP },
        });
        setSuppName(""); setSelSupplier(null); setSuppResults([]);
        setSplitUnits(""); setSplitSale(""); setSplitBasis(""); setSplitPct("50");
        setCostType("supplier"); setSupplierBilled(false); setShowForm(false);
        if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
        onReload();
      } catch (e: any) { toast(String(e), "error"); setSaving(false); return false; }
      setSaving(false);
      return true;
    }
    if (isOwnKind) {
      const amt = parseAmount(ownAmount);
      if (amt <= 0) { toast("Add the amount for this cost", "error"); return false; }
      setSaving(true);
      try {
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
          amount: amt, quantity: 1, unit_price: amt,
          method: selSupplier?.payment_method || null,
          category: costType, supplier_billed: supplierBilled,
        });
        setSuppName(""); setSelSupplier(null); setSuppResults([]); setOwnAmount("");
        setCostType("supplier"); setSupplierBilled(false); setShowForm(false);
        if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
        onReload();
      } catch (e: any) { toast(String(e), "error"); setSaving(false); return false; }
      setSaving(false);
      return true;
    }
    const filledItems = items.filter((it) => parseAmount(it.myRate) > 0);
    const zeroCost = filledItems.length === 0;
    if (zeroCost && !confirm("Submit $0 as the supplier cost for this deal? Your profit will equal the full revenue. Are you sure?")) return false;
    setSaving(true);
    try {
      if (zeroCost) {
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
          amount: 0, quantity: items.reduce((s, it) => s + it.qty, 0) || 1, unit_price: 0,
          method: selSupplier?.payment_method || null,
        });
      } else {
        for (const it of filledItems) {
          const rate = parseAmount(it.myRate);
          await api.addSupplierPayment(flow.id, {
            supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
            amount: it.qty * rate, quantity: it.qty, unit_price: rate,
            method: selSupplier?.payment_method || null,
          });
        }
      }
      setSuppName(""); setSelSupplier(null); setSuppResults([]);
      setItems((prev) => prev.map((it) => ({ ...it, myRate: "" })));
      setShowForm(false);
      // Keep completed-deal numbers correct after a manual cost edit.
      if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
      onReload();
    } catch (e: any) { toast(String(e), "error"); setSaving(false); return false; }
    setSaving(false);
    return true;
  };

  // Typed-in work is not lost by moving on: Continue saves the form first, and stays
  // put if that save does not go through (R-205). Nothing typed, nothing to save.
  const handleContinue = async () => {
    if (formDirty) {
      if (!suppName.trim()) { toast("Add the supplier's name, or clear the amounts, before continuing", "error"); return; }
      if (!(await handleAddSupplier())) return;
    }
    onAdvance();
  };

  const removePayment = async (pid: string) => {
    const line = (flow.supplier_payments || []).find((x) => x.id === pid);
    if (line && isBuyLine(line) && !confirm(removeLineAsk(line))) return;
    try {
      await api.removeSupplierPayment(flow.id, pid);
      if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
  };

  // "Didn't pay — kept it": drop this supplier's amount from the deal's cost.
  const toggleKept = async (pid: string, kept: boolean) => {
    setSaving(true);
    try { await api.setSupplierPaymentKept(flow.id, pid, kept); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  // One cost line. There is no "mark paid" here (R-401): a supplier is paid outside the deal.
  const renderLine = (p: SupplierPayment) => (
      <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-line rounded-lg">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1.5">
            {p.supplier_name}
            {p.category && p.category !== "supplier" && (
              <StatusPill tone="accent">{catLabel(p.category)}</StatusPill>
            )}
          </div>
          {p.split ? (
            <div className="text-[12px] text-muted tabular-nums">
              {p.split.share_pct}% of {fmtAmount(Math.max(0, p.split.sale_unit_price - p.split.basis_unit_cost))} a unit
              on {p.split.units.toLocaleString()} units, split taken on {fmtAmount(p.split.basis_unit_cost)}
            </div>
          ) : p.quantity != null && p.unit_price != null ? (
            <div className="text-[12px] text-muted tabular-nums">{p.quantity} × {fmtAmount(p.unit_price)}</div>
          ) : null}
          {p.notes && <ResoldNote note={p.notes} />}
          {p.paid && <div className="text-[10.5px] text-success-ink font-medium">Paid</div>}
          {p.kept && <div className="text-[10.5px] text-accent font-medium">Kept: didn't pay, not counted as a cost</div>}
          {!locked && !isResoldLine(p) && (
            <div className="flex items-center gap-2.5 mt-0.5">
              {!p.paid && (
                <button onClick={() => toggleKept(p.id, !p.kept)} disabled={saving}
                  className="text-[10.5px] text-muted hover:text-ink-2 disabled:opacity-40">
                  {p.kept ? "Undo (I did pay this)" : "Didn't pay, keep it"}
                </button>
              )}
            </div>
          )}
        </div>
        <div className={`text-[13px] font-medium tabular-nums ${p.kept ? "text-muted line-through" : "text-ink"}`}>{fmtAmount(p.amount)}</div>
        {!locked && !isResoldLine(p) && (
          <button onClick={() => removePayment(p.id)} className="text-faint hover:text-danger-ink transition-colors duration-150"><X size={13} /></button>
        )}
      </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-medium text-ink">Supplier &amp; cost</div>
        {/* R-315: the two figures side by side, so a glance never confuses a cost
            Jack pays himself with money actually owed to the supplier. */}
        {existingPayments.length > 0 && (
          <div className="flex items-center gap-5 mt-2.5">
            <div>
              <div className="text-[12px] text-muted">Owed to supplier</div>
              <div className="text-[15px] font-medium text-ink tabular-nums">{fmtAmount(flow.supplier_owed)}</div>
            </div>
            {ownCostsTotal > 0.005 && (
              <div>
                <div className="text-[12px] text-muted">Your own costs</div>
                <div className="text-[13px] font-medium text-ink-2 tabular-nums">{fmtAmount(ownCostsUnpaid)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Existing cost lines */}
      {goodsLines.length > 0 && (
        <div className="space-y-1.5">
          {goodsLines.map(renderLine)}
          <div className="flex justify-end gap-2 text-[12px] text-muted pr-1">
            <span>Total cost</span>
            <span className="font-medium text-ink tabular-nums w-24 text-right">{fmtAmount(totalCost)}</span>
          </div>
        </div>
      )}

      {locked ? null : (
      <>
      {/* Add another — the form is already open when the deal has no cost yet */}
      {!showForm && (
        <button onClick={() => setShowForm(true)}
          className="ui-btn ui-btn-sm">
          <Plus size={14} /> Add supplier
        </button>
      )}

      {/* Supplier form */}
      {showForm && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div>
            <div className="text-[14px] font-medium text-ink">{isOwnKind ? "Cost on this deal" : "Supplier cost"}</div>
            <div className="text-[12px] text-muted mt-0.5">
              {isOwnKind ? "A cost you are paying for this deal, not the goods" : "Itemized: your cost vs the client quote per line"}
            </div>
          </div>
          {/* R-315: what kind of cost this is, before anything else — the answer
              decides whether the money is owed to the supplier at all. */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-muted">What is this cost?</label>
            <select value={costType} onChange={(e) => {
              const next = e.target.value;
              setCostType(next); setSupplierBilled(false);
              // Pre-fill the split from the invoice so the common case is two fields, not
              // four. Both stay editable — the units on a partner deal are not always the
              // whole invoice, and the price he was shown is never on it.
              if (next === "partner" && !splitUnits && !splitSale) {
                const units = items.reduce((t, it) => t + it.qty, 0);
                if (units > 0) {
                  setSplitUnits(String(units));
                  if (flow.invoice_total > 0) setSplitSale((flow.invoice_total / units).toFixed(2));
                }
              }
            }} className={inp}>
              <option value="supplier">Supplier goods</option>
              <option value="partner">Partner split</option>
              <option value="freight">Freight and shipping</option>
              <option value="wire_out">Outgoing wire fee</option>
              <option value="wire_in">Incoming wire fee</option>
              <option value="other">Other cost</option>
            </select>
          </div>
          {isOwnKind && !isPartner && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-muted">Billed by the supplier</span>
              <Switch on={supplierBilled} onToggle={() => setSupplierBilled((v) => !v)} label="Billed by the supplier" />
            </div>
          )}
          {isOwnKind && <label className="text-[12px] font-medium text-muted block">{isPartner ? "Partner" : "Paid to"}</label>}
          <div className="relative">
            <input type="text" placeholder={isPartner ? "Who you are splitting with" : isOwnKind ? "Who this went to" : "Search supplier name..."} value={suppName}
              onChange={(e) => { setSuppName(e.target.value); setSelSupplier(null); }} className={inp} />
            {suppResults.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.08)] max-h-40 overflow-y-auto">
                {suppResults.map((s) => (
                  <button key={s.id} onClick={() => pickSupplier(s)} className="w-full text-left px-4 py-2.5 hover:bg-surface-2 transition-colors duration-150 first:rounded-t-xl last:rounded-b-xl">
                    <div className="text-[13px] font-medium text-ink">{s.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {s.contact_name && <span className="text-[12px] text-muted">{s.contact_name}</span>}
                      {s.payment_method && <span className="text-[12px] text-muted">· {s.payment_method}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {selSupplier && (
            <div className="text-[12px] text-muted bg-surface-3 rounded-lg px-3 py-2 space-y-0.5">
              {selSupplier.contact_name && <div className="font-medium text-ink">{selSupplier.contact_name}</div>}
              {(selSupplier.payment_method || selSupplier.payment_details) && (
                <div>{selSupplier.payment_method}{selSupplier.payment_details ? ` · ${selSupplier.payment_details}` : ""}</div>
              )}
            </div>
          )}
          {isPartner ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted">Units</label>
                  <input className={inp} placeholder="0" inputMode="decimal" value={splitUnits}
                    onChange={(e) => setSplitUnits(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted">Sale price per unit</label>
                  <input className={inp} placeholder="0.00" inputMode="decimal" value={splitSale}
                    onChange={(e) => setSplitSale(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted">Cost they were shown</label>
                  <input className={inp} placeholder="0.00" inputMode="decimal" value={splitBasis}
                    onChange={(e) => setSplitBasis(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-muted">Their share</label>
                  <div className="relative">
                    <input className={inp + " pr-7"} placeholder="50" inputMode="decimal" value={splitPct}
                      onChange={(e) => setSplitPct(e.target.value)} />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[12px] pointer-events-none">%</span>
                  </div>
                </div>
              </div>
              <div className="rounded-lg bg-surface-2 ring-1 ring-line-2 px-3 py-2.5 space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-muted">Their cut</span>
                  <span className="text-[14px] font-medium text-ink tabular-nums">{fmtAmount(splitCut)}</span>
                </div>
                <div className="text-[12px] text-muted tabular-nums">
                  {splitReady
                    ? splitPctLabel
                    : "Fill in the units, the sale price and their share"}
                </div>
                {splitReady && splitB > 0 && (
                  <div className="text-[12px] text-muted">
                    The split is taken on {fmtAmount(splitB)} a unit, not on what you actually pay.
                    Anything you buy it under stays with you on top of your half.
                  </div>
                )}
              </div>
              <div className="text-[12px] text-muted">
                Your own cost. It lowers this deal&rsquo;s profit but never appears in what you owe the supplier.
              </div>
            </div>
          ) : isOwnKind ? (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-muted">Amount</label>
              <input className={inp} placeholder="0.00" inputMode="decimal" value={ownAmount}
                onChange={(e) => setOwnAmount(e.target.value)} />
              <div className="text-[12px] text-muted">
                {supplierBilled
                  ? "The supplier billed you for this, so it counts as money owed to them."
                  : "Your own cost. It lowers this deal's profit but never appears in what you owe the supplier."}
              </div>
            </div>
          ) : items.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[12.5px] font-medium text-muted">Item costs</div>
              <div className="rounded-lg border border-line overflow-hidden">
                <div className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-1.5 bg-surface-2 text-[12.5px] font-medium text-muted">
                  <span>Item</span><span className="text-center">Qty</span><span className="text-right">Our quote</span><span className="text-right">My rate</span><span className="text-right">My total</span>
                </div>
                {items.map((item, i) => {
                  const myRate = parseAmount(item.myRate);
                  const myTotal = item.qty * myRate;
                  const clientTotal = item.qty * item.clientRate;
                  const saving_pct = clientTotal > 0 && myTotal > 0 ? ((clientTotal - myTotal) / clientTotal) * 100 : null;
                  return (
                    <div key={i} className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-2 border-t border-line-2 items-center">
                      <span className="text-[12px] text-ink-2 truncate" title={item.description}>{item.description}</span>
                      <span className="text-[12px] text-muted text-center tabular-nums">{item.qty}</span>
                      <span className="text-[12px] text-muted text-right tabular-nums">{fmtAmount(item.clientRate)}</span>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[12px] pointer-events-none">$</span>
                        <input type="text" inputMode="decimal" placeholder="0.00" value={item.myRate}
                          onChange={(e) => { const copy = [...items]; copy[i] = { ...copy[i], myRate: e.target.value }; setItems(copy); }}
                          className="w-full border border-line-3 bg-transparent pl-5 pr-1 h-8 rounded-md text-[12px] text-right focus:outline-none focus:border-ink transition-colors duration-150 tabular-nums" />
                      </div>
                      <div className="text-right">
                        <div className="text-[12px] font-medium text-ink tabular-nums">{myRate > 0 ? fmtAmount(myTotal) : "-"}</div>
                        {saving_pct !== null && myRate > 0 && (
                          <div className={`text-[11px] tabular-nums ${saving_pct >= 20 ? "text-success-ink" : saving_pct >= 0 ? "text-warning-ink" : "text-danger-ink"}`}>{saving_pct.toFixed(0)}% margin</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {anyRateEntered && (
                  <div className="flex justify-between items-center px-3 py-2 border-t border-line bg-surface-2/60">
                    <span className="text-[12px] text-muted font-medium">Total supplier cost</span>
                    <span className="text-[12px] font-medium text-ink tabular-nums">{fmtAmount(suppTotal)}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[12.5px] font-medium text-muted">Amount</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input type="text" inputMode="decimal" placeholder="0.00" value={items[0]?.myRate ?? ""}
                  onChange={(e) => setItems([{ description: "Supplier cost", qty: 1, clientRate: flow.invoice_total, myRate: e.target.value }])}
                  className="w-full border border-line-3 bg-transparent pl-8 pr-3 h-9 rounded-lg text-[13px] focus:outline-none focus:border-ink transition-colors duration-150" />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={async () => { if (await handleAddSupplier()) onAdvance(); }} disabled={saving || !suppName.trim()}
              className="ui-btn ui-btn-ink">
              <Plus size={14} /> {isOwnKind ? "Add cost" : "Add supplier"}
            </button>
            <button onClick={() => { setShowForm(false); setSuppName(""); setSelSupplier(null); setSuppResults([]); setItems((prev) => prev.map((it) => ({ ...it, myRate: "" }))); }}
              className="ui-btn !border-transparent text-muted">Clear</button>
          </div>
        </div>
      )}
      </>
      )}

      {/* Advance */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[12px] text-muted">
          {existingPayments.length === 0 ? "No supplier cost yet. You can continue and record this as 100% profit"
            : "Cost recorded"}
        </span>
        <button onClick={handleContinue} disabled={saving}
          className="ui-btn ui-btn-ink">
          {formDirty ? "Save and continue" : "Continue to shipping"} <Check size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Section 2: Link financials ───────────────────────────────────────────
// The buyer's money is linked here like every other leg. The "Mark payment received"
// card and the bank-confirm card that sat above the links were removed (R-302): the
// linked transaction already says the money landed, and Review & complete records the
// payment on the deal and the invoice when the deal closes, from any open stage.
function SectionLink({ flow, onReload, onAdvance }: { flow: DealFlow; onReload: () => void; onAdvance: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-medium text-ink">Link financials</div>
      </div>

      <ReconciliationPanel flow={flow} onChange={onReload} />

      {/* R-555: a payment with nothing to link is marked "No payment recorded" with a note on its own line above. */}
      <DealNotes flow={flow} onReload={onReload} />

      <div className="flex items-center justify-end pt-1">
        <button onClick={onAdvance}
          className="ui-btn ui-btn-ink">
          Continue to profit <Check size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Deal notes — explain anything (e.g. why a leg has no bank record) ──
function DealNotes({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [val, setVal] = useState(flow.notes || "");
  const [saving, setSaving] = useState(false);
  const dirty = (flow.notes || "") !== val;
  const save = async () => {
    setSaving(true);
    try { await api.updateDealFlowNotes(flow.id, val.trim() || null); toast("Note saved"); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[12px] font-medium text-muted mb-1.5">Notes</div>
      <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={2}
        placeholder="Explain anything about this deal (e.g. why a payment has no bank record)"
        className="w-full border border-line-3 rounded-lg px-2.5 py-2 text-[12.5px] bg-transparent focus:outline-none focus:border-ink transition-colors duration-150 resize-y" />
      {dirty && (
        <div className="flex justify-end mt-1.5">
          <button onClick={save} disabled={saving}
            className="ui-btn ui-btn-ink ui-btn-sm">Save note</button>
        </div>
      )}
    </div>
  );
}

// ─── Section 4: Profit from financials ────────────────────────────────────
function SectionProfit({ flow, onReload, onAdvance }: { flow: DealFlow; onReload: () => void; onAdvance: () => void }) {
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id, flow.updated_at]);

  const p = recon?.pieces;
  const rd = recon?.record;
  // R-555 (Jack: "Linked money, always"): green is the profit from linked payments, what completion books. Beside it, faded,
  // what the deal comes to if every payment is made as entered.
  const actual = recon?.actual_profit ?? 0;
  const projected = recon?.projected_profit ?? recon?.expected_profit ?? (flow.invoice_total - projectedCostOf(flow));
  const differs = Math.abs(projected - actual) >= 0.5;
  const legs = recon?.legs;
  const keys: LegKey[] = ["buyer", "supplier", "shipping"];
  const open = legs ? keys.filter((k) => legs[k] && (legs[k].state === "missing" || legs[k].state === "part")) : [];
  const marked = legs ? keys.filter((k) => legs[k]?.state === "marked") : [];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-medium text-ink">Profit from financials</div>
      </div>

      <div className="grid grid-cols-[1fr_1px_1fr] gap-x-4">
        <div className="py-1">
          <div className="text-[12px] text-muted">Profit from linked payments</div>
          <div className={`ui-fig mt-0.5 ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
            {actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}
          </div>
          <div className="text-[12px] text-muted mt-0.5">What gets booked</div>
        </div>
        <div className="vsep" />
        <div className="py-1 opacity-70">
          <div className="text-[12px] text-faint">Projected</div>
          <div className="ui-fig mt-0.5 text-muted">{projected < 0 ? "−" : ""}{fmtAmount(Math.abs(projected))}</div>
          <div className="text-[12px] text-faint mt-0.5">{differs ? "If every payment is made as entered" : "The same: every payment is linked or marked"}</div>
        </div>
      </div>

      {open.length > 0 && legs && (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2.5 text-[12.5px] space-y-1">
          <div className="text-[12px] font-medium text-danger-ink">{open.length === 1 ? "A payment is not linked yet" : `${open.length} payments are not linked yet`}</div>
          {open.filter((k) => k === "shipping" && flow.shipping_mode).map((k) => (
            <div key={k} className={legs[k].state === "missing" ? "text-danger-ink" : "text-warning-ink"}>{legLine(k, legs[k])}</div>
          ))}
          {open.some((k) => !(k === "shipping" && flow.shipping_mode)) && (
            <OpenLegReasons flow={flow} legs={legs} keys={open.filter((k) => !(k === "shipping" && flow.shipping_mode))}
              onSaved={() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); onReload(); }} />
          )}
          {/* A Logistics carrier has its own question on completion (Mark done, or why no carrier is paid). */}
          {flow.shipping_mode && open.includes("shipping") && (
            <div className="text-[12px] text-ink-2 pt-0.5">The carrier counts once its payment is linked, from Pay carriers or Financials. Completing asks about it.</div>
          )}
        </div>
      )}
      {marked.length > 0 && legs && (
        <div className="text-[12px] text-muted space-y-0.5">
          {marked.map((k) => <div key={k}>{legLine(k, legs[k])}</div>)}
        </div>
      )}

      {rd && p && (
        <div className="text-[12.5px] space-y-1.5">
          <div className="text-[12px] font-medium text-muted mb-1">How the profit adds up</div>
          <Row label="Revenue" note={rd.buyer_linked ? "linked" : "nothing linked"} value={`+${fmtAmount(rd.gross)}`} clr="text-success-ink" />
          <Row label="Supplier and other costs" note={rd.supplier_linked ? (rd.supplier_part_linked ? "part linked" : "linked") : "nothing linked"} value={`−${fmtAmount(rd.goods)}`} clr="text-danger-ink" />
          {(rd.shipping > 0.005 || rd.shipping_linked) && <Row label="Shipping" note="linked" value={`−${fmtAmount(rd.shipping)}`} clr="text-danger-ink" />}
          {p.refund_total > 0.005 && <Row label="Refunds paid" value={`−${fmtAmount(p.refund_total)}`} clr="text-danger-ink" />}
          <div className="flex items-center justify-between pt-1.5 border-t border-line-2">
            <span className="font-medium text-ink">Profit</span>
            <span className={`font-medium tabular-nums ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <span className="text-[12px] text-muted">{open.length ? "Link or mark every payment to complete it" : recon?.fully_reconciled ? "Fully reconciled with the bank" : "Every payment is linked or marked"}</span>
        <button onClick={onAdvance}
          className="ui-btn ui-btn-ink">
          Review &amp; complete <Check size={14} />
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, clr, note }: { label: string; value: string; clr: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-2">{label}{note && <span className="text-muted">, {note}</span>}</span>
      <span className={`tabular-nums ${clr}`}>{value}</span>
    </div>
  );
}

// ─── Panel 4: Complete deal ───────────────────────────────────────────────
type ShippingHold = "idle" | "asking" | "shipping";

function PanelComplete({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [recipients, setRecipients] = useState<PayoutShare[]>([]);
  const [recon,      setRecon]      = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [shipHold,   setShipHold]   = useState<ShippingHold>("idle");
  const [carrier,      setCarrier]      = useState("");
  const [tracking,     setTracking]     = useState("");
  // R-154 gate. Blocked until the goods land; the escape hatch is deliberate,
  // because a gate with no override just teaches people to type a fake date —
  // and a fake date destroys the data the gate was protecting.
  const gate = shipGate(flow);
  const [overrideOn,     setOverrideOn]     = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const overrideReady = overrideReason.trim().length > 0;
  const gateBlocks    = !!gate && !(overrideOn && overrideReady);
  // R-509: a load whose carrier is not paid yet. Complete becomes "Mark done" (it completes by itself once the carrier
  // payment is linked) unless no carrier is paid, which needs a reason like the date override.
  const carrierDue = (flow.logistics_unpaid ?? 0) > 0;
  const held = carrierHold(flow);
  const [noCarrier, setNoCarrier] = useState(false);
  const [carrierWhy, setCarrierWhy] = useState("");
  const holdMode = carrierDue && !noCarrier;
  const carrierBlocks = carrierDue && noCarrier && carrierWhy.trim().length === 0;
  // R-533: the loads the gate holds the deal for (an older backend sends only load_numbers).
  const dueLoads = Array.isArray(flow.carrier_due_loads) ? flow.carrier_due_loads : (flow.load_numbers || "").trim().split(/\s+/).filter(Boolean);
  const dueText = dueLoads.length ? `${dueLoads.join(", ")} ${dueLoads.length > 1 ? "are" : "is"}` : "A load on this deal is";
  const todayStr = localDay();
  const [completedDate, setCompletedDate] = useState(todayStr);
  const [payoutIncluded, setPayoutIncluded] = useState(true);
  const [moneyLinked, setMoneyLinked] = useState(false);
  // R-401: the logistics pay is taken off the top before the owner split, like a rep's cut.
  const logiPay = useDealLogisticsPay(flow.id, [flow.updated_at, flow.logistics_paid, flow.logistics_quoted, flow.shipping_linked]);

  useEffect(() => { api.getPayoutSplit().then(setRecipients).catch(() => {}); }, []);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id, flow.stage]);
  // Default the completion date to when the BUYER's payment actually landed (bank
  // date of the last buyer leg), falling back to the recorded payment date — a deal
  // closed on the day the money came in, so backdated / backlogged deals land right.
  useEffect(() => {
    if (flow.stage === "complete") return;
    api.dealAllocations(flow.id).then((allocs) => {
      const paid = allocs.filter((a) => a.role === "buyer_payment" && a.posted_at).map((a) => a.posted_at as string).sort();
      if (paid.length) setCompletedDate(paid[paid.length - 1].slice(0, 10));
      else if (flow.payment_received_at) setCompletedDate(flow.payment_received_at.slice(0, 10));
    }).catch(() => {});
  }, [flow.id, flow.stage]);

  // Any open stage (R-302). With the "Mark payment received" button gone, a deal can sit
  // at `invoiced` until it closes; `complete_deal_flow` records the buyer payment itself.
  const canComplete = flow.stage === "invoiced" || flow.stage === "payment_received" || flow.stage === "supplier_paid";
  const isComplete  = flow.stage === "complete";

  // What gets recorded. A completed deal shows its permanent recorded figures (captured at
  // completion, survive even if statements are lost). R-553: an open deal previews exactly what
  // completion records, worked out by the backend leg by leg: a leg's linked payments once they
  // are linked (the supplier's once they cover the typed cost), what it is expected to cost until
  // then, so an unpaid carrier or a supplier paid only a deposit no longer reads as profit. Until
  // the reconciliation loads (or on an older backend) the projection stands in.
  const pc = recon?.pieces;
  const rd = recon?.record;
  const waiveCarrier = carrierDue && noCarrier;
  const recRev  = isComplete ? flow.gross_revenue : rd ? rd.gross : flow.invoice_total;
  // R-400: the cost is two legs, and shipping sits outside the goods figure exactly as completion records it.
  const recShip = isComplete ? (flow.shipping_cost ?? 0)
    : rd ? (waiveCarrier ? rd.shipping_known : rd.shipping)
    : shippingEstimateOf(flow);
  const recGoods = isComplete ? flow.total_cost - recShip
    : rd ? rd.goods
    : projectedCostOf(flow) - shippingEstimateOf(flow);
  const recCost = recGoods + recShip;
  const recNet  = isComplete ? flow.net_profit    : recRev - recCost;
  // R-555: only linked money is recorded, and every payment is linked or marked before the deal completes. The carrier of a
  // deal on Logistics keeps its own question below (Mark done, or why no carrier is paid).
  const open = isComplete ? [] : openLegs(recon?.legs, !!flow.shipping_mode);
  const basis = isComplete || open.length === 0 ? "from bank" : "open";
  const revFromBank = !!rd?.buyer_linked;
  const costBasis = !rd ? "linked" : rd.supplier_linked || rd.goods <= 0.005 ? "linked" : "nothing linked";
  const refundTotal = pc?.refund_total ?? 0;
  // R-438: shown after refunds, as every other screen counts them (R-436). The stored figures
  // stay before refunds; the refund comes off once, here, on display.
  const showRev = recRev - refundTotal;
  const showNet = recNet - refundTotal;
  // The owners' split after refunds. The split stored at completion was taken on the profit
  // before the refund, so a refunded deal splits its profit after refunds over the deal's own
  // stored shares (the org's current split only when it has none): what the logistics person
  // earns comes off the top, then the deal's recipients and payout choice.
  // The phone does the same (www/app.js dfPlSummaryHTML), so the two cannot show different splits.

  // Fail-proof record: transactions snapshotted onto the deal at completion.
  let snapshot: any[] = [];
  let overrides: any[] = [];
  try {
    const m = JSON.parse((flow as any).metadata || "{}");
    if (Array.isArray(m.bank_snapshot)) snapshot = m.bank_snapshot;
    // Every time the gate was overridden on this deal, kept across reopens.
    if (Array.isArray(m.gate_overrides)) overrides = m.gate_overrides;
  } catch {}

  // R-496: the money chime the moment this computer completes a deal; the server's notice for it is not raised again here.
  const chimeCompleted = (id: string) => {
    let st: Storage | null = null;
    try { st = window.localStorage; } catch { /* storage blocked: the pop-up may chime once more later */ }
    noteChimedDeal(st, id);
    api.playMoneyChime().catch(() => {});
  };

  // Only sent when the gate is actually blocking — an override recorded on a deal
  // that was never held would be a lie in the audit trail.
  const reasonArg = () => (gate && overrideOn ? overrideReason.trim() : null);
  const carrierArg = () => (carrierDue && noCarrier ? carrierWhy.trim() : null);

  // R-509: marked done. The hold rides the deal's sync to the server, which completes it when the carrier is paid.
  const runHold = async () => {
    setSaving(true);
    try {
      const r = await api.holdDealForCarrier(flow.id, completedDate || null, payoutIncluded, reasonArg());
      toast(r.message);
      api.netsyncSyncNow().catch(() => {});
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const runComplete = async () => {
    setSaving(true);
    try {
      const result = await api.completeDealFlow(flow.id, "none", completedDate || null, payoutIncluded, reasonArg(), carrierArg());
      if (result.is_loss && result.warning) toast(result.warning, "error");
      chimeCompleted(flow.id);
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleCompleteClick = () => {
    // The confirm that used to sit on "Mark payment received".
    if ((flow.supplier_payments || []).length === 0
      && !confirm("No supplier cost on this deal. It will be recorded as 100% profit. Complete it anyway?")) return;
    if (recNet < 0) {
      const ok = confirm(`Warning: This deal is at a loss.\n\nRevenue: ${fmtAmount(recRev)}\nCosts: ${fmtAmount(recCost)}\nLoss: ${fmtAmount(recNet)}\n\nMark complete anyway?`);
      if (!ok) return;
    }
    if (holdMode) { runHold(); return; }
    setShipHold("asking");
  };

  const handleCompleteNow = () => { setShipHold("idle"); runComplete(); };

  const handleShippingComplete = async () => {
    setSaving(true);
    try {
      // Carrier and tracking only. The deal's pickup / delivery dates live on
      // `deal_flows` since R-154 and are edited on the card — writing them here
      // too would leave two copies to disagree. `invoices.pickup_date` /
      // `delivery_date` still exist and keep whatever they already hold, and so do
      // the shipping charge and any carrier / tracking left blank here: an omitted
      // field is left alone by the save.
      //
      // The invoice is NOT flagged complete here. This used to send `is_complete:
      // true` before completing, so a refusal from the completion gate left the
      // invoice flagged complete on an open deal. `completeDealFlow` flags it itself
      // once it has succeeded.
      if (carrier || tracking) {
        await api.saveInvoiceShipping(flow.invoice_id, {
          carrier: carrier || undefined, tracking_number: tracking || undefined, is_complete: false,
        });
      }
      await api.completeDealFlow(flow.id, "none", completedDate || null, payoutIncluded, reasonArg(), carrierArg());
      chimeCompleted(flow.id);
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleUndo = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const split = !isComplete ? []
    : refundTotal > 0.005 ? (showNet - logiPay.amount > 0.005 ? allocateDealPayout(showNet - logiPay.amount, dealPayoutIncluded(flow), dealPayoutRecipients(flow) ?? recipients) : [])
    : recNet > 0 ? dealPayoutSplit(flow, recipients) : [];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-medium text-ink">Review &amp; complete</div>
        <div className="text-[12px] text-muted mt-0.5">
          {isComplete
            ? "Recorded from the linked bank transactions, saved with the deal so it never disappears."
            : "Only linked payments are recorded. Every payment is linked, added by hand, or marked No payment recorded before the deal completes."}
        </div>
      </div>

      {/* What gets recorded */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12.5px] font-medium text-ink-2">{isComplete ? "Recorded profit" : "What gets recorded"}</span>
          {basis === "from bank"
            ? <span className="text-[12px] font-medium text-success-ink">From bank{recon?.fully_reconciled ? " · fully reconciled" : ""}</span>
            : <span className="text-[12px] font-medium text-danger-ink">{open.length === 1 ? "A payment is open" : `${open.length} payments are open`}</span>}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <RecCell label="Revenue" value={fmtAmount(showRev)} sub={refundTotal > 0.005 ? `after ${fmtAmount(refundTotal)} refunded` : isComplete ? undefined : (revFromBank ? "linked" : "nothing linked")} />
          <RecCell label="Cost"    value={fmtAmount(recCost)} sub={isComplete ? undefined : costBasis} />
          <RecCell label={showNet >= 0 ? "Profit" : "Loss"} value={fmtAmount(showNet)} sub={`${showRev > 0 ? ((showNet / showRev) * 100).toFixed(1) : "0.0"}% margin`} clr={showNet >= 0 ? "text-success-ink" : "text-danger-ink"} big />
        </div>
        <div className="mt-3 space-y-1 text-[12px]">
          <Row label="Supplier and other costs" value={fmtAmount(recGoods)} clr="text-ink-2" />
          <Row label="Shipping" value={fmtAmount(recShip)} clr="text-ink-2" />
        </div>
        {open.length > 0 && recon?.legs && (
          <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2.5 text-[12px]">
            <OpenLegReasons flow={flow} legs={recon.legs} keys={open}
              onSaved={() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); onReload(); }} />
          </div>
        )}
        {!isComplete && carrierDue && !waiveCarrier && (
          <div className="mt-2.5 flex items-start gap-1.5 text-[12px] text-warning-ink">
            <span>The carrier is not paid yet, so shipping counts nothing until its payment is linked.</span>
          </div>
        )}
        {!isComplete && recon?.projected_profit !== undefined && Math.abs(recon.projected_profit - showNet) >= 0.5 && (
          <div className="mt-2.5 text-[12px] text-faint">
            Projected if every payment is made as entered: {recon.projected_profit < 0 ? "−" : ""}{fmtAmount(Math.abs(recon.projected_profit))}
          </div>
        )}
        {refundTotal > 0.005 && (
          <div className="mt-2.5 text-[12px] text-muted">
            Revenue and profit are after {fmtAmount(refundTotal)} refunded to the buyer, the same figures every report uses.
          </div>
        )}
        {/* A deal marked received before R-302 carries the amount typed then. There is no
            button to change it any more, but a linked buyer payment always wins. */}
        {!isComplete && !revFromBank && flow.stage !== "invoiced" && flow.payment_received_amount > 0.005
          && Math.abs(flow.payment_received_amount - flow.invoice_total) > 0.005 && (
          <div className="mt-2.5 text-[12px] text-muted">
            Revenue is the {fmtAmount(flow.payment_received_amount)} recorded as received, not the invoice total of {fmtAmount(flow.invoice_total)}.
            If that is wrong, link the buyer's payment in Link financials, or add it by hand there. A linked payment is what gets recorded.
          </div>
        )}
      </div>

      {/* Snapshot of linked transactions — the fail-proof record */}
      {snapshot.length > 0 && (
        <div>
          <div className="hsep mb-3" />
          <div className="text-[12px] font-medium text-muted mb-1.5">Linked transactions saved with this deal</div>
          <div className="space-y-1">
            {snapshot.map((s: any, i: number) => {
              const clickable = !!s.txn_id;
              const openInFinancials = () => {
                if (!clickable) return;
                // Hand the target transaction to Financials, then switch to it.
                // FinancialsView reads this on mount and opens the txn's detail.
                (window as any).__pendingBankTxn = s.txn_id;
                window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }));
              };
              return (
                <div
                  key={i}
                  onClick={openInFinancials}
                  title={clickable ? "View this transaction in Financials" : undefined}
                  className={`flex items-center gap-2 text-[12px] ${clickable ? "cursor-pointer hover:bg-surface-2 -mx-1.5 px-1.5 py-0.5 rounded-md transition-colors duration-150" : ""}`}
                >
                  <span className="text-ink-2 flex-1 truncate">
                    {roleLabel(s.role)} · {s.counterparty || "-"}
                    {s.posted_at ? ` · ${new Date(s.posted_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                  </span>
                  <span className={`tabular-nums font-medium ${s.direction === "out" ? "text-danger-ink" : "text-success-ink"}`}>
                    {s.direction === "out" ? "−" : ""}{fmtAmount(s.amount)}
                  </span>
                  {clickable && <ChevronRight size={13} className="text-muted shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Who overrode the date gate, when, and why — the record that makes the
          escape hatch safe to have. */}
      {overrides.length > 0 && (
        <div className="rounded-lg border border-warning bg-warning-bg/50 px-3 py-2.5">
          <div className="text-[12px] font-medium text-warning-ink mb-1.5">
            {overrides.some((o: any) => o.basis === "carrier" || o.basis === "payments") ? "Completed with an override" : `Completed before its ${overrides.length === 1 ? "date" : "dates"}`}
          </div>
          <div className="space-y-1">
            {overrides.map((o: any, i: number) => (
              <div key={i} className="text-[12px] text-ink-2">
                <span className="font-medium">{o.by || "Unknown"}</span>
                {o.at ? ` · ${new Date(o.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
                {o.basis === "carrier" ? " · no carrier paid" : o.basis === "payments" ? " · no payment recorded" : ""}
                {o.blocked_until ? ` · held until ${dayLabel(o.blocked_until)}` : ""}
                {o.reason ? ` · ${o.reason}` : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* R-577: who gets paid what, from the server's ledger: the reps on the deal, a projection
          before it completes, and any line typed over. Where the server cannot answer (offline, or
          not an admin) the profit split as this computer works it out. */}
      <DealPayoutsBox dealFlowId={flow.id} refreshKey={`${flow.updated_at}|${flow.stage}|${refundTotal}`} fallback={
        (split.length > 0 || logiPay.amount > 0.005 || logiPay.pending) ? (
          <div>
            <div className="text-[12px] font-medium text-muted mb-2">Profit split</div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <LogisticsPayCell pay={logiPay} />
              {split.map((it, i) => (
                <div key={i}>
                  <div className="text-[12px] text-muted">{it.name}</div>
                  <div className="text-[13px] font-medium text-success-ink tabular-nums">{fmtAmount(it.amount)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null
      } />

      {/* ── Complete action area ── */}
      {canComplete && shipHold === "idle" && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-muted whitespace-nowrap">Completed date</label>
            <input type="date" value={completedDate} max={todayStr} onChange={(e) => setCompletedDate(e.target.value)}
              className="flex-1 border border-line-3 px-2.5 h-8 rounded-lg text-[12px] bg-transparent focus:outline-none focus:border-ink transition-colors duration-150" />
          </div>
          <div className="py-1 space-y-1">
            <div className="text-[12px] text-muted">Where does this deal's profit go?</div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPayoutIncluded(true)} aria-pressed={payoutIncluded}
                className={`ui-opt flex-1 ${payoutIncluded ? "on" : ""}`}>Apply profit split</button>
              <button type="button" onClick={() => setPayoutIncluded(false)} aria-pressed={!payoutIncluded}
                className={`ui-opt flex-1 ${!payoutIncluded ? "on" : ""}`}>Business keeps 100%</button>
            </div>
          </div>
          {gate && (
            <div className="rounded-lg border border-warning bg-warning-bg px-3 py-2.5 space-y-2">
              <div className="flex items-start gap-2 text-[12.5px] text-warning-ink">
                <span>
                  Held until {dayLabel(gate.date)}: this deal's {basisWord(gate.basis)} date has not arrived yet.
                </span>
              </div>
              {!overrideOn ? (
                <button type="button" onClick={() => setOverrideOn(true)}
                  className="ui-btn ui-btn-sm text-warning-ink">
                  Complete it anyway
                </button>
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-[12px] font-medium text-warning-ink">Why is this being completed early?</label>
                  <input className={inp} value={overrideReason} autoFocus
                    placeholder="Picked up early, date was keyed wrong..."
                    onChange={(e) => setOverrideReason(e.target.value)} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-warning-ink">Saved on the deal with your name and the time.</span>
                    <button type="button" onClick={() => { setOverrideOn(false); setOverrideReason(""); }}
                      className="text-[12px] text-muted hover:text-ink-2 px-2 h-7 rounded-lg hover:bg-surface-3 transition-colors duration-150">
                      Cancel override
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {carrierDue && (
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 space-y-2">
              <div className="flex items-start gap-2 text-[12.5px] text-ink-2">
                <span>
                  {held
                    ? "Marked done. It completes by itself when the carrier payment is linked."
                    : `${dueText} not paid in full yet. Mark the deal done and it completes by itself once the payment is linked. If the carrier took less, change the rate.`}
                </span>
              </div>
              {!noCarrier ? (
                <button type="button" onClick={() => setNoCarrier(true)}
                  className="ui-btn ui-btn-sm">
                  No carrier to pay
                </button>
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-[12px] font-medium text-ink-2">Why is no carrier paid?</label>
                  <input className={inp} value={carrierWhy} autoFocus placeholder="The buyer sent their own truck"
                    onChange={(e) => setCarrierWhy(e.target.value)} />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-muted">Saved on the deal with your name and the time.</span>
                    <button type="button" onClick={() => { setNoCarrier(false); setCarrierWhy(""); }}
                      className="text-[12px] text-muted hover:text-ink-2 px-2 h-7 rounded-lg hover:bg-surface-3 transition-colors duration-150">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={() => setMoneyLinked((v) => !v)}
            aria-pressed={moneyLinked}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors duration-150 ${moneyLinked ? "border-success bg-success-bg" : "border-line-3 hover:bg-surface-2"}`}>
            <span className="w-4 flex-shrink-0">{moneyLinked && <Check size={16} className="text-success-ink" />}</span>
            <span className={`text-[12.5px] leading-snug ${moneyLinked ? "text-success-ink font-medium" : "text-ink-2"}`}>
              {holdMode ? "Everything but the carrier payment is linked to this deal" : "This is all the money that will ever be linked to this deal"}
            </span>
          </button>
          <button onClick={handleCompleteClick} disabled={saving || open.length > 0 || !moneyLinked || gateBlocks || carrierBlocks || (holdMode && held)}
            title={open.length > 0 ? "Link the rest, or save a reason for each short payment above"
              : gateBlocks ? `Held until ${dayLabel(gate!.date)}, override above with a reason`
              : !moneyLinked ? "Confirm all money is linked first"
              : carrierBlocks ? "Say why no carrier is paid first" : undefined}
            className="ui-btn ui-btn-ink">
            {open.length > 0 ? "Complete deal: link the rest or save a reason above"
              : gateBlocks ? `Complete deal: held until ${dayLabel(gate!.date)}`
              : !moneyLinked ? "Complete deal: confirm money linked above"
              : holdMode ? (held ? "Marked done: waiting for the carrier payment" : "Mark done: completes when the carrier is paid")
              : `Complete deal: record ${fmtAmount(recNet)} profit`}
          </button>
        </div>
      )}

      {/* Step A: shipping question */}
      {canComplete && shipHold === "asking" && (
        <div className="bg-warning-bg border border-warning rounded-xl p-4 space-y-3">
          <div className="text-[14px] font-medium text-warning-ink">Does this deal require shipping?</div>
          <p className="text-[12px] text-warning-ink">If items are being shipped, hold here and track the shipment before closing out.</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setShipHold("shipping")} className="ui-btn ui-btn-ink">Yes, track shipping</button>
            <button onClick={handleCompleteNow} disabled={saving} className="ui-btn">No, complete now</button>
            <button onClick={() => setShipHold("idle")} className="ui-btn !border-transparent text-muted">Cancel</button>
          </div>
        </div>
      )}

      {/* Step B: shipping form */}
      {canComplete && shipHold === "shipping" && (
        <div className="bg-surface border border-warning rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">Shipping hold</span>
            <span className="ml-auto"><StatusPill tone="warning">Awaiting delivery</StatusPill></span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-[12px] text-muted font-medium mb-1">Carrier</label><input className={inp} placeholder="FedEx, UPS..." value={carrier} onChange={(e) => setCarrier(e.target.value)} /></div>
            <div><label className="block text-[12px] text-muted font-medium mb-1">Tracking #</label><input className={inp} placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} /></div>
          </div>
          {/* Pickup and expected delivery moved to Schedule at the top of this
              card (R-154) — one copy, synced, and it is what the gate reads. */}
          <div className="text-[12px] text-muted">
            Pickup and expected delivery are set under Schedule at the top of this card.
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleShippingComplete} disabled={saving || gateBlocks}
              title={gateBlocks ? `Held until ${dayLabel(gate!.date)}, override in the step before this` : undefined}
              className="ui-btn ui-btn-ink">Confirm delivery &amp; complete</button>
            <button onClick={() => setShipHold("idle")} className="ui-btn !border-transparent text-muted">Cancel</button>
          </div>
        </div>
      )}

      {/* Completed controls */}
      {isComplete && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button onClick={handleUndo} disabled={saving}
            className="ui-btn ui-btn-sm text-warning-ink">
            <RotateCcw size={14} /> Reopen deal
          </button>
          <button onClick={async () => { setSaving(true); try { const r = await api.recalcDealFromBank(flow.id); toast(r?.from_bank ? `Recalculated from bank: profit ${fmtAmount(r?.net_profit ?? 0)}` : "No bank transactions linked: kept recorded figures", "success"); onReload(); } catch (e: any) { toast(String(e), "error"); } setSaving(false); }}
            disabled={saving}
            className="ui-btn ui-btn-sm">
            <RefreshCw size={14} /> Recalculate from bank
          </button>
        </div>
      )}
    </div>
  );
}

const roleLabel = (r: string) =>
  r === "buyer_payment" ? "Payment in" : r === "supplier_payment" ? "Paid to supplier" :
  r === "fee" ? "Wire fee" : r === "shipping" ? "Paid to carrier" : r === "refund_out" ? "Refund out" : r === "refund_in" ? "Supplier refund" : r;

function RecCell({ label, value, sub, clr = "text-ink", big }: { label: string; value: string; sub?: string; clr?: string; big?: boolean }) {
  return (
    <div className="py-1">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`${big ? "text-[22px]" : "text-[18px]"} font-medium tabular-nums mt-0.5 tracking-tight ${clr}`}>{value}</div>
      {sub && <div className="text-[11px] text-faint mt-0.5">{sub}</div>}
    </div>
  );
}

