// DEV ONLY: the fixture behind r400a-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL LogisticsView (as the Logistics account and as the owner) and the REAL
// DealShipping step inside the app's shell geometry (216px sidebar, p-7), with the Tauri
// bridge stubbed. Every place, carrier, number and person below is invented.
//
// R-401 adds the logistics pay: his "Your pay" card on the Logistics screen (as=dad), the deal's
// Shipping step with its pay lines and typed freight (view=deal, &pay=share|loss|waiting|off),
// the settings form (view=settings) and the tracker (view=tracker).
//
// R-415 adds: the Freight section and required fields on the Send sheet (view=deal&send=1, &byteam=0 turns
// the setting off), the read-only Freight and the charged line on a booking (&open=L-A91C3D, as=dad),
// the Logistics settings card and the Off / Pay / Track choice (view=settings, &mode=track|off), the tracker
// in track mode (view=tracker&mode=track) and All shipments (view=logistics&ship=1, owner only).
// Query: ?as=dad|jack  &names=0|1  &addr=0|1  &dark=1  &view=logistics|deal|settings|tracker|freight
//        &byteam=0|1  &mode=pay|track|off  &ship=1  &send=1  &open=<booking code>
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import LogisticsView from "./components/LogisticsView";
import DealShipping from "./components/DealShipping";
import { LogisticsFreightSetting, LogisticsPaySettingsForm, LogisticsPayTrackerPanel } from "./components/LogisticsPay";
import { ToastHost } from "./components/Toast";
import { localDay } from "./lib/format";
import { payRoute, r415, r415Route, settings as paySettings } from "./__r400-fixture/pay";
import "./index.css";

const q = new URLSearchParams(location.search);
const AS = q.get("as") === "dad" ? "dad" : "jack";
const NAMES = q.get("names") !== "0";
const ADDR = q.get("addr") !== "0";
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
r415.byTeam = q.get("byteam") !== "0";
if (q.get("mode") === "track") paySettings.surplus_mode = "track";
if (q.get("mode") === "off") paySettings.enabled = false;

const ahead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };
const back = (n: number) => ahead(-n);

// A confirm sheet would block the page in a headless run, so the harness answers yes.
window.confirm = () => true;

const base = {
  status: "requested", booked_at: "", request_note: "",
  pickup_name: "", pickup_address: "", pickup_date: "", pickup_window: "", pickup_contact: "", pickup_phone: "", pickup_notes: "",
  delivery_name: "", delivery_address: "", delivery_date: "", delivery_window: "", delivery_contact: "", delivery_phone: "", delivery_notes: "",
  delivered_at: "", carrier: "", broker: "", service: "", equipment: "", bol: "", pro: "", pickup_number: "", reference: "", tracking_url: "",
  driver_name: "", driver_phone: "", truck_number: "", trailer_number: "",
  pallets: "", pieces: "", weight_lbs: "", freight_class: "", dimensions: "", commodity: "", accessorials: "",
  quoted_cost: null as number | null, paid_amount: null as number | null, paid_at: "", paid_method: "", paid_note: "", notes: "",
  created_by_name: "Sam Rivera", updated_by_name: "", created_at: `${back(5)}T10:00:00Z`, updated_at: `${back(1)}T10:00:00Z`,
  tracking: null as any,
};

const P1 = { name: "Northgate Wholesale", address: "418 Alder Way, Fairmont, OH 43201" };
const D1 = { name: "Lakeside Discount Co", address: "77 Quay Road, Marlow, PA 15201" };
const D2 = { name: "Tidewater Surplus", address: "9 Kiln Street, Ashby, VA 23301" };

