import { describe, it, expect } from "vitest";
import {
  ALL_TABS, SECTIONS, addSection, hiddenSections, isCustomSection, landingTab, layoutSections, moveSection, moveTab,
  removeSection, renameSection, sectionOfTab, shellDrawsHeader, visibleTabs, type ShellLayout,
} from "./sections";

describe("sections", () => {
  it("places every screen in exactly one section", () => {
    const ids = ALL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(37); // R-648: Purchases folded into Warehouse > Loads
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
    const only = new Set(["completed", "bols", "quotes"]);
    expect(visibleTabs(deals, (id) => only.has(id)).map((t) => t.id)).toEqual(["quotes", "completed", "bols"]);
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
    // R-605: Invoices is one screen but fills the shell's action slot, so the shell keeps its title and slot.
    expect(shellDrawsHeader("invoices")).toBe(true);
  });

  it("puts Invoices in its own section right above Deals (R-605)", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(sectionOfTab("invoices")?.id).toBe("invoices");
    expect(ids.indexOf("invoices")).toBe(ids.indexOf("deals") - 1);
    expect(SECTIONS.find((s) => s.id === "deals")!.tabs.some((t) => t.id === "invoices")).toBe(false);
  });

  it("keeps a Logistics-only account on Logistics and Settings", () => {
    const allowed = new Set(["logistics", "settings"]);
    const open = SECTIONS.filter((s) => landingTab(s, (id) => allowed.has(id)) !== null).map((s) => s.id);
    expect(open).toEqual(["logistics", "settings"]);
  });

  // R-623: the layout chosen on this computer.
  it("keeps the default map without a layout", () => {
    expect(layoutSections(null)).toBe(SECTIONS);
    expect(hiddenSections(null).size).toBe(0);
  });

  it("orders the sidebar as chosen, drops ids it does not know and appends the rest in default order", () => {
    const got = layoutSections({ sections: ["money", "gone", "deals"], hidden: [], tabs: {} }).map((s) => s.id);
    expect(got).toEqual(["money", "deals", "home", "invoices", "clients", "inventory", "logistics", "insights", "more", "settings"]);
  });

  it("orders a section's screens as chosen and appends the ones not listed", () => {
    const deals = layoutSections({ sections: [], hidden: [], tabs: { deals: ["bols", "nope", "quotes"] } }).find((s) => s.id === "deals")!;
    expect(deals.tabs.map((t) => t.id)).toEqual(["bols", "quotes", "dealflow", "releaseletter", "clientreceipt", "purchaseorder", "completed"]);
    expect(landingTab(deals, () => true)).toBe("bols");
    // The default map is never changed underneath.
    expect(SECTIONS.find((s) => s.id === "deals")!.tabs[0].id).toBe("dealflow");
  });

  it("never hides Home or Settings", () => {
    expect([...hiddenSections({ sections: [], hidden: ["home", "settings", "insights", "more"], tabs: {} })]).toEqual(["insights", "more"]);
  });

  // R-684: sections you make, screens moved between sections, names you give.
  const EMPTY: ShellLayout = { sections: [], hidden: [], tabs: {} };
  const tabsOf = (l: ShellLayout, id: string) => layoutSections(l).find((s) => s.id === id)!.tabs.map((t) => t.id);

  it("makes a Suppliers section holding Suppliers and Cold calls, and removing it puts them back", () => {
    let l = addSection(EMPTY, "mine-1", "Suppliers", "factory");
    l = moveTab(l, "suppliers", "mine-1", 0);
    l = moveTab(l, "coldcalls", "mine-1", 1);
    const secs = layoutSections(l);
    const mine = secs.find((s) => s.id === "mine-1")!;
    expect(mine.label).toBe("Suppliers");
    expect(mine.icon).toBe("factory");
    expect(mine.tabs.map((t) => t.id)).toEqual(["suppliers", "coldcalls"]);
    expect(tabsOf(l, "inventory")).not.toContain("suppliers");
    expect(tabsOf(l, "inventory")).not.toContain("coldcalls");
    // A new section sits just above More.
    const ids = secs.map((s) => s.id);
    expect(ids.indexOf("mine-1")).toBe(ids.indexOf("more") - 1);
    // Every screen still lives in exactly one section.
    const all = secs.flatMap((s) => s.tabs.map((t) => t.id));
    expect(all.length).toBe(ALL_TABS.length);
    expect(new Set(all).size).toBe(ALL_TABS.length);

    const back = removeSection(l, "mine-1");
    expect(layoutSections(back).some((s) => s.id === "mine-1")).toBe(false);
    expect(tabsOf(back, "inventory")).toEqual(expect.arrayContaining(["suppliers", "coldcalls"]));
  });

  it("reorders inside a section, can empty one, and never moves Home or Settings", () => {
    let l = moveTab(EMPTY, "bills", "money", 0);
    expect(tabsOf(l, "money")).toEqual(["bills", "financials"]);
    expect(moveTab(l, "bills", "money", 0)).toBe(l);
    l = moveTab(l, "logistics", "deals", 0);
    expect(tabsOf(l, "deals")[0]).toBe("logistics");
    const logistics = layoutSections(l).find((s) => s.id === "logistics")!;
    expect(logistics.tabs).toEqual([]);
    expect(landingTab(logistics, () => true)).toBeNull();
    expect(moveTab(l, "dashboard", "deals", 0)).toBe(l);
    expect(moveTab(l, "settings", "deals", 0)).toBe(l);
    expect(moveTab(l, "invoices", "home", 0)).toBe(l);
    expect(moveTab(l, "invoices", "gone", 0)).toBe(l);
  });

  it("draws the shell header by where a screen sits in your layout", () => {
    const l = moveTab(moveTab(addSection(EMPTY, "mine", "Suppliers"), "suppliers", "mine", 0), "logistics", "deals", 0);
    const secs = layoutSections(l);
    const of = (id: string) => secs.find((s) => s.tabs.some((t) => t.id === id));
    // Alone in its section, Suppliers still fills the shell's action slot, so the shell keeps its header.
    expect(shellDrawsHeader("suppliers", of("suppliers"))).toBe(true);
    // Grouped with other screens, Logistics gets the shell's header and tab bar.
    expect(shellDrawsHeader("logistics", of("logistics"))).toBe(true);
    expect(shellDrawsHeader("dashboard", of("dashboard"))).toBe(false);
  });

  it("moves sections above More, renames them and only removes your own", () => {
    let l = addSection(EMPTY, "mine", "Suppliers");
    l = moveSection(l, "mine", 1);
    expect(layoutSections(l).map((s) => s.id).slice(0, 3)).toEqual(["home", "mine", "invoices"]);
    expect(moveSection(l, "more", 0)).toBe(l);
    expect(moveSection(l, "mine", 1)).toBe(l);

    l = renameSection(l, "inventory", "  Stock ");
    expect(layoutSections(l).find((s) => s.id === "inventory")!.label).toBe("Stock");
    l = renameSection(l, "inventory", "");
    expect(layoutSections(l).find((s) => s.id === "inventory")!.label).toBe("Inventory");
    expect(l.labels).toEqual({});
    l = renameSection(l, "mine", "Vendors");
    expect(layoutSections(l).find((s) => s.id === "mine")!.label).toBe("Vendors");
    expect(renameSection(l, "mine", "  ")).toBe(l);

    expect(isCustomSection(l, "mine")).toBe(true);
    expect(isCustomSection(l, "inventory")).toBe(false);
    expect(removeSection(l, "inventory")).toBe(l);
  });
});
