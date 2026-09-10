import { describe, it, expect } from "vitest";
import {
  encodeScore, decodeScore, normalise, board, addRival, net, localScores, loadRivals,
  SAVE_PREFIX, RIVALS_KEY, type Score,
} from "./crossdock-score";

const score = (name: string, over: Partial<Score> = {}): Score =>
  normalise(name, { spins: 100, wagered: 2000, won: 1900, best: 500, jackpots: 0, at: 0, ...over });

/** A stand-in for localStorage, since the tests run without a DOM. */
function fakeStore(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  } as Storage;
}

describe("cross-dock share codes", () => {
  it("round-trips a score exactly", () => {
    const s = score("Ben", { spins: 4213, wagered: 842600, won: 913455, best: 250000, jackpots: 3, at: 1757460000000 });
    const back = decodeScore(encodeScore(s));
    expect(back).toEqual(s);
  });

  it("survives a name with punctuation and accents", () => {
    for (const name of ["Jack Mildice", "Ben — sales", "Ana Ruiz", 'the "house"', "Zoë"]) {
      expect(decodeScore(encodeScore(score(name)))?.name).toBe(name);
    }
  });

  it("stays short enough to paste into a message", () => {
    expect(encodeScore(score("Jack Mildice", { wagered: 99999999, won: 99999999 })).length).toBeLessThan(140);
  });

  it("refuses anything that is not one of ours, or has been mangled", () => {
    const good = encodeScore(score("Jack"));
    expect(decodeScore(good)).not.toBeNull();
    expect(decodeScore("")).toBeNull();
    expect(decodeScore("hello")).toBeNull();
    expect(decodeScore("XD1.abc")).toBeNull();
    expect(decodeScore("XD2." + good.split(".").slice(1).join("."))).toBeNull();
    // one character dropped out of the payload, the classic copy-paste injury
    const [tag, payload, sum] = good.split(".");
    expect(decodeScore(`${tag}.${payload.slice(0, -1)}.${sum}`)).toBeNull();
    expect(decodeScore(`${tag}.${payload}.zzzz`)).toBeNull();
  });

  it("tolerates whitespace around a pasted code", () => {
    const s = score("Jack");
    expect(decodeScore(`  ${encodeScore(s)}\n`)).toEqual(s);
  });

  it("never trusts the numbers inside a code", () => {
    const nasty = decodeScore(encodeScore(normalise("x".repeat(200), {
      spins: -5, wagered: Number.NaN, won: Infinity, best: -1, jackpots: 2.7, at: -3,
    })))!;
    expect(nasty.name.length).toBeLessThanOrEqual(40);
    for (const k of ["spins", "wagered", "won", "best", "jackpots", "at"] as const) {
      expect(Number.isFinite(nasty[k])).toBe(true);
      expect(nasty[k]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("cross-dock board", () => {
  it("ranks on money made, not on money won", () => {
    const grinder = score("Grinder", { wagered: 1_000_000, won: 950_000 });   // -$500
    const lucky = score("Lucky", { wagered: 2_000, won: 12_000 });            // +$100
    expect(board([grinder, lucky], []).map((s) => s.name)).toEqual(["Lucky", "Grinder"]);
    expect(net(lucky)).toBe(10_000);
    expect(net(grinder)).toBe(-50_000);
  });

  it("prefers this device's live score over a pasted copy of the same person", () => {
    const live = score("Jack", { won: 5_000 });
    const stale = score("jack", { won: 900_000, at: 9_999_999 });
    const [top] = board([live], [stale]);
    expect(top.won).toBe(5_000);
    expect(board([live], [stale])).toHaveLength(1);
  });

  it("keeps the newer of two pasted codes and cannot be rewound by an old one", () => {
    const older = score("Ben", { won: 1_000, at: 100 });
    const newer = score("Ben", { won: 9_000, at: 200 });
    expect(board([], [older, newer])[0].won).toBe(9_000);
    expect(board([], [newer, older])[0].won).toBe(9_000);

    let rivals = addRival([], newer);
    rivals = addRival(rivals, older);           // re-pasting yesterday's code
    expect(rivals).toHaveLength(1);
    expect(rivals[0].won).toBe(9_000);
  });

  it("breaks a tie on the biggest single win, then the name", () => {
    const a = score("Ana", { wagered: 100, won: 100, best: 50 });
    const b = score("Bo", { wagered: 100, won: 100, best: 900 });
    const c = score("Cy", { wagered: 100, won: 100, best: 50 });
    expect(board([a, b, c], []).map((s) => s.name)).toEqual(["Bo", "Ana", "Cy"]);
  });
});

describe("cross-dock local reads", () => {
  it("finds every save on the device and ignores everything else", () => {
    const store = fakeStore({
      [`${SAVE_PREFIX}usr_1`]: JSON.stringify({ name: "Jack", stats: { spins: 10, wagered: 200, won: 340, best: 300, jackpots: 1 } }),
      [`${SAVE_PREFIX}usr_2`]: JSON.stringify({ name: "Ben", stats: { spins: 4, wagered: 80, won: 0, best: 0, jackpots: 0 } }),
      "clienthub_dark": "1",
      "clienthub_crossdock_muted": "0",
    });
    const found = localScores(store).sort((x, y) => x.name.localeCompare(y.name));
    expect(found.map((s) => s.name)).toEqual(["Ben", "Jack"]);
    expect(found[1].won).toBe(340);
  });

  it("skips a save it cannot parse rather than throwing", () => {
    const store = fakeStore({
      [`${SAVE_PREFIX}broken`]: "{not json",
      [`${SAVE_PREFIX}empty`]: JSON.stringify({ name: "No stats" }),
      [`${SAVE_PREFIX}ok`]: JSON.stringify({ name: "Fine", stats: { spins: 1, wagered: 20, won: 0, best: 0, jackpots: 0 } }),
    });
    expect(localScores(store).map((s) => s.name)).toEqual(["Fine"]);
  });

  it("falls back to an empty board when the rivals key is rubbish", () => {
    expect(loadRivals(fakeStore({ [RIVALS_KEY]: "nonsense" }))).toEqual([]);
    expect(loadRivals(fakeStore())).toEqual([]);
  });
});
