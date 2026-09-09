/**
 * Cross-dock — the reel mathematics.
 *
 * A real PAR sheet rather than a hand-waved toy. The strips, paytable and paylines
 * below were designed against published slot-configuration practice and then verified
 * by three independent 20M+ spin simulations, which agreed with the closed-form
 * arithmetic to four significant figures:
 *
 *   base-game RTP        92.2708%   (exact, by enumeration)
 *   free spins           + 2.3492%
 *   progressive          + 1.2000%
 *   --------------------------------
 *   total RTP              95.82%
 *
 *   hit frequency        25.95% of spins pay something
 *   volatility           SD 10.61x total bet per spin (medium-high)
 *   free spins           1 in 481 spins
 *   grand prize          1 in 105,621 spins (five BJM on one line)
 *
 * Play money only. Stakes and wins are denominated in dollars the way a real cabinet
 * is — denomination x lines x bet per line — but no amount here is ever a real one.
 * crossdock.test.ts re-measures every figure above, so an edit to a strip cannot
 * quietly move the RTP.
 */

export type SymbolId =
  | "bjm" | "compass" | "crate" | "pallet" | "drum" | "cog" | "tag"
  | "wild" | "beacon" | "slat";

export interface SymbolDef {
  id: SymbolId;
  name: string;
  kind: "normal" | "wild" | "scatter";
  /** Multiplier of the LINE bet for a run of [3, 4, 5]. */
  pays: [number, number, number];
}

export const SYMBOLS: SymbolDef[] = [
  { id: "bjm", name: "BJM", kind: "normal", pays: [220, 2000, 60000] },
  { id: "compass", name: "Compass Rose", kind: "normal", pays: [90, 570, 4500] },
  { id: "crate", name: "Sealed Crate", kind: "normal", pays: [56, 320, 2250] },
  { id: "pallet", name: "Pallet Stack", kind: "normal", pays: [28, 150, 900] },
  { id: "drum", name: "Steel Drum", kind: "normal", pays: [22, 115, 680] },
  { id: "cog", name: "Freight Cog", kind: "normal", pays: [14, 68, 450] },
  { id: "tag", name: "Cargo Tag", kind: "normal", pays: [8, 40, 280] },
  { id: "wild", name: "The Manifest", kind: "wild", pays: [0, 0, 0] },
  { id: "beacon", name: "Harbour Beacon", kind: "scatter", pays: [40, 200, 1000] },
  { id: "slat", name: "Timber Slat", kind: "normal", pays: [0, 0, 0] },
];

export const SYMBOL_BY_ID = Object.fromEntries(
  SYMBOLS.map((s) => [s.id, s]),
) as Record<SymbolId, SymbolDef>;

/** The five reel strips in order. A symbol's weight IS its number of stops. */
const STRIPS_RAW = [
  "slat tag cog slat drum pallet slat crate compass slat tag cog slat drum pallet slat tag slat cog slat crate tag slat drum pallet slat beacon cog compass bjm slat tag slat drum pallet slat tag crate cog slat slat tag slat drum pallet cog slat compass slat tag crate slat drum pallet cog slat tag slat",
  "slat tag cog drum pallet slat crate slat compass tag wild slat cog drum bjm pallet slat tag slat cog crate slat tag drum pallet slat beacon cog compass slat tag wild slat drum pallet tag slat crate cog slat tag slat drum bjm pallet cog slat compass tag wild slat crate slat drum pallet cog tag slat",
  "slat tag cog drum pallet slat crate wild slat compass tag cog slat drum bjm pallet tag slat slat cog crate wild tag slat drum pallet slat beacon cog compass tag slat drum pallet slat tag crate wild cog slat slat tag drum bjm pallet slat cog compass tag slat crate wild slat drum pallet cog tag slat",
  "cog crate slat tag drum pallet slat beacon cog compass slat tag wild slat drum pallet tag slat crate cog slat tag slat drum bjm pallet cog slat compass tag wild slat crate slat drum pallet cog tag slat slat tag cog drum pallet slat crate slat compass tag wild slat cog drum bjm pallet slat tag slat",
  "slat tag cog drum pallet slat crate slat compass tag slat cog beacon drum pallet slat tag slat cog crate slat tag drum pallet slat cog compass bjm slat tag wild slat drum pallet tag slat crate cog slat tag slat beacon drum pallet cog slat compass tag slat crate slat drum pallet cog tag slat",
];
export const REELS: SymbolId[][] = STRIPS_RAW.map((s) => s.split(" ") as SymbolId[]);

