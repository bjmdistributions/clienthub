import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Landmark, Upload, Search, Check, X, Trash2, Loader2, Link2, ChevronRight, ChevronDown, Sparkles, Plus,
  Building2, RefreshCw, Plug, Wand2, ArrowDownLeft, ArrowUpRight, Pencil, ShieldCheck, AlertTriangle,
} from "lucide-react";
import {
  api, BankTxn, BankTxnReviewPatch, BankTxnSummary, BankPreview, BankAiPreview, BankAiImportResult, BankAllocation, DealFlow, PlaidItem,
  Loan, TxnRule, DedupeResult, PlaidSyncSummary, BankSuggestCandidate, BankPersonCandidate, ReconciliationMissingDeal,
} from "../lib/api";
import { fmtAmount, localDay, parseLocalDay } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./Toast";
import PersonPickerModal, { PersonRef, personKey } from "./PersonPicker";
import FreeCashView from "./FreeCashView";
import LoansView from "./LoansView";

import { parseAmount } from "../lib/format";
// Backend errors arrive as raw Rust strings and were shown to the user verbatim,
// often prefixed "Error:" by String(e). Strip the noise and never render an empty
// toast — a failure with no message reads as nothing having happened at all.
function errText(e: unknown): string {
  const raw = typeof e === "string" ? e : ((e as { message?: string })?.message ?? String(e));
  return raw.replace(/^Error:\s*/i, "").trim() || "Something went wrong. Please try again.";
}

// ── Transaction search ──────────────────────────────────────────────────────
// Exact numeric token ("500", "$1,500.00", "1500") → number; anything else null.
const numToken = (s: string): number | null =>
  /^\$?\d[\d,]*(\.\d{1,2})?$/.test(s) ? parseFloat(s.replace(/[$,]/g, "")) : null;

// Multi-term AND search: every space-separated token must match. A numeric token
// matches the amount EXACTLY (to the cent) — so "500" no longer matches 1,500.00 —
// while a word token matches the payee or memo. "walmart 500" ⇒ payee~walmart AND $500.00.
const matchesQuery = (t: BankTxn, q: string): boolean => {
  const toks = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return toks.every((tok) => {
    const n = numToken(tok);
    if (n !== null) return Math.abs(t.amount - n) < 0.005;
    return (t.description || "").toLowerCase().includes(tok) ||
           (t.counterparty_name || "").toLowerCase().includes(tok);
  });
};

// Chart of accounts (QuickBooks-style). Legacy values (receipt/payment/fee/
// owner_draw/shipping/software/internal_transfer/cash_in/cash_out) are kept so
// existing rows keep their category. Grouped for scannable <optgroup> dropdowns.
//
// R-187 widened this to a chart a tax return can actually be filed from. Four
// movements have to be separable or the year's numbers are wrong: money earned,
// money handed back out of a sale, what things cost, and what a supplier handed
// back. Sales reductions and cost reductions had NO home before this — a refund
// to a buyer had to be filed as a supplier payment, which reads as cost of goods.
//
// It also carries the buckets a Schedule C names in its own words (interest,
// repairs, licences, retirement, health insurance) and, most importantly, the
// kinds of money that are NOT deductible and must never sit in an expense
// bucket: an owner draw, the owner's personal estimated tax, sales tax being
// held for the state, and a capitalised asset purchase.
//
// `hidden` entries are written by the backend (loan tagging derives its category
// from direction) and must render with a real label, but are never hand-picked.
const CATEGORIES: { value: string; label: string; group: string; hidden?: boolean }[] = [
  { value: "",                    label: "Uncategorized",                   group: "" },

  { value: "receipt",             label: "Sale / buyer payment",            group: "Income" },
  { value: "service_income",      label: "Commission & service income",     group: "Income" },
  { value: "shipping_income",     label: "Shipping billed to a customer",   group: "Income" },
  { value: "interest_income",     label: "Interest earned",                 group: "Income" },
  { value: "other_income",        label: "Other income",                    group: "Income" },

  { value: "customer_refund",     label: "Refund to a customer",            group: "Sales reductions" },
  { value: "sales_discount",      label: "Discount or allowance given",     group: "Sales reductions" },
  { value: "chargeback",          label: "Chargeback or dispute lost",      group: "Sales reductions" },
  { value: "bad_debt",            label: "Bad debt written off",            group: "Sales reductions" },

  { value: "payment",             label: "Supplier payment",                group: "Cost of goods" },
  { value: "merchandise",         label: "Inventory / merchandise",         group: "Cost of goods" },
  { value: "shipping",            label: "Shipping & freight",              group: "Cost of goods" },
  { value: "customs",             label: "Customs, duties & tariffs",       group: "Cost of goods" },
  { value: "packaging",           label: "Packaging & shipping supplies",   group: "Cost of goods" },
  { value: "storage",             label: "Storage, 3PL & pallet fees",      group: "Cost of goods" },

  { value: "supplier_refund",     label: "Refund from a supplier",          group: "Cost reductions" },
  { value: "purchase_discount",   label: "Supplier discount or rebate",     group: "Cost reductions" },

  { value: "meals",               label: "Meals & food",                    group: "Operating expenses" },
  { value: "auto",                label: "Fuel & auto",                     group: "Operating expenses" },
  { value: "travel",              label: "Travel & lodging",                group: "Operating expenses" },
  { value: "office",              label: "Office & supplies",               group: "Operating expenses" },
  { value: "utilities",           label: "Utilities & phone",               group: "Operating expenses" },
  { value: "rent",                label: "Rent & warehouse",                group: "Operating expenses" },
  { value: "repairs",             label: "Repairs & maintenance",           group: "Operating expenses" },
  { value: "equipment",           label: "Small equipment & tools",         group: "Operating expenses" },
  { value: "software",            label: "Software & subscriptions",        group: "Operating expenses" },
  { value: "advertising",         label: "Advertising & marketing",         group: "Operating expenses" },
  { value: "insurance",           label: "Business insurance",              group: "Operating expenses" },
  { value: "health_insurance",    label: "Health insurance premiums",       group: "Operating expenses" },
  { value: "professional",        label: "Professional & legal fees",       group: "Operating expenses" },
  { value: "payroll",             label: "Payroll & contractors",           group: "Operating expenses" },
  { value: "commissions",         label: "Sales commissions & rep payouts", group: "Operating expenses" },
  { value: "retirement",          label: "Retirement contributions",        group: "Operating expenses" },
  { value: "education",           label: "Training & education",            group: "Operating expenses" },
  { value: "gifts",               label: "Client gifts",                    group: "Operating expenses" },
  { value: "charity",             label: "Charitable contributions",        group: "Operating expenses" },
  { value: "fee",                 label: "Bank & wire fees",                group: "Operating expenses" },
  { value: "merchant_fees",       label: "Card & processing fees",          group: "Operating expenses" },
  { value: "interest_expense",    label: "Loan & credit card interest",     group: "Operating expenses" },
  { value: "other_expense",       label: "Other expense",                   group: "Operating expenses" },

  { value: "taxes",               label: "Business & franchise taxes",      group: "Taxes & licences" },
  { value: "payroll_taxes",       label: "Payroll taxes",                   group: "Taxes & licences" },
  { value: "sales_tax_collected", label: "Sales tax collected",             group: "Taxes & licences" },
  { value: "sales_tax_remitted",  label: "Sales tax paid to the state",     group: "Taxes & licences" },
  { value: "licenses",            label: "Licences, permits & filings",     group: "Taxes & licences" },
  { value: "estimated_tax",       label: "Owner estimated tax (personal)",  group: "Taxes & licences" },

  { value: "internal_transfer",   label: "Internal transfer",               group: "Transfers, owner & assets" },
  { value: "card_payment",        label: "Credit card payment",             group: "Transfers, owner & assets" },
  { value: "owner_draw",          label: "Owner draw",                      group: "Transfers, owner & assets" },
  { value: "owner_contribution",  label: "Owner contribution",              group: "Transfers, owner & assets" },
  { value: "asset_purchase",      label: "Equipment or vehicle bought",     group: "Transfers, owner & assets" },
  { value: "cash_in",             label: "Cash deposit",                    group: "Transfers, owner & assets" },
  { value: "cash_out",            label: "Cash withdrawal",                 group: "Transfers, owner & assets" },
  // Backend-written: tag a transaction to a loan and the category follows the
  // direction. Shown with a real label, never offered in a picker.
  { value: "loan_received",       label: "Loan received",                   group: "Transfers, owner & assets", hidden: true },
  { value: "loan_repayment",      label: "Loan repayment",                  group: "Transfers, owner & assets", hidden: true },
];

// What a category means at filing time, for the ones where picking the wrong
// neighbour changes the return. Shown under the picker in the detail pane, so
// the distinction is readable at the moment of choosing rather than in a manual.
const CAT_HINTS: Record<string, string> = {
  service_income:      "Brokerage or commission you earned, not goods you sold",
  shipping_income:     "Freight you charged the customer — income, not a cost offset",
  customer_refund:     "Money back to a buyer. Reduces sales, never counts as cost of goods",
  sales_discount:      "A price break or allowance granted after the sale",
  bad_debt:            "An invoice you have given up on collecting",
  customs:             "Duty, tariff and customs-broker charges on an imported lot",
  packaging:           "Boxes, pallets, labels and shipping materials",
  storage:             "3PL, pallet and warehousing charges tied to stock",
  supplier_refund:     "A supplier reversal or credit. Lowers what the goods cost you",
  purchase_discount:   "A rebate or early-payment discount from a supplier",
  health_insurance:    "Your own premiums — deducted separately from business expenses",
  retirement:          "SEP or solo 401(k) contributions — deducted on the personal return",
  commissions:         "What you paid a rep or partner out of a deal",
  merchant_fees:       "Stripe, Shopify, PayPal and card-processing charges",
  interest_expense:    "Interest only. The principal of a loan repayment is not an expense",
  gifts:               "Deductible up to $25 per recipient per year",
  equipment:           "Cheap, short-lived tools. Anything lasting years is an asset purchase",
  taxes:               "Business taxes only. Your own income tax is Owner estimated tax",
  sales_tax_collected: "Not income — you are holding it for the state",
  sales_tax_remitted:  "Handing the state what you collected. Not an expense",
  estimated_tax:       "Your personal income tax. NOT a business deduction",
  owner_draw:          "Money you took out. Not a deduction",
  owner_contribution:  "Money you put in. Not income",
  asset_purchase:      "Something with years of life — depreciated, not expensed this year",
  card_payment:        "Paying down a card. The charges themselves are the expense",
};

const CAT_GROUP_ORDER = ["Income", "Sales reductions", "Cost of goods", "Cost reductions",
                         "Operating expenses", "Taxes & licences", "Transfers, owner & assets"];

// The ONLY categories whose money can belong to a deal. Everything else — every
// operating expense, every transfer, owner draw, card payment — is fully booked by
// its category and must never be counted as deal work. Blank stays in because an
// uncategorised wire is usually exactly the buyer payment that needs tying; it is
// the "we don't know yet" case, not the "definitely not a deal" case.
//
// This list is duplicated in Rust in TWO places — `bank_txn_summary` and
// `financials_overview.stale_unallocated` (`commands.rs`). All three must move
// together or the queue count, the summary figure and the Overview alert start
// disagreeing about the same rows, which is the bug this replaced.
const DEAL_CAPABLE_CATEGORIES = ["", "receipt", "payment", "merchandise", "shipping", "customs",
                                 "customer_refund", "supplier_refund", "cash_in", "cash_out"];

// Does this transaction still owe someone a link to a deal?
const needsADeal = (t: BankTxn) =>
  t.counterparty_type !== "loan" &&
  DEAL_CAPABLE_CATEGORIES.includes(t.category || "") &&
  t.unallocated > 0.0001;

