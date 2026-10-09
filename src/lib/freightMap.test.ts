import { describe, expect, it } from "vitest";
import type { FreightMapLoad } from "./api";
import {
  DEFAULT_MAP_RANGE, canViewFreightMap, dayAtStep, dayLabel, decodePolyline, durationText, groupLanes, headline, laneName, laneNote,
  laneState, laneSummary, laneWeight, lineStyle, loadLine, loadsOnOrBefore, mapMarkers, mapProblem, markerRadius, milesText,
  parseMapRange, partialPath, pluralLoads, replayDay, replayPlan, replayProgress, roadMiles, sliderDays, sliderReadout, statesOf,
  stepOfDay, stopPoints, subLine, waitingForRouteKey, KEY_REFUSED_OTHER, NOTHING_PICKED, NO_KEY_ADMIN, NO_KEY_OTHER, NO_LOADS,
  SCRIPT_FAILED,
} from "./freightMap";

// Invented loads only: Birchwood and Lantern Bay are not real places, the carriers are made up, the numbers are small.
const RENO = [39.53, -119.81], SPARKS = [39.54, -119.75], DALLAS = [32.78, -96.8], BOISE = [43.62, -116.2], TULSA = [36.15, -95.99];

function load(over: Partial<FreightMapLoad> & { id: string }): FreightMapLoad {
  return {
    load_number: `LD-${over.id}`, day: "2026-10-03", carrier: "Test Freight", from: "Reno, NV", to: "Dallas, TX", lane: "Reno, NV to Dallas, TX",
    stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "delivery", label: "Dallas, TX" }],
    route_state: "ready", route: { polyline: "abc", miles: 1234, minutes: 1110, points: [RENO as [number, number], DALLAS as [number, number]] },
    ...over,
  };
}
const pending = (id: string, over: Partial<FreightMapLoad> = {}) => load({ id, route_state: "pending", route: null, ...over });
const failed = (id: string, over: Partial<FreightMapLoad> = {}) => load({ id, route_state: "failed", route: null, ...over });

describe("range and access", () => {
  it("knows its four ranges and falls back to 90 days", () => {
    expect(parseMapRange("30d")).toBe("30d");
    expect(parseMapRange("year")).toBe("year");
    expect(parseMapRange("all")).toBe("all");
    expect(parseMapRange("7d")).toBe(DEFAULT_MAP_RANGE);
    expect(parseMapRange(null)).toBe("90d");
  });
  it("shows the map to whoever may see addresses", () => {
    expect(canViewFreightMap({ permissions: ["deal_flow:view"] })).toBe(true);
    expect(canViewFreightMap({ permissions: ["logistics:view", "logistics:view_addresses"] })).toBe(true);
    expect(canViewFreightMap({ permissions: ["*"] })).toBe(true);
    expect(canViewFreightMap({ permissions: ["logistics:view", "logistics:view_names"] })).toBe(false);
    expect(canViewFreightMap(null)).toBe(false);
  });
});

