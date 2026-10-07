// DEV ONLY: the fixture behind r464-harness.html (a copy of the R-459 one, grown for R-463, R-464 and R-465).
// Nothing in the app imports this and index.html does not reference the page, so it never reaches a build.
//
// R-464 additions: the load page is a full page over the content area (the harness puts it in a positioned
// <main>, as the app does), the tracker, the Invoice section, the booking gate (the stub applies the server's
// four refusals in order and the override), "We pay this shipping ourselves", the quote's carrier cost and
// markup, and Change on a paid amount. Extra query: &sent=1 (the invoice has been sent) &editable=1 (logistics
// may change the markup) &settings=1 (view the logistics pay settings).
//
// Renders the REAL LogisticsView (as the owner and as the Logistics account) and the REAL DealShipping
// step inside the app's shell geometry (216px sidebar, p-7), with the Tauri bridge stubbed. The stub
// answers the Logistics routes from nine invented loads (one per list group) and applies the two server
// rules the form depends on: a quote with an amount becomes quoted, and a pickup day moves the status.
// Every name, number and amount here is invented.
//
// Query: ?view=logistics|shipping|bills|bols|numbering|palette  &as=team|logistics  &dark=1  &tab=Carriers|Pay carriers (click that Logistics view)
//        &open=LD-0004  (click that load's row)  &step=Quote|Invoice|Book|Pickup|Delivery|Pay  &paid=1 (the customer has paid)
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import LogisticsView from "./components/LogisticsView";
import DealShipping from "./components/DealShipping";
import { CarriersToPaySection } from "./components/LogisticsPayCarriers";
import BolsView from "./components/BolsView";
import CommandPalette from "./components/CommandPalette";
import { LogisticsNumberingSetting, LogisticsPaySettingsForm as LogisticsPaySettingsPanel } from "./components/LogisticsPay";
import { canPayCarriers } from "./lib/logisticsCarriers";
import { ToastHost } from "./components/Toast";
import { localDay } from "./lib/format";
import "./index.css";

const q = new URLSearchParams(location.search);
// A confirm sheet would block the page in a headless run, so the harness answers yes.
window.confirm = () => true;
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

type Who = "team" | "logistics";
const state = { who: (q.get("as") === "logistics" ? "logistics" : "team") as Who, paid: q.get("paid") === "1", sent: q.get("sent") === "1" || q.get("paid") === "1", editable: q.get("editable") === "1" };

const today = localDay();
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return localDay(d); })();
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); };

const blank = {
  status: "requested", request_note: "", booked_at: "",
  pickup_name: "Northgate Wholesale", pickup_address: "410 Mercer Ave, Northgate, OH 44120", pickup_date: "", pickup_window: "",
  pickup_contact: "", pickup_phone: "", pickup_notes: "",
  delivery_name: "Lakeside Discount Co", delivery_address: "12 Shore Rd, Lakeside, MI 49001", delivery_date: "", delivery_window: "",
  delivery_contact: "", delivery_phone: "", delivery_notes: "", delivered_at: "",
  carrier: "", broker: "", service: "", equipment: "", bol: "", pro: "", pickup_number: "", reference: "", tracking_url: "",
  driver_name: "", driver_phone: "", truck_number: "", trailer_number: "",
  pallets: "6", pieces: "", weight_lbs: "5400", freight_class: "", dimensions: "48 x 40 x 52", commodity: "Shelving units", accessorials: "",
  quoted_cost: null as number | null, paid_amount: null as number | null, paid_at: "", paid_method: "", paid_note: "", notes: "",
  created_by_name: "Sam Rivera", updated_by_name: "", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
  tracking: null, extra_pickups: [] as any[], urgent: false, files: [] as any[],
  quote_amount: null as number | null, quote_note: "", quoted_at: "", quoted_by_name: "", quote_invoiced_at: "", quote_invoiced_amount: null as number | null,
  pickup_appt_time: "", picked_up_at: "", picked_up_time: "", delivery_appt_time: "", delivered_time: "", pickup_dock: "", delivery_dock: "",
  pickup_number_confirmed_at: "", pickup_number_confirmed_by: "", pay_due_date: "", carrier_pay_method: "", bols: [] as any[], bank_linked: "",
  shipping_charge: "", book_override_at: "", book_override_by: "", quote_cost: null as number | null, markup_pct: null as number | null,
  markup_amount: null as number | null, markup_by_name: "", markup_at: "",
};
const file = (id: string, name: string, kind: string) => ({ id, name, mime: "application/pdf", size: 120_000, by: "Ines Okafor", at: "2026-10-04T12:00:00Z", kind });
const deal = { id: "d1", invoice_number: "INV-6001", client_name: "Lakeside Discount Co", stage: "invoiced" };

