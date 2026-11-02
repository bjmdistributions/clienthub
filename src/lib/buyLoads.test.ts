import { describe, it, expect } from "vitest";
import type { BuyDetail, TruckRow } from "./api";
import { buyLabelOf, buySteps, chargingOf, comingLabel, comingState, costEachLine, invoiceCost, invoiceCostLines, perUnit, truckDays, truckWord } from "./buyLoads";

// Invented trucks and buys, never a real one.
const truck = (over: Partial<TruckRow> = {}): TruckRow => ({
  id: "fb_a", code: "LD-0151", status: "quoted", truck_no: 1, trucks: 2, carrier: "Sample Freight", rate: 1750, paid: null, markup: null, quote_amount: null,
  bank_txn_id: "", pickup_date: "", delivery_date: "2026-10-23", delivery_window: "", delivery_appt_time: "09:00", delivered_at: "", delivered_time: "", ...over,
});

const detail = (over: { buy?: Partial<BuyDetail["buy"]>; rollup?: Partial<BuyDetail["rollup"]>; trucks?: TruckRow[]; cost?: Partial<BuyDetail["truck_cost"]> } = {}): BuyDetail => ({
  buy: {
    id: "buy_1", item_id: "", load_id: "", stock_name: "", name: "Sample hats", supplier_id: "", supplier_name: "Sample Supplier", units_bought: 0,
    goods_total: 1000, ship_total: 0, ship_typed: 0, markup_total: 0, notes: "", archived: false, on_the_way: true, created_at: "", updated_at: "", ...over.buy,
  },
  rollup: {
    bought: 0, sold: 0, left: 0, goods_total: 1000, ship_total: 0, unit_cost: 0, goods_paid: 0, ship_paid: 0, cost_sold: 0, sales: 0, received: 0, other_cost: 0,
    refunds: 0, made_on_sold: 0, made_so_far: 0, sold_out: false, oversold: false, markup_total: 0, load_cost: 1000, cost_on_hand: 1000, markup_sold: 0, ...over.rollup,
  },
  unit_goods: 0, unit_ship: 0, unit_markup: 0, trucks: over.trucks ?? [], truck_cost: { live: (over.trucks ?? []).length, priced: 0, paid: 0, carrier: 0, markup: 0, ...over.cost },
  orders: [], payments: [], missing: [], in_step: true,
});

describe("how a buy's truck reads", () => {
  it("is Coming in with the buy's name, and the truck's place only when there are several", () => {
    expect(comingLabel("Sample hats")).toBe("Coming in: Sample hats");
    expect(comingLabel("Sample hats", 1, 1)).toBe("Coming in: Sample hats");
    expect(comingLabel("Sample hats", 2, 3)).toBe("Coming in: Sample hats, truck 2 of 3");
    expect(comingLabel("Sample hats", 0, 3)).toBe("Coming in: Sample hats");
  });
  it("is nothing for a deal's load", () => {
    expect(buyLabelOf({ buy: null })).toBe("");
    expect(buyLabelOf({})).toBe("");
    expect(buyLabelOf({ buy: { name: "Sample hats", truck_no: 1, trucks: 2 } })).toBe("Coming in: Sample hats, truck 1 of 2");
  });
  it("words the truck's place", () => {
    expect(truckWord({ truck_no: 1, trucks: 2 })).toBe("Truck 1 of 2");
    expect(truckWord({ truck_no: 1, trucks: 1 })).toBe("");
    expect(truckWord({ truck_no: 0, trucks: 2 })).toBe("");
  });
});

