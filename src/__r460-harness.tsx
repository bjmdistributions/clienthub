// DEV ONLY: the fixture behind r460-harness.html. Nothing in the app imports this. Renders the REAL
// Notifications screen (ApprovalsView) with the REAL useNotices hook, and the REAL PayablesView, with the
// Tauri bridge stubbed. Every name, number and amount is invented.
// Query: ?as=admin|deals|books  &view=notifications|payables  &dark=1
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import { ApprovalsView } from "./components/ApprovalsView";
import PayablesView from "./components/PayablesView";
import { ToastHost } from "./components/Toast";
import { useNotices } from "./lib/useNotices";
import { canSeeTeamNotices } from "./lib/notices";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const who = q.get("as") || "admin";
const me: any = {
  admin: { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "r1", role_name: "Admin", is_admin: true, permissions: ["*"] },
  deals: { id: "u3", email: "sam@example.test", display_name: "Sam Rivera", role_id: "r3", role_name: "Sales", is_admin: false, permissions: ["deal_flow:view", "logistics:view"] },
  logistics: { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "r2", role_name: "Logistics", is_admin: false, permissions: ["logistics:view", "logistics:edit", "logistics:view_names", "logistics:view_addresses"] },
  books: { id: "u4", email: "bea@example.test", display_name: "Bea Clarke", role_id: "r4", role_name: "Books", is_admin: false, permissions: ["financials:view"] },
}[who];

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const base = { org_id: "o1", status: "unread", acknowledged_at: null, acknowledged_by: null, entity_id: null };
let notes: any[] = [
  { ...base, id: "n1", kind: "logistics_quote", title: "Quote ready for LD-0012", body: "Dallas, TX to Newark, NJ.", payload_json: '{"booking_id":"fb_12"}', created_at: ago(1) },
  { ...base, id: "n2", kind: "carrier_overdue", title: "Ridgeway Freight is overdue", body: "LD-0009 was due Oct 3 and no payment has come through.", payload_json: '{"booking_id":"fb_9"}', created_at: ago(5) },
  { ...base, id: "n3", kind: "carrier_due", title: "Ridgeway Freight is due Thursday", body: "LD-0011, Oct 9.", payload_json: '{"booking_id":"fb_11"}', created_at: ago(9) },
  { ...base, id: "n4", kind: "bill_overdue", title: "Warehouse rent is overdue", body: "It was due Oct 1 and no payment has come through.", payload_json: '{"bill_id":"b_1"}', created_at: ago(26) },
  { ...base, id: "n5", kind: "bill_due", title: "Insurance is due Friday", body: "Due Oct 10. No payment seen yet.", payload_json: '{"bill_id":"b_2"}', created_at: ago(30) },
  { ...base, id: "n6", kind: "bill_paid", title: "Software was paid", body: "Paid Oct 1.", payload_json: '{"bill_id":"b_3"}', created_at: ago(70) },
  { ...base, id: "n7", kind: "supply_lead", title: "New supply lead", body: "A seller in Ohio.", payload_json: '{"name":"Harbor Surplus"}', created_at: ago(2) },
];
const payables = {
  summary: { d0_30: 1850, d31_60: 0, d61_90: 0, d90_plus: 0, total: 1850, committed_total: 1850, open_count: 1 },
  by_payee: [], suppliers: [],
  items: [{ deal_flow_id: "d1", invoice_id: "i1", invoice_number: "INV-6001", client_id: "c1", client_name: "Lakeside Discount Co", payment_id: null, payee: "Ridgeway Freight",
    amount: 1850, anchor_date: ago(240), days: 10, bucket: "d0_30", committed: true, deal_flow_stage: "payment_received", own_cost: true, kind: "shipping", booking_id: "fb_9", load_number: "LD-0009" }],
};
const lb = (id: string, n: string, status: string, urgent = false) => ({
  id, code: "L-" + id, load_number: n, status, urgent, can_see_names: true, can_see_addresses: true, can_see_deal: false, extra_pickups: [],
  pickup_name: "Northgate Wholesale", pickup_address: "410 Mercer Ave, Northgate, OH 44120", delivery_name: "Lakeside Discount Co", delivery_address: "12 Shore Rd, Lakeside, MI 49001",
});
// ?add=1 adds a new load after the first poll, the way a team member sending one would
let loads: any[] = [lb("a1", "LD-0001", "quote"), lb("a2", "LD-0002", "requested"), lb("a3", "LD-0003", "booked")];
(window as any).__addLoad = () => { loads = [...loads, lb("a4", "LD-0004", "quote", true)]; };
const calls: any[] = ((window as any).__calls = []);
const handlers: Record<string, (a: any) => any> = {
  employee_me: () => me,
  list_lead_notifications: () => notes.filter((n) => n.status === "unread"),
  ack_lead_notification: (a) => { notes = notes.map((n) => (n.id === a.id ? { ...n, status: "acknowledged" } : n)); return null; },
  list_approval_requests: () => [],
  get_pending_approvals: () => [],
  get_payables_aging: () => payables,
  show_desktop_notification: () => null,
  logistics_request: () => ({ bookings: loads }),
};
(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    calls.push({ cmd, args });
    if (handlers[cmd]) return Promise.resolve(handlers[cmd](args || {}));
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") ? [] : null);
  },
  transformCallback: () => 1, unregisterListener: () => {}, convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } }, plugins: {},
};

function Harness() {
  const notices = useNotices(me);
  (window as any).__notices = notices;
  const [tab, setTab] = useState(q.get("view") || "notifications");
  useEffect(() => {
    const h = (e: any) => { calls.push({ cmd: "navigate-tab", args: e.detail }); };
    window.addEventListener("navigate-tab", h);
    return () => window.removeEventListener("navigate-tab", h);
  }, []);
  return (
    <div className="flex h-screen bg-bg">
      <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 space-y-1 text-[13px]">
        <button onClick={() => setTab("notifications")} className="block w-full text-left px-2.5 h-8 rounded-lg bg-surface-2 text-ink">
          Notifications {canSeeTeamNotices(me) && <span id="bell" className="ml-1 text-danger-ink">{notices.team.length}</span>}
        </button>
        <button onClick={() => setTab("payables")} className="block w-full text-left px-2.5 h-8 rounded-lg text-ink-2">Payables</button>
      </aside>
      <main className="flex-1 overflow-y-auto p-7 min-w-0">
        {tab === "notifications" ? <ApprovalsView me={me} notices={notices} /> : <PayablesView />}
      </main>
      <ToastHost />
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
