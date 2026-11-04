import { describe, it, expect } from "vitest";
import { ALL_TABS, SECTIONS, landingTab, sectionOfTab, shellDrawsHeader, visibleTabs } from "./sections";

describe("sections", () => {
  it("places every screen in exactly one section", () => {
    const ids = ALL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(37);
  });

  it("maps the screens the way the mockups group them", () => {
    expect(sectionOfTab("dealflow")?.id).toBe("deals");
    expect(sectionOfTab("purchaseorder")?.id).toBe("deals");
    expect(sectionOfTab("newsletter")?.id).toBe("clients");
    expect(sectionOfTab("suppliers")?.id).toBe("inventory");
    expect(sectionOfTab("bills")?.id).toBe("money");
    expect(sectionOfTab("globe")?.id).toBe("insights");
    expect(sectionOfTab("datasafety")?.id).toBe("more");
    expect(sectionOfTab("nope")).toBeUndefined();
  });

  it("lists only the screens an account may open, in order", () => {
    const deals = SECTIONS.find((s) => s.id === "deals")!;
    const only = new Set(["invoices", "bols", "quotes"]);
    expect(visibleTabs(deals, (id) => only.has(id)).map((t) => t.id)).toEqual(["quotes", "invoices", "bols"]);
  });

  it("lands on the last screen used, else the first openable, else nothing", () => {
    const money = SECTIONS.find((s) => s.id === "money")!;
    expect(landingTab(money, () => true)).toBe("financials");
    expect(landingTab(money, () => true, "bills")).toBe("bills");
    expect(landingTab(money, (id) => id === "bills", "financials")).toBe("bills");
    expect(landingTab(money, () => false)).toBeNull();
  });

  it("draws the shell header only for sections that group several screens", () => {
    expect(shellDrawsHeader("dashboard")).toBe(false);
    expect(shellDrawsHeader("logistics")).toBe(false);
    expect(shellDrawsHeader("settings")).toBe(false);
    expect(shellDrawsHeader("financials")).toBe(true);
  });

  it("keeps a Logistics-only account on Logistics and Settings", () => {
    const allowed = new Set(["logistics", "settings"]);
    const open = SECTIONS.filter((s) => landingTab(s, (id) => allowed.has(id)) !== null).map((s) => s.id);
    expect(open).toEqual(["logistics", "settings"]);
  });
});