describe("where a buy's trucks stand", () => {
  it("waits for quotes while any truck has none, however many are quoted", () => {
    expect(comingState([{ status: "quoted" }, { status: "quote" }])).toBe("waiting");
  });
  it("is quoted until every live truck is booked, then booked, then delivered", () => {
    expect(comingState([{ status: "quoted" }, { status: "requested" }])).toBe("quoted");
    expect(comingState([{ status: "booked" }, { status: "quoted" }])).toBe("quoted");
    expect(comingState([{ status: "booked" }, { status: "picked_up" }])).toBe("booked");
    expect(comingState([{ status: "delivered" }, { status: "booked" }])).toBe("booked");
    expect(comingState([{ status: "delivered" }, { status: "delivered" }])).toBe("delivered");
  });
  it("leaves a cancelled truck out, and says none when nothing is live", () => {
    expect(comingState([{ status: "delivered" }, { status: "cancelled" }])).toBe("delivered");
    expect(comingState([{ status: "cancelled" }])).toBe("none");
    expect(comingState([])).toBe("none");
  });
  it("lists when each truck arrives", () => {
    const two = [truck(), truck({ delivery_appt_time: "13:00" }), truck({ status: "cancelled", delivery_appt_time: "15:00" })];
    expect(truckDays(two)).toBe("Oct 23, 9:00 am and Oct 23, 1:00 pm");
    expect(truckDays([truck({ status: "delivered", delivered_at: "2026-10-24", delivered_time: "10:30" })])).toBe("Delivered Oct 24, 10:30 am");
  });
});

describe("the four steps", () => {
  it("starts a new buy with nothing paid, no truck, no stock and nothing sold", () => {
    const s = buySteps(detail(), true);
    expect(s.map((x) => `${x.key}:${x.word}:${x.done}`)).toEqual(["paid:Not paid yet:false", "ship:No truck yet:false", "arrived:Not here yet:false", "selling:Waiting for stock:false"]);
    expect(s[1].line).toBe("Send to logistics");
    expect(s[2].line).toBe("Add the manifest");
  });
  it("reads Paid, Part paid and Not paid yet from the goods paid against what you pay", () => {
    expect(buySteps(detail({ rollup: { goods_paid: 1000 } }), true)[0]).toMatchObject({ word: "Paid", done: true });
    expect(buySteps(detail({ rollup: { goods_paid: 400 } }), true)[0]).toMatchObject({ word: "Part paid", line: "$400.00 of $1,000.00", done: false });
    expect(buySteps(detail({ rollup: { goods_paid: 400 } }), false)[0].line).toBe("");
  });
  it("counts the trucks and what they cost so far, done once every live truck is delivered", () => {
    const two = [truck(), truck({ truck_no: 2 })];
    const s = buySteps(detail({ trucks: two, cost: { carrier: 3600, priced: 2 } }), true)[1];
    expect(s).toMatchObject({ word: "Quoted", line: "2 trucks, $3,600.00 so far", done: false });
    expect(buySteps(detail({ trucks: two, cost: { carrier: 3600 } }), false)[1].line).toBe("2 trucks");
    const done = [truck({ status: "delivered" }), truck({ status: "delivered", truck_no: 2 })];
    expect(buySteps(detail({ trucks: done }), true)[1]).toMatchObject({ word: "Delivered", done: true });
  });
  it("is Arrived once the stock is attached, and counts what is sold", () => {
    const here = detail({ buy: { on_the_way: false, load_id: "wl_1", stock_name: "Shoe delivery", units_bought: 110000 }, rollup: { bought: 110000, sold: 1000 } });
    const s = buySteps(here, true);
    expect(s[2]).toMatchObject({ word: "In the warehouse", done: true });
    expect(s[3]).toMatchObject({ word: "Selling", line: "1,000 of 110,000 sold", done: false });
    expect(buySteps(detail({ buy: { on_the_way: false }, rollup: { bought: 10, sold: 10, sold_out: true } }), true)[3]).toMatchObject({ word: "Sold out", done: true });
  });
});

describe("what a unit costs", () => {
  it("shows four places under $10 and cents above, never fewer than two", () => {
    expect(perUnit(1.2827)).toBe("$1.2827");
    expect(perUnit(1.25)).toBe("$1.25");
    expect(perUnit(0.03)).toBe("$0.03");
    expect(perUnit(0.0027)).toBe("$0.0027");
    expect(perUnit(9.5)).toBe("$9.50");
    expect(perUnit(12.3456)).toBe("$12.35");
    expect(perUnit(0)).toBe("$0.00");
  });
  it("words the cost line with its parts", () => {
    expect(costEachLine({ goods: 1.25, ship: 0.03, markup: 0.0027 }, "pair")).toBe("Each pair costs $1.28 with shipping in ($1.25 goods, $0.03 trucks). Logistics markup on the trucks, $0.0027 a pair, is not in this cost: it is his pay, taken off the split.");
    expect(costEachLine({ goods: 1.25, ship: 0, markup: 0 }, "unit")).toBe("Each unit costs $1.25.");
    expect(costEachLine({ goods: 1.25, ship: 0.0327, markup: 0 }, "unit")).toBe("Each unit costs $1.2827 with shipping in ($1.25 goods, $0.0327 trucks).");
  });
});

