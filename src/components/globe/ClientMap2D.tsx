// The flat view of the Globe tab: the US by state (Albers USA, the storefront's
// geometry) or the world by country (Natural Earth). Regions are shaded by how many
// clients (or how much profit) they hold, so "where do I have nobody" reads at a
// glance; client marks sit on top and merge by on-screen distance like the globe's.
import { useEffect, useMemo, useRef, useState } from "react";
import { geoAlbersUsa, geoContains, geoNaturalEarth1, geoPath } from "d3-geo";
import type { FeatureCollection, Geometry } from "geojson";
import { Minus, Plus, Maximize2 } from "lucide-react";
import countriesJson from "../../assets/countries-110m.json";
import { US_MAP_VIEWBOX, US_STATE_PATHS } from "../../lib/us-map";
import { stateName } from "../../lib/location";
import { fmtAmount } from "../../lib/format";
import { clusterPlaces, lensRgb, type Group, type Lens, type RegionRow } from "./places";
import { countLabel, markPx } from "./marks";

type Countries = FeatureCollection<Geometry, { name: string; iso: string }>;
const countries = countriesJson as unknown as Countries;

// us-atlas pre-projected its states with exactly this projection.
const albers = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const WORLD_BOX: [number, number] = [1024, 540];
const natural = geoNaturalEarth1().fitExtent([[6, 6], [WORLD_BOX[0] - 6, WORLD_BOX[1] - 6]], countries);
const worldPath = geoPath(natural);
const WORLD_PATHS = countries.features.map((f) => ({ f, d: worldPath(f) || "" }));

// Wider than the globe's: flat-map clusters carry a count and must not touch.
const MARK_SPACING_PX = 34;
const NO_CLIENTS = "rgba(120,138,175,0.07)";

interface Props {
  scope: "us" | "world";
  places: Group[];
  regions: RegionRow[];
  lens: Lens;
  today: string;
  showMoney: boolean;
  selectedKey: string | null;
  regionFilter: string;
  onSelect: (g: Group) => void;
  onRegion: (region: string) => void;
  onScope: (s: "us" | "world") => void;
}

interface Tip { x: number; y: number; title: string; lines: string[] }

