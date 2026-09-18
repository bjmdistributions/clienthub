// Warehouse (R-326, R-327, R-328): stock Jack physically holds, counted in boxes of several
// sizes, and the truckload packer that says exactly which boxes to pull so what is left
// stays even. The rule lives in lib/warehouse.ts (planUnits) with its tests; the import
// screen is WarehouseImport.tsx; this file is the rest of the screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft, Archive, ArchiveRestore, ClipboardPaste, FileSpreadsheet, FileText, Pencil, Plus, SlidersHorizontal, Trash2, Undo2,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  INVOICE_PREFILL_KEY, describePick, invoiceLines, itemTotals, planUnits, rowsFromText, sectionBoxes, sectionUnits, shares,
  type BoxType, type InvoicePrefill, type SheetRead, type WarehouseItem, type WhMove, type WhSection,
} from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import WarehouseImport from "./WarehouseImport";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, newId, plural } from "./warehouseUi";

const BAR = { background: "rgb(var(--c-chart-1))" };
const SHEET_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xls", "ods"];
const SHEET_RE = /\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

function fmtWhen(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------

export default function WarehouseView() {
  const [items, setItems] = useState<WarehouseItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WarehouseItem | "new" | null>(null);
  const [importing, setImporting] = useState<{ read: SheetRead; fileName: string; targetId: string | null } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const openRef = useRef<string | null>(null);
  openRef.current = openId;
  const busyRef = useRef(false);
  busyRef.current = !!editing || !!importing;

  const load = useCallback(() =>
    api.listWarehouseItems()
      .then(setItems)
      .catch((e) => { toast(`Couldn't load the warehouse: ${e}`, "error"); setItems([]); }), []);
  useEffect(() => { load(); }, [load]);

  // Live: a count changed on the phone (or another desktop) lands here as soon as it syncs.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

  const put = (it: WarehouseItem) =>
    setItems((prev) => (prev ? (prev.some((p) => p.id === it.id) ? prev.map((p) => (p.id === it.id ? it : p)) : [...prev, it]) : [it]));

  const openSheet = useCallback(async (path: string) => {
    try {
      const read = await api.warehouseReadSheet(path);
      const fileName = path.split(/[\\/]/).pop() || "Sheet";
      setImporting({ read, fileName, targetId: openRef.current });
    } catch (e) { toast(String(e), "error"); }
  }, []);

  const pickSheet = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Spreadsheet", extensions: SHEET_EXTS }] });
    if (typeof f === "string") openSheet(f);
  };

  // Drop a spreadsheet anywhere on the Warehouse to import it. Tauri hands over paths; the
  // HTML5 drop event would hand over a File with no path.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (busyRef.current) return;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const file = p.paths.find((x) => SHEET_RE.test(x));
          if (file) openSheet(file);
          else if (p.paths.length) toast("Drop a spreadsheet — Excel or CSV.", "error");
        }
      })
      .then((fn) => { if (cancelled) fn(); else un = fn; })
      .catch(() => {});
    return () => { cancelled = true; un?.(); };
  }, [openSheet]);

  const overlay = dragging && (
    <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-accent/10 backdrop-blur-[2px]">
      <div className={`${WH_CARD} px-8 py-6 text-center shadow-[0_8px_24px_rgba(0,0,0,0.12)]`}>
        <FileSpreadsheet size={22} className="text-accent mx-auto mb-2" />
        <div className="text-[14px] font-semibold text-ink">Drop the sheet to import it</div>
        <div className="text-[12px] text-muted mt-0.5">Excel or CSV. You choose what each column is next.</div>
      </div>
    </div>
  );

  if (importing) {
    return (
      <WarehouseImport
        read={importing.read}
        fileName={importing.fileName}
        items={(items || []).filter((i) => !i.archived)}
        defaultTargetId={importing.targetId}
        onClose={() => setImporting(null)}
        onImported={(it) => { put(it); setImporting(null); setOpenId(it.id); }}
      />
    );
  }

  if (editing) {
    return (
      <ProductForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={(it) => { put(it); setEditing(null); setOpenId(it.id); }}
      />
    );
  }

  const importButtons = (
    <>
      <button onClick={() => setPasting(true)} className={WH_BTN_SECONDARY} title="Paste rows copied out of a spreadsheet">
        <ClipboardPaste size={13} /> Paste rows
      </button>
      <button onClick={pickSheet} className={WH_BTN_SECONDARY} title="Or drop the file anywhere on this screen">
        <FileSpreadsheet size={13} /> Import a sheet
      </button>
    </>
  );
  const pasteDialog = pasting && (
    <PasteDialog
      onClose={() => setPasting(false)}
      onRows={async (rows) => {
        try {
          const guess = await api.warehouseGuess(rows);
          setPasting(false);
          setImporting({ read: { rows, sheet_name: null, note: null, guess }, fileName: "Pasted rows", targetId: openRef.current });
        } catch (e) { toast(String(e), "error"); }
      }}
    />
  );

  const open = items?.find((i) => i.id === openId);
  if (open) {
    return (
      <>
        {overlay}
        {pasteDialog}
        <ProductScreen
          key={open.id}
          item={open}
          importButtons={importButtons}
          onBack={() => setOpenId(null)}
          onEdit={() => setEditing(open)}
          onChanged={put}
        />
      </>
    );
  }

  const live = (items || []).filter((i) => !i.archived);
  const archived = (items || []).filter((i) => i.archived);
  const all = live.reduce((a, i) => { const t = itemTotals(i); return { boxes: a.boxes + t.boxes, units: a.units + t.units }; }, { boxes: 0, units: 0 });

  return (
    <div>
      {overlay}
      {pasteDialog}
      <div className="flex flex-wrap justify-between items-start gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Warehouse</h2>
          <p className="text-[12px] text-muted mt-0.5">
            <span className="text-ink-2 font-medium tabular-nums">{live.length}</span> {live.length === 1 ? "product" : "products"}
            <span className="text-faint"> · </span>
            <span className="text-ink-2 font-medium tabular-nums">{n0(all.boxes)}</span> boxes
            <span className="text-faint"> · </span>
            <span className="text-ink-2 font-medium tabular-nums">{n0(all.units)}</span> units on the shelf
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {importButtons}
          <button onClick={() => setEditing("new")} className={WH_BTN_PRIMARY}><Plus size={14} /> Add product</button>
        </div>
      </div>

      {items === null ? (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
          {[0, 1].map((i) => <div key={i} className="h-[112px] bg-surface-2 rounded-xl animate-pulse" />)}
        </div>
      ) : live.length === 0 ? (
        <div className={`${WH_CARD} px-6 py-10 text-center border-dashed`}>
          <WarehouseIcon size={22} className="text-faint mx-auto mb-3" />
          <div className="text-[14px] font-semibold text-ink">Count what is on your shelves</div>
          <p className="text-[13px] text-muted mt-1 max-w-[460px] mx-auto">
            Drop in the spreadsheet you keep your stock in — any layout — and pick what each column is.
            Or add a product by hand. The packer then tells you exactly which boxes to pull for an order.
          </p>
          <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
            <button onClick={pickSheet} className={WH_BTN_PRIMARY}><FileSpreadsheet size={14} /> Import a sheet</button>
            <button onClick={() => setEditing("new")} className={WH_BTN_SECONDARY}><Plus size={13} /> Add by hand</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
          {live.map((it) => <ProductCard key={it.id} item={it} onOpen={() => setOpenId(it.id)} />)}
        </div>
      )}

      {archived.length > 0 && (
        <div className="mt-5">
          <button onClick={() => setShowArchived((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 transition-colors">
            {showArchived ? "Hide" : "Show"} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3 mt-3 opacity-80">
              {archived.map((it) => <ProductCard key={it.id} item={it} onOpen={() => setOpenId(it.id)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PasteDialog({ onClose, onRows }: { onClose: () => void; onRows: (rows: string[][]) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className={`${WH_CARD} w-[560px] max-w-[calc(100vw-32px)] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.12)]`} onClick={(e) => e.stopPropagation()}>
        <div className="text-[14px] font-semibold text-ink">Paste rows</div>
        <p className="text-[12px] text-muted mt-0.5 mb-3">Copy the cells out of your spreadsheet, headings included, and paste them here.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={9} autoFocus style={WH_INPUT_BG}
          placeholder={"Team\tBox size\tBoxes\tPer box\nYankees\tBig Box\t13\t72"}
          className="w-full border border-line px-3 py-2 rounded-lg text-[12.5px] font-mono text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className={WH_BTN_SECONDARY}>Cancel</button>
          <button onClick={() => { const rows = rowsFromText(text); if (rows.length) onRows(rows); }} disabled={!text.trim()} className={WH_BTN_PRIMARY}>Next: pick the columns</button>
        </div>
      </div>
    </div>
  );
}

// ---------- List card ----------

function ProductCard({ item, onOpen }: { item: WarehouseItem; onOpen: () => void }) {
  const t = itemTotals(item);
  const sh = shares(item.box_types, item.sections);
  const ranked = [...item.sections].filter((s) => sectionUnits(item.box_types, s) > 0).sort((a, b) => sh[b.id] - sh[a.id]);
  const top = ranked[0];
  return (
    <button onClick={onOpen} className={`${WH_CARD} text-left px-5 py-4 hover:border-line-3 transition-colors min-w-0`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink truncate">{item.name}</div>
          <div className="text-[12px] text-muted mt-0.5">
            {item.sections.length} {plural(item.section_label)} · {n0(t.boxes)} boxes · {n0(t.units)} units
            {item.box_types.length > 1 && <> · {item.box_types.length} box sizes</>}
            {t.pallets !== null && <> · {t.pallets.toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets</>}
          </div>
        </div>
        {item.archived && <StatusPill>Archived</StatusPill>}
      </div>
      {/* Every section as a slice of one bar, biggest first — the lopsided product is
          obvious before you open it. */}
      <div className="flex h-2 rounded-full overflow-hidden bg-surface-3 mt-3 gap-px">
        {ranked.map((s) => (
          <div key={s.id} title={`${s.name} ${pct(sh[s.id])}`} style={{ ...BAR, width: `${sh[s.id] * 100}%`, opacity: 0.35 + 0.65 * (sh[s.id] / (sh[ranked[0].id] || 1)) }} />
        ))}
      </div>
      <div className="text-[12px] text-muted mt-2">
        {top ? <>Largest: <span className="text-ink-2 font-medium">{top.name}</span> at {pct(sh[top.id])}</> : "Nothing on the shelf"}
      </div>
    </button>
  );
}

// ---------- Product screen: packer, pick list, stock, history ----------

function ProductScreen({ item, importButtons, onBack, onEdit, onChanged }: {
  item: WarehouseItem; importButtons: React.ReactNode; onBack: () => void; onEdit: () => void; onChanged: (it: WarehouseItem) => void;
}) {
  const label = item.section_label || "Section";
  const types = item.box_types;
  const [mode, setMode] = useState<"pallets" | "units">(item.units_per_pallet > 0 ? "pallets" : "units");
  const [count, setCount] = useState(0);
  const [finish, setFinish] = useState<"exact" | "whole">("exact");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [fixed, setFixed] = useState<Record<string, number>>({});
  const [upp, setUpp] = useState(item.units_per_pallet);
  const [takeOut, setTakeOut] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<WhSection[] | null>(null);

  const totals = itemTotals(item);
  const target = mode === "pallets" ? count * (upp || 0) : count;
  const plan = useMemo(
    () => planUnits(types, item.sections, target, { skip, fixed, finish: mode === "pallets" ? "under" : finish }),
    [types, item.sections, target, skip, fixed, finish, mode],
  );
  const grabUnits = Object.values(plan.units).reduce((a, b) => a + b, 0);
  const grabBoxes = Object.values(plan.take).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
  const grabLoose = Object.values(plan.loose).reduce((a, b) => a + b, 0);
  const picking = grabUnits > 0;
  const shNow = shares(types, item.sections);
  const shAfter = shares(types, plan.left);
  const leftOf = (id: string) => plan.left.find((s) => s.id === id)!;
  const rows = [...item.sections].sort((a, b) => (shNow[b.id] - shNow[a.id]) || a.name.localeCompare(b.name));
  const edited = Object.keys(fixed).length > 0;

  const biggest = rows.find((s) => !skip.has(s.id) && sectionUnits(types, s) > 0);
  const story = picking && biggest && Math.round(shNow[biggest.id] * 100) !== Math.round(shAfter[biggest.id] * 100)
    ? `${biggest.name} goes from ${pct(shNow[biggest.id])} to ${pct(shAfter[biggest.id])} of what is left.`
    : "";
  const openings = Object.entries(plan.opened).flatMap(([sid, m]) =>
    Object.entries(m).map(([tid, n]) => `${n} × ${types.find((t) => t.id === tid)?.name ?? "box"} of ${item.sections.find((s) => s.id === sid)?.name ?? ""}`));

  const setTarget = (n: number) => { setCount(Math.max(0, n)); setFixed({}); };

  const saveDetails = async (patch: Partial<WarehouseItem>) => {
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: item.sections,
        units_per_pallet: item.units_per_pallet, unit_price: item.unit_price, notes: item.notes, ...patch,
      });
      onChanged(it);
      return it;
    } catch (e) { toast(String(e), "error"); return null; }
  };

  const sendToInvoice = () => {
    const prefill: InvoicePrefill = { lines: invoiceLines(item, plan), warehouse: { item_id: item.id, item_name: item.name } };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };

  const doTakeOut = async () => {
    setBusy(true);
    try {
      const changes = item.sections.filter((s) => plan.units[s.id]).map((s) => ({
        section_id: s.id,
        boxes: Object.fromEntries(Object.entries(plan.take[s.id] || {}).map(([t, n]) => [t, -n])),
        loose: plan.loose[s.id] ? -plan.loose[s.id] : 0,
      }));
      const r = await api.warehouseAdjust(item.id, changes, { note: note.trim() || undefined });
      onChanged(r.item);
      setTakeOut(false); setNote(""); setCount(0); setFixed({});
      if (r.short.length) toast(`Taken out, but short: ${r.short.map((s) => `${s.name} had ${s.taken} of ${s.wanted}`).join(", ")}`, "error");
      else toast(`${n0(grabUnits)} units taken out of the warehouse`);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  const putBack = async (m: WhMove) => {
    try {
      const r = await api.warehouseAdjust(item.id, [], { note: `Put back${m.reference ? ` from ${m.reference}` : ""}`, undoOf: m.id });
      onChanged(r.item);
      toast("Put back on the shelf");
    } catch (e) { toast(String(e), "error"); }
  };

  const saveCounts = async () => {
    if (!counting) return;
    setBusy(true);
    const it = await saveDetails({ sections: counting });
    setBusy(false);
    if (it) { setCounting(null); toast("Counts saved"); }
  };

  const archive = async (archived: boolean) => {
    try {
      await api.archiveWarehouseItem(item.id, archived);
      onChanged({ ...item, archived });
      toast(archived ? "Archived. It stays under Show archived." : "Back in the warehouse");
      if (archived) onBack();
    } catch (e) { toast(String(e), "error"); }
  };

  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> Warehouse
      </button>
      <div className="flex flex-wrap justify-between items-start gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">{item.name}</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {item.sections.length} {plural(label)} · {n0(totals.boxes)} boxes · {n0(totals.units)} units
            {types.length > 0 && <> · {types.length} box {types.length === 1 ? "size" : "sizes"}</>}
            {totals.pallets !== null && <> · {totals.pallets.toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets at {n0(item.units_per_pallet)}</>}
            {item.unit_price > 0 && <> · {fmtAmount(item.unit_price)} a unit</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {importButtons}
          <button onClick={() => archive(!item.archived)} className={WH_BTN_SECONDARY} title={item.archived ? "Bring back" : "Archive — nothing is deleted"}>
            {item.archived ? <><ArchiveRestore size={13} /> Bring back</> : <><Archive size={13} /> Archive</>}
          </button>
          <button onClick={onEdit} className={WH_BTN_SECONDARY}><Pencil size={13} /> Edit product</button>
        </div>
      </div>

      {/* Packer */}
      <div className={`${WH_CARD} p-5 mb-4`}>
        <div className="text-[14px] font-semibold text-ink">Pack an order</div>
        <p className="text-[12px] text-muted mt-0.5 mb-4">
          Say how much is going out. The biggest {plural(label)} give first, biggest boxes first, so what stays on the shelf evens out.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="flex rounded-lg border border-line p-0.5 bg-surface-2 w-fit mb-1.5" role="tablist">
              {(["pallets", "units"] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setTarget(0); }}
                  className={`px-3 h-7 rounded-md text-[12px] transition-colors ${mode === m ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                  {m === "pallets" ? "Pallets" : "Units"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              {mode === "pallets" && (
                <button onClick={() => setTarget(count - 1)} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px] leading-none" aria-label="One less">−</button>
              )}
              <NumberInput integer value={count || ""} onValue={(n) => setTarget(n)} placeholder="0" style={WH_INPUT_BG}
                className={`${mode === "units" ? "w-32" : "w-20"} border border-line h-9 rounded-lg text-[15px] font-semibold text-ink text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent`} />
              {mode === "pallets" && (
                <button onClick={() => setTarget(count + 1)} className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 text-[16px] leading-none" aria-label="One more">+</button>
              )}
            </div>
          </div>
          {mode === "pallets" ? (
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Units per pallet</label>
              <NumberInput integer value={upp || ""} onValue={(n) => { setUpp(n); setFixed({}); }}
                onBlur={() => { if (upp !== item.units_per_pallet) saveDetails({ units_per_pallet: upp }); }}
                placeholder="e.g. 1,500" style={WH_INPUT_BG}
                className="w-28 border border-line px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
            </div>
          ) : (
            <div>
              <label className="block text-[12px] text-muted mb-1.5">If it does not come out even</label>
              <div className="flex rounded-lg border border-line p-0.5 bg-surface-2 w-fit" role="tablist">
                {(["exact", "whole"] as const).map((f) => (
                  <button key={f} role="tab" aria-selected={finish === f} onClick={() => setFinish(f)}
                    className={`px-3 h-7 rounded-md text-[12px] transition-colors ${finish === f ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                    {f === "exact" ? "Open a box" : "Whole boxes only"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="min-w-0 pb-1.5">
            {picking ? (
              <div className="text-[13px] text-ink tabular-nums">
                <span className="font-semibold">{n0(grabUnits)}</span> units · <span className="font-semibold">{n0(grabBoxes)}</span> boxes
                {grabLoose > 0 && <> + <span className="font-semibold">{n0(grabLoose)}</span> loose</>}
                {item.unit_price > 0 && <> · <span className="font-semibold">{fmtAmount(grabUnits * item.unit_price)}</span></>}
                {mode === "units" && item.units_per_pallet > 0 && <span className="text-muted"> · about {(grabUnits / item.units_per_pallet).toLocaleString("en-US", { maximumFractionDigits: 1 })} pallets</span>}
              </div>
            ) : mode === "pallets" && !(upp > 0) ? (
              <div className="text-[12px] text-warning-ink">Say how many units fit on a pallet to plan by pallet.</div>
            ) : (
              <div className="text-[12px] text-muted">{n0(totals.units)} units on the shelf.</div>
            )}
          </div>
        </div>

        {(story || plan.short !== 0 && target > 0 || openings.length > 0 || edited) && (
          <div className="mt-4 text-[13px] space-y-1">
            {story && <div className="text-ink-2">{story}</div>}
            {openings.length > 0 && <div className="text-ink-2">Open {openings.join(", ")} for the last {n0(grabLoose)}.</div>}
            {plan.short > 0 && target > 0 && (
              <div className="text-warning-ink">
                {mode === "pallets" && grabUnits > 0
                  ? `Whole boxes come to ${n0(grabUnits)} of the ${n0(target)} — ${n0(plan.short)} under, so no box is opened.`
                  : `Only ${n0(target - plan.short)} of the ${n0(target)} units are on the shelf for the ${plural(label)} you picked.`}
              </div>
            )}
            {plan.short < 0 && <div className="text-ink-2">Whole boxes come to {n0(grabUnits)} — {n0(-plan.short)} over.</div>}
            {edited && (
              <div className="text-muted">
                You set some {plural(label)} by hand; the rest are balanced around them.{" "}
                <button onClick={() => setFixed({})} className="text-accent hover:text-accent-hover">Back to the even pick</button>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button onClick={sendToInvoice} disabled={!picking} className={WH_BTN_PRIMARY}><FileText size={14} /> Send to invoice</button>
          <button onClick={() => setTakeOut((v) => !v)} disabled={!picking} className={WH_BTN_SECONDARY}>Take out without an invoice</button>
          {picking && <span className="text-[12px] text-muted">The invoice takes the boxes off the shelf when you create it.</span>}
        </div>
        {takeOut && picking && (
          <div className="mt-3 flex flex-wrap items-center gap-2 p-3 rounded-lg bg-surface-2 border border-line">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for (optional)" style={WH_INPUT_BG} className={`${WH_INPUT} flex-1 min-w-[200px]`} />
            <button onClick={doTakeOut} disabled={busy} className={WH_BTN_PRIMARY}>Take out {n0(grabUnits)} units</button>
            <button onClick={() => setTakeOut(false)} className="text-[12px] text-muted hover:text-ink-2 px-2">Cancel</button>
          </div>
        )}
      </div>

      {/* Pick list: what to grab from each section, and what it does to the shelf */}
      <div className={`${WH_CARD} mb-4 overflow-hidden`}>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
          <div className="text-[14px] font-semibold text-ink">{picking ? "What to grab" : cap(plural(label))}</div>
          <div className="text-[12px] text-muted">Type a number in Units to set a {label.toLowerCase()} by hand.</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[760px]">
            <thead>
              <tr className="text-[12px] text-muted border-y border-line">
                <th className="w-9 pl-5" />
                <th className="text-left font-medium py-2.5 pr-3">{label}</th>
                <th className="text-left font-medium py-2.5 px-3">Grab</th>
                <th className="text-right font-medium py-2.5 px-3">Units</th>
                <th className="text-left font-medium py-2.5 px-3 w-[140px]">Share now</th>
                <th className="text-right font-medium py-2.5 px-3">Left</th>
                <th className="text-right font-medium py-2.5 pl-3 pr-5">Share after</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const off = skip.has(s.id);
                const u = plan.units[s.id] || 0;
                const opened = plan.opened[s.id] || {};
                const openTxt = Object.entries(opened).map(([t, n]) => `${n} × ${types.find((x) => x.id === t)?.name ?? "box"}`).join(", ");
                return (
                  <tr key={s.id} className={`border-b border-line-2 last:border-0 ${off ? "opacity-50" : ""}`}>
                    <td className="pl-5">
                      <input type="checkbox" className="accent-accent" checked={!off} aria-label={`Include ${s.name}`}
                        onChange={() => {
                          setSkip((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; });
                          setFixed((f) => { const n = { ...f }; delete n[s.id]; return n; });
                        }} />
                    </td>
                    <td className="py-2 pr-3 text-ink font-medium truncate max-w-[180px]" title={s.name}>{s.name}</td>
                    <td className="py-2 px-3 text-ink-2">
                      {u > 0 ? (
                        <>
                          {describePick(types, plan.take[s.id] || {}, plan.loose[s.id] || 0)}
                          {openTxt && <div className="text-[11.5px] text-muted">opens {openTxt}</div>}
                        </>
                      ) : <span className="text-faint">—</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <NumberInput integer value={u || ""} disabled={off || sectionUnits(types, s) === 0} placeholder="0" style={WH_INPUT_BG}
                        onValue={(n, raw) => setFixed((f) => { const x = { ...f }; if (raw.trim() === "") delete x[s.id]; else x[s.id] = n; return x; })}
                        className={`w-20 border px-2 h-8 rounded-md text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent ${u > 0 ? "border-accent/40 text-ink font-semibold" : "border-line text-muted"} ${s.id in fixed ? "ring-1 ring-accent/30" : ""}`} />
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                          <div className="h-full rounded-full" style={{ ...BAR, width: `${shNow[s.id] * 100}%` }} />
                        </div>
                        <span className="w-9 text-right tabular-nums text-[12px] text-ink-2">{pct(shNow[s.id])}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-2">{picking ? n0(sectionUnits(types, leftOf(s.id))) : n0(sectionUnits(types, s))}</td>
                    <td className="py-2 pl-3 pr-5 text-right tabular-nums text-ink-2">{picking ? pct(shAfter[s.id]) : ""}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-[13px] text-muted">
                  No {plural(label)} yet. Import a sheet or <button onClick={onEdit} className="text-accent hover:text-accent-hover">add them</button>.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stock by box size — the live count */}
      <div className={`${WH_CARD} mb-4 overflow-hidden`}>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[14px] font-semibold text-ink">On the shelf</div>
            <div className="text-[12px] text-muted">Boxes of each size, and what is loose in an opened box.</div>
          </div>
          {counting ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setCounting(null)} className={WH_BTN_SECONDARY}>Cancel</button>
              <button onClick={saveCounts} disabled={busy} className={WH_BTN_PRIMARY}>Save counts</button>
            </div>
          ) : (
            <button onClick={() => setCounting(item.sections.map((s) => ({ ...s, counts: { ...s.counts } })))} className={WH_BTN_SECONDARY}
              disabled={types.length === 0} title={types.length === 0 ? "Add a box size first (Edit product)" : undefined}>
              <SlidersHorizontal size={13} /> Update counts
            </button>
          )}
        </div>
        <CountsGrid types={types} sections={counting ?? rows} label={label} editing={!!counting}
          onChange={(next) => setCounting(next)} />
        {counting && <p className="text-[12px] text-muted px-5 pb-4">Saving writes the changes to the history as a recount.</p>}
      </div>

      <History item={item} onPutBack={putBack} />
    </div>
  );
}

/** Sections by box size. Read-only, or editable counts (and, in the form, editable names). */
export function CountsGrid({ types, sections, label, editing, withNames, onChange, onRemove }: {
  types: BoxType[]; sections: WhSection[]; label: string; editing?: boolean; withNames?: boolean;
  onChange?: (next: WhSection[]) => void; onRemove?: (id: string) => void;
}) {
  const set = (id: string, patch: Partial<WhSection>) => onChange?.(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const cell = "w-[72px] border border-line px-2 h-8 rounded-md text-right tabular-nums text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent";
  const tot = (tid: string) => sections.reduce((a, s) => a + (s.counts[tid] || 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]" style={{ minWidth: 260 + types.length * 96 }}>
        <thead>
          <tr className="text-[12px] text-muted border-y border-line">
            <th className="text-left font-medium py-2.5 pl-5 pr-3">{label}</th>
            {types.map((t) => (
              <th key={t.id} className="text-right font-medium py-2.5 px-2 whitespace-nowrap">
                {t.name}<div className="text-[11px] font-normal text-faint">of {t.per_box}</div>
              </th>
            ))}
            <th className="text-right font-medium py-2.5 px-2">Loose</th>
            <th className="text-right font-medium py-2.5 px-3">Boxes</th>
            <th className="text-right font-medium py-2.5 pl-3 pr-5">Units</th>
            {withNames && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {sections.map((s) => (
            <tr key={s.id} className="border-b border-line-2 last:border-0">
              <td className="py-1.5 pl-5 pr-3 text-ink font-medium">
                {withNames ? (
                  <input value={s.name} onChange={(e) => set(s.id, { name: e.target.value })} placeholder={label} style={WH_INPUT_BG}
                    className={`${WH_INPUT} h-8 min-w-[140px]`} />
                ) : <span className="truncate block max-w-[200px]" title={s.name}>{s.name}</span>}
              </td>
              {types.map((t) => (
                <td key={t.id} className="py-1.5 px-2 text-right tabular-nums text-ink-2">
                  {editing ? (
                    <NumberInput integer value={s.counts[t.id] || ""} placeholder="0" style={WH_INPUT_BG} className={cell}
                      onValue={(n) => set(s.id, { counts: { ...s.counts, [t.id]: Math.max(0, n) } })} />
                  ) : (s.counts[t.id] ? n0(s.counts[t.id]) : <span className="text-faint">·</span>)}
                </td>
              ))}
              <td className="py-1.5 px-2 text-right tabular-nums text-ink-2">
                {editing ? (
                  <NumberInput integer value={s.loose || ""} placeholder="0" style={WH_INPUT_BG} className={cell}
                    onValue={(n) => set(s.id, { loose: Math.max(0, n) })} />
                ) : (s.loose ? n0(s.loose) : <span className="text-faint">·</span>)}
              </td>
              <td className="py-1.5 px-3 text-right tabular-nums text-ink-2">{n0(sectionBoxes(s))}</td>
              <td className="py-1.5 pl-3 pr-5 text-right tabular-nums text-ink font-medium">{n0(sectionUnits(types, s))}</td>
              {withNames && (
                <td className="pr-3">
                  <button onClick={() => onRemove?.(s.id)} aria-label={`Remove ${s.name || "row"}`}
                    className="h-8 w-8 flex items-center justify-center text-faint hover:text-danger-ink transition-colors"><Trash2 size={13} /></button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {sections.length > 0 && (
          <tfoot>
            <tr className="border-t border-line text-[12.5px] font-semibold text-ink">
              <td className="py-2.5 pl-5 pr-3">Total</td>
              {types.map((t) => <td key={t.id} className="py-2.5 px-2 text-right tabular-nums">{n0(tot(t.id))}</td>)}
              <td className="py-2.5 px-2 text-right tabular-nums">{n0(sections.reduce((a, s) => a + (s.loose || 0), 0))}</td>
              <td className="py-2.5 px-3 text-right tabular-nums">{n0(sections.reduce((a, s) => a + sectionBoxes(s), 0))}</td>
              <td className="py-2.5 pl-3 pr-5 text-right tabular-nums">{n0(sections.reduce((a, s) => a + sectionUnits(types, s), 0))}</td>
              {withNames && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function History({ item, onPutBack }: { item: WarehouseItem; onPutBack: (m: WhMove) => void }) {
  const [all, setAll] = useState(false);
  const moves = all ? item.log : item.log.slice(0, 8);
  if (item.log.length === 0) return null;
  const kindLabel = (m: WhMove) => (m.kind === "out" ? "Out" : m.kind === "in" ? "In" : "Recount");
  const abs = (m: Record<string, number>) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, Math.abs(v)]));
  return (
    <div className={`${WH_CARD} p-5`}>
      <div className="text-[14px] font-semibold text-ink mb-3">History</div>
      <div className="divide-y divide-line-2">
        {moves.map((m) => {
          const units = m.lines.reduce((a, l) => a + (l.units || 0), 0);
          const detail = m.lines.map((l) => {
            const what = describePick(item.box_types, abs(l.boxes), Math.abs(l.loose || 0));
            return `${l.name} ${(l.units || 0) >= 0 ? "+" : "−"}${n0(Math.abs(l.units || 0))}${what ? ` (${what})` : ""}`;
          }).join(" · ");
          return (
            <div key={m.id} className="py-2.5 flex items-start gap-3 min-w-0">
              <div className="w-[118px] flex-shrink-0 text-[12px] text-muted tabular-nums">{fmtWhen(m.at)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink">
                  <span className="font-medium">{kindLabel(m)}</span>
                  <span className="tabular-nums text-ink-2">{units >= 0 ? "+" : "−"}{n0(Math.abs(units))} units</span>
                  {m.reference && <StatusPill tone="accent">{m.reference}</StatusPill>}
                  {m.undone && <StatusPill>Put back</StatusPill>}
                </div>
                <div className="text-[12px] text-muted truncate" title={detail}>{m.note ? `${m.note} · ` : ""}{detail}</div>
              </div>
              {m.kind === "out" && !m.undone && (
                <button onClick={() => onPutBack(m)} className="flex-shrink-0 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 px-2 h-7 rounded-md hover:bg-surface-2 transition-colors">
                  <Undo2 size={12} /> Put back
                </button>
              )}
            </div>
          );
        })}
      </div>
      {item.log.length > 8 && (
        <button onClick={() => setAll((v) => !v)} className="text-[12px] text-accent hover:text-accent-hover mt-2">
          {all ? "Show less" : `Show all ${item.log.length}`}
        </button>
      )}
    </div>
  );
}

// ---------- Add / edit a product ----------

function ProductForm({ initial, onCancel, onSaved }: {
  initial: WarehouseItem | null; onCancel: () => void; onSaved: (it: WarehouseItem) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [label, setLabel] = useState(initial?.section_label && initial.section_label !== "Section" ? initial.section_label : "");
  const [upp, setUpp] = useState(initial?.units_per_pallet ?? 0);
  const [price, setPrice] = useState(initial?.unit_price ?? 0);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [types, setTypes] = useState<BoxType[]>(initial?.box_types.length ? initial.box_types.map((t) => ({ ...t })) : [{ id: newId(), name: "", per_box: 0 }]);
  const [sections, setSections] = useState<WhSection[]>(
    initial?.sections.length ? initial.sections.map((s) => ({ ...s, counts: { ...s.counts } })) : [{ id: newId(), name: "", counts: {}, loose: 0 }],
  );
  const [saving, setSaving] = useState(false);
  const shown = label.trim() || "Section";
  const liveTypes = types.filter((t) => t.per_box > 0);

  const save = async () => {
    if (!name.trim()) { toast("Give the product a name", "error"); return; }
    setSaving(true);
    try {
      const it = await api.saveWarehouseItem({
        id: initial?.id ?? null, name: name.trim(), section_label: label.trim() || "Section",
        box_types: types.filter((t) => t.name.trim() || t.per_box > 0),
        sections, units_per_pallet: upp, unit_price: price, notes,
      });
      toast(initial ? "Saved" : "Product added");
      onSaved(it);
    } catch (e) { toast(String(e), "error"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-[980px]">
      <button onClick={onCancel} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> {initial ? initial.name : "Warehouse"}
      </button>
      <h2 className="text-[18px] font-semibold text-ink tracking-tight mb-5">{initial ? "Edit product" : "Add a product"}</h2>

      <div className={`${WH_CARD} p-5 mb-4`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="lg:col-span-2">
            <label className="block text-[12px] text-muted mb-1.5">Product</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Era 59FIFTY fitted hats" style={WH_INPUT_BG} className={WH_INPUT} autoFocus={!initial} />
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">What each row is</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Team, size, colour…" style={WH_INPUT_BG} className={WH_INPUT} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Units per pallet</label>
              <NumberInput integer value={upp || ""} onValue={setUpp} placeholder="e.g. 1,500" style={WH_INPUT_BG} className={WH_INPUT} />
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Price per unit</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                <NumberInput value={price || ""} onValue={setPrice} placeholder="0.00" style={WH_INPUT_BG} className={`${WH_INPUT} pl-7`} />
              </div>
            </div>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-[12px] text-muted mb-1.5">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where it sits, condition, anything worth knowing" style={WH_INPUT_BG} className={WH_INPUT} />
          </div>
        </div>
      </div>

      <div className={`${WH_CARD} p-5 mb-4`}>
        <div className="text-[14px] font-semibold text-ink">Box sizes</div>
        <p className="text-[12px] text-muted mt-0.5 mb-3">Every box this product comes in, and how many units each one holds.</p>
        <div className="grid grid-cols-[minmax(0,1fr)_130px_32px] gap-2 text-[12px] text-muted px-1 mb-1.5 max-w-[520px]">
          <div>Name</div><div className="text-right">Units per box</div><div />
        </div>
        {types.map((t) => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_130px_32px] gap-2 mb-1.5 items-center max-w-[520px]">
            <input value={t.name} onChange={(e) => setTypes(types.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))} placeholder="e.g. Big Box" style={WH_INPUT_BG} className={WH_INPUT} />
            <NumberInput integer value={t.per_box || ""} onValue={(n) => setTypes(types.map((x) => (x.id === t.id ? { ...x, per_box: Math.max(0, n) } : x)))} placeholder="0" style={WH_INPUT_BG} className={`${WH_INPUT} text-right tabular-nums`} />
            <button onClick={() => setTypes(types.filter((x) => x.id !== t.id))} aria-label={`Remove ${t.name || "size"}`} className="h-9 flex items-center justify-center text-faint hover:text-danger-ink transition-colors"><Trash2 size={13} /></button>
          </div>
        ))}
        <button onClick={() => setTypes([...types, { id: newId(), name: "", per_box: 0 }])} className="mt-1 text-[12px] font-medium text-accent hover:text-accent-hover inline-flex items-center gap-1">
          <Plus size={13} /> Add a box size
        </button>
      </div>

      <div className={`${WH_CARD} mb-4 overflow-hidden`}>
        <div className="px-5 pt-4 pb-2">
          <div className="text-[14px] font-semibold text-ink">{cap(plural(shown))}</div>
          <div className="text-[12px] text-muted">{liveTypes.length ? "Boxes of each size on the shelf." : "Add a box size above to count boxes."}</div>
        </div>
        <CountsGrid types={liveTypes} sections={sections} label={shown} editing withNames
          onChange={setSections} onRemove={(id) => setSections(sections.filter((s) => s.id !== id))} />
        <div className="px-5 py-3">
          <button onClick={() => setSections([...sections, { id: newId(), name: "", counts: {}, loose: 0 }])} className="text-[12px] font-medium text-accent hover:text-accent-hover inline-flex items-center gap-1">
            <Plus size={13} /> Add {shown === "Section" ? "a row" : shown.toLowerCase()}
          </button>
          {initial && <p className="text-[12px] text-muted mt-2">A changed count is saved to the history as a recount.</p>}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={saving || !name.trim()} className={WH_BTN_PRIMARY}>{saving ? "Saving…" : initial ? "Save" : "Add product"}</button>
      </div>
    </div>
  );
}
