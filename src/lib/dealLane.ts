// R-481: which of the three Pipeline lists on Deal Flow an active deal belongs to. Pure, so it is tested without the
// screen. The website has the same rule in www/app.js (dfPipelineSplit), tested against the same cases.
//
// The lists are mutually exclusive, in this order:
//   1. Delivered, ready to complete (the carrier says it landed);
//   2. Waiting on pickup or delivery: a pickup or expected delivery date is set, OR the deal is waiting on Logistics;
//   3. every other active deal.
//
// A deal is waiting on Logistics when it has a live load at quoted, requested, booked or picked_up. The quote is in,
// and the load is being booked or is on the road, even though nobody typed a date on the deal. Not a load still at
// "quote" (the price is not in yet), not delivered (that is list 1), and not a cancelled or archived one. The list's
// `logistics_live_quoted` counts exactly those loads, so a quoted load beside an "Add another truck" copy still asked
// counts. `logistics_stage` (the least advanced of the live loads, which reads "quote" for that deal) stands in only
// for a row that lacks the count.

export const LOGISTICS_WAITING = ["quoted", "requested", "booked", "picked_up"] as const;

/** What the deal list says about a deal's dates and loads. */
export interface LaneFacts {
  id: string;
  ships_direct?: boolean;
  pickup_date?: string | null;
  expected_delivery_date?: string | null;
  logistics_stage?: string;
  logistics_live_quoted?: number;
}

const day = (v?: string | null) => (v || "").trim();

/** A pickup or expected delivery date is set and the deal does not ship direct. */
export const hasShipDate = (f: Pick<LaneFacts, "ships_direct" | "pickup_date" | "expected_delivery_date">): boolean =>
  !f.ships_direct && !!(day(f.expected_delivery_date) || day(f.pickup_date));

/** The deal has a live load at quoted, requested, booked or picked_up: the list's count when it has one (R-481), else
 *  the stage of its least advanced live load. */
export const waitingOnLogistics = (f: Pick<LaneFacts, "logistics_stage" | "logistics_live_quoted">): boolean =>
  Number.isFinite(f.logistics_live_quoted)
    ? (f.logistics_live_quoted as number) > 0
    : (LOGISTICS_WAITING as readonly string[]).includes(f.logistics_stage || "");

/** Splits the active deals into the three lists. In the waiting lane the dated deals run soonest first by `nextDate`
 *  (the next thing due to happen, an ISO day) and the ones waiting only on Logistics follow them, in the order given. */
export function pipelineSplit<T extends LaneFacts>(
  active: readonly T[], delivered: ReadonlySet<string>, nextDate: (f: T) => string,
): { arrived: T[]; lane: T[]; unscheduled: T[] } {
  const arrived = active.filter((f) => delivered.has(f.id));
  const lane = active
    .filter((f) => !delivered.has(f.id) && (hasShipDate(f) || waitingOnLogistics(f)))
    .sort((a, b) => {
      const x = hasShipDate(a) ? nextDate(a) : "", y = hasShipDate(b) ? nextDate(b) : "";
      return x && y ? x.localeCompare(y) : x ? -1 : y ? 1 : 0;
    });
  const laneIds = new Set(lane.map((f) => f.id));
  const unscheduled = active.filter((f) => !delivered.has(f.id) && !laneIds.has(f.id));
  return { arrived, lane, unscheduled };
}
