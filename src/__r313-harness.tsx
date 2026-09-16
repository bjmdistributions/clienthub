// DEV ONLY — the fixture behind r313-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL DashboardView and AnalyticsView with invented figures so the
// R-313 tiles (true net, shipping, bank and wire fees) can be seen on both screens.
import ReactDOM from "react-dom/client";
import DashboardView from "./components/DashboardView";
import AnalyticsView from "./components/AnalyticsView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const monthly = MONTHS.map((m, i) => {
  const revenue = 42_000 + i * 9_500, cost = 27_000 + i * 6_100;
  const profit = revenue - cost, shipping = 1_200 + i * 640, fees = 95 + i * 30;
  return {
    month: m, revenue, cost, profit, shipping, fees, true_net: profit - shipping - fees,
    count: 5 + i, margin_pct: (profit / revenue) * 100, overhead_pct: ((shipping + fees) / revenue) * 100,
  };
});
const sum = (k: "revenue" | "cost" | "profit" | "shipping" | "fees" | "true_net") => monthly.reduce((s, m) => s + m[k], 0);
const last = monthly[monthly.length - 1], prev = monthly[monthly.length - 2];

const STATS = {
  clients: 48, invoices: 61, outstanding: 18_250, total_clients: 48, open_deals: 5, completed_this_month: 3,
  revenue_all_time: sum("revenue"), revenue_prev_month: prev.revenue,
  profit_all_time: sum("profit"), profit_prev_month: prev.profit,
  paid_ytd: sum("revenue"), revenue_this_week: 9_800, clients_this_week: 2, interactions_this_week: 14,
  total_cost: sum("cost"), total_profit: sum("profit"), avg_margin: 34.2,
  monthly_profit: monthly,
  top_clients_by_profit: [
    { name: "Harbour Goods", total_revenue: 61_000, total_profit: 22_400, margin: 36.7 },
    { name: "Cedar Lane Resale", total_revenue: 38_500, total_profit: 11_900, margin: 30.9 },
  ],
  pipeline_value: 74_000, pipeline_count: 5, incomplete_shipping: 2,
  category_breakdown: [
    { category: "Apparel", client_count: 12, revenue: 88_000 },
    { category: "Footwear", client_count: 9, revenue: 61_000 },
    { category: "Home and kitchen", client_count: 7, revenue: 44_500 },
    { category: "Toys and seasonal", client_count: 5, revenue: 28_900 },
    { category: "Electronics", client_count: 4, revenue: 19_400 },
    { category: "Health and beauty", client_count: 3, revenue: 11_200 },
    { category: "General returns", client_count: 2, revenue: 6_800 },
  ],
  invoice_status_breakdown: [{ status: "paid", count: 52, total: 300_000 }, { status: "sent", count: 4, total: 18_250 }],
  top_spenders: [{ name: "Harbour Goods", company: null, invoice_count: 9, total_spent: 61_000, total_profit: 22_400, last_invoice: "2026-09-12" }],
  loss_deals_this_month: 0, loss_total_this_month: 0,
  revenue_mtd: last.revenue, profit_mtd: last.profit, deals_mtd: 3,
  top_suppliers: [{ name: "Northside Liquidators", contact_name: "", deal_count: 7, total_paid: 140_000 }],
  all_time_revenue: sum("revenue"), refunded_total: 2_400, refund_owed_remaining: 0, deals_won_all: 52, deals_lost_all: 4,
  shipping_mtd: last.shipping, fees_mtd: last.fees, shipping_prev_month: prev.shipping, fees_prev_month: prev.fees,
  shipping_all_time: sum("shipping"), fees_all_time: sum("fees"),
  true_net_mtd: last.true_net, true_net_prev_month: prev.true_net, true_net_all_time: sum("true_net"),
  true_net_enabled: false,
};

