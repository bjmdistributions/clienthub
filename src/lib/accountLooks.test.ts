import { describe, expect, it } from "vitest";
import { accountCheck, autoFinish, CARD_FINISHES, darkText, finishFor, luminance, needsALook } from "./accountLooks";

describe("R-678 account cards", () => {
  it("picks the text that reads on the card", () => {
    expect(darkText("#1C1C1E")).toBe(false);
    expect(darkText("#007AFF")).toBe(false);
    expect(darkText("#FF3B30")).toBe(false);
    expect(darkText("#AEAEB2")).toBe(true);
    expect(darkText("#FFCC00")).toBe(true);
    expect(luminance("not a colour")).toBe(0);
  });

  it("R-688: an account's row says what the automatic check found, and is red only when he has something to do", () => {
    const a = (over: object) => ({ type: "depository", drift: 0 as number | null, ...over });
    expect(accountCheck(a({}), 0, false, false)).toEqual({ kind: "match" });
    expect(accountCheck(a({ drift: 0.004 }), 0, false, false)).toEqual({ kind: "match" });
    // Off and not checked in this state: it is being checked, with no click.
    expect(accountCheck(a({ drift: -150, checked: false }), 0, false, false)).toEqual({ kind: "checking" });
    expect(accountCheck(a({ drift: -150, checked: false }), 0, true, false)).toEqual({ kind: "checking" });
    // Checked, and these transactions are left for him.
    expect(accountCheck(a({ drift: -150, checked: true }), 2, false, true)).toEqual({ kind: "answer", count: 2 });
    expect(accountCheck(a({ drift: 0, checked: true }), 1, false, true)).toEqual({ kind: "answer", count: 1 });
    // Checked, nothing left, the bank's balance still behind: nothing for him to do, so not red.
    expect(accountCheck(a({ drift: -150, checked: true }), 0, false, true)).toEqual({ kind: "waiting" });
    // The bank could not be read this time.
    expect(accountCheck(a({ drift: -150, checked: false }), 0, false, true)).toEqual({ kind: "unread" });
    expect(accountCheck(a({ drift: -150, needs_fix: true }), 3, false, false)).toEqual({ kind: "connection" });
    expect(accountCheck(a({ drift: null, checked_on: "Mac" }), 0, false, false)).toEqual({ kind: "elsewhere", on: "Mac" });
    expect(accountCheck(a({ type: "loan", drift: null }), 0, false, false)).toEqual({ kind: "none" });
    expect(["match", "checking", "waiting", "unread", "elsewhere", "none"].every((k) => !needsALook({ kind: k } as never))).toBe(true);
    expect(needsALook({ kind: "answer", count: 1 }) && needsALook({ kind: "connection" })).toBe(true);
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
