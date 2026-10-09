import type { FreightMapLoad, FreightMapRange, FreightMapRouteState } from "./api";
import { can, type Perms } from "./permissions";

// R-485: the delivered-freight map in Logistics. Every rule the screen follows lives here as a pure function, so the
// website (www/app.js) can carry the same rules under the same names (laneName, groupLanes, loadsOnOrBefore,
// laneWeight, roadMiles, statesOf, subLine, loadLine, laneSummary, replayPlan and the rest) and a vitest run can hold
// them. LogisticsMap.tsx only draws what these return.

// ── Range ────────────────────────────────────────────────────────────────

export const MAP_RANGES: { key: FreightMapRange; label: string; phrase: string }[] = [
  { key: "30d", label: "30 days", phrase: "last 30 days" },
  { key: "90d", label: "90 days", phrase: "last 90 days" },
  { key: "year", label: "This year", phrase: "this year" },
  { key: "all", label: "All time", phrase: "all time" },
];
export const DEFAULT_MAP_RANGE: FreightMapRange = "90d";

/** The range a person last picked, or 90 days for anything else (nothing stored, or a value this version does not know). */
export function parseMapRange(v: unknown): FreightMapRange {
  return MAP_RANGES.some((r) => r.key === v) ? (v as FreightMapRange) : DEFAULT_MAP_RANGE;
}

/** Who sees the Map switch: whoever may see load addresses (the server's own rule: `deal_flow:view` or
 *  `logistics:view_addresses`, a wildcard holder included). The server answers 403 to anyone else. */
export function canViewFreightMap(me: Perms | null | undefined): boolean {
  return can(me, "deal_flow:view") || can(me, "logistics:view_addresses");
}

/** The lower 48, for a map with no route to fit yet. */
export const LOWER_48 = { south: 24.4, west: -125.0, north: 49.6, east: -66.9 };

// ── Days ─────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Oct 3". With `today` given, a day in another year says its year ("Oct 3, 2025"), so All time never reads wrong. */
export function dayLabel(day: string, today?: string): string {
  const m = DAY_RE.exec(day || "");
  if (!m) return day || "";
  const base = `${MONTHS[+m[2] - 1] ?? m[2]} ${+m[3]}`;
  return today && today.slice(0, 4) !== m[1] ? `${base}, ${m[1]}` : base;
}

