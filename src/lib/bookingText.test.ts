import { describe, it, expect } from "vitest";
import { bolNote, bookingText, sendMissing, type SendFields } from "./bookingText";
import table from "./bookingText.cases.json";

// R-558: the case table is the one the website's lgBookingText and lgSendMissing are checked against.

describe("the booking message", () => {
  for (const c of table.text) {
    it(c.name, () => {
      expect(bookingText(c.load as Parameters<typeof bookingText>[0])).toBe(c.text);
    });
  }
});

describe("what Send to logistics needs", () => {
  for (const c of table.send) {
    it(c.name, () => {
      expect(sendMissing(c.form as SendFields, c.byTeam)).toBe(c.says);
    });
  }
  it("keeps the BOL email as the pickup note, in Jack's words", () => {
    expect(bolNote(" dock@example.com ")).toBe("Send BOL to: dock@example.com with me in copy");
  });
});
