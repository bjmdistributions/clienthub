import { describe, expect, it } from "vitest";
import { accountIssue, darkText, luminance } from "./accountLooks";

const fmt = (n: number) => `$${n.toFixed(2)}`;

describe("R-678 account cards", () => {
  it("picks the text that reads on the card", () => {
    expect(darkText("#1C1C1E")).toBe(false);
    expect(darkText("#007AFF")).toBe(false);
    expect(darkText("#FF3B30")).toBe(false);
    expect(darkText("#AEAEB2")).toBe(true);
    expect(darkText("#FFCC00")).toBe(true);
    expect(luminance("not a colour")).toBe(0);
  });

  it("names what is wrong, the connection first", () => {
    expect(accountIssue({ drift: 0 }, fmt)).toBeNull();
    expect(accountIssue({ drift: null }, fmt)).toBeNull();
    expect(accountIssue({ drift: 0.004 }, fmt)).toBeNull();
    expect(accountIssue({ drift: -43.1 }, fmt)).toEqual({ kind: "books", text: "Your books are $43.10 away from what the bank shows." });
    expect(accountIssue({ drift: -43.1, needs_fix: true }, fmt)?.kind).toBe("connection");
  });
});
