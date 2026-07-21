import { useState } from "react";
import { api, ManifestAnalysis } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./Toast";
import { Upload, Clipboard, ClipboardList, Plus, RotateCcw } from "lucide-react";

/**
 * Standalone manifest analyzer. Lifted out of the inventory view into its own section:
 * upload a manifest CSV, see the itemized breakdown (units, product lines, per-category
 * and per-brand retail), get a suggested bid — then optionally send it to inventory as a
 * prefilled lot. The "send to inventory" handoff dispatches `inventory-prefill-lot` (with
 * the lot numbers AND a public manifest summary) and navigates to the inventory tab,
 * where the lot form opens prefilled.
 */
export default function ManifestView({ onNavigate }: { onNavigate: (t: any) => void }) {
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest CSV", extensions: ["csv"] }] });
    if (typeof f !== "string") return;
    setBusy(true);
    try { setManifest(await api.analyzeManifest(f)); }
    catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

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
          className="w-full max-w-[640px] rounded-2xl border border-dashed border-line-3 hover:border-accent bg-surface hover:bg-surface-2 transition-colors py-14 px-6 flex flex-col items-center text-center disabled:opacity-60">
          <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-4">
            <Upload size={20} className="text-accent" />
          </div>
          <p className="text-[15px] font-semibold text-ink">{busy ? "Analyzing…" : "Upload a manifest CSV"}</p>
          <p className="text-[12.5px] text-muted mt-1 max-w-[380px]">
            Include a quantity column for a true unit count. Category and brand columns get grouped automatically.
          </p>
        </button>
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
