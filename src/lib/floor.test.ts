import { describe, expect, it } from "vitest";
import { boxGrid, cutOff, firstFree, fitArea, fitDoor, footprint, ft, hundredth, insideRect, nextRowName, overlaps, palletLabel, palletRect, rowOf, rowSpots, snap, standsOn, type Floor, type FloorDoor, type FloorPallet, type FloorShape } from "./floor";

// The cases mirror floor_core.rs's own tests: `snap` here is a copy of floor_core::snap.

describe("a pallet is 48 by 40 and turns (floor_core)", () => {
  it("swaps its footprint when turned", () => {
    expect(footprint(false)).toEqual([4, 40 / 12]);
    expect(footprint(true)).toEqual([40 / 12, 4]);
  });
  it("keeps feet to the hundredth", () => {
    expect([hundredth(120.004), hundredth(10.123), hundredth(56.666667)]).toEqual([120, 10.12, 56.67]);
  });
});

describe("touching is not overlapping (floor_core)", () => {
  it("counts only shared floor", () => {
    const a = palletRect(0, 0, false);
    expect(overlaps(a, palletRect(4, 0, false))).toBe(false);
    expect(overlaps(a, palletRect(0, 3.33, false))).toBe(false);
    expect(overlaps(a, palletRect(3, 1, false))).toBe(true);
    expect(overlaps(a, palletRect(0, 0, true))).toBe(true);
  });
});

describe("a dragged pallet lines up with its row (floor_core::snap)", () => {
  const a = palletRect(10, 10, false);
  it("is pulled against a neighbour's edge on the same row, and level with it", () => {
    const s = snap(100, 60, palletRect(14.3, 10.4, false), [a]);
    expect([s.x, s.y]).toEqual([14, 10]);
  });
  it("lands on the nearest quarter foot far from everything", () => {
    const s = snap(100, 60, palletRect(50.13, 30.4, false), [a]);
    expect([s.x, s.y]).toEqual([50.25, 30.5]);
  });
  it("puts its end on a wall it is near", () => {
    expect(snap(100, 60, palletRect(95.8, 30, false), []).x).toBe(96);
  });
  it("ignores something across the building", () => {
    expect(snap(100, 60, palletRect(14.3, 40, false), [a]).x).toBe(14.25);
  });
  it("never leaves the walls", () => {
    const s = snap(100, 60, palletRect(-7, 70, true), []);
    expect([s.x, s.y]).toEqual([0, 56]);
  });
  it("keeps the size it was given", () => {
    const s = snap(100, 60, palletRect(20, 20, true), []);
    expect([s.w, s.d]).toEqual([40 / 12, 4]);
  });
});

describe("a room goes to the first free spot from the top-left", () => {
  it("starts at the corner and steps past what is there", () => {
    expect(firstFree(100, 60, 15, 12, [])).toEqual({ x: 0, y: 0 });
    expect(firstFree(100, 60, 15, 12, [{ x: 0, y: 0, w: 15, d: 12 }])).toEqual({ x: 15, y: 0 });
    // The top row is full: down a row.
    expect(firstFree(30, 60, 15, 12, [{ x: 0, y: 0, w: 15, d: 12 }, { x: 15, y: 0, w: 15, d: 12 }])).toEqual({ x: 0, y: 12 });
  });
  it("falls back to the corner when nothing is free", () => {
    expect(firstFree(10, 10, 10, 10, [{ x: 0, y: 0, w: 10, d: 10 }])).toEqual({ x: 0, y: 0 });
  });
});

describe("feet as the screens say them", () => {
  it("shows one decimal only when it is not whole", () => {
    expect([ft(120), ft(12.5), ft(12.04), ft(3.33)]).toEqual(["120 ft", "12.5 ft", "12 ft", "3.3 ft"]);
  });
});

describe("a pallet on a removed or unknown building is in the tray", () => {
  const live: Floor[] = [{ id: "flr-1", name: "Main", width: 100, depth: 60, shape: { doors: [], areas: [] }, archived: false, updated_at: "" }];
  const p = (floor_id: string): FloorPallet => ({ id: "pal-x-1", load_id: "x", load_name: "X", number: 1, location: "", closed: false, note: "", floor_id, x: 0, y: 0, turned: false, boxes: 0, loose: 0, pairs: 0, styles: 0, filled: 0, layers: 0, per_layer: 0 });
  it("stands only on a live building", () => {
    expect([standsOn(p("flr-1"), live), standsOn(p("flr-gone"), live), standsOn(p(""), live)]).toEqual([true, false, false]);
  });
});

