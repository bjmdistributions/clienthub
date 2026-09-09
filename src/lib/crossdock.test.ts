import { describe, it, expect } from "vitest";
import {
  REELS, PAYLINES, SYMBOLS, SYMBOL_BY_ID, JACKPOTS, LINE_COUNT, ROWS,
  BASE_TOTAL_BET, mulberry32, spin, evaluate, meterGain, rollJackpot,
  type SymbolId,
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
    const rtp = (exactLinePayPerLine() * LINE_COUNT + scatter) / BASE_TOTAL_BET;
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
    // Contributions in must equal awards out: average award = seed + meterRate / pBase.
    const paidOut = JACKPOTS.reduce((a, t) => a + t.pBase * (t.seed + t.meterRate / t.pBase), 0);
    expect(paidOut / BASE_TOTAL_BET).toBeCloseTo(0.012, 9);

    // ...and at any stake, because the meter and the odds scale together.
    for (const totalBet of [20, 40, 100, 200]) {
      const out = JACKPOTS.reduce((a, t) => {
        const pr = t.pBase * (totalBet / BASE_TOTAL_BET);
        return a + pr * (t.seed + meterGain(t, totalBet) / pr);
      }, 0);
      expect(out / totalBet, `at a ${totalBet} credit bet`).toBeCloseTo(0.012, 9);
    }
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

  it("awards at most one jackpot tier per spin", () => {
    // Forced: an rng that always returns 0 clears every tier's threshold.
    expect(rollJackpot(() => 0, BASE_TOTAL_BET)?.id).toBe("grand");
    expect(rollJackpot(() => 1, BASE_TOTAL_BET)).toBeNull();
  });
});
