// DEV ONLY — the fixture behind lot-harness.html. Nothing in the app imports this, and
// index.html does not reference the page, so it never reaches a build.
//
// Every figure here is invented. The point is to render the screen, not to be right about
// a warehouse: change a number freely, but keep the SHAPES honest, because a fixture that
// lies about a field's type hides the bug it was meant to catch.
import ReactDOM from "react-dom/client";
import LotEngineView from "./components/LotEngineView";
import "./index.css";

const BRANDS = [
  "Nike", "adidas", "New Balance", "Crocs", "Under Armour", "Puma", "Reebok", "Converse",
  "Vans", "Skechers", "ASICS", "Hoka", "Brooks", "Timberland", "Columbia", "The North Face",
  "Carhartt", "Levi's",
];
const CATS = [
  "Footwear", "Boots", "Sandals", "Clogs", "Slippers", "Cleats", "Apparel-Top",
  "Apparel-Bottom", "Socks", "Underwear", "Bag", "Headwear", "Accessory", "Uncategorized",
];
const SEGS = ["Men", "Women", "Kids", "Unisex"];

const facet = (name: string, i: number) => ({
  name, units: Math.round(24000 / (i + 1.4)), slots: Math.round(900 / (i + 1.4)),
});

const slot = (i: number) => {
  const total = 60 - (i % 14) * 3;
  const want = Math.round(total * (0.98 - (i % 14) * 0.05));
  const other = total - want;
  return {
    location: `4${(i % 5) + 1}-${String(101 + i * 13).padStart(3, "0")}-0${(i % 4) + 1}A`,
    total, allowed: total, want, breaks: 0, pct: want / total,
    msrp: total * 96.4, styles: 4 + (i % 9),
    brands: [
      { name: "Nike", units: want },
      { name: "New Balance", units: Math.max(1, Math.round(other * 0.6)) },
      { name: "adidas", units: Math.max(1, Math.round(other * 0.3)) },
    ].filter((b) => b.units > 0),
    comes_with: other > 0 ? [{ name: "New Balance", units: Math.max(1, other) }] : [],
    boxes: ["BOX3"],
    unverified_units: i % 4 === 0 ? 3 + i : 0,
  };
};

// A cost of 0 with cost_known false is the "not recorded" case, which is the one the UI
// must NOT render as a 100% margin. Flip COST_PCT to see the other branch.
const COST_PCT = 0.12;

const group = (name: string, units: number, share: number) => ({
  name, units, styles: Math.max(1, Math.round(units / 38)),
  locations: Math.max(1, Math.round(units / 61)),
  msrp: units * 94.2, ask: units * 24.5, per_unit: 24.5, share,
  cost: units * 94.2 * COST_PCT, profit: units * 24.5 - units * 94.2 * COST_PCT,
});

const ask = 103_013, msrp = 396_204, cost = msrp * COST_PCT;
const TOTALS = {
  locations: 214, stacks: 1806, styles: 742, units: 4118, msrp, ask,
  effective_pct: 0.26, per_unit: 25.01,
  cost, cost_per_unit: cost / 4118, profit: ask - cost, margin: (ask - cost) / ask,
  cost_known: COST_PCT > 0,
  by_brand: [group("Nike", 2410, 0.585), group("New Balance", 690, 0.168), group("adidas", 511, 0.124)],
  by_category: [group("Footwear", 3402, 0.826), group("Boots", 402, 0.098)],
  title_risk_units: [3961, 108, 27, 22] as [number, number, number, number],
};

const sheet = (id: string, name: string, over: Record<string, any> = {}) => ({
  id, name, source_filename: `${name}.xlsx`, imported_at: "2026-08-31T09:00:00Z",
  rows_in: 144_635, stacks: 96_770, products: 15_217, units: 179_672, locations: 7677,
  msrp_total: 17_074_851, artifact_path: null, report_path: null, audit_map_path: null,
  archived: false, staged_slots: 925, removed_slots: 38, has_stacks: true, ...over,
});

