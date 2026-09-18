// Warehouse stock and the truckload packer (R-326).
//
// A product (New Era hats) has sections (one per team). Each section is counted in
// whole boxes with a fixed number of units per box, so units are always boxes x per_box.
//
// The packer answers "I'm shipping N pallets — how many boxes of each team do I grab?"
// so that what is LEFT is as even as it can be: every box goes to whichever section has
// the most units left at that moment. A team holding 40% of the stock is drained first
// until it is level with the rest, then all of them come down together, so the last
// pallet on the shelf is never one team.
//
// The phone runs the same rule — `whPlanPick` in clienthub-api www/app.js. Change both
// together; the tests below pin the behaviour.

import type { LineItem } from "./api";

export interface WhSection {
  id: string;
  name: string;
  boxes: number;
  per_box: number;
}

export interface WhMoveLine {
  section_id: string;
  name: string;
  /** Signed: negative went out, positive came in. */
  boxes: number;
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
  sections: WhSection[];
  boxes_per_pallet: number;
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
  sections: WhSection[];
  boxes_per_pallet: number;
  unit_price: number;
  notes: string;
}

export interface WhChange { section_id: string; boxes: number }
export interface WhShort { name: string; wanted: number; taken: number }

export const sectionUnits = (s: WhSection) => s.boxes * s.per_box;

export function itemTotals(item: Pick<WarehouseItem, "sections" | "boxes_per_pallet">) {
  const boxes = item.sections.reduce((a, s) => a + s.boxes, 0);
  const units = item.sections.reduce((a, s) => a + sectionUnits(s), 0);
  const pallets = item.boxes_per_pallet > 0 ? boxes / item.boxes_per_pallet : null;
  return { boxes, units, pallets };
}

/** Share of the product's units each section holds, 0..1. */
export function shares(sections: WhSection[]): Record<string, number> {
  const total = sections.reduce((a, s) => a + sectionUnits(s), 0);
  const out: Record<string, number> = {};
  for (const s of sections) out[s.id] = total > 0 ? sectionUnits(s) / total : 0;
  return out;
}

export interface PickPlan {
  /** Boxes to grab, by section id. Sections not listed get 0. */
  take: Record<string, number>;
  /** Boxes asked for that the included sections could not supply. */
  short: number;
}

/**
 * The balancing pick. Each of `boxes` goes, one at a time, to the included section with
 * the most units left; ties go to the one with more boxes left, then to the one listed
 * first. Balancing on units rather than boxes keeps it right when two teams pack a
 * different number of hats to a box.
 */
export function planPick(sections: WhSection[], boxes: number, skip: ReadonlySet<string> = new Set()): PickPlan {
  const want = Math.max(0, Math.floor(boxes || 0));
  const pool = sections
    .map((s, i) => ({ id: s.id, per: Math.max(0, s.per_box), left: Math.max(0, s.boxes), i }))
    .filter((p) => !skip.has(p.id) && p.left > 0);
  const take: Record<string, number> = {};
  let got = 0;
  while (got < want) {
    let best: (typeof pool)[number] | null = null;
    for (const p of pool) {
      if (p.left <= 0) continue;
      if (!best) { best = p; continue; }
      const u = p.left * p.per, bu = best.left * best.per;
      if (u > bu || (u === bu && (p.left > best.left || (p.left === best.left && p.i < best.i)))) best = p;
    }
    if (!best) break;
    best.left -= 1;
    take[best.id] = (take[best.id] || 0) + 1;
    got += 1;
  }
  return { take, short: want - got };
}

