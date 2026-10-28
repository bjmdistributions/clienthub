// R-557. Lots from a spreadsheet.
//
// Jack fills the template (or hands it to Muse), drops the file on Inventory, reviews every
// row and adds them. Each row becomes EXACTLY what the lot form would save for the same
// typing: `quantity` is the total, a per-pallet price is stored multiplied out under
// price_type "total", the minimum order is the first rung of the ladder, and so on. The
// rules are the form's (InventoryView.tsx, LotForm `submit`); where this file repeats one,
// it says so, and a change to either must change both.
//
// The column list is shared with the template writer (src-tauri/src/lot_import.rs) through
// lotImportTemplate.json, so a header the template prints is a header this file reads.
import type { Lot, LotDetails, LotOption, LotPriceTier, LotVariant } from "./api";
import spec from "./lotImportTemplate.json";
import { dedupeTags } from "./tags";
import { formatLocation, parseLocation } from "./location";
import { MAX_EXPIRE_DAYS } from "./lotTimer";

/** One spreadsheet row as the lot form would save it, plus the files that ride along. It is
 *  also the shape the form takes as a prefill, so a row opens in the full form unchanged. */
export interface LotDraft {
  name: string;
  description: string | null;
  category: string | null;
  quantity: number;
  total_cost: number;
  asking_price: number;
  price_type: string;
  notes: string | null;
  supplier: string | null;
  location: string | null;
  details_json: string | null;
  manifest_file: string | null;
  sent_whatsapp: boolean;
  sent_email: boolean;
}

/** A photo as the sheet named it, and the file on this computer it turned into. */
export interface PhotoRef { ref: string; path?: string; error?: string }

export interface Duplicate {
  /** "same": almost certainly a lot you already have, left out unless you tick it.
   *  "maybe": close enough to look at, still added unless you untick it. */
  strength: "same" | "maybe";
  against: "inventory" | "file";
  lotId?: string;
  line?: number;
  name: string;
  status?: string;
  quantity: number;
  asking_price: number;
  price_type: string;
  why: string;
}

export interface ImportRow {
  key: string;
  /** The row number the spreadsheet itself shows, so "row 7" means row 7 in Excel. */
  line: number;
  draft: LotDraft;
  photos: PhotoRef[];
  photosLoading: boolean;
  manifestRef: string | null;
  manifestError: string | null;
  /** Must be fixed before the row can be added. */
  problems: string[];
  /** Read with a guess worth a look; does not stop the row. */
  notes: string[];
  dup: Duplicate | null;
  include: boolean;
  /** Set once the person ticks or unticks the row, so a re-check never overrides them. */
  includeTouched: boolean;
  state: "ready" | "adding" | "added" | "failed";
  error: string | null;
  edited: boolean;
}

export interface ImportContext {
  categories: string[];
  suppliers: string[];
  tags: string[];
}

type Key = string;

const normHeader = (s: string) =>
  (s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const HEADER_KEYS: Map<string, Key> = (() => {
  const m = new Map<string, Key>();
  for (const c of spec.columns as { key: string; header: string; aliases?: string[] }[]) {
    for (const h of [c.header, ...(c.aliases ?? [])]) {
      const n = normHeader(h);
      if (n && !m.has(n)) m.set(n, c.key);
    }
  }
  return m;
})();

export const TEMPLATE_HEADERS: string[] = spec.columns.map((c) => c.header);
const EXAMPLE_NAMES = new Set(spec.examples.map((e) => normName(e.name)));

export interface HeaderMatch {
  index: number;
  col: Record<Key, number>;
  /** Columns in the sheet that match nothing, shown so a renamed column is never silently lost. */
  unknown: string[];
}

/** The header is the first row (of the first 20) that names the Name column. */
export function findHeader(rows: string[][]): HeaderMatch | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const col: Record<Key, number> = {};
    const unknown: string[] = [];
    rows[i].forEach((cell, j) => {
      const n = normHeader(cell);
      if (!n) return;
      const k = HEADER_KEYS.get(n);
      if (k && col[k] === undefined) col[k] = j;
      else unknown.push(cell.trim());
    });
    if (col.name !== undefined) return { index: i, col, unknown };
  }
  return null;
}

// ── Reading one cell ─────────────────────────────────────────────────────────

