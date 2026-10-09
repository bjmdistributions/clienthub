import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { api, type FreightMapLoad, type FreightMapRange, type FreightMapResponse, type Me } from "../lib/api";
import { localDay } from "../lib/format";
import { isAdmin } from "../lib/permissions";
import {
  DEFAULT_MAP_RANGE, LOWER_48, MAP_RANGES, NOTHING_PICKED, dayAtStep, decodePolyline, groupLanes, headline, laneName, laneNote,
  laneSummary, lineStyle, loadLine, loadsOnOrBefore, mapMarkers, mapProblem, markerRadius, parseMapRange, partialPath, pluralLoads,
  replayDay, replayPlan, replayProgress, SCRIPT_FAILED, sliderDays, sliderReadout, stepOfDay, subLine, waitingForRouteKey, type LatLng,
} from "../lib/freightMap";
import { mix, recolor, type Rgb, type StyleJson } from "../lib/freightMapStyle";

// R-485: the map of delivered freight. Each delivered load is drawn as the road route the server found between its
// addresses, a busier lane in a thicker line, with the date slider and Replay under it and the lane list below. The rules
// (lanes, weights, the sub line, the replay clock) are lib/freightMap.ts; the basemap's colours are lib/freightMapStyle.ts;
// this file only draws what they return. The map is MapLibre on OpenFreeMap's free tiles, so it needs no key; the road
// routes come from the server, which asks OpenRouteService with the company's route key and caches every answer.

// ── MapLibre, loaded the first time the Map opens ────────────────────────
// A dynamic import so the library (and its stylesheet and worker) is a chunk of its own and the main bundle does not grow.
// The worker is given its URL outright: MapLibre otherwise finds it next to its own module, which a bundled app, the dev
// server's pre-bundling and a `tauri://` page cannot all be trusted to keep.

type MapLibre = typeof import("maplibre-gl");
let libPromise: Promise<MapLibre> | null = null;

function loadMapLibre(): Promise<MapLibre> {
  if (libPromise) return libPromise;
  const p = Promise.all([
    import("maplibre-gl"),
    import("maplibre-gl/dist/maplibre-gl.css"),
    import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
  ]).then(([lib, , worker]) => {
    lib.setWorkerUrl(worker.default);
    return lib;
  });
  p.catch(() => { if (libPromise === p) libPromise = null; });
  libPromise = p;
  return p;
}

// ── The basemap: OpenFreeMap's two styles, recoloured as Ecliptr's ───────

const STYLE_URL = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" } as const;
const styles = new Map<"light" | "dark", Promise<StyleJson>>();

function loadStyle(dark: boolean): Promise<StyleJson> {
  const k = dark ? "dark" : "light";
  let p = styles.get(k);
  if (!p) {
    const q: Promise<StyleJson> = fetch(STYLE_URL[k]).then((r) => {
      if (!r.ok) throw new Error("style");
      return r.json() as Promise<StyleJson>;
    });
    q.catch(() => { if (styles.get(k) === q) styles.delete(k); });
    styles.set(k, q);
    p = q;
  }
  return p;
}

// ── Colours, read from the theme ─────────────────────────────────────────

/** A token such as --c-step-now ("0 122 255") as red, green and blue. */
function cssRgb(name: string): Rgb {
  const parts = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts.map((n) => Math.max(0, Math.min(255, Math.round(n)))) as Rgb) : [0, 0, 0];
}
const hex = (c: Rgb) => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

const isDark = () => document.documentElement.classList.contains("dark");

function readColors() {
  const dark = isDark();
  const route = cssRgb("--c-step-now"), ink = cssRgb("--c-ink");
  // The land is the page's own surface colour; on the dark map it is lifted a little so it never reads as black.
  const land = dark ? mix(cssRgb("--c-surface-3"), ink, 0.12) : cssRgb("--c-surface-2");
  const water = mix(land, mix(route, ink, dark ? 0.1 : 0.3), dark ? 0.2 : 0.16);
  return { dark, route: hex(route), paper: hex(cssRgb("--c-map-paper")), ink: hex(cssRgb("--c-map-ink")), land, water };
}
type Colors = ReturnType<typeof readColors>;

/** What changes the map's look: the dark switch, and Mono (which moves the surface tokens). */
const themeKey = () => `${isDark() ? "dark" : "light"}|${document.documentElement.classList.contains("matte") ? "mono" : "color"}`;

// ── Drawing state ────────────────────────────────────────────────────────

