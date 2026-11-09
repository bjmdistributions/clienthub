// DEV ONLY: the fixture behind harness/r642-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL SupplierLeadsInbox with invented supplier leads
// inside the shell's geometry (216px sidebar beside an overflow-auto pane). Every name and figure is made up.
import ReactDOM from "react-dom/client";
import SupplierLeadsInbox from "./components/SupplierLeadsInbox";
import { ToastHost } from "./components/Toast";
import "./index.css";

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const LOGO = (() => {
  const c = document.createElement("canvas");
  c.width = 180; c.height = 48;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1f6feb"; g.fillRect(0, 8, 32, 32);
  g.fillStyle = "#3b3b3b"; g.font = "600 20px sans-serif"; g.fillText("Example Co", 42, 31);
  return c.toDataURL("image/png");
})();
const SETTINGS: any = {
  send_from: "sam@example.test", from_name: "Sam", address_line: "Example Co", daily_cap: 30, pump_seen_at: ago(1), pump_note: "",
  hours: "", subject: "", body: "", bump: "",
  signature: new URLSearchParams(location.search).get("sig") === "none" ? "" : "Sam Tester\nExample Co\n(555) 010-0000",
  signature_logo: new URLSearchParams(location.search).get("sig") === "none" ? "" : LOGO,
};
const lead = (o: Record<string, unknown>): any => ({ kind: "supply_lead", company: "", phone: "", acknowledged: false, answered: false, answered_how: "",
  answered_at: "", thread: [], my_reply: null, ...o, last_at: o.last_at ?? o.at });
const LEADS = [
  lead({ id: "n1", name: "Rita Vega", company: "Dock 9 Liquidators", email: "rita@dock9.example", phone: "555-010-0101", at: ago(35),
    subject: "12 pallets of mixed name brand sneakers", gist: "12 pallets of mixed name brand sneakers. Can pick up Friday.",
    lines: [{ label: "Load", value: "12 pallets of mixed name brand sneakers" }, { label: "Pallets", value: "12" }, { label: "Location", value: "Riverton, NJ" },
      { label: "Asking price", value: "$9,000" }, { label: "Timeline", value: "This week" }, { label: "Message", value: "Shelf pulls and returns, mostly mens sizes. Can pick up Friday." }] }),
  lead({ id: "n2", name: "Lee Park", email: "lee@harborgoods.example", at: ago(60 * 26), last_at: ago(60 * 3),
    subject: "Truckload of home goods", gist: "Here are the photos. Most of it is still boxed.",
    lines: [{ label: "Load", value: "Truckload of home goods" }, { label: "Quantity", value: "26 pallets" }],
    thread: [
      { dir: "out", subject: "Re: Truckload of home goods", body: "Hi Lee,\n\nCan you send photos of a few pallets?\n\nSam Tester\nExample Co", whole: "", at: ago(60 * 20) },
      { dir: "in", subject: "Re: Truckload of home goods", body: "Here are the photos. Most of it is still boxed.", whole: "", at: ago(60 * 3) },
    ] }),
  lead({ id: "n3", name: "", company: "", email: "", at: ago(60 * 50), subject: "A box truck of toys", gist: "Load: A box truck of toys",
    lines: [{ label: "Load", value: "A box truck of toys" }] }),
  lead({ id: "n4", name: "Ana Cruz", email: "ana@cruzwholesale.example", at: ago(60 * 24 * 9), subject: "Your load", gist: "Load: Apparel",
    lines: [{ label: "Load", value: "Apparel" }], acknowledged: true, answered: true, answered_how: "acknowledged" }),
];
const waiting = () => LEADS.filter((l) => !l.answered).length;

(window as any).__calls = [];
(window as any).__FIXTURE = (cmd: string, args: any) => {
  (window as any).__calls.push([cmd, args]);
  if (cmd !== "outreach_request") return null;
  const { method, path, body } = args;
  if (method === "GET" && path === "/api/outreach/supplier-leads") return { leads: LEADS.map((l) => ({ ...l })), waiting: waiting() };
  if (method === "GET" && path === "/api/outreach/settings") return SETTINGS;
  if (path === "/api/outreach/signature") { SETTINGS.signature = body.signature; SETTINGS.signature_logo = body.signature_logo; return SETTINGS; }
  const r = path.match(/^\/api\/outreach\/supplier-leads\/([^/]+)\/(reply|answered)$/);
  if (r) {
    const l = LEADS.find((x) => x.id === r[1])!;
    if (r[2] === "reply") l.my_reply = { status: "queued", error: "", text: body.text, at: ago(0) };
    else { l.answered = true; l.answered_how = "answered"; l.answered_at = ago(0); }
    return { ok: true, pump_seen_at: SETTINGS.pump_seen_at };
  }
  return { ok: true };
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="h-screen flex bg-bg">
    <aside className="w-[216px] flex-shrink-0 border-r border-line bg-surface" />
    <main id="pane" className="flex-1 overflow-auto p-6"><SupplierLeadsInbox /></main>
    <ToastHost />
  </div>,
);