const LOADS: any[] = [
  { ...blank, id: "fb_1", load_number: "LD-0001", status: "quote", urgent: true, pickup_date: tomorrow, request_note: "Dock closes at 3. Call the office first." },
  { ...blank, id: "fb_2", load_number: "LD-0002", status: "quoted", quote_cost: 1650, markup_pct: 12, markup_amount: 198, quote_amount: 1848, markup_by_name: "Ines Okafor", markup_at: today,
    quote_note: "Includes liftgate at delivery.", quoted_at: today, quoted_by_name: "Ines Okafor", equipment: "Dry van 53 ft" },
  { ...blank, id: "fb_3", load_number: "LD-0003", status: "requested", pickup_date: tomorrow, equipment: "Reefer", pickup_number: "PU-3310", shipping_charge: "invoice",
    quote_cost: 1000, markup_pct: 10, markup_amount: 100, quote_amount: 1100, quote_invoiced_at: today, quote_invoiced_amount: 1100, book_override_at: today + "T09:00:00Z", book_override_by: "Owner" },
  { ...blank, id: "fb_4", load_number: "LD-0004", status: "booked", shipping_charge: "own", quote_cost: 1400, markup_pct: 8, markup_amount: 112, quote_amount: 1512,
    booked_at: daysAgo(1), carrier: "Ridgeway Freight", broker: "Summit Load Desk", bol: "RW48211",
    pickup_date: today, pickup_appt_time: "09:30", pickup_number: "PU-7731", quoted_cost: 1500, equipment: "Flatbed", pickup_dock: "Door 4" },
  { ...blank, id: "fb_5", load_number: "LD-0005", status: "picked_up", carrier_id: "c1", booked_at: daysAgo(3), carrier: "Ridgeway Freight", pickup_date: daysAgo(2), picked_up_at: daysAgo(2),
    picked_up_time: "10:05", delivery_date: tomorrow, quoted_cost: 1500, pickup_number: "PU-1180", pickup_number_confirmed_at: daysAgo(3), pickup_number_confirmed_by: "Ines Okafor" },
  { ...blank, id: "fb_6", load_number: "LD-0006", status: "delivered", booked_at: daysAgo(8), carrier: "Harbor Lines", delivered_at: daysAgo(1), picked_up_at: daysAgo(4),
    files: [file("f1", "bol-signed.pdf", "bol")] },
  { ...blank, id: "fb_7", load_number: "LD-0007", status: "delivered", carrier_id: "c3", booked_at: daysAgo(9), carrier: "Northline Freight", quoted_cost: 1320, delivered_at: daysAgo(3), picked_up_at: daysAgo(6),
    pay_due_date: daysAgo(1), carrier_pay_method: "Zelle", files: [file("f2", "bol-signed.pdf", "bol"), file("f3", "pod.pdf", "pod"), file("f4", "carrier-invoice.pdf", "carrier_invoice")] },
  { ...blank, id: "fb_8", load_number: "LD-0008", status: "delivered", carrier_id: "c3", booked_at: daysAgo(14), carrier: "Northline Freight", quoted_cost: 1210, paid_amount: 1210, paid_at: daysAgo(5),
    paid_method: "Zelle", paid_note: "ref 4471", delivered_at: daysAgo(8), picked_up_at: daysAgo(11), bank_linked: "linked", carrier_pay_method: "Zelle",
    files: [file("f5", "bol-signed.pdf", "bol"), file("f6", "pod.pdf", "pod"), file("f7", "carrier-invoice.pdf", "carrier_invoice")], bols: [{ id: "bol_1", number: "BOL-0003" }] },
  { ...blank, id: "fb_9", load_number: "LD-0009", status: "cancelled", carrier: "Harbor Lines" },
  { ...blank, id: "fb_10", load_number: "LD-0010", status: "quoted", quote_amount: 900, quoted_at: today, quoted_by_name: "Ines Okafor", quote_note: "Quoted before markups." },
];

