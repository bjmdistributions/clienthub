// R-464 and R-465: where a load is in Jack's flow, what has to be true before it goes to book, and the
// markup on the quote. Everything here takes values and returns values, so the rules are tested without a
// screen. The website carries the same rules in its own code, so a change here is a change there.
//
// The flow (eight stages for the team, six for logistics):
//   1 Quote, 2 Shipping charge (on the invoice, or we pay it ourselves), 3 Invoice sent, 4 Customer paid,
//   5 Booked, 6 Picked up, 7 Delivered, 8 Carrier paid.

import { roundCents } from "./logisticsPay";
import { statusRank } from "./logisticsLoad";

// ─── the tracker (stages) ─────────────────────────────────────────────────

export type StageState = "done" | "current" | "todo" | "skipped";
export type StageKey = "quote" | "charge" | "sent" | "paid" | "team" | "booked" | "pickup" | "delivery" | "carrier";
export interface Stage { key: StageKey; label: string; state: StageState; note: string }

/** The facts the tracker reads. Every one is optional because the local copy of a load does not carry the
 *  server-only ones (`invoice_sent`, `deal_paid`) and the screen that knows them passes them in. */
export interface ProgressFacts {
  status: string;
  quote_amount?: number | null;
  quote_invoiced_at?: string;
  shipping_charge?: string;
  invoice_sent?: boolean;
  deal_paid?: boolean;
  book_override_at?: string;
  book_override_by?: string;
  picked_up_at?: string;
  delivered_at?: string;
  paid_amount?: number | null;
}

const has = (v: string | null | undefined): boolean => !!(v ?? "").trim();

interface Row { key: StageKey; label: string; done: boolean; skipped: boolean; note: string }

/** Which stages are done and which a legacy load passed without. Keyed by the team's eight. */
function teamStages(b: ProgressFacts): { rows: Row[]; pastQuote: boolean; legacy: boolean } {
  const rank = statusRank(b.status);                       // cancelled is -1: nothing is "past" it
  const pastQuote = rank >= statusRank("requested");
  const overridden = has(b.book_override_at);
  const own = b.shipping_charge === "own";
  const done = {
    // A viewer without the dollar switch gets no quote amount, so a load that says Quoted counts as quoted.
    quote: b.quote_amount != null || rank >= statusRank("quoted"),
    charge: has(b.shipping_charge) || has(b.quote_invoiced_at),
    sent: !!b.invoice_sent,
    paid: !!b.deal_paid || overridden,
    booked: rank >= statusRank("booked"),
    pickup: has(b.picked_up_at) || rank >= statusRank("picked_up"),
    delivery: has(b.delivered_at) || rank >= statusRank("delivered"),
    carrier: b.paid_amount != null,
  };
  // A load already past quote with nothing on record for stages 1 to 4 is a load from before this flow:
  // those stages are muted, never missing work. A load that has some of it, or was booked early on purpose,
  // has the rest passed over the same way.
  const anyData = b.quote_amount != null || done.charge || done.sent || done.paid;
  const legacy = pastQuote && !anyData;
  const passed = (isDone: boolean) => pastQuote && !isDone;
  const by = (b.book_override_by ?? "").trim();
  const rows: Row[] = [
    { key: "quote", label: "Quote", done: done.quote && !legacy, skipped: legacy, note: "" },
    { key: "charge", label: own ? "We pay it" : "On the invoice", done: done.charge, skipped: passed(done.charge), note: "" },
    { key: "sent", label: "Invoice sent", done: done.sent, skipped: passed(done.sent), note: "" },
    { key: "paid", label: "Customer paid", done: done.paid, skipped: passed(done.paid), note: overridden ? (by ? `Override by ${by}` : "Override") : "" },
    { key: "booked", label: "Booked", done: done.booked, skipped: false, note: "" },
    { key: "pickup", label: "Picked up", done: done.pickup, skipped: false, note: "" },
    { key: "delivery", label: "Delivered", done: done.delivery, skipped: false, note: "" },
    { key: "carrier", label: "Carrier paid", done: done.carrier, skipped: false, note: "" },
  ];
  return { rows, pastQuote, legacy };
}

