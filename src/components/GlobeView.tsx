import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import Globe from "globe.gl";
import { api, Client } from "../lib/api";
import { fmtAmount } from "../lib/format";
import TierBadge from "./TierBadge";
import { X, MapPin, Clock, DollarSign, ExternalLink, RotateCcw, RefreshCw, Search } from "lucide-react";

const STAR_COUNT  = 450;

// Initial camera — slightly tilted view of Earth
const HOME_POV = { lat: 25, lng: -30, altitude: 2.0 };
// Clicking the globe zooms to the continental US so all clients are visible
const US_POV   = { lat: 38, lng: -97, altitude: 0.7 };

interface Point {
  lat: number;
  lng: number;
  name: string;
  city: string;
  state: string;
  tier: string;          // real buyer tier: S / A / B / C / New / Prospect
  highValue: boolean;
  revenue: number;
  lastContact: string | null;
  id: string;
}

// Dots mean something: tier drives color, size, and glow. S/A read brighter
// and larger; prospects sit dim so the whales pop.
const DOT_STYLE: Record<string, { c: string; size: number; glow: number; dim?: boolean }> = {
  S:        { c: "56,189,248",  size: 13, glow: 0.70 },  // Diamond — bright sky
  A:        { c: "251,191,36",  size: 12, glow: 0.60 },  // Gold
  B:        { c: "199,210,224", size: 10, glow: 0.40 },  // Silver
  C:        { c: "224,149,92",  size: 9,  glow: 0.35 },  // Bronze
  Prospect: { c: "139,147,168", size: 7,  glow: 0.20, dim: true },
  New:      { c: "139,147,168", size: 7,  glow: 0.20, dim: true },
};
const dotStyle = (tier: string) => DOT_STYLE[tier] ?? DOT_STYLE.New;
const RANKED = ["S", "A", "B", "C"];

type TierFilter = "all" | "ranked" | "high" | "prospect";
const FILTERS: [TierFilter, string][] = [
  ["all", "All"], ["ranked", "Ranked"], ["high", "High-value"], ["prospect", "Prospects"],
];
function passesFilter(p: Point, f: TierFilter): boolean {
  if (f === "ranked")   return RANKED.includes(p.tier);
  if (f === "high")     return p.highValue;
  if (f === "prospect") return !RANKED.includes(p.tier);
  return true;
}

const relTime = (d: string | null | undefined): string => {
  if (!d) return "Never";
  const ms   = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0)  return "Today";
  if (days === 1)  return "Yesterday";
  if (days < 30)   return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

