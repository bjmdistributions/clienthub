import { describe, it, expect } from "vitest";
import {
  BOOK_ANYWAY_CONFIRM, GATE_BUTTON, GATE_REASON, actualCost, bookGate, firstSection, invoiceWasSent, loadProgress, markupEditable, quoteCostLocked,
  markupPreview, markupProblem, markupStart, markupValue, sectionOfStage, sectionsFor, withDealFacts, type ProgressFacts, type Stage,
} from "./loadProgress";

// The load as it moves through Jack's flow, with invented facts.
const flow = (over: Partial<ProgressFacts> = {}): ProgressFacts => ({
  status: "quoted", quote_amount: 1120, quote_invoiced_at: "", shipping_charge: "", invoice_sent: false, deal_paid: false,
  book_override_at: "", book_override_by: "", picked_up_at: "", delivered_at: "", paid_amount: null, ...over,
});
const states = (s: Stage[]) => s.map((x) => `${x.key}:${x.state}`).join(" ");

describe("loadProgress, the team's eight stages", () => {
  it("names the eight stages in order", () => {
    const s = loadProgress(flow(), true);
    expect(s.map((x) => x.label)).toEqual(["Quote", "On the invoice", "Invoice sent", "Customer paid", "Booked", "Picked up", "Delivered", "Carrier paid"]);
  });

  it("a quote asked is on stage one", () => {
    const s = loadProgress(flow({ status: "quote", quote_amount: null }), true);
    expect(states(s)).toBe("quote:current charge:todo sent:todo paid:todo booked:todo pickup:todo delivery:todo carrier:todo");
  });

  it("a quote that is in makes the shipping charge the current stage", () => {
    const s = loadProgress(flow(), true);
    expect(s[0].state).toBe("done");
    expect(s[1].state).toBe("current");
  });

  it("a quoted load reads Quoted even when the viewer cannot see the amount", () => {
    expect(loadProgress(flow({ quote_amount: null }), true)[0].state).toBe("done");
  });

  it("walks through the invoice, the payment and the booking", () => {
    expect(states(loadProgress(flow({ shipping_charge: "invoice" }), true))).toContain("charge:done sent:current");
    expect(states(loadProgress(flow({ quote_invoiced_at: "2026-10-06T10:00:00Z", invoice_sent: true }), true))).toContain("charge:done sent:done paid:current");
    expect(states(loadProgress(flow({ shipping_charge: "invoice", invoice_sent: true, deal_paid: true }), true))).toContain("paid:done booked:current");
  });

  it("we pay it ourselves relabels the second stage and counts as done", () => {
    const s = loadProgress(flow({ shipping_charge: "own" }), true);
    expect(s[1].label).toBe("We pay it");
    expect(s[1].state).toBe("done");
    expect(loadProgress(flow({ shipping_charge: "invoice" }), true)[1].label).toBe("On the invoice");
  });

  it("an override makes the customer-paid stage done and says who did it", () => {
    const s = loadProgress(flow({ status: "requested", shipping_charge: "invoice", book_override_at: "2026-10-07T09:00:00Z", book_override_by: "Sample sender" }), true);
    expect(s[3].state).toBe("done");
    expect(s[3].note).toBe("Override by Sample sender");
    // The invoice was never sent, and the load is already past it: muted, not missing work.
    expect(s[2].state).toBe("skipped");
  });

  it("sent to book makes Booked the current stage and says logistics has it", () => {
    const s = loadProgress(flow({ status: "requested", shipping_charge: "invoice", invoice_sent: true, deal_paid: true }), true);
    expect(s[4]).toMatchObject({ key: "booked", state: "current", note: "Waiting on logistics" });
    expect(s.filter((x) => x.state === "current")).toHaveLength(1);
  });

  it("booked, picked up and delivered move the current stage along", () => {
    const base = { shipping_charge: "invoice" as const, invoice_sent: true, deal_paid: true };
    expect(states(loadProgress(flow({ ...base, status: "booked" }), true))).toContain("booked:done pickup:current");
    expect(states(loadProgress(flow({ ...base, status: "picked_up" }), true))).toContain("pickup:done delivery:current");
    expect(states(loadProgress(flow({ ...base, status: "delivered" }), true))).toContain("delivery:done carrier:current");
  });

  it("a picked up day or a delivered day counts even when the status has not caught up", () => {
    const base = { shipping_charge: "invoice" as const, invoice_sent: true, deal_paid: true, status: "booked" };
    expect(loadProgress(flow({ ...base, picked_up_at: "2026-10-08" }), true)[5].state).toBe("done");
    expect(loadProgress(flow({ ...base, delivered_at: "2026-10-09" }), true)[6].state).toBe("done");
  });

  it("everything done leaves no current stage", () => {
    const s = loadProgress(flow({ status: "delivered", shipping_charge: "invoice", invoice_sent: true, deal_paid: true, paid_amount: 1000, paid_state: "paid" }), true);
    expect(s.every((x) => x.state === "done")).toBe(true);
  });

  it("a $0 payment is never a paid carrier (R-470)", () => {
    const s = loadProgress(flow({ status: "delivered", paid_amount: 0 }), true);
    expect(s[7].state).toBe("current");
    expect(s[7].note).toBe("Link the bank payment");
  });

  it("Carrier paid is done only when the bank payment is linked (R-470)", () => {
    const base = { status: "delivered", shipping_charge: "invoice" as const, invoice_sent: true, deal_paid: true };
    expect(loadProgress(flow({ ...base, paid_amount: null }), true)[7]).toMatchObject({ state: "current", note: "" });
    expect(loadProgress(flow({ ...base, paid_amount: 850, paid_state: "unpaid" }), true)[7]).toMatchObject({ state: "current", note: "" });
    expect(loadProgress(flow({ ...base, paid_amount: 850, paid_state: "marked" }), true)[7]).toMatchObject({ state: "current", note: "Link the bank payment" });
    expect(loadProgress(flow({ ...base, paid_amount: 850, paid_state: "paid" }), true)[7]).toMatchObject({ state: "done", note: "" });
  });

  it("a typed payment with no link reads as marked when the copy has no paid_state, and linked reads as paid", () => {
    const base = { status: "delivered", shipping_charge: "invoice" as const, invoice_sent: true, deal_paid: true, paid_amount: 850 };
    expect(loadProgress(flow(base), true)[7].state).toBe("current");
    expect(loadProgress(flow({ ...base, bank_linked: "partial" }), true)[7].state).toBe("current");
    expect(loadProgress(flow({ ...base, bank_linked: "linked" }), true)[7].state).toBe("done");
  });

  it("the logistics view shows the same Carrier paid stage", () => {
    const base = { status: "delivered", paid_amount: 850 };
    const last = (st: Stage[]) => st[st.length - 1];
    expect(last(loadProgress(flow({ ...base, paid_state: "marked" }), false))).toMatchObject({ key: "carrier", state: "current", note: "Link the bank payment" });
    expect(last(loadProgress(flow({ ...base, paid_state: "paid" }), false))).toMatchObject({ key: "carrier", state: "done" });
  });

  it("a legacy load past quote with no data shows stages one to four as skipped", () => {
    const s = loadProgress({ status: "booked" }, true);
    expect(states(s)).toBe("quote:skipped charge:skipped sent:skipped paid:skipped booked:done pickup:current delivery:todo carrier:todo");
    const sent = loadProgress({ status: "requested" }, true);
    expect(sent.slice(0, 4).every((x) => x.state === "skipped")).toBe(true);
    expect(sent[4].state).toBe("current");
  });

  it("a cancelled load is not past anything", () => {
    const s = loadProgress({ status: "cancelled" }, true);
    expect(s.filter((x) => x.state === "skipped")).toHaveLength(0);
  });

  it("a load from before this flow that has some data keeps what it has and skips the rest", () => {
    const s = loadProgress({ status: "booked", quote_amount: 900, quote_invoiced_at: "2026-09-01T00:00:00Z" }, true);
    expect(states(s)).toBe("quote:done charge:done sent:skipped paid:skipped booked:done pickup:current delivery:todo carrier:todo");
  });
});

