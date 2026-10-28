import type { FreightBooking, FreightStop } from "./api";

// R-558: a load as the one message the logistics person copies and sends out to get the truck booked, in the shape
// Jack gave: the pickup and where its BOL goes, the delivery, then the truck, the freight, the delivery day and who
// the driver calls. And what Send to logistics needs before it goes, so that message is always whole.
// Twins of the website's lgBookingText / lgSendMissing in app.js; both read bookingText.cases.json.

type Src = Pick<FreightBooking,
  "pickup_name" | "pickup_address" | "pickup_phone" | "pickup_date" | "pickup_window" | "pickup_notes" |
  "delivery_name" | "delivery_address" | "delivery_phone" | "delivery_date" | "delivery_window" | "delivery_notes" |
  "equipment" | "pallets" | "weight_lbs" | "dimensions"
> & { extra_pickups?: Pick<FreightStop, "name" | "address" | "phone" | "window" | "notes">[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ymd = (s: string | undefined) => /^(\d{4})-(\d{2})-(\d{2})/.exec((s || "").trim());
const lines = (s: string | undefined) => (s || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const words = (...parts: (string | undefined)[]) => parts.map((p) => (p || "").trim()).filter(Boolean).join(" ");

/** 13000 reads 13,000 lbs; anything typed that is not a plain number is kept as typed. */
function weightWords(raw: string | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "";
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? `${n.toLocaleString("en-US")} lbs` : t;
}

export function bookingText(b: Src): string {
  const out: string[] = [];
  const block = (title: string, body: string[]) => {
    const kept = body.filter(Boolean);
    if (!kept.length) return;
    if (out.length) out.push("");
    out.push(title, ...kept);
  };
  const pd = ymd(b.pickup_date);
  const pickWhen = words(b.pickup_window, pd ? `${+pd[2]}/${+pd[3]}` : "");
  block("Pickup location:", [
    ...lines(b.pickup_name), ...lines(b.pickup_address), ...lines(b.pickup_phone), pickWhen ? `Pick up ${pickWhen}` : "", ...lines(b.pickup_notes),
  ]);
  (b.extra_pickups ?? []).forEach((x, i) => block(`Pickup location ${i + 2}:`, [
    ...lines(x.name), ...lines(x.address), ...lines(x.phone), (x.window || "").trim() ? `Pick up ${x.window.trim()}` : "", ...lines(x.notes),
  ]));
  block("Deliver to:", [...lines(b.delivery_name), ...lines(b.delivery_address)]);
  const dd = ymd(b.delivery_date);
  const dropWhen = words(b.delivery_window, dd ? `${MONTHS[+dd[2] - 1]} ${+dd[3]}, ${dd[1]}` : "");
  const phone = (b.delivery_phone || "").trim(), note = lines(b.delivery_notes).join(" ");
  const lbs = weightWords(b.weight_lbs);
  const truck = [
    (b.equipment || "").trim(),
    (b.pallets || "").trim() ? `Pallets: ${b.pallets.trim()}` : "",
    lbs ? `Weight: ${lbs}` : "",
    (b.dimensions || "").trim() ? `Dimensions: ${b.dimensions.trim()}` : "",
    dropWhen ? `Delivery: ${dropWhen}` : "",
    phone && note ? `Call ${phone} (${note})` : phone ? `Call ${phone}` : note,
  ].filter(Boolean);
  if (truck.length) { if (out.length) out.push(""); out.push(...truck); }
  return out.join("\n");
}

/** What Send to logistics takes before it goes. `bol_to` is the email the BOL is sent to, kept on the load as a pickup note. */
export interface SendFields {
  pickup_name: string; pickup_address: string; pickup_phone: string; pickup_date: string; pickup_window: string; bol_to: string;
  delivery_name: string; delivery_address: string; delivery_phone: string; delivery_date: string; equipment: string;
  pallets: string; weight_lbs: string; dimensions: string;
}

const NEED: [keyof SendFields, string][] = [
  ["pickup_name", "the pickup name"], ["pickup_address", "the pickup address"], ["pickup_phone", "the pickup phone"],
  ["pickup_date", "the pickup day"], ["pickup_window", "the pickup time"], ["bol_to", "who gets the BOL"],
  ["delivery_name", "the delivery name"], ["delivery_address", "the delivery address"], ["delivery_phone", "the delivery phone"],
  ["delivery_date", "the delivery day"], ["equipment", "the equipment"],
];
/** R-415: the freight only while the team fills it in; otherwise the logistics person does. */
const FREIGHT: [keyof SendFields, string][] = [["pallets", "the pallets"], ["weight_lbs", "the weight"], ["dimensions", "the pallet dimensions"]];

/** The sentence that stops a send, or "" when everything is there. */
export function sendMissing(f: SendFields, freightByTeam: boolean): string {
  const gaps = [...NEED, ...(freightByTeam ? FREIGHT : [])].filter(([k]) => !(f[k] || "").trim()).map(([, label]) => label);
  if (gaps.length) {
    const list = gaps.length === 1 ? gaps[0] : `${gaps.slice(0, -1).join(", ")} and ${gaps[gaps.length - 1]}`;
    return `Fill in ${list} first.`;
  }
  if (!f.bol_to.includes("@")) return "Write the email address the BOL goes to.";
  return "";
}

/** The pickup note a send writes, in Jack's words. */
export const bolNote = (email: string) => `Send BOL to: ${email.trim()} with me in copy`;
