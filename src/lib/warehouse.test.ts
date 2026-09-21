import { describe, expect, it } from "vitest";
import {
  changesForInvoice, colName, describePick, doorWhere, emptyPick, emptyShape, invoiceLines, layoutSummary, mapView, pickFromPlan, pickUnits,
  planUnits, removeRow, rowLength, rowsFromText, sectionBoxes, sectionUnits, setPicked, shareOut, shares, spotName, takeUnits, wallAt,
  effectiveFill, mapPlaces, placesHolding, takeFromPlaces, type WarehouseLayout, buildLot, builtUnits, countCheck, matchToPallets,
  countedFills, fillQuarter, palletFill, pctLabel,
  type BoxType, type WhSection,
} from "./warehouse";

const T: BoxType[] = [
  { id: "big", name: "Big Box", per_box: 72 },
  { id: "sq", name: "Big Square", per_box: 48 },
  { id: "rect", name: "Small Rectangle", per_box: 36 },
  { id: "small", name: "Small Square", per_box: 24 },
  { id: "tiny", name: "Small Box", per_box: 12 },
];
const sec = (id: string, counts: Record<string, number>, loose = 0): WhSection => ({ id, name: id.toUpperCase(), counts, loose });
const total = (types: BoxType[], ss: WhSection[]) => ss.reduce((a, s) => a + sectionUnits(types, s), 0);
const one: BoxType[] = [{ id: "b", name: "Box", per_box: 24 }];

describe("planUnits — pallets and units, evening out what is left", () => {
  // Jack's example: one team is 40% of the hats.
  const hats = [sec("nyy", { b: 40 }), sec("lad", { b: 20 }), sec("bos", { b: 20 }), sec("chc", { b: 20 })];

  it("drains the big team first until it is level with the rest", () => {
    const p = planUnits(one, hats, 20 * 24, { finish: "under" });
    expect(p.take).toEqual({ nyy: { b: 20 } });
    expect(Object.values(shares(one, p.left)).every((s) => s === 0.25)).toBe(true);
  });

  it("then brings every team down together", () => {
    const p = planUnits(one, hats, 40 * 24, { finish: "under" });
    expect(p.left.map(sectionBoxes)).toEqual([15, 15, 15, 15]);
  });

  it("500 units is whole boxes and 20 loose from an opened box", () => {
    const p = planUnits(one, hats, 500);
    expect(Object.values(p.units).reduce((a, b) => a + b, 0)).toBe(500);
    expect(p.short).toBe(0);
    expect(Object.values(p.opened).length).toBe(1);
    expect(total(one, p.left)).toBe(2400 - 500);
  });

  it("whole boxes only goes over by the smallest box that covers the rest", () => {
    const p = planUnits(one, hats, 500, { finish: "whole" });
    expect(p.short).toBe(-4);
    expect(p.loose).toEqual({});
    expect(Object.values(p.units).reduce((a, b) => a + b, 0)).toBe(504);
  });

  it("pallets never go over and never open a box", () => {
    const p = planUnits(one, hats, 500, { finish: "under" });
    expect(p.short).toBe(20);
    expect(p.opened).toEqual({});
  });

  it("with five box sizes, 500 is made exactly from the biggest boxes that fit", () => {
    const mixed = [sec("a", { big: 10, small: 2, tiny: 3 }), sec("b", { sq: 2, tiny: 2 })];
    const p = planUnits(T, mixed, 500);
    expect(p.short).toBe(0);
    expect(Object.values(p.units).reduce((a, b) => a + b, 0)).toBe(500);
    // 500 is not a multiple of 12, so exactly one box is opened for the last few.
    const opened = Object.values(p.opened).flatMap((m) => Object.values(m)).reduce((a, b) => a + b, 0);
    expect(opened).toBe(1);
    expect(total(T, p.left)).toBe(total(T, mixed) - 500);
  });

  it("uses a box that is already open before opening another", () => {
    const p = planUnits(one, [sec("nyy", { b: 40 }), sec("lad", { b: 20 }, 10)], 30);
    expect(p.take).toEqual({ nyy: { b: 1 } });
    expect(p.loose).toEqual({ lad: 6 });
    expect(p.opened).toEqual({});
  });

  it("leaves out a team the buyer does not want", () => {
    const p = planUnits(one, hats, 480, { skip: new Set(["nyy"]), finish: "under" });
    expect(p.units.nyy).toBeUndefined();
    expect(Object.values(p.units).reduce((a, b) => a + b, 0)).toBe(480);
  });

  it("a team pinned to a number gets exactly that, and the rest is balanced around it", () => {
    const p = planUnits(one, hats, 480, { fixed: { chc: 100 } });
    expect(p.units.chc).toBe(100);
    expect(Object.values(p.units).reduce((a, b) => a + b, 0)).toBe(480);
    expect(p.units.nyy).toBe(380);
  });

  it("says what it could not find", () => {
    const p = planUnits(one, [sec("a", { b: 1 })], 30);
    expect(p.units).toEqual({ a: 24 });
    expect(p.short).toBe(6);
  });

  it("asks for nothing on zero or negative", () => {
    expect(planUnits(one, hats, 0).units).toEqual({});
    expect(planUnits(one, hats, -5).units).toEqual({});
  });
});

