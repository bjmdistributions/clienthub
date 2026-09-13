// DEV ONLY — fixture behind r271-harness.html. Mounts ShowPackingView against an
// in-memory stand-in for the R-271 `/api/shows*` routes (same bin rules as
// clienthub-api routes/show_packing.rs: first win = next box, repeat buyer = same
// box, typed item number creates "Item #N"). Nothing in the app imports this.
import ReactDOM from "react-dom/client";
import ShowPackingView from "./components/ShowPackingView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const now = () => new Date().toISOString();
let seq = 0;
const uid = () => `id${++seq}`;
const state: any = { enabled: false, config: { fee_pct: 8, processing_pct: 2.9, processing_fixed: 0.3 }, shows: [] as any[] };

function detail(show: any) {
  const sold = show.items.filter((i: any) => i.status === "sold");
  const gross = sold.reduce((s: number, i: any) => s + (i.sale_price || 0), 0);
  const fees = sold.reduce((s: number, i: any) => s + (i.sale_price || 0) * (show.fee_pct + show.processing_pct) / 100 + show.processing_fixed, 0);
  const cost = show.items.filter((i: any) => i.status === "sold" || i.status === "giveaway").reduce((s: number, i: any) => s + i.unit_cost, 0);
  const last = [...show.items].filter((i: any) => i.sold_at).sort((a: any, b: any) => (a.sold_at < b.sold_at ? 1 : -1))[0] || null;
  return {
    show: { ...show, items: undefined, buyers: undefined },
    items: [...show.items].sort((a: any, b: any) => a.item_number - b.item_number),
    buyers: [...show.buyers].sort((a: any, b: any) => a.bin_number - b.bin_number),
    last_sale: last,
    pnl: { gross, fees, fees_source: "estimated", cost, net: gross - fees - cost, sold: sold.length, giveaways: show.items.filter((i: any) => i.status === "giveaway").length, pending: show.items.filter((i: any) => i.status === "pending").length, buyers: show.buyers.length, avg_sale: sold.length ? gross / sold.length : 0 },
    sales_imported: 0,
    mismatches: [],
  };
}

function newItem(show: any, n: number, title: string, unit_cost = 0) {
  const it = { id: uid(), org_id: "o", show_id: show.id, item_number: n, title, source_lot_id: null, unit_cost, start_price: null, status: "pending", buyer: null, bin_number: null, sale_price: null, sold_at: null, created_at: now(), updated_at: now() };
  show.items.push(it);
  return it;
}

function route(method: string, path: string, body: any): any {
  const parts = path.split("/").filter(Boolean); // api shows :id ...
  if (path === "/api/shows/addon") {
    if (method === "POST") { state.enabled = body.enabled; if (body.config) state.config = body.config; }
    return { entitled: true, enabled: state.enabled, config: state.config };
  }
  if (path === "/api/shows" && method === "GET") {
    return { shows: state.shows.map((s: any) => { const d = detail(s); return { ...d.show, items: s.items.length, sold: d.pnl.sold, giveaways: d.pnl.giveaways, buyers: s.buyers.length, gross: d.pnl.gross }; }) };
  }
  if (path === "/api/shows" && method === "POST") {
    const s = { id: uid(), org_id: "o", name: body.name, show_date: body.show_date || "", status: "prep", ...state.config, archived: false, created_at: now(), updated_at: now(), items: [] as any[], buyers: [] as any[] };
    state.shows.unshift(s);
    return { ...s, items: undefined, buyers: undefined };
  }
  const show = state.shows.find((s: any) => s.id === parts[2]);
  if (!show) throw "not found";
  const tail = parts.slice(3).join("/");
  if (tail === "" ) return detail(show);
  if (tail === "items") {
    let n = show.items.reduce((m: number, i: any) => Math.max(m, i.item_number), 0);
    return { items: body.items.filter((i: any) => i.title?.trim()).map((i: any) => newItem(show, ++n, i.title, i.unit_cost || 0)) };
  }
  if (tail.startsWith("items/") && tail.endsWith("/update")) {
    const it = show.items.find((i: any) => i.id === parts[4]);
    Object.assign(it, body, { updated_at: now() });
    return it;
  }
  if (tail === "sell") {
    let it = body.item_id ? show.items.find((i: any) => i.id === body.item_id) : null;
    if (!it && body.item_number) it = show.items.find((i: any) => i.item_number === body.item_number) || newItem(show, body.item_number, `Item #${body.item_number}`);
    if (!it) it = [...show.items].filter((i: any) => i.status === "pending").sort((a: any, b: any) => a.item_number - b.item_number)[0];
    if (!it) throw "Every item in this show is already recorded.";
    let buyer: any = null;
    if (body.buyer) {
      const u = body.buyer.trim().replace(/^@/, "").toLowerCase();
      buyer = show.buyers.find((b: any) => b.username === u);
      if (!buyer) { buyer = { id: uid(), org_id: "o", show_id: show.id, username: u, display_name: body.buyer, bin_number: show.buyers.length + 1, created_at: now() }; show.buyers.push(buyer); }
      if (it.status === "sold" && it.buyer !== u) throw `Item #${it.item_number} is already recorded for @${it.buyer}.`;
    }
    Object.assign(it, { status: body.giveaway ? "giveaway" : "sold", buyer: buyer?.username ?? null, bin_number: buyer?.bin_number ?? null, sale_price: body.giveaway ? 0 : (body.sale_price ?? 0), sold_at: now() });
    show.status = "live";
    return { item: it, buyer: buyer && { ...buyer, is_new: false }, next_item: null };
  }
  if (tail === "unsell") {
    const it = show.items.find((i: any) => i.id === body.item_id);
    Object.assign(it, { status: "pending", buyer: null, bin_number: null, sale_price: null, sold_at: null });
    return { item: it };
  }
  if (tail === "update") { Object.assign(show, body); return detail(show).show; }
  throw `harness: unhandled ${method} ${path}`;
}

(window as any).__FIXTURE = (cmd: string, args: any) => {
  if (cmd === "show_packing_request") {
    try { return Promise.resolve(route(args.method, args.path, args.body)); }
    catch (e) { return Promise.reject(String(e)); }
  }
  if (cmd === "list_inventory") return [];
  return null;
};

const me: any = { permissions: ["*"], role: "admin", name: "Jack" };
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ background: "var(--t-bg)", minHeight: "100vh" }}>
    <ShowPackingView me={me} />
    <ToastHost />
  </div>,
);
