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
  Receipt,
  Boxes,
  Newspaper,
  Search,
  MoreHorizontal,
  Pin,
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
import LotEngineView from "./components/LotEngineView";
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
import ClientStatementView from "./components/ClientStatementView";
import FinancialsView from "./components/FinancialsView";
import { ApprovalsView } from "./components/ApprovalsView";
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

type Tab = "dashboard" | "clients" | "health" | "deals" | "dealflow" | "suppliers" | "inventory" | "lotengine" | "manifest" | "invoices" | "receivables" | "payables" | "quotes" | "releaseletter" | "clientreceipt" | "email" | "analytics" | "brief" | "automation" | "globe" | "notes" | "approvals" | "checkup" | "archive" | "sheetcopy" | "financials" | "platform" | "datasafety" | "settings";

/** Below this window width the sidebar collapses itself.
 *
 *  1280 is the principled number - it is where the `xl:` breakpoints across the
 *  screens fire, and they were authored as if they owned the whole window when in
 *  fact they live in a column of `viewport - 216 - 56` (that 56 is the pane's own
 *  p-7, not the rail). The 96px rail hands back 120px of that - it was 160px while
 *  the rail was 56px wide, and R-224 spent 40px of it on labels. 1240 rather than
 *  1280 because a 1280 window reports innerWidth ~1264 once Windows chrome is
 *  subtracted, and a fresh install must not launch collapsed.
 *
 *  The threshold itself is pinned by the default window width (tauri.conf.json) and
 *  by where `xl:` fires - the rail's own width is in neither, so widening the rail
 *  is not a reason to move it. Auto-collapse can be switched off per device in
 *  Settings -> Appearance; see NAV_AUTO_KEY. */
const NAV_COLLAPSE_AT = 1240;

/** Per-device: "0" disables the automatic collapse below NAV_COLLAPSE_AT entirely. */
const NAV_AUTO_KEY = "clienthub_nav_auto";

/** Collapsed rail: the pinned band, in NAV order. Editable per device; the rail
 *  never reorders it on its own, because at this width the row's position is the
 *  only thing about it that survives a glance. */
const RAIL_PINS_KEY = "clienthub_rail_pins";
const DEFAULT_PINS = ["dashboard", "clients", "suppliers", "inventory", "invoices", "financials"];

/** Collapsed rail row heights, in px, kept here because the fit calculation below
 *  has to agree with the markup exactly - a rail that miscounts either scrolls
 *  (which R-224 forbids) or hides rows it had room for.
 *
 *  The separator is a fixed-height box rather than a bare rule with margins: the
 *  nav's `space-y-0.5` writes margin-top on every sibling at a higher specificity
 *  than an arbitrary `my-[…]`, so margins there are silently overridden and the
 *  number here would be a guess. A height cannot be argued with. */
const RAIL_ROW = 46;   // h-[44px] + the 2px space-y gap
const RAIL_KID = 26;   // h-[24px] + the 2px space-y gap
const RAIL_SEP = 13;   // h-[11px] + the 2px space-y gap

/** Shared class for the account flyout's rows. */
const RAIL_MENU_ROW =
  "w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-[13px] tracking-tight " +
  "text-[#8A8A9A] hover:text-white hover:bg-white/[0.06] transition-colors";

