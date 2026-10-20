// The floor plan (R-550): the warehouse drawn to scale in feet, with its doors, its office and
// any other rooms, and every delivery pallet standing where it really stands. The rules a building
// and a pallet's spot are held to are floor_core.rs (byte-identical on the server); `snap` below is
// a copy of floor_core::snap, the drag rule, kept in step by lib/floor.test.ts (the same cases as
// the Rust tests). Coordinates are feet from the building's top-left corner as drawn: x along the
// top wall (the width), y down the left wall (the depth). A pallet's (x, y) is its top-left corner.
// The phone's twin is `whf*` in www/app.js.

export const PALLET_LONG = 4;
export const PALLET_SHORT = 40 / 12;
export const SIZE_MIN = 10;
export const SIZE_MAX = 1000;
export const DOOR_MIN = 2;
export const DOOR_MAX = 40;
export const AREA_MIN = 1;
/** An edge within this many feet of another edge (or a wall) is pulled onto it while dragging. */
export const SNAP_TOLERANCE = 0.5;
/** Off any edge, a drag lands on the nearest quarter foot (3 inches). */
export const SNAP_STEP = 0.25;

export type Side = "top" | "bottom" | "left" | "right";
export type DoorKind = "garage" | "dock" | "door";
export type AreaKind = "office" | "shelf" | "area";

export interface FloorDoor { id: string; side: Side; at: number; width: number; kind: DoorKind; label: string }
/** A room or a run of shelving drawn on the floor: the office, a shelf, or any named area. */
export interface FloorArea { id: string; kind: AreaKind; label: string; x: number; y: number; w: number; d: number }
export interface FloorShape { doors: FloorDoor[]; areas: FloorArea[] }
export interface Floor { id: string; name: string; width: number; depth: number; shape: FloorShape; archived: boolean; updated_at: string }

/** One delivery pallet as the floor plan shows it (floor_core::FloorPallet). */
export interface FloorPallet {
  id: string; load_id: string; load_name: string; number: number; location: string; closed: boolean; note: string;
  floor_id: string; x: number; y: number; turned: boolean;
  boxes: number; loose: number; pairs: number; styles: number;
}
export interface FloorList { floors: Floor[]; pallets: FloorPallet[] }
/** Where a new pallet is to stand (start_load_pallet's `place`). */
export interface PalletSpot { floor_id: string; x: number; y: number; turned?: boolean }

export interface Rect { x: number; y: number; w: number; d: number }

export const emptyShape = (): FloorShape => ({ doors: [], areas: [] });

/** Feet as stored: to the hundredth. */
export const hundredth = (v: number) => Math.round(v * 100) / 100;

/** Rust's f64::round: halves go away from zero (Math.round sends -2.5 to -2). */
const round = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/** A pallet's size on the floor: [along x, along y]. */
export const footprint = (turned: boolean): [number, number] => (turned ? [PALLET_SHORT, PALLET_LONG] : [PALLET_LONG, PALLET_SHORT]);

export function palletRect(x: number, y: number, turned: boolean): Rect {
  const [w, d] = footprint(turned);
  return { x, y, w, d };
}

export const areaRect = (a: FloorArea): Rect => ({ x: a.x, y: a.y, w: a.w, d: a.d });

/** True when two rectangles share floor. Touching edges do not count, nor does a sliver under a hundredth of a foot. */
export function overlaps(a: Rect, b: Rect): boolean {
  const E = 0.01;
  return a.x < b.x + b.w - E && b.x < a.x + a.w - E && a.y < b.y + b.d - E && b.y < a.y + a.d - E;
}

/** How long a wall is: the top and bottom walls run the building's width, the sides its depth. */
export const wallLength = (width: number, depth: number, side: Side) => (side === "left" || side === "right" ? depth : width);

/** The nearest edge within the tolerance, as the new start of a span of length `len` at `at`. */
function snapAxis(at: number, len: number, edges: number[]): number | null {
  let best: [number, number] | null = null;
  for (const e of edges) {
    for (const cand of [e, e - len]) {
      const dist = Math.abs(cand - at);
      if (dist <= SNAP_TOLERANCE && (best === null || dist < best[0])) best = [dist, cand];
    }
  }
  return best ? best[1] : null;
}

/**
 * Where a dragged rectangle lands (floor_core::snap). Along each axis on its own: when its start or
 * end is within half a foot of a wall or of an edge of another rectangle (`others`: the other
 * pallets and the rooms), it is pulled onto the nearest such edge, otherwise onto the nearest
 * quarter foot. Then it is pulled inside the walls and kept to the hundredth. Edges count only
 * from rectangles that overlap it on the other axis, widened by the tolerance.
 */