const BOOKINGS: any[] = [
  { ...base, id: "fb_7f3k2a0000", status: "requested", request_note: "Dock closes at 3. Call the office before you come.",
    pickup_name: P1.name, pickup_address: P1.address, delivery_name: D1.name, delivery_address: D1.address, pallets: "12",
    weight_lbs: "9400", pieces: "96", freight_class: "70", dimensions: "48 x 40 x 60 in", commodity: "Mixed apparel", accessorials: "Liftgate at delivery, Appointment, Dock has a low door",
    deal: { id: "df1", invoice_number: "INV-5001", client_name: "Lakeside Discount Co", stage: "payment_received" } },
  { ...base, id: "fb_a91c3d0000", status: "booked", carrier: "Ridgeway Freight", broker: "Summit Load Desk", bol: "RW48211", pickup_date: ahead(1), delivery_date: ahead(4),
    pickup_name: P1.name, pickup_address: P1.address, delivery_name: D2.name, delivery_address: D2.address, quoted_cost: 700, pallets: "8",
    updated_by_name: "Ines Okafor", deal: { id: "df1", invoice_number: "INV-5001", client_name: "Lakeside Discount Co", stage: "payment_received" } },
  { ...base, id: "fb_c20e8b0000", status: "picked_up", carrier: "Ridgeway Freight", pro: "9920144", pickup_date: back(1), delivery_date: ahead(2),
    pickup_name: "Harbor Row Liquidators", pickup_address: "20 Pier Lane, Colby, MD 21201", delivery_name: D1.name, delivery_address: D1.address, quoted_cost: 950,
    deal: { id: "df2", invoice_number: "INV-5007", client_name: "Cedar Row Resale", stage: "supplier_paid" },
    tracking: { stage: "in_transit", status: "In transit", carrier: "Ridgeway Freight", last_location: "Dayton, OH", last_update_at: `${back(0)}T09:00:00Z` } },
  { ...base, id: "fb_d31f9c0000", status: "delivered", carrier: "Bluefield Lines", bol: "BF77120", pickup_date: back(6), delivered_at: back(2), delivery_date: back(2),
    pickup_name: P1.name, pickup_address: P1.address, delivery_name: D2.name, delivery_address: D2.address, quoted_cost: 800, paid_amount: 800, paid_at: back(1), paid_method: "ACH",
    deal: { id: "df1", invoice_number: "INV-5001", client_name: "Lakeside Discount Co", stage: "payment_received" } },
];
const DONE: any[] = [
  { ...base, id: "fb_e42a1d0000", status: "cancelled", pickup_name: P1.name, pickup_address: P1.address, delivery_name: D1.name, delivery_address: D1.address,
    updated_at: `${back(9)}T10:00:00Z`, deal: { id: "df3", invoice_number: "INV-4990", client_name: "Marlow Traders", stage: "invoiced" } },
];

// What each deal was charged for shipping, and how many live trucks it has (the server works both out).
const CHARGED: Record<string, number> = { df1: 1_200, df2: 950, df3: 0 };
const r415Fields = (b: any) => ({
  shipping_billed: CHARGED[b.deal?.id] ?? 0,
  trucks_on_deal: BOOKINGS.filter((x) => x.deal?.id === b.deal?.id && x.status !== "cancelled").length,
  freight_by_team: r415.byTeam,
});
const shape = (b: any) => {
  const o = { ...b, ...r415Fields(b), code: "L-" + b.id.slice(3, 9).toUpperCase(), can_see_names: AS === "jack" || NAMES, can_see_addresses: AS === "jack" || ADDR, can_see_deal: AS === "jack" };
  if (!o.can_see_names) { o.pickup_name = ""; o.delivery_name = ""; }
  if (!o.can_see_addresses) { o.pickup_address = ""; o.delivery_address = ""; }
  if (AS === "dad") o.deal = null;
  return o;
};

const live = () => BOOKINGS.filter((b) => b.status !== "cancelled");
const clone = (x: any) => JSON.parse(JSON.stringify(x));

const FLOW: any = {
  id: "df1", invoice_id: "i1", invoice_number: "INV-5001", client_name: "Lakeside Discount Co", stage: "payment_received",
  payment_received_amount: 24_000, deposit_amount: 0, payment_received_method: null, payment_received_at: null,
  supplier_payments_json: "[]", supplier_owed: 0, own_costs_unpaid: 500, own_costs_total: 500, total_supplier_cost: 6_500,
  completed_at: null, gross_revenue: 0, total_cost: 0, net_profit: 0, profit_jack: 0, profit_ben: 0, profit_business: 0, notes: null, name: null,
  created_at: `${back(30)}T00:00:00Z`, updated_at: `${back(0)}T00:00:00Z`, invoice_total: 24_000, client_id: "c1",
  ships_direct: false, pickup_date: null, expected_delivery_date: null, pickup_date_prev: null, expected_delivery_date_prev: null,
  supplier_payments: [
    { id: "sp1", supplier_name: "Northgate Wholesale", amount: 6_000, paid: true, category: "supplier" },
    { id: "sp2", supplier_name: "Freight to Marlow", amount: 500, paid: false, category: "freight", kept: false },
  ],
  shipping_cost: null, logistics_bookings: 3, logistics_unpaid: 2, logistics_paid: 800, logistics_quoted: 700, logistics_stage: "requested",
  shipping_linked: 810, freight_typed: 500, shipping_mode: true, shipping_estimate: 1_500, projected_cost: 7_500,
  shipping_billed: 1_200, shipping_billed_source: "lines",
};