/** A number as people type one in a sheet: "$12,500.00", "450 units". Empty is null;
 *  anything else that is not a number is "bad", so the row can say which cell. */
export function readNumber(raw: string): number | null | "bad" {
  const s = (raw || "").trim().replace(/^\$|usd$/i, "").replace(/[$,\s]/g, "").replace(/(units?|pcs|ea|each)$/i, "");
  if (!s) return null;
  if (!/^\d*\.?\d+$/.test(s)) return "bad";
  return parseFloat(s);
}

const YES = /^(y|yes|true|1|x|✓|✔)$/i;
const NO = /^(n|no|false|0|-)?$/i;

const squash = (s: string) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

function priceMode(raw: string): "per_unit" | "total" | "per_pallet" | "custom" | null | "bad" {
  const s = squash(raw);
  if (!s) return null;
  if (["perunit", "unit", "each", "ea", "perpiece", "peritem", "unitprice"].includes(s)) return "per_unit";
  if (["fixedtotal", "total", "fixed", "flat", "wholeload", "thewholeload", "load", "lot", "perlot", "perload"].includes(s)) return "total";
  if (["perpallet", "pallet", "palletprice"].includes(s)) return "per_pallet";
  if (["customtext", "custom", "text"].includes(s)) return "custom";
  return "bad";
}

function qtyBasis(raw: string): "total" | "per_pallet" | null | "bad" {
  const s = squash(raw);
  if (!s) return null;
  if (["thewholeload", "wholeload", "total", "load", "lot"].includes(s)) return "total";
  if (["perpallet", "pallet", "eachpallet"].includes(s)) return "per_pallet";
  return "bad";
}

