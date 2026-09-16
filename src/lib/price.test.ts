import { describe, it, expect } from "vitest";
import { lotPriceBlock, lotUnitPrice, impliedPriceBand } from "./price";
import type { Lot, LotDetails } from "./api";

// R-311. Per unit is the headline on every lot that has one; the whole-lot total drops to
// a supporting line; a genuinely flat rate keeps the headline and says what it buys.
const lot = (price_type: string, asking_price: number, quantity: number) =>
  ({ price_type, asking_price, quantity }) as Pick<Lot, "price_type" | "asking_price" | "quantity">;

describe("lotPriceBlock", () => {
  it("puts the per-unit price in the headline and the load total underneath", () => {
    const b = lotPriceBlock(lot("per_unit", 3.16, 50_000), { moq: 5_000 } as LotDetails);
    expect(b.headline).toBe("$3.16");
    expect(b.unit).toBe("per unit");
    expect(b.moq).toBe("5,000 unit minimum");
    expect(b.total).toBe("$158,000.00 for the whole lot");
  });

  it("derives the per-unit price of a lot priced as a whole load", () => {
    const b = lotPriceBlock(lot("total", 20_000, 10_000), {} as LotDetails);
    expect(b.headline).toBe("$2.00");
    expect(b.unit).toBe("per unit");
    expect(b.total).toBe("$20,000.00 for the whole lot");
    expect(b.moq).toBeNull();
  });

  it("keeps a flat rate as the headline when there is no quantity to divide by", () => {
    const b = lotPriceBlock(lot("total", 9_500, 0), {} as LotDetails);
    expect(b.headline).toBe("$9,500.00");
    expect(b.unit).toBe("for the whole lot");
    expect(b.total).toBeNull();
  });

  it("shows the band a ladder or variants imply when the lot carries no price of its own", () => {
    const det = { price_tiers: [{ min_qty: 5_000, price: 6 }, { min_qty: 20_000, price: 5 }], moq: 5_000 } as LotDetails;
    const b = lotPriceBlock(lot("per_unit", 0, 40_000), det);
    expect(b.headline).toBe("$5.00–$6.00");
    expect(b.unit).toBe("per unit");
    expect(b.total).toBeNull();
    expect(b.moq).toBe("5,000 unit minimum");
  });

  it("never prints $0.00 per unit", () => {
    const b = lotPriceBlock(lot("per_unit", 0, 0), {} as LotDetails);
    expect(b.headline).toBe("No price set");
    expect(b.priced).toBe(false);
    expect(b.unit).toBe("");
  });

  it("shows custom price text verbatim, with no per-unit or total beside it", () => {
    const b = lotPriceBlock(lot("custom", 0, 100), { price_text: "Make an offer — truckload only", moq: 500 } as LotDetails);
    expect(b.headline).toBe("Make an offer — truckload only");
    expect(b.unit).toBe("");
    expect(b.total).toBeNull();
    expect(b.moq).toBe("500 unit minimum");
  });

  it("keeps the quoted pallet price beside a per-pallet lot's per-unit headline", () => {
    // Stored the way the form multiplies it out: price_type total, whole-load ask.
    const det = { price_basis: "per_pallet", price_per_pallet: 1_500, pallets: 20 } as LotDetails;
    const b = lotPriceBlock(lot("total", 30_000, 9_000), det);
    expect(b.headline).toBe("$3.33");
    expect(b.unit).toBe("per unit");
    expect(b.pallet).toBe("$1,500.00 per pallet");
    expect(b.total).toBe("$30,000.00 for the whole lot");
  });

  it("headlines the per-unit BAND a quoted pallet range implies", () => {
    // "20 pallets at $1,500, 450-500 units a pallet" — the low count is the dear unit.
    const det = { price_basis: "per_pallet", price_per_pallet: 1_500, pallets: 20, qty_basis: "per_pallet", qty_per_pallet: 450, qty_per_pallet_max: 500 } as LotDetails;
    const b = lotPriceBlock(lot("total", 30_000, 9_000), det);
    expect(b.headline).toBe("$3.00–$3.33");
    expect(b.unit).toBe("per unit");
    expect(b.pallet).toBe("$1,500.00 per pallet");
    expect(b.total).toBe("$30,000.00 for the whole lot");
  });
});

describe("lotUnitPrice / impliedPriceBand", () => {
  it("divides a total-priced lot and passes a per-unit one straight through", () => {
    expect(lotUnitPrice(lot("total", 20_000, 10_000))).toBe(2);
    expect(lotUnitPrice(lot("per_unit", 3.16, 50_000))).toBe(3.16);
    // Deliberate fallthrough: this is the VARIANT fallback, so a blank variant price on a
    // quantity-less load still inherits the ask. lotPriceBlock does not use it — see its comment.
    expect(lotUnitPrice(lot("total", 20_000, 0))).toBe(20_000);
    expect(lotUnitPrice(lot("custom", 20_000, 10))).toBe(0);
  });

  it("ignores blank and zero variant prices when building the band", () => {
    expect(impliedPriceBand({ variants: [{ values: ["M"], qty: 0, price: null }, { values: ["L"], qty: 0, price: 0 }] } as LotDetails)).toBeNull();
    expect(impliedPriceBand({ variants: [{ values: ["M"], qty: 0, price: 4 }, { values: ["L"], qty: 0, price: 7 }] } as LotDetails)).toEqual({ low: 4, high: 7 });
  });
});
