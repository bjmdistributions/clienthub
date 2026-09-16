// R-310. Tags are the SECOND namespace on a lot — brands and styles — and they are
// deliberately not categories.
//
// Jack: "a way to create more specifc category tags as in by brands or specifc styles …
// I may have multiple brands such as nike new balance adidas, but i have no way to tag it
// as that unless i do a variant but variants only work when putting qty and price."
//
// Why not just more categories: a lot's categories are BUYER SEGMENTS. They drive the
// newsletter audience, and the BJM homepage publishes them verbatim as tiles (see the
// vault's "the category grid is inventory, not copy" — one lot tagged `CAPS` put a shouty
// one-lot tile between Electronics and Jewelry). A "Nike" category would blast the wrong
// segment and grow a brand tile on the homepage. Tags live in `details_json.tags`, are
// never written to the `categories` table, and never reach the audience builder.
//
// The phone carries a second copy of the detection vocabulary in clienthub-api/www/app.js
// (it cannot import this file). Change the two together.

/** Collapse whitespace and trim. Tags are compared case-insensitively everywhere else. */
export const normalizeTag = (t: string) => (t || "").trim().replace(/\s+/g, " ");

const norm = (t: string) => normalizeTag(t).toLowerCase();

/** A lot's tags, from `details_json.tags`. Never falls back to a category — the two lists
 *  are separate on purpose, and a category that leaked in here would reach the storefront
 *  tag facet as though Jack had tagged it. */
export function lotTags(detailsJson: string | null | undefined): string[] {
  try { return dedupeTags((JSON.parse(detailsJson || "{}") || {}).tags); } catch { return []; }
}

/** Trim, collapse, drop blanks, dedupe case-insensitively keeping the first spelling.
 *  Anything that is not a list of strings comes back empty rather than throwing. */
export function dedupeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const v = normalizeTag(String(t ?? ""));
    if (!v || seen.has(norm(v))) continue;
    seen.add(norm(v));
    out.push(v);
  }
  return out;
}

export const isTagged = (tags: string[], t: string) => tags.some((x) => norm(x) === norm(t));

/** Add it if missing, drop it if present — the chip click and the input's Enter share it. */
export function toggleTag(tags: string[], t: string): string[] {
  const v = normalizeTag(t);
  if (!v) return tags;
  return isTagged(tags, v) ? tags.filter((x) => norm(x) !== norm(v)) : [...tags, v];
}

// ── The detection vocabulary ────────────────────────────────────────────────────────────
// Seeded from `src-tauri/src/lot_engine/classify.rs` (LITERAL_BRANDS / SILHOUETTES), which
// classifies manifest lines for the lot engine. The two lists are allowed to drift: that
// one decides what a line IS, this one only offers a chip Jack can click. The vocabulary
// that matters most is the one he builds himself — every tag already on another lot is
// matched first, and wins on spelling.
const BRANDS: { label: string; alts?: string[] }[] = [
  { label: "Nike" }, { label: "Jordan", alts: ["JORDAN", "AIR JORDAN"] }, { label: "adidas" },
  { label: "New Balance" }, { label: "Converse" }, { label: "Vans" }, { label: "Puma" },
  { label: "Reebok" }, { label: "Crocs" }, { label: "ASICS" }, { label: "Brooks" },
  { label: "HOKA", alts: ["HOKA", "HOKA ONE ONE"] }, { label: "Saucony" }, { label: "Skechers" },
  { label: "Timberland" }, { label: "Dr. Martens", alts: ["DR MARTENS", "DR. MARTENS", "DOC MARTENS", "DOCMARTENS"] },
  { label: "Birkenstock" }, { label: "UGG" }, { label: "Columbia" },
  { label: "The North Face", alts: ["NORTH FACE", "THE NORTH FACE"] },
  { label: "Under Armour", alts: ["UNDER ARMOUR", "UNDER ARMORE", "UNDERARMOUR"] },
  { label: "Champion" }, { label: "Levi's", alts: ["LEVIS", "LEVI'S", "LEVI STRAUSS"] },
  { label: "Carhartt" }, { label: "Wrangler" }, { label: "Dickies" }, { label: "Fila" },
  { label: "Sperry" }, { label: "Clarks" }, { label: "Merrell" }, { label: "Salomon" },
  { label: "KEEN" }, { label: "Steve Madden" }, { label: "Michael Kors" }, { label: "Coach" },
  { label: "Ralph Lauren", alts: ["RALPH LAUREN", "POLO RALPH LAUREN"] }, { label: "Tommy Hilfiger" },
  { label: "Calvin Klein" }, { label: "GUESS" }, { label: "Hanes" }, { label: "Fruit of the Loom" },
  { label: "Gildan" }, { label: "Oakley" }, { label: "Ray-Ban", alts: ["RAY BAN", "RAY-BAN", "RAYBAN"] },
  { label: "Lacoste" }, { label: "Kappa" }, { label: "Diadora" }, { label: "Mizuno" },
  { label: "K-Swiss", alts: ["K SWISS", "K-SWISS"] }, { label: "Lugz" }, { label: "Nautica" },
  { label: "Eddie Bauer" }, { label: "Patagonia" }, { label: "Sorel" }, { label: "Cole Haan" },
  { label: "Nine West" }, { label: "Aldo" }, { label: "Josef Seibel" },
];

