import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { compact, mono, niceMax } from "./chartMath";
import { easeOutQuart, prefersReducedMotion } from "./motion";

// The Home mockup's chart, reusable. One grey line with a soft area under it (.4 to 0), and optionally a
// dashed line for the period before. Pointing at it lights the line near the cursor and fades the rest
// (the spotlight), drops a dot on the curve, shows a tooltip, and a pill on the x axis whose date rolls
// up or down with the direction you scrub. When `values`, `total` or `prev` change the curves morph into
// the new shape (800ms) instead of snapping. The curve is monotone, so it never waves between points.
// Reduced motion: no morph, no roll, no fade.
//
// Data: `values` has one entry per slot that has happened (a running total per day, say), `total` is how
// many slots the whole range has, so a month that is half over draws half the width. `prev` is the same
// range one period earlier, `total` long. Values are non-negative; the axis starts at 0.

const W = 1000;   // the SVG's x space; it is stretched to the box's width
const N = 120;    // curve samples used for morphing
const MORPH_MS = 800;

export interface MonoAreaChartProps {
  values: number[];
  total?: number;
  prev?: number[];
  /** Short label for slot i: the x axis ticks and the rolling pill ("Nov 4"). */
  label: (i: number) => string;
  /** Longer label for the tooltip's header ("Tue, Nov 4"). Default: label. */
  tipLabel?: (i: number) => string;
  /** How a value is written in the tooltip. Default: grouped digits. */
  format?: (v: number) => string;
  /** How a y tick is written. Default: 950, 1.2k, 3.4M. */
  formatAxis?: (v: number) => string;
  /** Tooltip row names: this series, and the one before. */
  seriesName?: string;
  prevName?: string;
  /** Plot height in px. Default 206. */
  height?: number;
  /** Called with the slot index under the pointer, or null when it leaves. Lets the parent show the
   *  scrubbed figure in its headline, as Home does. */
  onScrub?: (index: number | null) => void;
  ariaLabel?: string;
  className?: string;
}

interface Disp { ys: number[]; pys: number[]; xEnd: number; top: number; hasPrev: boolean; hasLine: boolean }

function build(values: number[], total: number, prev: number[] | undefined, H: number): Disp {
  const n = Math.max(1, total), m = Math.min(values.length, n);
  const top = niceMax(Math.max(0, ...values, ...(prev || [])) * 1.05);
  const xOf = (i: number, len: number) => (len <= 1 ? 0 : (i / (len - 1)) * W);
  const yOf = (v: number) => H - (v / top) * H;
  const xEnd = m ? xOf(m - 1, n) : 0;
  const g = m ? mono(values.slice(0, m).map((_, i) => xOf(i, n)), values.slice(0, m).map(yOf)) : null;
  const hasPrev = !!prev && prev.length > 0;
  const gp = hasPrev ? mono(prev!.map((_, i) => xOf(i, prev!.length)), prev!.map(yOf)) : null;
  return {
    ys: Array.from({ length: N }, (_, i) => (g ? g.at((i / (N - 1)) * xEnd) : H)),
    pys: Array.from({ length: N }, (_, i) => (gp ? gp.at((i / (N - 1)) * W) : H)),
    xEnd, top, hasPrev, hasLine: m > 0,
  };
}

const group = (v: number) => Math.round(v).toLocaleString("en-US");

