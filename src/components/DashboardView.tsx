import { useEffect, useState } from "react";
import { api, DashboardStats, Client, Invoice, BuyerTier } from "../lib/api";
import { fmtCompactCurrency, fmtFullAmount } from "../lib/format";
import {
  Users, FileText, DollarSign, TrendingUp, Mail,
  ArrowRight, CheckCircle2, Clock, ChevronLeft, ChevronRight, Package,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import TierBadge from "./TierBadge";

interface Props {
  onNavigate: (t: any) => void;
}

const invStatusColor = (s: string) => {
  const lo = s.toLowerCase();
  if (lo === "paid")    return "bg-amber-100 text-amber-800";
  if (lo === "sent")    return "bg-blue-100 text-blue-800";
  if (lo === "overdue") return "bg-red-100 text-red-800";
  return "bg-gray-100 text-gray-700";
};

function CompactAmount({ value }: { value: number }) {
  return (
    <span title={fmtFullAmount(value)} style={{ cursor: "help" }}>
      {fmtCompactCurrency(value)}
    </span>
  );
}

export default function DashboardView({ onNavigate }: Props) {
  const [stats, setStats]             = useState<DashboardStats | null>(null);
  const [followups, setFollowups]     = useState<Client[]>([]);
  const [recentInvoices, setRecent]   = useState<Invoice[]>([]);
  const [clients, setClients]         = useState<Client[]>([]);
  const [tiers, setTiers]             = useState<BuyerTier[]>([]);
  const [profitMonth, setProfitMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [dailyProfit, setDailyProfit] = useState<{ day: string; profit: number }[]>([]);

  const loadProfitMonth = async (m: string) => {
    const raw = await api.getMonthlyProfit(m);
    const [y, mo] = m.split("-").map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === mo;
    const profitMap: Record<string, number> = {};
    raw.forEach((r) => { profitMap[r.day] = r.profit; });
    // Extend lastDay to cover any data points beyond today (e.g. completed_at in future)
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
    api.dashboardStats().then(setStats).catch(console.error);
    api.dueFollowups().then(setFollowups).catch(console.error);
    api.listInvoices().then((inv) => setRecent(inv.slice(0, 7))).catch(console.error);
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
  const kpis = [
    { label: "Total Clients",    sub: "in account",          value: stats?.clients ?? 0,                icon: Users,       tab: "clients",   clr: "text-gray-900" },
    { label: "Outstanding",      sub: "awaiting payment",    value: <CompactAmount value={stats?.outstanding ?? 0} />, icon: DollarSign,  tab: "invoices",  clr: (stats?.outstanding ?? 0) > 0 ? "text-amber-600" : "text-gray-900" },
    { label: "Revenue MTD",      sub: "closed this month",   value: <CompactAmount value={revenueMtd} />,              icon: TrendingUp,  tab: "analytics", clr: "text-gray-900" },
    { label: "Profit MTD",       sub: "closed this month",   value: <CompactAmount value={profitMtd} />,               icon: TrendingUp,  tab: "analytics", clr: profitMtd >= 0 ? "text-emerald-600" : "text-red-600" },
    { label: "All-Time Revenue", sub: "from closed deals",   value: <CompactAmount value={allTimeRev} />,              icon: DollarSign,  tab: "analytics", clr: "text-gray-900" },
    { label: "All-Time Profit",  sub: "from closed deals",   value: <CompactAmount value={allTimeProfit} />,           icon: TrendingUp,  tab: "analytics", clr: allTimeProfit >= 0 ? "text-emerald-600" : "text-red-600" },
    { label: "Deals MTD",        sub: "completed this month", value: stats?.deals_mtd ?? 0,             icon: FileText,    tab: "deals",     clr: "text-gray-900" },
    { label: "Active Deals",     sub: "in pipeline",         value: stats?.pipeline_count ?? 0,         icon: FileText,    tab: "dealflow",  clr: "text-gray-900" },
  ];

  const weekStats = [
    { label: "Revenue",       value: <CompactAmount value={stats?.revenue_this_week ?? 0} />, color: "text-emerald-600" },
    { label: "New Clients",   value: String(stats?.clients_this_week ?? 0),    color: "text-indigo-600" },
    { label: "Interactions",  value: String(stats?.interactions_this_week ?? 0), color: "text-violet-600" },
  ];

  const topBuyers = tiers.filter((h) => h.tier === "S" || h.tier === "A").slice(0, 5);

  return (
    <div className="min-h-full flex flex-col bg-[#F7F6F4]">

      {/* ── Page Header ─────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100/80 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-[17px] font-semibold text-gray-900 tracking-tight">Dashboard</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">{dateStr}</p>
        </div>
        <div className="flex items-center gap-4 flex-wrap justify-end">
          <div className="text-right">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-medium mb-0.5">Outstanding</p>
            <p className="text-[15px] font-bold text-amber-500 tabular-nums leading-none">
              <CompactAmount value={stats?.outstanding ?? 0} />
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-medium mb-0.5">Profit MTD</p>
            <p className={`text-[15px] font-bold tabular-nums leading-none ${profitMtd >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              <CompactAmount value={profitMtd} />
            </p>
          </div>
          <button
            onClick={() => onNavigate("invoices")}
            className="flex items-center gap-1.5 bg-[#1A1A1E] hover:bg-[#27272B] text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
          >
            <FileText size={13} /> Invoices
          </button>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────── */}
      <div className="flex-1 p-6 flex flex-col gap-5">

        {/* KPI grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {kpis.map((k) => (
            <button
              key={k.label}
              onClick={() => onNavigate(k.tab)}
              className="bg-white border border-gray-100 rounded-xl p-4 text-left hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.07)] transition-all duration-200 group"
            >
              <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2.5 truncate">{k.label}</div>
              <div className={`text-[19px] font-bold tabular-nums leading-none break-all ${k.clr}`}>{k.value}</div>
              <div className="flex items-center gap-1 mt-1.5">
                <span className="text-[11px] text-gray-400">{k.sub}</span>
                <ArrowRight size={9} className="text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </button>
          ))}
        </div>

        {/* Chart row */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

          {/* Profit chart */}
          <div className="lg:col-span-3 bg-white border border-gray-100 rounded-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-[13px] font-semibold text-gray-900">{monthLabel} Profit</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">Cumulative this month</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => changeMonth(-1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                  <ChevronLeft size={14} />
                </button>
                <button onClick={() => changeMonth(1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            {dailyProfit.length > 0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={dailyProfit} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#F3F4F6" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "#9CA3AF" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: "#1A1A1E", border: "none", borderRadius: 8, color: "#fff", fontSize: 12 }}
                    formatter={(v: any) => [fmtFullAmount(Number(v) || 0), "Profit"]}
                    cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                  />
                  <Line type="monotone" dataKey="profit" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#10b981", strokeWidth: 0 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[210px] flex items-center justify-center text-[12px] text-gray-400">
                No profit data for this month
              </div>
            )}
          </div>

          {/* Right column: Top Clients + Top Suppliers stacked */}
          <div className="lg:col-span-2 flex flex-col gap-4">

            {/* Top Clients by Profit */}
            <div className="bg-white border border-gray-100 rounded-xl p-5 flex-1">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Top Clients</h3>
              <p className="text-[11px] text-gray-400 mb-3">Ranked by net profit</p>
              {stats?.top_clients_by_profit && stats.top_clients_by_profit.length > 0 ? (
                <div className="space-y-0.5">
                  {stats.top_clients_by_profit.slice(0, 4).map((c, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-50 transition-colors">
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold text-gray-300 flex-shrink-0">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-gray-900 truncate">{c.name}</div>
                        <div className="text-[10px] text-gray-400">{c.margin.toFixed(1)}% margin</div>
                      </div>
                      <div className="text-[12px] font-semibold text-emerald-600 tabular-nums flex-shrink-0"><CompactAmount value={c.total_profit} /></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-gray-400 text-center py-6">No profit data yet</div>
              )}
            </div>

            {/* Top Suppliers */}
            <div className="bg-white border border-gray-100 rounded-xl p-5 flex-1">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">Top Suppliers</h3>
              <p className="text-[11px] text-gray-400 mb-3">By total spend on closed deals</p>
              {stats?.top_suppliers && stats.top_suppliers.length > 0 ? (
                <div className="space-y-0.5">
                  {stats.top_suppliers.slice(0, 4).map((s, i) => (
                    <div key={i} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-50 transition-colors">
                      <span className="w-4 h-4 flex items-center justify-center text-[10px] font-bold text-gray-300 flex-shrink-0">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-gray-900 truncate">{s.name}</div>
                        <div className="text-[10px] text-gray-400 truncate">{s.contact_name || `${s.deal_count} deals`}</div>
                      </div>
                      <div className="text-[12px] font-semibold text-gray-700 tabular-nums flex-shrink-0"><CompactAmount value={s.total_paid} /></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-gray-400 text-center py-6">No supplier data yet</div>
              )}
            </div>

          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

          {/* Recent Invoices (2/3) */}
          <div className="xl:col-span-2 bg-white border border-gray-100 rounded-xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-50">
              <div>
                <h3 className="text-[13px] font-semibold text-gray-900">Recent Invoices</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">Latest billing activity</p>
              </div>
              <button
                onClick={() => onNavigate("invoices")}
                className="flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                View all <ArrowRight size={11} />
              </button>
            </div>
            {recentInvoices.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-14 text-center">
                <div>
                  <FileText size={24} className="text-gray-200 mx-auto mb-2" />
                  <p className="text-[13px] text-gray-400">No invoices yet</p>
                  <button onClick={() => onNavigate("invoices")} className="mt-2 text-[12px] text-indigo-600 font-medium">
                    Create first invoice →
                  </button>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-50">
                      <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Client</th>
                      <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest hidden sm:table-cell">Invoice #</th>
                      <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest hidden md:table-cell">Due</th>
                      <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Status</th>
                      <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentInvoices.map((inv) => (
                      <tr
                        key={inv.id}
                        onClick={() => onNavigate("invoices")}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/70 cursor-pointer transition-colors"
                      >
                        <td className="px-5 py-3 text-[13px] font-medium text-gray-900">
                          {clientName(inv.client_id)}
                        </td>
                        <td className="px-5 py-3 font-mono text-[11px] text-gray-400 hidden sm:table-cell">
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
            <div className="bg-white border border-gray-100 rounded-xl p-5">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-0.5">This Week</h3>
              <p className="text-[11px] text-gray-400 mb-4">Last 7 days</p>
              <div className="space-y-3">
                {weekStats.map((w) => (
                  <div key={w.label} className="flex items-center justify-between">
                    <span className="text-[12px] text-gray-500">{w.label}</span>
                    <span className={`text-[15px] font-bold tabular-nums ${w.color}`}>{w.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Incomplete Shipping */}
            {(stats?.incomplete_shipping ?? 0) > 0 && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Package size={14} className="text-amber-500 flex-shrink-0" />
                  <span className="text-[12px] text-gray-700">
                    {stats?.incomplete_shipping} invoice{stats?.incomplete_shipping !== 1 ? "s" : ""} need shipping info
                  </span>
                </div>
                <button onClick={() => onNavigate("invoices")}
                  className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 ml-2 flex-shrink-0">View</button>
              </div>
            )}

            {/* Loss Deals */}
            {(stats?.loss_deals_this_month ?? 0) > 0 && (
              <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-red-500">Loss Deals This Month</div>
                <div className="mt-1 flex items-end justify-between">
                  <div className="text-[22px] font-bold text-red-700">{stats?.loss_deals_this_month}</div>
                  <div className="text-[14px] font-semibold text-red-700"><CompactAmount value={stats?.loss_total_this_month ?? 0} /></div>
                </div>
              </div>
            )}

            {/* Top Buyers */}
            {topBuyers.length > 0 && (
              <div className="bg-white border border-gray-100 rounded-xl p-5">
                <h3 className="text-[13px] font-semibold text-gray-900 mb-4">Top Buyers</h3>
                <div className="space-y-1.5">
                  {topBuyers.map((h) => (
                    <div key={h.client_id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-gray-50 transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-gray-900 truncate">{h.client_name}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">
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
            <div className="bg-white border border-gray-100 rounded-xl p-5 flex flex-col flex-1">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">Follow-ups Due</h3>
                  <p className="text-[11px] text-gray-400 mt-0.5">Clients to contact today</p>
                </div>
                {followups.length > 0 && (
                  <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                    {followups.length}
                  </span>
                )}
              </div>

              {followups.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-4 text-center gap-1.5">
                  <CheckCircle2 size={22} className="text-emerald-400" />
                  <p className="text-[12px] font-medium text-gray-600">All caught up</p>
                  <p className="text-[11px] text-gray-400">No follow-ups due today</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {followups.map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-gray-900 truncate">{c.name}</p>
                        {c.company && <p className="text-[10px] text-gray-400 truncate">{c.company}</p>}
                      </div>
                      <span className="ml-2 flex-shrink-0 text-[10px] font-semibold text-amber-700 bg-amber-50 ring-1 ring-amber-200/70 px-2 py-0.5 rounded-full">
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
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <div className="px-5 py-2.5 border-b border-gray-50">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Quick Actions</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-gray-50">
            {[
              { label: "Add Client",  sub: "Create a new client profile",  icon: Users,    tab: "clients",  dot: "bg-indigo-500" },
              { label: "New Invoice", sub: "Generate and send an invoice",  icon: FileText, tab: "invoices", dot: "bg-violet-500" },
              { label: "Scan Inbox",  sub: "AI-process new emails",        icon: Mail,     tab: "email",    dot: "bg-emerald-500" },
            ].map((a) => (
              <button
                key={a.label}
                onClick={() => onNavigate(a.tab)}
                className="group flex items-center gap-3.5 px-5 py-4 hover:bg-gray-50/80 transition-colors w-full text-left"
              >
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${a.dot}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-gray-800 group-hover:text-gray-900 transition-colors">{a.label}</p>
                  <p className="text-[11px] text-gray-400">{a.sub}</p>
                </div>
                <ArrowRight size={13} className="text-gray-300 group-hover:text-gray-400 group-hover:translate-x-0.5 flex-shrink-0 transition-all" />
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
