// DEV ONLY: the fixture behind r569-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Opens the REAL lot form the way a delivery's Make a listing
// does, on invented data. Every call is kept in window.__calls.
import ReactDOM from "react-dom/client";
import InventoryView from "./components/InventoryView";
import { ToastHost } from "./components/Toast";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;
(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "employee_me") return { id: "u1", name: "Invented Admin", email: "admin@example.invalid", role: "admin", permissions: ["*"] };
  if (cmd === "list_warehouse_buys") return { stock: [], coming: [] };
  if (cmd === "media_base_dir") return "C:/fixture";
  if (cmd === "list_inventory" || cmd.startsWith("list_")) return [];
  if (cmd === "create_lot") return { id: "new1" };
  if (cmd === "import_lot_photos") return args.paths;
  if (cmd.startsWith("get_") || cmd.endsWith("_config")) return {};
  return [];
};

const detail = {
  name: "Shoe truck, invented", quantity: 483, total_cost: 0, price_type: "per_unit",
  description: "Brands: Harbor Runner, Pine Trail", details: { load_id: "wl1" },
  photo_paths: ["media/deliveries/wl1/l1-a.jpg", "media/deliveries/wl1/l2-b.jpg"],
};
sessionStorage.setItem("inventory_prefill_lot", JSON.stringify(detail));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-canvas min-h-screen">
    <InventoryView />
    <ToastHost />
  </div>
);
