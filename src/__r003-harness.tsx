// DEV ONLY — fixture behind r003-harness.html, verifying the R-003-ui bank-connection
// status pill on the Settings > Team tab. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
import ReactDOM from "react-dom/client";
import SettingsView from "./components/SettingsView";
import "./index.css";

// ?banks=0 (default) shows the "No banks connected" state; ?banks=2 shows "Connected · 2 banks".
const bankCount = Number(new URLSearchParams(location.search).get("banks") || "0");

const ROLES = { roles: [{ id: "role_owner", name: "Owner" }], modules: [] };
const STAFF = [
  { id: "u1", display_name: "Jack", email: "jack@example.com", title: "Owner", avatar: null,
    role_id: "role_owner", status: "active", commission_pct: 0, hide_pay_cuts: false, pay_type: "profit_pct" },
];
const PLAID_ITEMS = Array.from({ length: bankCount }, (_, i) => ({
  id: `pi_${i}`, institution: `Bank ${i + 1}`, account_count: 1, created_at: "2026-08-01",
}));

const ME = { id: "u1", email: "jack@example.com", role_id: "role_owner", permissions: ["*"] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "employee_me": return ME;
    case "list_staff": return STAFF;
    case "list_roles": return ROLES;
    case "plaid_list_items": return PLAID_ITEMS;
    case "get_rep_payout_settings": return { enabled: false };
    default: return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <SettingsView me={ME as any} />
  </div>,
);
