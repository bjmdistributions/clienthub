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

/** Every pickable state, sorted by name — the source list for the dropdown. */
export const US_STATES: { code: string; name: string }[] = Object.entries(STATE_ABBR)
  .map(([name, code]) => ({ code, name: titleCaseState(name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** Title-case a state name, keeping "of" lowercase ("District of Columbia"). */
function titleCaseState(s: string): string {
  return s.split(" ").map((w) => (w === "of" ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

const NAME_BY_CODE: Record<string, string> = Object.fromEntries(US_STATES.map((s) => [s.code, s.name]));

/** Full state name for a code ("IL" → "Illinois"), or the code back if unknown. */
export const stateName = (code: string): string => NAME_BY_CODE[(code || "").toUpperCase()] || code;

/** True when `code` is one of the 51 codes we accept. */
export const isStateCode = (code: string): boolean => ABBR_SET.has((code || "").trim().toUpperCase());

/**
 * Split a stored location back into its parts. This is the exact inverse of
 * `formatLocation` for anything that IS in canonical form, and a best effort for
 * anything that isn't (which is what the one-off reformat screen exists to fix).
 * A value we can't read a state out of comes back as `{ city: <raw>, state: "" }`,
 * never as a dropped value.
 */
export function parseLocation(raw: string): { city: string; state: string } {
  const s = (raw || "").trim();
  if (!s) return { city: "", state: "" };

  // Canonical "City, ST".
  const comma = s.lastIndexOf(",");
  if (comma > 0) {
    const st = resolveState(s.slice(comma + 1));
    if (st) return { city: s.slice(0, comma).trim(), state: st };
  }
  // Bare state, by code or full name ("TX", "Texas", "New York").
  const whole = resolveState(s);
  if (whole) return { city: "", state: whole };

  // Trailing state with no comma ("dallas texas", "los angeles ca").
  const tokens = s.split(/\s+/);
  for (const take of [2, 1]) {
    if (tokens.length <= take) continue;
    const st = resolveState(tokens.slice(-take).join(" "));
    if (st) return { city: tokens.slice(0, -take).join(" "), state: st };
  }
  return { city: s, state: "" };
}

/**
 * Build the canonical stored string: "City, ST", or "ST" with no city, or "" with
 * neither. This is the ONLY thing that should ever be written to `inventory.location`
 * — the storefront reads the state straight back off the end of it.
 */
export function formatLocation(city: string, state: string): string {
  const c = titleCase(city || "");
  const s = (state || "").trim().toUpperCase();
  if (c && isStateCode(s)) return `${c}, ${s}`;
  if (isStateCode(s)) return s;
  return c;
}

/**
 * Is this value already exactly what `formatLocation` would produce? Anything that
 * isn't is what the reformat screen lists. An empty location is fine (both fields
 * are optional) — it is simply absent, not malformed.
 */
/** Levenshtein distance, capped — only used against the 51 state names. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Closest state name within a small edit distance — catches "Virgina" → Virginia. */
export function fuzzyState(raw: string): string | null {
  const s = (raw || "").trim().toLowerCase();
  if (s.length < 4) return null;
  let best: { code: string; d: number } | null = null;
  for (const st of US_STATES) {
    const d = editDistance(s, st.name.toLowerCase());
    if (!best || d < best.d) best = { code: st.code, d };
  }
  // One or two typos in a name this long is a typo; more is a different word.
  return best && best.d <= Math.max(1, Math.floor(s.length / 6)) ? best.code : null;
}

/** A location that is nothing but a two-letter state code ("TX", "LA"). */
export const isBareStateCode = (raw: string): boolean => {
  const s = (raw || "").trim();
  return s.length === 2 && isStateCode(s);
};

/**
 * Should this stored value be offered for review?
 *
 * Anything not in canonical form, plus bare state codes — which ARE well-formed,
 * but are exactly where a city abbreviation hides ("LA"). Confirming one is a
 * glance; letting a Los Angeles load sit on the Louisiana map is not.
 */
export const needsLocationReview = (raw: string): boolean =>
  !isCanonicalLocation(raw) || isBareStateCode(raw);

export type LocationConfidence = "certain" | "assumed" | "unresolved";

export interface LocationProposal {
  city: string;
  state: string;
  /** What we'd write. Empty when we have nothing to propose. */
  formatted: string;
  confidence: LocationConfidence;
  /** Plain-language reason, shown next to the row so a guess never looks like a fact. */
  reason: string;
}

/**
 * Work out what a messy stored location should become.
 *
 * Order matters: a full state NAME is resolved before the city index, because
 * there is a real town called California in Pennsylvania — and "California"
 * plainly means the state. `cityStates` is the result of the `states_for_city`
 * command, passed in so this stays pure and testable.
 *
 * Nothing here is applied on its own. Every proposal is confirmed by a human,
 * which is why an honest `confidence` matters more than a clever guess.
 */
export function proposeLocation(raw: string, cityStates: { state: string; population: number }[] = []): LocationProposal {
  const s = (raw || "").trim();
  const none: LocationProposal = { city: "", state: "", formatted: "", confidence: "unresolved", reason: "" };
  if (!s) return none;

  const parsed = parseLocation(s);

  // A bare two-letter code IS a valid state, but it is also how people abbreviate a
  // city — "LA" is Los Angeles at least as often as Louisiana. Propose the state,
  // but never call it certain. Checked BEFORE the already-correct branch below,
  // which would otherwise wave "LA" through as a finished value.
  if (isBareStateCode(s)) {
    return {
      city: "", state: parsed.state, formatted: parsed.state, confidence: "assumed",
      reason: `Read as ${stateName(parsed.state)} — could also be a city abbreviation`,
    };
  }

  // Already exactly right — nothing to do.
  if (parsed.state && formatLocation(parsed.city, parsed.state) === s) {
    return { ...parsed, formatted: s, confidence: "certain", reason: "Already in the right format" };
  }

  // Resolved a state out of the text (full name, or "City, State" in a loose form).
  if (parsed.state) {
    return {
      ...parsed, formatted: formatLocation(parsed.city, parsed.state), confidence: "certain",
      reason: parsed.city ? "City and state both recognised" : `Recognised as ${stateName(parsed.state)}`,
    };
  }

  // No state in the text — try the city index. Only confident when one state
  // clearly dominates; "Springfield" must stay a question.
  if (cityStates.length) {
    const [top, next] = cityStates;
    const dominant = !next || top.population >= next.population * 5;
    return {
      city: titleCase(s), state: top.state, formatted: formatLocation(s, top.state),
      confidence: dominant ? "certain" : "assumed",
      reason: dominant
        ? `${titleCase(s)} is in ${stateName(top.state)}`
        : `${titleCase(s)} exists in ${cityStates.length} states — ${stateName(top.state)} is the biggest`,
    };
  }

  // Not a state, not a city we know — a typo, or a warehouse name.
  const fuzzy = fuzzyState(s);
  if (fuzzy) {
    return {
      city: "", state: fuzzy, formatted: fuzzy, confidence: "assumed",
      reason: `Looks like a misspelling of ${stateName(fuzzy)}`,
    };
  }
  return { ...none, city: s, reason: "Not a US city or state we recognise" };
}

export function isCanonicalLocation(raw: string): boolean {
  const s = (raw || "").trim();
  if (!s) return true;
  const { city, state } = parseLocation(s);
  return !!state && formatLocation(city, state) === s;
}

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
