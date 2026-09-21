// Warehouse (R-326..R-330): stock Jack physically holds, counted in boxes of several sizes.
// This file is the shell — Products and Map, the product cards, and the product form. One
// product's screen is WarehouseProduct.tsx; the map is WarehouseMap.tsx; importing a sheet is
// WarehouseImport.tsx; the rules are lib/warehouse.ts and warehouse_core.rs.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ClipboardPaste, FileSpreadsheet, Plus, Trash2, Warehouse as WarehouseIcon } from "lucide-react";
import { api } from "../lib/api";
import { itemTotals, rowsFromText, sectionUnits, shares, type BoxType, type SheetRead, type WarehouseItem, type WhSection } from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import WarehouseImport from "./WarehouseImport";
import ProductScreen, { CountsGrid, Seg } from "./WarehouseProduct";
import WarehouseMap from "./WarehouseMap";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, newId, plural } from "./warehouseUi";

const BAR = { background: "rgb(var(--c-chart-1))" };
const SHEET_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xls", "ods"];
const SHEET_RE = /\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------------------

export default function WarehouseView() {
  const [items, setItems] = useState<WarehouseItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WarehouseItem | "new" | null>(null);
  const [importing, setImporting] = useState<{ read: SheetRead; fileName: string; targetId: string | null } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [view, setView] = useState<"products" | "map">(() => {
    try { return localStorage.getItem("warehouse_view") === "map" ? "map" : "products"; } catch { return "products"; }
  });
  const pickView = (v: "products" | "map") => { setView(v); setOpenId(null); try { localStorage.setItem("warehouse_view", v); } catch { /* ignore */ } };
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
          <Seg size="md" value={view} onChange={pickView} options={[{ key: "products", label: "Products" }, { key: "map", label: "Map" }]} />
          {view === "products" && <>
            {importButtons}
            <button onClick={() => setEditing("new")} className={WH_BTN_PRIMARY}><Plus size={14} /> Add product</button>
          </>}
        </div>
      </div>

      {view === "map" ? <WarehouseMap items={items || []} /> : <>
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
      </>}
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
              <NumberInput integer value={upp || ""} onValue={setUpp} placeholder="Blank = 21 of the biggest box" style={WH_INPUT_BG} className={WH_INPUT} />
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
