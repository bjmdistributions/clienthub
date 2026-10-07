// R-464 (8.6): what the Bills screen shows of logistics money. Two things, both worked out here from rows the
// screen already has, so the rules are tested and the components only print them.
//   1. The Logistics pay block: the next pay date, who is paid, how much, and how many loads it covers.
//   2. The marks on the month strip: each logistics pay date and each unpaid carrier's due date.
// The figures themselves come from the server (the pay tracker and the carrier-pay rows); nothing is
// recomputed. Days are plain YYYY-MM-DD strings, never run through a timezone.

import type { CarrierPayRow, LogisticsPayTracker } from "./api";
import { DUE_SOON_DAYS, daysBetween, longDay } from "./billsFormat";
import { can, isAdmin, isLogisticsOnly, type Perms } from "./permissions";

/** Who may read the pay tracker: an admin, or someone who sees deals and their dollar figures. A Logistics-only
 *  account never does. The server refuses the rest, so a screen asks nothing of it for them. */
export function canReadPayTracker(me: Perms | null | undefined): boolean {
  if (!me || isLogisticsOnly(me)) return false;
  return isAdmin(me) || (can(me, "deal_flow:view") && can(me, "deal_flow:view_numbers"));
}

const owes = (n: number | null | undefined): boolean => (n ?? 0) > 0.005;

// ─── the Logistics pay block ──────────────────────────────────────────────

export interface PayBlock {
  payee: string;
  /** The date the block is about: the oldest date still unpaid with money on it, else the next scheduled one. */
  date: string;
  amount: number;
  /** How many loads that payment covers. */
  loads: number;
  /** The date is today or earlier and money is owed: the payment can be recorded now. */
  dueNow: boolean;
  /** The date has passed and money is still owed. */
  late: boolean;
  /** Nothing is owed on that date yet (it is only the next scheduled one). */
  nothingOwed: boolean;
}

/** The block, or null when there is nothing to say: logistics pay is off, only tracked, or has no date. */
export function payBlockOf(t: LogisticsPayTracker | null | undefined, today: string): PayBlock | null {
  if (!t || !t.settings?.enabled) return null;
  if (t.mode === "off" || t.mode === "track" || t.settings.surplus_mode === "track") return null;
  const unpaid = (t.dates ?? [])
    .filter((d) => d.status !== "paid" && owes(d.total))
    .map((d) => d.pay_date)
    .sort()[0];
  const date = unpaid ?? t.next_pay_date ?? "";
  if (!date) return null;
  const row = (t.dates ?? []).find((d) => d.pay_date === date);
  const amount = row ? row.total : unpaid ? 0 : t.next_total ?? 0;
  // A payment on a date covers every load due on or before it, the same reach the server records.
  const loads = (t.lines ?? []).filter((l) => !l.pending && !l.dropped && l.due_date && l.due_date <= date && Math.abs(l.owed) > 0.005).length;
  const nothingOwed = !owes(amount);
  return {
    payee: t.settings.payee_name || "",
    date,
    amount,
    loads: nothingOwed ? 0 : loads,
    dueNow: !nothingOwed && date <= today,
    late: !nothingOwed && date < today,
    nothingOwed,
  };
}

// ─── the marks on the month strip ─────────────────────────────────────────

export type MarkState = "paid" | "overdue" | "soon" | "plain";
export interface LogisticsMark {
  key: string;
  kind: "pay" | "carrier";
  /** The day of the month (1 to 31). */
  day: number;
  date: string;
  state: MarkState;
  /** The hover text. */
  title: string;
  /** A carrier mark opens this load on its Pay step; a pay mark opens the pay tracker. */
  bookingId?: string;
}

const stateOf = (date: string, today: string): MarkState => {
  const d = daysBetween(today, date);
  return d < 0 ? "overdue" : d <= DUE_SOON_DAYS ? "soon" : "plain";
};

const WORD: Record<MarkState, string> = { paid: ", paid", overdue: ", overdue", soon: "", plain: "" };

/** Every logistics pay date and every unpaid carrier's due date that falls in the month of `today`, oldest first.
 *  `pay` is the tracker (null when the person cannot read it or pay is off), `toPay` the carriers still owed. */
export function logisticsMarks(
  today: string, pay: LogisticsPayTracker | null | undefined, toPay: readonly CarrierPayRow[] | null | undefined,
  money: (n: number) => string,
): LogisticsMark[] {
  const month = today.slice(0, 7);
  const out: LogisticsMark[] = [];
  const inMonth = (d: string) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && d.startsWith(month);

  const block = pay && pay.settings?.enabled && pay.mode !== "off" && pay.mode !== "track" && pay.settings.surplus_mode !== "track" ? pay : null;
  if (block) {
    const who = block.settings.payee_name || "Logistics";
    for (const d of block.dates ?? []) {
      // The same dates the pay tracker itself lists: paid ones, ones with money, and the next scheduled one.
      if (!(d.status === "paid" || owes(d.total) || d.pay_date === block.next_pay_date)) continue;
      if (!inMonth(d.pay_date)) continue;
      const state: MarkState = d.status === "paid" ? "paid" : stateOf(d.pay_date, today);
      out.push({
        key: `pay:${d.pay_date}`, kind: "pay", day: +d.pay_date.slice(8, 10), date: d.pay_date, state,
        title: `Logistics pay, ${who}, ${longDay(d.pay_date)}${owes(d.total) ? ", " + money(d.total) : ""}${WORD[state]}`,
      });
    }
  }

  for (const r of toPay ?? []) {
    if (!inMonth(r.pay_due_date)) continue;
    const state = stateOf(r.pay_due_date, today);
    out.push({
      key: `carrier:${r.booking_id}`, kind: "carrier", day: +r.pay_due_date.slice(8, 10), date: r.pay_due_date, state,
      bookingId: r.booking_id,
      title: `${r.carrier || "Carrier"}, ${r.load_number}, due ${longDay(r.pay_due_date)}${r.rate != null ? ", " + money(r.rate) : ""}${WORD[state]}`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === "pay" ? -1 : 1));
}
