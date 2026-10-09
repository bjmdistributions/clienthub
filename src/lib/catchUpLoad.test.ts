import { describe, it, expect } from "vitest";
import { CATCH_UP_STEPS, blankCatchUp, catchUpFields, catchUpProblem, dayLabel, type CatchUpForm } from "./catchUpLoad";

// R-479: the "Already moving" sheet's rules. Invented carrier and numbers.
const today = "2026-10-08";
const form = (over: Partial<CatchUpForm> = {}): CatchUpForm => ({
  step: "picked_up", carrier: "Sample Freight Lines", carrierId: "car_1", cost: "1,200", markup: "0", day: "2026-10-06", own: false, ...over,
});

describe("catchUpProblem", () => {
  it("passes a complete form at each of the three steps", () => {
    expect(catchUpProblem(form({ step: "booked", day: "" }), today)).toBe("");
    expect(catchUpProblem(form({ step: "picked_up" }), today)).toBe("");
    expect(catchUpProblem(form({ step: "delivered" }), today)).toBe("");
  });
  it("needs a step, a carrier and a carrier cost, in that order", () => {
    expect(catchUpProblem(blankCatchUp(), today)).toBe("Choose the step the load is at.");
    expect(catchUpProblem(form({ carrier: "  " }), today)).toBe("Pick the carrier.");
    expect(catchUpProblem(form({ cost: "" }), today)).toBe("Add the carrier cost.");
    expect(catchUpProblem(form({ cost: "0" }), today)).toBe("Add the carrier cost.");
  });
  it("needs the day for picked up and delivered, and not in the future", () => {
    expect(catchUpProblem(form({ step: "picked_up", day: "" }), today)).toBe("Add the day it was picked up.");
    expect(catchUpProblem(form({ step: "delivered", day: "" }), today)).toBe("Add the day it was delivered.");
    expect(catchUpProblem(form({ step: "delivered", day: "2026-10-09" }), today)).toBe("That day has not happened yet.");
    expect(catchUpProblem(form({ step: "delivered", day: today }), today)).toBe("");
  });
  it("lets a booked load name a pickup day in the future, or none", () => {
    expect(catchUpProblem(form({ step: "booked", day: "2026-10-20" }), today)).toBe("");
  });
  it("takes a markup of zero or more, blank as zero", () => {
    expect(catchUpProblem(form({ markup: "" }), today)).toBe("");
    expect(catchUpProblem(form({ markup: "12.5" }), today)).toBe("");
    expect(catchUpProblem(form({ markup: "-1" }), today)).toBe("The markup is a percent of zero or more.");
    expect(catchUpProblem(form({ markup: "abc" }), today)).toBe("The markup is a percent of zero or more.");
  });
});

describe("catchUpFields", () => {
  it("starts the markup at 0 and sends it, so the server never falls back to the default", () => {
    expect(blankCatchUp().markup).toBe("0");
    expect(catchUpFields(form()).markup_pct).toBe(0);
    expect(catchUpFields(form({ markup: "" })).markup_pct).toBe(0);
    expect(catchUpFields(form({ markup: "12.5" })).markup_pct).toBe(12.5);
  });
  it("picked up: the status, the day it was picked up and the deal's pickup date", () => {
    expect(catchUpFields(form())).toEqual({
      catch_up: true, status: "picked_up", carrier: "Sample Freight Lines", carrier_id: "car_1",
      quote_cost: 1200, markup_pct: 0, picked_up_at: "2026-10-06", pickup_date: "2026-10-06",
    });
  });
  it("delivered: the day it landed and the deal's delivery date", () => {
    const f = catchUpFields(form({ step: "delivered", day: "2026-10-07" }));
    expect(f).toMatchObject({ status: "delivered", delivered_at: "2026-10-07", delivery_date: "2026-10-07" });
    expect(f).not.toHaveProperty("picked_up_at");
  });
  it("booked: the pickup day only when one was given", () => {
    expect(catchUpFields(form({ step: "booked", day: "" }))).not.toHaveProperty("pickup_date");
    expect(catchUpFields(form({ step: "booked", day: "2026-10-12" })).pickup_date).toBe("2026-10-12");
    expect(catchUpFields(form({ step: "booked", day: "2026-10-12" }))).not.toHaveProperty("picked_up_at");
  });
  it("sends shipping_charge own only when ticked, and carrier_id only when a saved carrier was picked", () => {
    expect(catchUpFields(form())).not.toHaveProperty("shipping_charge");
    expect(catchUpFields(form({ own: true })).shipping_charge).toBe("own");
    expect(catchUpFields(form({ carrierId: "" }))).not.toHaveProperty("carrier_id");
  });
  it("has no body without a step", () => {
    expect(() => catchUpFields(blankCatchUp())).toThrow();
  });
});

describe("labels", () => {
  it("names the three steps and the day for each", () => {
    expect(CATCH_UP_STEPS.map((s) => s.label)).toEqual(["Booked", "Picked up", "Delivered"]);
    expect(dayLabel("picked_up")).toBe("Picked up on");
    expect(dayLabel("delivered")).toBe("Delivered on");
    expect(dayLabel("booked")).toBe("Pickup day (optional)");
  });
});
