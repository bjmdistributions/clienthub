import { costNotEntered, LINKED, money, OWED, paymentFiguresOf } from "./dealPayments";

// R-486: Deal Flow says what each deal still needs. Pure functions over values, so the rule is tested without the
// screen. The website has the same rule in www/app.js (dfSectionOf, dfShippingLine, dfStillNeededLine), tested against
// the same case table (src/lib/dealSections.cases.json).
//
// Every active deal is in exactly one of six sections, checked in this order:
//   1. Ready to complete: shipping is done and nothing is missing;
//   2. Delivered, payment still missing: shipping is done and something is missing;
//   3. On the way: the least advanced live load is picked_up (or no load, pickup passed, delivery ahead);
//   4. Waiting on pickup: the least advanced live load is requested or booked (or no load, pickup ahead);
//   5. With Logistics: the least advanced live load is a quote asked or quoted;
//   6. Shipping not set up: none of the above.
//
// "Shipping is done" is the old "arrived" idea, matched to the Rust completion gate (`shipping_gate` in commands.rs, where
// today counts as passed): the carrier says it landed, every live load is delivered, the deal ships direct, or there is
// no live load and the expected delivery date (else the pickup date) is today or earlier.

export type DealSection = "ready" | "paymentMissing" | "onTheWay" | "waitingPickup" | "withLogistics" | "notSetUp";

/** The sections in the order they are shown. */
export const SECTIONS: { key: DealSection; title: string }[] = [
  { key: "ready", title: "Ready to complete" },
  { key: "paymentMissing", title: "Delivered, payment still missing" },
  { key: "onTheWay", title: "On the way" },
  { key: "waitingPickup", title: "Waiting on pickup" },
  { key: "withLogistics", title: "With Logistics" },
  { key: "notSetUp", title: "Shipping not set up" },
];

// ─── what the deal row says ───────────────────────────────────────────────

/** What the deal list says about a deal's dates and loads. The `logistics_*` fields describe the least advanced live
 *  load (the one `logistics_stage` names); older responses lack the ones added in R-486, so every one is optional. */
export interface DealShipFacts {
  ships_direct?: boolean;
  pickup_date?: string | null;
  expected_delivery_date?: string | null;
  logistics_stage?: string;
  logistics_live_count?: number;
  logistics_carrier?: string;
  logistics_pickup_day?: string;
  logistics_picked_up_day?: string;
  logistics_delivery_day?: string;
  logistics_delivered_day?: string;
  logistics_asked_day?: string;
  /** The quote amount, null until priced, and null for a viewer without deal numbers. */
  logistics_quote?: number | null;
}

/** What is still unpaid on a deal, as the screen needs it. `buyerLeft` and `supplierLeft` are dollars, and are null for
 *  a viewer who may not see deal numbers (the lines then say "buyer payment" without the amount). */
export interface PayFacts {
  buyerDue: boolean;
  supplierDue: boolean;
  costMissing: boolean;
  /** The supplier cost was entered and all of it kept ("Didn't pay, kept it"): nothing to pay, by choice. */
  supplierKept: boolean;
  buyerLeft: number | null;
  supplierLeft: number | null;
}

/** What the person looking and the day add to a deal row. */
export interface DealCtx {
  /** The deal is in today's delivered set (Priority1 says it landed). */
  delivered: boolean;
  /** Today as YYYY-MM-DD, local. */
  today: string;
  /** The viewer may see deal numbers (`deal_flow:view_numbers`, or an admin). */
  numbers: boolean;
  /** null when the deal's payment row has not arrived: the deal is never called ready on a guess. */
  pay: PayFacts | null;
}

/** The payment facts off a status row (`reconciliation_status_all`). The four booleans (`buyer_due`, `supplier_due`,
 *  `supplier_cost_missing`, `supplier_kept`) are not money and are never redacted, so they come first; an older row without
 *  them is read from the six R-479 figures. A buyer payment the deal's stage says was received (`markedPaid`) counts as paid
 *  even when no bank payment is linked to it, as the Payments view's quiet note does (`MARKED_PAID_NOTE`). Amounts need real
 *  figures, so they are there only for a viewer who may see numbers. null when the row says nothing. */
