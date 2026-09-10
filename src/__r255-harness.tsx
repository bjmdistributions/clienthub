// DEV ONLY — fixture behind r255-harness.html, verifying the "What people
// bought" section on BriefView: six completed deals (5-product chip overflow,
// no supplier, negative profit, an already-shipping-stripped deal, qty<=1
// hidden, multi-supplier join), and ?empty=1 for the empty state.
// Nothing in the app imports this and index.html does not reference the page,
// so it never reaches a build.
import ReactDOM from "react-dom/client";
import BriefView from "./components/BriefView";
import { WeeklyBrief, BriefDeal } from "./lib/api";
import "./index.css";

const empty = new URLSearchParams(location.search).get("empty") === "1";

const DEALS: BriefDeal[] = [
  {
    deal_flow_id: "df_1", invoice_id: "inv_1", invoice_number: "INV-0201",
    client_name: "Tytan Market LLC", completed_on: "2026-09-07",
    products: [
      { name: "Nike Dunks", qty: 24 },
      { name: "Nike Clothing", qty: 12689 },
      { name: "Air Max 90", qty: 60 },
      { name: "Jordan 1 Retro", qty: 8 },
      { name: "Yeezy Slides", qty: 150 },
    ],
    suppliers: ["Ronnie Diaz"], revenue: 165060, net_profit: 42500,
  },
  {
    deal_flow_id: "df_2", invoice_id: "inv_2", invoice_number: "INV-0198",
    client_name: "Last Stock LLC", completed_on: "2026-09-05",
    products: [{ name: "Crocs - Lego Collab", qty: 400 }],
    suppliers: [], revenue: 18400, net_profit: 3200,
  },
  {
    deal_flow_id: "df_3", invoice_id: "inv_3", invoice_number: "INV-0187",
    client_name: "Ali Rehman", completed_on: "2026-09-03",
    products: [{ name: "Adidas Samba", qty: 90 }],
    suppliers: ["Todd Yohman"], revenue: 8200, net_profit: -1250,
  },
  {
    // Shipping line already stripped server-side — the fixture reflects what
    // the backend delivers, not what the raw invoice held.
    deal_flow_id: "df_4", invoice_id: "inv_4", invoice_number: "INV-0210",
    client_name: "Dylan Taylor", completed_on: "2026-09-02",
    products: [{ name: "Nike Air Force 1", qty: 1 }],
    suppliers: ["Todd Yohman"], revenue: 12500, net_profit: 3100,
  },
  {
    deal_flow_id: "df_5", invoice_id: "inv_5", invoice_number: "INV-0176",
    client_name: "ARABE LLC", completed_on: "2026-08-30",
    products: [{ name: "Puma RS-X", qty: 300 }, { name: "New Balance 550", qty: 75 }],
    suppliers: ["ARABE LLC Supply"], revenue: 27800, net_profit: 6100,
  },
  {
    deal_flow_id: "df_6", invoice_id: "inv_6", invoice_number: "INV-0165",
    client_name: "Marcus Whitfield", completed_on: "2026-08-28",
    products: [{ name: "Reebok Classic", qty: 1 }],
    suppliers: ["Jordan Blake", "Marcus Import Co"], revenue: 4100, net_profit: 900,
  },
];

const BRIEF: WeeklyBrief = {
  generated_at: "2026-09-10T14:00:00Z",
  week_start: "2026-09-07", week_end: "2026-09-13",
  avg_margin_this_month: 24.6, avg_margin_all_time: 21.3,
  revenue_this_month: 412000, revenue_all_time: 3850000,
  monthly_breakdown: [
    { month: "2026-08", count: 14, revenue: 380000, net_profit: 79000, margin_pct: 20.8 },
    { month: "2026-09", count: 6, revenue: 236060, net_profit: 54550, margin_pct: 23.1 },
  ],
  revenue_this_week: 236060, revenue_last_week: 198500, revenue_change_pct: 18.9,
  profit_this_week: 54550, profit_last_week: 41200, profit_change_pct: 32.4,
  avg_margin_this_week: 23.1,
  deals_closed_this_week: 6, deals_lost_this_week: 1, win_rate_this_week: 85.7,
  overdue_invoices_count: 2, overdue_invoices_value: 15400,
  follow_ups_due: 3,
  best_margin_deal: { deal_id: "df_1", client_name: "Tytan Market LLC", title: "INV-0201", asking_price: 165060, margin_pct: 25.7 },
  worst_margin_deal: { deal_id: "df_3", client_name: "Ali Rehman", title: "INV-0187", asking_price: 8200, margin_pct: -15.2 },
  biggest_invoice: { invoice_id: "inv_1", client_name: "Tytan Market LLC", number: "INV-0201", total: 165060 },
  new_clients_this_week: 2, interactions_this_week: 11,
  completed_deals_this_week: 6, completed_deals_last_week: 5,
  net_profit_this_week: 54550, net_profit_last_week: 41200, net_profit_change_pct: 32.4,
  profit_jack_this_week: 27275, profit_ben_this_week: 27275, profit_business_this_week: 0,
  profit_jack_all_time: 900000, profit_ben_all_time: 900000, profit_business_all_time: 0,
  net_profit_this_month: 133550, profit_jack_this_month: 66775, profit_ben_this_month: 66775, profit_business_this_month: 0,
  loss_deals_this_week: 1, loss_total_this_week: 1250,
  refunded_deals_this_week: 0, refunded_total_this_week: 0,
  rep_earnings_this_week: 0,
  payout_totals: [
    { name: "Jack", is_business: false, this_week: 27275, this_month: 66775, all_time: 900000 },
    { name: "Ben", is_business: false, this_week: 27275, this_month: 66775, all_time: 900000 },
  ],
  completed_deals: empty ? [] : DEALS,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  if (cmd === "generate_weekly_brief") return BRIEF;
  if (cmd === "get_brief_frequency") return 7;
  if (cmd === "set_brief_frequency") return null;
  return null;
};

ReactDOM.createRoot(document.getElementById("root")!).render(<BriefView />);
