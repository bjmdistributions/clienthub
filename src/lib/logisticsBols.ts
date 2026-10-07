// R-459: the bills of lading we make, and the numbering block in Settings. Everything here takes
// values and returns values, so the rules are tested without a screen: a BOL read from the server
// always has every key, the item totals, what is saved (blank item rows dropped), how a load's
// prefill or a saved record is read, the list line, and the number preview. The phone carries the
// same rules in www/app.js.

import type { BolData, BolItem, BolRow, BolTerms } from "./api";

export const UNIT_TYPES = ["Pallet", "Skid", "Carton", "Crate", "Drum", "Bundle", "Other"] as const;

export const FREIGHT_TERMS: { key: BolTerms; label: string }[] = [
  { key: "prepaid", label: "Prepaid" },
  { key: "collect", label: "Collect" },
  { key: "third_party", label: "Third party" },
];

export const freightTermsKey = (v: unknown): BolTerms =>
  v === "collect" || v === "third_party" ? v : "prepaid";

/** The server answers a BOL's PDF here. The Logistics bridge allows only paths under /api/logistics. */
export const bolPdfPath = (id: string): string => `/api/logistics/bols/${encodeURIComponent(id)}/pdf`;

// ─── reading and building a BOL's data ────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

export const blankBolItem = (): BolItem => ({ units: "", unit_type: "Pallet", pieces: "", description: "", weight_lbs: "", class: "", nmfc: "", hazmat: false });

/** A new BOL: today's date, prepaid, one empty item row. */
export function blankBol(today: string): BolData {
  return {
    ship_date: today, freight_terms: "prepaid",
    shipper: { name: "", address: "", contact: "", phone: "" },
    consignee: { name: "", address: "", contact: "", phone: "" },
    bill_to: { name: "", address: "" },
    carrier: { name: "", scac: "", pro: "", trailer: "", seal: "" },
    refs: { load_number: "", po: "", pickup_number: "", customer_ref: "" },
    items: [blankBolItem()], special_instructions: "", cod_amount: "", declared_value: "",
  };
}

/** Whatever the server sent (or the data string it stored), as a BOL with every key present. Numbers come
 *  back as the text they would be typed as, and a missing key reads as empty. */
export function normalBol(raw: unknown): BolData {
  let r = raw;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = {}; } }
  const o = obj(r);
  const party = (v: unknown) => { const p = obj(v); return { name: str(p.name), address: str(p.address), contact: str(p.contact), phone: str(p.phone) }; };
  const bill = obj(o.bill_to), car = obj(o.carrier), refs = obj(o.refs);
  const items = (Array.isArray(o.items) ? o.items : []).map((it): BolItem => {
    const i = obj(it);
    return {
      units: str(i.units), unit_type: str(i.unit_type) || "Pallet", pieces: str(i.pieces), description: str(i.description),
      weight_lbs: str(i.weight_lbs), class: str(i.class), nmfc: str(i.nmfc), hazmat: bool(i.hazmat),
    };
  });
  return {
    ship_date: str(o.ship_date), freight_terms: freightTermsKey(o.freight_terms),
    shipper: party(o.shipper), consignee: party(o.consignee), bill_to: { name: str(bill.name), address: str(bill.address) },
    carrier: { name: str(car.name), scac: str(car.scac), pro: str(car.pro), trailer: str(car.trailer), seal: str(car.seal) },
    refs: { load_number: str(refs.load_number), po: str(refs.po), pickup_number: str(refs.pickup_number), customer_ref: str(refs.customer_ref) },
    items, special_instructions: str(o.special_instructions), cod_amount: str(o.cod_amount), declared_value: str(o.declared_value),
  };
}

/** One BOL as the editor holds it: the record around the data. The viewer flags say whether the server
 *  blanked names or addresses (absent means nothing was hidden). */
export interface BolRecord {
  id: string; number: string; bookingId: string; loadNumber: string; data: BolData;
  canNames: boolean; canAddresses: boolean; updatedAt: string; createdBy: string;
}

/** Reads `GET /bols/:id` (or the answer to a create or update). The data may sit under `data` or `data_json`,
 *  or the record may be the data itself. */
export function bolRecordOf(raw: unknown): BolRecord {
  const o = obj(raw);
  const inner = o.data ?? o.data_json ?? (o.shipper !== undefined || o.items !== undefined ? o : {});
  return {
    id: str(o.id), number: str(o.number), bookingId: str(o.booking_id), loadNumber: str(o.load_number) || str(obj(obj(inner).refs).load_number),
    data: normalBol(inner), canNames: o.can_see_names !== false, canAddresses: o.can_see_addresses !== false,
    updatedAt: str(o.updated_at), createdBy: str(o.created_by_name),
  };
}

/** Whether an answer carries the BOL's data at all. A save that answers only `{id, number}` must not blank
 *  what the person typed, so the editor keeps its own copy then. */
export function bolHasData(raw: unknown): boolean {
  const o = obj(raw);
  return o.data !== undefined || o.data_json !== undefined || o.shipper !== undefined || o.items !== undefined;
}

