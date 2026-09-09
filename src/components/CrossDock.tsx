/**
 * Cross-dock — a private slot machine.
 *
 * Play money only. It never reads or writes a client, an invoice or a bank row: credits
 * and the four progressive meters live in this device's localStorage under the signed-in
 * account's id, so nothing here can reach a money screen, the oplog or the server.
 *
 * The mathematics lives in lib/crossdock.ts and is verified by lib/crossdock.test.ts. The result
 * of a spin is fully decided the moment Spin is pressed; everything below is only how it
 * is delivered, which is what makes the skip affordance safe.
 *
 * The reels are real cylinders, not scrolling strips: each column is a CSS `perspective`
 * box and every symbol sits on the surface of a drum at `rotateX(θ) translateZ(R)`, so
 * symbols foreshorten and fall away over the shoulder exactly as a physical reel does.
 * One requestAnimationFrame loop drives all five, and it exists only between a Spin press
 * and the last reel landing — nothing on this panel moves at rest.
 *
 * Colour: the ten symbols carry their own palette (--s-* stroke, --f-* fill), declared
 * once for light and once for dark so every one of them stays legible on both grounds.
 * Everything else — chrome, type, borders, the accent — stays on the app's own tokens,
 * so the mono themes still behave. No emoji, no glow, no gradients: wins are marked with
 * a solid inset ring, and the symbols are hand-drawn SVG.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Info } from "lucide-react";
import StatusPill from "./StatusPill";
import { laneY, laneV, stopAt } from "../lib/crossdock-motion";
import {
  REELS, PAYLINES, SYMBOLS, SYMBOL_BY_ID, JACKPOTS, LINE_BETS, LINE_COUNT,
  evaluate, meterGain, rollJackpot,
  type Grid, type LineWin, type SymbolId,
} from "../lib/crossdock";

/* ── geometry ─────────────────────────────────────────────────────────────────
   The drum: one cell of travel turns it by ARC degrees, so its radius follows from
   the pitch. PERSP is the viewer distance that gives the curvature its depth.   */

const ARC = 20;                       // degrees of drum per symbol
const PERSP = 900;                    // px
const VISIBLE = 4;                    // cells either side of the front that are drawn

interface Geo { cell: number; gutter: number; gap: number; art: number; badge: number; spin: number }
const FULL: Geo = { cell: 100, gutter: 6, gap: 4, art: 56, badge: 84, spin: 60 };
const COMPACT: Geo = { cell: 80, gutter: 6, gap: 4, art: 46, badge: 68, spin: 52 };

const rad = (deg: number) => (deg * Math.PI) / 180;
const pitch = (g: Geo) => g.cell + g.gap;
const radius = (g: Geo) => pitch(g) / rad(ARC);
const frameW = (g: Geo) => REELS.length * g.cell + (REELS.length - 1) * g.gutter;
const windowH = (g: Geo) => Math.round(g.cell * 3.2);

/** Where a landed row's centre actually projects to, curvature and perspective included.
 *  The payline overlay is drawn from these, so a line lands on the symbols, not near them. */
function projectedY(g: Geo, row: number) {
  const R = radius(g), t = rad((row - 1) * ARC);
  const z = R * Math.cos(t) - R;
  return windowH(g) / 2 + R * Math.sin(t) * (PERSP / (PERSP - z));
}
const cx = (g: Geo, reel: number) => reel * (g.cell + g.gutter) + g.cell / 2;

/** Tiles ahead of the result in each lane. Every one is real content from that reel's own
 *  strip in its own order, so no filler is ever spliced out mid-spin. LEAD has to cover
 *  the longest travel (reel 5, ~35 symbols) with room to spare, or the drum would run off
 *  the end of its own lane. */
const LEAD = 44;
const LANE = LEAD + 4;

const OPENING_FLOAT = 10_000;

/* ── persistence ──────────────────────────────────────────────────────────── */

interface Saved {
  credits: number;
  lineBet: number;
  meters: Record<string, number>;
  stats: { spins: number; wagered: number; won: number; best: number; jackpots: number; floats: number };
}
const seeded = () => Object.fromEntries(JACKPOTS.map((t) => [t.id, t.seed]));
const fresh = (): Saved => ({
  credits: OPENING_FLOAT, lineBet: 1, meters: seeded(),
  stats: { spins: 0, wagered: 0, won: 0, best: 0, jackpots: 0, floats: 1 },
});
const KEY = (id: string) => `clienthub_crossdock_v1_${id}`;

function load(id: string): Saved {
  try {
    const raw = localStorage.getItem(KEY(id));
    if (!raw) return fresh();
    const s = JSON.parse(raw) as Partial<Saved>;
    return { ...fresh(), ...s, meters: { ...seeded(), ...(s.meters || {}) }, stats: { ...fresh().stats, ...(s.stats || {}) } };
  } catch { return fresh(); }
}
const store = (id: string, s: Saved) => {
  try { localStorage.setItem(KEY(id), JSON.stringify(s)); } catch { /* private window */ }
};

/* ── symbols ──────────────────────────────────────────────────────────────────
   Each symbol owns a stroke colour and a fill tint, both re-declared for dark, so a
   symbol is never a dark line on a dark ground. Pay rank still reads from stroke
   WEIGHT as well as hue, so the ladder survives a colour-blind reading.          */

const s = (id: SymbolId) => `var(--s-${id})`;
const f = (id: SymbolId) => `var(--f-${id})`;
const ACC = "rgb(var(--c-accent))";
const ON_ACC = "rgb(var(--c-on-accent))";

