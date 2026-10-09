import { describe, it, expect } from "vitest";
import { pipelineSplit } from "./dealLane";
import { SECTIONS, type DealCtx, type DealSection, type DealShipFacts, type PayFacts } from "./dealSections";

// R-486: invented deals. The split of the active deals into the six sections, and the order inside each. R-481 had three
// lists here (delivered, waiting on a date or a load, the rest); the same intents are tested against the new sections.
// The website's dfPipelineSections is tested against the same cases.
const TODAY = "2026-10-09";
const paid: PayFacts = { buyerDue: false, supplierDue: false, costMissing: false, supplierKept: false, buyerLeft: null, supplierLeft: null };
const unpaid: PayFacts = { ...paid, buyerDue: true, buyerLeft: 500 };

type Deal = DealShipFacts & { id: string; delivered?: boolean; pay?: PayFacts | null };
const deal = (id: string, over: Partial<Deal> = {}): Deal => ({ id, ...over });
const ctxOf = (f: Deal): DealCtx => ({ delivered: !!f.delivered, today: TODAY, numbers: true, pay: f.pay === undefined ? paid : f.pay });
const split = (active: Deal[]) => {
  const s = pipelineSplit(active, ctxOf);
  return Object.fromEntries(SECTIONS.map(({ key }) => [key, s[key].map((f) => f.id)])) as Record<DealSection, string[]>;
};
const only = (over: Partial<Record<DealSection, string[]>>): Record<DealSection, string[]> =>
  ({ ready: [], paymentMissing: [], onTheWay: [], waitingPickup: [], withLogistics: [], notSetUp: [], ...over });

describe("pipelineSplit", () => {
  it("a dated deal waits on its pickup, a deal with no date and no load is not set up", () => {
    expect(split([deal("dated", { pickup_date: "2026-10-12" }), deal("plain")])).toEqual(only({ waitingPickup: ["dated"], notSetUp: ["plain"] }));
  });
  it("a deal with a live load goes by the load, whether or not it has a date", () => {
    expect(split([
      deal("q", { logistics_stage: "quote" }), deal("qd", { logistics_stage: "quoted" }), deal("r", { logistics_stage: "requested" }),
      deal("b", { logistics_stage: "booked" }), deal("p", { logistics_stage: "picked_up" }),
    ])).toEqual(only({ withLogistics: ["q", "qd"], waitingPickup: ["r", "b"], onTheWay: ["p"] }));
  });
  it("a quoted load beside one still asked goes with Logistics, the stage notwithstanding", () => {
    expect(split([deal("two", { logistics_stage: "quote", logistics_live_count: 2 })])).toEqual(only({ withLogistics: ["two"] }));
  });
  it("a delivered deal is ready, or delivered with payment missing, whatever else it has", () => {
    expect(split([
      deal("both", { delivered: true, pickup_date: "2026-10-12", logistics_stage: "booked" }),
      deal("owes", { delivered: true, pay: unpaid }),
      deal("load", { logistics_stage: "booked" }),
    ])).toEqual(only({ ready: ["both"], paymentMissing: ["owes"], waitingPickup: ["load"] }));
    // A delivered load beside a new quoted one: the deal is in the delivered set, so it lands there, not with Logistics.
    expect(split([deal("again", { delivered: true, logistics_stage: "delivered", logistics_live_count: 2 })])).toEqual(only({ ready: ["again"] }));
  });
  it("a deal that ships direct is done, so it is ready or waiting on payment", () => {
    expect(split([deal("direct", { ships_direct: true, pickup_date: "2026-10-12" }), deal("owes", { ships_direct: true, pay: unpaid })]))
      .toEqual(only({ ready: ["direct"], paymentMissing: ["owes"] }));
  });
  it("orders a section: dated soonest first and a late one at the top, then the ones with no date in the order given", () => {
    const s = split([
      deal("none", { logistics_stage: "requested" }),
      deal("late", { logistics_stage: "booked", logistics_pickup_day: "2026-10-06", expected_delivery_date: "2026-10-30" }),
      deal("ahead", { logistics_stage: "booked", logistics_pickup_day: "2026-10-20" }),
      deal("soon", { logistics_stage: "booked", logistics_pickup_day: "2026-10-12" }),
      deal("dated", { pickup_date: "2026-10-15" }),
    ]);
    expect(s.waitingPickup).toEqual(["late", "soon", "dated", "ahead", "none"]);
  });
  it("orders the deals on the road by the day they are due", () => {
    const s = split([
      deal("b", { logistics_stage: "picked_up", logistics_delivery_day: "2026-10-14" }),
      deal("a", { logistics_stage: "picked_up", logistics_delivery_day: "2026-10-08" }),
      deal("c", { pickup_date: "2026-10-07", expected_delivery_date: "2026-10-11" }),
    ]);
    expect(s.onTheWay).toEqual(["a", "c", "b"]);
  });
  it("keeps the sections mutually exclusive and loses no deal", () => {
    const active = [
      deal("a", { pickup_date: "2026-10-12" }), deal("b", { logistics_stage: "picked_up" }), deal("c"), deal("d", { logistics_stage: "quote" }),
      deal("e", { logistics_stage: "booked", expected_delivery_date: "2026-10-20" }), deal("f", { delivered: true }),
      deal("g", { ships_direct: true, pay: unpaid }), deal("h", { expected_delivery_date: "2026-10-01", pay: null }),
    ];
    const s = split(active);
    const all = Object.values(s).flat();
    expect(all.sort()).toEqual(active.map((x) => x.id).sort());
    expect(new Set(all).size).toBe(active.length);
    expect(s.ready).toEqual(["f"]);
    // h has a date, g ships direct and has none to wait for: the dated one runs first.
    expect(s.paymentMissing).toEqual(["h", "g"]);
  });
  it("returns every section, empty or not", () => {
    expect(Object.keys(pipelineSplit([], ctxOf))).toEqual(SECTIONS.map((s) => s.key));
  });
});