// The deal's pay line, as `get_deal_logistics_pay` gives it, for the four cases the step words.
const PAY = q.get("pay") ?? "share";
const payLine = (): any => {
  const b = { charged: 1_200, charged_source: "lines", freight: 810, freight_source: "bank", earned_on: back(4), due_date: ahead(3), booking_codes: ["L-7F3K2A", "L-A91C3D"], payee_name: "Ines Okafor", pending: false };
  if (PAY === "off") return null;
  if (PAY === "waiting") return { ...b, freight: 0, surplus: 1_200, pay: null, rule: "pending", pending: true };
  if (PAY === "loss") return { ...b, charged: 600, surplus: -210, pay: 81, rule: "loss_cover" };
  return { ...b, surplus: 390, pay: 390, rule: "share" };
};
const INVOICE = {
  id: "i1", number: "INV-5001", total: 25_200, subtotal: 25_200, shipping_charged: null,
  line_items_json: JSON.stringify([
    { description: "Mixed apparel pallets", qty: 8, rate: 3_000, amount: 24_000 },
    { description: "Shipping", qty: 1, rate: 1_200, amount: 1_200 },
  ]),
};

const handlers: Record<string, (a: any) => any> = {
  get_invoice: () => clone(INVOICE),
  get_deal_logistics_pay: () => payLine(),
  update_supplier_payment: () => null,
  remove_supplier_payment: () => null,
  list_staff: () => [
    { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "role_admin", role_name: "Admin", status: "active", commission_pct: 0, hide_pay_cuts: false },
    { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "role_logistics", role_name: "Logistics", status: "active", commission_pct: 0, hide_pay_cuts: false },
    { id: "u3", email: "sam@example.test", display_name: "Sam Rivera", role_id: "role_sales", role_name: "Sales", status: "active", commission_pct: 10, hide_pay_cuts: false },
  ],
  list_roles: () => ({ modules: [], roles: [
    { id: "role_admin", name: "Admin", permissions: ["*"], is_system: true },
    { id: "role_logistics", name: "Logistics", permissions: ["logistics:view", "logistics:edit"], is_system: true },
    { id: "role_sales", name: "Sales", permissions: ["deal_flow:view"], is_system: false },
  ] }),
  logistics_request: ({ method, path, body }: any) => {
    const paid = payRoute(method, path, body, AS === "dad" ? "payee" : "owner", NAMES);
    if (paid !== undefined) return paid;
    const r415r = r415Route(method, path, body, AS === "dad" ? "payee" : "owner");
    if (r415r !== undefined) return r415r;
    const [p, qs = ""] = path.split("?");
    const bookings = () => (qs.includes("include_done=1") ? [...BOOKINGS, ...DONE] : live());
    if (method === "GET" && p === "/api/logistics/bookings") return { bookings: bookings().map(shape) };
    const m = /^\/api\/logistics\/bookings\/(.+)$/.exec(p);
    if (method === "PATCH" && m) {
      const b = [...BOOKINGS, ...DONE].find((x) => x.id === m[1]);
      if (!b) return Promise.reject("That booking was not found.");
      // While our side fills in the freight, the Logistics account's change to it is ignored, like the server does.
      const FREIGHT = ["pallets", "pieces", "weight_lbs", "freight_class", "dimensions", "commodity", "accessorials"];
      for (const [k, v] of Object.entries(body || {})) if (k !== "today" && !(AS === "dad" && r415.byTeam && FREIGHT.includes(k))) b[k] = v;
      b.updated_by_name = "Ines Okafor"; b.updated_at = `${localDay()}T12:00:00Z`;
      return shape(b);
    }
    if (method === "POST" && p === "/api/logistics/bookings") {
      if (!body?.copy_from && r415.byTeam && !["pallets", "weight_lbs", "dimensions"].every((k) => String(body?.[k] ?? "").trim())) {
        return Promise.reject("Fill in the pallets, weight and dimensions before sending to logistics.");
      }
      const from = body?.copy_from ? BOOKINGS.find((x) => x.id === body.copy_from) : null;
      const nb = { ...base, id: "fb_" + Math.random().toString(16).slice(2, 8).padEnd(32, "0"), status: "requested", deal: from?.deal ?? BOOKINGS[0].deal,
        pickup_name: from?.pickup_name ?? body?.pickup_name ?? "", pickup_address: from?.pickup_address ?? body?.pickup_address ?? "",
        delivery_name: from?.delivery_name ?? body?.delivery_name ?? "", delivery_address: from?.delivery_address ?? body?.delivery_address ?? "",
        request_note: from?.request_note ?? body?.request_note ?? "", pallets: body?.pallets ?? "", pieces: body?.pieces ?? "", weight_lbs: body?.weight_lbs ?? "",
        freight_class: body?.freight_class ?? "", dimensions: body?.dimensions ?? "", commodity: body?.commodity ?? "", accessorials: body?.accessorials ?? "" };
      BOOKINGS.push(nb);
      return shape(nb);
    }
    if (method === "GET" && p.startsWith("/api/logistics/prefill/")) {
      return { pickup_name: P1.name, pickup_address: P1.address, delivery_name: D1.name, delivery_address: D1.address,
        pickup_options: [P1, { name: "Harbor Row Liquidators", address: "20 Pier Lane, Colby, MD 21201" }] };
    }
    return Promise.reject("That request is not allowed here.");
  },
  list_freight_bookings: () => [...BOOKINGS, ...DONE].map((b) => clone({
    ...b, ...r415Fields(b), code: "L-" + b.id.slice(3, 9).toUpperCase(), can_see_names: true, can_see_addresses: true, can_see_deal: true,
  })),
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

const me: any = AS === "dad"
  ? { id: "u2", email: "ines@example.test", display_name: "Ines Okafor", role_id: "role_logistics", role_name: "Logistics", is_admin: false,
      permissions: ["logistics:view", "logistics:edit", ...(NAMES ? ["logistics:view_names"] : []), ...(ADDR ? ["logistics:view_addresses"] : [])] }
  : { id: "u1", email: "owner@example.test", display_name: "Owner", role_id: "role_admin", role_name: "Admin", is_admin: true, permissions: ["*"] };

// Clicks through the screens the way a person would, so a URL reproduces a sheet or a list.
function useAutoClick() {
  useEffect(() => {
    const steps: string[] = [];
    if (q.get("ship") === "1") steps.push("All shipments");
    if (q.get("send") === "1") steps.push("Send to logistics");
    const code = q.get("open");
    if (code) steps.push(code);
    let i = 0, tries = 0;
    const t = window.setInterval(() => {
      tries++;
      if (i >= steps.length || tries > 80) { window.clearInterval(t); return; }
      const hit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(steps[i]) && !b.getAttribute("aria-label")?.startsWith("Close"));
      if (hit) { (hit as HTMLElement).click(); i++; }
    }, 200);
    return () => window.clearInterval(t);
  }, []);
}