describe("lanes", () => {
  it("names a lane from the server's text, else from its two ends", () => {
    expect(laneName(load({ id: "1" }))).toBe("Reno, NV to Dallas, TX");
    expect(laneName(load({ id: "2", lane: "  ", from: "Boise, ID", to: "Tulsa, OK" }))).toBe("Boise, ID to Tulsa, OK");
    expect(laneName(load({ id: "3", lane: "", from: "", to: "" }))).toBe("LD-3");
  });

  it("groups loads on one lane, the busiest lane first, then the newest, then by name", () => {
    const loads = [
      load({ id: "1", day: "2026-10-01" }),
      load({ id: "2", day: "2026-10-05", lane: "Boise, ID to Tulsa, OK" }),
      load({ id: "3", day: "2026-10-03" }),
      load({ id: "4", day: "2026-10-05", lane: "Anchorage, AK to Tulsa, OK" }),
      load({ id: "5", day: "2026-10-02" }),
    ];
    const lanes = groupLanes(loads);
    expect(lanes.map((l) => [l.name, l.count])).toEqual([
      ["Reno, NV to Dallas, TX", 3], ["Anchorage, AK to Tulsa, OK", 1], ["Boise, ID to Tulsa, OK", 1],
    ]);
    // Newest load first inside a lane, and the lane knows its last day.
    expect(lanes[0].loads.map((l) => l.id)).toEqual(["3", "5", "1"]);
    expect(lanes[0].lastDay).toBe("2026-10-03");
  });

  it("breaks a tie on count by the newest delivery", () => {
    const lanes = groupLanes([
      load({ id: "1", day: "2026-09-01", lane: "A, NV to B, TX" }),
      load({ id: "2", day: "2026-10-01", lane: "C, NV to D, TX" }),
    ]);
    expect(lanes.map((l) => l.name)).toEqual(["C, NV to D, TX", "A, NV to B, TX"]);
  });

  it("reads a lane's state: ready wins, then pending, then failed", () => {
    expect(laneState([failed("1"), load({ id: "2" })])).toBe("ready");
    expect(laneState([failed("1"), pending("2")])).toBe("pending");
    expect(laneState([failed("1"), failed("2")])).toBe("failed");
    expect(laneState([load({ id: "1", route_state: "no_key", route: null })])).toBe("no_key");
  });

  it("puts the not-found, finding and waiting notes under a lane with no line, and nothing under one with a line", () => {
    const [bad] = groupLanes([failed("1")]);
    const [wait] = groupLanes([pending("1")]);
    const [nokey] = groupLanes([load({ id: "1", route_state: "no_key", route: null })]);
    const [good] = groupLanes([load({ id: "1" })]);
    expect(laneNote(bad)).toBe("Route not found, check the addresses");
    expect(laneNote(wait)).toBe("Finding the route");
    expect(laneNote(nokey)).toBe("Waiting for the route key");
    expect(laneNote(good)).toBe("");
  });
});

describe("the slider", () => {
  const loads = [load({ id: "1", day: "2026-10-01" }), load({ id: "2", day: "2026-10-03" }), load({ id: "3", day: "2026-10-03" }), load({ id: "4", day: "2026-10-08" })];

  it("shows the loads delivered on or before a day", () => {
    expect(loadsOnOrBefore(loads, "2026-09-30")).toEqual([]);
    expect(loadsOnOrBefore(loads, "2026-10-01").map((l) => l.id)).toEqual(["1"]);
    expect(loadsOnOrBefore(loads, "2026-10-03").map((l) => l.id)).toEqual(["1", "2", "3"]);
    expect(loadsOnOrBefore(loads, "2026-10-08")).toHaveLength(4);
  });

  it("steps every day from the first delivery to today", () => {
    const days = sliderDays(loads, "2026-10-09");
    expect(days[0]).toBe("2026-10-01");
    expect(days[days.length - 1]).toBe("2026-10-09");
    expect(days).toHaveLength(9);
    expect(sliderDays([], "2026-10-09")).toEqual([]);
  });

  it("steps across a month end and a year end", () => {
    expect(sliderDays([load({ id: "1", day: "2026-09-29" })], "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(sliderDays([load({ id: "1", day: "2025-12-30" })], "2026-01-01")).toEqual(["2025-12-30", "2025-12-31", "2026-01-01"]);
  });

  it("reads the end of the slider as everything, and Today", () => {
    const days = sliderDays(loads, "2026-10-09");
    expect(dayAtStep(days, 0)).toBe("2026-10-01");
    expect(dayAtStep(days, 3)).toBe("2026-10-04");
    expect(dayAtStep(days, days.length - 1)).toBeNull();
    expect(stepOfDay(days, null)).toBe(days.length - 1);
    expect(stepOfDay(days, "2026-10-04")).toBe(3);
    expect(sliderReadout(null, "2026-10-09")).toBe("Today");
    expect(sliderReadout("2026-10-04", "2026-10-09")).toBe("Oct 4");
  });
});

describe("counts, miles and states", () => {
  it("adds up the road miles of ready routes only", () => {
    const loads = [load({ id: "1" }), load({ id: "2", route: { polyline: "x", miles: 100.4, minutes: 90, points: [] } }), pending("3"), failed("4")];
    expect(roadMiles(loads)).toBe(1334);
    expect(roadMiles([pending("1")])).toBe(0);
    expect(roadMiles([])).toBe(0);
  });

  it("counts the states on the stop labels, once each", () => {
    const loads = [
      load({ id: "1" }),
      load({ id: "2", stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "pickup", label: "Sparks, NV" }, { kind: "delivery", label: "Boise, ID" }] }),
      load({ id: "3", stops: [{ kind: "pickup", label: "12 Test Way" }, { kind: "delivery", label: "Tulsa, ok" }] }),
    ];
    expect(statesOf(loads)).toEqual(["ID", "NV", "OK", "TX"]);
    expect(statesOf([load({ id: "4", stops: [{ kind: "pickup", label: "Somewhere, XX" }, { kind: "delivery", label: "No comma" }] })])).toEqual([]);
  });

  it("falls back to the two ends when a load has no stops", () => {
    expect(statesOf([load({ id: "1", stops: [], from: "Reno, NV", to: "Dallas, TX" })])).toEqual(["NV", "TX"]);
  });
});

