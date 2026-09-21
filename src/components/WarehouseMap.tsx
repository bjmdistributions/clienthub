// The warehouse map (R-330, R-332, R-333): a floor of pallet spots or a run of shelving, drawn
// as a grid, each spot saying what sits there and how full it is. Rows can differ in length
// and carry a title; a floor has walls with doors in them and can hold shelves among its
// pallets, each shelf with its own levels; spots are coloured by how full they are (or by
// team) and show a short name when one is set. The view turns and flips without changing
// the map. Click a spot (or drag across several, shift-click for a block, ctrl-click to add
// one), a wall to add a door, and set it in the panel beside the grid. Changes save on their
// own a moment after the last edit, and are cleaned by warehouse_core::clean_layout, so the
// phone draws the same map.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArchiveRestore, FlipHorizontal, LayoutGrid, Pencil, Plus, RotateCw, Rows3, StickyNote, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import {
  DOOR_KINDS, FILL_LABELS, FILL_SHORT, SHELF_MAX, cellKey, colName, doorSpots, doorWhere, emptyShape, fillBucket, layoutSummary, mapView,
  removeRow, rowLength, spotKey, spotName, wallAt, wallLength,
  type Door, type LayoutCell, type LayoutShape, type ShelfLevel, type WarehouseItem, type WarehouseLayout,
} from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import { Seg } from "./WarehouseProduct";
import { FILL_COLORS, WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, newId, rgba, teamColor } from "./warehouseUi";

const blank = (r: number, c: number): LayoutCell => ({ r, c, item_id: "", section_id: "", label: "", fill: 0, note: "", aisle: false });
const blankLevel = (): ShelfLevel => ({ item_id: "", section_id: "", label: "", fill: 0 });
const shapeOf = (l: WarehouseLayout): LayoutShape => ({ ...emptyShape(), ...(l.shape || {}) });
const DOOR_SHORT: Record<Door["kind"], string> = { garage: "Garage", dock: "Dock", door: "Door" };
const ICON_BTN = "inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-8 rounded-lg text-[12.5px] transition-colors";

