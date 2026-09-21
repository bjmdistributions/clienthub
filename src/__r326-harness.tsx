// DEV ONLY — the fixture behind r326-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL WarehouseView (and its import screen) and InvoicesView inside the app's
// shell geometry (216px sidebar, p-7), switching between them on the same `navigate-tab`
// event App.tsx uses, so the packer's "Send to invoice" can be driven end to end. The sheet
// in __r326-fixture/sheet.json is INVENTED — made-up teams and counts in the shape of a real
// grouped manifest — and its preview was produced by the real warehouse_core.rs reader.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import WarehouseView from "./components/WarehouseView";
import InvoicesView from "./components/InvoicesView";
import { ToastHost } from "./components/Toast";
import { takeUnits, type BoxType, type WhSection } from "./lib/warehouse";
import sheet from "./__r326-fixture/sheet.json";
import "./index.css";

const NOW = new Date().toISOString();
const clone = (x: any) => JSON.parse(JSON.stringify(x));
const preview = clone(sheet.preview) as { box_types: BoxType[]; sections: WhSection[] };

const ITEMS: any[] = [
  {
    id: "w1", name: "New Era 59FIFTY fitted hats", section_label: "Team", box_types: preview.box_types,
    sections: preview.sections.map((s, i) => ({ ...s, id: `t${i}` })),
    units_per_pallet: 1512, unit_price: 6.5, notes: "", archived: false, created_at: NOW, updated_at: NOW, log: [],
  },
  {
    id: "w2", name: "Crew socks, 6 packs", section_label: "Size", box_types: [{ id: "b48", name: "Case", per_box: 48 }],
    sections: [
      { id: "s1", name: "Small", counts: { b48: 30 }, loose: 0 },
      { id: "s2", name: "Medium", counts: { b48: 32 }, loose: 12 },
      { id: "s3", name: "Large", counts: { b48: 28 }, loose: 0 },
    ],
    units_per_pallet: 1728, unit_price: 2.1, notes: "", archived: false, created_at: NOW, updated_at: NOW, log: [],
  },
];

