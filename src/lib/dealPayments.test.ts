import { describe, it, expect } from "vitest";
import {
  PAYMENT_GROUPS, buyerLeg, canMoveDeal, canSeePayments, costNotEntered, groupPayments, groupSummary, hasAnyLoad, loadNumbersOf, money,
  paymentFiguresOf, paymentGroupOf, stillNeeded, supplierLeg, type PaymentEntry, type PaymentFigures, type PaymentGroup,
} from "./dealPayments";

// R-479: invented deals. A 10,000 invoice with 7,000 of supplier cost unless a case says otherwise.
const fig = (over: Partial<PaymentFigures> = {}): PaymentFigures => ({
  no_buyer_link: false, no_supplier_link: false, supplier_paid_paired: false, cost_kept: false,
  buyer_target: 10000, buyer_paired: 0, buyer_left: 10000,
  supplier_target: 7000, supplier_paired: 0, supplier_left: 7000,
  ...over,
});
const buyerPart = { buyer_paired: 4000, buyer_left: 6000 };
const buyerDone = { buyer_paired: 10000, buyer_left: 0 };
const supplierPart = { supplier_paired: 2000, supplier_left: 5000 };
const supplierDone = { supplier_paired: 7000, supplier_left: 0, supplier_paid_paired: true };

// The cases the website's grouping function is tested against too (www/app.js dfPaymentGroup), case for case.
const GROUP_CASES: [string, PaymentFigures, PaymentGroup][] = [
  ["nothing linked on either leg", fig(), "none"],
  ["buyer 4k of 10k, supplier none", fig(buyerPart), "buyer"],
  ["buyer full, supplier 2k of 7k", fig({ ...buyerDone, ...supplierPart }), "supplier"],
  ["buyer full, supplier none", fig(buyerDone), "supplier"],
  ["buyer none, supplier part", fig(supplierPart), "buyer"],
  ["both full", fig({ ...buyerDone, ...supplierDone }), "linked"],
  ["fee-only link: no buyer or supplier money, so it is not linked", fig(), "none"],
  ["both acknowledged, nothing linked", fig({ no_buyer_link: true, buyer_left: 0, no_supplier_link: true, supplier_left: 0 }), "linked"],
  ["buyer acknowledged, supplier none", fig({ no_buyer_link: true, buyer_left: 0 }), "none"],
  ["buyer full, no cost entered", fig({ ...buyerDone, supplier_target: 0, supplier_left: 0 }), "supplier"],
  ["buyer none, no cost entered", fig({ supplier_target: 0, supplier_left: 0 }), "none"],
  ["no cost entered, supplier acknowledged", fig({ ...buyerDone, supplier_target: 0, supplier_left: 0, no_supplier_link: true }), "linked"],
  ["goods resold away: the supplier leg is settled with nothing linked", fig({ ...buyerDone, supplier_target: 0, supplier_left: 0, supplier_paid_paired: true }), "linked"],
  ["sole supplier line kept, buyer fully linked: the cost is in and settled as kept", fig({ ...buyerDone, supplier_target: 0, supplier_left: 0, cost_kept: true }), "linked"],
  ["sole supplier line kept, buyer part paid", fig({ ...buyerPart, supplier_target: 0, supplier_left: 0, cost_kept: true }), "buyer"],
  ["sole supplier line kept, nothing linked yet", fig({ supplier_target: 0, supplier_left: 0, cost_kept: true }), "none"],
  ["one line kept and one still owed: the live line decides", fig({ ...buyerDone, supplier_target: 6000, supplier_left: 6000, cost_kept: true }), "supplier"],
  ["overpaid buyer counts as done", fig({ buyer_paired: 10100, buyer_left: 0, ...supplierDone }), "linked"],
  ["half a cent left on the buyer is not owed", fig({ buyer_paired: 9999.995, buyer_left: 0.005, ...supplierDone }), "linked"],
  ["within the route's 50 cent tolerance the buyer's left is already 0", fig({ buyer_paired: 9999.6, buyer_left: 0, ...supplierDone }), "linked"],
  ["supplier only, buyer acknowledged", fig({ no_buyer_link: true, buyer_left: 0, ...supplierPart }), "supplier"],
];

describe("paymentGroupOf", () => {
  for (const [name, f, want] of GROUP_CASES) {
    it(name, () => expect(paymentGroupOf(f)).toBe(want));
  }
  it("covers every group the view shows", () => {
    const seen = new Set(GROUP_CASES.map((c) => c[2]));
    for (const g of PAYMENT_GROUPS) expect(seen.has(g.key)).toBe(true);
  });
});

