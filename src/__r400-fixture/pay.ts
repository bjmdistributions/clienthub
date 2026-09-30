// DEV ONLY (harness data for R-401). Every person, place and figure is invented. It stands in for
// the server's /api/logistics/pay/* routes: the settings, the tracker, the payee's own view, and
// recording or undoing a payment. The dates follow today, so the screens always show a payment
// that is due, one that was paid, and the next one.
import { localDay } from "../lib/format";

const day = (d: Date) => localDay(d);
const shift = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = new Date();
// The first Friday strictly after today, then the two before it.
const nextFri = (() => { let d = shift(today, 1); while (d.getDay() !== 5) d = shift(d, 1); return d; })();
const dueFri = shift(nextFri, -7);
const paidFri = shift(nextFri, -14);

const PAYEE = { id: "u2", name: "Ines Okafor" };

export const settings: any = {
  enabled: true, surplus_mode: "pay", payee_id: PAYEE.id, payee_name: PAYEE.name, share_pct: 100, cover_losses: true, loss_pay_pct: 10,
  frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1, method: "Zelle", details: "ines@example.test",
  updated_at: `${day(shift(today, -6))}T12:00:00Z`, updated_by_name: "Owner",
};

const line = (o: any) => ({ paid: 0, owed: o.pay ?? 0, pending: false, freight_source: "paid", charged_source: "lines", ...o });

export const lines: any[] = [
  line({ deal_flow_id: "d9", invoice_number: "INV-6009", client_name: "Tidewater Surplus", booking_codes: ["L-B1A2C3"], earned_on: day(shift(paidFri, -3)),
    due_date: day(paidFri), charged: 620, freight: 410, surplus: 210, rule: "share", pay: 210, paid: 210, owed: 0 }),
  line({ deal_flow_id: "d8", invoice_number: "INV-6008", client_name: "Lakeside Discount Co", booking_codes: ["L-7F3K2A"], earned_on: day(shift(dueFri, -4)),
    due_date: day(dueFri), charged: 500, freight: 350, surplus: 150, rule: "share", pay: 150 }),
  line({ deal_flow_id: "d6", invoice_number: "INV-6006", client_name: "Cedar Row Resale", booking_codes: ["L-E42A1D"], earned_on: day(shift(dueFri, -2)),
    due_date: day(dueFri), charged: 300, freight: 350, surplus: -50, rule: "loss_cover", pay: 35, freight_source: "bank" }),
  line({ deal_flow_id: "d7", invoice_number: "INV-6007", client_name: "Marlow Traders", booking_codes: ["L-F53B2E"], earned_on: day(shift(nextFri, -2)),
    due_date: day(nextFri), charged: 400, freight: 330, surplus: 70, rule: "share", pay: 70 }),
  line({ deal_flow_id: "d3", invoice_number: "INV-6003", client_name: "Northgate Outlet", booking_codes: ["L-C20E8B"], earned_on: day(shift(today, -1)),
    due_date: day(nextFri), charged: 500, freight: 0, surplus: 500, rule: "pending", pay: null, owed: 0, pending: true }),
];

export const dates: any[] = [
  { pay_date: day(paidFri), period_start: day(shift(paidFri, -7)), period_end: day(shift(paidFri, -1)), total: 210, carried_in: 0, status: "paid", payout_id: "lp_a1" },
  { pay_date: day(dueFri), period_start: day(shift(dueFri, -7)), period_end: day(shift(dueFri, -1)), total: 185, carried_in: 0, status: "due", payout_id: null },
  { pay_date: day(nextFri), period_start: day(shift(nextFri, -7)), period_end: day(shift(nextFri, -1)), total: 70, carried_in: 0, status: "upcoming", payout_id: null },
];

export const payouts: any[] = [
  { id: "lp_a1", payee_id: PAYEE.id, payee_name: PAYEE.name, pay_date: day(paidFri), period_start: day(shift(paidFri, -7)), period_end: day(shift(paidFri, -1)),
    amount: 210, lines_json: "[]", method: "Zelle", reference: "", note: "", paid_at: day(shift(paidFri, 0)), created_by_name: "Owner", created_at: `${day(paidFri)}T15:00:00Z` },
];

const totals = () => {
  const due = dates.filter((d) => d.status === "due").reduce((s, d) => s + d.total, 0);
  const next = dates.find((d) => d.status === "upcoming");
  return { next_pay_date: next?.pay_date ?? "", next_total: next?.total ?? 0, due_now_total: due };
};

