// R-583: the shell's map. The sidebar shows ten sections; each section owns a list of screens (the
// existing tab ids, unchanged) that the shell draws as a tab bar above the page. Pure data and pure
// helpers so the routing rules can be tested without a DOM (sections.test.ts).
//
// Tab ids are the app's routing keys (navigate-tab events, the remembered screen, the command palette,
// split view). Nothing here renames one. A section with one screen (Home, Purchases, Logistics, Settings) has no
// tab bar and no shell header; the screen draws its own PageHeader.

export type TabId =
  | "dashboard" | "clients" | "tiers" | "completed" | "dealflow" | "suppliers" | "coldcalls" | "inventory"
  | "warehouse" | "renewals" | "lotengine" | "showpacking" | "manifest" | "invoices"
  | "quotes" | "releaseletter" | "clientreceipt" | "purchaseorder" | "newsletter" | "analytics"
  | "brief" | "automation" | "globe" | "notes" | "documents" | "approvals" | "portals" | "checkup"
  | "archive" | "sheetcopy" | "financials" | "bills" | "logistics" | "bols" | "platform" | "datasafety"
  | "settings";

// R-648: Purchases is no longer a section. Every purchase order is a load in Warehouse > Loads; a saved layout naming it drops it.
export type SectionId = "home" | "invoices" | "deals" | "clients" | "inventory" | "logistics" | "money" | "insights" | "more" | "settings";

export interface TabDef { id: TabId; label: string }
export interface SectionDef {
  /** A SectionId, or the id of a section you made (R-684). */
  id: string;
  label: string;
  /** The screens in tab order. The first one the account may open is where a click on the section lands. */
  tabs: TabDef[];
  /** R-684: a section you made carries the name of the icon you picked for it (lib/sectionIcons.ts). */
  icon?: string;
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

/** The screens that draw their own PageHeader when they are alone in their section. Every other screen
 *  fills the shell's action slot (<PageActions>), so the shell draws its title and slot even when the
 *  screen is alone (Invoices, R-605, or any screen you put in a section of its own, R-684). */
const SELF_HEADED: string[] = ["dashboard", "logistics", "settings"];

/** Whether the shell draws its own header (section title, action slot and tab bar) for a screen, in the
 *  section it sits in (the default map unless the layout's section is passed). A section that groups
 *  several screens always gets one; a self-headed screen grouped with others then yields its title to it. */
export function shellDrawsHeader(id: string, section: SectionDef | undefined = sectionOfTab(id)): boolean {
  return !!section && (section.tabs.length > 1 || !SELF_HEADED.includes(id));
}

// ── R-623: the layout you chose for this computer ────────────────────────────────────────────────
// The sidebar's order, which sections it shows, and the order of the screens inside each section are
// yours to set (Settings > Appearance > Sidebar and tabs). Stored per device like the rest of Appearance.
// SECTIONS above stays the default map; the shell reads the layout through layoutSections() so an id the
// app no longer has is dropped and a section or screen added by an update appears in its default place.

export const SHELL_LAYOUT_KEY = "clienthub_shell_layout";
export const SHELL_LAYOUT_EVENT = "shell-layout-change";

/** R-684: a section you made. Its screens are the ones `tabs[id]` lists. */
export interface CustomSection { id: string; label: string; icon: string }

export interface ShellLayout {
  /** Section ids in sidebar order. A section not listed comes after these, in default order. */
  sections: string[];
  /** Sections kept off the sidebar. Home and Settings can never be hidden. */
  hidden: string[];
  /** Screen ids in tab order, per section. Since R-684 this is also where a screen lives: one listed under
   *  another section has moved there. A screen listed nowhere stays in its default section, after the listed ones. */
  tabs: Record<string, string[]>;
  /** R-684: the sections you made, which sit just above More until you move them. */
  custom?: CustomSection[];
  /** R-684: the names you gave the built-in sections. */
  labels?: Record<string, string>;
}

/** Sections that always stay on the sidebar: Home is where the app lands, Settings is where you put the rest back. */
export const ALWAYS_SHOWN: SectionId[] = ["home", "settings"];
/** R-684: screens that never leave their section, and the sections no screen moves into, for the same reason. */
export const FIXED_TABS: string[] = ["dashboard", "settings"];
export const CLOSED_SECTIONS: string[] = ["home", "settings"];
/** Longest name a section can be given; the open sidebar is 216px wide. */
export const SECTION_NAME_MAX = 24;

const isStr = (s: unknown): s is string => typeof s === "string";

export function readShellLayout(): ShellLayout | null {
  try {
    const v = JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY) || "null");
    if (!v || typeof v !== "object") return null;
    const tabs: Record<string, string[]> = {};
    if (v.tabs && typeof v.tabs === "object") {
      for (const [k, ids] of Object.entries(v.tabs)) if (Array.isArray(ids)) tabs[k] = ids.filter(isStr);
    }
    const labels: Record<string, string> = {};
    if (v.labels && typeof v.labels === "object") {
      for (const [k, l] of Object.entries(v.labels)) if (isStr(l) && l.trim()) labels[k] = l;
    }
    return {
      sections: Array.isArray(v.sections) ? v.sections.filter(isStr) : [],
      hidden: Array.isArray(v.hidden) ? v.hidden.filter(isStr) : [],
      tabs,
      custom: Array.isArray(v.custom)
        ? v.custom.filter((c: any) => c && isStr(c.id) && isStr(c.label)).map((c: any) => ({ id: c.id, label: c.label, icon: isStr(c.icon) ? c.icon : "folder" }))
        : [],
      labels,
    };
  } catch { return null; }
}

