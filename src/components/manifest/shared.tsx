import type { ManifestAnalysis, ManifestColumnMap, ManifestColumnMapRecord, ManifestLine, ManifestPlaced, ManifestProduct, SavedManifest } from "../../lib/api";
import StatusPill from "../StatusPill";

/** Every form a manifest turns up in. Anything else is rejected with a reason. */
export const MANIFEST_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "pdf"];
export const ACCEPTED = new RegExp(`\\.(${MANIFEST_EXTS.join("|")})$`, "i");

/** Jack's resale rates and target margin: per device, kept between manifests.
 *  pct/cats are a % of retail; unit/unitCats are a resale price per unit (for a sheet that carries cost and no retail). */
export const SETTINGS_KEY = "manifest_resale_v1";
export type ResaleSettings = { pct: string; margin: string; cats: Record<string, string>; unit: string; unitCats: Record<string, string> };
export const loadSettings = (): ResaleSettings => {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { pct: s.pct ?? "", margin: s.margin ?? "", cats: s.cats ?? {}, unit: s.unit ?? "", unitCats: s.unitCats ?? {} };
  } catch { return { pct: "", margin: "", cats: {}, unit: "", unitCats: {} }; }
};
export const storeSettings = (s: ResaleSettings) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* the figures still work this session */ }
};

