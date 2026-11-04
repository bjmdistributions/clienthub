import { describe, it, expect } from "vitest";
import { compact, mono, niceMax } from "./chartMath";

describe("niceMax", () => {
  it("rounds up to four even steps", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(9)).toBe(10);
    expect(niceMax(23000)).toBe(40000);
    for (const v of [1, 7, 123, 4567, 23000, 987654]) {
      const top = niceMax(v);
      expect(top).toBeGreaterThanOrEqual(v);
      expect(top).toBeLessThan(v * 2.1);
    }
  });
});

describe("mono", () => {
  const xs = [0, 1, 2, 3, 4, 5];
  const ys = [0, 10, 10, 12, 40, 41];

  it("passes through every point", () => {
    const c = mono(xs, ys);
    xs.forEach((x, i) => expect(c.at(x)).toBeCloseTo(ys[i], 6));
  });

  it("never overshoots between two points (no waves)", () => {
    const c = mono(xs, ys);
    for (let i = 0; i < xs.length - 1; i++) {
      const lo = Math.min(ys[i], ys[i + 1]) - 1e-9, hi = Math.max(ys[i], ys[i + 1]) + 1e-9;
      for (let t = 0; t <= 1; t += 0.05) {
        const y = c.at(xs[i] + t);
        expect(y).toBeGreaterThanOrEqual(lo);
        expect(y).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("draws one cubic per gap and handles one point", () => {
    expect(mono(xs, ys).path.split("C").length - 1).toBe(5);
    expect(mono([3], [7]).path).toBe("M3 7");
    expect(mono([3], [7]).at(100)).toBe(7);
  });
});

describe("compact", () => {
  it("shortens axis numbers", () => {
    expect(compact(950)).toBe("950");
    expect(compact(1200)).toBe("1.2k");
    expect(compact(12000)).toBe("12k");
    expect(compact(3400000)).toBe("3.4M");
  });
});