export const tracker = () => {
  const copy = (x: any) => JSON.parse(JSON.stringify(x));
  if (settings.enabled && settings.surplus_mode === "track") {
    // R-415: the surplus is only tracked. Each load keeps its charged, freight and surplus, pays 0 and owes nothing;
    // a load paid before the switch keeps what it was paid. No pay dates.
    const tl = copy(lines).map((l: any) => (l.paid > 0 || l.pending ? { ...l, owed: 0 } : { ...l, rule: "tracked", pay: 0, owed: 0 }));
    const known = tl.filter((l: any) => !l.pending);
    const sum = (f: (l: any) => number) => Math.round(known.reduce((n: number, l: any) => n + f(l), 0) * 100) / 100;
    return {
      settings: { ...settings }, today: day(today), next_pay_date: "", next_total: 0, due_now_total: 0, mode: "track",
      lines: tl, dates: [], payouts: copy(payouts),
      totals: { charged: sum((l) => l.charged), freight: sum((l) => l.freight), surplus: sum((l) => l.surplus), loads: tl.length, pending_loads: tl.length - known.length },
    };
  }
  return { settings: { ...settings }, today: day(today), ...totals(), mode: "pay", lines: copy(lines), dates: copy(dates), payouts: copy(payouts) };
};

// R-415: who fills in the freight, and every shipment on our side. Dates follow today, so "This
// month" always has rows and "Last month" has the old one.
export const r415 = { byTeam: true };
const back = (n: number) => day(shift(today, -n));
const truck = (id: string, status: string, o: any = {}) => ({
  id: "fb_" + id + "0000", code: "L-" + id.toUpperCase(), status, carrier: "Ridgeway Freight", broker: "", bol: "", pro: "", pickup_date: "", delivery_date: "",
  delivered_at: "", paid_amount: null, paid_at: "", paid_method: "", booked_at: "", updated_by_name: "Ines Okafor", ...o,
});
const SHIP_DEALS: any[] = [
  { deal_flow_id: "d8", invoice_number: "INV-6008", client_name: "Lakeside Discount Co", stage: "payment_received", billed: 500, billed_source: "lines", linked: 0, pay: 150, rule: "share",
    earned_on: back(1), day: back(1), trucks: [truck("7f3k2a", "delivered", { paid_amount: 350, paid_at: back(1), paid_method: "ACH", booked_at: back(1), delivered_at: back(1) })] },
  { deal_flow_id: "d9", invoice_number: "INV-6009", client_name: "Tidewater Surplus", stage: "complete", billed: 620, billed_source: "lines", linked: 0, pay: 210, rule: "share",
    earned_on: back(3), day: back(3), trucks: [truck("b1a2c3", "delivered", { carrier: "Bluefield Lines", paid_amount: 410, paid_at: back(3), paid_method: "Card", booked_at: back(3) })] },
  { deal_flow_id: "d6", invoice_number: "INV-6006", client_name: "Cedar Row Resale", stage: "supplier_paid", billed: 300, billed_source: "field", linked: 0, pay: 35, rule: "loss_cover",
    earned_on: back(8), day: back(8), trucks: [truck("e42a1d", "delivered", { paid_amount: 350, paid_at: back(8), paid_method: "ACH", booked_at: back(8) })] },
  { deal_flow_id: "d3", invoice_number: "INV-6003", client_name: "Northgate Outlet", stage: "invoiced", billed: 500, billed_source: "lines", linked: 0, pay: null, rule: "",
    earned_on: "", day: back(10), trucks: [truck("c20e8b", "picked_up", { booked_at: back(10) })] },
  { deal_flow_id: "d7", invoice_number: "INV-6007", client_name: "Marlow Traders", stage: "payment_received", billed: 800, billed_source: "lines", linked: 0, pay: null, rule: "",
    earned_on: "", day: back(45), trucks: [
      truck("f53b2e", "delivered", { paid_amount: 300, paid_at: back(40), paid_method: "Check", booked_at: back(45) }),
      truck("a77c10", "booked", { carrier: "Bluefield Lines", booked_at: back(44) }),
      truck("0d9e44", "cancelled", { carrier: "Summit Load Desk" }),
    ] },
];
export function shipments(query: string): any {
  const p = new URLSearchParams(query);
  const from = p.get("from") || "", to = p.get("to") || "";
  const live = (d: any) => d.trucks.filter((t: any) => t.status !== "cancelled");
  const deals = SHIP_DEALS.filter((d) => (!from || d.day >= from) && (!to || d.day <= to)).sort((a, b) => b.day.localeCompare(a.day)).map((d) => {
    const paid = live(d).reduce((n: number, t: any) => n + (t.paid_amount ?? 0), 0);
    const unpaid = live(d).some((t: any) => t.paid_amount == null);
    return { ...d, paid, freight: paid, surplus: unpaid ? null : Math.round((d.billed - paid) * 100) / 100 };
  });
  const known = deals.filter((d) => d.surplus != null);
  const sum = (f: (d: any) => number) => Math.round(known.reduce((n, d) => n + f(d), 0) * 100) / 100;
  return {
    deals,
    totals: {
      deals: deals.length, trucks: deals.reduce((n, d) => n + live(d).length, 0), billed: sum((d) => d.billed), paid: sum((d) => d.paid), surplus: sum((d) => d.surplus),
      pay: deals.reduce((n, d) => n + (d.pay ?? 0), 0), waiting: deals.length - known.length, mode: !settings.enabled ? "off" : settings.surplus_mode,
    },
  };
}

