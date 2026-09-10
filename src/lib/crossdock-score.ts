/**
 * Cross-dock — the scoreboard, without a server.
 *
 * A leaderboard normally needs somewhere shared to put it, and every shared place this
 * app owns is the droplet the iOS app also talks to. Jack's call, and the right one:
 * nothing about this game goes near a backend an App Store reviewer can reach, because
 * gambling content on a reviewed surface is a Guideline 5.3 problem whatever the data
 * actually is. So the scoreboard crosses machines the only way that touches nothing —
 * you copy a short code and send it however you like.
 *
 * Two sources feed it:
 *   - every Cross-dock save on THIS device, so two people sharing a machine just work;
 *   - rivals pasted in from a code, kept in one local key of their own.
 *
 * A code is `XD1.<base64url payload>.<checksum>`. The checksum is not security — there
 * is nothing here worth forging — it is there so a code mangled by a chat client fails
 * cleanly instead of loading a plausible wrong number.
 */

export interface Score {
  name: string;
  /** All cents, except `spins` and `jackpots`. */
  spins: number;
  wagered: number;
  won: number;
  best: number;
  jackpots: number;
  /** When the code was made, ms since epoch. 0 for a score read off this device. */
  at: number;
}

export const SAVE_PREFIX = "clienthub_crossdock_v2_";
export const RIVALS_KEY = "clienthub_crossdock_rivals";

/** What the board actually ranks on: money made, which is what came back minus what
 *  went in. It is the only measure that cannot be gamed by simply playing longer. */
export const net = (s: Score) => s.won - s.wagered;

const clean = (n: unknown) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(-1e15, Math.min(1e15, v)) : 0;
};

export function normalise(name: string, raw: Partial<Score>): Score {
  return {
    name: String(name || "Someone").trim().slice(0, 40) || "Someone",
    spins: Math.max(0, clean(raw.spins)),
    wagered: Math.max(0, clean(raw.wagered)),
    won: Math.max(0, clean(raw.won)),
    best: Math.max(0, clean(raw.best)),
    jackpots: Math.max(0, clean(raw.jackpots)),
    at: Math.max(0, clean(raw.at)),
  };
}

/* ── the code ─────────────────────────────────────────────────────────────── */

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
};

const b64url = {
  encode: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))),
};

export function encodeScore(s: Score): string {
  // Short keys, fixed order — the code gets pasted into a message, so length matters.
  const body = JSON.stringify([s.name, s.spins, s.wagered, s.won, s.best, s.jackpots, s.at]);
  const payload = b64url.encode(body);
  return `XD1.${payload}.${hash(payload)}`;
}

/** Returns null for anything that is not one of our codes, or has been mangled. */
export function decodeScore(code: string): Score | null {
  const parts = String(code || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "XD1") return null;
  const [, payload, sum] = parts;
  if (hash(payload) !== sum) return null;
  try {
    const a = JSON.parse(b64url.decode(payload));
    if (!Array.isArray(a) || a.length < 7) return null;
    return normalise(String(a[0]), { spins: a[1], wagered: a[2], won: a[3], best: a[4], jackpots: a[5], at: a[6] });
  } catch { return null; }
}

/* ── reading the board ────────────────────────────────────────────────────── */

/** Every Cross-dock save on this device, newest stats as they stand. */
export function localScores(store: Storage): Score[] {
  const out: Score[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k || !k.startsWith(SAVE_PREFIX)) continue;
    try {
      const v = JSON.parse(store.getItem(k) || "");
      if (!v || typeof v !== "object" || !v.stats) continue;
      out.push(normalise(v.name || k.slice(SAVE_PREFIX.length), { ...v.stats, at: 0 }));
    } catch { /* a save we cannot read is simply not on the board */ }
  }
  return out;
}

export function loadRivals(store: Storage): Score[] {
  try {
    const raw = JSON.parse(store.getItem(RIVALS_KEY) || "[]");
    return Array.isArray(raw) ? raw.map((r) => normalise(r?.name, r)) : [];
  } catch { return []; }
}

export function saveRivals(store: Storage, rivals: Score[]) {
  try { store.setItem(RIVALS_KEY, JSON.stringify(rivals)); } catch { /* private window */ }
}

const key = (s: Score) => s.name.trim().toLowerCase();

/**
 * One row per person, ranked by money made. A player present on this device wins over
 * a pasted copy of the same name — the local one is live, the code is a snapshot — and
 * of two pasted copies the newer wins, so re-pasting an older code cannot rewind
 * somebody's score.
 */
export function board(local: Score[], rivals: Score[]): Score[] {
  const by = new Map<string, Score>();
  for (const r of rivals) {
    const k = key(r);
    const cur = by.get(k);
    if (!cur || r.at > cur.at) by.set(k, r);
  }
  for (const l of local) by.set(key(l), l);
  return [...by.values()].sort((a, b) => net(b) - net(a) || b.best - a.best || a.name.localeCompare(b.name));
}

/** Merge a pasted score in, replacing any older copy of the same person. */
export function addRival(rivals: Score[], s: Score): Score[] {
  const k = key(s);
  const kept = rivals.filter((r) => key(r) !== k || r.at > s.at);
  return kept.some((r) => key(r) === k) ? kept : [...kept, s];
}
