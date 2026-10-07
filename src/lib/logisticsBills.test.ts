import { describe, expect, it } from "vitest";
import type { CarrierPayRow, LogisticsPayDate, LogisticsPaySettings, LogisticsPayTracker, LogisticsPayTrackerLine } from "./api";
import { canReadPayTracker, logisticsMarks, payBlockOf } from "./logisticsBills";

const money = (n: number) => `$${n.toFixed(2)}`;
const TODAY = "2026-10-07";

const settings = (over: Partial<LogisticsPaySettings> = {}): LogisticsPaySettings => ({
  enabled: true, surplus_mode: "pay", payee_id: "u1", payee_name: "Sam Rivera", share_pct: 100, cover_losses: true, loss_pay_pct: 0,
  frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1, method: "Zelle", details: "", ...over,
});
const date = (pay_date: string, total: number, status: LogisticsPayDate["status"], over: Partial<LogisticsPayDate> = {}): LogisticsPayDate => ({
  pay_date, period_start: "2026-10-01", period_end: "2026-10-07", total, carried_in: 0, status, payout_id: status === "paid" ? "po1" : null, ...over,
});
const line = (id: string, due_date: string, owed: number, over: Partial<LogisticsPayTrackerLine> = {}): LogisticsPayTrackerLine => ({
  deal_flow_id: id, invoice_number: `INV-${id}`, client_name: "Acme", booking_codes: ["LD-1"], earned_on: "2026-10-01", due_date,
  charged: 500, charged_source: "lines", freight: 300, freight_source: "paid", surplus: 200, rule: "markup", pay: owed, paid: 0, owed, pending: false, ...over,
});
const tracker = (over: Partial<LogisticsPayTracker> = {}): LogisticsPayTracker => ({
  settings: settings(), mode: "pay", today: TODAY, next_pay_date: "2026-10-09", next_total: 150, due_now_total: 0,
  lines: [], dates: [], payouts: [], ...over,
});
const carrier = (id: string, due: string, over: Partial<CarrierPayRow> = {}): CarrierPayRow => ({
  booking_id: id, load_number: `LD-${id}`, deal_flow_id: "d1", deal_label: "INV-1", route: "A to B", carrier: "Blue Line", carrier_id: "c1",
  pay_method: "zelle", pay_details: "", rate: 1200, quote_amount: 1500, pay_due_date: due, days_until: null, overdue: false, status: "delivered",
  delivered_at: "2026-10-01", paperwork: { bol: true, pod: true, carrier_invoice: true }, carrier_invoice_file_id: "", paid_amount: null,
  paid_at: "", paid_method: "", paid_note: "", bank_linked: "", ...over,
} as CarrierPayRow);

describe("who reads the pay tracker", () => {
  it("an admin, or a deal viewer with the dollar switch; never a Logistics-only account", () => {
    expect(canReadPayTracker({ permissions: ["*"] })).toBe(true);
    expect(canReadPayTracker({ permissions: ["admin:manage"] })).toBe(true);
    expect(canReadPayTracker({ permissions: ["deal_flow:view", "deal_flow:view_numbers"] })).toBe(true);
    expect(canReadPayTracker({ permissions: ["deal_flow:view"] })).toBe(false);
    expect(canReadPayTracker({ permissions: ["financials:view"] })).toBe(false);
    expect(canReadPayTracker({ permissions: ["logistics:view", "logistics:edit"] })).toBe(false);
    expect(canReadPayTracker(null)).toBe(false);
  });
});

describe("the Logistics pay block", () => {
  it("shows nothing when pay is off, only tracked, missing, or has no date", () => {
    expect(payBlockOf(null, TODAY)).toBeNull();
    expect(payBlockOf(tracker({ settings: settings({ enabled: false }) }), TODAY)).toBeNull();
    expect(payBlockOf(tracker({ mode: "off" }), TODAY)).toBeNull();
    expect(payBlockOf(tracker({ mode: "track" }), TODAY)).toBeNull();
    expect(payBlockOf(tracker({ mode: undefined, settings: settings({ surplus_mode: "track" }) }), TODAY)).toBeNull();
    expect(payBlockOf(tracker({ next_pay_date: "", dates: [] }), TODAY)).toBeNull();
  });

  it("the next pay date with its payee, amount and the loads it covers", () => {
    const t = tracker({
      dates: [date("2026-10-09", 150, "upcoming")],
      lines: [line("a", "2026-10-09", 100), line("b", "2026-10-09", 50), line("c", "2026-10-16", 80)],
    });
    expect(payBlockOf(t, TODAY)).toEqual({ payee: "Sam Rivera", date: "2026-10-09", amount: 150, loads: 2, dueNow: false, late: false, nothingOwed: false });
  });

  it("an unpaid date that has arrived is due now, and late once it has passed", () => {
    const t = tracker({
      next_pay_date: "2026-10-09", next_total: 0, due_now_total: 220,
      dates: [date("2026-10-02", 220, "due"), date("2026-10-09", 0, "upcoming")],
      lines: [line("a", "2026-10-02", 220)],
    });
    expect(payBlockOf(t, TODAY)).toMatchObject({ date: "2026-10-02", amount: 220, loads: 1, dueNow: true, late: true });
    expect(payBlockOf(t, "2026-10-02")).toMatchObject({ date: "2026-10-02", dueNow: true, late: false });
  });

  it("takes the oldest unpaid date with money, and counts every load due on or before it", () => {
    const t = tracker({
      dates: [date("2026-09-25", 40, "paid"), date("2026-10-02", 70, "due"), date("2026-10-09", 50, "upcoming")],
      lines: [line("a", "2026-10-02", 70), line("b", "2026-10-09", 50)],
    });
    expect(payBlockOf(t, TODAY)).toMatchObject({ date: "2026-10-02", amount: 70, loads: 1 });
  });

  it("a date with nothing on it reads as nothing owed yet, with no load count", () => {
    const t = tracker({ next_total: 0, dates: [date("2026-10-09", 0, "upcoming")] });
    expect(payBlockOf(t, TODAY)).toEqual({ payee: "Sam Rivera", date: "2026-10-09", amount: 0, loads: 0, dueNow: false, late: false, nothingOwed: true });
  });

  it("a load waiting on its amount or taken back is not a load the payment covers", () => {
    const t = tracker({
      dates: [date("2026-10-09", 100, "upcoming")],
      lines: [line("a", "2026-10-09", 100), line("b", "2026-10-09", 0, { pending: true, pay: null }), line("c", "2026-10-09", -30, { dropped: true })],
    });
    expect(payBlockOf(t, TODAY)?.loads).toBe(1);
  });
});