describe("loadProgress, the logistics person's six stages", () => {
  it("folds the invoice and payment into With the team, with no money words", () => {
    const s = loadProgress(flow({ status: "quoted" }), false);
    expect(s.map((x) => x.label)).toEqual(["Quote", "With the team", "Booked", "Picked up", "Delivered", "Carrier paid"]);
    const words = s.map((x) => `${x.label} ${x.note}`).join(" ").toLowerCase();
    for (const w of ["invoice", "paid by", "customer", "override", "pay it"]) expect(words).not.toContain(w);
  });

  it("is on the quote while it is a quote, with the team once quoted", () => {
    expect(states(loadProgress(flow({ status: "quote", quote_amount: null }), false))).toBe("quote:current team:todo booked:todo pickup:todo delivery:todo carrier:todo");
    expect(states(loadProgress(flow({ status: "quoted" }), false))).toBe("quote:done team:current booked:todo pickup:todo delivery:todo carrier:todo");
  });

  it("the team's part is done once the load is sent to book, whatever he can see of the invoice", () => {
    const s = loadProgress({ status: "requested", quote_amount: 1120, invoice_sent: false, deal_paid: false, shipping_charge: "" }, false);
    expect(states(s)).toBe("quote:done team:done booked:current pickup:todo delivery:todo carrier:todo");
    expect(s[2].note).toBe("Waiting on logistics");
  });

  it("an override never shows to him", () => {
    const s = loadProgress(flow({ status: "requested", book_override_at: "2026-10-07T09:00:00Z", book_override_by: "Sample sender" }), false);
    expect(s.map((x) => x.note).join("")).toBe("Waiting on logistics");
  });

  it("a legacy load past quote skips the quote and the team's part", () => {
    expect(states(loadProgress({ status: "booked" }, false))).toBe("quote:skipped team:skipped booked:done pickup:current delivery:todo carrier:todo");
  });
});

