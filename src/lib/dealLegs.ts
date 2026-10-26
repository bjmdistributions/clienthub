// R-555: a deal's money legs as the reconciliation reports them (`legs`), for the colours on a deal and for completion.
// The state is worked out by the backend (`leg_state`, the same rule on the server and the phone); this only reads it.
import { fmtAmount } from "./format";

export type LegState = "linked" | "part" | "missing" | "marked" | "none";
export type LegKey = "buyer" | "supplier" | "shipping";
export interface LegView { state: LegState; expected: number; linked: number; note: string }
export type DealLegs = Record<LegKey, LegView>;

export const LEG_NAME: Record<LegKey, string> = { buyer: "Buyer payment", supplier: "Supplier payment", shipping: "Shipping payment" };

/** The legs still open (something expected, not all of it linked, not marked). The carrier of a deal on Logistics has its
 *  own question on completion (Mark done, or why no carrier is paid), so `carrierOwnGate` leaves it out. */
export function openLegs(legs: DealLegs | null | undefined, carrierOwnGate: boolean): LegKey[] {
  if (!legs) return [];
  return (["buyer", "supplier", "shipping"] as LegKey[])
    .filter((k) => !(k === "shipping" && carrierOwnGate))
    .filter((k) => legs[k] && (legs[k].state === "missing" || legs[k].state === "part"));
}

/** One line for a leg, the way the screens say it. */
export function legLine(k: LegKey, l: LegView): string {
  switch (l.state) {
    case "linked": return `${LEG_NAME[k]}: ${fmtAmount(l.linked)} linked`;
    case "part": return `${LEG_NAME[k]}: ${fmtAmount(l.linked)} of ${fmtAmount(l.expected)} linked, ${fmtAmount(l.expected - l.linked)} missing`;
    case "missing": return `${LEG_NAME[k]} missing: ${fmtAmount(l.expected)} expected, nothing linked`;
    case "marked": return `${LEG_NAME[k]}: no payment recorded${l.note ? `, ${l.note}` : ""}`;
    default: return `${LEG_NAME[k]}: nothing expected`;
  }
}

/** The colour of a leg: red missing, amber part linked, green linked, grey marked or nothing expected. */
export const legTone = (s: LegState): "danger" | "warning" | "success" | "neutral" =>
  s === "missing" ? "danger" : s === "part" ? "warning" : s === "linked" ? "success" : "neutral";
