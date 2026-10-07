// R-459: carriers, the rate popup and paying carriers. Everything here takes values and returns
// values, so the rules are tested without a screen: how a carrier gets paid, when to offer "Save to
// carriers", what the last-rate popup says, the query text the Logistics bridge allows, what Mark
// paid prefills and writes, how the bank candidates are read, and who may pay. The phone carries the
// same rules in www/app.js.

import type {
  CarrierPayMethod, CarrierPayRow, FreightCarrier, FreightBooking, RateMatch, RatesResponse,
} from "./api";
import { fmtAmount } from "./format";
import { LOAD_STEPS, dueLabel, dueTone, fmtDayLabel, laneOf, type LoadStep } from "./logisticsLoad";
import { formatLocation } from "./location";
import { can, isAdmin, isLogisticsOnly, type Perms } from "./permissions";

// ─── how a carrier gets paid (contract section 5) ─────────────────────────

export const PAY_METHODS: { key: Exclude<CarrierPayMethod, "">; label: string }[] = [
  { key: "zelle", label: "Zelle" },
  { key: "wire", label: "Wire" },
  { key: "ach", label: "ACH" },
  { key: "credit_card", label: "Credit card" },
  { key: "check", label: "Check" },
  { key: "other", label: "Other" },
];

/** "Zelle", "Credit card"; empty for no method or one that is not on the list. */
export const payMethodLabel = (key: string | null | undefined): string => PAY_METHODS.find((m) => m.key === key)?.label ?? "";

/** The method a stored word names, whether it is the key ("credit_card") or the label ("Credit card"). */
export function payMethodKey(word: string | null | undefined): CarrierPayMethod {
  const w = (word || "").trim().toLowerCase();
  return PAY_METHODS.find((m) => m.key === w || m.label.toLowerCase() === w)?.key ?? "";
}

// ─── the Logistics bridge allows no spaces and no percent signs ───────────

/** Text for a query string the bridge will pass: letters, digits and a few marks, spaces as plus. */
export function queryText(s: string): string {
  return (s || "").replace(/[^A-Za-z0-9 ,.'@_-]/g, "").trim().replace(/\s+/g, "+");
}

/** The two ends of a lane as "City, ST", from the first pickup and the delivery address. null until both
 *  read as a place, so the send sheet asks for rates only once the addresses are in. */
export function laneEnds(pickupAddress: string, deliveryAddress: string): { pickup: string; delivery: string } | null {
  const a = laneOf(pickupAddress), b = laneOf(deliveryAddress);
  if (!a || !b) return null;
  return { pickup: formatLocation(a.city, a.state), delivery: formatLocation(b.city, b.state) };
}

// ─── the carrier picker (contract section 5) ──────────────────────────────

/** A name as the server compares it: lowercased, punctuation gone, spaces squeezed. */
export const normalName = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export const carrierByName = (name: string, list: FreightCarrier[]): FreightCarrier | null => {
  const n = normalName(name);
  return n ? list.find((c) => normalName(c.name) === n) ?? null : null;
};

/** The directory narrowed to what was typed: name, MC or DOT. At most `max`, the best starts first. */
export function filterCarriers(list: FreightCarrier[], text: string, max = 8): FreightCarrier[] {
  const n = normalName(text);
  if (!n) return list.slice(0, max);
  const hit = (c: FreightCarrier) => [c.name, c.mc_number, c.dot_number].some((v) => normalName(v).includes(n));
  const starts = (c: FreightCarrier) => normalName(c.name).startsWith(n) ? 0 : 1;
  return list.filter(hit).sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name)).slice(0, max);
}

/** "Save to carriers" is offered for a typed name nobody has saved yet. Nothing is offered before the
 *  directory has loaded (`list` null), since the name might be on it. */
export const offerSaveCarrier = (typed: string, list: FreightCarrier[] | null): boolean =>
  list !== null && normalName(typed) !== "" && carrierByName(typed, list) === null;

