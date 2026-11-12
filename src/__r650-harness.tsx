// DEV ONLY: the fixture behind harness/r650-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Opens the REAL load page at its Pay step with a carrier invoice
// PDF in Paperwork, and the REAL Pay carriers list, so opening the file can be watched. Every value here is invented.
import ReactDOM from "react-dom/client";
import LogisticsBookingForm from "./components/LogisticsBookingForm";
import { ToastHost } from "./components/Toast";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { FreightBooking } from "./lib/api";
import "./index.css";

type A = Record<string, any>;
const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (INVOICE TEST) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
// ?file=multi is a three page Letter invoice; ?file=png is a photo of one.
const kindOf = q.get("file") || "tiny";
const file = { id: "ff_1", name: kindOf === "png" ? "carrier-invoice-4471.png" : "carrier-invoice-4471.pdf", mime: kindOf === "png" ? "image/png" : "application/pdf",
  size: PDF.length, kind: "carrier_invoice", by: "Sam", at: "2026-11-11T12:00:00Z" };
async function fileData(): Promise<string> {
  if (kindOf === "png") {
    const c = document.createElement("canvas"); c.width = 600; c.height = 800;
    const g = c.getContext("2d")!; g.fillStyle = "#f4f1ea"; g.fillRect(0, 0, 600, 800); g.fillStyle = "#222"; g.font = "28px sans-serif"; g.fillText("PHOTO OF AN INVOICE", 60, 120);
    return c.toDataURL("image/png").split("base64,")[1];
  }
  if (kindOf === "multi") {
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 3; n++) {
      const pg = d.addPage([612, 792]);
      pg.drawText(`Test Freight Lines, invoice 4471, page ${n} of 3`, { x: 50, y: 730, size: 18, font: f });
      for (let i = 0; i < 20; i++) pg.drawText(`Line ${i + 1}: linehaul, fuel, detention   ${(100 + i * 7).toFixed(2)}`, { x: 50, y: 680 - i * 28, size: 12, font: f });
    }
    return await d.saveAsBase64();
  }
  return btoa(PDF);
}

const load = {
  id: "fb_1", code: "L-ab12cd", load_number: "LD-0042", status: "delivered", booked_at: "2026-11-03", request_note: "",
  pickup_name: "Harbor Pallet Co", pickup_address: "100 Example Rd, Springfield, KY 40000", pickup_date: "2026-11-04", pickup_window: "",
  pickup_contact: "", pickup_phone: "", pickup_notes: "",
  delivery_name: "Sample Warehouse", delivery_address: "200 Test Ave, Lakeview, IL 60000", delivery_date: "2026-11-06", delivery_window: "",
  delivery_contact: "", delivery_phone: "", delivery_notes: "", delivered_at: "2026-11-06", picked_up_at: "2026-11-04",
  carrier: "Test Freight Lines", broker: "", service: "", equipment: "Dry van 53 ft", bol: "", pro: "", pickup_number: "", reference: "", tracking_url: "",
  driver_name: "", driver_phone: "", truck_number: "", trailer_number: "",
  pallets: "26", pieces: "", weight_lbs: "13000", freight_class: "", dimensions: "", commodity: "", accessorials: "",
  quoted_cost: 900, paid_amount: null, paid_at: "", paid_method: "", paid_note: "", notes: "",
  created_by_name: "Sam", updated_by_name: "", created_at: "2026-11-01T12:00:00Z", updated_at: "2026-11-06T12:00:00Z",
  can_see_names: true, can_see_addresses: true, can_see_deal: true, can_see_money: true, tracking: null,
  deal: { id: "df_1", invoice_number: "INV-1001", client_name: "Sample Buyer", stage: "invoiced" },
  extra_pickups: [], files: [file], urgent: false,
} as unknown as FreightBooking;

const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;
(window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown }).__FIXTURE = (cmd: string, a: A) => {
  calls.push({ cmd, a });
  if (cmd === "logistics_request") {
    const p = String(a.path);
    if (p === "/api/logistics/bookings/fb_1/files/ff_1") return fileData().then((data) => ({ name: file.name, mime: file.mime, size: file.size, data }));
    if (p.startsWith("/api/logistics/settings")) return { freight_by_team: true };
    if (p.startsWith("/api/logistics/bookings/fb_1")) return load;
    if (p.startsWith("/api/logistics/bookings")) return { bookings: [load] };
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

// ?auto=1 opens the carrier invoice by itself, for a browser no one can click in (Edge under a screenshot).
if (q.get("auto") === "1") {
  const tick = setInterval(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent?.includes(file.name));
    if (b) { clearInterval(tick); b.click(); }
  }, 300);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <><LogisticsBookingForm booking={load} initialStep="pay" onClose={() => {}} onSaved={() => {}} onChanged={() => {}} /><ToastHost /></>,
);
