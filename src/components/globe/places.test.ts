import { describe, expect, it } from "vitest";
import {
  buildPlaces, canonicalState, clusterPlaces, dueToReorder, followUpState, lensRgb,
  missingReason, regionOf, regionRollup, RECENCY_STEPS, TIER_RGB, type ClientRow,
} from "./places";

const TODAY = "2026-09-29";

function row(p: Partial<ClientRow>): ClientRow {
  return {
    id: p.id ?? "c", name: p.name ?? "Invented Co", company: "", tier: "New", highValue: false,
    profit: 0, revenue: 0, dealsLanded: 0, lastInvoice: null, lastContact: null, cadenceDays: null,
    reliability: "unrated", nextFollowUp: null, category: "", leadStatus: "", city: "", state: "",
    stateCode: "", country: "", region: "", lat: null, lng: null, precision: "city", ...p,
  };
}

describe("canonicalState / regionOf", () => {
  it("reads a US state however it was typed", () => {
    expect(canonicalState("New Jersey")).toBe("NJ");
    expect(canonicalState("nj")).toBe("NJ");
    expect(canonicalState("N.J.")).toBe("NJ");
    expect(canonicalState("Virgina")).toBe("VA");
    expect(canonicalState("")).toBe("");
  });
  it("rolls a client up to its state, or its country abroad", () => {
    expect(regionOf("Newark", "New Jersey", "")).toBe("US-NJ");
    expect(regionOf("Newark", "NJ", "USA")).toBe("US-NJ");
    expect(regionOf("Paris", "", "france")).toBe("France");
    expect(regionOf("Toronto", "ON", "CA")).toBe("Canada");
    expect(regionOf("", "", "")).toBe("");
  });
});

describe("missingReason", () => {
  it("names what the geocoder is missing", () => {
    expect(missingReason({ city: "", state: "", country: "" })).toBe("No address");
    expect(missingReason({ city: "Pittsbrgh", state: "PA", country: "" })).toBe("City not recognized");
    expect(missingReason({ city: "Boise", state: "", country: "" })).toBe("Needs a state");
    expect(missingReason({ city: "", state: "Nowhere", country: "" })).toBe("State not recognized");
    expect(missingReason({ city: "", state: "", country: "USA" })).toBe("Needs a city and state");
    expect(missingReason({ city: "Reykjavik", state: "", country: "Iceland" })).toBe("Country not recognized");
  });
});

describe("buildPlaces / clusterPlaces", () => {
  const newark1 = row({ id: "a", name: "A", lat: 40.7357, lng: -74.1724, city: "Newark", state: "NJ", tier: "B", profit: 100 });
  const newark2 = row({ id: "b", name: "B", lat: 40.7357, lng: -74.1724, city: "Newark", state: "NJ", tier: "P", profit: 900 });
  const edison = row({ id: "c", name: "C", lat: 40.5187, lng: -74.4121, city: "Edison", state: "NJ", tier: "A", profit: 50 });
  const chicago = row({ id: "d", name: "D", lat: 41.8781, lng: -87.6298, city: "Chicago", state: "IL", tier: "C" });
  const unpinned = row({ id: "e", name: "E" });

  it("groups clients at one coordinate into one place, best tier and top profit first", () => {
    const places = buildPlaces([newark1, newark2, edison, chicago, unpinned], TODAY);
    expect(places).toHaveLength(3);
    const newark = places.find((p) => p.label === "Newark, NJ")!;
    expect(newark.count).toBe(2);
    expect(newark.bestTier).toBe("P");
    expect(newark.clients.map((c) => c.id)).toEqual(["b", "a"]);
    expect(newark.profit).toBe(1000);
  });

  it("merges nearby places when zoomed out and keeps them apart when zoomed in", () => {
    const places = buildPlaces([newark1, newark2, edison, chicago], TODAY);
    const far = clusterPlaces(places, TODAY, () => 0.5);   // Newark and Edison are ~0.3° apart
    expect(far).toHaveLength(2);
    const nj = far.find((g) => g.count === 3)!;
    expect(nj.label).toBe("Near Newark, NJ");     // sits on the heaviest place
    expect(nj.placeCount).toBe(2);
    expect(clusterPlaces(places, TODAY, () => 0.05)).toHaveLength(3);
    // Same members, same key: the mark is reused instead of rebuilt.
    expect(clusterPlaces(places, TODAY, () => 0.5).find((g) => g.count === 3)!.key).toBe(nj.key);
  });

  it("gives a bigger badge more room, and never leaves two marks touching", () => {
    // Three places in a row, 1 unit apart. Single dots fit; once two merge, the
    // badge's larger room swallows the third as well.
    const mk = (id: string, lng: number) => row({ id, name: id, lat: 0, lng, city: id });
    const places = buildPlaces([mk("a", 0), mk("a2", 0), mk("b", 1), mk("c", 2), mk("d", 10)], TODAY);
    const flat = (g: { lng: number }, h: { lng: number }) => Math.abs(g.lng - h.lng);
    const room = (n: number) => (n < 2 ? 0.45 : 1.6);
    const out = clusterPlaces(places, TODAY, room, flat);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      expect(flat(out[i], out[j])).toBeGreaterThanOrEqual(room(out[i].count) + room(out[j].count));
    }
    // b and c were each far enough from a single dot, not from the growing badge.
    expect(out.map((g) => g.count).sort()).toEqual([1, 4]);
  });
});

describe("lenses and follow-ups", () => {
  it("colours by tier, recency and follow-up", () => {
    const [g] = buildPlaces([row({ lat: 1, lng: 1, tier: "A", lastInvoice: "2026-09-20", nextFollowUp: "2026-09-28" })], TODAY);
    expect(lensRgb(g, "tier", TODAY, 0)).toBe(TIER_RGB.A);
    expect(lensRgb(g, "recency", TODAY, 0)).toBe(RECENCY_STEPS[0].rgb);
    expect(g.followUp).toBe("overdue");
  });
  it("reads follow-up dates against today", () => {
    expect(followUpState("2026-09-29", TODAY)).toBe("today");
    expect(followUpState("2026-10-03", TODAY)).toBe("soon");
    expect(followUpState("2026-11-01", TODAY)).toBe("none");
    expect(followUpState(null, TODAY)).toBe("none");
  });
  it("flags a client past their usual reorder gap", () => {
    expect(dueToReorder(row({ lastInvoice: "2026-07-01", cadenceDays: 45 }), TODAY)).toBe(true);
    expect(dueToReorder(row({ lastInvoice: "2026-09-10", cadenceDays: 45 }), TODAY)).toBe(false);
    expect(dueToReorder(row({ lastInvoice: "2026-07-01", cadenceDays: null }), TODAY)).toBe(false);
  });
});

describe("regionRollup", () => {
  it("counts every client with a region, pinned or not", () => {
    const out = regionRollup([
      row({ region: "US-NJ", lat: 1, lng: 1, profit: 10 }),
      row({ region: "US-NJ", profit: 5 }),
      row({ region: "France", lat: 2, lng: 2 }),
      row({ region: "" }),
    ]);
    const nj = out.find((r) => r.region === "US-NJ")!;
    expect(nj).toMatchObject({ label: "New Jersey", count: 2, mapped: 1, profit: 15 });
    expect(out).toHaveLength(2);
  });
});