// The carriers directory, invented. Counts and last rates come from the loads above.
const CARRIERS: any[] = [
  { id: "c1", name: "Ridgeway Freight", mc_number: "481122", dot_number: "2290110", contact_name: "Dana Whitcombe", phone: "555-0142", email: "dispatch@ridgeway.example.test",
    address: "88 Depot Rd, Dayton, OH 45402", pay_method: "zelle", pay_details: "Zelle to billing@ridgeway.example.test", pay_terms_days: 30, notes: "Prefers a call before 10.", archived: 0 },
  { id: "c2", name: "Harbor Lines", mc_number: "775310", dot_number: "", contact_name: "Tomas Reyes", phone: "555-0177", email: "", address: "",
    pay_method: "ach", pay_details: "ACH, routing and account on the W-9", pay_terms_days: 15, notes: "", archived: 0 },
  { id: "c3", name: "Northline Freight", mc_number: "", dot_number: "3318842", contact_name: "", phone: "555-0109", email: "", address: "",
    pay_method: "wire", pay_details: "Wire, details on file", pay_terms_days: null, notes: "", archived: 0 },
];
const carrierRow = (c: any) => {
  const mine = LOADS.filter((b) => b.carrier_id === c.id || b.carrier === c.name);
  const last = [...mine].sort((a, b) => (b.delivered_at || b.pickup_date || "").localeCompare(a.delivered_at || a.pickup_date || ""))[0];
  const { pay_details, archived, ...rest } = c;
  return { ...rest, load_count: mine.length, last_used: last ? last.delivered_at || last.pickup_date || daysAgo(5) : "", last_rate: last?.paid_amount ?? last?.quoted_cost ?? null };
};
const history = (c: any) => LOADS.filter((b) => b.carrier_id === c.id || b.carrier === c.name).map((b) => ({
  booking_id: b.id, load_number: b.load_number, day: b.delivered_at || b.pickup_date || daysAgo(5), lane: "Northgate, OH to Lakeside, MI", rate: b.paid_amount ?? b.quoted_cost, paid: b.paid_amount != null,
}));
const rateMatches = [
  { booking_id: "fb_8", load_number: "LD-0008", day: daysAgo(11), carrier: "Northline Freight", carrier_id: "c3", rate: 1210, quote_amount: 1300, paid: true, equipment: "Dry van 53 ft", pallets: "6", weight_lbs: "5200", exact: true },
  { booking_id: "fb_7", load_number: "LD-0007", day: daysAgo(30), carrier: "Ridgeway Freight", carrier_id: "c1", rate: 1320, quote_amount: null, paid: false, equipment: "Flatbed", pallets: "8", weight_lbs: "6400", exact: true },
  { booking_id: "fb_x", load_number: "LD-0002", day: daysAgo(80), carrier: "Harbor Lines", carrier_id: "c2", rate: 1480, quote_amount: null, paid: true, equipment: "Reefer", pallets: "4", weight_lbs: "3100", exact: false },
];

// R-459 section 8: the BOLs we make, invented. Names and figures are not real.
const bolData = (over: any = {}) => ({
  ship_date: today, freight_terms: "prepaid",
  shipper: { name: "Northgate Wholesale", address: "410 Mercer Ave, Northgate, OH 44120", contact: "Dana Whitcombe", phone: "555-0142" },
  consignee: { name: "Lakeside Discount Co", address: "12 Shore Rd, Lakeside, MI 49001", contact: "", phone: "" },
  bill_to: { name: "Lakeside Discount Co", address: "" },
  carrier: { name: "Northline Freight", scac: "NLFT", pro: "PRO-5521", trailer: "T-204", seal: "" },
  refs: { load_number: "LD-0008", po: "PO-4410", pickup_number: "PU-7731", customer_ref: "" },
  items: [{ units: 6, unit_type: "Pallet", pieces: 72, description: "Shelving units", weight_lbs: 5400, class: "70", nmfc: "", hazmat: false }],
  special_instructions: "Call the dock before arrival.", cod_amount: "", declared_value: "", ...over,
});
const BOLS: any[] = [
  { id: "bol_1", number: "BOL-0003", booking_id: "fb_8", load_number: "LD-0008", data: bolData(), created_at: "2026-10-05T10:00:00Z", updated_at: "2026-10-05T10:00:00Z" },
  { id: "bol_2", number: "BOL-0004", booking_id: "", load_number: "", created_at: "2026-10-06T09:00:00Z", updated_at: "2026-10-06T09:00:00Z",
    data: bolData({ shipper: { name: "Mill Road Foods", address: "9 Mill Rd, Dayton, OH 45402", contact: "", phone: "" }, consignee: { name: "Harbor Grocers", address: "", contact: "", phone: "" }, refs: { load_number: "", po: "", pickup_number: "", customer_ref: "" }, carrier: { name: "", scac: "", pro: "", trailer: "", seal: "" } }) },
];
const bolRow = (b: any) => ({ id: b.id, number: b.number, booking_id: b.booking_id, load_number: b.load_number, ship_date: b.data.ship_date, shipper: b.data.shipper.name, consignee: b.data.consignee.name, carrier: b.data.carrier.name, created_at: b.created_at });
const PAY_SETTINGS: any = { enabled: true, surplus_mode: "pay", payee_id: "u2", payee_name: "Ines Okafor", share_pct: 100, cover_losses: true, loss_pay_pct: 0,
  frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1, method: "Zelle", details: "", markup_pct: 10, markup_editable: false };