// An invented floor and rack, marked with the invented teams above.
const T = (i: number) => ({ item_id: "w1", section_id: `t${i}` });
const cellAt = (r: number, c: number, o: Record<string, any>) => ({ r, c, item_id: "", section_id: "", label: "", fill: 0, note: "", aisle: false, ...o });
const LAYOUTS: any[] = [
  {
    id: "L1", name: "Floor", kind: "pallets", rows: 5, cols: 9, notes: "", archived: false, created_at: NOW, updated_at: NOW,
    cells: [
      cellAt(0, 0, { ...T(0), fill: 4 }), cellAt(0, 1, { ...T(0), fill: 4 }), cellAt(0, 2, { ...T(0), fill: 3 }), cellAt(0, 3, { ...T(1), fill: 4 }),
      cellAt(0, 4, { ...T(1), fill: 2 }), cellAt(0, 5, { ...T(2), fill: 4 }), cellAt(0, 6, { ...T(3), fill: 1, note: "Top boxes crushed" }),
      ...Array.from({ length: 9 }, (_, c) => cellAt(2, c, { aisle: true })),
      cellAt(1, 0, { ...T(4), fill: 4 }), cellAt(1, 1, { ...T(5), fill: 2 }), cellAt(1, 2, { label: "Returns to sort", fill: 2 }),
      cellAt(3, 0, { ...T(6), fill: 4 }), cellAt(3, 1, { ...T(7), fill: 4 }), cellAt(3, 2, { ...T(8), fill: 3 }), cellAt(4, 0, { label: "Empty pallets", fill: 1 }),
      cellAt(4, 1, { ...T(9), fill: 0 }),
    ],
    // R-332/R-333: rows of different lengths, titles, doors, a short name, two shelves on the floor.
    shape: {
      row_lengths: [9, 7, 9, 6, 9], row_names: ["Back wall", "", "Drive lane", "", "Dock side"],
      doors: [
        { id: "d1", side: "bottom", at: 2, width: 2, kind: "garage", label: "Dock 1" },
        { id: "d2", side: "bottom", at: 6, width: 1, kind: "dock", label: "" },
        { id: "d3", side: "left", at: 3, width: 1, kind: "door", label: "Office" },
      ],
      short_names: { "s:w1:t0": "OWL" },
      shelves: {
        "3:4": { levels: [{ ...T(10), label: "", fill: 4 }, { ...T(11), label: "", fill: 2 }, { item_id: "", section_id: "", label: "Samples", fill: 1 }, { item_id: "", section_id: "", label: "", fill: 0 }], note: "" },
        "1:6": { levels: [{ ...T(2), label: "", fill: 3 }, { item_id: "", section_id: "", label: "", fill: 0 }, { ...T(0), label: "", fill: 4 }], note: "Top level is loose hats" },
        "4:8": { levels: [{ ...T(5), label: "", fill: 1 }, { ...T(6), label: "", fill: 1 }], note: "" },
      },
    },
    // R-340: boxes counted on some OWLS pallets (big = the first box size), one counted down to nothing.
    stock: {
      "0:0": { ...T(0), boxes: { [preview.box_types[0].id]: 8, [preview.box_types[1].id]: 2 } },
      "0:1": { ...T(0), boxes: { [preview.box_types[0].id]: 3 } },
      "0:2": { ...T(0), boxes: {} },
      // R-345: boxes on shelf levels, measured against a pallet too.
      "3:4:0": { ...T(10), boxes: { [preview.box_types[0].id]: 7 } },
      "1:6:0": { ...T(2), boxes: { [preview.box_types[0].id]: 5 } },
      "4:8:0": { ...T(5), boxes: { [preview.box_types[0].id]: 12, [preview.box_types[1].id]: 4 } },
      "4:8:1": { ...T(6), boxes: { [preview.box_types[0].id]: 21 } },
    },
  },
  {
    id: "L2", name: "Rack A", kind: "shelving", rows: 4, cols: 6, notes: "", archived: false, created_at: NOW, updated_at: NOW,
    cells: [cellAt(3, 0, { ...T(9), fill: 4 }), cellAt(3, 1, { ...T(10), fill: 2 }), cellAt(2, 0, { ...T(11), fill: 3 }), cellAt(0, 5, { label: "Samples", fill: 1 })],
    shape: { row_lengths: [], row_names: [], doors: [], short_names: {}, shelves: {} },
  },
  {
    id: "L3", name: "Test map", kind: "pallets", rows: 2, cols: 3, notes: "", archived: false, created_at: NOW, updated_at: NOW,
    cells: [], shape: { row_lengths: [], row_names: [], doors: [], short_names: {}, shelves: {} },
  },
];

const per = (it: any, t: string) => (it.box_types.find((x: BoxType) => x.id === t)?.per_box ?? 0);
const units = (it: any, s: WhSection) => Object.entries(s.counts).reduce((a, [t, n]) => a + (n as number) * per(it, t), 0) + (s.loose || 0);

