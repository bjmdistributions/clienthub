// DEV ONLY — the fixture behind r326-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL WarehouseView and InvoicesView inside the app's shell geometry (216px
// sidebar, p-7), switching between them on the same `navigate-tab` event App.tsx uses, so
// the packer's "Send to invoice" can be driven end to end. Every name and number is invented.
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import WarehouseView from "./components/WarehouseView";
import InvoicesView from "./components/InvoicesView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const NOW = new Date().toISOString();
const teams: [string, number][] = [
  ["New York Yankees", 64], ["Los Angeles Dodgers", 22], ["Boston Red Sox", 18], ["Chicago Cubs", 16],
  ["Atlanta Braves", 14], ["San Francisco Giants", 12], ["Houston Astros", 10], ["New York Mets", 4],
];
const ITEMS: any[] = [
  {
    id: "w1", name: "New Era 59FIFTY fitted hats", section_label: "Team",
    sections: teams.map(([name, boxes], i) => ({ id: `t${i}`, name, boxes, per_box: 24 })),
    boxes_per_pallet: 20, unit_price: 6.5, notes: "", archived: false, created_at: NOW, updated_at: NOW,
    log: [{ id: "m1", at: NOW, kind: "in", lines: teams.map(([name, boxes], i) => ({ section_id: `t${i}`, name, boxes, units: boxes * 24 })), reference: "", note: "", undone: false }],
  },
  {
    id: "w2", name: "Crew socks, 6 packs", section_label: "Size",
    sections: [{ id: "s1", name: "Small", boxes: 30, per_box: 48 }, { id: "s2", name: "Medium", boxes: 32, per_box: 48 }, { id: "s3", name: "Large", boxes: 28, per_box: 48 }],
    boxes_per_pallet: 36, unit_price: 2.1, notes: "", archived: false, created_at: NOW, updated_at: NOW, log: [],
  },
];

const clone = (x: any) => JSON.parse(JSON.stringify(x));
const handlers: Record<string, (a: any) => any> = {
  list_warehouse_items: () => clone(ITEMS),
  save_warehouse_item: ({ input }) => {
    const it = ITEMS.find((i) => i.id === input.id);
    const row = { ...(it || { id: `w${ITEMS.length + 1}`, log: [], archived: false, created_at: NOW }), ...input,
      sections: input.sections.map((s: any, i: number) => ({ ...s, id: s.id || `n${i}` })), updated_at: NOW };
    if (it) Object.assign(it, row); else ITEMS.push(row);
    return clone(row);
  },
  warehouse_adjust: ({ id, changes, reference, note }) => {
    const it = ITEMS.find((i) => i.id === id);
    const lines = changes.map((c: any) => {
      const s = it.sections.find((x: any) => x.id === c.section_id);
      s.boxes += c.boxes;
      return { section_id: s.id, name: s.name, boxes: c.boxes, units: c.boxes * s.per_box };
    });
    it.log.unshift({ id: `m${Math.random()}`, at: new Date().toISOString(), kind: "out", lines, reference: reference || "", note: note || "", undone: false });
    return { item: clone(it), short: [] };
  },
  list_clients: () => [{ id: "c1", name: "Harbour Goods" }, { id: "c2", name: "Cedar Lane Resale" }],
  create_invoice: () => "inv-new",
  get_invoice: () => ({ id: "inv-new", number: "INV-2041" }),
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) return Promise.resolve(handlers[cmd](args || {}));
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
