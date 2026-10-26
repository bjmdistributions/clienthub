import { describe, it, expect } from "vitest";
import { legOf, payChoice, rowMatches, supplierFirst } from "./buyPay";

// Invented rows and amounts, never a real one.
const row = (over: Partial<{ counterparty_name: string; description: string; amount: number; unallocated: number; posted_at: string }> = {}) => ({
  counterparty_name: "Sample Apparel Co", description: "WIRE OUT SAMPLE APPAREL", amount: 12500, unallocated: 12500, posted_at: "2026-10-02", ...over,
});

describe("payChoice mirrors buy_core::pay_take", () => {
  it("books a deposit and then the final payment with no question", () => {
    expect(payChoice(50000, 0, 10000)).toEqual({ kind: "plain", books: 10000 });
    expect(payChoice(50000, 10000, 40000)).toEqual({ kind: "plain", books: 40000 });
  });
  it("with no cost typed the cost becomes what was paid", () => {
    expect(payChoice(0, 0, 10000)).toEqual({ kind: "plain", books: 10000, raisesTo: 10000 });
  });
  it("asks when the payment is past what is left, and offers only all of it once paid in full", () => {
    expect(payChoice(50000, 45000, 12000)).toEqual({ kind: "ask", room: 12000, left: 5000, raisesTo: 57000 });
    expect(payChoice(10000, 10000, 40000)).toEqual({ kind: "ask", room: 40000, left: 0, raisesTo: 50000 });
  });
  it("has nothing to book when nothing on the row is free", () => {
    expect(payChoice(50000, 0, 0.004)).toEqual({ kind: "none" });
  });
  it("reads either leg", () => {
    const r = { goods_total: 100, goods_paid: 40, ship_total: 20, ship_paid: 0 };
    expect(legOf(r, "goods")).toEqual({ total: 100, paid: 40 });
    expect(legOf(r, "ship")).toEqual({ total: 20, paid: 0 });
  });
});

describe("the bank picker's search", () => {
  it("reads an amount typed with $ and commas", () => {
    expect(rowMatches(["$12,500"], row())).toBe(true);
    expect(rowMatches(["12,500.00"], row())).toBe(true);
    expect(rowMatches(["12500"], row())).toBe(true);
    expect(rowMatches(["$12,6"], row())).toBe(false);
  });
  it("matches what is left of a part-booked row", () => {
    expect(rowMatches(["2,500"], row({ unallocated: 2500 }))).toBe(true);
  });
  it("matches words and dates", () => {
    expect(rowMatches(["sample", "2026-10"], row())).toBe(true);
    expect(rowMatches(["other"], row())).toBe(false);
  });
});

describe("supplierFirst", () => {
  it("puts the rows that name the buy's supplier first and keeps the rest in order", () => {
    const rows = [row({ counterparty_name: "Fuel Stop", description: "CARD" }), row(), row({ counterparty_name: "Payroll", description: "ACH" })];
    expect(supplierFirst(rows, "Sample Apparel Co, LLC").map((r) => r.counterparty_name)).toEqual(["Sample Apparel Co", "Fuel Stop", "Payroll"]);
    expect(supplierFirst(rows, "")).toEqual(rows);
    const shared = [row({ counterparty_name: "Sample Fuel Stop", description: "CARD" }), row({ counterparty_name: "", description: "WIRE OUT SAMPLE APPAREL CO" })];
    expect(supplierFirst(shared, "Sample Apparel Co")[0].description).toBe("WIRE OUT SAMPLE APPAREL CO");
  });
});
