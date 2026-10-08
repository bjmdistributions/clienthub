import { describe, it, expect } from "vitest";
import type { FreightBooking } from "./api";
import {
  EQUIPMENT, GROUPS, LOAD_STEPS, QUOTE_WAITING_WARNING, STATUS_ORDER,
  dayAndTime, dealPaid, dueLabel, dueTone, equipmentOptions, fileKind, firstStep, fmtDayLabel, groupOf, isHot, isLiveTruck,
  isTime, laneLabel, laneOf, loadHaystack, loadNumber, missingPaperwork, needsAmount, paidMethodWord, paidStateOf, paidView, paperworkOf, pickStatus, statusAllowed, confirmToSend,
  pickupNumberUnconfirmed, quoteWaitingOnInvoice, statusAfterActual, statusWord, stepDone, timeWord,
} from "./logisticsLoad";

// An invented load: every key a row carries, so a rule is tested on the whole shape.
const mk = (over: Partial<FreightBooking> = {}): FreightBooking => ({
  id: "b1", code: "L-ab12cd", status: "requested", booked_at: "", request_note: "",
  pickup_name: "", pickup_address: "", pickup_date: "", pickup_window: "", pickup_contact: "", pickup_phone: "", pickup_notes: "",
  delivery_name: "", delivery_address: "", delivery_date: "", delivery_window: "", delivery_contact: "", delivery_phone: "", delivery_notes: "", delivered_at: "",
  carrier: "", broker: "", service: "", equipment: "", bol: "", pro: "", pickup_number: "", reference: "", tracking_url: "",
  driver_name: "", driver_phone: "", truck_number: "", trailer_number: "",
  pallets: "", pieces: "", weight_lbs: "", freight_class: "", dimensions: "", commodity: "", accessorials: "",
  quoted_cost: null, paid_amount: null, paid_at: "", paid_method: "", paid_note: "", notes: "",
  created_by_name: "", updated_by_name: "", created_at: "", updated_at: "",
  can_see_names: true, can_see_addresses: true, can_see_deal: true, tracking: null, deal: null,
  ...over,
});

describe("statuses", () => {
  it("has the seven statuses in order", () => {
    expect(STATUS_ORDER).toEqual(["quote", "quoted", "requested", "booked", "picked_up", "delivered", "cancelled"]);
  });
  it("labels a quote differently for the team and for logistics", () => {
    expect(statusWord("quote")).toBe("Quote asked");
    expect(statusWord("quote", true)).toBe("Quote needed");
    expect(statusWord("picked_up")).toBe("On the way");
    expect(statusWord("requested", true)).toBe("To book");
  });
  it("never counts a quote or a cancelled load as a truck", () => {
    expect(isLiveTruck({ status: "quote" })).toBe(false);
    expect(isLiveTruck({ status: "quoted" })).toBe(false);
    expect(isLiveTruck({ status: "cancelled" })).toBe(false);
    expect(isLiveTruck({ status: "requested" })).toBe(true);
    expect(isLiveTruck({ status: "booked", archived: 1 })).toBe(false);
  });
  it("quotes the load number, else the short code", () => {
    expect(loadNumber({ load_number: "LD-0012", code: "L-ab12cd" })).toBe("LD-0012");
    expect(loadNumber({ load_number: "", code: "L-ab12cd" })).toBe("L-ab12cd");
    expect(loadNumber({ code: "L-ab12cd" })).toBe("L-ab12cd");
  });
});

describe("equipment", () => {
  it("lists all eighteen options", () => {
    expect(EQUIPMENT).toHaveLength(18);
    expect(EQUIPMENT[0]).toBe("Dry van 53 ft");
    expect(EQUIPMENT[EQUIPMENT.length - 1]).toBe("Other");
  });
  it("keeps a stored value that is not on the list as an extra option", () => {
    expect(equipmentOptions("Reefer")).toBe(EQUIPMENT);
    expect(equipmentOptions("")).toBe(EQUIPMENT);
    expect(equipmentOptions("53 ft dry van")).toEqual([...EQUIPMENT, "53 ft dry van"]);
  });
});

