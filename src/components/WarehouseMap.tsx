// The warehouse map (R-330): a floor of pallet spots or a run of shelving, drawn as a grid,
// each spot saying what sits there and how full it is. Click a spot (or drag across several,
// shift-click for a block, ctrl-click to add one) and set it in the panel beside the grid.
// Changes save on their own a moment after the last edit. Cleaned server-side by
// warehouse_core::clean_layout, so the phone draws the same map.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Archive, LayoutGrid, Pencil, Plus, Rows3, StickyNote } from "lucide-react";
import { api } from "../lib/api";
import {
  FILL_LABELS, cellKey, colName, layoutSummary, spotName,
  type LayoutCell, type WarehouseItem, type WarehouseLayout,
} from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import { Seg } from "./WarehouseProduct";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, rgba, teamColor } from "./warehouseUi";

const key = (r: number, c: number) => `${r}:${c}`;
const blank = (r: number, c: number): LayoutCell => ({ r, c, item_id: "", section_id: "", label: "", fill: 0, note: "", aisle: false });
const FILL_SHORT = ["", "¼", "½", "¾", "Full"];

export default function WarehouseMap({ items }: { items: WarehouseItem[] }) {
  const [layouts, setLayouts] = useState<WarehouseLayout[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WarehouseLayout | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(() => {
    if (dirty.current) return; // never pull a map out from under an edit that has not saved yet
    api.listWarehouseLayouts().then((ls) => {
      setLayouts(ls);
      setActiveId((cur) => cur && ls.some((l) => l.id === cur) ? cur : (ls.find((l) => !l.archived)?.id ?? null));
    }).catch((e) => { toast(`Couldn't load the map: ${e}`, "error"); setLayouts([]); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => load()).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

  const live = (layouts || []).filter((l) => !l.archived);
  const archived = (layouts || []).filter((l) => l.archived);
  const active = (layouts || []).find((l) => l.id === activeId) || null;
  const put = (l: WarehouseLayout) => setLayouts((prev) => prev ? (prev.some((x) => x.id === l.id) ? prev.map((x) => (x.id === l.id ? l : x)) : [...prev, l]) : [l]);

  if (editing) {
    return <LayoutForm initial={editing === "new" ? null : editing} onCancel={() => setEditing(null)}
      onSaved={(l) => { put(l); setActiveId(l.id); setEditing(null); }} />;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {live.map((l) => (
          <button key={l.id} onClick={() => setActiveId(l.id)}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[12.5px] transition-colors ${l.id === activeId ? "border-accent bg-accent/10 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
            {l.kind === "shelving" ? <Rows3 size={13} className="text-muted" /> : <LayoutGrid size={13} className="text-muted" />}
            {l.name}
          </button>
        ))}
        <button onClick={() => setEditing("new")} className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-dashed border-line-3 text-[12.5px] text-accent hover:bg-accent/10 transition-colors">
          <Plus size={13} /> Add a map
        </button>
        {archived.length > 0 && (
          <button onClick={() => setShowArchived((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 ml-1">{showArchived ? "Hide" : "Show"} archived ({archived.length})</button>
        )}
        {showArchived && archived.map((l) => (
          <button key={l.id} onClick={() => setActiveId(l.id)} className={`inline-flex items-center h-8 px-3 rounded-full border text-[12.5px] opacity-70 ${l.id === activeId ? "border-accent" : "border-line"}`}>{l.name}</button>
        ))}
      </div>

      {layouts === null ? (
        <div className="h-[320px] bg-surface-2 rounded-xl animate-pulse" />
      ) : !active ? (
        <div className={`${WH_CARD} border-dashed px-6 py-12 text-center`}>
          <LayoutGrid size={22} className="text-faint mx-auto mb-3" />
          <div className="text-[14px] font-semibold text-ink">Draw your warehouse</div>
          <p className="text-[13px] text-muted mt-1 max-w-[460px] mx-auto">
            Add a map for each area — a floor of pallets, or a run of shelving — then mark each spot with the team on it and how full it is.
          </p>
          <button onClick={() => setEditing("new")} className={`${WH_BTN_PRIMARY} mt-4`}><Plus size={14} /> Add a map</button>
        </div>
      ) : (
        <MapEditor key={active.id} layout={active} items={items} dirty={dirty}
          onSaved={put} onEdit={() => setEditing(active)}
          onArchive={async () => {
            try {
              await api.archiveWarehouseLayout(active.id, !active.archived);
              put({ ...active, archived: !active.archived });
              toast(active.archived ? "Map brought back" : "Map archived. It stays under Show archived.");
              if (!active.archived) setActiveId(live.find((l) => l.id !== active.id)?.id ?? null);
            } catch (e) { toast(String(e), "error"); }
          }} />
      )}
    </div>
  );
}

/** The teams a spot can be marked with: every product's sections, by product. */
function useChoices(items: WarehouseItem[]) {
  return useMemo(() => items.filter((i) => !i.archived).map((i) => ({
    item: i, sections: [...i.sections].sort((a, b) => a.name.localeCompare(b.name)),
  })), [items]);
}

function MapEditor({ layout, items, dirty, onSaved, onEdit, onArchive }: {
  layout: WarehouseLayout; items: WarehouseItem[]; dirty: React.MutableRefObject<boolean>;
  onSaved: (l: WarehouseLayout) => void; onEdit: () => void; onArchive: () => void;
}) {
  const [cells, setCells] = useState<Record<string, LayoutCell>>(() => Object.fromEntries(layout.cells.map((c) => [key(c.r, c.c), c])));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const anchor = useRef<{ r: number; c: number } | null>(null);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const choices = useChoices(items);
  const shelving = layout.kind === "shelving";

  // Autosave a moment after the last change — and at once if the map is left before then,
  // so switching maps mid-edit never drops the last spot marked.
  const pending = useRef<Record<string, LayoutCell> | null>(null);
  const body = (next: Record<string, LayoutCell>) => ({
    id: layout.id, name: layout.name, kind: layout.kind, rows: layout.rows, cols: layout.cols, cells: Object.values(next), notes: layout.notes,
  });
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const save = useCallback((next: Record<string, LayoutCell>) => {
    dirty.current = true;
    pending.current = next;
    setStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      pending.current = null;
      setStatus("saving");
      try {
        const saved = await api.saveWarehouseLayout(bodyRef.current(next));
        onSaved({ ...saved, cells: Object.values(next) });
        setStatus("saved");
      } catch (e) { toast(String(e), "error"); setStatus("unsaved"); }
      finally { dirty.current = false; }
    }, 700);
  }, [onSaved, dirty]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) {
      api.saveWarehouseLayout(bodyRef.current(pending.current)).catch((e) => toast(`The map did not save: ${e}`, "error"))
        .finally(() => { dirty.current = false; });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const up = () => { dragging.current = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setSel(new Set()); setFocus(null); } };
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mouseup", up); window.removeEventListener("keydown", esc); };
  }, []);

  const rect = (a: { r: number; c: number }, b: { r: number; c: number }) => {
    const out = new Set<string>();
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++)
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.add(key(r, c));
    return out;
  };
  const down = (r: number, c: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) { setSel(rect(anchor.current, { r, c })); return; }
    if (e.ctrlKey || e.metaKey) {
      setSel((p) => { const n = new Set(p); if (n.has(key(r, c))) n.delete(key(r, c)); else n.add(key(r, c)); return n; });
      anchor.current = { r, c };
      return;
    }
    anchor.current = { r, c };
    dragging.current = true;
    setSel(new Set([key(r, c)]));
  };
  const enter = (r: number, c: number) => { if (dragging.current && anchor.current) setSel(rect(anchor.current, { r, c })); };

  const apply = (patch: (c: LayoutCell) => LayoutCell) => {
    const next = { ...cells };
    for (const k of sel) {
      const [r, c] = k.split(":").map(Number);
      next[k] = patch(next[k] || blank(r, c));
    }
    setCells(next);
    save(next);
  };
  const setWhat = (v: string) => apply((c) => {
    if (!v) return { ...c, item_id: "", section_id: "", label: "" };
    const [kind, a, b] = v.split("|");
    const base = { ...c, aisle: false, fill: c.fill || 4 }; // marking a spot with a team means something is on it
    return kind === "s" ? { ...base, item_id: a, section_id: b, label: "" } : { ...base, item_id: "", section_id: "", label: a };
  });

  const nameOf = useCallback((c: LayoutCell) => {
    if (c.section_id) {
      const it = items.find((i) => i.id === c.item_id);
      const s = it?.sections.find((x) => x.id === c.section_id);
      return s ? s.name : "Removed team";
    }
    return c.label;
  }, [items]);
  const productOf = (c: LayoutCell) => (c.section_id ? items.find((i) => i.id === c.item_id)?.name ?? "" : "");

  const selCells = [...sel].map((k) => { const [r, c] = k.split(":").map(Number); return cells[k] || blank(r, c); });
  const first = selCells[0];
  const same = <T,>(f: (c: LayoutCell) => T) => (selCells.every((c) => f(c) === f(first)) ? f(first) : undefined);
  const whatValue = first ? same((c) => (c.section_id ? `s|${c.item_id}|${c.section_id}` : c.label ? `l|${c.label}` : "")) : "";
  const fillValue = first ? same((c) => c.fill) : undefined;
  const all = Object.values(cells);
  const summary = layoutSummary({ rows: layout.rows, cols: layout.cols, cells: all });

  // The legend: what is on this map, biggest first.
  const legend = useMemo(() => {
    const m = new Map<string, { key: string; name: string; product: string; spots: number; full: number }>();
    for (const c of all) {
      const k = cellKey(c);
      if (!k || c.aisle) continue;
      const e = m.get(k) || { key: k, name: nameOf(c), product: productOf(c), spots: 0, full: 0 };
      e.spots += 1;
      if (c.fill >= 4) e.full += 1;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.spots - a.spots || a.name.localeCompare(b.name));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, items]);

  const size = shelving ? { w: 78, h: 58 } : { w: 64, h: 64 };
  const levelLabel = (r: number) => (shelving ? `Level ${layout.rows - r}` : "");

  const cellView = (r: number, c: number) => {
    const k = key(r, c);
    const cell = cells[k];
    const selected = sel.has(k);
    const dim = focus !== null && (!cell || cellKey(cell) !== focus);
    const ck = cell ? cellKey(cell) : "";
    const color = ck ? teamColor(ck) : "";
    const label = cell ? nameOf(cell) : "";
    const title = `${spotName(layout.kind, layout.rows, r, c)}${cell?.aisle ? " · aisle" : label ? ` · ${label} · ${FILL_LABELS[cell!.fill]}` : ""}${cell?.note ? ` · ${cell.note}` : ""}`;
    return (
      <button key={k} title={title} onMouseDown={(e) => { e.preventDefault(); down(r, c, e); }} onMouseEnter={() => enter(r, c)}
        style={{ width: size.w, height: size.h, opacity: dim ? 0.25 : 1,
          backgroundImage: cell?.aisle ? "repeating-linear-gradient(135deg, rgb(var(--c-line-3)) 0 1px, transparent 1px 7px)" : undefined }}
        className={`relative rounded-md overflow-hidden text-left transition-[opacity,box-shadow] duration-[130ms] select-none
          ${cell?.aisle ? "border border-transparent" : ck ? "bg-surface border border-line" : "border border-dashed border-line-3 hover:border-line"}
          ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-bg z-10" : ""}`}>
        {ck && !cell!.aisle && cell!.fill > 0 && (
          <div className="absolute inset-x-0 bottom-0" style={{ height: `${(cell!.fill / 4) * 100}%`, background: rgba(color, 0.22), borderTop: `2px solid ${rgba(color, 0.9)}` }} />
        )}
        {ck && !cell!.aisle && <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: rgba(color, 0.9) }} />}
        {/* Pinned to the top: a button centres its content, which put the name on the half-full line. */}
        <div className="absolute left-0 right-2 top-0 px-1.5 pt-1 text-[10.5px] leading-tight font-medium text-ink line-clamp-2 break-words">{cell?.aisle ? "" : label}</div>
        {ck && !cell!.aisle && <div className="absolute right-1 bottom-0.5 text-[9.5px] font-medium text-ink-2 tabular-nums">{FILL_SHORT[cell!.fill] || "Empty"}</div>}
        {cell?.note && <StickyNote size={9} className="absolute right-1 top-1 text-muted" aria-hidden />}
      </button>
    );
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
      <div className={`${WH_CARD} overflow-hidden min-w-0`}>
        <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink truncate">{layout.name}</div>
            <div className="text-[12px] text-muted">
              {shelving ? `Shelving · ${layout.cols} bays, ${layout.rows} levels` : `Pallet floor · ${layout.rows} rows of ${layout.cols}`}
              <span className="text-faint"> · </span>{status === "saving" ? "Saving…" : status === "unsaved" ? "Saving shortly" : "Saved"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onEdit} className={WH_BTN_SECONDARY}><Pencil size={13} /> Name and size</button>
            <button onClick={onArchive} className={WH_BTN_SECONDARY}><Archive size={13} /> {layout.archived ? "Bring back" : "Archive"}</button>
          </div>
        </div>
        <div className="px-5 pb-3 flex flex-wrap gap-2 text-[12px]">
          {[
            { l: "Spots", v: summary.spots },
            { l: "Full", v: summary.full },
            { l: "Partly full", v: summary.partial },
            { l: "Empty", v: summary.empty },
          ].map((x) => (
            <span key={x.l} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-ink-2">
              {x.l} <span className="font-semibold text-ink tabular-nums">{n0(x.v)}</span>
            </span>
          ))}
        </div>
        <div className="overflow-auto px-5 pb-5" onMouseLeave={() => { dragging.current = false; }}>
          <div className="inline-block">
            {/* Column headings: numbers on a floor, bays on shelving */}
            <div className="flex gap-1.5 ml-[52px] mb-1.5">
              {Array.from({ length: layout.cols }, (_, c) => (
                <div key={c} style={{ width: size.w }} className="text-center text-[11px] text-muted tabular-nums">{shelving ? `Bay ${c + 1}` : c + 1}</div>
              ))}
            </div>
            {Array.from({ length: layout.rows }, (_, r) => (
              <div key={r} className={`flex items-stretch gap-1.5 ${shelving ? "pb-2 mb-2 border-b-[3px] border-line-3" : "mb-1.5"}`}>
                <div className="w-[46px] flex-shrink-0 flex items-center justify-end pr-1.5 text-[11px] text-muted tabular-nums">
                  {shelving ? levelLabel(r).replace("Level ", "L") : colName(r)}
                </div>
                {Array.from({ length: layout.cols }, (_, c) => cellView(r, c))}
              </div>
            ))}
            {shelving && <div className="ml-[52px] text-[11px] text-faint">Floor</div>}
          </div>
        </div>
      </div>

      {/* The panel: edit the selection, or read the legend */}
      <div className={`${WH_CARD} p-5 xl:sticky xl:top-4`}>
        {sel.size > 0 ? (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[14px] font-semibold text-ink">
                {sel.size === 1 && first ? spotName(layout.kind, layout.rows, first.r, first.c) : `${sel.size} spots`}
              </div>
              <button onClick={() => setSel(new Set())} className="text-[12px] text-muted hover:text-ink-2">Done</button>
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">What is here</label>
              <select value={whatValue ?? "__mixed"} onChange={(e) => {
                const v = e.target.value;
                if (v === "__other") { setOther(""); return; }
                setOther(null);
                if (v !== "__mixed") setWhat(v);
              }} style={WH_INPUT_BG} className={`${WH_INPUT} pr-8`}>
                {whatValue === undefined && <option value="__mixed">Several things</option>}
                <option value="">Nothing</option>
                {choices.map(({ item, sections }) => (
                  <optgroup key={item.id} label={item.name}>
                    {sections.map((s) => <option key={s.id} value={`s|${item.id}|${s.id}`}>{s.name}</option>)}
                  </optgroup>
                ))}
                {legend.filter((l) => l.key.startsWith("l:")).map((l) => <option key={l.key} value={`l|${l.name}`}>{l.name}</option>)}
                {whatValue && whatValue.startsWith("l|") && !legend.some((l) => `l|${l.name}` === whatValue) && <option value={whatValue}>{whatValue.slice(2)}</option>}
                <option value="__other">Something else…</option>
              </select>
              {other !== null && (
                <input autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="Type what is here, then Enter"
                  onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) { setWhat(`l|${other.trim()}`); setOther(null); } if (e.key === "Escape") setOther(null); }}
                  onBlur={() => { if (other.trim()) setWhat(`l|${other.trim()}`); setOther(null); }}
                  style={WH_INPUT_BG} className={`${WH_INPUT} mt-2`} />
              )}
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">How full</label>
              <div className="grid grid-cols-5 gap-1">
                {FILL_SHORT.map((f, q) => (
                  <button key={q} onClick={() => apply((c) => ({ ...c, fill: q, aisle: false }))}
                    className={`h-9 rounded-md border text-[12px] transition-colors ${fillValue === q ? "border-accent bg-accent/10 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                    {q === 0 ? "Empty" : f}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Note</label>
              <input key={[...sel].join(",")} defaultValue={first ? same((c) => c.note) ?? "" : ""} placeholder="e.g. damaged corner, count next week"
                onBlur={(e) => { const v = e.target.value; if (selCells.some((c) => c.note !== v)) apply((c) => ({ ...c, note: v })); }}
                style={WH_INPUT_BG} className={WH_INPUT} />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={() => apply((c) => ({ ...blank(c.r, c.c), aisle: !(same((x) => x.aisle) ?? false) }))} className={WH_BTN_SECONDARY}>
                {same((x) => x.aisle) ? "Not an aisle" : "Mark as aisle"}
              </button>
              <button onClick={() => apply((c) => blank(c.r, c.c))} className={WH_BTN_SECONDARY}>Clear</button>
            </div>
            <p className="text-[11.5px] text-muted">Drag across spots, or shift-click, to set several at once. Esc to finish.</p>
          </div>
        ) : (
          <div>
            <div className="text-[14px] font-semibold text-ink">On this map</div>
            {legend.length === 0 ? (
              <p className="text-[12.5px] text-muted mt-1">Click a spot, or drag across several, then say what is there and how full.</p>
            ) : (
              <div className="mt-2 space-y-0.5">
                {legend.map((l) => (
                  <button key={l.key} onClick={() => setFocus((f) => (f === l.key ? null : l.key))}
                    className={`w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${focus === l.key ? "bg-accent/10" : "hover:bg-surface-2"}`}>
                    <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ background: rgba(teamColor(l.key), 0.9) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-ink truncate">{l.name}</span>
                      {l.product && <span className="block text-[11px] text-muted truncate">{l.product}</span>}
                    </span>
                    <span className="text-[12px] text-ink-2 tabular-nums whitespace-nowrap">{l.spots} {l.spots === 1 ? "spot" : "spots"}{l.full ? ` · ${l.full} full` : ""}</span>
                  </button>
                ))}
                {focus && <button onClick={() => setFocus(null)} className="text-[12px] text-accent hover:text-accent-hover mt-1 px-2">Show everything</button>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LayoutForm({ initial, onCancel, onSaved }: { initial: WarehouseLayout | null; onCancel: () => void; onSaved: (l: WarehouseLayout) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<WarehouseLayout["kind"]>(initial?.kind ?? "pallets");
  const [rows, setRows] = useState(initial?.rows ?? 4);
  const [cols, setCols] = useState(initial?.cols ?? 8);
  const [busy, setBusy] = useState(false);
  const lost = initial ? initial.cells.filter((c) => c.r >= rows || c.c >= cols).length : 0;
  const save = async () => {
    setBusy(true);
    try {
      const l = await api.saveWarehouseLayout({ id: initial?.id ?? null, name: name.trim(), kind, rows, cols, cells: initial?.cells ?? [], notes: initial?.notes ?? "" });
      onSaved(l);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="max-w-[560px]">
      <h3 className="text-[16px] font-semibold text-ink mb-4">{initial ? "Name and size" : "Add a map"}</h3>
      <div className={`${WH_CARD} p-5 space-y-4`}>
        <div>
          <label className="block text-[12px] text-muted mb-1.5">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Floor, Rack A, Back room" style={WH_INPUT_BG} className={WH_INPUT} autoFocus />
        </div>
        <div>
          <label className="block text-[12px] text-muted mb-1.5">What it is</label>
          <Seg size="md" value={kind} onChange={setKind} options={[{ key: "pallets", label: "Pallets on the floor" }, { key: "shelving", label: "Shelving" }]} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[12px] text-muted mb-1.5">{kind === "shelving" ? "Bays across" : "Spots in a row"}</label>
            <NumberInput integer value={cols || ""} onValue={(n) => setCols(Math.max(0, Math.min(60, n)))} style={WH_INPUT_BG} className={`${WH_INPUT} tabular-nums`} />
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">{kind === "shelving" ? "Levels high" : "Rows"}</label>
            <NumberInput integer value={rows || ""} onValue={(n) => setRows(Math.max(0, Math.min(60, n)))} style={WH_INPUT_BG} className={`${WH_INPUT} tabular-nums`} />
          </div>
        </div>
        {lost > 0 && <p className="text-[12.5px] text-warning-ink">{lost} marked {lost === 1 ? "spot falls" : "spots fall"} outside the new size and will be dropped.</p>}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={busy || !name.trim() || rows < 1 || cols < 1} className={WH_BTN_PRIMARY}>{initial ? "Save" : "Add map"}</button>
      </div>
    </div>
  );
}