const RANGE_KEY = "ecliptr_logistics_map_range";
const ROUTES = "freight-routes", STOPS = "freight-stops";
const LINES = "freight-lines", ARROWS = "freight-arrows", DOTS = "freight-dots";
const ARROW_IMAGE = "freight-arrow";
const ARROW_PX = 24;
const ROUTES_CREDIT = "Routes © openrouteservice.org";

type Coord = [number, number];
/** A route as the map draws it: the points for partialPath, and the same as [lng, lat] for GeoJSON. */
interface Geo { path: LatLng[]; coords: Coord[] }
/** What the map has been given for one load. */
interface LineState { poly: string; frac: number; sig: string }
interface View {
  map: MapLibreMap | null; loads: FreightMapLoad[];
  /** The loads the date slider shows. */
  visible: Set<string>;
  /** Loads on each lane among those shown (a lane's thickness). */
  counts: Map<string, number>;
  /** The picked lane, or null. */
  selected: string | null;
}

/** Jump to the Logistics card in Settings, where the route key is kept. */
function openLogisticsSettings() {
  try { localStorage.setItem("clienthub_settings_tab", "splits"); } catch { /* storage blocked: Settings just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "settings" }));
}

/** The small arrow laid along each line: white inside a ring of the line's blue, so it shows on the line it points along. */
function arrowImage(c: Colors): ImageData {
  const px = 2;
  const cv = document.createElement("canvas");
  cv.width = cv.height = ARROW_PX * px;
  const g = cv.getContext("2d")!;
  g.scale(px, px);
  g.lineJoin = "round";
  g.lineWidth = 2.4;
  g.fillStyle = c.paper;
  g.strokeStyle = c.route;
  g.beginPath();
  g.moveTo(6, 5); g.lineTo(19, 12); g.lineTo(6, 19); g.lineTo(9.5, 12);
  g.closePath();
  g.fill();
  g.stroke();
  return g.getImageData(0, 0, ARROW_PX * px, ARROW_PX * px);
}

/** MapLibre throws from inside its camera and drawing calls (a NaN corner, a context lost). Without this the throw takes the
 *  whole Logistics screen down; with it, the map says it could not load and the rest of the page stays. */
class MapCatch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="rounded-xl border border-line bg-surface px-4 py-6 text-[17px] text-muted">{SCRIPT_FAILED}</div>
      : this.props.children;
  }
}

/** fitBounds with more padding than the box has room for (a narrow window) gives MapLibre a NaN camera and it throws. The
 *  padding shrinks to a quarter of the box, a box too small to fit anything is skipped, and a throw leaves the camera as it
 *  is. Returns whether the fit happened, so a skipped fit is tried again on the next redraw. */
function safeFit(map: MapLibreMap, bounds: [[number, number], [number, number]], padding: number, maxZoom?: number): boolean {
  const el = map.getContainer();
  const room = Math.min(el.clientWidth, el.clientHeight);
  if (!(room >= 40)) return false;
  try {
    map.fitBounds(bounds, { padding: Math.min(padding, Math.floor(room / 4)), duration: 0, ...(maxZoom ? { maxZoom } : {}) });
    return true;
  } catch { return false; }
}

export default function LogisticsMapSafe(props: { me: Me | null | undefined }) {
  return <MapCatch><LogisticsMap {...props} /></MapCatch>;
}