function Harness() {
  const v = q.get("view");
  const view = v === "deal" || v === "settings" || v === "tracker" || v === "freight" ? v : "logistics";
  useAutoClick();
  return (
    <div className="flex h-screen" style={{ background: "var(--t-bg)" }}>
      <aside className="w-[216px] flex-shrink-0" style={{ background: "linear-gradient(180deg, #161618 0%, #0C0C0D 100%)" }} />
      <main className="flex-1 overflow-auto">
        <div className="p-7">
          <div className="max-w-[1280px] mx-auto">
            {view === "logistics" && <LogisticsView me={me} />}
            {view === "deal" && <div className="border border-line rounded-xl bg-surface-2 px-5 py-4 max-w-[900px]"><DealShipping flow={FLOW} onReload={() => {}} locked={false} onAdvance={() => {}} /></div>}
            {view === "settings" && <div className="bg-surface border border-line rounded-2xl p-6 max-w-2xl"><LogisticsPaySettingsForm /></div>}
            {view === "freight" && <div className="bg-surface border border-line rounded-2xl p-6 max-w-2xl"><LogisticsFreightSetting /></div>}
            {view === "tracker" && <div className="bg-surface border border-line rounded-2xl p-6 max-w-3xl"><LogisticsPayTrackerPanel /></div>}
          </div>
        </div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