describe("doors and a smaller building", () => {
  const door = (id: string, side: "top" | "left", at: number, width: number): FloorDoor => ({ id, side, at, width, kind: "door", label: "" });
  it("holds a door to its wall as clean_floor does", () => {
    expect(fitDoor(100, 60, door("a", "top", 95, 12), [])).toEqual(door("a", "top", 88, 12));
    expect(fitDoor(100, 60, door("a", "left", 10, 80), [])?.width).toBe(40);
    expect(fitDoor(100, 60, door("a", "top", -5, 1), [])).toEqual(door("a", "top", 0, 2));
  });
  it("refuses a door that would overlap another on its wall, but not on another wall", () => {
    const g = door("g", "top", 88, 12);
    expect(fitDoor(100, 60, door("b", "top", 90, 3), [g])).toBeNull();
    expect(fitDoor(100, 60, door("b", "left", 90, 3), [g])).not.toBeNull();
    expect(fitDoor(100, 60, g, [g])).toEqual(g);
  });
  it("counts what a shrink would leave outside the walls", () => {
    const shape: FloorShape = { doors: [door("g", "top", 88, 12)], areas: [{ id: "o", kind: "office", label: "Office", x: 85, y: 48, w: 15, d: 12 }] };
    const p = (x: number, y: number): FloorPallet => ({ id: "p", load_id: "x", load_name: "X", number: 1, location: "", closed: false, note: "", floor_id: "f", x, y, turned: false, boxes: 0, loose: 0, pairs: 0, styles: 0, filled: 0, layers: 0, per_layer: 0 });
    expect(cutOff(shape, [p(10, 10), p(55, 10)], 100, 60)).toEqual({ pallets: 0, rooms: 0, doors: 0 });
    expect(cutOff(shape, [p(10, 10), p(55, 10)], 60, 60)).toEqual({ pallets: 0, rooms: 1, doors: 1 });
    expect(cutOff(shape, [p(10, 10), p(55, 10)], 58, 60)).toEqual({ pallets: 1, rooms: 1, doors: 1 });
  });
  it("draws a pallet pulled inside the walls", () => {
    expect(insideRect({ x: 98, y: 59, turned: false }, 100, 60)).toEqual({ x: 96, y: 60 - 40 / 12, w: 4, d: 40 / 12 });
  });
});

describe("a room is held inside the walls", () => {
  it("pulls it inside and keeps it at least a foot each way", () => {
    const a = { id: "o", kind: "office" as const, label: "Office", x: 90, y: -3, w: 20, d: 12 };
    expect(fitArea(100, 60, a)).toEqual({ ...a, x: 80, y: 0 });
    expect(fitArea(100, 60, { ...a, w: 0.2, d: 200 })).toMatchObject({ w: 1, d: 60, y: 0 });
    expect(fitArea(100, 60, { ...a, x: NaN })).toBeNull();
  });
});

// R-554: the same cases as floor_core.rs's row tests and case_core.rs's pallet_label.
describe("a row is drawn exactly where it was measured or not at all (floor_core::row_spots)", () => {
  const spots = (r: ReturnType<typeof rowSpots>) => ("spots" in r ? r.spots : r.error);
  it("lays pallets out across or down, touching or apart", () => {
    expect(spots(rowSpots(100, 60, 6, 10, true, 3, false, 0))).toEqual([[6, 10], [10, 10], [14, 10]]);
    expect(spots(rowSpots(100, 60, 2, 0, false, 3, true, 0.5))).toEqual([[2, 0], [2, 4.5], [2, 9]]);
    expect(spots(rowSpots(100, 60, 0, 0, false, 3, false, 0))).toEqual([[0, 0], [0, 3.33], [0, 6.67]]);
    const r = rowSpots(100, 60, 60, 0, true, 10, false, 0);
    expect("spots" in r && r.spots[9]).toEqual([96, 0]);
  });
  it("says why a row cannot be drawn, and how many would fit", () => {
    const e = spots(rowSpots(100, 60, 60, 0, true, 11, false, 0)) as string;
    expect(e).toContain("11 pallets need 44 ft");
    expect(e).toContain("40 ft to the right wall");
    expect(e).toContain("10 would fit");
    const e2 = spots(rowSpots(100, 60, 0, 50, false, 4, false, 1)) as string;
    expect(e2).toContain("bottom wall");
    expect(e2).toContain("2 would fit");
    expect(spots(rowSpots(100, 60, 0, 58, true, 1, false, 0))).toContain("3.3 ft wide");
    expect(spots(rowSpots(100, 60, 98, 0, false, 1, false, 0))).toContain("right wall");
    for (const bad of [rowSpots(100, 60, -1, 0, true, 1, false, 0), rowSpots(100, 60, 100, 0, true, 1, false, 0), rowSpots(100, 60, NaN, 0, true, 1, false, 0),
      rowSpots(100, 60, 0, 0, true, 0, false, 0), rowSpots(1000, 60, 0, 0, true, 61, false, 0), rowSpots(100, 60, 0, 0, true, 2, false, 10.5), rowSpots(100, 60, 0, 0, true, 2, false, -0.5)]) {
      expect("error" in bad).toBe(true);
    }
  });
  it("names rows with letters and finds a pallet's row by its location", () => {
    expect(rowOf("A12")).toEqual(["A", 12]);
    expect(rowOf(" BB3 ")).toEqual(["BB", 3]);
    for (const no of ["A", "12", "A01", "a3", "A3 by the door", "ABCD1"]) expect(rowOf(no)).toBeNull();
    expect(nextRowName([])).toBe("A");
    expect(nextRowName(["A", "C"])).toBe("B");
    const all = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    expect(nextRowName(all)).toBe("AA");
    expect(nextRowName([...all, "AA"])).toBe("AB");
  });
  it("starts a pallet's box codes with its short name (case_core::pallet_label)", () => {
    expect(palletLabel({ location: "A3", number: 7 })).toBe("A3");
    expect(palletLabel({ location: " B-12 ", number: 7 })).toBe("B-12");
    expect(palletLabel({ location: "", number: 7 })).toBe("P7");
    expect(palletLabel({ location: "Back by the office", number: 2 })).toBe("P2");
    expect(palletLabel({ location: "ABCDEFGHI", number: 2 })).toBe("P2");
  });
  it("lays a row of boxes out to fill the deck", () => {
    expect(boxGrid(6, 4, 40 / 12)).toEqual({ cols: 3, rows: 2 });
    expect(boxGrid(4, 4, 40 / 12)).toEqual({ cols: 2, rows: 2 });
    expect(boxGrid(1, 4, 40 / 12)).toEqual({ cols: 1, rows: 1 });
    const g = boxGrid(5, 4, 40 / 12);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(5);
  });
});
