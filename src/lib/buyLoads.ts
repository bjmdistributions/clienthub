// R-551: a buy started in Deal Flow before its stock is here, and brought in on logistics trucks. Everything here takes
// values and returns values so the rules are tested without a screen: how a buy's truck is named, where its steps stand,
// what a unit costs with the shipping in and his markup, and the cost and profit on an invoice made from its stock.
// buy_core.rs works the shares out; this only words them.

import type { BuyDetail, FreightStatus, TruckRow } from "./api";
import { fmtAmount, isShippingLine } from "./format";
import { dayAndTime } from "./logisticsLoad";

/** A person asked for one buy (Logistics, the Warehouse): Deal Flow's Inventory opens on it. */
export const OPEN_BUY_KEY = "dealflow_open_buy";

/** Go to a buy in Deal Flow > Inventory. */
export function openBuyInDealFlow(id: string): void {
  try { localStorage.setItem(OPEN_BUY_KEY, id); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "dealflow" }));
}

/** Add the manifest on a buy still on the way: the Warehouse opens the one import for it (read once, on arriving). */
export const ADD_MANIFEST_KEY = "warehouse_add_manifest_for";

/** Go to the Warehouse's import for a buy: the delivery (or product) it makes becomes the buy's stock. */
export function openManifestForBuy(b: { id: string; name: string }): void {
  try { localStorage.setItem(ADD_MANIFEST_KEY, JSON.stringify(b)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "warehouse" }));
}

// ─── how a buy's truck reads ──────────────────────────────────────────────

/** Where a deal's client and invoice would read: "Coming in: Sample hats", and ", truck 1 of 2" when the buy has more than one. */
export function comingLabel(name: string, truckNo = 0, trucks = 0): string {
  const base = `Coming in: ${name}`;
  return trucks > 1 && truckNo > 0 ? `${base}, truck ${truckNo} of ${trucks}` : base;
}

/** Who a logistics pay line is for: the buy the trucks bring in, or a deal's invoice and client. */
export function payLineWho(l: { invoice_number: string; client_name: string; buy_name?: string }): string {
  return l.buy_name ? comingLabel(l.buy_name) : `${l.invoice_number}${l.client_name ? ` for ${l.client_name}` : ""}`;
}

/** The label of a load that brings a buy in, "" for a deal's load. */
export function buyLabelOf(b: { buy?: { name: string; truck_no: number; trucks: number } | null }): string {
  return b.buy ? comingLabel(b.buy.name, b.buy.truck_no, b.buy.trucks) : "";
}

/** "Truck 1 of 2". Nothing for a buy with a single truck, or one that was cancelled. */
export const truckWord = (t: { truck_no: number; trucks: number }): string => (t.trucks > 1 && t.truck_no > 0 ? `Truck ${t.truck_no} of ${t.trucks}` : "");

// ─── where a buy's trucks stand ───────────────────────────────────────────

export type ComingState = "none" | "waiting" | "quoted" | "booked" | "delivered";

/** The one word for a buy's trucks: waiting for a quote while any is, delivered once every live one is, booked once every
 *  live one is booked or moving, quoted in between. A cancelled truck is out of it. */
export function comingState(trucks: { status: FreightStatus | string }[]): ComingState {
  const live = trucks.filter((t) => t.status !== "cancelled");
  if (live.length === 0) return "none";
  if (live.some((t) => t.status === "quote")) return "waiting";
  if (live.every((t) => t.status === "delivered")) return "delivered";
  if (live.every((t) => t.status === "booked" || t.status === "picked_up" || t.status === "delivered")) return "booked";
  return "quoted";
}

export const COMING_WORD: Record<ComingState, string> = {
  none: "No truck yet", waiting: "Waiting for quotes", quoted: "Quoted", booked: "Booked", delivered: "Delivered",
};
export const COMING_TONE: Record<ComingState, "neutral" | "warning" | "step" | "shipping" | "success"> = {
  none: "neutral", waiting: "warning", quoted: "step", booked: "shipping", delivered: "success",
};

