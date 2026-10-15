import { describe, it, expect } from "vitest";
import type { FreightBooking } from "./api";
import {
  EQUIPMENT, LOAD_STEPS, arrivesToday, dashboardLoads, deliveryDays, loadCard, QUOTE_WAITING_WARNING, STATUS_ORDER, firstName, isNewToday,
  BOARD, BOARD_WORD, boardKey, boardSort, milTime,
  dayAndTime, dealPaid, dueLabel, dueTone, equipmentOptions, fileKind, firstStep, fmtDayLabel, groupOf, isHot, isLiveTruck,
  isTime, laneLabel, laneOf, loadHaystack, loadNumber, missingPaperwork, needsAmount, paidMethodWord, paidStateOf, paidView, paperworkOf, pickStatus, statusAllowed, confirmToSend,
  pickupNumberUnconfirmed, quoteWaitingOnInvoice, rateConLine, rateConMissing, rowLane, statusAfterActual, statusWord, stepDone, timeWord,
  actualDayGap, atQuoteStage, daysToAsk, moveBackAsk, pastDay, skipAsk, statusRank, stepForRefusal, QUOTE_STAGE_DAYS,
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
  const blank = { delivered_at: "", delivered_time: "", picked_up_at: "", picked_up_time: "" };
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
  it("R-502: picking Delivered or On the way never fills a day (it used to fill today)", () => {
    expect(pickStatus(blank, "delivered")).toEqual({ ...blank, status: "delivered" });
    expect(pickStatus({ ...blank, delivered_at: "2026-10-05" }, "delivered").delivered_at).toBe("2026-10-05");
    expect(pickStatus(blank, "picked_up")).toEqual({ ...blank, status: "picked_up" });
    expect(pickStatus({ ...blank, picked_up_at: "2026-10-04" }, "picked_up").picked_up_at).toBe("2026-10-04");
  });
  it("R-502: going back to To book or Booked clears what was picked up and delivered, times too", () => {
    const was = { delivered_at: "2026-10-08", delivered_time: "14:00", picked_up_at: "2026-10-06", picked_up_time: "09:30" };
    expect(pickStatus(was, "booked")).toEqual({ status: "booked", ...blank });
    expect(pickStatus(was, "requested").picked_up_at).toBe("");
    expect(pickStatus(was, "requested").delivered_time).toBe("");
  });
  it("R-502: going back from Delivered to On the way clears the delivery day and time and keeps the pickup", () => {
    const was = { delivered_at: "2026-10-08", delivered_time: "14:00", picked_up_at: "2026-10-06", picked_up_time: "09:30" };
    expect(pickStatus(was, "picked_up")).toEqual({ status: "picked_up", delivered_at: "", delivered_time: "", picked_up_at: "2026-10-06", picked_up_time: "09:30" });
  });
  it("leaves the days alone for a quote or a cancel", () => {
    const was = { delivered_at: "2026-10-08", delivered_time: "14:00", picked_up_at: "2026-10-06", picked_up_time: "09:30" };
    expect(pickStatus(was, "cancelled")).toEqual({ ...was, status: "cancelled" });
    expect(pickStatus(was, "quote")).toEqual({ ...was, status: "quote" });
  });
});

