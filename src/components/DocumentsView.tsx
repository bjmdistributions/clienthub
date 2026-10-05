// R-441 company documents: legal and tax papers in one place. Admin only (App.tsx gates the
// tab; the server refuses anyone else). Files live on the server, sealed in its database and
// in the daily off-site backup; this computer also keeps a copy of every current version.
// Editing a PDF (fill in, sign) saves a new version and keeps the old one.
import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Archive, Download, FolderOpen, PenLine, RefreshCw, RotateCcw, Search, Settings2, Upload, X, FileText, Image as ImageIcon, Check } from "lucide-react";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { docsApi, type CompanyDoc } from "../lib/documentsApi";
// @ts-expect-error plain JS module shared byte-for-byte with the phone (www/docsign.js)
import { openDocEditor, DOC_CATEGORIES, DOC_CHECKLIST, expiryState } from "../lib/docsign.js";

type Cat = { key: string; label: string };
type Slot = { key: string; category: string; label: string; hint: string };
const CATS = DOC_CATEGORIES as Cat[];
const SLOTS = DOC_CHECKLIST as Slot[];
const catLabel = (k: string) => CATS.find((c) => c.key === k)?.label || "Other";

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const btn = "border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-8 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-50";
const pri = "px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity inline-flex items-center gap-1.5";

const current = (d: CompanyDoc) => d.versions.find((v) => v.version === d.current_version) || d.versions[0];
const isPdf = (d: CompanyDoc) => current(d)?.mime === "application/pdf";
const size = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

