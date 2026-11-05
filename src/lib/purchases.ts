// R-596: Purchases. Plain words and plain sums for the purchase order screens, with no screen in them so the rules are tested.
// The money rules (cost each, refund owed, state) are buy_core.rs, the same file on the desktop and the server; this only words
// what it returns and adds up the invoice lines as they are typed, the way buy_core::lines_totals does when they are saved.

import type { InvoiceLine, PurchaseState } from "./api";

const r2 = (x: number) => Math.round(x * 100) / 100 + 0;

/** The one word for where an order stands. The state itself is read on the server's rules and the desktop's, never set by hand. */
export const STATE_WORD: Record<PurchaseState, string> = {
  ordered: "Ordered", on_truck: "On the truck", received: "Received", refund_owed: "Refund owed", done: "Done",
};
export const STATE_TONE: Record<PurchaseState, "neutral" | "shipping" | "step" | "warning" | "success"> = {
  ordered: "neutral", on_truck: "shipping", received: "step", refund_owed: "warning", done: "success",
};

/** What the invoice lines add up to, live as they are typed: the units and the total to the cent. A line with no name or no
 *  count adds nothing yet. */
export function linesTotals(lines: { what: string; qty: number; price: number }[]): { units: number; total: number } {
  const ok = lines.filter((l) => l.what.trim() && l.qty > 0);
  return { units: ok.reduce((a, l) => a + Math.round(l.qty), 0), total: r2(ok.reduce((a, l) => a + Math.round(l.qty) * Math.max(0, l.price), 0)) };
}

/** The lines worth saving (a name and a count), as the server takes them. */
export function cleanLines(lines: { what: string; qty: number; price: number }[]): InvoiceLine[] {
  return lines.filter((l) => l.what.trim() && l.qty > 0).map((l) => ({ what: l.what.trim(), qty: Math.round(l.qty), price: Math.max(0, l.price) }));
}

/** "150 of 200" once counted, "200 ordered" before. */
export function gotWord(r: { units_ordered: number; units_received: number | null }): string {
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  return r.units_received == null ? `${n(r.units_ordered)} ordered` : `${n(r.units_received)} of ${n(r.units_ordered)}`;
}

/** "Oct 8, 2026" from a YYYY-MM-DD day, "" when there is none. */
export function dayWord(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return "";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return "";
  return `${names[mo]} ${Number(m[3])}, ${m[1]}`;
}

/** The name an order carries in lists and on its deals: the supplier and their invoice number, else the first thing on it. */
export function purchaseName(o: { supplier: string; invoiceNo: string; firstLine?: string }): string {
  const parts = [o.supplier.trim(), o.invoiceNo.trim() ? `invoice ${o.invoiceNo.trim()}` : ""].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return o.firstLine?.trim() || "Purchase order";
}

/** The units in a manifest saved as a spreadsheet's plain text (CSV): the filled rows under its header row. 0 when it has none. */
export function csvRowCount(text: string): number {
  const rows = text.split(/\r?\n/).filter((l) => l.replace(/[,;\t"\s]/g, "").length > 0);
  return Math.max(0, rows.length - 1);
}

/** Why an order's count cannot be saved yet, or "". The day it was counted is always asked for. */
export function receivedProblem(units: number | null, day: string): string {
  if (units == null || !Number.isFinite(units) || units < 0) return "Enter how many arrived.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Say the day it was counted.";
  return "";
}