const SETTINGS: any = { freight_by_team: true, load_prefix: "LD-", load_next_number: 10, bol_prefix: "BOL-", bol_next_number: 5 };
// A tiny PDF, base64, so the in-app preview has something to draw.
const TINY_PDF = "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+CiUlRU9G";
const qParam = (qs: string) => (/(?:^|&)q=([^&]*)/.exec(qs)?.[1] || "").replace(/\+/g, " ").toLowerCase();

const paperwork = (b: any) => {
  const kinds = new Set((b.files ?? []).map((f: any) => f.kind));
  return { bol: kinds.has("bol"), pod: kinds.has("pod"), carrier_invoice: kinds.has("carrier_invoice") };
};
const payRow = (b: any) => {
  const c = CARRIERS.find((x) => x.id === b.carrier_id);
  const due = b.pay_due_date || "";
  return { booking_id: b.id, load_number: b.load_number, deal_flow_id: "d1", deal_label: "INV-6001 for Lakeside Discount Co", route: "Northgate to Lakeside", carrier: b.carrier, carrier_id: b.carrier_id || "",
    pay_method: c?.pay_method || "", pay_details: c?.pay_details || "", rate: b.quoted_cost, quote_amount: b.quote_amount, pay_due_date: due, days_until: null, overdue: !!due && due < today,
    status: b.status, delivered_at: b.delivered_at, paperwork: paperwork(b), carrier_invoice_file_id: (b.files ?? []).find((f: any) => f.kind === "carrier_invoice")?.id ?? "",
    paid_amount: b.paid_amount, paid_at: b.paid_at, paid_method: b.paid_method, paid_note: b.paid_note, bank_linked: b.paid_amount == null ? "" : b.bank_linked || "none" };
};
const shape = (b: any) => {
  const lg = state.who === "logistics";
  return { ...clone(b), code: b.load_number, can_see_names: true, can_see_addresses: true, can_see_deal: !lg, can_see_money: true, freight_by_team: true,
    shipping_billed: lg ? null : 1900, trucks_on_deal: 1, paperwork: paperwork(b), carrier_pay_method: CARRIERS.find((c) => c.id === b.carrier_id)?.pay_method ?? "", deal_paid: lg ? false : state.paid, deal: lg ? null : deal,
    invoice_sent: lg ? false : state.sent, deal_invoice_number: lg ? "" : deal.invoice_number, markup_default_pct: 10, markup_editable: state.editable };
};

