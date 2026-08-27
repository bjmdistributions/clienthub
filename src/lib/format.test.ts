import { describe, it, expect } from "vitest";
import { parseAmount, parseCount } from "./format";

// R-206. A figure pasted out of a spreadsheet, an email or a bank statement arrives
// with commas and a dollar sign. Every one of these used to reach `parseFloat` as an
// empty string (the number input had already refused it) and be stored as 0.

describe("parseAmount", () => {
  it("takes a plain number", () => {
    expect(parseAmount("1234.56")).toBe(1234.56);
    expect(parseAmount("12")).toBe(12);
  });

  it("takes thousands separators, currency and spaces — the reported bug", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount(" 1,234,567.89 ")).toBe(1234567.89);
    expect(parseAmount("$52,890")).toBe(52890);
  });

  it("keeps a negative", () => {
    expect(parseAmount("-1,234.56")).toBe(-1234.56);
    expect(parseAmount("-$40")).toBe(-40);
  });

  it("returns the fallback for nothing typed, not a wrong number", () => {
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("   ")).toBe(0);
    expect(parseAmount("abc")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount("", 587)).toBe(587);
  });

  it("passes a number through, and refuses NaN/Infinity", () => {
    expect(parseAmount(42.5)).toBe(42.5);
    expect(parseAmount(NaN)).toBe(0);
    expect(parseAmount(Infinity, 7)).toBe(7);
  });

  it("survives a half-typed decimal — the box must not fight the keyboard", () => {
    expect(parseAmount("12.")).toBe(12);
    expect(parseAmount(".5")).toBe(0.5);
  });
});

describe("parseCount", () => {
  it("takes separators and truncates, the same as the parseInt it replaces", () => {
    expect(parseCount("1,250")).toBe(1250);
    expect(parseCount("12.9")).toBe(12);
    expect(parseCount("-3.7")).toBe(-3);
    expect(parseCount("")).toBe(0);
    expect(parseCount("", 587)).toBe(587);
  });
});