const SHEETS = [
  sheet("s1", "Shoe list"),
  sheet("s2", "Carhartt offer", { staged_slots: 0, removed_slots: 0, locations: 412 }),
];
const ARCHIVED = [sheet("s9", "July closeout", { archived: true, staged_slots: 400, removed_slots: 600, locations: 1000 })];

const BUILD = {
  id: "b1", sheet_id: "s1", sheet_name: "Shoe list", name: "Mixed athletic 4,118",
  status: "draft", price_pct: 0.26, price_pct_json: null,
  cost_pct: COST_PCT, cost_pct_json: null,
  locations: 214, units: 4118, styles: 742, msrp_total: msrp, ask_total: ask, slots: [],
  notes: null, archived: false,
  created_at: "2026-08-30T10:00:00Z", updated_at: "2026-08-30T10:00:00Z",
};

const CODES = Array.from({ length: 214 }, (_, i) =>
  `4${(i % 5) + 1}-${String(101 + i).padStart(3, "0")}-0${(i % 4) + 1}A`).join("\n");

const planLot = (index: number, target: number) => {
  const locs = Array.from({ length: Math.ceil(target / 58) }, (_, k) =>
    `4${(index % 5) + 1}-${String(200 + index * 40 + k).padStart(3, "0")}-01A`);
  const units = locs.length * 58;
  const wantU = Math.round(units * (0.97 - index * 0.04));
  return {
    index, locations: locs, units, want_units: wantU, pct: wantU / units,
    msrp: units * 96.4, styles: locs.length * 6,
    brands: [{ name: "Nike", units: wantU }, { name: "New Balance", units: units - wantU }],
    unverified_units: index === 2 ? 41 : 0,
  };
};

/// A mutable fixture tree. `let`-scoped at module level so the tree cases can mutate it and
/// the screen re-renders against the change, which is the only way to drive a combine.
const TREE: any[] = [
  { ...BUILD, id: "b1", name: "B- 001", kind: "lot", parent_id: null, status: "saved" },
  { ...BUILD, id: "b2", name: "B- 002", kind: "lot", parent_id: null, status: "saved" },
  { ...BUILD, id: "b3", name: "B- 003", kind: "lot", parent_id: null, status: "saved" },
  { ...BUILD, id: "b4", name: "Kids footwear 1,204", kind: "lot", parent_id: null, status: "sent" },
  {
    ...BUILD, id: "brA", name: "3,000-unit lots", kind: "branch", parent_id: null,
    status: "saved", units: 2060, locations: 48, styles: 61,
    msrp_total: 145_755.53, ask_total: 43_732.5, slots: [],
  },
  {
    ...BUILD, id: "cA", name: "C- 001", kind: "combined", parent_id: "brA",
    status: "saved", units: 2060, locations: 48, styles: 61,
    msrp_total: 145_755.53, ask_total: 43_732.5, slots: [],
  },
  { ...BUILD, id: "b5", name: "B- 010", kind: "lot", parent_id: "cA", status: "saved" },
  { ...BUILD, id: "b6", name: "B- 011", kind: "lot", parent_id: "cA", status: "saved" },
];

