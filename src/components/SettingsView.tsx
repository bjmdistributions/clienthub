import { useEffect, useState, useRef, createContext, useContext } from "react";
import {
  api,
  Me,
  EmailInbox,
  EmailSettings,
  PolicyClauseSettings,
  CompanyInfo,
  InvoiceTemplate,
  OllamaModel,
  CsvPreview,
  ImportSummary,
  SignupRule,
  PaymentMethod,
  PaymentMethodInput,
  LineItemTemplate,
  Category,
  CategoryInput,
  SheetSyncConfig,
  SheetSyncResult,
  SheetSyncLogEntry,
  SheetWritebackStatus,
  User,
  StaffMember,
  RoleDef,
  InviteRow,
  FollowUpRule,
  FollowUpLogEntry,
  StripeConfigStatus,
  GoogleContact,
  CustomField,
  WhatsappSettings,
  CapturedCustomer,
  FormCapturePreview,
  StorefrontConfig,
  FbStatus,
  FbPageLite,
  NewsletterProductTemplate,
} from "../lib/api";
import { buildNewsletterBody } from "../lib/newsletter";
import { fmtAmount, parseAmount, parseCount } from "../lib/format";
import { isAdmin } from "../lib/permissions";
import {
  Save,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  Upload,
  Plus,
  Trash2,
  Sparkles,
  RefreshCw,
  Image,
  Hash,
  ChevronUp,
  ChevronDown,
  Edit2,
  X,
  Building2,
  Palette,
  Tag,
  Mail,
  FileText,
  Zap,
  Bot,
  Sheet,
  Download,
  CreditCard,
  Receipt,
  ShoppingBag,
  Facebook,
  Globe,
  Split,
  Database,
  Users,
  SlidersHorizontal,
  Moon,
  Sun,
  MessageCircle,
  CheckCheck,
  ArrowDownAZ,
  Contrast,
  PanelLeftClose,
  Cloud,
  ChevronRight,
  Inbox,
  Send,
  Wand2,
  BookOpen,
  Lock,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ExternalLink,
  Share2,
  MessageSquarePlus,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "./Toast";
import VariablePicker from "./VariablePicker";
import { FeedbackPanel } from "./FeedbackPanel";
import InvoicePreview from "./InvoicePreview";
import NumberInput from "./NumberInput";
import { FormsPanel } from "./FormsPanel";
import { GoogleCloudGuide } from "./GoogleCloudGuide";

// Opens the matching section of the website setup guide in the browser.
function GuideLink({ section }: { section: string }) {
  return (
    <button onClick={() => api.openExternal(`https://ecliptr.app/guide#${section}`)}
      className="text-[12px] text-accent hover:underline inline-flex items-center gap-1.5 whitespace-nowrap">
      <BookOpen size={13} /> Setup guide
    </button>
  );
}

// ── Settings auto-save ──────────────────────────────────────────────────────
type SaveState = "idle" | "saving" | "saved" | "error";
const SaveStatusCtx = createContext<(s: SaveState) => void>(() => {});

/// Debounced auto-save: saves `value` ~700ms after it changes (skipping the
/// initial loaded value), reporting saving/saved into the shared status pill.
function useAutosave(value: unknown, save: () => Promise<void>, ready: boolean) {
  const report = useContext(SaveStatusCtx);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const lastSaved = useRef<string | null>(null);
  const saveRef = useRef(save);
  const pending = useRef<string | null>(null);   // json scheduled but not yet saved
  saveRef.current = save;
  const json = JSON.stringify(value);

  // Run the save with a hard timeout: a hung round-trip (e.g. an unreachable
  // server in SaaS mode) reports an error instead of pinning the pill on
  // "Saving…" forever.
  const run = async (j: string) => {
    pending.current = null;
    report("saving");
    try {
      await Promise.race([
        saveRef.current(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
      ]);
      lastSaved.current = j;
      report("saved");
    } catch { report("error"); }
  };

  useEffect(() => {
    if (!ready) { lastSaved.current = json; return; }   // baseline = loaded value
    if (json === lastSaved.current) return;             // no real change
    pending.current = json;
    report("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void run(json); }, 700);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, ready]);

  // On unmount, flush a still-pending edit so it isn't lost when the user
  // switches sections mid-debounce, and the pill can never stick on "Saving…"
  // after the section is gone.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (pending.current !== null) void run(pending.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const inpSm = "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

type SettingsTab =
  | "account" | "appearance" | "company" | "invoice" | "quote" | "storefront" | "categories" | "customfields"
  | "email" | "whatsapp" | "templates" | "automation" | "forms"
  | "ai" | "sheets" | "import" | "payments" | "billing" | "shopify" | "facebook" | "webforms"
  | "sync" | "splits" | "backup" | "team" | "feedback";

const SETTINGS_GROUPS: {
  group: string;
  items: { id: SettingsTab; label: string; icon: any; desc: string }[];
}[] = [
  {
    group: "Workspace",
    items: [
      { id: "account",      label: "My Account",     icon: Users,             desc: "Your name, photo & contact info" },
      { id: "appearance",   label: "Appearance",    icon: Palette,           desc: "Theme, accent color & display" },
      { id: "company",      label: "Company",        icon: Building2,         desc: "Business details & invoice logo" },
      { id: "invoice",      label: "Invoice",        icon: Receipt,           desc: "Invoice branding, numbering & preview" },
      { id: "quote",        label: "Quote",          icon: FileText,          desc: "Quote branding, numbering & preview" },
      { id: "storefront",   label: "Storefront",     icon: Globe,             desc: "Public inventory catalog link" },
      { id: "categories",   label: "Categories",     icon: Tag,               desc: "Client & deal categories" },
      { id: "customfields", label: "Custom Fields",  icon: SlidersHorizontal, desc: "Extra fields on client records" },
    ],
  },
  {
    group: "Communication",
    items: [
      { id: "email",      label: "Email",       icon: Mail,          desc: "SMTP / IMAP & Pi sending" },
      { id: "whatsapp",   label: "WhatsApp",    icon: MessageCircle, desc: "Inventory share message template" },
      { id: "templates",  label: "Templates",   icon: FileText,      desc: "Reusable line-item templates" },
      { id: "automation", label: "Automation",  icon: Zap,      desc: "Signup detection & follow-ups" },
      { id: "forms",      label: "Lead Forms",  icon: FileText, desc: "Custom forms to capture clients" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { id: "ai",       label: "AI",            icon: Bot,        desc: "Ollama model selection" },
      { id: "sheets",   label: "Google Sheets", icon: Sheet,      desc: "Two-way sheet sync" },
      { id: "import",   label: "Import",        icon: Download,   desc: "CSV & Google Contacts" },
      { id: "billing",  label: "Billing",       icon: Receipt,    desc: "Stripe configuration" },
      { id: "shopify",  label: "Shopify",       icon: ShoppingBag, desc: "Sync new customers as leads" },
      { id: "facebook", label: "Facebook",      icon: Facebook,    desc: "Post inventory to a Facebook Page" },
      { id: "webforms", label: "Web forms",     icon: Globe,       desc: "Custom sites & forms → pending leads" },
    ],
  },
  {
    group: "Data & Team",
    items: [
      { id: "sync",   label: "Sync",   icon: RefreshCw, desc: "Event log, encryption & updates" },
      { id: "splits", label: "Splits", icon: Split,     desc: "Profit-split partners" },
      { id: "backup", label: "Backup", icon: Database,  desc: "Local backups & restore" },
      { id: "team",   label: "Team",   icon: Users,     desc: "Users, roles & invites" },
    ],
  },
  {
    // Feedback's home. It was an unlabelled icon in the sidebar footer; anyone can
    // send it, so it stays visible to non-admins too (see NON_ADMIN_SECTIONS).
    group: "Help",
    items: [
      { id: "feedback", label: "Send feedback", icon: MessageSquarePlus, desc: "Requests and bug reports go straight to the team" },
    ],
  },
];

export default function SettingsView({ me }: { me: Me | null | undefined }) {
  // Everyone can open Settings, but only admins see org-sensitive sections;
  // viewers/sales get Appearance (per-device) + their own Account.
  const admin = isAdmin(me);
  const NON_ADMIN_SECTIONS: SettingsTab[] = ["account", "appearance", "feedback"];
  const groups = admin
    ? SETTINGS_GROUPS
    : SETTINGS_GROUPS
        .map((g) => ({ ...g, items: g.items.filter((i) => NON_ADMIN_SECTIONS.includes(i.id)) }))
        .filter((g) => g.items.length > 0);

  const [tab, setTab] = useState<SettingsTab>(() => {
    // Payments merged into the Invoice tab — redirect any saved "payments" tab.
    const s = localStorage.getItem("clienthub_settings_tab") as SettingsTab;
    return s === "payments" ? "invoice" : (s || "appearance");
  });
  const select = (t: SettingsTab) => {
    setTab(t);
    localStorage.setItem("clienthub_settings_tab", t);
  };
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // A non-admin whose stored tab is now gated falls back to Appearance.
  useEffect(() => {
    if (!admin && !NON_ADMIN_SECTIONS.includes(tab)) setTab("appearance");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, tab]);

  // Clear the auto-save pill when switching sections so a prior section's
  // "Saving…"/"Couldn't save" can't linger on a section that doesn't autosave
  // (e.g. Team), where it would look like the current action is stuck.
  useEffect(() => { setSaveState("idle"); }, [tab]);

  // The whole Settings page (nav + content) scrolls together inside an ancestor
  // scroll container. If the nav is scrolled down to reach a low item and the
  // opened section is short, its content renders above the fold. Reset the
  // nearest scrollable ancestor to the top on every tab change so the freshly
  // opened section is always in view.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let el: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        el.scrollTop = 0;
        break;
      }
      el = el.parentElement;
    }
  }, [tab]);

  const active = groups.flatMap((g) => g.items).find((i) => i.id === tab);

  return (
   <SaveStatusCtx.Provider value={setSaveState}>
    <div ref={rootRef} className="flex gap-5 lg:gap-8 max-w-[1100px]">
      {/* Left rail */}
      <aside className="w-[200px] lg:w-[232px] shrink-0">
        <div className="mb-5 px-1">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Settings</h2>
          <p className="text-[12px] text-muted mt-0.5">Manage your workspace</p>
        </div>
        <nav className="space-y-5">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="px-3 mb-1.5 text-[12.5px] font-medium text-muted">
                {g.group}
              </div>
              <div className="space-y-0.5">
                {g.items.map((it) => {
                  const Icon = it.icon;
                  const isActive = tab === it.id;
                  return (
                    <button
                      key={it.id}
                      onClick={() => select(it.id)}
                      className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-[13px] transition-colors ${
                        isActive
                          ? "accent-active font-medium"
                          : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      <Icon size={15} className={isActive ? "accent-active-ic" : "text-muted"} />
                      {it.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {active && (
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[16px] font-semibold text-ink tracking-tight">{active.label}</h3>
              <p className="text-[12px] text-muted mt-0.5">{active.desc}</p>
            </div>
            <div className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 h-7 rounded-full flex-shrink-0 ${
              saveState === "saving" ? "bg-accent/10 text-accent-hover"
              : saveState === "error" ? "bg-red-50 text-red-600"
              : "bg-emerald-50 text-emerald-600"}`}>
              {saveState === "saving" ? "Saving…"
               : saveState === "error" ? "Couldn’t save"
               : <><Check size={12} /> All changes saved</>}
            </div>
          </div>
        )}
        <div key={tab} className="page-enter">
          {tab === "account"     && <AccountTab />}
          {tab === "appearance"  && <AppearanceTab />}
          {tab === "email"       && <EmailTab />}
          {tab === "whatsapp"    && <WhatsAppTab />}
          {tab === "company"     && <CompanyTab />}
          {tab === "invoice"     && <div className="space-y-8"><DocBrandingTab kind="invoice" /><PaymentsTab /></div>}
          {tab === "quote"       && <DocBrandingTab kind="quote" />}
          {tab === "storefront"  && <StorefrontTab />}
          {tab === "categories"  && <CategoriesTab />}
          {tab === "ai"          && <AiTab />}
          {tab === "sync"        && <SyncTab />}
          {tab === "import"      && <ImportTab />}
          {tab === "automation"  && <AutomationTab />}
          {tab === "forms"       && <FormsPanel />}
          {tab === "templates"   && <TemplatesTab />}
          {tab === "sheets"      && <SheetsTab />}
          {tab === "splits"      && <SplitsTab />}
          {tab === "backup"      && <BackupTab />}
          {tab === "team"        && <TeamTab />}
          {tab === "billing"     && <BillingTab />}
          {tab === "shopify"     && <ShopifyTab />}
          {tab === "facebook"    && <FacebookTab />}
          {tab === "webforms"    && <IntakeTab />}
          {tab === "customfields"&& <CustomFieldsTab />}
          {tab === "feedback"    && <FeedbackPanel me={me} />}
        </div>
      </div>
    </div>
   </SaveStatusCtx.Provider>
  );
}

// Resize an uploaded image to a small square-ish JPEG data URL (avatar).
function resizePhoto(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function AccountTab() {
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState({ display_name: "", title: "", phone: "", avatar: "" });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api.employeeMe().then((m) => {
      if (m) { setMe(m); setForm({ display_name: m.display_name, title: m.title || "", phone: m.phone || "", avatar: m.avatar || "" }); }
    }).finally(() => setReady(true));
  }, []);
  const save = async () => { await api.updateMyAccount(form); };
  useAutosave(form, save, ready && !!me);
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { const url = await resizePhoto(f); setForm((p) => ({ ...p, avatar: url })); } catch { /* ignore */ }
    e.target.value = "";
  };
  if (!me) return <div className="text-sm text-muted py-8 text-center">Loading…</div>;
  const initial = (form.display_name || me.email || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="space-y-4 max-w-xl">
      <div className="bg-surface border border-line rounded-xl p-6">
      <div className="flex items-center gap-4 mb-6">
        {form.avatar
          ? <img src={form.avatar} alt="" className="w-20 h-20 rounded-full object-cover border border-line" />
          : <div className="w-20 h-20 rounded-full flex items-center justify-center text-[28px] font-bold text-on-accent" style={{ background: "var(--accent-600)" }}>{initial}</div>}
        <div>
          <label className="bg-surface-2 border border-line hover:bg-surface-3 text-ink-2 px-3 h-8 rounded-lg text-[12px] font-medium inline-flex items-center cursor-pointer">
            Upload photo<input type="file" accept="image/*" className="hidden" onChange={pick} />
          </label>
          {form.avatar && <button onClick={() => setForm((p) => ({ ...p, avatar: "" }))} className="ml-2 text-[12px] text-muted hover:text-danger-ink">Remove</button>}
        </div>
      </div>
      <div className="space-y-3">
        <div><label className="block text-[12px] font-medium text-muted mb-1">Name</label><input className={inpSm} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
        <div><label className="block text-[12px] font-medium text-muted mb-1">Title</label><input className={inpSm} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Sales Manager" /></div>
        <div><label className="block text-[12px] font-medium text-muted mb-1">Phone</label><input className={inpSm} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        <div><label className="block text-[12px] font-medium text-muted mb-1">Email</label><input className={inpSm + " opacity-60"} value={me.email} disabled /><p className="text-[10px] text-muted mt-1">Contact an admin to change your email.</p></div>
        <div><label className="block text-[12px] font-medium text-muted mb-1">Role</label><input className={inpSm + " opacity-60"} value={me.role_name} disabled /></div>
      </div>
      </div>
      <MyPlanCard />
      <button onClick={() => window.dispatchEvent(new CustomEvent("replay-tour"))} className="text-[12px] text-muted hover:text-ink transition-colors">Replay the getting-started tour</button>
    </div>
  );
}

function MyPlanCard() {
  const [plan, setPlan] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.getMyPlan().then(setPlan).catch((e) => setErr(String(e))); }, []);
  if (err || !plan) return null; // local-first: hide when not signed into the server / offline
  const planLabel = String(plan.plan || "free");
  const pretty = planLabel.charAt(0).toUpperCase() + planLabel.slice(1);
  const Row = ({ label, used, limit }: { label: string; used: number; limit: number | null }) => {
    const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return (
      <div>
        <div className="flex items-center justify-between text-[12px] mb-1">
          <span className="text-ink-2">{label}</span>
          <span className="text-muted tabular-nums">{used}{limit != null ? ` / ${limit}` : " · unlimited"}</span>
        </div>
        {limit != null && (
          <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: pct >= 100 ? "rgb(var(--c-danger))" : "var(--accent-500)" }} />
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="bg-surface border border-line rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <SectionLabel>My Plan</SectionLabel>
        <span className="text-[11px] font-bold uppercase tracking-wider text-accent bg-accent/10 border border-accent/20 px-2.5 py-1 rounded-full">{pretty}</span>
      </div>
      <div className="space-y-3">
        <Row label="Team members" used={plan.members ?? 0} limit={plan.member_limit ?? null} />
        <Row label="Clients" used={plan.clients ?? 0} limit={plan.client_limit ?? null} />
      </div>
      {planLabel === "free" && <p className="text-[12px] text-muted mt-4">Paid plans with higher limits are coming soon.</p>}
    </div>
  );
}

function AppearanceTab() {
  const [dark, setDark] = useState(() => localStorage.getItem("clienthub_dark") === "1");
  const [matte, setMatte] = useState(() => localStorage.getItem("clienthub_matte") === "1");
  const [accent, setAccentState] = useState(() => localStorage.getItem("clienthub_accent") || "orange");
  const [navAuto, setNavAutoState] = useState(() => localStorage.getItem("clienthub_nav_auto") !== "0");

  // Per device, like the rest of Appearance. App owns the state; this writes the
  // key and tells it, the same shape as the theme toggles above.
  const setNavAuto = (on: boolean) => {
    setNavAutoState(on);
    localStorage.setItem("clienthub_nav_auto", on ? "1" : "0");
    window.dispatchEvent(new CustomEvent("nav-auto-change", { detail: on }));
  };

  const setAccent = (a: string) => {
    setAccentState(a);
    window.dispatchEvent(new CustomEvent("accent-change", { detail: a }));
  };
  // Base (light/dark) and Mono are now orthogonal — set each independently.
  const setBase = (isDark: boolean) => {
    setDark(isDark);
    window.dispatchEvent(new CustomEvent("dark-change", { detail: isDark }));
  };
  const setMono = (on: boolean) => {
    setMatte(on);
    window.dispatchEvent(new CustomEvent("matte-change", { detail: on }));
  };

  const ACCENTS = [
    { id: "orange",  label: "Ecliptr orange", swatch: "#FF6520" },
    { id: "eclipse", label: "Indigo",   swatch: "#4F46E5" },
    { id: "blue",    label: "Blue",     swatch: "#2563EB" },
    { id: "emerald", label: "Emerald",  swatch: "#059669" },
    { id: "teal",    label: "Teal",     swatch: "#0D9488" },
    { id: "violet",  label: "Violet",   swatch: "#7C3AED" },
    { id: "amber",   label: "Amber",    swatch: "#D97706" },
    { id: "rose",    label: "Rose",     swatch: "#E11D48" },
  ];

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <SectionLabel>Accent Color</SectionLabel>
      <p className="text-[12px] text-muted mb-3 mt-0.5">
        {matte
          ? "Mono is on — accent colors are disabled while the interface is monochrome. Turn Mono off to choose an accent."
          : "Sets the accent used across the sidebar, highlights and controls. Data colors (revenue, profit, charts) stay fixed for clarity."}
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        {ACCENTS.map((a) => {
          const isActive = accent === a.id && !matte;
          return (
            <button
              key={a.id}
              onClick={() => { if (!matte) setAccent(a.id); }}
              disabled={matte}
              title={matte ? "Mono is on — accent colors don't apply" : a.label}
              className={`relative flex flex-col items-center gap-2 py-4 rounded-xl border transition-all ${
                matte
                  ? "border-line opacity-40 cursor-not-allowed"
                  : isActive ? "border-transparent ring-2 ring-offset-1" : "border-line hover:border-line-3"
              }`}
              style={isActive ? ({ ["--tw-ring-color" as any]: a.swatch } as any) : undefined}
            >
              <span
                className="relative w-9 h-9 rounded-full shadow-inner flex items-center justify-center"
                style={{ background: a.swatch }}
              >
                {isActive && <Check size={16} className="text-white" />}
                {matte && (
                  <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
                    <span className="block w-[150%] h-[2px] rotate-45 rounded-full bg-white" />
                  </span>
                )}
              </span>
              <span className={`text-[12px] font-medium text-ink-2 ${matte ? "line-through" : ""}`}>{a.label}</span>
            </button>
          );
        })}
      </div>

      <SectionLabel>Theme</SectionLabel>
      <p className="text-[12px] text-muted mb-3 mt-0.5">Pick a base, then add Mono for a stripped-back monochrome look.</p>
      <div className="flex gap-3 mb-5">
        {([
          { isDark: false, label: "Light", icon: Sun },
          { isDark: true,  label: "Dark",  icon: Moon },
        ] as { isDark: boolean; label: string; icon: typeof Sun }[]).map((opt) => {
          const Icon = opt.icon;
          const isActive = dark === opt.isDark;
          return (
            <button
              key={opt.label}
              onClick={() => setBase(opt.isDark)}
              className={`flex-1 flex items-center justify-center gap-2 h-12 rounded-xl border text-[13px] font-medium transition-colors ${
                isActive
                  ? "accent-active accent-active-bd"
                  : "border-line text-muted hover:border-line-3"
              }`}
            >
              <Icon size={15} /> {opt.label}
            </button>
          );
        })}
      </div>

      {/* Mono — orthogonal to light/dark. Strips accent + goes grayscale. */}
      <button
        onClick={() => setMono(!matte)}
        role="switch"
        aria-checked={matte}
        className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ${
          matte ? "accent-active accent-active-bd" : "border-line hover:border-line-3"
        }`}
      >
        <span className={`flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg ${matte ? "bg-ink text-surface" : "bg-surface-2 text-muted"}`}>
          <Contrast size={16} />
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block text-[13px] font-semibold ${matte ? "text-ink" : "text-ink-2"}`}>Mono</span>
          <span className="block text-[11.5px] text-muted leading-snug mt-0.5">
            Monochrome — strips accent color; pure black in dark, clean white/black in light.
          </span>
        </span>
        <span className={`flex-shrink-0 w-11 h-6 rounded-full relative transition-colors ${matte ? "bg-accent" : "bg-surface-3"}`}>
          <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${matte ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </span>
      </button>

      <div className="mt-7"><SectionLabel>Sidebar</SectionLabel></div>
      <p className="text-[12px] text-muted mb-3 mt-0.5">
        Cmd/Ctrl + B collapses the sidebar to the rail at any time. This decides whether a narrow window does it for you.
      </p>
      <button
        onClick={() => setNavAuto(!navAuto)}
        role="switch"
        aria-checked={navAuto}
        className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ${
          navAuto ? "accent-active accent-active-bd" : "border-line hover:border-line-3"
        }`}
      >
        <span className={`flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-lg ${navAuto ? "bg-ink text-surface" : "bg-surface-2 text-muted"}`}>
          <PanelLeftClose size={16} />
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block text-[13px] font-semibold ${navAuto ? "text-ink" : "text-ink-2"}`}>Collapse on narrow windows</span>
          <span className="block text-[11.5px] text-muted leading-snug mt-0.5">
            Below 1240px the sidebar becomes the rail on its own, and hands the width back to the screen. Turn this off to keep it exactly where you left it.
          </span>
        </span>
        <span className={`flex-shrink-0 w-11 h-6 rounded-full relative transition-colors ${navAuto ? "bg-accent" : "bg-surface-3"}`}>
          <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${navAuto ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </span>
      </button>
    </div>
  );
}

function SecretInput({
  label, value, onChange, showSecrets, onToggleSecrets,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  showSecrets: boolean;
  onToggleSecrets: () => void;
}) {
  return (
    <Field label={label}>
      <div className="relative">
        <input
          type={showSecrets ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inp}
          placeholder="•••••••• (leave blank to keep current)"
        />
        <button
          type="button"
          onClick={onToggleSecrets}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink-2 transition-colors"
        >
          {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Field>
  );
}

// Render WhatsApp *bold* markup faithfully; newlines handled by the pre-wrap container.
function waFormat(text: string): React.ReactNode {
  return text.split(/(\*[^*\n]+\*)/g).map((p, i) =>
    /^\*[^*\n]+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong> : <span key={i}>{p}</span>
  );
}

const WA_SAMPLE_LOTS = [
  { name: "Mixed Electronics Pallet", qty: 48, perUnit: "$25.00", total: "$1,200.00", pallets: "2", perPallet: "$600.00", cat: "Electronics" },
  { name: "Designer Sneakers Lot", qty: 120, perUnit: "$28.33", total: "$3,400.00", pallets: "5", perPallet: "$680.00", cat: "Shoes" },
];

function WhatsAppTab() {
  const [s, setS] = useState<WhatsappSettings>({ template: "", lot_format: "", footer: "", phone: "" });
  const [companyName, setCompanyName] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getWhatsappSettings().then((v) => { setS(v); setLoaded(true); }).catch(() => setLoaded(true));
    api.getCompanyInfo().then((c) => c && setCompanyName(c.name || "")).catch(() => {});
  }, []);

  const set = (k: keyof WhatsappSettings, v: string) => setS((prev) => ({ ...prev, [k]: v }));

  const save = async () => { await api.saveWhatsappSettings(s); };
  useAutosave(s, save, loaded);

  const templateRef = useRef<HTMLTextAreaElement>(null);
  const lotRef = useRef<HTMLTextAreaElement>(null);
  // Insert a variable at the cursor (or append) in the target textarea.
  const insertVar = (field: "template" | "lot_format", token: string) => {
    const el = field === "template" ? templateRef.current : lotRef.current;
    const cur = s[field] || "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    set(field, next);
    requestAnimationFrame(() => { el?.focus(); const p = start + token.length; el?.setSelectionRange(p, p); });
  };

  // Live preview — substitutes sample lots client-side (same logic as the backend).
  const sub = (str: string, map: Record<string, string>) =>
    Object.entries(map).reduce((acc, [k, v]) => acc.split(k).join(v), str);
  const lotList = WA_SAMPLE_LOTS.map((l, i) => sub(s.lot_format, {
    "{number}": String(i + 1), "{lot_name}": l.name, "{quantity}": String(l.qty), "{units}": String(l.qty),
    "{pallets}": l.pallets, "{price_per_unit}": l.perUnit, "{total_price}": l.total, "{asking_price}": l.total,
    "{price_per_pallet}": l.perPallet,
    "{price_text}": "Best offer", "{category}": l.cat,
  })).join("\n");
  const preview = sub(s.template, {
    "{business_name}": companyName || "Your Business",
    "{lot_list}": lotList,
    "{footer}": s.footer,
    "{phone}": s.phone,
  });

  const VarHint = ({ field, vars }: { field: "template" | "lot_format"; vars: string[] }) => (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      <span className="text-[11px] text-muted">Tap to insert:</span>
      {vars.map((v) => (
        <button key={v} type="button" onClick={() => insertVar(field, v)}
          className="font-mono text-[11px] text-ink-2 bg-surface-2 border border-line-2 hover:border-accent hover:text-accent px-1.5 py-0.5 rounded transition-colors">
          {v}
        </button>
      ))}
    </div>
  );

  const ta = "border border-line px-3 py-2.5 rounded-lg text-[13px] w-full font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y";

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-muted mb-5">
        Customize the message used when you share inventory to WhatsApp. The business name is pulled from your Company settings.
      </p>

      <Field label="Message Template">
        <textarea ref={templateRef} className={ta} rows={10} value={s.template} onChange={(e) => set("template", e.target.value)} spellCheck={false} />
      </Field>
      <VarHint field="template" vars={["{business_name}", "{lot_list}", "{footer}", "{phone}"]} />

      <div className="mt-5">
        <Field label="Lot Format (per item)">
          <textarea ref={lotRef} className={ta} rows={3} value={s.lot_format} onChange={(e) => set("lot_format", e.target.value)} spellCheck={false} />
        </Field>
        <VarHint field="lot_format" vars={["{number}", "{lot_name}", "{units}", "{price_per_unit}", "{price_per_pallet}", "{total_price}", "{pallets}", "{asking_price}", "{category}"]} />
      </div>

      <div className="grid grid-cols-2 gap-4 mt-5">
        <Field label="Footer Text">
          <input className={inp} value={s.footer} onChange={(e) => set("footer", e.target.value)} placeholder="Reply to claim or for more info" />
        </Field>
        <Field label="Business Phone">
          <input className={inp} value={s.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+1 555 123 4567" />
        </Field>
      </div>

      {/* Live preview */}
      <div className="mt-2 mb-6">
        <SectionLabel>Preview</SectionLabel>
        <p className="text-[12px] text-muted mt-1 mb-2.5">How it will appear in WhatsApp, with sample lots.</p>
        <div className="rounded-xl p-4" style={{ background: "var(--t-s3)" }}>
          <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-md px-3.5 py-2.5 shadow-sm"
            style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
            <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: "var(--t-tx1)" }}>
              {loaded ? waFormat(preview) : <span style={{ color: "var(--t-tx4)" }}>Loading…</span>}
            </div>
            <div className="flex items-center justify-end gap-1 mt-1.5 text-[10px]" style={{ color: "var(--t-tx4)" }}>
              <span>12:34 PM</span>
              <CheckCheck size={13} />
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// Inline connection-test result: idle → spinner → green ✓ / red message.
type TestState = { status: "idle" | "testing" | "ok" | "fail"; message?: string };

function StatusDot({ state }: { state: TestState }) {
  if (state.status === "testing") return <RefreshCw size={12} className="text-muted animate-spin" />;
  if (state.status === "ok") return <span className="w-2 h-2 rounded-full bg-success-ink" title="Connected" />;
  if (state.status === "fail") return <span className="w-2 h-2 rounded-full bg-danger-ink" title="Failed" />;
  return <span className="w-2 h-2 rounded-full bg-line-3" title="Untested" />;
}

function TestResultLine({ state }: { state: TestState }) {
  if (state.status === "ok") return <span className="inline-flex items-center gap-1 text-[12px] text-success-ink"><Check size={12} /> Connected {state.message ? `— ${state.message}` : ""}</span>;
  if (state.status === "fail") return <span className="inline-flex items-center gap-1 text-[12px] text-danger-ink"><AlertCircle size={12} /> Failed — {state.message || "could not connect"}</span>;
  if (state.status === "testing") return <span className="inline-flex items-center gap-1 text-[12px] text-muted"><RefreshCw size={12} className="animate-spin" /> Testing…</span>;
  return null;
}

// ── Calm settings-card scaffolding (shared, reused by the de-clutter pass) ──
// One clear card per thing: icon + title + one-line plain purpose, then body.
function SettingCard({ icon: Icon, title, purpose, aside, children }: {
  icon: typeof Mail; title: string; purpose: string; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-line rounded-2xl p-6">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-surface-2 text-ink-2 flex items-center justify-center flex-shrink-0 mt-0.5"><Icon size={17} /></span>
          <div>
            <div className="text-[15px] font-semibold text-ink">{title}</div>
            <div className="text-[12.5px] text-muted mt-0.5">{purpose}</div>
          </div>
        </div>
        {aside && <div className="flex-shrink-0">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

// Connected / not-connected pill (calm, reused).
function ConnectedPill({ ok, onLabel = "Connected", offLabel = "Not set up" }: { ok: boolean; onLabel?: string; offLabel?: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-success-ink bg-success-bg border border-success-ink/20 px-2.5 h-7 rounded-full"><Check size={13} /> {onLabel}</span>
    : <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-muted bg-surface-2 border border-line px-2.5 h-7 rounded-full"><span className="w-2 h-2 rounded-full bg-line-3" /> {offLabel}</span>;
}

// Cloud-sync health. Deliberately not ConnectedPill: having a token stored is not
// health — an expired one looks identical until the server rejects it, which is how
// a device can sit on a green pill for days syncing nothing. Green only when the
// server confirmed a pull/push recently; red when it rejected us.
function SyncPill({ auth, connected }: { auth?: string; connected?: boolean }) {
  if (auth === "auth_lost")
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-danger-ink bg-danger-bg border border-danger-ink/20 px-2.5 h-7 rounded-full">
        <AlertCircle size={13} /> Signed out — sign in again
      </span>
    );
  if (auth === "ok") return <ConnectedPill ok />;
  return <ConnectedPill ok={false} offLabel={connected ? "Not syncing" : "Not set up"} />;
}

// Last time the SERVER confirmed a pull or push — the only honest "is this working".
function lastSyncLabel(pullAt?: string, pushAt?: string) {
  const times = [pullAt, pushAt].filter(Boolean).map((s) => new Date(s!).getTime()).filter((n) => !isNaN(n));
  if (!times.length) return "Never";
  const mins = Math.floor((Date.now() - Math.max(...times)) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} days ago`;
}

// A quiet "Advanced" disclosure for technical/rare fields.
function Advanced({ label = "Advanced", children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink-2 transition-colors">
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} /> {label}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

// Email provider presets — auto-fill host/port so the user only enters
// email + app password. "Other" leaves the fields editable.
const EMAIL_PROVIDERS: Record<string, { label: string; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number }> = {
  gmail:   { label: "Gmail",   smtp_host: "smtp.gmail.com",       smtp_port: 587, imap_host: "imap.gmail.com",       imap_port: 993 },
  outlook: { label: "Outlook", smtp_host: "smtp-mail.outlook.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 },
  other:   { label: "Other",   smtp_host: "",                     smtp_port: 587, imap_host: "",                     imap_port: 993 },
};

function ProviderPicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  return (
    <div className="flex gap-2">
      {Object.entries(EMAIL_PROVIDERS).map(([id, p]) => (
        <button key={id} type="button" onClick={() => onPick(id)}
          className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${value === id ? "accent-active accent-active-bd" : "border-line text-muted hover:border-line-3"}`}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

// Detect the provider from a host (so a saved config shows the right preset).
function providerFromHost(host: string): string {
  if (host.includes("gmail")) return "gmail";
  if (host.includes("outlook") || host.includes("office365")) return "outlook";
  return "other";
}

// One monitored inbox row — status + Test + remove.
function InboxRow({ ib }: { ib: EmailInbox }) {
  const [st, setSt] = useState<TestState>({ status: "idle" });
  const [linking, setLinking] = useState(false);
  // The row's auth_method travels between devices with the shared inbox list, but
  // the Google grant does NOT - it lives in this device's keyring. So the badge asks
  // the backend whether THIS machine can actually open the mailbox, instead of
  // trusting a synced flag and claiming "signed in" on a device that has no token.
  const [google, setGoogle] = useState(false);
  const refreshLink = () => { api.inboxGoogleConnected(ib.id).then(setGoogle).catch(() => setGoogle(false)); };
  useEffect(refreshLink, [ib.id, ib.auth_method]);
  // Only Google mailboxes can use this. Offering it for Outlook or a generic IMAP
  // host would run a consent flow that cannot produce a working credential.
  const isGoogleHost = /gmail|googlemail|google/i.test(ib.host);
  const claimsGoogle = ib.auth_method === "oauth2";
  const test = async () => {
    setSt({ status: "testing" });
    try { const r = await api.testInboxConnection(ib.id); setSt({ status: r.ok ? "ok" : "fail", message: r.message }); }
    catch (e: any) { setSt({ status: "fail", message: String(e) }); }
  };
  // The mailbox's own owner signs in here — on this machine, as themselves. Their
  // refresh token is stored against this inbox; no password is created or shared.
  const connect = async () => {
    setLinking(true);
    setSt({ status: "idle" });
    try {
      await api.oauthStartConsentForInbox(ib.id);
      window.dispatchEvent(new CustomEvent("email-inboxes-changed"));
      refreshLink();
      await test();
    } catch (e: any) { setSt({ status: "fail", message: String(e) }); }
    finally { setLinking(false); refreshLink(); }
  };
  const remove = async () => { if (!confirm("Remove this inbox?")) return; await api.deleteEmailInbox(ib.id).catch(() => {}); window.dispatchEvent(new CustomEvent("email-inboxes-changed")); };
  return (
    <div className="border border-line rounded-xl px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <StatusDot state={st} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-medium text-ink truncate">{ib.label}</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${ib.scope === "me" ? "bg-surface-2 text-muted" : "bg-accent/12 text-accent"}`}>
                {ib.scope === "me" ? "Personal" : "Shared"}
              </span>
            </div>
            <div className="text-[11px] text-muted truncate">
              {ib.user}
              {google && <span className="text-accent"> · Signed in with Google</span>}
              {!google && claimsGoogle && <span className="text-warning-ink"> · Needs Google sign-in on this device</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isGoogleHost && (
            <button onClick={connect} disabled={linking}
              className="border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium disabled:opacity-50 transition-colors">
              {linking ? "Waiting for Google…" : google ? "Reconnect Google" : "Sign in with Google"}
            </button>
          )}
          <button onClick={test} disabled={st.status === "testing"}
            className="border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium disabled:opacity-50 transition-colors">Test</button>
          <button onClick={remove} className="text-faint hover:text-danger-ink p-1.5 rounded-lg hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
        </div>
      </div>
      {st.status !== "idle" && <div className="mt-2 pl-5"><TestResultLine state={st} /></div>}
    </div>
  );
}

// ── Card 1: Sending email (SMTP send-from + Google OAuth) ──
function SendingCard() {
  const [settings, setSettings] = useState<EmailSettings>({
    smtp_host: "smtp.gmail.com", smtp_port: 587, imap_host: "imap.gmail.com", imap_port: 993,
    user: "", auth_method: "password", from_email: "", from_invoices: "",
  });
  const [provider,   setProvider]   = useState("gmail");
  const [smtpPass,   setSmtpPass]   = useState("");
  const [imapPass,   setImapPass]   = useState("");
  const [oauthClientId,     setOauthClientId]     = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthConnecting,   setOauthConnecting]   = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [useGoogle,   setUseGoogle]   = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [smtpTest,    setSmtpTest]    = useState<TestState>({ status: "idle" });
  const [pushState,   setPushState]   = useState<TestState>({ status: "idle" });
  const [gStatus,     setGStatus]     = useState<{ connected: boolean; email: string; scopes: string } | null>(null);
  const [showGuide,   setShowGuide]   = useState(false);
  // Org-shared vs personal override + transfer.
  const [me,          setMe]          = useState<Me | null>(null);
  const [useOrg,      setUseOrg]      = useState(true);
  const [staff,       setStaff]       = useState<StaffMember[]>([]);
  const [transferTo,  setTransferTo]  = useState("");
  const [transferMsg, setTransferMsg] = useState<string | null>(null);
  const admin = isAdmin(me);
  // The scope this save writes to: personal override edits the "me" config; an
  // admin using the org default edits the shared org config.
  const scope: "org" | "me" = useOrg ? "org" : "me";

  const refreshGoogleStatus = () => api.googleEmailStatus().then(setGStatus).catch(() => setGStatus(null));
  useEffect(() => {
    api.getEmailSettings().then((s) => {
      if (!s) return;
      setSettings(s);
      setProvider(providerFromHost(s.smtp_host || ""));
      setUseGoogle(s.auth_method === "oauth2");
    }).catch(() => {});
    api.getEmailUseOrgDefault().then(setUseOrg).catch(() => {});
    api.employeeMe().then((m) => {
      setMe(m);
      if (isAdmin(m)) api.listStaff().then((rows) => setStaff(rows.filter((r) => r.status === "active"))).catch(() => {});
    }).catch(() => {});
    refreshGoogleStatus();
  }, []);

  const pickProvider = (id: string) => {
    setProvider(id);
    if (id !== "other") {
      const p = EMAIL_PROVIDERS[id];
      setSettings((s) => ({ ...s, smtp_host: p.smtp_host, smtp_port: p.smtp_port, imap_host: p.imap_host, imap_port: p.imap_port }));
    }
  };

  const authorize = async () => {
    setError(null); setOauthConnecting(true);
    try {
      if (oauthClientId) await api.saveCredential("oauth_client_id", oauthClientId);
      if (oauthClientSecret) await api.saveCredential("oauth_client_secret", oauthClientSecret);
      await api.saveEmailSettings({ ...settings, auth_method: "oauth2" }, scope);
      await api.oauthStartConsent(oauthClientId, oauthClientSecret);
      await refreshGoogleStatus();
    } catch (e: any) { setError(e.toString()); }
    finally { setOauthConnecting(false); }
  };

  const testSmtp = async () => {
    setSmtpTest({ status: "testing" });
    try { const r = await api.testSmtpConnection(); setSmtpTest({ status: r.ok ? "ok" : "fail", message: r.message }); }
    catch (e: any) { setSmtpTest({ status: "fail", message: String(e) }); }
  };

  // Push this device's working keychain login up to the server so mobile invoice
  // sends and the newsletter scheduler authenticate with the SAME password that
  // works here — no new Gmail app password needed.
  const pushLogin = async () => {
    setPushState({ status: "testing" });
    try {
      await api.pushEmailLoginToServer();
      setPushState({ status: "ok", message: "Server updated — mobile sends and newsletters now use this login." });
    } catch (e: any) {
      setPushState({ status: "fail", message: String(e) });
    }
  };

  const save = async () => {
    setError(null);
    try {
      const next = { ...settings, auth_method: (useGoogle ? "oauth2" : "password") as "password" | "oauth2" };
      // Persist this device's org-vs-personal choice, then write the config to the
      // matching scope. `saveEmailSettings(scope="org")` also shares the secrets to
      // the server so sibling admins inherit them.
      await api.setEmailUseOrgDefault(useOrg);
      // Write the secrets to the OS keychain FIRST. saveEmailSettings(scope="org")
      // shares them to the server by reading them back from the keychain, so the
      // keychain must already hold the freshly-typed password — otherwise the
      // server receives the PREVIOUS password (the cause of server-side 535 auth
      // failures on mobile invoice sends and the newsletter scheduler).
      if (!useGoogle) {
        await api.saveCredential("smtp_user", settings.user);
        if (smtpPass) await api.saveCredential("smtp_pass", smtpPass);
        if (imapPass) await api.saveCredential("imap_pass", imapPass);
      } else {
        if (oauthClientId) await api.saveCredential("oauth_client_id", oauthClientId);
        if (oauthClientSecret) await api.saveCredential("oauth_client_secret", oauthClientSecret);
      }
      await api.saveEmailSettings(next, scope);
      if (!useGoogle) {
        try {
          const company = await api.getCompanyInfo().catch(() => null);
          await api.pushDesktopSmtpToPi(company?.name || settings.user || "");
        } catch { /* ignore */ }
      }
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(e.toString()); }
  };

  const doTransfer = async () => {
    setTransferMsg(null);
    if (!transferTo) return;
    try {
      await api.transferOrgInbox(transferTo);
      const name = staff.find((s) => s.id === transferTo)?.display_name || "that admin";
      setTransferMsg(`Shared inbox transferred to ${name}.`);
      setTimeout(() => setTransferMsg(null), 3000);
    } catch (e: any) { setTransferMsg(String(e)); }
  };

  if (showGuide) return <GoogleCloudGuide onBack={() => { setShowGuide(false); refreshGoogleStatus(); }} />;

  const connected = useGoogle ? !!gStatus?.connected : (smtpTest.status === "ok");

  return (
    <SettingCard icon={Send} title="Sending email" purpose="Invoices, quotes, and newsletters go out from here."
      aside={<ConnectedPill ok={connected} />}>
      {/* Org-shared vs personal. The shared inbox is set up once and every admin
          inherits it automatically; an admin can opt this device onto its own. */}
      <div className="mb-4 rounded-xl border border-line bg-surface-2/40 p-3.5">
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${useOrg ? "bg-accent/12 text-accent" : "bg-surface-2 text-muted"}`}>
            {useOrg ? "Shared team inbox" : "My own inbox"}
          </span>
          {admin && (
            <label className="ml-auto flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
              <input type="checkbox" checked={!useOrg} onChange={(e) => setUseOrg(!e.target.checked)} className="accent-accent" />
              Use my own inbox on this device
            </label>
          )}
        </div>
        <p className="text-[11.5px] text-muted">
          {useOrg
            ? "Set up once — every admin inherits this send account and monitored inboxes automatically."
            : "This device sends from your own account instead of the shared team one. Other admins are unaffected."}
        </p>
      </div>

      <ProviderPicker value={provider} onPick={pickProvider} />

      <div className="mt-4 space-y-3">
        <Field label="Email address">
          <input className={inp} value={settings.user} onChange={(e) => setSettings({ ...settings, user: e.target.value })} placeholder="you@company.com" />
        </Field>

        {/* Toggle between an app password and the Google one-click path. */}
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none">
          <input type="checkbox" checked={useGoogle} onChange={(e) => setUseGoogle(e.target.checked)} className="accent-accent" />
          Use Connect Google instead of an app password
        </label>

        {!useGoogle ? (
          <SecretInput label="App password" value={smtpPass} onChange={setSmtpPass} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
        ) : (
          <div className="rounded-xl border border-line bg-surface-2/40 p-4">
            <div className="flex items-center gap-2 mb-1"><Cloud size={15} className="text-accent" /><span className="text-[13px] font-semibold text-ink">Connect Google</span>
              {gStatus?.connected && <span className="ml-auto text-[11.5px] font-medium text-success-ink inline-flex items-center gap-1"><Check size={12} /> {gStatus.email || "connected"}</span>}
            </div>
            <p className="text-[11.5px] text-muted mb-3">Connect Gmail without storing your password.</p>
            <SecretInput label="Google Client ID"     value={oauthClientId}     onChange={setOauthClientId}     showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
            <SecretInput label="Google Client Secret" value={oauthClientSecret} onChange={setOauthClientSecret} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={authorize} disabled={oauthConnecting || !oauthClientId || !oauthClientSecret}
                className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-2 transition-colors">
                {oauthConnecting ? <><RefreshCw size={13} className="animate-spin" /> Connecting…</> : gStatus?.connected ? <><RefreshCw size={13} /> Reconnect</> : <><Cloud size={13} /> Connect Google</>}
              </button>
              <button type="button" onClick={() => setShowGuide(true)} className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">Where do I get these? <ChevronRight size={13} /></button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Send from">
            <input className={inpSm} value={settings.from_email ?? ""} placeholder={settings.user || "sales@company.com"}
              onChange={(e) => setSettings({ ...settings, from_email: e.target.value })} />
          </Field>
          <Field label="Send invoices from">
            <input className={inpSm} value={settings.from_invoices ?? ""} placeholder={settings.from_email || settings.user || "invoices@company.com"}
              onChange={(e) => setSettings({ ...settings, from_invoices: e.target.value })} />
          </Field>
        </div>
        <p className="text-[11px] text-muted -mt-1">
          Leave either blank to send as {settings.user || "the account above"}. Quotes, newsletters and replies use the first;
          only invoices use the second. Gmail rewrites the From back to the login unless the address is verified under
          Send mail as (or is an alias) on that account — there is no error when it does.
        </p>

        <Advanced label="Advanced (mail server)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="SMTP host"><input className={inpSm} value={settings.smtp_host} onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })} /></Field>
            <Field label="SMTP port"><NumberInput integer className={inpSm} value={settings.smtp_port} onValue={(n) => setSettings({ ...settings, smtp_port: n || 587 })} /></Field>
          </div>
          <p className="text-[11px] text-muted mt-1">Credentials are stored in your OS keychain — never written to disk or synced.</p>
        </Advanced>
      </div>

      {error && <div className="text-danger-ink text-[12.5px] flex items-center gap-1.5 mt-3"><AlertCircle size={13} /> {error}</div>}

      <div className="flex items-center gap-2 flex-wrap mt-4">
        <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors">
          {saved ? <Check size={13} /> : <Save size={13} />} {saved ? "Saved" : "Save"}
        </button>
        <button onClick={testSmtp} disabled={smtpTest.status === "testing"}
          className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 hover:bg-surface-2 disabled:opacity-50 transition-colors">
          {smtpTest.status === "testing" ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} {smtpTest.status === "testing" ? "Testing…" : "Test"}
        </button>
        {!useGoogle && (
          <button onClick={pushLogin} disabled={pushState.status === "testing"}
            title="Push this device's working email login up to the server so mobile invoice sends and newsletters authenticate — no new app password needed."
            className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 hover:bg-surface-2 disabled:opacity-50 transition-colors">
            {pushState.status === "testing" ? <RefreshCw size={13} className="animate-spin" /> : <Cloud size={13} />} {pushState.status === "testing" ? "Pushing…" : "Push login to server"}
          </button>
        )}
      </div>
      {smtpTest.status !== "idle" && smtpTest.status !== "testing" && <div className="mt-2.5"><TestResultLine state={smtpTest} /></div>}
      {pushState.status !== "idle" && pushState.status !== "testing" && <div className="mt-2.5"><TestResultLine state={pushState} /></div>}

      {/* Transfer the shared inbox to a different email admin (admin-only, and only
          for the shared config). The new owner's device pulls the creds itself. */}
      {admin && useOrg && staff.length > 0 && (
        <div className="mt-5 pt-4 border-t border-line">
          <div className="text-[12px] font-medium text-ink-2 mb-1.5">Transfer shared inbox to another admin</div>
          <p className="text-[11.5px] text-muted mb-2.5">Hands the send + monitored inboxes to a different email admin. Credentials move with it — no re-typing.</p>
          <div className="flex items-center gap-2 flex-wrap">
            <select className={inpSm} value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
              <option value="">Choose an admin…</option>
              {staff.filter((s) => s.id !== (settings.owner_staff_id || "")).map((s) => (
                <option key={s.id} value={s.id}>{s.display_name} ({s.email})</option>
              ))}
            </select>
            <button onClick={doTransfer} disabled={!transferTo}
              className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-40 transition-colors">Transfer</button>
          </div>
          {transferMsg && <div className="mt-2 text-[12px] text-ink-2">{transferMsg}</div>}
        </div>
      )}
    </SettingCard>
  );
}

// ── Card 2: Inbox (unified monitored-inbox list) ──
function InboxCard() {
  const [inboxes, setInboxes] = useState<EmailInbox[]>([]);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("gmail");
  const [admin, setAdmin] = useState(false);
  const [form, setForm] = useState<{ label: string; host: string; port: number; user: string; password: string; scope: "org" | "me"; readFromNow: boolean }>(
    { label: "", host: "imap.gmail.com", port: 993, user: "", password: "", scope: "org", readFromNow: true }
  );
  const load = () => api.getEmailInboxes().then(setInboxes).catch(() => {});
  useEffect(() => {
    load();
    api.employeeMe().then((m) => {
      const a = isAdmin(m);
      setAdmin(a);
      // Non-admins can only add a personal inbox.
      if (!a) setForm((f) => ({ ...f, scope: "me" }));
    }).catch(() => {});
    const h = () => load();
    window.addEventListener("email-inboxes-changed", h);
    return () => window.removeEventListener("email-inboxes-changed", h);
  }, []);
  const pickProvider = (id: string) => {
    setProvider(id);
    if (id !== "other") { const p = EMAIL_PROVIDERS[id]; setForm((f) => ({ ...f, host: p.imap_host, port: p.imap_port })); }
  };
  const add = async () => {
    if (!form.host || !form.user) return;
    await api.saveEmailInbox({ label: form.label || form.user, host: form.host, port: Number(form.port) || 993, user: form.user, password: form.password, scope: form.scope, readFromNow: form.readFromNow }).catch(() => {});
    setForm({ label: "", host: "imap.gmail.com", port: 993, user: "", password: "", scope: admin ? "org" : "me", readFromNow: true });
    setProvider("gmail"); setAdding(false); load();
  };

  return (
    <SettingCard icon={Inbox} title="Inbox" purpose="Mail Ecliptr reads for replies and form submissions."
      aside={<ConnectedPill ok={inboxes.length > 0} />}>
      {inboxes.length > 0 && <div className="space-y-2 mb-3">{inboxes.map((ib) => <InboxRow key={ib.id} ib={ib} />)}</div>}

      {adding ? (
        <div className="border border-line rounded-xl p-4 space-y-3">
          <ProviderPicker value={provider} onPick={pickProvider} />
          {admin && (
            <div className="flex items-center gap-2 text-[12px] text-ink-2">
              <span className="text-muted">Share with:</span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="radio" name="inbox-scope" checked={form.scope === "org"} onChange={() => setForm({ ...form, scope: "org" })} className="accent-accent" />
                Whole team
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="radio" name="inbox-scope" checked={form.scope === "me"} onChange={() => setForm({ ...form, scope: "me" })} className="accent-accent" />
                Just me
              </label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input className={inpSm} placeholder="Label (e.g. Support)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            <input className={inpSm} placeholder="Email address" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
          </div>
          <input className={inpSm} type="password" placeholder="App password (or leave blank and sign in with Google after adding)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {/* Default ON. Off means importing the mailbox's whole history, and every
              imported message is dated today — which overwrites the real "last
              contact" on every client it matches, on desktop and phone. */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.readFromNow} onChange={(e) => setForm({ ...form, readFromNow: e.target.checked })} className="accent-accent mt-0.5" />
            <span className="text-[12px] text-ink-2">
              Read mail from now on
              <span className="block text-[11px] text-muted">Leave this on. Turning it off imports the whole mailbox and dates every old message as contact today.</span>
            </span>
          </label>
          <Advanced label="Advanced (mail server)">
            <div className="grid grid-cols-2 gap-3">
              <input className={inpSm} placeholder="IMAP host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <NumberInput className={inpSm} integer placeholder="Port" value={form.port} onValue={(n) => setForm({ ...form, port: n })} />
            </div>
          </Advanced>
          <div className="flex gap-2">
            <button onClick={add} disabled={!form.host || !form.user} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">Add inbox</button>
            <button onClick={() => setAdding(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5"><Plus size={14} /> Add inbox</button>
      )}
    </SettingCard>
  );
}

// The parsed-customer preview, matching the approved mock: avatar + name/title/
// company header, then contact rows, then category tags.
function CapturedCustomerCard({ c }: { c: CapturedCustomer }) {
  const displayName = c.name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "New customer";
  const initials = (c.name || c.first_name || c.email || "?").trim().slice(0, 2).toUpperCase();
  const location = [c.city, c.state, c.zip, c.country].filter(Boolean).join(", ");
  const rows: [string, string | null][] = [
    ["Email", c.email], ["Phone", c.phone], ["Location", location || null],
    ["Address", c.address], ["Tax ID", c.tax_id],
  ];
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 overflow-hidden">
      <div className="flex items-center gap-3 p-3.5 border-b border-line-2">
        <span className="w-10 h-10 rounded-full bg-accent/10 text-accent-hover flex items-center justify-center text-[14px] font-bold flex-shrink-0">{initials}</span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink truncate">{displayName}</div>
          <div className="text-[11.5px] text-muted truncate">{[c.title, c.company].filter(Boolean).join(" · ") || "—"}</div>
        </div>
      </div>
      <div className="px-3.5 py-2 divide-y divide-line-2">
        {rows.map(([label, val]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-[11px] text-muted">{label}</span>
            <span className={`text-[12.5px] tabular-nums truncate ${val ? "text-ink-2" : "text-faint"}`}>{val || "—"}</span>
          </div>
        ))}
      </div>
      {c.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-3.5 pt-1">
          {c.categories.map((cat) => (
            <span key={cat} className="text-[11px] font-medium text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full">{cat}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card 3: Capture form submissions (inbox-bound signup rule) ──
function CaptureCard() {
  const [inboxes, setInboxes] = useState<EmailInbox[]>([]);
  const [rules, setRules] = useState<SignupRule[]>([]);
  const [inboxId, setInboxId] = useState("");
  const [fromPat, setFromPat] = useState("");
  const [subjPat, setSubjPat] = useState("");
  const [preview, setPreview] = useState<FormCapturePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const load = () => {
    api.getEmailInboxes().then(setInboxes).catch(() => {});
    api.listSignupRules().then(setRules).catch(() => {});
  };
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener("email-inboxes-changed", h);
    return () => window.removeEventListener("email-inboxes-changed", h);
  }, []);

  // The rule bound to the selected inbox drives the on/off + fields. It's matched
  // by inbox LABEL — that's what the mail scanner records as an email's `source`
  // (previewFormCapture, by contrast, takes the inbox id).
  const inboxLabel = inboxes.find((i) => i.id === inboxId)?.label || "";
  const rule = rules.find((r) => r.inbox_source && r.inbox_source === inboxLabel) || null;
  useEffect(() => {
    if (rule) { setFromPat(rule.sender_pattern || ""); setSubjPat(rule.subject_pattern || ""); }
  }, [rule?.id]);
  useEffect(() => {
    if (!inboxId && inboxes.length) setInboxId(inboxes[0].id);
  }, [inboxes, inboxId]);

  const on = !!rule?.active;

  const runPreview = async () => {
    if (!inboxId) return;
    setPreviewing(true); setPreviewErr(null); setPreview(null);
    try {
      const r = await api.previewFormCapture(inboxId, fromPat || null, subjPat || null);
      setPreview(r);
      if (!r.found) setPreviewErr("No recent form email matched. Adjust the from/subject filters.");
    } catch (e: any) { setPreviewErr(String(e)); }
    finally { setPreviewing(false); }
  };

  const toggle = async () => {
    if (!inboxId) return;
    try {
      if (rule) {
        await api.toggleSignupRule(rule.id, !rule.active);
      } else {
        await api.createSignupRule({
          name: `Form capture — ${inboxes.find((i) => i.id === inboxId)?.label || "inbox"}`,
          sender_pattern: fromPat || null, subject_pattern: subjPat || null,
          inbox_source: inboxLabel, active: true,
        });
      }
      api.listSignupRules().then(setRules).catch(() => {});
    } catch { /* ignore */ }
  };

  const saveFilters = async () => {
    if (!rule) return;
    try {
      await api.updateSignupRule(rule.id, {
        name: rule.name, sender_pattern: fromPat || null, subject_pattern: subjPat || null,
        inbox_source: inboxLabel, active: rule.active,
      });
      api.listSignupRules().then(setRules).catch(() => {});
    } catch { /* ignore */ }
  };

  if (inboxes.length === 0) {
    return (
      <SettingCard icon={Wand2} title="Capture form submissions" purpose="Shopify contact-form emails become customers automatically.">
        <div className="text-[12.5px] text-muted bg-surface-2/50 border border-line-2 rounded-xl px-4 py-3">
          Add an inbox above first — that's the mailbox Ecliptr watches for form emails.
        </div>
      </SettingCard>
    );
  }

  return (
    <SettingCard icon={Wand2} title="Capture form submissions" purpose="Shopify contact-form emails become customers automatically."
      aside={
        <button onClick={toggle} role="switch" aria-checked={on}
          className={`w-11 h-6 rounded-full relative transition-colors ${on ? "bg-accent" : "bg-surface-3"}`}>
          <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </button>
      }>
      <div className="space-y-3">
        <Field label="Watch which inbox">
          <select value={inboxId} onChange={(e) => { setInboxId(e.target.value); setPreview(null); }}
            className={inp}>
            {inboxes.map((ib) => <option key={ib.id} value={ib.id}>{ib.label}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From contains">
            <input className={inpSm} value={fromPat} onChange={(e) => setFromPat(e.target.value)} placeholder="mailer@shopify.com" />
          </Field>
          <Field label="Subject contains">
            <input className={inpSm} value={subjPat} onChange={(e) => setSubjPat(e.target.value)} placeholder="New contact / order" />
          </Field>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={runPreview} disabled={previewing || !inboxId}
            className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 hover:bg-surface-2 disabled:opacity-50 transition-colors">
            {previewing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />} {previewing ? "Reading…" : "Preview"}
          </button>
          {rule && <button onClick={saveFilters} className="text-[12.5px] text-accent hover:text-accent-hover font-medium">Save filters</button>}
        </div>

        {previewErr && <div className="text-[12px] text-muted flex items-center gap-1.5"><AlertCircle size={13} className="text-danger-ink" /> {previewErr}</div>}
        {preview?.found && preview.customer && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted mb-2">Preview — what Ecliptr would create</div>
            <CapturedCustomerCard c={preview.customer} />
          </div>
        )}
      </div>
    </SettingCard>
  );
}

function EmailTab() {
  return (
    <div className="max-w-2xl space-y-4">
      <SendingCard />
      <PolicyClauseCard />
      <NewsletterTemplateCard />
      <InboxCard />
      <CaptureCard />
    </div>
  );
}

// The clause toggles (R-162). Module scope on purpose: declared inside PolicyClauseCard
// it was a NEW component type on every render, so React tore the button down and rebuilt
// it on each keystroke in either textarea — the knob never slid, it snapped, and the
// control flickered while typing.
//
// Colours are tokens, never literals, because two themes invert them. The knob was
// hardcoded `bg-white`: fine on orange, invisible on mono-dark's near-white accent, and
// invisible again OFF, where a white knob sits on a near-white track (`surface-3` is
// rgb(240,239,236) against a white card — a 1.05:1 track you cannot see). So the knob
// takes `on-accent`, the token that exists to stay legible on the accent fill, and a
// muted fill when off; the ring gives the pill an edge in every theme so an OFF switch
// still reads as a control rather than a smudge. `left-0` is load-bearing: a button
// centres its content, so an absolute knob with no left anchors to the track's MIDPOINT
// and translate-x-[22px] threw it clean off the right edge — ON rendered as a solid
// accent blob with no knob at all.
function ClauseSwitch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} role="switch" aria-checked={on} aria-label={label}
      className={`w-11 h-6 rounded-full relative flex-shrink-0 transition-colors ring-1 ${on ? "bg-accent ring-accent" : "bg-surface-3 ring-line-3"}`}>
      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full shadow-sm transition-transform ${on ? "bg-on-accent translate-x-[22px]" : "bg-faint translate-x-0.5"}`} />
    </button>
  );
}

// Wording saved with the switch off renders nowhere — by design, so a half-configured
// clause can never reach a buyer. But nothing said so, and the state is indistinguishable
// from a working one: the text is right there in the box. Both clauses sat filled-in and
// switched off, and every invoice went out without them. Say it out loud.
function OffWithText({ on, text }: { on: boolean; text: string }) {
  if (on || !text.trim()) return null;
  return (
    <p className="text-[11.5px] text-warning-ink bg-warning-bg border border-warning/30 rounded-lg px-2.5 py-1.5 mt-1.5">
      Saved, but the switch is off — this wording is not on any invoice, quote or email.
    </p>
  );
}

// Standing policy clauses that ride outbound documents (R-162). Both print at the foot
// of the document AND repeat in the send email, so a buyer who never opens the PDF has
// still been told. The 24-hour notice rides invoices and quotes; the return policy is an
// invoice-level term and what is set here is only the DEFAULT — each invoice's own copy
// is editable on the invoice form and frozen on the row once created, so re-editing this
// never restates an invoice already issued.
//
// Both ship empty. This wording is Jack's, not the app's; an enabled toggle with empty
// text renders nothing rather than putting invented legalese in front of a customer.
function PolicyClauseCard() {
  const [c, setC] = useState<PolicyClauseSettings>({
    notice_24h_enabled: false, notice_24h_text: "",
    return_policy_enabled: false, return_policy_text: "",
  });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getPolicyClauseSettings().then(setC).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true);
    try { await api.savePolicyClauseSettings(c); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };
  const ta = "w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink resize-y focus:outline-none focus:border-accent";
  const Switch = ClauseSwitch;
  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      <div>
        <SectionLabel>Policy clauses</SectionLabel>
        <p className="text-[13px] text-muted mt-1 leading-relaxed">
          Standing terms that print at the bottom of the document and repeat in the email body.
          Leave the text blank and nothing is added, whatever the toggle says.
        </p>
      </div>
      <div>
        <div className="flex items-center gap-3 mb-1.5">
          <span className="text-[12.5px] font-medium text-muted">24-hour notice</span>
          <Switch on={c.notice_24h_enabled} label="Include the 24-hour notice"
            onClick={() => setC({ ...c, notice_24h_enabled: !c.notice_24h_enabled })} />
          <span className="text-[11.5px] text-muted">Invoices and quotes</span>
        </div>
        <textarea value={c.notice_24h_text} onChange={(e) => setC({ ...c, notice_24h_text: e.target.value })}
          rows={3} className={ta} placeholder="Your 24-hour notification wording" />
        <OffWithText on={c.notice_24h_enabled} text={c.notice_24h_text} />
      </div>
      <div>
        <div className="flex items-center gap-3 mb-1.5">
          <span className="text-[12.5px] font-medium text-muted">Return policy</span>
          <Switch on={c.return_policy_enabled} label="Prefill the return policy on new invoices"
            onClick={() => setC({ ...c, return_policy_enabled: !c.return_policy_enabled })} />
          <span className="text-[11.5px] text-muted">Default for new invoices, editable per deal</span>
        </div>
        <textarea value={c.return_policy_text} onChange={(e) => setC({ ...c, return_policy_text: e.target.value })}
          rows={3} className={ta} placeholder="Your return policy wording" />
        <OffWithText on={c.return_policy_enabled} text={c.return_policy_text} />
      </div>
      <button onClick={save} disabled={busy} className="px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
        {saved ? "Saved" : busy ? "Saving…" : "Save clauses"}
      </button>
    </div>
  );
}

// Editable template behind Inventory → "Send to newsletter": intro + a per-product block
// + outro, with a live preview so it's ready-to-send.
function NewsletterTemplateCard() {
  const [t, setT] = useState<NewsletterProductTemplate>({ intro: "", outro: "", lot_format: "" });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getNewsletterProductTemplate().then(setT).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true);
    try { await api.saveNewsletterProductTemplate(t); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };
  const ta = "w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink resize-y focus:outline-none focus:border-accent";
  const preview = buildNewsletterBody(t, [
    { title: "Nike overstock — mixed sneakers", units: 250, pricePerUnit: "$4.50", price: "", link: "https://ecliptr.app/i/abc123?lot=lot_001" },
    { title: "Assorted apparel pallet", units: 40, pricePerUnit: "", price: "$1,200 for the lot", link: "https://ecliptr.app/i/abc123?lot=lot_002" },
  ]).replace(/\{first_name\}/g, "Alex");
  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      <div>
        <SectionLabel>Inventory newsletter</SectionLabel>
        <p className="text-[13px] text-muted mt-1 leading-relaxed">
          The template behind “Send to newsletter” in Inventory. Your selected products drop between the intro and outro.
          Per-product tokens: <code className="text-ink-2 text-[12px]">{"{title} {units} {price_per_unit} {price} {link}"}</code> — any line whose value is blank is removed automatically.
        </p>
      </div>
      <div>
        <div className="text-[12.5px] font-medium text-muted mb-1.5">Intro <span className="font-normal">(supports {"{first_name}"})</span></div>
        <textarea value={t.intro} onChange={(e) => setT({ ...t, intro: e.target.value })} rows={3} className={ta} />
      </div>
      <div>
        <div className="text-[12.5px] font-medium text-muted mb-1.5">Per-product block</div>
        <textarea value={t.lot_format} onChange={(e) => setT({ ...t, lot_format: e.target.value })} rows={6} className={ta + " font-mono"} />
      </div>
      <div>
        <div className="text-[12.5px] font-medium text-muted mb-1.5">Outro</div>
        <textarea value={t.outro} onChange={(e) => setT({ ...t, outro: e.target.value })} rows={3} className={ta} />
      </div>
      <div>
        <div className="text-[12.5px] font-medium text-muted mb-1.5">Preview (two sample products)</div>
        <pre className="bg-surface-2 border border-line rounded-lg px-3 py-2.5 text-[12px] text-ink-2 whitespace-pre-wrap max-h-72 overflow-y-auto">{preview}</pre>
      </div>
      <button onClick={save} disabled={busy} className="px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
        {saved ? "Saved" : busy ? "Saving…" : "Save template"}
      </button>
    </div>
  );
}

function WhatsAppFooterField() {
  const [footer, setFooter] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.getWhatsappFooter().then(setFooter).catch(() => {}); }, []);
  const save = async () => { await api.saveWhatsappFooter(footer); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div>
      <label className="block text-[12px] font-medium text-muted mb-1.5">WhatsApp Share Footer</label>
      <div className="flex gap-2">
        <input className={inp} value={footer} onChange={e => setFooter(e.target.value)} placeholder="💬 Reply to claim or for more info" />
        <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-10 rounded-lg text-[13px] font-medium flex-shrink-0">
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      <p className="text-[10px] text-muted mt-1">Appended to every WhatsApp share message.</p>
      <WhatsAppDescriptionField />
    </div>
  );
}

function WhatsAppDescriptionField() {
  const [desc, setDesc] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.getWhatsappDescription().then(setDesc).catch(() => {}); }, []);
  const save = async () => { await api.saveWhatsappDescription(desc); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div className="mt-3">
      <label className="block text-[12px] font-medium text-muted mb-1.5">WhatsApp Description</label>
      <textarea className={inp + " h-20 resize-none"} value={desc} onChange={e => setDesc(e.target.value)}
        placeholder="A description that preloads into your WhatsApp share message. Include key details about your inventory, business, or terms." />
      <div className="flex justify-between items-center mt-1.5">
        <p className="text-[10px] text-muted">Appears at the top of every WhatsApp share message before the lot listing.</p>
        <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium flex-shrink-0">
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

function CompanyTab() {
  const [info, setInfo] = useState<CompanyInfo>({ name: "", address: "", email: "", phone: "", tax_id: "" });
  const [orgName, setOrgName] = useState("");
  const [ready, setReady] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);

  useEffect(() => {
    Promise.all([
      api.getCompanyInfo().then((c) => c && setInfo(c)).catch(() => {}),
      api.getOrganizationName().then((n) => setOrgName(n || "")).catch(() => {}),
    ]).finally(() => setReady(true));
  }, []);

  const save = async () => {
    await api.saveCompanyInfo(info);
    await api.setOrganizationName(orgName);
  };
  useAutosave([info, orgName], save, ready);

  const pickLogo = async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selected === "string") {
      setLogoError(false);
      setLogoVersion((v) => v + 1);
      setInfo({ ...info, logo_path: selected });
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
    <SettingCard icon={Building2} title="Business details" purpose="Appears on every PDF invoice and across the app.">

      <Field label="Company Logo">
        <div className="flex items-center gap-4">
          {info.logo_path ? (
            <div className="relative group">
              <div className="h-20 w-32 border border-line rounded-xl bg-[repeating-conic-gradient(#f3f4f6_0%_25%,#ffffff_0%_50%)] bg-[length:14px_14px] flex items-center justify-center overflow-hidden p-2">
                <img
                  key={info.logo_path}
                  src={`${convertFileSrc(info.logo_path)}?t=${logoVersion}`}
                  alt="Logo preview"
                  className="max-h-full max-w-full object-contain"
                  onLoad={() => setLogoError(false)}
                  onError={() => setLogoError(true)}
                />
              </div>
              <button
                onClick={() => { setInfo({ ...info, logo_path: null }); setLogoError(false); }}
                className="absolute -top-2 -right-2 bg-danger text-white rounded-full p-1 shadow-sm hover:bg-danger transition-colors"
                title="Remove logo"
              >
                <X size={11} />
              </button>
            </div>
          ) : (
            <div className="h-20 w-32 border border-dashed border-line rounded-xl bg-surface-2 flex flex-col items-center justify-center gap-1 text-faint">
              <Image size={22} />
              <span className="text-[10px] text-muted">No logo</span>
            </div>
          )}
          <div className="space-y-1.5">
            <button
              onClick={pickLogo}
              className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-3.5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 transition-colors"
            >
              <Upload size={13} /> {info.logo_path ? "Change logo" : "Choose logo"}
            </button>
            {info.logo_path && !logoError && (
              <p className="text-[11px] text-success-ink flex items-center gap-1"><Check size={11} /> Logo selected</p>
            )}
            {logoError && (
              <p className="text-[11px] text-danger-ink flex items-center gap-1"><AlertCircle size={11} /> Couldn't load image</p>
            )}
            {!info.logo_path && <p className="text-[11px] text-muted">PNG or JPG · shown on invoices</p>}
          </div>
        </div>
        {info.logo_path && (
          <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-accent"
              checked={info.show_company_name !== false}
              onChange={(e) => setInfo({ ...info, show_company_name: e.target.checked })}
            />
            Also show company name text on invoices
            <span className="text-[11px] text-muted">(turn off if your logo already includes the name)</span>
          </label>
        )}
      </Field>

      <Field label="Company name">
        <input className={inp} value={info.name}    onChange={(e) => setInfo({ ...info, name: e.target.value })} />
      </Field>
      <Field label="Organization name (app header)">
        <input className={inp} value={orgName} placeholder={info.name || "Your organization"} onChange={(e) => setOrgName(e.target.value)} />
        <p className="text-[11px] text-muted mt-1">Shown next to the logo in the app, web, and mobile. Leave blank to use your company name.</p>
      </Field>
      <Field label="Address">
        <input className={inp} value={info.address} onChange={(e) => setInfo({ ...info, address: e.target.value })} />
      </Field>
      <Field label="Email">
        <input className={inp} value={info.email}   onChange={(e) => setInfo({ ...info, email: e.target.value })} />
      </Field>
      <Field label="Phone">
        <input className={inp} value={info.phone ?? ""} onChange={(e) => setInfo({ ...info, phone: e.target.value })} />
      </Field>
      <Field label="Tax ID / EIN">
        <input className={inp} value={info.tax_id ?? ""} onChange={(e) => setInfo({ ...info, tax_id: e.target.value })} />
      </Field>
    </SettingCard>

    <SettingCard icon={FileText} title="Share footer" purpose="The sign-off line appended when you share inventory over WhatsApp.">
      <WhatsAppFooterField />
    </SettingCard>
    </div>
  );
}

// ── Invoice branding studio ─────────────────────────────────────────────────
const TEMPLATE_DEFAULT: InvoiceTemplate = {
  logo_placement: "left",
  logo_size: "medium",
  show_company_name: true,
  show_address: true,
  show_email: true,
  show_phone: true,
  show_tax_id: true,
  accent_color: "#111827",
  title_label: "INVOICE",
  footer_note: "",
};

const ACCENT_PRESETS = ["#111827", "#FF6520", "#0F766E", "#7C3AED", "#B91C1C", "#B45309"];

// A small segmented control (reused for logo placement + size).
function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: typeof AlignLeft }[];
}) {
  return (
    <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-full">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {Icon && <Icon size={13} />} {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Shared branding studio for both invoices and quotes. `kind` swaps the template
// store (invoice_template vs quote_template), the sample-PDF renderer, the numbering
// section, and the copy — the layout and controls are identical, which is exactly what
// Jack asked for ("built out identical to invoice"). The logo lives in company_info and
// is shared by both documents.
function DocBrandingTab({ kind }: { kind: "invoice" | "quote" }) {
  const isQuote = kind === "quote";
  const noun = isQuote ? "quote" : "invoice";
  const defaultTitle = isQuote ? "QUOTE" : "INVOICE";
  const [info, setInfo] = useState<CompanyInfo>({ name: "", address: "", email: "", phone: "", tax_id: "" });
  const [tpl, setTpl] = useState<InvoiceTemplate>(isQuote ? { ...TEMPLATE_DEFAULT, title_label: "QUOTE" } : TEMPLATE_DEFAULT);
  const [ready, setReady] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getCompanyInfo().then((c) => { if (c) setInfo(c); }).catch(() => {}),
      (isQuote ? api.getQuoteTemplate() : api.getInvoiceTemplate()).then((t) => { if (t) setTpl(t); }).catch(() => {}),
    ]).finally(() => setReady(true));
  }, [isQuote]);

  // Two independent stores: the logo lives in company_info, everything else in
  // the template. Both autosave through the shared SaveStatus pill.
  useAutosave(info, () => api.saveCompanyInfo(info), ready);
  useAutosave(tpl, () => (isQuote ? api.saveQuoteTemplate(tpl) : api.saveInvoiceTemplate(tpl)), ready);

  const setT = (patch: Partial<InvoiceTemplate>) => setTpl((t) => ({ ...t, ...patch }));

  const pickLogo = async () => {
    const selected = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
    if (typeof selected === "string") {
      setLogoError(false);
      setLogoVersion((v) => v + 1);
      setInfo({ ...info, logo_path: selected });
    }
  };

  const viewPdf = async () => {
    setRendering(true);
    // The backend renders the sample, opens it in the OS viewer, and returns
    // its path (same mechanism as invoice preview) — we just await it.
    try { await (isQuote ? api.renderSampleQuotePdf() : api.renderSampleInvoicePdf()); }
    catch (e: any) { toast(String(e), "error"); }
    finally { setRendering(false); }
  };

  const Check2 = ({ label, k }: { label: string; k: keyof InvoiceTemplate }) => (
    <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none">
      <input type="checkbox" className="accent-accent" checked={!!tpl[k]} onChange={(e) => setT({ [k]: e.target.checked } as any)} />
      {label}
    </label>
  );

  return (
    <div className="flex flex-col lg:flex-row gap-5 items-start">
      {/* Controls */}
      <div className="w-full lg:w-[380px] lg:flex-shrink-0 space-y-4">
        <SettingCard icon={Hash} title="Numbering" purpose={`How new ${noun} numbers are generated. Numbers stay unique across your devices.`}>
          {isQuote ? <QuoteNumberingSection /> : <InvoiceNumberingSection />}
        </SettingCard>
        <SettingCard icon={Image} title="Logo" purpose={`Shown at the top of every ${noun}.`}>
          <div className="flex items-center gap-4">
            {info.logo_path ? (
              <div className="relative group">
                <div className="h-20 w-32 border border-line rounded-xl bg-[repeating-conic-gradient(#f3f4f6_0%_25%,#ffffff_0%_50%)] bg-[length:14px_14px] flex items-center justify-center overflow-hidden p-2">
                  <img key={info.logo_path} src={`${convertFileSrc(info.logo_path)}?t=${logoVersion}`} alt="Logo preview"
                    className="max-h-full max-w-full object-contain"
                    onLoad={() => setLogoError(false)} onError={() => setLogoError(true)} />
                </div>
                <button onClick={() => { setInfo({ ...info, logo_path: null }); setLogoError(false); }}
                  className="absolute -top-2 -right-2 bg-danger text-white rounded-full p-1 shadow-sm transition-colors" title="Remove logo">
                  <X size={11} />
                </button>
              </div>
            ) : (
              <div className="h-20 w-32 border border-dashed border-line rounded-xl bg-surface-2 flex flex-col items-center justify-center gap-1 text-faint">
                <Image size={22} />
                <span className="text-[10px] text-muted">No logo</span>
              </div>
            )}
            <div className="space-y-1.5">
              <button onClick={pickLogo}
                className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-3.5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 transition-colors">
                <Upload size={13} /> {info.logo_path ? "Change logo" : "Choose logo"}
              </button>
              {logoError && <p className="text-[11px] text-danger-ink flex items-center gap-1"><AlertCircle size={11} /> Couldn't load image</p>}
              {!info.logo_path && <p className="text-[11px] text-muted">PNG or JPG</p>}
            </div>
          </div>

          <label className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none">
            <input type="checkbox" className="accent-accent" checked={tpl.show_company_name}
              onChange={(e) => setT({ show_company_name: e.target.checked })} />
            Show company name on {noun}s
            <span className="text-[11px] text-muted">(off if your logo has it)</span>
          </label>

          <div className="mt-4 space-y-3">
            <Field label="Placement">
              <Segmented value={tpl.logo_placement} onChange={(v) => setT({ logo_placement: v })}
                options={[
                  { value: "left", label: "Left", icon: AlignLeft },
                  { value: "center", label: "Center", icon: AlignCenter },
                  { value: "right", label: "Right", icon: AlignRight },
                ]} />
            </Field>
            <Field label="Size">
              <Segmented value={tpl.logo_size} onChange={(v) => setT({ logo_size: v })}
                options={[
                  { value: "small", label: "Small" },
                  { value: "medium", label: "Medium" },
                  { value: "large", label: "Large" },
                ]} />
            </Field>
          </div>
        </SettingCard>

        <SettingCard icon={Palette} title="Brand accent" purpose="Colors the title, divider, table header, and total.">
          <div className="flex items-center gap-3">
            <input type="color" value={tpl.accent_color} onChange={(e) => setT({ accent_color: e.target.value })}
              className="w-11 h-9 rounded-lg border border-line bg-surface cursor-pointer p-0.5" title="Pick a color" />
            <input value={tpl.accent_color} onChange={(e) => setT({ accent_color: e.target.value })}
              className={`${inpSm} font-mono w-32`} placeholder="#111827" />
            <div className="flex items-center gap-1.5 flex-wrap">
              {ACCENT_PRESETS.map((c) => (
                <button key={c} onClick={() => setT({ accent_color: c })} title={c}
                  className={`w-6 h-6 rounded-full border transition-transform hover:scale-110 ${tpl.accent_color.toLowerCase() === c.toLowerCase() ? "border-ink ring-2 ring-accent/30" : "border-line"}`}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
        </SettingCard>

        <SettingCard icon={FileText} title="Details & text" purpose={`What appears on the ${noun}.`}>
          <div className="space-y-2.5 mb-4">
            <div className="text-[12.5px] font-medium text-muted">Show on {noun}</div>
            <div className="grid grid-cols-2 gap-2">
              <Check2 label="Address" k="show_address" />
              <Check2 label="Email" k="show_email" />
              <Check2 label="Phone" k="show_phone" />
              <Check2 label="Tax ID" k="show_tax_id" />
            </div>
          </div>
          <Field label="Title label">
            <input className={inpSm} value={tpl.title_label} placeholder={defaultTitle}
              onChange={(e) => setT({ title_label: e.target.value })} />
          </Field>
          <Field label="Footer note">
            <textarea rows={2} className="border border-line px-3 py-2 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              value={tpl.footer_note} placeholder="Payment terms, thank-you note…"
              onChange={(e) => setT({ footer_note: e.target.value })} />
          </Field>
        </SettingCard>
      </div>

      {/* Live preview */}
      <div className="w-full lg:flex-1 lg:sticky lg:top-4">
        <div className="flex items-center justify-between mb-2.5">
          <div className="text-[12.5px] font-medium text-muted">Live preview</div>
          <button onClick={viewPdf} disabled={rendering}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg text-[12px] font-medium disabled:opacity-50 transition-colors">
            {rendering ? <RefreshCw size={13} className="animate-spin" /> : <ExternalLink size={13} />} View actual PDF
          </button>
        </div>
        <InvoicePreview info={info} tpl={tpl} logoVersion={logoVersion} kind={kind} />
        <p className="text-[11px] text-muted mt-2 text-center">A close approximation — the PDF is the ground truth.</p>
      </div>
    </div>
  );
}

function AiTab() {
  const [models,  setModels]  = useState<OllamaModel[]>([]);
  const [selected,setSelected]= useState("");
  const [online,  setOnline]  = useState<boolean | null>(null);
  const [saved,   setSaved]   = useState(false);

  useEffect(() => {
    api.aiHealthCheck().then(setOnline);
    api.aiListModels().then(setModels).catch(() => {});
  }, []);

  const save = async () => {
    if (!selected) return;
    await api.aiSetModel(selected);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-2xl">
      <SettingCard icon={Bot} title="Local AI" purpose="A local Ollama model reads emails and drafts text — nothing leaves your machine."
        aside={online !== null ? <ConnectedPill ok={online} onLabel="Online" offLabel="Offline" /> : undefined}>
        {online === false && (
          <div className="text-[12.5px] text-muted bg-surface-2/50 border border-line-2 rounded-xl px-4 py-3 mb-4">
            Ollama isn't running — start it with <code className="bg-surface-3 px-1.5 py-0.5 rounded-md text-[12px]">ollama serve</code>, then reopen this section.
          </div>
        )}

        <Field label="Active model">
          <select
            className={inp}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">— pick a model —</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.size ? ` (${(m.size / 1e9).toFixed(1)} GB)` : ""}
              </option>
            ))}
          </select>
        </Field>

        <button
          onClick={save}
          disabled={!selected}
          className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors flex items-center gap-2"
        >
          {saved ? <Check size={13} /> : null} {saved ? "Saved" : "Set active model"}
        </button>

        <Advanced label="Model suggestions">
          <p className="text-[12px] text-muted">
            <code className="bg-surface-3 px-1 rounded">llama3.1:8b</code> works well for general use;{" "}
            <code className="bg-surface-3 px-1 rounded">qwen2.5:14b</code> extracts customer details more accurately.
            Download one with <code className="bg-surface-3 px-1.5 py-0.5 rounded">ollama pull &lt;model&gt;</code>.
          </p>
        </Advanced>
      </SettingCard>
    </div>
  );
}

