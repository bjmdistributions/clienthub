// DEV ONLY: the fixture behind r554-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL WarehouseView (Map tab, floor plan,
// Deliveries) with every Tauri command forwarded to the local test server's twin route (a fresh database
// of invented rows), so the desktop screen runs against the same rules end to end.
import ReactDOM from "react-dom/client";
import WarehouseView from "./components/WarehouseView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const calls: [string, unknown][] = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const r = await fetch(path, { method, credentials: "include", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const v = await r.json();
  if (v && typeof v === "object" && "error" in v && v.error) throw String(v.error);
  return v;
};
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
(window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown }).__FIXTURE = (cmd: string, a: A) => {
  calls.push([cmd, a]);
  const L = (id: string) => `/api/warehouse/loads/${encodeURIComponent(id)}`;
  switch (cmd) {
    case "list_warehouse_items": return http("GET", "/api/warehouse");
    case "list_warehouse_loads": return http("GET", "/api/warehouse/loads");
    case "list_warehouse_buys": return { stock: [], coming: [] };
    case "list_warehouse_floors": return http("GET", "/api/warehouse/floors");
    case "create_warehouse_floor": return http("POST", "/api/warehouse/floors", { name: a.name, width: a.width, depth: a.depth, shape: a.shape });
    case "update_warehouse_floor": return http("POST", `/api/warehouse/floors/${a.id}`, clean({ name: a.name, width: a.width, depth: a.depth, shape: a.shape, archived: a.archived }));
    case "draw_pallet_row": return http("POST", `/api/warehouse/floors/${a.floorId}/rows`, clean({ load_id: a.loadId, name: a.name, x: a.x, y: a.y, across: a.across, count: a.count, turned: a.turned, gap: a.gap ?? 0 }));
    case "change_pallet_row": return http("POST", `/api/warehouse/floors/${a.floorId}/rows/${encodeURIComponent(a.name)}`, clean({ x: a.x, y: a.y, across: a.across, turned: a.turned, gap: a.gap, remove: a.remove ?? false }));
    case "get_warehouse_load": return http("GET", L(a.id));
    case "set_pallet_boxes": return http("POST", `${L(a.loadId)}/pallets/${a.number}/boxes`, clean({ rows: a.rows, per_row: a.perRow, count: a.count }));
    case "save_warehouse_case": return http("POST", `${L(a.loadId)}/cases`, clean({ id: a.caseId, pallet: a.pallet, contents: a.contents, notes: a.notes ?? "", copies: a.copies, kind: a.kind, code: a.code }));
    case "remove_warehouse_case": return http("POST", `${L(a.loadId)}/cases/${a.caseId}/remove`, {});
    case "save_load_pallet": return http("POST", `${L(a.loadId)}/pallets/${a.number}`, clean({ location: a.location, note: a.note, closed: a.closed, start_next: a.startNext ?? false, archived: a.archived, floor_id: a.floorId, x: a.x, y: a.y, turned: a.turned }));
    case "start_load_pallet": return http("POST", `${L(a.loadId)}/pallets`, a.place ?? {});
    case "ensure_delivery_pictures": return { arrived: 0, missing: 0 };
    case "media_base_dir": return "";
    default:
      if (cmd.startsWith("plugin:event|")) return 1;
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", height: "100vh" }}>
    <div style={{ width: 216, flexShrink: 0 }} className="bg-surface-2 border-r border-line" />
    <div className="flex-1 overflow-auto p-6"><WarehouseView /></div>
    <ToastHost />
  </div>,
);