describe("R-502: the status order", () => {
  it("ranks the statuses the way the server does, cancelled before them all", () => {
    expect(STATUS_ORDER.filter((s) => s !== "cancelled").map(statusRank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(statusRank("cancelled")).toBe(-1);
  });
});

describe("R-506: moving a quote-stage load past the quote stage asks, then lets it through", () => {
  it("a quote, a quoted load and a cancelled load that never went to book are at the quote stage", () => {
    expect(atQuoteStage({ status: "quote" })).toBe(true);
    expect(atQuoteStage({ status: "quoted" })).toBe(true);
    expect(atQuoteStage({ status: "cancelled", booked_at: "", sent_to_book_at: "" })).toBe(true);
    expect(atQuoteStage({ status: "cancelled" })).toBe(true);
  });
  it("a cancelled load that was booked or sent to book, and any later status, are not", () => {
    expect(atQuoteStage({ status: "cancelled", booked_at: "2026-10-01T09:00:00Z" })).toBe(false);
    expect(atQuoteStage({ status: "cancelled", sent_to_book_at: "2026-10-01T09:00:00Z" })).toBe(false);
    expect(atQuoteStage({ status: "requested" })).toBe(false);
    expect(atQuoteStage({ status: "delivered", booked_at: "" })).toBe(false);
  });
  it("asks nothing when nothing is skipped", () => {
    expect(skipAsk("booked", [], false)).toBe("");
    expect(skipAsk("picked_up", [], true)).toBe("");
  });
  it("To book and Booked ask Book anyway and name what is skipped, in the gate's order", () => {
    expect(skipAsk("requested", ["sent", "paid"], false)).toBe("Book anyway? This skips: invoice not sent, customer not paid.");
    expect(skipAsk("booked", ["quote", "charge", "sent", "paid"], false))
      .toBe("Book anyway? This skips: no quote yet, shipping not on the invoice yet, invoice not sent, customer not paid.");
  });
  it("On the way and Delivered ask to log a load that already moved", () => {
    expect(skipAsk("picked_up", ["paid"], false)).toBe("Log this load as already moving? This skips: customer not paid.");
    expect(skipAsk("delivered", ["quote"], false)).toBe("Log this load as already moving? This skips: no quote yet.");
  });
  it("tells a Logistics-only person that the team will see it", () => {
    // A Logistics-only person cannot see the invoice or the payment, so the question does not list them.
    expect(skipAsk("delivered", ["sent", "paid"], true)).toBe("Log this load as already moving? Your team will see you logged it.");
    expect(skipAsk("booked", ["paid"], true)).toBe("Book anyway? Your team will see you logged it.");
  });
  it("the sentence for a day on a load that stayed at the quote stage is the server's, and leaves the person where they are", () => {
    expect(QUOTE_STAGE_DAYS).toBe("Pick On the way or Delivered in Status to log a load that already moved. It asks for the days.");
  });
});

describe("R-502: asking for the days", () => {
  it("On the way asks for the pickup day when the load has none", () => {
    expect(daysToAsk("booked", "picked_up", { picked_up_at: "" })).toEqual({ pickup: true, delivery: false });
    expect(daysToAsk("booked", "picked_up", { picked_up_at: "2026-10-01" })).toEqual({ pickup: false, delivery: false });
  });
  it("Delivered always asks for the delivery day, and the pickup day when it has not been on the way and has none", () => {
    expect(daysToAsk("booked", "delivered", { picked_up_at: "" })).toEqual({ pickup: true, delivery: true });
    expect(daysToAsk("booked", "delivered", { picked_up_at: "2026-10-01" })).toEqual({ pickup: false, delivery: true });
    expect(daysToAsk("picked_up", "delivered", { picked_up_at: "" })).toEqual({ pickup: false, delivery: true });
    expect(daysToAsk("cancelled", "delivered", { picked_up_at: "" })).toEqual({ pickup: true, delivery: true });
  });
  it("a move back, a cancel or an early step asks for nothing", () => {
    expect(daysToAsk("delivered", "picked_up", { picked_up_at: "" })).toEqual({ pickup: false, delivery: false });
    expect(daysToAsk("booked", "cancelled", { picked_up_at: "" })).toEqual({ pickup: false, delivery: false });
    expect(daysToAsk("requested", "booked", { picked_up_at: "" })).toEqual({ pickup: false, delivery: false });
  });
  it("the appointment day is the first answer only once it has come", () => {
    expect(pastDay("2026-10-05", "2026-10-06")).toBe("2026-10-05");
    expect(pastDay("2026-10-06", "2026-10-06")).toBe("2026-10-06");
    expect(pastDay("2026-10-07", "2026-10-06")).toBe("");
    expect(pastDay("", "2026-10-06")).toBe("");
    expect(pastDay(undefined, "2026-10-06")).toBe("");
  });
  it("judges the days like the server: not after today, delivery not before pickup", () => {
    expect(actualDayGap({ picked_up_at: "2026-10-05", delivered_at: "" }, "2026-10-04")).toBe("The pickup day cannot be after today.");
    expect(actualDayGap({ picked_up_at: "", delivered_at: "2026-10-09" }, "2026-10-04")).toBe("The delivery day cannot be after today.");
    expect(actualDayGap({ picked_up_at: "2026-10-03", delivered_at: "2026-10-02" }, "2026-10-04")).toBe("The delivery day cannot be before the pickup day.");
    expect(actualDayGap({ picked_up_at: "2026-10-02", delivered_at: "2026-10-02" }, "2026-10-04")).toBe("");
    expect(actualDayGap({ picked_up_at: "", delivered_at: "" }, "2026-10-04")).toBe("");
  });
});

describe("R-502: asking before a move back or a cancel", () => {
  const now = new Date(2026, 9, 12);
  const moved = { delivered_at: "2026-10-02", delivered_time: "14:00", picked_up_at: "2026-10-01", picked_up_time: "09:30" };
  it("back from Delivered to On the way names the delivery day it clears", () => {
    expect(moveBackAsk("delivered", "picked_up", moved, now)).toBe("Move this load back? This clears the delivery day Oct 2.");
  });
  it("back to To book or Booked names both days", () => {
    expect(moveBackAsk("delivered", "booked", moved, now)).toBe("Move this load back? This clears the pickup day Oct 1 and the delivery day Oct 2.");
    expect(moveBackAsk("picked_up", "requested", { ...moved, delivered_at: "" }, now)).toBe("Move this load back? This clears the pickup day Oct 1.");
  });
  it("a move back with nothing to clear asks nothing", () => {
    expect(moveBackAsk("delivered", "booked", { delivered_at: "", delivered_time: "", picked_up_at: "", picked_up_time: "" }, now)).toBe("");
    expect(moveBackAsk("delivered", "picked_up", { ...moved, delivered_at: "" }, now)).toBe("");
  });
  it("cancelling a booked, moving or delivered load asks, and says what it already did (cancel keeps the days)", () => {
    expect(moveBackAsk("booked", "cancelled", { ...moved, picked_up_at: "", delivered_at: "" }, now)).toBe("Cancel this load?");
    expect(moveBackAsk("picked_up", "cancelled", { ...moved, delivered_at: "" }, now)).toBe("Cancel this load? It was picked up Oct 1.");
    expect(moveBackAsk("delivered", "cancelled", moved, now)).toBe("Cancel this load? It was picked up Oct 1 and delivered Oct 2.");
  });
  it("cancelling a load that is not booked yet, and a move forward, ask nothing", () => {
    expect(moveBackAsk("requested", "cancelled", moved, now)).toBe("");
    expect(moveBackAsk("quote", "cancelled", moved, now)).toBe("");
    expect(moveBackAsk("booked", "delivered", moved, now)).toBe("");
    expect(moveBackAsk("picked_up", "picked_up", moved, now)).toBe("");
  });
  it("back to a quote stage asks nothing (the days stay, as pickStatus leaves them)", () => {
    expect(moveBackAsk("delivered", "quoted", moved, now)).toBe("");
  });
});

describe("R-502: a refused save lands on the box to fix", () => {
  it("sends the carrier to Book, the days to Pickup and Delivery", () => {
    expect(stepForRefusal("Add the carrier on the Book step before marking it booked.", true)).toBe("book");
    expect(stepForRefusal("Add the day it was picked up on the Pickup step.", true)).toBe("pickup");
    expect(stepForRefusal("Add the day it was delivered on the Delivery step.", true)).toBe("delivery");
    expect(stepForRefusal("The pickup day cannot be after today.", true)).toBe("pickup");
    expect(stepForRefusal("The delivery day cannot be after today.", true)).toBe("delivery");
    expect(stepForRefusal("The delivery day cannot be before the pickup day.", true)).toBe("delivery");
  });
  it("sends an address to Quote when it can be fixed there, else to Book", () => {
    expect(stepForRefusal("The delivery address needs its city. Like 9 Depot Rd, Reno, NV 89501.", true)).toBe("quote");
    expect(stepForRefusal("The address of pickup 2 needs its street and number. Like 9 Depot Rd, Reno, NV 89501.", true)).toBe("quote");
    expect(stepForRefusal("Your team needs to finish the delivery address (its city) before this can go on.", false)).toBe("book");
  });
  it("leaves the person where they are for the quote-stage sentences and anything else", () => {
    expect(stepForRefusal("Send this load to book before adding the day it was picked up or delivered.", true)).toBeUndefined();
    // R-506: the sentence names "Delivered", which must not send the person to the Delivery step.
    expect(stepForRefusal(QUOTE_STAGE_DAYS, true)).toBeUndefined();
    expect(stepForRefusal(QUOTE_STAGE_DAYS, false)).toBeUndefined();
    expect(stepForRefusal("Could not reach the server.", true)).toBeUndefined();
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

describe("R-524: a time typed in 24-hour time", () => {
  it("reads 1430, 930, 14:30 and 2:30 pm as HH:MM, and anything else as not a time", () => {
    const cases: [string, string | null][] = [
      ["1430", "14:30"], ["930", "09:30"], ["0930", "09:30"], ["14:30", "14:30"], ["7", "07:00"], ["0", "00:00"], ["2359", "23:59"],
      ["2400", null], ["1260", null], ["2:30 pm", "14:30"], ["230p", "14:30"], ["12am", "00:00"], ["12pm", "12:00"],
      ["12:15 a.m.", "00:15"], ["13pm", null], ["", ""], ["abc", null], ["12345", null],
    ];
    for (const [typed, want] of cases) expect([typed, milTime(typed)]).toEqual([typed, want]);
  });
});

describe("the list groups", () => {
  const all = { bol: true, pod: true, carrier_invoice: true };
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
    // R-506: a quote-stage load can be moved on to To book, Booked, On the way or Delivered; he still cannot pick Quote
    // asked, Quoted only comes from a quote stage, and Cancelled stays shut while it is a quote.
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quote", false))).toEqual(["quote", "quoted", "requested", "booked", "picked_up", "delivered"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quoted", false))).toEqual(["quoted", "requested", "booked", "picked_up", "delivered"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "booked", false))).toEqual(["requested", "booked", "picked_up", "delivered", "cancelled"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "cancelled", false))).toEqual(["requested", "booked", "picked_up", "delivered", "cancelled"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quote", true))).toEqual(STATUS_ORDER);
    // R-521: with the owner's switch off, logistics waits for the team to send a quote-stage load to book.
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quoted", false, false))).toEqual(["quoted"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "booked", false, false))).toEqual(["requested", "booked", "picked_up", "delivered", "cancelled"]);
    expect(STATUS_ORDER.filter((s) => statusAllowed(s, "quoted", true, false))).toEqual(STATUS_ORDER);
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
  it("keeps a marked load, or a $0, out of Carrier to be paid, it waits in Pay carriers to be linked, and keeps a part-linked one in it (R-470)", () => {
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 1500, paid_state: "marked", paperwork: all }))).toBe("delivered");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 0, paperwork: all }))).toBe("delivered");
    expect(groupOf(mk({ status: "delivered", quoted_cost: 1500, paid_amount: 300, paid_state: "part", paperwork: all }))).toBe("topay");
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
  it("reads the address shapes the website reads: a ZIP or country after the state, a full state name, newlines (R-478)", () => {
    const dallas = { city: "Dallas", state: "TX" };
    expect(laneOf("1200 Industrial Blvd, Dallas, TX 75201, USA")).toEqual(dallas);
    expect(laneOf("1200 Industrial Blvd, Dallas, TX 75201, United States")).toEqual(dallas);
    expect(laneOf("Dallas, TX, 75201")).toEqual(dallas);
    expect(laneOf("Dallas, Texas 75201")).toEqual(dallas);
    expect(laneOf("12 Mill Rd, Dallas, Texas")).toEqual(dallas);
    expect(laneOf("1200 Industrial Blvd\nDallas, TX 75201")).toEqual(dallas);
    expect(laneOf("12 Mill Rd, Dallas TX 75201")).toEqual(dallas);
    expect(laneOf("Reno, NV")).toEqual({ city: "Reno", state: "NV" });
    expect(laneOf("12 Mill Rd")).toBeNull();
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

describe("the line under a load in the list (R-478)", () => {
  const lane = (over: Partial<FreightBooking> = {}) => rowLane(mk(over));
  it("reads From city and state to city and state", () => {
    expect(lane({ pickup_address: "12 Mill Rd, dallas, TX 75201", delivery_address: "9 Quay Rd, Newark, NJ 07102" })).toBe("From Dallas, TX to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "dallas texas" })).toBe("From Dallas, TX to Dallas, TX");
  });
  it("counts the pickups after the first", () => {
    const stop = { name: "", address: "5 Elm St, Reno, NV 89501", window: "", contact: "", phone: "", notes: "", dock: "", pickup_number: "", confirmed: false };
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "Newark, NJ", extra_pickups: [stop] })).toBe("From Dallas, TX + 1 more to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "Newark, NJ", extra_pickups: [stop, stop, stop] })).toBe("From Dallas, TX + 3 more to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "Newark, NJ", extra_pickups: [] })).toBe("From Dallas, TX to Newark, NJ");
  });
  it("reads the same city and state the website does for the common address shapes (R-478)", () => {
    const to = "9 Depot Rd, Newark, NJ 07102, USA";
    expect(lane({ pickup_address: "1200 Industrial Blvd, Dallas, TX 75201, USA", delivery_address: to })).toBe("From Dallas, TX to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, TX, 75201", delivery_address: to })).toBe("From Dallas, TX to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, Texas 75201", delivery_address: to })).toBe("From Dallas, TX to Newark, NJ");
    expect(lane({ pickup_address: "Reno, NV", delivery_address: to })).toBe("From Reno, NV to Newark, NJ");
    expect(lane({ pickup_address: "1200 Industrial Blvd\nDallas, TX 75201", delivery_address: to })).toBe("From Dallas, TX to Newark, NJ");
    // a street with no city and state stays as typed
    expect(lane({ pickup_address: "1200 Industrial Blvd", delivery_address: to })).toBe("From 1200 Industrial Blvd to Newark, NJ");
  });
  it("keeps an address that is not a city and state as typed, on one line", () => {
    expect(lane({ pickup_address: "Warehouse A", delivery_address: "Newark, NJ" })).toBe("From Warehouse A to Newark, NJ");
    // a line break reads as a comma, the way the website's From/to line keeps it
    expect(lane({ pickup_address: "  Bay 4\n  Test Yard  ", delivery_address: "Newark, NJ" })).toBe("From Bay 4, Test Yard to Newark, NJ");
  });
  it("an empty side reads a hyphen, and two empty sides give no line", () => {
    expect(lane({ pickup_address: "", delivery_address: "Newark, NJ" })).toBe("From - to Newark, NJ");
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "  " })).toBe("From Dallas, TX to -");
    expect(lane({ pickup_address: "", delivery_address: "" })).toBe("");
    expect(lane({ pickup_address: "", delivery_address: "", extra_pickups: [{ name: "", address: "Reno, NV", window: "", contact: "", phone: "", notes: "", dock: "", pickup_number: "", confirmed: false }] })).toBe("");
  });
  it("is nothing for a viewer without the address switch, whatever the names say", () => {
    expect(lane({ pickup_address: "", delivery_address: "", pickup_name: "Birchwood", delivery_name: "Lantern Bay", can_see_addresses: false })).toBe("");
    expect(lane({ pickup_address: "Dallas, TX", delivery_address: "Newark, NJ", can_see_addresses: false })).toBe("");
  });
  it("carries no em dash", () => {
    expect(lane({ pickup_address: "", delivery_address: "Newark, NJ" })).not.toMatch(/[\u2014\u2013]/);
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
    expect(paidView({ paid_state: "unpaid", paid_amount: null, can_see_money: false }, today)).toMatchObject({ text: "Not paid yet", note: "" });
  });

  it("says nothing at all about a payment the server withheld, never Not paid yet (C-1, P-5)", () => {
    expect(paidStateOf({ paid_state: "", paid_amount: null })).toBe("hidden");
    expect(paidStateOf({ paid_state: "", paid_amount: null, can_see_money: false })).toBe("hidden");
    expect(paidStateOf({ paid_amount: null, can_see_money: false })).toBe("hidden");
    expect(paidStateOf({ paid_amount: null })).toBe("unpaid");
    expect(paidView({ paid_state: "", paid_amount: null, can_see_money: false }, today)).toMatchObject({ state: "hidden", text: "", note: "" });
    expect(paidView({ paid_amount: null, can_see_money: false }, today).text).toBe("");
  });

  it("a recorded $0 or less is marked, never paid, whatever the link or the server says (P-1, P-3)", () => {
    expect(paidStateOf({ paid_amount: 0, bank_linked: "linked" })).toBe("marked");
    expect(paidStateOf({ paid_state: "paid", paid_amount: 0 })).toBe("marked");
    expect(paidStateOf({ paid_state: "part", paid_amount: 0 })).toBe("marked");
    expect(paidStateOf({ paid_amount: -5, bank_linked: "linked" })).toBe("marked");
    expect(paidStateOf({ paid_amount: 0.01, bank_linked: "linked" })).toBe("paid");
  });

  it("a part-linked load says what is linked of the rate and to link the rest, and keeps its due date (R-470 partial)", () => {
    expect(paidStateOf({ paid_state: "part", paid_amount: 300 })).toBe("part");
    const v = paidView({ paid_state: "part", paid_amount: 300, quoted_cost: 800, pay_due_date: "2026-10-03" }, today);
    expect(v).toMatchObject({ state: "part", tone: "warning", text: "Paid $300.00 of $800.00, link the rest", note: "Overdue since Oct 3", noteTone: "danger" });
    expect(paidView({ paid_state: "part", paid_amount: 300 }, today).text).toBe("Paid $300.00, link the rest");
  });

  it("says only part of a marked payment is linked, with the marked day and method (C-3)", () => {
    const v = paidView({ paid_state: "marked", paid_amount: 850, bank_linked: "partial", paid_at: "2026-10-03", paid_method: "wire" }, today);
    expect(v.text).toBe("Marked paid $850.00, only part of it is linked to the bank");
    expect(v.note).toBe(`Marked on ${fmtDayLabel("2026-10-03")} by Wire`);
    expect(paidView({ paid_state: "marked", paid_amount: 850, paid_method: "Zelle" }, today).note).toBe("by Zelle");
    expect(paidView({ paid_state: "marked", paid_amount: 850 }, today).note).toBe("");
  });

  it("shows the reference under Linked to the bank (C-3)", () => {
    const v = paidView({ paid_state: "paid", paid_amount: 100, paid_note: "ref 4471" }, today);
    expect(v.note).toBe("Linked to the bank · Reference ref 4471");
    expect(paidView({ paid_state: "paid", paid_amount: 100, paid_note: "  " }, today).note).toBe("Linked to the bank");
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
    expect(needsAmount({ status: "delivered", paid_amount: 0 })).toBe(false);
    expect(needsAmount({ status: "picked_up", paid_amount: 800, paid_state: "marked" })).toBe(false);
    expect(needsAmount({ status: "delivered", paid_amount: 300, paid_state: "part" })).toBe(true);
    expect(needsAmount({ status: "delivered", paid_amount: 800, paid_state: "paid" })).toBe(false);
    expect(needsAmount({ status: "booked", paid_amount: null })).toBe(false);
    expect(needsAmount({ status: "delivered", paid_amount: null, can_see_money: false })).toBe(false);
  });
});

