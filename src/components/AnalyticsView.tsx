import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  api, AnalyticsRange, AnalyticsMonth, AnalyticsReconciliation, ReconRow, AnalyticsPace, AnalyticsPaceMonth,
  DashboardStats, FinancialsOverview, BuyerTier, Client, AnalyticsLabels, LabelRow,
  AnalyticsRefunds, AnalyticsRefundDeal, openDealFlow,
} from "../lib/api";
import { regionRollup, toRows } from "./globe/places";
import { fmtAmount, fmtCompactCurrency, localDay, parseLocalDay } from "../lib/format";
import { RefreshCw, FileDown } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  BarChart, Bar as RBar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import TierBadge from "./TierBadge";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import DealLabelsModal, { LabelFocus } from "./DealLabelsModal";
import { Button, Kpi, MonoAreaChart, PageActions, Tabs } from "./ui";

// ─── Chart colours (R-583) ─────────────────────────────────────────
// Everything neutral is read from the chart tokens (grey on both themes); only profit and loss wear
// the mockup's green and red. Resolved once per theme flip, because recharts wants real colours.
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgbVar = (n: string) => `rgb(${cssVar(n)})`;

const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect"];

function usePalette() {
  const [tick, force] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => force((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return useMemo(() => {
    void tick;   // the theme flip IS the input: every value below is read off the DOM
    const ink = rgbVar("--c-ink");
    const muted = rgbVar("--c-muted");
    return {
      grid: cssVar("--chart-grid"),
      line: cssVar("--chart-line"),
      hi: cssVar("--chart-hi"),
      profit: rgbVar("--c-chart-profit"),
      loss: rgbVar("--c-chart-loss"),
      TT: {
        contentStyle: {
          background: cssVar("--chart-tip"),
          border: `1px solid ${rgbVar("--c-line")}`,
          borderRadius: 8,
          color: ink,
          fontSize: 12,
          padding: "8px 10px",
          boxShadow: "0 10px 30px -10px rgba(0,0,0,0.5)",
        },
        cursor: { fill: "rgba(128,128,128,0.08)" },
        itemStyle: { color: ink },
        labelStyle: { color: muted, marginBottom: 3 },
      },
      AX: { fontSize: 12, fill: muted },
    };
  }, [tick]);
}

// ─── Small helpers ─────────────────────────────────────────────────
const PRESETS = ["All time", "This year", "This month"] as const;
// R-159: local (Central) day, computed per call.
function presetRange(label: string): { start: string; end: string } {
  const today = localDay();
  if (label === "This year") return { start: today.slice(0, 4) + "-01-01", end: today };
  if (label === "This month") return { start: today.slice(0, 7) + "-01", end: today };
  return { start: "", end: "" };
}

// A negative figure reads "-$4,260.00" through fmtAmount, which puts the sign in the wrong place.
// Money that can go negative on this screen wears a real minus in front. Under half a cent is zero.
const signed = (n: number) => (Math.abs(n) < 0.005 ? fmtAmount(0) : n < 0 ? "−" + fmtAmount(Math.abs(n)) : fmtAmount(n));
const pnTone = (n: number) => (n >= 0 ? "text-success-ink" : "text-danger-ink");
// Kpi has no colour prop; its figure takes the tone through its wrapper.
const kpiTone = (n: number) => (n >= 0 ? "[&_.ui-fig]:text-success-ink" : "[&_.ui-fig]:text-danger-ink");

// A month is just its name; the year is added only on the first bucket of a year when the series spans several.
const shortMonth = (m: string) => parseLocalDay(m + "-01").toLocaleDateString("en-US", { month: "short" });
const longMonth = (m: string) => parseLocalDay(m + "-01").toLocaleDateString("en-US", { month: "long" });
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

// Share bars and ranks wear ink at falling strengths: the name beside them is the identity, not a hue.
const RAMP = [0.9, 0.62, 0.44, 0.3, 0.2, 0.13];
const inkAt = (i: number) => `rgb(var(--c-ink) / ${RAMP[Math.min(i, RAMP.length - 1)]})`;

type TabId = "overview" | "money" | "deals" | "buyers";
const TAB_KEY = "clienthub_analytics_tab";
const readTab = (): TabId => {
  try { const t = localStorage.getItem(TAB_KEY); if (t === "overview" || t === "money" || t === "deals" || t === "buyers") return t; } catch { /* storage off */ }
  return "overview";
};

// ─── Layout pieces ─────────────────────────────────────────────────
function Head({ title, sub, right }: { title: string; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-5">{title}</div>
        {sub && <div className="ui-note mt-0.5 leading-[1.45]">{sub}</div>}
      </div>
      {right && <div className="flex-shrink-0">{right}</div>}
    </div>
  );
}

const Block = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <section className={`px-4 py-5 min-w-0 ${className}`}>{children}</section>
);

/** Two blocks side by side with a fading hairline between, stacked below ~1400px. */
function Cols({ a, b }: { a: React.ReactNode; b: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 min-[1400px]:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] min-[1400px]:gap-x-2">
      {a}
      <div className="vsep hidden min-[1400px]:block mt-4" />
      <div className="hsep min-[1400px]:hidden" />
      {b}
    </div>
  );
}

type Tone = "up" | "down" | "warn";
const TONE: Record<Tone, string> = { up: "text-success-ink", down: "text-danger-ink", warn: "text-warning-ink" };

function Fig({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="ui-label truncate">{label}</div>
      <div className={`ui-fig !text-[22px] !leading-7 mt-1 truncate ${tone ? TONE[tone] : ""}`}>{value}</div>
      {hint && <div className="ui-note mt-0.5 truncate tabular-nums">{hint}</div>}
    </div>
  );
}

/** A thin share bar. It grows by scaling, not by changing its width, so it stays on the GPU. */
function Bar({ frac, h = 6, tone = "bg-faint", on = true, delay = 0 }: { frac: number; h?: number; tone?: string; on?: boolean; delay?: number }) {
  const f = on ? Math.max(0, Math.min(1, frac)) : 0;
  return (
    <span className="block overflow-hidden rounded-full bg-surface-3" style={{ height: h }}>
      <span className={`block h-full w-full rounded-full origin-left transition-transform duration-[600ms] ease-out ${tone}`}
        style={{ transform: `scaleX(${f})`, transitionDelay: `${delay}ms` }} />
    </span>
  );
}

/** A 100% bar split into the named parts and one "Other". */
function ShareBar({ parts, total, on }: { parts: { name: string; value: number }[]; total: number; on: boolean }) {
  if (total <= 0) return null;
  const named = parts.reduce((s, p) => s + p.value, 0);
  const other = Math.max(total - named, 0);
  const segs = other > 0.005 ? [...parts, { name: "Other", value: other }] : parts;
  return (
    <div className={`flex gap-0.5 h-2.5 transition-opacity duration-500 ${on ? "opacity-100" : "opacity-0"}`}>
      {segs.map((s, i) => (
        <span key={s.name} className="rounded-[3px]" title={`${s.name}, ${((s.value / total) * 100).toFixed(1)}%`}
          style={{ flex: `${Math.max(s.value, 0)} 0 0`, background: s.name === "Other" ? inkAt(5) : inkAt(i) }} />
      ))}
    </div>
  );
}

function Blank({ h = 160, text = "No data yet" }: { h?: number; text?: string }) {
  return <div className="flex items-center justify-center text-center text-[13px] text-faint px-4" style={{ height: h }}>{text}</div>;
}

/** The key to a chart series: a short bar of its colour beside its name. */
function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted whitespace-nowrap">
      <span className="inline-block w-3.5 h-0.5 rounded-sm" style={{ background: color }} />{label}
    </span>
  );
}