describe("the words", () => {
  it("writes the headline", () => {
    expect(headline(26)).toBe("26 loads delivered");
    expect(headline(1)).toBe("1 load delivered");
    expect(headline(0)).toBe("0 loads delivered");
    expect(pluralLoads(3)).toBe("3 loads");
  });

  it("writes the sub line from states, road miles and the range", () => {
    const loads = [load({ id: "1" }), load({ id: "2", stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "delivery", label: "Boise, ID" }] })];
    expect(subLine(loads, "90d")).toBe("to 3 states, 2,468 road miles, last 90 days");
    expect(subLine(loads, "30d")).toBe("to 3 states, 2,468 road miles, last 30 days");
    expect(subLine(loads, "year")).toBe("to 3 states, 2,468 road miles, this year");
    expect(subLine(loads, "all")).toBe("to 3 states, 2,468 road miles, all time");
  });

  it("says nothing about miles when none is ready, and nothing about states it cannot read", () => {
    expect(subLine([pending("1")], "90d")).toBe("to 2 states, last 90 days");
    expect(subLine([pending("1", { stops: [{ kind: "pickup", label: "12 Test Way" }, { kind: "delivery", label: "9 Test Way" }] })], "90d")).toBe("last 90 days");
    expect(subLine([load({ id: "1", stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "delivery", label: "Sparks, NV" }] })], "90d")).toBe("to 1 state, 1,234 road miles, last 90 days");
  });

  it("writes the days, with a year only when it is not this year", () => {
    expect(dayLabel("2026-10-03")).toBe("Oct 3");
    expect(dayLabel("2026-10-03", "2026-10-09")).toBe("Oct 3");
    expect(dayLabel("2025-12-31", "2026-10-09")).toBe("Dec 31, 2025");
  });

  it("writes drive time to the nearest hour, a half hour rounding down", () => {
    expect(durationText(1110)).toBe("about 18 hours");
    expect(durationText(1111)).toBe("about 19 hours");
    expect(durationText(60)).toBe("about 1 hour");
    expect(durationText(45)).toBe("about 45 minutes");
    expect(durationText(0)).toBe("");
  });

  it("writes miles", () => {
    expect(milesText(1234)).toBe("1,234 road miles");
    expect(milesText(1)).toBe("1 road mile");
  });

  it("writes the lane summary and a line for each load", () => {
    const lane = groupLanes([load({ id: "1042", load_number: "LD-1042", carrier: "Swift" }), load({ id: "2", day: "2026-09-20" }), load({ id: "3", day: "2026-09-21" })])[0];
    expect(laneSummary(lane, "2026-10-09")).toBe("3 loads, last delivered Oct 3");
    expect(loadLine(lane.loads[0], "2026-10-09")).toBe("LD-1042, Oct 3, Swift, 1,234 road miles, about 18 hours");
  });

  it("leaves out the miles and hours of a load with no route, and an empty carrier", () => {
    expect(loadLine(pending("7", { load_number: "LD-7", carrier: "" }))).toBe("LD-7, Oct 3");
    expect(loadLine(failed("8", { load_number: "LD-8", carrier: "Test Freight" }))).toBe("LD-8, Oct 3, Test Freight");
  });
});

