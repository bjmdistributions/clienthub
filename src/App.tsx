import { useEffect, useLayoutEffect, useState, useRef, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Users,
  FileText,
  Mail,
  Settings as SettingsIcon,
  LayoutDashboard,
  RefreshCw, LogOut,
  PanelLeftClose, PanelLeftOpen,
  Briefcase,
  BarChart3,
  Layers,
  GitBranch,
  Package,
  Sun,
  Moon,
  Globe,
  StickyNote,
  Grid3X3,
  Bot,
  ChevronRight,
  Columns2,
  X,
  FileSignature,
  Bell,
  MessageSquarePlus,
  ClipboardCheck,
  ClipboardList,
  Building2,
  ShieldAlert,
  Wallet,
  Banknote,
  Landmark,
  Archive as ArchiveIcon,
  CopyPlus,
  FileCheck2,
} from "lucide-react";
import ClientsView from "./components/ClientsView";
import InvoicesView from "./components/InvoicesView";
import ReceivablesView from "./components/ReceivablesView";
import PayablesView from "./components/PayablesView";
import QuotesView from "./components/QuotesView";
import EmailView from "./components/EmailView";
import DashboardView from "./components/DashboardView";
import DealFlowView from "./components/DealFlowView";
import SuppliersView from "./components/SuppliersView";
import InventoryView from "./components/InventoryView";
import ManifestView from "./components/ManifestView";
import WhatsAppSharePanel from "./components/WhatsAppSharePanel";
import CloseoutView from "./components/CloseoutView";
import BriefView from "./components/BriefView";
import TiersView from "./components/TiersView";
import NotesView from "./components/NotesView";
import PlatformView from "./components/PlatformView";
import DataSafetyView from "./components/DataSafetyView";
import ArchiveView from "./components/ArchiveView";
import SheetCopyView from "./components/SheetCopyView";
import ReleaseLetterView from "./components/ReleaseLetterView";
import FinancialsView from "./components/FinancialsView";
import { ApprovalsView } from "./components/ApprovalsView";
import { FeedbackModal } from "./components/FeedbackModal";
import CheckupView from "./components/CheckupView";
import QuickLogModal from "./components/QuickLogModal";
import UpdateNotification from "./components/UpdateNotification";
import { ToastHost } from "./components/Toast";
import CommandPalette from "./components/CommandPalette";
import ShortcutsModal from "./components/ShortcutsModal";
import AutomationLogView from "./components/AutomationLogView";
import OnboardingWizard from "./components/OnboardingWizard";
import GettingStarted from "./components/GettingStarted";
import AuthView from "./components/AuthView";
import { useAppStore } from "./lib/store";
import { api, Me } from "./lib/api";
import { can, canViewTab, isAdmin } from "./lib/permissions";

// Screens heavy enough that parsing them at launch is felt by every session that
// never opens them. Globe is the expensive one — it is the only importer of
// globe.gl, which carries three.js with it, together the largest thing in the
// build. Analytics pulls the chart families the dashboard does not use, and
// Settings is the largest screen by code. Each becomes its own chunk, read from
// local disk the first time its tab is opened.
const GlobeView     = lazy(() => import("./components/GlobeView"));
const AnalyticsView = lazy(() => import("./components/AnalyticsView"));
const SettingsView  = lazy(() => import("./components/SettingsView"));

// Shown while a lazy chunk is read off local disk. It repeats the overlay the
// globe draws over its own dark ground while it initialises, in the same place,
// so the chunk arriving changes nothing the eye can catch.
const globeFallback = (
  <div className="globe-root relative w-full h-full" style={{ background: "#060610", color: "#eef0f6" }}>
    <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
      <div className="text-[13px]" style={{ color: "#7E8798" }}>Loading globe…</div>
    </div>
  </div>
);

// The same for the screens that share the padded column: title, subtitle, then
// content, in the skeleton idiom those screens already use for their own loading
// state. Sizes match Analytics' skeleton so the top of the page does not move
// when the real screen takes over.
const paneFallback = (
  <div className="space-y-5">
    <div className="flex items-start justify-between">
      <div>
        <div className="h-6 w-28 bg-surface-2 rounded-md animate-pulse" />
        <div className="h-3.5 w-44 bg-surface-2 rounded animate-pulse mt-2" />
      </div>
      <div className="h-8 w-64 bg-surface-2 rounded-lg animate-pulse" />
    </div>
    <div className="h-[108px] bg-surface-2 rounded-2xl animate-pulse" />
    <div className="h-[300px] bg-surface-2 rounded-xl animate-pulse" />
  </div>
);

