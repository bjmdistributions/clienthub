// DEV ONLY: the fixture behind harness/r675-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL Approvals screen with an upload waiting for
// approval (R-675) and opens its Review panel. Every value and picture here is invented.
// ?case=loading shows photos still being fetched, ?case=none an upload sent without photos.
import ReactDOM from "react-dom/client";
import { ApprovalsView } from "./components/ApprovalsView";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const kase = q.get("case") || "photos";

const now = new Date().toISOString();
const requests = [
  { id: "ap_new", kind: "lot_feed_new", entity_id: "row_1", summary: "New from Muse: Sample ceramic mugs, $3.50 a unit", requested_by_name: null, created_at: now },
  { id: "ap_new2", kind: "lot_feed_new", entity_id: "row_2", summary: "New from Muse: Sample linen towels, $2 a unit", requested_by_name: null, created_at: now },
  { id: "ap_rep", kind: "lot_feed_repeat", entity_id: "lot_9", summary: "Already listed: Sample canvas totes. Price changed from $4 a unit to $3 a unit", requested_by_name: null, created_at: now },
];
const mugs = {
  kind: "new", lot_id: null,
  draft: {
    name: "Sample ceramic mugs", description: "Mixed colours, boxed in sixes. Shelf pulls, mostly new.", category: "Home goods",
    quantity: 1200, total_cost: 1.75, asking_price: 3.5, price_type: "per_unit", notes: "Two pallets, 48x40.",
    supplier: "Sample Supply Co", location: "Columbus, OH", details: {},
  },
  photo_links: kase === "none" ? 0 : 3,
  photos: kase === "photos" ? ["r675/a.svg", "r675/b.svg", "r675/c.svg"] : [],
  photos_ready: kase !== "loading",
  photos_failed: kase === "photos" ? 1 : 0,
};
// R-679: a second waiting lot, so the list of every lot has more than one row.
const towels = {
  kind: "new", lot_id: null,
  draft: {
    name: "Sample linen towels", description: "", category: null, quantity: 400, total_cost: 0.9, asking_price: 2, price_type: "per_unit", notes: null,
    supplier: "Sample Textiles", location: null, details: {},
  },
  photo_links: 1, photos: ["r675/c.svg"], photos_ready: true, photos_failed: 0,
};
const rows: Record<string, any> = { ap_new: mugs, ap_new2: towels };
const server = `${location.origin}/harness`;
let waiting = ["ap_new", "ap_new2"];

(window as any).__FIXTURE = (cmd: string, args: any) => {
  if (cmd === "list_approval_requests") return requests.filter((r) => r.kind !== "lot_feed_new" || waiting.includes(r.id));
  if (cmd === "lot_feed" && args?.action === "held") return { ...rows[args.body.approval_id], server };
  if (cmd === "lot_feed" && args?.action === "all") {
    return { lots: waiting.map((id) => ({ ...rows[id], approval_id: id, created_at: now })), server };
  }
  if (cmd === "lot_feed" && args?.action === "draft") {
    const { approval_id, price, cost, price_text, ...rest } = args.body;
    (window as any).__draft = args.body;
    const r = rows[approval_id];
    r.draft = { ...r.draft, ...rest, asking_price: rest.price_type === "custom" ? 0 : price, total_cost: cost,
      details: rest.price_type === "custom" ? { price_text } : {} };
    return { ...r, server };
  }
  if (cmd === "lot_feed" && args?.action === "order") { (window as any).__order = args.body.photos; return { photos: args.body.photos }; }
  if (cmd === "list_categories") return [{ id: "c1", label: "Home goods", sort_order: 0 }, { id: "c2", label: "Kitchen", sort_order: 1 }];
  if (cmd === "resolve_approval_request") {
    (window as any).__resolved = [...((window as any).__resolved || []), args];
    waiting = waiting.filter((id) => id !== args.id);
    return null;
  }
  if (cmd === "plugin:event|listen") return 1;
  return [];
};

const me = { id: "u1", permissions: ["*"] } as any;
ReactDOM.createRoot(document.getElementById("root")!).render(<div className="p-6"><ApprovalsView me={me} /></div>);
