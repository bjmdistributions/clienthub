// DEV ONLY — the fixture behind r235-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// It renders the REAL components, so what is under test is the shipping code and not a
// copy of it that can drift.
import ReactDOM from "react-dom/client";
import ClientDetailView from "./components/ClientDetailView";
import InvoicesView from "./components/InvoicesView";
import InventoryView from "./components/InventoryView";
import "./index.css";

const screen = new URLSearchParams(location.search).get("screen") || "client";

// Shapes copied from the live DB (2026-09-03): line_items_json is a STRING, and the
// three buckets below are the three states that actually occur — complete, voided, and
// mid-flow. The one-row collision (voided AND complete) is included on purpose: it is
// the case Jack decided fell-through wins.
const inv = (
  id: string, number: string, total: number, items: [string, number, number][],
  extra: Record<string, unknown> = {},
) => ({
  id, client_id: "c1", number, issue_date: "2026-07-14", due_date: "2026-07-28",
  line_items_json: JSON.stringify(items.map(([description, qty, rate]) => ({
    description, qty, rate, amount: qty * rate,
  }))),
  subtotal: total, tax: 0, total, status: "paid", pdf_path: null, sent_at: "2026-07-14",
  notes: "", cost_items_json: null, total_cost: 0, profit: 0, margin: 0, carrier: null,
  tracking_number: null, shipping_charged: 0, pickup_date: null, delivery_date: null,
  is_complete: false, deal_flow_id: null, deal_flow_stage: "none", voided: false,
  return_policy: "", ...extra,
});

const INVOICES = [
  inv("i1", "INV-0202", 29736, [["Nike Dunks", 400, 18.5], ["Shipping", 1, 900]],
      { is_complete: true, deal_flow_id: "d1", deal_flow_stage: "complete" }),
  inv("i2", "INV-0201", 185259.4, [["NIKE, JORDAN, NEW BALANCE, ADIDAS, HOKA, ON CLOUD mixed shoes", 9800, 18.9]],
      { deal_flow_id: "d2", deal_flow_stage: "supplier_paid" }),
  inv("i3", "INV-0186", 158348.1, [["NFL Licensed apparel MIXED SIZES MIXED TEAMS (3800 units)", 3800, 41.67]],
      { voided: true, deal_flow_id: "d3", deal_flow_stage: "invoiced" }),
  inv("i4", "INV-0180", 22000, [["New Era Hats", 1000, 5.25], ["Crocs", 800, 21.0]],
      { is_complete: true, deal_flow_id: "d4", deal_flow_stage: "complete" }),
  // The collision: complete AND voided. Must land in "fell through", not "completed".
  inv("i5", "INV-0164", 4230, [["Asics Shoes", 200, 21.15]],
      { is_complete: true, voided: true, deal_flow_id: "d5", deal_flow_stage: "complete" }),
];

const FLOW = (id: string, invoice_id: string, invoice_number: string, stage: string, total: number) => ({
  id, invoice_id, name: null, stage, payment_received_amount: 0, payment_received_method: "",
  payment_received_at: null, supplier_payments: [], total_supplier_cost: 0, completed_at: null,
  gross_revenue: total, total_cost: 0, net_profit: total * 0.1, profit_jack: 0, profit_ben: 0,
  profit_business: 0, notes: "", created_at: "2026-07-01", updated_at: "2026-07-14",
  invoice_number, client_id: "c1", client_name: "SouthJerzAuctions", invoice_total: total,
  refund_owed: 0, archived: false,
});

const CLIENT = {
  id: "c1", name: "SouthJerzAuctions", email: "buyer@example.com", phone: "5551234567",
  company: "South Jerz Auctions", notes: "", billing_status: "good", lead_status: "customer",
  created_at: "2026-01-04", updated_at: "2026-07-14", metadata: { city: "Vineland", state: "NJ" },
  invoice_count: INVOICES.length, total_revenue: 399573.5, total_profit: 40000,
  is_blacklisted: false, high_value: true, exclusive: false, last_contact_at: "2026-07-20",
};

