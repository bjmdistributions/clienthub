import { useEffect, useState } from "react";
import { api, DashboardStats } from "../lib/api";
import { Users, FileText, DollarSign, TrendingUp } from "lucide-react";

interface Props {
  onNavigate: (t: any) => void;
}

export default function DashboardView({ onNavigate }: Props) {
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    api.dashboardStats().then(setStats).catch(console.error);
  }, []);

  const cards = [
    {
      label: "Clients",
      value: stats?.clients ?? 0,
      icon: Users,
      color: "bg-blue-500",
      tab: "clients",
    },
    {
      label: "Invoices",
      value: stats?.invoices ?? 0,
      icon: FileText,
      color: "bg-violet-500",
      tab: "invoices",
    },
    {
      label: "Outstanding",
      value: `$${(stats?.outstanding ?? 0).toFixed(2)}`,
      icon: DollarSign,
      color: "bg-amber-500",
      tab: "invoices",
    },
    {
      label: "Paid YTD",
      value: `$${(stats?.paid_ytd ?? 0).toFixed(2)}`,
      icon: TrendingUp,
      color: "bg-green-500",
      tab: "invoices",
    },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>
      <div className="grid grid-cols-4 gap-4 mb-6">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => onNavigate(c.tab)}
            className="bg-white p-5 rounded-lg shadow hover:shadow-md transition text-left"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-slate-500">{c.label}</span>
              <div className={`${c.color} p-2 rounded text-white`}>
                <c.icon size={16} />
              </div>
            </div>
            <div className="text-2xl font-bold">{c.value}</div>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold mb-3">Quick Actions</h3>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => onNavigate("clients")}
            className="border border-slate-200 hover:bg-slate-50 p-4 rounded text-left"
          >
            <div className="font-medium text-sm">Add Client</div>
            <div className="text-xs text-slate-500">Create a new client profile</div>
          </button>
          <button
            onClick={() => onNavigate("invoices")}
            className="border border-slate-200 hover:bg-slate-50 p-4 rounded text-left"
          >
            <div className="font-medium text-sm">New Invoice</div>
            <div className="text-xs text-slate-500">Generate and send an invoice</div>
          </button>
          <button
            onClick={() => onNavigate("email")}
            className="border border-slate-200 hover:bg-slate-50 p-4 rounded text-left"
          >
            <div className="font-medium text-sm">Scan Inbox</div>
            <div className="text-xs text-slate-500">AI-process new emails</div>
          </button>
        </div>
      </div>
    </div>
  );
}
