import { describe, it, expect } from "vitest";
import { SEARCH_MIN_CHARS, handoffFor, newBolHandoff, searchHits, searchable } from "./logisticsSearch";
import { parseOpenLoad } from "./logisticsCarriers";

// R-459 section 12: the palette's Loads, BOLs and Carriers. Invented names throughout.

const res = {
  loads: [
    { id: "fb_1", load_number: "LD-0012", route: "Dallas, TX to Newark, NJ", status: "quote", carrier: "", deal_label: "INV-0042 for Hollis Retail" },
    { id: "fb_2", load_number: "LD-0013", route: "", status: "booked", carrier: "Harbor Freight Lines" },
  ],
  bols: [
    { id: "b1", number: "BOL-0003", shipper: "Northgate Supply", consignee: "Lakeside Depot", load_number: "LD-0012" },
    { id: "b2", number: "BOL-0004", shipper: "", consignee: "", load_number: "" },
  ],
  carriers: [{ id: "c1", name: "Harbor Freight Lines", mc_number: "123456" }, { id: "c2", name: "Mill Road Trucking", mc_number: "" }],
};

describe("searchable", () => {
  it("waits for two characters", () => {
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(searchable("L")).toBe(false);
    expect(searchable(" L ")).toBe(false);
    expect(searchable("LD")).toBe(true);
    expect(searchable("")).toBe(false);
  });
});

describe("searchHits", () => {
  it("lists loads, then BOLs, then carriers", () => {
    expect(searchHits(res).map((h) => `${h.kind}:${h.id}`)).toEqual(["Load:fb_1", "Load:fb_2", "BOL:b1", "BOL:b2", "Carrier:c1", "Carrier:c2"]);
  });
  it("labels a load by its number and describes it by route, status, carrier and deal", () => {
    const [a, b] = searchHits(res);
    expect(a.label).toBe("LD-0012");
    expect(a.sub).toBe("Dallas, TX to Newark, NJ · Quote asked · INV-0042 for Hollis Retail");
    expect(b.sub).toBe("Booked · Harbor Freight Lines");
  });
  it("reads the status in the Logistics account's words when it is that account", () => {
    expect(searchHits(res, true)[0].sub).toContain("Quote needed");
  });
  it("describes a BOL by its two ends and its load, and a carrier by its MC number", () => {
    const h = searchHits(res);
    expect(h[2].label).toBe("BOL-0003");
    expect(h[2].sub).toBe("Northgate Supply to Lakeside Depot · Load LD-0012");
    expect(h[3].sub).toBe("");
    expect(h[4].sub).toBe("MC 123456");
    expect(h[5].sub).toBe("");
  });
  it("reads a missing list, an empty answer and no answer as no rows", () => {
    expect(searchHits({ loads: [] })).toEqual([]);
    expect(searchHits({ bols: res.bols }).map((h) => h.kind)).toEqual(["BOL", "BOL"]);
    expect(searchHits(null)).toEqual([]);
    expect(searchHits(undefined)).toEqual([]);
  });
  it("never prints an em dash", () => {
    expect(JSON.stringify(searchHits(res))).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("handoffFor: what a hit opens", () => {
  it("opens a load on Logistics through the load handoff the screen already reads", () => {
    const h = handoffFor("Load", "fb_1");
    expect(h.tab).toBe("logistics");
    expect(h.key).toBe("logistics_open_load");
    expect(parseOpenLoad(h.value)).toEqual({ id: "fb_1" });
    expect(h.event).toBe("logistics-open-load");
  });
  it("opens a carrier on Logistics by its id", () => {
    const h = handoffFor("Carrier", "c1");
    expect(h).toMatchObject({ tab: "logistics", key: "logistics_open_carrier", value: "c1" });
  });
  it("opens a BOL on the BOLs screen", () => {
    expect(handoffFor("BOL", "b1")).toEqual({ tab: "bols", key: "bols_open_id", value: "b1", event: "bols-open" });
  });
  it("starts a BOL from a load on the BOLs screen", () => {
    expect(newBolHandoff("fb_9")).toEqual({ tab: "bols", key: "bols_new_from_load", value: "fb_9", event: "bols-open" });
  });
});
