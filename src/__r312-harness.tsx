// DEV ONLY — the fixture behind r312-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL FinancialsView for R-312: the Ledger's Export CSV button. The half
// worth seeing here is the half no unit test can reach — WHICH rows the click hands to
// `export_ledger_csv`. The fixture records the call on `window.__EXPORTED`, so the
// answer can be read back and compared against the rows on screen.
//
// Every name, payee, account and figure below is invented.
import ReactDOM from "react-dom/client";
import FinancialsView from "./components/FinancialsView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const txn = (
  id: string, posted_at: string, description: string, counterparty_name: string,
  direction: "in" | "out", amount: number, category: string, reviewed: boolean,
  extra: Record<string, unknown> = {},
) => ({
  id, posted_at, amount, direction, description,
  rail: "", category, counterparty_name, counterparty_type: counterparty_name ? "client" : "",
  counterparty_id: "", wire_ref: "", reviewed, account_id: "Rivermount Checking ··4417",
  allocated: 0, alloc_count: 0, unallocated: amount, balance: null, posted_dt: null,
  confirmed_method: "", bank_method: null, note: "", pending: false, retracted: false,
  auto_booked_at: null, auto_booked_from: null, links: [] as unknown[], ...extra,
});

// Two years, so the tax-year filter has something to exclude; booked and unbooked in
// each, so the Booked scope does too.
const TXNS = [
  txn("t1", "2026-09-12", "ZELLE FROM HARBOUR GOODS", "Harbour Goods", "in", 18_400, "receipt", true,
      { allocated: 18_400, alloc_count: 1, unallocated: 0,
        links: [{ deal_id: "d1", role: "buyer_payment", amount: 18_400 }] }),
  txn("t2", "2026-09-10", "WIRE OUT — NORTHSIDE LIQUIDATORS", "Northside Liquidators", "out", 11_250, "payment", true,
      { allocated: 11_250, alloc_count: 1, unallocated: 0, confirmed_method: "wire",
        links: [{ deal_id: "d1", role: "supplier_payment", amount: 11_250 }] }),
  txn("t3", "2026-08-28", "FREIGHT — MERIDIAN CARRIERS", "Meridian Carriers", "out", 1_960.55, "shipping", true),
  txn("t4", "2026-08-02", "SOFTWARE SUBSCRIPTION", "", "out", 64.99, "software", true, { note: "Annual plan" }),
  txn("t5", "2026-07-19", "DEPOSIT — CEDAR LANE RESALE", "Cedar Lane Resale", "in", 7_300, "receipt", true,
      { allocated: 3_000, alloc_count: 1, unallocated: 4_300,
        links: [{ deal_id: "d2", role: "buyer_payment", amount: 3_000 }] }),
  txn("t6", "2026-07-04", "CARD PURCHASE — PALLET WRAP", "", "out", 212.4, "packaging", true),
  txn("t7", "2026-06-15", "OWNER DRAW", "", "out", 5_000, "owner_draw", true),
  txn("t8", "2026-06-01", "REFUND — HARBOUR GOODS", "Harbour Goods", "out", 900, "customer_refund", true),
  // Still in the queue: must be absent from a Booked export, present in an All one.
  txn("t9", "2026-09-14", "ACH CREDIT — UNKNOWN PAYER", "", "in", 4_120, "", false),
  txn("t10", "2026-09-13", "CARD PURCHASE — PENDING", "", "out", 38.75, "", false, { pending: true }),
  // Last year: excluded by the tax-year filter.
  txn("t11", "2025-11-22", "ZELLE FROM HARBOUR GOODS", "Harbour Goods", "in", 9_800, "receipt", true),
  txn("t12", "2025-10-05", "WIRE OUT — NORTHSIDE LIQUIDATORS", "Northside Liquidators", "out", 6_400, "payment", true),
];

const DEALS = [
  { id: "d1", name: "Harbour Goods — sneaker load", invoice_id: "i1", stage: "complete",
    payment_received_amount: 18_400, deposit_amount: 0, payment_received_method: null,
    payment_received_at: "2026-09-12", supplier_payments_json: "[]", supplier_payments: [],
    total_supplier_cost: 11_250, completed_at: "2026-09-12", gross_revenue: 18_400,
    total_cost: 11_250, net_profit: 7_150, profit_jack: 0, profit_ben: 0, profit_business: 7_150,
    notes: null, created_at: "2026-09-01", updated_at: "2026-09-12",
    invoice_number: "1041", client_id: "c1", client_name: "Harbour Goods", invoice_total: 18_400 },
  { id: "d2", name: "Cedar Lane — homeware", invoice_id: "i2", stage: "invoiced",
    payment_received_amount: 3_000, deposit_amount: 3_000, payment_received_method: null,
    payment_received_at: null, supplier_payments_json: "[]", supplier_payments: [],
    total_supplier_cost: 0, completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0,
    profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null,
    created_at: "2026-07-10", updated_at: "2026-07-19",
    invoice_number: "1042", client_id: "c2", client_name: "Cedar Lane Resale", invoice_total: 7_300 },
];

const sum = (dir: "in" | "out") => TXNS.filter((t) => t.direction === dir).reduce((s, t) => s + t.amount, 0);

const EMPTY_OK = new Set([
  "list_loans", "list_txn_rules", "list_takeover_suggestions", "list_clients", "list_suppliers",
  "list_plaid_items", "list_bank_accounts", "bank_suggestions_bulk", "list_bank_allocations",
  "list_invoices", "list_categories", "list_reserve_rules",
]);

(window as any).__EXPORTED = null;
(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "list_bank_txns": return TXNS;
    case "list_deal_flows": return DEALS;
    case "bank_txn_summary": return {
      total: TXNS.length, reviewed: TXNS.filter((t) => t.reviewed).length,
      sum_in: sum("in"), sum_out: sum("out"),
      unallocated_in: 0, unallocated_out: 0, unclassified: 2,
    };
    // The dialog plugin, answered so the click runs the whole way through.
    case "plugin:dialog|save":
      (window as any).__SAVE_ARGS = args;
      return "C:/invented/ledger.csv";
    case "export_ledger_csv":
      (window as any).__EXPORTED = args;
      return (args?.ids ?? []).length;
    case "cleanup_ghost_deal_flows": return 0;
    default:
      if (EMPTY_OK.has(cmd)) return [];
      // Everything else this screen touches on mount: a list unless the name says
      // it is a single record. `null` throws inside the callers, which is noise here.
      return /^get_|_info$|_config$|_status$|_summary$/.test(cmd) ? {} : [];
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen p-6">
    <FinancialsView />
    <ToastHost />
  </div>,
);
