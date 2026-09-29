import { describe, expect, it } from "vitest";
import { polygonToCells } from "h3-js";
import countries from "../../assets/countries-110m.json";

// three-globe fills each country with h3 cells for the dotted land, and a single
// outline h3 rejects throws inside its build loop and leaves every country after
// it undrawn (the US went missing this way once). Re-run this after regenerating
// the file.
describe("countries-110m.json", () => {
  it("every outline fills at resolution 3", () => {
    const bad: string[] = [];
    for (const f of (countries as any).features) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      try { polys.forEach((p: number[][][]) => polygonToCells(p, 3, true)); } catch { bad.push(f.properties.name); }
    }
    expect(bad).toEqual([]);
  });
});
