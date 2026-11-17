import { describe, expect, it } from "vitest";
import { attentionItems } from "./FinancialsAttention";

describe("attentionItems", () => {
  it("shows nothing when nothing needs a person", () => {
    expect(attentionItems(0, 0, 0)).toEqual([]);
  });

  it("names each thing once, with where it is answered", () => {
    const items = attentionItems(1, 3, 12);
    expect(items.map((i) => i.go)).toEqual(["setup", "report", "tobook"]);
    expect(items[0].text).toBe("1 bank needs its connection fixed.");
    expect(items[1].text).toBe("3 accounts do not agree with the bank.");
    expect(items[2].text).toBe("12 transactions are not in the tax figure yet.");
  });

  it("says one of a thing in the singular", () => {
    expect(attentionItems(0, 1, 1).map((i) => i.text)).toEqual([
      "1 account does not agree with the bank.",
      "1 transaction is not in the tax figure yet.",
    ]);
  });
});
