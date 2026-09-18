// Warehouse stock and the truckload packer (R-326, R-327, R-328).
//
// A product (New Era hats) declares its box sizes once ("Big Box" of 72, "Small Box" of 12).
// Each section (a team) holds whole boxes of each size plus the loose units left in an
// opened box, so a team's units are always sum(count x per_box) + loose.
//
// The packer answers "I'm shipping N pallets" or "I need 500 hats — which boxes do I grab?"
// so that what is LEFT is as even as it can be: each box goes to whichever team has the most
// units left at that moment, and from that team the biggest box that still fits. A team
// holding 40% of the stock is drained first until it is level with the rest, then they all
// come down together. What a whole box cannot make comes loose: out of a box already open,
// else by opening the smallest box that covers it — or, if asked, by one more whole box.
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
 * The balancing pick for `target` units. See the header of this file for the rule; the
 * tests pin it on the shapes it has to get right.
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

  const pool: Cursor[] = left.map((s, i) => ({ s, i })).filter(({ s }) => !skip.has(s.id) && fixed[s.id] == null);
  const bigger = (a: Cursor, b: Cursor) => {
    const ua = sectionUnits(types, a.s), ub = sectionUnits(types, b.s);
    if (ua !== ub) return ua > ub;
    const ba = sectionBoxes(a.s), bb = sectionBoxes(b.s);
    return ba !== bb ? ba > bb : a.i < b.i;
  };

  // Whole boxes: the section with the most units left, its biggest box that still fits.
  for (;;) {
    let best: Cursor | null = null;
    for (const c of pool) {
      if (!sizesIn(types, c.s).some((t) => t.per_box <= rem)) continue;
      if (!best || bigger(c, best)) best = c;
    }
    if (!best) break;
    const t = sizesIn(types, best.s).find((x) => x.per_box <= rem)!;
    best.s.counts[t.id] -= 1;
    add(take, best.s.id, t.id, 1);
    rem -= t.per_box;
  }

  if (rem > 0 && finish === "whole") {
    // One more whole box: the smallest that covers the rest, from the biggest section with one.
    let best: Cursor | null = null;
    for (const c of pool) if (sizesIn(types, c.s).some((t) => t.per_box >= rem) && (!best || bigger(c, best))) best = c;
    if (best) {
      const t = [...sizesIn(types, best.s)].reverse().find((x) => x.per_box >= rem)!;
      best.s.counts[t.id] -= 1;
      add(take, best.s.id, t.id, 1);
      rem -= t.per_box;
    }
  } else if (rem > 0 && finish === "exact") {
    // Boxes already open before opening another.
    while (rem > 0) {
      let best: Cursor | null = null;
      for (const c of pool) if (c.s.loose > 0 && (!best || bigger(c, best))) best = c;
      if (!best) break;
      const x = Math.min(rem, best.s.loose);
      best.s.loose -= x;
      loose[best.s.id] = (loose[best.s.id] || 0) + x;
      rem -= x;
    }
    while (rem > 0) {
      let best: Cursor | null = null;
      for (const c of pool) if (sectionBoxes(c.s) > 0 && (!best || bigger(c, best))) best = c;
      if (!best) break;
      const op: Record<string, number> = {};
      const got = takeLoose(types, best.s, rem, op);
      for (const [t, n] of Object.entries(op)) add(opened, best.s.id, t, n);
      loose[best.s.id] = (loose[best.s.id] || 0) + got;
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

// ---------- The warehouse map (R-330) ----------

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

export interface WarehouseLayout {
  id: string;
  name: string;
  kind: "pallets" | "shelving";
  rows: number;
  cols: number;
  cells: LayoutCell[];
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
  notes: string;
}

export const FILL_LABELS = ["Empty", "¼ full", "½ full", "¾ full", "Full"];

/** What a spot holds, as the key its colour and the legend group by. */
export const cellKey = (c: Pick<LayoutCell, "item_id" | "section_id" | "label">) =>
  c.section_id ? `s:${c.item_id}:${c.section_id}` : c.label ? `l:${c.label.trim().toLowerCase()}` : "";

/** Pallet spots are named like a spreadsheet (A1 is the top-left); shelves by bay and level, level 1 at the bottom. */
export function spotName(kind: WarehouseLayout["kind"], rows: number, r: number, c: number): string {
  if (kind === "shelving") return `Bay ${c + 1}, level ${rows - r}`;
  return `${colName(r)}${c + 1}`;
}

/** Totals for a map: spots that are spots (not aisles), and how full they are. */
export function layoutSummary(l: Pick<WarehouseLayout, "rows" | "cols" | "cells">) {
  const aisles = l.cells.filter((c) => c.aisle).length;
  const spots = l.rows * l.cols - aisles;
  const used = l.cells.filter((c) => !c.aisle && (c.section_id || c.label));
  const full = used.filter((c) => c.fill >= 4).length;
  const partial = used.filter((c) => c.fill > 0 && c.fill < 4).length;
  return { spots, used: used.length, full, partial, empty: spots - full - partial };
}
