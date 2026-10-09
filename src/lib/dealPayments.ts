import { fmtAmount } from "./format";
import { can, isAdmin, type Perms } from "./permissions";

// R-479: the Payments view on Deal Flow. Which active deals have been paid, which are part paid, and what
// payment is still needed, read from the bank links only. Everything here takes values and returns values;
// the figures come from `reconciliation_status_all` (six keys per deal: target, paired and left for the buyer
// and for the supplier). The website has the same rule in www/app.js, tested against the same cases.

/** A deal is "owed" on a leg when more than a cent is still unlinked, and "linked" once more than a cent is. */
export const OWED = 0.005;
export const LINKED = 0.01;

/** What the group rule reads from one deal's status row. */
export interface PaymentFigures {
  no_buyer_link: boolean;
  no_supplier_link: boolean;
  supplier_paid_paired: boolean;
  buyer_target: number; buyer_paired: number; buyer_left: number;
  supplier_target: number; supplier_paired: number; supplier_left: number;
  /** A supplier goods line on the deal is marked "Didn't pay, kept it". Kept lines never count as cost, so the
   *  target is 0 for a deal whose lines are all kept: this says the cost was entered and settled. */
  cost_kept: boolean;
}

const KEYS = ["buyer_target", "buyer_paired", "buyer_left", "supplier_target", "supplier_paired", "supplier_left"] as const;

/** The figures off a status row, or null when the row is missing or does not carry all six (an older answer):
 *  such a deal is left out of the groups rather than guessed at, since a missing `left` would read as nothing owed. */
export function paymentFiguresOf(r: Partial<Record<string, unknown>> | null | undefined): PaymentFigures | null {
  if (!r) return null;
  for (const k of KEYS) if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number)) return null;
  return {
    no_buyer_link: !!r.no_buyer_link,
    no_supplier_link: !!r.no_supplier_link,
    supplier_paid_paired: !!r.supplier_paid_paired,
    cost_kept: !!r.cost_kept,
    buyer_target: r.buyer_target as number, buyer_paired: r.buyer_paired as number, buyer_left: r.buyer_left as number,
    supplier_target: r.supplier_target as number, supplier_paired: r.supplier_paired as number, supplier_left: r.supplier_left as number,
  };
}

export type PaymentGroup = "none" | "buyer" | "supplier" | "linked";

/** The groups in the order they are shown. */
export const PAYMENT_GROUPS: { key: PaymentGroup; title: string }[] = [
  { key: "none", title: "No payments yet" },
  { key: "buyer", title: "Waiting on the buyer" },
  { key: "supplier", title: "Supplier to pay" },
  { key: "linked", title: "All linked" },
];

/** The supplier cost has not been entered: nothing is expected on that leg, and nothing was linked, kept or marked
 *  as having no bank record. The deal cannot be called settled until the cost is in. A cost that was entered and then
 *  kept is in. */
export const costNotEntered = (r: PaymentFigures): boolean =>
  !r.no_supplier_link && !r.supplier_paid_paired && !r.cost_kept && r.supplier_target <= LINKED;

/** Which group a deal belongs to. First match wins, so a deal is in exactly one:
 *   1. nothing owed on either leg and the cost is in: All linked;
 *   2. no buyer or supplier money linked at all: No payments yet (a lone wire fee or shipping link does not count);
 *   3. the buyer still owes: Waiting on the buyer;
 *   4. otherwise the supplier is the open leg (including a buyer who has paid with no cost entered): Supplier to pay. */
export function paymentGroupOf(r: PaymentFigures): PaymentGroup {
  const owesBuyer = r.buyer_left > OWED;
  const owesSupplier = r.supplier_left > OWED;
  if (!owesBuyer && !owesSupplier && !costNotEntered(r)) return "linked";
  if (!(r.buyer_paired > LINKED || r.supplier_paired > LINKED)) return "none";
  if (owesBuyer) return "buyer";
  return "supplier";
}

/** What is still needed on a deal, both legs together. Orders a group: the largest first. */
export const stillNeeded = (r: PaymentFigures): number => Math.max(r.buyer_left, 0) + Math.max(r.supplier_left, 0);

/** A dollar figure without the cents when it is a whole number, so "$6,000" and "$6,000.50" both read right. */
export const money = (n: number): string => {
  const s = fmtAmount(n);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
};

export type LegTone = "owed" | "done" | "quiet";
/** One line under a deal: `text` is the sentence, `note` is the quiet suffix to show after it (may be empty). */
export interface PaymentLeg { text: string; note: string; tone: LegTone }

export const MARKED_PAID_NOTE = "marked paid, not linked to a bank payment";

/** The buyer line. `markedPaid` is true when the deal's stage says the buyer has paid: if the bank link is still
 *  short, the line says so in a quiet suffix instead of hiding the difference. */
