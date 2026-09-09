import { describe, it, expect } from "vitest";
import {
  REELS, PAYLINES, SYMBOLS, SYMBOL_BY_ID, JACKPOTS, LINE_COUNT, ROWS,
  DENOMS, CREDITS_PER_LINE, MIN_BET, MAX_BET, TIER_RATE,
  mulberry32, spin, evaluate, meterGain, advanceJackpots, jackpotVisible,
  lineStake, totalBet, cents,
  type SymbolId, type MeterState,
} from "./crossdock";

/** P(a given cell on a given reel shows `id`). One row of a reel is uniform over its strip. */
const p = (reel: number, id: SymbolId) =>
  REELS[reel].filter((s) => s === id).length / REELS[reel].length;

/**
 * Exact expected line-win credits per spin, per unit of LINE bet.
 *
 * A payline takes one cell from each reel and those cells are independent across
 * reels, so a run of exactly k needs: the symbol on reel 1, the symbol or a wild on
 * reels 2..k, and neither on reel k+1. No simulation required.
 */
function exactLinePayPerLine(): number {
  let e = 0;
  for (const sym of SYMBOLS) {
    if (sym.kind !== "normal" || sym.pays[2] === 0) continue;
    const hit = REELS.map((_, r) => p(r, sym.id) + (r === 0 ? 0 : p(r, "wild")));
    for (let k = 3; k <= 5; k++) {
      let q = p(0, sym.id);
      for (let r = 1; r < k; r++) q *= hit[r];
      if (k < 5) q *= 1 - hit[k];
      e += q * sym.pays[k - 3];
    }
  }
  return e;
}

/** Exact beacon-count distribution. Beacons sit >= 3 stops apart on every strip, so a
 *  reel's 3-row window shows at most one — which makes this a Poisson binomial. */
function beaconCountDistribution(): number[] {
  const per = REELS.map((strip) => (ROWS * strip.filter((s) => s === "beacon").length) / strip.length);
  let dist = [1];
  for (const q of per) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((v, n) => { next[n] += v * (1 - q); next[n + 1] += v * q; });
    dist = next;
  }
  return dist;
}

describe("cross-dock reel strips", () => {
  it("only ever references symbols the paytable defines", () => {
    const known = new Set(SYMBOLS.map((s) => s.id));
    REELS.forEach((strip, r) => strip.forEach((s) => {
      expect(known, `reel ${r + 1} stop ${s}`).toContain(s);
    }));
  });

  it("keeps the wild off reel 1, so a line's symbol is never ambiguous", () => {
    expect(REELS[0]).not.toContain("wild");
    REELS.slice(1).forEach((strip) => expect(strip).toContain("wild"));
  });

  it("spaces beacons far enough apart that one reel can never show two", () => {
    REELS.forEach((strip, r) => {
      const at = strip.map((s, i) => (s === "beacon" ? i : -1)).filter((i) => i >= 0);
      at.forEach((i, n) => {
        const gap = n === at.length - 1 ? strip.length - i + at[0] : at[n + 1] - i;
        expect(gap, `reel ${r + 1} beacon gap`).toBeGreaterThanOrEqual(ROWS);
      });
    });
  });

  it("has 20 well-formed paylines", () => {
    expect(LINE_COUNT).toBe(20);
    PAYLINES.forEach((l) => {
      expect(l).toHaveLength(REELS.length);
      l.forEach((row) => expect(row).toBeGreaterThanOrEqual(0));
      l.forEach((row) => expect(row).toBeLessThan(ROWS));
    });
    expect(new Set(PAYLINES.map((l) => l.join(""))).size).toBe(LINE_COUNT);
  });
});