describe("R-475: how complete the rate confirmation is", () => {
  const full = { carrier: "Fast Test Freight", quoted_cost: 1850, pickup_date: "2026-10-09", pickup_name: "Sunrise Test Supply", pickup_address: "",
    delivery_name: "", delivery_address: "12 Test Way", can_see_names: true, can_see_addresses: true };
  it("is ready with a carrier, a rate, both places and a pickup day", () => {
    expect(rateConMissing(full)).toEqual([]);
    expect(rateConLine([])).toBe("Ready to send to the carrier.");
  });
  it("names what is missing, in order", () => {
    const empty = { ...full, carrier: " ", quoted_cost: null, pickup_date: "", pickup_name: "", delivery_address: "" };
    expect(rateConMissing(empty)).toEqual(["carrier", "carrier rate", "pickup location", "delivery location", "pickup date"]);
    expect(rateConLine(["carrier rate", "pickup date"])).toBe("Still missing: carrier rate, pickup date. It exports anyway, with those left blank.");
  });
  it("never counts what this viewer may not see as missing", () => {
    expect(rateConMissing({ ...full, quoted_cost: null, can_see_money: false })).toEqual([]);
    expect(rateConMissing({ ...full, pickup_name: "", delivery_address: "", can_see_names: false, can_see_addresses: false })).toEqual([]);
    // Names hidden: an address alone places the stop; with no address it is missing.
    expect(rateConMissing({ ...full, can_see_names: false, pickup_address: "9 Depot Rd" })).toEqual([]);
    expect(rateConMissing({ ...full, can_see_names: false })).toEqual(["pickup location"]);
  });
});