describe("files and paperwork", () => {
  it("reads a missing kind as other", () => {
    expect(fileKind({})).toBe("other");
    expect(fileKind({ kind: "pod" })).toBe("pod");
  });
  it("derives the paperwork from the files when the server sent none", () => {
    const f = (kind?: "bol" | "pod" | "carrier_invoice" | "other") => ({ id: "1", name: "a.pdf", mime: "application/pdf", size: 1, by: "", at: "", kind });
    expect(paperworkOf({ files: [f("bol"), f(), f("carrier_invoice")] })).toEqual({ bol: true, pod: false, carrier_invoice: true });
    expect(paperworkOf({ paperwork: { bol: false, pod: true, carrier_invoice: false }, files: [f("bol")] }).pod).toBe(true);
  });
});

describe("days, times and due labels", () => {
  const now = new Date(2026, 9, 6);
  it("writes a day without the year until it is another year", () => {
    expect(fmtDayLabel("2026-10-03", now)).toBe("Oct 3");
    expect(fmtDayLabel("2025-12-30", now)).toBe("Dec 30, 2025");
    expect(fmtDayLabel("", now)).toBe("");
  });
  it("accepts only a 24 hour wall clock", () => {
    expect(isTime("")).toBe(true);
    expect(isTime("08:05")).toBe(true);
    expect(isTime("23:59")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("8:05")).toBe(false);
    expect(isTime("12:60")).toBe(false);
  });
  it("says a time the way people do", () => {
    expect(timeWord("00:15")).toBe("12:15 am");
    expect(timeWord("12:00")).toBe("12:00 pm");
    expect(timeWord("14:30")).toBe("2:30 pm");
    expect(timeWord("")).toBe("");
    expect(dayAndTime("2026-10-07", "09:00", now)).toBe("Oct 7, 9:00 am");
    expect(dayAndTime("", "09:00", now)).toBe("9:00 am");
  });
  it("labels when a carrier is due, the same four ways everywhere", () => {
    expect(dueLabel("2026-10-06", "2026-10-06", now)).toBe("Due today");
    expect(dueLabel("2026-10-03", "2026-10-06", now)).toBe("Overdue since Oct 3");
    expect(dueLabel("2026-10-10", "2026-10-06", now)).toBe("Due Oct 10");
    expect(dueLabel("", "2026-10-06", now)).toBe("No due date");
    expect(dueLabel(undefined, "2026-10-06", now)).toBe("No due date");
  });
  it("tones a due date by how close it is", () => {
    expect(dueTone("2026-10-03", "2026-10-06")).toBe("danger");
    expect(dueTone("2026-10-06", "2026-10-06")).toBe("danger");
    expect(dueTone("2026-10-12", "2026-10-06")).toBe("warning");
    expect(dueTone("2026-10-30", "2026-10-06")).toBe("neutral");
    expect(dueTone("", "2026-10-06")).toBe("neutral");
  });
});