function Art({ id, size }: { id: SymbolId; size: number }) {
  const base = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  let body: JSX.Element;
  switch (id) {
    case "bjm": // the house mark, and the top payer — five of these is the grand prize
      body = (<>
        <rect x="7" y="17" width="50" height="30" rx="4" {...base} fill={f("bjm")} stroke={s("bjm")} strokeWidth={2.5} />
        <text x="32" y="32" dy=".36em" textAnchor="middle" fill={s("bjm")}
          style={{ font: "900 19px/1 Satoshi, system-ui, sans-serif", letterSpacing: "-0.5px" }}>BJM</text>
        <path d="M13 51 L51 51" {...base} stroke={s("bjm")} strokeWidth={2} opacity={0.45} />
      </>); break;
    case "compass":
      body = (<>
        <circle cx="32" cy="32" r="21" {...base} fill={f("compass")} stroke={s("compass")} strokeWidth={2.25} />
        <path d="M32 13 L37.3 26.7 L51 32 L37.3 37.3 L32 51 L26.7 37.3 L13 32 L26.7 26.7 Z" {...base} stroke={s("compass")} strokeWidth={2.25} />
        <path d="M32 13 L37.3 26.7 L26.7 26.7 Z" fill={s("compass")} />
        <circle cx="32" cy="32" r="2.5" fill={s("compass")} />
      </>); break;
    case "crate":
      body = (<>
        <rect x="13" y="17" width="38" height="32" rx="3" {...base} fill={f("crate")} stroke={s("crate")} strokeWidth={2.25} />
        <path d="M13 17 L51 49 M51 17 L13 49" {...base} stroke={s("crate")} strokeWidth={1.5} opacity={0.55} />
        <rect x="13" y="29" width="38" height="8" fill={s("crate")} opacity={0.14} />
        <path d="M13 29 L51 29 M13 37 L51 37" {...base} stroke={s("crate")} strokeWidth={1.5} />
        <rect x="28" y="29" width="8" height="8" rx="1.5" fill={s("crate")} />
      </>); break;
    case "pallet":
      body = (<>
        {[18, 29, 40].map((y) => <rect key={y} x="11" y={y} width="42" height="7" rx="1.5" {...base} fill={f("pallet")} stroke={s("pallet")} strokeWidth={2} />)}
        {[14, 28, 42].map((x) => <rect key={x} x={x} y="47" width="8" height="5" rx="1" {...base} fill={f("pallet")} stroke={s("pallet")} strokeWidth={2} />)}
        <path d="M25 18 L25 25 M39 18 L39 25" {...base} stroke={s("pallet")} strokeWidth={1} opacity={0.5} />
      </>); break;
    case "drum":
      body = (<>
        <path d="M17 18 L17 46 A15 5.5 0 0 0 47 46 L47 18 Z" fill={f("drum")} />
        <ellipse cx="32" cy="18" rx="15" ry="5.5" {...base} fill={f("drum")} stroke={s("drum")} strokeWidth={2} />
        <path d="M17 18 L17 46 M47 18 L47 46 M17 46 A15 5.5 0 0 0 47 46" {...base} stroke={s("drum")} strokeWidth={2} />
        <path d="M17 28 A15 5.5 0 0 0 47 28 M17 38 A15 5.5 0 0 0 47 38" {...base} stroke={s("drum")} strokeWidth={1.5} opacity={0.55} />
      </>); break;
    case "cog": // teeth first, disc painted over their roots — no fill-rule needed
      body = (<>
        {Array.from({ length: 8 }, (_, k) => (
          <rect key={k} x="29" y="8" width="6" height="8" rx="1.5" transform={`rotate(${k * 45} 32 32)`}
            fill={f("cog")} stroke={s("cog")} strokeWidth={1.75} strokeLinejoin="round" />
        ))}
        <circle cx="32" cy="32" r="18" fill={f("cog")} stroke={s("cog")} strokeWidth={1.75} />
        <circle cx="32" cy="32" r="7.5" {...base} stroke={s("cog")} strokeWidth={1.75} />
      </>); break;
    case "tag": // lowest payer, plainest
      body = (<>
        <path d="M24 18 L52 18 L52 46 L24 46 L12 32 Z" {...base} fill={f("tag")} stroke={s("tag")} strokeWidth={1.75} />
        <circle cx="21" cy="32" r="3" {...base} stroke={s("tag")} strokeWidth={1.75} />
        <path d="M21 32 Q10 26 8 16" {...base} stroke={s("tag")} strokeWidth={1.5} opacity={0.6} />
        <path d="M30 27 L46 27 M30 36 L41 36" {...base} stroke={s("tag")} strokeWidth={1.5} opacity={0.55} />
      </>); break;
    case "wild": // on the one solid-accent badge, so it inverts with the theme by construction
      body = (<>
        <rect x="16" y="14" width="32" height="38" rx="3" {...base} stroke={ON_ACC} strokeWidth={2.5} />
        <rect x="26" y="9" width="12" height="8" rx="2" fill={ON_ACC} stroke={ON_ACC} strokeWidth={2.5} strokeLinejoin="round" />
        <path d="M22 27 L42 27 M22 34 L38 34" {...base} stroke={ON_ACC} strokeWidth={2} opacity={0.7} />
        <path d="M22 42 L27 47 L38 37" {...base} stroke={ON_ACC} strokeWidth={2.5} />
      </>); break;
    case "beacon": // marked by badge SHAPE as well as colour, so it survives a mono theme
      body = (<>
        <path d="M24 50 L27 24 L37 24 L40 50 Z" {...base} fill={f("beacon")} stroke={s("beacon")} strokeWidth={2.25} />
        <path d="M25.6 36 L38.4 36 M24.8 43 L39.2 43" {...base} stroke={s("beacon")} strokeWidth={1.5} opacity={0.5} />
        <rect x="25" y="16" width="14" height="8" rx="1.5" {...base} fill={s("beacon")} opacity={0.3} />
        <rect x="25" y="16" width="14" height="8" rx="1.5" {...base} stroke={s("beacon")} strokeWidth={2.25} />
        <path d="M23 16 L32 10 L41 16" {...base} stroke={s("beacon")} strokeWidth={2.25} />
        <path d="M21 12 L13 8 M43 12 L51 8" {...base} stroke={s("beacon")} strokeWidth={2} />
        <path d="M20 19 L11 19 M44 19 L53 19" {...base} stroke={s("beacon")} strokeWidth={1.75} opacity={0.55} />
        <rect x="21" y="50" width="22" height="4" rx="1" fill={s("beacon")} stroke={s("beacon")} strokeWidth={2} strokeLinejoin="round" opacity={0.85} />
      </>); break;
    default: // slat — the blank, 27-37% of every strip. Calm negative space, no badge.
      body = (<>
        <rect x="10" y="25" width="44" height="14" rx="2" {...base} stroke={s("slat")} strokeWidth={1.5} />
        <path d="M16 30 L46 30 M18 34.5 L42 34.5" {...base} stroke={s("slat")} strokeWidth={1} opacity={0.7} />
      </>); break;
  }
  return <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>{body}</svg>;
}

