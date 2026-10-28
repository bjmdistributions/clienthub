import { describe, it, expect } from "vitest";
import { expireDays, timeLeft } from "./lotTimer";

const at = (iso: string) => Date.parse(iso);
const lot = (details: object | null, over: Partial<{ status: string; updated_at: string }> = {}) => ({
  status: "available", updated_at: "2026-10-01T12:00:00Z", details_json: details ? JSON.stringify(details) : null, ...over,
});

describe("R-559 lot timer", () => {
  it("counts from the last renewal", () => {
    expect(timeLeft(lot({ expire_days: 2 }), at("2026-10-01T12:00:00Z"))).toBe("2d 0h");
    expect(timeLeft(lot({ expire_days: 2 }), at("2026-10-02T08:00:00Z"))).toBe("1d 4h");
    expect(timeLeft(lot({ expire_days: 2 }), at("2026-10-03T11:30:00Z"))).toBe("1h");
    expect(timeLeft(lot({ expire_days: 2 }), at("2026-10-03T12:00:00Z"))).toBe("now");
  });

  it("no timer, zero, bad JSON, or a lot that is not available shows nothing", () => {
    expect(timeLeft(lot(null))).toBe(null);
    expect(timeLeft(lot({ expire_days: 0 }))).toBe(null);
    expect(timeLeft({ status: "available", updated_at: "2026-10-01T12:00:00Z", details_json: "not json" })).toBe(null);
    expect(timeLeft(lot({ expire_days: 2 }, { status: "reserved" }))).toBe(null);
  });

  it("caps at a year", () => {
    expect(expireDays(JSON.stringify({ expire_days: 9999 }))).toBe(365);
    expect(expireDays(JSON.stringify({ expire_days: -3 }))).toBe(0);
  });
});
