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
    units_per_pallet: 1440, unit_price: 6.5, notes: "", archived: false, created_at: NOW, updated_at: NOW, log: [],
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
