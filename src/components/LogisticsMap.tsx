import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { api, type FreightMapLoad, type FreightMapRange, type FreightMapResponse, type Me } from "../lib/api";
import { localDay } from "../lib/format";
import { isAdmin } from "../lib/permissions";
import {
  DEFAULT_MAP_RANGE, LOWER_48, MAP_RANGES, NOTHING_PICKED, dayAtStep, groupLanes, headline, laneName, laneNote, laneSummary, lineStyle,
  loadLine, loadsOnOrBefore, mapMarkers, mapProblem, markerRadius, parseMapRange, partialPath, pluralLoads, replayDay, replayPlan,
  replayProgress, sliderDays, sliderReadout, stepOfDay, subLine, type LatLng,
} from "../lib/freightMap";

// R-485: the map of delivered freight. Each delivered load is drawn as the road route Google found between its
// addresses, a busier lane in a thicker line, with the date slider and Replay under it and the lane list below. The rules
// (lanes, weights, the sub line, the replay clock) are lib/freightMap.ts; this file only draws what they return. The
// server fetches and caches the routes and hands the Maps browser key to whoever may open the map.

// ── Google Maps, typed just enough ───────────────────────────────────────
// No npm package: the few calls this screen makes are declared here, and the script is loaded once per window.

interface GBounds { extend(p: LatLng): void }
interface GMap {
  fitBounds(b: GBounds | { south: number; west: number; north: number; east: number }, padding?: number): void;
  addListener(event: string, fn: () => void): unknown;
}
interface GOverlay { setMap(m: GMap | null): void; setOptions(o: Record<string, unknown>): void; addListener(event: string, fn: () => void): unknown }
interface GPolyline extends GOverlay { setPath(p: LatLng[]): void }
interface GoogleMaps {
  Map: new (el: HTMLElement, o: Record<string, unknown>) => GMap;
  Polyline: new (o: Record<string, unknown>) => GPolyline;
  Marker: new (o: Record<string, unknown>) => GOverlay;
  LatLngBounds: new () => GBounds;
  SymbolPath: { CIRCLE: number; FORWARD_CLOSED_ARROW: number };
  geometry: { encoding: { decodePath(s: string): { lat(): number; lng(): number }[] } };
  importLibrary?: (name: string) => Promise<unknown>;
}

let mapsPromise: Promise<GoogleMaps> | null = null;
/** Google calls gm_authFailure when it refuses the browser key (wrong key, or the Maps JavaScript API is off). */
let authFailed = false;
let onAuthFailed: (() => void) | null = null;

