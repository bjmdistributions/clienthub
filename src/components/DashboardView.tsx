import { useEffect, useState } from "react";
import { api, DashboardStats, Client } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Users, FileText, DollarSign, TrendingUp, Calendar, Mail, ArrowRight, CheckCircle2 } from "lucide-react";

interface Props {
  onNavigate: (t: any) => void;
  onViewClient?: (id: string) => void;
}

export default function DashboardView({ onNavigate, onViewClient }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [followups, setFollowups] = useState<Client[]>([]);

  useEffect(() => {
    api.dashboardStats().then(setStats).catch(console.error);
    api.dueFollowups().then(setFollowups).catch(console.error);
  }, []);

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const kpis = [
    {
      label: "Total Clients",
      sub: "active accounts",
      value: stats?.clients ?? 0,
      icon: Users,
      bg: "bg-indigo-600",
      tab: "clients",
    },
    {
      label: "Total Invoices",
      sub: "all time",
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

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-5">

      {/* Page header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <h2 className="text-[20px] font-semibold text-gray-900">Dashboard</h2>
        <span className="text-[13px] text-gray-400">{dateStr}</span>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4 flex-shrink-0">
        {kpis.map((k) => (
          <button
            key={k.label}
            onClick={() => onNavigate(k.tab)}
            className="bg-white border border-gray-200 rounded-xl p-5 text-left hover:shadow-md transition-shadow group"
          >
            <div className={`${k.bg} w-10 h-10 rounded-lg flex items-center justify-center mb-4`}>
              <k.icon size={18} className="text-white" />
            </div>
            <div className="text-[28px] font-bold text-gray-900 tabular-nums leading-none mb-1.5">
              {k.value}
            </div>
            <div className="text-[13px] font-medium text-gray-700">{k.label}</div>
            <div className="text-[12px] text-gray-400 mt-0.5">{k.sub}</div>
          </button>
        ))}
      </div>

      {/* Middle row — fills remaining space */}
      <div className="grid grid-cols-3 gap-4 flex-1 min-h-0">

        {/* This Week panel */}
        <div className="col-span-2 bg-white border border-gray-200 rounded-xl p-6 flex flex-col min-h-0">
          <div className="flex-shrink-0 mb-6">
            <h3 className="text-[15px] font-semibold text-gray-900">This Week</h3>
            <p className="text-[12px] text-gray-400 mt-0.5">What's happened in the last 7 days</p>
          </div>
          <div className="grid grid-cols-3 gap-6 flex-1">
            <div className="flex flex-col justify-center">
              <div className="text-[32px] font-bold text-emerald-600 tabular-nums leading-none">
                {fmtAmount(stats?.revenue_this_week ?? 0)}
              </div>
              <div className="text-[14px] font-medium text-gray-700 mt-2">Revenue Earned</div>
              <div className="text-[12px] text-gray-400 mt-0.5">from invoices paid</div>
            </div>
            <div className="flex flex-col justify-center border-l border-gray-100 pl-6">
              <div className="text-[32px] font-bold text-indigo-600 tabular-nums leading-none">
                {stats?.clients_this_week ?? 0}
              </div>
              <div className="text-[14px] font-medium text-gray-700 mt-2">New Clients</div>
              <div className="text-[12px] text-gray-400 mt-0.5">added to your account</div>
            </div>
            <div className="flex flex-col justify-center border-l border-gray-100 pl-6">
              <div className="text-[32px] font-bold text-violet-600 tabular-nums leading-none">
                {stats?.interactions_this_week ?? 0}
              </div>
              <div className="text-[14px] font-medium text-gray-700 mt-2">Interactions</div>
              <div className="text-[12px] text-gray-400 mt-0.5">calls, emails, meetings</div>
            </div>
          </div>
        </div>

        {/* Follow-ups panel */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 flex flex-col min-h-0">
          <div className="flex items-center justify-between flex-shrink-0 mb-4">
            <div>
              <h3 className="text-[15px] font-semibold text-gray-900">Follow-ups Due</h3>
              <p className="text-[12px] text-gray-400 mt-0.5">Clients to contact today</p>
            </div>
            {followups.length > 0 && (
              <span className="bg-amber-100 text-amber-700 text-[12px] font-semibold rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">
                {followups.length}
              </span>
            )}
          </div>

          {followups.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
              <CheckCircle2 size={28} className="text-emerald-400" />
              <p className="text-[14px] font-medium text-gray-600">All caught up</p>
              <p className="text-[12px] text-gray-400">No follow-ups due today</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
              {followups.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-gray-900 truncate">{c.name}</p>
                    {c.company && (
                      <p className="text-[12px] text-gray-400 truncate">{c.company}</p>
                    )}
                  </div>
                  <span className="ml-3 flex-shrink-0 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                    Today
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white border border-gray-200 rounded-xl flex-shrink-0">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-[12px] font-semibold text-gray-400 uppercase tracking-widest">Quick Actions</h3>
        </div>
        <div className="grid grid-cols-3 divide-x divide-gray-100">
          <button
            onClick={() => onNavigate("clients")}
            className="group flex items-center gap-4 px-6 py-4 hover:bg-indigo-50 transition-colors"
          >
            <div className="w-9 h-9 rounded-lg bg-indigo-100 group-hover:bg-indigo-200 flex items-center justify-center flex-shrink-0 transition-colors">
              <Users size={16} className="text-indigo-600" />
            </div>
            <div className="text-left min-w-0 flex-1">
              <div className="text-[14px] font-medium text-gray-800 group-hover:text-indigo-700">Add Client</div>
              <div className="text-[12px] text-gray-400">Create a new client profile</div>
            </div>
            <ArrowRight size={14} className="text-gray-300 group-hover:text-indigo-400 flex-shrink-0" />
          </button>
          <button
            onClick={() => onNavigate("invoices")}
            className="group flex items-center gap-4 px-6 py-4 hover:bg-violet-50 transition-colors"
          >
            <div className="w-9 h-9 rounded-lg bg-violet-100 group-hover:bg-violet-200 flex items-center justify-center flex-shrink-0 transition-colors">
              <FileText size={16} className="text-violet-600" />
            </div>
            <div className="text-left min-w-0 flex-1">
              <div className="text-[14px] font-medium text-gray-800 group-hover:text-violet-700">New Invoice</div>
              <div className="text-[12px] text-gray-400">Generate and send an invoice</div>
            </div>
            <ArrowRight size={14} className="text-gray-300 group-hover:text-violet-400 flex-shrink-0" />
          </button>
          <button
            onClick={() => onNavigate("email")}
            className="group flex items-center gap-4 px-6 py-4 hover:bg-emerald-50 transition-colors"
          >
            <div className="w-9 h-9 rounded-lg bg-emerald-100 group-hover:bg-emerald-200 flex items-center justify-center flex-shrink-0 transition-colors">
              <Mail size={16} className="text-emerald-600" />
            </div>
            <div className="text-left min-w-0 flex-1">
              <div className="text-[14px] font-medium text-gray-800 group-hover:text-emerald-700">Scan Inbox</div>
              <div className="text-[12px] text-gray-400">AI-process new emails</div>
            </div>
            <ArrowRight size={14} className="text-gray-300 group-hover:text-emerald-400 flex-shrink-0" />
          </button>
        </div>
      </div>

    </div>
  );
}