/** When a truck is to arrive (or did): "Oct 23, 9:00 am". */
export function truckWhen(t: Pick<TruckRow, "delivery_date" | "delivery_appt_time" | "delivered_at" | "delivered_time">): string {
  return t.delivered_at ? `Delivered ${dayAndTime(t.delivered_at, t.delivered_time)}` : dayAndTime(t.delivery_date, t.delivery_appt_time);
}

/** The pickups-to-arrivals of a coming buy in one line: "Oct 23, 9:00 am and Oct 23, 1:00 pm". */
export function truckDays(trucks: Pick<TruckRow, "status" | "delivery_date" | "delivery_appt_time" | "delivered_at" | "delivered_time">[]): string {
  return trucks.filter((t) => t.status !== "cancelled").map(truckWhen).filter(Boolean).join(" and ");
}

// ─── the four steps across the top of a buy ───────────────────────────────

export type StepKey = "paid" | "ship" | "arrived" | "selling";
export type StepTone = "success" | "warning" | "neutral" | "step" | "shipping";
export interface BuyStep { key: StepKey; label: string; word: string; line: string; tone: StepTone; done: boolean }

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");

/** Paid, Shipping in, Arrived, Selling: each a pill (`word`, `tone`) and a line. Paid is the goods paid against what you pay;
 *  Shipping in is done once every live truck is delivered; Arrived once the stock is attached; Selling once it is sold out.
 *  `numbers`: dollar figures only for someone who may see them. */
export function buySteps(d: BuyDetail, numbers: boolean): BuyStep[] {
  const r = d.rollup;
  const owed = d.buy.goods_total;
  const paidAll = owed <= 0.005 || r.goods_paid + 0.005 >= owed;
  const paid: BuyStep = paidAll
    ? { key: "paid", label: "Paid", word: "Paid", line: owed > 0.005 && numbers ? fmtAmount(owed) : "", tone: "success", done: true }
    : r.goods_paid > 0.005
      ? { key: "paid", label: "Paid", word: "Part paid", line: numbers ? `${fmtAmount(r.goods_paid)} of ${fmtAmount(owed)}` : "", tone: "warning", done: false }
      : { key: "paid", label: "Paid", word: "Not paid yet", line: numbers ? `${fmtAmount(owed)} to pay` : "", tone: "warning", done: false };

  const tc = d.truck_cost;
  const state = comingState(d.trucks);
  const delivered = tc.live > 0 && state === "delivered";
  const ship: BuyStep = tc.live === 0
    ? { key: "ship", label: "Shipping in", word: COMING_WORD.none, line: "Send to logistics", tone: "neutral", done: false }
    : {
      key: "ship", label: "Shipping in", word: COMING_WORD[state],
      line: `${tc.live} ${tc.live === 1 ? "truck" : "trucks"}${numbers && tc.carrier > 0.005 ? `, ${fmtAmount(tc.carrier)} so far` : ""}`,
      tone: COMING_TONE[state], done: delivered,
    };

  const here = !d.buy.on_the_way;
  const arrived: BuyStep = here
    ? { key: "arrived", label: "Arrived", word: "In the warehouse", line: d.buy.stock_name, tone: "success", done: true }
    : { key: "arrived", label: "Arrived", word: "Not here yet", line: "Add the manifest", tone: "neutral", done: false };

  const selling: BuyStep = !here
    ? { key: "selling", label: "Selling", word: "Waiting for stock", line: "", tone: "neutral", done: false }
    : { key: "selling", label: "Selling", word: r.sold_out ? "Sold out" : r.sold > 0 ? "Selling" : "Not started", line: `${n0(r.sold)} of ${n0(r.bought)} sold`, tone: r.sold_out ? "success" : "neutral", done: r.sold_out };
  return [paid, ship, arrived, selling];
}

// ─── the cost of a unit ───────────────────────────────────────────────────

