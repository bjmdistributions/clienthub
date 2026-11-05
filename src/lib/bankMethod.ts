// The payment method a bank row's own evidence shows. Moved here from FinancialsView (R-602) so the Deal
// Flow and buy payment lists read a row the same way Financials does.

export type BankMethod = "wire" | "ach" | "zelle" | "rtp" | "check" | "card" | "cash" | "transfer";

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
export const METHOD_PATTERNS: { method: BankMethod; re: RegExp; reason: string }[] = [
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
export const bankFieldMethod = (raw?: string | null): BankMethod | null => {
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

/** R-602: the method this row's own evidence shows: a person's answer, the bank's field, the memo, then the
 *  importer's memo guess. "" when nothing says. (Financials' `readMethod` adds the payee memory on top.) */
export function evidenceMethod(t: {
  confirmed_method?: string; bank_method?: string | null; description?: string; counterparty_name?: string; rail?: string;
}): BankMethod | "" {
  if (t.confirmed_method) return t.confirmed_method as BankMethod;
  const field = bankFieldMethod(t.bank_method);
  if (field) return field;
  const hay = `${t.description || ""} ${t.counterparty_name || ""}`.toUpperCase();
  const hit = METHOD_PATTERNS.find((p) => p.re.test(hay));
  if (hit) return hit.method;
  return (t.rail as BankMethod) || "";
}

/** R-602: how deals are paid. Jack: "only wire zelle or ach and not show other junk". Real-time payments and
 *  checks are buyers' and suppliers' payments too, so a link list that hid them would look like missing money. */
export const DEAL_PAYMENT_METHODS: BankMethod[] = ["wire", "ach", "zelle", "rtp", "check"];

export const isDealPayment = (t: Parameters<typeof evidenceMethod>[0]): boolean => {
  const m = evidenceMethod(t);
  return m !== "" && DEAL_PAYMENT_METHODS.includes(m);
};
