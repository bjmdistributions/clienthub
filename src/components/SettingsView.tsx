import { useEffect, useState, useRef, createContext, useContext } from "react";
import {
  api,
  Me,
  EmailInbox,
  EmailSettings,
  CompanyInfo,
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
  ProfitSplit,
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
} from "../lib/api";
import { fmtAmount } from "../lib/format";
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
  Globe,
  Split,
  Database,
  Users,
  SlidersHorizontal,
  Moon,
  Sun,
  MessageCircle,
  CheckCheck,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import VariablePicker from "./VariablePicker";
import { FormsPanel } from "./FormsPanel";

// Opens the matching section of the website setup guide in the browser.
function GuideLink({ section }: { section: string }) {
  return (
    <button onClick={() => api.openExternal(`https://ecliptr.app/guide#${section}`)}
      className="text-[12px] text-accent hover:underline inline-flex items-center gap-1 whitespace-nowrap">
      📖 Setup guide →
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
  const json = JSON.stringify(value);
  useEffect(() => {
    if (!ready) { lastSaved.current = json; return; }   // baseline = loaded value
    if (json === lastSaved.current) return;             // no real change
    report("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await save(); lastSaved.current = json; report("saved"); }
      catch { report("error"); }
    }, 700);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, ready]);
}

const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const inpSm = "border border-line px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

type SettingsTab =
  | "account" | "appearance" | "company" | "categories" | "customfields"
  | "email" | "whatsapp" | "templates" | "automation" | "forms"
  | "ai" | "sheets" | "import" | "payments" | "billing" | "shopify" | "webforms"
  | "sync" | "splits" | "backup" | "team";

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
      { id: "payments", label: "Payments",      icon: CreditCard, desc: "Accepted payment methods" },
      { id: "billing",  label: "Billing",       icon: Receipt,    desc: "Stripe configuration" },
      { id: "shopify",  label: "Shopify",       icon: ShoppingBag, desc: "Sync new customers as leads" },
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
];

export default function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>(
    () => (localStorage.getItem("clienthub_settings_tab") as SettingsTab) || "appearance"
  );
  const select = (t: SettingsTab) => {
    setTab(t);
    localStorage.setItem("clienthub_settings_tab", t);
  };
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const active = SETTINGS_GROUPS.flatMap((g) => g.items).find((i) => i.id === tab);

  return (
   <SaveStatusCtx.Provider value={setSaveState}>
    <div className="flex gap-8 max-w-[1100px]">
      {/* Left rail */}
      <aside className="w-[232px] shrink-0">
        <div className="mb-5 px-1">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Settings</h2>
          <p className="text-[12px] text-muted mt-0.5">Manage your workspace</p>
        </div>
        <nav className="space-y-5">
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.group}>
              <div className="px-3 mb-1.5 text-[10px] font-semibold text-muted uppercase tracking-widest">
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
              saveState === "saving" ? "bg-amber-50 text-amber-600"
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
          {tab === "categories"  && <CategoriesTab />}
          {tab === "ai"          && <AiTab />}
          {tab === "sync"        && <SyncTab />}
          {tab === "import"      && <ImportTab />}
          {tab === "automation"  && <AutomationTab />}
          {tab === "forms"       && <FormsPanel />}
          {tab === "payments"    && <PaymentsTab />}
          {tab === "templates"   && <TemplatesTab />}
          {tab === "sheets"      && <SheetsTab />}
          {tab === "splits"      && <SplitsTab />}
          {tab === "backup"      && <BackupTab />}
          {tab === "team"        && <TeamTab />}
          {tab === "billing"     && <BillingTab />}
          {tab === "shopify"     && <ShopifyTab />}
          {tab === "webforms"    && <IntakeTab />}
          {tab === "customfields"&& <CustomFieldsTab />}
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
      <div className="flex items-center gap-4 mb-6">
        {form.avatar
          ? <img src={form.avatar} alt="" className="w-20 h-20 rounded-full object-cover border border-line" />
          : <div className="w-20 h-20 rounded-full flex items-center justify-center text-[28px] font-bold text-white" style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>{initial}</div>}
        <div>
          <label className="bg-surface-2 border border-line hover:bg-surface-3 text-ink-2 px-3 h-8 rounded-lg text-[12px] font-medium inline-flex items-center cursor-pointer">
            Upload photo<input type="file" accept="image/*" className="hidden" onChange={pick} />
          </label>
          {form.avatar && <button onClick={() => setForm((p) => ({ ...p, avatar: "" }))} className="ml-2 text-[12px] text-muted hover:text-danger-ink">Remove</button>}
        </div>
      </div>
      <div className="space-y-3">
        <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Name</label><input className={inpSm} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
        <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Title</label><input className={inpSm} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Sales Manager" /></div>
        <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Phone</label><input className={inpSm} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
        <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Email</label><input className={inpSm + " opacity-60"} value={me.email} disabled /><p className="text-[10px] text-muted mt-1">Contact an admin to change your email.</p></div>
        <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Role</label><input className={inpSm + " opacity-60"} value={me.role_name} disabled /></div>
      </div>
    </div>
  );
}

