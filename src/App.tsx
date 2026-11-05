import { useEffect, useLayoutEffect, useMemo, useState, useRef, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Users, House, FileText, Repeat, Package, ClipboardList, Truck, DollarSign, ChartColumn, Ellipsis, SlidersHorizontal,
  RefreshCw, LogOut,
  PanelLeftClose, PanelLeftOpen,
  Sun, Moon,
  Columns2, X, Wifi, WifiOff, Bell, Search, Pin,
  type LucideIcon,
} from "lucide-react";
import ClientsView from "./components/ClientsView";
import InvoicesView from "./components/InvoicesView";
import QuotesView from "./components/QuotesView";
import EmailView from "./components/EmailView";
import DealFlowView from "./components/DealFlowView";
import SuppliersView from "./components/SuppliersView";
import InventoryView from "./components/InventoryView";
import ManifestView from "./components/ManifestView";
import LotEngineView from "./components/LotEngineView";
import ShowPackingView from "./components/ShowPackingView";
import WarehouseView from "./components/WarehouseView";
import PurchasesView from "./components/PurchasesView";
import RenewalsView from "./components/RenewalsView";
import ColdCallsView from "./components/ColdCallsView";
import WhatsAppSharePanel from "./components/WhatsAppSharePanel";
import CloseoutView from "./components/CloseoutView";
import BriefView from "./components/BriefView";
import TiersView from "./components/TiersView";
import CustomerPortalsView from "./components/CustomerPortalsView";
import NotesView from "./components/NotesView";
import DocumentsView from "./components/DocumentsView";
import PlatformView from "./components/PlatformView";
import DataSafetyView from "./components/DataSafetyView";
import ArchiveView from "./components/ArchiveView";
import SheetCopyView from "./components/SheetCopyView";
import ReleaseLetterView from "./components/ReleaseLetterView";
import PurchaseOrderView from "./components/PurchaseOrderView";
import ClientStatementView from "./components/ClientStatementView";
import FinancialsView from "./components/FinancialsView";
import { ApprovalsView } from "./components/ApprovalsView";
import CheckupView from "./components/CheckupView";
import { PaneBoundary } from "./components/ErrorBoundary";
import QuickLogModal from "./components/QuickLogModal";
import UpdateNotification from "./components/UpdateNotification";
import { ToastHost, toast } from "./components/Toast";
import CommandPalette from "./components/CommandPalette";
import ShortcutsModal from "./components/ShortcutsModal";
import AutomationLogView from "./components/AutomationLogView";
import OnboardingWizard from "./components/OnboardingWizard";
import GettingStarted from "./components/GettingStarted";
import AuthView from "./components/AuthView";
import ReconnectSheet, { RECONNECT_EVENT } from "./components/ReconnectSheet";
import LogisticsView from "./components/LogisticsView";
import BolsView from "./components/BolsView";
import { api, Me } from "./lib/api";
import { billsApi } from "./lib/billsApi";
import { can, canViewTab, canViewLogistics, isAdmin, isLogisticsOnly, isLogisticsOnlyTab } from "./lib/permissions";
import { forgetTime24, loadTime24 } from "./lib/time24";
import { bellCountOf, bellTitle, bellUrgentOf, canSeeTeamNotices } from "./lib/notices";
import { confirmLeaveUnsaved } from "./lib/unsavedWork";
import { tabSwitchAction, tabToShow } from "./lib/tabSwitch";
import { useNotices } from "./lib/useNotices";
import {
  SECTIONS, ALL_TABS, landingTab, sectionOfTab, shellDrawsHeader, visibleTabs,
  type SectionDef, type SectionId, type TabDef, type TabId,
} from "./lib/sections";
import Tabs, { type TabItem } from "./components/ui/Tabs";
import { PageSlotContext } from "./components/ui/PageHeader";

// Screens heavy enough that parsing them at launch is felt by every session that
// never opens them. Globe is the expensive one — it is the only importer of
// globe.gl, which carries three.js with it, together the largest thing in the
// build. Analytics pulls the chart families the dashboard does not use, and
// Settings is the largest screen by code. Dashboard is the first screen every
// session opens but only needs recharts for its trend line, so it is lazy too.
// Each becomes its own chunk, read from local disk the first time its tab is opened.
const GlobeView     = lazy(() => import("./components/GlobeView"));
const AnalyticsView = lazy(() => import("./components/AnalyticsView"));
const SettingsView  = lazy(() => import("./components/SettingsView"));
const DashboardView = lazy(() => import("./components/DashboardView"));
// R-449: Bills draws its Spending and True profit charts with recharts, so it stays out of the entry chunk.
const BillsView     = lazy(() => import("./components/BillsView"));

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

type Tab = TabId;

/** Ids a persisted string can still carry from before the R-231 rename
 *  ("deals"→"completed", "health"→"tiers", "email"→"newsletter"). Consulted only
 *  where a raw id comes back off disk, so an installed device keeps its last tab
 *  and rail pins instead of silently falling back to Dashboard or losing a pin. */
const LEGACY_TAB_IDS: Record<string, Tab> = { deals: "completed", health: "tiers", email: "newsletter" };

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

/** Collapsed rail: the pinned band, in section order. Editable per device; the rail
 *  never reorders it on its own, because at this width the row's position is the
 *  only thing about it that survives a glance. */
// R-583: pins are section ids now (the rail has a row per section), so they live under a new key; an old
// list of screen ids would match nothing. Everyone starts with every section pinned except More.
const RAIL_PINS_KEY = "clienthub_rail_pins_r583";
const RAIL_PINS_R605_KEY = "clienthub_rail_pins_r605";
const DEFAULT_PINS: string[] = ["home", "invoices", "deals", "clients", "inventory", "logistics", "money", "insights"];

/** The screen last used in each section, so a click on the section returns to it. */
const SECTION_LAST_KEY = "clienthub_section_last";

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
  "w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-[13px] font-medium " +
  "text-muted hover:text-ink hover:bg-surface-3 transition-colors";

/** The icon of each sidebar section. Plain lucide, 16px, never inside a tile. */
const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  home: House,
  invoices: FileText,
  deals: Repeat,
  clients: Users,
  inventory: Package,
  purchases: ClipboardList,
  logistics: Truck,
  money: DollarSign,
  insights: ChartColumn,
  more: Ellipsis,
  settings: SlidersHorizontal,
};

/** Collapsed rail: the open section lists at most this many of its screens (always including the one on
 *  screen). The rail may not scroll, and Deals alone has ten. The rest are in the tab bar and All screens. */
const RAIL_KIDS_MAX = 6;

/** A window of at most `max` screens that always contains `activeId`, centred on it where it can be. */
function kidWindow(list: TabDef[], activeId: string, max: number): TabDef[] {
  if (list.length <= max) return list;
  const at = Math.max(0, list.findIndex((t) => t.id === activeId));
  const start = Math.min(Math.max(0, at - Math.floor(max / 2)), list.length - max);
  return list.slice(start, start + max);
}

/** The shell's frame around a screen (R-583). Every screen sits in the main panel's 32px padding. When its
 *  section groups several screens the frame also draws the header: the section's name, a slot on the right
 *  that the screen fills through <PageActions>, and the section's screens as tabs. Globe is the one screen
 *  that bleeds to the panel's edges (it still gets the header). It is a component of its own, outside App,
 *  so its slot element and the tab bar's gliding thumb survive a tab change instead of remounting. */
