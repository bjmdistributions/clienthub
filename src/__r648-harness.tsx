// DEV ONLY: the fixture behind harness/r648-harness.html. Nothing in the app imports this and index.html does not reference the
// page, so it never reaches a build. Renders the REAL Warehouse Loads list, the REAL Receive a load form, the REAL load page with
// its pallets, and the Deal Flow stage tints, with the Tauri bridge stubbed. Every name, number and amount here is invented.
//
// Query: ?view=loads|receive|load|tint  &dark=1
// Every call is kept in window.__calls.
import ReactDOM from "react-dom/client";
import WarehouseLoads from "./components/WarehouseLoads";
import PurchaseForm from "./components/PurchaseForm";
import { ToastHost } from "./components/Toast";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = new URLSearchParams(location.search);
window.confirm = () => true;
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const view = q.get("view") || "loads";
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;

const noTrucks = { live: 0, priced: 0, paid: 0, carrier: 0, markup: 0 };
const rollup = (o: A) => ({
  bought: 400, sold: 120, left: 280, goods_total: 2000, ship_total: 400, unit_cost: 6, goods_paid: 2000, ship_paid: 400, cost_sold: 720, sales: 1500, received: 1500,
  other_cost: 0, refunds: 0, made_on_sold: 780, made_so_far: 780, sold_out: false, oversold: false, markup_total: 0, load_cost: 2400, cost_on_hand: 1680, markup_sold: 0,
  units_ordered: 400, units_received: 400, short: 0, refund_owed: 0, refund_owed_typed: null, refund_received: 0, refund_counted: 0, refund_left: 0,
  goods_net: 2000, spent: 2400, owed_supplier: 0, cost_projected: false, state: "received", ...o,
});
const buyOf = (o: A) => ({
  id: "buy_1", item_id: "", load_id: "", stock_name: "", name: "Harbor Supply, invoice 4471", supplier_id: "s1", supplier_name: "Harbor Supply", units_bought: 400,
  goods_total: 2000, ship_total: 400, ship_typed: 0, markup_total: 0, notes: "", archived: false, on_the_way: true, created_at: "2026-11-01", updated_at: "2026-11-09",
  invoice_no: "4471", invoice_date: "2026-11-01", lines: [{ what: "Snapback hats, assorted", qty: 300, price: 5 }, { what: "Beanies, black", qty: 100, price: 5 }],
  units_received: 400, received_at: "2026-11-04", refund_owed_typed: null, manifest_name: "", from_deal_id: "", state: "received", ...o,
});
const truck = { id: "fb1", code: "LD-0042", status: "delivered", truck_no: 1, trucks: 1, carrier: "Test Freight Lines", rate: 400, paid: 400, markup: null, quote_amount: null,
  bank_txn_id: "t9", pickup_date: "2026-11-02", delivery_date: "2026-11-04", delivery_window: "", delivery_appt_time: "", delivered_at: "2026-11-04", delivered_time: "" };
const detail = () => ({
  buy: buyOf({}), rollup: rollup({}), unit_goods: 5, unit_ship: 1, unit_markup: 0, trucks: [truck], truck_cost: { live: 1, priced: 1, paid: 1, carrier: 400, markup: 0 },
  orders: [{
    id: "bo1", invoice_id: "i1", number: "INV-3101", client: "Whatnot", stage: "invoiced", voided: false, count: 120, undone: false, own_cost: false, typed: false,
    deal_flow_id: "df1", goods: 600, ship: 120, markup: 0, goods_paid: true, ship_paid: true, past_bought: false, cost: 720, sales: 1500,
    received: 1500, other_cost: 0, refunds: 0, made: 780, created_at: "2026-11-08", on_deal: 720, wanted: 720,
  }],
  payments: [{ txn_id: "t1", kind: "goods", amount: 2000, posted_at: "2026-11-01", name: "Harbor Supply wire", cash: false, booked_here: 2000, booked_elsewhere: 0 }],
  missing: [], in_step: true, can_book_bank: true,
});
const row = (id: string, supplier: string, inv: string, b: A, r: A) => ({
  id, name: `${supplier}, invoice ${inv}`, supplier_id: "s", supplier_name: supplier, item_id: "", load_id: "", on_the_way: true,
  buy: buyOf({ id, supplier_name: supplier, invoice_no: inv, ...b }), rollup: rollup(r), truck_cost: noTrucks, orders: 1, in_step: true,
});
const purchases = [
  row("buy_1", "Harbor Supply", "4471", {}, {}),
  row("buy_2", "Pine Ridge Wholesale", "A-208", { received_at: "", units_received: null }, { sold: 0, left: 480, bought: 480, goods_total: 3120, ship_total: 0, unit_cost: 6.5, made_so_far: 0, cost_on_hand: 3120, state: "ordered" }),
  row("buy_3", "Lakeside Closeouts", "7782", { received_at: "2026-10-20" }, { sold: 90, left: 0, bought: 90, goods_total: 800, ship_total: 80, unit_cost: 9.78, made_so_far: -42.5, cost_on_hand: 0, state: "done" }),
];
const standalone = (id: string, code: string, from: string, to: string, day: string, status: string) => ({
  id, code, status, pickup_name: from, delivery_name: to, pickup_date: day, standalone: true, buy: null, deal: null,
});

