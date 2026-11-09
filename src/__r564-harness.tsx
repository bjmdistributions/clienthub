// DEV ONLY: the fixture behind r564-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL Manifest analyzer with its Tauri calls
// mocked from invented fixtures (src/__r564-fixture/*.json, produced by the real Rust reader on invented CSVs).
// ?state=list|clean|sections|cost|needsmap|review  &theme=dark
import ReactDOM from "react-dom/client";
import ManifestView from "./components/ManifestView";
import { ToastHost } from "./components/Toast";
import "./index.css";
import clean from "./__r564-fixture/clean.json";
import sections from "./__r564-fixture/sections.json";
import sectionsOff from "./__r564-fixture/sections_off.json";
import cost from "./__r564-fixture/cost.json";
import costRule from "./__r564-fixture/cost_rule.json";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const w = window as unknown as { __FIXTURE: (cmd: string, a: A) => unknown; __calls: { cmd: string; args: A }[] };
w.__calls = [];

const params = new URLSearchParams(location.search);
const state = params.get("state") || "list";
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");

const needsmap = {
  ...(clean as A), needs_map: true,
  checks: [{ severity: "red", code: "no_header", text: "Ecliptr could not tell which column holds the units on this sheet.", fix: "columns", rows: [] }],
};
const saved: A[] = [
  { id: "m1", name: "Sample mixed pallets", supplier: "Harbor Pallet Co", source_name: "harbor-pallets.xlsx", ask: 1850, status: "saved", lot_id: "lot_1", load_id: null,
    totals_json: JSON.stringify({ lines: 40, units: 230, retail: 5120.5 }), options_json: "{}", file_path: "C:/invented/harbor-pallets.xlsx",
    created_at: "2026-10-20T12:00:00Z", updated_at: "2026-10-20T12:00:00Z", archived: false },
  { id: "m2", name: "Closeout toys", supplier: "North Yard", source_name: "toys.csv", ask: null, status: "saved", lot_id: null, load_id: null,
    totals_json: JSON.stringify({ lines: 12, units: 93, retail: 0 }), options_json: "{}", file_path: "C:/invented/toys.csv",
    created_at: "2026-10-25T12:00:00Z", updated_at: "2026-10-25T12:00:00Z", archived: false },
];
let rules: A[] = [];

const dialogPath = () => `C:/invented/${state === "review" ? "review" : state}.csv`;
// R-640: the clean sheet as if written in euros; with a rate every money figure is in dollars.
const eur = (rate: number | null | undefined) => {
  const c = JSON.parse(JSON.stringify(clean));
  c.currency = "EUR";
  const k = rate || 1;
  const scale = (o: A) => { for (const f of ["total_retail", "retail", "cost", "sheet", "uncategorized_retail"]) if (typeof o[f] === "number") o[f] *= k; };
  scale(c);
  [...(c.categories || []), ...(c.brands || []), ...(c.lines || []), ...(c.products || [])].forEach(scale);
  return c;
};
const analyze = (a: A) => {
  const p = String(a.path), o = a.options || {};
  if (p.includes("eur")) return eur(o.fx_rate);
  if (p.includes("needsmap")) return o.columns ? clean : needsmap;
  if (p.includes("review")) {
    // The review state is the sections sheet; once a rule is saved every line reads as placed by it.
    if (!(o.rules || []).length) return sections;
    const c = JSON.parse(JSON.stringify(sections));
    c.lines.forEach((l: A) => { l.placed = "rule"; }); c.products.forEach((l: A) => { l.placed = "rule"; });
    c.review.groups = []; c.uncategorized_lines = 0; c.uncategorized_retail = 0;
    return c;
  }
  if (p.includes("sections")) return (o.sections_off || []).length ? sectionsOff : sections;
  if (p.includes("cost")) return (o.rules || []).length ? costRule : cost;
  return clean;
};

w.__FIXTURE = (cmd: string, a: A) => {
  a = a || {};
  w.__calls.push({ cmd, args: a });
  switch (cmd) {
    case "plugin:dialog|open": return dialogPath();
    case "analyze_manifest": return analyze(a);
    case "manifest_fx_rate": return { rate: 1.1193, date: "2026-11-09" };
    case "list_manifests": return saved;
    case "list_manifests_deleted": return [];
    case "get_manifest": return { ...saved.find((m) => m.id === a.id), lines: [], products: [] };
    case "save_manifest": {
      const r = a.record || {};
      return { id: r.id || "m_new", name: r.name, supplier: r.supplier, source_name: r.source_name, ask: r.ask, status: "saved", lot_id: null, load_id: null,
        totals_json: JSON.stringify(r.totals), options_json: JSON.stringify(r.options), file_path: r.path, created_at: "2026-10-28T12:00:00Z", updated_at: "2026-10-28T12:00:00Z", archived: false };
    }
    case "update_manifest": return { ...saved[0], id: a.id, name: a.name };
    case "delete_manifest": case "restore_manifest": return null;
    case "find_column_map": return null;
    case "list_manifest_rules": return rules;
    case "save_manifest_rules": rules = [...rules, ...(a.rules || []).map((r: A, i: number) => ({ ...r, id: `rule_${rules.length + i}` }))]; return rules;
    case "list_warehouse_buys": return { stock: [], coming: [{ id: "buy_1", name: "Spring apparel buy", supplier_id: "s1", supplier_name: "North Yard", goods_total: 4200, units_bought: 640, created_at: "2026-10-24T12:00:00Z", truck_cost: {}, trucks: [], goods_paid: 0 }] };
    case "list_categories": return ["Apparel", "Electronics", "Home & Kitchen", "Toys", "Shoes", "Grocery"].map((label, i) => ({ id: `c${i}`, label, sort_order: i }));
    case "list_suppliers": return [{ id: "s1", name: "North Yard" }, { id: "s2", name: "Harbor Pallet Co" }];
    case "manifest_to_load": return { id: "ld_1", name: "Sample delivery" };
    case "set_manifest_links": return null;
    default:
      if (cmd.startsWith("plugin:event|")) return 1;
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6">
    <ManifestView onNavigate={(t: unknown) => { (window as unknown as { __nav: unknown }).__nav = t; }} />
    <ToastHost />
  </div>,
);

// Every state but the list opens a file the way a click on Analyze would.
if (state !== "list") {
  const t = window.setInterval(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /Analyze a manifest/.test(x.textContent || ""));
    if (b) { window.clearInterval(t); (b as HTMLButtonElement).click(); }
  }, 100);
}
