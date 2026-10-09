// DEV ONLY: the fixture behind r479-harness.html. Nothing in the app imports this and index.html does not reference
// the page, so it never reaches a build.
//
// Renders the REAL DealFlowView (Pipeline | Payments, the four payment groups, Move to Logistics and its "Already
// moving" sheet) inside the app's shell geometry (216px sidebar, p-7), with the Tauri bridge stubbed. The stub answers
// the status route with the six R-479 keys and the Logistics routes with a carrier directory; a create is recorded on
// window.__posted. Every name, number and amount is invented.
// Query: ?as=admin|deals|nonum  &dark=1  &view=payments  &move=INV-5003
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import DealFlowView from "./components/DealFlowView";
import { ToastHost } from "./components/Toast";
import { localDay } from "./lib/format";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const TODAY = localDay();
const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); };

const me: any = {
  admin: { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "r1", role_name: "Admin", is_admin: true, permissions: ["*"] },
  deals: { id: "u3", email: "sam@example.test", display_name: "Sam Rivera", role_id: "r3", role_name: "Sales", is_admin: false, permissions: ["deal_flow:view", "deal_flow:edit", "deal_flow:view_numbers", "logistics:view"] },
  nonum: { id: "u5", email: "kai@example.test", display_name: "Kai Moreno", role_id: "r5", role_name: "Viewer", is_admin: false, permissions: ["deal_flow:view", "deal_flow:edit"] },
}[q.get("as") || "admin"];

const cost = (amount: number, name = "Sample Supplier Co") => ({
  id: "sp_" + Math.random().toString(36).slice(2, 8), supplier_name: name, supplier_id: null, amount, original_amount: null, price_changed: false,
  quantity: null, unit_price: null, method: null, notes: null, paid: false, paid_at: null, category: "supplier", kept: false, supplier_billed: false,
});
const flow = (o: Record<string, any>) => ({
  deposit_amount: 0, payment_received_method: null, payment_received_at: null, payment_received_amount: 0,
  supplier_payments_json: "[]", supplier_payments: [], supplier_owed: 0, own_costs_unpaid: 0, own_costs_total: 0, total_supplier_cost: 0,
  completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0, profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null, name: null,
  created_at: back(20), updated_at: TODAY, client_id: "c1", ships_direct: false, pickup_date: null, expected_delivery_date: null,
  pickup_date_prev: null, expected_delivery_date_prev: null, refund_owed: 0, refund_total: 0, load_numbers: "", logistics_bookings: 0, logistics_stage: "", ...o,
});
const withCost = (o: Record<string, any>, amount: number, name?: string) => {
  const lines = amount > 0 ? [cost(amount, name)] : [];
  return flow({ ...o, supplier_payments: lines, supplier_payments_json: JSON.stringify(lines), total_supplier_cost: amount });
};

let FLOWS: any[] = [
  withCost({ id: "f1", invoice_id: "i1", invoice_number: "INV-5001", client_name: "Harbour Goods", stage: "invoiced", invoice_total: 10_000 }, 7_000, "Northgate Wholesale"),
  withCost({ id: "f2", invoice_id: "i2", invoice_number: "INV-5002", client_name: "Cedar Lane Resale", stage: "payment_received", invoice_total: 24_500, payment_received_amount: 24_500 }, 17_250, "Ridgeway Surplus"),
  withCost({ id: "f3", invoice_id: "i3", invoice_number: "INV-5003", client_name: "Delta Bay Trading", stage: "invoiced", invoice_total: 34_500 }, 22_000, "Northgate Wholesale"),
  withCost({ id: "f4", invoice_id: "i4", invoice_number: "INV-5004", client_name: "Coastline Discount", stage: "supplier_paid", invoice_total: 7_600 }, 5_100, "Lakeside Liquidators"),
  withCost({ id: "f5", invoice_id: "i5", invoice_number: "INV-5005", client_name: "Birchwood Outlet", stage: "payment_received", invoice_total: 12_250, payment_received_amount: 12_250 }, 0),
  withCost({ id: "f6", invoice_id: "i6", invoice_number: "INV-5006", client_name: "Summit Closeouts", stage: "invoiced", invoice_total: 9_800, load_numbers: "LD-0101", logistics_bookings: 1, logistics_stage: "booked" }, 6_400, "Northgate Wholesale"),
  withCost({ id: "f7", invoice_id: "i7", invoice_number: "INV-5007", client_name: "Draft Buyer LLC", stage: "invoiced", invoice_total: 3_000 }, 0),
  withCost({ id: "f8", invoice_id: "i8", invoice_number: "INV-5008", client_name: "Maple Street Liquidation", stage: "supplier_paid", invoice_total: 6_400, ships_direct: true }, 4_000, "Ridgeway Surplus"),
];
const inv = (o: Record<string, any>) => ({
  client_id: "c1", line_items_json: "[]", subtotal: 0, tax: 0, status: "sent", pdf_path: null, cost_items_json: null, total_cost: null, profit: null,
  margin: null, carrier: null, tracking_number: null, shipping_charged: null, pickup_date: null, delivery_date: null, is_complete: false,
  voided: false, issue_date: back(10), due_date: back(-14), sent_at: `${back(9)}T12:00:00Z`, ...o,
});
const INVOICES = FLOWS.map((f, i) => inv({ id: f.invoice_id, number: f.invoice_number, total: f.invoice_total, issue_date: back(20 - i), status: f.id === "f7" ? "draft" : "sent" }));