const toUtc = (day: string): number => { const m = DAY_RE.exec(day)!; return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Every calendar day from `first` to `last` inclusive, as YYYY-MM-DD. */
function daysBetween(first: string, last: string): string[] {
  if (!DAY_RE.test(first) || !DAY_RE.test(last) || first > last) return [first].filter((d) => DAY_RE.test(d));
  const out: string[] = [];
  for (let t = toUtc(first); t <= toUtc(last); t += 86_400_000) out.push(fromUtc(t));
  return out;
}

// ── Lanes ────────────────────────────────────────────────────────────────

/** The lane a load belongs to: "Reno, NV to Dallas, TX". Loads on the same lane share one line and one row. */
export function laneName(l: FreightMapLoad): string {
  return (l.lane || "").trim() || [l.from, l.to].map((s) => (s || "").trim()).filter(Boolean).join(" to ") || l.load_number || l.id;
}

/** What a lane says about its routes: `ready` if any is drawn, else `pending` if any is still being found, else
 *  `failed` if any has no road route, else `no_key` (the company has no route key yet, or the key was refused). */
export function laneState(loads: { route_state: FreightMapRouteState }[]): FreightMapRouteState {
  for (const s of ["ready", "pending", "failed"] as const) if (loads.some((l) => l.route_state === s)) return s;
  return "no_key";
}

export interface MapLane {
  key: string; name: string;
  /** Newest first. */
  loads: FreightMapLoad[];
  count: number;
  /** The newest delivered day on the lane. */
  lastDay: string;
  state: FreightMapRouteState;
}

/** Newest delivered day first; the same day keeps the order the server sent. */
const newestFirst = (loads: FreightMapLoad[]): FreightMapLoad[] =>
  loads.map((l, i) => [l, i] as const).sort((a, b) => b[0].day.localeCompare(a[0].day) || a[1] - b[1]).map(([l]) => l);

/** The lane list: one row per lane, the busiest first, then the newest, then by name. */
export function groupLanes(loads: FreightMapLoad[]): MapLane[] {
  const by = new Map<string, FreightMapLoad[]>();
  for (const l of loads) {
    const k = laneName(l);
    const list = by.get(k);
    if (list) list.push(l); else by.set(k, [l]);
  }
  return [...by.entries()]
    .map(([key, list]): MapLane => {
      const sorted = newestFirst(list);
      return { key, name: key, loads: sorted, count: sorted.length, lastDay: sorted[0].day, state: laneState(sorted) };
    })
    .sort((a, b) => b.count - a.count || b.lastDay.localeCompare(a.lastDay) || a.name.localeCompare(b.name));
}

/** The muted line under a lane that has no line on the map. */
export function laneNote(lane: Pick<MapLane, "state">): string {
  if (lane.state === "failed") return "Route not found, check the addresses";
  if (lane.state === "pending") return "Finding the route";
  if (lane.state === "no_key") return "Waiting for the route key";
  return "";
}

// ── The slider ───────────────────────────────────────────────────────────

/** The loads delivered on or before `day` (the date slider's reading). */
export function loadsOnOrBefore(loads: FreightMapLoad[], day: string): FreightMapLoad[] {
  return loads.filter((l) => l.day <= day);
}

/** The slider's steps: every day from the first delivery to today. Empty when nothing was delivered. */
export function sliderDays(loads: FreightMapLoad[], today: string): string[] {
  if (!loads.length) return [];
  const days = loads.map((l) => l.day).filter((d) => DAY_RE.test(d)).sort();
  if (!days.length) return [];
  const last = DAY_RE.test(today) && today > days[days.length - 1] ? today : days[days.length - 1];
  return daysBetween(days[0], last);
}

/** The slider's reading at a step: `null` at the end, which shows every load (and reads "Today"). */
export function dayAtStep(days: string[], step: number): string | null {
  return step >= days.length - 1 ? null : days[Math.max(0, step)] ?? null;
}

/** The slider's step for a reading (`null` is the last step). */
export function stepOfDay(days: string[], at: string | null): number {
  if (at === null) return Math.max(0, days.length - 1);
  let step = 0;
  for (let i = 0; i < days.length; i++) if (days[i] <= at) step = i;
  return step;
}

/** The date beside the slider. */
export function sliderReadout(at: string | null, today: string): string {
  return at === null ? "Today" : dayLabel(at, today);
}

// ── Numbers ──────────────────────────────────────────────────────────────

/** A line's thickness: 3 for a lane with one load, 1.5 thicker for each further load, never more than 9. */
export function laneWeight(loadsOnLane: number): number {
  return Math.min(9, 3 + 1.5 * (Math.max(1, loadsOnLane) - 1));
}
export const SELECTED_EXTRA_WEIGHT = 2;
export const LINE_OPACITY = { normal: 0.85, selected: 1, dim: 0.15 } as const;

/** The line a lane draws, given how many of its loads show and which lane is picked (null: none). */
export function lineStyle(loadsOnLane: number, laneKey: string, selected: string | null): { weight: number; opacity: number } {
  const w = laneWeight(loadsOnLane);
  if (selected === null) return { weight: w, opacity: LINE_OPACITY.normal };
  return selected === laneKey ? { weight: w + SELECTED_EXTRA_WEIGHT, opacity: LINE_OPACITY.selected } : { weight: w, opacity: LINE_OPACITY.dim };
}

/** Road miles over the loads whose route is ready, rounded. 0 when none is. */
export function roadMiles(loads: FreightMapLoad[]): number {
  let sum = 0;
  for (const l of loads) if (l.route_state === "ready" && l.route && l.route.miles > 0) sum += l.route.miles;
  return Math.round(sum);
}

const US_STATES = new Set((
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
).split(" "));

/** The states a set of loads touches, read from the "City, ST" stop labels. A label that does not read that way adds none. */
export function statesOf(loads: FreightMapLoad[]): string[] {
  const out = new Set<string>();
  for (const l of loads) {
    const labels = l.stops.length ? l.stops.map((s) => s.label) : [l.from, l.to];
    for (const label of labels) {
      const m = /,\s*([A-Za-z]{2})\s*$/.exec(label || "");
      const st = m ? m[1].toUpperCase() : "";
      if (US_STATES.has(st)) out.add(st);
    }
  }
  return [...out].sort();
}

// ── Words ────────────────────────────────────────────────────────────────

export const pluralLoads = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "load" : "loads"}`;

/** The big line: "26 loads delivered". */
export const headline = (n: number): string => `${pluralLoads(n)} delivered`;

export const milesText = (n: number): string => `${Math.round(n).toLocaleString("en-US")} road ${Math.round(n) === 1 ? "mile" : "miles"}`;

/** Drive time to the nearest hour, a half hour rounding down: 1110 minutes is "about 18 hours". */
export function durationText(minutes: number): string {
  if (!(minutes > 0)) return "";
  if (minutes < 60) { const m = Math.max(1, Math.round(minutes)); return `about ${m} ${m === 1 ? "minute" : "minutes"}`; }
  const h = Math.ceil(minutes / 60 - 0.5);
  return `about ${h} ${h === 1 ? "hour" : "hours"}`;
}

/** The line under the headline: "to 9 states, 18,240 road miles, last 90 days". Says nothing about states or miles it does not know. */
export function subLine(loads: FreightMapLoad[], range: FreightMapRange): string {
  const parts: string[] = [];
  const states = statesOf(loads).length;
  if (states > 0) parts.push(`to ${states} ${states === 1 ? "state" : "states"}`);
  const miles = roadMiles(loads);
  if (miles > 0) parts.push(milesText(miles));
  parts.push(MAP_RANGES.find((r) => r.key === range)?.phrase ?? "");
  return parts.filter(Boolean).join(", ");
}

/** Under a lane's name: "3 loads, last delivered Oct 3". */
export function laneSummary(lane: Pick<MapLane, "count" | "lastDay">, today?: string): string {
  return `${pluralLoads(lane.count)}, last delivered ${dayLabel(lane.lastDay, today)}`;
}

/** One load under its lane: "LD-1042, Oct 3, Swift, 1,234 road miles, about 18 hours". Leaves out what it does not have. */
export function loadLine(l: FreightMapLoad, today?: string): string {
  const ready = l.route_state === "ready" && l.route;
  return [
    l.load_number, dayLabel(l.day, today), (l.carrier || "").trim(),
    ready && l.route!.miles > 0 ? milesText(l.route!.miles) : "",
    ready ? durationText(l.route!.minutes) : "",
  ].filter(Boolean).join(", ");
}

export const NOTHING_PICKED = "Tap a line or a lane to see its loads.";
export const NO_KEY_ADMIN = "Add your free OpenRouteService key in Settings to draw the road routes.";
export const NO_KEY_OTHER = "Ask an admin to add the route key.";
export const KEY_REFUSED_OTHER = "Ask an admin to check the route key.";
export const NO_LOADS = "No loads delivered in this range.";
export const SCRIPT_FAILED = "The map could not load. Check your connection.";

/** Whether the company still has no working route key: some load is waiting on one and the server did not say the key was
 *  refused (a refusal has its own sentence, `key_problem`). The map itself needs no key, so this never hides it. */
export function waitingForRouteKey(loads: { route_state: FreightMapRouteState }[], keyProblem: string): boolean {
  return !keyProblem && loads.some((l) => l.route_state === "no_key");
}

export interface MapProblem {
  text: string;
  /** There is no map to show: this sentence stands in its place. */
  blocks: boolean;
  /** The map still draws and the sentence sits over it (with an Open settings button for an admin). Otherwise a banner above it. */
  onMap: boolean;
}

/** The plain sentence that stands in for the map, sits over it or above it. `waitingForKey` is `waitingForRouteKey(...)`. */
export function mapProblem(o: { waitingForKey: boolean; keyProblem: string; loadCount: number; admin: boolean; scriptFailed: boolean }): MapProblem | null {
  // Nothing delivered needs no map, so a failed map library does not matter then. Same order as the website's FM.mapProblem.
  if (o.loadCount === 0) return { text: NO_LOADS, blocks: true, onMap: false };
  if (o.scriptFailed) return { text: SCRIPT_FAILED, blocks: true, onMap: false };
  if (o.keyProblem) return { text: o.admin ? o.keyProblem : KEY_REFUSED_OTHER, blocks: false, onMap: false };
  if (o.waitingForKey) return { text: o.admin ? NO_KEY_ADMIN : NO_KEY_OTHER, blocks: false, onMap: true };
  return null;
}

// ── Markers ──────────────────────────────────────────────────────────────

export interface MapMarker {
  key: string; kind: "pickup" | "delivery"; label: string; lat: number; lng: number;
  /** How many loads stop here. Deliveries to one city share one marker. */
  count: number;
  /** The lanes that stop here, in the order given to `mapMarkers`. */
  laneKeys: string[];
}

/** Where each stop of a ready load sits: `points` holds one [lat, lng] per stop, in order, and the last stop is the
 *  delivery. A load with more stops than points (extra pickups past the route's 50-stop limit) keeps the stops it has a point for. */
export function stopPoints(l: FreightMapLoad): { kind: "pickup" | "delivery"; label: string; lat: number; lng: number }[] {
  const pts = l.route?.points ?? [];
  if (l.route_state !== "ready" || pts.length < 2 || l.stops.length < 2) return [];
  const out: { kind: "pickup" | "delivery"; label: string; lat: number; lng: number }[] = [];
  l.stops.forEach((s, i) => {
    const p = i === l.stops.length - 1 ? pts[pts.length - 1] : i < pts.length - 1 ? pts[i] : null;
    if (p) out.push({ kind: s.kind, label: s.label, lat: p[0], lng: p[1] });
  });
  return out;
}

/** One marker per place and kind: every pickup in Reno is one pickup marker, every delivery to Dallas is one bigger one. */
export function mapMarkers(loads: FreightMapLoad[]): MapMarker[] {
  const by = new Map<string, MapMarker>();
  for (const l of loads) {
    const lane = laneName(l);
    const seen = new Set<string>();
    for (const p of stopPoints(l)) {
      const key = `${p.kind}|${p.label.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = by.get(key);
      if (m) { m.count += 1; if (!m.laneKeys.includes(lane)) m.laneKeys.push(lane); }
      else by.set(key, { key, kind: p.kind, label: p.label, lat: p.lat, lng: p.lng, count: 1, laneKeys: [lane] });
    }
  }
  return [...by.values()];
}

