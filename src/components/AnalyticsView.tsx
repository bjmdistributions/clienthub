import { useEffect, useRef, useState } from "react";
import { api, DashboardStats } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import TierBadge from "./TierBadge";

// ─── Palette ─────────────────────────────────────────────────────
// One primary accent, semantic green/red, nothing competing.
const CLR = {
  indigo:  "#6366f1",   // primary — revenue bars, category bars
  emerald: "#10b981",   // profit positive, paid invoices
  rose:    "#f43f5e",   // negative / overdue
  amber:   "#f59e0b",   // warning / outstanding
  sky:     "#38bdf8",   // sent invoices
  slate:   "#cbd5e1",   // draft / neutral
};

const STATUS_CLR: Record<string, string> = {
  paid:            CLR.emerald,
  sent:            CLR.sky,
  overdue:         CLR.rose,
  draft:           CLR.slate,
};

const TIER_CLR: Record<string, string> = {
  S:        "#7c3aed",
  A:        CLR.amber,
  B:        "#94a3b8",
  C:        "#b45309",
  Prospect: "#e2e8f0",
};

const TIER_ORDER = ["S", "A", "B", "C", "Prospect"];

const TT = {
  contentStyle: {
    background: "#09090B",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 10,
    color: "#fff",
    fontSize: 12,
    padding: "9px 13px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
  },
  cursor: { fill: "rgba(99,102,241,0.05)" },
};

const AX = { fontSize: 10, fill: "#9ca3af" };

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
const today = new Date().toISOString().slice(0, 10);
const firstDayOfMonth = today.slice(0, 7) + "-01";
const firstDayOfYear  = today.slice(0, 4) + "-01-01";
const PRESETS = [
  { label: "All Time",    start: "", end: "" },
  { label: "This Year",   start: firstDayOfYear, end: today },
  { label: "This Month",  start: firstDayOfMonth, end: today },
] as const;