/** The stages of a load, each done, current, still to do, or skipped. The person who can see the deal gets
 *  eight; the logistics person gets six, with stages 2 to 4 folded into "With the team" (no money words). */
export function loadProgress(b: ProgressFacts, teamView: boolean): Stage[] {
  const { rows: all, pastQuote, legacy } = teamStages(b);
  let rows: Row[] = all;
  if (!teamView) {
    const live = all.slice(1, 4).filter((r) => !r.skipped);
    // The team's part is skipped on a load from before this flow, done once the team has sent it on (or every
    // part of it that applied is done), and otherwise still to do. What the logistics person cannot see
    // (the invoice, the payment) never counts against it.
    const done = !legacy && (pastQuote || (live.length > 0 && live.every((r) => r.done)));
    rows = [all[0], { key: "team", label: "With the team", done, skipped: legacy, note: "" }, ...all.slice(4)];
  }
  const current = rows.findIndex((r) => !r.done && !r.skipped);
  return rows.map((r, i): Stage => {
    const state: StageState = r.skipped ? "skipped" : r.done ? "done" : i === current ? "current" : "todo";
    const note = r.key === "booked" && state === "current" && b.status === "requested" ? "Waiting on logistics" : r.note;
    return { key: r.key, label: r.label, state, note };
  });
}

// ─── the sections under the tracker ───────────────────────────────────────

export type LoadSection = "quote" | "invoice" | "book" | "pickup" | "delivery" | "pay";

/** The tabs: Invoice is the team's. */
export function sectionsFor(teamView: boolean): { key: LoadSection; label: string }[] {
  return [
    { key: "quote", label: "Quote" },
    ...(teamView ? [{ key: "invoice" as LoadSection, label: "Invoice" }] : []),
    { key: "book", label: "Book" },
    { key: "pickup", label: "Pickup" },
    { key: "delivery", label: "Delivery" },
    { key: "pay", label: "Pay" },
  ];
}

/** The tab a stage opens: 1 Quote, 2 to 4 Invoice (the team) or Quote (logistics), 5 Book, 6 Pickup, 7 Delivery, 8 Pay. */
export function sectionOfStage(key: StageKey, teamView: boolean): LoadSection {
  switch (key) {
    case "quote": return "quote";
    case "charge": case "sent": case "paid": case "team": return teamView ? "invoice" : "quote";
    case "booked": return "book";
    case "pickup": return "pickup";
    case "delivery": return "delivery";
    default: return "pay";
  }
}

/** The tab a load opens on: the one the current stage belongs to, or Pay once everything is done. */
export function firstSection(stages: Stage[], teamView: boolean): LoadSection {
  const cur = stages.find((s) => s.state === "current");
  return cur ? sectionOfStage(cur.key, teamView) : "pay";
}

// ─── the booking gate ─────────────────────────────────────────────────────

export type GateKey = "quote" | "charge" | "sent" | "paid";

/** The server's sentences, in the server's order. The first one missing is what a refusal says. */
export const GATE_REASON: Record<GateKey, string> = {
  quote: "Logistics has not quoted this load yet.",
  charge: "Put the quote on the invoice, or mark that you are paying this shipping yourselves.",
  sent: "Send the invoice first.",
  paid: "The customer has not paid yet.",
};

/** What the Send to book button says while that part is missing. */
export const GATE_BUTTON: Record<GateKey, string> = {
  quote: "Waiting on the quote",
  charge: "Put it on the invoice first",
  sent: "Send the invoice first",
  paid: "Waiting for the customer to pay",
};

export const BOOK_ANYWAY = "Book anyway, the money is coming";
export const BOOK_ANYWAY_CONFIRM = "Send this load to book before the invoice is sent and paid?";

export interface Gate {
  ok: boolean;
  /** Everything missing, in order. */
  missing: GateKey[];
  /** The first thing missing, or null. */
  first: GateKey | null;
  /** The server's sentence for the first thing missing. */
  reason: string;
  /** What the button reads: "Send to book" when the gate passes, else the first thing missing. */
  button: string;
  /** Only the invoice being sent or the customer paying is missing, so the team may book anyway. */
  canOverride: boolean;
}

