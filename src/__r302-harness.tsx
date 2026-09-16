// DEV ONLY — the fixture behind r302-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL DealFlowView for R-302..R-305: the payment pill in each of its five
// states, the supplier dot filling on cost alone, Pending profit, and the refunds list
// with a closed-out and an open whole-lot refund. Every name and figure is invented.
import ReactDOM from "react-dom/client";
import DealFlowView from "./components/DealFlowView";
import "./index.css";

type Leg = { amount: number; paid?: boolean; kept?: boolean };
const legs = (name: string, ls: Leg[]) => ls.map((l, i) => ({
  id: `${name}-${i}`, supplier_name: name, amount: l.amount, quantity: 1, unit_price: l.amount,
  paid: !!l.paid, kept: !!l.kept, category: (l as any).category ?? "supplier", supplier_billed: !!(l as any).supplier_billed,
}));

const FLOW = (
  id: string, n: number, client: string, stage: string, total: number,
  sup: ReturnType<typeof legs>, extra: Record<string, unknown> = {},
) => ({
  id, invoice_id: `i${n}`, name: null, stage, payment_received_amount: 0, deposit_amount: 0,
  payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
  supplier_payments: sup, total_supplier_cost: sup.filter((p) => !p.kept).reduce((s, p) => s + p.amount, 0),
  supplier_owed: sup.filter((p) => !p.kept && !p.paid && (!p.category || p.category === "supplier" || p.supplier_billed)).reduce((s, p) => s + p.amount, 0),
  own_costs_unpaid: sup.filter((p) => !p.kept && !p.paid && p.category && p.category !== "supplier" && !p.supplier_billed).reduce((s, p) => s + p.amount, 0),
  own_costs_total: sup.filter((p) => !p.kept && p.category && p.category !== "supplier" && !p.supplier_billed).reduce((s, p) => s + p.amount, 0),
  completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0, profit_jack: 0, profit_ben: 0,
  profit_business: 0, notes: null, metadata: "{}", created_at: "2026-08-20", updated_at: "2026-09-10",
  invoice_number: `INV-${1000 + n}`, client_id: `c${n}`, client_name: client, invoice_total: total,
  pickup_date: null, expected_delivery_date: null, ships_direct: true, ...extra,
});

const FLOWS = [
  FLOW("d1", 1, "Northside Resale", "invoiced", 12400, []),
  FLOW("d2", 2, "Harbor Wholesale", "invoiced", 18000, legs("Tri-State Returns", [{ amount: 12500 }])),
  FLOW("d3", 3, "Prairie Goods", "supplier_paid", 26350, legs("Delta Overstock", [{ amount: 19800, paid: true }]),
    { payment_received_amount: 26350, payment_received_at: "2026-09-02" }),
  FLOW("d4", 4, "Lakeview Liquidators", "invoiced", 9200, legs("Keystone Pallets", [{ amount: 6100, paid: true }])),
  FLOW("d5", 5, "Summit Outlet", "payment_received", 14750, legs("Granite Surplus", [{ amount: 9900 }, { amount: 450 }]),
    { payment_received_amount: 14750, payment_received_at: "2026-09-08" }),
  FLOW("d6", 6, "Coastal Bins", "complete", 16000, legs("Harborline Supply", [{ amount: 11800, paid: true }]),
    { completed_at: "2026-09-01", gross_revenue: 16000, total_cost: 11800, net_profit: 4200 }),
  FLOW("d7", 7, "Ridge Traders", "complete", 9500, legs("Pinecrest Goods", [{ amount: 7000, paid: true }]),
    { completed_at: "2026-08-12", gross_revenue: 9500, total_cost: 7000, net_profit: 2500,
      notes: "Buyer rejected the load on arrival (wet pallets). Supplier credited 4,000 against the next load." }),
  FLOW("d8", 8, "Maple Surplus", "supplier_paid", 6000, legs("Birchwood Returns", [{ amount: 4300, paid: true }]),
    { payment_received_amount: 6000 }),
];

const ITEMS: Record<number, [string, number, number][]> = {
  1: [["Mixed apparel pallets", 8, 1550]],
  2: [["Small appliances, shelf pulls", 12, 1500]],
  3: [["Name-brand sneakers, mixed sizes", 1700, 15.5]],
  4: [["Home goods truckload", 1, 9200]],
  5: [["Toys, overstock", 590, 25]],
  6: [["Electronics accessories", 4000, 4]],
  7: [["Outdoor furniture", 38, 250]],
  8: [["Kitchenware returns", 1500, 4]],
};

const INVOICES = FLOWS.map((f, i) => ({
  id: f.invoice_id, client_id: f.client_id, number: f.invoice_number, issue_date: "2026-08-20",
  due_date: "2026-09-03", subtotal: f.invoice_total, tax: 0, total: f.invoice_total,
  line_items_json: JSON.stringify((ITEMS[i + 1] || []).map(([description, qty, rate]) => ({ description, qty, rate, amount: qty * rate }))),
  status: f.stage === "invoiced" ? "sent" : "paid", is_complete: f.stage === "complete", voided: false,
  deal_flow_id: f.id, deal_flow_stage: f.stage, notes: "",
}));

const RECON = FLOWS.map((f) => ({
  deal_flow_id: f.id,
  payment_received_paired: f.id === "d3",
  supplier_paid_paired: false, fully_reconciled: false, has_payment: false,
  has_financials: f.id === "d3", no_buyer_link: false, no_supplier_link: false,
  needs_financials: false, buyer_missing: false, supplier_missing: false, needs_review: false,
}));

const REFUNDS = [
  { deal_flow_id: "d6", refund_owed: 3000, refunded: 3000, remaining: 0, done: false },
  { deal_flow_id: "d7", refund_owed: 9500, refunded: 9500, remaining: 0, done: true },
  { deal_flow_id: "d8", refund_owed: 6000, refunded: 2000, remaining: 4000, done: false },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "list_deal_flows": return FLOWS;
    case "list_invoices": return INVOICES;
    case "get_invoice": return INVOICES.find((i) => i.id === args?.id) ?? null;
    case "reconciliation_status_all": return RECON;
    case "refund_status_all": return REFUNDS;
    case "cleanup_ghost_deal_flows": return 0;
    case "deal_reconciliation": {
      const f = FLOWS.find((x) => x.id === args?.dealFlowId);
      return {
        expected_profit: f ? f.invoice_total - f.total_supplier_cost : 0, gross_revenue: 0, total_cost: 0,
        actual_profit: f ? f.invoice_total - f.total_supplier_cost : 0,
        pieces: { buyer_paired: f?.id === "d3" ? 26350 : 0, supplier_paired: 0, fee_paired: 0, refund_total: 0, refund_in: 0 },
        payment_received_paired: f?.id === "d3", supplier_paid_paired: false, fully_reconciled: false,
      };
    }
    case "deal_flow_payout": {
      const r = REFUNDS.find((x) => x.deal_flow_id === args?.dealFlowId);
      return { refund_owed: r?.refund_owed ?? 0, refunded: r?.refunded ?? 0, shortage: null };
    }
    case "unallocated_bank_txns": return { money_in: [], money_out: [] };
    case "deal_allocations": case "list_deal_receipts": case "list_refunds":
    case "list_shipments": case "get_payout_split": case "list_bank_txns":
      return [];
    default: return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen p-6">
    <DealFlowView />
  </div>,
);