describe("the sections", () => {
  it("lists Invoice for the team only", () => {
    expect(sectionsFor(true).map((s) => s.key)).toEqual(["quote", "invoice", "book", "pickup", "delivery", "pay"]);
    expect(sectionsFor(false).map((s) => s.key)).toEqual(["quote", "book", "pickup", "delivery", "pay"]);
  });

  it("maps stages to sections: 1 Quote, 2 to 4 Invoice or Quote, 5 Book, 6 Pickup, 7 Delivery, 8 Pay", () => {
    expect((["quote", "charge", "sent", "paid", "booked", "pickup", "delivery", "carrier"] as const).map((k) => sectionOfStage(k, true)))
      .toEqual(["quote", "invoice", "invoice", "invoice", "book", "pickup", "delivery", "pay"]);
    expect((["quote", "team", "booked", "pickup", "delivery", "carrier"] as const).map((k) => sectionOfStage(k, false)))
      .toEqual(["quote", "quote", "book", "pickup", "delivery", "pay"]);
  });

  it("opens on the current stage's section", () => {
    expect(firstSection(loadProgress(flow({ status: "quote", quote_amount: null }), true), true)).toBe("quote");
    expect(firstSection(loadProgress(flow(), true), true)).toBe("invoice");
    expect(firstSection(loadProgress(flow(), false), false)).toBe("quote");
    expect(firstSection(loadProgress(flow({ status: "requested", shipping_charge: "invoice", invoice_sent: true, deal_paid: true }), true), true)).toBe("book");
    expect(firstSection(loadProgress(flow({ status: "booked", shipping_charge: "own", invoice_sent: true, deal_paid: true }), true), true)).toBe("pickup");
    expect(firstSection(loadProgress(flow({ status: "picked_up", shipping_charge: "own", invoice_sent: true, deal_paid: true }), true), true)).toBe("delivery");
    expect(firstSection(loadProgress(flow({ status: "delivered", shipping_charge: "own", invoice_sent: true, deal_paid: true }), true), true)).toBe("pay");
  });

  it("opens on Pay once everything is done", () => {
    const s = loadProgress(flow({ status: "delivered", shipping_charge: "own", invoice_sent: true, deal_paid: true, paid_amount: 5, paid_state: "paid" }), true);
    expect(firstSection(s, true)).toBe("pay");
  });
});