export function payFactsOf(row: Partial<Record<string, unknown>> | null | undefined, markedPaid: boolean, numbers: boolean): PayFacts | null {
  if (!row) return null;
  const figures = paymentFiguresOf(row);
  const flags = typeof row.buyer_due === "boolean" && typeof row.supplier_due === "boolean" && typeof row.supplier_cost_missing === "boolean"
    ? { buyer: row.buyer_due, supplier: row.supplier_due, cost: row.supplier_cost_missing }
    : figures ? { buyer: figures.buyer_left > OWED, supplier: figures.supplier_left > OWED, cost: costNotEntered(figures) } : null;
  if (!flags) return null;
  const seen = numbers ? figures : null;
  const buyerDue = flags.buyer && !markedPaid;
  return {
    buyerDue,
    supplierDue: flags.supplier,
    costMissing: flags.cost,
    supplierKept: !flags.supplier && !flags.cost
      && (typeof row.supplier_kept === "boolean" ? row.supplier_kept : !!seen && seen.cost_kept && seen.supplier_target <= LINKED && seen.supplier_paired <= LINKED),
    buyerLeft: seen && buyerDue ? seen.buyer_left : null,
    supplierLeft: seen && flags.supplier ? seen.supplier_left : null,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

const iso = (v?: string | null): string => (typeof v === "string" ? v.trim().slice(0, 10) : "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-07" as "Oct 7". */
export const dayText = (d: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d);
  return m && MONTHS[+m[1] - 1] ? `${MONTHS[+m[1] - 1]} ${+m[2]}` : d;
};

type LoadStage = "quote" | "quoted" | "requested" | "booked" | "picked_up" | "delivered";
const LOAD_STAGES: readonly string[] = ["quote", "quoted", "requested", "booked", "picked_up", "delivered"];
/** The least advanced live load's status, "" when the deal has none (or an older response does not say). */
const stageOf = (f: DealShipFacts): LoadStage | "" => (LOAD_STAGES.includes(f.logistics_stage || "") ? (f.logistics_stage as LoadStage) : "");
/** How many live loads (not cancelled, not archived, a quote included). An older response has no count: one when it
 *  names a stage. */
const liveCount = (f: DealShipFacts): number =>
  Number.isFinite(f.logistics_live_count) ? (f.logistics_live_count as number) : stageOf(f) ? 1 : 0;

const missingAny = (p: PayFacts | null): boolean => !p || p.buyerDue || p.supplierDue || p.costMissing;

/** The deal has several live loads and the least advanced is not delivered. The delivered set (`ctx.delivered`) is filled
 *  when ANY booking has landed, so it cannot say the whole deal has: the deal is described by the load still to go. */
const loadBehind = (f: DealShipFacts): boolean => {
  const stage = stageOf(f);
  return !!stage && stage !== "delivered" && liveCount(f) > 1;
};

/** Shipping is done: see the header. */
function shippingDone(f: DealShipFacts, ctx: Pick<DealCtx, "delivered" | "today">): boolean {
  if (f.ships_direct) return true;
  if (ctx.delivered && !loadBehind(f)) return true;
  const stage = stageOf(f);
  if (stage === "delivered") return true;
  if (stage) return false;
  const gate = iso(f.expected_delivery_date) || iso(f.pickup_date);
  return !!gate && gate <= ctx.today;
}

/** The section a deal is in. */
export function sectionOf(f: DealShipFacts, ctx: Pick<DealCtx, "delivered" | "today" | "pay">): DealSection {
  if (shippingDone(f, ctx)) return missingAny(ctx.pay) ? "paymentMissing" : "ready";
  switch (stageOf(f)) {
    case "picked_up": return "onTheWay";
    case "requested": case "booked": return "waitingPickup";
    case "quote": case "quoted": return "withLogistics";
  }
  // No live load: the deal's own dates. Shipping is not done, so the gate date is ahead.
  const pick = iso(f.pickup_date), del = iso(f.expected_delivery_date);
  if (!pick && !del) return "notSetUp";
  return pick && pick < ctx.today ? "onTheWay" : "waitingPickup";
}

/** What orders a section: the next thing due to happen, an ISO day, "" when there is none. A live load that is booked
 *  or on the road goes by its own date, so a late one sorts to the top; a deal without one goes by the earliest of its
 *  dates still ahead, else its last (every date has passed: overdue). A deal that ships direct has nothing to wait for. */
export function nextDay(f: DealShipFacts, today: string): string {
  if (f.ships_direct) return "";
  const stage = stageOf(f);
  const own = stage === "requested" || stage === "booked" ? iso(f.logistics_pickup_day) : stage === "picked_up" ? iso(f.logistics_delivery_day) : "";
  if (own) return own;
  const ds = [iso(f.pickup_date), iso(f.expected_delivery_date)].filter(Boolean).sort();
  return ds.find((d) => d >= today) ?? ds[ds.length - 1] ?? "";
}

// ─── the two lines ────────────────────────────────────────────────────────

export type LineTone = "ink" | "muted" | "success" | "danger";
export interface LinePart { text: string; tone: LineTone }
/** One plain line under a deal: `text` is the sentence, `parts` are its pieces in order (the part that says a date has
 *  passed is in the danger tone) and `tone` is the line's own tone: danger once any part is. */
export interface Line { text: string; tone: LineTone; parts: LinePart[] }

/** A sentence: `head`, then `late` (a date that has passed, in the danger tone), then `tail`. */
function line(head: string, late = "", tail = ""): Line {
  const parts: LinePart[] = [];
  if (head) parts.push({ text: late ? `${head}, ` : head, tone: "muted" });
  if (late) parts.push({ text: late, tone: "danger" });
  if (tail) parts.push({ text: tail, tone: "muted" });
  return { text: parts.map((p) => p.text).join(""), tone: late ? "danger" : "muted", parts };
}

/** `head`, then ", pickup Oct 13" when the date is ahead, or "pickup was due Oct 6" in the danger tone when it passed. */
function withDay(head: string, noun: "pickup" | "delivery", day: string, today: string, tail: string): Line {
  if (!day) return line(head, "", tail);
  if (day < today) return line(head, `${noun} was due ${dayText(day)}`, tail);
  return line(`${head}, ${noun} ${noun === "delivery" ? "due " : ""}${dayText(day)}`, "", tail);
}

/** The deal's own dates, for a deal with no live load. */
function datesLine(f: DealShipFacts, today: string): Line {
  const pick = iso(f.pickup_date), del = iso(f.expected_delivery_date);
  if (!pick && !del) return line("No shipping set up");
  if (del) {
    if (del <= today) return del < today ? line("", `Delivery was due ${dayText(del)}`) : line(`Delivery due ${dayText(del)}`);
    if (pick && pick < today) return line(`Picked up ${dayText(pick)}, delivery due ${dayText(del)}`);
    return line(pick ? `Pickup ${dayText(pick)}` : `Delivery due ${dayText(del)}`);
  }
  return line(pick < today ? `Picked up ${dayText(pick)}` : `Pickup ${dayText(pick)}`);
}

/** Where the deal's shipping stands, specific, built from the least advanced live load. */
export function shippingLine(f: DealShipFacts, ctx: Pick<DealCtx, "delivered" | "today" | "numbers">): Line {
  const stage = stageOf(f);
  const n = liveCount(f);
  const tail = n > 1 ? ` (1 of ${n} loads)` : "";
  if (stage === "delivered") {
    const d = iso(f.logistics_delivered_day);
    return line(d ? `Delivered ${dayText(d)}` : "Delivered", "", tail);
  }
  if (ctx.delivered && !loadBehind(f)) return line("Delivered", "", tail);
  if (f.ships_direct) return line("Ships direct");
  switch (stage) {
    case "quote": {
      const d = iso(f.logistics_asked_day);
      return line(`${d ? `Quote asked ${dayText(d)}` : "Quote asked"}, not booked yet`, "", tail);
    }
    case "quoted": {
      const q = f.logistics_quote;
      return line(`Quoted${ctx.numbers && typeof q === "number" && q > 0.005 ? ` ${money(q)}` : ""}, not booked yet`, "", tail);
    }
    case "requested": return withDay("Sent to book", "pickup", iso(f.logistics_pickup_day), ctx.today, tail);
    case "booked": {
      const carrier = (f.logistics_carrier || "").trim();
      return withDay(carrier ? `Booked with ${carrier}` : "Booked", "pickup", iso(f.logistics_pickup_day), ctx.today, tail);
    }
    case "picked_up": {
      const d = iso(f.logistics_picked_up_day);
      return withDay(d ? `Picked up ${dayText(d)}` : "Picked up", "delivery", iso(f.logistics_delivery_day), ctx.today, tail);
    }
  }
  return datesLine(f, ctx.today);
}

/** The date the completion gate (`shipping_gate` in commands.rs) holds this deal for, or null. The gate reads only the deal's
 *  own expected delivery date (else its pickup date), never its loads, and never holds a deal that ships direct. A deal in
 *  Ready to complete by its load can still be held by a date somebody typed. */
function gateHold(f: DealShipFacts, today: string): { date: string; basis: "delivery" | "pickup" } | null {
  if (f.ships_direct) return null;
  const del = iso(f.expected_delivery_date), pick = iso(f.pickup_date);
  const date = del || pick;
  return date && date > today ? { date, basis: del ? "delivery" : "pickup" } : null;
}

/** What the deal still needs: payments and the cost, in that order, then shipping when it is not set up. */
export function stillNeededLine(f: DealShipFacts, ctx: DealCtx): Line | null {
  const section = sectionOf(f, ctx);
  const one = (text: string, tone: LineTone): Line => ({ text, tone, parts: [{ text, tone }] });
  if (section === "ready") {
    const hold = gateHold(f, ctx.today);
    return hold
      ? one(`Everything is in. Completing needs an override, ${hold.basis} is dated ${dayText(hold.date)}.`, "ink")
      : one("Everything is in. Open it and press Complete.", "success");
  }
  const pay = ctx.pay;
  const need: string[] = [];
  if (pay?.buyerDue) need.push(pay.buyerLeft !== null ? `buyer payment ${money(pay.buyerLeft)}` : "buyer payment");
  if (pay?.supplierDue) need.push(pay.supplierLeft !== null ? `supplier payment ${money(pay.supplierLeft)}` : "supplier payment");
  if (pay?.costMissing) need.push("supplier cost");
  if (section === "notSetUp") need.push("shipping");
  if (need.length > 0) return one(`Still needed: ${need.join(", ")}`, "ink");
  if (!pay) return section === "paymentMissing" ? one("Payment status not available", "muted") : null;
  return one(`Buyer paid. ${pay.supplierKept ? "Supplier kept, nothing to pay." : "Supplier paid."}`, "muted");
}

/** Everything a card needs about one deal. */
export interface DealDescription { section: DealSection; shipping: Line; needed: Line | null }
export function describeDeal(f: DealShipFacts, ctx: DealCtx): DealDescription {
  return { section: sectionOf(f, ctx), shipping: shippingLine(f, ctx), needed: stillNeededLine(f, ctx) };
}
