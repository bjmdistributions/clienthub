// Warehouse stock and the truckload packer (R-326, R-327, R-328).
//
// A product (New Era hats) declares its box sizes once ("Big Box" of 72, "Small Box" of 12).
// Each section (a team) holds whole boxes of each size plus the loose units left in an
// opened box, so a team's units are always sum(count x per_box) + loose.
//
// The packer answers "I'm shipping N pallets" or "I need 500 hats — which boxes do I grab?"
// First it decides how many units each team gives, by the `lean` (R-334): 0 takes the same
// from every team, 0.5 takes from each in proportion to what it holds (the load looks like
// the shelf), 1 evens out the shelf (a team holding 40% gives until it is level with the
// rest, then they all come down together); in between blends the two neighbours. Then each
// team's share is made of whole boxes, biggest first, and what whole boxes left over goes, a
// box at a time, to the team furthest below its share. What a whole box cannot make comes
// loose: out of a box already open, else by opening the smallest box that covers it — or, if
// asked, by one more whole box.
//
// The server and the desktop apply picks with warehouse_core.rs (byte-identical in both
// repos). The phone plans with a copy of this file's rule — `whPlan` in clienthub-api
// www/app.js. Change both together; the tests pin the behaviour.

import type { LineItem } from "./api";

export interface BoxType { id: string; name: string; per_box: number }

export interface WhSection {
  id: string;
  name: string;
  /** Whole boxes, by box type id. */
  counts: Record<string, number>;
  /** Units out of a full box. */
  loose: number;
}

export interface WhMoveLine {
  section_id: string;
  name: string;
  boxes: Record<string, number>;
  loose: number;
  opened: Record<string, number>;
  units: number;
}

export interface WhMove {
  id: string;
  at: string;
  kind: "out" | "in" | "count";
  lines: WhMoveLine[];
  reference: string;
  note: string;
  undone: boolean;
}

