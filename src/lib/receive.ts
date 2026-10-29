// R-568: receiving by scanning. A tag scanned is one unit; its barcode is matched to a style and size
// once (the company's `item_codes`), and a barcode not matched yet still counts, waiting in its box.
// The rules that decide anything are case_core.rs (byte-identical in both repos); this file only keeps
// the open box on the screen and tells a scanner's burst of keys from typing. The phone twin is
// www/app.js whr*.

import type { CaseLine, LoadLine } from "./deliveries";

/** What the company knows a barcode is (case_core::ItemCode). */
export type ItemCode = { id?: string; code: string; brand: string; style: string; color: string; color_name: string; description: string; size: string; how: string; updated_at?: string };
/** A barcode as it lands on this delivery: its line and size, or none (case_core::Resolved). */
export type Resolved = { code: string; line_id: string; size: string; item: ItemCode };

/** case_core::clean_barcode: digits 12 to 14 long are kept as 14 (so a UPC and its EAN agree); a
 *  14-digit code not starting with 0 is a carton's; anything else is kept as scanned. */
export function cleanBarcode(s: string): { code: string } | { error: string } {
  const t = s.trim();
  if (!t) return { error: "That barcode is empty." };
  if (t.length > 48 || !/^[\x21-\x7e]+$/.test(t)) return { error: "That is not a barcode Ecliptr can keep." };
  if (/^\d{12,14}$/.test(t)) {
    if (t.length === 14 && t[0] !== "0") return { error: "That is a carton's barcode, not an item's. Scan the tags inside." };
    return { code: t.padStart(14, "0") };
  }
  return { code: t };
}

/** case_core::show_barcode: a stored 14-digit code as people read it (12 or 13 digits). */
export function showBarcode(code: string): string {
  if (/^\d{14}$/.test(code)) return code.replace(/^0+/, "").padStart(12, "0");
  return code;
}

/** The box on the screen: what is in it so far, and every scan in order so Undo takes the last. */
export type OpenBox = {
  id: string;
  pallet: number;
  /** "loose": scanned straight onto the pallet, no carton. */
  kind: "box" | "loose";
  code: string;
  contents: CaseLine[];
  unmatched: Record<string, number>;
  /** Each scan or photo, newest last: what it added. */
  log: { code: string; line_id?: string; size?: string; n: number }[];
};

export const emptyBox = (id: string, pallet: number, kind: "box" | "loose", code = ""): OpenBox => ({ id, pallet, kind, code, contents: [], unmatched: {}, log: [] });

/** One scan (or `n` of the same) into the box: onto its line and size when the barcode is known on
 *  this delivery, else waiting on a match. */
export function addScan(box: OpenBox, code: string, r: Resolved | undefined, n = 1): OpenBox {
  if (r && r.line_id) {
    const contents = box.contents.map((c) => ({ ...c }));
    const hit = contents.find((c) => c.line_id === r.line_id && c.size === r.size);
    if (hit) hit.pairs += n;
    else contents.push({ line_id: r.line_id, size: r.size, pairs: n });
    return { ...box, contents, log: [...box.log, { code, line_id: r.line_id, size: r.size, n }] };
  }
  return { ...box, unmatched: { ...box.unmatched, [code]: (box.unmatched[code] ?? 0) + n }, log: [...box.log, { code, n }] };
}

/** Take the last scan back out. */
export function undoScan(box: OpenBox): OpenBox {
  const last = box.log[box.log.length - 1];
  if (!last) return box;
  const log = box.log.slice(0, -1);
  if (last.line_id) {
    const contents = box.contents.map((c) => (c.line_id === last.line_id && c.size === last.size ? { ...c, pairs: c.pairs - last.n } : c)).filter((c) => c.pairs > 0);
    return { ...box, contents, log };
  }
  const unmatched = { ...box.unmatched };
  unmatched[last.code] = (unmatched[last.code] ?? 0) - last.n;
  if (unmatched[last.code] <= 0) delete unmatched[last.code];
  return { ...box, unmatched, log };
}

