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
  Grid3X3,
  Bot,
  Columns2,
  X,
  FileSignature,
} from "lucide-react";
import ClientsView from "./components/ClientsView";
import InvoicesView from "./components/InvoicesView";
import QuotesView from "./components/QuotesView";
import EmailView from "./components/EmailView";
import SettingsView from "./components/SettingsView";
import DashboardView from "./components/DashboardView";
import DealsView from "./components/DealsView";
import DealFlowView from "./components/DealFlowView";
import SuppliersView from "./components/SuppliersView";
import InventoryView from "./components/InventoryView";
import WhatsAppSharePanel from "./components/WhatsAppSharePanel";
import CloseoutView from "./components/CloseoutView";
import HealthView from "./components/HealthView";
import BriefView from "./components/BriefView";
import AnalyticsView from "./components/AnalyticsView";
import TiersView from "./components/TiersView";
import GlobeView from "./components/GlobeView";
import QuickLogModal from "./components/QuickLogModal";
import UpdateNotification from "./components/UpdateNotification";
import CommandPalette from "./components/CommandPalette";
import ShortcutsModal from "./components/ShortcutsModal";
import AutomationLogView from "./components/AutomationLogView";
import OnboardingWizard from "./components/OnboardingWizard";
import { useAppStore } from "./lib/store";
import { api, User } from "./lib/api";
import { canView } from "./lib/permissions";