/** A marker's radius in pixels: deliveries a little larger than pickups, and a shared delivery larger again. */
export function markerRadius(m: Pick<MapMarker, "kind" | "count">): number {
  if (m.kind === "pickup") return 6;
  return Math.min(11, 7 + Math.min(4, Math.max(0, m.count - 1)));
}

// ── Replay ───────────────────────────────────────────────────────────────

export interface ReplayStep { id: string; day: string; startMs: number; endMs: number }

/** The deliveries a replay draws, in date order over about eight seconds, each route taking about 0.8 of one. Only a load
 *  with a ready route has something to draw. The first starts at once and the last ends exactly at the total. */
export function replayPlan(loads: FreightMapLoad[], totalMs = 8000, drawMs = 800): ReplayStep[] {
  const ready = loads
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.route_state === "ready" && l.route)
    .sort((a, b) => a[0].day.localeCompare(b[0].day) || a[1] - b[1])
    .map(([l]) => l);
  const draw = Math.min(drawMs, totalMs);
  const gap = ready.length > 1 ? (totalMs - draw) / (ready.length - 1) : 0;
  return ready.map((l, i) => ({ id: l.id, day: l.day, startMs: Math.round(i * gap), endMs: Math.round(i * gap + draw) }));
}

/** How much of a step's route is drawn at `t` milliseconds: 0 before it starts, 1 once it ends. */
export function replayProgress(step: Pick<ReplayStep, "startMs" | "endMs">, t: number): number {
  if (t <= step.startMs) return 0;
  if (t >= step.endMs) return 1;
  return (t - step.startMs) / (step.endMs - step.startMs);
}