// A model name is a style tag in its own right AND tells you the brand, so matching one
// offers both chips — "Air Max 90 mixed lot" suggests Air Max and Nike.
const MODELS: { label: string; brand: string; alts?: string[] }[] = [
  { label: "Samba", brand: "adidas" }, { label: "Gazelle", brand: "adidas" },
  { label: "Superstar", brand: "adidas" }, { label: "Stan Smith", brand: "adidas" },
  { label: "Ultraboost", brand: "adidas", alts: ["ULTRABOOST", "ULTRA BOOST"] },
  { label: "Cloudfoam", brand: "adidas" }, { label: "Adilette", brand: "adidas" },
  { label: "Forum Low", brand: "adidas" }, { label: "Campus", brand: "adidas", alts: ["CAMPUS 00"] },
  { label: "Air Max", brand: "Nike" }, { label: "Air Force 1", brand: "Nike" },
  { label: "Blazer Mid", brand: "Nike" }, { label: "Pegasus", brand: "Nike" },
  { label: "Revolution 7", brand: "Nike" }, { label: "Court Vision", brand: "Nike" },
  { label: "Chuck Taylor", brand: "Converse" }, { label: "All Star", brand: "Converse" },
  { label: "Run Star", brand: "Converse" }, { label: "Star Player", brand: "Converse" },
  { label: "Old Skool", brand: "Vans" }, { label: "Sk8-Hi", brand: "Vans", alts: ["SK8-HI", "SK8 HI"] },
  { label: "Classic Clog", brand: "Crocs" }, { label: "Jibbitz", brand: "Crocs" },
  { label: "Crocband", brand: "Crocs" }, { label: "Baya Clog", brand: "Crocs" },
  { label: "Clifton", brand: "HOKA" },
  { label: "9060", brand: "New Balance" }, { label: "2002R", brand: "New Balance" },
  { label: "990v", brand: "New Balance", alts: ["990V"] }, { label: "574", brand: "New Balance" },
  { label: "530", brand: "New Balance" }, { label: "327", brand: "New Balance" },
  { label: "550", brand: "New Balance" },
];

// Styles that are not tied to a brand. Short on purpose — the list Jack builds by tagging
// is the one that gets good, and a long guessy list only produces chips nobody clicks.
const STYLES = [
  "Hoodie", "Joggers", "Leggings", "T-Shirt", "Polo", "Jeans", "Jacket", "Shorts",
  "Sweatpants", "Sweatshirt", "Sneakers", "Slides", "Sandals", "Boots", "Flip Flops",
  "Crew Socks", "No Show Socks", "Ankle Socks", "Sports Bra", "Swimwear", "Backpack",
  "Streetwear", "Athleisure", "Activewear", "Workwear", "Outerwear", "Vintage",
];

// Alias -> compiled matcher. A tag matches on a word boundary, so "Vans" does not fire on
// "ADVANCED" and "574" does not fire on "15748".
const patterns = new Map<string, RegExp>();
function matchAt(up: string, alias: string, plural = false): number {
  const key = plural ? alias + "|s" : alias;
  let re = patterns.get(key);
  if (!re) {
    const body = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // Styles are written both ways in a load message ("hoodie", "hoodies"), so they match
    // an optional plural. Brands and models never do — "Vans" and "Crocs" are already the
    // brand, and a pluralised model number would match half the numbers in a manifest.
    re = new RegExp("(^|[^A-Z0-9])" + body + (plural ? "(S|ES)?" : "") + "([^A-Z0-9]|$)");
    patterns.set(key, re);
  }
  const m = re.exec(up);
  return m ? m.index : -1;
}

/** Brands and styles found in a lot's text, in the order they appear, offered as one-click
 *  chips. `known` is every tag already used on another lot — matched first so Jack's own
 *  spelling wins over the seed list's. */
export function suggestTags(text: string, known: string[] = []): string[] {
  const up = (text || "").toUpperCase();
  if (!up.trim()) return [];
  const hits: { label: string; at: number }[] = [];
  const push = (label: string, at: number) => {
    if (at < 0) return;
    const i = hits.findIndex((h) => norm(h.label) === norm(label));
    if (i < 0) hits.push({ label: normalizeTag(label), at });
    else if (at < hits[i].at) hits[i].at = at;
  };
  for (const k of known) {
    const v = normalizeTag(k);
    if (v) push(v, matchAt(up, v.toUpperCase()));
  }
  for (const m of MODELS) {
    for (const a of m.alts ?? [m.label.toUpperCase()]) {
      const at = matchAt(up, a);
      if (at >= 0) { push(m.label, at); push(m.brand, at); break; }
    }
  }
  for (const b of BRANDS) {
    for (const a of b.alts ?? [b.label.toUpperCase()]) {
      const at = matchAt(up, a);
      if (at >= 0) { push(b.label, at); break; }
    }
  }
  for (const s of STYLES) push(s, matchAt(up, s.toUpperCase(), true));
  return hits.sort((a, b) => a.at - b.at).map((h) => h.label);
}
