import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe from "globe.gl";
import * as THREE from "three";
import { api, BuyerTier, Client, Me } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { can } from "../lib/permissions";
import TierBadge from "./TierBadge";
import StatusPill from "./StatusPill";
import ClientMap2D from "./globe/ClientMap2D";
import {
  arcDeg, buildPlaces, clusterPlaces, dueToReorder, FOLLOWUP_LABEL, FOLLOWUP_RGB, lensRgb,
  missingReason, MISSING_HINT, MISSING_ORDER, placeLabel, PROFIT_NEGATIVE, PROFIT_STEPS,
  RECENCY_STEPS, NEVER_RGB, regionRollup, TIER_NAME, TIER_RGB, toRows,
  type ClientRow, type FollowUp, type Group, type Lens, type MissingReason,
} from "./globe/places";
import { disposeMarkTextures, makeSprite, markRoom, styleSprite } from "./globe/marks";
import {
  X, MapPin, MapPinOff, Map as MapIcon, Globe2, Maximize2, ChevronLeft, ExternalLink,
  RotateCcw, RefreshCw, Search, SlidersHorizontal,
} from "lucide-react";

// How long the globe waits after a manual drag release before it starts
// auto-rotating again.
const AUTO_ROTATE_RESUME_MS = 3000;
// With no pointer, wheel or key for this long the globe stops turning and stops
// drawing; the next touch wakes it.
const IDLE_MS = 60_000;
const MARK_ALTITUDE = 0.012;

// Initial camera — slightly tilted view of Earth
const HOME_POV = { lat: 25, lng: -30, altitude: 2.0 };
// The "Zoom to the US" button: the continental US with every client in view
const US_POV   = { lat: 38, lng: -97, altitude: 0.7 };

// Tier rows double as the tier legend and the tier filter. "Prospect" covers New.
const TIER_ROWS = ["P", "S", "A", "B", "C", "Prospect"] as const;
const tierKey = (t: string) => (t === "New" ? "Prospect" : t);

const LENSES: [Lens, string][] = [["tier", "Tier"], ["profit", "Profit"], ["recency", "Recency"], ["followup", "Follow-up"]];

// View settings survive a trip to a client and back (per session).
const SAVE_KEY = "clienthub.globe.view.v2";
interface Saved {
  view?: "globe" | "map"; scope?: "us" | "world"; lens?: Lens; tiers?: string[];
  high?: boolean; category?: string; lead?: string; region?: string;
  pov?: { lat: number; lng: number; altitude: number };
}
function readSaved(): Saved {
  try { return JSON.parse(sessionStorage.getItem(SAVE_KEY) || "{}"); } catch { return {}; }
}

type Panel =
  | { kind: "group"; group: Group }
  | { kind: "client"; id: string; from: Group | null }
  | { kind: "missing" }
  | null;

const relTime = (d: string | null | undefined): string => {
  if (!d) return "Never";
  const ms   = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0)   return "Today";
  if (days === 1)  return "Yesterday";
  if (days < 30)   return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

const niceStatus = (s: string) => (s ? (s[0].toUpperCase() + s.slice(1)).replace(/_/g, " ") : "");
const RELIABILITY: Record<string, string> = { reliable: "Pays reliably", mixed: "Mixed payment record", low: "Often pays late", unrated: "Not rated yet" };
const RAD = Math.PI / 180;