(window as any).__FIXTURE = (cmd: string, a: any) => {
  switch (cmd) {
    case "list_lot_sheets":
      return a?.includeArchived ? [...SHEETS, ...ARCHIVED] : SHEETS;
    case "rename_lot_sheet":
    case "archive_lot_sheet":
    case "rename_lot_build":
      return null;
    case "resync_lot_sheet":
      return 1140;
    case "lot_sheet_facets":
      return {
        brands: BRANDS.map(facet), categories: CATS.map(facet), segments: SEGS.map(facet),
        size_min: 0.5, size_max: 20, msrp_min: 4, msrp_max: 480,
        pool_slots: 7428, pool_units: 175_310, pool_msrp: 16_610_004,
      };
    case "rank_lot_slots": {
      const floor = a?.opts?.min_pct ?? 0;
      const all = Array.from({ length: 14 }, (_, i) => slot(i));
      const slots = all.filter((s) => s.pct >= floor);
      return {
        slots, matched_slots: slots.length ? 2449 : 0, pool_slots: 7428,
        matched_units: 44_563, matched_want_units: 12_865, matched_msrp: 4_294_402,
        tagalong_ratio: 2.46, rejected_by_allow: 1921, rejected_by_want: 402,
        rejected_by_size: 0, rejected_by_pct: all.length - slots.length,
        sort_note: "Sorted by concentration: the top 100 slots give 1,100 units of what you want.",
      };
    }
    case "plan_lot_builds": {
      const target = a?.plan?.target_units || 1000;
      const cap = a?.plan?.max_lots || 0;
      const nLots = cap > 0 ? Math.min(cap, 6) : 6;
      const lots = Array.from({ length: nLots }, (_, i) => planLot(i + 1, target));
      const total = lots.reduce((s, l) => s + l.units, 0);
      return {
        lots, total_units: total,
        total_want_units: lots.reduce((s, l) => s + l.want_units, 0),
        total_msrp: lots.reduce((s, l) => s + l.msrp, 0),
        leftover_slots: 812, leftover_units: 9_140,
        note: `${nLots} lots averaging ${Math.round(total / nLots)} units. A location is never split, so each lot lands a little over the target. 812 qualifying slots (9,140 units) are left over.`,
      };
    }
    case "save_lot_build":
      return { ...BUILD, id: "new" + Math.round((a?.pricePct ?? 0) * 1e6) };
    case "preview_lot_totals":
      // Honours the cost the screen passed, so the margin block can be exercised both ways.
      return { ...TOTALS, cost_known: (a?.costPct ?? 0) > 0 };
    case "list_lot_builds":
      // A live three-level tree: two loose base lots, a branch holding one combined lot,
      // and that combined lot's two children. Mutated in place by the tree cases below, so
      // combining and selling can actually be driven here rather than only compiled.
      return TREE;
    case "create_lot_branch": {
      const br = {
        ...BUILD, id: `br${TREE.length}`, name: String(a?.name ?? "Branch"),
        kind: "branch", parent_id: null, status: "saved",
        locations: 0, units: 0, styles: 0, msrp_total: 0, ask_total: 0, slots: [],
      };
      TREE.push(br);
      return br;
    }
    case "combine_lot_builds": {
      const ids: string[] = a?.childIds ?? [];
      const kids = TREE.filter((b: any) => ids.includes(b.id));
      const c = {
        ...BUILD, id: `c${TREE.length}`, name: String(a?.name ?? "Combined"),
        kind: "combined", parent_id: String(a?.branchId), status: "saved",
        price_pct: Number(a?.pricePct ?? 0.3), slots: [],
        locations: kids.reduce((t: number, k: any) => t + k.locations, 0),
        units: kids.reduce((t: number, k: any) => t + k.units, 0),
        styles: kids.reduce((t: number, k: any) => t + k.styles, 0),
        msrp_total: kids.reduce((t: number, k: any) => t + k.msrp_total, 0),
        ask_total: kids.reduce((t: number, k: any) => t + k.ask_total, 0),
      };
      kids.forEach((k: any) => { k.parent_id = c.id; });
      TREE.push(c);
      return c;
    }
    case "set_lot_parent": {
      const row = TREE.find((b: any) => b.id === a?.buildId);
      if (row) row.parent_id = a?.parentId ?? null;
      return null;
    }
    case "mark_lot_sold": {
      const want = a?.sold ? "sold" : "saved";
      const from = a?.sold ? "saved" : "sold";
      const ids = new Set<string>([String(a?.buildId)]);
      // Same cascade shape as the recursive CTE: keep sweeping until nothing new is added.
      for (let pass = 0; pass < 4; pass++) {
        TREE.forEach((b: any) => { if (b.parent_id && ids.has(b.parent_id)) ids.add(b.id); });
      }
      let n = 0;
      TREE.forEach((b: any) => {
        if (ids.has(b.id) && b.status === from) { b.status = want; n += 1; }
      });
      return n;
    }
    case "lot_roster_lines":
      return TREE.filter((b: any) =>
        a?.nodeId ? b.parent_id === a.nodeId : (b.kind ?? "lot") === "lot" && !b.parent_id,
      )
        .filter((b: any) => !b.archived && b.status === "saved")
        .map((b: any) => ({ reference: b.name, units: b.units, retail: b.msrp_total, sale: b.ask_total }));
    case "export_lot_roster":
      return { path: String(a?.path ?? "C:/roster.csv"), rows: 3, reconciled: true };
    case "lot_build_detail":
      return { build: BUILD, totals: TOTALS, location_codes: CODES };
    case "lot_build_location_codes":
      return CODES;
    case "export_lot_build":
      return { path: `C:/Users/Jack/Desktop/lot.${a?.format ?? "csv"}`, rows: 1806, reconciled: true };
    case "export_lot_conflicts":
      return { path: "C:/lot-engine/s1/barcode-conflicts.csv", rows: 4791, reconciled: true };
    case "lot_sheet_conflicts":
      return [{
        upc: "197968446084", grade: "split", units: 381, one_price: true,
        names: [
          { title: "New Balance 9060 Big Kid Shoes, Great Plains/Twilight Haze, Size 6.5", brand: "New Balance", units: 380, share: 0.997, locations: 12, msrp: 109.99 },
          { title: "New Balance 550 - Men's (Navy/Electric Sky) Size 12", brand: "New Balance", units: 1, share: 0.003, locations: 1, msrp: 109.99 },
        ],
      }];
    case "lot_sheet_products": {
      const q = String(a?.query || "").toLowerCase();
      const all = [
        { title: "Nike Air Max 90 Men's, White/Black, Size 10.5", upc: "196969506827", brand: "Nike", category: "Footwear", units: 1840, msrp: 129.99, overridden: false, locations: 41 },
        { title: "100289 - Odessa Leatherette Cap", upc: "195836916257", brand: "Carhartt", category: "Headwear", units: 2004, msrp: 16.99, overridden: true, locations: 1 },
        { title: "New Balance 9060 Big Kid Shoes, Great Plains/Twilight Haze, Size 6.5", upc: "197968446084", brand: "New Balance", category: "Footwear", units: 380, msrp: 0, overridden: false, locations: 12 },
      ];
      return all.filter((p) => !q || p.title.toLowerCase().includes(q) || p.upc.includes(q) || (p.brand || "").toLowerCase().includes(q));
    }
    case "set_lot_retail":
    case "set_lot_manifest_opts":
      return null;
    case "get_lot_manifest_opts":
      return {
        lot_name: "Lot", include_slots: false, show_check: false, show_upc: true,
        show_brand: true, show_category: true, show_segment: true, show_size: true,
        show_msrp: true, show_summary: true, show_by_category: true,
      };
    case "reprice_lot_build":
      return { ...BUILD, price_pct: a?.pricePct ?? 0.26, cost_pct: a?.costPct ?? 0 };
    case "lot_sheet_report":
      return {
        sheet: null,
        quality: { warnings: [], units_in: 179_672, units: 179_672, units_dropped: 0 },
        detection: null, report_text: "quality report", report_path: null, audit_map_path: null,
      };
    default:
      return null;
  }
};

// Mirrors App.tsx: a 216px sidebar, a full-height scroll pane, p-7, capped at 1280px. Keep
// this in step with App.tsx or the responsive breakpoints will look right here and wrong
// in the app.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen" style={{ background: "var(--t-bg)" }}>
    <aside style={{ width: 216, borderRight: "1px solid rgb(var(--c-line))" }} />
    <main className="flex-1 min-w-0">
      <div className="h-full overflow-auto">
        <div className="p-7">
          <div className="max-w-[1280px] mx-auto">
            <LotEngineView />
          </div>
        </div>
      </div>
    </main>
  </div>,
);