export const num = (s: string): number | null => {
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export const fmtInt = (n: number) => Math.round(n || 0).toLocaleString();
export const fmtPct = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;
export const unitOf = (l: ManifestLine) => (l.qty > 0 ? l.retail / l.qty : 0);
export const fileBase = (p: string) => (p.split(/[/\\]/).pop() || "").replace(/\.[^.]+$/, "");
export const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
/** Column letter as Excel shows it: 0 is A, 26 is AA. */
export const colLetter = (i: number): string => {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** What the saved row says it holds, from its totals text. */
export function savedTotals(m: SavedManifest): { lines: number; units: number; retail: number } {
  try {
    const t = m.totals && typeof m.totals === "object" ? m.totals : JSON.parse(m.totals_json || "{}");
    return { lines: Number(t.lines) || 0, units: Number(t.units) || 0, retail: Number(t.retail) || 0 };
  } catch { return { lines: 0, units: 0, retail: 0 }; }
}
/** A remembered column map, whichever way the store hands it over. */
export function mapOfRecord(r: ManifestColumnMapRecord | null): ManifestColumnMap | null {
  if (!r) return null;
  if (r.map) return r.map;
  try { return r.map_json ? (JSON.parse(r.map_json) as ManifestColumnMap) : null; } catch { return null; }
}

export const BANDS: [string, number, number][] = [
  ["Under $10", 0, 10], ["$10 to $25", 10, 25], ["$25 to $50", 25, 50],
  ["$50 to $100", 50, 100], ["$100 to $250", 100, 250], ["$250 and up", 250, Infinity],
];

/** What the sheet itself charges for the load, and how it says so. */
export function sheetAsk(m: ManifestAnalysis): number | null {
  const p = m.sheet_pricing;
  if (!p) return null;
  if (p.total != null && p.total > 0) return p.total;
  if (p.kind === "pct" && p.pct != null) return m.total_retail * p.pct / 100;
  if (p.kind === "unit" && p.unit != null) return p.unit * m.total_quantity;
  return null;
}

/** Lines the sheet's price covers: its own line prices, else every line its rule can price. */
export function pricedLines(m: ManifestAnalysis): number {
  const own = m.lines.filter((l) => l.sheet_price != null).length;
  if (own) return own;
  return m.sheet_pricing?.kind === "pct" ? m.lines.filter((l) => l.retail > 0).length : m.lines.length;
}

/** A line with no category is Unplaced on screen, whichever name the reader gives it. */
export const isUnplaced = (name: string | null | undefined) => !name || /^(uncategori[sz]ed|unplaced)$/i.test(name.trim());
export const catLabel = (name: string | null | undefined) => (isUnplaced(name) ? "Unplaced" : (name as string));

export const placedCounts = (m: ManifestAnalysis) => {
  const c: Record<ManifestPlaced, number> = { sheet: 0, rule: 0, list: 0, none: 0 };
  for (const l of m.lines) c[l.placed] = (c[l.placed] || 0) + 1;
  return c;
};

/** Everything the breakdown quotes, worked out from the reader's lines and products. */
export function facts(m: ManifestAnalysis) {
  const lines = m.lines || [];
  const products = m.products || [];
  const retail = m.total_retail;
  const value = (p: ManifestProduct) => (m.cost_only ? p.cost ?? 0 : p.retail);
  const byValue = [...products].sort((a, b) => value(b) - value(a));
  const top10 = byValue.slice(0, 10).reduce((s, p) => s + value(p), 0);
  const top10Base = m.cost_only ? products.reduce((s, p) => s + value(p), 0) : retail;
  const priced = lines.filter((l) => l.retail > 0);
  const units = priced.map(unitOf).sort((a, b) => a - b);
  const median = units.length ? units[Math.floor(units.length / 2)] : 0;
  const outliers = priced.filter((l) => unitOf(l) >= Math.max(100, median * 10)).sort((a, b) => unitOf(b) - unitOf(a));
  const bands = BANDS.map(([name, lo, hi]) => {
    const ls = priced.filter((l) => unitOf(l) >= lo && unitOf(l) < hi);
    return { name, lines: ls.length, units: ls.reduce((s, l) => s + l.qty, 0), retail: ls.reduce((s, l) => s + l.retail, 0) };
  }).filter((b) => b.lines > 0);
  const conditions = new Map<string, { units: number; retail: number; lines: number }>();
  if (m.detection.condition_col) {
    for (const l of lines) {
      const k = l.condition || "Not stated";
      const c = conditions.get(k) || { units: 0, retail: 0, lines: 0 };
      conditions.set(k, { units: c.units + l.qty, retail: c.retail + l.retail, lines: c.lines + 1 });
    }
  }
  const suggestedByCat = new Map<string, number>();
  const costByCat = new Map<string, number>();
  for (const l of lines) {
    if (l.placed === "list") suggestedByCat.set(l.category, (suggestedByCat.get(l.category) || 0) + 1);
    if (l.sheet_price != null) costByCat.set(l.category, (costByCat.get(l.category) || 0) + l.sheet_price);
  }
  const topBrand = m.brands.find((b) => b.name !== "Unbranded");
  return {
    top10Share: top10Base > 0 ? top10 / top10Base : 0,
    topProducts: byValue.slice(0, 10),
    topBrand, topBrandShare: topBrand && retail > 0 ? topBrand.total_retail / retail : 0,
    median, outliers, bands,
    conditions: [...conditions.entries()].sort((a, b) => b[1].retail - a[1].retail),
    noRetail: lines.filter((l) => l.retail <= 0),
    suggestedByCat, costByCat,
    value,
  };
}

/** How a line's category was settled, as the pill a person reads. */
export const PLACED_LABEL: Record<ManifestPlaced, string> = {
  sheet: "From the sheet", rule: "By your rule", list: "Suggested", none: "Unplaced",
};
const PLACED_TIP: Record<ManifestPlaced, string> = {
  sheet: "The sheet's own category column says so.",
  rule: "One of your rules placed it.",
  list: "Read from the words in the title. Only a suggestion until you confirm it in the review.",
  none: "Nothing on the sheet or in your rules places it yet.",
};
export function PlacedPill({ placed }: { placed: ManifestPlaced }) {
  const tone = placed === "sheet" ? "neutral" : placed === "rule" ? "accent" : placed === "list" ? "warning" : "danger";
  return <StatusPill tone={tone} title={PLACED_TIP[placed]}>{PLACED_LABEL[placed]}</StatusPill>;
}

/** House styles for this screen. */
export const S = {
  card: "bg-surface-2 rounded-lg px-3.5 py-3",
  h2: "text-[13px] font-semibold text-ink mb-2",
  input: "h-8 px-2.5 rounded-lg border border-line-3 bg-surface text-[12.5px] tabular-nums outline-none focus:border-accent",
  th: "px-3 py-2 font-medium text-muted",
  thL: "px-2 py-2 font-medium text-muted",
  btn: "text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50",
  btnPrimary: "bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50",
};