const round2 = (n: number) => Math.round((n + 1e-9) * 100) / 100;
const GATE = ["Logistics has not quoted this load yet.", "Put the quote on the invoice, or mark that you are paying this shipping yourselves.", "Send the invoice first.", "The customer has not paid yet."];
const settle = (cur: any, body: any) => {
  const lg = state.who === "logistics";
  // R-464 section 2.3: the booking gate, in order. The last two are skipped by an override.
  if (isQuote(cur.status) && body.status && !["quote", "quoted"].includes(body.status) && body.status !== "cancelled") {
    const quoted = body.quote_amount != null || cur.quote_amount != null;
    const charged = !!(cur.shipping_charge || cur.quote_invoiced_at);
    if (!quoted) throw GATE[0];
    if (!charged) throw GATE[1];
    if (!body.override) { if (!state.sent) throw GATE[2]; if (!state.paid) throw GATE[3]; }
  }
  const out = { ...cur, ...body };
  delete out.today; delete out.pickup_number_confirmed; delete out.override;
  if (body.override && isQuote(cur.status) && body.status === "requested") { out.book_override_at = today + "T09:00:00Z"; out.book_override_by = "Owner"; }
  // R-465 section 8.3: the cost and the percent make the markup and the quote.
  if (body.quote_cost != null) {
    const pct = body.markup_pct != null && (!lg || state.editable) ? body.markup_pct : 10;
    out.quote_cost = body.quote_cost; out.markup_pct = pct; out.markup_amount = round2(body.quote_cost * pct / 100);
    out.quote_amount = round2(body.quote_cost + out.markup_amount); out.markup_by_name = "Ines Okafor"; out.markup_at = today;
    if (cur.quoted_cost == null && body.quoted_cost === undefined) out.quoted_cost = body.quote_cost;
    if (cur.status === "quote" && body.status === undefined) { out.status = "quoted"; out.quoted_at = today; out.quoted_by_name = "Ines Okafor"; }
  }
  if (body.paid_amount === null) { out.paid_at = ""; out.paid_method = ""; out.paid_note = ""; out.bank_linked = ""; }
  if (body.pickup_number_confirmed === true) { out.pickup_number_confirmed_at = today; out.pickup_number_confirmed_by = "Ines Okafor"; }
  if (body.pickup_number_confirmed === false) { out.pickup_number_confirmed_at = ""; out.pickup_number_confirmed_by = ""; }
  if (cur.status === "quote" && body.quote_amount != null && body.status === undefined) { out.status = "quoted"; out.quoted_at = today; out.quoted_by_name = "Ines Okafor"; }
  if (body.status === "requested" && isQuote(cur.status)) out.sent_to_book_at = today;
  out.updated_by_name = "Ines Okafor";
  return out;
};
const isQuote = (s: string) => s === "quote" || s === "quoted";

const flow = {
  id: "d1", invoice_id: "inv1", invoice_number: "INV-6001", stage: "invoiced", updated_at: "", supplier_payments: [], logistics_bookings: 2,
  logistics_paid: 1210, logistics_unpaid: 2, logistics_quoted: 1500, logistics_stage: "booked", shipping_linked: 0, shipping_mode: true, shipping_billed: 1900,
} as any;

