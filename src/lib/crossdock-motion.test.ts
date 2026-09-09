import { describe, it, expect } from "vitest";
import {
  laneY, laneV, travel, stopAt, startAt, cruiseMs,
  VMAX, RECOIL, RECOIL_MS, ACCEL_MS, SETTLE_1, SETTLE_2, OVERSHOOT,
} from "./crossdock-motion";

const REELS = 5;
const PITCH = 104;      // cell 100 + gap 4, the full-size geometry
const LEAD = 44;        // tiles of real strip content ahead of the result
const REST = -4570;     // an arbitrary landed offset; every assertion is relative to it

describe("cross-dock reel motion", () => {
  it("starts held, dips, and comes to rest exactly on the mark", () => {
    for (let i = 0; i < REELS; i++) {
      const start = REST + travel(i) - RECOIL;
      expect(laneY(i, 0, REST)).toBeCloseTo(start, 6);
      // the recoil is a dip AGAINST the direction of travel, and it is the whole of it
      expect(laneY(i, startAt(i) + RECOIL_MS - 0.001, REST)).toBeCloseTo(start + RECOIL, 1);
      expect(laneY(i, stopAt(i), REST)).toBeCloseTo(REST, 6);
      expect(laneY(i, stopAt(i) + 5_000, REST)).toBe(REST);
    }
  });

  it("lands the five reels in a readable cascade, the last at 2,380ms", () => {
    const stops = Array.from({ length: REELS }, (_, i) => stopAt(i));
    expect(stops).toEqual([1300, 1570, 1840, 2110, 2380]);
    stops.slice(1).forEach((s, i) => expect(s - stops[i]).toBe(270));
  });

  it("never travels further than its own lane of symbols is long", () => {
    // The lane holds LEAD tiles ahead of the three result tiles. If a reel travelled
    // past that it would decelerate a symbol that does not exist.
    for (let i = 0; i < REELS; i++) {
      const symbols = travel(i) / PITCH;
      expect(symbols, `reel ${i + 1} travel`).toBeLessThan(LEAD - 4);
      expect(symbols, `reel ${i + 1} travel`).toBeGreaterThan(6);
    }
  });

  it("only ever moves one way, apart from the recoil and the detent", () => {
    for (let i = 0; i < REELS; i++) {
      const from = startAt(i) + RECOIL_MS;
      const settleStart = from + ACCEL_MS + cruiseMs(i);
      const apex = settleStart + SETTLE_1;
      let prev = laneY(i, from, REST);
      for (let t = from + 1; t <= apex; t++) {
        const y = laneY(i, t, REST);
        expect(y, `reel ${i + 1} reversed at ${t}ms`).toBeLessThanOrEqual(prev + 1e-9);
        prev = y;
      }
      // and the detent brings it back up the last 16px, never further
      expect(laneY(i, apex, REST)).toBeCloseTo(REST - OVERSHOOT, 4);
      for (let t = apex; t <= apex + SETTLE_2; t++) {
        expect(laneY(i, t, REST)).toBeGreaterThanOrEqual(REST - OVERSHOOT - 1e-9);
        expect(laneY(i, t, REST)).toBeLessThanOrEqual(REST + 1e-9);
      }
    }
  });

  it("hands over from cruise to settle at exactly cruise speed", () => {
    for (let i = 0; i < REELS; i++) {
      const join = startAt(i) + RECOIL_MS + ACCEL_MS + cruiseMs(i);
      // The offset decreases as the reel turns, so speed is the earlier value minus the later.
      const before = laneY(i, join - 2, REST) - laneY(i, join - 1, REST);
      const after = laneY(i, join + 1, REST) - laneY(i, join + 2, REST);
      expect(before).toBeCloseTo(VMAX, 2);
      expect(after).toBeCloseTo(VMAX, 1);
      // the detent's own ends are both stationary, which is what stops it snapping
      const apex = join + SETTLE_1;
      expect(laneY(i, apex + 1, REST) - laneY(i, apex, REST)).toBeCloseTo(0, 2);
      const end = apex + SETTLE_2;
      expect(laneY(i, end, REST) - laneY(i, end - 1, REST)).toBeCloseTo(0, 2);
    }
  });

  it("reports a speed that peaks at cruise and is zero once landed", () => {
    for (let i = 0; i < REELS; i++) {
      expect(laneV(i, 0)).toBe(0);
      expect(laneV(i, startAt(i) + RECOIL_MS + ACCEL_MS + 10)).toBeCloseTo(VMAX, 6);
      expect(laneV(i, stopAt(i))).toBe(0);
      for (let t = 0; t <= stopAt(i); t += 7) expect(laneV(i, t)).toBeLessThanOrEqual(VMAX + 1e-9);
    }
    // ~19 symbols a second at cruise — fast enough to blur, slow enough to read
    expect((VMAX * 1000) / PITCH).toBeGreaterThan(17);
    expect((VMAX * 1000) / PITCH).toBeLessThan(21);
  });
});
