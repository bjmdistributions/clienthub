import { useEffect, useState } from "react";
import {
  Users,
  FileText,
  Mail,
  Settings as SettingsIcon,
  LayoutDashboard,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import ClientsView from "./components/ClientsView";
import InvoicesView from "./components/InvoicesView";
import EmailView from "./components/EmailView";
import SettingsView from "./components/SettingsView";
import DashboardView from "./components/DashboardView";
import QuickLogModal from "./components/QuickLogModal";
import { useAppStore } from "./lib/store";
import { api } from "./lib/api";

type Tab = "dashboard" | "clients" | "invoices" | "email" | "settings";

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
        if (tab === "clients") {
          window.dispatchEvent(new CustomEvent("clients-new-client"));
        }
        if (tab === "invoices") {
          window.dispatchEvent(new CustomEvent("invoices-new-invoice"));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "clients",   label: "Clients",   icon: Users },
    { id: "invoices",  label: "Invoices",  icon: FileText },
    { id: "email",     label: "AI Email",  icon: Mail },
    { id: "settings",  label: "Settings",  icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-[220px] bg-slate-900 flex flex-col flex-shrink-0">
        {/* Brand */}
        <div className="h-14 px-5 flex items-center border-b border-slate-700/60">
          <h1 className="text-[15px] font-semibold text-white tracking-tight">ClientHub</h1>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full flex items-center gap-3 px-3 h-10 rounded-md text-sm transition-colors ${
                tab === id
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Icon size={18} />
              {label}
              {id === "email" && draftCount > 0 && (
                <span className="ml-auto bg-amber-400 text-amber-900 text-[11px] font-bold rounded-full px-1.5 py-0.5 leading-none">
                  {draftCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Status footer */}
        <div className="border-t border-slate-700/60 px-4 py-3 space-y-1">
          <div className="flex items-center justify-between text-[12px] text-slate-400">
            <span className="flex items-center gap-1.5">
              {aiOnline ? (
                <Wifi size={12} className="text-emerald-400" />
              ) : (
                <WifiOff size={12} className="text-red-400" />
              )}
              Ollama
            </span>
            <span className={aiOnline ? "text-emerald-400 font-medium" : "text-red-400"}>
              {aiOnline ? "online" : "offline"}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center justify-between text-[12px] text-slate-400 hover:text-white hover:bg-slate-800 px-2 py-1.5 rounded-md transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
              Sync
            </span>
            <span className="text-slate-500 tabular-nums">
              {lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
            </span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-[#F8F7F6]">
        {tab === "dashboard" ? (
          <DashboardView onNavigate={setTab} />
        ) : (
          <div className="p-8">
            <div className="max-w-[1200px] mx-auto">
              {tab === "clients"   && <ClientsView />}
              {tab === "invoices"  && <InvoicesView />}
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
