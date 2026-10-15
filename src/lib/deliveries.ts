// R-519: a delivery coming in and the cases received onto its pallets. The shapes are
// case_core.rs's (byte-identical in both repos), and every count comes from there: this file
// only names the shapes and the small text helpers the screen needs. The phone twin is
// www/app.js whd*.

export type SizeQty = { size: string; qty: number };
export type LoadLine = {
  id: string; brand: string; group: string; style: string; color: string; description: string; color_name: string;
  cost: number; msrp: number; sizes: SizeQty[]; sheet_total: number; source: string;
  /** R-537: the tab it was read from, and its picture from the sheet ("media/deliveries/<load>/<line>.jpg"). */
  sheet?: string; image?: string;
};
export type CaseLine = { line_id: string; size: string; pairs: number };
/** A box, or (kind "loose", number 0) items on the pallet with no box (R-535). */
export type WhCase = { id: string; pallet: number; number: number; contents: CaseLine[]; notes: string; created_at: string; updated_at: string; kind?: string };
/** A pallet as the screens show it: its record (where it stands, full or not) and what is on it (R-535). */
export type PalletView = { pallet: number; location: string; closed: boolean; note: string; recorded: boolean; boxes: number; loose: number; pairs: number; styles: number; cost: number; msrp: number };
export type SizeCount = { size: string; expected: number; received: number };
export type LineCount = { line_id: string; sizes: SizeCount[]; expected: number; received: number; pallets: number[] };
export type PalletSum = { pallet: number; cases: number; pairs: number; styles: number; cost: number; msrp: number };
export type LoadTotals = { lines: number; expected: number; received: number; short: number; over: number; cases: number; pallets: number; cost: number; msrp: number };
export type LoadHead = { id: string; name: string; source: string; notes: string; archived: boolean; created_at: string; updated_at: string; lines?: LoadLine[] };
export type LoadDetail = {
  load: LoadHead; cases: WhCase[]; tally: { counts: LineCount[]; pallets: PalletSum[]; totals: LoadTotals };
  outs: LoadOut[]; stock: Stock; short?: TakeShort[];
  pallets: PalletView[]; recent_locations: string[];
};
export type LoadSummary = Omit<LoadHead, "lines"> & { totals: LoadTotals };
/**
 * One tab of a manifest as read (R-537). `kind`: "items" (styles to import), "totals" (a totals
 * page: never imported, only checks the count), "copy" (every style is also on the other pages:
 * a master list, left out unless turned on) or "other". `layout`: how its sizes are named.
 */
export type TabRead = {
  name: string; read: boolean; lines: number; pairs: number; note: string;
  kind?: string; layout?: string; samples?: string[]; mismatches?: number; pictures?: number; warnings?: string[];
};
export type GroupCount = { brand: string; group: string; lines: number; pairs: number };
export type ManifestRead = {
  lines: LoadLine[];
  tabs: TabRead[];
  groups: GroupCount[];
  mismatches: { line_id: string; source: string; style: string; color: string; sizes: number; total: number }[];
  warnings: string[];
  stated: { tab: string; lines: number | null; pairs: number } | null;
  pairs: number;
  /** R-537: pictures matched to a style, pictures left out, and the sample lines' pictures as data: URLs. */
  pictures?: number; pictures_left_out?: number; previews?: Record<string, string>;
};
/** What putting a sheet's pictures on a delivery did (R-537). */
export type PicturesAdded = { on_lines: number; not_on_delivery: number; left_out: number };

export const tabKind = (t: TabRead) => t.kind ?? (t.read ? "items" : "other");
/** The tabs a new delivery takes at first: every page of styles, never a totals page or a copy. */
export const defaultTabs = (read: ManifestRead) => new Set(read.tabs.filter((t) => tabKind(t) === "items").map((t) => t.name));
/** The lines of the chosen tabs. A line with no tab (read before R-537) is always kept. */
export const linesOfTabs = (read: ManifestRead, on: Set<string>) => read.lines.filter((l) => !l.sheet || on.has(l.sheet));
/** How a tab names its sizes, said plainly. */
export function layoutText(layout: string | undefined): string {
  if (layout === "above") return "Sizes are on a row above the styles, so each style keeps its own sizes.";
  if (layout === "heading") return "Sizes are across the top of the page.";
  if (layout === "column") return "One size a row, gathered into one line for each style and colour.";
  return "";
}
/** "8 rows have Totals that do not match their sizes" */
export const offText = (n: number) => (n === 1 ? "1 row has a Total that does not match its sizes" : `${n.toLocaleString("en-US")} rows have Totals that do not match their sizes`);
/** "5 × 20 · 6 × 24": the sizes the manifest lists for a line. */
export const sizesText = (l: LoadLine) => l.sizes.filter((s) => s.qty > 0).map((s) => `${s.size} × ${s.qty}`).join(" · ");
export const lineQty = (l: LoadLine) => l.sizes.reduce((a, s) => a + Math.max(0, s.qty), 0);
/** Lines and pairs by brand and group, in the order they first appear (case_core::group_counts). */
export function groupsOf(lines: LoadLine[]): GroupCount[] {
  const out: GroupCount[] = [];
  for (const l of lines) {
    let g = out.find((x) => x.brand === l.brand && x.group === l.group);
    if (!g) { g = { brand: l.brand, group: l.group, lines: 0, pairs: 0 }; out.push(g); }
    g.lines += 1; g.pairs += lineQty(l);
  }
  return out;
}
export type NewLine = { brand: string; group: string; style: string; color: string; description: string; cost: number; msrp: number; sizes: string };

