import { useEffect, useRef, useState } from "react";
import { api, DEFAULT_READ_OPTIONS, ManifestAnalysis, ManifestColumnMap, ManifestReadOptions, ManifestRule, SavedManifest, SavedManifestFull, SaveManifestRecord } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "./Toast";
import { Upload, ClipboardList, RotateCcw } from "lucide-react";
import StatusPill from "./StatusPill";
import Session, { SaveForm, SessionData } from "./manifest/Session";
import SavedReadOnly from "./manifest/SavedReadOnly";
import { ACCEPTED, fmtDay, fmtInt, mapOfRecord, MANIFEST_EXTS, S, savedTotals } from "./manifest/shared";

/**
 * Manifest analyzer (R-430, rebuilt for R-564). Opens on the saved manifests. Analyzing a file
 * reads every page and section, asks which column is which when the sheet leaves it unclear,
 * asks the category of what the sheet did not say (and remembers the answers as rules), then
 * saves the manifest and sends it on to Inventory or the Warehouse. Every figure comes from the
 * file, from a rule Jack set, or from a number he typed. Nothing is read by AI.
 */

/** A rule as the reader takes it, without the store's own bookkeeping. */
const asRule = (r: ManifestRule): ManifestRule => ({ id: r.id, kind: r.kind, pattern: r.pattern, category: r.category, brand: r.brand });
const rulesNow = async (): Promise<ManifestRule[]> => {
  try { return (await api.listManifestRules()).map(asRule); } catch { return []; }
};
const optionsOf = (m: SavedManifest): ManifestReadOptions => {
  try {
    const o = m.options && typeof m.options === "object" ? m.options : JSON.parse(m.options_json || "{}");
    return { ...DEFAULT_READ_OPTIONS, ...o };
  } catch { return { ...DEFAULT_READ_OPTIONS }; }
};

/** The column map a saved manifest was read with: in its options, else its own column. */
const savedOptions = (m: SavedManifest, rules: ManifestRule[]): ManifestReadOptions => {
  const o = { ...optionsOf(m), rules };
  if (!o.columns && m.column_map && Object.keys(m.column_map).length) {
    o.columns = m.column_map as ManifestColumnMap;
  }
  return o;
};

/** Everything save_manifest keeps, taken from the reading in hand. The store reads nothing again. */
const recordOf = (
  id: string | null, path: string, a: ManifestAnalysis, options: ManifestReadOptions,
  f: { name: string; supplier: string | null; ask: number | null; status?: string },
): SaveManifestRecord => ({
  id, path, name: f.name, supplier: f.supplier, source_name: path.split(/[/\\]/).pop() || null,
  ask: f.ask, status: f.status || "saved",
  pages: a.pages || [], sections: a.sections || [], column_map: options.columns, options,
  totals: { lines: a.total_items, units: a.total_quantity, retail: a.total_retail },
  stated: a.stated, lines: a.lines || [], products: a.products || [],
});

