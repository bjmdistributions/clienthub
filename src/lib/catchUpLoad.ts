import type { FreightBookingPatch } from "./api";
import { parseAmount } from "./format";

// R-479: "Already moving". A load the team forgot to send to Logistics, found when it has already been booked,
// picked up or delivered. The sheet sends it in one step at the step it is really at, with `catch_up: true`, and
// the server stamps it as a team-only catch-up. These two functions are the sheet's rules: what is wrong with the
// form, and the body it sends.

export type CatchUpStep = "booked" | "picked_up" | "delivered";

export const CATCH_UP_STEPS: { value: CatchUpStep; label: string }[] = [
  { value: "booked", label: "Booked" },
  { value: "picked_up", label: "Picked up" },
  { value: "delivered", label: "Delivered" },
];

export interface CatchUpForm {
  step: CatchUpStep | "";
  carrier: string;
  /** The saved carrier picked from the directory, "" for a name that was only typed. */
  carrierId: string;
  /** Raw text, as typed. */
  cost: string;
  /** Raw text. Starts at 0. */
  markup: string;
  /** The day for the step: the pickup day for Booked (optional), the day it was picked up or delivered otherwise. */
  day: string;
  /** "We pay the shipping ourselves": the customer is not charged for it. */
  own: boolean;
}

export const blankCatchUp = (): CatchUpForm => ({ step: "", carrier: "", carrierId: "", cost: "", markup: "0", day: "", own: false });

/** The word before the day field for a step. */
export const dayLabel = (step: CatchUpStep | ""): string =>
  step === "picked_up" ? "Picked up on" : step === "delivered" ? "Delivered on" : "Pickup day (optional)";

/** What is missing or wrong, in the words shown under the sheet, or "" when the form can be sent.
 *  `today` is the local day, YYYY-MM-DD. */
export function catchUpProblem(f: CatchUpForm, today: string): string {
  if (!f.step) return "Choose the step the load is at.";
  if (!f.carrier.trim()) return "Pick the carrier.";
  if (!(parseAmount(f.cost) > 0)) return "Add the carrier cost.";
  const pct = f.markup.trim() === "" ? 0 : parseAmount(f.markup, NaN);
  if (!Number.isFinite(pct) || pct < 0) return "The markup is a percent of zero or more.";
  if (f.step !== "booked") {
    if (!f.day) return f.step === "picked_up" ? "Add the day it was picked up." : "Add the day it was delivered.";
    if (f.day > today) return "That day has not happened yet.";
  }
  return "";
}

/** The part of the create body the "Already moving" mode adds. The places, freight and note go in beside it.
 *  Call `catchUpProblem` first: an empty step has no body. */
export function catchUpFields(f: CatchUpForm): FreightBookingPatch {
  if (!f.step) throw new Error("Choose the step the load is at.");
  const day = f.day.trim();
  return {
    catch_up: true,
    status: f.step,
    carrier: f.carrier.trim(),
    ...(f.carrierId ? { carrier_id: f.carrierId } : {}),
    quote_cost: parseAmount(f.cost),
    // Blank means 0, the same as the box it starts at: the server must never fall back to the org's default here.
    markup_pct: f.markup.trim() === "" ? 0 : parseAmount(f.markup),
    ...(f.own ? { shipping_charge: "own" as const } : {}),
    // The day also moves the deal's own dates.
    ...(f.step === "booked" && day ? { pickup_date: day } : {}),
    ...(f.step === "picked_up" ? { picked_up_at: day, pickup_date: day } : {}),
    ...(f.step === "delivered" ? { delivered_at: day, delivery_date: day } : {}),
  };
}