describe("the actual dates move the status", () => {
  const blank = { delivered_at: "", picked_up_at: "", picked_up_time: "" };
  it("a pickup day moves To book and Booked to On the way", () => {
    expect(statusAfterActual("requested", "picked_up_at", "2026-10-06")).toBe("picked_up");
    expect(statusAfterActual("booked", "picked_up_at", "2026-10-06")).toBe("picked_up");
  });
  it("a pickup day leaves a quote, a delivered load and a cancelled one alone", () => {
    expect(statusAfterActual("quote", "picked_up_at", "2026-10-06")).toBe("quote");
    expect(statusAfterActual("delivered", "picked_up_at", "2026-10-06")).toBe("delivered");
    expect(statusAfterActual("cancelled", "picked_up_at", "2026-10-06")).toBe("cancelled");
  });
  it("clearing a day steps the status back, and only when it was resting on that day", () => {
    expect(statusAfterActual("picked_up", "picked_up_at", "")).toBe("booked");
    expect(statusAfterActual("delivered", "delivered_at", "", "2026-10-06")).toBe("picked_up");
    expect(statusAfterActual("delivered", "delivered_at", "")).toBe("booked");
    expect(statusAfterActual("booked", "picked_up_at", "")).toBe("booked");
    expect(statusAfterActual("delivered", "picked_up_at", "")).toBe("delivered");
  });
  it("a delivered day moves anything but Cancelled to Delivered", () => {
    expect(statusAfterActual("picked_up", "delivered_at", "2026-10-08")).toBe("delivered");
    expect(statusAfterActual("booked", "delivered_at", "2026-10-08")).toBe("delivered");
    expect(statusAfterActual("cancelled", "delivered_at", "2026-10-08")).toBe("cancelled");
  });
  it("picking Delivered fills today, picking On the way fills the pickup day", () => {
    expect(pickStatus(blank, "delivered", "2026-10-06")).toMatchObject({ status: "delivered", delivered_at: "2026-10-06" });
    expect(pickStatus({ ...blank, delivered_at: "2026-10-05" }, "delivered", "2026-10-06").delivered_at).toBe("2026-10-05");
    expect(pickStatus(blank, "picked_up", "2026-10-06")).toMatchObject({ status: "picked_up", picked_up_at: "2026-10-06" });
  });
  it("going back to To book or Booked clears what was picked up and delivered", () => {
    const was = { delivered_at: "2026-10-08", picked_up_at: "2026-10-06", picked_up_time: "09:30" };
    expect(pickStatus(was, "booked", "2026-10-09")).toEqual({ status: "booked", delivered_at: "", picked_up_at: "", picked_up_time: "" });
    expect(pickStatus(was, "requested", "2026-10-09").picked_up_at).toBe("");
    expect(pickStatus(was, "picked_up", "2026-10-09")).toMatchObject({ picked_up_at: "2026-10-06", delivered_at: "" });
  });
  it("leaves the days alone for a quote or a cancel", () => {
    const was = { delivered_at: "2026-10-08", picked_up_at: "2026-10-06", picked_up_time: "09:30" };
    expect(pickStatus(was, "cancelled", "2026-10-09")).toEqual({ ...was, status: "cancelled" });
    expect(pickStatus(was, "quote", "2026-10-09")).toEqual({ ...was, status: "quote" });
  });
});

describe("the stepper", () => {
  it("has the five steps", () => {
    expect(LOAD_STEPS.map((s) => s.label)).toEqual(["Quote", "Book", "Pickup", "Delivery", "Pay"]);
  });
  it("opens on the step the status points at", () => {
    expect(firstStep("quote")).toBe("quote");
    expect(firstStep("quoted")).toBe("quote");
    expect(firstStep("requested")).toBe("book");
    expect(firstStep("booked")).toBe("pickup");
    expect(firstStep("picked_up")).toBe("delivery");
    expect(firstStep("delivered")).toBe("pay");
    expect(firstStep("cancelled")).toBe("quote");
  });
  const none = { bol: false, pod: false, carrier_invoice: false };
  const facts = { status: "requested", carrier: "", picked_up_at: "", delivered_at: "", paid_amount: null, paperwork: none };
  it("marks Quote done once quoted, or once quoting was skipped", () => {
    expect(stepDone({ ...facts, status: "quote" }).quote).toBe(false);
    expect(stepDone({ ...facts, status: "quoted" }).quote).toBe(true);
    expect(stepDone({ ...facts, status: "requested" }).quote).toBe(true);
    expect(stepDone({ ...facts, status: "cancelled" }).quote).toBe(false);
  });
  it("marks Book done only once booked and a carrier is set", () => {
    expect(stepDone({ ...facts, status: "booked" }).book).toBe(false);
    expect(stepDone({ ...facts, status: "booked", carrier: "Northline Freight" }).book).toBe(true);
    expect(stepDone({ ...facts, status: "requested", carrier: "Northline Freight" }).book).toBe(false);
  });
  it("marks Pickup and Delivery by their actual days", () => {
    const d = stepDone({ ...facts, picked_up_at: "2026-10-06", delivered_at: "" });
    expect(d.pickup).toBe(true);
    expect(d.delivery).toBe(false);
    expect(stepDone({ ...facts, delivered_at: "2026-10-08" }).delivery).toBe(true);
  });
  it("marks Pay done only when the bank payment is linked and every paperwork kind is in", () => {
    const all = { bol: true, pod: true, carrier_invoice: true };
    expect(stepDone({ ...facts, paid_amount: 1500, paid_state: "paid", paperwork: all }).pay).toBe(true);
    expect(stepDone({ ...facts, paid_amount: 1500, paid_state: "paid", paperwork: { ...all, pod: false } }).pay).toBe(false);
    expect(stepDone({ ...facts, paid_amount: null, paperwork: all }).pay).toBe(false);
    // R-470: a payment somebody typed (or a $0) is not a paid load.
    expect(stepDone({ ...facts, paid_amount: 0, paperwork: all }).pay).toBe(false);
    expect(stepDone({ ...facts, paid_amount: 1500, paid_state: "marked", paperwork: all }).pay).toBe(false);
    expect(stepDone({ ...facts, paid_amount: 1500, bank_linked: "linked", paperwork: all }).pay).toBe(true);
  });
});