const handlers: Record<string, (a: any) => any> = {
  list_warehouse_items: () => clone(ITEMS),
  save_warehouse_item: ({ input }) => {
    const it = ITEMS.find((i) => i.id === input.id);
    const row = { ...(it || { id: `w${ITEMS.length + 1}`, log: [], archived: false, created_at: NOW }), ...input, updated_at: NOW };
    if (it) Object.assign(it, row); else ITEMS.push(row);
    return clone(row);
  },
  warehouse_adjust: ({ id, changes, reference, note }) => {
    const it = ITEMS.find((i) => i.id === id);
    const lines = (changes || []).map((c: any) => {
      const s = it.sections.find((x: WhSection) => x.id === c.section_id);
      const before = units(it, s);
      for (const [t, n] of Object.entries(c.boxes || {})) s.counts[t] = (s.counts[t] || 0) + (n as number);
      if (c.loose < 0) {
        s.loose += c.loose;
        while (s.loose < 0) {
          const t = [...it.box_types].sort((a: BoxType, b: BoxType) => a.per_box - b.per_box).find((x: BoxType) => (s.counts[x.id] || 0) > 0);
          if (!t) break;
          s.counts[t.id] -= 1; s.loose += t.per_box;
        }
      }
      if (c.units < 0) takeUnits(it.box_types, s, -c.units);
      return { section_id: s.id, name: s.name, boxes: c.boxes || {}, loose: c.loose || 0, opened: {}, units: units(it, s) - before };
    });
    it.log.unshift({ id: `m${it.log.length + 1}`, at: new Date().toISOString(), kind: "out", lines, reference: reference || "", note: note || "", undone: false });
    return { item: clone(it), short: [] };
  },
  list_warehouse_layouts: () => clone(LAYOUTS),
  save_warehouse_layout: ({ input }) => {
    const l = LAYOUTS.find((x) => x.id === input.id);
    const row = { ...(l || { id: `L${LAYOUTS.length + 1}`, archived: false, created_at: NOW }), ...input, updated_at: NOW };
    if (l) Object.assign(l, row); else LAYOUTS.push(row);
    return clone(row);
  },
  set_warehouse_place_stock: ({ layoutId, place, itemId, sectionId, boxes, add }) => {
    const l = LAYOUTS.find((x) => x.id === layoutId);
    const cur: Record<string, number> = { ...((l.stock || {})[place]?.boxes || {}) };
    for (const [t, n] of Object.entries(boxes || {})) cur[t] = n as number;
    for (const [t, d] of Object.entries(add || {})) cur[t] = Math.max(0, (cur[t] || 0) + (d as number));
    l.stock = { ...(l.stock || {}), [place]: { item_id: itemId, section_id: sectionId, boxes: Object.fromEntries(Object.entries(cur).filter(([, n]) => n > 0)) } };
    return clone(l);
  },
  archive_warehouse_layout: ({ id, archived }) => { const l = LAYOUTS.find((x) => x.id === id); if (l) l.archived = archived; return null; },
  warehouse_read_sheet: () => ({ rows: sheet.rows, sheet_name: "Sheet1", note: null, guess: sheet.guess }),
  warehouse_guess: () => sheet.guess,
  warehouse_import_preview: () => clone(sheet.preview),
  warehouse_import: ({ name, sectionLabel }) => {
    const row = { ...clone(ITEMS[0]), id: `w${ITEMS.length + 1}`, name: name || "Imported", section_label: sectionLabel || "Team", log: [] };
    ITEMS.push(row);
    return clone(row);
  },
  list_clients: () => [{ id: "c1", name: "Harbour Goods" }, { id: "c2", name: "Cedar Lane Resale" }],
  create_invoice: () => "inv-new",
  get_invoice: () => ({ id: "inv-new", number: "INV-2041" }),
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) return Promise.resolve(handlers[cmd](args || {}));
    if (cmd === "plugin:dialog|open") return Promise.resolve("C:/stock/Invented manifest.csv");
    return Promise.resolve(cmd.startsWith("list_") || cmd.endsWith("_all") ? [] : null);
  },
  transformCallback: (cb: any) => { (window as any).__cb = cb; return 1; },
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

function Harness() {
  const [tab, setTab] = useState<"warehouse" | "invoices">("warehouse");
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (d === "invoices" || d === "warehouse") setTab(d); };
    window.addEventListener("navigate-tab", on);
    return () => window.removeEventListener("navigate-tab", on);
  }, []);
  return (
    <div className="flex h-screen bg-bg">
      <div className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3 space-y-1">
        <button onClick={() => setTab("warehouse")} className="block text-[13px] text-ink-2">Warehouse</button>
        <button onClick={() => setTab("invoices")} className="block text-[13px] text-ink-2">Invoices</button>
      </div>
      <main className="flex-1 overflow-y-auto p-7 min-w-0">
        <div className="max-w-[1280px] mx-auto">{tab === "warehouse" ? <WarehouseView /> : <InvoicesView />}</div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
