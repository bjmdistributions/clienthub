import { addressParts, oneLineAddress } from "./fullAddress";
import { milWindow } from "./logisticsLoad";

// R-651: what Send to logistics writes into a box when it is left, so every load reads the same way for the people
// booking it. Each tidy keeps anything it does not recognise as typed (only the spacing is cleaned), so it never loses
// a word. The website's lgTidy* in app.js are the twins; both read tidy.cases.json.

const spaced = (s: string) => (s || "").replace(/[ \t]+/g, " ").trim();

const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

/** Words typed all in lowercase get capitals ("depot rd" reads "Depot Rd", "nw" reads "NW"); anything typed with a
 *  capital anywhere is left as typed, so "McDonald" and "ABC Supply" stay. A word starting with a digit stays. */
export function capitalIfLower(s: string): string {
  if (!/[a-z]/.test(s) || s !== s.toLowerCase()) return s;
  return s.split(" ").map((w) => (DIRECTIONS.has(w.replace(/[.,]/g, "")) ? w.toUpperCase()
    : /^\d/.test(w) ? w : w.replace(/(^|[-'/])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()))).join(" ");
}

/** A name with its spacing cleaned, capitalised when typed all in lowercase. */
export const tidyName = (s: string): string => capitalIfLower(spaced(s));

/** A full address as "Street, City, ST 12345" (a suite after the street, a country at the end); anything else on one
 *  line with its spacing cleaned. */
export function tidyAddress(s: string): string {
  const p = addressParts(s);
  if (!p) return capitalIfLower(oneLineAddress(s).replace(/[ \t]+/g, " ").replace(/\s+,/g, ","));
  return [...[p.street, ...p.suites, p.city].map(capitalIfLower), `${p.state} ${p.zip}`, p.country].filter(Boolean).join(", ");
}

/** A US phone number as 555-123-4567 (the app's way), with an extension kept as "ext 22"; anything else as typed. */
export function tidyPhone(s: string): string {
  const t = spaced(s);
  const m = /^(?:\+?1[\s.-]*)?\(?(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})(?:\s*(?:x|ext\.?|extension|#)\s*(\d{1,6}))?$/i.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ext ${m[4]}` : ""}` : t;
}

/** A time or a window as "8:00 am to 2:00 pm" when both ends are clearly times (R-538's rule); else as typed. */
export function tidyWindow(s: string): string {
  const t = spaced(s);
  return milWindow(t) || t;
}

/** An email address trimmed and lowercased. */
export const tidyEmail = (s: string): string => spaced(s).replace(/^mailto:/i, "").toLowerCase();

/** Pallet dimensions as "48 x 40 x 60"; anything else as typed. */
export function tidyDims(s: string): string {
  const t = spaced(s);
  const m = /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:in|inch|inches|")?\.?$/i.exec(t);
  return m ? `${m[1]} x ${m[2]} x ${m[3]}` : t;
}
