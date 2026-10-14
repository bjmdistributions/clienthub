// R-519: a delivery coming in and the cases received onto its pallets. The shapes are
// case_core.rs's (byte-identical in both repos), and every count comes from there: this file
// only names the shapes and the small text helpers the screen needs. The phone twin is
// www/app.js whd*.

export type SizeQty = { size: string; qty: number };
export type LoadLine = {
  id: string; brand: string; group: string; style: string; color: string; description: string; color_name: string;
  cost: number; msrp: number; sizes: SizeQty[]; sheet_total: number; source: string;
};
export type CaseLine = { line_id: string; size: string; pairs: number };
export type WhCase = { id: string; pallet: number; number: number; contents: CaseLine[]; notes: string; created_at: string; updated_at: string };
export type SizeCount = { size: string; expected: number; received: number };
export type LineCount = { line_id: string; sizes: SizeCount[]; expected: number; received: number; pallets: number[] };
export type PalletSum = { pallet: number; cases: number; pairs: number; styles: number; cost: number; msrp: number };
export type LoadTotals = { lines: number; expected: number; received: number; short: number; over: number; cases: number; pallets: number; cost: number; msrp: number };
export type LoadHead = { id: string; name: string; source: string; notes: string; archived: boolean; created_at: string; updated_at: string; lines?: LoadLine[] };
export type LoadDetail = { load: LoadHead; cases: WhCase[]; tally: { counts: LineCount[]; pallets: PalletSum[]; totals: LoadTotals } };
export type LoadSummary = Omit<LoadHead, "lines"> & { totals: LoadTotals };
export type ManifestRead = {
  lines: LoadLine[];
  tabs: { name: string; read: boolean; lines: number; pairs: number; note: string }[];
  groups: { brand: string; group: string; lines: number; pairs: number }[];
  mismatches: { line_id: string; source: string; style: string; color: string; sizes: number; total: number }[];
  warnings: string[];
  stated: { tab: string; lines: number | null; pairs: number } | null;
  pairs: number;
};
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
