// R-660: where personal money went, one month at a time. Plaid gives each transaction a spending group
// (`personal_finance_category.primary`); this names the groups in plain words and adds a month up. Transfers and
// card or loan payments only move money between your own accounts, so they are listed apart and never counted as
// spending or as money in (paying the card from checking would otherwise count every purchase twice).
// The phone's port is `psSummarize` in clienthub-api www/app.js; change both together.
import type { PersonalTxn } from "./api";

export const CATEGORY_NAMES: Record<string, string> = {
  FOOD_AND_DRINK: "Food and drink",
  GENERAL_MERCHANDISE: "Shopping",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  RENT_AND_UTILITIES: "Rent and utilities",
  ENTERTAINMENT: "Entertainment",
  PERSONAL_CARE: "Personal care",
  MEDICAL: "Medical",
  HOME_IMPROVEMENT: "Home",
  GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Taxes and donations",
  BANK_FEES: "Bank fees",
  INCOME: "Income",
  TRANSFER_IN: "Transfers in",
  TRANSFER_OUT: "Transfers out",
  LOAN_PAYMENTS: "Card and loan payments",
  OTHER: "Other",
};

const MOVEMENTS = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);

export function categoryName(code: string): string {
  return CATEGORY_NAMES[code] ?? (code ? code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ") : "Other");
}

/** Money moved between your own accounts: shown, never counted. */
export function isMovement(code: string): boolean {
  return MOVEMENTS.has(code);
}

export interface Group { key: string; name: string; amount: number; count: number }

export interface MonthSummary {
  month: string;
  /** What went out, refunds taken off, transfers and card payments left out. */
  spent: number;
  /** What came in, refunds and transfers left out. */
  income: number;
  /** Money moved between your own accounts this month, both ways, for the note under the figures. */
  moved: number;
  byCategory: Group[];
  byPlace: Group[];
  rows: PersonalTxn[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** "2026-11" for a date like "2026-11-12". */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Every month that has a transaction, newest first. */
export function monthsOf(txns: PersonalTxn[]): string[] {
  return [...new Set(txns.map((t) => monthOf(t.posted_at)).filter((m) => m.length === 7))].sort().reverse();
}

/** One month added up. A refund (money in that is not income, in a spending group) takes off that group's
 *  spending, so a returned purchase does not count as either. */
export function summarize(txns: PersonalTxn[], month: string): MonthSummary {
  const rows = txns.filter((t) => monthOf(t.posted_at) === month);
  let spent = 0;
  let income = 0;
  let moved = 0;
  const cats = new Map<string, Group>();
  const places = new Map<string, Group>();
  for (const t of rows) {
    const code = t.category || "OTHER";
    if (isMovement(code)) { moved += t.amount; continue; }
    if (t.direction === "in" && code === "INCOME") { income += t.amount; continue; }
    const signed = t.direction === "in" ? -t.amount : t.amount;
    spent += signed;
    const c = cats.get(code) ?? { key: code, name: categoryName(code), amount: 0, count: 0 };
    c.amount += signed; c.count += 1; cats.set(code, c);
    const place = (t.merchant || t.description || "Unknown").trim();
    const p = places.get(place.toLowerCase()) ?? { key: place.toLowerCase(), name: place, amount: 0, count: 0 };
    p.amount += signed; p.count += 1; places.set(place.toLowerCase(), p);
  }
  const sorted = (m: Map<string, Group>) =>
    [...m.values()].map((g) => ({ ...g, amount: cents(g.amount) })).filter((g) => g.amount > 0.004).sort((a, b) => b.amount - a.amount);
  return { month, spent: cents(spent), income: cents(income), moved: cents(moved), byCategory: sorted(cats), byPlace: sorted(places), rows };
}
