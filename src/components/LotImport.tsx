// R-557. Import lots from a spreadsheet: drop the file, review every row, add them.
//
// Nothing is written until "Add". Each row can open in the full lot form (the same form a
// hand-made lot uses) and comes back as the form would save it; rows that look like a lot
// already in inventory, or like an earlier row in the same file, are flagged and the sure
// ones start unticked. Photos and manifests named in the sheet are fetched up front so a
// broken link shows on its row before anything is added.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, FileSpreadsheet, FileDown, Upload, Pencil, ImagePlus, Check, RotateCcw, FileText } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, Lot, LotDetails } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { lotPriceBlock } from "../lib/price";
import { lotCategories } from "../lib/categories";
import { lotTags } from "../lib/tags";
import { parseSheet, markDuplicates, ImportRow, LotDraft, PhotoRef } from "../lib/lotImport";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

const SHEET_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;
const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const isAbs = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");

type Filter = "all" | "ready" | "dupes" | "fix" | "skipped" | "added";
type EditorSave = (d: LotDraft & { photo_paths: string[] }) => void;

export default function LotImport({ lots, categories, suppliers, onClose, onAdded, renderEditor }: {
  lots: Lot[];
  categories: string[];
  suppliers: string[];
  onClose: () => void;
  /** Inventory reloads after lots were added, whether or not the screen stays open. */
  onAdded: () => void;
  /** The lot form, opened on one row. Passed in so this file does not import InventoryView. */
  renderEditor: (prefill: Partial<Lot>, label: string, onSave: EditorSave, onClose: () => void) => ReactNode;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [unknownColumns, setUnknownColumns] = useState<string[]>([]);
  const [examplesSkipped, setExamplesSkipped] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [dragOver, setDragOver] = useState(false);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [editing, setEditing] = useState<ImportRow | null>(null);
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Read inside the native drop listener, which is registered once.
  const live = useRef({ editing: false, adding: false, hasRows: false, file: null as string | null });
  live.current = { editing: !!editing, adding: !!adding, hasRows: rows.length > 0, file };

  const ctx = useMemo(() => ({
    categories,
    suppliers,
    tags: Array.from(new Set(lots.flatMap((l) => lotTags(l.details_json)))),
  }), [categories, suppliers, lots]);

  const patch = (key: string, p: Partial<ImportRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  // Photos and the manifest for every row, a few rows at a time. Each row shows its own
  // progress, so a sheet of 200 rows is reviewable while the last photos still arrive.
  const fetchFiles = async (list: ImportRow[], baseDir: string) => {
    const queue = list.filter((r) => r.photos.length > 0 || r.manifestRef);
    const work = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const row = r;
        try {
          const got = row.photos.length ? await api.fetchLotImportFiles(row.photos.map((p) => p.ref), baseDir, "photo") : [];
          const photos: PhotoRef[] = row.photos.map((p, i) => ({ ref: p.ref, path: got[i]?.path ?? undefined, error: got[i]?.error ?? undefined }));
          let manifest_file: string | null = null;
          let manifestError: string | null = null;
          if (row.manifestRef) {
            const [m] = await api.fetchLotImportFiles([row.manifestRef], baseDir, "manifest");
            manifest_file = m?.path ?? null;
            manifestError = m?.error ?? null;
          }
          setRows((rs) => rs.map((x) => (x.key === row.key && !x.edited
            ? { ...x, photos, photosLoading: false, manifestError, draft: { ...x.draft, manifest_file } }
            : x)));
        } catch (e: any) {
          patch(row.key, { photosLoading: false, photos: row.photos.map((p) => ({ ...p, error: String(e) })) });
        }
      }
    };
    await Promise.all([work(), work(), work()]);
  };

  const readFile = async (path: string) => {
    setFile(path);
    setReading(true);
    setReadError(null);
    setRows([]);
    setFilter("all");
    try {
      const sheet = await api.readLotImportSheet(path);
      const parsed = parseSheet(sheet.rows, ctx);
      if (typeof parsed === "string") { setReadError(parsed); setReading(false); return; }
      if (parsed.rows.length === 0) {
        setReadError(parsed.examplesSkipped ? "Only the template's example rows are in this file. Add a row for each lot under them." : "There are no lots under the header row.");
        setReading(false);
        return;
      }
      const marked = markDuplicates(parsed.rows.map((r) => ({ ...r, photosLoading: r.photos.length > 0 || !!r.manifestRef })), lots);
      setRows(marked);
      setUnknownColumns(parsed.unknownColumns);
      setExamplesSkipped(parsed.examplesSkipped);
      setReading(false);
      fetchFiles(marked, folderOf(path));
    } catch (e: any) {
      setReadError(String(e));
      setReading(false);
    }
  };

  const chooseFile = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Spreadsheet", extensions: ["xlsx", "xlsm", "xls", "csv", "tsv"] }] });
    if (typeof f === "string") readFile(f);
  };

  const downloadTemplate = async () => {
    const path = await saveDialog({ defaultPath: "Ecliptr lot import template.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
    if (!path) return;
    setSavingTemplate(true);
    try {
      await api.saveLotImportTemplate(path);
      toast(`Template saved to ${fileName(path)}`);
    } catch (e: any) { toast(String(e), "error"); }
    setSavingTemplate(false);
  };

  const addPhotos = (key: string, paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (!imgs.length) { toast("Only JPG, PNG, WEBP or GIF photos can be added", "error"); return; }
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, photos: [...r.photos, ...imgs.map((p) => ({ ref: p, path: p }))] } : r)));
  };
  const pickPhotos = async (key: string) => {
    const f = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    const picked = Array.isArray(f) ? f : typeof f === "string" ? [f] : [];
    if (picked.length) addPhotos(key, picked);
  };
  const removePhoto = (key: string, i: number) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, photos: r.photos.filter((_, n) => n !== i) } : r)));

  // Native drag and drop: a spreadsheet anywhere opens it; photos land on the row under
  // the pointer. The lot form registers its own listener while a row is open in it. The
  // listener is registered once, so it reads this render's readFile through a ref.
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    const rowAt = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr) as HTMLElement | null;
      return el?.closest("[data-import-row]")?.getAttribute("data-import-row") ?? null;
    };
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (live.current.editing || live.current.adding) return;
      if (p.type === "enter" || p.type === "over") { setDragOver(true); setDropRow(rowAt(p.position)); }
      else if (p.type === "leave") { setDragOver(false); setDropRow(null); }
      else if (p.type === "drop") {
        setDragOver(false);
        setDropRow(null);
        const sheet = p.paths.find((x) => SHEET_EXT.test(x));
        if (sheet) {
          if (live.current.hasRows && !confirm(`Open ${fileName(sheet)} instead? The rows you are reviewing will be dropped.`)) return;
          readFileRef.current(sheet);
          return;
        }
        if (!live.current.hasRows) { toast("Drop an Excel or CSV file", "error"); return; }
        const key = rowAt(p.position);
        if (!key) { toast("Drop photos onto the row they belong to", "error"); return; }
        addPhotos(key, p.paths);
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  const saveEdit: EditorSave = (d) => {
    if (!editing) return;
    const { photo_paths, ...draft } = d;
    setRows((rs) => markDuplicates(rs.map((r) => (r.key === editing.key
      ? { ...r, draft, photos: photo_paths.map((p) => ({ ref: p, path: p })), photosLoading: false, manifestRef: null, manifestError: null, problems: [], notes: [], edited: true, state: r.state === "failed" ? "ready" : r.state, error: null, include: r.includeTouched ? r.include : true }
      : r)), lots));
  };

  const toggle = (r: ImportRow, include: boolean) => patch(r.key, { include, includeTouched: true });

  const counts = {
    all: rows.length,
    ready: rows.filter((r) => r.include && r.state !== "added").length,
    dupes: rows.filter((r) => r.dup && r.state !== "added").length,
    fix: rows.filter((r) => r.problems.length > 0).length,
    skipped: rows.filter((r) => !r.include && r.problems.length === 0 && r.state !== "added").length,
    added: rows.filter((r) => r.state === "added").length,
  };
  const shown = rows.filter((r) =>
    filter === "all" ? true
    : filter === "ready" ? r.include && r.state !== "added"
    : filter === "dupes" ? !!r.dup && r.state !== "added"
    : filter === "fix" ? r.problems.length > 0
    : filter === "skipped" ? !r.include && r.problems.length === 0 && r.state !== "added"
    : r.state === "added");
  const toAdd = rows.filter((r) => r.include && r.state !== "added" && r.problems.length === 0);
  const stillFetching = toAdd.some((r) => r.photosLoading);

  const addAll = async () => {
    if (!toAdd.length) return;
    const list = toAdd;
    setAdding({ done: 0, total: list.length });
    let added = 0;
    const cats = new Set<string>();
    for (const [i, r] of list.entries()) {
      setAdding({ done: i, total: list.length });
      patch(r.key, { state: "adding", error: null });
      const d = r.draft;
      try {
        // The same calls, in the same order, as the lot form's create.
        const lot = await api.createLot({ name: d.name, quantity: d.quantity, totalCost: d.total_cost, askingPrice: d.asking_price, description: d.description || undefined, category: d.category || undefined, notes: d.notes || undefined, supplier: d.supplier || undefined, location: d.location || undefined, priceType: d.price_type, detailsJson: d.details_json || undefined });
        // The lot exists from here on. Whatever fails after this is reported on the row, and
        // the row counts as added, so trying again can never make a second lot.
        const after: string[] = [];
        const paths = r.photos.flatMap((p) => (p.path ? [p.path] : []));
        if (paths.length) {
          try { const rel = await api.importLotPhotos(lot.id, paths); await api.updateLot(lot.id, { photos: rel }); }
          catch (e: any) { after.push(`the photos were not copied (${String(e)})`); }
        }
        if (d.manifest_file) {
          try { await api.attachLotManifest(lot.id, d.manifest_file); }
          catch (e: any) { after.push(`the manifest was not attached (${String(e)})`); }
        }
        if (d.sent_whatsapp || d.sent_email) await api.updateLot(lot.id, { sentWhatsapp: d.sent_whatsapp, sentEmail: d.sent_email }).catch(() => after.push("the sent marks were not saved"));
        lotCategories(d.details_json, d.category).forEach((c) => cats.add(c));
        patch(r.key, { state: "added", error: after.length ? `Added, but ${after.join(" and ")}. Open the lot to fix it.` : null });
        added++;
      } catch (e: any) {
        patch(r.key, { state: "failed", error: String(e) });
      }
    }
    // Every category typed becomes a reusable pick, as the form does on save.
    cats.forEach((c) => api.createCategory({ label: c }).catch(() => {}));
    setAdding(null);
    onAdded();
    const failed = list.length - added;
    if (failed === 0) {
      toast(`Added ${added} lot${added === 1 ? "" : "s"}`);
      // Close once nothing is left to fix; rows left out on purpose do not hold it open.
      if (rows.every((r) => r.state === "added" || list.includes(r) || (!r.include && r.problems.length === 0))) onClose();
    } else {
      toast(`Added ${added}. ${failed} could not be added; they are marked below.`, "error");
      setFilter("all");
    }
  };

  const requestClose = () => {
    if (adding) return;
    const pending = rows.filter((r) => r.state !== "added").length;
    if (pending > 0 && counts.added === 0 && !confirm("Close the import? Nothing has been added yet.")) return;
    onClose();
  };

  const stepPick = rows.length === 0;

  return (
    <div className="fixed inset-0 z-50 bg-surface flex flex-col inv-form-in">
      <div className="border-b border-line flex-shrink-0">
        <div className="max-w-[1040px] mx-auto w-full flex justify-between items-center gap-3 px-6 py-3.5">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink">Import lots</h3>
            <p className="text-[11.5px] text-muted mt-0.5 truncate">
              {stepPick
                ? "Add many lots at once from a spreadsheet. Nothing is added until you review it."
                : `${fileName(file || "")}: ${rows.length} row${rows.length === 1 ? "" : "s"}. Nothing is added until you press Add.`}
            </p>
          </div>
          <button onClick={requestClose} disabled={!!adding} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0 disabled:opacity-40"><X size={16} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {stepPick ? (
          <div className="max-w-[640px] mx-auto px-6 py-10 space-y-5">
            <button type="button" onClick={chooseFile} disabled={reading}
              className={`w-full border-2 border-dashed rounded-xl px-6 py-14 flex flex-col items-center justify-center gap-2 transition-colors ${dragOver ? "border-accent bg-accent/10" : "border-line-3 hover:border-accent hover:bg-accent/5"}`}>
              <FileSpreadsheet size={28} className={dragOver ? "text-accent" : "text-muted"} strokeWidth={1.5} />
              <span className="text-[15px] font-semibold text-ink">{reading ? `Reading ${fileName(file || "")}…` : "Drop your spreadsheet here"}</span>
              <span className="text-[12.5px] text-muted">Excel or CSV, one row per lot</span>
              {!reading && <span className="mt-2 inline-flex items-center gap-1.5 border border-line-3 text-ink-2 px-3 h-9 rounded-lg text-[13px] font-medium bg-surface"><Upload size={13} /> Choose a file</span>}
            </button>
            {readError && (
              <div className="rounded-lg border border-danger-ink/20 bg-danger-bg px-4 py-3 text-[13px] text-danger-ink">
                <span className="font-medium">{fileName(file || "")}</span>: {readError}
              </div>
            )}
            <div className="rounded-xl border border-line bg-surface-2/50 px-5 py-4 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-ink">The template</p>
                <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
                  A column for every field on the lot form, with a sheet that explains each one. Photos go in as web links or
                  file names saved next to the spreadsheet, as many as you like per lot. Fill it in yourself, or give it to an assistant to fill from your emails.
                </p>
              </div>
              <button onClick={downloadTemplate} disabled={savingTemplate}
                className="flex-shrink-0 flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50">
                <FileDown size={14} /> {savingTemplate ? "Saving…" : "Download"}
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[1040px] mx-auto px-6 py-5">
            <div className="flex flex-wrap items-center gap-1 bg-surface-3 rounded-lg p-0.5 w-fit mb-3">
              {([
                ["all", "All"], ["ready", "To add"], ["dupes", "Possible duplicates"], ["fix", "Needs a fix"], ["skipped", "Left out"], ["added", "Added"],
              ] as [Filter, string][]).filter(([f]) => f === "all" || counts[f] > 0).map(([f, label]) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`text-[12.5px] font-medium h-8 px-3 rounded-md transition-colors tabular-nums ${filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                  {label} <span className={filter === f ? "text-ink-2" : "text-faint"}>{counts[f]}</span>
                </button>
              ))}
            </div>
            <div className="space-y-1 mb-4 text-[12px]">
              {examplesSkipped > 0 && <p className="text-muted">The template's {examplesSkipped} example row{examplesSkipped === 1 ? " was" : "s were"} left out.</p>}
              {unknownColumns.length > 0 && <p className="text-warning-ink">Not read, because the column names are not in the template: {unknownColumns.join(", ")}.</p>}
              <p className="text-muted">Drop photos on a row to add them. Edit opens the row in the full lot form.</p>
            </div>

            <div className="space-y-2">
              {shown.map((r) => (
                <Row key={r.key} row={r} lots={lots} dropping={dragOver && dropRow === r.key} busy={!!adding}
                  onToggle={(v) => toggle(r, v)} onEdit={() => setEditing(r)} onPickPhotos={() => pickPhotos(r.key)} onRemovePhoto={(i) => removePhoto(r.key, i)} />
              ))}
              {shown.length === 0 && <p className="text-[13px] text-muted py-10 text-center">No rows here.</p>}
            </div>
          </div>
        )}
      </div>

      {!stepPick && (
        <div className="border-t border-line flex-shrink-0">
          <div className="max-w-[1040px] mx-auto w-full flex items-center justify-between gap-3 px-6 py-3.5">
            <button onClick={() => { if (counts.added > 0 || confirm("Choose another file? The rows you are reviewing will be dropped.")) { setRows([]); setFile(null); setReadError(null); } }}
              disabled={!!adding} className="text-[13px] text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2 transition-colors disabled:opacity-40">
              Choose another file
            </button>
            <div className="flex items-center gap-3">
              <span className="text-[12.5px] text-muted tabular-nums hidden sm:inline">
                {adding ? `Adding ${adding.done + 1} of ${adding.total}…`
                  : stillFetching ? "Getting photos…"
                  : `${toAdd.length} of ${rows.length - counts.added} will be added`}
              </span>
              <button onClick={addAll} disabled={!!adding || toAdd.length === 0 || stillFetching}
                className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
                {adding ? "Adding…" : `Add ${toAdd.length} lot${toAdd.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && renderEditor(
        { ...editing.draft, photo_paths: editing.photos.flatMap((p) => (p.path ? [p.path] : [])) } as Partial<Lot>,
        `Row ${editing.line} of your spreadsheet`,
        saveEdit,
        () => setEditing(null),
      )}
    </div>
  );
}

function Row({ row, lots, dropping, busy, onToggle, onEdit, onPickPhotos, onRemovePhoto }: {
  row: ImportRow; lots: Lot[]; dropping: boolean; busy: boolean;
  onToggle: (v: boolean) => void; onEdit: () => void; onPickPhotos: () => void; onRemovePhoto: (i: number) => void;
}) {
  const d = row.draft;
  let det: LotDetails = {};
  try { det = JSON.parse(d.details_json || "{}") || {}; } catch { det = {}; }
  const price = lotPriceBlock(d, det);
  const cats = lotCategories(d.details_json, d.category);
  const good = row.photos.filter((p) => p.path);
  const bad = row.photos.filter((p) => p.error);
  const added = row.state === "added";
  const blocked = row.problems.length > 0;
  const facts = [
    d.quantity > 0 ? `${d.quantity.toLocaleString()}${det.qty_approx ? "+" : ""} units` : null,
    det.pallets ? `${det.pallets} pallet${det.pallets === 1 ? "" : "s"}` : null,
    price.priced ? `${price.headline}${price.unit ? ` ${price.unit}` : ""}` : "No price set",
    price.pallet,
    price.total,
    price.moq,
    // total_cost is in the price's terms: per unit on a per-unit lot.
    d.total_cost > 0 ? `cost ${fmtAmount(d.total_cost)}${d.price_type === "per_unit" ? " / unit" : ""}` : null,
  ].filter(Boolean);
  const pill = added ? <StatusPill tone="success">Added</StatusPill>
    : row.state === "adding" ? <StatusPill tone="accent">Adding</StatusPill>
    : row.state === "failed" ? <StatusPill tone="danger">Not added</StatusPill>
    : blocked ? <StatusPill tone="danger">Needs a fix</StatusPill>
    : row.dup?.strength === "same" ? <StatusPill tone="warning">{row.dup.against === "file" ? `Repeats row ${row.dup.line}` : "Already in inventory"}</StatusPill>
    : row.dup ? <StatusPill tone="warning">Possible duplicate</StatusPill>
    : !row.include ? <StatusPill>Left out</StatusPill>
    : <StatusPill tone="accent">Ready</StatusPill>;
  const dupLot = row.dup?.lotId ? lots.find((l) => l.id === row.dup!.lotId) : null;

  return (
    <div data-import-row={row.key}
      className={`rounded-xl border px-4 py-3 transition-colors ${dropping ? "border-accent bg-accent/5" : added ? "border-line bg-surface-2/40" : "border-line bg-surface"}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" className="accent-accent mt-1.5 w-4 h-4 flex-shrink-0" checked={row.include || added} disabled={added || blocked || busy}
          onChange={(e) => onToggle(e.target.checked)} title={blocked ? "Fix this row before it can be added" : "Add this row"} />
        <div className="w-14 h-14 rounded-lg border border-line bg-surface-3 flex-shrink-0 overflow-hidden flex items-center justify-center">
          {good[0]?.path ? <img src={convertFileSrc(good[0].path)} alt="" className="w-full h-full object-cover" />
            : row.photosLoading ? <span className="text-[10.5px] text-muted">Getting</span>
            : <ImagePlus size={18} className="text-faint" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={`text-[14.5px] font-semibold truncate ${d.name ? "text-ink" : "text-danger-ink"}`}>{d.name || "No name"}</p>
              <p className="text-[12px] text-muted mt-0.5 truncate">
                {[`Row ${row.line}`, cats.join(", ") || null, det.condition || null, d.location, d.supplier].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {pill}
              {!added && (
                <button onClick={onEdit} disabled={busy || row.photosLoading} title={row.photosLoading ? "Getting this row's photos first" : "Open in the lot form"}
                  className="flex items-center gap-1 text-[12.5px] text-ink-2 border border-line px-2.5 h-8 rounded-lg hover:bg-surface-2 transition-colors disabled:opacity-40">
                  <Pencil size={12} /> Edit
                </button>
              )}
            </div>
          </div>
          <p className="text-[12.5px] text-ink-2 mt-1.5 tabular-nums">{facts.join(" · ")}</p>

          {row.problems.length > 0 && (
            <ul className="mt-2 space-y-0.5">{row.problems.map((p) => <li key={p} className="text-[12.5px] text-danger-ink">{p}</li>)}</ul>
          )}
          {row.error && <p className={`mt-2 text-[12.5px] ${added ? "text-warning-ink" : "text-danger-ink"}`}>{row.error}</p>}
          {row.notes.length > 0 && !added && <p className="mt-1.5 text-[12px] text-muted">{row.notes.join(". ")}.</p>}

          {row.dup && !added && (
            <div className="mt-2.5 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12.5px] text-warning-ink min-w-0">
                {row.dup.against === "file" ? <>Looks like row {row.dup.line} in this file</> : <>Looks like <span className="font-medium">{row.dup.name}</span>, {dupLot?.status ?? row.dup.status} in your inventory</>}
                {": "}{row.dup.quantity.toLocaleString()} units at {fmtAmount(row.dup.asking_price)}{row.dup.price_type === "per_unit" ? " / unit" : row.dup.price_type === "total" ? " for the lot" : ""}. {row.dup.why}.
              </p>
              {!blocked && (
                <button onClick={() => onToggle(!row.include)} disabled={busy}
                  className="text-[12.5px] font-medium text-ink-2 border border-line bg-surface px-2.5 h-8 rounded-lg hover:bg-surface-2 transition-colors flex-shrink-0 inline-flex items-center gap-1">
                  {row.include ? <><RotateCcw size={12} /> Leave it out</> : <><Check size={12} /> Add it anyway</>}
                </button>
              )}
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {row.photos.map((p, i) => p.path ? (
              <div key={`${p.ref}-${i}`} className="relative group">
                <img src={convertFileSrc(p.path)} alt="" className="w-11 h-11 object-cover rounded-md border border-line" title={isAbs(p.ref) ? fileName(p.ref) : p.ref} />
                {!added && !busy && (
                  <button onClick={() => onRemovePhoto(i)} title="Remove this photo"
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-danger text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><X size={10} /></button>
                )}
              </div>
            ) : null)}
            {row.photosLoading && <span className="text-[12px] text-muted">Getting {row.photos.length} photo{row.photos.length === 1 ? "" : "s"}…</span>}
            {!added && !row.photosLoading && (
              <button onClick={onPickPhotos} disabled={busy}
                className="h-11 px-3 rounded-md border border-dashed border-line-3 text-[12px] text-muted hover:border-accent hover:text-accent transition-colors inline-flex items-center gap-1.5">
                <ImagePlus size={13} /> {good.length ? "Add more" : "Add photos"}
              </button>
            )}
            {d.manifest_file && <span className="text-[12px] text-ink-2 inline-flex items-center gap-1 ml-1"><FileText size={13} className="text-muted" /> {fileName(d.manifest_file)}</span>}
          </div>
          {bad.length > 0 && !added && (
            <ul className="mt-1.5 space-y-0.5">
              {bad.map((p, i) => <li key={`${p.ref}-${i}`} className="text-[12px] text-warning-ink break-all">Photo not used, {p.ref}: {p.error}</li>)}
            </ul>
          )}
          {row.manifestError && !added && <p className="mt-1 text-[12px] text-warning-ink break-all">Manifest not used, {row.manifestRef}: {row.manifestError}</p>}
        </div>
      </div>
    </div>
  );
}
