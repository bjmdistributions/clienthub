// DEV ONLY: the fixture behind harness/r670-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL FinancialsView (R-670: the books status strip,
// the regrouped sections and the Needs you list) on an invented bank. Every name and figure here is invented.
// ?state=good shows books that match the bank with nothing to answer. &dark=1 for the dark theme.
import ReactDOM from "react-dom/client";
import FinancialsView from "./components/FinancialsView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
let good = q.get("state") === "good";

const ACCT = "Rivermount Checking ··4417";
const txn = (
  id: string, posted_at: string, description: string, counterparty_name: string,
  direction: "in" | "out", amount: number, category: string, reviewed: boolean,
  extra: Record<string, unknown> = {},
) => ({
  id, posted_at, amount, direction, description,
  rail: "", category, counterparty_name, counterparty_type: counterparty_name ? "client" : "",
  counterparty_id: "", wire_ref: "", reviewed, account_id: ACCT,
  allocated: 0, alloc_count: 0, unallocated: amount, balance: null, posted_dt: null,
  confirmed_method: "", bank_method: null, note: "", pending: false, retracted: false,
  auto_booked_at: null, auto_booked_from: null, links: [] as unknown[], ...extra,
});

const TXNS = [
  txn("t9", "2026-11-17", "ACH CREDIT ORCHARD SUPPLY", "", "in", 4_120, "", false),
  txn("t10", "2026-11-17", "CARD PURCHASE FUEL STOP 22", "", "out", 38.75, "", false, { pending: true }),
  txn("t13", "2026-11-16", "WIRE OUT LAKESHORE FREIGHT", "", "out", 1_480, "", false),
  txn("t14", "2026-11-15", "BOX AND TAPE CO", "", "out", 212.4, "", false),
  txn("t1", "2026-11-12", "ZELLE FROM HARBOUR GOODS", "Harbour Goods", "in", 18_400, "receipt", true,
      { allocated: 18_400, alloc_count: 1, unallocated: 0, links: [{ deal_id: "d1", role: "buyer_payment", amount: 18_400 }] }),
  txn("t2", "2026-11-10", "WIRE OUT NORTHSIDE LIQUIDATORS", "Northside Liquidators", "out", 11_250, "payment", true,
      { allocated: 11_250, alloc_count: 1, unallocated: 0, confirmed_method: "wire", links: [{ deal_id: "d1", role: "supplier_payment", amount: 11_250 }] }),
  txn("t3", "2026-10-28", "FREIGHT MERIDIAN CARRIERS", "Meridian Carriers", "out", 1_960.55, "shipping", true),
  txn("t4", "2026-10-02", "SOFTWARE SUBSCRIPTION", "", "out", 64.99, "software", true, { note: "Annual plan" }),
  txn("t5", "2026-09-19", "DEPOSIT CEDAR LANE RESALE", "Cedar Lane Resale", "in", 7_300, "receipt", true,
      { allocated: 3_000, alloc_count: 1, unallocated: 4_300, links: [{ deal_id: "d2", role: "buyer_payment", amount: 3_000 }] }),
  txn("t6", "2026-09-04", "CARD PURCHASE PALLET WRAP", "", "out", 212.4, "packaging", true),
  txn("t7", "2026-08-15", "OWNER DRAW", "", "out", 5_000, "owner_draw", true),
  txn("t8", "2026-08-01", "REFUND HARBOUR GOODS", "Harbour Goods", "out", 900, "customer_refund", true),
];

const DEALS = [
  { id: "d1", name: "Harbour Goods sneaker load", invoice_id: "i1", stage: "complete",
    payment_received_amount: 18_400, deposit_amount: 0, payment_received_method: null,
    payment_received_at: "2026-11-12", supplier_payments_json: "[]", supplier_payments: [],
    total_supplier_cost: 11_250, completed_at: "2026-11-12", gross_revenue: 18_400,
    total_cost: 11_250, net_profit: 7_150, profit_jack: 0, profit_ben: 0, profit_business: 7_150,
    notes: null, created_at: "2026-11-01", updated_at: "2026-11-12",
    invoice_number: "1041", client_id: "c1", client_name: "Harbour Goods", invoice_total: 18_400 },
  { id: "d2", name: "Cedar Lane homeware", invoice_id: "i2", stage: "invoiced",
    payment_received_amount: 3_000, deposit_amount: 3_000, payment_received_method: null,
    payment_received_at: null, supplier_payments_json: "[]", supplier_payments: [],
    total_supplier_cost: 0, completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0,
    profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null,
    created_at: "2026-09-10", updated_at: "2026-09-19",
    invoice_number: "1042", client_id: "c2", client_name: "Cedar Lane Resale", invoice_total: 7_300 },
];

const side = (id: string, date: string, description: string, extra: object = {}) =>
  ({ id, account: ACCT, date, amount: 640, direction: "out", description, source: "plaid", pending: false, category: "", booked: false, counterparty: "", links: [], ...extra });
