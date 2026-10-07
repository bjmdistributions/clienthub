import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isUnavailable, type FreightBooking, type LeadNotification, type Me } from "./api";
import {
  canSeeTeamNotices, desktopNoticesOn, logisticsBellCount, planDerived, planTeamRaise, readSeen, seenKey, teamNoticesOf, writeSeen,
} from "./notices";
import { isLogisticsOnly } from "./permissions";
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
function raise(items: { title: string; body: string }[]) {
  if (!desktopNoticesOn(store())) return;
  for (const it of items) api.showDesktopNotification(it.title, it.body).catch(() => {});
}

export interface NoticeState {
  /** The unread team notices, newest first. Empty for a person who does not see them. */
  team: LeadNotification[];
  /** A Logistics-only account's count of loads to quote plus loads to book. 0 for everyone else. */
  logisticsCount: number;
  /** Read again now (after an acknowledge or an open). */
  refresh: () => void;
  /** Take a notice out of the list at once; the server has been told separately. */
  drop: (id: string) => void;
}

export function useNotices(me: Me | null | undefined): NoticeState {
  const teamOn = canSeeTeamNotices(me);
  const logisticsOnly = isLogisticsOnly(me);
  const userId = me?.id ?? "";
  const [team, setTeam] = useState<LeadNotification[]>([]);
  const [logisticsCount, setLogisticsCount] = useState(0);
  // undefined = not read from storage yet; null = read, nothing stored (a first run)
  const teamSeen = useRef<string[] | null | undefined>(undefined);
  const derivedSeen = useRef<string[] | null | undefined>(undefined);
  // A new account on this device starts from its own stored sets.
  useEffect(() => { teamSeen.current = undefined; derivedSeen.current = undefined; }, [userId]);

  const refreshTeam = useCallback(async () => {
    if (!teamOn) return;
    const r = await api.listLeadNotifications(undefined, "unread").catch(() => null);
    if (!r || isUnavailable(r)) return;
    const list = teamNoticesOf(r);
    setTeam(list);
    const key = seenKey("team", userId);
    if (teamSeen.current === undefined) teamSeen.current = readSeen(store(), key);
    const plan = planTeamRaise(list, teamSeen.current, Date.now());
    teamSeen.current = plan.seen;
    writeSeen(store(), key, plan.seen);
    raise(plan.raise.map((n) => ({ title: n.title, body: n.body })));
  }, [teamOn, userId]);

  const refreshLogistics = useCallback(async () => {
    if (!logisticsOnly) return;
    let bookings: FreightBooking[];
    try { bookings = (await api.logistics.list()).bookings; } catch { return; }
    setLogisticsCount(logisticsBellCount(bookings));
    const key = seenKey("derived", userId);
    if (derivedSeen.current === undefined) derivedSeen.current = readSeen(store(), key);
    const plan = planDerived(bookings, derivedSeen.current, (b) => routeLabel(b as FreightBooking));
    derivedSeen.current = plan.seen;
    writeSeen(store(), key, plan.seen);
    raise(plan.raise.map((n) => ({ title: n.title, body: n.body })));
  }, [logisticsOnly, userId]);

  const refresh = useCallback(() => { refreshTeam(); refreshLogistics(); }, [refreshTeam, refreshLogistics]);

  useEffect(() => {
    if (!teamOn) setTeam([]);
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

  const drop = useCallback((id: string) => setTeam((l) => l.filter((n) => n.id !== id)), []);
  return { team, logisticsCount, refresh, drop };
}