// ─── Main view ───────────────────────────────────────────────────
export default function AnalyticsView() {
  const [stats,     setStats]     = useState<DashboardStats | null>(null);
  const [rangeData, setRangeData] = useState<any | null>(null);
  const [tiers,     setTiers]     = useState<any[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [bars,      setBars]      = useState(false);
  const [preset,    setPreset]    = useState<string>("All Time");
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
    setPreset(p.label);
    setStartDate(p.start);
    setEndDate(p.end);
    loadRange(p.start, p.end);
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
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!loading && stats) setTimeout(() => setBars(true), 120);
  }, [loading, stats]);

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <RefreshCw size={15} className="text-gray-200 animate-spin" />
    </div>
  );
  if (!stats) return (
    <div className="text-center py-32 text-[13px] text-gray-300">No data yet</div>
  );

  // ── Derived ───────────────────────────────────────────────────
  const monthlySource = rangeData?.monthly_profit ?? stats.monthly_profit;
  const monthly = monthlySource.map((m: any) => ({
    ...m,
    month: new Date(m.month + "-01").toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
  }));

  const tierMap  = tiers.reduce((acc: Record<string, number>, t: any) => {
    acc[t.tier] = (acc[t.tier] || 0) + 1; return acc;
  }, {});
  const totalCl  = tiers.length;
  const maxSpend = Math.max(...stats.top_spenders.map((c) => c.total_spent), 1);
  const totalSV  = stats.invoice_status_breakdown.reduce((s, x) => s + x.total, 0);
  const cats     = stats.category_breakdown.filter((c) => c.client_count > 0);
  const maxCat   = Math.max(...cats.map((c) => c.revenue), 1);

  // ── Layout ───────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Analytics</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">Business performance overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Preset pills */}
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
                preset === p.label
                  ? "bg-indigo-600 text-white"
                  : "bg-white border border-gray-200 text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
              }`}
            >
              {p.label}
            </button>
          ))}
          {/* Custom range */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border border-gray-200 h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
            />
            <span className="text-[11px] text-gray-400">to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border border-gray-200 h-8 px-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
            />
            <button
              onClick={applyCustomRange}
              className="px-3 h-8 bg-white border border-gray-200 rounded-lg text-[12px] text-gray-500 hover:border-indigo-400 hover:text-indigo-600 transition-colors"
            >
              Apply
            </button>
          </div>
          <button onClick={load}
            className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-700
                       px-2.5 h-8 rounded-lg hover:bg-gray-100 transition-colors border border-gray-200">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {/* ── KPI row ──────────────────────────────────────────────
          Revenue spans 2 cols and gets the indigo top-accent treatment.
          All other cards are neutral white — numbers carry the weight.
      ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">

        {/* Revenue hero */}
        <div className="col-span-2 md:col-span-2 lg:col-span-2 bg-white rounded-xl p-5
                        border border-gray-100 border-t-[3px] border-t-indigo-500
                        animate-fade-up [animation-fill-mode:backwards]
                        hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] transition-shadow">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3">
            Revenue {preset === "All Time" ? "All Time" : preset}
          </div>
          <div className="text-[32px] font-bold text-indigo-600 tabular-nums leading-none tracking-tight">
            {fmtAmount(aRevenue)}
          </div>
          <div className="text-[11px] text-gray-300 mt-2">Total closed deal revenue</div>
        </div>

        <StatCard label="Net Profit"   delay={65}
          color={(displayStats?.total_profit ?? 0) >= 0 ? CLR.emerald : CLR.rose}>
          {fmtAmount(aProfit)}
        </StatCard>

        <StatCard label="Avg Margin"   delay={130}>{aMargin.toFixed(1)}%</StatCard>

        <StatCard label="Outstanding"  delay={195}
          color={stats.outstanding > 0 ? CLR.amber : undefined}>
          {fmtAmount(aOutstanding)}
        </StatCard>
      </div>

      {/* ── Monthly Revenue vs Profit ──────────────────────────────
          Grouped BarChart — two bars side by side per month.
          No ComposedChart / Line so single-month data still looks fine.
      ─────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-100 rounded-xl p-5
                      animate-fade-up [animation-fill-mode:backwards] stagger-2">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">Monthly Revenue vs Profit</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              {monthly.length > 0 ? `Last ${monthly.length} month${monthly.length !== 1 ? "s" : ""}` : "No data"}
            </p>
          </div>
          <div className="flex items-center gap-5 mt-0.5">
            <Legend color={CLR.indigo}  label="Revenue" />
            <Legend color={CLR.emerald} label="Profit"  />
          </div>
        </div>

        {monthly.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthly} barCategoryGap="38%" barGap={3}
                      margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="#F1F5F9" vertical={false} />
              <XAxis dataKey="month" tick={AX} axisLine={false} tickLine={false} />
              <YAxis tick={AX} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => fmtAmount(Number(v))} {...TT} />
              <Bar dataKey="revenue" name="Revenue" fill={CLR.indigo}
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

      {/* ── Row: Invoice Status + Top Spenders ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Invoice Status */}
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-2">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Invoice Status</h3>
          <p className="text-[11px] text-gray-400 mb-5">{stats.invoices} total invoices</p>

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
                        <span className="text-[12px] text-gray-700 capitalize">
                          {s.status.replace("_", " ")}
                        </span>
                        <span className="text-[10px] text-gray-300">({s.count})</span>
                      </div>
                      <span className="text-[12px] font-semibold text-gray-800 tabular-nums">
                        {fmtAmount(s.total)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
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
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-3">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Top Spenders</h3>
          <p className="text-[11px] text-gray-400 mb-4">By total revenue collected</p>

          {stats.top_spenders.length > 0 ? (
            <div className="space-y-1">
              {stats.top_spenders.map((c, i) => (
                <div key={i} className="relative rounded-xl overflow-hidden
                                        animate-fade-up [animation-fill-mode:backwards]"
                  style={{ animationDelay: `${i * 50}ms` }}>
                  {/* Proportional fill behind each row */}
                  <div className="absolute inset-y-0 left-0 rounded-xl transition-all duration-700 ease-out"
                    style={{
                      width: bars ? `${(c.total_spent / maxSpend) * 100}%` : "0%",
                      background: "rgba(99,102,241,0.06)",
                      transitionDelay: `${200 + i * 70}ms`,
                    }} />
                  <div className="relative flex items-center gap-3 px-4 py-3.5">
                    <span className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center
                                      justify-center text-[10px] font-bold text-white ${
                      i === 0 ? "bg-amber-400" :
                      i === 1 ? "bg-slate-400" :
                      i === 2 ? "bg-amber-700/70" : "bg-gray-200"
                    }`}>{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-gray-900 truncate">{c.name}</div>
                      <div className="text-[11px] text-gray-400">
                        {c.invoice_count} invoice{c.invoice_count !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[13px] font-semibold text-gray-900 tabular-nums">
                        {fmtAmount(c.total_spent)}
                      </div>
                      <div className={`text-[10px] tabular-nums ${
                        c.total_profit >= 0 ? "text-emerald-600" : "text-rose-500"
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Client Tiers */}
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-2">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Client Tiers</h3>
          <p className="text-[11px] text-gray-400 mb-5">{totalCl} clients</p>

          {totalCl > 0 ? (
            <>
              {/* Segmented pill */}
              <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden flex mb-5">
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
                                             border-b border-gray-50 last:border-0">
                      <TierBadge tier={t} />
                      <div className="flex items-center gap-4">
                        <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700 ease-out"
                            style={{
                              width: bars ? `${(n / totalCl) * 100}%` : "0%",
                              backgroundColor: TIER_CLR[t],
                              transitionDelay: `${200 + i * 60}ms`,
                            }} />
                        </div>
                        <span className="text-[11px] text-gray-400 w-9 text-right tabular-nums">
                          {((n / totalCl) * 100).toFixed(1)}%
                        </span>
                        <span className="text-[14px] font-bold text-gray-900 tabular-nums w-5 text-right">
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
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-3">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Category Breakdown</h3>
          <p className="text-[11px] text-gray-400 mb-5">Revenue by client category</p>

          {cats.length > 0 ? (
            <div className="space-y-4 max-h-[280px] overflow-y-auto pr-1">
              {cats.map((c, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] font-medium text-gray-700 truncate max-w-[160px]">
                      {c.category}
                    </span>
                    <div className="flex items-center gap-2.5 ml-2 flex-shrink-0">
                      <span className="text-[11px] text-gray-400">
                        {c.client_count} client{c.client_count !== 1 ? "s" : ""}
                      </span>
                      {c.revenue > 0 && (
                        <span className="text-[12px] font-semibold text-gray-800 tabular-nums">
                          {fmtAmount(c.revenue)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700 ease-out"
                      style={{
                        width: c.revenue > 0 && bars ? `${(c.revenue / maxCat) * 100}%` : "0%",
                        backgroundColor: CLR.indigo,
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Most Profitable */}
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-2">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Most Profitable</h3>
          <p className="text-[11px] text-gray-400 mb-5">By net profit margin</p>

          {((rangeData?.top_clients_by_profit ?? stats.top_clients_by_profit) as any[]).length > 0 ? (
            <div>
              {((rangeData?.top_clients_by_profit ?? stats.top_clients_by_profit) as any[]).map((c: any, i: number) => (
                <div key={i} className="py-3 border-b border-gray-50 last:border-0">
                  <div className="flex items-start justify-between mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-900 truncate">{c.name}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5 tabular-nums">
                        {fmtAmount(c.total_revenue)} revenue
                      </div>
                    </div>
                    <div className="text-right ml-3 flex-shrink-0">
                      <div className={`text-[13px] font-semibold tabular-nums ${
                        c.total_profit >= 0 ? "text-emerald-600" : "text-rose-500"
                      }`}>{fmtAmount(c.total_profit)}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {c.margin.toFixed(1)}% margin
                      </div>
                    </div>
                  </div>
                  <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
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

        {/* Financial snapshot */}
        <div className="bg-white border border-gray-100 rounded-xl p-5
                        animate-fade-up [animation-fill-mode:backwards] stagger-3">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-5">
            Financial Snapshot
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              { label: "Total Revenue",  value: fmtAmount(stats.paid_ytd),         clr: "#111827" },
              { label: "Total Cost",     value: fmtAmount(stats.total_cost),        clr: "#111827" },
              { label: "Net Profit",     value: fmtAmount(stats.total_profit),
                clr: stats.total_profit >= 0 ? CLR.emerald : CLR.rose },
              { label: "Avg Margin",     value: `${stats.avg_margin.toFixed(1)}%`, clr: "#111827" },
              { label: "Outstanding",    value: fmtAmount(stats.outstanding),       clr: CLR.amber },
              { label: "Open Closeouts", value: String(stats.incomplete_shipping),  clr: "#111827" },
            ].map((item) => (
              <div key={item.label}>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
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

    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────

function StatCard({
  label, children, color, delay = 0,
}: {
  label: string;
  children: React.ReactNode;
  color?: string;
  delay?: number;
}) {
  return (
    <div
      className="bg-white border border-gray-100 rounded-xl p-4
                 animate-fade-up [animation-fill-mode:backwards]
                 hover:shadow-[0_4px_14px_rgba(0,0,0,0.06)] transition-shadow"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2.5">
        {label}
      </div>
      <div
        className="text-[22px] font-bold tabular-nums leading-none"
        style={{ color: color ?? "#111827" }}
      >
        {children}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
      <span className="text-[11px] text-gray-500">{label}</span>
    </div>
  );
}

function Blank({ h = 160, text = "No data yet" }: { h?: number; text?: string }) {
  return (
    <div className="flex items-center justify-center text-[12px] text-gray-300"
      style={{ height: h }}>
      {text}
    </div>
  );
}