describe("R-476: the hello and New today", () => {
  it("counts a load as new for 24 hours after it was created, never a cancelled one", () => {
    const now = Date.parse("2026-10-08T18:00:00Z");
    expect(isNewToday({ created_at: "2026-10-08T09:00:00Z", status: "quote" }, now)).toBe(true);
    expect(isNewToday({ created_at: "2026-10-07T18:00:01Z", status: "booked" }, now)).toBe(true);
    expect(isNewToday({ created_at: "2026-10-07T17:59:59Z", status: "booked" }, now)).toBe(false);
    expect(isNewToday({ created_at: "2026-10-08T09:00:00Z", status: "cancelled" }, now)).toBe(false);
    expect(isNewToday({ created_at: "", status: "quote" }, now)).toBe(false);
  });
  it("R-525: the board has three boxes left to right, and each load is in one of them, in its colour, or finished", () => {
    expect(BOARD.map((c) => [c.title, c.keys])).toEqual([
      ["Quote and book", ["quote", "team", "book"]], ["Booked and on the road", ["pickup", "moving"]], ["Delivered", ["paper", "pay"]],
    ]);
    const all = { bol: true, pod: true, carrier_invoice: true };
    const paid = { paperwork: all, quoted_cost: 900, paid_amount: 900, paid_state: "paid" as const };
    expect(boardKey(mk({ status: "quote" }))).toBe("quote");
    expect(boardKey(mk({ status: "quoted" }))).toBe("team");
    expect(boardKey(mk({ status: "requested", urgent: true }))).toBe("book");
    expect(boardKey(mk({ status: "booked" }))).toBe("pickup");
    expect(boardKey(mk({ status: "picked_up" }))).toBe("moving");
    expect(boardKey(mk({ status: "delivered", quoted_cost: 900 }))).toBe("paper");
    expect(boardKey(mk({ status: "delivered", paperwork: all, quoted_cost: 900, paid_amount: null, paid_state: "unpaid" }))).toBe("pay");
    expect(boardKey(mk({ status: "delivered", ...paid }))).toBeNull();
    expect(boardKey(mk({ status: "cancelled" }))).toBeNull();
    expect(BOARD_WORD.paper).toBe("Waiting on paperwork");
  });
  it("R-525: inside a box, urgent first, then by colour, then by day", () => {
    const loads = [
      mk({ id: "book-late", status: "requested", pickup_date: "2026-10-20" }),
      mk({ id: "quote", status: "quote", pickup_date: "2026-10-25" }),
      mk({ id: "book-soon", status: "requested", pickup_date: "2026-10-10" }),
      mk({ id: "hot", status: "requested", urgent: true, pickup_date: "2026-10-30" }),
    ];
    expect([...loads].sort(boardSort).map((b) => b.id)).toEqual(["hot", "quote", "book-soon", "book-late"]);
  });
  it("greets by the first word of the account's name", () => {
    expect(firstName("Robin Testcase")).toBe("Robin");
    expect(firstName("  Jordan  ")).toBe("Jordan");
    expect(firstName("")).toBe("");
    expect(firstName(undefined)).toBe("");
  });
});

