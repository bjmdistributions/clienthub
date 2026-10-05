import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the phone
import { expiryState, DOC_CHECKLIST, DOC_CATEGORIES } from "./docsign.js";

describe("R-441 documents catalogue", () => {
  const now = new Date(2026, 9, 5);
  it("flags a renewal inside 60 days and anything past due", () => {
    expect(expiryState("2026-10-04", now)).toEqual({ tone: "danger", text: "Expired yesterday" });
    expect(expiryState("2026-10-05", now).tone).toBe("danger");
    expect(expiryState("2026-10-06", now)).toEqual({ tone: "warning", text: "Expires in 1 day" });
    expect(expiryState("2026-12-04", now).tone).toBe("warning");
    expect(expiryState("2027-01-10", now).tone).toBe(null);
    expect(expiryState("", now)).toEqual({ tone: null, text: "" });
  });
  it("every checklist slot sits in a real category", () => {
    const cats = new Set(DOC_CATEGORIES.map((c: { key: string }) => c.key));
    for (const s of DOC_CHECKLIST) expect(cats.has(s.category)).toBe(true);
    expect(DOC_CHECKLIST.some((s: { key: string }) => s.key === "resale_cert")).toBe(true);
  });
});
