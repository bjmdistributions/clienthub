import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, Plus, Trash2, ExternalLink, Lock } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { api, type FreightBooking, type FreightBookingPatch, type FreightStatus } from "../lib/api";
import { fmtAmount, localDay, parseLocalDay } from "../lib/format";
import StatusPill from "./StatusPill";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";

// R-400: one booking, one truck. This drawer is the booking page for both people who open it:
// the Logistics account (who fills in everything about the shipment) and Jack (who reads it from
// a deal or from the Logistics screen). It writes only through the server's Logistics routes,
// which decide what each person may see and change, so nothing here trusts what it was handed:
// a redacted value comes back empty and is never written back.

// ─── shared words and shapes ──────────────────────────────────────────────

export const STATUS_WORD: Record<FreightStatus, string> = {
  requested: "To book", booked: "Booked", picked_up: "Picked up", delivered: "Delivered", cancelled: "Cancelled",
};
const STATUS_TONE: Record<FreightStatus, "warning" | "accent" | "success" | "neutral"> = {
  requested: "warning", booked: "accent", picked_up: "accent", delivered: "success", cancelled: "neutral",
};
const STATUS_ORDER: FreightStatus[] = ["requested", "booked", "picked_up", "delivered", "cancelled"];

export function FreightStatusPill({ status }: { status: string }) {
  const s = status as FreightStatus;
  return <StatusPill tone={STATUS_TONE[s] ?? "neutral"}>{STATUS_WORD[s] ?? status}</StatusPill>;
}

/** Picked up or delivered and nobody has typed what the carrier charged yet. An amount the
 *  server withheld (can_see_money false) is hidden, not missing. */
export const needsAmount = (b: Pick<FreightBooking, "status" | "paid_amount" | "can_see_money">) =>
  b.can_see_money !== false && (b.status === "picked_up" || b.status === "delivered") && b.paid_amount == null;

export function AmountNeededPill() {
  return <StatusPill tone="warning">Amount paid needed</StatusPill>;
}

/** Bare YYYY-MM-DD as "Oct 2" (the year only when it is not this one). Local, never UTC. */
export function fmtDay(s: string | null | undefined): string {
  const v = (s || "").slice(0, 10);
  if (!v) return "";
  const d = parseLocalDay(v);
  if (isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The city out of a one-line address ("Street, City, ST 12345" or "City, ST 12345"). */
export function cityOf(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[0];
  return "";
}

/** How a place reads in a row: its name when the viewer may see names, else its city when
 *  they may see addresses, else nothing (the row then shows only the code). */
export function placeLabel(name: string, address: string, canNames: boolean, canAddr: boolean): string {
  if (canNames && name.trim()) return name.trim();
  if (canAddr && address.trim()) return cityOf(address);
  return "";
}

/** Reload on a sync that applied changes from another device (Logistics types a date on his
 *  phone or laptop, this desktop pulls it). A Tauri event, so it needs listen(), not a window
 *  listener. Debounced so a burst of applied events is one reload. */
export function useNetsyncApplied(cb: () => void, ms = 800) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    let dead = false;
    listen("netsync-applied", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => ref.current(), ms);
    }).then((u) => { if (dead) u(); else unlisten = u; }).catch(() => {});
    return () => { dead = true; window.clearTimeout(timer); unlisten?.(); };
  }, [ms]);
}

// ─── the form ─────────────────────────────────────────────────────────────

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";
const area =
  "border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[64px] " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const SERVICES = ["", "LTL", "Full truckload", "Partial", "Box truck", "Other"];
const ACCESSORIALS = [
  "Liftgate at pickup", "Liftgate at delivery", "Residential", "Appointment",
  "Inside delivery", "Limited access", "Hazmat",
];

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** R-415: the accessorials as toggle chips for the usual ones and free text for the rest. One
 *  comma-separated string in and out, the way the booking stores it. Shared with the Send sheet. */
