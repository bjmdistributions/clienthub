import { describe, it, expect } from "vitest";
import { buildLotBlock, buildNewsletterBody, type LotBlockInput } from "./newsletter";
import type { NewsletterProductTemplate } from "./api";

// The drop-empty-lines rule is the whole point of this helper and it is invisible
// until a lot happens to have no price: the label has to leave with the value, or
// the customer gets an email that says "Price per unit:" and nothing after it.

const lot = (over: Partial<LotBlockInput> = {}): LotBlockInput => ({
  title: "Mixed apparel pallet",
  units: 42,
  pricePerUnit: "$4.50",
  price: "$189.00",
  link: "https://example.com/i/abc",
  ...over,
});

const LOT_FORMAT = "{title}\n\nUnits: {units}\nPrice per unit: {price_per_unit}\n{price}\n\nLink to product: {link}";

describe("buildLotBlock", () => {
  it("fills every token when the lot has every value", () => {
    expect(buildLotBlock(LOT_FORMAT, lot())).toBe(
      "Mixed apparel pallet\n\nUnits: 42\nPrice per unit: $4.50\n$189.00\n\nLink to product: https://example.com/i/abc",
    );
  });

  it("drops the label along with the value when a token resolves empty", () => {
    const out = buildLotBlock(LOT_FORMAT, lot({ pricePerUnit: "" }));
    expect(out).not.toContain("Price per unit");
    expect(out).toContain("Units: 42");
  });

  it("drops a line only when ALL of its tokens are empty", () => {
    const out = buildLotBlock("{title} — {price}", lot({ price: "" }));
    // The line survives; the empty token renders as nothing, and the trailing space
    // goes with the block's trim.
    expect(out).toBe("Mixed apparel pallet —");
  });

  it("treats zero units as absent", () => {
    expect(buildLotBlock(LOT_FORMAT, lot({ units: 0 }))).not.toContain("Units:");
  });

  it("groups large unit counts", () => {
    expect(buildLotBlock("Units: {units}", lot({ units: 1200 }))).toBe(`Units: ${(1200).toLocaleString()}`);
  });

  it("collapses the gap left by dropped lines to one blank line", () => {
    const out = buildLotBlock(LOT_FORMAT, lot({ pricePerUnit: "", price: "" }));
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toBe("Mixed apparel pallet\n\nUnits: 42\n\nLink to product: https://example.com/i/abc");
  });

  it("keeps a line that carries no tokens at all", () => {
    expect(buildLotBlock("Ships from our warehouse", lot())).toBe("Ships from our warehouse");
  });
});

describe("buildNewsletterBody", () => {
  const template: NewsletterProductTemplate = {
    intro: "Hi {first_name},\n\nHere are some fresh loads that just came in:",
    outro: "Reply to this email to claim any of these.",
    lot_format: LOT_FORMAT,
  };

  it("leaves {first_name} intact for the per-recipient pass at send time", () => {
    expect(buildNewsletterBody(template, [lot()])).toContain("{first_name}");
  });

  it("puts the intro first and the outro last", () => {
    const out = buildNewsletterBody(template, [lot()]);
    expect(out.startsWith("Hi {first_name},")).toBe(true);
    expect(out.endsWith("Reply to this email to claim any of these.")).toBe(true);
  });

  it("renders one block per lot", () => {
    const out = buildNewsletterBody(template, [lot({ title: "Lot one" }), lot({ title: "Lot two" })]);
    expect(out).toContain("Lot one");
    expect(out).toContain("Lot two");
  });

  it("skips an empty intro or outro instead of leaving a blank gap", () => {
    const out = buildNewsletterBody({ ...template, intro: "", outro: "   " }, [lot()]);
    expect(out.startsWith("Mixed apparel pallet")).toBe(true);
    expect(out.endsWith("Link to product: https://example.com/i/abc")).toBe(true);
  });

  it("still produces the wrapper text when there are no lots", () => {
    expect(buildNewsletterBody(template, [])).toBe(
      "Hi {first_name},\n\nHere are some fresh loads that just came in:\n\nReply to this email to claim any of these.",
    );
  });
});
