import { describe, it, expect } from "vitest";
import { tieAmount } from "./tieAmount";

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

  it("takes the whole remainder when there is no candidate", () => {
    expect(tieAmount("buyer_payment", 50000, undefined)).toEqual({ amount: 50000, book: true });
    expect(tieAmount("buyer_payment", 50000, null)).toEqual({ amount: 50000, book: true });
  });

  it("takes the whole remainder when the leg is 0 (nothing outstanding to cap by)", () => {
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

  it("takes the whole remainder with no candidate", () => {
    expect(tieAmount("supplier_payment", 7000, undefined)).toEqual({ amount: 7000, book: true });
  });
});