function Badge({ id, geo, lit }: { id: SymbolId; geo: Geo; lit?: boolean }) {
  if (id === "slat") return <Art id={id} size={geo.art} />;
  const round = id === "beacon";
  return (
    <div
      className={`flex items-center justify-center border transition-colors ${
        id === "wild" ? "bg-accent border-transparent" : lit ? "bg-accent/10 border-accent" : "bg-surface border-line-2"
      } ${lit ? "cd-pop" : ""}`}
      style={{
        width: geo.badge, height: geo.badge,
        borderRadius: round ? 999 : geo.badge / 5.25,
        borderWidth: round ? 1.5 : 1,
        borderColor: round && !lit ? s("beacon") : undefined,
        boxShadow: lit ? "inset 0 0 0 2px rgb(var(--c-accent)/0.6)" : undefined,
      }}
    >
      <Art id={id} size={geo.art} />
    </div>
  );
}

/* ── paytable ─────────────────────────────────────────────────────────────── */

function LineGlyph({ line }: { line: number[] }) {
  const on = new Set(line.map((row, r) => `${r}:${row}`));
  return (
    <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden>
      <polyline points={line.map((row, r) => `${r * 6 + 2},${row * 6 + 2}`).join(" ")}
        fill="none" stroke={ACC} strokeWidth={1} opacity={0.6} />
      {[0, 1, 2].map((row) => [0, 1, 2, 3, 4].map((r) => (
        <rect key={`${r}:${row}`} x={r * 6} y={row * 6} width="4" height="4" rx="1"
          fill={on.has(`${r}:${row}`) ? ACC : "rgb(var(--c-line-2))"} />
      )))}
    </svg>
  );
}

