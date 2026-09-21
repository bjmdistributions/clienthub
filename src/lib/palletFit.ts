// R-346: the pallet fitter's shapes (src-tauri/src/pallet_fit.rs, the same file on the server) and
// the small helpers the screens use to ask it and show its answer. The fitting itself is never
// done here: one fitter, in Rust, for the desktop and the phone alike.

export interface PalletSpec { length: number; width: number; deck: number; max_height: number }
export interface BoxSize { length: number; width: number; height: number; side_ok: boolean }
/** What a product keeps (warehouse_items.pallet_json): its pallet and each box size's measurements. */
export interface PalletSetup { pallet: PalletSpec; boxes: Record<string, BoxSize> }
export interface FitType { type_id: string; name: string; per_box: number; size: BoxSize }
export interface FitGroup { section_id: string; name: string; type_id: string; boxes: number }
export interface FitRequest { pallet: PalletSpec; types: FitType[]; groups: FitGroup[]; big_alone: boolean }
/** One box: x along the pallet's length, y across its width, z up from the deck; the corner nearest the back-left, on the deck side. */
export interface Placed { type_id: string; section_id: string; x: number; y: number; z: number; l: number; w: number; h: number; layer: number; on_side: boolean }
export interface FitLayer { n: number; type_id: string; z: number; height: number; boxes: number; full: boolean; on_side: boolean }
export interface FitPallet { n: number; boxes: Placed[]; layers: FitLayer[]; load_height: number; total_height: number; units: number; counts: FitGroup[] }
export interface Capacity { type_id: string; per_layer: number; layers: number; top_boxes: number; boxes: number; layer_is_best: boolean; on_side: boolean; total_height: number; pallet: FitPallet }
export interface FitResult { pallets: FitPallet[]; capacity: Capacity[] }

/** A standard pallet, 48 × 40 in on a 6 in deck; the height limit is Jack's to set. */
export const DEFAULT_PALLET: PalletSpec = { length: 48, width: 40, deck: 6, max_height: 0 };
export const emptySetup = (): PalletSetup => ({ pallet: { ...DEFAULT_PALLET }, boxes: {} });

type Item = { box_types: { id: string; name: string; per_box: number }[]; pallet?: PalletSetup | null };

const measured = (b: BoxSize | undefined) => !!b && b.length > 0 && b.width > 0 && b.height > 0;
export const palletReady = (p: PalletSpec | undefined) => !!p && p.length > 0 && p.width > 0 && p.max_height > (p.deck || 0);

/** The box sizes with measurements, as the fitter takes them. */
export function fitTypes(item: Item): FitType[] {
  const boxes = item.pallet?.boxes || {};
  return item.box_types.filter((t) => measured(boxes[t.id])).map((t) => ({ type_id: t.id, name: t.name, per_box: t.per_box, size: boxes[t.id] }));
}

/** Everything a load needs is measured: the pallet, and every size the load holds. */
export function readyFor(item: Item, typeIds: string[]): boolean {
  if (!palletReady(item.pallet?.pallet)) return false;
  const boxes = item.pallet?.boxes || {};
  return typeIds.every((id) => measured(boxes[id]));
}

/** "48", "47.5". */
export const inches = (v: number) => `${Math.round(v * 100) / 100}`;
/** 72 in → "6 ft", 58 in → "4 ft 10 in". */
export function feet(v: number): string {
  const t = Math.round(v * 10) / 10;
  const f = Math.floor(t / 12), i = Math.round((t - f * 12) * 10) / 10;
  return f === 0 ? `${i} in` : i === 0 ? `${f} ft` : `${f} ft ${i} in`;
}

/** What one layer of a built pallet holds, per section: [section_id, boxes] biggest first. */
export function layerSections(p: FitPallet, layer: number): [string, number][] {
  const m = new Map<string, number>();
  for (const b of p.boxes) if (b.layer === layer) m.set(b.section_id, (m.get(b.section_id) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const VULGAR: Record<string, string> = { "½": " 1/2", "¼": " 1/4", "¾": " 3/4", "⅛": " 1/8", "⅜": " 3/8", "⅝": " 5/8", "⅞": " 7/8", "⅓": " 1/3", "⅔": " 2/3" };

/**
 * Inches as a tape measure reads them: "23.5", "23 1/2", "23-1/2", "23½", "1/2", "23 in", `23"`.
 * Anything else is null, never a guess — "23,5" or "23 1/0" is refused, not read as 235 or 23.
 * Rounded to hundredths, the fitter's own precision.
 */
export function parseInches(raw: string): number | null {
  let s = (raw || "").trim().toLowerCase();
  for (const [k, v] of Object.entries(VULGAR)) s = s.split(k).join(v);
  s = s.replace(/(inches|inch|in|")\s*$/, "").trim();
  if (!s) return null;
  // Exactly one of: a decimal, a fraction, or a whole number and a fraction with a space or a dash between.
  const dec = s.match(/^(\d+(?:\.\d+)?|\.\d+)$/);
  const mixed = s.match(/^(\d+)(?:\s+|\s*-\s*)(\d+)\s*\/\s*(\d+)$/);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  const part = (n: string, d: string) => (Number(d) > 0 && Number(n) < Number(d) ? Number(n) / Number(d) : NaN);
  const v = dec ? Number(dec[1]) : mixed ? Number(mixed[1]) + part(mixed[2], mixed[3]) : frac ? part(frac[1], frac[2]) : NaN;
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

// ---- The pallets of an order (R-347, R-348) ----

/** Some boxes of one size of one team on a recorded pallet (names copied in). */
export interface PalletLine { section_id: string; name: string; type_id: string; type_name: string; per_box: number; boxes: number }
/** A recorded pallet's picture: the pallet it was fitted to and every box's place. */
export interface PalletPlan { spec: PalletSpec; pallet: FitPallet }
export interface WarehousePallet {
  id: string; invoice_id: string; invoice_number: string; client_name: string; item_id: string; number: number;
  lines: PalletLine[]; plan: PalletPlan | null; token: string; passcode: string; notes: string; archived: boolean;
  created_at: string; updated_at: string;
}
/** A pallet to add: its lines, "N pallets like this", and (from Build this lot) the fitted picture. */
export interface NewPallet { lines: PalletLine[]; copies?: number; plan?: PalletPlan | null; notes?: string }

/** Where a pallet's QR code points. */
export const manifestUrl = (token: string) => `https://ecliptr.app/p/${token}`;
export const palletBoxes = (p: { lines: PalletLine[] }) => p.lines.reduce((a, l) => a + l.boxes, 0);
export const palletUnits = (p: { lines: PalletLine[] }) => p.lines.reduce((a, l) => a + l.boxes * l.per_box, 0);

/** An order's pallets together, newest order first. */
export function byOrder(ps: WarehousePallet[]): { invoice_id: string; invoice_number: string; client_name: string; item_id: string; pallets: WarehousePallet[]; latest: string }[] {
  const m = new Map<string, { invoice_id: string; invoice_number: string; client_name: string; item_id: string; pallets: WarehousePallet[]; latest: string }>();
  for (const p of ps) {
    const o = m.get(p.invoice_id) || { invoice_id: p.invoice_id, invoice_number: p.invoice_number, client_name: p.client_name, item_id: p.item_id, pallets: [], latest: "" };
    o.pallets.push(p);
    if (p.created_at > o.latest) o.latest = p.created_at;
    m.set(p.invoice_id, o);
  }
  const out = [...m.values()];
  for (const o of out) o.pallets.sort((a, b) => a.number - b.number);
  return out.sort((a, b) => b.latest.localeCompare(a.latest));
}
