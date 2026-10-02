import { useEffect, useMemo, useState } from "react";
import { api, ManifestAnalysis, ManifestLine } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "./Toast";
import { Upload, Clipboard, ClipboardList, Layers, Plus, RotateCcw } from "lucide-react";
import ManifestSplit from "./ManifestSplit";
import StatusPill from "./StatusPill";

/**
 * Standalone manifest analyzer (rebuilt for R-430). Every figure on it comes from the file
 * or from a number Jack typed: what is in the load (lines, units, retail, retail per unit),
 * how the sheet prices itself and what that is per unit across every unit, where the
 * retail sits (top lines, brands, price bands), what to check (outliers, no retail,
 * repeats, condition), and every line, searchable. The bid is his own resale % per
 * category less his target margin, never an average dressed up as a suggestion, and
 * nothing is read by AI. "Create lot" fills the lot's cost with the asking price he
 * confirms, or leaves it blank.
 */

/** Every form a manifest turns up in. Anything else is rejected with a reason. */
const MANIFEST_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "pdf"];
const ACCEPTED = new RegExp(`\\.(${MANIFEST_EXTS.join("|")})$`, "i");

/** Jack's resale %s and target margin: per device, kept between manifests. */
const SETTINGS_KEY = "manifest_resale_v1";
type ResaleSettings = { pct: string; margin: string; cats: Record<string, string> };
const loadSettings = (): ResaleSettings => {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { pct: s.pct ?? "", margin: s.margin ?? "", cats: s.cats ?? {} };
  } catch { return { pct: "", margin: "", cats: {} }; }
};

