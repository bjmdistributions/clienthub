// DEV ONLY: the fixture behind harness/r643-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL ColdCallsView (or, with ?v=suppliers, the REAL
// SuppliersView) with invented warehouses and suppliers inside the shell's geometry. Every name and figure is made up.
import ReactDOM from "react-dom/client";
import ColdCallsView from "./components/ColdCallsView";
import SuppliersView from "./components/SuppliersView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const today = new Date().toISOString().slice(0, 10);
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const lead = (o: Record<string, unknown>): any => ({
  contact_name: "", email: "", phone: "", city: "Riverton", state: "NJ", kind: "ecom", website: "", status: "emailed", next_touch: "",
  last_touch_at: "", personal_line: "", notes: "", source: "NJ 3PL", list: "NJ 3PL", supplier_id: "", supplier_name: "", emailed: true, replied: false, ...o,
});
const LEADS: any[] = [
  lead({ id: "l1", company: "Harbor Prep Co", email: "hello@harborprep.example", replied: true, status: "talking" }),
  lead({ id: "l2", company: "Northline Fulfillment", email: "sales@northline.example" }),
  lead({ id: "l3", company: "Dock Nine Logistics", email: "ops@docknine.example", replied: true, status: "talking" }),
  lead({ id: "l4", company: "Bluebird Supply", email: "b@bluebird.example", replied: true, status: "converted", supplier_id: "s2", supplier_name: "Bluebird Supply Co" }),
  lead({ id: "l5", company: "Old Mill Warehousing", email: "info@oldmill.example" }),
  lead({ id: "l6", company: "Garment Row 3PL", email: "info@garmentrow.example", source: "PA list", list: "PA list", replied: true, status: "supplier", supplier_id: "s3", supplier_name: "Garment Row" }),
  lead({ id: "l7", company: "Seaside Storage", source: "PA list", list: "PA list", emailed: false, status: "new" }),
];
const SUPPLIERS: any[] = [
  { id: "s1", name: "Dock 9 Logistics LLC", contact_name: "Rita Vega", email: "rita@docknine.example", phone: "555-010-0101" },
  { id: "s2", name: "Bluebird Supply Co", contact_name: "Lee Park", email: "lee@bluebird.example" },
  { id: "s3", name: "Garment Row", contact_name: "", email: "pat@garmentrow.example" },
  { id: "s4", name: "Acme Overstock", contact_name: "Ana Cruz", email: "ana@acme.example" },
].map((s) => ({ phone: "", address: "", payment_method: "", payment_details: "", payment_terms: "", typical_lead_time: "", notes: "", archived: false,
  total_paid: 0, total_revenue: 0, total_profit: 0, deal_count: 0, created_at: ago(9000), updated_at: ago(9000), ...s }));
const SETTINGS = { send_from: "sam@example.test", from_name: "Sam", address_line: "Example Co", daily_cap: 30, pump_seen_at: ago(2), pump_note: "",
  hours: "", subject: "", body: "", bump: "", signature: "", signature_logo: "" };
const list = () => {
  const counts: Record<string, number> = {};
  const lists: any[] = [];
  for (const l of LEADS) {
    counts[l.status] = (counts[l.status] ?? 0) + 1;
    let x = lists.find((y) => y.name === l.list);
    if (!x) lists.push(x = { name: l.list, total: 0, emailed: 0, replied: 0, texted: 0, suppliers: 0, converted: 0, waiting: 0, failed: 0, not_emailed: 0 });
    x.total++; x.emailed += +l.emailed; x.replied += +l.replied; x.suppliers += +!!l.supplier_id; x.converted += +(l.status === "converted"); x.not_emailed += +!l.emailed;
  }
  return { today, due: 0, leads: LEADS.map((l) => ({ ...l })), counts, lists, queue: { waiting: 0, sent_today: 4, failed: 0, line: "" }, settings: SETTINGS, replies_waiting: 0 };
};

(window as any).__calls = [];
(window as any).__FIXTURE = (cmd: string, args: any) => {
  (window as any).__calls.push([cmd, args]);
  if (cmd === "employee_me") return { id: "u1", name: "Invented Admin", email: "admin@example.invalid", role: "admin", permissions: ["*"] };
  if (cmd === "outreach_pump_get") return { on: true, login: "sam@example.test", inboxes: [], last_error: "", last_sent_at: ago(14), watching: "" };
  if (cmd === "list_suppliers") return SUPPLIERS;
  if (cmd.startsWith("list_") || cmd.startsWith("get_")) return [];
  if (cmd !== "outreach_request") return cmd.startsWith("outreach_pump") ? null : [];
  const { method, path, body } = args;
  if (method === "GET" && path === "/api/outreach/leads") return list();
  if (method === "GET" && path === "/api/outreach/supplier-leads") return { leads: [], waiting: 0 };
  if (method === "GET" && path === "/api/outreach/supplier-links")
    return { links: LEADS.filter((l) => l.supplier_id).map((l) => ({ supplier_id: l.supplier_id, lead_id: l.id, company: l.company, list: l.list, status: l.status })) };
  const ln = path.match(/^\/api\/outreach\/leads\/([^/]+)\/link-supplier$/);
  if (ln) {
    const l = LEADS.find((x) => x.id === ln[1])!;
    const s = SUPPLIERS.find((x) => x.id === body.supplier_id);
    if (!body.supplier_id) { Object.assign(l, { supplier_id: "", supplier_name: "", status: "talking" }); return { supplier_id: "" }; }
    Object.assign(l, { supplier_id: s.id, supplier_name: s.name, status: l.status === "converted" ? "converted" : "supplier" });
    return { supplier_id: s.id, supplier_name: s.name };
  }
  const m = path.match(/^\/api\/outreach\/leads\/([^/]+)$/);
  if (m && method === "GET") return { lead: { ...LEADS.find((x) => x.id === m[1]) }, events: [], queue: [] };
  if (m && method === "POST") {
    const l = LEADS.find((x) => x.id === m[1])!;
    if (body.status && ["supplier", "converted"].includes(body.status) && !l.supplier_id) throw new Error("Link them to a supplier first.");
    Object.assign(l, body);
    return { ok: true };
  }
  return { ok: true };
};

const v = new URLSearchParams(location.search).get("v");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="h-screen flex bg-bg">
    <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface" />
    <main id="pane" className="flex-1 overflow-auto p-6">{v === "suppliers" ? <SuppliersView /> : <ColdCallsView />}</main>
    <ToastHost />
  </div>,
);
