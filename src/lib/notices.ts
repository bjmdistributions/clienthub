// R-460: notifications on the desktop. Two sources feed the bell and the operating-system alerts.
//   1. The team side (admins, anyone who sees deals or the books): the server's own notices of the six
//      kinds below, read through /api/notifications.
//   2. The Logistics-only side: that account cannot call /api/notifications, so its desktop works the
//      notices out of the bookings it already reads (a load newly in quote, newly to book, newly urgent).
// Everything here is plain logic with no screen, so what is new, what is raised once, and where a notice
// opens are all tested. The hook that polls (useNotices.ts) and the screens only call these.

import type { LeadNotification } from "./api";
import { daysBetween, shortDay } from "./billsFormat";
import { localDay } from "./format";
import { isHot, loadNumber, type LoadStep } from "./logisticsLoad";
import { can, canViewLogistics, isAdmin, isLogisticsOnly, type Perms } from "./permissions";
import { isRenewal } from "./renewals";

// ─── the team's notices ───────────────────────────────────────────────────

export const TEAM_NOTICE_KINDS = ["logistics_quote", "carrier_due", "carrier_overdue", "bill_due", "bill_overdue", "bill_paid", "logistics_pay_due"] as const;
export type TeamNoticeKind = (typeof TEAM_NOTICE_KINDS)[number];
export const isTeamNoticeKind = (k: string): k is TeamNoticeKind => (TEAM_NOTICE_KINDS as readonly string[]).includes(k);

/** R-464: the kinds only an admin sees. "Pay <payee> today" is raised on the morning of a logistics pay date
 *  and is the owner's to act on; the server hides it from everyone else and this list does too. */
export const ADMIN_NOTICE_KINDS = ["logistics_pay_due"] as const;
const isAdminKind = (k: string): boolean => (ADMIN_NOTICE_KINDS as readonly string[]).includes(k);

/** Who sees the bell with these notices: an admin (as always), or anyone who sees deals or the books. A
 *  Logistics-only account never does (it has its own bell, and the server refuses it these routes). */
export function canSeeTeamNotices(me: Perms | null | undefined): boolean {
  if (!me || isLogisticsOnly(me)) return false;
  return isAdmin(me) || can(me, "deal_flow:view") || can(me, "financials:view");
}

/** R-477: whether the server will answer /api/notifications for this person. The route sits behind the clients
 *  module, so a books-only or deals-only role (it sees the bell, per canSeeTeamNotices) is refused with a 403.
 *  That refusal is not a failed read; there is simply nothing to read. */
export function canReadTeamNotices(me: Perms | null | undefined): boolean {
  return isAdmin(me) || can(me, "clients:view");
}

/** The unread notices of the seven kinds, newest first. Anything else the server sends is not listed here, and
 *  the admin-only kinds are kept only for an admin (the default keeps them out). */
