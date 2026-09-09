// DEV ONLY — fixture behind r153b-harness.html, throwaway for R-153b's Address/
// Current deals columns. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL ClientsView.
import ReactDOM from "react-dom/client";
import ClientsView from "./components/ClientsView";
import "./index.css";

// c1 has a full address and one open deal; c2 has only a city (no state) and two
// open deals; c3 has no address at all and a completed deal only, so its
// current-deals count must read 0.
const CLIENTS = [
  { id: "c1", name: "Ava Torres", email: "ava@example.com", phone: "8155551234",
    company: "Torres Co", category: "Shoes", street_address: "123 Main St",
    city: "Chicago", state: "IL", zip_code: "60601", country: "US",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "active_customer",
    approval_status: "approved", invoice_count: 3, total_revenue: 12000,
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c2", name: "Ben Ortiz", email: "ben@example.com", phone: "8155555678",
    company: "Ortiz LLC", category: "General Merchandise", street_address: null,
    city: "Austin", state: null, zip_code: null, country: "US",
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "hot_lead",
    approval_status: "approved", invoice_count: 1, total_revenue: 4000,
    created_at: "2026-07-01", updated_at: "2026-07-01" },
  { id: "c3", name: "Cleo Nash", email: "cleo@example.com", phone: null,
    company: null, category: null, street_address: null,
    city: null, state: null, zip_code: null, country: null,
    is_blacklisted: false, exclusive: false, metadata: {}, lead_status: "inactive",
    approval_status: "approved", invoice_count: 1, total_revenue: 2000,
    created_at: "2026-07-01", updated_at: "2026-07-01" },
];

const DEAL_FLOWS = [
  { id: "df1", client_id: "c1", stage: "invoiced", gross_revenue: 5000, net_profit: 800,
    total_cost: 4200, total_supplier_cost: 4200, payment_received_amount: 0, deposit_amount: 0,
    payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
    supplier_payments: [], profit_jack: 400, profit_ben: 400, profit_business: 0, notes: null,
    created_at: "2026-08-01", updated_at: "2026-08-01", invoice_number: "INV-1", client_name: "Ava Torres",
    invoice_total: 5000, completed_at: null },
  { id: "df2", client_id: "c2", stage: "payment_received", gross_revenue: 3000, net_profit: 500,
    total_cost: 2500, total_supplier_cost: 2500, payment_received_amount: 3000, deposit_amount: 0,
    payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
    supplier_payments: [], profit_jack: 250, profit_ben: 250, profit_business: 0, notes: null,
    created_at: "2026-08-02", updated_at: "2026-08-02", invoice_number: "INV-2", client_name: "Ben Ortiz",
    invoice_total: 3000, completed_at: null },
  { id: "df3", client_id: "c2", stage: "supplier_paid", gross_revenue: 1200, net_profit: 200,
    total_cost: 1000, total_supplier_cost: 1000, payment_received_amount: 1200, deposit_amount: 0,
    payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
    supplier_payments: [], profit_jack: 100, profit_ben: 100, profit_business: 0, notes: null,
    created_at: "2026-08-03", updated_at: "2026-08-03", invoice_number: "INV-3", client_name: "Ben Ortiz",
    invoice_total: 1200, completed_at: null },
  { id: "df4", client_id: "c3", stage: "complete", gross_revenue: 2000, net_profit: 300,
    total_cost: 1700, total_supplier_cost: 1700, payment_received_amount: 2000, deposit_amount: 0,
    payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
    supplier_payments: [], profit_jack: 150, profit_ben: 150, profit_business: 0, notes: null,
    created_at: "2026-07-15", updated_at: "2026-07-20", invoice_number: "INV-4", client_name: "Cleo Nash",
    invoice_total: 2000, completed_at: "2026-07-20" },
];

const CATEGORIES = [{ id: "cat1", label: "Shoes" }, { id: "cat2", label: "General Merchandise" }];

const EMPTY_OK = new Set([
  "client_last_activity", "get_email_inboxes", "list_client_reps",
  "detect_duplicate_clients",
]);

(window as unknown as { __FIXTURE: (cmd: string) => unknown }).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "list_clients": return CLIENTS;
    case "list_categories": return CATEGORIES;
    case "buyer_tiers": return [];
    case "list_deal_flows": return DEAL_FLOWS;
    case "clients_missing_info": return { missing_email: [], missing_phone: [], missing_address: [], missing_category: [] };
    default:
      if (EMPTY_OK.has(cmd)) return [];
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <ClientsView />
  </div>,
);