// R-316 extends this fixture with every advanced aggregate the redesigned Analytics
// screen reads. Every name and figure below is invented — nothing here is real data.
const REV_CLIENTS = [
  { name: "Harbour Goods", revenue: 118_400, profit: 31_200 },
  { name: "Cedar Lane Resale", revenue: 74_900, profit: 18_050 },
  { name: "Tidewater Outlet", revenue: 52_300, profit: 9_400 },
  { name: "Maple Row Trading", revenue: 38_100, profit: 7_650 },
  { name: "Quarry Street Wholesale", revenue: 24_600, profit: 3_900 },
  { name: "Northgate Bargain Co", revenue: 15_200, profit: 2_100 },
  { name: "Everyone else", revenue: 21_500, profit: 3_300 },
];
const REV_TOTAL = REV_CLIENTS.reduce((s, c) => s + c.revenue, 0);
const SUPPLIERS = [
  { name: "Northside Liquidators", deal_count: 14, total_paid: 141_000 },
  { name: "Brightpoint Returns", deal_count: 9, total_paid: 82_500 },
  { name: "Gulf Coast Salvage", deal_count: 6, total_paid: 47_200 },
  { name: "Ridgeway Pallets", deal_count: 4, total_paid: 28_900 },
  { name: "Stonebridge Surplus", deal_count: 3, total_paid: 16_400 },
  { name: "Lakeside Clearance", deal_count: 2, total_paid: 9_100 },
];
const SUP_TOTAL = SUPPLIERS.reduce((s, x) => s + x.total_paid, 0) + 12_300;
const share = (v: number, t: number) => (v / t) * 100;
const cur = monthly[monthly.length - 1];

const PRODUCTS = [
  ["Mixed apparel pallet", "Assorted footwear, 40 cases"],
  ["Small kitchen appliances, 12 pallets"],
  ["Seasonal decor truckload", "Overstock bedding", "Assorted toys"],
  ["Returns pallet, general merchandise"],
];

const RANGE = {
  total_revenue: sum("revenue"), total_cost: sum("cost"), net_profit: sum("profit"), total_profit: sum("profit"),
  avg_margin: 34.2, deal_count: 52, deals_lost: 4, refunded_in_range: 2_400,
  total_shipping: sum("shipping"), total_fees: sum("fees"), true_net: sum("true_net"),
  monthly_profit: monthly, top_clients_by_profit: STATS.top_clients_by_profit,
  overhead_ratio: ((sum("shipping") + sum("fees")) / sum("revenue")) * 100,
  concentration: {
    client_count: 31, total_revenue: REV_TOTAL,
    top1_pct: share(REV_CLIENTS[0].revenue, REV_TOTAL),
    top3_pct: share(REV_CLIENTS.slice(0, 3).reduce((s, c) => s + c.revenue, 0), REV_TOTAL),
    top5_pct: share(REV_CLIENTS.slice(0, 5).reduce((s, c) => s + c.revenue, 0), REV_TOTAL),
  },
  top_revenue_clients: REV_CLIENTS.slice(0, 6).map((c) => ({ ...c, pct: share(c.revenue, REV_TOTAL) })),
  supplier_concentration: {
    supplier_count: 11, total_spend: SUP_TOTAL,
    top1_pct: share(SUPPLIERS[0].total_paid, SUP_TOTAL),
    top3_pct: share(SUPPLIERS.slice(0, 3).reduce((s, x) => s + x.total_paid, 0), SUP_TOTAL),
  },
  top_suppliers_range: SUPPLIERS.map((s) => ({ ...s, pct: share(s.total_paid, SUP_TOTAL) })),
  repeat_new: {
    new_clients: 9, new_deals: 11, new_revenue: 96_400, new_profit: 21_700,
    repeat_clients: 22, repeat_deals: 41, repeat_revenue: sum("revenue") - 96_400,
    repeat_profit: sum("profit") - 21_700,
  },
  margin_bands: [
    { label: "Loss", deals: 3, revenue: 18_400, profit: -4_260 },
    { label: "0–10%", deals: 6, revenue: 47_900, profit: 3_100 },
    { label: "10–20%", deals: 14, revenue: 96_200, profit: 14_800 },
    { label: "20–30%", deals: 17, revenue: 121_500, profit: 30_600 },
    { label: "30–40%", deals: 9, revenue: 61_300, profit: 21_200 },
    { label: "40%+", deals: 3, revenue: 19_800, profit: 9_400 },
  ],
  velocity: {
    median_days: 19, deals_measured: 48,
    by_month: MONTHS.map((m, i) => ({ month: m, deals: 6 + i, median_days: [27, 24, 22, 19, 17, 18][i] })),
  },
  run_rate: {
    month: MONTHS[MONTHS.length - 1], days_elapsed: 16, days_in_month: 30,
    revenue_so_far: cur.revenue, profit_so_far: cur.profit,
    projected_revenue: (cur.revenue / 16) * 30, projected_profit: (cur.profit / 16) * 30,
  },
  loss_deals: 3, loss_total: -4_260, refunded_deals: 2,
  best_margin_deal: { deal_id: "d1", client_name: "Harbour Goods", title: "INV-0412", revenue: 18_400, margin_pct: 46.2, net_profit: 8_500 },
  worst_margin_deal: { deal_id: "d2", client_name: "Quarry Street Wholesale", title: "INV-0389", revenue: 9_100, margin_pct: -12.4, net_profit: -1_130 },
  biggest_invoice: { invoice_id: "i1", client_name: "Cedar Lane Resale", number: "INV-0421", total: 41_250 },
  completed_deals: Array.from({ length: 12 }, (_, i) => ({
    deal_flow_id: `df_${i}`, invoice_id: `in_${i}`, invoice_number: `INV-04${20 - i}`,
    client_name: REV_CLIENTS[i % REV_CLIENTS.length].name,
    completed_on: `2026-09-${String(16 - i).padStart(2, "0")}`,
    products: PRODUCTS[i % PRODUCTS.length].map((name, q) => ({ name, qty: q + 1 })),
    suppliers: [SUPPLIERS[i % SUPPLIERS.length].name],
    revenue: 7_400 + i * 1_150, net_profit: i === 4 ? -820 : 1_500 + i * 260,
  })),
  completed_deals_capped: true,
  new_clients: 9, interactions: 63,
  revenue_all_time: sum("revenue"), profit_all_time: sum("profit"), margin_all_time: 34.2,
  revenue_this_month: cur.revenue, profit_this_month: cur.profit,
  margin_this_month: (cur.profit / cur.revenue) * 100,
};