describe("the Dashboard's two groups (R-483)", () => {
  it("lists booked and picked-up loads as waiting on shipping, and delivered loads with the carrier unpaid as waiting to pay", () => {
    const list = [
      mk({ id: "q", status: "quote" }),
      mk({ id: "r", status: "requested" }),
      mk({ id: "bk", status: "booked" }),
      mk({ id: "pu", status: "picked_up" }),
      mk({ id: "unpaid", status: "delivered", paid_amount: null, paid_state: "unpaid" }),
      mk({ id: "part", status: "delivered", paid_amount: 200, paid_state: "part" }),
      mk({ id: "marked", status: "delivered", paid_amount: 500, paid_state: "marked" }),
      mk({ id: "paid", status: "delivered", paid_amount: 500, paid_state: "paid", bank_linked: "linked" }),
      mk({ id: "hidden", status: "delivered", paid_amount: null, can_see_money: false }),
      mk({ id: "x", status: "cancelled" }),
    ];
    const { shipping, carrier } = dashboardLoads(list, "2026-10-09");
    expect(shipping.map((b) => b.id)).toEqual(["bk", "pu"]);
    expect(carrier.map((b) => b.id)).toEqual(["unpaid", "part", "marked"]);
  });
});

describe("the Dashboard's cards (R-484 round 2)", () => {
  const T = "2026-10-09";
  const paper = { bol: true, pod: true, carrier_invoice: true };
  it("colours a load by where it is: teal while it ships (R-507)", () => {
    expect(loadCard(mk({ status: "booked" }), T)).toMatchObject({ tone: "teal", label: "Booked", step: 1 });
    expect(loadCard(mk({ status: "picked_up" }), T)).toMatchObject({ tone: "teal", label: "On the way", step: 2 });
  });
  it("says what a delivered load still needs before the carrier is paid", () => {
    expect(loadCard(mk({ status: "delivered" }), T)).toMatchObject({ tone: "green", label: "Needs paperwork", step: 1 });
    const ready = mk({ status: "delivered", paperwork: paper, quoted_cost: 1800, pay_due_date: "2026-10-20" });
    expect(loadCard(ready, T)).toMatchObject({ tone: "green", label: "Ready to pay", step: 2 });
    expect(loadCard({ ...ready, pay_due_date: "2026-10-09" }, T)).toMatchObject({ tone: "red", label: "Due today" });
    expect(loadCard({ ...ready, pay_due_date: "2026-10-02" }, T)).toMatchObject({ tone: "red", label: "Overdue" });
    expect(loadCard({ ...ready, paid_amount: 500, paid_state: "marked" }, T)).toMatchObject({ label: "Link the payment" });
    expect(loadCard({ ...ready, paid_amount: 500, paid_state: "part" }, T)).toMatchObject({ label: "Part paid" });
  });
});