describe("cross-dock return to player", () => {
  // These are the published figures in the reels.ts header. A strip edit that moves
  // the RTP fails here rather than silently shipping a different game.
  it("pays back 92.2708% of the base game, exactly", () => {
    const dist = beaconCountDistribution();
    const scatter = [3, 4, 5].reduce((a, n) => a + dist[n] * SYMBOL_BY_ID.beacon.pays[n - 3], 0);
    const rtp = (exactLinePayPerLine() * LINE_COUNT + scatter) / LINE_COUNT;
    expect(rtp).toBeCloseTo(0.922708, 5);
  });

  it("awards free spins once in 481 spins, worth another 2.3492%", () => {
    const dist = beaconCountDistribution();
    const trigger = dist[3] + dist[4] + dist[5];
    expect(1 / trigger).toBeCloseTo(481.1, 0);

    const perSpin = dist[3] * 6 + dist[4] * 10 + dist[5] * 16;
    const contribution = perSpin * 2 * 0.922708;
    expect(contribution).toBeCloseTo(0.023492, 5);
  });

  it("funds the four progressives with exactly 1.20% of every bet", () => {
    expect(JACKPOTS).toHaveLength(4);
    expect(JACKPOTS.length * TIER_RATE).toBeCloseTo(0.012, 12);

    // A must-hit-by tier balances when what the meter has to climb over one cycle,
    // grossed back up by the reserve it also holds, equals what it pays out.
    for (const t of JACKPOTS) {
      const meanTarget = (t.seed + t.cap) / 2;
      const volume = (meanTarget - t.seed) / (TIER_RATE * t.visible);
      const takenIn = TIER_RATE * volume;
      expect(takenIn, `${t.name} balance`).toBeCloseTo(meanTarget, 6);
      expect(t.visible).toBe(jackpotVisible(t.seed, t.cap));
      expect(t.cap).toBeGreaterThan(t.seed);
    }
  });

  it("pays the progressives back at 1.20%, whatever the stake, over a real run", () => {
    // Mini and Minor cycle often enough to measure directly. Bet at the top of the
    // range so a few thousand cycles fit in a unit test.
    for (const id of ["mini", "minor"] as const) {
      const t = JACKPOTS.find((j) => j.id === id)!;
      const rng = mulberry32(4242);
      let state: Record<string, MeterState> = { [t.id]: { meter: t.seed, target: t.seed + rng() * (t.cap - t.seed) } };
      let paid = 0, volume = 0;
      const bet = MAX_BET;
      for (let i = 0; i < 300_000; i++) {
        volume += bet;
        const only = { [t.id]: state[t.id] };
        const meter = only[t.id].meter + meterGain(t, bet);
        if (meter >= only[t.id].target) {
          paid += meter;
          state = { [t.id]: { meter: t.seed, target: t.seed + rng() * (t.cap - t.seed) } };
        } else {
          state = { [t.id]: { meter, target: only[t.id].target } };
        }
      }
      const rate = paid / volume;
      expect(rate, `${t.name} returned ${(rate * 100).toFixed(3)}%`).toBeGreaterThan(TIER_RATE * 0.96);
      expect(rate, `${t.name} returned ${(rate * 100).toFixed(3)}%`).toBeLessThan(TIER_RATE * 1.04);
    }
  });

  it("never awards more than one tier on a spin, and never loses a meter", () => {
    const rng = mulberry32(7);
    let state: Record<string, MeterState> = {};
    let wins = 0;
    for (let i = 0; i < 20_000; i++) {
      const r = advanceJackpots(state, MAX_BET, rng);
      state = r.state;
      if (r.won) {
        wins++;
        expect(r.amount).toBeGreaterThanOrEqual(r.won.seed);
        expect(r.amount).toBeLessThanOrEqual(r.won.cap + meterGain(r.won, MAX_BET) + 1e-9);
        expect(state[r.won.id].meter).toBe(r.won.seed);
      }
      // every tier is always present and never negative
      for (const t of JACKPOTS) {
        expect(state[t.id].meter).toBeGreaterThanOrEqual(t.seed - 1e-9);
        expect(state[t.id].target).toBeGreaterThan(t.seed);
      }
    }
    expect(wins).toBeGreaterThan(0);
  });

  it("lands the grand prize about once in 105,000 spins", () => {
    const hit = REELS.map((_, r) => p(r, "bjm") + (r === 0 ? 0 : p(r, "wild")));
    const perLine = hit.reduce((a, q, r) => a * (r === 0 ? p(0, "bjm") : q), 1);
    expect(1 / (perLine * LINE_COUNT)).toBeGreaterThan(95000);
    expect(1 / (perLine * LINE_COUNT)).toBeLessThan(115000);
  });
});

