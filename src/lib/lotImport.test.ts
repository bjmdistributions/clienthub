import { describe, it, expect } from "vitest";
import type { Lot } from "./api";
import { findHeader, parseSheet, parseTiers, parseVariants, readNumber, splitRefs, markDuplicates, TEMPLATE_HEADERS, ImportRow } from "./lotImport";

// Invented lots and suppliers, never a real one.
const ctx = { categories: ["Clothing", "Home & kitchen", "Shoes"], suppliers: ["Sample Supply Co"], tags: ["Nike"] };
const H = TEMPLATE_HEADERS;
const sheet = (...rows: Record<string, string>[]) => [H, ...rows.map((r) => H.map((h) => r[h] ?? ""))];
const one = (r: Record<string, string>) => {
  const p = parseSheet(sheet(r), ctx);
  if (typeof p === "string") throw new Error(p);
  return p.rows[0];
};
const det = (row: ImportRow) => JSON.parse(row.draft.details_json || "{}");

const lot = (over: Partial<Lot>): Lot => ({
  id: "lot_1", name: "Sample lot", description: null, category: null, quantity: 0, total_cost: 0, asking_price: 0, status: "available",
  linked_deal_id: null, photos_json: "[]", created_at: "", updated_at: "", notes: null, sent_whatsapp: false, sent_email: false,
  sent_facebook: false, supplier: null, location: null, manifest_path: null, price_type: "per_unit", details_json: null, ...over,
});

describe("reading the sheet", () => {
  it("finds the header by its Name column, through renamed columns and a title row above it", () => {
    const h = findHeader([["Loads for October"], ["Title", "Qty", "MSRP", "Asking price", "Mystery"]]);
    expect(h?.index).toBe(1);
    expect(h?.col).toMatchObject({ name: 0, quantity: 1, msrp: 2, price: 3 });
    expect(h?.unknown).toEqual(["Mystery"]);
  });

  it("refuses a sheet with no Name column", () => {
    expect(parseSheet([["Qty", "Price"], ["4", "5"]], ctx)).toMatch(/no Name column/);
  });

  it("leaves out the template's example rows and empty rows", () => {
    const p = parseSheet([H, ["Example: mixed sneakers, shelf pulls"], [], ["Sample hats"]], ctx);
    if (typeof p === "string") throw new Error(p);
    expect(p.examplesSkipped).toBe(1);
    expect(p.rows.map((r) => [r.line, r.draft.name])).toEqual([[4, "Sample hats"]]);
  });

  it("reads numbers the way people type them", () => {
    expect(readNumber("$12,500.00")).toBe(12500);
    expect(readNumber("450 units")).toBe(450);
    expect(readNumber("")).toBe(null);
    expect(readNumber("lots")).toBe("bad");
  });

  it("splits many photos, by line, semicolon or comma, without breaking a link", () => {
    expect(splitRefs("a.jpg, b.jpg\nhttps://x.test/c.jpg?w=1,2;d.png")).toEqual(["a.jpg", "b.jpg", "https://x.test/c.jpg?w=1,2", "d.png"]);
  });
});

