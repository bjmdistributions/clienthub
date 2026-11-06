// R-583: the shell's map. The sidebar shows ten sections; each section owns a list of screens (the
// existing tab ids, unchanged) that the shell draws as a tab bar above the page. Pure data and pure
// helpers so the routing rules can be tested without a DOM (sections.test.ts).
//
// Tab ids are the app's routing keys (navigate-tab events, the remembered screen, the command palette,
// split view). Nothing here renames one. A section with one screen (Home, Purchases, Logistics, Settings) has no
// tab bar and no shell header; the screen draws its own PageHeader.

export type TabId =
  | "dashboard" | "clients" | "tiers" | "completed" | "dealflow" | "suppliers" | "coldcalls" | "inventory"
  | "warehouse" | "purchases" | "renewals" | "lotengine" | "showpacking" | "manifest" | "invoices"
  | "quotes" | "releaseletter" | "clientreceipt" | "purchaseorder" | "newsletter" | "analytics"
  | "brief" | "automation" | "globe" | "notes" | "documents" | "approvals" | "portals" | "checkup"
  | "archive" | "sheetcopy" | "financials" | "bills" | "logistics" | "bols" | "platform" | "datasafety"
  | "settings";

export type SectionId = "home" | "invoices" | "deals" | "clients" | "inventory" | "purchases" | "logistics" | "money" | "insights" | "more" | "settings";

export interface TabDef { id: TabId; label: string }
export interface SectionDef {
  id: SectionId;
  label: string;
  /** The screens in tab order. The first one the account may open is where a click on the section lands. */
  tabs: TabDef[];
}

export const SECTIONS: SectionDef[] = [
  { id: "home", label: "Home", tabs: [{ id: "dashboard", label: "Home" }] },
  // R-605: Invoices is its own sidebar item again, right above Deals (Jack: "put the invoice back above deals").
  { id: "invoices", label: "Invoices", tabs: [{ id: "invoices", label: "Invoices" }] },
  { id: "deals", label: "Deals", tabs: [
    { id: "dealflow", label: "Deal Flow" },
    { id: "quotes", label: "Quotes" },
    { id: "releaseletter", label: "Release letter" },
    { id: "clientreceipt", label: "Client receipt" },
    { id: "purchaseorder", label: "Purchase order" },
    { id: "completed", label: "Completed" },
    { id: "bols", label: "BOLs" },
  ] },
  { id: "clients", label: "Clients", tabs: [
    { id: "clients", label: "Clients" },
    { id: "checkup", label: "Checkup" },
    { id: "tiers", label: "Tiers" },
    { id: "portals", label: "Customer portals" },
    { id: "newsletter", label: "Newsletter" },
    { id: "approvals", label: "Notifications" },
  ] },
  { id: "inventory", label: "Inventory", tabs: [
    { id: "inventory", label: "Inventory" },
    { id: "warehouse", label: "Warehouse" },
    { id: "suppliers", label: "Suppliers" },
    { id: "coldcalls", label: "Cold calls" },
    { id: "manifest", label: "Manifest analyzer" },
    { id: "renewals", label: "Renewals" },
    { id: "lotengine", label: "Lot engine" },
    { id: "showpacking", label: "Show packing" },
    { id: "sheetcopy", label: "Sheet copy" },
  ] },
  // R-596: Jack chose Purchases as its own section, so it sits alone and draws its own header.
  { id: "purchases", label: "Purchases", tabs: [{ id: "purchases", label: "Purchases" }] },
  { id: "logistics", label: "Logistics", tabs: [{ id: "logistics", label: "Logistics" }] },
  { id: "money", label: "Money", tabs: [
    { id: "financials", label: "Financials" },
    { id: "bills", label: "Bills" },
  ] },
  { id: "insights", label: "Insights", tabs: [
    { id: "analytics", label: "Analytics" },
    { id: "brief", label: "Brief" },
    { id: "automation", label: "Automation" },
    { id: "globe", label: "Globe" },
  ] },
  { id: "more", label: "More", tabs: [
    { id: "notes", label: "Notes" },
    { id: "documents", label: "Documents" },
    { id: "archive", label: "Archive" },
    { id: "platform", label: "Platform" },
    { id: "datasafety", label: "Data safety" },
  ] },
  { id: "settings", label: "Settings", tabs: [{ id: "settings", label: "Settings" }] },
];