export interface WarehouseItem {
  id: string;
  name: string;
  section_label: string;
  box_types: BoxType[];
  sections: WhSection[];
  units_per_pallet: number;
  unit_price: number;
  notes: string;
  log: WhMove[];
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface WarehouseInput {
  id?: string | null;
  name: string;
  section_label: string;
  box_types: BoxType[];
  sections: WhSection[];
  units_per_pallet: number;
  unit_price: number;
  notes: string;
}

/** One section's part of a move — the shape warehouse_core.rs `Change` reads. */
export interface WhChange {
  section_id: string;
  boxes?: Record<string, number>;
  loose?: number;
  /** Negative: take this many units and let the server choose the boxes. */
  units?: number;
}

/** A section that could not supply what was asked, in units. */
export interface WhShort { name: string; wanted: number; taken: number }

// ---------- Spreadsheet import (R-328) ----------

export interface SizeCol { col: number; name: string; per_box: number }
export interface Mapping {
  header_row: number;
  layout: "rows" | "grouped" | "across";
  team_col: number | null;
  size_col: number | null;
  boxes_col: number | null;
  per_box_col: number | null;
  units_col: number | null;
  size_cols: SizeCol[];
}
export interface ImportResult {
  box_types: BoxType[];
  sections: WhSection[];
  warnings: string[];
  rows_used: number;
  rows_skipped: number;
}
export interface SheetRead { rows: string[][]; sheet_name: string | null; note: string | null; guess: Mapping }

/** "A", "B", ... "AA" — how a person names a column. */
export function colName(c: number): string {
  let n = c + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Text pasted out of a spreadsheet (tab-separated) or a CSV, as rows of cells. */
export function rowsFromText(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.some((l) => l.includes("\t"))) return lines.map((l) => l.split("\t").map((c) => c.trim()));
  return lines.map((line) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

// ---------- Counting ----------

const perOf = (types: BoxType[], id: string) => Math.max(0, types.find((t) => t.id === id)?.per_box ?? 0);

export const sectionUnits = (types: BoxType[], s: WhSection) =>
  Object.entries(s.counts || {}).reduce((a, [t, n]) => a + n * perOf(types, t), 0) + (s.loose || 0);

export const sectionBoxes = (s: WhSection) => Object.values(s.counts || {}).reduce((a, n) => a + n, 0);

export function itemTotals(item: Pick<WarehouseItem, "box_types" | "sections" | "units_per_pallet">) {
  const boxes = item.sections.reduce((a, s) => a + sectionBoxes(s), 0);
  const units = item.sections.reduce((a, s) => a + sectionUnits(item.box_types, s), 0);
  const pallets = item.units_per_pallet > 0 ? units / item.units_per_pallet : null;
  return { boxes, units, pallets };
}

/** Share of the product's units each section holds, 0..1. */
export function shares(types: BoxType[], sections: WhSection[]): Record<string, number> {
  const total = sections.reduce((a, s) => a + sectionUnits(types, s), 0);
  const out: Record<string, number> = {};
  for (const s of sections) out[s.id] = total > 0 ? sectionUnits(types, s) / total : 0;
  return out;
}

// ---------- The packer ----------

export interface PickPlan {
  /** Whole boxes to grab: section id -> box type id -> count. */
  take: Record<string, Record<string, number>>;
  /** Loose units to grab, by section id. */
  loose: Record<string, number>;
  /** Boxes that have to be opened for those loose units: section id -> box type id -> count. */
  opened: Record<string, Record<string, number>>;
  /** Units grabbed, by section id. */
  units: Record<string, number>;
  /** Units asked for that could not be found (negative when a whole box went over). */
  short: number;
  /** What each section holds afterwards. */
  left: WhSection[];
}

export interface PlanOpts {
  /** Sections the buyer does not want. */
  skip?: ReadonlySet<string>;
  /** Sections pinned to an exact number of units; the rest is balanced around them. */
  fixed?: Record<string, number>;
  /** "exact": make the remainder loose. "whole": one more whole box instead. "under": whole boxes, never over (pallets). */
  finish?: "exact" | "whole" | "under";
  /** R-334: 0 the same from every team, 0.5 in proportion to stock, 1 even out the stock (the default). */
  lean?: number;
}

/** The lean's three stops, as the screens name them. */
export const LEAN_STOPS = [
  { at: 0, label: "Same from every team" },
  { at: 0.5, label: "Match my stock" },
  { at: 1, label: "Even out my stock" },
] as const;

/**
 * How many units each team gives to a load of `want` (never more than it holds), by the lean.
 * Worked in exact fractions; `planUnits` turns them into boxes.
 */
export function shareOut(held: number[], want: number, lean: number): number[] {
  const total = held.reduce((a, b) => a + b, 0);
  if (want <= 0 || total <= 0) return held.map(() => 0);
  if (want >= total) return [...held];
  // Same from every team: fill each up to a common amount, a small team giving all it has.
  const fillTo = (cap: (u: number, x: number) => number, lo: number, hi: number) => {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (held.reduce((a, u) => a + cap(u, mid), 0) < want) lo = mid; else hi = mid;
    }
    return hi;
  };
  const top = Math.max(...held);
  const e = fillTo((u, x) => Math.min(u, x), 0, top);
  const same = held.map((u) => Math.min(u, e));
  const match = held.map((u) => (want * u) / total);
  // Even out: everything above a common level.
  const l = fillTo((u, x) => Math.max(0, u - (top - x)), 0, top);
  const level = held.map((u) => Math.max(0, u - (top - l)));
  const x = Math.min(1, Math.max(0, Number.isFinite(lean) ? lean : 1));
  const [a, b, t] = x <= 0.5 ? [same, match, x / 0.5] : [match, level, (x - 0.5) / 0.5];
  return held.map((_, i) => (1 - t) * a[i] + t * b[i]);
}

type Cursor = { s: WhSection; i: number };

const cloneSections = (sections: WhSection[]) =>
  sections.map((s) => ({ ...s, counts: { ...(s.counts || {}) }, loose: Math.max(0, s.loose || 0) }));

const add = (m: Record<string, Record<string, number>>, sid: string, tid: string, n: number) => {
  (m[sid] ||= {})[tid] = (m[sid][tid] || 0) + n;
};

/** Sizes in a section that still have boxes, biggest first. */
function sizesIn(types: BoxType[], s: WhSection) {
  return types.filter((t) => t.per_box > 0 && (s.counts[t.id] || 0) > 0).sort((a, b) => b.per_box - a.per_box);
}

/**
 * Take `want` loose units out of one section: the open box first, then the smallest box
 * that covers what is left (the biggest there is, again, if none does). Same as
 * warehouse_core.rs `take_loose`.
 */
function takeLoose(types: BoxType[], s: WhSection, want: number, opened: Record<string, number>): number {
  const fromLoose = Math.min(want, s.loose);
  s.loose -= fromLoose;
  let need = want - fromLoose;
  while (need > 0) {
    const have = sizesIn(types, s);
    if (!have.length) break;
    const t = [...have].reverse().find((x) => x.per_box >= need) || have[0];
    s.counts[t.id] -= 1;
    opened[t.id] = (opened[t.id] || 0) + 1;
    const got = Math.min(need, t.per_box);
    s.loose += t.per_box - got;
    need -= got;
  }
  return want - need;
}

/** One section, n units: whole boxes biggest first while one fits, then loose. Same as warehouse_core.rs `take_units`. */
export function takeUnits(types: BoxType[], s: WhSection, n: number) {
  const boxes: Record<string, number> = {};
  const opened: Record<string, number> = {};
  let rem = Math.max(0, Math.floor(n));
  for (const t of sizesIn(types, s)) {
    const k = Math.min(s.counts[t.id], Math.floor(rem / t.per_box));
    if (k > 0) { s.counts[t.id] -= k; boxes[t.id] = k; rem -= k * t.per_box; }
  }
  const loose = takeLoose(types, s, rem, opened);
  return { boxes, loose, opened, short: rem - loose };
}

/**
 * The pick for `target` units: each team's share by the lean, made of whole boxes, the rest
 * finished by `finish`. See the header of this file; the tests pin it on the shapes it has to
 * get right.
 */
export function planUnits(types: BoxType[], sections: WhSection[], target: number, opts: PlanOpts = {}): PickPlan {
  const skip = opts.skip ?? new Set<string>();
  const fixed = opts.fixed ?? {};
  const finish = opts.finish ?? "exact";
  const left = cloneSections(sections);
  const take: PickPlan["take"] = {};
  const loose: PickPlan["loose"] = {};
  const opened: PickPlan["opened"] = {};
  let rem = Math.max(0, Math.floor(target || 0));

  // Pinned sections first, by the one-section rule.
  for (const s of left) {
    const want = fixed[s.id];
    if (want == null || skip.has(s.id)) continue;
    const ask = Math.min(Math.max(0, want), rem);
    const r = takeUnits(types, s, ask);
    for (const [t, n] of Object.entries(r.boxes)) add(take, s.id, t, n);
    for (const [t, n] of Object.entries(r.opened)) add(opened, s.id, t, n);
    if (r.loose) loose[s.id] = (loose[s.id] || 0) + r.loose;
    rem -= ask - r.short;
  }

  const pool: (Cursor & { owe: number })[] = left
    .map((s, i) => ({ s, i, owe: 0 }))
    .filter(({ s }) => !skip.has(s.id) && fixed[s.id] == null && sectionUnits(types, s) > 0);
  const owed = shareOut(pool.map((c) => sectionUnits(types, c.s)), rem, opts.lean ?? 1);

  // Each team's share in whole boxes, biggest first, never past the share.
  pool.forEach((c, k) => {
    let want = owed[k];
    for (const t of sizesIn(types, c.s)) {
      const n = Math.min(c.s.counts[t.id], Math.floor((want + 1e-9) / t.per_box));
      if (n > 0) { c.s.counts[t.id] -= n; add(take, c.s.id, t.id, n); want -= n * t.per_box; rem -= n * t.per_box; }
    }
    c.owe = want;
  });
  // Who is furthest below its share; then the bigger team; then the first.
  const behind = (a: (typeof pool)[number], b: (typeof pool)[number]) => {
    if (Math.abs(a.owe - b.owe) > 1e-9) return a.owe > b.owe;
    const ua = sectionUnits(types, a.s), ub = sectionUnits(types, b.s);
    return ua !== ub ? ua > ub : a.i < b.i;
  };

  // What whole boxes left over, a box at a time to the team furthest below its share — the
  // size nearest what it is owed that still fits.
  for (;;) {
    let best: (typeof pool)[number] | null = null;
    for (const c of pool) if (sizesIn(types, c.s).some((t) => t.per_box <= rem) && (!best || behind(c, best))) best = c;
    if (!best) break;
    const fits = sizesIn(types, best.s).filter((t) => t.per_box <= rem);
    const owe = best.owe;
    const t = fits.reduce((p, q) => (Math.abs(q.per_box - owe) < Math.abs(p.per_box - owe) ? q : p));
    best.s.counts[t.id] -= 1;
    add(take, best.s.id, t.id, 1);
    best.owe -= t.per_box;
    rem -= t.per_box;
  }

  if (rem > 0 && finish === "whole") {
    // One more whole box: the smallest that covers the rest, from the team furthest below its share.
    let best: (typeof pool)[number] | null = null;
    for (const c of pool) if (sizesIn(types, c.s).some((t) => t.per_box >= rem) && (!best || behind(c, best))) best = c;
    if (best) {
      const t = [...sizesIn(types, best.s)].reverse().find((x) => x.per_box >= rem)!;
      best.s.counts[t.id] -= 1;
      add(take, best.s.id, t.id, 1);
      rem -= t.per_box;
    }
  } else if (rem > 0 && finish === "exact") {
    // Boxes already open before opening another.
    while (rem > 0) {
      let best: (typeof pool)[number] | null = null;
      for (const c of pool) if (c.s.loose > 0 && (!best || behind(c, best))) best = c;
      if (!best) break;
      const x = Math.min(rem, best.s.loose);
      best.s.loose -= x;
      best.owe -= x;
      loose[best.s.id] = (loose[best.s.id] || 0) + x;
      rem -= x;
    }
    while (rem > 0) {
      let best: (typeof pool)[number] | null = null;
      for (const c of pool) if (sectionBoxes(c.s) > 0 && (!best || behind(c, best))) best = c;
      if (!best) break;
      const op: Record<string, number> = {};
      const got = takeLoose(types, best.s, rem, op);
      for (const [t, n] of Object.entries(op)) add(opened, best.s.id, t, n);
      loose[best.s.id] = (loose[best.s.id] || 0) + got;
      best.owe -= got;
      rem -= got;
      if (!got) break;
    }
  }

  for (const s of left) s.counts = Object.fromEntries(Object.entries(s.counts).filter(([, n]) => n > 0));
  const units: Record<string, number> = {};
  for (const s of sections) {
    const u = Object.entries(take[s.id] || {}).reduce((a, [t, n]) => a + n * perOf(types, t), 0) + (loose[s.id] || 0);
    if (u > 0) units[s.id] = u;
  }
  return { take, loose, opened, units, short: rem, left };
}

// ---------- Send to invoice ----------

/** Which warehouse section an invoice line came from, and exactly what the packer planned for it. */
export interface WhTag { section_id: string; name: string; boxes: Record<string, number>; loose: number; units: number }

export interface InvoicePrefill {
  lines: (LineItem & { wh?: WhTag })[];
  warehouse: { item_id: string; item_name: string };
  /** R-342: built in the warehouse — the boxes already left the shelf as they were grabbed. */
  built?: boolean;
}

/** localStorage key the packer stashes a prefilled invoice under (read once by Invoices). */
export const INVOICE_PREFILL_KEY = "invoices_prefill";

/** "3 × Big Box, 1 × Small Square, 20 loose" */
export function describePick(types: BoxType[], boxes: Record<string, number>, loose: number): string {
  const parts = types
    .filter((t) => (boxes[t.id] || 0) > 0)
    .map((t) => `${boxes[t.id].toLocaleString()} × ${t.name}`);
  if (loose > 0) parts.push(`${loose.toLocaleString()} loose`);
  return parts.join(", ");
}

/**
 * One invoice line per section picked, biggest first: quantity in units at the product's
 * price per unit, with the boxes in the description so the buyer and the warehouse read the
 * same thing.
 */
export function invoiceLines(
  item: Pick<WarehouseItem, "name" | "box_types" | "sections" | "unit_price">,
  plan: Pick<PickPlan, "take" | "loose" | "units">,
  /** A sale price per unit for one section, over the product's own (R-329). */
  rates: Record<string, number> = {},
): (LineItem & { wh: WhTag })[] {
  return item.sections
    .filter((s) => (plan.units[s.id] || 0) > 0)
    .sort((a, b) => (plan.units[b.id] - plan.units[a.id]) || a.name.localeCompare(b.name))
    .map((s) => {
      const qty = plan.units[s.id];
      const boxes = plan.take[s.id] || {};
      const lo = plan.loose[s.id] || 0;
      const rate = rates[s.id] ?? (item.unit_price || 0);
      return {
        description: `${item.name} — ${s.name}: ${describePick(item.box_types, boxes, lo)}`,
        qty,
        rate,
        amount: Math.round(qty * rate * 100) / 100,
        wh: { section_id: s.id, name: s.name, boxes: { ...boxes }, loose: lo, units: qty },
      };
    });
}

/**
 * What an invoice actually carries off the shelf, read from its final lines. A line left as
 * planned takes exactly the planned boxes; a line whose quantity was changed takes that many
 * units, the boxes chosen by the one-section rule on the server; a deleted line takes nothing.
 */
export function changesForInvoice(lines: { qty: number; wh?: WhTag }[]): WhChange[] {
  const out: WhChange[] = [];
  for (const l of lines) {
    if (!l.wh) continue;
    const q = Math.max(0, Math.round(l.qty || 0));
    if (q <= 0) continue;
    if (q === l.wh.units) {
      out.push({
        section_id: l.wh.section_id,
        boxes: Object.fromEntries(Object.entries(l.wh.boxes).map(([t, n]) => [t, -n])),
        loose: l.wh.loose ? -l.wh.loose : 0,
      });
    } else {
      out.push({ section_id: l.wh.section_id, units: -q });
    }
  }
  return out;
}

/** Units the warehouse lines on an invoice add up to. */
export const unitsOnInvoice = (lines: { qty: number; wh?: WhTag }[]) =>
  lines.reduce((a, l) => a + (l.wh ? Math.max(0, Math.round(l.qty || 0)) : 0), 0);

/** Invoice lines as the invoice stores them — the warehouse tag stays in the form. */
export const plainLines = (lines: LineItem[]): LineItem[] =>
  lines.map(({ description, qty, rate, amount }) => ({ description, qty, rate, amount }));

// ---------- Picking an order by hand (R-329) ----------

/** What was taken off the shelf for an order: whole boxes by section and size, and loose units. */
export interface HandPick { take: Record<string, Record<string, number>>; loose: Record<string, number> }

export const emptyPick = (): HandPick => ({ take: {}, loose: {} });

/** Units a hand pick comes to, by section — the shape invoiceLines reads. */
export function pickUnits(types: BoxType[], pick: HandPick): Record<string, number> {
  const out: Record<string, number> = {};
  const ids = new Set([...Object.keys(pick.take), ...Object.keys(pick.loose)]);
  for (const sid of ids) {
    const u = Object.entries(pick.take[sid] || {}).reduce((a, [t, n]) => a + n * perOf(types, t), 0) + (pick.loose[sid] || 0);
    if (u > 0) out[sid] = u;
  }
  return out;
}

/** The most loose units a hand pick can take from a section: whatever is not already picked as
 *  whole boxes. Past what is loose now, the server opens a box (warehouse_core take_loose). */
export function looseRoom(types: BoxType[], pick: HandPick, s: WhSection): number {
  const inBoxes = Object.entries(pick.take[s.id] || {}).reduce((a, [t, n]) => a + n * perOf(types, t), 0);
  return Math.max(0, sectionUnits(types, s) - inBoxes);
}

/** Set one count on a hand pick, never past what the shelf holds and never below zero. Loose
 *  units are capped by `looseMax` (default: what is loose now). */
export function setPicked(pick: HandPick, s: WhSection, typeId: string | null, n: number, looseMax?: number): HandPick {
  const next: HandPick = { take: { ...pick.take }, loose: { ...pick.loose } };
  if (typeId === null) {
    const v = Math.max(0, Math.min(Math.floor(n || 0), looseMax ?? (s.loose || 0)));
    if (v) next.loose[s.id] = v; else delete next.loose[s.id];
  } else {
    const row = { ...(next.take[s.id] || {}) };
    const v = Math.max(0, Math.min(Math.floor(n || 0), s.counts[typeId] || 0));
    if (v) row[typeId] = v; else delete row[typeId];
    if (Object.keys(row).length) next.take[s.id] = row; else delete next.take[s.id];
  }
  return next;
}

/** A packer plan as a hand pick, to adjust box by box before it is sent. */
export const pickFromPlan = (plan: Pick<PickPlan, "take" | "loose">): HandPick =>
  ({ take: JSON.parse(JSON.stringify(plan.take)), loose: { ...plan.loose } });

// ---------- The warehouse map (R-330, R-332, R-333) ----------

export interface LayoutCell {
  r: number;
  c: number;
  item_id: string;
  section_id: string;
  label: string;
  /** How full, in quarters: 0 empty .. 4 full. */
  fill: number;
  note: string;
  aisle: boolean;
}

/** A door in a floor map's wall: "top" is the row A side, "bottom" the last row's, "left" spot 1's
 *  end, "right" the far end. `at` is the first spot (top/bottom) or row (left/right) it spans. */
export interface Door {
  id: string;
  side: "top" | "bottom" | "left" | "right";
  at: number;
  width: number;
  kind: "garage" | "dock" | "door";
  label: string;
}

/** One level of a shelf on a floor map, bottom level first. */
export interface ShelfLevel { item_id: string; section_id: string; label: string; fill: number }

/** A shelf unit standing on a pallet floor in place of a pallet spot (R-333). */
export interface FloorShelf { levels: ShelfLevel[]; note: string }

/** Everything about a map beyond its spots (R-332, R-333) — warehouse_core::LayoutShape. */
export interface LayoutShape {
  /** Spots in each row, top row first. Empty = every row is `cols` long. */
  row_lengths: number[];
  row_names: string[];
  doors: Door[];
  /** Short names by cellKey, shown on the map in place of the full name. */
  short_names: Record<string, string>;
  /** Shelves on a pallet floor, by spot key ("row:col"). */
  shelves: Record<string, FloorShelf>;
}

export const emptyShape = (): LayoutShape => ({ row_lengths: [], row_names: [], doors: [], short_names: {}, shelves: {} });

export interface WarehouseLayout {
  id: string;
  name: string;
  kind: "pallets" | "shelving";
  rows: number;
  cols: number;
  cells: LayoutCell[];
  shape: LayoutShape;
  /** Boxes recorded on each place (R-340), set place by place — never saved with the map. */
  stock?: MapStock;
  notes: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface LayoutInput {
  id?: string | null;
  name: string;
  kind: "pallets" | "shelving";
  rows: number;
  cols: number;
  cells: LayoutCell[];
  shape: LayoutShape;
  notes: string;
}

export const FILL_LABELS = ["Empty", "¼ full", "½ full", "¾ full", "Full"];
export const FILL_SHORT = ["Empty", "¼", "½", "¾", "Full"];
export const DOOR_KINDS: Record<Door["kind"], string> = { garage: "Garage door", dock: "Dock door", door: "Door" };
export const SHELF_MAX = 10;

/** A spot's position as the key cells, shelves and selections use. */
export const spotKey = (r: number, c: number) => `${r}:${c}`;

/** What a spot holds, as the key its colour, its short name and the legend group by. */
export const cellKey = (c: Pick<LayoutCell, "item_id" | "section_id" | "label">) =>
  c.section_id ? `s:${c.item_id}:${c.section_id}` : c.label ? `l:${c.label.trim().toLowerCase()}` : "";

/** Pallet spots are named like a spreadsheet (A1 is the top-left); shelves by bay and level, level 1 at the bottom. */
export function spotName(kind: WarehouseLayout["kind"], rows: number, r: number, c: number): string {
  if (kind === "shelving") return `Bay ${c + 1}, level ${rows - r}`;
  return `${colName(r)}${c + 1}`;
}

/** How many spots row `r` holds (R-332: rows can differ). */
export function rowLength(l: Pick<WarehouseLayout, "cols"> & { shape?: LayoutShape }, r: number): number {
  const ls = l.shape?.row_lengths || [];
  return ls.length ? (ls[r] ?? ls[ls.length - 1] ?? l.cols) : l.cols;
}

/** Full, partly full or empty — the three colours a map uses for how full a spot is (R-332). */
export const fillBucket = (fill: number): "full" | "partial" | "empty" => (fill >= 4 ? "full" : fill > 0 ? "partial" : "empty");

/** Totals for a map. A place is a pallet spot (not an aisle, not a shelf) or one level of a
 *  shelf. `used` places say what is on them and are full, partly full or empty (marked, with
 *  nothing on it); `open` places have nothing marked. */
export function layoutSummary(l: Pick<WarehouseLayout, "rows" | "cols" | "cells"> & { shape?: LayoutShape }) {
  const shelves = l.shape?.shelves || {};
  const at = new Map(l.cells.map((c) => [spotKey(c.r, c.c), c]));
  let spots = 0, used = 0, full = 0, partial = 0, nShelves = 0, levels = 0;
  const count = (says: boolean, fill: number) => {
    spots++;
    if (!says) return;
    used++;
    if (fill >= 4) full++; else if (fill > 0) partial++;
  };
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < rowLength(l, r); c++) {
      const sh = shelves[spotKey(r, c)];
      if (sh) {
        nShelves++;
        for (const lv of sh.levels) { levels++; count(!!(lv.section_id || lv.label), lv.fill); }
        continue;
      }
      const cell = at.get(spotKey(r, c));
      if (cell?.aisle) continue;
      count(!!cell && !!(cell.section_id || cell.label), cell?.fill ?? 0);
    }
  }
  return { spots, used, full, partial, empty: used - full - partial, open: spots - used, shelves: nShelves, levels };
}

/**
 * How the map is drawn when it is turned (R-332): `rot` quarter turns clockwise after an
 * optional left-right flip. `ring` 1 adds the walls around a floor as an outer row and column
 * on every side, so a door at r = -1 (the top wall) turns with the floor. `at` gives the drawn
 * row and column of a spot; `back` the spot at a drawn row and column. Nothing is stored.
 */
export function mapView(rows: number, cols: number, ring: 0 | 1, rot: number, flip: boolean) {
  const H = rows + 2 * ring, W = cols + 2 * ring;
  const k = ((Math.trunc(rot) % 4) + 4) % 4;
  const dh = k % 2 ? W : H, dw = k % 2 ? H : W;
  const at = (r: number, c: number): [number, number] => {
    let y = r + ring, x = c + ring, h = H, w = W;
    if (flip) x = W - 1 - x;
    for (let i = 0; i < k; i++) { [y, x] = [x, h - 1 - y]; [h, w] = [w, h]; }
    return [y, x];
  };
  const back = (y: number, x: number): [number, number] => {
    let h = dh, w = dw;
    for (let i = 0; i < k; i++) { [y, x] = [w - 1 - x, y]; [h, w] = [w, h]; }
    if (flip) x = W - 1 - x;
    return [y - ring, x - ring];
  };
  return { dh, dw, turned: k % 2 === 1, at, back };
}

/** The wall a door can go in and how long it is: top and bottom run the width, left and right the rows. */
export const wallLength = (l: Pick<WarehouseLayout, "rows" | "cols">, side: Door["side"]) =>
  (side === "top" || side === "bottom" ? l.cols : l.rows);

/** The wall position a ring spot (r or c just outside the floor) stands for, or null for a corner. */
export function wallAt(l: Pick<WarehouseLayout, "rows" | "cols">, r: number, c: number): { side: Door["side"]; pos: number } | null {
  if (r === -1 && c >= 0 && c < l.cols) return { side: "top", pos: c };
  if (r === l.rows && c >= 0 && c < l.cols) return { side: "bottom", pos: c };
  if (c === -1 && r >= 0 && r < l.rows) return { side: "left", pos: r };
  if (c === l.cols && r >= 0 && r < l.rows) return { side: "right", pos: r };
  return null;
}

/** The ring spots a door covers, first to last. */
export function doorSpots(l: Pick<WarehouseLayout, "rows" | "cols">, d: Door): [number, number][] {
  const out: [number, number][] = [];
  for (let i = d.at; i < d.at + d.width; i++) {
    if (d.side === "top") out.push([-1, i]);
    else if (d.side === "bottom") out.push([l.rows, i]);
    else if (d.side === "left") out.push([i, -1]);
    else out.push([i, l.cols]);
  }
  return out;
}

/** Where a door is, in words that do not change when the map is turned. */
export function doorWhere(l: Pick<WarehouseLayout, "rows" | "cols">, d: Door): string {
  const span = (a: number, b: number, f: (n: number) => string) => (a === b ? f(a) : `${f(a)}–${f(b)}`);
  if (d.side === "top" || d.side === "bottom") {
    const wall = d.side === "top" ? "Row A wall" : `Row ${colName(l.rows - 1)} wall`;
    return `${wall}, ${d.width === 1 ? "spot" : "spots"} ${span(d.at + 1, d.at + d.width, String)}`;
  }
  const wall = d.side === "left" ? "Spot 1 end" : "Far end";
  return `${wall}, ${d.width === 1 ? "row" : "rows"} ${span(d.at, d.at + d.width - 1, colName)}`;
}

/** Take row `r` out of a map: the rows below move up one, with their spots, shelves, titles and
 *  the doors along the side walls. The last row cannot go. */
export function removeRow<T extends Pick<LayoutInput, "rows" | "cols" | "cells" | "shape">>(l: T, r: number): T {
  if (l.rows <= 1 || r < 0 || r >= l.rows) return l;
  const move = (row: number) => (row > r ? row - 1 : row);
  const cells = l.cells.filter((c) => c.r !== r).map((c) => ({ ...c, r: move(c.r) }));
  const shelves: Record<string, FloorShelf> = {};
  for (const [k, sh] of Object.entries(l.shape.shelves)) {
    const [sr, sc] = k.split(":").map(Number);
    if (sr !== r) shelves[spotKey(move(sr), sc)] = sh;
  }
  const doors = l.shape.doors.flatMap((d) => {
    if (d.side === "top" || d.side === "bottom") return [d];
    const end = d.at + d.width; // exclusive
    if (r >= end) return [d];
    if (r < d.at) return [{ ...d, at: d.at - 1 }];
    return d.width > 1 ? [{ ...d, width: d.width - 1 }] : [];
  });
  const cut = <X,>(xs: X[]) => xs.filter((_, i) => i !== r);
  return {
    ...l,
    rows: l.rows - 1,
    cells,
    shape: { ...l.shape, row_lengths: cut(l.shape.row_lengths), row_names: cut(l.shape.row_names), doors, shelves },
  };
}

// ---------- Boxes on each pallet (R-339, R-340) ----------
// A place is a pallet spot ("r:c") or a shelf level ("r:c:L", 0 = bottom) marked with a team.
// Its recorded boxes go down on their own when stock leaves: the server and the desktop take
// them off with warehouse_core::take_from_places; this is the same rule, to show the plan.

/** The boxes recorded on one place, and whose they are. No boxes = counted and empty. */
export interface PlaceStock { item_id: string; section_id: string; boxes: Record<string, number> }
export type MapStock = Record<string, PlaceStock>;

export const placeKey = (r: number, c: number, level?: number) => (level == null ? `${r}:${c}` : `${r}:${c}:${level}`);

/** The places on a map holding a team, in reading order — warehouse_core::map_places. */
export function mapPlaces(l: Pick<WarehouseLayout, "cells" | "shape">): { key: string; r: number; c: number; level: number | null; item_id: string; section_id: string; fill: number }[] {
  const shelves = l.shape?.shelves || {};
  const out: { order: [number, number, number]; key: string; r: number; c: number; level: number | null; item_id: string; section_id: string; fill: number }[] = [];
  for (const c of l.cells) {
    if (!c.aisle && c.section_id && !shelves[spotKey(c.r, c.c)]) out.push({ order: [c.r, c.c, 0], key: placeKey(c.r, c.c), r: c.r, c: c.c, level: null, item_id: c.item_id, section_id: c.section_id, fill: c.fill });
  }
  for (const [k, sh] of Object.entries(shelves)) {
    const [r, c] = k.split(":").map(Number);
    sh.levels.forEach((lv, i) => {
      if (lv.section_id) out.push({ order: [r, c, i + 1], key: placeKey(r, c, i), r, c, level: i, item_id: lv.item_id, section_id: lv.section_id, fill: lv.fill });
    });
  }
  out.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
  return out.map((x) => ({ key: x.key, r: x.r, c: x.c, level: x.level, item_id: x.item_id, section_id: x.section_id, fill: x.fill }));
}

/** A place in words: "Floor A2", "Floor B7 level 3". */
export function placeName(l: Pick<WarehouseLayout, "name" | "kind" | "rows">, p: { r: number; c: number; level: number | null }): string {
  return `${l.name} ${spotName(l.kind, l.rows, p.r, p.c)}${p.level == null ? "" : ` level ${p.level + 1}`}`;
}

/** How full a place looks: a place counted to no boxes is empty, whatever was marked. */
export function effectiveFill(fill: number, stock: PlaceStock | undefined): number {
  return stock && Object.values(stock.boxes).every((n) => !(n > 0)) ? 0 : fill;
}

export interface PlaceTake { layout_id: string; place: string; name: string; boxes: Record<string, number> }

/**
 * Which places a team's boxes come off — warehouse_core::take_from_places: for each box type,
 * the places holding it, fewest first, then map order (maps oldest first). `take` is positive
 * counts by box type. Boxes no place records are left out (they come off nowhere).
 */
export function takeFromPlaces(layouts: WarehouseLayout[], item_id: string, section_id: string, take: Record<string, number>): PlaceTake[] {
  const maps = layouts.filter((l) => !l.archived).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: PlaceTake[] = [];
  for (const tid of Object.keys(take).sort()) {
    let need = take[tid];
    if (!(need > 0)) continue;
    const cands: { have: number; mi: number; pi: number; l: WarehouseLayout; p: ReturnType<typeof mapPlaces>[number] }[] = [];
    maps.forEach((l, mi) => mapPlaces(l).forEach((p, pi) => {
      if (p.item_id !== item_id || p.section_id !== section_id) return;
      const ps = l.stock?.[p.key];
      const have = ps && ps.item_id === item_id && ps.section_id === section_id ? ps.boxes[tid] || 0 : 0;
      if (have > 0) cands.push({ have, mi, pi, l, p });
    }));
    cands.sort((a, b) => a.have - b.have || a.mi - b.mi || a.pi - b.pi);
    for (const x of cands) {
      if (need <= 0) break;
      const n = Math.min(x.have, need);
      need -= n;
      const hit = out.find((o) => o.layout_id === x.l.id && o.place === x.p.key);
      if (hit) hit.boxes[tid] = n;
      else out.push({ layout_id: x.l.id, place: x.p.key, name: placeName(x.l, x.p), boxes: { [tid]: n } });
    }
  }
  return out;
}

/** Every place on the live maps holding a team, part-full first — "where it is", when no boxes are recorded. */
export function placesHolding(layouts: WarehouseLayout[], item_id: string, section_id: string) {
  const out: { layout_id: string; place: string; name: string; fill: number; boxes: Record<string, number> | null }[] = [];
  for (const l of layouts.filter((x) => !x.archived).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    for (const p of mapPlaces(l)) {
      if (p.item_id !== item_id || p.section_id !== section_id) continue;
      const ps = l.stock?.[p.key];
      const counted = ps && ps.item_id === item_id && ps.section_id === section_id ? ps.boxes : null;
      out.push({ layout_id: l.id, place: p.key, name: placeName(l, p), fill: effectiveFill(p.fill, counted ? ps : undefined), boxes: counted });
    }
  }
  // Part-full places first (they empty out), then full, then empty ones last.
  const rank = (f: number) => (f > 0 && f < 4 ? 0 : f >= 4 ? 1 : 2);
  return out.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.fill) - rank(b.x.fill) || a.i - b.i).map(({ x }) => x);
}

