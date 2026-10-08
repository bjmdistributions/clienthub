import { describe, it, expect } from "vitest";
import type { FreightCarrier, RateMatch, RatesResponse } from "./api";
import {
  OPEN_LOAD_KEY, PAY_METHODS, UNDO_PAID_PATCH, canChangePaidOn, canEditCarriers, canPayCarriers, canRecordOn, canSeePayDetails, carrierByName, carrierFacts, carrierIds,
  carrierMatches, carrierPayCandidates, encodeOpenLoad, fillOffers, fillPatch, fillWouldChange, filterCarriers, laneEnds, lastRate, linkAmountCheck, linkAmountStart,
  normalName, offerSaveCarrier, parseOpenLoad, payDue, payMethodKey, payMethodLabel, queryText, rateOf, squashName, termsWord, toPaySummary, typedNumber,
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
    expect(canSeePayDetails(me(["logistics:view"]))).toBe(true);
    expect(canSeePayDetails(me(["deal_flow:view", "logistics:view"]))).toBe(false);
    expect(canSeePayDetails(me(["deal_flow:view", "deal_flow:edit"]))).toBe(false);
  });
  it("offers Link bank payment only on a booked, picked up or delivered load the viewer has the figures for", () => {
    const b = { status: "delivered" as const, can_see_deal: true, can_see_money: true };
    expect(canRecordOn(b, true)).toBe(true);
    expect(canRecordOn(b, false)).toBe(false);
    expect(canRecordOn({ ...b, status: "quoted" }, true)).toBe(false);
    expect(canRecordOn({ ...b, status: "requested" }, true)).toBe(false);
    expect(canRecordOn({ ...b, can_see_money: false }, true)).toBe(false);
    expect(canRecordOn({ ...b, can_see_deal: false }, true)).toBe(false);
  });
  it("lets the team take a payment back on a load of any status, but not a viewer without the figures (R-470)", () => {
    const b = { can_see_deal: true, can_see_money: true };
    expect(canChangePaidOn(b, true)).toBe(true);
    expect(canChangePaidOn(b, false)).toBe(false);
    expect(canChangePaidOn({ ...b, can_see_money: false }, true)).toBe(false);
    expect(canChangePaidOn({ ...b, can_see_deal: false }, true)).toBe(false);
  });
});

