// R-657: money booked to a deal is that deal's money whatever the bank called it. Plaid files any wire or Zelle it
// calls a transfer as `internal_transfer`, and booking never changes a row's category, so a booked buyer or supplier
// wire was left out of the Tax report's net income. Where a row's category is blank or in the Transfers group, the
// part booked to a deal counts under its booking's category and only the rest keeps the row's own. Any other
// category is the row's whole story, as before. Mirrors `pnl_rows` in commands.rs and the server's routes/bank.rs.

/** A deal booking's role, read as the category it stands for. `adjustment` has none and keeps the row's own. */
export const PNL_ROLE_CATEGORY: Record<string, string> = {
  buyer_payment: "receipt",
  supplier_payment: "payment",
  shipping: "shipping",
  fee: "fee",
  refund_out: "customer_refund",
  refund_in: "supplier_refund",
};

/** The row's amount split by the category each part counts under in the P&L. Parts of 0 are left out. */
export function pnlParts(
  t: { category?: string | null; amount: number; links?: { role: string; amount: number }[] },
  inTransfers: (category: string) => boolean,
): { category: string; amount: number }[] {
  const own = t.category || "";
  if (own !== "" && !inTransfers(own)) return [{ category: own, amount: t.amount }];
  const parts: { category: string; amount: number }[] = [];
  let rest = t.amount;
  for (const l of t.links ?? []) {
    const cat = PNL_ROLE_CATEGORY[l.role];
    if (!cat) continue;
    parts.push({ category: cat, amount: l.amount });
    rest -= l.amount;
  }
  if (Math.abs(rest) > 0.004) parts.push({ category: own, amount: rest });
  return parts;
}