/** Boxes of a team recorded across every live map, by box type. */
export function boxesOnMaps(layouts: WarehouseLayout[], item_id: string, section_id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of placesHolding(layouts, item_id, section_id)) for (const [t, n] of Object.entries(p.boxes || {})) out[t] = (out[t] || 0) + n;
  return out;
}

/** What a planned pick takes off a team's places: whole boxes plus boxes opened for loose units. */
export function boxesLeaving(plan: Pick<PickPlan, "take" | "opened">, section_id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, n] of Object.entries(plan.take[section_id] || {})) out[t] = (out[t] || 0) + n;
  for (const [t, n] of Object.entries(plan.opened[section_id] || {})) out[t] = (out[t] || 0) + n;
  return out;
}

/** The units on a place, from its boxes. */
export const unitsOn = (stock: PlaceStock, types: BoxType[]) =>
  Object.entries(stock.boxes).reduce((a, [t, n]) => a + n * perOf(types, t), 0);

/** A place's exact fullness from its boxes (R-344): units on it over the product's pallet size
 *  (units_per_pallet — 21 of the biggest box unless set, R-345, filled in where products are
 *  read). Null when it cannot be worked out — no boxes recorded, or no pallet size. */
export function palletFill(stock: PlaceStock | undefined, item: Pick<WarehouseItem, "box_types" | "units_per_pallet"> | undefined): number | null {
  if (!stock || !item || !(item.units_per_pallet > 0)) return null;
  return unitsOn(stock, item.box_types) / item.units_per_pallet;
}

