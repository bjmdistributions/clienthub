import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { Phone } from "lucide-react";
import StatusPill from "./StatusPill";
import { cssRgb, hex, loadMapLibre, loadStyle, openLogisticsSettings, readColors, safeFit, themeKey } from "./LogisticsMap";
import { recolor } from "../lib/freightMapStyle";
import { STAGES, STATUS_LABEL, emailedLine, outreach, saidLine, spread, stageOf, type Lead, type MapAnswer } from "../lib/outreach";

// R-581: every Cold calls warehouse as a pin on the same real basemap as the Logistics map (MapLibre on OpenFreeMap),
// coloured by where it stands. The points come from the server (the street address the notes start with, else the city),
// which looks them up through the logistics geocoder and keeps each answer; an ask places 40 at most, so while some are
// still waiting this asks again every 15 seconds.

const PINS = "cc-pins", DOTS = "cc-dots";

export default function ColdCallsMap({ leads, onOpen }: { leads: Lead[]; onOpen: (id: string) => void }) {
  const [ans, setAns] = useState<MapAnswer | null>(null);
  const [error, setError] = useState("");
  const [lib, setLib] = useState<typeof import("maplibre-gl") | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [theme, setTheme] = useState(themeKey);
  const [picked, setPicked] = useState<string | null>(null);
  // Counts each style the map has loaded, so the pins are put back into every one (the first, and each theme change).
  const [styled, setStyled] = useState(0);
  const el = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const fitted = useRef(false);

  useEffect(() => {
    let dead = false, timer = 0;
    const ask = async () => {
      try {
        const a = await outreach.map();
        if (dead) return;
        setAns(a); setError("");
        if (a.pending > 0 && !a.problem) timer = window.setTimeout(ask, 15_000);
      } catch (e) { if (!dead) setError(e instanceof Error ? e.message : String(e)); }
    };
    ask();
    return () => { dead = true; window.clearTimeout(timer); };
    // Asked again when warehouses are added, so new ones are placed without leaving the map.
  }, [leads.length]);

  useEffect(() => {
    let dead = false;
    loadMapLibre().then((l) => { if (!dead) setLib(l); }).catch(() => { if (!dead) setError("The map could not load. Check your connection."); });
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(themeKey()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  const byId = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const pins = useMemo(() => spread((ans?.pins ?? []).filter((p) => byId.has(p.id))), [ans, byId]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of pins) { const s = stageOf(byId.get(p.id)!); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [pins, byId]);

  useEffect(() => {
    if (!lib || !el.current) return;
    const m = new lib.Map({
      container: el.current, style: { version: 8, sources: {}, layers: [] }, center: [-98.35, 39.5], zoom: 3, minZoom: 2, maxZoom: 17,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new lib.AttributionControl({ compact: true }), "bottom-right");
    m.on("style.load", () => {
      const paper = hex(cssRgb("--c-map-paper"));
      m.addSource(PINS, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: DOTS, type: "circle", source: PINS,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 10, 8],
          "circle-color": ["get", "c"], "circle-stroke-color": paper, "circle-stroke-width": ["case", ["==", ["get", "sel"], 1], 3.5, 1.5],
        },
      });
      ready.current = true;
      setStyled((n) => n + 1);
    });
    const hit = (e: MapMouseEvent): [[number, number], [number, number]] => [[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]];
    m.on("click", (e) => {
      if (!ready.current) return;
      const f = m.queryRenderedFeatures(hit(e), { layers: [DOTS] })[0];
      setPicked(f ? String(f.properties?.id) : null);
    });
    m.on("mousemove", (e) => { if (ready.current) m.getCanvas().style.cursor = m.queryRenderedFeatures(hit(e), { layers: [DOTS] }).length ? "pointer" : ""; });
    setMap(m);
    return () => { ready.current = false; setMap(null); m.remove(); };
  }, [lib]);

  useEffect(() => {
    if (!map) return;
    let dead = false;
    const c = readColors();
    loadStyle(c.dark).then((style) => {
      if (dead) return;
      ready.current = false;
      map.setStyle(recolor(style, c) as unknown as Parameters<MapLibreMap["setStyle"]>[0], { diff: false });
    }).catch(() => { if (!dead) setError("The map could not load. Check your connection."); });
    return () => { dead = true; };
  }, [map, theme]);

  useEffect(() => {
    if (!map || !ready.current) return;
    const colour = Object.fromEntries(STAGES.map(([s, , token]) => [s, hex(cssRgb(token))]));
    const src = map.getSource(PINS) as GeoJSONSource | undefined;
    void src?.setData({
      type: "FeatureCollection",
      features: pins.map((p) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { id: p.id, c: colour[stageOf(byId.get(p.id)!)], sel: p.id === picked ? 1 : 0 },
      })),
    });
    if (pins.length && !fitted.current) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const p of pins) { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
      if (safeFit(map, [[w, s], [e, n]], 48, 11)) fitted.current = true;
    }
  }, [map, pins, picked, byId, styled]);

  const sel = picked ? byId.get(picked) : undefined;
  const selPin = pins.find((p) => p.id === picked);
  const waiting = ans?.pending ?? 0;
  const notOnMap = leads.length - pins.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-2 text-[12.5px] text-ink-2">
        {STAGES.map(([s, lb, token]) => (
          <span key={s} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span style={{ color: `rgb(var(${token}))` }}>{lb}</span>
            <span className="tabular-nums text-muted">{counts[s] ?? 0}</span>
          </span>
        ))}
      </div>
      {ans?.problem ? (
        <div className="mb-2 text-[12.5px] text-warning-ink flex flex-wrap items-center gap-2">
          {ans.problem === "no_key" ? "Pins need the route key the Logistics map uses." : "OpenRouteService refused the route key."}
          <button onClick={openLogisticsSettings} className="underline">Open Settings</button>
        </div>
      ) : (waiting > 0 || notOnMap > 0) && (
        <p className="mb-2 text-[12.5px] text-muted">
          {waiting > 0 ? `Placing the rest on the map, ${waiting} to go. ` : ""}
          {notOnMap > 0 && waiting === 0 ? `${notOnMap} not on the map: no street address in their notes and no city and state.` : ""}
        </p>
      )}
      {error && <p className="mb-2 text-[12.5px] text-danger-ink">{error}</p>}
      <div className="relative h-[560px] rounded-xl overflow-hidden border border-line bg-surface-2">
        {/* Its own height, not inset-0: MapLibre's stylesheet makes the container position: relative. */}
        <div ref={el} className="h-full w-full" />
        {sel && (
          <div className="absolute left-3 bottom-3 w-[340px] max-w-[calc(100%-24px)] bg-surface rounded-xl shadow-lg p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink truncate">{sel.company}</div>
                <div className="text-[12.5px] text-muted truncate">
                  {[sel.city, sel.state].filter(Boolean).join(", ")}{selPin?.place === "city" ? ", placed by city" : ""}
                </div>
              </div>
              <StatusPill tone="neutral" size="md">{STATUS_LABEL[sel.status] ?? sel.status}</StatusPill>
            </div>
            {(sel.phone_shown || sel.phone) && (
              <div className="mt-2 text-[16px] font-medium text-ink tabular-nums inline-flex items-center gap-1.5 select-text">
                <Phone size={14} className="text-muted" />{sel.phone_shown || sel.phone}
              </div>
            )}
            <div className="mt-1 text-[12.5px] text-ink-2">
              {emailedLine(sel)}{sel.texted ? `, texted by ${sel.texted.by || "the team"}` : ""}
            </div>
            {sel.said && <div className="mt-1.5 text-[13px] text-ink line-clamp-3">{saidLine(sel.said)}</div>}
            <div className="mt-3 flex gap-2">
              <button onClick={() => onOpen(sel.id)} className="ui-btn ui-btn-ink">Open</button>
              <button onClick={() => setPicked(null)} className="ui-btn">Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
