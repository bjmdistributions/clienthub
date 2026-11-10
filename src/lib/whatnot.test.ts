import { describe, expect, it } from "vitest";
import { dayOf, fingerprint, guessColumns, invoiceLines, lastDay, money, plan, readRows } from "./whatnot";

describe("R-648 Whatnot sales", () => {
  it("guesses each column from its heading, the net before the item", () => {
    expect(guessColumns(["Order ID", "Product Name", "Quantity", "Sold Price", "Net Earnings", "Order Date"]))
      .toEqual({ order: 0, item: 1, qty: 2, net: 4, date: 5 });
    expect(guessColumns(["Title", "Payout"])).toEqual({ item: 0, net: 1, qty: -1, date: -1, order: -1 });
  });

  it("reads money and days the way a sheet writes them", () => {
    expect([money("$1,234.56"), money("12"), money("-3.5"), money("(3.00)"), money("USD 4.10"), money(""), money("n/a")])
      .toEqual([1234.56, 12, -3.5, -3, 4.1, null, null]);
    expect([dayOf("2026-11-08T19:22:00Z"), dayOf("11/8/2026"), dayOf("1/2/26 7:00 PM"), dayOf("yesterday")])
      .toEqual(["2026-11-08", "2026-11-08", "2026-01-02", ""]);
  });

  it("reads every sale and skips a row it cannot read, never guessing", () => {
    const sheet = [
      ["Order", "Item", "Qty", "Net"],
      ["A1", "Test hat", "1", "$9.10"],
      ["", "", "", ""],
      ["A2", "Test cap", "3", "27.30"],
      ["A3", "", "1", "5"],
      ["A4", "Test visor", "1.5", "5"],
      ["A5", "Test beanie", "1", "free"],
    ];
    const got = readRows(sheet, guessColumns(sheet[0]));
    expect(got.skipped).toBe(3);
    expect(got.rows).toEqual([
      { item: "Test hat", qty: 1, net: 9.1, date: "", order: "A1" },
      { item: "Test cap", qty: 3, net: 27.3, date: "", order: "A2" },
    ]);
    // No count column: one each.
    expect(readRows([["Item", "Net"], ["Test hat", "4"]], guessColumns(["Item", "Net"])).rows[0].qty).toBe(1);
  });

  it("costs each sale at its load's average and refuses past what is left", () => {
    const rows = [
      { item: "a", qty: 2, net: 30, date: "2026-11-07", order: "" },
      { item: "b", qty: 1, net: 12.5, date: "2026-11-08", order: "" },
      { item: "c", qty: 1, net: 4, date: "", order: "" },
    ];
    const loads = [{ id: "L1", left: 2, unit_cost: 5.255 }, { id: "L2", left: 10, unit_cost: 3 }];
    const p = plan(rows, ["L1", "L1", "L2"], loads);
    expect(p.byLoad).toEqual([{ id: "L1", units: 3 }, { id: "L2", units: 1 }]);
    expect(p.over).toEqual([{ id: "L1", units: 3, left: 2 }]);
    expect([p.net, p.cost, p.made, p.unpicked]).toEqual([46.5, 18.77, 27.73, 0]);
    expect(plan(rows, ["L2", "", "L2"], loads).unpicked).toBe(1);
    expect(lastDay(rows, "2026-11-10")).toBe("2026-11-08");
    expect(lastDay([rows[2]], "2026-11-10")).toBe("2026-11-10");
  });

  it("writes one invoice line a sale at its net, to the cent", () => {
    expect(invoiceLines([
      { item: "Test hat", qty: 1, net: 9.1, date: "", order: "A1" },
      { item: "Test cap", qty: 3, net: 27.3, date: "", order: "" },
      { item: "Test visor", qty: 3, net: 10, date: "", order: "" },
    ])).toEqual([
      { description: "Test hat, order A1", qty: 1, rate: 9.1, amount: 9.1 },
      { description: "Test cap", qty: 3, rate: 9.1, amount: 27.3 },
      { description: "Test visor (3 units)", qty: 1, rate: 10, amount: 10 },
    ]);
  });

  it("marks the same sales the same way, and different sales differently", () => {
    const a = [{ item: "Test hat", qty: 1, net: 9.1, date: "", order: "A1" }];
    expect(fingerprint(a)).toBe(fingerprint([...a]));
    expect(fingerprint(a)).not.toBe(fingerprint([{ ...a[0], net: 9.2 }]));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{8}$/);
  });
});
