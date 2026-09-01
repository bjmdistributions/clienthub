// DEV ONLY — the fixture behind shell-harness.html. Nothing in the app imports this, and
// index.html does not reference the page, so it never reaches a build.
//
// It renders the REAL <App />, so the sidebar under test is the shipping one and not a
// copy of it that can drift. Everything below exists only to get past the auth gate and
// keep the boot calls from throwing.
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const params = new URLSearchParams(location.search);
const role = params.get("role") || "admin";
const apCount = Number(params.get("ap") ?? 3);
const draftCount = Number(params.get("drafts") ?? 2);

// The three cases worth looking at. Permissions are the real strings from
// src/lib/permissions.ts; the role names match what seed_roles() ships.
const ROLES: Record<string, { role_name: string; is_admin: boolean; permissions: string[] }> = {
  // Sees everything, including Financials, Platform and Data safety.
  admin: { role_name: "Owner", is_admin: true, permissions: ["*"] },
  // The shipped Sales role: no financials module exists at all, so Financials is
  // invisible to it — one of the six default pins simply does not render.
  sales: {
    role_name: "Sales",
    is_admin: false,
    permissions: ["clients:view", "clients:edit", "inventory:view", "inventory:edit",
                  "quotes:view", "quotes:edit", "email:view", "email:edit"],
  },
  // A role created with no permissions yet. Dashboard is the only pin left standing.
  fresh: { role_name: "New role", is_admin: false, permissions: [] },
};
const R = ROLES[role] || ROLES.admin;

const ME = {
  id: "u_harness", email: "harness@ecliptr.app", display_name: "Jack Miller",
  role_id: "r_harness", role_name: R.role_name, permissions: R.permissions,
  is_admin: R.is_admin, title: "Owner", phone: "",
};

// Approvals: the bell count is pending clients + requests whose kind is NOT client_add,
// so the fixture has to split them that way or the number on the rail will not match the
// number the Notifications screen shows.
const pendingClients = Array.from({ length: Math.max(0, Math.min(apCount, 2)) }, (_, i) => ({
  id: `c_${i}`, name: `Pending buyer ${i + 1}`, company: "", email: "", phone: "",
  status: "pending", archived: 0,
}));
const requests = Array.from({ length: Math.max(0, apCount - pendingClients.length) }, (_, i) => ({
  id: `r_${i}`, kind: "listing_stale", status: "pending", payload_json: "{}", created_at: "2026-09-01",
}));

window.__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "employee_status":       return { has_accounts: true, signed_in: true };
    case "employee_me":           return ME;
    case "get_onboarding_status": return true;
    case "get_organization_name": return "BJM Distributions";
    case "get_my_plan":
      return { name: "BJM Distributions", plan: "unlimited", members: 4, member_limit: null,
               clients: 812, client_limit: null, is_superadmin: role === "admin" };
    case "local_is_superadmin":   return role === "admin";
    case "sync_status":           return { last_applied: "2026-09-01T13:04:00Z", pending: 0 };
    case "get_pending_approvals": return pendingClients;
    case "list_approval_requests": return requests;
    case "list_drafts":           return Array.from({ length: draftCount }, (_, i) => ({ id: `d_${i}`, status: "pending" }));
    case "media_base_dir":        return "";
    // The dashboard renders behind the rail and will take the whole tree down with it
    // if these two return the wrong SHAPE — both are `.catch(() => setX(null))` in
    // DashboardView, so null is the honest "no data" value and an empty array is not.
    case "get_receivables_aging":
    case "get_payables_aging":    return null;
    case "dashboard_stats":       return {};
    // Everything else is a list. An empty one is enough to keep a screen quiet.
    default: return [];
  }
};

declare global {
  interface Window { __FIXTURE?: (cmd: string, args?: any) => any; __cb?: any }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
