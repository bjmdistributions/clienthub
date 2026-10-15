// R-538: typing load times in 24-hour time is the person's choice (Jack chose "each person picks" for R-524), kept on the
// server at /api/logistics/me so it follows the person to every device, and cached here and on the device for the
// moments before the server has answered. logisticsLoad.ts's time24On() reads the cache.
import { api } from "./api";
import { TIME24_KEY, setTime24Account } from "./logisticsLoad";

let asked = false;

/** Read the person's choice once per sign-in. A choice made on this device before it was kept on the account is sent
 *  up once. A failed read leaves the device's cache in charge and is asked again next time. */
export async function loadTime24(): Promise<void> {
  if (asked) return;
  asked = true;
  let r: { time24: boolean | null };
  try { r = await api.logistics.me.get(); } catch { asked = false; return; }
  if (typeof r.time24 === "boolean") { setTime24Account(r.time24); return; }
  let local = false;
  try { local = localStorage.getItem(TIME24_KEY) === "1"; } catch { /* storage blocked: nothing chosen here */ }
  if (!local) { setTime24Account(false); return; }
  try { setTime24Account((await api.logistics.me.save({ time24: true })).time24); } catch { /* the cache still says on */ }
}

/** The switch in Settings, Appearance. Throws when the server refuses, so the switch can go back. */
export async function saveTime24(on: boolean): Promise<boolean> {
  const r = await api.logistics.me.save({ time24: on });
  setTime24Account(r.time24);
  return r.time24;
}

/** Sign-out: the next person on this device reads their own choice. */
export function forgetTime24(): void {
  asked = false;
  setTime24Account(null);
  try { localStorage.removeItem(TIME24_KEY); } catch { /* nothing to forget */ }
}
