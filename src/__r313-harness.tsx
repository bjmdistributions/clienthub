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
  return { month: m, revenue, cost, profit, shipping, fees, true_net: profit - shipping - fees };
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
  category_breakdown: [{ category: "Apparel", client_count: 12, revenue: 88_000 }, { category: "Footwear", client_count: 9, revenue: 61_000 }],
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

const RANGE = {
  total_revenue: sum("revenue"), total_cost: sum("cost"), net_profit: sum("profit"), total_profit: sum("profit"),
  avg_margin: 34.2, deal_count: 52, deals_lost: 4, refunded_in_range: 2_400,
  total_shipping: sum("shipping"), total_fees: sum("fees"), true_net: sum("true_net"),
  monthly_profit: monthly, top_clients_by_profit: STATS.top_clients_by_profit,
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
    case "get_monthly_profit": return DAYS;
    case "buyer_tiers": return [];
    case "get_pending_approvals": return [];
    case "due_followups": return [];
    case "list_invoices": return [];
    case "list_clients": return [];
    case "financials_overview": return { free_cash: 0, stale_unallocated: 0 };
    case "get_receivables_aging": return null;
    case "get_payables_aging": return null;
    case "get_dashboard_prefs": return { true_net: false };
    default:
      return /_info$|_config$|_status$|_summary$|_prefs$/.test(cmd) ? {} : [];
  }
};

const ME = { id: "u1", name: "Invented Admin", email: "admin@example.invalid", role: "admin", permissions: ["*"] } as any;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen p-6 space-y-10">
    <section id="dash"><DashboardView onNavigate={() => {}} me={ME} /></section>
    <section id="analytics"><AnalyticsView /></section>
    <ToastHost />
  </div>,
);
