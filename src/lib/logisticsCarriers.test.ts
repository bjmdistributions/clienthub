import { describe, it, expect } from "vitest";
import type { FreightCarrier, RateMatch, RatesResponse } from "./api";
import {
  OPEN_LOAD_KEY, PAY_METHODS, UNDO_PAID_PATCH, canEditCarriers, canPayCarriers, canRecordOn, canSeePayDetails, carrierByName, carrierIds,
  carrierPayCandidates, encodeOpenLoad, filterCarriers, laneEnds, lastRate, markPaidDefaults, markPaidPatch, normalName, offerSaveCarrier,
  parseOpenLoad, payDue, payMethodKey, payMethodLabel, queryText, rateOf, termsWord, toPaySummary,
} from "./logisticsCarriers";

const carrier = (over: Partial<FreightCarrier> = {}): FreightCarrier => ({
  id: "c1", name: "Ridgeway Freight", mc_number: "", dot_number: "", contact_name: "", phone: "", email: "", address: "",
  pay_method: "", pay_terms_days: null, notes: "", load_count: 0, last_used: "", last_rate: null, ...over,
});
const match = (over: Partial<RateMatch> = {}): RateMatch => ({
  booking_id: "b1", load_number: "LD-0004", day: "2026-09-12", carrier: "Ridgeway Freight", carrier_id: "c1", rate: 1850, quote_amount: null,
  paid: true, equipment: "Dry van 53 ft", pallets: "6", weight_lbs: "5400", exact: true, ...over,
});
const rates = (over: Partial<RatesResponse> = {}): RatesResponse => ({
  lane: { from: "Dallas, TX", to: "Newark, NJ" }, last: match(), matches: [match()], ...over,
});

describe("how a carrier gets paid", () => {
  it("has the six methods the contract names, in order", () => {
    expect(PAY_METHODS.map((m) => m.key)).toEqual(["zelle", "wire", "ach", "credit_card", "check", "other"]);
    expect(PAY_METHODS.map((m) => m.label)).toEqual(["Zelle", "Wire", "ACH", "Credit card", "Check", "Other"]);
  });
  it("reads a key as its label and a label as its key", () => {
    expect(payMethodLabel("credit_card")).toBe("Credit card");
    expect(payMethodLabel("")).toBe("");
    expect(payMethodLabel("barter")).toBe("");
    expect(payMethodKey("Credit card")).toBe("credit_card");
    expect(payMethodKey(" ZELLE ")).toBe("zelle");
    expect(payMethodKey("Card, ACH, check")).toBe("");
  });
});

describe("query text for the Logistics bridge", () => {
  it("has no spaces and no percent signs", () => {
    expect(queryText("Dallas, TX")).toBe("Dallas,+TX");
    expect(queryText("  St. Mary's   Point, MN ")).toBe("St.+Mary's+Point,+MN");
    expect(queryText("AT&T 100% #1")).toBe("ATT+100+1");
    expect(queryText("")).toBe("");
  });
  it("reads the two ends of a lane from free-text addresses", () => {
    expect(laneEnds("410 Mercer Ave, Northgate, OH 44120", "12 Shore Rd, Lakeside, MI 49001")).toEqual({ pickup: "Northgate, OH", delivery: "Lakeside, MI" });
    expect(laneEnds("Dallas TX", "Newark, NJ")).toEqual({ pickup: "Dallas, TX", delivery: "Newark, NJ" });
  });
  it("waits until both ends read as a place", () => {
    expect(laneEnds("410 Mercer Ave", "12 Shore Rd, Lakeside, MI")).toBeNull();
    expect(laneEnds("", "")).toBeNull();
  });
});

