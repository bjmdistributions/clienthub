import { describe, expect, it } from "vitest";
import { addScan, boxRows, boxUnits, brandHint, cleanBarcode, emptyBox, ScanReader, setCount, settleMatch, showBarcode, undoScan, type Resolved } from "./receive";

const known: Resolved = { code: "00883139385961", line_id: "wcnt", size: "11", item: { code: "00883139385961", brand: "LA", style: "MUM1913OA", color: "WCNT", color_name: "Waxed Chestnut", description: "Harrison Moc", size: "11", how: "matched" } };

describe("barcodes (R-568)", () => {
  it("keeps a UPC and its EAN the same way, and refuses a carton's", () => {
    expect(cleanBarcode("883139385961")).toEqual({ code: "00883139385961" });
    expect(cleanBarcode("0883139385961")).toEqual({ code: "00883139385961" });
    expect(showBarcode("00883139385961")).toBe("883139385961");
    expect("error" in cleanBarcode("10883139385968")).toBe(true);
    expect(cleanBarcode("LAMO-11-WCNT")).toEqual({ code: "LAMO-11-WCNT" });
    expect("error" in cleanBarcode("two words")).toBe(true);
  });
  it("suggests a brand only from a barcode already matched with the same leading digits", () => {
    expect(brandHint("00883139385978", [known])).toBe("LA");
    expect(brandHint("00123456789012", [known])).toBe("");
  });
});

describe("the open box (R-568)", () => {
  it("counts known scans on their line, holds unknown ones, and undoes the last", () => {
    let b = emptyBox("rx-1", 1, "box");
    b = addScan(b, known.code, known);
    b = addScan(b, known.code, known);
    b = addScan(b, "00883139385978", undefined);
    expect(b.contents).toEqual([{ line_id: "wcnt", size: "11", pairs: 2 }]);
    expect(b.unmatched).toEqual({ "00883139385978": 1 });
    expect(boxUnits(b)).toBe(3);
    expect(boxRows(b)[0]).toEqual({ kind: "code", code: "00883139385978", n: 1 });
    b = undoScan(b);
    expect(b.unmatched).toEqual({});
    b = undoScan(undoScan(b));
    expect(b.contents).toEqual([]);
    expect(undoScan(b)).toEqual(b);
  });
  it("moves waiting units onto their line when the barcode is matched, and sets a count by hand", () => {
    let b = addScan(addScan(emptyBox("rx-1", 1, "box"), known.code, undefined), known.code, undefined);
    b = settleMatch(b, known);
    expect(b.contents).toEqual([{ line_id: "wcnt", size: "11", pairs: 2 }]);
    expect(b.unmatched).toEqual({});
    b = setCount(b, "wcnt", "11", 12);
    expect(boxUnits(b)).toBe(12);
    b = setCount(b, "wcnt", "11", 0);
    expect(b.contents).toEqual([]);
  });
});

describe("telling a scanner from typing (R-568)", () => {
  it("takes a fast burst ending in Enter, and ignores typing and short bursts", () => {
    const r = new ScanReader(100, 8);
    let t = 1000, out = null;
    for (const k of "883139385961") out = r.key(k, (t += 15));
    expect(out).toBeNull();
    expect(r.key("Enter", (t += 15))).toEqual({ scan: "883139385961" });
    // A person typing: 300 ms apart, so each key starts over.
    for (const k of "883139385961") r.key(k, (t += 300));
    expect(r.key("Enter", (t += 300))).toBeNull();
    // Too short to be a barcode.
    for (const k of "1234") r.key(k, (t += 10));
    expect(r.key("Enter", (t += 10))).toBeNull();
  });
});