const handlers: Record<string, (a: any) => any> = {
  employee_me: () => meFor(state.who),
  get_deal_flow: () => ({ ...flow }),
  get_invoice: () => ({ id: "inv1", number: "INV-6001", status: state.sent ? "sent" : "draft", sent_at: state.sent ? today : null, line_items_json: JSON.stringify([{ description: "Shipping", qty: 1, rate: 0, amount: 0 }]), shipping_charged: 0 }),
  get_deal_logistics_pay: () => ({ charged: 1900, charged_source: "lines", freight: 1210, freight_source: "paid", surplus: 690, pay: 100, rule: "markup", pending: false,
    earned_on: today, due_date: today, booking_codes: ["LD-0008"], payee_name: "Ines Okafor", markup: 100 }),
  global_search: () => ({ clients: [], invoices: [], deals: [], suppliers: [] }),
  logistics_save_download: ({ path }: any) => { (window as any).__download = path; return "C:/Users/Example/Downloads/" + path.split("/")[4] + ".pdf"; },
  list_freight_bookings: () => LOADS.filter((b) => b.status !== "cancelled" || true).map((b) => ({ ...shape(b), can_see_deal: true, deal_paid: undefined, paperwork: undefined, bols: undefined })),
  logistics_request: ({ method, path, body }: any) => {
    const [p, qs = ""] = path.split("?");
    if (method === "GET" && p === "/api/logistics/bookings") {
      return { bookings: (qs.includes("include_done=1") ? LOADS : LOADS.filter((b) => b.status !== "cancelled")).map(shape) };
    }
    if (method === "GET" && p === "/api/logistics/settings") return { ...SETTINGS };
    if (method === "PUT" && p === "/api/logistics/settings") { (window as any).__settings = body; Object.assign(SETTINGS, body); return { ...SETTINGS }; }
    // R-459: BOLs and search.
    if (method === "GET" && p === "/api/logistics/bols") {
      const n = qParam(qs);
      return { bols: BOLS.map(bolRow).filter((r) => !n || Object.values(r).join(" ").toLowerCase().includes(n)) };
    }
    if (method === "GET" && p === "/api/logistics/bols/prefill") {
      (window as any).__prefill = qs;
      const b = LOADS.find((x) => qs.includes("booking_id=" + x.id)) ?? LOADS[0];
      return { booking_id: b.id, load_number: b.load_number, data: bolData({ carrier: { name: b.carrier || "", scac: "", pro: b.pro || "", trailer: b.trailer_number || "", seal: "" },
        refs: { load_number: b.load_number, po: "", pickup_number: b.pickup_number || "", customer_ref: "" } }) };
    }
    if (p === "/api/logistics/bols" && method === "POST") {
      (window as any).__bolCreate = body;
      const b = { id: "bol_" + (BOLS.length + 1), number: "BOL-" + String(SETTINGS.bol_next_number++).padStart(4, "0"), booking_id: body.booking_id || "", load_number: LOADS.find((x) => x.id === body.booking_id)?.load_number || "",
        data: body.data, created_at: today + "T10:00:00Z", updated_at: today + "T10:00:00Z" };
      BOLS.push(b);
      return b;
    }
    const bm = /^\/api\/logistics\/bols\/([^/]+?)(\/pdf)?$/.exec(p);
    if (bm) {
      const b = BOLS.find((x) => x.id === bm[1]);
      if (bm[2] && method === "GET") return { name: b.number + ".pdf", mime: "application/pdf", data: TINY_PDF };
      if (method === "GET") return state.who === "logistics" ? { ...b, can_see_names: false, can_see_addresses: false, data: { ...b.data, shipper: { ...b.data.shipper, name: "", address: "" } } } : b;
      if (method === "PATCH") { (window as any).__bolPatch = body; Object.assign(b, { booking_id: body.booking_id, data: body.data, load_number: LOADS.find((x) => x.id === body.booking_id)?.load_number || "" }); return b; }
      if (method === "DELETE") { BOLS.splice(BOLS.indexOf(b), 1); return {}; }
    }
    if (method === "GET" && p === "/api/logistics/search") {
      (window as any).__search = qs;
      const n = qParam(qs);
      const lg = state.who === "logistics";
      return {
        loads: LOADS.filter((b) => (b.load_number + " " + b.carrier + " " + b.pickup_number).toLowerCase().includes(n)).slice(0, 8)
          .map((b) => ({ id: b.id, load_number: b.load_number, route: "Northgate, OH to Lakeside, MI", status: b.status, carrier: b.carrier, deal_label: lg ? undefined : "INV-6001 for Lakeside Discount Co" })),
        bols: BOLS.filter((b) => (b.number + " " + b.load_number + " " + b.data.shipper.name).toLowerCase().includes(n))
          .map((b) => ({ id: b.id, number: b.number, shipper: b.data.shipper.name, consignee: b.data.consignee.name, load_number: b.load_number })),
        carriers: CARRIERS.filter((c) => (c.name + " " + c.mc_number).toLowerCase().includes(n)).map((c) => ({ id: c.id, name: c.name, mc_number: c.mc_number })),
      };
    }
    // R-459: carriers, rates, carrier pay.
    if (p === "/api/logistics/carriers" && method === "GET") return { carriers: CARRIERS.filter((c) => !c.archived).map(carrierRow) };
    if (p === "/api/logistics/carriers" && method === "POST") {
      (window as any).__carrier = body;
      const c = { id: "c" + (CARRIERS.length + 1), mc_number: "", dot_number: "", contact_name: "", phone: "", email: "", address: "", pay_method: "", pay_details: "", pay_terms_days: null, notes: "", archived: 0, ...body };
      CARRIERS.push(c);
      return { ...carrierRow(c), pay_details: c.pay_details, history: [] };
    }
    const cm = /^\/api\/logistics\/carriers\/([^/]+)$/.exec(p);
    if (cm) {
      const c = CARRIERS.find((x) => x.id === cm[1]);
      if (method === "GET") return { ...carrierRow(c), pay_details: c.pay_details, history: history(c) };
      if (method === "PATCH") { (window as any).__carrier = body; Object.assign(c, body); return { ...carrierRow(c), pay_details: c.pay_details, history: history(c) }; }
      if (method === "DELETE") { c.archived = 1; return {}; }
    }
    if (p === "/api/logistics/rates" && method === "GET") {
      (window as any).__ratesQuery = qs;
      return { lane: { from: "Northgate, OH", to: "Lakeside, MI" }, last: qs.includes("booking_id=fb_9") ? null : rateMatches[0], matches: qs.includes("booking_id=fb_9") ? [] : rateMatches };
    }
    if (p === "/api/logistics/carrier-pay" && method === "GET") {
      if (state.who === "logistics") return Promise.reject("Only people who pay carriers can see this.");
      const live = LOADS.filter((b) => ["booked", "picked_up", "delivered"].includes(b.status));
      return { to_pay: live.filter((b) => b.paid_amount == null).map(payRow), paid: live.filter((b) => b.paid_amount != null).map(payRow) };
    }
    const cc = /^\/api\/logistics\/carrier-pay\/([^/]+)\/(candidates|link)$/.exec(p);
    if (cc && method === "GET") return { candidates: [
      { txn_id: "t1", posted_at: daysAgo(4) + "T00:00:00Z", amount: 1210, counterparty_name: "NORTHLINE FREIGHT", description: "WIRE OUT", reason: "carrier name and exact amount match" },
      { txn_id: "t2", posted_at: daysAgo(5) + "T00:00:00Z", amount: 1209.8, counterparty_name: "ZELLE PAYMENT", description: "Zelle to N Freight", reason: "amount matches what was paid for this booking" },
    ] };
    if (cc && method === "POST") { (window as any).__link = { id: cc[1], ...body }; LOADS.find((x) => x.id === cc[1]).bank_linked = "linked"; return {}; }
    if (method === "GET" && p.startsWith("/api/logistics/prefill/")) {
      return { pickup_name: "Northgate Wholesale", pickup_address: "410 Mercer Ave, Northgate, OH 44120", delivery_name: "Lakeside Discount Co",
        delivery_address: "12 Shore Rd, Lakeside, MI 49001", pickup_options: [] };
    }
    if (method === "POST" && p === "/api/logistics/bookings") { (window as any).__created = body; return shape({ ...blank, ...body, id: "fb_new", load_number: "LD-0010" }); }
    const inv = /^\/api\/logistics\/bookings\/([^/]+)\/invoice-line$/.exec(p);
    if (method === "POST" && inv) {
      const b = LOADS.find((x) => x.id === inv[1]);
      Object.assign(b, { quote_invoiced_at: today, quote_invoiced_amount: body.amount });
      return { invoice_id: "inv1", invoice_number: "INV-6001", line: 0, subtotal: body.amount, tax: 0, total: body.amount };
    }
    const fk = /^\/api\/logistics\/bookings\/([^/]+)\/files\/([^/]+)$/.exec(p);
    if (method === "PATCH" && fk) {
      const b = LOADS.find((x) => x.id === fk[1]);
      b.files = b.files.map((f: any) => (f.id === fk[2] ? { ...f, kind: body.kind } : f));
      return shape(b);
    }
    const fa = /^\/api\/logistics\/bookings\/([^/]+)\/files$/.exec(p);
    if (method === "POST" && fa) {
      const b = LOADS.find((x) => x.id === fa[1]);
      b.files = [...b.files, file("f_" + b.files.length + 9, body.name, body.kind ?? "other")];
      return shape(b);
    }
    const m = /^\/api\/logistics\/bookings\/([^/]+)$/.exec(p);
    if (m && method === "GET") return shape(LOADS.find((x) => x.id === m[1]));
    if (m && method === "PATCH") {
      const i = LOADS.findIndex((x) => x.id === m[1]);
      (window as any).__patch = body;
      LOADS[i] = settle(LOADS[i], body);
      return shape(LOADS[i]);
    }
    if (p === "/api/logistics/pay/settings" && method === "GET") return { ...PAY_SETTINGS };
    if (p === "/api/logistics/pay/settings" && method === "PUT") { (window as any).__paySettings = body; Object.assign(PAY_SETTINGS, body); return { ...PAY_SETTINGS }; }
    if (p.startsWith("/api/logistics/pay/")) return Promise.reject("Not part of this harness.");
    return Promise.reject("That request is not allowed here.");
  },
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) { try { return Promise.resolve(handlers[cmd](args || {})); } catch (e) { return Promise.reject(e); } }
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    return Promise.resolve(cmd.startsWith("list_") ? [] : null);
  },
  transformCallback: () => 1,
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