/** "3" when a section spreads evenly over the pallets, "2–3" when it does not. */
export function perPallet(boxes: number, pallets: number): string {
  if (!pallets || pallets < 1 || boxes <= 0) return "";
  const lo = Math.floor(boxes / pallets), hi = Math.ceil(boxes / pallets);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** What each section would hold after the pick. */
export function afterPick(sections: WhSection[], take: Record<string, number>): WhSection[] {
  return sections.map((s) => ({ ...s, boxes: Math.max(0, s.boxes - (take[s.id] || 0)) }));
}

// ---------- Send to invoice ----------

/** Which warehouse section an invoice line came from. */
export interface WhTag { section_id: string; name: string; per_box: number }

export interface InvoicePrefill {
  lines: (LineItem & { wh?: WhTag })[];
  warehouse: { item_id: string; item_name: string };
}

/** localStorage key the packer stashes a prefilled invoice under (read once by Invoices). */
export const INVOICE_PREFILL_KEY = "invoices_prefill";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * One invoice line per section picked, biggest first: quantity in units at the product's
 * price per unit, with the box count in the description so the buyer and the warehouse
 * read the same thing.
 */
export function invoiceLines(item: Pick<WarehouseItem, "name" | "sections" | "unit_price">, take: Record<string, number>): (LineItem & { wh: WhTag })[] {
  return item.sections
    .filter((s) => (take[s.id] || 0) > 0)
    .sort((a, b) => (take[b.id] - take[a.id]) || a.name.localeCompare(b.name))
    .map((s) => {
      const boxes = take[s.id];
      const qty = boxes * s.per_box;
      const rate = item.unit_price || 0;
      return {
        description: `${item.name} — ${s.name}, ${plural(boxes, "box", "boxes")} of ${s.per_box}`,
        qty,
        rate,
        amount: Math.round(qty * rate * 100) / 100,
        wh: { section_id: s.id, name: s.name, per_box: s.per_box },
      };
    });
}

/**
 * The boxes an invoice actually carries, read from its final lines. A line whose quantity
 * was edited takes the nearest whole number of boxes; a deleted line takes nothing.
 */
export function boxesOnInvoice(lines: { qty: number; wh?: WhTag }[]): WhChange[] {
  const by: Record<string, number> = {};
  for (const l of lines) {
    if (!l.wh || !(l.wh.per_box > 0)) continue;
    const b = Math.max(0, Math.round((l.qty || 0) / l.wh.per_box));
    if (b > 0) by[l.wh.section_id] = (by[l.wh.section_id] || 0) + b;
  }
  return Object.entries(by).map(([section_id, b]) => ({ section_id, boxes: -b }));
}

/** Invoice lines as the invoice stores them — the warehouse tag stays in the form. */
export const plainLines = (lines: LineItem[]): LineItem[] =>
  lines.map(({ description, qty, rate, amount }) => ({ description, qty, rate, amount }));

/**
 * Turn a pasted list into sections — one per line, from a spreadsheet or a message:
 * "Yankees<TAB>40<TAB>24", "Yankees, 40, 24", "Yankees - 40 boxes of 24", "Yankees 40x24".
 * The name is everything before the first plain number (so "San Francisco 49ers 12 24"
 * keeps its 49ers), then boxes, then units per box, which falls back to `perBox`.
 * A header line with no numbers is dropped when the lines under it have them.
 */
export function parseSectionList(text: string, perBox = 0): WhSection[] {
  const rows = text.split(/\r?\n/).map((line) => {
    const tokens = line
      .replace(/(\d),(\d{3})(?!\d)/g, "$1$2") // "1,200" is a number, "20, 24" is two
      .replace(/(\d)\s*[x×]\s*(\d)/gi, "$1 $2")
      .split(/[\t,;|]+|\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const isNum = (t: string) => /^\d[\d,]*$/.test(t);
    const first = tokens.findIndex(isNum);
    const nameTokens = first < 0 ? tokens : tokens.slice(0, first);
    const name = nameTokens.join(" ").replace(/[\s:=-]+$/, "").trim();
    const nums = first < 0 ? [] : tokens.slice(first).filter(isNum).map((t) => parseInt(t.replace(/,/g, ""), 10));
    return { name, nums };
  }).filter((r) => r.name);
  const anyNums = rows.some((r) => r.nums.length > 0);
  return rows
    .filter((r, i) => !(i === 0 && anyNums && r.nums.length === 0))
    .map((r) => ({ id: "", name: r.name, boxes: r.nums[0] ?? 0, per_box: r.nums[1] ?? perBox }));
}
