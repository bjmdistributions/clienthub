// DEV ONLY: the fixture behind r379-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL ManifestView (and its split section) inside the app's shell geometry
// (216px sidebar, p-7). The manifest is INVENTED (made-up lines, brands and prices), and
// every JSON in __r379-fixture was produced by the real manifest.rs / manifest_split.rs
// from that invented workbook. The plan does not re-run here: answers and edits are
// echoed onto the fixture so the controls can be driven, and the figures stay as Rust
// wrote them.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import ManifestView from "./components/ManifestView";
import InventoryView from "./components/InventoryView";
import { ToastHost } from "./components/Toast";
import analysis from "./__r379-fixture/analysis.json";
import plan from "./__r379-fixture/plan.json";
import lines from "./__r379-fixture/lines.json";
import exported from "./__r379-fixture/export.json";
import "./index.css";

const clone = (x: any) => JSON.parse(JSON.stringify(x));

const handlers: Record<string, (a: any) => any> = {
  analyze_manifest: () => clone(analysis),
  manifest_split_plan: ({ answers, edits }: any) => {
    const p = clone(plan);
    for (const q of p.questions) {
      if (answers?.[q.id]) { q.answer = answers[q.id]; q.answered = true; }
      if (answers?.[`${q.id}_value`] != null) q.value = parseFloat(answers[`${q.id}_value`]) || null;
    }
    for (const s of p.splits) {
      if (edits?.names?.[s.key]) s.name = edits.names[s.key];
      if (edits?.pricing?.[s.key]) s.rule = edits.pricing[s.key];
      s.skipped = (edits?.skip || []).includes(s.key);
    }
    p.splits = p.splits.filter((s: any) => !edits?.combine?.[s.key]);
    return p;
  },
  manifest_split_lines: () => clone(lines),
  manifest_split_export: () => clone(exported),
};

(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: any) => {
    (window as any).__calls = [...((window as any).__calls || []), { cmd, args }];
    if (handlers[cmd]) { try { return Promise.resolve(handlers[cmd](args || {})); } catch (e) { return Promise.reject(e); } }
    if (cmd === "plugin:dialog|open") return Promise.resolve(args?.options?.directory ? "C:/Invented/Splits" : "C:/Invented/Truckload 5512.xlsx");
    if (cmd === "plugin:event|listen") return Promise.resolve(1);
    if (cmd === "media_base_dir") return Promise.resolve("C:/Invented/media");
    if (cmd === "get_storefront_config") return Promise.resolve({ enabled: false, url: "" });
    return Promise.resolve(cmd.startsWith("list_") || cmd.endsWith("_all") ? [] : null);
  },
  transformCallback: (cb: any) => { (window as any).__cb = cb; return 1; },
  unregisterListener: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  plugins: {},
};

function Harness() {
  // The app mounts Inventory only while its tab is open, so the harness does the same.
  const [tab, setTab] = useState<"manifest" | "inventory">("manifest");
  return (
    <div className="flex h-screen bg-bg">
      <div className="w-[216px] flex-shrink-0 border-r border-line bg-surface p-3">
        <button onClick={() => setTab("manifest")} className="block text-[13px] text-ink-2">Manifest analyzer</button>
        <button onClick={() => setTab("inventory")} className="block text-[13px] text-ink-2 mt-1">Inventory</button>
      </div>
      <main className="flex-1 overflow-y-auto p-7 min-w-0">
        <div className="max-w-[1280px] mx-auto">
          {tab === "manifest" ? <ManifestView onNavigate={(t) => setTab(t)} /> : <InventoryView />}
        </div>
      </main>
      <ToastHost />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
