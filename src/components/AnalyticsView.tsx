import { useEffect, useRef, useState } from "react";
import { api, DashboardStats, FinancialsOverview } from "../lib/api";
import { fmtAmount, localDay, localMonth, parseLocalDay } from "../lib/format";
import { RefreshCw, FileDown, TrendingUp, TrendingDown } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import TierBadge from "./TierBadge";
import { toast } from "./Toast";

// ─── Theme-aware chart palette ────────────────────────────────────
// Charts read the same brand tokens as the rest of the app, so they stay
// cohesive and adapt to light/dark: one accent + semantic green/red + neutral.
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgbVar = (n: string) => `rgb(${cssVar(n)})`;

// Refined, muted tier swatches — premium metallics, not neon.
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

// Designed series colors — fixed hues so charts stay vivid in light/dark/matte
// instead of greying out with the theme accent. Revenue = indigo, profit = emerald.
const C_REVENUE = "#6366F1";

const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect"];

// Resolve brand tokens to concrete chart colors; re-render on light/dark flip.
function usePalette() {
  const [, force] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => force((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  const accent  = rgbVar("--c-accent");
  const success = rgbVar("--c-success");
  const danger  = rgbVar("--c-danger");
  const warning = rgbVar("--c-warning");
  const info    = rgbVar("--c-info");
  const neutral = rgbVar("--c-faint");
  // Data bars are a neutral ink tone (inverts in dark), not the brand accent —
  // keeps charts matte; colour is reserved for profit (green) / loss (red).
  const bar     = rgbVar("--c-ink-2");
  return {
    accent, success, danger, warning, info, neutral, bar,
    grid: rgbVar("--c-line"),
    CLR: { indigo: accent, emerald: success, rose: danger, amber: warning, sky: info, slate: neutral },
    STATUS: { paid: success, sent: info, overdue: danger, draft: neutral, void: danger } as Record<string, string>,
    TT: {
      contentStyle: {
        background: rgbVar("--c-surface"),
        border: `1px solid ${rgbVar("--c-line")}`,
        borderRadius: 10,
        color: rgbVar("--c-ink"),
        fontSize: 12,
        padding: "9px 13px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
      },
      cursor: { fill: `rgb(${cssVar("--c-accent")} / 0.06)` },
    },
    AX: { fontSize: 10, fill: `rgb(${cssVar("--c-muted")})` },
  };
}

// ─── Count-up hook ────────────────────────────────────────────────
function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(0);
  const raf = useRef<number>(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (target === 0) { setVal(0); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      setVal(target * (1 - Math.pow(1 - p, 4)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setVal(target);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);
  return val;
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

// ─── Main view ───────────────────────────────────────────────────
export default function AnalyticsView() {
  const P = usePalette();
  const CLR = P.CLR;
  const STATUS_CLR = P.STATUS;
  const TT = P.TT;
  const AX = P.AX;
  const indigo = C_REVENUE;  // revenue / category bars → designed indigo (vivid in matte, not the grey accent)
  const [stats,     setStats]     = useState<DashboardStats | null>(null);
  const [rangeData, setRangeData] = useState<any | null>(null);
  const [tiers,     setTiers]     = useState<any[]>([]);
  const [money,     setMoney]     = useState<FinancialsOverview | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [bars,      setBars]      = useState(false);
  const [preset,    setPreset]    = useState<string>("All time");
  const [startDate, setStartDate] = useState("");
  const [endDate,   setEndDate]   = useState("");

  // All hooks unconditionally before early returns
  const displayStats = rangeData ?? stats;
  const aRevenue     = useCountUp(displayStats?.total_revenue ?? displayStats?.paid_ytd ?? 0);
  const aProfit      = useCountUp(displayStats?.total_profit  ?? 0);
  const aMargin      = useCountUp(displayStats?.avg_margin    ?? 0);
  const aOutstanding = useCountUp(stats?.outstanding          ?? 0, 750);
  const aInvoices    = useCountUp(stats?.invoices             ?? 0, 700);

  const loadRange = async (start: string, end: string) => {
    setBars(false);
    try {
      const r = await api.getAnalyticsRange(start, end);
      setRangeData(r);
    } catch {}
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
        api.getAnalyticsRange("", ""), // all-time by default
      ]);
      setStats(s);
      setTiers(t);
      setRangeData(r);
      // Cash position is secondary — load separately so a Plaid/overview hiccup
      // never blanks the analytics page.
      api.financialsOverview().then(setMoney).catch(() => {});
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!loading && stats) setTimeout(() => setBars(true), 120);
  }, [loading, stats]);

  // Skeleton mirrors the real layout: header, hero row, big chart, chart pair.
  if (loading) return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-6 w-28 bg-surface-2 rounded-md animate-pulse" />
          <div className="h-3.5 w-44 bg-surface-2 rounded animate-pulse mt-2" />
        </div>
        <div className="h-8 w-64 bg-surface-2 rounded-lg animate-pulse" />
      </div>
      <div className="h-[108px] bg-surface-2 rounded-2xl animate-pulse" />
      <div className="h-[300px] bg-surface-2 rounded-xl animate-pulse" />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="h-56 bg-surface-2 rounded-xl animate-pulse" />
        <div className="h-56 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    </div>
  );
  if (!stats) return (
    <div className="text-center py-32 text-[13px] text-faint">No data yet</div>
  );

  // ── Derived ───────────────────────────────────────────────────
  const monthlySource = rangeData?.monthly_profit ?? stats.monthly_profit;
  const monthly = monthlySource.map((m: any) => ({
    ...m,
    // R-159: local parse — new Date("YYYY-MM-01") is UTC midnight and labeled
    // every bucket one month early when rendered in Central.
    month: parseLocalDay(m.month).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
  }));

  // Month-over-month movement for the lead stats — derived from data we already
  // have (monthly_profit). The in-progress current month is skipped: comparing a
  // half-finished month against a complete one always reads as a fake drop.
  const curMonth = localMonth();
  const momSource = monthlySource.filter((m: any) => m.month !== curMonth);
  const momLast = momSource.length > 1 ? momSource[momSource.length - 1] : null;
  const momPrev = momSource.length > 1 ? momSource[momSource.length - 2] : null;

  const tierMap  = tiers.reduce((acc: Record<string, number>, t: any) => {
    acc[t.tier] = (acc[t.tier] || 0) + 1; return acc;
  }, {});
  const totalCl  = tiers.length;
  const maxSpend = Math.max(...stats.top_spenders.map((c) => c.total_spent), 1);
  const totalSV  = stats.invoice_status_breakdown.reduce((s, x) => s + x.total, 0);
  const cats     = stats.category_breakdown.filter((c) => c.client_count > 0);
  const maxCat   = Math.max(...cats.map((c) => c.revenue), 1);

  const handleExportAnalytics = async () => {
    const path = await saveDialog({ filters: [{ name: "Excel", extensions: ["xlsx"] }], defaultPath: "analytics.xlsx" });
    if (!path) return;
    await api.exportAnalyticsXlsx(path as string);
    toast("Exported analytics to Excel");
  };

  // ── Layout ───────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Analytics</h2>
          <p className="text-[12px] text-muted mt-0.5">Business performance overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Preset pills */}
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
                preset === p
                  ? "bg-accent text-on-accent"
                  : "bg-surface border border-line text-muted hover:border-accent hover:text-accent"
              }`}
            >
              {p}
            </button>
          ))}
          {/* Custom range */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border border-line h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <span className="text-[11px] text-muted">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border border-line h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <button
              onClick={applyCustomRange}
              className="px-3 h-8 bg-surface border border-line rounded-lg text-[12px] text-muted hover:border-accent hover:text-accent transition-colors"
            >
              Apply
            </button>
          </div>
          <button onClick={load}
            className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                       px-2.5 h-8 rounded-lg hover:bg-surface-3 transition-colors border border-line">
            <RefreshCw size={13} /> Refresh
          </button>
          <button onClick={handleExportAnalytics}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium transition-colors">
            <FileDown size={13} /> Export
          </button>
        </div>
      </div>

      {/* ── Hero: the headline read for the selected range ─────────
          One calm divided row (mirrors the dashboard hero) — revenue
          leads, profit/margin/outstanding read left to right.
      ─────────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-2xl overflow-hidden">
        <div className="grid grid-cols-2 xl:grid-cols-4 divide-x divide-line">
          <div className="p-5">
            <div className="text-[12.5px] font-medium text-muted">
              Revenue · {preset === "Custom" ? "custom range" : preset.toLowerCase()}
            </div>
            <div className="flex items-end gap-2.5 mt-1.5">
              <span className="text-[26px] font-bold text-accent tabular-nums leading-none tracking-tight">
                {fmtAmount(aRevenue)}
              </span>
              {momLast && momPrev && <MomChip now={momLast.revenue} prev={momPrev.revenue} />}
            </div>
            <div className="text-[11px] text-faint mt-1.5">closed deal revenue</div>
          </div>
          <div className="p-5">
            <div className="text-[12.5px] font-medium text-muted">Net profit</div>
            <div className="flex items-end gap-2.5 mt-1.5">
              <span className="text-[26px] font-bold tabular-nums leading-none"
                style={{ color: (displayStats?.total_profit ?? 0) >= 0 ? CLR.emerald : CLR.rose }}>
                {fmtAmount(aProfit)}
              </span>
              {momLast && momPrev && <MomChip now={momLast.profit} prev={momPrev.profit} />}
            </div>
            <div className="text-[11px] text-faint mt-1.5">after all costs</div>
          </div>
          <div className="p-5 border-t border-line lg:border-t-0">
            <div className="text-[12.5px] font-medium text-muted">Avg margin</div>
            <div className="text-[26px] font-bold text-ink tabular-nums mt-1.5 leading-none">{aMargin.toFixed(1)}%</div>
            <div className="text-[11px] text-faint mt-1.5">across closed deals</div>
          </div>
          <div className="p-5 border-t border-line lg:border-t-0">
            <div className="text-[12.5px] font-medium text-muted">Outstanding</div>
            <div className="text-[26px] font-bold tabular-nums mt-1.5 leading-none"
              style={{ color: stats.outstanding > 0 ? CLR.amber : "var(--t-tx1)" }}>
              {fmtAmount(aOutstanding)}
            </div>
            <div className="text-[11px] text-faint mt-1.5">awaiting payment</div>
          </div>
        </div>

        {/* Lead insight: the revenue/profit story lives inside the same card. */}
        <div className="px-5 pb-5 pt-4 border-t border-line-2">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">Monthly revenue vs profit</h3>
            <p className="text-[11px] text-muted mt-0.5">
              {monthly.length > 0 ? `Last ${monthly.length} month${monthly.length !== 1 ? "s" : ""}` : "No data"}
            </p>
          </div>
          <div className="flex items-center gap-5 mt-0.5">
            <Legend color={indigo}  label="Revenue" />
            <Legend color={CLR.emerald} label="Profit"  />
          </div>
        </div>

        {monthly.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthly} barCategoryGap="38%" barGap={3}
                      margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
              <XAxis dataKey="month" tick={AX} axisLine={false} tickLine={false} />
              <YAxis tick={AX} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => fmtAmount(Number(v))} {...TT} />
              <Bar dataKey="revenue" name="Revenue" fill={indigo}
                radius={[4, 4, 0, 0]} maxBarSize={40} />
              <Bar dataKey="profit"  name="Profit"
                radius={[4, 4, 0, 0]} maxBarSize={40}>
                {monthly.map((m: any, i: number) => (
                  <Cell key={i} fill={m.profit >= 0 ? CLR.emerald : CLR.rose} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : <Blank h={300} />}
        </div>
      </div>

      {/* ── Deal outcomes: won / lost / win rate / refunded, range-aware ── */}
      {(() => {
        const won      = rangeData?.deal_count ?? stats.deals_won_all ?? 0;
        const lost     = rangeData?.deals_lost ?? stats.deals_lost_all ?? 0;
        const winRate  = won + lost > 0 ? (won / (won + lost)) * 100 : 0;
        const refunded = rangeData?.refunded_in_range ?? stats.refunded_total ?? 0;
        return (
          <div className="bg-surface border border-line rounded-2xl overflow-hidden">
            <div className="grid grid-cols-2 xl:grid-cols-4 divide-x divide-line">
              <div className="p-5">
                <div className="text-[12.5px] font-medium text-muted">Deals won</div>
                <div className="text-[26px] font-bold text-ink tabular-nums mt-1.5 leading-none">{won}</div>
                <div className="text-[11px] text-faint mt-1.5">completed in range</div>
              </div>
              <div className="p-5">
                <div className="text-[12.5px] font-medium text-muted">Deals lost</div>
                <div className="text-[26px] font-bold tabular-nums mt-1.5 leading-none"
                  style={{ color: lost > 0 ? CLR.rose : "var(--t-tx1)" }}>{lost}</div>
                <div className="text-[11px] text-faint mt-1.5">fell through</div>
              </div>
              <div className="p-5 border-t border-line lg:border-t-0">
                <div className="text-[12.5px] font-medium text-muted">Win rate</div>
                <div className="text-[26px] font-bold tabular-nums mt-1.5 leading-none"
                  style={{ color: winRate >= 60 ? CLR.emerald : winRate >= 40 ? CLR.amber : CLR.rose }}>
                  {won + lost > 0 ? `${winRate.toFixed(0)}%` : "—"}
                </div>
                <div className="text-[11px] text-faint mt-1.5">won vs fell through</div>
              </div>
              <div className="p-5 border-t border-line lg:border-t-0">
                <div className="text-[12.5px] font-medium text-muted">Refunded</div>
                <div className="text-[26px] font-bold tabular-nums mt-1.5 leading-none"
                  style={{ color: refunded > 0 ? CLR.rose : "var(--t-tx1)" }}>
                  {refunded > 0 ? `−${fmtAmount(refunded)}` : fmtAmount(0)}
                </div>
                <div className="text-[11px] text-faint mt-1.5">
                  {stats.refund_owed_remaining > 0
                    ? `${fmtAmount(stats.refund_owed_remaining)} still owed back`
                    : "returned to customers"}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Row: Profit Trend (area) + Client Mix (donut) ──────────
          Two new chart *types* — an area trend + a donut — for variety
          beyond the bars/lists, with designed (theme-independent) colors.
      ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Profit Trend — area */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Profit trend</h3>
          <p className="text-[11px] text-muted mb-5">Net profit by month</p>
          {monthly.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={monthly} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="anProfitArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={CLR.emerald} stopOpacity={0.30} />
                    <stop offset="100%" stopColor={CLR.emerald} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke={P.grid} vertical={false} />
                <XAxis dataKey="month" tick={AX} axisLine={false} tickLine={false} />
                <YAxis tick={AX} axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: any) => fmtAmount(Number(v))} {...TT} />
                <Area type="monotone" dataKey="profit" stroke={CLR.emerald} strokeWidth={2.5}
                  fill="url(#anProfitArea)" isAnimationActive animationDuration={900} />
              </AreaChart>
            </ResponsiveContainer>
          ) : <Blank h={240} />}
        </div>

        {/* Client Mix — donut */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Client mix</h3>
          <p className="text-[11px] text-muted mb-5">Share of clients by tier</p>
          {totalCl > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => ({ name: TIER_NAME[t], value: tierMap[t] }))}
                  dataKey="value" nameKey="name" cx="50%" cy="50%"
                  innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none">
                  {TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => (
                    <Cell key={t} fill={TIER_CLR[t]} />
                  ))}
                </Pie>
                <Tooltip {...TT} formatter={(v: any, n: any) => [`${v} client${v !== 1 ? "s" : ""}`, n]} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Blank h={240} />}
        </div>
      </div>

      {/* ── Row: Invoice Status + Top Spenders ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Invoice Status */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Invoice status</h3>
          <p className="text-[11px] text-muted mb-5">{stats.invoices} total invoices</p>

          {stats.invoice_status_breakdown.length > 0 ? (
            <div className="space-y-4">
              {stats.invoice_status_breakdown.map((s, i) => {
                const clr = STATUS_CLR[s.status] ?? CLR.slate;
                const pct = totalSV > 0 ? (s.total / totalSV) * 100 : 0;
                return (
                  <div key={s.status}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: clr }} />
                        <span className="text-[12px] text-ink-2 capitalize">
                          {s.status.replace("_", " ")}
                        </span>
                        <span className="text-[10px] text-faint">({s.count})</span>
                      </div>
                      <span className="text-[12px] font-semibold text-ink tabular-nums">
                        {fmtAmount(s.total)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{
                          width: bars ? `${pct}%` : "0%",
                          backgroundColor: clr,
                          transitionDelay: `${i * 75}ms`,
                        }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Blank h={160} />}
        </div>

        {/* Top Spenders */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Top spenders</h3>
          <p className="text-[11px] text-muted mb-4">By total revenue collected</p>

          {stats.top_spenders.length > 0 ? (
            <div className="space-y-1">
              {stats.top_spenders.map((c, i) => (
                <div key={i} className="relative rounded-xl overflow-hidden">
                  {/* Proportional fill behind each row */}
                  <div className="absolute inset-y-0 left-0 rounded-xl transition-all duration-700 ease-out"
                    style={{
                      width: bars ? `${(c.total_spent / maxSpend) * 100}%` : "0%",
                      background: "rgb(var(--c-accent) / 0.06)",
                      transitionDelay: `${200 + i * 70}ms`,
                    }} />
                  <div className="relative flex items-center gap-3 px-4 py-3.5">
                    <span className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center
                                      justify-center text-[10px] font-bold text-white ${
                      i === 0 ? "bg-warning" :
                      i === 1 ? "bg-slate-400" :
                      i === 2 ? "bg-warning/70" : "bg-surface-3"
                    }`}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                      <div className="text-[11px] text-muted">
                        {c.invoice_count} invoice{c.invoice_count !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[13px] font-semibold text-ink tabular-nums">
                        {fmtAmount(c.total_spent)}
                      </div>
                      <div className={`text-[10px] tabular-nums ${
                        c.total_profit >= 0 ? "text-success-ink" : "text-danger-ink"
                      }`}>{fmtAmount(c.total_profit)} profit</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : <Blank h={160} />}
        </div>
      </div>

      {/* ── Row: Tier Distribution + Category ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Client Tiers */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Client tiers</h3>
          <p className="text-[11px] text-muted mb-5">{totalCl} clients</p>

          {totalCl > 0 ? (
            <>
              {/* Segmented pill */}
              <div className="h-2.5 bg-surface-3 rounded-full overflow-hidden flex mb-5">
                {TIER_ORDER.filter((t) => tierMap[t] > 0).map((t, i, arr) => (
                  <div key={t} className="h-full transition-all duration-700 ease-out"
                    style={{
                      width: bars ? `${(tierMap[t] / totalCl) * 100}%` : "0%",
                      backgroundColor: TIER_CLR[t],
                      transitionDelay: `${i * 80}ms`,
                    }} />
                ))}
              </div>

              <div>
                {TIER_ORDER.map((t, i) => {
                  const n = tierMap[t] || 0;
                  if (!n) return null;
                  return (
                    <div key={t} className="flex items-center justify-between py-2.5
                                             border-b border-line-2 last:border-0">
                      <TierBadge tier={t} />
                      <div className="flex items-center gap-4">
                        <div className="w-24 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700 ease-out"
                            style={{
                              width: bars ? `${(n / totalCl) * 100}%` : "0%",
                              backgroundColor: TIER_CLR[t],
                              transitionDelay: `${200 + i * 60}ms`,
                            }} />
                        </div>
                        <span className="text-[11px] text-muted w-9 text-right tabular-nums">
                          {((n / totalCl) * 100).toFixed(1)}%
                        </span>
                        <span className="text-[14px] font-bold text-ink tabular-nums w-5 text-right">
                          {n}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : <Blank h={160} />}
        </div>

        {/* Category breakdown */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Category breakdown</h3>
          <p className="text-[11px] text-muted mb-5">Revenue by client category</p>

          {cats.length > 0 ? (
            <div className="space-y-4 max-h-[280px] overflow-y-auto pr-1">
              {cats.map((c, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] font-medium text-ink-2 truncate max-w-[160px]">
                      {c.category}
                    </span>
                    <div className="flex items-center gap-2.5 ml-2 flex-shrink-0">
                      <span className="text-[11px] text-muted">
                        {c.client_count} client{c.client_count !== 1 ? "s" : ""}
                      </span>
                      {c.revenue > 0 && (
                        <span className="text-[12px] font-semibold text-ink tabular-nums">
                          {fmtAmount(c.revenue)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: c.revenue > 0 && bars ? `${(c.revenue / maxCat) * 100}%` : "0%",
                        backgroundColor: indigo,
                        transitionDelay: `${i * 55}ms`,
                      }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <Blank h={160} text="No category data" />}
        </div>
      </div>

      {/* ── Most Profitable + Financial summary ────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Most Profitable */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Most profitable</h3>
          <p className="text-[11px] text-muted mb-5">By net profit margin</p>

          {((rangeData?.top_clients_by_profit ?? stats.top_clients_by_profit) as any[]).length > 0 ? (
            <div>
              {((rangeData?.top_clients_by_profit ?? stats.top_clients_by_profit) as any[]).map((c: any, i: number) => (
                <div key={i} className="py-3 border-b border-line-2 last:border-0">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                      <div className="text-[11px] text-muted mt-0.5 tabular-nums">
                        {fmtAmount(c.total_revenue)} revenue
                      </div>
                    </div>
                    <div className="text-right ml-3 flex-shrink-0">
                      <div className={`text-[13px] font-semibold tabular-nums ${
                        c.total_profit >= 0 ? "text-success-ink" : "text-danger-ink"
                      }`}>{fmtAmount(c.total_profit)}</div>
                      <div className="text-[10px] text-muted mt-0.5">
                        {c.margin.toFixed(1)}% margin
                      </div>
                    </div>
                  </div>
                  <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: bars ? `${Math.min(Math.max(c.margin, 0), 100)}%` : "0%",
                        backgroundColor: c.total_profit >= 0 ? CLR.emerald : CLR.rose,
                        transitionDelay: `${150 + i * 55}ms`,
                      }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <Blank h={160} text="No profit data yet" />}
        </div>

        {/* Financial snapshot — same range-filtered deal source as the hero, so
            revenue − cost = profit holds inside one card (the old card mixed a
            YTD paid-invoice number with all-time costs from a different base). */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Financial snapshot</h3>
          <p className="text-[11px] text-muted mb-5">
            Completed deals · {preset === "Custom" ? "custom range" : preset.toLowerCase()}
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { label: "Revenue",       value: fmtAmount(displayStats?.total_revenue ?? 0), clr: "var(--t-tx1)" },
              { label: "Total cost",    value: fmtAmount(displayStats?.total_cost ?? 0),    clr: "var(--t-tx1)" },
              { label: "Net profit",    value: fmtAmount(displayStats?.total_profit ?? 0),
                clr: (displayStats?.total_profit ?? 0) >= 0 ? CLR.emerald : CLR.rose },
              { label: "Margin",        value: `${(displayStats?.avg_margin ?? 0).toFixed(1)}%`, clr: "var(--t-tx1)" },
              { label: "Outstanding (current)", value: fmtAmount(stats.outstanding), clr: CLR.amber },
              { label: "Open closeouts",        value: String(stats.incomplete_shipping), clr: "var(--t-tx1)" },
            ].map((item) => (
              <div key={item.label}>
                <div className="text-[12.5px] font-medium text-muted mb-1.5">
                  {item.label}
                </div>
                <div className="text-[20px] font-bold tabular-nums leading-none"
                  style={{ color: item.clr }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Row: Cash position + Top suppliers ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Cash position — live from the Financials engine (always current, not range) */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Cash position</h3>
          <p className="text-[11px] text-muted mb-5">Live from Financials · not affected by the date range</p>
          {money ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between">
                <span className="text-[12.5px] font-medium text-muted">Free cash</span>
                <span className="text-[24px] font-bold tabular-nums leading-none"
                  style={{ color: money.free_cash >= 0 ? CLR.emerald : CLR.rose }}>
                  {fmtAmount(money.free_cash)}
                </span>
              </div>
              <div className="border-t border-line-2 pt-3 space-y-2">
                {[
                  { label: "Bank balance",       v: money.bank_balance,       out: false },
                  { label: "Credit card owed",   v: money.credit_card_balance, out: true },
                  { label: "Supplier payables",  v: money.supplier_payables,  out: true },
                  { label: "Refund liability",   v: money.refund_liability,   out: true },
                  // Reserves are targets, not deductions — listing them here made the
                  // breakdown fail to add up to the figure printed above it. Cash floor
                  // IS deducted and was missing, which broke the same sum the other way.
                  { label: "Cash floor",         v: money.cash_floor,         out: true },
                  { label: "Loans outstanding",  v: money.loan_outstanding,   out: true },
                ].filter((r) => r.v > 0.005 || r.label === "Bank balance").map((r) => (
                  <div key={r.label} className="flex items-center justify-between text-[12.5px]">
                    <span className="text-ink-2">{r.label}</span>
                    <span className={`tabular-nums font-medium ${r.out ? "text-danger-ink" : "text-success-ink"}`}>
                      {r.out ? "−" : ""}{fmtAmount(r.v)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : <Blank h={160} text="Connect a bank in Financials to see cash position" />}
        </div>

        {/* Top suppliers — where the cost of goods goes */}
        <div className="bg-surface border border-line-2 rounded-xl p-5 min-w-0">
          <h3 className="text-[13px] font-semibold text-ink mb-0.5">Top suppliers</h3>
          <p className="text-[11px] text-muted mb-4">By total paid across completed deals · all time</p>
          {(stats.top_suppliers ?? []).length > 0 ? (
            <div className="space-y-1">
              {(() => {
                const maxPaid = Math.max(...stats.top_suppliers.map((s) => s.total_paid), 1);
                return stats.top_suppliers.map((s, i) => (
                  <div key={i} className="relative rounded-xl overflow-hidden">
                    <div className="absolute inset-y-0 left-0 rounded-xl transition-all duration-700 ease-out"
                      style={{
                        width: bars ? `${(s.total_paid / maxPaid) * 100}%` : "0%",
                        background: "rgb(var(--c-accent) / 0.06)",
                        transitionDelay: `${200 + i * 70}ms`,
                      }} />
                    <div className="relative flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{s.name}</div>
                        <div className="text-[11px] text-muted">
                          {s.deal_count} deal{s.deal_count !== 1 ? "s" : ""}
                        </div>
                      </div>
                      <span className="text-[13px] font-semibold text-ink tabular-nums flex-shrink-0">
                        {fmtAmount(s.total_paid)}
                      </span>
                    </div>
                  </div>
                ));
              })()}
            </div>
          ) : <Blank h={160} text="No supplier payments yet" />}
        </div>
      </div>

    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────

// Small month-over-month movement chip on lead stats.
function MomChip({ now, prev }: { now: number; prev: number }) {
  if (!prev) return null;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span title="vs prior month"
      className={`inline-flex items-center gap-0.5 h-5 px-1.5 rounded-full text-[10.5px] font-semibold tabular-nums flex-shrink-0 ${up ? "bg-success-bg text-success-ink" : "bg-danger-bg text-danger-ink"}`}>
      {up ? <TrendingUp size={11} strokeWidth={2} /> : <TrendingDown size={11} strokeWidth={2} />}
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}

function Blank({ h = 160, text = "No data yet" }: { h?: number; text?: string }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-faint"
      style={{ height: h }}>
      {text}
    </div>
  );
}