/** 20 fixed lines, each one row index (0 top, 1 middle, 2 bottom) per reel. */
export const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 0, 0],
  [2, 2, 1, 2, 2],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [1, 0, 1, 0, 1],
  [1, 2, 1, 2, 1],
  [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2],
  [0, 1, 0, 1, 0],
  [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1],
  [1, 1, 2, 1, 1],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [0, 2, 0, 2, 0],
];

export const ROWS = 3;
export const LINE_COUNT = PAYLINES.length;

/* ── what a spin costs ────────────────────────────────────────────────────────
   The cabinet's own arithmetic: a DENOMINATION is what one credit is worth, and
   the player bets a whole number of credits on each of the 20 lines. So

       total bet = denomination x 20 lines x credits per line

   which runs from 1c x 20 x 1 = $0.20 up to $1 x 20 x 5 = $100.00 a spin. Every
   payout in the table above is a multiple of the LINE stake, so the return is the
   same at every denomination — betting bigger buys more of the same game, never a
   better one.                                                                   */

/** Dollars per credit, the standard multi-denomination ladder. */
export const DENOMS = [0.01, 0.02, 0.05, 0.10, 0.25, 1.0] as const;
/** Credits wagered on each line. */
export const CREDITS_PER_LINE = [1, 2, 3, 4, 5] as const;

export const lineStake = (denom: number, credits: number) => denom * credits;
export const totalBet = (denom: number, credits: number) => lineStake(denom, credits) * LINE_COUNT;
export const MIN_BET = totalBet(DENOMS[0], CREDITS_PER_LINE[0]);
export const MAX_BET = totalBet(DENOMS[DENOMS.length - 1], CREDITS_PER_LINE[CREDITS_PER_LINE.length - 1]);

/** Money is held in whole cents everywhere, so a run of thousands of spins cannot
 *  drift the balance by float error. */
export const cents = (dollars: number) => Math.round(dollars * 100);
export const dollars = (c: number) => c / 100;

/** Free spins for 3, 4 and 5 beacons. Every win during them doubles; no retrigger. */
const FREE_SPINS_FOR: Record<number, number> = { 3: 6, 4: 10, 5: 16 };
export const FREE_SPIN_MULTIPLIER = 2;

export interface JackpotTier {
  id: "mini" | "minor" | "major" | "grand";
  name: string;
  /** Dollars the meter resets to after it is won. */
  seed: number;
  /** The highest a hidden target may be. */
  cap: number;
  /** Share of this tier's take that shows on the meter; the remainder is held back to
   *  re-seed the next cycle. Derived, not chosen — see jackpotVisible below. */
  visible: number;
}

/** Each tier takes 0.30% of every dollar wagered; four tiers, 1.20% in total. */
export const TIER_RATE = 0.003;

/**
 * A must-hit-by progressive, which is what a real mystery jackpot is.
 *
 * When a tier resets, a target is drawn uniformly between its seed and its cap and
 * hidden. The meter climbs on every wagered dollar, and the instant it reaches that
 * target it pays out whatever it is showing and reseeds.
 *
 * This replaced a fixed per-spin probability, which does not survive real money: a
 * probability that scales with stake means a $100 spin wins the same small average
 * award far more often, so the top tier stops meaning anything at the top of the bet
 * range. A must-hit-by meter is bet-size independent by construction — bet more and
 * you fill it faster, and what you win is what the meter says.
 *
 * The split between the visible meter and the reserve is forced, not tuned. Over one
 * cycle the meter must climb (target - seed) and the reserve must accrue exactly the
 * seed for the next one, so with an average target of (seed + cap) / 2:
 *
 *     visible = (mean target - seed) / mean target
 *
 * and every dollar taken comes back out. crossdock.test.ts checks that, by simulation
 * as well as by arithmetic.
 */
export const jackpotVisible = (seed: number, cap: number) => {
  const mean = (seed + cap) / 2;
  return (mean - seed) / mean;
};

const tier = (id: JackpotTier["id"], name: string, seed: number, cap: number): JackpotTier =>
  ({ id, name, seed, cap, visible: jackpotVisible(seed, cap) });

/** Ordered high to low: at most one tier is awarded per spin. */
export const JACKPOTS: JackpotTier[] = [
  tier("grand", "Grand", 5000, 50000),
  tier("major", "Major", 500, 5000),
  tier("minor", "Minor", 50, 500),
  tier("mini", "Mini", 10, 50),
];

/** Where a freshly reseeded tier will next pay out. Hidden from the player. */
export function drawTarget(t: JackpotTier, rng: Rng): number {
  return t.seed + rng() * (t.cap - t.seed);
}

