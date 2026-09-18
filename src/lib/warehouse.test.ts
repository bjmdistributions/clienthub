import { describe, expect, it } from "vitest";
import { afterPick, boxesOnInvoice, invoiceLines, parseSectionList, perPallet, planPick, shares, type WhSection } from "./warehouse";

const sec = (id: string, boxes: number, per_box = 24): WhSection => ({ id, name: id.toUpperCase(), boxes, per_box });

describe("planPick — the truckload evens out what is left", () => {
  // Jack's example: one team is 40% of the hats.
  const hats = [sec("nyy", 40), sec("lad", 20), sec("bos", 20), sec("chc", 20)];

  it("drains the big team first until it is level with the rest", () => {
    const { take, short } = planPick(hats, 20);
    expect(take).toEqual({ nyy: 20 });
    expect(short).toBe(0);
    const left = afterPick(hats, take);
    expect(Object.values(shares(left)).every((s) => s === 0.25)).toBe(true);
  });

  it("then brings every team down together", () => {
    const { take } = planPick(hats, 40);
    expect(take).toEqual({ nyy: 25, lad: 5, bos: 5, chc: 5 });
    expect(afterPick(hats, take).map((s) => s.boxes)).toEqual([15, 15, 15, 15]);
  });

  it("never leaves one team standing while others are gone", () => {
    const { take } = planPick(hats, 90);
    const left = afterPick(hats, take).map((s) => s.boxes);
    expect(Math.max(...left) - Math.min(...left)).toBeLessThanOrEqual(1);
  });

  it("balances on units when boxes pack differently", () => {
    // 10 boxes of 50 = 500 units against 20 boxes of 10 = 200 units.
    const mixed = [sec("big", 10, 50), sec("small", 20, 10)];
    const { take } = planPick(mixed, 6);
    expect(take).toEqual({ big: 6 });
  });

  it("leaves out a section the buyer does not want", () => {
    const { take } = planPick(hats, 20, new Set(["nyy"]));
    expect(take.nyy).toBeUndefined();
    expect((take.lad || 0) + (take.bos || 0) + (take.chc || 0)).toBe(20);
  });

  it("says how many boxes it could not find", () => {
    const { take, short } = planPick([sec("a", 3), sec("b", 2)], 8);
    expect(take).toEqual({ a: 3, b: 2 });
    expect(short).toBe(3);
  });

  it("asks for nothing on zero, negative or empty stock", () => {
    expect(planPick(hats, 0).take).toEqual({});
    expect(planPick(hats, -5).take).toEqual({});
    expect(planPick([sec("a", 0)], 4)).toEqual({ take: {}, short: 4 });
  });
});

describe("perPallet", () => {
  it("shows one number when even and a range when not", () => {
    expect(perPallet(12, 4)).toBe("3");
    expect(perPallet(10, 4)).toBe("2–3");
    expect(perPallet(0, 4)).toBe("");
  });
});

describe("send to invoice", () => {
  const item = { name: "New Era 59FIFTY", unit_price: 9, sections: [sec("nyy", 40), sec("lad", 20, 12)] };

  it("writes one line per team, biggest first, priced per unit", () => {
    const lines = invoiceLines(item, { nyy: 3, lad: 10 });
    expect(lines.map((l) => l.description)).toEqual([
      "New Era 59FIFTY — LAD, 10 boxes of 12",
      "New Era 59FIFTY — NYY, 3 boxes of 24",
    ]);
    expect(lines[0]).toMatchObject({ qty: 120, rate: 9, amount: 1080 });
    expect(lines[1]).toMatchObject({ qty: 72, amount: 648 });
  });

  it("takes out what the saved invoice carries, not what was planned", () => {
    const lines = invoiceLines(item, { nyy: 3, lad: 10 });
    lines[0].qty = 60; // edited down to 5 boxes of 12
    const kept = [lines[0], { description: "Freight", qty: 1, rate: 400, amount: 400 }];
    expect(boxesOnInvoice(kept)).toEqual([{ section_id: "lad", boxes: -5 }]);
  });
});

describe("parseSectionList", () => {
  it("reads the shapes a list arrives in", () => {
    const got = parseSectionList([
      "Team\tBoxes\tPer box",
      "New York Yankees\t40\t24",
      "Dodgers, 20, 24",
      "Red Sox - 12 boxes of 24",
      "San Francisco 49ers 8x12",
      "Cubs 1,200",
    ].join("\n"), 36);
    expect(got.map((s) => [s.name, s.boxes, s.per_box])).toEqual([
      ["New York Yankees", 40, 24],
      ["Dodgers", 20, 24],
      ["Red Sox", 12, 24],
      ["San Francisco 49ers", 8, 12],
      ["Cubs", 1200, 36],
    ]);
  });

  it("keeps a bare list of names to count later", () => {
    expect(parseSectionList("Mets\nPhillies\n\n", 24).map((s) => [s.name, s.boxes, s.per_box]))
      .toEqual([["Mets", 0, 24], ["Phillies", 0, 24]]);
  });
});
