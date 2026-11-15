import { describe, expect, it } from "vitest";
import type { FreightPlace } from "./api";
import { applyPlace, blankSendForm, formFromDraft, isBlank, placeInUse, sendGaps } from "./sendForm";

// R-651: invented places and values.
const place = (over: Partial<FreightPlace>): FreightPlace => ({
  source: "load", load_number: "", day: "", name: "", address: "", phone: "", window: "", bol_to: "", notes: "", equipment: "", accessorials: "", ...over,
});

const whole = () => ({
  ...blankSendForm(),
  pickup_name: "Sunrise Test Supply", pickup_address: "9 Depot Rd, Reno, NV 89501", pickup_phone: "555-000-0001", pickup_date: "2026-11-20",
  pickup_window: "8:00 am to 2:00 pm", bol_to: "dock@test.example",
  delivery_name: "Test Buyer", delivery_address: "12 Test Way, Testville, TX 75001", delivery_phone: "555-000-0002", delivery_date: "2026-11-24",
  equipment: "Dry van 53", pallets: "6", weight_lbs: "900", dimensions: "48 x 40 x 50",
});

describe("sendGaps", () => {
  it("lists each box still needed under its section, the freight only while the team fills it in", () => {
    const g = sendGaps(blankSendForm(), true);
    expect(g.filter((x) => x.section === "pickup").map((x) => x.label)).toEqual(
      ["Pickup name", "Pickup address", "Pickup phone", "Pickup day", "Pickup time", "Who gets the BOL"]);
    expect(g.filter((x) => x.section === "delivery").map((x) => x.label)).toEqual(
      ["Delivery name", "Delivery address", "Delivery phone", "Delivery day"]);
    expect(g.filter((x) => x.section === "freight").map((x) => x.label)).toEqual(["Equipment", "Pallets", "Weight", "Pallet dimensions"]);
    expect(sendGaps(blankSendForm(), false).some((x) => x.key === "pallets")).toBe(false);
    expect(sendGaps(whole(), true)).toEqual([]);
  });

  it("counts what is typed but would be refused", () => {
    const f = { ...whole(), bol_to: "dock", pickup_address: "9 Depot Rd, Reno", extra_pickups: [{ name: "Second Test Supply", address: "", phone: "", window: "" }] };
    expect(sendGaps(f, true).map((x) => [x.key, x.label])).toEqual([
      ["bol_to", "A BOL email address"], ["pickup_address", "The full pickup address"], ["stop:0", "The address of pickup 2"],
    ]);
  });
});

describe("a draft", () => {
  it("reads back only the form's own keys, each as the form holds it", () => {
    const f = formFromDraft({ pickup_name: "Sunrise Test Supply", pallets: 6, urgent: true, junk: "x", extra_pickups: [{ name: "B", address: 3 }] });
    expect(f.pickup_name).toBe("Sunrise Test Supply");
    expect(f.pallets).toBe("6");
    expect(f.urgent).toBe(true);
    expect(f.extra_pickups).toEqual([{ name: "B", address: "3", phone: "", window: "" }]);
    expect("junk" in f).toBe(false);
    expect(isBlank(formFromDraft({}))).toBe(true);
    expect(formFromDraft(JSON.parse(JSON.stringify(whole())))).toEqual(whole());
  });
});

describe("filling from a place", () => {
  it("writes the name and address, and each detail the place carries over what is there", () => {
    const f = { ...blankSendForm(), pickup_phone: "555-999-9999", bol_to: "me@test.example" };
    const out = applyPlace(f, "pickup", place({ name: "Sunrise Test Supply", address: "44 Other St, Reno, NV 89501", window: "before 4 pm" }));
    expect([out.pickup_name, out.pickup_address, out.pickup_phone, out.pickup_window, out.bol_to])
      .toEqual(["Sunrise Test Supply", "44 Other St, Reno, NV 89501", "555-999-9999", "before 4 pm", "me@test.example"]);
    expect(placeInUse(out, "pickup", place({ name: "sunrise test supply", address: "44 Other St Reno NV 89501" }))).toBe(true);
  });

  it("brings a delivery's truck details only into empty boxes", () => {
    const p = place({ name: "Test Buyer Dock 3", address: "70 Dock Rd, Testville, TX 75002", notes: "Call 15 minutes out", equipment: "Dry van 53", accessorials: "Liftgate" });
    const out = applyPlace({ ...blankSendForm(), equipment: "Flatbed" }, "delivery", p);
    expect([out.delivery_notes, out.equipment, out.accessorials]).toEqual(["Call 15 minutes out", "Flatbed", "Liftgate"]);
  });

  it("fills an extra pickup by its index", () => {
    const f = { ...blankSendForm(), extra_pickups: [{ name: "", address: "", phone: "", window: "" }, { name: "x", address: "", phone: "", window: "" }] };
    const out = applyPlace(f, 1, place({ name: "Second Test Supply", address: "5 Side St, Sparks, NV 89431", phone: "555-111-2222" }));
    expect(out.extra_pickups[1]).toEqual({ name: "Second Test Supply", address: "5 Side St, Sparks, NV 89431", phone: "555-111-2222", window: "" });
    expect(out.extra_pickups[0].name).toBe("");
  });
});
