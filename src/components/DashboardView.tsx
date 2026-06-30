import { useEffect, useState, useRef } from "react";
import { api, DashboardStats, Client, Invoice, BuyerTier, ProfitForecast, Note, Newsletter } from "../lib/api";
import { fmtCompactCurrency, fmtFullAmount, fmtAmount } from "../lib/format";
import {
  Users, FileText, DollarSign, TrendingUp, Mail,
  ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Package, StickyNote,
} from "lucide-react";

const NOTE_ACCENT: Record<string, string> = {
  yellow: "#FACC15", blue: "#60A5FA", green: "#34D399", pink: "#F472B6", purple: "#A78BFA", orange: "#FB923C",
};
function relNote(iso: string): string {
  const d = new Date(iso).getTime();
  if (!d) return "";
  const m = Math.floor((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import TierBadge from "./TierBadge";

interface Props {
  onNavigate: (t: any) => void;
}

const invStatusStyle = (s: string): React.CSSProperties => {
  const lo = s.toLowerCase();
  if (lo === "paid")    return { background: "rgba(16,185,129,0.12)",  color: "rgb(var(--c-success))", border: "1px solid rgba(16,185,129,0.25)" };
  if (lo === "sent")    return { background: "rgba(59,130,246,0.12)",  color: "rgb(var(--c-info))", border: "1px solid rgba(59,130,246,0.25)" };
  if (lo === "overdue") return { background: "rgba(239,68,68,0.12)",   color: "rgb(var(--c-danger))", border: "1px solid rgba(239,68,68,0.25)" };
  return { background: "rgba(107,114,128,0.1)", color: "var(--t-tx3)", border: "1px solid rgba(107,114,128,0.2)" };
};

function CompactAmount({ value }: { value: number }) {
  const full = fmtFullAmount(value);
  const compact = fmtCompactCurrency(value);
  if (full === compact) return <>{compact}</>;
  return (
    <span className="compact-amount" data-tip={full}>
      {compact}
    </span>
  );
}

function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(0);
  const [popped, setPopped] = useState(false);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    setPopped(false);
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setValue(target);
        setPopped(true);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return { value, popped };
}

function AnimatedStat({ value }: { value: number }) {
  const { value: current, popped } = useCountUp(value);
  return (
    <span className={popped ? "animate-number-pop inline-block" : "inline-block"}>
      {current.toLocaleString()}
    </span>
  );
}

export default function DashboardView({ onNavigate }: Props) {
  const [stats, setStats]             = useState<DashboardStats | null>(null);
  const [followups, setFollowups]     = useState<Client[]>([]);
  const [pendingApprovals, setPending] = useState<Client[]>([]);
  const [recentInvoices, setRecent]   = useState<Invoice[]>([]);
  const [notes, setNotes]             = useState<Note[]>([]);
  const [clients, setClients]         = useState<Client[]>([]);
  const [tiers, setTiers]             = useState<BuyerTier[]>([]);
  const [profitMonth, setProfitMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [dailyProfit, setDailyProfit] = useState<{ day: string; profit: number }[]>([]);
  const [forecast, setForecast] = useState<ProfitForecast | null>(null);
  const [sentNewsletters, setSentNewsletters] = useState<Newsletter[]>([]);

  const loadAll = () => {
    api.dashboardStats().then(setStats).catch(console.error);
    api.getProfitForecast().then(setForecast).catch(() => {});
    api.dueFollowups().then(setFollowups).catch(() => {});
    api.getPendingApprovals().then(setPending).catch(() => {});
    api.listInvoices().then((inv) => setRecent(inv.slice(0, 50))).catch(() => {});
    api.listNotes().then(setNotes).catch(() => {});
    api.listNewsletters().then((ns) => setSentNewsletters(ns.filter((n) => n.status === "sent").slice(0, 5))).catch(() => {});
  };

  const loadProfitMonth = async (m: string) => {
    const raw = await api.getMonthlyProfit(m);
    const [y, mo] = m.split("-").map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === mo;
    const profitMap: Record<string, number> = {};
    raw.forEach((r) => { profitMap[r.day] = r.profit; });
    const maxDataDay = raw.length > 0
      ? Math.max(...raw.map((r) => parseInt(r.day.split("-")[2], 10)))
      : 0;
    const lastDay = isCurrentMonth ? Math.max(today.getDate(), maxDataDay) : daysInMonth;
    let cumulative = 0;
    const data = [];
    for (let d = 1; d <= lastDay; d++) {
      const dayStr = `${m}-${String(d).padStart(2, "0")}`;
      cumulative += profitMap[dayStr] || 0;
      data.push({ day: String(d), profit: cumulative });
    }
    setDailyProfit(data);
  };

  useEffect(() => {
    loadAll();
    api.listClients().then(setClients).catch(console.error);
    api.buyerTiers().then(setTiers).catch(console.error);
    loadProfitMonth(profitMonth);
  }, []);

  const changeMonth = (dir: 1 | -1) => {
    const [y, m] = profitMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    setProfitMonth(next);
    loadProfitMonth(next);
  };

  const monthLabel = new Date(
    Number(profitMonth.split("-")[0]),
    Number(profitMonth.split("-")[1]) - 1
  ).toLocaleString("default", { month: "long", year: "numeric" });

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const profitMtd     = stats?.profit_mtd      ?? 0;
  const revenueMtd    = stats?.revenue_mtd     ?? 0;
  const allTimeRev    = stats?.all_time_revenue ?? 0;
  const allTimeProfit = stats?.all_time_profit  ?? 0;

  type KpiDef = {
    label: string; sub: string;
    displayValue: React.ReactNode;
    icon: any; tab: string;
    accent: string; iconBg: string;
  };

  const kpis: KpiDef[] = [
    { label: "Total Clients",    sub: "in account",           displayValue: <AnimatedStat value={stats?.clients ?? 0} />,          icon: Users,      tab: "clients",   accent: "kpi-accent-indigo",  iconBg: "icon-bg-indigo"  },
    { label: "Outstanding",      sub: "awaiting payment",     displayValue: <CompactAmount value={stats?.outstanding ?? 0} />,      icon: DollarSign, tab: "invoices",  accent: "kpi-accent-amber",   iconBg: "icon-bg-amber"   },
    { label: "Revenue MTD",      sub: "closed this month",    displayValue: <CompactAmount value={revenueMtd} />,                   icon: TrendingUp, tab: "analytics", accent: "kpi-accent-emerald", iconBg: "icon-bg-emerald" },
    { label: "Profit MTD",       sub: "closed this month",    displayValue: <CompactAmount value={profitMtd} />,                    icon: TrendingUp, tab: "analytics", accent: profitMtd >= 0 ? "kpi-accent-emerald" : "kpi-accent-rose", iconBg: profitMtd >= 0 ? "icon-bg-emerald" : "icon-bg-rose" },
    { label: "All-Time Revenue", sub: "from closed deals",    displayValue: <CompactAmount value={allTimeRev} />,                   icon: DollarSign, tab: "analytics", accent: "kpi-accent-emerald", iconBg: "icon-bg-emerald"  },
    { label: "All-Time Profit",  sub: "from closed deals",    displayValue: <CompactAmount value={allTimeProfit} />,                 icon: TrendingUp, tab: "analytics", accent: allTimeProfit >= 0 ? "kpi-accent-emerald" : "kpi-accent-rose", iconBg: allTimeProfit >= 0 ? "icon-bg-emerald" : "icon-bg-rose" },
    { label: "Deals MTD",        sub: "completed this month", displayValue: <AnimatedStat value={stats?.deals_mtd ?? 0} />,         icon: FileText,   tab: "deals",     accent: "kpi-accent-indigo",  iconBg: "icon-bg-indigo"  },
    { label: "Active Deals",     sub: "in pipeline",          displayValue: <AnimatedStat value={stats?.pipeline_count ?? 0} />,    icon: FileText,   tab: "dealflow",  accent: "kpi-accent-indigo",  iconBg: "icon-bg-indigo"  },
  ];

  const weekStats = [
    { label: "Revenue",      value: <CompactAmount value={stats?.revenue_this_week ?? 0} />, color: "rgb(var(--c-success))" },
    { label: "New Clients",  value: String(stats?.clients_this_week ?? 0),                   color: "rgb(var(--c-accent))" },
    { label: "Interactions", value: String(stats?.interactions_this_week ?? 0),              color: "rgb(var(--c-accent))" },
  ];

  const topBuyers = tiers.filter((h) => h.tier === "S" || h.tier === "A").slice(0, 5);
  const staggerClass = (i: number) => `animate-fade-up stagger-${Math.min(i + 1, 8)}`;

  // Reusable card style
  const cardStyle: React.CSSProperties = { border: "1px solid var(--t-b1)", boxShadow: "var(--shadow-card)", background: "var(--t-s1)" };

  return (
    <div className="min-h-full flex flex-col" style={{ background: "var(--t-bg)" }}>

      {/* ── Page Header ─────────────────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between flex-shrink-0"
        style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)", boxShadow: "0 1px 0 rgba(0,0,0,0.04)" }}>
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Dashboard</h2>
          <p className="text-[12px] mt-0.5" style={{ color: "var(--t-tx4)" }}>{dateStr}</p>
        </div>
        <div className="flex items-center gap-4 flex-wrap justify-end">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5" style={{ color: "var(--t-tx4)" }}>Outstanding</p>
            <p className="text-[15px] font-bold tabular-nums leading-none" style={{ color: "rgb(var(--c-warning))" }}>
              <CompactAmount value={stats?.outstanding ?? 0} />
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5" style={{ color: "var(--t-tx4)" }}>Profit MTD</p>
            <p className="text-[15px] font-bold tabular-nums leading-none" style={{ color: profitMtd >= 0 ? "rgb(var(--c-success))" : "rgb(var(--c-danger))" }}>
              <CompactAmount value={profitMtd} />
            </p>
          </div>
          <button
            onClick={() => onNavigate("invoices")}
            className="btn-ripple flex items-center gap-1.5 text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-all duration-150 hover:-translate-y-px"
            style={{
              background: "linear-gradient(135deg, var(--accent-600), var(--accent-500))",
              boxShadow: "0 2px 10px var(--accent-glow), 0 1px 2px var(--accent-glow)",
            }}
          >
            <FileText size={13} /> Invoices
          </button>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────── */}
      <div className="flex-1 p-6 flex flex-col gap-5">

        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {stats === null ? Array.from({ length: 8 }).map((_, i) => (
            <div key={`kpi-sk-${i}`} className={`rounded-xl p-4 ${staggerClass(i)}`} style={cardStyle}>
              <div className="skeleton w-7 h-7 rounded-lg mb-2.5" />
              <div className="skeleton h-2.5 w-3/4 mb-2.5" />
              <div className="skeleton h-4 w-1/2 mb-2.5" />
              <div className="skeleton h-2.5 w-2/3" />
            </div>
          )) : kpis.map((k, i) => {
            const Icon = k.icon;
            return (
              <button
                key={k.label}
                onClick={() => onNavigate(k.tab)}
                className={`text-left group relative overflow-hidden rounded-xl p-4 transition-all duration-200 hover:-translate-y-0.5 ${k.accent} ${staggerClass(i)}`}
                style={cardStyle}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)")}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "var(--shadow-card)")}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center mb-2.5 ${k.iconBg}`}>
                  <Icon size={13} strokeWidth={2} />
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-widest mb-2 truncate" style={{ color: "var(--t-tx4)" }}>{k.label}</div>
                <div className="text-[18px] font-bold tabular-nums leading-none mb-1.5" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>
                  {k.displayValue}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px]" style={{ color: "var(--t-tx4)" }}>{k.sub}</span>
                  <ArrowRight size={9} className="opacity-0 group-hover:opacity-60 group-hover:translate-x-0.5 transition-all duration-150" style={{ color: "var(--t-tx3)" }} />
                </div>
              </button>
            );
          })}
        </div>

        {/* Forecast card */}
        {forecast && (
          <div className="rounded-xl p-5 animate-fade-up stagger-2" style={{
            background: "var(--t-s1)",
            border: "1px solid var(--t-b1)",
            borderLeft: "3px solid rgb(var(--c-accent))",
            boxShadow: "var(--shadow-xs)",
          }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)" }}>Profit Projection</h3>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>
                  Estimated month-end profit based on pipeline
                </p>
              </div>
              <div className="flex items-center gap-4 text-[12px]">
                <span style={{ color: "var(--t-tx3)" }}>Actual <span className="font-semibold" style={{ color: "var(--t-tx1)" }}>{fmtAmount(forecast.actual_profit_mtd)}</span></span>
                <span style={{ color: "var(--t-tx3)" }}>Projected <span className="font-semibold" style={{ color: "rgb(var(--c-accent))" }}>{fmtAmount(forecast.projected_profit)}</span></span>
                <span className="px-2.5 py-1 rounded-full text-[11px] font-bold" style={{ background: "rgb(var(--c-accent) / 0.1)", color: "rgb(var(--c-accent))" }}>{fmtAmount(forecast.total_forecast)}</span>
              </div>
            </div>

            {forecast.open_deal_count > 0 ? (
              <>
                <div className="w-full h-2 rounded-full mb-2" style={{ background: "var(--t-s3)", overflow: "hidden" }}>
                  {(() => {
                    const total = Math.max(forecast.total_forecast, forecast.actual_profit_mtd + forecast.projected_profit);
                    if (total <= 0) return null;
                    const actualPct = Math.max(0, (forecast.actual_profit_mtd / total) * 100);
                    const projPct = Math.max(0, (forecast.projected_profit / total) * 100);
                    return (
                      <>
                        <div style={{ background: "rgb(var(--c-success))", height: "100%", width: `${actualPct}%`, float: "left", borderRadius: "4px 0 0 4px" }} />
                        <div style={{ background: "rgb(var(--c-accent))", height: "100%", width: `${projPct}%`, float: "left", borderRadius: actualPct === 0 ? "4px 0 0 4px" : "0" }} />
                      </>
                    );
                  })()}
                </div>
                <p className="text-[10px]" style={{ color: "var(--t-tx4)" }}>
                  {forecast.open_deal_count} open deal{forecast.open_deal_count !== 1 ? "s" : ""} · {forecast.overall_win_rate}% overall win rate{forecast.win_rate_label ? ` (${forecast.win_rate_label})` : ""}
                </p>
              </>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--t-tx4)" }}>No open deals in pipeline — projection equals actual MTD.</p>
            )}
          </div>
        )}

        {/* Notes peek */}
        {notes.length > 0 && (
          <div className="rounded-xl p-5 animate-fade-up stagger-2" style={cardStyle}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <StickyNote size={14} style={{ color: "rgb(var(--c-accent))" }} />
                <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)" }}>Notes</h3>
              </div>
              <button onClick={() => onNavigate("notes")}
                className="text-[11px] font-medium flex items-center gap-1 transition-colors hover:opacity-80"
                style={{ color: "var(--accent-400)" }}>
                View all <ArrowRight size={11} />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {notes.slice(0, 4).map((n) => {
                const accent = NOTE_ACCENT[n.color] || NOTE_ACCENT.yellow;
                return (
                  <button key={n.id} onClick={() => onNavigate("notes")}
                    className="text-left rounded-lg p-3 transition-transform hover:-translate-y-0.5"
                    style={{ background: `${accent}1f`, border: `1px solid ${accent}33` }}>
                    <p className="text-[12px] leading-snug line-clamp-3" style={{ color: "var(--t-tx1)", minHeight: 30 }}>
                      {n.body.trim() || <span style={{ color: "var(--t-tx4)" }}>Empty note</span>}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5 text-[10px]" style={{ color: "var(--t-tx4)" }}>
                      <span className="tabular-nums" title={new Date(n.updated_at).toLocaleString()}>{relNote(n.updated_at)}</span>
                      {n.author && <><span>·</span><span className="truncate">{n.author}</span></>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Chart row */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

          {/* Profit chart */}
          <div className="lg:col-span-3 rounded-xl p-5 animate-fade-up stagger-2" style={cardStyle}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>{monthLabel} Profit</h3>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>Cumulative this month</p>
              </div>
              <div className="flex items-center gap-1">
                {([-1, 1] as const).map(dir => (
                  <button key={dir} onClick={() => changeMonth(dir)}
                    className="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
                    style={{ color: "var(--t-tx4)" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "var(--t-s3)"; e.currentTarget.style.color = "var(--accent-600)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "var(--t-tx4)"; }}>
                    {dir === -1 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                  </button>
                ))}
              </div>
            </div>
            {dailyProfit.length > 0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={dailyProfit} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="profitGrad" x1="0" y1="0" x2="1" y2="0">
                      {/* Designed, theme-independent profit gradient (emerald → teal → cyan) —
                          stays vivid in light/dark/matte instead of greying out with the accent. */}
                      <stop offset="0%" stopColor="#34D399" />
                      <stop offset="55%" stopColor="#14B8A6" />
                      <stop offset="100%" stopColor="#06B6D4" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--t-b1)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--t-tx4)", fontFamily: "Inter" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--t-tx4)", fontFamily: "Inter" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: "var(--t-s3)", border: "1px solid var(--t-b1)", borderRadius: 10, color: "var(--t-tx1)", fontSize: 12, fontFamily: "Inter", boxShadow: "var(--shadow-panel)" }}
                    formatter={(v: any) => [fmtFullAmount(Number(v) || 0), "Profit"]}
                    cursor={{ stroke: "var(--t-b3)", strokeWidth: 1 }}
                  />
                  <Line type="monotone" dataKey="profit" stroke="url(#profitGrad)" strokeWidth={2.5} dot={false}
                    activeDot={{ r: 5, fill: "#10B981", strokeWidth: 0, style: { filter: "drop-shadow(0 0 6px rgba(16,185,129,0.5))" } }}
                    isAnimationActive animationDuration={1000} animationEasing="ease-out" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[210px] flex items-center justify-center text-[12px]" style={{ color: "var(--t-tx4)" }}>
                No profit data for this month
              </div>
            )}
          </div>

          {/* Right column: Top Clients + Top Suppliers */}
          <div className="lg:col-span-2 flex flex-col gap-4">

            <div className="rounded-xl p-5 flex-1 animate-fade-up stagger-3" style={cardStyle}>
              <h3 className="text-[13px] font-semibold tracking-tight mb-0.5" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Top Clients</h3>
              <p className="text-[11px] mb-3" style={{ color: "var(--t-tx4)" }}>Ranked by net profit</p>
              {stats?.top_clients_by_profit && stats.top_clients_by_profit.length > 0 ? (
                <div className="space-y-0.5">
                  {stats.top_clients_by_profit.slice(0, 4).map((c, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg transition-colors cursor-default"
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={{ color: "var(--t-b3)" }}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{c.name}</div>
                        <div className="text-[10px]" style={{ color: "var(--t-tx4)" }}>{c.margin.toFixed(1)}% margin</div>
                      </div>
                      <div className="text-[12px] font-semibold tabular-nums flex-shrink-0" style={{ color: "rgb(var(--c-success))" }}><CompactAmount value={c.total_profit} /></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-center py-6" style={{ color: "var(--t-tx4)" }}>No profit data yet</div>
              )}
            </div>

            <div className="rounded-xl p-5 flex-1 animate-fade-up stagger-4" style={cardStyle}>
              <h3 className="text-[13px] font-semibold tracking-tight mb-0.5" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Top Suppliers</h3>
              <p className="text-[11px] mb-3" style={{ color: "var(--t-tx4)" }}>By total spend on closed deals</p>
              {stats?.top_suppliers && stats.top_suppliers.length > 0 ? (
                <div className="space-y-0.5">
                  {stats.top_suppliers.slice(0, 4).map((s, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg transition-colors cursor-default"
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={{ color: "var(--t-b3)" }}>{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{s.name}</div>
                        <div className="text-[10px] truncate" style={{ color: "var(--t-tx4)" }}>{s.contact_name || `${s.deal_count} deals`}</div>
                      </div>
                      <div className="text-[12px] font-semibold tabular-nums flex-shrink-0" style={{ color: "var(--t-tx2)" }}><CompactAmount value={s.total_paid} /></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-center py-6" style={{ color: "var(--t-tx4)" }}>No supplier data yet</div>
              )}
            </div>

          </div>
        </div>

        {/* Newsletters sent */}
        <div className="rounded-xl p-5 animate-fade-up stagger-2" style={cardStyle}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Newsletters Sent</h3>
              <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>Recent campaigns and how many went out</p>
            </div>
            <button
              onClick={() => onNavigate("email")}
              className="flex items-center gap-1 text-[12px] font-medium transition-colors"
              style={{ color: "var(--accent-500)" }}
              onMouseEnter={e => (e.currentTarget.style.color = "var(--accent-600)")}
              onMouseLeave={e => (e.currentTarget.style.color = "var(--accent-500)")}
            >
              Compose <ArrowRight size={11} />
            </button>
          </div>
          {sentNewsletters.length === 0 ? (
            <div className="text-[12px] text-center py-6" style={{ color: "var(--t-tx4)" }}>No newsletters sent yet</div>
          ) : (
            <div className="divide-y" style={{ ["--tw-divide-opacity" as any]: 1, borderColor: "var(--t-b2)" }}>
              {sentNewsletters.map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex items-center gap-2.5">
                    <Mail size={14} style={{ color: "var(--t-tx4)" }} className="flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{n.subject || "(no subject)"}</div>
                      <div className="text-[11px]" style={{ color: "var(--t-tx4)" }}>{n.sent_at ? new Date(n.sent_at).toLocaleDateString() : ""}</div>
                    </div>
                  </div>
                  <div className="text-[12px] font-semibold tabular-nums flex-shrink-0" style={{ color: "rgb(var(--c-success))" }}>
                    {n.sent_count}/{n.recipient_count} sent
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

          {/* Recent Invoices (2/3) */}
          <div className="xl:col-span-2 rounded-xl overflow-hidden flex flex-col animate-fade-up stagger-3" style={cardStyle}>
            <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid var(--t-b2)" }}>
              <div>
                <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Recent Invoices</h3>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>Latest billing activity</p>
              </div>
              <button
                onClick={() => onNavigate("invoices")}
                className="flex items-center gap-1 text-[12px] font-medium transition-colors"
                style={{ color: "var(--accent-500)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--accent-600)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--accent-500)")}
              >
                View all <ArrowRight size={11} />
              </button>
            </div>
            {recentInvoices.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-14 text-center">
                <div>
                  <FileText size={24} className="mx-auto mb-2" style={{ color: "var(--t-b3)" }} />
                  <p className="text-[13px]" style={{ color: "var(--t-tx4)" }}>No invoices yet</p>
                  <button onClick={() => onNavigate("invoices")} className="mt-2 text-[12px] font-medium" style={{ color: "var(--accent-500)" }}>
                    Create first invoice →
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
                      {["Client", "Invoice #", "Due", "Status", "Amount"].map((h, i) => (
                        <th key={h} className={`text-left px-5 py-2.5 text-[10px] font-semibold uppercase tracking-widest ${i === 1 ? "hidden sm:table-cell" : i === 2 ? "hidden md:table-cell" : ""} ${i === 4 ? "text-right" : ""}`}
                          style={{ color: "var(--t-tx4)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentInvoices.map((inv) => (
                      <tr
                        key={inv.id}
                        onClick={() => onNavigate("invoices")}
                        className="cursor-pointer transition-colors"
                        style={{ borderBottom: "1px solid var(--t-b2)" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "")}
                      >
                        <td className="px-5 py-3 text-[13px] font-medium" style={{ color: "var(--t-tx1)" }}>{clientName(inv.client_id)}</td>
                        <td className="px-5 py-3 font-mono text-[11px] hidden sm:table-cell" style={{ color: "var(--t-tx4)" }}>{inv.number}</td>
                        <td className="px-5 py-3 text-[12px] tabular-nums hidden md:table-cell" style={{ color: "var(--t-tx3)" }}>{inv.due_date.slice(0, 10)}</td>
                        <td className="px-5 py-3">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                            style={invStatusStyle(inv.status)}>
                            {inv.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right text-[13px] font-bold tabular-nums" style={{ color: "var(--t-tx1)" }}>
                          <CompactAmount value={inv.total} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Right column (1/3) */}
          <div className="flex flex-col gap-4">

            {/* This Week */}
            <div className="rounded-xl p-5 animate-fade-up stagger-4" style={cardStyle}>
              <h3 className="text-[13px] font-semibold tracking-tight mb-0.5" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>This Week</h3>
              <p className="text-[11px] mb-4" style={{ color: "var(--t-tx4)" }}>Last 7 days</p>
              <div className="space-y-3">
                {weekStats.map((w) => (
                  <div key={w.label} className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: "var(--t-tx3)" }}>{w.label}</span>
                    <span className="text-[15px] font-bold tabular-nums" style={{ color: w.color }}>{w.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Incomplete Shipping */}
            {(stats?.incomplete_shipping ?? 0) > 0 && (
              <div className="rounded-xl p-4 flex items-center justify-between animate-fade-up stagger-5"
                style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                <div className="flex items-center gap-2.5">
                  <Package size={14} style={{ color: "rgb(var(--c-warning))" }} className="flex-shrink-0" />
                  <span className="text-[12px]" style={{ color: "var(--t-tx2)" }}>
                    {stats?.incomplete_shipping} invoice{stats?.incomplete_shipping !== 1 ? "s" : ""} need shipping info
                  </span>
                </div>
                <button onClick={() => onNavigate("invoices")} className="text-[12px] font-medium ml-2 flex-shrink-0" style={{ color: "var(--accent-500)" }}>View</button>
              </div>
            )}

            {/* Loss Deals */}
            {(stats?.loss_deals_this_month ?? 0) > 0 && (
              <div className="rounded-xl p-4 animate-fade-up stagger-5"
                style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "rgb(var(--c-danger))" }}>Loss Deals This Month</div>
                <div className="mt-1 flex items-end justify-between">
                  <div className="text-[22px] font-bold" style={{ color: "rgb(var(--c-danger))" }}>{stats?.loss_deals_this_month}</div>
                  <div className="text-[14px] font-semibold" style={{ color: "rgb(var(--c-danger))" }}><CompactAmount value={stats?.loss_total_this_month ?? 0} /></div>
                </div>
              </div>
            )}

            {/* Top Buyers */}
            {topBuyers.length > 0 && (
              <div className="rounded-xl p-5 animate-fade-up stagger-5" style={cardStyle}>
                <h3 className="text-[13px] font-semibold tracking-tight mb-4" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Top Buyers</h3>
                <div className="space-y-1.5">
                  {topBuyers.map((h) => (
                    <div key={h.client_id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg transition-colors cursor-default"
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{h.client_name}</div>
                        <div className="text-[10px] mt-0.5" style={{ color: "var(--t-tx4)" }}>
                          {h.actual_paid > 0 ? <CompactAmount value={h.actual_paid} /> : "No purchases yet"}
                        </div>
                      </div>
                      <TierBadge tier={h.tier} size="sm" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Follow-ups */}
            <div className="rounded-xl p-5 flex flex-col flex-1 animate-fade-up stagger-6" style={cardStyle}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Follow-ups Due</h3>
                  <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>Clients to contact today</p>
                </div>
                {followups.length > 0 && (
                  <span className="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0"
                    style={{ background: "rgba(245,158,11,0.15)", color: "rgb(var(--c-warning-ink))" }}>
                    {followups.length}
                  </span>
                )}
              </div>

              {followups.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-4 text-center gap-1.5">
                  <CheckCircle2 size={22} style={{ color: "rgb(var(--c-success))" }} />
                  <p className="text-[12px] font-medium" style={{ color: "var(--t-tx2)" }}>All caught up</p>
                  <p className="text-[11px]" style={{ color: "var(--t-tx4)" }}>No follow-ups due today</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {followups.map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-2 py-2 rounded-lg transition-colors"
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{c.name}</p>
                        {c.company && <p className="text-[10px] truncate" style={{ color: "var(--t-tx4)" }}>{c.company}</p>}
                      </div>
                      <span className="ml-2 flex-shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: "rgba(245,158,11,0.12)", color: "rgb(var(--c-warning-ink))", border: "1px solid rgba(245,158,11,0.2)" }}>
                        Today
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Quick Actions */}
        <div className="rounded-xl overflow-hidden animate-fade-up stagger-5" style={cardStyle}>
          <div className="px-5 py-2.5" style={{ borderBottom: "1px solid var(--t-b2)" }}>
            <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--t-tx4)" }}>Quick Actions</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-line-2">
            {[
              { label: "Add Client",  sub: "Create a new client profile", icon: Users,    tab: "clients",  dot: "var(--accent-600)", dotBg: "var(--accent-tint)"  },
              { label: "New Invoice", sub: "Generate and send an invoice", icon: FileText, tab: "invoices", dot: "rgb(var(--c-accent))", dotBg: "rgb(var(--c-accent) / 0.1)"  },
              { label: "Scan Inbox",  sub: "AI-process new emails",       icon: Mail,     tab: "email",    dot: "rgb(var(--c-success))", dotBg: "rgba(16,185,129,0.1)"  },
            ].map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  onClick={() => onNavigate(a.tab)}
                  className="group flex items-center gap-3.5 px-5 py-4 transition-colors w-full text-left"
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "")}
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105"
                    style={{ background: a.dotBg }}>
                    <Icon size={14} style={{ color: a.dot }} strokeWidth={2} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium" style={{ color: "var(--t-tx1)" }}>{a.label}</p>
                    <p className="text-[11px]" style={{ color: "var(--t-tx4)" }}>{a.sub}</p>
                  </div>
                  <ArrowRight size={13} className="opacity-0 group-hover:opacity-50 group-hover:translate-x-0.5 flex-shrink-0 transition-all duration-150" style={{ color: "var(--t-tx3)" }} />
                </button>
              );
            })}
          </div>
            </div>

            {/* Pending Approvals */}
            {pendingApprovals.length > 0 && (
              <div className="rounded-xl p-5 flex flex-col flex-1 animate-fade-up stagger-7" style={cardStyle}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--t-tx1)", letterSpacing: "-0.01em" }}>Pending Approvals</h3>
                    <p className="text-[11px] mt-0.5" style={{ color: "var(--t-tx4)" }}>Sign-ups waiting for review</p>
                  </div>
                  <span className="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0"
                    style={{ background: "rgba(99,102,241,0.15)", color: "rgb(var(--c-accent))" }}>
                    {pendingApprovals.length}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {pendingApprovals.map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-2 py-2 rounded-lg transition-colors"
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium truncate" style={{ color: "var(--t-tx1)" }}>{c.name}</p>
                        {c.email && <p className="text-[10px] truncate" style={{ color: "var(--t-tx4)" }}>{c.email}</p>}
                      </div>
                      <div className="flex items-center gap-1 ml-2">
                        <button onClick={async () => { await api.approveClient(c.id); setPending(p => p.filter(x => x.id !== c.id)); }}
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: "rgba(16,185,129,0.12)", color: "rgb(var(--c-success))", border: "1px solid rgba(16,185,129,0.2)" }}>
                          Approve
                        </button>
                        <button onClick={async () => { await api.rejectClient(c.id); setPending(p => p.filter(x => x.id !== c.id)); }}
                          className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: "rgba(239,68,68,0.12)", color: "rgb(var(--c-error))", border: "1px solid rgba(239,68,68,0.2)" }}>
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
    </div>
  );
}
