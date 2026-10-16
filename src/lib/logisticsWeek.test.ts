import { describe, expect, it } from "vitest";
import type { LogisticsWeek, LogisticsWeekLoad } from "./api";
import { amountProblem, bookedDayLabel, byBookedDay, hasNextWeek, paidLine, shiftDay, weekPill, weekRange } from "./logisticsWeek";

// R-542: invented loads and amounts throughout.
const money = (n: number) => `$${n.toFixed(2)}`;
const load = (id: string, booked_on: string, commission: number | null = 100): LogisticsWeekLoad =>
  ({ id, code: `LD-${id}`, booked_on, lane: "Camden, NJ to Columbus, OH", commission, paid: false });
const week = (over: Partial<LogisticsWeek> = {}): LogisticsWeek => ({
  start: "2026-10-09", end: "2026-10-15", pay_date: "2026-10-16", today: "2026-10-14", money: true, mine: false,
  payee_name: "Test Payee", pay_method: "Zelle", loads: [], commission: 0, status: "", to_pay: 0, paid: null,
  paid_total: 0, owed_now: 0, can_record: false, ...over,
});

describe("the Logistics week (R-542)", () => {
  it("moves a day across a month end and names the week and the booked day", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-10-16", -1)).toBe("2026-10-15");
    expect(weekRange("2026-10-09", "2026-10-15")).toBe("Oct 9 to Oct 15");
    expect(bookedDayLabel("2026-10-09")).toBe("Fri, Oct 9");
  });

  it("groups the trucks by the day they were booked, oldest day first", () => {
    const g = byBookedDay([load("1", "2026-10-09"), load("2", "2026-10-13"), load("3", "2026-10-13")]);
    expect(g.map((x) => [x.day, x.loads.map((l) => l.id)])).toEqual([["2026-10-09", ["1"]], ["2026-10-13", ["2", "3"]]]);
    expect(byBookedDay([])).toEqual([]);
  });

  it("says whether the week is paid, due or coming, and nothing without the money", () => {
    expect(weekPill(week({ status: "paid" }))).toEqual({ tone: "success", word: "Paid" });
    expect(weekPill(week({ status: "due", today: "2026-10-16" }))).toEqual({ tone: "warning", word: "Due today" });
    expect(weekPill(week({ status: "due", today: "2026-10-20" }))).toEqual({ tone: "warning", word: "Due Oct 16" });
    expect(weekPill(week({ status: "upcoming" }))).toEqual({ tone: "neutral", word: "Pays Oct 16" });
    expect(weekPill(week({ status: "" }))).toBeNull();
    expect(weekPill(week({ status: "paid", money: false }))).toBeNull();
  });

  it("reads a recorded payment, with the extra over the commission", () => {
    expect(paidLine(week(), money)).toBe("");
    const paid = { amount: 140, extra: 40, paid_at: "2026-10-16", method: "Cash", payout_id: "lp_1" };
    expect(paidLine(week({ paid }), money)).toBe("Paid $140.00 on Oct 16, Cash, $40.00 more than the commission");
    expect(paidLine(week({ paid: { ...paid, extra: 0, method: "" } }), money)).toBe("Paid $140.00 on Oct 16");
  });

  it("takes a payment of at least what is owed", () => {
    expect(amountProblem(100, 100, money)).toBe("");
    expect(amountProblem(150, 100, money)).toBe("");
    expect(amountProblem(99.99, 100, money)).toBe("Pay at least $100.00, the commission owed.");
    expect(amountProblem(0, 100, money)).toBe("Type the amount paid.");
    expect(amountProblem(Number.NaN, 100, money)).toBe("Type the amount paid.");
  });

  it("looks at the next week only once it has begun", () => {
    expect(hasNextWeek(week({ today: "2026-10-14" }))).toBe(false);
    expect(hasNextWeek(week({ today: "2026-10-16" }))).toBe(true);
  });
});
