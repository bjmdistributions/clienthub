// R-542: the words and groups of the Logistics week (the trucks booked each day of a week and his commission). The
// figures come from the server (/api/logistics/pay/week); this file only lays them out, so the rules are tested here
// and the component prints them. Days are plain YYYY-MM-DD strings, read at local midnight.

import type { LogisticsWeek, LogisticsWeekLoad } from "./api";
import { localDay, parseLocalDay } from "./format";

/** `day` moved by `n` days. */
export function shiftDay(day: string, n: number): string {
  const d = parseLocalDay(day);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

const short = (day: string) => parseLocalDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "Oct 9 to Oct 15". */
export function weekRange(start: string, end: string): string {
  return `${short(start)} to ${short(end)}`;
}

/** "Thu, Oct 9": the day a group of trucks was booked. */
export function bookedDayLabel(day: string): string {
  return parseLocalDay(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** The week's trucks by the day they were booked, oldest day first, in the order the server sent them. */
export function byBookedDay(loads: readonly LogisticsWeekLoad[]): { day: string; loads: LogisticsWeekLoad[] }[] {
  const out: { day: string; loads: LogisticsWeekLoad[] }[] = [];
  for (const l of loads) {
    const last = out[out.length - 1];
    if (last && last.day === l.booked_on) last.loads.push(l);
    else out.push({ day: l.booked_on, loads: [l] });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** The pill beside the week's commission: paid, due on its pay day, or paid on a coming pay day. null when the
 *  week has nothing to say (no money shown, or nothing owed for it). */
export function weekPill(w: LogisticsWeek): { tone: "success" | "warning" | "neutral"; word: string } | null {
  if (!w.money) return null;
  if (w.status === "paid") return { tone: "success", word: "Paid" };
  if (w.status === "due") return { tone: "warning", word: w.pay_date === w.today ? "Due today" : `Due ${short(w.pay_date)}` };
  if (w.status === "upcoming" && w.pay_date) return { tone: "neutral", word: `Pays ${short(w.pay_date)}` };
  return null;
}

/** "Paid $140 on Oct 16, Cash, $40 more than the commission", or "" while the week is not paid on its date. */
export function paidLine(w: LogisticsWeek, money: (n: number) => string): string {
  if (!w.paid) return "";
  const bits = [`Paid ${money(w.paid.amount)} on ${short(w.paid.paid_at || w.pay_date)}`];
  if (w.paid.method) bits.push(w.paid.method);
  if (w.paid.extra > 0.005) bits.push(`${money(w.paid.extra)} more than the commission`);
  return bits.join(", ");
}

/** Why a typed payment cannot be recorded, or "" when it can: it is at least what is owed on the pay date. */
export function amountProblem(amount: number, toPay: number, money: (n: number) => string): string {
  if (!Number.isFinite(amount) || amount <= 0) return "Type the amount paid.";
  if (amount < toPay - 0.005) return `Pay at least ${money(toPay)}, the commission owed.`;
  return "";
}

/** The week after this one may be looked at only once it has begun. */
export const hasNextWeek = (w: LogisticsWeek): boolean => w.end < w.today;
