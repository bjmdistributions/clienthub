import { describe, it, expect } from "vitest";
import { missingLegs } from "./missingPayments";

describe("missingLegs (R-601)", () => {
  it("lists every flagged payment on a completed deal", () => {
    expect(missingLegs("complete", { buyer_missing: true, supplier_missing: true, shipping_missing: true }))
      .toEqual(["buyer", "supplier", "shipping"]);
  });
  it("does not call an open deal's payment missing before the deal says it was made", () => {
    expect(missingLegs("invoiced", { buyer_missing: true, supplier_missing: true })).toEqual([]);
    expect(missingLegs("payment_received", { buyer_missing: true, supplier_missing: true })).toEqual(["buyer"]);
    expect(missingLegs("supplier_paid", { buyer_missing: false, supplier_missing: true })).toEqual(["supplier"]);
  });
  it("counts a paid carrier with no link at any stage", () => {
    expect(missingLegs("invoiced", { shipping_missing: true })).toEqual(["shipping"]);
  });
  it("is empty with no flags", () => {
    expect(missingLegs("complete", undefined)).toEqual([]);
    expect(missingLegs("complete", {})).toEqual([]);
  });
});
