// FD-05: what a one-tap "Looks like" tie on Financials books, and whether it books the row.
// A supplier or shipping leg is one cut of a deal, so it takes at most that leg. A buyer payment
// takes at most the invoice's outstanding balance too (the leg), so a wire that covers two
// invoices cannot land whole on the first; the exception is a remainder within 50 cents over
// the leg, which is a rounding or fee difference and is tied whole. No candidate, or a leg of 0,
// means nothing to cap by and the whole remainder is tied.

/** A buyer remainder this many cents over the leg is still tied whole. */
const TIE_OVER_CENTS = 50;

export interface TieAmount {
  /** The amount to allocate. */
  amount: number;
  /** The tie accounts for the whole remainder, so the row may be booked (R-204). */
  book: boolean;
}

export function tieAmount(role: string, unallocated: number, legAmount?: number | null): TieAmount {
  const leg = legAmount ?? 0;
  let amount = unallocated;
  if (leg > 0) {
    if (role === "supplier_payment" || role === "shipping") {
      amount = Math.min(unallocated, leg);
    } else if (role === "buyer_payment" && Math.round((unallocated - leg) * 100) > TIE_OVER_CENTS) {
      amount = leg;
    }
  }
  return { amount, book: amount + 0.005 >= unallocated };
}
