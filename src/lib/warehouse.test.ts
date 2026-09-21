import { describe, expect, it } from "vitest";
import {
  changesForInvoice, colName, describePick, doorWhere, emptyPick, emptyShape, invoiceLines, layoutSummary, mapView, pickFromPlan, pickUnits,
  planUnits, removeRow, rowLength, rowsFromText, sectionBoxes, sectionUnits, setPicked, shareOut, shares, spotName, takeUnits, wallAt,
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