describe("costNotEntered", () => {
  it("is true when no cost is in and nothing says the leg is settled", () => {
    expect(costNotEntered(fig({ supplier_target: 0, supplier_left: 0 }))).toBe(true);
  });
  it("is false once the cost is in, or the leg is acknowledged, or settled", () => {
    expect(costNotEntered(fig())).toBe(false);
    expect(costNotEntered(fig({ supplier_target: 0, supplier_left: 0, no_supplier_link: true }))).toBe(false);
    expect(costNotEntered(fig({ supplier_target: 0, supplier_left: 0, supplier_paid_paired: true }))).toBe(false);
  });
  it("is false when the only cost was kept: it was entered, then settled as kept", () => {
    expect(costNotEntered(fig({ supplier_target: 0, supplier_left: 0, cost_kept: true }))).toBe(false);
  });
});

describe("the row wording", () => {
  it("buyer: none, partial, done, acknowledged", () => {
    expect(buyerLeg(fig(), false)).toEqual({ text: "Buyer: nothing linked, $10,000 due", note: "", tone: "owed" });
    expect(buyerLeg(fig(buyerPart), false).text).toBe("Buyer: $4,000 of $10,000 linked, $6,000 due");
    expect(buyerLeg(fig(buyerDone), false)).toEqual({ text: "Buyer: $10,000 linked", note: "", tone: "done" });
    expect(buyerLeg(fig({ no_buyer_link: true, buyer_left: 0 }), false)).toEqual({ text: "Buyer: no bank record", note: "", tone: "quiet" });
  });
  it("supplier: none, partial, done, acknowledged, cost not entered", () => {
    expect(supplierLeg(fig())).toEqual({ text: "Supplier: nothing linked, $7,000 to pay", note: "", tone: "owed" });
    expect(supplierLeg(fig(supplierPart)).text).toBe("Supplier: $2,000 of $7,000 linked, $5,000 to pay");
    expect(supplierLeg(fig(supplierDone))).toEqual({ text: "Supplier: $7,000 linked", note: "", tone: "done" });
    expect(supplierLeg(fig({ no_supplier_link: true, supplier_left: 0 }))).toEqual({ text: "Supplier: no bank record", note: "", tone: "quiet" });
    expect(supplierLeg(fig({ supplier_target: 0, supplier_left: 0 }))).toEqual({ text: "Supplier: cost not entered yet", note: "", tone: "owed" });
  });
  it("a cost that was all kept reads as kept, nothing to pay, and not as an owed line", () => {
    expect(supplierLeg(fig({ supplier_target: 0, supplier_left: 0, cost_kept: true }))).toEqual({ text: "Supplier: kept, nothing to pay", note: "", tone: "quiet" });
    // The website reads a kept cost ahead of the no-bank-record note.
    expect(supplierLeg(fig({ supplier_target: 0, supplier_left: 0, cost_kept: true, no_supplier_link: true })).text).toBe("Supplier: kept, nothing to pay");
    // A kept line beside a live one still owed: the live line shows, never "kept".
    expect(supplierLeg(fig({ cost_kept: true }))).toEqual({ text: "Supplier: nothing linked, $7,000 to pay", note: "", tone: "owed" });
  });
  it("a goods leg resold away reads as nothing to pay", () => {
    expect(supplierLeg(fig({ supplier_target: 0, supplier_left: 0, supplier_paid_paired: true })).text).toBe("Supplier: nothing to pay");
  });
  it("keeps cents when the amount has them", () => {
    expect(buyerLeg(fig({ buyer_paired: 4000.5, buyer_left: 5999.5 }), false).text).toBe("Buyer: $4,000.50 of $10,000 linked, $5,999.50 due");
    expect(money(12)).toBe("$12");
    expect(money(0.5)).toBe("$0.50");
  });
  it("adds the quiet suffix only when the stage says paid and the bank link is short", () => {
    expect(buyerLeg(fig(buyerPart), true).note).toBe("marked paid, not linked to a bank payment");
    expect(buyerLeg(fig(), true).note).toBe("marked paid, not linked to a bank payment");
    expect(buyerLeg(fig(buyerDone), true).note).toBe("");
    expect(buyerLeg(fig({ no_buyer_link: true, buyer_left: 0 }), true).note).toBe("");
  });
});