// Per computer, not per map: how each map is turned, and what the colours mean.
const VIEW_KEY = "warehouse_map_view";
const COLOR_KEY = "warehouse_map_color";
type View = { rot: number; flip: boolean };
function readView(id: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")[id];
    return v ? { rot: Number(v.rot) || 0, flip: !!v.flip } : { rot: 0, flip: false };
  } catch { return { rot: 0, flip: false }; }
}
function writeView(id: string, v: View) {
  try {
    const all = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    all[id] = v;
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

export default function WarehouseMap({ items }: { items: WarehouseItem[] }) {
  const [layouts, setLayouts] = useState<WarehouseLayout[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WarehouseLayout | "new" | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  // Bumped when a map changes under the editor (its form, or another device) so it redraws.
  const [rev, setRev] = useState(0);
  const dirty = useRef(false);
  const known = useRef<Record<string, string>>({});

  const load = useCallback(() => {
    if (dirty.current) return; // never pull a map out from under an edit that has not saved yet
    api.listWarehouseLayouts().then((ls) => {
      if (ls.some((l) => known.current[l.id] && known.current[l.id] !== l.updated_at)) setRev((r) => r + 1);
      for (const l of ls) known.current[l.id] = l.updated_at;
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
  const removed = (layouts || []).filter((l) => l.archived);
  const active = (layouts || []).find((l) => l.id === activeId) || null;
  const put = useCallback((l: WarehouseLayout) => {
    known.current[l.id] = l.updated_at;
    setLayouts((prev) => prev ? (prev.some((x) => x.id === l.id) ? prev.map((x) => (x.id === l.id ? l : x)) : [...prev, l]) : [l]);
  }, []);

  const setRemoved = async (l: WarehouseLayout, archived: boolean) => {
    try {
      await api.archiveWarehouseLayout(l.id, archived);
      put({ ...l, archived });
      toast(archived ? `${l.name} removed. It stays under Removed maps.` : `${l.name} is back`);
      if (archived) setActiveId(live.find((x) => x.id !== l.id)?.id ?? null);
    } catch (e) { toast(String(e), "error"); }
  };

  if (editing) {
    return <LayoutForm initial={editing === "new" ? null : editing} onCancel={() => setEditing(null)}
      onSaved={(l) => { put(l); setActiveId(l.id); setRev((r) => r + 1); setEditing(null); }} />;
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
        {removed.length > 0 && (
          <button onClick={() => setShowRemoved((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 ml-1">{showRemoved ? "Hide" : "Removed maps"} ({removed.length})</button>
        )}
        {showRemoved && removed.map((l) => (
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
        <MapEditor key={`${active.id}:${rev}`} layout={active} items={items} dirty={dirty} onSaved={put}
          onEdit={(snap) => setEditing(snap)} onRemove={() => setRemoved(active, true)} onRestore={() => setRemoved(active, false)} />
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

type Saved = { cells: Record<string, LayoutCell>; shape: LayoutShape };

function MapEditor({ layout, items, dirty, onSaved, onEdit, onRemove, onRestore }: {
  layout: WarehouseLayout; items: WarehouseItem[]; dirty: React.MutableRefObject<boolean>;
  onSaved: (l: WarehouseLayout) => void; onEdit: (snapshot: WarehouseLayout) => void; onRemove: () => void; onRestore: () => void;
}) {
  const [cells, setCells] = useState<Record<string, LayoutCell>>(() => Object.fromEntries(layout.cells.map((c) => [spotKey(c.r, c.c), c])));
  const [shape, setShape] = useState<LayoutShape>(() => shapeOf(layout));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [wall, setWall] = useState<{ side: Door["side"]; pos: number } | null>(null);
  const [doorId, setDoorId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [other, setOther] = useState<{ at: "spot" | number; text: string } | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [view, setViewState] = useState<View>(() => readView(layout.id));
  const [colorBy, setColorByState] = useState<"fill" | "team">(() => { try { return localStorage.getItem(COLOR_KEY) === "team" ? "team" : "fill"; } catch { return "fill"; } });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const anchor = useRef<{ r: number; c: number } | null>(null);
  const dragging = useRef(false);
  const choices = useChoices(items);
  const floor = layout.kind === "pallets";
  const shelving = !floor;

  const setView = (v: View) => { setViewState(v); writeView(layout.id, v); };
  const setColorBy = (v: "fill" | "team") => { setColorByState(v); try { localStorage.setItem(COLOR_KEY, v); } catch { /* ignore */ } };

  // Autosave a moment after the last change — and at once if the map is left before then,
  // so switching maps mid-edit never drops the last spot marked.
  const pending = useRef<Saved | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = (next: Saved) => ({
    id: layout.id, name: layout.name, kind: layout.kind, rows: layout.rows, cols: layout.cols,
    cells: Object.values(next.cells), shape: next.shape, notes: layout.notes,
  });
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const send = useCallback(async () => {
    const next = pending.current;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!next) return;
    pending.current = null;
    setStatus("saving");
    try {
      onSavedRef.current(await api.saveWarehouseLayout(bodyRef.current(next)));
      setStatus(pending.current ? "unsaved" : "saved");
    } catch (e) { toast(`The map did not save: ${e}`, "error"); setStatus("unsaved"); }
    finally { if (!pending.current) dirty.current = false; }
  }, [dirty]);
  const commit = (nextCells: Record<string, LayoutCell>, nextShape: LayoutShape) => {
    setCells(nextCells);
    setShape(nextShape);
    dirty.current = true;
    pending.current = { cells: nextCells, shape: nextShape };
    setStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void send(); }, 700);
  };
  useEffect(() => () => { void send(); }, [send]);

  const clearAll = () => { setSel(new Set()); setWall(null); setDoorId(null); setOther(null); };
  useEffect(() => {
    const up = () => { dragging.current = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { clearAll(); setFocus(null); } };
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mouseup", up); window.removeEventListener("keydown", esc); };
  }, []);

  const lenOf = (r: number) => rowLength({ cols: layout.cols, shape }, r);
  const rect = (a: { r: number; c: number }, b: { r: number; c: number }) => {
    const out = new Set<string>();
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++)
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) if (c < lenOf(r)) out.add(spotKey(r, c));
    return out;
  };
  const down = (r: number, c: number, e: React.MouseEvent) => {
    setWall(null); setDoorId(null); setOther(null);
    if (e.shiftKey && anchor.current) { setSel(rect(anchor.current, { r, c })); return; }
    if (e.ctrlKey || e.metaKey) {
      setSel((p) => { const n = new Set(p); if (n.has(spotKey(r, c))) n.delete(spotKey(r, c)); else n.add(spotKey(r, c)); return n; });
      anchor.current = { r, c };
      return;
    }
    anchor.current = { r, c };
    dragging.current = true;
    setSel(new Set([spotKey(r, c)]));
  };
  const enter = (r: number, c: number) => { if (dragging.current && anchor.current) setSel(rect(anchor.current, { r, c })); };

  // ---- Changing spots, shelves and doors ----
  const apply = (patch: (c: LayoutCell) => LayoutCell) => {
    const next = { ...cells };
    for (const k of sel) {
      if (shape.shelves[k]) continue; // a shelf keeps its levels; select it alone to change them
      const [r, c] = k.split(":").map(Number);
      next[k] = patch(next[k] || blank(r, c));
    }
    commit(next, shape);
  };
  const whatPatch = <T extends { item_id: string; section_id: string; label: string; fill: number }>(v: string, x: T): T => {
    if (!v) return { ...x, item_id: "", section_id: "", label: "" };
    const [kind, a, b] = v.split("|");
    const base = { ...x, fill: x.fill || 4 }; // marking a spot with a team means something is on it
    return kind === "s" ? { ...base, item_id: a, section_id: b, label: "" } : { ...base, item_id: "", section_id: "", label: a };
  };
  const setWhat = (v: string) => apply((c) => ({ ...whatPatch(v, c), aisle: v ? false : c.aisle }));

  const setShelves = (fn: (s: LayoutShape["shelves"]) => void, nextCells = cells) => {
    const shelves = JSON.parse(JSON.stringify(shape.shelves)) as LayoutShape["shelves"];
    fn(shelves);
    commit(nextCells, { ...shape, shelves });
  };
  const makeShelves = () => {
    const next = { ...cells };
    setShelves((sh) => {
      for (const k of sel) {
        if (sh[k]) continue;
        const cell = next[k];
        const bottom = cell && !cell.aisle ? { item_id: cell.item_id, section_id: cell.section_id, label: cell.label, fill: cell.fill } : blankLevel();
        sh[k] = { levels: [bottom, blankLevel(), blankLevel()], note: cell?.note || "" };
        delete next[k];
      }
    }, next);
  };
  const unShelf = (k: string) => {
    const sh = shape.shelves[k];
    if (!sh) return;
    const [r, c] = k.split(":").map(Number);
    const lv = sh.levels[0] || blankLevel();
    const next = { ...cells, [k]: { ...blank(r, c), ...lv, note: sh.note } };
    setShelves((s) => { delete s[k]; }, next);
  };
  const setLevel = (k: string, i: number, fn: (l: ShelfLevel) => ShelfLevel) => setShelves((s) => { s[k].levels[i] = fn(s[k].levels[i]); });

  const doors = shape.doors;
  const door = doors.find((d) => d.id === doorId) || null;
  const setDoors = (next: Door[]) => commit(cells, { ...shape, doors: next });
  const addDoor = (kind: Door["kind"]) => {
    if (!wall) return;
    const d: Door = { id: newId(), side: wall.side, at: wall.pos, width: 1, kind, label: "" };
    setDoors([...doors, d]);
    setWall(null);
    setDoorId(d.id);
  };
  // How far a door can reach along its wall without running into the next one.
  const room = (d: Door) => {
    const others = doors.filter((o) => o.id !== d.id && o.side === d.side);
    const before = Math.max(0, ...others.filter((o) => o.at < d.at).map((o) => o.at + o.width));
    const after = Math.min(wallLength(layout, d.side), ...others.filter((o) => o.at > d.at).map((o) => o.at));
    return { before, after };
  };
  const patchDoor = (d: Door, p: Partial<Door>) => setDoors(doors.map((o) => (o.id === d.id ? { ...o, ...p } : o)));

  // ---- Reading the map ----
  const nameOf = useCallback((c: { item_id: string; section_id: string; label: string }) => {
    if (c.section_id) {
      const it = items.find((i) => i.id === c.item_id);
      const s = it?.sections.find((x) => x.id === c.section_id);
      return s ? s.name : "Removed team";
    }
    return c.label;
  }, [items]);
  const shownName = (c: { item_id: string; section_id: string; label: string }) => shape.short_names[cellKey(c)] || nameOf(c);
  const productOf = (c: { item_id: string; section_id: string }) => (c.section_id ? items.find((i) => i.id === c.item_id)?.name ?? "" : "");
  const colorOf = (key: string, fill: number) => (colorBy === "team" ? (key ? teamColor(key) : "") : key || fill > 0 ? FILL_COLORS[fillBucket(fill)] : "");

  const selKeys = [...sel];
  const selCells = selKeys.filter((k) => !shape.shelves[k]).map((k) => { const [r, c] = k.split(":").map(Number); return cells[k] || blank(r, c); });
  const shelfSel = selKeys.length === 1 && shape.shelves[selKeys[0]] ? selKeys[0] : null;
  const first = selCells[0];
  const same = <T,>(f: (c: LayoutCell) => T) => (first && selCells.every((c) => f(c) === f(first)) ? f(first) : undefined);
  const whatOf = (c: { item_id: string; section_id: string; label: string }) => (c.section_id ? `s|${c.item_id}|${c.section_id}` : c.label ? `l|${c.label}` : "");
  const whatValue = first ? same(whatOf) : "";
  const fillValue = first ? same((c) => c.fill) : undefined;
  const all = Object.values(cells);
  const summary = layoutSummary({ rows: layout.rows, cols: layout.cols, cells: all, shape });

  // The legend: what is on this map, biggest first — pallet spots and shelf levels alike.
  const legend = useMemo(() => {
    const m = new Map<string, { key: string; name: string; product: string; spots: number; full: number }>();
    const count = (x: { item_id: string; section_id: string; label: string; fill: number }) => {
      const k = cellKey(x);
      if (!k) return;
      const e = m.get(k) || { key: k, name: nameOf(x), product: productOf(x), spots: 0, full: 0 };
      e.spots += 1;
      if (x.fill >= 4) e.full += 1;
      m.set(k, e);
    };
    for (const c of all) if (!c.aisle && !shape.shelves[spotKey(c.r, c.c)] && c.c < lenOf(c.r)) count(c);
    for (const sh of Object.values(shape.shelves)) for (const lv of sh.levels) count(lv);
    return [...m.values()].sort((a, b) => b.spots - a.spots || a.name.localeCompare(b.name));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, shape, items]);
  const labels = legend.filter((l) => l.key.startsWith("l:"));

  // ---- Drawing: a grid, turned and flipped, with the walls as a thin outer ring on a floor ----
  const ring: 0 | 1 = floor ? 1 : 0;
  const v = mapView(layout.rows, layout.cols, ring, floor ? view.rot : 0, view.flip);
  const S = floor ? { w: 64, h: 64 } : { w: 78, h: 58 };
  const WALL = 18, GAP = 6;
  const outside = (r: number, c: number) => r < 0 || r >= layout.rows || c < 0 || c >= layout.cols;
  const wallCol = (x: number) => { const [r, c] = v.back(ring, x); return ring === 1 && (v.turned ? r < 0 || r >= layout.rows : c < 0 || c >= layout.cols); };
  const wallRow = (y: number) => { const [r, c] = v.back(y, ring); return ring === 1 && (v.turned ? c < 0 || c >= layout.cols : r < 0 || r >= layout.rows); };
  const rowHead = (r: number) => (floor ? colName(r) : `L${layout.rows - r}`);
  const colHead = (c: number) => (floor ? String(c + 1) : `Bay ${c + 1}`);
  const titled = shape.row_names.some((n) => n);
  const headW = v.turned ? 34 : titled ? 118 : shelving ? 40 : 30;
  const headH = v.turned ? (titled ? 34 : 20) : 20;
  const tracks = (n: number, isWall: (i: number) => boolean, size: number) =>
    Array.from({ length: n }, (_, i) => `${isWall(i) ? WALL : size}px`).join(" ");
  const grid: CSSProperties = {
    display: "grid", gap: GAP,
    gridTemplateColumns: `${headW}px ${tracks(v.dw, wallCol, S.w)}`,
    gridTemplateRows: `${headH}px ${tracks(v.dh, wallRow, S.h)}`,
  };
  const place = (r: number, c: number): CSSProperties => { const [y, x] = v.at(r, c); return { gridRow: y + 2, gridColumn: x + 2 }; };
  const span = (spots: [number, number][]): CSSProperties => {
    const ps = spots.map(([r, c]) => v.at(r, c));
    const ys = ps.map((p) => p[0]), xs = ps.map((p) => p[1]);
    return { gridRow: `${Math.min(...ys) + 2} / ${Math.max(...ys) + 3}`, gridColumn: `${Math.min(...xs) + 2} / ${Math.max(...xs) + 3}` };
  };

  const pillTint = (b: "full" | "partial" | "empty"): CSSProperties | undefined =>
    colorBy === "fill" ? { background: rgba(FILL_COLORS[b], 0.14), borderColor: rgba(FILL_COLORS[b], 0.45) } : undefined;

  const spotView = (r: number, c: number) => {
    const k = spotKey(r, c);
    const cell = cells[k];
    const selected = sel.has(k);
    const ck = cell ? cellKey(cell) : "";
    const dim = focus !== null && ck !== focus;
    const color = cell && !cell.aisle ? colorOf(ck, cell.fill) : "";
    const name = cell && !cell.aisle ? shownName(cell) : "";
    const full = cell ? nameOf(cell) : "";
    const title = `${spotName(layout.kind, layout.rows, r, c)}${cell?.aisle ? " · aisle" : full ? ` · ${full} · ${FILL_LABELS[cell!.fill]}` : ""}${cell?.note ? ` · ${cell.note}` : ""}`;
    return (
      <button key={k} title={title} onMouseDown={(e) => { e.preventDefault(); down(r, c, e); }} onMouseEnter={() => enter(r, c)}
        style={{ ...place(r, c), opacity: dim ? 0.25 : 1,
          backgroundColor: color && colorBy === "fill" ? rgba(color, 0.1) : undefined,
          backgroundImage: cell?.aisle ? "repeating-linear-gradient(135deg, rgb(var(--c-line-3)) 0 1px, transparent 1px 7px)" : undefined }}
        className={`relative rounded-md overflow-hidden text-left transition-[opacity,box-shadow] duration-[130ms] select-none
          ${cell?.aisle ? "border border-transparent" : ck || color ? "bg-surface border border-line" : "border border-dashed border-line-3 hover:border-line"}
          ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-bg z-10" : ""}`}>
        {color && cell!.fill > 0 && (
          <div className="absolute inset-x-0 bottom-0" style={{ height: `${(cell!.fill / 4) * 100}%`, background: rgba(color, colorBy === "fill" ? 0.3 : 0.22), borderTop: `2px solid ${rgba(color, 0.9)}` }} />
        )}
        {color && <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: rgba(color, 0.9) }} />}
        {/* Pinned to the top: a button centres its content, which put the name on the half-full line. */}
        <div className="absolute left-0 right-1 top-0 pl-1.5 pr-0.5 pt-1 text-[10px] leading-tight font-medium text-ink line-clamp-2 break-words">{name}</div>
        {ck && !cell!.aisle && <div className="absolute right-1 bottom-0.5 text-[9.5px] font-medium text-ink-2 tabular-nums">{FILL_SHORT[cell!.fill]}</div>}
        {cell?.note && <StickyNote size={9} className="absolute right-1 top-1 text-muted" aria-hidden />}
      </button>
    );
  };

  const shelfView = (r: number, c: number) => {
    const k = spotKey(r, c);
    const sh = shape.shelves[k];
    const selected = sel.has(k);
    const dim = focus !== null && !sh.levels.some((lv) => cellKey(lv) === focus);
    const title = `Shelf ${spotName(layout.kind, layout.rows, r, c)} · ` +
      sh.levels.map((lv, i) => `level ${i + 1}: ${nameOf(lv) || "nothing"}${cellKey(lv) ? ` (${FILL_LABELS[lv.fill]})` : ""}`).join(" · ") + (sh.note ? ` · ${sh.note}` : "");
    return (
      <button key={k} title={title} onMouseDown={(e) => { e.preventDefault(); down(r, c, e); }} onMouseEnter={() => enter(r, c)}
        style={{ ...place(r, c), opacity: dim ? 0.25 : 1 }}
        className={`relative rounded-md overflow-hidden text-left select-none bg-surface border-2 border-ink-2/60 flex flex-col-reverse transition-[opacity,box-shadow] duration-[130ms]
          ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-bg z-10" : ""}`}>
        {sh.levels.map((lv, i) => {
          const lk = cellKey(lv);
          const color = colorOf(lk, lv.fill);
          return (
            <div key={i} className={`relative flex-1 min-h-0 flex items-center ${i > 0 ? "border-b border-line-3" : ""}`}>
              {color && lv.fill > 0 && <div className="absolute inset-y-0 left-0" style={{ width: `${(lv.fill / 4) * 100}%`, background: rgba(color, 0.28) }} />}
              {color && <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: rgba(color, 0.9) }} />}
              <span className="relative block w-full pl-1.5 pr-1 text-[9.5px] leading-none font-medium text-ink truncate">{lk ? shownName(lv) : ""}</span>
            </div>
          );
        })}
        {sh.note && <StickyNote size={9} className="absolute right-1 top-1 text-muted" aria-hidden />}
      </button>
    );
  };

  // The walls: one continuous line per side, clickable spot by spot, and the doors over them.
  const walls = !floor ? null : (
    <>
      {(["top", "right", "bottom", "left"] as const).map((side) => {
        const ends: [number, number][] = side === "top" ? [[-1, -1], [-1, layout.cols]] : side === "bottom" ? [[layout.rows, -1], [layout.rows, layout.cols]]
          : side === "left" ? [[-1, -1], [layout.rows, -1]] : [[-1, layout.cols], [layout.rows, layout.cols]];
        const st = span(ends);
        const across = v.at(...ends[0])[0] === v.at(...ends[1])[0]; // both ends on one drawn row: the wall runs across
        return (
          <div key={side} style={st} className="relative pointer-events-none">
            <div className={`absolute bg-muted/45 rounded-full ${across ? "left-0 right-0 top-1/2 -translate-y-1/2 h-[4px]" : "top-0 bottom-0 left-1/2 -translate-x-1/2 w-[4px]"}`} />
          </div>
        );
      })}
      {Array.from({ length: layout.rows + 2 }, (_, i) => i - 1).flatMap((r) => Array.from({ length: layout.cols + 2 }, (_, j) => j - 1).map((c) => {
        if (!outside(r, c)) return null;
        const w = wallAt(layout, r, c);
        if (!w) return null;
        const on = wall && wall.side === w.side && wall.pos === w.pos;
        return (
          <button key={`w${r}:${c}`} style={place(r, c)} title={`${w.side === "top" ? "Row A wall" : w.side === "bottom" ? `Row ${colName(layout.rows - 1)} wall` : w.side === "left" ? "Spot 1 end" : "Far end"} — click to add a door`}
            onClick={() => { setSel(new Set()); setDoorId(null); setOther(null); setWall(w); }}
            className={`rounded-[4px] transition-colors ${on ? "bg-accent/30 ring-2 ring-accent" : "hover:bg-accent/15"}`} aria-label="Wall" />
        );
      }))}
      {doors.map((d) => {
        const st = span(doorSpots(layout, d));
        const [y0] = v.at(...doorSpots(layout, d)[0]);
        const upright = !wallRow(y0);
        return (
          <button key={d.id} style={{ ...st, writingMode: upright ? "vertical-rl" : undefined }} title={`${DOOR_KINDS[d.kind]}${d.label ? ` · ${d.label}` : ""} — ${doorWhere(layout, d)}`}
            onClick={() => { setSel(new Set()); setWall(null); setOther(null); setDoorId(d.id); }}
            className={`z-10 rounded-[4px] bg-ink text-surface text-[10px] font-medium leading-none flex items-center justify-center overflow-hidden whitespace-nowrap px-1 ${doorId === d.id ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : ""}`}>
            <span className="truncate">{DOOR_SHORT[d.kind]}{d.label ? ` · ${d.label}` : ""}</span>
          </button>
        );
      })}
    </>
  );

  // ---- The panel's pieces ----
  const whatSelect = (value: string | undefined, onPick: (v: string) => void, at: "spot" | number, compact = false) => (
    <>
      <select value={value ?? "__mixed"} onChange={(e) => {
        const val = e.target.value;
        if (val === "__other") { setOther({ at, text: "" }); return; }
        setOther(null);
        if (val !== "__mixed") onPick(val);
      }} style={WH_INPUT_BG} className={`${WH_INPUT} pr-8 ${compact ? "h-8 text-[12.5px]" : ""}`}>
        {value === undefined && <option value="__mixed">Several things</option>}
        <option value="">Nothing</option>
        {choices.map(({ item, sections }) => (
          <optgroup key={item.id} label={item.name}>
            {sections.map((s) => <option key={s.id} value={`s|${item.id}|${s.id}`}>{s.name}</option>)}
          </optgroup>
        ))}
        {labels.map((l) => <option key={l.key} value={`l|${l.name}`}>{l.name}</option>)}
        {value && value.startsWith("l|") && !labels.some((l) => `l|${l.name}` === value) && <option value={value}>{value.slice(2)}</option>}
        <option value="__other">Something else…</option>
      </select>
      {other && other.at === at && (
        <input autoFocus value={other.text} onChange={(e) => setOther({ at, text: e.target.value })} placeholder="Type what is here, then Enter"
          onKeyDown={(e) => { if (e.key === "Enter" && other.text.trim()) { onPick(`l|${other.text.trim()}`); setOther(null); } if (e.key === "Escape") setOther(null); }}
          onBlur={() => { if (other.text.trim()) onPick(`l|${other.text.trim()}`); setOther(null); }}
          style={WH_INPUT_BG} className={`${WH_INPUT} mt-2`} />
      )}
    </>
  );
  const fillButtons = (value: number | undefined, onPick: (q: number) => void, small = false) => (
    <div className="grid grid-cols-5 gap-1">
      {FILL_SHORT.map((f, q) => {
        const on = value === q;
        const tint = colorBy === "fill" && q > 0 ? FILL_COLORS[fillBucket(q)] : "";
        return (
          <button key={q} onClick={() => onPick(q)} style={on && tint ? { background: rgba(tint, 0.16), borderColor: rgba(tint, 0.7) } : undefined}
            className={`${small ? "h-7 text-[11.5px]" : "h-9 text-[12px]"} rounded-md border transition-colors ${on ? "border-accent bg-accent/10 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
            {f}
          </button>
        );
      })}
    </div>
  );

  const doorPanel = () => {
    if (door) {
      const { before, after } = room(door);
      return (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[14px] font-semibold text-ink">{DOOR_KINDS[door.kind]}</div>
            <button onClick={clearAll} className="text-[12px] text-muted hover:text-ink-2">Done</button>
          </div>
          <div className="text-[12px] text-muted -mt-2">{doorWhere(layout, door)}</div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">Kind</label>
            <Seg value={door.kind} onChange={(k) => patchDoor(door, { kind: k })} options={[{ key: "garage", label: "Garage" }, { key: "dock", label: "Dock" }, { key: "door", label: "Door" }]} />
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">Name</label>
            <input key={door.id} defaultValue={door.label} placeholder="e.g. Dock 1" maxLength={40}
              onBlur={(e) => { if (e.target.value.trim() !== door.label) patchDoor(door, { label: e.target.value.trim() }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              style={WH_INPUT_BG} className={WH_INPUT} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] text-muted mb-1.5">How wide</label>
              <div className="flex items-center gap-1.5">
                <button onClick={() => patchDoor(door, { width: Math.max(1, door.width - 1) })} disabled={door.width <= 1} className="w-8 h-8 rounded-md border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-35" aria-label="Narrower">−</button>
                <span className="w-8 text-center text-[13px] tabular-nums text-ink">{door.width}</span>
                <button onClick={() => patchDoor(door, { width: door.width + 1 })} disabled={door.at + door.width >= after} className="w-8 h-8 rounded-md border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-35" aria-label="Wider">+</button>
              </div>
            </div>
            <div>
              <label className="block text-[12px] text-muted mb-1.5">Move along the wall</label>
              <div className="flex items-center gap-1.5">
                <button onClick={() => patchDoor(door, { at: door.at - 1 })} disabled={door.at <= before} className="w-8 h-8 rounded-md border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-35" aria-label="Move back">−</button>
                <button onClick={() => patchDoor(door, { at: door.at + 1 })} disabled={door.at + door.width >= after} className="w-8 h-8 rounded-md border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-35" aria-label="Move on">+</button>
              </div>
            </div>
          </div>
          <button onClick={() => { setDoors(doors.filter((d) => d.id !== door.id)); setDoorId(null); }} className={WH_BTN_SECONDARY}><Trash2 size={13} /> Remove door</button>
        </div>
      );
    }
    const w = wall!;
    const where = doorWhere(layout, { id: "", side: w.side, at: w.pos, width: 1, kind: "door", label: "" });
    const taken = doors.some((d) => d.side === w.side && w.pos >= d.at && w.pos < d.at + d.width);
    return (
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[14px] font-semibold text-ink">Wall</div>
          <button onClick={clearAll} className="text-[12px] text-muted hover:text-ink-2">Done</button>
        </div>
        <div className="text-[12px] text-muted -mt-2">{where}</div>
        {taken ? <p className="text-[12.5px] text-muted">A door is already here.</p> : (
          <>
            <p className="text-[12.5px] text-ink-2">Add a door here:</p>
            <div className="flex flex-wrap gap-2">
              {(["garage", "dock", "door"] as const).map((k) => <button key={k} onClick={() => addDoor(k)} className={WH_BTN_SECONDARY}><Plus size={13} /> {DOOR_KINDS[k]}</button>)}
            </div>
          </>
        )}
      </div>
    );
  };

  const shelfPanel = (k: string) => {
    const sh = shape.shelves[k];
    const [r, c] = k.split(":").map(Number);
    const n = sh.levels.length;
    return (
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[14px] font-semibold text-ink">Shelf · {spotName(layout.kind, layout.rows, r, c)}</div>
          <button onClick={clearAll} className="text-[12px] text-muted hover:text-ink-2">Done</button>
        </div>
        <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-0.5">
          {sh.levels.map((lv, i) => ({ lv, i })).reverse().map(({ lv, i }) => (
            <div key={i} className="rounded-lg border border-line p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink">Level {i + 1}{i === 0 ? " · bottom" : i === n - 1 ? " · top" : ""}</span>
                {n > 1 && <button onClick={() => setShelves((s) => { s[k].levels.splice(i, 1); })} className="text-muted hover:text-ink-2" title="Remove this level" aria-label={`Remove level ${i + 1}`}><X size={13} /></button>}
              </div>
              {whatSelect(whatOf(lv), (val) => setLevel(k, i, (l) => whatPatch(val, l)), i, true)}
              {fillButtons(lv.fill, (q) => setLevel(k, i, (l) => ({ ...l, fill: q })), true)}
            </div>
          ))}
        </div>
        {n < SHELF_MAX && <button onClick={() => setShelves((s) => { s[k].levels.push(blankLevel()); })} className={WH_BTN_SECONDARY}><Plus size={13} /> Add a level on top</button>}
        <div>
          <label className="block text-[12px] text-muted mb-1.5">Note</label>
          <input key={k} defaultValue={sh.note} placeholder="e.g. top shelf is returns"
            onBlur={(e) => { if (e.target.value !== sh.note) { const val = e.target.value; setShelves((s) => { s[k].note = val; }); } }}
            style={WH_INPUT_BG} className={WH_INPUT} />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => unShelf(k)} className={WH_BTN_SECONDARY}>Make it a pallet spot</button>
          <button onClick={() => setShelves((s) => { s[k] = { levels: s[k].levels.map(() => blankLevel()), note: "" }; })} className={WH_BTN_SECONDARY}>Clear</button>
        </div>
      </div>
    );
  };

  const spotPanel = () => {
    const shelvesIn = selKeys.filter((k) => shape.shelves[k]).length;
    return (
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[14px] font-semibold text-ink">
            {sel.size === 1 && first ? spotName(layout.kind, layout.rows, first.r, first.c) : `${sel.size} spots`}
          </div>
          <button onClick={clearAll} className="text-[12px] text-muted hover:text-ink-2">Done</button>
        </div>
        {shelvesIn > 0 && <p className="text-[12px] text-muted -mt-2">{shelvesIn === 1 ? "The shelf" : `The ${shelvesIn} shelves`} in this selection keep their levels — click a shelf on its own to change them.</p>}
        {selCells.length > 0 && <>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">What is here</label>
            {whatSelect(whatValue, setWhat, "spot")}
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">How full</label>
            {fillButtons(fillValue, (q) => apply((c) => ({ ...c, fill: q, aisle: false })))}
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">Note</label>
            <input key={selKeys.join(",")} defaultValue={same((c) => c.note) ?? ""} placeholder="e.g. damaged corner, count next week"
              onBlur={(e) => { const val = e.target.value; if (selCells.some((c) => c.note !== val)) apply((c) => ({ ...c, note: val })); }}
              style={WH_INPUT_BG} className={WH_INPUT} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {floor && <button onClick={makeShelves} className={WH_BTN_SECONDARY}><Rows3 size={13} /> Make it a shelf</button>}
            <button onClick={() => apply((c) => ({ ...blank(c.r, c.c), aisle: !(same((x) => x.aisle) ?? false) }))} className={WH_BTN_SECONDARY}>
              {same((x) => x.aisle) ? "Not an aisle" : "Mark as aisle"}
            </button>
            <button onClick={() => apply((c) => blank(c.r, c.c))} className={WH_BTN_SECONDARY}>Clear</button>
          </div>
        </>}
        <p className="text-[11.5px] text-muted">Drag across spots, or shift-click, to set several at once. Esc to finish.</p>
      </div>
    );
  };

  const legendPanel = () => (
    <div>
      <div className="text-[14px] font-semibold text-ink">On this map</div>
      {legend.length === 0 ? (
        <p className="text-[12.5px] text-muted mt-1">Click a spot, or drag across several, then say what is there and how full.{floor ? " Click a wall to add a door." : ""}</p>
      ) : (
        <div className="mt-2 space-y-0.5">
          {legend.map((l) => (
            <div key={l.key} className={`flex items-center gap-2 rounded-md pl-2 pr-1 py-1 transition-colors ${focus === l.key ? "bg-accent/10" : "hover:bg-surface-2"}`}>
              <button onClick={() => setFocus((f) => (f === l.key ? null : l.key))} className="min-w-0 flex-1 flex items-center gap-2.5 text-left py-0.5">
                {colorBy === "team" && <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ background: rgba(teamColor(l.key), 0.9) }} />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink truncate">{l.name}</span>
                  <span className="block text-[11px] text-muted truncate">{[l.product, `${l.spots} ${l.spots === 1 ? "spot" : "spots"}${l.full ? ` · ${l.full} full` : ""}`].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
              <input key={`${l.key}:${shape.short_names[l.key] || ""}`} defaultValue={shape.short_names[l.key] || ""} maxLength={8} placeholder="Short"
                title={`A short name for ${l.name}, shown on the map`} aria-label={`Short name for ${l.name}`}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val === (shape.short_names[l.key] || "")) return;
                  const short_names = { ...shape.short_names };
                  if (val) short_names[l.key] = val; else delete short_names[l.key];
                  commit(cells, { ...shape, short_names });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                style={WH_INPUT_BG} className="w-[62px] flex-shrink-0 border border-line h-7 px-1.5 rounded-md text-[12px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
          ))}
          {focus && <button onClick={() => setFocus(null)} className="text-[12px] text-accent hover:text-accent-hover mt-1 px-2">Show everything</button>}
        </div>
      )}
      {floor && (
        <div className="mt-4 pt-3 border-t border-line-2">
          <div className="text-[13px] font-semibold text-ink">Doors</div>
          {doors.length === 0 ? <p className="text-[12px] text-muted mt-1">Click a wall around the floor to add a garage door, a dock door or a door.</p> : (
            <div className="mt-1.5 space-y-0.5">
              {doors.map((d) => (
                <button key={d.id} onClick={() => setDoorId(d.id)} className="w-full text-left rounded-md px-2 py-1.5 hover:bg-surface-2 transition-colors">
                  <span className="block text-[13px] text-ink">{DOOR_KINDS[d.kind]}{d.label ? ` · ${d.label}` : ""}</span>
                  <span className="block text-[11px] text-muted">{doorWhere(layout, d)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const openForm = async () => { await send(); onEdit({ ...layout, cells: Object.values(cells), shape }); };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
      <div className={`${WH_CARD} overflow-hidden min-w-0`}>
        {layout.archived && (
          <div className="px-5 py-2.5 bg-surface-2 border-b border-line flex items-center justify-between gap-3 text-[12.5px] text-ink-2">
            This map is removed. It is not shown with your maps.
            <button onClick={onRestore} className={WH_BTN_SECONDARY}><ArchiveRestore size={13} /> Bring it back</button>
          </div>
        )}
        <div className="px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink truncate">{layout.name}</div>
            <div className="text-[12px] text-muted">
              {shelving ? `Shelving · ${layout.rows} ${layout.rows === 1 ? "level" : "levels"}` : `Pallet floor · ${layout.rows} ${layout.rows === 1 ? "row" : "rows"}`}
              {shape.row_lengths.length ? ", rows of different lengths" : shelving ? `, ${layout.cols} bays` : ` of ${layout.cols}`}
              <span className="text-faint"> · </span>{status === "saving" ? "Saving…" : status === "unsaved" ? "Saving shortly" : "Saved"}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={openForm} className={WH_BTN_SECONDARY}><Pencil size={13} /> Rows and size</button>
            {!layout.archived && (confirmRemove ? (
              <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
                Remove {layout.name}?
                <button onClick={() => { setConfirmRemove(false); void send().then(onRemove); }} className={WH_BTN_PRIMARY}>Remove</button>
                <button onClick={() => setConfirmRemove(false)} className={WH_BTN_SECONDARY}>Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmRemove(true)} className={WH_BTN_SECONDARY}><Trash2 size={13} /> Remove map</button>
            ))}
          </div>
        </div>
        <div className="px-5 pb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2 text-[12px]">
            {([
              { l: "Spots", v: summary.spots },
              { l: "Full", v: summary.full, b: "full" as const },
              { l: "Partly full", v: summary.partial, b: "partial" as const },
              { l: "Empty", v: summary.empty, b: "empty" as const },
              { l: "Open", v: summary.open },
              ...(summary.shelves ? [{ l: "Shelves", v: summary.shelves }] : []),
            ]).map((x) => (
              <span key={x.l} style={"b" in x && x.b ? pillTint(x.b) : undefined}
                title={x.l === "Empty" ? "Marked with a team, with nothing on it" : x.l === "Open" ? "Nothing marked on the spot" : undefined}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-ink-2">
                {x.l} <span className="font-semibold text-ink tabular-nums">{n0(x.v)}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">Colour</span>
            <Seg value={colorBy} onChange={setColorBy} options={[{ key: "fill", label: "How full" }, { key: "team", label: "Team" }]} />
            {floor && <button onClick={() => setView({ ...view, rot: (view.rot + 1) % 4 })} className={ICON_BTN} title="Turn the map a quarter"><RotateCw size={13} /> Turn</button>}
            <button onClick={() => setView({ ...view, flip: !view.flip })} className={`${ICON_BTN} ${view.flip ? "border-accent bg-accent/10 text-ink" : ""}`} title="Flip left and right"><FlipHorizontal size={13} /> Flip</button>
          </div>
        </div>
        <div className="overflow-auto px-5 pb-5" onMouseLeave={() => { dragging.current = false; }}>
          <div className="inline-block">
            <div style={grid}>
              {/* Headings: row letters (and titles) down the side, spot numbers across — swapped when turned */}
              {Array.from({ length: v.dw }, (_, x) => {
                if (wallCol(x)) return null;
                const [r, c] = v.back(ring, x);
                return (
                  <div key={`h${x}`} style={{ gridRow: 1, gridColumn: x + 2 }} className="self-end text-center text-[11px] text-muted tabular-nums leading-tight min-w-0" title={v.turned ? shape.row_names[r] || undefined : undefined}>
                    {v.turned ? <><div className="font-medium text-ink-2">{rowHead(r)}</div>{shape.row_names[r] && <div className="truncate text-[10px]">{shape.row_names[r]}</div>}</> : colHead(c)}
                  </div>
                );
              })}
              {Array.from({ length: v.dh }, (_, y) => {
                if (wallRow(y)) return null;
                const [r, c] = v.back(y, ring);
                return (
                  <div key={`s${y}`} style={{ gridRow: y + 2, gridColumn: 1 }} className="flex items-center justify-end gap-1.5 pr-0.5 text-[11px] text-muted tabular-nums min-w-0">
                    {v.turned ? colHead(c) : <>
                      {shape.row_names[r] && <span className="truncate text-[10.5px]" title={shape.row_names[r]}>{shape.row_names[r]}</span>}
                      <span className="font-medium text-ink-2 flex-shrink-0">{rowHead(r)}</span>
                    </>}
                  </div>
                );
              })}
              {/* Shelf boards under each level of shelving */}
              {shelving && Array.from({ length: layout.rows }, (_, r) => lenOf(r) > 0 && (
                <div key={`b${r}`} style={{ ...span([[r, 0], [r, lenOf(r) - 1]]), alignSelf: "end", height: 3, marginBottom: -5 }} className="bg-line-3 rounded-full pointer-events-none" />
              ))}
              {walls}
              {Array.from({ length: layout.rows }, (_, r) => Array.from({ length: lenOf(r) }, (_, c) => (shape.shelves[spotKey(r, c)] ? shelfView(r, c) : spotView(r, c))))}
            </div>
            {shelving && <div className="text-[11px] text-faint mt-2" style={{ marginLeft: headW + GAP }}>Floor</div>}
          </div>
        </div>
      </div>

      {/* The panel: a door or wall, a shelf, the selected spots, or the legend */}
      <div className={`${WH_CARD} p-5 xl:sticky xl:top-4`}>
        {door || wall ? doorPanel() : shelfSel ? shelfPanel(shelfSel) : sel.size > 0 ? spotPanel() : legendPanel()}
      </div>
    </div>
  );
}

// ---------- Rows and size ----------

function LayoutForm({ initial, onCancel, onSaved }: { initial: WarehouseLayout | null; onCancel: () => void; onSaved: (l: WarehouseLayout) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<WarehouseLayout["kind"]>(initial?.kind ?? "pallets");
  // The map being reshaped: every row's length written out, so rows can be taken out one at a time.
  const [work, setWork] = useState(() => {
    const shape = initial ? shapeOf(initial) : emptyShape();
    const rows = initial?.rows ?? 4;
    const lengths = Array.from({ length: rows }, (_, r) => (initial ? rowLength(initial, r) : 8));
    const names = Array.from({ length: rows }, (_, r) => shape.row_names[r] || "");
    return { rows, cols: initial?.cols ?? 8, cells: initial?.cells ?? [], shape: { ...shape, row_lengths: lengths, row_names: names } };
  });
  const [every, setEvery] = useState(0);
  const [busy, setBusy] = useState(false);
  // Marked spots in rows taken out with ×: asked for, so not warned about below.
  const [gone, setGone] = useState(0);
  const shelvingKind = kind === "shelving";
  const lengths = work.shape.row_lengths;
  const rowLabel = (r: number) => (shelvingKind ? `L${work.rows - r}` : colName(r));

  const setRows = (n: number) => {
    n = Math.max(1, Math.min(60, Math.trunc(n) || 0));
    setWork((w) => {
      let next = w;
      while (next.rows > n) next = removeRow(next, next.rows - 1);
      if (next.rows < n) {
        const add = n - next.rows;
        const last = next.shape.row_lengths[next.rows - 1] ?? 8;
        next = { ...next, rows: n, shape: { ...next.shape, row_lengths: [...next.shape.row_lengths, ...Array(add).fill(last)], row_names: [...next.shape.row_names, ...Array(add).fill("")] } };
      }
      return next;
    });
  };
  const setLen = (r: number, n: number) => setWork((w) => ({ ...w, shape: { ...w.shape, row_lengths: w.shape.row_lengths.map((x, i) => (i === r ? Math.max(0, Math.min(60, n)) : x)) } }));
  const setTitle = (r: number, t: string) => setWork((w) => ({ ...w, shape: { ...w.shape, row_names: w.shape.row_names.map((x, i) => (i === r ? t : x)) } }));

  // What the new rows would drop: marked spots and shelves past a row's end, or in a row taken out.
  const before = initial ? initial.cells.filter((c) => c.c < rowLength(initial, c.r) && c.r < initial.rows).length + Object.keys(shapeOf(initial).shelves).length : 0;
  const after = work.cells.filter((c) => c.r < work.rows && c.c < (lengths[c.r] ?? 0)).length +
    Object.keys(work.shape.shelves).filter((k) => { const [r, c] = k.split(":").map(Number); return r < work.rows && c < (lengths[r] ?? 0); }).length;
  const lost = Math.max(0, before - after - gone);
  const widest = Math.max(0, ...lengths);

  const save = async () => {
    setBusy(true);
    try {
      const l = await api.saveWarehouseLayout({
        id: initial?.id ?? null, name: name.trim(), kind, rows: work.rows, cols: Math.max(1, widest), cells: work.cells,
        shape: { ...work.shape, row_names: work.shape.row_names.map((t) => t.trim()) }, notes: initial?.notes ?? "",
      });
      onSaved(l);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-[620px]">
      <h3 className="text-[16px] font-semibold text-ink mb-4">{initial ? "Rows and size" : "Add a map"}</h3>
      <div className={`${WH_CARD} p-5 space-y-4`}>
        <div>
          <label className="block text-[12px] text-muted mb-1.5">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Floor, Rack A, Back room" style={WH_INPUT_BG} className={WH_INPUT} autoFocus />
        </div>
        <div>
          <label className="block text-[12px] text-muted mb-1.5">What it is</label>
          <Seg size="md" value={kind} onChange={setKind} options={[{ key: "pallets", label: "Pallets on the floor" }, { key: "shelving", label: "Shelving" }]} />
          {!shelvingKind && <p className="text-[11.5px] text-muted mt-1.5">A floor can also hold shelves among its pallets, and doors in its walls — set those on the map.</p>}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-[12px] text-muted mb-1.5">{shelvingKind ? "Levels" : "Rows"}</label>
            <NumberInput integer value={work.rows} onValue={setRows} style={WH_INPUT_BG} className={`${WH_INPUT} w-24 tabular-nums`} />
          </div>
          <div>
            <label className="block text-[12px] text-muted mb-1.5">{shelvingKind ? "Bays on every level" : "Pallets in every row"}</label>
            <div className="flex items-center gap-2">
              <NumberInput integer value={every || ""} placeholder={String(lengths[0] ?? 8)} onValue={(n) => setEvery(Math.max(0, Math.min(60, n)))} style={WH_INPUT_BG} className={`${WH_INPUT} w-24 tabular-nums`} />
              <button onClick={() => { if (every > 0) setWork((w) => ({ ...w, shape: { ...w.shape, row_lengths: w.shape.row_lengths.map(() => every) } })); }} disabled={!(every > 0)} className={WH_BTN_SECONDARY}>Set all</button>
            </div>
          </div>
        </div>
        <div>
          <div className="grid grid-cols-[44px_minmax(0,1fr)_96px_28px] gap-2 px-1 text-[11.5px] text-muted mb-1">
            <span>{shelvingKind ? "Level" : "Row"}</span><span>Title (if needed)</span><span>{shelvingKind ? "Bays" : "Pallets"}</span><span />
          </div>
          <div className="space-y-1.5 max-h-[46vh] overflow-y-auto pr-1">
            {Array.from({ length: work.rows }, (_, r) => (
              <div key={r} className="grid grid-cols-[44px_minmax(0,1fr)_96px_28px] gap-2 items-center">
                <span className="text-[12.5px] font-medium text-ink-2 pl-1">{rowLabel(r)}</span>
                <input value={work.shape.row_names[r] ?? ""} onChange={(e) => setTitle(r, e.target.value)} maxLength={40}
                  placeholder={shelvingKind ? "e.g. Top shelf" : "e.g. Back wall"} style={WH_INPUT_BG} className={`${WH_INPUT} h-8`} />
                <NumberInput integer value={lengths[r] ?? 0} onValue={(n) => setLen(r, n)} style={WH_INPUT_BG} className={`${WH_INPUT} h-8 tabular-nums`} aria-label={`${shelvingKind ? "Bays on level" : "Pallets in row"} ${rowLabel(r)}`} />
                <button onClick={() => {
                  if (work.rows <= 1) return;
                  const len = lengths[r] ?? 0;
                  setGone((g) => g + work.cells.filter((c) => c.r === r && c.c < len).length + Object.keys(work.shape.shelves).filter((k) => { const [sr, sc] = k.split(":").map(Number); return sr === r && sc < len; }).length);
                  setWork((w) => removeRow(w, r));
                }} disabled={work.rows <= 1} title={`Take out ${shelvingKind ? "level" : "row"} ${rowLabel(r)}`}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-surface-2 disabled:opacity-30"><X size={14} /></button>
              </div>
            ))}
          </div>
          <button onClick={() => setRows(work.rows + 1)} disabled={work.rows >= 60} className={`${WH_BTN_SECONDARY} mt-2`}><Plus size={13} /> Add a {shelvingKind ? "level" : "row"}</button>
          <p className="text-[11.5px] text-muted mt-2">Taking a {shelvingKind ? "level" : "row"} out moves the ones below it up, with what is marked on them.</p>
        </div>
        {lost > 0 && <p className="text-[12.5px] text-warning-ink">{lost} marked {lost === 1 ? "spot falls" : "spots fall"} outside the new rows and will be dropped.</p>}
        {widest < 1 && <p className="text-[12.5px] text-warning-ink">Give at least one {shelvingKind ? "level a bay" : "row a pallet"}.</p>}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={busy || !name.trim() || widest < 1} className={WH_BTN_PRIMARY}>{initial ? "Save" : "Add map"}</button>
      </div>
    </div>
  );
}