/** A price a unit: cents as usual, and up to four places under $10 ($1.2827), never fewer than two. */
export const perUnit = (n: number): string =>
  Math.abs(n) < 10 && Math.abs(n) > 0 ? `$${n.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1")}` : fmtAmount(n);

/** "Each costs $1.2827 with shipping in ($1.25 goods, $0.03 trucks, $0.0027 his markup)". */
export function costEachLine(unit: { goods: number; ship: number; markup: number }, one: string): string {
  const each = unit.goods + unit.ship + unit.markup;
  const parts = [
    `${perUnit(unit.goods)} goods`,
    ...(unit.ship > 0 ? [`${perUnit(unit.ship)} trucks`] : []),
    ...(unit.markup > 0 ? [`${perUnit(unit.markup)} his markup`] : []),
  ];
  return `Each ${one} costs ${perUnit(each)}${unit.ship > 0 ? " with shipping in" : ""}${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`;
}

// ─── the cost and profit on an invoice made from a buy's stock ────────────

const r2 = (x: number) => Math.round(x * 100) / 100 + 0;

/** What the invoice charges for the goods: every line that is not a shipping line, live as the lines change. */
export function chargingOf(items: { description?: string | null; amount?: number | null }[]): number {
  return r2(items.filter((it) => !isShippingLine(it.description)).reduce((s, it) => s + (Number(it.amount) || 0), 0));
}

export interface InvoiceCost {
  /** Cost each: goods, shipping in and his markup. */
  each: number;
  /** The goods share of one (the typed one when the share was typed). */
  eachGoods: number;
  cost: number;
  charging: number;
  profit: number;
  /** Profit over what is charged, as a percent to one decimal. null while nothing is charged. */
  margin: number | null;
}

/** The cost of `count` units and the profit against what the invoice charges. The units come from `unit_goods`, `unit_ship` and
 *  `unit_markup` unrounded, so 1,000 units cost what 1,000 of the buy cost, not 1,000 of a rounded price. A typed goods share
 *  stands in for the worked-out goods. Shipping charged to the buyer is left out of `charging`: that truck's cost is not known. */
export function invoiceCost(o: { unitGoods: number; unitShip: number; unitMarkup: number; count: number; goodsTyped?: number | null; charging: number }): InvoiceCost {
  const count = Math.max(0, o.count);
  const goods = o.goodsTyped != null ? o.goodsTyped : count * o.unitGoods;
  const total = goods + count * o.unitShip + count * o.unitMarkup;
  const cost = r2(total);
  const charging = r2(o.charging);
  const profit = r2(charging - cost);
  return {
    each: count > 0 ? total / count : o.unitGoods + o.unitShip + o.unitMarkup,
    eachGoods: count > 0 ? goods / count : o.unitGoods,
    cost, charging, profit,
    margin: charging > 0.005 ? Math.round((profit / charging) * 1000) / 10 : null,
  };
}

/** The two sentences under an invoice's lines. The second leaves its profit out until something is charged. */
export function invoiceCostLines(c: InvoiceCost, o: { count: number; unitShip: number; unitMarkup: number; typed: boolean }): [string, string] {
  const parts = [perUnit(c.eachGoods), ...(o.unitShip > 0 ? [perUnit(o.unitShip)] : []), ...(o.unitMarkup > 0 ? [perUnit(o.unitMarkup)] : [])];
  const first = `${perUnit(c.each)} each${o.unitShip > 0 ? " with shipping in" : ""}${parts.length > 1 ? ` (${parts.join(" + ")})` : ""}${o.typed ? ", with the cost you typed" : ""}`;
  const second = `${n0(o.count)} cost you ${fmtAmount(c.cost)}.${c.charging > 0.005
    ? ` You are charging ${fmtAmount(c.charging)}: profit ${fmtAmount(c.profit)}${c.margin != null ? ` (${c.margin.toFixed(1)}%)` : ""}`
    : ""}`;
  return [first, second];
}
