// R-653: the manifest analyzer as a spreadsheet. Jack clicks the headings that matter (name,
// quantity, brand, price) and these functions add them up. No column is guessed: the one thing
// read without a click is which row holds the headings, and that only names the columns.
// The phone's copy is the mg* functions in clienthub-api www/app.js; keep the two the same.

export type Pick = "name" | "qty" | "brand" | "each" | "line";

export const PICKS: { id: Pick; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "qty", label: "Quantity" },
  { id: "brand", label: "Brand" },
  { id: "each", label: "Price each" },
  { id: "line", label: "Line total" },
];

/** The column each pick names (0-based). */
export type Picks = Partial<Record<Pick, number>>;

const filled = (c: string | undefined | null) => c != null && String(c).trim() !== "";

/** A cell as a number: "$1,234.50", "(12.00)", "4 ea". Null when it is not one. */
export function num(c: string | undefined | null): number | null {
  if (c == null) return null;
  let t = String(c).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$€£\s,]/g, "").replace(/^(usd|eur|gbp)/i, "").replace(/(usd|eur|gbp|ea|each|pcs|units?)$/i, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** The row holding the headings: the first of the top 30 with at least two cells filled, none of
 *  them a number, and at least half as many filled as the fullest of those rows. -1 when none is. */
export function headingRow(rows: string[][]): number {
  const top = rows.slice(0, 30);
  const most = Math.max(0, ...top.map((r) => r.filter(filled).length));
  for (let i = 0; i < top.length; i++) {
    const cells = top[i].filter(filled);
    if (cells.length >= 2 && cells.length * 2 >= most && cells.every((c) => num(c) === null)) return i;
  }
  return -1;
}

/** What the column picks are remembered by: the headings themselves. Empty when there are none. */
export function signature(rows: string[][], h: number): string {
  if (h < 0 || !rows[h]) return "";
  const cells = rows[h].map((c) => String(c ?? "").trim().toLowerCase().replace(/\s+/g, " "));
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return cells.length ? "r653:" + cells.join("|") : "";
}

/** A totals row at the foot of a sheet ("Total", "Grand total", "Total units:"), never a line. */
const TOTAL = /^(grand\s+|sub\s*-?\s*)?totals?(\s+(units|qty|quantity|retail|cost|price|value|items|lines))?\s*:?\s*$/i;
export const isTotalRow = (r: string[]) => {
  const first = r.find(filled);
  return !!first && TOTAL.test(String(first).trim());
};

export interface Line {
  /** 0-based row on the page. */
  row: number;
  name: string;
  brand: string;
  qty: number | null;
  each: number | null;
  /** The line's price: its Line total cell, else Price each times the quantity. */
  value: number | null;
}

export interface Reading {
  /** By row: is it one of the lines added up. */
  counted: boolean[];
  lines: Line[];
  qty: number;
  price: number;
  brands: number;
}

/** Add up a page with the columns Jack picked. A row is a line when it has a name (with Name
 *  picked) or a number where the quantity or a price is, and is not the headings again or a total. */
export function read(rows: string[][], h: number, p: Picks): Reading {
  const counted = rows.map(() => false);
  const lines: Line[] = [];
  const head = h >= 0 ? rows[h] || [] : [];
  const picked = p.name != null || p.qty != null || p.each != null || p.line != null;
  if (picked) {
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (!r.some(filled) || isTotalRow(r)) continue;
      const cell = (j?: number) => (j == null ? "" : String(r[j] ?? "").trim());
      const name = cell(p.name);
      if (p.name != null) {
        if (!name || TOTAL.test(name)) continue;
        // The headings again (a page per pallet pasted one under another) are not a line.
        if (name.toLowerCase() === String(head[p.name] ?? "").trim().toLowerCase()) continue;
      }
      const q = p.qty != null ? num(cell(p.qty)) : null;
      if (p.qty != null && q === null && cell(p.qty)) continue; // words where the quantity belongs
      const each = p.each != null ? num(cell(p.each)) : null;
      const line = p.line != null ? num(cell(p.line)) : null;
      if (p.name == null && q === null && each === null && line === null) continue;
      const times = p.qty != null ? q ?? 0 : 1;
      const value = line ?? (each != null ? each * times : null);
      counted[i] = true;
      lines.push({ row: i, name, brand: cell(p.brand), qty: q, each, value });
    }
  }
  const sum = (f: (l: Line) => number | null) => lines.reduce((s, l) => s + (f(l) ?? 0), 0);
  return {
    counted,
    lines,
    qty: sum((l) => l.qty),
    price: Math.round(sum((l) => l.value) * 100) / 100,
    brands: new Set(lines.map((l) => l.brand.toLowerCase()).filter(Boolean)).size,
  };
}

/** The picks as the column map store keeps them (the R-564 roles), so a map saved here reads there too. */
const ROLE_OF: Record<Pick, string> = { name: "description", qty: "quantity", brand: "brand", each: "retail_unit", line: "retail_ext" };

export function toRoles(p: Picks): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(ROLE_OF) as Pick[]) if (p[k] != null) out[ROLE_OF[k]] = p[k] as number;
  return out;
}

export function fromRoles(r: Record<string, number> | null | undefined): Picks {
  const out: Picks = {};
  if (!r) return out;
  for (const k of Object.keys(ROLE_OF) as Pick[]) {
    const v = r[ROLE_OF[k]];
    if (typeof v === "number" && v >= 0) out[k] = v;
  }
  return out;
}

/** Give a pick to a column. A column holds one thing, so whatever it held before is dropped. */
export function setPick(p: Picks, col: number, what: Pick | null): Picks {
  const out: Picks = {};
  for (const k of Object.keys(p) as Pick[]) if (p[k] !== col && k !== what) out[k] = p[k];
  if (what) out[what] = col;
  return out;
}

/** Excel's letters for a column: 0 is A, 26 is AA. */
export const colLetter = (i: number): string => {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
