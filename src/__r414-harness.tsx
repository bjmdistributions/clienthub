// DEV ONLY — the fixture behind r414-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// R-414: the client screen's Store credit card, full window and inside the app's split
// view. The shell below copies App.tsx's markup (sidebar width, split row, .pane-container
// on each pane, the p-7 / max-w-[1280px] column) so the pane is measured in the container
// it really lives in. Every figure is invented.
//
// ?mode=full (default) | split   &nav=216 (default) | 96   &ratio=0.5 (split only)
// &screen=client (default) | any key of SCREENS below (R-417: every screen in a split pane;
// unknown list_* calls answer [], so the other screens render their empty layouts)
import ReactDOM from "react-dom/client";
import ClientDetailView from "./components/ClientDetailView";
import DashboardView from "./components/DashboardView";
import InvoicesView from "./components/InvoicesView";
import InventoryView from "./components/InventoryView";
import SuppliersView from "./components/SuppliersView";
import AnalyticsView from "./components/AnalyticsView";
import FinancialsView from "./components/FinancialsView";
import DealFlowView from "./components/DealFlowView";
import TiersView from "./components/TiersView";
import ReceivablesView from "./components/ReceivablesView";
import PayablesView from "./components/PayablesView";
import BriefView from "./components/BriefView";
import ClientsView from "./components/ClientsView";
import QuotesView from "./components/QuotesView";
import SettingsView from "./components/SettingsView";
import "./index.css";

const q = new URLSearchParams(location.search);
const mode = q.get("mode") || "full";
const screen = q.get("screen") || "client";
const nav = Number(q.get("nav") || 216);
const ratio = Number(q.get("ratio") || 0.5);

const inv = (id: string, number: string, total: number, extra: Record<string, unknown> = {}) => ({
  id, client_id: "c1", number, issue_date: "2026-08-14", due_date: "2026-08-28",
  line_items_json: JSON.stringify([{ description: "Mixed apparel, shelf pulls", qty: 1000, rate: total / 1000, amount: total }]),
  subtotal: total, tax: 0, total, status: "paid", pdf_path: null, sent_at: "2026-08-14",
  notes: "", cost_items_json: null, total_cost: 0, profit: 0, margin: 0, carrier: null,
  tracking_number: null, shipping_charged: 0, pickup_date: null, delivery_date: null,
  is_complete: true, deal_flow_id: null, deal_flow_stage: "complete", voided: false,
  return_policy: "", ...extra,
});

const INVOICES = [
  inv("i1", "INV-0412", 18450, { deal_flow_id: "d1" }),
  inv("i2", "INV-0398", 126880.5, { deal_flow_id: "d2", is_complete: false, deal_flow_stage: "supplier_paid" }),
  inv("i3", "INV-0371", 7300, { deal_flow_id: "d3" }),
];

const FLOW = (id: string, invoice_id: string, invoice_number: string, stage: string, total: number) => ({
  id, invoice_id, name: null, stage, payment_received_amount: 0, payment_received_method: "",
  payment_received_at: null, supplier_payments: [], total_supplier_cost: 0, completed_at: null,
  gross_revenue: total, total_cost: 0, net_profit: total * 0.1, profit_jack: 0, profit_ben: 0,
  profit_business: 0, notes: "", created_at: "2026-08-01", updated_at: "2026-08-14",
  invoice_number, client_id: "c1", client_name: "Harbor Point Resale", invoice_total: total,
  refund_owed: 0, archived: false,
});

const CLIENT = {
  id: "c1", name: "Harbor Point Resale", email: "orders@harborpoint.example", phone: "5550142288",
  company: "Harbor Point Resale LLC", notes: "", billing_status: "good", lead_status: "customer",
  created_at: "2026-02-04", updated_at: "2026-08-14",
  metadata: { city: "Toledo", state: "OH", job_title: "Buyer", website: "harborpoint.example",
              primary_buy_category: "Apparel", lead_source: "Referral", date_added: "2026-02-04" },
  invoice_count: INVOICES.length, total_revenue: 152630.5, total_profit: 15263,
  is_blacklisted: false, high_value: true, exclusive: false, last_contact_at: "2026-09-20",
};

