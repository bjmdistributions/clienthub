// The floor plan (R-550): the warehouse drawn to scale in feet, with its doors, its office and any
// shelving or named areas, and every delivery pallet standing where it really stands, coloured by its
// delivery. Drag a pallet to move it (it snaps to a neighbour's edge or the nearest quarter foot,
// Escape cancels), drag one in from the tray, or click empty floor to start a new pallet there. Click a
// pallet to see what is on it and to add a box or loose items: that opens the delivery's own box editor
// (WarehouseDeliveries) and comes back here. Edit the building sets its size, doors and rooms. A
// building and a pallet's spot are cleaned by floor_core.rs (the server runs the same file) and
// `snap` is lib/floor.ts, a copy of floor_core::snap. The phone's twin is `whf*` in www/app.js.
// R-554: Add a row of pallets draws a whole row at once, measured in feet from the walls; a pallet's
// panel says how its boxes stack, makes them empty with their codes (A3-7, written on each carton)
// and fills them one by one; the 3D view (WarehouseFloor3D.tsx) shows every pallet with its boxes.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArchiveRestore, Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import { parseAmount } from "../lib/format";
import { byStyle, lineTitle, type LoadDetail, type LoadLine, type LoadSummary, type WhCase } from "../lib/deliveries";
import {
  MAX_ROW, SIZE_MAX, SIZE_MIN, areaRect, boxGrid, cutOff, emptyShape, firstFree, fitArea, fitDoor, footprint, ft, hundredth, insideRect, nextRowName, palletLabel, palletRect, rowOf, rowSpots, snap, standsOn, wallLength,
  type DeliveryOpen, type DoorKind, type AreaKind, type Floor, type FloorArea, type FloorDoor, type FloorList, type FloorPallet, type FloorRequest, type FloorShape, type Rect, type Side,
} from "../lib/floor";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import Switch from "./Switch";
import { Seg } from "./WarehouseProduct";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, newId, rgba, teamColor } from "./warehouseUi";

// three.js only loads when the 3D view is opened.
const WarehouseFloor3D = lazy(() => import("./WarehouseFloor3D"));

// Per computer: the building last looked at, the delivery a new pallet last started on, and whether
// the map opens in 3D.
const ACTIVE_KEY = "warehouse_floor_active";
const LOAD_KEY = "warehouse_floor_load";
const VIEW_KEY = "warehouse_floor_3d";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const DOOR_LABEL: Record<DoorKind, string> = { garage: "Garage", dock: "Dock", door: "Door" };
const SIDE_NAME: Record<Side, string> = { top: "Top wall", bottom: "Bottom wall", left: "Left wall", right: "Right wall" };
const ROOM_ADD: Record<AreaKind, { w: number; d: number; label: string; button: string; name: string }> = {
  office: { w: 15, d: 12, label: "Office", button: "Add the office", name: "Office" },
  shelf: { w: 20, d: 4, label: "Shelving", button: "Add shelving", name: "Shelving" },
  area: { w: 10, d: 10, label: "", button: "Add an area", name: "Area" },
};
/** Room around the drawing, in pixels, for the width and depth written along two edges. */
const PAD = 40;
const BLANK_NAME = "Warehouse";
const SIZE_HINT = `A building is ${SIZE_MIN} to ${SIZE_MAX.toLocaleString("en-US")} ft each way.`;

const doorName = (d: FloorDoor) => d.label || DOOR_LABEL[d.kind];
const roomName = (a: FloorArea) => a.label || ROOM_ADD[a.kind].name;
const rid = (p: string) => `${p}${newId().slice(0, 10)}`;

/** R-554: the row being drawn (or a row being moved), as typed. Numbers stay text until drawn. */
type RowDraft = { mode: "new" | "move"; name: string; loadId: string; count: string; across: boolean; long: boolean; gapIn: string; x: string; y: string };

/** The row as typed: each pallet's corner (drawn even past a wall, to show where it runs out), its names, and why it cannot be drawn. */
function rowDraft(f: Floor, onFloor: FloorPallet[], r: RowDraft) {
  const turned = r.across ? !r.long : r.long;
  const [w, d] = footprint(turned);
  const members = rowMembers(onFloor, r.name);
  const count = r.mode === "move" ? members.length : Math.round(parseAmount(r.count, NaN));
  const x = parseAmount(r.x, NaN), y = parseAmount(r.y, NaN), gap = parseAmount(r.gapIn, 0) / 12;
  const res = rowSpots(f.width, f.depth, x, y, r.across, count, turned, gap);
  const cells: [number, number][] = [];
  if (Number.isFinite(x) && Number.isFinite(y) && count >= 1 && count <= MAX_ROW) {
    const step = (r.across ? w : d) + Math.max(0, gap);
    for (let i = 0; i < count; i++) cells.push(r.across ? [x + step * i, y] : [x, y + step * i]);
  }
  const name = r.name.trim().toUpperCase();
  const after = members.reduce((a, p) => Math.max(a, rowOf(p.location)?.[1] ?? 0), 0);
  const names = r.mode === "move" ? members.map((p) => p.location) : cells.map((_, i) => `${name}${after + 1 + i}`);
  const bad = r.mode === "new" && !/^[A-Z]{1,3}$/.test(name) ? "Name the row with 1 to 3 letters, like A or BB." : "";
  return { cells, names, w, d, turned, count, gap, error: bad || ("error" in res ? res.error : ""), length: "length" in res ? res.length : 0 };
}
/** A row's pallets on this building, first to last. */
const rowMembers = (onFloor: FloorPallet[], name: string) =>
  onFloor.map((p) => [rowOf(p.location), p] as const).filter(([r]) => r && r[0] === name.trim().toUpperCase()).sort((a, b) => a[0]![1] - b[0]![1]).map(([, p]) => p);

const filledOf = (c: WhCase) => c.contents.some((x) => x.pairs > 0);

/** What is on a pallet, in a few words. */
function palletWhat(p: FloorPallet): string {
  const parts: string[] = [];
  if (p.boxes) parts.push(`${p.filled ?? 0} of ${p.boxes} ${p.boxes === 1 ? "box" : "boxes"} filled`);
  if (p.loose) parts.push(`${p.loose} loose ${p.loose === 1 ? "pair" : "pairs"}`);
  if (p.pairs) parts.push(`${p.pairs.toLocaleString("en-US")} ${p.pairs === 1 ? "pair" : "pairs"}`);
  if (p.styles) parts.push(`${p.styles} ${p.styles === 1 ? "style" : "styles"}`);
  return parts.join(" · ") || "Empty";
}

// ---------------------------------------------------------------------------------------
// The building being edited: a draft that saves itself 0.7 s after the last change (and at once when
// the screen or the building is left), then shows what the server stored, cleaned.

type Draft = { id: string; name: string; width: number; depth: number; shape: FloorShape };

function useBuilding(floor: Floor | null, onSaved: (f: Floor) => void, dirty: MutableRefObject<boolean>) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const pending = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const send = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (busy.current) { again.current = true; return; }
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    busy.current = true;
    setStatus("saving");
    try {
      const { floor: saved } = await api.updateWarehouseFloor(next.id, { name: next.name, width: next.width, depth: next.depth, shape: next.shape });
      onSavedRef.current(saved);
      // What is stored (cleaned) is what shows now, unless something newer is waiting.
      if (!pending.current) setDraft(null);
      setStatus(pending.current ? "unsaved" : "saved");
    } catch (e) {
      toast(`The building did not save: ${e}`, "error");
      if (!pending.current) pending.current = next;
      setStatus("unsaved");
    } finally {
      busy.current = false;
      if (!pending.current) dirty.current = false;
      if (again.current) { again.current = false; void send(); }
    }
  }, [dirty]);

  const commit = (next: Draft) => {
    setDraft(next);
    dirty.current = true;
    pending.current = next;
    setStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void send(); }, 700);
  };
  useEffect(() => () => { void send(); }, [send]);

  const shown: Floor | null = floor && draft && draft.id === floor.id ? { ...floor, name: draft.name, width: draft.width, depth: draft.depth, shape: draft.shape } : floor;
  return { shown, status, commit, flush: send };
}

// ---------------------------------------------------------------------------------------