/** An exact fullness as the quarters the colours and totals count in: full only at 100%. */
export const fillQuarter = (pct: number) => (pct >= 1 ? 4 : pct > 0 ? Math.max(1, Math.min(3, Math.round(pct * 4))) : 0);

/** What a counted place shows (R-345): its exact fullness and the units on it. */
export interface Counted { pct?: number; units?: number }
/** A shown spot: its fill as the map draws it, and its exact fullness and units when its boxes give them. */
export type ShownCell = LayoutCell & Counted;
export type ShownLevel = ShelfLevel & Counted;
export type ShownShape = Omit<LayoutShape, "shelves"> & { shelves: Record<string, { levels: ShownLevel[]; note: string }> };

/**
 * A map as it looks. A counted place's fullness comes from its boxes (R-344) — pallet spots and
 * shelf levels alike (R-345: a level is measured against a pallet too) — with its units beside
 * it; any place counted down to no boxes shows empty; everything else shows the fill marked by hand.
 */
export function countedFills(cells: LayoutCell[], shape: LayoutShape, stock: MapStock | undefined, items: Pick<WarehouseItem, "id" | "box_types" | "units_per_pallet">[] = []): { cells: ShownCell[]; shape: ShownShape } {
  if (!stock || !Object.keys(stock).length) return { cells, shape };
  const counted = <T extends { item_id: string; fill: number }>(x: T, ps: PlaceStock | undefined): T & Counted => {
    const it = items.find((i) => i.id === x.item_id);
    const pct = palletFill(ps, it);
    return pct === null || !ps || !it ? { ...x, fill: effectiveFill(x.fill, ps) } : { ...x, fill: fillQuarter(pct), pct, units: unitsOn(ps, it.box_types) };
  };
  const match = (key: string, x: { item_id: string; section_id: string }) => {
    const ps = stock[key];
    return ps && ps.item_id === x.item_id && ps.section_id === x.section_id ? ps : undefined;
  };
  const out: ShownCell[] = cells.map((c) => (!c.section_id || c.aisle ? c : counted(c, match(placeKey(c.r, c.c), c))));
  const shelves: ShownShape["shelves"] = {};
  for (const [k, sh] of Object.entries(shape.shelves)) {
    const [r, c] = k.split(":").map(Number);
    shelves[k] = { ...sh, levels: sh.levels.map((lv, i) => (lv.section_id ? counted(lv, match(placeKey(r, c, i), lv)) : lv)) };
  }
  return { cells: out, shape: { ...shape, shelves } };
}

