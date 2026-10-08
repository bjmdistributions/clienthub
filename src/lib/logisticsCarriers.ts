// R-459: carriers, the rate popup and paying carriers. Everything here takes values and returns
// values, so the rules are tested without a screen: how a carrier gets paid, when to offer "Save to
// carriers", what the last-rate popup says, the query text the Logistics bridge allows, what Mark
// paid prefills and writes, how the bank candidates are read, and who may pay. The phone carries the
// same rules in www/app.js.

import type {
  CarrierPayMethod, CarrierPayRow, FreightCarrier, FreightBooking, RateMatch, RatesResponse,
} from "./api";
import { fmtAmount, parseLocalDay } from "./format";
import { LOAD_STEPS, addDays, dueLabel, dueTone, fmtDayLabel, laneOf, type LoadStep } from "./logisticsLoad";
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

/** R-470: taking back a payment somebody typed (never linked to the bank) is the amount going back to nothing, and
 *  nothing else. It is the only paid write left: a load becomes paid only by linking its bank payment. */
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

/** Whether a booking is one the Pay step lets the team link a bank payment to. */
export const canRecordOn = (b: Pick<FreightBooking, "status" | "can_see_deal" | "can_see_money">, canPay: boolean): boolean =>
  canPay && b.can_see_deal && b.can_see_money !== false && (b.status === "booked" || b.status === "picked_up" || b.status === "delivered");

/** R-470: whether the team may take a payment back (Undo or Unlink). Any status: a payment on a load that was
 *  cancelled afterwards still has to be fixable. */
export const canChangePaidOn = (b: Pick<FreightBooking, "can_see_deal" | "can_see_money">, canPay: boolean): boolean =>
  canPay && b.can_see_deal && b.can_see_money !== false;

// ─── the bank candidates (contract section 9) ─────────────────────────────

/** One bank row offered for a load. `free` is the money on it no deal has claimed (what can still be linked) and
 *  `suggested` is the amount the server would link. Either is null on an older server. */
export interface BankCandidate {
  txnId: string; day: string; amount: number | null; free: number | null; suggested: number | null;
  who: string; memo: string; method: string; reason: string;
}

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
      txnId, day: str(r.posted_at ?? r.date ?? r.day).slice(0, 10), amount: num(r.txn_amount) ?? num(r.amount) ?? num(r.leg_amount),
      free: num(r.unlinked), suggested: num(r.suggested_amount),
      who: str(r.counterparty_name ?? r.counterparty ?? r.payee ?? r.name), memo: str(r.description ?? r.memo), method: str(r.method), reason: str(r.reason),
    }];
  });
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** The amount a pick opens with: the server's suggestion, else the smaller of the money free on the row and the
 *  carrier rate (when there is a rate), else what is free. null when none of them is known. */
export function linkAmountStart(c: Pick<BankCandidate, "free" | "suggested" | "amount">, rate: number | null | undefined): number | null {
  if (c.suggested != null) return cents(c.suggested);
  const free = c.free ?? c.amount;
  if (free == null) return rate != null && rate > 0 ? cents(rate) : null;
  return cents(rate != null && rate > 0 && rate < free ? rate : free);
}