describe("bookGate, the four things before a load goes to book", () => {
  const ready = flow({ shipping_charge: "invoice", invoice_sent: true, deal_paid: true });

  it("passes when all four are in", () => {
    const g = bookGate(ready);
    expect(g).toMatchObject({ ok: true, missing: [], first: null, reason: "", button: "Send to book", canOverride: false });
  });

  it("names the first thing missing, in the server's order", () => {
    expect(bookGate(flow({ status: "quote", quote_amount: null })).first).toBe("quote");
    expect(bookGate(flow({ status: "quote", quote_amount: null })).reason).toBe("Logistics has not quoted this load yet.");
    expect(bookGate(flow()).first).toBe("charge");
    expect(bookGate(flow()).reason).toBe("Put the quote on the invoice, or mark that you are paying this shipping yourselves.");
    expect(bookGate(flow({ shipping_charge: "own" })).first).toBe("sent");
    expect(bookGate(flow({ shipping_charge: "own" })).reason).toBe("Send the invoice first.");
    expect(bookGate(flow({ shipping_charge: "own", invoice_sent: true })).first).toBe("paid");
    expect(bookGate(flow({ shipping_charge: "own", invoice_sent: true })).reason).toBe("The customer has not paid yet.");
  });

  it("lists everything missing when several are", () => {
    expect(bookGate(flow({ status: "quote", quote_amount: null })).missing).toEqual(["quote", "charge", "sent", "paid"]);
  });

  it("the button says what is missing", () => {
    expect(bookGate(flow({ shipping_charge: "own" })).button).toBe(GATE_BUTTON.sent);
    expect(bookGate(flow({ shipping_charge: "own", invoice_sent: true })).button).toBe(GATE_BUTTON.paid);
  });

  it("a quote or a shipping decision can never be overridden", () => {
    expect(bookGate(flow({ status: "quote", quote_amount: null, shipping_charge: "own", invoice_sent: true, deal_paid: true })).canOverride).toBe(false);
    expect(bookGate(flow({ invoice_sent: true, deal_paid: true })).canOverride).toBe(false);
  });

  it("only the invoice being sent or the customer paying missing can be overridden", () => {
    expect(bookGate(flow({ shipping_charge: "invoice" })).canOverride).toBe(true);
    expect(bookGate(flow({ shipping_charge: "invoice", invoice_sent: true })).canOverride).toBe(true);
    expect(bookGate(flow({ shipping_charge: "invoice", deal_paid: true })).canOverride).toBe(true);
  });

  it("a quote already put on the invoice counts as the shipping decision", () => {
    expect(bookGate(flow({ quote_invoiced_at: "2026-10-06T10:00:00Z", invoice_sent: true, deal_paid: true })).ok).toBe(true);
  });

  it("a load that says Quoted counts as quoted when the amount is hidden", () => {
    expect(bookGate(flow({ quote_amount: null, shipping_charge: "own", invoice_sent: true, deal_paid: true })).ok).toBe(true);
  });

  it("uses the server's sentences and the confirm Jack wrote", () => {
    expect(Object.values(GATE_REASON)).toEqual([
      "Logistics has not quoted this load yet.",
      "Put the quote on the invoice, or mark that you are paying this shipping yourselves.",
      "Send the invoice first.",
      "The customer has not paid yet.",
    ]);
    expect(BOOK_ANYWAY_CONFIRM).toBe("Send this load to book before the invoice is sent and paid?");
  });

  it("uses no em dashes in anything it says", () => {
    const all = [...Object.values(GATE_REASON), ...Object.values(GATE_BUTTON), BOOK_ANYWAY_CONFIRM].join(" ");
    expect(all).not.toContain("\u2014");
  });
});

describe("invoiceWasSent and withDealFacts", () => {
  it("an invoice is sent once it says sent, overdue or paid, or has a sent date", () => {
    expect(invoiceWasSent({ status: "sent", sent_at: null })).toBe(true);
    expect(invoiceWasSent({ status: "overdue", sent_at: null })).toBe(true);
    expect(invoiceWasSent({ status: "paid", sent_at: null })).toBe(true);
    expect(invoiceWasSent({ status: "draft", sent_at: "2026-10-05T12:00:00Z" })).toBe(true);
    expect(invoiceWasSent({ status: "draft", sent_at: null })).toBe(false);
    expect(invoiceWasSent({ status: "draft", sent_at: "  " })).toBe(false);
    expect(invoiceWasSent(null)).toBe(false);
  });

  it("a voided or archived invoice has not been sent", () => {
    expect(invoiceWasSent({ status: "sent", sent_at: "2026-10-05T12:00:00Z", voided: true })).toBe(false);
    expect(invoiceWasSent({ status: "paid", sent_at: null, archived: true })).toBe(false);
    expect(invoiceWasSent({ status: "sent", sent_at: null, voided: false, archived: false })).toBe(true);
  });

  it("what the screen knows about the deal is laid over the load's own flags", () => {
    expect(withDealFacts(flow({ invoice_sent: false, deal_paid: false }), { invoiceSent: true, dealPaid: true })).toMatchObject({ invoice_sent: true, deal_paid: true });
    expect(withDealFacts(flow({ invoice_sent: true, deal_paid: true }), {})).toMatchObject({ invoice_sent: true, deal_paid: true });
  });

  it("a sent invoice or a payment never un-happens: either source saying yes wins", () => {
    expect(withDealFacts(flow({ invoice_sent: true }), { invoiceSent: false }).invoice_sent).toBe(true);
    expect(withDealFacts(flow({ deal_paid: true }), { dealPaid: false }).deal_paid).toBe(true);
    expect(withDealFacts(flow({ invoice_sent: false, deal_paid: false }), { invoiceSent: false, dealPaid: false })).toMatchObject({ invoice_sent: false, deal_paid: false });
  });
});

