// DEV ONLY: the fixture behind r546-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL ColdCallsView with invented warehouses
// inside the shell's geometry (216px sidebar beside an overflow-auto pane).
import ReactDOM from "react-dom/client";
import ColdCallsView from "./components/ColdCallsView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const today = day(0);
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const lead = (o: Record<string, unknown>): any => ({
  contact_name: "", email: "", phone: "", city: "", state: "NJ", kind: "", website: "", status: "new", next_touch: "",
  last_touch_at: "", personal_line: "", notes: "", source: "Call list", supplier_id: "", ...o,
});
const LEADS = [
  lead({ id: "l1", company: "Harbor Prep Co", contact_name: "Dana Ruiz", email: "hello@harborprep.example", phone: "555-201-0101", city: "Riverton", kind: "prep", next_touch: today }),
  lead({ id: "l2", company: "Northline Fulfillment", email: "sales@northline.example", phone: "555-201-0102", city: "Lakeview", kind: "ecom", status: "called", next_touch: day(-2), personal_line: "Saw you run apparel returns." }),
  lead({ id: "l3", company: "Garment Row Logistics", contact_name: "Pat", email: "info@garmentrow.example", city: "Millbrook", state: "NY", kind: "apparel", status: "emailed", next_touch: day(3) }),
  lead({ id: "l4", company: "Seaside Pallet Storage", phone: "555-201-0104", city: "Bayport", state: "NY", kind: "other", status: "talking", next_touch: today }),
  lead({ id: "l5", company: "Crossdock Twelve", email: "ops@crossdock12.example", kind: "forwarder", status: "do_not_contact" }),
  lead({ id: "l6", company: "Elm Street Apparel 3PL", contact_name: "Morgan", email: "morgan@elmst.example", city: "Fairhaven", kind: "apparel", status: "has_goods", next_touch: day(1), notes: "6 pallets of mixed womens tops" }),
  lead({ id: "l7", company: "Old Mill Warehousing", email: "info@oldmill.example", city: "Granby", state: "NY", kind: "ecom", status: "not_now", next_touch: day(80) }),
  lead({ id: "l8", company: "Bluebird Supply", email: "b@bluebird.example", city: "Ashford", kind: "prep", status: "supplier" }),
  // R-631: invented overseas suppliers at three stages of their checks.
  lead({ id: "o1", company: "Adriatic Trading Srl", contact_name: "Luca", email: "sales@adriatic.example", state: "", country: "Italy", kind: "overseas", status: "talking",
    checks: { done: Object.fromEntries(["company", "invoices", "bank", "inspection", "trial"].map((k) => [k, { at: ago(60 * 24 * 9), by: "Invented Admin" }])), cleared: true } }),
  lead({ id: "o2", company: "Harbourline Exports Ltd", email: "info@harbourline.example", state: "", country: "United Kingdom", kind: "overseas",
    checks: { done: { company: { at: ago(60 * 24 * 2), by: "Invented Admin" }, bank: { at: ago(60 * 5), by: "Invented Admin" } }, cleared: false } }),
  lead({ id: "o3", company: "Eastgate Stocklots", state: "", country: "Turkey", kind: "overseas", checks: { done: {}, cleared: false } }),
];
const SETTINGS = {
  send_from: "sam@example.test", from_name: "Sam", address_line: "Example Co, 1 Test Way, Riverton NJ", daily_cap: 30,
  pump_seen_at: new URLSearchParams(location.search).get("pc") === "off" ? "" : ago(2), pump_note: "Replies are watched in sam@example.test.",
  hours: "9 to 4 New York time, weekdays", subject: "leftover inventory at {company}",
  body: "Hi {first_name},\n\nI buy leftover and abandoned inventory from warehouses, mostly clothing and shoes.\n\n{personal_line}\n\nAnything like that sitting in {city} right now?\n\n{from_name}",
  bump: "Hi {first_name}, bumping this in case it got buried.\n\n{from_name}",
};
const list = () => {
  const counts: Record<string, number> = {};
  let due = 0;
  const leads = LEADS.map((l) => {
    counts[l.status as string] = (counts[l.status as string] ?? 0) + 1;
    const d = !!l.next_touch && (l.next_touch as string) <= today;
    if (d) due++;
    return { ...l, due: d, queued: l.id === "l3" ? 1 : 0, emails_sent: 0 };
  }).sort((a, b) => Number(b.due) - Number(a.due) || String(a.company).localeCompare(String(b.company)));
  return { today, due, leads, counts, queue: { waiting: 2, sent_today: 7, failed: 1 }, settings: SETTINGS, replies_waiting: REPLIES.filter((r) => !r.answered).length };
};
const reply = (o: Record<string, unknown>): any => ({ contact_name: "", status: "talking", subject: "Re: leftover inventory", phone: "", tags: [],
  answered: false, answered_how: "", answered_at: "", yours: { subject: "leftover inventory", body: "Hi there,\n\nAnything sitting right now?\n\nSam", at: ago(60 * 72) }, ...o });