describe("arriving today (R-487)", () => {
  const T = "2026-10-09";
  it("is a load delivered today, or booked or on the way with its delivery due today", () => {
    expect(arrivesToday(mk({ status: "picked_up", delivery_date: T }), T)).toBe(true);
    expect(arrivesToday(mk({ status: "booked", delivery_date: T }), T)).toBe(true);
    expect(arrivesToday(mk({ status: "delivered", delivered_at: T }), T)).toBe(true);
    expect(arrivesToday(mk({ status: "delivered", delivered_at: "2026-10-08", delivery_date: T }), T)).toBe(false);
    expect(arrivesToday(mk({ status: "picked_up", delivery_date: "2026-10-10" }), T)).toBe(false);
    expect(arrivesToday(mk({ status: "quote", delivery_date: T }), T)).toBe(false);
  });
  it("leads the Dashboard and takes its loads out of the other groups", () => {
    const list = [
      mk({ id: "a", status: "picked_up", delivery_date: T }),
      mk({ id: "b", status: "picked_up", delivery_date: "2026-10-11" }),
      mk({ id: "c", status: "delivered", delivered_at: T, paid_state: "unpaid" }),
      mk({ id: "d", status: "delivered", delivered_at: "2026-10-01", paid_state: "unpaid" }),
    ];
    const g = dashboardLoads(list, T);
    expect(g.arriving.map((b) => b.id)).toEqual(["a", "c"]);
    expect(g.shipping.map((b) => b.id)).toEqual(["b"]);
    expect(g.carrier.map((b) => b.id)).toEqual(["d"]);
    expect(loadCard(list[0], T)).toMatchObject({ tone: "teal", label: "Arriving today", step: 2 });
    expect(loadCard(list[2], T)).toMatchObject({ tone: "teal", label: "Delivered today", step: 3 });
  });
});