export function snap(width: number, depth: number, r: Rect, others: Rect[]): Rect {
  const nearY = (o: Rect) => o.y < r.y + r.d + SNAP_TOLERANCE && r.y < o.y + o.d + SNAP_TOLERANCE;
  const nearX = (o: Rect) => o.x < r.x + r.w + SNAP_TOLERANCE && r.x < o.x + o.w + SNAP_TOLERANCE;
  const xs = [0, width];
  const ys = [0, depth];
  for (const o of others) {
    if (nearY(o)) xs.push(o.x, o.x + o.w);
    if (nearX(o)) ys.push(o.y, o.y + o.d);
  }
  const step = (v: number) => round(v / SNAP_STEP) * SNAP_STEP;
  const x = snapAxis(r.x, r.w, xs) ?? step(r.x);
  const y = snapAxis(r.y, r.d, ys) ?? step(r.y);
  return { x: hundredth(clamp(x, 0, width - r.w)), y: hundredth(clamp(y, 0, depth - r.d)), w: r.w, d: r.d };
}

/** The first spot from the top-left where a w by d room fits clear of `taken`, a foot at a time. */
export function firstFree(width: number, depth: number, w: number, d: number, taken: Rect[]): { x: number; y: number } {
  for (let y = 0; y + d <= depth + 1e-9; y += 1) {
    for (let x = 0; x + w <= width + 1e-9; x += 1) {
      const r = { x, y, w, d };
      if (!taken.some((t) => overlaps(r, t))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** "120 ft", and one decimal only when it is not whole: "12.5 ft". */
export function ft(v: number): string {
  const n = Math.round(v * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ft`;
}

/** A pallet standing on a live building (a pallet on a removed or unknown one is in the tray). */
export const standsOn = (p: FloorPallet, live: Floor[]) => !!p.floor_id && live.some((f) => f.id === p.floor_id);

/** What the screens ask for across Warehouse views (WarehouseView hands them on). */
export type FloorRequest = { kind: "show" | "place"; palletId: string };
/** Open a delivery on a pallet, optionally straight into the box editor (kind), and come back to the floor plan when `back` is a pallet id. */
export type DeliveryOpen = { loadId: string; pallet: number; kind?: "box" | "loose"; back?: string };

/** A pallet as drawn: pulled inside the walls (floor_core::clean_spot, without the rounding to stored feet). */
export function insideRect(p: Pick<FloorPallet, "x" | "y" | "turned">, width: number, depth: number): Rect {
  const [w, d] = footprint(p.turned);
  return { x: clamp(p.x, 0, width - w), y: clamp(p.y, 0, depth - d), w, d };
}

/**
 * A door held to its wall the way floor_core::clean_floor holds it: 2 to 40 ft wide and no wider than
 * its wall, kept inside the wall, to the hundredth. Null when it would overlap another door on the same wall.
 */
export function fitDoor(width: number, depth: number, d: FloorDoor, others: FloorDoor[]): FloorDoor | null {
  if (!Number.isFinite(d.at) || !Number.isFinite(d.width)) return null;
  const wall = wallLength(width, depth, d.side);
  const w = hundredth(clamp(d.width, DOOR_MIN, Math.min(DOOR_MAX, wall)));
  const at = hundredth(clamp(d.at, 0, wall - w));
  if (others.some((o) => o.id !== d.id && o.side === d.side && at < o.at + o.width - 0.01 && o.at < at + w - 0.01)) return null;
  return { ...d, at, width: w };
}

/** What a smaller building would leave outside its walls: pallets (drawn pulled inside), rooms and doors (moved inside when saved). */
export function cutOff(shape: FloorShape, pallets: FloorPallet[], width: number, depth: number): { pallets: number; rooms: number; doors: number } {
  const E = 0.01;
  const out = (r: Rect) => r.x + r.w > width + E || r.y + r.d > depth + E;
  return {
    pallets: pallets.filter((p) => out(palletRect(p.x, p.y, p.turned))).length,
    rooms: shape.areas.filter((a) => out(areaRect(a))).length,
    doors: shape.doors.filter((d) => d.at + d.width > wallLength(width, depth, d.side) + E).length,
  };
}

/** A room held inside the walls the way floor_core::clean_floor holds it: at least 1 ft each way, no bigger than the building, kept inside, to the hundredth. */
export function fitArea(width: number, depth: number, a: FloorArea): FloorArea | null {
  if (![a.x, a.y, a.w, a.d].every(Number.isFinite)) return null;
  const w = hundredth(clamp(a.w, AREA_MIN, width));
  const d = hundredth(clamp(a.d, AREA_MIN, depth));
  return { ...a, w, d, x: hundredth(clamp(a.x, 0, width - w)), y: hundredth(clamp(a.y, 0, depth - d)) };
}
