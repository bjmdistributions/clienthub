import { describe, expect, it } from "vitest";
import { categoryName, isMovement, monthsOf, summarize } from "./personalSpend";
import type { PersonalTxn } from "./api";

let n = 0;
const t = (posted_at: string, amount: number, direction: "in" | "out", category: string, merchant = "Test Place"): PersonalTxn => ({
  id: `k.btpl_${++n}`, account_key: "test bank|9999", account: "Card ··9999", posted_at, amount, direction,
  description: merchant.toUpperCase(), merchant, category, pending: false,
});

describe("R-660 personal spending", () => {
  const txns = [
    t("2026-11-02", 40, "out", "FOOD_AND_DRINK", "Test Diner"),
    t("2026-11-03", 25.5, "out", "FOOD_AND_DRINK", "Test Diner"),
    t("2026-11-05", 120, "out", "GENERAL_MERCHANDISE", "Test Store"),
    t("2026-11-06", 20, "in", "GENERAL_MERCHANDISE", "Test Store"), // a return
    t("2026-11-07", 500, "in", "LOAN_PAYMENTS", "Card payment"), // paying the card: moved, not counted
    t("2026-11-08", 1500, "in", "INCOME", "Paycheck"),
    t("2026-10-30", 99, "out", "TRAVEL", "Test Air"),
  ];

  it("adds a month up, a return off its group, transfers and card payments apart", () => {
    const s = summarize(txns, "2026-11");
    expect(s.spent).toBe(165.5);
    expect(s.income).toBe(1500);
    expect(s.moved).toBe(500);
    expect(s.byCategory.map((g) => [g.name, g.amount])).toEqual([["Shopping", 100], ["Food and drink", 65.5]]);
    expect(s.byPlace[0]).toMatchObject({ name: "Test Store", amount: 100, count: 2 });
    expect(s.byPlace[1]).toMatchObject({ name: "Test Diner", amount: 65.5, count: 2 });
    expect(s.rows).toHaveLength(6);
  });

  it("lists months newest first and names groups in plain words", () => {
    expect(monthsOf(txns)).toEqual(["2026-11", "2026-10"]);
    expect(categoryName("RENT_AND_UTILITIES")).toBe("Rent and utilities");
    expect(categoryName("SOMETHING_NEW")).toBe("Something new");
    expect(categoryName("")).toBe("Other");
    expect(isMovement("TRANSFER_OUT") && !isMovement("TRAVEL")).toBe(true);
  });

  it("an empty month is all zeros", () => {
    const s = summarize(txns, "2026-09");
    expect([s.spent, s.income, s.byCategory.length, s.rows.length]).toEqual([0, 0, 0, 0]);
  });
});
