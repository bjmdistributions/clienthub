import { resolveState } from "./location";

// R-483: Logistics needs a ZIP to get a freight rate, so every load is sent with a full address at each stop. The
// server refuses a load whose pickup or delivery is not full (clienthub-api routes/logistics.rs `full_address`, the
// rule this file repeats); the desktop only guides, so the box says what to type and shows the server's sentence as it
// comes. The same cases are tested on both sides.

/** What every address box that goes to Logistics asks for. */
export const ADDRESS_HINT = "Street, city, state ZIP";

const COUNTRIES = new Set(["usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"]);
const ZIP = /^(\d{5})(-\d{4})?$/;

/** A full address: split on commas and new lines it has a street, a city, then a US state followed by a 5 digit ZIP
 *  (or ZIP+4), like "9 Depot Rd, Warehouse City, NV 89001". The state is its two letter code or its full name, in any
 *  case. A country after the ZIP ("USA") does not matter, and the state and the ZIP may be two parts ("NV", "89001"). */
export function isFullAddress(addr: string | null | undefined): boolean {
  const parts = (addr ?? "").split(/[,\r\n]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && COUNTRIES.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  const last = parts.pop();
  if (!last) return false;
  const words = last.split(/\s+/);
  const zip = words.pop() ?? "";
  if (!ZIP.test(zip)) return false;
  const state = words.length > 0 ? words.join(" ") : parts.pop() ?? "";
  // The street and the city are what is left. (resolveState reads a plain object, so "constructor" would come back as a
  // function; only a string is a state.)
  return typeof resolveState(state) === "string" && parts.length >= 2;
}

/** The line to show under an address that has been typed but is not full yet; nothing for an empty box (its
 *  placeholder says what to type) or a full address. It always carries a worked example, because an address with all
 *  four parts but no commas ("9 Depot Rd, Reno NV 89501") is not full and a plain "add the ZIP" would not say why. */
export const addressNote = (addr: string | null | undefined): string | undefined =>
  (addr ?? "").trim() && !isFullAddress(addr)
    ? "Write it as street, city, state ZIP with commas between: 9 Depot Rd, Reno, NV 89501."
    : undefined;

/** The server numbers the extra pickups it was sent ("pickup 2" is the first one it got), but the sheet drops a blank
 *  row before sending and labels its rows by position ("Pickup 2" is the first row). `sent` holds the sheet index of
 *  each extra pickup that was sent, in order; the number in the server's sentence goes back to that row's label. A
 *  sentence with no pickup number ("the full pickup address", "the full delivery address") is returned as it is. */
export function relabelPickupError(msg: string, sent: readonly number[]): string {
  return msg.replace(/\b(pickup) (\d+)\b/i, (whole, word: string, n: string) => {
    const row = sent[Number(n) - 2];
    return row === undefined ? whole : `${word} ${row + 2}`;
  });
}
