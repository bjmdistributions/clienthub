import { describe, it, expect } from "vitest";
import {
  SECTIONS, dayText, describeDeal, nextDay, payFactsOf, sectionOf, shippingLine, stillNeededLine,
  type DealCtx, type DealSection, type DealShipFacts, type PayFacts,
} from "./dealSections";
import table from "./dealSections.cases.json";

// R-486: invented deals. The case table (dealSections.cases.json) is the one the website's dfSectionOf, dfShippingLine and
// dfStillNeededLine are tested against too, case for case. Today in the table is 2026-10-09.

interface Want { section: DealSection; shipping: { text: string; tone: string; late: string }; needed: { text: string; tone: string } | null }
interface Case { name: string; deal?: DealShipFacts; ctx?: Record<string, boolean>; row?: Record<string, unknown> | null; want: Want }
const CASES = table.cases as unknown as Case[];
const TODAY = table.today;

/** The defaults merged under a case, as the table's "about" describes. */
function build(c: Case): { deal: DealShipFacts; ctx: DealCtx } {
  const d = table.defaults as unknown as { deal: DealShipFacts; ctx: Record<string, boolean>; row: Record<string, unknown> };
  const deal = { ...d.deal, ...c.deal };
  const cx = { ...d.ctx, ...c.ctx };
  let row: Record<string, unknown> | null = null;
  if (c.row !== null) {
    row = { ...d.row, ...c.row };
    for (const k of Object.keys(row)) if (row[k] === null) delete row[k];
  }
  return { deal, ctx: { delivered: cx.delivered, today: TODAY, numbers: cx.numbers, pay: payFactsOf(row, cx.markedPaid, cx.numbers) } };
}

