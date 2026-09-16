// DEV ONLY — the fixture behind r316-brief-harness.html. Nothing in the app imports
// this and index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL BriefView inside the app's own shell geometry (216px sidebar,
// p-7, max-w-[1280px]) so overflow at 1280 / 1440 / 1728 is visible rather than
// assumed. Every name and figure below is invented.
import ReactDOM from "react-dom/client";
import BriefView from "./components/BriefView";
import { ToastHost } from "./components/Toast";
import { localDay } from "./lib/format";
import "./index.css";

const TODAY = localDay();
const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); };
const ahead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDay(d); })();

const flow = (o: Record<string, any>) => ({
  deposit_amount: 0, payment_received_method: null, payment_received_at: null,
  payment_received_amount: 0, supplier_payments_json: "[]", supplier_payments: [],
  supplier_owed: 0, own_costs_unpaid: 0, own_costs_total: 0, total_supplier_cost: 0,
  completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0,
  profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null,
  created_at: back(30), updated_at: TODAY, invoice_total: 0, client_id: "c1",
  ...o,
});

const FLOWS = [
  flow({ id: "f1", invoice_id: "i1", invoice_number: "INV-4102", client_name: "Harbour Goods", stage: "complete",
    completed_at: `${TODAY}T15:20:00Z`, gross_revenue: 41_800, total_cost: 28_400, net_profit: 13_400, invoice_total: 41_800 }),
  flow({ id: "f2", invoice_id: "i2", invoice_number: "INV-4098", client_name: "Cedar Lane Resale", stage: "complete",
    completed_at: `${TODAY}T11:05:00Z`, gross_revenue: 12_250, total_cost: 13_600, net_profit: -1_350, invoice_total: 12_250 }),
  flow({ id: "f3", invoice_id: "i3", invoice_number: "INV-4091", client_name: "Northgate Outlet", stage: "complete",
    completed_at: `${back(2)}T09:40:00Z`, gross_revenue: 26_900, total_cost: 19_100, net_profit: 7_800, invoice_total: 26_900 }),
  flow({ id: "f4", invoice_id: "i4", invoice_number: "INV-4110", client_name: "Delta Bay Trading", stage: "payment_received",
    payment_received_at: `${TODAY}T08:15:00Z`, payment_received_amount: 34_500, payment_received_method: "Wire",
    supplier_owed: 21_900, invoice_total: 34_500 }),
  flow({ id: "f5", invoice_id: "i5", invoice_number: "INV-4111", client_name: "Meridian Wholesale", stage: "payment_received",
    payment_received_at: `${back(1)}T14:02:00Z`, payment_received_amount: 9_140, payment_received_method: "Zelle",
    supplier_owed: 6_300, invoice_total: 9_140, expected_delivery_date: back(3) }),
  flow({ id: "f6", invoice_id: "i6", invoice_number: "INV-4085", client_name: "Pinehurst Liquidation", stage: "supplier_paid",
    invoice_total: 18_400, expected_delivery_date: back(6) }),
  flow({ id: "f7", invoice_id: "i7", invoice_number: "INV-4112", client_name: "Coastline Discount", stage: "invoiced",
    invoice_total: 7_600, expected_delivery_date: ahead(5) }),
];

const inv = (o: Record<string, any>) => ({
  client_id: "c1", line_items_json: "[]", subtotal: 0, tax: 0, status: "sent", pdf_path: null,
  cost_items_json: null, total_cost: null, profit: null, margin: null, carrier: null,
  tracking_number: null, shipping_charged: null, pickup_date: null, delivery_date: null,
  is_complete: false, voided: false, issue_date: TODAY, ...o,
});

const INVOICES = [
  inv({ id: "i8", number: "INV-4113", total: 22_400, sent_at: `${TODAY}T10:12:00Z`, due_date: ahead(14) }),
  inv({ id: "i9", number: "INV-4114", total: 5_980, sent_at: `${TODAY}T16:44:00Z`, due_date: ahead(14) }),
  inv({ id: "i4", number: "INV-4110", total: 34_500, sent_at: `${back(2)}T12:00:00Z`, due_date: ahead(7) }),
  inv({ id: "i10", number: "INV-3990", total: 11_100, sent_at: `${back(40)}T12:00:00Z`, due_date: back(12) }),
];

const arItem = (o: Record<string, any>) => ({ deal_flow_id: null, committed: true, deal_flow_stage: null, ...o });
const AR = {
  summary: { current: 42_000, d1_30: 18_300, d31_60: 9_400, d61_90: 4_100, d90_plus: 2_600, total: 76_400, open_count: 11, due_soon: 3 },
  by_client: [],
  items: [
    arItem({ invoice_id: "i10", invoice_number: "INV-3990", client_id: "c2", client_name: "Redwood Bargain Co", amount: 11_100, due_date: back(12), days_overdue: 12, bucket: "1-30" }),
    arItem({ invoice_id: "i11", invoice_number: "INV-3944", client_id: "c3", client_name: "Summit Closeouts", amount: 6_450, due_date: back(38), days_overdue: 38, bucket: "31-60" }),
    arItem({ invoice_id: "i12", invoice_number: "INV-3901", client_id: "c4", client_name: "Bluffside Resale Group", amount: 4_100, due_date: back(64), days_overdue: 64, bucket: "61-90" }),
    arItem({ invoice_id: "i13", invoice_number: "INV-3877", client_id: "c5", client_name: "Kestrel Supply", amount: 2_600, due_date: back(96), days_overdue: 96, bucket: "90+" }),
    arItem({ invoice_id: "i14", invoice_number: "INV-4055", client_id: "c6", client_name: "Orchard Street Markets", amount: 3_280, due_date: back(4), days_overdue: 4, bucket: "1-30" }),
    arItem({ invoice_id: "i15", invoice_number: "INV-4120", client_id: "c7", client_name: "Larkspur Trading Post", amount: 7_900, due_date: ahead(9), days_overdue: 0, bucket: "current", committed: false }),
  ],
};