async function pdfLibs() {
  const [PDFLib, pdfjsLib, worker] = await Promise.all([
    import("pdf-lib"),
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
  return { PDFLib, pdfjsLib };
}

export default function DocumentsView() {
  const [docs, setDocs] = useState<CompanyDoc[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [upload, setUpload] = useState<{ file: File; slot: string } | null>(null);
  const [details, setDetails] = useState<CompanyDoc | null>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [localCopy, setLocalCopy] = useState<{ folder: string; copied: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pendingSlot = useRef("");

  const load = async () => {
    setError("");
    try {
      setDocs(await docsApi.list());
      docsApi.mirror().then(setLocalCopy).catch(() => {});
    } catch (e) {
      setError(String(e));
      setDocs([]);
    }
  };
  useEffect(() => { load(); }, []);

  const live = useMemo(() => (docs || []).filter((d) => !d.archived), [docs]);
  const filled = useMemo(() => new Map(live.filter((d) => d.checklist_key).map((d) => [d.checklist_key, d])), [live]);
  const renewals = useMemo(() => live.filter((d) => expiryState(d.expires_on).tone), [live]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (docs || [])
      .filter((d) => d.archived === showArchived)
      .filter((d) => !needle || (d.title + " " + current(d)?.filename + " " + d.notes + " " + catLabel(d.category)).toLowerCase().includes(needle));
  }, [docs, q, showArchived]);

  const pick = (slot = "") => { pendingSlot.current = slot; picker.current?.click(); };

  const fillAndSign = async (d: CompanyDoc) => {
    setBusy(d.id);
    try {
      const [bytes, libs] = await Promise.all([docsApi.file(d.id), pdfLibs()]);
      setBusy("");
      const res = await openDocEditor({
        bytes, filename: d.title, ...libs,
        getSignature: () => docsApi.signature(),
        drawSignature: (png: string) => docsApi.saveSignature(png),
      });
      if (!res) return;
      setBusy(d.id);
      await docsApi.newVersion(d.id, res.bytes, res.signed ? "Filled in and signed" : "Filled in");
      toast(`Saved as version ${d.current_version + 1}. The earlier version is kept.`);
      await load();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy("");
    }
  };

  const view = async (d: CompanyDoc) => {
    setBusy(d.id);
    try {
      const bytes = await docsApi.file(d.id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: current(d)?.mime }));
      setPreview({ url, title: d.title });
    } catch (e) { toast(String(e), "error"); } finally { setBusy(""); }
  };

  const download = async (d: CompanyDoc, version = d.current_version) => {
    const v = d.versions.find((x) => x.version === version);
    const dest = await saveDialog({ defaultPath: v?.filename || d.title });
    if (!dest) return;
    try {
      await docsApi.saveAs(d.id, version, dest);
      toast("Saved");
    } catch (e) { toast(String(e), "error"); }
  };

  const setArchived = async (d: CompanyDoc, archived: boolean) => {
    try {
      await docsApi.archive(d.id, archived);
      toast(archived ? "Archived. Find it under Show archived." : "Restored");
      await load();
    } catch (e) { toast(String(e), "error"); }
  };

  if (docs === null) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="h-7 w-48 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-40 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-72 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-[1100px] min-w-0">
      <input ref={picker} type="file" className="hidden" accept="application/pdf,image/*,.docx,.xlsx,.txt"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setUpload({ file: f, slot: pendingSlot.current }); }} />

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">Company documents</h2>
          <p className="text-[12px] text-muted mt-0.5 max-w-[620px]">
            Legal and tax papers, visible to admins only. Files are encrypted on the server and included in the daily off-site backup. Editing a form saves a new version and keeps the old one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className={btn}><RefreshCw size={13} /> Refresh</button>
          <button onClick={() => pick()} className={pri}><Upload size={14} /> Upload</button>
        </div>
      </div>

      {error && <div className="text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">{error}</div>}

      {renewals.length > 0 && (
        <div className="bg-surface border border-line rounded-xl p-4">
          <div className="text-[13px] font-semibold text-ink mb-2">Needs renewal</div>
          <div className="space-y-1.5">
            {renewals.map((d) => {
              const ex = expiryState(d.expires_on);
              return (
                <button key={d.id} onClick={() => setDetails(d)} className="w-full flex items-center gap-3 text-left hover:bg-surface-2 rounded-lg px-2 py-1.5 transition-colors">
                  <span className="text-[13px] text-ink truncate flex-1 min-w-0">{d.title}</span>
                  <StatusPill tone={ex.tone === "danger" ? "danger" : "warning"}>{ex.text}</StatusPill>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl p-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <div className="text-[13px] font-semibold text-ink">Papers a company keeps on file</div>
          <div className="text-[12px] text-muted">{SLOTS.filter((s) => filled.has(s.key)).length} of {SLOTS.length} on file</div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {SLOTS.map((s) => {
            const d = filled.get(s.key);
            return (
              <div key={s.key} className="flex items-center gap-3 border border-line-2 rounded-lg px-3 py-2 min-w-0">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${d ? "bg-success-bg text-success-ink" : "bg-surface-2 text-faint"}`}>
                  {d ? <Check size={13} /> : <FileText size={12} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink truncate">{s.label}</div>
                  <div className="text-[11px] text-muted truncate">{d ? d.title : s.hint}</div>
                </div>
                {d
                  ? <button onClick={() => setDetails(d)} className={btn}>Open</button>
                  : <button onClick={() => pick(s.key)} className={btn}><Upload size={12} /> Add</button>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents" className={inp + " pl-8"} />
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-muted cursor-pointer select-none">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        {localCopy && (
          <button onClick={() => docsApi.openFolder().catch((e) => toast(String(e), "error"))} className="ml-auto text-[12px] text-muted hover:text-ink inline-flex items-center gap-1.5">
            <FolderOpen size={13} /> Copy on this computer
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl py-14 flex flex-col items-center text-center px-6">
          <div className="text-[13px] text-muted">
            {showArchived ? "Nothing archived." : q ? "No document matches that search." : "No documents yet. Upload one, or add a paper from the list above."}
          </div>
        </div>
      ) : (
        CATS.filter((c) => shown.some((d) => (CATS.some((x) => x.key === d.category) ? d.category : "other") === c.key)).map((c) => (
          <div key={c.key} className="space-y-2">
            <div className="text-[12.5px] font-semibold text-ink-2">{c.label}</div>
            <div className="bg-surface border border-line-2 rounded-xl divide-y divide-line-2 overflow-hidden">
              {shown.filter((d) => (CATS.some((x) => x.key === d.category) ? d.category : "other") === c.key).map((d) => {
                const v = current(d);
                const ex = expiryState(d.expires_on);
                const Icon = v?.mime.startsWith("image/") ? ImageIcon : FileText;
                return (
                  <div key={d.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors min-w-0">
                    <span className="w-8 h-8 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center flex-shrink-0"><Icon size={14} /></span>
                    <button onClick={() => setDetails(d)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-semibold text-ink truncate">{d.title}</span>
                        {ex.tone && <StatusPill tone={ex.tone === "danger" ? "danger" : "warning"}>{ex.text}</StatusPill>}
                      </div>
                      <div className="text-[11px] text-muted truncate mt-0.5">
                        {v?.filename} · {v ? size(v.size) : ""} · version {d.current_version} · updated {day(d.updated_at)}
                        {!ex.tone && ex.text ? ` · ${ex.text}` : ""}
                      </div>
                    </button>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {d.archived ? (
                        <button onClick={() => setArchived(d, false)} className={btn}><RotateCcw size={12} /> Restore</button>
                      ) : (
                        <>
                          {isPdf(d) && (
                            <button onClick={() => fillAndSign(d)} disabled={busy === d.id} className={btn}>
                              {busy === d.id ? <RefreshCw size={12} className="animate-spin" /> : <PenLine size={12} />} Fill and sign
                            </button>
                          )}
                          {v?.mime.startsWith("image/") && <button onClick={() => view(d)} className={btn}>View</button>}
                          <button onClick={() => download(d)} className={btn} title="Download"><Download size={12} /></button>
                          <button onClick={() => setDetails(d)} className={btn} title="Details and versions"><Settings2 size={12} /></button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      {upload && <UploadModal file={upload.file} slot={upload.slot} onClose={() => setUpload(null)} onDone={async () => { setUpload(null); await load(); }} />}
      {details && (
        <DetailsModal doc={details} onClose={() => setDetails(null)} onDownload={download} onArchive={(d) => { setDetails(null); setArchived(d, true); }}
          onSaved={async () => { setDetails(null); await load(); }} />
      )}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>
          <img src={preview.url} alt={preview.title} className="max-w-full max-h-full rounded-lg shadow-xl" />
        </div>
      )}
    </div>
  );
}

function SlotSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inp}>
      <option value="">None of these</option>
      {SLOTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  );
}

function UploadModal({ file, slot, onClose, onDone }: { file: File; slot: string; onClose: () => void; onDone: () => void }) {
  const slotDef = SLOTS.find((s) => s.key === slot);
  const [title, setTitle] = useState(slotDef?.label || file.name.replace(/\.[^.]+$/, ""));
  const [category, setCategory] = useState(slotDef?.category || "other");
  const [checklist, setChecklist] = useState(slot);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (file.size > 25 * 1024 * 1024) { toast("Files over 25 MB can't be stored here.", "error"); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await docsApi.upload({ title: title.trim() || file.name, category, checklistKey: checklist, filename: file.name, bytes });
      if (expires) await docsApi.update(r.id, { expires_on: expires });
      toast("Uploaded");
      onDone();
    } catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-5 max-h-[88vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-ink">Upload a document</h3>
          <button onClick={onClose} className="text-muted hover:text-ink p-0.5"><X size={15} /></button>
        </div>
        <div className="text-[11px] text-muted mb-4 truncate">{file.name} · {size(file.size)}</div>
        <div className="space-y-3">
          <label className="block"><span className="text-[12px] text-muted">Title</span><input className={inp} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="block"><span className="text-[12px] text-muted">Category</span>
            <select className={inp} value={category} onChange={(e) => setCategory(e.target.value)}>{CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
          </label>
          <label className="block"><span className="text-[12px] text-muted">Counts as</span>
            <SlotSelect value={checklist} onChange={(v) => { setChecklist(v); const s = SLOTS.find((x) => x.key === v); if (s) setCategory(s.category); }} />
          </label>
          <label className="block"><span className="text-[12px] text-muted">Renewal date (optional)</span><input type="date" className={inp} value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className={btn}>Cancel</button>
          <button onClick={submit} disabled={busy} className={pri}>{busy ? "Uploading" : "Upload"}</button>
        </div>
      </div>
    </div>
  );
}

function DetailsModal({ doc, onClose, onDownload, onArchive, onSaved }: {
  doc: CompanyDoc; onClose: () => void; onDownload: (d: CompanyDoc, v: number) => void; onArchive: (d: CompanyDoc) => void; onSaved: () => void;
}) {
  const [f, setF] = useState({ title: doc.title, category: doc.category, checklist_key: doc.checklist_key, expires_on: doc.expires_on, notes: doc.notes });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await docsApi.update(doc.id, f); toast("Saved"); onSaved(); } catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-lg p-5 max-h-[88vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-ink truncate">{doc.title}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink p-0.5"><X size={15} /></button>
        </div>
        <div className="space-y-3">
          <label className="block"><span className="text-[12px] text-muted">Title</span><input className={inp} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="text-[12px] text-muted">Category</span>
              <select className={inp} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
            </label>
            <label className="block"><span className="text-[12px] text-muted">Renewal date</span><input type="date" className={inp} value={f.expires_on} onChange={(e) => setF({ ...f, expires_on: e.target.value })} /></label>
          </div>
          <label className="block"><span className="text-[12px] text-muted">Counts as</span><SlotSelect value={f.checklist_key} onChange={(v) => setF({ ...f, checklist_key: v })} /></label>
          <label className="block"><span className="text-[12px] text-muted">Notes</span>
            <textarea className={inp + " h-20 py-2 resize-y"} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Where the original is kept, who issued it, when to renew." />
          </label>
        </div>
        <div className="mt-5">
          <div className="text-[12.5px] font-semibold text-ink-2 mb-2">Versions</div>
          <div className="border border-line-2 rounded-lg divide-y divide-line-2">
            {doc.versions.map((v) => (
              <div key={v.version} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-ink truncate">Version {v.version}{v.version === doc.current_version ? " (current)" : ""} · {v.note || "Uploaded"}</div>
                  <div className="text-[11px] text-muted truncate">{v.filename} · {size(v.size)} · {day(v.created_at)}{v.created_by ? ` · ${v.created_by}` : ""}</div>
                </div>
                <button onClick={() => onDownload(doc, v.version)} className={btn} title="Download this version"><Download size={12} /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-5">
          {!doc.archived && <button onClick={() => onArchive(doc)} className={btn}><Archive size={12} /> Archive</button>}
          <div className="flex-1" />
          <button onClick={onClose} className={btn}>Cancel</button>
          <button onClick={save} disabled={busy} className={pri}>{busy ? "Saving" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
