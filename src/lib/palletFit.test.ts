import { describe, expect, it } from "vitest";
import { feet, parseInches } from "./palletFit";

describe("inches as a tape measure reads them (R-346)", () => {
  it("reads decimals, fractions and the symbols people type", () => {
    expect(["23.5", "23 1/2", "23-1/2", "23 - 1/2", "23½", "23 ½", "1/2", ".75", "23 in", '23"', "23 inches", " 48 ", "23 3/8"].map(parseInches))
      .toEqual([23.5, 23.5, 23.5, 23.5, 23.5, 23.5, 0.5, 0.75, 23, 23, 23, 48, 23.38]);
  });
  it("refuses what it cannot be sure of, instead of guessing", () => {
    expect(["", "abc", "23,5", "23 1/0", "23 3/2", "23.5 1/2", "2 3 4", "-5", "23 1/2/3", "1e3", "231/2", "3/2"].map(parseInches)).toEqual(Array(12).fill(null));
  });
  it("says a height in feet and inches", () => {
    expect([feet(72), feet(58), feet(8), feet(60.5)]).toEqual(["6 ft", "4 ft 10 in", "8 in", "5 ft 0.5 in"]);
  });
});