/** A feet field: keeps what is typed until it is left, then says the figure (or goes back). */
function FeetField({ value, onCommit, label, className = "" }: { value: number; onCommit: (n: number) => void; label: string; className?: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const done = () => {
    if (txt === null) return;
    const raw = txt.trim();
    setTxt(null);
    const n = parseAmount(raw, NaN);
    if (raw && Number.isFinite(n) && n !== value) onCommit(n);
  };
  return (
    <input inputMode="decimal" aria-label={label} value={txt ?? String(hundredth(value))} onChange={(e) => setTxt(e.target.value)} onBlur={done}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={WH_INPUT_BG} className={`${WH_INPUT} tabular-nums ${className}`} />
  );
}

type Drag =
  | { kind: "pallet"; id: string; dx: number; dy: number; moved: boolean; pos: Rect; from: { x: number; y: number } }
  | { kind: "tray"; id: string; moved: boolean; pos: Rect | null; from: { x: number; y: number }; at: { x: number; y: number } }
  | { kind: "room"; id: string; dx: number; dy: number; moved: boolean; pos: Rect; from: { x: number; y: number } }
  | { kind: "corner"; id: string; pos: Rect };

export default function WarehouseFloor({ request, onRequestUsed, onOpenDelivery }: {
  /** Another view asked to show a pallet on its building, or to place it (the Deliveries pallet lines). */
  request: FloorRequest | null;
  onRequestUsed: () => void;
  /** Open a delivery on a pallet, into its box editor when `kind` is given, and come back here after. */
  onOpenDelivery: (o: DeliveryOpen) => void;
}) {
  const [data, setData] = useState<FloorList | null>(null);
  const [loads, setLoads] = useState<LoadSummary[]>([]);
  const [floorId, setFloorId] = useState<string | null>(() => lsGet(ACTIVE_KEY));
  const [selId, setSelId] = useState<string | null>(null);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [focusLoad, setFocusLoad] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [doorId, setDoorId] = useState<string | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [boxW, setBoxW] = useState(0);
  // R-554: the row being drawn, the 3D view, and each delivery's boxes as last read (for the picked
  // pallet's panel, and so the 3D view knows exactly which boxes are filled).
  const [row, setRow] = useState<RowDraft | null>(null);
  const [view3d, setView3dRaw] = useState(() => lsGet(VIEW_KEY) === "1");
  const setView3d = (on: boolean) => { setView3dRaw(on); lsSet(VIEW_KEY, on ? "1" : ""); };
  const [details, setDetails] = useState<Record<string, LoadDetail>>({});
  const putDetail = useCallback((d: LoadDetail) => setDetails((m) => ({ ...m, [d.load.id]: { ...d, load: { ...d.load, lines: d.load.lines ?? m[d.load.id]?.load.lines } } })), []);
  const dragRef = useRef<Drag | null>(null);
  const dirty = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };

  const refresh = useCallback(() =>
    Promise.all([api.listWarehouseFloors(), api.listWarehouseLoads()])
      .then(([d, l]) => { setData(d); setLoads(l); })
      .catch((e) => { toast(`Couldn't load the floor plan: ${e}`, "error"); setData((p) => p ?? { floors: [], pallets: [] }); }), []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Live: a pallet moved on the phone (or another desktop) lands here as soon as it syncs, never mid-drag or mid-edit.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { if (!dragRef.current && !dirty.current) void refresh(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [refresh]);

  const floors = data?.floors ?? [];
  const live = floors.filter((f) => !f.archived);
  const removed = floors.filter((f) => f.archived);
  const floor = live.find((f) => f.id === floorId) ?? live[0] ?? null;
  const putFloor = useCallback((f: Floor) => setData((d) => d && ({ ...d, floors: d.floors.some((x) => x.id === f.id) ? d.floors.map((x) => (x.id === f.id ? f : x)) : [...d.floors, f] })), []);
  const building = useBuilding(floor, putFloor, dirty);
  const shown = building.shown;
  const pallets = data?.pallets ?? [];
  const onFloor = shown ? pallets.filter((p) => p.floor_id === shown.id) : [];
  const tray = pallets.filter((p) => !standsOn(p, live));
  const sel = pallets.find((p) => p.id === selId) ?? null;
  useEffect(() => { if (floor) lsSet(ACTIVE_KEY, floor.id); }, [floor]);
  // The picked pallet's delivery, read again whenever what is on the pallet changes.
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    api.getWarehouseLoad(sel.load_id).then((d) => { if (alive) putDetail(d); }).catch(() => {});
    return () => { alive = false; };
  }, [sel?.load_id, sel?.boxes, sel?.filled, sel?.loose, sel?.pairs, sel?.styles, putDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another view asked for a pallet: show it on its building, or get ready to place it.
  useEffect(() => {
    if (!request || !data) return;
    const p = data.pallets.find((x) => x.id === request.palletId);
    onRequestUsed();
    if (!p) { toast("That pallet is no longer there.", "error"); return; }
    setSelId(p.id); setSpot(null); setEditing(false); setCreating(false);
    if (request.kind === "show") { if (standsOn(p, data.floors.filter((f) => !f.archived))) setFloorId(p.floor_id); }
    else setPlacing(p.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, data]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !dragRef.current) { setPlacing(null); setSpot(null); setRow(null); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // ---- Size on screen: fit the drawing to its box, then zoom ----
  const hasFloor = !!shown;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const read = () => setBoxW(Math.max(0, el.clientWidth - 2 * PAD));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasFloor, creating, view3d, editing]);
  const maxH = Math.max(320, Math.min(window.innerHeight * 0.7, 780));
  const base = shown ? Math.max(240, Math.min(boxW || 760, (maxH * shown.width) / shown.depth)) : 0;
  const svgW = base * 1.25 ** zoom;
  const ppf = shown ? svgW / shown.width : 1;

  // ---- Pointer to feet ----
  const pointFt = (cx: number, cy: number) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return null;
    const q = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return { x: q.x, y: q.y };
  };
  const overSvg = (cx: number, cy: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    return !!r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  };
  const centred = (pt: { x: number; y: number }, turned: boolean): Rect => {
    const [w, d] = footprint(turned);
    return { x: pt.x - w / 2, y: pt.y - d / 2, w, d };
  };

  // ---- Changing the building ----
  const edit = (patch: Partial<Omit<Draft, "id">>) => {
    if (!shown) return;
    building.commit({ id: shown.id, name: shown.name, width: shown.width, depth: shown.depth, shape: shown.shape, ...patch });
  };
  const setShape = (shape: FloorShape) => edit({ shape });

  // ---- Changing pallets ----
  const commitPlace = async (p: FloorPallet, x: number, y: number, turned: boolean) => {
    if (!shown) return;
    const fid = shown.id;
    setData((d) => d && { ...d, pallets: d.pallets.map((q) => (q.id === p.id ? { ...q, floor_id: fid, x, y, turned } : q)) });
    setPlacing(null);
    try { await api.saveLoadPallet(p.load_id, p.number, { floorId: fid, x, y, turned }); }
    catch (e) { toast(String(e), "error"); void refresh(); }
  };
  const patchPallet = async (p: FloorPallet, patch: { closed?: boolean; floorId?: string; startNext?: boolean }, local: Partial<FloorPallet>) => {
    setData((d) => d && { ...d, pallets: d.pallets.map((q) => (q.id === p.id ? { ...q, ...local } : q)) });
    try {
      await api.saveLoadPallet(p.load_id, p.number, patch);
      // Pallet full starts the next pallet, as it does in Deliveries; it waits in the tray.
      if (patch.startNext) void refresh();
    } catch (e) { toast(String(e), "error"); void refresh(); }
  };
  const turn = (p: FloorPallet) => {
    if (!shown) return;
    const r = insideRect({ x: p.x, y: p.y, turned: !p.turned }, shown.width, shown.depth);
    void commitPlace(p, hundredth(r.x), hundredth(r.y), !p.turned);
  };
  const takeOff = (p: FloorPallet) => patchPallet(p, { floorId: "" }, { floor_id: "", x: 0, y: 0, turned: false });
  const startHere = async (loadId: string) => {
    if (!shown || !spot) return;
    try {
      const res = await api.startLoadPallet(loadId, { floor_id: shown.id, x: spot.x, y: spot.y, turned: false });
      lsSet(LOAD_KEY, loadId);
      setSpot(null);
      if (res.started) { setSelId(`pal-${loadId}-${res.started}`); toast(`Pallet ${res.started} started here`); }
      await refresh();
    } catch (e) { toast(String(e), "error"); }
  };

  // ---- R-554: rows of pallets, a pallet's boxes, exactly where it stands ----
  const startRow = async () => {
    if (!shown) return;
    let ls = loads;
    try { ls = await api.listWarehouseLoads(); setLoads(ls); } catch { /* keep what is on hand */ }
    const open = ls.filter((l) => !l.archived).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const k = lsGet(LOAD_KEY);
    const used = onFloor.map((p) => rowOf(p.location)?.[0]).filter((n): n is string => !!n);
    setRow({ mode: "new", name: nextRowName(used), loadId: k && open.some((l) => l.id === k) ? k : open[0]?.id ?? "", count: "10", across: true, long: true, gapIn: "0", x: "", y: "" });
    setSelId(null); setSpot(null); setPlacing(null); setView3d(false);
  };
  const moveRow = (name: string) => {
    const ms = rowMembers(onFloor, name);
    if (!ms.length) return;
    const a = ms[0], b = ms[1];
    const across = b ? Math.abs(b.y - a.y) < 0.01 : true;
    const [w, d] = footprint(a.turned);
    const gapFt = b ? Math.max(0, across ? b.x - a.x - w : b.y - a.y - d) : 0;
    setRow({ mode: "move", name, loadId: "", count: String(ms.length), across, long: across ? !a.turned : a.turned, gapIn: String(Math.round(gapFt * 12 * 4) / 4), x: String(a.x), y: String(a.y) });
    setSelId(null); setSpot(null); setPlacing(null); setView3d(false);
  };
  const [rowBusy, setRowBusy] = useState(false);
  const sendRow = async (go: () => Promise<FloorList>, said: string) => {
    setRowBusy(true);
    try { setData(await go()); setRow(null); toast(said); } catch (e) { toast(String(e), "error"); }
    finally { setRowBusy(false); }
  };
  const drawRow = () => {
    if (!shown || !row) return;
    const rd = rowDraft(shown, onFloor, row);
    if (!row.x.trim() || !row.y.trim()) { toast("Give the first pallet's corner in feet from the walls, or click the floor.", "error"); return; }
    if (rd.error) { toast(rd.error, "error"); return; }
    const x = parseAmount(row.x, 0), y = parseAmount(row.y, 0);
    if (row.mode === "move") { void sendRow(() => api.changePalletRow(shown.id, row.name, { x, y, across: row.across, turned: rd.turned, gap: rd.gap }), `Row ${row.name} moved`); return; }
    if (!row.loadId) { toast("Choose the delivery the pallets are from.", "error"); return; }
    lsSet(LOAD_KEY, row.loadId);
    const name = row.name.trim().toUpperCase();
    void sendRow(() => api.drawPalletRow(shown.id, { loadId: row.loadId, name, x, y, across: row.across, count: rd.count, turned: rd.turned, gap: rd.gap }),
      `Row ${name} drawn: ${rd.names[0]}${rd.count > 1 ? ` to ${rd.names[rd.count - 1]}` : ""}`);
  };
  const removeRow = (name: string) => shown && sendRow(() => api.changePalletRow(shown.id, name, { remove: true }), `Row ${name} removed`);
  const setBoxes = async (p: FloorPallet, rows: number, perRow: number, count: number) => {
    const have = (details[p.load_id]?.cases ?? []).filter((c) => c.pallet === p.number && c.kind !== "loose").length;
    try {
      putDetail(await api.setPalletBoxes(p.load_id, p.number, rows, perRow, count));
      await refresh();
      const label = palletLabel(p);
      toast(count > have ? `${count - have} boxes made, ${label}-${have + 1} to ${label}-${count}. Write each code on its box.` : "Saved");
      return true;
    } catch (e) { toast(String(e), "error"); return false; }
  };
  const sameAs = async (p: FloorPallet, to: WhCase, from: WhCase) => {
    try {
      putDetail(await api.saveWarehouseCase(p.load_id, { caseId: to.id, pallet: to.pallet, contents: from.contents, notes: to.notes }));
      await refresh();
      toast(`${to.code || `Box ${to.number}`} filled the same as ${from.code || `box ${from.number}`}`);
    } catch (e) { toast(String(e), "error"); }
  };
  /** Exactly where a pallet stands, typed in feet from the walls: kept inside them, never snapped. */
  const placeExact = (p: FloorPallet, x: number, y: number) => {
    const f = live.find((q) => q.id === p.floor_id);
    if (!f) return;
    const r = insideRect({ x, y, turned: p.turned }, f.width, f.depth);
    void commitPlace(p, hundredth(r.x), hundredth(r.y), p.turned);
  };

  // ---- Snapping: the other pallets on this floor and every other room ----
  const othersFor = (skipPallet: string | null, skipArea: string | null, withPallets: boolean): Rect[] => {
    if (!shown) return [];
    return [
      ...(withPallets ? onFloor.filter((p) => p.id !== skipPallet).map((p) => insideRect(p, shown.width, shown.depth)) : []),
      ...shown.shape.areas.filter((a) => a.id !== skipArea).map(areaRect),
    ];
  };
  const placeAt = (p: FloorPallet, pt: { x: number; y: number }) => {
    if (!shown) return;
    const r = snap(shown.width, shown.depth, centred(pt, false), othersFor(p.id, null, true));
    void commitPlace(p, r.x, r.y, false);
  };

  // What the window-level drag handlers need, as of the latest render.
  const latest = useRef({ shown, pallets, pointFt, overSvg, othersFor, commitPlace, centred, setShape, setPlacing, setSelId, placeAt });
  latest.current = { shown, pallets, pointFt, overSvg, othersFor, commitPlace, centred, setShape, setPlacing, setSelId, placeAt };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const L = latest.current;
      if (!d || !L.shown) return;
      const { width: W, depth: D } = L.shown;
      if (d.kind === "pallet") {
        const pt = L.pointFt(e.clientX, e.clientY);
        const moved = d.moved || Math.hypot(e.clientX - d.from.x, e.clientY - d.from.y) > 3;
        if (!pt || !moved) return;
        setDrag({ ...d, moved, pos: snap(W, D, { x: pt.x - d.dx, y: pt.y - d.dy, w: d.pos.w, d: d.pos.d }, L.othersFor(d.id, null, true)) });
      } else if (d.kind === "tray") {
        const moved = d.moved || Math.hypot(e.clientX - d.from.x, e.clientY - d.from.y) > 4;
        const pt = L.overSvg(e.clientX, e.clientY) ? L.pointFt(e.clientX, e.clientY) : null;
        setDrag({ ...d, moved, at: { x: e.clientX, y: e.clientY }, pos: pt ? snap(W, D, L.centred(pt, false), L.othersFor(d.id, null, true)) : null });
      } else if (d.kind === "room") {
        const pt = L.pointFt(e.clientX, e.clientY);
        const moved = d.moved || Math.hypot(e.clientX - d.from.x, e.clientY - d.from.y) > 3;
        if (!pt || !moved) return;
        setDrag({ ...d, moved, pos: snap(W, D, { x: pt.x - d.dx, y: pt.y - d.dy, w: d.pos.w, d: d.pos.d }, L.othersFor(null, d.id, true)) });
      } else {
        const pt = L.pointFt(e.clientX, e.clientY);
        const a = L.shown.shape.areas.find((x) => x.id === d.id);
        if (!pt || !a) return;
        const s = snap(W, D, { x: pt.x, y: pt.y, w: 0, d: 0 }, L.othersFor(null, d.id, true));
        setDrag({ ...d, pos: { x: a.x, y: a.y, w: Math.max(1, Math.min(s.x - a.x, W - a.x)), d: Math.max(1, Math.min(s.y - a.y, D - a.y)) } });
      }
    };
    const up = () => {
      const d = dragRef.current;
      const L = latest.current;
      setDrag(null);
      if (!d || !L.shown) return;
      if (d.kind === "pallet") {
        const p = L.pallets.find((x) => x.id === d.id);
        if (p && d.moved) void L.commitPlace(p, d.pos.x, d.pos.y, p.turned);
      } else if (d.kind === "tray") {
        const p = L.pallets.find((x) => x.id === d.id);
        if (!p) return;
        if (d.pos) void L.commitPlace(p, d.pos.x, d.pos.y, false);
        else if (!d.moved) L.setPlacing((cur) => (cur === p.id ? null : p.id));
      } else if (d.kind === "room") {
        if (d.moved) L.setShape({ ...L.shown.shape, areas: L.shown.shape.areas.map((a) => (a.id === d.id ? { ...a, x: d.pos.x, y: d.pos.y } : a)) });
      } else {
        L.setShape({ ...L.shown.shape, areas: L.shown.shape.areas.map((a) => (a.id === d.id ? { ...a, w: hundredth(d.pos.w), d: hundredth(d.pos.d) } : a)) });
      }
    };
    const cancel = () => setDrag(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, drag?.id]);

  // ---- Pointer down on the drawing ----
  const floorDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !shown) return;
    if (editing) { setRoomId(null); setDoorId(null); return; }
    const pt = pointFt(e.clientX, e.clientY);
    if (!pt) return;
    // R-554: drawing a row, a click is where its first pallet stands (lined up with its neighbours).
    if (row) {
      const s = snap(shown.width, shown.depth, centred(pt, rowDraft(shown, onFloor, row).turned), othersFor(null, null, true));
      setRow({ ...row, x: String(s.x), y: String(s.y) });
      return;
    }
    if (placing) {
      const p = pallets.find((x) => x.id === placing);
      if (p) placeAt(p, pt);
      return;
    }
    setSelId(null);
    setSpot(snap(shown.width, shown.depth, centred(pt, false), othersFor(null, null, true)));
  };
  const palletDown = (p: FloorPallet, e: React.PointerEvent) => {
    if (e.button !== 0 || editing || placing || row || !shown) return;
    e.stopPropagation();
    setSelId(p.id); setSpot(null);
    const pt = pointFt(e.clientX, e.clientY);
    if (!pt) return;
    const r = insideRect(p, shown.width, shown.depth);
    setDrag({ kind: "pallet", id: p.id, dx: pt.x - r.x, dy: pt.y - r.y, moved: false, pos: r, from: { x: e.clientX, y: e.clientY } });
  };
  const trayDown = (p: FloorPallet, e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return;
    setSelId(p.id); setSpot(null);
    if (!shown) return;
    setDrag({ kind: "tray", id: p.id, moved: false, pos: null, from: { x: e.clientX, y: e.clientY }, at: { x: e.clientX, y: e.clientY } });
  };
  const roomDown = (a: FloorArea, e: React.PointerEvent) => {
    if (e.button !== 0 || !editing) return;
    e.stopPropagation();
    setRoomId(a.id); setDoorId(null);
    const pt = pointFt(e.clientX, e.clientY);
    if (!pt) return;
    setDrag({ kind: "room", id: a.id, dx: pt.x - a.x, dy: pt.y - a.y, moved: false, pos: areaRect(a), from: { x: e.clientX, y: e.clientY } });
  };
  const cornerDown = (a: FloorArea, e: React.PointerEvent) => {
    if (e.button !== 0 || !editing) return;
    e.stopPropagation();
    setDrag({ kind: "corner", id: a.id, pos: areaRect(a) });
  };
  const wallDown = (side: Side, e: React.PointerEvent) => {
    if (e.button !== 0 || !editing || !shown) return;
    e.stopPropagation();
    const pt = pointFt(e.clientX, e.clientY);
    if (!pt) return;
    const along = side === "top" || side === "bottom" ? pt.x : pt.y;
    const w = Math.min(12, wallLength(shown.width, shown.depth, side));
    const fit = fitDoor(shown.width, shown.depth, { id: rid("d"), side, at: along - w / 2, width: w, kind: "garage", label: "" }, shown.shape.doors);
    if (!fit) { toast("A door is already there. Click a clear part of the wall.", "error"); return; }
    setShape({ ...shown.shape, doors: [...shown.shape.doors, fit] });
    setDoorId(fit.id); setRoomId(null);
  };

  // ---- Buildings: picking, drawing a new one, removing, bringing back ----
  const pickFloor = (id: string) => {
    void building.flush();
    setFloorId(id); setSelId(null); setSpot(null); setRoomId(null); setDoorId(null); setCreating(false); setFocusLoad(null);
  };
  const created = (f: Floor) => {
    putFloor(f); setFloorId(f.id); setCreating(false); setEditing(true); setSelId(null); setSpot(null);
  };
  const setRemoved = async (f: Floor, archived: boolean) => {
    try {
      await building.flush();
      const { floor: next } = await api.updateWarehouseFloor(f.id, { archived });
      putFloor(next);
      if (archived) {
        setEditing(false); setSpot(null); setSelId(null);
        setFloorId(live.find((x) => x.id !== f.id)?.id ?? null);
        toast(`${f.name} removed. It stays under Removed buildings.`);
      } else { setFloorId(f.id); setShowRemoved(false); toast(`${f.name} is back`); }
    } catch (e) { toast(String(e), "error"); }
  };

  if (data === null) return <div className="h-[320px] bg-surface-2 rounded-xl animate-pulse" />;

  const chips = (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {live.map((f) => (
        <button key={f.id} onClick={() => pickFloor(f.id)}
          className={`inline-flex items-center h-8 px-3 rounded-full border text-[12.5px] transition-colors ${floor?.id === f.id && !creating ? "border-accent bg-accent/10 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
          {f.name}
        </button>
      ))}
      {live.length > 0 && !creating && (
        <button onClick={() => { void building.flush(); setCreating(true); setEditing(false); }}
          className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-dashed border-line-3 text-[12.5px] text-accent hover:bg-accent/10 transition-colors">
          <Plus size={13} /> Add a building
        </button>
      )}
      {removed.length > 0 && (
        <button onClick={() => setShowRemoved((v) => !v)} className="text-[12px] text-muted hover:text-ink-2 ml-1">{showRemoved ? "Hide" : "Removed buildings"} ({removed.length})</button>
      )}
      {showRemoved && removed.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1.5 h-8 pl-3 pr-1.5 rounded-full border border-line text-[12.5px] text-muted">
          {f.name}
          <button onClick={() => setRemoved(f, false)} className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-accent hover:bg-accent/10"><ArchiveRestore size={12} /> Bring it back</button>
        </span>
      ))}
    </div>
  );

  if (live.length === 0 || creating) {
    return (
      <div>
        {chips}
        <BuildingForm first={live.length === 0} onCancel={live.length ? () => setCreating(false) : undefined} onCreated={created} />
      </div>
    );
  }
  if (!shown) return null;

  const W = shown.width, D = shown.depth;
  const placingPallet = placing ? pallets.find((p) => p.id === placing) ?? null : null;
  const legend = [...new Map(onFloor.map((p) => [p.load_id, p.load_name])).entries()].map(([id, name]) => ({ id, name, n: onFloor.filter((p) => p.load_id === id).length }));
  const trayDrag = drag?.kind === "tray" && drag.moved ? drag : null;
  const focus = legend.some((l) => l.id === focusLoad) ? focusLoad : null;

  const rd = row ? rowDraft(shown, onFloor, row) : null;
  let side: React.ReactNode;
  if (editing) {
    side = <EditPanel key={shown.id} floor={shown} pallets={onFloor} status={building.status} edit={edit} setShape={setShape} roomId={roomId} setRoomId={setRoomId} doorId={doorId} setDoorId={setDoorId}
      onRemove={async () => { await setRemoved(floor ?? shown, true); }} />;
  } else if (row && rd) {
    side = <RowPanel row={row} setRow={setRow} rd={rd} loads={loads} busy={rowBusy} onGo={drawRow} onCancel={() => setRow(null)} />;
  } else if (spot) {
    side = <NewPalletPanel loads={loads} onStart={startHere} onCancel={() => setSpot(null)} />;
  } else if (sel) {
    const sf = live.find((f) => f.id === sel.floor_id);
    const rr = rowOf(sel.location);
    side = <PalletPanel key={sel.id} p={sel} detail={details[sel.load_id] ?? null} standing={standsOn(sel, live)} floorName={sf?.name ?? ""} placing={placing === sel.id}
      row={rr && sf ? { name: rr[0], count: rowMembers(pallets.filter((q) => q.floor_id === sf.id), rr[0]).length } : null}
      onTurn={() => turn(sel)} onTakeOff={() => takeOff(sel)} onFull={() => patchPallet(sel, { closed: !sel.closed, startNext: !sel.closed }, { closed: !sel.closed })}
      onPlace={() => setPlacing(placing === sel.id ? null : sel.id)} onOpen={onOpenDelivery}
      onSetBoxes={(r, n, c) => setBoxes(sel, r, n, c)} onSameAs={(to, from) => sameAs(sel, to, from)} onExact={(x, y) => placeExact(sel, x, y)}
      onMoveRow={moveRow} onRemoveRow={(n) => { void removeRow(n); }} />;
  } else {
    side = (
      <div className={`${WH_CARD} p-4`}>
        <div className="text-[14px] font-semibold text-ink">{shown.name}</div>
        <div className="text-[12px] text-muted mt-0.5 tabular-nums">{ft(W)} by {ft(D)} · {onFloor.length} {onFloor.length === 1 ? "pallet" : "pallets"} on this floor</div>
        <p className="text-[12.5px] text-muted mt-3">{view3d ? "Drag to turn it, right drag to slide it, scroll to zoom. Click a pallet to see what is on it." : "Click a pallet to see what is on it and to fill its boxes. Drag it to move it. Click empty floor to start a new pallet there, or add a whole row of pallets."}</p>
      </div>
    );
  }

  return (
    <div>
      {chips}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <Switch on={editing} onToggle={() => { if (editing) void building.flush(); setEditing(!editing); setRoomId(null); setDoorId(null); setSpot(null); setPlacing(null); setSelId(null); setRow(null); }} label="Edit the building" />
          <span className="text-[13px] text-ink-2">Edit the building</span>
          {editing && <span className="text-[12px] text-muted">{building.status === "saving" ? "Saving…" : building.status === "unsaved" ? "Saving shortly" : "Saved"}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!editing && <button onClick={() => { void startRow(); }} className={WH_BTN_SECONDARY}><Plus size={13} /> Add a row of pallets</button>}
          {!editing && <Seg value={view3d ? "3d" : "plan"} onChange={(k) => { setView3d(k === "3d"); if (k === "3d") setRow(null); }} options={[{ key: "plan", label: "Floor plan" }, { key: "3d", label: "3D view" }]} />}
          {(editing || !view3d) && <div className="flex items-center gap-1.5">
            <button onClick={() => setZoom((z) => Math.max(-4, z - 1))} disabled={zoom <= -4} aria-label="Zoom out" className={`${WH_BTN_SECONDARY} px-2.5`}><ZoomOut size={14} /></button>
            <span className="w-12 text-center text-[12px] text-muted tabular-nums">{Math.round(1.25 ** zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(8, z + 1))} disabled={zoom >= 8} aria-label="Zoom in" className={`${WH_BTN_SECONDARY} px-2.5`}><ZoomIn size={14} /></button>
          </div>}
        </div>
      </div>
      {row && !editing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-2 mb-3">
          <span className="text-[12.5px] text-ink">Click the floor where the first pallet of the row stands, or type its feet from the walls. Escape cancels.</span>
          <button onClick={() => setRow(null)} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
        </div>
      )}

      {placingPallet && !editing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-2 mb-3">
          <span className="text-[12.5px] text-ink">Click the floor where pallet {placingPallet.number} of {placingPallet.load_name} stands. Escape cancels.</span>
          <button onClick={() => setPlacing(null)} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
        </div>
      )}

      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="min-w-0 space-y-3">
          {view3d && !editing ? (
            <Suspense fallback={<div className={`${WH_CARD} bg-surface-2 animate-pulse`} style={{ height: maxH }} />}>
              <WarehouseFloor3D floor={shown} pallets={onFloor} details={details} selId={selId} focusLoad={focus} height={maxH}
                onPick={(id) => { setSelId(id); setSpot(null); setPlacing(null); }} />
            </Suspense>
          ) : (
          <div ref={boxRef} className={`${WH_CARD} overflow-auto`} style={{ padding: PAD, maxHeight: maxH + 2 * PAD + 8 }}>
            <div className="mx-auto" style={{ width: svgW }}>
            <Drawing floor={shown} onFloor={onFloor} selId={selId} focusLoad={focus} editing={editing} placing={!!placing || !!row} ppf={ppf} svgW={svgW} svgRef={svgRef}
              drag={drag} spot={editing ? null : spot} roomId={roomId} doorId={doorId} rowGhost={editing ? null : rd}
              onFloorDown={floorDown} onPalletDown={palletDown} onPalletPick={(p) => { setSelId(p.id); setSpot(null); }} onRoomDown={roomDown} onCornerDown={cornerDown} onWallDown={wallDown} onDoorDown={(d) => { setDoorId(d.id); setRoomId(null); }} />
            </div>
          </div>
          )}
          {legend.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {legend.map((l) => (
                <button key={l.id} onClick={() => setFocusLoad(focus === l.id ? null : l.id)} title={focus === l.id ? "Show every delivery" : "Show only this delivery"}
                  className={`inline-flex items-center gap-2 h-8 px-3 rounded-full border text-[12.5px] transition-colors ${focus === l.id ? "border-accent bg-accent/10 text-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                  <span className="w-3 h-3 rounded-[3px]" style={{ background: rgba(teamColor(l.id), 1) }} />
                  <span className="truncate max-w-[220px]">{l.name}</span>
                  <span className="text-muted tabular-nums">{l.n} {l.n === 1 ? "pallet" : "pallets"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-3 min-w-0">
          {side}
          <Tray pallets={tray} selId={selId} placing={placing} onDown={trayDown} onPick={(p) => { setSelId(p.id); setSpot(null); setPlacing(p.id); }} />
        </div>
      </div>
      {trayDrag && (() => {
        const p = pallets.find((x) => x.id === trayDrag.id);
        return p ? <div className="fixed z-50 pointer-events-none px-2.5 py-1 rounded-md bg-surface ring-1 ring-line shadow-md text-[12px] text-ink" style={{ left: trayDrag.at.x + 14, top: trayDrag.at.y + 14 }}>Pallet {p.number} of {p.load_name}</div> : null;
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The drawing: SVG in feet, so everything is to scale. Strokes and text keep their size in pixels.

function Drawing({ floor, onFloor, selId, focusLoad, editing, placing, ppf, svgW, svgRef, drag, spot, roomId, doorId, rowGhost, onFloorDown, onPalletDown, onPalletPick, onRoomDown, onCornerDown, onWallDown, onDoorDown }: {
  floor: Floor; onFloor: FloorPallet[]; selId: string | null; focusLoad: string | null; editing: boolean; placing: boolean; ppf: number; svgW: number;
  svgRef: React.RefObject<SVGSVGElement>; drag: Drag | null; spot: Rect | null; roomId: string | null; doorId: string | null;
  rowGhost: ReturnType<typeof rowDraft> | null;
  onFloorDown: (e: React.PointerEvent) => void; onPalletDown: (p: FloorPallet, e: React.PointerEvent) => void; onPalletPick: (p: FloorPallet) => void; onRoomDown: (a: FloorArea, e: React.PointerEvent) => void;
  onCornerDown: (a: FloorArea, e: React.PointerEvent) => void; onWallDown: (side: Side, e: React.PointerEvent) => void; onDoorDown: (d: FloorDoor) => void;
}) {
  const { width: W, depth: D } = floor;
  const px = (n: number) => n / ppf;
  const ink = "rgb(var(--c-ink))";
  const text = { fontSize: px(12), fill: "rgb(var(--c-ink-2))", userSelect: "none" as const, pointerEvents: "none" as const };
  const halo = { stroke: "rgb(var(--c-surface))", strokeWidth: px(3), paintOrder: "stroke" as const };
  const grid: string[] = [];
  for (let x = 10; x < W; x += 10) grid.push(`M${x} 0V${D}`);
  for (let y = 10; y < D; y += 10) grid.push(`M0 ${y}H${W}`);
  const seg = (d: FloorDoor): [number, number, number, number] =>
    d.side === "top" ? [d.at, 0, d.at + d.width, 0] : d.side === "bottom" ? [d.at, D, d.at + d.width, D] : d.side === "left" ? [0, d.at, 0, d.at + d.width] : [W, d.at, W, d.at + d.width];
  const band = px(8);
  const dragged = (id: string): Rect | null => (drag && (drag.kind === "pallet" || drag.kind === "room" || drag.kind === "corner") && drag.id === id ? drag.pos : null);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${D}`} width={svgW} height={(svgW * D) / W} onPointerDown={onFloorDown}
      style={{ display: "block", overflow: "visible", cursor: placing ? "crosshair" : "default", userSelect: "none" }}>
      <rect x={0} y={0} width={W} height={D} style={{ fill: "rgb(var(--c-surface))" }} />
      <path d={grid.join("")} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none" style={{ stroke: "rgb(var(--c-line-3))", strokeWidth: 1 }} />

      {floor.shape.areas.map((a) => {
        const r = dragged(a.id) ?? areaRect(a);
        const on = editing && roomId === a.id;
        // Shelving is drawn with a shelf line every 2 ft across its long side.
        const shelf: string[] = [];
        if (a.kind === "shelf") {
          if (r.w >= r.d) for (let x = r.x + 2; x < r.x + r.w - 0.01; x += 2) shelf.push(`M${x} ${r.y}V${r.y + r.d}`);
          else for (let y = r.y + 2; y < r.y + r.d - 0.01; y += 2) shelf.push(`M${r.x} ${y}H${r.x + r.w}`);
        }
        return (
          <g key={a.id} pointerEvents={editing ? "all" : "none"} style={{ cursor: editing ? "move" : "default" }} onPointerDown={(e) => onRoomDown(a, e)}>
            <rect x={r.x} y={r.y} width={r.w} height={r.d} vectorEffect="non-scaling-stroke"
              strokeDasharray={a.kind === "area" ? "6 4" : undefined}
              style={{ fill: a.kind === "office" ? "rgb(var(--c-ink) / 0.09)" : a.kind === "shelf" ? "rgb(var(--c-ink) / 0.04)" : "rgb(var(--c-ink) / 0.02)", stroke: on ? ink : "rgb(var(--c-ink-2) / 0.65)", strokeWidth: on ? 2.5 : 1.5 }} />
            {shelf.length > 0 && <path d={shelf.join("")} fill="none" vectorEffect="non-scaling-stroke" style={{ stroke: "rgb(var(--c-ink-2) / 0.4)", strokeWidth: 1 }} />}
            {a.label && (a.kind === "shelf" ? r.d * ppf > 16 || r.w * ppf > 60 : true) && (
              <text x={r.x + r.w / 2} y={r.y + r.d / 2} textAnchor="middle" dominantBaseline="central" style={{ ...text, ...halo }}>{a.label}</text>
            )}
          </g>
        );
      })}

      {onFloor.map((p) => {
        const r = dragged(p.id) ?? insideRect(p, W, D);
        const col = teamColor(p.load_id);
        const sel = p.id === selId;
        const dim = focusLoad !== null && focusLoad !== p.load_id && !sel;
        // R-554: full, or every box filled, is solid; boxes fill from the bottom as they are filled; a
        // pallet with nothing on it yet is only outlined. Zoomed in, its boxes show as a grid.
        const boxes = p.boxes || 0, filled = Math.min(p.filled || 0, boxes);
        const done = p.closed || (boxes > 0 && filled === boxes);
        const empty = !done && !boxes && !p.pairs;
        const per = boxes ? Math.min(p.per_layer || Math.min(boxes, 6), boxes) : 0;
        const g = per && ppf >= 12 ? boxGrid(per, r.w, r.d) : null;
        const grid: string[] = [];
        if (g) {
          for (let i = 1; i < g.cols; i++) grid.push(`M${r.x + (r.w * i) / g.cols} ${r.y}V${r.y + r.d}`);
          for (let i = 1; i < g.rows; i++) grid.push(`M${r.x} ${r.y + (r.d * i) / g.rows}H${r.x + r.w}`);
        }
        const fh = !done && boxes > 0 && filled > 0 ? (r.d * filled) / boxes : 0;
        const big = r.w * ppf >= 20, sub = boxes > 0 && ppf >= 12;
        const tx = { fontWeight: 600, fill: done ? "rgb(var(--c-on-accent))" : ink, userSelect: "none" as const, pointerEvents: "none" as const };
        return (
          <g key={p.id} opacity={dim ? 0.22 : 1} pointerEvents={editing ? "none" : "all"} tabIndex={0} role="button" aria-label={`${palletLabel(p)}, pallet ${p.number} of ${p.load_name}`}
            style={{ cursor: placing ? "crosshair" : drag?.kind === "pallet" && drag.id === p.id ? "grabbing" : "grab", touchAction: "none", outline: "none" }}
            onPointerDown={(e) => onPalletDown(p, e)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPalletPick(p); } }}>
            <title>{`${palletLabel(p)}, pallet ${p.number} of ${p.load_name}: ${palletWhat(p)}`}</title>
            <rect x={r.x} y={r.y} width={r.w} height={r.d} rx={px(2)} vectorEffect="non-scaling-stroke" strokeDasharray={empty ? "4 3" : undefined}
              style={{ fill: done ? rgba(col, 0.92) : empty ? "rgb(var(--c-surface))" : rgba(col, 0.22), stroke: rgba(col, 1), strokeWidth: 1.5 }} />
            {fh > 0 && <rect x={r.x} y={r.y + r.d - fh} width={r.w} height={fh} pointerEvents="none" style={{ fill: rgba(col, 0.92) }} />}
            {grid.length > 0 && <path d={grid.join("")} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none" style={{ stroke: "rgb(var(--c-surface) / 0.85)", strokeWidth: 1 }} />}
            {sel && <rect x={r.x - px(3)} y={r.y - px(3)} width={r.w + px(6)} height={r.d + px(6)} rx={px(4)} fill="none" vectorEffect="non-scaling-stroke" style={{ stroke: ink, strokeWidth: 2.5 }} />}
            {big && (
              <text x={r.x + r.w / 2} y={r.y + r.d / 2 - (sub ? px(6) : 0)} textAnchor="middle" dominantBaseline="central" style={{ ...tx, fontSize: px(12) }}>{palletLabel(p)}</text>
            )}
            {big && sub && (
              <text x={r.x + r.w / 2} y={r.y + r.d / 2 + px(7)} textAnchor="middle" dominantBaseline="central" style={{ ...tx, fontSize: px(10), fontWeight: 500 }}>{filled}/{boxes}</text>
            )}
          </g>
        );
      })}

      {rowGhost && rowGhost.cells.map(([x, y], i) => (
        <g key={`row-${i}`} pointerEvents="none">
          <rect x={x} y={y} width={rowGhost.w} height={rowGhost.d} rx={px(2)} strokeDasharray="5 3" vectorEffect="non-scaling-stroke"
            style={{ fill: rowGhost.error ? "rgb(var(--c-warning) / 0.18)" : "rgb(var(--c-ink) / 0.10)", stroke: rowGhost.error ? "rgb(var(--c-warning))" : ink, strokeWidth: 1.5 }} />
          {rowGhost.w * ppf >= 20 && <text x={x + rowGhost.w / 2} y={y + rowGhost.d / 2} textAnchor="middle" dominantBaseline="central" style={{ fontSize: px(11), fill: ink, userSelect: "none" }}>{rowGhost.names[i]}</text>}
        </g>
      ))}

      {spot && (
        <rect x={spot.x} y={spot.y} width={spot.w} height={spot.d} rx={px(2)} fill="none" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" pointerEvents="none" style={{ stroke: ink, strokeWidth: 1.5 }} />
      )}
      {drag?.kind === "tray" && drag.pos && (
        <rect x={drag.pos.x} y={drag.pos.y} width={drag.pos.w} height={drag.pos.d} rx={px(2)} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" pointerEvents="none"
          style={{ fill: "rgb(var(--c-ink) / 0.12)", stroke: ink, strokeWidth: 1.5 }} />
      )}

      {/* The walls, with a gap for each door and its label just inside. */}
      <rect x={0} y={0} width={W} height={D} fill="none" vectorEffect="non-scaling-stroke" pointerEvents="none" style={{ stroke: "rgb(var(--c-ink) / 0.85)", strokeWidth: 3 }} />
      {/* Under the doors, so a click on a door picks it rather than adding another. */}
      {editing && (
        <>
          {/* Click a wall to add a door there. */}
          <rect x={0} y={-band} width={W} height={2 * band} fill="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => onWallDown("top", e)}><title>Click to add a garage door</title></rect>
          <rect x={0} y={D - band} width={W} height={2 * band} fill="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => onWallDown("bottom", e)}><title>Click to add a garage door</title></rect>
          <rect x={-band} y={0} width={2 * band} height={D} fill="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => onWallDown("left", e)}><title>Click to add a garage door</title></rect>
          <rect x={W - band} y={0} width={2 * band} height={D} fill="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => onWallDown("right", e)}><title>Click to add a garage door</title></rect>
        </>
      )}
      {floor.shape.doors.map((d) => {
        const [x1, y1, x2, y2] = seg(d);
        const horiz = d.side === "top" || d.side === "bottom";
        const tick = px(5);
        const on = editing && doorId === d.id;
        const name = doorName(d);
        const short = !horiz && name.length > 10 ? `${name.slice(0, 9)}…` : name;
        const lx = horiz ? (x1 + x2) / 2 : d.side === "left" ? px(6) : W - px(6);
        const ly = horiz ? (d.side === "top" ? px(6) : D - px(6)) : (y1 + y2) / 2;
        return (
          <g key={d.id} pointerEvents={editing ? "all" : "none"} style={{ cursor: editing ? "pointer" : "default" }} onPointerDown={(e) => { if (!editing) return; e.stopPropagation(); onDoorDown(d); }}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" style={{ stroke: "rgb(var(--c-surface))", strokeWidth: 7 }} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" strokeDasharray={d.kind === "garage" ? "7 4" : undefined}
              style={{ stroke: on ? ink : "rgb(var(--c-ink-2) / 0.7)", strokeWidth: d.kind === "dock" ? 3 : 1.5 }} />
            {[0, 1].map((i) => {
              const cx = i ? x2 : x1, cy = i ? y2 : y1;
              return <line key={i} x1={horiz ? cx : cx - tick} y1={horiz ? cy - tick : cy} x2={horiz ? cx : cx + tick} y2={horiz ? cy + tick : cy} vectorEffect="non-scaling-stroke" style={{ stroke: ink, strokeWidth: 2 }} />;
            })}
            <text x={lx} y={ly} textAnchor={horiz ? "middle" : d.side === "left" ? "start" : "end"}
              dominantBaseline={horiz ? (d.side === "top" ? "hanging" : "auto") : "central"} style={{ ...text, ...halo, fontWeight: on ? 700 : 500 }}>{short}</text>
          </g>
        );
      })}

      {/* The width and depth, written along two edges. */}
      <text x={W / 2} y={-px(14)} textAnchor="middle" style={text}>{ft(W)}</text>
      <text transform={`translate(${-px(14)} ${D / 2}) rotate(-90)`} textAnchor="middle" style={text}>{ft(D)}</text>

      {editing && (
        <>
          {floor.shape.areas.filter((a) => a.id === roomId).map((a) => {
            const r = dragged(a.id) ?? areaRect(a);
            const s = px(10);
            return <rect key={a.id} x={r.x + r.w - s / 2} y={r.y + r.d - s / 2} width={s} height={s} rx={px(2)} style={{ fill: ink, cursor: "nwse-resize", stroke: "rgb(var(--c-surface))", strokeWidth: 1 }} vectorEffect="non-scaling-stroke" onPointerDown={(e) => onCornerDown(a, e)}><title>Drag to size it</title></rect>;
          })}
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------

function BuildingForm({ first, onCancel, onCreated }: { first: boolean; onCancel?: () => void; onCreated: (f: Floor) => void }) {
  const [name, setName] = useState("");
  const [w, setW] = useState("");
  const [d, setD] = useState("");
  const [busy, setBusy] = useState(false);
  const wn = parseAmount(w, NaN), dn = parseAmount(d, NaN);
  const ok = (n: number) => Number.isFinite(n) && n >= SIZE_MIN && n <= SIZE_MAX;
  const create = async () => {
    if (!ok(wn) || !ok(dn) || busy) return;
    setBusy(true);
    try { onCreated((await api.createWarehouseFloor(name.trim() || BLANK_NAME, wn, dn, emptyShape())).floor); }
    catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  return (
    <div className={`${WH_CARD} ${first ? "border-dashed" : ""} px-6 py-8 max-w-[560px] mx-auto`}>
      <div className="text-[15px] font-semibold text-ink">{first ? "Draw your warehouse" : "Add a building"}</div>
      <p className="text-[13px] text-muted mt-1">Give its size in feet. Then add its doors and its office, and every pallet from your deliveries goes on it where it really stands.</p>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <label className="col-span-2 text-[12px] text-muted">Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Main warehouse" maxLength={60} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} />
        </label>
        <label className="text-[12px] text-muted">Width (ft)
          <input value={w} onChange={(e) => setW(e.target.value)} inputMode="decimal" placeholder="120" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} />
        </label>
        <label className="text-[12px] text-muted">Depth (ft)
          <input value={d} onChange={(e) => setD(e.target.value)} inputMode="decimal" placeholder="80" onKeyDown={(e) => { if (e.key === "Enter") void create(); }} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} />
        </label>
      </div>
      <p className={`text-[12px] mt-2 ${(w && !ok(wn)) || (d && !ok(dn)) ? "text-warning-ink" : "text-muted"}`}>{SIZE_HINT}</p>
      <div className="flex gap-2 mt-4">
        <button onClick={create} disabled={!ok(wn) || !ok(dn) || busy} className={WH_BTN_PRIMARY}>{busy ? "Creating…" : "Create"}</button>
        {onCancel && <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function NewPalletPanel({ loads, onStart, onCancel }: { loads: LoadSummary[]; onStart: (loadId: string) => Promise<void>; onCancel: () => void }) {
  const open = loads.filter((l) => !l.archived).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const [pick, setPick] = useState<string>(() => { const k = lsGet(LOAD_KEY); return k && open.some((l) => l.id === k) ? k : open[0]?.id ?? ""; });
  const [busy, setBusy] = useState(false);
  const chosen = open.some((l) => l.id === pick) ? pick : open[0]?.id ?? "";
  return (
    <div className={`${WH_CARD} p-4 space-y-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[14px] font-semibold text-ink">New pallet here</div>
        <button onClick={onCancel} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
      </div>
      {open.length === 0 ? <p className="text-[12.5px] text-muted">There is no delivery to put a pallet on yet. Import a delivery's manifest under Deliveries first.</p> : (
        <>
          <label className="block text-[12px] text-muted">Which delivery is it from
            <select value={chosen} onChange={(e) => setPick(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}>
              {open.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <p className="text-[12px] text-muted">It starts that delivery's next pallet standing on the dashed spot.</p>
          <button disabled={busy || !chosen} className={WH_BTN_PRIMARY} onClick={async () => { setBusy(true); await onStart(chosen); setBusy(false); }}>Start the next pallet here</button>
        </>
      )}
    </div>
  );
}

function PalletPanel({ p, detail, standing, floorName, placing, row, onTurn, onTakeOff, onFull, onPlace, onOpen, onSetBoxes, onSameAs, onExact, onMoveRow, onRemoveRow }: {
  p: FloorPallet; detail: LoadDetail | null; standing: boolean; floorName: string; placing: boolean;
  /** The row it stands in on its building, with how many pallets the row has. */
  row: { name: string; count: number } | null;
  onTurn: () => void; onTakeOff: () => void; onFull: () => void; onPlace: () => void; onOpen: (o: DeliveryOpen) => void;
  onSetBoxes: (rows: number, perRow: number, count: number) => Promise<boolean>; onSameAs: (to: WhCase, from: WhCase) => Promise<void>;
  onExact: (x: number, y: number) => void; onMoveRow: (name: string) => void; onRemoveRow: (name: string) => void;
}) {
  const [restack, setRestack] = useState(false);
  const [sureRow, setSureRow] = useState(false);
  const [busy, setBusy] = useState(false);
  const idx = useMemo(() => Object.fromEntries((detail?.load.lines ?? []).map((l) => [l.id, l])) as Record<string, LoadLine>, [detail]);
  const mine = detail && detail.load.id === p.load_id ? detail.cases.filter((c) => c.pallet === p.number) : null;
  const boxes = (mine ?? []).filter((c) => c.kind !== "loose").sort((a, b) => a.number - b.number);
  const loose = (mine ?? []).filter((c) => c.kind === "loose");
  const filled = boxes.filter(filledOf).length;
  const live = !!detail && !detail.load.archived;
  const here = { loadId: p.load_id, pallet: p.number, back: p.id };
  const label = palletLabel(p);
  // Two boxes with one code on this delivery: both are flagged.
  const dup = useMemo(() => {
    const seen = new Map<string, number>();
    (detail?.cases ?? []).forEach((c) => { if (c.kind !== "loose" && c.code) seen.set(c.code.toLowerCase(), (seen.get(c.code.toLowerCase()) ?? 0) + 1); });
    return (c: WhCase) => !!c.code && (seen.get(c.code.toLowerCase()) ?? 0) > 1;
  }, [detail]);
  const next = boxes.find((c) => !filledOf(c));
  const last = next ? boxes.filter((c) => filledOf(c) && c.number < next.number).pop() : undefined;
  const meta = [`Pallet ${p.number} of ${p.load_name}`, boxes.length ? `${filled} of ${boxes.length} ${boxes.length === 1 ? "box" : "boxes"} filled` : "",
    p.loose ? `${p.loose.toLocaleString("en-US")} loose ${p.loose === 1 ? "pair" : "pairs"}` : "", p.pairs ? `${p.pairs.toLocaleString("en-US")} ${p.pairs === 1 ? "pair" : "pairs"}` : ""].filter(Boolean).join(" · ");
  const col = teamColor(p.load_id);
  const per = Math.max(1, p.per_layer || Math.min(boxes.length || 1, 6));
  const stack: WhCase[][] = [];
  for (let i = 0; i < boxes.length; i += per) stack.push(boxes.slice(i, i + per));
  const open = (c: WhCase) => onOpen({ ...here, caseId: c.id });

  let body: React.ReactNode;
  if (!detail) body = <p className="text-[12.5px] text-muted">Loading what is on it…</p>;
  else if ((!boxes.length && !loose.length) || restack) {
    body = live ? <BoxSetup p={p} have={boxes.length} label={label} busy={busy} onCancel={restack ? () => setRestack(false) : undefined}
      onSave={async (r, n, c) => { setBusy(true); const ok = await onSetBoxes(r, n, c); setBusy(false); if (ok) setRestack(false); }}
      onLoose={() => onOpen({ ...here, kind: "loose" })} /> : <p className="text-[12.5px] text-muted">Nothing on this pallet yet.</p>;
  } else {
    body = (
      <div className="space-y-3">
        {boxes.length > 0 && <div className="h-2 rounded bg-surface-2 overflow-hidden" aria-hidden><div className="h-full rounded transition-[width] duration-[130ms]" style={{ width: `${Math.round((filled / boxes.length) * 100)}%`, background: rgba(col, 1) }} /></div>}
        {live && next && (
          <div className="flex gap-2">
            <button onClick={() => open(next)} className={`${WH_BTN_PRIMARY} flex-1 justify-center`}>Fill {next.code || `box ${next.number}`}</button>
            {last && <button disabled={busy} onClick={async () => { setBusy(true); await onSameAs(next, last); setBusy(false); }} className={`${WH_BTN_SECONDARY} flex-1 justify-center`}>Same as {last.code || `box ${last.number}`}</button>}
          </div>
        )}
        {boxes.length > 0 && !next && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-success-bg px-3 py-2">
            <span className="text-[12.5px] font-medium text-success-ink">{p.closed ? "Every box is filled and the pallet is complete." : "Every box is filled."}</span>
            {live && !p.closed && <button onClick={onFull} className={WH_BTN_PRIMARY}>Pallet complete</button>}
          </div>
        )}
        {boxes.length > 0 && (
          <div>
            <div className="overflow-x-auto pb-0.5">
              {stack.slice().reverse().map((r, i) => (
                <div key={i} className="flex gap-1 mb-1">
                  {r.map((c) => (
                    <button key={c.id} onClick={() => live && open(c)} title={`Box ${c.code || c.number}${filledOf(c) ? "" : ", empty"}`}
                      className="flex-[1_0_44px] min-w-[44px] h-9 rounded-md text-[11.5px] font-semibold truncate px-0.5 transition-colors"
                      style={{ border: `1.5px solid ${rgba(col, 1)}`, background: filledOf(c) ? rgba(col, 1) : "rgb(var(--c-surface))", color: filledOf(c) ? "rgb(var(--c-on-accent))" : "rgb(var(--c-ink))", boxShadow: dup(c) ? "0 0 0 2px rgb(var(--c-warning))" : undefined }}>
                      {c.code || c.number}
                    </button>
                  ))}
                  {r.length < per && Array.from({ length: per - r.length }, (_, k) => <span key={`g${k}`} className="flex-[1_0_44px] min-w-[44px]" />)}
                </div>
              ))}
              <div className="h-2 rounded-sm" style={{ background: "rgb(162 132 94)" }} />
            </div>
            <p className="text-[11.5px] text-muted mt-1">Seen from the side, top row first. Solid boxes are filled. Click a box to fill it or change it.</p>
          </div>
        )}
        <div className="space-y-1.5 max-h-[260px] overflow-auto pr-0.5">
          {[...boxes, ...loose].map((c) => {
            const n = c.contents.reduce((a, x) => a + x.pairs, 0);
            return (
              <button key={c.id} onClick={() => live && open(c)} className="w-full text-left rounded-lg border border-line px-3 py-2 hover:bg-surface-2 transition-colors">
                <div className="flex justify-between items-baseline gap-2 text-[12.5px]">
                  <span className="font-medium text-ink">{c.kind === "loose" ? "Loose items" : `Box ${c.code || c.number}`}</span>
                  {n ? <span className="text-muted tabular-nums">{n.toLocaleString("en-US")} {n === 1 ? "pair" : "pairs"}</span> : <StatusPill tone="neutral">Empty</StatusPill>}
                </div>
                {dup(c) && <div className="text-[11.5px] text-warning-ink mt-0.5">Another box has this code too. Change one of them.</div>}
                {byStyle(c.contents).map((g) => {
                  const l = idx[g.line_id];
                  return <div key={g.line_id} className="text-[11.5px] text-muted mt-0.5"><span className="text-ink-2 font-medium">{l ? lineTitle(l) : "A style no longer listed"}</span>: {g.sizes.map(([s, q]) => `${s} × ${q}`).join(" · ")}</div>;
                })}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`${WH_CARD} p-4 space-y-3`}>
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ background: rgba(col, 1) }} />
            <span className="text-[20px] font-bold text-ink truncate">{label}</span>
          </div>
          {p.closed ? <StatusPill tone="neutral">Full</StatusPill> : <StatusPill tone="success">Open</StatusPill>}
        </div>
        <div className="text-[12px] text-muted mt-1 tabular-nums">{meta}</div>
        <div className="text-[12px] text-muted mt-1">{standing ? `On the floor plan${floorName ? `, ${floorName}` : ""}` : placing ? "Click the floor where it stands, or drag it there." : "Not on the floor plan yet"}</div>
      </div>

      {body}

      {live && standing && (
        <div className="pt-3 border-t border-line space-y-2">
          <div className="text-[12.5px] font-semibold text-ink">Exactly where it stands</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11.5px] text-muted">From the left wall (ft)<FeetField value={p.x} label="Feet from the left wall" className="mt-1 h-8" onCommit={(n) => onExact(n, p.y)} /></label>
            <label className="text-[11.5px] text-muted">From the top wall (ft)<FeetField value={p.y} label="Feet from the top wall" className="mt-1 h-8" onCommit={(n) => onExact(p.x, n)} /></label>
          </div>
          {row && (
            sureRow ? (
              <div className="rounded-lg border border-line px-3 py-2.5 space-y-2">
                <p className="text-[12.5px] text-ink-2">Remove row {row.name}? Its {row.count} {row.count === 1 ? "pallet comes" : "pallets come"} off the floor plan and out of the delivery. Only empty pallets can be removed.</p>
                <div className="flex gap-2">
                  <button onClick={() => { setSureRow(false); onRemoveRow(row.name); }} className={WH_BTN_PRIMARY}>Remove the row</button>
                  <button onClick={() => setSureRow(false)} className={WH_BTN_SECONDARY}>Keep it</button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-ink">Row {row.name} · {row.count} {row.count === 1 ? "pallet" : "pallets"}</span>
                <div className="flex gap-2">
                  <button onClick={() => onMoveRow(row.name)} className={`${WH_BTN_SECONDARY} h-8 px-3 text-[12.5px]`}>Move the row</button>
                  <button onClick={() => setSureRow(true)} className={`${WH_BTN_SECONDARY} h-8 px-3 text-[12.5px]`}>Remove the row</button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {live && detail && (boxes.length > 0 || loose.length > 0) && !restack && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => onOpen({ ...here, kind: "box" })} className={WH_BTN_SECONDARY}><Plus size={14} /> Add a box</button>
          <button onClick={() => onOpen({ ...here, kind: "loose" })} className={WH_BTN_SECONDARY}>Add loose items</button>
          {boxes.length > 0 && <button onClick={() => setRestack(true)} className={WH_BTN_SECONDARY}>How the boxes stack</button>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {live && <button onClick={onFull} className={WH_BTN_SECONDARY}>{p.closed ? "Reopen" : "Pallet full"}</button>}
        {standing && <button onClick={onTurn} className={WH_BTN_SECONDARY}>Turn</button>}
        {standing ? <button onClick={onTakeOff} className={WH_BTN_SECONDARY}>Take off the floor plan</button>
          : <button onClick={onPlace} className={WH_BTN_SECONDARY}>{placing ? "Stop placing" : "Put on the floor plan"}</button>}
        <button onClick={() => onOpen({ loadId: p.load_id, pallet: p.number })} className={WH_BTN_SECONDARY}>Open in Deliveries</button>
      </div>
    </div>
  );
}

/** R-554: how many boxes, as rows stacked up and boxes in each row. Every box made gets its code. */
function BoxSetup({ p, have, label, busy, onSave, onCancel, onLoose }: {
  p: FloorPallet; have: number; label: string; busy: boolean;
  onSave: (rows: number, perRow: number, count: number) => void; onCancel?: () => void; onLoose: () => void;
}) {
  const [rows, setRows] = useState(p.layers ? String(p.layers) : "");
  const [per, setPer] = useState(p.per_layer ? String(p.per_layer) : "");
  const [count, setCount] = useState(p.layers && p.per_layer ? String(Math.max(have, p.layers * p.per_layer)) : "");
  const [auto, setAuto] = useState(!(p.layers && p.per_layer));
  const r = parseInt(rows, 10), n = parseInt(per, 10), c = parseInt(count, 10);
  const total = c >= 1 ? c : r * n;
  const say = !(r >= 1 && n >= 1) ? `Each box gets a code to write on it with a marker: ${label}-1, ${label}-2 and on.`
    : total <= have ? `${have} ${have === 1 ? "box is" : "boxes are"} on it already.`
    : have ? `Adds ${total - have} empty ${total - have === 1 ? "box" : "boxes"}, ${label}-${have + 1} to ${label}-${total}.`
    : `${total} empty ${total === 1 ? "box" : "boxes"}, coded ${label}-1 to ${label}-${total}. Write each code on its box.`;
  const both = (nr: string, np: string) => { if (auto) { const a = parseInt(nr, 10), b = parseInt(np, 10); setCount(a >= 1 && b >= 1 ? String(a * b) : ""); } };
  const num = (v: string) => v.replace(/\D/g, "");
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3 space-y-2.5">
      <div>
        <div className="text-[14px] font-semibold text-ink">How are the boxes stacked?</div>
        <p className="text-[12px] text-muted mt-0.5">Count the rows of boxes from the floor up, and the boxes in one row. Fewer in all when the top row is short.</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-[11.5px] text-muted">Rows high<input value={rows} inputMode="numeric" placeholder="4" onChange={(e) => { const v = num(e.target.value); setRows(v); both(v, per); }} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} /></label>
        <label className="text-[11.5px] text-muted">Boxes per row<input value={per} inputMode="numeric" placeholder="6" onChange={(e) => { const v = num(e.target.value); setPer(v); both(rows, v); }} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} /></label>
        <label className="text-[11.5px] text-muted">Boxes in all<input value={count} inputMode="numeric" placeholder="24" onChange={(e) => { const v = num(e.target.value); setCount(v); setAuto(!v); }} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} /></label>
      </div>
      <p className="text-[12px] text-muted">{say}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy || !(r >= 1 && n >= 1)} onClick={() => onSave(r, n, total)} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : have ? "Save" : "Make the boxes"}</button>
        {onCancel && <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>}
        {!have && <button onClick={onLoose} className="text-[12.5px] text-muted hover:text-ink-2 ml-1">No boxes, only loose items</button>}
      </div>
    </div>
  );
}

/** R-554: a row of pallets, measured from the walls; or a row being moved. Drawn on the plan as it is typed. */
function RowPanel({ row, setRow, rd, loads, busy, onGo, onCancel }: {
  row: RowDraft; setRow: (r: RowDraft) => void; rd: ReturnType<typeof rowDraft>; loads: LoadSummary[]; busy: boolean; onGo: () => void; onCancel: () => void;
}) {
  const move = row.mode === "move";
  const open = loads.filter((l) => !l.archived).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const fld = (k: "name" | "count" | "x" | "y" | "gapIn", label: string, mode: "text" | "numeric" | "decimal") => (
    <label className="text-[11.5px] text-muted">{label}
      <input value={row[k]} inputMode={mode} onChange={(e) => setRow({ ...row, [k]: e.target.value })} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 h-8 tabular-nums`} />
    </label>
  );
  const has = row.x.trim() && row.y.trim();
  const end = (row.across ? parseAmount(row.x, 0) : parseAmount(row.y, 0)) + rd.length;
  return (
    <div className={`${WH_CARD} p-4 space-y-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[14px] font-semibold text-ink">{move ? `Move row ${row.name}` : "Add a row of pallets"}</div>
        <button onClick={onCancel} className="text-[12px] text-muted hover:text-ink-2">Cancel</button>
      </div>
      {move ? <p className="text-[12px] text-muted">{rd.count} {rd.count === 1 ? "pallet moves" : "pallets move"} together, in order. What is on them stays on them.</p> : (
        <>
          {open.length ? (
            <label className="block text-[11.5px] text-muted">Which delivery are they from
              <select value={open.some((l) => l.id === row.loadId) ? row.loadId : ""} onChange={(e) => setRow({ ...row, loadId: e.target.value })} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}>
                {!open.some((l) => l.id === row.loadId) && <option value="">Choose a delivery</option>}
                {open.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          ) : <p className="text-[12.5px] text-muted">There is no delivery yet. Import its sheet under Deliveries first.</p>}
          <div className="grid grid-cols-2 gap-2">{fld("name", "Row", "text")}{fld("count", "Pallets in the row", "numeric")}</div>
        </>
      )}
      <div className="space-y-1.5">
        <div className="text-[11.5px] text-muted">The row runs</div>
        <Seg value={row.across ? "across" : "down"} onChange={(k) => setRow({ ...row, across: k === "across" })} options={[{ key: "across", label: "Across, along the top wall" }, { key: "down", label: "Down, along the side" }]} />
      </div>
      <div className="space-y-1.5">
        <div className="text-[11.5px] text-muted">Each pallet has</div>
        <Seg value={row.long ? "48" : "40"} onChange={(k) => setRow({ ...row, long: k === "48" })} options={[{ key: "48", label: "48 in along the row" }, { key: "40", label: "40 in along the row" }]} />
      </div>
      <div className="grid grid-cols-2 gap-2">{fld("x", "First pallet from the left wall (ft)", "decimal")}{fld("y", "First pallet from the top wall (ft)", "decimal")}</div>
      <div className="grid grid-cols-2 gap-2">{fld("gapIn", "Gap between pallets (in)", "decimal")}</div>
      <p className="text-[12px] text-muted">Or click the floor where the first pallet stands, then adjust the feet.</p>
      {!has ? <p className="text-[12px] text-muted">Give the first pallet's corner in feet from the left and top walls.</p>
        : rd.error ? <p className="text-[12.5px] text-warning-ink">{rd.error}</p>
        : <p className="text-[12.5px] text-ink-2"><span className="font-semibold">{rd.names[0]}{rd.count > 1 ? ` to ${rd.names[rd.count - 1]}` : ""}</span>: {rd.count} {rd.count === 1 ? "pallet" : "pallets"}, {ft(rd.length)} long. The last one ends {ft(end)} from the {row.across ? "left" : "top"} wall.</p>}
      <button disabled={busy || (!move && !open.length)} onClick={onGo} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : move ? `Move row ${row.name}` : "Draw the row"}</button>
    </div>
  );
}

function Tray({ pallets, selId, placing, onDown, onPick }: { pallets: FloorPallet[]; selId: string | null; placing: string | null; onDown: (p: FloorPallet, e: React.PointerEvent) => void; onPick: (p: FloorPallet) => void }) {
  const groups: { id: string; name: string; items: FloorPallet[] }[] = [];
  for (const p of pallets) {
    let g = groups.find((x) => x.id === p.load_id);
    if (!g) { g = { id: p.load_id, name: p.load_name, items: [] }; groups.push(g); }
    g.items.push(p);
  }
  return (
    <div className={`${WH_CARD} p-4`}>
      <div className="text-[13px] font-semibold text-ink">Not on the floor plan yet ({pallets.length})</div>
      {pallets.length === 0 ? <p className="text-[12px] text-muted mt-1">Every pallet from your deliveries is on a floor plan.</p> : (
        <>
          <p className="text-[12px] text-muted mt-0.5">Drag a pallet onto the floor, or click it and then click where it stands.</p>
          <div className="space-y-3 mt-3 max-h-[300px] overflow-auto pr-0.5">
            {groups.map((g) => (
              <div key={g.id}>
                <div className="flex items-center gap-2 text-[12px] text-ink-2 min-w-0">
                  <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ background: rgba(teamColor(g.id), 1) }} />
                  <span className="truncate">{g.name}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {g.items.map((p) => (
                    <button key={p.id} onPointerDown={(e) => onDown(p, e)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(p); } }} title={palletWhat(p)} style={{ touchAction: "none", borderColor: rgba(teamColor(p.load_id), 1) }}
                      className={`h-7 px-2.5 rounded-md border text-[12px] text-ink select-none cursor-grab transition-colors ${selId === p.id || placing === p.id ? "bg-accent/10 ring-1 ring-ink" : "bg-surface-2 hover:bg-surface-3"}`}>
                      Pallet {p.number}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function EditPanel({ floor, pallets, status, edit, setShape, roomId, setRoomId, doorId, setDoorId, onRemove }: {
  floor: Floor; pallets: FloorPallet[]; status: "saved" | "saving" | "unsaved";
  edit: (patch: Partial<Omit<Draft, "id">>) => void; setShape: (s: FloorShape) => void;
  roomId: string | null; setRoomId: (id: string | null) => void; doorId: string | null; setDoorId: (id: string | null) => void;
  onRemove: () => Promise<void>;
}) {
  const { width: W, depth: D, shape } = floor;
  const [shrink, setShrink] = useState<{ width: number; depth: number; cut: ReturnType<typeof cutOff> } | null>(null);
  const [sure, setSure] = useState(false);
  const [sizeHint, setSizeHint] = useState(false);
  const ok = (n: number) => n >= SIZE_MIN && n <= SIZE_MAX;

  const trySize = (width: number, depth: number) => {
    if (!ok(width) || !ok(depth)) { setSizeHint(true); return; }
    setSizeHint(false);
    const cut = cutOff(shape, pallets, width, depth);
    if (width < W || depth < D) {
      if (cut.pallets || cut.rooms || cut.doors) { setShrink({ width, depth, cut }); return; }
    }
    setShrink(null);
    edit({ width, depth });
  };
  const cutWords = (c: { pallets: number; rooms: number; doors: number }) => {
    const parts = [c.pallets && `${c.pallets} ${c.pallets === 1 ? "pallet" : "pallets"}`, c.rooms && `${c.rooms} ${c.rooms === 1 ? "room" : "rooms"}`, c.doors && `${c.doors} ${c.doors === 1 ? "door" : "doors"}`].filter(Boolean) as string[];
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  };

  const patchDoor = (d: FloorDoor, patch: Partial<FloorDoor>) => {
    const fit = fitDoor(W, D, { ...d, ...patch }, shape.doors);
    if (!fit) { toast("That would overlap another door on the same wall.", "error"); return; }
    setShape({ ...shape, doors: shape.doors.map((o) => (o.id === d.id ? fit : o)) });
  };
  const patchRoom = (a: FloorArea, patch: Partial<FloorArea>) => {
    const fit = fitArea(W, D, { ...a, ...patch });
    if (fit) setShape({ ...shape, areas: shape.areas.map((o) => (o.id === a.id ? fit : o)) });
  };
  const addRoom = (kind: AreaKind) => {
    const spec = ROOM_ADD[kind];
    const w = Math.min(spec.w, W), d = Math.min(spec.d, D);
    const at = firstFree(W, D, w, d, [...shape.areas.map(areaRect), ...pallets.map((p) => palletRect(p.x, p.y, p.turned))]);
    const a: FloorArea = { id: rid("a"), kind, label: spec.label, x: at.x, y: at.y, w, d };
    setShape({ ...shape, areas: [...shape.areas, a] });
    setRoomId(a.id); setDoorId(null);
  };
  const room = shape.areas.find((a) => a.id === roomId) ?? null;

  return (
    <div className={`${WH_CARD} p-4 space-y-5`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[14px] font-semibold text-ink">Edit the building</div>
        <span className="text-[12px] text-muted">{status === "saving" ? "Saving…" : status === "unsaved" ? "Saving shortly" : "Saved"}</span>
      </div>

      <div className="space-y-3">
        <label className="block text-[12px] text-muted">Name
          <input key={floor.id} defaultValue={floor.name} maxLength={60} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}
            onBlur={(e) => { const v = e.target.value.trim() || BLANK_NAME; if (v !== floor.name) edit({ name: v }); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-[12px] text-muted">Width (ft)<FeetField value={W} label="Width in feet" className="mt-1" onCommit={(n) => trySize(n, D)} /></label>
          <label className="text-[12px] text-muted">Depth (ft)<FeetField value={D} label="Depth in feet" className="mt-1" onCommit={(n) => trySize(W, n)} /></label>
        </div>
        {sizeHint && <p className="text-[12px] text-warning-ink">{SIZE_HINT}</p>}
        {shrink && (
          <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2.5 space-y-2">
            <p className="text-[12.5px] text-warning-ink">Making it {ft(shrink.width)} by {ft(shrink.depth)} leaves {cutWords(shrink.cut)} outside the walls. Pallets are drawn pulled inside, and rooms and doors are moved inside.</p>
            <div className="flex gap-2">
              <button onClick={() => { edit({ width: shrink.width, depth: shrink.depth }); setShrink(null); }} className={WH_BTN_PRIMARY}>Make it smaller</button>
              <button onClick={() => setShrink(null)} className={WH_BTN_SECONDARY}>Keep it as it is</button>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="text-[13px] font-semibold text-ink">Doors</div>
        <p className="text-[12px] text-muted mt-0.5">Click a wall on the drawing to add a garage door there.</p>
        <div className="space-y-2 mt-2">
          {shape.doors.map((d) => (
            <div key={d.id} onClick={() => setDoorId(d.id)} className={`rounded-lg border px-3 py-2.5 space-y-2 ${doorId === d.id ? "border-accent/50 ring-1 ring-accent/20" : "border-line"}`}>
              <div className="flex items-center justify-between gap-2">
                <select value={d.side} aria-label="Wall" onChange={(e) => patchDoor(d, { side: e.target.value as Side })} style={WH_INPUT_BG} className={`${WH_INPUT} h-8 w-auto`}>
                  {(Object.keys(SIDE_NAME) as Side[]).map((s) => <option key={s} value={s}>{SIDE_NAME[s]}</option>)}
                </select>
                <button onClick={() => { setShape({ ...shape, doors: shape.doors.filter((o) => o.id !== d.id) }); setDoorId(null); }} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-danger-ink"><Trash2 size={12} /> Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11.5px] text-muted">Feet from the wall's start<FeetField value={d.at} label="Feet from the wall's start" className="mt-1 h-8" onCommit={(n) => patchDoor(d, { at: n })} /></label>
                <label className="text-[11.5px] text-muted">Width (ft)<FeetField value={d.width} label="Door width in feet" className="mt-1 h-8" onCommit={(n) => patchDoor(d, { width: n })} /></label>
              </div>
              <Seg value={d.kind} onChange={(k) => patchDoor(d, { kind: k })} options={[{ key: "garage", label: "Garage" }, { key: "dock", label: "Dock" }, { key: "door", label: "Door" }]} />
              <input key={`${d.id}:${d.label}`} defaultValue={d.label} placeholder={`Label, for example ${DOOR_LABEL[d.kind]} 1`} maxLength={24} aria-label="Door label" style={WH_INPUT_BG} className={`${WH_INPUT} h-8`}
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== d.label) patchDoor(d, { label: v }); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            </div>
          ))}
          {shape.doors.length === 0 && <p className="text-[12px] text-muted">No doors yet.</p>}
        </div>
      </div>

      <div>
        <div className="text-[13px] font-semibold text-ink">Rooms</div>
        <p className="text-[12px] text-muted mt-0.5">Drag a room to move it, and its bottom right corner to size it.</p>
        <div className="flex flex-wrap gap-2 mt-2">
          {(["office", "shelf", "area"] as const).map((k) => <button key={k} onClick={() => addRoom(k)} className={`${WH_BTN_SECONDARY} h-8 px-3 text-[12.5px]`}><Plus size={12} /> {ROOM_ADD[k].button}</button>)}
        </div>
        <div className="space-y-1.5 mt-2">
          {shape.areas.map((a) => (
            <button key={a.id} onClick={() => { setRoomId(roomId === a.id ? null : a.id); setDoorId(null); }}
              className={`w-full text-left rounded-lg border px-3 py-2 text-[12.5px] ${roomId === a.id ? "border-accent/50 ring-1 ring-accent/20" : "border-line hover:bg-surface-2"}`}>
              <span className="text-ink font-medium">{roomName(a)}</span><span className="text-muted"> · {ft(a.w)} by {ft(a.d)}</span>
            </button>
          ))}
          {shape.areas.length === 0 && <p className="text-[12px] text-muted">No rooms yet.</p>}
        </div>
        {room && (
          <div className="rounded-lg border border-line px-3 py-2.5 space-y-2 mt-2">
            <input key={`${room.id}:${room.label}`} defaultValue={room.label} placeholder="Label" maxLength={24} aria-label="Room label" style={WH_INPUT_BG} className={`${WH_INPUT} h-8`}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== room.label) patchRoom(room, { label: v }); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11.5px] text-muted">Across from the left (ft)<FeetField value={room.x} label="Room x in feet" className="mt-1 h-8" onCommit={(n) => patchRoom(room, { x: n })} /></label>
              <label className="text-[11.5px] text-muted">Down from the top (ft)<FeetField value={room.y} label="Room y in feet" className="mt-1 h-8" onCommit={(n) => patchRoom(room, { y: n })} /></label>
              <label className="text-[11.5px] text-muted">Width (ft)<FeetField value={room.w} label="Room width in feet" className="mt-1 h-8" onCommit={(n) => patchRoom(room, { w: n })} /></label>
              <label className="text-[11.5px] text-muted">Depth (ft)<FeetField value={room.d} label="Room depth in feet" className="mt-1 h-8" onCommit={(n) => patchRoom(room, { d: n })} /></label>
            </div>
            <button onClick={() => { setShape({ ...shape, areas: shape.areas.filter((o) => o.id !== room.id) }); setRoomId(null); }} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-danger-ink"><Trash2 size={12} /> Remove this room</button>
          </div>
        )}
      </div>

      <div className="pt-1 border-t border-line">
        {sure ? (
          <div className="space-y-2 pt-3">
            <p className="text-[12.5px] text-ink-2">Remove {floor.name}? Its pallets go back to the tray, and it stays under Removed buildings so you can bring it back.</p>
            <div className="flex gap-2">
              <button onClick={() => { void onRemove(); }} className={WH_BTN_PRIMARY}>Remove it</button>
              <button onClick={() => setSure(false)} className={WH_BTN_SECONDARY}>Keep it</button>
            </div>
          </div>
        ) : <button onClick={() => setSure(true)} className={`${WH_BTN_SECONDARY} mt-3`}><Trash2 size={13} /> Remove building</button>}
      </div>
    </div>
  );
}