export default function GlobeView() {
  const [selected,    setSelected]    = useState<Point | null>(null);
  const [points,      setPoints]      = useState<Point[]>([]);
  const [filter,      setFilter]      = useState<TierFilter>("all");
  const [query,       setQuery]       = useState("");
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [geocoding,   setGeocoding]   = useState(false);
  const [geocodeMsg,  setGeocodeMsg]  = useState<string | null>(null);
  const [geocodeSummary, setGeocodeSummary] = useState<{ total: number; matched: number; skipped: number; not_found: number } | null>(null);

  const containerRef       = useRef<HTMLDivElement>(null);
  const starCanvasRef      = useRef<HTMLCanvasElement>(null);
  const globeRef           = useRef<any>(null);
  const starRafRef         = useRef<number>(0);
  const autoRotateTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cleanupRef         = useRef<(() => void) | null>(null);
  // client_id → buyer tier, fetched once and reused by geocode refreshes.
  const tierMapRef         = useRef<Record<string, string>>({});
  // Prevents the OrbitControls "start" event from cancelling programmatic navigation
  const isProgNavRef       = useRef(false);
  // Set briefly when a client dot is clicked so the page-level click handler
  // (which would otherwise re-route to US_POV) leaves the client zoom alone.
  const justClickedDotRef  = useRef(false);

  const viewProfile = useCallback((clientId: string) => {
    sessionStorage.setItem("clienthub.globe.clientId", clientId);
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
  }, []);

  // Programmatic camera move. Only thing we toggle is autoRotate — locking
  // controls.enabled made the globe feel unresponsive during the tween, and
  // it was unnecessary anyway since the tween writes the camera directly.
  const navTo = useCallback((pov: object, duration = 600, thenSpin = false) => {
    const globe = globeRef.current;
    if (!globe) return;
    isProgNavRef.current = true;
    const c = globe.controls?.();
    if (c) c.autoRotate = false;
    globe.pointOfView(pov, duration);
    if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
    setTimeout(() => {
      isProgNavRef.current = false;
      if (thenSpin && globeRef.current?.controls()) {
        const cc = globeRef.current.controls();
        cc.autoRotate      = true;
        cc.autoRotateSpeed = 0.45;
      }
    }, duration + 80);
  }, []);

  const focusPoint = useCallback((d: Point) => {
    justClickedDotRef.current = true;
    setTimeout(() => { justClickedDotRef.current = false; }, 250);
    setSelected(d);
    navTo({ lat: d.lat, lng: d.lng, altitude: 0.35 }, 500, false);
  }, [navTo]);
  const focusPointRef = useRef(focusPoint);
  focusPointRef.current = focusPoint;

  const runGeocode = useCallback(async () => {
    setGeocoding(true);
    setGeocodeMsg("Geocoding clients…");
    try {
      const result = await api.geocodeAllClients();
      setGeocodeMsg(result.message);
      setGeocodeSummary({ total: result.total, matched: result.matched, skipped: result.skipped, not_found: result.not_found });
      const allClients = await api.listClientsFiltered({});
      setPoints(toPoints(allClients, tierMapRef.current));
    } catch (e: any) {
      setGeocodeMsg(e?.toString?.() || "Geocode failed");
    } finally {
      setGeocoding(false);
    }
  }, []);

  useEffect(() => {
    let destroyed = false;

    const init = async () => {
      let allClients: Client[] = [];
      try {
        const [clients, tiers] = await Promise.all([
          api.listClientsFiltered({}),
          api.buyerTiers().catch(() => [] as any[]),
        ]);
        allClients = clients;
        const tm: Record<string, string> = {};
        for (const t of tiers as any[]) tm[t.client_id] = t.tier;
        tierMapRef.current = tm;
      } catch {
        if (destroyed) return;
        setError("Failed to load clients");
        setLoading(false);
        return;
      }
      if (destroyed) return;

      setPoints(toPoints(allClients, tierMapRef.current));
      setLoading(false);

      // Auto-geocode any client that has a city/state/country but isn't placed
      // yet — so newly added or freshly synced clients (incl. international ones)
      // get a pin without needing a manual refresh.
      const hasUnmappedAddressable = allClients.some((c) => {
        const m = c.metadata || {};
        return (m.city || m.state) && !(m.lat || m.lng);
      });
      if (hasUnmappedAddressable) runGeocode();

      if (destroyed) return;

      // containerRef is always mounted now (rendered unconditionally above)
      if (!containerRef.current) {
        setError("Globe container not ready");
        return;
      }

      // ── Starfield ───────────────────────────────────────────
      initStarfield(starCanvasRef, starRafRef);

      // ── Globe instance ──────────────────────────────────────
      let globe: any;
      try {
        globe = Globe()
          .globeImageUrl("https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
          .bumpImageUrl("https://unpkg.com/three-globe/example/img/earth-topology.png")
          .backgroundColor("rgba(0,0,0,0)")
          .showAtmosphere(true)
          .atmosphereColor("#1a6dff")
          .atmosphereAltitude(0.14)
          .width(containerRef.current.clientWidth)
          .height(containerRef.current.clientHeight)
          (containerRef.current);
      } catch (e: any) {
        setError(`Globe init failed: ${e?.message ?? e}`);
        return;
      }

      globeRef.current = globe;
      // Dots are applied by the [points, filter] effect below.

      globe.onGlobeClick(() => {
        // Clicking the globe sphere → zoom into US to see all clients
        setSelected(null);
        navTo(US_POV, 600, false);
      });

      // ── Controls ────────────────────────────────────────────
      const ctrl = globe.controls();
      ctrl.autoRotate      = true;
      ctrl.autoRotateSpeed = 0.45;
      ctrl.zoomSpeed       = 5.0;   // was 2.5 — much snappier
      ctrl.enableDamping   = true;
      ctrl.dampingFactor   = 0.22;  // was 0.12 — more responsive
      ctrl.minDistance     = 101;
      ctrl.maxDistance     = 700;

      ctrl.addEventListener("start", () => {
        if (isProgNavRef.current) return; // programmatic nav — don't interfere
        ctrl.autoRotate = false;
        if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
      });

      // ── Resize ──────────────────────────────────────────────
      const onResize = () => {
        if (!containerRef.current) return;
        globe.width(containerRef.current.clientWidth);
        globe.height(containerRef.current.clientHeight);
      };
      window.addEventListener("resize", onResize);

      cleanupRef.current = () => {
        window.removeEventListener("resize", onResize);
        if (starRafRef.current) cancelAnimationFrame(starRafRef.current);
        if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
        if (globe._destructor) globe._destructor();
        globeRef.current = null;
      };
    };

    init();
    return () => { destroyed = true; cleanupRef.current?.(); };
  }, [navTo, runGeocode]);

  // ── Plotted points follow the tier filter (one htmlElementsData call —
  //    nothing per-frame, so a large client list stays cheap). ─────────
  const visible = useMemo(() => points.filter((p) => passesFilter(p, filter)), [points, filter]);
  useEffect(() => {
    if (globeRef.current) applyDots(globeRef.current, visible, (d) => focusPointRef.current(d));
  }, [visible, loading]);

  // Search — match by name or city, fly to the pick.
  const q = query.trim().toLowerCase();
  const results = useMemo(() => (
    q ? points.filter((p) => p.name.toLowerCase().includes(q) || p.city.toLowerCase().includes(q)).slice(0, 8) : []
  ), [q, points]);

  // Small stats strip: what's on the map right now.
  const stats = useMemo(() => {
    const revenue = visible.reduce((s, p) => s + (p.revenue || 0), 0);
    const byState: Record<string, number> = {};
    for (const p of visible) if (p.state) byState[p.state] = (byState[p.state] || 0) + 1;
    const top = Object.entries(byState).sort((a, b) => b[1] - a[1])[0];
    return { revenue, topState: top ? `${top[0]} (${top[1]})` : null };
  }, [visible]);

  // ── Handlers ────────────────────────────────────────────────
  const handleRespin = () => {
    setSelected(null);
    navTo(HOME_POV, 800, true);
  };

  // Clicking anywhere on the globe page (other than dots, buttons, or the
  // client panel) zooms into the US. The native click bubbles up here even
  // when the user clicks empty canvas space that globe.gl didn't handle.
  const handleRootClick = (e: React.MouseEvent) => {
    if (justClickedDotRef.current) return; // a dot click is mid-flight
    const t = e.target as HTMLElement;
    // Skip clicks on UI overlays/buttons/panels so they keep working
    if (t.closest("button, input, .globe-client-panel, .globe-bottom-bar, .globe-top-controls, .globe-geocode-msg, .globe-chips, .globe-search-wrap, .globe-legend")) return;
    if (selected) return; // panel is open — let X-button handle close
    navTo(US_POV, 600, false);
  };

  // ── Render ──────────────────────────────────────────────────
  // Always render the container so containerRef is mounted before the async
  // init resolves — otherwise containerRef.current would be null when checked.
  // Loading and error states are overlays, not replacements.
  return (
    <div
      className="globe-root relative w-full h-full"
      style={{ background: "#060610", color: "#eef0f6" }}
      onClick={handleRootClick}
    >
      <div className="globe-neb" />
      <canvas ref={starCanvasRef} className="globe-starfield" />
      <div ref={containerRef} className="globe-container" />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px]" style={{ color: "#7E8798" }}>Loading globe…</div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px] text-center" style={{ color: "#7E8798" }}>{error}</div>
        </div>
      )}

      {/* Tier filter chips */}
      {points.length > 0 && (
        <div className="globe-chips globe-glass">
          {FILTERS.map(([f, label]) => (
            <button key={f} onClick={() => setFilter(f)} className={`globe-chip ${filter === f ? "on" : ""}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Client search — fly to a client */}
      {points.length > 0 && (
        <div className="globe-search-wrap">
          <div className="globe-glass relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "#6B7488" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a client…"
              spellCheck={false}
            />
          </div>
          {results.length > 0 && (
            <div className="globe-glass mt-1.5 overflow-hidden">
              {results.map((p) => {
                const ds = dotStyle(p.tier);
                return (
                  <button key={p.id}
                    onClick={() => {
                      setQuery("");
                      // If the current filter hides this client, widen it so the dot exists.
                      if (!passesFilter(p, filter)) setFilter("all");
                      focusPoint(p);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-white/[0.06]">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: `rgb(${ds.c})` }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium truncate" style={{ color: "#F2F4F8" }}>{p.name}</span>
                      {(p.city || p.state) && (
                        <span className="block text-[11px] truncate" style={{ color: "#7E8798" }}>
                          {p.city}{p.state ? `, ${p.state}` : ""}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {q && results.length === 0 && (
            <div className="globe-glass mt-1.5 px-3 py-2 text-[11.5px]" style={{ color: "#7E8798" }}>
              No mapped client matches
            </div>
          )}
        </div>
      )}

      {/* Legend — what dot color/size means */}
      {points.length > 0 && (
        <div className="globe-legend globe-glass">
          {(["S", "A", "B", "C", "Prospect"] as const).map((t) => {
            const ds = dotStyle(t);
            return (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className="rounded-full flex-shrink-0"
                  style={{ width: Math.max(5, ds.size - 4), height: Math.max(5, ds.size - 4), background: `rgb(${ds.c})`, opacity: ds.dim ? 0.7 : 1 }} />
                {t === "S" ? "Diamond" : t === "A" ? "Gold" : t === "B" ? "Silver" : t === "C" ? "Bronze" : "Prospect"}
              </span>
            );
          })}
        </div>
      )}

      {/* Zero-clients overlay */}
      {points.length === 0 && !loading && !geocoding && (
        <div className="absolute inset-0 flex items-center justify-center z-[5]">
          <div className="text-center px-7 py-5 rounded-2xl pointer-events-auto globe-glass">
            <div className="text-[13px] mb-2" style={{ color: "#A9B1C6" }}>No client locations mapped</div>
            {geocodeSummary ? (
              <div className="text-[11px] leading-relaxed mb-3" style={{ color: "#7E8798" }}>
                {geocodeSummary.total} client{geocodeSummary.total !== 1 ? "s" : ""} total ·
                {geocodeSummary.matched > 0 && <span> {geocodeSummary.matched} newly plotted ·</span>} {geocodeSummary.skipped} have no city/state
              </div>
            ) : (
              <div className="text-[11px] leading-relaxed mb-3" style={{ color: "#7E8798" }}>
                Add city/state to your client records to plot them on the globe.
              </div>
            )}
            <button
              onClick={() => {
                sessionStorage.setItem("clienthub.clients.filter.missing", "address");
                window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
              }}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: "var(--accent-tint)", color: "var(--accent-400)", border: "1px solid var(--accent-glow)" }}
            >
              Fill in addresses
            </button>
          </div>
        </div>
      )}

      {/* Bottom bar — live stats for what's plotted */}
      <div className="globe-bottom-bar">
        <div className="globe-stats-badge">
          {visible.length} client{visible.length !== 1 ? "s" : ""} mapped
          {stats.revenue > 0 && <span> · {fmtAmount(stats.revenue)} represented</span>}
          {stats.topState && <span> · top: {stats.topState}</span>}
        </div>
        <button
          onClick={runGeocode}
          disabled={geocoding}
          className="globe-geocode-btn"
          title="Re-geocode all clients"
        >
          <RefreshCw size={13} className={geocoding ? "animate-spin" : ""} />
        </button>
        {geocodeMsg && (
          <div className="globe-geocode-msg">{geocodeMsg}</div>
        )}
      </div>

      {/* Top-right controls */}
      <div className="globe-top-controls">
        <button
          onClick={handleRespin}
          className="globe-ctrl-btn"
          title="Reset view and spin"
        >
          <RotateCcw size={15} />
        </button>
      </div>

      {/* Client detail panel */}
      {selected && (
        <div className="globe-client-panel open">
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-[15px] font-semibold mb-1.5">{selected.name}</h3>
                <div className="flex items-center gap-1.5">
                  <TierBadge tier={selected.tier} size="sm" />
                  {selected.highValue && (
                    <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={{ color: "#FFA45C", background: "rgba(255,101,32,0.14)", border: "1px solid rgba(255,101,32,0.3)" }}>
                      High value
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="transition-colors"
                style={{ color: "#7E8798" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#eee")}
                onMouseLeave={e => (e.currentTarget.style.color = "#7E8798")}
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-2.5 text-[13px]" style={{ color: "#A9B1C6" }}>
              {(selected.city || selected.state) && (
                <div className="flex items-center gap-2">
                  <MapPin size={13} style={{ color: "var(--accent-500)" }} />
                  {selected.city}{selected.state ? `, ${selected.state}` : ""}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Clock size={13} style={{ color: "#7E8798" }} />
                Last contact: {relTime(selected.lastContact)}
              </div>
              <div className="flex items-center gap-2">
                <DollarSign size={13} style={{ color: "#3EC785" }} />
                Total revenue: <span className="tabular-nums font-semibold" style={{ color: "#F2F4F8" }}>{fmtAmount(selected.revenue)}</span>
              </div>
            </div>

            <button
              onClick={() => viewProfile(selected.id)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors"
              style={{
                background: "var(--accent-tint)",
                color: "var(--accent-400)",
                border: "1px solid var(--accent-glow)",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-glow)")}
              onMouseLeave={e => (e.currentTarget.style.background = "var(--accent-tint)")}
            >
              <ExternalLink size={12} />
              Open client
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPoints(clients: Client[], tierMap: Record<string, string>): Point[] {
  return clients
    .map(c => {
      const meta = c.metadata || {};
      if (!meta.lat || !meta.lng) return null;
      return {
        lat:         meta.lat,
        lng:         meta.lng,
        name:        c.name,
        city:        meta.city  || "",
        state:       meta.state || "",
        tier:        tierMap[c.id] || "New",
        highValue:   !!(c.high_value || meta.high_value),
        revenue:     c.total_revenue || 0,
        lastContact: c.last_contact_at || null,
        id:          c.id,
      };
    })
    .filter(Boolean) as Point[];
}

// Two-element pattern: globe.gl writes `style.transform` directly on the
// element it gets back from htmlElement. If we styled the dot itself we'd
// fight that inline transform. Instead, the outer wrap (zero-sized) is what
// globe.gl positions, and the inner dot is absolutely positioned so that
// its center sits exactly on the wrap's origin — i.e. the geo coord.
function applyDots(globe: any, points: Point[], onClick: (d: Point) => void) {
  globe
    .htmlElementsData(points)
    .htmlLat((d: Point) => d.lat)
    .htmlLng((d: Point) => d.lng)
    .htmlAltitude(0.005)
    .htmlElement((d: Point) => {
      const ds = dotStyle(d.tier);

      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;width:0;height:0;pointer-events:none";

      const dot = document.createElement("div");
      dot.className = "globe-dot";
      dot.style.background = `rgb(${ds.c})`;
      dot.style.setProperty("--dot-s", `${ds.size + (d.highValue ? 2 : 0)}px`);
      dot.style.setProperty("--dot-c", ds.c);
      dot.style.setProperty("--dot-glow", String(d.highValue ? Math.min(ds.glow + 0.2, 0.9) : ds.glow));
      if (ds.dim && !d.highValue) dot.style.opacity = "0.75";
      dot.innerHTML = `
        <div class="globe-dot-tip">
          <strong>${escapeHtml(d.name)}</strong>
          <span>${escapeHtml(tierLabel(d.tier))}${d.city || d.state ? ` · ${escapeHtml(d.city)}${d.state ? ", " + escapeHtml(d.state) : ""}` : ""}</span>
        </div>`;
      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onClick(d);
      });

      wrap.appendChild(dot);
      return wrap;
    });
}

function tierLabel(t: string): string {
  return t === "S" ? "Diamond" : t === "A" ? "Gold" : t === "B" ? "Silver" : t === "C" ? "Bronze" : t;
}

function escapeHtml(s: string): string {
  return (s || "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch] || ch)
  );
}

function initStarfield(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  rafRef:    React.MutableRefObject<number>
) {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const resize = () => {
    const p = canvas.parentElement;
    if (!p) return;
    canvas.width  = p.clientWidth;
    canvas.height = p.clientHeight;
  };
  resize();
  window.addEventListener("resize", resize);

  const reduceMotion = matchMedia("(prefers-reduced-motion:reduce)").matches;
  // Subtle blue/white palette so the field reads as deep space, not TV static.
  const COLORS = ["#ffffff", "#e3edff", "#c2d6ff", "#a9c2ff", "#d7e4ff"];
  const stars = Array.from({ length: STAR_COUNT }, () => {
    const bright = Math.random() < 0.06; // a few hero stars get a soft glow
    return {
      x: Math.random(),
      y: Math.random(),
      size: bright ? 1.3 + Math.random() * 1.0 : 0.4 + Math.random() * 1.1,
      baseOpacity: bright ? 0.7 + Math.random() * 0.3 : 0.18 + Math.random() * 0.62,
      speed: 0.4 + Math.random() * 1.8,
      color: bright ? "#eaf2ff" : COLORS[(Math.random() * COLORS.length) | 0],
      bright,
    };
  });

  // Occasional shooting star — same motif as the website, random cadence.
  type Shoot = { x: number; y: number; vx: number; vy: number; life: number; max: number };
  let shoots: Shoot[] = [];
  let nextShoot = 4 + Math.random() * 6;
  const spawnShoot = (W: number, H: number) => {
    const fromLeft = Math.random() < 0.5;
    const speed = (0.7 + Math.random() * 0.5) * W;
    const ang = (fromLeft ? 0.22 : 0.78) * Math.PI + (Math.random() - 0.5) * 0.18;
    shoots.push({
      x: fromLeft ? Math.random() * W * 0.35 : W * 0.65 + Math.random() * W * 0.35,
      y: Math.random() * H * 0.4,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      life: 0, max: 0.9 + Math.random() * 0.5,
    });
  };

  let frame = 0;
  let lastDraw = 0;
  // Cap redraw at ~30 FPS — twinkle is imperceptibly different from 60 and
  // halves the CPU spent on the background canvas.
  const FRAME_MS = 1000 / 30;
  const draw = (t: number) => {
    rafRef.current = requestAnimationFrame(draw);
    if (t - lastDraw < FRAME_MS) return;
    const dt = Math.min(0.06, (t - lastDraw) / 1000 || 0);
    lastDraw = t;
    frame++;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const opacity = s.baseOpacity * (0.5 + 0.5 * Math.sin(frame * 0.018 * s.speed));
      if (s.bright) { ctx.shadowBlur = 6; ctx.shadowColor = s.color; } else { ctx.shadowBlur = 0; }
      ctx.globalAlpha = opacity;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (!reduceMotion) {
      nextShoot -= dt;
      if (nextShoot <= 0) { spawnShoot(w, h); nextShoot = 7 + Math.random() * 10; }
      for (let i = shoots.length - 1; i >= 0; i--) {
        const sh = shoots[i];
        sh.life += dt; sh.x += sh.vx * dt; sh.y += sh.vy * dt;
        if (sh.life >= sh.max || sh.x < -200 || sh.x > w + 200 || sh.y > h + 200) { shoots.splice(i, 1); continue; }
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
      }
    }
  };
  rafRef.current = requestAnimationFrame(draw);
}
