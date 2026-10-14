import { describe, it, expect } from "vitest";
import { alreadyTied, tieAmount } from "./tieAmount";

// FD-05: invented figures. A buyer wire of 50,000 suggested against the first of two invoices.
describe("tieAmount, buyer payments", () => {
  it("ties the whole remainder when it equals the leg, and books it", () => {
    expect(tieAmount("buyer_payment", 20000, 20000)).toEqual({ amount: 20000, book: true });
  });

  it("ties the whole remainder when it is below the leg (a part payment), and books it", () => {
    expect(tieAmount("buyer_payment", 8000, 20000)).toEqual({ amount: 8000, book: true });
  });

  it("takes a remainder up to 50 cents over the leg whole, and books it", () => {
    expect(tieAmount("buyer_payment", 20000.4, 20000)).toEqual({ amount: 20000.4, book: true });
    expect(tieAmount("buyer_payment", 20000.5, 20000)).toEqual({ amount: 20000.5, book: true });
  });

  it("caps at the leg and does not book when the remainder is over the leg by more than 50 cents", () => {
    expect(tieAmount("buyer_payment", 50000, 20000)).toEqual({ amount: 20000, book: false });
    expect(tieAmount("buyer_payment", 20000.51, 20000)).toEqual({ amount: 20000, book: false });
  });

  it("takes the whole remainder when there is no candidate and no invoice total to cap by", () => {
    expect(tieAmount("buyer_payment", 50000, undefined)).toEqual({ amount: 50000, book: true });
    expect(tieAmount("buyer_payment", 50000, null)).toEqual({ amount: 50000, book: true });
    expect(tieAmount("buyer_payment", 50000, undefined, 0)).toEqual({ amount: 50000, book: true });
  });

  it("with no candidate (offline matcher) caps at the deal's invoice total and does not book", () => {
    expect(tieAmount("buyer_payment", 50000, undefined, 20000)).toEqual({ amount: 20000, book: false });
    expect(tieAmount("buyer_payment", 50000, null, 30000)).toEqual({ amount: 30000, book: false });
  });

  it("with no candidate, a remainder at or under the invoice total (or 50 cents over) is tied whole and booked", () => {
    expect(tieAmount("buyer_payment", 20000, undefined, 20000)).toEqual({ amount: 20000, book: true });
    expect(tieAmount("buyer_payment", 8000, undefined, 20000)).toEqual({ amount: 8000, book: true });
    expect(tieAmount("buyer_payment", 20000.5, undefined, 20000)).toEqual({ amount: 20000.5, book: true });
  });

  it("a candidate's own leg wins over the invoice total", () => {
    expect(tieAmount("buyer_payment", 50000, 12000, 30000)).toEqual({ amount: 12000, book: false });
  });

  it("a candidate with nothing outstanding (leg 0) falls back to the invoice total as the cap", () => {
    expect(tieAmount("buyer_payment", 50000, 0, 20000)).toEqual({ amount: 20000, book: false });
  });

  it("takes the whole remainder when the leg is 0 and the deal has no invoice total", () => {
    expect(tieAmount("buyer_payment", 50000, 0)).toEqual({ amount: 50000, book: true });
  });
});

describe("tieAmount, supplier and shipping legs keep their cap", () => {
  it("caps a supplier payment at the leg and leaves the row unbooked", () => {
    expect(tieAmount("supplier_payment", 50000, 20000)).toEqual({ amount: 20000, book: false });
  });

  it("caps a supplier payment even a few cents over the leg (unchanged)", () => {
    expect(tieAmount("supplier_payment", 20000.3, 20000)).toEqual({ amount: 20000, book: false });
  });

  it("caps a shipping payment at the leg", () => {
    expect(tieAmount("shipping", 3000, 1800)).toEqual({ amount: 1800, book: false });
  });

  it("books a supplier payment when the leg covers the row", () => {
    expect(tieAmount("supplier_payment", 7000, 7000)).toEqual({ amount: 7000, book: true });
    expect(tieAmount("supplier_payment", 5000, 7000)).toEqual({ amount: 5000, book: true });
  });

  it("takes the whole remainder with no candidate, and ignores the invoice total (a buyer-side figure)", () => {
    expect(tieAmount("supplier_payment", 7000, undefined)).toEqual({ amount: 7000, book: true });
    expect(tieAmount("supplier_payment", 7000, undefined, 3000)).toEqual({ amount: 7000, book: true });
    expect(tieAmount("shipping", 7000, undefined, 3000)).toEqual({ amount: 7000, book: true });
  });
});

// The partial-tie follow-up: $50,000 wire, deal A's leg 20,000. After the first tap A holds 20,000
// and the cached suggestion for A is stale, so a second tap on it must not be offered.
describe("alreadyTied", () => {
  const links = [{ deal_id: "A", role: "buyer_payment", amount: 20000 }];

  it("is true for the deal and role the row is already linked to", () => {
    expect(alreadyTied(links, "A", "buyer_payment")).toBe(true);
  });

  it("is false for a different deal, so the other invoice's chip stays", () => {
    expect(alreadyTied(links, "B", "buyer_payment")).toBe(false);
  });

  it("is false for the same deal under another role", () => {
    expect(alreadyTied(links, "A", "refund_in")).toBe(false);
  });

  it("is false for a row with no links", () => {
    expect(alreadyTied(undefined, "A", "buyer_payment")).toBe(false);
    expect(alreadyTied([], "A", "buyer_payment")).toBe(false);
  });

  it("only guards the buyer role: a deal can have two unpaid supplier legs, each its own tie", () => {
    const sup = [{ deal_id: "A", role: "supplier_payment", amount: 7000 }];
    expect(alreadyTied(sup, "A", "supplier_payment")).toBe(false);
    const ship = [{ deal_id: "A", role: "shipping", amount: 900 }];
    expect(alreadyTied(ship, "A", "shipping")).toBe(false);
  });
});