// R-317 extends this fixture with the reconciliation section. Two states, because the
// one that matters is the one that is easy to get wrong: the default book TIES at every
// subtotal, and `?drift` on the URL loads a book where a stored deal profit disagrees
// with its own revenue − cost and the bank block cannot be fully explained. Every name
// and figure below is invented.
const DRIFTING = new URLSearchParams(location.search).has("drift");

// revenue, profit, money in (buyer allocations), money out (supplier + fee), refunds.
// Northgate has no buyer payment behind it and Riverbend has no supplier payment — the
// two flag states. Pinegrove closed at a loss and carries the whole refund.
const RECON_DEALS = [
  ["INV-0418", "Harbour Goods",           "2026-09-12", 96_400, 24_600, 96_400, 78_500, 0],
  ["INV-0415", "Cedar Lane Resale",       "2026-09-08", 71_900, 18_050, 71_900, 59_650, 0],
  ["INV-0412", "Tidewater Outlet",        "2026-09-02", 58_300, 14_900, 58_300, 47_100, 0],
  ["INV-0409", "Maple Row Trading",       "2026-08-27", 44_200, 11_300, 44_200, 34_900, 0],
  ["INV-0406", "Quarry Street Wholesale", "2026-08-21", 38_700,  9_450, 38_700, 29_250, 0],
  ["INV-0403", "Northgate Bargain Co",    "2026-08-14", 29_500,  6_100,      0, 29_100, 0],
  ["INV-0400", "Riverbend Surplus",       "2026-08-06", 21_800,  4_200, 21_800,      0, 0],
  ["INV-0397", "Stonecrest Outlet",       "2026-07-29", 14_600,  1_150, 14_600, 13_450, 0],
  ["INV-0394", "Pinegrove Resale",        "2026-07-22",  9_100, -1_400,  9_100,  3_250, 7_250],
] as const;