const splitList = (raw: string) => (raw || "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

/** Photo and manifest references: one per line, or separated by ; or |, or by a comma that
 *  starts the next reference. A comma inside a link is left alone. */
export function splitRefs(raw: string): string[] {
  return (raw || "")
    .split(/\r?\n|;|\|/)
    .flatMap((p) => p.split(/,\s*(?=https?:\/\/|[a-z]:[\\/]|[\\/]|[^,]*\.(?:jpe?g|png|webp|gif|pdf|csv|xlsx?)\b)/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Spelling key for matching a typed label to one already in use: "Home and kitchen",
 *  "home & kitchen" and "Home & Kitchens" all find "Home & kitchen". */
const labelKey = (s: string) => (s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "").replace(/s$/, "");

function canonical(typed: string, known: string[]): { value: string; isNew: boolean } {
  const k = labelKey(typed);
  const hit = known.find((x) => labelKey(x) === k);
  return hit ? { value: hit, isNew: false } : { value: typed.trim(), isNew: true };
}

const CONDITIONS = (spec.columns.find((c) => c.key === "condition")?.choices ?? []) as string[];

/** "2000+ at 4.00; 5000+ at 3.50" → ascending rungs. A rung with no price is a minimum only. */
export function parseTiers(raw: string): LotPriceTier[] | "bad" {
  const text = (raw || "").trim();
  if (!text) return [];
  let parts = text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) parts = text.split(/,\s+(?=\d[\d,]*\s*\+)/).map((s) => s.trim()).filter(Boolean);
  const out: LotPriceTier[] = [];
  for (const p of parts) {
    const m = p.match(/^([\d,]+)\s*\+?\s*(?:units?|pcs)?\s*(?:(?:at|@|:|=|-)\s*\$?\s*([\d,]*\.?\d+)\s*(?:\/\s*(?:unit|ea|each))?)?$/i);
    if (!m) return "bad";
    out.push({ min_qty: parseInt(m[1].replace(/,/g, ""), 10), price: m[2] ? parseFloat(m[2].replace(/,/g, "")) : 0 });
  }
  return out.filter((t) => t.min_qty > 0).sort((a, b) => a.min_qty - b.min_qty);
}

/** "Black / M: 600 at 4.75; Navy / M: 500" against options "Color, Size". */
export function parseVariants(optionsRaw: string, raw: string): { options: LotOption[]; variants: LotVariant[] } | string {
  const names = (optionsRaw || "").split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
  const entries = (raw || "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return { options: [], variants: [] };
  if (!names.length) return "Variants need the Variant options column filled in, like Color, Size";
  const variants: LotVariant[] = [];
  for (const e of entries) {
    const m = e.match(/^(.*?)\s*[:=]\s*([\d,]+)?\s*(?:units?|pcs)?\s*(?:(?:at|@)\s*\$?\s*([\d,]*\.?\d+))?\s*$/i);
    if (!m) return `Couldn't read the variant "${e}". Write it like Black / M: 600 at 4.75`;
    const values = m[1].split("/").map((v) => v.trim());
    if (values.length !== names.length || values.some((v) => !v)) {
      return `The variant "${e}" needs ${names.length} value${names.length === 1 ? "" : "s"} (${names.join(" / ")})`;
    }
    variants.push({ values, qty: m[2] ? parseInt(m[2].replace(/,/g, ""), 10) : 0, price: m[3] ? parseFloat(m[3].replace(/,/g, "")) : null });
  }
  // The form keeps option VALUES on the option; here they are whatever the variants use, in
  // the order they first appear.
  const options = names.map((name, i) => ({ name, values: Array.from(new Set(variants.map((v) => v.values[i]))) }));
  return { options, variants };
}

// ── One row ──────────────────────────────────────────────────────────────────

export function parseRow(cells: string[], h: HeaderMatch, line: number, ctx: ImportContext): ImportRow | null {
  const get = (k: Key) => (h.col[k] === undefined ? "" : String(cells[h.col[k]] ?? "").trim());
  if (cells.every((c) => !String(c ?? "").trim())) return null;
  const problems: string[] = [];
  const notes: string[] = [];
  const num = (k: Key, label: string): number => {
    const v = readNumber(get(k));
    if (v === "bad") { problems.push(`${label} is not a number: "${get(k)}"`); return 0; }
    return v ?? 0;
  };
  const yes = (k: Key, label: string): boolean => {
    const v = get(k);
    if (YES.test(v)) return true;
    if (!NO.test(v)) notes.push(`${label} "${v}" was read as No`);
    return false;
  };

  const name = get("name");
  if (!name) problems.push("No name");

  // Categories and tags take the spelling already in use, so an import never splits
  // "Clothing" into a second "clothing" (categories are referenced by label).
  const cats: string[] = [];
  for (const c of splitList(get("categories"))) {
    const { value, isNew } = canonical(c, ctx.categories);
    if (cats.some((x) => labelKey(x) === labelKey(value))) continue;
    cats.push(value);
    if (isNew) notes.push(`New category: ${value}`);
  }
  const tags = dedupeTags(splitList(get("tags")).map((t) => canonical(t, ctx.tags).value));
  const conditionRaw = get("condition");
  const condition = conditionRaw ? canonical(conditionRaw, CONDITIONS).value : "";
  const supplier = get("supplier") ? canonical(get("supplier"), ctx.suppliers).value : "";
  const locRaw = get("location");
  const locParts = parseLocation(locRaw);
  const location = formatLocation(locParts.city, locParts.state);
  if (locRaw && !locParts.state) notes.push(`Location "${locRaw}" has no state`);

  const pallets = Math.round(num("pallets", "Pallets"));
  const qtyTyped = Math.round(num("quantity", "Quantity"));
  const perPalletMax = Math.round(num("qty_per_pallet_max", "Per pallet up to"));
  let basis = qtyBasis(get("qty_basis"));
  if (basis === "bad") { notes.push(`Quantity is "${get("qty_basis")}" was read as The whole load`); basis = "total"; }
  // A range quoted per pallet only makes sense per pallet.
  if (basis === null && perPalletMax > 0) basis = "per_pallet";
  const qtyApprox = yes("qty_approx", "At least this many");
  const costLoad = num("cost", "Your cost");
  const costUnit = num("cost_unit", "Your cost per unit");
  const msrp = num("msrp", "MSRP");

  // Price. A price cell that is words, not a number, is custom text ("Best offer").
  const priceCell = get("price");
  const priceNum = readNumber(priceCell);
  let mode = priceMode(get("price_type"));
  let priceText = get("price_text");
  if (mode === "bad") { problems.push(`Price type "${get("price_type")}" is not one of Per unit, Fixed total, Per pallet, Custom text`); mode = null; }
  if (priceNum === "bad" && mode !== "custom" && mode !== null) problems.push(`Selling price is not a number: "${priceCell}"`);
  if (priceNum === "bad" && (mode === null || mode === "custom") && !priceText) { priceText = priceCell; mode = "custom"; }
  if (mode === null && priceText) mode = "custom";
  const ask = typeof priceNum === "number" ? priceNum : 0;
  if (mode === null) {
    if (ask > 0) notes.push("No price type, so the price was read as per unit");
    mode = "per_unit";
  }
  if (priceText.length > 80) { notes.push("Custom price text was cut to 80 characters"); priceText = priceText.slice(0, 80); }

  const tiersRaw = parseTiers(get("tiers"));
  let tiers: LotPriceTier[] = [];
  if (tiersRaw === "bad") problems.push(`Couldn't read the volume pricing "${get("tiers")}". Write it like 2000+ at 4.00; 5000+ at 3.50`);
  else tiers = tiersRaw;
  const moqTyped = Math.round(num("moq", "Minimum order"));

  const v = parseVariants(get("variant_options"), get("variants"));
  let options: LotOption[] = [];
  let variants: LotVariant[] = [];
  if (typeof v === "string") problems.push(v);
  else { options = v.options; variants = v.variants; }
  if (get("variant_options") && !get("variants")) notes.push("Variant options with no variants were left out");

  // ── From here down: LotForm `submit`, for a new lot. ──
  if (mode === "per_pallet" && ask > 0 && pallets <= 0) problems.push("A per-pallet price needs a pallet count");
  const perPallet = basis === "per_pallet" ? qtyTyped : 0;
  const totalUnits = basis === "per_pallet" ? (pallets > 0 ? perPallet * pallets : perPallet) : qtyTyped;
  if (basis === "per_pallet" && pallets <= 0 && perPallet > 0) notes.push("Quantity per pallet with no pallet count, so it was taken as the whole load");
  const isCustom = mode === "custom";
  const priceTextClean = isCustom ? priceText.trim() : "";
  const perPalletPriced = mode === "per_pallet" && ask > 0 && pallets > 0;
  const storedPriceType = mode === "per_pallet" ? "total" : mode;
  const effAsk = isCustom ? 0 : perPalletPriced ? ask * pallets : ask;
  const cleanOptions = options.filter((o) => o.name && o.values.length > 0);
  const cleanVariants: LotVariant[] = cleanOptions.length > 0
    ? variants.filter((x) => x.qty > 0 || (x.price != null && x.price > 0))
              .map((x) => ({ values: x.values, qty: x.qty || 0, price: x.price != null && x.price > 0 ? x.price : null }))
    : [];
  const hasVariants = cleanOptions.length > 0 && cleanVariants.length > 0;
  const variantQtyTotal = cleanVariants.reduce((s, x) => s + (x.qty || 0), 0);
  const effQty = hasVariants && variantQtyTotal > 0 ? variantQtyTotal : totalUnits;
  if (hasVariants && variantQtyTotal > 0 && qtyTyped > 0 && basis !== "per_pallet" && qtyTyped !== variantQtyTotal) {
    notes.push(`Quantity ${qtyTyped.toLocaleString()} was replaced by the variants' ${variantQtyTotal.toLocaleString()}`);
  }
  if (effQty <= 0 && !isCustom) notes.push("No quantity");
  // `total_cost` is read in the price's own terms everywhere (the card's profit, margin and
  // value): per unit on a per-unit lot, the whole load otherwise. The sheet's Your cost is
  // always the whole load, so a per-unit lot divides it out, as typing it into the form would.
  let cost = 0;
  if (storedPriceType === "per_unit") {
    if (costUnit > 0) cost = costUnit;
    else if (costLoad > 0 && effQty > 0) {
      cost = Math.round((costLoad / effQty) * 10000) / 10000;
      if (costLoad < ask) notes.push(`Your cost ${costLoad.toLocaleString()} is less than one unit's price. If that is the cost of each unit, put it in Your cost per unit`);
    } else if (costLoad > 0) notes.push("Your cost was left out: a per-unit lot needs a quantity to work out the cost of each unit");
  } else {
    cost = costLoad > 0 ? costLoad : costUnit > 0 && effQty > 0 ? Math.round(costUnit * effQty * 100) / 100 : 0;
  }
  if (costLoad > 0 && costUnit > 0 && effQty > 0 && Math.abs(costUnit * effQty - costLoad) > costLoad * 0.01) {
    notes.push(`Your cost and Your cost per unit disagree; ${storedPriceType === "per_unit" ? "the per-unit figure" : "the whole-load figure"} was used`);
  }
  const primaryCat = cats[0] || "";
  // The form's ladder: row 0 is the minimum order, a typed MOQ below the first break is
  // still the minimum, and only priced rungs become breaks.
  const rungs = moqTyped > 0 && (tiers.length === 0 || moqTyped < tiers[0].min_qty)
    ? [{ min_qty: moqTyped, price: 0 }, ...tiers]
    : tiers;
  const moqOut = rungs.length ? rungs[0].min_qty : 0;
  const cleanTiers = rungs.filter((t) => t.price > 0).map((t) => ({ min_qty: t.min_qty, price: t.price }));
  const openToOffers = yes("open_to_offers", "Open to offers");
  // R-559: the form's "Comes off after N days". Whole days, 1 to MAX_EXPIRE_DAYS.
  const expireTyped = num("expire_days", "Off the site after (days)");
  if (expireTyped < 0) problems.push("Off the site after (days) cannot be below 0");
  const expireDays = expireTyped > 0 ? Math.min(Math.ceil(expireTyped), MAX_EXPIRE_DAYS) : 0;
  if (expireTyped > MAX_EXPIRE_DAYS) notes.push(`Off the site after was capped at ${MAX_EXPIRE_DAYS} days`);
  const detailsObj: LotDetails = { pallets: pallets || null, msrp: msrp || null, avg_msrp: null, moq: moqOut || null, size_run: [] };
  if (cleanTiers.length) detailsObj.price_tiers = cleanTiers;
  if (qtyApprox) detailsObj.qty_approx = true;
  if (!hasVariants && basis === "per_pallet" && perPallet > 0) {
    detailsObj.qty_basis = "per_pallet";
    detailsObj.qty_per_pallet = perPallet;
    if (perPalletMax > perPallet) detailsObj.qty_per_pallet_max = perPalletMax;
  }
  // Also kept when the pallet count is missing. That row is refused, so this is never
  // stored as is; it makes the form open in Per pallet, where adding the count fixes it.
  if (mode === "per_pallet" && ask > 0) {
    detailsObj.price_basis = "per_pallet";
    detailsObj.price_per_pallet = ask;
  }
  if (priceTextClean) detailsObj.price_text = priceTextClean;
  if (openToOffers) detailsObj.open_to_offers = true;
  if (expireDays > 0) detailsObj.expire_days = expireDays;
  if (hasVariants) { detailsObj.options = cleanOptions; detailsObj.variants = cleanVariants; }
  if (cats.length) detailsObj.categories = cats;
  if (tags.length) detailsObj.tags = tags;
  if (condition) detailsObj.condition = condition;
  const hasDetails = !!pallets || !!msrp || !!moqOut || cleanTiers.length > 0 || qtyApprox || !!priceTextClean || hasVariants || openToOffers || cats.length > 0 || tags.length > 0 || !!condition || (mode === "per_pallet" && ask > 0) || expireDays > 0;

  const manifestRefs = splitRefs(get("manifest"));
  if (manifestRefs.length > 1) notes.push("Only the first manifest is attached");

  return {
    key: `r${line}-${Math.random().toString(36).slice(2, 8)}`,
    line,
    draft: {
      name,
      description: get("description") || null,
      category: primaryCat || null,
      quantity: effQty,
      total_cost: cost,
      asking_price: effAsk,
      price_type: storedPriceType,
      notes: get("notes") || null,
      supplier: supplier || null,
      location: location || null,
      details_json: hasDetails ? JSON.stringify(detailsObj) : null,
      manifest_file: null,
      sent_whatsapp: yes("sent_whatsapp", "Sent on WhatsApp"),
      sent_email: yes("sent_email", "Emailed"),
    },
    photos: splitRefs(get("photos")).map((ref) => ({ ref })),
    photosLoading: false,
    manifestRef: manifestRefs[0] ?? null,
    manifestError: null,
    problems,
    notes,
    dup: null,
    include: problems.length === 0,
    includeTouched: false,
    state: "ready",
    error: null,
    edited: false,
  };
}

export interface ParsedSheet {
  rows: ImportRow[];
  unknownColumns: string[];
  examplesSkipped: number;
}

/** Every data row under the header. Rows that are the template's own examples are left out. */
export function parseSheet(cells: string[][], ctx: ImportContext): ParsedSheet | string {
  const h = findHeader(cells);
  if (!h) return "There is no Name column. Use the template, or put the lot names under a column called Name.";
  const rows: ImportRow[] = [];
  let examplesSkipped = 0;
  for (let i = h.index + 1; i < cells.length; i++) {
    const nameCell = h.col.name === undefined ? "" : String(cells[i][h.col.name] ?? "");
    if (EXAMPLE_NAMES.has(normName(nameCell))) { examplesSkipped++; continue; }
    const r = parseRow(cells[i], h, i + 1, ctx);
    if (r) rows.push(r);
  }
  return { rows, unknownColumns: h.unknown, examplesSkipped };
}

// ── Duplicates ───────────────────────────────────────────────────────────────

function normName(s: string): string {
  return (s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}
const tokens = (s: string) => new Set(normName(s).split(" ").filter(Boolean).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)));
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  a.forEach((w) => { if (b.has(w)) both++; });
  return both / (a.size + b.size - both);
}

interface Comparable { name: string; quantity: number; asking_price: number; supplier: string | null; location: string | null }

function compare(a: Comparable, at: Set<string>, b: Comparable, bt: Set<string>): { strength: "same" | "maybe"; why: string; score: number } | null {
  const sameName = normName(a.name) === normName(b.name) && !!normName(a.name);
  const sim = sameName ? 1 : similarity(at, bt);
  const matched: string[] = [];
  if (a.quantity > 0 && a.quantity === b.quantity) matched.push("quantity");
  if (a.asking_price > 0 && Math.abs(a.asking_price - b.asking_price) < 0.005) matched.push("price");
  if (a.supplier && b.supplier && labelKey(a.supplier) === labelKey(b.supplier)) matched.push("supplier");
  if (a.location && b.location && a.location === b.location) matched.push("location");
  const close = sim >= 0.75;
  let strength: "same" | "maybe" | null = null;
  if ((sameName && matched.length >= 1) || (close && matched.length >= 2)) strength = "same";
  else if (sameName || close || (sim >= 0.5 && matched.length >= 2)) strength = "maybe";
  if (!strength) return null;
  const said = matched.length
    ? `, same ${matched.length > 1 ? `${matched.slice(0, -1).join(", ")} and ${matched[matched.length - 1]}` : matched[0]}`
    : "";
  return { strength, why: `${sameName ? "Same name" : "Similar name"}${said}`, score: (strength === "same" ? 10 : 0) + sim + matched.length / 10 };
}

/** Mark each row that looks like a lot already in inventory, or like an earlier row in the
 *  same file. A "same" match starts unticked; a "maybe" stays ticked but flagged. A row
 *  the person ticked or unticked keeps their choice. */
export function markDuplicates(rows: ImportRow[], lots: Lot[]): ImportRow[] {
  const live = lots.filter((l) => l.status !== "archived").map((l) => ({ lot: l, t: tokens(l.name) }));
  const seen: { row: ImportRow; t: Set<string> }[] = [];
  return rows.map((row) => {
    if (row.state === "added") return row;
    const a: Comparable = row.draft;
    const at = tokens(a.name);
    let best: { dup: Duplicate; score: number } | null = null;
    for (const { lot, t } of live) {
      const c = compare(a, at, lot, t);
      if (c && (!best || c.score > best.score)) {
        best = { dup: { strength: c.strength, against: "inventory", lotId: lot.id, name: lot.name, status: lot.status, quantity: lot.quantity, asking_price: lot.asking_price, price_type: lot.price_type, why: c.why }, score: c.score };
      }
    }
    for (const { row: other, t } of seen) {
      const c = compare(a, at, other.draft, t);
      if (c && (!best || c.score > best.score + 0.001)) {
        best = { dup: { strength: c.strength, against: "file", line: other.line, name: other.draft.name, quantity: other.draft.quantity, asking_price: other.draft.asking_price, price_type: other.draft.price_type, why: c.why }, score: c.score };
      }
    }
    seen.push({ row, t: at });
    const dup = best?.dup ?? null;
    const include = row.includeTouched ? row.include : row.problems.length === 0 && dup?.strength !== "same";
    return { ...row, dup, include };
  });
}
