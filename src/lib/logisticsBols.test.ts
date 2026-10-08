import { describe, it, expect } from "vitest";
import {
  FREIGHT_TERMS, NEW_BOL_FROM_LOAD_KEY, OPEN_BOL_KEY, UNIT_TYPES, blankBol, blankBolItem, bolChanged, bolForSave, bolHasData, bolMatches,
  bolPdfPath, bolPrefillOf, bolProblem, bolRecordOf, bolRouteLine, bolTotals, freightTermsKey, lowersCounter, normalBol, numberPreview,
  numberingProblem, rateConPath, weightWord,
} from "./logisticsBols";

// R-459 section 8: the BOLs we make. Invented names and figures throughout.

describe("the lists", () => {
  it("has the seven unit types and the three freight terms of the contract", () => {
    expect([...UNIT_TYPES]).toEqual(["Pallet", "Skid", "Carton", "Crate", "Drum", "Bundle", "Other"]);
    expect(FREIGHT_TERMS.map((t) => t.key)).toEqual(["prepaid", "collect", "third_party"]);
  });
  it("reads an unknown freight term as prepaid", () => {
    expect(freightTermsKey("collect")).toBe("collect");
    expect(freightTermsKey("third_party")).toBe("third_party");
    expect(freightTermsKey("sender pays")).toBe("prepaid");
    expect(freightTermsKey(undefined)).toBe("prepaid");
  });
  it("addresses the PDF under /api/logistics, the only prefix the bridge passes", () => {
    expect(bolPdfPath("b_12")).toBe("/api/logistics/bols/b_12/pdf");
  });
  it("addresses the rate confirmation under /api/logistics too (R-475)", () => {
    expect(rateConPath("fb_7")).toBe("/api/logistics/bookings/fb_7/rate-confirmation");
  });
  it("hands off through the two keys the screen reads", () => {
    expect(OPEN_BOL_KEY).toBe("bols_open_id");
    expect(NEW_BOL_FROM_LOAD_KEY).toBe("bols_new_from_load");
  });
});

describe("a new BOL", () => {
  it("starts today, prepaid, with one empty item and every key", () => {
    const b = blankBol("2026-10-06");
    expect(b.ship_date).toBe("2026-10-06");
    expect(b.freight_terms).toBe("prepaid");
    expect(b.items).toEqual([blankBolItem()]);
    expect(Object.keys(b).sort()).toEqual(
      ["bill_to", "carrier", "cod_amount", "consignee", "declared_value", "freight_terms", "items", "refs", "ship_date", "shipper", "special_instructions"],
    );
    expect(Object.keys(b.refs).sort()).toEqual(["customer_ref", "load_number", "pickup_number", "po"]);
    expect(Object.keys(b.carrier).sort()).toEqual(["name", "pro", "scac", "seal", "trailer"]);
  });
  it("is not changed until something is typed, and an untouched extra row does not count", () => {
    const a = blankBol("2026-10-06");
    expect(bolChanged(a, blankBol("2026-10-06"))).toBe(false);
    expect(bolChanged(a, { ...a, items: [...a.items, blankBolItem()] })).toBe(false);
    expect(bolChanged(a, { ...a, shipper: { ...a.shipper, name: "Northgate Supply" } })).toBe(true);
  });
});

describe("normalBol: every key present on read", () => {
  it("fills what the server left out and turns numbers into the text they are typed as", () => {
    const d = normalBol({
      ship_date: "2026-10-07", freight_terms: "collect", shipper: { name: "Northgate Supply" },
      items: [{ units: 3, unit_type: "Skid", pieces: 12, description: "Bolt kits", weight_lbs: 1450.5, hazmat: 1 }],
      cod_amount: 250,
    });
    expect(d.shipper).toEqual({ name: "Northgate Supply", address: "", contact: "", phone: "" });
    expect(d.consignee).toEqual({ name: "", address: "", contact: "", phone: "" });
    expect(d.bill_to).toEqual({ name: "", address: "" });
    expect(d.refs.po).toBe("");
    expect(d.items[0]).toEqual({ units: "3", unit_type: "Skid", pieces: "12", description: "Bolt kits", weight_lbs: "1450.5", class: "", nmfc: "", hazmat: true });
    expect(d.cod_amount).toBe("250");
    expect(d.freight_terms).toBe("collect");
  });
  it("reads the stored JSON string, junk and null as an empty BOL", () => {
    expect(normalBol(JSON.stringify({ ship_date: "2026-10-01" })).ship_date).toBe("2026-10-01");
    expect(normalBol("not json").items).toEqual([]);
    expect(normalBol(null).carrier.scac).toBe("");
    expect(normalBol([]).special_instructions).toBe("");
  });
  it("gives an item with no unit type the first one", () => {
    expect(normalBol({ items: [{}] }).items[0].unit_type).toBe("Pallet");
  });
});

