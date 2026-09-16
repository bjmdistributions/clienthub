import { describe, it, expect } from "vitest";
import { lotTags, suggestTags, toggleTag, isTagged, normalizeTag } from "./tags";

// R-310. Jack: "I may have multiple brands such as nike new balance adidas, but i have no
// way to tag it as that unless i do a variant but variants only work when putting qty and
// price." Detection has to find EVERY brand in one title, not just the strongest.

describe("suggestTags", () => {
  it("finds every brand in one title, in the order they appear", () => {
    expect(suggestTags("Mixed athletic lot — Nike, New Balance and Adidas")).toEqual(["Nike", "New Balance", "adidas"]);
  });

  it("offers a model AND the brand it implies", () => {
    expect(suggestTags("Air Max 90 overstock")).toEqual(["Air Max", "Nike"]);
    expect(suggestTags("Samba mixed sizes")).toEqual(["Samba", "adidas"]);
  });

  it("matches a brand's aliases and returns the canonical spelling", () => {
    expect(suggestTags("DOC MARTENS boots")).toEqual(["Dr. Martens", "Boots"]);
    expect(suggestTags("UNDERARMOUR joggers")).toEqual(["Under Armour", "Joggers"]);
  });

  it("only matches on a word boundary", () => {
    expect(suggestTags("Advanced logistics pallets")).toEqual([]); // not Vans
    expect(suggestTags("Item 15748 assorted")).toEqual([]);        // not New Balance 574
    expect(suggestTags("574 assorted")).toEqual(["574", "New Balance"]);
  });

  it("matches tags already used on other lots first, keeping their spelling", () => {
    expect(suggestTags("NIKE tech fleece", ["NIKE"])).toEqual(["NIKE", "Tech Fleece"].slice(0, 1));
  });

  it("picks up unbranded styles", () => {
    expect(suggestTags("Assorted crew socks and hoodies")).toEqual(["Crew Socks", "Hoodie"]);
  });

  it("returns nothing for empty or unmatched text", () => {
    expect(suggestTags("")).toEqual([]);
    expect(suggestTags("   ")).toEqual([]);
    expect(suggestTags("Assorted general merchandise")).toEqual([]);
  });
});

describe("lotTags", () => {
  it("reads details_json.tags and nothing else", () => {
    expect(lotTags('{"tags":["Nike","Air Max"],"categories":["Shoes"]}')).toEqual(["Nike", "Air Max"]);
    // A category is NEVER a tag — that separation is the whole point of the namespace.
    expect(lotTags('{"categories":["Shoes"]}')).toEqual([]);
  });

  it("survives junk without throwing", () => {
    expect(lotTags(null)).toEqual([]);
    expect(lotTags("not json")).toEqual([]);
    expect(lotTags('{"tags":"Nike"}')).toEqual([]);
    expect(lotTags('{"tags":["  ", null, "Nike"]}')).toEqual(["Nike"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(lotTags('{"tags":["Nike","NIKE","nike"]}')).toEqual(["Nike"]);
  });
});

describe("toggleTag", () => {
  it("adds then removes, case-insensitively", () => {
    const one = toggleTag([], " Nike ");
    expect(one).toEqual(["Nike"]);
    expect(toggleTag(one, "NIKE")).toEqual([]);
    expect(isTagged(one, "nike")).toBe(true);
  });

  it("ignores a blank rather than storing an empty tag", () => {
    expect(toggleTag(["Nike"], "   ")).toEqual(["Nike"]);
  });

  it("collapses inner whitespace so one tag cannot exist twice", () => {
    expect(normalizeTag("  New   Balance ")).toBe("New Balance");
    expect(toggleTag(["New Balance"], "New   Balance")).toEqual([]);
  });
});