describe("the pickup number check", () => {
  const today = "2026-10-06";
  const booked = { status: "booked", pickup_date: "2026-10-06", pickup_number_confirmed_at: "" };
  it("flags a booked load picking up today or tomorrow with no confirmation", () => {
    expect(pickupNumberUnconfirmed(booked, today)).toBe(true);
    expect(pickupNumberUnconfirmed({ ...booked, pickup_date: "2026-10-07" }, today)).toBe(true);
  });
  it("ignores a later pickup, an earlier one, a load that is not booked and a confirmed one", () => {
    expect(pickupNumberUnconfirmed({ ...booked, pickup_date: "2026-10-08" }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...booked, pickup_date: "2026-10-05" }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...booked, pickup_date: "" }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...booked, status: "requested" }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...booked, status: "picked_up" }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...booked, pickup_number_confirmed_at: "2026-10-05" }, today)).toBe(false);
  });
  it("rolls over a month end for tomorrow", () => {
    expect(pickupNumberUnconfirmed({ ...booked, pickup_date: "2026-11-01" }, "2026-10-31")).toBe(true);
  });
  it("flags a later stop that has a pickup number nobody confirmed", () => {
    const ok = { ...booked, pickup_number_confirmed_at: "2026-10-05" };
    const stop = (x: object) => ({ name: "", address: "", window: "", contact: "", phone: "", notes: "", ...x });
    expect(pickupNumberUnconfirmed({ ...ok, extra_pickups: [stop({ pickup_number: "7731" })] }, today)).toBe(true);
    expect(pickupNumberUnconfirmed({ ...ok, extra_pickups: [stop({ pickup_number: "7731", confirmed: true })] }, today)).toBe(false);
    expect(pickupNumberUnconfirmed({ ...ok, extra_pickups: [stop({})] }, today)).toBe(false);
  });
});

