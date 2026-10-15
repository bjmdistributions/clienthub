// R-459: the load (a freight booking) as a flow. Everything here takes values and returns
// values, so the rules are tested without a screen: the status model and its labels, the
// stepper (first step, done dots), how the actual dates move the status, the list groups, the
// due labels, the lane, the equipment list and the send-invoice warning. The phone carries the
// same rules in www/app.js, so a change here is a change there.

import type { FreightBooking, FreightFile, FreightFileKind, FreightStatus, FreightStop, PaidState } from "./api";
import { fmtAmount, localDay, parseLocalDay } from "./format";
import { formatLocation, parseLocation } from "./location";
import type { GateKey } from "./loadProgress";

// ─── statuses (contract section 1) ────────────────────────────────────────

/** Every status, in the order a load moves through them. `cancelled` last. */
export const STATUS_ORDER: FreightStatus[] = ["quote", "quoted", "requested", "booked", "picked_up", "delivered", "cancelled"];

const STATUS_WORDS: Record<FreightStatus, { team: string; logistics: string }> = {
  quote: { team: "Quote asked", logistics: "Quote needed" },
  quoted: { team: "Quoted", logistics: "Quoted" },
  requested: { team: "To book", logistics: "To book" },
  booked: { team: "Booked", logistics: "Booked" },
  picked_up: { team: "On the way", logistics: "On the way" },
  delivered: { team: "Delivered", logistics: "Delivered" },
  cancelled: { team: "Cancelled", logistics: "Cancelled" },
};

/** The label a status wears. Only `quote` reads differently to the two sides. */
export function statusWord(status: string, logistics = false): string {
  const w = STATUS_WORDS[status as FreightStatus];
  return w ? (logistics ? w.logistics : w.team) : status;
}

/** A quote-stage row: the team asked, or logistics answered. It is not a truck yet. */
export const isQuoteStage = (status: string): boolean => status === "quote" || status === "quoted";

/** The live-truck rule: a load counts as a truck on its deal only when it is not cancelled and not
 *  a quote. Mirrors the server's `archived=0 AND status NOT IN ('cancelled','quote','quoted')`. */
export const isLiveTruck = (b: { status: string; archived?: boolean | number }): boolean =>
  !b.archived && b.status !== "cancelled" && !isQuoteStage(b.status);

/** How far along a status is. A cancelled load is nowhere. */
export function statusRank(status: string): number {
  const i = STATUS_ORDER.indexOf(status as FreightStatus);
  return status === "cancelled" ? -1 : i;
}

/** Who wrote the label: someone who may see the deal is the team, anyone else is logistics. */
export const isLogisticsSide = (b: { can_see_deal?: boolean }): boolean => b.can_see_deal === false;

/** The load number a person quotes: the minted one, else the old short code. */
export const loadNumber = (b: { load_number?: string; code: string }): string => (b.load_number || "").trim() || b.code;

// ─── equipment (contract section 11) ──────────────────────────────────────

export const EQUIPMENT: string[] = [
  "Dry van 53 ft", "Dry van 48 ft", "Reefer", "Flatbed", "Step deck", "Double drop", "Lowboy / RGN", "Conestoga",
  "Hotshot", "Box truck 26 ft", "Straight truck", "Sprinter / cargo van", "Power only", "LTL", "Partial / volume LTL",
  "Intermodal container", "Tanker", "Other",
];

/** The options to show: the list, plus a stored value that is not on it so it stays selected. */
export function equipmentOptions(current: string): string[] {
  const c = (current || "").trim();
  return c && !EQUIPMENT.includes(c) ? [...EQUIPMENT, c] : EQUIPMENT;
}

// ─── files (contract section 4) ───────────────────────────────────────────

export const FILE_KINDS: { key: FreightFileKind; label: string }[] = [
  { key: "bol", label: "Signed BOL" },
  { key: "pod", label: "Proof of delivery" },
  { key: "carrier_invoice", label: "Carrier invoice" },
  { key: "other", label: "Other" },
];

export const fileKind = (f: Pick<FreightFile, "kind">): FreightFileKind =>
  f.kind === "bol" || f.kind === "pod" || f.kind === "carrier_invoice" ? f.kind : "other";

export const fileKindLabel = (k: FreightFileKind): string => FILE_KINDS.find((x) => x.key === k)?.label ?? "Other";

export type Paperwork = { bol: boolean; pod: boolean; carrier_invoice: boolean };

/** Which paperwork is on file. The server's derived flags win; an older copy falls back to the files. */
export function paperworkOf(b: { paperwork?: Paperwork; files?: FreightFile[] }): Paperwork {
  if (b.paperwork) return b.paperwork;
  const kinds = new Set((b.files ?? []).map(fileKind));
  return { bol: kinds.has("bol"), pod: kinds.has("pod"), carrier_invoice: kinds.has("carrier_invoice") };
}

// ─── money visibility and payment (contract sections 9, 10) ───────────────

/** A viewer without the dollar switch gets null for every figure: null then means hidden, not none. */
export const moneyHidden = (b: { can_see_money?: boolean }): boolean => b.can_see_money === false;

/** The carrier rate is missing when this viewer could see it and nobody has typed it. */
export const rateMissing = (b: { quoted_cost: number | null; can_see_money?: boolean }): boolean =>
  !moneyHidden(b) && b.quoted_cost == null;

/** R-475: what the rate confirmation still lacks for the carrier, in the order the strip names them. A field this viewer
 *  may not see is hidden, not missing (the PDF prints it blank either way). Empty means it is ready to send. */
