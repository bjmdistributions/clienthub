// DEV ONLY: the fixture behind r464c-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build.
//
// Renders the REAL BillsView (the Logistics pay block, the carriers to pay and the month strip with the
// logistics marks), the REAL ApprovalsView (with the compact renewals line and the pay-day notice) and the
// REAL RenewalsView inside the app's shell geometry (216px sidebar, p-7), with the Tauri bridge stubbed.
// Every name, number and amount here is invented.
//
// Query: ?view=bills|notifications|renewals  &as=admin|books  &dark=1  &none=1 (logistics pay off, nobody owed)
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import BillsView from "./components/BillsView";
import RenewalsView from "./components/RenewalsView";
import { ApprovalsView } from "./components/ApprovalsView";
import { ToastHost } from "./components/Toast";
import { useNotices } from "./lib/useNotices";
import { localDay } from "./lib/format";
import "./index.css";

const q = new URLSearchParams(location.search);
window.confirm = (m?: string) => { (window as any).__confirm = m; return true; };
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

const as = q.get("as") === "books" ? "books" : "admin";
const none = q.get("none") === "1";
const today = localDay();
const month = today.slice(0, 7);
const dim = new Date(+today.slice(0, 4), +today.slice(5, 7), 0).getDate();
const todayN = +today.slice(8, 10);
const dayOf = (n: number) => `${month}-${String(Math.min(dim, Math.max(1, n))).padStart(2, "0")}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); };

const ME = as === "books"
  ? { id: "u3", email: "books@example.test", display_name: "Rae Kimura", role_id: "r3", role_name: "Bookkeeper", is_admin: false, permissions: ["financials:view"] }
  : { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "r1", role_name: "Admin", is_admin: true, permissions: ["*"] };

// ─── bills ────────────────────────────────────────────────────────────────
const state = (next: string, days: number, status = "upcoming") => ({
  status, next_due: next, days_until: days, overdue: [], last_paid: daysAgo(30), last_amount: 1, current_paid: false, paid_count: 3, on_time_count: 3,
  history: [], extras: [], extras_year: 0, avg_amount: null, avg_count: 0,
});
const bill = (id: string, name: string, amount: number, due: string) => ({
  id, name, payee_match: name.toLowerCase(), amount, tolerance_pct: 5, cadence: "monthly", anchor_date: due, category: "Rent", method: "ach", website: "", logo: "",
  notes: "", status: "active", created_at: "2026-01-01", updated_at: "2026-01-01", monthly: amount, state: state(due, 3),
});
const BILLS = [
  bill("b1", "Riverside Storage Rent", 2400, dayOf(todayN + 4)),
  bill("b2", "Fleet Insurance", 860, dayOf(todayN + 1)),
  bill("b3", "Warehouse Utilities", 310, dayOf(todayN + 4)),
];
const BILLS_LIST = {
  today, feed_latest: today, bills: BILLS,
  summary: { active: 3, monthly_total: 3570, due_30_total: 3570, due_30_count: 3, overdue_count: 0, overdue_total: 0, due_soon_count: 1, paid_this_month: 0, expected_this_month: 3 },
  upcoming: BILLS.map((b) => ({ bill_id: b.id, due: b.state.next_due, amount: b.amount, paid: false })),
  suggestions: 0,
};

// ─── logistics money ──────────────────────────────────────────────────────
const payDate = dayOf(todayN + 2);
const lateDate = dayOf(todayN - 2);
const TRACKER = {
  settings: { enabled: true, surplus_mode: "pay", payee_id: "u2", payee_name: "Ines Okafor", share_pct: 100, cover_losses: true, loss_pay_pct: 0,
    frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1, method: "Zelle", details: "", markup_pct: 10, markup_editable: false },
  mode: "pay", today, next_pay_date: payDate, next_total: 0, due_now_total: 312.5,
  lines: [
    { deal_flow_id: "d1", invoice_number: "INV-6001", client_name: "Lakeside Discount Co", booking_codes: ["LD-0004"], earned_on: daysAgo(6), due_date: lateDate, charged: 1900, charged_source: "lines",
      freight: 1500, freight_source: "paid", surplus: 400, rule: "markup", pay: 150, paid: 0, owed: 150, pending: false },
    { deal_flow_id: "d2", invoice_number: "INV-6002", client_name: "Northgate Wholesale", booking_codes: ["LD-0005"], earned_on: daysAgo(5), due_date: lateDate, charged: 1200, charged_source: "lines",
      freight: 980, freight_source: "paid", surplus: 220, rule: "markup", pay: 162.5, paid: 0, owed: 162.5, pending: false },
  ],
  dates: [
    { pay_date: lateDate, period_start: daysAgo(12), period_end: daysAgo(6), total: 312.5, carried_in: 0, status: "due", payout_id: null },
    { pay_date: payDate, period_start: daysAgo(5), period_end: today, total: 0, carried_in: 0, status: "upcoming", payout_id: null },
  ],
  payouts: [],
};
const carrierRow = (id: string, load: string, carrier: string, due: string, rate: number | null) => ({
  booking_id: id, load_number: load, deal_flow_id: "d1", deal_label: "INV-6001 for Lakeside Discount Co", route: "Northgate to Lakeside", carrier, carrier_id: "c1",
  pay_method: "zelle", pay_details: "", rate, quote_amount: null, pay_due_date: due, days_until: null, overdue: false, status: "delivered", delivered_at: daysAgo(3),
  paperwork: { bol: true, pod: true, carrier_invoice: true }, carrier_invoice_file_id: "f1", paid_amount: null, paid_at: "", paid_method: "", paid_note: "", bank_linked: "",
});
const CARRIERS_TO_PAY = [
  carrierRow("fb_7", "LD-0007", "Northline Freight", dayOf(todayN - 1), 1320),
  carrierRow("fb_8", "LD-0008", "Ridgeway Freight", dayOf(todayN + 4), 1500),
  carrierRow("fb_9", "LD-0009", "Harbor Lines", dayOf(todayN + 4), 980),
];

// ─── notifications and renewals ───────────────────────────────────────────
const note = (id: string, kind: string, title: string, body: string, payload: object, ago: number) => ({
  id, org_id: "o1", kind, title, body, payload_json: JSON.stringify(payload), entity_id: null, status: "unread", acknowledged_at: null, acknowledged_by: null,
  created_at: new Date(Date.now() - ago * 3600_000).toISOString(),
});
let NOTICES: any[] = [
  note("n1", "logistics_pay_due", "Pay Ines Okafor today", "2 loads. Open it to record the payment.", { pay_date: lateDate }, 1),
  note("n2", "carrier_overdue", "Carrier overdue", "Northline Freight, LD-0007 was due yesterday.", { booking_id: "fb_7" }, 5),
];
const NAMES = ["Pallet of mixed tools", "Cosmetics lot, 18 cartons", "Patio furniture, 6 sets", "Kitchen small appliances", "Toy assortment, 9 pallets", "Garden hose reels", "Winter coats, 400 units",
  "Bike helmets", "Phone cases, mixed", "Candle assortment", "Office chairs, 12", "Water bottles, 3 pallets", "Yoga mats", "Storage bins, 5 pallets"];
let REQUESTS: any[] = NAMES.map((n, i) => ({ id: `r${i}`, kind: "listing_stale", entity_id: `lot${i}`, summary: `Renew or mark sold: ${n}`, requested_by_name: null, created_at: daysAgo(i % 4) + "T09:00:00Z" }));
REQUESTS.push({ id: "rd", kind: "client_delete", entity_id: "c1", summary: "Delete Harbor Grocers", requested_by_name: "Sam Rivera", created_at: daysAgo(1) + "T09:00:00Z" });
const LOTS = NAMES.map((n, i) => ({ id: `lot${i}`, name: n, updated_at: daysAgo(6 + (i % 5)) + "T09:00:00Z", status: "available" }));

const handlers: Record<string, (a: any) => any> = {
  employee_me: () => ME,
  bills_list: () => (none ? { ...BILLS_LIST, bills: [], upcoming: [], summary: { ...BILLS_LIST.summary, active: 0 } } : BILLS_LIST),
  list_approval_requests: () => REQUESTS,
  get_pending_approvals: () => [],
  list_inventory: () => LOTS,
  list_lead_notifications: ({ status }: any) => (status === "unread" ? NOTICES : NOTICES),
  ack_lead_notification: ({ id }: any) => { NOTICES = NOTICES.filter((n) => n.id !== id); return null; },
  resolve_approval_request: ({ id, approve }: any) => { (window as any).__resolved = [...((window as any).__resolved || []), { id, approve }]; REQUESTS = REQUESTS.filter((r) => r.id !== id); return null; },
  show_desktop_notification: () => null,
  logistics_request: ({ method, path }: any) => {
    const [p] = path.split("?");
    if (method === "GET" && p === "/api/logistics/pay/tracker") return none ? { ...TRACKER, settings: { ...TRACKER.settings, enabled: false }, mode: "off", dates: [], lines: [] } : TRACKER;
    if (method === "GET" && p === "/api/logistics/carrier-pay") return none ? { to_pay: [], paid: [] } : { to_pay: CARRIERS_TO_PAY, paid: [] };
    return Promise.reject("That request is not allowed here.");
  },
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) { try { return Promise.resolve(handlers[cmd](args || {})); } catch (e) { return Promise.reject(e); } }
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") ? [] : null);
  },
  transformCallback: () => 1,
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

type V = "bills" | "notifications" | "renewals" | "settings" | "logistics";

function Harness() {
  const [view, setView] = useState<V>((q.get("view") as V) || "bills");
  const notices = useNotices(ME as any);
  useEffect(() => {
    const go = (e: Event) => setView((e as CustomEvent<string>).detail as V);
    window.addEventListener("navigate-tab", go);
    return () => window.removeEventListener("navigate-tab", go);
  }, []);
  const tab = "block w-full text-left text-[13px] px-2.5 h-8 rounded-lg";
  return (
    <div className="flex h-screen bg-bg">
      <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 space-y-1">
        {([["bills", "Bills"], ["notifications", "Notifications"], ["renewals", "Renewals"]] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} className={`${tab} ${view === v ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>{label}</button>
        ))}
      </aside>
      <main className="flex-1 overflow-hidden relative min-w-0">
        <div className="h-full overflow-y-auto p-7"><div className="max-w-[1280px] mx-auto">
          {view === "bills" && <BillsView me={ME as any} />}
          {view === "notifications" && <ApprovalsView me={ME as any} notices={notices} />}
          {view === "renewals" && <RenewalsView />}
          {view === "settings" && <div id="settings-landed" className="text-[13px] text-ink">Settings opened. tab={localStorage.getItem("clienthub_settings_tab")} sub={localStorage.getItem("settings_team_sub")}</div>}
          {view === "logistics" && <div id="logistics-landed" className="text-[13px] text-ink">Logistics opened. load={localStorage.getItem("logistics_open_load")}</div>}
        </div></div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