describe("what stands in for the map", () => {
  const base = { waitingForKey: false, keyProblem: "", loadCount: 3, admin: true, scriptFailed: false };
  const nokey = (id: string) => load({ id, route_state: "no_key", route: null });

  it("is nothing when all is well", () => {
    expect(mapProblem(base)).toBeNull();
  });

  it("knows the company is waiting for a route key when a load is, and the server did not say the key was refused", () => {
    expect(waitingForRouteKey([nokey("1"), load({ id: "2" })], "")).toBe(true);
    expect(waitingForRouteKey([load({ id: "1" }), pending("2"), failed("3")], "")).toBe(false);
    expect(waitingForRouteKey([nokey("1")], "OpenRouteService refused the route key. Check it in Settings.")).toBe(false);
    expect(waitingForRouteKey([], "")).toBe(false);
  });

  it("asks an admin for the free key over the map, and everyone else to ask an admin, without hiding the map", () => {
    expect(mapProblem({ ...base, waitingForKey: true })).toEqual({ text: NO_KEY_ADMIN, blocks: false, onMap: true });
    expect(mapProblem({ ...base, waitingForKey: true, admin: false })).toEqual({ text: NO_KEY_OTHER, blocks: false, onMap: true });
  });

  it("says so when nothing was delivered in the range, and when the map would not load", () => {
    expect(mapProblem({ ...base, loadCount: 0 })).toEqual({ text: NO_LOADS, blocks: true, onMap: false });
    expect(mapProblem({ ...base, scriptFailed: true })).toEqual({ text: SCRIPT_FAILED, blocks: true, onMap: false });
    // Nothing delivered beats a missing key: there are no routes to wait for.
    expect(mapProblem({ ...base, loadCount: 0, waitingForKey: true })?.text).toBe(NO_LOADS);
    // And it beats a failed map library: a range with nothing to draw needs no map (the website says the same).
    expect(mapProblem({ ...base, loadCount: 0, scriptFailed: true })).toEqual({ text: NO_LOADS, blocks: true, onMap: false });
  });

  it("shows an admin the server's refusal as given in a banner and still draws the map", () => {
    const said = "OpenRouteService refused the route key. Check it in Settings.";
    expect(mapProblem({ ...base, keyProblem: said })).toEqual({ text: said, blocks: false, onMap: false });
    expect(mapProblem({ ...base, keyProblem: said, admin: false })?.text).toBe(KEY_REFUSED_OTHER);
  });

  it("has the copy Jack approved", () => {
    expect(NOTHING_PICKED).toBe("Tap a line or a lane to see its loads.");
    expect(NO_KEY_ADMIN).toBe("Add your free OpenRouteService key in Settings to draw the road routes.");
    expect(NO_KEY_OTHER).toBe("Ask an admin to add the route key.");
    expect(KEY_REFUSED_OTHER).toBe("Ask an admin to check the route key.");
    expect(NO_LOADS).toBe("No loads delivered in this range.");
    expect(SCRIPT_FAILED).toBe("The map could not load. Check your connection.");
  });

  it("uses no em dash in anything it shows", () => {
    for (const s of [NOTHING_PICKED, NO_KEY_ADMIN, NO_KEY_OTHER, KEY_REFUSED_OTHER, NO_LOADS, SCRIPT_FAILED, laneNote({ state: "no_key" })]) {
      expect(s).not.toContain("\u2014");
    }
  });
});

describe("line weight and selection", () => {
  it("is 3 for one load, 1.5 more for each other, and never more than 9", () => {
    expect(laneWeight(1)).toBe(3);
    expect(laneWeight(2)).toBe(4.5);
    expect(laneWeight(3)).toBe(6);
    expect(laneWeight(5)).toBe(9);
    expect(laneWeight(40)).toBe(9);
    expect(laneWeight(0)).toBe(3);
  });
  it("thickens the picked lane by 2 at full opacity and fades the rest", () => {
    expect(lineStyle(3, "A", null)).toEqual({ weight: 6, opacity: 0.85 });
    expect(lineStyle(3, "A", "A")).toEqual({ weight: 8, opacity: 1 });
    expect(lineStyle(3, "B", "A")).toEqual({ weight: 6, opacity: 0.15 });
  });
});