export function AccessorialsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const chosen = splitList(value);
  const known = ACCESSORIALS.filter((x) => chosen.includes(x));
  const others = chosen.filter((c) => !ACCESSORIALS.includes(c));
  // The box keeps what is typed, so a comma is not eaten before the next word arrives.
  const [text, setText] = useState(others.join(", "));
  useEffect(() => {
    setText((t) => (splitList(t).join(", ") === others.join(", ") ? t : others.join(", ")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const emit = (k: string[], other: string) => onChange([...k, ...splitList(other)].join(", "));
  const toggle = (a: string) =>
    emit(known.includes(a) ? known.filter((x) => x !== a) : ACCESSORIALS.filter((x) => known.includes(x) || x === a), text);
  return (
    <div>
      <div className="text-[12px] font-medium text-muted mb-1.5">Accessorials</div>
      <div className="flex flex-wrap gap-1.5">
        {ACCESSORIALS.map((a) => {
          const on = chosen.includes(a);
          return (
            <button key={a} type="button" aria-pressed={on} onClick={() => toggle(a)}
              className={`h-8 px-2.5 rounded-lg border text-[12px] whitespace-nowrap transition-colors ${
                on ? "border-accent bg-accent/10 text-accent font-medium" : "border-line text-muted hover:text-ink-2 hover:bg-surface-2"}`}>
              {a}
            </button>
          );
        })}
      </div>
      <input className={`${inp} mt-2`} placeholder="Anything else, separated by commas" value={text}
        onChange={(e) => { setText(e.target.value); emit(known, e.target.value); }} />
    </div>
  );
}

/** Every text column a person can write. Names and addresses are deliberately absent: they
 *  are read-only here, so a redacted empty string can never be written back over the real one. */
const TEXT_KEYS = [
  "pickup_date", "pickup_window", "pickup_contact", "pickup_phone", "pickup_notes",
  "delivery_date", "delivery_window", "delivery_contact", "delivery_phone", "delivery_notes", "delivered_at",
  "carrier", "broker", "service", "equipment", "bol", "pro", "pickup_number", "reference", "tracking_url",
  "driver_name", "driver_phone", "truck_number", "trailer_number",
  "pallets", "pieces", "weight_lbs", "freight_class", "dimensions", "commodity", "accessorials",
  "paid_at", "paid_method", "paid_note", "notes",
] as const;
type TextKey = typeof TEXT_KEYS[number];
type Draft = Record<TextKey, string> & { status: FreightStatus; paid: string };

const moneyText = (n: number | null | undefined) => (n == null ? "" : String(n));

function toDraft(b: FreightBooking): Draft {
  const d: Record<string, string> = {};
  for (const k of TEXT_KEYS) d[k] = (b[k] ?? "") as string;
  return { ...(d as Record<TextKey, string>), status: b.status, paid: moneyText(b.paid_amount) };
}

/** null = fine, a string = the sentence to show. Empty means "no figure", which is allowed. */
function moneyProblem(raw: string, what: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return `${what} must be a number.`;
  if (n < 0) return `${what} cannot be less than zero.`;
  if (n > 10_000_000) return `${what} is too large.`;
  return null;
}
const moneyValue = (raw: string): number | null => {
  const t = raw.trim();
  return t ? Math.round(Number(t.replace(/[$,\s]/g, "")) * 100) / 100 : null;
};

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <label className="block text-[12px] font-medium text-muted mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      {children}
    </section>
  );
}

/** A place that is read-only here: what the viewer may see of it, and why the rest is missing. */
function Place({ name, address, canNames, canAddr }: { name: string; address: string; canNames: boolean; canAddr: boolean }) {
  const hidden = <span className="inline-flex items-center gap-1 text-muted"><Lock size={11} />Hidden by your permissions</span>;
  return (
    <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[13px] space-y-0.5">
      <div className="text-ink font-medium break-words">{canNames ? (name || "-") : hidden}</div>
      <div className="text-ink-2 break-words">{canAddr ? (address || "-") : hidden}</div>
    </div>
  );
}

export default function LogisticsBookingForm({
  booking, onClose, onSaved, onChanged,
}: {
  booking: FreightBooking;
  onClose: () => void;
  /** The server's copy after a save, so the caller can swap it into its list. */
  onSaved: (b: FreightBooking) => void;
  /** Something other than a save changed the list (a truck added or a booking removed). */
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(booking));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const base = useMemo(() => toDraft(booking), [booking]);
  // The server's copy replaces the draft after a save, and a booking the parent swaps in
  // (another one opened) starts clean. The parent holds the open booking as a snapshot and
  // replaces it only on a save, so a background refresh never wipes what is being typed.
  useEffect(() => { setDraft(toDraft(booking)); setError(""); }, [booking]);

  const full = booking.can_see_deal;           // Jack: sees the deal, so his dates move it
  const dirty = (Object.keys(base) as (keyof Draft)[]).some((k) => base[k] !== draft[k]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const tryClose = () => {
    if (dirty && !confirm("You have changes that are not saved. Leave without saving them?")) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") tryClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const pickStatus = (s: FreightStatus) => {
    setDraft((d) => {
      const next = { ...d, status: s };
      // Delivered asks for the day it landed, and today is the usual answer.
      if (s === "delivered" && !d.delivered_at) next.delivered_at = localDay();
      // Any other status must not keep a delivered day: the server reads one as "delivered".
      if (s !== "delivered") next.delivered_at = "";
      return next;
    });
  };

  const paidErr = moneyProblem(draft.paid, "The amount paid");
  // R-415: our side fills in the freight, so the logistics person only reads it.
  const freightLocked = !full && booking.freight_by_team === true;

  const save = async () => {
    if (paidErr) { setError(paidErr); return; }
    const patch: Record<string, unknown> = {};
    for (const k of TEXT_KEYS) if (draft[k] !== base[k]) patch[k] = draft[k];
    if (draft.status !== base.status) patch.status = draft.status;
    if (draft.paid !== base.paid) patch.paid_amount = moneyValue(draft.paid);
    if (Object.keys(patch).length === 0) return;
    setSaving(true); setError("");
    try {
      const saved = await api.logistics.update(booking.id, { ...(patch as FreightBookingPatch), today: localDay() });
      toast("Saved");
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const addTruck = async () => {
    if (dirty && !confirm("You have changes that are not saved. Add another truck without them?")) return;
    try {
      await api.logistics.copy(booking.id);
      toast("Another truck is on the list");
      onChanged();
    } catch (e) { toast(String(e), "error"); }
  };

  const remove = async () => {
    if (!confirm(`Remove booking ${booking.code}? It leaves the list and the deal's shipping figures. The record is kept, but it cannot be brought back from the app.`)) return;
    try {
      await api.logistics.remove(booking.id);
      toast("Booking removed");
      onChanged();
      onClose();
    } catch (e) { toast(String(e), "error"); }
  };

  const openDeal = () => {
    if (booking.deal?.invoice_number) {
      try { localStorage.setItem("dealflow_invoice_filter", booking.deal.invoice_number); } catch { /* ignore */ }
    }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "dealflow" }));
    onClose();
  };

  const t = (k: TextKey, label: string, opts?: { type?: string; hint?: string; wide?: boolean; placeholder?: string }) => (
    <Field label={label} hint={opts?.hint} wide={opts?.wide}>
      <input className={inp} type={opts?.type ?? "text"} value={draft[k]} placeholder={opts?.placeholder}
        onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const dateHint = (kind: "pickup" | "delivery") =>
    full ? `This moves the deal's ${kind} date` : "Your team sees this date";

  const track = booking.tracking;

  return (
    <>
      <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" onClick={tryClose} />
      <div
        role="dialog" aria-modal="true" aria-label={`Booking ${booking.code}`}
        className="fixed inset-y-0 right-0 w-[560px] max-w-[96vw] bg-surface shadow-[0_0_50px_rgba(0,0,0,0.12)] z-50 flex flex-col animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-surface/95 backdrop-blur-sm border-b border-line px-6 py-4 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="min-w-0 flex items-center gap-2 flex-wrap">
            <h3 className="text-[14px] font-semibold text-ink font-mono">{booking.code}</h3>
            <FreightStatusPill status={booking.status} />
            {needsAmount(booking) && <AmountNeededPill />}
          </div>
          <button onClick={tryClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors flex-shrink-0"><X size={16} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
          {full && booking.deal && (
            <div className="text-[12.5px] text-ink-2 min-w-0">
              <span className="font-medium text-ink">{booking.deal.invoice_number || "Deal"}</span>
              {booking.deal.client_name ? <span className="text-muted">{" "}for {booking.deal.client_name}</span> : null}
            </div>
          )}

          {booking.request_note.trim() && (
            <div className="rounded-xl bg-accent/10 border border-accent/25 px-4 py-3">
              <div className="text-[12px] font-medium text-accent-hover mb-1">
                Note{booking.created_by_name ? ` from ${booking.created_by_name}` : " with the request"}
              </div>
              <div className="text-[13px] text-ink whitespace-pre-wrap break-words">{booking.request_note}</div>
            </div>
          )}

          <Section title="Status">
            <div className="grid grid-cols-5 gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
              {STATUS_ORDER.map((s) => {
                const on = draft.status === s;
                return (
                  <button key={s} type="button" aria-pressed={on} onClick={() => pickStatus(s)}
                    className={`h-9 rounded-md px-1 text-[12px] whitespace-nowrap transition-colors ${
                      on ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                    {STATUS_WORD[s]}
                  </button>
                );
              })}
            </div>
            {draft.status === "delivered" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Delivered on" hint={dateHint("delivery")}>
                  <input className={inp} type="date" value={draft.delivered_at} onChange={(e) => set("delivered_at", e.target.value)} />
                </Field>
              </div>
            )}
          </Section>

          <Section title="Pickup">
            <Place name={booking.pickup_name} address={booking.pickup_address} canNames={booking.can_see_names} canAddr={booking.can_see_addresses} />
            <div className="grid grid-cols-2 gap-3">
              {t("pickup_date", "Pickup date", { type: "date", hint: dateHint("pickup") })}
              {t("pickup_window", "Time window", { placeholder: "8 to 12" })}
              {t("pickup_contact", "Contact")}
              {t("pickup_phone", "Phone")}
              <Field label="Dock notes" wide>
                <textarea className={area} value={draft.pickup_notes} onChange={(e) => set("pickup_notes", e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Delivery">
            <Place name={booking.delivery_name} address={booking.delivery_address} canNames={booking.can_see_names} canAddr={booking.can_see_addresses} />
            <div className="grid grid-cols-2 gap-3">
              {t("delivery_date", "Estimated delivery date", { type: "date", hint: dateHint("delivery") })}
              {t("delivery_window", "Time window")}
              {t("delivery_contact", "Contact")}
              {t("delivery_phone", "Phone")}
              <Field label="Delivery notes" wide>
                <textarea className={area} value={draft.delivery_notes} onChange={(e) => set("delivery_notes", e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Carrier">
            <div className="grid grid-cols-2 gap-3">
              {t("carrier", "Carrier")}
              {t("broker", "Broker")}
              <Field label="Service">
                <select className={inp} value={draft.service} onChange={(e) => set("service", e.target.value)}>
                  {SERVICES.map((s) => <option key={s} value={s}>{s || "Not set"}</option>)}
                  {draft.service && !SERVICES.includes(draft.service) && <option value={draft.service}>{draft.service}</option>}
                </select>
              </Field>
              {t("equipment", "Equipment", { placeholder: "53 ft dry van" })}
              {t("bol", "BOL number")}
              {t("pro", "PRO number")}
              {t("pickup_number", "Pickup number")}
              {t("reference", "Reference or load number")}
              {t("tracking_url", "Tracking link", { wide: true, placeholder: "https://" })}
              {t("driver_name", "Driver name")}
              {t("driver_phone", "Driver phone")}
              {t("truck_number", "Truck number")}
              {t("trailer_number", "Trailer number")}
            </div>
          </Section>

          <Section title="Freight">
            {freightLocked ? (
              <>
                <p className="text-[12px] text-muted inline-flex items-center gap-1"><Lock size={11} />Filled in by your team</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-surface-2 border border-line px-3 py-2.5 text-[13px]">
                  {([
                    ["Pallets", draft.pallets], ["Pieces", draft.pieces], ["Weight in lbs", draft.weight_lbs],
                    ["Freight class", draft.freight_class], ["Dimensions", draft.dimensions], ["What it is", draft.commodity],
                  ] as const).map(([label, v]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-[11.5px] text-muted">{label}</dt>
                      <dd className="text-ink break-words">{v.trim() || "-"}</dd>
                    </div>
                  ))}
                  <div className="col-span-2 min-w-0">
                    <dt className="text-[11.5px] text-muted">Accessorials</dt>
                    <dd className="text-ink break-words">{draft.accessorials.trim() || "-"}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {t("pallets", "Pallets")}
                  {t("pieces", "Pieces")}
                  {t("weight_lbs", "Weight in lbs")}
                  {t("freight_class", "Freight class")}
                  {t("dimensions", "Dimensions", { placeholder: "48 x 40 x 60 in" })}
                  {t("commodity", "What it is")}
                </div>
                <AccessorialsField value={draft.accessorials} onChange={(v) => set("accessorials", v)} />
              </>
            )}
          </Section>

          <Section title="Cost">
            {booking.shipping_billed != null && (
              <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[13px]">
                <span className="text-muted">Charged to the customer for shipping:</span>{" "}
                <span className="font-semibold text-ink tabular-nums">{fmtAmount(booking.shipping_billed)}</span>
                {(booking.trucks_on_deal ?? 0) > 1 && (
                  <div className="text-[11.5px] text-muted mt-0.5">for the {booking.trucks_on_deal} trucks on this shipment</div>
                )}
              </div>
            )}
            {booking.can_see_money === false ? (
              <p className="text-[12px] text-muted inline-flex items-center gap-1"><Lock size={11} />Shipping amounts are hidden by your permissions.</p>
            ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount paid" hint={paidErr ?? "The exact amount the carrier charged. Type it once the carrier is paid."}>
                <NumberInput className={inp} value={draft.paid} placeholder="0.00" onValue={(_n, raw) => set("paid", raw)} />
              </Field>
              {t("paid_at", "Paid on", { type: "date" })}
              {t("paid_method", "Paid with", { placeholder: "Card, ACH, check" })}
              {t("paid_note", "Note", { wide: true })}
            </div>
            )}
          </Section>

          <Section title="Notes">
            <textarea className={area} value={draft.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything else worth writing down" />
          </Section>

          {track && (
            <Section title="Tracking">
              <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[12.5px] text-ink-2">
                {[track.carrier, track.status || track.stage, track.last_location].filter(Boolean).join(", ") || "Waiting for the carrier's first update"}
                {track.last_update_at ? <span className="text-muted">{" "}(updated {fmtDay(track.last_update_at)})</span> : null}
              </div>
            </Section>
          )}

          <div className="text-[11.5px] text-muted">
            {booking.updated_by_name ? `Last changed by ${booking.updated_by_name}` : booking.created_by_name ? `Sent by ${booking.created_by_name}` : ""}
            {booking.updated_at ? ` ${fmtDay(booking.updated_at)}` : ""}
          </div>
        </div>

        {/* Pinned: save never scrolls away. */}
        <div className="border-t border-line bg-surface px-6 py-3 flex-shrink-0 space-y-2">
          {error && <div className="text-[12px] text-danger-ink" role="alert">{error}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            {/* While the team fills the freight in, the team adds the trucks (the logistics person could not fill a new one). */}
            {!freightLocked && (
            <button type="button" onClick={addTruck}
              className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink px-2 h-8 rounded-lg hover:bg-surface-2 transition-colors">
              <Plus size={13} /> Add another truck
            </button>
            )}
            {full && (
              <>
                <button type="button" onClick={openDeal}
                  className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink px-2 h-8 rounded-lg hover:bg-surface-2 transition-colors">
                  <ExternalLink size={12} /> Open the deal
                </button>
                <button type="button" onClick={remove}
                  className="flex items-center gap-1 text-[12px] text-faint hover:text-danger-ink hover:bg-danger-bg px-2 h-8 rounded-lg transition-colors">
                  <Trash2 size={12} /> Remove booking
                </button>
              </>
            )}
            <button type="button" onClick={save} disabled={!dirty || saving}
              className="ml-auto bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
