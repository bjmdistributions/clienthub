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

export default function SettingsView() {
  const [tab, setTab] = useState<
    "email" | "company" | "categories" | "ai" | "sync" | "import" | "automation" | "payments" | "templates"
  >("email");

  const TABS = ["email", "company", "categories", "ai", "sync", "import", "automation", "payments", "templates"] as const;

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-gray-900 mb-4">Settings</h2>

      {/* Underline tabs */}
      <div className="flex gap-0 border-b border-gray-200 mb-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-[14px] border-b-2 -mb-px capitalize transition-colors ${
              tab === t
                ? "border-indigo-600 text-indigo-700 font-medium"
                : "border-transparent text-gray-500 hover:text-gray-800"
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
          className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full pr-10 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          placeholder="•••••••• (leave blank to keep current)"
        />
        <button
          type="button"
          onClick={onToggleSecrets}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
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
  const [smtpPass, setSmtpPass] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      console.error("Settings save error:", e);
      setError(e.toString());
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl">
      <p className="text-[13px] text-gray-500 mb-5">
        Credentials are stored in your operating system's keychain — never written to plain disk or synced.
      </p>

      <Field label="Auth method">
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer">
            <input
              type="radio"
              checked={settings.auth_method === "password"}
              onChange={() => setSettings({ ...settings, auth_method: "password" })}
            />
            Password / App Password
          </label>
          <label className="flex items-center gap-2 text-[14px] text-gray-700 cursor-pointer">
            <input
              type="radio"
              checked={settings.auth_method === "oauth2"}
              onChange={() => setSettings({ ...settings, auth_method: "oauth2" })}
            />
            OAuth2 (Gmail/Outlook)
          </label>
        </div>
      </Field>

      <Field label="Email address">
        <input
          className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={settings.user}
          onChange={(e) => setSettings({ ...settings, user: e.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="SMTP host">
          <input
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={settings.smtp_host}
            onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })}
          />
        </Field>
        <Field label="SMTP port">
          <input
            type="number"
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={settings.smtp_port}
            onChange={(e) => setSettings({ ...settings, smtp_port: parseInt(e.target.value) || 587 })}
          />
        </Field>
        <Field label="IMAP host">
          <input
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={settings.imap_host}
            onChange={(e) => setSettings({ ...settings, imap_host: e.target.value })}
          />
        </Field>
        <Field label="IMAP port">
          <input
            type="number"
            className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            value={settings.imap_port}
            onChange={(e) => setSettings({ ...settings, imap_port: parseInt(e.target.value) || 993 })}
          />
        </Field>
      </div>

      {settings.auth_method === "password" ? (
        <>
          <SecretInput label="SMTP password" value={smtpPass} onChange={setSmtpPass} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="IMAP password" value={imapPass} onChange={setImapPass} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
        </>
      ) : (
        <>
          <SecretInput label="OAuth Client ID" value={oauthClientId} onChange={setOauthClientId} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <SecretInput label="OAuth Client Secret" value={oauthClientSecret} onChange={setOauthClientSecret} showSecrets={showSecrets} onToggleSecrets={() => setShowSecrets((v) => !v)} />
          <div className="mb-4">
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Google Authorization</label>
            <button
              type="button"
              onClick={authorize}
              disabled={oauthConnecting || !oauthClientId || !oauthClientSecret}
              className={`px-4 h-9 rounded-md text-[14px] font-medium disabled:opacity-50 flex items-center gap-2 ${
                oauthConnected
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-indigo-600 hover:bg-indigo-700 text-white"
              }`}
            >
              {oauthConnecting ? (
                <><RefreshCw size={14} className="animate-spin" /> Authorizing...</>
              ) : oauthConnected ? (
                <><Check size={14} /> Connected</>
              ) : (
                "Authorize with Google"
              )}
            </button>
          </div>
          <p className="text-[12px] text-gray-500 mb-3">
            Enter your Client ID and Client Secret from the Google Cloud Console, click Authorize, and approve access in your browser.
          </p>
        </>
      )}

      {error && (
        <div className="text-red-600 text-[13px] flex items-center gap-1.5 mt-2 mb-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      <button
        onClick={save}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 mt-2 transition-colors"
      >
        {saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? "Saved" : "Save Settings"}
      </button>
    </div>
  );
}

function CompanyTab() {
  const [info, setInfo] = useState<CompanyInfo>({
    name: "", address: "", email: "", phone: "", tax_id: "",
  });
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

  const removeLogo = () => setInfo({ ...info, logo_path: null });

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl">
      <p className="text-[13px] text-gray-500 mb-5">This information appears on every PDF invoice.</p>

      <Field label="Company Logo">
        <div className="flex items-center gap-3">
          {info.logo_path ? (
            <div className="relative">
              <img
                src={info.logo_path ? convertFileSrc(info.logo_path) : undefined}
                alt="Logo preview"
                className="h-16 w-auto border border-gray-200 rounded-md object-contain bg-gray-50"
              />
              <button
                onClick={removeLogo}
                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ) : (
            <div className="h-16 w-16 border border-gray-200 rounded-md bg-gray-50 flex items-center justify-center text-gray-300">
              <Image size={24} />
            </div>
          )}
          <button
            onClick={pickLogo}
            className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-3 h-9 rounded-md text-[14px] transition-colors"
          >
            {info.logo_path ? "Change" : "Choose Logo"}
          </button>
        </div>
      </Field>

      <Field label="Company name">
        <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} />
      </Field>
      <Field label="Address">
        <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={info.address} onChange={(e) => setInfo({ ...info, address: e.target.value })} />
      </Field>
      <Field label="Email">
        <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={info.email} onChange={(e) => setInfo({ ...info, email: e.target.value })} />
      </Field>
      <Field label="Phone">
        <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={info.phone ?? ""} onChange={(e) => setInfo({ ...info, phone: e.target.value })} />
      </Field>
      <Field label="Tax ID / EIN">
        <input className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          value={info.tax_id ?? ""} onChange={(e) => setInfo({ ...info, tax_id: e.target.value })} />
      </Field>

      <button
        onClick={save}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium flex items-center gap-2 transition-colors"
      >
        {saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

function AiTab() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selected, setSelected] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    api.aiHealthCheck().then(setOnline);
    api.aiListModels().then(setModels).catch(() => {});
  }, []);

  const save = async () => {
    if (selected) await api.aiSetModel(selected);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl">
      <div className="mb-5">
        <span className="text-[14px] font-medium text-gray-700">Ollama status: </span>
        {online === null ? (
          <span className="text-[14px] text-gray-400">checking...</span>
        ) : online ? (
          <span className="text-[14px] text-emerald-600 font-medium">online</span>
        ) : (
          <span className="text-[14px] text-red-600">
            offline — start with{" "}
            <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[13px]">ollama serve</code>
          </span>
        )}
      </div>

      <Field label="Active model">
        <select
          className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
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

      <p className="text-[12px] text-gray-500 mb-4">
        Recommended: <code className="bg-gray-100 px-1 rounded">llama3.1:8b</code> for general use,{" "}
        <code className="bg-gray-100 px-1 rounded">qwen2.5:14b</code> for better extraction quality.
        Pull with <code className="bg-gray-100 px-1.5 py-0.5 rounded">ollama pull &lt;model&gt;</code>.
      </p>

      <button
        onClick={save}
        disabled={!selected}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40 transition-colors"
      >
        Set Active Model
      </button>
    </div>
  );
}