// Grouped <option>s for any category <select>. Set includeUncat={false} to omit
// the blank "Uncategorized" entry (e.g. a "Set category…" placeholder select).
function CategoryOptions({ includeUncat = true }: { includeUncat?: boolean }) {
  return (
    <>
      {includeUncat && <option value="">Uncategorized</option>}
      {CAT_GROUP_ORDER.map((g) => (
        <optgroup key={g} label={g}>
          {CATEGORIES.filter((c) => c.group === g && !c.hidden).map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

// Labels answer "what IS this money?", not "which accounting role?". Jack booked
// real refunds as supplier payments because "Refund out" reads as jargon next to
// "Supplier payment" and nothing said which one a refund to a buyer is. The two are
// NOT interchangeable: deal_bank_actuals puts supplier_payment into cost, while
// net_profit is deliberately pre-refund and refund_out is excluded from cost
// entirely — so mis-picking silently moves a deal's recorded profit.
const ROLES: { value: string; label: string; hint?: string }[] = [
  { value: "buyer_payment",    label: "Payment from the buyer",       hint: "Money the customer paid you for this deal" },
  { value: "supplier_payment", label: "Payment to the supplier",      hint: "What the goods cost you — counts as cost of the deal" },
  { value: "refund_out",       label: "Refund back to the buyer",     hint: "Money returned to your customer — does not change the deal's cost" },
  { value: "refund_in",        label: "Money back from the supplier", hint: "A supplier reversal — lowers what this deal cost you" },
  { value: "adjustment",       label: "Adjustment" },
];

const roleLabel = (v: string) => ROLES.find((r) => r.value === v)?.label ?? v;
const catLabel = (v: string) => CATEGORIES.find((c) => c.value === v)?.label ?? (v || "Uncategorized");
// Identify a deal by its BUYER first — an invoice number alone is meaningless when
// scanning for the right deal to tie a payment to.
const dealLabel = (d: DealFlow) =>
  d.client_name?.trim() || d.name?.trim() || (d.invoice_number ? `Invoice #${d.invoice_number}` : "Untitled deal");

const fmtShortDate = (s?: string | null) => {
  if (!s) return "";
  const d = parseLocalDay(s); // bare bank dates parse at local midnight (R-159 — UTC parse rendered them a day early)
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

// Time-of-day from a bank timestamp (Plaid datetime), e.g. "2:40 PM". Empty when the
// bank didn't provide one or the string is date-only.
const fmtTime = (s?: string | null) => {
  if (!s || !s.includes("T")) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

// Does this deal plausibly match a bank transaction — same buyer name, or same
// amount as the invoice? Drives the "match" badge + surfacing the right deal.
const dealMatchesTxn = (d: DealFlow, txn: { counterparty_name?: string | null; amount: number }) => {
  const cp = (txn.counterparty_name || "").trim().toLowerCase();
  const byName = cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp);
  const byAmount = !!txn.amount && !!d.invoice_total && Math.abs(d.invoice_total - txn.amount) < 0.5;
  return byName || byAmount;
};

// The one obvious deal for a transaction — same signals the deal picker ranks by
// (payer name, exact invoice amount), but only surfaced when EXACTLY ONE deal in the
// pool carries them. Two deals for the same amount, or a repeat buyer with several
// open deals, means the answer isn't obvious, so the row says nothing rather than
// guessing loudly. Pass survivorDeals(deals) — never the raw list — so a suggestion
// can't land on a duplicate deal_flow row the deal view hides.
const CONFIDENT_SCORE = 60;
const confidentMatch = (t: BankTxn, pool: DealFlow[]): { deal: DealFlow; reason: string } | null => {
  // Loan-tagged rows aren't deals; anything already tied (in part or in full) is a
  // deliberate allocation and must not be second-guessed by a one-click button.
  if (t.counterparty_type === "loan") return null;
  if (t.allocated > 0.0001) return null;
  if (!(t.unallocated > 0.0001)) return null;
  const cp = (t.counterparty_name || "").trim().toLowerCase();
  const hits: { d: DealFlow; score: number }[] = [];
  for (const d of pool) {
    let score = 0;
    if (cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp)) score += 100;
    if (t.amount && d.invoice_total && Math.abs(d.invoice_total - t.amount) < 0.5) score += 60;
    if (score >= CONFIDENT_SCORE) hits.push({ d, score });
  }
  if (hits.length !== 1) return null;
  const { d, score } = hits[0];
  return {
    deal: d,
    reason:
      score >= 160 ? "payer name and exact amount match"
      : score >= 100 ? "payer name matches"
      : "exact amount match",
  };
};

// "#0041 · Costco pallets" — invoice first, then who the deal is with. Falls back to
// one or the other when the deal carries no name beyond its invoice number.
const matchLabel = (d: DealFlow) => {
  const inv = d.invoice_number ? `#${d.invoice_number}` : "";
  const name = dealLabel(d);
  if (!inv) return name;
  return name === `Invoice #${d.invoice_number}` ? inv : `${inv} · ${name}`;
};

// Server-scored suggestion for a transaction (R-150): the mirror engine weighs
// bank metadata (payer/payee/by_order_of, merchant), amounts against invoice
// totals and unpaid supplier legs, date proximity, and invoice-number hits.
// Only surfaced when unambiguous — a top candidate rated certain/strong with no
// near-equal second — matching the local matcher's "say nothing rather than
// guess loudly" rule.
const serverMatchFor = (t: BankTxn, pool: DealFlow[], cands?: BankSuggestCandidate[]):
  { deal: DealFlow; reason: string; candidate: BankSuggestCandidate } | null => {
  if (!cands || cands.length === 0) return null;
  if (t.allocated > 0.0001) return null;
  if (!(t.unallocated > 0.0001)) return null;
  const top = cands[0];
  if (top.tier !== "certain" && top.tier !== "strong") return null;
  const second = cands[1];
  if (second && (second.tier === "certain" || top.score - second.score < 20)) return null;
  const deal = pool.find((d) => d.id === top.deal_id);
  if (!deal) return null;
  return { deal, reason: top.reason, candidate: top };
};

// A rich, scannable deal row: buyer · date · amount · completed/open — used by both
// the allocate picker and the bulk-tag modal so they stay identical.
function DealRowContent({ d, match }: { d: DealFlow; match?: boolean }) {
  const invLabel = d.invoice_number ? `Invoice #${d.invoice_number}` : "";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-ink truncate flex items-center gap-1.5">
          <span className="truncate">{dealLabel(d)}</span>
          {match && <span className="text-[10px] text-accent font-semibold flex-shrink-0">match</span>}
        </div>
        <div className="text-[11px] text-muted truncate">
          {d.completed_at ? fmtShortDate(d.completed_at) : "In progress"}
          {invLabel && dealLabel(d) !== invLabel ? ` · #${d.invoice_number}` : ""}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[12px] tabular-nums text-ink-2">{d.invoice_total ? fmtAmount(d.invoice_total) : "—"}</div>
        <div className={`text-[10px] ${d.stage === "complete" ? "text-success-ink" : "text-muted"}`}>
          {d.stage === "complete" ? "Completed" : "Open"}
        </div>
      </div>
    </div>
  );
}
const loanLabel = (l: Loan) => (l.name?.trim() || l.lender?.trim() || "Loan");
// Loan tags live on the txn (counterparty_type "loan"); the backend derives the
// category by direction — money-in is a loan drawdown, money-out a repayment.
const loanTagLabel = (direction: string) => (direction === "in" ? "Loan received" : "Loan repayment");

// Roles valid for a transaction's direction (must match the backend guard in
// allocate_bank_txn — money-in can't be a supplier payment, etc.).
const rolesFor = (direction: string) =>
  direction === "out"
    ? ROLES.filter((r) => ["supplier_payment", "refund_out"].includes(r.value))
    : ROLES.filter((r) => ["buyer_payment", "refund_in"].includes(r.value));

// ── Payment method (R-157) ──────────────────────────────────────────────────
// MEASURED on the live ledger 2026-08-17, 1,342 transactions: Plaid returns NO
// payment_meta for this institution. 0 rows carry a `pm` block, 0 carry
// `pm.payment_method`, and `wire_ref` / `check_num` are empty on all 1,342. A
// field-based method filter would therefore match nothing at all — so this reads
// the MEMO, and reads a real field only if some future institution supplies one.
//
// THREE states, never two:
//   certain       `confirmed_method` is stored on the row — a human answered — or
//                 the bank sent a real structured field. The only things treated
//                 as fact.
//   likely        the memo matched, or `rail` carries the importer's own memo
//                 guess, or another transaction from the same payee is confirmed.
//                 A guess, labelled as one, and NEVER written down.
//   unclassified  nothing readable. Counted and shown, never quietly dropped.
//
// `rail` IS NOT A CONFIRMATION and must never be read as one. `bank_import`'s
// `classify()` string-matches the raw memo and persists `rail` on every statement
// parse path (OFX, CSV, PDF) — its own doc comment says "This is a SUGGESTION
// only". Replaying it over this ledger's 1,342 rows sets a non-empty `rail` on 690
// of them, disagreeing with the classifier below on 43. Reading `rail` as certain
// would render those 690 guesses as facts, and `methodMemory` would then teach
// from them — laundering a guess into "you confirmed this payee pays by wire".
// That is exactly what R-018 forbids: only a confirmed row may teach. So the
// human's answer lives in its own column, `confirmed_method` (migration 78).
//
// The unclassified count rides in the filter control itself and again in a line
// under the toolbar whenever a method is selected. A heuristic filter that hides
// what it could not read is a filter that lies, and money filters that lie have
// cost real money here before.
export type BankMethod = "wire" | "ach" | "zelle" | "rtp" | "check" | "card" | "cash" | "transfer";

// MUST stay identical to BANK_METHODS in commands.rs — the backend rejects any
// value outside it, so a method added on one side alone silently fails to save.
const METHODS: { value: BankMethod; label: string }[] = [
  { value: "wire",     label: "Wire" },
  { value: "ach",      label: "ACH" },
  { value: "zelle",    label: "Zelle" },
  { value: "rtp",      label: "Real-time payment" },
  { value: "check",    label: "Check" },
  { value: "card",     label: "Card" },
  { value: "cash",     label: "Cash" },
  { value: "transfer", label: "Internal transfer" },
];
const methodLabel = (v: string) => METHODS.find((m) => m.value === v)?.label ?? v;

// Ordered — the FIRST match wins, so a specific rail beats the generic wording it
// contains: "ONLINE DOMESTIC WIRE TRANSFER" is a wire, not a transfer, and "REAL
// TIME PAYMENT CREDIT" is RTP, not a transfer.
//
// Counts over the live ledger 2026-08-17 (1,342 rows): wire 188 · rtp 192 ·
// ach 171 · zelle 85 · transfer 68 · cash 14 · check 3 · unclassified 621.
//
// `card` has NO pattern on purpose. This bank prints a card purchase as the
// merchant alone ("AplPay THORNTONS #22LOCKPORT"), and the only rows containing
// the word "card" are "Payment to Chase card ending in 2623" — paying a card OFF,
// not paying BY card. Guessing there would be worse than saying nothing, so card
// purchases stay unclassified until Jack sets one, and the count says how many.
const METHOD_PATTERNS: { method: BankMethod; re: RegExp; reason: string }[] = [
  { method: "wire",     re: /\bFEDWIRE\b/,                     reason: "memo says FEDWIRE" },
  { method: "wire",     re: /\bWIRE TYPE\b/,                   reason: "memo says WIRE TYPE" },
  { method: "wire",     re: /\bWIRE TRANSFER\b/,               reason: "memo says WIRE TRANSFER" },
  { method: "wire",     re: /\bWIRE\b/,                        reason: "memo says WIRE" },
  { method: "wire",     re: /\bCHIPS\b/,                       reason: "memo says CHIPS, a wire clearing house" },
  { method: "wire",     re: /\bBOOK TRANSFER\b/,               reason: "memo says BOOK TRANSFER, a same-bank wire" },
  { method: "zelle",    re: /\bZELLE\b/,                       reason: "memo says ZELLE" },
  { method: "zelle",    re: /\bQUICKPAY\b/,                    reason: "memo says QUICKPAY" },
  { method: "rtp",      re: /\bREAL TIME (?:PAYMENT|TRANSFER)\b/, reason: "memo says REAL TIME PAYMENT" },
  { method: "rtp",      re: /\bRTP\b/,                         reason: "memo says RTP" },
  { method: "check",    re: /\bCHECK\s*#/,                     reason: "memo carries a check number" },
  { method: "ach",      re: /\bACH\b/,                         reason: "memo says ACH" },
  { method: "ach",      re: /\bORIG CO NAME\b/,                reason: "memo carries an ACH originator block" },
  { method: "ach",      re: /\b(?:PPD|CCD)\b/,                 reason: "memo carries an ACH entry class" },
  { method: "cash",     re: /\bATM\b/,                         reason: "memo says ATM" },
  { method: "cash",     re: /\bCASH (?:DEPOSIT|WITHDRAWAL)\b/, reason: "memo says cash" },
  { method: "cash",     re: /\bTELLER\b/,                      reason: "memo says TELLER" },
  { method: "transfer", re: /\bONLINE TRANSFER\b/,             reason: "memo says ONLINE TRANSFER" },
  { method: "transfer", re: /\bTRANSFER (?:TO|FROM)\b/,        reason: "memo says transfer to/from an account" },
];

// Plaid's `payment_method` is free text and its vocabulary is the institution's,
// not ours. Anything unrecognised returns null and falls through to the memo —
// mapping an unknown string onto a method would be inventing a fact.
const bankFieldMethod = (raw?: string | null): BankMethod | null => {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("wire")) return "wire";
  if (v.includes("zelle")) return "zelle";
  if (v.includes("ach") || v.includes("standard entry")) return "ach";
  if (v.includes("check") || v.includes("cheque")) return "check";
  if (v.includes("card")) return "card";
  if (v.includes("cash")) return "cash";
  if (v.includes("rtp") || v.includes("real-time") || v.includes("real time")) return "rtp";
  if (v.includes("transfer")) return "transfer";
  return null;
};

// Payee + direction, the same key `suggestedGroups` clusters by: a Zelle TO
// "Walmart Loads" must never be pooled with a purchase FROM "Walmart".
const payeeKey = (t: BankTxn) => `${(t.counterparty_name || "").trim().toLowerCase()}|${t.direction}`;

type MethodRead = { method: BankMethod | ""; state: "certain" | "likely" | "unclassified"; reason: string };

// Read a transaction's payment method. `taught` maps payee+direction → the method
// its CONFIRMED rows carry (see methodMemory) — per-row memo evidence still wins
// over it, because a payee rule is a generalisation and the memo is the actual
// transaction. Correcting a whole payee writes `confirmed_method` on every row,
// which is `certain` and beats both.
//
// Order matters. Only the first two branches are facts; everything below them is
// evidence, and `rail` sits down there with the rest of the guesswork because that
// is what it is.
const readMethod = (t: BankTxn, taught: Map<string, BankMethod>): MethodRead => {
  if (t.confirmed_method) return { method: t.confirmed_method as BankMethod, state: "certain", reason: "set by hand" };
  const field = bankFieldMethod(t.bank_method);
  if (field) return { method: field, state: "certain", reason: "the bank supplied it" };
  const hay = `${t.description || ""} ${t.counterparty_name || ""}`.toUpperCase();
  const hit = METHOD_PATTERNS.find((p) => p.re.test(hay));
  if (hit) return { method: hit.method, state: "likely", reason: hit.reason };
  // The importer's own memo guess, stored on the row by bank_import::classify.
  // `likely`, never `certain` — nobody answered this.
  if (t.rail) return { method: t.rail as BankMethod, state: "likely", reason: "the statement importer read it off the memo" };
  const learned = taught.get(payeeKey(t));
  if (learned) return { method: learned, state: "likely", reason: `you confirmed this payee pays by ${methodLabel(learned).toLowerCase()}` };
  return { method: "", state: "unclassified", reason: "" };
};

// W2-e — the wire detail. There is no bank field to read: `wire_ref` and
// `check_num` are empty on all 1,342 rows and there is no payment_meta, so the
// reference lines are parsed out of the memo the bank does print. Display only;
// nothing here is stored, and a memo that carries none of it simply shows none.
// 466 of 1,342 rows yield at least one of these (measured 2026-08-17).
const MEMO_TAGS = "REF|TRN|VIA|A\\/C|B\\/O|SSN|ORG|BNF|IMAD|OMAD|RFB|TRACE#";
const memoField = (memo: string, tag: string): string => {
  const m = new RegExp(`\\b${tag}:\\s*(.+?)(?=\\s+(?:${MEMO_TAGS})\\b\\s*[:=]|$)`, "i").exec(memo);
  return (m?.[1] || "").trim();
};
const wireDetail = (t: BankTxn): { label: string; value: string }[] => {
  const memo = t.description || "";
  const out: { label: string; value: string }[] = [];
  const push = (label: string, value: string) => { if (value) out.push({ label, value }); };
  push("By order of", memoField(memo, "B\\/O"));
  push("Account", memoField(memo, "A\\/C"));
  push("Via", memoField(memo, "VIA"));
  push("Reference", t.wire_ref?.trim() || memoField(memo, "REF"));
  push("Trace", memoField(memo, "TRN"));
  return out;
};

// ── The person on a transaction (R-156) ─────────────────────────────────────
// A counterparty tag is IDENTITY, not accounting: it says WHO the money is from
// or to, while the allocation says WHAT it paid for. Tagging must never move deal
// profit, cost, Free Cash or any reconciliation figure — nothing in this file
// reads counterparty_type/id into a total, and nothing here may start.
const personTypeLabel = (t: string) => (t === "supplier" ? "Supplier" : "Client");

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Collapse duplicate deal_flow rows for one invoice to the single highest-stage
// survivor — the same row Deal Flow shows — so an allocation (single OR bulk) can
// never land on a ghost duplicate the deal view hides.
const DEAL_STAGE_RANK: Record<string, number> = { invoiced: 0, payment_received: 1, supplier_paid: 2, complete: 3 };
const survivorDeals = (deals: DealFlow[]): DealFlow[] => {
  const byInv: Record<string, DealFlow> = {};
  for (const d of deals) {
    const key = d.invoice_id || d.id;
    const prev = byInv[key];
    if (!prev || (DEAL_STAGE_RANK[d.stage || ""] ?? -1) > (DEAL_STAGE_RANK[prev.stage || ""] ?? -1)) byInv[key] = d;
  }
  return Object.values(byInv);
};

// R-019. What the last bank sync declined to load, and why. The feed can never be made
// infallible — the bank decides what it hands over — so the contract is that a miss is
// never silent. These fields ride on the sync result; they are declared here rather than
// on PlaidSyncSummary because api.ts is owned elsewhere this cycle.
type SyncSkip = {
  date?: string; amount?: number; direction?: string;
  account?: string; description?: string; reference?: string;
};
type SyncSkips = {
  already_held: number;
  skipped_duplicate: SyncSkip[];
  skipped_no_id: string[];
  skipped_unsaved: string[];
  amend_unknown: number;
  page_capped: string[];
  possible_duplicates: SyncSkip[];
};
const readSkips = (r: PlaidSyncSummary): SyncSkips => {
  const x = r as PlaidSyncSummary & Partial<SyncSkips>;
  return {
    already_held: x.already_held ?? 0,
    skipped_duplicate: x.skipped_duplicate ?? [],
    skipped_no_id: x.skipped_no_id ?? [],
    skipped_unsaved: x.skipped_unsaved ?? [],
    amend_unknown: x.amend_unknown ?? 0,
    page_capped: x.page_capped ?? [],
    possible_duplicates: x.possible_duplicates ?? [],
  };
};
// Anything worth showing at all. `already_held` alone is an ordinary replay, not a miss.
const anySkips = (s: SyncSkips): boolean =>
  s.skipped_duplicate.length > 0 || s.skipped_no_id.length > 0 || s.skipped_unsaved.length > 0 ||
  s.amend_unknown > 0 || s.page_capped.length > 0 || s.possible_duplicates.length > 0;
const skipLine = (s: SyncSkip): string =>
  [s.date, s.amount === undefined ? "" : fmtAmount(s.amount), s.description, s.account]
    .filter(Boolean).join(" · ");

export default function FinancialsView() {
  const [txns, setTxns]       = useState<BankTxn[]>([]);
  const [summary, setSummary] = useState<BankTxnSummary | null>(null);
  const [deals, setDeals]     = useState<DealFlow[]>([]);
  const [loans, setLoans]     = useState<Loan[]>([]);
  const [rules, setRules]     = useState<TxnRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Four surfaces: To book (the daily queue) opens first; Ledger is the full
  // history; Cash holds Free cash + Loans; Setup is every once-in-a-while tool.
  // The chosen surface survives leaving and re-entering the page — losing your
  // place on every visit was one of the audit's standing complaints.
  const [tab, setTabRaw] = useState<"tobook" | "ledger" | "cash" | "setup">(() => {
    const t = localStorage.getItem("fin_tab");
    return t === "ledger" || t === "cash" || t === "setup" ? t : "tobook";
  });
  const setTab = (v: "tobook" | "ledger" | "cash" | "setup") => {
    setTabRaw(v);
    localStorage.setItem("fin_tab", v);
  };
  const [cashTab, setCashTab] = useState<"freecash" | "loans">("freecash");
  const [aiBusy, setAiBusy]   = useState(false);
  const [newDealBusy, setNewDealBusy] = useState(false);
  // Record-cash modal (a manual cash txn that then allocates across deals).
  const [cashOpen, setCashOpen]     = useState(false);
  const [cashAmount, setCashAmount] = useState("");
  const [cashDir, setCashDir]       = useState<"in" | "out">("in");
  const [cashDate, setCashDate]     = useState("");
  const [cashCp, setCashCp]         = useState("");
  const [cashNote, setCashNote]     = useState("");
  const [cashSaving, setCashSaving] = useState(false);

  // Import — default to the last account used on this device (generic fallback).
  const [accountId, setAccountId]     = useState(() => localStorage.getItem("fin_last_account") || "business");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview]         = useState<BankPreview | null>(null);
  const [importing, setImporting]     = useState(false);
  const [clearing, setClearing]       = useState(false);

  // Bulk import (multiple statement files in one go)
  const [bulkBusy, setBulkBusy]         = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");

  // Bank feed (Plaid) — live transactions straight from the bank
  const [plaidReady, setPlaidReady]         = useState<boolean | null>(null); // has keys
  const [plaidItems, setPlaidItems]         = useState<PlaidItem[]>([]);
  const [plaidClientId, setPlaidClientId]   = useState("");
  const [plaidSecret, setPlaidSecret]       = useState("");
  const [plaidSavingKeys, setPlaidSavingKeys] = useState(false);
  const [plaidConnecting, setPlaidConnecting] = useState(false);
  const [plaidSyncing, setPlaidSyncing]     = useState(false);
  const [dedupe, setDedupe]                 = useState<DedupeResult | null>(null); // preview/result modal
  const [dedupeRunning, setDedupeRunning]   = useState(false);
  const [dedupeDone, setDedupeDone]         = useState(false); // modal is showing the post-run report
  const [dedupeAggressive, setDedupeAggressive] = useState(false); // remove every exact match, not just safe ones
  const [backupUrl, setBackupUrl]           = useState("");    // Google Sheet safety-log URL
  const [backupEnabled, setBackupEnabled]   = useState(false);
  const [backupLast, setBackupLast]         = useState<{ at: string; total: string }>({ at: "", total: "" });
  const [backupBusy, setBackupBusy]         = useState(false);
  const [plaidEnv, setPlaidEnv]             = useState<"sandbox" | "production">("sandbox");
  const [plaidTesting, setPlaidTesting]     = useState(false);
  const [showKeys, setShowKeys]             = useState(false); // reveal the keys/env form once set up
  const [bankFeedOpen, setBankFeedOpen]     = useState(false); // collapse the whole feed panel once connected
  // Did the last importing sync carry Plaid's pending_transaction_id? Drives the
  // one-line health note in Setup; "unknown" until a sync actually imports something.
  const [pendingRefSeen, setPendingRefSeen] = useState<"unknown" | "yes" | "no">("unknown");
  // R-019: what the last sync declined to load. Kept on screen rather than only in a
  // toast — a transaction that never arrived is exactly the thing you find out about
  // hours later, and a notice that has already faded is no notice at all.
  const [syncSkips, setSyncSkips] = useState<SyncSkips | null>(null);
  // Plaid is still extracting a freshly-linked bank's history (a 2-year pull can
  // take ~a minute) — keep re-syncing in the background until transactions land.
  const [plaidPreparing, setPlaidPreparing] = useState(false);
  // Hosted Link connect flow — poll the browser-based connect to completion.
  const pollTimerRef  = useRef<number | null>(null);
  const pollCancelRef = useRef(false);
  const prepTimerRef  = useRef<number | null>(null);

  // AI import (any statement — credit cards / other banks)
  const [aiPreviewPath, setAiPreviewPath] = useState<string | null>(null);
  const [aiPreview, setAiPreview]         = useState<BankAiPreview | null>(null);
  const [aiExtracting, setAiExtracting]   = useState(false);
  const [previewing, setPreviewing]       = useState(false); // parsing a single statement for preview
  const [aiImporting, setAiImporting]     = useState(false);

  // Filters
  const [search, setSearch]           = useState("");
  const [dirFilter, setDirFilter]     = useState<"all" | "in" | "out">("all");
  const [acctFilter, setAcctFilter]   = useState("all");
  const [catFilter, setCatFilter]     = useState("all");
  // Payment method (R-157/W2-a) — "all", one method, or the unclassified pile.
  // "unclassified" is a first-class choice, not an absence: it is the pile Jack
  // works down, and it is how the filter stays honest about what it could not read.
  const [methodFilter, setMethodFilter] = useState<"all" | BankMethod | "unclassified">("all");
  // The person on a transaction (R-156/W2-f) — "all", "linked" (anyone),
  // "none" (nobody), or "client:ID" / "supplier:ID" for one party.
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "unclassified" | "unallocated_in" | "unallocated_out"
  >("all");
  // The Ledger is a tax-year view by default (R-145): each year's transactions stand
  // alone, because the books are read per tax year. Custom from/to stays available.
  const [fromDate, setFromDate]       = useState(`${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate]           = useState(`${new Date().getFullYear()}-12-31`);

  // Ledger scope: the full history by default; To book / Booked narrow it.
  const [queue, setQueue]             = useState<"all" | "todo" | "booked">("all");

  // To-book queue controls — search and account only. A queue is a queue: no date
  // window, no status dropdowns, nothing that silently hides work.
  const [toBookSearch, setToBookSearch] = useState("");
  const [toBookAcct, setToBookAcct]     = useState("all");

  // Split view: money-in and money-out side by side, each with its own search —
  // for reconciling a refund against the original payment. Plus a collapse that
  // tucks away rows still missing a category so they don't clutter the list.
  const [splitView, setSplitView]     = useState(false);
  const [searchIn, setSearchIn]       = useState("");
  const [searchOut, setSearchOut]     = useState("");

  // Inline payee rename. Plaid mislabels transfers constantly (a Zelle to a person
  // shows as a store), so the fix lives in the row itself — the old prompt() sat
  // behind a hover-only pencil and so didn't exist on touch at all.
  const [payeeEditId, setPayeeEditId] = useState<string | null>(null);
  const [payeeDraft, setPayeeDraft]   = useState("");
  // Escape blurs the input, and blur commits — this flag tells the two apart.
  const payeeCancelRef = useRef(false);

  // Smart grouping suggestions — dismissed groups (payee|dir keys) + per-group
  // category overrides for the session.
  const [dismissedGroups, setDismissedGroups]   = useState<Set<string>>(new Set());
  const [groupCatOverride, setGroupCatOverride] = useState<Record<string, string>>({});

  // Bulk selection + actions (clean a year fast — loop existing commands).
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [bulkCat, setBulkCat]           = useState("");
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [bulkAllocOpen, setBulkAllocOpen]   = useState(false);
  const [aiProgress, setAiProgress]     = useState("");

  // Allocation panel (inline expanding row)
  const [openId, setOpenId]           = useState<string | null>(null);
  const [allocs, setAllocs]           = useState<BankAllocation[]>([]);
  const [allocLoading, setAllocLoading] = useState(false);

  // A linked transaction clicked from the Deal Flow section hands off its id via
  // window.__pendingBankTxn, then navigates here. Pick it up on mount, then (once the
  // txn list has loaded) open its detail via the same toggleRow the row click uses and
  // scroll it into view — so the click lands you right on that transaction.
  const pendingOpenRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = (window as any).__pendingBankTxn;
    if (pending) {
      pendingOpenRef.current = pending;
      (window as any).__pendingBankTxn = null;
      // Open every filter first. The ledger defaults to the current tax year and
      // whatever facets were last used; a jump that lands on a row those filters
      // hide does nothing at all and reads as a dead link (R-170).
      setTab("ledger");
      setPersonFilter("all"); setQueue("all"); setDirFilter("all"); setAcctFilter("all");
      setCatFilter("all"); setStatusFilter("all"); setMethodFilter("all");
      setSearch(""); setFromDate(""); setToDate("");
    }
  }, []);
  useEffect(() => {
    const id = pendingOpenRef.current;
    if (!id) return;
    const t = txns.find((x) => x.id === id);
    if (!t) return;
    pendingOpenRef.current = null;
    if (openId !== id) toggleRow(t);
    setTimeout(() => {
      document.querySelector(`[data-txn-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns]);

  // W2-f — the landing site for "See all in Financials" on a client or supplier
  // profile. The profile sets
  //     window.__financialsPerson = { type: "client" | "supplier", id }
  // and navigates here, the same handoff shape as __pendingBankTxn above.
  //
  // Every OTHER filter is opened up at the same time. The ledger defaults to the
  // current tax year, and a person's payments very often sit outside it — landing
  // on an empty list after clicking "see all" would read as "there are none",
  // which is the filter-that-lies failure this plan exists to avoid.
  useEffect(() => {
    const p = (window as any).__financialsPerson;
    if (!p?.type || !p?.id) return;
    (window as any).__financialsPerson = null;
    setPersonFilter(personKey(p));
    setTab("ledger");
    setQueue("all"); setDirFilter("all"); setAcctFilter("all"); setCatFilter("all");
    setStatusFilter("all"); setMethodFilter("all"); setSearch("");
    setFromDate(""); setToDate("");
  }, []);

  const [targetType, setTargetType]   = useState<"deal" | "loan" | "expense">("deal");
  const [dealQuery, setDealQuery]     = useState("");
  const [selectedDeal, setSelectedDeal] = useState<DealFlow | null>(null);
  const [dealListOpen, setDealListOpen] = useState(false);
  const [loanQuery, setLoanQuery]     = useState("");
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [loanListOpen, setLoanListOpen] = useState(false);
  const [amountStr, setAmountStr]     = useState("");
  const [role, setRole]               = useState("buyer_payment");
  const [note, setNote]               = useState("");
  const [allocBusy, setAllocBusy]     = useState(false);
  // Which row's one-click "Tie it" is in flight (id, not a bool, so only that row spins).
  const [tyingId, setTyingId]         = useState<string | null>(null);
  // Split mode: allow one transaction to be divided across multiple deals (partial
  // amounts, leg by leg). The backend keeps the running total <= the txn amount.
  const [allowSplit, setAllowSplit]   = useState(false);
  // A failed first load must never render as "No transactions yet" — that reads as
  // data loss and hides the real cause. Hold the message and offer a retry.
  const [loadError, setLoadError]     = useState<string | null>(null);
  const [refreshing, setRefreshing]   = useState(false);
  // Latest refreshAll, for the mounted-once sync listener (see below).
  const refreshRef = useRef<((keepOpen?: boolean) => Promise<void>) | null>(null);
  // Server-scored smart links (R-150) — txn id → ranked candidate deals. Empty
  // when the server is unreachable; the local matcher stays as the fallback.
  const [serverSugg, setServerSugg] = useState<Map<string, BankSuggestCandidate[]>>(new Map());
  // R-156/W1-b — the same server pass, read as a PERSON rather than a deal. Empty
  // until deploy-41 lands; the picker's search works regardless.
  const [personSugg, setPersonSugg] = useState<Map<string, BankPersonCandidate[]>>(new Map());
  // Both sides of the address book, for the person picker and the person filter.
  const [people, setPeople] = useState<PersonRef[]>([]);
  // Which transaction's person picker is open (W1-a). One modal, two entry points:
  // the ledger row and the booking sheet.
  const [personPickerFor, setPersonPickerFor] = useState<string | null>(null);
  const [personBusy, setPersonBusy] = useState<string | null>(null);
  // After an inline payee RENAME, offer the link the rename does not make. Renaming
  // a payee to "Tytan" edits a free-text string and puts nothing on Tytan's profile;
  // that has actively confused Jack, so the offer says so out loud.
  const [linkOfferFor, setLinkOfferFor] = useState<string | null>(null);
  // After a method is set by hand, offer to remember it for the whole payee (W2-d).
  const [methodOffer, setMethodOffer] = useState<
    { txnId: string; payee: string; direction: "in" | "out"; method: BankMethod; ids: string[] } | null
  >(null);
  const [methodBusy, setMethodBusy] = useState(false);
  // R-150 phase 5 — completed deals whose payments were never bank-linked.
  const [missingLinks, setMissingLinks] = useState<ReconciliationMissingDeal[]>([]);
  const [missingLinksOpen, setMissingLinksOpen] = useState(false);
  const [missingLinksLoading, setMissingLinksLoading] = useState(false);
  // Scan scope: the server caps at the 30 newest completed deals; `truncated`
  // means older deals were left unscanned, so an empty list isn't an all-clear.
  const [missingLinksScope, setMissingLinksScope] = useState<{ checked?: number; truncated?: boolean }>({});
  const [attachBusy, setAttachBusy] = useState<string | null>(null);

  // Fetch server-scored suggestions without blocking the ledger load — hints are
  // optional; a slow or unreachable server must never stall the money screen.
  const loadServerSugg = async () => {
    try {
      const r = await api.suggestBankTxnLinks();
      const m = new Map<string, BankSuggestCandidate[]>();
      const p = new Map<string, BankPersonCandidate[]>();
      for (const row of r.suggestions || []) {
        if (row.candidates.length) m.set(row.txn_id, row.candidates);
        // Additive on the server (R-156/W1-b): a server older than deploy-41 sends
        // no counterparty_candidates and this stays empty, which costs the picker
        // its shortcut and nothing else.
        if (row.counterparty_candidates?.length) p.set(row.txn_id, row.counterparty_candidates);
      }
      setServerSugg(m);
      setPersonSugg(p);
    } catch { /* offline — the local matcher stays */ }
  };

  // Both sides of the address book. Loaded once and kept: the picker searches it,
  // the ledger resolves counterparty_id to a name through it, and the person filter
  // is built from it. Failure is not fatal — the ledger must still open.
  const loadPeople = async () => {
    try {
      const [cs, ss] = await Promise.all([api.listClients(), api.listSuppliers()]);
      setPeople([
        ...cs.map((c): PersonRef => ({ type: "client", id: c.id, name: c.name })),
        ...ss.filter((s) => !s.archived).map((s): PersonRef => ({ type: "supplier", id: s.id, name: s.name })),
      ]);
    } catch { /* the picker falls back to whatever is already tagged */ }
  };

  const loadAll = async () => {
    setLoadError(null);
    try {
      const [t, s, d, ln, r] = await Promise.all([
        api.listBankTxns(), api.bankTxnSummary(), api.listDealFlows(), api.listLoans(), api.listTxnRules(),
      ]);
      setTxns(t); setSummary(s); setDeals(d); setLoans(ln); setRules(r);
      // Smart-link hints arrive separately and never block the ledger (R-150).
      loadServerSugg();
      loadPeople();
      // Heal payments paired to duplicate deal_flow rows AND archive the duplicate
      // rows so pickers/aggregates stay clean (idempotent; usually a no-op).
      api.cleanupGhostDealFlows().then((n) => { if (n > 0) api.listDealFlows().then(setDeals).catch(() => {}); }).catch(() => {});
      // NOTE: healOverallocatedTxns is deliberately NOT run here. It deletes the
      // most recently created allocation, which is as likely to be the correct leg
      // as the duplicate — too destructive to fire from merely opening the screen.
      // Over-allocation is surfaced below instead, for a human to resolve.
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally { setLoading(false); }
  };

  const loadPlaid = async () => {
    try {
      const cfg = await api.plaidConfig();
      setPlaidReady(cfg.has_keys);
      if (cfg.env === "sandbox" || cfg.env === "production") setPlaidEnv(cfg.env);
    } catch { setPlaidReady(false); }
    try { setPlaidItems(await api.plaidListItems()); } catch { /* no banks / not set up yet */ }
  };

  useEffect(() => {
    loadAll();
    // Bank feed is secondary — load separately so a Plaid hiccup never blocks the list.
    loadPlaid();
  }, []);

  // Live-refresh when a sync pull applies remote rows — e.g. a second admin (a
  // brother's login on the same org) links a payment or records a refund on his
  // device. Without this the Financials tab shows stale data until it's remounted.
  //
  // The listener mounts once, so it must call through a ref: capturing refreshAll
  // directly froze the first render's openId (always null), which meant an OPEN
  // allocation panel kept showing stale allocations while the table underneath
  // refreshed — the exact state that causes a double-book.
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { refreshRef.current?.(true).catch(() => {}); })
      .then((u) => { if (dead) u(); else un = u; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // Escape closes the booking sheet (the payee editor stops propagation so its
  // own Escape doesn't also close the sheet). The person picker sits ABOVE the
  // sheet, so while it is open Escape belongs to it — closing the sheet out from
  // under it would leave the picker floating over nothing.
  useEffect(() => {
    if (!openId && !personPickerFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (personPickerFor) { setPersonPickerFor(null); return; }
      setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, personPickerFor]);

  // Focus moves into the sheet ONCE when it opens, so keyboard and screen-reader
  // users land inside the dialog rather than behind it. This has to be an effect
  // keyed on openId: an inline `ref={(el) => el?.focus()}` is a new function every
  // render, so React detached and re-attached it on EVERY commit and re-focused
  // this container — which blew the caret out of the deal search, the amount, the
  // note and the payee rename after a single keystroke, and out of any field
  // whenever a background netsync refresh landed. Never focus from a ref callback.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openId) sheetRef.current?.focus();
  }, [openId]);

  // Stop any in-flight bank-connect polling when this view unmounts.
  useEffect(() => () => {
    pollCancelRef.current = true;
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    if (prepTimerRef.current !== null) clearTimeout(prepTimerRef.current);
  }, []);

  // Reload txns + summary, and (optionally) the open row's allocations.
  const refreshAll = async (keepOpen = true) => {
    // Loan tags change outstanding, so refresh loans alongside txns (cheap). Deals
    // too — a deal added on another device (the netsync-applied path) or elsewhere
    // in the app must reach the allocation picker without a full remount.
    const [t, s, ln, d] = await Promise.all([api.listBankTxns(), api.bankTxnSummary(), api.listLoans(), api.listDealFlows()]);
    setTxns(t); setSummary(s); setLoans(ln); setDeals(d);
    loadServerSugg();
    if (keepOpen && openId) {
      const a = await api.listBankAllocationsForTxn(openId);
      setAllocs(a);
      const nt = t.find((x) => x.id === openId);
      setAmountStr(nt ? String(nt.unallocated) : "");
    }
  };
  refreshRef.current = refreshAll;

  // Screen-level refresh. Deliberately NOT gated on a Plaid link: on a device that
  // has never linked a bank itself, every other refresh control on this screen is
  // hidden, which left no way to re-read the ledger without leaving the tab.
  const refreshScreen = async () => {
    setRefreshing(true);
    try { await refreshAll(true); }
    catch (e: any) { toast(errText(e), "error"); }
    finally { setRefreshing(false); }
  };

  const recordCash = async () => {
    const amt = Number(cashAmount);
    if (!(amt > 0)) { toast("Enter a cash amount greater than zero", "error"); return; }
    setCashSaving(true);
    try {
      await api.addCashTransaction(amt, cashDir, cashDate || localDay(), cashCp.trim() || undefined, cashNote.trim() || undefined);
      setCashOpen(false); setCashAmount(""); setCashCp(""); setCashNote("");
      await refreshAll(false);
      toast(`Cash ${cashDir === "out" ? "payment" : "receipt"} recorded — allocate it to deals below`);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setCashSaving(false); }
  };

  const savePlaidKeys = async () => {
    const cid = plaidClientId.trim(), sec = plaidSecret.trim();
    if (!cid || !sec) { toast("Enter both the client ID and secret", "error"); return; }
    setPlaidSavingKeys(true);
    try {
      await api.plaidSetKeys(cid, sec, plaidEnv);
      const cfg = await api.plaidConfig();
      setPlaidReady(cfg.has_keys);
      if (cfg.env === "sandbox" || cfg.env === "production") setPlaidEnv(cfg.env);
      setPlaidClientId(""); setPlaidSecret("");
      toast("Plaid keys saved");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSavingKeys(false); }
  };

  const testPlaidKeys = async () => {
    setPlaidTesting(true);
    try {
      toast(await api.plaidTestKeys());
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidTesting(false); }
  };

  // Stop the hosted-link poll loop (shared by success, timeout, error and Cancel).
  const stopPolling = () => {
    pollCancelRef.current = true;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Booking-destroying events must never pass silently. The bank retracting rows
  // already reviewed or allocated (the pending→posted churn) and amendments below
  // the booked total used to be surfaced only on the manual Sync-now path — the
  // background prep-retry timer and the post-connect sync swallowed them, which is
  // why a destroyed booking felt unexplained rather than like a warning that was
  // shown. Every plaidSync-shaped result now reports through here.
  const surfaceSyncWarnings = (r: PlaidSyncSummary) => {
    // Canary: if a sync imported transactions but not one carried Plaid's
    // pending_transaction_id, the automatic pending→posted carry-forward cannot
    // fire for these institutions. It is inert, not broken — bookings are still
    // never destroyed — but Jack should know the safety net is doing nothing.
    if (r.imported > 0) setPendingRefSeen(r.with_pending_ref > 0 ? "yes" : "no");
    // Work the bank moved for you, carried automatically onto the posted twin.
    if (r.settled > 0) {
      toast(`${r.settled} transaction${r.settled === 1 ? "" : "s"} settled at your bank — ${r.settled === 1 ? "its booking was" : "their bookings were"} carried over, no re-work needed.`, "success");
    }
    if (r.over_allocated?.length) {
      toast(
        `${r.over_allocated.length} transaction${r.over_allocated.length === 1 ? " was" : "s were"} changed by the bank to less than what's booked against ${r.over_allocated.length === 1 ? "it" : "them"}: ${r.over_allocated.join("; ")}. Nothing was removed — please review the allocations.`,
        "error",
      );
    }
    // The bank retracted work already reviewed or booked, and no replacement could
    // be identified. Since v0.15.137 the row is KEPT — nothing was deleted, so there
    // is nothing to "re-link"; the old copy said the opposite and was wrong.
    if (r.retracted_kept > 0) {
      toast(`Your bank retracted ${r.retracted_kept} transaction${r.retracted_kept === 1 ? "" : "s"} you'd already reviewed or booked. Nothing was deleted — ${r.retracted_kept === 1 ? "it is" : "they are"} still in your ledger. If the replacement has landed, use "Re-pull all" in Setup to move your work onto it.`, "error");
    }
    // A pending/posted pair was identified but the booking could not be moved
    // automatically. Both rows are intact; which one keeps the work is a human call.
    if (r.settle_refused?.length) {
      toast(`${r.settle_refused.length} settled transaction${r.settle_refused.length === 1 ? "" : "s"} couldn't have the booking moved automatically: ${r.settle_refused.join("; ")}. Nothing was changed — please re-link by hand.`, "error");
    }
    // Surface the actual per-bank Plaid error so a silent empty result is never a mystery.
    for (const x of r.results.filter((x) => x.status === "error")) {
      toast(`${x.institution || "A bank"} couldn't sync: ${x.error}`, "error");
    }
    // R-019. Four paths used to drop a transaction with no trace anywhere. They are
    // counted now, so keep the tally on screen and shout about the ones that lost money.
    const skips = readSkips(r);
    setSyncSkips(anySkips(skips) ? skips : null);
    if (skips.skipped_unsaved.length) {
      toast(`${skips.skipped_unsaved.length} transaction${skips.skipped_unsaved.length === 1 ? "" : "s"} couldn't be saved and your bank won't offer ${skips.skipped_unsaved.length === 1 ? "it" : "them"} again: ${skips.skipped_unsaved.join("; ")}. Use "Re-pull all" in Setup to get ${skips.skipped_unsaved.length === 1 ? "it" : "them"} back.`, "error");
    }
    if (skips.skipped_no_id.length) {
      toast(`Your bank sent ${skips.skipped_no_id.length} transaction${skips.skipped_no_id.length === 1 ? "" : "s"} with no id, so ${skips.skipped_no_id.length === 1 ? "it couldn't" : "they couldn't"} be stored: ${skips.skipped_no_id.join("; ")}. Add ${skips.skipped_no_id.length === 1 ? "it" : "them"} by hand if ${skips.skipped_no_id.length === 1 ? "it belongs" : "they belong"} in your ledger.`, "error");
    }
    if (skips.page_capped.length) {
      toast(`${skips.page_capped.join(", ")} still ${skips.page_capped.length === 1 ? "has" : "have"} more history than one sync can pull. Sync again to keep going.`);
    }
  };

  // While a freshly-linked bank is still being prepared by Plaid, re-sync in the
  // background a few times (~every 20s) until transactions land, then stop.
  const schedulePrepRetries = (left: number) => {
    if (prepTimerRef.current !== null) clearTimeout(prepTimerRef.current);
    if (left <= 0) {
      // Retries exhausted — clear the "preparing" banner so it doesn't sit forever,
      // and tell the user how to finish once the bank's history is ready.
      setPlaidPreparing(false);
      toast("Your bank is still preparing transactions — use Sync now in a few minutes.");
      return;
    }
    prepTimerRef.current = window.setTimeout(async () => {
      prepTimerRef.current = null;
      try {
        const r = await api.plaidSync();
        surfaceSyncWarnings(r);
        if (r.imported > 0 || r.removed > 0) {
          setPlaidPreparing(false);
          await refreshAll(false);
          toast(`Synced ${r.imported} transaction${r.imported === 1 ? "" : "s"}`);
          return;
        }
        if (r.preparing) { schedulePrepRetries(left - 1); }
        else { setPlaidPreparing(false); await refreshAll(false); }
      } catch { schedulePrepRetries(left - 1); }
    }, 20000);
  };

  // Connect a bank via Plaid Hosted Link: open Plaid in the system browser (where
  // bank logins / OAuth actually work — the embedded widget stalls inside the
  // Tauri webview), then poll every 3s until the server reports it exchanged.
  const connectBank = async () => {
    if (plaidConnecting) return; // guard against double-clicks
    setPlaidConnecting(true);
    pollCancelRef.current = false;
    try {
      const { hosted_link_url, link_token } = await api.plaidConnectStart();
      await api.openExternal(hosted_link_url);
      let attempts = 0;
      let pollErrors = 0;
      const maxAttempts = 100; // ~5 minutes at 3s each
      const tick = async () => {
        if (pollCancelRef.current) return;
        attempts += 1;
        try {
          const r = await api.plaidConnectPoll(link_token);
          if (pollCancelRef.current) return;
          pollErrors = 0; // a good poll resets the tolerance
          if (r.status === "connected") {
            stopPolling();
            const inst = r.institution || "bank";
            toast(`Connected ${inst}`);
            setPlaidItems(await api.plaidListItems());
            const s = await api.plaidSync();
            surfaceSyncWarnings(s);
            if (s.imported > 0) {
              toast(`Synced ${s.imported} transaction${s.imported === 1 ? "" : "s"}`);
              await refreshAll(false);
            } else if (s.preparing) {
              setPlaidPreparing(true);
              schedulePrepRetries(6); // ~2 min of background re-syncs
            } else {
              await refreshAll(false);
            }
            setPlaidConnecting(false);
            return;
          }
          if (attempts >= maxAttempts) {
            stopPolling();
            toast("Didn't detect a completed connection — click Connect a bank to try again.", "error");
            setPlaidConnecting(false);
            return;
          }
          pollTimerRef.current = window.setTimeout(tick, 3000);
        } catch (e: any) {
          // A transient blip (network, laptop sleep) shouldn't abort a valid connect
          // while the user is mid-login. Tolerate a few in a row before giving up.
          pollErrors += 1;
          if (pollCancelRef.current) return;
          if (pollErrors >= 5) {
            stopPolling();
            toast(errText(e), "error");
            setPlaidConnecting(false);
          } else {
            pollTimerRef.current = window.setTimeout(tick, 3000);
          }
        }
      };
      pollTimerRef.current = window.setTimeout(tick, 3000);
    } catch (e: any) {
      stopPolling();
      toast(errText(e), "error");
      setPlaidConnecting(false);
    }
  };

  // Cancel the wait — stops polling only; nothing is undone server-side.
  const cancelConnect = () => {
    stopPolling();
    setPlaidConnecting(false);
  };

  // "sync" reads Plaid's cached copy; "full" resets the cursor and re-pulls;
  // "refresh" first FORCES the bank to hand Plaid its very latest activity (today's
  // wires/spend) before syncing — the only path that surfaces same-day money.
  const syncPlaid = async (mode: "sync" | "full" | "refresh" = "sync") => {
    setPlaidSyncing(true);
    try {
      const r = mode === "full" ? await api.plaidResyncAll()
              : mode === "refresh" ? await api.plaidRefreshSync()
              : await api.plaidSync();
      const stillPreparing = r.preparing || r.results.some((x) => x.status === "preparing");
      const amended = r.amended ?? 0;
      if (r.imported === 0 && r.removed === 0 && amended === 0 && stillPreparing) {
        setPlaidPreparing(true);
        schedulePrepRetries(6);
        toast("Plaid is still preparing your transactions — this can take a minute.");
      } else {
        setPlaidPreparing(stillPreparing);
        if (mode === "refresh" && r.imported === 0 && r.removed === 0 && amended === 0) {
          toast("Refreshed from bank — nothing new yet. Same-day wires can take a few hours to post; try again shortly.");
        } else {
          const lead = mode === "refresh" ? "Refreshed — " : "";
          const bits = [`Synced ${r.imported} new transaction${r.imported === 1 ? "" : "s"}`];
          if (r.removed > 0) bits.push(`removed ${r.removed}`);
          // The bank changed a transaction we already held (a pending row settling at
          // a different amount, a corrected date). These used to be discarded silently.
          if (amended > 0) bits.push(`updated ${amended} the bank changed`);
          toast(`${lead}${bits.join(", ")}`);
        }
        await refreshAll(false);
      }
      surfaceSyncWarnings(r);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSyncing(false); }
  };

  // A bulk clear keeps anything reviewed or linked to a deal; those only go if
  // you're told exactly what they are and say yes a second time.
  const clearTxnsGuarded = async (scope: "statements" | "all") => {
    const r = await api.clearBankTxns(scope);
    const n = r.kept;
    if (n === 0) return r;
    if (!confirm(
      `Kept ${n} transaction${n === 1 ? "" : "s"} that ${n === 1 ? "is" : "are"} already reviewed or linked to a deal.\n\nDelete ${n === 1 ? "it" : "them"} too? Any deal linked to ${n === 1 ? "it" : "them"} loses that money from its recorded profit. This can't be undone.`
    )) return r;
    const f = await api.clearBankTxns(scope, true);
    return { deleted: r.deleted + f.deleted, allocations_removed: r.allocations_removed + f.allocations_removed, kept: 0 };
  };

  const clearAndRepull = async () => {
    if (!confirm(
      "Clear bank transactions and re-pull fresh from your currently connected banks?\n\nAnything reviewed or linked to a deal is kept — you'll be asked separately before those go. Use this after removing a wrong account. This can't be undone."
    )) return;
    setPlaidSyncing(true);
    try {
      const c = await clearTxnsGuarded("all");
      const r = await api.plaidResyncAll();
      const stillPreparing = r.preparing || r.results.some((x) => x.status === "preparing");
      setPlaidPreparing(stillPreparing);
      if (stillPreparing) schedulePrepRetries(6);
      toast(`Cleared ${c.deleted} old, pulled ${r.imported} fresh transaction${r.imported === 1 ? "" : "s"}${c.kept > 0 ? ` (kept ${c.kept} reviewed or deal-linked)` : ""}`);
      surfaceSyncWarnings(r);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSyncing(false); }
  };

  // Duplicate cleanup: preview first (dry run), then the user confirms in the modal.
  // aggressive=true removes every exact match (same date/amount/memo), not just the
  // clearly-safe ones — still never a booked row, and everything is backed up.
  const previewDedupe = async (aggressive: boolean) => {
    setDedupeAggressive(aggressive);
    setDedupeRunning(true);
    setDedupeDone(false);
    try {
      const r = await api.dedupeBankTxns(true, aggressive);
      setDedupe(r);
      if ((r.auto_remove || 0) === 0 && r.review_count === 0) {
        toast("No duplicate transactions found", "success");
        setDedupe(null);
      }
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setDedupeRunning(false); }
  };

  const executeDedupe = async () => {
    setDedupeRunning(true);
    try {
      const r = await api.dedupeBankTxns(false, dedupeAggressive);
      setDedupe(r);
      setDedupeDone(true);
      await refreshAll(false);
      toast(`Removed ${r.removed || 0} duplicate${(r.removed || 0) === 1 ? "" : "s"}${r.review_count ? ` · ${r.review_count} still need a look` : ""}`, "success");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setDedupeRunning(false); }
  };

  // Google Sheet safety log for bank transactions.
  useEffect(() => {
    api.getBankBackupSettings().then((s) => {
      setBackupUrl(s.sheet_url || "");
      setBackupEnabled(!!s.enabled);
      setBackupLast({ at: s.last_at || "", total: s.last_total || "" });
    }).catch(() => {});
  }, []);

  const saveBackupSettings = async (url: string, enabled: boolean) => {
    setBackupUrl(url); setBackupEnabled(enabled);
    try { await api.setBankBackupSettings(url, enabled); } catch (e: any) { toast(errText(e), "error"); }
  };

  const runBackupNow = async () => {
    setBackupBusy(true);
    try {
      const r = await api.backupBankTxnsNow();
      setBackupLast({ at: r.at, total: String(r.total) });
      toast(r.added > 0 ? `Backed up ${r.added} transaction${r.added === 1 ? "" : "s"} to your sheet` : "Sheet is already up to date", "success");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setBackupBusy(false); }
  };

  const disconnectBank = async (item: PlaidItem) => {
    if (!confirm(
      `Disconnect ${item.institution}?\n\nThe live feed from this bank stops. Transactions already imported stay in the list — nothing is deleted — but to start pulling again you'd have to link the bank from scratch.`
    )) return;
    try {
      await api.plaidRemoveItem(item.id);
      toast("Bank disconnected");
      const items = await api.plaidListItems();
      setPlaidItems(items);
      if (items.length === 0) {
        if (prepTimerRef.current !== null) { clearTimeout(prepTimerRef.current); prepTimerRef.current = null; }
        setPlaidPreparing(false);
      }
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // Open/close a row's allocation panel.
  //
  // This is the ONLY place openId changes, so it is also where the panel is reset.
  // Every field has to be cleared here or it bleeds into the next row: split mode
  // left on re-primes the amount for a different deal, and stale allocs render
  // under the new transaction whenever its fetch fails (the catch below clears
  // allocLoading but would otherwise leave the previous row's list on screen).
  // A useEffect on [openId] cannot do this — it runs after the commit and would
  // wipe the amount and role prefilled just below.
  const toggleRow = (t: BankTxn) => {
    if (openId === t.id) { setOpenId(null); return; }
    setOpenId(t.id);
    setTargetType("deal");
    setDealQuery(""); setSelectedDeal(null); setDealListOpen(false); setNote("");
    setLoanQuery(""); setSelectedLoan(null); setLoanListOpen(false);
    setAllowSplit(false);
    setAllocs([]);
    setRole(t.direction === "out" ? "supplier_payment" : "buyer_payment");
    setAmountStr(String(t.unallocated));
    setAllocLoading(true);
    api.listBankAllocationsForTxn(t.id)
      .then(setAllocs)
      .catch((e: any) => toast(errText(e), "error"))
      .finally(() => setAllocLoading(false));
  };

  // Normalize the dialog result (string | string[] | null) to a list of paths.
  const asPaths = (sel: string | string[] | null): string[] =>
    Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];

  // Import flow — one file previews first; multiple files import straight through.
  const pickAndPreview = async () => {
    const paths = asPaths(await openDialog({
      multiple: true,
      filters: [{ name: "Bank statement", extensions: ["pdf", "ofx", "qbo", "qfx", "csv"] }],
    }));
    if (paths.length === 0) return;
    if (paths.length > 1) { await bulkImport(paths, false); return; }
    const selected = paths[0];
    setPreviewPath(selected);
    setPreview(null);
    setPreviewing(true);
    try {
      const p = await api.bankPreview(selected);
      setPreview(p);
    } catch (e: any) { toast(errText(e), "error"); setPreviewPath(null); }
    finally { setPreviewing(false); }
  };

  // Import many statements sequentially, all into the current account.
  const bulkImport = async (paths: string[], ai: boolean) => {
    const acct = accountId.trim() || "business";
    localStorage.setItem("fin_last_account", acct);
    setBulkBusy(true);
    let imported = 0, extracted = 0, skipped = 0;
    const errors: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      setBulkProgress(`Importing ${i + 1} of ${paths.length}…`);
      try {
        const s = ai ? await api.bankImportAi(paths[i], acct) : await api.bankImport(paths[i], acct);
        imported += s.imported;
        skipped += s.skipped;
        if (ai) extracted += (s as BankAiImportResult).extracted;
      } catch (e: any) { errors.push(String(e)); }
    }
    setBulkProgress("");
    setBulkBusy(false);
    const failNote = errors.length ? ` — ${errors.length} file${errors.length === 1 ? "" : "s"} failed` : "";
    toast(
      ai
        ? `AI imported ${imported} (extracted ${extracted}), skipped ${skipped} across ${paths.length} files${failNote}`
        : `Imported ${imported}, skipped ${skipped} across ${paths.length} files${failNote}`,
      errors.length ? "error" : "success",
    );
    await refreshAll(false);
  };

  const doImport = async () => {
    if (!previewPath) return;
    setImporting(true);
    try {
      const acct = accountId.trim() || "business";
      localStorage.setItem("fin_last_account", acct);
      const s = await api.bankImport(previewPath, acct);
      toast(`Imported ${s.imported}, skipped ${s.skipped} (already imported)`);
      setPreview(null); setPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setImporting(false); }
  };

  // AI import flow — reads ANY statement (credit cards, other banks) via LLM.
  const pickAndPreviewAi = async () => {
    const paths = asPaths(await openDialog({
      multiple: true,
      filters: [{ name: "Statement", extensions: ["pdf", "ofx", "qbo", "qfx", "csv"] }],
    }));
    if (paths.length === 0) return;
    if (paths.length > 1) { await bulkImport(paths, true); return; }
    const selected = paths[0];
    setAiPreviewPath(selected);
    setAiPreview(null);
    setAiExtracting(true);
    try {
      const p = await api.bankPreviewAi(selected);
      setAiPreview(p);
    } catch (e: any) { toast(errText(e), "error"); setAiPreviewPath(null); }
    finally { setAiExtracting(false); }
  };

  const doImportAi = async () => {
    if (!aiPreviewPath) return;
    setAiImporting(true);
    try {
      const acct = accountId.trim() || "business";
      localStorage.setItem("fin_last_account", acct);
      const s = await api.bankImportAi(aiPreviewPath, acct);
      toast(`AI imported ${s.imported} (extracted ${s.extracted}); skipped ${s.skipped} already-imported. Review + allocate below.`);
      setAiPreview(null); setAiPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAiImporting(false); }
  };

  // Remove statement-imported transactions (PDF/OFX/CSV/AI) — keeps the live
  // bank feed (Plaid) so the two don't overlap. Allocations go with them.
  const clearStatementImports = async () => {
    if (clearing) return;
    if (!window.confirm(
      "Remove all transactions imported from statement files (PDF/OFX/CSV)? This keeps everything from the live bank feed (Plaid), plus anything reviewed or linked to a deal — you'll be asked separately before those go. This can't be undone (you can re-import statements later)."
    )) return;
    setClearing(true);
    try {
      const r = await clearTxnsGuarded("statements");
      toast(
        [
          `Removed ${r.deleted} statement transactions`,
          r.allocations_removed > 0 ? ` (${r.allocations_removed} allocations cleared)` : "",
          r.kept > 0 ? ` — kept ${r.kept} reviewed or deal-linked` : "",
        ].join(""),
      );
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setClearing(false); }
  };

  // Save classification / reviewed flag. Sends ONLY the field being changed —
  // never the whole cached row. Sync is per-column last-write-wins, so re-sending
  // an untouched field re-stamps it with a fresh clock and lets this device's
  // (possibly stale) copy beat a newer edit from another device. That is how
  // changing a category used to un-book a transaction booked elsewhere.
  const saveReview = async (t: BankTxn, patch: BankTxnReviewPatch) => {
    try {
      await api.setBankTxnReview(t.id, patch);
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
      const s = await api.bankTxnSummary();
      setSummary(s);
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // Enter and blur both land here; Escape sets payeeCancelRef first so the blur it
  // causes closes the editor without writing. An empty or unchanged name is a no-op
  // (clearing the payee is not what a blank box means).
  const commitPayeeEdit = (t: BankTxn, raw: string) => {
    setPayeeEditId(null);
    if (payeeCancelRef.current) { payeeCancelRef.current = false; return; }
    const next = raw.trim();
    if (!next || next === (t.counterparty_name || "").trim()) return;
    saveReview(t, { counterparty_name: next });
    // R-156 §5 — this edits a FREE-TEXT label and links nothing. Renaming a payee
    // to "Tytan" does not put the payment on Tytan's profile, and Jack has been
    // caught by exactly that. Offer the link the rename did not make; only when
    // there isn't one already, so a correction to a spelling stays quiet.
    if (!t.counterparty_type) setLinkOfferFor(t.id);
  };

  const submitAlloc = async () => {
    if (!openId) return;
    if (targetType === "loan") {
      if (!selectedLoan) { toast("Pick a loan first", "error"); return; }
      setAllocBusy(true);
      try {
        await api.tagBankTxnToLoan(openId, selectedLoan.id);
        toast("Tagged to loan");
        await refreshAll(true);
      } catch (e: any) { toast(errText(e), "error"); }
      finally { setAllocBusy(false); }
      return;
    }
    if (!selectedDeal) { toast("Pick a deal first", "error"); return; }
    const amt = parseAmount(amountStr, NaN);
    if (!(amt > 0)) { toast("Enter an amount", "error"); return; }
    setAllocBusy(true);
    try {
      await api.allocateBankTxn(openId, selectedDeal.id, amt, role, note.trim(), allowSplit);
      toast(allowSplit ? "Split leg allocated" : "Allocated to deal");
      // In split mode keep the panel primed for the next leg; otherwise reset.
      setSelectedDeal(null); setDealQuery(""); setNote("");
      if (!allowSplit) setAmountStr("");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAllocBusy(false); }
  };

  // One-click allocate for an unambiguous match: the full remaining amount, role read
  // from the direction (money in = buyer payment, money out = supplier payment — the
  // same pairing bulk allocate uses and the only roles rolesFor allows). A server
  // candidate (R-150) overrides both: its role, its supplier leg cap, and the
  // counterparty tag stamped on the txn after the allocation lands. This calls the
  // exact command the panel calls, so nothing here skips a backend check; the row is
  // re-checked for remaining amount at click time in case it went stale.
  const tieMatch = async (t: BankTxn, d: DealFlow, candidate?: BankSuggestCandidate) => {
    if (tyingId) return;
    if (!(t.unallocated > 0.0001)) { toast("Nothing left to tie on this transaction", "error"); return; }
    setTyingId(t.id);
    try {
      const r = candidate?.role ?? (t.direction === "out" ? "supplier_payment" : "buyer_payment");
      // A supplier leg is one cut of a deal: tie at most that leg's amount so a
      // multi-leg wire leaves its remainder allocatable elsewhere. Buyer ties keep
      // the full remainder (the pre-existing behaviour, over-invoice confirm aside).
      const amt = r === "supplier_payment" && candidate && candidate.leg_amount > 0
        ? Math.min(t.unallocated, candidate.leg_amount)
        : t.unallocated;
      const note = r === "supplier_payment" && candidate?.supplier_name ? candidate.supplier_name : "";
      await api.allocateBankTxn(t.id, d.id, amt, r, note);
      // R-150 phase 4: stamp the supplier/client identity on the txn so profiles
      // show payment history even for money never tied to a deal. Best-effort —
      // a failed tag must never undo or hide a successful allocation.
      const cpid = r === "supplier_payment" ? candidate?.supplier_id : candidate?.client_id;
      if (cpid) {
        // Since R-175 the tag is exclusive - it decides which profile shows this
        // payment at all - so a swallowed failure leaves it on the wrong one.
        api.tagBankTxnCounterparty(t.id, r === "supplier_payment" ? "supplier" : "client", cpid)
          .catch(() => toast("Booked, but the payment was not filed under anyone - set it on the row", "error"));
      }
      toast(`Tied ${fmtAmount(amt)} to ${dealLabel(d)}`);
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setTyingId(null); }
  };

  // ── R-150 phase 5: missing links on completed deals ─────────────────────────
  const openMissingLinks = async () => {
    setMissingLinksOpen(true);
    setMissingLinksLoading(true);
    try {
      const r = await api.suggestReconciliationMissing();
      setMissingLinks(r.deals || []);
      setMissingLinksScope({ checked: r.checked, truncated: r.truncated });
    } catch { setMissingLinks([]); setMissingLinksScope({}); }
    finally { setMissingLinksLoading(false); }
  };

  // Attach one suggested transaction to its deal. Same command the panel uses,
  // so every backend guard applies; capped at the leg/invoice target so an
  // over-sized wire leaves its remainder for other legs. The txn can only ever
  // land on ONE deal (exclusivity), so the suggestion is withdrawn everywhere
  // the moment it attaches.
  const attachMissing = async (cand: BankSuggestCandidate) => {
    if (attachBusy) return;
    setAttachBusy(cand.txn_id);
    try {
      const txn = txns.find((x) => x.id === cand.txn_id);
      // Allocate against what is still free on the txn, not its face amount — a
      // partial allocation already on the row would make the backend reject an
      // attach sized off `amount`. Same stale-row guard as tieMatch.
      if (txn && !(txn.unallocated > 0.0001)) { toast("Nothing left to tie on this transaction", "error"); return; }
      const amt = txn ? Math.min(txn.unallocated, cand.leg_amount) : cand.leg_amount;
      await api.allocateBankTxn(cand.txn_id, cand.deal_id, amt, cand.role, cand.supplier_name || "");
      const cpid = cand.role === "supplier_payment" ? cand.supplier_id : cand.client_id;
      if (cpid) {
        api.tagBankTxnCounterparty(cand.txn_id, cand.role === "supplier_payment" ? "supplier" : "client", cpid)
          .catch(() => toast("Booked, but the payment was not filed under anyone - set it on the row", "error"));
      }
      toast(`Attached ${fmtAmount(amt)} to ${cand.client_name}${cand.supplier_name ? ` · ${cand.supplier_name}` : ""}`);
      setMissingLinks((prev) => prev
        .map((d) => ({ ...d, missing: d.missing.map((m) => ({ ...m, candidates: m.candidates.filter((c) => c.txn_id !== cand.txn_id) })) }))
        .filter((d) => d.missing.some((m) => m.candidates.length > 0)));
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAttachBusy(null); }
  };

  const untagLoan = async (bankTxnId: string) => {
    setAllocBusy(true);
    try {
      await api.untagBankTxnLoan(bankTxnId);
      toast("Loan tag removed");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAllocBusy(false); }
  };

  // Memorize a rule AND immediately tag every matching transaction — one click
  // handles the whole backlog instead of tagging each row by hand.
  const createRule = async (
    matchCounterparty: string, category: string, tType: "deal" | "loan" | "expense", targetId: string,
    direction: string, autoBook = false,
  ): Promise<boolean> => {
    try {
      await api.createTxnRule(matchCounterparty, category, tType, targetId, "", direction, autoBook);
      const r = await api.applyTxnRules();
      const dirWord = direction === "in" ? " money-in" : direction === "out" ? " money-out" : "";
      const booked = (r.auto_booked ?? 0) > 0 ? ` — ${r.auto_booked} booked automatically` : "";
      toast(`Remembered — tagged ${r.updated}${dirWord} transaction${r.updated === 1 ? "" : "s"}${booked}. Applies on every device.`);
      setRules(await api.listTxnRules());
      await refreshAll(false);
      return true;
    } catch (e: any) { toast(errText(e), "error"); return false; }
  };

  const deleteRule = async (id: string) => {
    try {
      await api.deleteTxnRule(id);
      setRules(await api.listTxnRules());
    } catch (e: any) { toast(errText(e), "error"); }
  };

  const toggleRuleAuto = async (r: TxnRule) => {
    try {
      await api.setTxnRuleAuto(r.id, !r.auto_book);
      setRules(await api.listTxnRules());
    } catch (e: any) { toast(errText(e), "error"); }
  };

  const applyRules = async () => {
    try {
      const r = await api.applyTxnRules();
      const booked = (r.auto_booked ?? 0) > 0 ? ` — ${r.auto_booked} booked automatically` : "";
      toast(`Applied to ${r.updated} transaction${r.updated === 1 ? "" : "s"}${booked}`);
      await refreshAll(true);
      setRules(await api.listTxnRules());
    } catch (e: any) { toast(errText(e), "error"); }
  };

  const removeAlloc = async (id: string) => {
    try {
      await api.removeBankAllocation(id);
      toast("Allocation removed");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // ── Bulk actions ────────────────────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Run an action over the current selection, one existing command at a time, with a
  // running counter; then a single refresh. Skips rows already gone from the list.
  const runBulk = async (fn: (t: BankTxn) => Promise<unknown> | undefined) => {
    const ids = Array.from(selected);
    setBulkActionBusy(true);
    let done = 0, failed = 0;
    let firstErr = ""; // surface WHY (usually "already linked to another deal")
    for (const id of ids) {
      const t = txns.find((x) => x.id === id);
      if (!t) continue;
      try { await fn(t); } catch (e: any) { failed += 1; if (!firstErr) firstErr = String(e?.message || e); }
      done += 1;
      setBulkProgress(`Updating ${done} of ${ids.length}…`);
    }
    setBulkProgress("");
    setBulkActionBusy(false);
    clearSelection();
    await refreshAll(true);
    if (failed > 0) toast(`${failed} of ${ids.length} couldn't be updated${firstErr ? ` — ${firstErr}` : ""}`, "error");
  };

  const bulkSetCategory = (cat: string) =>
    runBulk((t) => api.setBankTxnReview(t.id, { category: cat }));
  const bulkSetReviewed = (val: boolean) =>
    runBulk((t) => api.setBankTxnReview(t.id, { reviewed: val }));
  // Allocate each selected txn's remaining amount to one deal; role auto-picked by
  // direction so mixed in/out selections book to the correct side.
  const bulkAllocate = (deal: DealFlow) =>
    runBulk((t) => {
      if (!(t.unallocated > 0.0001)) return undefined;
      const r = t.direction === "out" ? "supplier_payment" : "buyer_payment";
      return api.allocateBankTxn(t.id, deal.id, t.unallocated, r, "");
    });
  // Tag each selected txn to one loan; the backend derives received/repayment per
  // direction, so a mixed selection books each side correctly.
  const bulkTagLoan = (loan: Loan) =>
    runBulk((t) => api.tagBankTxnToLoan(t.id, loan.id));

  // Delete hand-picked transactions — the escape hatch for duplicates the automatic
  // cleanup refuses to touch. Anything booked to a deal/loan/refund is skipped by the
  // backend (removing it would silently change recorded profit) and reported back.
  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}?\n\n` +
        `Anything linked to a deal, loan or refund is kept — those are skipped and reported.\n` +
        `This can't be undone from here, though a copy of everything removed is saved locally.`
    );
    if (!ok) return;
    setBulkActionBusy(true);
    try {
      const r = await api.deleteBankTxns(ids);
      clearSelection();
      await refreshAll(true);
      const extra = r.skipped_booked > 0 ? ` · ${r.skipped_booked} kept (linked to a deal)` : "";
      toast(`Deleted ${r.deleted} transaction${r.deleted === 1 ? "" : "s"}${extra}`, "success");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBulkActionBusy(false);
    }
  };

  // Suggest categories with AI. Suggestions only — does NOT mark reviewed. Loops the
  // batched command until the backlog is clear (or the model stops making progress).
  const aiCategorize = async () => {
    setAiBusy(true);
    let total = 0;
    try {
      for (let round = 0; round < 25; round++) {
        const { updated, remaining } = await api.aiCategorizeBankTxns();
        total += updated;
        if (remaining > 0 && updated > 0) setAiProgress(`Categorized ${total} — ${remaining} left…`);
        if (remaining <= 0 || updated === 0) break;
      }
      setAiProgress("");
      toast(`AI categorized ${total} transaction${total === 1 ? "" : "s"}`);
      await refreshAll(true);
    } catch (e: any) { setAiProgress(""); toast(errText(e), "error"); }
    finally { setAiBusy(false); }
  };

  // Rebuild a never-tracked brokering deal from a bank receipt:
  // client → backfilled invoice → deal flow → allocate this receipt to it.
  const createDealFromTxn = async (
    t: BankTxn, dealName: string, buyerName: string, expectedSale: number, noteVal: string,
  ): Promise<boolean> => {
    // Guard: this backfills a deal from a RECEIVED payment (allocated as
    // buyer_payment). A money-out txn would create an orphan client/invoice/deal
    // and then fail the allocation on the direction guard.
    if (t.direction !== "in") { toast("New-deal backfill is for money-in receipts only", "error"); return false; }
    setNewDealBusy(true);
    try {
      const client = await api.createClient({ name: buyerName });
      const today = localDay();
      const invoiceId = await api.createInvoice({
        client_id: client.id,
        issue_date: today,
        due_date: today,
        line_items: [{ description: dealName, qty: 1, rate: expectedSale, amount: expectedSale }],
        tax_rate: 0,
        notes: "Backfilled from bank import",
      });
      const dealId = await api.createDealFlow(invoiceId, "Backfilled from bank import", dealName);
      await api.allocateBankTxn(t.id, dealId, t.unallocated, "buyer_payment", noteVal);
      toast("Deal created and receipt allocated");
      setDeals(await api.listDealFlows());
      await refreshAll(true);
      return true;
    } catch (e: any) { toast(errText(e), "error"); return false; }
    finally { setNewDealBusy(false); }
  };

  // W2-d — the same memory, for payment method. ONLY CONFIRMED ROWS TEACH, and
  // `confirmed_method` is the ONLY column that carries a confirmation:
  // `set_bank_txn_review` is its sole writer. It deliberately never reads `rail`
  // (the statement importer's memo guess) and never the memo classifier, so a guess
  // cannot be laundered into a stored fact and then re-taught as one — which is the
  // rule R-018 already enforces for categories.
  //
  // A strict majority is required, so a payee whose confirmations disagree teaches
  // nothing rather than teaching the first one. What it yields is `likely`, never
  // `certain` — inheriting from a sibling row is a generalisation, and only the row
  // itself can be certain.
  const methodMemory = useMemo(() => {
    const counts = new Map<string, Map<BankMethod, number>>();
    for (const t of txns) {
      const m = (t.confirmed_method || "") as BankMethod;
      if (!m) continue;
      if (!(t.counterparty_name || "").trim()) continue;
      const key = payeeKey(t);
      const inner = counts.get(key) ?? new Map<BankMethod, number>();
      inner.set(m, (inner.get(m) || 0) + 1);
      counts.set(key, inner);
    }
    const out = new Map<string, BankMethod>();
    for (const [key, inner] of counts) {
      let best: BankMethod | "" = "", bestN = 0, total = 0;
      for (const [m, n] of inner) { total += n; if (n > bestN) { best = m; bestN = n; } }
      if (best && bestN * 2 > total) out.set(key, best);
    }
    return out;
  }, [txns]);

  const methodOf = useCallback((t: BankTxn) => readMethod(t, methodMemory), [methodMemory]);

  // ── The person on a transaction (R-156) ───────────────────────────────────
  const peopleByKey = useMemo(() => new Map(people.map((p) => [personKey(p), p])), [people]);

  // The party a transaction is tagged to, resolved to a name. `loan` is deliberately
  // excluded — a loan tag lives in the same two columns and is a different thing.
  // A tag whose record has since gone still renders, saying so, rather than
  // vanishing and making the row look untagged.
  const personOf = useCallback((t: BankTxn): PersonRef | null => {
    const ty = t.counterparty_type;
    if (ty !== "client" && ty !== "supplier") return null;
    if (!t.counterparty_id) return null;
    return peopleByKey.get(`${ty}:${t.counterparty_id}`)
      ?? { type: ty, id: t.counterparty_id, name: "Record not found" };
  }, [peopleByKey]);

  // W2-a/b — the method facet. "unclassified" is the pile the classifier could not
  // read; it is a selectable state, never a silent omission.
  const passesMethod = useCallback((t: BankTxn) => {
    if (methodFilter === "all") return true;
    const r = methodOf(t);
    return methodFilter === "unclassified" ? r.state === "unclassified" : r.method === methodFilter;
  }, [methodFilter, methodOf]);

  // W2-f — the person facet, and the landing site for "See all in Financials".
  // A loan tag is not a person: it lives in the same two columns and must not
  // answer "who is this money from", so `personOf` returns null for it and
  // loan-tagged rows count as unlinked.
  const passesPerson = useCallback((t: BankTxn) => {
    if (personFilter === "all") return true;
    const p = personOf(t);
    if (personFilter === "linked") return !!p;
    if (personFilter === "none") return !p;
    return !!p && personKey(p) === personFilter;
  }, [personFilter, personOf]);

  // Shared filters — everything except direction + search. Reused by the combined
  // list and both split panes so all three stay consistent.
  // `bypass` = a search term is active: an exact-amount / payee lookup should span
  // the WHOLE ledger, not just the To-do queue and the current-year window —
  // otherwise a booked or prior-year transfer is silently hidden even when the
  // amount matches exactly. Account / category / status stay applied (those are
  // deliberate user choices, not defaults).
  //
  // `skip` leaves ONE facet out, which is how the counts on the method and person
  // controls are produced: the number beside a choice is the number of rows
  // choosing it would actually show. Counting over anything wider is how a filter
  // ends up claiming "3 wires" over a list of one.
  const passesBase = useCallback((t: BankTxn, bypass = false, skip?: "method" | "person") => {
    if (!bypass) {
      if (queue === "todo" && t.reviewed) return false;
      if (queue === "booked" && !t.reviewed) return false;
    }
    if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
    if (catFilter !== "all" && (t.category || "") !== catFilter) return false;
    if (skip !== "method" && !passesMethod(t)) return false;
    if (skip !== "person" && !passesPerson(t)) return false;
    if (statusFilter === "unclassified" && (t.category || "") !== "") return false;
    if (statusFilter === "unallocated_in" && !(t.direction === "in" && (t.category || "") !== "internal_transfer" && t.unallocated > 0.0001)) return false;
    if (statusFilter === "unallocated_out" && !(t.direction === "out" && (t.category || "") !== "internal_transfer" && t.unallocated > 0.0001)) return false;
    if (!bypass) {
      const d = (t.posted_at || "").slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
    }
    return true;
  }, [queue, acctFilter, catFilter, statusFilter, fromDate, toDate, passesMethod, passesPerson]);

  const filtered = useMemo(
    () => txns.filter((t) =>
      passesBase(t, !!search.trim()) &&
      (dirFilter === "all" || t.direction === dirFilter) &&
      matchesQuery(t, search)),
    [txns, passesBase, dirFilter, search],
  );

  // Split-view panes: forced direction + independent search per side.
  const filteredIn = useMemo(
    () => txns.filter((t) => t.direction === "in" && passesBase(t, !!searchIn.trim()) && matchesQuery(t, searchIn)),
    [txns, passesBase, searchIn],
  );
  const filteredOut = useMemo(
    () => txns.filter((t) => t.direction === "out" && passesBase(t, !!searchOut.trim()) && matchesQuery(t, searchOut)),
    [txns, passesBase, searchOut],
  );

  // The rows the ledger would show with ONE facet cleared — the same predicate the
  // visible list uses, split view and per-pane searches included, so a count on a
  // control and the list it produces can never disagree.
  const scopeWithout = useCallback((skip: "method" | "person") => (
    splitView
      ? txns.filter((t) => (t.direction === "in"
            ? passesBase(t, !!searchIn.trim(), skip) && matchesQuery(t, searchIn)
            : passesBase(t, !!searchOut.trim(), skip) && matchesQuery(t, searchOut)))
      : txns.filter((t) =>
          passesBase(t, !!search.trim(), skip) &&
          (dirFilter === "all" || t.direction === dirFilter) &&
          matchesQuery(t, search))
  ), [txns, passesBase, splitView, search, searchIn, searchOut, dirFilter]);

  // Distinct account ids present in the loaded transactions (for the filter).
  const accounts = useMemo(
    () => Array.from(new Set(txns.map((t) => t.account_id).filter(Boolean))).sort(),
    [txns],
  );

  // Smart grouping — cluster un-booked rows by (payer, direction) so a whole
  // backlog of look-alikes can be tagged in one click. Payer + direction keeps the
  // same payer's money-in and money-out apart (a Zelle to "Walmart Loads" never
  // merges with a "Walmart" store purchase). Surface the top 3 groups of 4+.
  const suggestedGroups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; payee: string; direction: "in" | "out"; count: number; cats: Record<string, number>; defaultCat: string }
    >();
    for (const t of txns) {
      if (t.reviewed) continue;
      const payee = (t.counterparty_name || "").trim();
      if (!payee) continue;
      const key = `${payee.toLowerCase()}|${t.direction}`;
      let g = map.get(key);
      if (!g) { g = { key, payee, direction: t.direction, count: 0, cats: {}, defaultCat: "" }; map.set(key, g); }
      g.count += 1;
      if (t.category) g.cats[t.category] = (g.cats[t.category] || 0) + 1;
    }
    const groups = Array.from(map.values()).filter((g) => g.count >= 3 && !dismissedGroups.has(g.key));
    for (const g of groups) {
      let best = "", bestN = 0;
      for (const [c, n] of Object.entries(g.cats)) if (n > bestN) { best = c; bestN = n; }
      g.defaultCat = best; // most common existing category in the group (or blank)
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 10);
  }, [txns, dismissedGroups]);

  const dismissGroup = (key: string) => setDismissedGroups((prev) => new Set(prev).add(key));

  // Summary scoped to the active date range so the To-do/Booked counts (and the
  // figures strip) reflect only what's in view — pre-January rows you've excluded
  // via the date filter don't inflate the "left to review" count.
  const rangeSummary = useMemo(() => {
    let total = 0, reviewed = 0, sumIn = 0, sumOut = 0, unclassified = 0, needsDeal = 0, shippingOut = 0;
    for (const t of txns) {
      const d = (t.posted_at || "").slice(0, 10);
      if (fromDate && d < fromDate) continue;
      if (toDate && d > toDate) continue;
      total++;
      if (t.reviewed) reviewed++;
      // Money-in/out excludes internal transfers (they hit both sides) and card
      // payments (the same spend already counted as the card purchase) so the
      // totals reflect real external cash movement, not double counts.
      const cat = t.category || "";
      if (cat !== "internal_transfer" && cat !== "card_payment") {
        if (t.direction === "in") sumIn += t.amount; else sumOut += t.amount;
      }
      if (!(t.category || "").trim()) unclassified++;
      // "Needs a deal" = still in the queue, with money to tie out, in a category
      // that can belong to a deal at all (see needsADeal). Booking a row marks it
      // reviewed, so it clears — the counter can actually reach zero.
      if (!t.reviewed && needsADeal(t)) needsDeal++;
      // Freight is a real cost that had no figure anywhere (R-174). Money-out only:
      // a credit from a carrier is not spend, and netting it would understate it.
      if (cat === "shipping" && t.direction === "out") shippingOut += t.amount;
    }
    return { total, reviewed, sumIn, sumOut, unclassified, needsDeal, shippingOut };
  }, [txns, fromDate, toDate]);

  // What one category adds up to (R-174). Nothing anywhere rolled a category up to
  // a total before this, so "how much did shipping cost me" had no answer on any
  // screen. Money in and money out stay separate - a category like `shipping` can
  // carry a refund from a carrier, and one netted figure would hide it.
  //
  // Scoped to the date range only, NOT to the other facets: this strip explains
  // what picking the category means, so it has to describe the whole category.
  const catSummary = useMemo(() => {
    if (catFilter === "all") return null;
    let outN = 0, outSum = 0, inN = 0, inSum = 0, tied = 0;
    for (const t of txns) {
      if ((t.category || "") !== catFilter) continue;
      const d = (t.posted_at || "").slice(0, 10);
      if (fromDate && d < fromDate) continue;
      if (toDate && d > toDate) continue;
      if (t.direction === "in") { inN++; inSum += t.amount; } else { outN++; outSum += t.amount; }
      // Fully allocated means every cent of it sits on a deal.
      if (t.unallocated <= 0.0001) tied++;
    }
    return { outN, outSum, inN, inSum, tied, total: outN + inN };
  }, [txns, catFilter, fromDate, toDate]);

  // ── To book — the daily queue ────────────────────────────────────────────────
  // Every unbooked transaction, org-wide, newest first. Search and account narrow
  // it; nothing else hides rows.
  const toBookRows = useMemo(
    () => txns
      .filter((t) => !t.reviewed &&
        (toBookAcct === "all" || t.account_id === toBookAcct) &&
        matchesQuery(t, toBookSearch))
      .sort((a, b) => (b.posted_at || "").localeCompare(a.posted_at || "")),
    [txns, toBookAcct, toBookSearch],
  );

  // Headline figures: rows waiting, and money still needing a deal — the same
  // definition as rangeSummary.needsDeal (kept in step with bank_txn_summary and
  // financials_overview.stale_unallocated), with no date window.
  const toBookStats = useMemo(() => {
    let count = 0, needsDealAmt = 0;
    for (const t of txns) {
      if (t.reviewed) continue;
      count++;
      if (needsADeal(t)) needsDealAmt += t.unallocated;
    }
    return { count, needsDealAmt };
  }, [txns]);

  // Rows grouped by posted day, newest day first (toBookRows is already sorted).
  const toBookGroups = useMemo(() => {
    const groups: { date: string; rows: BankTxn[] }[] = [];
    for (const t of toBookRows) {
      const d = (t.posted_at || "").slice(0, 10);
      const g = groups[groups.length - 1];
      if (g && g.date === d) g.rows.push(t); else groups.push({ date: d, rows: [t] });
    }
    return groups;
  }, [toBookRows]);

  // What was accomplished this month — the caught-up state should read like an
  // achievement, not a shrug.
  const monthBooked = useMemo(() => {
    const now = new Date();
    const pfx = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let amt = 0, n = 0;
    for (const t of txns) {
      if (!(t.posted_at || "").startsWith(pfx)) continue;
      if (t.allocated > 0.0001) { amt += t.allocated; n++; }
    }
    return { amt, n };
  }, [txns]);

  // localDay comes from lib/format (never `new Date("YYYY-MM-DD")` — that
  // parses as UTC and renders a day early in Central time).
  const dayHeading = (iso: string) => {
    if (!iso) return "No date";
    if (iso === localDay(new Date())) return "Today";
    if (iso === localDay(new Date(Date.now() - 86400000))) return "Yesterday";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: y === new Date().getFullYear() ? undefined : "numeric" });
  };

  // The left rail carries state: solid accent = needs a deal, faded = partly
  // tied, none = nothing owed. That is what colour is for on this screen.
  const railClass = (t: BankTxn) => {
    if (t.allocated > 0.0001 && t.unallocated > 0.0001) return "border-l-2 border-accent/40";
    if (needsADeal(t)) return "border-l-2 border-accent";
    return "border-l-2 border-transparent";
  };

  // The subline says what the row NEEDS, not what it is. An expense never asks for
  // a deal — a fuel purchase or a software subscription is fully booked by its
  // category, and saying "needs a deal" on one made the queue read as unfinishable.
  const needsLine = (t: BankTxn) => {
    const acct = t.account_id ? ` · ${t.account_id}` : "";
    if (t.counterparty_type === "loan") return `${loanTagLabel(t.direction)}${acct}`;
    if (t.allocated > 0.0001 && t.unallocated > 0.0001)
      return `${fmtAmount(t.allocated)} of ${fmtAmount(t.amount)} tied${acct}`;
    if (t.allocated > 0.0001) return `Tied to a deal — book it${acct}`;
    const noCat = !(t.category || "").trim();
    if (noCat) return `Needs a category${acct}`;
    if (needsADeal(t)) return `${catLabel(t.category)} — needs a deal${acct}`;
    return `${catLabel(t.category || "")} — ready to book${acct}`;
  };

  // Reset every Ledger filter in one click — the filtered-to-nothing state used
  // to be a grey line with no exit.
  const clearFilters = () => {
    setSearch(""); setSearchIn(""); setSearchOut("");
    setDirFilter("all"); setAcctFilter("all"); setCatFilter("all"); setStatusFilter("all");
    setMethodFilter("all"); setPersonFilter("all");
    setQueue("all");
    setFromDate(`${new Date().getFullYear()}-01-01`); setToDate(`${new Date().getFullYear()}-12-31`);
  };

  // ── What the method filter is NOT showing (W2-b) ──────────────────────────
  // Counted over the rows every OTHER filter already admits, so these ARE the
  // numbers for what would be on screen. They ride in the select's own option
  // labels, so the size of the pile the classifier could not read is visible
  // before anything is hidden — and again, in words, once a method is selected.
  // `confirmed` counts the human's own column, NOT the `certain` state — those two
  // are not the same set. A row the bank itself supplied a method for is certain and
  // nobody confirmed it, so counting it under "you confirmed" would put a false
  // claim in the caption below.
  const methodCounts = useMemo(() => {
    const out = { unclassified: 0, confirmed: {} as Record<string, number>, total: {} as Record<string, number> };
    for (const t of scopeWithout("method")) {
      const r = methodOf(t);
      if (r.state === "unclassified") { out.unclassified += 1; continue; }
      out.total[r.method] = (out.total[r.method] || 0) + 1;
      if (t.confirmed_method) out.confirmed[r.method] = (out.confirmed[r.method] || 0) + 1;
    }
    return out;
  }, [scopeWithout, methodOf]);

  // People who actually appear in the ledger, plus whoever is selected — so a
  // profile can deep-link someone with nothing tagged yet and the control still
  // shows who it is filtered to, with a count of zero, instead of resetting itself.
  const peopleInLedger = useMemo(() => {
    const rows = scopeWithout("person");
    const counts = new Map<string, number>();
    let linked = 0;
    for (const t of rows) {
      const p = personOf(t);
      if (!p) continue;
      linked += 1;
      counts.set(personKey(p), (counts.get(personKey(p)) || 0) + 1);
    }
    if (personFilter.includes(":") && !counts.has(personFilter)) counts.set(personFilter, 0);
    const list = [...counts].map(([key, n]) => ({
      person: peopleByKey.get(key)
        ?? { type: key.split(":")[0] as "client" | "supplier", id: key.split(":")[1], name: "Record not found" },
      n,
    }));
    list.sort((a, b) => b.n - a.n || a.person.name.localeCompare(b.person.name));
    return { rows: list, linked, unlinked: rows.length - linked };
  }, [scopeWithout, personOf, peopleByKey, personFilter]);

  // Tax-year scope (R-145). Every year that appears in the ledger, newest first —
  // so old years stay reachable exactly as the accountant needs them, one at a time.
  const taxYears = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    for (const t of txns) {
      const y = Number((t.posted_at || "").slice(0, 4));
      if (y > 1990) ys.add(y);
    }
    return [...ys].sort((a, b) => b - a);
  }, [txns]);
  // Which option the current from/to bounds represent: a whole tax year, everything,
  // or a hand-picked range.
  const taxYearValue = useMemo(() => {
    if (!fromDate && !toDate) return "all";
    const m = /^(\d{4})-01-01$/.exec(fromDate);
    if (m && toDate === `${m[1]}-12-31`) return m[1];
    return "custom";
  }, [fromDate, toDate]);
  const pickTaxYear = (v: string) => {
    if (v === "all") { setFromDate(""); setToDate(""); return; }
    if (v === "custom") return; // the date inputs are the editor for this
    setFromDate(`${v}-01-01`); setToDate(`${v}-12-31`);
  };

  const filteredDeals = useMemo(() => {
    const q = dealQuery.trim().toLowerCase();
    const ot = openId ? txns.find((t) => t.id === openId) : null;
    const cp = (ot?.counterparty_name || "").trim().toLowerCase();
    const amt = ot?.amount || 0;
    // Server-scored candidates (R-150) for the open transaction — the local
    // ranking only knows buyer names, so supplier matches come from here.
    const sc = openId ? serverSugg.get(openId) ?? [] : [];
    return survivorDeals(deals)
      .filter((d) => !q || `${d.client_name || ""} ${d.name || ""} ${d.invoice_number || ""}`.toLowerCase().includes(q))
      .map((d) => {
        // Rank deals that match the open transaction (same buyer / same amount) to
        // the top so the right deal is one glance away.
        let score = 0;
        if (sc.some((c) => c.deal_id === d.id)) score += 250;
        if (cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp)) score += 100;
        if (amt && d.invoice_total && Math.abs(d.invoice_total - amt) < 0.5) score += 60;
        const when = Date.parse(d.completed_at || d.created_at || "") || 0;
        return { d, score, when };
      })
      .sort((a, b) => b.score - a.score || b.when - a.when)
      .slice(0, 20)
      .map((x) => x.d);
  }, [deals, dealQuery, openId, txns, serverSugg]);

  // txn id → the single obvious deal for it, if there is one. Computed once per data
  // change (not per row render) and shared by every table instance. The server
  // engine (R-150) wins when it has an unambiguous answer; the local matcher stays
  // as the offline fallback.
  const confidentMatches = useMemo(() => {
    const pool = survivorDeals(deals);
    const m = new Map<string, { deal: DealFlow; reason: string; candidate?: BankSuggestCandidate }>();
    for (const t of txns) {
      const sc = serverMatchFor(t, pool, serverSugg.get(t.id));
      if (sc) { m.set(t.id, sc); continue; }
      const c = confidentMatch(t, pool);
      if (c) m.set(t.id, c);
    }
    return m;
  }, [txns, deals, serverSugg]);

  // Booking memory — what the book itself already says about a payee. Only BOOKED
  // rows teach (reviewed = a human confirmed the classification; unreviewed Plaid
  // categories are machine guesses and teaching from them would launder noise into
  // advice). A payee+direction suggests its dominant category once it has been booked
  // that way at least twice and in at least 60% of its booked rows — one odd booking
  // must never become "usually".
  const catMemory = useMemo(() => {
    const counts = new Map<string, Map<string, number>>();
    for (const t of txns) {
      if (!t.reviewed || !(t.category || "").trim()) continue;
      const p = (t.counterparty_name || "").trim().toLowerCase();
      if (!p) continue;
      const key = `${p}|${t.direction}`;
      const m = counts.get(key) ?? new Map<string, number>();
      m.set(t.category, (m.get(t.category) || 0) + 1);
      counts.set(key, m);
    }
    const out = new Map<string, { cat: string; count: number }>();
    for (const [key, m] of counts) {
      let best = "", bestN = 0, total = 0;
      for (const [cat, n] of m) { total += n; if (n > bestN) { best = cat; bestN = n; } }
      if (bestN >= 2 && bestN / total >= 0.6) out.set(key, { cat: best, count: bestN });
    }
    return out;
  }, [txns]);
  const suggestionFor = (t: BankTxn) => {
    if ((t.category || "").trim() || t.counterparty_type === "loan") return null;
    const p = (t.counterparty_name || "").trim().toLowerCase();
    if (!p) return null;
    return catMemory.get(`${p}|${t.direction}`) ?? null;
  };

  // Tag a transaction to a person. Identity only — it writes counterparty_type/id
  // and nothing else, so no money figure anywhere can move. Never auto-applied:
  // every path into this is a click.
  const tagPerson = async (t: BankTxn, p: PersonRef) => {
    setPersonBusy(t.id);
    try {
      await api.tagBankTxnCounterparty(t.id, p.type, p.id);
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, counterparty_type: p.type, counterparty_id: p.id } : x)));
      setPersonPickerFor(null);
      setLinkOfferFor((cur) => (cur === t.id ? null : cur));
      toast(`Linked to ${p.name}`);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPersonBusy(null); }
  };

  const untagPerson = async (t: BankTxn) => {
    setPersonBusy(t.id);
    try {
      await api.untagBankTxnCounterparty(t.id);
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, counterparty_type: "", counterparty_id: "" } : x)));
      toast("Link removed");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPersonBusy(null); }
  };

  // The server's top candidate for a transaction with no person yet — one tap to
  // confirm, the runners-up behind the picker. Loan-tagged rows are never offered
  // a party: their two counterparty columns are already spoken for.
  const personSuggestionFor = useCallback((t: BankTxn): BankPersonCandidate | null => {
    if (t.counterparty_type) return null;
    return personSugg.get(t.id)?.[0] ?? null;
  }, [personSugg]);

  // ── Setting the method by hand (W2-c) ─────────────────────────────────────
  // Writes `confirmed_method` alone. Never touches category, allocation or
  // `reviewed`, so confirming a wire cannot re-stamp another column's sync clock —
  // the exact failure `review_cols` was extracted to prevent. It also never touches
  // `rail`: that column belongs to the statement importer, and overwriting it would
  // put an answer back into the same field as a guess.
  const setMethod = async (t: BankTxn, method: BankMethod | "") => {
    try {
      await api.setBankTxnReview(t.id, { confirmed_method: method });
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, confirmed_method: method } : x)));
      const payee = (t.counterparty_name || "").trim();
      if (!method || !payee) { setMethodOffer(null); return; }
      // W2-d: offer to remember it for this payee. Only rows not already CONFIRMED
      // as that method count, so the number offered is the number that will change —
      // a row whose `rail` happens to agree has still never been answered.
      const ids = txns
        .filter((x) => x.id !== t.id && payeeKey(x) === payeeKey(t) && (x.confirmed_method || "") !== method)
        .map((x) => x.id);
      setMethodOffer(ids.length ? { txnId: t.id, payee, direction: t.direction, method, ids } : null);
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // Apply the confirmed method across the payee, one existing command per row —
  // the same shape as every other bulk action on this screen (`runBulk`).
  const applyMethodToPayee = async () => {
    const offer = methodOffer;
    if (!offer) return;
    setMethodBusy(true);
    let done = 0, failed = 0;
    for (const id of offer.ids) {
      try { await api.setBankTxnReview(id, { confirmed_method: offer.method }); done += 1; }
      catch { failed += 1; }
      setBulkProgress(`Updating ${done + failed} of ${offer.ids.length}…`);
    }
    setBulkProgress("");
    setMethodBusy(false);
    setMethodOffer(null);
    setTxns((prev) => prev.map((x) => (offer.ids.includes(x.id) ? { ...x, confirmed_method: offer.method } : x)));
    toast(failed
      ? `${done} set to ${methodLabel(offer.method).toLowerCase()} · ${failed} failed`
      : `${done} more from ${offer.payee} set to ${methodLabel(offer.method).toLowerCase()}`,
      failed ? "error" : "success");
  };

  const filteredLoans = useMemo(() => {
    const q = loanQuery.toLowerCase();
    return loans
      .filter((l) => `${l.name || ""} ${l.lender || ""}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [loans, loanQuery]);

  // Deal column — quiet allocation state only. A confident match is no longer
  // announced here: it renders as the chip under the payee, which names the deal and
  // carries the one-click "Tie it". A bare accent "match" in this cell said less, had
  // no action attached, and read as a typo rather than an affordance.
  const dealCell = (t: BankTxn) => {
    if (t.counterparty_type === "loan") return <span className="text-muted">—</span>;
    if (t.allocated > 0.0001 && t.unallocated <= 0.0001) return <span className="text-muted">Linked</span>;
    if (t.allocated > 0.0001)
      return <span className="text-muted tabular-nums">{fmtAmount(t.allocated)} of {fmtAmount(t.amount)}</span>;
    return <span className="text-muted">Link a deal</span>;
  };

  const openTxn = openId ? txns.find((t) => t.id === openId) ?? null : null;

  // One transaction table for a given row set — reused by the combined list, each
  // split pane, and the "needs a category" collapse. Selection and the inline
  // allocation panel behave identically in every instance (openId is global, so
  // only one row is ever expanded at a time).
  const renderTxnTable = (rows: BankTxn[]) => (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[560px]">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="py-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all shown transactions"
                    checked={rows.length > 0 && rows.every((t) => selected.has(t.id))}
                    ref={(el) => {
                      if (el) el.indeterminate =
                        rows.some((t) => selected.has(t.id)) && !rows.every((t) => selected.has(t.id));
                    }}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) rows.forEach((t) => next.add(t.id));
                        else rows.forEach((t) => next.delete(t.id));
                        return next;
                      })
                    }
                    className="align-middle accent-accent"
                  />
                </th>
                <th className="w-7" aria-label="Direction" />
                <th className="text-[11px] font-medium text-muted py-2 pr-3 whitespace-nowrap">Date</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Payee</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Category</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Method</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3 text-right whitespace-nowrap">Amount</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Deal</th>
                <th className="text-[11px] font-medium text-muted py-2 text-center whitespace-nowrap w-12">Book</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const payee = t.counterparty_name?.trim();
                const mainLabel = payee || t.description || "—";
                const memo = payee ? t.description : "";
                // The obvious-deal suggestion. Hidden while the row is expanded — the
                // full allocate panel is already open there.
                const cm = openId === t.id ? null : confidentMatches.get(t.id) ?? null;
                const mr = methodOf(t);
                const linked = personOf(t);
                const psug = personSuggestionFor(t);
                return (
                <Fragment key={t.id}>
                  <tr
                    data-txn-id={t.id}
                    onClick={() => toggleRow(t)}
                    className={`${cm ? "" : "border-b border-line-2"} cursor-pointer transition-colors ${
                      selected.has(t.id) || openId === t.id ? "bg-surface-2" : "hover:bg-surface-2"
                    }`}
                  >
                    <td className="py-3 pr-2 align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Select transaction"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        className="align-middle accent-accent"
                      />
                    </td>
                    <td className="py-3 align-top">
                      {t.direction === "in"
                        ? <ArrowDownLeft size={15} className="text-success-ink" strokeWidth={2} />
                        : <ArrowUpRight size={15} className="text-danger-ink" strokeWidth={2} />}
                    </td>
                    <td className="py-3 pr-3 tabular-nums text-muted whitespace-nowrap align-top">
                      <div>{(t.posted_at || "").slice(0, 10)}</div>
                      {fmtTime(t.posted_dt) && <div className="text-[10px] text-faint">{fmtTime(t.posted_dt)}</div>}
                    </td>
                    <td
                      className="py-3 pr-3 align-top max-w-[300px]"
                      onClick={(e) => { if (payeeEditId === t.id) e.stopPropagation(); }}
                    >
                      {payeeEditId === t.id ? (
                        <input
                          autoFocus
                          value={payeeDraft}
                          aria-label="Payee name"
                          onChange={(e) => setPayeeDraft(e.target.value)}
                          onBlur={(e) => commitPayeeEdit(t, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                            else if (e.key === "Escape") { e.preventDefault(); payeeCancelRef.current = true; e.currentTarget.blur(); }
                          }}
                          className="w-full min-w-0 bg-surface border border-line rounded px-1.5 py-0.5 text-[13px] font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-ink truncate" title={mainLabel}>{mainLabel}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPayeeDraft(payee || t.description || "");
                              setPayeeEditId(t.id);
                            }}
                            title="Rename payee"
                            aria-label="Rename payee"
                            className="text-faint hover:text-ink-2 flex-shrink-0 transition-colors"
                          >
                            <Pencil size={12} />
                          </button>
                        </div>
                      )}
                      {memo && <div className="text-[11px] text-faint truncate" title={memo}>{memo}</div>}
                      {/* W1-a — the person on this payment, as its own action. Tagging
                          is identity: it says who the money is from or to and moves no
                          money figure anywhere. A loan-tagged row is skipped; its two
                          counterparty columns already mean something else. */}
                      {t.counterparty_type !== "loan" && (
                        <div className="flex items-center gap-1.5 mt-0.5 min-w-0" onClick={(e) => e.stopPropagation()}>
                          {linked ? (
                            <>
                              <button
                                onClick={() => setPersonPickerFor(t.id)}
                                title={`${personTypeLabel(linked.type)} — click to change`}
                                className="min-w-0 inline-flex items-center gap-1 h-5 px-1.5 rounded border border-line-2 text-[11px] text-ink-2 hover:border-line-3 transition-colors"
                              >
                                <Building2 size={10} className="text-muted flex-shrink-0" />
                                <span className="truncate max-w-[150px]">{linked.name}</span>
                              </button>
                              <button
                                onClick={() => untagPerson(t)}
                                disabled={personBusy === t.id}
                                title="Remove this link"
                                aria-label="Remove person link"
                                className="text-faint hover:text-ink-2 disabled:opacity-50 flex-shrink-0 transition-colors"
                              >
                                <X size={11} />
                              </button>
                            </>
                          ) : psug ? (
                            <>
                              <button
                                onClick={() => tagPerson(t, { type: psug.type, id: psug.id, name: psug.name })}
                                disabled={personBusy === t.id}
                                title={`Link this payment to ${psug.name} — ${psug.reason}`}
                                className="min-w-0 inline-flex items-center gap-1 h-5 px-1.5 rounded border border-accent/40 bg-accent/5 text-accent text-[11px] font-medium hover:bg-accent/10 disabled:opacity-50 transition-colors"
                              >
                                {personBusy === t.id
                                  ? <Loader2 size={10} className="animate-spin flex-shrink-0" />
                                  : <Plus size={10} className="flex-shrink-0" />}
                                <span className="truncate max-w-[150px]">{psug.name}?</span>
                              </button>
                              <button
                                onClick={() => setPersonPickerFor(t.id)}
                                className="text-[11px] text-muted hover:text-ink-2 flex-shrink-0 transition-colors"
                              >
                                Someone else
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setPersonPickerFor(t.id)}
                              className="text-[11px] text-faint hover:text-ink-2 transition-colors"
                            >
                              Link a person
                            </button>
                          )}
                        </div>
                      )}
                      {/* The rename trap (R-156 §5): renaming a payee edits a free-text
                          string and links nothing. Say so, right where it happened. */}
                      {linkOfferFor === t.id && !linked && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setPersonPickerFor(t.id); }}
                          className="mt-0.5 block text-[11px] text-accent hover:text-accent-hover text-left transition-colors"
                        >
                          Renaming only changed the label — link this to a person too?
                        </button>
                      )}
                    </td>
                    <td className="py-3 pr-3 align-top" onClick={(e) => e.stopPropagation()}>
                      {t.counterparty_type === "loan" ? (
                        <span className="text-[12px] text-ink-2 whitespace-nowrap">{loanTagLabel(t.direction)}</span>
                      ) : (
                        <span className="relative inline-flex items-center">
                          <select
                            value={t.category || ""}
                            aria-label="Category"
                            onChange={(e) => saveReview(t, { category: e.target.value })}
                            className={`appearance-none h-7 pl-2 pr-6 rounded-md border text-[12px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors ${
                              t.category
                                ? "bg-transparent border-line text-ink-2 hover:border-line-3"
                                : "bg-accent/5 border-accent/40 text-accent font-semibold hover:bg-accent/10"
                            }`}
                          >
                            <option value="">Set category</option>
                            <CategoryOptions includeUncat={false} />
                          </select>
                          <ChevronDown
                            size={12}
                            className={`pointer-events-none absolute right-1.5 ${t.category ? "text-faint" : "text-accent"}`}
                          />
                        </span>
                      )}
                    </td>
                    {/* W2-c — set the method by hand, on the row. Three states are
                        visually distinct: confirmed reads as solid, a guess is faint
                        and marked "likely", and nothing read is the accent prompt.
                        The select's value is only ever the CONFIRMED method, so
                        neither the memo classifier nor the importer's `rail` ever
                        looks like a decision that was made. */}
                    <td className="py-3 pr-3 align-top" onClick={(e) => e.stopPropagation()}>
                      <span className="relative inline-flex items-center">
                        <select
                          value={t.confirmed_method || ""}
                          aria-label="Payment method"
                          title={mr.state === "unclassified" ? "No payment method could be read from the memo" : `${methodLabel(mr.method)} — ${mr.reason}`}
                          onChange={(e) => setMethod(t, e.target.value as BankMethod | "")}
                          className={`appearance-none h-7 pl-2 pr-6 rounded-md border text-[12px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors ${
                            mr.state === "certain"
                              ? "bg-transparent border-line text-ink-2 hover:border-line-3"
                              : mr.state === "likely"
                                ? "bg-transparent border-line-2 text-muted hover:border-line-3"
                                : "bg-accent/5 border-accent/40 text-accent font-semibold hover:bg-accent/10"
                          }`}
                        >
                          <option value="">
                            {mr.state === "likely" ? `${methodLabel(mr.method)} — likely` : "Set method"}
                          </option>
                          {METHODS.map((m) => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                        <ChevronDown
                          size={12}
                          className={`pointer-events-none absolute right-1.5 ${mr.state === "unclassified" ? "text-accent" : "text-faint"}`}
                        />
                      </span>
                    </td>
                    <td className={`py-3 pr-3 text-right tabular-nums whitespace-nowrap align-top font-medium ${t.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
                      {t.direction === "in" ? "+" : "−"}{fmtAmount(t.amount)}
                    </td>
                    <td className="py-3 pr-3 text-[12px] whitespace-nowrap align-top">{dealCell(t)}</td>
                    <td className="py-3 text-center align-top" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => saveReview(t, { reviewed: !t.reviewed })}
                        title={t.reviewed ? "Booked — click to reopen" : "Mark this transaction booked"}
                        className={`h-7 px-2.5 rounded-md inline-flex items-center gap-1 justify-center border text-[11.5px] font-semibold transition-colors whitespace-nowrap ${
                          t.reviewed
                            ? "bg-ink border-ink text-surface"
                            : "border-accent/40 bg-accent/5 text-accent hover:bg-accent/10"
                        }`}
                      >
                        <Check size={11} strokeWidth={2.4} /> {t.reviewed ? "Booked" : "Book"}
                      </button>
                    </td>
                  </tr>

                  {/* W2-d — remember the method for this payee. Only a CONFIRMED row
                      offers this: the classifier's own guesses never teach, which is
                      the rule R-018 already enforces for categories. The count is of
                      rows that will actually change, so the number offered is the
                      number that moves. */}
                  {methodOffer?.txnId === t.id && (
                    <tr className={`border-b border-line-2 ${selected.has(t.id) ? "bg-surface-2" : ""}`}>
                      <td colSpan={3} />
                      <td colSpan={6} className="pb-3 pr-3 align-top">
                        <div className="flex items-center gap-2 flex-wrap min-w-0" onClick={(e) => e.stopPropagation()}>
                          <span className="text-[11.5px] text-muted min-w-0">
                            {methodOffer.ids.length} more from{" "}
                            <span className="text-ink-2 font-medium">{methodOffer.payee}</span>{" "}
                            ({methodOffer.direction === "in" ? "money in" : "money out"})
                          </span>
                          <button
                            onClick={applyMethodToPayee}
                            disabled={methodBusy}
                            className="flex items-center gap-1 h-6 px-2 rounded-md border border-accent/40 bg-accent/5 text-accent text-[11.5px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors flex-shrink-0"
                          >
                            {methodBusy ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
                            Set them all to {methodLabel(methodOffer.method).toLowerCase()}
                          </button>
                          <button
                            onClick={() => setMethodOffer(null)}
                            aria-label="Dismiss"
                            className="text-muted hover:text-ink-2 transition-colors flex-shrink-0"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {cm && (
                    <tr className={`border-b border-line-2 ${selected.has(t.id) ? "bg-surface-2" : ""}`}>
                      <td colSpan={3} />
                      <td colSpan={6} className="pb-3 pr-3 align-top">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span className="text-[11.5px] text-muted min-w-0">
                            Looks like <span className="text-ink-2 font-medium">{matchLabel(cm.deal)}</span> — {cm.reason}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); tieMatch(t, cm.deal, cm.candidate); }}
                            disabled={tyingId === t.id}
                            title={`Tie to ${dealLabel(cm.deal)} as ${cm.candidate?.role === "supplier_payment" ? "a supplier payment" : cm.candidate?.role === "buyer_payment" ? "a buyer payment" : t.direction === "out" ? "a supplier payment" : "a buyer payment"} — ${cm.reason}`}
                            className="flex items-center gap-1 h-6 px-2 rounded-md border border-accent/40 bg-accent/5 text-accent text-[11.5px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors flex-shrink-0"
                          >
                            {tyingId === t.id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />} Tie it
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="text-center py-10 text-[12px] text-muted">
              No transactions match these filters
              <button
                onClick={clearFilters}
                className="block mx-auto mt-2 text-[12px] font-medium text-accent hover:text-accent-hover"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
  );

  // Loading placeholder at roughly row height, so the page stops jumping.
  const skeletonRows = (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-[52px] rounded-lg bg-surface-2 animate-pulse" />
      ))}
    </div>
  );

  // A load failure must never render as an empty ledger — that reads as data
  // loss and hides the real cause. Shared by the To-book and Ledger surfaces.
  const errorState = (
    <div className="text-center py-20">
      <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
        <AlertTriangle size={18} className="text-danger-ink" />
      </div>
      <p className="text-[14px] font-semibold text-ink-2">Could not load your transactions</p>
      <p className="text-[12px] text-muted mt-1 max-w-[420px] mx-auto break-words">{loadError}</p>
      <p className="text-[11.5px] text-faint mt-1">Nothing has been changed or lost — this is a read that failed.</p>
      <button
        onClick={() => { setLoading(true); loadAll(); }}
        className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover"
      >
        Try again
      </button>
    </div>
  );

  // First run: the right door is the bank feed, not a statement upload.
  const firstRunState = (
    <div className="text-center py-20">
      <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
        <Landmark size={18} className="text-faint" />
      </div>
      <p className="text-[14px] font-semibold text-ink-2">No transactions yet</p>
      <p className="text-[12px] text-muted mt-1">
        {plaidItems.length > 0
          ? "Nothing has arrived from your bank yet"
          : "Connect your bank for a live feed, or import a statement"}
      </p>
      <button onClick={() => setTab("setup")} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
        {plaidItems.length > 0 ? "Open setup" : "Connect your bank"}
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="min-w-0 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold text-ink tracking-tight truncate">Financials</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {tab === "tobook" ? "Book the money that came in and went out"
              : tab === "ledger" ? "Everything ever — search, filter, drill in"
              : tab === "cash" ? "Free cash, reserves and loans"
              : "Bank connections, statement imports and cleanup tools"}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {plaidItems.length > 0 && (
            // Honest wording: the bank feed is pulled on a 20-minute timer by this
            // device (main.rs), not continuously. "Auto-syncing" read as live.
            <span className="text-[11.5px] text-muted whitespace-nowrap">Bank feed checked every 20 min</span>
          )}
          <button
            onClick={refreshScreen}
            disabled={refreshing}
            title="Re-read transactions, deals and loans"
            className="text-[12px] text-muted hover:text-ink-2 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Surface nav — To book is the daily queue and opens first; its count is
          the one number that says whether there is work to do. */}
      <div className="flex items-center gap-5 border-b border-line">
        {([
          ["tobook", "To book"],
          ["ledger", "Ledger"],
          ["cash", "Cash"],
          ["setup", "Setup"],
        ] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`-mb-px pb-2 text-[13px] border-b-2 transition-colors ${
              tab === v ? "text-ink font-semibold border-ink" : "text-muted border-transparent hover:text-ink-2"
            }`}
          >
            {label}
            {v === "tobook" && toBookStats.count > 0 && (
              <span className="ml-1.5 font-normal text-muted tabular-nums">{toBookStats.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Cash — free cash and loans together; the best-designed screens stay as they are. */}
      {tab === "cash" && (
        <div className="space-y-4">
          <div className="flex items-center gap-1">
            {([["freecash", "Free cash"], ["loans", "Loans"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setCashTab(v)}
                className={`px-3 h-8 rounded-lg text-[12.5px] font-medium transition-colors ${
                  cashTab === v ? "bg-surface-2 text-ink border border-line" : "text-muted hover:text-ink-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {cashTab === "freecash" ? <FreeCashView /> : <LoansView />}
        </div>
      )}

      {tab !== "cash" && (
      <div className="space-y-5">
      {/* To book — headline row: how much work waits, plus the daily controls. */}
      {tab === "tobook" && (
        <div className="min-w-0 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[14px] text-ink min-w-0">
            <span className="font-semibold tabular-nums">
              {toBookStats.count === 0 ? "Nothing to book" : `${toBookStats.count} to book`}
            </span>
            {toBookStats.needsDealAmt > 0.005 && (
              <span className="text-muted"> · <span className="tabular-nums">{fmtAmount(toBookStats.needsDealAmt)}</span> waiting on a deal</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="flex items-center gap-1.5 min-w-[190px] bg-surface-2 border border-line rounded-lg px-2.5 h-9">
              <Search size={13} className="text-muted flex-shrink-0" />
              <input
                value={toBookSearch}
                onChange={(e) => setToBookSearch(e.target.value)}
                placeholder="Search payee, memo, exact amount…"
                className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
            {accounts.length > 1 && (
              <select
                value={toBookAcct}
                onChange={(e) => setToBookAcct(e.target.value)}
                className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-9 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="all">All accounts</option>
                {accounts.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            )}
            <button
              onClick={openMissingLinks}
              title="Find completed deals whose payments were never linked to bank transactions, and suggest the matching transactions from history"
              className="flex-shrink-0 flex items-center gap-1.5 px-4 h-9 border border-accent/40 bg-accent/5 text-accent rounded-lg text-[13px] font-semibold hover:bg-accent/10 transition-colors"
            >
              <Wand2 size={14} /> Find missing links
            </button>
            <button
              onClick={() => { setCashDate(localDay()); setCashOpen(true); }}
              className="flex-shrink-0 flex items-center gap-1.5 px-4 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 transition-colors"
            >
              <Plus size={14} /> Record cash
            </button>
          </div>
        </div>
      )}

      {/* R-150 phase 5 — missing payment links on completed deals. Confirm-only:
          every attach flows through allocate_bank_txn and nothing is written
          without a click. */}
      {missingLinksOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setMissingLinksOpen(false)}>
          <div className="bg-surface border border-line rounded-2xl w-full max-w-xl max-h-[82vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold text-ink">Missing payment links</div>
                <div className="text-[11.5px] text-muted mt-0.5">Completed deals whose payments were never tied to bank transactions — candidates from history, confirm before attaching.</div>
              </div>
              <button onClick={() => setMissingLinksOpen(false)} className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2"><X size={16} /></button>
            </div>
            <div className="px-5 py-4 overflow-y-auto flex flex-col gap-3">
              {missingLinksLoading ? (
                <div className="flex items-center gap-2 text-[12.5px] text-muted py-8 justify-center"><Loader2 size={14} className="animate-spin" /> Scanning completed deals…</div>
              ) : missingLinks.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-[13px] text-ink-2 font-medium">Nothing missing</div>
                  {missingLinksScope.truncated ? (
                    <>
                      <div className="text-[12px] text-muted mt-1">Nothing missing in the latest {missingLinksScope.checked} completed deals.</div>
                      <div className="text-[12px] text-muted mt-0.5">Older completed deals weren't scanned.</div>
                    </>
                  ) : (
                    <div className="text-[12px] text-muted mt-1">Every completed deal with recorded payments already has them bank-linked.</div>
                  )}
                </div>
              ) : (
                missingLinks.map((d) => (
                  <div key={d.deal_id} className="border border-line rounded-xl px-4 py-3">
                    <div className="text-[13px] font-semibold text-ink">{d.invoice_number ? `#${d.invoice_number} · ` : ""}{d.client_name || "Deal"}</div>
                    {d.missing.map((m) => (
                      <div key={`${d.deal_id}-${m.leg}-${m.supplier_name ?? ""}`} className="mt-2">
                        <div className="text-[11.5px] text-muted">
                          {m.leg === "buyer_payment" ? `Buyer owed ${fmtAmount(m.target_amount)}` : `Supplier ${m.supplier_name ?? ""} owed ${fmtAmount(m.target_amount)}`}
                        </div>
                        <div className="flex flex-col gap-1.5 mt-1.5">
                          {m.candidates.map((c) => {
                            const txn = txns.find((x) => x.id === c.txn_id);
                            return (
                              <div key={c.txn_id} className="flex items-center justify-between gap-2 bg-surface-2 border border-line rounded-lg px-2.5 py-1.5">
                                <div className="min-w-0 text-[12px] text-ink-2 truncate" title={c.reason}>
                                  {txn ? `${fmtAmount(txn.amount)} · ${txn.counterparty_name || txn.description}` : c.txn_id}
                                  <span className="text-muted"> — {c.reason}</span>
                                </div>
                                <button
                                  onClick={() => attachMissing(c)}
                                  disabled={attachBusy !== null}
                                  className="flex-shrink-0 flex items-center gap-1 h-7 px-2.5 rounded-md border border-accent/40 bg-accent/5 text-accent text-[11.5px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors"
                                >
                                  {attachBusy === c.txn_id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />} Attach
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
              {!missingLinksLoading && missingLinks.length > 0 && missingLinksScope.truncated && (
                <div className="text-[11.5px] text-muted">Scanned the latest {missingLinksScope.checked} completed deals — older completed deals weren't checked.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Setup — import + cleanup toolbar. The container stays mounted (as
          display:contents on other surfaces, so it adds no gap) because the dedupe
          and record-cash modals live inside it and must open from any surface. */}
      <div className={tab === "setup" ? "space-y-1.5" : "contents"}>
        {tab === "setup" && (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          {/* Duplicate cleanup lives here — the primary transactions toolbar — because the
              bank-feed panel it used to sit in collapses itself once a bank is connected. */}
          <button
            onClick={() => previewDedupe(false)}
            disabled={dedupeRunning || bulkBusy}
            title="Find transactions imported more than once (e.g. the same bank connected on two devices) and remove the extra copies."
            className="mr-auto flex items-center gap-1.5 px-3 h-9 border border-accent/40 bg-accent/5 text-accent rounded-lg text-[13px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            {dedupeRunning && !dedupe ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Clean up duplicates
          </button>
          <button
            onClick={clearStatementImports}
            disabled={clearing || bulkBusy}
            title="Delete transactions imported from statement files — keeps the live bank feed"
            className="flex items-center gap-1.5 px-3 h-9 border border-line text-muted rounded-lg text-[13px] font-medium hover:text-danger-ink hover:border-danger-ink/30 hover:bg-danger-bg disabled:opacity-50 transition-colors"
          >
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove statement imports
          </button>
          {(bulkProgress || aiProgress) && (
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {bulkProgress || aiProgress}
            </span>
          )}
          <button
            onClick={aiCategorize}
            disabled={aiBusy}
            className="flex items-center gap-1.5 px-3 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Auto-categorize with AI
          </button>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            Account
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="border border-line px-2.5 h-9 rounded-lg text-[13px] w-40 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <button
            onClick={pickAndPreview}
            disabled={bulkBusy || previewing}
            className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {bulkBusy || previewing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import statement
          </button>
          <button
            onClick={pickAndPreviewAi}
            disabled={aiExtracting || bulkBusy}
            className="flex items-center gap-1.5 px-4 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {aiExtracting || bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Smart import (AI)
          </button>
        </div>
        )}

        {dedupe && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => !dedupeRunning && setDedupe(null)}>
            <div className="bg-surface border border-line rounded-2xl w-full max-w-lg max-h-[82vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-line flex items-center justify-between">
                <div className="text-[15px] font-semibold text-ink">{dedupeDone ? "Duplicates cleaned up" : "Clean up duplicate transactions"}</div>
                <button onClick={() => setDedupe(null)} disabled={dedupeRunning} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 disabled:opacity-40"><X size={16} /></button>
              </div>

              <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
                {dedupeDone ? (
                  <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success-bg/50 px-4 py-3">
                    <Check size={18} className="text-success-ink mt-0.5 shrink-0" />
                    <div className="text-[13px] text-ink-2 leading-relaxed">
                      Removed <span className="font-semibold text-ink">{dedupe.removed || 0}</span> duplicate transaction{(dedupe.removed || 0) === 1 ? "" : "s"}.
                      {(dedupe.skipped_now_referenced || 0) > 0 && <> {dedupe.skipped_now_referenced} were skipped because they became linked to a deal while cleaning.</>}
                      {" "}A copy of everything removed is kept locally, so nothing is truly lost.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                        <div className="text-[11px] text-muted">Total</div>
                        <div className="text-[18px] font-semibold text-ink tabular-nums">{dedupe.total_transactions ?? "—"}</div>
                      </div>
                      <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5">
                        <div className="text-[11px] text-muted">Auto-remove</div>
                        <div className="text-[18px] font-semibold text-accent tabular-nums">{dedupe.auto_remove ?? 0}</div>
                      </div>
                      <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                        <div className="text-[11px] text-muted">To review</div>
                        <div className="text-[18px] font-semibold text-ink tabular-nums">{dedupe.review_count}</div>
                      </div>
                    </div>

                    {/* Same card linked twice under two masks — the reason already-booked
                        transactions kept re-appearing as "needs booking". */}
                    {(dedupe.account_merges?.length || 0) > 0 && (
                      <div className="rounded-xl border border-accent/40 bg-accent/5 px-3.5 py-3">
                        <div className="text-[12.5px] font-semibold text-ink flex items-center gap-1.5">
                          <Landmark size={14} className="text-accent" /> Same account connected twice
                        </div>
                        <p className="text-[11.5px] text-muted leading-relaxed mt-1">
                          These look like one account that got connected twice (the bank returned a different last-4 each time), which is why transactions you already booked keep coming back unbooked. They'll be combined into one account, keeping your reviewed ones.
                        </p>
                        <div className="mt-2 space-y-1">
                          {dedupe.account_merges!.map((m, i) => (
                            <div key={i} className="text-[11.5px] text-ink-2 tabular-nums">
                              <span className="text-muted">{m.from}</span> <span className="text-faint">→</span> <span className="font-medium">{m.to}</span> <span className="text-muted">({m.rows} moved)</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mode: clearly-safe only, or every exact match (same date/amount/memo). */}
                    <div className="flex items-center gap-1 p-1 rounded-xl border border-line bg-surface-2/40">
                      <button onClick={() => previewDedupe(false)} disabled={dedupeRunning}
                        className={`flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors ${!dedupeAggressive ? "bg-surface text-ink shadow-sm border border-line" : "text-muted hover:text-ink-2"}`}>
                        Only clearly-safe
                      </button>
                      <button onClick={() => previewDedupe(true)} disabled={dedupeRunning}
                        className={`flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors ${dedupeAggressive ? "bg-surface text-ink shadow-sm border border-line" : "text-muted hover:text-ink-2"}`}>
                        Every exact match
                      </button>
                    </div>
                    <p className="text-[12px] text-muted leading-relaxed">
                      {dedupeAggressive
                        ? "Removes every extra copy that matches on date, amount, direction and description — including round amounts and generic memos. Anything reviewed or linked to a deal, loan or refund is still never touched, and every removed row is backed up. Run this from one device."
                        : "Removes only the clearly-safe extra copies. Round amounts and generic memos (like ATM / cash / transfer) are left for you below — switch to “Every exact match” to remove those too. Anything reviewed or linked to a deal is never touched. Run this from one device."}
                    </p>
                    {(dedupe.sample?.length || 0) > 0 && (
                      <div>
                        <div className="text-[12px] font-medium text-muted mb-1.5">Will remove (sample)</div>
                        <div className="rounded-xl border border-line divide-y divide-line max-h-40 overflow-y-auto">
                          {dedupe.sample!.map((g, i) => (
                            <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                              <div className="min-w-0">
                                <div className="text-ink-2 truncate">{g.description || "(no memo)"}</div>
                                <div className="text-muted text-[11px]">{g.date} · {g.account}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {g.cross_account && <span className="text-[10px] text-accent bg-accent/10 border border-accent/30 rounded px-1.5 py-0.5">merged acct</span>}
                                <span className={`tabular-nums font-medium ${g.direction === "in" ? "text-success-ink" : "text-ink-2"}`}>{g.direction === "in" ? "+" : "−"}${g.amount.toFixed(2)}</span>
                                <span className="text-[10px] text-muted bg-surface-2 border border-line rounded px-1.5 py-0.5">−{(g.remove?.length || 1)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {dedupe.review.length > 0 && (
                  <div>
                    <div className="text-[12px] font-medium text-warning-ink mb-1.5">Needs your review — not removed</div>
                    <div className="rounded-xl border border-warning/40 bg-warning-bg/30 divide-y divide-warning/20 max-h-48 overflow-y-auto">
                      {dedupe.review.slice(0, 60).map((g, i) => (
                        <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="text-ink-2 truncate">{g.description || "(no memo)"}</div>
                            <div className="text-muted text-[11px]">{g.date} · {g.account} · {g.count ?? 2} copies · {g.reason}</div>
                          </div>
                          <span className={`tabular-nums font-medium shrink-0 ${g.direction === "in" ? "text-success-ink" : "text-ink-2"}`}>{g.direction === "in" ? "+" : "−"}${g.amount.toFixed(2)}</span>
                        </div>
                      ))}
                      {dedupe.review.length > 60 && <div className="px-3 py-2 text-[11px] text-muted">+ {dedupe.review.length - 60} more…</div>}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
                {dedupeDone ? (
                  <button onClick={() => setDedupe(null)} className="h-9 px-4 rounded-lg text-[13px] font-medium bg-accent text-on-accent hover:bg-accent-hover transition-colors">Done</button>
                ) : (
                  <>
                    <button onClick={() => setDedupe(null)} disabled={dedupeRunning} className="h-9 px-4 rounded-lg text-[13px] font-medium border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-40 transition-colors">Cancel</button>
                    <button onClick={executeDedupe} disabled={dedupeRunning || (dedupe.auto_remove || 0) === 0}
                      className="flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-40 transition-colors">
                      {dedupeRunning ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Remove {dedupe.auto_remove || 0} duplicate{(dedupe.auto_remove || 0) === 1 ? "" : "s"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {cashOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCashOpen(false)}>
            <div className="bg-surface border border-line rounded-2xl w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-line flex items-center justify-between">
                <div className="text-[15px] font-semibold text-ink">Record a cash transaction</div>
                <button onClick={() => setCashOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2"><X size={16} /></button>
              </div>
              <div className="px-5 py-4 flex flex-col gap-3">
                <div className="flex gap-2">
                  <button onClick={() => setCashDir("in")} className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${cashDir === "in" ? "bg-success-bg border-success text-success-ink" : "border-line text-muted hover:bg-surface-2"}`}>Cash received</button>
                  <button onClick={() => setCashDir("out")} className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${cashDir === "out" ? "bg-warning-bg border-warning text-warning-ink" : "border-line text-muted hover:bg-surface-2"}`}>Cash paid out</button>
                </div>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Amount</span>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                    <input inputMode="decimal" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} placeholder="0"
                      className="w-full bg-surface-2 border border-line rounded-lg h-9 pl-6 pr-2.5 text-[13.5px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40" />
                  </div>
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Date</span>
                  <input type="date" value={cashDate} onChange={(e) => setCashDate(e.target.value)}
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Who (optional)</span>
                  <input value={cashCp} onChange={(e) => setCashCp(e.target.value)} placeholder="Buyer / supplier name"
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Note (optional)</span>
                  <input value={cashNote} onChange={(e) => setCashNote(e.target.value)} placeholder="e.g. cash pickup"
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <p className="text-[11px] text-muted">Saved as a cash transaction — then allocate it across deals below. It tracks how much is left of the original.</p>
              </div>
              <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
                <button onClick={() => setCashOpen(false)} className="px-4 h-9 rounded-lg border border-line text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
                <button onClick={recordCash} disabled={cashSaving} className="px-5 h-9 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[13px] font-medium disabled:opacity-50">
                  {cashSaving ? "Saving…" : "Record"}
                </button>
              </div>
            </div>
          </div>
        )}
        {tab === "setup" && (
        <p className="text-[11px] text-muted text-right leading-relaxed">
          Smart import reads any statement with AI — for credit cards and other banks. Set a distinct account per card
          (e.g. chase-card, amex) so each groups and dedupes separately. Selecting several files imports them all to the
          Account above, so import one account's statements together.
        </p>
        )}
      </div>

      {/* Bank feed (Plaid) — live transactions straight from the bank */}
      {tab === "setup" && (
      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 size={15} className="text-muted flex-shrink-0" strokeWidth={1.8} />
          <div className="text-[13px] font-semibold text-ink">Bank feed (Plaid)</div>
          {plaidItems.length > 0 && (
            <>
              <span className="text-[12px] text-muted tabular-nums">· {plaidItems.length} connected</span>
              <div className="ml-auto flex items-center gap-2">
                {!bankFeedOpen && (
                  <button
                    onClick={() => syncPlaid("refresh")}
                    disabled={plaidSyncing}
                    title="Ask your bank for today's latest activity, then sync."
                    className="flex items-center gap-1.5 h-8 px-2.5 border border-line text-ink-2 rounded-lg text-[12px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
                  </button>
                )}
                <button
                  onClick={() => setBankFeedOpen((o) => !o)}
                  title={bankFeedOpen ? "Hide bank feed" : "Manage bank feed"}
                  className="text-muted hover:text-ink-2 transition-colors"
                >
                  <ChevronDown size={16} className={`transition-transform ${bankFeedOpen ? "rotate-180" : ""}`} />
                </button>
              </div>
            </>
          )}
        </div>
        {(plaidItems.length === 0 || bankFeedOpen) && (
          <>
        <p className="text-[11px] text-muted leading-relaxed">
          Plaid pulls clean transactions straight from the bank — no statement uploads. After connecting,
          transactions appear in the list below to review and allocate.
        </p>

        {plaidReady !== null && (
          <div className="border border-line-2 rounded-lg p-3.5 bg-surface-2/40">
            {plaidReady === true && !showKeys ? (
              <div className="flex items-center justify-between gap-2 min-w-0">
                {/* This reflects SAVED API KEYS only — not a linked bank, and not a
                    healthy feed. It used to read "Connected", which everyone took to
                    mean a bank was connected. The bank list below is the real state. */}
                <div className="flex items-center gap-1.5 text-[12px] text-ink-2 min-w-0">
                  <Check size={13} className={plaidItems.length > 0 ? "text-success-ink flex-shrink-0" : "text-muted flex-shrink-0"} />
                  <span className="truncate">
                    {plaidItems.length > 0
                      ? <>Bank connected · <span className="font-medium text-ink">{plaidItems.length} {plaidItems.length === 1 ? "bank" : "banks"}</span></>
                      : <>API keys saved · <span className="font-medium text-ink">no bank linked yet</span></>}
                    <span className="text-faint"> · {plaidEnv === "sandbox" ? "Sandbox" : "Production"}</span>
                  </span>
                </div>
                <button
                  onClick={() => setShowKeys(true)}
                  className="text-[11px] text-muted hover:text-ink-2 flex-shrink-0"
                >
                  Manage keys
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-0">
                  <label className="block min-w-0 sm:col-span-2">
                    <span className="block text-[11px] text-muted mb-1">Environment</span>
                    <select
                      value={plaidEnv}
                      onChange={(e) => setPlaidEnv(e.target.value as "sandbox" | "production")}
                      className={`${inp} text-ink-2`}
                    >
                      <option value="sandbox">Sandbox (test)</option>
                      <option value="production">Production (real data)</option>
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className="block text-[11px] text-muted mb-1">Client ID</span>
                    <input
                      value={plaidClientId}
                      onChange={(e) => setPlaidClientId(e.target.value)}
                      placeholder="Plaid client ID"
                      className={inp}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="block text-[11px] text-muted mb-1">Secret</span>
                    <input
                      type="password"
                      value={plaidSecret}
                      onChange={(e) => setPlaidSecret(e.target.value)}
                      placeholder={plaidReady ? "Enter secret to update" : "Plaid secret"}
                      className={inp}
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  Each environment has its own secret. Start in Sandbox to test the flow instantly — in the connect popup,
                  log in with username <span className="font-medium text-ink-2">user_good</span> and password{" "}
                  <span className="font-medium text-ink-2">pass_good</span>. Switch to Production with your production secret
                  for real accounts once your Plaid OAuth is approved. Stored only on this device.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={savePlaidKeys}
                    disabled={plaidSavingKeys}
                    className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    {plaidSavingKeys ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save keys
                  </button>
                  {plaidReady === true && (
                    <button
                      onClick={testPlaidKeys}
                      disabled={plaidTesting}
                      className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                    >
                      {plaidTesting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Test connection
                    </button>
                  )}
                  {plaidReady === true && (
                    <button onClick={() => setShowKeys(false)} className="text-[11px] text-muted hover:text-ink-2 ml-auto">
                      Done
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {plaidReady === true && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={connectBank}
                disabled={plaidConnecting}
                className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {plaidConnecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Connect a bank
              </button>
              {plaidItems.length > 0 && (
                <>
                  <button
                    onClick={() => syncPlaid("refresh")}
                    disabled={plaidSyncing}
                    title="Ask your bank for the very latest activity — today's wires and spending — then sync. Use this when something you just did isn't showing yet."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={14} className="animate-spin" /> : <Building2 size={14} />} Refresh from bank
                  </button>
                  <button
                    onClick={() => syncPlaid()}
                    disabled={plaidSyncing}
                    title="Pull the latest transactions Plaid has already fetched."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
                  </button>
                  <button
                    onClick={() => syncPlaid("full")}
                    disabled={plaidSyncing}
                    title="Reset each bank's sync position and re-pull all transactions from the start — use if transactions are missing."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    Re-pull all
                  </button>
                  <button
                    onClick={clearAndRepull}
                    disabled={plaidSyncing}
                    title="Delete every bank transaction (and its tags/allocations) and re-pull fresh — use after removing a wrong account."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted rounded-lg text-[13px] font-medium hover:text-danger-ink hover:border-danger-ink/30 hover:bg-danger-bg disabled:opacity-50 transition-colors"
                  >
                    <Trash2 size={14} /> Clear all & re-pull
                  </button>
                </>
              )}
            </div>

            <p className="text-[11px] text-muted leading-relaxed">
              Connecting opens Plaid in your browser (that's where bank logins work). Finish there, then come back — it
              syncs automatically.{plaidEnv === "sandbox" && (
                <> Sandbox test login: <span className="font-medium text-ink-2">user_good</span> /{" "}
                <span className="font-medium text-ink-2">pass_good</span>.</>
              )}
            </p>

            {/* Safety backup — an independent, append-only copy of every bank transaction in
                a Google Sheet you own, so you always have a readable record outside the app. */}
            <div className="rounded-xl border border-line bg-surface-2/30 p-3.5 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink flex items-center gap-1.5"><ShieldCheck size={14} className="text-success-ink" /> Backup to Google Sheet</div>
                  <p className="text-[11px] text-muted leading-relaxed mt-0.5">
                    Keeps an append-only copy of every transaction in a sheet you own — a record that stays even if a transaction is removed here. Uses your connected Google account.
                  </p>
                </div>
                <button
                  onClick={runBackupNow}
                  disabled={backupBusy || !backupUrl.trim()}
                  title={backupUrl.trim() ? "Append any new transactions to the sheet now" : "Add your Google Sheet link first"}
                  className="flex items-center gap-1.5 h-9 px-3 shrink-0 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  {backupBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Back up now
                </button>
              </div>
              <input
                value={backupUrl}
                onChange={(e) => setBackupUrl(e.target.value)}
                onBlur={() => saveBackupSettings(backupUrl, backupEnabled)}
                placeholder="Paste a Google Sheet link (e.g. https://docs.google.com/spreadsheets/d/…)"
                className={inp}
              />
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer">
                  <input type="checkbox" checked={backupEnabled} onChange={(e) => saveBackupSettings(backupUrl, e.target.checked)} className="accent-[var(--accent)]" />
                  Automatically back up after each sync
                </label>
                {backupLast.at && (
                  <span className="text-[11px] text-muted">Last backed up {fmtShortDate(backupLast.at)}{backupLast.total ? ` · ${backupLast.total} transactions` : ""}</span>
                )}
              </div>
            </div>

            {plaidConnecting && (
              <div className="flex items-center gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <Loader2 size={15} className="animate-spin text-accent flex-shrink-0" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0">
                  Finish connecting your bank in the browser window that just opened, then come back here — it syncs
                  automatically.
                </p>
                <button
                  onClick={cancelConnect}
                  className="flex-shrink-0 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {plaidPreparing && !plaidConnecting && (
              <div className="flex items-center gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <Loader2 size={15} className="animate-spin text-accent flex-shrink-0" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0">
                  Plaid is preparing your transactions — this can take a minute. They'll appear here automatically, or
                  use Sync now to check again.
                </p>
              </div>
            )}

            {/* Is the pending→posted carry-forward actually armed? It relies on Plaid
                sending pending_transaction_id; if a sync imports rows and none carry
                it, the carry is inert for these banks. Bookings are still never
                destroyed either way — a retraction now keeps the row. */}
            {pendingRefSeen === "no" && (
              <div className="flex items-start gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <AlertTriangle size={15} className="text-warning-ink flex-shrink-0 mt-0.5" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0 leading-relaxed">
                  Your bank isn't telling us which pending transaction each posted one replaces, so bookings can't be
                  carried over automatically when something settles. Nothing gets deleted — you'll be told instead, and
                  can move the booking yourself.
                </p>
              </div>
            )}

            {/* R-019. Everything the last sync declined to load, in one place. The feed
                can't be made infallible — the bank decides what it sends — so the promise
                is only that nothing goes missing quietly. Nothing here is acted on
                automatically; the duplicate lists in particular are for review only. */}
            {syncSkips && (
              <div className="border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <div className="flex items-start gap-2.5 min-w-0">
                  <AlertTriangle size={15} className="text-warning-ink flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-ink">What the last sync didn't load</div>
                    <div className="mt-1.5 flex flex-col gap-1.5 text-[11.5px] text-ink-2 leading-relaxed">
                      {syncSkips.skipped_unsaved.length > 0 && (
                        <div>
                          <span className="text-ink">{syncSkips.skipped_unsaved.length} couldn't be saved.</span>{" "}
                          Your bank won't offer {syncSkips.skipped_unsaved.length === 1 ? "it" : "them"} again — re-pull all history to recover {syncSkips.skipped_unsaved.length === 1 ? "it" : "them"}.
                          <div className="mt-0.5 text-muted">{syncSkips.skipped_unsaved.join("; ")}</div>
                        </div>
                      )}
                      {syncSkips.skipped_no_id.length > 0 && (
                        <div>
                          <span className="text-ink">{syncSkips.skipped_no_id.length} arrived with no id</span>, so there was nothing to file {syncSkips.skipped_no_id.length === 1 ? "it" : "them"} under. Add by hand if {syncSkips.skipped_no_id.length === 1 ? "it belongs" : "they belong"} in the ledger.
                          <div className="mt-0.5 text-muted">{syncSkips.skipped_no_id.join("; ")}</div>
                        </div>
                      )}
                      {syncSkips.page_capped.length > 0 && (
                        <div>
                          <span className="text-ink">Stopped part-way through {syncSkips.page_capped.join(", ")}.</span>{" "}
                          The rest of the history is still waiting — sync again to continue.
                        </div>
                      )}
                      {syncSkips.amend_unknown > 0 && (
                        <div>
                          <span className="text-ink">Your bank changed {syncSkips.amend_unknown} transaction{syncSkips.amend_unknown === 1 ? "" : "s"} this ledger has never held.</span>{" "}
                          Re-pull all history to bring {syncSkips.amend_unknown === 1 ? "it" : "them"} in.
                        </div>
                      )}
                      {syncSkips.possible_duplicates.length > 0 && (
                        <div>
                          <span className="text-ink">{syncSkips.possible_duplicates.length} imported transaction{syncSkips.possible_duplicates.length === 1 ? "" : "s"} share a payment reference with one you already have.</span>{" "}
                          Nothing was removed — check whether {syncSkips.possible_duplicates.length === 1 ? "it is" : "they are"} the same money.
                          <div className="mt-0.5 flex flex-col text-muted">
                            {syncSkips.possible_duplicates.slice(0, 8).map((s, i) => (
                              <span key={i} className="truncate">{skipLine(s)}{s.reference ? ` · ${s.reference}` : ""}</span>
                            ))}
                            {syncSkips.possible_duplicates.length > 8 && <span>and {syncSkips.possible_duplicates.length - 8} more</span>}
                          </div>
                        </div>
                      )}
                      {syncSkips.skipped_duplicate.length > 0 && (
                        <div>
                          <span className="text-ink">{syncSkips.skipped_duplicate.length} skipped as {syncSkips.skipped_duplicate.length === 1 ? "a copy" : "copies"} of transactions already on the books.</span>{" "}
                          Usually a bank you reconnected re-sending its history.
                          <div className="mt-0.5 flex flex-col text-muted">
                            {syncSkips.skipped_duplicate.slice(0, 8).map((s, i) => (
                              <span key={i} className="truncate">{skipLine(s)}</span>
                            ))}
                            {syncSkips.skipped_duplicate.length > 8 && <span>and {syncSkips.skipped_duplicate.length - 8} more</span>}
                          </div>
                        </div>
                      )}
                      {syncSkips.already_held > 0 && (
                        <div className="text-muted">{syncSkips.already_held} were already in your ledger, unchanged.</div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setSyncSkips(null)}
                    className="flex-shrink-0 h-7 px-2 border border-line text-muted hover:bg-surface-2 rounded-md text-[11px] transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {plaidItems.length > 0 && (
              <div className="border border-line-2 rounded-lg divide-y divide-line-2 overflow-hidden">
                {plaidItems.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 px-3 py-2 min-w-0">
                    <Landmark size={14} className="text-muted flex-shrink-0" strokeWidth={1.8} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-ink truncate">{it.institution}</div>
                      <div className="text-[11px] text-muted tabular-nums">
                        {it.account_count} account{it.account_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      onClick={() => disconnectBank(it)}
                      className="flex-shrink-0 h-8 px-2.5 rounded-md text-[12px] text-muted hover:text-danger-ink hover:bg-danger-bg transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
      )}

      {/* Import preview / confirm card */}
      {tab === "setup" && preview && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] text-ink">
              Detected <span className="font-semibold">{preview.format.toUpperCase()}</span> ·{" "}
              <span className="tabular-nums font-semibold">{preview.total}</span> transaction{preview.total !== 1 ? "s" : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doImport}
                disabled={importing}
                className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {importing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Import
              </button>
              <button
                onClick={() => { setPreview(null); setPreviewPath(null); }}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          {!preview.has_fitid && (
            <p className="text-[11px] text-muted leading-relaxed">
              This format has no transaction id — duplicates are caught by a fingerprint, so re-importing is safe but
              near-identical same-day rows could collide.
            </p>
          )}

          <div className="border border-line-2 rounded-lg overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-muted border-b border-line-2">
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                  <th className="font-medium px-3 py-2">Description</th>
                  <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {preview.sample.slice(0, 6).map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 tabular-nums text-muted whitespace-nowrap">{(r.posted_at || "").slice(0, 10)}</td>
                    <td className="px-3 py-2 text-ink-2 max-w-0 truncate"><span className="truncate block">{r.description}</span></td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${r.direction === "in" ? "text-success-ink" : "text-ink"}`}>
                      {fmtAmount(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AI import preview / confirm card */}
      {tab === "setup" && aiPreview && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] text-ink">
              Extracted <span className="tabular-nums font-semibold">{aiPreview.total}</span> transaction{aiPreview.total !== 1 ? "s" : ""}
              {aiPreview.ending_balance != null && (
                <span className="text-muted">
                  {" "}· statement ending balance{" "}
                  <span className="tabular-nums font-semibold text-ink-2">{fmtAmount(aiPreview.ending_balance)}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doImportAi}
                disabled={aiImporting}
                className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {aiImporting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Import
              </button>
              <button
                onClick={() => { setAiPreview(null); setAiPreviewPath(null); }}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="border border-line-2 rounded-lg overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-muted border-b border-line-2">
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                  <th className="font-medium px-3 py-2">Description</th>
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Category</th>
                  <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {aiPreview.sample.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 tabular-nums text-muted whitespace-nowrap">{(r.date || "").slice(0, 10)}</td>
                    <td className="px-3 py-2 text-ink-2 max-w-0 truncate"><span className="truncate block">{r.description}</span></td>
                    <td className="px-3 py-2 text-muted whitespace-nowrap">{r.category || "—"}</td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${r.direction === "in" ? "text-success-ink" : "text-ink"}`}>
                      {r.direction === "in" ? "+" : "-"}{fmtAmount(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Summary — a quiet figures strip, not stat cards */}
      {tab === "ledger" && txns.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] border-b border-line pb-3">
          <span className="text-muted">Transactions <span className="text-ink font-medium tabular-nums">{rangeSummary.total}</span></span>
          <span className="text-muted">Reviewed <span className="text-ink font-medium tabular-nums">{rangeSummary.reviewed}/{rangeSummary.total}</span></span>
          <span className="text-muted">Money in <span className="text-success-ink font-medium tabular-nums">{fmtAmount(rangeSummary.sumIn)}</span></span>
          <span className="text-muted">Money out <span className="text-danger-ink font-medium tabular-nums">{fmtAmount(rangeSummary.sumOut)}</span></span>
          <span className="text-muted">Uncategorized <span className={`font-medium tabular-nums ${rangeSummary.unclassified > 0 ? "text-ink" : "text-muted"}`}>{rangeSummary.unclassified}</span></span>
          <span className="text-muted">Needs a deal <span className={`font-medium tabular-nums ${rangeSummary.needsDeal > 0 ? "text-ink" : "text-muted"}`}>{rangeSummary.needsDeal}</span></span>
          {rangeSummary.shippingOut > 0 && (
            <button
              onClick={() => { setTab("ledger"); setCatFilter("shipping"); }}
              title="Every transaction categorised as shipping and freight"
              className="text-muted hover:text-ink-2 transition-colors"
            >
              Shipping <span className="text-ink font-medium tabular-nums">{fmtAmount(rangeSummary.shippingOut)}</span>
            </button>
          )}
        </div>
      )}

      {/* Ledger toolbar — scope (left) + search & filters (right) */}
      {tab === "ledger" && (
      <div className="border-t border-b border-line flex items-center gap-x-5 gap-y-2 py-2.5 flex-wrap">
        <div className="flex items-center gap-5">
          {([["all", "All"], ["todo", "To book"], ["booked", "Booked"]] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setQueue(v)}
              className={`text-[13px] transition-colors ${queue === v ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
            >
              {label}
              <span className="ml-1.5 font-normal text-muted tabular-nums">
                {v === "all" ? rangeSummary.total : v === "todo" ? rangeSummary.total - rangeSummary.reviewed : rangeSummary.reviewed}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-x-4 gap-y-2 flex-wrap">
          {!splitView && (
            <div className="flex items-center gap-1.5 min-w-[190px] bg-surface-2 border border-line rounded-lg px-2.5 h-8">
              <Search size={13} className="text-muted flex-shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search payee, memo, exact amount…"
                className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
          )}
          {!splitView && (
            <div className="flex items-center gap-3">
              {(["all", "in", "out"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setDirFilter(f)}
                  className={`text-[12px] transition-colors ${dirFilter === f ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
                >
                  {f === "all" ? "All" : f === "in" ? "In" : "Out"}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setSplitView((v) => !v)}
            title="Show money in and money out side by side, each with its own search — for reconciling a refund."
            className={`text-[12px] transition-colors ${splitView ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
          >
            {splitView ? "Combined" : "Split in/out"}
          </button>
          {accounts.length > 0 && (
            <select
              value={acctFilter}
              onChange={(e) => setAcctFilter(e.target.value)}
              className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          )}
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All categories</option>
            <CategoryOptions />
          </select>
          {/* Payment method (R-157). The counts live in the option labels so the
              size of the pile the classifier could not read is on screen before
              anything is hidden — not only after. */}
          <select
            value={methodFilter}
            onChange={(e) => setMethodFilter(e.target.value as any)}
            aria-label="Payment method"
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All methods</option>
            {METHODS.filter((m) => (methodCounts.total[m.value] || 0) > 0 || methodFilter === m.value).map((m) => (
              <option key={m.value} value={m.value}>{m.label} · {methodCounts.total[m.value] || 0}</option>
            ))}
            <option value="unclassified">No method read · {methodCounts.unclassified}</option>
          </select>
          {/* The person facet (W2-f) — and where a profile's "See all in
              Financials" lands. */}
          <select
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
            aria-label="Person"
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 max-w-[180px]"
          >
            <option value="all">Anyone</option>
            <option value="linked">Linked to someone · {peopleInLedger.linked}</option>
            <option value="none">Not linked · {peopleInLedger.unlinked}</option>
            {peopleInLedger.rows.length > 0 && (
              <optgroup label="Tagged to">
                {peopleInLedger.rows.map(({ person, n }) => (
                  <option key={personKey(person)} value={personKey(person)}>
                    {person.name} · {n}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All statuses</option>
            <option value="unclassified">Uncategorized</option>
            <option value="unallocated_in">Needs a deal (in)</option>
            <option value="unallocated_out">Needs a deal (out)</option>
          </select>
          {/* Tax year first — the books are read one tax year at a time (R-145).
              The date inputs stay for odd ranges; touching them flips this to Custom. */}
          <select
            value={taxYearValue}
            onChange={(e) => pickTaxYear(e.target.value)}
            aria-label="Tax year"
            className="bg-surface-2 border border-line text-[12px] font-medium text-ink hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            {taxYears.map((y) => (
              <option key={y} value={String(y)}>Tax year {y}</option>
            ))}
            <option value="all">All years</option>
            {taxYearValue === "custom" && <option value="custom">Custom range</option>}
          </select>
          <div className="flex items-center gap-1.5 text-[12px] text-muted bg-surface-2 border border-line rounded-lg px-2.5 h-8">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-transparent text-[12px] text-muted rounded focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:light] dark:[color-scheme:dark]"
            />
            <span>to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-transparent text-[12px] text-muted rounded focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>
        </div>
      </div>
      )}

      {/* W2-b — what this filter is not showing, in words. Saying that plainly is
          the whole point: a heuristic filter that quietly drops what it could not
          read is a filter that lies.
          The second figure is worded "inferred" rather than "read off the memo"
          because it covers three different guesses — a memo match, the statement
          importer's stored `rail`, and a method inherited from the payee — and a
          caption has to be true for every row it counts. */}
      {tab === "ledger" && methodFilter !== "all" && (
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-muted border-b border-line pb-2.5">
          {methodFilter === "unclassified" ? (
            <span>
              <span className="text-ink font-medium tabular-nums">{methodCounts.unclassified}</span>{" "}
              transactions with no payment method the memo could name. Set one on any row and it sticks.
            </span>
          ) : (
            <>
              <span>
                Showing <span className="text-ink font-medium tabular-nums">{methodCounts.total[methodFilter] || 0}</span>{" "}
                {methodLabel(methodFilter).toLowerCase()} —{" "}
                <span className="tabular-nums">{methodCounts.confirmed[methodFilter] || 0}</span> you confirmed,{" "}
                <span className="tabular-nums">{(methodCounts.total[methodFilter] || 0) - (methodCounts.confirmed[methodFilter] || 0)}</span> inferred, not confirmed.
              </span>
              <span>
                <span className="text-ink font-medium tabular-nums">{methodCounts.unclassified}</span> could not be read and are not in this list.
              </span>
              <button
                onClick={() => setMethodFilter("unclassified")}
                className="font-medium text-accent hover:text-accent-hover transition-colors"
              >
                Show them
              </button>
            </>
          )}
        </div>
      )}

      {/* What the picked category comes to (R-174). Modelled on the method strip
          above: a facet that filters without saying what it filtered to leaves the
          reader counting rows by hand. */}
      {tab === "ledger" && catSummary && catSummary.total > 0 && (
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-muted border-b border-line pb-2.5">
          <span className="text-ink font-medium">{catLabel(catFilter)}</span>
          {catSummary.outN > 0 && (
            <span>
              <span className="tabular-nums">{catSummary.outN}</span> out{" "}
              <span className="text-danger-ink font-medium tabular-nums">{fmtAmount(catSummary.outSum)}</span>
            </span>
          )}
          {catSummary.inN > 0 && (
            <span>
              · <span className="tabular-nums">{catSummary.inN}</span> in{" "}
              <span className="text-success-ink font-medium tabular-nums">{fmtAmount(catSummary.inSum)}</span>
            </span>
          )}
          <span>
            · <span className="tabular-nums">{catSummary.tied}</span> of{" "}
            <span className="tabular-nums">{catSummary.total}</span> tied to a deal
          </span>
        </div>
      )}

      {/* Smart grouping suggestions — clear look-alike backlogs in one click */}
      {tab === "tobook" && suggestedGroups.length > 0 && (
        <div className="space-y-1">
          {/* Show a rolling few so the suggestions never bury the transaction list;
              clearing one surfaces the next. */}
          {suggestedGroups.slice(0, 3).map((g) => {
            const cat = groupCatOverride[g.key] ?? g.defaultCat;
            return (
              <div key={g.key} className="flex items-center gap-3 flex-wrap border border-line-2 rounded-lg px-2.5 py-1.5 text-[12px]">
                <span className="text-ink-2 min-w-0">
                  <span className="font-semibold text-ink tabular-nums">{g.count}</span> transactions from{" "}
                  <span className="font-semibold text-ink">{g.payee}</span>{" "}
                  <span className={g.direction === "in" ? "text-success-ink" : "text-danger-ink"}>
                    ({g.direction === "in" ? "money in" : "money out"})
                  </span>
                </span>
                <div className="ml-auto flex items-center gap-2.5">
                  <select
                    value={cat}
                    onChange={(e) => setGroupCatOverride((prev) => ({ ...prev, [g.key]: e.target.value }))}
                    className="h-7 px-2 rounded-md text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
                  >
                    <option value="">Set category…</option>
                    <CategoryOptions includeUncat={false} />
                  </select>
                  <button
                    onClick={async () => {
                      const c = groupCatOverride[g.key] ?? g.defaultCat;
                      if (!c) return;
                      // Only dismiss on success — otherwise a failed rule left the
                      // rows untagged AND hid the group so they couldn't be found.
                      if (await createRule(g.payee, c, "expense", "", g.direction)) dismissGroup(g.key);
                    }}
                    disabled={!cat}
                    className="text-[12px] font-medium text-accent hover:text-accent-hover disabled:text-faint disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    Tag all <span className="tabular-nums">{g.count}</span>
                  </button>
                  <button
                    onClick={() => dismissGroup(g.key)}
                    title="Dismiss"
                    className="text-muted hover:text-ink-2 transition-colors flex-shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk bar — a plain full-width row of text actions once rows are selected */}
      {(tab === "tobook" || tab === "ledger") && selected.size > 0 && (
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap border-b border-line py-2.5 text-[12.5px]">
          <span className="font-semibold text-ink whitespace-nowrap tabular-nums">{selected.size} selected</span>
          {bulkProgress && (
            <span className="flex items-center gap-1.5 text-muted">
              <Loader2 size={12} className="animate-spin" /> {bulkProgress}
            </span>
          )}
          <span className="text-faint">·</span>
          <div className="flex items-center gap-2">
            <select
              value={bulkCat}
              onChange={(e) => setBulkCat(e.target.value)}
              disabled={bulkActionBusy}
              className="h-8 px-2 rounded-md text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            >
              <option value="">Set category…</option>
              <CategoryOptions includeUncat={false} />
            </select>
            <button
              onClick={() => bulkCat && bulkSetCategory(bulkCat)}
              disabled={bulkActionBusy || !bulkCat}
              className="text-ink-2 hover:text-ink disabled:text-faint disabled:cursor-not-allowed transition-colors"
            >
              Apply
            </button>
          </div>
          <span className="text-faint">·</span>
          <button
            onClick={() => setBulkAllocOpen(true)}
            disabled={bulkActionBusy}
            className="text-ink-2 hover:text-ink disabled:opacity-50 transition-colors"
          >
            Tag all to a deal
          </button>
          <span className="text-faint">·</span>
          <button
            onClick={() => bulkSetReviewed(true)}
            disabled={bulkActionBusy}
            className="font-medium text-accent hover:text-accent-hover disabled:opacity-50 transition-colors"
          >
            Book
          </button>
          <button
            onClick={() => bulkSetReviewed(false)}
            disabled={bulkActionBusy}
            className="text-ink-2 hover:text-ink disabled:opacity-50 transition-colors"
          >
            Reopen
          </button>
          <span className="text-faint">·</span>
          <button
            onClick={bulkDelete}
            disabled={bulkActionBusy}
            title="Delete the selected transactions (booked ones are kept)"
            className="text-danger-ink hover:opacity-80 disabled:opacity-50 transition-opacity"
          >
            Delete
          </button>
          <button
            onClick={clearSelection}
            disabled={bulkActionBusy}
            className="ml-auto text-muted hover:text-ink-2 disabled:opacity-50 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* To book — the queue, grouped by day. Card rows: the left rail carries
          allocation state, the subline says what the row needs, and the obvious
          match is one click. */}
      {tab === "tobook" && (
        loading ? skeletonRows
        : loadError ? errorState
        : txns.length === 0 ? firstRunState
        : toBookRows.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
              <Check size={18} className="text-success-ink" />
            </div>
            <p className="text-[14px] font-semibold text-ink-2">
              {toBookSearch.trim() || toBookAcct !== "all" ? "Nothing here matches" : "You're all caught up"}
            </p>
            <p className="text-[12px] text-muted mt-1">
              {toBookSearch.trim() || toBookAcct !== "all"
                ? "No unbooked transactions match this search"
                : monthBooked.n > 0
                  ? `${fmtAmount(monthBooked.amt)} tied to deals this month across ${monthBooked.n} transaction${monthBooked.n === 1 ? "" : "s"}`
                  : "Every transaction is booked"}
            </p>
            {(toBookSearch.trim() !== "" || toBookAcct !== "all") && (
              <button
                onClick={() => { setToBookSearch(""); setToBookAcct("all"); }}
                className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {toBookGroups.map((g) => (
              <div key={g.date} className="bg-surface border border-line rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-surface-2/60 border-b border-line text-[11.5px] font-semibold text-ink-2">
                  {dayHeading(g.date)}
                </div>
                <div className="divide-y divide-line-2">
                  {g.rows.map((t) => {
                    const payee = t.counterparty_name?.trim();
                    const mainLabel = payee || t.description || "—";
                    const memo = payee ? t.description : "";
                    const cm = openId === t.id ? null : confidentMatches.get(t.id) ?? null;
                    const isLoan = t.counterparty_type === "loan";
                    return (
                      <div
                        key={t.id}
                        data-txn-id={t.id}
                        onClick={() => toggleRow(t)}
                        className={`${railClass(t)} pl-3 pr-3 py-3 cursor-pointer transition-colors ${
                          selected.has(t.id) || openId === t.id ? "bg-surface-2" : "hover:bg-surface-2"
                        }`}
                      >
                        {/* One booking row: everything needed to book lives HERE — the
                            category select, the deal action and a labeled Book button.
                            The drawer (row click) is for detail, never a requirement. */}
                        <div className="flex items-center gap-3 min-w-0 flex-wrap lg:flex-nowrap">
                          <input
                            type="checkbox"
                            aria-label="Select transaction"
                            checked={selected.has(t.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(t.id)}
                            className="align-middle accent-accent flex-shrink-0"
                          />
                          {t.direction === "in"
                            ? <ArrowDownLeft size={15} className="text-success-ink flex-shrink-0" strokeWidth={2} />
                            : <ArrowUpRight size={15} className="text-danger-ink flex-shrink-0" strokeWidth={2} />}
                          <div className="min-w-0 flex-1 basis-full lg:basis-auto order-1 lg:order-none">
                            <div className="text-[13px] font-semibold text-ink truncate" title={mainLabel}>{mainLabel}</div>
                            <div className="text-[11.5px] text-muted truncate">
                              {needsLine(t)}
                              {memo ? <span className="text-faint"> · {memo}</span> : null}
                            </div>
                            {(() => {
                              // Booking memory: this payee's own history, one tap to apply.
                              const sg = suggestionFor(t);
                              return sg ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); saveReview(t, { category: sg.cat }); }}
                                  title={`Booked as ${catLabel(sg.cat)} ${sg.count} time${sg.count === 1 ? "" : "s"} before — click to apply`}
                                  className="mt-1 inline-flex items-center gap-1 h-6 px-2 rounded-md border border-accent/40 bg-accent/5 text-accent text-[11.5px] font-medium hover:bg-accent/10 transition-colors max-w-full"
                                >
                                  <Wand2 size={10} className="flex-shrink-0" />
                                  <span className="truncate">Usually {catLabel(sg.cat)}</span>
                                </button>
                              ) : null;
                            })()}
                          </div>
                          <div
                            className={`text-[13.5px] tabular-nums whitespace-nowrap font-semibold flex-shrink-0 lg:order-none ${
                              t.direction === "in" ? "text-success-ink" : "text-danger-ink"
                            }`}
                          >
                            {t.direction === "in" ? "+" : "−"}{fmtAmount(t.amount)}
                          </div>
                          {/* Category — a real, visible control on the row itself. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            {isLoan ? (
                              <span className="inline-flex items-center h-8 px-2.5 rounded-lg bg-surface-2 border border-line text-[12px] text-ink-2 whitespace-nowrap">
                                {loanTagLabel(t.direction)}
                              </span>
                            ) : (
                              <span className="relative inline-flex items-center">
                                <select
                                  value={t.category || ""}
                                  aria-label="Category"
                                  onChange={(e) => saveReview(t, { category: e.target.value })}
                                  className={`appearance-none h-8 pl-2.5 pr-7 rounded-lg border text-[12px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors ${
                                    t.category
                                      ? "bg-surface border-line text-ink-2 hover:border-line-3"
                                      : "bg-accent/5 border-accent/40 text-accent font-semibold hover:bg-accent/10"
                                  }`}
                                >
                                  <option value="">Set category</option>
                                  <CategoryOptions includeUncat={false} />
                                </select>
                                <ChevronDown
                                  size={12}
                                  className={`pointer-events-none absolute right-2 ${t.category ? "text-faint" : "text-accent"}`}
                                />
                              </span>
                            )}
                          </span>
                          {/* Deal — tie the obvious match in one click, or open the picker. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            {isLoan ? null : t.allocated > 0.0001 && t.unallocated <= 0.0001 ? (
                              <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-success-bg/60 border border-success/40 text-[12px] text-success-ink whitespace-nowrap">
                                <Link2 size={11} /> Linked
                              </span>
                            ) : cm ? (
                              <button
                                onClick={() => tieMatch(t, cm.deal, cm.candidate)}
                                disabled={tyingId === t.id}
                                title={`Tie to ${dealLabel(cm.deal)} as ${cm.candidate?.role === "supplier_payment" ? "a supplier payment" : cm.candidate?.role === "buyer_payment" ? "a buyer payment" : t.direction === "out" ? "a supplier payment" : "a buyer payment"} — ${cm.reason}`}
                                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-accent/40 bg-accent/5 text-accent text-[12px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors whitespace-nowrap max-w-[220px]"
                              >
                                {tyingId === t.id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                                <span className="truncate">
                                  Tie to {matchLabel(cm.deal)}
                                  {cm.candidate?.supplier_name ? ` · ${cm.candidate.supplier_name}` : ""}
                                </span>
                              </button>
                            ) : (
                              <button
                                onClick={() => toggleRow(t)}
                                title="Pick a deal to tie this payment to"
                                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line text-[12px] text-ink-2 font-medium hover:bg-surface-2 hover:border-line-3 transition-colors whitespace-nowrap"
                              >
                                <Link2 size={11} /> {t.allocated > 0.0001 ? `${fmtAmount(t.allocated)} tied` : "Link deal"}
                              </button>
                            )}
                          </span>
                          {/* Book — labeled, always visible, never hover-only. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => saveReview(t, { reviewed: true })}
                              title="Mark this transaction booked"
                              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-semibold transition-colors whitespace-nowrap"
                            >
                              <Check size={12} strokeWidth={2.4} /> Book
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Ledger — the full history */}
      {tab === "ledger" && (
        loading ? skeletonRows
        : loadError ? errorState
        : txns.length === 0 ? firstRunState
        : splitView ? (
        // Money in and money out, side by side, each with its own search — pin the
        // received side and the sent side at once to reconcile a refund.
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-semibold text-success-ink whitespace-nowrap">
                Money in <span className="text-muted font-normal tabular-nums">{filteredIn.length}</span>
              </span>
              <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-2.5 h-8">
                <Search size={13} className="text-muted flex-shrink-0" />
                <input value={searchIn} onChange={(e) => setSearchIn(e.target.value)} placeholder="Search received…"
                  className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none" />
              </div>
            </div>
            {renderTxnTable(filteredIn)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-semibold text-danger-ink whitespace-nowrap">
                Money out <span className="text-muted font-normal tabular-nums">{filteredOut.length}</span>
              </span>
              <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-2.5 h-8">
                <Search size={13} className="text-muted flex-shrink-0" />
                <input value={searchOut} onChange={(e) => setSearchOut(e.target.value)} placeholder="Search sent…"
                  className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none" />
              </div>
            </div>
            {renderTxnTable(filteredOut)}
          </div>
        </div>
      ) : (
        renderTxnTable(filtered)
      )
      )}

      {bulkAllocOpen && (
        <BulkAllocateModal
          deals={deals}
          loans={loans}
          count={selected.size}
          busy={bulkActionBusy}
          onClose={() => setBulkAllocOpen(false)}
          onPickDeal={async (d) => { setBulkAllocOpen(false); await bulkAllocate(d); }}
          onPickLoan={async (l) => { setBulkAllocOpen(false); await bulkTagLoan(l); }}
        />
      )}

      {/* W1-a — one picker, two entry points (the ledger row and the booking
          sheet), so "whose money is this" is answered the same way from both. */}
      {personPickerFor && (() => {
        const t = txns.find((x) => x.id === personPickerFor);
        if (!t) return null;
        return (
          <PersonPickerModal
            txn={t}
            people={people}
            candidates={personSugg.get(t.id) ?? []}
            current={personOf(t)}
            busy={personBusy === t.id}
            onClose={() => setPersonPickerFor(null)}
            onPick={(p) => tagPerson(t, p)}
          />
        );
      })()}

      {/* Auto-tag rules — managed from Setup, next to the tools that act on them */}
      {tab === "setup" && (
        <RulesCard
          rules={rules}
          open={rulesOpen}
          setOpen={setRulesOpen}
          onApply={applyRules}
          onDelete={deleteRule}
          onToggleAuto={toggleRuleAuto}
          onCreate={(cp, cat, dir) => createRule(cp, cat, "expense", "", dir)}
        />
      )}
      </div>
      )}

      {/* Booking sheet — the allocation panel out of the table. One transaction,
          full height, Escape or the overlay closes it, and it can no longer be
          scrolled away from its own row. */}
      {openTxn && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          onClick={() => setOpenId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Book transaction"
            tabIndex={-1}
            ref={sheetRef}
            className="h-full w-full max-w-[560px] bg-surface border-l border-line shadow-2xl overflow-y-auto p-5 space-y-4 focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {payeeEditId === openTxn.id ? (
                  <input
                    autoFocus
                    value={payeeDraft}
                    aria-label="Payee name"
                    onChange={(e) => setPayeeDraft(e.target.value)}
                    onBlur={(e) => commitPayeeEdit(openTxn, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); payeeCancelRef.current = true; e.currentTarget.blur(); }
                    }}
                    className="w-full min-w-0 bg-surface border border-line rounded px-1.5 py-0.5 text-[16px] font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[16px] font-semibold text-ink truncate">
                      {openTxn.counterparty_name?.trim() || openTxn.description || "Transaction"}
                    </span>
                    <button
                      onClick={() => {
                        setPayeeDraft(openTxn.counterparty_name?.trim() || openTxn.description || "");
                        setPayeeEditId(openTxn.id);
                      }}
                      title="Rename payee"
                      aria-label="Rename payee"
                      className="text-faint hover:text-ink-2 flex-shrink-0 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
                <div className="text-[12px] text-muted mt-0.5 truncate">
                  {(openTxn.posted_at || "").slice(0, 10)}
                  {fmtTime(openTxn.posted_dt) ? ` · ${fmtTime(openTxn.posted_dt)}` : ""}
                  {openTxn.counterparty_name?.trim() && openTxn.description ? ` · ${openTxn.description}` : ""}
                </div>
              </div>
              <button
                onClick={() => setOpenId(null)}
                aria-label="Close"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 flex-shrink-0 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className={`text-[20px] font-semibold tabular-nums ${openTxn.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
                {openTxn.direction === "in" ? "+" : "−"}{fmtAmount(openTxn.amount)}
              </div>
              <button
                onClick={() => saveReview(openTxn, { reviewed: !openTxn.reviewed })}
                className={`flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium transition-colors ${
                  openTxn.reviewed
                    ? "border border-line text-ink-2 hover:bg-surface-2"
                    : "bg-accent hover:bg-accent-hover text-on-accent"
                }`}
              >
                <Check size={14} /> {openTxn.reviewed ? "Booked — reopen" : "Book it"}
              </button>
            </div>

            {/* W1-a — the person, as its own field, with no deal involved. This is
                the thing Jack went looking for and could not find: `counterparty_type`
                was empty on all 1,342 transactions because the only way to set it was
                as a side effect of tying money to a deal. Identity, never accounting —
                nothing written here changes profit, cost or Free Cash. */}
            {openTxn.counterparty_type !== "loan" && (() => {
              const linked = personOf(openTxn);
              const psug = personSuggestionFor(openTxn);
              return (
                <div className="border border-line rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-ink-2">Person</span>
                    {linked && (
                      <button
                        onClick={() => untagPerson(openTxn)}
                        disabled={personBusy === openTxn.id}
                        className="text-[12px] text-muted hover:text-ink-2 disabled:opacity-50 transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {linked ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-ink min-w-0 truncate">{linked.name}</span>
                      <span className="text-[11px] text-muted">{personTypeLabel(linked.type)}</span>
                      <button
                        onClick={() => setPersonPickerFor(openTxn.id)}
                        className="ml-auto text-[12px] font-medium text-accent hover:text-accent-hover transition-colors"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {psug && (
                        <button
                          onClick={() => tagPerson(openTxn, { type: psug.type, id: psug.id, name: psug.name })}
                          disabled={personBusy === openTxn.id}
                          className="w-full flex items-center gap-2 h-9 px-3 rounded-lg border border-accent/40 bg-accent/5 text-accent text-[13px] font-medium hover:bg-accent/10 disabled:opacity-50 transition-colors text-left"
                        >
                          {personBusy === openTxn.id
                            ? <Loader2 size={13} className="animate-spin flex-shrink-0" />
                            : <Plus size={13} className="flex-shrink-0" />}
                          <span className="truncate">{psug.name}</span>
                          <span className="ml-auto text-[11px] font-normal text-muted truncate">{psug.reason}</span>
                        </button>
                      )}
                      <button
                        onClick={() => setPersonPickerFor(openTxn.id)}
                        className="text-[12px] font-medium text-accent hover:text-accent-hover transition-colors"
                      >
                        {psug ? "Choose someone else" : "Choose a person"}
                      </button>
                      {linkOfferFor === openTxn.id && (
                        <p className="text-[11.5px] text-muted">
                          Renaming the payee changed the label on this transaction only — it does not
                          put the payment on anyone's profile. Linking a person does.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* W2-a/c/e — the payment method, and the wire detail behind it. */}
            {(() => {
              const mr = methodOf(openTxn);
              const detail = wireDetail(openTxn);
              return (
                <div className="border border-line rounded-xl p-3 space-y-2">
                  <label className="block">
                    <span className="block text-[12px] font-medium text-ink-2 mb-1">Payment method</span>
                    <select
                      value={openTxn.confirmed_method || ""}
                      onChange={(e) => setMethod(openTxn, e.target.value as BankMethod | "")}
                      className={`${inp} text-ink-2`}
                    >
                      <option value="">
                        {mr.state === "likely" ? `${methodLabel(mr.method)} — likely, not confirmed` : "Not set"}
                      </option>
                      {METHODS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                  <p className="text-[11.5px] text-muted">
                    {mr.state === "certain"
                      ? `${methodLabel(mr.method)} — ${mr.reason}.`
                      : mr.state === "likely"
                        ? `Reads like ${methodLabel(mr.method).toLowerCase()}: ${mr.reason}. Your bank sends no payment method, so this is a guess until you set it.`
                        : "Your bank sends no payment method and the memo doesn't name one. Set it here and it sticks."}
                  </p>
                  {methodOffer?.txnId === openTxn.id && (
                    <button
                      onClick={applyMethodToPayee}
                      disabled={methodBusy}
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-accent/40 bg-accent/5 text-accent text-[12px] font-medium hover:bg-accent/10 disabled:opacity-50 transition-colors max-w-full"
                    >
                      {methodBusy ? <Loader2 size={11} className="animate-spin flex-shrink-0" /> : <Wand2 size={11} className="flex-shrink-0" />}
                      <span className="truncate">
                        Set the other {methodOffer.ids.length} from {methodOffer.payee} to {methodLabel(methodOffer.method).toLowerCase()}
                      </span>
                    </button>
                  )}
                  {detail.length > 0 && (
                    <dl className="pt-1 border-t border-line-2 space-y-1">
                      {detail.map((d) => (
                        <div key={d.label} className="flex gap-2 text-[11.5px] min-w-0">
                          <dt className="text-muted w-[86px] flex-shrink-0">{d.label}</dt>
                          <dd className="text-ink-2 min-w-0 break-words">{d.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })()}

            {openTxn.counterparty_type !== "loan" && (
              <label className="block">
                <span className="block text-[12px] font-medium text-ink-2 mb-1">Category</span>
                <select
                  value={openTxn.category || ""}
                  onChange={(e) => saveReview(openTxn, { category: e.target.value })}
                  className={`${inp} text-ink-2`}
                >
                  <CategoryOptions />
                </select>
                {CAT_HINTS[openTxn.category || ""] && (
                  <span className="mt-1 block text-[11px] text-muted leading-snug">
                    {CAT_HINTS[openTxn.category || ""]}
                  </span>
                )}
                {(() => {
                  // Booking memory: what this payee's own booked history says.
                  const sg = suggestionFor(openTxn);
                  return sg ? (
                    <button
                      onClick={(e) => { e.preventDefault(); saveReview(openTxn, { category: sg.cat }); }}
                      className="mt-1.5 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-accent/40 bg-accent/5 text-accent text-[12px] font-medium hover:bg-accent/10 transition-colors max-w-full"
                    >
                      <Wand2 size={11} className="flex-shrink-0" />
                      <span className="truncate">
                        Usually {catLabel(sg.cat)} — booked that way {sg.count} time{sg.count === 1 ? "" : "s"}
                      </span>
                    </button>
                  ) : null;
                })()}
              </label>
            )}

            <AllocationPanel
              txn={openTxn}
              allocs={allocs}
              loading={allocLoading}
              targetType={targetType}
              setTargetType={setTargetType}
              filteredDeals={filteredDeals}
              dealQuery={dealQuery}
              setDealQuery={(v) => { setDealQuery(v); setSelectedDeal(null); setDealListOpen(true); }}
              dealListOpen={dealListOpen}
              setDealListOpen={setDealListOpen}
              selectedDeal={selectedDeal}
              onPickDeal={(d) => { setSelectedDeal(d); setDealQuery(dealLabel(d)); setDealListOpen(false); }}
              filteredLoans={filteredLoans}
              loanQuery={loanQuery}
              setLoanQuery={(v) => { setLoanQuery(v); setSelectedLoan(null); setLoanListOpen(true); }}
              loanListOpen={loanListOpen}
              setLoanListOpen={setLoanListOpen}
              selectedLoan={selectedLoan}
              onPickLoan={(l) => { setSelectedLoan(l); setLoanQuery(loanLabel(l)); setLoanListOpen(false); }}
              amountStr={amountStr}
              setAmountStr={setAmountStr}
              role={role}
              setRole={setRole}
              note={note}
              setNote={setNote}
              allowSplit={allowSplit}
              setAllowSplit={setAllowSplit}
              busy={allocBusy}
              onSubmit={submitAlloc}
              onRemove={removeAlloc}
              onUntagLoan={untagLoan}
              onCreateRule={createRule}
              newDealBusy={newDealBusy}
              onCreateDeal={createDealFromTxn}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Name the person a payment is from or to — with no deal in sight (R-156/W1-a).
//
// The server's candidates sit on top with the reason each was nominated, one tap
// to confirm; everyone else is one search away. NOTHING is ever auto-applied —
// R-150's locked decision, and a wrong auto-tag on the wrong buyer is a data error
// that looks like a fact.
//
// This writes counterparty_type / counterparty_id, which is IDENTITY. It says who
// the money is from or to; the allocation says what it paid for. No total on any
// screen may move because of it.
// Pick one deal or loan, then tag every selected transaction to it. For deals the
// remaining amount is allocated (role auto-picked by direction); for loans the whole
// txn is tagged (received/repayment derived by direction).
function BulkAllocateModal({
  deals, loans, count, busy, onClose, onPickDeal, onPickLoan,
}: {
  deals: DealFlow[];
  loans: Loan[];
  count: number;
  busy: boolean;
  onClose: () => void;
  onPickDeal: (d: DealFlow) => void;
  onPickLoan: (l: Loan) => void;
}) {
  const [mode, setMode] = useState<"deal" | "loan">("deal");
  const [q, setQ] = useState("");
  const dealList = useMemo(() => {
    const s = q.toLowerCase();
    // Same survivor dedup as the single-row picker — a bulk tag must never land on
    // a ghost duplicate the deal view hides.
    return survivorDeals(deals)
      .filter((d) => `${d.client_name || ""} ${d.name || ""} ${d.invoice_number || ""}`.toLowerCase().includes(s))
      .sort((a, b) =>
        (Date.parse(b.completed_at || b.created_at || "") || 0) - (Date.parse(a.completed_at || a.created_at || "") || 0))
      .slice(0, 40);
  }, [deals, q]);
  const loanList = useMemo(() => {
    const s = q.toLowerCase();
    return loans.filter((l) => `${l.name || ""} ${l.lender || ""}`.toLowerCase().includes(s)).slice(0, 30);
  }, [loans, q]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">
              {mode === "deal" ? `Tag ${count} to a deal` : `Tag ${count} to a loan`}
            </h2>
            <p className="text-[12px] text-muted mt-0.5">
              {mode === "deal"
                ? "Each remaining amount is tied to the deal you pick — receipts as buyer payments, payments as supplier payments."
                : "Each transaction is tagged to the loan you pick — money in as loan received, money out as repayment."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-line space-y-3">
          <div className="flex gap-1">
            {([["deal", "Deal"], ["loan", "Loan"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => { setMode(v); setQ(""); }}
                className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
                  mode === v ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "deal" ? "Search a deal…" : "Search a loan…"}
            className={inp}
          />
        </div>
        <div className="overflow-y-auto divide-y divide-line-2">
          {mode === "deal" ? (
            dealList.length === 0 ? (
              <div className="text-center py-10 text-[12px] text-muted">No deals match</div>
            ) : (
              dealList.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onPickDeal(d)}
                  disabled={busy}
                  className="w-full text-left px-5 py-2.5 hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  <DealRowContent d={d} />
                </button>
              ))
            )
          ) : loanList.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-muted">No loans match</div>
          ) : (
            loanList.map((l) => (
              <button
                key={l.id}
                onClick={() => onPickLoan(l)}
                disabled={busy}
                className="w-full text-left px-5 py-2.5 hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                <div className="text-[13px] font-medium text-ink truncate">{loanLabel(l)}</div>
                <div className="text-[11px] text-muted truncate tabular-nums">
                  {l.lender || "—"}{l.outstanding ? ` · ${fmtAmount(l.outstanding)} outstanding` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AllocationPanel(props: {
  txn: BankTxn;
  allocs: BankAllocation[];
  loading: boolean;
  targetType: "deal" | "loan" | "expense";
  setTargetType: (v: "deal" | "loan" | "expense") => void;
  filteredDeals: DealFlow[];
  dealQuery: string;
  setDealQuery: (v: string) => void;
  dealListOpen: boolean;
  setDealListOpen: (v: boolean) => void;
  selectedDeal: DealFlow | null;
  onPickDeal: (d: DealFlow) => void;
  filteredLoans: Loan[];
  loanQuery: string;
  setLoanQuery: (v: string) => void;
  loanListOpen: boolean;
  setLoanListOpen: (v: boolean) => void;
  selectedLoan: Loan | null;
  onPickLoan: (l: Loan) => void;
  amountStr: string;
  setAmountStr: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  allowSplit: boolean;
  setAllowSplit: (v: boolean) => void;
  busy: boolean;
  onSubmit: () => void;
  onRemove: (id: string) => void;
  onUntagLoan: (bankTxnId: string) => void;
  onCreateRule: (matchCounterparty: string, category: string, tType: "deal" | "loan" | "expense", targetId: string, direction: string, autoBook?: boolean) => void;
  newDealBusy: boolean;
  onCreateDeal: (t: BankTxn, name: string, buyer: string, sale: number, note: string) => Promise<boolean>;
}) {
  const {
    txn, allocs, loading, targetType, setTargetType, filteredDeals, dealQuery, setDealQuery, dealListOpen, setDealListOpen,
    selectedDeal, onPickDeal, filteredLoans, loanQuery, setLoanQuery, loanListOpen, setLoanListOpen, selectedLoan, onPickLoan,
    amountStr, setAmountStr, role, setRole, note, setNote, allowSplit, setAllowSplit, busy, onSubmit, onRemove, onUntagLoan, onCreateRule,
    newDealBusy, onCreateDeal,
  } = props;

  // Live split math: how much of this transaction is still unallocated across ALL deals.
  const splitAllocated = allocs.reduce((s, a) => s + (a.amount || 0), 0);
  const splitRemaining = Math.max((txn.amount || 0) - splitAllocated, 0);

  // "Create a deal from this transaction" — retroactive backfill form (local state).
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [ndName, setNdName]   = useState("");
  const [ndBuyer, setNdBuyer] = useState("");
  const [ndSale, setNdSale]   = useState("");
  const [ndNote, setNdNote]   = useState("");

  const openNewDeal = () => {
    const base = txn.counterparty_name?.trim() || txn.description || "";
    setNdName(base);
    setNdBuyer(txn.counterparty_name?.trim() || base);
    setNdSale(txn.unallocated > 0 ? String(txn.unallocated) : "");
    setNdNote("");
    setShowNewDeal(true);
  };

  const submitNewDeal = async () => {
    const name = ndName.trim();
    const buyer = ndBuyer.trim();
    const sale = parseAmount(ndSale, NaN);
    if (!name) { toast("Deal name required", "error"); return; }
    if (!buyer) { toast("Buyer name required", "error"); return; }
    if (!(sale > 0)) { toast("Enter an expected sale amount", "error"); return; }
    if (await onCreateDeal(txn, name, buyer, sale, ndNote.trim())) setShowNewDeal(false);
  };

  const isLoanTagged = txn.counterparty_type === "loan";
  const counterparty = txn.counterparty_name?.trim() || "";
  // Remember future rows with this counterparty: a loan tag memorizes the loan
  // (recurring lender repayments), otherwise it memorizes the category only — a
  // one-off deal id shouldn't auto-apply to unrelated future transactions.
  const isLoanRule = isLoanTagged || (targetType === "loan" && !!selectedLoan);
  // Auto-book opt-in for the rule about to be created. Defaults OFF: automation is
  // per-payee consent, never the ambient behavior (R-018).
  const [rememberAuto, setRememberAuto] = useState(false);
  const alwaysTag = () => {
    if (!counterparty) return;
    const dir = txn.direction; // scope the rule to this txn's direction (in vs out)
    if (isLoanTagged && txn.counterparty_id) onCreateRule(counterparty, "", "loan", txn.counterparty_id, dir, rememberAuto);
    else if (targetType === "loan" && selectedLoan) onCreateRule(counterparty, "", "loan", selectedLoan.id, dir, rememberAuto);
    else onCreateRule(counterparty, txn.category || "", "expense", "", dir, rememberAuto);
  };

  // Booking memory, designed to stay inside its own box: the payee lives in a
  // truncating text span (full string on hover), never inside the button label —
  // the old "Tag all money-out from "<entire bank memo>" as X" button rendered a
  // 90-character quoted memo as its own label and broke the panel layout.
  const renderRememberRow = () => {
    const canTag = !!counterparty && (isLoanRule || !!txn.category);
    if (!canTag) return null;
    const dirWord = txn.direction === "in" ? "money in" : "money out";
    const what = isLoanRule ? "books to this loan" : `books as ${catLabel(txn.category || "")}`;
    return (
      <div className="min-w-0 border border-line-2 rounded-lg pl-3 pr-2 py-2 bg-surface-2/40 space-y-1.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <Wand2 size={13} className="text-muted flex-shrink-0" />
          <div className="min-w-0 flex-1 text-[12px] text-muted truncate" title={counterparty}>
            Every future {dirWord} from <span className="text-ink-2 font-medium">{counterparty}</span> {what}
          </div>
          <button
            onClick={alwaysTag}
            title="Remember this booking — applies to every matching unbooked transaction now, and to future ones as they arrive. Synced to your other devices."
            className="flex-shrink-0 h-7 px-2.5 rounded-md border border-accent/40 bg-accent/5 text-accent text-[12px] font-semibold hover:bg-accent/10 transition-colors"
          >
            Remember
          </button>
        </div>
        <label className="flex items-center gap-2 pl-[23px] text-[11.5px] text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rememberAuto}
            onChange={(e) => setRememberAuto(e.target.checked)}
            className="accent-accent"
          />
          Book it automatically too — matched transactions skip the queue entirely
        </label>
      </div>
    );
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px] text-ink-2 min-w-0">
          {txn.direction === "in" ? "Receipt" : "Payment"} of{" "}
          <span className="font-semibold tabular-nums text-ink">{fmtAmount(txn.amount)}</span>
          {/* The account moved here when it left the table row — it is near-constant
              down the column, but it must stay visible somewhere per transaction. */}
          {txn.account_id ? <span className="text-muted"> · {txn.account_id}</span> : null}
        </div>
        <div className="text-[12px] text-muted">
          Unallocated{" "}
          <span className={`font-semibold tabular-nums ${txn.unallocated > 0.0001 ? "text-warning-ink" : "text-success-ink"}`}>
            {fmtAmount(txn.unallocated)}
          </span>
        </div>
      </div>

      {/* Existing allocations / loan tag */}
      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          {isLoanTagged && (
            <div className="border border-line-2 rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2">
                <Landmark size={14} className="text-muted flex-shrink-0" strokeWidth={1.8} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink truncate">{txn.counterparty_name || "Loan"}</div>
                  <div className="text-[11px] text-muted">{loanTagLabel(txn.direction)}</div>
                </div>
                <button
                  onClick={() => onUntagLoan(txn.id)}
                  disabled={busy}
                  title="Remove loan tag"
                  className="flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-faint hover:text-danger-ink hover:bg-danger-bg disabled:opacity-50 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )}
          {allocs.length > 0 && (
            <div className="border border-line-2 rounded-lg divide-y divide-line-2 overflow-hidden">
              {allocs.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-ink truncate">
                      {a.deal_name?.trim() || a.invoice_number || "Deal"}
                      {a.client_name && <span className="text-muted font-normal"> · {a.client_name}</span>}
                    </div>
                    <div className="text-[11px] text-muted">
                      {roleLabel(a.role)}{a.invoice_number ? ` · ${a.invoice_number}` : ""}{a.note ? ` · ${a.note}` : ""}
                    </div>
                  </div>
                  <div className="text-[12px] font-semibold text-ink tabular-nums flex-shrink-0">{fmtAmount(a.amount)}</div>
                  <button
                    onClick={() => onRemove(a.id)}
                    title="Remove allocation"
                    className="flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-faint hover:text-danger-ink hover:bg-danger-bg transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!isLoanTagged && allocs.length === 0 && (
            <div className="text-[12px] text-muted">Not tied to any deal or loan yet.</div>
          )}
        </>
      )}

      {/* Where this transaction belongs */}
      <div className="flex gap-1 flex-wrap">
        {([["deal", "Deal"], ["loan", "Loan"], ["expense", "Expense / income"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTargetType(v)}
            className={`px-3 h-9 rounded-lg text-[12px] font-medium transition-colors ${
              targetType === v ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Deal target */}
      {targetType === "deal" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
            <div className="sm:col-span-5 relative min-w-0">
              <input
                value={dealQuery}
                onChange={(e) => setDealQuery(e.target.value)}
                onFocus={() => setDealListOpen(true)}
                placeholder="Search a deal…"
                className={inp}
              />
              {dealListOpen && (
                <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg">
                  {filteredDeals.length > 0 ? (
                    filteredDeals.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => onPickDeal(d)}
                        className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors border-b border-line/40 last:border-0"
                      >
                        <DealRowContent d={d} match={dealMatchesTxn(d, txn)} />
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-3 text-[11px] text-muted">No deals match{dealQuery ? ` "${dealQuery}"` : " yet"}.</div>
                  )}
                </div>
              )}
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="Amount"
              aria-label="Amount to allocate"
              className={`${inp} sm:col-span-3 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="What this money is"
              title={ROLES.find((r) => r.value === role)?.hint || ""}
              className="sm:col-span-4 border border-line px-2.5 h-9 rounded-lg text-[13px] w-full bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {rolesFor(txn.direction).map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button
              onClick={onSubmit}
              disabled={busy || !selectedDeal}
              className="sm:col-span-12 flex items-center justify-center gap-1.5 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Allocate
            </button>
          </div>
          {/* Say what the chosen role MEANS for the deal's money, in the row where the
              choice is made. Picking "Payment to the supplier" for a refund silently
              adds it to cost of goods and moves recorded profit — the mistake this
              line exists to stop. */}
          {ROLES.find((r) => r.value === role)?.hint && (
            <p className="text-[11.5px] text-muted -mt-0.5">
              {ROLES.find((r) => r.value === role)?.hint}
            </p>
          )}
          {/* Split one payment across multiple deals — allocate a partial amount to
              each; the backend keeps the running total within the transaction. */}
          <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer mt-1">
            <input type="checkbox" checked={allowSplit} onChange={(e) => setAllowSplit(e.target.checked)} className="accent-accent" />
            Split this payment across multiple deals
          </label>
          {allowSplit && (
            <div className="flex items-center gap-2 text-[11.5px] text-muted mt-1 flex-wrap">
              <span>Enter a partial amount, pick a deal + role, Allocate — repeat for each deal.</span>
              <span className="ml-auto tabular-nums whitespace-nowrap">
                Unallocated <span className={`font-semibold ${splitRemaining > 0.005 ? "text-ink" : "text-success-ink"}`}>{fmtAmount(splitRemaining)}</span> of {fmtAmount(txn.amount)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className={`${inp} flex-1 min-w-[180px]`}
            />
            {/* Backfills a deal from a RECEIVED payment — only valid for money-in.
                On money-out it created an orphan client/invoice/deal then errored. */}
            {txn.direction === "in" && (
              <button
                onClick={() => (showNewDeal ? setShowNewDeal(false) : openNewDeal())}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[12px] font-medium hover:bg-surface-2 transition-colors"
              >
                <Plus size={13} /> New deal from this transaction
              </button>
            )}
          </div>
          {renderRememberRow()}
        </>
      )}

      {/* Loan target — tags the whole transaction (received / repayment by direction) */}
      {targetType === "loan" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
            <div className="sm:col-span-7 relative min-w-0">
              <input
                value={loanQuery}
                onChange={(e) => setLoanQuery(e.target.value)}
                onFocus={() => setLoanListOpen(true)}
                placeholder="Search a loan…"
                className={inp}
              />
              {loanListOpen && filteredLoans.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg">
                  {filteredLoans.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => onPickLoan(l)}
                      className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors"
                    >
                      <div className="text-[12px] font-medium text-ink truncate">{loanLabel(l)}</div>
                      <div className="text-[11px] text-muted truncate tabular-nums">
                        {l.lender || "—"}{l.outstanding ? ` · ${fmtAmount(l.outstanding)} outstanding` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="sm:col-span-3 h-9 flex items-center px-3 border border-line-2 rounded-lg text-[12px] text-muted bg-surface-2/40 truncate">
              Records as {loanTagLabel(txn.direction).toLowerCase()}
            </div>
            <button
              onClick={onSubmit}
              disabled={busy || !selectedLoan}
              className="sm:col-span-2 flex items-center justify-center gap-1.5 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />} Tag to loan
            </button>
          </div>
          {renderRememberRow()}
        </>
      )}

      {/* Expense / income — no target, just the row's category */}
      {targetType === "expense" && (
        <>
          <p className="text-[12px] text-muted">
            Tracked by category only — set the category on the row above; it isn't tied to a deal or loan.
          </p>
          {renderRememberRow()}
        </>
      )}

      {/* Create a deal retroactively from this transaction */}
      {showNewDeal && (
        <div className="border border-line rounded-xl p-3.5 space-y-3 bg-surface-2/40">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-medium text-ink">Create a deal from this transaction</div>
            <button
              onClick={() => setShowNewDeal(false)}
              title="Cancel"
              className="text-faint hover:text-muted transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-0">
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Deal name</span>
              <input value={ndName} onChange={(e) => setNdName(e.target.value)} placeholder="Deal name" className={inp} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Buyer / client</span>
              <input value={ndBuyer} onChange={(e) => setNdBuyer(e.target.value)} placeholder="Buyer name" className={inp} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Expected sale</span>
              <input type="text" inputMode="decimal" value={ndSale} onChange={(e) => setNdSale(e.target.value)} placeholder="0.00" className={`${inp} tabular-nums`} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Note (optional)</span>
              <input value={ndNote} onChange={(e) => setNdNote(e.target.value)} placeholder="Note" className={inp} />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] text-muted min-w-0">Creates a client, a backfilled invoice and a deal, then ties this receipt to it.</p>
            <button
              onClick={submitNewDeal}
              disabled={newDealBusy}
              className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {newDealBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create deal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Memorized auto-tag rules — collapsible management home next to the queue they act on.
function RulesCard({
  rules, open, setOpen, onApply, onDelete, onToggleAuto, onCreate,
}: {
  rules: TxnRule[];
  open: boolean;
  setOpen: (v: boolean) => void;
  onApply: () => void;
  onDelete: (id: string) => void;
  onToggleAuto: (r: TxnRule) => void;
  onCreate: (matchCounterparty: string, category: string, direction: string) => void;
}) {
  const [cp, setCp]   = useState("");
  const [cat, setCat] = useState("");
  const [dir, setDir] = useState("");

  const add = () => {
    if (!cp.trim()) { toast("Enter a counterparty to match", "error"); return; }
    // A rule applies its category to EVERY matching un-booked transaction — an
    // empty ("Uncategorized") rule would mass-clear categories across the ledger.
    if (!cat) { toast("Pick a category for the rule", "error"); return; }
    onCreate(cp.trim(), cat, dir);
    setCp(""); setCat(""); setDir("");
  };

  return (
    <div className="border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <ChevronRight size={14} className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <span className="text-[13px] font-semibold text-ink">Auto-tag rules</span>
          <span className="text-[12px] text-muted tabular-nums">· {rules.length}</span>
        </button>
        <button
          onClick={onApply}
          className="text-[12px] font-medium text-accent hover:text-accent-hover transition-colors"
        >
          Apply rules now
        </button>
      </div>

      {open && (
        <div className="pt-3 space-y-3">
          <p className="text-[11px] text-muted leading-relaxed">
            Booking teaches the app. Once a payee has been booked the same way twice, its unbooked transactions show a
            one-tap "Usually …" suggestion drawn from your own history. "Remember" in the booking sheet goes one step
            further — it applies the booking to every matching transaction now and to future ones as they arrive, and
            it reaches every device signed into your workspace. A memory can be limited to money in or money out, so
            the same payer (e.g. Whatnot) can be a sale one way and an expense the other. "Suggests" rows wait in
            To book for your click; "Auto-books" rows are booked outright and skip the queue — flip it per rule.
          </p>

          {rules.length > 0 && (
            <div className="border-t border-line-2">
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-2 border-b border-line-2">
                  <div className="min-w-0 flex-1 text-[12.5px]">
                    {r.direction && (
                      <span className={r.direction === "in" ? "text-success-ink" : "text-danger-ink"}>
                        {r.direction === "in" ? "Money in" : "Money out"} ·{" "}
                      </span>
                    )}
                    <span className="font-semibold text-ink">{r.match_counterparty}</span>
                    <span className="text-faint"> → </span>
                    <span className="text-ink-2">{r.target_type === "loan" ? (r.loan_name || "Loan") : catLabel(r.category)}</span>
                  </div>
                  <button
                    onClick={() => onToggleAuto(r)}
                    title={r.auto_book
                      ? "Auto-book is ON — matched transactions are booked outright and skip the queue. Click to turn off."
                      : "Auto-book is OFF — matched transactions are pre-filled but wait in To book. Click to book them automatically."}
                    className={`flex-shrink-0 h-6 px-2 rounded-md border text-[11px] font-semibold transition-colors ${
                      r.auto_book
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-line text-muted hover:text-ink-2 hover:border-line-3"
                    }`}
                  >
                    {r.auto_book ? "Auto-books" : "Suggests"}
                  </button>
                  <button
                    onClick={() => onDelete(r.id)}
                    title="Delete rule — on every device"
                    className="flex-shrink-0 text-faint hover:text-danger-ink transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add rule (edit = delete then re-add) */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={cp}
              onChange={(e) => setCp(e.target.value)}
              placeholder="Counterparty to match…"
              className={`${inp} flex-1 min-w-[160px]`}
            />
            <select
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              title="Which direction this rule applies to"
              className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">Any direction</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
            <select
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <CategoryOptions />
            </select>
            <button
              onClick={add}
              className="flex items-center gap-1.5 h-9 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[12px] font-medium transition-colors"
            >
              <Plus size={13} /> Add rule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
