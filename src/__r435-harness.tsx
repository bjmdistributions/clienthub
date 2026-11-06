// DEV ONLY: the fixture behind r435-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build. Every figure is invented.
// R-435/R-438: the refund step of a fully refunded deal whose cost was moved to the deal the
// goods were sold again on. ?closed=1 shows it closed; ?owed=1 leaves money still owed.
import ReactDOM from "react-dom/client";
import RefundWorkspace from "./components/RefundWorkspace";
import "./index.css";

const q = new URLSearchParams(location.search);
const closed = q.get("closed") === "1";
const owed = q.get("owed") === "1";
// R-442: ?r442=1 is a refund with two payments, before the resell; ?r442=done is after a buy-back.
const r442 = q.get("r442");
const AT = "2026-10-05T14:02:11.000Z";
const line = (id: string, amount: number, notes: string | null) => ({
  id, supplier_name: "Northfield Liquidators", supplier_id: "s1", amount, original_amount: amount,
  price_changed: false, quantity: null, unit_price: null, method: null, notes, paid: true, paid_at: AT,
  category: "supplier", kept: false, supplier_billed: false,
});
const meta = {
  resold_to: [{ deal_flow_id: "df_b", invoice_number: "INV-2057", amount: 8000, moved_bank: 8000, at: AT }],
  ...(closed ? { refund_done: true, refund_done_at: "2026-10-05T15:00:00.000Z" } : {}),
};
const deal = (id: string, number: string, client: string, gross: number, lines: any[], metadata: any) => ({
  id, name: null, invoice_id: "inv_" + id, stage: "complete", payment_received_amount: gross, deposit_amount: 0,
  payment_received_method: null, payment_received_at: null, supplier_payments_json: "[]",
  supplier_payments: lines, total_supplier_cost: lines.reduce((s, l) => s + l.amount, 0), total_cost: 0,
  gross_revenue: gross, invoice_total: gross, net_profit: 0, completed_at: "2026-09-20", metadata: JSON.stringify(metadata),
  invoice_number: number, client_name: client, updated_at: "2026-10-05",
});
const boughtBack = { kind: "refunds", buyer: "Harbor Point Outlet", deal_flow_id: "df_b", invoice_number: "INV-2057", amount: 10000, moved_bank: 10000, at: AT };
const flows = r442 ? [
  deal("df_a", "INV-2041", "Harbor Point Outlet", 10000, [line("l1", 6000, null), line("l1b", 2000, null)], r442 === "done" ? { resold_to: [boughtBack] } : {}),
  deal("df_b", "INV-2057", "Lakeview Resale Co", 9000, [], {}),
] : [
  deal("df_a", "INV-2041", "Harbor Point Outlet", 10000, [line("l1", 8000, null), line("l2", -8000, "Resold: cost moved to INV-2057")], meta),
  deal("df_b", "INV-2057", "Lakeview Resale Co", 9000, [line("l3", 8000, "Resold from INV-2041: cost moved here")], { resold_from: [{ deal_flow_id: "df_a", invoice_number: "INV-2041", amount: 8000, moved_bank: 8000, at: AT }] }),
];
const refunded = owed ? 6000 : 10000;
(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "deal_allocations": if (r442) return [
      { id: "al1", role: "buyer_payment", amount: 10000, posted_at: "2026-09-14", counterparty_name: "Harbor Point Outlet", description: "" },
      { id: "al_s1", role: "supplier_payment", amount: 6000, posted_at: "2026-09-15", counterparty_name: "Northfield Liquidators", description: "" },
      { id: "al_s2", role: "supplier_payment", amount: 2000, posted_at: "2026-09-16", counterparty_name: "Ridgeway Freight Co", description: "" },
    ]; return [{ id: "al1", role: "buyer_payment", amount: 10000, posted_at: "2026-09-14", counterparty_name: "Harbor Point Outlet", description: "" }];
    case "list_deal_receipts": return [];
    case "list_refunds": if (r442) return r442 === "done" ? [] : [
      { id: "al_r1", amount: 6000, reason: "Wire to Harbor Point Outlet", refunded_at: "2026-09-18", source: "", bank_txn_id: "t1", origin: "allocation" },
      { id: "rf_r2", amount: 4000, reason: "Buyer returned the load", refunded_at: "2026-09-22", source: "business", bank_txn_id: "t2", origin: "refund" },
    ]; return [{ id: "rf1", amount: refunded, reason: "Buyer returned the load", source: "business", bank_txn_id: "t9", origin: "refund" }];
    case "deal_flow_payout": if (r442) return r442 === "done" ? { refund_owed: 0, refunded: 0, owed_remaining: 0, splits: [] } : { refund_owed: 10000, refunded: 10000, owed_remaining: 0, splits: [] };
      return { refund_owed: 10000, refunded, owed_remaining: 10000 - refunded, splits: [] };
    case "unallocated_bank_txns": return { money_in: [], money_out: [] };
    case "get_deal_flow": return flows[0];
    case "list_deal_flows": return flows;
    case "set_refund_done": return null;
    default: return null;
  }
};
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-bg p-8"><div className="max-w-[560px]"><RefundWorkspace dealFlowId="df_a" primary /></div></div>,
);
