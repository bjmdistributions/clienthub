// R-459: the load (a freight booking) as a flow. Everything here takes values and returns
// values, so the rules are tested without a screen: the status model and its labels, the
// stepper (first step, done dots), how the actual dates move the status, the list groups, the
// due labels, the lane, the equipment list and the send-invoice warning. The phone carries the
// same rules in www/app.js, so a change here is a change there.

import type { FreightBooking, FreightFile, FreightFileKind, FreightStatus, FreightStop, PaidState } from "./api";
import { fmtAmount, localDay, parseLocalDay } from "./format";
import { formatLocation, parseLocation } from "./location";

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
      note: due ? dueLabel(due, today, now) : "", noteTone: due ? dueTone(due, today) : "neutral",
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

export interface Actuals { delivered_at: string; picked_up_at: string; picked_up_time: string }

/** A person picks a status by hand. Delivered asks for the day it landed, and today is the usual
 *  answer. On the way asks for the day it left. Back to To book or Booked, nothing has been picked up
 *  or delivered, so those days clear (the server clears them the same way). Anything else leaves them. */
export function pickStatus(cur: Actuals, to: FreightStatus, today: string): Actuals & { status: FreightStatus } {
  const out = { ...cur, status: to };
  if (to === "delivered") out.delivered_at = cur.delivered_at || today;
  else if (to === "picked_up") { out.picked_up_at = cur.picked_up_at || today; out.delivered_at = ""; }
  else if (to === "requested" || to === "booked") { out.picked_up_at = ""; out.picked_up_time = ""; out.delivered_at = ""; }
  return out;
}

/** The pickup-number check to send with a save, or undefined to leave it as it is. A changed number clears the
 *  check on the server, so a box ticked again after the number changed is a re-confirmation and is sent even
 *  though it was ticked before. */
export function confirmToSend(numberChanged: boolean, was: boolean, now: boolean): boolean | undefined {
  if (numberChanged && now) return true;
  return now !== was ? now : undefined;
}

/** Whether a status may be picked on a load that is `from` now. The team (deal_flow:edit) may pick any.
 *  Without it the server refuses `quote` always, `quoted` unless the load is a quote already, and every
 *  other status while the load is a quote or quoted (the team sends it to book). The current status is
 *  always listed. */
export function statusAllowed(to: FreightStatus, from: string, dealEdit: boolean): boolean {
  if (dealEdit || to === from) return true;
  if (to === "quote") return false;
  if (to === "quoted") return isQuoteStage(from);
  return !isQuoteStage(from);
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

export const GROUPS: { key: GroupKey; title: string }[] = [
  { key: "urgent", title: "Urgent" },
  { key: "quotes", title: "Quotes to give" },
  { key: "quoted", title: "Quoted, with the team" },
  { key: "requested", title: "To book" },
  { key: "booked", title: "Booked" },
  { key: "way", title: "On the way" },
  { key: "paperwork", title: "Needs paperwork" },
  { key: "topay", title: "Carrier to be paid" },
  { key: "delivered", title: "Delivered" },
];

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
  if (!b.can_see_addresses) return "";
  const place = (a: string) => {
    const l = laneOf(a);
    return l ? formatLocation(l.city, l.state) : (a || "").replace(/\s*[\r\n]+\s*/g, ", ").replace(/\s+/g, " ").trim();
  };
  const from = place(b.pickup_address), to = place(b.delivery_address);
  if (!from && !to) return "";
  const more = stopsOf(b).length;
  return `From ${from || "-"}${more > 0 ? ` + ${more} more` : ""} to ${to || "-"}`;
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
