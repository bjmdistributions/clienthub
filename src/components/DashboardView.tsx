import { useEffect, useState } from "react";
import { api, DashboardStats, Client, Invoice, ReceivablesAging, PayablesAging, Me } from "../lib/api";
import { fmtCompactCurrency, fmtFullAmount, fmtAmount, localMonth } from "../lib/format";
import {
  Users, FileText, Mail, ArrowRight, CheckCircle2, GitBranch,
  ChevronLeft, ChevronRight, Package, CalendarClock, Clock,
  TrendingUp, TrendingDown,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import PendingReviewModal from "./PendingReviewModal";
import { can } from "../lib/permissions";

interface Props {
  onNavigate: (t: any) => void;
  me: Me | null | undefined;
}

const invStatusCls = (s: string): string => {
  const lo = s.toLowerCase();
  if (lo === "paid")    return "bg-success-bg text-success-ink";
  if (lo === "sent" || lo === "deposit_pending") return "bg-info-bg text-info-ink";
  if (lo === "overdue") return "bg-danger-bg text-danger-ink";
  return "bg-surface-3 text-ink-2";
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

// Count-up once when the value arrives — 350ms ease-out, honours reduced motion.
function useCountUp(target: number, duration = 350): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) { setV(target); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

function CountUpAmount({ value }: { value: number }) {
  const v = useCountUp(value);
  return <>{fmtAmount(Math.round(v))}</>;
}

function CountUpInt({ value }: { value: number }) {
  const v = useCountUp(value);
  return <>{Math.round(v).toLocaleString()}</>;
}

// Month-over-previous-month movement chip (only meaningful in monthly mode).
function DeltaChip({ now, prev }: { now: number; prev: number }) {
  if (!prev) return null;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span title={`vs last month (${fmtAmount(prev)})`}
      className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-semibold tabular-nums ${up ? "bg-success-bg text-success-ink" : "bg-danger-bg text-danger-ink"}`}>
      {up ? <TrendingUp size={12} strokeWidth={2} /> : <TrendingDown size={12} strokeWidth={2} />}
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}


export default function DashboardView({ onNavigate, me }: Props) {
  // Org money (cash position, revenue, profit) is hidden from reps/viewers
  // unless they hold deal_flow:view_numbers. Admins/owners carry "*" and pass.
  const showMoney = can(me, "deal_flow:view_numbers");

  const [stats, setStats]               = useState<DashboardStats | null>(null);
  const [ar, setAr]                     = useState<ReceivablesAging | null>(null);
  const [ap, setAp]                     = useState<PayablesAging | null>(null);
  const [followups, setFollowups]       = useState<Client[]>([]);
  const [pendingApprovals, setPending]  = useState<Client[]>([]);
  const [reviewClient, setReviewClient] = useState<Client | null>(null);
  const [recentInvoices, setRecent]     = useState<Invoice[]>([]);
  const [clients, setClients]           = useState<Client[]>([]);
  const [profitMonth, setProfitMonth]   = useState(() => localMonth());
  const [dailyProfit, setDailyProfit]   = useState<{ day: string; profit: number; revenue: number }[]>([]);
  const [chartMetric, setChartMetric]   = useState<"profit" | "revenue">("profit");
  // Hero range toggle — persisted so the dashboard opens how Jack left it.
  const [heroRange, setHeroRangeState]  = useState<"month" | "all">(
    () => (localStorage.getItem("ec_dash_range") as "month" | "all") || "month"
  );
  const setHeroRange = (r: "month" | "all") => {
    setHeroRangeState(r);
    try { localStorage.setItem("ec_dash_range", r); } catch { /* ignore */ }
  };

  const loadAll = () => {
    api.dueFollowups().then(setFollowups).catch(() => {});
    api.getPendingApprovals().then(setPending).catch(() => {});
    // Hero counts (clients / open deals / completed this month) are non-sensitive
    // and shown to everyone, so dashboard stats load for all users.
    api.dashboardStats().then(setStats).catch(console.error);
    // Money-bearing data (AR/AP, invoice list) is only fetched for users who may see it.
    if (!showMoney) return;
    api.getReceivablesAging().then(setAr).catch(() => setAr(null));
    api.getPayablesAging().then(setAp).catch(() => setAp(null));
    api.listInvoices().then((inv) => setRecent(inv.slice(0, 6))).catch(() => {});
  };

  const loadProfitMonth = async (m: string) => {
    const raw = await api.getMonthlyProfit(m);
    const [y, mo] = m.split("-").map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === mo;
    const profitMap: Record<string, number> = {};
    const revenueMap: Record<string, number> = {};
    raw.forEach((r) => { profitMap[r.day] = r.profit; revenueMap[r.day] = r.revenue; });
    const maxDataDay = raw.length > 0
      ? Math.max(...raw.map((r) => parseInt(r.day.split("-")[2], 10)))
      : 0;
    const lastDay = isCurrentMonth ? Math.max(today.getDate(), maxDataDay) : daysInMonth;
    let cumProfit = 0;
    let cumRevenue = 0;
    const data = [];
    for (let d = 1; d <= lastDay; d++) {
      const dayStr = `${m}-${String(d).padStart(2, "0")}`;
      cumProfit += profitMap[dayStr] || 0;
      cumRevenue += revenueMap[dayStr] || 0;
      data.push({ day: String(d), profit: cumProfit, revenue: cumRevenue });
    }
    setDailyProfit(data);
  };

  useEffect(() => {
    loadAll();
    api.listClients().then(setClients).catch(console.error);
    if (showMoney) loadProfitMonth(profitMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMoney]);

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

  // Overdue = everything aged past "current" (shown in the Today queue for money users).
  const overdueAmt   = ar ? ar.summary.total - ar.summary.current : 0;
  const overdueCount = ar ? ar.items.filter((i) => i.days_overdue > 0).length : 0;

  const shippingCount = stats?.incomplete_shipping ?? 0;
  const heroLoading = stats === null;
  const todayEmpty = pendingApprovals.length === 0 && overdueCount === 0 && followups.length === 0 && shippingCount === 0;

  // New hero counts — non-sensitive, shown to everyone.
  const totalClients      = stats?.total_clients ?? stats?.clients ?? 0;
  const openDeals         = stats?.open_deals ?? 0;
  const completedThisMonth = stats?.completed_this_month ?? 0;

  // Hero money — revenue = paid invoices, profit = completed deal flows.
  const heroRevenue = heroRange === "month" ? (stats?.revenue_mtd ?? 0) : (stats?.revenue_all_time ?? 0);
  const heroProfit  = heroRange === "month" ? (stats?.profit_mtd ?? 0)  : (stats?.profit_all_time ?? 0);

  const resolvedApproval = (id: string) => {
    setPending((p) => p.filter((x) => x.id !== id));
    window.dispatchEvent(new CustomEvent("approvals-changed"));
  };

  return (
    <div className="min-h-full flex flex-col page-atmosphere dashboard-glow" style={{ background: "var(--t-bg)" }}>

      {reviewClient && (
        <PendingReviewModal
          client={reviewClient}
          onClose={() => setReviewClient(null)}
          onResolved={() => { resolvedApproval(reviewClient.id); setReviewClient(null); }}
        />
      )}

      {/* ── Page header ─────────────────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between flex-shrink-0 bg-surface border-b border-line">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Dashboard</h2>
          <p className="text-[12px] text-muted mt-0.5">{dateStr}</p>
        </div>
      </div>

      <div className="flex-1 p-6 flex flex-col gap-5 max-w-[1200px] w-full mx-auto">

        {/* ── Hero: Revenue + Profit (money — gated), range toggle ─ */}
        {showMoney && (heroLoading ? (
          <div className="h-[168px] bg-surface-2 rounded-2xl animate-pulse" />
        ) : (
          <div className="bg-surface border border-line rounded-2xl p-7">
            <div className="flex items-center justify-between gap-4 mb-6">
              <h3 className="text-[13px] font-semibold text-ink-2">Performance</h3>
              <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
                {([["month", "This month"], ["all", "All time"]] as ["month" | "all", string][]).map(([r, label]) => (
                  <button key={r} onClick={() => setHeroRange(r)}
                    className={`px-3 h-7 rounded-md text-[12px] font-medium transition-colors ${heroRange === r ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div>
                <div className="text-[12.5px] font-medium text-muted">Revenue</div>
                <div className="flex items-end gap-3 mt-2">
                  <span className="text-[38px] font-bold text-ink tabular-nums leading-none tracking-tight">
                    <CountUpAmount value={heroRevenue} />
                  </span>
                  {heroRange === "month" && <DeltaChip now={heroRevenue} prev={stats?.revenue_prev_month ?? 0} />}
                </div>
                <div className="text-[11.5px] text-faint mt-2.5">
                  paid invoices{heroRange === "month" ? " this month" : ", all time"}
                </div>
              </div>
              <div>
                <div className="text-[12.5px] font-medium text-muted">Profit</div>
                <div className="flex items-end gap-3 mt-2">
                  <span className={`text-[38px] font-bold tabular-nums leading-none tracking-tight ${heroProfit < 0 ? "text-danger-ink" : "text-ink"}`}>
                    <CountUpAmount value={heroProfit} />
                  </span>
                  {heroRange === "month" && <DeltaChip now={heroProfit} prev={stats?.profit_prev_month ?? 0} />}
                </div>
                <div className="text-[11.5px] text-faint mt-2.5">
                  completed deals{heroRange === "month" ? " this month" : ", all time"}
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* ── Secondary counts — non-sensitive, everyone ──── */}
        {heroLoading ? (
          <div className="h-[76px] bg-surface-2 rounded-2xl animate-pulse" />
        ) : (
          <div className="bg-surface-2/60 border border-line-2 rounded-2xl overflow-hidden">
            <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-line-2">
              {([
                { label: "Clients", value: totalClients, icon: Users, tab: "clients" },
                { label: "Open deals", value: openDeals, icon: GitBranch, tab: "dealflow" },
                { label: "Completed this month", value: completedThisMonth, icon: CheckCircle2, tab: "deals" },
              ] as const).map((c) => {
                const Icon = c.icon;
                return (
                  <button key={c.label} onClick={() => onNavigate(c.tab)}
                    className="px-5 py-4 flex items-center gap-3.5 text-left hover:bg-surface-2 transition-colors">
                    <span className="w-9 h-9 rounded-lg bg-surface text-ink-2 border border-line-2 flex items-center justify-center flex-shrink-0"><Icon size={16} strokeWidth={1.75} /></span>
                    <div>
                      <div className="text-[22px] font-bold text-ink tabular-nums leading-none"><CountUpInt value={c.value} /></div>
                      <div className="text-[12px] text-muted mt-1">{c.label}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Today: everything that needs a decision ────── */}
        <div className="bg-surface border border-line rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-line-2">
            <h3 className="text-[13px] font-semibold text-ink tracking-tight">Today</h3>
            <p className="text-[11px] text-muted mt-0.5">What needs you right now</p>
          </div>

          {todayEmpty ? (
            <div className="py-10 flex flex-col items-center">
              <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-success-ink mb-3">
                <CheckCircle2 size={18} />
              </div>
              <div className="text-[13px] text-muted">All clear — nothing needs you right now</div>
            </div>
          ) : (
            <div className="divide-y divide-line-2">
              {/* New customers awaiting review — inline decisions */}
              {pendingApprovals.slice(0, 4).map((c) => {
                const initials = (c.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
                return (
                  <div key={c.id} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/40 transition-colors">
                    <span className="w-8 h-8 rounded-full bg-accent/10 text-accent-hover flex items-center justify-center text-[12px] font-bold flex-shrink-0">{initials}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                      <div className="text-[11px] text-muted truncate">New customer to review{c.email ? ` · ${c.email}` : ""}</div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => setReviewClient(c)}
                        className="border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors">
                        Review
                      </button>
                      <button onClick={async () => { await api.approveClient(c.id); resolvedApproval(c.id); }}
                        className="bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors">
                        Approve
                      </button>
                      <button onClick={async () => { await api.rejectClient(c.id); resolvedApproval(c.id); }}
                        className="border border-line text-muted hover:text-danger-ink hover:bg-danger-bg px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors">
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
              {pendingApprovals.length > 4 && (
                <button onClick={() => onNavigate("approvals")}
                  className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-2/40 transition-colors">
                  <span className="w-8 flex justify-center text-faint"><Users size={14} /></span>
                  <span className="text-[12px] text-accent font-medium">{pendingApprovals.length - 4} more waiting for review</span>
                  <ArrowRight size={12} className="text-faint" />
                </button>
              )}

              {/* Overdue money — the broker's #1 chase (money — gated) */}
              {showMoney && overdueCount > 0 && (
                <button onClick={() => onNavigate("receivables")}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors group">
                  <span className="w-8 h-8 rounded-lg bg-danger-bg text-danger-ink flex items-center justify-center flex-shrink-0"><CalendarClock size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {overdueCount} invoice{overdueCount !== 1 ? "s" : ""} overdue
                    </div>
                    <div className="text-[11px] text-muted">Chase these first</div>
                  </div>
                  <span className="text-[13px] font-bold text-danger-ink tabular-nums flex-shrink-0">{fmtAmount(overdueAmt)}</span>
                  <ArrowRight size={13} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              )}

              {/* Follow-ups due */}
              {followups.length > 0 && (
                <button onClick={() => onNavigate("clients")}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors group">
                  <span className="w-8 h-8 rounded-lg bg-warning-bg text-warning-ink flex items-center justify-center flex-shrink-0"><Clock size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {followups.length} follow-up{followups.length !== 1 ? "s" : ""} due today
                    </div>
                    <div className="text-[11px] text-muted truncate">
                      {followups.slice(0, 3).map((c) => c.name).join(", ")}{followups.length > 3 ? "…" : ""}
                    </div>
                  </div>
                  <ArrowRight size={13} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              )}

              {/* Shipping info missing */}
              {shippingCount > 0 && (
                <button onClick={() => onNavigate("invoices")}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors group">
                  <span className="w-8 h-8 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center flex-shrink-0"><Package size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">
                      {shippingCount} invoice{shippingCount !== 1 ? "s" : ""} need{shippingCount === 1 ? "s" : ""} shipping info
                    </div>
                    <div className="text-[11px] text-muted">Fill in carrier and tracking to close them out</div>
                  </div>
                  <ArrowRight size={13} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Trend + recent activity (money — gated) ────── */}
        {showMoney && (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">

          {/* Cumulative month chart */}
          <div className="xl:col-span-3 bg-surface border border-line rounded-2xl p-5 min-w-0">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-[13px] font-semibold text-ink tracking-tight">{monthLabel}</h3>
                <p className="text-[11px] text-muted mt-0.5">Cumulative {chartMetric} this month</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 bg-surface-2 border border-line rounded-lg p-0.5">
                  {(["profit", "revenue"] as const).map((mtr) => (
                    <button key={mtr} onClick={() => setChartMetric(mtr)}
                      className={`px-2.5 h-7 rounded-md text-[11px] font-semibold capitalize transition-colors ${chartMetric === mtr ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                      {mtr}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-0.5">
                  {([-1, 1] as const).map((dir) => (
                    <button key={dir} onClick={() => changeMonth(dir)}
                      className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors">
                      {dir === -1 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {dailyProfit.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dailyProfit} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="profitGrad" x1="0" y1="0" x2="1" y2="0">
                      {/* Designed, theme-independent profit gradient (emerald → teal → cyan) —
                          stays vivid in light/dark/matte instead of greying out with the accent. */}
                      <stop offset="0%" stopColor="#34D399" />
                      <stop offset="55%" stopColor="#14B8A6" />
                      <stop offset="100%" stopColor="#06B6D4" />
                    </linearGradient>
                    <linearGradient id="revenueGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#6366F1" />
                      <stop offset="100%" stopColor="#818CF8" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--t-b1)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--t-tx4)", fontFamily: "Satoshi" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--t-tx4)", fontFamily: "Satoshi" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: "var(--t-s3)", border: "1px solid var(--t-b1)", borderRadius: 10, color: "var(--t-tx1)", fontSize: 12, fontFamily: "Satoshi", boxShadow: "var(--shadow-panel)" }}
                    formatter={(v: any) => [fmtFullAmount(Number(v) || 0), chartMetric === "revenue" ? "Revenue" : "Profit"]}
                    cursor={{ stroke: "var(--t-b3)", strokeWidth: 1 }}
                  />
                  <Line type="monotone" dataKey={chartMetric} stroke={chartMetric === "revenue" ? "url(#revenueGrad)" : "url(#profitGrad)"} strokeWidth={2.5} dot={false}
                    isAnimationActive animationDuration={800} animationEasing="ease-out" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-[12px] text-faint">
                No closed deals this month yet
              </div>
            )}
          </div>

          {/* Recent activity */}
          <div className="xl:col-span-2 bg-surface border border-line rounded-2xl overflow-hidden flex flex-col min-w-0">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-line-2">
              <div>
                <h3 className="text-[13px] font-semibold text-ink tracking-tight">Recent invoices</h3>
                <p className="text-[11px] text-muted mt-0.5">Latest billing activity</p>
              </div>
              <button onClick={() => onNavigate("invoices")}
                className="flex items-center gap-1 text-[12px] font-medium text-accent hover:text-accent-hover transition-colors">
                View all <ArrowRight size={11} />
              </button>
            </div>
            {recentInvoices.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-12">
                <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
                  <FileText size={18} />
                </div>
                <p className="text-[13px] text-muted mb-2">No invoices yet</p>
                <button onClick={() => onNavigate("invoices")} className="text-[12px] font-medium text-accent hover:text-accent-hover">
                  Create your first invoice
                </button>
              </div>
            ) : (
              <div className="divide-y divide-line-2">
                {recentInvoices.map((inv) => (
                  <button key={inv.id} onClick={() => onNavigate("invoices")}
                    className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-2/40 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">{clientName(inv.client_id)}</div>
                      <div className="text-[11px] text-muted truncate">
                        <span className="font-mono">{inv.number}</span>
                        <span className="text-faint"> · due {inv.due_date.slice(0, 10)}</span>
                      </div>
                    </div>
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 ${invStatusCls(inv.status)}`}>
                      {inv.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-[13px] font-bold text-ink tabular-nums flex-shrink-0 w-20 text-right">
                      <CompactAmount value={inv.total} />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        )}

        {/* ── Quick actions — secondary panel, quieter than the cards ── */}
        <div className="bg-surface-2/60 border border-line-2 rounded-2xl overflow-hidden">
          <div className={`grid grid-cols-1 divide-y lg:divide-y-0 lg:divide-x divide-line-2 ${showMoney ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
            {[
              { label: "Add client",  sub: "Create a new client profile",  icon: Users,    tab: "clients"  },
              // Only surface the invoice action to users who can see the money.
              ...(showMoney ? [{ label: "New invoice", sub: "Generate and send an invoice", icon: FileText, tab: "invoices" }] : []),
              { label: "Newsletter",  sub: "Reach your client list",       icon: Mail,     tab: "email"    },
            ].map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  onClick={() => onNavigate(a.tab)}
                  className="group flex items-center gap-3.5 px-5 py-4 transition-colors w-full text-left hover:bg-surface-2/40"
                >
                  <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105">
                    <Icon size={14} strokeWidth={2} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-ink">{a.label}</p>
                    <p className="text-[11px] text-muted">{a.sub}</p>
                  </div>
                  <ArrowRight size={13} className="opacity-0 group-hover:opacity-50 group-hover:translate-x-0.5 flex-shrink-0 transition-all duration-150 text-muted" />
                </button>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
