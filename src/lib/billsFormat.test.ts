import { describe, it, expect } from "vitest";
import type { BillsAlerts } from "./billsApi";
import {
  alertRow, chipState, daysBetween, daysInMonth, dueText, initials, monthLabels, pctChange, periodRange,
  PERIOD_PILL, rangeText, shortDay, tintIndex,
} from "./billsFormat";

// R-449 / R-446. The date and period rules the Bills screen leans on. All are plain strings, so
// the answers must not move with the machine's timezone.

describe("dates", () => {
  it("formats a short day without a timezone", () => {
    expect(shortDay("2026-10-08")).toBe("Oct 8");
    expect(shortDay("2026-01-31")).toBe("Jan 31");
    expect(shortDay("")).toBe("");
  });

  it("counts whole days across month ends and a leap day", () => {
    expect(daysBetween("2026-10-05", "2026-10-08")).toBe(3);
    expect(daysBetween("2026-10-08", "2026-10-05")).toBe(-3);
    expect(daysBetween("2026-02-27", "2026-03-02")).toBe(3);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("knows the length of a month", () => {
    expect(daysInMonth("2026-10-05")).toBe(31);
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2028-02-10")).toBe(29);
  });
});

describe("periodRange", () => {
  const today = "2026-10-05";
  it("this month runs from the 1st to today", () => {
    expect(periodRange("this_month", today)).toEqual({ from: "2026-10-01", to: "2026-10-05" });
  });
  it("last month is the whole previous month", () => {
    expect(periodRange("last_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
  it("last month steps back over a year end and into a short month", () => {
    expect(periodRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodRange("last_month", "2026-03-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("last 3 months starts on the 1st, two months back", () => {
    expect(periodRange("last_3", today)).toEqual({ from: "2026-08-01", to: "2026-10-05" });
    expect(periodRange("last_3", "2026-02-10")).toEqual({ from: "2025-12-01", to: "2026-02-10" });
  });
  it("this year starts on January 1", () => {
    expect(periodRange("this_year", today)).toEqual({ from: "2026-01-01", to: "2026-10-05" });
  });
});

describe("rangeText", () => {
  it("drops the year inside one year and keeps it across two", () => {
    expect(rangeText("2026-10-01", "2026-10-05")).toBe("Oct 1 to Oct 5");
    expect(rangeText("2025-12-01", "2026-01-05")).toBe("Dec 1, 2025 to Jan 5, 2026");
  });
});

describe("pctChange", () => {
  it("is the change against the period before", () => {
    expect(pctChange(1100, 1000)).toBeCloseTo(10);
    expect(pctChange(500, 1000)).toBeCloseTo(-50);
  });
  it("is null when there is nothing before to compare to", () => {
    expect(pctChange(500, 0)).toBeNull();
    expect(pctChange(500, 0.001)).toBeNull();
  });
});

describe("monthLabels", () => {
  it("is just the month inside one year", () => {
    expect(monthLabels(["2026-08", "2026-09"])).toEqual(["Aug", "Sep"]);
  });
  it("adds the year to the first bucket of each year when the series spans two", () => {
    expect(monthLabels(["2025-11", "2025-12", "2026-01", "2026-02"])).toEqual(["Nov 2025", "Dec", "Jan 2026", "Feb"]);
  });
});

describe("dueText", () => {
  it("says how far away the date is", () => {
    expect(dueText("2026-10-08", 3)).toBe("Oct 8, in 3 days");
    expect(dueText("2026-10-06", 1)).toBe("Oct 6, tomorrow");
    expect(dueText("2026-10-05", 0)).toBe("Oct 5, today");
    expect(dueText("2026-10-04", -1)).toBe("Oct 4, yesterday");
    expect(dueText("2026-10-01", -4)).toBe("Oct 1, 4 days ago");
    expect(dueText(null, null)).toBe("No date yet");
  });
});

describe("chipState", () => {
  const today = "2026-10-05";
  const u = (due: string, paid = false) => ({ bill_id: "b", due, amount: 100, paid });
  it("a paid date is paid whatever else is true", () => {
    expect(chipState(u("2026-10-01", true), ["2026-10-01"], today)).toBe("paid");
  });
  it("a date the bill calls overdue is overdue", () => {
    expect(chipState(u("2026-10-01"), ["2026-10-01"], today)).toBe("overdue");
  });
  it("a date inside the due soon window, or just past with the feed behind, is soon", () => {
    expect(chipState(u("2026-10-08"), [], today)).toBe("soon");
    expect(chipState(u("2026-10-04"), [], today)).toBe("soon");
  });
  it("a date further out is plain", () => {
    expect(chipState(u("2026-10-09"), [], today)).toBe("plain");
  });
});

describe("tiles for a bill with no logo", () => {
  it("takes two capitals from the first two words, or two letters of one", () => {
    expect(initials("Oak Street Properties")).toBe("OS");
    expect(initials("insurance")).toBe("IN");
    expect(initials("  ")).toBe("?");
  });
  it("keeps the same tint for a name, one of the six chart tokens", () => {
    const t = tintIndex("Oak Street Properties");
    expect(t).toBe(tintIndex("  oak street properties "));
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(6);
    const spread = new Set(["Rent", "Insurance", "Car note", "Phone", "Power", "Water", "Internet", "Storage"].map(tintIndex));
    expect(spread.size).toBeGreaterThan(2);
  });
});

describe("alertRow", () => {
  const item = (name: string, status: "overdue" | "due_soon") => ({ id: name, name, status, next_due: "2026-10-08", days_until: 3, overdue: [] as string[] });
  const alerts = (items: ReturnType<typeof item>[]): BillsAlerts => ({
    overdue_count: items.filter((i) => i.status === "overdue").length,
    due_soon_count: items.filter((i) => i.status === "due_soon").length,
    items,
  });

  it("is nothing when no bill needs attention", () => {
    expect(alertRow(null)).toBeNull();
    expect(alertRow(alerts([]))).toBeNull();
  });
  it("is red and names the overdue bills first, noting the ones due soon", () => {
    const r = alertRow(alerts([item("Rent", "overdue"), item("Insurance", "overdue"), item("Car note", "due_soon")]))!;
    expect(r.tone).toBe("danger");
    expect(r.title).toBe("2 bills overdue");
    expect(r.sub).toBe("Rent, Insurance, and 1 due soon");
  });
  it("is orange when only due soon, and singular for one", () => {
    const r = alertRow(alerts([item("Car note", "due_soon")]))!;
    expect(r.tone).toBe("warning");
    expect(r.title).toBe("1 bill due soon");
    expect(r.sub).toBe("Car note");
  });
  it("names at most three and says there are more", () => {
    const r = alertRow(alerts(["A", "B", "C", "D"].map((n) => item(n, "overdue"))))!;
    expect(r.sub).toBe("A, B, C…");
  });
});

describe("period pills", () => {
  it("reads a due date with no payment yet as \"Due\", which is true for today, a grace day and three days ahead", () => {
    expect(PERIOD_PILL.due.label).toBe("Due");
  });
});