function SyncTab() {
  const [status, setStatus] = useState<{ events_applied: number; last_applied: string | null } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [settingPassphrase, setSettingPassphrase] = useState(false);
  const [encryptError, setEncryptError] = useState<string | null>(null);

  const refresh = () => api.syncStatus().then(setStatus);
  const checkEncrypted = () => api.syncIsEncrypted().then(setEncrypted).catch(() => {});

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
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl space-y-6">
      <div>
        <h3 className="text-[14px] font-semibold text-gray-900 mb-2">Sync Status</h3>
        <div className="text-[14px] text-gray-600 space-y-1">
          <div>
            Events applied:{" "}
            <span className="font-mono text-[13px] text-gray-800">{status?.events_applied ?? 0}</span>
          </div>
          <div>
            Last applied:{" "}
            <span className="font-mono text-[13px] text-gray-800">
              {status?.last_applied ? new Date(status.last_applied).toLocaleString() : "—"}
            </span>
          </div>
        </div>
      </div>

      <button
        onClick={replay}
        disabled={replaying}
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-5 h-9 rounded-md text-[14px] transition-colors"
      >
        {replaying ? "Replaying..." : "Replay All Events"}
      </button>

      <div className="border-t border-gray-100 pt-5">
        <h3 className="text-[14px] font-semibold text-gray-900 mb-2">Updates</h3>
        <UpdateButton />
      </div>

      <div className="border-t border-gray-100 pt-5">
        <h3 className="text-[14px] font-semibold text-gray-900 mb-2">Encryption</h3>
        {encrypted === null ? (
          <p className="text-[14px] text-gray-400">checking...</p>
        ) : encrypted ? (
          <p className="text-[14px] text-emerald-600 font-medium">
            Enabled — sync events are encrypted at rest
          </p>
        ) : (
          <div>
            <p className="text-[13px] text-gray-600 mb-3">
              Protect your sync data with a passphrase. All sync event files will be encrypted with
              ChaCha20-Poly1305. Enter the same passphrase on every device.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="Enter passphrase..."
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="border border-gray-300 px-3 h-10 rounded-md text-[14px] flex-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                onClick={handleSetPassphrase}
                disabled={settingPassphrase || !passphrase.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-10 rounded-md text-[14px] font-medium disabled:opacity-40"
              >
                {settingPassphrase ? "Setting..." : "Enable"}
              </button>
            </div>
            {encryptError && (
              <div className="text-red-600 text-[13px] mt-2 flex items-center gap-1.5">
                <AlertCircle size={14} /> {encryptError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-gray-100 pt-5">
        <h3 className="text-[14px] font-semibold text-gray-900 mb-2">How sync works</h3>
        <p className="text-[13px] text-gray-600 mb-2">
          ClientHub uses an append-only event log with Hybrid Logical Clocks. Every write produces a JSON event in:
        </p>
        <code className="block bg-gray-50 border border-gray-200 px-4 py-3 rounded-lg text-[12px] font-mono text-gray-600">
          ~/Library/Application Support/com.bjmdistributions.clienthub/sync/ (macOS)<br />
          %APPDATA%\com.bjmdistributions.clienthub\sync\ (Windows)
        </code>
        <p className="text-[13px] text-gray-600 mt-2">
          Point Syncthing or another file-sync tool at this folder. Conflict-free merging is handled
          automatically per-column with last-write-wins semantics.
        </p>
      </div>
    </div>
  );
}

function ImportTab() {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [metaKeys, setMetaKeys] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const CORE_FIELDS = [
    { key: "first_name", label: "First Name *" },
    { key: "last_name",  label: "Last Name" },
    { key: "email",      label: "Email" },
    { key: "phone",      label: "Phone" },
    { key: "company",    label: "Company Name" },
    { key: "notes",      label: "Notes" },
  ];

  const pickFile = async () => {
    setError(null);
    setSummary(null);
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
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
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-3xl">
      <h3 className="text-[15px] font-semibold text-gray-900 mb-1">Import from Google Sheets / CSV</h3>
      <p className="text-[13px] text-gray-500 mb-5">
        Export your sheet as CSV (File → Download → CSV in Google Sheets), then upload it here.
        Existing clients are deduplicated by email.
      </p>

      <button
        onClick={pickFile}
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] flex items-center gap-2 mb-4 transition-colors"
      >
        <Upload size={14} /> {path ? "Change file" : "Choose CSV file"}
      </button>

      {path && (
        <div className="text-[12px] text-gray-500 mb-4 font-mono">{path}</div>
      )}

      {preview && (
        <>
          <div className="bg-gray-50 border border-gray-200 px-4 py-3 rounded-lg mb-5">
            <div className="text-[14px] font-medium text-gray-800 mb-1">{preview.total_rows} rows detected</div>
            <div className="text-[12px] text-gray-500">Headers: {preview.headers.join(", ")}</div>
          </div>

          <h4 className="text-[13px] font-semibold text-gray-700 mb-3">Map columns</h4>
          <div className="space-y-2 mb-5">
            {CORE_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-3 gap-2 items-center">
                <label className="text-[14px] text-gray-700">{f.label}</label>
                <select
                  className="col-span-2 border border-gray-300 px-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={mapping[f.key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                >
                  <option value="">— skip —</option>
                  {preview.headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                </select>
              </div>
            ))}
          </div>

          <h4 className="text-[13px] font-semibold text-gray-700 mb-2">
            Extra fields → metadata ({metaKeys.length} selected)
          </h4>
          <div className="flex flex-wrap gap-2 mb-5">
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

          <div className="text-[12px] font-semibold text-gray-600 mb-2">Preview (first 5 rows):</div>
          <div className="overflow-auto max-h-40 mb-5 border border-gray-200 rounded-lg">
            <table className="text-[12px] w-full">
              <thead className="bg-gray-50">
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-gray-600">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    {row.map((cell, j) => (
                      <td key={j} className="px-3 py-1.5 truncate max-w-[120px] text-gray-700">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={runImport}
            disabled={importing || (!mapping.first_name && !mapping.last_name)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40 transition-colors"
          >
            {importing ? "Importing..." : `Import ${preview.total_rows} clients`}
          </button>
        </>
      )}

      {summary && (
        <div className="mt-5 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="text-[14px] font-medium text-emerald-800">
            ✓ Imported {summary.imported} clients
          </div>
          {summary.skipped > 0 && (
            <div className="text-[13px] text-gray-600 mt-1">
              Skipped {summary.skipped} (duplicates or empty names)
            </div>
          )}
          {summary.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] text-red-600">{summary.errors.length} errors</summary>
              <ul className="text-[12px] mt-1 space-y-0.5 text-gray-700">
                {summary.errors.map((e, i) => (<li key={i}>{e}</li>))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 text-red-600 text-[13px] flex items-center gap-1.5">
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

function AutomationTab() {
  const [rules, setRules] = useState<SignupRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", sender_pattern: "", subject_pattern: "" });

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

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={16} className="text-indigo-600" />
        <h3 className="text-[15px] font-semibold text-gray-900">Auto-detect Signup Emails</h3>
      </div>
      <p className="text-[13px] text-gray-500 mb-5">
        When an incoming email matches a rule, the AI extracts client info from the body and
        auto-creates a client record. Patterns are{" "}
        <a
          href="https://docs.rs/regex/latest/regex/#syntax"
          target="_blank"
          rel="noreferrer"
          className="text-indigo-600 underline"
        >
          regular expressions
        </a>.
      </p>

      <button
        onClick={() => setShowForm(true)}
        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 mb-5 transition-colors"
      >
        <Plus size={14} /> Add rule
      </button>

      {showForm && (
        <div className="border border-gray-200 rounded-lg p-4 mb-5 space-y-3 bg-gray-50">
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Rule name</label>
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g. Typeform new client signups"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Sender pattern (regex)</label>
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g. noreply@typeform\.com"
              value={form.sender_pattern}
              onChange={(e) => setForm({ ...form, sender_pattern: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Subject pattern (regex)</label>
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g. (?i)new\s+(client|signup|inquiry)"
              value={form.subject_pattern}
              onChange={(e) => setForm({ ...form, subject_pattern: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-[14px] text-gray-500 hover:text-gray-800">Cancel</button>
            <button
              onClick={save}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium"
            >
              Save Rule
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rules.map((r) => (
          <div key={r.id} className="border border-gray-200 rounded-lg px-4 py-3 flex items-center justify-between hover:border-gray-300 transition-colors">
            <div className="flex-1">
              <div className="text-[14px] font-medium text-gray-900">{r.name}</div>
              <div className="text-[12px] text-gray-500 font-mono space-y-0.5 mt-1">
                {r.sender_pattern && <div>From: {r.sender_pattern}</div>}
                {r.subject_pattern && <div>Subject: {r.subject_pattern}</div>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[13px] cursor-pointer text-gray-600">
                <input
                  type="checkbox"
                  checked={r.active}
                  onChange={(e) => api.toggleSignupRule(r.id, e.target.checked).then(load)}
                />
                Active
              </label>
              <button
                onClick={() => confirm("Delete rule?") && api.deleteSignupRule(r.id).then(load)}
                className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {rules.length === 0 && (
          <div className="text-center text-[14px] text-gray-400 py-8">
            No rules yet. Add one to start auto-importing clients from signup emails.
          </div>
        )}
      </div>

      <div className="mt-6 p-4 bg-indigo-50 border border-indigo-200 rounded-lg text-[12px]">
        <div className="font-semibold text-indigo-900 mb-1.5">Example rules</div>
        <div className="space-y-1 text-indigo-800">
          <div>• Typeform: <code className="bg-indigo-100 px-1 rounded">noreply@typeform\.com</code> + any subject</div>
          <div>• Google Forms: <code className="bg-indigo-100 px-1 rounded">forms-receipts-noreply@google\.com</code></div>
          <div>• Your contact form: <code className="bg-indigo-100 px-1 rounded">contact@yourbusiness\.com</code> + subject <code className="bg-indigo-100 px-1 rounded">(?i)new inquiry</code></div>
        </div>
      </div>
    </div>
  );
}

function UpdateButton() {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-5 h-9 rounded-md text-[14px] disabled:opacity-50 transition-colors"
      >
        {checking ? "Checking..." : "Check for Updates"}
      </button>
      {status && <p className="text-[13px] text-gray-600 mt-2">{status}</p>}
    </div>
  );
}

function PaymentsTab() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [form, setForm] = useState<PaymentMethodInput>({ kind: "ACH", label: "", details: "" });

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
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-semibold text-gray-900">Payment Methods</h3>
        <button
          onClick={() => { setEditing(null); setForm({ kind: "ACH", label: "", details: "" }); setShowForm(true); }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex items-center gap-1.5 transition-colors"
        >
          <Plus size={14} /> Add
        </button>
      </div>
      <p className="text-[13px] text-gray-500 mb-5">Active methods appear on every invoice.</p>

      {showForm && (
        <div className="border border-gray-200 rounded-lg p-4 mb-5 bg-gray-50 space-y-3">
          <Field label="Type">
            <select
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (<option key={k} value={k}>{k}</option>))}
            </select>
          </Field>
          <Field label="Label">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Bank transfer"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Field>
          <Field label="Details">
            <textarea
              rows={3}
              className="border border-gray-300 px-3 py-2 rounded-md text-[14px] w-full font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder={"Account #: 123456789\nRouting: 021000021\nBank: Chase"}
              value={form.details ?? ""}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setEditing(null); }}
              className="text-[14px] text-gray-500 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!form.label.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"
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
            className={`border border-gray-200 rounded-lg px-4 py-3 flex items-start justify-between ${m.active ? "" : "opacity-50"}`}
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium font-mono bg-gray-100 px-2 py-0.5 rounded text-gray-600">
                  {m.kind}
                </span>
                <span className="text-[14px] font-medium text-gray-900">{m.label}</span>
              </div>
              {m.details && (
                <pre className="text-[12px] text-gray-500 mt-1 whitespace-pre-wrap font-mono">{m.details}</pre>
              )}
            </div>
            <div className="flex items-center gap-1 ml-3">
              <button onClick={() => moveUp(i)} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
                <ChevronUp size={14} />
              </button>
              <button onClick={() => moveDown(i)} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
                <ChevronDown size={14} />
              </button>
              <button
                onClick={() => { setEditing(m); setForm({ kind: m.kind, label: m.label, details: m.details }); setShowForm(true); }}
                className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
              >
                <Edit2 size={14} />
              </button>
              <button onClick={() => remove(m.id)} className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {methods.length === 0 && (
          <div className="text-center text-[14px] text-gray-400 py-8">
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
  const [qty, setQty] = useState("1");

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
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl">
      <h3 className="text-[15px] font-semibold text-gray-900 mb-1">Line Item Templates</h3>
      <p className="text-[13px] text-gray-500 mb-5">Saved line items for quick invoice creation.</p>

      {/* Add row */}
      <div className="grid grid-cols-12 gap-2 mb-5">
        <div className="col-span-7">
          <label className="block text-[12px] font-medium text-gray-500 mb-1">Description</label>
          <input
            className="border border-gray-300 px-3 h-9 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="e.g. Standard order processing"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-[12px] font-medium text-gray-500 mb-1">Rate</label>
          <input
            type="text"
            inputMode="decimal"
            className="border border-gray-300 px-3 h-9 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="0.00"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div className="col-span-1">
          <label className="block text-[12px] font-medium text-gray-500 mb-1">Qty</label>
          <input
            type="text"
            inputMode="decimal"
            className="border border-gray-300 px-3 h-9 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div className="col-span-2 flex items-end">
          <button
            onClick={add}
            disabled={!desc.trim()}
            className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 rounded-md text-[14px] font-medium w-full disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center justify-between border border-gray-100 rounded-lg px-4 py-2.5 hover:border-gray-200 transition-colors">
            <span className="text-[14px] text-gray-800">{t.description}</span>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-gray-500 tabular-nums">{fmtAmount(t.rate)} × {t.qty}</span>
              <button onClick={() => remove(t.id)} className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="text-center text-[14px] text-gray-400 py-8">No templates yet.</div>
        )}
      </div>
    </div>
  );
}

function CategoriesTab() {
  const [cats, setCats] = useState<Category[]>([]);
  const [newLabel, setNewLabel] = useState("");
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
    <div>
      <p className="text-[13px] text-gray-500 mb-4">
        Manage client category labels. Categories help organize and filter clients.
      </p>

      <div className="flex gap-2 mb-4">
        <input
          placeholder="New category name..."
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          className="flex-1 border border-gray-300 px-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <button
          onClick={create}
          disabled={!newLabel.trim()}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-10 rounded-md text-[14px] font-medium disabled:opacity-40 transition-colors"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
        {cats.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2 px-4 py-2.5">
            {editingId === c.id ? (
              <>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && update(c.id)}
                  className="flex-1 border border-gray-300 px-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  autoFocus
                />
                <button
                  onClick={() => update(c.id)}
                  className="text-emerald-600 hover:text-emerald-700 p-1.5 rounded hover:bg-emerald-50"
                >
                  <Check size={14} />
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="text-gray-400 hover:text-gray-600 p-1.5 rounded hover:bg-gray-100"
                >
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => move(c.id, -1)}
                    disabled={i === 0}
                    className="text-gray-300 hover:text-gray-500 disabled:opacity-20"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={() => move(c.id, 1)}
                    disabled={i === cats.length - 1}
                    className="text-gray-300 hover:text-gray-500 disabled:opacity-20"
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
                <span className="flex-1 text-[14px] text-gray-800">{c.label}</span>
                <button
                  onClick={() => { setEditingId(c.id); setEditLabel(c.label); }}
                  className="text-gray-400 hover:text-gray-700 p-1.5 rounded hover:bg-gray-100"
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => remove(c.id, c.label)}
                  className="text-gray-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        ))}
        {cats.length === 0 && (
          <div className="text-center text-[14px] text-gray-400 py-6">No categories defined yet.</div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-[12px] font-medium text-gray-600 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