/** The day the slider shows at `t`: the delivery day of the latest route that has started, else the first one's. */
export function replayDay(plan: ReplayStep[], t: number): string | null {
  if (!plan.length) return null;
  let day = plan[0].day;
  for (const s of plan) if (s.startMs <= t) day = s.day;
  return day;
}

// ── A path, partly drawn ─────────────────────────────────────────────────

export interface LatLng { lat: number; lng: number }

/** An encoded polyline as points. It is the encoding Google published and OpenRouteService answers with; `precision` is the
 *  decimal places the coordinates were rounded to (5 for the routes the server stores). A string cut short ends the path
 *  at the last whole point, and an empty or garbled one gives an empty path. */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let i = 0, lat = 0, lng = 0;
  const next = (): number | null => {
    let result = 0, shift = 0, b: number;
    do {
      if (i >= encoded.length || shift > 30) return null;
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

const rad = (d: number) => (d * Math.PI) / 180;
function metres(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The first `frac` of a path by length, ending on an interpolated point. 0 gives a single point, 1 gives the whole path. */
export function partialPath(path: LatLng[], frac: number): LatLng[] {
  if (path.length < 2 || frac >= 1) return path;
  if (frac <= 0) return path.slice(0, 1);
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + metres(path[i - 1], path[i]));
  const target = cum[cum.length - 1] * frac;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (target - cum[i - 1]) / span : 0;
  const a = path[i - 1], b = path[i];
  return [...path.slice(0, i), { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }];
}