const FOLLOWUPS = [
  { id: "c2", name: "Dana Whitfield", company: "Redwood Bargain Co", email: null, phone: null, notes: null, billing_status: "", lead_status: "", created_at: back(80), updated_at: TODAY, metadata: { next_follow_up_date: TODAY }, invoice_count: 3, total_revenue: 0, category: null, tags: null, street_address: null, city: null, state: null, zip_code: null, country: null, next_follow_up_date: TODAY, needs_review: false, is_blacklisted: false },
  { id: "c8", name: "Marco Ilnitsky", company: "Ridgeline Overstock", email: null, phone: null, notes: null, billing_status: "", lead_status: "", created_at: back(60), updated_at: TODAY, metadata: { next_follow_up_date: back(1) }, invoice_count: 1, total_revenue: 0, category: null, tags: null, street_address: null, city: null, state: null, zip_code: null, country: null, next_follow_up_date: back(1), needs_review: false, is_blacklisted: false },
  { id: "c9", name: "Priya Raghunathan", company: null, email: null, phone: null, notes: null, billing_status: "", lead_status: "", created_at: back(20), updated_at: TODAY, metadata: { next_follow_up_date: TODAY }, invoice_count: 0, total_revenue: 0, category: null, tags: null, street_address: null, city: null, state: null, zip_code: null, country: null, next_follow_up_date: TODAY, needs_review: false, is_blacklisted: false },
  { id: "c10", name: "Terrence Ovalle", company: "Fairmount Clearance", email: null, phone: null, notes: null, billing_status: "", lead_status: "", created_at: back(12), updated_at: TODAY, metadata: { next_follow_up_date: TODAY }, invoice_count: 2, total_revenue: 0, category: null, tags: null, street_address: null, city: null, state: null, zip_code: null, country: null, next_follow_up_date: TODAY, needs_review: false, is_blacklisted: false },
];

const BRIEF = {
  generated_at: new Date().toISOString(),
  week_start: monday, week_end: (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 6); return localDay(d); })(),
  avg_margin_this_month: 31.4, avg_margin_all_time: 29.8,
  revenue_this_month: 184_200, revenue_all_time: 1_940_000, monthly_breakdown: [],
  revenue_this_week: 61_300, revenue_last_week: 48_900, revenue_change_pct: 25.4,
  profit_this_week: 19_850, profit_last_week: 15_100, profit_change_pct: 31.5,
  avg_margin_this_week: 32.4, deals_closed_this_week: 3, deals_lost_this_week: 1, win_rate_this_week: 75,
  overdue_invoices_count: 5, overdue_invoices_value: 27_530, follow_ups_due: 4,
  best_margin_deal: null, worst_margin_deal: null, biggest_invoice: null,
  new_clients_this_week: 6, interactions_this_week: 23,
  completed_deals_this_week: 3, completed_deals_last_week: 2,
  net_profit_this_week: 19_850, net_profit_last_week: 15_100, net_profit_change_pct: 31.5,
  profit_jack_this_week: 0, profit_ben_this_week: 0, profit_business_this_week: 0,
  profit_jack_all_time: 0, profit_ben_all_time: 0, profit_business_all_time: 0,
  net_profit_this_month: 57_420, profit_jack_this_month: 0, profit_ben_this_month: 0, profit_business_this_month: 0,
  loss_deals_this_week: 1, loss_total_this_week: 1_350,
  refunded_deals_this_week: 0, refunded_total_this_week: 0,
  rep_earnings_this_week: 0,
  payout_totals: [
    { name: "Business", is_business: true, this_week: 9_925, this_month: 28_710 },
    { name: "Partner one", is_business: false, this_week: 4_962.5, this_month: 14_355 },
    { name: "Partner two", is_business: false, this_week: 4_962.5, this_month: 14_355 },
  ],
  completed_deals: [],
};

// ?empty=1 renders the quiet day: nothing happened, nothing waiting, nothing aged.
const EMPTY = new URLSearchParams(location.search).get("empty") === "1";

(window as any).__FIXTURE = (cmd: string) => {
  if (EMPTY) {
    switch (cmd) {
      case "generate_weekly_brief":
        return { ...BRIEF, new_clients_this_week: 0, interactions_this_week: 0, net_profit_this_week: 0, net_profit_this_month: 0, payout_totals: [] };
      case "get_brief_frequency": return 7;
      case "get_receivables_aging": return { summary: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, open_count: 0, due_soon: 0 }, by_client: [], items: [] };
      default: return [];
    }
  }
  switch (cmd) {
    case "generate_weekly_brief": return BRIEF;
    case "get_brief_frequency": return 7;
    case "set_brief_frequency": return null;
    case "list_deal_flows": return FLOWS;
    case "list_invoices": return INVOICES;
    case "get_receivables_aging": return AR;
    case "due_followups": return FOLLOWUPS;
    default:
      return /_info$|_config$|_status$|_summary$|_prefs$/.test(cmd) ? {} : [];
  }
};

const ME = { name: "Invented Admin", role: "owner" };

// The app's own shell geometry: a 216px rail, then p-7 and a 1280px cap.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen bg-bg">
    <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface" />
    <div className="flex-1 min-w-0 p-7">
      <div className="max-w-[1280px] mx-auto">
        <BriefView currentUser={ME} />
      </div>
    </div>
    <ToastHost />
  </div>,
);