export default function MonoAreaChart({
  values, total, prev, label, tipLabel, format = group, formatAxis = compact,
  seriesName = "Total", prevName = "Period before", height = 206, onScrub, ariaLabel, className,
}: MonoAreaChartProps) {
  const H = height;
  const n = Math.max(1, total ?? values.length);
  const m = Math.min(values.length, n);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  // ── morph ──
  // Keyed on the numbers, not the array identity: a parent that builds a fresh array on every render
  // (while you scrub, say) must not restart the morph.
  const key = `${n}|${H}|${values.join(",")}|${prev ? prev.join(",") : ""}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => build(values, n, prev, H), [key]);
  const [disp, setDisp] = useState<Disp>(target);
  const dispRef = useRef<Disp>(target);
  const raf = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    cancelAnimationFrame(raf.current);
    const from = dispRef.current;
    if (prefersReducedMotion()) { dispRef.current = target; setDisp(target); return; }
    const t0 = performance.now();
    const mix = (a: number, b: number, e: number) => a + (b - a) * e;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / MORPH_MS), e = easeOutQuart(p);
      const next: Disp = {
        ys: from.ys.map((v, i) => mix(v, target.ys[i], e)),
        pys: from.pys.map((v, i) => mix(v, target.pys[i], e)),
        xEnd: mix(from.xEnd, target.xEnd, e),
        top: target.top, hasPrev: target.hasPrev, hasLine: target.hasLine,
      };
      dispRef.current = next;
      setDisp(next);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);

  const g = useMemo(() => mono(Array.from({ length: N }, (_, i) => (i / (N - 1)) * disp.xEnd), disp.ys), [disp]);
  const gp = useMemo(() => mono(Array.from({ length: N }, (_, i) => (i / (N - 1)) * W), disp.pys), [disp]);

  // ── scrub ──
  const [fx, setFx] = useState<number | null>(null);
  const [idx, setIdx] = useState<number | null>(null);
  const [rollCls, setRollCls] = useState("rUpA");
  const idxRef = useRef<number | null>(null);
  const mv = useRef(0);
  useEffect(() => () => cancelAnimationFrame(mv.current), []);
  useEffect(() => { onScrub?.(idx); }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveTo = (f: number) => {
    const i = Math.round(f * (n - 1));
    if (i !== idxRef.current) {
      const prevI = idxRef.current === null ? i : idxRef.current;
      const dir = i >= prevI ? "Up" : "Dn";
      setRollCls((c) => `r${dir}${c.slice(-1) === "A" ? "B" : "A"}`);
      idxRef.current = i;
      setIdx(i);
    }
    setFx(f);
  };
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const rc = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rc.left) / rc.width));
    cancelAnimationFrame(mv.current);
    mv.current = requestAnimationFrame(() => moveTo(f));
  };
  const unscrub = () => { cancelAnimationFrame(mv.current); idxRef.current = null; setFx(null); setIdx(null); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { unscrub(); return; }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = idxRef.current ?? (e.key === "ArrowRight" ? -1 : n);
    const next = Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
    moveTo(n === 1 ? 0 : next / (n - 1));
  };

  const on = fx !== null && idx !== null;
  const x = on ? fx! * W : 0;
  const inThis = on && x <= disp.xEnd + 0.5;
  const cy = on ? (inThis || !disp.hasPrev ? g.at(Math.min(x, disp.xEnd)) : gp.at(x)) : 0;
  const tipRight = on && fx! > 0.68;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const lineD = disp.hasLine ? g.path : "";
  const areaD = disp.hasLine && disp.xEnd > 0 ? `${g.path} L${disp.xEnd.toFixed(2)} ${H} L0 ${H} Z` : "";
  const endOp = on || !disp.hasLine || disp.xEnd >= W - 1 ? 0 : 1;
  const yl = [4, 3, 2, 1, 0].map((q) => (q === 0 ? "0" : formatAxis((target.top * q) / 4)));

  return (
    <div className={className}>
      <div className="flex gap-2.5">
        <div
          aria-hidden
          className="flex flex-col justify-between text-right text-[12px] leading-[14px] text-muted"
          style={{ height: H + 14, width: 38, marginTop: -7 }}
        >
          {yl.map((t, i) => <span key={i}>{t}</span>)}
        </div>
        <div className="flex-1 min-w-0">
          <div
            className="mc-box outline-none"
            style={{ height: H }}
            tabIndex={0}
            role="img"
            aria-label={ariaLabel || `${seriesName} over ${n} points. Use the left and right arrow keys to move along it.`}
            onPointerMove={scrub}
            onPointerDown={scrub}
            onPointerLeave={unscrub}
            onPointerCancel={unscrub}
            onBlur={unscrub}
            onKeyDown={onKey}
          >
            <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden style={{ display: "block", overflow: "visible" }}>
              <defs>
                <linearGradient id={`${uid}a`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: "var(--chart-line)", stopOpacity: 0.4 }} />
                  <stop offset="100%" style={{ stopColor: "var(--chart-line)", stopOpacity: 0 }} />
                </linearGradient>
                <linearGradient id={`${uid}s`} gradientUnits="userSpaceOnUse" x1={x - 150} y1="0" x2={x + 150} y2="0">
                  <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
                  <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="1" />
                  <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                </linearGradient>
                <mask id={`${uid}m`} maskUnits="userSpaceOnUse" x="-10" y="-20" width={W + 20} height={H + 40}>
                  <rect x="-10" y="-20" width={W + 20} height={H + 40} fill={`url(#${uid}s)`} />
                </mask>
              </defs>
              {[0, 1, 2, 3].map((k) => (
                <line key={k} x1="0" x2={W} y1={k === 0 ? 0.5 : (k * H) / 4} y2={k === 0 ? 0.5 : (k * H) / 4} stroke="var(--chart-grid)" vectorEffect="non-scaling-stroke" />
              ))}
              {disp.hasPrev && (
                <path d={gp.path} fill="none" stroke="rgb(var(--c-faint))" strokeWidth="1.5" strokeDasharray="4 5" opacity="0.55" vectorEffect="non-scaling-stroke" />
              )}
              {areaD && <path className="mc-base" d={areaD} fill={`url(#${uid}a)`} style={{ opacity: on ? 0.45 : 1 }} />}
              {lineD && <path className="mc-base" d={lineD} fill="none" stroke="var(--chart-line)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ opacity: on ? 0.28 : 1 }} />}
              {lineD && <path className="mc-base" d={lineD} fill="none" stroke="var(--chart-hi)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" mask={`url(#${uid}m)`} style={{ opacity: on ? 1 : 0 }} />}
            </svg>
            {/* where the line ends today */}
            <span className="mc-dot" style={{ left: `${(disp.xEnd / W) * 100}%`, top: disp.hasLine ? g.at(disp.xEnd) : 0, opacity: endOp }} />
            <span className="mc-cursor" style={{ left: `${(fx || 0) * 100}%`, opacity: on ? 1 : 0 }} />
            <span className="mc-dot" style={{ left: `${(fx || 0) * 100}%`, top: cy, opacity: on ? 1 : 0 }} />
            <div
              className="mc-tip"
              style={{
                left: tipRight ? `calc(${fx! * 100}% - 196px)` : `calc(${(fx || 0) * 100}% + 16px)`,
                top: Math.max(0, Math.min(H - 84, cy - 40)),
                opacity: on ? 1 : 0,
              }}
            >
              <div className="mc-rollbox font-medium text-ink"><span className={`mc-roll ${rollCls}`}>{on ? (tipLabel || label)(idx!) : ""}</span></div>
              <div className="flex justify-between gap-4 mt-1.5 text-muted">
                <span>{seriesName}</span>
                <span className="font-medium text-ink tabular-nums">{on && idx! < m ? format(values[idx!]) : "Not yet"}</span>
              </div>
              {disp.hasPrev && (
                <div className="flex justify-between gap-4 mt-1 text-muted">
                  <span>{prevName}</span>
                  <span className="tabular-nums">{on && prev && idx! < prev.length ? format(prev[idx!]) : ""}</span>
                </div>
              )}
            </div>
          </div>
          <div className="relative mt-2" style={{ height: 26 }}>
            {ticks.map((f, j) => {
              const i = Math.round(f * (n - 1));
              return (
                <span
                  key={j}
                  className="absolute whitespace-nowrap text-[12px] text-muted"
                  style={{ left: `${f * 100}%`, transform: `translateX(${j === 0 ? "0" : j === 4 ? "-100%" : "-50%"})`, opacity: on && Math.abs(f - fx!) < 0.09 ? 0 : 1, transition: "opacity .2s" }}
                >
                  {label(i)}
                </span>
              );
            })}
            <span className="mc-pill" style={{ left: `${(fx || 0) * 100}%`, opacity: on ? 1 : 0 }}>
              <span className={`mc-roll ${rollCls}`}>{on ? label(idx!) : ""}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
