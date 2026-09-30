import type { LogisticsPayRule, LogisticsPaySettings } from "./api";

// R-401: the logistics pay rule, for the live example on the settings screen. The figures on
// every other screen are worked out by the server (and the desktop's Rust twin), so this
// exists only to let the owner see what a rule would pay before saving it. It is the same
// arithmetic, kept in step with `pay_for` in freight.rs.

/** Whole cents, halves rounded away from zero. */
export const roundCents = (n: number): number => {
  const v = Math.round((Math.abs(n) + 1e-9) * 100) / 100;
  return n < 0 ? -v : v;
};

export type PayRuleInput = Pick<LogisticsPaySettings, "share_pct" | "cover_losses" | "loss_pay_pct">;

/** What one load pays. `surplus = charged - freight`. A profit pays `share_pct` of it. A load
 *  that breaks even or loses pays `loss_pay_pct` of the freight cost when the owner covers
 *  losses, else `share_pct` of the (zero or negative) surplus. */
export function logisticsPayFor(
  rule: PayRuleInput, charged: number, freight: number,
): { pay: number; rule: Exclude<LogisticsPayRule, "pending"> } {
  const surplus = charged - freight;
  if (surplus > 0) return { pay: roundCents(surplus * rule.share_pct / 100), rule: "share" };
  if (rule.cover_losses) return { pay: roundCents(freight * rule.loss_pay_pct / 100), rule: "loss_cover" };
  return { pay: roundCents(surplus * rule.share_pct / 100), rule: "loss_share" };
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const ordinal = (n: number) => {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10] ?? "th"}`;
};

/** The schedule in a sentence, e.g. "Every Friday". */
export function describeSchedule(
  s: Pick<LogisticsPaySettings, "frequency" | "pay_weekday" | "anchor_date" | "pay_day_of_month">,
  fmtDay: (d: string) => string = (d) => d,
): string {
  if (s.frequency === "monthly") return `On the ${ordinal(s.pay_day_of_month || 1)} of each month`;
  if (s.frequency === "biweekly") return s.anchor_date ? `Every two weeks, including ${fmtDay(s.anchor_date)}` : "Every two weeks";
  return `Every ${WEEKDAYS[s.pay_weekday] ?? "Friday"}`;
}