function SectionFrame({ title, items, value, onSelect, shell, bleed, children }: {
  title: string;
  items: TabItem[];
  value: string;
  onSelect: (id: string) => void;
  shell: boolean;
  bleed: boolean;
  children: React.ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const ctx = useMemo(() => ({ shell, el: slot }), [shell, slot]);
  const header = shell ? (
    <header className={bleed ? "" : "mb-6"}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="m-0 text-[20px] font-medium leading-7 text-ink">{title}</h1>
        <div ref={setSlot} className="flex flex-wrap items-center justify-end gap-2" />
      </div>
      {items.length > 1 && <Tabs tabs={items} value={value} onChange={onSelect} label={title} />}
    </header>
  ) : null;
  return (
    <PageSlotContext.Provider value={ctx}>
      {bleed ? (
        <div className="h-full flex flex-col">
          {header && <div className="px-8 pt-8 pb-4 flex-shrink-0">{header}</div>}
          <div className="flex-1 min-h-0 relative">{children}</div>
        </div>
      ) : (
        <div className="px-8 pt-8 pb-10">
          <div className="max-w-[1600px] mx-auto">
            {header}
            {children}
          </div>
        </div>
      )}
    </PageSlotContext.Provider>
  );
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(() => {
    const stored = localStorage.getItem("clienthub_last_tab");
    return stored ? (LEGACY_TAB_IDS[stored] || (stored as Tab)) : "dashboard";
  });
  const [pageKey, setPageKey] = useState(0);
  // Collapsed rail: which menu (All screens, or the account menu) is showing its
  // flyout, and the viewport y it hangs off. The per-group flyouts this was built for
  // are gone in R-224 - the section you are in opens inline in the rail now - but both
  // survivors still need anchoring and clamping. Click to open rather than hover: a
  // hover menu on a narrow rail is hard to hit on a trackpad, and Jack asked for click.
  const [flyout, setFlyout] = useState<{ id: string; top: number } | null>(null);
  // The screen on show, for setTab. The navigate-tab and shortcut listeners are mounted once ([] deps) and keep the
  // first render's setTab, so it cannot read `tab` from its own closure; this ref is kept current instead.
  const tabRef = useRef<Tab>(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  const lastInSection = useRef<Record<string, string>>((() => {
    try { const v = JSON.parse(localStorage.getItem(SECTION_LAST_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  })());
  const setTab = (t: Tab, handoff = false) => {
    // DG-02: a click on the screen already open keeps it as it is (no remount, nothing asked); only a menu closes.
    // A handoff (a navigate-tab event, or the onNavigate prop of Dashboard, Quotes and Manifest, which stash a value
    // such as invoices_open_id and then jump) still remounts it: the destination reads that value when it mounts.
    // R-464: a full-page form with unsaved typing is asked about before the screen is switched away from it.
    const action = tabSwitchAction(tabRef.current, t, confirmLeaveUnsaved, handoff);
    if (action === "stay") { setFlyout(null); return; }
    if (action === "refused") return;
    tabRef.current = t;
    setTabState(t);
    setPageKey(k => k + 1);
    setFlyout(null);
    localStorage.setItem("clienthub_last_tab", t);
    const sec = sectionOfTab(t);
    if (sec) {
      lastInSection.current = { ...lastInSection.current, [sec.id]: t };
      try { localStorage.setItem(SECTION_LAST_KEY, JSON.stringify(lastInSection.current)); } catch { /* a blocked store only forgets which screen was last */ }
    }
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
  // Collapsed rail: which top-level screens hold a permanent row. Stored rather than
  // derived so a reorder of the sections cannot silently change what someone pinned; an id that no
  // longer exists simply matches nothing when the rail is built.
  // An empty ARRAY is a real answer - "I unpinned everything" - and must not fall back
  // to the defaults, or unpinning the last row undoes itself on the next launch. Only
  // an absent or unparseable value means "never chosen".
  const [railPins, setRailPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RAIL_PINS_KEY) || "null");
      if (Array.isArray(saved)) {
        const pins: string[] = saved.filter((id) => typeof id === "string").map((id) => LEGACY_TAB_IDS[id] || id);
        // R-605: Invoices became its own section; pin it once (above Deals) on a rail chosen before it existed.
        if (!localStorage.getItem(RAIL_PINS_R605_KEY)) {
          localStorage.setItem(RAIL_PINS_R605_KEY, "1");
          if (!pins.includes("invoices")) {
            const at = pins.indexOf("deals");
            pins.splice(at < 0 ? pins.length : at, 0, "invoices");
            localStorage.setItem(RAIL_PINS_KEY, JSON.stringify(pins));
          }
        }
        return pins;
      }
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
  const [splitTab, setSplitTabState] = useState<Tab | null>(() => {
    const stored = localStorage.getItem("clienthub_split_tab");
    return stored ? (LEGACY_TAB_IDS[stored] || (stored as Tab)) : null;
  });
  const setSplit = (t: Tab | null) => {
    setSplitTabState(t);
    if (t) localStorage.setItem("clienthub_split_tab", t);
    else localStorage.removeItem("clienthub_split_tab");
  };
  const toggleSplit = () => setSplit(splitTab ? null : (tab === "inventory" ? "newsletter" : "inventory"));

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
  // R-589: the Mono switch is gone. Black (the ink: black on light, white on dark) is an accent like any other and the
  // default. The `matte` class stays on for good, because the stylesheet keys Black off `html.matte:not([data-accent])`
  // and other screens still read it; every other colour, orange included, is an explicit data-accent.
  useEffect(() => { document.documentElement.classList.add("matte"); }, []);

  // Accent color
  const [accent, setAccent] = useState(() => {
    const saved = localStorage.getItem("clienthub_accent");
    // Once per device: before R-589 "orange" (or nothing) meant the ink with Mono on and orange with it off.
    if (localStorage.getItem("clienthub_accent_r589") !== "1") {
      localStorage.setItem("clienthub_accent_r589", "1");
      if (!saved || saved === "orange") {
        const was = localStorage.getItem("clienthub_matte") === "0" ? "orange" : "black";
        localStorage.setItem("clienthub_accent", was);
        return was;
      }
    }
    if (!saved || ["indigo", "red", "green", "slate"].includes(saved)) return "black"; // retired ids
    return saved;
  });
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    if (accent === "black") html.removeAttribute("data-accent");
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
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  // R-511 DG-14: the footer's light is the server, not the local AI model (that status lives on the AI
  // settings card). `auth` is what the netsync loop last saw: ok, offline (unreachable) or auth_lost.
  const [net, setNet] = useState<{ auth: "ok" | "auth_lost" | "offline"; pending_push: number; last_pull_at: string; auth_reason?: string; account_email?: string } | null>(null);
  // R-560: "Not now" on the sign-in-again sheet hides it until the next launch; Settings can bring it back.
  const [reconnectHidden, setReconnectHidden] = useState(false);
  const [syncFailed, setSyncFailed] = useState<string | null>(null);
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
  // Additive per-feature entitlements from /api/org (R-271/R-272's show_packing key
  // and whatever else lands later). Gates the Show packing tab; the server is the
  // authoritative check on every route.
  const [entitlements, setEntitlements] = useState<Record<string, boolean>>({});
  // DG-03: true once the plan, entitlement and superadmin answers above have arrived (or failed) for the person signed in.
  // Until then visible() hides the screens that ride them, so a remembered one is not judged yet.
  const [accessSettled, setAccessSettled] = useState(false);
  // me: undefined = loading, null = signed out, Me = signed in.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  // R-538: the person's own 24-hour choice for load times, read once they are signed in (kept on their account).
  // Signed out by any route (the sign-in screen showing): forget it, so the next person reads their own.
  useEffect(() => { if (me === null) forgetTime24(); else if (me && canViewLogistics(me)) loadTime24(); }, [me]);
  // R-400: an account that holds only Logistics permissions gets the Logistics screen and
  // nothing else. This device never holds the workspace for it (the sign-in skips the sync),
  // so every screen and every background read of workspace data below is skipped, not just hidden.
  const logisticsOnly = isLogisticsOnly(me);
  // R-224 gap: the navigate-tab listener needs the current visible() gate, but it's
  // registered once (see the [] effect below) while visible() is a fresh function
  // every render - a ref kept in sync near visible's own declaration is the bridge.
  const visibleRef = useRef<(id: Tab) => boolean>(() => false);
  const [orgName, setOrgName] = useState<string>("");
  // R-477: the approval queue's part of the bell, kept as what it holds so the bell can count only what needs you.
  const [apQueue, setApQueue] = useState<{ pending: number; requests: { kind: string }[] }>({ pending: 0, requests: [] });
  // R-449: overdue bills, for the Bills row's count. Same people who can open the screen.
  const [billsOverdue, setBillsOverdue] = useState(0);
  const billsAllowed = !!me && !logisticsOnly && (isAdmin(me) || can(me, "financials:view"));
  // Sign out is two-step: the first click arms it, the second one goes. It sits in
  // the footer next to the collapse control, one stray click from a row you press all
  // day, and a mis-click drops every unsynced local edit behind a re-auth.
  const [signOutArm, setSignOutArm] = useState<boolean>(false);
  // First-run getting-started tour (after setup + sign-in), and a replay hook.
  useEffect(() => {
    if (onboarded === true && me && !logisticsOnly) {
      try { if (localStorage.getItem("ec_welcome_desktop_v1") !== "1") setShowTour(true); } catch { /* ignore */ }
    }
  }, [onboarded, me, logisticsOnly]);
  useEffect(() => {
    const replay = () => setShowTour(true);
    window.addEventListener("replay-tour", replay);
    return () => window.removeEventListener("replay-tour", replay);
  }, []);
  useEffect(() => {
    if (!me || logisticsOnly) { setAccessSettled(false); return; }
    Promise.all([
      api.getMyPlan().then((p) => { setSuperadmin(!!p.is_superadmin); setPlan(p.plan); setEntitlements(p.entitlements || {}); }).catch(() => { setSuperadmin(false); setPlan(null); setEntitlements({}); }),
      api.localIsSuperadmin().then(setLocalSuper).catch(() => setLocalSuper(false)),
    ]).then(() => setAccessSettled(true));
  }, [me, logisticsOnly]);

  // Poll the approval queue for the bell badge: the pending customers and the requests. (A `client_add`
  // request is already represented by its pending customer, so it is never counted on its own.) The server's
  // notices, supplier leads among them, come from useNotices below, so they are read once, not again here.
  // What counts is bellCountOf's rule (R-477): only what needs you.
  useEffect(() => {
    if (!me?.is_admin) { setApQueue({ pending: 0, requests: [] }); return; }
    const refresh = () => Promise.all([
      api.listApprovalRequests().catch(() => []),
      api.getPendingApprovals().catch(() => []),
    ]).then(([reqs, pend]) => {
      setApQueue({ pending: pend.length, requests: reqs.map((r) => ({ kind: r.kind })) });
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

  // R-460: the logistics and bill notices (server side, for the team) and the Logistics-only account's own
  // alerts. Counted into the bell below; the same hook raises the operating-system notifications.
  const notices = useNotices(me);
  // Everything waiting in the Notifications screen, and what the bell shows: for a Logistics-only account
  // that is the loads to quote or book, and the bell opens Logistics.
  const apTotal = bellCountOf({ pendingCustomers: apQueue.pending, requests: apQueue.requests, notices: [...notices.team, ...notices.leads] });
  const bellShown = canSeeTeamNotices(me) || logisticsOnly;
  const bellCount = logisticsOnly ? notices.logisticsCount : apTotal;
  const bellTab: Tab = logisticsOnly ? "logistics" : "approvals";
  // R-571: the count is red while something urgent waits (money in today, an overdue bill or carrier, the pay day,
  // an urgent load), and a calm grey when everything on it can wait.
  const bellUrgent = logisticsOnly ? notices.logisticsUrgent : bellUrgentOf(notices.team);

  // R-591: the company logo sits beside the name. Re-read when Settings saves the company and when the window comes
  // back, so a logo picked on another computer shows up here (the server answers 304 when nothing changed).
  const [orgLogo, setOrgLogo] = useState<string | null>(null);
  useEffect(() => {
    const load = () => {
      api.getOrganizationName().then((n) => setOrgName((n || "").trim())).catch(() => {});
      api.companyLogoFile().then((p) => setOrgLogo(p ? `${convertFileSrc(p)}?t=${Date.now()}` : null)).catch(() => {});
    };
    load();
    window.addEventListener("company-info-change", load);
    window.addEventListener("focus", load);
    return () => { window.removeEventListener("company-info-change", load); window.removeEventListener("focus", load); };
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
    // R-400: a Logistics-only account never sets up a workspace, so the wizard is not for it.
    if (logisticsOnly) { setOnboarded(true); return; }
    api.getOnboardingStatus().then(setOnboarded).catch(() => setOnboarded(true));
  }, [me, logisticsOnly]);

  // R-400: the screen this account lands on, whatever tab the last person left stored. Set
  // without persisting, so the last tab on this device is not overwritten for the next sign-in.
  // Anything else is already refused by visible(), so nothing renders in the one frame before this runs.
  // It always opens on Logistics: Settings, even as the stored last tab, is allowed only once the
  // person has opened it themselves in this session.
  const logisticsLanded = useRef(false);
  useEffect(() => {
    if (!logisticsOnly) { logisticsLanded.current = false; return; }
    const allowed = isLogisticsOnlyTab(tab) || (tab === "settings" && logisticsLanded.current);
    logisticsLanded.current = true;
    if (!allowed) { setTabState("logistics"); setPageKey((k) => k + 1); }
    if (splitTab) setSplit(null);
  }, [logisticsOnly, tab, splitTab]);

  const signOut = async () => {
    try { await api.employeeLogout(); } catch {}
    // R-400, DG-03: the next person to sign in on this device starts on the Dashboard, not on the screen the
    // last account was held to or left open. The stored last screen is per device, so it goes for every role.
    try { localStorage.removeItem("clienthub_last_tab"); } catch { /* a blocked store has nothing to forget */ }
    forgetTime24();   // R-538: the next person on this device reads their own 24-hour choice
    setTabState("dashboard");
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

  const navRef = useRef<HTMLElement>(null);
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

  const pollNet = () => {
    api.netsyncStatus()
      .then((st) => setNet({ auth: st.auth, pending_push: st.pending_push, last_pull_at: st.last_pull_at, auth_reason: st.auth_reason, account_email: st.account_email }))
      .catch(() => setNet(null));
  };
  useEffect(() => {
    pollNet();
    const id = setInterval(pollNet, 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const open = () => setReconnectHidden(false);
    window.addEventListener(RECONNECT_EVENT, open);
    return () => window.removeEventListener(RECONNECT_EVENT, open);
  }, []);

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
    if (!me || logisticsOnly) { setDraftCount(0); return; }
    const read = () => api.listDrafts("pending").then((d) => setDraftCount(d.length)).catch(() => {});
    read();
    let unlisten: (() => void) | undefined;
    listen("netsync-applied", () => read()).then((u) => { unlisten = u; }).catch(() => {});
    const id = setInterval(read, 60000);
    return () => { clearInterval(id); unlisten?.(); };
  }, [me, logisticsOnly]);

  // R-449: how many bills are overdue. Local read (no server call), refreshed every minute and
  // whenever a bill or a link changes here or arrives from another device. Both are Tauri events,
  // so listen() and not addEventListener.
  useEffect(() => {
    if (!billsAllowed) { setBillsOverdue(0); return; }
    const read = () => billsApi.alerts().then((a) => setBillsOverdue(a.overdue_count)).catch(() => {});
    read();
    const un: (() => void)[] = [];
    let dead = false;
    for (const ev of ["bills-changed", "netsync-applied"]) {
      listen(ev, () => read()).then((u) => { if (dead) u(); else un.push(u); }).catch(() => {});
    }
    const id = setInterval(read, 60000);
    return () => { dead = true; clearInterval(id); un.forEach((u) => u()); };
  }, [billsAllowed]);

  // R-318: a Priority1 delivery announces itself wherever you are in the app, not only on
  // Deal Flow, because it is the moment that deal becomes completable. The green row on
  // Deal Flow is what keeps saying it after the toast has gone.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ label: string }>("shipment-delivered", (e) => {
      toast(`Delivered: ${e.payload.label}. Ready to mark the deal complete.`, "delivered");
    }).then((u) => { unlisten = u; }).catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const onNavigate = (e: Event) => {
      const detail = (e as CustomEvent<Tab>).detail;
      // R-224 gap: a navigate-tab event (command palette, or any of the in-app
      // "jump to X" shortcuts) used to land on any id at all, including a screen
      // this role's sidebar hides. Route it through the same visible() gate the
      // sidebar itself uses - via a ref, since this effect mounts once and visible
      // is a fresh function every render.
      if (detail && visibleRef.current(detail)) setTab(detail, true);
      else if (detail) toast("That screen is not available to your account", "error");
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
      await api.syncReplay();
      const s = await api.syncStatus();
      setLastSync(s.last_applied);
      setSyncFailed(null);
    } catch (e) {
      // R-511 DG-14: a failed manual sync used to stop the spinner and say nothing.
      setSyncFailed(String(e));
      toast(`Sync failed: ${String(e)}`, "error");
    } finally {
      setSyncing(false);
      pollNet();
    }
  };
  // The server light's word and colour. No answer at all (the command failed) reads as unreachable.
  const netOk = !!net && net.auth === "ok" && !syncFailed;
  const netWord = syncFailed ? "sync failed" : net?.auth === "auth_lost" ? "sign in again" : net?.auth !== "ok" ? "unreachable" : net.pending_push > 0 ? `${net.pending_push} waiting` : "connected";
  const netColor = netOk ? "var(--rail-ok)" : net?.auth === "auth_lost" && !syncFailed ? "var(--rail-hot)" : "var(--rail-bad)";
  const netTitle = `Server: ${netWord}${net?.last_pull_at ? `, last pull ${new Date(net.last_pull_at).toLocaleTimeString()}` : ""}`;

  // Same per-id gating as before (parents, children, and utility items alike).
  const visible = (id: Tab): boolean =>
    // R-400: a Logistics-only account sees its own screen and Settings (appearance and
    // profile only, see SettingsView). Everyone else sees Logistics when they may see deals.
    logisticsOnly ? (isLogisticsOnlyTab(id) || id === "settings")
    : id === "logistics" || id === "bols" ? canViewLogistics(me) // R-459: our own BOLs ride the same switch as the loads
    : id === "platform" ? (superadmin || localSuper)
    : id === "datasafety" ? (superadmin || localSuper) // secret integrity console

    : id === "archive" ? isAdmin(me)              // admin-only, like the money views
    : id === "documents" ? isAdmin(me)            // R-441 legal and tax papers; the server refuses non-admins too
    // Books area. Admins keep access unconditionally (as before); a non-admin
    // now needs an explicit financials:view grant, which no role template hands out.
    : id === "financials" ? (isAdmin(me) || can(me, "financials:view"))
    // R-449: bills read like the books (admins and anyone with financials:view); only admins write, and the server enforces that too.
    : id === "bills" ? (isAdmin(me) || can(me, "financials:view"))

    : id === "sheetcopy" ? (plan === "unlimited") // top-tier only (server also enforces)
    : id === "approvals" ? canSeeTeamNotices(me)  // was the header bell; also a Clients sub-item. R-460: deal and book viewers see their notices here too
    : id === "portals" ? canViewTab(me, "clients" as any) // R-290: rides client access, like Tiers
    : id === "manifest" ? canViewTab(me, "inventory" as any) // analyzer rides inventory access
    : id === "lotengine" ? canViewTab(me, "inventory" as any) // so does the lot engine
    : id === "warehouse" ? canViewTab(me, "inventory" as any) // and the warehouse (R-326)
    : id === "purchases" ? canViewTab(me, "inventory" as any) // and the purchase orders (R-596), which are buys on the warehouse's side
    : id === "coldcalls" ? canViewTab(me, "suppliers" as any) // R-546: sourcing suppliers, the bar /api/outreach asks for
    : id === "renewals" ? isAdmin(me) // R-466: the stale-listing requests are read for admins only, here and on the bell
    // Show packing (R-271/R-272): rides inventory access, plus the plan entitlement
    // itself — whether the add-on is turned ON for this org is a state the view
    // handles internally (setup screen), not a reason to hide the tab.
    : id === "showpacking" ? (canViewTab(me, "inventory" as any) && !!entitlements.show_packing)
    : canViewTab(me, id as any);
  // Kept in step every render so the navigate-tab listener above (mounted once,
  // deps []) always gates against the current role rather than the one at mount.
  useEffect(() => { visibleRef.current = visible; });

  // Flat list of every visible destination, used by the remembered-screen check below.
  const flatTabs: TabDef[] = ALL_TABS.filter((t) => visible(t.id));

  // DG-03: the remembered screen (and the split pane's) is read off this device's disk, which belongs to no one person.
  // A role that cannot open it, a role changed since, or an id that no longer exists would paint an empty pane with no
  // row lit, so the Dashboard opens instead. Not written back: the next sign-in on this device reads what was stored.
  // A Logistics-only account has no Dashboard and is sent to its own screen by the lock above.
  useEffect(() => {
    if (!me || logisticsOnly || !accessSettled) return;
    const openable = flatTabs.map((t) => t.id);
    const shown = tabToShow(tab, openable, "dashboard");
    if (shown !== tab) { setTabState(shown); setPageKey((k) => k + 1); }
    if (splitTab) {
      const shownSplit = tabToShow(splitTab, openable, "dashboard");
      if (shownSplit !== splitTab) setSplitTabState(shownSplit);
    }
    // flatTabs is rebuilt every render; what it holds only changes with the inputs listed (and accessSettled says they are in)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, logisticsOnly, accessSettled, tab, splitTab]);

  // ── The sidebar (R-583) ──────────────────────────────────────────────────────────────────────────
  // Nine sections (lib/sections.ts), one row each. A section's screens are the tab bar the shell draws
  // above the page (SectionFrame below), so the sidebar no longer carries a tree. Everything that used
  // to hang off a nav row still does: a screen's count moves onto its section row and its tab, the
  // visible() gate decides which rows and tabs exist, and a click on a section opens the screen last
  // used in it (or the first one this account may open).

  type CountTone = "urgent" | "calm" | "draft";
  /** The number a screen carries (unread, overdue, drafts), or null. Gated like the screen itself. */
  const tabCount = (id: Tab): { n: number; tone: CountTone } | null => {
    if (!visible(id)) return null;
    if (id === "approvals") return apTotal > 0 ? { n: apTotal, tone: bellUrgent ? "urgent" : "calm" } : null;
    if (id === "newsletter") return draftCount > 0 ? { n: draftCount, tone: "draft" } : null;
    if (id === "bills") return billsOverdue > 0 ? { n: billsOverdue, tone: "urgent" } : null;
    return null;
  };
  /** A section row carries the sum of its screens' counts; red text while any of them is urgent. */
  const sectionCount = (s: SectionDef): { n: number; tone: CountTone } | null => {
    let n = 0;
    let tone: CountTone | null = null;
    for (const t of s.tabs) {
      const c = tabCount(t.id);
      if (!c) continue;
      n += c.n;
      tone = tone === "urgent" || c.tone === "urgent" ? "urgent" : tone === "calm" || c.tone === "calm" ? "calm" : "draft";
    }
    return n > 0 ? { n, tone: tone || "calm" } : null;
  };
  const sectionShown = (s: SectionDef) => landingTab(s, visible) !== null;
  const currentSection = sectionOfTab(tab);
  const countChip = (c: { n: number; tone: CountTone } | null, small = false) =>
    c ? (
      <span
        className={`ui-count ${c.tone} flex-shrink-0`}
        style={small ? { minWidth: 16, height: 16, padding: "0 4px", fontSize: 10 } : undefined}
      >
        {c.n > (small ? 9 : 99) ? (small ? "9+" : "99+") : c.n}
      </span>
    ) : null;

  /** A click on a section opens the screen last used in it. */
  const openSection = (s: SectionDef) => {
    const to = landingTab(s, visible, lastInSection.current[s.id]);
    if (to) setTab(to);
  };

  // One row of the open sidebar, as in the Home mockup: 40px, icon and name, a chip for the number.
  const navItem = (s: SectionDef) => {
    const Icon = SECTION_ICONS[s.id];
    const active = currentSection?.id === s.id;
    return (
      <button
        key={s.id}
        onClick={() => openSection(s)}
        aria-current={active ? "page" : undefined}
        className={`w-full flex items-center gap-2.5 h-10 px-[11px] rounded-lg text-[14px] font-medium tracking-[0.025em] text-left transition-colors duration-150 ${
          active ? "text-ink bg-surface-3" : "text-muted hover:text-ink hover:bg-surface-2"
        }`}
      >
        <Icon size={16} className="flex-shrink-0" />
        <span className="flex-1 truncate">{s.label}</span>
        {countChip(sectionCount(s))}
      </button>
    );
  };

  // ── The collapsed rail (R-224) ────────────────────────────────────────────────────────────────────
  // It is not a narrower copy of the sidebar. Open, the sidebar shows the whole map; closed, it keeps you
  // oriented and lets you move fast inside the section you are already in. So every row carries its name,
  // the current section opens INLINE rather than in a flyout, and nothing scrolls.

  /** A top-level rail row: icon above its own name. */
  const railRow = (key: string, label: string, Icon: any, active: boolean, count: { n: number; tone: CountTone } | null, onClick: () => void) => (
    <button
      key={key}
      onClick={onClick}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`relative w-full flex flex-col items-center justify-center gap-[3px] h-[44px] px-1 rounded-lg transition-colors duration-150 ${
        active ? "text-ink rail-active" : "text-muted hover:text-ink hover:bg-surface-2"
      }`}
    >
      <Icon size={16} />
      <span className="max-w-full truncate text-[10px] font-medium leading-none">{label}</span>
      {count && <span className="absolute top-0.5 right-1">{countChip(count, true)}</span>}
    </button>
  );

  /** A screen inside the open section. Text only: at 96px an icon would cost the label its room, and the
   *  spine beside it already says these belong to the row above. */
  const railKid = (t: { id: Tab; label: string }) => {
    const active = tab === t.id;
    const c = tabCount(t.id);
    return (
      <button
        key={t.id}
        onClick={() => setTab(t.id)}
        title={t.label}
        aria-current={active ? "page" : undefined}
        className={`relative w-full flex items-center h-[24px] pl-[7px] pr-1.5 rounded-md text-[10.5px] font-medium transition-colors duration-150 ${
          active ? "text-ink rail-active" : "text-muted hover:text-ink hover:bg-surface-2"
        }`}
      >
        <span className="truncate">{t.label}</span>
        {c && <span className="ml-auto pl-1 flex-shrink-0">{countChip(c, true)}</span>}
      </button>
    );
  };

  /** A rail row that is not a destination: Search and All screens. */
  const railAction = (key: string, label: string, Icon: any, onClick: (e: React.MouseEvent) => void, open?: boolean) => (
    <button
      key={key}
      onClick={onClick}
      title={label}
      aria-expanded={open}
      className={`relative w-full flex flex-col items-center justify-center gap-[3px] h-[44px] px-1 rounded-lg transition-colors duration-150 ${
        open ? "text-ink rail-active" : "text-muted hover:text-ink hover:bg-surface-2"
      }`}
    >
      <Icon size={16} />
      <span className="max-w-full truncate text-[10px] font-medium leading-none">{label}</span>
    </button>
  );

  /** Which section rows the rail shows, and how tall they come out.
   *
   *  Three reasons earn a row: it is the section you are standing in, it is pinned, or it is carrying work
   *  that is waiting. That is also the order they survive in when the window is too short to hold them all:
   *  the rail may not scroll, so something has to go, and it goes to All screens rather than below the fold.
   *  A pin outranks a count because a pin is a choice you made and a count is the app being helpful.
   *  Whatever survives is drawn in section order regardless, so a row arriving or leaving never reshuffles
   *  the ones around it. The open section lists at most RAIL_KIDS_MAX of its screens (always including the
   *  one you are on); the rest are one click away in the tab bar and in All screens. */
  const railPlan = (() => {
    const sectionId: SectionId | null =
      currentSection && currentSection.id !== "settings" && sectionShown(currentSection) ? currentSection.id : null;

    type Row = { section: SectionDef; kids: TabDef[]; rank: number; at: number; h: number };
    const rows: Row[] = [];
    SECTIONS.filter((s) => s.id !== "settings").forEach((section, at) => {
      if (!sectionShown(section)) return;
      const isSection = section.id === sectionId;
      const pinned = railPins.includes(section.id);
      const counted = !!sectionCount(section);
      if (!isSection && !pinned && !counted) return;
      const open = visibleTabs(section, visible);
      const kids = isSection && open.length > 1 ? kidWindow(open, tab, RAIL_KIDS_MAX) : [];
      rows.push({
        section, kids, at,
        rank: isSection ? 0 : pinned ? 1 : 2,
        h: RAIL_ROW + (kids.length ? kids.length * RAIL_KID + 8 : 0),
      });
    });

    // Search + All screens + their two rules, plus the nav's own py-2.
    const chrome = RAIL_ROW * 2 + RAIL_SEP * 2 + 16;
    // navH is 0 only before the nav has been measured at all. Show everything then;
    // the layout effect corrects it on the next frame.
    let budget = navH > 0 ? navH - chrome : Number.POSITIVE_INFINITY;

    const keep = new Set<string>();
    let full = false;
    for (const r of [...rows].sort((a, b) => a.rank - b.rank || a.at - b.at)) {
      // The section you are in always gets its row: a rail that cannot say where you are is the fault
      // R-224 exists to fix, so it is never the thing that goes.
      if (r.rank === 0) { budget -= r.h; keep.add(r.section.id); continue; }
      // Once one row does not fit, everything below it in priority goes too. Skipping only the ones that
      // happen to be too tall would let a lower-priority row jump over a higher one as the window resizes.
      if (full || budget - r.h < 0) { full = true; continue; }
      budget -= r.h;
      keep.add(r.section.id);
    }
    return { rows: rows.filter((r) => keep.has(r.section.id)), sectionId };
  })();

  // One labelled row inside a flyout.
  const flyoutRow = (item: { id: Tab; label: string }, indent: boolean) => {
    const active = tab === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setTab(item.id)}
        className={`w-full flex items-center gap-2.5 ${indent ? "pl-6 pr-9" : "px-2.5 pr-9"} h-8 rounded-lg text-[13px] font-medium transition-colors ${
          active ? "text-ink bg-surface-3" : "text-muted hover:text-ink hover:bg-surface-3"
        }`}
      >
        <span className="truncate">{item.label}</span>
        <span className="ml-auto flex-shrink-0">{countChip(tabCount(item.id), true)}</span>
      </button>
    );
  };

  // Background per tab (globe is full-bleed dark); shared by single + split panes.
  const paneBg = (_t: Tab) => "var(--t-bg)";

  // Renders a tab's content without the outer scroll/background chrome, so it can be dropped into either the
  // single main area or a split pane. The padding and the section header around it come from SectionFrame
  // (R-583), so a screen draws neither an outer page padding nor its own copy of its section's tabs.
  const paneContent = (t: Tab) => {
    if (!visible(t)) return null;
    if (t === "globe") return <Suspense fallback={globeFallback}><GlobeView me={me} /></Suspense>;
    return (
      // Wraps the whole column rather than the lazy screens individually: the padding and header are
      // already on screen, so only the content area swaps, and any screen made lazy later is covered too.
      <Suspense fallback={paneFallback}>
        {t === "dashboard"  && <DashboardView onNavigate={(to) => setTab(to, true)} me={me} />}
        {t === "notes"      && <NotesView me={me?.display_name || ""} />}
        {t === "approvals"  && <ApprovalsView me={me} notices={notices} />}
        {t === "checkup"    && <CheckupView />}
        {t === "clients"    && <ClientsView />}
        {t === "invoices"   && <InvoicesView />}
        {t === "archive"    && <ArchiveView />}
        {t === "documents"  && <DocumentsView />}
        {t === "quotes"     && <QuotesView onNavigate={(to) => setTab(to, true)} />}
        {t === "releaseletter" && <ReleaseLetterView />}
        {t === "purchaseorder" && <PurchaseOrderView />}
        {t === "clientreceipt" && <ClientStatementView />}
        {t === "dealflow"   && <DealFlowView />}
        {t === "logistics"  && <LogisticsView me={me} />}
        {t === "bols"       && <BolsView me={me} />}
        {t === "suppliers"  && <SuppliersView />}
        {t === "inventory"  && <InventoryView />}
        {t === "warehouse"  && <WarehouseView />}
        {t === "purchases"  && <PurchasesView />}
        {t === "renewals"   && <RenewalsView />}
        {t === "coldcalls"  && <ColdCallsView />}
        {t === "manifest"   && <ManifestView onNavigate={(to) => setTab(to, true)} />}
        {t === "lotengine"  && <LotEngineView me={me} />}
        {t === "showpacking" && <ShowPackingView me={me} />}
        {t === "sheetcopy"  && <SheetCopyView />}
        {t === "financials" && <FinancialsView />}
        {t === "bills"      && <BillsView me={me} />}
        {t === "completed"  && <CloseoutView />}
        {t === "analytics"  && <AnalyticsView />}
        {t === "tiers"      && <TiersView />}
        {t === "portals"    && <CustomerPortalsView me={me} />}
        {t === "automation" && <AutomationLogView />}
        {t === "brief"      && <BriefView me={me} currentUser={me ? { name: me.display_name, role: me.is_admin ? "owner" : "sales_rep" } : null} />}
        {t === "newsletter" && <EmailView />}
        {t === "settings"   && <SettingsView me={me} />}
        {t === "platform"   && <PlatformView />}
        {t === "datasafety" && <DataSafetyView />}
      </Suspense>
    );
  };

  // R-511 DG-01: a screen that throws while rendering stops at its own pane instead of taking the whole app
  // down. Keyed on the screen id, so opening another screen mounts a fresh boundary. Back to Dashboard moves
  // this pane (the main one, or the split one) to the Dashboard. It is not offered on the Dashboard itself (a
  // split pane already on it would not change state, so the button would do nothing) or to a Logistics-only
  // account (the lock above sends it straight back to the screen that crashed). The section's header is
  // outside the boundary, so a screen that crashes still leaves its tabs to move to another.
  const guardedPane = (t: Tab, onBack: () => void) => (
    <PaneBoundary key={t} onBack={t === "dashboard" || logisticsOnly ? undefined : onBack}>{paneContent(t)}</PaneBoundary>
  );

  // Auth gates everything: not signed in → sign-in screen (accounts are made on
  // the website). Onboarding is only considered once signed in, and only if the
  // account genuinely hasn't completed it — never on a fresh reinstall.
  if (me === undefined) return null; // loading session
  if (me === null) return <AuthView onAuthed={(u) => setMe(u)} />;
  if (onboarded === null) return null; // resolving onboarding status for this account
  if (onboarded === false) return <OnboardingWizard onDone={() => setOnboarded(true)} />;

  // Bell, dark mode and split view. They sit in a row of icon buttons at the foot of the open sidebar and
  // move into the account menu when it is collapsed: split view has no other entry point anywhere in the
  // app, so dropping them from the rail would strand it.
  const shellButtons = (
    <>
      {/* Notification bell: the team's notices (admins, deal and book viewers), or for a Logistics-only
          account the loads waiting on a quote or a booking. */}
      {bellShown && (
        <button
          onClick={() => setTab(bellTab)}
          title={logisticsOnly && bellCount > 0 ? `${bellCount} to quote or book` : bellTitle(bellCount)}
          aria-label="Notifications"
          className={`ui-ib relative ${tab === bellTab ? "!text-ink !bg-surface-3" : ""}`}
        >
          <Bell size={15} />
          {bellCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5">{countChip({ n: bellCount, tone: bellUrgent ? "urgent" : "calm" }, true)}</span>
          )}
        </button>
      )}

      {/* Dark mode toggle: flips the base only; Mono (if on) is preserved since it is orthogonal. */}
      <button
        onClick={() => setDark(d => !d)}
        title={dark ? "Switch to light mode" : "Switch to dark mode"}
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        className="ui-ib"
      >
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      {/* Split-view toggle */}
      {!logisticsOnly && (
        <button
          onClick={toggleSplit}
          title={splitTab ? "Close split view" : "Open split view (two tabs side by side)"}
          aria-label={splitTab ? "Close split view" : "Open split view"}
          className={`ui-ib ${splitTab ? "!text-ink !bg-surface-3" : ""}`}
        >
          <Columns2 size={15} />
        </button>
      )}
    </>
  );

  /** A screen inside its section's frame: the shell's header (section name, actions slot, tab bar) when the
   *  section groups several screens, the padding every screen sits in, and the page itself. */
  const frame = (t: Tab, onSelect: (id: Tab) => void, content: React.ReactNode) => {
    const sec = sectionOfTab(t);
    const items: TabItem[] = sec
      ? visibleTabs(sec, visible).map((d) => {
          const c = tabCount(d.id);
          return { id: d.id, label: d.label, count: c?.n, countTone: c?.tone };
        })
      : [];
    return (
      <SectionFrame
        key={sec?.id ?? "none"}
        title={sec?.label ?? ""}
        items={items}
        value={t}
        onSelect={(id) => onSelect(id as Tab)}
        shell={shellDrawsHeader(t)}
        bleed={t === "globe"}
      >
        {content}
      </SectionFrame>
    );
  };

  const settingsSection = SECTIONS.find((s) => s.id === "settings")!;

  return (
    <div className="flex h-screen bg-side text-ink">
      {/* Sidebar */}
      <aside className={`${navCollapsed ? "w-[96px] px-1.5 py-2" : "w-[256px] p-4"} flex flex-col flex-shrink-0 relative transition-[width] motion-reduce:transition-none`}>
        {/* Brand. The mark and the name, then (open only) the organisation as the mockup's outlined box.
            The rail toggle is NOT here: it lives at the bottom of the footer in both states, so it is
            always in the same place. */}
        {navCollapsed ? (
          <div className="h-[46px] flex items-center justify-center flex-shrink-0">
            <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-6 w-6 flex-shrink-0" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 h-10 px-2 flex-shrink-0">
              <img src="/ecliptr-mark.svg" alt="" className="h-5 w-5 flex-shrink-0" />
              <span className="text-[14px] font-medium text-ink">Ecliptr</span>
            </div>
            {orgName ? (
              <div className="flex items-center gap-2.5 h-12 px-[11px] mt-1 mb-5 rounded-lg border border-line bg-surface-2 flex-shrink-0" title={orgName}>
                {orgLogo ? (
                  <img src={orgLogo} alt="" className="w-6 h-6 rounded-md object-contain flex-shrink-0"
                    onError={() => setOrgLogo(null)} />
                ) : (
                  <span className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-medium bg-ink text-surface flex-shrink-0">
                    {orgName.trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="flex-1 min-w-0 truncate text-[14px] font-medium">{orgName}</span>
              </div>
            ) : <div className="h-4 flex-shrink-0" />}
          </>
        )}

        {/* Nav */}
        <nav
          ref={navRef}
          aria-label="Sections"
          className={`flex-1 min-h-0 flex flex-col gap-0.5 ${navCollapsed ? "py-1 overflow-hidden" : "overflow-y-auto"}`}
        >
          {navCollapsed ? (
            <>
              {!logisticsOnly && railAction("__search", "Search", Search, () => { setFlyout(null); setPaletteOpen(true); })}
              {!logisticsOnly && <div className="h-[11px] mx-1 flex items-center" aria-hidden><div className="w-full border-t border-line" /></div>}

              {railPlan.rows.map(({ section, kids }) => (
                <div key={section.id} className="space-y-0.5">
                  {railRow(section.id, section.label, SECTION_ICONS[section.id], section.id === railPlan.sectionId, sectionCount(section), () => openSection(section))}
                  {kids.length > 0 && (
                    <div className="relative pl-[9px] mt-[3px] mb-[5px] space-y-0.5">
                      <span className="rail-spine absolute left-[3px] top-0.5 bottom-0.5 w-[1.5px] rounded-full" aria-hidden />
                      {kids.map((c) => railKid(c))}
                    </div>
                  )}
                </div>
              ))}

              <div className="h-[11px] mx-1 flex items-center" aria-hidden><div className="w-full border-t border-line" /></div>
              {railAction("__all", "All screens", Ellipsis, (e) => openFlyout("__all", e), flyout?.id === "__all")}
            </>
          ) : (
            SECTIONS.filter((s) => s.id !== "more" && s.id !== "settings" && sectionShown(s)).map(navItem)
          )}
        </nav>

        {/* More and Settings sit under the nav, pinned outside its scroller: they are the ones you reach
            for when you are lost. Collapsed it is Settings alone: the rest are one click away in All
            screens, which lists every screen this role can reach. */}
        <div className="flex-shrink-0 pt-2 space-y-0.5">
          {navCollapsed
            ? (sectionShown(settingsSection) ? railRow(settingsSection.id, settingsSection.label, SECTION_ICONS.settings, currentSection?.id === "settings", null, () => openSection(settingsSection)) : null)
            : SECTIONS.filter((s) => (s.id === "more" || s.id === "settings") && sectionShown(s)).map(navItem)}
        </div>

        {/* Status footer. Collapsed this is a compact strip: bell, dark mode, split view and sign out live
            in the account menu, which matters because the rail is forbidden to scroll. */}
        <div className={`flex-shrink-0 ${navCollapsed ? "pt-2" : "pt-3"}`}>
          {navCollapsed ? (
            <div className="flex flex-col items-center gap-1.5">
              <span className="py-0.5" title={netTitle} style={{ color: netColor }}>
                {netOk ? <Wifi size={12} /> : <WifiOff size={12} />}
              </span>
              {!logisticsOnly && <button
                onClick={handleSync}
                disabled={syncing}
                title={`Sync · ${lastSync ? new Date(lastSync).toLocaleTimeString() : "never"}`}
                aria-label="Sync now"
                className="ui-ib disabled:opacity-50"
              >
                <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
              </button>}
              <button
                onClick={(e) => openFlyout("__account", e)}
                title={me?.display_name || "Account"}
                aria-label="Account menu"
                aria-expanded={flyout?.id === "__account"}
                className="relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-2"
              >
                {me?.avatar
                  ? <img src={me.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
                  : <span className="w-7 h-7 rounded-full grid place-items-center text-[11px] font-medium bg-ink text-surface">
                      {(me?.display_name || "?").trim().charAt(0).toUpperCase()}
                    </span>}
                {bellShown && bellCount > 0 && (
                  <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[rgb(var(--c-side))] ${bellUrgent ? "bg-danger" : "bg-faint"}`} />
                )}
              </button>
              {/* The only way back out of the rail, and it sits in the same corner as the collapse control
                  does when the sidebar is open. It must never move into the nav: that clips, and a short
                  window once put it out of reach with no other exit. */}
              <button
                onClick={toggleNav}
                title="Expand sidebar (Cmd/Ctrl + B)"
                aria-label="Expand sidebar"
                className="ui-ib"
              >
                <PanelLeftOpen size={15} />
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {!logisticsOnly && <div className="flex items-center justify-between px-[11px] h-7 text-[12px] text-muted" title={netTitle}>
                <span className="flex items-center gap-2">
                  <span style={{ color: netColor }}>{netOk ? <Wifi size={12} /> : <WifiOff size={12} />}</span>
                  Server
                </span>
                <span className="font-medium" style={{ color: netColor }}>{netWord}</span>
              </div>}
              {!logisticsOnly && <button
                onClick={handleSync}
                disabled={syncing}
                className="w-full flex items-center justify-between px-[11px] h-7 rounded-lg text-[12px] text-muted hover:text-ink hover:bg-surface-2 transition-colors disabled:opacity-50"
              >
                <span className="flex items-center gap-2">
                  <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
                  Sync
                </span>
                <span className="tabular-nums">
                  {lastSync ? new Date(lastSync).toLocaleTimeString() : "never"}
                </span>
              </button>}

              {/* Signed-in user, then the row of shell buttons: bell, dark mode, split view, collapse the
                  rail, sign out. Feedback has a Settings section of its own. */}
              <div className="flex items-center gap-2.5 px-[11px] pt-3">
                {me?.avatar
                  ? <img src={me.avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                  : <span className="w-7 h-7 rounded-full grid place-items-center text-[11px] font-medium bg-ink text-surface flex-shrink-0">
                      {(me?.display_name || "?").trim().charAt(0).toUpperCase()}
                    </span>}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{me?.display_name}</div>
                  <div className="text-[12px] text-muted truncate">{me?.role_name}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 px-1.5 pt-2">
                {shellButtons}
                <span className="flex-1" />
                <button
                  onClick={toggleNav}
                  title="Collapse sidebar (Cmd/Ctrl + B)"
                  aria-label="Collapse sidebar"
                  className="ui-ib"
                >
                  <PanelLeftClose size={15} />
                </button>
                <button
                  onClick={() => setSignOutArm((v) => !v)}
                  title="Sign out"
                  aria-label="Sign out"
                  aria-expanded={signOutArm}
                  className={`ui-ib ${signOutArm ? "!text-danger-ink !bg-danger-bg" : ""}`}
                >
                  <LogOut size={15} />
                </button>
              </div>

              {/* Step two. Signing out is not destructive, but it is a re-auth away from everything, and the
                  button sits one icon from the collapse control you press all day, so it asks. */}
              {signOutArm && (
                <div className="px-[11px] pt-3 space-y-2">
                  <div className="text-[12px] text-ink">Sign out of {orgName || "Ecliptr"}?</div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={signOut} className="ui-btn ui-btn-sm ui-btn-danger flex-1">Sign out</button>
                    <button onClick={() => setSignOutArm(false)} className="ui-btn ui-btn-sm flex-1">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Rail flyouts. Two of them: the account menu behind the footer avatar, and All screens. The
            section you are in opens inline in the rail instead. Fixed rather than absolute so the rail
            cannot clip them, over a backdrop that closes on any outside click. `left` is the rail width
            plus a gap; there is no shared constant for it, so it moves when the rail moves. */}
        {navCollapsed && flyout && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setFlyout(null)} />
            <div
              ref={flyRef}
              className="fixed z-50 w-[204px] p-1 rounded-xl bg-surface"
              style={{ left: 102, top: flyout.top, boxShadow: "var(--shadow-panel)" }}
            >
              {flyout.id === "__account" ? (
                <>
                  <div className="px-2.5 pt-1.5 pb-2 mb-1 border-b border-line">
                    <div className="text-[13px] font-medium truncate">{me?.display_name}</div>
                    <div className="text-[12px] text-muted truncate">{me?.role_name}</div>
                  </div>
                  {bellShown && (
                    <button onClick={() => setTab(bellTab)} className={RAIL_MENU_ROW}>
                      <Bell size={14} />
                      <span>Notifications</span>
                      <span className="ml-auto">{countChip(bellCount > 0 ? { n: bellCount, tone: bellUrgent ? "urgent" : "calm" } : null, true)}</span>
                    </button>
                  )}
                  <button onClick={() => { setDark(d => !d); setFlyout(null); }} className={RAIL_MENU_ROW}>
                    {dark ? <Sun size={14} /> : <Moon size={14} />}
                    <span>{dark ? "Light mode" : "Dark mode"}</span>
                  </button>
                  {!logisticsOnly && <button onClick={() => { toggleSplit(); setFlyout(null); }} className={RAIL_MENU_ROW}>
                    <Columns2 size={14} />
                    <span>{splitTab ? "Close split view" : "Split view"}</span>
                  </button>}
                  {/* Two-step here too, in the one row the menu has room for: the first click relabels
                      it, the second signs out. */}
                  <button
                    onClick={() => { if (signOutArm) { setFlyout(null); signOut(); } else setSignOutArm(true); }}
                    className={`${RAIL_MENU_ROW} ${signOutArm ? "!text-danger-ink" : ""}`}
                  >
                    <LogOut size={14} />
                    <span>{signOutArm ? "Confirm sign out" : "Sign out"}</span>
                  </button>
                </>
              ) : flyout.id === "__all" ? (
                // Everything this role can reach, including the screens the rail is not currently showing,
                // grouped by section. visible() is what filters it, so it cannot leak a screen the sidebar
                // hides. It scrolls: 39 rows do not fit any window. A pin keeps a section's row on the rail.
                <div className="max-h-[60vh] overflow-y-auto">
                  {SECTIONS.filter(sectionShown).map((s) => {
                    const open = visibleTabs(s, visible);
                    const pinned = railPins.includes(s.id);
                    return (
                      <div key={s.id} className="relative group/allrow">
                        {open.length === 1
                          ? flyoutRow({ id: open[0].id, label: s.label }, false)
                          : (
                            <button
                              onClick={() => openSection(s)}
                              className="w-full flex items-center h-8 px-2.5 pr-9 rounded-lg text-[12px] font-medium text-faint hover:text-ink hover:bg-surface-3 text-left transition-colors"
                            >
                              {s.label}
                            </button>
                          )}
                        {s.id !== "settings" && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleRailPin(s.id); }}
                            title={pinned ? `Unpin ${s.label} from the rail` : `Pin ${s.label} to the rail`}
                            aria-label={pinned ? `Unpin ${s.label}` : `Pin ${s.label}`}
                            className={`absolute top-1 right-1 h-6 w-6 flex items-center justify-center rounded-md transition-colors ${
                              pinned
                                ? "text-ink hover:bg-surface-3"
                                : "opacity-0 group-hover/allrow:opacity-100 focus:opacity-100 text-faint hover:text-ink hover:bg-surface-3"
                            }`}
                          >
                            <Pin size={12} style={pinned ? { fill: "currentColor" } : undefined} />
                          </button>
                        )}
                        {open.length > 1 && open.map((t) => flyoutRow(t, true))}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        )}

      </aside>


      {/* Main: the panel, 32px of padding and a 40px top-left corner (the padding lives in SectionFrame). */}
      <main className="flex-1 min-w-0 overflow-hidden relative bg-surface rounded-tl-[40px]">
        {splitTab ? (
          <div ref={splitRowRef} className="flex h-full">
            {/* Left pane — driven by the sidebar nav */}
            <section className="min-w-0 overflow-auto pane-container" style={{ width: `${splitRatio * 100}%`, background: paneBg(tab) }}>
              {tab !== "globe" && <UpdateNotification />}
              {frame(tab, (id) => setTab(id), (
                <div key={`l-${pageKey}`} className={`page-enter ${tab === "globe" ? "h-full" : ""}`}>{guardedPane(tab, () => setTab("dashboard"))}</div>
              ))}
            </section>

            {/* Draggable divider */}
            <div
              onMouseDown={startSplitDrag}
              className="w-1.5 flex-shrink-0 cursor-col-resize relative group bg-surface-2"
              title="Drag to resize"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-ink/10 transition-colors" />
            </div>

            {/* Right pane — independent tab picker */}
            <section className="flex-1 min-w-0 overflow-auto relative pane-container" style={{ background: paneBg(splitTab) }}>
              <div className="sticky top-0 z-20 flex items-center gap-2 px-3 h-10 flex-shrink-0 bg-surface border-b border-line">
                <Columns2 size={13} className="text-faint" />
                <span className="text-[12px] text-faint">Split</span>
                <select
                  value={splitTab}
                  onChange={(e) => setSplit(e.target.value as Tab)}
                  className="text-[12px] rounded-md px-2 h-7 bg-surface text-ink border border-line-3"
                >
                  {SECTIONS.filter(sectionShown).map((s) => (
                    <optgroup key={s.id} label={s.label}>
                      {visibleTabs(s, visible).filter((t) => t.id !== "globe").map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={() => setSplit(null)}
                  className="ui-ib ml-auto"
                  title="Close split view"
                  aria-label="Close split view"
                >
                  <X size={14} />
                </button>
              </div>
              {frame(splitTab, (id) => setSplit(id), (
                <div key={`r-${splitTab}`} className="page-enter">{guardedPane(splitTab, () => setSplit("dashboard"))}</div>
              ))}
            </section>
          </div>
        ) : (
          <div className={tab === "globe" ? "h-full overflow-hidden" : "h-full overflow-auto"} style={{ background: paneBg(tab) }}>
            {/* Outside the keyed page, as in split view: a tab click must not remount it (R-409). */}
            {tab !== "globe" && <UpdateNotification />}
            {frame(tab, (id) => setTab(id), (
              <div key={pageKey} className={`page-enter ${tab === "globe" ? "h-full" : ""}`}>
                {guardedPane(tab, () => setTab("dashboard"))}
              </div>
            ))}
          </div>
        )}
      </main>

      {showTour && <GettingStarted onDone={() => setShowTour(false)} />}
      {quickLogOpen && !logisticsOnly && <QuickLogModal onClose={() => setQuickLogOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} logisticsOnly={logisticsOnly} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {sharePanelIds && (
        <WhatsAppSharePanel
          lotIds={sharePanelIds}
          mediaBase={shareMediaBase}
          onClose={() => setSharePanelIds(null)}
        />
      )}
      {net?.auth === "auth_lost" && !reconnectHidden && (
        <ReconnectSheet
          email={net.account_email || me.email}
          reason={net.auth_reason}
          onClose={() => setReconnectHidden(true)}
          onDone={() => { setReconnectHidden(false); pollNet(); }}
        />
      )}
      <ToastHost />
    </div>
  );
}