describe("the marks on the month strip", () => {
  it("marks each pay date that has money, is paid, or is the next one, in this month only", () => {
    const t = tracker({
      next_pay_date: "2026-10-16",
      dates: [date("2026-09-25", 40, "paid"), date("2026-10-02", 220, "paid"), date("2026-10-09", 150, "upcoming"), date("2026-10-16", 0, "upcoming"), date("2026-10-23", 0, "upcoming")],
    });
    const m = logisticsMarks(TODAY, t, [], money);
    expect(m.map((x) => [x.kind, x.date, x.state])).toEqual([
      ["pay", "2026-10-02", "paid"], ["pay", "2026-10-09", "soon"], ["pay", "2026-10-16", "plain"],
    ]);
    expect(m[1]).toMatchObject({ day: 9, key: "pay:2026-10-09" });
    expect(m[1].title).toBe("Logistics pay, Sam Rivera, Oct 9, 2026, $150.00");
  });

  it("an unpaid pay date that has passed is overdue, one within three days is due soon", () => {
    const t = tracker({ dates: [date("2026-10-02", 70, "due"), date("2026-10-09", 150, "upcoming"), date("2026-10-10", 20, "upcoming"), date("2026-10-30", 20, "upcoming")] });
    expect(logisticsMarks(TODAY, t, [], money).map((x) => x.state)).toEqual(["overdue", "soon", "soon", "plain"]);
    // three days ahead is still due soon, four is not
    expect(logisticsMarks("2026-10-06", t, [], money).map((x) => x.state)).toEqual(["overdue", "soon", "plain", "plain"]);
    expect(logisticsMarks(TODAY, t, [], money)[0].title).toContain(", overdue");
  });

  it("no pay marks when pay is off or only tracked, or the tracker was not read", () => {
    const dates = [date("2026-10-09", 150, "upcoming")];
    expect(logisticsMarks(TODAY, null, [], money)).toEqual([]);
    expect(logisticsMarks(TODAY, tracker({ settings: settings({ enabled: false }), dates }), [], money)).toEqual([]);
    expect(logisticsMarks(TODAY, tracker({ mode: "track", dates }), [], money)).toEqual([]);
    expect(logisticsMarks(TODAY, tracker({ mode: "off", dates }), [], money)).toEqual([]);
  });

  it("marks each unpaid carrier on its due date, and opens that load", () => {
    const rows = [
      carrier("1", "2026-10-03"), carrier("2", "2026-10-09", { rate: null }), carrier("3", "2026-11-02"), carrier("4", ""),
      carrier("5", "2026-10-30", { carrier: "" }),
    ];
    const m = logisticsMarks(TODAY, null, rows, money);
    expect(m.map((x) => [x.bookingId, x.day, x.state])).toEqual([["1", 3, "overdue"], ["2", 9, "soon"], ["5", 30, "plain"]]);
    expect(m[0]).toMatchObject({ kind: "carrier", key: "carrier:1" });
    expect(m[0].title).toBe("Blue Line, LD-1, due Oct 3, 2026, $1200.00, overdue");
    expect(m[1].title).toBe("Blue Line, LD-2, due Oct 9, 2026");
    expect(m[2].title.startsWith("Carrier, LD-5")).toBe(true);
  });

  it("puts a pay mark before a carrier mark on the same day, and sorts by day", () => {
    const t = tracker({ dates: [date("2026-10-09", 150, "upcoming")] });
    const m = logisticsMarks(TODAY, t, [carrier("1", "2026-10-09"), carrier("2", "2026-10-05")], money);
    expect(m.map((x) => x.key)).toEqual(["carrier:2", "pay:2026-10-09", "carrier:1"]);
  });

  it("a mark has a day that falls inside the month", () => {
    const m = logisticsMarks("2026-02-10", null, [carrier("1", "2026-02-28"), carrier("2", "2026-03-01")], money);
    expect(m.map((x) => x.day)).toEqual([28]);
  });
});