describe("markers", () => {
  it("reads a ready load's stops off its points, the last stop being the delivery", () => {
    const l = load({
      id: "1",
      stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "pickup", label: "Sparks, NV" }, { kind: "delivery", label: "Dallas, TX" }],
      route: { polyline: "x", miles: 10, minutes: 10, points: [RENO as [number, number], SPARKS as [number, number], DALLAS as [number, number]] },
    });
    expect(stopPoints(l).map((p) => [p.kind, p.label, p.lat])).toEqual([["pickup", "Reno, NV", 39.53], ["pickup", "Sparks, NV", 39.54], ["delivery", "Dallas, TX", 32.78]]);
    expect(stopPoints(pending("2"))).toEqual([]);
  });

  it("keeps the delivery on the last point when a load has more stops than points", () => {
    const l = load({
      id: "1",
      stops: [{ kind: "pickup", label: "A, NV" }, { kind: "pickup", label: "B, NV" }, { kind: "pickup", label: "C, NV" }, { kind: "delivery", label: "Dallas, TX" }],
      route: { polyline: "x", miles: 10, minutes: 10, points: [RENO as [number, number], SPARKS as [number, number], DALLAS as [number, number]] },
    });
    expect(stopPoints(l).map((p) => p.label)).toEqual(["A, NV", "B, NV", "Dallas, TX"]);
  });

  it("shares one marker between loads that stop at one city, and counts them", () => {
    const loads = [
      load({ id: "1" }),
      load({ id: "2" }),
      load({ id: "3", lane: "Boise, ID to Dallas, TX", stops: [{ kind: "pickup", label: "Boise, ID" }, { kind: "delivery", label: "Dallas, TX" }],
        route: { polyline: "x", miles: 5, minutes: 5, points: [BOISE as [number, number], DALLAS as [number, number]] } }),
      pending("4"),
    ];
    const ms = mapMarkers(loads);
    const dallas = ms.find((m) => m.kind === "delivery" && m.label === "Dallas, TX")!;
    expect(dallas.count).toBe(3);
    expect(dallas.laneKeys).toEqual(["Reno, NV to Dallas, TX", "Boise, ID to Dallas, TX"]);
    expect(ms.find((m) => m.kind === "pickup" && m.label === "Reno, NV")!.count).toBe(2);
    expect(ms).toHaveLength(3);
    expect(markerRadius(dallas)).toBeGreaterThan(markerRadius({ kind: "delivery", count: 1 }));
    expect(markerRadius({ kind: "delivery", count: 1 })).toBeGreaterThan(markerRadius({ kind: "pickup", count: 1 }));
    expect(markerRadius({ kind: "delivery", count: 99 })).toBeLessThanOrEqual(11);
  });

  it("counts a city once for a load that passes it twice", () => {
    const l = load({
      id: "1",
      stops: [{ kind: "pickup", label: "Reno, NV" }, { kind: "pickup", label: "Reno, NV" }, { kind: "delivery", label: "Tulsa, OK" }],
      route: { polyline: "x", miles: 10, minutes: 10, points: [RENO as [number, number], RENO as [number, number], TULSA as [number, number]] },
    });
    expect(mapMarkers([l]).find((m) => m.label === "Reno, NV")!.count).toBe(1);
  });
});

describe("replay", () => {
  const loads = [
    load({ id: "late", day: "2026-10-08" }), load({ id: "early", day: "2026-10-01" }), pending("wait", { day: "2026-10-04" }),
    load({ id: "mid", day: "2026-10-04" }), failed("bad", { day: "2026-10-05" }),
  ];

  it("plays the ready routes in date order and skips the rest", () => {
    expect(replayPlan(loads).map((s) => s.id)).toEqual(["early", "mid", "late"]);
  });

  it("runs about eight seconds, the first at once and the last ending on the total", () => {
    const plan = replayPlan(loads);
    expect(plan[0].startMs).toBe(0);
    expect(plan[plan.length - 1].endMs).toBe(8000);
    for (const s of plan) expect(s.endMs - s.startMs).toBe(800);
    expect(plan[1].startMs).toBe(3600);
  });

  it("plays one load over its own 0.8 seconds, and nothing for nothing", () => {
    expect(replayPlan([load({ id: "1" })])).toEqual([{ id: "1", day: "2026-10-03", startMs: 0, endMs: 800 }]);
    expect(replayPlan([pending("1")])).toEqual([]);
  });

  it("grows a route from nothing to whole", () => {
    const s = { startMs: 1000, endMs: 1800 };
    expect(replayProgress(s, 0)).toBe(0);
    expect(replayProgress(s, 1000)).toBe(0);
    expect(replayProgress(s, 1400)).toBeCloseTo(0.5);
    expect(replayProgress(s, 1800)).toBe(1);
    expect(replayProgress(s, 9000)).toBe(1);
  });

  it("moves the slider to the day of the latest route that has started", () => {
    const plan = replayPlan(loads);
    expect(replayDay(plan, 0)).toBe("2026-10-01");
    expect(replayDay(plan, 3599)).toBe("2026-10-01");
    expect(replayDay(plan, 3600)).toBe("2026-10-04");
    expect(replayDay(plan, 8000)).toBe("2026-10-08");
    expect(replayDay([], 100)).toBeNull();
  });
});