const meFor = (who: Who): any => who === "logistics"
  ? { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "role_logistics", role_name: "Logistics", is_admin: false,
      permissions: ["logistics:view", "logistics:edit", "logistics:view_names", "logistics:view_addresses"] }
  : { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "role_admin", role_name: "Admin", is_admin: true, permissions: ["*"] };

// Opens a load and a step the way a person would (by clicking), so a URL reproduces a screen.
function useAutoOpen() {
  useEffect(() => {
    const open = q.get("open"), step = q.get("step"), tab = q.get("tab");
    if (tab) {
      let n = 0;
      const t = window.setInterval(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent?.trim() === tab && x.getAttribute("aria-pressed") !== null);
        if (b) { (b as HTMLElement).click(); window.clearInterval(t); } else if (++n > 60) window.clearInterval(t);
      }, 150);
    }
    if (!open) return;
    let tries = 0, stage = 0;
    const t = window.setInterval(() => {
      tries++;
      const btns = Array.from(document.querySelectorAll("button"));
      if (stage === 0) {
        const row = btns.find((b) => b.textContent?.includes(open) && b.className.includes("w-full"));
        if (row) { (row as HTMLElement).click(); stage = step ? 1 : 2; }
      } else if (stage === 1) {
        const s = btns.find((b) => b.getAttribute("role") === "tab" && b.textContent?.trim() === step);
        if (s) { (s as HTMLElement).click(); stage = 2; }
      }
      if (stage === 2 || tries > 60) window.clearInterval(t);
    }, 150);
    return () => window.clearInterval(t);
  }, []);
}

