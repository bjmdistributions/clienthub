import { useEffect, useState, useRef, useCallback } from "react";
import Globe from "globe.gl";
import { api, Client } from "../lib/api";
import { fmtAmount } from "../lib/format";
import TierBadge from "./TierBadge";
import { X, MapPin, Clock, DollarSign, ExternalLink, RotateCcw, RefreshCw } from "lucide-react";

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
  tier: string;
  revenue: number;
  lastContact: string | null;
  id: string;
}

// All client dots are red
function tierColor(_tier: string): string {
  return "#EF4444";
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
  const [mappedCount, setMappedCount] = useState(0);
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

  const runGeocode = useCallback(async () => {
    setGeocoding(true);
    setGeocodeMsg("Geocoding clients…");
    try {
      const result = await api.geocodeAllClients();
      setGeocodeMsg(result.message);
      setGeocodeSummary({ total: result.total, matched: result.matched, skipped: result.skipped, not_found: result.not_found });
      const allClients = await api.listClientsFiltered({});
      const pts = toPoints(allClients);
      setMappedCount(pts.length);
      if (globeRef.current && pts.length > 0) {
        applyDots(globeRef.current, pts, (d) => {
          justClickedDotRef.current = true;
          setTimeout(() => { justClickedDotRef.current = false; }, 250);
          setSelected(d);
          navTo({ lat: d.lat, lng: d.lng, altitude: 0.35 }, 500, false);
        });
      }
    } catch (e: any) {
      setGeocodeMsg(e?.toString?.() || "Geocode failed");
    } finally {
      setGeocoding(false);
    }
  }, [navTo]);

  useEffect(() => {
    let destroyed = false;

    const init = async () => {
      let allClients: Client[] = [];
      try {
        allClients = await api.listClientsFiltered({});
      } catch {
        if (destroyed) return;
        setError("Failed to load clients");
        setLoading(false);
        return;
      }
      if (destroyed) return;

      const points = toPoints(allClients);
      setMappedCount(points.length);
      setLoading(false);

      // Auto-geocode on first open if nothing is mapped yet — but only if
      // any clients have city/state to geocode
      if (points.length === 0) {
        const hasAddressable = allClients.some((c) => {
          const m = c.metadata || {};
          return (m.city || m.state) && !(m.lat || m.lng);
        });
        if (hasAddressable) runGeocode();
      }

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

      // ── Client dots (DOM-based, fixed pixel size) ──────────
      // Clusters resolve naturally on zoom because dots don't grow on screen.
      const onDotClick = (d: Point) => {
        justClickedDotRef.current = true;
        setTimeout(() => { justClickedDotRef.current = false; }, 250);
        setSelected(d);
        navTo({ lat: d.lat, lng: d.lng, altitude: 0.35 }, 500, false);
      };
      applyDots(globe, points, onDotClick);

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
    if (t.closest("button, .globe-client-panel, .globe-bottom-bar, .globe-top-controls, .globe-geocode-msg")) return;
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
      <canvas ref={starCanvasRef} className="globe-starfield" />
      <div ref={containerRef} className="globe-container" />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px]" style={{ color: "#555" }}>Loading globe…</div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-[13px] text-center" style={{ color: "#666" }}>{error}</div>
        </div>
      )}

      {/* Zero-clients overlay */}
      {mappedCount === 0 && !geocoding && (
        <div className="absolute inset-0 flex items-center justify-center z-[5]">
          <div
            className="text-center px-7 py-5 rounded-2xl pointer-events-auto"
            style={{
              background: "rgba(10,10,22,0.88)",
              border: "1px solid rgba(165,180,252,0.18)",
              backdropFilter: "blur(8px)",
            }}
          >
            <div className="text-[13px] mb-2" style={{ color: "#888" }}>No client locations mapped</div>
            {geocodeSummary ? (
              <div className="text-[11px] leading-relaxed mb-3" style={{ color: "#666" }}>
                {geocodeSummary.total} client{geocodeSummary.total !== 1 ? "s" : ""} total ·
                {geocodeSummary.matched > 0 && <span> {geocodeSummary.matched} newly plotted ·</span>} {geocodeSummary.skipped} have no city/state
              </div>
            ) : (
              <div className="text-[11px] leading-relaxed mb-3" style={{ color: "#666" }}>
                Add city/state to your client records to plot them on the globe.
              </div>
            )}
            <button
              onClick={() => {
                sessionStorage.setItem("clienthub.clients.filter.missing", "address");
                window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
              }}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: "rgba(99,102,241,0.2)", color: "#A5B4FC", border: "1px solid rgba(165,180,252,0.25)" }}
            >
              Fill in Addresses →
            </button>
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div className="globe-bottom-bar">
        <div className="globe-stats-badge">
          {mappedCount} client{mappedCount !== 1 ? "s" : ""} mapped
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
                <TierBadge tier={selected.tier} size="sm" />
              </div>
              <button
                onClick={() => setSelected(null)}
                className="transition-colors"
                style={{ color: "#555" }}
                onMouseEnter={e => (e.currentTarget.style.color = "#eee")}
                onMouseLeave={e => (e.currentTarget.style.color = "#555")}
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-2.5 text-[13px]" style={{ color: "#aaa" }}>
              {(selected.city || selected.state) && (
                <div className="flex items-center gap-2">
                  <MapPin size={13} style={{ color: "#6366F1" }} />
                  {selected.city}{selected.state ? `, ${selected.state}` : ""}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Clock size={13} style={{ color: "#555" }} />
                Last contact: {relTime(selected.lastContact)}
              </div>
              <div className="flex items-center gap-2">
                <DollarSign size={13} style={{ color: "#34D399" }} />
                Total revenue: {fmtAmount(selected.revenue)}
              </div>
            </div>

            <button
              onClick={() => viewProfile(selected.id)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors"
              style={{
                background: "rgba(99,102,241,0.12)",
                color: "#A5B4FC",
                border: "1px solid rgba(99,102,241,0.22)",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(99,102,241,0.22)")}
              onMouseLeave={e => (e.currentTarget.style.background = "rgba(99,102,241,0.12)")}
            >
              <ExternalLink size={12} />
              View Full Profile
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPoints(clients: Client[]): Point[] {
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
        tier:        c.lead_status || "prospect",
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
      const c = tierColor(d.tier);

      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;width:0;height:0;pointer-events:none";

      const dot = document.createElement("div");
      dot.className = "globe-dot";
      dot.style.background = c;
      dot.innerHTML = `
        <div class="globe-dot-tip">
          <strong>${escapeHtml(d.name)}</strong>
          ${d.city || d.state ? `<span>${escapeHtml(d.city)}${d.state ? ", " + escapeHtml(d.state) : ""}</span>` : ""}
        </div>`;
      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onClick(d);
      });

      wrap.appendChild(dot);
      return wrap;
    });
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

  const stars = Array.from({ length: STAR_COUNT }, () => ({
    x:           Math.random(),
    y:           Math.random(),
    size:        0.4 + Math.random() * 1.4,
    baseOpacity: 0.2 + Math.random() * 0.7,
    speed:       0.4 + Math.random() * 1.8,
  }));

  let frame = 0;
  let lastDraw = 0;
  // Cap star redraw at ~30 FPS — twinkle is imperceptibly different from 60
  // and halves the CPU spent on the background canvas.
  const FRAME_MS = 1000 / 30;
  const draw = (t: number) => {
    rafRef.current = requestAnimationFrame(draw);
    if (t - lastDraw < FRAME_MS) return;
    lastDraw = t;
    frame++;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const opacity = s.baseOpacity * (0.5 + 0.5 * Math.sin(frame * 0.018 * s.speed));
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${opacity})`;
      ctx.fill();
    }
  };
  rafRef.current = requestAnimationFrame(draw);
}
