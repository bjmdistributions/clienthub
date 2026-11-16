import { describe, expect, it } from "vitest";
import { pnlParts } from "./pnlParts";

const transfers = new Set(["internal_transfer", "card_payment", "owner_draw", "owner_contribution", "asset_purchase",
  "cash_in", "cash_out", "loan_received", "loan_repayment"]);
const inTransfers = (c: string) => transfers.has(c);

describe("pnlParts (R-657)", () => {
  it("counts a buyer wire the bank called a transfer as a sale once it is booked", () => {
    expect(pnlParts({ category: "internal_transfer", amount: 10000, links: [{ role: "buyer_payment", amount: 10000 }] }, inTransfers))
      .toEqual([{ category: "receipt", amount: 10000 }]);
  });

  it("moves only the booked part and leaves the rest where the bank put it", () => {
    expect(pnlParts({ category: "internal_transfer", amount: 5000, links: [{ role: "buyer_payment", amount: 3000 }] }, inTransfers))
      .toEqual([{ category: "receipt", amount: 3000 }, { category: "internal_transfer", amount: 2000 }]);
  });

  it("reads each booking role as its category, and a blank row the same way", () => {
    const roles: [string, string][] = [["supplier_payment", "payment"], ["shipping", "shipping"], ["fee", "fee"],
      ["refund_out", "customer_refund"], ["refund_in", "supplier_refund"]];
    for (const [role, cat] of roles) {
      expect(pnlParts({ category: "", amount: 40, links: [{ role, amount: 40 }] }, inTransfers)).toEqual([{ category: cat, amount: 40 }]);
    }
  });

  it("keeps a category a person chose, and an adjustment keeps the row's own", () => {
    expect(pnlParts({ category: "commissions", amount: 500, links: [{ role: "supplier_payment", amount: 500 }] }, inTransfers))
      .toEqual([{ category: "commissions", amount: 500 }]);
    expect(pnlParts({ category: "cash_in", amount: 50, links: [{ role: "adjustment", amount: 50 }] }, inTransfers))
      .toEqual([{ category: "cash_in", amount: 50 }]);
  });

  it("leaves an unbooked transfer alone", () => {
    expect(pnlParts({ category: "internal_transfer", amount: 2000 }, inTransfers)).toEqual([{ category: "internal_transfer", amount: 2000 }]);
  });
});
