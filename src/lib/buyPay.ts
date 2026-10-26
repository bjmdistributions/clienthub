// R-552: tying a payment to a buy books all of it or says why, never nothing. The rule is buy_core::pay_take (the same
// file on the desktop and the server); this mirrors it so the screen can ask before it sends, and the phone's buyPayChoice
// mirrors it again. Change all three together.
import type { BuyKind } from "./api";

export type BuyTake = "all" | "left";

const CENT = 0.005;
const r2 = (x: number) => Math.round(x * 100) / 100 + 0;

/** What tying a payment with `room` free does to a leg that cost `total` with `paid` booked on it now.
 *  plain: it books `books`, and when the buy had no cost yet its cost becomes `raisesTo`.
 *  ask: it is more than the `left` to pay; book all of it (the cost becomes `raisesTo`) or, when something is left, only that.
 *  none: nothing on it is free. */
export type PayChoice =
  | { kind: "plain"; books: number; raisesTo?: number }
  | { kind: "ask"; room: number; left: number; raisesTo: number }
  | { kind: "none" };

export function payChoice(total: number, paid: number, room: number): PayChoice {
  const free = r2(room);
  if (free <= CENT) return { kind: "none" };
  const was = Math.max(paid, 0);
  if (total <= CENT) return { kind: "plain", books: free, raisesTo: r2(was + free) };
  const left = r2(Math.max(total - paid, 0));
  if (free <= left + CENT) return { kind: "plain", books: free };
  return { kind: "ask", room: free, left: left <= CENT ? 0 : left, raisesTo: r2(was + free) };
}

/** A leg of a buy as the pickers need it: what it cost and what is booked on it. */
export interface BuyLeg { total: number; paid: number }

export const legOf = (r: { goods_total: number; goods_paid: number; ship_total: number; ship_paid: number }, kind: BuyKind): BuyLeg =>
  kind === "goods" ? { total: r.goods_total, paid: r.goods_paid } : { total: r.ship_total, paid: r.ship_paid };

/** The bank picker's search: every word must match; an amount may be typed with $ and commas and matches the row's
 *  amount or what is left of it, to the cent. */
export function rowMatches(words: string[], t: { counterparty_name: string; description: string; amount: number; unallocated: number; posted_at: string }): boolean {
  const text = `${t.counterparty_name} ${t.description} ${t.posted_at}`.toLowerCase();
  return words.every((w) => {
    if (text.includes(w)) return true;
    if (!/^\$?[\d,]*\.?\d*$/.test(w) || !/\d/.test(w)) return false;
    const bare = w.replace(/[$,]/g, "");
    const n = Number(bare);
    return Math.abs(t.amount - n) < CENT || Math.abs(t.unallocated - n) < CENT
      || t.amount.toFixed(2).includes(bare) || t.unallocated.toFixed(2).includes(bare);
  });
}

/** The rows that carry most of the buy's supplier's name first, the rest in the order they came (newest first). */
export function supplierFirst<T extends { counterparty_name: string; description: string }>(rows: T[], supplier: string): T[] {
  const words = supplier.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["inc", "llc", "the", "and", "corp", "company"].includes(w));
  if (!words.length) return rows;
  const score = (t: T) => words.filter((w) => `${t.counterparty_name} ${t.description}`.toLowerCase().includes(w)).length;
  return rows.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);
}
