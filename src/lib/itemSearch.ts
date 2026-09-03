/* ── Searching what we have sold (R-234) ─────────────────────────────────────
 *
 * Invoice line items are not a table. They are a JSON array on the invoice row
 * (`line_items_json`), and `description` is the only text on them — no SKU, no
 * category, no product id. Everything that wants to search or compare what was
 * sold goes through this file, so the app has ONE search grammar instead of one
 * per screen.
 *
 * Three callers: the Invoices search box (R-234), the client screen's deal
 * sections (R-235) and the buyer matcher (R-236).
 *
 * The grammar is multi-token AND, matching the server's bank ledger search
 * (`clienthub-api/src/routes/bank.rs`): every token must appear somewhere in the
 * haystack, in any order, so "lego crocs" finds "Crocs — Lego collab" too.
 */

import type { LineItem } from "./api";

/** Freight is 21% of every line item ever written (27 of 128, measured
 *  2026-09-03). It is not a product, and indexing it makes every query for a
 *  shipped thing match every invoice. */
export function isNoiseItem(description: string): boolean {
  const d = description.trim().toLowerCase();
  return d === "" || d === "shipping" || d === "freight";
}

/** Parse a `line_items_json` blob. Never throws — a bad blob is an empty
 *  invoice, not a broken screen. An invalid blob reaching `json_extract` blanked
 *  the whole financials page once (v0.15.116); the same care applies here. */
export function parseLineItems(json: string | null | undefined): LineItem[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((i) => i && typeof i === "object") as LineItem[];
  } catch {
    return [];
  }
}

/** Split a query into lowercase tokens. Empty query → no tokens → match all. */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every token present somewhere in the haystack. */
export function matchesAllTokens(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** The items on this invoice whose description matches every token. Freight
 *  lines never match — searching "shipping" is not a product search. */
export function matchingItems(items: LineItem[], tokens: string[]): LineItem[] {
  if (tokens.length === 0) return [];
  return items.filter(
    (it) => !isNoiseItem(it.description || "") && matchesAllTokens(it.description || "", tokens),
  );
}

/** One line item, written the way it reads on a row: what it was, how many, at
 *  what price. This is the "what did it fetch last time" answer. */
export function describeItem(it: LineItem): string {
  const qty = Number(it.qty) || 0;
  const rate = Number(it.rate) || 0;
  const money = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  if (qty && rate) return `${qty.toLocaleString()} × ${money(rate)}`;
  if (rate) return money(rate);
  return money(Number(it.amount) || 0);
}
