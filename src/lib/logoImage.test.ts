import { describe, it, expect } from "vitest";
import { chooseLogo, fitWithin, LOGO_MAX_CHARS, LOGO_SIDES, LOGO_TOO_DETAILED } from "./logoImage";

// R-449. A bill's logo must come out under the 40,000-character cap or the sync batch it rides
// in could be refused. The canvas work needs a browser; the sizing and the choice of which
// encoding to keep are pure, and that is what is pinned here.

const of = (n: number) => "x".repeat(n);

describe("fitWithin", () => {
  it("shrinks the longest side to the cap and keeps the aspect", () => {
    expect(fitWithin(512, 256, 128)).toEqual({ w: 128, h: 64 });
    expect(fitWithin(300, 600, 96)).toEqual({ w: 48, h: 96 });
  });

  it("never scales a small image up", () => {
    expect(fitWithin(40, 20, 128)).toEqual({ w: 40, h: 20 });
  });

  it("never returns a zero side for a very thin image", () => {
    expect(fitWithin(2000, 3, 128)).toEqual({ w: 128, h: 1 });
  });

  it("is null for a zero, missing or non-finite size", () => {
    expect(fitWithin(0, 100, 128)).toBeNull();
    expect(fitWithin(100, 0, 128)).toBeNull();
    expect(fitWithin(NaN, 100, 128)).toBeNull();
    expect(fitWithin(Infinity, 100, 128)).toBeNull();
    expect(fitWithin(100, 100, 0)).toBeNull();
  });
});

describe("chooseLogo", () => {
  it("keeps the first PNG that fits, at the biggest side", () => {
    const seen: number[] = [];
    const out = chooseLogo({
      png: (s) => { seen.push(s); return of(1000); },
      jpeg: () => { throw new Error("jpeg should not be tried"); },
    });
    expect(out.length).toBe(1000);
    expect(seen).toEqual([128]);
  });

  it("retries the PNG at 96 and then 64 before giving up on it", () => {
    const seen: number[] = [];
    const out = chooseLogo({
      png: (s) => { seen.push(s); return of(s === 64 ? 20_000 : LOGO_MAX_CHARS + 1); },
      jpeg: () => { throw new Error("jpeg should not be tried"); },
    });
    expect(out.length).toBe(20_000);
    expect(seen).toEqual([...LOGO_SIDES]);
  });

  it("accepts a PNG of exactly the cap", () => {
    const out = chooseLogo({ png: () => of(LOGO_MAX_CHARS), jpeg: () => "" });
    expect(out.length).toBe(LOGO_MAX_CHARS);
  });

  it("falls back to the JPEG when no PNG fits", () => {
    const out = chooseLogo({ png: () => of(LOGO_MAX_CHARS + 1), jpeg: (s) => (s === 128 ? "jpeg-ok" : "never") });
    expect(out).toBe("jpeg-ok");
  });

  it("throws the plain sentence when nothing fits", () => {
    expect(() => chooseLogo({ png: () => of(LOGO_MAX_CHARS + 1), jpeg: () => of(LOGO_MAX_CHARS + 1) }))
      .toThrow(LOGO_TOO_DETAILED);
  });

  it("honours a different limit", () => {
    expect(() => chooseLogo({ png: () => of(50), jpeg: () => of(50) }, 10)).toThrow(LOGO_TOO_DETAILED);
    expect(chooseLogo({ png: () => of(5), jpeg: () => "" }, 10).length).toBe(5);
  });
});