describe("groupPayments", () => {
  const entry = (id: string, f: PaymentFigures, since = "2026-09-01"): PaymentEntry<string> => ({ item: id, figures: f, since });
  it("returns the four groups in order, even when empty", () => {
    const g = groupPayments<string>([]);
    expect(g.map((x) => x.title)).toEqual(["No payments yet", "Waiting on the buyer", "Supplier to pay", "All linked"]);
    expect(g.every((x) => x.entries.length === 0)).toBe(true);
  });
  it("puts each deal in one group and sorts the most still needed first, then the oldest invoice", () => {
    const g = groupPayments([
      entry("small", fig({ buyer_target: 2000, buyer_left: 2000, supplier_target: 1000, supplier_left: 1000 })),
      entry("big", fig({ buyer_target: 30000, buyer_left: 30000, supplier_target: 20000, supplier_left: 20000 })),
      entry("tieNew", fig(), "2026-09-20"),
      entry("tieOld", fig(), "2026-09-02"),
      entry("part", fig(buyerPart)),
      entry("done", fig({ ...buyerDone, ...supplierDone })),
    ]);
    const byKey = Object.fromEntries(g.map((x) => [x.key, x.entries.map((e) => e.item)]));
    expect(byKey.none).toEqual(["big", "tieOld", "tieNew", "small"]);
    expect(byKey.buyer).toEqual(["part"]);
    expect(byKey.supplier).toEqual([]);
    expect(byKey.linked).toEqual(["done"]);
    expect(g.reduce((n, x) => n + x.entries.length, 0)).toBe(6);
  });
  it("sums what is still needed in each direction", () => {
    const g = groupPayments([entry("a", fig(buyerPart)), entry("b", fig({ buyer_target: 5000, buyer_paired: 1000, buyer_left: 4000 }))]);
    const buyer = g.find((x) => x.key === "buyer")!;
    expect(buyer.buyerDue).toBe(10000);
    expect(buyer.supplierDue).toBe(14000);
    expect(stillNeeded(fig(buyerPart))).toBe(13000);
  });
  it("words a header with the count and what is due", () => {
    const g = groupPayments([entry("a", fig(buyerPart)), entry("b", fig(buyerPart))]);
    expect(groupSummary(g.find((x) => x.key === "buyer")!)).toBe("2 deals, $12,000 due from buyers, $14,000 to pay suppliers");
    expect(groupSummary(g.find((x) => x.key === "linked")!)).toBe("0 deals");
    const one = groupPayments([entry("c", fig({ ...buyerDone, ...supplierPart }))]).find((x) => x.key === "supplier")!;
    expect(groupSummary(one)).toBe("1 deal, $5,000 to pay suppliers");
  });
});

describe("paymentFiguresOf", () => {
  it("reads a full status row", () => {
    const f = paymentFiguresOf({ buyer_target: 10000, buyer_paired: 0, buyer_left: 10000, supplier_target: 7000, supplier_paired: 0, supplier_left: 7000, no_buyer_link: false });
    expect(f && paymentGroupOf(f)).toBe("none");
    expect(f?.cost_kept).toBe(false);
  });
  it("carries the kept flag, and reads an older answer without it as not kept", () => {
    const six = { buyer_target: 10000, buyer_paired: 10000, buyer_left: 0, supplier_target: 0, supplier_paired: 0, supplier_left: 0 };
    expect(paymentGroupOf(paymentFiguresOf({ ...six, cost_kept: true })!)).toBe("linked");
    expect(paymentGroupOf(paymentFiguresOf(six)!)).toBe("supplier");
  });
  it("is null for a missing row or an older answer without the six keys, so it is never read as nothing owed", () => {
    expect(paymentFiguresOf(undefined)).toBeNull();
    expect(paymentFiguresOf({ payment_received_paired: true })).toBeNull();
    expect(paymentFiguresOf({ buyer_target: 1, buyer_paired: 1, buyer_left: 0, supplier_target: 1, supplier_paired: 1 })).toBeNull();
    expect(paymentFiguresOf({ buyer_target: NaN, buyer_paired: 1, buyer_left: 0, supplier_target: 1, supplier_paired: 1, supplier_left: 0 })).toBeNull();
  });
});

describe("who sees the Payments view and who can move a load", () => {
  it("shows to an admin and to someone with the dollar switch, not to anyone else", () => {
    expect(canSeePayments({ permissions: ["*"] })).toBe(true);
    expect(canSeePayments({ permissions: ["deal_flow:view", "deal_flow:view_numbers"] })).toBe(true);
    expect(canSeePayments({ permissions: ["deal_flow:view", "deal_flow:edit"] })).toBe(false);
    expect(canSeePayments(null)).toBe(false);
  });
  it("Move to Logistics is for a deal with no load that does not ship direct", () => {
    expect(canMoveDeal({})).toBe(true);
    expect(canMoveDeal({ logistics_bookings: 0, logistics_stage: "", load_numbers: "" })).toBe(true);
    expect(canMoveDeal({ ships_direct: true })).toBe(false);
    expect(canMoveDeal({ logistics_bookings: 1 })).toBe(false);
    expect(canMoveDeal({ logistics_stage: "quote" })).toBe(false);
    expect(canMoveDeal({ load_numbers: "LD-0101" })).toBe(false);
    expect(hasAnyLoad({ load_numbers: "  " })).toBe(false);
  });
  it("splits the load numbers", () => {
    expect(loadNumbersOf({ load_numbers: "LD-0101 LD-0102" })).toEqual(["LD-0101", "LD-0102"]);
    expect(loadNumbersOf({})).toEqual([]);
  });
});
