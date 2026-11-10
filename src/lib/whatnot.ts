// R-648: a Whatnot sales export turned into sales against loads. No Whatnot export had been seen when this was written, so no
// column name is assumed: each column is guessed from its heading and can be changed on the screen. What it needs from each
// row is the item, how many, and the net (what Whatnot paid after its fees); the day and the order number are kept when there.
// The phone's copy of these rules is wn* in clienthub-api www/app.js.
import type { LineItem } from "./api";

export type WnCol = "item" | "qty" | "net" | "date" | "order";
/** The column each field is read from; -1 is none. */
export type WnMap = Record<WnCol, number>;
export interface WnRow { item: string; qty: number; net: number; date: string; order: string }

export const WN_LABEL: Record<WnCol, string> = {
  item: "Item", qty: "How many", net: "Net (after Whatnot's fees)", date: "Day sold", order: "Order number",
};

// Most telling first. The net is guessed before the item, so a heading like "Net earnings" is never read as the item.
const WANT: Record<WnCol, RegExp[]> = {
  net: [/\bnet\b/, /payout/, /earning/, /proceeds/],
  qty: [/^qty$/, /quantity/, /^units?$/, /^count$/],
  order: [/order\s*(id|number|no\.?|#)/, /^order$/],
  date: [/(sold|order|sale|transaction|created)\s*(date|at|on|time)/, /^date$/, /\bdate\b/],
  item: [/product\s*name/, /listing\s*(title|name)/, /^title$/, /\bitem\b/, /product/, /description/, /^name$/],
};

export function guessColumns(header: string[]): WnMap {
  const h = header.map((x) => String(x ?? "").trim().toLowerCase());
  const used = new Set<number>();
  const out: WnMap = { item: -1, qty: -1, net: -1, date: -1, order: -1 };
  for (const col of ["net", "qty", "order", "date", "item"] as WnCol[]) {
    for (const re of WANT[col]) {
      const i = h.findIndex((x, k) => !used.has(k) && re.test(x));
      if (i >= 0) { out[col] = i; used.add(i); break; }
    }
  }
  return out;
}

/** A money cell: "$1,234.56", "1234.5", "-3.00" or "(3.00)". Null when it is not a number. */
export function money(cell: string): number | null {
  let s = String(cell ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()$,\s]|usd/gi, "").replace(/^-/, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}

/** The day a cell names, as YYYY-MM-DD, or "" when it names none. */
export function dayOf(cell: string): string {
  const s = String(cell ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (us) {
    const y = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return "";
}

/** Every sale in the sheet (its first row is the headings). Empty rows are passed over; a row with no item, no net, or a
 *  count that is not a whole number above 0 is counted as skipped, never guessed at. */
export function readRows(rows: string[][], m: WnMap): { rows: WnRow[]; skipped: number } {
  const out: WnRow[] = [];
  let skipped = 0;
  const cell = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
  for (const r of rows.slice(1)) {
    if (!r.some((c) => String(c ?? "").trim())) continue;
    const item = cell(r, m.item);
    const net = money(cell(r, m.net));
    const qtyText = cell(r, m.qty);
    const qty = m.qty < 0 || !qtyText ? 1 : Number(qtyText.replace(/,/g, ""));
    if (!item || net == null || !Number.isInteger(qty) || qty < 1) { skipped++; continue; }
    out.push({ item, qty, net, date: dayOf(cell(r, m.date)), order: cell(r, m.order) });
  }
  return { rows: out, skipped };
}

/** A short mark of exactly these sales, kept in the invoice's notes so the same export is never booked twice. */
export function fingerprint(rows: WnRow[]): string {
  let h = 5381;
  for (const ch of JSON.stringify(rows)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export interface LoadPick { id: string; left: number; unit_cost: number }

/** What each load gives (units by load, in the order first picked), the loads asked for more than they have left, and the
 *  sales' net and cost (units at each load's average cost a unit). `picks[i]` is the load row i sold from. */
export function plan(rows: WnRow[], picks: string[], loads: LoadPick[]) {
  const by = new Map<string, number>();
  rows.forEach((r, i) => { const id = picks[i]; if (id) by.set(id, (by.get(id) ?? 0) + r.qty); });
  const byLoad = [...by].map(([id, units]) => ({ id, units }));
  const over = byLoad.flatMap((b) => {
    const l = loads.find((x) => x.id === b.id);
    return !l || b.units > l.left ? [{ id: b.id, units: b.units, left: l ? Math.max(0, l.left) : 0 }] : [];
  });
  const cents = (n: number) => Math.round(n * 100) / 100;
  const net = cents(rows.reduce((a, r) => a + r.net, 0));
  const cost = cents(byLoad.reduce((a, b) => a + b.units * (loads.find((x) => x.id === b.id)?.unit_cost ?? 0), 0));
  return { byLoad, over, net, cost, made: cents(net - cost), unpicked: rows.filter((_, i) => !picks[i]).length };
}

/** One invoice line a sale, at its net. A count whose net does not split into whole cents goes as one line of the whole. */
export function invoiceLines(rows: WnRow[]): LineItem[] {
  return rows.map((r) => {
    const what = r.order ? `${r.item}, order ${r.order}` : r.item;
    const cents = Math.round(r.net * 100);
    if (r.qty === 1 || cents % r.qty === 0) return { description: what, qty: r.qty, rate: cents / r.qty / 100, amount: cents / 100 };
    return { description: `${what} (${r.qty} units)`, qty: 1, rate: cents / 100, amount: cents / 100 };
  });
}

/** The invoice's day: the last day sold, else today. */
export function lastDay(rows: WnRow[], today: string): string {
  return rows.map((r) => r.date).filter(Boolean).sort().pop() || today;
}