describe("the cost and profit on an invoice", () => {
  // 110,000 pairs at $1.25 and $3,600 of trucks: the example from the plan.
  const unit = { unitGoods: 1.25, unitShip: 3600 / 110000, unitMarkup: 0 };
  it("costs the count from the unrounded unit figures", () => {
    const c = invoiceCost({ ...unit, count: 1000, charging: 2000 });
    expect(c.cost).toBe(1282.73);
    expect(c.profit).toBe(717.27);
    expect(c.margin).toBe(35.9);
    expect(perUnit(c.each)).toBe("$1.2827");
  });
  it("says the two sentences, with the profit once something is charged", () => {
    const c = invoiceCost({ ...unit, count: 1000, charging: 2000 });
    expect(invoiceCostLines(c, { count: 1000, unitShip: unit.unitShip, unitMarkup: 0, typed: false })).toEqual([
      "$1.2827 each with shipping in ($1.25 + $0.0327)",
      "1,000 cost you $1,282.73. You are charging $2,000.00: profit $717.27 (35.9%)",
    ]);
    const none = invoiceCost({ ...unit, count: 1000, charging: 0 });
    expect(none.margin).toBeNull();
    expect(invoiceCostLines(none, { count: 1000, unitShip: unit.unitShip, unitMarkup: 0, typed: false })[1]).toBe("1,000 cost you $1,282.73.");
  });
  it("never counts his markup in the cost, and names it apart (R-576)", () => {
    const c = invoiceCost({ unitGoods: 1.25, unitShip: 0.03, unitMarkup: 0.0027, count: 100, charging: 200 });
    expect([c.cost, c.profit, c.markup]).toEqual([128, 72, 0.27]);
    const [first, second] = invoiceCostLines(c, { count: 100, unitShip: 0.03, unitMarkup: 0.0027, typed: false });
    expect(first).toBe("$1.28 each with shipping in ($1.25 + $0.03)");
    expect(second).toBe("100 cost you $128.00. You are charging $200.00: profit $72.00 (36.0%). Logistics markup on these, $0.27, is not in the cost: it comes off the split.");
  });
  it("stands a typed goods share in for the worked-out one", () => {
    const c = invoiceCost({ ...unit, count: 1000, goodsTyped: 1500, charging: 2000 });
    expect(c.cost).toBe(1532.73);
    expect(c.eachGoods).toBe(1.5);
    expect(invoiceCostLines(c, { count: 1000, unitShip: unit.unitShip, unitMarkup: 0, typed: true })[0]).toContain("with the cost you typed");
  });
  it("shows a loss as a negative profit and a negative margin", () => {
    const c = invoiceCost({ ...unit, count: 1000, charging: 1000 });
    expect(c.profit).toBe(-282.73);
    expect(c.margin).toBe(-28.3);
    expect(invoiceCostLines(c, { count: 1000, unitShip: unit.unitShip, unitMarkup: 0, typed: false })[1]).toBe("1,000 cost you $1,282.73. You are charging $1,000.00: profit -$282.73 (-28.3%)");
  });
  it("charges only the lines that are not shipping, and leaves what the buyer pays for shipping out", () => {
    expect(chargingOf([
      { description: "Pallet of hats", amount: 1500 },
      { description: "Freight", amount: 300 },
      { description: "Shipping and handling", amount: 50 },
      { description: "Extra case", amount: 500.5 },
      { description: "", amount: 99 },
    ])).toBe(2000.5);
    expect(chargingOf([])).toBe(0);
  });
});
