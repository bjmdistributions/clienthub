// The Globe tab's data model, kept free of three.js and React so it can be tested.
//
// A client with a pin belongs to a Place (every client at the same coordinate: a
// city, or a state or country centre). Places merge into Clusters by distance, with
// the distance growing as the camera pulls back, so marks never sit on top of each
// other at any zoom. Colour follows the chosen lens; size follows the client count.
import type { BuyerTier, Client } from "../../lib/api";
import { fuzzyState, resolveState, stateName } from "../../lib/location";

// ── Clients ────────────────────────────────────────────────────────────────

export type Precision = "city" | "region" | "country";

export interface ClientRow {
  id: string;
  name: string;
  company: string;
  tier: string;              // P / S / A / B / C / New / Prospect
  highValue: boolean;
  profit: number;            // BuyerTier.total_profit, the figure the Tiers screen leads with
  revenue: number;
  dealsLanded: number;
  lastInvoice: string | null;
  lastContact: string | null;
  cadenceDays: number | null;
  reliability: string;
  nextFollowUp: string | null;
  category: string;
  leadStatus: string;
  city: string;
  state: string;             // as typed
  stateCode: string;         // canonical 2-letter code for a US client, else ""
  country: string;
  region: string;            // "US-NJ" or a country name, "" when unknown
  lat: number | null;
  lng: number | null;
  precision: Precision;
}