/** Answers /api/logistics/settings and /api/logistics/shipments, or undefined when the path is not one. */
export function r415Route(method: string, path: string, body: any, who: "owner" | "payee"): any {
  const [p, qs = ""] = path.split("?");
  if (p === "/api/logistics/settings") {
    if (method === "GET") return { freight_by_team: r415.byTeam };
    if (method === "PUT") {
      if (who !== "owner") return Promise.reject("Only an admin can change that.");
      r415.byTeam = body.freight_by_team !== false;
      return { freight_by_team: r415.byTeam };
    }
  }
  if (p === "/api/logistics/shipments" && method === "GET") {
    return who === "owner" ? shipments(qs) : Promise.reject("You do not have access to that.");
  }
  return undefined;
}

/** What the payee sees: his pay only. Names follow his permission switch. */
export const mine = (canNames: boolean) => ({
  enabled: settings.enabled && settings.surplus_mode !== "track", ...totals(), method: settings.method,
  dates: dates.map((d) => ({ pay_date: d.pay_date, total: d.total, status: d.status, paid_at: d.status === "paid" ? day(paidFri) : "" })),
  loads: lines.map((l) => ({
    code: l.booking_codes[0], pickup_name: canNames ? "Northgate Wholesale" : "", delivery_name: canNames ? l.client_name : "",
    earned_on: l.earned_on, due_date: l.due_date, amount: l.pay ?? 0,
    status: l.pending ? "pending" : l.owed === 0 ? "paid" : "earned",
  })),
});

/** Answers a /api/logistics/pay/* request, or returns undefined when the path is not one. */
export function payRoute(method: string, path: string, body: any, who: "owner" | "payee", canNames = true): any {
  const [p] = path.split("?");
  if (!p.startsWith("/api/logistics/pay/")) return undefined;
  if (method === "GET" && p.endsWith("/settings")) {
    return who === "owner" ? { ...settings }
      : { enabled: settings.enabled, frequency: settings.frequency, pay_weekday: settings.pay_weekday, anchor_date: settings.anchor_date,
          pay_day_of_month: settings.pay_day_of_month, method: settings.method, details: settings.details };
  }
  if (who !== "owner" && !p.endsWith("/mine")) return Promise.reject("You do not have access to that.");
  if (method === "PUT" && p.endsWith("/settings")) {
    if (!(body.share_pct >= 0 && body.share_pct <= 100)) return Promise.reject("The share must be between 0 and 100 percent.");
    if (!["pay", "track"].includes(body.surplus_mode)) return Promise.reject("Choose to pay the surplus or only track it.");
    if (body.enabled && body.surplus_mode === "pay" && !body.payee_id) return Promise.reject("Choose who gets the logistics pay.");
    Object.assign(settings, body, { updated_at: `${day(today)}T12:00:00Z`, updated_by_name: "Owner" });
    delete settings.today;
    return { ...settings };
  }
  if (method === "GET" && p.endsWith("/tracker")) return tracker();
  if (method === "GET" && p.endsWith("/mine")) return mine(canNames);
  if (method === "POST" && p.endsWith("/payouts")) {
    if (settings.enabled && settings.surplus_mode === "track") return Promise.reject("Logistics pay is set to track the surplus only.");
    const d = dates.find((x) => x.pay_date === body.pay_date && x.status === "due");
    if (!d) return Promise.reject("Nothing is owed for that pay date.");
    const id = "lp_" + Math.random().toString(16).slice(2, 10);
    d.status = "paid"; d.payout_id = id;
    payouts.push({ id, payee_id: PAYEE.id, payee_name: PAYEE.name, pay_date: d.pay_date, period_start: d.period_start, period_end: d.period_end, amount: d.total,
      lines_json: "[]", method: body.method || "", reference: body.reference || "", note: body.note || "", paid_at: body.today || day(today), created_by_name: "Owner", created_at: `${day(today)}T12:00:00Z` });
    for (const l of lines) if (l.due_date === d.pay_date && !l.pending) { l.paid = l.pay; l.owed = 0; }
    return payouts[payouts.length - 1];
  }
  const m = /\/payouts\/(.+)$/.exec(p);
  if (method === "DELETE" && m) {
    const d = dates.find((x) => x.payout_id === m[1]);
    if (!d) return Promise.reject("That payment was not found.");
    d.status = d.pay_date <= day(today) ? "due" : "upcoming"; d.payout_id = null;
    payouts.splice(payouts.findIndex((x) => x.id === m[1]), 1);
    for (const l of lines) if (l.due_date === d.pay_date && !l.pending) { l.owed = l.pay ?? 0; l.paid = 0; }
    return { ok: true };
  }
  return Promise.reject("That request is not allowed here.");
}
