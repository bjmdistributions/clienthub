import { useEffect, useState, useRef, useCallback } from "react";
import { api, Client } from "../lib/api";
import { fmtAmount } from "../lib/format";
import TierBadge from "./TierBadge";
import { X, MapPin, Clock, DollarSign, ExternalLink, RotateCcw, RefreshCw } from "lucide-react";

const STAR_COUNT  = 900;
const CLOUDS_IMG  = "//unpkg.com/three-globe/example/img/fair_clouds_4k.png";
const CLOUDS_ALT  = 0.004;
const CLOUDS_SPEED = -0.006;

// Initial camera — slightly tilted view of Earth
const HOME_POV = { lat: 25, lng: -30, altitude: 2.0 };

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

// Tier → dot/label color (space-theme palette)
function tierColor(tier: string): string {
  const t = (tier || "").toLowerCase();
  if (t === "s")       return "#7DD3FC"; // diamond — sky blue
  if (t === "a")       return "#FDE68A"; // gold — warm gold
  if (t === "b")       return "#E2E8F0"; // silver — near-white
  if (t === "c")       return "#FDBA74"; // bronze — warm orange
  if (t === "prospect") return "#A5B4FC"; // prospect — indigo
  return "#A5B4FC";
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

  const containerRef       = useRef<HTMLDivElement>(null);
  const starCanvasRef      = useRef<HTMLCanvasElement>(null);
  const globeRef           = useRef<any>(null);
  const starRafRef         = useRef<number>(0);
  const cloudRafRef        = useRef<number>(0);
  const autoRotateTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cleanupRef         = useRef<(() => void) | null>(null);
  // Prevents the OrbitControls "start" event from cancelling programmatic navigation
  const isProgNavRef       = useRef(false);

  const viewProfile = useCallback((clientId: string) => {
    sessionStorage.setItem("clienthub.globe.clientId", clientId);
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
  }, []);

  // Programmatic camera navigation — shields the move from the "start" listener
  const navTo = useCallback((pov: object, duration = 700, thenSpin = false) => {
    const globe = globeRef.current;
    if (!globe) return;
    isProgNavRef.current = true;
    globe.pointOfView(pov, duration);
    if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
    setTimeout(() => {
      isProgNavRef.current = false;
      if (thenSpin && globeRef.current?.controls()) {
        globeRef.current.controls().autoRotate      = true;
        globeRef.current.controls().autoRotateSpeed = 0.45;
      }
    }, duration + 80);
  }, []);

  const runGeocode = useCallback(async () => {
    setGeocoding(true);
    setGeocodeMsg("Geocoding clients…");
    try {
      const msg = await api.geocodeAllClients();
      setGeocodeMsg(msg);
      const allClients = await api.listClientsFiltered({});
      const points = toPoints(allClients);
      setMappedCount(points.length);
      // Hot-reload the labels on the existing globe
      if (globeRef.current && points.length > 0) {
        applyLabels(globeRef.current, points);
      }
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

      // Auto-geocode on first open if nothing is mapped yet
      if (points.length === 0) {
        runGeocode();
      }

      const W     = (window as any);
      const Globe = W.Globe;
      const THREE = W.THREE;
      if (!Globe || !THREE || !containerRef.current) {
        if (!destroyed) setError("Globe unavailable — check internet connection");
        return;
      }
      if (destroyed) return;

      // ── Starfield ───────────────────────────────────────────
      initStarfield(starCanvasRef, starRafRef);

      // ── Globe instance ──────────────────────────────────────
      const globe = Globe()
        .globeImageUrl("//unpkg.com/three-globe/example/img/earth-blue-marble.jpg")
        .bumpImageUrl("//unpkg.com/three-globe/example/img/earth-topology.png")
        .backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true)
        .atmosphereColor("#1a6dff")
        .atmosphereAltitude(0.14)
        .width(containerRef.current.clientWidth)
        .height(containerRef.current.clientHeight)
        (containerRef.current);

      globeRef.current = globe;

      // ── Labels (dot + name) — replaces raw points layer ────
      applyLabels(globe, points);

      globe.onLabelClick((point: any) => {
        globe.controls().autoRotate = false;
        if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
        isProgNavRef.current = true;
        globe.pointOfView({ lat: point.lat, lng: point.lng, altitude: 0.45 }, 500);
        setSelected(point);
        setTimeout(() => { isProgNavRef.current = false; }, 600);
      });

      globe.onGlobeClick(() => {
        setSelected(null);
        navTo(HOME_POV, 700, false);
        if (autoRotateTimerRef.current) clearTimeout(autoRotateTimerRef.current);
        autoRotateTimerRef.current = setTimeout(() => {
          if (globeRef.current?.controls()) {
            globeRef.current.controls().autoRotate      = true;
            globeRef.current.controls().autoRotateSpeed = 0.45;
          }
        }, 3500);
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

      // ── Clouds ──────────────────────────────────────────────
      globe.onGlobeReady?.(() => {
        new THREE.TextureLoader().load(CLOUDS_IMG, (tex: any) => {
          const r      = (globe as any).getGlobeRadius?.() || 100;
          const clouds = new THREE.Mesh(
            new THREE.SphereGeometry(r * (1 + CLOUDS_ALT), 75, 75),
            new THREE.MeshPhongMaterial({ map: tex, transparent: true, opacity: 0.65 })
          );
          globe.scene().add(clouds);
          const spin = () => {
            clouds.rotation.y += (CLOUDS_SPEED * Math.PI) / 180;
            cloudRafRef.current = requestAnimationFrame(spin);
          };
          spin();
        });
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
        if (cloudRafRef.current) cancelAnimationFrame(cloudRafRef.current);
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

  // ── Render ──────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center w-full h-full" style={{ background: "#060610" }}>
      <div className="text-[13px]" style={{ color: "#555" }}>Loading globe…</div>
    </div>
  );

  if (error) return (
    <div className="flex items-center justify-center w-full h-full" style={{ background: "#060610" }}>
      <div className="text-[13px] text-center" style={{ color: "#666" }}>{error}</div>
    </div>
  );

  return (
    <div className="globe-root relative w-full h-full" style={{ background: "#060610", color: "#eef0f6" }}>
      <canvas ref={starCanvasRef} className="globe-starfield" />
      <div ref={containerRef} className="globe-container" />

      {/* Zero-clients overlay */}
      {mappedCount === 0 && !geocoding && (
        <div className="absolute inset-0 flex items-center justify-center z-[5] pointer-events-none">
          <div
            className="text-center px-7 py-5 rounded-2xl"
            style={{
              background: "rgba(10,10,22,0.88)",
              border: "1px solid rgba(165,180,252,0.18)",
              backdropFilter: "blur(8px)",
            }}
          >
            <div className="text-[13px] mb-2" style={{ color: "#888" }}>No client locations found</div>
            <div className="text-[11px]" style={{ color: "#555" }}>Geocoding in progress…</div>
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

function applyLabels(globe: any, points: Point[]) {
  globe
    .labelsData(points)
    .labelLat((d: any)  => d.lat)
    .labelLng((d: any)  => d.lng)
    // Truncate long names so labels don't crowd
    .labelText((d: any) => d.name.length > 20 ? d.name.slice(0, 18) + "…" : d.name)
    .labelSize(0.42)
    .labelDotRadius(0.42)
    .labelColor((d: any) => tierColor(d.tier))
    .labelResolution(3)
    .labelAltitude(0.013)
    .labelIncludeDot(true)
    // Hover tooltip
    .labelLabel((d: any) => `
      <div style="
        background: rgba(6,6,18,0.94);
        border: 1px solid rgba(165,180,252,0.22);
        border-radius: 10px;
        padding: 9px 13px;
        color: #eee;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        min-width: 160px;
        pointer-events: none;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      ">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">${d.name}</div>
        ${d.city || d.state ? `<div style="color:#888">${d.city}${d.state ? ", " + d.state : ""}</div>` : ""}
      </div>
    `);
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
  const draw = () => {
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
    rafRef.current = requestAnimationFrame(draw);
  };
  draw();
}