export const US_NAMES = new Set(["", "us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);
const CANADA = new Set(["canada", "ca", "can"]);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A US client's state as a 2-letter code ("New Jersey", "nj", "N.J." → "NJ"), else "". */
export function canonicalState(raw: string): string {
  const s = raw.replace(/\./g, "").trim();
  if (!s) return "";
  return resolveState(s) ?? fuzzyState(s) ?? "";
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The region a client rolls up to: "US-NJ" for a US state, the country otherwise. */
export function regionOf(city: string, state: string, country: string): string {
  const c = country.trim().toLowerCase();
  if (US_NAMES.has(c)) {
    const code = canonicalState(state);
    return code ? `US-${code}` : "";
  }
  if (CANADA.has(c)) return "Canada";
  return titleCase(country.trim());
}

export function regionLabel(region: string): string {
  return region.startsWith("US-") ? stateName(region.slice(3)) : region;
}

export function toRows(clients: Client[], tiers: Record<string, BuyerTier>): ClientRow[] {
  return clients.map((c) => {
    const m = c.metadata || {};
    const t = tiers[c.id];
    const city = str(m.city), state = str(m.state), country = str(m.country);
    const lat = Number.isFinite(m.lat) ? m.lat : null;
    const lng = Number.isFinite(m.lng) ? m.lng : null;
    const us = US_NAMES.has(country.toLowerCase());
    return {
      id: c.id,
      name: c.name,
      company: c.company || "",
      tier: t?.tier || "New",
      highValue: !!(c.high_value || m.high_value),
      profit: t?.total_profit ?? 0,
      revenue: c.total_revenue || 0,
      dealsLanded: t?.deals_landed ?? 0,
      lastInvoice: t?.last_invoice_date ?? null,
      lastContact: c.last_contact_at || null,
      cadenceDays: t?.purchase_cadence_days ?? null,
      reliability: t?.reliability || "unrated",
      nextFollowUp: c.next_follow_up_date || str(m.next_follow_up_date) || null,
      category: c.category || "",
      leadStatus: c.lead_status || "",
      city, state, country,
      stateCode: us ? canonicalState(state) : "",
      region: regionOf(city, state, country),
      lat, lng,
      precision: m.geo_precision === "region" ? "region" : m.geo_precision === "country" ? "country" : "city",
    };
  });
}

// "Newark, NJ", or "Paris, France" for a client outside the US.
export function placeLabel(city: string, state: string, country: string): string {
  const abroad = US_NAMES.has(country.trim().toLowerCase()) ? "" : country.trim();
  return [city.trim(), state.trim(), abroad].filter(Boolean).join(", ");
}

// ── Why a client has no pin ────────────────────────────────────────────────
// In the geocoder's own terms (CityLookup::client_pin): a US client needs a city and
// state on the city list, or a good ZIP, or a state alone (approximate); Canada needs
// a known city or province; any other recognized country plots at its centre.

export type MissingReason =
  | "City not recognized" | "Needs a state" | "State not recognized"
  | "Needs a city and state" | "Country not recognized" | "No address";

export const MISSING_ORDER: MissingReason[] = [
  "City not recognized", "Needs a state", "State not recognized",
  "Needs a city and state", "Country not recognized", "No address",
];

export const MISSING_HINT: Record<MissingReason, string> = {
  "City not recognized":    "Check the spelling of the city, or add a ZIP code.",
  "Needs a state":          "Has a city and no state. Add the state.",
  "State not recognized":   "The state is not one the globe knows.",
  "Needs a city and state": "Only the country is on the client.",
  "Country not recognized": "The country is not in the globe's country list.",
  "No address":             "No city, state or country on the client.",
};

export function missingReason(r: Pick<ClientRow, "city" | "state" | "country">): MissingReason {
  const country = r.country.toLowerCase();
  if (!r.city && !r.state && !country) return "No address";
  if (US_NAMES.has(country)) {
    if (r.city && r.state) return "City not recognized";
    if (r.city) return "Needs a state";
    if (r.state) return "State not recognized";
    return "Needs a city and state";
  }
  if (CANADA.has(country)) return "City not recognized";
  return "Country not recognized";
}

// ── Places and clusters ────────────────────────────────────────────────────

export const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect", "New"];
const tierRank = (t: string) => { const i = TIER_ORDER.indexOf(t); return i < 0 ? TIER_ORDER.length : i; };

/** What a mark stands for: one or more clients, with the figures the lenses read. */
export interface Group {
  key: string;
  lat: number;
  lng: number;
  label: string;             // "Newark, NJ", or "Near Newark, NJ" for a cluster of places
  clients: ClientRow[];      // sorted by profit, highest first
  placeCount: number;
  count: number;
  bestTier: string;
  profit: number;
  lastActivity: string | null;
  followUp: FollowUp;
  approximate: boolean;      // every client in it sits on a state or country centre
}

export type FollowUp = "overdue" | "today" | "soon" | "none";

function newest(a: string | null, b: string | null) { return !a ? b : !b ? a : a > b ? a : b; }
const FOLLOW_RANK: Record<FollowUp, number> = { overdue: 0, today: 1, soon: 2, none: 3 };

export function followUpState(date: string | null, today: string): FollowUp {
  if (!date) return "none";
  const d = date.slice(0, 10);
  if (d < today) return "overdue";
  if (d === today) return "today";
  const days = (Date.parse(d) - Date.parse(today)) / 86400000;
  return days <= 7 ? "soon" : "none";
}

function summarise(key: string, lat: number, lng: number, label: string, clients: ClientRow[], placeCount: number, today: string): Group {
  const sorted = [...clients].sort((a, b) => b.profit - a.profit || a.name.localeCompare(b.name));
  let bestTier = "New", profit = 0, lastActivity: string | null = null, followUp: FollowUp = "none";
  for (const c of clients) {
    if (tierRank(c.tier) < tierRank(bestTier)) bestTier = c.tier;
    profit += c.profit;
    lastActivity = newest(lastActivity, newest(c.lastInvoice, c.lastContact));
    const f = followUpState(c.nextFollowUp, today);
    if (FOLLOW_RANK[f] < FOLLOW_RANK[followUp]) followUp = f;
  }
  return {
    key, lat, lng, label, clients: sorted, placeCount, count: clients.length, bestTier, profit,
    lastActivity, followUp, approximate: clients.every((c) => c.precision !== "city"),
  };
}

/** Every pinned client grouped by exact coordinate. */
export function buildPlaces(rows: ClientRow[], today: string): Group[] {
  const byKey = new Map<string, ClientRow[]>();
  for (const r of rows) {
    if (r.lat === null || r.lng === null) continue;
    const key = `${r.lat.toFixed(3)},${r.lng.toFixed(3)}`;
    byKey.set(key, [...(byKey.get(key) || []), r]);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const c = list[0];
    return summarise(key, c.lat!, c.lng!, placeLabel(c.city, c.state, c.country), list, 1, today);
  });
}

const RAD = Math.PI / 180;
/** Great-circle distance in degrees. */
export function arcDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const s = Math.sin((bLat - aLat) * RAD / 2) ** 2
    + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin((bLng - aLng) * RAD / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / RAD;
}

/**
 * Merges marks that would touch, until none do. `room(count)` is the space a mark
 * with that many clients claims around its centre and `dist` the distance between
 * two places, in the same units (degrees on the globe, pixels on the flat map), so
 * a count badge claims more room than a single dot and two badges never overlap.
 * A merged mark sits on its heaviest place rather than drifting to an empty
 * midpoint, and its key is its members' keys, so an unchanged cluster keeps its
 * identity (and its three.js object) across recomputes.
 */
export function clusterPlaces(
  places: Group[], today: string, room: (count: number) => number,
  dist: (a: Group, b: Group) => number = (a, b) => arcDeg(a.lat, a.lng, b.lat, b.lng),
): Group[] {
  type C = { seed: Group; members: Group[]; count: number };
  const cs: C[] = [...places]
    .sort((a, b) => b.count - a.count || b.profit - a.profit || a.key.localeCompare(b.key))
    .map((p) => ({ seed: p, members: [p], count: p.count }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        if (dist(cs[i].seed, cs[j].seed) >= room(cs[i].count) + room(cs[j].count)) continue;
        const [keep, drop] = cs[j].count > cs[i].count ? [cs[j], cs[i]] : [cs[i], cs[j]];
        keep.members.push(...drop.members);
        keep.count += drop.count;
        cs[i] = keep;
        cs.splice(j, 1);
        merged = true;
        j = i; // the grown mark claims more room: check its neighbours again
      }
    }
  }
  return cs.map(({ seed, members }) => {
    if (members.length === 1) return seed;
    const key = members.map((m) => m.key).sort().join("|");
    return summarise(key, seed.lat, seed.lng, `Near ${seed.label}`, members.flatMap((m) => m.clients), members.length, today);
  });
}

// ── Lenses ─────────────────────────────────────────────────────────────────

export type Lens = "tier" | "profit" | "recency" | "followup";

// Tier colours are the app-wide tier identity (TierBadge and friends); keep in step.
export const TIER_RGB: Record<string, string> = {
  P: "167,139,250", S: "56,189,248", A: "251,191,36", B: "199,210,224", C: "224,149,92",
  Prospect: "139,147,168", New: "139,147,168",
};
export const TIER_NAME: Record<string, string> = {
  P: "Platinum", S: "Diamond", A: "Gold", B: "Silver", C: "Bronze", Prospect: "Prospect", New: "New",
};

// Apple system colours, dark appearance.
const GREEN = "48,209,88", YELLOW = "255,214,10", ORANGE = "255,159,10", RED = "255,69,58", BLUE = "10,132,255", GREY = "142,142,147";

export const RECENCY_STEPS: { max: number; rgb: string; label: string }[] = [
  { max: 30, rgb: GREEN, label: "Within 30 days" },
  { max: 90, rgb: YELLOW, label: "31 to 90 days" },
  { max: 180, rgb: ORANGE, label: "91 to 180 days" },
  { max: Infinity, rgb: RED, label: "Over 180 days" },
];
export const FOLLOWUP_RGB: Record<FollowUp, string> = { overdue: RED, today: ORANGE, soon: BLUE, none: GREY };
export const FOLLOWUP_LABEL: Record<FollowUp, string> = {
  overdue: "Follow-up overdue", today: "Follow-up today", soon: "Within 7 days", none: "Nothing due",
};
export const PROFIT_STEPS = ["60,72,92", "31,111,74", "36,138,87", "43,179,107", GREEN];
export const PROFIT_NEGATIVE = RED;
export const NEVER_RGB = GREY;

export function daysSince(date: string | null, today: string): number | null {
  if (!date) return null;
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(date.slice(0, 10))) / 86400000));
}