/** A percentage that never claims more than it is: 99.6% reads 99%, not 100%; a few units read "<1%". */
const pctOf = (pct: number) => (pct > 0 && pct < 0.005 ? "<1%" : `${pct < 1 ? Math.min(99, Math.round(pct * 100)) : Math.round(pct * 100)}%`);
/** "86%", or "Full" at 100%, "Full · 105%" over it. */
export const pctLabel = (pct: number) => (pct >= 1 ? (pct > 1.005 ? `Full · ${pctOf(pct)}` : "Full") : pctOf(pct));
/** The short form on a spot: "86%", "Full", or "105%" over a pallet. */
export const pctShort = (pct: number) => (pct >= 1 && pct <= 1.005 ? "Full" : pctOf(pct));

// ---------- Building a lot (R-342) ----------
// A planned load, as the pallets Jack builds: every big box (the product's biggest size)
// grouped on pallets of his number (21), then the smaller boxes together on their own pallets
// of about the same hats — each box tied to the pallet it comes off. He ticks each grab as he
// pulls it: that takes those boxes off that pallet and the shelf at once (a put-back unticks).

/** One grab: some boxes of one size of one team, off one place (or off no counted pallet). */
export interface GrabLine {
  id: string;
  pallet: number;
  section_id: string;
  name: string;
  type_id: string;
  type_name: string;
  per_box: number;
  boxes: number;
  place: { layout_id: string; place: string; name: string } | null;
}
/** Loose units a load needs from a team, out of an open box (or by opening one). */
export interface LooseGrab { id: string; section_id: string; name: string; units: number }
export interface BuiltPallet { n: number; big: boolean; boxes: number; units: number; lines: GrabLine[] }
export interface LotBuild {
  totals: { type_id: string; name: string; per_box: number; boxes: number }[];
  pallets: BuiltPallet[];
  loose: LooseGrab[];
  units: number;
}

