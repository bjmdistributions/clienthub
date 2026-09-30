import { describe, it, expect } from "vitest";
import { isShippingLine, projectedCostOf, shippingChargedOf, shippingEstimateOf, supplierSideLegs } from "./format";

// R-400: the helpers every open-deal projection and the supplier stage rule read through.
describe("projectedCostOf", () => {
  it("reads projected_cost when the deal has one", () => {
    expect(projectedCostOf({ projected_cost: 7500, total_supplier_cost: 6500 })).toBe(7500);
  });
  it("falls back to total_supplier_cost for an older row", () => {
    expect(projectedCostOf({ total_supplier_cost: 6500 })).toBe(6500);
    expect(projectedCostOf({ projected_cost: null, total_supplier_cost: 6500 })).toBe(6500);
  });
  it("keeps a real zero", () => {
    expect(projectedCostOf({ projected_cost: 0, total_supplier_cost: 6500 })).toBe(0);
  });
});

describe("shippingEstimateOf", () => {
  it("is 0 when absent", () => {
    expect(shippingEstimateOf({})).toBe(0);
    expect(shippingEstimateOf({ shipping_estimate: 1500 })).toBe(1500);
  });
});

describe("supplierSideLegs", () => {
  const goods = { category: "supplier", paid: true };
  const freight = { category: "freight", paid: false };
  it("leaves freight out of the supplier leg", () => {
    expect(supplierSideLegs([goods, freight])).toEqual([goods]);
  });
  it("judges a deal with only freight lines on those lines", () => {
    expect(supplierSideLegs([freight])).toEqual([freight]);
  });
  it("treats a line with no category as goods", () => {
    const plain = { category: null, paid: true };
    expect(supplierSideLegs([plain, freight])).toEqual([plain]);
  });
  it("is empty for no lines", () => {
    expect(supplierSideLegs(null)).toEqual([]);
  });
});

// R-401: the add-supplier grid lists items only, by the R-255 rule.
describe("isShippingLine", () => {
  it("knows every shipping word, however it is spelled out", () => {
    for (const d of ["Shipping", "  FREIGHT ", "Shipping & Handling", "shipping and handling", "Delivery",
      "Shipping to Orlando, FL", "Freight surcharge"]) {
      expect(isShippingLine(d)).toBe(true);
    }
  });
  it("leaves goods alone, including words that only contain a shipping word", () => {
    for (const d of ["Pallet of mixed goods", "Ship-to deposit", "Overnight delivery bags", "Air freshener"]) {
      expect(isShippingLine(d)).toBe(false);
    }
  });
  it("counts a blank description, which names nothing to buy", () => {
    expect(isShippingLine("")).toBe(true);
    expect(isShippingLine("   ")).toBe(true);
    expect(isShippingLine(null)).toBe(true);
    expect(isShippingLine(undefined)).toBe(true);
  });
});

// R-401: what the invoice charged for shipping, the same way the pay rule reads it.
describe("shippingChargedOf", () => {
  const lines = (...l: object[]) => JSON.stringify(l);
  it("sums the shipping lines", () => {
    expect(shippingChargedOf(lines({ description: "Mixed pallets", qty: 10, rate: 100, amount: 1000 },
      { description: "Shipping", qty: 1, rate: 500, amount: 500 }), 0)).toEqual({ amount: 500, source: "lines" });
  });
  it("uses quantity times rate when a line has no stored amount", () => {
    expect(shippingChargedOf(lines({ description: "Freight", qty: 2, rate: 200, amount: 0 }), 0)).toEqual({ amount: 400, source: "lines" });
  });
  it("counts a description that starts with shipping, but not a blank or ship-to line", () => {
    expect(shippingChargedOf(lines({ description: "Shipping to Orlando, FL", qty: 1, rate: 300, amount: 300 }), 0).amount).toBe(300);
    expect(shippingChargedOf(lines({ description: "Ship-to deposit", qty: 1, rate: 300, amount: 300 },
      { description: "", qty: 1, rate: 50, amount: 50 }), 0)).toEqual({ amount: 0, source: "none" });
  });
  it("falls back to the invoice's own shipping charge, then to nothing", () => {
    expect(shippingChargedOf(lines({ description: "Goods", qty: 1, rate: 10, amount: 10 }), 250)).toEqual({ amount: 250, source: "field" });
    expect(shippingChargedOf("not json", null)).toEqual({ amount: 0, source: "none" });
  });
});