const num = (s: string): number | null => {
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fmtInt = (n: number) => Math.round(n || 0).toLocaleString();
const fmtPct = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;
const unitOf = (l: ManifestLine) => (l.qty > 0 ? l.retail / l.qty : 0);

const BANDS: [string, number, number][] = [
  ["Under $10", 0, 10], ["$10 to $25", 10, 25], ["$25 to $50", 25, 50],
  ["$50 to $100", 50, 100], ["$100 to $250", 100, 250], ["$250 and up", 250, Infinity],
];

/** What the sheet itself charges for the load, and how it says so. */
function sheetAsk(m: ManifestAnalysis): number | null {
  const p = m.sheet_pricing;
  if (!p) return null;
  if (p.total != null && p.total > 0) return p.total;
  if (p.kind === "pct" && p.pct != null) return m.total_retail * p.pct / 100;
  if (p.kind === "unit" && p.unit != null) return p.unit * m.total_quantity;
  return null;
}

/** Lines the sheet's price covers: its own line prices, else every line its rule can price. */
function pricedLines(m: ManifestAnalysis): number {
  const own = m.lines.filter((l) => l.sheet_price != null).length;
  if (own) return own;
  return m.sheet_pricing?.kind === "pct" ? m.lines.filter((l) => l.retail > 0).length : m.lines.length;
}

function facts(m: ManifestAnalysis) {
  const lines = m.lines || [];
  const retail = m.total_retail;
  const byRetail = [...lines].sort((a, b) => b.retail - a.retail);
  const top10 = byRetail.slice(0, 10).reduce((s, l) => s + l.retail, 0);
  const priced = lines.filter((l) => l.retail > 0);
  const units = priced.map(unitOf).sort((a, b) => a - b);
  const median = units.length ? units[Math.floor(units.length / 2)] : 0;
  const outliers = priced.filter((l) => unitOf(l) >= Math.max(100, median * 10)).sort((a, b) => unitOf(b) - unitOf(a));
  const bands = BANDS.map(([name, lo, hi]) => {
    const ls = priced.filter((l) => unitOf(l) >= lo && unitOf(l) < hi);
    return { name, lines: ls.length, units: ls.reduce((s, l) => s + l.qty, 0), retail: ls.reduce((s, l) => s + l.retail, 0) };
  }).filter((b) => b.lines > 0);
  const seen = new Map<string, ManifestLine[]>();
  for (const l of lines) {
    const k = `${l.title.trim().toLowerCase()}|${l.code}`;
    seen.set(k, [...(seen.get(k) || []), l]);
  }
  const repeats = [...seen.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  const conditions = new Map<string, { units: number; retail: number; lines: number }>();
  if (m.detection.condition_col) {
    for (const l of lines) {
      const k = l.condition || "Not stated";
      const c = conditions.get(k) || { units: 0, retail: 0, lines: 0 };
      conditions.set(k, { units: c.units + l.qty, retail: c.retail + l.retail, lines: c.lines + 1 });
    }
  }
  const guessedByCat = new Map<string, number>();
  for (const l of lines) if (l.guessed) guessedByCat.set(l.category, (guessedByCat.get(l.category) || 0) + 1);
  const topBrand = m.brands.find((b) => b.name !== "Unbranded");
  return {
    top10Share: retail > 0 ? top10 / retail : 0,
    topLines: byRetail.slice(0, 10),
    topBrand, topBrandShare: topBrand && retail > 0 ? topBrand.total_retail / retail : 0,
    median, outliers, bands, repeats,
    conditions: [...conditions.entries()].sort((a, b) => b[1].retail - a[1].retail),
    noRetail: lines.filter((l) => l.retail <= 0),
    guessedByCat,
  };
}

export default function ManifestView({ onNavigate }: { onNavigate: (t: any) => void }) {
  const [manifest, setManifest] = useState<ManifestAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [lastPath, setLastPath] = useState<string | null>(null);
  // R-379: the split section under the breakdown, opened on request.
  const [splitOpen, setSplitOpen] = useState(false);
  const [settings, setSettings] = useState<ResaleSettings>(loadSettings);
  // What the supplier is asking: the sheet's own price when it states one, editable.
  const [ask, setAsk] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"retail" | "unit" | "qty" | "row">("retail");
  const [limit, setLimit] = useState(100);

  const saveSettings = (s: ResaleSettings) => {
    setSettings(s);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* the figures still work this session */ }
  };

  const analyze = async (path: string) => {
    setBusy(true);
    setLastPath(path);
    try {
      const m = await api.analyzeManifest(path);
      setManifest(m);
      const a = sheetAsk(m);
      setAsk(a != null ? a.toFixed(2) : "");
      setQuery(""); setLimit(100); setSplitOpen(false);
    } catch (e: any) { toast(String(e), "error"); }
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
        else if (p.paths.length) toast("That file can't be read as a manifest. Drop a CSV, Excel, TSV or PDF.", "error");
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  const f = useMemo(() => (manifest ? facts(manifest) : null), [manifest]);
  const sheetPrice = manifest ? sheetAsk(manifest) : null;

  // The bid: each category's retail at Jack's resale %, less his target margin.
  const bid = useMemo(() => {
    if (!manifest) return null;
    const rows = manifest.categories.map((c) => {
      const pct = num(settings.cats[c.name] ?? "") ?? num(settings.pct);
      return { ...c, pct, resale: pct != null ? c.total_retail * pct / 100 : null };
    });
    const set = rows.filter((r) => r.resale != null);
    const resale = set.reduce((s, r) => s + (r.resale || 0), 0);
    const missing = rows.filter((r) => r.resale == null && r.total_retail > 0);
    const margin = num(settings.margin);
    const max = set.length && margin != null && margin < 100 ? resale * (1 - margin / 100) : null;
    const askN = num(ask);
    return { rows, resale: set.length ? resale : null, missing, margin, max, ask: askN };
  }, [manifest, settings, ask]);

  const shownLines = useMemo(() => {
    if (!manifest) return [];
    const q = query.trim().toLowerCase();
    const ls = (manifest.lines || []).filter((l) => !q || [l.title, l.brand || "", l.category, l.code, l.condition].some((v) => v.toLowerCase().includes(q)));
    const key = { retail: (l: ManifestLine) => -l.retail, unit: (l: ManifestLine) => -unitOf(l), qty: (l: ManifestLine) => -l.qty, row: (l: ManifestLine) => l.row }[sort];
    return ls.sort((a, b) => key(a) - key(b));
  }, [manifest, query, sort]);

  const createLot = () => {
    if (!manifest) return;
    // Public-safe summary the storefront can render — internal retail and cost excluded.
    const summary = {
      units: Math.round(manifest.total_quantity) || manifest.total_items || 0,
      lines: manifest.total_items || 0,
      // "Uncategorized" says nothing to a buyer, so it stays off the storefront.
      categories: (manifest.categories || [])
        .filter((c) => c && c.name && c.name !== "Uncategorized")
        .map((c) => ({ name: c.name, quantity: Math.round(c.quantity || 0) })),
    };
    const cost = num(ask) ?? 0;
    const detail = {
      quantity: Math.round(manifest.total_quantity) || manifest.total_items || 1,
      total_cost: cost,
      price_type: "total",
      manifest: summary,
    };
    if (!cost) toast("No asking price entered, so the lot's cost is left blank.");
    // Inventory is not mounted until the tab switch, so it picks this up from here.
    sessionStorage.setItem("inventory_prefill_lot", JSON.stringify(detail));
    window.dispatchEvent(new CustomEvent("inventory-prefill-lot", { detail }));
    onNavigate("inventory");
  };

  const d = manifest?.detection;
  // What was read as what, so a wrong column is never wrong in silence.
  const detected = d ? [
    d.sheet ? `Sheet ${d.sheet}` : null,
    d.header_row > 0 ? `Header on row ${d.header_row}` : null,
    d.description_col ? `Description = ${d.description_col}` : null,
    `Quantity = ${d.quantity_col ?? "none, 1 per line"}`,
    d.price_col ? `Retail = ${d.price_col}${d.price_is_extended ? " (extended)" : ""}` : null,
    d.category_col ? `Category = ${d.category_col}` : null,
    d.brand_col ? `Brand = ${d.brand_col}` : null,
    d.code_col ? `Code = ${d.code_col}` : null,
    d.condition_col ? `Condition = ${d.condition_col}` : null,
  ].filter(Boolean) as string[] : [];

  const card = "bg-surface-2 rounded-lg px-3.5 py-3";
  const h2 = "text-[13px] font-semibold text-ink mb-2";
  const input = "h-8 px-2.5 rounded-lg border border-line-3 bg-surface text-[12.5px] tabular-nums outline-none focus:border-accent";
  const th = "px-3 py-2 font-medium text-muted";
  const thL = "px-2 py-2 font-medium text-muted";
  const units = manifest?.total_quantity || 0;
  const hasSheetPrice = !!manifest?.lines?.some((l) => l.sheet_price != null);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[20px] font-semibold text-ink flex items-center gap-2">
            <ClipboardList size={18} className="text-accent" /> Manifest analyzer
          </h1>
          <p className="text-[13px] text-muted mt-1 max-w-[560px]">
            What is in a load, what the sheet charges for it per unit, and what you can pay at your own resale rates.
            Every figure comes from the file or from a number you set.
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

      {manifest && f && bid && d && (
        <div className="max-w-[1120px] min-w-0 space-y-6">
          {/* What is in it */}
          <section>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                ["Units", fmtInt(units)],
                ["Product lines", fmtInt(manifest.total_items)],
                ["Total retail", fmtAmount(manifest.total_retail)],
                ["Retail per unit", units > 0 ? fmtAmount(manifest.total_retail / units) : "-"],
              ].map(([l, v]) => (
                <div key={l} className={card}>
                  <p className="text-[11.5px] font-medium text-muted">{l}</p>
                  <p className="text-[17px] font-bold text-ink tabular-nums mt-0.5">{v}</p>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-muted mt-2">
              {manifest.unpriced_lines > 0 ? `${fmtInt(manifest.unpriced_lines)} line${manifest.unpriced_lines !== 1 ? "s have" : " has"} no retail value and count in units only. ` : ""}
              {manifest.skipped_note || (manifest.skipped_rows > 0 ? `${fmtInt(manifest.skipped_rows)} rows left out.` : "")}
            </p>
          </section>

          {/* The sheet's own pricing */}
          <section className={card}>
            <p className={h2}>The sheet's price</p>
            {sheetPrice != null ? (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    ["For the load", fmtAmount(sheetPrice)],
                    ["Per unit, across all units", units > 0 ? fmtAmount(sheetPrice / units) : "-"],
                    ["Of retail", manifest.total_retail > 0 ? fmtPct(sheetPrice / manifest.total_retail) : "-"],
                    ["Lines with a price", `${fmtInt(pricedLines(manifest))} of ${fmtInt(manifest.total_items)}`],
                  ].map(([l, v]) => (
                    <div key={l}>
                      <p className="text-[11.5px] text-muted">{l}</p>
                      <p className="text-[15px] font-semibold text-ink tabular-nums">{v}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[11.5px] text-muted mt-2">Read from the sheet: {manifest.sheet_pricing?.evidence}.</p>
              </>
            ) : (
              <p className="text-[12.5px] text-ink-2">
                {manifest.sheet_pricing ? "The sheet shows retail only. It states no price for the load." : "A PDF's price is not read. Type the asking price below."}
              </p>
            )}
          </section>

          {/* What you can pay */}
          <section className={card}>
            <p className={h2}>What you can pay</p>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-[11.5px] text-muted">
                <span className="block mb-1">You resell at (% of retail)</span>
                <input className={`${input} w-28`} value={settings.pct} placeholder="e.g. 30"
                  onChange={(e) => saveSettings({ ...settings, pct: e.target.value })} />
              </label>
              <label className="text-[11.5px] text-muted">
                <span className="block mb-1">Your target margin (%)</span>
                <input className={`${input} w-28`} value={settings.margin} placeholder="e.g. 25"
                  onChange={(e) => saveSettings({ ...settings, margin: e.target.value })} />
              </label>
              <label className="text-[11.5px] text-muted">
                <span className="block mb-1">Asking price for the load</span>
                <input className={`${input} w-36`} value={ask} placeholder="$"
                  onChange={(e) => setAsk(e.target.value)} />
              </label>
              {manifest.overall_margin_pct > 0 && (
                <p className="text-[11.5px] text-muted pb-2">Your completed deals average a {manifest.overall_margin_pct.toFixed(0)}% margin.</p>
              )}
            </div>
            {bid.resale == null ? (
              <p className="text-[12.5px] text-ink-2 mt-3">Set the % of retail you resell at, here or per category below, to see what this load is worth to you.</p>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                <div>
                  <p className="text-[11.5px] text-muted">You'd resell it for</p>
                  <p className="text-[15px] font-semibold text-ink tabular-nums">{fmtAmount(bid.resale)}</p>
                </div>
                <div>
                  <p className="text-[11.5px] text-muted">Most you can pay</p>
                  <p className="text-[15px] font-semibold text-ink tabular-nums">{bid.max != null ? fmtAmount(bid.max) : "Set a margin"}</p>
                </div>
                <div>
                  <p className="text-[11.5px] text-muted">Most per unit</p>
                  <p className="text-[15px] font-semibold text-ink tabular-nums">{bid.max != null && units > 0 ? fmtAmount(bid.max / units) : "-"}</p>
                </div>
                <div>
                  <p className="text-[11.5px] text-muted">At the asking price</p>
                  {bid.ask != null && bid.ask > 0 ? (() => {
                    const profit = bid.resale - bid.ask;
                    return (
                      <p className={`text-[15px] font-semibold tabular-nums ${profit >= 0 && (bid.max == null || bid.ask <= bid.max) ? "text-success-ink" : "text-danger-ink"}`}>
                        {fmtAmount(profit)} <span className="text-[12px] font-medium">({bid.resale > 0 ? fmtPct(profit / bid.resale) : "-"} margin)</span>
                      </p>
                    );
                  })() : <p className="text-[15px] font-semibold text-muted">No asking price</p>}
                </div>
              </div>
            )}
            {bid.max != null && bid.ask != null && bid.ask > 0 && (
              <p className="text-[12px] text-ink-2 mt-2">
                {bid.ask <= bid.max
                  ? `The ask is ${fmtAmount(bid.max - bid.ask)} under the most you can pay.`
                  : `The ask is ${fmtAmount(bid.ask - bid.max)} over the most you can pay.`}
              </p>
            )}
            {bid.resale != null && bid.missing.length > 0 && (
              <p className="text-[11.5px] text-warning-ink mt-2">
                No resale % for {bid.missing.map((c) => c.name).join(", ")}, so {fmtAmount(bid.missing.reduce((s, c) => s + c.total_retail, 0))} of retail is not counted.
              </p>
            )}
          </section>

          {/* By category */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <p className={h2 + " mb-0"}>By category</p>
              <span className="text-[11px] text-muted">
                {manifest.categories_from_manifest
                  ? manifest.categories_guessed > 0 ? `from the sheet, ${fmtInt(manifest.categories_guessed)} line${manifest.categories_guessed !== 1 ? "s" : ""} guessed from titles` : "from the sheet"
                  : "guessed from the titles"}
              </span>
            </div>
            {manifest.uncategorized_lines > 0 && (() => {
              const share = manifest.total_retail > 0 ? manifest.uncategorized_retail / manifest.total_retail : manifest.uncategorized_lines / Math.max(1, manifest.total_items);
              return (
                <p className={`text-[11.5px] mb-2 px-3 py-2 rounded-lg ${share > 0.1 ? "text-warning-ink bg-warning-bg border border-warning" : "text-muted bg-surface-2"}`}>
                  {fmtInt(manifest.uncategorized_lines)} of {fmtInt(manifest.total_items)} lines ({Math.round(share * 100)}% of retail) could not be placed in a category.
                </p>
              );
            })()}
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead className="bg-surface-2">
                  <tr>
                    <th className={`${th} text-left rounded-l-lg`}>Category</th>
                    <th className={`${th} text-right`}>Lines</th>
                    <th className={`${th} text-right`}>Units</th>
                    <th className={`${th} text-right`}>Retail</th>
                    <th className={`${th} text-right`}>Retail per unit</th>
                    <th className={`${th} text-right`}>Resale %</th>
                    <th className={`${th} text-right rounded-r-lg`}>You'd resell for</th>
                  </tr>
                </thead>
                <tbody>
                  {bid.rows.map((c) => {
                    const guessed = f.guessedByCat.get(c.name) || 0;
                    return (
                      <tr key={c.name} className="border-t border-line">
                        <td className="px-3 py-2 font-medium text-ink-2">
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            {c.name}
                            {guessed > 0 && c.name !== "Uncategorized" && (
                              <StatusPill title="Read from the product titles, not a category column on the sheet">{guessed === c.items ? "Guessed" : `${fmtInt(guessed)} guessed`}</StatusPill>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(c.items)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtInt(c.quantity)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(c.total_retail)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-2">{c.quantity > 0 && c.total_retail > 0 ? fmtAmount(c.total_retail / c.quantity) : "-"}</td>
                        <td className="px-3 py-1.5 text-right">
                          <input className={`${input} w-20 h-7 text-right`} value={settings.cats[c.name] ?? ""} placeholder={settings.pct || "%"}
                            onChange={(e) => {
                              const cats = { ...settings.cats };
                              if (e.target.value.trim()) cats[c.name] = e.target.value; else delete cats[c.name];
                              saveSettings({ ...settings, cats });
                            }} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.resale != null ? fmtAmount(c.resale) : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Where the retail sits */}
          <section className="grid lg:grid-cols-2 gap-4">
            <div className={card}>
              <p className={h2}>Where the retail sits</p>
              <ul className="text-[12.5px] text-ink-2 space-y-1">
                <li>The top 10 lines hold <span className="font-semibold text-ink tabular-nums">{fmtPct(f.top10Share)}</span> of the retail.</li>
                {f.topBrand && <li>{f.topBrand.name} is the biggest brand at <span className="font-semibold text-ink tabular-nums">{fmtPct(f.topBrandShare)}</span> of the retail.</li>}
                <li>Half the priced lines retail under <span className="font-semibold text-ink tabular-nums">{fmtAmount(f.median)}</span> a unit.</li>
              </ul>
              <table className="w-full text-[12px] mt-3">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left font-medium py-1">Retail per unit</th>
                    <th className="text-right font-medium py-1">Lines</th>
                    <th className="text-right font-medium py-1">Units</th>
                    <th className="text-right font-medium py-1">Retail</th>
                  </tr>
                </thead>
                <tbody>
                  {f.bands.map((b) => (
                    <tr key={b.name} className="border-t border-line">
                      <td className="py-1.5 text-ink-2">{b.name}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted">{fmtInt(b.lines)}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink-2">{fmtInt(b.units)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtAmount(b.retail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={card}>
              <p className={h2}>Biggest lines</p>
              <table className="w-full text-[12px]">
                <tbody>
                  {f.topLines.map((l, i) => (
                    <tr key={i} className="border-t border-line first:border-t-0">
                      <td className="py-1.5 pr-2 text-ink-2" title={l.title}><div className="truncate max-w-[150px] xl:max-w-[280px]">{l.title}</div></td>
                      <td className="py-1.5 text-right tabular-nums text-muted whitespace-nowrap">{fmtInt(l.qty)} x {fmtAmount(unitOf(l))}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums font-medium">{fmtAmount(l.retail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* By brand */}
          {manifest.brands.length > 0 && (
            <section>
              <p className={h2}>By brand <span className="text-[11px] font-normal text-muted">{manifest.brands_from_titles ? (d.brand_col ? "from the sheet, the rest read from titles" : "read from the titles") : "from the sheet"}</span></p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className={`${th} text-left rounded-l-lg`}>Brand</th>
                      <th className={`${th} text-right`}>Lines</th>
                      <th className={`${th} text-right`}>Units</th>
                      <th className={`${th} text-right`}>Retail</th>
                      <th className={`${th} text-right`}>Retail per unit</th>
                      <th className={`${th} text-right rounded-r-lg`}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.brands.map((b) => (
                      <tr key={b.name} className="border-t border-line">
                        <td className="px-3 py-2 font-medium text-ink-2">{b.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(b.items)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtInt(b.quantity)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(b.total_retail)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-2">{b.quantity > 0 && b.total_retail > 0 ? fmtAmount(b.total_retail / b.quantity) : "-"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{manifest.total_retail > 0 ? fmtPct(b.total_retail / manifest.total_retail) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Check these */}
          <section className={card}>
            <p className={h2}>Check these</p>
            <div className="space-y-3 text-[12.5px] text-ink-2">
              {f.outliers.length > 0 && (
                <div>
                  <p className="font-medium text-ink">{fmtInt(f.outliers.length)} line{f.outliers.length !== 1 ? "s retail" : " retails"} at 10 times the typical unit or more</p>
                  <ul className="mt-1 space-y-0.5">
                    {f.outliers.slice(0, 8).map((l, i) => (
                      <li key={i} className="flex justify-between gap-3"><span className="truncate" title={l.title}>{l.row > 0 ? `Row ${l.row}: ` : ""}{l.title}</span><span className="tabular-nums whitespace-nowrap">{fmtAmount(unitOf(l))} a unit</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {f.noRetail.length > 0 && (
                <div>
                  <p className="font-medium text-ink">{fmtInt(f.noRetail.length)} line{f.noRetail.length !== 1 ? "s have" : " has"} no retail ({fmtInt(f.noRetail.reduce((s, l) => s + l.qty, 0))} units)</p>
                  <p className="text-muted truncate">{f.noRetail.slice(0, 5).map((l) => l.title).join(", ")}</p>
                </div>
              )}
              {f.repeats.length > 0 && (
                <div>
                  <p className="font-medium text-ink">{fmtInt(f.repeats.length)} title{f.repeats.length !== 1 ? "s appear" : " appears"} on more than one line</p>
                  <ul className="mt-1 space-y-0.5">
                    {f.repeats.slice(0, 6).map((g, i) => (
                      <li key={i} className="flex justify-between gap-3"><span className="truncate" title={g[0].title}>{g[0].title}</span><span className="tabular-nums whitespace-nowrap text-muted">{g.length} lines, rows {g.map((l) => l.row).join(", ")}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {f.conditions.length > 0 && (
                <div>
                  <p className="font-medium text-ink">Condition</p>
                  <ul className="mt-1 space-y-0.5">
                    {f.conditions.map(([name, c]) => (
                      <li key={name} className="flex justify-between gap-3"><span>{name}</span><span className="tabular-nums text-muted">{fmtInt(c.units)} units, {fmtAmount(c.retail)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {!f.outliers.length && !f.noRetail.length && !f.repeats.length && (
                <p className="text-muted">Nothing stood out: every line has a retail value, no title repeats, and no unit retail is far off the rest.</p>
              )}
            </div>
          </section>

          {/* Every line */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className={h2 + " mb-0"}>Every line <span className="text-[11px] font-normal text-muted">{fmtInt(shownLines.length)} of {fmtInt(manifest.lines.length)}</span></p>
              <div className="flex items-center gap-2">
                <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(100); }} placeholder="Search titles, brands, codes"
                  className={`${input} w-64 max-w-full`} />
                <select value={sort} onChange={(e) => setSort(e.target.value as any)} className={`${input} pr-7`}>
                  <option value="retail">Biggest retail</option>
                  <option value="unit">Highest unit retail</option>
                  <option value="qty">Most units</option>
                  <option value="row">Sheet order</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-surface-2">
                  <tr>
                    <th className={`${thL} text-right rounded-l-lg`}>Row</th>
                    <th className={`${thL} text-left`}>Title</th>
                    <th className={`${thL} text-left`}>Category</th>
                    <th className={`${thL} text-left`}>Brand</th>
                    {d.condition_col && <th className={`${thL} text-left`}>Condition</th>}
                    <th className={`${thL} text-right`}>Units</th>
                    <th className={`${thL} text-right`}>Unit retail</th>
                    <th className={`${thL} text-right ${hasSheetPrice ? "" : "rounded-r-lg"}`}>Retail</th>
                    {hasSheetPrice && <th className={`${thL} text-right rounded-r-lg`}>Sheet price</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownLines.slice(0, limit).map((l, i) => (
                    <tr key={`${l.row}-${i}`} className="border-t border-line">
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted">{l.row || ""}</td>
                      <td className="px-2 py-1.5 text-ink-2" title={l.code ? `${l.title} · ${l.code}` : l.title}>
                        <div className="truncate max-w-[170px] xl:max-w-[340px]">{l.title}</div>
                        {l.code && <div className="text-[11px] text-muted tabular-nums">{l.code}</div>}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">{l.category}{l.guessed && l.category !== "Uncategorized" ? <span className="text-muted" title="Guessed from the title"> *</span> : null}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">{l.brand || <span className="text-muted">-</span>}</td>
                      {d.condition_col && <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">{l.condition || "-"}</td>}
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(l.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{l.retail > 0 ? fmtAmount(unitOf(l)) : "-"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{l.retail > 0 ? fmtAmount(l.retail) : "-"}</td>
                      {hasSheetPrice && <td className="px-2 py-1.5 text-right tabular-nums">{l.sheet_price != null ? fmtAmount(l.sheet_price) : "-"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {manifest.categories_guessed > 0 && <p className="text-[11px] text-muted mt-1.5">* Category guessed from the title.</p>}
            {shownLines.length > limit && (
              <button onClick={() => setLimit((n) => n + 500)} className="mt-2 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-8 rounded-lg">
                Show {fmtInt(Math.min(500, shownLines.length - limit))} more
              </button>
            )}
          </section>

          {/* How it was read */}
          <section className={card}>
            <p className="text-[11.5px] font-medium text-ink-2">Read as {d.format}</p>
            <p className="text-[11px] text-muted mt-1 leading-relaxed">{detected.join(" · ")}</p>
            {d.note && <p className="text-[11px] text-ink-2 mt-1.5 leading-relaxed">{d.note}</p>}
          </section>

          <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-line">
            <button onClick={createLot}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
              <Plus size={14} /> Create lot{num(ask) ? ` at ${fmtAmount(num(ask) || 0)} cost` : ""}
            </button>
            {bid.max != null && (
              <button onClick={() => navigator.clipboard.writeText(bid.max!.toFixed(2)).then(() => toast("Most you can pay copied."))}
                className="text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors">
                <Clipboard size={12} /> Copy most you can pay
              </button>
            )}
            {lastPath && !d.format.startsWith("pdf") && (
              <button onClick={() => setSplitOpen((o) => !o)}
                className={`border px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors ${splitOpen ? "border-accent text-accent" : "text-ink-2 border-line-3 hover:border-accent hover:text-accent"}`}>
                <Layers size={12} /> Split into separate manifests
              </button>
            )}
            <button onClick={() => { setManifest(null); setSplitOpen(false); }} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Clear</button>
          </div>
        </div>
      )}
      {/* Wider than the breakdown: the split table carries a price editor per row. */}
      {manifest && splitOpen && lastPath && !d?.format.startsWith("pdf") && (
        <div className="max-w-[1120px] mt-4"><ManifestSplit path={lastPath} onNavigate={onNavigate} /></div>
      )}
    </div>
  );
}
