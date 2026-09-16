// DEV ONLY — the fixture behind r318-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL DealFlowView inside the app's own shell geometry (216px sidebar, p-7)
// so R-318's green "Delivered — ready to complete" strip can be seen rather than assumed,
// and fires the delivery toast the way `shipment-delivered` does in the app. Every name,
// number and BOL below is invented.
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import DealFlowView from "./components/DealFlowView";
import { ToastHost, toast } from "./components/Toast";
import { localDay } from "./lib/format";
import "./index.css";

const TODAY = localDay();
const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); };
const ahead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };

const flow = (o: Record<string, any>) => ({
  deposit_amount: 0, payment_received_method: null, payment_received_at: null,
  payment_received_amount: 0, supplier_payments_json: "[]", supplier_payments: [],
  supplier_owed: 0, own_costs_unpaid: 0, own_costs_total: 0, total_supplier_cost: 0,
  completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0,
  profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null, name: null,
  created_at: back(30), updated_at: TODAY, invoice_total: 0, client_id: "c1",
  ships_direct: false, pickup_date: null, expected_delivery_date: null,
  pickup_date_prev: null, expected_delivery_date_prev: null,
  refund_owed: 0, refund_total: 0, ...o,
});

const FLOWS = [
  // Two landed loads waiting on nothing but a click.
  flow({ id: "f1", invoice_id: "i1", invoice_number: "INV-4102", client_name: "Harbour Goods",
    stage: "payment_received", invoice_total: 41_800, payment_received_amount: 41_800,
    pickup_date: back(6), expected_delivery_date: back(1) }),
  flow({ id: "f2", invoice_id: "i2", invoice_number: "INV-4098", client_name: "Cedar Lane Resale",
    stage: "supplier_paid", invoice_total: 12_250, pickup_date: back(9), expected_delivery_date: TODAY }),
  // Still moving — stays in the waiting lane.
  flow({ id: "f3", invoice_id: "i3", invoice_number: "INV-4110", client_name: "Delta Bay Trading",
    stage: "invoiced", invoice_total: 34_500, pickup_date: back(1), expected_delivery_date: ahead(4) }),
  // No dates at all — the plain active list.
  flow({ id: "f4", invoice_id: "i4", invoice_number: "INV-4112", client_name: "Coastline Discount",
    stage: "invoiced", invoice_total: 7_600 }),
];

const inv = (o: Record<string, any>) => ({
  client_id: "c1", line_items_json: "[]", subtotal: 0, tax: 0, status: "sent", pdf_path: null,
  cost_items_json: null, total_cost: null, profit: null, margin: null, carrier: null,
  tracking_number: null, shipping_charged: null, pickup_date: null, delivery_date: null,
  is_complete: false, voided: false, archived: false, issue_date: TODAY, due_date: ahead(14),
  sent_at: `${back(3)}T12:00:00Z`, client_name: "Harbour Goods", ...o,
});

const INVOICES = [
  inv({ id: "i1", number: "INV-4102", total: 41_800 }),
  inv({ id: "i2", number: "INV-4098", total: 12_250, client_name: "Cedar Lane Resale" }),
  inv({ id: "i3", number: "INV-4110", total: 34_500, client_name: "Delta Bay Trading" }),
  inv({ id: "i4", number: "INV-4112", total: 7_600, client_name: "Coastline Discount" }),
];

const ship = (o: Record<string, any>) => ({
  broker: "Priority1", shipment_number: "", pro: "", pickup_number: "", refs_json: "[]",
  carrier: "EDI Express (EDXI)", status: "", origin: "Fair Lawn, NJ", destination: "Orlando, FL",
  last_location: "", last_note: "", details_url: "", events_json: "[]", dismissed: 0,
  created_at: back(6), updated_at: TODAY, ...o,
});

const SHIPMENTS = [
  ship({ id: "shp-1", deal_flow_id: "f1", bol: "60115779865", stage: "delivered", status: "Delivered",
    last_note: "Delivered, signed by J SMITH", last_update_at: `${back(1)}T20:12:00Z`,
    events_json: JSON.stringify([{ at: `${back(1)}T20:12:00Z`, status: "Delivered", location: "Orlando, FL", note: "Signed by J SMITH" }]) }),
  ship({ id: "shp-2", deal_flow_id: "f2", bol: "70220011223", stage: "delivered", status: "Delivered",
    carrier: "Estes Express (EXLA)", destination: "Dalton, GA", last_update_at: `${TODAY}T14:30:00Z` }),
  ship({ id: "shp-3", deal_flow_id: "f3", bol: "80330022114", stage: "in_transit", status: "In transit",
    carrier: "Southeastern (SEFL)", last_location: "Atlanta, GA", last_update_at: `${TODAY}T06:02:00Z` }),
  // One that never made it onto a deal, so the list below the strip is not empty.
  ship({ id: "shp-4", deal_flow_id: "", bol: "90440033225", stage: "out_for_delivery",
    status: "Out for delivery", carrier: "AAA Cooper (AACT)", destination: "Mesquite, TX",
    last_update_at: `${TODAY}T09:44:00Z` }),
];

const FIXTURE: Record<string, any> = {
  list_deal_flows: FLOWS,
  list_invoices: INVOICES,
  list_shipments: SHIPMENTS,
  reconciliation_status_all: [],
  refund_status_all: [],
  cleanup_ghost_deal_flows: 0,
  suggest_shipment_deals: [{ deal_flow_id: "f4", label: "INV-4112 · Coastline Discount", score: 40, reason: "buyer is in the destination state" }],
  list_suppliers: [],
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) => Promise.resolve(cmd in FIXTURE ? FIXTURE[cmd] : null),
  transformCallback: (cb: any) => { (window as any).__cb = cb; return 1; },
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

function Harness() {
  // What `shipment-delivered` does in App.tsx, so the popup is on screen beside the strip.
  useEffect(() => {
    const t = setTimeout(() => toast("Delivered — Harbour Goods · INV-4102. Ready to mark the deal complete.", "delivered"), 400);
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
