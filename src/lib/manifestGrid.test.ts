import { describe, expect, it } from "vitest";
import { colLetter, fromRoles, headingRow, isTotalRow, num, read, setPick, signature, toRoles } from "./manifestGrid";

// Invented sheet: a title row, the headings, lines, the headings pasted again, a totals row.
const SHEET = [
  ["LOAD 4471 MANIFEST", "", "", ""],
  ["Item Description", "Brand", "Qty", "Unit Retail"],
  ["Harbor desk lamp", "Harbor", "4", "$24.50"],
  ["Pine shelf, 3 tier", "", "2", "60"],
  ["", "", "", ""],
  ["Item Description", "Brand", "Qty", "Unit Retail"],
  ["Harbor floor lamp", "HARBOR", "1", "1,200.00"],
  ["Total", "", "7", ""],
];

describe("R-653 manifest grid", () => {
  it("reads numbers the way sheets write them", () => {
    expect(num("$1,234.50")).toBe(1234.5);
    expect(num("(12.00)")).toBe(-12);
    expect(num("4 ea")).toBe(4);
    expect(num(".5")).toBe(0.5);
    expect(num("Qty")).toBeNull();
    expect(num("12A")).toBeNull();
    expect(num("")).toBeNull();
  });

  it("finds the headings under a title row", () => {
    expect(headingRow(SHEET)).toBe(1);
    expect(headingRow([["Lamp", "4", "24.5"], ["Shelf", "2", "60"]])).toBe(-1);
    expect(signature(SHEET, 1)).toBe("r653:item description|brand|qty|unit retail");
    expect(signature(SHEET, -1)).toBe("");
  });

  it("adds up only the lines, not the headings again or the total", () => {
    const r = read(SHEET, 1, { name: 0, brand: 1, qty: 2, each: 3 });
    expect(r.lines.map((l) => l.row)).toEqual([2, 3, 6]);
    expect(r.qty).toBe(7);
    expect(r.price).toBe(4 * 24.5 + 2 * 60 + 1200);
    expect(r.brands).toBe(1);
    expect(r.counted[5]).toBe(false);
    expect(r.counted[7]).toBe(false);
  });

  it("takes a line total as it is, over price each", () => {
    const r = read(SHEET, 1, { name: 0, qty: 2, line: 3 });
    expect(r.price).toBe(24.5 + 60 + 1200);
  });

  it("counts nothing until a column is picked", () => {
    const r = read(SHEET, 1, { brand: 1 });
    expect(r.lines).toHaveLength(0);
  });

  it("counts rows by their quantity when no name is picked", () => {
    const r = read(SHEET, 1, { qty: 2 });
    expect(r.lines.map((l) => l.row)).toEqual([2, 3, 6]);
    expect(r.qty).toBe(7);
  });

  it("keeps product names that only start like a total", () => {
    expect(isTotalRow(["Total Gym XLS", "1"])).toBe(false);
    expect(isTotalRow(["", "Grand total:", "9"])).toBe(true);
    expect(isTotalRow(["Total units", "9"])).toBe(true);
  });

  it("gives a column one pick and a pick one column", () => {
    let p = setPick({}, 0, "name");
    p = setPick(p, 2, "qty");
    p = setPick(p, 2, "each");
    expect(p).toEqual({ name: 0, each: 2 });
    p = setPick(p, 3, "each");
    expect(p).toEqual({ name: 0, each: 3 });
    expect(setPick(p, 0, null)).toEqual({ each: 3 });
  });

  it("keeps picks in the column map store's words", () => {
    const p = { name: 0, qty: 2, brand: 1, line: 3 };
    expect(toRoles(p)).toEqual({ description: 0, quantity: 2, brand: 1, retail_ext: 3 });
    expect(fromRoles({ description: 0, quantity: 2, brand: 1, retail_ext: 3, category: 5 })).toEqual(p);
    expect(colLetter(0)).toBe("A");
    expect(colLetter(27)).toBe("AB");
  });
});
