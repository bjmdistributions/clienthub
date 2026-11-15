import type { FreightPlace } from "./api";
import { FREIGHT, NEED, type SendFields } from "./bookingText";
import { addressLack } from "./fullAddress";

// R-651: the Send to logistics form as one value, so it can be saved as a draft (on the server, for every device) and
// read back, and so what each section still needs is worked out in one place. The field names are the create
// payload's; the website's lgSendForm uses the same ones, so a draft started on one surface opens on the other.

/** An extra pickup on the same truck. */
export interface SendStop { name: string; address: string; phone: string; window: string }

export interface SendForm {
  urgent: boolean;
  pickup_name: string; pickup_address: string; pickup_phone: string; pickup_date: string; pickup_window: string; bol_to: string;
  extra_pickups: SendStop[];
  delivery_name: string; delivery_address: string; delivery_phone: string; delivery_date: string; delivery_window: string; delivery_notes: string;
  pallets: string; pieces: string; weight_lbs: string; freight_class: string; dimensions: string; commodity: string;
  accessorials: string; equipment: string;
  request_note: string;
}

export const blankStop = (): SendStop => ({ name: "", address: "", phone: "", window: "" });

export const blankSendForm = (): SendForm => ({
  urgent: false,
  pickup_name: "", pickup_address: "", pickup_phone: "", pickup_date: "", pickup_window: "", bol_to: "",
  extra_pickups: [],
  delivery_name: "", delivery_address: "", delivery_phone: "", delivery_date: "", delivery_window: "", delivery_notes: "",
  pallets: "", pieces: "", weight_lbs: "", freight_class: "", dimensions: "", commodity: "", accessorials: "", equipment: "",
  request_note: "",
});

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A saved draft read back: only the form's own keys, each the type the form holds. */
export function formFromDraft(body: Record<string, unknown> | null | undefined): SendForm {
  const f = blankSendForm();
  const b = body ?? {};
  for (const k of Object.keys(f) as (keyof SendForm)[]) {
    if (k === "urgent") f.urgent = b.urgent === true;
    else if (k === "extra_pickups") {
      const list = Array.isArray(b.extra_pickups) ? b.extra_pickups : [];
      f.extra_pickups = list.slice(0, 9).map((x) => {
        const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        return { name: str(o.name), address: str(o.address), phone: str(o.phone), window: str(o.window) };
      });
    } else (f as unknown as Record<string, string>)[k] = str(b[k]);
  }
  return f;
}

/** Whether anything has been typed or picked. */
export const isBlank = (f: SendForm): boolean => JSON.stringify(f) === JSON.stringify(blankSendForm());

export type SectionKey = "pickup" | "delivery" | "freight";

/** One thing a send still needs: the box it is about (a stop's address is `stop:<index>`), the words for it and its
 *  section. */
export interface Gap { key: string; label: string; section: SectionKey }

const SECTION: Record<keyof SendFields, SectionKey> = {
  pickup_name: "pickup", pickup_address: "pickup", pickup_phone: "pickup", pickup_date: "pickup", pickup_window: "pickup", bol_to: "pickup",
  delivery_name: "delivery", delivery_address: "delivery", delivery_phone: "delivery", delivery_date: "delivery",
  equipment: "freight", pallets: "freight", weight_lbs: "freight", dimensions: "freight",
};

/** "the pickup phone" as "Pickup phone". */
const asLabel = (s: string) => { const t = s.replace(/^the /, ""); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Everything a quote can't be asked without, in the order the screen reads: `bookingText`'s list (the same one the
 *  sentence under the button used), then what is typed but not usable yet: an email with no @, an address the server
 *  would refuse because it lacks its street, city, state or ZIP. */
export function sendGaps(f: SendForm, freightByTeam: boolean): Gap[] {
  const gaps: Gap[] = [];
  for (const [k, label] of [...NEED, ...(freightByTeam ? FREIGHT : [])]) {
    if (!(f[k] || "").trim()) gaps.push({ key: k, label: asLabel(label), section: SECTION[k] });
  }
  if (f.bol_to.trim() && !f.bol_to.includes("@")) gaps.push({ key: "bol_to", label: "A BOL email address", section: "pickup" });
  if (f.pickup_address.trim() && addressLack(f.pickup_address)) gaps.push({ key: "pickup_address", label: "The full pickup address", section: "pickup" });
  f.extra_pickups.forEach((s, i) => {
    if (s.address.trim() && addressLack(s.address)) gaps.push({ key: `stop:${i}`, label: `The full address of pickup ${i + 2}`, section: "pickup" });
    else if (s.name.trim() && !s.address.trim()) gaps.push({ key: `stop:${i}`, label: `The address of pickup ${i + 2}`, section: "pickup" });
  });
  if (f.delivery_address.trim() && addressLack(f.delivery_address)) gaps.push({ key: "delivery_address", label: "The full delivery address", section: "delivery" });
  // One line per box, the first reason kept.
  return gaps.filter((g, i) => gaps.findIndex((x) => x.key === g.key) === i);
}

/** Lowercase letters and digits, one space between words (the server's `norm` in send_drafts.rs). */
const norm = (t: string) => (t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

/** Which part of the form a place goes into: the first pickup, an extra pickup by index, or the delivery. */
export type PlaceTarget = "pickup" | "delivery" | number;

/** Whether the form already holds this place there. */
export function placeInUse(f: SendForm, target: PlaceTarget, p: FreightPlace): boolean {
  const [name, address] = target === "pickup" ? [f.pickup_name, f.pickup_address]
    : target === "delivery" ? [f.delivery_name, f.delivery_address]
    : [f.extra_pickups[target]?.name ?? "", f.extra_pickups[target]?.address ?? ""];
  return norm(name) === norm(p.name) && norm(address) === norm(p.address);
}

/** The form with a place filled in: the name and address always, and each detail the place carries (phone, time, BOL
 *  email, the driver's note) over what is there; a detail it does not carry is left as it is. The equipment and the
 *  extras a delivery used last time fill only empty boxes, as they are about the truck, not the place. */
export function applyPlace(f: SendForm, target: PlaceTarget, p: FreightPlace): SendForm {
  const keep = (v: string, cur: string) => (v.trim() ? v.trim() : cur);
  if (target === "pickup") {
    return { ...f, pickup_name: p.name, pickup_address: p.address, pickup_phone: keep(p.phone, f.pickup_phone),
      pickup_window: keep(p.window, f.pickup_window), bol_to: keep(p.bol_to, f.bol_to) };
  }
  if (target === "delivery") {
    return { ...f, delivery_name: p.name, delivery_address: p.address, delivery_phone: keep(p.phone, f.delivery_phone),
      delivery_window: keep(p.window, f.delivery_window), delivery_notes: keep(p.notes, f.delivery_notes),
      equipment: f.equipment.trim() ? f.equipment : p.equipment.trim(),
      accessorials: f.accessorials.trim() ? f.accessorials : p.accessorials.trim() };
  }
  return { ...f, extra_pickups: f.extra_pickups.map((s, i) => (i === target
    ? { name: p.name, address: p.address, phone: keep(p.phone, s.phone), window: keep(p.window, s.window) } : s)) };
}
