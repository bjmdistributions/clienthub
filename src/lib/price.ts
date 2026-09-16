// R-311. One price hierarchy, three surfaces.
//
// Jack: "always always show price per unit as the main price thing, then beneath show moq
// if there is one, and then below that the total price of the entire lot … if there is no
// price per unit, meaning its 1 flat rate, just put that then of course."
//
// So the headline is the PER-UNIT figure whenever one can be known — the lot's own, or the
// band its variants / volume breaks imply — and the whole-load total drops to a supporting
// line beneath the minimum order. A lot that genuinely has no per-unit price (custom free
// text, or a flat ask on a lot with no quantity to divide by) puts THAT figure in the
// headline and names it, rather than printing a per-unit price nobody quoted.
//
// The same three lines are rendered by the Ecliptr storefront (clienthub-api/www/shop.html)
// and the BJM site (Websites/bjmdistributions/components/marketplace). Those are separate
// runtimes and cannot import this file; if the rule changes here, change it there too.
import type { Lot, LotDetails, LotPriceTier } from "./api";
import { fmtAmount } from "./format";

/** A variant's price is ALWAYS per unit; a blank one falls back to the LOT's unit price,
 *  and a `total`-priced lot divides by quantity to get there. Custom-priced lots have no
 *  numeric unit price at all. */
export const lotUnitPrice = (lot: Pick<Lot, "price_type" | "asking_price" | "quantity">) =>
  lot.price_type === "custom" ? 0
    : lot.price_type === "total" && lot.quantity > 0 ? lot.asking_price / lot.quantity
    : lot.asking_price;

/** Volume price breaks (R-247), ascending and per unit. The rows are open-ended by
 *  construction — each runs until the next begins — so the last one is the fixed rate and
 *  needs no upper bound stored. The first row's quantity is the lot's MOQ. */
export const priceTiers = (det: LotDetails): LotPriceTier[] =>
  (det.price_tiers ?? [])
    .filter((t) => t && t.min_qty > 0 && t.price > 0)
    .sort((a, b) => a.min_qty - b.min_qty);

/** The unit-price band the VARIANTS and the volume BREAKS imply. A lot priced only through
 *  its sizes or its ladder has no asking_price of its own, and a headline that divides by
 *  quantity would print $0.00 — the thing custom price text was written to avoid. */
export const impliedPriceBand = (det: LotDetails): { low: number; high: number } | null => {
  const ps = [
    ...(det.variants ?? []).map((v) => v.price),
    ...priceTiers(det).map((t) => t.price),
  ].filter((x): x is number => x != null && x > 0);
  if (ps.length === 0) return null;
  return { low: Math.min(...ps), high: Math.max(...ps) };
};

/** A lot quoted BY THE PALLET: the pallet price, the pallet count, and the per-unit band
 *  that pallet size implies. Fewer units on a pallet makes each unit dearer, so the LOW
 *  per-pallet count gives the HIGH unit price; with no range quoted both ends match. */
export const palletPrice = (det: LotDetails) => {
  if (det.price_basis !== "per_pallet") return null;
  const perPallet = det.price_per_pallet ?? 0;
  const pallets = det.pallets ?? 0;
  if (perPallet <= 0 || pallets <= 0) return null;
  const lo = det.qty_per_pallet ?? 0;
  const hi = det.qty_per_pallet_max ?? 0;
  const unitHigh = lo > 0 ? perPallet / lo : 0;
  const unitLow = hi > lo ? perPallet / hi : unitHigh;
  return { perPallet, pallets, unitLow, unitHigh };
};

export interface LotPriceBlock {
  /** The big, bold figure — "$3.16", "$3.00–$3.33", custom free text, or "No price set". */
  headline: string;
  /** What the headline is per: "per unit", "for the whole lot", or "" for free text. */
  unit: string;
  /** "5,000 unit minimum", or null when the lot has no MOQ. */
  moq: string | null;
  /** "$158,000.00 for the whole lot" — null when the headline already IS the total. */
  total: string | null;
  /** "$1,500.00 per pallet" — only for a lot that was quoted by the pallet. */
  pallet: string | null;
  /** false only for "No price set", so a caller can grey the headline out. */
  priced: boolean;
}

export function lotPriceBlock(lot: Pick<Lot, "price_type" | "asking_price" | "quantity">, det: LotDetails): LotPriceBlock {
  const moqN = det.moq ?? 0;
  const moq = moqN > 0 ? `${moqN.toLocaleString()} unit minimum` : null;
  const pal = palletPrice(det);
  const pallet = pal ? `${fmtAmount(pal.perPallet)} per pallet` : null;

  // Custom-priced lots show what was typed, verbatim. No per-unit, no total — that is the
  // whole point of the mode.
  if (lot.price_type === "custom") {
    const text = (det.price_text || "").trim();
    return { headline: text || "No price set", unit: "", moq, total: null, pallet, priced: !!text };
  }

  const total = lot.price_type === "per_unit" ? lot.asking_price * lot.quantity : lot.asking_price;
  // NOT `lotUnitPrice` — that one falls through to the raw ask so a blank variant price
  // still inherits something, which would headline a flat $9,500 load as "$9,500 per unit".
  // Here a whole-load price with no quantity to divide by has no per-unit price at all,
  // which is precisely the "1 flat rate" case.
  const own = lot.price_type === "per_unit" ? lot.asking_price
    : lot.quantity > 0 ? lot.asking_price / lot.quantity
    : 0;
  const band = impliedPriceBand(det);
  // Resolution order: what the supplier actually quoted (the pallet band) beats the
  // divided-out figure, which beats the band the variants or the ladder imply.
  const low = pal && pal.unitHigh > 0 ? pal.unitLow : own > 0 ? own : band ? band.low : 0;
  const high = pal && pal.unitHigh > 0 ? pal.unitHigh : own > 0 ? own : band ? band.high : 0;

  if (high > 0) {
    return {
      headline: low < high ? `${fmtAmount(low)}–${fmtAmount(high)}` : fmtAmount(high),
      unit: "per unit",
      moq,
      total: total > 0 ? `${fmtAmount(total)} for the whole lot` : null,
      pallet,
      priced: true,
    };
  }
  // One flat rate and nothing to divide it by — show the flat figure and say what it buys.
  if (total > 0) return { headline: fmtAmount(total), unit: "for the whole lot", moq, total: null, pallet, priced: true };
  return { headline: "No price set", unit: "", moq, total: null, pallet, priced: false };
}
