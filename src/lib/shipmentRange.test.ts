import { describe, expect, it } from "vitest";
import { shipmentRange } from "./shipmentRange";

describe("shipmentRange (R-415)", () => {
  it("this month runs from the first to the last day", () => {
    expect(shipmentRange("month", "2026-10-02")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(shipmentRange("month", "2026-02-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(shipmentRange("month", "2028-02-15")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("last month steps back, across a year end too", () => {
    expect(shipmentRange("last", "2026-10-02")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(shipmentRange("last", "2026-01-09")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("this year and all", () => {
    expect(shipmentRange("year", "2026-10-02")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(shipmentRange("all", "2026-10-02")).toEqual({});
  });
  it("a custom range passes through and an empty end stays open", () => {
    expect(shipmentRange("custom", "2026-10-02", { from: "2026-08-01", to: "" })).toEqual({ from: "2026-08-01", to: undefined });
    expect(shipmentRange("custom", "2026-10-02")).toEqual({ from: undefined, to: undefined });
  });
});