/** Set one line and size to a number (the number pad on a row). */
export function setCount(box: OpenBox, line_id: string, size: string, pairs: number): OpenBox {
  const n = Math.max(0, Math.min(9999, Math.floor(pairs) || 0));
  const rest = box.contents.filter((c) => !(c.line_id === line_id && c.size === size));
  return { ...box, contents: n ? [...rest, { line_id, size, pairs: n }] : rest, log: box.log.filter((x) => !(x.line_id === line_id && x.size === size)) };
}

/** A barcode matched while units of it were waiting in the open box: they move onto its line. */
export function settleMatch(box: OpenBox, r: Resolved): OpenBox {
  const n = box.unmatched[r.code] ?? 0;
  if (!n || !r.line_id) return box;
  const unmatched = { ...box.unmatched };
  delete unmatched[r.code];
  const moved = addScan({ ...box, unmatched, log: [] }, r.code, r, n);
  return { ...moved, log: box.log.map((x) => (x.code === r.code && !x.line_id ? { ...x, line_id: r.line_id, size: r.size } : x)) };
}

export const boxUnits = (b: OpenBox) => b.contents.reduce((a, c) => a + c.pairs, 0) + Object.values(b.unmatched).reduce((a, n) => a + n, 0);
export const waitingUnits = (u: Record<string, number> | undefined) => Object.values(u ?? {}).reduce((a, n) => a + Math.max(0, n), 0);

/** The rows of the open box, newest scan first: a line and size, or a barcode waiting. */
export type BoxRow = { kind: "line"; line_id: string; size: string; n: number } | { kind: "code"; code: string; n: number };
export function boxRows(box: OpenBox): BoxRow[] {
  const order: string[] = [];
  for (let i = box.log.length - 1; i >= 0; i--) {
    const x = box.log[i];
    const k = x.line_id ? `l|${x.line_id}|${x.size}` : `c|${x.code}`;
    if (!order.includes(k)) order.push(k);
  }
  for (const c of box.contents) { const k = `l|${c.line_id}|${c.size}`; if (!order.includes(k)) order.push(k); }
  for (const code of Object.keys(box.unmatched)) { const k = `c|${code}`; if (!order.includes(k)) order.push(k); }
  return order.flatMap((k): BoxRow[] => {
    const [t, a, b] = k.split("|");
    if (t === "l") { const c = box.contents.find((x) => x.line_id === a && x.size === b); return c ? [{ kind: "line" as const, line_id: a, size: b, n: c.pairs }] : []; }
    const n = box.unmatched[a] ?? 0;
    return n ? [{ kind: "code" as const, code: a, n }] : [];
  });
}

/** Words to show a line by: "Harrison Moc, Waxed Chestnut". */
export const lineWords = (l: LoadLine) => [l.description || l.style, l.color_name || l.color].filter(Boolean).join(", ");

/**
 * Tells a scanner from typing. A scanner types its characters a few milliseconds apart and ends with
 * Enter; a person does not. `key` is fed every key; it answers "scan" with the code when a burst of at
 * least `min` characters, each under `gap` ms after the one before, ends with Enter.
 */
export class ScanReader {
  private buf = "";
  private last = 0;
  constructor(private gap = 100, private min = 8) {}
  key(k: string, at: number): { scan: string } | null {
    if (at - this.last > this.gap) this.buf = "";
    this.last = at;
    if (k === "Enter") {
      const b = this.buf;
      this.buf = "";
      return b.length >= this.min ? { scan: b } : null;
    }
    if (k.length === 1) this.buf += k;
    return null;
  }
  /** Characters held so far (a burst under way). */
  get pending() { return this.buf.length; }
}

/** The company prefix a barcode's leading digits share with barcodes already matched, as a suggested brand
 *  (a suggestion only: never matched on it). Six digits is the shortest GS1 prefix in use. */
export function brandHint(code: string, known: Resolved[]): string {
  if (!/^\d{14}$/.test(code)) return "";
  const head = code.slice(0, 8);
  const hit = known.find((r) => r.code.startsWith(head) && r.item.brand);
  return hit ? hit.item.brand : "";
}

/** A short id for a box this device makes (case_core::safe_id allows letters, digits, - and _). */
export const newBoxId = () => `rx-${(crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "")}`;
