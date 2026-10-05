// R-449 / R-446: the small pure rules the Bills screen leans on. Dates are plain YYYY-MM-DD
// strings throughout and never go through a timezone: the server decides what "today" is
// (Central) and sends it, and every comparison here is on those strings.
import type { BillStateStatus, BillsAlerts, Cadence, PeriodState, UpcomingDue } from "./billsApi";

/** bills_core::DUE_SOON_DAYS: a bill is "due soon" from this many days ahead. */
export const DUE_SOON_DAYS = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));

/** "Oct 8" */
export function shortDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(day || "")) return "";
  return `${MONTHS[+day.slice(5, 7) - 1]} ${+day.slice(8, 10)}`;
}

/** "Oct 8, 2026" */
export function longDay(day: string): string {
  const s = shortDay(day);
  return s ? `${s}, ${day.slice(0, 4)}` : "";
}

/** "October 2026" for a YYYY-MM or a full day. */
export function monthTitle(day: string): string {
  return `${MONTHS_LONG[+day.slice(5, 7) - 1]} ${day.slice(0, 4)}`;
}

/** Whole days from a to b (b later is positive). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export function daysInMonth(day: string): number {
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
}

/** The first day of the month `offset` months from the month of `day`. */
function monthStart(day: string, offset: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1 + offset, 1));
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The last day of the month `offset` months from the month of `day`. */
function monthEnd(day: string, offset: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) + offset, 0));
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// ------------------------------------------------------------------------------ periods

export type PeriodKind = "this_month" | "last_month" | "last_3" | "this_year";

export const PERIODS: { kind: PeriodKind; label: string }[] = [
  { kind: "this_month", label: "This month" },
  { kind: "last_month", label: "Last month" },
  { kind: "last_3", label: "Last 3 months" },
  { kind: "this_year", label: "This year" },
];

/** The dates a period covers, ending today unless it is a finished month. "Last 3 months" is
 *  this month and the two before it, so it always starts on the 1st. */
export function periodRange(kind: PeriodKind, today: string): { from: string; to: string } {
  switch (kind) {
    case "last_month": return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case "last_3": return { from: monthStart(today, -2), to: today };
    case "this_year": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: monthStart(today, 0), to: today };
  }
}

/** "Oct 1 to Oct 5" or, across years, "Dec 1, 2025 to Jan 5, 2026". */
export function rangeText(from: string, to: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return sameYear ? `${shortDay(from)} to ${shortDay(to)}` : `${longDay(from)} to ${longDay(to)}`;
}

/** Percent change from `prev` to `cur`, or null when there was nothing before to compare to. */
export function pctChange(cur: number, prev: number): number | null {
  if (!(prev > 0.005)) return null;
  return ((cur - prev) / prev) * 100;
}

/** A chart's month labels: "Oct", and "Jan 2026" on the first bucket of each year when the
 *  series spans more than one. */
export function monthLabels(months: string[]): string[] {
  const spans = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const seen = new Set<string>();
  return months.map((m) => {
    const y = m.slice(0, 4);
    const first = !seen.has(y);
    seen.add(y);
    const name = MONTHS[+m.slice(5, 7) - 1] || m;
    return spans && first ? `${name} ${y}` : name;
  });
}

// ------------------------------------------------------------------------------ bills

export const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every three months" },
  { value: "semiannual", label: "Twice a year" },
  { value: "annual", label: "Once a year" },
];
export const cadenceLabel = (c: string) => CADENCE_OPTIONS.find((o) => o.value === c)?.label ?? c;

export const METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "zelle", label: "Zelle" },
  { value: "ach", label: "ACH" },
  { value: "card", label: "Card" },
  { value: "check", label: "Check" },
  { value: "other", label: "Other" },
];
export const billMethodLabel = (m: string) => METHOD_OPTIONS.find((o) => o.value === m)?.label ?? m;

type Tone = "danger" | "warning" | "success" | "neutral";
export const STATUS_PILL: Record<BillStateStatus, { label: string; tone: Tone }> = {
  overdue: { label: "Overdue", tone: "danger" },
  due_soon: { label: "Due soon", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  upcoming: { label: "Upcoming", tone: "neutral" },
  not_seen: { label: "Not seen yet", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export const PERIOD_PILL: Record<PeriodState, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "success" },
  late: { label: "Paid late", tone: "warning" },
  missed: { label: "Missed", tone: "danger" },
  due: { label: "Not due yet", tone: "neutral" },
};

/** "Oct 8, in 3 days" */
export function dueText(nextDue: string | null, daysUntil: number | null): string {
  if (!nextDue) return "No date yet";
  const day = shortDay(nextDue);
  if (daysUntil == null) return day;
  if (daysUntil === 0) return `${day}, today`;
  if (daysUntil === 1) return `${day}, tomorrow`;
  if (daysUntil === -1) return `${day}, yesterday`;
  return daysUntil > 0 ? `${day}, in ${daysUntil} days` : `${day}, ${-daysUntil} days ago`;
}

export type ChipState = "paid" | "overdue" | "soon" | "plain";

/** How a due date reads on the month strip. Unpaid dates inside the due-soon window, and ones
 *  already past that the bank feed has not caught up with, both read as due soon. */
export function chipState(u: UpcomingDue, overdueDates: string[], today: string): ChipState {
  if (u.paid) return "paid";
  if (overdueDates.includes(u.due)) return "overdue";
  return daysBetween(today, u.due) <= DUE_SOON_DAYS ? "soon" : "plain";
}

/** Up to two capital letters for a name with no logo. */
export function initials(name: string): string {
  const w = (name || "").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return "?";
  const letters = w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0];
  return letters.toUpperCase();
}

/** Which of the six chart tokens (1..6) tints a name's tile. Stable for a name, so a bill keeps
 *  its colour on every screen and every device. */
export function tintIndex(name: string): number {
  let h = 0;
  for (const ch of (name || "").trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 6) + 1;
}

/** The one "needs you now" line for Brief and Dashboard: overdue bills first (red), else bills
 *  due soon (orange). Null when neither. */
export function alertRow(a: BillsAlerts | null): { tone: "danger" | "warning"; title: string; sub: string } | null {
  if (!a) return null;
  const over = a.overdue_count;
  const soon = a.due_soon_count;
  if (over + soon === 0) return null;
  const word = (n: number) => (n === 1 ? "bill" : "bills");
  const pool = over > 0 ? a.items.filter((i) => i.status === "overdue") : a.items;
  const names = pool.slice(0, 3).map((i) => i.name).join(", ") + (pool.length > 3 ? "…" : "");
  return {
    tone: over > 0 ? "danger" : "warning",
    title: over > 0 ? `${over} ${word(over)} overdue` : `${soon} ${word(soon)} due soon`,
    sub: names + (over > 0 && soon > 0 ? `, and ${soon} due soon` : ""),
  };
}