/** Whether a load may go to book: a quote, shipping decided, the invoice sent, the customer paid. The invoice
 *  being sent and the customer paying can be overridden when the team knows the money is coming. */
export function bookGate(b: ProgressFacts): Gate {
  const missing: GateKey[] = [];
  if (!(b.quote_amount != null || b.status === "quoted")) missing.push("quote");
  if (!(has(b.shipping_charge) || has(b.quote_invoiced_at))) missing.push("charge");
  if (!b.invoice_sent) missing.push("sent");
  if (!b.deal_paid) missing.push("paid");
  const first = missing[0] ?? null;
  return {
    ok: first === null, missing, first,
    reason: first ? GATE_REASON[first] : "",
    button: first ? GATE_BUTTON[first] : "Send to book",
    canOverride: missing.length > 0 && missing.every((k) => k === "sent" || k === "paid"),
  };
}

/** Whether a deal's invoice has gone out: its status says sent, overdue or paid, or it has a sent date. */
export function invoiceWasSent(inv: { status?: string | null; sent_at?: string | null } | null | undefined): boolean {
  if (!inv) return false;
  const s = (inv.status ?? "").trim().toLowerCase();
  return s === "sent" || s === "overdue" || s === "paid" || has(inv.sent_at);
}

/** The load as the tracker and the gate read it: the load's own facts, with what the screen knows about the
 *  deal laid over them (the local copy has neither the invoice nor the payment). */
export function withDealFacts<T extends ProgressFacts>(b: T, known: { invoiceSent?: boolean; dealPaid?: boolean }): T {
  return {
    ...b,
    invoice_sent: known.invoiceSent !== undefined ? known.invoiceSent : !!b.invoice_sent,
    deal_paid: known.dealPaid !== undefined ? known.dealPaid : !!b.deal_paid,
  };
}

// ─── the markup (R-465) ───────────────────────────────────────────────────

/** A percent typed in a box: null when fine, else the sentence to show. Empty is allowed (the default applies). */
export function markupProblem(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/[%,\s]/g, ""));
  if (!Number.isFinite(n)) return "The markup must be a number.";
  if (n < 0 || n > 100) return "The markup must be between 0 and 100.";
  return null;
}

/** The percent as a number, or null for an empty box. */
export function markupValue(raw: string): number | null {
  const t = raw.trim();
  return t ? Math.round(Number(t.replace(/[%,\s]/g, "")) * 100) / 100 : null;
}

/** What the server will work out from a carrier cost and a percent: the markup in dollars and the quote
 *  (cost plus markup), each to the cent. null while the cost is not a number. */
export function markupPreview(costRaw: string, pctRaw: string): { markup: number; quote: number } | null {
  const t = costRaw.trim();
  if (!t) return null;
  const cost = Number(t.replace(/[$,\s]/g, ""));
  const pct = markupValue(pctRaw) ?? 0;
  if (!Number.isFinite(cost) || cost < 0) return null;
  const markup = roundCents(cost * pct / 100);
  return { markup, quote: roundCents(cost + markup) };
}

/** The percent a quote box opens with: the one on the load, else the default, else nothing. */
export function markupStart(b: { markup_pct?: number | null; markup_default_pct?: number }): string {
  const v = b.markup_pct ?? b.markup_default_pct;
  return v == null ? "" : String(v);
}

/** Who may type the percent: the team always, the logistics person only when the owner allows it. */
export const markupEditable = (teamView: boolean, b: { markup_editable?: boolean }): boolean => teamView || !!b.markup_editable;

/** What the carrier really cost: the amount paid once there is one, else the carrier rate. null while neither is known. */
export function actualCost(b: { paid_amount?: number | null; quoted_cost?: number | null }): { amount: number; source: "paid" | "rate" } | null {
  if (b.paid_amount != null) return { amount: b.paid_amount, source: "paid" };
  if (b.quoted_cost != null) return { amount: b.quoted_cost, source: "rate" };
  return null;
}