describe("the list groups", () => {
  const all = { bol: true, pod: true, carrier_invoice: true };
  it("has the nine groups in order", () => {
    expect(GROUPS.map((g) => g.title)).toEqual([
      "Urgent", "Quotes to give", "Quoted, with the team", "To book", "Booked", "On the way", "Needs paperwork", "Carrier to be paid", "Delivered",
    ]);
  });
  it("sorts each status into its group", () => {
    expect(groupOf(mk({ status: "quote" }))).toBe("quotes");
    expect(groupOf(mk({ status: "quoted" }))).toBe("quoted");
    expect(groupOf(mk({ status: "requested" }))).toBe("requested");
    expect(groupOf(mk({ status: "booked" }))).toBe("booked");
    expect(groupOf(mk({ status: "picked_up" }))).toBe("way");
    expect(groupOf(mk({ status: "cancelled" }))).toBeNull();
  });
  it("leads with an urgent load that has not been picked up, quotes included", () => {
    expect(groupOf(mk({ status: "quote", urgent: true }))).toBe("urgent");
    expect(groupOf(mk({ status: "booked", urgent: true }))).toBe("urgent");
    expect(groupOf(mk({ status: "picked_up", urgent: true }))).toBe("way");
    expect(isHot({ status: "delivered", urgent: true })).toBe(false);
  });
  it("does not lead with an urgent quoted load, it is with the team (as on the phone and the server)", () => {
    expect(isHot({ status: "quoted", urgent: true })).toBe(false);
    expect(groupOf(mk({ status: "quoted", urgent: true }))).toBe("quoted");
    expect(isHot({ status: "quote", urgent: true })).toBe(true);
  });
  it("lists only the statuses the server lets a viewer without deal edit pick", () => {
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quote", false))).toEqual(["quote", "quoted"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quoted", false))).toEqual(["quoted"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "booked", false))).toEqual(["requested", "booked", "picked_up", "delivered", "cancelled"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quote", true))).toEqual(STATUS_ORDER);
  });
  it("sends a pickup number check that was ticked again after the number changed", () => {
    expect(confirmToSend(true, true, true)).toBe(true);
    expect(confirmToSend(true, true, false)).toBe(false);
    expect(confirmToSend(false, true, true)).toBeUndefined();
    expect(confirmToSend(false, false, true)).toBe(true);
    expect(confirmToSend(true, false, false)).toBeUndefined();
  });
  it("reads a legacy pay method key as its label", () => {
    expect(paidView({ paid_state: "paid", paid_amount: 100, paid_method: "credit_card" }, "2026-10-06").text).toBe("Paid $100.00 by Credit card");
    expect(paidView({ paid_state: "paid", paid_amount: 100, paid_method: "Zelle" }, "2026-10-06").text).toBe("Paid $100.00 by Zelle");
    expect(paidMethodWord("wire")).toBe("Wire");
    expect(paidMethodWord("Cash app")).toBe("Cash app");
  });
  it("holds a delivered load for paperwork until the proof, the carrier invoice and the rate are in", () => {
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500 }))).toBe("paperwork");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paperwork: { ...all, pod: false } }))).toBe("paperwork");
    expect(groupOf(mk({ status: "delivered", quoted_cost: null, paperwork: all }))).toBe("paperwork");
    expect(missingPaperwork(mk({ status: "delivered" }))).toEqual(["Proof of delivery", "Carrier invoice", "Carrier rate"]);
  });
  it("then waits on the carrier being paid, then lands in Delivered", () => {
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paperwork: all }))).toBe("topay");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 1500, paid_state: "paid", paperwork: all }))).toBe("delivered");
  });
  it("keeps a load whose payment is only marked, or is a $0, in Carrier to be paid (R-470)", () => {
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 1500, paid_state: "marked", paperwork: all }))).toBe("topay");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 0, paperwork: all }))).toBe("topay");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 1500, bank_linked: "linked", paperwork: all }))).toBe("delivered");
  });
  it("does not call a rate missing, or a payment unpaid, when the viewer cannot see money", () => {
    const hidden = mk({ status: "delivered", can_see_money: false, paperwork: all });
    expect(groupOf(hidden)).toBe("delivered");
  });
  it("searches by load number, BOL, PRO, pickup numbers, carrier reference, carrier, broker and names", () => {
    const b = mk({
      load_number: "LD-0012", bol: "BL-8841", pro: "PR-5520", pickup_number: "PU-3310", reference: "RC-7781",
      carrier: "Northline Freight", broker: "Harbor Brokers", pickup_name: "Birchwood Depot", delivery_address: "9 Quay Rd, Newark, NJ 07102",
      extra_pickups: [{ name: "Kestrel Mill", address: "", window: "", contact: "", phone: "", notes: "", pickup_number: "PU-9902" }],
      deal: { id: "d1", invoice_number: "INV-0042", client_name: "Lantern Bay Supply", stage: "invoiced" },
    });
    const h = loadHaystack(b);
    for (const k of ["ld-0012", "bl-8841", "pr-5520", "pu-3310", "rc-7781", "northline", "harbor", "birchwood", "newark", "kestrel", "pu-9902", "inv-0042", "lantern"]) {
      expect(h).toContain(k);
    }
  });
});

