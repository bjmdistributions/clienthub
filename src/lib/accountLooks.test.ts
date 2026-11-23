import { describe, expect, it } from "vitest";
import { accountIssue, autoFinish, CARD_FINISHES, darkText, finishFor, luminance } from "./accountLooks";

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

  it("R-683: picks a card's finish from its name", () => {
    const id = (n: string) => autoFinish(n)?.id ?? null;
    expect(id("Business Platinum Card")).toBe("platinum");
    expect(id("Business Gold Card")).toBe("gold");
    expect(id("Rose Gold Rewards")).toBe("rose-gold");
    expect(id("Ink Business Cash")).toBe("sapphire");
    expect(id("Blue Business Plus")).toBe("sapphire");
    expect(id("Spark Cash Plus")).toBe("titanium");
    expect(id("Business Green Rewards")).toBe("emerald");
    expect(id("The Plum Card")).toBe("plum");
    expect(id("Business Rewards")).toBeNull();
    expect(id("Pink Drink Card")).toBeNull();
    expect(id("Credit Card")).toBeNull();
  });

  it("R-683: his choice wins, plain and unknown ids are his own colour", () => {
    expect(finishFor("gold", "Business Platinum Card")?.id).toBe("gold");
    expect(finishFor("plain", "Business Platinum Card")).toBeNull();
    expect(finishFor("from-a-newer-version", "Business Platinum Card")).toBeNull();
    expect(finishFor(undefined, "Business Platinum Card")?.id).toBe("platinum");
    expect(new Set(CARD_FINISHES.map((f) => f.id)).size).toBe(CARD_FINISHES.length);
    expect(CARD_FINISHES.every((f) => /^[a-z-]{1,24}$/.test(f.id))).toBe(true);
  });
});
