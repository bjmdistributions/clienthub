import { describe, expect, it } from "vitest";
import { unitFigures, unitGap } from "./dealUnits";

const lines = [
  { description: "Nike Dunk Low", qty: 120, rate: 153.5, amount: 18420 },
  { description: "Shipping", qty: 1, rate: 1260, amount: 1260 },
];

describe("unitFigures", () => {
  it("divides goods only, shipping left out", () => {
    const f = unitFigures(lines, { supplier_payments: [{}], projected_cost: 14460, shipping_estimate: 1260 });
    expect(f.units).toBe(120);
    expect(f.chargedPerUnit).toBe(153.5);
    expect(f.cost).toBe(13200);
    expect(f.costPerUnit).toBe(110);
  });
  it("has no cost before a cost line is entered", () => {
    const f = unitFigures(lines, { supplier_payments: [], total_supplier_cost: 0 });
    expect(f.cost).toBeNull();
    expect(f.costPerUnit).toBeNull();
    expect(unitGap(f, "cost")).toBe("No cost entered");
    expect(unitGap(f, "charged")).toBe("");
  });
  it("says the unit count is unknown instead of guessing", () => {
    const f = unitFigures([{ description: "Mixed lot", qty: 0, amount: 500 }], { supplier_payments: [{}], total_supplier_cost: 300 });
    expect(f.units).toBeNull();
    expect(f.chargedPerUnit).toBeNull();
    expect(f.costPerUnit).toBeNull();
    expect(unitGap(f, "charged")).toBe("Unit count unknown");
  });
  it("falls back to qty times rate when a line has no amount", () => {
    const f = unitFigures([{ description: "Tee", qty: 10, rate: 5 }], { supplier_payments: [] });
    expect(f.billed).toBe(50);
    expect(f.chargedPerUnit).toBe(5);
  });
});