const REPLIES = [
  reply({ id: "r1", lead_id: "l6", company: "Elm Street Apparel 3PL", contact_name: "Morgan", email: "morgan@elmst.example", at: ago(40),
    new_text: "Hi Sam,\n\nWe have about 12 pallets of mixed womens tops sitting here from a brand that stopped paying. Can you call me at (555) 201-0199 tomorrow? We want it gone by Friday.",
    body: "Hi Sam,\n\nWe have about 12 pallets of mixed womens tops sitting here from a brand that stopped paying. Can you call me at (555) 201-0199 tomorrow? We want it gone by Friday.\n\nThanks,\nMorgan\n\nOn Tue, Oct 20 Sam wrote:\n> Hi Morgan,\n> Anything sitting?",
    gist: "We have about 12 pallets of mixed womens tops sitting here from a brand that stopped paying. Can you call me at (555) 201-0199 tomorrow?",
    tags: ["stock", "call"], phone: "(555) 201-0199" }),
  reply({ id: "r2", lead_id: "l4", company: "Seaside Pallet Storage", email: "ops@seaside.example", at: ago(60 * 5),
    new_text: "What kind of pricing do you pay per pallet, and do you take shoes?", body: "What kind of pricing do you pay per pallet, and do you take shoes?",
    gist: "What kind of pricing do you pay per pallet, and do you take shoes?", tags: ["stock", "details"] }),
  reply({ id: "r3", lead_id: "l7", company: "Old Mill Warehousing", email: "info@oldmill.example", at: ago(60 * 30),
    new_text: "No thank you, we don't have anything like that.", body: "No thank you, we don't have anything like that.",
    gist: "No thank you, we don't have anything like that.", tags: ["no"], answered: true, answered_how: "answer", answered_at: ago(60 * 26) }),
  reply({ id: "r4", lead_id: "l5", company: "Crossdock Twelve", email: "ops@crossdock12.example", at: ago(60 * 50),
    new_text: "stop", body: "stop", gist: "stop", tags: ["stop"], answered: true, answered_how: "stop", answered_at: ago(60 * 50) }),
];
const render = (t: string, l: any) => t.replace(/\{first_name\}/g, (l.contact_name || "there").split(" ")[0]).replace(/\{company\}/g, l.company)
  .replace(/\{city\}/g, l.city || "your area").replace(/\{personal_line\}\n?/g, l.personal_line ? l.personal_line + "\n" : "").replace(/\{from_name\}/g, SETTINGS.from_name)
  + `\n\n${SETTINGS.address_line}\nReply stop and I won't email again.`;

(window as any).__calls = [];
(window as any).__FIXTURE = (cmd: string, args: any) => {
  (window as any).__calls.push([cmd, args]);
  if (cmd === "employee_me") return { id: "u1", name: "Invented Admin", email: "admin@example.invalid", role: "admin", permissions: ["*"] };
  if (cmd === "outreach_pump_get") return { on: true, login: "sam@example.test", inboxes: ["sam@example.test"], last_error: "", last_sent_at: ago(14), watching: "sam@example.test" };
  if (cmd === "outreach_pump_set") return null;
  if (cmd !== "outreach_request") return null;
  const { method, path, body } = args;
  if (method === "GET" && path === "/api/outreach/leads") return list();
  if (method === "GET" && path === "/api/outreach/replies") return { replies: [...REPLIES].sort((x, y) => Number(x.answered) - Number(y.answered)), waiting: REPLIES.filter((r) => !r.answered).length };
  const ra = path.match(/^\/api\/outreach\/replies\/([^/]+)\/answered$/);
  if (ra) { const r = REPLIES.find((x) => x.id === ra[1])!; r.answered = true; r.answered_how = "answered"; r.answered_at = ago(0); return { ok: true }; }
  const ck = path.match(/^\/api\/outreach\/leads\/([^/]+)\/check$/);
  if (ck) {
    const l: any = LEADS.find((x) => x.id === ck[1])!;
    if (body.done) l.checks.done[body.key] = { at: ago(0), by: "Invented Admin" }; else delete l.checks.done[body.key];
    l.checks.cleared = Object.keys(l.checks.done).length === 5;
    return { checks: l.checks };
  }
  const m = path.match(/^\/api\/outreach\/leads\/([^/]+)$/);
  if (method === "GET" && m) {
    const l = LEADS.find((x) => x.id === m[1])!;
    return {
      lead: l,
      events: l.id === "l3" ? [{ id: "e1", kind: "email", outcome: "", subject: "leftover inventory at Garment Row Logistics", body: "Hi Pat,\n\nI buy leftover and abandoned inventory...", at: ago(60 * 30), by: "" },
        { id: "e2", kind: "call", outcome: "voicemail", subject: "", body: "Left one with the front desk", at: ago(60 * 50), by: "Invented Admin" }] : [],
      queue: l.id === "l3" ? [{ id: "q1", subject: "Re: leftover inventory at Garment Row Logistics", body: "", status: "failed", error: "The PC stopped while sending this one. Check your Sent folder before sending it again.", bump: true, created_at: ago(90), sent_at: "" }] : [],
    };
  }
  if (path === "/api/outreach/preview") {
    const emails: any[] = [], skipped: any[] = [];
    body.lead_ids.forEach((id: string) => {
      const l: any = LEADS.find((x) => x.id === id)!;
      if (!l.email) skipped.push({ lead_id: id, company: l.company, reason: "No email address" });
      else emails.push({ lead_id: id, company: l.company, to: l.email, subject: body.subject.replace("{company}", l.company), body: render(body.body, l), reply_to: "", bump: false });
    });
    return { emails, skipped };
  }
  if (path === "/api/outreach/queue") return { queued: body.emails.length, skipped: [] };
  const c = path.match(/^\/api\/outreach\/leads\/([^/]+)\/call$/);
  if (c) { const l: any = LEADS.find((x) => x.id === c[1])!; if (l.status === "new") l.status = "called"; l.next_touch = body.next_touch || today; return { status: l.status, next_touch: l.next_touch }; }
  return { ok: true };
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="h-screen flex bg-bg">
    <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface" />
    <main id="pane" className="flex-1 overflow-auto p-6"><ColdCallsView /></main>
    <ToastHost />
  </div>,
);