type Tab = "dashboard" | "clients" | "health" | "deals" | "dealflow" | "suppliers" | "inventory" | "manifest" | "invoices" | "receivables" | "payables" | "quotes" | "releaseletter" | "email" | "analytics" | "brief" | "automation" | "globe" | "notes" | "approvals" | "checkup" | "archive" | "sheetcopy" | "financials" | "platform" | "datasafety" | "settings";

/** Below this window width the sidebar collapses itself.
 *
 *  1280 is the principled number - it is where the 28 `xl:` breakpoints across the
 *  screens fire, and they were authored as if they owned the whole window when in
 *  fact they live in a column of `viewport - 216 - 56`. A 56px rail hands back 160px
 *  of that. 1240 rather than 1280 because a 1280 window reports innerWidth ~1264
 *  once Windows chrome is subtracted, and a fresh install must not launch collapsed. */
const NAV_COLLAPSE_AT = 1240;

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
  // Which expandable nav groups the user has manually opened (the active group is
  // always shown regardless). Persisted so the tree restores on relaunch.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("clienthub_nav_open") || "[]")); }
    catch { return new Set(); }
  });
  const toggleGroup = (gid: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    next.has(gid) ? next.delete(gid) : next.add(gid);
    localStorage.setItem("clienthub_nav_open", JSON.stringify([...next]));
    return next;
  });

  // Sidebar collapse. Two inputs, one rule: the window decides by default, and a
  // manual choice overrides it until the window next crosses the threshold. That is
  // what stops the rail from springing shut again the moment you open it on a narrow
  // window, while still auto-collapsing when you actually resize.
  const narrowRef = useRef(window.innerWidth < NAV_COLLAPSE_AT);
  const [narrow, setNarrow] = useState(narrowRef.current);
  const [manualNav, setManualNav] = useState<boolean | null>(() => {
    const v = localStorage.getItem("clienthub_nav_collapsed");
    return v === "1" ? true : v === "0" ? false : null;
  });
  const navCollapsed = manualNav ?? narrow;
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < NAV_COLLAPSE_AT;
      if (n === narrowRef.current) return;
      narrowRef.current = n;
      setNarrow(n);
      // Crossing the threshold hands control back to the window.
      setManualNav(null);
      localStorage.removeItem("clienthub_nav_collapsed");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const toggleNav = () => setManualNav((prev) => {
    const next = !(prev ?? narrowRef.current);
    localStorage.setItem("clienthub_nav_collapsed", next ? "1" : "0");
    return next;
  });
  // Canvases and charts that size themselves off a measured width (GlobeView, the
  // split panes) only listen for window resize, which a width transition never fires.
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 160);
    return () => clearTimeout(t);
  }, [navCollapsed]);

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

  // Mono (monochrome) — orthogonal to light/dark. It strips the accent and goes
  // grayscale; combined with dark it's the pure-black look, with light it's the
  // clean white/black look. Persisted independently of `dark` (no forced dark).
  const [matte, setMatte] = useState(() => localStorage.getItem("clienthub_matte") === "1");
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    html.classList.toggle("matte", matte);
    localStorage.setItem("clienthub_matte", matte ? "1" : "0");
    const t = setTimeout(() => html.classList.remove("theme-transitioning"), 300);
    return () => clearTimeout(t);
  }, [matte]);

  // Accent color
  const [accent, setAccent] = useState(() => {
    const saved = localStorage.getItem("clienthub_accent");
    // Migrate retired accent ids (and the old blue default) to the new default: Ecliptr orange.
    return saved && !["indigo", "red", "green", "black", "slate", "blue"].includes(saved) ? saved : "orange";
  });
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    if (accent === "orange") html.removeAttribute("data-accent");
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
  useEffect(() => {
    const handler = (e: Event) => setMatte((e as CustomEvent).detail);
    window.addEventListener("matte-change", handler);
    return () => window.removeEventListener("matte-change", handler);
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
  const [showTour, setShowTour] = useState(false);
  const [superadmin, setSuperadmin] = useState(false);
  // Superadmin is confirmed two ways so the Platform tab is reliable across a user's
  // devices: the server (netsync session) OR the locally signed-in owner account. The
  // netsync session can be a different/stale server identity on one device even when the
  // local login is the same account, which hid the tab on one machine but not another.
  const [localSuper, setLocalSuper] = useState(false);
  // Org plan id ("unlimited" = top tier). Drives the Sheet-copy tab gate. The UI
  // gate is convenience only — the Rust command is the authoritative check.
  const [plan, setPlan] = useState<string | null>(null);
  // me: undefined = loading, null = signed out, Me = signed in.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [orgName, setOrgName] = useState<string>("");
  const [apCount, setApCount] = useState<number>(0);
  const [fbOpen, setFbOpen] = useState<boolean>(false);
  // First-run getting-started tour (after setup + sign-in), and a replay hook.
  useEffect(() => {
    if (onboarded === true && me) {
      try { if (localStorage.getItem("ec_welcome_desktop_v1") !== "1") setShowTour(true); } catch { /* ignore */ }
    }
  }, [onboarded, me]);
  useEffect(() => {
    const replay = () => setShowTour(true);
    window.addEventListener("replay-tour", replay);
    return () => window.removeEventListener("replay-tour", replay);
  }, []);
  useEffect(() => {
    if (me) {
      api.getMyPlan().then((p) => { setSuperadmin(!!p.is_superadmin); setPlan(p.plan); }).catch(() => { setSuperadmin(false); setPlan(null); });
      api.localIsSuperadmin().then(setLocalSuper).catch(() => setLocalSuper(false));
    }
  }, [me]);

  // Poll the notification queue for the bell badge. This MUST match exactly what
  // the Notifications view shows when opened: pending customers awaiting review
  // PLUS team requests that aren't plain new-customer adds. (A `client_add`
  // request is already represented by its pending customer, so counting the raw
  // approvals total double-counted it and made the bell read high — the "1 when
  // nothing" bug.)
  useEffect(() => {
    if (!me?.is_admin) { setApCount(0); return; }
    const refresh = () => Promise.all([
      api.listApprovalRequests().catch(() => []),
      api.getPendingApprovals().catch(() => []),
    ]).then(([reqs, pend]) => {
      const nonAdd = reqs.filter((a) => a.kind !== "client_add").length;
      setApCount(pend.length + nonAdd);
    }).catch(() => {});
    refresh();
    const onChanged = () => refresh();
    window.addEventListener("approvals-changed", onChanged);
    // A netsync pull that applied remote changes may have resolved (or added)
    // pending items on another device — refresh the bell right away.
    let unlisten: (() => void) | undefined;
    listen("netsync-applied", () => refresh()).then((u) => { unlisten = u; }).catch(() => {});
    const t = setInterval(refresh, 60000);
    return () => { window.removeEventListener("approvals-changed", onChanged); clearInterval(t); unlisten?.(); };
  }, [me?.is_admin]);

  useEffect(() => {
    api.getOrganizationName().then((n) => setOrgName((n || "").trim())).catch(() => {});
  }, []);

  // Auth is the gate — resolved independent of onboarding. Accounts are created
  // on the website, so the desktop only signs in; a fresh reinstall shows the
  // sign-in screen, never the onboarding/company wizard.
  useEffect(() => {
    api.employeeStatus()
      .then((s) => {
        if (s.signed_in) api.employeeMe().then((u) => setMe(u)).catch(() => setMe(null));
        else setMe(null);
      })
      .catch(() => setMe(null));
  }, []);

  // Onboarding is only ever relevant AFTER sign-in. A signed-in (website-created)
  // account returns onboarded=true, so the wizard never pops on reinstall.
  useEffect(() => {
    if (!me) { setOnboarded(null); return; }
    api.getOnboardingStatus().then(setOnboarded).catch(() => setOnboarded(true));
  }, [me]);

  const signOut = async () => {
    try { await api.employeeLogout(); } catch {}
    setMe(null);
  };

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

  useLayoutEffect(() => {
    const measure = () => {
      const btn = buttonRefs.current[tab];
      const nav = navRef.current;
      if (!btn || !nav) return;
      const navRect = nav.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicatorStyle({
        top: btnRect.top - navRect.top + btnRect.height / 2 - 10,
        opacity: 1,
      });
    };
    measure();
    // The old [tab]-only effect measured once and never recomputed, so the bar
    // stayed on the previously-measured tab when the nav layout shifted (window
    // resize, tab list add/remove, fonts settling). Recompute on those too.
    const nav = navRef.current;
    const ro = nav ? new ResizeObserver(measure) : null;
    if (nav && ro) ro.observe(nav);
    window.addEventListener("resize", measure);
    return () => { window.removeEventListener("resize", measure); ro?.disconnect(); };
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
      if (e.key === "b" && mod) { e.preventDefault(); toggleNav(); return; }
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

  // Consolidated sidebar: workflow mains, each expandable to reveal its sub-items
  // (Jack's "drop down on a main category"), plus a bottom utility zone. Every id
  // still maps to a real view in paneContent — nothing was dropped, only regrouped.
  type NavKid = { id: Tab; label: string; icon: any };
  type NavNode = NavKid & { children?: NavKid[] };
  // Ordered by daily flow: overview → who you deal with → what you stock/analyze →
  // pipeline → the documents that close a deal → money → outreach → insight. Dashboard
  // stays pinned on top; Quote sits directly under Invoice.
  const NAV: NavNode[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "clients", label: "Clients", icon: Users, children: [
      { id: "checkup", label: "Checkup", icon: ClipboardCheck },
      { id: "health",  label: "Tiers",   icon: Layers },
      { id: "approvals", label: "Approvals", icon: Bell },
    ] },
    { id: "suppliers", label: "Suppliers", icon: Package },
    { id: "inventory", label: "Inventory", icon: Grid3X3, children: [
      { id: "sheetcopy", label: "Sheet copy", icon: CopyPlus },
    ] },
    { id: "manifest", label: "Manifest analyzer", icon: ClipboardList },
    { id: "dealflow", label: "Deal Flow", icon: GitBranch },
    { id: "invoices", label: "Invoice", icon: FileText, children: [
      { id: "deals",      label: "Completed",  icon: Briefcase },
      { id: "receivables", label: "Receivables", icon: Wallet },
      { id: "payables",   label: "Payables",   icon: Banknote },
    ] },
    { id: "quotes", label: "Quote", icon: FileSignature, children: [
      { id: "releaseletter", label: "Release letter", icon: FileCheck2 },
    ] },
    { id: "financials", label: "Financials", icon: Landmark },
    { id: "email", label: "Newsletter", icon: Mail },
    { id: "brief", label: "Brief", icon: FileText },
    { id: "analytics", label: "Analytics", icon: BarChart3, children: [
      { id: "automation", label: "Automation", icon: Bot },
      { id: "globe",      label: "Globe",      icon: Globe },
    ] },
  ];
  const UTILITY: NavKid[] = [
    { id: "notes",    label: "Notes",    icon: StickyNote },
    { id: "archive",  label: "Archive",  icon: ArchiveIcon },
    { id: "platform", label: "Platform", icon: Building2 },
    { id: "datasafety", label: "Data safety", icon: ShieldAlert },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];

  // Same per-id gating as before (parents, children, and utility items alike).
  const visible = (id: Tab): boolean =>
    id === "platform" ? (superadmin || localSuper)
    : id === "datasafety" ? (superadmin || localSuper) // secret integrity console

    : id === "archive" ? isAdmin(me)              // admin-only, like the money views
    // Books area. Admins keep access unconditionally (as before); a non-admin
    // now needs an explicit financials:view grant, which no role template hands out.
    : id === "financials" ? (isAdmin(me) || can(me, "financials:view"))

    : id === "sheetcopy" ? (plan === "unlimited") // top-tier only (server also enforces)
    : id === "approvals" ? isAdmin(me)            // was the header bell; also a Clients sub-item
    : id === "manifest" ? canViewTab(me, "inventory" as any) // analyzer rides inventory access
    : canViewTab(me, id as any);

  // Flat list of every visible destination (mains + sub-items + utility) — used by
  // the split-view picker, which needs one flat menu rather than the grouped tree.
  const flatTabs: NavKid[] = [
    ...NAV.flatMap((n) => [{ id: n.id, label: n.label, icon: n.icon } as NavKid, ...(n.children || [])]),
    ...UTILITY,
  ].filter((t) => visible(t.id));

  // A group is open when the user opened it, or the active tab lives inside it.
  const parentOfActive = NAV.find((n) => n.children?.some((c) => c.id === tab))?.id ?? null;
  const isGroupOpen = (n: NavNode) => openGroups.has(n.id) || parentOfActive === n.id || tab === n.id;

  // One nav row: a leaf main or an indented sub-item. Group parents pair this with a
  // sibling chevron button (see the render below) rather than nesting one.
  const navButton = (item: NavKid, isChild: boolean) => {
    const Icon = item.icon;
    const active = tab === item.id;
    return (
      <button
        key={item.id}
        ref={(el) => { buttonRefs.current[item.id] = el; }}
        onClick={() => setTab(item.id)}
        title={navCollapsed ? item.label : undefined}
        className={`relative w-full flex items-center gap-2.5 ${
          navCollapsed ? "justify-center px-0" : isChild ? "pl-8 pr-2" : "px-2.5"
        } h-9 rounded-lg text-[13px] tracking-tight transition-all duration-150 ${
          active ? "text-white font-medium" : "text-[#6B6B7A] hover:text-white/80"
        }`}
        style={active ? { background: "linear-gradient(90deg, var(--accent-tint) 0%, transparent 100%)" } : undefined}
      >
        <Icon size={isChild && !navCollapsed ? 13 : 15} strokeWidth={active ? 2.1 : 1.6} style={active ? { color: "var(--accent-400)" } : undefined} />
        {!navCollapsed && item.label}
        {item.id === "email" && draftCount > 0 && (
          navCollapsed
            ? <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full" style={{ background: "#FCD34D" }} />
            : <span className="ml-auto text-[10px] font-bold rounded-full px-1.5 leading-5"
                style={{ background: "rgba(251,191,36,0.15)", color: "#FCD34D", border: "1px solid rgba(251,191,36,0.25)" }}>
                {draftCount}
              </span>
        )}
        {item.id === "approvals" && apCount > 0 && (
          navCollapsed
            ? <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-red-500" />
            : <span className="ml-auto min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-4 text-center">
                {apCount > 9 ? "9+" : apCount}
              </span>
        )}
      </button>
    );
  };

  // Background per tab (globe is full-bleed dark); shared by single + split panes.
  const paneBg = (t: Tab) => (t === "globe" ? "#0a0a14" : "var(--t-bg)");

  // Renders a tab's content without the outer scroll/background chrome, so it
  // can be dropped into either the single main area or a split pane.
  const paneContent = (t: Tab) => {
    if (t === "dashboard") return <DashboardView onNavigate={setTab} me={me} />;
    if (t === "globe") return <Suspense fallback={globeFallback}><GlobeView /></Suspense>;
    if (t === "notes") return <NotesView me={me?.display_name || ""} />;
    if (t === "approvals") return <ApprovalsView />;
    if (t === "checkup") return <CheckupView />;
    return (
      <div className="p-7">
        <div className="max-w-[1280px] mx-auto">
          {/* Wraps the whole column rather than the lazy screens individually:
              the padding and width are already on screen, so only the content
              area swaps, and any screen made lazy later is covered too. */}
          <Suspense fallback={paneFallback}>
            {t === "clients"    && <ClientsView />}
            {t === "invoices"   && <InvoicesView />}
            {t === "archive"    && <ArchiveView />}
            {t === "receivables" && <ReceivablesView />}
            {t === "payables"   && <PayablesView />}
            {t === "quotes"     && <QuotesView onNavigate={setTab} />}
            {t === "releaseletter" && <ReleaseLetterView />}
            {t === "dealflow"   && <DealFlowView />}
            {t === "suppliers"  && <SuppliersView />}
            {t === "inventory"  && <InventoryView />}
            {t === "manifest"   && <ManifestView onNavigate={setTab} />}
            {t === "sheetcopy"  && <SheetCopyView />}
            {t === "financials" && <FinancialsView />}
            {t === "deals"      && <CloseoutView />}
            {t === "analytics"  && <AnalyticsView />}
            {t === "health"     && <TiersView />}
            {t === "automation" && <AutomationLogView />}
            {t === "brief"      && <BriefView currentUser={me ? { name: me.display_name, role: me.is_admin ? "owner" : "sales_rep" } : null} />}
            {t === "email"      && <EmailView />}
            {t === "settings"   && <SettingsView me={me} />}
            {t === "platform"   && <PlatformView />}
            {t === "datasafety" && <DataSafetyView />}
          </Suspense>
        </div>
      </div>
    );
  };

  // Auth gates everything: not signed in → sign-in screen (accounts are made on
  // the website). Onboarding is only considered once signed in, and only if the
  // account genuinely hasn't completed it — never on a fresh reinstall.
  if (me === undefined) return null; // loading session
  if (me === null) return <AuthView onAuthed={(u) => setMe(u)} />;
  if (onboarded === null) return null; // resolving onboarding status for this account
  if (onboarded === false) return <OnboardingWizard onDone={() => setOnboarded(true)} />;

  // Bell, dark mode and split view. They sit in the brand row when the sidebar is
  // open and stack in the footer when it is collapsed - split view has no other
  // entry point, so hiding them at 56px would strand it.
  const shellButtons = (
    <>
        {/* Approvals notification bell (admins only) */}
        {me?.is_admin && (
          <button
            onClick={() => setTab("approvals")}
            title={apCount > 0 ? `${apCount} waiting for review` : "Notifications"}
            className="relative w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
            style={{ color: tab === "approvals" ? "var(--accent-400)" : "#7A7A90" }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; if (tab !== "approvals") e.currentTarget.style.color = "var(--accent-400)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = tab === "approvals" ? "var(--accent-400)" : "#7A7A90"; }}
          >
            <Bell size={13} strokeWidth={2} />
            {apCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[15px] text-center">
                {apCount > 9 ? "9+" : apCount}
              </span>
            )}
          </button>
        )}

        {/* Dark mode toggle — flips the base only; Mono (if on) is preserved
            since it's now orthogonal to light/dark. */}
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
    </>
  );

  return (
    <div className="flex h-screen" style={{ background: "var(--t-bg)" }}>
      {/* Sidebar */}
      <aside className={`${navCollapsed ? "w-[56px]" : "w-[216px]"} flex flex-col flex-shrink-0 relative transition-[width] motion-reduce:transition-none`} style={{
        background: "linear-gradient(180deg, #161618 0%, #0C0C0D 100%)",
        borderRight: "1px solid rgba(255,255,255,0.05)",
      }}>
        {/* Brand */}
        <div className={`h-[54px] ${navCollapsed ? "justify-center px-0" : "px-4"} flex items-center gap-2.5 flex-shrink-0`} style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}>
          <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-6 w-6 flex-shrink-0" />
          {!navCollapsed && (
            <>
              <h1 className="text-[15px] font-bold text-white tracking-tight flex-1 truncate">{orgName || "Ecliptr"}</h1>
              {shellButtons}
            </>
          )}

        </div>

        {/* Nav */}
        <nav ref={navRef} className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto relative">
          {/* Sliding indicator */}
          <div
            className="nav-indicator"
            style={{ top: indicatorStyle.top, opacity: indicatorStyle.opacity }}
          />

          {navCollapsed ? NAV.flatMap((node) => [
            ...(visible(node.id) ? [node as NavKid] : []),
            ...(node.children || []).filter((c) => visible(c.id)),
          ]).map((item) => navButton(item, false)) : NAV.map((node) => {
            const kids = (node.children || []).filter((c) => visible(c.id));
            // Parent gated out: don't strand independently-visible children (e.g.
            // null-perm Automation/Globe under Analytics) — promote them to top level.
            if (!visible(node.id)) {
              return kids.length
                ? <div key={node.id} className="space-y-0.5">{kids.map((c) => navButton(c, false))}</div>
                : null;
            }
            if (kids.length === 0) return navButton(node, false);
            const open = isGroupOpen(node);
            return (
              <div key={node.id} className="space-y-0.5">
                <div className="relative">
                  {navButton(node, false)}
                  {/* Sibling (not nested) chevron so it stays valid, focusable HTML. */}
                  <button
                    type="button"
                    aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
                    onClick={() => toggleGroup(node.id)}
                    className="absolute top-0 right-1 h-9 w-7 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
                  >
                    <ChevronRight size={13} style={{ color: "#6B6B7A", transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms ease" }} />
                  </button>
                </div>
                {open && kids.map((c) => navButton(c, true))}
              </div>
            );
          })}

          {/* Utility zone — configuration & housekeeping, set apart from the workflow mains */}
          <div className="mt-2 pt-2 space-y-0.5" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            {UTILITY.filter((u) => visible(u.id)).map((u) => navButton(u, false))}
            <button
              onClick={toggleNav}
              title={`${navCollapsed ? "Expand" : "Collapse"} sidebar (Cmd/Ctrl + B)`}
              aria-label={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={`relative w-full flex items-center gap-2.5 ${navCollapsed ? "justify-center px-0" : "px-2.5"} h-9 rounded-lg text-[13px] tracking-tight text-[#6B6B7A] hover:text-white/80 transition-all duration-150`}
            >
              {navCollapsed ? <PanelLeftOpen size={15} strokeWidth={1.6} /> : <PanelLeftClose size={15} strokeWidth={1.6} />}
              {!navCollapsed && "Collapse sidebar"}
            </button>
          </div>
        </nav>

        {/* Status footer */}
        <div className={`${navCollapsed ? "px-1.5" : "px-3"} py-3 space-y-1 flex-shrink-0`} style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
          {navCollapsed && (
            <div className="flex flex-col items-center gap-1 pb-1">{shellButtons}</div>
          )}
          <div className={`flex items-center ${navCollapsed ? "justify-center" : "justify-between"} px-1.5 py-0.5`}
               title={navCollapsed ? `Ollama ${aiOnline ? "online" : "offline"}` : undefined}>
            <span className="flex items-center gap-2 text-[11px]" style={{ color: "#4A4A5A" }}>
              {aiOnline ? (
                <span className="pulse-ring flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-success relative z-10 flex-shrink-0 block" />
                </span>
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-danger flex-shrink-0" />
              )}
              {!navCollapsed && "Ollama"}
            </span>
            {!navCollapsed && (
              <span className={`text-[11px] font-medium ${aiOnline ? "text-success-ink" : "text-danger-ink"}`}>
                {aiOnline ? "online" : "offline"}
              </span>
            )}
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            title={navCollapsed ? `Sync · ${lastSync ? new Date(lastSync).toLocaleTimeString() : "never"}` : undefined}
            className={`w-full flex items-center ${navCollapsed ? "justify-center" : "justify-between"} px-1.5 py-1.5 rounded-md text-[11px] transition-colors disabled:opacity-50`}
            style={{ color: "#4A4A5A" }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
            onMouseLeave={e => (e.currentTarget.style.background = "")}
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
              {!navCollapsed && "Sync"}
            </span>
            {!navCollapsed && (
              <span className="tabular-nums">
                {lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
              </span>
            )}
          </button>

          {/* Signed-in user + sign out */}
          <div className={`flex ${navCollapsed ? "flex-col" : ""} items-center gap-2 px-1.5 pt-2 mt-1`} style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
            {me?.avatar
              ? <img src={me.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
              : <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>
                  {(me?.display_name || "?").trim().charAt(0).toUpperCase()}
                </div>}
            {!navCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium truncate" style={{ color: "#C7C7D1" }}>{me?.display_name}</div>
                <div className="text-[10px] truncate" style={{ color: "#4A4A5A" }}>{me?.role_name}</div>
              </div>
            )}
            <button
              onClick={() => setFbOpen(true)}
              title="Send feedback"
              className="p-1.5 rounded-md transition-colors flex-shrink-0"
              style={{ color: "#7A7A90" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--accent-400)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#7A7A90"; }}
            >
              <MessageSquarePlus size={13} />
            </button>
            <button
              onClick={signOut}
              title="Sign out"
              className="p-1.5 rounded-md transition-colors flex-shrink-0"
              style={{ color: "#7A7A90" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#F87171"; }}
              onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#7A7A90"; }}
            >
              <LogOut size={13} />
            </button>
          </div>
        </div>
      </aside>

      {fbOpen && <FeedbackModal me={me} onClose={() => setFbOpen(false)} />}

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
                  {flatTabs.filter((t) => t.id !== "globe").map((t) => (
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
          <div className={tab === "globe" ? "h-full overflow-hidden" : "h-full overflow-auto page-atmosphere"} style={{ background: paneBg(tab) }}>
            <div key={pageKey} className="page-enter h-full">
              {tab !== "globe" && <UpdateNotification />}
              {paneContent(tab)}
            </div>
          </div>
        )}
      </main>

      {showTour && <GettingStarted onDone={() => setShowTour(false)} />}
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
      <ToastHost />
    </div>
  );
}

