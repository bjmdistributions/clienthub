import { describe, it, expect } from "vitest";
import { hasShipDate, pipelineSplit, waitingOnLogistics, type LaneFacts } from "./dealLane";

// R-481: invented deals. The cases the website's dfPipelineSplit is tested against too.
const deal = (id: string, over: Partial<LaneFacts> = {}): LaneFacts => ({ id, logistics_stage: "", ...over });
// The next thing due to happen: the earlier of the two dates, as the screen works it out.
const nextDate = (f: LaneFacts) => [f.pickup_date, f.expected_delivery_date].filter(Boolean).sort()[0] as string;
const split = (active: LaneFacts[], delivered: string[] = []) => {
  const s = pipelineSplit(active, new Set(delivered), nextDate);
  return { arrived: s.arrived.map((f) => f.id), lane: s.lane.map((f) => f.id), unscheduled: s.unscheduled.map((f) => f.id) };
};

describe("waitingOnLogistics", () => {
  it("is a live load at quoted, requested, booked or picked up", () => {
    for (const stage of ["quoted", "requested", "booked", "picked_up"]) expect(waitingOnLogistics({ logistics_stage: stage })).toBe(true);
  });
  it("is not a load still at quote, a delivered load, or no load at all", () => {
    for (const stage of ["quote", "delivered", "", undefined]) expect(waitingOnLogistics({ logistics_stage: stage })).toBe(false);
  });
  it("reads the live count when the row has one: a quoted load beside one still asked counts", () => {
    // The stage is the least advanced load, so it reads "quote" for this deal; the count sees the priced one.
    expect(waitingOnLogistics({ logistics_stage: "quote", logistics_live_quoted: 1 })).toBe(true);
    expect(waitingOnLogistics({ logistics_stage: "quote", logistics_live_quoted: 0 })).toBe(false);
  });
  it("the count wins over the stage in both directions", () => {
    expect(waitingOnLogistics({ logistics_stage: "booked", logistics_live_quoted: 0 })).toBe(false);
    expect(waitingOnLogistics({ logistics_stage: "", logistics_live_quoted: 2 })).toBe(true);
  });
  it("falls back to the stage for a row without the count", () => {
    expect(waitingOnLogistics({ logistics_stage: "booked", logistics_live_quoted: undefined })).toBe(true);
    expect(waitingOnLogistics({ logistics_stage: "quote" })).toBe(false);
  });
});

describe("hasShipDate", () => {
  it("needs a pickup or delivery date, and a deal that ships direct has none to wait on", () => {
    expect(hasShipDate({ pickup_date: "2026-10-12" })).toBe(true);
    expect(hasShipDate({ expected_delivery_date: "2026-10-14" })).toBe(true);
    expect(hasShipDate({})).toBe(false);
    expect(hasShipDate({ pickup_date: "  ", expected_delivery_date: "" })).toBe(false);
    expect(hasShipDate({ pickup_date: "2026-10-12", ships_direct: true })).toBe(false);
  });
});

describe("pipelineSplit", () => {
  it("a dated deal is in the lane, a deal with no date and no load is not", () => {
    expect(split([deal("dated", { pickup_date: "2026-10-12" }), deal("plain")])).toEqual({ arrived: [], lane: ["dated"], unscheduled: ["plain"] });
  });
  it("a deal with no date but a live load at quoted or later goes to the lane", () => {
    for (const stage of ["quoted", "requested", "booked", "picked_up"]) {
      expect(split([deal("d", { logistics_stage: stage })]).lane).toEqual(["d"]);
    }
  });
  it("a load still at quote, a delivered load and no load stay out of the lane", () => {
    expect(split([deal("q", { logistics_stage: "quote" }), deal("x", { logistics_stage: "delivered" }), deal("n")]))
      .toEqual({ arrived: [], lane: [], unscheduled: ["q", "x", "n"] });
  });
  it("a quoted load beside one still asked goes to the lane, the stage notwithstanding", () => {
    const s = split([deal("two", { logistics_stage: "quote", logistics_live_quoted: 1 }), deal("asked", { logistics_stage: "quote", logistics_live_quoted: 0 })]);
    expect(s).toEqual({ arrived: [], lane: ["two"], unscheduled: ["asked"] });
  });
  it("a delivered deal goes to the delivered list first, whatever else it has", () => {
    const s = split([deal("both", { pickup_date: "2026-10-12", logistics_stage: "booked" }), deal("load", { logistics_stage: "booked" })], ["both"]);
    expect(s).toEqual({ arrived: ["both"], lane: ["load"], unscheduled: [] });
    // A delivered load beside a new quoted one: the deal is in the delivered set, so it lands there, not in the lane.
    expect(split([deal("again", { logistics_stage: "delivered", logistics_live_quoted: 1 })], ["again"]))
      .toEqual({ arrived: ["again"], lane: [], unscheduled: [] });
  });
  it("orders the lane: dated soonest first, then the ones waiting only on Logistics in the order given", () => {
    const s = split([
      deal("loadA", { logistics_stage: "booked" }),
      deal("late", { expected_delivery_date: "2026-10-30" }),
      deal("loadB", { logistics_stage: "quoted" }),
      deal("soon", { pickup_date: "2026-10-12", logistics_stage: "requested" }),
    ]);
    expect(s.lane).toEqual(["soon", "late", "loadA", "loadB"]);
  });
  it("a deal that ships direct is out of the lane for a date but in it for a live load", () => {
    expect(split([deal("direct", { ships_direct: true, pickup_date: "2026-10-12" })]).lane).toEqual([]);
    expect(split([deal("direct", { ships_direct: true, logistics_stage: "booked" })]).lane).toEqual(["direct"]);
  });
  it("keeps the three lists mutually exclusive and loses no deal", () => {
    const active = [
      deal("a", { pickup_date: "2026-10-12" }), deal("b", { logistics_stage: "picked_up" }), deal("c"), deal("d", { logistics_stage: "quote" }),
      deal("e", { logistics_stage: "booked", expected_delivery_date: "2026-10-20" }), deal("f"),
    ];
    const s = split(active, ["f"]);
    const all = [...s.arrived, ...s.lane, ...s.unscheduled];
    expect(all.sort()).toEqual(active.map((x) => x.id).sort());
    expect(new Set(all).size).toBe(active.length);
    expect(s.arrived).toEqual(["f"]);
    expect(s.lane).toEqual(["a", "e", "b"]);
  });
});