/** Known ids in the chosen order, then the rest in default order. Unknown ids are dropped. */
function ordered<T extends { id: string }>(defaults: T[], chosen: string[] | undefined): T[] {
  if (!chosen || !chosen.length) return defaults;
  const picked = chosen.map((id) => defaults.find((d) => d.id === id)).filter((d): d is T => !!d);
  return [...picked, ...defaults.filter((d) => !picked.includes(d))];
}

/** Every section in the chosen sidebar order, with the names you gave them and the sections you made,
 *  each holding the screens that live in it in the chosen tab order. A section can come out empty when
 *  every screen was moved out of it; the shell then leaves it off the sidebar (landingTab is null). */
export function layoutSections(layout: ShellLayout | null): SectionDef[] {
  if (!layout) return SECTIONS;
  const made: SectionDef[] = (layout.custom ?? [])
    .filter((c) => !SECTIONS.some((s) => s.id === c.id))
    .map((c) => ({ id: c.id, label: c.label, icon: c.icon, tabs: [] }));
  const more = SECTIONS.findIndex((s) => s.id === "more");
  const order = ordered([...SECTIONS.slice(0, more), ...made, ...SECTIONS.slice(more)], layout.sections);
  // Where each screen lives: the first section in sidebar order that lists it, else its default section.
  const home = new Map<string, string>();
  for (const s of order) {
    if (CLOSED_SECTIONS.includes(s.id)) continue;
    for (const id of layout.tabs[s.id] ?? []) {
      if (!home.has(id) && !FIXED_TABS.includes(id) && ALL_TABS.some((t) => t.id === id)) home.set(id, s.id);
    }
  }
  return order.map((s) => ({
    ...s,
    label: layout.labels?.[s.id] || s.label,
    tabs: ordered(ALL_TABS.filter((t) => (home.get(t.id) ?? sectionOfTab(t.id)?.id) === s.id), layout.tabs[s.id]),
  }));
}

/** R-684: whether a section is one you made (it can be removed; a built-in one cannot). */
export function isCustomSection(layout: ShellLayout | null, id: string): boolean {
  return !!layout?.custom?.some((c) => c.id === id) && !SECTIONS.some((s) => s.id === id);
}

/** R-684: move a screen into a section (its own or another) at `index` among that section's other screens.
 *  Both sections' lists are written out in full, so the screen is listed in exactly one place. */
export function moveTab(layout: ShellLayout, tabId: string, to: string, index: number): ShellLayout {
  if (FIXED_TABS.includes(tabId) || CLOSED_SECTIONS.includes(to)) return layout;
  const secs = layoutSections(layout);
  const from = secs.find((s) => s.tabs.some((t) => t.id === tabId));
  const dest = secs.find((s) => s.id === to);
  if (!from || !dest) return layout;
  const fromIds = from.tabs.map((t) => t.id).filter((id) => id !== tabId);
  const destIds = from.id === to ? fromIds : dest.tabs.map((t) => t.id);
  const at = Math.max(0, Math.min(index, destIds.length));
  if (from.id === to && from.tabs[at]?.id === tabId) return layout;
  return {
    ...layout,
    tabs: { ...layout.tabs, [from.id]: fromIds, [to]: [...destIds.slice(0, at), tabId, ...destIds.slice(at)] },
  };
}

/** The sections that move: everything above More (More and Settings keep the bottom). */
function movableIds(layout: ShellLayout): string[] {
  return layoutSections(layout).map((s) => s.id).filter((id) => id !== "more" && id !== "settings");
}

/** R-684: move a section to `index` among the other movable sections. */
export function moveSection(layout: ShellLayout, id: string, index: number): ShellLayout {
  const ids = movableIds(layout);
  const was = ids.indexOf(id);
  if (was < 0) return layout;
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  if (at === was) return layout;
  return { ...layout, sections: [...rest.slice(0, at), id, ...rest.slice(at)] };
}

/** R-684: a new, empty section of your own, just above More. */
export function addSection(layout: ShellLayout, id: string, label: string, icon = "folder"): ShellLayout {
  return { ...layout, custom: [...(layout.custom ?? []), { id, label, icon }] };
}

/** R-684: remove a section you made. Its screens go back to their default sections. */
export function removeSection(layout: ShellLayout, id: string): ShellLayout {
  if (!isCustomSection(layout, id)) return layout;
  const tabs = { ...layout.tabs };
  delete tabs[id];
  return {
    ...layout,
    tabs,
    custom: (layout.custom ?? []).filter((c) => c.id !== id),
    sections: layout.sections.filter((s) => s !== id),
    hidden: layout.hidden.filter((h) => h !== id),
  };
}

/** R-684: rename a section. An empty name, or a built-in section's own name, puts the default back. */
export function renameSection(layout: ShellLayout, id: string, name: string): ShellLayout {
  const label = name.trim().slice(0, SECTION_NAME_MAX);
  if (isCustomSection(layout, id)) {
    if (!label) return layout;
    return { ...layout, custom: (layout.custom ?? []).map((c) => (c.id === id ? { ...c, label } : c)) };
  }
  const def = sectionById(id);
  if (!def) return layout;
  const labels = { ...(layout.labels ?? {}) };
  if (!label || label === def.label) delete labels[id];
  else labels[id] = label;
  return { ...layout, labels };
}

/** R-684: change the icon of a section you made. */
export function setSectionIcon(layout: ShellLayout, id: string, icon: string): ShellLayout {
  return { ...layout, custom: (layout.custom ?? []).map((c) => (c.id === id ? { ...c, icon } : c)) };
}

/** The sections the sidebar leaves out. Their screens stay reachable from search, All screens and split view. */
export function hiddenSections(layout: ShellLayout | null): Set<string> {
  return new Set((layout?.hidden ?? []).filter((id) => !ALWAYS_SHOWN.includes(id as SectionId)));
}