let pairs = [{ keep: side("n1", "2026-11-09", "DOCK RENTAL NOV", { booked: true, category: "rent" }), extra: side("n2", "2026-11-11", "DOCK RENTAL 0042", { source: "pdf" }), reason: "two_sources", gap_days: 2, automatic: false }];
let retracted = [
  { id: "r1", date: "2026-11-08", amount: 58.2, direction: "out", description: "PINE STREET GRILL", account: ACCT, category: "meals", booked: true, cancelled: false,
    matches: [{ id: "r1p", date: "2026-11-10", amount: 68.2, description: "PINE STREET GRILL", category: "", booked: false, automatic: false, blocked: null }] },
  { id: "r2", date: "2026-10-20", amount: 129.99, direction: "out", description: "LAKESIDE TICKETS", account: ACCT, category: "gifts", booked: true, cancelled: true, matches: [] },
];
let declined: any[] = [
  { id: "missing:b1", txn_id: "b1", source: "plaid", reason: "missing", account_id: ACCT, posted_at: "2026-10-30", amount: 310, direction: "out", description: "CITY UTILITIES",
    matched: [], bank: { removed_before: true }, status: "open", resolved_by: "", resolved_at: "", created_at: "2026-11-17" },
  { id: "not_at_bank:b2", txn_id: "b2", source: "plaid", reason: "not_at_bank", account_id: ACCT, posted_at: "2026-10-12", amount: 2_400, direction: "in", description: "BUYER WIRE MESA OUTLET",
    matched: ["b2"], bank: {}, status: "open", resolved_by: "", resolved_at: "", created_at: "2026-11-16" },
];
const check = () => ({
  checked_at: new Date().toISOString(), accounts: [{ account: ACCT, posted: 412, exact: good ? 412 : 410, not_exact: good ? 0 : 2, from_statement: 0, clean: good }],
  missing: good ? 0 : 1, differs: 0, not_at_bank: good ? 0 : 1, new_rows: 0, closed: 0, errors: [],
  fixed: { imported: 3, amended: 2, removed: 1, moved: 1, two_payments: 4, copies: 2, agreed: 1 },
});
const sum = (dir: "in" | "out") => TXNS.filter((t) => t.direction === dir).reduce((s, t) => s + t.amount, 0);
const acct = (key: string, name: string, mask: string, type: string, balance: number, drift: number) =>
  ({ key, item: "pi_a", institution: "Rivermount Bank", name, mask, type, subtype: "", balance, available: null, label: `${name} ··${mask}`, drift, ledger_rows: 400 });

(window as any).__FIXTURE = (cmd: string, args: any) => {
  switch (cmd) {
    case "list_bank_txns": return TXNS;
    case "list_deal_flows": return DEALS;
    case "bank_txn_summary": return { total: TXNS.length, reviewed: TXNS.filter((t) => t.reviewed).length, sum_in: sum("in"), sum_out: sum("out"), unallocated_in: 0, unallocated_out: 0, unclassified: 4 };
    case "list_near_duplicates": return good ? [] : pairs;
    case "list_retracted": return good ? [] : retracted;
    case "list_bank_declined": return { rows: good ? [] : declined, check: check() };
    case "resolve_near_duplicate": pairs = pairs.filter((p) => p.keep.id !== args.keepId); return { removed: true };
    case "take_over_booking": case "remove_cancelled_txn": case "mark_takeover_not_same":
      retracted = retracted.filter((r) => r.id !== (args.fromId ?? args.id ?? args.retractedId)); return { moved: true, removed: true, deals: 0 };
    case "resolve_bank_declined":
      if (args.action === "remove") return { ok: false, delete: { needs_unlink: [{ id: "b2", deals: ["1042 for Cedar Lane Resale"] }] } };
      declined = declined.filter((d) => d.id !== args.id); return { ok: true, status: "done" };
    case "check_against_bank": good = true; return check();
    case "plaid_health": return { banks: [], warnings: [], last_sync: new Date().toISOString() };
    case "bank_balances": return { last_sync: new Date().toISOString(), reserve_key: "", accounts: [
      acct("a1", "Rivermount Checking", "4417", "depository", 48_210.55, good ? 0 : -310),
      acct("a2", "Rivermount Savings", "2290", "depository", 120_000, 0),
      acct("a3", "Business Rewards", "7731", "credit", -3_920.18, 0),
    ] };
    case "bank_branding": return { pi_a: { logo: null, color: "teal" } };
    case "reconcile_accounts": return [];
    case "personal_me": return { owner: false };
    case "financials_overview": return { tax_base: 64_000, tax_reserve: 19_200, tax_paid: 4_000, tax_should_have: 15_200, tax_sweep_pct: 0.3, reserve_account_key: "", balance_source: "plaid", tax_extra: { uncategorised_rows: 4 } };
    case "get_money_config": return { bank_balance: 0, credit_card_balance: 0, cash_floor: 0, tax_sweep_pct: 0.3, refund_reserve_pct: 0, war_chest: 0 };
    case "cleanup_ghost_deal_flows": return 0;
    // The server is not reachable from a harness: the screens that ask it show their offline state.
    case "payouts_request": throw new Error("offline");
    default:
      return /^get_|_info$|_config$|_status$|_summary$|_overview$|_me$/.test(cmd) ? {} : [];
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen p-7 max-w-[1280px]">
    <FinancialsView />
    <ToastHost />
  </div>,
);