describe("the shared case table", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const { deal, ctx } = build(c);
      expect(sectionOf(deal, ctx)).toBe(c.want.section);
      const ship = shippingLine(deal, ctx);
      expect({ text: ship.text, tone: ship.tone, late: ship.parts.filter((p) => p.tone === "danger").map((p) => p.text).join("") }).toEqual(c.want.shipping);
      const needed = stillNeededLine(deal, ctx);
      expect(needed ? { text: needed.text, tone: needed.tone } : null).toEqual(c.want.needed);
      // The parts are the sentence, in order.
      expect(ship.parts.map((p) => p.text).join("")).toBe(ship.text);
    });
  }
  it("covers every section the screen shows", () => {
    const seen = new Set(CASES.map((c) => c.want.section));
    for (const s of SECTIONS) expect(seen.has(s.key)).toBe(true);
  });
  it("uses no em dash and no emoji in anything it shows", () => {
    for (const c of CASES) {
      const shown = [c.want.shipping.text, c.want.needed?.text ?? ""].join(" ");
      expect(shown).not.toMatch(/\u2014|\u2013/);
      expect(shown).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("SECTIONS", () => {
  it("names the six sections in the order they are shown", () => {
    expect(SECTIONS.map((s) => s.key)).toEqual(["ready", "paymentMissing", "onTheWay", "waitingPickup", "withLogistics", "notSetUp"]);
    expect(SECTIONS.map((s) => s.title)).toEqual([
      "Ready to complete", "Delivered, payment still missing", "On the way", "Waiting on pickup", "With Logistics", "Shipping not set up",
    ]);
  });
});

describe("describeDeal", () => {
  it("is the section and the two lines", () => {
    const { deal, ctx } = build(CASES[3]);
    const d = describeDeal(deal, ctx);
    expect(d.section).toBe("paymentMissing");
    expect(d.shipping.text).toBe("Delivered Oct 8");
    expect(d.needed?.text).toBe("Still needed: buyer payment $5,100");
  });
});

const paid: PayFacts = { buyerDue: false, supplierDue: false, costMissing: false, supplierKept: false, buyerLeft: null, supplierLeft: null };
const ctxOf = (over: Partial<DealCtx> = {}): DealCtx => ({ delivered: false, today: TODAY, numbers: true, pay: paid, ...over });

describe("the section a deal is in", () => {
  it("a deal is never called ready when its payment row has not arrived", () => {
    expect(sectionOf({ ships_direct: true }, ctxOf({ pay: null }))).toBe("paymentMissing");
  });
  it("the first match wins: delivered, then direct, then the load, then the dates", () => {
    expect(sectionOf({ logistics_stage: "booked" }, ctxOf({ delivered: true }))).toBe("ready");
    expect(sectionOf({ logistics_stage: "quote", pickup_date: "2026-10-01" }, ctxOf())).toBe("withLogistics");
    expect(sectionOf({ logistics_stage: "picked_up", expected_delivery_date: "2026-10-20" }, ctxOf())).toBe("onTheWay");
    expect(sectionOf({ logistics_stage: "requested", pickup_date: "2026-10-01" }, ctxOf())).toBe("waitingPickup");
  });
  it("a load outranks the deal's own dates, even when the deal's date has passed", () => {
    // The completion gate does not read loads, but a live load is what the deal is waiting on.
    expect(sectionOf({ logistics_stage: "booked", expected_delivery_date: "2026-10-01" }, ctxOf())).toBe("waitingPickup");
  });
  it("reads an older response with no live count or day fields", () => {
    expect(sectionOf({ logistics_stage: "booked" }, ctxOf())).toBe("waitingPickup");
    expect(shippingLine({ logistics_stage: "booked" }, { delivered: false, today: TODAY, numbers: true }).text).toBe("Booked");
    expect(shippingLine({}, { delivered: false, today: TODAY, numbers: true }).text).toBe("No shipping set up");
  });
  it("one delivered load of several does not finish the deal while another has not moved", () => {
    const booked = { logistics_stage: "booked", logistics_carrier: "Swift", logistics_pickup_day: "2026-10-13", logistics_live_count: 2 };
    const c = ctxOf({ delivered: true });
    expect(sectionOf(booked, c)).toBe("waitingPickup");
    expect(shippingLine(booked, c).text).toBe("Booked with Swift, pickup Oct 13 (1 of 2 loads)");
    expect(sectionOf({ ...booked, logistics_stage: "picked_up" }, c)).toBe("onTheWay");
    // One load, or every load delivered, is finished by the carrier's word.
    expect(sectionOf({ ...booked, logistics_live_count: 1 }, c)).toBe("ready");
    expect(sectionOf({ ...booked, logistics_stage: "delivered" }, c)).toBe("ready");
    // Ships direct is done whatever the loads say.
    expect(sectionOf({ ...booked, ships_direct: true }, c)).toBe("ready");
  });
  it("keeps every deal in exactly one section", () => {
    const deals: DealShipFacts[] = [
      {}, { ships_direct: true }, { logistics_stage: "quote" }, { logistics_stage: "quoted" }, { logistics_stage: "requested" },
      { logistics_stage: "booked" }, { logistics_stage: "picked_up" }, { logistics_stage: "delivered" },
      { pickup_date: "2026-10-01" }, { pickup_date: "2026-10-09" }, { pickup_date: "2026-10-20" }, { expected_delivery_date: "2026-10-01" },
      { expected_delivery_date: "2026-10-20" }, { pickup_date: "2026-10-01", expected_delivery_date: "2026-10-20" },
    ];
    for (const d of deals) for (const pay of [null, paid, { ...paid, buyerDue: true }]) {
      expect(SECTIONS.map((s) => s.key)).toContain(sectionOf(d, ctxOf({ pay })));
    }
  });
});

describe("payFactsOf", () => {
  const row = { buyer_target: 10000, buyer_paired: 4000, buyer_left: 6000, supplier_target: 7000, supplier_paired: 7000, supplier_left: 0, supplier_paid_paired: true, cost_kept: false, no_buyer_link: false, no_supplier_link: false };
  it("is null for a missing row, and for a row with neither the flags nor the six figures", () => {
    expect(payFactsOf(null, false, true)).toBeNull();
    expect(payFactsOf(undefined, false, true)).toBeNull();
    expect(payFactsOf({ deal_flow_id: "d" }, false, true)).toBeNull();
    expect(payFactsOf({ buyer_left: 5 }, false, true)).toBeNull();
  });
  it("reads the flags first, so a viewer whose figures were zeroed still sees what is due", () => {
    const p = payFactsOf({ buyer_target: 0, buyer_paired: 0, buyer_left: 0, supplier_target: 0, supplier_paired: 0, supplier_left: 0, buyer_due: true, supplier_due: false, supplier_cost_missing: false }, false, false);
    expect(p).toEqual({ buyerDue: true, supplierDue: false, costMissing: false, supplierKept: false, buyerLeft: null, supplierLeft: null });
  });
  it("reads an older row from the figures, with the amounts for a viewer who may see numbers", () => {
    expect(payFactsOf(row, false, true)).toEqual({ buyerDue: true, supplierDue: false, costMissing: false, supplierKept: false, buyerLeft: 6000, supplierLeft: null });
    expect(payFactsOf(row, false, false)).toEqual({ buyerDue: true, supplierDue: false, costMissing: false, supplierKept: false, buyerLeft: null, supplierLeft: null });
  });
  it("a buyer marked paid is not due, and an amount is shown only when something is due", () => {
    expect(payFactsOf(row, true, true)).toMatchObject({ buyerDue: false, buyerLeft: null });
  });
  it("the flags beat the figures when both are there", () => {
    expect(payFactsOf({ ...row, buyer_due: false, supplier_due: false, supplier_cost_missing: false }, false, true)?.buyerDue).toBe(false);
  });
  it("the kept flag is read ahead of the figures, so a viewer without numbers is told the cost was kept", () => {
    const zeroed = { buyer_target: 0, buyer_paired: 0, buyer_left: 0, supplier_target: 0, supplier_paired: 0, supplier_left: 0, buyer_due: false, supplier_due: false, supplier_cost_missing: false };
    expect(payFactsOf({ ...zeroed, supplier_kept: true }, false, false)?.supplierKept).toBe(true);
    expect(payFactsOf({ ...zeroed, supplier_kept: false }, false, false)?.supplierKept).toBe(false);
    // Kept never outranks something still owed or missing.
    expect(payFactsOf({ ...zeroed, supplier_kept: true, supplier_due: true }, false, false)?.supplierKept).toBe(false);
    expect(payFactsOf({ ...zeroed, supplier_kept: true, supplier_cost_missing: true }, false, false)?.supplierKept).toBe(false);
    // The flag wins over the figures when both are there.
    expect(payFactsOf({ ...row, buyer_left: 0, supplier_target: 0, supplier_paired: 0, supplier_left: 0, cost_kept: true, supplier_kept: false }, false, true)?.supplierKept).toBe(false);
  });
  it("a cost that was all kept reads as kept only for a viewer who sees the figures", () => {
    const kept = { ...row, buyer_left: 0, buyer_paired: 10000, supplier_target: 0, supplier_paired: 0, supplier_left: 0, supplier_paid_paired: false, cost_kept: true };
    expect(payFactsOf(kept, false, true)?.supplierKept).toBe(true);
    expect(payFactsOf(kept, false, false)?.supplierKept).toBe(false);
    // One line kept and another paid is not "kept, nothing to pay".
    expect(payFactsOf({ ...kept, supplier_target: 3000, supplier_paired: 3000 }, false, true)?.supplierKept).toBe(false);
  });
});

describe("the shipping line", () => {
  const ctx = { delivered: false, today: TODAY, numbers: true };
  it("names a quote with its amount only for someone who may see numbers", () => {
    const f = { logistics_stage: "quoted", logistics_quote: 1240.5, logistics_live_count: 1 };
    expect(shippingLine(f, ctx).text).toBe("Quoted $1,240.50, not booked yet");
    expect(shippingLine(f, { ...ctx, numbers: false }).text).toBe("Quoted, not booked yet");
    expect(shippingLine({ ...f, logistics_quote: 0 }, ctx).text).toBe("Quoted, not booked yet");
  });
  it("puts the late part in the danger tone and the rest in muted", () => {
    const l = shippingLine({ logistics_stage: "booked", logistics_carrier: "Swift", logistics_pickup_day: "2026-10-06", logistics_live_count: 2 }, ctx);
    expect(l.tone).toBe("danger");
    expect(l.parts).toEqual([
      { text: "Booked with Swift, ", tone: "muted" }, { text: "pickup was due Oct 6", tone: "danger" }, { text: " (1 of 2 loads)", tone: "muted" },
    ]);
  });
  it("a line with nothing late is muted all the way", () => {
    expect(shippingLine({ logistics_stage: "booked", logistics_pickup_day: "2026-10-13" }, ctx).tone).toBe("muted");
  });
  it("a delivery date that has passed on a deal with no load is in the danger tone, as a load's date is", () => {
    const l = shippingLine({ expected_delivery_date: "2026-10-01" }, ctx);
    expect(l.tone).toBe("danger");
    expect(l.parts).toEqual([{ text: "Delivery was due Oct 1", tone: "danger" }]);
    // Today, and a pickup that has passed, are not late.
    expect(shippingLine({ expected_delivery_date: TODAY }, ctx).tone).toBe("muted");
    expect(shippingLine({ pickup_date: "2026-10-01" }, ctx).tone).toBe("muted");
  });
  it("dayText writes the month and day", () => {
    expect(dayText("2026-10-07")).toBe("Oct 7");
    expect(dayText("2026-01-31T10:00:00Z")).toBe("Jan 31");
    expect(dayText("not a day")).toBe("not a day");
  });
});

describe("the still-needed line", () => {
  it("does not say press Complete when the completion gate would hold the deal", () => {
    const done = { logistics_stage: "delivered", logistics_live_count: 1 };
    expect(stillNeededLine({ ...done, expected_delivery_date: "2026-10-12" }, ctxOf())?.text)
      .toBe("Everything is in. Completing needs an override, delivery is dated Oct 12.");
    expect(stillNeededLine({ ...done, pickup_date: "2026-10-12" }, ctxOf())?.text)
      .toBe("Everything is in. Completing needs an override, pickup is dated Oct 12.");
    // The delivery date is the gate's basis when both are set, so a passed one clears it.
    expect(stillNeededLine({ ...done, expected_delivery_date: "2026-10-09", pickup_date: "2026-10-15" }, ctxOf())?.text).toBe("Everything is in. Open it and press Complete.");
    expect(stillNeededLine({ ...done, ships_direct: true, expected_delivery_date: "2026-10-12" }, ctxOf())?.text).toBe("Everything is in. Open it and press Complete.");
  });
  it("lists the buyer, then the supplier, then the cost, then shipping", () => {
    const pay: PayFacts = { buyerDue: true, supplierDue: true, costMissing: true, supplierKept: false, buyerLeft: 100, supplierLeft: 50 };
    expect(stillNeededLine({}, ctxOf({ pay }))?.text).toBe("Still needed: buyer payment $100, supplier payment $50, supplier cost, shipping");
  });
  it("without numbers it names the payment and leaves the amount out", () => {
    const pay: PayFacts = { buyerDue: true, supplierDue: true, costMissing: false, supplierKept: false, buyerLeft: null, supplierLeft: null };
    expect(stillNeededLine({ logistics_stage: "booked" }, ctxOf({ numbers: false, pay }))?.text).toBe("Still needed: buyer payment, supplier payment");
  });
});

describe("nextDay", () => {
  it("is the earliest of the deal's dates still ahead, else the last one (overdue)", () => {
    expect(nextDay({ pickup_date: "2026-10-12", expected_delivery_date: "2026-10-20" }, TODAY)).toBe("2026-10-12");
    expect(nextDay({ pickup_date: "2026-10-01", expected_delivery_date: "2026-10-20" }, TODAY)).toBe("2026-10-20");
    expect(nextDay({ pickup_date: "2026-10-01", expected_delivery_date: "2026-10-05" }, TODAY)).toBe("2026-10-05");
    expect(nextDay({ pickup_date: "2026-10-09" }, TODAY)).toBe("2026-10-09");
    expect(nextDay({}, TODAY)).toBe("");
    expect(nextDay({ pickup_date: "2026-10-12", ships_direct: true }, TODAY)).toBe("");
  });
  it("a booked or requested load goes by its own pickup day, even a late one", () => {
    expect(nextDay({ logistics_stage: "booked", logistics_pickup_day: "2026-10-06", expected_delivery_date: "2026-10-20" }, TODAY)).toBe("2026-10-06");
    expect(nextDay({ logistics_stage: "requested", logistics_pickup_day: "2026-10-13" }, TODAY)).toBe("2026-10-13");
  });
  it("a load on the road goes by its delivery day", () => {
    expect(nextDay({ logistics_stage: "picked_up", logistics_delivery_day: "2026-10-11", pickup_date: "2026-10-07" }, TODAY)).toBe("2026-10-11");
    // No delivery day on the load: the deal's own dates decide.
    expect(nextDay({ logistics_stage: "picked_up", expected_delivery_date: "2026-10-15" }, TODAY)).toBe("2026-10-15");
  });
});
