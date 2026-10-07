// R-459: the load (a freight booking) as a flow. Everything here takes values and returns
// values, so the rules are tested without a screen: the status model and its labels, the
// stepper (first step, done dots), how the actual dates move the status, the list groups, the
// due labels, the lane, the equipment list and the send-invoice warning. The phone carries the
// same rules in www/app.js, so a change here is a change there.

import type { FreightBooking, FreightFile, FreightFileKind, FreightStatus, FreightStop } from "./api";
import { fmtAmount, localDay, parseLocalDay } from "./format";
import { formatLocation, isStateCode, parseLocation } from "./location";

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

export const BANK_LINK_WORD: Record<string, string> = {
  linked: "Linked to the bank", partial: "Partly linked to the bank", none: "Not linked to the bank",
};

const PAID_METHOD_WORDS: Record<string, string> = {
  zelle: "Zelle", wire: "Wire", ach: "ACH", credit_card: "Credit card", check: "Check", other: "Other",
};

/** How a load was paid, as a word: a key an older phone build stored ("credit_card") reads as its label. */
export const paidMethodWord = (m: string | null | undefined): string => {
  const t = (m || "").trim();
  return PAID_METHOD_WORDS[t.toLowerCase()] ?? t;
};

/** "Paid $1,850.00 on Oct 6 by Zelle, ref 4471" or "Not paid yet". */
export function paymentLine(b: { paid_amount: number | null; paid_at: string; paid_method: string; paid_note: string }): string {
  if (b.paid_amount == null) return "Not paid yet";
  const bits = [`Paid ${fmtAmount(b.paid_amount)}`];
  if (b.paid_at) bits.push(`on ${fmtDayLabel(b.paid_at)}`);
  if (b.paid_method) bits.push(`by ${paidMethodWord(b.paid_method)}`);
  const head = bits.join(" ");
  return b.paid_note.trim() ? `${head}, ${b.paid_note.trim()}` : head;
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

const addDays = (day: string, n: number): string => {
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
}

/** The done dots. Quote is done once it is quoted, or the load skipped quoting. */
export function stepDone(f: StepFacts): Record<LoadStep, boolean> {
  const rank = statusRank(f.status);
  return {
    quote: rank >= statusRank("quoted"),
    book: rank >= statusRank("booked") && f.carrier.trim() !== "",
    pickup: f.picked_up_at.trim() !== "",
    delivery: f.delivered_at.trim() !== "",
    pay: f.paid_amount != null && f.paperwork.bol && f.paperwork.pod && f.paperwork.carrier_invoice,
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

/** Picked up or delivered and nobody has recorded what the carrier charged yet. A figure the server
 *  withheld is hidden, not missing. (The deal side still asks for it; the logistics list no longer does.) */
export const needsAmount = (b: { status: string; paid_amount: number | null; can_see_money?: boolean }): boolean =>
  !moneyHidden(b) && (b.status === "picked_up" || b.status === "delivered") && b.paid_amount == null;

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

type Groupable = Parameters<typeof isHot>[0] & Parameters<typeof missingPaperwork>[0] & { paid_amount: number | null };

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
      if (b.paid_amount == null && !moneyHidden(b)) return "topay";
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

/** The (city, state) of a free-text address: the last US two-letter state, optionally followed by a
 *  ZIP, and the comma segment before it as the city. Reads "Dallas TX" with no comma too. */
export function laneOf(address: string): { city: string; state: string } | null {
  const parts = (address || "").split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const m = /^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(last);
  if (m && isStateCode(m[1]) && parts.length >= 2) return { city: parts[parts.length - 2], state: m[1].toUpperCase() };
  const loose = parseLocation(address);
  return loose.state ? loose : null;
}

/** "Dallas, TX to Newark, NJ". One end alone reads as that end, none reads as empty. */
export function laneLabel(pickupAddress: string, deliveryAddress: string): string {
  const fmt = (a: string) => { const l = laneOf(a); return l ? formatLocation(l.city, l.state) : ""; };
  const from = fmt(pickupAddress), to = fmt(deliveryAddress);
  return from && to ? `${from} to ${to}` : from || to;
}

// ─── quote to invoice to book (contract section 7) ────────────────────────

export const QUOTE_WAITING_WARNING = "Shipping on this invoice is still waiting on the logistics quote. Send anyway?";
export const PAID_BANNER = "Customer paid. Send the booking to logistics.";
export const SEND_UNPAID_CONFIRM = "The customer has not paid yet. Send it to logistics to book anyway?";

/** True when the deal's shipping is still waiting on a quote: a load in `quote`, or one in `quoted`
 *  whose quote has not been put on the invoice. The send-invoice warning asks about it. */
export function quoteWaitingOnInvoice(bookings: { status: string; quote_invoiced_at?: string }[]): boolean {
  return bookings.some((b) => b.status === "quote" || (b.status === "quoted" && !(b.quote_invoiced_at || "").trim()));
}

/** Whether the customer has paid: the screen that knows the deal says so (`known`), else the server's flag on the load. */
export const dealPaid = (b: { deal_paid?: boolean }, known?: boolean): boolean => (known !== undefined ? known : !!b.deal_paid);