describe("bolRecordOf and bolPrefillOf", () => {
  it("reads a saved record: data under data, the load and the viewer's flags", () => {
    const r = bolRecordOf({ id: "b1", number: "BOL-0003", booking_id: "fb_9", load_number: "LD-0012", can_see_names: false, data: { shipper: { name: "" }, refs: { load_number: "LD-0012" } } });
    expect(r.id).toBe("b1");
    expect(r.number).toBe("BOL-0003");
    expect(r.bookingId).toBe("fb_9");
    expect(r.loadNumber).toBe("LD-0012");
    expect(r.canNames).toBe(false);
    expect(r.canAddresses).toBe(true);
  });
  it("reads data_json, and a bare data object, and takes the load number from the references", () => {
    expect(bolRecordOf({ id: "b2", data_json: JSON.stringify({ ship_date: "2026-10-02" }) }).data.ship_date).toBe("2026-10-02");
    const bare = bolRecordOf({ ship_date: "2026-10-03", shipper: { name: "Lakeside Depot" }, refs: { load_number: "LD-0007" } });
    expect(bare.data.shipper.name).toBe("Lakeside Depot");
    expect(bare.loadNumber).toBe("LD-0007");
  });
  it("tells an answer with data from one without, so a save never blanks the form", () => {
    expect(bolHasData({ id: "b1", number: "BOL-0001" })).toBe(false);
    expect(bolHasData({ id: "b1", data: {} })).toBe(true);
    expect(bolHasData({ shipper: {} })).toBe(true);
    expect(bolHasData(null)).toBe(false);
  });
  it("builds a prefill that remembers the load it came from", () => {
    const p = bolPrefillOf({ data: { carrier: { name: "Harbor Freight Lines", pro: "PRO-991" }, refs: { load_number: "LD-0012" } } }, "fb_9");
    expect(p.bookingId).toBe("fb_9");
    expect(p.loadNumber).toBe("LD-0012");
    expect(p.data.carrier.pro).toBe("PRO-991");
    expect(bolPrefillOf({ booking_id: "fb_1", data: {} }, "fb_9").bookingId).toBe("fb_1");
  });
});

describe("totals", () => {
  it("adds units, pieces and weight, reading commas and ignoring empty rows", () => {
    const t = bolTotals([
      { units: "2", pieces: "24", weight_lbs: "1,200" },
      { units: "1", pieces: "", weight_lbs: "350.5" },
      { units: "", pieces: "", weight_lbs: "" },
      { units: "x", pieces: "3", weight_lbs: "abc" },
    ]);
    expect(t).toEqual({ units: 3, pieces: 27, weight: 1550.5 });
  });
  it("says weight in pounds, or a dash for none", () => {
    expect(weightWord(1550.5)).toBe("1,550.5 lbs");
    expect(weightWord(0)).toBe("-");
  });
});

describe("what is saved", () => {
  it("trims the text and leaves out item rows with nothing in them, keeping a row that only has a hazmat tick", () => {
    const d = blankBol("2026-10-06");
    d.shipper.name = "  Northgate Supply ";
    d.refs.po = " PO-4410 ";
    d.items = [{ ...blankBolItem(), units: "2", description: " Bolt kits " }, blankBolItem(), { ...blankBolItem(), hazmat: true }];
    const out = bolForSave(d);
    expect(out.shipper.name).toBe("Northgate Supply");
    expect(out.refs.po).toBe("PO-4410");
    expect(out.items).toHaveLength(2);
    expect(out.items[0].description).toBe("Bolt kits");
    expect(out.items[1].hazmat).toBe(true);
  });
  it("sends a hidden name as empty, which the server keeps rather than erases", () => {
    const d = blankBol("2026-10-06");
    expect(bolForSave(d).shipper.name).toBe("");
  });
});

describe("problems said before saving", () => {
  it("lets a half-filled BOL save", () => {
    expect(bolProblem(blankBol("2026-10-06"))).toBeNull();
  });
  it("names an item figure that is not a number", () => {
    const d = blankBol("2026-10-06");
    d.items = [{ ...blankBolItem(), units: "2" }, { ...blankBolItem(), weight_lbs: "heavy" }];
    expect(bolProblem(d)).toBe("Item 2: the weight must be a number.");
  });
  it("names a COD amount or declared value that is not a number, and accepts a dollar sign and commas", () => {
    const d = blankBol("2026-10-06");
    d.cod_amount = "$1,250.00";
    expect(bolProblem(d)).toBeNull();
    d.declared_value = "a lot";
    expect(bolProblem(d)).toBe("Declared value must be a number.");
  });
});

describe("the list", () => {
  const row = { id: "b1", number: "BOL-0003", booking_id: "fb_9", load_number: "LD-0012", ship_date: "2026-10-06", shipper: "Northgate Supply", consignee: "Lakeside Depot", carrier: "Harbor Freight Lines", created_at: "2026-10-06T10:00:00Z" };
  it("says the two ends, or the one it has", () => {
    expect(bolRouteLine(row)).toBe("Northgate Supply to Lakeside Depot");
    expect(bolRouteLine({ shipper: "Northgate Supply", consignee: "" })).toBe("Northgate Supply");
    expect(bolRouteLine({ shipper: "", consignee: "" })).toBe("");
  });
  it("matches the BOL number, the load number, either end and the carrier, ignoring case", () => {
    for (const t of ["bol-0003", "ld-0012", "northgate", "LAKESIDE", "harbor", ""]) expect(bolMatches(row, t)).toBe(true);
    expect(bolMatches(row, "nobody")).toBe(false);
  });
});

describe("numbering", () => {
  it("previews the next number the way the server pads it", () => {
    expect(numberPreview("LD-", 1)).toBe("LD-0001");
    expect(numberPreview("BOL-", 42)).toBe("BOL-0042");
    expect(numberPreview("LD-", 12345)).toBe("LD-12345");
    expect(numberPreview("LD-", 0)).toBe("LD-0001");
  });
  it("wants whole next numbers of at least one", () => {
    expect(numberingProblem(1, 1)).toBeNull();
    expect(numberingProblem(0, 5)).toBe("The next load number must be a whole number of at least 1.");
    expect(numberingProblem(5, 2.5)).toBe("The next BOL number must be a whole number of at least 1.");
    expect(numberingProblem(NaN, 5)).not.toBeNull();
  });
  it("flags only a lowered counter", () => {
    expect(lowersCounter(10, 4)).toBe(true);
    expect(lowersCounter(10, 10)).toBe(false);
    expect(lowersCounter(10, 40)).toBe(false);
  });
});
