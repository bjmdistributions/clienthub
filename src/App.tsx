import { useEffect, useState } from "react";
import {
  Users,
  FileText,
  Mail,
  Settings as SettingsIcon,
  LayoutDashboard,
  RefreshCw,
  Briefcase,
  BarChart3,
  Layers,
  GitBranch,
  Package,
} from "lucide-react";
import ClientsView from "./components/ClientsView";
import InvoicesView from "./components/InvoicesView";
import EmailView from "./components/EmailView";
import SettingsView from "./components/SettingsView";
import DashboardView from "./components/DashboardView";
import DealsView from "./components/DealsView";
import DealFlowView from "./components/DealFlowView";
import SuppliersView from "./components/SuppliersView";
import CloseoutView from "./components/CloseoutView";
import HealthView from "./components/HealthView";
import BriefView from "./components/BriefView";
import AnalyticsView from "./components/AnalyticsView";
import TiersView from "./components/TiersView";
import QuickLogModal from "./components/QuickLogModal";
import { useAppStore } from "./lib/store";
import { api } from "./lib/api";

type Tab = "dashboard" | "clients" | "health" | "deals" | "dealflow" | "suppliers" | "invoices" | "email" | "analytics" | "brief" | "settings";

export default function App() {
  const [tab, setTabState] = useState<Tab>(() =>
    (localStorage.getItem("clienthub_last_tab") as Tab) || "dashboard"
  );
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem("clienthub_last_tab", t); };
  const [draftCount, setDraftCount] = useState(0);
  const { aiOnline, checkAi } = useAppStore();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [quickLogOpen, setQuickLogOpen] = useState(false);

  useEffect(() => {
    checkAi();
    const id = setInterval(checkAi, 30000);
    return () => clearInterval(id);
  }, [checkAi]);

  useEffect(() => {
    api.syncStatus().then((s) => setLastSync(s.last_applied)).catch(() => {});
    api.listDrafts("pending").then((d) => setDraftCount(d.length)).catch(() => {});
  }, []);

  useEffect(() => {
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent<Tab>).detail;
      if (detail) setTab(detail);
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (e.key === "L" || e.key === "l") {
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (e.metaKey || e.ctrlKey) return;
        setQuickLogOpen((v) => !v);
      }
      if (e.key === "Escape") setQuickLogOpen(false);
      if (e.key === "n" || e.key === "N") {
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (tab === "clients") window.dispatchEvent(new CustomEvent("clients-new-client"));
        if (tab === "invoices") window.dispatchEvent(new CustomEvent("invoices-new-invoice"));
      }
    };
    window.addEventListener("navigate-tab", onNavigate);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("navigate-tab", onNavigate);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const n = await api.syncReplay();
      const s = await api.syncStatus();
      setLastSync(s.last_applied);
      if (n > 0) console.log(`Synced ${n} events`);
    } finally {
      setSyncing(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "dashboard", label: "Dashboard",  icon: LayoutDashboard },
    { id: "clients",   label: "Clients",    icon: Users },
    { id: "health",    label: "Tiers",      icon: Layers },
    { id: "deals",     label: "Closeout",   icon: Briefcase },
    { id: "analytics", label: "Analytics",  icon: BarChart3 },
    { id: "invoices",  label: "Invoices",   icon: FileText },
    { id: "dealflow",  label: "Deal Flow",  icon: GitBranch },
    { id: "suppliers", label: "Suppliers",  icon: Package },
    { id: "email",     label: "AI Email",   icon: Mail },
    { id: "brief",     label: "Brief",      icon: FileText },
    { id: "settings",  label: "Settings",   icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen bg-[#F7F6F4]">
      {/* Sidebar */}
      <aside className="w-[216px] bg-[#0C0C0E] flex flex-col flex-shrink-0 border-r border-white/[0.05]">
        {/* Brand */}
        <div className="h-[54px] px-4 flex items-center gap-2.5 border-b border-white/[0.05]">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(99,102,241,0.5)]">
            <span className="text-white text-[11px] font-bold tracking-tight">C</span>
          </div>
          <h1 className="text-[13px] font-semibold text-white tracking-tight">ClientHub</h1>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`relative w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[13px] transition-all duration-150 ${
                tab === id
                  ? "bg-white/[0.07] text-white font-medium"
                  : "text-[#7A7A82] hover:bg-white/[0.04] hover:text-white/75"
              }`}
            >
              {tab === id && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r-full bg-indigo-400 opacity-90" />
              )}
              <Icon size={15} strokeWidth={tab === id ? 2 : 1.7} />
              {label}
              {id === "email" && draftCount > 0 && (
                <span className="ml-auto bg-amber-400/15 text-amber-300 border border-amber-400/25 text-[10px] font-bold rounded-full px-1.5 leading-5">
                  {draftCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Status footer */}
        <div className="border-t border-white/[0.05] px-3 py-3 space-y-1">
          <div className="flex items-center justify-between px-1.5 py-0.5">
            <span className="flex items-center gap-1.5 text-[11px] text-[#52525A]">
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  aiOnline ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-red-400"
                }`}
              />
              Ollama
            </span>
            <span className={`text-[11px] font-medium ${aiOnline ? "text-emerald-400" : "text-red-400"}`}>
              {aiOnline ? "online" : "offline"}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center justify-between px-1.5 py-1.5 rounded-md text-[11px] text-[#52525A] hover:text-white/60 hover:bg-white/[0.04] transition-colors disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
              Sync
            </span>
            <span className="tabular-nums">
              {lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
            </span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        {tab === "dashboard" ? (
          <DashboardView onNavigate={setTab} />
        ) : (
          <div className="p-7">
            <div className="max-w-[1280px] mx-auto">
              {tab === "clients"   && <ClientsView />}
              {tab === "invoices"  && <InvoicesView />}
              {tab === "dealflow"  && <DealFlowView />}
              {tab === "suppliers" && <SuppliersView />}
              {tab === "deals"     && <CloseoutView />}
              {tab === "analytics" && <AnalyticsView />}
              {tab === "health"    && <TiersView />}
              {tab === "brief"     && <BriefView />}
              {tab === "email"     && <EmailView />}
              {tab === "settings"  && <SettingsView />}
            </div>
          </div>
        )}
      </main>

      {quickLogOpen && <QuickLogModal onClose={() => setQuickLogOpen(false)} />}
    </div>
  );
}