/** "MC 123456, DOT 7890" from whichever the carrier has. */
export const carrierIds = (c: Pick<FreightCarrier, "mc_number" | "dot_number">): string =>
  [c.mc_number.trim() && `MC ${c.mc_number.trim()}`, c.dot_number.trim() && `DOT ${c.dot_number.trim()}`].filter(Boolean).join(", ");

/** Net 30 and the like: "Pays within 30 days" in the words a person says, "" with no terms. */
export const termsWord = (days: number | null | undefined): string =>
  days == null ? "" : days === 0 ? "Pay on delivery" : `Net ${days}`;

// ─── the rate popup (contract section 6) ──────────────────────────────────

/** What a past load cost: what was paid, else what was quoted. */
export const rateOf = (m: Pick<RateMatch, "rate" | "quote_amount">): number | null => m.rate ?? m.quote_amount ?? null;

export interface LastRate { lead: string; carrier: string; carrierId: string; tail: string }

/** The popup's one line: "Last time on Dallas, TX to Newark, NJ:" then the carrier then "at $1,850 (Sep 12)".
 *  null when there is nothing to say yet (the caller prints "No past loads on this lane yet."). A figure the
 *  viewer may not see is left out, the carrier and the day stay. */
export function lastRate(r: RatesResponse | null | undefined, now?: Date): LastRate | null {
  const m = r?.last ?? r?.matches?.[0] ?? null;
  if (!r || !m) return null;
  const lane = [r.lane?.from, r.lane?.to].filter(Boolean).join(" to ");
  const lead = m.exact === false
    ? "Nothing on this exact lane. Closest, in the same states:"
    : `Last time on ${lane || "this lane"}:`;
  const rate = rateOf(m);
  const day = fmtDayLabel(m.day, now);
  const tail = [rate != null ? `at ${fmtAmount(rate)}` : "", day ? `(${day})` : ""].filter(Boolean).join(" ");
  return { lead, carrier: m.carrier || "Carrier not named", carrierId: m.carrier_id || "", tail };
}

// ─── pay carriers (contract section 9) ────────────────────────────────────

/** The `pay` permission on the desktop: someone who sees deals and their dollar figures and edits deals,
 *  or an admin. A Logistics-only account never does, so it never calls the carrier-pay routes. */
export function canPayCarriers(me: Perms | null | undefined): boolean {
  if (!me || isLogisticsOnly(me)) return false;
  return isAdmin(me) || (can(me, "deal_flow:view") && can(me, "deal_flow:view_numbers") && can(me, "deal_flow:edit"));
}

/** Who may add and change carriers: the logistics edit switch, deal edit, or an admin. */
export const canEditCarriers = (me: Perms | null | undefined): boolean =>
  !!me && (isAdmin(me) || can(me, "logistics:edit") || can(me, "deal_flow:edit"));

/** Who sees how a carrier gets paid (the details are money): the dollar switch, an admin, or an account
 *  with no deal access at all (the Logistics person who sets how a carrier is paid). The server's money rule. */
export const canSeePayDetails = (me: Perms | null | undefined): boolean =>
  !!me && (isAdmin(me) || can(me, "deal_flow:view_numbers") || !can(me, "deal_flow:view"));

export interface MarkPaidForm { amount: string; paidAt: string; method: string; note: string }

/** Mark paid opens with the carrier rate as the amount, today as the day, and how the carrier likes
 *  to be paid. Everything stays editable. */
export function markPaidDefaults(r: { rate: number | null; pay_method: string }, today: string): MarkPaidForm {
  return { amount: r.rate == null ? "" : String(r.rate), paidAt: today, method: payMethodLabel(r.pay_method) || "", note: "" };
}

