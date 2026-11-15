// DEV ONLY: the fixture behind harness/r651-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL deal Shipping step and its full-screen Send to
// logistics on invented data. Drafts live in memory; every send is kept in window.__posted. `?draft=1` starts with a
// saved draft, `?bare=1` with a server older than R-651 (no suggestions).
import ReactDOM from "react-dom/client";
import DealShipping from "./components/DealShipping";
import { ToastHost } from "./components/Toast";
import type { DealFlow, FreightBooking } from "./lib/api";
import "./index.css";

type A = Record<string, any>;
const q = new URLSearchParams(location.search);
const posted: A[] = [];
(window as unknown as { __posted: A[] }).__posted = posted;

const place = (o: A) => ({ source: "load", load_number: "", day: "", name: "", address: "", phone: "", window: "", bol_to: "", notes: "", equipment: "", accessorials: "", ...o });
const prefill: A = {
  pickup_name: "Harbor Pallet Co", pickup_address: "100 Example Rd, Springfield, KY 40000",
  delivery_name: "Sample Buyer", delivery_address: "300 Demo Blvd, Riverton, NJ 08000",
  pickup_options: [{ name: "Harbor Pallet Co", address: "100 Example Rd, Springfield, KY 40000" }, { name: "North Yard Goods", address: "" }],
};
if (!q.get("bare")) {
  prefill.pickup_suggestions = [
    place({ source: "deal", load_number: "LD-0040", day: "2026-10-28", name: "Harbor Pallet Co", address: "100 Example Rd, Springfield, KY 40000", phone: "555-010-2000", window: "8:00 am to 2:00 pm", bol_to: "dock@example.com" }),
    place({ load_number: "LD-0037", day: "2026-10-14", name: "Harbor Pallet Co", address: "7 Second Dock Ln, Springfield, KY 40001", phone: "555-010-2100", window: "before 3 pm", bol_to: "yard2@example.com" }),
    place({ load_number: "LD-0031", day: "2026-09-30", name: "North Yard Goods", address: "1 First St, Townsville, OH 43000", phone: "555-010-4000" }),
    place({ load_number: "LD-0022", day: "2026-09-02", name: "Harbor Pallet Co", address: "55 Overflow Rd, Lexington, KY 40502", phone: "555-010-2200" }),
  ];
  prefill.delivery_suggestions = [
    place({ source: "deal", name: "Sample Buyer", address: "300 Demo Blvd, Riverton, NJ 08000" }),
    place({ load_number: "LD-0040", day: "2026-10-28", name: "Sample Buyer Dock 3", address: "200 Test Ave # G, Lakeview, IL 60000", phone: "555-010-3000", window: "ASAP", notes: "Call 15 minutes out", equipment: "Dry van 53 ft", accessorials: "Liftgate at delivery" }),
  ];
}

let draft: A | null = q.get("draft") ? {
  id: "fd_1", deal_flow_id: "df_1", updated_at: "2026-11-14T15:20:00Z", updated_by_name: "Sam",
  body: { pickup_name: "Harbor Pallet Co", pickup_address: "100 Example Rd, Springfield, KY 40000", pallets: "12", request_note: "Second truck may follow" },
  files: [{ id: "fdf_1", name: "packing-list.pdf", mime: "application/pdf", size: 48213 }],
} : null;

const load = { id: "fb_new", load_number: "LD-0043", status: "quote", files: [] } as unknown as FreightBooking;
const flow = { id: "df_1", invoice_id: "inv_1", invoice_number: "INV-1001", stage: "invoiced", supplier_payments: [], updated_at: "2026-10-27T12:00:00Z" } as unknown as DealFlow;

(window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown }).__FIXTURE = (cmd: string, a: A) => {
  if (cmd === "logistics_request") {
    const p = String(a.path);
    if (p.startsWith("/api/logistics/settings")) return { freight_by_team: true };
    if (p.startsWith("/api/logistics/prefill/")) return prefill;
    if (p.startsWith("/api/logistics/drafts/")) {
      const now = new Date().toISOString();
      if (p.endsWith("/discard")) { draft = null; return { draft }; }
      if (a.method === "PUT") { draft = { id: "fd_1", deal_flow_id: "df_1", files: draft?.files ?? [], ...draft, body: a.body.body, updated_at: now, updated_by_name: "Sam" }; return { draft }; }
      if (a.method === "POST" && p.endsWith("/files")) { draft!.files = [...draft!.files, { id: `fdf_${draft!.files.length + 2}`, name: a.body.name, mime: "", size: 1000 }]; return { draft }; }
      if (a.method === "DELETE") { draft!.files = draft!.files.filter((f: A) => !p.endsWith(f.id)); return { draft }; }
      return { draft };
    }
    if (a.method === "POST" && p === "/api/logistics/bookings") { posted.push(a.body); draft = null; return load; }
    if (p.startsWith("/api/logistics/bookings")) return { bookings: [] };
    if (p.startsWith("/api/logistics/carriers")) return { carriers: [] };
    if (p.startsWith("/api/logistics/rates")) return { lane: { from: "Springfield, KY", to: "Riverton, NJ" }, last: null, matches: [] };
    return null;
  }
  switch (cmd) {
    case "list_freight_bookings": return [];
    case "get_invoice": return { id: "inv_1", line_items_json: "[]", shipping_charged: 450, status: "sent" };
    case "get_deal_logistics_pay": return null;
    case "netsync_push_wait": return 0;
    default:
      if (cmd.startsWith("plugin:event|")) return 1;
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <>
    <div className="p-6 max-w-[900px]"><DealShipping flow={flow} onReload={() => {}} locked={false} /></div>
    <ToastHost />
  </>,
);
