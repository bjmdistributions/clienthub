import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isUnavailable, type FreightBooking, type LeadNotification, type LogisticsCompletion, type Me } from "./api";
import {
  CHIMED_DEALS_KEY, canReadTeamNotices, canSeeTeamNotices, chimedHere, chimes, desktopNoticesOn, leadNoticesOf, logisticsBellCount, mergeSeen, planDerived, planDone, planTeamRaise, readSeen, seenKey, switchOf, switchOn, teamNoticesOf, writeSeen,
} from "./notices";
import { pushApi } from "./billsApi";
import { isAdmin, isLogisticsOnly } from "./permissions";
import { routeLabel } from "../components/LogisticsBookingForm";

// R-460: the polling half of desktop notifications. One hook, mounted once by the app shell, so the
// bell is right on every screen and the operating-system alerts are raised whichever screen is open.
//   - Team (admins, deal and book viewers): the server's notices of the six kinds, read through the
//     existing /api/notifications call.
//   - Logistics-only: that account cannot call it, so the notices are worked out from its loads.
// Both poll every 60 seconds and on window focus. What was already raised is kept in localStorage per
// person, so an alert shows once per device; the in-memory copy covers storage that is blocked.

const POLL_MS = 60_000;

const store = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

/** Raise one alert per item through the operating system, unless the person switched them off on this
 *  device. A failure to show one is never worth interrupting the poll for. */
function raise(items: { title: string; body: string; chime?: boolean }[]) {
  if (!desktopNoticesOn(store())) return;
  for (const it of items) api.showDesktopNotification(it.title, it.body, !!it.chime).catch(() => {});
}

/** R-492: the person's switches (Settings, Notifications), read at most every five minutes. The same ones decide
 *  the phone's pushes, so turning Bank activity off quiets both. A failed read keeps every alert on. */
let prefsAt = 0;
let prefsCache: Record<string, boolean> | null = null;
async function noticePrefs(): Promise<Record<string, boolean> | null> {
  if (Date.now() - prefsAt < 5 * 60_000) return prefsCache;
  prefsAt = Date.now();
  try { prefsCache = (await pushApi.get()).prefs as unknown as Record<string, boolean>; } catch { prefsCache = null; }
  return prefsCache;
}
/** Settings calls this after a switch changes, so the next poll reads it. */
export function noticePrefsChanged() { prefsAt = 0; }

export interface NoticeState {
  /** The unread team notices, newest first. Empty for a person who does not see them. */
  team: LeadNotification[];
  /** R-477: the unread supplier leads and supplier details, newest first. Admins only; empty for everyone else. */
  leads: LeadNotification[];
  /** R-477: the server's notices have been read once, whichever way it went. */
  loaded: boolean;
  /** R-477: the last read of the server's notices failed, so the lists above may be out of date. */
  failed: boolean;
  /** A Logistics-only account's count of loads to quote plus loads to book. 0 for everyone else. */
  logisticsCount: number;
  /** Read again now (after an acknowledge or an open). */
  refresh: () => void;
  /** Take a notice out of the list at once; the server has been told separately. */
  drop: (id: string) => void;
}

export function useNotices(me: Me | null | undefined): NoticeState {
  const teamOn = canSeeTeamNotices(me);
  const canRead = canReadTeamNotices(me);
  const logisticsOnly = isLogisticsOnly(me);
  const admin = isAdmin(me);
  const userId = me?.id ?? "";
  const [team, setTeam] = useState<LeadNotification[]>([]);
  const [leads, setLeads] = useState<LeadNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [logisticsCount, setLogisticsCount] = useState(0);
  // undefined = not read from storage yet; null = read, nothing stored (a first run)
  const teamSeen = useRef<string[] | null | undefined>(undefined);
  const derivedSeen = useRef<string[] | null | undefined>(undefined);
  // A new account on this device starts from its own stored sets.
  useEffect(() => { teamSeen.current = undefined; derivedSeen.current = undefined; }, [userId]);

  const refreshTeam = useCallback(async () => {
    if (!teamOn) return;
    // The server refuses this list to a role without the clients module; that is nothing to read, not a failed read.
    if (!canRead) { setLoaded(true); setFailed(false); return; }
    const r = await api.listLeadNotifications(undefined, "unread").catch(() => null);
    setLoaded(true);
    if (!r || isUnavailable(r)) { setFailed(true); return; }
    setFailed(false);
    const list = teamNoticesOf(r, admin);
    setTeam(list);
    setLeads(leadNoticesOf(r, admin));
    const key = seenKey("team", userId);
    if (teamSeen.current === undefined) teamSeen.current = readSeen(store(), key);
    const plan = planTeamRaise(list, teamSeen.current, Date.now(), userId);
    teamSeen.current = plan.seen;
    writeSeen(store(), key, plan.seen);
    const prefs = plan.raise.length ? await noticePrefs() : null;
    // R-496: a deal this computer completed already chimed when it was completed.
    const chimed = readSeen(store(), CHIMED_DEALS_KEY);
    raise(plan.raise
      .filter((n) => switchOn(prefs, switchOf(n.kind)) && !chimedHere(n, chimed))
      .map((n) => ({ title: n.title, body: n.body, chime: chimes(n) })));
  }, [teamOn, canRead, userId, admin]);

  const refreshLogistics = useCallback(async () => {
    if (!logisticsOnly) return;
    let bookings: FreightBooking[];
    let completed: LogisticsCompletion[];
    try { const r = await api.logistics.list(); bookings = r.bookings; completed = r.completed ?? []; } catch { return; }
    setLogisticsCount(logisticsBellCount(bookings));
    const key = seenKey("derived", userId);
    if (derivedSeen.current === undefined) derivedSeen.current = readSeen(store(), key);
    // R-538: the "Deal 100% complete" alerts are planned against the same seen list as it stood before this poll.
    const before = derivedSeen.current;
    const plan = planDerived(bookings, before, (b) => routeLabel(b as FreightBooking));
    const done = planDone(completed, before);
    const seenNow = mergeSeen(plan.seen, done.seen);
    derivedSeen.current = seenNow;
    writeSeen(store(), key, seenNow);
    // R-494: a Logistics person's quote and booking alerts follow their Logistics switch; so does the 100% complete one.
    const all = [...plan.raise, ...done.raise];
    const prefs = all.length ? await noticePrefs() : null;
    if (switchOn(prefs, "logistics")) raise(all.map((n) => ({ title: n.title, body: n.body })));
  }, [logisticsOnly, userId]);

  const refresh = useCallback(() => { refreshTeam(); refreshLogistics(); }, [refreshTeam, refreshLogistics]);

  useEffect(() => {
    if (!teamOn) { setTeam([]); setLeads([]); setLoaded(false); setFailed(false); }
    if (!logisticsOnly) setLogisticsCount(0);
    if (!teamOn && !logisticsOnly) return;
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("approvals-changed", refresh);
    let unlisten: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => refresh()).then((u) => { if (dead) u(); else unlisten = u; }).catch(() => {});
    return () => {
      dead = true;
      window.clearInterval(t);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("approvals-changed", refresh);
      unlisten?.();
    };
  }, [teamOn, logisticsOnly, refresh]);

  const drop = useCallback((id: string) => {
    setTeam((l) => l.filter((n) => n.id !== id));
    setLeads((l) => l.filter((n) => n.id !== id));
  }, []);
  return { team, leads, loaded, failed, logisticsCount, refresh, drop };
}