export function teamNoticesOf(list: readonly LeadNotification[] | null | undefined, admin = false): LeadNotification[] {
  return (list ?? [])
    .filter((n) => isTeamNoticeKind(n.kind) && n.status !== "acknowledged" && (admin || !isAdminKind(n.kind)))
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

/** R-477: the supplier leads and supplier details the server keeps with the notices. Admins only. */
export const LEAD_NOTICE_KINDS = ["supply_lead", "supplier_profile"] as const;
const isLeadNoticeKind = (k: string): boolean => (LEAD_NOTICE_KINDS as readonly string[]).includes(k);

/** The unread supplier leads and supplier details, newest first. Only an admin has them. */
export function leadNoticesOf(list: readonly LeadNotification[] | null | undefined, admin = false): LeadNotification[] {
  if (!admin) return [];
  return (list ?? [])
    .filter((n) => isLeadNoticeKind(n.kind) && n.status !== "acknowledged")
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

/** R-477: the server's notices that ask something of you. They count on the bell and are the only ones that
 *  raise an operating-system alert. A paid bill and a supplier's details only tell you something. */
export const NEEDS_YOU_NOTICE_KINDS = ["bill_due", "bill_overdue", "carrier_due", "carrier_overdue", "logistics_quote", "logistics_pay_due"] as const;
export const isNeedsYouKind = (k: string): boolean => (NEEDS_YOU_NOTICE_KINDS as readonly string[]).includes(k);

export type NoticeTarget =
  | { to: "load"; id: string; step: LoadStep }
  | { to: "logistics" }
  | { to: "bill"; id?: string }
  /** R-464: the logistics pay tracker (Settings, Team, Payouts), where a pay date is recorded. */
  | { to: "paytracker" };

const payloadOf = (n: Pick<LeadNotification, "payload_json">): Record<string, unknown> => {
  try {
    const o = n.payload_json ? JSON.parse(n.payload_json) : null;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
};
const idIn = (o: Record<string, unknown>, key: string): string => (typeof o[key] === "string" ? (o[key] as string).trim() : "");

/** Where Open goes. A quote notice opens its load on the Quote step, a carrier notice the load's Pay step,
 *  a bill notice the Bills screen (on the bill when the payload names one), a pay-day notice the logistics pay
 *  tracker. A notice whose payload names no load falls back to the screen that holds it. */
export function noticeTarget(n: Pick<LeadNotification, "kind" | "payload_json">): NoticeTarget | null {
  const p = payloadOf(n);
  const load = idIn(p, "booking_id");
  switch (n.kind) {
    case "logistics_quote":
      return load ? { to: "load", id: load, step: "quote" } : { to: "logistics" };
    case "carrier_due":
    case "carrier_overdue":
      return load ? { to: "load", id: load, step: "pay" } : { to: "bill" };
    case "bill_due":
    case "bill_overdue":
    case "bill_paid": {
      const bill = idIn(p, "bill_id");
      return bill ? { to: "bill", id: bill } : { to: "bill" };
    }
    case "logistics_pay_due":
      return { to: "paytracker" };
    default:
      return null;
  }
}

/** The words a notice's kind wears on the Notifications screen. */
export const NOTICE_KIND_LABEL: Record<TeamNoticeKind, string> = {
  logistics_quote: "Quote ready",
  carrier_due: "Carrier due",
  carrier_overdue: "Carrier overdue",
  bill_due: "Bill due",
  bill_overdue: "Bill overdue",
  bill_paid: "Bill paid",
  logistics_pay_due: "Pay day",
};

/** The Bills screen opens a bill from another screen the same stash-then-switch way Invoices does. */
export const BILL_OPEN_KEY = "bills_open_id";
/** R-464: Settings opens on this Team sub-screen when another screen asks for the pay tracker. */
export const PAY_TRACKER_KEY = "settings_team_sub";
export const PAY_TRACKER_SUB = "payouts";

/** Whether this person can open what a notice points at. Loads need the Logistics screen, bills the books. */
export function canOpenTarget(t: NoticeTarget | null, me: Perms | null | undefined): boolean {
  if (!t || !me) return false;
  if (t.to === "bill") return isAdmin(me) || can(me, "financials:view");
  // The tracker lives in Settings, whose Team section is the admin's.
  if (t.to === "paytracker") return isAdmin(me);
  return canViewLogistics(me);
}

// ─── raised once per device ───────────────────────────────────────────────

export const SEEN_CAP = 500;
/** On a device's first run nothing older than this is raised. */
export const FIRST_RUN_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** At most this many alerts from one poll, so catching up after a day away is not a wall of them. */
export const RAISE_CAP = 5;

/** The keys the seen sets live under, per signed-in person so two accounts on one device do not share them. */
export const seenKey = (kind: "team" | "derived", userId: string): string => `ecliptr_notices_seen_${kind}_${userId || "me"}`;
export const DESKTOP_NOTIFY_KEY = "ecliptr_desktop_notifications";

type Store = Pick<Storage, "getItem" | "setItem">;

/** The ids already raised, oldest first. null when nothing was ever stored: the device's first run. */
export function readSeen(store: Store | null | undefined, key: string): string[] | null {
  try {
    const raw = store?.getItem(key);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch { return null; }
}

export function writeSeen(store: Store | null | undefined, key: string, ids: readonly string[]): void {
  try { store?.setItem(key, JSON.stringify(ids.slice(-SEEN_CAP))); } catch { /* storage blocked: the in-memory copy still holds for this run */ }
}

/** Add `ids` to a seen list (order kept, newest last, no repeats) and trim it to the cap. */
export function mergeSeen(prev: readonly string[] | null, ids: readonly string[]): string[] {
  const have = new Set(prev ?? []);
  const out = [...(prev ?? [])];
  for (const id of ids) if (!have.has(id)) { have.add(id); out.push(id); }
  return out.slice(-SEEN_CAP);
}

/** The "Desktop notifications" switch. On unless someone turned it off on this device. */
export function desktopNoticesOn(store: Store | null | undefined): boolean {
  try { return store?.getItem(DESKTOP_NOTIFY_KEY) !== "0"; } catch { return true; }
}

/** Which of the server's notices to raise now, oldest first, and the seen list after this poll. A notice is
 *  raised once per device. On the first run (`seen` is null) only notices from the last two days are, so a
 *  new install does not announce the whole backlog; every notice in the list is marked seen either way.
 *  R-477: only the kinds that need you are raised. A paid bill only reports good news, so it is marked seen
 *  and never shown, and it does not use up a slot of the cap. */
export function planTeamRaise(
  list: readonly LeadNotification[], seen: readonly string[] | null, nowMs: number,
): { raise: LeadNotification[]; seen: string[] } {
  const known = new Set(seen ?? []);
  const fresh = list.filter((n) => !known.has(n.id));
  const eligible = fresh.filter((n) => {
    if (!isNeedsYouKind(n.kind)) return false;
    if (seen !== null) return true;
    const t = Date.parse(n.created_at);
    return Number.isFinite(t) && nowMs - t <= FIRST_RUN_WINDOW_MS;
  });
  eligible.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  return { raise: eligible.slice(-RAISE_CAP), seen: mergeSeen(seen, fresh.map((n) => n.id)) };
}

// ─── the Logistics-only account's notices, worked out from its loads ──────

export type DerivedKind = "quote" | "book" | "urgent";
export interface DerivedNotice { key: string; id: string; kind: DerivedKind; title: string; body: string }

const TITLE: Record<DerivedKind, string> = { quote: "Quote needed", book: "To book", urgent: "Urgent" };

/** The few fields of a load these rules read. */
export interface NoticeLoad { id: string; status: string; urgent?: boolean; archived?: boolean | number; load_number?: string; code: string }

/** What a load is, right now, that a Logistics person should hear about: it is waiting for a quote, it is
 *  waiting to be booked, it is urgent and not picked up. A cancelled or archived load is nothing. */
export function derivedKindsOf(b: Pick<NoticeLoad, "status" | "urgent" | "archived">): DerivedKind[] {
  if (b.archived || b.status === "cancelled") return [];
  const out: DerivedKind[] = [];
  if (b.status === "quote") out.push("quote");
  if (b.status === "requested") out.push("book");
  if (isHot(b)) out.push("urgent");
  return out;
}

/** The loads this person is waiting on: in Quotes to give, plus To book. This is the Logistics bell's count. */
export function logisticsBellCount(bookings: readonly Pick<NoticeLoad, "status" | "archived">[] | null | undefined): number {
  return (bookings ?? []).filter((b) => !b.archived && (b.status === "quote" || b.status === "requested")).length;
}

/** The alerts to raise for this poll of the loads, and the seen list after it. A (load, kind) pair is raised
 *  once per device. The first poll (`seen` is null) raises nothing: every pair already true is seeded as seen,
 *  so only what changes after that is news. `routeOf` says how a load's route reads for this viewer. */
export function planDerived(
  bookings: readonly NoticeLoad[], seen: readonly string[] | null, routeOf: (b: NoticeLoad) => string,
): { raise: DerivedNotice[]; seen: string[] } {
  const known = new Set(seen ?? []);
  const fresh: { key: string; b: NoticeLoad; kind: DerivedKind }[] = [];
  for (const b of bookings) for (const kind of derivedKindsOf(b)) {
    const key = `${b.id}:${kind}`;
    if (!known.has(key)) fresh.push({ key, b, kind });
  }
  const raise: DerivedNotice[] = seen === null ? [] : fresh.map(({ key, b, kind }) => {
    const route = routeOf(b).trim();
    const num = loadNumber(b);
    return { key, id: b.id, kind, title: TITLE[kind], body: route ? `${num}, ${route}` : num };
  });
  return { raise: raise.slice(0, RAISE_CAP), seen: mergeSeen(seen, fresh.map((p) => p.key)) };
}

// ─── R-477: the Notifications screen, in groups, most urgent first ────────

export type NoticeGroup = "bills" | "logistics" | "customers" | "requests" | "leads";
/** The fixed order groups keep when nothing else separates them. */
export const GROUP_ORDER: readonly NoticeGroup[] = ["bills", "logistics", "customers", "requests", "leads"];
export const GROUP_LABEL: Record<NoticeGroup, string> = {
  bills: "Bills", logistics: "Logistics", customers: "Customers", requests: "Team requests", leads: "Supplier leads",
};

/** Overdue (red), needs you or is due soon (amber), for your information (grey). */
export type Urgency = "overdue" | "needs" | "info";
const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, needs: 1, info: 2 };

export type RowKind = TeamNoticeKind | "supply_lead" | "supplier_profile" | "pending_customer" | "client_delete" | "unsubscribe";

const ROW_INFO: Record<RowKind, { group: NoticeGroup; label: string; urgency: Urgency }> = {
  bill_overdue: { group: "bills", label: NOTICE_KIND_LABEL.bill_overdue, urgency: "overdue" },
  bill_due: { group: "bills", label: NOTICE_KIND_LABEL.bill_due, urgency: "needs" },
  bill_paid: { group: "bills", label: NOTICE_KIND_LABEL.bill_paid, urgency: "info" },
  carrier_overdue: { group: "logistics", label: NOTICE_KIND_LABEL.carrier_overdue, urgency: "overdue" },
  carrier_due: { group: "logistics", label: NOTICE_KIND_LABEL.carrier_due, urgency: "needs" },
  logistics_pay_due: { group: "logistics", label: NOTICE_KIND_LABEL.logistics_pay_due, urgency: "needs" },
  logistics_quote: { group: "logistics", label: NOTICE_KIND_LABEL.logistics_quote, urgency: "needs" },
  pending_customer: { group: "customers", label: "To review", urgency: "needs" },
  client_delete: { group: "requests", label: "Delete request", urgency: "needs" },
  unsubscribe: { group: "requests", label: "Unsubscribed", urgency: "info" },
  supply_lead: { group: "leads", label: "New lead", urgency: "needs" },
  supplier_profile: { group: "leads", label: "Supplier details", urgency: "info" },
};

/** One line of the screen, whatever it came from. Every row reads the same way. */
export interface NoticeRow {
  key: string;
  group: NoticeGroup;
  kind: RowKind;
  label: string;
  urgency: Urgency;
  /** What it is about, plain text with no relative words. */
  subject: string;
  /** The YYYY-MM-DD it is about (a due day, a pay date), or "". */
  dueDay: string;
  /** When it was raised, or "" when the source keeps no time. */
  createdAt: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** The day a notice is about: the server's `due_day`, else (an older server) the day inside its entity key
 *  (`bill:<id>:<day>:due`, `carrier:<load>:<day>:overdue`, `lpay:<org>:<pay date>`). "" when it has none. */
export function dueDayOf(n: Pick<LeadNotification, "kind" | "entity_id" | "due_day">): string {
  const given = text(n.due_day);
  if (DAY_RE.test(given)) return given;
  const parts = (n.entity_id || "").split(":");
  let day = "";
  if (parts[0] === "lpay" && n.kind === "logistics_pay_due") day = parts[parts.length - 1];
  else if ((parts[0] === "bill" && n.kind.startsWith("bill_")) || (parts[0] === "carrier" && n.kind.startsWith("carrier_"))) day = parts[parts.length - 2] ?? "";
  return DAY_RE.test(day) ? day : "";
}

/** A server notice as a row, or null for a kind this screen does not list (a call request, a system note). */
export function noticeRow(n: LeadNotification): NoticeRow | null {
  const kind: string = n.kind;
  if (!isTeamNoticeKind(kind) && !isLeadNoticeKind(kind)) return null;
  return {
    key: `n:${n.id}`, ...ROW_INFO[kind as RowKind], kind: kind as RowKind,
    subject: text(n.subject) || text(n.title), dueDay: dueDayOf(n), createdAt: n.created_at || "",
  };
}

/** A pending customer. It carries the day the client signed up, so it reads and sorts like every other row. */
export function customerRow(c: { id: string; name: string; created_at?: string }): NoticeRow {
  return { key: `c:${c.id}`, ...ROW_INFO.pending_customer, kind: "pending_customer", subject: text(c.name) || "New customer", dueDay: "", createdAt: c.created_at || "" };
}

/** An approval request as a row: a deletion to decide, or an unsubscribe to clear. Anything else (a new
 *  client, a listing to renew) is shown some other way, so null. */
export function requestRow(a: { id: string; kind: string; summary: string; created_at: string }): NoticeRow | null {
  if (a.kind !== "client_delete" && a.kind !== "unsubscribe") return null;
  const subject = a.kind === "client_delete"
    ? text(a.summary).replace(/^Delete client:\s*/i, "")
    : text(a.summary).replace(/\s+unsubscribed from email$/i, "");
  return { key: `a:${a.id}`, ...ROW_INFO[a.kind], kind: a.kind, subject: subject || text(a.summary), dueDay: "", createdAt: a.created_at || "" };
}

const ms = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/** Red first, then amber, then grey. Inside one colour a dated row goes first, earliest day first; the rest
 *  follow, newest first. */
export function compareRows(a: NoticeRow, b: NoticeRow): number {
  if (a.urgency !== b.urgency) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (a.dueDay || b.dueDay) {
    if (!a.dueDay) return 1;
    if (!b.dueDay) return -1;
    if (a.dueDay !== b.dueDay) return a.dueDay < b.dueDay ? -1 : 1;
  }
  return ms(b.createdAt) - ms(a.createdAt);
}

export interface RowGroup<T extends NoticeRow = NoticeRow> {
  group: NoticeGroup;
  label: string;
  rows: T[];
  /** The read behind this group failed. It shows one line saying so, never an empty list. */
  failed: boolean;
}

/** The groups that have something to show, most urgent row first (a group with a red row, then amber, then
 *  grey); a tie keeps the fixed order. A group that could not load sits after the rest and shows no rows. */
export function groupRows<T extends NoticeRow>(rows: readonly T[], failed: readonly NoticeGroup[] = []): RowGroup<T>[] {
  const out: RowGroup<T>[] = [];
  for (const group of GROUP_ORDER) {
    if (failed.includes(group)) { out.push({ group, label: GROUP_LABEL[group], rows: [], failed: true }); continue; }
    const mine = rows.filter((r) => r.group === group).sort(compareRows);
    if (mine.length > 0) out.push({ group, label: GROUP_LABEL[group], rows: mine, failed: false });
  }
  const rank = (g: RowGroup<T>) => (g.failed ? 99 : URGENCY_RANK[g.rows[0].urgency]);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Whether a group could hold anything for this person, so a failed read only complains about groups they have. */
export function canSeeGroup(g: NoticeGroup, me: Perms | null | undefined): boolean {
  if (!me) return false;
  if (isAdmin(me)) return true;
  if (g === "bills") return can(me, "financials:view");
  if (g === "logistics") return can(me, "deal_flow:view") || can(me, "financials:view");
  return false;
}

const createdDay = (iso: string): string => {
  if (DAY_RE.test(iso)) return iso;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? localDay(new Date(t)) : "";
};

/** The "when" of a row, worked out from `today` (YYYY-MM-DD) and never from the stored title. A row about a day
 *  reads from that day ("3 days overdue", "Due tomorrow", "Paid Oct 5", "Pay day Oct 10"); every other row reads
 *  from when it was raised ("Today", "Yesterday", "4 days ago", then "Oct 5"). A row with no time reads "". */
export function whenWords(r: Pick<NoticeRow, "kind" | "dueDay" | "createdAt">, today: string): string {
  if (r.dueDay) {
    const late = daysBetween(r.dueDay, today);
    if (r.kind === "bill_paid") return `Paid ${shortDay(r.dueDay)}`;
    if (r.kind === "logistics_pay_due") return `Pay day ${shortDay(r.dueDay)}`;
    if ((r.kind === "bill_overdue" || r.kind === "carrier_overdue") && late >= 1) return `${late} ${late === 1 ? "day" : "days"} overdue`;
    return late === 0 ? "Due today" : late === -1 ? "Due tomorrow" : `Due ${shortDay(r.dueDay)}`;
  }
  const from = createdDay(r.createdAt);
  if (!from) return "";
  const n = daysBetween(from, today);
  return n <= 0 ? "Today" : n === 1 ? "Yesterday" : n <= 6 ? `${n} days ago` : shortDay(from);
}

/** Whether the "when" of a row is written in the same colour as its label. Only an overdue row's is, so "3 days
 *  overdue" (and "Due today" on the day an overdue kind falls due) reads as loudly as "Bill overdue"; every other
 *  row keeps the muted when. */
export const whenWearsUrgency = (r: Pick<NoticeRow, "urgency">): boolean => r.urgency === "overdue";

/** The number on the bell: only what needs you. Pending customers, deletions to decide, one item for all the
 *  listings to renew, the unread supplier leads, and the unread notices that ask something of you. A paid
 *  bill, a supplier's details and an unsubscribe are for your information and do not count. */
export function bellCountOf(a: {
  pendingCustomers: number;
  requests: readonly { kind: string }[];
  notices: readonly { kind: string; status?: string }[];
}): number {
  const waiting = a.notices.filter((n) => n.status !== "acknowledged" && (n.kind === "supply_lead" || isNeedsYouKind(n.kind))).length;
  const deletions = a.requests.filter((r) => r.kind === "client_delete").length;
  return a.pendingCustomers + deletions + (a.requests.some(isRenewal) ? 1 : 0) + waiting;
}

/** The bell's tooltip. */
export const bellTitle = (n: number): string => (n <= 0 ? "Notifications" : n === 1 ? "1 needs you" : `${n} need you`);