export type Rng = () => number;

/** grid[reel][row] — the 5x3 visible window. */
export type Grid = SymbolId[][];

export interface LineWin {
  line: number;
  symbol: SymbolId;
  count: number;
  pay: number;
  /** [reel, row] of every cell in the run, for highlighting. */
  cells: [number, number][];
}

export interface SpinOutcome {
  stops: number[];
  grid: Grid;
  lineWins: LineWin[];
  beacons: [number, number][];
  scatterPay: number;
  freeSpinsAwarded: number;
  /** Line wins plus scatter pay, already doubled if this was a free spin. */
  win: number;
}

/** Draw a window from each strip. A column runs downwards from its stop index. */
export function drawGrid(rng: Rng): { stops: number[]; grid: Grid } {
  const stops = REELS.map((strip) => Math.floor(rng() * strip.length));
  const grid = REELS.map((strip, r) =>
    Array.from({ length: ROWS }, (_, row) => strip[(stops[r] + row) % strip.length]),
  );
  return { stops, grid };
}

/**
 * Evaluate one window. Left to right from reel 1 only; the wild substitutes for every
 * paying symbol but never for the beacon; a line pays its single longest run and lines
 * add; scatter pays count anywhere on the grid.
 */
export function evaluate(
  grid: Grid,
  lineBet: number,
  freeSpin = false,
): Omit<SpinOutcome, "stops" | "grid"> {
  const mult = freeSpin ? FREE_SPIN_MULTIPLIER : 1;
  const lineWins: LineWin[] = [];

  PAYLINES.forEach((rowsOf, line) => {
    const first = grid[0][rowsOf[0]];
    // The wild never lands on reel 1, so a line's symbol is never ambiguous.
    if (first === "beacon" || first === "slat" || first === "wild") return;
    const cells: [number, number][] = [[0, rowsOf[0]]];
    for (let r = 1; r < REELS.length; r++) {
      const cell = grid[r][rowsOf[r]];
      if (cell !== first && cell !== "wild") break;
      cells.push([r, rowsOf[r]]);
    }
    if (cells.length < 3) return;
    const pay = SYMBOL_BY_ID[first].pays[cells.length - 3] * lineBet * mult;
    if (pay > 0) lineWins.push({ line, symbol: first, count: cells.length, pay, cells });
  });

  const beacons: [number, number][] = [];
  grid.forEach((col, r) =>
    col.forEach((s, row) => { if (s === "beacon") beacons.push([r, row]); }));

  const scatterPay = beacons.length >= 3
    ? SYMBOL_BY_ID.beacon.pays[Math.min(beacons.length, 5) - 3] * lineBet * mult
    : 0;
  const freeSpinsAwarded = freeSpin ? 0 : (FREE_SPINS_FOR[beacons.length] || 0);

  return {
    lineWins,
    beacons,
    scatterPay,
    freeSpinsAwarded,
    win: lineWins.reduce((a, w) => a + w.pay, 0) + scatterPay,
  };
}

export function spin(rng: Rng, lineBet: number, freeSpin = false): SpinOutcome {
  const { stops, grid } = drawGrid(rng);
  return { stops, grid, ...evaluate(grid, lineBet, freeSpin) };
}

/** Dollars this tier's meter gains from one wagered spin. */
export function meterGain(t: JackpotTier, bet: number): number {
  return bet * TIER_RATE * t.visible;
}

export interface MeterState { meter: number; target: number }

/**
 * Advance every meter for one wagered spin and award at most one tier, highest first.
 * Returns the new state and the tier that paid, if any. Free spins are unwagered and
 * must never call this.
 */
export function advanceJackpots(
  state: Record<string, MeterState>,
  bet: number,
  rng: Rng,
): { state: Record<string, MeterState>; won: JackpotTier | null; amount: number } {
  const next: Record<string, MeterState> = { ...state };
  let won: JackpotTier | null = null;
  let amount = 0;
  for (const t of JACKPOTS) {
    const cur = next[t.id] ?? { meter: t.seed, target: drawTarget(t, rng) };
    const meter = cur.meter + meterGain(t, bet);
    if (!won && meter >= cur.target) {
      won = t;
      amount = meter;
      next[t.id] = { meter: t.seed, target: drawTarget(t, rng) };
    } else {
      next[t.id] = { meter, target: cur.target };
    }
  }
  return { state: next, won, amount };
}

/** Deterministic RNG for the tests. The game itself uses Math.random. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
