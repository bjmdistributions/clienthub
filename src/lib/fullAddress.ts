import { resolveState } from "./location";

// R-483: Logistics needs a ZIP to get a freight rate, so every load is sent with a full address at each stop. The
// server refuses a load whose pickup or delivery is not full (clienthub-api routes/logistics.rs `full_address`, the
// rule this file repeats); the desktop only guides, so the box says what to type and shows the server's sentence as it
// comes. The same cases are tested on both sides.

/** What every address box that goes to Logistics asks for. */
export const ADDRESS_HINT = "Street, city, state ZIP";

const COUNTRIES = new Set(["usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"]);
const ZIP = /^(\d{5})(-\d{4})?$/;

/** R-502: the first part an address is missing, read from the end (the server's `AddressLack`). */
export type AddressLack = "empty" | "zip" | "state" | "city" | "street";

/** R-502: street words that end a street name, so a city can be told from the street with no comma between them. */
const STREET_ENDS = new Set([
  "st", "street", "rd", "road", "ave", "av", "avenue", "blvd", "boulevard", "dr", "drive", "ln", "lane", "way", "hwy",
  "highway", "pkwy", "parkway", "ct", "court", "pl", "place", "cir", "circle", "ter", "terrace", "trl", "trail", "pike",
  "tpke", "turnpike", "loop", "plz", "plaza", "expy", "expressway", "fwy", "freeway", "rte", "route", "xing",
  "crossing", "sq", "square", "aly", "alley",
]);
/** R-502: words that name a unit inside a building, never a city ("Suite 4", "Dock B"). */
const UNIT_WORDS = new Set(["suite", "ste", "unit", "apt", "bldg", "building", "fl", "floor", "dock", "door", "rm", "room"]);

const word = (w: string) => w.replace(/\.+$/, "").toLowerCase();
// resolveState reads a plain object, so "constructor" would come back as a function; only a string is a state.
const isState = (s: string) => typeof resolveState(s) === "string";

/** What an address lacks to get a freight rate, or undefined when it has a street, a city, a US state and a 5 digit
 *  ZIP (or ZIP+4). The ZIP ends the address, the state is the one to three words just before it (code or full name,
 *  any case, comma or not), and what is left is the street and the city: two parts when a comma or new line splits
 *  them, else the street starts with its number and ends with a street word ("Rd") and the city follows it
 *  ("9 Depot Rd Reno NV 89501"). A country after the ZIP ("USA") and a full stop after a word do not matter. */
export function addressLack(addr: string | null | undefined): AddressLack | undefined {
  let parts = (addr ?? "").split(/[,\r\n]/).map((p) => p.trim().split(/\s+/).filter(Boolean)).filter((p) => p.length > 0);
  if (parts.length === 0) return "empty";
  if (parts.length > 1 && COUNTRIES.has(parts[parts.length - 1].join(" ").toLowerCase())) parts.pop();
  const zip = parts[parts.length - 1].pop() ?? "";
  if (!ZIP.test(zip.replace(/\.+$/, ""))) return "zip";
  parts = parts.filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  if (!last) return "state";
  let n = 0;
  for (let k = Math.min(3, last.length); k >= 1 && !n; k--) if (isState(last.slice(-k).map(word).join(" "))) n = k;
  if (!n) return "state";
  last.splice(last.length - n, n);
  parts = parts.filter((p) => p.length > 0);
  if (parts.length === 0) return "street";
  if (parts.length >= 2) return undefined;
  const w = parts[0];
  if (!/\d/.test(w[0])) return "street";
  let end = -1;
  w.forEach((x, i) => { if (STREET_ENDS.has(word(x))) end = i; });
  const city = end >= 0 && w.slice(end + 1).some((x) => !/\d/.test(x) && !x.startsWith("#") && !UNIT_WORDS.has(word(x)));
  return city ? undefined : "city";
}

/** A full address: `addressLack` finds nothing missing. */
export const isFullAddress = (addr: string | null | undefined): boolean => addressLack(addr) === undefined;

/** R-502: the worked example the server's refusal ends with (logistics.rs `ADDRESS_EXAMPLE`). */
export const ADDRESS_EXAMPLE = "Like 9 Depot Rd, Reno, NV 89501.";

const LACK_WORDS: Record<Exclude<AddressLack, "empty">, string> = {
  zip: "Needs its 5-digit ZIP code at the end.",
  state: "Needs its state, just before the ZIP code.",
  city: "Needs its city.",
  street: "Needs its street and number.",
};

/** The line to show under an address that has been typed but is not full yet; nothing for an empty box (its
 *  placeholder says what to type) or a full address. It names the missing part and carries the worked example. */
export const addressNote = (addr: string | null | undefined): string | undefined => {
  const lack = addressLack(addr);
  return lack && lack !== "empty" ? `${LACK_WORDS[lack]} ${ADDRESS_EXAMPLE}` : undefined;
};

/** What an extra pickup can hold. The server drops a row with none of these filled in (logistics.rs `parse_stops`,
 *  `STOP_FIELDS`) and numbers the rows it keeps from 2. */
const STOP_TEXT = ["name", "address", "window", "contact", "phone", "notes", "dock", "pickup_number"] as const;

/** The sheet index of each extra pickup the server keeps, in order, when every row is sent as it stands: a row with
 *  nothing in it is dropped, so a blank row above an incomplete one moves that one's number up by one. */
export function keptPickupRows(stops: ReadonlyArray<Partial<Record<(typeof STOP_TEXT)[number], string | null>>>): number[] {
  return stops.map((_, i) => i).filter((i) => STOP_TEXT.some((k) => (stops[i][k] ?? "").trim() !== ""));
}

/** The server numbers the extra pickups it was sent ("pickup 2" is the first one it got), but a sheet drops a blank
 *  row (or the server does) and labels its rows by position ("Pickup 2" is the first row). `sent` holds the sheet index
 *  of each extra pickup that was kept, in order; the number in the server's sentence goes back to that row's label. A
 *  sentence with no pickup number ("the full pickup address", "the full delivery address") is returned as it is. */
export function relabelPickupError(msg: string, sent: readonly number[]): string {
  return msg.replace(/\b(pickup) (\d+)\b/i, (whole, word: string, n: string) => {
    const row = sent[Number(n) - 2];
    return row === undefined ? whole : `${word} ${row + 2}`;
  });
}

/** For a form that sends every row as it stands. Only the address sentence counts the rows the server kept; its other
 *  pickup sentences ("Pickup 3 address is too long") count the rows as sent, which are the sheet's own, so they are
 *  returned as they are. */
export const relabelAddressGap = (msg: string, kept: readonly number[]): string =>
  /\baddress of pickup \d/i.test(msg) ? relabelPickupError(msg, kept) : msg;
