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
import { useAppStore } from "./lib/store";
import { api } from "./lib/api";

type Tab = "dashboard" | "clients" | "invoices" | "email" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { aiOnline, checkAi } = useAppStore();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    checkAi();
    const id = setInterval(checkAi, 30000);
    return () => clearInterval(id);
  }, [checkAi]);

  useEffect(() => {
    api.syncStatus().then((s) => setLastSync(s.last_applied)).catch(() => {});
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
    { id: "clients", label: "Clients", icon: Users },
    { id: "invoices", label: "Invoices", icon: FileText },
    { id: "email", label: "AI Email", icon: Mail },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-slate-900 text-slate-100 flex flex-col">
        <div className="p-4">
          <h1 className="text-xl font-bold">ClientHub</h1>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm
                ${tab === id ? "bg-slate-700" : "hover:bg-slate-800"}`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>

        {/* Status footer */}
        <div className="border-t border-slate-700 p-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              {aiOnline ? (
                <Wifi size={12} className="text-green-400" />
              ) : (
                <WifiOff size={12} className="text-red-400" />
              )}
              Ollama
            </span>
            <span className="text-slate-400">
              {aiOnline ? "online" : "offline"}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center justify-between hover:bg-slate-800 px-2 py-1 rounded"
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw
                size={12}
                className={syncing ? "animate-spin" : ""}
              />
              Sync
            </span>
            <span className="text-slate-400">
              {lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
            </span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="p-6">
          {tab === "dashboard" && <DashboardView onNavigate={setTab} />}
          {tab === "clients" && <ClientsView />}
          {tab === "invoices" && <InvoicesView />}
          {tab === "email" && <EmailView />}
          {tab === "settings" && <SettingsView />}
        </div>
      </main>
    </div>
  );
}