export default function App() {
  const [tab, setTabState] = useState<Tab>(() =>
    (localStorage.getItem("clienthub_last_tab") as Tab) || "dashboard"
  );
  const [pageKey, setPageKey] = useState(0);
  // Collapsed rail: which menu (All screens, or the account menu) is showing its
  // flyout, and the viewport y it hangs off. The per-group flyouts this was built for
  // are gone in R-224 - the section you are in opens inline in the rail now - but both
  // survivors still need anchoring and clamping. Click to open rather than hover: a
  // hover menu on a narrow rail is hard to hit on a trackpad, and Jack asked for click.
  const [flyout, setFlyout] = useState<{ id: string; top: number } | null>(null);
  const setTab = (t: Tab) => {
    setTabState(t);
    setPageKey(k => k + 1);
    setFlyout(null);
    localStorage.setItem("clienthub_last_tab", t);
  };
  /** Anchor a flyout beside the button that opened it. */
  const openFlyout = (id: string, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSignOutArm(false);
    setFlyout((prev) => (prev?.id === id ? null : { id, top: Math.max(8, r.top) }));
  };
  // A flyout opened from the footer would hang off the bottom of the window. Clamp it
  // against its real height before paint - guessing from a row count was wrong by 20px
  // on the account menu, whose header row is taller than the rest.
  const flyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = flyRef.current;
    if (!flyout || !el) return;
    const max = window.innerHeight - el.offsetHeight - 8;
    if (flyout.top > max) setFlyout({ ...flyout, top: Math.max(8, max) });
  }, [flyout]);
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

  // Collapsed rail: which top-level screens hold a permanent row. Stored rather than
  // derived so a NAV reorder cannot silently change what someone pinned; an id that no
  // longer exists simply matches nothing when the rail is built.
  // An empty ARRAY is a real answer - "I unpinned everything" - and must not fall back
  // to the defaults, or unpinning the last row undoes itself on the next launch. Only
  // an absent or unparseable value means "never chosen".
  const [railPins, setRailPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RAIL_PINS_KEY) || "null");
      if (Array.isArray(saved)) return saved.filter((id) => typeof id === "string");
    } catch { /* fall through to the default */ }
    return DEFAULT_PINS;
  });
  const toggleRailPin = (id: string) => setRailPins((prev) => {
    const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
    localStorage.setItem(RAIL_PINS_KEY, JSON.stringify(next));
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
  // Auto-collapse is a preference now (R-224). With it off the window never decides,
  // so the rail only ever appears because you asked for it.
  const [navAuto, setNavAuto] = useState(() => localStorage.getItem(NAV_AUTO_KEY) !== "0");
  useEffect(() => {
    const handler = (e: Event) => setNavAuto((e as CustomEvent).detail as boolean);
    window.addEventListener("nav-auto-change", handler);
    return () => window.removeEventListener("nav-auto-change", handler);
  }, []);
  const navCollapsed = manualNav ?? (navAuto && narrow);
  useEffect(() => {
    const onResize = () => {
      const n = window.innerWidth < NAV_COLLAPSE_AT;
      if (n === narrowRef.current) return;
      narrowRef.current = n;
      setNarrow(n);
      // Crossing the threshold hands control back to the window - but only while the
      // window is allowed to decide. With auto off, a manual choice is the only input
      // and must survive a resize.
      if (localStorage.getItem(NAV_AUTO_KEY) === "0") return;
      setManualNav(null);
      localStorage.removeItem("clienthub_nav_collapsed");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Invert what is on SCREEN, not what the window thinks. Those were the same
  // expression until auto-collapse became a preference; with it off the sidebar can be
  // open on a narrow window, and falling back to narrowRef there made the first
  // Cmd/Ctrl+B a no-op that only wrote the value it already rendered.
  //
  // The preference is read from storage rather than from `navAuto` on purpose: the
  // Cmd/Ctrl+B handler is registered once with [] deps, so it holds the toggleNav from
  // the first render forever and a closed-over navAuto would be whatever it was at
  // mount. The resize handler below reads the key for the same reason.
  const toggleNav = () => setManualNav((prev) => {
    const auto = localStorage.getItem(NAV_AUTO_KEY) !== "0";
    const next = !(prev ?? (auto && narrowRef.current));
    localStorage.setItem("clienthub_nav_collapsed", next ? "1" : "0");
    return next;
  });
  // Canvases and charts that size themselves off a measured width (GlobeView, the
  // split panes) only listen for window resize, which a width transition never fires.
  useEffect(() => {
    setFlyout(null);
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
  // Sign out is two-step: the first click arms it, the second one goes. It sits in
  // the footer next to the collapse control, one stray click from a row you press all
  // day, and a mis-click drops every unsynced local edit behind a re-auth.
  const [signOutArm, setSignOutArm] = useState<boolean>(false);
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

  // Disarm on its own. An armed confirm left sitting in the footer is the very
  // mis-click the two-step exists to prevent.
  useEffect(() => {
    if (!signOutArm) return;
    const id = setTimeout(() => setSignOutArm(false), 6000);
    return () => clearTimeout(id);
  }, [signOutArm]);

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
  // How much room the nav actually has. The nav is flex-1 in a fixed-height column,
  // so this changes with the window and not with the rows - which is exactly what the
  // rail's fit calculation needs: the space available, independent of what is in it.
  //
  // The deps are load-bearing. This hook runs on the very first render, when the shell
  // is still behind the auth gate below and <nav> does not exist yet; with an empty
  // array it would take that one look, find nothing, and never measure again - leaving
  // navH at 0 forever, which the fit calculation reads as "unlimited room" and renders
  // a rail that silently overflows. Re-run when the gate opens.
  const [navH, setNavH] = useState(0);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const read = () => setNavH(nav.clientHeight);
    read();
    // Both listeners, and neither is redundant. The observer catches the chrome around
    // the nav changing height (the footer, the utility band). The window listener
    // catches the window itself - which is the signal the rest of this file already
    // trusts for exactly this: the sliding indicator below and the collapse threshold
    // above both hang off `resize`.
    const ro = new ResizeObserver(read);
    ro.observe(nav);
    window.addEventListener("resize", read);
    return () => { window.removeEventListener("resize", read); ro.disconnect(); };
  }, [me, onboarded, navCollapsed]);

  useLayoutEffect(() => {
    const measure = () => {
      // The rail renders a row for the active child too (R-224), so the parent
      // fallback is no longer the common case - it now only covers a tab reached
      // without a rail row at all: the split-view picker, the command palette, a
      // navigate-tab event, or a stored last-tab the current role cannot see.
      const btn = buttonRefs.current[tab] ?? (parentOfActive ? buttonRefs.current[parentOfActive] : null);
      const nav = navRef.current;
      // Utility rows live outside the <nav> but still register a ref, so a naive
      // measure puts the bar below the nav's own box - hide it instead of lying.
      if (!btn || !nav || !nav.contains(btn)) { setIndicatorStyle((s) => ({ ...s, opacity: 0 })); return; }
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
    // parentOfActive is derived from tab alone, so [tab] already re-runs this; it is
    // declared further down the body and cannot go in the array without a TDZ throw.
    // The rest are here because a rail row can appear or disappear while `tab` does
    // not change - a count crossing zero, the fit calculation shedding a row, the
    // rail opening or closing - and the ResizeObserver above cannot see it: the nav
    // is flex-1, so its own box never moves when its contents do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, navCollapsed, navH, apCount, draftCount, railPins]);

  useEffect(() => {
    checkAi();
    const id = setInterval(checkAi, 30000);
    return () => clearInterval(id);
  }, [checkAi]);

  useEffect(() => {
    api.syncStatus().then((s) => setLastSync(s.last_applied)).catch(() => {});
  }, []);

  // Pending newsletter drafts. This used to be fetched once at mount with no refresh
  // at all, which was survivable while it only tinted a badge on a row that was always
  // there. The collapsed rail now decides whether Newsletter gets a row from this
  // number, so a value frozen at mount would mean a row that never appears and never
  // leaves. Same cadence and the same sync trigger as the approvals count above -
  // netsync-applied is a Tauri event, so it needs listen() and NOT addEventListener;
  // a window listener for it compiles, runs, and is never called.
  useEffect(() => {
    if (!me) { setDraftCount(0); return; }
    const read = () => api.listDrafts("pending").then((d) => setDraftCount(d.length)).catch(() => {});
    read();
    let unlisten: (() => void) | undefined;
    listen("netsync-applied", () => read()).then((u) => { unlisten = u; }).catch(() => {});
    const id = setInterval(read, 60000);
    return () => { clearInterval(id); unlisten?.(); };
  }, [me]);

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
      if (e.key === "Escape") { setQuickLogOpen(false); setPaletteOpen(false); setShortcutsOpen(false); setFlyout(null); }
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
      { id: "lotengine", label: "Lot engine", icon: Boxes },
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
      { id: "clientreceipt", label: "Client receipt", icon: Receipt },
    ] },
    { id: "financials", label: "Financials", icon: Landmark },
    { id: "email", label: "Newsletter", icon: Mail },
    { id: "brief", label: "Brief", icon: Newspaper },
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
    : id === "lotengine" ? canViewTab(me, "inventory" as any) // so does the lot engine
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
        } ${navCollapsed ? "h-8" : "h-9"} rounded-lg text-[13px] tracking-tight transition-all duration-150 ${
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

  // ── The collapsed rail (R-224) ────────────────────────────────────────────────
  // It stopped being a narrower copy of the sidebar. Open, the sidebar's job is to
  // show the whole map; closed, its job is to keep you oriented and let you move
  // fast inside the section you are already in. So: every row carries its name, the
  // current section opens INLINE rather than in a flyout, and nothing scrolls.

  /** The count a row should display, or 0. A parent surfaces its badged child's
   *  count only while that child is not itself on screen underneath it - otherwise
   *  the same number would appear twice, one row above the other. */
  const railCount = (n: NavNode, expanded: boolean): number => {
    if (n.id === "email") return visible("email") ? draftCount : 0;
    if (n.id === "approvals") return visible("approvals") ? apCount : 0;
    if (!expanded && n.children?.some((c) => c.id === "approvals") && visible("approvals")) return apCount;
    return 0;
  };

  /** The count pill, top-right of a rail row. A numeral, never a dot in front of a
   *  label. Both counts clamp at 9+ - the expanded sidebar leaves draftCount
   *  uncapped, but a three-digit pill does not fit a 96px row. */
  const railBadge = (id: string, n: number) =>
    n > 0 ? (
      <span
        className={`absolute top-1 right-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold leading-[15px] text-center ${
          id === "email" ? "" : "bg-red-500 text-white"
        }`}
        style={id === "email"
          ? { background: "rgba(251,191,36,0.15)", color: "#FCD34D", border: "1px solid rgba(251,191,36,0.25)" }
          : undefined}
      >
        {n > 9 ? "9+" : n}
      </span>
    ) : null;

  /** A top-level rail row: icon above its own name. At 96px the caption is what
   *  makes the row readable, so it is #8A8A9A rather than the sidebar's dimmer
   *  #6B6B7A - 9.5px text needs the contrast. */
  const railRow = (item: NavKid, count: number) => {
    const Icon = item.icon;
    const active = tab === item.id;
    return (
      <button
        key={item.id}
        ref={(el) => { buttonRefs.current[item.id] = el; }}
        onClick={() => setTab(item.id)}
        title={item.label}
        className={`relative w-full flex flex-col items-center justify-center gap-[3px] h-[44px] px-1 rounded-lg transition-colors duration-150 ${
          active ? "text-white rail-active" : "text-[#8A8A9A] hover:text-white/85 hover:bg-white/[0.06]"
        }`}
      >
        <Icon size={16} strokeWidth={active ? 2.1 : 1.6} style={active ? { color: "var(--accent-400)" } : undefined} />
        <span className="max-w-full truncate text-[9.5px] font-semibold leading-none tracking-tight">{item.label}</span>
        {railBadge(item.id, count)}
      </button>
    );
  };

  /** A screen inside the open section. Text only - at 96px an icon would cost the
   *  label the room it needs, and the spine beside it already says these belong to
   *  the row above. */
  const railKid = (item: NavKid, count: number) => {
    const active = tab === item.id;
    return (
      <button
        key={item.id}
        ref={(el) => { buttonRefs.current[item.id] = el; }}
        onClick={() => setTab(item.id)}
        title={item.label}
        className={`relative w-full flex items-center h-[24px] pl-[7px] pr-1.5 rounded-md text-[10px] font-medium tracking-tight transition-colors duration-150 ${
          active ? "text-white rail-active" : "text-[#8A8A9A] hover:text-white/85 hover:bg-white/[0.06]"
        }`}
      >
        <span className="truncate">{item.label}</span>
        {count > 0 && (
          <span className="ml-auto pl-1 text-[9px] font-bold tabular-nums" style={{ color: item.id === "email" ? "#FCD34D" : "#F87171" }}>
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>
    );
  };

  /** A rail row that is not a destination - Search and All screens. */
  const railAction = (key: string, label: string, Icon: any, onClick: (e: React.MouseEvent) => void, open?: boolean) => (
    <button
      key={key}
      onClick={onClick}
      title={label}
      aria-expanded={open}
      className={`relative w-full flex flex-col items-center justify-center gap-[3px] h-[44px] px-1 rounded-lg transition-colors duration-150 ${
        open ? "text-white rail-active" : "text-[#8A8A9A] hover:text-white/85 hover:bg-white/[0.06]"
      }`}
    >
      <Icon size={16} strokeWidth={1.6} />
      <span className="max-w-full truncate text-[9.5px] font-semibold leading-none tracking-tight">{label}</span>
    </button>
  );

  /** Which top-level rows the rail shows, and how tall they come out.
   *
   *  Three reasons earn a row: it is the section you are standing in, it is pinned, or
   *  it is carrying work that is waiting. That is also the order they survive in when
   *  the window is too short to hold them all - the rail may not scroll, so something
   *  has to go, and it goes to All screens rather than below the fold. A pin outranks a
   *  count because a pin is a choice you made and a count is the app being helpful; on
   *  a 600px window that means the newsletter's draft count can be trimmed away while
   *  Dashboard stays, which is the right way round.
   *
   *  Whatever survives is drawn in NAV order regardless, so a row arriving or leaving
   *  never reshuffles the ones around it. */
  const railPlan = (() => {
    // Membership alone is not enough - parentOfActive carries no gating, so a role
    // that cannot see Analytics would otherwise get an Analytics row from standing
    // on Globe, and clicking it lands on a screen paneContent renders regardless.
    const sectionId: string | null =
      parentOfActive && visible(parentOfActive as Tab) ? parentOfActive
      : NAV.some((n) => n.id === tab) && visible(tab) ? tab
      : null;

    type Row = { node: NavNode; kids: NavKid[]; rank: number; at: number; h: number };
    const rows: Row[] = [];
    NAV.forEach((node, at) => {
      // A pin the role cannot see renders nothing. The expanded sidebar promotes such
      // a parent's children to top level, but the rail must not: its rows are a chosen
      // subset, and promoting into it produced the same screen twice whenever the
      // promoted child was also the one you were standing on. Those children are still
      // in All screens, and the orphan row below still says where you are.
      if (!visible(node.id)) return;
      const isSection = node.id === sectionId;
      const pinned = railPins.includes(node.id);
      const counted = railCount(node, isSection) > 0;
      if (!isSection && !pinned && !counted) return;
      const kids = isSection ? (node.children || []).filter((c) => visible(c.id)) : [];
      rows.push({
        node, kids, at,
        rank: isSection ? 0 : pinned ? 1 : 2,
        h: RAIL_ROW + (kids.length ? kids.length * RAIL_KID + 8 : 0),
      });
    });

    // The section you are on is a child whose parent your role cannot see. Give it a
    // row of its own rather than leaving the rail unable to say where you are.
    const orphan: NavKid | null =
      !sectionId && parentOfActive && !visible(parentOfActive as Tab) && visible(tab)
        ? (NAV.find((n) => n.id === parentOfActive)?.children || []).find((c) => c.id === tab) ?? null
        : null;

    // Search + All screens + their two rules, plus the nav's own py-2.
    const chrome = RAIL_ROW * 2 + RAIL_SEP * 2 + 16 + (orphan ? RAIL_ROW : 0);
    // navH is 0 only before the nav has been measured at all. Show everything then;
    // the layout effect corrects it on the next frame.
    let budget = navH > 0 ? navH - chrome : Number.POSITIVE_INFINITY;

    const keep = new Set<string>();
    let full = false;
    for (const r of [...rows].sort((a, b) => a.rank - b.rank || a.at - b.at)) {
      // The section always gets its row - a rail that cannot say where you are is the
      // fault this whole redesign exists to fix, so it is never the thing that goes.
      if (r.rank === 0) { budget -= r.h; keep.add(r.node.id); continue; }
      // Once one row does not fit, everything below it in priority goes too. Skipping
      // only the ones that happen to be too tall would let a lower-priority row jump
      // over a higher one as the window resizes, which is the reshuffling this design
      // forbids.
      if (full || budget - r.h < 0) { full = true; continue; }
      budget -= r.h;
      keep.add(r.node.id);
    }
    return { rows: rows.filter((r) => keep.has(r.node.id)), orphan, sectionId };
  })();

  // One labelled row inside a flyout.
  const flyoutRow = (item: NavKid, badge?: number) => {
    const Icon = item.icon;
    const active = tab === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setTab(item.id)}
        className={`w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-[13px] tracking-tight transition-colors ${
          active ? "text-white font-medium" : "text-[#8A8A9A] hover:text-white hover:bg-white/[0.06]"
        }`}
        style={active ? { background: "linear-gradient(90deg, var(--accent-tint) 0%, transparent 100%)" } : undefined}
      >
        <Icon size={14} strokeWidth={active ? 2.1 : 1.6} style={active ? { color: "var(--accent-400)" } : undefined} />
        <span className="truncate">{item.label}</span>
        {badge ? (
          // Newsletter drafts are amber everywhere else in the shell and approvals are
          // red; this row had only ever carried approvals, so a bare red pill was right
          // until All screens started passing draftCount through it.
          <span
            className={`ml-auto min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold leading-4 text-center ${
              item.id === "email" ? "" : "bg-red-500 text-white"
            }`}
            style={item.id === "email"
              ? { background: "rgba(251,191,36,0.15)", color: "#FCD34D", border: "1px solid rgba(251,191,36,0.25)" }
              : undefined}
          >
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
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
            {t === "clientreceipt" && <ClientStatementView />}
            {t === "dealflow"   && <DealFlowView />}
            {t === "suppliers"  && <SuppliersView />}
            {t === "inventory"  && <InventoryView />}
            {t === "manifest"   && <ManifestView onNavigate={setTab} />}
            {t === "lotengine"  && <LotEngineView />}
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

  // Bell, dark mode and split view. They have their own strip under the brand row when
  // the sidebar is open and move into the account menu when it is collapsed - split view
  // has no other entry point anywhere in the app, so dropping them from the rail would
  // strand it. They used to be crammed into the brand row itself alongside the collapse
  // control: four icons wedged against the wordmark, which is why the row now carries
  // the brand alone.
  const shellButtons = (
    <>
        {/* Approvals notification bell (admins only) */}
        {me?.is_admin && (
          <button
            onClick={() => setTab("approvals")}
            title={apCount > 0 ? `${apCount} waiting for review` : "Notifications"}
            className="relative w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
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
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
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
          className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 transition-all duration-150"
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
      <aside className={`${navCollapsed ? "w-[96px]" : "w-[216px]"} flex flex-col flex-shrink-0 relative transition-[width] motion-reduce:transition-none`} style={{
        background: "linear-gradient(180deg, #161618 0%, #0C0C0D 100%)",
        borderRight: "1px solid rgba(255,255,255,0.05)",
      }}>
        {/* Brand. Expanded, this row is the wordmark and nothing else - the bell, theme,
            split-view and collapse icons all used to sit on it, which read as clutter
            hung off the logo. Collapsed, the whole row IS the expand control: the rail
            has no other way back out, and burying it in the nav once put it several
            hundred pixels below the fold on a short window. */}
        <div className={`h-[54px] ${navCollapsed ? "px-0" : "px-4"} flex items-center gap-2.5 flex-shrink-0`} style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}>
          {navCollapsed ? (
            <button
              onClick={toggleNav}
              title="Expand sidebar (Cmd/Ctrl + B)"
              aria-label="Expand sidebar"
              className="w-full h-full flex items-center justify-center gap-1 transition-colors"
              style={{ color: "#7A7A90" }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "var(--accent-400)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#7A7A90"; }}
            >
              <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-5 w-5 flex-shrink-0" />
              <PanelLeftOpen size={13} strokeWidth={1.8} />
            </button>
          ) : (
            <>
              <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-6 w-6 flex-shrink-0" />
              <h1 className="text-[15px] font-bold text-white tracking-tight flex-1 truncate">{orgName || "Ecliptr"}</h1>
            </>
          )}
        </div>

        {/* Shell strip. The three app-wide toggles, on their own line under the brand
            rather than on the main content header - they belong to the shell, not to
            whatever screen happens to be open. Expanded only; collapsed they are in the
            account flyout, since a 96px rail has no room for a toolbar. */}
        {!navCollapsed && (
          <div className="px-3 py-1.5 flex items-center gap-1 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.045)" }}>
            {shellButtons}
          </div>
        )}

        {/* Nav */}
        <nav
          ref={navRef}
          className={`flex-1 ${navCollapsed ? "px-1.5 py-2 overflow-hidden" : "px-2.5 py-3 overflow-y-auto"} space-y-0.5 relative`}
        >
          {/* Sliding indicator */}
          <div
            className="nav-indicator"
            style={{ top: indicatorStyle.top, opacity: indicatorStyle.opacity }}
          />

          {navCollapsed ? (
            <>
              {railAction("__search", "Search", Search, () => { setFlyout(null); setPaletteOpen(true); })}
              <div className="h-[11px] mx-1 flex items-center" aria-hidden><div className="w-full" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} /></div>

              {/* Standing on a screen whose parent this role cannot see. */}
              {railPlan.orphan && railRow(railPlan.orphan, railCount(railPlan.orphan, false))}

              {railPlan.rows.map(({ node, kids }) => (
                <div key={node.id} className="space-y-0.5">
                  {railRow(node, railCount(node, node.id === railPlan.sectionId))}
                  {kids.length > 0 && (
                    <div className="relative pl-[9px] mt-[3px] mb-[5px] space-y-0.5">
                      <span className="rail-spine absolute left-[3px] top-0.5 bottom-0.5 w-[1.5px] rounded-full" aria-hidden />
                      {kids.map((c) => railKid(c, railCount(c, false)))}
                    </div>
                  )}
                </div>
              ))}

              <div className="h-[11px] mx-1 flex items-center" aria-hidden><div className="w-full" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} /></div>
              {railAction("__all", "All screens", MoreHorizontal, (e) => openFlyout("__all", e), flyout?.id === "__all")}
            </>
          ) : NAV.map((node) => {
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

        </nav>

        {/* Utility zone — configuration & housekeeping, set apart from the workflow
            mains. Pinned outside the scroller: these are the ones you reach for when
            you are lost, and they were the first to fall below the fold.
            Collapsed it is Settings alone: five stacked labelled rows would be ~230px
            of chrome that cannot shrink, and on the 600px minimum window that is the
            difference between the rail fitting and the rail scrolling. The other four
            are one click away in All screens, which lists every screen this role can
            reach. */}
        <div className={`${navCollapsed ? "px-1.5" : "px-2.5"} py-2 space-y-0.5 flex-shrink-0`} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {navCollapsed
            ? UTILITY.filter((u) => u.id === "settings" && visible(u.id)).map((u) => railRow(u, 0))
            : UTILITY.filter((u) => visible(u.id)).map((u) => navButton(u, false))}
        </div>

        {/* Status footer. Collapsed this is a compact strip: an older rail stacked bell,
            dark mode, split view, feedback and sign out into a ~230px column that ate the
            nav's room. They live in the account menu instead, which matters more now the
            rail is forbidden to scroll - see railPlan's budget. */}
        <div className={`${navCollapsed ? "px-1.5" : "px-3"} py-3 flex-shrink-0`} style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
          {navCollapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <span className="py-0.5" title={`Ollama ${aiOnline ? "online" : "offline"}`}>
                {aiOnline ? (
                  <span className="pulse-ring flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-success relative z-10 flex-shrink-0 block" />
                  </span>
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-danger flex-shrink-0 block" />
                )}
              </span>
              <button
                onClick={handleSync}
                disabled={syncing}
                title={`Sync · ${lastSync ? new Date(lastSync).toLocaleTimeString() : "never"}`}
                className="w-7 h-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-50"
                style={{ color: "#7A7A90" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                onMouseLeave={e => (e.currentTarget.style.background = "")}
              >
                <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
              </button>
              <button
                onClick={(e) => openFlyout("__account", e)}
                title={me?.display_name || "Account"}
                aria-label="Account menu"
                aria-expanded={flyout?.id === "__account"}
                className="relative w-7 h-7 rounded-md flex items-center justify-center transition-colors"
              >
                {me?.avatar
                  ? <img src={me.avatar} alt="" className="w-6 h-6 rounded-md object-cover" />
                  : <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold text-white"
                      style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>
                      {(me?.display_name || "?").trim().charAt(0).toUpperCase()}
                    </div>}
                {me?.is_admin && apCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" style={{ border: "1px solid #101011" }} />
                )}
              </button>
            </div>
          ) : (
            <div className="space-y-1">
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

              {/* Signed-in user, then the two session controls: collapse the rail and sign
                  out. Feedback used to hold the left slot; it has a Settings section of
                  its own now, which is where a form with three fields belonged all along. */}
              <div className="flex items-center gap-2 px-1.5 pt-2 mt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
                {me?.avatar
                  ? <img src={me.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
                  : <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                      style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>
                      {(me?.display_name || "?").trim().charAt(0).toUpperCase()}
                    </div>}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium truncate" style={{ color: "#C7C7D1" }}>{me?.display_name}</div>
                  <div className="text-[10px] truncate" style={{ color: "#4A4A5A" }}>{me?.role_name}</div>
                </div>
                <button
                  onClick={toggleNav}
                  title="Collapse sidebar (Cmd/Ctrl + B)"
                  aria-label="Collapse sidebar"
                  className="p-1.5 rounded-md transition-colors flex-shrink-0"
                  style={{ color: "#7A7A90" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "var(--accent-400)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#7A7A90"; }}
                >
                  <PanelLeftClose size={13} strokeWidth={2} />
                </button>
                <button
                  onClick={() => setSignOutArm((v) => !v)}
                  title="Sign out"
                  aria-expanded={signOutArm}
                  className="p-1.5 rounded-md transition-colors flex-shrink-0"
                  style={{ color: signOutArm ? "#F87171" : "#7A7A90", background: signOutArm ? "rgba(248,113,113,0.14)" : "" }}
                  onMouseEnter={e => { if (!signOutArm) { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#F87171"; } }}
                  onMouseLeave={e => { if (!signOutArm) { e.currentTarget.style.background = ""; e.currentTarget.style.color = "#7A7A90"; } }}
                >
                  <LogOut size={13} />
                </button>
              </div>

              {/* Step two. Signing out is not destructive, but it is a re-auth away from
                  everything, and the button now lives one icon from the collapse control
                  you press all day - so it asks. */}
              {signOutArm && (
                <div className="px-1.5 pt-2 mt-1 space-y-1.5" style={{ borderTop: "1px solid rgba(255,255,255,0.045)" }}>
                  <div className="text-[11px]" style={{ color: "#C7C7D1" }}>Sign out of {orgName || "Ecliptr"}?</div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={signOut}
                      className="flex-1 h-7 rounded-md text-[11px] font-medium transition-colors"
                      style={{ background: "rgba(248,113,113,0.16)", color: "#F87171" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(248,113,113,0.26)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "rgba(248,113,113,0.16)")}
                    >
                      Sign out
                    </button>
                    <button
                      onClick={() => setSignOutArm(false)}
                      className="flex-1 h-7 rounded-md text-[11px] transition-colors"
                      style={{ background: "rgba(255,255,255,0.06)", color: "#C7C7D1" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.11)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Rail flyouts. Two of them now: the account menu behind the footer avatar,
            and All screens. The per-group flyouts are gone — the section you are in
            opens inline in the rail instead, which is the whole point of R-224.
            Fixed rather than absolute so the rail cannot clip them, over a backdrop
            that closes on any outside click. `left` is the rail width plus a 6px gap;
            there is no shared constant for it, so it moves when the rail moves. */}
        {navCollapsed && flyout && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setFlyout(null)} />
            <div
              ref={flyRef}
              className="fixed z-50 w-[186px] p-1 rounded-xl"
              style={{
                left: 102, top: flyout.top,
                background: "#17171A",
                border: "1px solid rgba(255,255,255,0.09)",
                boxShadow: "0 14px 36px rgba(0,0,0,0.55)",
              }}
            >
              {flyout.id === "__account" ? (
                <>
                  <div className="px-2.5 pt-1.5 pb-2 mb-1" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <div className="text-[12px] font-medium truncate" style={{ color: "#C7C7D1" }}>{me?.display_name}</div>
                    <div className="text-[10px] truncate" style={{ color: "#4A4A5A" }}>{me?.role_name}</div>
                  </div>
                  {me?.is_admin && (
                    <button onClick={() => setTab("approvals")} className={RAIL_MENU_ROW}>
                      <Bell size={14} strokeWidth={1.7} />
                      <span>Notifications</span>
                      {apCount > 0 && (
                        <span className="ml-auto min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-4 text-center">
                          {apCount > 9 ? "9+" : apCount}
                        </span>
                      )}
                    </button>
                  )}
                  <button onClick={() => { setDark(d => !d); setFlyout(null); }} className={RAIL_MENU_ROW}>
                    {dark ? <Sun size={14} strokeWidth={1.7} /> : <Moon size={14} strokeWidth={1.7} />}
                    <span>{dark ? "Light mode" : "Dark mode"}</span>
                  </button>
                  <button onClick={() => { toggleSplit(); setFlyout(null); }} className={RAIL_MENU_ROW}>
                    <Columns2 size={14} strokeWidth={1.7} />
                    <span>{splitTab ? "Close split view" : "Split view"}</span>
                  </button>
                  {/* Two-step here too, in the one row the menu has room for: the first
                      click relabels it, the second signs out. */}
                  <button
                    onClick={() => { if (signOutArm) { setFlyout(null); signOut(); } else setSignOutArm(true); }}
                    className={RAIL_MENU_ROW}
                    style={signOutArm ? { color: "#F87171" } : undefined}
                  >
                    <LogOut size={14} strokeWidth={1.7} />
                    <span>{signOutArm ? "Confirm sign out" : "Sign out"}</span>
                  </button>
                </>
              ) : flyout.id === "__all" ? (
                // Everything this role can reach, including the screens the rail is
                // not currently showing. flatTabs is the only list already filtered by
                // visible(), so it is the one that cannot leak a screen the sidebar
                // hides. It scrolls: 29 rows do not fit any window.
                <div className="max-h-[60vh] overflow-y-auto">
                  {flatTabs.map((t) => (
                    <div key={t.id} className="relative group/allrow">
                      {flyoutRow(t, t.id === "approvals" ? apCount : t.id === "email" ? draftCount : undefined)}
                      {NAV.some((n) => n.id === t.id) && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleRailPin(t.id); }}
                          title={railPins.includes(t.id) ? `Unpin ${t.label} from the rail` : `Pin ${t.label} to the rail`}
                          aria-label={railPins.includes(t.id) ? `Unpin ${t.label}` : `Pin ${t.label}`}
                          className={`absolute top-1 right-1 h-6 w-6 flex items-center justify-center rounded-md transition-colors ${
                            railPins.includes(t.id)
                              ? "text-[#C7C7D1] hover:bg-white/[0.1]"
                              : "opacity-0 group-hover/allrow:opacity-100 text-[#5A5A6A] hover:text-white hover:bg-white/[0.1]"
                          }`}
                        >
                          <Pin size={12} strokeWidth={1.9} style={railPins.includes(t.id) ? { fill: "currentColor" } : undefined} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        )}

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

