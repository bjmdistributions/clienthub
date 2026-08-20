import { describe, it, expect } from "vitest";
import { can, tabPerm, canViewTab, canEditFeature, isAdmin, type Perms } from "./permissions";

// These four functions decide what a signed-in staff member can see and change, and
// two of them fall back to "*" — meaning a feature added to the union but forgotten in
// a map silently becomes admin-only. That is the case worth having a test for.

const me = (...permissions: string[]): Perms => ({ permissions });

describe("can", () => {
  it("refuses a signed-out user", () => {
    expect(can(null, "clients:view")).toBe(false);
    expect(can(undefined, "clients:view")).toBe(false);
  });

  it("grants everything to the wildcard", () => {
    expect(can(me("*"), "anything:at:all")).toBe(true);
  });

  it("matches a permission exactly — a module grant is not a prefix", () => {
    expect(can(me("clients:view"), "clients:view")).toBe(true);
    expect(can(me("clients"), "clients:view")).toBe(false);
    expect(can(me("clients:view"), "clients:edit")).toBe(false);
  });

  it("survives a user carrying no permissions array", () => {
    expect(can({} as Perms, "clients:view")).toBe(false);
  });
});

describe("tabPerm", () => {
  it("leaves the tabs everyone gets ungated", () => {
    for (const f of ["dashboard", "globe", "automation", "notes", "settings"] as const) {
      expect(tabPerm(f)).toBeNull();
    }
  });

  it("gates the money tabs behind deal_flow:view", () => {
    for (const f of ["invoices", "deals", "dealflow", "receivables", "payables"] as const) {
      expect(tabPerm(f)).toBe("deal_flow:view");
    }
  });

  it("gates the books behind their own permission, not deal_flow", () => {
    expect(tabPerm("financials")).toBe("financials:view");
  });

  it("puts suppliers and inventory on the same key", () => {
    expect(tabPerm("suppliers")).toBe("inventory:view");
    expect(tabPerm("inventory")).toBe("inventory:view");
  });
});

describe("canViewTab", () => {
  it("still requires a signed-in user for an ungated tab", () => {
    expect(canViewTab(null, "dashboard")).toBe(false);
    expect(canViewTab(me(), "dashboard")).toBe(true);
  });

  it("checks the tab's permission when it has one", () => {
    expect(canViewTab(me("clients:view"), "clients")).toBe(true);
    expect(canViewTab(me("clients:view"), "financials")).toBe(false);
    expect(canViewTab(me("*"), "financials")).toBe(true);
  });
});

describe("canEditFeature", () => {
  it("maps a feature to its edit permission", () => {
    expect(canEditFeature(me("clients:edit"), "clients")).toBe(true);
    expect(canEditFeature(me("clients:view"), "clients")).toBe(false);
  });

  it("routes every deal surface through deal_flow:edit", () => {
    const editor = me("deal_flow:edit");
    for (const f of ["invoices", "deals", "dealflow"] as const) {
      expect(canEditFeature(editor, f)).toBe(true);
    }
  });

  it("falls back to admin for a feature that is not in the map", () => {
    expect(canEditFeature(me("analytics:view"), "analytics")).toBe(false);
    expect(canEditFeature(me("*"), "analytics")).toBe(true);
  });
});

describe("isAdmin", () => {
  it("accepts either the wildcard or the explicit admin grant", () => {
    expect(isAdmin(me("*"))).toBe(true);
    expect(isAdmin(me("admin:manage"))).toBe(true);
    expect(isAdmin(me("clients:edit"))).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});