describe("the markup", () => {
  it("works out the markup and the quote to the cent", () => {
    expect(markupPreview("1000", "12")).toEqual({ markup: 120, quote: 1120 });
    expect(markupPreview("$1,250.50", "10")).toEqual({ markup: 125.05, quote: 1375.55 });
    expect(markupPreview("333.33", "7.5")).toEqual({ markup: 25, quote: 358.33 });
  });

  it("an empty percent is no markup, an empty cost is no preview", () => {
    expect(markupPreview("800", "")).toEqual({ markup: 0, quote: 800 });
    expect(markupPreview("", "12")).toBeNull();
    expect(markupPreview("abc", "12")).toBeNull();
    expect(markupPreview("-5", "12")).toBeNull();
  });

  it("rounds half a cent away from zero the way the server does", () => {
    expect(markupPreview("10.04", "50")).toEqual({ markup: 5.02, quote: 15.06 });
    expect(markupPreview("0.01", "50")).toEqual({ markup: 0.01, quote: 0.02 });
  });

  it("checks the percent is between 0 and 100", () => {
    expect(markupProblem("")).toBeNull();
    expect(markupProblem("0")).toBeNull();
    expect(markupProblem("100")).toBeNull();
    expect(markupProblem("12.5")).toBeNull();
    expect(markupProblem("101")).toBe("The markup must be between 0 and 100.");
    expect(markupProblem("-1")).toBe("The markup must be between 0 and 100.");
    expect(markupProblem("abc")).toBe("The markup must be a number.");
  });

  it("reads the percent as a number, or null for an empty box", () => {
    expect(markupValue("")).toBeNull();
    expect(markupValue(" 12.5% ")).toBe(12.5);
    expect(markupValue("0")).toBe(0);
  });

  it("opens with the load's percent, else the default, else nothing", () => {
    expect(markupStart({ markup_pct: 15, markup_default_pct: 10 })).toBe("15");
    expect(markupStart({ markup_pct: 0, markup_default_pct: 10 })).toBe("0");
    expect(markupStart({ markup_pct: null, markup_default_pct: 10 })).toBe("10");
    expect(markupStart({})).toBe("");
  });

  it("the team always types the percent, logistics only when it is allowed", () => {
    expect(markupEditable(true, { markup_editable: false })).toBe(true);
    expect(markupEditable(false, { markup_editable: false })).toBe(false);
    expect(markupEditable(false, {})).toBe(false);
    expect(markupEditable(false, { markup_editable: true })).toBe(true);
  });

  it("the server's can_set_markup answer comes first", () => {
    expect(markupEditable(true, { can_set_markup: false })).toBe(false);
    expect(markupEditable(false, { can_set_markup: true, markup_editable: false })).toBe(true);
    expect(markupEditable(true, { can_set_markup: true })).toBe(true);
  });

  it("the carrier cost and markup are locked for a non-team person once the load is past quoted", () => {
    expect(quoteCostLocked("quote", false)).toBe(false);
    expect(quoteCostLocked("quoted", false)).toBe(false);
    for (const st of ["requested", "booked", "picked_up", "delivered", "cancelled"]) expect(quoteCostLocked(st, false)).toBe(true);
    for (const st of ["quote", "quoted", "requested", "booked", "delivered"]) expect(quoteCostLocked(st, true)).toBe(false);
  });

  it("the actual cost is the amount paid once it is linked to the bank, else the carrier rate", () => {
    expect(actualCost({ paid_amount: 1040, paid_state: "paid", quoted_cost: 1000 })).toEqual({ amount: 1040, source: "paid" });
    expect(actualCost({ paid_amount: 1040, bank_linked: "linked", quoted_cost: 1000 })).toEqual({ amount: 1040, source: "paid" });
    // R-470: a typed figure, a marked one or a $0 is never the actual cost.
    expect(actualCost({ paid_amount: 0, quoted_cost: 1000 })).toEqual({ amount: 1000, source: "rate" });
    expect(actualCost({ paid_amount: 1040, paid_state: "marked", quoted_cost: 1000 })).toEqual({ amount: 1000, source: "rate" });
    expect(actualCost({ paid_amount: 1040, quoted_cost: null })).toBeNull();
    expect(actualCost({ paid_amount: null, quoted_cost: 1000 })).toEqual({ amount: 1000, source: "rate" });
    expect(actualCost({ paid_amount: null, quoted_cost: null })).toBeNull();
    expect(actualCost({})).toBeNull();
  });
});