export function rateConMissing(b: {
  carrier: string; quoted_cost: number | null; can_see_money?: boolean; pickup_date: string;
  pickup_name: string; pickup_address: string; delivery_name: string; delivery_address: string;
  can_see_names: boolean; can_see_addresses: boolean;
}): string[] {
  const t = (v: string | null | undefined) => (v ?? "").trim();
  const sees = b.can_see_names || b.can_see_addresses;
  const place = (name: string, address: string) => (b.can_see_names && !!t(name)) || (b.can_see_addresses && !!t(address));
  const out: string[] = [];
  if (!t(b.carrier)) out.push("carrier");
  if (rateMissing(b)) out.push("carrier rate");
  if (sees && !place(b.pickup_name, b.pickup_address)) out.push("pickup location");
  if (sees && !place(b.delivery_name, b.delivery_address)) out.push("delivery location");
  if (!t(b.pickup_date)) out.push("pickup date");
  return out;
}

/** R-475: the strip's sentence under "Rate confirmation". */
export const rateConLine = (missing: string[]): string =>
  missing.length ? `Still missing: ${missing.join(", ")}. It exports anyway, with those left blank.` : "Ready to send to the carrier.";

const PAID_METHOD_WORDS: Record<string, string> = {
  zelle: "Zelle", wire: "Wire", ach: "ACH", credit_card: "Credit card", check: "Check", other: "Other",
};

/** How a load was paid, as a word: a key an older phone build stored ("credit_card") reads as its label. */
export const paidMethodWord = (m: string | null | undefined): string => {
  const t = (m || "").trim();
  return PAID_METHOD_WORDS[t.toLowerCase()] ?? t;
};

// ─── paid means linked to the bank (R-470) ────────────────────────────────

/** What a load's payment is. The server's `paid_state` wins. Without it (an older server, or the local copy of a
 *  load) a load is paid only when the bank link says so, and a payment with no link is `marked`: the screen
 *  never claims Paid on a figure somebody typed. */
export function paidStateOf(b: { paid_state?: string | null; paid_amount?: number | null; bank_linked?: string | null; can_see_money?: boolean }): PaidState {
  const s = b.paid_state;
  // A recorded $0 (or less) is never a payment, whatever the link says: it is marked, to be undone.
  if (b.paid_amount != null && b.paid_amount <= 0.005) return "marked";
  if (s === "unpaid" || s === "marked" || s === "paid" || s === "part") return s;
  // The server withheld the money from a viewer without the dollar switch: say nothing, never "Not paid yet".
  if (b.paid_amount == null && (s === "" || (b.can_see_money === false && !s))) return "hidden";
  if (b.paid_amount == null) return "unpaid";
  return b.bank_linked === "linked" ? "paid" : "marked";
}

export interface PaidFacts {
  paid_state?: string | null; paid_amount?: number | null; bank_linked?: string | null;
  paid_at?: string | null; paid_method?: string | null; paid_note?: string | null; pay_due_date?: string | null; can_see_money?: boolean;
  /** The carrier rate: what a part-linked load still has to reach. */
  quoted_cost?: number | null;
}

export interface PaidView {
  state: PaidState;
  tone: "neutral" | "warning" | "danger" | "success";
  /** The sentence the load carries. */
  text: string;
  /** The small line under it: the due date while unpaid, the bank link once paid. */
  note: string;
  /** The tone of the note (a due date turns amber, then red). */
  noteTone: "neutral" | "warning" | "danger" | "success";
  /** A $0 payment, which is never a real one. */
  zero: boolean;
}

/** The words every screen uses for a load's payment (the phone carries the same). */
export function paidView(b: PaidFacts, today: string, now?: Date): PaidView {
  const state = paidStateOf(b);
  const amount = b.paid_amount ?? null;
  if (state === "hidden") return { state, tone: "neutral", text: "", note: "", noteTone: "neutral", zero: false };
  if (state === "unpaid") {
    const due = (b.pay_due_date || "").trim();
    const note = due ? dueLabel(due, today, now) : moneyHidden(b) ? "" : "No due date";
    return { state, tone: "neutral", text: "Not paid yet", note, noteTone: due ? dueTone(due, today) : "neutral", zero: false };
  }
  if (state === "marked") {
    if (amount === 0) {
      return { state, tone: "danger", text: "A $0 payment is not a real payment. Undo it.", note: "", noteTone: "neutral", zero: true };
    }
    const link = b.bank_linked === "partial" ? "only part of it is linked to the bank" : "not linked to the bank";
    const day = (b.paid_at || "").trim() ? `Marked on ${fmtDayLabel(b.paid_at, now)}` : "";
    const how = (b.paid_method || "").trim() ? `by ${paidMethodWord(b.paid_method)}` : "";
    return {
      state, tone: "warning", note: [day, how].filter(Boolean).join(" "), noteTone: "neutral", zero: false,
      text: amount == null ? `Marked paid, ${link}` : `Marked paid ${fmtAmount(amount)}, ${link}`,
    };
  }
  if (state === "part") {
    const rate = b.quoted_cost ?? null;
    const due = (b.pay_due_date || "").trim();
    return {
      state, tone: "warning", zero: false,
      text: `${amount == null ? "Paid" : `Paid ${fmtAmount(amount)}`}${rate != null ? ` of ${fmtAmount(rate)}` : ""}, link the rest`,
      // R-533: the deal waits for the rest; if the carrier took less, the rate is what to change.
      note: due ? dueLabel(due, today, now) : "If the carrier took less, change the rate", noteTone: due ? dueTone(due, today) : "neutral",
    };
  }
  const bits = [amount == null ? "Paid" : `Paid ${fmtAmount(amount)}`];
  if ((b.paid_at || "").trim()) bits.push(`on ${fmtDayLabel(b.paid_at, now)}`);
  if ((b.paid_method || "").trim()) bits.push(`by ${paidMethodWord(b.paid_method)}`);
  const ref = (b.paid_note || "").trim();
  return { state, tone: "success", text: bits.join(" "), note: ["Linked to the bank", ref ? `Reference ${ref}` : ""].filter(Boolean).join(" · "), noteTone: "success", zero: false };
}

