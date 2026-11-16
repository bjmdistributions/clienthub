// DEV ONLY: the fixture behind r653-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL Manifest analyzer (R-653 spreadsheet view)
// with its Tauri calls mocked. Every name, brand and figure is invented.
// ?state=list|open|remembered|gone  &theme=dark
import ReactDOM from "react-dom/client";
import ManifestView from "./components/ManifestView";
import { ToastHost } from "./components/Toast";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const w = window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown; __calls: { cmd: string; args: A }[] };
w.__calls = [];

const params = new URLSearchParams(location.search);
const state = params.get("state") || "list";
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");

const HEAD = ["UPC", "Item Description", "Brand", "Qty", "Unit Retail", "Ext Retail", "Condition"];
const ITEMS: [string, string, number][] = [
  ["Harbor desk lamp, brass", "Harbor", 24.5], ["Pinewell shelf, 3 tier", "Pinewell", 60], ["Northfield throw blanket", "Northfield", 32],
  ["Harbor floor lamp", "HARBOR", 120], ["Glenmoor stock pot 8 qt", "Glenmoor", 44.99], ["Pinewell storage bins, set of 4", "Pinewell", 19.99],
  ["Unbranded kitchen towels 6 pk", "", 12], ["Northfield bath mat", "Northfield", 18.5], ["Glenmoor knife block 12 pc", "Glenmoor", 89],
  ["Harbor table lamp, linen shade", "Harbor", 39.95],
];
const page = (pallet: number, n: number) => {
  const rows: string[][] = [[`LOAD 9902 PALLET ${pallet}`, "", "", "", "", "", ""], [], HEAD];
  let units = 0;
  for (let i = 0; i < n; i++) {
    const [name, brand, unit] = ITEMS[(i + pallet) % ITEMS.length];
    const q = 1 + ((i * 7 + pallet) % 6);
    units += q;
    rows.push([`0${String(812345000000 + i * 37 + pallet)}`, name, brand, String(q), unit.toFixed(2), (unit * q).toFixed(2), i % 5 === 0 ? "Open box" : "New"]);
  }
  rows.push(["", "Total", "", String(units), "", "", ""]);
  return rows;
};
const SHEETS = [
  { name: "Summary", rows: [["Load 9902"], ["Pallets", "2"], ["Units", "see pallets"]] },
  { name: "Pallet 1", rows: page(1, 42) },
  { name: "Pallet 2", rows: page(2, 28) },
];
const REMEMBERED = { id: "map1", signature: "", name: "Harbor load", map: { header_row: 3, roles: { description: 1, brand: 2, quantity: 3, retail_unit: 4 } }, created_at: "2026-11-01T12:00:00Z" };

const saved: A[] = [
  { id: "m1", name: "Harbor load 9902", supplier: null, source_name: "harbor-9902.xlsx", ask: null, status: "saved", lot_id: null, load_id: null,
    totals_json: JSON.stringify({ lines: 70, units: 245, retail: 11840.25 }), options_json: "{}", file_path: "C:/invented/harbor-9902.xlsx",
    column_map: { header_row: 3, roles: { description: 1, quantity: 3, retail_unit: 4 }, sheet: "Pallet 1" },
    created_at: "2026-11-12T12:00:00Z", updated_at: "2026-11-12T12:00:00Z", archived: false },
  { id: "m2", name: "Closeout housewares", supplier: null, source_name: "housewares.csv", ask: null, status: "saved", lot_id: null, load_id: null,
    totals_json: JSON.stringify({ lines: 3, units: 9, retail: 0 }), options_json: "{}", file_path: null,
    created_at: "2026-11-02T12:00:00Z", updated_at: "2026-11-02T12:00:00Z", archived: false },
];

w.__FIXTURE = (cmd: string, a: A) => {
  a = a || {};
  w.__calls.push({ cmd, args: a });
  switch (cmd) {
    case "plugin:dialog|open": return "C:/invented/harbor-9902.xlsx";
    case "manifest_grid": return SHEETS;
    case "list_manifests": return saved;
    case "list_manifests_deleted": return [];
    case "get_manifest": {
      const m = saved.find((x) => x.id === a.id);
      return { ...m, lines: m?.file_path ? [] : [
        { row: 2, title: "Glenmoor stock pot 8 qt", qty: 2, retail: 89.98, brand: "Glenmoor" },
        { row: 3, title: "Pinewell storage bins, set of 4", qty: 4, retail: 79.96, brand: "Pinewell" },
        { row: 4, title: "Kitchen towels 6 pk", qty: 3, retail: 36, brand: null },
      ], products: [] };
    }
    case "find_column_map": return state === "remembered" && String(a.signature).includes("item description") ? { ...REMEMBERED, signature: a.signature } : null;
    case "save_column_map": return { id: "map1", signature: a.signature, name: a.name, map: a.mapJson, created_at: "2026-11-16T12:00:00Z" };
    case "save_manifest": {
      const r = a.record || {};
      return { id: r.id || "m_new", name: r.name, supplier: null, source_name: r.source_name, ask: null, status: "saved", lot_id: null, load_id: null,
        totals_json: JSON.stringify(r.totals), options_json: JSON.stringify(r.options), column_map: r.column_map, file_path: r.path,
        created_at: "2026-11-16T12:00:00Z", updated_at: "2026-11-16T12:00:00Z", archived: false };
    }
    case "update_manifest": return { ...saved[0], id: a.id, name: a.name };
    case "delete_manifest": case "restore_manifest": return null;
    default:
      if (cmd.startsWith("plugin:event|")) return 1;
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6">
    <ManifestView onNavigate={() => {}} />
    <ToastHost />
  </div>,
);

// open and remembered open the file the way a click on Open a manifest would; gone opens the saved one whose file is not here.
if (state !== "list") {
  const t = window.setInterval(() => {
    const want = state === "gone" ? /^Open$/ : /Open a manifest/;
    const rows = state === "gone" ? Array.from(document.querySelectorAll("tr")).filter((r) => /Closeout housewares/.test(r.textContent || "")) : [document];
    const b = rows.flatMap((r) => Array.from(r.querySelectorAll("button"))).find((x) => want.test((x.textContent || "").trim()));
    if (b) { window.clearInterval(t); (b as HTMLButtonElement).click(); }
  }, 100);
}
