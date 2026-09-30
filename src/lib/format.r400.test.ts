import { describe, it, expect } from "vitest";
import { projectedCostOf, shippingEstimateOf, supplierSideLegs } from "./format";

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