function SyncTab() {
  const [status,           setStatus]           = useState<{ events_applied: number; last_applied: string | null } | null>(null);
  const [replaying,        setReplaying]        = useState(false);
  const [encrypted,        setEncrypted]        = useState<boolean | null>(null);
  const [passphrase,       setPassphrase]       = useState("");
  const [settingPassphrase,setSettingPassphrase]= useState(false);
  const [encryptError,     setEncryptError]     = useState<string | null>(null);
  // Cloud network sync (Phase 2)
  const [net,   setNet]   = useState<Awaited<ReturnType<typeof api.netsyncStatus>> | null>(null);
  const [nUrl,  setNUrl]  = useState("https://ecliptr.app");
  const [nEmail,setNEmail]= useState("");
  const [nPass, setNPass] = useState("");
  const [nBusy, setNBusy] = useState(false);
  const [nErr,  setNErr]  = useState<string | null>(null);
  const [nMsg,  setNMsg]  = useState<string | null>(null);
  const [diag,  setDiag]  = useState<Awaited<ReturnType<typeof api.netsyncDiagnostics>> | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  const refresh       = () => api.syncStatus().then(setStatus);
  const checkEncrypted= () => api.syncIsEncrypted().then(setEncrypted).catch(() => {});
  const refreshNet    = () => api.netsyncStatus().then(setNet).catch(() => {});
  useEffect(() => { refresh(); checkEncrypted(); refreshNet(); }, []);

  const connectNet = async () => {
    setNBusy(true); setNErr(null); setNMsg(null);
    try {
      await api.netsyncConnect(nUrl.trim(), nEmail.trim(), nPass);
      setNPass(""); setNMsg("Connected — your workspace is syncing.");
      await refreshNet();
    } catch (e: any) { setNErr(e.toString()); }
    finally { setNBusy(false); }
  };
  const disconnectNet = async () => {
    if (!confirm("Disconnect this desktop from cloud sync?")) return;
    setNBusy(true);
    try { await api.netsyncDisconnect(); setNMsg(null); await refreshNet(); }
    finally { setNBusy(false); }
  };
  const syncNow = async () => {
    setNBusy(true); setNErr(null); setNMsg(null);
    try {
      const r = await api.netsyncSyncNow();
      setNMsg(`Pushed ${r.pushed}, pulled ${r.pulled}.`);
      await refreshNet();
    } catch (e: any) { setNErr(e.toString()); }
    finally { setNBusy(false); }
  };

  const repairSync = async () => {
    setNBusy(true); setNErr(null);
    setNMsg("Re-pulling your full workspace from the server — this can take a minute…");
    try {
      const r = await api.netsyncRepair();
      setNMsg(`Repair complete — re-applied ${r.reapplied} records from the server. If anything was missing, it's back now.`);
      await refreshNet();
    } catch (e: any) { setNErr(e.toString()); }
    finally { setNBusy(false); }
  };

  const repairSyncHard = async () => {
    if (!confirm("Deep repair rebuilds this device's data from the server. Nothing on the server is touched and no data is lost — it just re-applies your full history. Use this if clients or deals are still missing after Repair sync. Continue?")) return;
    setNBusy(true); setNErr(null);
    setNMsg("Deep repair: rebuilding from the server. This re-applies your full history and can take a minute or two — keep the app open…");
    try {
      const r = await api.netsyncRepairHard();
      setNMsg(`Deep repair complete — re-applied ${r.reapplied} records from the server. Anything that was stuck is back now.`);
      await refreshNet();
    } catch (e: any) { setNErr(e.toString()); }
    finally { setNBusy(false); }
  };

  const restoreFromServer = async () => {
    if (!confirm("Make this device match the server exactly. Your unsynced local changes are pushed to the server FIRST so nothing you've entered here is lost; then any leftover rows that no longer exist on the server are removed from this device. This is the surest fix when clients or deals are still missing after Repair and Deep repair. Continue?")) return;
    setNBusy(true); setNErr(null);
    setNMsg("Restoring from the server — cloning your current workspace onto this device…");
    try {
      const r = await api.netsyncRestoreSnapshot();
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      const nonZero = Object.entries(r).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`);
      setNMsg(`Restore complete — wrote ${total} records from the server${nonZero.length ? ` (${nonZero.join(", ")})` : ""}. Anything that was missing is back now.`);
      await refreshNet();
      if (diag) await refreshDiag();
    } catch (e: any) { setNErr(e.toString()); }
    finally { setNBusy(false); }
  };

  const refreshDiag = async () => {
    setDiagBusy(true);
    try { setDiag(await api.netsyncDiagnostics()); }
    catch (e: any) { setNErr(e.toString()); }
    finally { setDiagBusy(false); }
  };

  const replay = async () => {
    setReplaying(true);
    try { await api.syncReplay(); await refresh(); }
    finally { setReplaying(false); }
  };

  const handleSetPassphrase = async () => {
    if (!passphrase.trim()) return;
    setSettingPassphrase(true);
    setEncryptError(null);
    try {
      await api.syncSetPassphrase(passphrase);
      setPassphrase("");
      setEncrypted(true);
    } catch (e: any) {
      setEncryptError(e.toString());
    } finally {
      setSettingPassphrase(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      {/* Cloud sync — the main thing on this page */}
      <SettingCard icon={Cloud} title="Cloud sync" purpose="Keeps this desktop in step with your Ecliptr workspace."
        aside={<SyncPill auth={net?.auth} connected={net?.connected} />}>
        {net?.connected ? (
          <div className="space-y-3">
            {net.auth === "auth_lost" && (
              <div className="rounded-xl border border-danger-ink/20 bg-danger-bg px-4 py-3 text-[12.5px] text-danger-ink flex items-start gap-2">
                <AlertCircle size={14} className="shrink-0 mt-px" />
                <span>This device is signed out, so nothing is syncing. Sign out and back in to reconnect — your unsynced changes are kept and upload once you do.</span>
              </div>
            )}
            {net.invariants.length > 0 && (
              <div className="text-[12.5px] text-warning-ink bg-warning-bg border border-warning rounded-xl px-4 py-3 flex items-start gap-2">
                <AlertCircle size={14} className="mt-px shrink-0" />
                <div className="space-y-1">
                  {net.invariants.map((f, i) => <p key={i}>{f}</p>)}
                </div>
              </div>
            )}
            <div className="rounded-xl border border-line bg-surface-2/40 px-4 divide-y divide-line-2">
              <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <span className="text-muted">Server</span>
                <span className="text-ink truncate">{net.url}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <span className="text-muted">Last synced</span>
                <span className={`tabular-nums ${net.auth === "ok" ? "text-ink" : "text-danger-ink"}`}>
                  {lastSyncLabel(net.last_pull_at, net.last_push_at)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                <span className="text-muted">Waiting to upload</span>
                <span className="text-ink tabular-nums">{net.pending_push}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={syncNow}
                disabled={nBusy}
                className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                {nBusy && <RefreshCw size={13} className="animate-spin" />} {nBusy ? "Syncing…" : "Sync now"}
              </button>
              <button
                onClick={repairSync}
                disabled={nBusy}
                title="Missing clients or deals on this device? Re-pull your entire workspace from the server. Nothing local is lost."
                className="border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50"
              >
                Repair sync
              </button>
              <button
                onClick={disconnectNet}
                disabled={nBusy}
                className="border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
            <p className="text-[12px] text-muted">
              Still missing clients or deals after Repair sync?{" "}
              <button
                onClick={repairSyncHard}
                disabled={nBusy}
                title="Rebuilds this device from the server by re-applying your full history. Nothing on the server changes and no data is lost."
                className="text-accent hover:underline font-medium disabled:opacity-50"
              >
                Run Deep repair
              </button>
              , or{" "}
              <button
                onClick={restoreFromServer}
                disabled={nBusy}
                title="Copies the server's current data straight onto this device — the surest fix when clients or deals are still missing after Repair and Deep repair."
                className="text-accent hover:underline font-medium disabled:opacity-50"
              >
                Restore from server
              </button>{" "}
              to clone the server's current data directly.
            </p>
            {nMsg && <p className="text-[12px] text-muted">{nMsg}</p>}
            {nErr && (
              <div className="text-danger-ink text-[12.5px] flex items-center gap-1.5">
                <AlertCircle size={13} /> {nErr}
              </div>
            )}
            <Advanced>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted">Pull position</span>
                <span className="font-mono text-ink-2 tabular-nums">{net.pull_cursor}</span>
              </div>
              <div className="mt-3 pt-3 border-t border-line-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-muted">Diagnostics</span>
                  <button
                    onClick={refreshDiag}
                    disabled={diagBusy}
                    className="border border-line hover:bg-surface-2 text-ink-2 px-3 h-7 rounded-md text-[12px] font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {diagBusy && <RefreshCw size={11} className="animate-spin" />}
                    {diag ? "Refresh" : "Run diagnostics"}
                  </button>
                </div>
                {diag && (
                  <div className="mt-2.5 space-y-2.5 text-[12px]">
                    <div className="rounded-lg border border-line bg-surface-2/40 px-3 divide-y divide-line-2">
                      <div className="flex items-center justify-between gap-3 py-1.5">
                        <span className="text-muted">App version</span>
                        <span className="text-ink-2 tabular-nums">{diag.version}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-1.5">
                        <span className="text-muted">Signed in as</span>
                        <span className="text-ink-2 truncate">{diag.connected ? (diag.email || "—") : "not connected"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-1.5">
                        <span className="text-muted">Workspace</span>
                        <span className="text-ink-2 truncate">{diag.org || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 py-1.5">
                        <span className="text-muted">Pull position</span>
                        <span className="font-mono text-ink-2 tabular-nums">{diag.pull_cursor}</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-muted mb-1">Records on this device vs. the server</div>
                      <div className="rounded-lg border border-line bg-surface-2/40 overflow-hidden">
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="text-muted border-b border-line-2">
                              <th className="text-left font-medium px-3 py-1.5">Table</th>
                              <th className="text-right font-medium px-3 py-1.5">Here</th>
                              <th className="text-right font-medium px-3 py-1.5">Server</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line-2">
                            {Object.keys(diag.local_counts).sort().map((t) => {
                              const local = diag.local_counts[t] ?? 0;
                              const server = diag.server_counts ? (diag.server_counts[t] ?? 0) : null;
                              const behind = server !== null && local < server;
                              if (local === 0 && (server === null || server === 0)) return null;
                              return (
                                <tr key={t} className={behind ? "text-danger-ink" : ""}>
                                  <td className="px-3 py-1.5">{t}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{local}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums">{server === null ? "—" : server}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {diag.server_counts === null && (
                        <p className="text-muted mt-1">Server counts unavailable — offline or the session expired.</p>
                      )}
                      {diag.server_counts !== null && Object.keys(diag.local_counts).some((t) => (diag.local_counts[t] ?? 0) < (diag.server_counts?.[t] ?? 0)) && (
                        <p className="text-danger-ink mt-1.5">Rows in red are behind the server — try Restore from server above.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Advanced>
          </div>
        ) : (
          <div>
            <p className="text-[12.5px] text-muted mb-4">
              Sign in with your team account to sync over the internet — no shared folder needed.
            </p>
            <div className="space-y-3 max-w-sm">
              <Field label="Email">
                <input
                  value={nEmail}
                  onChange={(e) => setNEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoComplete="username"
                  className={inp}
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={nPass}
                  onChange={(e) => setNPass(e.target.value)}
                  autoComplete="current-password"
                  onKeyDown={(e) => { if (e.key === "Enter") connectNet(); }}
                  className={inp}
                />
              </Field>
              <button
                onClick={connectNet}
                disabled={nBusy || !nUrl.trim() || !nEmail.trim() || !nPass}
                className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                {nBusy && <RefreshCw size={13} className="animate-spin" />} {nBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
            {nErr && (
              <div className="text-danger-ink text-[12.5px] mt-3 flex items-center gap-1.5">
                <AlertCircle size={13} /> {nErr}
              </div>
            )}
            <Advanced label="Advanced (server)">
              <Field label="Server URL">
                <input
                  value={nUrl}
                  onChange={(e) => setNUrl(e.target.value)}
                  placeholder="https://ecliptr.app"
                  className={inpSm}
                />
              </Field>
            </Advanced>
          </div>
        )}
      </SettingCard>

      {/* Updates */}
      <SettingCard icon={Download} title="App updates" purpose="Get the latest version of Ecliptr.">
        <UpdateButton />
      </SettingCard>

      {/* Encryption */}
      <SettingCard icon={Lock} title="Encryption" purpose="Protect synced data with a passphrase only your devices know."
        aside={encrypted !== null ? <ConnectedPill ok={encrypted} onLabel="Encrypted" offLabel="Not encrypted" /> : undefined}>
        {encrypted === null ? (
          <div className="h-9 w-48 bg-surface-2 rounded-lg animate-pulse" />
        ) : encrypted ? (
          <p className="text-[12.5px] text-muted">Sync events are encrypted at rest on every device.</p>
        ) : (
          <div>
            <p className="text-[12.5px] text-muted mb-3">
              Pick a passphrase and enter the same one on every device. Once set, sync files are unreadable without it.
            </p>
            <div className="flex gap-2 max-w-sm">
              <input
                type="password"
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={`${inp} flex-1`}
              />
              <button
                onClick={handleSetPassphrase}
                disabled={settingPassphrase || !passphrase.trim()}
                className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {settingPassphrase ? "Setting…" : "Enable"}
              </button>
            </div>
            {encryptError && (
              <div className="text-danger-ink text-[12.5px] mt-2 flex items-center gap-1.5">
                <AlertCircle size={13} /> {encryptError}
              </div>
            )}
            <Advanced label="How it's encrypted">
              <p className="text-[12px] text-muted">
                Sync event files are encrypted with ChaCha20-Poly1305. The passphrase never leaves your device.
              </p>
            </Advanced>
          </div>
        )}
      </SettingCard>

      {/* Local event log — status + technical tools */}
      <SettingCard icon={RefreshCw} title="Sync activity" purpose="What this device has applied from the shared event log.">
        <div className="rounded-xl border border-line bg-surface-2/40 px-4 divide-y divide-line-2">
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
            <span className="text-muted">Events applied</span>
            <span className="text-ink tabular-nums">{status?.events_applied ?? 0}</span>
          </div>
          <div className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
            <span className="text-muted">Last applied</span>
            <span className="text-ink tabular-nums">
              {status?.last_applied ? new Date(status.last_applied).toLocaleString() : "—"}
            </span>
          </div>
        </div>
        <Advanced label="Advanced (event log)">
          <button
            onClick={replay}
            disabled={replaying}
            className="border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {replaying && <RefreshCw size={13} className="animate-spin" />} {replaying ? "Replaying…" : "Replay all events"}
          </button>
          <p className="text-[12px] text-muted mt-3 mb-2">
            Ecliptr keeps an append-only event log with Hybrid Logical Clocks. Every write produces a JSON event in:
          </p>
          <code className="block bg-surface-2 border border-line px-4 py-3 rounded-xl text-[11px] font-mono text-muted">
            ~/Library/Application Support/com.bjmdistributions.clienthub/sync/ (macOS)<br />
            %APPDATA%\com.bjmdistributions.clienthub\sync\ (Windows)
          </code>
          <p className="text-[12px] text-muted mt-2">
            Point Syncthing or another file-sync tool at this folder. Merging is conflict-free,
            handled per-column with last-write-wins.
          </p>
        </Advanced>
      </SettingCard>
    </div>
  );
}

function ImportTab() {
  const [subTab, setSubTab] = useState<"csv" | "contacts">("csv");
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
          {([["csv", "From CSV"], ["contacts", "From Google Contacts"]] as const).map(([t, label]) => (
            <button key={t} onClick={() => setSubTab(t)}
              className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${subTab === t ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
        <GuideLink section="import" />
      </div>
      {subTab === "csv" ? <CsvImportSection /> : <GoogleContactsSection />}
    </div>
  );
}

function CsvImportSection() {
  const [path,      setPath]      = useState<string | null>(null);
  const [preview,   setPreview]   = useState<CsvPreview | null>(null);
  const [mapping,   setMapping]   = useState<Record<string, string>>({});
  const [metaKeys,  setMetaKeys]  = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [summary,   setSummary]   = useState<ImportSummary | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => { api.getIntakeFields().then((fs) => setCustomFields(fs.filter((f) => f.value.startsWith("cf:")))).catch(() => {}); }, []);

  const CORE_FIELDS = [
    { key: "first_name", label: "First name *" },
    { key: "last_name",  label: "Last name" },
    { key: "email",      label: "Email" },
    { key: "phone",      label: "Phone" },
    { key: "company",    label: "Company" },
    { key: "notes",      label: "Notes" },
    { key: "street_address", label: "Street address" },
    { key: "city",       label: "City" },
    { key: "state",      label: "State" },
    { key: "zip_code",   label: "Zip code" },
    { key: "category",   label: "Category" },
    { key: "lead_status", label: "Lead status" },
  ];

  const pickFile = async () => {
    setError(null);
    setSummary(null);
    const selected = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof selected !== "string") return;
    setPath(selected);
    try {
      const p = await api.csvPreview(selected);
      setPreview(p);
      const guess: Record<string, string> = {};
      for (const f of CORE_FIELDS) {
        const hit = p.headers.find((h) => h.toLowerCase().includes(f.key.replace("_", " ").toLowerCase()));
        if (hit) guess[f.key] = hit;
      }
      setMapping(guess);
      setMetaKeys(p.headers.filter((h) => !Object.values(guess).includes(h)));
    } catch (e: any) { setError(e.toString()); }
  };

  const runImport = async () => {
    if (!path) return;
    setImporting(true);
    setError(null);
    try {
      const result = await api.csvImport(path, { fields: mapping, metadata_keys: metaKeys });
      setSummary(result);
    } catch (e: any) { setError(e.toString()); }
    finally { setImporting(false); }
  };

  const toggleMetaKey = (key: string) => {
    setMetaKeys((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  };

  return (
    <SettingCard icon={Upload} title="Import from CSV" purpose="Upload a spreadsheet export — existing clients are skipped by email.">
      <button
        onClick={pickFile}
        className="border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 mb-4 transition-colors"
      >
        <Upload size={13} /> {path ? "Change file" : "Choose CSV file"}
      </button>

      {!path && (
        <p className="text-[12px] text-muted">
          In Google Sheets: File → Download → CSV, then pick that file here.
        </p>
      )}
      {path && <div className="text-[12px] text-muted mb-4 font-mono truncate">{path}</div>}

      {preview && (
        <>
          <div className="bg-surface-2/80 border border-line px-4 py-3 rounded-xl mb-5">
            <div className="text-[13px] font-medium text-ink mb-0.5">{preview.total_rows} rows detected</div>
            <div className="text-[12px] text-muted">Headers: {preview.headers.join(", ")}</div>
          </div>

          <SectionLabel>Map columns</SectionLabel>
          <div className="space-y-2 mt-2 mb-5">
            {CORE_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-3 gap-2 items-center">
                <label className="text-[13px] text-ink-2">{f.label}</label>
                <select
                  className="col-span-2 border border-line px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                  value={mapping[f.key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                >
                  <option value="">— skip —</option>
                  {preview.headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </div>
            ))}
          </div>

          {customFields.length > 0 && (
            <>
              <SectionLabel>Custom fields</SectionLabel>
              <div className="space-y-2 mt-2 mb-5">
                {customFields.map((f) => (
                  <div key={f.value} className="grid grid-cols-3 gap-2 items-center">
                    <label className="text-[13px] text-ink-2">{f.label}</label>
                    <select
                      className="col-span-2 border border-line px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                      value={mapping[f.value] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [f.value]: e.target.value })}
                    >
                      <option value="">— skip —</option>
                      {preview.headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          <SectionLabel>Extra columns → metadata ({metaKeys.length} selected)</SectionLabel>
          <div className="flex flex-wrap gap-2 mt-2 mb-5">
            {preview.headers
              .filter((h) => !Object.values(mapping).includes(h))
              .map((h) => (
                <label
                  key={h}
                  className={`text-[12px] px-3 py-1 rounded-full cursor-pointer border transition-colors ${
                    metaKeys.includes(h)
                      ? "bg-accent text-on-accent border-accent"
                      : "bg-surface-2 border-line text-ink-2 hover:bg-surface-3"
                  }`}
                >
                  <input type="checkbox" className="sr-only" checked={metaKeys.includes(h)} onChange={() => toggleMetaKey(h)} />
                  {h}
                </label>
              ))}
          </div>

          <div className="text-[12.5px] font-medium text-muted mb-2">Preview (first 5 rows)</div>
          <div className="overflow-auto max-h-40 mb-5 border border-line rounded-xl">
            <table className="text-[12px] w-full">
              <thead className="bg-surface-2">
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-line">
                    {row.map((cell, j) => (
                      <td key={j} className="px-3 py-1.5 truncate max-w-[120px] text-ink-2">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={runImport}
            disabled={importing || (!mapping.first_name && !mapping.last_name)}
            className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            {importing ? "Importing…" : `Import ${preview.total_rows} clients`}
          </button>
        </>
      )}

      {summary && (
        <div className="mt-5 p-4 bg-success-bg border border-success rounded-xl">
          <div className="text-[13px] font-medium text-success-ink flex items-center gap-1.5">
            <Check size={14} /> Imported {summary.imported} clients
          </div>
          {summary.skipped > 0 && (
            <div className="text-[12px] text-ink-2 mt-1">
              Skipped {summary.skipped} (duplicates or empty names)
            </div>
          )}
          {summary.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-danger-ink">{summary.errors.length} errors</summary>
              <ul className="text-[11px] mt-1 space-y-0.5 text-ink-2">
                {summary.errors.map((e, i) => (<li key={i}>{e}</li>))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 text-danger-ink text-[13px] flex items-center gap-1.5">
          <AlertCircle size={13} /> {error}
        </div>
      )}
    </SettingCard>
  );
}

function GoogleContactsSection() {
  const [connected, setConnected] = useState(false);
  const [contacts, setContacts] = useState<GoogleContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    api.googleContactsList().then(() => setConnected(true)).catch(() => {});
  }, []);

  const connect = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setBusy(true); setErr(null);
    try { await api.googleContactsOauthStart(clientId.trim(), clientSecret.trim()); setConnected(true); }
    catch (e: any) { setErr(String(e)); }
    setBusy(false);
  };

  const fetch = async () => {
    setBusy(true); setErr(null);
    try { setContacts(await api.googleContactsList()); } catch (e: any) { setErr(String(e)); }
    setBusy(false);
  };

  const disconnect = () => {
    if (!confirm("Disconnect Google Contacts?")) return;
    setConnected(false);
    setContacts([]);
    setSelected(new Set());
  };

  const importContacts = async () => {
    if (selected.size === 0) return;
    setBusy(true); setErr(null);
    const toImport = contacts.filter(c => selected.has(c.resource_name));
    try { setResult(await api.googleContactsImport(toImport)); } catch (e: any) { setErr(String(e)); }
    setBusy(false);
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(c => c.resource_name)));
  };

  const filtered = contacts.filter(c =>
    !search || c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase()) ||
    c.organization?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <SettingCard icon={Users} title="Google Contacts" purpose="Bring contacts in from your Google account — duplicates are skipped."
      aside={<ConnectedPill ok={connected} />}>
      {!connected ? (
        <div className="max-w-sm">
          <SecretInput label="Google Client ID" value={clientId} onChange={setClientId} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="Google Client Secret" value={clientSecret} onChange={setClientSecret} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <button onClick={connect} disabled={busy || !clientId.trim() || !clientSecret.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-2 transition-colors">
            {busy && <RefreshCw size={13} className="animate-spin" />} {busy ? "Connecting…" : "Connect Google"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-4">
            <button onClick={fetch} disabled={busy}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-2 transition-colors">
              {busy && <RefreshCw size={13} className="animate-spin" />} {busy ? "Loading…" : contacts.length > 0 ? "Refresh" : "Fetch contacts"}
            </button>
            <button onClick={disconnect} className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">Disconnect</button>
          </div>

          {contacts.length > 0 && (
            <>
              <div className="flex items-center gap-3 mb-3">
                <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                  className="border border-line h-9 px-3 rounded-lg text-[13px] w-[200px] focus:outline-none focus:ring-2 focus:ring-accent/40" />
                <button onClick={toggleAll} className="text-[12px] text-accent hover:text-accent-hover font-medium">
                  {selected.size === filtered.length ? "Deselect all" : "Select all"}
                </button>
                <div className="flex-1" />
                <span className="text-[12px] text-muted tabular-nums">{selected.size} selected</span>
              </div>

              <div className="border border-line rounded-xl mb-4 max-h-[400px] overflow-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="bg-surface-2 sticky top-0">
                    <tr>
                      <th className="w-10 px-3 py-2"><input type="checkbox" className="accent-accent" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>
                      <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Name</th>
                      <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Email</th>
                      <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Company</th>
                      <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(c => (
                      <tr key={c.resource_name} className="border-t border-line-2 hover:bg-surface-2/50">
                        <td className="px-3 py-2"><input type="checkbox" className="accent-accent" checked={selected.has(c.resource_name)} onChange={() => {
                          const ns = new Set(selected);
                          if (ns.has(c.resource_name)) ns.delete(c.resource_name); else ns.add(c.resource_name);
                          setSelected(ns);
                        }} /></td>
                        <td className="px-3 py-2 text-[13px] text-ink">{c.name || "—"}</td>
                        <td className="px-3 py-2 text-[12px] text-muted">{c.email || "—"}</td>
                        <td className="px-3 py-2 text-[12px] text-muted">{c.organization || "—"}</td>
                        <td className="px-3 py-2 text-[12px] text-muted">{c.phone || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selected.size > 0 && (
                <button onClick={importContacts} disabled={busy}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors">
                  {busy ? "Importing…" : `Import ${selected.size} selected`}
                </button>
              )}
            </>
          )}

          {result && (
            <div className={`mt-4 px-4 py-3 rounded-xl text-[13px] ${result.errors.length > 0 ? "bg-warning-bg text-warning-ink" : "bg-success-bg text-success-ink"}`}>
              {result.imported} imported, {result.skipped} skipped (duplicates){result.errors.length > 0 && `, ${result.errors.length} errors`}
              {result.errors.slice(0, 3).map((e, i) => <div key={i} className="text-[11px] mt-1 opacity-70">{e}</div>)}
            </div>
          )}
        </>
      )}
      {err && (
        <div className="mt-4 text-danger-ink text-[12.5px] flex items-center gap-1.5">
          <AlertCircle size={13} /> {err}
        </div>
      )}
    </SettingCard>
  );
}

// One-click automations — pre-filled signup rules so users don't write regex.
// Each enables the existing email→AI-extract→create-client pipeline.
const PREMADE_AUTOMATIONS: { name: string; desc: string; sender: string | null; subject: string | null }[] = [
  { name: "Form submissions → New clients",
    desc: "Auto-create a client whenever a website or contact form is submitted — works with most providers.",
    sender: null,
    subject: "(?i)(new (form )?(submission|response|signup|lead|inquiry|entry)|form submission|contact (request|form)|you('ve| have)? (got|received) a new)" },
  { name: "Typeform submissions",
    desc: "New customer from a Typeform notification email.",
    sender: "(?i)typeform\\.com", subject: null },
  { name: "Google Forms responses",
    desc: "New customer from a Google Forms response notification.",
    sender: "(?i)google\\.com", subject: "(?i)(new response|google forms)" },
  { name: "Jotform submissions",
    desc: "New customer from a Jotform submission notification.",
    sender: "(?i)jotform\\.com", subject: null },
  { name: "Shopify contact form",
    desc: "New client from a Shopify store contact-form / customer-enquiry email.",
    sender: "(?i)shopify",
    subject: "(?i)(new (store )?contact|customer (enquiry|inquiry)|contacted you|new message from)" },
];

function AutomationTab() {
  const [rules,    setRules]    = useState<SignupRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState({ name: "", sender_pattern: "", subject_pattern: "" });
  const [enabling, setEnabling] = useState<string | null>(null);
  const [copied,   setCopied]   = useState(false);
  const leadFormUrl = "https://ecliptr.app/signup";
  const copyLeadLink = async () => {
    try { await navigator.clipboard.writeText(leadFormUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  const load = () => api.listSignupRules().then(setRules).catch(console.error);
  useEffect(() => { load(); }, []);

  const isEnabled = (name: string) => rules.some((r) => r.name === name);
  const enablePremade = async (p: (typeof PREMADE_AUTOMATIONS)[number]) => {
    if (isEnabled(p.name)) return;
    setEnabling(p.name);
    try {
      await api.createSignupRule({ name: p.name, sender_pattern: p.sender, subject_pattern: p.subject, active: true });
      load();
    } catch (e: any) { alert(e); } finally { setEnabling(null); }
  };

  const save = async () => {
    if (!form.name.trim()) return;
    if (!form.sender_pattern && !form.subject_pattern) {
      alert("At least one pattern (sender or subject) is required.");
      return;
    }
    try {
      await api.createSignupRule({
        name: form.name,
        sender_pattern: form.sender_pattern || null,
        subject_pattern: form.subject_pattern || null,
        active: true,
      });
      setShowForm(false);
      setForm({ name: "", sender_pattern: "", subject_pattern: "" });
      load();
    } catch (e: any) { alert(e); }
  };

  // Follow-up rules state
  const [fuRules, setFuRules] = useState<FollowUpRule[]>([]);
  const [fuLog, setFuLog] = useState<FollowUpLogEntry[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [showFuForm, setShowFuForm] = useState(false);
  const [editingFu, setEditingFu] = useState<FollowUpRule | null>(null);
  const [fuForm, setFuForm] = useState({ name: "", trigger_type: "no_order" as string, trigger_value: 30, action_type: "email" as string, email_subject: "", email_body: "" });
  const fuBodyRef = useRef<HTMLTextAreaElement>(null);
  const fuSubjectRef = useRef<HTMLInputElement>(null);
  const fuLastFocused = useRef<"subject" | "body">("body");

  const insertFuVariable = (token: string) => {
    if (fuLastFocused.current === "subject") {
      const el = fuSubjectRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const v = fuForm.email_subject;
      setFuForm({ ...fuForm, email_subject: v.slice(0, start) + token + v.slice(end) });
      setTimeout(() => { el.selectionStart = el.selectionEnd = start + token.length; }, 0);
    } else {
      const el = fuBodyRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const v = fuForm.email_body;
      setFuForm({ ...fuForm, email_body: v.slice(0, start) + token + v.slice(end) });
      setTimeout(() => { el.selectionStart = el.selectionEnd = start + token.length; }, 0);
    }
  };

  const loadFu = () => {
    api.listFollowupRules().then(setFuRules).catch(() => {});
    api.getFollowupLog().then(setFuLog).catch(() => {});
    api.getBackupStatus().then(s => {
      if ((s as any).last_rules_run) setLastRun((s as any).last_rules_run);
    }).catch(() => {});
  };
  useEffect(() => { loadFu(); }, []);

  const saveFu = async () => {
    if (!fuForm.name.trim()) return;
    try {
      if (editingFu) {
        await api.updateFollowupRule(editingFu.id, fuForm);
      } else {
        await api.createFollowupRule({
          name: fuForm.name.trim(),
          trigger_type: fuForm.trigger_type,
          trigger_value: fuForm.trigger_value,
          action_type: fuForm.action_type,
          email_subject: fuForm.action_type !== "reminder" ? fuForm.email_subject || null : null,
          email_body: fuForm.action_type !== "reminder" ? fuForm.email_body || null : null,
        });
      }
      setShowFuForm(false);
      setEditingFu(null);
      loadFu();
    } catch (e: any) { alert(e); }
  };

  const editFu = (r: FollowUpRule) => {
    setFuForm({ name: r.name, trigger_type: r.trigger_type, trigger_value: r.trigger_value, action_type: r.action_type, email_subject: r.email_subject || "", email_body: r.email_body || "" });
    setEditingFu(r);
    setShowFuForm(true);
  };

  const isEmailAction = fuForm.action_type === "email" || fuForm.action_type === "both";
  const triggerLabels: Record<string, string> = { no_order: "No order", no_contact: "No contact", overdue_invoice: "Overdue invoice", stale_deal: "Stale deal" };
  const actionLabels: Record<string, string> = { email: "Send email", reminder: "Create reminder", both: "Both" };

  return (
    <div className="max-w-3xl space-y-4">
    <SettingCard icon={Sparkles} title="Turn signup emails into clients"
      purpose="When an email matches a rule, Ecliptr reads the details and creates a client."
      aside={<GuideLink section="automations" />}>

      {/* Fastest path — the direct lead form (no email setup needed). */}
      <div className="border rounded-xl p-3.5 mb-5" style={{ borderColor: "rgb(var(--c-accent) / 0.3)", background: "rgb(var(--c-accent) / 0.06)" }}>
        <div className="text-[12.5px] font-semibold text-ink mb-1">Fastest setup — your lead form link</div>
        <p className="text-[11.5px] text-muted mb-2.5">Share or embed this link (add <code className="font-mono">?rep=Name</code> to attribute a rep). Every submission creates a client instantly — no email setup needed.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[12px] bg-surface-2 rounded-lg px-2.5 py-1.5 break-all select-all text-ink-2">{leadFormUrl}</code>
          <button onClick={copyLeadLink} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium whitespace-nowrap">{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>

      {/* Premade automations — one-click enable */}
      <div className="mb-6">
        <label className="block text-[12.5px] font-medium text-muted mb-2.5">One-click automations</label>
        <div className="grid lg:grid-cols-2 gap-2.5">
          {PREMADE_AUTOMATIONS.map((p) => {
            const on = isEnabled(p.name);
            return (
              <div key={p.name} className="border border-line rounded-xl p-3.5 flex flex-col bg-surface-2/40">
                <div className="text-[13px] font-medium text-ink mb-0.5">{p.name}</div>
                <div className="text-[11.5px] text-muted leading-snug flex-1 mb-3">{p.desc}</div>
                <button
                  disabled={on || enabling === p.name}
                  onClick={() => enablePremade(p)}
                  className={`h-8 rounded-lg text-[12px] font-medium transition-colors ${on ? "cursor-default bg-success-bg text-success-ink" : "bg-accent hover:bg-accent-hover text-on-accent"}`}
                >
                  {on ? "Enabled" : enabling === p.name ? "Enabling…" : "Enable"}
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted mt-2.5">Requires email connected (Settings → Email). Fine-tune or remove any rule below.</p>
      </div>

      <button onClick={() => setShowForm(true)} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 mb-5 transition-colors">
        <Plus size={13} /> Add custom rule
      </button>

      {showForm && (
        <div className="border border-line rounded-xl p-4 mb-5 space-y-3 bg-surface-2/80">
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Rule name</label>
            <input className={inp} placeholder="e.g. Typeform new client signups" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <p className="text-[11px] text-muted">Patterns are <a href="https://docs.rs/regex/latest/regex/#syntax" target="_blank" rel="noreferrer" className="text-accent underline">regular expressions</a> — at least one is required.</p>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Sender pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. noreply@typeform\.com" value={form.sender_pattern} onChange={(e) => setForm({ ...form, sender_pattern: e.target.value })} />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Subject pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. (?i)new\s+(client|signup|inquiry)" value={form.subject_pattern} onChange={(e) => setForm({ ...form, subject_pattern: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-[13px] text-muted hover:text-ink transition-colors">Cancel</button>
            <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">Save Rule</button>
          </div>
        </div>
      )}

      <div className="space-y-2 mb-8">
        {rules.map((r) => (
          <div key={r.id} className="border border-line rounded-xl px-4 py-3 flex items-center justify-between hover:border-line transition-colors">
            <div className="flex-1">
              <div className="text-[13px] font-medium text-ink">{r.name}</div>
              <div className="text-[11px] text-muted font-mono space-y-0.5 mt-0.5">
                {r.sender_pattern && <div>From: {r.sender_pattern}</div>}
                {r.subject_pattern && <div>Subject: {r.subject_pattern}</div>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer text-muted">
                <input type="checkbox" className="accent-accent" checked={r.active} onChange={(e) => api.toggleSignupRule(r.id, e.target.checked).then(load)} /> Active
              </label>
              <button onClick={() => confirm("Delete rule?") && api.deleteSignupRule(r.id).then(load)} className="text-faint hover:text-danger-ink p-1 rounded-lg hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {rules.length === 0 && <div className="text-center text-[13px] text-muted py-10">No rules yet. Add one to start auto-importing clients from signup emails.</div>}
      </div>
    </SettingCard>

    <SettingCard icon={RefreshCw} title="Follow-up rules"
      purpose="Email or remind clients automatically when a trigger fires."
      aside={lastRun ? <span className="text-[11px] text-muted">Last run {(() => { const d = new Date(lastRun); const mins = Math.floor((Date.now() - d.getTime()) / 60000); return mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ago`; })()}</span> : undefined}>

        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => { setEditingFu(null); setFuForm({ name: "", trigger_type: "no_order", trigger_value: 30, action_type: "email", email_subject: "", email_body: "" }); setShowFuForm(true); }} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium flex items-center gap-1">
            <Plus size={12} /> Add Rule
          </button>
          <button onClick={() => api.processFollowupRules().then(loadFu).catch(alert)} className="text-[12px] text-muted hover:text-ink-2 px-2 py-1 rounded hover:bg-surface-2">Run Now</button>
        </div>

        {showFuForm && (
          <div className="border border-line rounded-xl p-4 mb-4 space-y-3 bg-surface-2/80">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Name</label>
                <input className={inp} value={fuForm.name} onChange={(e) => setFuForm({ ...fuForm, name: e.target.value })} placeholder="Check-in reminder" />
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Trigger</label>
                <select className={inp} value={fuForm.trigger_type} onChange={(e) => setFuForm({ ...fuForm, trigger_type: e.target.value })}>
                  {Object.entries(triggerLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Days</label>
                <NumberInput className={inp} integer value={fuForm.trigger_value} onValue={(n) => setFuForm({ ...fuForm, trigger_value: n })} />
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1.5">Action</label>
                <select className={inp} value={fuForm.action_type} onChange={(e) => setFuForm({ ...fuForm, action_type: e.target.value })}>
                  {Object.entries(actionLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            {isEmailAction && (
              <>
                <div>
                  <label className="block text-[12.5px] font-medium text-muted mb-1.5">Email Subject</label>
                  <input ref={fuSubjectRef} className={inp} value={fuForm.email_subject} onChange={(e) => setFuForm({ ...fuForm, email_subject: e.target.value })} onFocus={() => { fuLastFocused.current = "subject"; }} placeholder="Just checking in" />
                </div>
                <div>
                  <label className="block text-[12.5px] font-medium text-muted mb-1.5">Email Body</label>
                  <textarea ref={fuBodyRef} className={inp + " h-20 resize-none"} value={fuForm.email_body} onChange={(e) => setFuForm({ ...fuForm, email_body: e.target.value })} onFocus={() => { fuLastFocused.current = "body"; }} placeholder="Hi {first_name}, hope things are going well..." />
                  <div className="mt-1">
                    <VariablePicker onSelect={insertFuVariable} />
                  </div>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowFuForm(false); setEditingFu(null); }} className="text-[13px] text-muted hover:text-ink transition-colors">Cancel</button>
              <button onClick={saveFu} disabled={!fuForm.name.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50">
                {editingFu ? "Save Changes" : "Create Rule"}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {fuRules.map((r) => (
            <div key={r.id} className="border border-line rounded-xl px-4 py-3 flex items-center justify-between hover:border-line transition-colors">
              <div className="flex-1">
                <div className="text-[13px] font-medium text-ink">{r.name}</div>
                <div className="text-[11px] text-muted mt-0.5">{triggerLabels[r.trigger_type] || r.trigger_type} &gt; {r.trigger_value}d → {actionLabels[r.action_type] || r.action_type}</div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer text-muted">
                  <input type="checkbox" className="accent-accent" checked={r.is_active} onChange={() => api.toggleFollowupRule(r.id).then(loadFu)} /> Active
                </label>
                <button onClick={() => editFu(r)} className="text-[11px] text-muted hover:text-ink-2">Edit</button>
                <button onClick={() => confirm("Delete rule?") && api.deleteFollowupRule(r.id).then(loadFu)} className="text-faint hover:text-danger-ink p-1 rounded-lg hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>

        {fuLog.length > 0 && (
          <div className="mt-4 border-t border-line-2 pt-4">
            <p className="text-[12.5px] font-medium text-muted mb-2">Recent Activity</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {fuLog.slice(0, 20).map((l) => (
                <div key={l.id} className="text-[11px] text-muted flex items-center gap-2">
                  <span className="text-muted w-16 flex-shrink-0">{l.triggered_at.slice(0, 10)}</span>
                  <span className="font-medium text-ink-2">{l.action_taken}</span>
                  {l.details && <span className="text-muted truncate">— {l.details}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
    </SettingCard>
    </div>
  );
}

function UpdateButton() {
  const [checking, setChecking] = useState(false);
  const [status,   setStatus]   = useState<string | null>(null);
  const [version,  setVersion]  = useState<string | null>(null);

  useEffect(() => { getVersion().then(setVersion).catch(() => setVersion(null)); }, []);

  const checkForUpdates = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setStatus(`Update available: ${update.version}`);
        await update.downloadAndInstall();
      } else {
        setStatus("Up to date");
      }
    } catch (e: any) { setStatus(e.toString()); }
    finally { setChecking(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-[13px]">
        <span className="text-muted">You're on</span>
        <span className="font-semibold text-ink tabular-nums">{version ? `v${version}` : "…"}</span>
      </div>
      <button
        onClick={checkForUpdates}
        disabled={checking}
        className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-5 h-9 rounded-lg text-[13px] disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking…" : "Check for updates"}
      </button>
      {status && <p className="text-[12px] text-muted mt-2">{status}</p>}
    </div>
  );
}

function intakeAutoMatch(key: string): string | null {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["email", "emailaddress", "mail", "e"].includes(k)) return "email";
  if (["phone", "phonenumber", "tel", "telephone", "mobile", "cell"].includes(k)) return "phone";
  if (["name", "fullname", "contactname", "yourname"].includes(k)) return "name";
  if (["firstname", "fname", "givenname"].includes(k)) return "first_name";
  if (["lastname", "lname", "surname", "familyname"].includes(k)) return "last_name";
  if (["company", "companyname", "business", "businessname", "organization", "organisation", "org"].includes(k)) return "company";
  if (["notes", "note", "message", "comments", "comment"].includes(k)) return "notes";
  return null;
}

function IntakeSourceCard({ source, fields, onChange }: { source: any; fields: { value: string; label: string }[]; onChange: () => void }) {
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(source.mapping_json || "{}"); } catch { /* ignore */ }
  let sample: Record<string, unknown> = {};
  try { sample = JSON.parse(source.sample_json || "{}"); } catch { /* ignore */ }
  const incoming = Object.keys(sample).filter((k) => k !== "website");

  const [map, setMap] = useState<Record<string, string>>({ ...saved });
  const [savedMsg, setSavedMsg] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    setMap((prev) => {
      const m = { ...prev };
      for (const k of incoming) if (!(k in m)) m[k] = saved[k] ?? intakeAutoMatch(k) ?? `cf:${k}`;
      return m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.sample_json, source.mapping_json]);

  const save = async () => {
    await api.saveIntakeMapping(source.id, JSON.stringify(map));
    setSavedMsg(true); setTimeout(() => setSavedMsg(false), 2000); onChange();
  };
  const del = () => {
    if (confirmDel) { api.deleteIntakeSource(source.id).then(onChange).catch(() => {}); }
    else { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); }
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-[13px] text-ink truncate">{source.name}</div>
        <button onClick={del} className="text-[12px] text-danger-ink hover:underline shrink-0">{confirmDel ? "Confirm delete?" : "Delete"}</button>
      </div>
      <div className="flex items-center gap-2">
        <input readOnly value={source.url} className="flex-1 bg-surface-2 border border-line rounded-lg h-8 px-2.5 text-[12px] text-ink" />
        <button onClick={() => navigator.clipboard?.writeText(source.url)} className="px-3 h-8 border border-line rounded-lg text-[12px] hover:bg-surface-2 transition-colors shrink-0">Copy URL</button>
      </div>
      {incoming.length === 0 ? (
        <div className="text-[12.5px] text-muted bg-surface-2 border border-line rounded-lg p-3 leading-relaxed">
          Point your form at this URL (HTTP <strong>POST</strong>, JSON body). After the first submission its fields show up here to map — standard names (name, email, phone, company) link on their own.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[12.5px] font-medium text-muted">Field mapping</div>
          {incoming.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <div className="flex-1 text-[12.5px] text-ink truncate" title={k}>{k}</div>
              <span className="text-muted text-[12px] shrink-0">→</span>
              <select value={map[k] ?? `cf:${k}`} onChange={(e) => setMap({ ...map, [k]: e.target.value })}
                className="w-48 bg-surface-2 border border-line rounded-lg h-8 px-2 text-[12.5px] text-ink shrink-0">
                {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                {!fields.some((f) => f.value === `cf:${k}`) && <option value={`cf:${k}`}>{`Keep as "${k}"`}</option>}
              </select>
            </div>
          ))}
          <div className="pt-1">
            <button onClick={save} className="px-4 h-8 rounded-lg bg-accent text-on-accent text-[12.5px] font-medium hover:opacity-90 transition-opacity">{savedMsg ? "Saved" : "Save mapping"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function IntakeTab() {
  const [sources, setSources] = useState<any[]>([]);
  const [fields, setFields] = useState<{ value: string; label: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [s, f] = await Promise.all([api.listIntakeSources(), api.getIntakeFields()]);
    setSources(s); setFields(f);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const create = async () => {
    setBusy(true);
    try { await api.createIntakeSource(newName); setNewName(""); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <SectionLabel>Web forms & custom sites</SectionLabel>
        <p className="text-[13px] text-muted mt-1 leading-relaxed">
          Create an intake link for any website or form. Submissions become <strong>pending</strong> clients for you to approve. Common fields link automatically; map anything custom once and it's remembered.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name this source (e.g. Website contact form)"
          className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink" />
        <button onClick={create} disabled={busy} className="px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium disabled:opacity-50 transition-opacity">Create link</button>
      </div>
      {sources.length === 0 && <div className="text-[13px] text-muted">No intake links yet — create one above.</div>}
      {sources.map((s) => <IntakeSourceCard key={s.id} source={s} fields={fields} onChange={load} />)}
    </div>
  );
}

function FacebookTab() {
  const [st, setSt] = useState<FbStatus | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [savingApp, setSavingApp] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pages, setPages] = useState<FbPageLite[] | null>(null);
  const load = () => api.fbStatus().then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);

  const saveApp = async () => {
    if (!appId.trim() || !appSecret.trim()) return;
    setSavingApp(true);
    try { await api.fbSetApp(appId.trim(), appSecret.trim()); setAppSecret(""); toast("Facebook app saved"); await load(); }
    catch (e: any) { toast(String(e), "error"); }
    setSavingApp(false);
  };
  const pick = async (id: string) => {
    try { const name = await api.fbSelectPage(id); setPages(null); toast(`Connected ${name}`); await load(); }
    catch (e: any) { toast(String(e), "error"); }
  };
  const connect = async () => {
    setConnecting(true);
    try {
      const ps = await api.fbConnect();
      if (ps.length === 1) await pick(ps[0].id);
      else setPages(ps);
    } catch (e: any) { toast(String(e), "error"); }
    setConnecting(false);
  };
  const disconnect = async () => {
    try { await api.fbDisconnect(); setPages(null); toast("Facebook Page disconnected"); await load(); }
    catch (e: any) { toast(String(e), "error"); }
  };
  const redirect = st?.redirect_uri || "http://localhost:8712/callback";

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <SectionLabel>Facebook Page posting</SectionLabel>
        <p className="text-[13px] text-muted mt-1 leading-relaxed">
          Post an inventory lot — photos and caption — straight to a Facebook <strong>Page</strong> you manage.
          Meta doesn’t let apps post into groups, so this targets a Page. Connect once; then use
          <strong> Post to Facebook</strong> on any lot.
        </p>
      </div>

      <div className="bg-surface border border-line rounded-xl p-4 space-y-3.5">
        <div className="text-[12px] font-medium">
          Status: {st?.connected
            ? <span className="text-success-ink">Connected · {st.page_name}</span>
            : st?.has_app ? <span className="text-muted">App saved — connect a Page</span>
            : <span className="text-muted">Not set up yet</span>}
        </div>

        {st?.connected ? (
          <button onClick={disconnect} className="px-3 h-9 border border-line rounded-lg text-[12.5px] hover:bg-surface-2 transition-colors">Disconnect Page</button>
        ) : (
          <>
            <div>
              <div className="text-[12.5px] font-medium text-muted mb-1.5">App ID</div>
              <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="From your Meta app"
                className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink" />
            </div>
            <div>
              <div className="text-[12.5px] font-medium text-muted mb-1.5">App secret</div>
              <div className="flex items-center gap-2">
                <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={st?.has_app ? "•••••••  (saved — paste to replace)" : "From your Meta app"}
                  className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink" />
                <button onClick={saveApp} disabled={savingApp || !appId.trim() || !appSecret.trim()}
                  className="px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
                  {savingApp ? "Saving…" : "Save app"}
                </button>
              </div>
            </div>
            <div className="pt-1">
              <button onClick={connect} disabled={!st?.has_app || connecting}
                className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
                <Facebook size={14} /> {connecting ? "Waiting for Facebook…" : "Connect Facebook Page"}
              </button>
              {!st?.has_app && <p className="text-[11.5px] text-muted mt-1.5">Save your App ID and secret first.</p>}
            </div>
          </>
        )}

        {pages && pages.length > 0 && (
          <div className="pt-1">
            <div className="text-[12.5px] font-medium text-muted mb-1.5">Choose the Page to post to</div>
            <div className="rounded-lg border border-line divide-y divide-line-2">
              {pages.map((p) => (
                <button key={p.id} onClick={() => pick(p.id)}
                  className="w-full text-left px-3 py-2.5 text-[13px] text-ink-2 hover:bg-surface-2 flex items-center justify-between transition-colors">
                  <span>{p.name}</span><span className="text-[11px] text-accent">Select</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[12px] font-semibold text-ink mb-2.5">Set it up in Meta (one time)</div>
        <ol className="text-[12.5px] text-muted space-y-2 list-decimal pl-4 leading-relaxed marker:text-muted">
          <li>Go to <strong className="text-ink-2">developers.facebook.com</strong> → <strong className="text-ink-2">My Apps → Create App</strong> → type <strong className="text-ink-2">Business</strong>.</li>
          <li>Add the <strong className="text-ink-2">Facebook Login</strong> product. Under its settings, add this exact <strong className="text-ink-2">Valid OAuth Redirect URI</strong>:
            <div className="flex items-center gap-2 mt-1.5">
              <input readOnly value={redirect} className="flex-1 bg-surface-2 border border-line rounded-lg h-8 px-2.5 text-[12px] text-ink" />
              <button onClick={() => { navigator.clipboard?.writeText(redirect); toast("Copied"); }} className="px-3 h-8 border border-line rounded-lg text-[12px] hover:bg-surface-2 transition-colors">Copy</button>
            </div>
          </li>
          <li>In <strong className="text-ink-2">App settings → Basic</strong>, copy the <strong className="text-ink-2">App ID</strong> and <strong className="text-ink-2">App secret</strong> into the fields above and save.</li>
          <li>Make sure you’re an admin of the app (you are, as its creator) — while the app is in <strong className="text-ink-2">Development</strong> mode you can post to Pages you manage without Meta app review.</li>
          <li>Click <strong className="text-ink-2">Connect Facebook Page</strong>, approve in the Facebook window, and pick your Page.</li>
        </ol>
      </div>
    </div>
  );
}

function ShopifyTab() {
  const [cfg, setCfg] = useState<any>(null);
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getShopifyConfig().then(setCfg).catch(() => {}); }, []);
  const save = async () => {
    if (!secret.trim()) return;
    setBusy(true);
    try {
      await api.setShopifySecret(secret.trim());
      setSecret(""); setSaved(true); setTimeout(() => setSaved(false), 2500);
      setCfg(await api.getShopifyConfig());
    } finally { setBusy(false); }
  };
  const url: string = cfg?.webhook_url || "https://ecliptr.app/api/integrations/shopify/customers?org=org_default";
  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <SectionLabel>Shopify customer sync</SectionLabel>
        <p className="text-[13px] text-muted mt-1 leading-relaxed">
          New Shopify customers arrive as <strong>pending</strong> clients for you to review — nothing is added automatically.
        </p>
      </div>

      <div className="bg-surface border border-line rounded-xl p-4 space-y-3.5">
        <div className="text-[12px] font-medium">
          Status: {cfg?.configured ? <span className="text-success-ink">Connected</span> : <span className="text-muted">Not set up yet</span>}
        </div>
        <div>
          <div className="text-[12.5px] font-medium text-muted mb-1.5">Webhook URL</div>
          <div className="flex items-center gap-2">
            <input readOnly value={url} className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[12px] text-ink" />
            <button onClick={() => navigator.clipboard?.writeText(url)} className="px-3 h-9 border border-line rounded-lg text-[12px] hover:bg-surface-2 transition-colors">Copy</button>
          </div>
        </div>
        <div>
          <div className="text-[12.5px] font-medium text-muted mb-1.5">Webhook signing secret</div>
          <div className="flex items-center gap-2">
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={cfg?.configured ? "•••••••  (set — paste to replace)" : "Paste the secret from Shopify"}
              className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink" />
            <button onClick={save} disabled={busy || !secret.trim()}
              className="px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
              {saved ? "Saved" : "Save"}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="text-[12px] font-semibold text-ink mb-2.5">Set it up in Shopify (one time)</div>
        <ol className="text-[12.5px] text-muted space-y-2 list-decimal pl-4 leading-relaxed marker:text-muted">
          <li>Shopify admin → <strong className="text-ink-2">Settings → Notifications → Webhooks</strong> → <strong className="text-ink-2">Create webhook</strong>.</li>
          <li>Event: <strong className="text-ink-2">Customer creation</strong>. Format: <strong className="text-ink-2">JSON</strong>.</li>
          <li>Paste the <strong className="text-ink-2">Webhook URL</strong> above as the destination.</li>
          <li>Save, then copy the <strong className="text-ink-2">signing secret</strong> Shopify shows and paste it here.</li>
        </ol>
      </div>
    </div>
  );
}

function PaymentsTab() {
  const [methods,  setMethods]  = useState<PaymentMethod[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing,  setEditing]  = useState<PaymentMethod | null>(null);
  const [form,     setForm]     = useState<PaymentMethodInput>({ kind: "ACH", label: "", details: "" });

  const load = () => api.listPaymentMethods().then(setMethods).catch(console.error);
  useEffect(() => { load(); }, []);

  const KINDS = ["ACH", "Wire", "Stripe Link", "PayPal", "Venmo", "Zelle", "Check", "Other"];

  const save = async () => {
    if (!form.label.trim()) return;
    try {
      if (editing) {
        await api.updatePaymentMethod(editing.id, { ...form, details: form.details || undefined });
      } else {
        await api.createPaymentMethod({ ...form, details: form.details || undefined });
      }
      setShowForm(false);
      setEditing(null);
      load();
    } catch (e: any) { alert(e); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this payment method?")) return;
    await api.deletePaymentMethod(id);
    load();
  };

  const moveUp = async (i: number) => {
    if (i === 0) return;
    const copy = [...methods];
    [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
    await api.reorderPaymentMethods(copy.map((m) => m.id));
    load();
  };

  const moveDown = async (i: number) => {
    if (i === methods.length - 1) return;
    const copy = [...methods];
    [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
    await api.reorderPaymentMethods(copy.map((m) => m.id));
    load();
  };

  return (
    <div className="max-w-3xl">
     <SettingCard icon={CreditCard} title="Payment methods" purpose="How customers can pay you — these print on every invoice."
      aside={
        <button
          onClick={() => { setEditing(null); setForm({ kind: "ACH", label: "", details: "" }); setShowForm(true); }}
          className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      }>
      {showForm && (
        <div className="border border-line rounded-xl p-4 mb-5 bg-surface-2/80 space-y-3">
          <Field label="Type">
            <select
              className={inp}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (<option key={k} value={k}>{k}</option>))}
            </select>
          </Field>
          <Field label="Label">
            <input
              className={inp}
              placeholder="e.g. Bank transfer"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>
          <Field label="Details">
            <textarea
              rows={3}
              className="border border-line px-3 py-2 rounded-lg text-[13px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              placeholder={"Account #: 123456789\nRouting: 021000021\nBank: Chase"}
              value={form.details ?? ""}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setEditing(null); }}
              className="text-[13px] text-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!form.label.trim()}
              className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
            >
              {editing ? "Update" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {methods.map((m, i) => (
          <div
            key={m.id}
            className={`border border-line rounded-xl px-4 py-3 flex items-start justify-between hover:border-line transition-colors ${m.active ? "" : "opacity-50"}`}
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold font-mono bg-surface-3 px-2 py-0.5 rounded-md text-muted uppercase tracking-wide">
                  {m.kind}
                </span>
                <span className="text-[13px] font-medium text-ink">{m.label}</span>
              </div>
              {m.details && (
                <pre className="text-[11px] text-muted mt-1 whitespace-pre-wrap font-mono">{m.details}</pre>
              )}
            </div>
            <div className="flex items-center gap-1 ml-3">
              <button onClick={() => moveUp(i)}   className="text-faint hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><ChevronUp   size={13} /></button>
              <button onClick={() => moveDown(i)} className="text-faint hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><ChevronDown size={13} /></button>
              <button
                onClick={() => { setEditing(m); setForm({ kind: m.kind, label: m.label, details: m.details }); setShowForm(true); }}
                className="text-faint hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"
              >
                <Edit2 size={13} />
              </button>
              <button onClick={() => remove(m.id)} className="text-faint hover:text-danger-ink p-1 rounded-lg hover:bg-danger-bg transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
        {methods.length === 0 && !showForm && (
          <div className="py-10 flex flex-col items-center">
            <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
              <CreditCard size={18} />
            </div>
            <div className="text-[13px] text-muted mb-3">No payment methods yet</div>
            <button
              onClick={() => { setEditing(null); setForm({ kind: "ACH", label: "", details: "" }); setShowForm(true); }}
              className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors"
            >
              <Plus size={14} /> Add your first method
            </button>
          </div>
        )}
      </div>
     </SettingCard>
    </div>
  );
}

function TemplatesTab() {
  const [templates, setTemplates] = useState<LineItemTemplate[]>([]);
  const [desc, setDesc] = useState("");
  const [rate, setRate] = useState("0");
  const [qty,  setQty]  = useState("1");

  const load = () => api.listLineItemTemplates().then(setTemplates).catch(console.error);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!desc.trim()) return;
    await api.createLineItemTemplate(desc.trim(), parseFloat(rate) || 0, parseFloat(qty) || 1);
    setDesc(""); setRate("0"); setQty("1");
    load();
  };

  const remove = async (id: string) => { await api.deleteLineItemTemplate(id); load(); };

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Line Item Templates</h3>
      <p className="text-[12px] text-muted mb-5">Saved line items for quick invoice creation.</p>

      {/* Add row */}
      <div className="grid grid-cols-12 gap-2 mb-5">
        <div className="col-span-7">
          <label className="block text-[12.5px] font-medium text-muted mb-1.5">Description</label>
          <input
            className={inpSm}
            placeholder="e.g. Standard order processing"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[12.5px] font-medium text-muted mb-1.5">Rate</label>
          <input
            type="text"
            inputMode="decimal"
            className={inpSm}
            placeholder="0.00"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div className="col-span-1">
          <label className="block text-[12.5px] font-medium text-muted mb-1.5">Qty</label>
          <input
            type="text"
            inputMode="decimal"
            className={inpSm}
            placeholder="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div className="col-span-2 flex items-end">
          <button
            onClick={add}
            disabled={!desc.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent h-9 px-4 rounded-lg text-[13px] font-medium w-full disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center justify-between border border-line rounded-xl px-4 py-2.5 hover:border-line transition-colors">
            <span className="text-[13px] text-ink">{t.description}</span>
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-muted tabular-nums">{fmtAmount(t.rate)} × {t.qty}</span>
              <button onClick={() => remove(t.id)} className="text-faint hover:text-danger-ink p-1 rounded-lg hover:bg-danger-bg transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="text-center text-[13px] text-muted py-10">No templates yet.</div>
        )}
      </div>
    </div>
  );
}

/** The storefront background ids that render as a light page. */
const LIGHT_STOREFRONT_BGS = new Set(["paper", "snow", "linen"]);

/**
 * Would this accent be unreadable on the chosen background? Mirrors the guard in
 * `www/shop.html` so the warning here and the fallback there never disagree.
 */
function accentTooLightForBg(accent?: string, bg?: string): boolean {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(accent || "");
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return LIGHT_STOREFRONT_BGS.has(bg || "paper") ? lum > 0.82 : lum < 0.12;
}

function StorefrontTab() {
  const [cfg, setCfg] = useState<StorefrontConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.getStorefrontConfig().then(setCfg).catch(() => {}); }, []);
  if (!cfg) return <div className="text-sm text-muted py-8 text-center">Loading…</div>;

  const set = (patch: Partial<StorefrontConfig>) => setCfg({ ...cfg, ...patch });
  const save = async (override?: Partial<StorefrontConfig>) => {
    const next = { ...cfg, ...(override || {}) };
    setCfg(next);
    setSaving(true);
    try { const c = await api.saveStorefrontConfig(next); setCfg(c); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  const copy = () => { if (cfg.url) { navigator.clipboard.writeText(cfg.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  const inpCls = "w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button onClick={onClick} className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${on ? "bg-accent" : "bg-surface-3 border border-line"}`}>
      <span className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : ""}`} />
    </button>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-[12px] text-muted leading-relaxed">
        A clean public web page of your available inventory — share the link with your buyer network so they can browse what's in stock anytime, with photos, location, and (optionally) pricing. Sold or archived lots drop off automatically.
      </p>

      {/* Enable */}
      <div className="flex items-center justify-between bg-surface border border-line rounded-xl px-4 py-3">
        <div>
          <div className="text-[13px] font-medium text-ink">Public storefront</div>
          <div className="text-[11.5px] text-muted">{cfg.enabled ? "Live — anyone with the link can view your available lots" : "Off — turn on to generate your shareable link"}</div>
        </div>
        <Toggle on={cfg.enabled} onClick={() => save({ enabled: !cfg.enabled })} />
      </div>

      {/* Link */}
      {cfg.enabled && cfg.url && (
        <div>
          <SectionLabel>Your public link</SectionLabel>
          <div className="flex gap-2 mt-2">
            <input readOnly value={cfg.url} onFocus={(e) => e.currentTarget.select()} className={inpCls} />
            <button onClick={copy} className="border border-line rounded-lg px-3 h-9 text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap flex items-center gap-1.5">
              {copied ? <><Check size={13} className="text-success-ink" /> Copied</> : "Copy"}
            </button>
            <button onClick={() => api.openExternal(cfg.url!)} className="border border-line rounded-lg px-3 h-9 text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">Open</button>
          </div>
          <p className="text-[11px] text-muted mt-1.5">Anyone can view it — the link is unguessable. Turning the storefront off makes it stop working.</p>
        </div>
      )}

      {/* Content */}
      <div className="space-y-3">
        <SectionLabel>Page content</SectionLabel>
        <div>
          <label className="text-[12px] text-muted">Headline</label>
          <input value={cfg.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. BJM Distributions — Available Now" className={inpCls} />
        </div>
        <div>
          <label className="text-[12px] text-muted">Subtitle</label>
          <input value={cfg.subtitle} onChange={(e) => set({ subtitle: e.target.value })} placeholder="e.g. Wholesale loads, refreshed weekly. First to commit wins it." className={inpCls} />
        </div>
      </div>

      {/* Contact — powers the "Inquire" button on every lot */}
      <div className="space-y-3">
        <SectionLabel>Inquire button</SectionLabel>
        <p className="text-[11.5px] text-muted -mt-1">Each lot gets an “Inquire” button. WhatsApp is used if set, otherwise email.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] text-muted">WhatsApp number</label>
            <input value={cfg.contact_wa} onChange={(e) => set({ contact_wa: e.target.value })} placeholder="+1 555 555 0100" className={inpCls} />
          </div>
          <div>
            <label className="text-[12px] text-muted">Contact email</label>
            <input value={cfg.contact_email} onChange={(e) => set({ contact_email: e.target.value })} placeholder="you@company.com" className={inpCls} />
          </div>
        </div>
      </div>

      {/* Display options */}
      <div className="space-y-2.5">
        <SectionLabel>Display</SectionLabel>
        <label className="flex items-center gap-2.5 text-[13px] text-ink-2 cursor-pointer">
          <input type="checkbox" className="accent-accent" checked={cfg.show_prices} onChange={(e) => set({ show_prices: e.target.checked })} />
          Show prices (asking price on each lot)
        </label>
        <label className="flex items-center gap-2.5 text-[13px] text-ink-2 cursor-pointer">
          <input type="checkbox" className="accent-accent" checked={cfg.show_logo} onChange={(e) => set({ show_logo: e.target.checked })} />
          Show your company logo (from Company settings)
        </label>
        <div className="flex items-center gap-3 pt-1">
          <label className="text-[13px] text-ink-2">Accent color</label>
          <input type="color" value={cfg.accent || "#FF6520"} onChange={(e) => set({ accent: e.target.value })} className="w-9 h-9 rounded-lg border border-line bg-surface-2 cursor-pointer" />
          <span className="text-[12px] text-muted tabular-nums">{cfg.accent}</span>
        </div>
        <div className="pt-1">
          <label className="text-[13px] text-ink-2 block mb-2">Background</label>
          <div className="flex gap-2 flex-wrap">
            {[
              { id: "paper",    label: "Paper",    c: "#FBFAF7", light: true },
              { id: "snow",     label: "Snow",     c: "#FFFFFF", light: true },
              { id: "linen",    label: "Linen",    c: "#F7F4EE", light: true },
              { id: "charcoal", label: "Charcoal", c: "#0D0A09" },
              { id: "obsidian", label: "Obsidian", c: "#070707" },
              { id: "midnight", label: "Midnight", c: "#080A10" },
              { id: "slate",    label: "Slate",    c: "#0B0D10" },
              { id: "plum",     label: "Plum",     c: "#0D080D" },
            ].map((b) => (
              <button key={b.id} type="button" onClick={() => set({ bg: b.id })} title={b.label}
                className={`w-9 h-9 rounded-lg border-2 transition-colors ${(cfg.bg || "paper") === b.id ? "border-accent" : b.light ? "border-line-3" : "border-line"}`}
                style={{ background: b.c }} aria-label={b.label} />
            ))}
          </div>
          {/* An accent chosen for a dark background can disappear on a light one.
              The page falls back to Ecliptr orange rather than rendering invisible
              buttons, but it should be a deliberate choice, not a rescue. */}
          {accentTooLightForBg(cfg.accent, cfg.bg) && (
            <p className="text-[11px] text-warning-ink mt-2">
              {cfg.accent} is too light to read on this background, so the storefront falls back to Ecliptr orange.
              Pick a darker accent to use your own colour.
            </p>
          )}
        </div>
      </div>

      <button onClick={() => save()} disabled={saving} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
        {saving ? "Saving…" : "Save storefront"}
      </button>
    </div>
  );
}

function CategoriesTab() {
  const [cats,      setCats]      = useState<Category[]>([]);
  const [newLabel,  setNewLabel]  = useState("");
  const [newParent, setNewParent] = useState<string>("");   // "" = top-level
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [sortDesc,  setSortDesc]  = useState(false);
  const [addedMsg,  setAddedMsg]  = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Shared import panel. `source` distinguishes a spreadsheet file (pick a
  // column first) from the connected Google Sheet (values arrive directly).
  const [imp, setImp] = useState<null | {
    source: "csv" | "sheet";
    path: string; headers: string[]; total: number;
    col: number | null; values: string[]; chosen: Record<string, boolean>; loading: boolean;
  }>(null);

  const reload = () => api.listCategories().then(setCats);
  useEffect(() => { reload(); }, []);

  const tops = cats.filter((c) => !c.parent_id);
  const childrenOf = (id: string) => cats.filter((c) => c.parent_id === id);
  const existingLabels = new Set(cats.map((c) => c.label.trim().toLowerCase()));

  const create = async () => {
    if (!newLabel.trim()) return;
    await api.createCategory({ label: newLabel.trim(), parent_id: newParent || null });
    setNewLabel("");
    reload();
  };

  const update = async (id: string) => {
    if (!editLabel.trim()) return;
    await api.updateCategory(id, { label: editLabel.trim() });
    setEditingId(null);
    reload();
  };

  const remove = async (id: string, label: string) => {
    const kids = childrenOf(id).length;
    const extra = kids > 0 ? ` Its ${kids} subcategor${kids === 1 ? "y" : "ies"} will become top-level.` : "";
    if (confirm(`Delete category "${label}"? Existing clients keep their category value.${extra}`)) {
      await api.deleteCategory(id);
      reload();
    }
  };

  const toggleSort = async () => {
    const desc = !sortDesc;
    setSortDesc(desc);
    await api.sortCategories(desc);
    reload();
  };

  // Same-name siblings (case/whitespace-insensitive) — only surface the cleanup
  // button when there's actually something to merge.
  const hasDupes = (() => {
    const seen = new Set<string>();
    for (const c of cats) {
      const key = `${c.parent_id || ""}::${c.label.trim().toLowerCase()}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  })();
  const [deduping, setDeduping] = useState(false);
  const dedupe = async () => {
    setDeduping(true);
    try {
      const n = await api.dedupeCategories();
      setAddedMsg(n > 0 ? `Merged ${n} duplicate${n === 1 ? "" : "s"}` : "No duplicates found");
      reload();
    } catch { setAddedMsg("Could not clean up duplicates"); }
    setDeduping(false);
  };

  // ── Detect categories from a spreadsheet column ──
  const pickFile = async () => {
    const selected = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!selected || typeof selected !== "string") return;
    try {
      const preview = await api.csvPreview(selected);
      setImp({ source: "csv", path: selected, headers: preview.headers, total: preview.total_rows, col: null, values: [], chosen: {}, loading: false });
    } catch (e: any) { alert(typeof e === "string" ? e : "Could not read that file."); }
  };

  // Pull the distinct values of the connected Google Sheet's category column and
  // reuse the same import checklist (new values pre-checked).
  const pickSheet = async () => {
    setImp({ source: "sheet", path: "", headers: [], total: 0, col: 0, values: [], chosen: {}, loading: true });
    try {
      const values = await api.sheetCategoryValues();
      const chosen: Record<string, boolean> = {};
      values.forEach((v) => { chosen[v] = !existingLabels.has(v.trim().toLowerCase()); });
      setImp((prev) => prev ? { ...prev, values, chosen, loading: false } : prev);
    } catch (e: any) {
      setImp(null);
      alert(typeof e === "string" ? e : "Could not read the connected Sheet. Configure it under Google Sheets first.");
    }
  };

  const pickColumn = async (col: number) => {
    if (!imp) return;
    setImp({ ...imp, col, loading: true });
    try {
      const values = await api.csvDistinctColumn(imp.path, col);
      const chosen: Record<string, boolean> = {};
      values.forEach((v) => { chosen[v] = !existingLabels.has(v.trim().toLowerCase()); });  // pre-check new ones
      setImp((prev) => prev ? { ...prev, col, values, chosen, loading: false } : prev);
    } catch (e: any) {
      alert(typeof e === "string" ? e : "Could not read that column.");
      setImp((prev) => prev ? { ...prev, loading: false } : prev);
    }
  };

  const chosenCount = imp ? imp.values.filter((v) => imp.chosen[v]).length : 0;
  const runImport = async () => {
    if (!imp) return;
    const labels = imp.values.filter((v) => imp.chosen[v]);
    if (labels.length === 0) return;
    setImporting(true);
    try {
      const added = await api.importCategories(labels);
      setAddedMsg(`Added ${added} categor${added === 1 ? "y" : "ies"}.`);
      setImp(null);
      reload();
      setTimeout(() => setAddedMsg(null), 3000);
    } catch (e: any) { alert(typeof e === "string" ? e : "Import failed."); }
    finally { setImporting(false); }
  };

  // Rendered as a direct call (not <Row/>) so editing keeps input focus.
  // `group` reveals the row's actions on hover for a calmer resting state.
  const renderRow = (c: Category, child?: boolean) => (
    <div key={c.id} className={`group flex items-center gap-2 pr-3 py-2 hover:bg-surface-2/60 transition-colors ${child ? "pl-4" : "pl-4"}`}>
      {child && (
        <span className="flex items-center text-faint shrink-0" aria-hidden>
          <span className="w-3 border-t border-line-2 mr-1.5 ml-0.5" />
        </span>
      )}
      {editingId === c.id ? (
        <>
          <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") update(c.id); if (e.key === "Escape") setEditingId(null); }}
            className="flex-1 border border-line px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" autoFocus />
          <button onClick={() => update(c.id)}       title="Save"   className="text-success-ink p-1.5 rounded-lg hover:bg-success-bg transition-colors"><Check size={14} /></button>
          <button onClick={() => setEditingId(null)} title="Cancel" className="text-muted hover:text-ink-2 p-1.5 rounded-lg hover:bg-surface-3 transition-colors"><X size={14} /></button>
        </>
      ) : (
        <>
          <span className={`flex-1 truncate ${child ? "text-[12.5px] text-ink-2" : "text-[13px] font-medium text-ink"}`}>{c.label}</span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {!child && (
              <button onClick={() => { setNewParent(c.id); setNewLabel(""); setTimeout(() => document.getElementById("cat-new-input")?.focus(), 0); }}
                title="Add subcategory" className="text-faint hover:text-accent px-1.5 py-1 rounded-lg hover:bg-surface-3 transition-colors flex items-center gap-0.5 text-[11px] font-medium"><Plus size={12} /> sub</button>
            )}
            <button onClick={() => { setEditingId(c.id); setEditLabel(c.label); }} title="Rename" className="text-faint hover:text-ink-2 p-1.5 rounded-lg hover:bg-surface-3 transition-colors"><Edit2 size={13} /></button>
            <button onClick={() => remove(c.id, c.label)}                          title="Delete" className="text-faint hover:text-danger-ink p-1.5 rounded-lg hover:bg-danger-bg transition-colors"><Trash2 size={13} /></button>
          </div>
        </>
      )}
    </div>
  );

  const toolBtn = "flex items-center gap-1.5 border border-line px-3 h-9 rounded-lg text-[12.5px] text-ink hover:bg-surface-2 hover:border-line-3 transition-colors";

  return (
    <div className="max-w-2xl">
      <p className="text-[12px] text-muted mb-4 leading-relaxed">
        Manage client category labels and subcategories. Categories help organize and filter clients.
      </p>

      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <button onClick={toggleSort} title="Toggle sort order" className={toolBtn}>
          <ArrowDownAZ size={13} className={sortDesc ? "rotate-180" : ""} />
          {sortDesc ? "Sort Z→A" : "Sort A→Z"}
        </button>
        <div className="w-px h-5 bg-line-2 mx-0.5" />
        <button onClick={pickFile} className={toolBtn}>
          <Upload size={13} /> Import from spreadsheet
        </button>
        <button onClick={pickSheet} className={toolBtn}>
          <Sheet size={13} /> Import from connected Sheet
        </button>
        {hasDupes && (
          <button onClick={dedupe} disabled={deduping} className={toolBtn} title="Merge categories with the same name">
            <Wand2 size={13} /> {deduping ? "Cleaning up…" : "Clean up duplicates"}
          </button>
        )}
        {addedMsg && <span className="text-[12px] text-success-ink font-medium ml-1">{addedMsg}</span>}
      </div>

      {/* Import panel — shared by the spreadsheet-file and connected-Sheet sources */}
      {imp && (
        <div className="bg-surface border border-line rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
              {imp.source === "sheet" ? <Sheet size={14} className="text-muted" /> : <Upload size={14} className="text-muted" />}
              {imp.source === "sheet" ? "Import categories from connected Sheet" : "Import categories from spreadsheet"}
            </div>
            <button onClick={() => setImp(null)} className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3"><X size={14} /></button>
          </div>
          {imp.source === "csv" && (
            <>
              <div className="text-[11.5px] text-muted mb-3">{imp.total} rows detected. Choose the column that holds the category.</div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {imp.headers.map((h, i) => (
                  <button key={i} onClick={() => pickColumn(i)}
                    className={`px-2.5 h-8 rounded-lg text-[12px] border transition-colors ${imp.col === i ? "bg-accent text-on-accent border-accent" : "border-line text-ink hover:bg-surface-2"}`}>
                    {h || `Column ${i + 1}`}
                  </button>
                ))}
              </div>
            </>
          )}
          {imp.loading && <div className="text-[12px] text-muted py-2">{imp.source === "sheet" ? "Reading connected Sheet…" : "Reading column…"}</div>}
          {imp.col !== null && !imp.loading && (
            imp.values.length === 0
              ? <div className="text-[12px] text-muted py-2">{imp.source === "sheet" ? "No category values found in the connected Sheet." : "No values found in that column."}</div>
              : <>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[12px] text-muted">{imp.values.length} distinct value{imp.values.length === 1 ? "" : "s"} — new ones are pre-selected.</div>
                    <div className="flex gap-3 text-[11.5px]">
                      <button className="text-accent" onClick={() => setImp({ ...imp, chosen: Object.fromEntries(imp.values.map((v) => [v, true])) })}>All</button>
                      <button className="text-muted hover:text-ink-2" onClick={() => setImp({ ...imp, chosen: {} })}>None</button>
                    </div>
                  </div>
                  <div className="max-h-56 overflow-auto border border-line rounded-lg divide-y divide-line-2 mb-3">
                    {imp.values.map((v) => {
                      const exists = existingLabels.has(v.trim().toLowerCase());
                      return (
                        <label key={v} className="flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer hover:bg-surface-2/50">
                          <input type="checkbox" checked={!!imp.chosen[v]} onChange={(e) => setImp({ ...imp, chosen: { ...imp.chosen, [v]: e.target.checked } })} />
                          <span className="flex-1 text-ink">{v}</span>
                          {exists && <span className="text-[10.5px] text-muted">already exists</span>}
                        </label>
                      );
                    })}
                  </div>
                  <button onClick={runImport} disabled={importing || chosenCount === 0}
                    className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
                    {importing ? "Adding…" : `Add ${chosenCount} categor${chosenCount === 1 ? "y" : "ies"}`}
                  </button>
                </>
          )}
        </div>
      )}

      {/* Add row */}
      <div className="flex gap-2 mb-5">
        <select value={newParent} onChange={(e) => setNewParent(e.target.value)}
          className="border border-line px-2.5 h-10 rounded-lg text-[13px] bg-surface max-w-[170px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors">
          <option value="">Top-level</option>
          {tops.map((t) => <option key={t.id} value={t.id}>Under: {t.label}</option>)}
        </select>
        <input id="cat-new-input" placeholder={newParent ? "New subcategory…" : "New category name…"} value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          className={`${inp} flex-1`} />
        <button onClick={create} disabled={!newLabel.trim()}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors shrink-0">
          <Plus size={13} /> Add
        </button>
      </div>

      {/* Tree */}
      {cats.length === 0 ? (
        <div className="bg-surface border border-dashed border-line rounded-xl py-12 px-6 text-center">
          <div className="mx-auto w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center text-muted mb-3"><Tag size={17} /></div>
          <div className="text-[13px] font-medium text-ink-2">No categories yet</div>
          <div className="text-[12px] text-muted mt-1 max-w-xs mx-auto leading-relaxed">Add one above, or import your existing labels from a spreadsheet or your connected Sheet.</div>
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
          {tops.map((c) => (
            <div key={c.id}>
              {renderRow(c)}
              {childrenOf(c.id).map((ch) => renderRow(ch, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One shared Google connection powers email sending, sheet sync/write-back, and
// Sheet copy. It used to be reachable ONLY by ticking a checkbox in the Email tab,
// so users who don't send via Gmail could never find it. This surfaces it right in
// the Google Sheets tab (and it's the same token — connecting here connects
// everywhere). Reconnect works with the saved credentials (no re-entry).
function GoogleConnectCard() {
  const [gStatus, setGStatus] = useState<{ connected: boolean; email?: string; scopes?: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => api.googleEmailStatus().then((s) => setGStatus(s)).catch(() => setGStatus(null));
  useEffect(() => { refresh(); }, []);

  const connect = async () => {
    setConnecting(true); setErr(null);
    try {
      if (clientId) await api.saveCredential("oauth_client_id", clientId);
      if (clientSecret) await api.saveCredential("oauth_client_secret", clientSecret);
      await api.oauthStartConsent(clientId, clientSecret); // blanks fall back to saved creds server-side
      await refresh();
    } catch (e: any) { setErr(String(e)); }
    finally { setConnecting(false); }
  };

  if (showGuide) return <GoogleCloudGuide onBack={() => { setShowGuide(false); refresh(); }} />;

  const connected = !!gStatus?.connected;
  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Cloud size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-ink">Google account</span>
        {connected && <span className="ml-1"><ConnectedPill ok /></span>}
      </div>
      <p className="text-[12px] text-muted mb-3 max-w-xl">
        One Google connection powers sheet sync, write-back, and Sheet copy.{" "}
        {connected
          ? "Reconnect only if you added new Google access or need to switch accounts."
          : "Connect once to turn these on (uses your own Google Cloud credentials)."}
      </p>
      {connected && gStatus?.email && (
        <div className="text-[12px] mb-3 flex items-center gap-1.5">
          <span className="text-muted">Connected as</span>
          <span className="font-medium text-ink">{gStatus.email}</span>
        </div>
      )}
      {connected && gStatus?.scopes !== undefined && !gStatus.scopes.includes("spreadsheets") && (
        <div className="text-[12px] text-warning-ink bg-warning-bg border border-warning rounded-lg px-3 py-2 mb-3 flex items-start gap-1.5">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>This connection is missing Google Sheets access. Click Reconnect to grant it (needed for sheet sync and Sheet copy).</span>
        </div>
      )}
      {!connected && (
        <div className="space-y-2 max-w-sm mb-3">
          <SecretInput label="Google Client ID" value={clientId} onChange={setClientId} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="Google Client Secret" value={clientSecret} onChange={setClientSecret} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <button type="button" onClick={() => setShowGuide(true)} className="text-[12px] text-accent hover:underline">
            How do I get these?
          </button>
        </div>
      )}
      <button
        onClick={connect}
        disabled={connecting || (!connected && (!clientId || !clientSecret))}
        className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
      >
        {connecting ? <><RefreshCw size={13} className="animate-spin" /> Connecting…</> : connected ? <><RefreshCw size={13} /> Reconnect</> : <><Cloud size={13} /> Connect Google</>}
      </button>
      {err && <div className="text-danger-ink text-[12.5px] mt-2 flex items-center gap-1.5"><AlertCircle size={13} /> {err}</div>}
    </div>
  );
}

function SheetsTab() {
  const [config,  setConfig]  = useState<SheetSyncConfig>({
    id: 1, sheet_url: null, name_col: "", first_name_col: "F", last_name_col: "G",
    email_col: "I", phone_col: "J", company_col: "E", category_col: "P",
    lead_status_col: "V", notes_col: "AA", skip_header_rows: 1,
    last_synced_at: null, last_synced_count: 0, field_mapping_json: null,
    writeback_enabled: true,
  });
  const [saving,  setSaving]  = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result,  setResult]  = useState<SheetSyncResult | null>(null);
  const [log,     setLog]     = useState<SheetSyncLogEntry[]>([]);
  const [customFields, setCustomFields] = useState<{ value: string; label: string }[]>([]);
  const [wbStatus, setWbStatus] = useState<SheetWritebackStatus | null>(null);
  const [pushingAll, setPushingAll] = useState(false);
  const [pushAllMsg, setPushAllMsg] = useState<string | null>(null);

  const refreshWbStatus = () => { api.sheetWritebackStatus().then(setWbStatus).catch(() => {}); };

  // Bulk push: append every active client not already on the sheet. Explicit action,
  // so it confirms first and surfaces a plain-language result (or error).
  const syncAllClients = async () => {
    if (!confirm("Add every active client that isn't already in the sheet?")) return;
    setPushingAll(true);
    setPushAllMsg(null);
    try {
      const r = await api.syncAllClientsToSheet();
      setPushAllMsg(`Added ${r.added}, skipped ${r.skipped} already present`);
    } catch (e: any) {
      setPushAllMsg(null);
      alert(e);
    }
    setPushingAll(false);
  };

  useEffect(() => {
    api.getSheetSyncConfig().then(setConfig).catch(() => {});
    api.getSheetSyncLog().then(setLog).catch(() => {});
    api.getIntakeFields().then((fs) => setCustomFields(fs.filter((f) => f.value.startsWith("cf:")))).catch(() => {});
    refreshWbStatus();
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api.saveSheetSyncConfig(config); refreshWbStatus(); } catch (e: any) { alert(e); }
    setSaving(false);
  };

  // Toggle write-back and persist immediately (the toggle should feel instant, not
  // require hitting "Save Config"). Reverts + surfaces the error if the save fails.
  const toggleWriteback = async () => {
    const next = { ...config, writeback_enabled: !config.writeback_enabled };
    setConfig(next);
    try { await api.saveSheetSyncConfig(next); refreshWbStatus(); }
    catch (e: any) { setConfig(config); alert(e); }
  };

  const syncNow = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const r = await api.syncFromSheet();
      setResult(r);
      api.getSheetSyncConfig().then(setConfig).catch(() => {});
      api.getSheetSyncLog().then(setLog).catch(() => {});
    } catch (e: any) { alert(e); }
    setSyncing(false);
  };

  // field_mapping_json is { columnLetter: target }; invert to { target: column } for the pickers.
  const fieldToCol: Record<string, string> = {};
  try {
    const m = JSON.parse(config.field_mapping_json || "{}");
    for (const [col, target] of Object.entries(m)) if (typeof target === "string") fieldToCol[target] = col;
  } catch { /* ignore */ }
  const setCustomFieldCol = (cfValue: string, col: string) => {
    const next: Record<string, string> = {};
    try {
      const m = JSON.parse(config.field_mapping_json || "{}");
      for (const [c, t] of Object.entries(m)) if (typeof t === "string" && !t.startsWith("cf:")) next[c] = t; // preserve non-custom mappings
    } catch { /* ignore */ }
    const updated: Record<string, string> = { ...fieldToCol, [cfValue]: col };
    for (const [t, c] of Object.entries(updated)) if (t.startsWith("cf:") && c) next[c] = t;
    setConfig({ ...config, field_mapping_json: JSON.stringify(next) });
  };

  const columns = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `A${c}`)];

  const relTime = (d: string | null | undefined): string => {
    if (!d) return "Never";
    const ms = Date.now() - new Date(d).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return `${Math.floor(hrs / 24)} days ago`;
  };

  const colSelect = "border border-line h-9 px-2 rounded-lg text-[12px] w-full bg-surface focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent transition-colors";

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[12px] text-muted">
          Share your Google Sheet as <strong className="text-ink-2">'Anyone with link can view'</strong>, paste the URL below. Ecliptr pulls new clients in automatically every 10 minutes, and — once you approve a lead — writes it back out as a new row.
        </p>
        <GuideLink section="sheets" />
      </div>

      {/* Google connection — lives here so it's findable (not buried in Email) */}
      <GoogleConnectCard />

      {/* Setup */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <SectionLabel>Sheet Setup</SectionLabel>
        <div className="space-y-3 mt-3">
          <Field label="Google Sheet URL">
            <input className={inp} placeholder="https://docs.google.com/spreadsheets/d/..." value={config.sheet_url ?? ""} onChange={(e) => setConfig({ ...config, sheet_url: e.target.value })} />
          </Field>
          <Advanced label="Column mapping">
          <div className="grid grid-cols-3 xl:grid-cols-5 gap-3">
            {[
              { label: "First Name", key: "first_name_col" as const, val: config.first_name_col, hint: "F" },
              { label: "Last Name",  key: "last_name_col"  as const, val: config.last_name_col,  hint: "G" },
              { label: "Email",      key: "email_col"      as const, val: config.email_col,      hint: "I" },
              { label: "Phone",      key: "phone_col"      as const, val: config.phone_col,      hint: "J" },
              { label: "Company",    key: "company_col"    as const, val: config.company_col,    hint: "E" },
              { label: "Category",   key: "category_col"   as const, val: config.category_col,   hint: "P" },
              { label: "Lead Status",key: "lead_status_col"as const, val: config.lead_status_col,hint: "V" },
              { label: "Notes",      key: "notes_col"      as const, val: config.notes_col,      hint: "AA" },
              { label: "Fallback",   key: "name_col"       as const, val: config.name_col,       hint: "—" },
            ].map((f) => (
              <div key={f.key}>
                <label className="block text-[10px] font-medium text-muted mb-1">
                  {f.label} <span className="text-faint">({f.hint})</span>
                </label>
                <select
                  value={f.val}
                  onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                  className={colSelect}
                >
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
          </div>
          {customFields.length > 0 && (
            <div>
              <label className="block text-[10px] font-medium text-muted mb-1.5">Custom fields — pick the column each lives in</label>
              <div className="grid grid-cols-3 xl:grid-cols-5 gap-3">
                {customFields.map((f) => (
                  <div key={f.value}>
                    <label className="block text-[10px] font-medium text-muted mb-1 truncate" title={f.label}>{f.label}</label>
                    <select
                      value={fieldToCol[f.value] ?? ""}
                      onChange={(e) => setCustomFieldCol(f.value, e.target.value)}
                      className={colSelect}
                    >
                      <option value="">—</option>
                      {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="w-32">
            <label className="block text-[10px] font-medium text-muted mb-1">Skip header rows</label>
            <NumberInput integer value={config.skip_header_rows} onValue={(n) => setConfig({ ...config, skip_header_rows: Math.max(0, n) })} className={inpSm} />
          </div>
          </Advanced>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <Save size={13} /> {saving ? "Saving..." : "Save Config"}
          </button>
        </div>
      </div>

      {/* Write-back: approved lead → new sheet row */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SectionLabel>Sync approvals back to the sheet</SectionLabel>
            <p className="text-[12px] text-muted mt-2 max-w-xl">
              When you approve a captured lead, Ecliptr adds it as a new row on this sheet —
              mapped to the same columns above. Runs on approvals made here on the desktop.
            </p>
          </div>
          <button
            onClick={toggleWriteback}
            role="switch"
            aria-checked={config.writeback_enabled}
            title={config.writeback_enabled ? "Turn write-back off" : "Turn write-back on"}
            className={`shrink-0 w-11 h-6 rounded-full relative transition-colors ${config.writeback_enabled ? "bg-accent" : "bg-surface-3"}`}
          >
            <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${config.writeback_enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
          </button>
        </div>

        {wbStatus && (
          <div
            className={`mt-3 flex items-start gap-2 text-[12px] px-3 py-2 rounded-lg border ${
              wbStatus.state === "active"
                ? "bg-success-bg text-success-ink border-success"
                : wbStatus.state === "disabled"
                ? "bg-surface-2 text-muted border-line"
                : "bg-warning-bg text-warning-ink border-warning"
            }`}
          >
            {wbStatus.state === "active"
              ? <Check size={14} className="mt-0.5 shrink-0" />
              : wbStatus.state === "disabled"
              ? <X size={14} className="mt-0.5 shrink-0" />
              : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
            <span>
              {wbStatus.message}
              {wbStatus.state === "not_connected" && (
                <> Use the <strong className="text-ink-2">Google account</strong> card at the top of this tab to connect (or Reconnect, if you connected before Sheets access was added).</>
              )}
            </span>
          </div>
        )}

        {/* One-shot bulk push: every active client that isn't already in the sheet. */}
        <div className="mt-4 pt-4 border-t border-line-2 flex items-center gap-3 flex-wrap">
          <button
            onClick={syncAllClients}
            disabled={pushingAll || !config.sheet_url}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} className={pushingAll ? "animate-spin" : ""} /> {pushingAll ? "Syncing..." : "Sync all clients to the sheet now"}
          </button>
          {pushAllMsg && <span className="text-[12px] text-success-ink">{pushAllMsg}</span>}
        </div>
      </div>

      {/* Sync */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <SectionLabel>Sync</SectionLabel>
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={syncNow}
            disabled={syncing || !config.sheet_url}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <span className="text-[12px] text-muted">
            {config.last_synced_at ? `Last sync: ${relTime(config.last_synced_at)}` : "Never synced"}
            {config.last_synced_count > 0 && ` — ${config.last_synced_count} clients added`}
          </span>
        </div>
        <div className="text-[11px] text-faint mt-1.5">Auto-syncs every 10 minutes</div>

        {result && (
          <div className={`mt-3 text-[12px] px-3 py-2 rounded-lg ${result.errors.length > 0 ? "bg-warning-bg text-warning-ink border border-warning" : "bg-success-bg text-success-ink border border-success"}`}>
            {result.new_clients} new clients added, {result.skipped_duplicates} duplicates skipped
            {result.errors.length > 0 && (
              <button onClick={() => alert(result.errors.join("\n"))} className="ml-2 underline text-[11px]">
                {result.errors.length} errors
              </button>
            )}
          </div>
        )}
      </div>

      {/* Sync log */}
      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <div className="px-5 py-3 border-b border-line-2">
          <span className="text-[12.5px] font-medium text-muted">Sync History</span>
        </div>
        {log.length === 0 ? (
          <div className="text-center text-[13px] text-muted py-8">No syncs yet</div>
        ) : (
          <table className="w-full min-w-[440px] text-sm">
            <thead className="bg-surface-2/50">
              <tr>
                <th className="text-left px-5 py-2.5 text-[12px] font-medium text-muted">Date</th>
                <th className="text-right px-5 py-2.5 text-[12px] font-medium text-muted">New</th>
                <th className="text-right px-5 py-2.5 text-[12px] font-medium text-muted">Skipped</th>
                <th className="text-right px-5 py-2.5 text-[12px] font-medium text-muted">Errors</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id} className="border-t border-line-2 hover:bg-surface-2/40 transition-colors">
                  <td className="px-5 py-2.5 text-[12px] text-ink-2">{new Date(l.synced_at).toLocaleString()}</td>
                  <td className="px-5 py-2.5 text-[12px] text-success-ink text-right tabular-nums">{l.new_clients}</td>
                  <td className="px-5 py-2.5 text-[12px] text-muted text-right tabular-nums">{l.skipped_duplicates}</td>
                  <td className="px-5 py-2.5 text-[12px] text-right">
                    {l.errors ? <span className="text-warning-ink">{JSON.parse(l.errors).length}</span> : <span className="text-faint">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SplitsTab() {
  type ShareKind = "person" | "business" | "investment" | "other";
  type Share = { name: string; pct: number; is_business: boolean; kind: ShareKind };
  const KIND_LABEL: Record<ShareKind, string> = { person: "Person", business: "Business", investment: "Investment", other: "Other" };
  const NAME_PLACEHOLDER: Record<ShareKind, string> = { person: "Name", business: "Business", investment: "Investment fund", other: "Label" };
  const [shares, setShares] = useState<Share[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Raw editing buffer for the percentage inputs so a field can be cleared and
  // partial values ("", "33.") survive while typing — the numeric state stays in
  // sync. Without this a controlled number input coerces empty→0 and can't clear.
  const [pctText, setPctText] = useState<Record<number, string>>({});

  const reloadStaff = () => api.listStaff().then((s) => setStaff(s.filter((x) => x.status === "active"))).catch(() => {});
  useEffect(() => {
    // Older saves have no kind — derive it for display; nothing is written back until the user edits.
    api.getPayoutSplit().then((list) => setShares(list.map((s) => ({
      ...s,
      kind: ((s.kind === "person" || s.kind === "business" || s.kind === "investment" || s.kind === "other") ? s.kind : (s.is_business ? "business" : "person")) as ShareKind,
    })))).catch(() => {});
    reloadStaff().finally(() => setLoaded(true));
  }, []);

  const total = shares.reduce((a, s) => a + (Number(s.pct) || 0), 0);
  const valid = Math.abs(total - 100) < 0.01;
  const remaining = Math.round((100 - total) * 100) / 100;
  // Honest save state: the old autosave silently did NOTHING when the total wasn't
  // exactly 100 (and swallowed API errors), so an edit could look saved while the
  // brief kept paying out the previously stored split. Now the card always says
  // whether what's on screen is actually stored.
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "error">("saved");
  const [saveErr, setSaveErr] = useState("");
  const persist = (next: Share[]) => {
    setShares(next);
    if (Math.abs(next.reduce((a, s) => a + (Number(s.pct) || 0), 0) - 100) < 0.01) {
      setSaveState("saving");
      api.savePayoutSplit(next)
        .then(() => { setSaveState("saved"); setSaveErr(""); })
        .catch((e: any) => { setSaveState("error"); setSaveErr(String(e)); });
    } else {
      setSaveState("unsaved");
    }
  };
  // Auto-math: drop the leftover (or overage) onto the Business share — or the last
  // recipient if none is marked Business — so the split always totals 100% and no
  // money is left unallocated.
  const balance = () => {
    if (!shares.length) return;
    const bizIdx = shares.findIndex((s) => s.is_business);
    const idx = bizIdx >= 0 ? bizIdx : shares.length - 1;
    const others = shares.reduce((a, s, i) => (i === idx ? a : a + (Number(s.pct) || 0)), 0);
    persist(shares.map((s, i) => (i === idx ? { ...s, pct: Math.round(Math.max(0, 100 - others) * 100) / 100 } : s)));
  };
  const setShare = (i: number, patch: Partial<Share>) => persist(shares.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  // Clear the edit buffer on removal so buffered strings don't misalign to the
  // wrong row after indices shift.
  const removeShare = (i: number) => { setPctText({}); persist(shares.filter((_, idx) => idx !== i)); };

  const PAY_TYPES: [string, string][] = [["profit_pct", "Profit %"], ["gross_pct", "Gross %"], ["fixed", "Fixed $"]];
  const setRepType = async (id: string, payType: string) => { await api.updateStaff(id, { payType }); reloadStaff(); };
  const setRepVal = async (id: string, commissionPct: number) => { await api.updateStaff(id, { commissionPct }); };

  // Live preview off an editable sample profit, using the first rep with a profit-% rule.
  const [sample, setSample] = useState(10000);
  const previewRep = staff.find((u) => ((u as any).pay_type || "profit_pct") === "profit_pct" && u.commission_pct > 0);
  const repCut = previewRep ? sample * (previewRep.commission_pct / 100) : 0;
  const remainder = sample - repCut;

  if (!loaded) return <div className="text-sm text-muted py-8 text-center">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <SettingCard icon={Users} title="Sales reps" purpose="Each person's cut when they're the deal's lead rep — taken first, off the top.">
        {staff.length === 0 ? (
          <div className="text-[12.5px] text-muted">No team members yet — invite people from the Team tab.</div>
        ) : (
          <div className="divide-y divide-line">
            {staff.map((u) => (
              <div key={u.id} className="grid grid-cols-[minmax(0,1fr)_220px_96px] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{u.display_name}</div>
                  {u.role_name ? <div className="text-[11px] text-muted truncate">{u.role_name}</div> : null}
                </div>
                <Segmented value={(u as any).pay_type || "profit_pct"} onChange={(v) => setRepType(u.id, v)}
                  options={PAY_TYPES.map(([v, l]) => ({ value: v, label: l }))} />
                <div className="flex items-center gap-1.5">
                  <input type="text" inputMode="decimal" defaultValue={u.commission_pct} onBlur={(e) => setRepVal(u.id, parseAmount(e.target.value))}
                    className={`${inpSm} text-right tabular-nums`} />
                  <span className="w-3 shrink-0 text-[12px] text-muted">{((u as any).pay_type || "profit_pct") === "fixed" ? "$" : "%"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingCard>

      <SettingCard icon={Split} title="Profit split" purpose="Whatever's left after the rep's cut is divided by these recipients — people, the business, investment set-asides, anything. Saves when the total is exactly 100%."
        aside={
          <span className={`text-[12.5px] font-medium tabular-nums ${
            !valid ? "text-warning-ink" : saveState === "error" ? "text-danger-ink" : saveState === "saved" ? "text-success-ink" : "text-muted"
          }`}>
            {!valid
              ? `Not saved — total is ${total.toFixed(1)}% (${remaining > 0 ? `${remaining}% left` : `${Math.abs(remaining)}% over`})`
              : saveState === "error" ? `Couldn't save — ${saveErr}`
              : saveState === "saved" ? "Saved · 100%"
              : "Saving…"}
          </span>
        }>
        {shares.length === 0 ? (
          <div className="text-[12.5px] text-muted">No recipients yet — add people, the business, or an investment share to define the split.</div>
        ) : (
          <div className="space-y-2">
            {shares.map((s, i) => (
              <div key={i} className="grid grid-cols-[128px_minmax(0,1fr)_112px_28px] items-center gap-2">
                <select value={s.kind} onChange={(e) => { const k = e.target.value as ShareKind; setShare(i, { kind: k, is_business: k === "business" }); }} className={inpSm}>
                  {(Object.keys(KIND_LABEL) as ShareKind[]).map((k) => (
                    <option key={k} value={k} disabled={k === "business" && s.kind !== "business" && shares.some((o, oi) => oi !== i && o.is_business)}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
                <input value={s.name} onChange={(e) => setShare(i, { name: e.target.value })} placeholder={NAME_PLACEHOLDER[s.kind]} className={`${inpSm} min-w-0`} />
                <div className="flex items-center gap-1.5">
                  <input
                    type="text" inputMode="decimal"
                    value={pctText[i] ?? (s.pct === 0 ? "" : String(s.pct))}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setPctText((m) => ({ ...m, [i]: raw }));
                      const n = parseFloat(raw);
                      setShare(i, { pct: Number.isFinite(n) ? n : 0 });
                    }}
                    onBlur={() => setPctText((m) => { const { [i]: _drop, ...rest } = m; return rest; })}
                    className={`${inpSm} text-right tabular-nums`} />
                  <span className="w-3 shrink-0 text-[12px] text-muted">%</span>
                </div>
                <button onClick={() => removeShare(i)} className="h-9 w-7 flex items-center justify-center text-muted hover:text-danger-ink transition-colors" title="Remove"><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <button onClick={() => setShares([...shares, { name: "", pct: Math.max(0, remaining), is_business: false, kind: "person" }])}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium border border-line rounded-lg px-3 h-8 text-ink-2 hover:bg-surface-2 transition-colors"><Plus size={13} /> Add recipient</button>
          {!valid && shares.length > 0 && (
            <button onClick={balance} className="ml-auto text-[12px] font-medium border border-accent/40 text-accent rounded-lg px-3 h-8 hover:bg-accent/10 transition-colors">Balance to 100%</button>
          )}
        </div>
      </SettingCard>

      <SettingCard icon={Eye} title="Preview" purpose="Type any deal profit to see exactly how it would be divided under today's rules.">
        <div className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-2 mb-3">
          <span className="text-[13px] text-muted">Amount to analyze</span>
          <div className="flex items-center gap-1.5">
            <span className="w-3 shrink-0 text-[12px] text-muted">$</span>
            <NumberInput value={sample} onValue={(n) => setSample(Math.max(0, n))}
              className={`${inpSm} text-right tabular-nums`} />
          </div>
        </div>
        <div className="text-[13px] space-y-1.5">
          {previewRep && <div className="flex justify-between"><span className="text-ink-2">Rep cut — {previewRep.display_name} ({previewRep.commission_pct}%)</span><span className="tabular-nums text-ink">${repCut.toFixed(2)}</span></div>}
          <div className="flex justify-between border-t border-line pt-1.5"><span className="text-ink-2 font-medium">Remainder</span><span className="tabular-nums text-ink font-medium">${remainder.toFixed(2)}</span></div>
          {shares.map((s, i) => (
            <div key={i} className="flex justify-between pl-3">
              <span className="text-muted">{s.name || "—"} <span className="text-faint">· {KIND_LABEL[s.kind]}</span> · <span className="tabular-nums">{s.pct}%</span></span>
              <span className="tabular-nums text-ink">${(remainder * (Number(s.pct) || 0) / 100).toFixed(2)}</span>
            </div>
          ))}
          {!previewRep && <p className="text-[11px] text-muted pt-1">No rep with a profit-% rule yet — the full profit goes to the split above.</p>}
        </div>
      </SettingCard>
    </div>
  );
}

function BackupTab() {
  const [status, setStatus] = useState<{ last_backup: string | null; backup_dir: string } | null>(null);
  const [backups, setBackups] = useState<{ filename: string; size: number; date: string; is_valid: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, b] = await Promise.all([api.getBackupStatus(), api.listBackups()]);
      setStatus(s);
      setBackups(b);
    } catch {}
  };
  useEffect(() => { load(); }, []);

  const handleBackup = async () => {
    setBusy(true); setMsg(null);
    try {
      const p = await api.backupDatabase();
      setMsg(`Backed up to ${p.split(/[\\/]/).pop()}`);
      load();
    } catch (e: any) { setMsg(e.toString()); }
    setBusy(false);
  };

  const handleRestore = async (filename: string, isValid: boolean) => {
    if (!isValid) { alert("This backup is corrupted and cannot be restored."); return; }
    const dateStr = filename.replace("clienthub-backup-", "").replace(".db", "");
    if (!confirm(`Restore from ${dateStr}? This will replace ALL current data and restart the app. This cannot be undone.`)) return;
    setBusy(true);
    try {
      const dir = status?.backup_dir || "";
      await api.restoreDatabase(dir + "/" + filename);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: any) { setMsg(e.toString()); setBusy(false); }
  };

  const handleDirChange = async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({ directory: true });
    if (typeof selected !== "string") return;
    setBusy(true);
    try { await api.backupDatabase(selected); load(); } catch (e: any) { setMsg(e.toString()); }
    setBusy(false);
  };

  const fmtSize = (b: number) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
  const lastTime = status?.last_backup ? new Date(status.last_backup).toLocaleString() : "Never";

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Database Backup</h3>
      <p className="text-[12px] text-muted mb-5">Automatic daily backups. Restore if something goes wrong.</p>

      <div className="space-y-3 mb-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12.5px] font-medium text-muted">Backup location</p>
            <p className="text-[12px] text-ink-2 font-mono mt-0.5">{status?.backup_dir || "—"}</p>
          </div>
          <button onClick={handleDirChange} className="text-[11px] text-accent hover:text-accent-hover">Change</button>
        </div>
        <div>
          <p className="text-[12.5px] font-medium text-muted">Last backup</p>
          <p className="text-[13px] text-ink-2 mt-0.5">{lastTime}</p>
        </div>
      </div>

      <div className="flex gap-2 mb-5">
        <button onClick={handleBackup} disabled={busy} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Backup Now
        </button>
      </div>

      {msg && <p className="text-[12px] text-success-ink font-medium mb-4">{msg}</p>}

      {backups.length > 0 && (
        <div>
          <p className="text-[12.5px] font-medium text-muted mb-2">Backups ({backups.length})</p>
          <div className="space-y-1">
            {backups.map((b) => (
              <div key={b.filename} className="flex items-center justify-between px-3 py-2 bg-surface-2 rounded-lg">
                <div>
                  <p className="text-[12px] font-medium text-ink-2 flex items-center gap-1.5">
                    {b.date} {!b.is_valid && <span title="Backup may be corrupted" className="text-danger-ink text-[14px]">&#9888;</span>}
                  </p>
                  <p className="text-[11px] text-muted">{fmtSize(b.size)}</p>
                </div>
                <button onClick={() => handleRestore(b.filename, b.is_valid)} disabled={busy} className="text-[11px] text-danger-ink hover:text-danger-ink font-medium disabled:opacity-50">Restore</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const MODULE_LABELS: Record<string, string> = {
  clients: "Clients", inventory: "Inventory", deal_flow: "Deals & pay (financial)",
  quotes: "Quotes", email: "Email", manifests: "Manifests",
  analytics: "Analytics & reports", financials: "Financials (books, bank & free cash)",
  settings: "Settings",
};
const MATRIX_MODULES = ["clients", "inventory", "deal_flow", "quotes", "email", "manifests", "analytics", "financials", "settings"];
const ACTIONS = ["view", "edit", "export"] as const;
// Sensitive per-role visibility flags (separate from the module×action grid).
const VIS_TOGGLES: [string, string, string][] = [
  ["clients:view_revenue", "See exact client spend", "Off: rep sees tier rank only, not dollar amounts"],
  ["suppliers:view", "See suppliers", "Off: the Suppliers area is hidden"],
  ["deal_flow:view_numbers", "See deal-flow dollar amounts", "Off: deals stay visible, money is hidden"],
];

function TeamTab() {
  const [sub, setSub] = useState<"people" | "roles" | "approvals" | "invites" | "payouts">("people");
  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit mb-4">
        {(["people", "roles", "approvals", "invites", "payouts"] as const).map((s) => (
          <button key={s} onClick={() => setSub(s)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors capitalize ${sub === s ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {s}
          </button>
        ))}
      </div>
      {sub === "people" && <PeoplePanel />}
      {sub === "roles" && <RolesPanel />}
      {sub === "approvals" && <ApprovalPolicyPanel />}
      {sub === "invites" && <InvitesPanel />}
      {sub === "payouts" && <PayoutsPanel />}
    </div>
  );
}

function PayoutsPanel() {
  const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
  const monthEnd = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10); };
  const [start, setStart] = useState(monthStart());
  const [end, setEnd] = useState(monthEnd());
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setErr(null);
    api.listRepPayouts(start, end).then(setData).catch((e: any) => setErr(typeof e === "string" ? e : e?.message || "Failed to load"));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markPaid = (repId: string, owed: number) => {
    setBusy(true);
    api.markRepPayoutPaid(repId, start, end, owed).then(() => load()).catch((e: any) => setErr(typeof e === "string" ? e : e?.message || "Failed")).finally(() => setBusy(false));
  };

  const payouts: any[] = (data && data.payouts) || [];
  return (
    <SettingCard icon={Receipt} title="Rep payouts" purpose="What each rep is owed for completed deals in the period.">
      <div className="space-y-4">
        {data && !data.enabled && (
          <div className="text-[12.5px] text-muted">Rep payouts are off. Turn them on under <strong>People</strong> first.</div>
        )}
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">From</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={`${inpSm} w-36`} />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">To</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={`${inpSm} w-36`} />
          </div>
          <button onClick={load} className="h-9 px-3.5 border border-line rounded-lg text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 transition-colors">Show</button>
        </div>
        {payouts.length === 0 ? (
          <div className="text-[12.5px] text-muted py-4 text-center">No rep payouts for completed deals in this period.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Rep</th>
                  <th className="text-left px-3 py-2 text-[12px] font-medium text-muted">Deals</th>
                  <th className="text-right px-3 py-2 text-[12px] font-medium text-muted">Owed</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {payouts.map((p) => (
                  <tr key={p.rep_id}>
                    <td className="px-3 py-2.5 font-medium text-ink">{p.name}</td>
                    <td className="px-3 py-2.5 text-muted">{p.deals}{p.refunded_deals > 0 ? ` · ${p.refunded_deals} refunded` : ""}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-ink">{fmtAmount(p.owed)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button disabled={busy} onClick={() => markPaid(p.rep_id, p.owed)}
                        className="px-2.5 h-7 border border-line rounded-lg text-[11.5px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors">Mark paid</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {payouts.length > 1 && (
                <tfoot>
                  <tr className="border-t border-line">
                    <td colSpan={2} className="px-3 py-2.5 text-[12px] text-muted">Total owed</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium text-ink">{fmtAmount(payouts.reduce((a, p) => a + (Number(p.owed) || 0), 0))}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {err && <div className="text-[12px] text-danger-ink flex items-center gap-1.5"><AlertCircle size={13} /> {err}</div>}
      </div>
    </SettingCard>
  );
}

function ApprovalPolicyPanel() {
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState(false);
  const [vis, setVis] = useState("team");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.getApprovalPolicy().then((p) => {
      setAdd(!!p.require_client_add_approval);
      setDel(!!p.require_client_delete_approval);
      if ((p as any).checkup_visibility) setVis((p as any).checkup_visibility);
    }).catch(() => {});
  }, []);
  const saveVis = async (v: string) => { setVis(v); await api.setCheckupVisibility(v).catch(() => {}); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  const save = async (nextAdd: boolean, nextDel: boolean) => {
    setAdd(nextAdd); setDel(nextDel);
    await api.setApprovalPolicy(nextAdd, nextDel).catch(() => {});
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };
  const Row = ({ label, hint, on, onToggle }: { label: string; hint: string; on: boolean; onToggle: () => void }) => (
    <label className="flex items-start justify-between gap-4 py-3 cursor-pointer">
      <div>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[11px] text-muted mt-0.5">{hint}</div>
      </div>
      <input type="checkbox" checked={on} onChange={onToggle} className="mt-1" />
    </label>
  );
  return (
    <div className="bg-surface border border-line rounded-xl p-5 max-w-xl">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-[14px] font-semibold text-ink">Client approvals</h4>
        {saved && <span className="text-[11px] text-emerald-500">Saved</span>}
      </div>
      <p className="text-[12px] text-muted mb-2">When on, a rep's action is held for an admin to approve from the notification bell. Admins and the owner always act immediately.</p>
      <div className="divide-y divide-line">
        <Row label="Require approval to add clients" hint="New clients a rep creates wait for admin approval before going active." on={add} onToggle={() => save(!add, del)} />
        <Row label="Require approval to delete clients" hint="A rep's delete is sent to an admin instead of removing the client." on={del} onToggle={() => save(add, !del)} />
      </div>

      <div className="mt-5 pt-4 border-t border-line">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-medium text-ink">Checkup session visibility</div>
            <div className="text-[11px] text-muted mt-0.5">Who can see each other's checkup sessions. Admins always see all.</div>
          </div>
          <select value={vis} onChange={(e) => saveVis(e.target.value)} className="bg-surface-2 border border-line rounded-lg h-8 px-2 text-[12px] text-ink">
            <option value="team">Whole team</option>
            <option value="private">Private to each person</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function PeoplePanel() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [me, setMe] = useState<string>("");
  const [viewing, setViewing] = useState<StaffMember | null>(null);
  const load = () => {
    api.listStaff().then(setStaff).catch(() => {});
    api.listRoles().then((r) => setRoles(r.roles)).catch(() => {});
    api.employeeMe().then((m) => setMe(m?.id || "")).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const [rp, setRp] = useState<any>(null);
  useEffect(() => { api.getRepPayoutSettings().then(setRp).catch(() => {}); }, []);
  const saveRp = (fields: any) => { setRp((p: any) => ({ ...(p || {}), ...fields })); api.setRepPayoutSettings(fields).catch(() => {}); };

  // Per-row save feedback so a role/status change is never ambiguous (and any
  // failure is shown inline instead of silently swallowed).
  const [rowMsg, setRowMsg] = useState<Record<string, { t: "saving" | "saved" | "error"; msg?: string }>>({});
  const flash = (id: string, s: { t: "saving" | "saved" | "error"; msg?: string }) => {
    setRowMsg((m) => ({ ...m, [id]: s }));
    if (s.t !== "saving") setTimeout(() => setRowMsg((m) => { const n = { ...m }; delete n[id]; return n; }), 2500);
  };
  const errText = (e: any) => (typeof e === "string" ? e : e?.message || "Failed to save");
  const setRole = async (id: string, roleId: string) => {
    flash(id, { t: "saving" });
    try { await api.updateStaff(id, { roleId }); flash(id, { t: "saved" }); load(); }
    catch (e: any) { flash(id, { t: "error", msg: errText(e) }); }
  };
  const setStatus = async (id: string, status: string) => {
    flash(id, { t: "saving" });
    try { await api.updateStaff(id, { status }); flash(id, { t: "saved" }); load(); }
    catch (e: any) { flash(id, { t: "error", msg: errText(e) }); }
  };
  const setComm = async (id: string, commissionPct: number) => { await api.updateStaff(id, { commissionPct }); };
  const setHide = async (id: string, hidePayCuts: boolean) => { await api.updateStaff(id, { hidePayCuts }); };
  const setPayType = async (id: string, payType: string) => { await api.updateStaff(id, { payType }); load(); };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the team? This permanently deletes their account and unassigns them from any deals. This can't be undone.`)) return;
    try { await api.deleteStaff(id); load(); } catch (e: any) { window.alert(typeof e === "string" ? e : (e?.message || "Failed to remove")); }
  };

  // Share every connection saved on THIS device (email, Stripe, Google, Shopify,
  // Plaid keys + linked banks) up to the org store so other admins inherit them
  // without re-typing. Secrets travel via an authed round-trip — never the sync log.
  const [sharing, setSharing] = useState(false);
  const shareConnections = async () => {
    if (!window.confirm(
      "Share your connections with your team?\n\n" +
      "This uploads the logins saved on this device — email (SMTP/IMAP), Stripe keys, Google connections, Shopify and Plaid keys, and any linked banks — to your team's secure server store so other admins inherit them without re-typing.\n\n" +
      "Nothing is added to the sync log."
    )) return;
    setSharing(true);
    try {
      const msg = await api.shareConnectionsWithTeam();
      toast(msg, "success");
    } catch (e: any) {
      toast(typeof e === "string" ? e : (e?.message || "Couldn't share connections"), "error");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink text-[13px]">Share my connections with my team</div>
          <div className="text-[11.5px] text-muted">Upload the email, Stripe, Google, Shopify, Plaid and bank logins saved on this device so other admins inherit them without re-typing.</div>
        </div>
        <button onClick={shareConnections} disabled={sharing}
          title="Push this device's saved connections up to your team's secure server store — no re-typing on other admins' devices."
          className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors whitespace-nowrap flex-shrink-0">
          {sharing ? <RefreshCw size={13} className="animate-spin" /> : <Share2 size={13} />} {sharing ? "Sharing…" : "Share connections"}
        </button>
      </div>
      {rp && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3 space-y-3">
          <label className="flex items-center justify-between cursor-pointer gap-3">
            <div>
              <div className="font-medium text-ink text-[13px]">Rep payouts</div>
              <div className="text-[11.5px] text-muted">Pay reps a cut of completed deals; owners split the rest.</div>
            </div>
            <input type="checkbox" checked={!!rp.enabled} onChange={(e) => saveRp({ enabled: e.target.checked })} className="accent-accent" />
          </label>
          {rp.enabled && (
            <div className="flex items-center gap-3 text-[12px] border-t border-line pt-3">
              <span className="text-muted">Pay out every</span>
              <select value={rp.period || "monthly"} onChange={(e) => saveRp({ period: e.target.value })}
                className="border border-line px-2 h-8 rounded-lg bg-surface text-[12px]">
                <option value="weekly">Week</option>
                <option value="biweekly">2 weeks</option>
                <option value="monthly">Month</option>
                <option value="custom">Custom</option>
              </select>
              {rp.period === "custom" && (
                <input type="text" inputMode="numeric" defaultValue={rp.custom_days || 14} onBlur={(e) => saveRp({ customDays: parseCount(e.target.value, 14) || 14 })}
                  className="w-16 border border-line px-2 h-8 rounded-lg text-[12px]" />
              )}
              <span className="text-muted ml-auto text-[11px]">Completed deals only.</span>
            </div>
          )}
        </div>
      )}
      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead><tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
          {["Member", "Role", "Pay cut", "Status", ""].map((h, i) => (
            <th key={i} className={`text-left px-4 py-2.5 text-[12px] font-medium text-muted ${i === 4 ? "text-right" : ""}`}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {staff.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--t-b2)" }}>
              <td className="px-4 py-3">
                <button onClick={() => setViewing(u)} className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity group">
                  {u.avatar
                    ? <img src={u.avatar} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                    : <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-on-accent flex-shrink-0" style={{ background: "var(--accent-600)" }}>{(u.display_name || u.email || "?").trim().charAt(0).toUpperCase()}</div>}
                  <div className="min-w-0">
                    <div className="font-medium text-ink truncate group-hover:text-accent">{u.display_name}</div>
                    <div className="text-[11px] text-muted truncate">{u.title ? `${u.title} · ` : ""}{u.email}</div>
                  </div>
                </button>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <select value={u.role_id} disabled={u.id === me} onChange={(e) => setRole(u.id, e.target.value)}
                    className="border border-line px-2 h-8 rounded-lg text-[12px] bg-surface disabled:opacity-60">
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  {rowMsg[u.id] && (
                    <span className={`text-[10.5px] font-medium whitespace-nowrap ${
                      rowMsg[u.id].t === "error" ? "text-danger-ink"
                      : rowMsg[u.id].t === "saved" ? "text-success-ink" : "text-muted"}`}
                      title={rowMsg[u.id].msg || ""}>
                      {rowMsg[u.id].t === "saving" ? "Saving…"
                       : rowMsg[u.id].t === "saved" ? "Saved" : (rowMsg[u.id].msg || "Failed")}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select defaultValue={(u as any).pay_type || "profit_pct"} onChange={(e) => setPayType(u.id, e.target.value)}
                    className="border border-line px-1.5 h-8 rounded-lg text-[11.5px] bg-surface">
                    <option value="profit_pct">% profit</option>
                    <option value="gross_pct">% gross</option>
                    <option value="fixed">fixed $</option>
                  </select>
                  <input type="text" inputMode="decimal" defaultValue={u.commission_pct} onBlur={(e) => setComm(u.id, parseAmount(e.target.value))}
                    className="w-14 border border-line px-2 h-8 rounded-lg text-[12px]" />
                  <span className="text-[11px] text-muted">{((u as any).pay_type === "fixed") ? "$" : "%"}</span>
                  <label className="flex items-center gap-1 text-[11px] text-muted cursor-pointer ml-1">
                    <input type="checkbox" defaultChecked={u.hide_pay_cuts} onChange={(e) => setHide(u.id, e.target.checked)} /> hide
                  </label>
                </div>
              </td>
              <td className="px-4 py-3">
                {u.status === "active"
                  ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-bg text-success-ink font-semibold">Active</span>
                  : <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning-bg text-warning-ink font-semibold">Suspended</span>}
              </td>
              <td className="px-4 py-3 text-right">
                {u.id === me ? <span className="text-[11px] text-muted">You</span>
                  : <div className="flex items-center gap-3 justify-end">
                      {u.status === "active"
                        ? <button onClick={() => setStatus(u.id, "suspended")} className="text-[12px] text-danger-ink font-medium">Suspend</button>
                        : <button onClick={() => setStatus(u.id, "active")} className="text-[12px] text-accent font-medium">Reactivate</button>}
                      <button onClick={() => remove(u.id, u.display_name)} className="text-[12px] text-danger-ink font-medium">Remove</button>
                    </div>}
              </td>
            </tr>
          ))}
          {staff.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-muted">No team members yet. Create an invite under the Invites tab.</td></tr>}
        </tbody>
      </table>
      </div>
      {viewing && <ProfileModal u={viewing} roleName={roles.find((r) => r.id === viewing.role_id)?.name || viewing.role_name || "—"} onClose={() => setViewing(null)} />}
    </div>
  );
}

function ProfileModal({ u, roleName, onClose }: { u: StaffMember; roleName: string; onClose: () => void }) {
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-line last:border-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[13px] text-ink text-right">{value}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-md shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 flex flex-col items-center text-center border-b border-line">
          {u.avatar
            ? <img src={u.avatar} alt="" className="w-20 h-20 rounded-full object-cover" />
            : <div className="w-20 h-20 rounded-full flex items-center justify-center text-[28px] font-bold text-on-accent" style={{ background: "var(--accent-600)" }}>{(u.display_name || u.email || "?").trim().charAt(0).toUpperCase()}</div>}
          <div className="mt-3 text-[17px] font-semibold text-ink">{u.display_name}</div>
          {u.title && <div className="text-[13px] text-muted">{u.title}</div>}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">{roleName}</span>
            {u.status === "active"
              ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-bg text-success-ink font-semibold">Active</span>
              : <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning-bg text-warning-ink font-semibold">Suspended</span>}
          </div>
        </div>
        <div className="px-6 py-3">
          <Row label="Email" value={<a href={`mailto:${u.email}`} className="hover:text-accent">{u.email}</a>} />
          {u.phone && <Row label="Phone" value={<a href={`tel:${u.phone}`} className="hover:text-accent">{u.phone}</a>} />}
          <Row label="Pay cut" value={`${u.commission_pct || 0}%`} />
          {u.created_at && <Row label="Member since" value={new Date(u.created_at).toLocaleDateString()} />}
        </div>
        <div className="px-6 py-4 flex justify-end border-t border-line">
          <button onClick={onClose} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Close</button>
        </div>
      </div>
    </div>
  );
}

function RolesPanel() {
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [newRole, setNewRole] = useState("");
  const load = () => api.listRoles().then((r) => {
    setRoles(r.roles);
    const d: Record<string, Set<string>> = {};
    r.roles.forEach((role) => { d[role.id] = new Set(role.permissions); });
    setDraft(d);
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const toggle = (roleId: string, perm: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      const s = new Set(next[roleId]);
      s.has(perm) ? s.delete(perm) : s.add(perm);
      next[roleId] = s;
      return next;
    });
  };
  const save = async (roleId: string) => { await api.updateRole(roleId, Array.from(draft[roleId] || [])); load(); };
  const create = async () => { if (!newRole.trim()) return; await api.createRole(newRole.trim()); setNewRole(""); load(); };

  return (
    <div className="space-y-4">
      {roles.map((r) => {
        const full = r.id === "role_admin" || r.permissions.includes("*");
        const has = (p: string) => draft[r.id]?.has(p);
        return (
          <div key={r.id} className="bg-surface border border-line rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[14px] font-semibold text-ink">{r.name} {r.is_system && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-3 text-muted ml-1">Built-in</span>}</h4>
              {!full && <button onClick={() => save(r.id)} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium">Save</button>}
            </div>
            {full ? (
              <p className="text-[12px] text-muted">Full access — everything (can't be limited).</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-[13px] font-medium text-ink-2 mb-3 cursor-pointer">
                  <input type="checkbox" checked={!!has("admin:manage")} onChange={() => toggle(r.id, "admin:manage")} />
                  Full admin (manage team, roles &amp; settings)
                </label>
                <div className="overflow-x-auto">
                  <table className="text-[12px]">
                  <thead><tr><th></th>{ACTIONS.map((a) => <th key={a} className="px-3 text-[12px] font-medium text-muted">{a}</th>)}</tr></thead>
                  <tbody>
                    {MATRIX_MODULES.map((m) => (
                      <tr key={m}>
                        <td className="py-1 pr-3 whitespace-nowrap text-ink-2">{MODULE_LABELS[m]}</td>
                        {ACTIONS.map((a) => (
                          <td key={a} className="text-center px-3 py-1">
                            <input type="checkbox" checked={!!has(`${m}:${a}`)} onChange={() => toggle(r.id, `${m}:${a}`)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                <div className="mt-4 pt-3 border-t border-line">
                  <div className="text-[12px] font-medium text-muted mb-2">Sensitive visibility</div>
                  <div className="space-y-2">
                    {VIS_TOGGLES.map(([perm, label, hint]) => (
                      <label key={perm} className="flex items-start gap-2 text-[12px] text-ink-2 cursor-pointer">
                        <input type="checkbox" checked={!!has(perm)} onChange={() => toggle(r.id, perm)} className="mt-0.5" />
                        <span>{label}<span className="block text-[10px] text-muted">{hint}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
      <div className="bg-surface border border-line rounded-xl p-4 flex items-center gap-2">
        <input className={inpSm} placeholder="New role name (e.g. Junior Rep)" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
        <button onClick={create} disabled={!newRole.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">Add role</button>
      </div>
    </div>
  );
}

function InvitesPanel() {
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [roleId, setRoleId] = useState("role_sales");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<{ token: string; signup_path: string } | null>(null);
  const base = "https://ecliptr.app";
  const load = () => {
    api.listInvites().then(setInvites).catch(() => {});
    api.listRoles().then((r) => setRoles(r.roles)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const res = await api.createInvite(roleId, email.trim() || null, 7);
    setCreated(res); setEmail(""); load();
  };
  const revoke = async (token: string) => { if (!confirm("Delete this invite? Its link stops working.")) return; await api.revokeInvite(token); load(); };
  const reopen = async (token: string) => { await api.reopenInvite(token); load(); };

  const status = (i: InviteRow) => i.used_at ? "Used" : (new Date(i.expires_at) < new Date() ? "Expired" : "Pending");

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-4">
        <p className="text-[13px] font-semibold text-ink">Invite someone</p>
        <p className="text-[12px] text-muted mb-3">Pick a role, create the link, and share it — it works once and expires in 7 days.</p>
        <div className="flex gap-2">
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="border border-line px-2 h-9 rounded-lg text-[13px] bg-surface">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input className={inpSm} placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button onClick={create} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium whitespace-nowrap">Create</button>
        </div>
        {created && (
          <div className="mt-3 bg-success-bg border border-success rounded-lg px-3 py-2">
            <p className="text-[12px] font-medium text-success-ink mb-1">Invite link ready — share it:</p>
            <code className="text-[12px] text-success-ink break-all select-all">{base}{created.signup_path}</code>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead><tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
            {["Role", "Email", "Status", "Expires", ""].map((h, i) => <th key={i} className={`text-left px-4 py-2.5 text-[12px] font-medium text-muted ${i === 4 ? "text-right" : ""}`}>{h}</th>)}
          </tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.token} style={{ borderBottom: "1px solid var(--t-b2)" }}>
                <td className="px-4 py-2.5 text-ink">{i.role_name || i.role_id}</td>
                <td className="px-4 py-2.5 text-muted">{i.email || "—"}</td>
                <td className="px-4 py-2.5"><span className="text-[11px] text-ink-2">{status(i)}</span></td>
                <td className="px-4 py-2.5 text-muted text-[12px]">{i.expires_at.slice(0, 10)}</td>
                <td className="px-4 py-2.5 text-right">
                  {(i.used_at || new Date(i.expires_at) < new Date()) && <button onClick={() => reopen(i.token)} className="text-[12px] text-accent font-medium mr-3">Reopen</button>}
                  <button onClick={() => revoke(i.token)} className="text-[12px] text-danger-ink font-medium">Delete</button>
                </td>
              </tr>
            ))}
            {invites.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[12px] text-muted">No invites yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceNumberingSection() {
  const [cfg, setCfg] = useState({ prefix: "INV-", next_number: 1, padding: 4, preview: "INV-0001" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getInvoiceNumberingConfig().then((c) => setCfg(c)).catch(() => {});
  }, []);

  const update = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    const preview = `${next.prefix}${String(next.next_number).padStart(next.padding || 1, "0")}`;
    setCfg({ ...next, preview });
  };

  const save = async () => {
    await api.saveInvoiceNumberingConfig(cfg.prefix, cfg.next_number, cfg.padding);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Prefix</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" value={cfg.prefix}
            onChange={(e) => update({ prefix: e.target.value })} placeholder="INV-" />
        </div>
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Padding</label>
          <NumberInput className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" integer value={cfg.padding}
            onValue={(n) => update({ padding: n || 1 })} />
        </div>
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Start at</label>
          <NumberInput className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" integer value={cfg.next_number}
            onValue={(n) => update({ next_number: n || 1 })} />
        </div>
      </div>
      <p className="text-[11px] text-muted mb-3">Preview: <span className="tabular-nums font-semibold text-accent-hover">{cfg.preview}</span></p>
      <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[12px] font-medium">
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

function QuoteNumberingSection() {
  const [cfg, setCfg] = useState({ prefix: "QUO-", next_number: 1, padding: 4, preview: "QUO-0001" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getQuoteNumberingConfig().then((c) => setCfg(c)).catch(() => {});
  }, []);

  const update = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    const preview = `${next.prefix}${String(next.next_number).padStart(next.padding || 1, "0")}`;
    setCfg({ ...next, preview });
  };

  const save = async () => {
    await api.saveQuoteNumberingConfig(cfg.prefix, cfg.next_number, cfg.padding);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Prefix</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" value={cfg.prefix}
            onChange={(e) => update({ prefix: e.target.value })} placeholder="QUO-" />
        </div>
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Padding</label>
          <NumberInput className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" integer value={cfg.padding}
            onValue={(n) => update({ padding: n || 1 })} />
        </div>
        <div>
          <label className="block text-[12.5px] font-medium text-muted mb-1">Start at</label>
          <NumberInput className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" integer value={cfg.next_number}
            onValue={(n) => update({ next_number: n || 1 })} />
        </div>
      </div>
      <p className="text-[11px] text-muted mb-3">Preview: <span className="tabular-nums font-semibold text-accent-hover">{cfg.preview}</span></p>
      <button onClick={save} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[12px] font-medium">
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

function BillingTab() {
  const [config, setConfig] = useState<StripeConfigStatus | null>(null);
  const [pk, setPk] = useState("");
  const [sk, setSk] = useState("");
  const [wh, setWh] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => api.getStripeConfig().then(setConfig).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!pk || !sk) return;
    await api.saveStripeKeys(pk, sk, wh);
    setSaved("Keys saved");
    setTimeout(() => setSaved(null), 2000);
    load();
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Stripe (Coming Soon)</h3>
      <p className="text-[12px] text-muted mb-5">Configure Stripe keys to accept card payments from invoices.</p>

      <label className="flex items-center gap-2 mb-4 cursor-pointer">
        <input type="checkbox" className="accent-accent" checked={showKeys} onChange={(e) => setShowKeys(e.target.checked)} />
        <span className="text-[12px] text-ink-2">Enable Stripe (preview)</span>
      </label>

      {showKeys && (
        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">
              Publishable Key {config?.publishable_key_present && <span className="inline-block w-2 h-2 rounded-full bg-success-ink align-middle" />}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="pk_test_..." value={pk} onChange={(e) => setPk(e.target.value)} />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">
              Secret Key {config?.secret_key_present && <span className="text-success-ink">●</span>}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="sk_test_..." value={sk} onChange={(e) => setSk(e.target.value)} />
          </div>
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">
              Webhook Secret {config?.webhook_secret_present && <span className="text-success-ink">●</span>}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="whsec_..." value={wh} onChange={(e) => setWh(e.target.value)} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={!showKeys || !pk || !sk} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">Save Keys</button>
        {config?.configured && (
          <button onClick={async () => { await api.deleteStripeKeys(); setPk(""); setSk(""); setWh(""); load(); }} className="text-[12px] text-danger-ink hover:text-danger-ink">Clear Keys</button>
        )}
        {saved && <span className="text-[12px] text-success-ink font-medium">{saved}</span>}
      </div>

      <p className="text-[10px] text-muted mt-4">When keys are configured, you'll be able to request payments from invoices and receive them via Stripe. Full activation when the SaaS server is live.</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-semibold text-ink-2">{children}</div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[12px] font-medium text-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function CustomFieldsTab() {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [form, setForm] = useState({ field_key: "", label: "", field_type: "text", options_json: "" as string | null });

  useEffect(() => { api.listCustomFields().then(setFields).catch(() => {}); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ field_key: "", label: "", field_type: "text", options_json: null });
    setShowForm(true);
  };
  const openEdit = (f: CustomField) => {
    setEditing(f);
    setForm({ field_key: f.field_key, label: f.label, field_type: f.field_type, options_json: f.options_json });
    setShowForm(true);
  };
  const save = async () => {
    if (!form.label.trim() || !form.field_key.trim()) return;
    await api.saveCustomField(editing?.id ?? null, form.field_key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"), form.label.trim(), form.field_type, form.options_json || null);
    setShowForm(false);
    api.listCustomFields().then(setFields);
  };
  const del = async (f: CustomField) => {
    if (!confirm(`Delete "${f.label}"? Existing client data is preserved.`)) return;
    await api.deleteCustomField(f.id);
    api.listCustomFields().then(setFields);
  };

  return (
    <div className="max-w-2xl">
      <p className="text-[12px] text-muted mb-4">
        Add custom fields to store additional client data. These appear on the client profile and can be mapped from sheet columns.
      </p>
      <button onClick={openCreate} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium mb-4">
        + Add Custom Field
      </button>
      {fields.length === 0 ? (
        <p className="text-[13px] text-muted">No custom fields defined.</p>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="text-left px-4 py-2 text-[12px] font-medium text-muted">Label</th>
                <th className="text-left px-4 py-2 text-[12px] font-medium text-muted">Key</th>
                <th className="text-left px-4 py-2 text-[12px] font-medium text-muted">Type</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.id} className="border-t border-line-2 hover:bg-surface-2/50">
                  <td className="px-4 py-2.5 text-[13px] font-medium text-ink">{f.label}</td>
                  <td className="px-4 py-2.5 text-[12px] text-muted font-mono">{f.field_key}</td>
                  <td className="px-4 py-2.5 text-[12px] text-muted capitalize">{f.field_type}</td>
                  <td className="px-4 py-2.5 text-right space-x-1">
                    <button onClick={() => openEdit(f)} className="text-[11px] text-muted hover:text-ink-2">Edit</button>
                    <button onClick={() => del(f)} className="text-[11px] text-danger-ink hover:text-danger-ink">Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={() => setShowForm(false)}>
          <div className="bg-surface rounded-2xl shadow-xl w-[380px] max-w-[92vw] p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-ink mb-4">{editing ? "Edit Field" : "New Field"}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1">Label</label>
                <input className={inp} value={form.label} onChange={e => { const lbl = e.target.value; setForm({ ...form, label: lbl, field_key: lbl.toLowerCase().replace(/[^a-z0-9_]/g, "_") }); }} placeholder="e.g. Loyalty Tier" />
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1">Key</label>
                <input className={inp + " font-mono text-[12px]"} value={form.field_key} onChange={e => setForm({ ...form, field_key: e.target.value })} placeholder="loyalty_tier" />
              </div>
              <div>
                <label className="block text-[12.5px] font-medium text-muted mb-1">Type</label>
                <select className={inp} value={form.field_type} onChange={e => setForm({ ...form, field_type: e.target.value })}>
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="boolean">Boolean</option>
                  <option value="dropdown">Dropdown</option>
                </select>
              </div>
              {form.field_type === "dropdown" && (
                <div>
                  <label className="block text-[12.5px] font-medium text-muted mb-1">Options (comma-separated)</label>
                  <input className={inp} value={form.options_json ?? ""} onChange={e => setForm({ ...form, options_json: e.target.value || null })} placeholder="Gold, Silver, Bronze" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
              <button onClick={save} disabled={!form.label.trim() || !form.field_key.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
                {editing ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