// ─── Main view ───────────────────────────────────────────────────
export default function AnalyticsView() {
  const P = usePalette();
  const { TT, AX } = P;
  const [tab, setTabState] = useState<TabId>(readTab);
  const setTab = (t: TabId) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* storage off */ } };

  const [paceCmp, setPaceCmp] = useState<string | null>(null);
  const [stats,     setStats]     = useState<DashboardStats | null>(null);
  const [range,     setRange]     = useState<AnalyticsRange | null>(null);
  const [recon,     setRecon]     = useState<AnalyticsReconciliation | null>(null);
  const [refunds,   setRefunds]   = useState<AnalyticsRefunds | null>(null);
  const [refundsBusy, setRefundsBusy] = useState(false);
  const [tiers,     setTiers]     = useState<any[]>([]);
  const [money,     setMoney]     = useState<FinancialsOverview | null>(null);
  const [clients,   setClients]   = useState<Client[] | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [bars,      setBars]      = useState(false);
  const [preset,    setPreset]    = useState<string>("All time");
  const [startDate, setStartDate] = useState("");
  const [endDate,   setEndDate]   = useState("");
  // Revenue or profit on the pace chart. One question, one line, a toggle rather than two charts.
  const [paceMetric, setPaceMetric] = useState<"revenue" | "profit">("revenue");
  // The reconciliation table can run to hundreds of rows. It renders the first 25 until asked for the rest.
  const [reconAll, setReconAll] = useState(false);
  // R-402: revenue and profit by category and by brand, and the screen that labels deals.
  const [labels, setLabels] = useState<AnalyticsLabels | null>(null);
  const [catMetric, setCatMetric] = useState<"revenue" | "profit">("revenue");
  const [brandMetric, setBrandMetric] = useState<"revenue" | "profit">("revenue");
  const [labelling, setLabelling] = useState<{ focus: LabelFocus | null } | null>(null);

  // R-444: only the latest range's refunds land, and the old list goes as a new range starts,
  // so the card never shows one range's deals under another's heading.
  const refundsSeq = useRef(0);
  const loadRefunds = (start: string, end: string) => {
    const seq = ++refundsSeq.current;
    setRefunds(null);
    setRefundsBusy(true);
    api.analyticsRefunds(start, end)
      .then((r) => { if (seq === refundsSeq.current) setRefunds(r); })
      .catch(() => { if (seq === refundsSeq.current) setRefunds(null); })
      .finally(() => { if (seq === refundsSeq.current) setRefundsBusy(false); });
  };

  const loadRange = async (start: string, end: string) => {
    setBars(false);
    try { setRange(await api.getAnalyticsRange(start, end)); } catch {}
    // Reconciliation is its own read and is allowed to fail on its own: it must never
    // be the reason the rest of the screen shows nothing.
    api.analyticsReconciliation(start, end).then(setRecon).catch(() => setRecon(null));
    loadRefunds(start, end);
    api.analyticsLabels(start, end).then(setLabels).catch(() => setLabels(null));
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
      // Cash position is secondary: load separately so a Plaid/overview hiccup
      // never blanks the analytics page. Same for the reconciliation read.
      api.financialsOverview().then(setMoney).catch(() => {});
      api.listClientsFiltered({}).then(setClients).catch(() => setClients(null));
      api.analyticsReconciliation(startDate, endDate).then(setRecon).catch(() => setRecon(null));
      loadRefunds(startDate, endDate);
      api.analyticsLabels(startDate, endDate).then(setLabels).catch(() => setLabels(null));
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!loading && stats) setTimeout(() => setBars(true), 120);
  }, [loading, stats]);

  const rangeLabel = preset === "Custom" ? "the selected range" : preset.toLowerCase();

  // Where the profit is: client profit (the Tiers figure) summed by US state or country, the same
  // rollup the Globe's region list shows. Rejected leads are out, as everywhere.
  const regions = useMemo(() => {
    if (!clients) return null;
    const tierMap: Record<string, BuyerTier> = Object.fromEntries((tiers as BuyerTier[]).map((t) => [t.client_id, t]));
    const rows = toRows(clients.filter((c) => c.approval_status !== "rejected"), tierMap);
    const list = regionRollup(rows).sort((a, b) => b.profit - a.profit || b.count - a.count);
    return { list, unplaced: rows.filter((r) => !r.region).length };
  }, [clients, tiers]);

  // The primary trend. The in-progress month is marked but NOT projected here; the projection lives
  // on the pace panel, where it is a line with a sentence.
  const trend = useMemo(() => {
    const months: AnalyticsMonth[] = range?.monthly_profit ?? [];
    const names = monthLabels(months.map((m) => m.month));
    const rr = range?.run_rate ?? null;
    return months.map((m, i) => ({ ...m, label: names[i], projected: !!rr && rr.month === m.month }));
  }, [range?.monthly_profit, range?.run_rate]);

  // Velocity carries its own month series, so it gets its own year-aware labels. A month with no
  // measured deal has no median and is left out of the line.
  const velocityRows = useMemo(() => {
    const by = range?.velocity.by_month ?? [];
    const names = monthLabels(by.map((v) => v.month));
    return by.map((v, i) => ({ ...v, label: names[i] })).filter((v) => v.median_days !== null);
  }, [range?.velocity]);

  // ── Pace: this month's running total against a month before it, or the average of those ──
  const pace: AnalyticsPace | null = range?.pace ?? null;
  const paceView = useMemo(() => {
    if (!pace || pace.months.length === 0) return null;
    const cur = pace.months[pace.months.length - 1];
    const priors = pace.months.slice(0, -1);
    const total = Math.max(...pace.months.map((m) => m.days_in_month));
    // A shorter month runs flat after its last day so every series is `total` long.
    const fill = (m: AnalyticsPaceMonth) => Array.from({ length: total }, (_, i) => {
      const pt = m.days[Math.min(i, m.days.length - 1)];
      return Math.max(0, pt ? pt[paceMetric] : 0);
    });
    const values = cur.days.slice(0, pace.day_of_month).map((p) => Math.max(0, p[paceMetric]));
    const filled = priors.map(fill);
    const options: { id: string; label: string; vals: number[] }[] =
      priors.map((m, i) => ({ id: m.month, label: longMonth(m.month), vals: filled[i] })).reverse();
    if (priors.length > 1) {
      options.push({
        id: "avg", label: `${priors.length}-month average`,
        vals: Array.from({ length: total }, (_, i) => filled.reduce((s, f) => s + f[i], 0) / priors.length),
      });
    }
    return { total, values, options };
  }, [pace, paceMetric]);
  const paceCompare = paceView ? (paceView.options.find((o) => o.id === paceCmp) ?? paceView.options[0] ?? null) : null;

  const reconRows = useMemo(
    () => (reconAll ? recon?.deals ?? [] : (recon?.deals ?? []).slice(0, 25)),
    [recon, reconAll],
  );

  // Skeleton mirrors the real layout: KPI band, tabs, a chart and a table. Blocks, not spinners.
  if (!range && loading) return (
    <div aria-busy="true">
      <div className="h-8 w-80 rounded-lg bg-surface-2 animate-pulse mb-4" />
      <div className="h-[136px] rounded-xl bg-surface-2 animate-pulse" />
      <div className="h-[36px] w-80 rounded-[10px] bg-surface-2 animate-pulse mt-6" />
      <div className="h-[300px] rounded-xl bg-surface-2 animate-pulse mt-5" />
      <div className="h-[260px] rounded-xl bg-surface-2 animate-pulse mt-5" />
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
  const overheadTotal = range.total_shipping + range.total_fees;
  const rn = range.repeat_new;
  const repeatTotal = rn.new_revenue + rn.repeat_revenue;
  const plural = (n: number, w: string) => `${n} ${w}${n !== 1 ? "s" : ""}`;

  const handleExportAnalytics = async () => {
    const path = await saveDialog({ filters: [{ name: "Excel", extensions: ["xlsx"] }], defaultPath: "analytics.xlsx" });
    if (!path) return;
    await api.exportAnalyticsXlsx(path as string);
    toast("Exported analytics to Excel");
  };

  const inputCls = "h-8 px-2.5 rounded-lg ring-1 ring-line-3 bg-transparent text-[13px] text-ink transition-colors duration-[130ms] focus:outline-none focus:ring-ink";

  // ── Layout ───────────────────────────────────────────────────
  return (
    <>
    <div className={`transition-opacity duration-200 ${loading ? "opacity-70" : "opacity-100"}`}>
      <PageActions>
        <Button onClick={load} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>Refresh</Button>
        <Button variant="ink" onClick={handleExportAnalytics} icon={<FileDown size={14} />}>Export</Button>
      </PageActions>

      {/* The range: a sentence on the left, presets and dates on the right */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="text-[13px] text-muted">Closed-deal performance for {rangeLabel}</div>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button key={p} onClick={() => applyPreset(p)} className={`ui-opt ${preset === p ? "on" : ""}`} aria-pressed={preset === p}>{p}</button>
          ))}
          <input type="date" aria-label="Start date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
          <span className="ui-note">to</span>
          <input type="date" aria-label="End date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
          <Button size="sm" onClick={applyCustomRange}>Apply</Button>
        </div>
      </div>

      {/* ── How are we doing: six figures, no boxes ──────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
        <Kpi label="Revenue" value={range.total_revenue} format={fmtAmount} caption="closed deal revenue" />
        <div className="vsep hidden md:block mt-4" />
        <Kpi label="Net profit" value={range.total_profit} format={signed} className={kpiTone(range.total_profit)}
          caption={`after ${fmtAmount(range.total_cost)} of deal costs`} />
        <div className="vsep hidden md:block mt-4" />
        <Kpi label="True net" value={range.true_net} format={signed} className={kpiTone(range.true_net)}
          caption="after shipping and bank fees" />
      </div>
      <div className="hsep" />
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
        <Kpi label="Margin" value={range.avg_margin} format={(n) => `${n.toFixed(1)}%`} caption="revenue-weighted" />
        <div className="vsep hidden md:block mt-4" />
        <Kpi label="Deals closed" value={won} caption={`${lost} fell through`} />
        <div className="vsep hidden md:block mt-4" />
        <Kpi label="Win rate" value={won + lost > 0 ? winRate : "None yet"} format={(n) => `${n.toFixed(0)}%`}
          caption="won vs fell through"
          className={won + lost === 0 ? "" : winRate >= 60 ? "[&_.ui-fig]:text-success-ink" : winRate >= 40 ? "[&_.ui-fig]:text-warning-ink" : "[&_.ui-fig]:text-danger-ink"} />
      </div>
      <div className="hsep" />
      <div className="ui-note flex flex-wrap gap-x-6 gap-y-1.5 px-4 py-3">
        {preset !== "All time" && (
          <span>
            All time <b className="text-ink font-medium tabular-nums">{fmtAmount(range.revenue_all_time)}</b> revenue,{" "}
            <b className="text-ink font-medium tabular-nums">{signed(range.profit_all_time)}</b> profit,{" "}
            <b className="text-ink font-medium tabular-nums">{range.margin_all_time.toFixed(1)}%</b>
          </span>
        )}
        <span>
          <b className="text-ink font-medium tabular-nums">{range.new_clients}</b> new clients,{" "}
          <b className="text-ink font-medium tabular-nums">{range.interactions}</b> interactions in {rangeLabel}
        </span>
      </div>

      <div className="mt-4 mb-1">
        <Tabs label="Analytics sections" value={tab} onChange={(id) => setTab(id as TabId)}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "money", label: "Money" },
            { id: "deals", label: "Deals" },
            { id: "buyers", label: "Buyers" },
          ]} />
      </div>

      <div key={tab} className="animate-fade-up motion-reduce:animate-none">

      {/* ═════════════════ OVERVIEW ═════════════════ */}
      {tab === "overview" && (
        <>
          {/* ── How this month is going (R-319) ───────────────────── */}
          {pace && (
            <>
              <Block>
                <Head title="Month comparisons"
                  sub={`${longMonth(pace.current_month)} against the ${pace.prior_count} month${pace.prior_count !== 1 ? "s" : ""} before it, not affected by the date range`}
                  right={
                    <Tabs label="Measure" value={paceMetric} onChange={(id) => setPaceMetric(id as "revenue" | "profit")}
                      tabs={[{ id: "revenue", label: "Revenue" }, { id: "profit", label: "Profit" }]} />
                  } />
                <PaceSummary pace={pace} metric={paceMetric} />
                {paceView && paceView.values.length > 0 ? (
                  <div className="mt-6">
                    <MonoAreaChart
                      values={paceView.values}
                      total={paceView.total}
                      prev={paceCompare?.vals}
                      label={(i) => `${shortMonth(pace.current_month)} ${i + 1}`}
                      tipLabel={(i) => `${longMonth(pace.current_month)} ${i + 1}`}
                      format={signed}
                      formatAxis={fmtCompactCurrency}
                      seriesName={`${longMonth(pace.current_month)} so far`}
                      prevName={paceCompare?.label ?? "Month before"}
                      height={220}
                      ariaLabel={`${paceMetric === "revenue" ? "Revenue" : "Profit"} so far in ${longMonth(pace.current_month)} by day of the month`}
                    />
                    {paceView.options.length > 0 && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3">
                        <span className="ui-note">Compare with</span>
                        <Tabs label="Compare with" value={paceCompare?.id ?? ""} onChange={(id) => setPaceCmp(id)}
                          tabs={paceView.options.map((o) => ({ id: o.id, label: o.label }))} />
                      </div>
                    )}
                  </div>
                ) : <Blank h={220} text="No closed deals in the last four months" />}
              </Block>
              <div className="hsep" />
            </>
          )}

          {/* ── Month by month ────────────────────────────────────── */}
          <Block className="!pb-2">
            <Head title="Month by month" sub="Every month with a closed deal or an overhead payment" />
          </Block>
          {trend.length > 0 ? (
            <div className="overflow-x-auto px-1.5 pb-4">
              <table className="ui-table min-w-[720px]">
                <thead>
                  <tr>
                    <th>Month</th><th className="r">Deals</th><th className="r">Revenue</th><th className="r">Profit</th>
                    <th className="r">Margin</th><th className="r">Shipping</th><th className="r">Fees</th><th className="r">True net</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trend].reverse().map((m) => (
                    <tr key={m.month}>
                      <td className="whitespace-nowrap">
                        {m.label}
                        {m.projected && <span className="ml-2 align-middle"><StatusPill>In progress</StatusPill></span>}
                      </td>
                      <td className="r text-muted">{m.count}</td>
                      <td className="r text-muted">{fmtAmount(m.revenue)}</td>
                      <td className={`r font-medium ${pnTone(m.profit)}`}>{signed(m.profit)}</td>
                      <td className="r text-muted">{m.margin_pct.toFixed(1)}%</td>
                      <td className="r text-faint">{fmtAmount(m.shipping)}</td>
                      <td className="r text-faint">{fmtAmount(m.fees)}</td>
                      <td className={`r font-medium ${pnTone(m.true_net)}`}>{signed(m.true_net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Blank h={160} text="No months to show for this range" />}

          <div className="hsep" />

          {/* ── Primary trend ─────────────────────────────────────── */}
          <Block>
            <Head title="Revenue and profit by month"
              sub={trend.length > 0 ? plural(trend.length, "month") + " of closed deals" : "No closed deals in this range"}
              right={<div className="flex items-center gap-4"><Key color={P.line} label="Revenue" /><Key color={P.hi} label="Profit" /></div>} />
            {trend.length > 0 ? (
              <>
                <div className="mt-5">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={trend} barCategoryGap="34%" barGap={3} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                      <CartesianGrid stroke={P.grid} vertical={false} />
                      <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                      <YAxis tick={AX} axisLine={false} tickLine={false} width={54} tickFormatter={(v: number) => fmtCompactCurrency(v)} />
                      <Tooltip {...TT} formatter={(v: any, n: any) => [signed(Number(v)), n]} labelFormatter={(l: any) => String(l)} />
                      {/* An open month is drawn at half strength rather than carrying a stacked forecast on its head. */}
                      <RBar dataKey="revenue" name="Revenue" radius={[3, 3, 0, 0]} maxBarSize={22} animationDuration={600}>
                        {trend.map((m, i) => <Cell key={i} fill={P.line} fillOpacity={m.projected ? 0.42 : 1} />)}
                      </RBar>
                      <RBar dataKey="profit" name="Profit" radius={[3, 3, 0, 0]} maxBarSize={22} animationDuration={600}>
                        {trend.map((m, i) => <Cell key={i} fill={m.profit >= 0 ? P.hi : P.loss} fillOpacity={m.projected ? 0.42 : 1} />)}
                      </RBar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {range.run_rate && (
                  <p className="ui-note mt-3 tabular-nums">
                    {longMonth(range.run_rate.month)} is still open: {range.run_rate.days_elapsed} of{" "}
                    {range.run_rate.days_in_month} days in, so its bars are drawn at half strength.
                  </p>
                )}
              </>
            ) : <Blank h={260} text="Nothing closed in this range" />}
          </Block>

          <div className="hsep" />

          {/* ── What went wrong + standouts ───────────────────────── */}
          <Cols
            a={
              <Block>
                <Head title="What went wrong" sub={`Closed below cost in ${rangeLabel}`} />
                <div className="mt-4">
                  <Fig label="Closed at a loss" value={String(range.loss_deals)} tone={range.loss_deals > 0 ? "down" : undefined}
                    hint={range.loss_total < 0 ? signed(range.loss_total) : "none"} />
                </div>
                <p className="ui-note mt-4 leading-[1.5]">
                  {lost + range.loss_deals + range.refunded_deals === 0
                    ? `Nothing was lost, refunded or closed below cost in ${rangeLabel}.`
                    : `A loss is a deal whose profit went negative after refunds. Deals that fell through (${lost}) are counted above, and refunds are under Money.`}
                </p>
              </Block>
            }
            b={
              <Block>
                <Head title="Standouts" sub={`The extremes of ${rangeLabel}`} />
                <div className="mt-2">
                  <Highlight label="Best margin"
                    name={range.best_margin_deal?.title ?? null}
                    sub={range.best_margin_deal ? range.best_margin_deal.client_name : null}
                    value={range.best_margin_deal ? `${range.best_margin_deal.margin_pct.toFixed(1)}%` : null}
                    valueCls="text-success-ink"
                    amount={range.best_margin_deal ? signed(range.best_margin_deal.net_profit) : null} />
                  <Highlight label="Worst margin"
                    name={range.worst_margin_deal?.title ?? null}
                    sub={range.worst_margin_deal ? range.worst_margin_deal.client_name : null}
                    value={range.worst_margin_deal ? `${range.worst_margin_deal.margin_pct.toFixed(1)}%` : null}
                    valueCls={(range.worst_margin_deal?.margin_pct ?? 0) < 0 ? "text-danger-ink" : "text-warning-ink"}
                    amount={range.worst_margin_deal ? signed(range.worst_margin_deal.net_profit) : null} />
                  <Highlight label="Biggest invoice"
                    name={range.biggest_invoice?.number ?? null}
                    sub={range.biggest_invoice?.client_name ?? null}
                    value={range.biggest_invoice ? fmtAmount(range.biggest_invoice.total) : null}
                    amount={null} />
                </div>
              </Block>
            }
          />
        </>
      )}

      {/* ═════════════════ MONEY ═════════════════ */}
      {tab === "money" && (
        <>
          {/* ── Refunds (R-444) ───────────────────────────────────── */}
          {refundsBusy && !refunds && (
            <>
              <Block><div className="h-[120px] rounded-xl bg-surface-2 animate-pulse" aria-busy="true" /></Block>
              <div className="hsep" />
            </>
          )}
          {refunds && (refunds.deals.length > 0 || refunds.totals.owed_back_all > 0.005 || refunds.supplier_back_unlinked > 0.005) && (
            <>
              <Block className="!pb-2">
                <Head title="Refunds"
                  sub="Every refunded deal that closed in this range. A refund comes off the deal's revenue and profit on the day the deal closed." />
                <div className="grid grid-cols-2 min-[1200px]:grid-cols-4 gap-x-6 gap-y-5 mt-4">
                  <Fig label="Refunded" value={signed(-refunds.totals.refunded)}
                    tone={refunds.totals.refunded > 0 ? "down" : undefined}
                    hint={plural(refunds.totals.refunded_deals, "deal")} />
                  <Fig label="Cancelled out" value={String(refunds.totals.cancelled)} hint="The refund undid the sale" />
                  <Fig label="Still a loss" value={refunds.totals.loss_deals ? signed(refunds.totals.loss_total) : "None"}
                    tone={refunds.totals.loss_deals ? "down" : undefined}
                    hint={`${plural(refunds.totals.loss_deals, "refunded deal")}`} />
                  <Fig label="Owed back" value={fmtAmount(refunds.totals.owed_back_all)}
                    tone={refunds.totals.owed_back_all > 0.005 ? "warn" : undefined}
                    hint={refunds.totals.owed_back_deals ? `${plural(refunds.totals.owed_back_deals, "deal")}, any date` : "Nothing to send back"} />
                </div>
              </Block>
              {refunds.deals.length > 0 ? (
                <RefundsTable deals={refunds.deals} />
              ) : <Blank h={80} text="No refunded deal closed in this range" />}
              {refunds.supplier_back_unlinked > 0.005 && (
                <p className="ui-note px-4 pb-4 leading-[1.5]">
                  {fmtAmount(refunds.supplier_back_unlinked)} of supplier money back in the bank ({plural(refunds.supplier_back_count, "payment")} in this range)
                  is linked to no deal. Link it on the refunded deal's refund step, under supplier money back, and that deal's loss clears.
                </p>
              )}
              <div className="hsep" />
            </>
          )}

          {/* ── Money in, money out (R-317) ───────────────────────── */}
          {recon && (
            <>
              <Cols
                a={
                  <Block>
                    <Head title="Money in, money out" sub={`Revenue down to true net for ${rangeLabel}`}
                      right={recon.bridge_ties
                        ? <StatusPill tone="success">Every line ties</StatusPill>
                        : <StatusPill tone="danger">Does not tie</StatusPill>} />
                    <div className="mt-3"><BridgeList rows={recon.bridge} /></div>
                    <p className="ui-note mt-3 leading-[1.5]">
                      Each subtotal is read straight from the book, not added up from the lines
                      above it. Where the two disagree, the difference is named on the line.
                    </p>
                  </Block>
                }
                b={
                  <Block>
                    <Head title="The bank against these deals" sub="Why the account moved by a different figure from the profit"
                      right={recon.bank.ties
                        ? <StatusPill tone="success">Fully explained</StatusPill>
                        : <StatusPill tone="warning">{fmtAmount(Math.abs(recon.bank.residual))} unexplained</StatusPill>} />
                    <div className="mt-3"><BridgeList rows={recon.bank.rows} /></div>
                    <p className="ui-note mt-3 leading-[1.5]">
                      A bank line is dated by the day it posted; a deal is dated by the day it
                      completed. Over all time those are the same book. Over a short range they
                      are not, and the difference lands on the unexplained line.
                    </p>
                    {recon.bank.supplier_back_count > 0 && (
                      <p className="ui-note text-warning-ink mt-2 leading-[1.5]">
                        {fmtAmount(recon.bank.supplier_back_unlinked)} of supplier refunds across{" "}
                        {plural(recon.bank.supplier_back_count, "transaction")} is not tied to a deal. A
                        deal's cost is built from what is linked to it, so that money has not come
                        off any cost yet. Tie each one to its deal in Financials as money back
                        from the supplier.
                      </p>
                    )}
                    {recon.bank.orphan_allocations > 0 && (
                      <p className="ui-note text-danger-ink mt-2 leading-[1.5]">
                        {plural(recon.bank.orphan_allocations, "allocation")} worth{" "}
                        {fmtAmount(recon.bank.orphan_amount)} point at a bank transaction that no
                        longer exists. That money cannot be traced from either side.
                      </p>
                    )}
                  </Block>
                }
              />
              <div className="hsep" />

              <Block className="!pb-2">
                <Head title="Every closed deal, and the money behind it"
                  sub={recon.deals_capped
                    ? `The ${recon.deals.length} most profitable of ${recon.totals.deal_count} closed deals: the totals cover all of them`
                    : `${plural(recon.totals.deal_count, "closed deal")} in ${rangeLabel}`} />
              </Block>
              {recon.deals.length > 0 ? (
                <>
                  <ReconTable recon={recon} rows={reconRows} />
                  <div className="px-4 pt-3 pb-5">
                    {!reconAll && recon.deals.length > reconRows.length && (
                      <Button size="sm" onClick={() => setReconAll(true)}>Show all {recon.deals.length} rows</Button>
                    )}
                    <div className="ui-note mt-3 space-y-1.5 leading-[1.5]">
                      <p className="m-0">
                        Profit and true net add back to the bridge exactly. Money in and money out
                        are bank evidence (what is actually allocated to the deal), so they are
                        allowed to differ from revenue and cost, and here is by how much.
                      </p>
                      <Gap label="Buyer money banked" gap={recon.totals.money_in_gap} against="recorded revenue" />
                      <Gap label="Supplier money banked" gap={recon.totals.money_out_gap} against="recorded cost"
                        because={Math.abs(recon.totals.money_out_gap - recon.totals.supplier_refund_in) < 0.005
                          && recon.totals.supplier_refund_in > 0
                          ? `exactly the ${fmtAmount(recon.totals.supplier_refund_in)} a supplier sent back`
                          : undefined} />
                    </div>
                  </div>
                </>
              ) : <Blank h={160} text="Nothing closed in this range to reconcile" />}
              <div className="hsep" />
            </>
          )}

          {/* ── Shipping and bank fees ────────────────────────────── */}
          <Block>
            <Head title="Shipping and bank fees" sub="Money that leaves the bank and never reaches a deal's cost" />
            <div className="grid grid-cols-1 min-[1200px]:grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-x-10 gap-y-6 mt-4">
              <div className="min-w-0">
                <Fig label="Shipping" value={fmtAmount(range.total_shipping)} />
                <div className="mt-3.5"><Fig label="Bank and wire fees" value={fmtAmount(range.total_fees)} /></div>
                <div className="hsep my-3.5" />
                <Fig label="Overhead" value={fmtAmount(overheadTotal)} hint={`${range.overhead_ratio.toFixed(1)}% of revenue`} />
              </div>

              <div className="min-w-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="ui-label">Overhead by month</span>
                  <div className="flex items-center gap-4"><Key color={P.line} label="Shipping" /><Key color={P.hi} label="Fees" /></div>
                </div>
                {trend.length > 0 ? (
                  <div className="mt-2.5">
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={trend} margin={{ top: 4, right: 4, left: -8, bottom: 0 }} barCategoryGap="34%">
                        <CartesianGrid stroke={P.grid} vertical={false} />
                        <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                        <YAxis tick={AX} axisLine={false} tickLine={false} width={54} tickFormatter={(v: number) => fmtCompactCurrency(v)} />
                        <Tooltip {...TT} formatter={(v: any, n: any) => [signed(Number(v)), n]} />
                        <RBar dataKey="shipping" name="Shipping" stackId="oh" fill={P.line} maxBarSize={22} animationDuration={600} />
                        <RBar dataKey="fees" name="Fees" stackId="oh" fill={P.hi} maxBarSize={22} radius={[3, 3, 0, 0]} animationDuration={600} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : <Blank h={160} text="No overhead recorded in this range" />}

                <div className="ui-label mt-6">Overhead as a share of revenue</div>
                {trend.length > 0 ? (
                  <div className="mt-3">
                    <MonoAreaChart
                      values={trend.map((m) => Math.max(0, m.overhead_pct))}
                      label={(i) => trend[i]?.label ?? ""}
                      format={(v) => `${v.toFixed(1)}%`}
                      formatAxis={(v) => `${v.toFixed(0)}%`}
                      seriesName="Overhead"
                      prevName=""
                      height={120}
                      ariaLabel="Overhead as a share of revenue, by month"
                    />
                  </div>
                ) : <Blank h={120} text="No revenue to compare against" />}
              </div>
            </div>
          </Block>

          <div className="hsep" />

          {/* ── Supplier spend + cash position ────────────────────── */}
          <Cols
            a={
              <Block>
                <Head title="Where the money goes" sub={`${plural(range.supplier_concentration.supplier_count, "supplier")} paid in ${rangeLabel}`} />
                {range.supplier_concentration.supplier_count > 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 mt-4">
                      <Concentration label="Top supplier" pct={range.supplier_concentration.top1_pct} warnAt={50} unit="of spend" />
                      <Concentration label="Top 3" pct={range.supplier_concentration.top3_pct} warnAt={80} unit="of spend" />
                    </div>
                    <div className="mt-4">
                      <ShareBar on={bars} total={range.supplier_concentration.total_spend}
                        parts={range.top_suppliers_range.map((s) => ({ name: s.name, value: s.total_paid }))} />
                    </div>
                    <div className="mt-3">
                      {range.top_suppliers_range.map((s) => (
                        <div key={s.name} className="grid grid-cols-[minmax(0,1fr)_64px_96px] items-center gap-3 min-h-[36px] text-[13px] [&+&]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                          <span className="truncate">{s.name}</span>
                          <span className="text-right text-muted tabular-nums">{plural(s.deal_count, "deal")}</span>
                          <span className="text-right font-medium tabular-nums">{fmtAmount(s.total_paid)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <Blank h={200} text="No supplier payments in this range" />}
              </Block>
            }
            b={
              <Block>
                <Head title="Cash position" sub="Live from Financials, not affected by the date range" />
                {money ? (
                  <div className="mt-3.5">
                    <div className="flex items-end justify-between gap-3">
                      <span className="ui-label">Free cash</span>
                      <span className={`ui-fig ${pnTone(money.free_cash)}`}>{signed(money.free_cash)}</span>
                    </div>
                    <div className="hsep my-2.5" />
                    {[
                      { label: "Bank balance",      v: money.bank_balance,        out: false },
                      { label: "Credit card owed",  v: money.credit_card_balance, out: true },
                      { label: "Supplier payables", v: money.supplier_payables,   out: true },
                      { label: "Refund liability",  v: money.refund_liability,    out: true },
                      { label: "Cash floor",        v: money.cash_floor,          out: true },
                      { label: "Loans outstanding", v: money.loan_outstanding,    out: true },
                    ].filter((r) => r.v > 0.005 || r.label === "Bank balance").map((r) => (
                      <div key={r.label} className="ui-kv">
                        <span>{r.label}</span>
                        <span className={r.out ? "text-danger-ink" : "text-success-ink"}>{r.out ? "−" : ""}{fmtAmount(r.v)}</span>
                      </div>
                    ))}
                  </div>
                ) : <Blank h={200} text="Connect a bank in Financials to see cash position" />}
              </Block>
            }
          />
        </>
      )}

      {/* ═════════════════ DEALS ═════════════════ */}
      {tab === "deals" && (
        <>
          <Cols
            a={
              <Block>
                <Head title="Margin distribution" sub="Deals by margin band, so a fat tail stays visible" />
                {range.margin_bands.some((b) => b.deals > 0) ? (() => {
                  const top = Math.max(1, ...range.margin_bands.map((b) => b.deals));
                  return (
                    <div className="mt-4">
                      {range.margin_bands.map((b, i) => (
                        <div key={b.label} className="grid grid-cols-[70px_minmax(0,1fr)_30px_84px] items-center gap-2.5 h-[34px] text-[13px]">
                          <span className="text-muted">{b.label}</span>
                          <Bar frac={b.deals / top} h={8} on={bars} delay={i * 40}
                            tone={i === 0 ? "bg-[rgb(var(--c-chart-loss))]" : "bg-faint"} />
                          <span className="text-right tabular-nums">{b.deals}</span>
                          <span className={`text-right tabular-nums ${b.deals > 0 ? pnTone(b.profit) : "text-faint"}`}>{b.deals > 0 ? signed(b.profit) : ""}</span>
                        </div>
                      ))}
                    </div>
                  );
                })() : <Blank h={230} text="No closed deals with revenue in this range" />}
              </Block>
            }
            b={
              <Block>
                <Head title="Deal velocity"
                  sub={range.velocity.median_days !== null
                    ? `Median ${range.velocity.median_days.toFixed(0)} days from invoice issued to deal completed, over ${plural(range.velocity.deals_measured, "deal")}`
                    : "Days from invoice issued to deal completed"} />
                {velocityRows.length > 0 ? (
                  <div className="mt-5">
                    <MonoAreaChart
                      values={velocityRows.map((v) => Math.max(0, v.median_days ?? 0))}
                      label={(i) => velocityRows[i]?.label ?? ""}
                      tipLabel={(i) => `${velocityRows[i]?.label ?? ""}, ${plural(velocityRows[i]?.deals ?? 0, "deal")}`}
                      format={(v) => `${v.toFixed(0)} days`}
                      formatAxis={(v) => `${v.toFixed(0)}d`}
                      seriesName="Median"
                      prevName=""
                      height={150}
                      ariaLabel="Median days from invoice to completed deal, by month"
                    />
                  </div>
                ) : <Blank h={230} text="No deal has both an issue date and a completion date yet" />}
              </Block>
            }
          />
          <div className="hsep" />

          {/* ── R-402: what sells, by category and by brand ──────── */}
          <Cols
            a={<LabelCard kind="category" labels={labels} metric={catMetric} setMetric={setCatMetric}
              rangeLabel={rangeLabel} bars={bars} onOpen={(focus) => setLabelling({ focus })} />}
            b={<LabelCard kind="brand" labels={labels} metric={brandMetric} setMetric={setBrandMetric}
              rangeLabel={rangeLabel} bars={bars} onOpen={(focus) => setLabelling({ focus })} />}
          />
          <div className="hsep" />

          {/* ── What people bought ───────────────────────────────── */}
          <Block className="!pb-2">
            <Head title="What people bought"
              sub={range.completed_deals_capped
                ? `The ${range.completed_deals.length} most recent of ${range.deal_count} closed deals`
                : `${plural(range.completed_deals.length, "closed deal")} in ${rangeLabel}`} />
          </Block>
          {range.completed_deals.length > 0 ? <BoughtTable deals={range.completed_deals} /> : <Blank h={160} text="Nothing closed in this range" />}
          <div className="hsep" />

          {/* ── Invoice status ───────────────────────────────────── */}
          <Block>
            <Head title="Invoice status" sub={`${plural(stats.invoices, "invoice")}, all time`} />
            {stats.invoice_status_breakdown.length > 0 ? (
              <div className="mt-4 max-w-[720px]">
                {stats.invoice_status_breakdown.map((s, i) => {
                  const pct = totalSV > 0 ? s.total / totalSV : 0;
                  const tone = s.status === "paid" ? "bg-[rgb(var(--c-chart-profit))]"
                    : s.status === "overdue" || s.status === "void" ? "bg-[rgb(var(--c-chart-loss))]" : "bg-faint";
                  return (
                    <div key={s.status} className="mb-3.5">
                      <div className="flex items-center justify-between gap-3 text-[13px] mb-1.5">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="capitalize truncate">{s.status.replace("_", " ")}</span>
                          <StatusPill>{s.count}</StatusPill>
                        </span>
                        <span className="font-medium tabular-nums flex-shrink-0">{fmtAmount(s.total)}</span>
                      </div>
                      <Bar frac={pct} on={bars} delay={i * 60} tone={tone} />
                    </div>
                  );
                })}
              </div>
            ) : <Blank h={160} text="No invoices yet" />}
          </Block>
        </>
      )}

      {/* ═════════════════ BUYERS ═════════════════ */}
      {tab === "buyers" && (
        <>
          <Cols
            a={
              <Block>
                <Head title="Where the revenue is concentrated" sub={`${plural(range.concentration.client_count, "buyer")} in ${rangeLabel}`} />
                {range.concentration.client_count > 0 ? (
                  <>
                    <div className="grid grid-cols-3 gap-3 mt-4">
                      <Concentration label="Top buyer" pct={range.concentration.top1_pct} warnAt={40} unit="of revenue" />
                      <Concentration label="Top 3" pct={range.concentration.top3_pct} warnAt={70} unit="of revenue" />
                      <Concentration label="Top 5" pct={range.concentration.top5_pct} warnAt={85} unit="of revenue" />
                    </div>
                    <div className="mt-4">
                      <ShareBar on={bars} total={range.concentration.total_revenue}
                        parts={range.top_revenue_clients.map((c) => ({ name: c.name, value: c.revenue }))} />
                    </div>
                    <div className="mt-3">
                      {range.top_revenue_clients.map((c) => (
                        <div key={c.name} className="grid grid-cols-[minmax(0,1fr)_48px_90px] items-center gap-3 min-h-[36px] text-[13px] [&+&]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                          <span className="truncate">{c.name}</span>
                          <span className="text-right text-muted tabular-nums">{c.pct.toFixed(1)}%</span>
                          <span className="text-right font-medium tabular-nums">{fmtAmount(c.revenue)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <Blank h={230} text="No buyers with revenue in this range" />}
              </Block>
            }
            b={
              <Block>
                <Head title="Repeat buyers versus first-time" sub="A deal counts as first-time when it is that buyer's earliest closed deal" />
                {repeatTotal > 0 ? (
                  <>
                    <div className="mt-4">
                      <ShareBar on={bars} total={repeatTotal}
                        parts={[{ name: "Repeat", value: rn.repeat_revenue }, { name: "First-time", value: rn.new_revenue }]} />
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4 mt-5">
                      <Fig label="Repeat revenue" value={fmtAmount(rn.repeat_revenue)}
                        hint={`${plural(rn.repeat_deals, "deal")}, ${plural(rn.repeat_clients, "buyer")}`} />
                      <Fig label="First-time revenue" value={fmtAmount(rn.new_revenue)}
                        hint={`${plural(rn.new_deals, "deal")}, ${plural(rn.new_clients, "buyer")}`} />
                      <Fig label="Repeat profit" value={signed(rn.repeat_profit)} tone={rn.repeat_profit >= 0 ? "up" : "down"} />
                      <Fig label="First-time profit" value={signed(rn.new_profit)} tone={rn.new_profit >= 0 ? "up" : "down"} />
                    </div>
                  </>
                ) : <Blank h={230} text="No revenue to split in this range" />}
              </Block>
            }
          />
          <div className="hsep" />

          <Cols
            a={
              <Block>
                <Head title="Client mix" sub={`${plural(totalCl, "client")} by tier, all time`} />
                {totalCl > 0 ? (
                  <>
                    <div className="mt-4">
                      <ShareBar on={bars} total={totalCl}
                        parts={TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => ({ name: t, value: tierMap[t] }))} />
                    </div>
                    <div className="mt-2">
                      {TIER_ORDER.filter((t) => tierMap[t] > 0).map((t) => (
                        <div key={t} className="grid grid-cols-[minmax(0,1fr)_56px_40px] items-center gap-3 min-h-[36px] text-[13px] [&+&]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                          <span><TierBadge tier={t} /></span>
                          <span className="text-right text-muted tabular-nums">{((tierMap[t] / totalCl) * 100).toFixed(1)}%</span>
                          <span className="text-right font-medium tabular-nums">{tierMap[t]}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <Blank h={200} text="No clients yet" />}
              </Block>
            }
            b={regions ? (
              <Block>
                <Head title="Where the profit is"
                  sub={`Client profit by state, or by country outside the US, all time${regions.unplaced ? `. ${plural(regions.unplaced, "client")} with no state or country` : ""}`} />
                {regions.list.length > 0 ? (
                  <>
                    <div className="mt-4">
                      {(() => {
                        const top = Math.max(1, ...regions.list.map((r) => Math.abs(r.profit)));
                        return regions.list.slice(0, 10).map((r, i) => (
                          <div key={r.region} className="mb-3 min-w-0">
                            <div className="flex items-center justify-between gap-3 mb-1.5 text-[13px]">
                              <span className="font-medium truncate">{r.label}</span>
                              <span className="flex-shrink-0 whitespace-nowrap">
                                <span className="text-faint tabular-nums">{plural(r.count, "client")}</span>
                                <span className={`ml-2 font-medium tabular-nums ${r.profit < 0 ? "text-danger-ink" : ""}`}>{fmtAmount(r.profit)}</span>
                              </span>
                            </div>
                            <Bar frac={Math.abs(r.profit) / top} on={bars} delay={i * 45}
                              tone={r.profit < 0 ? "bg-[rgb(var(--c-chart-loss))]" : "bg-faint"} />
                          </div>
                        ));
                      })()}
                    </div>
                    <button onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "globe" }))} className="ui-link mt-2">
                      See them on the globe
                    </button>
                  </>
                ) : <Blank h={160} text="No client has a state or country yet" />}
              </Block>
            ) : <Block><div className="h-40 rounded-xl bg-surface-2 animate-pulse" aria-busy="true" /></Block>}
          />
        </>
      )}
      </div>
    </div>
    {/* Outside the faded wrapper so the modal is never dimmed while a refresh runs. */}
    {labelling && (
      <DealLabelsModal focus={labelling.focus} onClose={(changed) => {
        setLabelling(null);
        if (changed) api.analyticsLabels(startDate, endDate).then(setLabels).catch(() => {});
      }} />
    )}
    </>
  );
}

// ─── Tables (memoised: a tab flip or a hover elsewhere must not rebuild hundreds of rows) ─────────

const RefundsTable = memo(function RefundsTable({ deals }: { deals: AnalyticsRefundDeal[] }) {
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[480px] px-1.5">
      <table className="ui-table ui-table-click min-w-[860px]">
        <thead>
          <tr>
            {["Invoice", "Buyer", "Closed", "Refunded on"].map((h) => <th key={h} className="sticky top-0 z-[2] bg-surface">{h}</th>)}
            {["Sold", "Refunded", "Result"].map((h) => <th key={h} className="r sticky top-0 z-[2] bg-surface">{h}</th>)}
            <th className="sticky top-0 z-[2] bg-surface">How it came out</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.deal_flow_id} onClick={() => d.invoice_number && openDealFlow(d.invoice_number, "refund")}
              title="Open this deal's refund step">
              <td className="whitespace-nowrap">{d.invoice_number || "No number"}</td>
              <td><div className="truncate max-w-[200px]">{d.client_name}</div></td>
              <td className="text-muted tabular-nums whitespace-nowrap">{d.closed_on}</td>
              <td className="text-muted tabular-nums whitespace-nowrap">{d.refunded_on || "None"}</td>
              <td className="r text-muted">{fmtAmount(d.sold)}</td>
              <td className="r">
                <span className={d.refunded > 0 ? "text-danger-ink" : "text-faint"}>{d.refunded > 0 ? signed(-d.refunded) : "None"}</span>
                {d.refunded > 0.005 && <span className="text-[12px] text-faint ml-1.5">{d.full ? "full" : "part"}</span>}
              </td>
              <td className={`r font-medium ${d.profit > 0.5 ? "text-success-ink" : d.profit < -0.5 ? "text-danger-ink" : ""}`}>{signed(d.profit)}</td>
              <td className="min-w-[220px]"><RefundOutcome d={d} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

const ReconTable = memo(function ReconTable({ recon, rows }: { recon: AnalyticsReconciliation; rows: AnalyticsReconciliation["deals"] }) {
  const t = recon.totals;
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[460px] px-1.5">
      <table className="ui-table min-w-[820px]">
        <thead>
          <tr>
            {["Invoice", "Buyer", "Closed"].map((h) => <th key={h} className="sticky top-0 z-[2] bg-surface">{h}</th>)}
            {["Money in", "Money out", "Refunds", "Profit", "True net"].map((h) => <th key={h} className="r sticky top-0 z-[2] bg-surface">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={`${d.invoice_number}-${i}`}>
              <td className="whitespace-nowrap">
                <div className="flex items-center gap-1.5">
                  <span>{d.invoice_number}</span>
                  {d.flags.slice(0, 2).map((f) => <span key={f} className="whitespace-nowrap"><StatusPill tone="warning">{f}</StatusPill></span>)}
                  {d.flags.length > 2 && <span className="ui-note">+{d.flags.length - 2}</span>}
                </div>
              </td>
              <td><div className="truncate max-w-[200px]">{d.client_name}</div></td>
              <td className="text-muted tabular-nums whitespace-nowrap">{d.completed_on}</td>
              <td className="r text-success-ink">{fmtAmount(d.money_in)}</td>
              <td className="r text-muted">{fmtAmount(d.money_out)}</td>
              <td className={`r ${d.refunds > 0 ? "text-danger-ink" : "text-faint"}`}>{d.refunds > 0 ? signed(-d.refunds) : "None"}</td>
              <td className={`r font-medium ${pnTone(d.profit)}`}>{signed(d.profit)}</td>
              <td className={`r font-medium ${pnTone(d.true_net_share)}`}>{signed(d.true_net_share)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className="sticky bottom-0 bg-surface whitespace-nowrap">{plural1(t.deal_count, "deal")}</td>
            <td className="sticky bottom-0 bg-surface" /><td className="sticky bottom-0 bg-surface" />
            <td className="r sticky bottom-0 bg-surface text-success-ink">{fmtAmount(t.money_in)}</td>
            <td className="r sticky bottom-0 bg-surface">{fmtAmount(t.money_out)}</td>
            <td className={`r sticky bottom-0 bg-surface ${t.refunds > 0 ? "text-danger-ink" : "text-faint"}`}>{t.refunds > 0 ? signed(-t.refunds) : "None"}</td>
            <td className={`r sticky bottom-0 bg-surface ${pnTone(t.profit)}`}>{signed(t.profit)}</td>
            <td className={`r sticky bottom-0 bg-surface ${pnTone(t.true_net_share)}`}>{signed(t.true_net_share)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
});
const plural1 = (n: number, w: string) => `${n} ${w}${n !== 1 ? "s" : ""}`;

const BoughtTable = memo(function BoughtTable({ deals }: { deals: AnalyticsRange["completed_deals"] }) {
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[460px] px-1.5 pb-3">
      <table className="ui-table min-w-[760px]">
        <thead>
          <tr>
            {["Closed", "Buyer", "Products", "Supplier"].map((h) => <th key={h} className="sticky top-0 z-[2] bg-surface">{h}</th>)}
            {["Revenue", "Profit"].map((h) => <th key={h} className="r sticky top-0 z-[2] bg-surface">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.deal_flow_id} className="align-top">
              <td className="text-muted tabular-nums whitespace-nowrap">{d.completed_on}</td>
              <td className="min-w-0">
                <div className="truncate max-w-[180px]">{d.client_name}</div>
                <div className="text-[12px] text-faint truncate max-w-[180px]">{d.invoice_number}</div>
              </td>
              <td className="text-muted min-w-0">
                {d.products.length > 0 ? (
                  <div className="max-w-[300px]">
                    {d.products.slice(0, 2).map((p, i) => (
                      <div key={i} className="truncate">{p.name}{p.qty > 1 ? ` x${p.qty}` : ""}</div>
                    ))}
                    {d.products.length > 2 && <div className="text-[12px] text-faint">+{d.products.length - 2} more</div>}
                  </div>
                ) : <span className="text-faint">None</span>}
              </td>
              <td className="text-muted min-w-0"><div className="truncate max-w-[160px]">{d.suppliers.join(", ") || "None"}</div></td>
              <td className="r text-muted">{fmtAmount(d.revenue)}</td>
              <td className={`r font-medium ${pnTone(d.net_profit)}`}>{signed(d.net_profit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ─── R-402: what sells, by category or by brand ──────────────────
// One row per category (or brand). Every closed deal in the range counts in exactly one row,
// so the rows add back to the KPI band's revenue and net profit. The toggle changes what the
// rows are measured and sorted by, never which rows exist. A loss wears the loss hue; Uncategorized
// and No brand are not categories and wear the faint ink. Any row opens the labelling screen on its own deals.
function LabelCard({ kind, labels, metric, setMetric, rangeLabel, bars, onOpen }: {
  kind: "category" | "brand";
  labels: AnalyticsLabels | null;
  metric: "revenue" | "profit";
  setMetric: (m: "revenue" | "profit") => void;
  rangeLabel: string;
  bars: boolean;
  onOpen: (focus: LabelFocus | null) => void;
}) {
  const noun = kind === "category" ? "category" : "brand";
  const none = kind === "category" ? "Uncategorized" : "No brand";
  const rows: LabelRow[] = labels ? (kind === "category" ? labels.categories : labels.brands) : [];
  const sorted = [...rows].sort((a, b) => (b[metric] - a[metric]) || a.name.localeCompare(b.name));
  const top = Math.max(1, ...sorted.map((r) => Math.abs(r[metric])));
  const missing = labels ? (kind === "category" ? labels.uncategorized : labels.unbranded) : 0;
  const guessed = labels ? (kind === "category" ? labels.categories_guessed : labels.brands_guessed) : 0;
  const n = labels?.deals ?? 0;
  return (
    <Block>
      <Head
        title={`${metric === "revenue" ? "Revenue" : "Profit"} by ${noun}`}
        sub={labels ? `${n} closed deal${n !== 1 ? "s" : ""} in ${rangeLabel}, one ${noun} each` : `Closed deals in ${rangeLabel}`}
        right={
          <Tabs label={`${noun} measure`} value={metric} onChange={(id) => setMetric(id as "revenue" | "profit")}
            tabs={[{ id: "revenue", label: "Revenue" }, { id: "profit", label: "Profit" }]} />
        } />
      {sorted.length > 0 ? (
        <>
          <div className="mt-3 max-h-[344px] overflow-y-auto -mx-1.5 px-0.5">
            {sorted.map((r, i) => {
              const isNone = r.name === none;
              const value = r[metric];
              const margin = r.revenue > 0 ? (r.profit / r.revenue) * 100 : null;
              return (
                <button key={r.name} onClick={() => onOpen({ kind, name: r.name })}
                  title={`Open the ${r.deals} deal${r.deals !== 1 ? "s" : ""} in ${r.name}`}
                  className="block w-full text-left rounded-lg px-1.5 py-2 min-h-[52px] hover:bg-surface-2 transition-colors duration-[130ms] min-w-0">
                  <span className="flex items-baseline justify-between gap-3 mb-1.5 min-w-0 text-[13px]">
                    <span className={`truncate font-medium ${isNone ? "text-muted" : ""}`}>{r.name}</span>
                    <span className="flex items-baseline gap-2.5 flex-shrink-0 whitespace-nowrap">
                      {r.guessed > 0 && !isNone && <span className="text-faint tabular-nums">{r.guessed} guessed</span>}
                      <span className="text-muted tabular-nums">{r.deals} deal{r.deals !== 1 ? "s" : ""}</span>
                      {metric === "profit" && margin !== null && <span className="text-muted tabular-nums">{margin.toFixed(1)}% margin</span>}
                      <span className={`font-medium tabular-nums min-w-[84px] text-right ${metric === "profit" ? pnTone(value) : ""}`}>{signed(value)}</span>
                    </span>
                  </span>
                  <Bar frac={Math.abs(value) / top} on={bars} delay={Math.min(i, 12) * 40}
                    tone={value < 0 ? "bg-[rgb(var(--c-chart-loss))]" : isNone ? "bg-line-3" : "bg-faint"} />
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="ui-note m-0 min-w-0">
              {missing > 0 ? `${missing} deal${missing !== 1 ? "s" : ""} with no ${noun} yet` : `Every deal has a ${noun}`}
              {guessed > 0 ? `, ${guessed} guessed and not confirmed` : ""}.
            </p>
            <button onClick={() => onOpen(null)} className="ui-link flex-shrink-0">
              Identify {kind === "category" ? "categories" : "brands"}
            </button>
          </div>
        </>
      ) : <Blank h={230} text={labels ? "No closed deals in this range" : "Reading your deals"} />}
    </Block>
  );
}

// A concentration reading is a risk statement: past its threshold it wears the warning ink, so
// "the top buyer is 61% of revenue" is not something you have to notice yourself.
function Concentration({ label, pct, warnAt, unit }: { label: string; pct: number; warnAt: number; unit: string }) {
  const hot = pct >= warnAt;
  return (
    <div className="min-w-0">
      <div className="ui-label truncate">{label}</div>
      <div className={`ui-fig !text-[22px] !leading-7 mt-1 ${hot ? "text-warning-ink" : ""}`}>{pct.toFixed(0)}%</div>
      <div className="ui-note">{unit}</div>
    </div>
  );
}

function Highlight({ label, name, sub, value, valueCls = "", amount }: {
  label: string; name: string | null; sub: string | null; value: string | null; valueCls?: string; amount: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 min-w-0 [&+&]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
      <div className="min-w-0">
        <div className="ui-note">{label}</div>
        {name ? (
          <>
            <div className="text-[14px] font-medium truncate">{name}</div>
            {sub && <div className="ui-note truncate">{sub}</div>}
          </>
        ) : <div className="text-[13px] text-faint mt-0.5">Nothing in this range</div>}
      </div>
      {value && (
        <div className="text-right flex-shrink-0">
          <div className={`text-[16px] font-medium tabular-nums ${valueCls}`}>{value}</div>
          {amount && <div className="ui-note tabular-nums">{amount}</div>}
        </div>
      )}
    </div>
  );
}

// ─── R-317 bridge ─────────────────────────────────────────────────
// A waterfall read as a statement rather than drawn as a chart: label left, amount right, tabular
// figures, and a hairline above every line that has to tie. Amounts arrive already signed, so the list
// never re-decides what a line means. Money arriving wears green, money leaving is plain ink, and only a
// subtotal that is itself negative goes red. The drift note is the reason this section exists: when a
// subtotal read from the book disagrees with the lines above it, the list says so underneath, in red.
function BridgeList({ rows }: { rows: ReconRow[] }) {
  return (
    <div className="min-w-0">
      {rows.map((r) => {
        const heavy = r.kind === "subtotal" || r.kind === "total";
        const drift = r.drift ?? 0;
        const light =
          r.kind === "residual" ? (Math.abs(r.amount) < 0.005 ? "text-faint" : "text-danger-ink")
          : r.amount >= 0 ? "text-success-ink" : "text-ink";
        return (
          <div key={r.label} className="min-w-0">
            {heavy && <div className="hsep my-1.5" />}
            <div className="flex items-baseline justify-between gap-3 min-w-0 py-1.5">
              <div className="min-w-0">
                <div className={`truncate text-[14px] ${heavy ? "font-medium text-ink" : "text-muted"}`}>{r.label}</div>
                {r.hint && <div className="ui-note truncate">{r.hint}</div>}
              </div>
              <span className={`tabular-nums flex-shrink-0 text-[14px] ${heavy ? `font-medium ${pnTone(r.amount)}` : light}`}>
                {signed(r.amount)}
              </span>
            </div>
            {Math.abs(drift) >= 0.005 && (
              <p className="ui-note text-danger-ink pb-1.5 m-0">
                Does not tie: the lines above come to {signed(r.running ?? 0)}, a difference
                of {signed(drift)}.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Whether a bank column ties to its ledger figure, and by how much when it does not. It always
// renders: "no note" and "ties to the cent" must not look the same.
function Gap({ label, gap, against, because }: { label: string; gap: number; against: string; because?: string }) {
  if (Math.abs(gap) < 0.005) return <p className="m-0">{label} matches {against} to the cent.</p>;
  return (
    <p className={`m-0 ${because ? "" : "text-danger-ink"}`}>
      {label} is {fmtAmount(Math.abs(gap))} {gap > 0 ? "more than" : "less than"} {against}
      {because ? `: ${because}` : ""}.
    </p>
  );
}

// ─── R-319 pace summary ───────────────────────────────────────────
// The sentence is the answer; the chart is the evidence. Ahead reads green, behind reads red.
function PaceSummary({ pace, metric }: { pace: AnalyticsPace; metric: "revenue" | "profit" }) {
  const now  = metric === "revenue" ? pace.revenue_so_far      : pace.profit_so_far;
  const prev = metric === "revenue" ? pace.prev_at_day_revenue : pace.prev_at_day_profit;
  const avg  = metric === "revenue" ? pace.avg_at_day_revenue  : pace.avg_at_day_profit;
  const proj = metric === "revenue" ? pace.projected_revenue   : pace.projected_profit;
  const word = metric === "revenue" ? "Revenue" : "Profit";
  const Delta = ({ v }: { v: number }) => (
    <b className={`font-medium tabular-nums ${v >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
      {fmtAmount(Math.abs(v))} {v >= 0 ? "ahead" : "behind"}
    </b>
  );
  return (
    <p className="text-[14px] leading-[22px] text-muted mt-4 mb-0">
      <b className="text-ink font-medium">Day {pace.day_of_month}</b> of {pace.days_in_month}. {word} is{" "}
      <b className="text-ink font-medium tabular-nums">{signed(now)}</b>
      {pace.prior_count > 0 ? (
        <>
          , which is <Delta v={now - prev} /> of where {longMonth(pace.prev_month)} stood on
          day {pace.day_of_month}, and <Delta v={now - avg} /> of the {pace.prior_count}-month average for this day.
        </>
      ) : <>. There is no earlier month to compare it against yet.</>}
      {" "}At this pace the month finishes near <b className="text-ink font-medium tabular-nums">{signed(proj)}</b>.
    </p>
  );
}

/** R-444: how a refunded deal came out, worded the same on the phone (`anRefundOutcome`). */
function RefundOutcome({ d }: { d: AnalyticsRefundDeal }) {
  if (d.status === "owed") return <StatusPill tone="warning">{`${fmtAmount(d.remaining)} still to send back`}</StatusPill>;
  if (d.status === "cancelled") return <StatusPill tone="success">Cancelled out</StatusPill>;
  if (d.status === "kept") return <StatusPill tone="neutral">Kept the rest</StatusPill>;
  if (d.status === "cost_here") return (
    <div className="min-w-0">
      <StatusPill tone="danger">Supplier cost still here</StatusPill>
      <div className="ui-note mt-1 whitespace-normal">
        Link the supplier's money back on its refund step, or move the cost if the goods were resold.
      </div>
    </div>
  );
  if (d.status === "loss_kept") return <StatusPill tone="danger">A real loss</StatusPill>;
  return <StatusPill tone="danger">Refund more than it made</StatusPill>;
}
