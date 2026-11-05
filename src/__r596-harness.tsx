// DEV ONLY: the fixture behind r596-harness.html. Nothing in the app imports this and index.html does not reference the page, so
// it never reaches a build. Renders the REAL Purchases list, the REAL New order form and the REAL order panel (a shorted order
// with part of its refund received) with the Tauri bridge stubbed. Every name, number and amount here is invented.
//
// Query: ?view=list|new|order|clean  &dark=1  &numbers=0 (a person who may not see dollars)
// Every call is kept in window.__calls.
import ReactDOM from "react-dom/client";
import PurchasesView from "./components/PurchasesView";
import PurchaseForm from "./components/PurchaseForm";
import PurchasePanel from "./components/PurchasePanel";
import { ToastHost } from "./components/Toast";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = new URLSearchParams(location.search);
window.confirm = () => true;
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const view = q.get("view") || "list";
const numbers = q.get("numbers") !== "0";
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;

const noTrucks = { live: 0, priced: 0, paid: 0, carrier: 0, markup: 0 };
const rollup = (o: A) => ({
  bought: 200, sold: 0, left: 150, goods_total: 1500, ship_total: 0, unit_cost: 7.5, goods_paid: 1500, ship_paid: 0, cost_sold: 0, sales: 0, received: 0,
  other_cost: 0, refunds: 0, made_on_sold: 0, made_so_far: 0, sold_out: false, oversold: false, markup_total: 0, load_cost: 1125, cost_on_hand: 1125, markup_sold: 0,
  units_ordered: 200, units_received: 150, short: 50, refund_owed: 375, refund_owed_typed: null, refund_received: 100, refund_counted: 375, refund_left: 275,
  goods_net: 1125, spent: 1400, owed_supplier: 0, cost_projected: true, state: "refund_owed", ...o,
});
const buyOf = (o: A) => ({
  id: "buy_1", item_id: "", load_id: "", stock_name: "", name: "Harbor Supply, invoice 4471", supplier_id: "s1", supplier_name: "Harbor Supply", units_bought: 200,
  goods_total: 1500, ship_total: 0, ship_typed: 0, markup_total: 0, notes: "Pallets 1 to 4", archived: false, on_the_way: true, created_at: "2026-10-01", updated_at: "2026-10-09",
  invoice_no: "4471", invoice_date: "2026-10-01", lines: [{ what: "Canvas totes, large", qty: 100, price: 10 }, { what: "Canvas totes, small", qty: 100, price: 5 }],
  units_received: 150, received_at: "2026-10-08", refund_owed_typed: null, manifest_name: "harbor-4471.csv", from_deal_id: "", state: "refund_owed", ...o,
});
const detail = (b: A = {}, r: A = {}, extra: A = {}) => ({
  buy: buyOf(b), rollup: rollup(r), unit_goods: 7.5, unit_ship: 0, unit_markup: 0, trucks: [], truck_cost: noTrucks,
  orders: [{
    id: "bo1", invoice_id: "i1", number: "INV-3010", client: "Pine Market Outlet", stage: "invoiced", voided: false, count: 50, undone: false, own_cost: false, typed: false,
    deal_flow_id: "df1", goods: 375, ship: 0, markup: 0, goods_net: 375, refund: 0, goods_paid: true, ship_paid: false, past_bought: false, cost: 375, sales: 600,
    received: 0, other_cost: 0, refunds: 0, made: 225, created_at: "2026-10-12", on_deal: 375, wanted: 375,
  }],
  payments: [
    { txn_id: "t1", kind: "goods", amount: 1500, posted_at: "2026-10-02", name: "Harbor Supply wire", cash: false, booked_here: 1500, booked_elsewhere: 0 },
    { txn_id: "t2", kind: "refund", amount: 100, posted_at: "2026-10-20", name: "Harbor Supply refund", cash: false, booked_here: 100, booked_elsewhere: 0 },
  ],
  missing: [], in_step: true, can_book_bank: true, ...extra,
});
const row = (id: string, supplier: string, inv: string, b: A, r: A) => ({
  id, name: `${supplier}, invoice ${inv}`, supplier_id: "s", supplier_name: supplier, item_id: "", load_id: "", on_the_way: true,
  buy: buyOf({ id, supplier_name: supplier, invoice_no: inv, ...b }), rollup: rollup(r), truck_cost: noTrucks, orders: 1, in_step: true,
});
const purchases = [
  row("buy_1", "Harbor Supply", "4471", {}, {}),
  row("buy_2", "Pine Ridge Wholesale", "A-208", { invoice_date: "2026-10-14", units_received: null, received_at: "" },
    { units_ordered: 480, units_received: null, short: 0, refund_owed: 0, refund_received: 0, refund_left: 0, spent: 0, owed_supplier: 3120, goods_paid: 0, cost_projected: false, state: "ordered" }),
  row("buy_3", "Lakeside Closeouts", "7782", { invoice_date: "2026-09-02" },
    { units_ordered: 90, units_received: 90, short: 0, refund_owed: 0, refund_received: 0, refund_left: 0, spent: 880, owed_supplier: 0, cost_projected: false, state: "done" }),
  row("buy_4", "Maple Street Imports", "1190", { invoice_date: "2026-10-05" },
    { units_ordered: 300, units_received: null, short: 0, refund_owed: 0, refund_received: 0, refund_left: 0, spent: 2400, owed_supplier: 0, cost_projected: false, state: "on_truck" }),
];

(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "employee_me") return { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "r", role_name: "Owner", permissions: numbers ? ["*"] : [], is_admin: numbers };
  if (cmd === "list_warehouse_buys") return { stock: [], coming: [], purchases };
  if (cmd === "get_warehouse_buy") return view === "clean" ? detail({ units_received: null, received_at: "", state: "ordered", manifest_name: "" },
    { units_received: null, short: 0, refund_owed: 0, refund_received: 0, refund_left: 0, cost_projected: false, state: "ordered", spent: 1500, bought: 200, left: 200, unit_cost: 7.5, goods_net: 1500 }, { payments: [], orders: [] }) : detail();
  if (cmd === "search_suppliers") return [{ id: "s1", name: "Harbor Supply" }, { id: "s2", name: "Harbor Freight Surplus" }];
  if (cmd === "unallocated_bank_txns") return { money_out: [], money_in: [{ id: "m1", posted_at: "2026-10-27", counterparty_name: "Harbor Supply", description: "Deposit", direction: "in", unallocated: 275, original: 275, amount: 275, category: "" }] };
  if (cmd === "create_warehouse_buy" || cmd === "update_warehouse_buy") return detail();
  return null;
};

const page = (children: React.ReactNode) => (
  <div className="p-8 bg-canvas min-h-screen"><div className="max-w-[1100px] mx-auto">{children}</div></div>
);
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (view === "new") root.render(page(<><PurchaseForm detail={null} onCancel={() => calls.push({ cancelled: true })} onSaved={(d) => calls.push({ saved: d.buy.id })} /><ToastHost /></>));
else if (view === "order" || view === "clean") root.render(page(<><PurchasePanel buyId="buy_1" onRemoved={() => calls.push({ removed: true })} /><ToastHost /></>));
else root.render(page(<><PurchasesView /><ToastHost /></>));
