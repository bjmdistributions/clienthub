// R-460: notifications on the desktop. Two sources feed the bell and the operating-system alerts.
//   1. The team side (admins, anyone who sees deals or the books): the server's own notices of the six
//      kinds below, read through /api/notifications.
//   2. The Logistics-only side: that account cannot call /api/notifications, so its desktop works the
//      notices out of the bookings it already reads (a load newly in quote, newly to book, newly urgent).
// Everything here is plain logic with no screen, so what is new, what is raised once, and where a notice
// opens are all tested. The hook that polls (useNotices.ts) and the screens only call these.

import type { LeadNotification } from "./api";
import { isHot, loadNumber, type LoadStep } from "./logisticsLoad";
import { can, canViewLogistics, isAdmin, isLogisticsOnly, type Perms } from "./permissions";

// ─── the team's notices ───────────────────────────────────────────────────

export const TEAM_NOTICE_KINDS = ["logistics_quote", "carrier_due", "carrier_overdue", "bill_due", "bill_overdue", "bill_paid"] as const;
export type TeamNoticeKind = (typeof TEAM_NOTICE_KINDS)[number];
export const isTeamNoticeKind = (k: string): k is TeamNoticeKind => (TEAM_NOTICE_KINDS as readonly string[]).includes(k);

/** Who sees the bell with these notices: an admin (as always), or anyone who sees deals or the books. A
 *  Logistics-only account never does (it has its own bell, and the server refuses it these routes). */
export function canSeeTeamNotices(me: Perms | null | undefined): boolean {
  if (!me || isLogisticsOnly(me)) return false;
  return isAdmin(me) || can(me, "deal_flow:view") || can(me, "financials:view");
}

/** The unread notices of the six kinds, newest first. Anything else the server sends is not listed here. */
export function teamNoticesOf(list: readonly LeadNotification[] | null | undefined): LeadNotification[] {
  return (list ?? [])
    .filter((n) => isTeamNoticeKind(n.kind) && n.status !== "acknowledged")
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

export type NoticeTarget =
  | { to: "load"; id: string; step: LoadStep }
  | { to: "logistics" }
  | { to: "bill"; id?: string };

const payloadOf = (n: Pick<LeadNotification, "payload_json">): Record<string, unknown> => {
  try {
    const o = n.payload_json ? JSON.parse(n.payload_json) : null;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
};
const idIn = (o: Record<string, unknown>, key: string): string => (typeof o[key] === "string" ? (o[key] as string).trim() : "");

/** Where Open goes. A quote notice opens its load on the Quote step, a carrier notice the load's Pay step,
 *  a bill notice the Bills screen (on the bill when the payload names one). A notice whose payload names no
 *  load falls back to the screen that holds it. */
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
    default:
      return null;
  }
}

/** The words and colour a notice's kind wears on the Notifications screen. */
export const NOTICE_KIND_LABEL: Record<TeamNoticeKind, string> = {
  logistics_quote: "Quote ready",
  carrier_due: "Carrier due",
  carrier_overdue: "Carrier overdue",
  bill_due: "Bill due",
  bill_overdue: "Bill overdue",
  bill_paid: "Bill paid",
};
export const noticeTone = (k: string): "danger" | "warning" | "success" | "neutral" =>
  k === "carrier_overdue" || k === "bill_overdue" ? "danger" : k === "carrier_due" || k === "bill_due" ? "warning" : k === "bill_paid" ? "success" : "neutral";

/** The Bills screen opens a bill from another screen the same stash-then-switch way Invoices does. */
export const BILL_OPEN_KEY = "bills_open_id";

/** Whether this person can open what a notice points at. Loads need the Logistics screen, bills the books. */
export function canOpenTarget(t: NoticeTarget | null, me: Perms | null | undefined): boolean {
  if (!t || !me) return false;
  if (t.to === "bill") return isAdmin(me) || can(me, "financials:view");
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
 *  new install does not announce the whole backlog; every notice in the list is marked seen either way. */
export function planTeamRaise(
  list: readonly LeadNotification[], seen: readonly string[] | null, nowMs: number,
): { raise: LeadNotification[]; seen: string[] } {
  const known = new Set(seen ?? []);
  const fresh = list.filter((n) => !known.has(n.id));
  const eligible = fresh.filter((n) => {
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