const R_REVENUE = RECON_DEALS.reduce((s, d) => s + d[3], 0);   // 384,500
const R_RAW     = RECON_DEALS.reduce((s, d) => s + d[4], 0)
                + RECON_DEALS.reduce((s, d) => s + d[7], 0);   // profits + refunds
const R_COST    = R_REVENUE - R_RAW;
const R_REFUNDS = RECON_DEALS.reduce((s, d) => s + d[7], 0);
const R_NET     = R_RAW - R_REFUNDS;
const R_SHIP = 6_420, R_FEES = 780;
const R_OVERHEAD = R_SHIP + R_FEES;
const SKEW = DRIFTING ? 540 : 0;   // a stored deal profit that disagrees with its own book

const cents = (n: number) => Math.round(n * 100) / 100;
const line = (label: string, hint: string, amount: number, kind: string) =>
  ({ label, hint, amount: cents(amount), kind, running: null, drift: null });
const tieLine = (label: string, hint: string, amount: number, running: number, kind: string) =>
  ({ label, hint, amount: cents(amount), kind, running: cents(running), drift: cents(amount - running) });

const R_BRIDGE = [
  line("Revenue", "what buyers were invoiced on closed deals", R_REVENUE, "start"),
  line("Cost", "what those goods cost", -R_COST, "subtract"),
  tieLine("Profit before refunds", "read off each deal", R_RAW + SKEW, R_REVENUE - R_COST, "subtotal"),
  line("Refunds", "each refund counted once, on these deals", -R_REFUNDS, "subtract"),
  tieLine("Net profit", "after refunds", R_NET + SKEW, R_REVENUE - R_COST - R_REFUNDS, "subtotal"),
  line("Shipping", "bank shipping that never reached a deal", -R_SHIP, "subtract"),
  line("Bank and wire fees", "bank fees that never reached a deal", -R_FEES, "subtract"),
  tieLine("True net", "after shipping and fees", R_NET + SKEW - R_OVERHEAD,
          R_REVENUE - R_COST - R_REFUNDS - R_OVERHEAD, "total"),
];

const R_BANK_IN = 612_300, R_BANK_OUT = 588_915;
const R_BANK_NET = R_BANK_IN - R_BANK_OUT;
const R_ADJ = [41_275, 9_840, 18_600, -4_750];
const R_RESIDUAL = (R_NET + SKEW) - R_BANK_NET - R_ADJ.reduce((s, x) => s + x, 0);
const R_BANK_ROWS = [
  line("Money in", "every credit on the bank ledger", R_BANK_IN, "start"),
  line("Money out", "every debit on the bank ledger", -R_BANK_OUT, "subtract"),
  line("Bank net", "what the bank actually did", R_BANK_NET, "subtotal"),
  line("Money tied to no deal", "unallocated, and not a transfer or a running cost", R_ADJ[0], "adjust"),
  line("Money on deals not counted here", "not complete, or completed outside this range", R_ADJ[1], "adjust"),
  line("Transfers, draws and running costs", "categorised as never part of a deal", R_ADJ[2], "adjust"),
  line("Refunds with no bank row", "taken off profit, never seen leaving the bank", R_ADJ[3], "adjust"),
  line("Still unexplained", "after every reason above", R_RESIDUAL, "residual"),
  line("Net profit", "the figure in the bridge", R_NET + SKEW, "total"),
];

