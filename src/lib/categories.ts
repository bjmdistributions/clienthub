// The category picker's menu, extracted so it can be tested without rendering the
// Inventory form (see vitest.config.ts — node env, no jsdom).
//
// R-309. The old menu did three things that made picking a category feel broken:
// it hid anything already picked, it capped the list at 8, and it re-filtered on every
// click — so clicking a category made it disappear and took the list with it. The rule
// now is that the menu always shows EVERY category; a picked one keeps its place and
// gains a checkmark, and clicking it again un-picks it.

const norm = (c: string) => c.trim().toLowerCase();

/** Every known category once, sorted, filtered only by what has been typed — plus
 *  whether the typed text is a new category the picker should offer to create.
 *  `picked` values that aren't in `options` (typed in this session) are included. */
export function categoryMenu(
  options: string[],
  picked: string[],
  draft: string,
): { list: string[]; canCreate: boolean } {
  const seen = new Set<string>();
  const all: string[] = [];
  // Picks first, so a hand-typed category that isn't in the org's list still shows.
  for (const raw of [...picked, ...options]) {
    const c = (raw || "").trim();
    if (!c || seen.has(norm(c))) continue;
    seen.add(norm(c));
    all.push(c);
  }
  all.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const q = norm(draft);
  return {
    list: q ? all.filter((c) => norm(c).includes(q)) : all,
    canCreate: !!q && !seen.has(q),
  };
}

/** Is this category already picked? Case-insensitive, so "nike" doesn't sit beside "Nike". */
export const isPicked = (picked: string[], c: string) => picked.some((x) => norm(x) === norm(c));

/** Add it if it's missing, remove it if it's there. The menu's click and the input's
 *  Enter both go through here, so the two can never disagree. */
export function toggleCategory(picked: string[], c: string): string[] {
  const v = c.trim();
  if (!v) return picked;
  return isPicked(picked, v) ? picked.filter((x) => norm(x) !== norm(v)) : [...picked, v];
}

/** A lot's FULL category set — the multi list in `details_json.categories` plus the
 *  legacy primary column, deduped case-insensitively, details first (the order the lot
 *  card and storefront already print). A surface that reads only the column makes a lot
 *  invisible under every category but its first; that is the bug the BJM homepage had
 *  before R-253 and the one the Inventory filter still had. */
export function lotCategories(detailsJson: string | null | undefined, category: string | null | undefined): string[] {
  let multi: unknown = [];
  try { multi = (JSON.parse(detailsJson || "{}") || {}).categories ?? []; } catch { multi = []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(Array.isArray(multi) ? multi : []), ...(category ? [category] : [])]) {
    const c = String(raw ?? "").trim();
    if (!c || seen.has(norm(c))) continue;
    seen.add(norm(c));
    out.push(c);
  }
  return out;
}