describe("a row saves what the lot form would save", () => {
  it("per pallet: the quantity and the price are multiplied out and the quote is kept", () => {
    const r = one({ Name: "Sample sneakers", Quantity: "450", Pallets: "4", "Quantity is": "Per pallet", "Per pallet up to": "500", "Price type": "Per pallet", "Selling price": "6,200" });
    expect(r.problems).toEqual([]);
    expect(r.draft).toMatchObject({ quantity: 1800, asking_price: 24800, price_type: "total" });
    expect(det(r)).toMatchObject({ pallets: 4, qty_basis: "per_pallet", qty_per_pallet: 450, qty_per_pallet_max: 500, price_basis: "per_pallet", price_per_pallet: 6200 });
  });

  it("a per-pallet price with no pallet count is refused, as the form refuses it", () => {
    const r = one({ Name: "Sample", "Price type": "Per pallet", "Selling price": "1500" });
    expect(r.problems).toContain("A per-pallet price needs a pallet count");
    expect(r.include).toBe(false);
    // The quote survives, so the form opens in Per pallet and adding the count fixes it.
    expect(det(r)).toMatchObject({ price_basis: "per_pallet", price_per_pallet: 1500 });
  });

  it("variants carry the quantity; the minimum order is the first rung of the ladder", () => {
    const r = one({
      Name: "Sample leggings", Quantity: "9", "Variant options": "Color, Size", Variants: "Black / S: 400; Black / M: 600 at 4.75; Navy / M: 500",
      "Price type": "Per unit", "Selling price": "4.50", "Minimum order": "500", "Volume pricing": "2,000+ at 4.00; 5000+ at 3.50",
    });
    expect(r.problems).toEqual([]);
    expect(r.draft).toMatchObject({ quantity: 1500, asking_price: 4.5, price_type: "per_unit" });
    const d = det(r);
    expect(d.moq).toBe(500);
    expect(d.price_tiers).toEqual([{ min_qty: 2000, price: 4 }, { min_qty: 5000, price: 3.5 }]);
    expect(d.options).toEqual([{ name: "Color", values: ["Black", "Navy"] }, { name: "Size", values: ["S", "M"] }]);
    expect(d.variants[1]).toEqual({ values: ["Black", "M"], qty: 600, price: 4.75 });
    expect(r.notes.join(" ")).toMatch(/Quantity 9 was replaced/);
  });

  it("a variant with the wrong number of values says which one", () => {
    const r = one({ Name: "Sample", "Variant options": "Color, Size", Variants: "Black: 4" });
    expect(r.problems[0]).toMatch(/Black: 4.*2 values/);
  });

  it("Your cost is the whole load; a per-unit lot keeps it per unit, as the card reads it", () => {
    expect(one({ Name: "S", Quantity: "1500", "Price type": "Per unit", "Selling price": "4.50", "Your cost": "4,200" }).draft.total_cost).toBe(2.8);
    expect(one({ Name: "S", Quantity: "1500", "Price type": "Per unit", "Selling price": "4.50", "Your cost per unit": "3" }).draft.total_cost).toBe(3);
    expect(one({ Name: "S", Quantity: "100", "Price type": "Fixed total", "Selling price": "900", "Your cost per unit": "3" }).draft.total_cost).toBe(300);
    expect(one({ Name: "S", Quantity: "4", Pallets: "2", "Price type": "Per pallet", "Selling price": "900", "Your cost": "1000" }).draft.total_cost).toBe(1000);
    const typo = one({ Name: "S", Quantity: "1500", "Price type": "Per unit", "Selling price": "4.50", "Your cost": "2.80" });
    expect(typo.notes.join(" ")).toMatch(/less than one unit's price/);
  });

  it("words in the price are custom text", () => {
    const r = one({ Name: "Sample", "Selling price": "Best offer" });
    expect(r.draft).toMatchObject({ price_type: "custom", asking_price: 0 });
    expect(det(r).price_text).toBe("Best offer");
  });

  it("a price with no type is read per unit, and says so", () => {
    const r = one({ Name: "Sample", Quantity: "10", "Selling price": "5" });
    expect(r.draft.price_type).toBe("per_unit");
    expect(r.notes).toContain("No price type, so the price was read as per unit");
  });

  it("categories, supplier and condition take the spelling already in use", () => {
    const r = one({ Name: "Sample", Categories: "home and kitchen, shoe, Toys", Condition: "customer returns", Supplier: "sample supply co", Location: "dallas texas" });
    expect(r.draft).toMatchObject({ category: "Home & kitchen", supplier: "Sample Supply Co", location: "Dallas, TX" });
    expect(det(r)).toMatchObject({ categories: ["Home & kitchen", "Shoes", "Toys"], condition: "Customer returns" });
    expect(r.notes).toContain("New category: Toys");
  });

  it("an empty row of extras stores no details at all, like the form", () => {
    const r = one({ Name: "Sample", Quantity: "5" });
    expect(r.draft.details_json).toBe(null);
  });

  it("several photos per lot, and the yes/no columns", () => {
    const r = one({ Name: "Sample", Photos: "front.jpg\nside.jpg\nhttps://x.test/back.png", "Sent on WhatsApp": "Yes", Emailed: "maybe" });
    expect(r.photos.map((p) => p.ref)).toEqual(["front.jpg", "side.jpg", "https://x.test/back.png"]);
    expect(r.draft).toMatchObject({ sent_whatsapp: true, sent_email: false });
    expect(r.notes).toContain('Emailed "maybe" was read as No');
  });
});

describe("ladders and variants on their own", () => {
  it("reads several ways of writing a price break", () => {
    expect(parseTiers("500+ @ $4.50, 2000+ at 4")).toEqual([{ min_qty: 500, price: 4.5 }, { min_qty: 2000, price: 4 }]);
    expect(parseTiers("1000")).toEqual([{ min_qty: 1000, price: 0 }]);
    expect(parseTiers("cheap")).toBe("bad");
  });

  it("variants without option names are refused", () => {
    expect(parseVariants("", "Red: 4")).toMatch(/Variant options/);
  });
});

describe("duplicates", () => {
  const rows = (...names: [string, string, string][]) => {
    const p = parseSheet(sheet(...names.map(([n, q, s]) => ({ Name: n, Quantity: q, Supplier: s, "Price type": "Per unit", "Selling price": "5" }))), ctx);
    if (typeof p === "string") throw new Error(p);
    return p.rows;
  };

  it("the same lot already in inventory starts unticked; a similar name is only flagged", () => {
    const out = markDuplicates(rows(["Sample Sneakers, Shelf Pulls", "1800", ""], ["Sample sneaker shelf pull lot", "20", ""], ["Sample hats", "50", ""]), [
      lot({ id: "a", name: "Sample sneakers shelf pulls", quantity: 1800 }),
      lot({ id: "b", name: "Old archived hats", status: "archived" }),
    ]);
    expect(out[0].dup).toMatchObject({ strength: "same", against: "inventory", lotId: "a", why: "Same name, same quantity" });
    expect(out[0].include).toBe(false);
    expect(out[1].dup?.strength).toBe("maybe");
    expect(out[1].include).toBe(true);
    expect(out[2].dup).toBe(null);
  });

  it("an archived lot is not a duplicate", () => {
    const out = markDuplicates(rows(["Old archived hats", "5", ""]), [lot({ name: "Old archived hats", quantity: 5, status: "archived" })]);
    expect(out[0].dup).toBe(null);
  });

  it("a row repeated in the same file points at the first one", () => {
    const out = markDuplicates(rows(["Sample hats", "50", "Sample Supply Co"], ["Sample hats", "50", "Sample Supply Co"]), []);
    expect(out[0].dup).toBe(null);
    expect(out[1].dup).toMatchObject({ strength: "same", against: "file", line: 2, why: "Same name, same quantity, price and supplier" });
  });

  it("a choice the person made survives a re-check", () => {
    const first = markDuplicates(rows(["Sample hats", "50", ""]), [lot({ name: "Sample hats", quantity: 50 })]);
    const ticked = [{ ...first[0], include: true, includeTouched: true }];
    expect(markDuplicates(ticked, [lot({ name: "Sample hats", quantity: 50 })])[0].include).toBe(true);
  });
});