/** The product's biggest box size — what a pallet's capacity is counted in. */
export const bigBox = (types: BoxType[]) => [...types].filter((t) => t.per_box > 0).sort((a, b) => b.per_box - a.per_box)[0];

/**
 * Split a plan into the pallets to build. `perPallet` is how many big boxes fit on one; the
 * smaller boxes share their own pallets up to the same number of units. 0 or less keeps it one
 * list (pallet 1). Sources come from takeFromPlaces, so they match what the grab takes off.
 */
export function buildLot(item: Pick<WarehouseItem, "id" | "box_types" | "sections">, layouts: WarehouseLayout[], plan: Pick<PickPlan, "take" | "loose">, perPallet: number): LotBuild {
  const big = bigBox(item.box_types);
  const per = (tid: string) => item.box_types.find((t) => t.id === tid);
  type Chunk = Omit<GrabLine, "id" | "pallet">;
  const chunks: Chunk[] = [];
  const sections = item.sections.filter((s) => Object.values(plan.take[s.id] || {}).some((n) => n > 0));
  for (const s of sections) {
    const take = plan.take[s.id] || {};
    for (const [tid, want] of Object.entries(take)) {
      const t = per(tid);
      if (!t || !(want > 0)) continue;
      // One size at a time, so its places come fewest first (the order they are taken in).
      const from = takeFromPlaces(layouts, item.id, s.id, { [tid]: want });
      let left = want;
      for (const f of from) {
        const n = f.boxes[tid] || 0;
        if (n <= 0) continue;
        chunks.push({ section_id: s.id, name: s.name, type_id: tid, type_name: t.name, per_box: t.per_box, boxes: n, place: { layout_id: f.layout_id, place: f.place, name: f.name } });
        left -= n;
      }
      if (left > 0) chunks.push({ section_id: s.id, name: s.name, type_id: tid, type_name: t.name, per_box: t.per_box, boxes: left, place: null });
    }
  }
  const teamBig = (sid: string) => chunks.filter((c) => c.section_id === sid && big && c.type_id === big.id).reduce((a, c) => a + c.boxes, 0);
  const order = (a: Chunk, b: Chunk) => b.per_box - a.per_box || teamBig(b.section_id) - teamBig(a.section_id) || a.name.localeCompare(b.name);
  const bigs = chunks.filter((c) => big && c.type_id === big.id).sort(order);
  const smalls = chunks.filter((c) => !big || c.type_id !== big.id).sort(order);
  const pallets: BuiltPallet[] = [];
  let n = 0;
  const fill = (list: Chunk[], isBig: boolean, cap: number, size: (c: Chunk) => number) => {
    let cur: BuiltPallet | null = null;
    for (const c of list) {
      let left = c.boxes;
      while (left > 0) {
        if (!cur || (cap > 0 && cur[isBig ? "boxes" : "units"] + size(c) > cap)) {
          n += 1;
          cur = { n, big: isBig, boxes: 0, units: 0, lines: [] };
          pallets.push(cur);
        }
        const room = cap > 0 ? Math.max(1, Math.floor((cap - (isBig ? cur.boxes : cur.units)) / size(c))) : left;
        const k = Math.min(left, room);
        cur.lines.push({ ...c, boxes: k, id: `${cur.n}-${cur.lines.length}`, pallet: cur.n });
        cur.boxes += k;
        cur.units += k * c.per_box;
        left -= k;
      }
    }
  };
  if (perPallet > 0) {
    fill(bigs, true, perPallet, () => 1);
    fill(smalls, false, perPallet * (big ? big.per_box : 0), (c) => c.per_box);
  } else {
    fill([...bigs, ...smalls], true, 0, () => 1);
  }
  const totals = item.box_types
    .map((t) => ({ type_id: t.id, name: t.name, per_box: t.per_box, boxes: chunks.filter((c) => c.type_id === t.id).reduce((a, c) => a + c.boxes, 0) }))
    .filter((t) => t.boxes > 0)
    .sort((a, b) => b.per_box - a.per_box);
  const loose: LooseGrab[] = item.sections.filter((s) => (plan.loose[s.id] || 0) > 0).map((s) => ({ id: `L-${s.id}`, section_id: s.id, name: s.name, units: plan.loose[s.id] }));
  const units = chunks.reduce((a, c) => a + c.boxes * c.per_box, 0) + loose.reduce((a, l) => a + l.units, 0);
  return { totals, pallets, loose, units };
}

