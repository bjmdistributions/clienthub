import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, EmailSettings, CompanyInfo, CsvPreview, ColumnMapping, ImportSummary } from "../lib/api";
import { Upload, Check, AlertCircle, ArrowLeft, ArrowRight } from "lucide-react";

const PRESETS: Record<string, Partial<EmailSettings>> = {
  Gmail:   { smtp_host: "smtp.gmail.com",  smtp_port: 587, imap_host: "imap.gmail.com",  imap_port: 993 },
  Outlook: { smtp_host: "smtp.office365.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 },
};
const FIELDS = [
  { key: "name",    label: "Name *", required: true },
  { key: "email",   label: "Email" },
  { key: "phone",   label: "Phone" },
  { key: "company", label: "Company" },
  { key: "notes",   label: "Notes" },
  { key: "street_address", label: "Street address" },
  { key: "city",    label: "City" },
  { key: "state",   label: "State" },
  { key: "zip_code", label: "Zip code" },
  { key: "category", label: "Category" },
  { key: "lead_status", label: "Lead status" },
];

export default function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);

  const [biz, setBiz] = useState({ company: "", user: "", email: "", phone: "", address: "", logoPath: "" as string | null });
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  const [emailSettings, setEmailSettings] = useState<EmailSettings>({
    smtp_host: "smtp.gmail.com", smtp_port: 587,
    imap_host: "imap.gmail.com", imap_port: 993,
    user: "", auth_method: "password",
  });
  const [smtpPass, setSmtpPass] = useState("");
  const [emailTested, setEmailTested] = useState<"ok" | "fail" | null>(null);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailSkipped, setEmailSkipped] = useState(false);

  const [csvPath, setCsvPath] = useState("");
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [csvSkipped, setCsvSkipped] = useState(false);

  const pickLogo = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }] });
    if (typeof f === "string") { setBiz({ ...biz, logoPath: f }); setLogoPreview(f); }
  };

  const pickCsv = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof f !== "string") return;
    setCsvPath(f);
    try {
      const p = await api.csvPreview(f);
      setCsvPreview(p);
      const guess: Record<string, string> = {};
      for (const fld of FIELDS) {
        const hit = p.headers.find((h) => h.toLowerCase().includes(fld.key));
        if (hit) guess[fld.key] = hit;
      }
      setCsvMapping(guess);
    } catch {}
  };

  const runImport = async () => {
    if (!csvPath) return;
    setImporting(true);
    try {
      const r = await api.csvImport(csvPath, { fields: csvMapping, metadata_keys: [] });
      setImportSummary(r);
    } catch {}
    setImporting(false);
  };

  const saveBiz = async () => {
    const info: CompanyInfo = { name: biz.company, address: biz.address, email: biz.email, phone: biz.phone || null, logo_path: biz.logoPath };
    await api.saveCompanyInfo(info);
  };

  const saveEmail = async () => {
    await api.saveEmailSettings(emailSettings);
    if (smtpPass) {
      await api.saveCredential("smtp_user", emailSettings.user);
      await api.saveCredential("smtp_pass", smtpPass);
    }
  };

  const testEmail = async () => {
    setEmailTesting(true);
    setEmailTested(null);
    try {
      await saveEmail();
      await api.saveEmailSettings(emailSettings);
      setEmailTested("ok");
    } catch { setEmailTested("fail"); }
    setEmailTesting(false);
  };

  const finish = async () => {
    if (!emailSkipped) { try { await saveEmail(); } catch {} }
    const ownerName = biz.user.trim() || biz.company.trim() || "Owner";
    try { await api.createOwnerUser(ownerName, biz.email || ""); } catch {}
    await api.completeOnboarding();
    onDone();
  };

  const steps = ["Welcome", "Business", "Email", "Import", "Done"];

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 pt-6 pb-4 border-b border-line">
          <div className="flex items-center justify-center gap-2 mb-4">
            {steps.map((s, i) => (
              <div key={s} className={`w-2 h-2 rounded-full transition-colors ${i === step ? "bg-accent" : i < step ? "bg-accent" : "bg-surface-3"}`} title={s} />
            ))}
          </div>
          <h2 className="text-[16px] font-semibold text-ink text-center">{steps[step]}</h2>
        </div>

        <div className="px-6 py-5">
          {step === 0 && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))", boxShadow: "0 0 28px var(--accent-glow)" }}>
                <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-9 w-9" />
              </div>
              <h3 className="text-[20px] font-bold text-ink mb-2">Welcome to Ecliptr</h3>
              <p className="text-[13px] text-muted max-w-[320px] mx-auto leading-relaxed mb-2">
                Your clients, invoices, deal flow, and newsletters — all in one place.
              </p>
              <p className="text-[12px] text-muted mb-8">Let's get you set up in about 2 minutes.</p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <Field label="Business name *">
                <input className={inp} value={biz.company} onChange={(e) => setBiz({ ...biz, company: e.target.value })} placeholder="BJM Distributions" />
              </Field>
              <Field label="Your name *">
                <input className={inp} value={biz.user} onChange={(e) => setBiz({ ...biz, user: e.target.value })} placeholder="Jack" />
              </Field>
              <Field label="Business email">
                <input className={inp} type="email" value={biz.email} onChange={(e) => setBiz({ ...biz, email: e.target.value })} placeholder="you@company.com" />
              </Field>
              <Field label="Phone">
                <input className={inp} value={biz.phone} onChange={(e) => setBiz({ ...biz, phone: e.target.value })} placeholder="555-123-4567" />
              </Field>
              <Field label="Address">
                <input className={inp} value={biz.address} onChange={(e) => setBiz({ ...biz, address: e.target.value })} placeholder="123 Main St, City, ST 12345" />
              </Field>
              <Field label="Logo (optional)">
                <div className="flex items-center gap-3">
                  <button onClick={pickLogo} className="bg-surface-2 border border-line px-3 h-9 rounded-lg text-[12px] text-ink-2 hover:bg-surface-3 flex items-center gap-1.5">
                    <Upload size={12} /> {logoPreview ? "Change" : "Upload"}
                  </button>
                  {logoPreview && <span className="text-[11px] text-muted truncate max-w-[200px]">{logoPreview.split(/[\\/]/).pop()}</span>}
                </div>
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="flex gap-2 mb-2">
                {Object.keys(PRESETS).map((p) => (
                  <button key={p} onClick={() => { setEmailSettings({ ...emailSettings, ...PRESETS[p] }); setEmailSkipped(false); }}
                    className={`px-3 h-8 rounded-lg text-[12px] font-medium border transition-colors ${!emailSkipped && emailSettings.smtp_host === PRESETS[p]?.smtp_host ? "bg-accent text-on-accent border-accent" : "bg-surface text-ink-2 border-line hover:bg-surface-2"}`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setEmailSkipped(true)}
                  className={`px-3 h-8 rounded-lg text-[12px] font-medium border transition-colors ${emailSkipped ? "bg-surface-3 text-ink border-line-3" : "bg-surface text-ink-2 border-line hover:bg-surface-2"}`}>
                  Skip email
                </button>
              </div>
              {!emailSkipped ? (
                <>
                  <Field label="SMTP Host"><input className={inp} value={emailSettings.smtp_host} onChange={(e) => setEmailSettings({ ...emailSettings, smtp_host: e.target.value })} /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="SMTP Port"><input className={inp} type="number" value={emailSettings.smtp_port} onChange={(e) => setEmailSettings({ ...emailSettings, smtp_port: parseInt(e.target.value) || 587 })} /></Field>
                    <Field label="IMAP Port"><input className={inp} type="number" value={emailSettings.imap_port} onChange={(e) => setEmailSettings({ ...emailSettings, imap_port: parseInt(e.target.value) || 993 })} /></Field>
                  </div>
                  <Field label="Username / Email"><input className={inp} value={emailSettings.user} onChange={(e) => setEmailSettings({ ...emailSettings, user: e.target.value })} placeholder="you@gmail.com" /></Field>
                  <Field label="Password"><input className={inp} type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="App Password for Gmail" /></Field>
                  {emailSettings.smtp_host.includes("gmail") && (
                    <p className="text-[11px] text-warning-ink bg-warning-bg px-3 py-2 rounded-lg">Using Gmail? You need an App Password, not your regular password.</p>
                  )}
                  <div className="flex items-center gap-3 pt-1">
                    <button onClick={testEmail} disabled={emailTesting} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[12px] font-medium disabled:opacity-50 flex items-center gap-1.5">
                      {emailTesting ? "Testing…" : "Test connection"}
                    </button>
                    {emailTested === "ok" && <span className="text-success-ink text-[12px] font-medium flex items-center gap-1"><Check size={13} /> Connected</span>}
                    {emailTested === "fail" && (
                      <span className="text-warning-ink text-[11px] flex items-center gap-1">
                        <AlertCircle size={12} /> Connection failed — you can fix this in Settings later
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-[12px] text-muted py-4">You can set up email later in Settings.</p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {!csvPath ? (
                <div className="text-center py-4">
                  <p className="text-[13px] text-muted mb-4">Have an existing client list? Import it now.</p>
                  <button onClick={pickCsv} className="bg-surface border border-line hover:bg-surface-2 text-ink-2 px-4 h-9 rounded-lg text-[13px] flex items-center gap-2 mx-auto mb-3">
                    <Upload size={13} /> Upload CSV
                  </button>
                  <button onClick={() => { setCsvSkipped(true); setStep(4); }} className="text-[12px] text-muted hover:text-ink-2">Skip for now</button>
                </div>
              ) : (
                <>
                  <div className="bg-surface-2 border border-line px-4 py-3 rounded-xl">
                    <p className="text-[13px] font-medium text-ink">{csvPreview?.total_rows ?? 0} rows</p>
                    <p className="text-[11px] text-muted font-mono truncate">{csvPath}</p>
                  </div>
                  {csvPreview && !importSummary && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold text-muted uppercase tracking-widest">Map columns</p>
                      {FIELDS.map((f) => (
                        <div key={f.key} className="grid grid-cols-3 gap-2 items-center">
                          <label className="text-[12px] text-ink-2">{f.label}</label>
                          <select className="col-span-2 border border-line px-2 h-8 rounded-lg text-[12px]" value={csvMapping[f.key] ?? ""} onChange={(e) => setCsvMapping({ ...csvMapping, [f.key]: e.target.value })}>
                            <option value="">— skip —</option>
                            {csvPreview.headers.map((h) => (<option key={h} value={h}>{h}</option>))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                  {importSummary ? (
                    <div className="bg-success-bg border border-success px-4 py-3 rounded-xl text-[12px]">
                      <p className="font-medium text-success-ink">{importSummary.imported} imported, {importSummary.skipped} skipped</p>
                      {importSummary.errors.length > 0 && <p className="text-danger-ink mt-1">{importSummary.errors.length} errors</p>}
                    </div>
                  ) : (
                    <button onClick={runImport} disabled={importing || !csvMapping.name} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[12px] font-medium disabled:opacity-50">
                      {importing ? "Importing…" : `Import ${csvPreview?.total_rows ?? 0} clients`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full bg-success-bg flex items-center justify-center mx-auto mb-4">
                <Check size={20} className="text-success-ink" />
              </div>
              <h3 className="text-[16px] font-bold text-ink mb-2">You're all set!</h3>
              <p className="text-[13px] text-muted mb-4">Ecliptr is ready.</p>
              <div className="text-[12px] text-muted space-y-1">
                {biz.company && <p>Business info saved</p>}
                {!emailSkipped && emailSettings.user && <p>Email configured</p>}
                {importSummary && importSummary.imported > 0 && <p>{importSummary.imported} clients imported</p>}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center justify-between">
          <button onClick={() => setStep(step - 1)} className={`text-[13px] text-muted flex items-center gap-1 ${step === 0 ? "invisible" : ""}`}>
            <ArrowLeft size={13} /> Back
          </button>
          <div className="flex gap-2">
            {step < 4 && (
              <button onClick={async () => {
                if (step === 1) { if (!biz.company.trim()) return; await saveBiz(); }
                if (step === 2 && !emailSkipped) { if (!emailSettings.user.trim()) return; await saveEmail(); }
                setStep(step + 1);
              }} disabled={step === 1 && !biz.company.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 flex items-center gap-1">
                Next <ArrowRight size={13} />
              </button>
            )}
            {step === 4 && (
              <button onClick={finish} className="bg-accent hover:bg-accent-hover text-on-accent px-6 h-9 rounded-lg text-[13px] font-medium">
                Open Ecliptr
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}

const inp = "border border-line px-3 h-10 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