export function buyerLeg(r: PaymentFigures, markedPaid: boolean): PaymentLeg {
  if (r.buyer_left > OWED) {
    const text = r.buyer_paired > LINKED
      ? `Buyer: ${money(r.buyer_paired)} of ${money(r.buyer_target)} linked, ${money(r.buyer_left)} due`
      : `Buyer: nothing linked, ${money(r.buyer_left)} due`;
    return { text, note: markedPaid ? MARKED_PAID_NOTE : "", tone: "owed" };
  }
  if (r.buyer_paired > LINKED) return { text: `Buyer: ${money(r.buyer_paired)} linked`, note: "", tone: "done" };
  if (r.no_buyer_link) return { text: "Buyer: no bank record", note: "", tone: "quiet" };
  return { text: "Buyer: nothing due", note: "", tone: "quiet" };
}

/** The supplier line. Only the total is known, never which supplier on a deal with several is unpaid. */
export function supplierLeg(r: PaymentFigures): PaymentLeg {
  if (costNotEntered(r)) return { text: "Supplier: cost not entered yet", note: "", tone: "owed" };
  if (r.supplier_left > OWED) {
    const text = r.supplier_paired > LINKED
      ? `Supplier: ${money(r.supplier_paired)} of ${money(r.supplier_target)} linked, ${money(r.supplier_left)} to pay`
      : `Supplier: nothing linked, ${money(r.supplier_left)} to pay`;
    return { text, note: "", tone: "owed" };
  }
  if (r.supplier_paired > LINKED) return { text: `Supplier: ${money(r.supplier_paired)} linked`, note: "", tone: "done" };
  // Same order as the website: a cost that was all kept reads as kept, ahead of the no-bank-record note.
  if (r.cost_kept && r.supplier_target <= LINKED) return { text: "Supplier: kept, nothing to pay", note: "", tone: "quiet" };
  if (r.no_supplier_link) return { text: "Supplier: no bank record", note: "", tone: "quiet" };
  return { text: "Supplier: nothing to pay", note: "", tone: "quiet" };
}

export interface PaymentEntry<T> {
  item: T;
  figures: PaymentFigures;
  /** Sorts the oldest invoice first among deals that still need the same amount: an ISO date or timestamp. */
  since: string;
}
export interface PaymentGroupOut<T> {
  key: PaymentGroup;
  title: string;
  entries: PaymentEntry<T>[];
  /** Still unlinked from buyers, and still unlinked to suppliers, summed over the group. */
  buyerDue: number;
  supplierDue: number;
}

/** Splits the deals into the four groups, in display order, each sorted by the most still needed and then by the
 *  oldest invoice. Every group is returned, empty or not. */
export function groupPayments<T>(entries: PaymentEntry<T>[]): PaymentGroupOut<T>[] {
  return PAYMENT_GROUPS.map(({ key, title }) => {
    const mine = entries
      .filter((e) => paymentGroupOf(e.figures) === key)
      .sort((a, b) => stillNeeded(b.figures) - stillNeeded(a.figures) || a.since.localeCompare(b.since));
    return {
      key, title, entries: mine,
      buyerDue: mine.reduce((s, e) => s + Math.max(e.figures.buyer_left, 0), 0),
      supplierDue: mine.reduce((s, e) => s + Math.max(e.figures.supplier_left, 0), 0),
    };
  });
}

/** A group's header line: how many deals, and what is still needed in each direction. */
export function groupSummary(g: Pick<PaymentGroupOut<unknown>, "entries" | "buyerDue" | "supplierDue">): string {
  const n = g.entries.length;
  return [
    `${n} ${n === 1 ? "deal" : "deals"}`,
    g.buyerDue > OWED ? `${money(g.buyerDue)} due from buyers` : "",
    g.supplierDue > OWED ? `${money(g.supplierDue)} to pay suppliers` : "",
  ].filter(Boolean).join(", ");
}

// ─── who sees it, and who can move a load ─────────────────────────────────

/** The Payments view is all dollars, so it shows to whoever may see deal dollars (the switch, or an admin). */
export const canSeePayments = (me: Perms | null | undefined): boolean =>
  !!me && (isAdmin(me) || can(me, "deal_flow:view_numbers"));

/** What the deal list says about a deal's loads. */
export interface DealLoads {
  ships_direct?: boolean;
  logistics_bookings?: number;
  logistics_stage?: string;
  load_numbers?: string;
}

/** The deal's load numbers (live and quote-stage trucks), in the order they were made. */
export const loadNumbersOf = (f: Pick<DealLoads, "load_numbers">): string[] =>
  (f.load_numbers || "").split(/\s+/).filter(Boolean);

/** Whether the deal has any load at all, a quote included. Move to Logistics is for a deal with none: with a
 *  quote already on it, a second load would duplicate it. */
export const hasAnyLoad = (f: DealLoads): boolean =>
  (f.logistics_bookings ?? 0) > 0 || !!(f.logistics_stage || "") || loadNumbersOf(f).length > 0;

/** Move to Logistics is offered on a deal with no load that does not ship direct. */
export const canMoveDeal = (f: DealLoads): boolean => !f.ships_direct && !hasAnyLoad(f);
