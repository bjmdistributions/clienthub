export type Role = "owner" | "sales_rep" | "viewer";
export type Feature = "dashboard" | "clients" | "invoices" | "deals" | "dealflow" | "suppliers" | "analytics" | "email" | "brief" | "globe" | "settings" | "health";

export function canView(role: Role, feature: Feature): boolean {
  if (role === "owner") return true;
  if (role === "viewer") return !["analytics", "email", "settings"].includes(feature);
  if (role === "sales_rep") return !["analytics", "email", "settings"].includes(feature);
  return false;
}

export function canEdit(role: Role, feature: Feature): boolean {
  if (role === "owner") return true;
  if (role === "viewer") return false;
  if (role === "sales_rep") {
    if (feature === "dealflow") return false;
    return !["analytics", "email", "settings"].includes(feature);
  }
  return false;
}

export function canDelete(role: Role, feature: Feature): boolean {
  if (role === "owner") return true;
  if (role === "sales_rep") return feature === "clients" || feature === "deals";
  return false;
}

export function isOwner(role: Role): boolean {
  return role === "owner";
}
