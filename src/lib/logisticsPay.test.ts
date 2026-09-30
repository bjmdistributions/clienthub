import { describe, it, expect } from "vitest";
import { describeSchedule, logisticsPayFor, roundCents } from "./logisticsPay";

// R-401: the same numbers the server and the desktop's Rust twin are tested against.
const rule = { share_pct: 100, cover_losses: true, loss_pay_pct: 10 };

describe("logisticsPayFor", () => {
  it("pays the whole surplus at 100 percent", () => {
    expect(logisticsPayFor(rule, 500, 350)).toEqual({ pay: 150, rule: "share" });
  });
  it("pays a share of the surplus", () => {
    expect(logisticsPayFor({ ...rule, share_pct: 50 }, 500, 350).pay).toBe(75);
  });
  it("pays a percent of the freight on a load that lost money when losses are covered", () => {
    expect(logisticsPayFor(rule, 300, 350)).toEqual({ pay: 35, rule: "loss_cover" });
  });
  it("shares the loss when losses are not covered", () => {
    expect(logisticsPayFor({ ...rule, cover_losses: false }, 300, 350)).toEqual({ pay: -50, rule: "loss_share" });
  });
  it("covers a load with nothing charged", () => {
    expect(logisticsPayFor({ ...rule, loss_pay_pct: 5 }, 0, 200).pay).toBe(10);
  });
  it("treats a break-even load as a covered one", () => {
    expect(logisticsPayFor(rule, 350, 350)).toEqual({ pay: 35, rule: "loss_cover" });
  });
  it("rounds halves away from zero", () => {
    expect(roundCents(0.125)).toBe(0.13);
    expect(roundCents(-0.125)).toBe(-0.13);
    expect(logisticsPayFor({ ...rule, share_pct: 33.33 }, 101, 100).pay).toBe(0.33);
  });
});

describe("describeSchedule", () => {
  it("says the weekday", () => {
    expect(describeSchedule({ frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1 })).toBe("Every Friday");
  });
  it("says the day of the month with its ordinal", () => {
    const at = (d: number) => describeSchedule({ frequency: "monthly", pay_weekday: 4, anchor_date: "", pay_day_of_month: d });
    expect([at(1), at(2), at(3), at(11), at(22), at(28)]).toEqual([
      "On the 1st of each month", "On the 2nd of each month", "On the 3rd of each month",
      "On the 11th of each month", "On the 22nd of each month", "On the 28th of each month",
    ]);
  });
  it("names the anchor for every two weeks", () => {
    expect(describeSchedule({ frequency: "biweekly", pay_weekday: 4, anchor_date: "2026-10-02", pay_day_of_month: 1 }))
      .toBe("Every two weeks, including 2026-10-02");
  });
});
