import { useEffect, useState } from "react";
import {
  api,
  EmailSettings,
  CompanyInfo,
  OllamaModel,
  CsvPreview,
  ImportSummary,
  SignupRule,
} from "../lib/api";
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
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export default function SettingsView() {
  const [tab, setTab] = useState<
    "email" | "company" | "ai" | "sync" | "import" | "automation"
  >("email");

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Settings</h2>
      <div className="flex gap-2 border-b border-slate-200 mb-6">
        {(["email", "company", "ai", "sync", "import", "automation"] as const).map(
          (t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px ${
                tab === t
                  ? "border-slate-900 font-semibold"
                  : "border-transparent text-slate-500 hover:text-slate-900"
              }`}
            >
              {t}
            </button>
          )
        )}
      </div>

      {tab === "email" && <EmailTab />}
      {tab === "company" && <CompanyTab />}
      {tab === "ai" && <AiTab />}
      {tab === "sync" && <SyncTab />}
      {tab === "import" && <ImportTab />}
      {tab === "automation" && <AutomationTab />}
    </div>
  );
}

// ========== Email Tab ==========
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
        if (smtpPass) {
          await api.saveCredential("smtp_pass", smtpPass);
          console.log("smtp_pass saved to keychain, length:", smtpPass.length);
        } else {
          console.warn("smtp_pass was empty — not saved");
        }
        if (imapPass) await api.saveCredential("imap_pass", imapPass);
        await api.saveCredential("imap_host", settings.imap_host);
      } else {
        if (oauthClientId) await api.saveCredential("oauth_client_id", oauthClientId);
        if (oauthClientSecret)
          await api.saveCredential("oauth_client_secret", oauthClientSecret);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      console.error("Settings save error:", e);
      setError(e.toString());
    }
  };

  const SecretInput = ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (s: string) => void;
  }) => (
    <Field label={label}>
      <div className="relative">
        <input
          type={showSecrets ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="border p-2 rounded w-full pr-9"
          placeholder="•••••••• (leave blank to keep current)"
        />
        <button
          type="button"
          onClick={() => setShowSecrets((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"
        >
          {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </Field>
  );

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
      <p className="text-sm text-slate-600 mb-4">
        Credentials are stored in your operating system's keychain — never written to
        plain disk or synced.
      </p>

      <Field label="Auth method">
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={settings.auth_method === "password"}
              onChange={() => setSettings({ ...settings, auth_method: "password" })}
            />
            Password / App Password
          </label>
          <label className="flex items-center gap-2 text-sm">
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
          className="border p-2 rounded w-full"
          value={settings.user}
          onChange={(e) => setSettings({ ...settings, user: e.target.value })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="SMTP host">
          <input
            className="border p-2 rounded w-full"
            value={settings.smtp_host}
            onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })}
          />
        </Field>
        <Field label="SMTP port">
          <input
            type="number"
            className="border p-2 rounded w-full"
            value={settings.smtp_port}
            onChange={(e) =>
              setSettings({ ...settings, smtp_port: parseInt(e.target.value) || 587 })
            }
          />
        </Field>
        <Field label="IMAP host">
          <input
            className="border p-2 rounded w-full"
            value={settings.imap_host}
            onChange={(e) => setSettings({ ...settings, imap_host: e.target.value })}
          />
        </Field>
        <Field label="IMAP port">
          <input
            type="number"
            className="border p-2 rounded w-full"
            value={settings.imap_port}
            onChange={(e) =>
              setSettings({ ...settings, imap_port: parseInt(e.target.value) || 993 })
            }
          />
        </Field>
      </div>

      {settings.auth_method === "password" ? (
        <>
          <SecretInput label="SMTP password" value={smtpPass} onChange={setSmtpPass} />
          <SecretInput label="IMAP password" value={imapPass} onChange={setImapPass} />
        </>
      ) : (
        <>
          <SecretInput
            label="OAuth Client ID"
            value={oauthClientId}
            onChange={setOauthClientId}
          />
          <SecretInput
            label="OAuth Client Secret"
            value={oauthClientSecret}
            onChange={setOauthClientSecret}
          />
          <div className="mb-3">
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Google Authorization
            </label>
            <button
              type="button"
              onClick={authorize}
              disabled={oauthConnecting || !oauthClientId || !oauthClientSecret}
              className={`px-4 py-2 rounded text-sm font-medium disabled:opacity-50 flex items-center gap-2 ${
                oauthConnected
                  ? "bg-green-600 text-white"
                  : "bg-blue-600 text-white"
              }`}
            >
              {oauthConnecting ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Authorizing...
                </>
              ) : oauthConnected ? (
                <>
                  <Check size={14} />
                  Connected
                </>
              ) : (
                "Authorize with Google"
              )}
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            Enter your Client ID and Client Secret from the Google Cloud Console,
            click Authorize, and approve access in your browser.
          </p>
        </>
      )}

      {error && (
        <div className="text-red-600 text-sm flex items-center gap-1 mt-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      <button
        onClick={save}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-2 mt-2"
      >
        {saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? "Saved" : "Save Settings"}
      </button>
    </div>
  );
}

// ========== Company Tab ==========
function CompanyTab() {
  const [info, setInfo] = useState<CompanyInfo>({
    name: "",
    address: "",
    email: "",
    phone: "",
    tax_id: "",
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

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
      <p className="text-sm text-slate-600 mb-4">
        This information appears on every PDF invoice.
      </p>
      <Field label="Company name">
        <input
          className="border p-2 rounded w-full"
          value={info.name}
          onChange={(e) => setInfo({ ...info, name: e.target.value })}
        />
      </Field>
      <Field label="Address">
        <input
          className="border p-2 rounded w-full"
          value={info.address}
          onChange={(e) => setInfo({ ...info, address: e.target.value })}
        />
      </Field>
      <Field label="Email">
        <input
          className="border p-2 rounded w-full"
          value={info.email}
          onChange={(e) => setInfo({ ...info, email: e.target.value })}
        />
      </Field>
      <Field label="Phone">
        <input
          className="border p-2 rounded w-full"
          value={info.phone ?? ""}
          onChange={(e) => setInfo({ ...info, phone: e.target.value })}
        />
      </Field>
      <Field label="Tax ID / EIN">
        <input
          className="border p-2 rounded w-full"
          value={info.tax_id ?? ""}
          onChange={(e) => setInfo({ ...info, tax_id: e.target.value })}
        />
      </Field>
      <button
        onClick={save}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-2"
      >
        {saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}

// ========== AI Tab ==========
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
    <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
      <div className="mb-4">
        <span className="font-semibold">Ollama status: </span>
        {online === null ? (
          "checking..."
        ) : online ? (
          <span className="text-green-600">online</span>
        ) : (
          <span className="text-red-600">
            offline — start with{" "}
            <code className="bg-slate-100 px-1 rounded">ollama serve</code>
          </span>
        )}
      </div>

      <Field label="Active model">
        <select
          className="border p-2 rounded w-full"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">— pick a model —</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
              {m.size ? ` (${(m.size / 1e9).toFixed(1)} GB)` : ""}
            </option>
          ))}
        </select>
      </Field>

      <p className="text-xs text-slate-500 mb-3">
        Recommended: <code>llama3.1:8b</code> for general use, <code>qwen2.5:14b</code>{" "}
        for better extraction quality. Pull with{" "}
        <code className="bg-slate-100 px-1 rounded">ollama pull &lt;model&gt;</code>.
      </p>

      <button
        onClick={save}
        disabled={!selected}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
      >
        Set Active Model
      </button>
    </div>
  );
}

// ========== Sync Tab ==========
function SyncTab() {
  const [status, setStatus] = useState<{
    events_applied: number;
    last_applied: string | null;
  } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [settingPassphrase, setSettingPassphrase] = useState(false);
  const [encryptError, setEncryptError] = useState<string | null>(null);

  const refresh = () => api.syncStatus().then(setStatus);
  const checkEncrypted = () =>
    api.syncIsEncrypted().then(setEncrypted).catch(() => {});

  useEffect(() => {
    refresh();
    checkEncrypted();
  }, []);

  const replay = async () => {
    setReplaying(true);
    try {
      await api.syncReplay();
      await refresh();
    } finally {
      setReplaying(false);
    }
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
    <div className="bg-white rounded-lg shadow p-6 max-w-2xl space-y-4">
      <div>
        <h3 className="font-semibold mb-2">Sync Status</h3>
        <div className="text-sm text-slate-600 space-y-1">
          <div>
            Events applied:{" "}
            <span className="font-mono">{status?.events_applied ?? 0}</span>
          </div>
          <div>
            Last applied:{" "}
            <span className="font-mono">
              {status?.last_applied
                ? new Date(status.last_applied).toLocaleString()
                : "—"}
            </span>
          </div>
        </div>
      </div>

      <button
        onClick={replay}
        disabled={replaying}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm"
      >
        {replaying ? "Replaying..." : "Replay All Events"}
      </button>

      <div className="border-t pt-4">
        <h3 className="font-semibold mb-2">Encryption</h3>
        {encrypted === null ? (
          <p className="text-sm text-slate-400">checking...</p>
        ) : encrypted ? (
          <p className="text-sm text-green-600 font-medium">
            Enabled — sync events are encrypted at rest
          </p>
        ) : (
          <div>
            <p className="text-sm text-slate-600 mb-2">
              Protect your sync data with a passphrase. All sync event files
              will be encrypted with ChaCha20-Poly1305. Enter the same
              passphrase on every device.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                placeholder="Enter passphrase..."
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="border p-2 rounded text-sm flex-1"
              />
              <button
                onClick={handleSetPassphrase}
                disabled={settingPassphrase || !passphrase.trim()}
                className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
              >
                {settingPassphrase ? "Setting..." : "Enable"}
              </button>
            </div>
            {encryptError && (
              <div className="text-red-600 text-sm mt-2 flex items-center gap-1">
                <AlertCircle size={14} /> {encryptError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t pt-4">
        <h3 className="font-semibold mb-2">How sync works</h3>
        <p className="text-sm text-slate-600 mb-2">
          ClientHub uses an append-only event log with Hybrid Logical Clocks. Every
          write produces a JSON event in:
        </p>
        <code className="block bg-slate-50 p-2 rounded text-xs">
          ~/Library/Application Support/com.bjmdistributions.clienthub/sync/ (macOS)
          <br />
          %APPDATA%\com.bjmdistributions.clienthub\sync\ (Windows)
        </code>
        <p className="text-sm text-slate-600 mt-2">
          Point Syncthing or another file-sync tool at this folder. Conflict-free
          merging is handled automatically per-column with last-write-wins semantics.
        </p>
      </div>
    </div>
  );
}

// ========== Import Tab (Google Sheets / CSV) ==========
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
    { key: "last_name", label: "Last Name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "company", label: "Company Name" },
    { key: "notes", label: "Notes" },
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
        const hit = p.headers.find((h) =>
          h.toLowerCase().includes(f.key.replace("_", " ").toLowerCase())
        );
        if (hit) guess[f.key] = hit;
      }
      setMapping(guess);
      const remaining = p.headers.filter(
        (h) => !Object.values(guess).includes(h)
      );
      setMetaKeys(remaining);
    } catch (e: any) {
      setError(e.toString());
    }
  };

  const runImport = async () => {
    if (!path) return;
    setImporting(true);
    setError(null);
    try {
      const result = await api.csvImport(path, {
        fields: mapping,
        metadata_keys: metaKeys,
      });
      setSummary(result);
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setImporting(false);
    }
  };

  const toggleMetaKey = (key: string) => {
    setMetaKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-3xl">
      <h3 className="font-semibold mb-2">Import from Google Sheets / CSV</h3>
      <p className="text-sm text-slate-600 mb-4">
        Export your sheet as CSV (File → Download → CSV in Google Sheets), then
        upload it here. Existing clients are deduplicated by email.
      </p>

      <button
        onClick={pickFile}
        className="bg-slate-900 text-white px-4 py-2 rounded text-sm flex items-center gap-2 mb-4"
      >
        <Upload size={14} /> {path ? "Change file" : "Choose CSV file"}
      </button>

      {path && (
        <div className="text-xs text-slate-500 mb-4 font-mono">{path}</div>
      )}

      {preview && (
        <>
          <div className="bg-slate-50 p-3 rounded mb-4">
            <div className="text-sm font-semibold mb-2">
              {preview.total_rows} rows detected
            </div>
            <div className="text-xs text-slate-600 mb-2">
              Headers: {preview.headers.join(", ")}
            </div>
          </div>

          <h4 className="font-semibold text-sm mb-2">Map columns</h4>
          <div className="space-y-2 mb-4">
            {CORE_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-3 gap-2 items-center">
                <label className="text-sm">{f.label}</label>
                <select
                  className="col-span-2 border p-2 rounded text-sm"
                  value={mapping[f.key] ?? ""}
                  onChange={(e) =>
                    setMapping({ ...mapping, [f.key]: e.target.value })
                  }
                >
                  <option value="">— skip —</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <h4 className="font-semibold text-sm mb-2">
            Extra fields → metadata ({metaKeys.length} selected)
          </h4>
          <div className="flex flex-wrap gap-2 mb-4">
            {preview.headers
              .filter((h) => !Object.values(mapping).includes(h))
              .map((h) => (
                <label
                  key={h}
                  className={`text-xs px-2 py-1 rounded cursor-pointer border ${
                    metaKeys.includes(h)
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={metaKeys.includes(h)}
                    onChange={() => toggleMetaKey(h)}
                  />
                  {h}
                </label>
              ))}
          </div>

          <div className="text-xs font-semibold mb-2">Preview (first 5 rows):</div>
          <div className="overflow-auto max-h-40 mb-4 border rounded">
            <table className="text-xs w-full">
              <thead className="bg-slate-100">
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h} className="text-left p-1 px-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    {row.map((cell, j) => (
                      <td key={j} className="p-1 px-2 truncate max-w-[120px]">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={runImport}
            disabled={importing || (!mapping.first_name && !mapping.last_name)}
            className="bg-green-600 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {importing ? "Importing..." : `Import ${preview.total_rows} clients`}
          </button>
        </>
      )}

      {summary && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded text-sm">
          <div className="font-semibold text-green-900">
            ✓ Imported {summary.imported} clients
          </div>
          {summary.skipped > 0 && (
            <div className="text-slate-600">
              Skipped {summary.skipped} (duplicates or empty names)
            </div>
          )}
          {summary.errors.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-red-600">
                {summary.errors.length} errors
              </summary>
              <ul className="text-xs mt-1 space-y-0.5">
                {summary.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 text-red-600 text-sm flex items-center gap-1">
          <AlertCircle size={14} /> {error}
        </div>
      )}
    </div>
  );
}

