import { useEffect, useState } from "react";
import {
  api,
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
  FollowUpRule,
  FollowUpLogEntry,
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
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";

const inp = "border border-gray-200 px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";
const inpSm = "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

export default function SettingsView() {
  const [tab, setTab] = useState<
    "email" | "company" | "categories" | "ai" | "sync" | "import" | "automation" | "payments" | "templates" | "sheets" | "splits" | "backup" | "team"
  >("email");

  const TABS = ["email", "company", "categories", "ai", "sync", "import", "automation", "payments", "templates", "sheets", "splits", "backup", "team"] as const;

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Settings</h2>
        <p className="text-[12px] text-gray-400 mt-0.5">Configure your account, integrations, and preferences.</p>
      </div>

      {/* Underline tab bar */}
      <div className="flex gap-0 border-b border-gray-100 mb-7 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-[13px] border-b-2 -mb-px capitalize transition-colors whitespace-nowrap ${
              tab === t
                ? "border-indigo-500 text-indigo-700 font-medium"
                : "border-transparent text-gray-400 hover:text-gray-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "email"      && <EmailTab />}
      {tab === "company"    && <CompanyTab />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "ai"         && <AiTab />}
      {tab === "sync"       && <SyncTab />}
      {tab === "import"     && <ImportTab />}
      {tab === "automation" && <AutomationTab />}
      {tab === "payments"   && <PaymentsTab />}
      {tab === "templates"  && <TemplatesTab />}
      {tab === "sheets"     && <SheetsTab />}
      {tab === "splits"     && <SplitsTab />}
      {tab === "backup"     && <BackupTab />}
      {tab === "team"       && <TeamTab />}
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
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 transition-colors"
        >
          {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Field>
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-gray-400 mb-5">
        Credentials are stored in your OS keychain — never written to disk or synced.
      </p>

      <Field label="Auth method">
        <div className="flex gap-5">
          {[
            { val: "password", label: "Password / App Password" },
            { val: "oauth2",   label: "OAuth2 (Gmail / Outlook)" },
          ].map((opt) => (
            <label key={opt.val} className="flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer">
              <input
                type="radio"
                checked={settings.auth_method === opt.val}
                onChange={() => setSettings({ ...settings, auth_method: opt.val as "password" | "oauth2" })}
                className="accent-indigo-600"
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
            <label className="block text-[12px] font-medium text-gray-500 mb-1.5">Google Authorization</label>
            <button
              type="button"
              onClick={authorize}
              disabled={oauthConnecting || !oauthClientId || !oauthClientSecret}
              className={`px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-2 transition-colors ${
                oauthConnected
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white"
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
          <p className="text-[12px] text-gray-400 mb-4">
            Enter your Client ID and Secret from Google Cloud Console, then click Authorize and approve access in your browser.
          </p>
        </>
      )}

      {error && (
        <div className="text-red-600 text-[13px] flex items-center gap-1.5 mt-2 mb-3">
          <AlertCircle size={13} /> {error}
        </div>
      )}
      <button
        onClick={save}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors"
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? "Saved" : "Save Settings"}
      </button>

      <div className="mt-8 pt-6 border-t border-gray-100">
        <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Pi / Mobile Sync</h3>
        <p className="text-[12px] text-gray-400 mb-4">
          Enter your SMTP password to enable newsletter sending from your phone and Pi server.
          This is stored in the database and synced via Syncthing — separate from the keychain above.
        </p>
        <PiSmtpSection settings={settings} />
      </div>
    </div>
  );
}

function PiSmtpSection({ settings }: { settings: EmailSettings }) {
  const [smtpPassword, setSmtpPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [saved, setSaved] = useState(false);
  const [existing, setExisting] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.getSmtpSettingsForPi().then((s) => {
      setExisting(s);
      if (s.smtp_from_name) setFromName(s.smtp_from_name);
    }).catch(console.error);
  }, []);

  const save = async () => {
    await api.saveSmtpSettingsForPi({
      smtp_host: settings.smtp_host,
      smtp_port: String(settings.smtp_port),
      smtp_username: settings.user,
      smtp_password: smtpPassword,
      smtp_from_name: fromName,
      smtp_from_email: settings.user,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-3">
      <Field label="From name (shown in emails)">
        <input className={inp} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your Business Name" />
      </Field>
      <Field label="SMTP password for Pi/Mobile">
        <div className="relative">
          <input
            type="password"
            value={smtpPassword}
            onChange={(e) => setSmtpPassword(e.target.value)}
            className={inp}
            placeholder={existing?.smtp_password_set ? "•••••••• (currently set — leave blank to keep)" : "Enter SMTP password"}
          />
        </div>
      </Field>
      <button
        onClick={save}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors"
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? "Saved for Pi" : "Save for Pi"}
      </button>
    </div>
  );
}

function CompanyTab() {
  const [info, setInfo] = useState<CompanyInfo>({ name: "", address: "", email: "", phone: "", tax_id: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getCompanyInfo().then((c) => c && setInfo(c)).catch(console.error);
  }, []);

  const save = async () => {
    await api.saveCompanyInfo(info);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const pickLogo = async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof selected === "string") setInfo({ ...info, logo_path: selected });
  };

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      <p className="text-[12px] text-gray-400 mb-5">This information appears on every PDF invoice.</p>

      <Field label="Company Logo">
        <div className="flex items-center gap-3">
          {info.logo_path ? (
            <div className="relative">
              <img
                src={convertFileSrc(info.logo_path)}
                alt="Logo preview"
                className="h-16 w-auto border border-gray-100 rounded-lg object-contain bg-gray-50"
              />
              <button
                onClick={() => setInfo({ ...info, logo_path: null })}
                className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600 transition-colors"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ) : (
            <div className="h-16 w-16 border border-gray-100 rounded-lg bg-gray-50 flex items-center justify-center text-gray-300">
              <Image size={22} />
            </div>
          )}
          <button
            onClick={pickLogo}
            className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 h-9 rounded-lg text-[13px] transition-colors"
          >
            {info.logo_path ? "Change" : "Choose Logo"}
          </button>
        </div>
      </Field>

      <Field label="Company name">
        <input className={inp} value={info.name}    onChange={(e) => setInfo({ ...info, name: e.target.value })} />
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

      <button
        onClick={save}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors"
      >
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? "Saved" : "Save"}
      </button>
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      {/* Status indicator */}
      <div className="flex items-center gap-2 mb-5 pb-5 border-b border-gray-50">
        <span className="text-[13px] font-medium text-gray-600">Ollama status</span>
        {online === null ? (
          <span className="text-[13px] text-gray-400">checking...</span>
        ) : (
          <span className={`flex items-center gap-1.5 text-[13px] font-medium ${online ? "text-emerald-600" : "text-red-500"}`}>
            <span className={`w-2 h-2 rounded-full ${online ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" : "bg-red-400"}`} />
            {online ? "Online" : (
              <>offline — start with <code className="bg-gray-100 px-1.5 py-0.5 rounded-md text-[12px] ml-1">ollama serve</code></>
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

      <p className="text-[12px] text-gray-400 mb-5">
        Recommended: <code className="bg-gray-100 px-1 rounded">llama3.1:8b</code> for general use,{" "}
        <code className="bg-gray-100 px-1 rounded">qwen2.5:14b</code> for better extraction quality.
        Pull with <code className="bg-gray-100 px-1.5 py-0.5 rounded">ollama pull &lt;model&gt;</code>.
      </p>

      <button
        onClick={save}
        disabled={!selected}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
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

  const refresh       = () => api.syncStatus().then(setStatus);
  const checkEncrypted= () => api.syncIsEncrypted().then(setEncrypted).catch(() => {});
  useEffect(() => { refresh(); checkEncrypted(); }, []);

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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl space-y-6">
      {/* Status */}
      <div>
        <SectionLabel>Sync Status</SectionLabel>
        <div className="bg-gray-50/80 border border-gray-100 rounded-xl px-4 py-3 space-y-1.5 mt-2">
          <div className="flex justify-between text-[13px]">
            <span className="text-gray-500">Events applied</span>
            <span className="font-mono text-gray-800">{status?.events_applied ?? 0}</span>
          </div>
          <div className="flex justify-between text-[13px]">
            <span className="text-gray-500">Last applied</span>
            <span className="font-mono text-gray-800">
              {status?.last_applied ? new Date(status.last_applied).toLocaleString() : "—"}
            </span>
          </div>
        </div>
        <button
          onClick={replay}
          disabled={replaying}
          className="mt-3 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-5 h-9 rounded-lg text-[13px] transition-colors disabled:opacity-50"
        >
          {replaying ? "Replaying..." : "Replay All Events"}
        </button>
      </div>

      {/* Updates */}
      <div className="border-t border-gray-100 pt-5">
        <SectionLabel>App Updates</SectionLabel>
        <div className="mt-2">
          <UpdateButton />
        </div>
      </div>

      {/* Encryption */}
      <div className="border-t border-gray-100 pt-5">
        <SectionLabel>Encryption</SectionLabel>
        {encrypted === null ? (
          <p className="text-[13px] text-gray-400 mt-2">checking...</p>
        ) : encrypted ? (
          <div className="flex items-center gap-2 mt-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
            <p className="text-[13px] text-emerald-600 font-medium">Sync events are encrypted at rest</p>
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-[12px] text-gray-500 mb-3">
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
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {settingPassphrase ? "Setting..." : "Enable"}
              </button>
            </div>
            {encryptError && (
              <div className="text-red-500 text-[13px] mt-2 flex items-center gap-1.5">
                <AlertCircle size={13} /> {encryptError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* How sync works */}
      <div className="border-t border-gray-100 pt-5">
        <SectionLabel>How Sync Works</SectionLabel>
        <p className="text-[12px] text-gray-500 mt-2 mb-2">
          ClientHub uses an append-only event log with Hybrid Logical Clocks. Every write produces a JSON event in:
        </p>
        <code className="block bg-gray-50 border border-gray-100 px-4 py-3 rounded-xl text-[11px] font-mono text-gray-500">
          ~/Library/Application Support/com.bjmdistributions.clienthub/sync/ (macOS)<br />
          %APPDATA%\com.bjmdistributions.clienthub\sync\ (Windows)
        </code>
        <p className="text-[12px] text-gray-500 mt-2">
          Point Syncthing or another file-sync tool at this folder. Conflict-free merging is handled
          automatically per-column with last-write-wins semantics.
        </p>
      </div>
    </div>
  );
}

function ImportTab() {
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-3xl">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Import from Google Sheets / CSV</h3>
      <p className="text-[12px] text-gray-400 mb-5">
        Export your sheet as CSV (File → Download → CSV in Google Sheets), then upload it here.
        Existing clients are deduplicated by email.
      </p>

      <button
        onClick={pickFile}
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-lg text-[13px] flex items-center gap-2 mb-4 transition-colors"
      >
        <Upload size={13} /> {path ? "Change file" : "Choose CSV file"}
      </button>

      {path && <div className="text-[12px] text-gray-400 mb-4 font-mono">{path}</div>}

      {preview && (
        <>
          <div className="bg-gray-50/80 border border-gray-100 px-4 py-3 rounded-xl mb-5">
            <div className="text-[13px] font-medium text-gray-800 mb-0.5">{preview.total_rows} rows detected</div>
            <div className="text-[12px] text-gray-400">Headers: {preview.headers.join(", ")}</div>
          </div>

          <SectionLabel>Map Columns</SectionLabel>
          <div className="space-y-2 mt-2 mb-5">
            {CORE_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-3 gap-2 items-center">
                <label className="text-[13px] text-gray-700">{f.label}</label>
                <select
                  className="col-span-2 border border-gray-200 px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
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
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <input type="checkbox" className="sr-only" checked={metaKeys.includes(h)} onChange={() => toggleMetaKey(h)} />
                  {h}
                </label>
              ))}
          </div>

          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Preview (first 5 rows)</div>
          <div className="overflow-auto max-h-40 mb-5 border border-gray-100 rounded-xl">
            <table className="text-[12px] w-full">
              <thead className="bg-gray-50">
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    {row.map((cell, j) => (
                      <td key={j} className="px-3 py-1.5 truncate max-w-[120px] text-gray-600">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={runImport}
            disabled={importing || (!mapping.first_name && !mapping.last_name)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            {importing ? "Importing..." : `Import ${preview.total_rows} clients`}
          </button>
        </>
      )}

      {summary && (
        <div className="mt-5 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
          <div className="text-[13px] font-medium text-emerald-800">
            ✓ Imported {summary.imported} clients
          </div>
          {summary.skipped > 0 && (
            <div className="text-[12px] text-gray-600 mt-1">
              Skipped {summary.skipped} (duplicates or empty names)
            </div>
          )}
          {summary.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-red-600">{summary.errors.length} errors</summary>
              <ul className="text-[11px] mt-1 space-y-0.5 text-gray-600">
                {summary.errors.map((e, i) => (<li key={i}>{e}</li>))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 text-red-500 text-[13px] flex items-center gap-1.5">
          <AlertCircle size={13} /> {error}
        </div>
      )}
    </div>
  );
}

function AutomationTab() {
  const [rules,    setRules]    = useState<SignupRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState({ name: "", sender_pattern: "", subject_pattern: "" });

  const load = () => api.listSignupRules().then(setRules).catch(console.error);
  useEffect(() => { load(); }, []);

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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={15} className="text-indigo-500" />
        <h3 className="text-[14px] font-semibold text-gray-900">Auto-detect Signup Emails</h3>
      </div>
      <p className="text-[12px] text-gray-400 mb-5">
        When an incoming email matches a rule, AI extracts client info from the body and
        auto-creates a client record. Patterns are{" "}
        <a href="https://docs.rs/regex/latest/regex/#syntax" target="_blank" rel="noreferrer" className="text-indigo-500 underline">regular expressions</a>.
      </p>

      <button onClick={() => setShowForm(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 mb-5 transition-colors">
        <Plus size={13} /> Add rule
      </button>

      {showForm && (
        <div className="border border-gray-100 rounded-xl p-4 mb-5 space-y-3 bg-gray-50/80">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Rule name</label>
            <input className={inp} placeholder="e.g. Typeform new client signups" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Sender pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. noreply@typeform\.com" value={form.sender_pattern} onChange={(e) => setForm({ ...form, sender_pattern: e.target.value })} />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Subject pattern (regex)</label>
            <input className={`${inp} font-mono`} placeholder="e.g. (?i)new\s+(client|signup|inquiry)" value={form.subject_pattern} onChange={(e) => setForm({ ...form, subject_pattern: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-[13px] text-gray-500 hover:text-gray-800 transition-colors">Cancel</button>
            <button onClick={save} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">Save Rule</button>
          </div>
        </div>
      )}

      <div className="space-y-2 mb-8">
        {rules.map((r) => (
          <div key={r.id} className="border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between hover:border-gray-200 transition-colors">
            <div className="flex-1">
              <div className="text-[13px] font-medium text-gray-900">{r.name}</div>
              <div className="text-[11px] text-gray-400 font-mono space-y-0.5 mt-0.5">
                {r.sender_pattern && <div>From: {r.sender_pattern}</div>}
                {r.subject_pattern && <div>Subject: {r.subject_pattern}</div>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer text-gray-500">
                <input type="checkbox" className="accent-indigo-600" checked={r.active} onChange={(e) => api.toggleSignupRule(r.id, e.target.checked).then(load)} /> Active
              </label>
              <button onClick={() => confirm("Delete rule?") && api.deleteSignupRule(r.id).then(load)} className="text-gray-300 hover:text-red-500 p-1 rounded-lg hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {rules.length === 0 && <div className="text-center text-[13px] text-gray-400 py-10">No rules yet. Add one to start auto-importing clients from signup emails.</div>}
      </div>

      <div className="border-t border-gray-100 pt-5">
        <div className="flex items-center gap-2 mb-1">
          <RefreshCw size={15} className="text-indigo-500" />
          <h3 className="text-[14px] font-semibold text-gray-900">Follow-Up Rules</h3>
        </div>
        <p className="text-[12px] text-gray-400 mb-1">
          Automatically email or remind clients based on triggers.{" "}
          {lastRun && <span>Last checked: {(() => { const d = new Date(lastRun); const mins = Math.floor((Date.now() - d.getTime()) / 60000); return mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} hours ago`; })()}</span>}
        </p>

        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => { setEditingFu(null); setFuForm({ name: "", trigger_type: "no_order", trigger_value: 30, action_type: "email", email_subject: "", email_body: "" }); setShowFuForm(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-8 rounded-lg text-[12px] font-medium flex items-center gap-1">
            <Plus size={12} /> Add Rule
          </button>
          <button onClick={() => api.processFollowupRules().then(loadFu).catch(alert)} className="text-[12px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-50">Run Now</button>
        </div>

        {showFuForm && (
          <div className="border border-gray-100 rounded-xl p-4 mb-4 space-y-3 bg-gray-50/80">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Name</label>
                <input className={inp} value={fuForm.name} onChange={(e) => setFuForm({ ...fuForm, name: e.target.value })} placeholder="Check-in reminder" />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Trigger</label>
                <select className={inp} value={fuForm.trigger_type} onChange={(e) => setFuForm({ ...fuForm, trigger_type: e.target.value })}>
                  {Object.entries(triggerLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Days</label>
                <input className={inp} type="number" value={fuForm.trigger_value} onChange={(e) => setFuForm({ ...fuForm, trigger_value: parseInt(e.target.value) || 0 })} />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Action</label>
                <select className={inp} value={fuForm.action_type} onChange={(e) => setFuForm({ ...fuForm, action_type: e.target.value })}>
                  {Object.entries(actionLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            </div>
            {isEmailAction && (
              <>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Email Subject</label>
                  <input className={inp} value={fuForm.email_subject} onChange={(e) => setFuForm({ ...fuForm, email_subject: e.target.value })} placeholder="Just checking in" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Email Body</label>
                  <textarea className={inp + " h-20 resize-none"} value={fuForm.email_body} onChange={(e) => setFuForm({ ...fuForm, email_body: e.target.value })} placeholder="Hi {client_name}, hope things are going well..." />
                  <p className="text-[10px] text-gray-400 mt-1">Available variables: {"{client_name}"}</p>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowFuForm(false); setEditingFu(null); }} className="text-[13px] text-gray-500 hover:text-gray-800 transition-colors">Cancel</button>
              <button onClick={saveFu} disabled={!fuForm.name.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50">
                {editingFu ? "Save Changes" : "Create Rule"}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {fuRules.map((r) => (
            <div key={r.id} className="border border-gray-100 rounded-xl px-4 py-3 flex items-center justify-between hover:border-gray-200 transition-colors">
              <div className="flex-1">
                <div className="text-[13px] font-medium text-gray-900">{r.name}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">{triggerLabels[r.trigger_type] || r.trigger_type} &gt; {r.trigger_value}d → {actionLabels[r.action_type] || r.action_type}</div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer text-gray-500">
                  <input type="checkbox" className="accent-indigo-600" checked={r.is_active} onChange={() => api.toggleFollowupRule(r.id).then(loadFu)} /> Active
                </label>
                <button onClick={() => editFu(r)} className="text-[11px] text-gray-400 hover:text-gray-600">Edit</button>
                <button onClick={() => confirm("Delete rule?") && api.deleteFollowupRule(r.id).then(loadFu)} className="text-gray-300 hover:text-red-500 p-1 rounded-lg hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>

        {fuLog.length > 0 && (
          <div className="mt-4 border-t border-gray-50 pt-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Recent Activity</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {fuLog.slice(0, 20).map((l) => (
                <div key={l.id} className="text-[11px] text-gray-500 flex items-center gap-2">
                  <span className="text-gray-400 w-16 flex-shrink-0">{l.triggered_at.slice(0, 10)}</span>
                  <span className="font-medium text-gray-600">{l.action_taken}</span>
                  {l.details && <span className="text-gray-400 truncate">— {l.details}</span>}
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
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-5 h-9 rounded-lg text-[13px] disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking..." : "Check for Updates"}
      </button>
      {status && <p className="text-[12px] text-gray-500 mt-2">{status}</p>}
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[14px] font-semibold text-gray-900">Payment Methods</h3>
        <button
          onClick={() => { setEditing(null); setForm({ kind: "ACH", label: "", details: "" }); setShowForm(true); }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      </div>
      <p className="text-[12px] text-gray-400 mb-5">Active methods appear on every invoice.</p>

      {showForm && (
        <div className="border border-gray-100 rounded-xl p-4 mb-5 bg-gray-50/80 space-y-3">
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
              className="border border-gray-200 px-3 py-2 rounded-lg text-[13px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
              placeholder={"Account #: 123456789\nRouting: 021000021\nBank: Chase"}
              value={form.details ?? ""}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setEditing(null); }}
              className="text-[13px] text-gray-500 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!form.label.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
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
            className={`border border-gray-100 rounded-xl px-4 py-3 flex items-start justify-between hover:border-gray-200 transition-colors ${m.active ? "" : "opacity-50"}`}
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold font-mono bg-gray-100 px-2 py-0.5 rounded-md text-gray-500 uppercase tracking-wide">
                  {m.kind}
                </span>
                <span className="text-[13px] font-medium text-gray-900">{m.label}</span>
              </div>
              {m.details && (
                <pre className="text-[11px] text-gray-400 mt-1 whitespace-pre-wrap font-mono">{m.details}</pre>
              )}
            </div>
            <div className="flex items-center gap-1 ml-3">
              <button onClick={() => moveUp(i)}   className="text-gray-300 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"><ChevronUp   size={13} /></button>
              <button onClick={() => moveDown(i)} className="text-gray-300 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"><ChevronDown size={13} /></button>
              <button
                onClick={() => { setEditing(m); setForm({ kind: m.kind, label: m.label, details: m.details }); setShowForm(true); }}
                className="text-gray-300 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <Edit2 size={13} />
              </button>
              <button onClick={() => remove(m.id)} className="text-gray-300 hover:text-red-500 p-1 rounded-lg hover:bg-red-50 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
        {methods.length === 0 && (
          <div className="text-center text-[13px] text-gray-400 py-10">
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Line Item Templates</h3>
      <p className="text-[12px] text-gray-400 mb-5">Saved line items for quick invoice creation.</p>

      {/* Add row */}
      <div className="grid grid-cols-12 gap-2 mb-5">
        <div className="col-span-7">
          <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Description</label>
          <input
            className={inpSm}
            placeholder="e.g. Standard order processing"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Rate</label>
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
          <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Qty</label>
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
            className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 rounded-lg text-[13px] font-medium w-full disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center justify-between border border-gray-100 rounded-xl px-4 py-2.5 hover:border-gray-200 transition-colors">
            <span className="text-[13px] text-gray-800">{t.description}</span>
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-gray-400 tabular-nums">{fmtAmount(t.rate)} × {t.qty}</span>
              <button onClick={() => remove(t.id)} className="text-gray-300 hover:text-red-500 p-1 rounded-lg hover:bg-red-50 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="text-center text-[13px] text-gray-400 py-10">No templates yet.</div>
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
      <p className="text-[12px] text-gray-400 mb-4">
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
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-10 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      <div className="bg-white border border-gray-100 rounded-xl divide-y divide-gray-50 overflow-hidden">
        {cats.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50/50 transition-colors">
            {editingId === c.id ? (
              <>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && update(c.id)}
                  className="flex-1 border border-gray-200 px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
                  autoFocus
                />
                <button onClick={() => update(c.id)}    className="text-emerald-500 hover:text-emerald-600 p-1.5 rounded-lg hover:bg-emerald-50 transition-colors"><Check  size={13} /></button>
                <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"><X size={13} /></button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <button onClick={() => move(c.id, -1)} disabled={i === 0}                className="text-gray-200 hover:text-gray-400 disabled:opacity-20 transition-colors"><ChevronUp   size={12} /></button>
                  <button onClick={() => move(c.id,  1)} disabled={i === cats.length - 1} className="text-gray-200 hover:text-gray-400 disabled:opacity-20 transition-colors"><ChevronDown size={12} /></button>
                </div>
                <span className="flex-1 text-[13px] text-gray-800">{c.label}</span>
                <button onClick={() => { setEditingId(c.id); setEditLabel(c.label); }} className="text-gray-300 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"><Edit2  size={13} /></button>
                <button onClick={() => remove(c.id, c.label)}                          className="text-gray-300 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50  transition-colors"><Trash2 size={13} /></button>
              </>
            )}
          </div>
        ))}
        {cats.length === 0 && (
          <div className="text-center text-[13px] text-gray-400 py-8">No categories defined yet.</div>
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
    last_synced_at: null, last_synced_count: 0,
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

  const colSelect = "border border-gray-200 h-9 px-2 rounded-lg text-[12px] w-full bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-[12px] text-gray-400">
        Share your Google Sheet as <strong className="text-gray-600">'Anyone with link can view'</strong>, paste the URL below. ClientHub syncs new clients automatically every 10 minutes.
      </p>

      {/* Setup */}
      <div className="bg-white border border-gray-100 rounded-xl p-5">
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
                <label className="block text-[10px] font-medium text-gray-400 mb-1">
                  {f.label} <span className="text-gray-300">({f.hint})</span>
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
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Skip header rows</label>
            <input type="number" min={0} value={config.skip_header_rows} onChange={(e) => setConfig({ ...config, skip_header_rows: Number(e.target.value) })} className={inpSm} />
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <Save size={13} /> {saving ? "Saving..." : "Save Config"}
          </button>
        </div>
      </div>

      {/* Sync */}
      <div className="bg-white border border-gray-100 rounded-xl p-5">
        <SectionLabel>Sync</SectionLabel>
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={syncNow}
            disabled={syncing || !config.sheet_url}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <span className="text-[12px] text-gray-400">
            {config.last_synced_at ? `Last sync: ${relTime(config.last_synced_at)}` : "Never synced"}
            {config.last_synced_count > 0 && ` — ${config.last_synced_count} clients added`}
          </span>
        </div>
        <div className="text-[11px] text-gray-300 mt-1.5">Auto-syncs every 10 minutes</div>

        {result && (
          <div className={`mt-3 text-[12px] px-3 py-2 rounded-lg ${result.errors.length > 0 ? "bg-amber-50 text-amber-800 border border-amber-100" : "bg-emerald-50 text-emerald-800 border border-emerald-100"}`}>
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
      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-50">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Sync History</span>
        </div>
        {log.length === 0 ? (
          <div className="text-center text-[13px] text-gray-400 py-8">No syncs yet</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Date</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">New</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Skipped</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Errors</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id} className="border-t border-gray-50 hover:bg-gray-50/40 transition-colors">
                  <td className="px-5 py-2.5 text-[12px] text-gray-600">{new Date(l.synced_at).toLocaleString()}</td>
                  <td className="px-5 py-2.5 text-[12px] text-emerald-600 text-right tabular-nums">{l.new_clients}</td>
                  <td className="px-5 py-2.5 text-[12px] text-gray-400 text-right tabular-nums">{l.skipped_duplicates}</td>
                  <td className="px-5 py-2.5 text-[12px] text-right">
                    {l.errors ? <span className="text-amber-500">{JSON.parse(l.errors).length}</span> : <span className="text-gray-200">0</span>}
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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.getProfitSplit().then(setSplit).catch(() => {});
  }, []);

  if (!split) return <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>;

  const total = split.jack_pct + split.ben_pct + split.business_pct;
  const valid = Math.abs(total - 100) < 0.01;

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.saveProfitSplit(split.business_pct, split.jack_pct, split.ben_pct, split.jack_name, split.ben_name);
      setMsg("saved");
    } catch (e: any) {
      setMsg(e);
    } finally {
      setSaving(false);
    }
  };

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
            <div className="text-[12px] font-medium text-gray-500 mb-1.5">Business share %</div>
            <div className="border border-gray-200 px-3 h-9 rounded-lg text-[13px] flex items-center bg-gray-50 text-gray-500">
              {split.business_pct.toFixed(1)}% (auto)
            </div>
          </div>
          <div>
            <div className="text-[12px] font-medium text-gray-500 mb-1.5">Total</div>
            <div className={`border px-3 h-9 rounded-lg text-[13px] flex items-center gap-1.5 ${
              valid ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            }`}>
              {valid ? <Check size={13} /> : <AlertCircle size={13} />}
              {total.toFixed(1)}%
              {!valid && <span className="text-[11px] ml-1">(must equal 100%)</span>}
            </div>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !valid}
          className="flex items-center gap-1.5 bg-zinc-900 text-white px-4 h-9 rounded-lg text-[13px] font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save Profit Split"}
        </button>
        {msg === "saved" && <p className="text-[12px] text-emerald-600 font-medium">Saved</p>}
        {msg && msg !== "saved" && <p className="text-[12px] text-red-600">{msg}</p>}
      </div>
    </div>
  );
}

function BackupTab() {
  const [status, setStatus] = useState<{ last_backup: string | null; backup_dir: string } | null>(null);
  const [backups, setBackups] = useState<{ filename: string; size: number; date: string }[]>([]);
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

  const handleRestore = async (filename: string) => {
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
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Database Backup</h3>
      <p className="text-[12px] text-gray-400 mb-5">Automatic daily backups. Restore if something goes wrong.</p>

      <div className="space-y-3 mb-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Backup location</p>
            <p className="text-[12px] text-gray-600 font-mono mt-0.5">{status?.backup_dir || "—"}</p>
          </div>
          <button onClick={handleDirChange} className="text-[11px] text-indigo-600 hover:text-indigo-800">Change</button>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Last backup</p>
          <p className="text-[13px] text-gray-700 mt-0.5">{lastTime}</p>
        </div>
      </div>

      <div className="flex gap-2 mb-5">
        <button onClick={handleBackup} disabled={busy} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 flex items-center gap-1.5">
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Backup Now
        </button>
      </div>

      {msg && <p className="text-[12px] text-emerald-600 font-medium mb-4">{msg}</p>}

      {backups.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Backups ({backups.length})</p>
          <div className="space-y-1">
            {backups.map((b) => (
              <div key={b.filename} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                <div>
                  <p className="text-[12px] font-medium text-gray-700">{b.date}</p>
                  <p className="text-[11px] text-gray-400">{fmtSize(b.size)}</p>
                </div>
                <button onClick={() => handleRestore(b.filename)} disabled={busy} className="text-[11px] text-red-500 hover:text-red-700 font-medium disabled:opacity-50">Restore</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("sales_rep");
  const [inviteResult, setInviteResult] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => { api.listUsers().then(setUsers).catch(() => {}); };
  useEffect(() => { load(); }, []);

  const handleInvite = async () => {
    if (!name.trim() || !email.trim()) return;
    setError(null);
    try {
      const u = await api.inviteUser(name.trim(), email.trim(), role);
      setInviteResult(u);
      setName(""); setEmail(""); setRole("sales_rep");
      load();
    } catch (e: any) { setError(e.toString()); }
  };

  const handleRemove = async (id: string) => {
    if (!confirm("Remove this user? They will lose access on next app launch.")) return;
    await api.removeUser(id);
    load();
  };

  const handleRoleChange = async (id: string, newRole: string) => {
    await api.updateUserRole(id, newRole);
    load();
  };

  const roleLabel = (r: string) => r === "sales_rep" ? "Sales Rep" : r === "owner" ? "Owner" : "Viewer";
  const roleColor = (r: string) => r === "owner" ? "bg-amber-100 text-amber-800" : r === "sales_rep" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700";

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-6 max-w-2xl">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-1">Team</h3>
      <p className="text-[12px] text-gray-400 mb-5">Invite team members and manage their access.</p>

      <div className="space-y-2 mb-5">
        {users.filter(u => u.is_active).map((u) => (
          <div key={u.id} className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-[12px] font-bold text-indigo-600">
                {u.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-[13px] font-medium text-gray-900">{u.name}</p>
                <p className="text-[11px] text-gray-400">{u.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {u.role !== "owner" ? (
                <select value={u.role} onChange={(e) => handleRoleChange(u.id, e.target.value)}
                  className="border border-gray-200 px-2 h-7 rounded-lg text-[11px]">
                  <option value="sales_rep">Sales Rep</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">OWNER</span>
              )}
              {u.role !== "owner" && (
                <button onClick={() => handleRemove(u.id)} className="text-[11px] text-red-500 hover:text-red-700 font-medium">Remove</button>
              )}
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="text-[12px] text-gray-400">No team members yet.</p>}
      </div>

      {inviteResult && (
        <div className="bg-emerald-50 border border-emerald-100 px-4 py-3 rounded-xl mb-5">
          <p className="text-[12px] font-medium text-emerald-800 mb-1">Invitation created for {inviteResult.name}</p>
          <p className="text-[11px] text-emerald-600">Share this invite code: <span className="font-mono font-bold text-[14px]">{inviteResult.invite_code}</span></p>
          <button onClick={() => setInviteResult(null)} className="text-[10px] text-emerald-500 mt-1">Dismiss</button>
        </div>
      )}

      <div className="border-t border-gray-100 pt-4">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Invite New Member</p>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input className="border border-gray-200 px-3 h-9 rounded-lg text-[12px]" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="border border-gray-200 px-3 h-9 rounded-lg text-[12px]" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div className="flex gap-2">
            <select value={role} onChange={(e) => setRole(e.target.value)} className="border border-gray-200 px-2 h-9 rounded-lg text-[12px] flex-1">
              <option value="sales_rep">Sales Rep</option>
              <option value="viewer">Viewer</option>
            </select>
            <button onClick={handleInvite} disabled={!name.trim() || !email.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 h-9 rounded-lg text-[12px] font-medium disabled:opacity-40">Invite</button>
          </div>
        </div>
        {error && <p className="text-[11px] text-red-500">{error}</p>}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{children}</div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[12px] font-medium text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
