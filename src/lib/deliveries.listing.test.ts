import { describe, expect, it } from "vitest";
import { listingCount, type LoadLine, type LoadOut, type Stock } from "./deliveries";

const line = (id: string, pairs: number) => ({ id, brand: "Lamo", sizes: [{ size: "9", qty: pairs }] }) as unknown as LoadLine;
const stock = (received: number, per: [string, number][]) =>
  ({ received, lines: per.map(([line_id, r]) => ({ line_id, received: r })) }) as unknown as Stock;
const out = (pairs: number, takes: number[] = [], undone = false) =>
  ({ pairs, undone, takes: takes.map((p) => ({ line_id: "a", size: "9", pairs: p })) }) as unknown as LoadOut;

// R-569: the same figures as delivery_listing.rs's tests on the server.
describe("listingCount", () => {
  it("lists the whole truck, one pallet boxed, less a sale by count", () => {
    expect(listingCount([line("a", 300), line("b", 200)], stock(60, [["a", 60]]), [out(17)])).toBe(483);
  });
  it("counts what arrived when more came than the manifest says", () => {
    expect(listingCount([line("a", 10)], stock(14, [["a", 14]]), [])).toBe(14);
  });
  it("skips a put back order and never goes below zero", () => {
    expect(listingCount([line("a", 10)], stock(0, []), [out(4, [4], true)])).toBe(10);
    expect(listingCount([line("a", 10)], stock(0, []), [out(25)])).toBe(0);
  });
});