export default function ManifestView({ onNavigate }: { onNavigate: (t: any) => void }) {
  const [list, setList] = useState<SavedManifest[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [session, setSession] = useState<SessionData | null>(null);
  // A saved manifest whose file is gone: its saved products and totals, read-only.
  const [readOnly, setReadOnly] = useState<SavedManifestFull | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const seq = useRef(0);
  const undoTimer = useRef<number | undefined>(undefined);

  const loadList = async (deleted = showDeleted) => {
    try { setList(await (deleted ? api.listManifestsDeleted() : api.listManifests())); } catch (e: any) { setList([]); toast(String(e), "error"); }
  };
  useEffect(() => { loadList(false); }, []);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  /** Read a file. Any layout already remembered for its headings is used at once. */
  const begin = async (path: string) => {
    setBusy(true);
    try {
      let options: ManifestReadOptions = { ...DEFAULT_READ_OPTIONS, rules: await rulesNow() };
      let analysis = await api.analyzeManifest(path, options);
      let mappedLike = null;
      if (analysis.header_signature) {
        const rec = await api.findColumnMap(analysis.header_signature).catch(() => null);
        const map = mapOfRecord(rec);
        if (rec && map) {
          try {
            const withMap = { ...options, columns: map };
            analysis = await api.analyzeManifest(path, withMap);
            options = withMap; mappedLike = rec;
          } catch { /* the layout no longer fits this sheet; keep the first reading */ }
        }
      }
      setSession({ key: ++seq.current, path, options, analysis, saved: null, mappedLike, dirty: false });
    } catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  const upload = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: MANIFEST_EXTS }] });
    if (typeof f !== "string") return;
    begin(f);
  };

  // Native file drag-drop onto the screen (Tauri webview): the HTML5 drop event
  // gives a File with no path, and the analyzer reads from a path.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragActive(true);
      else if (p.type === "leave") setDragActive(false);
      else if (p.type === "drop") {
        setDragActive(false);
        const file = p.paths.find((path) => ACCEPTED.test(path));
        if (file) begin(file);
        else if (p.paths.length) toast("That file can't be read as a manifest. Drop a CSV, Excel, TSV or PDF.", "error");
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  /** Read the open manifest again with different choices (columns, pages, sections, rules). */
  const reread = async (patch: Partial<ManifestReadOptions>, refreshRules = false) => {
    const cur = session;
    if (!cur) return;
    if (!cur.path) { toast("The original file is not on this computer, so it cannot be read again.", "error"); return; }
    setBusy(true);
    try {
      const options: ManifestReadOptions = { ...cur.options, ...patch };
      if (refreshRules) options.rules = await rulesNow();
      const analysis = await api.analyzeManifest(cur.path, options);
      setSession((s) => s && s.key === cur.key
        ? { ...s, options, analysis, dirty: !!s.saved, mappedLike: patch.columns ? null : s.mappedLike }
        : s);
    } catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  const save = async (form: SaveForm, own: { key: string; name: string }[]) => {
    const cur = session;
    if (!cur || !cur.path) { toast("The original file is not on this computer, so it cannot be saved again.", "error"); return; }
    const secs = cur.analysis.sections || [];
    const keys = secs.map((x) => x.key);
    const skipMain = secs.length > 0 && !secs.some((x) => x.read) && own.length > 0;
    let first: SavedManifest | null = null;
    let n = 0;
    if (!skipMain) {
      first = await api.saveManifest(recordOf(cur.saved?.id ?? null, cur.path, cur.analysis, cur.options,
        { name: form.name, supplier: form.supplier || null, ask: form.ask, status: cur.saved?.status }));
      n++;
    }
    for (const o of own) {
      // A section that is its own manifest is read alone, and that reading is what is kept.
      const options = { ...cur.options, sections_off: keys.filter((k) => k !== o.key) };
      const alone = await api.analyzeManifest(cur.path, options);
      await api.saveManifest(recordOf(null, cur.path, alone, options,
        { name: `${form.name}, ${o.name}`, supplier: form.supplier || null, ask: null }));
      n++;
    }
    if (n === 1 && first) {
      const saved = first;
      setSession((s) => s && s.key === cur.key ? { ...s, saved, dirty: false } : s);
      toast("Saved. It is in your list now.");
    } else {
      toast(`Saved ${n} manifests.`);
      setSession(null);
    }
    loadList(false);
  };

  const refreshSaved = async () => {
    const id = session?.saved?.id;
    if (!id) return;
    try {
      const full = await api.getManifest(id);
      setSession((s) => s && s.saved?.id === id ? { ...s, saved: full } : s);
    } catch { /* the screen still works; the link shows on the list */ }
  };

  const openSaved = async (m: SavedManifest) => {
    setWorking(m.id);
    try {
      const full = await api.getManifest(m.id);
      if (!full.file_path) { setReadOnly(full); setWorking(null); return; }
      // The file is read again with the saved options and column map and the rules as they are now.
      const options = savedOptions(full, await rulesNow());
      const analysis = await api.analyzeManifest(full.file_path, options);
      setSession({ key: ++seq.current, path: full.file_path, options, analysis, saved: full, mappedLike: null, dirty: false });
    } catch (e: any) { toast(String(e), "error"); }
    setWorking(null);
  };

  const rereadSaved = async (m: SavedManifest) => {
    if (!m.file_path) { toast("The original file is not on this computer, so it cannot be read again.", "error"); return; }
    setWorking(m.id);
    try {
      const options = savedOptions(m, await rulesNow());
      const analysis = await api.analyzeManifest(m.file_path, options);
      await api.saveManifest(recordOf(m.id, m.file_path, analysis, options, { name: m.name, supplier: m.supplier, ask: m.ask, status: m.status }));
      toast("Read again with your rules as they are now.");
      await loadList();
    } catch (e: any) { toast(String(e), "error"); }
    setWorking(null);
  };

  const commitRename = async () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const cur = list?.find((m) => m.id === r.id);
    if (!r.text.trim() || !cur || r.text.trim() === cur.name) return;
    try { await api.updateManifest(r.id, { name: r.text.trim() }); await loadList(); } catch (e: any) { toast(String(e), "error"); }
  };

  const remove = async (m: SavedManifest) => {
    try {
      await api.deleteManifest(m.id);
      setList((l) => (l || []).filter((x) => x.id !== m.id));
      setUndo({ id: m.id, name: m.name });
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 10000);
    } catch (e: any) { toast(String(e), "error"); }
  };
  const restore = async (id: string) => {
    try { await api.restoreManifest(id); setUndo(null); await loadList(); toast("Restored."); } catch (e: any) { toast(String(e), "error"); }
  };

  const th = "px-3 py-2 font-medium text-muted";
  const linkBtn = "text-[12px] text-ink-2 hover:text-accent disabled:opacity-50 whitespace-nowrap";

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[20px] font-semibold text-ink flex items-center gap-2">
            <ClipboardList size={18} className="text-accent" /> Manifest analyzer
          </h1>
          <p className="text-[13px] text-muted mt-1 max-w-[560px]">
            What is in a load, what the sheet charges for it per unit, and what you can pay at your own resale rates.
            Every figure comes from the file, your rules or a number you set.
          </p>
        </div>
        <button onClick={upload} disabled={busy}
          className="shrink-0 flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors disabled:opacity-50">
          {session ? <RotateCcw size={13} /> : <Upload size={13} />} {busy ? "Reading…" : session ? "Analyze another" : "Analyze a manifest"}
        </button>
      </div>

      {/* Dropping over a result replaces it, so say so rather than swapping silently. */}
      {dragActive && (
        <div className="fixed inset-0 z-40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center">
            <p className="text-[15px] font-semibold text-ink">Drop to analyze this manifest</p>
            {session && <p className="text-[12px] text-muted mt-1">It replaces the manifest on screen.</p>}
          </div>
        </div>
      )}

      {readOnly ? (
        <SavedReadOnly m={readOnly} onBack={() => setReadOnly(null)} />
      ) : session ? (
        <Session key={session.key} s={session} busy={busy} onReread={reread} onSave={save} onRefreshSaved={refreshSaved}
          onBack={() => { setSession(null); loadList(); }} onNavigate={onNavigate} />
      ) : (
        <div className="max-w-[1120px] min-w-0 space-y-4">
          <div className="flex items-center gap-1" role="group">
            {([[false, "Saved"], [true, "Deleted"]] as const).map(([v, label]) => (
              <button key={label} onClick={() => { setShowDeleted(v); setList(null); loadList(v); }}
                className={`px-3 h-8 rounded-lg text-[12.5px] ${showDeleted === v ? "bg-surface-2 text-ink font-medium" : "text-muted hover:text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>

          {list === null ? <p className="text-[13px] text-muted">Loading…</p> : list.length === 0 ? (
            showDeleted ? (
              <p className="text-[13px] text-muted">Nothing has been deleted.</p>
            ) : (
              <button onClick={upload} disabled={busy}
                className={`w-full max-w-[640px] rounded-2xl border border-dashed bg-surface transition-colors py-14 px-6 flex flex-col items-center text-center disabled:opacity-60 ${
                  dragActive ? "border-accent bg-surface-2" : "border-line-3 hover:border-accent hover:bg-surface-2"
                }`}>
                <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-4">
                  <Upload size={20} className="text-accent" />
                </div>
                <p className="text-[15px] font-semibold text-ink">
                  {busy ? "Reading…" : dragActive ? "Drop it here" : "Drop a manifest here, or click to browse"}
                </p>
                <p className="text-[12.5px] text-muted mt-1 max-w-[400px]">
                  CSV, Excel, TSV or a text-based PDF. Nothing is saved until you press Save.
                </p>
              </button>
            )
          ) : (
            <>
              {showDeleted && <p className="text-[12px] text-muted">Deleted manifests are kept. Restore one to bring it back to your list.</p>}
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-surface-2">
                    <tr>
                      <th className={`${th} text-left rounded-l-lg`}>Manifest</th>
                      <th className={`${th} text-left`}>Supplier</th>
                      <th className={`${th} text-left`}>Date</th>
                      <th className={`${th} text-right`}>Units</th>
                      <th className={`${th} text-right`}>Retail</th>
                      <th className={`${th} text-right`}>Ask</th>
                      <th className={`${th} text-left`}>Where it went</th>
                      <th className={`${th} text-right rounded-r-lg`}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => {
                      const t = savedTotals(m);
                      const isBusy = working === m.id;
                      return (
                        <tr key={m.id} className="border-t border-line">
                          <td className="px-3 py-2 text-ink">
                            {renaming?.id === m.id ? (
                              <input autoFocus className={`${S.input} w-56`} value={renaming.text}
                                onChange={(e) => setRenaming({ id: m.id, text: e.target.value })}
                                onBlur={commitRename}
                                onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }} />
                            ) : (
                              <>
                                <div className="font-medium truncate max-w-[220px] xl:max-w-[360px]" title={m.name}>{m.name}</div>
                                {m.source_name && <div className="text-[11px] text-muted truncate max-w-[220px] xl:max-w-[360px]">{m.source_name}</div>}
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{m.supplier || <span className="text-muted">-</span>}</td>
                          <td className="px-3 py-2 text-muted whitespace-nowrap">{fmtDay(m.created_at)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtInt(t.units)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{t.retail > 0 ? fmtAmount(t.retail) : "-"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{m.ask != null && m.ask > 0 ? fmtAmount(m.ask) : "-"}</td>
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-1.5">
                              {m.lot_id && <StatusPill tone="accent">Lot in Inventory</StatusPill>}
                              {m.load_id && <StatusPill tone="shipping">Delivery</StatusPill>}
                              {!m.lot_id && !m.load_id && <StatusPill>Not sent</StatusPill>}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="flex items-center justify-end gap-3">
                              {showDeleted ? (
                                <button onClick={() => restore(m.id)} className={linkBtn}>Restore</button>
                              ) : (
                                <>
                                  <button onClick={() => openSaved(m)} disabled={isBusy} className="text-[12px] font-medium text-accent hover:underline disabled:opacity-50">{isBusy ? "Working…" : "Open"}</button>
                                  <button onClick={() => setRenaming({ id: m.id, text: m.name })} className={linkBtn}>Rename</button>
                                  <button onClick={() => rereadSaved(m)} disabled={isBusy} className={linkBtn} title="Read the file again with your rules as they are now">Re-read</button>
                                  <button onClick={() => remove(m)} className={linkBtn}>Delete</button>
                                </>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {undo && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] bg-ink text-surface text-[13px] rounded-xl px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.18)] flex items-center gap-4">
          <span className="truncate max-w-[320px]">Deleted {undo.name}.</span>
          <button onClick={() => restore(undo.id)} className="font-semibold underline shrink-0">Undo</button>
        </div>
      )}
    </div>
  );
}
