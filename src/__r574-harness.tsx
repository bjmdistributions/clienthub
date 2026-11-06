// DEV ONLY: the fixture behind r574-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL Link an invoice card (LinkDelivery) on invented
// data, once as the delivery's Sell tab shows it and once as an invoice or a deal opens it. Every call is kept in
// window.__calls.
import ReactDOM from "react-dom/client";
import LinkDelivery from "./components/LinkDelivery";
import { ToastHost } from "./components/Toast";
import type { Invoice } from "./lib/api";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;

const inv = (id: string, number: string, client: string, lines: A[]): Invoice => ({
  id, client_id: client, number, issue_date: "2026-10-27", due_date: "2026-11-10", line_items_json: JSON.stringify(lines),
  subtotal: lines.reduce((a, l) => a + l.amount, 0), tax: 0, total: lines.reduce((a, l) => a + l.amount, 0), status: "sent",
  pdf_path: null, sent_at: null,
} as unknown as Invoice);
const invoices = [
  inv("i1", "INV-2041", "c1", [
    { description: "Runner mix, men's", qty: 40, rate: 18, amount: 720 },
    { description: "Kids slip-ons", qty: 12, rate: 9, amount: 108 },
    { description: "Shipping", qty: 1, rate: 150, amount: 150 },
  ]),
  inv("i2", "INV-2042", "c2", [{ description: "Boots closeout", qty: 25, rate: 22, amount: 550 }]),
];
(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "list_clients") return [{ id: "c1", name: "Harbor Street Shoes" }, { id: "c2", name: "Pine Market Outlet" }];
  if (cmd === "list_invoices") return invoices;
  if (cmd === "list_warehouse_loads") return [{ id: "L1", name: "Sample truck 7", archived: false }, { id: "L2", name: "Old truck", archived: true }];
  if (cmd === "warehouse_buy_for") return { buy: { id: "B1", name: "Sample truck 7 buy", units_bought: 1000, sold: 0, unit_goods: 10, unit_ship: 2.5, unit_markup: 0 } };
  if (cmd === "get_warehouse_load") return { outs: [] };
  if (cmd === "take_load_pairs") return { load: { id: args.loadId }, outs: [], stock: {} };
  if (cmd === "add_warehouse_buy_order") return { order_id: "o1", own_cost: false };
  return [];
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 bg-canvas min-h-screen grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
    <div>
      <div className="text-[12px] text-muted mb-2">From the delivery's Sell tab</div>
      <LinkDelivery loadId="L1" exclude={new Set()} pick={{ pairs: 0, takes: [] }}
        onLinked={(d, usedPick) => calls.push({ linked: d, usedPick })} onCancel={() => calls.push({ cancelled: "sell" })} />
    </div>
    <div>
      <div className="text-[12px] text-muted mb-2">From an invoice or a deal</div>
      <LinkDelivery invoice={invoices[0]} onLinked={(d) => calls.push({ linked: d, from: "invoice" })} onCancel={() => calls.push({ cancelled: "invoice" })} />
    </div>
    <ToastHost />
  </div>
);