const LOTS = [
  { id: "l1", name: "Chaco Sandals", description: "Mixed sizes, new with tags", category: "Shoes",
    quantity: 900, total_cost: 9000, asking_price: 17, status: "available", linked_deal_id: null,
    photos_json: "[]", created_at: "2026-08-30", updated_at: "2026-08-30", notes: null,
    sent_whatsapp: false, sent_email: false, sent_facebook: false, supplier: "Big Lots return co",
    location: "Vineland, NJ", manifest_path: null, price_type: "per_unit", details_json: null },
  { id: "l2", name: "Bed Sheet Sets", description: null, category: "General Merchandise",
    quantity: 1200, total_cost: 4000, asking_price: 6, status: "available", linked_deal_id: null,
    photos_json: "[]", created_at: "2026-08-29", updated_at: "2026-08-29", notes: null,
    sent_whatsapp: false, sent_email: false, sent_facebook: false, supplier: null,
    location: "PA", manifest_path: null, price_type: "per_unit", details_json: null },
];

// The two answers Find matches must be able to give: real buyers with their evidence,
// and — for the lot with no close history — nothing at all.
const MATCHES: Record<string, unknown[]> = {
  l1: [
    { client_id: "c9", client_name: "Zayd", score: 100, bought: "Adidas Shoes Pink Sambas",
      unit_price: 19.5, qty: 300, invoice_id: "i9", invoice_number: "INV-0140",
      issue_date: "2026-06-11", closed: true, price_close: true, shared: ["shoes"] },
    { client_id: "c8", client_name: "Miles Campbell", score: 100, bought: "Asics Shoes",
      unit_price: 22, qty: 200, invoice_id: "i8", invoice_number: "INV-0131",
      issue_date: "2026-05-13", closed: true, price_close: true, shared: ["shoes"] },
    { client_id: "c7", client_name: "Dylan Sanders", score: 75, bought: "Adidas Shoes",
      unit_price: 23, qty: 150, invoice_id: "i7", invoice_number: "INV-0122",
      issue_date: "2026-04-02", closed: true, price_close: false, shared: ["shoes"] },
  ],
  l2: [],
};

const EMPTY_OK = new Set([
  "list_interactions", "list_portal_links", "counterparty_payments", "list_clients",
  "list_suppliers", "list_custom_fields", "refund_status_all", "list_deals", "list_offers",
  "list_payment_methods", "list_line_item_templates", "list_lot_warnings", "list_bank_txns",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "get_client": return CLIENT;
    case "list_invoices_for_client": return INVOICES;
    case "list_invoices": return INVOICES;
    case "list_deal_flows":
      return [
        FLOW("d1", "i1", "INV-0202", "complete", 29736),
        FLOW("d2", "i2", "INV-0201", "supplier_paid", 185259.4),
        FLOW("d4", "i4", "INV-0180", "complete", 22000),
      ];
    case "get_buyer_tier":
      return { tier: "P", label: "Platinum", reliability: "reliable", reliability_pct: 78,
               quotes_sent: 9, quotes_won: 7, total_paid: 399573.5, total_profit: 40000,
               deals_landed: 4, actual_paid: 399573.5, refunded: 0 };
    case "get_party_link": throw new Error("not supported in this fixture");
    case "list_lots": case "list_inventory": return LOTS;
    case "find_lot_matches": return MATCHES[args?.lotId] ?? [];
    case "get_storefront_config": return null;
    case "get_company_info": return { name: "BJM Distributions", address: "", email: "", phone: null, tax_id: null };
    default:
      if (EMPTY_OK.has(cmd)) return [];
      return null;
  }
};

const Screen = () => {
  if (screen === "invoices") return <InvoicesView />;
  if (screen === "inventory") return <InventoryView />;
  return <ClientDetailView clientId="c1" onBack={() => {}} />;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <Screen />
  </div>,
);