describe("the lane", () => {
  it("reads city and state, with or without a ZIP", () => {
    expect(laneOf("12 Mill Rd, Dallas, TX 75201")).toEqual({ city: "Dallas", state: "TX" });
    expect(laneOf("Dallas, TX")).toEqual({ city: "Dallas", state: "TX" });
    expect(laneOf("9 Quay Rd, Newark, nj 07102-1234")).toEqual({ city: "Newark", state: "NJ" });
    expect(laneOf("dallas texas")).toEqual({ city: "dallas", state: "TX" });
  });
  it("gives nothing for text with no state", () => {
    expect(laneOf("Warehouse A")).toBeNull();
    expect(laneOf("")).toBeNull();
  });
  it("labels a lane the way the rate popup says it", () => {
    expect(laneLabel("12 Mill Rd, dallas, TX 75201", "9 Quay Rd, Newark, NJ 07102")).toBe("Dallas, TX to Newark, NJ");
    expect(laneLabel("", "9 Quay Rd, Newark, NJ")).toBe("Newark, NJ");
    expect(laneLabel("", "")).toBe("");
  });
});

describe("paying and invoicing", () => {
  it("says what has been paid", () => {
    const today = "2026-10-06";
    expect(paidView({ paid_amount: null }, today).text).toBe("Not paid yet");
    expect(paidView({ paid_state: "paid", paid_amount: 1850, paid_at: "2026-10-06", paid_method: "Zelle" }, today).text)
      .toBe(`Paid $1,850.00 on ${fmtDayLabel("2026-10-06")} by Zelle`);
  });
  it("warns when shipping on the invoice waits on a quote", () => {
    expect(quoteWaitingOnInvoice([{ status: "quote" }])).toBe(true);
    expect(quoteWaitingOnInvoice([{ status: "quoted", quote_invoiced_at: "" }])).toBe(true);
    expect(quoteWaitingOnInvoice([{ status: "quoted" }])).toBe(true);
    expect(quoteWaitingOnInvoice([{ status: "quoted", shipping_charge: "own" }])).toBe(false);
    expect(quoteWaitingOnInvoice([{ status: "quoted", shipping_charge: "invoice" }])).toBe(true);
    expect(quoteWaitingOnInvoice([{ status: "quote", shipping_charge: "own" }])).toBe(true);
    expect(quoteWaitingOnInvoice([{ status: "quoted", quote_invoiced_at: "2026-10-06" }])).toBe(false);
    expect(quoteWaitingOnInvoice([{ status: "requested" }, { status: "booked" }, { status: "cancelled" }])).toBe(false);
    expect(quoteWaitingOnInvoice([])).toBe(false);
    expect(QUOTE_WAITING_WARNING).toBe("Shipping on this invoice is still waiting on the logistics quote. Send anyway?");
  });
  it("trusts the screen that knows the deal over the load's own flag", () => {
    expect(dealPaid({ deal_paid: false }, true)).toBe(true);
    expect(dealPaid({ deal_paid: true }, false)).toBe(false);
    expect(dealPaid({ deal_paid: true })).toBe(true);
    expect(dealPaid({})).toBe(false);
  });
});

