// Unified permission model — module:action strings backed by the synced role
// (same as web/mobile). A signed-in user carries `permissions`; "*" = full access.

export interface Perms {
  permissions: string[];
}

export type Feature =
  | "dashboard" | "clients" | "invoices" | "quotes" | "completed" | "dealflow"
  | "suppliers" | "analytics" | "newsletter" | "brief" | "globe" | "settings"
  | "tiers" | "inventory" | "automation" | "notes" | "receivables" | "payables"
  | "financials" | "clientreceipt" | "logistics" | "bols";

/** True if the user holds a permission (wildcard "*" grants everything). */
export function can(me: Perms | null | undefined, perm: string): boolean {
  if (!me) return false;
  const p = me.permissions || [];
  return p.includes("*") || p.includes(perm);
}

/** Required permission for a tab/feature (null = available to any signed-in user). */
export function tabPerm(feature: Feature): string | null {
  switch (feature) {
    case "dashboard":
    case "globe":
    case "automation":
    case "notes":
      return null;
    case "clients":
    case "tiers":       return "clients:view";
    case "invoices":
    case "completed":
    case "dealflow":
    case "receivables":
    case "payables":     return "deal_flow:view";
    case "quotes":       return "quotes:view";
    // The receipt builder lists a client's deals and what they paid, so it rides
    // deal access rather than the document-maker default of everyone-signed-in.
    case "clientreceipt": return "deal_flow:view";
    // The books (bank balances, allocations, free cash). Admins also reach this
    // via `*`/admin:manage — see the financials case in App.tsx's `visible`.
    case "financials":   return "financials:view";
    // R-400: the Logistics screen. Anyone who sees deals also sees it (see canViewLogistics),
    // so this single string is only the floor for a role built for it. R-459: the BOLs we make ride
    // the same switch as the loads they travel with.
    case "logistics":
    case "bols":         return "logistics:view";
    case "suppliers":
    case "inventory":    return "inventory:view";
    case "analytics":
    case "brief":        return "analytics:view";
    case "newsletter":   return "email:view";
    // Everyone can OPEN Settings (to reach Appearance + their own Profile); the
    // org-sensitive sections gate themselves to admins inside SettingsView.
    case "settings":     return null;
    default:             return null;
  }
}

export function canViewTab(me: Perms | null | undefined, feature: Feature): boolean {
  const need = tabPerm(feature);
  if (need === null) return !!me;
  return can(me, need);
}

/** Edit-capability for a feature's module (view→edit). */
export function canEditFeature(me: Perms | null | undefined, feature: Feature): boolean {
  const map: Partial<Record<Feature, string>> = {
    clients: "clients:edit", invoices: "deal_flow:edit", completed: "deal_flow:edit",
    dealflow: "deal_flow:edit", quotes: "quotes:edit", suppliers: "inventory:edit",
    inventory: "inventory:edit", newsletter: "email:edit",
  };
  const need = map[feature];
  return need ? can(me, need) : can(me, "*");
}

/** R-400: who may open the Logistics screen. A Logistics role holds `logistics:view`; whoever
 *  can see deals sees the same bookings, so `deal_flow:view` opens it too. */
export function canViewLogistics(me: Perms | null | undefined): boolean {
  return can(me, "logistics:view") || can(me, "deal_flow:view");
}

/** The three older switches a role editor can add to any role. They open no screen. */
const OLDER_SWITCHES = ["clients:view_revenue", "suppliers:view", "deal_flow:view_numbers"];

/** R-400: a session that holds at least one `logistics:` permission and nothing else but the
 *  three older switches (no wildcard, no admin). Such a session gets the Logistics screen and
 *  nothing else. Same rule as the server's `employees::is_logistics_only`. Takes the permission
 *  list, or anything carrying one. */
export function isLogisticsOnly(perms: string[] | Perms | null | undefined): boolean {
  const list = Array.isArray(perms) ? perms : perms?.permissions;
  if (!list || list.length === 0) return false;
  const ok = (p: unknown): boolean => typeof p === "string" && (p.startsWith("logistics:") || OLDER_SWITCHES.includes(p));
  return list.some((p) => typeof p === "string" && p.startsWith("logistics:")) && list.every(ok);
}

export function isAdmin(me: Perms | null | undefined): boolean {
  return can(me, "*") || can(me, "admin:manage");
}

/** R-459: the screens a Logistics-only account may open besides Settings. The sidebar's gate and the
 *  lock that bounces it back to Logistics both read this one list. */
export const LOGISTICS_ONLY_TABS = ["logistics", "bols"] as const;
export const isLogisticsOnlyTab = (id: string): boolean => (LOGISTICS_ONLY_TABS as readonly string[]).includes(id);