/** The encoder, so a round trip proves the decoder at both precisions. */
function encodePolyline(points: [number, number][], precision = 5): string {
  const f = 10 ** precision;
  let out = "", pLat = 0, pLng = 0;
  const put = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    out += String.fromCharCode(n + 63);
  };
  for (const [la, lg] of points) {
    const a = Math.round(la * f), b = Math.round(lg * f);
    put(a - pLat); put(b - pLng); pLat = a; pLng = b;
  }
  return out;
}

describe("decoding a polyline", () => {
  it("reads the example string Google documents for its encoding", () => {
    // From Google's polyline algorithm page: three points, the last two with steps larger than one chunk.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 },
    ]);
  });

  it("round-trips road-like points at precision 5 and precision 6", () => {
    const pts: [number, number][] = [[39.52963, -119.8138], [39.54012, -119.75031], [36.15398, -95.99277], [32.77666, -96.79699], [-33.86882, 151.20929]];
    expect(decodePolyline(encodePolyline(pts)).map((p) => [p.lat, p.lng])).toEqual(pts);
    const fine: [number, number][] = [[39.529631, -119.813803], [32.776664, -96.796988]];
    expect(decodePolyline(encodePolyline(fine, 6), 6).map((p) => [p.lat, p.lng])).toEqual(fine);
  });

  it("reads a long route in order", () => {
    const pts: [number, number][] = [];
    for (let k = 0; k <= 200; k++) pts.push([39.5 - k * 0.03, -119.8 + k * 0.11]);
    const back = decodePolyline(encodePolyline(pts));
    expect(back).toHaveLength(201);
    expect(back[200].lat).toBeCloseTo(33.5, 5);
    expect(back[200].lng).toBeCloseTo(-97.8, 5);
  });

  it("gives an empty path for an empty string and stops at the last whole point of a cut one", () => {
    expect(decodePolyline("")).toEqual([]);
    const whole = encodePolyline([[39.5, -119.8], [32.8, -96.8]]);
    expect(decodePolyline(whole.slice(0, -3))).toHaveLength(1);
    expect(decodePolyline(whole.slice(0, 5))).toEqual([]);
  });
});

describe("a path partly drawn", () => {
  // Three points along a line of latitude, the second two thirds of the way along.
  const path = [{ lat: 40, lng: -100 }, { lat: 40, lng: -97 }, { lat: 40, lng: -94 }];
  it("gives the whole path at 1, one point at 0", () => {
    expect(partialPath(path, 1)).toEqual(path);
    expect(partialPath(path, 0)).toEqual([path[0]]);
  });
  it("ends on a point between the two it falls between", () => {
    const half = partialPath(path, 0.5);
    expect(half).toHaveLength(2);
    expect(half[0]).toEqual(path[0]);
    expect(half[1].lat).toBeCloseTo(40, 4);
    expect(half[1].lng).toBeCloseTo(-97, 1);
    const quarter = partialPath(path, 0.25);
    expect(quarter[quarter.length - 1].lng).toBeCloseTo(-98.5, 1);
  });
  it("leaves a path of one point alone", () => {
    expect(partialPath([path[0]], 0.5)).toEqual([path[0]]);
    expect(partialPath([], 0.5)).toEqual([]);
  });
});