describe("planUnits — the lean (R-334)", () => {
  // One team holding 35% of the stock and seventeen smaller ones, every team in five sizes.
  const teams = [
    sec("big", { big: 40, sq: 20, rect: 20, small: 20, tiny: 20 }),
    ...Array.from({ length: 17 }, (_, i) => sec(`t${i}`, { big: 3, sq: 3, rect: 3, small: 3, tiny: 3 })),
  ];
  const held = total(T, teams);
  const sum = (p: { units: Record<string, number> }) => Object.values(p.units).reduce((a, b) => a + b, 0);

  it("match my stock takes from every team, each in proportion to what it holds", () => {
    const p = planUnits(T, teams, 6000, { lean: 0.5 });
    expect(sum(p)).toBe(6000);
    expect(teams.every((s) => (p.units[s.id] || 0) > 0)).toBe(true);
    expect(Math.abs(p.units.big / 6000 - sectionUnits(T, teams[0]) / held)).toBeLessThan(0.03);
  });

  it("same from every team gives each about the same, never more than it holds", () => {
    const p = planUnits(T, teams, 6000, { lean: 0 });
    expect(sum(p)).toBe(6000);
    const us = teams.map((s) => p.units[s.id] || 0);
    expect(Math.max(...us) - Math.min(...us)).toBeLessThanOrEqual(72);
    // Past what the small teams hold, the rest comes from the big one.
    const q = planUnits(T, teams, 12000, { lean: 0 });
    expect(teams.slice(1).every((s) => q.units[s.id] === sectionUnits(T, s))).toBe(true);
    expect(sum(q)).toBe(12000);
  });

  it("even out my stock leans on the big team, and still spreads once it is level", () => {
    const p = planUnits(T, teams, 6000, { lean: 1 });
    expect(sum(p)).toBe(6000);
    expect(p.units.big).toBeGreaterThan(4000);
    expect(teams.slice(1).every((s) => (p.units[s.id] || 0) > 0)).toBe(true);
  });

  it("the share out adds up to the load and never passes what a team holds", () => {
    const hs = [960, 480, 480, 480, 12, 0];
    for (const lean of [0, 0.25, 0.5, 0.75, 1]) {
      const out = shareOut(hs, 1500, lean);
      expect(Math.abs(out.reduce((a, b) => a + b, 0) - 1500)).toBeLessThan(1e-6);
      out.forEach((x, i) => expect(x).toBeLessThanOrEqual(hs[i] + 1e-9));
    }
    expect(shareOut(hs, 5000, 0.5)).toEqual(hs);
    expect(shareOut(hs, 0, 0.5)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("takeUnits — one team, the server's rule", () => {
  it("big boxes first, then opens the smallest that covers the rest", () => {
    const s = sec("a", { big: 2, small: 3, tiny: 1 });
    const r = takeUnits(T, s, 100);
    expect(r.boxes).toEqual({ big: 1, small: 1 });
    expect([r.loose, r.short]).toEqual([4, 0]);
    expect(r.opened).toEqual({ tiny: 1 });
    expect(s.loose).toBe(8);
  });
});

describe("send to invoice", () => {
  const item = { name: "New Era 59FIFTY", unit_price: 9, box_types: T, sections: [sec("nyy", { big: 3, tiny: 5 }), sec("lad", { small: 4 })] };
  const plan = { take: { nyy: { big: 2 }, lad: { small: 1 } }, loose: { lad: 5 }, units: { nyy: 144, lad: 29 } };

  it("writes one line per team, biggest first, with the boxes in the description", () => {
    const lines = invoiceLines(item, plan);
    expect(lines.map((l) => [l.description, l.qty, l.amount])).toEqual([
      ["New Era 59FIFTY — NYY: 2 × Big Box", 144, 1296],
      ["New Era 59FIFTY — LAD: 1 × Small Square, 5 loose", 29, 261],
    ]);
  });

  it("an unchanged line takes the planned boxes, a changed one takes its units", () => {
    const lines = invoiceLines(item, plan);
    lines[1].qty = 20;
    const kept = [...lines, { description: "Freight", qty: 1, rate: 400, amount: 400 }];
    expect(changesForInvoice(kept)).toEqual([
      { section_id: "nyy", boxes: { big: -2 }, loose: 0 },
      { section_id: "lad", units: -20 },
    ]);
  });

  it("describes a pick in box sizes, biggest first", () => {
    expect(describePick(T, { tiny: 1, big: 3 }, 20)).toBe("3 × Big Box, 1 × Small Box, 20 loose");
  });
});

describe("reading pasted rows", () => {
  it("reads a tab-separated paste and a quoted CSV", () => {
    expect(rowsFromText("Team\tBoxes\nMets\t4\n")).toEqual([["Team", "Boxes"], ["Mets", "4"]]);
    expect(rowsFromText('Team,Note\n"Sox, Red","say ""hi"""')).toEqual([["Team", "Note"], ["Sox, Red", 'say "hi"']]);
  });
  it("names columns like a spreadsheet", () => {
    expect([colName(0), colName(25), colName(26)]).toEqual(["A", "Z", "AA"]);
  });
});

describe("picking an order by hand (R-329)", () => {
  const owls = sec("owls", { big: 3, tiny: 5 }, 8);

  it("never takes more of a size than the shelf holds, and clears a zero", () => {
    let p = setPicked(emptyPick(), owls, "big", 9);
    expect(p.take.owls).toEqual({ big: 3 });
    p = setPicked(p, owls, "tiny", 2);
    p = setPicked(p, owls, null, 20);
    expect(p.loose.owls).toBe(8);
    expect(pickUnits(T, p)).toEqual({ owls: 3 * 72 + 2 * 12 + 8 });
    p = setPicked(p, owls, "big", 0);
    p = setPicked(p, owls, "tiny", 0);
    p = setPicked(p, owls, null, 0);
    expect(p).toEqual(emptyPick());
  });

  it("a hand pick invoices at a price set for one team", () => {
    const item = { name: "Hats", unit_price: 9, box_types: T, sections: [owls] };
    const p = setPicked(emptyPick(), owls, "big", 2);
    const lines = invoiceLines(item, { ...p, units: pickUnits(T, p) }, { owls: 7.5 });
    expect([lines[0].qty, lines[0].rate, lines[0].amount]).toEqual([144, 7.5, 1080]);
    expect(changesForInvoice(lines)).toEqual([{ section_id: "owls", boxes: { big: -2 }, loose: 0 }]);
  });

  it("a packer plan can be adjusted by hand without changing the plan", () => {
    const plan = planUnits(T, [owls], 100);
    const p = pickFromPlan(plan);
    p.take.owls.big = 0;
    expect(plan.take.owls.big).toBe(1);
  });
});

describe("the warehouse map (R-330)", () => {
  const cell = (r: number, c: number, o: Partial<{ label: string; fill: number; aisle: boolean }>) =>
    ({ r, c, item_id: "", section_id: "", label: "", fill: 0, note: "", aisle: false, ...o });

  it("counts spots, leaving aisles out", () => {
    const m = { rows: 2, cols: 3, cells: [cell(0, 0, { label: "Owls", fill: 4 }), cell(0, 1, { label: "Hawks", fill: 2 }), cell(1, 2, { aisle: true })] };
    expect(layoutSummary(m)).toEqual({ spots: 5, used: 2, full: 1, partial: 1, empty: 0, open: 3, shelves: 0, levels: 0 });
  });

  it("names a pallet spot like a spreadsheet and a shelf by bay and level", () => {
    expect(spotName("pallets", 4, 0, 0)).toBe("A1");
    expect(spotName("pallets", 4, 2, 9)).toBe("C10");
    expect(spotName("shelving", 4, 3, 0)).toBe("Bay 1, level 1");
    expect(spotName("shelving", 4, 0, 2)).toBe("Bay 3, level 4");
  });
});

describe("the map's shape (R-332, R-333)", () => {
  const cell = (r: number, c: number, o: Partial<{ label: string; fill: number; aisle: boolean }>) =>
    ({ r, c, item_id: "", section_id: "", label: "", fill: 0, note: "", aisle: false, ...o });
  const lvl = (label: string, fill: number) => ({ item_id: "", section_id: "", label, fill });

  it("rows keep their own lengths, and a shelf counts each level as a place", () => {
    const m = {
      rows: 3, cols: 4, cells: [cell(0, 3, { label: "Owls", fill: 4 }), cell(2, 3, { label: "Off the row", fill: 4 })],
      shape: { ...emptyShape(), row_lengths: [4, 2, 1], shelves: { "1:0": { levels: [lvl("Hawks", 2), lvl("", 0), lvl("Bears", 4)], note: "" } } },
    };
    expect([0, 1, 2].map((r) => rowLength(m, r))).toEqual([4, 2, 1]);
    expect(rowLength({ cols: 5 }, 3)).toBe(5);
    // 4 + (1 pallet spot + 3 levels) + 1 = 9 places; the spot past row 2's end is not one.
    expect(layoutSummary(m)).toEqual({ spots: 9, used: 3, full: 2, partial: 1, empty: 0, open: 6, shelves: 1, levels: 3 });
  });

  it("turning the map moves every spot and wall, and turns back exactly", () => {
    const v = mapView(2, 3, 0, 1, false);
    expect([v.dh, v.dw, v.turned]).toEqual([3, 2, true]);
    expect(v.at(0, 0)).toEqual([0, 1]); // the top-left spot ends up top-right after a quarter turn
    expect(v.at(1, 2)).toEqual([2, 0]);
    for (const [rot, flip, ring] of [[0, false, 1], [1, true, 1], [2, false, 1], [3, true, 0], [7, false, 1]] as const) {
      const w = mapView(3, 5, ring, rot, flip);
      for (let r = 0 - ring; r < 3 + ring; r++) for (let c = 0 - ring; c < 5 + ring; c++) {
        const [y, x] = w.at(r, c);
        expect(y >= 0 && y < w.dh && x >= 0 && x < w.dw).toBe(true);
        expect(w.back(y, x)).toEqual([r, c]);
      }
    }
    expect(mapView(2, 3, 0, 0, true).at(0, 0)).toEqual([0, 2]); // a flip mirrors left and right
  });

  it("names the walls and doors the same way however the map is turned", () => {
    const l = { rows: 5, cols: 9 };
    expect(wallAt(l, -1, 3)).toEqual({ side: "top", pos: 3 });
    expect(wallAt(l, 5, 0)).toEqual({ side: "bottom", pos: 0 });
    expect(wallAt(l, 2, -1)).toEqual({ side: "left", pos: 2 });
    expect(wallAt(l, 4, 9)).toEqual({ side: "right", pos: 4 });
    expect(wallAt(l, -1, -1)).toBeNull();
    const d = (side: "top" | "bottom" | "left" | "right", at: number, width: number) => ({ id: "d", side, at, width, kind: "garage" as const, label: "" });
    expect(doorWhere(l, d("top", 2, 2))).toBe("Row A wall, spots 3–4");
    expect(doorWhere(l, d("bottom", 0, 1))).toBe("Row E wall, spot 1");
    expect(doorWhere(l, d("right", 1, 3))).toBe("Far end, rows B–D");
  });

  it("taking a row out moves the rows below up, with their shelves, titles and side doors", () => {
    const m = {
      rows: 4, cols: 3,
      cells: [cell(0, 0, { label: "A" }), cell(1, 0, { label: "B" }), cell(3, 2, { label: "D" })],
      shape: {
        ...emptyShape(), row_lengths: [3, 3, 2, 3], row_names: ["", "Gone", "", "Back"],
        shelves: { "2:1": { levels: [lvl("C", 1)], note: "" }, "1:1": { levels: [lvl("B", 1)], note: "" } },
        doors: [
          { id: "a", side: "left" as const, at: 0, width: 1, kind: "door" as const, label: "" },
          { id: "b", side: "left" as const, at: 1, width: 1, kind: "door" as const, label: "" },
          { id: "c", side: "right" as const, at: 0, width: 3, kind: "dock" as const, label: "" },
          { id: "e", side: "right" as const, at: 3, width: 1, kind: "dock" as const, label: "" },
          { id: "f", side: "top" as const, at: 1, width: 1, kind: "garage" as const, label: "" },
        ],
      },
    };
    const out = removeRow(m, 1);
    expect(out.rows).toBe(3);
    expect(out.cells.map((c) => `${c.label}${c.r}`)).toEqual(["A0", "D2"]);
    expect(Object.keys(out.shape.shelves)).toEqual(["1:1"]);
    expect(out.shape.shelves["1:1"].levels[0].label).toBe("C");
    expect(out.shape.row_lengths).toEqual([3, 2, 3]);
    expect(out.shape.row_names).toEqual(["", "", "Back"]);
    expect(out.shape.doors.map((x) => `${x.id}${x.at}/${x.width}`)).toEqual(["a0/1", "c0/2", "e2/1", "f1/1"]);
    expect(removeRow({ ...m, rows: 1 }, 0).rows).toBe(1);
  });
});

describe("boxes on each pallet (R-339, R-340)", () => {
  // The same map as warehouse_core's test: two owls pallets, a hawks pallet, an aisle, and a shelf whose bottom level holds owls.
  const cell = (r: number, c: number, section_id: string, o: Partial<{ aisle: boolean; fill: number }> = {}) =>
    ({ r, c, item_id: section_id ? "w" : "", section_id, label: "", fill: 4, note: "", aisle: false, ...o });
  const floor = (stock: WarehouseLayout["stock"], created_at = "2026-01-01"): WarehouseLayout => ({
    id: "floor", name: "Floor", kind: "pallets", rows: 2, cols: 3, notes: "", archived: false, created_at, updated_at: created_at,
    cells: [cell(0, 0, "owls"), cell(0, 1, "owls", { fill: 2 }), cell(0, 2, "hawks"), cell(1, 0, "", { aisle: true })],
    shape: { ...emptyShape(), shelves: { "1:1": { levels: [{ item_id: "w", section_id: "owls", label: "", fill: 2 }, { item_id: "", section_id: "", label: "", fill: 0 }], note: "" } } },
    stock,
  });
  const ps = (boxes: Record<string, number>) => ({ item_id: "w", section_id: "owls", boxes });

  it("lists the places holding a team in reading order", () => {
    expect(mapPlaces(floor({})).map((p) => p.key)).toEqual(["0:0", "0:1", "0:2", "1:1:0"]);
  });

  it("takes part pallets first, then map order — the server's rule", () => {
    const l = floor({ "0:0": ps({ big: 20 }), "0:1": ps({ big: 5, small: 3 }), "1:1:0": ps({ big: 2 }) });
    const got = takeFromPlaces([l], "w", "owls", { big: 9, small: 1 });
    expect(got.map((t) => [t.place, t.boxes])).toEqual([["1:1:0", { big: 2 }], ["0:1", { big: 5, small: 1 }], ["0:0", { big: 2 }]]);
    expect(got[0].name).toBe("Floor B2 level 1");
  });

  it("says where a team is when nothing is recorded, part-full first, and a counted empty place is empty", () => {
    const l = floor({ "0:0": ps({}) });
    expect(placesHolding([l], "w", "owls").map((p) => [p.place, p.fill])).toEqual([["0:1", 2], ["1:1:0", 2], ["0:0", 0]]);
    expect(effectiveFill(4, ps({}))).toBe(0);
    expect(effectiveFill(4, ps({ big: 1 }))).toBe(4);
    expect(effectiveFill(4, undefined)).toBe(4);
  });
});

describe("building a lot (R-342)", () => {
  const types: BoxType[] = [{ id: "big", name: "Big Box", per_box: 72 }, { id: "sq", name: "Big Square", per_box: 48 }, { id: "tiny", name: "Small Box", per_box: 12 }];
  const item = { id: "w", box_types: types, sections: [sec("owls", { big: 30, sq: 10, tiny: 20 }), sec("hawks", { big: 20, tiny: 10 })] };
  const layout: WarehouseLayout = {
    id: "floor", name: "Floor", kind: "pallets", rows: 1, cols: 2, notes: "", archived: false, created_at: "2026-01-01", updated_at: "2026-01-01",
    cells: [0, 1].map((c) => ({ r: 0, c, item_id: "w", section_id: "owls", label: "", fill: 4, note: "", aisle: false })),
    shape: emptyShape(),
    stock: { "0:0": { item_id: "w", section_id: "owls", boxes: { big: 20 } }, "0:1": { item_id: "w", section_id: "owls", boxes: { big: 5 } } },
  };
  const plan = { take: { owls: { big: 25, sq: 4, tiny: 6 }, hawks: { big: 20, tiny: 2 } }, loose: { owls: 8 } };

  it("groups big boxes 21 to a pallet, smaller ones together on their own, each tied to its source", () => {
    const b = buildLot(item, [layout], plan, 21);
    expect(b.totals.map((t) => [t.name, t.boxes])).toEqual([["Big Box", 45], ["Big Square", 4], ["Small Box", 8]]);
    // 45 big boxes -> 21 + 21 + 3; the smaller boxes (4 x 48 + 8 x 12 = 288 units) share one pallet of up to 21 x 72.
    expect(b.pallets.map((p) => [p.n, p.big, p.boxes])).toEqual([[1, true, 21], [2, true, 21], [3, true, 3], [4, false, 12]]);
    expect(b.pallets.flatMap((p) => p.lines).filter((l) => l.type_id === "big").reduce((a, l) => a + l.boxes, 0)).toBe(45);
    // OWLS big: 5 off the part pallet first, then 20 off the full one; HAWKS have no counted pallet.
    const owlsBig = b.pallets.flatMap((p) => p.lines).filter((l) => l.section_id === "owls" && l.type_id === "big");
    expect(owlsBig.map((l) => [l.place?.place ?? null, l.boxes])).toEqual([["0:1", 5], ["0:0", 16], ["0:0", 4]]);
    expect(b.pallets.flatMap((p) => p.lines).filter((l) => l.section_id === "hawks").every((l) => l.place === null)).toBe(true);
    expect(b.loose).toEqual([{ id: "L-owls", section_id: "owls", name: "OWLS", units: 8 }]);
    expect(b.units).toBe(45 * 72 + 4 * 48 + 8 * 12 + 8);
  });

  it("with no pallet size it is one list, and the invoice counts only what was ticked", () => {
    const b = buildLot(item, [layout], plan, 0);
    expect(b.pallets.length).toBe(1);
    const first = b.pallets[0].lines[0];
    const got = builtUnits({ build: b, done: { [first.id]: "m1", "L-owls": "m2" } });
    expect(got).toEqual([{ section_id: first.section_id, name: first.name, boxes: { [first.type_id]: first.boxes }, loose: first.section_id === "owls" ? 8 : 0, units: first.boxes * first.per_box + (first.section_id === "owls" ? 8 : 0) }]);
  });
});

describe("checking the counts against the pallets (R-343)", () => {
  const types: BoxType[] = [{ id: "big", name: "Big Box", per_box: 72 }, { id: "tiny", name: "Small Box", per_box: 12 }];
  const item = { id: "w", box_types: types, sections: [sec("owls", { big: 25, tiny: 4 }, 7), sec("hawks", { big: 10 }), sec("bears", { big: 3 }), sec("lions", { big: 5 })] };
  const cell = (c: number, s: string) => ({ r: 0, c, item_id: "w", section_id: s, label: "", fill: 4, note: "", aisle: false });
  const map: WarehouseLayout = {
    id: "floor", name: "Floor", kind: "pallets", rows: 1, cols: 5, notes: "", archived: false, created_at: "2026-01-01", updated_at: "2026-01-01",
    cells: [cell(0, "owls"), cell(1, "owls"), cell(2, "hawks"), cell(3, "bears"), cell(4, "bears")],
    shape: emptyShape(),
    stock: {
      "0:0": { item_id: "w", section_id: "owls", boxes: { big: 20, tiny: 4 } },
      "0:1": { item_id: "w", section_id: "owls", boxes: { big: 3 } },
      "0:2": { item_id: "w", section_id: "hawks", boxes: { big: 10 } },
      "0:3": { item_id: "w", section_id: "bears", boxes: { big: 3 } },
    },
  };

  it("says which teams differ, by size, and which have spots with no boxes entered", () => {
    const c = countCheck(item, [map]);
    const byName = Object.fromEntries(c.teams.map((t) => [t.name, t]));
    expect(byName.OWLS.sizes).toEqual([{ type_id: "big", type_name: "Big Box", stock: 25, onMaps: 23, diff: -2 }, { type_id: "tiny", type_name: "Small Box", stock: 4, onMaps: 4, diff: 0 }]);
    expect(byName.HAWKS.matches).toBe(true);
    expect(byName.BEARS.uncounted).toEqual(["Floor A5"]); // a bears spot with no boxes entered
    expect(byName.LIONS.places).toBe(0); // not on the map at all
    expect(c.off.map((t) => t.name)).toEqual(["OWLS", "BEARS", "LIONS"]);
    expect(c.matchable.map((t) => t.name)).toEqual(["OWLS"]); // only a fully counted team can be matched blindly
    expect(c.boxesOff).toBe(2 + 5);
  });

  it("sets a team to what its pallets hold, keeping its loose units", () => {
    const out = matchToPallets(item, [map], ["owls"]);
    expect(out[0]).toEqual({ ...item.sections[0], counts: { big: 23, tiny: 4 } });
    expect(out[0].loose).toBe(7);
    expect(out[1]).toBe(item.sections[1]);
  });
});

describe("a pallet's fullness from its boxes (R-344)", () => {
  const types: BoxType[] = [{ id: "big", name: "Big Box", per_box: 72 }, { id: "tiny", name: "Small Box", per_box: 12 }];
  const item = { id: "w", box_types: types, units_per_pallet: 21 * 72 };
  const ps = (boxes: Record<string, number>) => ({ item_id: "w", section_id: "owls", boxes });

  it("is units on the pallet over the pallet size, exactly", () => {
    expect(palletFill(ps({ big: 21 }), item)).toBe(1);
    expect(palletFill(ps({ big: 18 }), item)).toBeCloseTo(18 / 21);
    expect(palletFill(ps({ big: 10, tiny: 12 }), item)).toBeCloseTo((720 + 144) / 1512);
    expect(palletFill(ps({}), item)).toBe(0);
    expect(palletFill(undefined, item)).toBeNull();
    expect(palletFill(ps({ big: 3 }), { ...item, units_per_pallet: 0 })).toBeNull();
    expect([fillQuarter(1), fillQuarter(0.99), fillQuarter(0.5), fillQuarter(0.01), fillQuarter(0)]).toEqual([4, 3, 2, 1, 0]);
    expect([pctLabel(18 / 21), pctLabel(1), pctLabel(22 / 21)]).toEqual(["86%", "Full", "Full · 105%"]);
  });

  it("draws a counted pallet by its boxes and leaves the rest as marked", () => {
    const cell = (c: number, fill: number) => ({ r: 0, c, item_id: "w", section_id: "owls", label: "", fill, note: "", aisle: false });
    const shown = countedFills([cell(0, 4), cell(1, 2)], emptyShape(), { "0:0": ps({ big: 18 }) }, [item]);
    expect(shown.cells[0].pct).toBeCloseTo(18 / 21);
    expect(shown.cells[0].fill).toBe(3);
    expect(shown.cells[1]).toEqual(cell(1, 2));
  });
});