function Paytable({ lineBet, onClose }: { lineBet: number; onClose: () => void }) {
  const paying = SYMBOLS.filter((sym) => sym.kind === "normal" && sym.pays[2] > 0);
  const c = (n: number) => (n * lineBet).toLocaleString();
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="pt-4 mt-4 border-t border-line">
      <h4 className="text-[13px] font-semibold text-ink mb-2">{title}</h4>
      <div className="text-[12px] text-muted leading-relaxed space-y-1.5">{children}</div>
    </div>
  );
  return (
    <div className="cd fixed inset-0 z-[96] flex justify-end bg-black/30" onClick={onClose}>
      <div className="bg-surface border-l border-line w-full max-w-sm h-full overflow-y-auto animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-surface border-b border-line px-5 py-3.5 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold text-ink">Paytable</h3>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">
          <p className="text-[12px] text-muted mb-3">
            Left to right from reel 1, on {LINE_COUNT} fixed lines. Shown at a line bet of{" "}
            {lineBet} {lineBet === 1 ? "credit" : "credits"}.
          </p>
          <table className="w-full text-[12px] tabular-nums">
            <thead><tr className="text-[11px] text-muted">
              <th className="text-left font-medium pb-1.5">Symbol</th>
              {[3, 4, 5].map((n) => <th key={n} className="text-right font-medium pb-1.5 w-16">{n}</th>)}
            </tr></thead>
            <tbody>
              {paying.map((sym) => (
                <tr key={sym.id} className="border-t border-line">
                  <td className="py-1.5">
                    <span className="flex items-center gap-2">
                      <span className="shrink-0"><Art id={sym.id} size={36} /></span>
                      <span className="text-ink-2">{sym.name}</span>
                    </span>
                  </td>
                  {sym.pays.map((v, i) => <td key={i} className="text-right text-ink">{c(v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>

          <Section title="The manifest">
            {/* The wild is drawn in --c-on-accent, so it is legible only on its own accent
                badge — never render it bare. */}
            <div className="flex items-start gap-2.5">
              <span className="shrink-0 w-9 h-9 rounded-lg bg-accent flex items-center justify-center"><Art id="wild" size={32} /></span>
              <p>Stands in for all seven paying symbols. Reels 2 to 5 only, no pay of its own, and it never stands in for a beacon or a slat.</p>
            </div>
          </Section>

          <Section title="Harbour beacon">
            <div className="flex items-start gap-2.5"><span className="shrink-0"><Art id="beacon" size={36} /></span>
              <p>Counted anywhere in the 15 cells, not on a line. Pays {c(40)}, {c(200)} or {c(1000)} for 3, 4 or 5.</p></div>
          </Section>

          <Section title="Free spins">
            <p>Three, four or five beacons award 6, 10 or 16 free spins. Every win during them is doubled, including beacon pays. They cost nothing, and they do not retrigger.</p>
          </Section>

          <Section title="Jackpots">
            <p>
              Mini, Minor, Major and Grand are funded by 1.2% of every bet and can land on any paid
              spin, independent of the reels and on top of whatever they pay. They reset to{" "}
              {JACKPOTS.map((t) => t.seed.toLocaleString()).reverse().join(", ")} credits. Longer odds at
              a bigger stake are matched by a faster-climbing meter, so no bet size is better value.
            </p>
          </Section>

          <Section title="Timber slat">
            <div className="flex items-start gap-2.5"><span className="shrink-0"><Art id="slat" size={36} /></span>
              <p>Never pays and never substitutes. It is the spacer that keeps the reel honest.</p></div>
          </Section>

          <Section title={`The ${LINE_COUNT} lines`}>
            <div className="grid grid-cols-4 gap-2.5 pt-1">
              {PAYLINES.map((l, i) => <LineGlyph key={i} line={l} />)}
            </div>
          </Section>

          <p className="text-[11px] text-faint mt-5 leading-relaxed">
            Return to player 95.82% — 92.27% from the reels, 2.35% from free spins, 1.20% from the
            progressives. Something pays on 25.95% of spins. Five BJM on a line, the grand prize,
            lands about once in 105,600.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── numbers ──────────────────────────────────────────────────────────────── */

/** Ease-out cubic, or a stepped odometer of `segments` eased legs with a pause between.
 *  The odometer fires in exactly one place in the game: the grand prize. */
function ease(p: number, segments: number) {
  if (segments <= 1) return 1 - Math.pow(1 - p, 3);
  const k = Math.min(segments - 1, Math.floor(p * segments));
  const local = Math.min(1, (p * segments - k) * 1.3);
  return (k + (1 - Math.pow(1 - local, 3))) / segments;
}

function useCountUp(target: number, duration: number, segments = 1) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = from.current;
    if (start === target) return;
    if (duration <= 0) { from.current = target; setShown(target); return; }
    let r = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setShown(Math.round(start + (target - start) * ease(p, segments)));
      if (p < 1) r = requestAnimationFrame(step); else from.current = target;
    };
    r = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(r); from.current = target; setShown(target); };
  }, [target, duration, segments]);
  return shown;
}

/* ── the machine ──────────────────────────────────────────────────────────── */

type Phase = "idle" | "spinning" | "revealing";
interface Msg { primary: string; secondary?: string; accent?: boolean }

export default function ReelsGame({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [saved, setSaved] = useState<Saved>(() => load(accountId));
  const [geo, setGeo] = useState<Geo>(() =>
    typeof window !== "undefined" && (window.innerWidth < 720 || window.innerHeight < 780) ? COMPACT : FULL);
  const reduced = useMemo(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  // Opens on a real random window rather than the top of each strip, so the machine
  // never greets you with five blanks.
  const [lanes, setLanes] = useState<SymbolId[][]>(() =>
    REELS.map((strip) => {
      const st = Math.floor(Math.random() * strip.length);
      return Array.from({ length: LANE }, (_, k) => strip[(st - LEAD + k + 2 * strip.length) % strip.length]);
    }));
  const [phase, setPhase] = useState<Phase>("idle");
  const [landed, setLanded] = useState(REELS.length);
  const [lines, setLines] = useState<LineWin[]>([]);
  const [drawn, setDrawn] = useState<number[]>([]);
  const [lit, setLit] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<Msg | null>(null);
  const [paytable, setPaytable] = useState(false);
  const [modal, setModal] = useState<{ tier: string; amount: number } | null>(null);
  const [flashTier, setFlashTier] = useState<string | null>(null);
  const [free, setFree] = useState({ left: 0, total: 0, won: 0 });

  const [countMs, setCountMs] = useState(0);
  const [countSegs, setCountSegs] = useState(1);
  const credits = useCountUp(saved.credits, reduced ? 0 : countMs, countSegs);

  const cellRefs = useRef<(HTMLDivElement | null)[][]>(REELS.map(() => []));
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const raf = useRef(0);
  const timers = useRef<number[]>([]);
  const spinStart = useRef(0);
  /** Elapsed ms at which Spin was pressed a second time, not a wall clock. */
  const skipAt = useRef<number | null>(null);
  const afterModal = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);

  const totalBet = saved.lineBet * LINE_COUNT;
  const H = windowH(geo), W = frameW(geo), R = radius(geo), P = pitch(geo);
  // Landed offset: the middle row (lane index LEAD + 1) sits at the front of the drum.
  const restY = H / 2 - ((LEAD + 1) * P + geo.cell / 2);
  const inFree = free.left > 0 || free.total > 0;
  const busy = phase !== "idle" || inFree || !!modal;
  busyRef.current = busy;

  const at = useCallback((ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); }, []);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  /** Place reel `i`'s cells on the drum for a given flat offset. Only the handful near
   *  the front is drawn; the rest is taken out of the layout entirely. */
  const paint = useCallback((i: number, y: number, blur: boolean) => {
    const cells = cellRefs.current[i];
    const front = Math.round((H / 2 - geo.cell / 2 - y) / P);
    for (let k = 0; k < cells.length; k++) {
      const el = cells[k];
      if (!el) continue;
      if (Math.abs(k - front) > VISIBLE) { if (el.style.display !== "none") el.style.display = "none"; continue; }
      const t = (k * P + geo.cell / 2 + y - H / 2) / R;             // radians around the drum
      if (el.style.display === "none") el.style.display = "";
      el.style.transform = `rotateX(${(-t * 180) / Math.PI}deg) translateZ(${R}px)`;
      el.style.filter = blur ? "blur(0.7px)" : "";
      // The far side of a real drum is dark; the near face is fully lit.
      el.style.opacity = String(Math.max(0, Math.cos(t) ** 0.8));
    }
  }, [H, P, R, geo.cell]);

  useEffect(() => () => { clearTimers(); cancelAnimationFrame(raf.current); }, []);
  useEffect(() => { store(accountId, saved); }, [accountId, saved]);

  useEffect(() => {
    const onResize = () => setGeo(window.innerWidth < 720 || window.innerHeight < 780 ? COMPACT : FULL);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Cells sit at their landed angles whenever the loop is not running — the first paint,
  // after a resize changes the pitch, and after every spin resolves.
  useEffect(() => {
    if (phase === "spinning") return;
    REELS.forEach((_, i) => paint(i, restY, false));
  }, [phase, restY, lanes, paint]);

  const reveal = useCallback((out: ReturnType<typeof evaluate>, bet: number, isFree: boolean) => {
    setPhase("revealing");
    const ranked = [...out.lineWins].sort((a, b) => b.pay - a.pay);
    const first = ranked.slice(0, 5), rest = ranked.slice(5);
    const marks = new Set<string>();
    const mark = (cells: [number, number][]) => {
      cells.forEach(([r, row]) => marks.add(`${r}:${row}`));
      setLit(new Set(marks));
    };

    first.forEach((w, i) => at(200 * i, () => { setDrawn((d) => [...d, w.line]); mark(w.cells); }));
    if (rest.length) at(200 * first.length, () => {
      setDrawn((d) => [...d, ...rest.map((w) => w.line)]);
      rest.forEach((w) => mark(w.cells));
    });
    if (out.scatterPay > 0) at(200 * ranked.length + 320, () => mark(out.beacons));

    const beats = 200 * (first.length + (rest.length ? 1 : 0)) + 260;
    at(beats, () => {
      const grand = ranked.some((w) => w.symbol === "bjm" && w.count === 5);
      if (out.win > 0) {
        const top = ranked[0];
        setMsg(
          grand
            ? { primary: "Grand prize — five BJM", secondary: `${out.win.toLocaleString()} credits`, accent: true }
            : out.win >= bet * 20
              ? { primary: "Big win", secondary: `${out.win.toLocaleString()} credits`, accent: true }
              : ranked.length > 5
                ? { primary: `${ranked.length} lines — ${out.win.toLocaleString()} credits` }
                : top
                  ? { primary: `${top.count} x ${SYMBOL_BY_ID[top.symbol].name} — ${out.win.toLocaleString()} credits` }
                  : { primary: `${out.beacons.length} harbour beacons — ${out.win.toLocaleString()} credits` },
        );
      }
      setCountSegs(grand ? 3 : 1);
      setCountMs(grand ? 2000 : out.win >= bet * 20 ? 1400 : Math.min(900, 320 + out.win * 1.5));
      setSaved((sv) => ({
        ...sv, credits: sv.credits + out.win,
        stats: { ...sv.stats, won: sv.stats.won + out.win, best: Math.max(sv.stats.best, out.win) },
      }));
      if (isFree) setFree((fr) => ({ ...fr, won: fr.won + out.win }));

      if (out.freeSpinsAwarded > 0) at(320, () => {
        setMsg({ primary: "Free spins", secondary: `${out.freeSpinsAwarded} spins, every win doubled` });
        setFree((fr) => ({ left: fr.left + out.freeSpinsAwarded, total: fr.total + out.freeSpinsAwarded, won: fr.won }));
      });
      setPhase("idle");
    });
  }, [at]);

  const doSpin = useCallback((isFree: boolean) => {
    if (phase !== "idle" || modal) return;
    if (!isFree && saved.credits < totalBet) return;

    clearTimers();
    cancelAnimationFrame(raf.current);
    skipAt.current = null;
    setLines([]); setDrawn([]); setLit(new Set()); setMsg(null); setCountMs(0); setCountSegs(1);
    setPhase("spinning");
    setLanded(0);

    const bet = totalBet;
    // The whole result — window, lines, scatter, jackpot — is decided right here.
    const stops = REELS.map((strip) => Math.floor(Math.random() * strip.length));
    const grid: Grid = REELS.map((strip, r) => [0, 1, 2].map((k) => strip[(stops[r] + k) % strip.length]));
    const out = evaluate(grid, saved.lineBet, isFree);
    const jackpot = isFree ? null : rollJackpot(Math.random, bet);
    const jackpotAmount = jackpot ? Math.round(saved.meters[jackpot.id] ?? jackpot.seed) : 0;

    setLanes(REELS.map((strip, r) => Array.from({ length: LANE }, (_, k) =>
      strip[(stops[r] - LEAD + k + 2 * strip.length) % strip.length])));
    setLines(out.lineWins);

    setSaved((sv) => {
      const meters = { ...sv.meters };
      if (!isFree) JACKPOTS.forEach((t) => { meters[t.id] = (meters[t.id] ?? t.seed) + meterGain(t, bet); });
      if (jackpot) meters[jackpot.id] = jackpot.seed;
      return {
        ...sv,
        credits: sv.credits - (isFree ? 0 : bet) + jackpotAmount,
        meters,
        stats: {
          ...sv.stats,
          spins: sv.stats.spins + (isFree ? 0 : 1),
          wagered: sv.stats.wagered + (isFree ? 0 : bet),
          won: sv.stats.won + jackpotAmount,
          best: Math.max(sv.stats.best, jackpotAmount),
          jackpots: sv.stats.jackpots + (jackpot ? 1 : 0),
        },
      };
    });
    if (isFree) setFree((fr) => ({ ...fr, left: fr.left - 1 }));

    const finish = () => {
      if (jackpot) {
        setFlashTier(jackpot.id);
        at(1200, () => setFlashTier(null));
        if (jackpot.id === "major" || jackpot.id === "grand") {
          afterModal.current = () => reveal(out, bet, isFree);
          setModal({ tier: jackpot.name, amount: jackpotAmount });
          return; // Collect resumes the reveal
        }
        setMsg({ primary: `${jackpot.name} jackpot — ${jackpotAmount.toLocaleString()} credits`, accent: true });
      }
      reveal(out, bet, isFree);
    };

    if (reduced) { setLanded(REELS.length); at(60, finish); return; }

    const t0 = performance.now();
    spinStart.current = t0;
    const held: (number | null)[] = REELS.map(() => null);
    let seen = 0;
    let resolved = false;

    /** Put every reel on its mark and resolve the spin, once. */
    const land = (pause: number) => {
      if (resolved) return;
      resolved = true;
      cancelAnimationFrame(raf.current);
      REELS.forEach((_, i) => paint(i, restY, false));
      setLanded(REELS.length);
      at(pause, finish);
    };

    // requestAnimationFrame stops entirely while the window is hidden, so a spin that is
    // minimised mid-flight would otherwise sit unresolved with the stake already taken.
    // setTimeout still fires when hidden, so it is what guarantees the spin completes.
    at(stopAt(REELS.length - 1) + 1500, () => land(0));

    const frame = (now: number) => {
      if (resolved) return;
      const t = now - t0;
      let done = 0;
      REELS.forEach((_, i) => {
        const skipT = skipAt.current;
        let y: number, v: number;
        if (skipT !== null && t > skipT) {
          // Every unlanded reel eases to rest over 260ms from wherever it stood.
          if (held[i] === null) held[i] = laneY(i, Math.min(skipT, stopAt(i)), restY);
          const p = Math.min(1, (t - skipT) / 260);
          y = held[i]! + (restY - held[i]!) * (1 - Math.pow(1 - p, 3));
          v = p < 1 ? 1.4 : 0;
          if (p >= 1) done++;
        } else {
          y = laneY(i, t, restY);
          v = laneV(i, t);
          if (t >= stopAt(i)) done++;
        }
        paint(i, y, v > 1.2);
      });
      if (done > seen) {
        for (let i = seen; i < done; i++) {
          const col = colRefs.current[i];
          if (col) { col.classList.add("cd-thud"); window.setTimeout(() => col.classList.remove("cd-thud"), 200); }
        }
        seen = done;
        setLanded(done);
      }
      if (done < REELS.length) raf.current = requestAnimationFrame(frame);
      else land(110);
    };
    raf.current = requestAnimationFrame(frame);
  }, [phase, modal, saved.credits, saved.lineBet, saved.meters, totalBet, restY, reduced, at, reveal, paint]);

  /** Spin, or — pressed again mid-spin — bring every unlanded reel to rest early. The
   *  outcome was decided at the first press, so skipping cannot change it. */
  const press = useCallback(() => {
    if (modal || inFree) return;
    if (phase === "spinning") {
      if (skipAt.current === null) skipAt.current = performance.now() - spinStart.current;
      return;
    }
    if (phase === "idle") doSpin(false);
  }, [modal, inFree, phase, doSpin]);

  // Free spins play themselves out. They are a thing you watch, not a modal to dismiss.
  useEffect(() => {
    if (phase !== "idle" || modal) return;
    if (free.left > 0) {
      const t = window.setTimeout(() => doSpin(true), reduced ? 220 : free.left === free.total ? 900 : 700);
      return () => clearTimeout(t);
    }
    if (free.total > 0) {
      setMsg({ primary: "Free spins complete", secondary: `${free.won.toLocaleString()} credits` });
      const t = window.setTimeout(() => setFree({ left: 0, total: 0, won: 0 }), 2000);
      return () => clearTimeout(t);
    }
  }, [phase, modal, free, reduced, doSpin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (paytable) setPaytable(false); else if (!busyRef.current) onClose(); return; }
      if (e.code === "Space" && !paytable && !modal) { e.preventDefault(); press(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paytable, modal, press, onClose]);

  const collect = () => {
    setModal(null);
    const resume = afterModal.current;
    afterModal.current = null;
    if (resume) resume(); else setPhase("idle");
  };

  const broke = saved.credits < totalBet && !inFree;
  const betIndex = LINE_BETS.indexOf(saved.lineBet as typeof LINE_BETS[number]);
  const stepBet = (d: number) => {
    const i = Math.max(0, Math.min(LINE_BETS.length - 1, betIndex + d));
    setSaved((sv) => ({ ...sv, lineBet: LINE_BETS[i] }));
  };

  return (
    <div className="cd fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-6 overflow-auto"
      onClick={() => { if (!busy) onClose(); }}>
      {/* Scoped to this component so it never touches global CSS — the house idiom
          (InventoryView, DealFlowView). The symbol palette is declared twice, once per
          ground, because a symbol that is only legible in light is half a symbol.
          Literal black and white appear ONLY in these box-shadows — dark is blue-cast,
          mono-dark is neutral, so one rule cannot cover both — and never as a fill,
          stroke, border or text colour. */}
      <style>{`
        .cd{
          --s-bjm:#D64B0B;--f-bjm:#FFEADC;
          --s-compass:#1D4ED8;--f-compass:#E4EBFE;
          --s-crate:#A55207;--f-crate:#FCEFD9;
          --s-pallet:#15803D;--f-pallet:#E1F7E7;
          --s-drum:#475569;--f-drum:#E9EDF2;
          --s-cog:#0F766E;--f-cog:#DDF3F0;
          --s-tag:#7C3AED;--f-tag:#EFE7FE;
          --s-beacon:#C81E1E;--f-beacon:#FDE6E6;
          --s-slat:rgb(var(--c-line-3));
        }
        html.dark .cd{
          --s-bjm:#FF9A5C;--f-bjm:#40200E;
          --s-compass:#7FA8FF;--f-compass:#152343;
          --s-crate:#E2A94F;--f-crate:#3A2B0E;
          --s-pallet:#5FD48A;--f-pallet:#0F2D1C;
          --s-drum:#A9B7C6;--f-drum:#222A34;
          --s-cog:#4FD1C5;--f-cog:#0E2C29;
          --s-tag:#B899FA;--f-tag:#291A47;
          --s-beacon:#FF8080;--f-beacon:#421616;
          --s-slat:rgb(var(--c-line-3));
        }
        .cd-glass{box-shadow:inset 0 3px 10px rgb(0 0 0 / .13),inset 0 -1px 0 rgb(0 0 0 / .06),inset 0 0 0 1px rgb(0 0 0 / .05)}
        html.dark .cd-glass{box-shadow:inset 0 3px 14px rgb(0 0 0 / .55),inset 0 -1px 0 rgb(0 0 0 / .30),inset 0 0 0 1px rgb(255 255 255 / .05)}
        html.matte.dark .cd-glass{box-shadow:inset 0 3px 14px rgb(0 0 0 / .70),inset 0 0 0 1px rgb(255 255 255 / .06)}
        html.matte:not(.dark) .cd-glass{box-shadow:inset 0 3px 10px rgb(0 0 0 / .10),inset 0 0 0 1px rgb(0 0 0 / .08)}
        .cd-spin-shadow{box-shadow:0 1px 2px rgb(0 0 0 / .12),0 4px 10px rgb(0 0 0 / .10)}
        .cd-drum{transform-style:preserve-3d}
        .cd-face{backface-visibility:hidden;will-change:transform,opacity}
        @keyframes cd-pop{0%{transform:scale(1)}45%{transform:scale(1.10)}100%{transform:scale(1)}}
        @keyframes cd-thud{0%{transform:scaleY(1)}30%{transform:scaleY(0.975)}100%{transform:scaleY(1)}}
        @keyframes cd-draw{to{stroke-dashoffset:0}}
        .cd-pop{animation:cd-pop 380ms cubic-bezier(.2,.7,.3,1.4)}
        .cd-thud{animation:cd-thud 180ms cubic-bezier(.34,1.56,.64,1)}
        .cd-line{stroke-dasharray:900;stroke-dashoffset:900;animation:cd-draw 240ms cubic-bezier(.16,1,.3,1) forwards}
        @media (prefers-reduced-motion: reduce){
          .cd-pop,.cd-thud{animation:none}
          .cd-line{stroke-dashoffset:0;animation:none}
        }
      `}</style>

      {/* Plinth — the 8px reveal is the seam that implies a machined body. */}
      <div className="bg-surface-3 border border-line-3 rounded-2xl p-2 animate-scale-in"
        style={{ boxShadow: "var(--shadow-panel)" }} onClick={(e) => e.stopPropagation()}>
        <div className="bg-surface border border-line rounded-xl" style={{ padding: geo === FULL ? 26 : 20 }}>
          <div style={{ width: W }}>

            {/* Header */}
            <div className="flex items-start justify-between" style={{ height: 36 }}>
              <div>
                <h2 className="text-[16px] font-semibold text-ink tracking-tight leading-none">Cross-dock</h2>
                <p className="text-[11px] text-muted mt-1">5 reels, {LINE_COUNT} lines</p>
              </div>
              <div className="flex items-center gap-1.5">
                {inFree && <StatusPill tone="accent">2x wins</StatusPill>}
                {inFree && free.total > 0 && (
                  <StatusPill tone="accent">
                    Free spin {Math.min(free.total, free.total - free.left + (phase === "idle" ? 0 : 1))} of {free.total}
                  </StatusPill>
                )}
                <button onClick={() => setPaytable(true)} title="Paytable"
                  className="w-7 h-7 rounded-md border border-line text-muted hover:text-ink hover:bg-surface-2 flex items-center justify-center transition-colors">
                  <Info size={14} />
                </button>
                <button onClick={onClose} disabled={busy} title="Close"
                  className="w-7 h-7 rounded-md border border-line text-muted hover:text-ink hover:bg-surface-2 flex items-center justify-center transition-colors disabled:opacity-40">
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Progressive meters. The live number is the whole affordance — no gauges,
                no per-tick animation, no leading marker, no tier singled out by hue. */}
            <div className="mt-4 flex bg-surface-2 border border-line-2 rounded-lg divide-x divide-line-2 overflow-hidden">
              {[...JACKPOTS].reverse().map((t) => (
                <div key={t.id} className={`flex-1 px-2.5 py-2 transition-colors ${flashTier === t.id ? "cd-pop" : ""}`}
                  style={flashTier === t.id ? { boxShadow: "inset 0 0 0 1px rgb(var(--c-accent))" } : undefined}>
                  <div className="text-[11px] text-muted leading-none">{t.name}</div>
                  <div className="text-[16px] font-semibold text-ink tabular-nums leading-none mt-1.5">
                    {Math.floor(saved.meters[t.id] ?? t.seed).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>

            {/* The glass, and behind it five drums */}
            <div className={`cd-glass mt-4 bg-surface-2 rounded-lg border transition-colors ${inFree ? "border-accent" : "border-line-2"}`}
              style={{ padding: geo === FULL ? 14 : 12 }}>
              <div className="relative" style={{ width: W, height: H }}>
                <div className="absolute inset-0 flex" style={{ gap: geo.gutter }}>
                  {lanes.map((lane, r) => (
                    <div key={r} ref={(el) => { colRefs.current[r] = el; }}
                      className="relative overflow-hidden"
                      style={{ width: geo.cell, height: H, perspective: PERSP, perspectiveOrigin: "50% 50%" }}>
                      <div className="cd-drum absolute inset-0">
                        {lane.map((id, k) => (
                          <div key={k} ref={(el) => { cellRefs.current[r][k] = el; }}
                            className="cd-face absolute left-0 flex items-center justify-center"
                            style={{ width: geo.cell, height: geo.cell, top: (H - geo.cell) / 2 }}>
                            <Badge id={id} geo={geo}
                              lit={landed > r && k >= LEAD && k < LEAD + 3 && lit.has(`${r}:${k - LEAD}`)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Five drums behind one pane, not one wide window. */}
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="absolute top-0 bg-line-3 pointer-events-none"
                    style={{ left: i * (geo.cell + geo.gutter) - geo.gutter / 2 - 0.5, width: 1, height: H }} />
                ))}
                <svg className="absolute inset-0 pointer-events-none" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
                  {lines.filter((w) => drawn.includes(w.line)).map((w) => (
                    <polyline key={w.line} className="cd-line"
                      // Only the run that actually paid, not the whole 5-reel line — drawing
                      // past the stopping reel reads as though it won too.
                      points={w.cells.map(([r, row]) => `${cx(geo, r)},${projectedY(geo, row)}`).join(" ")}
                      fill="none" stroke={ACC} opacity={0.9} strokeLinecap="round" strokeLinejoin="round"
                      strokeWidth={w.symbol === "bjm" && w.count === 5 ? 3.5 : 2.5} />
                  ))}
                </svg>
              </div>
            </div>

            {/* Message strip — fixed height so the rail never shifts, empty at rest. */}
            <div className="flex flex-col items-center justify-center text-center" style={{ height: 48 }}>
              {msg && (
                <div className="animate-fade-up">
                  <div className={`${msg.accent ? "text-[17px] text-accent" : "text-[14px] text-ink"} font-semibold leading-tight tabular-nums`}>
                    {msg.primary}
                  </div>
                  {msg.secondary && <div className="text-[13px] text-muted tabular-nums mt-0.5">{msg.secondary}</div>}
                </div>
              )}
            </div>

            {/* Control rail */}
            <div className="flex items-center justify-between" style={{ height: 64 }}>
              <div className="bg-surface-2 border border-line-2 rounded-lg px-3 py-2" style={{ width: geo === FULL ? 160 : 132 }}>
                <div className="text-[11px] text-muted leading-none">Credits</div>
                <div className="text-[20px] font-bold text-ink tabular-nums leading-none mt-1.5">{credits.toLocaleString()}</div>
              </div>

              <div className={`flex flex-col items-center gap-1 transition-opacity ${inFree ? "opacity-50 pointer-events-none" : ""}`}>
                <div className="flex items-center h-10 rounded-full border border-line bg-surface">
                  <button onClick={() => stepBet(-1)} disabled={busy || betIndex === 0}
                    className="w-8 h-8 ml-1 rounded-full text-ink-2 hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[15px] leading-none">−</button>
                  <span className="px-3 text-[13px] text-ink whitespace-nowrap tabular-nums">
                    Line bet {saved.lineBet}<span className="text-muted"> · Total {totalBet}</span>
                  </span>
                  <button onClick={() => stepBet(1)} disabled={busy || betIndex === LINE_BETS.length - 1}
                    className="w-8 h-8 mr-1 rounded-full text-ink-2 hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[15px] leading-none">+</button>
                </div>
                <span className="text-[11px] text-faint">{LINE_COUNT} lines</span>
              </div>

              {broke ? (
                <button
                  onClick={() => setSaved((sv) => ({ ...sv, credits: OPENING_FLOAT, stats: { ...sv.stats, floats: sv.stats.floats + 1 } }))}
                  className="h-10 px-4 rounded-full bg-accent hover:bg-accent-hover text-on-accent text-[13px] font-semibold transition-colors">
                  Reload the float
                </button>
              ) : (
                <button onClick={press} disabled={inFree || !!modal}
                  title={inFree ? "Free spins are playing" : phase === "spinning" ? "Stop the reels" : "Spin"}
                  className="cd-spin-shadow rounded-full bg-accent text-on-accent flex items-center justify-center transition-transform active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
                  style={{ width: geo.spin, height: geo.spin }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
                    {phase === "spinning"
                      ? <rect x="5" y="5" width="10" height="10" rx="2.5" fill="currentColor" />
                      : <path d="M6 4 L17 10 L6 16 Z" fill="currentColor" strokeLinejoin="round" strokeWidth={1.5} stroke="currentColor" />}
                  </svg>
                </button>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-faint tabular-nums pt-1">
              <span>
                {saved.stats.spins.toLocaleString()} {saved.stats.spins === 1 ? "spin" : "spins"} · best{" "}
                {saved.stats.best.toLocaleString()}
              </span>
              <span>
                {saved.stats.wagered > 0
                  ? `returned ${((saved.stats.won / saved.stats.wagered) * 100).toFixed(1)}% of ${saved.stats.wagered.toLocaleString()} staked`
                  : "95.82% return to player"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Major and Grand only — the one modal moment in the game. Mini and Minor stay on
          the meter strip, because 1 in 1,000 is a routine event and 1 in 50,000 is not. */}
      {modal && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-surface border border-accent rounded-2xl w-full max-w-md p-6 text-center animate-scale-in"
            style={{ boxShadow: "var(--shadow-modal)" }}>
            <h3 className="text-[20px] font-semibold text-ink">{modal.tier} jackpot</h3>
            <div className="text-[34px] font-bold text-accent tabular-nums my-3">{modal.amount.toLocaleString()}</div>
            <p className="text-[12px] text-muted mb-5">credits, straight off the meter</p>
            <button onClick={collect}
              className="h-10 px-6 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[13px] font-semibold transition-colors">
              Collect
            </button>
          </div>
        </div>
      )}

      {paytable && <Paytable lineBet={saved.lineBet} onClose={() => setPaytable(false)} />}
    </div>
  );
}