type Tab = "dashboard" | "clients" | "health" | "deals" | "dealflow" | "suppliers" | "inventory" | "invoices" | "quotes" | "email" | "analytics" | "brief" | "automation" | "globe" | "settings";

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

  // Split-screen: optional second pane showing another tab alongside the main one.
  const [splitTab, setSplitTabState] = useState<Tab | null>(
    () => (localStorage.getItem("clienthub_split_tab") as Tab) || null
  );
  const setSplit = (t: Tab | null) => {
    setSplitTabState(t);
    if (t) localStorage.setItem("clienthub_split_tab", t);
    else localStorage.removeItem("clienthub_split_tab");
  };
  const toggleSplit = () => setSplit(splitTab ? null : (tab === "inventory" ? "email" : "inventory"));

  // Draggable split divider — left pane width as a fraction of the row.
  const [splitRatio, setSplitRatio] = useState(() => {
    const v = parseFloat(localStorage.getItem("clienthub_split_ratio") || "0.5");
    return isNaN(v) ? 0.5 : Math.min(0.8, Math.max(0.2, v));
  });
  useEffect(() => { localStorage.setItem("clienthub_split_ratio", String(splitRatio)); }, [splitRatio]);
  const splitRowRef = useRef<HTMLDivElement>(null);
  const draggingSplit = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingSplit.current || !splitRowRef.current) return;
      const rect = splitRowRef.current.getBoundingClientRect();
      const r = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, r)));
    };
    const onUp = () => {
      if (!draggingSplit.current) return;
      draggingSplit.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);
  const startSplitDrag = () => {
    draggingSplit.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
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

  // Accent color
  const [accent, setAccent] = useState(() => {
    const saved = localStorage.getItem("clienthub_accent");
    // Migrate retired accent ids to the new default.
    return saved && !["indigo", "red", "green", "black"].includes(saved) ? saved : "blue";
  });
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    if (accent === "blue") html.removeAttribute("data-accent");
    else html.setAttribute("data-accent", accent);
    localStorage.setItem("clienthub_accent", accent);
    const t = setTimeout(() => html.classList.remove("theme-transitioning"), 300);
    return () => clearTimeout(t);
  }, [accent]);
  useEffect(() => {
    const handler = (e: Event) => setAccent((e as CustomEvent).detail);
    window.addEventListener("accent-change", handler);
    return () => window.removeEventListener("accent-change", handler);
  }, []);
  useEffect(() => {
    const handler = (e: Event) => setDark((e as CustomEvent).detail);
    window.addEventListener("dark-change", handler);
    return () => window.removeEventListener("dark-change", handler);
  }, []);

  const [draftCount, setDraftCount] = useState(0);
  const { aiOnline, checkAi } = useAppStore();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sharePanelIds, setSharePanelIds] = useState<string[] | null>(null);
  const [shareMediaBase, setShareMediaBase] = useState("");
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<any | null>(undefined);

  useEffect(() => {
    api.getOnboardingStatus().then(setOnboarded).catch(() => setOnboarded(true));
  }, []);

  useEffect(() => {
    if (onboarded !== true) return;
    api.getCurrentUser().then((u) => setCurrentUser(u)).catch(() => setCurrentUser(null));
  }, [onboarded]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const ids = (e as CustomEvent).detail as string[];
      if (ids && ids.length > 0) {
        const base = await api.mediaBaseDir();
        setShareMediaBase(base);
        setSharePanelIds(ids);
      }
    };
    window.addEventListener("share-whatsapp", handler);
    return () => window.removeEventListener("share-whatsapp", handler);
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
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "L" || e.key === "l") {
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (mod) return;
        setQuickLogOpen((v) => !v);
      }
      if (e.key === "Escape") { setQuickLogOpen(false); setPaletteOpen(false); setShortcutsOpen(false); }
      if (e.key === "k" && mod) { e.preventDefault(); setPaletteOpen(v => !v); return; }
      if (e.key === "," && mod && tag !== "input" && tag !== "textarea" && tag !== "select") { e.preventDefault(); setTab("settings"); return; }
      if (e.key === "s" && mod) {
        if (tag === "input" || tag === "textarea" || tag === "select") {
          const form = (document.activeElement as HTMLElement)?.closest("form");
          if (form) { e.preventDefault(); form.requestSubmit(); return; }
        }
        return;
      }
      if (e.key === "/" && !mod && tag !== "input" && tag !== "textarea" && tag !== "select") { e.preventDefault(); setShortcutsOpen(v => !v); return; }
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

  const allTabs: { id: Tab; label: string; icon: any }[] = [
    { id: "dashboard", label: "Dashboard",  icon: LayoutDashboard },
    { id: "clients",   label: "Clients",    icon: Users },
    { id: "health",    label: "Tiers",      icon: Layers },
    { id: "deals",     label: "Completed",  icon: Briefcase },
    { id: "analytics", label: "Analytics",  icon: BarChart3 },
    { id: "invoices",  label: "Invoices",   icon: FileText },
    { id: "quotes",    label: "Quotes",     icon: FileSignature },
    { id: "dealflow",  label: "Deal Flow",  icon: GitBranch },
    { id: "suppliers", label: "Suppliers",  icon: Package },
    { id: "inventory", label: "Inventory",  icon: Grid3X3 },
    { id: "email",     label: "Newsletter", icon: Mail },
    { id: "brief",     label: "Brief",      icon: FileText },
    { id: "automation", label: "Automation",  icon: Bot },
    { id: "globe",     label: "Globe",      icon: Globe },
    { id: "settings",  label: "Settings",   icon: SettingsIcon },
  ];
  const tabs = allTabs.filter((t) => canView(currentUser?.role as any, t.id));

  // Background per tab (globe is full-bleed dark); shared by single + split panes.
  const paneBg = (t: Tab) => (t === "globe" ? "#0a0a14" : "var(--t-bg)");

  // Renders a tab's content without the outer scroll/background chrome, so it
  // can be dropped into either the single main area or a split pane.
  const paneContent = (t: Tab) => {
    if (t === "dashboard") return <DashboardView onNavigate={setTab} />;
    if (t === "globe") return <GlobeView />;
    return (
      <div className="p-7">
        <div className="max-w-[1280px] mx-auto">
          {t === "clients"    && <ClientsView />}
          {t === "invoices"   && <InvoicesView />}
          {t === "quotes"     && <QuotesView onNavigate={setTab} />}
          {t === "dealflow"   && <DealFlowView />}
          {t === "suppliers"  && <SuppliersView />}
          {t === "inventory"  && <InventoryView />}
          {t === "deals"      && <CloseoutView />}
          {t === "analytics"  && <AnalyticsView />}
          {t === "health"     && <TiersView />}
          {t === "automation" && <AutomationLogView />}
          {t === "brief"      && <BriefView currentUser={currentUser} />}
          {t === "email"      && <EmailView />}
          {t === "settings"   && <SettingsView />}
        </div>
      </div>
    );
  };

  if (onboarded === false) return <OnboardingWizard onDone={() => setOnboarded(true)} />;
  if (onboarded === null) return null;

  if (currentUser === undefined) return null;
  if (currentUser === null) return <UserPicker onSetUser={(u) => setCurrentUser(u)} />;
  if (!currentUser.is_active) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: "var(--t-bg)" }}>
        <div className="text-center">
          <h2 className="text-[18px] font-bold text-ink mb-2">Access Revoked</h2>
          <p className="text-[13px] text-muted">Your access has been removed. Contact your team owner.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--t-bg)" }}>
      {/* Sidebar */}
      <aside className="w-[216px] flex flex-col flex-shrink-0 relative" style={{
        background: "linear-gradient(180deg, #161618 0%, #0C0C0D 100%)",
        borderRight: "1px solid rgba(255,255,255,0.05)",
      }}>
        {/* Brand */}
        <div className="h-[54px] px-4 flex items-center gap-2.5 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}>
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 animate-glow-pulse"
            style={{
              background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))",
              boxShadow: "0 0 16px var(--accent-glow)",
            }}
          >
            <span className="text-white text-[12px] font-extrabold tracking-tight">B</span>
          </div>
          <h1 className="text-[13px] font-semibold text-white tracking-tight flex-1">Brokr</h1>

          {/* Dark mode toggle */}
          <button
            onClick={() => setDark(d => !d)}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
            style={{ color: dark ? "#FCD34D" : "#7A7A90" }}
            onMouseEnter={e => {
              e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              e.currentTarget.style.color = dark ? "#FDE68A" : "var(--accent-400)";
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

          {/* Split-view toggle */}
          <button
            onClick={toggleSplit}
            title={splitTab ? "Close split view" : "Open split view (two tabs side by side)"}
            className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
            style={{ color: splitTab ? "var(--accent-400)" : "#7A7A90" }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; if (!splitTab) e.currentTarget.style.color = "var(--accent-400)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = splitTab ? "var(--accent-400)" : "#7A7A90"; }}
          >
            <Columns2 size={13} strokeWidth={2} />
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
                background: "linear-gradient(90deg, var(--accent-tint) 0%, transparent 100%)",
              } : undefined}
            >
              <Icon
                size={15}
                strokeWidth={tab === id ? 2.1 : 1.6}
                style={tab === id ? { color: "var(--accent-400)" } : undefined}
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
                  <span className="w-1.5 h-1.5 rounded-full bg-success relative z-10 flex-shrink-0 block" />
                </span>
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-danger flex-shrink-0" />
              )}
              Ollama
            </span>
            <span className={`text-[11px] font-medium ${aiOnline ? "text-success-ink" : "text-danger-ink"}`}>
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
      <main className="flex-1 overflow-hidden">
        {splitTab ? (
          <div ref={splitRowRef} className="flex h-full">
            {/* Left pane — driven by the sidebar nav */}
            <section className="min-w-0 overflow-auto pane-container" style={{ width: `${splitRatio * 100}%`, background: paneBg(tab) }}>
              {tab !== "globe" && <UpdateNotification />}
              <div key={`l-${pageKey}`} className="page-enter h-full">{paneContent(tab)}</div>
            </section>

            {/* Draggable divider */}
            <div
              onMouseDown={startSplitDrag}
              className="w-1.5 flex-shrink-0 cursor-col-resize relative group"
              style={{ background: "var(--t-b1)" }}
              title="Drag to resize"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-[var(--accent-glow)] transition-colors" />
            </div>

            {/* Right pane — independent tab picker */}
            <section className="flex-1 min-w-0 overflow-auto relative pane-container" style={{ background: paneBg(splitTab) }}>
              <div className="sticky top-0 z-20 flex items-center gap-2 px-3 h-10 flex-shrink-0"
                style={{ background: "var(--t-s1)", borderBottom: "1px solid var(--t-b1)" }}>
                <Columns2 size={12} style={{ color: "var(--t-tx4)" }} />
                <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--t-tx4)" }}>Split</span>
                <select
                  value={splitTab}
                  onChange={(e) => setSplit(e.target.value as Tab)}
                  className="text-[12px] rounded-md px-2 h-7"
                  style={{ background: "var(--t-input-bg)", color: "var(--t-tx1)", border: "1px solid var(--t-b1)" }}
                >
                  {tabs.filter((t) => t.id !== "globe").map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => setSplit(null)}
                  className="ml-auto w-7 h-7 flex items-center justify-center rounded-md transition-colors"
                  style={{ color: "var(--t-tx3)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--t-s3)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  title="Close split view"
                >
                  <X size={14} />
                </button>
              </div>
              <div key={`r-${splitTab}`} className="page-enter">{paneContent(splitTab)}</div>
            </section>
          </div>
        ) : (
          <div className={tab === "globe" ? "h-full overflow-hidden" : "h-full overflow-auto"} style={{ background: paneBg(tab) }}>
            <div key={pageKey} className="page-enter h-full">
              {tab !== "globe" && <UpdateNotification />}
              {paneContent(tab)}
            </div>
          </div>
        )}
      </main>

      {quickLogOpen && <QuickLogModal onClose={() => setQuickLogOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {sharePanelIds && (
        <WhatsAppSharePanel
          lotIds={sharePanelIds}
          mediaBase={shareMediaBase}
          onClose={() => setSharePanelIds(null)}
        />
      )}
    </div>
  );
}

function UserPicker({ onSetUser }: { onSetUser: (u: any) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { api.listUsers().then(setUsers).catch(() => {}); }, []);

  const select = async (u: User) => {
    await api.setCurrentUser(u.id);
    onSetUser(u);
  };

  const claim = async () => {
    if (!inviteCode.trim()) return;
    setError("");
    try {
      const u = await api.claimInvite(inviteCode.trim());
      onSetUser(u);
    } catch (e: any) { setError(e.toString()); }
  };

  const active = users.filter((u) => u.is_active);
  return (
    <div className="flex h-screen items-center justify-center" style={{ background: "var(--t-bg)" }}>
      <div className="bg-surface border border-line rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <h2 className="text-[18px] font-bold text-ink mb-1">Select Profile</h2>
        <p className="text-[12px] text-muted mb-5">Choose your user profile or enter an invite code.</p>
        <div className="space-y-2 mb-5">
          {active.map((u) => (
            <button key={u.id} onClick={() => select(u)} className="w-full text-left px-4 py-3 rounded-xl border border-line hover:border-accent/20 hover:bg-accent/10 transition-colors">
              <p className="text-[14px] font-medium text-ink">{u.name}</p>
              <p className="text-[11px] text-muted">{u.email} — {u.role}</p>
            </button>
          ))}
          {active.length === 0 && <p className="text-[12px] text-muted">No users found. Enter an invite code below.</p>}
        </div>
        <div className="border-t border-gray-50 pt-4">
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Invite Code</p>
          <div className="flex gap-2">
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] flex-1" placeholder="Enter 6-digit code" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && claim()} />
            <button onClick={claim} disabled={!inviteCode.trim()} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">Claim</button>
          </div>
          {error && <p className="text-[11px] text-danger-ink mt-2">{error}</p>}
        </div>
      </div>
    </div>
  );
}