// ─── days and times ───────────────────────────────────────────────────────

/** A bare YYYY-MM-DD as "Oct 2" (the year only when it is not `now`'s). Local, never UTC. */
export function fmtDayLabel(s: string | null | undefined, now: Date = new Date()): string {
  const v = (s || "").slice(0, 10);
  if (!v) return "";
  const d = parseLocalDay(v);
  if (isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "HH:MM" on a 24 hour clock, or empty. The wall clock as typed, no time zone. */
export const isTime = (v: string): boolean => v === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** "14:30" as "2:30 pm". Anything that is not a time comes back as it was. */
export function timeWord(v: string | null | undefined): string {
  const t = (v || "").trim();
  if (!t || !isTime(t)) return t;
  const h = Number(t.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${t.slice(3)} ${h < 12 ? "am" : "pm"}`;
}

/** R-524: a time typed in 24-hour time ("1430", "930", "14:30", "7") or with am or pm ("2:30 pm", "230p"), as "HH:MM";
 *  "" for an empty box and null for anything that is not a time. The website's lgMilTime follows the same rules. */
export function milTime(s: string): string | null {
  const t = (s || "").toLowerCase().replace(/[\s.]/g, "");
  if (!t) return "";
  const ap = /^(\d{1,2})(?::?(\d{2}))?([ap])m?$/.exec(t);
  const m = ap || /^(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap[3] === "p" ? 12 : 0); }
  else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** R-524: whether this person types load times in 24-hour time. R-538: the choice is kept on the person's account
 *  (time24.ts reads and saves it); until the server has answered, this device's cache decides. */
export const TIME24_KEY = "ec_time24";
let time24Account: boolean | null = null;
export function time24On(): boolean {
  if (time24Account !== null) return time24Account;
  try { return localStorage.getItem(TIME24_KEY) === "1"; } catch { return false; }
}
/** R-538: what the server says (null: not known yet). Kept on the device too, as the cache. */
export function setTime24Account(v: boolean | null): void {
  time24Account = v;
  if (v !== null) { try { localStorage.setItem(TIME24_KEY, v ? "1" : "0"); } catch { /* the cache is a convenience */ } }
}

/** R-538: a time window typed as "0800-1200" or "1400" reads back as "8:00 am to 12:00 pm" or "2:00 pm" for a person
 *  set to 24-hour time; anything else ("before 4 pm", "8am to noon") is null and stays as typed. The website's
 *  lgMilWindow follows the same rules. */
export function milWindow(s: string): string | null {
  const raw = (s || "").trim();
  if (!raw) return "";
  // A side reads as a time only when it cannot be a bare hour: 3 or 4 digits (0800), a colon (8:00), or am or pm. So
  // "9-5" and "8 to 12" stay as typed; they are not 9 am to 5 am. A window must end after it starts.
  const clear = (x: string) => /^\d{3,4}$/.test(x.trim()) || /:/.test(x) || /[ap]\.?m?\.?$/i.test(x.trim());
  const one = (x: string) => (clear(x) ? milTime(x) : null);
  const m = /^(.+?)\s*(?:-|–|\bto\b)\s*(.+)$/i.exec(raw);
  if (m) {
    const a = one(m[1]), b = one(m[2]);
    return a && b && b > a ? `${timeWord(a)} to ${timeWord(b)}` : null;
  }
  const a = one(raw);
  return a ? timeWord(a) : null;
}

/** A day and a time as people say them: "Oct 2, 2:30 pm". Either may be missing. */
export const dayAndTime = (day: string | null | undefined, time: string | null | undefined, now?: Date): string =>
  [fmtDayLabel(day, now), timeWord(time)].filter(Boolean).join(", ");

export const addDays = (day: string, n: number): string => {
  const d = parseLocalDay(day);
  d.setDate(d.getDate() + n);
  return localDay(d);
};

/** Whole days from `today` to `day` (negative once past). null when `day` is not a day. */
export function daysUntil(day: string, today: string): number | null {
  const a = parseLocalDay((day || "").slice(0, 10)), b = parseLocalDay(today);
  if (!(day || "").trim() || isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/** When a carrier has to be paid, as every screen says it: Due today, Overdue since Oct 3, Due Oct 10, No due date. */
export function dueLabel(due: string | null | undefined, today: string, now?: Date): string {
  const d = (due || "").trim().slice(0, 10);
  const n = d ? daysUntil(d, today) : null;
  if (n === null) return "No due date";
  if (n === 0) return "Due today";
  if (n < 0) return `Overdue since ${fmtDayLabel(d, now)}`;
  return `Due ${fmtDayLabel(d, now)}`;
}

/** The tone of a due label: red once overdue or due today, amber within a week, quiet otherwise. */
export function dueTone(due: string | null | undefined, today: string): "danger" | "warning" | "neutral" {
  const n = daysUntil((due || "").trim(), today);
  if (n === null) return "neutral";
  if (n <= 0) return "danger";
  return n <= 7 ? "warning" : "neutral";
}

// ─── how the actual dates move the status (contract section 1) ────────────

export interface Actuals { delivered_at: string; delivered_time: string; picked_up_at: string; picked_up_time: string }

/** A person picks a status by hand. R-502: it never makes a day up (it used to fill today, which stamped a load that
 *  was logged afterwards with the day it was typed in); the form asks for the day when a status needs one. Back from
 *  Delivered, the delivery day and time clear; back to To book or Booked, the pickup day and time clear as well
 *  (the server clears them the same way). Anything else leaves them. */
export function pickStatus(cur: Actuals, to: FreightStatus): Actuals & { status: FreightStatus } {
  const out = { ...cur, status: to };
  if (to === "picked_up") { out.delivered_at = ""; out.delivered_time = ""; }
  else if (to === "requested" || to === "booked") { out.picked_up_at = ""; out.picked_up_time = ""; out.delivered_at = ""; out.delivered_time = ""; }
  return out;
}

/** R-502: the days a pick of `to` has to ask for, on a load that is `from` now. Only a move forward asks. On the way
 *  needs the day it was picked up (unless it has one); Delivered always needs the day it was delivered, and the pickup
 *  day too when the load has not been on the way yet and has none (a load already on the way passed that step). */
export function daysToAsk(from: string, to: string, cur: Pick<Actuals, "picked_up_at">): { pickup: boolean; delivery: boolean } {
  const f = statusRank(from), t = statusRank(to);
  return {
    pickup: t > f && t >= statusRank("picked_up") && f < statusRank("picked_up") && !cur.picked_up_at.trim(),
    delivery: t > f && t === statusRank("delivered"),
  };
}

/** R-502: the load's appointment day as the first answer for an actual day, only once it has come: a day ahead has not
 *  happened. */
export function pastDay(day: string | null | undefined, today: string): string {
  const d = (day || "").slice(0, 10);
  return d && d <= today ? d : "";
}

/** R-502: the question to ask before a pick that takes days away or cancels a load that was booked, or "" when there
 *  is nothing to ask. Back to an earlier live status names the days it clears (the same ones `pickStatus` clears).
 *  Cancelling leaves the days where they are, so it only says what the load already did. */
export function moveBackAsk(from: string, to: string, cur: Actuals, now?: Date): string {
  const f = statusRank(from), t = statusRank(to);
  if (to === "cancelled") {
    if (f < statusRank("booked")) return "";
    const did = [
      cur.picked_up_at.trim() && `picked up ${fmtDayLabel(cur.picked_up_at, now)}`,
      cur.delivered_at.trim() && `delivered ${fmtDayLabel(cur.delivered_at, now)}`,
    ].filter(Boolean).join(" and ");
    return did ? `Cancel this load? It was ${did}.` : "Cancel this load?";
  }
  if (f < statusRank("picked_up") || t < statusRank("requested") || t >= f) return "";
  const next = pickStatus(cur, to as FreightStatus);
  const clears = [
    cur.picked_up_at.trim() && !next.picked_up_at && `the pickup day ${fmtDayLabel(cur.picked_up_at, now)}`,
    cur.delivered_at.trim() && !next.delivered_at && `the delivery day ${fmtDayLabel(cur.delivered_at, now)}`,
  ].filter(Boolean);
  return clears.length ? `Move this load back? This clears ${clears.join(" and ")}.` : "";
}

/** R-502: the sentences the server still refuses a save with on the actual days (clienthub-api routes/logistics.rs
 *  `actual_day_gap`), word for word. R-506: it no longer refuses a step for a missing carrier or a missing day, so those
 *  sentences and the checks that mirrored them are gone. */
export const GAP_PICKUP_AFTER_TODAY = "The pickup day cannot be after today.";
export const GAP_DELIVERY_AFTER_TODAY = "The delivery day cannot be after today.";
export const GAP_DELIVERY_BEFORE_PICKUP = "The delivery day cannot be before the pickup day.";
/** R-506: what any editor is told on a load that is still at the quote stage and has an actual day typed on it. The
 *  server refuses a day there; the days are asked for when On the way or Delivered is picked, so the two day boxes stay shut. */
export const QUOTE_STAGE_DAYS = "Pick On the way or Delivered in Status to log a load that already moved. It asks for the days.";

/** R-506: a load whose saved status is still at the quote stage: a quote, a quoted load, or a cancelled load that never
 *  went to book (no booked day, never sent to book). Moving it past the quote stage is the move the booking gate judges. */
export const atQuoteStage = (b: { status: string; booked_at?: string; sent_to_book_at?: string }): boolean =>
  isQuoteStage(b.status) || (b.status === "cancelled" && !(b.booked_at ?? "").trim() && !(b.sent_to_book_at ?? "").trim());

/** What skipping each booking-gate item reads as, in plain words (the keys are `bookGate`'s). */
const SKIPPED_WORDS: Record<GateKey, string> = {
  quote: "no quote yet", charge: "shipping not on the invoice yet", sent: "invoice not sent", paid: "customer not paid",
};

/** R-506: the question to ask once before a quote-stage load is moved past the quote stage to `to`, naming what the move
 *  skips (`missing`: the booking gate's missing items). "" when nothing is skipped, so nothing is asked. On the way and
 *  Delivered log a load that already moved; To book and Booked are booking it anyway. A Logistics-only person is told the
 *  team will see it. */
export function skipAsk(to: string, missing: GateKey[], logisticsOnly: boolean): string {
  if (!missing.length) return "";
  const lead = statusRank(to) >= statusRank("picked_up") ? "Log this load as already moving?" : "Book anyway?";
  // A Logistics-only person cannot see the invoice or the payment (they read as not done), so he is not told they are skipped.
  if (logisticsOnly) return `${lead} Your team will see you logged it.`;
  return `${lead} This skips: ${missing.map((k) => SKIPPED_WORDS[k]).join(", ")}.`;
}

/** R-502: the server's day checks on the days a save writes: not after `today`, and a delivery not before its pickup.
 *  The sentence, or "" when the days are fine. A day that is empty is not judged. */
export function actualDayGap(days: { picked_up_at: string; delivered_at: string }, today: string): string {
  const p = days.picked_up_at.trim(), d = days.delivered_at.trim();
  if (p && p > today) return GAP_PICKUP_AFTER_TODAY;
  if (d && d > today) return GAP_DELIVERY_AFTER_TODAY;
  if (p && d && d < p) return GAP_DELIVERY_BEFORE_PICKUP;
  return "";
}

/** R-502: the step a refusal sentence points at, so a failed save lands on the box to fix: the carrier on Book, the
 *  pickup day on Pickup, the delivery day on Delivery, an address on Quote when the person may edit addresses there,
 *  else on Book. undefined leaves the person where they are (the quote-stage sentences). R-506: the sentence about a day
 *  on a load that stayed at the quote stage names "Delivered", so it is checked before the days. */
export function stepForRefusal(msg: string, addressOnQuote: boolean): LoadStep | undefined {
  const m = msg.toLowerCase();
  if (m.includes("send this load to book") || m.includes("in status to log a load")) return undefined;
  if (m.includes("book step") || m.includes("carrier")) return "book";
  if (m.includes("pickup step") || m.includes("picked up") || m.includes("pickup day cannot")) return "pickup";
  if (m.includes("delivery step") || m.includes("delivered") || m.includes("delivery day cannot")) return "delivery";
  if (/\baddress\b/.test(m)) return addressOnQuote ? "quote" : "book";
  return undefined;
}

/** The pickup-number check to send with a save, or undefined to leave it as it is. A changed number clears the
 *  check on the server, so a box ticked again after the number changed is a re-confirmation and is sent even
 *  though it was ticked before. */
export function confirmToSend(numberChanged: boolean, was: boolean, now: boolean): boolean | undefined {
  if (numberChanged && now) return true;
  return now !== was ? now : undefined;
}

/** Whether a status may be picked on a load that is `from` now. The team (deal_flow:edit) may pick any.
 *  Without it the server refuses `quote` always and `quoted` unless the load is a quote already. R-506: a quote or
 *  quoted load may be moved on to To book, Booked, On the way or Delivered by a Logistics-only person too (the form asks
 *  what that skips and the save says so with `override`); only Cancelled stays shut to him while the load is a quote.
 *  The current status is always listed. */
export function statusAllowed(to: FreightStatus, from: string, dealEdit: boolean, mayBook = true): boolean {
  if (dealEdit || to === from) return true;
  if (to === "quote") return false;
  if (to === "quoted") return isQuoteStage(from);
  if (to === "cancelled") return !isQuoteStage(from);
  // R-521: past the quote stage only while the owner lets logistics book a load the team has not sent (the server's rule).
  if (isQuoteStage(from)) return mayBook;
  return true;
}

/** A person fills in an actual day. The pickup day moves To book or Booked to On the way, and the
 *  delivered day moves anything but Cancelled to Delivered, the way the server reads them. Clearing a day
 *  steps back: no delivered day on a delivered load is On the way (or Booked when nothing left yet), and no
 *  pickup day on an On the way load is Booked. `pickedUpAt` is the pickup day as it stands. */
export function statusAfterActual(status: FreightStatus, field: "picked_up_at" | "delivered_at", value: string, pickedUpAt = ""): FreightStatus {
  if (!value) {
    if (field === "delivered_at" && status === "delivered") return pickedUpAt ? "picked_up" : "booked";
    if (field === "picked_up_at" && status === "picked_up") return "booked";
    return status;
  }
  if (field === "picked_up_at") return status === "requested" || status === "booked" ? "picked_up" : status;
  return status !== "delivered" && status !== "cancelled" ? "delivered" : status;
}

// ─── the stepper (contract section 10) ────────────────────────────────────

export type LoadStep = "quote" | "book" | "pickup" | "delivery" | "pay";
export const LOAD_STEPS: { key: LoadStep; label: string }[] = [
  { key: "quote", label: "Quote" }, { key: "book", label: "Book" }, { key: "pickup", label: "Pickup" },
  { key: "delivery", label: "Delivery" }, { key: "pay", label: "Pay" },
];

/** The step a load opens on. */
export function firstStep(status: string): LoadStep {
  switch (status) {
    case "requested": return "book";
    case "booked": return "pickup";
    case "picked_up": return "delivery";
    case "delivered": return "pay";
    default: return "quote";
  }
}

export interface StepFacts {
  status: string; carrier: string; picked_up_at: string; delivered_at: string;
  paid_amount: number | null | undefined; paperwork: Paperwork;
  /** R-470: Pay is done only when the bank payment is linked. */
  paid_state?: string | null; bank_linked?: string | null;
}

/** The done dots. Quote is done once it is quoted, or the load skipped quoting. */
export function stepDone(f: StepFacts): Record<LoadStep, boolean> {
  const rank = statusRank(f.status);
  return {
    quote: rank >= statusRank("quoted"),
    book: rank >= statusRank("booked") && f.carrier.trim() !== "",
    pickup: f.picked_up_at.trim() !== "",
    delivery: f.delivered_at.trim() !== "",
    pay: paidStateOf(f) === "paid" && f.paperwork.bol && f.paperwork.pod && f.paperwork.carrier_invoice,
  };
}

// ─── the check and balance (contract section 10) ──────────────────────────

export const stopsOf = (b: { extra_pickups?: FreightStop[] }): FreightStop[] => (Array.isArray(b.extra_pickups) ? b.extra_pickups : []);

/** A booked load that picks up today or tomorrow and whose pickup number is not confirmed with the
 *  warehouse. The first pickup always needs it. A later stop needs it once it has a pickup number. */
export function pickupNumberUnconfirmed(
  b: { status: string; pickup_date: string; pickup_number_confirmed_at?: string; extra_pickups?: FreightStop[] },
  today: string,
): boolean {
  if (b.status !== "booked") return false;
  const day = (b.pickup_date || "").slice(0, 10);
  if (!day || (day !== today && day !== addDays(today, 1))) return false;
  if (!(b.pickup_number_confirmed_at || "").trim()) return true;
  return stopsOf(b).some((x) => (x.pickup_number || "").trim() !== "" && !x.confirmed);
}

// ─── the list (contract section 10) ───────────────────────────────────────

export type GroupKey = "urgent" | "quotes" | "quoted" | "requested" | "booked" | "way" | "paperwork" | "topay" | "delivered";
/** R-476: created in the last 24 hours and not cancelled, for New today at the top of the list. */
export const isNewToday = (b: { created_at: string; status: string }, now: number = Date.now()): boolean => {
  const t = Date.parse(b.created_at);
  return !Number.isNaN(t) && now - t < 86_400_000 && b.status !== "cancelled";
};

/** R-476: the first word of the account's name, for "Hello, Robin". Blank when the account has no name. */
export const firstName = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0] ?? "";

/** Urgent and not picked up yet. Once the truck has the load it is no longer ahead of anything, and a
 *  quoted load is with the team (the phone and the server list it the same way). */
export const isHot = (b: { urgent?: boolean; status: string }): boolean =>
  !!b.urgent && (b.status === "quote" || b.status === "requested" || b.status === "booked");

/** Picked up or delivered and the carrier is still owed: nothing linked to a bank payment yet, or only part of the rate. A
 *  marked payment (typed before R-470) waits in Pay carriers to be linked, so it is not this pill. A figure the server
 *  withheld is hidden, not missing. (The deal side still asks for it; the logistics list no longer does.) */
export const needsAmount = (b: { status: string; paid_amount: number | null; paid_state?: string | null; bank_linked?: string | null; can_see_money?: boolean }): boolean =>
  !moneyHidden(b) && (b.status === "picked_up" || b.status === "delivered") && (paidStateOf(b) === "unpaid" || paidStateOf(b) === "part");

/** What a delivered load still lacks before the carrier can be paid: the proof of delivery, the
 *  carrier's invoice and the carrier rate. */
export function missingPaperwork(b: { paperwork?: Paperwork; files?: FreightFile[]; quoted_cost: number | null; can_see_money?: boolean }): string[] {
  const p = paperworkOf(b);
  const out: string[] = [];
  if (!p.pod) out.push("Proof of delivery");
  if (!p.carrier_invoice) out.push("Carrier invoice");
  if (rateMissing(b)) out.push("Carrier rate");
  return out;
}

type Groupable = Parameters<typeof isHot>[0] & Parameters<typeof missingPaperwork>[0] & { paid_amount: number | null; paid_state?: string | null; bank_linked?: string | null };

export function groupOf(b: Groupable): GroupKey | null {
  if (b.status === "cancelled") return null;
  if (isHot(b)) return "urgent";
  switch (b.status) {
    case "quote": return "quotes";
    case "quoted": return "quoted";
    case "requested": return "requested";
    case "booked": return "booked";
    case "picked_up": return "way";
    default:
      if (missingPaperwork(b).length > 0) return "paperwork";
      // Carrier to be paid holds the loads still owed (nothing linked, or only part). A marked load waits in Pay carriers'
      // "Link the bank payment" group, not here.
      if ((paidStateOf(b) === "unpaid" || paidStateOf(b) === "part") && !moneyHidden(b)) return "topay";
      return "delivered";
  }
}

// ─── the board (R-525) ────────────────────────────────────────────────────

/** R-525: where a load sits on the board: its box and its colour inside the box. Jack: "everything moves on a left to
 *  right basis". Box 1 holds the quote, the team's part and booking; box 2 booked and waiting on pickup, then on the way;
 *  box 3 delivered and waiting on the paperwork, then (R-538) waiting for payment once the carrier invoice is attached
 *  ("a color change once the invoice is attatched"). What is finished comes from the server, which keeps a delivered load
 *  on the open list until its carrier is paid in full or its deal is complete. A cancelled load is null. The website's
 *  lgBoardKey follows the same rules. */
export type BoardKey = "quote" | "team" | "book" | "pickup" | "moving" | "paper" | "pay";
export function boardKey(b: Groupable): BoardKey | null {
  switch (b.status) {
    case "quote": return "quote";
    case "quoted": return "team";
    case "requested": return "book";
    case "booked": return "pickup";
    case "picked_up": return "moving";
    case "delivered": return paperworkOf(b).carrier_invoice ? "pay" : "paper";
    default: return null;
  }
}
/** R-538: what a waiting-for-payment load still lacks besides the carrier invoice: shown as a tag on its card. */
export function boardNeeds(b: Groupable): string[] {
  if (boardKey(b) !== "pay") return [];
  const p = paperworkOf(b);
  return [!p.pod && "proof of delivery", rateMissing(b) && "carrier rate"].filter((x): x is string => !!x);
}
export const BOARD: { n: number; title: string; keys: BoardKey[] }[] = [
  { n: 1, title: "Quote and book", keys: ["quote", "team", "book"] },
  { n: 2, title: "Booked and on the road", keys: ["pickup", "moving"] },
  { n: 3, title: "Delivered", keys: ["paper", "pay"] },
];
export const BOARD_WORD: Record<BoardKey, string> = {
  quote: "Quote needed", team: "With the team", book: "Ready to book", pickup: "Waiting on pickup", moving: "On the way",
  paper: "Waiting on paperwork", pay: "Waiting for payment",
};
const BOARD_ORDER: BoardKey[] = ["quote", "team", "book", "pickup", "moving", "paper", "pay"];
/** The day a card is sorted by: the pickup until it is picked up, then the delivery, then the day it was delivered. */
const boardDay = (b: { status: string; pickup_date?: string; delivery_date?: string; delivered_at?: string }): string =>
  ((b.status === "picked_up" ? b.delivery_date : b.status === "delivered" ? b.delivered_at : b.pickup_date) || "9999").slice(0, 10);
/** Inside a box: urgent first, then in the order of the box's colours, then by day. */
export function boardSort(a: Groupable & { pickup_date?: string; delivery_date?: string; delivered_at?: string }, b: Groupable & { pickup_date?: string; delivery_date?: string; delivered_at?: string }): number {
  const ka = boardKey(a), kb = boardKey(b);
  return Number(isHot(b)) - Number(isHot(a))
    || (ka ? BOARD_ORDER.indexOf(ka) : 99) - (kb ? BOARD_ORDER.indexOf(kb) : 99)
    || boardDay(a).localeCompare(boardDay(b));
}

/** R-483: the Dashboard's two groups. Waiting on shipping is a booked or picked-up load; waiting to pay the carrier is a
 *  delivered load whose carrier is not paid (not linked, part linked, or only marked). A figure the server withheld
 *  says nothing either way, so that load stays out. */
export function dashboardLoads<T extends Groupable & { status: string; delivery_date?: string; delivered_at?: string }>(
  list: T[], today: string = localDay(),
): { arriving: T[]; shipping: T[]; carrier: T[] } {
  // R-487: Arriving today comes first and claims its loads, so a load shows once (R-480).
  const arriving = list.filter((b) => arrivesToday(b, today));
  const rest = list.filter((b) => !arrivesToday(b, today));
  const shipping = rest.filter((b) => b.status === "booked" || b.status === "picked_up");
  const owed = (b: T) => { const st = paidStateOf(b); return st === "unpaid" || st === "part" || st === "marked"; };
  const carrier = rest.filter((b) => b.status === "delivered" && !moneyHidden(b) && owed(b));
  return { arriving, shipping, carrier };
}

/** R-487: delivered today, or booked or on the way with its delivery expected today (the delivery day the load's
 *  updates keep current). */
export function arrivesToday(b: { status: string; delivery_date?: string; delivered_at?: string }, today: string): boolean {
  if (b.status === "delivered") return (b.delivered_at || "").slice(0, 10) === today;
  return (b.status === "booked" || b.status === "picked_up") && (b.delivery_date || "").slice(0, 10) === today;
}

/** R-487: the Logistics delivery chart. Each of the next `n` days from today holds the loads expected to deliver that
 *  day, booked or on the way; today also holds what was delivered today. `late` is a booked or moving load whose
 *  delivery day has passed; `undated` counts the ones with no delivery day yet. */
export interface DeliveryDay<T> { day: string; booked: T[]; way: T[]; delivered: T[] }
export function deliveryDays<T extends { status: string; delivery_date?: string; delivered_at?: string }>(
  list: T[], today: string, n = 14,
): { days: DeliveryDay<T>[]; late: T[]; undated: number } {
  const moving = list.filter((b) => b.status === "booked" || b.status === "picked_up");
  const dayOf = (b: T) => (b.delivery_date || "").slice(0, 10);
  const days: DeliveryDay<T>[] = [];
  const d0 = parseLocalDay(today);
  for (let i = 0; i < n; i++) {
    const day = localDay(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i));
    days.push({
      day,
      booked: moving.filter((b) => b.status === "booked" && dayOf(b) === day),
      way: moving.filter((b) => b.status === "picked_up" && dayOf(b) === day),
      delivered: i === 0 ? list.filter((b) => b.status === "delivered" && (b.delivered_at || "").slice(0, 10) === today) : [],
    });
  }
  return {
    days,
    late: moving.filter((b) => dayOf(b) !== "" && dayOf(b) < today),
    undated: moving.filter((b) => dayOf(b) === "").length,
  };
}

/** Everything a person could type in the list's search box, of what this viewer can see. */
export function loadHaystack(b: FreightBooking): string {
  return [
    b.load_number, b.code, b.bol, b.pro, b.pickup_number, b.reference, b.carrier, b.broker, b.equipment,
    b.pickup_name, b.delivery_name, b.pickup_address, b.delivery_address, b.request_note,
    b.deal?.invoice_number, b.deal?.client_name,
    ...stopsOf(b).flatMap((x) => [x.name, x.address, x.pickup_number]),
  ].filter(Boolean).join(" ").toLowerCase();
}

// ─── the lane (contract section 6) ────────────────────────────────────────

/** The (city, state) of a free-text address, read the way the website's lgCityState reads it: newlines are commas, a
 *  trailing ZIP or country (USA, United States) segment is dropped, a ZIP after the state is dropped, and the state
 *  is a code or a full name ("TX", "Texas"). The comma segment before the state is the city; "Dallas TX" with no
 *  comma reads too. */
export function laneOf(address: string): { city: string; state: string } | null {
  const parts = (address || "").replace(/\s*[\r\n]+\s*/g, ", ").split(",").map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && /^(\d{5}(-\d{4})?|usa?|united states( of america)?)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return null;
  const end = parseLocation(parts[parts.length - 1].replace(/[\s,]*\d{5}(-\d{4})?$/, ""));
  if (!end.state) return null;
  return { city: end.city || (parts.length > 1 ? parts[parts.length - 2] : ""), state: end.state };
}

/** "Dallas, TX to Newark, NJ". One end alone reads as that end, none reads as empty. */
export function laneLabel(pickupAddress: string, deliveryAddress: string): string {
  const fmt = (a: string) => { const l = laneOf(a); return l ? formatLocation(l.city, l.state) : ""; };
  const from = fmt(pickupAddress), to = fmt(deliveryAddress);
  return from && to ? `${from} to ${to}` : from || to;
}

/** R-478: the line under a load in the list, "From Dallas, TX to Newark, NJ". A pickup with more behind it reads
 *  "From Dallas, TX + 2 more to Newark, NJ". A place that does not read as a city and state stays as typed, on one
 *  line; an empty side reads "-"; nothing at all gives no line. Addresses only: a viewer without the address switch
 *  gets no line (names have their own switch, and the route above already shows them). */
export function rowLane(b: { pickup_address: string; delivery_address: string; can_see_addresses: boolean; extra_pickups?: FreightStop[] }): string {
  const { from, to, more } = laneEnds(b);
  if (!from && !to) return "";
  return `From ${from || "-"}${more > 0 ? ` + ${more} more` : ""} to ${to || "-"}`;
}

/** The two ends of rowLane's line, for the Dashboard's cards (R-484): "" for a side the viewer may not see. */
export function laneEnds(b: { pickup_address: string; delivery_address: string; can_see_addresses: boolean; extra_pickups?: FreightStop[] }): { from: string; to: string; more: number } {
  if (!b.can_see_addresses) return { from: "", to: "", more: 0 };
  const place = (a: string) => {
    const l = laneOf(a);
    return l ? formatLocation(l.city, l.state) : (a || "").replace(/\s*[\r\n]+\s*/g, ", ").replace(/\s+/g, " ").trim();
  };
  return { from: place(b.pickup_address), to: place(b.delivery_address), more: stopsOf(b).length };
}

/** R-484 round 2: one Dashboard card. The colour says the state: teal while the load ships (booked, on the way,
 *  arriving today), green the carrier is owed, red the carrier is due today or overdue (R-507, 2026-10-13: Jack's pick,
 *  the teal of a load on its way). `step` is how far along the three steps the load is. */
export type CardTone = "green" | "teal" | "red";
export interface LoadCard { tone: CardTone; label: string; sub: string; steps: [string, string, string]; step: 1 | 2 | 3 }
export function loadCard(b: Groupable & { status: string; pay_due_date?: string | null; delivery_date?: string; delivered_at?: string }, today: string): LoadCard {
  // R-487: a load arriving today leads, full track once it is delivered.
  if (arrivesToday(b, today)) {
    const done = b.status === "delivered";
    return { tone: "teal", label: done ? "Delivered today" : "Arriving today", sub: "", steps: ["Booked", "Picked up", "Delivered"], step: done ? 3 : b.status === "picked_up" ? 2 : 1 };
  }
  if (b.status === "booked" || b.status === "picked_up") {
    const moving = b.status === "picked_up";
    return { tone: "teal", label: moving ? "On the way" : "Booked", sub: "", steps: ["Booked", "Picked up", "Delivered"], step: moving ? 2 : 1 };
  }
  const steps: [string, string, string] = ["Delivered", "Paperwork", "Paid"];
  const missing = missingPaperwork(b);
  if (missing.length > 0) return { tone: "green", label: "Needs paperwork", sub: `Needs ${missing.join(", ").toLowerCase()}`, steps, step: 1 };
  const due = b.pay_due_date || "";
  const late = dueTone(due, today) === "danger";
  const st = paidStateOf(b);
  const label = st === "marked" ? "Link the payment" : st === "part" ? "Part paid" : late ? (daysUntil(due, today) === 0 ? "Due today" : "Overdue") : "Ready to pay";
  return { tone: late ? "red" : "green", label, sub: dueLabel(due, today), steps, step: 2 };
}

// ─── quote to invoice to book (contract section 7) ────────────────────────

export const QUOTE_WAITING_WARNING = "Shipping on this invoice is still waiting on the logistics quote. Send anyway?";
export const PAID_BANNER = "Customer paid. Send the booking to logistics.";

/** True when the deal's shipping is still waiting on a quote: a load in `quote`, or one in `quoted`
 *  whose quote has not been put on the invoice and is not marked "we pay it ourselves". The send-invoice
 *  warning asks about it. */
export function quoteWaitingOnInvoice(bookings: { status: string; quote_invoiced_at?: string; shipping_charge?: string }[]): boolean {
  return bookings.some((b) => b.status === "quote" || (b.status === "quoted" && !(b.quote_invoiced_at || "").trim() && b.shipping_charge !== "own"));
}

/** Whether the customer has paid: the screen that knows the deal says so (`known`), else the server's flag on the load. */
export const dealPaid = (b: { deal_paid?: boolean }, known?: boolean): boolean => (known !== undefined ? known : !!b.deal_paid);
