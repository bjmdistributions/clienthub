import { useEffect, useState } from "react";
import { api, DashboardStats, Client, Invoice } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  Users, FileText, DollarSign, TrendingUp, Mail,
  ArrowRight, CheckCircle2, Clock, AlertCircle, ChevronLeft, ChevronRight,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface Props {
  onNavigate: (t: any) => void;
}

const invStatusColor = (s: string) => {
  const lo = s.toLowerCase();
  if (lo === "paid")            return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (lo === "sent")            return "bg-blue-50 text-blue-700 border border-blue-200";
  if (lo === "overdue")         return "bg-red-50 text-red-700 border border-red-200";
  if (lo === "deposit_pending") return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-gray-100 text-gray-600 border border-gray-200";
};

export default function DashboardView({ onNavigate }: Props) {
  const [stats, setStats]               = useState<DashboardStats | null>(null);
  const [followups, setFollowups]       = useState<Client[]>([]);
  const [recentInvoices, setRecent]     = useState<Invoice[]>([]);
  const [clients, setClients]           = useState<Client[]>([]);
  const [profitMonth, setProfitMonth]   = useState(() => new Date().toISOString().slice(0, 7));
  const [dailyProfit, setDailyProfit]   = useState<{ day: string; profit: number }[]>([]);

  const loadProfitMonth = async (m: string) => {
    const raw = await api.getMonthlyProfit(m);
    const [y, mo] = m.split("-").map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === mo;
    const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;

    const profitMap: Record<string, number> = {};
    raw.forEach((r) => { profitMap[r.day] = r.profit; });

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
    api.dashboardStats().then(setStats).catch(console.error);
    api.dueFollowups().then(setFollowups).catch(console.error);
    api.listInvoices().then((inv) => setRecent(inv.slice(0, 7))).catch(console.error);
    api.listClients().then(setClients).catch(console.error);
    loadProfitMonth(profitMonth);
  }, []);

  const changeMonth = (dir: 1 | -1) => {
    const [y, m] = profitMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    setProfitMonth(next);
    loadProfitMonth(next);
  };

  const monthLabel = new Date(Number(profitMonth.split("-")[0]), Number(profitMonth.split("-")[1]) - 1).toLocaleString("default", { month: "long", year: "numeric" });

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const kpis = [
    {
      label: "Total Clients",
      sub: "in your account",
      value: stats?.clients ?? 0,
      icon: Users,
      bg: "bg-indigo-600",
      tab: "clients",
    },
    {
      label: "Total Invoices",
      sub: "created all time",
      value: stats?.invoices ?? 0,
      icon: FileText,
      bg: "bg-violet-600",
      tab: "invoices",
    },
    {
      label: "Outstanding",
      sub: "awaiting payment",
      value: fmtAmount(stats?.outstanding ?? 0),
      icon: DollarSign,
      bg: "bg-amber-500",
      tab: "invoices",
    },
    {
      label: "Revenue YTD",
      sub: "collected this year",
      value: fmtAmount(stats?.paid_ytd ?? 0),
      icon: TrendingUp,
      bg: "bg-emerald-600",
      tab: "invoices",
    },
  ];

  const weekStats = [
    {
      label: "Revenue Earned",
      value: fmtAmount(stats?.revenue_this_week ?? 0),
      icon: TrendingUp,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      iconColor: "text-emerald-600",
    },
    {
      label: "New Clients",
      value: String(stats?.clients_this_week ?? 0),
      icon: Users,
      color: "text-indigo-600",
      bg: "bg-indigo-50",
      iconColor: "text-indigo-600",
    },
    {
      label: "Interactions",
      value: String(stats?.interactions_this_week ?? 0),
      icon: Clock,
      color: "text-violet-600",
      bg: "bg-violet-50",
      iconColor: "text-violet-600",
    },
  ];

  return (
    <div className="min-h-full flex flex-col">

      {/* ── Dark header ─────────────────────────────────────────── */}
      <div className="bg-slate-900 px-6 py-5 flex-shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-bold text-white tracking-tight">Dashboard</h2>
            <p className="text-[13px] text-slate-400 mt-0.5">{dateStr}</p>
          </div>
          <div className="flex items-center gap-6 sm:gap-8">
            <div>
              <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-0.5">Outstanding</p>
              <p className="text-[18px] font-bold text-amber-400 tabular-nums">
                {fmtAmount(stats?.outstanding ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-0.5">Paid YTD</p>
              <p className="text-[18px] font-bold text-emerald-400 tabular-nums">
                {fmtAmount(stats?.paid_ytd ?? 0)}
              </p>
            </div>
            <button
              onClick={() => onNavigate("invoices")}
              className="hidden sm:flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
            >
              <FileText size={14} /> Invoices
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────── */}
      <div className="flex-1 p-6 flex flex-col gap-5">

        {/* KPI cards — 2 cols on small, 4 on large */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map((k) => (
            <button
              key={k.label}
              onClick={() => onNavigate(k.tab)}
              className="bg-white border border-gray-200 rounded-xl p-5 text-left hover:shadow-md transition-all group"
            >
              <div className={`${k.bg} w-10 h-10 rounded-lg flex items-center justify-center mb-4`}>
                <k.icon size={18} className="text-white" />
              </div>
              <div className="text-[26px] font-bold text-gray-900 tabular-nums leading-none mb-1">
                {k.value}
              </div>
              <div className="text-[13px] font-medium text-gray-700 leading-snug">{k.label}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">{k.sub}</div>
            </button>
          ))}
        </div>

        {/* Analytics — Profit Chart + Top Clients */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-5">
          <div className="lg:col-span-3 bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => changeMonth(-1)} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"><ChevronLeft size={16} /></button>
              <h3 className="text-[14px] font-semibold text-gray-900">{monthLabel} Profit</h3>
              <button onClick={() => changeMonth(1)} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"><ChevronRight size={16} /></button>
            </div>
            {dailyProfit.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dailyProfit}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: any) => fmtAmount(Number(v) || 0)} />
                  <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-[13px] text-gray-400 text-center py-10">No profit data for this month</div>
            )}
          </div>

          <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-5">
            <h3 className="text-[14px] font-semibold text-gray-900 mb-4">Top Clients by Profit</h3>
            {stats?.top_clients_by_profit && stats.top_clients_by_profit.length > 0 ? (
              <div className="space-y-2">
                {stats.top_clients_by_profit.map((c, i) => (
                  <div key={i} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-gray-50 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-900 truncate">{c.name}</div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-0.5">
                        <span>Rev: {fmtAmount(c.total_revenue)}</span>
                        <span className="text-emerald-600 font-medium">Profit: {fmtAmount(c.total_profit)}</span>
                      </div>
                    </div>
                    <span className="text-[13px] font-semibold tabular-nums ml-2 flex-shrink-0" style={{ color: c.margin >= 20 ? "#059669" : c.margin >= 10 ? "#d97706" : "#6b7280" }}>
                      {c.margin.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[13px] text-gray-400 text-center py-10">No profit data yet</div>
            )}
          </div>
        </div>

        {/* Main grid — stacked on small, 3-col on large */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

          {/* ── Recent Invoices (2/3) ───────────────────────── */}
          <div className="xl:col-span-2 bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h3 className="text-[14px] font-semibold text-gray-900">Recent Invoices</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">Latest billing activity</p>
              </div>
              <button
                onClick={() => onNavigate("invoices")}
                className="flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                View all <ArrowRight size={12} />
              </button>
            </div>
            {recentInvoices.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-14 text-center">
                <div>
                  <FileText size={28} className="text-gray-200 mx-auto mb-2" />
                  <p className="text-[13px] text-gray-400">No invoices yet</p>
                  <button
                    onClick={() => onNavigate("invoices")}
                    className="mt-3 text-[12px] text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    Create your first invoice →
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Client</th>
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide hidden sm:table-cell">Invoice #</th>
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide hidden md:table-cell">Due</th>
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Status</th>
                      <th className="text-right px-5 py-2.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentInvoices.map((inv) => (
                      <tr
                        key={inv.id}
                        onClick={() => onNavigate("invoices")}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
                      >
                        <td className="px-5 py-3 text-[13px] font-medium text-gray-900">
                          {clientName(inv.client_id)}
                        </td>
                        <td className="px-5 py-3 font-mono text-[12px] text-gray-400 hidden sm:table-cell">
                          {inv.number}
                        </td>
                        <td className="px-5 py-3 text-[12px] text-gray-500 tabular-nums hidden md:table-cell">
                          {inv.due_date.slice(0, 10)}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${invStatusColor(inv.status)}`}>
                            {inv.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right text-[13px] font-bold text-gray-900 tabular-nums">
                          {fmtAmount(inv.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Right column (1/3) ──────────────────────────── */}
          <div className="flex flex-col gap-5">

            {/* This Week */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-[14px] font-semibold text-gray-900 mb-1">This Week</h3>
              <p className="text-[11px] text-gray-400 mb-4">Last 7 days of activity</p>
              <div className="space-y-3">
                {weekStats.map((w) => (
                  <div key={w.label} className="flex items-center gap-3">
                    <div className={`${w.bg} w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0`}>
                      <w.icon size={15} className={w.iconColor} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-gray-400">{w.label}</p>
                      <p className={`text-[17px] font-bold tabular-nums leading-tight ${w.color}`}>
                        {w.value}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Profitability */}
            <div className="grid grid-cols-4 gap-4 mb-4">
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Revenue (Paid)</div>
                <div className="text-[20px] font-bold text-gray-900 tabular-nums mt-1">{fmtAmount(stats?.paid_ytd ?? 0)}</div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Total Cost</div>
                <div className="text-[20px] font-bold text-gray-900 tabular-nums mt-1">{fmtAmount(stats?.total_cost ?? 0)}</div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Net Profit</div>
                <div className={`text-[20px] font-bold tabular-nums mt-1 ${(stats?.total_profit ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {fmtAmount(stats?.total_profit ?? 0)}
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Avg Margin</div>
                <div className="text-[20px] font-bold text-gray-900 tabular-nums mt-1">{(stats?.avg_margin ?? 0).toFixed(1)}%</div>
              </div>
            </div>

            {/* Follow-ups */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[14px] font-semibold text-gray-900">Follow-ups Due</h3>
                  <p className="text-[11px] text-gray-400 mt-0.5">Clients to contact today</p>
                </div>
                {followups.length > 0 && (
                  <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold flex items-center justify-center flex-shrink-0">
                    {followups.length}
                  </span>
                )}
              </div>

              {followups.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-4 text-center gap-2">
                  <CheckCircle2 size={26} className="text-emerald-400" />
                  <p className="text-[13px] font-medium text-gray-600">All caught up</p>
                  <p className="text-[11px] text-gray-400">No follow-ups due today</p>
                </div>
              ) : (
                <div className="space-y-1 overflow-y-auto">
                  {followups.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between px-2 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-gray-900 truncate">{c.name}</p>
                        {c.company && (
                          <p className="text-[11px] text-gray-400 truncate">{c.company}</p>
                        )}
                      </div>
                      <span className="ml-3 flex-shrink-0 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                        Today
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Quick Actions ────────────────────────────────────── */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Quick Actions</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">
            {[
              { label: "Add Client",   sub: "Create a new client profile",   icon: Users,    bg: "bg-indigo-100", hover: "hover:bg-indigo-50", iconColor: "text-indigo-600", hoverIcon: "group-hover:bg-indigo-200", hoverText: "group-hover:text-indigo-700", tab: "clients" },
              { label: "New Invoice",  sub: "Generate and send an invoice",  icon: FileText, bg: "bg-violet-100", hover: "hover:bg-violet-50", iconColor: "text-violet-600", hoverIcon: "group-hover:bg-violet-200", hoverText: "group-hover:text-violet-700", tab: "invoices" },
              { label: "Scan Inbox",   sub: "AI-process new emails",         icon: Mail,     bg: "bg-emerald-100",hover: "hover:bg-emerald-50",iconColor: "text-emerald-600",hoverIcon: "group-hover:bg-emerald-200",hoverText: "group-hover:text-emerald-700",tab: "email" },
            ].map((a) => (
              <button
                key={a.label}
                onClick={() => onNavigate(a.tab)}
                className={`group flex items-center gap-4 px-5 py-4 ${a.hover} transition-colors w-full text-left`}
              >
                <div className={`${a.bg} ${a.hoverIcon} w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors`}>
                  <a.icon size={16} className={a.iconColor} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-[14px] font-medium text-gray-800 ${a.hoverText}`}>{a.label}</p>
                  <p className="text-[12px] text-gray-400">{a.sub}</p>
                </div>
                <ArrowRight size={14} className="text-gray-300 group-hover:text-gray-400 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