/** A build in progress, kept on this device while Jack builds: the grabs as planned (frozen, so
 *  taking stock does not reshuffle them) and the move each tick made. */
export interface BuildState {
  item_id: string;
  started_at: string;
  per_pallet: number;
  build: LotBuild;
  /** grab or loose id -> the warehouse move that took it (for a put-back). */
  done: Record<string, string>;
}
export const buildKey = (itemId: string) => `warehouse_build:${itemId}`;

/** What a build has taken so far, per team — the invoice's lines. */
export function builtUnits(state: Pick<BuildState, "build" | "done">): { section_id: string; name: string; boxes: Record<string, number>; loose: number; units: number }[] {
  const out = new Map<string, { section_id: string; name: string; boxes: Record<string, number>; loose: number; units: number }>();
  const get = (sid: string, name: string) => out.get(sid) || (out.set(sid, { section_id: sid, name, boxes: {}, loose: 0, units: 0 }), out.get(sid)!);
  for (const p of state.build.pallets) for (const l of p.lines) {
    if (!state.done[l.id]) continue;
    const e = get(l.section_id, l.name);
    e.boxes[l.type_id] = (e.boxes[l.type_id] || 0) + l.boxes;
    e.units += l.boxes * l.per_box;
  }
  for (const l of state.build.loose) {
    if (!state.done[l.id]) continue;
    const e = get(l.section_id, l.name);
    e.loose += l.units;
    e.units += l.units;
  }
  return [...out.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
}

// ---------- Checking the counts against the pallets (R-343) ----------
// The master count (a team's boxes by size) against the boxes recorded on its pallets and
// shelf levels. Once they agree, every pick takes boxes off both, so they stay agreed.

export interface CountCheckTeam {
  section_id: string;
  name: string;
  /** By size: the master count, the pallets' count, pallets minus master. */
  sizes: { type_id: string; type_name: string; stock: number; onMaps: number; diff: number }[];
  /** Places marked with the team and no boxes entered — their boxes are not counted yet. */
  uncounted: string[];
  /** Places marked with the team (counted or not). */
  places: number;
  matches: boolean;
}

export function countCheck(item: Pick<WarehouseItem, "id" | "box_types" | "sections">, layouts: WarehouseLayout[]) {
  const teams: CountCheckTeam[] = item.sections.map((s) => {
    const places = placesHolding(layouts, item.id, s.id);
    const on = boxesOnMaps(layouts, item.id, s.id);
    const sizes = item.box_types
      .map((t) => ({ type_id: t.id, type_name: t.name, stock: s.counts[t.id] || 0, onMaps: on[t.id] || 0, diff: (on[t.id] || 0) - (s.counts[t.id] || 0) }))
      .filter((x) => x.stock > 0 || x.onMaps > 0);
    const uncounted = places.filter((p) => p.boxes === null).map((p) => p.name);
    return { section_id: s.id, name: s.name, sizes, uncounted, places: places.length, matches: sizes.every((x) => x.diff === 0) && !uncounted.length };
  });
  const off = teams.filter((t) => !t.matches);
  return {
    teams,
    off,
    boxesOff: teams.reduce((a, t) => a + t.sizes.reduce((b, x) => b + Math.abs(x.diff), 0), 0),
    /** Teams whose master can simply be set to their pallets: on the map, every place counted. */
    matchable: off.filter((t) => t.places > 0 && !t.uncounted.length && t.sizes.some((x) => x.diff !== 0)),
  };
}

/** The sections with the given teams' box counts set to what their pallets hold (loose units kept). */
export function matchToPallets(item: Pick<WarehouseItem, "id" | "box_types" | "sections">, layouts: WarehouseLayout[], sectionIds: string[]): WhSection[] {
  const want = new Set(sectionIds);
  return item.sections.map((s) => {
    if (!want.has(s.id)) return s;
    const on = boxesOnMaps(layouts, item.id, s.id);
    const counts: Record<string, number> = {};
    for (const t of item.box_types) if ((on[t.id] || 0) > 0) counts[t.id] = on[t.id];
    return { ...s, counts };
  });
}
