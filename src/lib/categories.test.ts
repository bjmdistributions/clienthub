import { describe, it, expect } from "vitest";
import { categoryMenu, isPicked, toggleCategory, lotCategories } from "./categories";

// R-309. Jack: "when i click something for it to not reset and instead just show a
// checkmark in the drop down and also display all categories in general … it clears the
// list once i select something." Every assertion here is one of those three complaints.

const OPTIONS = ["Clothing", "Electronics", "Hats", "Toys", "Appliances", "Beauty/Cosmetics", "Shoes", "General Merchandise", "Tools"];

describe("categoryMenu", () => {
  it("lists every category, not a capped slice", () => {
    const { list } = categoryMenu(OPTIONS, [], "");
    expect(list.length).toBe(OPTIONS.length);
    expect(list.length).toBeGreaterThan(8); // the old menu stopped here
  });

  it("keeps a picked category in the list instead of hiding it", () => {
    const { list } = categoryMenu(OPTIONS, ["Hats"], "");
    expect(list).toContain("Hats");
    expect(list.length).toBe(OPTIONS.length);
    expect(isPicked(["Hats"], "hats")).toBe(true);
  });

  it("shows a hand-typed category that the org list doesn't have yet", () => {
    const { list } = categoryMenu(OPTIONS, ["Seasonal"], "");
    expect(list).toContain("Seasonal");
  });

  it("dedupes case-insensitively and sorts alphabetically", () => {
    const { list } = categoryMenu(["hats", "Hats", "Clothing"], ["HATS"], "");
    expect(list.filter((c) => c.toLowerCase() === "hats")).toEqual(["HATS"]);
    expect(list).toEqual(["Clothing", "HATS"]);
  });

  it("filters on what is typed, without a cap", () => {
    expect(categoryMenu(OPTIONS, [], "o").list).toEqual(["Beauty/Cosmetics", "Clothing", "Electronics", "Shoes", "Tools", "Toys"]);
    expect(categoryMenu(OPTIONS, [], "hat").list).toEqual(["Hats"]);
  });

  it("offers to create only a category that doesn't exist, picked or not", () => {
    expect(categoryMenu(OPTIONS, [], "Vintage").canCreate).toBe(true);
    expect(categoryMenu(OPTIONS, [], "hats").canCreate).toBe(false);
    expect(categoryMenu(OPTIONS, ["Seasonal"], "seasonal").canCreate).toBe(false);
    expect(categoryMenu(OPTIONS, [], "   ").canCreate).toBe(false);
  });
});

describe("toggleCategory", () => {
  it("adds, then removes the same click", () => {
    const once = toggleCategory([], "Hats");
    expect(once).toEqual(["Hats"]);
    expect(toggleCategory(once, "Hats")).toEqual([]);
  });

  it("un-picks case-insensitively and trims", () => {
    expect(toggleCategory(["Hats"], " hats ")).toEqual([]);
  });

  it("ignores an empty pick rather than storing a blank category", () => {
    expect(toggleCategory(["Hats"], "   ")).toEqual(["Hats"]);
  });

  it("keeps the order categories were added in", () => {
    const v = toggleCategory(toggleCategory(toggleCategory([], "Clothing"), "Hats"), "Shoes");
    expect(v).toEqual(["Clothing", "Hats", "Shoes"]);
    expect(toggleCategory(v, "Hats")).toEqual(["Clothing", "Shoes"]);
  });
});

describe("lotCategories", () => {
  it("returns the multi list plus the legacy column, details first", () => {
    expect(lotCategories('{"categories":["Clothing","Hats"]}', "Clothing")).toEqual(["Clothing", "Hats"]);
  });

  it("keeps a primary column the multi list never got", () => {
    expect(lotCategories("{}", "Toys")).toEqual(["Toys"]);
    expect(lotCategories(null, "Toys")).toEqual(["Toys"]);
  });

  it("survives unparseable or absent details_json", () => {
    expect(lotCategories("not json", "Toys")).toEqual(["Toys"]);
    expect(lotCategories('{"categories":"Clothing"}', "Toys")).toEqual(["Toys"]);
    expect(lotCategories("", "")).toEqual([]);
  });

  it("dedupes case-insensitively", () => {
    expect(lotCategories('{"categories":["Hats"]}', "hats")).toEqual(["Hats"]);
  });
});
