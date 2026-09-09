/**
 * Cross-dock — how a reel moves.
 *
 * Kept apart from the component (and from the game maths in crossdock.ts) because it is
 * pure arithmetic and it is the part most easily got wrong by eye: a reel that eases
 * badly, hands over between phases at the wrong speed, or travels further than its own
 * lane of symbols is long. crossdock-motion.test.ts checks all three.
 *
 * A reel's offset is a flat number of pixels; the component wraps that around a drum.
 * Four phases, in order, per reel:
 *
 *   recoil      90ms   a 7px dip against the direction of travel, staggered 20ms per reel
 *   accelerate 130ms   quadratic ramp to VMAX
 *   cruise     700ms + 250ms per reel, constant — this is what stages the stop cascade
 *   settle     380ms   easeOutCubic 16px PAST the mark, then a raised-cosine detent back
 *
 * VMAX is 2 px/ms against a 104px pitch: about 19 symbols a second, fast enough to blur
 * and slow enough to read. The last reel lands 2,380ms after the press.
 */

export const RECOIL = 7;
export const RECOIL_MS = 90;
export const ACCEL_MS = 130;
export const VMAX = 2.0;
export const SETTLE_1 = 289;
export const SETTLE_2 = 91;
export const OVERSHOOT = 16;

export const ACCEL_D = (VMAX * ACCEL_MS) / 3;              // 86.7px
/** easeOutCubic has derivative 3 at p=0, so this span hands over from cruise at exactly
 *  VMAX and the join between the two phases is invisible. */
export const SETTLE_D = (VMAX * SETTLE_1) / 3;             // 192.7px
export const TRAVEL_TAIL = ACCEL_D + SETTLE_D - OVERSHOOT; // 263.4px

export const cruiseMs = (i: number) => 700 + 250 * i;
export const travel = (i: number) => TRAVEL_TAIL + VMAX * cruiseMs(i);
export const startAt = (i: number) => 20 * i;
export const stopAt = (i: number) =>
  startAt(i) + RECOIL_MS + ACCEL_MS + cruiseMs(i) + SETTLE_1 + SETTLE_2;

/** Offset for reel `i`, `t` ms after the spin began. `rest` is where it lands. */
export function laneY(i: number, t: number, rest: number) {
  const base = rest + travel(i) - RECOIL;
  const t0 = startAt(i);
  if (t <= t0) return base;
  let e = t - t0;
  if (e < RECOIL_MS) { const p = e / RECOIL_MS; return base + RECOIL * p * p; }
  e -= RECOIL_MS;
  const top = base + RECOIL;
  if (e < ACCEL_MS) return top - (VMAX * e * e * e) / (3 * ACCEL_MS * ACCEL_MS);
  e -= ACCEL_MS;
  const c = cruiseMs(i);
  if (e < c) return top - ACCEL_D - VMAX * e;
  e -= c;
  if (e < SETTLE_1) {
    const p = e / SETTLE_1;
    return rest + SETTLE_D - OVERSHOOT - SETTLE_D * (1 - Math.pow(1 - p, 3));
  }
  e -= SETTLE_1;
  // A raised cosine, not another cubic: it has zero velocity at BOTH ends, so the reel
  // comes to rest at the top of the overshoot for an instant and settles back — a
  // mechanical detent rather than a visible snap.
  if (e < SETTLE_2) { const p = e / SETTLE_2; return rest - (OVERSHOOT * (1 + Math.cos(p * Math.PI))) / 2; }
  return rest;
}

/** Speed in px/ms. Drives the motion-blur cue and nothing else. */
export function laneV(i: number, t: number) {
  const t0 = startAt(i) + RECOIL_MS;
  if (t <= t0) return 0;
  let e = t - t0;
  if (e < ACCEL_MS) return VMAX * (e / ACCEL_MS) ** 2;
  e -= ACCEL_MS;
  const c = cruiseMs(i);
  if (e < c) return VMAX;
  e -= c;
  if (e < SETTLE_1) return VMAX * (1 - e / SETTLE_1) ** 2;
  return 0;
}