const R_SUPPLIER_REFUND_IN = 6_300;
const RECON = {
  bridge: R_BRIDGE,
  bridge_drift: cents(Math.abs(SKEW)),
  bridge_ties: SKEW === 0,
  bank: {
    rows: R_BANK_ROWS, money_in: R_BANK_IN, money_out: R_BANK_OUT, bank_net: R_BANK_NET,
    residual: cents(R_RESIDUAL), ties: Math.abs(R_RESIDUAL) < 0.005,
    orphan_allocations: DRIFTING ? 2 : 0, orphan_amount: DRIFTING ? 1_480 : 0,
  },
  deals: RECON_DEALS.map(([invoice_number, client_name, completed_on, revenue, profit, money_in, money_out, refunds]) => ({
    invoice_number, client_name, completed_on, money_in, money_out, refunds, profit,
    true_net_share: cents(profit - R_OVERHEAD * (revenue / R_REVENUE)),
    flags: [...(money_in <= 0 ? ["No buyer link"] : []), ...(money_out <= 0 ? ["No supplier link"] : [])],
  })),
  deals_capped: false,
  totals: {
    deal_count: RECON_DEALS.length,
    money_in: RECON_DEALS.reduce((s, d) => s + d[5], 0),
    money_out: RECON_DEALS.reduce((s, d) => s + d[6], 0),
    refunds: R_REFUNDS, profit: R_NET + SKEW,
    true_net_share: cents(R_NET + SKEW - R_OVERHEAD),
    revenue: R_REVENUE, cost: R_COST, supplier_refund_in: R_SUPPLIER_REFUND_IN,
    money_in_gap: RECON_DEALS.reduce((s, d) => s + d[5], 0) - R_REVENUE,
    money_out_gap: RECON_DEALS.reduce((s, d) => s + d[6], 0) - R_COST,
  },
};

const DAYS = Array.from({ length: 16 }, (_, i) => ({
  day: `2026-09-${String(i + 1).padStart(2, "0")}`,
  profit: i % 3 === 0 ? 1_900 : 0, revenue: i % 3 === 0 ? 5_200 : 0,
  shipping: i % 4 === 0 ? 310 : 0, fees: i % 5 === 0 ? 35 : 0,
}));

(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "dashboard_stats": return STATS;
    case "get_analytics_range": return RANGE;
    case "analytics_reconciliation": return RECON;
    case "get_monthly_profit": return DAYS;
    case "buyer_tiers": return TIERS;
    case "get_pending_approvals": return [];
    case "due_followups": return [];
    case "list_invoices": return [];
    case "list_clients": return [];
    case "financials_overview": return {
      free_cash: 61_480, bank_balance: 128_900, credit_card_balance: 7_240,
      supplier_payables: 34_100, refund_liability: 1_080, cash_floor: 20_000,
      loan_outstanding: 5_000, stale_unallocated: 0,
    };
    case "get_receivables_aging": return null;
    case "get_payables_aging": return null;
    case "get_dashboard_prefs": return { true_net: false };
    default:
      return /_info$|_config$|_status$|_summary$|_prefs$/.test(cmd) ? {} : [];
  }
};

// Invented tier spread so the Client mix donut has something to draw.
const TIERS = [
  ...Array(3).fill(0).map((_, i) => ({ tier: "P", client_id: `p${i}` })),
  ...Array(6).fill(0).map((_, i) => ({ tier: "S", client_id: `s${i}` })),
  ...Array(11).fill(0).map((_, i) => ({ tier: "A", client_id: `a${i}` })),
  ...Array(14).fill(0).map((_, i) => ({ tier: "B", client_id: `b${i}` })),
  ...Array(9).fill(0).map((_, i) => ({ tier: "C", client_id: `c${i}` })),
  ...Array(5).fill(0).map((_, i) => ({ tier: "Prospect", client_id: `x${i}` })),
];

const ME = { id: "u1", name: "Invented Admin", email: "admin@example.invalid", role: "admin", permissions: ["*"] } as any;

// The real shell is a fixed 216px aside beside an overflow-auto pane, which is why
// Tailwind's viewport breakpoints fire about one step too early here (see the vault's
// desktop-responsive-rule). Rendering inside the same geometry is the only way the
// overflow check means anything: `#pane.scrollWidth - #pane.clientWidth` must be 0.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen flex">
    <aside className="w-[216px] flex-shrink-0 bg-surface-2 ring-1 ring-line" />
    <main id="pane" className="flex-1 min-w-0 overflow-auto p-6 space-y-10">
      <section id="analytics"><AnalyticsView /></section>
      <section id="dash"><DashboardView onNavigate={() => {}} me={ME} /></section>
      <ToastHost />
    </main>
  </div>,
);