export default function GlobeView({ me }: { me?: Me | null }) {
  // Dollar figures follow the "See exact client spend" permission.
  const showMoney = can(me, "clients:view_revenue");
  const today = localDay();
  const saved = useRef(readSaved()).current;

  const [view,     setView]     = useState<"globe" | "map">(saved.view ?? "globe");
  const [scope,    setScope]    = useState<"us" | "world">(saved.scope ?? "us");
  const [lensPick, setLens]     = useState<Lens>(saved.lens ?? "tier");
  const lens: Lens = lensPick === "profit" && !showMoney ? "tier" : lensPick;
  const [tiersOn,  setTiersOn]  = useState<string[]>(saved.tiers ?? [...TIER_ROWS]);
  const [highOnly, setHighOnly] = useState(!!saved.high);
  const [category, setCategory] = useState(saved.category ?? "");
  const [lead,     setLead]     = useState(saved.lead ?? "");
  const [region,   setRegion]   = useState(saved.region ?? "");
  const [allRegions, setAllRegions] = useState(false);

  // Every client except rejected leads, which the rest of the app also leaves out.
  const [clients,  setClients]  = useState<Client[]>([]);
  const [tiers,    setTiers]    = useState<Record<string, BuyerTier>>({});
  const [panel,    setPanel]    = useState<Panel>(null);
  const [query,    setQuery]    = useState("");
  const [active,   setActive]   = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [globeReady, setGlobeReady] = useState(false);
  const [geocoding,  setGeocoding]  = useState(false);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);
  const [size,     setSize]     = useState({ w: 1200, h: 800 });   // the globe canvas
  const [rootW,    setRootW]    = useState(1200);                   // the whole tab
  const [railOpen, setRailOpen] = useState(false);
  // Cluster level: the camera altitude, quantised, so marks regroup as you zoom
  // but not on every frame of a rotation.
  const [altLevel, setAltLevel] = useState(() => altToLevel(saved.pov?.altitude ?? HOME_POV.altitude));

  const rootRef            = useRef<HTMLDivElement>(null);
  const containerRef       = useRef<HTMLDivElement>(null);
  const starCanvasRef      = useRef<HTMLCanvasElement>(null);
  const searchRef          = useRef<HTMLInputElement>(null);
  const globeRef           = useRef<any>(null);
  const autoRotateTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Prevents the OrbitControls "start" event from cancelling programmatic navigation
  const isProgNavRef       = useRef(false);
  // rAF id of the camera flight in progress (navTo).
  const flightRef          = useRef(0);
  // Last Group handed to globe.gl per key. An unchanged mark keeps its object, so
  // globe.gl keeps its sprite instead of tearing it down and making a new one.
  const groupCacheRef      = useRef(new Map<string, Group>());
  // What the sprite updater reads; kept in refs so restyling never rebuilds a mark.
  const styleRef = useRef({ lens: "tier" as Lens, profitTop: 0, selected: new Set<string>(), hover: "", pxToScale: 0.01 });
  const groupsRef = useRef<Group[]>([]);
  const wakeRef   = useRef<() => void>(() => {});
  const pauseRef  = useRef<() => void>(() => {});
  const viewRef   = useRef(view);
  viewRef.current = view;

  const viewProfile = useCallback((clientId: string) => {
    sessionStorage.setItem("clienthub.globe.clientId", clientId);
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
  }, []);

  // ── Camera ───────────────────────────────────────────────────
  // Programmatic camera move. Only thing we toggle is autoRotate — locking
  // controls.enabled made the globe feel unresponsive during the tween, and
  // it was unnecessary anyway since the tween writes the camera directly.
  //
  // The flight is driven here, one pointOfView per frame. globe.gl's own
  // pointOfView(pov, ms) starts a tween in tween.js's shared group, which
  // nothing updates any more (its three-render-objects 1.42 keeps a private
  // group), so a transition handed to globe.gl never moves the camera.
  const navTo = useCallback((pov: { lat: number; lng: number; altitude: number }, duration = 600, thenSpin = false) => {
    const globe = globeRef.current;
    if (!globe) return;
    wakeRef.current();
    isProgNavRef.current = true;
    const c = globe.controls?.();
    if (c) c.autoRotate = false;
    if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
    cancelAnimationFrame(flightRef.current);
    const from = globe.pointOfView();
    const dLng = ((pov.lng - from.lng + 540) % 360) - 180; // the short way round
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / duration));
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // cubic in-out
      globeRef.current?.pointOfView({
        lat:      from.lat + (pov.lat - from.lat) * e,
        lng:      from.lng + dLng * e,
        altitude: from.altitude + (pov.altitude - from.altitude) * e,
      });
      if (k < 1) { flightRef.current = requestAnimationFrame(step); return; }
      isProgNavRef.current = false;
      setAltLevel(altToLevel(pov.altitude));
      if (thenSpin && globeRef.current?.controls()) {
        const cc = globeRef.current.controls();
        cc.autoRotate      = true;
        cc.autoRotateSpeed = 0.45;
      }
    };
    flightRef.current = requestAnimationFrame(step);
  }, []);

  /** Frames a set of marks: the centre of their spread, far enough out to see them all. */
  const fitTo = useCallback((groups: { lat: number; lng: number }[]) => {
    if (!groups.length) return;
    let x = 0, y = 0, z = 0;
    for (const g of groups) {
      x += Math.cos(g.lat * RAD) * Math.cos(g.lng * RAD);
      y += Math.cos(g.lat * RAD) * Math.sin(g.lng * RAD);
      z += Math.sin(g.lat * RAD);
    }
    const lat = Math.atan2(z, Math.hypot(x, y)) / RAD, lng = Math.atan2(y, x) / RAD;
    let maxDeg = 0;
    for (const g of groups) {
      const s = Math.sin((g.lat - lat) * RAD / 2) ** 2 + Math.cos(lat * RAD) * Math.cos(g.lat * RAD) * Math.sin((g.lng - lng) * RAD / 2) ** 2;
      maxDeg = Math.max(maxDeg, 2 * Math.asin(Math.min(1, Math.sqrt(s))) / RAD);
    }
    navTo({ lat, lng, altitude: Math.min(2.6, Math.max(0.3, maxDeg / 18)) }, 900);
  }, [navTo]);

  // ── Data ─────────────────────────────────────────────────────
  // Re-checks every pin against the address on the client today. `quiet` is the
  // check that runs each time the page opens: no spinner, no message.
  const runGeocode = useCallback(async (quiet = false) => {
    if (!quiet) { setGeocoding(true); setGeocodeMsg(null); }
    try {
      const result = await api.geocodeAllClients();
      // Nothing moved, so the list on screen is already right: skip the reload
      // and the redraw of every mark it would cause.
      if (result.matched > 0 || result.removed > 0) {
        setClients(liveClients(await api.listClientsFiltered({})));
      }
      if (!quiet) {
        setGeocodeMsg(result.matched || result.removed
          ? `${result.matched} placed or moved${result.removed ? `, ${result.removed} removed` : ""}`
          : "Every pin is up to date");
      }
    } catch (e: any) {
      if (!quiet) setGeocodeMsg(e?.toString?.() || "Could not refresh pins");
    } finally {
      if (!quiet) setGeocoding(false);
    }
  }, []);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [list, tierList] = await Promise.all([
          api.listClientsFiltered({}),
          api.buyerTiers().catch(() => [] as BuyerTier[]),
        ]);
        if (dead) return;
        setTiers(Object.fromEntries(tierList.map((t) => [t.client_id, t])));
        setClients(liveClients(list));
      } catch {
        if (!dead) setError("Failed to load clients");
      } finally {
        if (!dead) setLoading(false);
      }
      // Places clients added or synced since launch, moves pins whose address
      // was edited, and drops pins whose address no longer resolves. Reloads
      // the list only when something changed.
      if (!dead) runGeocode(true);
    })();
    return () => { dead = true; };
  }, [runGeocode]);

  const rows = useMemo(() => toRows(clients, tiers), [clients, tiers]);
  // Every filter but the region one: the region list and the map's shading read
  // this, so picking a state never hides the other states you could pick.
  const unregioned = useMemo(() => rows.filter((r) =>
    tiersOn.includes(tierKey(r.tier))
    && (!highOnly || r.highValue)
    && (!category || r.category === category)
    && (!lead || r.leadStatus === lead)
  ), [rows, tiersOn, highOnly, category, lead]);
  const shown = useMemo(() => (region ? unregioned.filter((r) => r.region === region) : unregioned), [unregioned, region]);

  const allPlaces = useMemo(() => buildPlaces(rows, today), [rows, today]);
  const places    = useMemo(() => buildPlaces(shown, today), [shown, today]);
  const mapped    = rows.filter((r) => r.lat !== null).length;
  const shownMapped = shown.filter((r) => r.lat !== null).length;

  const missing = useMemo(() => {
    const groups = new Map<MissingReason, ClientRow[]>();
    for (const r of rows) {
      if (r.lat !== null) continue;
      const why = missingReason(r);
      groups.set(why, [...(groups.get(why) || []), r]);
    }
    const ordered = MISSING_ORDER.filter((w) => groups.has(w)).map((w) => [w, groups.get(w)!] as const);
    return { count: rows.length - mapped, groups: ordered };
  }, [rows, mapped]);

  const byProfit = lens === "profit";
  const regionList = useMemo(() => regionRollup(unregioned), [unregioned]);
  const regions = useMemo(() => [...regionList].sort((a, b) =>
    (byProfit ? b.profit - a.profit : b.count - a.count) || a.label.localeCompare(b.label)), [regionList, byProfit]);

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(), [rows]);
  const leads      = useMemo(() => [...new Set(rows.map((r) => r.leadStatus).filter(Boolean))].sort(), [rows]);
  const tierCounts = useMemo(() => {
    const n: Record<string, number> = {};
    for (const r of rows) n[tierKey(r.tier)] = (n[tierKey(r.tier)] || 0) + 1;
    return n;
  }, [rows]);

  // Marks on the globe: places merged by on-screen distance at this altitude.
  const globeGroups = useMemo(() => {
    const fov = globeRef.current?.camera?.().fov ?? 50;
    // Degrees of arc per CSS pixel at the centre of the view at this altitude:
    // a mark's room on screen, in the same units as the distance between places.
    const degPerPx = (2 * Math.tan((fov * RAD) / 2) * levelToAlt(altLevel)) / Math.max(1, size.h) / RAD;
    const out = clusterPlaces(places, today, (n) => markRoom(n) * degPerPx).map((g) => {
      const sig = `${g.count}|${g.bestTier}|${g.profit}|${g.followUp}|${g.lastActivity}|${g.approximate}|${g.lat}|${g.lng}`;
      const prev = groupCacheRef.current.get(g.key);
      if (prev && (prev as any).__sig === sig) return prev;
      (g as any).__sig = sig;
      groupCacheRef.current.set(g.key, g);
      return g;
    });
    return out;
    // globeReady: the camera's fov is only readable once the globe exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, altLevel, size.h, today, globeReady]);

  const selectedClient = panel?.kind === "client" ? panel.id : null;
  const selectedGroup  = panel?.kind === "group" ? panel.group : panel?.kind === "client" ? panel.from : null;
  const selectedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const g of globeGroups) {
      if ((selectedGroup && g.key === selectedGroup.key) || (selectedClient && g.clients.some((c) => c.id === selectedClient))) s.add(g.key);
    }
    return s;
  }, [globeGroups, selectedGroup, selectedClient]);

  // ── Globe instance ───────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current, root = rootRef.current;
    if (!el || !root) return;
    let globe: any;
    try {
      globe = Globe({ rendererConfig: { antialias: true, alpha: true, powerPreference: "high-performance" } })
        .backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true)
        .atmosphereColor("#4C74E0")
        .atmosphereAltitude(0.18)
        .width(el.clientWidth)
        .height(el.clientHeight)
        (el);
    } catch (e: any) {
      setError(`Globe init failed: ${e?.message ?? e}`);
      return;
    }

    // The real earth, dimmed: the photo's colour times a blue-grey, so the land
    // and oceans read clearly but stay quieter than the client marks.
    // (v0.16.106's near-black texture read as a black ball; v0.16.107's hexagon
    // land did not land with Jack.)
    globe
      .globeImageUrl("/globe/earth-blue-marble.jpg")
      .bumpImageUrl("/globe/earth-topology.png");
    const mat = globe.globeMaterial() as THREE.MeshPhongMaterial;
    mat.color = new THREE.Color("#A3ADC2");
    mat.specular = new THREE.Color("#0E1422");
    mat.shininess = 5;

    // Marks: one sprite per group, styled from styleRef so restyling never rebuilds.
    globe
      .customThreeObject(() => makeSprite())
      .customThreeObjectUpdate((obj: THREE.Sprite, g: Group) => {
        Object.assign(obj.position, globe.getCoords(g.lat, g.lng, MARK_ALTITUDE));
        const st = styleRef.current;
        styleSprite(obj, {
          rgb: lensRgb(g, st.lens, today, st.profitTop),
          count: g.count,
          approximate: g.approximate,
          selected: st.selected.has(g.key),
        }, st.pxToScale, st.hover === g.key ? 1.15 : 1);
        fadeToHorizon(globe, obj);
      })
      .customLayerLabel((g: Group) => tooltipHtml(g, showMoney))
      .onCustomLayerHover((g: Group | null) => {
        const key = g?.key ?? "";
        if (styleRef.current.hover === key) return;
        styleRef.current.hover = key;
        globe.customLayerData(groupsRef.current);
      })
      .onCustomLayerClick((g: Group) => openGroupRef.current(g));

    // Follow-ups due today or overdue pulse, and nothing else does.
    globe
      .ringColor(() => (t: number) => `rgba(255,159,10,${((1 - t) * 0.85).toFixed(3)})`)
      .ringMaxRadius(2.4)
      .ringPropagationSpeed(2.2)
      .ringRepeatPeriod(1500)
      .ringAltitude(MARK_ALTITUDE - 0.001);

    globeRef.current = globe;

    // A click on the sphere only closes what is open; the camera stays put.
    globe.onGlobeClick(() => setPanel(null));

    const ctrl = globe.controls();
    ctrl.autoRotateSpeed = 0.45;
    ctrl.zoomSpeed       = 5.0;   // was 2.5 — much snappier
    ctrl.enableDamping   = true;
    ctrl.dampingFactor   = 0.22;  // was 0.12 — more responsive
    ctrl.minDistance     = 101;
    ctrl.maxDistance     = 700;
    if (saved.pov) {
      globe.pointOfView(saved.pov);           // back from a client: keep the view
    } else {
      globe.pointOfView(HOME_POV);
      ctrl.autoRotate = !reduceMotion();
    }

    ctrl.addEventListener("start", () => {
      if (isProgNavRef.current) return; // programmatic nav — don't interfere
      ctrl.autoRotate = false;
      if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
    });
    // Resume auto-rotate after the user releases the drag, once it's been
    // idle for a bit — "start" above only ever turns it off.
    ctrl.addEventListener("end", () => {
      if (isProgNavRef.current) return; // programmatic nav — don't interfere
      if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
      if (reduceMotion()) return;
      autoRotateTimerRef.current = setTimeout(() => {
        ctrl.autoRotate      = true;
        ctrl.autoRotateSpeed = 0.45;
      }, AUTO_ROTATE_RESUME_MS);
    });
    // Regroup marks when the zoom crosses a level (rotation alone never does), and
    // fade them toward the horizon as the globe turns.
    ctrl.addEventListener("change", () => {
      const lvl = altToLevel(globe.pointOfView().altitude);
      setAltLevel((cur) => (cur === lvl ? cur : lvl));
      globe.scene().traverse((o: any) => { if (o.__globeObjType === "custom") fadeToHorizon(globe, o); });
    });

    // ── Drawing only when someone is looking ──────────────────
    let paused = false, idleTimer: ReturnType<typeof setTimeout> | undefined, rotateBeforeIdle = false;
    const pause = () => { if (!paused) { paused = true; globe.pauseAnimation(); } };
    const resume = () => { if (paused) { paused = false; globe.resumeAnimation(); } };
    // Not gated on window focus: a webview that misreports focus would leave the
    // globe undrawn, and a visible globe is watched even when another window has focus.
    const wake = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!document.hidden && viewRef.current === "globe") resume();
      if (rotateBeforeIdle) { ctrl.autoRotate = true; rotateBeforeIdle = false; }
      idleTimer = setTimeout(() => { rotateBeforeIdle = ctrl.autoRotate; ctrl.autoRotate = false; pause(); }, IDLE_MS);
    };
    wakeRef.current = wake;
    pauseRef.current = pause;
    const onVisibility = () => (document.hidden ? pause() : wake());
    document.addEventListener("visibilitychange", onVisibility);
    const activity = ["pointermove", "pointerdown", "wheel", "keydown"];
    activity.forEach((ev) => root.addEventListener(ev, wake, { passive: true }));
    wake();

    // ── Size ──────────────────────────────────────────────────
    // A ResizeObserver, not window resize: the split-view divider and the sidebar
    // collapse change this pane's size without resizing the window.
    const ro = new ResizeObserver(() => {
      setRootW(root.clientWidth);
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      globe.width(w);
      globe.height(h);
      setSize({ w, h });
    });
    ro.observe(el);
    ro.observe(root);

    const stopStars = initStarfield(starCanvasRef.current);
    setGlobeReady(true);

    return () => {
      try { sessionStorage.setItem(SAVE_KEY, JSON.stringify({ ...readSaved(), pov: globe.pointOfView() })); } catch { /* storage off */ }
      ro.disconnect();
      stopStars();
      document.removeEventListener("visibilitychange", onVisibility);
      activity.forEach((ev) => root.removeEventListener(ev, wake));
      if (idleTimer) clearTimeout(idleTimer);
      cancelAnimationFrame(flightRef.current);
      if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
      // globe.gl's destructor empties the layers but keeps the WebGL context,
      // the controls and their listeners; release those too, or every visit to
      // the tab leaves one behind.
      globe._destructor?.();
      globe.controls()?.dispose?.();
      const renderer = globe.renderer?.();
      renderer?.dispose?.();
      renderer?.forceContextLoss?.();
      disposeMarkTextures();
      globeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hover tests run every 50ms against everything in the scene; the atmosphere
  // is only a glow and never needs one.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const t = setTimeout(() => globe.scene().traverse((o: any) => {
      if (o.__globeObjType === "atmosphere") o.raycast = () => {};
    }), 60);
    return () => clearTimeout(t);
  }, [globeReady]);

  // Keep the sprite scale right for the canvas height and camera.
  useEffect(() => {
    const fov = globeRef.current?.camera?.().fov ?? 50;
    styleRef.current.pxToScale = (2 * Math.tan((fov * RAD) / 2)) / Math.max(1, size.h);
  }, [size.h, globeReady]);

  // Hand the marks to globe.gl, and restyle them when the lens or selection moves.
  const profitTop = Math.max(0, ...globeGroups.map((g) => g.profit));
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    Object.assign(styleRef.current, { lens, profitTop, selected: selectedKeys });
    groupsRef.current = globeGroups;
    globe.customLayerData(globeGroups);
    globe.ringsData(reduceMotion() ? [] : globeGroups.filter((g) => g.followUp === "overdue" || g.followUp === "today"));
  }, [globeGroups, lens, profitTop, selectedKeys, globeReady, size.h]);

  // The globe draws nothing while the flat map is up.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    // Through the same pause/wake pair as idle, so their paused flag stays true.
    if (view === "map") pauseRef.current();
    else wakeRef.current();
  }, [view, globeReady]);

  // Remember the view settings for this session.
  useEffect(() => {
    try {
      sessionStorage.setItem(SAVE_KEY, JSON.stringify({
        ...readSaved(), view, scope, lens: lensPick, tiers: tiersOn, high: highOnly, category, lead, region,
      }));
    } catch { /* storage off */ }
  }, [view, scope, lensPick, tiersOn, highOnly, category, lead, region]);

  // ── Opening things ───────────────────────────────────────────
  const openGroup = useCallback((g: Group) => {
    if (g.count === 1) setPanel({ kind: "client", id: g.clients[0].id, from: null });
    else setPanel({ kind: "group", group: g });
    if (view !== "globe" || !globeRef.current) return;
    const alt = globeRef.current.pointOfView().altitude;
    if (g.placeCount < 2) { navTo({ lat: g.lat, lng: g.lng, altitude: Math.min(alt, 0.45) }, 700); return; }
    // A cluster of several places flies in just far enough that its two closest
    // places come apart, so one click always separates it.
    const pts = [...new Map(g.clients.map((c) => [`${c.lat},${c.lng}`, c])).values()];
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      closest = Math.min(closest, arcDeg(pts[i].lat!, pts[i].lng!, pts[j].lat!, pts[j].lng!));
    }
    const fov = globeRef.current.camera().fov;
    // Two single dots need 2 x markRoom(1) px between them; find the altitude
    // where the closest pair's arc covers that many pixels.
    const degPerPxPerAlt = (2 * Math.tan((fov * RAD) / 2)) / Math.max(1, size.h) / RAD;
    const target = Math.min(alt * 0.8, Math.max(0.06, (closest / (2 * markRoom(1) * degPerPxPerAlt)) * 0.9));
    navTo({ lat: g.lat, lng: g.lng, altitude: target }, 800);
  }, [navTo, view, size.h]);
  const openGroupRef = useRef(openGroup);
  openGroupRef.current = openGroup;

  const openClient = useCallback((r: ClientRow, from: Group | null = null) => {
    setPanel({ kind: "client", id: r.id, from });
    if (view === "globe" && r.lat !== null && r.lng !== null) navTo({ lat: r.lat, lng: r.lng, altitude: 0.35 }, 600);
  }, [navTo, view]);

  const pickRegion = (key: string) => {
    const next = region === key ? "" : key;
    setRegion(next);
    if (next && view === "globe") fitTo(allPlaces.filter((p) => p.clients.some((c) => c.region === next)));
  };

  // ── Search ───────────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const results = useMemo(() => (
    q ? rows.filter((r) => [r.name, r.company, r.city, r.state, r.country].some((f) => f.toLowerCase().includes(q))).slice(0, 8) : []
  ), [q, rows]);
  useEffect(() => setActive(0), [q]);
  const choose = (r: ClientRow) => { setQuery(""); openClient(r); };

  // Esc closes whatever is open; Ctrl/Cmd+F finds a client.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (rootW < 820) setRailOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === "Escape" && document.activeElement !== searchRef.current) {
        setPanel(null);
        setRailOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootW]);

  const narrow = rootW < 820;
  const panelRow = selectedClient ? rows.find((r) => r.id === selectedClient) ?? null : null;
  const toggleTier = (t: string) => setTiersOn((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const topRegions = allRegions ? regions : regions.slice(0, 8);
  const regionTop = Math.max(1, ...regions.map((r) => (byProfit ? Math.max(0, r.profit) : r.count)));
  const filtered = shown.length !== rows.length;

  // ── Render ──────────────────────────────────────────────────
  return (
    <div ref={rootRef} className={`globe-root relative w-full h-full ${panel ? "has-panel" : ""}`}
      style={{ background: "#060610", color: "#eef0f6" }}>
      <div className="globe-neb" />
      <canvas ref={starCanvasRef} className="globe-starfield" />
      <div ref={containerRef} className={`globe-container ${narrow ? "" : "with-rail"}`} style={{ visibility: view === "globe" ? "visible" : "hidden" }} />

      {view === "map" && (
        <div className={`globe-map-pane ${narrow ? "" : "with-rail"}`}>
          <ClientMap2D
            scope={scope} places={places} regions={regionList} lens={lens} today={today}
            showMoney={showMoney} selectedKey={selectedGroup?.key ?? null} regionFilter={region}
            onSelect={openGroup} onRegion={pickRegion} onScope={setScope}
          />
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px]" style={{ color: "#7E8798" }}>Loading clients…</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px] text-center" style={{ color: "#7E8798" }}>{error}</div>
        </div>
      )}

      {/* ── Left rail: search, what is shown, how it is coloured, where ── */}
      {narrow && !railOpen && (
        <button className="globe-rail-toggle globe-ctrl-btn" onClick={() => setRailOpen(true)} aria-label="Show filters" title="Show filters">
          <SlidersHorizontal size={15} />
        </button>
      )}
      {(!narrow || railOpen) && (
        <aside className={`globe-rail ${narrow ? "floating" : ""}`}>
          <div className="globe-rail-head">
            <div className="globe-seg" role="tablist" aria-label="View">
              <button className={view === "globe" ? "on" : ""} onClick={() => setView("globe")}><Globe2 size={13} /> Globe</button>
              <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}><MapIcon size={13} /> Map</button>
            </div>
            {view === "map" && (
              <div className="globe-seg" aria-label="Map area">
                <button className={scope === "us" ? "on" : ""} onClick={() => setScope("us")}>US</button>
                <button className={scope === "world" ? "on" : ""} onClick={() => setScope("world")}>World</button>
              </div>
            )}
            {narrow && (
              <button className="globe-panel-close ml-auto" onClick={() => setRailOpen(false)} aria-label="Hide filters"><X size={16} /></button>
            )}
          </div>

          <div className="globe-rail-search">
            <Search size={13} className="globe-rail-search-icon" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                else if (e.key === "Enter" && results[active]) choose(results[active]);
                else if (e.key === "Escape") { setQuery(""); searchRef.current?.blur(); }
              }}
              placeholder="Find a client, city or state"
              spellCheck={false}
              aria-label="Find a client"
            />
          </div>
          {q && (
            <div className="globe-rail-results">
              {results.length === 0 && <div className="globe-rail-empty">No client matches</div>}
              {results.map((r, i) => (
                <button key={r.id} onClick={() => choose(r)} onMouseEnter={() => setActive(i)}
                  className={`globe-rail-result ${i === active ? "on" : ""}`}>
                  <span className="globe-swatch" style={{ background: `rgb(${TIER_RGB[r.tier] ?? TIER_RGB.New})` }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium truncate" style={{ color: "#F2F4F8" }}>{r.name}</span>
                    <span className="block text-[11px] truncate" style={{ color: "#7E8798" }}>
                      {r.lat === null ? `Not on the map · ${missingReason(r).toLowerCase()}` : placeLabel(r.city, r.state, r.country)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <section className="globe-rail-section">
            <div className="globe-coverage">
              <span className="tabular-nums">{mapped} of {rows.length}</span> clients on the map
              {filtered && <span style={{ color: "#7E8798" }}> · {shownMapped} shown</span>}
            </div>
            <div className="globe-coverage-bar"><span style={{ width: `${rows.length ? (mapped / rows.length) * 100 : 0}%` }} /></div>
            <div className="flex items-center gap-2 mt-2">
              {missing.count > 0 && (
                <button className="globe-link" onClick={() => setPanel({ kind: "missing" })}>
                  <MapPinOff size={12} /> {missing.count} not on the map
                </button>
              )}
              <button onClick={() => runGeocode()} disabled={geocoding} className="globe-icon-btn ml-auto"
                title="Re-check every pin against its address" aria-label="Re-check every pin against its address">
                <RefreshCw size={12} className={geocoding ? "animate-spin" : ""} />
              </button>
            </div>
            {geocodeMsg && <div className="globe-geocode-msg">{geocodeMsg}</div>}
          </section>

          <section className="globe-rail-section">
            <div className="globe-rail-label">Colour by</div>
            <div className="globe-seg full">
              {LENSES.filter(([l]) => l !== "profit" || showMoney).map(([l, label]) => (
                <button key={l} className={lens === l ? "on" : ""} onClick={() => setLens(l)}>{label}</button>
              ))}
            </div>
            {lens !== "tier" && <LensLegend lens={lens} />}
          </section>

          <section className="globe-rail-section">
            <div className="globe-rail-label">Show</div>
            {TIER_ROWS.map((t) => (
              <button key={t} className={`globe-legend-row ${tiersOn.includes(t) ? "" : "off"}`} onClick={() => toggleTier(t)}
                aria-pressed={tiersOn.includes(t)}>
                <span className="globe-swatch" style={{ background: `rgb(${TIER_RGB[t]})` }} />
                <span className="flex-1 text-left">{TIER_NAME[t]}</span>
                <span className="tabular-nums" style={{ color: "#7E8798" }}>{tierCounts[t] || 0}</span>
              </button>
            ))}
            <label className="globe-check">
              <input type="checkbox" checked={highOnly} onChange={(e) => setHighOnly(e.target.checked)} />
              High value only
            </label>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <select className="globe-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                <option value="">All categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="globe-select" value={lead} onChange={(e) => setLead(e.target.value)} aria-label="Lead status">
                <option value="">Any status</option>
                {leads.map((l) => <option key={l} value={l}>{niceStatus(l)}</option>)}
              </select>
            </div>
            {region && (
              <button className="globe-chip-on mt-2" onClick={() => setRegion("")}>
                {regions.find((r) => r.region === region)?.label ?? region} <X size={11} />
              </button>
            )}
          </section>

          <section className="globe-rail-section">
            <div className="globe-rail-label">{byProfit ? "Regions by profit" : "Regions by clients"}</div>
            {regions.length === 0 && <div className="globe-rail-empty">No client has a state or country yet</div>}
            {topRegions.map((r) => {
              const v = byProfit ? Math.max(0, r.profit) : r.count;
              return (
                <button key={r.region} className={`globe-region-row ${region === r.region ? "on" : ""}`} onClick={() => pickRegion(r.region)}>
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="truncate flex-1 text-left">{r.label}</span>
                    <span className="tabular-nums flex-shrink-0" style={{ color: "#A9B1C6" }}>
                      {showMoney && byProfit ? fmtAmount(r.profit) : r.count}
                    </span>
                  </span>
                  <span className="globe-region-bar"><span style={{ width: `${(v / regionTop) * 100}%` }} /></span>
                </button>
              );
            })}
            {regions.length > 8 && (
              <button className="globe-link mt-1" onClick={() => setAllRegions((a) => !a)}>
                {allRegions ? "Show fewer" : `Show all ${regions.length}`}
              </button>
            )}
          </section>
        </aside>
      )}

      {/* Camera controls */}
      {view === "globe" && (
        <div className="globe-top-controls">
          <button onClick={() => { setPanel(null); navTo(HOME_POV, 800, !reduceMotion()); }} className="globe-ctrl-btn" title="Reset view and spin" aria-label="Reset view and spin">
            <RotateCcw size={15} />
          </button>
          <button onClick={() => navTo(US_POV, 600, false)} className="globe-ctrl-btn" title="Zoom to the US" aria-label="Zoom to the US">
            <MapIcon size={15} />
          </button>
          <button onClick={() => fitTo(places)} className="globe-ctrl-btn" title="Fit every client in view" aria-label="Fit every client in view">
            <Maximize2 size={14} />
          </button>
        </div>
      )}

      {/* ── Right panel ── */}
      {panel?.kind === "group" && (
        <div className="globe-client-panel open">
          <div className="p-5">
            <PanelHead title={panel.group.label} onClose={() => setPanel(null)} />
            <div className="text-[12px] mb-3" style={{ color: "#A9B1C6" }}>
              {panel.group.count} clients{panel.group.placeCount > 1 ? ` in ${panel.group.placeCount} places` : ""}
              {showMoney && <> · <span className="tabular-nums">{fmtAmount(panel.group.profit)}</span> profit</>}
            </div>
            {panel.group.approximate && <div className="globe-note mb-3">These pins are the centre of a state or country, not an exact city.</div>}
            {panel.group.clients.map((c) => (
              <button key={c.id} className="globe-missing-row" onClick={() => openClient(c, panel.group)}>
                <span className="globe-swatch" style={{ background: `rgb(${TIER_RGB[c.tier] ?? TIER_RGB.New})` }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] truncate" style={{ color: "#F2F4F8" }}>{c.name}</span>
                  <span className="block text-[11px] truncate" style={{ color: "#7E8798" }}>
                    {TIER_NAME[c.tier] ?? c.tier}{panel.group.placeCount > 1 ? ` · ${placeLabel(c.city, c.state, c.country)}` : ""}
                  </span>
                </span>
                {showMoney && <span className="text-[11.5px] tabular-nums" style={{ color: "#A9B1C6" }}>{fmtAmount(c.profit)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {panel?.kind === "client" && panelRow && (
        <div className="globe-client-panel open">
          <div className="p-5 space-y-4">
            {panel.from && (
              <button className="globe-link" onClick={() => setPanel({ kind: "group", group: panel.from! })}>
                <ChevronLeft size={13} /> {panel.from.label}
              </button>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold mb-1.5">{panelRow.name}</h3>
                {panelRow.company && panelRow.company !== panelRow.name && (
                  <div className="text-[12px] mb-1.5 truncate" style={{ color: "#A9B1C6" }}>{panelRow.company}</div>
                )}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <TierBadge tier={panelRow.tier} size="sm" />
                  {panelRow.highValue && <StatusPill tone="accent">High value</StatusPill>}
                  {dueToReorder(panelRow, today) && <StatusPill tone="warning">Due to reorder</StatusPill>}
                </div>
              </div>
              <button onClick={() => setPanel(null)} className="globe-panel-close" aria-label="Close"><X size={16} /></button>
            </div>

            {showMoney && (
              <div className="globe-figures">
                <div>
                  <div className="globe-fig-label">Profit</div>
                  <div className="globe-fig tabular-nums" style={{ color: panelRow.profit < 0 ? `rgb(${PROFIT_NEGATIVE})` : "#F2F4F8" }}>{fmtAmount(panelRow.profit)}</div>
                </div>
                <div>
                  <div className="globe-fig-label">Revenue</div>
                  <div className="globe-fig small tabular-nums">{fmtAmount(panelRow.revenue)}</div>
                </div>
              </div>
            )}

            <dl className="globe-facts">
              <Fact label="Location">
                {panelRow.lat === null
                  ? <span>Not on the map · {missingReason(panelRow).toLowerCase()}</span>
                  : <span className="inline-flex items-center gap-1.5">
                      <MapPin size={12} style={{ color: "var(--accent-500)" }} />
                      {placeLabel(panelRow.city, panelRow.state, panelRow.country)}
                      {panelRow.precision !== "city" && <span style={{ color: "#7E8798" }}>(approximate)</span>}
                    </span>}
              </Fact>
              <Fact label="Deals landed">{panelRow.dealsLanded}</Fact>
              <Fact label="Last invoice">{panelRow.lastInvoice ? relTime(panelRow.lastInvoice) : "None yet"}</Fact>
              {panelRow.cadenceDays ? <Fact label="Orders">About every {Math.round(panelRow.cadenceDays)} days</Fact> : null}
              <Fact label="Payment">{RELIABILITY[panelRow.reliability] ?? niceStatus(panelRow.reliability)}</Fact>
              <Fact label="Last contact">{relTime(panelRow.lastContact)}</Fact>
              {panelRow.nextFollowUp && (
                <Fact label="Follow-up">
                  <span style={{ color: followColor(panelRow.nextFollowUp, today) }}>{panelRow.nextFollowUp.slice(0, 10)}</span>
                </Fact>
              )}
              {panelRow.category && <Fact label="Category">{panelRow.category}</Fact>}
              {panelRow.leadStatus && <Fact label="Status">{niceStatus(panelRow.leadStatus)}</Fact>}
            </dl>

            {(() => {
              const others = panel.from ? [] : (allPlaces.find((p) => p.clients.some((c) => c.id === panelRow.id))?.clients ?? []).filter((c) => c.id !== panelRow.id);
              return others.length > 0 && (
                <div>
                  <div className="globe-rail-label">Also in {placeLabel(panelRow.city, panelRow.state, panelRow.country)}</div>
                  {others.slice(0, 6).map((c) => (
                    <button key={c.id} className="globe-missing-row" onClick={() => openClient(c)}>
                      <span className="globe-swatch" style={{ background: `rgb(${TIER_RGB[c.tier] ?? TIER_RGB.New})` }} />
                      <span className="block text-[12.5px] truncate flex-1 text-left" style={{ color: "#F2F4F8" }}>{c.name}</span>
                    </button>
                  ))}
                </div>
              );
            })()}

            <button onClick={() => viewProfile(panelRow.id)} className="globe-primary">
              <ExternalLink size={12} /> Open client
            </button>
          </div>
        </div>
      )}

      {/* Every client without a pin, grouped by why */}
      {panel?.kind === "missing" && (
        <div className="globe-client-panel open">
          <div className="p-5">
            <PanelHead title="Not on the map" onClose={() => setPanel(null)} />
            <p className="text-[12px] leading-relaxed mb-4" style={{ color: "#7E8798" }}>
              {missing.count} of {rows.length} clients have no pin. Fix the address on the client and it lands on the map the next time this page opens.
            </p>
            {missing.groups.map(([why, list]) => (
              <div key={why} className="mb-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium" style={{ color: "#E7ECF6" }}>{why}</span>
                  <span className="text-[11.5px] tabular-nums" style={{ color: "#7E8798" }}>{list.length}</span>
                </div>
                <div className="text-[11px] mb-1.5" style={{ color: "#7E8798" }}>{MISSING_HINT[why]}</div>
                {list.map((r) => {
                  const where = placeLabel(r.city, r.state, r.country);
                  return (
                    <button key={r.id} onClick={() => viewProfile(r.id)} className="globe-missing-row">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] truncate" style={{ color: "#F2F4F8" }}>{r.name}</span>
                        {where && <span className="block text-[11px] truncate" style={{ color: "#7E8798" }}>{where}</span>}
                      </span>
                      <ExternalLink size={12} className="flex-shrink-0" style={{ color: "#6B7488" }} />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-1.5">
      <h3 className="text-[15px] font-semibold min-w-0">{title}</h3>
      <button onClick={onClose} className="globe-panel-close" aria-label="Close"><X size={16} /></button>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="globe-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LensLegend({ lens }: { lens: Lens }) {
  const rows: [string, string][] =
    lens === "recency" ? [...RECENCY_STEPS.map((s) => [s.rgb, s.label] as [string, string]), [NEVER_RGB, "No invoice or contact"]]
    : lens === "followup" ? (["overdue", "today", "soon", "none"] as FollowUp[]).map((f) => [FOLLOWUP_RGB[f], FOLLOWUP_LABEL[f]] as [string, string])
    : [[PROFIT_STEPS[4], "Most profit on screen"], [PROFIT_STEPS[2], "Middle"], [PROFIT_STEPS[0], "None yet"], [PROFIT_NEGATIVE, "A loss"]];
  return (
    <div className="mt-2">
      {rows.map(([rgb, label]) => (
        <div key={label} className="globe-legend-row static">
          <span className="globe-swatch" style={{ background: `rgb(${rgb})` }} />
          <span>{label}</span>
        </div>
      ))}
      {lens === "recency" && <div className="globe-note mt-1">Days since the last invoice, or the last contact when there is none.</div>}
    </div>
  );
}

function followColor(date: string, today: string): string {
  const d = date.slice(0, 10);
  if (d < today) return `rgb(${FOLLOWUP_RGB.overdue})`;
  if (d === today) return `rgb(${FOLLOWUP_RGB.today})`;
  return "#E7ECF6";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Rejected leads stay out of the globe, as they stay out of the Clients counts.
const liveClients = (list: Client[]) => list.filter((c) => c.approval_status !== "rejected");

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Altitude levels 18% apart: fine enough that marks regroup smoothly as you zoom.
const altToLevel = (alt: number) => Math.round(Math.log(Math.max(0.05, alt)) / Math.log(1.18));
const levelToAlt = (lvl: number) => Math.pow(1.18, lvl);

/**
 * Marks are not depth-tested (the globe cut them in half at its edge), so this
 * does the hiding: full strength facing the camera, fading over the last stretch
 * before the horizon, gone behind it.
 */
function fadeToHorizon(globe: any, s: THREE.Sprite) {
  const cam = globe.camera().position as THREE.Vector3;
  const camLen = cam.length();
  const p = s.position;
  const facing = (p.x * cam.x + p.y * cam.y + p.z * cam.z) / (Math.max(1e-6, p.length()) * camLen);
  const horizon = globe.getGlobeRadius() / camLen;
  const k = Math.min(1, Math.max(0, (facing - horizon) / 0.12));
  (s.material as THREE.SpriteMaterial).opacity = k;
  s.visible = k > 0.02;
}

function escapeHtml(s: string): string {
  return (s || "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch] || ch)
  );
}

function tooltipHtml(g: Group, showMoney: boolean): string {
  const head = g.count === 1 ? escapeHtml(g.clients[0].name) : `${g.count} clients`;
  const where = `${escapeHtml(g.label)}${g.approximate ? " (approximate)" : ""}`;
  const names = g.count > 1
    ? g.clients.slice(0, 3).map((c) => `<span>${escapeHtml(c.name)}</span>`).join("") + (g.count > 3 ? `<span>and ${g.count - 3} more</span>` : "")
    : `<span>${escapeHtml(TIER_NAME[g.clients[0].tier] ?? g.clients[0].tier)}</span>`;
  const money = showMoney ? `<span>${escapeHtml(fmtAmount(g.profit))} profit</span>` : "";
  return `<div class="globe-tip"><strong>${head}</strong><em>${where}</em>${names}${money}</div>`;
}

/**
 * Stars drawn once, not every frame. A shooting star crosses now and then, and
 * only while it is in flight does anything animate. Returns a cleanup.
 */
function initStarfield(canvas: HTMLCanvasElement | null): () => void {
  if (!canvas) return () => {};
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const STAR_COUNT = 450;
  // Subtle blue/white palette so the field reads as deep space, not TV static.
  const COLORS = ["#ffffff", "#e3edff", "#c2d6ff", "#a9c2ff", "#d7e4ff"];
  const stars = Array.from({ length: STAR_COUNT }, () => {
    const bright = Math.random() < 0.06; // a few hero stars get a soft glow
    return {
      x: Math.random(), y: Math.random(),
      size: bright ? 1.3 + Math.random() * 1.0 : 0.4 + Math.random() * 1.1,
      alpha: bright ? 0.7 + Math.random() * 0.3 : 0.12 + Math.random() * 0.5,
      color: bright ? "#eaf2ff" : COLORS[(Math.random() * COLORS.length) | 0],
      bright,
    };
  });
  const paint = () => {
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      ctx.shadowBlur = s.bright ? 6 : 0;
      ctx.shadowColor = s.color;
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };
  let base: ImageData | null = null;
  const resize = () => {
    const p = canvas.parentElement;
    if (!p) return;
    canvas.width = p.clientWidth;
    canvas.height = p.clientHeight;
    paint();
    base = canvas.width && canvas.height ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
  };
  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  resize();

  // Occasional shooting star — same motif as the website, random cadence.
  let raf = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const shoot = () => {
    timer = setTimeout(shoot, 7000 + Math.random() * 10000);
    if (reduceMotion() || document.hidden || !base) return;
    const W = canvas.width, H = canvas.height;
    const fromLeft = Math.random() < 0.5;
    const speed = (0.7 + Math.random() * 0.5) * W;
    const ang = (fromLeft ? 0.22 : 0.78) * Math.PI + (Math.random() - 0.5) * 0.18;
    const sh = {
      x: fromLeft ? Math.random() * W * 0.35 : W * 0.65 + Math.random() * W * 0.35,
      y: Math.random() * H * 0.4,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life: 0, max: 0.9 + Math.random() * 0.5,
    };
    let last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(0.06, (t - last) / 1000);
      last = t;
      sh.life += dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt;
      if (base) ctx.putImageData(base, 0, 0);
      if (sh.life >= sh.max) return;
      const a = Math.sin(Math.min(1, sh.life / sh.max) * Math.PI);
      const tx = sh.x - sh.vx * 0.07, ty = sh.y - sh.vy * 0.07;
      const g = ctx.createLinearGradient(sh.x, sh.y, tx, ty);
      g.addColorStop(0, `rgba(234,242,255,${0.9 * a})`);
      g.addColorStop(1, "rgba(120,170,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.globalAlpha = a; ctx.fillStyle = "#eaf2ff";
      ctx.beginPath(); ctx.arc(sh.x, sh.y, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };
  timer = setTimeout(shoot, 4000 + Math.random() * 6000);

  return () => {
    ro.disconnect();
    if (timer) clearTimeout(timer);
    cancelAnimationFrame(raf);
  };
}
