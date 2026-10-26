import { describe, it, expect } from "vitest";
import { legLine, legTone, openLegs, type DealLegs } from "./dealLegs";

// Invented figures, never a real deal.
const legs = (over: Partial<DealLegs> = {}): DealLegs => ({
  buyer: { state: "linked", expected: 2915, linked: 2915, note: "" },
  supplier: { state: "missing", expected: 2440, linked: 0, note: "" },
  shipping: { state: "none", expected: 0, linked: 0, note: "" },
  ...over,
});

describe("openLegs", () => {
  it("lists what is missing or part linked, never what is linked or marked", () => {
    expect(openLegs(legs(), false)).toEqual(["supplier"]);
    expect(openLegs(legs({ supplier: { state: "marked", expected: 2440, linked: 0, note: "Paid on another deal" } }), false)).toEqual([]);
    expect(openLegs(legs({ buyer: { state: "part", expected: 9000, linked: 6000, note: "" } }), false)).toEqual(["buyer", "supplier"]);
  });
  it("leaves the carrier to its own question on a deal on Logistics", () => {
    const l = legs({ supplier: { state: "linked", expected: 6000, linked: 6000, note: "" }, shipping: { state: "missing", expected: 900, linked: 0, note: "" } });
    expect(openLegs(l, true)).toEqual([]);
    expect(openLegs(l, false)).toEqual(["shipping"]);
  });
  it("reads nothing from an older answer with no legs", () => {
    expect(openLegs(null, false)).toEqual([]);
  });
});

describe("legLine and legTone", () => {
  it("says each state plainly, with the note on a marked leg", () => {
    expect(legLine("supplier", legs().supplier)).toBe("Supplier payment missing: $2,440.00 expected, nothing linked");
    expect(legLine("buyer", { state: "part", expected: 9000, linked: 6000, note: "" })).toBe("Buyer payment: $6,000.00 of $9,000.00 linked, $3,000.00 missing");
    expect(legLine("supplier", { state: "marked", expected: 2440, linked: 0, note: "Paid on another deal" })).toBe("Supplier payment: no payment recorded, Paid on another deal");
    expect([legTone("missing"), legTone("part"), legTone("linked"), legTone("marked")]).toEqual(["danger", "warning", "success", "neutral"]);
  });
});
