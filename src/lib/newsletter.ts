// Builds a newsletter body from an editable template + a set of selected lots. The
// per-lot block is `lot_format` with {title} {units} {price_per_unit} {price} {link};
// any LINE whose token(s) resolve empty is dropped, so "price per unit if available" and
// "fixed/custom price only if listed" fall away cleanly. Shared by the inventory
// "Send to newsletter" action and the Settings live preview so they never drift.

import type { NewsletterProductTemplate } from "./api";

/** The already-resolved token values for one lot (the caller computes price/link). */
export interface LotBlockInput {
  title: string;
  units: number;
  pricePerUnit: string; // e.g. "$4.50" or "" if not applicable
  price: string;        // fixed total or custom text, "" if not listed
  link: string;         // storefront URL or "" if the storefront is off
}

function renderBlock(lotFormat: string, tokens: Record<string, string>): string {
  const lines = lotFormat.split("\n").map((line) => {
    const toks = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    // Drop a line that has token(s) which ALL resolved to empty (labels go with them).
    if (toks.length > 0 && toks.every((k) => !(tokens[k] ?? "").trim())) return null;
    return line.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? "");
  });
  return lines.filter((l): l is string => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildLotBlock(lotFormat: string, lot: LotBlockInput): string {
  return renderBlock(lotFormat, {
    title: lot.title,
    units: lot.units > 0 ? lot.units.toLocaleString() : "",
    price_per_unit: lot.pricePerUnit,
    price: lot.price,
    link: lot.link,
  });
}

/** Assemble intro + one block per lot + outro. {first_name} in the intro is left intact
 *  for the server's per-recipient substitution at send time. */
export function buildNewsletterBody(t: NewsletterProductTemplate, lots: LotBlockInput[]): string {
  const blocks = lots.map((l) => buildLotBlock(t.lot_format, l)).filter(Boolean);
  return [t.intro.trim(), blocks.join("\n\n\n"), t.outro.trim()].filter(Boolean).join("\n\n");
}