/** The colour of a mark under a lens. `profitTop` is the largest group profit on screen. */
export function lensRgb(g: Group, lens: Lens, today: string, profitTop: number): string {
  if (lens === "tier") return TIER_RGB[g.bestTier] ?? TIER_RGB.New;
  if (lens === "followup") return FOLLOWUP_RGB[g.followUp];
  if (lens === "recency") {
    const d = daysSince(g.lastActivity, today);
    if (d === null) return NEVER_RGB;
    return RECENCY_STEPS.find((s) => d <= s.max)!.rgb;
  }
  if (g.profit < 0) return PROFIT_NEGATIVE;
  if (g.profit === 0 || profitTop <= 0) return PROFIT_STEPS[0];
  const step = Math.min(4, 1 + Math.floor((g.profit / profitTop) * 3.999));
  return PROFIT_STEPS[step];
}

// ── Regions ────────────────────────────────────────────────────────────────

export interface RegionRow { region: string; label: string; count: number; mapped: number; profit: number }

/** Clients per state (US) or country, including clients the globe cannot pin. */
export function regionRollup(rows: ClientRow[]): RegionRow[] {
  const by = new Map<string, RegionRow>();
  for (const r of rows) {
    if (!r.region) continue;
    const e = by.get(r.region) || { region: r.region, label: regionLabel(r.region), count: 0, mapped: 0, profit: 0 };
    e.count += 1;
    if (r.lat !== null) e.mapped += 1;
    e.profit += r.profit;
    by.set(r.region, e);
  }
  return [...by.values()];
}

/** "Due to reorder": the last invoice plus the usual gap between orders has passed. */
export function dueToReorder(r: ClientRow, today: string): boolean {
  if (!r.lastInvoice || !r.cadenceDays || r.cadenceDays <= 0) return false;
  const d = daysSince(r.lastInvoice, today);
  return d !== null && d > r.cadenceDays;
}
