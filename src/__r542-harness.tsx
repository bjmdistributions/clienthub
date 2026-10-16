// DEV ONLY: the fixture behind r542-harness.html. Nothing in the app imports this and index.html does not reference
// the page, so it never reaches a build. Renders the REAL LogisticsWeekView (the Logistics timeline), the REAL Bills
// pay day block and month strip, and the REAL pay day panel, with the Tauri bridge stubbed. Every name, number and
// amount here is invented.
//
// Query: ?as=owner|payee|blind  &paid=1 (the week was paid, $40 extra)  &dark=1  &open=1 (open the pay day panel)
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { LogisticsWeekView, LogisticsWeekPanel } from "./components/LogisticsWeek";
import { LogisticsPayBillsBlock } from "./components/LogisticsPay";
import BillsMode from "./components/bills/BillsMode";
import { ToastHost } from "./components/Toast";
import { localDay } from "./lib/format";
import { shiftDay } from "./lib/logisticsWeek";
import "./index.css";

const q = new URLSearchParams(location.search);
window.confirm = () => true;
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const who = q.get("as") || "owner";
const today = localDay();
// The pay week ends yesterday and is paid today, so today is pay day.
const start = shiftDay(today, -7), end = shiftDay(today, -1);
const state = { paid: q.get("paid") === "1" };

const loads = [
  { id: "fb_1", code: "LD-0142", booked_on: start, lane: "Newark, NJ to Dallas, TX", commission: 120, paid: false },
  { id: "fb_2", code: "LD-0144", booked_on: shiftDay(start, 4), lane: "Elizabeth, NJ to Atlanta, GA", commission: 150, paid: false },
  { id: "fb_3", code: "LD-0145", booked_on: shiftDay(start, 4), lane: "Camden, NJ to Columbus, OH", commission: 140, paid: false },
];

function week(day: string) {
  const money = who !== "blind";
  const inWeek = day >= start && day <= end;
  const ws = inWeek ? start : day < start ? shiftDay(start, -7) : today;
  const we = shiftDay(ws, 6);
  const these = inWeek ? loads : [];
  const commission = these.reduce((a, l) => a + l.commission, 0);
  const paid = inWeek && state.paid;
  return {
    start: ws, end: we, pay_date: shiftDay(we, 1), today, money, mine: who === "payee", payee_name: money ? "Ines Okafor" : "",
    pay_method: who === "owner" ? "Zelle" : "",
    loads: these.map((l) => ({ ...l, lane: who === "blind" ? "" : l.lane, commission: money ? l.commission : null, paid })),
    commission: money ? commission : null,
    status: !inWeek ? "" : paid ? "paid" : "due",
    to_pay: inWeek && !paid ? commission : 0,
    paid: paid ? { amount: commission + 40, extra: 40, paid_at: today, method: who === "owner" ? "Cash" : "", payout_id: who === "owner" ? "lp_1" : "" } : null,
    paid_total: money ? 2480 + (paid ? commission + 40 : 0) : null,
    owed_now: money ? (paid ? 0 : commission) : null,
    can_record: who === "owner" && inWeek && !paid,
  };
}

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (cmd === "logistics_request") {
      const path: string = args.path;
      if (args.method === "GET" && path.startsWith("/api/logistics/pay/week")) {
        const day = new URLSearchParams(path.split("?")[1]).get("day") || today;
        return Promise.resolve(week(day));
      }
      if (args.method === "POST" && path === "/api/logistics/pay/payouts") { state.paid = true; return Promise.resolve({ ok: true }); }
      if (args.method === "DELETE") { state.paid = false; return Promise.resolve({ ok: true }); }
    }
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(null);
  },
  transformCallback: () => 1,
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

const bills: any = {
  today, feed_latest: null, bills: [], upcoming: [], suggestions: 0,
  summary: { active: 0, monthly_total: 0, due_30_total: 0, due_30_count: 0, overdue_count: 0, overdue_total: 0, due_soon_count: 0, paid_this_month: 0, expected_this_month: 0 },
};
const marks: any[] = [
  { key: `pay:${today}`, kind: "pay", day: +today.slice(8, 10), date: today, state: "soon", title: "Logistics pay, Ines Okafor, today, $410" },
  { key: "carrier:fb_9", kind: "carrier", day: Math.min(28, +today.slice(8, 10) + 3), date: today, state: "plain", title: "Test Freight, LD-0140", bookingId: "fb_9" },
];

function App() {
  const [open, setOpen] = useState<string | null>(q.get("open") === "1" ? today : null);
  return (
    <div className="min-h-screen bg-bg p-7 space-y-6" style={{ maxWidth: 1180 }}>
      <LogisticsWeekView onOpenLoad={(id) => (window as any).__opened = id} />
      {who === "owner" && <>
        <LogisticsPayBillsBlock block={{ payee: "Ines Okafor", date: today, amount: 410, loads: 3, dueNow: true, late: false, nothingOwed: false }} onOpen={() => setOpen(today)} />
        <BillsMode data={bills} cands={[]} admin marks={marks} onMark={(m: any) => m.kind === "pay" && setOpen(m.date)} markOpens={() => true}
          onOpen={() => {}} onAdd={() => {}} onTrack={() => {}} onIgnore={() => {}} onRestore={() => {}} />
      </>}
      {open && <LogisticsWeekPanel payDate={open} onClose={() => setOpen(null)} />}
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
