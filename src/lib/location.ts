// Consistent location formatting for inventory lots. If the text looks like a US
// city/state, it's normalized to "City, ST" (e.g. "los angeles ca" → "Los Angeles, CA")
// so lots read the same everywhere. Anything that ISN'T a recognizable city/state — a
// warehouse name, a note — is left exactly as typed, so we never mangle "Warehouse A".

const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};
const ABBR_SET = new Set(Object.values(STATE_ABBR));

const titleCase = (s: string) =>
  s.trim().replace(/\s+/g, " ").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");

/** Resolve a state fragment (full name or 2-letter abbr, any case) to its abbreviation, else null. */
const resolveState = (frag: string): string | null => {
  const f = frag.trim().toLowerCase();
  if (!f) return null;
  if (f.length === 2 && ABBR_SET.has(f.toUpperCase())) return f.toUpperCase();
  return STATE_ABBR[f] ?? null;
};

/**
 * Normalize a location to "City, ST" when it reads like a US city/state; otherwise return
 * the input trimmed but otherwise untouched. Safe to call on every keystroke's blur.
 */
export function normalizeLocation(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";

  // Explicit "City, State" form.
  if (s.includes(",")) {
    const idx = s.indexOf(",");
    const city = s.slice(0, idx);
    const st = resolveState(s.slice(idx + 1));
    if (city.trim() && st) return `${titleCase(city)}, ${st}`;
    return s;
  }

  // No comma: try to peel a trailing state off the end (2-letter abbr, or a 1–2 word name).
  const tokens = s.split(/\s+/);
  if (tokens.length >= 2) {
    // Last token as an abbreviation.
    const lastAbbr = resolveState(tokens[tokens.length - 1]);
    if (lastAbbr) {
      const city = tokens.slice(0, -1).join(" ");
      if (city.trim()) return `${titleCase(city)}, ${lastAbbr}`;
    }
    // Last two tokens as a full state name (e.g. "New York", "North Carolina").
    if (tokens.length >= 3) {
      const twoName = resolveState(tokens.slice(-2).join(" "));
      if (twoName) {
        const city = tokens.slice(0, -2).join(" ");
        if (city.trim()) return `${titleCase(city)}, ${twoName}`;
      }
    }
    // Last single token as a full state name (e.g. "dallas texas").
    const oneName = resolveState(tokens[tokens.length - 1]);
    if (oneName) {
      const city = tokens.slice(0, -1).join(" ");
      if (city.trim()) return `${titleCase(city)}, ${oneName}`;
    }
  }

  // Not a recognizable city/state — leave it exactly as typed.
  return s;
}