/** The PATCH that records the payment. null with a message when the figure cannot be used. */
export function markPaidPatch(f: MarkPaidForm): { patch: { paid_amount: number; paid_at: string; paid_method: string; paid_note: string } } | { error: string } {
  const t = f.amount.trim();
  if (!t) return { error: "Add the amount paid." };
  const n = Number(t.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return { error: "The amount paid must be a number." };
  if (n < 0) return { error: "The amount paid cannot be less than zero." };
  if (n > 10_000_000) return { error: "The amount paid is too large." };
  if (!f.paidAt) return { error: "Add the day it was paid." };
  return { patch: { paid_amount: Math.round(n * 100) / 100, paid_at: f.paidAt, paid_method: f.method.trim(), paid_note: f.note.trim() } };
}

/** Undo is the amount going back to nothing, and nothing else. */
export const UNDO_PAID_PATCH = { paid_amount: null } as const;

/** The due word and tone for one row, off the local day (the server's `overdue` is its own clock). */
export const payDue = (r: Pick<CarrierPayRow, "pay_due_date">, today: string): { label: string; tone: "danger" | "warning" | "neutral" } =>
  ({ label: dueLabel(r.pay_due_date, today), tone: dueTone(r.pay_due_date, today) });

/** The rows still owed, counted for a section header: how many, how many are due today or late, and the
 *  rate they add up to (loads with no rate yet add nothing and are counted apart). */
export function toPaySummary(rows: Pick<CarrierPayRow, "pay_due_date" | "rate">[], today: string): { count: number; late: number; total: number; noRate: number } {
  let late = 0, total = 0, noRate = 0;
  for (const r of rows) {
    if (payDue(r, today).tone === "danger") late++;
    if (r.rate == null) noRate++; else total += r.rate;
  }
  return { count: rows.length, late, total: Math.round(total * 100) / 100, noRate };
}

/** Whether a booking is one the Pay step lets the team record a payment on. */
export const canRecordOn = (b: Pick<FreightBooking, "status" | "can_see_deal" | "can_see_money">, canPay: boolean): boolean =>
  canPay && b.can_see_deal && b.can_see_money !== false && (b.status === "booked" || b.status === "picked_up" || b.status === "delivered");

// ─── the bank candidates (contract section 9) ─────────────────────────────

export interface BankCandidate { txnId: string; day: string; amount: number | null; who: string; memo: string; reason: string }

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The bank payments the server offers for a load. It answers with the existing bank suggestion rows, so
 *  each key is read from the names that route family uses, and a row with no transaction id is dropped. */
export function carrierPayCandidates(resp: unknown): BankCandidate[] {
  const o = (resp && typeof resp === "object" ? resp : {}) as Record<string, unknown>;
  const list = [o.candidates, o.txns, o.transactions, o.suggestions, Array.isArray(resp) ? resp : null].find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).flatMap((x) => {
    const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const txnId = str(r.txn_id ?? r.id);
    if (!txnId) return [];
    return [{
      txnId, day: str(r.posted_at ?? r.date ?? r.day).slice(0, 10), amount: num(r.amount) ?? num(r.leg_amount),
      who: str(r.counterparty_name ?? r.counterparty ?? r.payee ?? r.name), memo: str(r.description ?? r.memo), reason: str(r.reason),
    }];
  });
}

// ─── opening a load or a carrier from another screen ──────────────────────

/** The stash-then-switch handoffs, like `invoices_open_id`. Bills opens a load on its Pay step. */
export const OPEN_LOAD_KEY = "logistics_open_load";
export const OPEN_CARRIER_KEY = "logistics_open_carrier";

export const encodeOpenLoad = (id: string, step?: LoadStep): string => JSON.stringify(step ? { id, step } : { id });

/** What a stashed handoff names. A bare id (no JSON) is a load on its first step. null for junk. */
export function parseOpenLoad(raw: string | null | undefined): { id: string; step?: LoadStep } | null {
  const t = (raw || "").trim();
  if (!t) return null;
  if (!t.startsWith("{")) return { id: t };
  try {
    const o = JSON.parse(t) as { id?: unknown; step?: unknown };
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) return null;
    const step = LOAD_STEPS.find((s) => s.key === o.step)?.key;
    return step ? { id, step } : { id };
  } catch { return null; }
}
