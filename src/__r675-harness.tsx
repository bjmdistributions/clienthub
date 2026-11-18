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
  { id: "ap_rep", kind: "lot_feed_repeat", entity_id: "lot_9", summary: "Already listed: Sample canvas totes. Price changed from $4 a unit to $3 a unit", requested_by_name: null, created_at: now },
];
const held = {
  kind: "new", lot_id: null,
  draft: {
    name: "Sample ceramic mugs", description: "Mixed colours, boxed in sixes. Shelf pulls, mostly new.", category: "Home goods",
    quantity: 1200, total_cost: 2100, asking_price: 3.5, price_type: "per_unit", notes: "Two pallets, 48x40.",
    supplier: "Sample Supply Co", location: "Columbus, OH", details: {},
  },
  photo_links: kase === "none" ? 0 : 3,
  photos: kase === "photos" ? ["r675/a.svg", "r675/b.svg"] : [],
  photos_ready: kase !== "loading",
  photos_failed: kase === "photos" ? 1 : 0,
  server: `${location.origin}/harness`,
};

(window as any).__FIXTURE = (cmd: string, args: any) => {
  if (cmd === "list_approval_requests") return requests;
  if (cmd === "lot_feed" && args?.action === "held") return held;
  if (cmd === "plugin:event|listen") return 1;
  return [];
};

const me = { id: "u1", permissions: ["*"] } as any;
ReactDOM.createRoot(document.getElementById("root")!).render(<div className="p-6"><ApprovalsView me={me} /></div>);