describe("the delivery chart (R-487)", () => {
  const T = "2026-10-30";
  it("puts each booked or moving load on its delivery day, across a month end, and keeps the late and undated apart", () => {
    const list = [
      mk({ id: "a", status: "picked_up", delivery_date: T }),
      mk({ id: "b", status: "booked", delivery_date: "2026-11-02" }),
      mk({ id: "c", status: "delivered", delivered_at: T }),
      mk({ id: "d", status: "picked_up", delivery_date: "2026-10-28" }),
      mk({ id: "e", status: "booked", delivery_date: "" }),
      mk({ id: "f", status: "quote", delivery_date: T }),
      mk({ id: "g", status: "booked", delivery_date: "2026-11-20" }),
    ];
    const r = deliveryDays(list, T, 14);
    expect(r.days.length).toBe(14);
    expect(r.days[0]).toMatchObject({ day: T });
    expect(r.days[0].way.map((b) => b.id)).toEqual(["a"]);
    expect(r.days[0].delivered.map((b) => b.id)).toEqual(["c"]);
    expect(r.days[3].day).toBe("2026-11-02");
    expect(r.days[3].booked.map((b) => b.id)).toEqual(["b"]);
    expect(r.days[13].day).toBe("2026-11-12");
    expect(r.late.map((b) => b.id)).toEqual(["d"]);
    expect(r.undated).toBe(1);
  });
});