/** "CK2316 CNT" */
export const lineTitle = (l: LoadLine) => [l.style, l.color].filter(Boolean).join(" ");
/** "Wrangler Kids, Chestnut" */
export const lineDesc = (l: LoadLine) => [l.description, l.color_name && l.color_name !== l.color ? l.color_name : ""].filter(Boolean).join(", ");

/** Every word typed appears somewhere in the line's brand, group, style, colour or name. */
export function lineMatches(l: LoadLine, q: string): boolean {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return true;
  const hay = [l.brand, l.group, l.style, l.color, l.description, l.color_name].join(" ").toLowerCase();
  return toks.every((t) => hay.includes(t));
}

/** Pairs short and over, size by size, so an over in one size never hides a short in another. */
export function lineStatus(c: LineCount): { short: number; over: number } {
  let short = 0, over = 0;
  for (const s of c.sizes) { short += Math.max(0, s.expected - s.received); over += Math.max(0, s.received - s.expected); }
  return { short, over };
}

/** A case's contents as one entry a style: [{ line_id, sizes: [["7", 2], ...] }]. */
export function byStyle(contents: CaseLine[]): { line_id: string; sizes: [string, number][] }[] {
  const out: { line_id: string; sizes: [string, number][] }[] = [];
  for (const c of contents) {
    let g = out.find((x) => x.line_id === c.line_id);
    if (!g) { g = { line_id: c.line_id, sizes: [] }; out.push(g); }
    g.sizes.push([c.size, c.pairs]);
  }
  return out;
}

// ---- R-519 phase 2: selling from a delivery -------------------------------------------------

export type SizeLeft = { size: string; received: number; out: number; left: number };
export type LineLeft = { line_id: string; sizes: SizeLeft[]; received: number; out: number; left: number; pallets: number[] };
export type Stock = {
  lines: LineLeft[]; groups: { brand: string; group: string; styles: number; left: number }[];
  received: number; out: number; left: number; oversold: { line_id: string; size: string; over: number }[];
};
/** An order that took pairs; `invoice_state` is "live", "voided", "removed", "gone" or "" (no invoice). */
export type LoadOut = {
  id: string; invoice_id: string; reference: string; note: string; takes: CaseLine[]; pairs: number; cost: number;
  undone: boolean; undone_at: string; created_at: string; updated_at: string; invoice_state: string;
};
export type TakeShort = { line_id: string; size: string; asked: number; taken: number };

/** The pick, a draft kept on this device per delivery until its invoice exists. */
export const pickKey = (loadId: string) => `warehouse_pick:${loadId}`;
/** An invoice whose pairs did not leave the delivery (the call failed after it was created). */
export const pendingTakeKey = (loadId: string) => `warehouse_pending_take:${loadId}`;

export type Pick = Record<string, Record<string, number>>;
export type Bucket = { key: string; brand: string; group: string; pairs: number; styles: number; cost: number; msrp: number; takes: CaseLine[] };

/** One bucket per brand and group, in manifest order: the invoice gets one line each, priced per pair. */
export function buckets(lines: LoadLine[], pick: Pick): Bucket[] {
  const out: Bucket[] = [];
  for (const l of lines) {
    const sizes = pick[l.id] || {};
    const n = Object.values(sizes).reduce((a, b) => a + (b || 0), 0);
    if (!(n > 0)) continue;
    const key = `${l.brand}\u0001${l.group}`;
    let b = out.find((x) => x.key === key);
    if (!b) { b = { key, brand: l.brand, group: l.group, pairs: 0, styles: 0, cost: 0, msrp: 0, takes: [] }; out.push(b); }
    b.pairs += n; b.styles += 1; b.cost += n * (l.cost || 0); b.msrp += n * (l.msrp || 0);
    for (const [size, pairs] of Object.entries(sizes)) if (pairs > 0) b.takes.push({ line_id: l.id, size, pairs });
  }
  for (const b of out) { b.cost = Math.round(b.cost * 100) / 100; b.msrp = Math.round(b.msrp * 100) / 100; }
  return out;
}
export const bucketName = (b: Bucket) => [b.brand, b.group].filter(Boolean).join(" ") || "Other";
/** "Lamo Hash WOMEN'S, 31 styles": the invoice line for a bucket. */
export const bucketLine = (b: Bucket) => `${bucketName(b)}, ${b.styles} ${b.styles === 1 ? "style" : "styles"}`;
/** A rate from a percent of the bucket's average MSRP, to the cent. */
export const pctRate = (b: Bucket, pct: number) => (b.pairs > 0 ? Math.round((b.msrp / b.pairs) * pct) / 100 : 0);

/** "pallet 2 at A2, pallet 5" for the pallets a style stands on (R-535). */
export function palletNames(ns: number[], pallets: PalletView[]): string {
  if (!ns.length) return "";
  return (ns.length === 1 ? "pallet " : "pallets ") + ns.map((n) => { const p = pallets.find((x) => x.pallet === n); return p?.location ? `${n} at ${p.location}` : String(n); }).join(", ");
}
/** "1 box · 2 loose · 2 styles · $51.00 cost", or "Empty". */
export function palletMeta(p: PalletView, money: (n: number) => string): string {
  const parts: string[] = [];
  if (p.boxes) parts.push(`${p.boxes} ${p.boxes === 1 ? "box" : "boxes"}`);
  if (p.loose) parts.push(`${p.loose} loose`);
  if (p.styles) parts.push(`${p.styles} ${p.styles === 1 ? "style" : "styles"}`);
  if (p.pairs) parts.push(`${money(p.cost)} cost`);
  return parts.join(" · ") || "Empty";
}