// The six keys per deal, as reconciliation_status_all would carry them.
const rec = (id: string, bt: number, bp: number, st: number, sp: number, extra: Record<string, any> = {}) => {
  const bleft = extra.no_buyer_link || bp >= bt - 0.5 ? 0 : Math.max(bt - bp, 0);
  const sleft = extra.no_supplier_link || (st > 0.01 ? sp >= st - 0.5 : sp > 0.01) ? 0 : Math.max(st - sp, 0);
  return {
    deal_flow_id: id, payment_received_paired: bleft === 0, supplier_paid_paired: st > 0.01 ? sp >= st - 0.5 : sp > 0.01, fully_reconciled: false,
    has_payment: bp > 0.01, has_financials: bp + sp > 0, no_buyer_link: false, no_supplier_link: false, needs_financials: false,
    buyer_missing: false, supplier_missing: false, needs_review: false,
    buyer_target: bt, buyer_paired: bp, buyer_left: bleft, supplier_target: st, supplier_paired: sp, supplier_left: sleft, ...extra,
  };
};
const RECON = [
  rec("f1", 10_000, 0, 7_000, 0),
  rec("f2", 24_500, 24_500, 17_250, 8_000),
  rec("f3", 34_500, 12_000, 22_000, 0),
  rec("f4", 7_600, 7_600, 5_100, 5_100),
  rec("f5", 12_250, 12_250, 0, 0),
  rec("f6", 9_800, 9_800, 6_400, 0),
  rec("f7", 3_000, 0, 0, 0),
  rec("f8", 6_400, 3_200, 4_000, 0, { no_supplier_link: true }),
];

const CARRIERS = [
  { id: "car1", name: "Ridgeway Freight", mc_number: "412233", dot_number: "", contact_name: "", phone: "", email: "", address: "", pay_method: "ach", pay_terms_days: 30, notes: "", load_count: 6, last_used: back(12), last_rate: 1400 },
  { id: "car2", name: "Summit Haulers", mc_number: "889120", dot_number: "3300211", contact_name: "", phone: "", email: "", address: "", pay_method: "check", pay_terms_days: 15, notes: "", load_count: 2, last_used: back(40), last_rate: 950 },
];
const PREFILL = { pickup_name: "Northgate Wholesale", pickup_address: "410 Mercer Ave, Northgate, OH 44120", delivery_name: "Delta Bay Trading", delivery_address: "12 Shore Rd, Lakeside, MI 49001", pickup_options: [] };

const posted: any[] = ((window as any).__posted = []);
const handlers: Record<string, (a: any) => any> = {
  employee_me: () => me,
  list_deal_flows: () => FLOWS,
  list_invoices: () => INVOICES,
  reconciliation_status_all: () => RECON,
  refund_status_all: () => [],
  cleanup_ghost_deal_flows: () => 0,
  deal_allocations: () => [],
  list_suppliers: () => [],
  list_freight_bookings: (a) => (a.dealFlowId === "f6" ? [{ id: "fb_f6", code: "L-f6", load_number: "LD-0101", status: "booked" }] : []),
  logistics_request: ({ method, path, body }: any) => {
    if (method === "GET" && path.startsWith("/api/logistics/settings")) return { freight_by_team: true };
    if (method === "GET" && path.startsWith("/api/logistics/prefill/")) return PREFILL;
    if (method === "GET" && path.startsWith("/api/logistics/carriers")) return { carriers: CARRIERS };
    if (method === "GET" && path.startsWith("/api/logistics/rates")) return { lane: { from: "", to: "" }, last: null, matches: [] };
    if (method === "POST" && path === "/api/logistics/bookings") {
      posted.push(body);
      if (!body.catch_up) return { id: "fb_q", code: "L-q", load_number: "LD-0199", status: "quote" };
      const f = FLOWS.find((x) => x.id === body.deal_flow_id);
      if (f) { f.load_numbers = "LD-0200"; f.logistics_bookings = 1; f.logistics_stage = body.status; }
      return { id: "fb_new", code: "L-new", load_number: "LD-0200", status: body.status };
    }
    return null;
  },
};
(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    if (handlers[cmd]) return Promise.resolve(handlers[cmd](args || {}));
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") ? [] : null);
  },
  transformCallback: () => 1, unregisterListener: () => {}, convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } }, plugins: {},
};

function Harness() {
  // ?view=payments clicks the Payments switch, ?move=INV-5003 then clicks that row's Move button.
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.get("view") === "payments") {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Payments");
        b?.click();
      }
      const want = q.get("move");
      if (want) setTimeout(() => {
        const li = Array.from(document.querySelectorAll("li")).find((x) => x.textContent?.includes(want));
        (Array.from(li?.querySelectorAll("button") ?? []).find((x) => x.textContent?.includes("Move to Logistics")) as HTMLElement | undefined)?.click();
      }, 250);
    }, 600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex h-screen bg-bg">
      <div className="w-[216px] flex-shrink-0 border-r border-line bg-surface" />
      <main className="flex-1 overflow-y-auto p-7 min-w-0">
        <div className="max-w-[1280px] mx-auto"><DealFlowView /></div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