describe("the carrier picker", () => {
  const list = [carrier(), carrier({ id: "c2", name: "Harbor Lines", mc_number: "88123" }), carrier({ id: "c3", name: "North Harbor Express", dot_number: "4412" })];
  it("compares names the way the server does", () => {
    expect(normalName("  Ridgeway   FREIGHT. ")).toBe("ridgeway freight");
    expect(carrierByName("ridgeway freight", list)?.id).toBe("c1");
    expect(carrierByName("Ridgeway", list)).toBeNull();
    expect(carrierByName("", list)).toBeNull();
  });
  it("narrows by name, MC or DOT, names that start with the text first", () => {
    expect(filterCarriers(list, "harbor").map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(filterCarriers(list, "88123").map((c) => c.id)).toEqual(["c2"]);
    expect(filterCarriers(list, "4412").map((c) => c.id)).toEqual(["c3"]);
    expect(filterCarriers(list, "").length).toBe(3);
    expect(filterCarriers(list, "", 2).length).toBe(2);
  });
  it("offers Save to carriers only for a name nobody has saved", () => {
    expect(offerSaveCarrier("Brightline Hauling", list)).toBe(true);
    expect(offerSaveCarrier("ridgeway freight", list)).toBe(false);
    expect(offerSaveCarrier("   ", list)).toBe(false);
    expect(offerSaveCarrier("Brightline Hauling", null)).toBe(false);
  });
  it("writes MC and DOT and the terms in words", () => {
    expect(carrierIds(carrier({ mc_number: "123456", dot_number: "7890" }))).toBe("MC 123456, DOT 7890");
    expect(carrierIds(carrier({ dot_number: "7890" }))).toBe("DOT 7890");
    expect(carrierIds(carrier())).toBe("");
    expect(termsWord(30)).toBe("Net 30");
    expect(termsWord(0)).toBe("Pay on delivery");
    expect(termsWord(null)).toBe("");
  });
});

describe("the rate popup", () => {
  const now = new Date(2026, 9, 6);
  it("says who carried it last, at what, and when", () => {
    const r = lastRate(rates(), now)!;
    expect(r.lead).toBe("Last time on Dallas, TX to Newark, NJ:");
    expect(r.carrier).toBe("Ridgeway Freight");
    expect(r.carrierId).toBe("c1");
    expect(r.tail).toBe("at $1,850.00 (Sep 12)");
  });
  it("falls back to the quote when nothing was paid", () => {
    expect(rateOf(match({ rate: null, quote_amount: 1700 }))).toBe(1700);
    expect(rateOf(match({ rate: 1850, quote_amount: 1700 }))).toBe(1850);
    expect(rateOf(match({ rate: null, quote_amount: null }))).toBeNull();
  });
  it("leaves the figure out for someone who may not see money, and the lane out without addresses", () => {
    const r = lastRate(rates({ lane: { from: "", to: "" }, last: match({ rate: null, quote_amount: null }) }), now)!;
    expect(r.lead).toBe("Last time on this lane:");
    expect(r.tail).toBe("(Sep 12)");
  });
  it("says a same-states match is not the exact lane", () => {
    expect(lastRate(rates({ last: match({ exact: false }) }), now)!.lead).toContain("Nothing on this exact lane");
  });
  it("is null with no history, so the screen can say there are no past loads", () => {
    expect(lastRate(rates({ last: null, matches: [] }))).toBeNull();
    expect(lastRate(null)).toBeNull();
    expect(lastRate(rates({ last: null }), now)?.carrier).toBe("Ridgeway Freight");
  });
});

describe("who may pay carriers", () => {
  const me = (permissions: string[]) => ({ permissions });
  it("lets an admin and a deal editor with the dollar switch", () => {
    expect(canPayCarriers(me(["*"]))).toBe(true);
    expect(canPayCarriers(me(["admin:manage"]))).toBe(true);
    expect(canPayCarriers(me(["deal_flow:view", "deal_flow:view_numbers", "deal_flow:edit"]))).toBe(true);
  });
  it("refuses everyone missing one of the three", () => {
    expect(canPayCarriers(me(["deal_flow:view", "deal_flow:edit"]))).toBe(false);
    expect(canPayCarriers(me(["deal_flow:view", "deal_flow:view_numbers"]))).toBe(false);
    expect(canPayCarriers(me(["deal_flow:view_numbers", "deal_flow:edit"]))).toBe(false);
    expect(canPayCarriers(null)).toBe(false);
  });
  it("never lets a Logistics-only account near the carrier-pay routes", () => {
    expect(canPayCarriers(me(["logistics:view", "logistics:edit", "deal_flow:view_numbers"]))).toBe(false);
  });
  it("lets the logistics edit switch change carriers and the dollar switch see how they are paid", () => {
    expect(canEditCarriers(me(["logistics:view", "logistics:edit"]))).toBe(true);
    expect(canEditCarriers(me(["logistics:view"]))).toBe(false);
    expect(canSeePayDetails(me(["logistics:view", "deal_flow:view_numbers"]))).toBe(true);
    expect(canSeePayDetails(me(["logistics:view"]))).toBe(false);
  });
  it("offers Mark paid only on a booked, picked up or delivered load the viewer has the figures for", () => {
    const b = { status: "delivered" as const, can_see_deal: true, can_see_money: true };
    expect(canRecordOn(b, true)).toBe(true);
    expect(canRecordOn(b, false)).toBe(false);
    expect(canRecordOn({ ...b, status: "quoted" }, true)).toBe(false);
    expect(canRecordOn({ ...b, status: "requested" }, true)).toBe(false);
    expect(canRecordOn({ ...b, can_see_money: false }, true)).toBe(false);
    expect(canRecordOn({ ...b, can_see_deal: false }, true)).toBe(false);
  });
});

describe("Mark paid", () => {
  it("opens with the carrier rate, today and the carrier's method", () => {
    expect(markPaidDefaults({ rate: 1320, pay_method: "zelle" }, "2026-10-06")).toEqual({ amount: "1320", paidAt: "2026-10-06", method: "Zelle", note: "" });
    expect(markPaidDefaults({ rate: null, pay_method: "" }, "2026-10-06")).toEqual({ amount: "", paidAt: "2026-10-06", method: "", note: "" });
  });
  it("writes the four paid fields", () => {
    const r = markPaidPatch({ amount: "$1,320.456", paidAt: "2026-10-06", method: " Zelle ", note: " ref 4471 " });
    expect(r).toEqual({ patch: { paid_amount: 1320.46, paid_at: "2026-10-06", paid_method: "Zelle", paid_note: "ref 4471" } });
  });
  it("accepts zero, which is an exact figure, and refuses what is not a figure", () => {
    expect("patch" in markPaidPatch({ amount: "0", paidAt: "2026-10-06", method: "", note: "" })).toBe(true);
    expect(markPaidPatch({ amount: "", paidAt: "2026-10-06", method: "", note: "" })).toEqual({ error: "Add the amount paid." });
    expect(markPaidPatch({ amount: "abc", paidAt: "2026-10-06", method: "", note: "" })).toEqual({ error: "The amount paid must be a number." });
    expect(markPaidPatch({ amount: "-5", paidAt: "2026-10-06", method: "", note: "" })).toEqual({ error: "The amount paid cannot be less than zero." });
    expect(markPaidPatch({ amount: "20000000", paidAt: "2026-10-06", method: "", note: "" })).toEqual({ error: "The amount paid is too large." });
    expect(markPaidPatch({ amount: "10", paidAt: "", method: "", note: "" })).toEqual({ error: "Add the day it was paid." });
  });
  it("undoes by clearing the amount and nothing else", () => {
    expect(UNDO_PAID_PATCH).toEqual({ paid_amount: null });
  });
});

describe("what is due", () => {
  const today = "2026-10-06";
  it("says it the way every screen does", () => {
    expect(payDue({ pay_due_date: "2026-10-06" }, today)).toEqual({ label: "Due today", tone: "danger" });
    expect(payDue({ pay_due_date: "2026-10-03" }, today)).toEqual({ label: "Overdue since Oct 3", tone: "danger" });
    expect(payDue({ pay_due_date: "2026-10-10" }, today)).toEqual({ label: "Due Oct 10", tone: "warning" });
    expect(payDue({ pay_due_date: "2026-11-10" }, today).tone).toBe("neutral");
    expect(payDue({ pay_due_date: "" }, today)).toEqual({ label: "No due date", tone: "neutral" });
  });
  it("sums a section: how many, how many late, what they add up to, how many have no rate", () => {
    const s = toPaySummary([
      { pay_due_date: "2026-10-03", rate: 1200 }, { pay_due_date: "2026-10-06", rate: 300.5 },
      { pay_due_date: "2026-10-20", rate: 900 }, { pay_due_date: "", rate: null },
    ], today);
    expect(s).toEqual({ count: 4, late: 2, total: 2400.5, noRate: 1 });
  });
});

describe("the bank candidates", () => {
  it("reads the rows of the suggestion shape", () => {
    const rows = carrierPayCandidates({ candidates: [
      { txn_id: "t1", posted_at: "2026-10-05T00:00:00Z", amount: 1320, counterparty_name: "NORTHLINE FREIGHT", description: "ZELLE PAYMENT", reason: "amount matches" },
      { id: "t2", date: "2026-10-04", leg_amount: 1319.8, payee: "Northline", memo: "wire" },
      { amount: 5 },
    ] });
    expect(rows).toEqual([
      { txnId: "t1", day: "2026-10-05", amount: 1320, who: "NORTHLINE FREIGHT", memo: "ZELLE PAYMENT", reason: "amount matches" },
      { txnId: "t2", day: "2026-10-04", amount: 1319.8, who: "Northline", memo: "wire", reason: "" },
    ]);
  });
  it("reads a bare list and an answer with nothing in it", () => {
    expect(carrierPayCandidates([{ txn_id: "t9", amount: 1 }]).map((r) => r.txnId)).toEqual(["t9"]);
    expect(carrierPayCandidates({})).toEqual([]);
    expect(carrierPayCandidates(null)).toEqual([]);
  });
});

describe("opening a load from another screen", () => {
  it("round-trips a load and the step to open", () => {
    expect(OPEN_LOAD_KEY).toBe("logistics_open_load");
    expect(parseOpenLoad(encodeOpenLoad("fb_7", "pay"))).toEqual({ id: "fb_7", step: "pay" });
    expect(parseOpenLoad(encodeOpenLoad("fb_7"))).toEqual({ id: "fb_7" });
  });
  it("reads a bare id and refuses junk and an unknown step", () => {
    expect(parseOpenLoad("fb_7")).toEqual({ id: "fb_7" });
    expect(parseOpenLoad(JSON.stringify({ id: "fb_7", step: "paperwork" }))).toEqual({ id: "fb_7" });
    expect(parseOpenLoad("{not json")).toBeNull();
    expect(parseOpenLoad(JSON.stringify({ step: "pay" }))).toBeNull();
    expect(parseOpenLoad("")).toBeNull();
    expect(parseOpenLoad(null)).toBeNull();
  });
});
