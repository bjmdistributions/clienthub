// R-441 company documents: legal and tax papers in one place. Admin only (App.tsx gates the
// tab; the server refuses anyone else). Files live on the server, sealed in its database and
// in the daily off-site backup; this computer also keeps a copy of every current version.
// Editing a PDF (fill in, sign) saves a new version and keeps the old one.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Archive, Download, FolderOpen, PenLine, RefreshCw, RotateCcw, Search, Settings2, Upload, X, FileText, Image as ImageIcon, Check } from "lucide-react";
import { Button, PageActions } from "./ui";
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

const field = "field-input";

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
      <div className="min-w-0">
        <div className="skeleton h-5 w-80 rounded-md mb-6" />
        <div className="skeleton h-40 rounded-xl mb-4" />
        <div className="skeleton h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <input ref={picker} type="file" className="hidden" accept="application/pdf,image/*,.docx,.xlsx,.txt"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setUpload({ file: f, slot: pendingSlot.current }); }} />

      <PageActions>
        <Button icon={<RefreshCw size={14} />} onClick={load}>Refresh</Button>
        <Button variant="ink" icon={<Upload size={14} />} onClick={() => pick()}>Upload</Button>
      </PageActions>

      <p className="m-0 max-w-[640px] text-[14px] leading-5 text-muted">
        Company documents. Legal and tax papers, visible to admins only. Files are encrypted on the server and included in the daily off-site backup. Editing a form saves a new version and keeps the old one.
      </p>

      {error && <div className="mt-4 text-[13px] text-danger-ink bg-danger-bg rounded-lg px-3 py-2">{error}</div>}

      <div className="hsep mt-6" />

      {renewals.length > 0 && (
        <>
          <section className="py-5 px-1" aria-label="Needs renewal">
            <div className="mb-2 text-[13px] font-medium text-ink">Needs renewal</div>
            {renewals.map((d) => {
              const ex = expiryState(d.expires_on);
              return (
                <button key={d.id} onClick={() => setDetails(d)}
                  className="flex items-center gap-3 w-full h-10 px-2 rounded-lg text-left hover:bg-surface-2 transition-colors duration-150">
                  <span className="flex-1 min-w-0 truncate text-[14px] text-ink">{d.title}</span>
                  <StatusPill tone={ex.tone === "danger" ? "danger" : "warning"}>{ex.text}</StatusPill>
                </button>
              );
            })}
          </section>
          <div className="hsep" />
        </>
      )}

      <section className="py-5 px-1" aria-label="Papers a company keeps on file">
        <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
          <div className="text-[13px] font-medium text-ink">Papers a company keeps on file</div>
          <div className="text-[12px] text-muted">{SLOTS.filter((s) => filled.has(s.key)).length} of {SLOTS.length} on file</div>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8">
          {SLOTS.map((s, i) => {
            const d = filled.get(s.key);
            return (
              <div key={s.key} className={`flex items-center gap-3 min-h-[56px] py-2 px-1 min-w-0 ${i > 0 ? "border-t border-line" : ""} ${i === 1 ? "xl:border-t-0" : ""}`}>
                {d ? <Check size={16} className="flex-shrink-0 text-success-ink" /> : <FileText size={16} className="flex-shrink-0 text-faint" />}
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[14px] font-medium text-ink">{s.label}</div>
                  <div className="truncate text-[12px] text-muted">{d ? d.title : s.hint}</div>
                </div>
                {d
                  ? <Button size="sm" onClick={() => setDetails(d)}>Open</Button>
                  : <Button size="sm" icon={<Upload size={12} />} onClick={() => pick(s.key)}>Add</Button>}
              </div>
            );
          })}
        </div>
      </section>

      <div className="hsep" />

      <section className="pt-5 px-1" aria-label="All documents">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="ui-search flex-1 min-w-[200px] max-w-[360px]">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents" aria-label="Search documents" style={{ width: "100%" }} />
          </label>
          <button role="checkbox" aria-checked={showArchived} onClick={() => setShowArchived(!showArchived)}
            className="inline-flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors duration-150 select-none">
            <span className={`inline-grid place-items-center w-[18px] h-[18px] rounded-[5px] transition-colors duration-150 ${showArchived ? "bg-accent text-on-accent" : "ring-1 ring-inset ring-line-3"}`}>
              <Check size={12} className={`transition-opacity duration-150 ${showArchived ? "opacity-100" : "opacity-0"}`} />
            </span>
            Show archived
          </button>
          {localCopy && (
            <Button size="sm" className="ml-auto !border-transparent !text-muted" icon={<FolderOpen size={14} />}
              onClick={() => docsApi.openFolder().catch((e) => toast(String(e), "error"))}>
              Copy on this computer
            </Button>
          )}
        </div>

        {shown.length === 0 ? (
          <div className="py-[72px] text-center text-[14px] text-muted animate-fade-up">
            {showArchived ? "Nothing archived." : q ? "No document matches that search." : "No documents yet. Upload one, or add a paper from the list above."}
          </div>
        ) : (
          CATS.filter((c) => shown.some((d) => (CATS.some((x) => x.key === d.category) ? d.category : "other") === c.key)).map((c) => (
            <div key={c.key} className="mt-6 animate-fade-up">
              <div className="mb-1 pl-1 text-[13px] font-medium text-muted">{c.label}</div>
              {shown.filter((d) => (CATS.some((x) => x.key === d.category) ? d.category : "other") === c.key).map((d, i) => {
                const v = current(d);
                const ex = expiryState(d.expires_on);
                const Icon = v?.mime.startsWith("image/") ? ImageIcon : FileText;
                return (
                  <div key={d.id} className={`flex items-center gap-3 px-1 py-2.5 min-w-0 rounded-lg hover:bg-surface-2 transition-colors duration-150 ${i > 0 ? "border-t border-line" : ""}`}>
                    <Icon size={16} className="flex-shrink-0 text-muted" />
                    <button onClick={() => setDetails(d)} className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-[14px] font-medium text-ink">{d.title}</span>
                        {ex.tone && <StatusPill tone={ex.tone === "danger" ? "danger" : "warning"}>{ex.text}</StatusPill>}
                      </div>
                      <div className="truncate mt-0.5 text-[12px] text-muted">
                        {v?.filename} · {v ? size(v.size) : ""} · version {d.current_version} · updated {day(d.updated_at)}
                        {!ex.tone && ex.text ? ` · ${ex.text}` : ""}
                      </div>
                    </button>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {d.archived ? (
                        <Button variant="ink" size="sm" icon={<RotateCcw size={12} />} onClick={() => setArchived(d, false)}>Restore</Button>
                      ) : (
                        <>
                          {isPdf(d) && (
                            <Button size="sm" disabled={busy === d.id} onClick={() => fillAndSign(d)}
                              icon={busy === d.id ? <RefreshCw size={12} className="animate-spin" /> : <PenLine size={12} />}>
                              Fill and sign
                            </Button>
                          )}
                          {v?.mime.startsWith("image/") && <Button size="sm" onClick={() => view(d)}>View</Button>}
                          <button onClick={() => download(d)} className="ui-ib" title="Download" aria-label="Download"><Download size={16} /></button>
                          <button onClick={() => setDetails(d)} className="ui-ib" title="Details and versions" aria-label="Details and versions"><Settings2 size={16} /></button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </section>

      {upload && <UploadDrawer file={upload.file} slot={upload.slot} onClose={() => setUpload(null)} onDone={async () => { setUpload(null); await load(); }} />}
      {details && (
        <DetailsDrawer doc={details} onClose={() => setDetails(null)} onDownload={download} onArchive={(d) => { setDetails(null); setArchived(d, true); }}
          onSaved={async () => { setDetails(null); await load(); }} />
      )}
      {preview && (
        <ImagePreview url={preview.url} title={preview.title} onClose={() => { URL.revokeObjectURL(preview.url); setPreview(null); }} />
      )}
    </div>
  );
}

// A right-hand drawer (the DesktopSettings pattern): the scrim fades and the panel slides in on the next frame,
// and Cancel, the scrim, the close button and Escape slide it back out before it unmounts.
function Drawer({ title, sub, onClose, children }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const closing = useRef(false);
  useEffect(() => {
    const r = window.setTimeout(() => setOpen(true), 20);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", key);
    return () => { window.clearTimeout(r); window.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    window.setTimeout(onClose, 240);
  };
  return (
    <>
      <div className={`ui-scrim ${open ? "open" : ""}`} onClick={close} />
      <aside className={`ui-drawer ${open ? "open" : ""}`} role="dialog" aria-label={typeof title === "string" ? title : undefined}>
        <div className="ui-drawer-head">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-[18px] font-medium leading-[26px] text-ink">{title}</h2>
            {sub ? <div className="truncate mt-0.5 text-[12px] text-muted">{sub}</div> : null}
          </div>
          <button onClick={close} className="ui-ib" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="ui-drawer-body">
          <DrawerClose.Provider value={close}>{children}</DrawerClose.Provider>
        </div>
      </aside>
    </>
  );
}
const DrawerClose = createContext<() => void>(() => {});

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1.5 min-w-0 text-[13px] font-medium text-muted">{label}{children}</label>
);

function SlotSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      <option value="">None of these</option>
      {SLOTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
    </select>
  );
}

function CancelButton({ children = "Cancel" }: { children?: ReactNode }) {
  const close = useContext(DrawerClose);
  return <Button onClick={close}>{children}</Button>;
}

function UploadDrawer({ file, slot, onClose, onDone }: { file: File; slot: string; onClose: () => void; onDone: () => void }) {
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
    <Drawer title="Upload a document" sub={`${file.name} · ${size(file.size)}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Title"><input className={field} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Category">
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>{CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        </Field>
        <Field label="Counts as">
          <SlotSelect value={checklist} onChange={(v) => { setChecklist(v); const s = SLOTS.find((x) => x.key === v); if (s) setCategory(s.category); }} />
        </Field>
        <Field label="Renewal date (optional)"><input type="date" className={field} value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <div className="text-[12px] text-muted">Files over 25 MB can't be stored here.</div>
      </div>
      <div className="hsep mt-6" />
      <div className="flex items-center justify-end gap-2 mt-4">
        <CancelButton />
        <Button variant="ink" onClick={submit} disabled={busy}>{busy ? "Uploading" : "Upload"}</Button>
      </div>
    </Drawer>
  );
}

function DetailsDrawer({ doc, onClose, onDownload, onArchive, onSaved }: {
  doc: CompanyDoc; onClose: () => void; onDownload: (d: CompanyDoc, v: number) => void; onArchive: (d: CompanyDoc) => void; onSaved: () => void;
}) {
  const [f, setF] = useState({ title: doc.title, category: doc.category, checklist_key: doc.checklist_key, expires_on: doc.expires_on, notes: doc.notes });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await docsApi.update(doc.id, f); toast("Saved"); onSaved(); } catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <Drawer title={doc.title} sub={catLabel(doc.category)} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Title"><input className={field} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Category">
          <select className={field} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
        </Field>
        <Field label="Renewal date"><input type="date" className={field} value={f.expires_on} onChange={(e) => setF({ ...f, expires_on: e.target.value })} /></Field>
        <Field label="Counts as"><SlotSelect value={f.checklist_key} onChange={(v) => setF({ ...f, checklist_key: v })} /></Field>
        <Field label="Notes">
          <textarea className={field + " h-20 resize-y"} rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Where the original is kept, who issued it, when to renew." />
        </Field>
      </div>
      <div className="mt-7">
        <div className="mb-1 text-[13px] font-medium text-ink">Versions</div>
        {doc.versions.map((v, i) => (
          <div key={v.version} className={`flex items-center gap-3 min-h-[52px] py-2 px-1 ${i > 0 ? "border-t border-line" : ""}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-ink">Version {v.version}{v.version === doc.current_version ? " (current)" : ""} · {v.note || "Uploaded"}</div>
              <div className="truncate mt-0.5 text-[12px] text-muted">{v.filename} · {size(v.size)} · {day(v.created_at)}{v.created_by ? ` · ${v.created_by}` : ""}</div>
            </div>
            <button onClick={() => onDownload(doc, v.version)} className="ui-ib" title="Download this version" aria-label="Download this version"><Download size={16} /></button>
          </div>
        ))}
      </div>
      <div className="hsep mt-6" />
      <div className="flex flex-wrap items-center gap-2 mt-4">
        {!doc.archived && <Button icon={<Archive size={14} />} onClick={() => onArchive(doc)}>Archive</Button>}
        <span className="flex-1" />
        <CancelButton />
        <Button variant="ink" onClick={save} disabled={busy}>{busy ? "Saving" : "Save"}</Button>
      </div>
    </Drawer>
  );
}

function ImagePreview({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const r = window.setTimeout(() => setOpen(true), 20); return () => window.clearTimeout(r); }, []);
  const close = () => { setOpen(false); window.setTimeout(onClose, 180); };
  return (
    <>
      <div className={`ui-scrim ${open ? "open" : ""}`} style={{ zIndex: 48 }} onClick={close} />
      <div role="dialog" aria-label="Image preview"
        className="fixed left-1/2 top-1/2 z-[49] rounded-2xl bg-surface p-3 shadow-xl ring-1 ring-line-3"
        style={{ width: "min(720px, calc(100% - 32px))", maxHeight: "88vh", opacity: open ? 1 : 0,
                 transform: open ? "translate(-50%, -50%)" : "translate(-50%, -47%) scale(0.98)",
                 transition: "opacity 180ms var(--ease), transform 240ms var(--ease)" }}>
        <img src={url} alt={title} className="block max-w-full mx-auto rounded-lg" style={{ maxHeight: "calc(88vh - 76px)" }} />
        <div className="flex items-center justify-between mt-2.5 text-[13px]">
          <span className="text-[12px] text-muted">Click outside to close</span>
          <Button size="sm" onClick={close}>Close</Button>
        </div>
      </div>
    </>
  );
}
