// R-538: typing load times in 24-hour time is the person's choice (Jack chose "each person picks" for R-524), kept on the
// server at /api/logistics/me so it follows the person to every device, and cached here and on the device for the
// moments before the server has answered. logisticsLoad.ts's time24On() reads the cache.
import { api } from "./api";
import { TIME24_KEY, setTime24Account } from "./logisticsLoad";

let asked = false;
/** Bumped on sign-out, so an answer that lands after it is dropped. */
let epoch = 0;

/** Read the person's choice once per sign-in. Never chosen on the account reads as off: a device's earlier flag is not
 *  sent up, since it may have been another person's. A failed read leaves the device's cache in charge and is asked
 *  again next time. */
export async function loadTime24(): Promise<void> {
  if (asked) return;
  asked = true;
  const mine = epoch;
  let r: { time24: boolean | null };
  try { r = await api.logistics.me.get(); } catch { if (mine === epoch) asked = false; return; }
  if (mine !== epoch) return;
  setTime24Account(typeof r.time24 === "boolean" ? r.time24 : false);
}

/** The switch in Settings, Appearance. Throws when the server refuses, so the switch can go back. */
export async function saveTime24(on: boolean): Promise<boolean> {
  const r = await api.logistics.me.save({ time24: on });
  setTime24Account(r.time24);
  return r.time24;
}

/** Signed out: the next person on this device reads their own choice. */
export function forgetTime24(): void {
  epoch++;
  asked = false;
  setTime24Account(null);
  try { localStorage.removeItem(TIME24_KEY); } catch { /* nothing to forget */ }
}
