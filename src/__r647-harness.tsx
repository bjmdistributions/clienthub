// DEV ONLY (R-647) — the real App with invented bank rows, so Financials > Ledger > Filters
// opens in the container it really lives in. Copied from __shell-harness.tsx.
// DEV ONLY — the fixture behind r647-harness.html. Nothing in the app imports this, and
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


const TXNS = Array.from({ length: 60 }, (_, i) => ({
  id: `t_${i}`, posted_at: `2026-${String(1 + (i % 10)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`,
  amount: 120 + i * 37, direction: i % 3 ? "out" : "in", description: `INVENTED PAYEE ${i} WIRE TRANSFER`,
  rail: i % 2 ? "wire" : "", confirmed_method: "", category: i % 4 ? "inventory" : "", counterparty_name: "",
  counterparty_type: "", counterparty_id: "", wire_ref: "", reviewed: i % 5 === 0, account_id: i % 2 ? "Checking 1234" : "Savings 9876",
  allocated: 0, alloc_count: 0, unallocated: 120 + i * 37, note: "", links: [],
}));
window.__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "plaid_health":          return { banks: [], warnings: [], last_sync: null };
    case "list_bank_declined":    return { rows: [], check: null };
    case "list_bank_txns":        return TXNS;
    case "bank_txn_summary":      return { total: 60, reviewed: 12, sum_in: 1000, sum_out: 2000, unallocated_in: 0, unallocated_out: 0, unclassified: 15 };
    case "employee_status":       return { has_accounts: true, signed_in: true };
    case "employee_me":           return ME;
    case "get_onboarding_status": return true;
    case "get_organization_name": return "BJM Distributions";
    case "get_my_plan":
      return { name: "BJM Distributions", plan: "unlimited", members: 4, member_limit: null,
               clients: 812, client_limit: null, is_superadmin: role === "admin" };
    case "local_is_superadmin":   return role === "admin";
    case "sync_status":           return { last_applied: "2026-09-01T13:04:00Z", pending: 0 };
    case "netsync_status":        return { connected: true, url: "https://ecliptr.app", pending_push: 0, pull_cursor: 1, auth: "ok", last_pull_at: "2026-09-01T13:04:00Z", last_push_at: "2026-09-01T13:04:00Z", invariants: [], invariants_at: "" };
    case "get_pending_approvals": return pendingClients;
    case "list_approval_requests": return requests;
    case "list_drafts":           return Array.from({ length: draftCount }, (_, i) => ({ id: `d_${i}`, status: "pending" }));
    case "media_base_dir":        return "";
    // The dashboard renders behind the rail and will take the whole tree down with it
    // if these two return the wrong SHAPE — both are `.catch(() => setX(null))` in
    // DashboardView, so null is the honest "no data" value and an empty array is not.
    case "get_receivables_aging":
    case "get_payables_aging":    return null;
    // R-449 bills: `alertRow` reads `.items` off the answer, so the list default would crash the Dashboard.
    case "bills_alerts":          return null;
    case "dashboard_stats":       return {};
    // Everything else is a list. An empty one is enough to keep a screen quiet.
    default: return [];
  }
};

declare global {
  interface Window { __FIXTURE?: (cmd: string, args?: any) => any; __cb?: any }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