function loadGoogleMaps(key: string): Promise<GoogleMaps> {
  if (mapsPromise) return mapsPromise;
  const w = window as unknown as { google?: { maps?: GoogleMaps }; gm_authFailure?: () => void; __ecliptrMapsReady?: () => void };
  const p = new Promise<GoogleMaps>((resolve, reject) => {
    w.gm_authFailure = () => { authFailed = true; onAuthFailed?.(); };
    w.__ecliptrMapsReady = () => {
      const g = w.google?.maps;
      if (!g) { reject(new Error("maps")); return; }
      const libs = typeof g.importLibrary === "function" ? Promise.all(["maps", "marker", "geometry"].map((n) => g.importLibrary!(n))) : Promise.resolve([]);
      libs.then(() => (g.Map && g.Polyline && g.Marker && g.geometry?.encoding ? resolve(g) : reject(new Error("maps")))).catch(reject);
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=geometry&loading=async&callback=__ecliptrMapsReady`;
    s.async = true;
    s.onerror = () => { s.remove(); reject(new Error("maps")); };
    document.head.appendChild(s);
  });
  p.catch(() => { if (mapsPromise === p) mapsPromise = null; });
  mapsPromise = p;
  return p;
}

// ── Colours, read from the theme ─────────────────────────────────────────

/** A token such as --c-step-now ("0 122 255") as the #rrggbb Google wants. */
function cssHex(name: string): string {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  const [r, g, b] = parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : [0, 0, 0];
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
}
const readColors = () => ({ route: cssHex("--c-step-now"), paper: cssHex("--c-map-paper"), ink: cssHex("--c-map-ink") });
type Colors = ReturnType<typeof readColors>;

// ── Drawing state ────────────────────────────────────────────────────────

const RANGE_KEY = "ecliptr_logistics_map_range";
const ROADMAP_STYLES = [{ featureType: "poi", stylers: [{ visibility: "off" }] }, { featureType: "transit", stylers: [{ visibility: "off" }] }];

interface LineEntry { line: GPolyline; path: LatLng[]; poly: string; laneKey: string; shown: boolean; frac: number; sig: string }
interface MarkerEntry { marker: GOverlay; sig: string; laneKeys: string[] }
interface View {
  gm: GoogleMaps | null; map: GMap | null; loads: FreightMapLoad[];
  /** The loads the date slider shows. */
  visible: Set<string>;
  /** Loads on each lane among those shown (a lane's thickness). */
  counts: Map<string, number>;
  /** The picked lane, or null. */
  selected: string | null;
}

/** Jump to the Logistics card in Settings, where the Google keys are kept. */
function openLogisticsSettings() {
  try { localStorage.setItem("clienthub_settings_tab", "splits"); } catch { /* storage blocked: Settings just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "settings" }));
}

export default function LogisticsMap({ me }: { me: Me | null | undefined }) {
  const admin = isAdmin(me);
  const today = localDay();
  const [range, setRange] = useState<FreightMapRange>(() => {
    try { return parseMapRange(localStorage.getItem(RANGE_KEY)); } catch { return DEFAULT_MAP_RANGE; }
  });
  // The last answer, and the range it was asked for: a new range keeps showing the old answer, dimmed, until the new one
  // lands, so the Google map is never torn down and built again just to change the range.
  const [res, setRes] = useState<{ range: FreightMapRange; data: FreightMapResponse } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [gm, setGm] = useState<GoogleMaps | null>(null);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [scriptTry, setScriptTry] = useState(0);
  const [keyRefused, setKeyRefused] = useState(authFailed);
  const [mapEl, setMapEl] = useState<HTMLDivElement | null>(null);
  const [map, setMap] = useState<GMap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The slider's day. null is the end of the slider ("Today"): every load shows. */
  const [at, setAt] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const data = res?.data ?? null;
  const stale = !!res && res.range !== range;
  const key = data?.key ?? "";

  // What was drawn, kept outside React so the replay can move a line every frame without rendering the screen.
  const view = useRef<View>({ gm: null, map: null, loads: [], visible: new Set(), counts: new Map(), selected: null });
  const lines = useRef(new Map<string, LineEntry>());
  const markers = useRef(new Map<string, MarkerEntry>());
  const paths = useRef(new Map<string, LatLng[]>());
  const colors = useRef<Colors | null>(null);
  /** Per load, how much of its route a replay has drawn so far. null when no replay is running. */
  const progress = useRef<Map<string, number> | null>(null);
  const raf = useRef(0);
  /** none: nothing fitted yet; lower48: the empty map; routes: fitted to the routes, and left alone from then on. */
  const fit = useRef<"none" | "lower48" | "routes">("none");

  // ── Ask the server, and again every 3 seconds (ten times at most) while routes are still being found ──
  useEffect(() => {
    let dead = false;
    let timer: number | undefined;
    let polls = 0;
    const run = async () => {
      try {
        const r = await api.logistics.map(range, localDay());
        if (dead) return;
        if (polls === 0) fit.current = "none";
        setRes({ range, data: r });
        setError("");
        if (r.pending > 0 && !r.key_problem && polls < 10) { polls += 1; timer = window.setTimeout(run, 3000); }
      } catch (e) {
        if (!dead) setError(String(e));
      }
    };
    run();
    return () => { dead = true; window.clearTimeout(timer); };
  }, [range, retry]);

  // ── The Google script, once per window ──
  useEffect(() => {
    if (!key) return;
    let dead = false;
    onAuthFailed = () => setKeyRefused(true);
    if (authFailed) setKeyRefused(true);
    loadGoogleMaps(key).then((g) => { if (!dead) { setGm(g); setScriptFailed(false); } }).catch(() => { if (!dead) setScriptFailed(true); });
    return () => { dead = true; onAuthFailed = null; };
  }, [key, scriptTry]);

  const loads = useMemo(() => data?.loads ?? [], [data]);
  const problem = data ? mapProblem({ key: data.key, keyProblem: data.key_problem, loadCount: loads.length, admin, scriptFailed, browserKeyRefused: keyRefused }) : null;
  const showMap = !!data && !problem?.blocks;

  const days = useMemo(() => sliderDays(loads, today), [loads, today]);
  const visible = useMemo(() => (at === null ? loads : loadsOnOrBefore(loads, at)), [loads, at]);
  const lanes = useMemo(() => groupLanes(visible), [visible]);
  const counts = useMemo(() => new Map(lanes.map((l) => [l.key, l.count])), [lanes]);
  const pickedLane = lanes.find((l) => l.key === selected) ?? null;
  const sel = pickedLane ? pickedLane.key : null;
  const plan = useMemo(() => replayPlan(loads), [loads]);

  const pathOf = useCallback((g: GoogleMaps, l: FreightMapLoad): LatLng[] => {
    const id = `${l.id}|${l.route?.polyline ?? ""}`;
    let p = paths.current.get(id);
    if (!p) {
      p = l.route ? g.geometry.encoding.decodePath(l.route.polyline).map((x) => ({ lat: x.lat(), lng: x.lng() })) : [];
      paths.current.set(id, p);
    }
    return p;
  }, []);

  const pickLane = useCallback((laneKeys: string[]) => {
    const c = view.current.counts;
    let best = laneKeys[0];
    for (const k of laneKeys) if ((c.get(k) ?? 0) > (c.get(best) ?? 0)) best = k;
    if (best !== undefined) setSelected((cur) => (cur === best ? null : best));
  }, []);

  const syncLines = useCallback(() => {
    const v = view.current;
    if (!v.gm || !v.map) return;
    const g = v.gm, col = colors.current ?? (colors.current = readColors());
    const prog = progress.current;
    // A line whose load left the answer (a shorter range, or it stopped being ready) comes off the map.
    const ready = new Set<string>();
    for (const l of v.loads) if (l.route_state === "ready" && l.route) ready.add(l.id);
    for (const [id, e] of lines.current) if (!ready.has(id)) { e.line.setMap(null); lines.current.delete(id); }
    for (const l of v.loads) {
      if (l.route_state !== "ready" || !l.route) continue;
      const frac = prog ? prog.get(l.id) ?? 0 : v.visible.has(l.id) ? 1 : 0;
      let e = lines.current.get(l.id);
      // A route fetched again (the addresses changed) is a new line.
      if (e && e.poly !== l.route.polyline) { e.line.setMap(null); lines.current.delete(l.id); e = undefined; }
      if (frac <= 0) { if (e?.shown) { e.line.setMap(null); e.shown = false; } continue; }
      const laneKey = laneName(l);
      if (!e) {
        const path = pathOf(g, l);
        const line = new g.Polyline({ path, strokeColor: col.route, clickable: true });
        line.addListener("click", () => { const cur = lines.current.get(l.id); if (cur) setSelected((now) => (now === cur.laneKey ? null : cur.laneKey)); });
        e = { line, path, poly: l.route.polyline, laneKey, shown: false, frac: 1, sig: "" };
        lines.current.set(l.id, e);
      }
      e.laneKey = laneKey;
      if (e.frac !== frac) { e.line.setPath(frac >= 1 ? e.path : partialPath(e.path, frac)); e.frac = frac; }
      const st = lineStyle(v.counts.get(laneKey) ?? 1, laneKey, v.selected);
      const sig = `${st.weight}|${st.opacity}|${frac >= 1 ? 1 : 0}|${v.selected === laneKey ? 1 : 0}`;
      if (e.sig !== sig) {
        // One arrow at the middle, white inside a ring of the line's blue so it shows on the line it points along.
        const arrow = { path: g.SymbolPath.FORWARD_CLOSED_ARROW, scale: Math.max(3, st.weight * 0.8 + 1), strokeColor: col.route, strokeWeight: 1, strokeOpacity: st.opacity, fillColor: col.paper, fillOpacity: st.opacity };
        e.line.setOptions({
          strokeColor: col.route, strokeWeight: st.weight, strokeOpacity: st.opacity, zIndex: v.selected === laneKey ? 3 : 1,
          icons: frac >= 1 ? [{ icon: arrow, offset: "50%" }] : [],
        });
        e.sig = sig;
      }
      if (!e.shown) { e.line.setMap(v.map); e.shown = true; }
    }
  }, [pathOf]);

  const syncMarkers = useCallback(() => {
    const v = view.current;
    if (!v.gm || !v.map) return;
    const g = v.gm, col = colors.current ?? (colors.current = readColors());
    const prog = progress.current;
    const drawn = v.loads.filter((l) => l.route_state === "ready" && (prog ? (prog.get(l.id) ?? 0) > 0 : v.visible.has(l.id)));
    const keep = new Set<string>();
    for (const m of mapMarkers(drawn)) {
      keep.add(m.key);
      const r = markerRadius(m);
      const dim = v.selected !== null && !m.laneKeys.includes(v.selected);
      const sig = `${r}|${dim ? 1 : 0}`;
      let e = markers.current.get(m.key);
      if (!e) {
        const marker = new g.Marker({ position: { lat: m.lat, lng: m.lng }, map: v.map, title: m.label, zIndex: m.kind === "delivery" ? 20 : 10 });
        const key = m.key;
        marker.addListener("click", () => { const cur = markers.current.get(key); if (cur) pickLane(cur.laneKeys); });
        e = { marker, sig: "", laneKeys: m.laneKeys };
        markers.current.set(m.key, e);
      }
      e.laneKeys = m.laneKeys;
      if (e.sig !== sig) {
        const delivery = m.kind === "delivery";
        e.marker.setOptions({
          opacity: dim ? 0.35 : 1,
          icon: {
            path: g.SymbolPath.CIRCLE, scale: r, fillOpacity: 1, strokeWeight: 2,
            fillColor: delivery ? col.route : col.paper, strokeColor: delivery ? col.paper : col.ink,
          },
        });
        e.sig = sig;
      }
    }
    for (const [k, e] of markers.current) if (!keep.has(k)) { e.marker.setMap(null); markers.current.delete(k); }
  }, [pickLane]);

  const syncAll = useCallback(() => { syncLines(); syncMarkers(); }, [syncLines, syncMarkers]);

  // The Google map itself, built when its box is on screen and the script is in.
  useEffect(() => {
    if (!gm || !mapEl) return;
    colors.current = readColors();
    const phone = window.matchMedia?.("(pointer: coarse)").matches;
    const m = new gm.Map(mapEl, {
      center: { lat: 39.5, lng: -98.35 }, zoom: 4, styles: ROADMAP_STYLES, clickableIcons: false,
      mapTypeControl: false, streetViewControl: false, gestureHandling: phone ? "greedy" : "auto",
    });
    m.addListener("click", () => setSelected(null));
    fit.current = "none";
    setMap(m);
    const drawnLines = lines.current, drawnMarkers = markers.current;
    return () => {
      for (const e of drawnLines.values()) e.line.setMap(null);
      for (const e of drawnMarkers.values()) e.marker.setMap(null);
      drawnLines.clear(); drawnMarkers.clear();
      setMap(null);
    };
  }, [gm, mapEl]);

  // Fit the map to the routes the first time any is ready, and show the lower 48 until then. After that a poll redraws and
  // leaves the map where the person put it.
  useEffect(() => {
    if (!gm || !map || !data) return;
    const ready = data.loads.filter((l) => l.route_state === "ready" && l.route);
    if (ready.length && fit.current !== "routes") {
      const b = new gm.LatLngBounds();
      let n = 0;
      for (const l of ready) for (const p of pathOf(gm, l)) { b.extend(p); n += 1; }
      if (n) { map.fitBounds(b, 48); fit.current = "routes"; }
    } else if (!ready.length && fit.current === "none") {
      map.fitBounds(LOWER_48, 24);
      fit.current = "lower48";
    }
  }, [gm, map, data, pathOf]);

  // Draw whatever changed: the loads, the slider, the picked lane.
  useEffect(() => {
    view.current = { gm, map, loads, visible: new Set(visible.map((l) => l.id)), counts, selected: sel };
    syncAll();
  }, [gm, map, loads, visible, counts, sel, syncAll]);

  // ── Replay ──
  const stopReplay = useCallback((finished = false) => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    progress.current = null;
    setPlaying(false);
    if (finished) setAt(null);
    syncAll();
  }, [syncAll]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); }, []);

  const startReplay = () => {
    if (!plan.length) return;
    const total = plan[plan.length - 1].endMs;
    setSelected(null);
    progress.current = new Map(plan.map((s) => [s.id, 0]));
    setAt(replayDay(plan, 0));
    setPlaying(true);
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = progress.current;
      if (!p) return;
      const t = now - t0;
      for (const s of plan) p.set(s.id, replayProgress(s, t));
      setAt(replayDay(plan, t));
      syncAll();
      if (t >= total) { stopReplay(true); return; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const pickRange = (r: FreightMapRange) => {
    if (r === range) return;
    stopReplay();
    setRange(r);
    setSelected(null);
    setAt(null);
    try { localStorage.setItem(RANGE_KEY, r); } catch { /* storage blocked: the choice just is not remembered */ }
  };

  const step = stepOfDay(days, at);
  const canReplay = showMap && !!map && plan.length > 0;

  return (
    <div className="space-y-5 min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="How far back">
          {MAP_RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => pickRange(r.key)}
              className={`h-9 px-4 rounded-full border text-[15px] whitespace-nowrap transition-colors duration-[130ms] ${range === r.key ? "border-step-now bg-step-now/10 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
              {r.label}
            </button>
          ))}
        </div>
        <button type="button" disabled={!canReplay} onClick={() => (playing ? stopReplay() : startReplay())}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border border-line bg-surface text-[15px] font-medium text-ink hover:bg-surface-2 transition-colors duration-[130ms] disabled:opacity-40 disabled:hover:bg-surface">
          {playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Pause" : "Replay"}
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[15px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => { setError(""); setRetry((n) => n + 1); }} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}

      {data ? (
        <div className={`min-w-0 transition-opacity duration-[130ms] ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
          <h2 className="text-[30px] leading-tight font-semibold text-ink tracking-tight tabular-nums">{headline(loads.length)}</h2>
          <p className="text-[17px] text-ink-2 mt-1">{subLine(loads, res?.range ?? range)}</p>
        </div>
      ) : !error ? (
        <div className="space-y-2" aria-busy="true">
          <div className="h-9 w-64 bg-surface-2 rounded-md animate-pulse" />
          <div className="h-5 w-80 max-w-full bg-surface-2 rounded-md animate-pulse" />
        </div>
      ) : null}

      {problem && !problem.blocks && (
        <div className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[15px] text-warning-ink" role="status">{problem.text}</div>
      )}

      {showMap ? (
        <div ref={setMapEl} className="h-[560px] max-h-[75vh] w-full rounded-xl border border-line overflow-hidden bg-surface-2" aria-label="Map of delivered freight" />
      ) : data && problem ? (
        <div className="rounded-xl border border-line bg-surface-2 min-h-[240px] px-6 py-10 flex flex-col items-center justify-center gap-4 text-center">
          <p className="text-[17px] text-ink-2 max-w-md">{problem.text}</p>
          {admin && (!data.key || keyRefused) && (
            <button type="button" onClick={openLogisticsSettings}
              className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-10 rounded-lg text-[15px] font-medium transition-colors">Open settings</button>
          )}
          {scriptFailed && !!data.key && !keyRefused && (
            <button type="button" onClick={() => { setScriptFailed(false); setScriptTry((n) => n + 1); }}
              className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-10 rounded-lg text-[15px] font-medium transition-colors">Try again</button>
          )}
        </div>
      ) : !error ? (
        <div className="h-[560px] max-h-[75vh] rounded-xl bg-surface-2 animate-pulse" />
      ) : null}

      {data && loads.length > 0 && (
        <div className="space-y-4">
          {showMap && (
            <div className="flex items-center gap-4">
              <input
                type="range" min={0} max={Math.max(0, days.length - 1)} step={1} value={step} disabled={days.length < 2}
                aria-label="Show loads delivered up to" aria-valuetext={sliderReadout(at, today)}
                onChange={(e) => { if (playing) stopReplay(); setAt(dayAtStep(days, Number(e.target.value))); }}
                className="flex-1 min-w-0 h-6 cursor-pointer disabled:cursor-default"
                style={{ accentColor: "rgb(var(--c-step-now))" }}
              />
              <span className="text-[17px] font-medium text-ink tabular-nums w-28 text-right flex-shrink-0">{sliderReadout(at, today)}</span>
            </div>
          )}

          {pickedLane ? (
            <div aria-live="polite">
              <div className="text-[19px] font-semibold text-ink">{pickedLane.name}</div>
              <div className="text-[17px] text-ink-2 mt-0.5">{laneSummary(pickedLane, today)}</div>
              <ul className="mt-2 space-y-1">
                {pickedLane.loads.map((l) => <li key={l.id} className="text-[17px] text-ink tabular-nums">{loadLine(l, today)}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-[17px] text-muted">{NOTHING_PICKED}</p>
          )}

          <section className="bg-surface border border-line rounded-xl overflow-hidden divide-y divide-line">
            {lanes.map((l) => {
              const note = laneNote(l);
              return (
                <button key={l.key} type="button" aria-pressed={sel === l.key} onClick={() => setSelected((cur) => (cur === l.key ? null : l.key))}
                  className={`w-full text-left flex items-baseline justify-between gap-4 px-4 py-3 transition-colors duration-[130ms] ${sel === l.key ? "bg-step-now/10" : "hover:bg-surface-2/60"}`}>
                  <span className="min-w-0">
                    <span className={`block text-[17px] text-ink ${sel === l.key ? "font-medium" : ""}`}>{l.name}</span>
                    {note && <span className="block text-[17px] text-muted">{note}</span>}
                  </span>
                  <span className="text-[17px] text-ink-2 tabular-nums whitespace-nowrap flex-shrink-0">{pluralLoads(l.count)}</span>
                </button>
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}