describe("R-470: a load is paid only when its bank payment is linked", () => {
  const today = "2026-10-06";

  it("reads the server's word first", () => {
    expect(paidStateOf({ paid_state: "paid", paid_amount: null })).toBe("paid");
    expect(paidStateOf({ paid_state: "marked", paid_amount: 100, bank_linked: "linked" })).toBe("marked");
    expect(paidStateOf({ paid_state: "unpaid", paid_amount: 100 })).toBe("unpaid");
  });

  it("works it out when the copy does not carry it, and never calls a typed figure paid", () => {
    expect(paidStateOf({ paid_amount: null })).toBe("unpaid");
    expect(paidStateOf({ paid_amount: 0 })).toBe("marked");
    expect(paidStateOf({ paid_amount: 850 })).toBe("marked");
    expect(paidStateOf({ paid_amount: 850, bank_linked: "none" })).toBe("marked");
    expect(paidStateOf({ paid_amount: 850, bank_linked: "partial" })).toBe("marked");
    expect(paidStateOf({ paid_amount: 850, bank_linked: "linked" })).toBe("paid");
    expect(paidStateOf({ paid_state: "nonsense", paid_amount: null })).toBe("unpaid");
  });

  it("says Not paid yet with the due date for an unpaid load", () => {
    const v = paidView({ paid_state: "unpaid", paid_amount: null, pay_due_date: "2026-10-10" }, today);
    expect(v).toMatchObject({ state: "unpaid", tone: "neutral", text: "Not paid yet", note: "Due Oct 10", noteTone: "warning", zero: false });
    expect(paidView({ paid_amount: null, pay_due_date: "2026-10-03" }, today)).toMatchObject({ note: "Overdue since Oct 3", noteTone: "danger" });
    expect(paidView({ paid_amount: null }, today).note).toBe("No due date");
  });

  it("does not claim a missing due date for someone who cannot see money", () => {
    expect(paidView({ paid_amount: null, can_see_money: false }, today)).toMatchObject({ text: "Not paid yet", note: "" });
  });

  it("warns amber on a payment that is marked but not linked", () => {
    expect(paidView({ paid_state: "marked", paid_amount: 850 }, today)).toMatchObject({
      state: "marked", tone: "warning", text: "Marked paid $850.00, not linked to the bank", zero: false,
    });
    expect(paidView({ paid_state: "marked", paid_amount: null }, today).text).toBe("Marked paid, not linked to the bank");
  });

  it("says a $0 payment is not a real payment, in red", () => {
    expect(paidView({ paid_state: "marked", paid_amount: 0 }, today)).toMatchObject({
      state: "marked", tone: "danger", text: "A $0 payment is not a real payment. Undo it.", zero: true,
    });
    expect(paidView({ paid_amount: 0 }, today).zero).toBe(true);
  });

  it("says Paid with the amount, the day and the method once it is linked", () => {
    const v = paidView({ paid_state: "paid", paid_amount: 1850, paid_at: "2026-10-06", paid_method: "Zelle" }, today);
    expect(v).toMatchObject({ state: "paid", tone: "success", note: "Linked to the bank", noteTone: "success" });
    expect(v.text).toBe(`Paid $1,850.00 on ${fmtDayLabel("2026-10-06")} by Zelle`);
    expect(paidView({ paid_state: "paid", paid_amount: null }, today).text).toBe("Paid");
    expect(paidView({ paid_state: "paid", paid_amount: 100, paid_at: "2026-10-06T14:00:00Z" }, today).text).toBe(`Paid $100.00 on ${fmtDayLabel("2026-10-06")}`);
  });

  it("asks for the payment only on a delivered or moving load that is not paid", () => {
    expect(needsAmount({ status: "delivered", paid_amount: null })).toBe(true);
    expect(needsAmount({ status: "delivered", paid_amount: 0 })).toBe(true);
    expect(needsAmount({ status: "picked_up", paid_amount: 800, paid_state: "marked" })).toBe(true);
    expect(needsAmount({ status: "delivered", paid_amount: 800, paid_state: "paid" })).toBe(false);
    expect(needsAmount({ status: "booked", paid_amount: null })).toBe(false);
    expect(needsAmount({ status: "delivered", paid_amount: null, can_see_money: false })).toBe(false);
  });
});
