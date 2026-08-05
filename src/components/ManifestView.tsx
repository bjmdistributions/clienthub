import { useEffect, useState } from "react";
import { api, ManifestAnalysis } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "./Toast";
import { Upload, Clipboard, ClipboardList, Plus, RotateCcw, Sparkles } from "lucide-react";

/**
 * Standalone manifest analyzer. Lifted out of the inventory view into its own section:
 * drop or upload a manifest in whatever form it arrived (CSV, TSV, Excel, or a
 * text-based PDF), see the itemized breakdown (units, product lines, per-category
 * and per-brand retail), get a suggested bid — then optionally send it to inventory as a
 * prefilled lot. The "send to inventory" handoff dispatches `inventory-prefill-lot` (with
 * the lot numbers AND a public manifest summary) and navigates to the inventory tab,
 * where the lot form opens prefilled.
 */

/** Every form a manifest turns up in. Anything else is rejected with a reason. */
const MANIFEST_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "pdf"];
const ACCEPTED = new RegExp(`\\.(${MANIFEST_EXTS.join("|")})$`, "i");

export default function ManifestView({ onNavigate }: { onNavigate: (t: any) => void }) {
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // Kept so a PDF the text-layer heuristic mis-read can be re-read through the AI
  // path without asking for the file again.
  const [lastPath, setLastPath] = useState<string | null>(null);

  const analyze = async (path: string, forceAi = false) => {
    setBusy(true);
    setLastPath(path);
    try { setManifest(await api.analyzeManifest(path, forceAi)); }
    catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  const upload = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: MANIFEST_EXTS }] });
    if (typeof f !== "string") return;
    analyze(f);
  };

  // Native file drag-drop onto the screen (Tauri webview) — the HTML5 drop event
  // gives a File with no path, and the analyzer reads from a path.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragActive(true);
      else if (p.type === "leave") setDragActive(false);
      else if (p.type === "drop") {
        setDragActive(false);
        const file = p.paths.find((path) => ACCEPTED.test(path));
        if (file) analyze(file);
        else if (p.paths.length) toast("That file can't be read as a manifest — drop a CSV, Excel, TSV or PDF.", "error");
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  const createLot = () => {
    if (!manifest) return;
    // Public-safe summary the storefront can render — internal retail/margin/bid excluded.
    const summary = {
      units: Math.round(manifest.total_quantity) || manifest.total_items || 0,
      lines: manifest.total_items || 0,
      categories: (manifest.categories || [])
        .filter((c) => c && c.name)
        .map((c) => ({ name: c.name, quantity: Math.round(c.quantity || 0) })),
    };
    window.dispatchEvent(new CustomEvent("inventory-prefill-lot", {
      detail: {
        quantity: Math.round(manifest.total_quantity) || manifest.total_items || 1,
        total_cost: manifest.suggested_bid || 0,
        price_type: "total",
        manifest: summary,
      },
    }));
    onNavigate("inventory");
  };

  const stats = manifest ? [
    { label: "Total units", value: Math.round(manifest.total_quantity || 0).toLocaleString() },
    { label: "Total retail", value: fmtAmount(manifest.total_retail) },
    { label: "Avg margin", value: `${manifest.overall_margin_pct.toFixed(0)}%` },
    { label: "Suggested bid", value: fmtAmount(manifest.suggested_bid) },
  ] : [];

  const d = manifest?.detection;
  // What was read as what. Shown because accepting every format is worthless if a
  // mis-detected price column is wrong in silence.
  const detected = d ? [
    d.sheet ? `Sheet ${d.sheet}` : null,
    d.header_row > 0 ? `Header on row ${d.header_row}` : null,
    d.description_col ? `Description = ${d.description_col}` : null,
    `Quantity = ${d.quantity_col ?? "none, 1 per line"}`,
    d.price_col ? `Price = ${d.price_col}${d.price_is_extended ? " (extended)" : ""}` : null,
    d.category_col ? `Category = ${d.category_col}` : null,
    d.brand_col ? `Brand = ${d.brand_col}` : null,
  ].filter(Boolean) as string[] : [];

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[20px] font-semibold text-ink flex items-center gap-2">
            <ClipboardList size={18} className="text-accent" /> Manifest analyzer
          </h1>
          <p className="text-[13px] text-muted mt-1 max-w-[560px]">
            Break down a manifest by its own categories and brands, count real units vs product lines,
            estimate margins, and calculate a suggested bid — then send it straight to inventory.
          </p>
        </div>
        {manifest && (
          <button onClick={upload} disabled={busy}
            className="shrink-0 flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors disabled:opacity-50">
            <RotateCcw size={13} /> {busy ? "Analyzing…" : "Analyze another"}
          </button>
        )}
      </div>

      {!manifest && (
        <button onClick={upload} disabled={busy}
          className={`w-full max-w-[640px] rounded-2xl border border-dashed bg-surface transition-colors py-14 px-6 flex flex-col items-center text-center disabled:opacity-60 ${
            dragActive ? "border-accent bg-surface-2" : "border-line-3 hover:border-accent hover:bg-surface-2"
          }`}>
          <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-4">
            <Upload size={20} className="text-accent" />
          </div>
          <p className="text-[15px] font-semibold text-ink">
            {busy ? "Analyzing…" : dragActive ? "Drop it here" : "Drop a manifest here, or click to browse"}
          </p>
          <p className="text-[12.5px] text-muted mt-1 max-w-[400px]">
            CSV, Excel, TSV or a text-based PDF. Include a quantity column for a true unit count.
            Category and brand columns get grouped automatically.
          </p>
        </button>
      )}

      {/* Dropping over a result replaces it — say so rather than swapping silently. */}
      {dragActive && manifest && (
        <div className="fixed inset-0 z-40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center">
            <p className="text-[15px] font-semibold text-ink">Drop to analyze this manifest</p>
            <p className="text-[12px] text-muted mt-1">It replaces the breakdown on screen.</p>
          </div>
        </div>
      )}

      {manifest && (
        <div className="max-w-[840px]">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {stats.map((s) => (
              <div key={s.label} className="bg-surface-2 rounded-lg px-3.5 py-3">
                <p className="text-[11.5px] font-medium text-muted">{s.label}</p>
                <p className="text-[17px] font-bold text-ink tabular-nums mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>

          {d && (
            <div className="bg-surface-2 rounded-lg px-3.5 py-3 mb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11.5px] font-medium text-ink-2">Read as {d.format}</p>
                  <p className="text-[11px] text-muted mt-1 leading-relaxed">{detected.join(" · ")}</p>
                </div>
                {d.format === "pdf" && lastPath && (
                  <button onClick={() => analyze(lastPath, true)} disabled={busy}
                    className="shrink-0 flex items-center gap-1.5 text-[11.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-2.5 h-8 rounded-lg transition-colors disabled:opacity-50">
                    <Sparkles size={12} /> Read it with AI instead
                  </button>
                )}
              </div>
              {d.note && <p className="text-[11px] text-warning-ink bg-warning-bg border border-warning rounded-md px-2.5 py-1.5 mt-2.5">{d.note}</p>}
            </div>
          )}

          <p className="text-[12px] text-muted mb-3">
            <span className="tabular-nums font-medium text-ink-2">{Math.round(manifest.total_quantity || 0).toLocaleString()}</span> units across{" "}
            <span className="tabular-nums font-medium text-ink-2">{manifest.total_items.toLocaleString()}</span> product line{manifest.total_items !== 1 ? "s" : ""}
            {manifest.skipped_rows > 0 ? ` · ${manifest.skipped_rows.toLocaleString()} skipped (no price)` : ""}.
          </p>
          <p className="text-[11px] text-muted mb-4 bg-warning-bg border border-warning px-3 py-2 rounded-lg">{manifest.formula}</p>

          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[12px] font-semibold text-ink-2">By category</p>
            <span className="text-[10px] text-muted">{manifest.categories_from_manifest ? "from manifest" : "estimated — no category column found"}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] mb-5">
              <thead className="bg-surface-2">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-muted rounded-l-lg">Category</th>
                  <th className="text-right px-3 py-2 font-medium text-muted">Lines</th>
                  <th className="text-right px-3 py-2 font-medium text-muted">Units</th>
                  <th className="text-right px-3 py-2 font-medium text-muted rounded-r-lg">Retail</th>
                </tr>
              </thead>
              <tbody>
                {manifest.categories.map((c) => (
                  <tr key={c.name} className="border-t border-line">
                    <td className="px-3 py-2 font-medium text-ink-2">{c.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{c.items.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{Math.round(c.quantity || 0).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(c.total_retail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {manifest.brands.length > 0 && (
            <>
              <p className="text-[12px] font-semibold text-ink-2 mb-1.5">By brand <span className="text-[10px] font-normal text-muted">from manifest</span></p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px] mb-5">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted rounded-l-lg">Brand</th>
                      <th className="text-right px-3 py-2 font-medium text-muted">Lines</th>
                      <th className="text-right px-3 py-2 font-medium text-muted">Units</th>
                      <th className="text-right px-3 py-2 font-medium text-muted rounded-r-lg">Retail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.brands.map((b) => (
                      <tr key={b.name} className="border-t border-line">
                        <td className="px-3 py-2 font-medium text-ink-2">{b.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{b.items.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-2">{Math.round(b.quantity || 0).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(b.total_retail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-line">
            <button onClick={createLot}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
              <Plus size={14} /> Create lot from this manifest
            </button>
            <button onClick={() => navigator.clipboard.writeText(manifest.suggested_bid.toString()).then(() => toast("Suggested bid copied — paste into your deal."))}
              className="text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors">
              <Clipboard size={12} /> Copy bid
            </button>
            <button onClick={() => setManifest(null)} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