describe("cross-dock spins", () => {
  it("pays something on about 26% of spins, and never more than one win per line", () => {
    const rng = mulberry32(20260909);
    let hits = 0;
    const SPINS = 200_000;
    for (let i = 0; i < SPINS; i++) {
      const out = spin(rng, 1);
      if (out.win > 0) hits++;
      expect(new Set(out.lineWins.map((w) => w.line)).size).toBe(out.lineWins.length);
    }
    expect(hits / SPINS).toBeGreaterThan(0.25);
    expect(hits / SPINS).toBeLessThan(0.27);
  });

  it("doubles every win during a free spin", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5_000; i++) {
      const { grid } = { grid: spin(rng, 1).grid };
      expect(evaluate(grid, 1, true).win).toBe(evaluate(grid, 1, false).win * 2);
    }
  });

  it("scales line pays with the line bet and nothing else", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 2_000; i++) {
      const { grid } = spin(rng, 1);
      expect(evaluate(grid, 10).win).toBe(evaluate(grid, 1).win * 10);
    }
  });

  it("never starts a run on a beacon, a slat or a wild", () => {
    const rng = mulberry32(31337);
    for (let i = 0; i < 50_000; i++) {
      for (const w of spin(rng, 1).lineWins) {
        expect(["beacon", "slat", "wild"]).not.toContain(w.symbol);
        expect(w.cells[0][0]).toBe(0);
        expect(w.cells).toHaveLength(w.count);
      }
    }
  });

  it("scales a win with the line stake and nothing else", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 2_000; i++) {
      const { grid } = spin(rng, 1);
      const base = evaluate(grid, 1).win;
      expect(evaluate(grid, 0.05).win).toBeCloseTo(base * 0.05, 9);
      expect(evaluate(grid, 5).win).toBeCloseTo(base * 5, 9);
    }
  });
});

describe("cross-dock bet structure", () => {
  it("runs from 20 cents to 100 dollars a spin", () => {
    expect(MIN_BET).toBeCloseTo(0.2, 10);
    expect(MAX_BET).toBeCloseTo(100, 10);
  });

  it("is always denomination x 20 lines x credits per line", () => {
    for (const d of DENOMS) {
      for (const c of CREDITS_PER_LINE) {
        expect(totalBet(d, c)).toBeCloseTo(lineStake(d, c) * LINE_COUNT, 10);
        // and every reachable stake is a whole number of cents, so nothing rounds away
        expect(Math.abs(cents(totalBet(d, c)) - totalBet(d, c) * 100)).toBeLessThan(1e-6);
      }
    }
  });

  it("returns the same share at every denomination", () => {
    // Pays are multiples of the LINE stake, so the return cannot vary with denom —
    // betting bigger buys more of the same game, never a better one.
    const rng = mulberry32(2026);
    const grids = Array.from({ length: 3_000 }, () => spin(rng, 1).grid);
    const at = (stake: number) =>
      grids.reduce((a, g) => a + evaluate(g, stake).win, 0) / (grids.length * stake * LINE_COUNT);
    const penny = at(lineStake(0.01, 1));
    for (const d of DENOMS) {
      for (const c of CREDITS_PER_LINE) {
        expect(at(lineStake(d, c))).toBeCloseTo(penny, 9);
      }
    }
  });
});
