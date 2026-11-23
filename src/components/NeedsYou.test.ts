import { describe, expect, it } from "vitest";
import { needsYou } from "./NeedsYou";
import { checkSentence, fixedSentence, statusLines } from "./BooksStatus";
import type { BankDeclined, NearDupPair, NearDupRow, RetractedRow } from "../lib/api";

const row = (id: string, extra: Partial<NearDupRow> = {}): NearDupRow => ({
  id, account: "Checking ··1111", date: "2026-10-01", amount: 80, direction: "out", description: "FUEL STOP",
  source: "plaid", pending: false, category: "", booked: false, counterparty: "", links: [], ...extra,
});
const taken = (id: string, extra: Partial<RetractedRow> = {}): RetractedRow => ({
  id, date: "2026-10-01", amount: 50, direction: "out", description: "GRILL", account: "Card ··2222", category: "meals",
  booked: true, cancelled: false, matches: [], ...extra,
});
const held = (id: string, reason: BankDeclined["reason"], extra: Partial<BankDeclined> = {}): BankDeclined => ({
  id, txn_id: id, source: "plaid", reason, account_id: "Checking ··1111", posted_at: "2026-10-03", amount: 310, direction: "out",
  description: "CITY UTILITIES", matched: [], bank: {}, status: "open", resolved_by: "", resolved_at: "", created_at: "", ...extra,
});
const posted = (id: string, blocked: string | null = null) =>
  ({ id, date: "2026-10-03", amount: 55, description: "GRILL", category: "", booked: false, automatic: false, blocked });

describe("needsYou", () => {
  it("asks one question per thing, with at most two answers unless there are several posted charges to pick from", () => {
    const pairs: NearDupPair[] = [{ keep: row("a"), extra: row("b"), reason: "different_text", gap_days: 2, automatic: false }];
    const items = needsYou(pairs, [taken("r1", { matches: [posted("p1")] }), taken("r2", { cancelled: true })],
      [held("d1", "differs", { bank: { ledger: { posted_at: "2026-10-02", amount: 300, direction: "out", description: "CITY UTIL" }, amount: 310 } }), held("d2", "not_at_bank")]);
    expect(items.map((i) => i.question)).toEqual([
      "Is the posted charge the same payment?", "Your bank cancelled this charge", "One payment or two?",
      "Your bank shows this one differently", "Your books have this and your bank does not list it",
    ]);
    expect(items.every((i) => i.answers.length <= 2)).toBe(true);
    expect(items[0].answers.map((a) => a.id)).toEqual(["swap:p1", "not:p1"]);
    expect(items[2].answers.map((a) => a.label)).toEqual(["One payment", "Two payments"]);
    expect(items[3].lines.map((l) => l.tag)).toEqual(["Your books", "Your bank"]);
    // Taking a transaction off the books is always a second click.
    expect(items[1].answers[0].confirm).toBe(true);
    expect(items[4].answers[0].confirm).toBe(true);
  });

  it("leaves out what needs nothing from a person", () => {
    // Waiting for the bank's posted copy, and a row already answered.
    expect(needsYou([], [taken("r1")], [held("d1", "missing", { status: "kept" })])).toEqual([]);
  });

  it("says why when the booking cannot move yet, and does not offer the move", () => {
    const [item] = needsYou([], [taken("r1", { matches: [posted("p1", "The two copies pay different bills.")] })], []);
    expect(item.answers.map((a) => a.id)).toEqual(["not:p1"]);
    expect(item.blocked).toBe("The two copies pay different bills.");
  });

  it("words a transaction he removed himself as his own call", () => {
    const [item] = needsYou([], [], [held("d1", "missing", { bank: { removed_before: true } })]);
    expect(item.question).toBe("You removed this and your bank still lists it");
    expect(item.answers.map((a) => a.label)).toEqual(["Bring it back", "Leave it out"]);
  });
});

describe("the books status strip", () => {
  it("names each thing that needs a person and where it is answered", () => {
    expect(statusLines(0, 0, 0, 0)).toEqual([]);
    expect(statusLines(1, 2, 1, 3).map((l) => l.go)).toEqual(["setup", "needs", "tobook"]);
    // An account that is off with nothing to answer points at the accounts.
    expect(statusLines(0, 0, 1, 0).map((l) => l.go)).toEqual(["accounts"]);
  });

  it("says what the last check did in one sentence, or nothing", () => {
    expect(fixedSentence(undefined)).toBe("");
    expect(fixedSentence({ imported: 0, amended: 0, removed: 0, moved: 0, two_payments: 0, copies: 0, agreed: 2 })).toBe("");
    expect(fixedSentence({ imported: 1, amended: 0, removed: 0, moved: 0, two_payments: 0, copies: 0, agreed: 0 })).toBe("The last check brought in 1 transaction.");
    expect(fixedSentence({ imported: 3, amended: 0, removed: 1, moved: 2, two_payments: 0, copies: 1, agreed: 0 }))
      .toBe("The last check brought in 3 transactions, removed 2 copies and moved 2 bookings to the posted charge.");
  });
});

describe("R-687 what a Check against bank run says", () => {
  const none = { imported: 0, amended: 0, removed: 0, moved: 0, two_payments: 0, copies: 0, agreed: 0 };
  it("says it checked everything and that nothing differs", () => {
    expect(checkSentence({ fixed: none, missing: 0, differs: 0, not_at_bank: 0, errors: [] }))
      .toBe("Checked every posted transaction your banks list. Nothing had to change. Every one is in your books.");
  });
  it("says what it put right and what is left for him, with where", () => {
    expect(checkSentence({ fixed: { ...none, imported: 3, removed: 1 }, missing: 1, differs: 1, not_at_bank: 0, errors: [] }))
      .toBe("Checked every posted transaction your banks list. It brought in 3 transactions and removed 1 copy. 2 transactions still differ from the bank: answer them under Needs you.");
    expect(checkSentence({ fixed: none, missing: 0, differs: 0, not_at_bank: 1, errors: [] }))
      .toBe("Checked every posted transaction your banks list. Nothing could be put right without you. 1 transaction still differs from the bank: answer it under Needs you.");
  });
  it("names a bank it could not read", () => {
    expect(checkSentence({ fixed: none, missing: 0, differs: 0, not_at_bank: 0, errors: [{ institution: "Example Bank", error: "x" }] }))
      .toContain("Example Bank could not be read, so it was not checked.");
  });
});
