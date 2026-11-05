import { describe, it, expect } from "vitest";
import { cleanLines, csvRowCount, dayWord, gotWord, linesTotals, purchaseName, receivedProblem } from "./purchases";

describe("the invoice lines", () => {
  it("add up to the total and the units, to the cent, leaving out a line with no name or count", () => {
    const lines = [{ what: "Hats", qty: 100, price: 10.1 }, { what: "Caps", qty: 3, price: 0.33 }, { what: "", qty: 5, price: 9 }, { what: "Socks", qty: 0, price: 4 }];
    expect(linesTotals(lines)).toEqual({ units: 103, total: 1010.99 });
    expect(cleanLines(lines)).toEqual([{ what: "Hats", qty: 100, price: 10.1 }, { what: "Caps", qty: 3, price: 0.33 }]);
    expect(linesTotals([])).toEqual({ units: 0, total: 0 });
  });
});

describe("how an order reads", () => {
  it("says how many got here against how many were ordered", () => {
    expect(gotWord({ units_ordered: 200, units_received: 150 })).toBe("150 of 200");
    expect(gotWord({ units_ordered: 1200, units_received: null })).toBe("1,200 ordered");
    expect(gotWord({ units_ordered: 40, units_received: 0 })).toBe("0 of 40");
  });
  it("words a day plainly and nothing for no day", () => {
    expect(dayWord("2026-10-08")).toBe("Oct 8, 2026");
    expect(dayWord("")).toBe("");
    expect(dayWord("2026-13-01")).toBe("");
  });
  it("names an order from its supplier and invoice, else its first line", () => {
    expect(purchaseName({ supplier: "Sample Supply", invoiceNo: "INV-9" })).toBe("Sample Supply, invoice INV-9");
    expect(purchaseName({ supplier: " ", invoiceNo: "", firstLine: "Hats" })).toBe("Hats");
    expect(purchaseName({ supplier: "", invoiceNo: "" })).toBe("Purchase order");
  });
});

describe("counting an order in", () => {
  it("always needs the units and the day", () => {
    expect(receivedProblem(150, "2026-10-08")).toBe("");
    expect(receivedProblem(0, "2026-10-08")).toBe("");
    expect(receivedProblem(null, "2026-10-08")).toBe("Enter how many arrived.");
    expect(receivedProblem(150, "")).toBe("Say the day it was counted.");
  });
  it("takes the unit count from a CSV manifest: the filled rows under its header", () => {
    expect(csvRowCount("sku,qty\nA,1\nB,2\n\n,,\n")).toBe(2);
    expect(csvRowCount("")).toBe(0);
    expect(csvRowCount("sku,qty\n")).toBe(0);
  });
});
