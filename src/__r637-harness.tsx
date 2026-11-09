// DEV ONLY: R-637 harness. Renders the real <App /> on Home with invented invoices and deals so the
// "On Mondays you typically..." line can be checked. Nothing imports it; every value below is made up.
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const ME = { id: "u_h", email: "harness@ecliptr.app", display_name: "Sam Rivera", role_id: "r_h", role_name: "Owner",
  permissions: ["*"], is_admin: true, title: "Owner", phone: "" };
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const empty = new URLSearchParams(location.search).get("empty") === "1";

// Every Monday sends 2 invoices, August Mondays 4; Mondays close 1 deal; Wednesdays a little of both.
const invoices: any[] = [], deals: any[] = [];
const t = new Date(); t.setHours(0, 0, 0, 0);
for (let i = 0; i < 230 && !empty; i++) {
  const d = new Date(t); d.setDate(t.getDate() - i);
  const wd = d.getDay(), aug = d.getMonth() === 7;
  const sends = wd === 1 ? (aug ? 4 : 2) : wd === 3 ? 1 : 0;
  for (let k = 0; k < sends; k++) invoices.push({ id: `i${i}_${k}`, client_id: `c${k}`, number: `INV-${i}${k}`, voided: 0, sent_at: day(d), issue_date: day(d), due_date: day(d), created_at: day(d), status: "paid", line_items_json: "[]", total: 1000 });
  if (wd === 1 || (wd === 3 && i % 14 === 0)) deals.push({ id: `d${i}`, completed_on: day(d), net_profit: 1200, name: "Deal", client_name: "Client", created_at: day(d) });
}

window.__FIXTURE = (cmd: string, args?: any) => {
  switch (cmd) {
    case "employee_status":       return { has_accounts: true, signed_in: true };
    case "employee_me":           return ME;
    case "get_onboarding_status": return true;
    case "get_organization_name": return "Northwind Goods";
    case "get_my_plan":           return { name: "Northwind Goods", plan: "unlimited", members: 1, member_limit: null, clients: 10, client_limit: null, is_superadmin: true };
    case "local_is_superadmin":   return true;
    case "sync_status":           return { last_applied: "2026-11-09T13:04:00Z", pending: 0 };
    case "netsync_status":        return { connected: true, url: "https://ecliptr.app", pending_push: 0, pull_cursor: 1, auth: "ok", last_pull_at: "", last_push_at: "", invariants: [], invariants_at: "" };
    case "media_base_dir":        return "";
    case "get_receivables_aging":
    case "get_payables_aging":
    case "bills_alerts":
    case "financials_overview":   return null;
    case "dashboard_stats":       return {};
    case "list_invoices":         return invoices;
    case "get_analytics_range": {
      const rows = deals.filter((x) => x.completed_on >= args.startDate && x.completed_on <= args.endDate);
      return { completed_deals: rows, completed_deals_capped: false, deal_count: rows.length };
    }
    default: return [];
  }
};

declare global { interface Window { __FIXTURE?: (cmd: string, args?: any) => any } }
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
