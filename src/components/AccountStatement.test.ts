import { describe, expect, it } from "vitest";
import { parseMoney, statementDays } from "./AccountStatement";
import type { StatementLine, StatementPoint } from "../lib/api";

const line = (id: string, date: string, amount: number, direction: string, balance: number): StatementLine =>
  ({ id, date, description: id, amount, direction, balance });

describe("parseMoney", () => {
  it("reads what a person copies off a bank's site", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney(" 40 ")).toBe(40);
    expect(parseMoney("-40.10")).toBe(-40.1);
    expect(parseMoney("($40.10)")).toBe(-40.1);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("about forty")).toBeNull();
  });
});

describe("statementDays", () => {
  const lines = [
    line("fuel", "2026-03-12", 60.05, "out", 790.05),
    line("sale", "2026-03-09", 250.1, "in", 850.1),
    line("fee", "2026-03-09", 5, "out", 600),
    line("rent", "2026-03-05", 400, "out", 605),
  ];
  const points: StatementPoint[] = [
    { date: "2026-03-09", bank: 850.1, books: 850.1, gap: 0, source: "you" },
    { date: "2026-03-07", bank: 605, books: 605, gap: 0, source: "statement" },
  ];

  it("groups by day, newest first, and gives a checked day with no transaction its own line", () => {
    const days = statementDays(lines, points, () => true, false);
    expect(days.map((d) => d.date)).toEqual(["2026-03-12", "2026-03-09", "2026-03-07", "2026-03-05"]);
    expect(days[1].end).toBe(850.1);
    expect(days[1].point?.source).toBe("you");
    expect(days[2].lines).toEqual([]);
    expect(days[2].end).toBe(605);
  });

  it("keeps the real end of day balance when a filter hides the day's last transaction", () => {
    const days = statementDays(lines, points, (l) => l.id === "fee", true);
    expect(days.map((d) => d.date)).toEqual(["2026-03-09"]);
    expect(days[0].end).toBe(850.1);
    expect(days[0].lines.map((l) => l.id)).toEqual(["fee"]);
  });
});
