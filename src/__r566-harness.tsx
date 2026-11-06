// DEV ONLY: the fixture behind r566-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL mass edit sheet on invented lots.
// Every call is kept in window.__calls.
import ReactDOM from "react-dom/client";
import LotBulkEdit from "./components/LotBulkEdit";
import { ToastHost } from "./components/Toast";
import type { Lot } from "./lib/api";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;
(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "bulk_edit_lots") return args.ids.length;
  return [];
};

const lot = (id: string, name: string, tags: string[], supplier: string): Lot => ({
  id, name, status: "available", quantity: 100, total_cost: 1, asking_price: 2, price_type: "per_unit",
  category: "Shoes", supplier, location: "Newark, NJ", details_json: JSON.stringify({ tags }),
  photos_json: "[]", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-27T00:00:00Z",
} as unknown as Lot);
const lots = [
  lot("a", "Mixed runners pallet", ["Nike", "Running"], "Harbor Goods"),
  lot("b", "Kids sneakers, 12 cases", ["adidas"], "Harbor Goods"),
  lot("c", "Boots closeout", [], "Pine Street Supply"),
];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 bg-canvas min-h-screen">
    <LotBulkEdit lots={lots} categories={["Apparel", "Shoes", "Toys"]} conditions={["New", "Open box", "Customer returns"]}
      onClose={() => calls.push({ closed: true })} onSaved={() => calls.push({ saved: true })} />
    <ToastHost />
  </div>
);