// ========== Automation Tab (Signup Detection) ==========
function AutomationTab() {
  const [rules, setRules] = useState<SignupRule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    sender_pattern: "",
    subject_pattern: "",
  });

  const load = () => api.listSignupRules().then(setRules).catch(console.error);
  useEffect(() => {
    load();
  }, []);

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
    } catch (e: any) {
      alert(e);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={16} className="text-violet-600" />
        <h3 className="font-semibold">Auto-detect Signup Emails</h3>
      </div>
      <p className="text-sm text-slate-600 mb-4">
        When an incoming email matches a rule, the AI extracts client info from
        the body and auto-creates a client record. Patterns are{" "}
        <a
          href="https://docs.rs/regex/latest/regex/#syntax"
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 underline"
        >
          regular expressions
        </a>
        .
      </p>

      <button
        onClick={() => setShowForm(true)}
        className="bg-slate-900 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1 mb-4"
      >
        <Plus size={14} /> Add rule
      </button>

      {showForm && (
        <div className="border rounded p-4 mb-4 space-y-3 bg-slate-50">
          <div>
            <label className="block text-xs font-semibold mb-1">Rule name</label>
            <input
              className="border p-2 rounded w-full text-sm"
              placeholder="e.g. Typeform new client signups"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              Sender pattern (regex)
            </label>
            <input
              className="border p-2 rounded w-full text-sm font-mono"
              placeholder="e.g. noreply@typeform\.com"
              value={form.sender_pattern}
              onChange={(e) =>
                setForm({ ...form, sender_pattern: e.target.value })
              }
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">
              Subject pattern (regex)
            </label>
            <input
              className="border p-2 rounded w-full text-sm font-mono"
              placeholder="e.g. (?i)new\s+(client|signup|inquiry)"
              value={form.subject_pattern}
              onChange={(e) =>
                setForm({ ...form, subject_pattern: e.target.value })
              }
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="text-sm">
              Cancel
            </button>
            <button
              onClick={save}
              className="bg-slate-900 text-white px-3 py-1.5 rounded text-sm"
            >
              Save Rule
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rules.map((r) => (
          <div
            key={r.id}
            className="border rounded p-3 flex items-center justify-between"
          >
            <div className="flex-1">
              <div className="font-semibold text-sm">{r.name}</div>
              <div className="text-xs text-slate-500 font-mono space-y-0.5 mt-1">
                {r.sender_pattern && <div>From: {r.sender_pattern}</div>}
                {r.subject_pattern && <div>Subject: {r.subject_pattern}</div>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={r.active}
                  onChange={(e) =>
                    api.toggleSignupRule(r.id, e.target.checked).then(load)
                  }
                />
                Active
              </label>
              <button
                onClick={() =>
                  confirm("Delete rule?") &&
                  api.deleteSignupRule(r.id).then(load)
                }
                className="text-red-500 hover:text-red-700"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {rules.length === 0 && (
          <div className="text-center text-slate-400 text-sm py-6">
            No rules yet. Add one to start auto-importing clients from signup
            emails.
          </div>
        )}
      </div>

      <div className="mt-6 p-3 bg-violet-50 border border-violet-200 rounded text-xs">
        <div className="font-semibold text-violet-900 mb-1">Example rules</div>
        <div className="space-y-1 text-violet-800">
          <div>
            • Typeform: <code>noreply@typeform\.com</code> + any subject
          </div>
          <div>
            • Google Forms:{" "}
            <code>forms-receipts-noreply@google\.com</code>
          </div>
          <div>
            • Your contact form:{" "}
            <code>contact@yourbusiness\.com</code> + subject{" "}
            <code>(?i)new inquiry</code>
          </div>
        </div>
      </div>
    </div>
  );
}

// ========== Helpers ==========
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-semibold text-slate-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
