// FD-05: what a one-tap "Looks like" tie on Financials books, and whether it books the row.
// A supplier or shipping leg is one cut of a deal, so it takes at most that leg. A buyer payment
// takes at most the invoice's outstanding balance too (the leg), so a wire that covers two
// invoices cannot land whole on the first; the exception is a remainder within 50 cents over
// the leg, which is a rounding or fee difference and is tied whole.
//
// A buyer tie with no usable candidate leg (the offline matcher offers chips with no candidate,
// and a settled candidate carries leg 0) is capped at the deal's invoice total instead, the
// upper bound the deal in hand gives. Only when neither is known is there nothing to cap by and
// the whole remainder is tied.

/** A buyer remainder this many cents over the leg is still tied whole. */
const TIE_OVER_CENTS = 50;

export interface TieAmount {
  /** The amount to allocate. */
  amount: number;
  /** The tie accounts for the whole remainder, so the row may be booked (R-204). */
  book: boolean;
}

export function tieAmount(
  role: string,
  unallocated: number,
  legAmount?: number | null,
  invoiceTotal?: number | null,
): TieAmount {
  let leg = legAmount ?? 0;
  if (!(leg > 0) && role === "buyer_payment") leg = invoiceTotal ?? 0;
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

/**
 * The row already holds a buyer payment on this deal. A capped tie leaves the rest of the wire
 * on the row, and the suggestions fetched before the tie still name that deal, so a second tap
 * would put a second payment on an invoice the first already covered. Only the buyer role is
 * guarded: an invoice is paid once by a wire, while a deal can have several supplier legs and
 * each is its own tie.
 */
export function alreadyTied(
  links: { deal_id: string; role: string }[] | undefined,
  dealId: string,
  role: string,
): boolean {
  return role === "buyer_payment" && (links ?? []).some((l) => l.deal_id === dealId && l.role === role);
}