export default function ClientMap2D({ scope, places, regions, lens, today, showMoney, selectedKey, regionFilter, onSelect, onRegion, onScope }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [tip, setTip] = useState<Tip | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const [vbX, vbY, vbW, vbH] = scope === "us"
    ? US_MAP_VIEWBOX.split(" ").map(Number)
    : [0, 0, WORLD_BOX[0], WORLD_BOX[1]];
  const unitsPerPx = vbW / Math.max(1, width);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setView({ k: 1, x: 0, y: 0 }), [scope]);

  // Projected position of every place in this scope (the US view drops the rest).
  const projected = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const p of places) {
      const xy = scope === "us" ? albers([p.lng, p.lat]) : natural([p.lng, p.lat]);
      if (xy) m.set(p.key, [xy[0], xy[1]]);
    }
    return m;
  }, [places, scope]);
  const inScope = useMemo(() => places.filter((p) => projected.has(p.key)), [places, projected]);
  const outside = places.reduce((s, p) => s + (projected.has(p.key) ? 0 : p.count), 0);

  // Merge by distance on screen: the radius shrinks as you zoom in.
  const groups = useMemo(() => {
    const r = (MARK_SPACING_PX * unitsPerPx) / view.k;
    return clusterPlaces(inScope, r, today, (a, b) => {
      const pa = projected.get(a.key)!, pb = projected.get(b.key)!;
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    });
  }, [inScope, projected, unitsPerPx, view.k, today]);

  const profitTop = Math.max(0, ...groups.map((g) => g.profit));
  const byProfit = lens === "profit" && showMoney;

  // Region shading. The US view reads the rollup, which also counts clients the
  // map cannot pin; the world view counts pinned clients per country outline.
  const shade = useMemo(() => {
    const value = new Map<string, { count: number; profit: number }>();
    if (scope === "us") {
      for (const r of regions) if (r.region.startsWith("US-")) value.set(r.region.slice(3), { count: r.count, profit: r.profit });
    } else {
      for (const p of places) {
        const f = countries.features.find((c) => geoContains(c, [p.lng, p.lat]));
        if (!f) continue;
        const v = value.get(f.properties.name) || { count: 0, profit: 0 };
        v.count += p.count; v.profit += p.profit;
        value.set(f.properties.name, v);
      }
    }
    const metric = (v: { count: number; profit: number }) => (byProfit ? Math.max(0, v.profit) : v.count);
    const max = Math.max(0, ...[...value.values()].map(metric));
    const fill = (key: string) => {
      const v = value.get(key);
      if (!v || metric(v) <= 0 || max <= 0) return NO_CLIENTS;
      return `rgba(124,142,220,${(0.14 + 0.5 * Math.sqrt(metric(v) / max)).toFixed(3)})`;
    };
    return { value, fill };
  }, [scope, regions, places, byProfit]);

  const regionTip = (key: string, label: string, e: React.PointerEvent) => {
    const v = shade.value.get(key);
    const lines = v
      ? [`${v.count} client${v.count !== 1 ? "s" : ""}`, ...(showMoney ? [`${fmtAmount(v.profit)} profit`] : [])]
      : ["No clients"];
    showTip(e, label, lines);
  };
  const showTip = (e: React.PointerEvent, title: string, lines: string[]) => {
    const r = wrapRef.current!.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, title, lines });
  };

  // ── Zoom and pan ────────────────────────────────────────────
  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * factor));
      const f = k / v.k;
      return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  };
  const toUnits = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [vbX + (e.clientX - r.left) * unitsPerPx, vbY + (e.clientY - r.top) * unitsPerPx] as const;
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [ux, uy] = toUnits(e);
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, ux, uy);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !(e.buttons & 1)) return;
    const dx = (e.clientX - d.x) * unitsPerPx, dy = (e.clientY - d.y) * unitsPerPx;
    if (Math.abs(dx) + Math.abs(dy) > 3 * unitsPerPx) d.moved = true;
    if (d.moved && view.k > 1) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => { setTimeout(() => { drag.current = null; }, 0); };
  const clickable = () => !drag.current?.moved;

  const cx = vbX + vbW / 2, cy = vbY + vbH / 2;
  const s = unitsPerPx / view.k; // one CSS pixel in map units at this zoom
  const colors = [...new Set(groups.map((g) => lensRgb(g, lens, today, profitTop)))];

  return (
    <div ref={wrapRef} className="globe-map" onPointerLeave={() => setTip(null)}>
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        style={{ cursor: view.k > 1 ? "grab" : "default" }}>
        <defs>
          {colors.map((c) => (
            <radialGradient key={c} id={`gm-glow-${c.replace(/,/g, "-")}`}>
              <stop offset="0%" stopColor={`rgb(${c})`} stopOpacity="0.5" />
              <stop offset="45%" stopColor={`rgb(${c})`} stopOpacity="0.16" />
              <stop offset="100%" stopColor={`rgb(${c})`} stopOpacity="0" />
            </radialGradient>
          ))}
          {colors.map((c) => (
            <radialGradient key={`b${c}`} id={`gm-bead-${c.replace(/,/g, "-")}`} cx="35%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="40%" stopColor={`rgb(${c})`} />
              <stop offset="100%" stopColor={`rgb(${c})`} stopOpacity="0.85" />
            </radialGradient>
          ))}
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {scope === "us"
            ? Object.entries(US_STATE_PATHS).map(([code, d]) => (
                <path key={code} d={d} className={`globe-map-region ${regionFilter === `US-${code}` ? "on" : ""}`}
                  fill={shade.fill(code)}
                  onPointerMove={(e) => regionTip(code, stateName(code), e)}
                  onClick={() => clickable() && onRegion(`US-${code}`)} />
              ))
            : WORLD_PATHS.map(({ f, d }) => (
                <path key={f.properties.name} d={d} className="globe-map-region"
                  fill={shade.fill(f.properties.name)}
                  onPointerMove={(e) => regionTip(f.properties.name, f.properties.name, e)} />
              ))}

          {groups.map((g) => {
            const xy = scope === "us" ? albers([g.lng, g.lat]) : natural([g.lng, g.lat]);
            if (!xy) return null;
            const rgb = lensRgb(g, lens, today, profitTop);
            const id = rgb.replace(/,/g, "-");
            const px = markPx(g.count);
            const core = px * (g.count > 1 ? 30 : 19) / 128;
            const label = countLabel(g.count);
            return (
              <g key={g.key} transform={`translate(${xy[0]} ${xy[1]}) scale(${s})`} className="globe-map-mark"
                onPointerMove={(e) => { e.stopPropagation(); showTip(e, g.count > 1 ? `${g.count} clients` : g.clients[0].name, markLines(g, showMoney)); }}
                onClick={(e) => { e.stopPropagation(); if (clickable()) onSelect(g); }}>
                <circle r={px / 2} fill={`url(#gm-glow-${id})`} />
                <circle r={core + 3.5 * px / 128} fill="rgba(6,8,18,0.88)" />
                {g.approximate
                  ? <circle r={core - 1.5 * px / 128} fill={`rgba(${rgb},0.16)`} stroke={`rgb(${rgb})`} strokeWidth={6 * px / 128} />
                  : <circle r={core} fill={`url(#gm-bead-${id})`} stroke="rgba(255,255,255,0.35)" strokeWidth={0.75} />}
                {label && (
                  <text textAnchor="middle" dominantBaseline="central" y={0.5}
                    fontSize={(label.length > 2 ? 22 : 28) * px / 128} fontWeight={700}
                    fill={g.approximate ? "rgba(242,244,248,0.96)" : "rgba(8,10,20,0.9)"}>{label}</text>
                )}
                {selectedKey === g.key && <circle r={core + 9 * px / 128} fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth={3.5 * px / 128} />}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="globe-map-legend">
        <span>{byProfit ? "Less profit" : "Fewer clients"}</span>
        <span className="globe-map-ramp" />
        <span>More</span>
        {scope === "us" && outside > 0 && (
          <button onClick={() => onScope("world")} className="globe-map-outside">
            {outside} outside the US
          </button>
        )}
      </div>

      <div className="globe-map-zoom">
        <button className="globe-ctrl-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.5, cx, cy)}><Plus size={15} /></button>
        <button className="globe-ctrl-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.5, cx, cy)}><Minus size={15} /></button>
        <button className="globe-ctrl-btn" aria-label="Show the whole map" title="Show the whole map" onClick={() => setView({ k: 1, x: 0, y: 0 })}><Maximize2 size={14} /></button>
      </div>

      {tip && (
        <div className="globe-map-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          {tip.lines.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

function markLines(g: Group, showMoney: boolean): string[] {
  const lines = [g.label];
  if (g.count > 1) lines.push(...g.clients.slice(0, 3).map((c) => c.name), ...(g.count > 3 ? [`and ${g.count - 3} more`] : []));
  if (showMoney) lines.push(`${fmtAmount(g.profit)} profit`);
  return lines;
}
