import { useEffect, useState, useRef } from "react";
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
  Sun,
  Moon,
  Globe,
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
import GlobeView from "./components/GlobeView";
import QuickLogModal from "./components/QuickLogModal";
import UpdateNotification from "./components/UpdateNotification";
import OnboardingWizard from "./components/OnboardingWizard";
import { useAppStore } from "./lib/store";
import { api } from "./lib/api";

type Tab = "dashboard" | "clients" | "health" | "deals" | "dealflow" | "suppliers" | "invoices" | "email" | "analytics" | "brief" | "globe" | "settings";

export default function App() {
  const [tab, setTabState] = useState<Tab>(() =>
    (localStorage.getItem("clienthub_last_tab") as Tab) || "dashboard"
  );
  const [pageKey, setPageKey] = useState(0);
  const setTab = (t: Tab) => {
    setTabState(t);
    setPageKey(k => k + 1);
    localStorage.setItem("clienthub_last_tab", t);
  };

  // Dark mode
  const [dark, setDark] = useState(() => localStorage.getItem("clienthub_dark") === "1");
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    html.classList.toggle("dark", dark);
    localStorage.setItem("clienthub_dark", dark ? "1" : "0");
    const t = setTimeout(() => html.classList.remove("theme-transitioning"), 300);
    return () => clearTimeout(t);
  }, [dark]);

  const [draftCount, setDraftCount] = useState(0);
  const { aiOnline, checkAi } = useAppStore();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    api.getOnboardingStatus().then(setOnboarded).catch(() => setOnboarded(true));
  }, []);

  // Sliding nav indicator
  const navRef = useRef<HTMLElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ top: 0, opacity: 0 });
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const btn = buttonRefs.current[tab];
    const nav = navRef.current;
    if (btn && nav) {
      const navRect = nav.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicatorStyle({
        top: btnRect.top - navRect.top + btnRect.height / 2 - 10,
        opacity: 1,
      });
    }
  }, [tab]);

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
    { id: "deals",     label: "Completed",  icon: Briefcase },
    { id: "analytics", label: "Analytics",  icon: BarChart3 },
    { id: "invoices",  label: "Invoices",   icon: FileText },
    { id: "dealflow",  label: "Deal Flow",  icon: GitBranch },
    { id: "suppliers", label: "Suppliers",  icon: Package },
    { id: "email",     label: "Newsletter", icon: Mail },
    { id: "brief",     label: "Brief",      icon: FileText },
    { id: "globe",     label: "Globe",      icon: Globe },
    { id: "settings",  label: "Settings",   icon: SettingsIcon },
  ];

  if (onboarded === false) return <OnboardingWizard onDone={() => setOnboarded(true)} />;
  if (onboarded === null) return null;

  return (
    <div className="flex h-screen" style={{ background: "var(--t-bg)" }}>
      {/* Sidebar */}
      <aside className="w-[216px] flex flex-col flex-shrink-0 relative" style={{
        background: "linear-gradient(180deg, #0A0A12 0%, #0D0D1A 100%)",
        borderRight: "1px solid rgba(255,255,255,0.045)",
      }}>
        {/* Brand */}
        <div className="h-[54px] px-4 flex items-center gap-2.5 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}>
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 animate-glow-pulse"
            style={{
              background: "linear-gradient(135deg, #6366F1, #7C3AED)",
              boxShadow: "0 0 16px rgba(99,102,241,0.55)",
            }}
          >
            <span className="text-white text-[11px] font-bold tracking-tight">C</span>
          </div>
          <h1 className="text-[13px] font-semibold text-white tracking-tight flex-1">ClientHub</h1>

          {/* Dark mode toggle */}
          <button
            onClick={() => setDark(d => !d)}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
            style={{ color: dark ? "#FCD34D" : "#7A7A90" }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              e.currentTarget.style.color = dark ? "#FDE68A" : "#A5B4FC";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = "";
              e.currentTarget.style.color = dark ? "#FCD34D" : "#7A7A90";
            }}
          >
            {dark
              ? <Sun size={13} strokeWidth={2} />
              : <Moon size={13} strokeWidth={2} />
            }
          </button>
        </div>

        {/* Nav */}
        <nav ref={navRef} className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto relative">
          {/* Sliding indicator */}
          <div
            className="nav-indicator"
            style={{ top: indicatorStyle.top, opacity: indicatorStyle.opacity }}
          />

          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={el => { buttonRefs.current[id] = el; }}
              onClick={() => setTab(id)}
              className={`relative w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[13px] tracking-tight transition-all duration-150 ${
                tab === id
                  ? "text-white font-medium"
                  : "text-[#6B6B7A] hover:text-white/80"
              }`}
              style={tab === id ? {
                background: "linear-gradient(90deg, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0.05) 100%)",
              } : undefined}
            >
              <Icon
                size={15}
                strokeWidth={tab === id ? 2.1 : 1.6}
                style={tab === id ? { color: "#A5B4FC" } : undefined}
              />
              {label}
              {id === "email" && draftCount > 0 && (
                <span className="ml-auto text-[10px] font-bold rounded-full px-1.5 leading-5"
                  style={{ background: "rgba(251,191,36,0.15)", color: "#FCD34D", border: "1px solid rgba(251,191,36,0.25)" }}>
                  {draftCount}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Status footer */}
        <div className="px-3 py-3 space-y-1 flex-shrink-0" style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
          <div className="flex items-center justify-between px-1.5 py-0.5">
            <span className="flex items-center gap-2 text-[11px]" style={{ color: "#4A4A5A" }}>
              {aiOnline ? (
                <span className="pulse-ring flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 relative z-10 flex-shrink-0 block" />
                </span>
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
              )}
              Ollama
            </span>
            <span className={`text-[11px] font-medium ${aiOnline ? "text-emerald-400" : "text-red-400"}`}>
              {aiOnline ? "online" : "offline"}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center justify-between px-1.5 py-1.5 rounded-md text-[11px] transition-colors disabled:opacity-50"
            style={{ color: "#4A4A5A" }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
            onMouseLeave={e => (e.currentTarget.style.background = "")}
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
      <main className={`flex-1 ${tab === "globe" ? "overflow-hidden" : "overflow-auto"}`} style={{ background: tab === "globe" ? "#0a0a14" : "var(--t-bg)" }}>
          <div key={pageKey} className="page-enter h-full">
            {tab !== "globe" && <UpdateNotification />}
            {tab === "dashboard" ? (
            <DashboardView onNavigate={setTab} />
          ) : tab === "globe" ? (
            <GlobeView />
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
        </div>
      </main>

      {quickLogOpen && <QuickLogModal onClose={() => setQuickLogOpen(false)} />}
    </div>
  );
}