/** Every screen id with its label, in section order (the split picker and the All screens menu). */
export const ALL_TABS: TabDef[] = SECTIONS.flatMap((s) => s.tabs);

export function sectionOfTab(id: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.tabs.some((t) => t.id === id));
}

export function sectionById(id: string): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/** The section's screens this account may open, in tab order. */
export function visibleTabs(section: SectionDef, visible: (id: TabId) => boolean): TabDef[] {
  return section.tabs.filter((t) => visible(t.id));
}

/** Where a click on a section lands: the screen last used in it when that is still openable,
 *  otherwise the first screen the account may open, otherwise null (the section is hidden). */
export function landingTab(section: SectionDef, visible: (id: TabId) => boolean, lastUsed?: string | null): TabId | null {
  const open = visibleTabs(section, visible);
  if (lastUsed && open.some((t) => t.id === lastUsed)) return lastUsed as TabId;
  return open[0]?.id ?? null;
}

/** One-screen sections whose screen fills the shell's action slot (<PageActions>) instead of drawing its
 *  own PageHeader, so the shell still draws the title and slot (no tab bar with one screen). */
const SHELL_HEADED_SINGLE: SectionId[] = ["invoices"];

/** Whether the shell draws its own header (section title, action slot and tab bar) for a screen.
 *  Sections that group several screens get one; Home, Logistics and Settings draw their own. */
export function shellDrawsHeader(id: string): boolean {
  const s = sectionOfTab(id);
  return !!s && (s.tabs.length > 1 || SHELL_HEADED_SINGLE.includes(s.id));
}

// ── R-623: the layout you chose for this computer ────────────────────────────────────────────────
// The sidebar's order, which sections it shows, and the order of the screens inside each section are
// yours to set (Settings > Appearance > Sidebar and tabs). Stored per device like the rest of Appearance.
// SECTIONS above stays the default map; the shell reads the layout through layoutSections() so an id the
// app no longer has is dropped and a section or screen added by an update appears in its default place.

export const SHELL_LAYOUT_KEY = "clienthub_shell_layout";
export const SHELL_LAYOUT_EVENT = "shell-layout-change";

export interface ShellLayout {
  /** Section ids in sidebar order. A section not listed comes after these, in default order. */
  sections: string[];
  /** Sections kept off the sidebar. Home and Settings can never be hidden. */
  hidden: string[];
  /** Screen ids in tab order, per section. A screen not listed comes after these, in default order. */
  tabs: Record<string, string[]>;
}

/** Sections that always stay on the sidebar: Home is where the app lands, Settings is where you put the rest back. */
export const ALWAYS_SHOWN: SectionId[] = ["home", "settings"];

export function readShellLayout(): ShellLayout | null {
  try {
    const v = JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY) || "null");
    if (!v || typeof v !== "object") return null;
    return {
      sections: Array.isArray(v.sections) ? v.sections.filter((s: unknown) => typeof s === "string") : [],
      hidden: Array.isArray(v.hidden) ? v.hidden.filter((s: unknown) => typeof s === "string") : [],
      tabs: v.tabs && typeof v.tabs === "object" ? v.tabs : {},
    };
  } catch { return null; }
}

/** Known ids in the chosen order, then the rest in default order. Unknown ids are dropped. */
function ordered<T extends { id: string }>(defaults: T[], chosen: string[] | undefined): T[] {
  if (!chosen || !chosen.length) return defaults;
  const picked = chosen.map((id) => defaults.find((d) => d.id === id)).filter((d): d is T => !!d);
  return [...picked, ...defaults.filter((d) => !picked.includes(d))];
}

/** Every section in the chosen sidebar order, each with its screens in the chosen tab order. */
export function layoutSections(layout: ShellLayout | null): SectionDef[] {
  if (!layout) return SECTIONS;
  return ordered(SECTIONS, layout.sections).map((s) => ({ ...s, tabs: ordered(s.tabs, layout.tabs[s.id]) }));
}

/** The sections the sidebar leaves out. Their screens stay reachable from search, All screens and split view. */
export function hiddenSections(layout: ShellLayout | null): Set<string> {
  return new Set((layout?.hidden ?? []).filter((id) => !ALWAYS_SHOWN.includes(id as SectionId)));
}
