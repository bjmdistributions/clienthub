import { describe, expect, it } from "vitest";
import { emailedLine, inReach, saidLine, spread, stageOf, type Lead } from "./outreach";

// R-581: the Cold calls rules this screen keeps for itself. Everything else (emailed, replied, no reply, texted,
// what they said) the server works out; these only read it.

const lead = (o: Partial<Lead> = {}): Lead => ({
  id: "a", company: "Test Co", contact_name: "", email: "", phone: "", city: "", state: "", kind: "", website: "",
  status: "new", next_touch: "", last_touch_at: "", personal_line: "", notes: "", source: "", supplier_id: "", ...o,
});

describe("Cold calls lists and the map", () => {
  it("colours a pin by how far it got, a stop and a supplier first", () => {
    expect(stageOf(lead())).toBe("not_emailed");
    expect(stageOf(lead({ emailed: true }))).toBe("emailed");
    expect(stageOf(lead({ emailed: true, replied: true, status: "talking" }))).toBe("replied");
    expect(stageOf(lead({ replied: true, status: "supplier" }))).toBe("supplier");
    expect(stageOf(lead({ replied: true, status: "do_not_contact" }))).toBe("stop");
    // R-607: queued and not gone yet has its own colour, so a stalled queue is seen on the map.
    expect(stageOf(lead({ queued: 1 }))).toBe("waiting");
    expect(stageOf(lead({ queued: 1, emailed: true }))).toBe("emailed");
  });

  it("lists the ones that failed to send (R-606)", () => {
    expect(inReach(lead({ failed: 1, failed_error: "535 bad login" }), "failed")).toBe(true);
    expect(inReach(lead(), "failed")).toBe(false);
  });

  it("filters by what the server worked out", () => {
    const l = lead({ emailed: true, no_reply: true });
    expect([inReach(l, "emailed"), inReach(l, "not_emailed"), inReach(l, "no_reply"), inReach(l, "texted"), inReach(l, "all")]).toEqual([true, false, true, false, true]);
    expect(inReach(lead({ texted: { at: "2026-11-04T15:00:00Z", by: "Dana" } }), "texted")).toBe(true);
  });

  it("says what they said, else the last call or note", () => {
    expect(saidLine(null)).toBe("");
    expect(saidLine({ kind: "reply", outcome: "", text: "We have 6 pallets.", tags: ["stock"], at: "", by: "" })).toBe("They said: We have 6 pallets.");
    expect(saidLine({ kind: "call", outcome: "voicemail", text: "Ask for Dana", tags: [], at: "", by: "" })).toBe("Call: Left a voicemail. Ask for Dana");
    expect(saidLine({ kind: "call", outcome: "no_answer", text: "", tags: [], at: "", by: "" })).toBe("Call: No answer");
  });

  it("says when the first email went", () => {
    expect(emailedLine(lead())).toBe("Not emailed");
    expect(emailedLine(lead({ emailed: true }))).toBe("Emailed");
    expect(emailedLine(lead({ emailed: true, first_email_at: "2026-10-20T15:00:00Z" }))).toBe("Emailed Oct 20");
  });

  it("spreads the pins of one city so each can be clicked, and leaves a lone pin where it is", () => {
    const pins = spread([
      { id: "a", lat: 40.5, lng: -74.4, place: "city" }, { id: "b", lat: 40.5, lng: -74.4, place: "city" }, { id: "c", lat: 41, lng: -75, place: "street" },
    ]);
    expect(pins[0]).toMatchObject({ lat: 40.5, lng: -74.4 });
    expect(pins[1].lat === 40.5 && pins[1].lng === -74.4).toBe(false);
    expect(Math.hypot(pins[1].lat - 40.5, pins[1].lng + 74.4)).toBeLessThan(0.03);
    expect(pins[2]).toMatchObject({ lat: 41, lng: -75 });
  });
});