function LogisticsMap({ me }: { me: Me | null | undefined }) {
  const admin = isAdmin(me);
  const today = localDay();
  const [range, setRange] = useState<FreightMapRange>(() => {
    try { return parseMapRange(localStorage.getItem(RANGE_KEY)); } catch { return DEFAULT_MAP_RANGE; }
  });
  // The last answer, and the range it was asked for: a new range keeps showing the old answer, dimmed, until the new one
  // lands, so the map is never torn down and built again just to change the range.
  const [res, setRes] = useState<{ range: FreightMapRange; data: FreightMapResponse } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [lib, setLib] = useState<MapLibre | null>(null);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [scriptTry, setScriptTry] = useState(0);
  const [mapEl, setMapEl] = useState<HTMLDivElement | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [theme, setTheme] = useState(themeKey);
  const [selected, setSelected] = useState<string | null>(null);
  /** The slider's day. null is the end of the slider ("Today"): every load shows. */
  const [at, setAt] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const data = res?.data ?? null;
  const stale = !!res && res.range !== range;

  // What was drawn, kept outside React so the replay can move a line every frame without rendering the screen.
  const view = useRef<View>({ map: null, loads: [], visible: new Set(), counts: new Map(), selected: null });
  /** The map's style is loaded and our sources and layers are in it. */
  const ready = useRef(false);
  const lines = useRef(new Map<string, LineState>());
  const geos = useRef(new Map<string, Geo>());
  /** The stops source as last given, and which lanes each stop belongs to (for a click). */
  const stopsSig = useRef("");
  const stopLanes = useRef(new Map<string, string[]>());
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

  // ── MapLibre itself, once per window ──
  useEffect(() => {
    let dead = false;
    loadMapLibre().then((l) => { if (!dead) { setLib(l); setScriptFailed(false); } }).catch(() => { if (!dead) setScriptFailed(true); });
    return () => { dead = true; };
  }, [scriptTry]);

  // The app's theme changing while the map is open: a new look, same camera.
  useEffect(() => {
    const html = document.documentElement;
    const mo = new MutationObserver(() => setTheme(themeKey()));
    mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  const loads = useMemo(() => data?.loads ?? [], [data]);
  const waitingForKey = data ? waitingForRouteKey(loads, data.key_problem) : false;
  const problem = data ? mapProblem({ waitingForKey, keyProblem: data.key_problem, loadCount: loads.length, admin, scriptFailed }) : null;
  const showMap = !!data && !problem?.blocks;

  const days = useMemo(() => sliderDays(loads, today), [loads, today]);
  const visible = useMemo(() => (at === null ? loads : loadsOnOrBefore(loads, at)), [loads, at]);
  const lanes = useMemo(() => groupLanes(visible), [visible]);
  const counts = useMemo(() => new Map(lanes.map((l) => [l.key, l.count])), [lanes]);
  const pickedLane = lanes.find((l) => l.key === selected) ?? null;
  const sel = pickedLane ? pickedLane.key : null;
  const plan = useMemo(() => replayPlan(loads), [loads]);

  const geoOf = useCallback((l: FreightMapLoad): Geo => {
    const id = `${l.id}|${l.route?.polyline ?? ""}`;
    let g = geos.current.get(id);
    if (!g) {
      const path = l.route ? decodePolyline(l.route.polyline) : [];
      g = { path, coords: path.map((p): Coord => [p.lng, p.lat]) };
      geos.current.set(id, g);
    }
    return g;
  }, []);

  const pickLane = useCallback((laneKeys: string[]) => {
    const c = view.current.counts;
    let best = laneKeys[0];
    for (const k of laneKeys) if ((c.get(k) ?? 0) > (c.get(best) ?? 0)) best = k;
    if (best !== undefined) setSelected((cur) => (cur === best ? null : best));
  }, []);

  /** Bring the routes source in line with what should show, sending the map only what changed: a line that is new, one that
   *  grew, one whose weight or fade changed, one that left. A replay frame is one small update, not a rebuild. */
  const syncLines = useCallback(() => {
    const v = view.current;
    const src = ready.current && v.map ? (v.map.getSource(ROUTES) as GeoJSONSource | undefined) : undefined;
    if (!v.map || !src) return;
    const prog = progress.current;
    const add: GeoJSON.Feature[] = [];
    const update: { id: string; newGeometry?: GeoJSON.Geometry; addOrUpdateProperties?: { key: string; value: number }[] }[] = [];
    const wanted = new Set<string>();
    for (const l of v.loads) {
      if (l.route_state !== "ready" || !l.route) continue;
      const frac = prog ? prog.get(l.id) ?? 0 : v.visible.has(l.id) ? 1 : 0;
      if (frac <= 0) continue;
      wanted.add(l.id);
      const lane = laneName(l);
      const st = lineStyle(v.counts.get(lane) ?? 1, lane, v.selected);
      const props = { w: st.weight, o: st.opacity, full: frac >= 1 ? 1 : 0, z: v.selected === lane ? 1 : 0 };
      const sig = `${props.w}|${props.o}|${props.full}|${props.z}`;
      const geo = geoOf(l);
      const coordsAt = (): Coord[] => (frac >= 1 ? geo.coords : partialPath(geo.path, frac).map((p): Coord => [p.lng, p.lat]));
      const have = lines.current.get(l.id);
      if (!have || have.poly !== l.route.polyline) {
        // New, or fetched again (the addresses changed): adding a feature under an id the source has replaces it.
        add.push({ type: "Feature", properties: { load: l.id, lane, ...props }, geometry: { type: "LineString", coordinates: coordsAt() } });
      } else if (have.frac !== frac || have.sig !== sig) {
        update.push({
          id: l.id,
          ...(have.frac !== frac ? { newGeometry: { type: "LineString" as const, coordinates: coordsAt() } } : {}),
          ...(have.sig !== sig ? { addOrUpdateProperties: Object.entries(props).map(([key, value]) => ({ key, value })) } : {}),
        });
      } else continue;
      lines.current.set(l.id, { poly: l.route.polyline, frac, sig });
    }
    // A line whose load left the answer (a shorter range, the slider, or it stopped being ready) comes off the map.
    const remove: string[] = [];
    for (const id of lines.current.keys()) if (!wanted.has(id)) { remove.push(id); lines.current.delete(id); }
    if (add.length || update.length || remove.length) void src.updateData({ add, update, remove });
  }, [geoOf]);

  /** The stops: a small source, handed over whole whenever a stop appears, goes, grows or dims. */
  const syncStops = useCallback(() => {
    const v = view.current;
    const src = ready.current && v.map ? (v.map.getSource(STOPS) as GeoJSONSource | undefined) : undefined;
    if (!v.map || !src) return;
    const prog = progress.current;
    const drawn = v.loads.filter((l) => l.route_state === "ready" && (prog ? (prog.get(l.id) ?? 0) > 0 : v.visible.has(l.id)));
    const markers = mapMarkers(drawn);
    stopLanes.current = new Map(markers.map((m) => [m.key, m.laneKeys]));
    const features: GeoJSON.Feature[] = markers.map((m) => ({
      type: "Feature",
      properties: { k: m.key, kind: m.kind, r: markerRadius(m), dim: v.selected !== null && !m.laneKeys.includes(v.selected) ? 1 : 0 },
      geometry: { type: "Point", coordinates: [m.lng, m.lat] },
    }));
    const sig = features.map((f) => `${f.properties!.k}|${f.properties!.r}|${f.properties!.dim}`).join(";");
    if (sig === stopsSig.current) return;
    stopsSig.current = sig;
    void src.setData({ type: "FeatureCollection", features });
  }, []);

  const syncAll = useCallback(() => { syncLines(); syncStops(); }, [syncLines, syncStops]);

  // The map itself, built when its box is on screen and the library is in.
  useEffect(() => {
    if (!lib || !mapEl) return;
    let m: MapLibreMap;
    try {
      m = new lib.Map({
        container: mapEl,
        style: { version: 8, sources: {}, layers: [] },
        center: [-98.35, 39.5], zoom: 3, minZoom: 2, maxZoom: 16,
        attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false,
      });
    } catch {
      setScriptFailed(true);
      return;
    }
    m.touchZoomRotate.disableRotation();
    m.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new lib.AttributionControl({ compact: true, customAttribution: ROUTES_CREDIT }), "bottom-right");

    // Our sources and layers, put into every style the map loads (the first, and each theme change).
    m.on("style.load", () => {
      const c = colors.current ?? (colors.current = readColors());
      if (m.hasImage(ARROW_IMAGE)) m.removeImage(ARROW_IMAGE);
      m.addImage(ARROW_IMAGE, arrowImage(c), { pixelRatio: 2 });
      m.addSource(ROUTES, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "load" });
      m.addSource(STOPS, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      // Lines go under the style's labels, so a city's name stays readable over a route; arrows and stops go on top.
      const firstLabel = m.getStyle().layers.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-field"])?.id;
      m.addLayer({
        id: LINES, type: "line", source: ROUTES,
        layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["get", "z"] },
        paint: { "line-color": c.route, "line-width": ["get", "w"], "line-opacity": ["get", "o"] },
      }, firstLabel);
      m.addLayer({
        id: ARROWS, type: "symbol", source: ROUTES, filter: ["==", ["get", "full"], 1],
        layout: {
          "symbol-placement": "line", "symbol-spacing": 250, "icon-image": ARROW_IMAGE, "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["get", "w"], 3, 0.55, 11, 0.95],
        },
        paint: { "icon-opacity": ["get", "o"] },
      });
      const delivery: ExpressionSpecification = ["==", ["get", "kind"], "delivery"];
      m.addLayer({
        id: DOTS, type: "circle", source: STOPS,
        layout: { "circle-sort-key": ["case", delivery, 2, 1] },
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["case", delivery, c.route, c.paper],
          "circle-stroke-color": ["case", delivery, c.paper, c.ink],
          "circle-stroke-width": 2,
          "circle-opacity": ["case", ["==", ["get", "dim"], 1], 0.35, 1],
          "circle-stroke-opacity": ["case", ["==", ["get", "dim"], 1], 0.35, 1],
        },
      });
      lines.current.clear();
      stopsSig.current = "";
      ready.current = true;
      view.current = { ...view.current, map: m };
      syncAll();
    });

    const hitBox = (e: MapMouseEvent): [[number, number], [number, number]] => [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    m.on("click", (e) => {
      if (!ready.current) return;
      const stop = m.queryRenderedFeatures(hitBox(e), { layers: [DOTS] })[0];
      if (stop) { pickLane(stopLanes.current.get(String(stop.properties?.k)) ?? []); return; }
      const line = m.queryRenderedFeatures(hitBox(e), { layers: [LINES] })[0];
      if (line) { const lane = String(line.properties?.lane); setSelected((cur) => (cur === lane ? null : lane)); return; }
      setSelected(null);
    });
    m.on("mousemove", (e) => {
      if (!ready.current) return;
      m.getCanvas().style.cursor = m.queryRenderedFeatures(hitBox(e), { layers: [DOTS, LINES] }).length ? "pointer" : "";
    });

    fit.current = "none";
    colors.current = readColors();
    setMap(m);
    const drawn = lines.current;
    return () => {
      ready.current = false;
      drawn.clear();
      stopsSig.current = "";
      setMap(null);
      m.remove();
    };
  }, [lib, mapEl, pickLane, syncAll]);

  // The style: OpenFreeMap's, in Ecliptr's colours, again whenever the app's theme changes.
  useEffect(() => {
    if (!map) return;
    let dead = false;
    const c = readColors();
    loadStyle(c.dark).then((style) => {
      if (dead) return;
      colors.current = c;
      ready.current = false;
      // diff: false so the old style's sources and layers are dropped and `style.load` fires again.
      map.setStyle(recolor(style, c) as unknown as Parameters<MapLibreMap["setStyle"]>[0], { diff: false });
    }).catch(() => { if (!dead) setScriptFailed(true); });
    return () => { dead = true; };
  }, [map, theme]);

  // Fit the map to the routes the first time any is ready, and show the lower 48 until then. After that a poll redraws and
  // leaves the map where the person put it.
  useEffect(() => {
    if (!map || !data) return;
    const readyLoads = data.loads.filter((l) => l.route_state === "ready" && l.route);
    if (readyLoads.length && fit.current !== "routes") {
      let w = 180, s = 90, e = -180, n = -90, any = false;
      for (const l of readyLoads) for (const p of geoOf(l).path) {
        any = true;
        if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng; if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
      }
      if (any && safeFit(map, [[w, s], [e, n]], 48, 10)) fit.current = "routes";
    } else if (!readyLoads.length && fit.current === "none") {
      if (safeFit(map, [[LOWER_48.west, LOWER_48.south], [LOWER_48.east, LOWER_48.north]], 24)) fit.current = "lower48";
    }
  }, [map, data, geoOf]);

  // Draw whatever changed: the loads, the slider, the picked lane.
  useEffect(() => {
    view.current = { map, loads, visible: new Set(visible.map((l) => l.id)), counts, selected: sel };
    syncAll();
  }, [map, loads, visible, counts, sel, syncAll]);

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

      {problem && !problem.blocks && !problem.onMap && (
        <div className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[15px] text-warning-ink" role="status">{problem.text}</div>
      )}

      {showMap ? (
        <div className="relative min-w-0">
          <div ref={setMapEl} className="freight-map h-[560px] max-h-[75vh] w-full rounded-xl border border-line overflow-hidden bg-surface-2" aria-label="Map of delivered freight" />
          {problem?.onMap && (
            <div className="absolute left-4 right-16 top-4 flex justify-center pointer-events-none">
              <div className="pointer-events-auto max-w-lg rounded-xl border border-line bg-surface px-5 py-4 text-center shadow-lg" role="status">
                <p className="text-[17px] text-ink">{problem.text}</p>
                {admin && (
                  <button type="button" onClick={openLogisticsSettings}
                    className="mt-3 bg-accent hover:bg-accent-hover text-on-accent px-5 h-10 rounded-lg text-[15px] font-medium transition-colors">Open settings</button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : data && problem ? (
        <div className="rounded-xl border border-line bg-surface-2 min-h-[240px] px-6 py-10 flex flex-col items-center justify-center gap-4 text-center">
          <p className="text-[17px] text-ink-2 max-w-md">{problem.text}</p>
          {scriptFailed && loads.length > 0 && (
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
