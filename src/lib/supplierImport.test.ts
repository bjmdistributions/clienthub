import { describe, expect, it } from "vitest";
import { parseSupplierRows } from "./supplierImport";

const HEAD = ["Company name", "Contact name", "Email", "Phone", "Address", "Payment method", "Payment details", "Payment terms", "Lead time", "Notes"];

describe("parseSupplierRows (R-634)", () => {
  const existing = [{ name: "Acme Liquidators", email: "sales@acme.test", phone: "(555) 010-2000" }];

  it("reads the template's columns", () => {
    const [row] = parseSupplierRows([HEAD, ["North Pallets", "Dana", "dana@north.test", "555-010-3000", "", "Wire", "", "Net 15", "3 days", "Shoes"]], []);
    expect(row.line).toBe(2);
    expect(row.input).toMatchObject({ name: "North Pallets", contact_name: "Dana", email: "dana@north.test", payment_terms: "Net 15", typical_lead_time: "3 days", notes: "Shoes" });
    expect(row.dupes).toEqual([]);
  });

  it("flags exact matches on name, email or phone against saved suppliers", () => {
    const rows = parseSupplierRows([
      HEAD,
      ["acme  LIQUIDATORS"],
      ["Other Co", "", "Sales@Acme.test"],
      ["Third Co", "", "", "+1 555 010 2000"],
      ["Fresh Co", "", "new@fresh.test", "555-010-9999"],
    ], existing);
    expect(rows.map((r) => r.dupes)).toEqual([
      ["Same company name as Acme Liquidators"],
      ["Same email as Acme Liquidators"],
      ["Same phone as Acme Liquidators"],
      [],
    ]);
  });

  it("flags a repeat inside the same file and skips rows with no company name", () => {
    const rows = parseSupplierRows([["Notes about this sheet"], HEAD, ["Fresh Co", "", "a@fresh.test"], ["", "No name"], ["Fresh Co 2", "", "A@fresh.test"]], []);
    expect(rows).toHaveLength(2);
    expect(rows[1].dupes).toEqual(["Same email as row 3 (Fresh Co)"]);
  });

  it("refuses a sheet with no Company name column", () => {
    expect(() => parseSupplierRows([["Email", "Phone"]], [])).toThrow(/Company name/);
  });
});
