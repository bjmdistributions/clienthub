// R-601: "i then need a way to see deals that are missing transactions". The payments a deal should have a bank
// payment linked for by now and does not. The flags come from the server-side reconciliation status (a leg that
// expects money, has nothing linked, and is not marked No payment recorded). A buyer payment counts once the deal
// says it was paid or later, a supplier payment once the deal says the supplier was paid or later, and a paid
// carrier whenever it is not linked. On a completed deal every flagged leg counts.

export type MissingLeg = "buyer" | "supplier" | "shipping";

export interface MissingFlags { buyer_missing?: boolean; supplier_missing?: boolean; shipping_missing?: boolean }

const ORDER = ["invoiced", "payment_received", "supplier_paid", "complete"];

export const LEG_WORD: Record<MissingLeg, string> = {
  buyer: "Buyer payment",
  supplier: "Supplier payment",
  shipping: "Carrier payment",
};

export function missingLegs(stage: string, flags: MissingFlags | null | undefined): MissingLeg[] {
  if (!flags) return [];
  const at = ORDER.indexOf(stage);
  const out: MissingLeg[] = [];
  if (flags.buyer_missing && at >= ORDER.indexOf("payment_received")) out.push("buyer");
  if (flags.supplier_missing && at >= ORDER.indexOf("supplier_paid")) out.push("supplier");
  if (flags.shipping_missing) out.push("shipping");
  return out;
}