// Long notes on purpose: a ledger line is where a card overflows first.
const CREDIT = {
  balance: 1240.5,
  entries: [
    { id: "e1", kind: "issued", amount: 1500, created_at: "2026-09-02T14:00:00Z", note: "Short count on the pallet of hoodies, agreed by phone",
      source_deal_flow_id: "d1", applied_deal_flow_id: null },
    { id: "e2", kind: "applied", amount: -259.5, created_at: "2026-09-18T10:00:00Z", note: "",
      source_deal_flow_id: null, applied_deal_flow_id: "d2" },
  ],
};

const EMPTY_OK = new Set([
  "list_interactions", "list_portal_links", "counterparty_payments", "list_clients",
  "list_suppliers", "list_custom_fields", "refund_status_all", "list_deals", "list_offers",
  "list_payment_methods", "list_line_item_templates", "list_lot_warnings", "list_bank_txns",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "get_client": return CLIENT;
    case "list_invoices_for_client": case "list_invoices": return INVOICES;
    case "list_deal_flows":
      return [
        FLOW("d1", "i1", "INV-0412", "complete", 18450),
        FLOW("d2", "i2", "INV-0398", "supplier_paid", 126880.5),
        FLOW("d3", "i3", "INV-0371", "complete", 7300),
      ];
    case "get_client_credit": return CREDIT;
    case "get_client_credit_status": return { credit_limit: 25000, exposure: 12400, available: 12600, over: false };
    case "get_buyer_tier":
      return { tier: "A", label: "A", reliability: "reliable", reliability_pct: 82,
               quotes_sent: 6, quotes_won: 5, total_paid: 152630.5, total_profit: 15263,
               deals_landed: 3, actual_paid: 152630.5, refunded: 0 };
    case "get_party_link": throw new Error("not supported in this fixture");
    case "get_company_info": return { name: "Example Co", address: "", email: "", phone: null, tax_id: null };
    default:
      // An empty list is the answer most screens survive: it has a length and a map, and a
      // missing field reads as undefined instead of throwing on null.
      if (EMPTY_OK.has(cmd) || screen !== "client") return [];
      return null;
  }
};

const ME = { id: "u1", display_name: "Test Owner", email: "owner@example.com", is_admin: true, permissions: [] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SCREENS: Record<string, () => any> = {
  client: () => <ClientDetailView clientId="c1" onBack={() => {}} />,
  dashboard: () => <DashboardView onNavigate={() => {}} me={ME as never} />,
  invoices: () => <InvoicesView />,
  inventory: () => <InventoryView />,
  suppliers: () => <SuppliersView />,
  analytics: () => <AnalyticsView />,
  financials: () => <FinancialsView />,
  dealflow: () => <DealFlowView />,
  tiers: () => <TiersView />,
  receivables: () => <ReceivablesView />,
  payables: () => <PayablesView />,
  brief: () => <BriefView currentUser={{ name: "Test Owner", role: "owner" }} />,
  clients: () => <ClientsView />,
  quotes: () => <QuotesView onNavigate={() => {}} />,
  settings: () => <SettingsView me={ME as never} />,
};

// The same column paneContent() wraps every screen in.
const Column = () => (
  <div className="p-7">
    <div className="max-w-[1280px] mx-auto">
      {(SCREENS[screen] || SCREENS.client)()}
    </div>
  </div>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen bg-bg">
    <aside style={{ width: nav, background: "#1b1b22" }} className="flex-shrink-0" />
    <main className="flex-1 overflow-hidden">
      {mode === "split" ? (
        <div className="flex h-full">
          <section id="left" className="min-w-0 overflow-auto pane-container" style={{ width: `${ratio * 100}%` }}>
            <Column />
          </section>
          <div className="w-1.5 flex-shrink-0" style={{ background: "var(--t-b1)" }} />
          <section id="right" className="flex-1 min-w-0 overflow-auto relative pane-container">
            <div className="h-10" />
            <Column />
          </section>
        </div>
      ) : (
        <div id="full" className="h-full overflow-auto">
          <Column />
        </div>
      )}
    </main>
  </div>,
);
