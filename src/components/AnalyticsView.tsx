import { useEffect, useMemo, useRef, useState } from "react";
import {
  api, AnalyticsRange, AnalyticsMonth, AnalyticsReconciliation, ReconRow, AnalyticsPace,
  DashboardStats, FinancialsOverview,
} from "../lib/api";
import { fmtAmount, fmtCompactCurrency, localDay, parseLocalDay } from "../lib/format";
import { RefreshCw, FileDown } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  BarChart, Bar, PieChart, Pie, ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import TierBadge from "./TierBadge";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// ─── Theme-aware chart palette (R-319: Apple system colours) ──────
// Every colour on this screen is read through a CSS token, so light, dark and the two
// mono themes all get a palette that was chosen for them rather than flipped. The values
// behind these tokens are Apple's published system colours — see src/index.css.
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgbVar = (n: string) => `rgb(${cssVar(n)})`;
// SVG `fill` wants a colour it can parse everywhere, so alpha is built explicitly
// rather than relying on the `rgb(r g b / a)` space-separated form.
const rgbaVar = (n: string, a: number) => {
  const [r, g, b] = cssVar(n).split(/\s+/);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// Refined, muted tier swatches — premium metallics, not neon. An IDENTITY palette,
// deliberately outside the categorical slots below: the tier hues are fixed in ~17
// places across the app and only move all at once (architecture/client-tiers-platinum).
const TIER_CLR: Record<string, string> = {
  P:        "#8B5CF6",   // Platinum — violet (top tier)
  S:        "#2563EB",   // Diamond — sapphire (fixed data-viz hue, not the accent)
  A:        "#C9A227",   // Gold (muted)
  B:        "#A6AEBC",   // Silver
  C:        "#B17F4A",   // Bronze (muted)
  Prospect: "#9CA3AF",   // Prospect
};

const TIER_NAME: Record<string, string> = {
  P: "Platinum", S: "Diamond", A: "Gold", B: "Silver", C: "Bronze", Prospect: "Prospect",
};

const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect"];

// Resolve brand tokens to concrete chart colors; re-render on light/dark flip.
//
// Memoised on the theme tick. It used to run ~20 getComputedStyle reads on EVERY render
// of this view, and a tooltip hover renders this view — that alone was a measurable part
// of the lag, before a single chart redrew.
//
// Two families, and the difference matters: a MARK colour is Apple's exact system value
// and goes on bars, lines, dots and swatches; an INK colour is Apple's published
// accessible variant of the same hue and goes on text. systemGreen on white is 2.2:1 and
// cannot carry a 12.5px table cell — the ink can.
function usePalette() {
  const [tick, force] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => force((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return useMemo(() => {
    void tick;   // the theme flip IS the input — every value below is read off the DOM
    const neutral = rgbVar("--c-faint");
    // Revenue's own data hue — Apple's systemBlue. Not the accent (that greys out under
    // mono and is spoken for by the app's chrome) and not a status colour.
    const chartRevenue = rgbVar("--c-chart-revenue");
    // The categorical slots. Assigned in this order and never cycled — a seventh series
    // folds into "Other" rather than inventing a hue.
    const cat = [1, 2, 3, 4, 5, 6].map((i) => rgbVar(`--c-chart-${i}`));
    // Ordinal ramp for margin bands: one hue (profit's systemGreen), monotone lightness.
    const profitRamp = [0.45, 0.6, 0.72, 0.86, 1].map((a) => rgbaVar("--c-chart-profit", a));
    const MARK = {
      profit:  rgbVar("--c-chart-profit"),
      loss:    rgbVar("--c-chart-loss"),
      caution: rgbVar("--c-chart-caution"),
    };
    return {
      neutral, chartRevenue, cat, profitRamp, MARK,
      grid: rgbVar("--c-line"),
      // Text inks. `emerald`/`rose`/`amber` keep their names because they are referenced
      // ~40 times on this screen; the values behind them are now Apple's accessible
      // green, red and orange.
      CLR: {
        emerald: rgbVar("--c-chart-profit-ink"),
        rose:    rgbVar("--c-chart-loss-ink"),
        amber:   rgbVar("--c-chart-caution-ink"),
      },
      STATUS: {
        paid: MARK.profit, sent: chartRevenue, overdue: MARK.loss,
        draft: neutral, void: MARK.loss,
      } as Record<string, string>,
      TT: {
        contentStyle: {
          background: rgbVar("--c-surface"),
          border: `1px solid ${rgbVar("--c-line")}`,
          borderRadius: 12,
          color: rgbVar("--c-ink"),
          fontSize: 12,
          padding: "9px 13px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
        },
        // The hover cursor is chrome, not a mark — it wears ink, never the accent.
        cursor: { fill: rgbaVar("--c-ink", 0.05) },
        itemStyle: { color: rgbVar("--c-ink") },
        labelStyle: { color: rgbVar("--c-muted"), marginBottom: 3 },
      },
      AX: { fontSize: 10, fill: rgbVar("--c-muted") },
    };
  }, [tick]);
}

// Recharts animates every series on mount AND on every data change. Thirteen charts
// doing that at once is most of what "slow and laggy" was. Data is drawn, not performed.
const STILL = { isAnimationActive: false } as const;

// ─── Deferred mount ───────────────────────────────────────────────
// A panel below the fold still costs a ResponsiveContainer, its ResizeObserver and a
// recharts layout pass before anyone has scrolled to it. This mounts its children the
// first time they come near the viewport, and then leaves them mounted.
function Defer({ h, children }: { h: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) { setShown(true); io.disconnect(); } },
      { rootMargin: "500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);
  return (
    <div ref={ref} className="min-w-0">
      {shown ? children : <div className="rounded-[18px] bg-surface-2/50" style={{ minHeight: h }} />}
    </div>
  );
}

// ─── Date presets ─────────────────────────────────────────────────
// R-159: local (Central) day, computed per call — the old module-level UTC
// constants flipped "This month" to the next month on month-end evenings and
// went stale if the app stayed open past midnight.
const PRESETS = ["All time", "This year", "This month"] as const;
function presetRange(label: string): { start: string; end: string } {
  const today = localDay();
  if (label === "This year") return { start: today.slice(0, 4) + "-01-01", end: today };
  if (label === "This month") return { start: today.slice(0, 7) + "-01", end: today };
  return { start: "", end: "" };
}

// A negative figure reads "-$4,260.00" through fmtAmount, which puts the sign in the
// wrong place. Money that can go negative on this screen wears a real minus in front.
const signed = (n: number) => (n < 0 ? "−" + fmtAmount(Math.abs(n)) : fmtAmount(n));

// Jack, 2026-09-16: "im questioning why all dates say 26th of each month. why not just
// say the month." The old format was { month: "short", year: "2-digit" }, so 2026
// rendered as "Apr 26" and read as a day. A month is now just its name. The year is
// added only when the series really does span more than one calendar year, and then only
// on the FIRST bucket of each year rather than on all of them.
const shortMonth = (m: string) =>
  parseLocalDay(m + "-01").toLocaleDateString("en-US", { month: "short" });
const longMonth = (m: string) =>
  parseLocalDay(m + "-01").toLocaleDateString("en-US", { month: "long" });

function monthLabels(months: string[]): string[] {
  const spans = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const seen = new Set<string>();
  return months.map((m) => {
    const y = m.slice(0, 4);
    const first = !seen.has(y);
    seen.add(y);
    return spans && first ? `${shortMonth(m)} ${y}` : shortMonth(m);
  });
}

// ─── Main view ───────────────────────────────────────────────────
export default function AnalyticsView() {
  const P = usePalette();
  // R-320: which month the pace chart is singling out (null = just this month).
  const [paceHi, setPaceHi] = useState<string | null>(null);
  const CLR = P.CLR;
  const TT = P.TT;
  const AX = P.AX;
  const revenueClr = P.chartRevenue;
  const [stats,     setStats]     = useState<DashboardStats | null>(null);
  const [range,     setRange]     = useState<AnalyticsRange | null>(null);
  const [recon,     setRecon]     = useState<AnalyticsReconciliation | null>(null);
  const [tiers,     setTiers]     = useState<any[]>([]);
  const [money,     setMoney]     = useState<FinancialsOverview | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [bars,      setBars]      = useState(false);
  const [preset,    setPreset]    = useState<string>("All time");
  const [startDate, setStartDate] = useState("");
  const [endDate,   setEndDate]   = useState("");
  // Revenue or profit on the pace chart. One question, one line, a toggle rather than
  // two charts fighting over one axis.
  const [paceMetric, setPaceMetric] = useState<"revenue" | "profit">("revenue");
  // The reconciliation table can run to hundreds of rows. It renders the first 25 until
  // asked for the rest, which is the difference between one layout pass and hundreds.
  const [reconAll, setReconAll] = useState(false);

  // The KPI count-ups are gone (R-319). Four of them re-rendered this entire view on
  // every animation frame — and this view owns thirteen charts, so each frame was
  // thirteen recharts layout passes. The figures render immediately instead.

  const loadRange = async (start: string, end: string) => {
    setBars(false);
    try { setRange(await api.getAnalyticsRange(start, end)); } catch {}
    // Reconciliation is its own read and is allowed to fail on its own: it must never
    // be the reason the rest of the screen shows nothing.
    api.analyticsReconciliation(start, end).then(setRecon).catch(() => setRecon(null));
    setTimeout(() => setBars(true), 120);
  };

  const applyPreset = (p: typeof PRESETS[number]) => {
    const { start, end } = presetRange(p);
    setPreset(p);
    setStartDate(start);
    setEndDate(end);
    loadRange(start, end);
  };

  const applyCustomRange = () => {
    setPreset("Custom");
    loadRange(startDate, endDate);
  };

  const load = async () => {
    setLoading(true);
    setBars(false);
    try {
      const [s, t, r] = await Promise.all([
        api.dashboardStats(),
        api.buyerTiers(),
        api.getAnalyticsRange(startDate, endDate),
      ]);
      setStats(s);
      setTiers(t);
      setRange(r);
      // Cash position is secondary — load separately so a Plaid/overview hiccup
      // never blanks the analytics page. Same for the reconciliation read.
      api.financialsOverview().then(setMoney).catch(() => {});
      api.analyticsReconciliation(startDate, endDate).then(setRecon).catch(() => setRecon(null));
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!loading && stats) setTimeout(() => setBars(true), 120);
  }, [loading, stats]);

  const rangeLabel = preset === "Custom" ? "the selected range" : preset.toLowerCase();

  // The primary trend. The in-progress month is marked but NOT projected here: R-316
  // stacked the projection as a remainder on top of the real bar, which asked the eye to
  // decode a forecast as the top of a column. The projection lives on the pace panel now,
  // where it is a line with a "today" marker and a sentence.
  const trend = useMemo(() => {
    const months: AnalyticsMonth[] = range?.monthly_profit ?? [];
    const labels = monthLabels(months.map((m) => m.month));
    const rr = range?.run_rate ?? null;
    return months.map((m, i) => ({
      ...m,
      label: labels[i],
      projected: !!rr && rr.month === m.month,
    }));
  }, [range?.monthly_profit, range?.run_rate]);

  // Velocity carries its own month series, so it gets its own year-aware labels.
  const velocityRows = useMemo(() => {
    const by = range?.velocity.by_month ?? [];
    const labels = monthLabels(by.map((v) => v.month));
    return by.map((v, i) => ({ ...v, label: labels[i] }));
  }, [range?.velocity]);

  // ── Pace rows: one row per day of month, one series per month ────────────────────
  // The current month's series is cut off at today — past that there is no data, and a
  // line that ran flat to the month end would read as "we stopped selling".
  const pace: AnalyticsPace | null = range?.pace ?? null;
  const paceRows = useMemo(() => {
    if (!pace || pace.months.length === 0) return [];
    const span = Math.max(...pace.months.map((m) => m.days_in_month));
    const curIdx = pace.months.length - 1;
    const rows: Record<string, number | null>[] = [];
    for (let d = 1; d <= span; d++) {
      const row: Record<string, number | null> = { day: d };
      pace.months.forEach((m, i) => {
        const pt = m.days[d - 1];
        const past = i === curIdx && d > pace.day_of_month;
        row[`m${i}`] = pt && !past ? pt[paceMetric] : null;
      });
      rows.push(row);
    }
    return rows;
  }, [pace, paceMetric]);

  const reconRows = useMemo(
    () => (reconAll ? recon?.deals ?? [] : (recon?.deals ?? []).slice(0, 25)),
    [recon, reconAll],
  );

  // Skeleton mirrors the real layout: header, KPI band, primary trend, overhead panel,
  // then the paired analysis cards. Blocks, not spinners — the page keeps its shape.
  if (loading) return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="h-6 w-28 bg-surface-2 rounded-md animate-pulse" />
          <div className="h-3.5 w-52 bg-surface-2 rounded animate-pulse mt-2" />
        </div>
        <div className="h-8 w-72 bg-surface-2 rounded-lg animate-pulse" />
      </div>
      <div className="h-[168px] bg-surface-2 rounded-[20px] animate-pulse" />
      <div className="h-[360px] bg-surface-2 rounded-[18px] animate-pulse" />
      <div className="h-[340px] bg-surface-2 rounded-[18px] animate-pulse" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="h-72 bg-surface-2 rounded-2xl animate-pulse" />
        <div className="h-72 bg-surface-2 rounded-2xl animate-pulse" />
      </div>
      <div className="h-[260px] bg-surface-2 rounded-2xl animate-pulse" />
      <div className="h-[300px] bg-surface-2 rounded-2xl animate-pulse" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="h-64 bg-surface-2 rounded-2xl animate-pulse" />
        <div className="h-64 bg-surface-2 rounded-2xl animate-pulse" />
      </div>
    </div>
  );
  if (!stats || !range) return (
    <div className="text-center py-32 text-[13px] text-faint">No analytics yet. Close a deal and this fills in.</div>
  );

  // ── Derived ───────────────────────────────────────────────────
  const won      = range.deal_count;
  const lost     = range.deals_lost;
  const winRate  = won + lost > 0 ? (won / (won + lost)) * 100 : 0;
  const tierMap  = tiers.reduce((acc: Record<string, number>, t: any) => {
    acc[t.tier] = (acc[t.tier] || 0) + 1; return acc;
  }, {} as Record<string, number>);
  const totalCl  = tiers.length;
  const totalSV  = stats.invoice_status_breakdown.reduce((s, x) => s + x.total, 0);
  const cats     = stats.category_breakdown.filter((c) => c.client_count > 0 && c.revenue > 0);

  const overheadTotal = range.total_shipping + range.total_fees;
  const rn = range.repeat_new;
  const repeatTotal = rn.new_revenue + rn.repeat_revenue;

  const handleExportAnalytics = async () => {
    const path = await saveDialog({ filters: [{ name: "Excel", extensions: ["xlsx"] }], defaultPath: "analytics.xlsx" });
    if (!path) return;
    await api.exportAnalyticsXlsx(path as string);
    toast("Exported analytics to Excel");
  };

  // ── Layout ───────────────────────────────────────────────────
  // `analytics-stage` is the wash the glass samples: without something behind it, a
  // translucent panel over a flat page is just a tint.
  return (
    <div className="space-y-5 analytics-stage">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Analytics</h2>
          <p className="text-[12px] text-muted mt-0.5">Closed-deal performance for {rangeLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
                preset === p
                  ? "bg-accent text-on-accent"
                  : "bg-surface ring-1 ring-line text-muted hover:ring-accent hover:text-accent"
              }`}
            >
              {p}
            </button>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="ring-1 ring-line bg-surface h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <span className="text-[11px] text-muted">to</span>
            <input
              type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="ring-1 ring-line bg-surface h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <button onClick={applyCustomRange}
              className="px-3 h-8 bg-surface ring-1 ring-line rounded-lg text-[12px] text-muted hover:ring-accent hover:text-accent transition-colors">
              Apply
            </button>
          </div>
          <button onClick={load}
            className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                       px-2.5 h-8 rounded-lg hover:bg-surface-3 transition-colors ring-1 ring-line">
            <RefreshCw size={13} /> Refresh
          </button>
          <button onClick={handleExportAnalytics}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium transition-colors">
            <FileDown size={13} /> Export
          </button>
        </div>
      </div>

      {/* ── How are we doing ───────────────────────────────────────
          Six tiles on a hairline grid. The gap-px trick draws the dividers,
          so they stay correct at every wrap instead of relying on divide-x
          on a column count that was guessed. Steps 2 → 3 → 6 across the
          sidebar-narrowed pane; it is the old xl:grid-cols-5 that overflowed.
      ─────────────────────────────────────────────────────────── */}
      <div className="rounded-[20px] overflow-hidden ring-1 ring-line/70 bg-line/60 glass">
        <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-px">
          <Kpi label="Revenue" value={fmtAmount(range.total_revenue)} hint="closed deal revenue" color={revenueClr} />
          <Kpi label="Net profit" value={signed(range.total_profit)} hint="after all deal costs"
            color={range.total_profit >= 0 ? CLR.emerald : CLR.rose} />
          <Kpi label="True net" value={signed(range.true_net)} hint="after shipping and bank fees"
            color={range.true_net >= 0 ? CLR.emerald : CLR.rose} />
          <Kpi label="Margin" value={`${range.avg_margin.toFixed(1)}%`} hint="revenue-weighted" />
          <Kpi label="Deals closed" value={String(won)} hint={`${lost} fell through`} />
          <Kpi label="Win rate" value={won + lost > 0 ? `${winRate.toFixed(0)}%` : "—"} hint="won vs fell through"
            color={won + lost === 0 ? undefined : winRate >= 60 ? CLR.emerald : winRate >= 40 ? CLR.amber : CLR.rose} />
        </div>
        {/* The range needs something to be compared against, on the same population. */}
        <div className="bg-surface/70 px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[11.5px] text-muted">
          <span>
            This month <b className="text-ink-2 tabular-nums font-semibold">{fmtAmount(range.revenue_this_month)}</b> revenue
            {" · "}<b className="text-ink-2 tabular-nums font-semibold">{signed(range.profit_this_month)}</b> profit
            {" · "}<b className="text-ink-2 tabular-nums font-semibold">{range.margin_this_month.toFixed(1)}%</b>
          </span>
          <span>
            All time <b className="text-ink-2 tabular-nums font-semibold">{fmtAmount(range.revenue_all_time)}</b> revenue
            {" · "}<b className="text-ink-2 tabular-nums font-semibold">{signed(range.profit_all_time)}</b> profit
            {" · "}<b className="text-ink-2 tabular-nums font-semibold">{range.margin_all_time.toFixed(1)}%</b>
          </span>
          <span>
            <b className="text-ink-2 tabular-nums font-semibold">{range.new_clients}</b> new clients
            {" · "}<b className="text-ink-2 tabular-nums font-semibold">{range.interactions}</b> interactions in {rangeLabel}
          </span>
        </div>
      </div>

      {/* ── How this month is going (R-319) ───────────────────────
          Jack asked to see how the current month is doing "compared to where we were at
          this point in previous months". That is a cumulative line by DAY OF MONTH: the
          current month bold and stopping at today, the three before it faint and running
          their full length. Day 16 against day 16 is then a vertical distance, not an
          inference. The answer is also stated in words above the chart, because the
          sentence is the thing he actually asked for.
      ─────────────────────────────────────────────────────────── */}
      {pace && (
        <Card
          title="Month comparisons"
          sub={`${longMonth(pace.current_month)} against the ${pace.prior_count} month${pace.prior_count !== 1 ? "s" : ""} before it · not affected by the date range`}
          right={
            <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-0.5">
              {(["revenue", "profit"] as const).map((m) => (
                <button key={m} onClick={() => setPaceMetric(m)}
                  className={`px-2.5 h-6 rounded-md text-[11.5px] font-medium capitalize transition-colors ${
                    paceMetric === m ? "bg-surface text-ink ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                  {m}
                </button>
              ))}
            </div>
          }
        >
          <PaceSummary pace={pace} metric={paceMetric} CLR={CLR} />
          {paceRows.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={270}>
                <LineChart data={paceRows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                  <XAxis dataKey="day" tick={AX} axisLine={false} tickLine={false}
                    tickFormatter={(d: number) => String(d)} interval={2} />
                  <YAxis tick={AX} axisLine={false} tickLine={false} width={54}
                    tickFormatter={(v: number) => fmtCompactCurrency(v)} />
                  <Tooltip {...TT}
                    formatter={(v: any, n: any) => [signed(Number(v)), n]}
                    labelFormatter={(d: any) => `Day ${d}`} />
                  <ReferenceLine x={pace.day_of_month} stroke={rgbaVar("--c-ink", 0.28)}
                    strokeDasharray="3 3"
                    label={{ value: "Today", position: "insideTopRight", fill: rgbVar("--c-muted"), fontSize: 10 }} />
                  {/* Prior months wear ink at low alpha, not a hue: only the month being
                      asked about carries colour, so the comparison reads at a glance. */}
                  {pace.months.map((m, i) => {
                    const current = i === pace.months.length - 1;
                    const picked  = paceHi === m.month;
                    // Nothing picked: this month carries the hue and the rest are ink.
                    // Pick one and IT carries a hue of its own, the others step back — so
                    // any two months can be read against each other, not just against now.
                    const clr = picked
                      ? P.cat[i % P.cat.length]
                      : current
                        ? (paceMetric === "revenue" ? revenueClr : P.MARK.profit)
                        : rgbaVar("--c-ink", 0.20 + i * 0.12);
                    const dimmed = paceHi !== null && !picked && !current;
                    return (
                      <Line key={m.month} type="monotone" dataKey={`m${i}`} name={longMonth(m.month)}
                        stroke={clr} strokeWidth={picked ? 3 : current ? 2.75 : 1.5}
                        strokeOpacity={dimmed ? 0.35 : 1}
                        dot={false} connectNulls={false} {...STILL} />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 flex-wrap mt-3">
                {pace.months.map((m, i) => {
                  const current = i === pace.months.length - 1;
                  const picked  = paceHi === m.month;
                  return (
                    <Legend key={m.month}
                      color={picked
                        ? P.cat[i % P.cat.length]
                        : current
                          ? (paceMetric === "revenue" ? revenueClr : P.MARK.profit)
                          : rgbaVar("--c-ink", 0.20 + i * 0.12)}
                      label={current ? `${longMonth(m.month)} (so far)` : longMonth(m.month)}
                      active={picked}
                      onClick={() => setPaceHi(picked ? null : m.month)} />
                  );
                })}
                {paceHi && (
                  <button type="button" onClick={() => setPaceHi(null)}
                    className="text-[11px] text-muted hover:text-ink transition-colors duration-[130ms]">
                    Clear
                  </button>
                )}
              </div>
            </>
          ) : <Blank h={270} text="No closed deals in the last four months" />}
        </Card>
      )}

      {/* ── Primary trend ───────────────────────────────────────── */}
      <Card
        title="Revenue and profit by month"
        sub={trend.length > 0
          ? `${trend.length} month${trend.length !== 1 ? "s" : ""} of closed deals`
          : "No closed deals in this range"}
        right={
          <div className="flex items-center gap-4 flex-wrap justify-end">
            <Legend color={revenueClr} label="Revenue" />
            <Legend color={P.MARK.profit} label="Profit" />
          </div>
        }
      >
        {trend.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trend} barCategoryGap="34%" barGap={3}
                margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                <YAxis tick={AX} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => fmtCompactCurrency(v)} width={54} />
                <Tooltip {...TT} formatter={(v: any, n: any) => [signed(Number(v)), n]}
                  labelFormatter={(l: any) => String(l)} />
                {/* An open month is drawn at half strength rather than carrying a stacked
                    forecast on its head. What it will finish at is on the pace panel. */}
                <Bar dataKey="revenue" name="Revenue" radius={[5, 5, 0, 0]} maxBarSize={38} {...STILL}>
                  {trend.map((m, i) => (
                    <Cell key={i} fill={revenueClr} fillOpacity={m.projected ? 0.42 : 1} />
                  ))}
                </Bar>
                <Bar dataKey="profit" name="Profit" radius={[5, 5, 0, 0]} maxBarSize={38} {...STILL}>
                  {trend.map((m, i) => (
                    <Cell key={i} fill={m.profit >= 0 ? P.MARK.profit : P.MARK.loss}
                      fillOpacity={m.projected ? 0.42 : 1} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
            {range.run_rate && (
              <p className="text-[11px] text-muted mt-3 tabular-nums">
                {longMonth(range.run_rate.month)} is still open — {range.run_rate.days_elapsed} of{" "}
                {range.run_rate.days_in_month} days in, so its bars are drawn at half strength.
              </p>
            )}
          </>
        ) : <Blank h={300} text="Nothing closed in this range" />}
      </Card>

      {/* ── Money in, money out (R-317) ───────────────────────────
          A statement, not a dashboard. Three blocks that have to agree with one
          another, and that say so in words when they do not: the bridge from revenue
          to true net, the bank measured against those same deals, and every deal with
          the bank evidence behind it. The bridge and the bank sit side by side on xl;
          the table is full width beneath them with a sticky header and a sticky total.
      ─────────────────────────────────────────────────────────── */}
      {recon && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card
              glass
              title="Money in, money out"
              sub={`Revenue down to true net for ${rangeLabel}`}
              right={recon.bridge_ties
                ? <StatusPill tone="success">Every line ties</StatusPill>
                : <StatusPill tone="danger">Does not tie</StatusPill>}
            >
              <BridgeList rows={recon.bridge} CLR={CLR} />
              <p className="text-[11px] text-muted mt-4">
                Each subtotal is read straight from the book, not added up from the lines
                above it. Where the two disagree, the difference is named on the line.
              </p>
            </Card>

            <Card
              glass
              title="The bank against these deals"
              sub="Why the account moved by a different figure from the profit"
              right={recon.bank.ties
                ? <StatusPill tone="success">Fully explained</StatusPill>
                : <StatusPill tone="warning">{fmtAmount(Math.abs(recon.bank.residual))} unexplained</StatusPill>}
            >
              <BridgeList rows={recon.bank.rows} CLR={CLR} />
              <p className="text-[11px] text-muted mt-4">
                A bank line is dated by the day it posted; a deal is dated by the day it
                completed. Over all time those are the same book. Over a short range they
                are not, and the difference lands on the unexplained line.
              </p>
              {recon.bank.orphan_allocations > 0 && (
                <p className="text-[11px] text-danger-ink mt-2">
                  {recon.bank.orphan_allocations} allocation
                  {recon.bank.orphan_allocations !== 1 ? "s" : ""} worth{" "}
                  {fmtAmount(recon.bank.orphan_amount)} point at a bank transaction that no
                  longer exists. That money cannot be traced from either side.
                </p>
              )}
            </Card>
          </div>

          <Card
            title="Every closed deal, and the money behind it"
            sub={recon.deals_capped
              ? `The ${recon.deals.length} most profitable of ${recon.totals.deal_count} closed deals — the totals cover all of them`
              : `${recon.totals.deal_count} closed deal${recon.totals.deal_count !== 1 ? "s" : ""} in ${rangeLabel}`}
          >
            {recon.deals.length > 0 ? (
              <>
                <div className="overflow-x-auto -mx-5 px-5 max-h-[560px] overflow-y-auto">
                  <table className="w-full min-w-[860px] text-[12.5px]">
                    <thead className="sticky top-0 bg-surface z-10">
                      <tr className="text-[11px] text-muted border-b border-line">
                        <th className="text-left font-medium py-2 pr-3">Invoice</th>
                        <th className="text-left font-medium py-2 px-3">Buyer</th>
                        <th className="text-left font-medium py-2 px-3">Closed</th>
                        <th className="text-right font-medium py-2 px-3">Money in</th>
                        <th className="text-right font-medium py-2 px-3">Money out</th>
                        <th className="text-right font-medium py-2 px-3">Refunds</th>
                        <th className="text-right font-medium py-2 px-3">Profit</th>
                        <th className="text-right font-medium py-2 pl-3">True net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconRows.map((d, i) => (
                        <tr key={`${d.invoice_number}-${i}`}
                          className="border-b border-line-2 hover:bg-surface-2 transition-colors">
                          <td className="py-2.5 pr-3 text-ink whitespace-nowrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span>{d.invoice_number}</span>
                              {d.flags.map((f) => (
                                <StatusPill key={f} tone="warning">{f}</StatusPill>
                              ))}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-ink-2 min-w-0">
                            <div className="truncate max-w-[200px]">{d.client_name}</div>
                          </td>
                          <td className="py-2.5 px-3 text-muted tabular-nums whitespace-nowrap">{d.completed_on}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap text-success-ink">
                            {fmtAmount(d.money_in)}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap text-ink-2">
                            {fmtAmount(d.money_out)}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap"
                            style={d.refunds > 0 ? { color: CLR.rose } : undefined}>
                            {d.refunds > 0 ? signed(-d.refunds) : "—"}
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums font-medium whitespace-nowrap"
                            style={{ color: d.profit >= 0 ? CLR.emerald : CLR.rose }}>{signed(d.profit)}</td>
                          <td className="py-2.5 pl-3 text-right tabular-nums font-medium whitespace-nowrap"
                            style={{ color: d.true_net_share >= 0 ? CLR.emerald : CLR.rose }}>
                            {signed(d.true_net_share)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="sticky bottom-0 bg-surface">
                      <tr className="border-t border-line text-[12.5px] font-semibold">
                        <td className="py-2.5 pr-3 text-ink whitespace-nowrap">
                          {recon.totals.deal_count} deal{recon.totals.deal_count !== 1 ? "s" : ""}
                        </td>
                        <td className="py-2.5 px-3" />
                        <td className="py-2.5 px-3" />
                        <td className="py-2.5 px-3 text-right tabular-nums text-success-ink whitespace-nowrap">
                          {fmtAmount(recon.totals.money_in)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-ink whitespace-nowrap">
                          {fmtAmount(recon.totals.money_out)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap"
                          style={recon.totals.refunds > 0 ? { color: CLR.rose } : undefined}>
                          {recon.totals.refunds > 0 ? signed(-recon.totals.refunds) : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap"
                          style={{ color: recon.totals.profit >= 0 ? CLR.emerald : CLR.rose }}>
                          {signed(recon.totals.profit)}
                        </td>
                        <td className="py-2.5 pl-3 text-right tabular-nums whitespace-nowrap"
                          style={{ color: recon.totals.true_net_share >= 0 ? CLR.emerald : CLR.rose }}>
                          {signed(recon.totals.true_net_share)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {!reconAll && recon.deals.length > reconRows.length && (
                  <button onClick={() => setReconAll(true)}
                    className="mt-3 px-3 h-8 rounded-lg bg-surface ring-1 ring-line text-[12px] text-muted
                               hover:ring-accent hover:text-accent transition-colors">
                    Show all {recon.deals.length} rows
                  </button>
                )}
                <div className="text-[11px] mt-3 space-y-1">
                  <p className="text-muted">
                    Profit and true net add back to the bridge exactly. Money in and money out
                    are bank evidence — what is actually allocated to the deal — so they are
                    allowed to differ from revenue and cost, and here is by how much.
                  </p>
                  <Gap label="Buyer money banked" gap={recon.totals.money_in_gap} against="recorded revenue" CLR={CLR} />
                  <Gap label="Supplier money banked" gap={recon.totals.money_out_gap} against="recorded cost" CLR={CLR}
                    because={Math.abs(recon.totals.money_out_gap - recon.totals.supplier_refund_in) < 0.005
                      && recon.totals.supplier_refund_in > 0
                      ? `exactly the ${fmtAmount(recon.totals.supplier_refund_in)} a supplier sent back`
                      : undefined} />
                </div>
              </>
            ) : <Blank h={160} text="Nothing closed in this range to reconcile" />}
          </Card>
        </div>
      )}

      <Defer h={420}>
      {/* ── Shipping and bank fees: its own panel, not a line above a chart ── */}
      <Card
        title="Shipping and bank fees"
        sub="Money that leaves the bank and never reaches a deal's cost"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)] gap-x-8 gap-y-6">
          {/* The two sums Jack asked for, stated plainly, with the ratio under them. */}
          <div className="min-w-0 space-y-4">
            <Stat label="Shipping" value={fmtAmount(range.total_shipping)} swatch={P.cat[0]} />
            <Stat label="Bank and wire fees" value={fmtAmount(range.total_fees)} swatch={P.cat[1]} />
            <div className="pt-4 border-t border-line-2">
              <Stat label="Overhead" value={fmtAmount(overheadTotal)}
                hint={`${range.overhead_ratio.toFixed(1)}% of revenue`} />
            </div>
            <div className="pt-4 border-t border-line-2">
              <Stat label="True net" value={signed(range.true_net)}
                color={range.true_net >= 0 ? CLR.emerald : CLR.rose}
                hint="net profit minus this overhead" />
            </div>
          </div>

          {/* One dollar axis for the two overhead series; the ratio is a different
              measure, so it gets its own chart rather than a second y-axis. */}
          <div className="min-w-0 space-y-4">
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[11.5px] text-muted">Overhead by month</span>
                <div className="flex items-center gap-4">
                  <Legend color={P.cat[0]} label="Shipping" />
                  <Legend color={P.cat[1]} label="Fees" />
                </div>
              </div>
              {trend.length > 0 ? (
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart data={trend} margin={{ top: 4, right: 4, left: -12, bottom: 0 }} barCategoryGap="34%">
                    <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                    <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                    <YAxis tick={AX} axisLine={false} tickLine={false} width={54}
                      tickFormatter={(v: number) => fmtCompactCurrency(v)} />
                    <Tooltip {...TT} formatter={(v: any, n: any) => [signed(Number(v)), n]} />
                    <Bar dataKey="shipping" name="Shipping" stackId="oh" fill={P.cat[0]} maxBarSize={34} {...STILL} />
                    <Bar dataKey="fees" name="Fees" stackId="oh" fill={P.cat[1]} maxBarSize={34} radius={[5, 5, 0, 0]} {...STILL} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Blank h={170} text="No overhead recorded in this range" />}
            </div>
            <div className="min-w-0">
              <span className="text-[11.5px] text-muted">Overhead as a share of revenue</span>
              {trend.length > 0 ? (
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart data={trend} margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                    <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                    <YAxis tick={AX} axisLine={false} tickLine={false} width={54}
                      tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                    <Tooltip {...TT} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Overhead"]} />
                    <Line type="monotone" dataKey="overhead_pct" name="Overhead" stroke={P.cat[0]}
                      strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: P.cat[0] }} {...STILL} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <Blank h={130} text="No revenue to compare against" />}
            </div>
          </div>
        </div>
      </Card>
      </Defer>

      <Defer h={360}>
      {/* ── Margin distribution + revenue concentration ─────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Margin distribution" sub="Deals by margin band, so a fat tail stays visible">
          {range.margin_bands.some((b) => b.deals > 0) ? (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={range.margin_bands} layout="vertical" barCategoryGap="26%"
                  margin={{ top: 0, right: 12, left: 6, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={P.grid} horizontal={false} />
                  <XAxis type="number" tick={AX} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" tick={AX} axisLine={false} tickLine={false} width={56} />
                  <Tooltip {...TT}
                    formatter={(v: any, _n: any, e: any) => [
                      `${v} deal${v !== 1 ? "s" : ""} · ${fmtAmount(e?.payload?.revenue ?? 0)} revenue`, "Deals"]} />
                  <Bar dataKey="deals" name="Deals" radius={[0, 5, 5, 0]} maxBarSize={24} {...STILL}>
                    {range.margin_bands.map((b, i) => (
                      <Cell key={b.label} fill={i === 0 ? P.MARK.loss : P.profitRamp[Math.min(i - 1, P.profitRamp.length - 1)]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11.5px]">
                {range.margin_bands.filter((b) => b.deals > 0).map((b) => (
                  <div key={b.label} className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-muted truncate">{b.label}</span>
                    <span className="text-ink-2 tabular-nums font-medium flex-shrink-0">{signed(b.profit)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <Blank h={230} text="No closed deals with revenue in this range" />}
        </Card>

        <Card title="Where the revenue is concentrated"
          sub={`${range.concentration.client_count} buyer${range.concentration.client_count !== 1 ? "s" : ""} in ${rangeLabel}`}>
          {range.concentration.client_count > 0 ? (
            <>
              <div className="grid grid-cols-3 gap-3 mb-5">
                <Concentration label="Top buyer" pct={range.concentration.top1_pct} warnAt={40} unit="of revenue" P={P} />
                <Concentration label="Top 3" pct={range.concentration.top3_pct} warnAt={70} unit="of revenue" P={P} />
                <Concentration label="Top 5" pct={range.concentration.top5_pct} warnAt={85} unit="of revenue" P={P} />
              </div>
              <ShareBar
                parts={range.top_revenue_clients.map((c, i) => ({ name: c.name, value: c.revenue, color: P.cat[i] }))}
                total={range.concentration.total_revenue} otherColor={P.neutral} animate={bars}
              />
              <div className="mt-4 space-y-2">
                {range.top_revenue_clients.map((c, i) => (
                  <div key={c.name} className="flex items-center gap-2.5 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: P.cat[i] }} />
                    <span className="text-[12.5px] text-ink truncate flex-1 min-w-0">{c.name}</span>
                    <span className="text-[11px] text-muted tabular-nums flex-shrink-0 w-11 text-right">
                      {c.pct.toFixed(1)}%
                    </span>
                    <span className="text-[12.5px] text-ink-2 font-semibold tabular-nums flex-shrink-0">
                      {fmtAmount(c.revenue)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : <Blank h={230} text="No buyers with revenue in this range" />}
        </Card>
      </div>
      </Defer>

      <Defer h={360}>
      {/* ── Repeat versus new + deal velocity ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Repeat buyers versus first-time"
          sub="A deal counts as first-time when it is that buyer's earliest closed deal">
          {repeatTotal > 0 ? (
            <>
              <ShareBar
                parts={[
                  { name: "Repeat", value: rn.repeat_revenue, color: P.cat[0] },
                  { name: "First-time", value: rn.new_revenue, color: P.cat[1] },
                ]}
                total={repeatTotal} otherColor={P.neutral} animate={bars}
              />
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 mt-5">
                <Stat label="Repeat revenue" value={fmtAmount(rn.repeat_revenue)} swatch={P.cat[0]}
                  hint={`${rn.repeat_deals} deal${rn.repeat_deals !== 1 ? "s" : ""} · ${rn.repeat_clients} buyer${rn.repeat_clients !== 1 ? "s" : ""}`} />
                <Stat label="First-time revenue" value={fmtAmount(rn.new_revenue)} swatch={P.cat[1]}
                  hint={`${rn.new_deals} deal${rn.new_deals !== 1 ? "s" : ""} · ${rn.new_clients} buyer${rn.new_clients !== 1 ? "s" : ""}`} />
                <Stat label="Repeat profit" value={signed(rn.repeat_profit)}
                  color={rn.repeat_profit >= 0 ? CLR.emerald : CLR.rose} />
                <Stat label="First-time profit" value={signed(rn.new_profit)}
                  color={rn.new_profit >= 0 ? CLR.emerald : CLR.rose} />
              </div>
            </>
          ) : <Blank h={230} text="No revenue to split in this range" />}
        </Card>

        <Card title="Deal velocity"
          sub={range.velocity.median_days !== null
            ? `Median ${range.velocity.median_days.toFixed(0)} days from invoice issued to deal completed, over ${range.velocity.deals_measured} deal${range.velocity.deals_measured !== 1 ? "s" : ""}`
            : "Days from invoice issued to deal completed"}>
          {velocityRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <LineChart data={velocityRows}
                margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                <YAxis tick={AX} axisLine={false} tickLine={false} width={40}
                  tickFormatter={(v: number) => `${v}d`} />
                <Tooltip {...TT}
                  formatter={(v: any, _n: any, e: any) => [
                    `${Number(v).toFixed(0)} days · ${e?.payload?.deals ?? 0} deal${e?.payload?.deals !== 1 ? "s" : ""}`,
                    "Median"]} />
                <Line type="monotone" dataKey="median_days" name="Median" stroke={P.cat[0]} strokeWidth={2}
                  dot={{ r: 2.5, strokeWidth: 0, fill: P.cat[0] }} connectNulls {...STILL} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Blank h={230} text="No deal has both an issue date and a completion date yet" />}
        </Card>
      </div>
      </Defer>

      <Defer h={360}>
      {/* ── Supplier spend + category revenue ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Where the money goes"
          sub={`${range.supplier_concentration.supplier_count} supplier${range.supplier_concentration.supplier_count !== 1 ? "s" : ""} paid in ${rangeLabel}`}>
          {range.supplier_concentration.supplier_count > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-5">
                <Concentration label="Top supplier" pct={range.supplier_concentration.top1_pct} warnAt={50} unit="of spend" P={P} />
                <Concentration label="Top 3" pct={range.supplier_concentration.top3_pct} warnAt={80} unit="of spend" P={P} />
              </div>
              <ShareBar
                parts={range.top_suppliers_range.map((s, i) => ({ name: s.name, value: s.total_paid, color: P.cat[i] }))}
                total={range.supplier_concentration.total_spend} otherColor={P.neutral} animate={bars}
              />
              <div className="mt-4 space-y-2">
                {range.top_suppliers_range.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-2.5 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: P.cat[i] }} />
                    <span className="text-[12.5px] text-ink truncate flex-1 min-w-0">{s.name}</span>
                    <span className="text-[11px] text-muted tabular-nums flex-shrink-0">
                      {s.deal_count} deal{s.deal_count !== 1 ? "s" : ""}
                    </span>
                    <span className="text-[12.5px] text-ink-2 font-semibold tabular-nums flex-shrink-0 w-24 text-right">
                      {fmtAmount(s.total_paid)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : <Blank h={230} text="No supplier payments in this range" />}
        </Card>

        <Card title="Revenue by category" sub="Client category · all time">
          {cats.length > 0 ? (
            <div className="space-y-3.5 max-h-[300px] overflow-y-auto pr-1">
              {(() => {
                const maxCat = Math.max(...cats.map((c) => c.revenue), 1);
                return cats.map((c, i) => (
                  <div key={c.category} className="min-w-0">
                    <div className="flex items-center justify-between gap-3 mb-1.5 min-w-0">
                      <span className="text-[12px] font-medium text-ink-2 truncate min-w-0">{c.category}</span>
                      <div className="flex items-center gap-2.5 flex-shrink-0">
                        <span className="text-[11px] text-muted tabular-nums">
                          {c.client_count} client{c.client_count !== 1 ? "s" : ""}
                        </span>
                        <span className="text-[12px] font-semibold text-ink tabular-nums">{fmtAmount(c.revenue)}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{
                          width: bars ? `${(c.revenue / maxCat) * 100}%` : "0%",
                          // Never cycle the categorical slots: past the sixth, a row
                          // is "other" and wears the neutral ink instead of a repeat hue.
                          backgroundColor: i < P.cat.length ? P.cat[i] : P.neutral,
                          transitionDelay: `${i * 55}ms`,
                        }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          ) : <Blank h={230} text="No category revenue yet" />}
        </Card>
      </div>
      </Defer>

      <Defer h={280}>
      {/* ── What went wrong + standouts ────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card glass title="What went wrong" sub={`Losses, refunds and deals that fell through in ${rangeLabel}`}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Stat label="Fell through" value={String(lost)} color={lost > 0 ? CLR.rose : undefined}
              hint="invoices voided" />
            <Stat label="Closed at a loss" value={String(range.loss_deals)}
              color={range.loss_deals > 0 ? CLR.rose : undefined}
              hint={range.loss_total < 0 ? signed(range.loss_total) : "none"} />
            <Stat label="Refunded" value={signed(-range.refunded_in_range)}
              color={range.refunded_in_range > 0 ? CLR.rose : undefined}
              hint={`${range.refunded_deals} deal${range.refunded_deals !== 1 ? "s" : ""}`} />
            <Stat label="Still owed back" value={fmtAmount(stats.refund_owed_remaining)}
              color={stats.refund_owed_remaining > 0 ? CLR.amber : undefined}
              hint="promised, not yet sent" />
          </div>
          <p className="text-[11.5px] text-muted mt-5">
            {lost + range.loss_deals + range.refunded_deals === 0
              ? `Nothing was lost, refunded or closed below cost in ${rangeLabel}.`
              : `Lost deals are invoices voided in ${rangeLabel}; a loss is a deal whose profit went negative after refunds.`}
          </p>
        </Card>

        <Card glass title="Standouts" sub={`The extremes of ${rangeLabel}`}>
          <div className="space-y-3">
            <Highlight
              label="Best margin"
              name={range.best_margin_deal?.title ?? null}
              sub={range.best_margin_deal ? range.best_margin_deal.client_name : null}
              value={range.best_margin_deal ? `${range.best_margin_deal.margin_pct.toFixed(1)}%` : null}
              valueColor={CLR.emerald}
              amount={range.best_margin_deal ? signed(range.best_margin_deal.net_profit) : null}
            />
            <Highlight
              label="Worst margin"
              name={range.worst_margin_deal?.title ?? null}
              sub={range.worst_margin_deal ? range.worst_margin_deal.client_name : null}
              value={range.worst_margin_deal ? `${range.worst_margin_deal.margin_pct.toFixed(1)}%` : null}
              valueColor={(range.worst_margin_deal?.margin_pct ?? 0) < 0 ? CLR.rose : CLR.amber}
              amount={range.worst_margin_deal ? signed(range.worst_margin_deal.net_profit) : null}
            />
            <Highlight
              label="Biggest invoice"
              name={range.biggest_invoice?.number ?? null}
              sub={range.biggest_invoice?.client_name ?? null}
              value={range.biggest_invoice ? fmtAmount(range.biggest_invoice.total) : null}
              valueColor={undefined}
              amount={null}
            />
          </div>
        </Card>
      </div>
      </Defer>

      <Defer h={300}>
      {/* ── Client mix + invoice status ────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Client mix" sub={`${totalCl} client${totalCl !== 1 ? "s" : ""} by tier · all time`}>
          {totalCl > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-5 items-center">
              <div className="min-w-0">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => ({ name: TIER_NAME[t], value: tierMap[t] }))}
                      dataKey="value" nameKey="name" cx="50%" cy="50%"
                      innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none" {...STILL}>
                      {TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => (
                        <Cell key={t} fill={TIER_CLR[t]} />
                      ))}
                    </Pie>
                    <Tooltip {...TT} formatter={(v: any, n: any) => [`${v} client${v !== 1 ? "s" : ""}`, n]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="min-w-0">
                {TIER_ORDER.map((t) => {
                  const n = tierMap[t] || 0;
                  if (!n) return null;
                  return (
                    <div key={t} className="flex items-center justify-between gap-3 py-2 border-b border-line-2 last:border-0 min-w-0">
                      <TierBadge tier={t} />
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-[11px] text-muted tabular-nums w-11 text-right">
                          {((n / totalCl) * 100).toFixed(1)}%
                        </span>
                        <span className="text-[13px] font-semibold text-ink tabular-nums w-6 text-right">{n}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : <Blank h={200} text="No clients yet" />}
        </Card>

        <Card title="Invoice status" sub={`${stats.invoices} invoices · all time`}>
          {stats.invoice_status_breakdown.length > 0 ? (
            <div className="space-y-4">
              {stats.invoice_status_breakdown.map((s, i) => {
                const clr = P.STATUS[s.status] ?? P.neutral;
                const pct = totalSV > 0 ? (s.total / totalSV) * 100 : 0;
                return (
                  <div key={s.status} className="min-w-0">
                    <div className="flex items-center justify-between gap-3 mb-1.5 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: clr }} />
                        <span className="text-[12px] text-ink-2 capitalize truncate">{s.status.replace("_", " ")}</span>
                        <StatusPill>{s.count}</StatusPill>
                      </div>
                      <span className="text-[12px] font-semibold text-ink tabular-nums flex-shrink-0">
                        {fmtAmount(s.total)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{ width: bars ? `${pct}%` : "0%", backgroundColor: clr, transitionDelay: `${i * 75}ms` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Blank h={200} text="No invoices yet" />}
        </Card>
      </div>
      </Defer>

      <Defer h={300}>
      {/* ── Cash position + financial summary ──────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card glass title="Cash position" sub="Live from Financials · not affected by the date range">
          {money ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <span className="text-[12.5px] font-medium text-muted">Free cash</span>
                <span className="text-[24px] font-bold tabular-nums leading-none"
                  style={{ color: money.free_cash >= 0 ? CLR.emerald : CLR.rose }}>
                  {signed(money.free_cash)}
                </span>
              </div>
              <div className="border-t border-line-2 pt-3 space-y-2">
                {[
                  { label: "Bank balance",      v: money.bank_balance,        out: false },
                  { label: "Credit card owed",  v: money.credit_card_balance, out: true },
                  { label: "Supplier payables", v: money.supplier_payables,   out: true },
                  { label: "Refund liability",  v: money.refund_liability,    out: true },
                  { label: "Cash floor",        v: money.cash_floor,          out: true },
                  { label: "Loans outstanding", v: money.loan_outstanding,    out: true },
                ].filter((r) => r.v > 0.005 || r.label === "Bank balance").map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3 text-[12.5px] min-w-0">
                    <span className="text-ink-2 truncate min-w-0">{r.label}</span>
                    <span className={`tabular-nums font-medium flex-shrink-0 ${r.out ? "text-danger-ink" : "text-success-ink"}`}>
                      {r.out ? "−" : ""}{fmtAmount(r.v)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : <Blank h={200} text="Connect a bank in Financials to see cash position" />}
        </Card>

        <Card glass title="Financial summary" sub={`Completed deals · ${rangeLabel}`}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { label: "Revenue",             value: fmtAmount(range.total_revenue) },
              { label: "Total cost",          value: fmtAmount(range.total_cost) },
              { label: "Net profit",          value: signed(range.total_profit),
                color: range.total_profit >= 0 ? CLR.emerald : CLR.rose },
              { label: "Margin",              value: `${range.avg_margin.toFixed(1)}%` },
              { label: "Shipping",            value: fmtAmount(range.total_shipping) },
              { label: "Bank and wire fees",  value: fmtAmount(range.total_fees) },
              { label: "True net",            value: signed(range.true_net),
                color: range.true_net >= 0 ? CLR.emerald : CLR.rose },
              { label: "Outstanding",         value: fmtAmount(stats.outstanding), color: CLR.amber },
              { label: "Open closeouts",      value: String(stats.incomplete_shipping) },
            ].map((item) => (
              <Stat key={item.label} label={item.label} value={item.value} color={item.color} size="md" />
            ))}
          </div>
        </Card>
      </div>
      </Defer>

      <Defer h={320}>
      {/* ── Month by month ─────────────────────────────────────── */}
      <Card title="Month by month" sub="Every month with a closed deal or an overhead payment">
        {trend.length > 0 ? (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead>
                <tr className="text-[11px] text-muted border-b border-line">
                  <th className="text-left font-medium py-2 pr-3">Month</th>
                  <th className="text-right font-medium py-2 px-3">Deals</th>
                  <th className="text-right font-medium py-2 px-3">Revenue</th>
                  <th className="text-right font-medium py-2 px-3">Profit</th>
                  <th className="text-right font-medium py-2 px-3">Margin</th>
                  <th className="text-right font-medium py-2 px-3">Shipping</th>
                  <th className="text-right font-medium py-2 px-3">Fees</th>
                  <th className="text-right font-medium py-2 pl-3">True net</th>
                </tr>
              </thead>
              <tbody>
                {[...trend].reverse().map((m) => (
                  <tr key={m.month} className="border-b border-line-2 last:border-0 hover:bg-surface-2 transition-colors">
                    <td className="py-2.5 pr-3 text-ink whitespace-nowrap">
                      {m.label}
                      {m.projected && <span className="ml-2"><StatusPill>In progress</StatusPill></span>}
                    </td>
                    <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums">{m.count}</td>
                    <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums">{fmtAmount(m.revenue)}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-medium"
                      style={{ color: m.profit >= 0 ? CLR.emerald : CLR.rose }}>{signed(m.profit)}</td>
                    <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums">{m.margin_pct.toFixed(1)}%</td>
                    <td className="py-2.5 px-3 text-right text-muted tabular-nums">{fmtAmount(m.shipping)}</td>
                    <td className="py-2.5 px-3 text-right text-muted tabular-nums">{fmtAmount(m.fees)}</td>
                    <td className="py-2.5 pl-3 text-right tabular-nums font-medium"
                      style={{ color: m.true_net >= 0 ? CLR.emerald : CLR.rose }}>{signed(m.true_net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Blank h={160} text="No months to show for this range" />}
      </Card>
      </Defer>

      <Defer h={320}>
      {/* ── What people bought ─────────────────────────────────── */}
      <Card
        title="What people bought"
        sub={range.completed_deals_capped
          ? `The ${range.completed_deals.length} most recent of ${range.deal_count} closed deals`
          : `${range.completed_deals.length} closed deal${range.completed_deals.length !== 1 ? "s" : ""} in ${rangeLabel}`}
      >
        {range.completed_deals.length > 0 ? (
          <div className="overflow-x-auto -mx-5 px-5 max-h-[520px] overflow-y-auto">
            <table className="w-full min-w-[760px] text-[12.5px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-[11px] text-muted border-b border-line">
                  <th className="text-left font-medium py-2 pr-3">Closed</th>
                  <th className="text-left font-medium py-2 px-3">Buyer</th>
                  <th className="text-left font-medium py-2 px-3">Products</th>
                  <th className="text-left font-medium py-2 px-3">Supplier</th>
                  <th className="text-right font-medium py-2 px-3">Revenue</th>
                  <th className="text-right font-medium py-2 pl-3">Profit</th>
                </tr>
              </thead>
              <tbody>
                {range.completed_deals.map((d) => (
                  <tr key={d.deal_flow_id} className="border-b border-line-2 last:border-0 hover:bg-surface-2 transition-colors align-top">
                    <td className="py-2.5 pr-3 text-muted tabular-nums whitespace-nowrap">{d.completed_on}</td>
                    <td className="py-2.5 px-3 text-ink min-w-0">
                      <div className="truncate max-w-[180px]">{d.client_name}</div>
                      <div className="text-[10.5px] text-faint truncate max-w-[180px]">{d.invoice_number}</div>
                    </td>
                    <td className="py-2.5 px-3 text-ink-2 min-w-0">
                      {d.products.length > 0 ? (
                        <div className="max-w-[300px]">
                          {d.products.slice(0, 2).map((p, i) => (
                            <div key={i} className="truncate">
                              {p.name}{p.qty > 1 ? ` ×${p.qty}` : ""}
                            </div>
                          ))}
                          {d.products.length > 2 && (
                            <div className="text-[10.5px] text-faint">+{d.products.length - 2} more</div>
                          )}
                        </div>
                      ) : <span className="text-faint">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-ink-2 min-w-0">
                      <div className="truncate max-w-[160px]">{d.suppliers.join(", ") || "—"}</div>
                    </td>
                    <td className="py-2.5 px-3 text-right text-ink-2 tabular-nums whitespace-nowrap">{fmtAmount(d.revenue)}</td>
                    <td className="py-2.5 pl-3 text-right tabular-nums font-medium whitespace-nowrap"
                      style={{ color: d.net_profit >= 0 ? CLR.emerald : CLR.rose }}>{signed(d.net_profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Blank h={160} text="Nothing closed in this range" />}
      </Card>
      </Defer>

    </div>
  );
}

// ─── Shared pieces ────────────────────────────────────────────────

// The one section shell. `glass` opts a panel into the liquid-glass recipe (.glass in
// index.css: translucent surface, 20px backdrop blur, specular top hairline, soft wide
// shadow, no hard border). It is OPT-IN, not the default, because glass must never sit
// behind a chart's plotting area or a dense table — blur under data costs legibility and
// costs paint time, and paint time is half of what "slow and laggy" was. Panels that
// hold charts or tables stay on the solid surface token.
function Card({ title, sub, right, children, glass }: {
  title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; glass?: boolean;
}) {
  return (
    <section className={`ring-1 rounded-[18px] p-5 min-w-0 ${
      glass ? "glass ring-line/60" : "bg-surface ring-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-5">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
          {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
        </div>
        {right && <div className="min-w-0">{right}</div>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, hint, color, accentClass }: {
  label: string; value: string; hint?: string; color?: string; accentClass?: string;
}) {
  return (
    <div className="bg-surface/70 px-4 py-5 min-w-0">
      <div className="text-[12.5px] font-medium text-muted truncate">{label}</div>
      {/* A six-figure amount needs ~152px at 24px; a tile is narrower than that once the
          216px sidebar takes its cut, and `truncate` turned the money into an ellipsis.
          The figure steps up with the tile instead of being cut off. */}
      <div className={`text-[19px] sm:text-[21px] 2xl:text-[24px] font-bold tabular-nums mt-1.5 leading-none tracking-tight truncate ${accentClass ?? "text-ink"}`}
        style={color ? { color } : undefined}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-faint mt-1.5 truncate">{hint}</div>}
    </div>
  );
}

function Stat({ label, value, hint, color, swatch, size = "sm" }: {
  label: string; value: string; hint?: string; color?: string; swatch?: string; size?: "sm" | "md";
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {swatch && <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: swatch }} />}
        <span className="text-[12.5px] font-medium text-muted truncate">{label}</span>
      </div>
      <div className={`${size === "md" ? "text-[20px]" : "text-[18px]"} font-bold tabular-nums mt-1.5 leading-none truncate`}
        style={{ color: color ?? "rgb(var(--c-ink))" }}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-faint mt-1.5 truncate tabular-nums">{hint}</div>}
    </div>
  );
}

// A concentration reading is a risk statement: past its threshold it wears the warning
// ink, so "the top buyer is 61% of revenue" is not something you have to notice yourself.
function Concentration({ label, pct, warnAt, unit, P }: {
  label: string; pct: number; warnAt: number; unit: string; P: ReturnType<typeof usePalette>;
}) {
  const hot = pct >= warnAt;
  return (
    <div className="rounded-[14px] glass ring-1 ring-line/50 px-3.5 py-3 min-w-0">
      <div className="text-[11px] text-muted truncate">{label}</div>
      <div className="text-[19px] font-bold tabular-nums mt-1 leading-none"
        style={{ color: hot ? P.CLR.amber : "rgb(var(--c-ink))" }}>
        {pct.toFixed(0)}%
      </div>
      <div className="text-[10.5px] text-faint mt-1">{unit}</div>
    </div>
  );
}

// A 100% share bar. Anything past the named parts folds into one "Other" segment rather
// than taking a seventh hue — the categorical palette is six fixed slots, never cycled.
function ShareBar({ parts, total, otherColor, animate }: {
  parts: { name: string; value: number; color: string }[]; total: number; otherColor: string; animate: boolean;
}) {
  const named = parts.reduce((s, p) => s + p.value, 0);
  const other = Math.max(total - named, 0);
  const segs = other > 0.005 ? [...parts, { name: "Other", value: other, color: otherColor }] : parts;
  if (total <= 0) return null;
  return (
    <div className="h-2.5 bg-surface-3 rounded-full overflow-hidden flex gap-px">
      {segs.map((s, i) => (
        <div key={s.name} className="h-full transition-all duration-700 ease-out first:rounded-l-full last:rounded-r-full"
          title={`${s.name} · ${((s.value / total) * 100).toFixed(1)}%`}
          style={{
            width: animate ? `${(s.value / total) * 100}%` : "0%",
            backgroundColor: s.color,
            transitionDelay: `${i * 70}ms`,
          }} />
      ))}
    </div>
  );
}

function Highlight({ label, name, sub, value, valueColor, amount }: {
  label: string; name: string | null; sub: string | null; value: string | null;
  valueColor?: string; amount: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-line-2 last:border-0 min-w-0">
      <div className="min-w-0">
        <div className="text-[11px] text-muted">{label}</div>
        {name ? (
          <>
            <div className="text-[13px] font-medium text-ink truncate">{name}</div>
            {sub && <div className="text-[11px] text-faint truncate">{sub}</div>}
          </>
        ) : (
          <div className="text-[12.5px] text-faint mt-0.5">Nothing in this range</div>
        )}
      </div>
      {value && (
        <div className="text-right flex-shrink-0">
          <div className="text-[16px] font-bold tabular-nums leading-none"
            style={{ color: valueColor ?? "rgb(var(--c-ink))" }}>{value}</div>
          {amount && <div className="text-[11px] text-muted tabular-nums mt-1">{amount}</div>}
        </div>
      )}
    </div>
  );
}

// ─── R-317 bridge ─────────────────────────────────────────────────
// A waterfall read as a statement rather than drawn as a chart: label left, amount
// right, tabular figures, and a hairline above every line that has to tie.
//
// Amounts arrive already signed — a subtract row is negative in the payload — so the
// list never re-decides what a line means. Colour follows the rest of the screen: money
// arriving wears the muted emerald ink, money leaving is plain ink, and only a subtotal
// that is itself negative goes rose.
//
// The drift note is the reason this section exists. A subtotal is the figure read from
// the book; `running` is what the lines above it add up to. When they disagree the list
// keeps showing the figure it read and says so underneath, in rose.
function BridgeList({ rows, CLR }: { rows: ReconRow[]; CLR: { emerald: string; rose: string } }) {
  return (
    <div className="min-w-0">
      {rows.map((r) => {
        const heavy = r.kind === "subtotal" || r.kind === "total";
        const drift = r.drift ?? 0;
        const lightTone =
          r.kind === "residual" ? (Math.abs(r.amount) < 0.005 ? "text-faint" : "text-danger-ink")
          : r.amount >= 0 ? "text-success-ink" : "text-ink-2";
        return (
          <div key={r.label} className={`min-w-0 ${heavy ? "border-t border-line mt-2 pt-2" : ""}`}>
            <div className="flex items-baseline justify-between gap-3 min-w-0 py-1">
              <div className="min-w-0">
                <div className={`truncate ${heavy ? "text-[13px] font-semibold text-ink" : "text-[12.5px] text-ink-2"}`}>
                  {r.label}
                </div>
                {r.hint && <div className="text-[10.5px] text-faint truncate">{r.hint}</div>}
              </div>
              <span
                className={`tabular-nums flex-shrink-0 ${heavy ? "text-[16px] font-bold" : `text-[13px] font-medium ${lightTone}`}`}
                style={heavy ? { color: r.amount >= 0 ? CLR.emerald : CLR.rose } : undefined}
              >
                {signed(r.amount)}
              </span>
            </div>
            {Math.abs(drift) >= 0.005 && (
              <p className="text-[11px] text-danger-ink pb-1.5">
                Does not tie — the lines above come to {signed(r.running ?? 0)}, a difference
                of {signed(drift)}.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Whether a bank column ties to its ledger figure, and by how much when it does not.
// It always renders: "no note" and "ties to the cent" must not look the same.
function Gap({ label, gap, against, because, CLR }: {
  label: string; gap: number; against: string; because?: string; CLR: { rose: string };
}) {
  if (Math.abs(gap) < 0.005) {
    return <p className="text-muted">{label} matches {against} to the cent.</p>;
  }
  return (
    <p className={because ? "text-muted" : undefined} style={because ? undefined : { color: CLR.rose }}>
      {label} is {fmtAmount(Math.abs(gap))} {gap > 0 ? "more than" : "less than"} {against}
      {because ? ` — ${because}` : ""}.
    </p>
  );
}

// ─── R-319 pace summary ───────────────────────────────────────────
// The sentence is the answer; the chart is the evidence. Jack asked to know "how well
// we are doing so far in the current month" — that is a claim in words, with the two
// comparisons that make it mean something, and the pace the month is on. Ahead reads
// green, behind reads red, on Apple's accessible hues.
function PaceSummary({ pace, metric, CLR }: {
  pace: AnalyticsPace; metric: "revenue" | "profit"; CLR: { emerald: string; rose: string };
}) {
  const now  = metric === "revenue" ? pace.revenue_so_far      : pace.profit_so_far;
  const prev = metric === "revenue" ? pace.prev_at_day_revenue : pace.prev_at_day_profit;
  const avg  = metric === "revenue" ? pace.avg_at_day_revenue  : pace.avg_at_day_profit;
  const proj = metric === "revenue" ? pace.projected_revenue   : pace.projected_profit;
  const word = metric === "revenue" ? "Revenue" : "Profit";

  // A delta phrase: the amount, then ahead or behind, coloured by which it is.
  const Delta = ({ v }: { v: number }) => (
    <b className="font-semibold tabular-nums" style={{ color: v >= 0 ? CLR.emerald : CLR.rose }}>
      {fmtAmount(Math.abs(v))} {v >= 0 ? "ahead" : "behind"}
    </b>
  );

  return (
    <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
      <b className="text-ink font-semibold">Day {pace.day_of_month}</b> of{" "}
      {pace.days_in_month}. {word} is{" "}
      <b className="text-ink font-semibold tabular-nums">{signed(now)}</b>
      {pace.prior_count > 0 ? (
        <>
          , which is <Delta v={now - prev} /> of where {longMonth(pace.prev_month)} stood on
          day {pace.day_of_month}, and <Delta v={now - avg} /> of the{" "}
          {pace.prior_count}-month average for this day.
        </>
      ) : <> — there is no earlier month to compare it against yet.</>}
      {" "}At this pace the month finishes near{" "}
      <b className="text-ink font-semibold tabular-nums">{signed(proj)}</b>.
    </p>
  );
}

function Legend({ color, label, dashed, onClick, active }: {
  color: string; label: string; dashed?: boolean; onClick?: () => void; active?: boolean;
}) {
  const body = (
    <>
      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
        style={dashed
          ? { border: `1.5px dashed ${color}` }
          : { backgroundColor: color }} />
      <span className={`text-[11px] whitespace-nowrap ${active ? "text-ink font-medium" : "text-muted"}`}>{label}</span>
    </>
  );
  // A legend that picks a month is a control, so it is a real button — focusable,
  // and it says which month is currently singled out.
  if (!onClick) return <div className="flex items-center gap-1.5 flex-shrink-0">{body}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={!!active}
      className={`flex items-center gap-1.5 flex-shrink-0 rounded-md px-2 h-6 -mx-1 transition-colors duration-[130ms] ${
        active ? "bg-surface-2 ring-1 ring-line" : "hover:bg-surface-2"}`}>
      {body}
    </button>
  );
}

function Blank({ h = 160, text = "No data yet" }: { h?: number; text?: string }) {
  return (
    <div className="flex items-center justify-center text-center text-[12px] text-faint px-4"
      style={{ height: h }}>
      {text}
    </div>
  );
}