(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "employee_me") return { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "r", role_name: "Owner", permissions: ["*"], is_admin: true };
  if (cmd === "list_warehouse_buys") return { stock: [], coming: [], purchases };
  if (cmd === "get_warehouse_buy") return detail();
  if (cmd === "search_suppliers") return [{ id: "s1", name: "Harbor Supply" }];
  if (cmd === "list_warehouse_loads") return [{ id: "wl1", name: "Harbor Supply, invoice 4471", source: "", notes: "", archived: false, created_at: "", updated_at: "", unit: "units", buy_id: "buy_1", totals: {} }];
  if (cmd === "get_warehouse_load") return { load: { id: "wl1", name: "Harbor Supply, invoice 4471", buy_id: "buy_1" }, cases: [], tally: {}, outs: [], stock: {}, recent_locations: [],
    pallets: [1, 2, 3].map((n) => ({ pallet: n, location: "Bay 4", closed: false, note: "", recorded: true, boxes: 0, loose: 0, pairs: 0, styles: 0, cost: 0, msrp: 0 })) };
  if (cmd === "logistics_request") return { bookings: [
    standalone("fb7", "LD-0051", "Harbor Supply", "Our warehouse", "2026-11-12", "booked"),
    standalone("fb8", "LD-0052", "Pine Ridge Wholesale", "Our warehouse", "2026-11-14", "quoted"),
  ] };
  if (cmd === "create_warehouse_buy") return detail();
  return null;
};

const page = (children: React.ReactNode) => (
  <div className="p-8 bg-canvas min-h-screen"><div className="max-w-[1100px] mx-auto">{children}</div></div>
);
const STAGES: [string, string][] = [["ready", "Ready to complete"], ["paymentMissing", "Delivered, payment still missing"], ["onTheWay", "On the way"],
  ["waitingPickup", "Waiting on pickup"], ["withLogistics", "With Logistics"], ["notSetUp", "Shipping not set up"]];
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (view === "receive") root.render(page(<><PurchaseForm detail={null} onCancel={() => calls.push({ cancelled: true })} onSaved={(d) => calls.push({ saved: d.buy.id })} /><ToastHost /></>));
else if (view === "tint") root.render(page(
  <div className="space-y-4">
    {STAGES.map(([k, t]) => (
      <section key={k}>
        <div className="flex items-center gap-2.5 min-h-[40px] px-3"><span className="text-[14px] font-medium text-ink">{t} (1)</span></div>
        <div className={`rounded-xl border bg-surface border-line df-stage df-stage-${k} px-4 py-4 text-[13px] text-ink`}>INV-30{k.length} · Pine Market Outlet · $4,200.00</div>
      </section>
    ))}
  </div>,
));
else root.render(page(<><WarehouseLoads onOpenStock={() => calls.push({ openStock: true })} onShowPallets={(id) => calls.push({ showPallets: id })} onAddManifest={(b) => calls.push({ manifest: b.id })} /><ToastHost /></>));