/** The amount typed in the confirm step: more than $0 and at most the money free on the bank row. */
export function linkAmountCheck(raw: string, free: number | null): { amount: number } | { error: string } {
  const t = raw.trim();
  if (!t) return { error: "Add the amount to link." };
  const n = Number(t.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return { error: "The amount must be a number." };
  const amount = cents(n);
  if (amount <= 0) return { error: "The amount must be more than $0." };
  if (free != null && amount > cents(free) + 0.001) return { error: `The amount cannot be more than the ${fmtAmount(free)} free on this payment.` };
  if (amount > 10_000_000) return { error: "The amount is too large." };
  return { amount };
}

// ─── fill from a saved carrier (R-471) ────────────────────────────────────

/** A name with everything but letters and digits dropped, so "Acme-Freight, Inc." and "acme freight inc" are one name. */
export const squashName = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** An MC or DOT number typed in a box: "MC 123456", "MC-123456", "DOT 7890" or bare digits. null for anything else. */
export function typedNumber(typed: string): { kind: "mc" | "dot" | "any"; digits: string } | null {
  const m = /^\s*(mc|dot)?[\s#:.-]*(\d[\d\s-]*)$/i.exec(typed || "");
  if (!m) return null;
  const digits = m[2].replace(/\D/g, "");
  return digits.length >= 3 ? { kind: (m[1]?.toLowerCase() as "mc" | "dot" | undefined) ?? "any", digits } : null;
}

const digitsOf = (s: string): string => (s || "").replace(/\D/g, "");

/** The saved carriers the typed text names: the same name (case, spaces and punctuation ignored) or the same MC or
 *  DOT number; failing both, a name that starts with the typed text (3 or more characters) or that the typed text
 *  starts with (a saved "Acme Freight" for "Acme Freight LLC"). The closest name first; nothing for fewer than 3 characters. */
export function carrierMatches(typed: string, list: FreightCarrier[] | null | undefined): FreightCarrier[] {
  const t = squashName(typed);
  if (!list || t.length < 3) return [];
  const exact = list.filter((c) => squashName(c.name) === t);
  const tn = typedNumber(typed);
  const byNumber = tn
    ? list.filter((c) => !exact.includes(c) && ((tn.kind !== "dot" && digitsOf(c.mc_number) === tn.digits) || (tn.kind !== "mc" && digitsOf(c.dot_number) === tn.digits)))
    : [];
  const sure = [...exact, ...byNumber];
  if (sure.length > 0) return sure;
  const gap = (c: FreightCarrier) => Math.abs(squashName(c.name).length - t.length);
  return list
    .filter((c) => { const n = squashName(c.name); return n.length >= 3 && (n.startsWith(t) || t.startsWith(n)); })
    .sort((a, b) => gap(a) - gap(b) || a.name.localeCompare(b.name));
}

export interface FillFacts { carrier: string; carrier_id: string; delivered_at: string; pay_due_date: string }

/** What pressing "Fill from <carrier>" sets: the carrier's name and id, and (only when the load is already delivered
 *  and has no pay due date) the day it was delivered plus the carrier's terms. */
export function fillPatch(c: FreightCarrier, f: Pick<FillFacts, "delivered_at" | "pay_due_date">): { carrier: string; carrier_id: string; pay_due_date?: string } {
  const out: { carrier: string; carrier_id: string; pay_due_date?: string } = { carrier: c.name, carrier_id: c.id };
  const delivered = (f.delivered_at || "").trim().slice(0, 10);
  if (delivered && !(f.pay_due_date || "").trim() && c.pay_terms_days != null && !isNaN(parseLocalDay(delivered).getTime())) {
    out.pay_due_date = addDays(delivered, c.pay_terms_days);
  }
  return out;
}

/** Whether pressing the button would change anything. Once the load carries this carrier by name and id, with the pay
 *  due date set or nothing to set it from, the button goes away. */
export function fillWouldChange(c: FreightCarrier, f: FillFacts): boolean {
  const p = fillPatch(c, f);
  return p.carrier !== f.carrier || p.carrier_id !== f.carrier_id || (p.pay_due_date !== undefined && p.pay_due_date !== f.pay_due_date);
}

/** The matches that pressing would change something for. The button shows when this is not empty. */
export const fillOffers = (typed: string, list: FreightCarrier[] | null | undefined, f: FillFacts): FreightCarrier[] =>
  carrierMatches(typed, list).filter((c) => fillWouldChange(c, f));

/** What a filled carrier shows on the load: MC and DOT, contact, phone and how it gets paid. Empty ones are left out. */
export function carrierFacts(c: FreightCarrier): { label: string; value: string }[] {
  const paid = [payMethodLabel(c.pay_method) && `Paid by ${payMethodLabel(c.pay_method)}`, termsWord(c.pay_terms_days)].filter(Boolean).join(", ");
  return [
    { label: "MC and DOT", value: carrierIds(c) },
    { label: "Contact", value: c.contact_name.trim() },
    { label: "Phone", value: c.phone.trim() },
    { label: "How they get paid", value: paid },
  ].filter((x) => x.value);
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
