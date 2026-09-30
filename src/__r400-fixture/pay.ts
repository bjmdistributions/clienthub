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
  enabled: true, payee_id: PAYEE.id, payee_name: PAYEE.name, share_pct: 100, cover_losses: true, loss_pay_pct: 10,
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
    due_date: day(nextFri), charged: 400, freight: 330, surplus: 70, rule: "share", pay: 70, freight_source: "mixed" }),
  line({ deal_flow_id: "d3", invoice_number: "INV-6003", client_name: "Northgate Outlet", booking_codes: ["L-C20E8B"], earned_on: day(shift(today, -1)),
    due_date: day(nextFri), charged: 500, freight: 0, surplus: 500, rule: "pending", pay: null, owed: 0, pending: true, freight_source: "quote" }),
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

export const tracker = () => ({
  settings: { ...settings }, today: day(today), ...totals(),
  lines: JSON.parse(JSON.stringify(lines)), dates: JSON.parse(JSON.stringify(dates)), payouts: JSON.parse(JSON.stringify(payouts)),
});

/** What the payee sees: his pay only. Names follow his permission switch. */
export const mine = (canNames: boolean) => ({
  enabled: settings.enabled, ...totals(), method: settings.method,
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
    Object.assign(settings, body, { updated_at: `${day(today)}T12:00:00Z`, updated_by_name: "Owner" });
    delete settings.today;
    return { ...settings };
  }
  if (method === "GET" && p.endsWith("/tracker")) return tracker();
  if (method === "GET" && p.endsWith("/mine")) return mine(canNames);
  if (method === "POST" && p.endsWith("/payouts")) {
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
