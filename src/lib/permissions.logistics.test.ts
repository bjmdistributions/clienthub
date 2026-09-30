import { describe, it, expect } from "vitest";
import { canViewLogistics, canViewTab, isLogisticsOnly, tabPerm, type Perms } from "./permissions";

// R-400. A Logistics-only session gets one screen and nothing else, so this rule has to agree
// with the server's `employees::is_logistics_only` in every case: a list that is not empty,
// holds no wildcard and no admin grant, and every entry starts `logistics:`.

const me = (...permissions: string[]): Perms => ({ permissions });

describe("isLogisticsOnly", () => {
  it("accepts the built-in Logistics role", () => {
    expect(isLogisticsOnly(["logistics:view", "logistics:edit", "logistics:view_names", "logistics:view_addresses"])).toBe(true);
    expect(isLogisticsOnly(me("logistics:view"))).toBe(true);
  });

  it("refuses an empty list, a signed-out user and a missing list", () => {
    expect(isLogisticsOnly([])).toBe(false);
    expect(isLogisticsOnly(null)).toBe(false);
    expect(isLogisticsOnly(undefined)).toBe(false);
    expect(isLogisticsOnly({} as Perms)).toBe(false);
  });

  it("refuses the wildcard and the admin grant even beside logistics permissions", () => {
    expect(isLogisticsOnly(["*"])).toBe(false);
    expect(isLogisticsOnly(["logistics:view", "*"])).toBe(false);
    expect(isLogisticsOnly(["logistics:view", "admin:manage"])).toBe(false);
  });

  it("refuses anyone who holds a single permission outside the module", () => {
    expect(isLogisticsOnly(["logistics:view", "deal_flow:view"])).toBe(false);
    expect(isLogisticsOnly(["clients:view"])).toBe(false);
    // A prefix is not the module: the colon is part of the rule.
    expect(isLogisticsOnly(["logisticsx:view"])).toBe(false);
  });
});

describe("canViewLogistics", () => {
  it("opens for the Logistics role and for anyone who can see deals", () => {
    expect(canViewLogistics(me("logistics:view"))).toBe(true);
    expect(canViewLogistics(me("deal_flow:view"))).toBe(true);
    expect(canViewLogistics(me("*"))).toBe(true);
  });

  it("stays closed for everyone else", () => {
    expect(canViewLogistics(me("clients:view", "inventory:view"))).toBe(false);
    expect(canViewLogistics(me("logistics:edit"))).toBe(false);
    expect(canViewLogistics(null)).toBe(false);
  });
});

describe("the logistics tab", () => {
  it("is gated behind logistics:view as its floor", () => {
    expect(tabPerm("logistics")).toBe("logistics:view");
    expect(canViewTab(me("logistics:view"), "logistics")).toBe(true);
    expect(canViewTab(me("clients:view"), "logistics")).toBe(false);
  });
});
