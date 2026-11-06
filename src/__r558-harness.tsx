// DEV ONLY: the fixture behind r558-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL deal Shipping step (its Send to logistics
// sheet), the buy sheet and a load page on invented data; every send is kept in window.__posted.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import DealShipping from "./components/DealShipping";
import BuySendSheet from "./components/BuySendSheet";
import LogisticsBookingForm from "./components/LogisticsBookingForm";
import { ToastHost } from "./components/Toast";
import type { DealFlow, FreightBooking } from "./lib/api";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const posted: A[] = [];
(window as unknown as { __posted: A[] }).__posted = posted;

const load = {
  id: "fb_1", code: "L-ab12cd", load_number: "LD-0042", status: "quote", booked_at: "", request_note: "",
  pickup_name: "Harbor Pallet Co", pickup_address: "100 Example Rd, Springfield, KY 40000", pickup_date: "2026-10-28", pickup_window: "12:30-1:30PM",
  pickup_contact: "", pickup_phone: "555-010-2000", pickup_notes: "Send BOL to: dock@example.com with me in copy",
  delivery_name: "Sample Warehouse", delivery_address: "200 Test Ave # G, Lakeview, IL, 60000", delivery_date: "2026-10-28", delivery_window: "ASAP",
  delivery_contact: "", delivery_phone: "555-010-3000", delivery_notes: "driver to call when 15 minutes out", delivered_at: "",
  carrier: "", broker: "", service: "", equipment: "Dry van 53 ft", bol: "", pro: "", pickup_number: "", reference: "", tracking_url: "",
  driver_name: "", driver_phone: "", truck_number: "", trailer_number: "",
  pallets: "26", pieces: "", weight_lbs: "13000", freight_class: "", dimensions: "48 x 40 x 81", commodity: "", accessorials: "",
  quoted_cost: null, paid_amount: null, paid_at: "", paid_method: "", paid_note: "", notes: "",
  created_by_name: "Sam", updated_by_name: "", created_at: "2026-10-27T12:00:00Z", updated_at: "2026-10-27T12:00:00Z",
  can_see_names: true, can_see_addresses: true, can_see_deal: true, tracking: null, deal: { id: "df_1", invoice_number: "INV-1001", client_name: "Sample Buyer", stage: "invoiced" },
  extra_pickups: [], files: [], urgent: false,
} as unknown as FreightBooking;

const flow = { id: "df_1", invoice_id: "inv_1", invoice_number: "INV-1001", stage: "invoiced", supplier_payments: [], updated_at: "2026-10-27T12:00:00Z" } as unknown as DealFlow;

(window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown }).__FIXTURE = (cmd: string, a: A) => {
  if (cmd === "logistics_request") {
    const p = String(a.path);
    if (p.startsWith("/api/logistics/settings")) return { freight_by_team: true };
    if (p.startsWith("/api/logistics/prefill-buy/")) return { pickup_name: "North Yard", pickup_address: "1 First St, Townsville, OH 43000", delivery_name: "Sample Warehouse", delivery_address: "200 Test Ave, Lakeview, IL 60000" };
    if (p.startsWith("/api/logistics/prefill/")) return { pickup_name: "Harbor Pallet Co", pickup_address: "100 Example Rd, Springfield, KY 40000", delivery_name: "Sample Buyer", delivery_address: "300 Demo Blvd, Riverton, NJ 08000", pickup_options: [] };
    if (a.method === "POST" && p === "/api/logistics/bookings") { posted.push(a.body); return a.body.buy_id ? { bookings: [{ ...load, id: "fb_new" }] } : { ...load, id: "fb_new" }; }
    if (p.startsWith("/api/logistics/bookings")) return { bookings: [] };
    if (p.startsWith("/api/logistics/carriers")) return { carriers: [] };
    return null;
  }
  switch (cmd) {
    case "list_freight_bookings": return [];
    case "get_invoice": return { id: "inv_1", line_items_json: "[]", shipping_charged: 0, status: "sent" };
    case "netsync_push_wait": return 0;
    default:
      if (cmd.startsWith("plugin:event|")) return 1;
      return null;
  }
};

function Harness() {
  const [buy, setBuy] = useState(false);
  const [page, setPage] = useState(false);
  return (
    <div className="p-6 space-y-4 max-w-[900px]">
      <div className="flex gap-2">
        <button id="h-buy" className="px-3 h-9 rounded-lg border border-line text-[13px]" onClick={() => setBuy(true)}>Open buy sheet</button>
        <button id="h-load" className="px-3 h-9 rounded-lg border border-line text-[13px]" onClick={() => setPage(true)}>Open load page</button>
      </div>
      <DealShipping flow={flow} onReload={() => {}} locked={false} />
      {buy && <BuySendSheet buy={{ id: "buy_1", name: "Mixed apparel" }} live={0} onClose={() => setBuy(false)} onSent={() => setBuy(false)} />}
      {page && <LogisticsBookingForm booking={load} onClose={() => setPage(false)} onSaved={() => {}} onChanged={() => {}} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<><Harness /><ToastHost /></>);
