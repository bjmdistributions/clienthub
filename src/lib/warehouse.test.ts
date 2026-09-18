import { describe, expect, it } from "vitest";
import {
  changesForInvoice, colName, describePick, invoiceLines, planUnits, rowsFromText, sectionBoxes, sectionUnits, shares, takeUnits,
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