function Harness() {
  type V = "logistics" | "shipping" | "bills" | "bols" | "numbering" | "palette" | "settings";
  const [view, setView] = useState<V>((q.get("view") as V) || "logistics");
  const [who, setWho] = useState<Who>(state.who);
  state.who = who;
  useAutoOpen();
  const tab = "block w-full text-left text-[13px] px-2.5 h-8 rounded-lg";
  return (
    <div className="flex h-screen bg-bg">
      <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 space-y-1">
        {([["logistics", "Logistics"], ["bols", "BOLs"], ["shipping", "Deal shipping"], ["bills", "Bills"], ["numbering", "Numbering settings"], ["palette", "Command palette"], ["settings", "Logistics pay settings"]] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} className={`${tab} ${view === v ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>{label}</button>
        ))}
        <div className="pt-3 mt-3 border-t border-line space-y-1">
          <div className="text-[11px] text-muted px-2.5">Signed in as</div>
          <button onClick={() => setWho("team")} className={`${tab} ${who === "team" ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>Owner</button>
          <button onClick={() => setWho("logistics")} className={`${tab} ${who === "logistics" ? "bg-surface-2 text-ink font-medium" : "text-ink-2"}`}>Logistics account</button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden relative min-w-0">
        <div className="h-full overflow-y-auto p-7"><div className="max-w-[1280px] mx-auto">
          {view === "logistics" && <LogisticsView key={who} me={meFor(who)} />}
          {view === "bols" && <BolsView key={who} me={meFor(who)} />}
          {view === "numbering" && <div className="max-w-xl bg-surface border border-line rounded-xl p-5"><LogisticsNumberingSetting /></div>}
          {view === "palette" && <CommandPalette key={who} logisticsOnly={who === "logistics"} onClose={() => {}} />}
          {view === "bills" && (
            <div className="min-w-0">
              <h2 className="text-[18px] font-semibold text-ink tracking-tight mb-5">Bills</h2>
              <CarriersToPaySection canPay={canPayCarriers(meFor(who))} />
            </div>
          )}
          {view === "shipping" && <DealShipping flow={flow} onReload={() => {}} locked={false} dealPaid={state.paid} />}
          {view === "settings" && <div className="max-w-xl bg-surface border border-line rounded-xl p-5"><LogisticsPaySettingsPanel /></div>}
        </div></div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
