// R-486: which of the six Pipeline sections on Deal Flow an active deal belongs to, and the order inside each. Pure, so it
// is tested without the screen. The rule for one deal is `sectionOf` in dealSections.ts (R-481 had three lists here: the
// delivered ones, the ones with a date or a live load, and the rest). The website has the same split in www/app.js
// (dfPipelineSections), tested against the same cases.
//
// The sections are mutually exclusive and lose no deal. Inside a section the deals run by `nextDay` (the next thing due to
// happen, soonest first, a late one at the top), and the ones with nothing to wait for follow them, in the order given.

import { SECTIONS, nextDay, sectionOf, type DealCtx, type DealSection, type DealShipFacts } from "./dealSections";

export type SectionSplit<T> = Record<DealSection, T[]>;

/** Splits the active deals into the six sections. Every section is returned, empty or not. */
export function pipelineSplit<T extends DealShipFacts>(active: readonly T[], ctxOf: (f: T) => DealCtx): SectionSplit<T> {
  const keyed: Record<DealSection, { f: T; day: string }[]> = Object.fromEntries(SECTIONS.map((s) => [s.key, []])) as never;
  for (const f of active) {
    const ctx = ctxOf(f);
    keyed[sectionOf(f, ctx)].push({ f, day: nextDay(f, ctx.today) });
  }
  const out = {} as SectionSplit<T>;
  for (const { key } of SECTIONS) {
    out[key] = keyed[key]
      .sort((a, b) => (a.day && b.day ? a.day.localeCompare(b.day) : a.day ? -1 : b.day ? 1 : 0))
      .map((e) => e.f);
  }
  return out;
}