/** Reads `GET /bols/prefill`: the data built from a load, with the load it came from. */
export function bolPrefillOf(raw: unknown, bookingId: string): { data: BolData; bookingId: string; loadNumber: string } {
  const r = bolRecordOf(raw);
  return { data: r.data, bookingId: r.bookingId || bookingId, loadNumber: r.loadNumber || r.data.refs.load_number };
}

// ─── totals and what is saved ─────────────────────────────────────────────

const num = (v: string): number => {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Units, pieces and weight over every item row, the three totals the PDF prints. */
export function bolTotals(items: Pick<BolItem, "units" | "pieces" | "weight_lbs">[]): { units: number; pieces: number; weight: number } {
  let units = 0, pieces = 0, weight = 0;
  for (const i of items) { units += num(i.units); pieces += num(i.pieces); weight += num(i.weight_lbs); }
  return { units, pieces, weight: Math.round(weight * 100) / 100 };
}

/** "1,200 lbs", "-" with none. */
export const weightWord = (w: number): string => (w > 0 ? `${w.toLocaleString("en-US", { maximumFractionDigits: 2 })} lbs` : "-");

const itemBlank = (i: BolItem): boolean =>
  !i.units.trim() && !i.pieces.trim() && !i.description.trim() && !i.weight_lbs.trim() && !i.class.trim() && !i.nmfc.trim() && !i.hazmat;

const trimParty = <T extends object>(p: T): T =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v).trim()])) as T;

/** What is saved: text trimmed, item rows with nothing in them left out. Names and addresses are sent as
 *  typed: one the server blanked for this viewer comes back empty and is kept by the server, not erased. */
export function bolForSave(d: BolData): BolData {
  return {
    ...d,
    shipper: trimParty(d.shipper), consignee: trimParty(d.consignee), bill_to: trimParty(d.bill_to),
    carrier: trimParty(d.carrier), refs: trimParty(d.refs),
    items: d.items.filter((i) => !itemBlank(i)).map((i) => ({ ...i, description: i.description.trim(), class: i.class.trim(), nmfc: i.nmfc.trim() })),
    special_instructions: d.special_instructions.trim(), cod_amount: d.cod_amount.trim(), declared_value: d.declared_value.trim(),
  };
}

/** True when the draft differs from what was loaded (item rows with nothing in them do not count). */
export const bolChanged = (a: BolData, b: BolData): boolean => JSON.stringify(bolForSave(a)) !== JSON.stringify(bolForSave(b));

/** A problem to say before saving, or null: a figure that is not a number. A half-filled BOL still saves. */
export function bolProblem(d: BolData): string | null {
  for (const [i, it] of d.items.entries()) {
    for (const [f, what] of [["units", "units"], ["pieces", "pieces"], ["weight_lbs", "weight"]] as const) {
      const t = it[f].trim();
      if (t && !Number.isFinite(Number(t.replace(/[,\s]/g, "")))) return `Item ${i + 1}: the ${what} must be a number.`;
    }
  }
  for (const [f, what] of [["cod_amount", "COD amount"], ["declared_value", "Declared value"]] as const) {
    const t = d[f].trim();
    if (t && !Number.isFinite(Number(t.replace(/[$,\s]/g, "")))) return `${what} must be a number.`;
  }
  return null;
}

// ─── the list ─────────────────────────────────────────────────────────────

/** "Northgate Supply to Lakeside Depot", whichever ends have a name. */
export function bolRouteLine(r: Pick<BolRow, "shipper" | "consignee">): string {
  const a = (r.shipper || "").trim(), b = (r.consignee || "").trim();
  return a && b ? `${a} to ${b}` : a || b;
}

/** Narrow the list by what was typed, over every column the row shows. The server filters too, so this is
 *  for the rows already on screen while the next answer is on its way. */
export function bolMatches(r: BolRow, text: string): boolean {
  const n = text.trim().toLowerCase();
  if (!n) return true;
  return [r.number, r.load_number, r.shipper, r.consignee, r.carrier].some((v) => (v || "").toLowerCase().includes(n));
}

// ─── numbering (Settings) ─────────────────────────────────────────────────

/** "LD-0001": the prefix, then the number padded to four. The server pads the same way. */
export const numberPreview = (prefix: string, next: number, padding = 4): string =>
  `${prefix}${String(Math.max(1, Math.floor(next) || 1)).padStart(padding, "0")}`;

/** A problem with the numbering form, or null. The next number is a whole number of at least 1. */
export function numberingProblem(loadNext: number, bolNext: number): string | null {
  if (!Number.isInteger(loadNext) || loadNext < 1) return "The next load number must be a whole number of at least 1.";
  if (!Number.isInteger(bolNext) || bolNext < 1) return "The next BOL number must be a whole number of at least 1.";
  return null;
}

/** Lowering the next number can hand out one that was already used. Settings asks before it saves that. */
export const lowersCounter = (was: number, now: number): boolean => Number.isFinite(was) && Number.isFinite(now) && now < was;

// ─── opening a BOL from another screen ────────────────────────────────────

/** The stash-then-switch handoffs, like `invoices_open_id`. */
export const OPEN_BOL_KEY = "bols_open_id";
/** A load's page stashes its id here to start a BOL from it. */
export const NEW_BOL_FROM_LOAD_KEY = "bols_new_from_load";