describe("taking back a typed payment", () => {
  it("undoes by clearing the amount and nothing else, and has no other paid write", () => {
    expect(UNDO_PAID_PATCH).toEqual({ paid_amount: null });
    expect(Object.keys(UNDO_PAID_PATCH)).toEqual(["paid_amount"]);
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
  it("reads the rows of the R-470 shape", () => {
    const rows = carrierPayCandidates({ candidates: [
      {
        txn_id: "t1", posted_at: "2026-10-05T00:00:00Z", txn_amount: 2000, unlinked: 1320, counterparty_name: "NORTHLINE FREIGHT",
        description: "ZELLE PAYMENT", method: "Zelle", reason: "amount matches", suggested_amount: 1320,
      },
    ] });
    expect(rows).toEqual([
      { txnId: "t1", day: "2026-10-05", amount: 2000, free: 1320, suggested: 1320, who: "NORTHLINE FREIGHT", memo: "ZELLE PAYMENT", method: "Zelle", reason: "amount matches" },
    ]);
  });
  it("reads the older suggestion shape too, and drops a row with no transaction", () => {
    const rows = carrierPayCandidates({ candidates: [
      { id: "t2", date: "2026-10-04", leg_amount: 1319.8, payee: "Northline", memo: "wire" },
      { amount: 5 },
    ] });
    expect(rows).toEqual([
      { txnId: "t2", day: "2026-10-04", amount: 1319.8, free: null, suggested: null, who: "Northline", memo: "wire", method: "", reason: "" },
    ]);
  });
  it("reads a bare list and an answer with nothing in it", () => {
    expect(carrierPayCandidates([{ txn_id: "t9", amount: 1 }]).map((r) => r.txnId)).toEqual(["t9"]);
    expect(carrierPayCandidates({})).toEqual([]);
    expect(carrierPayCandidates(null)).toEqual([]);
  });
});

describe("the amount to link (R-470)", () => {
  const row = (over: Partial<Parameters<typeof linkAmountStart>[0]> = {}) => ({ free: 2000, suggested: null, amount: 2000, ...over });
  it("opens with the server's suggestion", () => {
    expect(linkAmountStart(row({ suggested: 1320 }), 1500)).toBe(1320);
  });
  it("else the smaller of the money free and the carrier rate", () => {
    expect(linkAmountStart(row(), 1320.456)).toBe(1320.46);
    expect(linkAmountStart(row({ free: 900 }), 1320)).toBe(900);
    expect(linkAmountStart(row(), null)).toBe(2000);
    expect(linkAmountStart(row(), 0)).toBe(2000);
  });
  it("falls back to the row's amount when the free money is not known", () => {
    expect(linkAmountStart(row({ free: null }), 1500)).toBe(1500);
    expect(linkAmountStart(row({ free: null, amount: null }), 1500)).toBe(1500);
    expect(linkAmountStart(row({ free: null, amount: null }), null)).toBeNull();
  });
  it("takes more than $0 and at most the money free", () => {
    expect(linkAmountCheck("1,320.456", 2000)).toEqual({ amount: 1320.46 });
    expect(linkAmountCheck("$2000", 2000)).toEqual({ amount: 2000 });
    expect(linkAmountCheck("0.01", 2000)).toEqual({ amount: 0.01 });
  });
  it("refuses $0, a negative, a blank, text and too much, in plain sentences", () => {
    expect(linkAmountCheck("0", 2000)).toEqual({ error: "The amount must be more than $0." });
    expect(linkAmountCheck("0.00", 2000)).toEqual({ error: "The amount must be more than $0." });
    expect(linkAmountCheck("0.004", 2000)).toEqual({ error: "The amount must be more than $0." });
    expect(linkAmountCheck("-5", 2000)).toEqual({ error: "The amount must be more than $0." });
    expect(linkAmountCheck("", 2000)).toEqual({ error: "Add the amount to link." });
    expect(linkAmountCheck("abc", 2000)).toEqual({ error: "The amount must be a number." });
    expect(linkAmountCheck("2000.01", 2000)).toEqual({ error: "The amount cannot be more than the $2,000.00 free on this payment." });
    expect(linkAmountCheck("99999999", null)).toEqual({ error: "The amount is too large." });
  });
  it("does not cap the amount when the free money is not known", () => {
    expect(linkAmountCheck("5000", null)).toEqual({ amount: 5000 });
  });
});

describe("recognising a saved carrier from what was typed (R-471)", () => {
  const list = [
    carrier({ id: "c1", name: "Ridgeway Freight", mc_number: "MC-123456", dot_number: "7788990" }),
    carrier({ id: "c2", name: "Ridgeway Freight Lines", mc_number: "", dot_number: "" }),
    carrier({ id: "c3", name: "Harbor Lines", mc_number: "88123", dot_number: "4412", contact_name: " Dana Okoye ", phone: "555-0142", pay_method: "zelle", pay_terms_days: 30 }),
    carrier({ id: "c4", name: "A1", mc_number: "", dot_number: "" }),
  ];
  const ids = (typed: string) => carrierMatches(typed, list).map((c) => c.id);

  it("ignores case, spaces and punctuation in the name", () => {
    expect(squashName("  Ridge-way, FREIGHT. ")).toBe("ridgewayfreight");
    expect(ids("ridgeway freight")).toEqual(["c1"]);
    expect(ids("RIDGEWAY-FREIGHT")).toEqual(["c1"]);
    expect(ids("harbor  lines")).toEqual(["c3"]);
  });

  it("an exact name wins over longer names that start with it", () => {
    expect(ids("Ridgeway Freight")).toEqual(["c1"]);
  });

  it("matches a start of 3 or more characters, best name first", () => {
    expect(ids("Rid")).toEqual(["c1", "c2"]);
    expect(ids("harb")).toEqual(["c3"]);
  });

  it("offers nothing under 3 characters", () => {
    expect(ids("Ri")).toEqual([]);
    expect(ids("A1")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("  ")).toEqual([]);
  });

  it("matches a saved name that the typed text starts with", () => {
    expect(ids("Harbor Lines LLC")).toEqual(["c3"]);
    expect(ids("Ridgeway Freight Lines Inc")).toEqual(["c2", "c1"]);
  });

  it("matches an MC or a DOT number", () => {
    expect(ids("MC 123456")).toEqual(["c1"]);
    expect(ids(`mc${"#"}123456`)).toEqual(["c1"]);
    expect(ids("123456")).toEqual(["c1"]);
    expect(ids("DOT 4412")).toEqual(["c3"]);
    expect(ids("4412")).toEqual(["c3"]);
    expect(ids("MC 88123")).toEqual(["c3"]);
  });

  it("does not take a DOT number for an MC number or the other way round", () => {
    expect(ids("MC 4412")).toEqual([]);
    expect(ids("DOT 88123")).toEqual([]);
  });

  it("matches nothing for a name or number that is not saved", () => {
    expect(ids("Quarry Haulers")).toEqual([]);
    expect(ids("MC 999999")).toEqual([]);
    expect(carrierMatches("Ridgeway", null)).toEqual([]);
    expect(carrierMatches("Ridgeway", [])).toEqual([]);
  });

  it("returns two matches when two carriers share a name", () => {
    const twins = [carrier({ id: "x1", name: "Twin Haul" }), carrier({ id: "x2", name: "twin  haul" })];
    expect(carrierMatches("Twin Haul", twins).map((c) => c.id)).toEqual(["x1", "x2"]);
  });

  it("reads a typed number", () => {
    expect(typedNumber("MC 123456")).toEqual({ kind: "mc", digits: "123456" });
    expect(typedNumber(`DOT${"#"}7788990`)).toEqual({ kind: "dot", digits: "7788990" });
    expect(typedNumber("123-456")).toEqual({ kind: "any", digits: "123456" });
    expect(typedNumber("12")).toBeNull();
    expect(typedNumber("Acme 123456")).toBeNull();
  });

  describe("pressing the button", () => {
    const harbor = list[2];
    it("sets the carrier and its id", () => {
      expect(fillPatch(harbor, { delivered_at: "", pay_due_date: "" })).toEqual({ carrier: "Harbor Lines", carrier_id: "c3" });
    });
    it("sets the pay due date to the delivered day plus the terms, only when it is blank and delivered", () => {
      expect(fillPatch(harbor, { delivered_at: "2026-10-01", pay_due_date: "" })).toEqual({ carrier: "Harbor Lines", carrier_id: "c3", pay_due_date: "2026-10-31" });
      expect(fillPatch(harbor, { delivered_at: "2026-10-01", pay_due_date: "2026-10-20" }).pay_due_date).toBeUndefined();
      expect(fillPatch(harbor, { delivered_at: "", pay_due_date: "" }).pay_due_date).toBeUndefined();
      expect(fillPatch(list[0], { delivered_at: "2026-10-01", pay_due_date: "" }).pay_due_date).toBeUndefined();
    });
    it("counts a day carrying a time, and pay on delivery as the same day", () => {
      expect(fillPatch(harbor, { delivered_at: "2026-10-01T09:00:00Z", pay_due_date: "" }).pay_due_date).toBe("2026-10-31");
      expect(fillPatch(carrier({ id: "c9", name: "Cash Haul", pay_terms_days: 0 }), { delivered_at: "2026-10-01", pay_due_date: "" }).pay_due_date).toBe("2026-10-01");
    });
    it("rolls into the next month and year the way a calendar does", () => {
      expect(fillPatch(harbor, { delivered_at: "2026-12-15", pay_due_date: "" }).pay_due_date).toBe("2027-01-14");
    });
  });

  describe("when the button shows", () => {
    const harbor = list[2];
    const facts = { carrier: "harbor lines", carrier_id: "", delivered_at: "", pay_due_date: "" };
    it("shows for a typed name that is not yet the saved carrier", () => {
      expect(fillWouldChange(harbor, facts)).toBe(true);
      expect(fillOffers("harbor lines", list, facts).map((c) => c.id)).toEqual(["c3"]);
    });
    it("goes away once the load carries that carrier by name and id", () => {
      const done = { ...facts, carrier: "Harbor Lines", carrier_id: "c3" };
      expect(fillWouldChange(harbor, done)).toBe(false);
      expect(fillOffers("Harbor Lines", list, done)).toEqual([]);
    });
    it("stays when the load is delivered and the pay due date can still be filled", () => {
      const done = { carrier: "Harbor Lines", carrier_id: "c3", delivered_at: "2026-10-01", pay_due_date: "" };
      expect(fillWouldChange(harbor, done)).toBe(true);
      expect(fillWouldChange(harbor, { ...done, pay_due_date: "2026-10-31" })).toBe(false);
    });
    it("shows both matches for a chooser", () => {
      expect(fillOffers("Rid", list, { carrier: "Rid", carrier_id: "", delivered_at: "", pay_due_date: "" }).map((c) => c.id)).toEqual(["c1", "c2"]);
    });
    it("shows nothing for a name nobody saved", () => {
      expect(fillOffers("Quarry Haulers", list, { ...facts, carrier: "Quarry Haulers" })).toEqual([]);
    });
  });

  it("lists what a filled carrier shows on the load, leaving out what is empty", () => {
    expect(carrierFacts(list[2])).toEqual([
      { label: "MC and DOT", value: "MC 88123, DOT 4412" },
      { label: "Contact", value: "Dana Okoye" },
      { label: "Phone", value: "555-0142" },
      { label: "How they get paid", value: "Paid by Zelle, Net 30" },
    ]);
    expect(carrierFacts(list[3])).toEqual([]);
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