function AppearanceTab() {
  const [dark, setDark] = useState(() => localStorage.getItem("clienthub_dark") === "1");
  const [matte, setMatte] = useState(() => localStorage.getItem("clienthub_matte") === "1");
  const [accent, setAccentState] = useState(() => localStorage.getItem("clienthub_accent") || "blue");

  const setAccent = (a: string) => {
    setAccentState(a);
    window.dispatchEvent(new CustomEvent("accent-change", { detail: a }));
  };
  const setTheme = (mode: "light" | "dark" | "matte") => {
    const isDark = mode !== "light";
    const isMatte = mode === "matte";
    setDark(isDark);
    setMatte(isMatte);
    window.dispatchEvent(new CustomEvent("dark-change", { detail: isDark }));
    window.dispatchEvent(new CustomEvent("matte-change", { detail: isMatte }));
  };

  const ACCENTS = [
    { id: "blue",    label: "Blue",     swatch: "#2563EB" },
    { id: "emerald", label: "Emerald",  swatch: "#059669" },
    { id: "teal",    label: "Teal",     swatch: "#0D9488" },
    { id: "violet",  label: "Violet",   swatch: "#7C3AED" },
    { id: "amber",   label: "Amber",    swatch: "#D97706" },
    { id: "rose",    label: "Rose",     swatch: "#E11D48" },
    { id: "slate",   label: "Graphite", swatch: "#334155" },
  ];

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <SectionLabel>Accent Color</SectionLabel>
      <p className="text-[12px] text-muted mb-3 mt-0.5">
        Sets the accent used across the sidebar, highlights and controls. Data colors (revenue, profit, charts) stay fixed for clarity.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-7">
        {ACCENTS.map((a) => {
          const isActive = accent === a.id;
          return (
            <button
              key={a.id}
              onClick={() => setAccent(a.id)}
              className={`relative flex flex-col items-center gap-2 py-4 rounded-xl border transition-all ${
                isActive ? "border-transparent ring-2 ring-offset-1" : "border-line hover:border-line-3"
              }`}
              style={isActive ? ({ ["--tw-ring-color" as any]: a.swatch } as any) : undefined}
            >
              <span
                className="w-9 h-9 rounded-full shadow-inner flex items-center justify-center"
                style={{ background: a.swatch }}
              >
                {isActive && <Check size={16} className="text-white" />}
              </span>
              <span className="text-[12px] font-medium text-ink-2">{a.label}</span>
            </button>
          );
        })}
      </div>

      <SectionLabel>Theme</SectionLabel>
      <p className="text-[12px] text-muted mb-3 mt-0.5">Light, dark, or a pure-black matte look — minimal and sharp.</p>
      <div className="flex gap-3">
        {([
          { mode: "light", label: "Light", icon: Sun },
          { mode: "dark",  label: "Dark",  icon: Moon },
          { mode: "matte", label: "Matte", icon: Moon },
        ] as { mode: "light" | "dark" | "matte"; label: string; icon: typeof Sun }[]).map((opt) => {
          const Icon = opt.icon;
          const current = matte ? "matte" : dark ? "dark" : "light";
          const isActive = current === opt.mode;
          return (
            <button
              key={opt.mode}
              onClick={() => setTheme(opt.mode)}
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
  { name: "Mixed Electronics Pallet", qty: 48, ask: "$1,200.00", cat: "Electronics" },
  { name: "Designer Sneakers Lot", qty: 120, ask: "$3,400.00", cat: "Shoes" },
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

  // Live preview — substitutes sample lots client-side (same logic as the backend).
  const sub = (str: string, map: Record<string, string>) =>
    Object.entries(map).reduce((acc, [k, v]) => acc.split(k).join(v), str);
  const lotList = WA_SAMPLE_LOTS.map((l, i) => sub(s.lot_format, {
    "{number}": String(i + 1), "{lot_name}": l.name, "{quantity}": String(l.qty),
    "{asking_price}": l.ask, "{category}": l.cat,
  })).join("\n");
  const preview = sub(s.template, {
    "{business_name}": companyName || "Your Business",
    "{lot_list}": lotList,
    "{footer}": s.footer,
    "{phone}": s.phone,
  });

  const VarHint = ({ vars }: { vars: string[] }) => (
    <p className="text-[11px] text-muted mt-1.5">
      Variables:{" "}
      {vars.map((v, i) => (
        <span key={v}>
          <code className="font-mono text-muted">{v}</code>{i < vars.length - 1 ? " · " : ""}
        </span>
      ))}
    </p>
  );

  const ta = "border border-line px-3 py-2.5 rounded-lg text-[13px] w-full font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y";

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-muted mb-5">
        Customize the message used when you share inventory to WhatsApp. The business name is pulled from your Company settings.
      </p>

      <Field label="Message Template">
        <textarea className={ta} rows={10} value={s.template} onChange={(e) => set("template", e.target.value)} spellCheck={false} />
      </Field>
      <VarHint vars={["{business_name}", "{lot_list}", "{footer}", "{phone}"]} />

      <div className="mt-5">
        <Field label="Lot Format (per item)">
          <textarea className={ta} rows={3} value={s.lot_format} onChange={(e) => set("lot_format", e.target.value)} spellCheck={false} />
        </Field>
        <VarHint vars={["{number}", "{lot_name}", "{quantity}", "{asking_price}", "{category}"]} />
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

function InboxesSection() {
  const [inboxes, setInboxes] = useState<EmailInbox[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: "", host: "imap.gmail.com", port: 993, user: "", password: "" });
  const load = () => api.getEmailInboxes().then(setInboxes).catch(() => {});
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!form.host || !form.user || !form.password) return;
    await api.saveEmailInbox({ label: form.label || form.user, host: form.host, port: Number(form.port) || 993, user: form.user, password: form.password }).catch(() => {});
    setForm({ label: "", host: "imap.gmail.com", port: 993, user: "", password: "" });
    setAdding(false); load();
  };
  const remove = async (id: string) => { if (!confirm("Remove this inbox?")) return; await api.deleteEmailInbox(id).catch(() => {}); load(); };
  return (
    <div className="mt-8 pt-6 border-t border-line">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Additional inboxes</h3>
      <p className="text-[12px] text-muted mb-4">Monitor extra mailboxes — their mail loads in your Inbox and feeds automations. Sending always uses the “send from” account above.</p>
      {inboxes.length > 0 && (
        <div className="space-y-2 mb-3">
          {inboxes.map((ib) => (
            <div key={ib.id} className="flex items-center justify-between bg-surface border border-line rounded-lg px-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{ib.label}</div>
                <div className="text-[11px] text-muted truncate">{ib.user} · {ib.host}:{ib.port}</div>
              </div>
              <button onClick={() => remove(ib.id)} className="text-faint hover:text-danger-ink p-1 rounded-md"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input className={inpSm} placeholder="Label (e.g. Support inbox)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            <input className={inpSm} placeholder="Email / username" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
            <input className={inpSm} placeholder="IMAP host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            <input className={inpSm} type="number" placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
          </div>
          <input className={inpSm} type="password" placeholder="IMAP password / app password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <div className="flex gap-2">
            <button onClick={add} disabled={!form.host || !form.user || !form.password} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">Add inbox</button>
            <button onClick={() => setAdding(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="border border-line text-ink-2 hover:bg-surface-3 px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5"><Plus size={14} /> Add inbox</button>
      )}
    </div>
  );
}

function EmailTab() {
  const [settings, setSettings] = useState<EmailSettings>({
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    imap_host: "imap.gmail.com",
    imap_port: 993,
    user: "",
    auth_method: "password",
  });
  const [smtpPass,         setSmtpPass]         = useState("");
  const [imapPass,         setImapPass]         = useState("");
  const [oauthClientId,    setOauthClientId]    = useState("");
  const [oauthClientSecret,setOauthClientSecret]= useState("");
  const [oauthConnecting,  setOauthConnecting]  = useState(false);
  const [oauthConnected,   setOauthConnected]   = useState(false);
  const [showSecrets,      setShowSecrets]      = useState(false);
  const [saved,            setSaved]            = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  useEffect(() => {
    api.getEmailSettings().then((s) => s && setSettings(s)).catch(console.error);
  }, []);

  const authorize = async () => {
    setError(null);
    setOauthConnecting(true);
    try {
      await api.oauthStartConsent(oauthClientId, oauthClientSecret);
      setOauthConnected(true);
      setTimeout(() => setOauthConnected(false), 5000);
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setOauthConnecting(false);
    }
  };

  const save = async () => {
    setError(null);
    try {
      await api.saveEmailSettings(settings);
      if (settings.auth_method === "password") {
        await api.saveCredential("smtp_user", settings.user);
        if (smtpPass) await api.saveCredential("smtp_pass", smtpPass);
        if (imapPass) await api.saveCredential("imap_pass", imapPass);
        // Same login = same send-from everywhere: push this SMTP account to the
        // synced per-org settings so mobile/web send from it too. Best-effort.
        try {
          const company = await api.getCompanyInfo().catch(() => null);
          await api.pushDesktopSmtpToPi(company?.name || settings.user || "");
        } catch { /* ignore — e.g. no password saved yet */ }
      } else {
        if (oauthClientId) await api.saveCredential("oauth_client_id", oauthClientId);
        if (oauthClientSecret) await api.saveCredential("oauth_client_secret", oauthClientSecret);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.toString());
    }
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-muted mb-5">
        Credentials are stored in your OS keychain — never written to disk or synced.
      </p>

      <Field label="Auth method">
        <div className="flex gap-5">
          {[
            { val: "password", label: "Password / App Password" },
            { val: "oauth2",   label: "OAuth2 (Gmail / Outlook)" },
          ].map((opt) => (
            <label key={opt.val} className="flex items-center gap-2 text-[14px] text-ink-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.auth_method === opt.val}
                onChange={() => setSettings({ ...settings, auth_method: opt.val as "password" | "oauth2" })}
                className="accent-accent"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Email address">
        <input className={inp} value={settings.user} onChange={(e) => setSettings({ ...settings, user: e.target.value })} />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="SMTP host">
          <input className={inp} value={settings.smtp_host} onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })} />
        </Field>
        <Field label="SMTP port">
          <input type="number" className={inp} value={settings.smtp_port} onChange={(e) => setSettings({ ...settings, smtp_port: parseInt(e.target.value) || 587 })} />
        </Field>
        <Field label="IMAP host">
          <input className={inp} value={settings.imap_host} onChange={(e) => setSettings({ ...settings, imap_host: e.target.value })} />
        </Field>
        <Field label="IMAP port">
          <input type="number" className={inp} value={settings.imap_port} onChange={(e) => setSettings({ ...settings, imap_port: parseInt(e.target.value) || 993 })} />
        </Field>
      </div>

      {settings.auth_method === "password" ? (
        <>
          <SecretInput label="SMTP password" value={smtpPass} onChange={setSmtpPass} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="IMAP password" value={imapPass} onChange={setImapPass} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
        </>
      ) : (
        <>
          <SecretInput label="OAuth Client ID"     value={oauthClientId}     onChange={setOauthClientId}     showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="OAuth Client Secret" value={oauthClientSecret} onChange={setOauthClientSecret} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <div className="mb-4">
            <label className="block text-[12px] font-medium text-muted mb-1.5">Google Authorization</label>
            <button
              type="button"
              onClick={authorize}
              disabled={oauthConnecting || !oauthClientId || !oauthClientSecret}
              className={`px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-2 transition-colors ${
                oauthConnected
                  ? "bg-success hover:bg-success text-white"
                  : "bg-accent hover:bg-accent-hover text-white"
              }`}
            >
              {oauthConnecting ? (
                <><RefreshCw size={13} className="animate-spin" /> Authorizing...</>
              ) : oauthConnected ? (
                <><Check size={13} /> Connected</>
              ) : (
                "Authorize with Google"
              )}
            </button>
          </div>
          <p className="text-[12px] text-muted mb-4">
            Enter your Client ID and Secret from Google Cloud Console, then click Authorize and approve access in your browser.
          </p>
        </>
      )}

      {error && (
        <div className="text-danger-ink text-[13px] flex items-center gap-1.5 mt-2 mb-3">
          <AlertCircle size={13} /> {error}
        </div>
      )}
      <button
        onClick={save}
        className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors"
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? "Saved" : "Save Settings"}
      </button>

      <InboxesSection />
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
        <button onClick={save} className="bg-accent hover:bg-accent-hover text-white px-3 h-10 rounded-lg text-[13px] font-medium flex-shrink-0">
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      <p className="text-[10px] text-muted mt-1">Appended to every WhatsApp share message.</p>
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-muted mb-5">This information appears on every PDF invoice.</p>

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

      <WhatsAppFooterField />

      <div className="mt-6 pt-5 border-t border-line">
        <InvoiceNumberingSection />
      </div>
      <div className="mt-6 pt-5 border-t border-line">
        <QuoteNumberingSection />
      </div>
    </div>
  );
}

function AiTab() {
  const [models,  setModels]  = useState<OllamaModel[]>([]);
  const [selected,setSelected]= useState("");
  const [online,  setOnline]  = useState<boolean | null>(null);

  useEffect(() => {
    api.aiHealthCheck().then(setOnline);
    api.aiListModels().then(setModels).catch(() => {});
  }, []);

  const save = async () => {
    if (selected) await api.aiSetModel(selected);
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      {/* Status indicator */}
      <div className="flex items-center gap-2 mb-5 pb-5 border-b border-gray-50">
        <span className="text-[13px] font-medium text-ink-2">Ollama status</span>
        {online === null ? (
          <span className="text-[13px] text-muted">checking...</span>
        ) : (
          <span className={`flex items-center gap-1.5 text-[13px] font-medium ${online ? "text-success-ink" : "text-danger-ink"}`}>
            <span className={`w-2 h-2 rounded-full ${online ? "bg-success shadow-[0_0_6px_rgba(16,185,129,0.5)]" : "bg-danger"}`} />
            {online ? "Online" : (
              <>offline — start with <code className="bg-surface-3 px-1.5 py-0.5 rounded-md text-[12px] ml-1">ollama serve</code></>
            )}
          </span>
        )}
      </div>

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

      <p className="text-[12px] text-muted mb-5">
        Recommended: <code className="bg-surface-3 px-1 rounded">llama3.1:8b</code> for general use,{" "}
        <code className="bg-surface-3 px-1 rounded">qwen2.5:14b</code> for better extraction quality.
        Pull with <code className="bg-surface-3 px-1.5 py-0.5 rounded">ollama pull &lt;model&gt;</code>.
      </p>

      <button
        onClick={save}
        disabled={!selected}
        className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
      >
        Set Active Model
      </button>
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
  const [net,   setNet]   = useState<{ connected: boolean; url: string; pending_push: number; pull_cursor: number } | null>(null);
  const [nUrl,  setNUrl]  = useState("https://ecliptr.app");
  const [nEmail,setNEmail]= useState("");
  const [nPass, setNPass] = useState("");
  const [nBusy, setNBusy] = useState(false);
  const [nErr,  setNErr]  = useState<string | null>(null);
  const [nMsg,  setNMsg]  = useState<string | null>(null);

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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl space-y-6">
      {/* Status */}
      <div>
        <SectionLabel>Sync Status</SectionLabel>
        <div className="bg-surface-2/80 border border-line rounded-xl px-4 py-3 space-y-1.5 mt-2">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted">Events applied</span>
            <span className="font-mono text-ink">{status?.events_applied ?? 0}</span>
          </div>
          <div className="flex justify-between text-[13px]">
            <span className="text-muted">Last applied</span>
            <span className="font-mono text-ink">
              {status?.last_applied ? new Date(status.last_applied).toLocaleString() : "—"}
            </span>
          </div>
        </div>
        <button
          onClick={replay}
          disabled={replaying}
          className="mt-3 bg-surface border border-line hover:bg-surface-2 text-ink-2 px-5 h-9 rounded-lg text-[13px] transition-colors disabled:opacity-50"
        >
          {replaying ? "Replaying..." : "Replay All Events"}
        </button>
      </div>

      {/* Cloud network sync — connect this desktop to the central server */}
      <div className="border-t border-line pt-5">
        <SectionLabel>Cloud Sync</SectionLabel>
        {net?.connected ? (
          <div className="mt-2 space-y-3">
            <div className="bg-surface-2/80 border border-line rounded-xl px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-success shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
                <p className="text-[13px] text-success-ink font-medium truncate">Connected to {net.url}</p>
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="text-muted">Pending to push</span>
                <span className="font-mono text-ink">{net.pending_push}</span>
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="text-muted">Pull position</span>
                <span className="font-mono text-ink">{net.pull_cursor}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={syncNow}
                disabled={nBusy}
                className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {nBusy ? "Syncing…" : "Sync now"}
              </button>
              <button
                onClick={disconnectNet}
                disabled={nBusy}
                className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-5 h-9 rounded-lg text-[13px] transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
            {nMsg && <p className="text-[12px] text-muted">{nMsg}</p>}
            {nErr && (
              <div className="text-danger-ink text-[13px] flex items-center gap-1.5">
                <AlertCircle size={13} /> {nErr}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-[12px] text-muted mb-3">
              Connect this desktop to your Ecliptr workspace to sync over the internet — no shared
              folder needed. Sign in with your team account.
            </p>
            <div className="space-y-2 max-w-sm">
              <input
                value={nUrl}
                onChange={(e) => setNUrl(e.target.value)}
                placeholder="Server URL"
                className={inp}
              />
              <input
                value={nEmail}
                onChange={(e) => setNEmail(e.target.value)}
                placeholder="Email"
                autoComplete="username"
                className={inp}
              />
              <input
                type="password"
                value={nPass}
                onChange={(e) => setNPass(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                onKeyDown={(e) => { if (e.key === "Enter") connectNet(); }}
                className={inp}
              />
              <button
                onClick={connectNet}
                disabled={nBusy || !nUrl.trim() || !nEmail.trim() || !nPass}
                className="bg-accent hover:bg-accent-hover text-white px-5 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {nBusy ? "Connecting…" : "Connect"}
              </button>
            </div>
            {nErr && (
              <div className="text-danger-ink text-[13px] mt-2 flex items-center gap-1.5">
                <AlertCircle size={13} /> {nErr}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Updates */}
      <div className="border-t border-line pt-5">
        <SectionLabel>App Updates</SectionLabel>
        <div className="mt-2">
          <UpdateButton />
        </div>
      </div>

      {/* Encryption */}
      <div className="border-t border-line pt-5">
        <SectionLabel>Encryption</SectionLabel>
        {encrypted === null ? (
          <p className="text-[13px] text-muted mt-2">checking...</p>
        ) : encrypted ? (
          <div className="flex items-center gap-2 mt-2">
            <span className="w-2 h-2 rounded-full bg-success shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
            <p className="text-[13px] text-success-ink font-medium">Sync events are encrypted at rest</p>
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-[12px] text-muted mb-3">
              Protect your sync data with a passphrase. All sync event files will be encrypted with
              ChaCha20-Poly1305. Enter the same passphrase on every device.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="Enter passphrase..."
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={`${inp} flex-1`}
              />
              <button
                onClick={handleSetPassphrase}
                disabled={settingPassphrase || !passphrase.trim()}
                className="bg-accent hover:bg-accent-hover text-white px-5 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {settingPassphrase ? "Setting..." : "Enable"}
              </button>
            </div>
            {encryptError && (
              <div className="text-danger-ink text-[13px] mt-2 flex items-center gap-1.5">
                <AlertCircle size={13} /> {encryptError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* How sync works */}
      <div className="border-t border-line pt-5">
        <SectionLabel>How Sync Works</SectionLabel>
        <p className="text-[12px] text-muted mt-2 mb-2">
          Ecliptr uses an append-only event log with Hybrid Logical Clocks. Every write produces a JSON event in:
        </p>
        <code className="block bg-surface-2 border border-line px-4 py-3 rounded-xl text-[11px] font-mono text-muted">
          ~/Library/Application Support/com.bjmdistributions.clienthub/sync/ (macOS)<br />
          %APPDATA%\com.bjmdistributions.clienthub\sync\ (Windows)
        </code>
        <p className="text-[12px] text-muted mt-2">
          Point Syncthing or another file-sync tool at this folder. Conflict-free merging is handled
          automatically per-column with last-write-wins semantics.
        </p>
      </div>
    </div>
  );
}

function ImportTab() {
  const [subTab, setSubTab] = useState<"csv" | "contacts">("csv");
  return (
    <div>
      <div className="flex items-center gap-1 mb-5 border-b border-line">
        {(["csv", "contacts"] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`px-4 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-[1px] capitalize ${subTab === t ? "border-accent text-accent-hover" : "border-transparent text-muted hover:text-ink-2"}`}>
            {t === "csv" ? "From CSV" : "From Google Contacts"}
          </button>
        ))}
        <span className="ml-auto pb-2"><GuideLink section="import" /></span>
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

  const CORE_FIELDS = [
    { key: "first_name", label: "First Name *" },
    { key: "last_name",  label: "Last Name" },
    { key: "email",      label: "Email" },
    { key: "phone",      label: "Phone" },
    { key: "company",    label: "Company Name" },
    { key: "notes",      label: "Notes" },
    { key: "street_address", label: "Street Address" },
    { key: "city",       label: "City" },
    { key: "state",      label: "State" },
    { key: "zip_code",   label: "Zip Code" },
    { key: "category",   label: "Category" },
    { key: "lead_status", label: "Lead Status" },
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-3xl">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Import from Google Sheets / CSV</h3>
      <p className="text-[12px] text-muted mb-5">
        Export your sheet as CSV (File → Download → CSV in Google Sheets), then upload it here.
        Existing clients are deduplicated by email.
      </p>

      <button
        onClick={pickFile}
        className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] flex items-center gap-2 mb-4 transition-colors"
      >
        <Upload size={13} /> {path ? "Change file" : "Choose CSV file"}
      </button>

      {path && <div className="text-[12px] text-muted mb-4 font-mono">{path}</div>}

      {preview && (
        <>
          <div className="bg-surface-2/80 border border-line px-4 py-3 rounded-xl mb-5">
            <div className="text-[13px] font-medium text-ink mb-0.5">{preview.total_rows} rows detected</div>
            <div className="text-[12px] text-muted">Headers: {preview.headers.join(", ")}</div>
          </div>

          <SectionLabel>Map Columns</SectionLabel>
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

          <SectionLabel>Extra Fields → Metadata ({metaKeys.length} selected)</SectionLabel>
          <div className="flex flex-wrap gap-2 mt-2 mb-5">
            {preview.headers
              .filter((h) => !Object.values(mapping).includes(h))
              .map((h) => (
                <label
                  key={h}
                  className={`text-[12px] px-3 py-1 rounded-full cursor-pointer border transition-colors ${
                    metaKeys.includes(h)
                      ? "bg-accent text-white border-accent"
                      : "bg-surface-2 border-line text-ink-2 hover:bg-surface-3"
                  }`}
                >
                  <input type="checkbox" className="sr-only" checked={metaKeys.includes(h)} onChange={() => toggleMetaKey(h)} />
                  {h}
                </label>
              ))}
          </div>

          <div className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Preview (first 5 rows)</div>
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
            className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            {importing ? "Importing..." : `Import ${preview.total_rows} clients`}
          </button>
        </>
      )}

      {summary && (
        <div className="mt-5 p-4 bg-success-bg border border-success rounded-xl">
          <div className="text-[13px] font-medium text-success-ink">
            ✓ Imported {summary.imported} clients
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
    </div>
  );
}

function GoogleContactsSection() {
  const [connected, setConnected] = useState(false);
  const [contacts, setContacts] = useState<GoogleContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);

  useEffect(() => {
    api.googleContactsList().then(() => setConnected(true)).catch(() => {});
  }, []);

  const connect = async () => {
    const id = prompt("Google Client ID:");
    if (!id) return;
    const secret = prompt("Google Client Secret:");
    if (!secret) return;
    setBusy(true);
    try { await api.googleContactsOauthStart(id, secret); setConnected(true); } catch (e: any) { alert(e); }
    setBusy(false);
  };

  const fetch = async () => {
    setBusy(true);
    try { setContacts(await api.googleContactsList()); } catch (e: any) { alert(e); }
    setBusy(false);
  };

  const disconnect = () => {
    setConnected(false);
    setContacts([]);
    setSelected(new Set());
  };

  const importContacts = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const toImport = contacts.filter(c => selected.has(c.resource_name));
    try { setResult(await api.googleContactsImport(toImport)); } catch (e: any) { alert(e); }
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-3xl">
      <h3 className="text-[14px] font-semibold text-ink mb-1">Google Contacts</h3>
      <p className="text-[12px] text-muted mb-5">
        Import clients from your Google Contacts. Duplicates are skipped by email or name.
      </p>

      {!connected ? (
        <button onClick={connect} disabled={busy}
          className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
          {busy ? "Connecting..." : "Connect Google Account"}
        </button>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[12px] text-success-ink font-medium">● Connected</span>
            <button onClick={fetch} disabled={busy}
              className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
              {busy ? "Loading..." : contacts.length > 0 ? "Refresh Contacts" : "Fetch Contacts"}
            </button>
            <button onClick={disconnect} className="text-[11px] text-muted hover:text-danger-ink">Disconnect</button>
          </div>

          {contacts.length > 0 && (
            <>
              <div className="flex items-center gap-3 mb-3">
                <input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)}
                  className="border border-line h-9 px-3 rounded-lg text-[13px] w-[200px] focus:outline-none focus:ring-2 focus:ring-accent/40" />
                <button onClick={toggleAll} className="text-[12px] text-accent hover:text-accent-hover">
                  {selected.size === filtered.length ? "Deselect All" : "Select All"}
                </button>
                <div className="flex-1" />
                <span className="text-[12px] text-muted">{selected.size} selected</span>
              </div>

              <div className="border border-line rounded-xl overflow-hidden mb-4 max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 sticky top-0">
                    <tr>
                      <th className="w-10 px-3 py-2"><input type="checkbox" className="accent-accent" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} /></th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-muted uppercase">Name</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-muted uppercase">Email</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-muted uppercase">Company</th>
                      <th className="text-left px-3 py-2 text-[10px] font-semibold text-muted uppercase">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(c => (
                      <tr key={c.resource_name} className="border-t border-gray-50 hover:bg-surface-2/50">
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
                  className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
                  {busy ? "Importing..." : `Import ${selected.size} selected`}
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
    </div>
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={15} className="text-accent" />
        <h3 className="text-[14px] font-semibold text-ink">Auto-detect Signup Emails</h3>
        <span className="ml-auto"><GuideLink section="automations" /></span>
      </div>
      <p className="text-[12px] text-muted mb-4">
        When an incoming email matches a rule, AI extracts client info from the body and
        auto-creates a client record. Patterns are{" "}
        <a href="https://docs.rs/regex/latest/regex/#syntax" target="_blank" rel="noreferrer" className="text-accent underline">regular expressions</a>.
      </p>

      {/* Fastest path — the direct lead form (no email setup needed). */}
      <div className="border rounded-xl p-3.5 mb-5" style={{ borderColor: "rgba(var(--c-accent-rgb,99,102,241),0.3)", background: "rgba(var(--c-accent-rgb,99,102,241),0.06)" }}>
        <div className="text-[12.5px] font-semibold text-ink mb-1">Fastest setup — your lead form link</div>
        <p className="text-[11.5px] text-muted mb-2.5">Share or embed this link (add <code className="font-mono">?rep=Name</code> to attribute a rep). Every submission creates a client instantly — no email setup needed.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[12px] bg-surface-2 rounded-lg px-2.5 py-1.5 break-all select-all text-ink-2">{leadFormUrl}</code>
          <button onClick={copyLeadLink} className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-lg text-[12px] font-medium whitespace-nowrap">{copied ? "Copied ✓" : "Copy"}</button>
        </div>
      </div>

      {/* Premade automations — one-click enable */}
      <div className="mb-6">
        <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-2.5">One-click automations</label>
        <div className="grid sm:grid-cols-2 gap-2.5">
          {PREMADE_AUTOMATIONS.map((p) => {
            const on = isEnabled(p.name);
            return (
              <div key={p.name} className="border border-line rounded-xl p-3.5 flex flex-col bg-surface-2/40">
                <div className="text-[13px] font-medium text-ink mb-0.5">{p.name}</div>
                <div className="text-[11.5px] text-muted leading-snug flex-1 mb-3">{p.desc}</div>
                <button
                  disabled={on || enabling === p.name}
                  onClick={() => enablePremade(p)}
                  className={`h-8 rounded-lg text-[12px] font-medium transition-colors ${on ? "cursor-default" : "bg-accent hover:bg-accent-hover text-white"}`}
                  style={on ? { background: "rgba(16,185,129,0.12)", color: "rgb(var(--c-success))" } : undefined}
                >
                  {on ? "✓ Enabled" : enabling === p.name ? "Enabling…" : "Enable"}
                </button>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted mt-2.5">Requires email connected (Settings → Email). Fine-tune or remove any rule below.</p>
      </div>

      <button onClick={() => setShowForm(true)} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 mb-5 transition-colors">
        <Plus size={13} /> Add custom rule
      </button>

      {showForm && (
        <div className="border border-line rounded-xl p-4 mb-5 space-y-3 bg-surface-2/80">
          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Rule name</label>
            <input className={inp} placeholder="e.g. Typeform new client signups" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Sender pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. noreply@typeform\.com" value={form.sender_pattern} onChange={(e) => setForm({ ...form, sender_pattern: e.target.value })} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Subject pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. (?i)new\s+(client|signup|inquiry)" value={form.subject_pattern} onChange={(e) => setForm({ ...form, subject_pattern: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-[13px] text-muted hover:text-ink transition-colors">Cancel</button>
            <button onClick={save} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">Save Rule</button>
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

      <div className="border-t border-line pt-5">
        <div className="flex items-center gap-2 mb-1">
          <RefreshCw size={15} className="text-accent" />
          <h3 className="text-[14px] font-semibold text-ink">Follow-Up Rules</h3>
        </div>
        <p className="text-[12px] text-muted mb-1">
          Automatically email or remind clients based on triggers.{" "}
          {lastRun && <span>Last checked: {(() => { const d = new Date(lastRun); const mins = Math.floor((Date.now() - d.getTime()) / 60000); return mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} hours ago`; })()}</span>}
        </p>

        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => { setEditingFu(null); setFuForm({ name: "", trigger_type: "no_order", trigger_value: 30, action_type: "email", email_subject: "", email_body: "" }); setShowFuForm(true); }} className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-lg text-[12px] font-medium flex items-center gap-1">
            <Plus size={12} /> Add Rule
          </button>
          <button onClick={() => api.processFollowupRules().then(loadFu).catch(alert)} className="text-[12px] text-muted hover:text-ink-2 px-2 py-1 rounded hover:bg-surface-2">Run Now</button>
        </div>

        {showFuForm && (
          <div className="border border-line rounded-xl p-4 mb-4 space-y-3 bg-surface-2/80">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Name</label>
                <input className={inp} value={fuForm.name} onChange={(e) => setFuForm({ ...fuForm, name: e.target.value })} placeholder="Check-in reminder" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Trigger</label>
                <select className={inp} value={fuForm.trigger_type} onChange={(e) => setFuForm({ ...fuForm, trigger_type: e.target.value })}>
                  {Object.entries(triggerLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Days</label>
                <input className={inp} type="number" value={fuForm.trigger_value} onChange={(e) => setFuForm({ ...fuForm, trigger_value: parseInt(e.target.value) || 0 })} />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Action</label>
                <select className={inp} value={fuForm.action_type} onChange={(e) => setFuForm({ ...fuForm, action_type: e.target.value })}>
                  {Object.entries(actionLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            {isEmailAction && (
              <>
                <div>
                  <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Email Subject</label>
                  <input ref={fuSubjectRef} className={inp} value={fuForm.email_subject} onChange={(e) => setFuForm({ ...fuForm, email_subject: e.target.value })} onFocus={() => { fuLastFocused.current = "subject"; }} placeholder="Just checking in" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Email Body</label>
                  <textarea ref={fuBodyRef} className={inp + " h-20 resize-none"} value={fuForm.email_body} onChange={(e) => setFuForm({ ...fuForm, email_body: e.target.value })} onFocus={() => { fuLastFocused.current = "body"; }} placeholder="Hi {first_name}, hope things are going well..." />
                  <div className="mt-1">
                    <VariablePicker onSelect={insertFuVariable} />
                  </div>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowFuForm(false); setEditingFu(null); }} className="text-[13px] text-muted hover:text-ink transition-colors">Cancel</button>
              <button onClick={saveFu} disabled={!fuForm.name.trim()} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50">
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
          <div className="mt-4 border-t border-gray-50 pt-4">
            <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Recent Activity</p>
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
      </div>
    </div>
  );
}

function UpdateButton() {
  const [checking, setChecking] = useState(false);
  const [status,   setStatus]   = useState<string | null>(null);

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
      <button
        onClick={checkForUpdates}
        disabled={checking}
        className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-5 h-9 rounded-lg text-[13px] disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking..." : "Check for Updates"}
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
          <div className="text-[11px] font-medium text-muted uppercase tracking-wide">Field mapping</div>
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
            <button onClick={save} className="px-4 h-8 rounded-lg bg-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity">{savedMsg ? "Saved" : "Save mapping"}</button>
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
        <button onClick={create} disabled={busy} className="px-4 h-9 rounded-lg bg-accent text-white text-[13px] font-medium disabled:opacity-50 transition-opacity">Create link</button>
      </div>
      {sources.length === 0 && <div className="text-[13px] text-muted">No intake links yet — create one above.</div>}
      {sources.map((s) => <IntakeSourceCard key={s.id} source={s} fields={fields} onChange={load} />)}
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
          <div className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1.5">Webhook URL</div>
          <div className="flex items-center gap-2">
            <input readOnly value={url} className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[12px] text-ink" />
            <button onClick={() => navigator.clipboard?.writeText(url)} className="px-3 h-9 border border-line rounded-lg text-[12px] hover:bg-surface-2 transition-colors">Copy</button>
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-muted uppercase tracking-wide mb-1.5">Webhook signing secret</div>
          <div className="flex items-center gap-2">
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder={cfg?.configured ? "•••••••  (set — paste to replace)" : "Paste the secret from Shopify"}
              className="flex-1 bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink" />
            <button onClick={save} disabled={busy || !secret.trim()}
              className="px-4 h-9 rounded-lg bg-accent text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
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
    <div className="bg-surface border border-line rounded-xl p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[14px] font-semibold text-ink">Payment Methods</h3>
        <button
          onClick={() => { setEditing(null); setForm({ kind: "ACH", label: "", details: "" }); setShowForm(true); }}
          className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      </div>
      <p className="text-[12px] text-muted mb-5">Active methods appear on every invoice.</p>

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
              className="bg-accent hover:bg-accent-hover text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
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
        {methods.length === 0 && (
          <div className="text-center text-[13px] text-muted py-10">
            No payment methods yet. Add one to display options on your invoices.
          </div>
        )}
      </div>
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
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Description</label>
          <input
            className={inpSm}
            placeholder="e.g. Standard order processing"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Rate</label>
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
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1.5">Qty</label>
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
            className="bg-accent hover:bg-accent-hover text-white h-9 px-4 rounded-lg text-[13px] font-medium w-full disabled:opacity-40 transition-colors"
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

function CategoriesTab() {
  const [cats,      setCats]      = useState<Category[]>([]);
  const [newLabel,  setNewLabel]  = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  useEffect(() => { api.listCategories().then(setCats); }, []);
  const reload = () => api.listCategories().then(setCats);

  const create = async () => {
    if (!newLabel.trim()) return;
    await api.createCategory({ label: newLabel.trim() });
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
    if (confirm(`Delete category "${label}"? Existing clients will keep their category value.`)) {
      await api.deleteCategory(id);
      reload();
    }
  };

  const move = async (id: string, dir: 1 | -1) => {
    const idx = cats.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= cats.length) return;
    const reordered = [...cats];
    [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
    await api.reorderCategories(reordered.map((c) => c.id));
    reload();
  };

  return (
    <div className="max-w-2xl">
      <p className="text-[12px] text-muted mb-4">
        Manage client category labels. Categories help organize and filter clients.
      </p>

      <div className="flex gap-2 mb-4">
        <input
          placeholder="New category name..."
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          className={`${inp} flex-1`}
        />
        <button
          onClick={create}
          disabled={!newLabel.trim()}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white px-4 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="bg-surface border border-line rounded-xl divide-y divide-gray-50 overflow-hidden">
        {cats.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-surface-2/50 transition-colors">
            {editingId === c.id ? (
              <>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && update(c.id)}
                  className="flex-1 border border-line px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                  autoFocus
                />
                <button onClick={() => update(c.id)}    className="text-success-ink hover:text-success-ink p-1.5 rounded-lg hover:bg-success-bg transition-colors"><Check  size={13} /></button>
                <button onClick={() => setEditingId(null)} className="text-muted hover:text-ink-2 p-1.5 rounded-lg hover:bg-surface-3 transition-colors"><X size={13} /></button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <button onClick={() => move(c.id, -1)} disabled={i === 0}                className="text-faint hover:text-muted disabled:opacity-20 transition-colors"><ChevronUp   size={12} /></button>
                  <button onClick={() => move(c.id,  1)} disabled={i === cats.length - 1} className="text-faint hover:text-muted disabled:opacity-20 transition-colors"><ChevronDown size={12} /></button>
                </div>
                <span className="flex-1 text-[13px] text-ink">{c.label}</span>
                <button onClick={() => { setEditingId(c.id); setEditLabel(c.label); }} className="text-faint hover:text-ink-2 p-1.5 rounded-lg hover:bg-surface-3 transition-colors"><Edit2  size={13} /></button>
                <button onClick={() => remove(c.id, c.label)}                          className="text-faint hover:text-danger-ink p-1.5 rounded-lg hover:bg-danger-bg  transition-colors"><Trash2 size={13} /></button>
              </>
            )}
          </div>
        ))}
        {cats.length === 0 && (
          <div className="text-center text-[13px] text-muted py-8">No categories defined yet.</div>
        )}
      </div>
    </div>
  );
}

function SheetsTab() {
  const [config,  setConfig]  = useState<SheetSyncConfig>({
    id: 1, sheet_url: null, name_col: "", first_name_col: "F", last_name_col: "G",
    email_col: "I", phone_col: "J", company_col: "E", category_col: "P",
    lead_status_col: "V", notes_col: "AA", skip_header_rows: 1,
    last_synced_at: null, last_synced_count: 0, field_mapping_json: null,
  });
  const [saving,  setSaving]  = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result,  setResult]  = useState<SheetSyncResult | null>(null);
  const [log,     setLog]     = useState<SheetSyncLogEntry[]>([]);

  useEffect(() => {
    api.getSheetSyncConfig().then(setConfig).catch(() => {});
    api.getSheetSyncLog().then(setLog).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api.saveSheetSyncConfig(config); } catch (e: any) { alert(e); }
    setSaving(false);
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
          Share your Google Sheet as <strong className="text-ink-2">'Anyone with link can view'</strong>, paste the URL below. Ecliptr syncs new clients automatically every 10 minutes.
        </p>
        <GuideLink section="sheets" />
      </div>

      {/* Setup */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <SectionLabel>Sheet Setup</SectionLabel>
        <div className="space-y-3 mt-3">
          <Field label="Google Sheet URL">
            <input className={inp} placeholder="https://docs.google.com/spreadsheets/d/..." value={config.sheet_url ?? ""} onChange={(e) => setConfig({ ...config, sheet_url: e.target.value })} />
          </Field>
          <div className="grid grid-cols-5 gap-3">
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
          <div className="w-32">
            <label className="block text-[10px] font-medium text-muted mb-1">Skip header rows</label>
            <input type="number" min={0} value={config.skip_header_rows} onChange={(e) => setConfig({ ...config, skip_header_rows: Number(e.target.value) })} className={inpSm} />
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <Save size={13} /> {saving ? "Saving..." : "Save Config"}
          </button>
        </div>
      </div>

      {/* Sync */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <SectionLabel>Sync</SectionLabel>
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={syncNow}
            disabled={syncing || !config.sheet_url}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
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
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-50">
          <span className="text-[10px] font-semibold text-muted uppercase tracking-widest">Sync History</span>
        </div>
        {log.length === 0 ? (
          <div className="text-center text-[13px] text-muted py-8">No syncs yet</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2/50">
              <tr>
                <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-widest">Date</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-widest">New</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-widest">Skipped</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-widest">Errors</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id} className="border-t border-gray-50 hover:bg-surface-2/40 transition-colors">
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
  const [split, setSplit] = useState<ProfitSplit | null>(null);

  useEffect(() => {
    api.getProfitSplit().then(setSplit).catch(() => {});
  }, []);

  const total = (split?.jack_pct ?? 0) + (split?.ben_pct ?? 0) + (split?.business_pct ?? 0);
  const valid = Math.abs(total - 100) < 0.01;
  // Auto-save only when the split is valid (totals 100%).
  const save = async () => {
    if (split) await api.saveProfitSplit(split.business_pct, split.jack_pct, split.ben_pct, split.jack_name, split.ben_name);
  };
  useAutosave(split, save, split !== null && valid);

  if (!split) return <div className="text-sm text-muted py-8 text-center">Loading...</div>;

  return (
    <div className="max-w-lg">
      <SectionLabel>Profit Split (must total 100%)</SectionLabel>
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={`${split.jack_name || "Partner 1"} name`}>
            <input
              type="text"
              value={split.jack_name}
              onChange={(e) => setSplit({ ...split, jack_name: e.target.value })}
              className={inpSm}
            />
          </Field>
          <Field label="Share %">
            <input
              type="number"
              step="0.1"
              value={split.jack_pct}
              onChange={(e) => setSplit({ ...split, jack_pct: parseFloat(e.target.value) || 0 })}
              className={inpSm}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={`${split.ben_name || "Partner 2"} name`}>
            <input
              type="text"
              value={split.ben_name}
              onChange={(e) => setSplit({ ...split, ben_name: e.target.value })}
              className={inpSm}
            />
          </Field>
          <Field label="Share %">
            <input
              type="number"
              step="0.1"
              value={split.ben_pct}
              onChange={(e) => setSplit({ ...split, ben_pct: parseFloat(e.target.value) || 0 })}
              className={inpSm}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[12px] font-medium text-muted mb-1.5">Business share %</div>
            <div className="border border-line px-3 h-9 rounded-lg text-[13px] flex items-center bg-surface-2 text-muted">
              {split.business_pct.toFixed(1)}% (auto)
            </div>
          </div>
          <div>
            <div className="text-[12px] font-medium text-muted mb-1.5">Total</div>
            <div className={`border px-3 h-9 rounded-lg text-[13px] flex items-center gap-1.5 ${
              valid ? "border-success bg-success-bg text-success-ink" : "border-danger bg-danger-bg text-danger-ink"
            }`}>
              {valid ? <Check size={13} /> : <AlertCircle size={13} />}
              {total.toFixed(1)}%
              {!valid && <span className="text-[11px] ml-1">(must equal 100%)</span>}
            </div>
          </div>
        </div>
      </div>
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
            <p className="text-[11px] font-semibold text-muted uppercase tracking-widest">Backup location</p>
            <p className="text-[12px] text-ink-2 font-mono mt-0.5">{status?.backup_dir || "—"}</p>
          </div>
          <button onClick={handleDirChange} className="text-[11px] text-accent hover:text-accent-hover">Change</button>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-muted uppercase tracking-widest">Last backup</p>
          <p className="text-[13px] text-ink-2 mt-0.5">{lastTime}</p>
        </div>
      </div>

      <div className="flex gap-2 mb-5">
        <button onClick={handleBackup} disabled={busy} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Backup Now
        </button>
      </div>

      {msg && <p className="text-[12px] text-success-ink font-medium mb-4">{msg}</p>}

      {backups.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Backups ({backups.length})</p>
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
  analytics: "Analytics & reports", settings: "Settings",
};
const MATRIX_MODULES = ["clients", "inventory", "deal_flow", "quotes", "email", "manifests", "analytics", "settings"];
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
      <div className="flex gap-0 border-b border-line mb-5">
        {(["people", "roles", "approvals", "invites", "payouts"] as const).map((s) => (
          <button key={s} onClick={() => setSub(s)}
            className={`px-4 py-2.5 text-[14px] border-b-2 -mb-px transition-colors capitalize ${sub === s ? "border-accent text-accent-hover font-medium" : "border-transparent text-muted hover:text-ink"}`}>
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
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      {data && !data.enabled && (
        <div className="text-[12.5px] text-muted">Rep payouts are off. Turn them on under <strong>People</strong> first.</div>
      )}
      <div className="flex items-center gap-2 text-[12px] flex-wrap">
        <span className="text-muted">Period</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="border border-line px-2 h-8 rounded-lg text-[12px] bg-surface" />
        <span className="text-muted">to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="border border-line px-2 h-8 rounded-lg text-[12px] bg-surface" />
        <button onClick={load} className="px-3 h-8 border border-line rounded-lg text-[12px] hover:bg-surface-2">Show</button>
      </div>
      {payouts.length === 0 ? (
        <div className="text-[12.5px] text-muted">No rep payouts for completed deals in this period.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead><tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
            {["Rep", "Deals", "Owed", ""].map((h, i) => <th key={i} className={`text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-muted ${i === 3 ? "text-right" : ""}`}>{h}</th>)}
          </tr></thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.rep_id} style={{ borderBottom: "1px solid var(--t-b2)" }}>
                <td className="px-3 py-2.5 text-ink">{p.name}</td>
                <td className="px-3 py-2.5 text-muted">{p.deals}{p.refunded_deals > 0 ? ` · ${p.refunded_deals} refunded` : ""}</td>
                <td className="px-3 py-2.5 tabular-nums font-semibold text-ink">{fmtAmount(p.owed)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button disabled={busy} onClick={() => markPaid(p.rep_id, p.owed)} className="px-2.5 h-7 border border-line rounded-lg text-[11.5px] hover:bg-surface-2">Mark paid</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {err && <div className="text-[11.5px] text-danger-ink">{err}</div>}
    </div>
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

  const setRole = async (id: string, roleId: string) => { await api.updateStaff(id, { roleId }); load(); };
  const setStatus = async (id: string, status: string) => { await api.updateStaff(id, { status }); load(); };
  const setComm = async (id: string, commissionPct: number) => { await api.updateStaff(id, { commissionPct }); };
  const setHide = async (id: string, hidePayCuts: boolean) => { await api.updateStaff(id, { hidePayCuts }); };
  const setPayType = async (id: string, payType: string) => { await api.updateStaff(id, { payType }); load(); };
  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from the team? This permanently deletes their account and unassigns them from any deals. This can't be undone.`)) return;
    try { await api.deleteStaff(id); load(); } catch (e: any) { window.alert(typeof e === "string" ? e : (e?.message || "Failed to remove")); }
  };

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      {rp && (
        <div className="px-4 py-3 border-b border-line space-y-3">
          <label className="flex items-center justify-between cursor-pointer gap-3">
            <div>
              <div className="font-medium text-ink text-[13px]">Rep payouts</div>
              <div className="text-[11.5px] text-muted">Pay reps a cut of completed deals; owners split the rest.</div>
            </div>
            <input type="checkbox" checked={!!rp.enabled} onChange={(e) => saveRp({ enabled: e.target.checked })} />
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
                <input type="number" min={1} defaultValue={rp.custom_days || 14} onBlur={(e) => saveRp({ customDays: parseInt(e.target.value) || 14 })}
                  className="w-16 border border-line px-2 h-8 rounded-lg text-[12px]" />
              )}
              <span className="text-muted ml-auto text-[11px]">Completed deals only.</span>
            </div>
          )}
        </div>
      )}
      <table className="w-full text-[13px]">
        <thead><tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
          {["Member", "Role", "Pay cut", "Status", ""].map((h, i) => (
            <th key={i} className={`text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted ${i === 4 ? "text-right" : ""}`}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {staff.map((u) => (
            <tr key={u.id} style={{ borderBottom: "1px solid var(--t-b2)" }}>
              <td className="px-4 py-3">
                <button onClick={() => setViewing(u)} className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity group">
                  {u.avatar
                    ? <img src={u.avatar} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
                    : <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold text-white flex-shrink-0" style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>{(u.display_name || u.email || "?").trim().charAt(0).toUpperCase()}</div>}
                  <div className="min-w-0">
                    <div className="font-medium text-ink truncate group-hover:text-accent">{u.display_name}</div>
                    <div className="text-[11px] text-muted truncate">{u.title ? `${u.title} · ` : ""}{u.email}</div>
                  </div>
                </button>
              </td>
              <td className="px-4 py-3">
                <select value={u.role_id} disabled={u.id === me} onChange={(e) => setRole(u.id, e.target.value)}
                  className="border border-line px-2 h-8 rounded-lg text-[12px] bg-surface disabled:opacity-60">
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select defaultValue={(u as any).pay_type || "profit_pct"} onChange={(e) => setPayType(u.id, e.target.value)}
                    className="border border-line px-1.5 h-8 rounded-lg text-[11.5px] bg-surface">
                    <option value="profit_pct">% profit</option>
                    <option value="gross_pct">% gross</option>
                    <option value="fixed">fixed $</option>
                  </select>
                  <input type="number" min={0} defaultValue={u.commission_pct} onBlur={(e) => setComm(u.id, parseFloat(e.target.value) || 0)}
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
            : <div className="w-20 h-20 rounded-full flex items-center justify-center text-[28px] font-bold text-white" style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))" }}>{(u.display_name || u.email || "?").trim().charAt(0).toUpperCase()}</div>}
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
          <button onClick={onClose} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium">Close</button>
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
              {!full && <button onClick={() => save(r.id)} className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-lg text-[12px] font-medium">Save</button>}
            </div>
            {full ? (
              <p className="text-[12px] text-muted">Full access — everything (can't be limited).</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-[13px] font-medium text-ink-2 mb-3 cursor-pointer">
                  <input type="checkbox" checked={!!has("admin:manage")} onChange={() => toggle(r.id, "admin:manage")} />
                  Full admin (manage team, roles &amp; settings)
                </label>
                <table className="text-[12px]">
                  <thead><tr><th></th>{ACTIONS.map((a) => <th key={a} className="px-3 text-[10px] uppercase tracking-wide text-muted">{a}</th>)}</tr></thead>
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
                <div className="mt-4 pt-3 border-t border-line">
                  <div className="text-[10px] uppercase tracking-wide text-muted mb-2">Sensitive visibility</div>
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
        <button onClick={create} disabled={!newRole.trim()} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">Add role</button>
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
  const revoke = async (token: string) => { await api.revokeInvite(token); load(); };
  const reopen = async (token: string) => { await api.reopenInvite(token); load(); };

  const status = (i: InviteRow) => i.used_at ? "Used" : (new Date(i.expires_at) < new Date() ? "Expired" : "Pending");

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-4">
        <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Create invite link</p>
        <div className="flex gap-2">
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="border border-line px-2 h-9 rounded-lg text-[13px] bg-surface">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input className={inpSm} placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button onClick={create} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium whitespace-nowrap">Create</button>
        </div>
        {created && (
          <div className="mt-3 bg-success-bg border border-success rounded-lg px-3 py-2">
            <p className="text-[12px] font-medium text-success-ink mb-1">Invite link ready — share it:</p>
            <code className="text-[12px] text-success-ink break-all select-all">{base}{created.signup_path}</code>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <table className="w-full text-[13px]">
          <thead><tr style={{ borderBottom: "1px solid var(--t-b2)" }}>
            {["Role", "Email", "Status", "Expires", ""].map((h, i) => <th key={i} className={`text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted ${i === 4 ? "text-right" : ""}`}>{h}</th>)}
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
      <h3 className="text-[14px] font-semibold text-ink mb-1">Invoice Numbering</h3>
      <p className="text-[12px] text-muted mb-4">Customize how new invoice numbers are generated.</p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Prefix</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" value={cfg.prefix}
            onChange={(e) => update({ prefix: e.target.value })} placeholder="INV-" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Padding</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" type="number" value={cfg.padding}
            onChange={(e) => update({ padding: parseInt(e.target.value) || 1 })} />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Start at</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" type="number" value={cfg.next_number}
            onChange={(e) => update({ next_number: parseInt(e.target.value) || 1 })} />
        </div>
      </div>
      <p className="text-[11px] text-muted mb-3">Preview: <span className="font-mono font-semibold text-accent-hover">{cfg.preview}</span></p>
      <button onClick={save} className="bg-accent hover:bg-accent-hover text-white px-4 h-8 rounded-lg text-[12px] font-medium">
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
      <h3 className="text-[14px] font-semibold text-ink mb-1">Quote Numbering</h3>
      <p className="text-[12px] text-muted mb-4">Customize how new quote numbers are generated — including which number to start at.</p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Prefix</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" value={cfg.prefix}
            onChange={(e) => update({ prefix: e.target.value })} placeholder="QUO-" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Padding</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" type="number" value={cfg.padding}
            onChange={(e) => update({ padding: parseInt(e.target.value) || 1 })} />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Start at</label>
          <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full" type="number" value={cfg.next_number}
            onChange={(e) => update({ next_number: parseInt(e.target.value) || 1 })} />
        </div>
      </div>
      <p className="text-[11px] text-muted mb-3">Preview: <span className="font-mono font-semibold text-accent-hover">{cfg.preview}</span></p>
      <button onClick={save} className="bg-accent hover:bg-accent-hover text-white px-4 h-8 rounded-lg text-[12px] font-medium">
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
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
              Publishable Key {config?.publishable_key_present && <span className="text-success-ink">●</span>}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="pk_test_..." value={pk} onChange={(e) => setPk(e.target.value)} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
              Secret Key {config?.secret_key_present && <span className="text-success-ink">●</span>}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="sk_test_..." value={sk} onChange={(e) => setSk(e.target.value)} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
              Webhook Secret {config?.webhook_secret_present && <span className="text-success-ink">●</span>}
            </label>
            <input className="border border-line px-3 h-9 rounded-lg text-[13px] w-full font-mono" type="password" placeholder="whsec_..." value={wh} onChange={(e) => setWh(e.target.value)} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={!showKeys || !pk || !sk} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">Save Keys</button>
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
    <div className="text-[10px] font-semibold text-muted uppercase tracking-widest">{children}</div>
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
      <button onClick={openCreate} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium mb-4">
        + Add Custom Field
      </button>
      {fields.length === 0 ? (
        <p className="text-[13px] text-muted">No custom fields defined.</p>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase">Label</th>
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase">Key</th>
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase">Type</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.id} className="border-t border-gray-50 hover:bg-surface-2/50">
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
          <div className="bg-surface rounded-2xl shadow-xl w-[380px] p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-ink mb-4">{editing ? "Edit Field" : "New Field"}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase mb-1">Label</label>
                <input className={inp} value={form.label} onChange={e => { const lbl = e.target.value; setForm({ ...form, label: lbl, field_key: lbl.toLowerCase().replace(/[^a-z0-9_]/g, "_") }); }} placeholder="e.g. Loyalty Tier" />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase mb-1">Key</label>
                <input className={inp + " font-mono text-[12px]"} value={form.field_key} onChange={e => setForm({ ...form, field_key: e.target.value })} placeholder="loyalty_tier" />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase mb-1">Type</label>
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
                  <label className="block text-[10px] font-medium text-muted uppercase mb-1">Options (comma-separated)</label>
                  <input className={inp} value={form.options_json ?? ""} onChange={e => setForm({ ...form, options_json: e.target.value || null })} placeholder="Gold, Silver, Bronze" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
              <button onClick={save} disabled={!form.label.trim() || !form.field_key.trim()} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
                {editing ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
