import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, X, Plus, Trash2, ExternalLink, Lock, FileText, Download, Upload, Send } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  api, type FreightBooking, type FreightBookingPatch, type FreightFile, type FreightFileKind, type FreightInvoiceLine,
  type FreightStatus, type FreightStop,
} from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import {
  FILE_KINDS, PAID_BANNER, STATUS_ORDER,
  dealPaid, equipmentOptions, fileKind, fileKindLabel, fmtDayLabel, isHot, isLogisticsSide,
  isQuoteStage, laneLabel, loadNumber, moneyHidden, needsAmount, paperworkOf, paymentLine, pickStatus as pickStatusFields,
  pickupNumberUnconfirmed, confirmToSend, statusAfterActual, statusAllowed, statusWord, timeWord, type LoadStep,
} from "../lib/logisticsLoad";
import {
  BOOK_ANYWAY, BOOK_ANYWAY_CONFIRM, actualCost, bookGate, firstSection, loadProgress, markupEditable, markupPreview, markupProblem, markupStart,
  markupValue, sectionsFor, withDealFacts, type LoadSection, type ProgressFacts, type StageKey, sectionOfStage,
} from "../lib/loadProgress";
import { canEditCarriers, canPayCarriers, canRecordOn, carrierByName, payMethodLabel } from "../lib/logisticsCarriers";
import { can } from "../lib/permissions";
import { useNetsyncApplied } from "../lib/useNetsyncApplied";
import { openLogisticsHit, startBolFromLoad } from "../lib/logisticsSearch";
import { useSessionMe } from "../lib/useSessionMe";
import StatusPill from "./StatusPill";
import { CarrierHost, CarrierPicker, useCarriers } from "./LogisticsCarriers";
import { RateCard } from "./LogisticsRates";
import { BankLinkPill, LinkBankSheet, MarkPaidSheet, undoCarrierPaid, type PayTarget } from "./LogisticsPayCarriers";
import { LoadTracker } from "./LoadTracker";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";

// R-400: one booking, one truck. This drawer is the booking page for both people who open it:
// the Logistics account (who fills in everything about the shipment) and Jack (who reads it from
// a deal or from the Logistics screen). It writes only through the server's Logistics routes,
// which decide what each person may see and change, so nothing here trusts what it was handed:
// a redacted value comes back empty and is never written back.
//
// R-459: the page is a five step flow, like a deal: Quote, Book, Pickup, Delivery, Pay. Every step
// is one click away at any time and every field stays editable; one Save writes the whole load.
//
// R-464: it is a full page over the content area (the sidebar stays), with the tracker of Jack's eight
// stages above the sections (Quote, Invoice for the team, Book, Pickup, Delivery, Pay) and a Save that
// stays in view. A load goes to book only through the gate: quoted, shipping decided, invoice sent,
// customer paid, with "Book anyway" when only the last two are missing.
// R-465: the quote is the carrier cost plus a markup, and his pay is that markup.

// ─── shared words and shapes ──────────────────────────────────────────────

const STATUS_TONE: Record<FreightStatus, "warning" | "accent" | "success" | "neutral"> = {
  quote: "warning", quoted: "accent", requested: "warning", booked: "accent", picked_up: "accent", delivered: "success", cancelled: "neutral",
};

export { STATUS_ORDER, isHot, needsAmount };

export function FreightStatusPill({ status, logistics }: { status: string; logistics?: boolean }) {
  return <StatusPill tone={STATUS_TONE[status as FreightStatus] ?? "neutral"}>{statusWord(status, logistics)}</StatusPill>;
}

export function AmountNeededPill() {
  return <StatusPill tone="warning">Amount paid needed</StatusPill>;
}

export function UrgentPill() {
  return <StatusPill tone="danger">Urgent</StatusPill>;
}

/** R-459: a booked load picks up today or tomorrow and nobody has confirmed the pickup number with the warehouse. */
export function PickupNumberPill() {
  return <StatusPill tone="danger">Pickup number not confirmed</StatusPill>;
}

/** R-459: open one invoice on the Invoices screen (the same stash-then-switch handoff the client screen uses). */
export function openInvoiceById(invoiceId: string) {
  try { localStorage.setItem("invoices_open_id", invoiceId); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
}

// ─── files (R-458, kinds R-459) ───────────────────────────────────────────

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const fileSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** The file as base64, for the server's JSON upload. */
export function fileBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split("base64,")[1] ?? "");
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.readAsDataURL(f);
  });
}

/** The files a person dropped or chose that are small enough, saying which were not. */
export function keepSmall(list: File[]): File[] {
  const big = list.filter((f) => f.size > MAX_FILE_BYTES);
  if (big.length) toast(`${big.map((f) => f.name).join(", ")} ${big.length === 1 ? "is" : "are"} over 15 MB`, "error");
  return list.filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES);
}

/** Drag files here or choose them. Hands the chosen files on; it uploads nothing itself. `prompt` finishes
 *  "Drop ... here" (a typed zone says what it is for). */
export function FileDrop({ onFiles, busy, hint, prompt = "a BOL, rate confirmation or photo" }: { onFiles: (files: File[]) => void; busy?: boolean; hint?: string; prompt?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const l = keepSmall(Array.from(e.dataTransfer.files)); if (l.length) onFiles(l); }}
      className={`rounded-xl border border-dashed px-4 py-4 text-center transition-colors ${over ? "border-accent bg-accent/10" : "border-line bg-surface-2/50"}`}
    >
      <Upload size={16} className="mx-auto text-muted mb-1" />
      <div className="text-[12.5px] text-ink-2">
        {busy ? "Adding..." : <>Drop {prompt} here, or{" "}
          <button type="button" onClick={() => input.current?.click()} className="text-accent font-medium hover:underline">choose files</button></>}
      </div>
      {hint && <div className="text-[11px] text-muted mt-0.5">{hint}</div>}
      <input ref={input} type="file" multiple className="hidden"
        onChange={(e) => { const l = keepSmall(Array.from(e.target.files ?? [])); e.target.value = ""; if (l.length) onFiles(l); }} />
    </div>
  );
}

/** Upload files to a booking one by one, each as `kind` (a missing kind is stored as other). Returns the
 *  booking after the last one that landed. */
export async function uploadFiles(bookingId: string, files: File[], kind?: FreightFileKind): Promise<FreightBooking | null> {
  let last: FreightBooking | null = null;
  for (const f of files) {
    try {
      last = await api.logistics.files.add(bookingId, f.name, await fileBase64(f), kind);
    } catch (e) { toast(`${f.name}: ${String(e)}`, "error"); }
  }
  return last;
}

/** The typed drop zones on a load. One zone per kind in `kinds`, each listing the files of its kind with
 *  a drop target under it. A file row shows its kind and can change it. Writes straight away, apart from
 *  the form's Save, and hands the booking the server answers with to `onBooking`. */
export function PaperworkZones({ booking, kinds, onBooking }: { booking: FreightBooking; kinds: FreightFileKind[]; onBooking: (b: FreightBooking) => void }) {
  const files = booking.files ?? [];
  const [busy, setBusy] = useState<FreightFileKind | null>(null);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  // Esc closes the preview and goes no further: the page behind it would otherwise treat it as "leave".
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); setPreview(null); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  const add = async (kind: FreightFileKind, list: File[]) => {
    setBusy(kind);
    const b = await uploadFiles(booking.id, list, kind);
    setBusy(null);
    if (b) { toast(list.length === 1 ? "File added" : "Files added"); onBooking(b); }
  };
  const save = async (f: FreightFile) => {
    const dest = await saveDialog({ defaultPath: f.name });
    if (!dest) return;
    try { await api.logistics.files.saveAs(booking.id, f.id, dest); toast("Saved"); } catch (e) { toast(String(e), "error"); }
  };
  const open = async (f: FreightFile) => {
    if (!(f.mime.startsWith("image/") || f.mime === "application/pdf")) return save(f);
    try {
      const got = await api.logistics.files.get(booking.id, f.id);
      const bin = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
      setPreview({ url: URL.createObjectURL(new Blob([bin], { type: got.mime })), name: got.name, mime: got.mime });
    } catch (e) { toast(String(e), "error"); }
  };
  const remove = async (f: FreightFile) => {
    if (!confirm(`Remove ${f.name} from this booking?`)) return;
    try { onBooking(await api.logistics.files.remove(booking.id, f.id)); toast("File removed"); } catch (e) { toast(String(e), "error"); }
  };
  const setKind = async (f: FreightFile, kind: FreightFileKind) => {
    if (kind === fileKind(f)) return;
    try {
      const r = await api.logistics.files.setKind(booking.id, f.id, kind);
      onBooking(r && r.id ? r : await api.logistics.get(booking.id));
    } catch (e) { toast(String(e), "error"); }
  };

  return (
    <div className="space-y-4">
      {kinds.map((kind) => {
        const mine = files.filter((f) => fileKind(f) === kind);
        return (
          <section key={kind} className="space-y-2" aria-label={fileKindLabel(kind)}>
            <div className="flex items-center gap-2">
              <h5 className="text-[12.5px] font-semibold text-ink">{fileKindLabel(kind)}</h5>
              {kind !== "other" && <StatusPill tone={mine.length ? "success" : "neutral"}>{mine.length ? "On file" : "Missing"}</StatusPill>}
            </div>
            {mine.length > 0 && (
              <div className="rounded-lg border border-line divide-y divide-line">
                {mine.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 px-3 py-2 min-w-0">
                    <FileText size={14} className="text-muted flex-shrink-0" />
                    <button type="button" onClick={() => open(f)} className="min-w-0 flex-1 text-left">
                      <div className="text-[13px] text-ink truncate hover:underline">{f.name}</div>
                      <div className="text-[11px] text-muted truncate">{[fileSize(f.size), f.by, fmtDay(f.at)].filter(Boolean).join(", ")}</div>
                    </button>
                    <select aria-label={`What ${f.name} is`} value={fileKind(f)} onChange={(e) => setKind(f, e.target.value as FreightFileKind)}
                      className="h-8 rounded-lg border border-line bg-surface text-[12px] text-ink-2 px-1.5 flex-shrink-0 max-w-[132px]">
                      {FILE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                    </select>
                    <button type="button" onClick={() => save(f)} title="Save a copy"
                      className="p-1.5 rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"><Download size={14} /></button>
                    <button type="button" onClick={() => remove(f)} title="Remove"
                      className="p-1.5 rounded-lg text-faint hover:text-danger-ink hover:bg-danger-bg transition-colors flex-shrink-0"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <FileDrop onFiles={(l) => add(kind, l)} busy={busy === kind}
              prompt={kind === "bol" ? "the signed BOL" : kind === "pod" ? "the proof of delivery" : kind === "carrier_invoice" ? "the carrier's invoice" : "a rate confirmation or photo"}
              hint="Each file up to 15 MB. Both sides see it straight away." />
          </section>
        );
      })}
      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={() => setPreview(null)}>
          {preview.mime === "application/pdf"
            ? <iframe src={preview.url} title={preview.name} className="w-full max-w-[900px] h-full rounded-lg bg-surface" />
            : <img src={preview.url} alt={preview.name} className="max-w-full max-h-full rounded-lg shadow-xl" />}
        </div>
      )}
    </div>
  );
}

/** Bare YYYY-MM-DD as "Oct 2" (the year only when it is not this one). Local, never UTC. */
export function fmtDay(s: string | null | undefined): string {
  return fmtDayLabel(s);
}

/** R-458: a day as people say it: "today", "tomorrow", else "Oct 2". */
export function dayWord(s: string | null | undefined): string {
  const v = (s || "").slice(0, 10);
  if (!v) return "";
  if (v === localDay()) return "today";
  const t = new Date(); t.setDate(t.getDate() + 1);
  if (v === localDay(t)) return "tomorrow";
  return fmtDay(v);
}

/** R-458: when the truck has to be where, in one line: "Pickup today 9:00 am before 4 pm, stop 2 after 1 pm, ETA Oct 9".
 *  R-459: the appointment time rides beside the day, and the actual days say what has happened. */
export function timingLine(b: FreightBooking): string {
  const parts: string[] = [];
  if (b.pickup_date || b.pickup_appt_time || b.pickup_window) {
    parts.push(["Pickup", dayWord(b.pickup_date), timeWord(b.pickup_appt_time), b.pickup_window].filter(Boolean).join(" "));
  }
  extraStops(b).forEach((x, i) => { if (x.window?.trim()) parts.push(`stop ${i + 2} ${x.window.trim()}`); });
  if (b.picked_up_at && !b.delivered_at) parts.push(`picked up ${fmtDay(b.picked_up_at)}`);
  if (b.delivered_at) parts.push(`delivered ${fmtDay(b.delivered_at)}`);
  else if (b.delivery_date || b.delivery_appt_time || b.delivery_window) {
    parts.push(["ETA", fmtDay(b.delivery_date), timeWord(b.delivery_appt_time), b.delivery_window].filter(Boolean).join(" "));
  }
  return parts.join(", ");
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

/** R-452: the pickups after the first on the same truck. */
export const extraStops = (b: Pick<FreightBooking, "extra_pickups">): FreightStop[] =>
  Array.isArray(b.extra_pickups) ? b.extra_pickups : [];

/** A blank extra pickup. */
export const blankStop = (): FreightStop => ({ name: "", address: "", window: "", contact: "", phone: "", notes: "", dock: "", pickup_number: "", confirmed: false });

/** "Birchwood to Lantern Bay", "Birchwood + Kestrel Mill to Lantern Bay", or "Birchwood + 2 more to
 *  Lantern Bay": the route as a row reads it. Empty when the viewer may see none of the places. */
export function routeLabel(b: FreightBooking): string {
  let from = placeLabel(b.pickup_name, b.pickup_address, b.can_see_names, b.can_see_addresses);
  const to = placeLabel(b.delivery_name, b.delivery_address, b.can_see_names, b.can_see_addresses);
  const extra = extraStops(b).map((x) => placeLabel(x.name, x.address, b.can_see_names, b.can_see_addresses));
  if (from && extra.length === 1 && extra[0]) from = `${from} + ${extra[0]}`;
  else if (from && extra.length) from = `${from} + ${extra.length} more`;
  return from && to ? `${from} to ${to}` : from || to;
}

export { useNetsyncApplied };

// ─── the form ─────────────────────────────────────────────────────────────

export const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";
export const area =
  "border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[64px] " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const SERVICES = ["", "LTL", "Full truckload", "Partial", "Box truck", "Other"];
const ACCESSORIALS = [
  "Liftgate at pickup", "Liftgate at delivery", "Residential", "Appointment",
  "Inside delivery", "Limited access", "Hazmat",
];

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** R-459: the equipment as a drop-down of every option. A value stored before the list existed stays
 *  selected as an extra option. Shared with the Send sheet. */
export function EquipmentSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select className={className ?? inp} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Equipment">
      <option value="">Not set</option>
      {equipmentOptions(value).map((e) => <option key={e} value={e}>{e}</option>)}
    </select>
  );
}

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

/** Every text column a person can write. The names and addresses of the first pickup and the delivery are
 *  here too, but `save` sends them only while the viewer may see them, so a redacted empty string can
 *  never be written back over the real one.
 *  R-459: the carrier payment (paid amount, day, method, note) is no longer typed here: the team
 *  records it. The carrier rate (`quoted_cost`) and the carrier cost the quote is built on (`quote_cost`)
 *  are money, so they sit in the draft beside these as `rate` and `cost`, with the markup percent `pct`. */
const TEXT_KEYS = [
  "pickup_name", "pickup_address", "delivery_name", "delivery_address",
  "pickup_date", "pickup_appt_time", "pickup_window", "pickup_contact", "pickup_phone", "pickup_dock", "pickup_notes", "pickup_number",
  "picked_up_at", "picked_up_time",
  "delivery_date", "delivery_appt_time", "delivery_window", "delivery_contact", "delivery_phone", "delivery_dock", "delivery_notes",
  "delivered_at", "delivered_time",
  "carrier", "carrier_id", "broker", "service", "equipment", "bol", "pro", "reference", "tracking_url",
  "driver_name", "driver_phone", "truck_number", "trailer_number",
  "pallets", "pieces", "weight_lbs", "freight_class", "dimensions", "commodity", "accessorials",
  "quote_note", "pay_due_date", "notes",
] as const;
type TextKey = typeof TEXT_KEYS[number];
type Draft = Record<TextKey, string> & {
  /** R-465: the carrier cost the quote is built on, and the markup percent on top of it. The quote is worked out from them. */
  status: FreightStatus; cost: string; pct: string; rate: string; stops: FreightStop[]; urgent: boolean;
  /** The pickup-number check on the first pickup. */
  confirmed: boolean;
};

/** A name is written only by someone who may see names, an address only by someone who may see addresses. */
const hiddenPlaceKey = (k: string, b: { can_see_names: boolean; can_see_addresses: boolean }): boolean =>
  (k.endsWith("_name") && (k.startsWith("pickup") || k.startsWith("delivery")) && !b.can_see_names) ||
  (k.endsWith("_address") && !b.can_see_addresses);

const moneyText = (n: number | null | undefined) => (n == null ? "" : String(n));
const STOP_KEYS: (keyof FreightStop)[] = ["name", "address", "window", "contact", "phone", "notes", "dock", "pickup_number"];
const stopsKey = (list: FreightStop[]) => JSON.stringify(list.map((x) => [...STOP_KEYS.map((k) => String(x[k] ?? "").trim()), !!x.confirmed]));

function toDraft(b: FreightBooking): Draft {
  const d: Record<string, string> = {};
  for (const k of TEXT_KEYS) d[k] = (b[k] ?? "") as string;
  return {
    ...(d as Record<TextKey, string>), status: b.status, cost: moneyText(b.quote_cost), pct: markupStart(b), rate: moneyText(b.quoted_cost),
    stops: extraStops(b).map((x) => ({ ...blankStop(), ...x, confirmed: !!x.confirmed })),
    urgent: !!b.urgent,
    confirmed: !!(b.pickup_number_confirmed_at ?? "").trim(),
  };
}

const draftChanged = (a: Draft, b: Draft, k: keyof Draft) => (k === "stops" ? stopsKey(a.stops) !== stopsKey(b.stops) : a[k] !== b[k]);

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

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-full" : ""}`}>
      <label className="block text-[12px] font-medium text-muted mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
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

/** The check and balance on a pickup: the driver has the pickup number and the warehouse confirmed it. */
function ConfirmCheck({ checked, onChange, hasNumber, stamp }: { checked: boolean; onChange: (v: boolean) => void; hasNumber: boolean; stamp: string }) {
  return (
    <div className="col-span-full min-w-0">
      <label className={`flex items-start gap-2 text-[13px] ${hasNumber ? "text-ink cursor-pointer" : "text-muted"}`}>
        <input type="checkbox" checked={checked} disabled={!hasNumber} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 mt-0.5 accent-accent" />
        <span>Driver has the pickup number, confirmed with the warehouse</span>
      </label>
      {checked && stamp && <div className="text-[11px] text-muted mt-1 ml-6">{stamp}</div>}
      {!hasNumber && <div className="text-[11px] text-muted mt-1 ml-6">Add the pickup number first.</div>}
    </div>
  );
}

/** R-459: "Put on the invoice". The amount comes from the quote and can be changed here; it becomes the
 *  deal's shipping line. Nothing is sent: the invoice is opened to review and send. */
function InvoiceLineSheet({ booking, initial, onClose, onDone }: {
  booking: FreightBooking; initial: string; onClose: () => void; onDone: (r: FreightInvoiceLine) => void;
}) {
  const [amount, setAmount] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const problem = moneyProblem(amount, "The amount");
  // Esc closes this sheet and never reaches the page under it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = async () => {
    const n = moneyValue(amount);
    if (problem) { setErr(problem); return; }
    if (n == null) { setErr("Add the amount to put on the invoice."); return; }
    setBusy(true); setErr("");
    try { onDone(await api.logistics.invoiceLine(booking.id, n)); }
    catch (e) { setErr(String(e)); setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Put on the invoice"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Put on the invoice</h2>
            <p className="text-[12px] text-muted mt-0.5">{booking.deal?.invoice_number ? `${booking.deal.invoice_number}. ` : ""}It becomes the shipping line. You review and send the invoice yourself.</p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Field label="Shipping amount" hint={problem ?? (booking.quote_amount != null ? `Logistics quoted ${fmtAmount(booking.quote_amount)}. Change it if the invoice should say something else.` : undefined)}>
            <NumberInput className={inp} value={amount} placeholder="0.00" onValue={(_n, raw) => setAmount(raw)} />
          </Field>
          {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2 border-t border-line">
          <button onClick={onClose} className="px-4 h-9 rounded-lg text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
          <button onClick={go} disabled={busy}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">
            {busy ? "Putting it on..." : "Put on the invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The facts the tracker and the gate read off a load. `over` lays the draft's status and actual days on top, so
 *  the page moves as a person types; `known` is what the screen knows about the deal that the load's copy may not. */
function factsOf(
  b: FreightBooking, over: Partial<Pick<ProgressFacts, "status" | "picked_up_at" | "delivered_at">>, known: { invoiceSent?: boolean; dealPaid?: boolean },
): ProgressFacts {
  return withDealFacts({
    status: b.status, quote_amount: b.quote_amount, quote_invoiced_at: b.quote_invoiced_at, shipping_charge: b.shipping_charge,
    invoice_sent: b.invoice_sent, deal_paid: b.deal_paid, book_override_at: b.book_override_at, book_override_by: b.book_override_by,
    picked_up_at: b.picked_up_at, delivered_at: b.delivered_at, paid_amount: b.paid_amount, ...over,
  }, known);
}

/** Two columns from about 760 px of page (the sidebar is 216), one below. */
const g2 = "grid grid-cols-1 min-[976px]:grid-cols-2 gap-3";
const btnPrimary = "bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap";
const btnGhost = "px-3 h-9 rounded-lg border border-line text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-40 whitespace-nowrap";

/** One fact of the flow on the Invoice section: a tick or an empty ring, the fact in words, and what can be done about it. */
function FlowRow({ done, title, children, actions }: { done: boolean; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 min-w-0">
      <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${done ? "bg-success text-surface" : "border border-line-3 text-faint"}`} aria-hidden>
        {done && <Check size={12} strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        <div className="text-[12.5px] text-ink-2 mt-0.5 break-words">{children}</div>
        {actions && <div className="flex items-center gap-2 flex-wrap mt-2.5">{actions}</div>}
      </div>
    </div>
  );
}

/** One figure on the team's cost line. */
function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className="text-[14px] font-semibold text-ink tabular-nums break-words">{value}</dd>
      {sub && <dd className="text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}

const GATE_ITEMS: { key: "quote" | "charge" | "sent" | "paid"; text: string }[] = [
  { key: "quote", text: "Logistics has quoted it" },
  { key: "charge", text: "The quote is on the invoice, or we pay the shipping ourselves" },
  { key: "sent", text: "The invoice has been sent" },
  { key: "paid", text: "The customer has paid" },
];

export default function LogisticsBookingForm({
  booking, onClose, onSaved, onChanged, dealPaid: dealPaidKnown, invoiceSent: invoiceSentKnown, initialStep,
}: {
  booking: FreightBooking;
  onClose: () => void;
  /** The server's copy after a save, so the caller can swap it into its list. */
  onSaved: (b: FreightBooking) => void;
  /** Something other than a save changed the list (a truck added or a booking removed). */
  onChanged: () => void;
  /** R-459: the screen that knows the deal says whether the customer has paid. Without it the load's own flag is used. */
  dealPaid?: boolean;
  /** R-464: the screen that knows the deal's invoice says whether it has been sent. Without it the load's own flag is used. */
  invoiceSent?: boolean;
  /** R-459: open on this section instead of the one the current stage points at (Bills opens a load on Pay). */
  initialStep?: LoadStep;
}) {
  const known = { invoiceSent: invoiceSentKnown, dealPaid: dealPaidKnown };
  const [draft, setDraft] = useState<Draft>(() => toDraft(booking));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const startSection = (b: FreightBooking): LoadSection =>
    initialStep ?? firstSection(loadProgress(factsOf(b, {}, known), b.can_see_deal), b.can_see_deal);
  const [step, setStep] = useState<LoadSection>(() => startSection(booking));
  const me = useSessionMe();
  const { list: carriers, error: carriersError, reload: reloadCarriers } = useCarriers();
  // The carrier card, or the add form seeded from a typed name; and the two sheets on the Pay step.
  const [carrierHost, setCarrierHost] = useState<{ id?: string; edit?: boolean; seedName?: string } | null>(null);
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);
  const [linkTarget, setLinkTarget] = useState<PayTarget | null>(null);
  const [invoiceSheet, setInvoiceSheet] = useState(false);
  const [onInvoice, setOnInvoice] = useState<FreightInvoiceLine | null>(null);
  const [choosing, setChoosing] = useState(false);
  const base = useMemo(() => toDraft(booking), [booking]);
  const baseRef = useRef(base);
  baseRef.current = base;
  // A booking the form handed to the parent itself (a file added, a quote put on the invoice) is rebased
  // into the draft instead of replacing it, so what is typed and not saved yet survives.
  const handedOver = useRef<FreightBooking | null>(null);
  // The server's copy replaces the draft after a save, and a booking the parent swaps in
  // (another one opened) starts clean. The parent holds the open booking as a snapshot and
  // replaces it only on a save, so a background refresh never wipes what is being typed.
  useEffect(() => {
    if (handedOver.current === booking) return;
    setDraft(toDraft(booking)); setError("");
  }, [booking]);
  // Another load opened: start on the section its current stage points at.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setStep(startSection(booking)); setOnInvoice(null); }, [booking.id]);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [step]);

  const full = booking.can_see_deal;           // Jack: sees the deal, so his dates move it
  const lg = isLogisticsSide(booking);
  const noMoney = moneyHidden(booking);
  const dirty = (Object.keys(base) as (keyof Draft)[]).some((k) => draftChanged(base, draft, k));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const sheetOpen = !!(carrierHost || payTarget || linkTarget || invoiceSheet);

  const tryClose = () => {
    if (dirty && !confirm("You have changes that are not saved. Leave without saving them?")) return;
    onClose();
  };
  /** Leaving this page for another screen (a BOL, the invoice): unsaved typing is asked about first. */
  const leaveFor = (go: () => void) => {
    if (dirty && !confirm("You have changes that are not saved. Leave without saving them?")) return;
    go();
  };
  // Esc leaves the page through the unsaved check, unless a sheet is open on top of it (Esc belongs to the sheet then).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !sheetOpen) tryClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, sheetOpen]);

  /** The server's copy of this load after something other than Save changed it. Fields nobody has touched
   *  take the new values, fields being edited keep what is typed. */
  const takeServerCopy = (b: FreightBooking) => {
    const old = baseRef.current, next = toDraft(b);
    handedOver.current = b;
    setDraft((d) => {
      const out = { ...next } as Record<string, unknown>;
      for (const k of Object.keys(next) as (keyof Draft)[]) if (draftChanged(old, d, k)) out[k] = d[k];
      return out as unknown as Draft;
    });
    onSaved(b);
  };

  const pickStatus = (s: FreightStatus) => {
    setDraft((d) => ({
      ...d,
      ...pickStatusFields({ delivered_at: d.delivered_at, picked_up_at: d.picked_up_at, picked_up_time: d.picked_up_time }, s, localDay()),
    }));
  };
  /** An actual day is filled in or cleared: the status follows it before Save, the way the server reads it. */
  const dealEdit = can(me, "deal_flow:edit");
  const setActual = (field: "picked_up_at" | "delivered_at", v: string) =>
    setDraft((d) => ({
      ...d, [field]: v,
      // Without deal edit the server never moves a quote or quoted load (the team sends it to book).
      status: !dealEdit && isQuoteStage(d.status) ? d.status : statusAfterActual(d.status, field, v, field === "picked_up_at" ? v : d.picked_up_at),
    }));
  /** Typing a name that is exactly a saved carrier's name is picking that carrier, so the load carries its id. */
  const setCarrier = (v: string) =>
    setDraft((d) => {
      const hit = carriers && !carriersError ? carrierByName(v, carriers) : null;
      return { ...d, carrier: v, carrier_id: hit ? hit.id : v === base.carrier ? base.carrier_id : "" };
    });
  /** A saved carrier is picked: its name and id go on the load, and the save carries both. */
  const pickCarrier = (c: { id: string; name: string }) => setDraft((d) => ({ ...d, carrier: c.name, carrier_id: c.id }));
  const setPickupNumber = (v: string) =>
    setDraft((d) => ({ ...d, pickup_number: v, confirmed: v.trim() === base.pickup_number.trim() ? base.confirmed : false }));

  const canPay = canRecordOn(booking, canPayCarriers(me));
  const canEditCarrier = canEditCarriers(me);
  const costErr = moneyProblem(draft.cost, "The carrier cost");
  const pctErr = markupProblem(draft.pct);
  const rateErr = moneyProblem(draft.rate, "The carrier rate");
  // R-415: our side fills in the freight, so the logistics person only reads it.
  const freightLocked = !full && booking.freight_by_team === true;
  const paid = dealPaid(booking, dealPaidKnown);
  // The quote can be revised and the load sent to book only while it is a quote (on the saved status, not a pick in the box).
  const atQuote = isQuoteStage(booking.status);
  // R-465: the markup percent is typed by the team, and by the logistics person only when the owner allows it.
  const pctEdit = markupEditable(full, booking);
  const preview = markupPreview(draft.cost, draft.pct);

  const save = async (opts?: { status?: FreightStatus; withQuote?: boolean; override?: boolean }) => {
    const problem = costErr || pctErr || rateErr;
    if (problem) { setError(problem); return; }
    if (opts?.withQuote && moneyValue(draft.cost) == null) { setError("Add the carrier cost first."); return; }
    const patch: Record<string, unknown> = {};
    for (const k of TEXT_KEYS) if (draft[k] !== base[k] && !hiddenPlaceKey(k, booking)) patch[k] = draft[k];
    if (draft.status !== base.status) patch.status = draft.status;
    if (opts?.status) patch.status = opts.status;
    if (opts?.override) patch.override = true;
    // The server works the markup and the quote out from the cost and the percent. A percent the person may not
    // type is never sent: the server uses the default for it.
    if (draft.cost !== base.cost || draft.pct !== base.pct || opts?.withQuote) {
      const cost = moneyValue(draft.cost);
      if (cost != null) {
        patch.quote_cost = cost;
        const pct = markupValue(draft.pct);
        if (pctEdit && pct != null) patch.markup_pct = pct;
      } else if (base.cost !== "") { setError("Add the carrier cost to change the quote."); return; }
    }
    if (draft.rate !== base.rate) patch.quoted_cost = moneyValue(draft.rate);
    if (draft.urgent !== base.urgent) patch.urgent = draft.urgent;
    const sendConfirm = confirmToSend(draft.pickup_number !== base.pickup_number, base.confirmed, draft.confirmed);
    if (sendConfirm !== undefined) patch.pickup_number_confirmed = sendConfirm;
    if (stopsKey(draft.stops) !== stopsKey(base.stops)) {
      // The server stamps who confirmed a stop and when; the client only says whether it is confirmed.
      patch.extra_pickups = draft.stops.map((s) => {
        const x = { ...s, name: s.name.trim(), address: s.address.trim(), confirmed: !!s.confirmed };
        delete x.confirmed_at; delete x.confirmed_by;
        return x;
      });
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true); setError("");
    try {
      const saved = await api.logistics.update(booking.id, { ...(patch as FreightBookingPatch), today: localDay() });
      toast(opts?.status === "requested" ? "Sent to logistics" : opts?.withQuote && !full ? "Quote sent to your team" : "Saved");
      handedOver.current = null;
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Something recorded straight on the server (a payment, a bank link): read the load again so the page says so. */
  const reloadLoad = async () => {
    try { takeServerCopy(await api.logistics.get(booking.id)); } catch (e) { toast(String(e), "error"); }
  };
  const payFor: PayTarget = {
    bookingId: booking.id, label: `${booking.carrier || "Carrier"}, ${loadNumber(booking)}`, rate: booking.quoted_cost,
    payMethod: booking.carrier_pay_method || "", paidAmount: booking.paid_amount, bankLinked: booking.bank_linked ?? "",
    // R-463: a payment on record opens the same sheet to be changed, with what is on record.
    current: booking.paid_amount != null
      ? { paid_amount: booking.paid_amount, paid_at: booking.paid_at, paid_method: booking.paid_method, paid_note: booking.paid_note }
      : undefined,
  };

  // ── the gate (R-464) ────────────────────────────────────────────────────
  const gate = bookGate(factsOf(booking, {}, known));
  const sendToBook = () => save({ status: "requested" });
  /** The money is coming: the team sends it to book before the invoice is sent and paid, after one more look. */
  const bookAnyway = async () => {
    if (!confirm(BOOK_ANYWAY_CONFIRM)) return;
    await save({ status: "requested", override: true });
  };
  /** "We pay this shipping ourselves" or back to charging the customer. Written at once, apart from Save. */
  const setCharge = async (v: "own" | "") => {
    setChoosing(true);
    try {
      const r = await api.logistics.update(booking.id, { shipping_charge: v });
      takeServerCopy(r && r.id ? r : await api.logistics.get(booking.id));
      toast(v === "own" ? "You are paying this shipping yourselves" : "The customer will be charged for shipping");
    } catch (e) { toast(String(e), "error"); }
    setChoosing(false);
  };
  /** Open the deal's invoice on the Invoices screen, to review and send it. */
  const openInvoice = async () => {
    try {
      const id = onInvoice?.invoice_id ?? (booking.deal?.id ? (await api.getDealFlow(booking.deal.id)).invoice_id : "");
      if (!id) { toast("This deal has no invoice yet.", "error"); return; }
      leaveFor(() => { openInvoiceById(id); onClose(); });
    } catch (e) { toast(String(e), "error"); }
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
    if (!confirm(`Remove booking ${loadNumber(booking)}? It leaves the list and the deal's shipping figures. The record is kept, but it cannot be brought back from the app.`)) return;
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
  // R-452: the team (who sees the deal, names and addresses) adds, changes and removes the extra
  // pickups; anyone else fills in each one's window, contact, phone and notes, and the server keeps
  // what they may not see.
  const stopEdit = full && booking.can_see_names && booking.can_see_addresses;
  const setStop = (i: number, k: keyof FreightStop, v: string) =>
    setDraft((d) => ({ ...d, stops: d.stops.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const setStopNumber = (i: number, v: string) =>
    setDraft((d) => ({
      ...d,
      stops: d.stops.map((x, j) => (j === i ? { ...x, pickup_number: v, confirmed: v.trim() === (base.stops[i]?.pickup_number ?? "").trim() ? !!base.stops[i]?.confirmed : false } : x)),
    }));
  /** The first pickup's and the delivery's name and address: inputs for what the viewer may see, the read-only
   *  card when they may see neither (a hidden half stays a lock, never an empty box that could be written back). */
  const placeBlock = (p: "pickup" | "delivery") => {
    const names = booking.can_see_names, addrs = booking.can_see_addresses;
    if (!names && !addrs) return <Place name="" address="" canNames={false} canAddr={false} />;
    const hidden = <p className="text-[12px] text-muted inline-flex items-center gap-1 h-9"><Lock size={11} />Hidden by your permissions</p>;
    return (
      <div className={g2}>
        {names ? t(`${p}_name`, "Name") : <Field label="Name">{hidden}</Field>}
        {addrs ? t(`${p}_address`, "Address") : <Field label="Address">{hidden}</Field>}
      </div>
    );
  };
  const stopInput = (i: number, k: keyof FreightStop, label: string, wide?: boolean) => (
    <Field label={label} wide={wide}>
      <input className={inp} value={String(draft.stops[i][k] ?? "")} onChange={(e) => setStop(i, k, e.target.value)} />
    </Field>
  );

  const unconfirmed = pickupNumberUnconfirmed(
    { status: draft.status, pickup_date: draft.pickup_date, pickup_number_confirmed_at: draft.confirmed ? "x" : "", extra_pickups: draft.stops },
    localDay(),
  );
  // R-464: the tracker reads the draft's status and actual days, so it moves as they are typed.
  const stages = loadProgress(factsOf(booking, { status: draft.status, picked_up_at: draft.picked_up_at, delivered_at: draft.delivered_at }, known), full);
  const sections = sectionsFor(full);
  const here: LoadSection = sections.some((s) => s.key === step) ? step : "quote";
  const lane = booking.can_see_addresses ? laneLabel(booking.pickup_address, booking.delivery_address) : "";
  const route = routeLabel(booking);
  const confirmedStamp = (by: string | undefined, at: string | undefined) =>
    by || at ? `Confirmed${by ? ` by ${by}` : ""}${at ? ` on ${fmtDay(at)}` : ""}` : "";
  const invoiceNo = booking.deal?.invoice_number || booking.deal_invoice_number || "";
  const actual = actualCost(booking);
  const overridden = !!(booking.book_override_at ?? "").trim();

  // ── the sections ────────────────────────────────────────────────────────

  const freightFields = freightLocked ? (
    <>
      <p className="text-[12px] text-muted inline-flex items-center gap-1"><Lock size={11} />Filled in by your team</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg bg-surface-2 border border-line px-3 py-2.5 text-[13px]">
        {([
          ["Pallets", draft.pallets], ["Pieces", draft.pieces], ["Pallet dimensions (L x W x H in)", draft.dimensions], ["Weight (lbs)", draft.weight_lbs],
          ["Freight class", draft.freight_class], ["Description of goods", draft.commodity],
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
      <div className={g2}>
        {t("pallets", "Pallets")}
        {t("pieces", "Pieces")}
        {t("dimensions", "Pallet dimensions (L x W x H in)", { placeholder: "48 x 40 x 60" })}
        {t("weight_lbs", "Weight (lbs)")}
        {t("freight_class", "Freight class")}
        {t("commodity", "Description of goods")}
      </div>
      <AccessorialsField value={draft.accessorials} onChange={(v) => set("accessorials", v)} />
    </>
  );

  const quoteStep = (
    <div className="space-y-6">
      {lane && <div className="text-[13px] text-ink-2"><span className="text-muted">Lane</span> {lane}</div>}
      <RateCard by={{ bookingId: booking.id }} onOpenCarrier={(id) => setCarrierHost({ id })} />

      <Section title="Freight">
        {freightFields}
        <Field label="Equipment">
          <EquipmentSelect value={draft.equipment} onChange={(v) => set("equipment", v)} />
        </Field>
      </Section>

      <Section title="Quote">
        {noMoney ? (
          <p className="text-[12px] text-muted inline-flex items-center gap-1"><Lock size={11} />Quote amounts are hidden by your permissions.</p>
        ) : (
          <>
            <div className={g2}>
              <Field label="Carrier cost" hint={costErr ?? "What the carrier will charge. The quote is this plus the markup."}>
                <NumberInput className={inp} value={draft.cost} placeholder="0.00" onValue={(_n, raw) => set("cost", raw)} />
              </Field>
              <Field label="Markup %" hint={pctErr ?? (pctEdit ? "Starts at the default. Change it for this load if you need to." : "Set by the owner. Your pay on this load is the markup.")}>
                {pctEdit
                  ? <NumberInput className={inp} value={draft.pct} placeholder="0" onValue={(_n, raw) => set("pct", raw)} />
                  : <p className="h-9 flex items-center text-[13px] text-ink tabular-nums">{draft.pct.trim() || "0"}%</p>}
              </Field>
            </div>
            {preview
              ? <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[13px] text-ink tabular-nums" role="status">Markup {fmtAmount(preview.markup)}, quote {fmtAmount(preview.quote)}</div>
              : <p className="text-[12px] text-muted">Add the carrier cost to see the quote.</p>}
            <Field label="Quote note">
              <textarea className={area} value={draft.quote_note} onChange={(e) => set("quote_note", e.target.value)} placeholder="Anything the team should know about this quote" />
            </Field>
            {booking.quote_amount != null && booking.quote_cost == null && (
              <p className="text-[12px] text-muted">
                Quoted at {fmtAmount(booking.quote_amount)}, from before the carrier cost and the markup were kept. Add the carrier cost to build it again.
              </p>
            )}
            {booking.quoted_at && (
              <p className="text-[12px] text-muted">
                Quoted{booking.quoted_by_name ? ` by ${booking.quoted_by_name}` : ""} on {fmtDay(booking.quoted_at)}
                {booking.quote_amount != null ? ` at ${fmtAmount(booking.quote_amount)}` : ""}.
                {booking.markup_by_name && booking.markup_pct != null ? ` Markup of ${booking.markup_pct}% set by ${booking.markup_by_name}${booking.markup_at ? ` on ${fmtDay(booking.markup_at)}` : ""}.` : ""}
              </p>
            )}
            {booking.quote_invoiced_at && (
              <p className="text-[12px] text-success-ink">
                On the invoice{booking.quote_invoiced_amount != null ? ` at ${fmtAmount(booking.quote_invoiced_amount)}` : ""} since {fmtDay(booking.quote_invoiced_at)}.
              </p>
            )}
            {/* R-465: the team always sees what the carrier cost, what was added, what the customer is quoted and what it really cost. */}
            {full && (
              <dl className="grid grid-cols-2 min-[976px]:grid-cols-3 gap-x-4 gap-y-3 rounded-lg bg-surface-2 border border-line px-3 py-3" aria-label="Cost and markup">
                <Figure label="Carrier cost" value={booking.quote_cost != null ? fmtAmount(booking.quote_cost) : "-"} />
                <Figure label="Markup" value={booking.markup_amount != null ? fmtAmount(booking.markup_amount) : "-"} sub={booking.markup_pct != null ? `${booking.markup_pct}%` : undefined} />
                <Figure label="Quote" value={booking.quote_amount != null ? fmtAmount(booking.quote_amount) : "-"} />
                {booking.quoted_cost != null && <Figure label="Carrier rate" value={fmtAmount(booking.quoted_cost)} />}
                {booking.paid_amount != null && <Figure label="Amount paid" value={fmtAmount(booking.paid_amount)} />}
                {actual && <Figure label="Actual cost" value={fmtAmount(actual.amount)} sub={actual.source === "paid" ? "The amount paid" : "The carrier rate"} />}
              </dl>
            )}
          </>
        )}
        {atQuote && (
          <div className="flex items-center gap-2 flex-wrap">
            {!noMoney && <button type="button" onClick={() => save({ withQuote: true })} disabled={saving} className={btnPrimary}>Submit quote</button>}
            {full && booking.quote_amount != null && (
              <button type="button" onClick={() => setStep("invoice")} className="text-[12.5px] text-accent font-medium hover:underline whitespace-nowrap">Next: the invoice</button>
            )}
          </div>
        )}
        {atQuote && full && booking.status === "quote" && booking.quote_amount == null && (
          <p className="text-[12px] text-muted">Waiting for logistics to quote it. You can fill in the booking details on the Book step meanwhile. They are stored here and not sent.</p>
        )}
      </Section>

      <Section title="Files">
        <PaperworkZones booking={booking} kinds={["other"]} onBooking={takeServerCopy} />
      </Section>
    </div>
  );

  /** The four things before a load goes to book, and the button. Only the team sends a load to book, and only while it is a quote. */
  const sendBar = full && atQuote && (
    <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3 space-y-3">
      <div className="text-[13px] font-medium text-ink">Send to book</div>
      <ul className="space-y-1.5 list-none m-0 p-0">
        {GATE_ITEMS.map((g) => {
          const ok = !gate.missing.includes(g.key);
          return (
            <li key={g.key} className={`flex items-center gap-2 text-[12.5px] ${ok ? "text-ink-2" : "text-muted"}`}>
              <span className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 ${ok ? "bg-success text-surface" : "border border-line-3"}`} aria-hidden>
                {ok && <Check size={10} strokeWidth={3} />}
              </span>
              <span>{g.text}</span>
            </li>
          );
        })}
      </ul>
      {!gate.ok && <p className="text-[12px] text-muted">{gate.reason}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={sendToBook} disabled={!gate.ok || saving}
          className={`${btnPrimary} flex items-center gap-1.5`}>
          <Send size={13} /> {gate.button}
        </button>
        {gate.canOverride && (
          <button type="button" onClick={bookAnyway} disabled={saving} className={btnGhost}>{BOOK_ANYWAY}</button>
        )}
        {!gate.ok && (
          <button type="button" onClick={reloadLoad} className="text-[12px] text-muted hover:text-ink-2 underline whitespace-nowrap">Check again</button>
        )}
      </div>
    </div>
  );

  const invoiceStep = (
    <div className="space-y-6">
      <Section title="Shipping on the invoice">
        <div className="space-y-2.5">
          <FlowRow done={booking.shipping_charge === "own" || booking.shipping_charge === "invoice" || !!(booking.quote_invoiced_at ?? "").trim()} title="Who pays for the shipping"
            actions={atQuote && !noMoney ? (
              <>
                {booking.quote_amount != null && booking.shipping_charge !== "own" && (
                  <button type="button" onClick={() => setInvoiceSheet(true)} className={btnPrimary}>Put on the invoice</button>
                )}
                {booking.shipping_charge === "own"
                  ? <button type="button" onClick={() => setCharge("")} disabled={choosing} className={btnGhost}>Charge the customer instead</button>
                  : booking.shipping_charge !== "invoice" && !(booking.quote_invoiced_at ?? "").trim() && (
                    <button type="button" onClick={() => setCharge("own")} disabled={choosing} className={btnGhost}>We pay this shipping ourselves</button>
                  )}
              </>
            ) : undefined}>
            {booking.shipping_charge === "own"
              ? "We pay this shipping ourselves. The customer is not charged for it."
              : booking.shipping_charge === "invoice" || (booking.quote_invoiced_at ?? "").trim()
                ? `On the invoice${invoiceNo ? ` ${invoiceNo}` : ""}${booking.quote_invoiced_amount != null ? ` at ${fmtAmount(booking.quote_invoiced_amount)}` : ""}${booking.quote_invoiced_at ? ` since ${fmtDay(booking.quote_invoiced_at)}` : ""}.`
                : booking.quote_amount == null
                  ? "Waiting for logistics to quote it. Then put the quote on the invoice, or pay the shipping ourselves."
                  : "Not decided yet. Put the quote on the invoice, or pay the shipping ourselves."}
          </FlowRow>

          {onInvoice && (
            <div className="rounded-xl bg-success-bg border border-success/30 px-4 py-3 text-[13px] text-success-ink" role="status">
              On invoice {onInvoice.invoice_number}. Review and send it.
            </div>
          )}

          <FlowRow done={!gate.missing.includes("sent")} title="Invoice sent"
            actions={invoiceNo || booking.deal ? (
              <button type="button" onClick={openInvoice} className={`${btnGhost} flex items-center gap-1.5`}><ExternalLink size={12} /> Open the invoice</button>
            ) : undefined}>
            {!gate.missing.includes("sent")
              ? `The invoice${invoiceNo ? ` ${invoiceNo}` : ""} has been sent.`
              : `The invoice${invoiceNo ? ` ${invoiceNo}` : ""} has not been sent yet.`}
          </FlowRow>

          <FlowRow done={!gate.missing.includes("paid") || overridden} title="Customer paid">
            {!gate.missing.includes("paid")
              ? "The customer has paid."
              : overridden
                ? `Sent to book before it was paid. Override by ${booking.book_override_by || "the team"}${booking.book_override_at ? ` on ${fmtDay(booking.book_override_at)}` : ""}.`
                : "The customer has not paid yet."}
          </FlowRow>
        </div>
      </Section>
      {sendBar}
    </div>
  );

  const bookStep = (
    <div className="space-y-6">
      {atQuote && (
        <p className="text-[12px] text-muted">
          {full ? "Fill in the booking details any time. They are stored here and sent to logistics when you send the load to book." : "Your team sends the load to book. You can read what is here."}
        </p>
      )}
      <Section title={draft.stops.length ? "Pickup 1" : "Pickup"}>
        {placeBlock("pickup")}
        <div className={g2}>
          {t("pickup_contact", "Contact")}
          {t("pickup_phone", "Phone")}
          {t("pickup_dock", "Dock door")}
          <Field label="Pickup number">
            <input className={inp} value={draft.pickup_number} onChange={(e) => setPickupNumber(e.target.value)} />
          </Field>
          <ConfirmCheck checked={draft.confirmed} hasNumber={draft.pickup_number.trim() !== ""} onChange={(v) => set("confirmed", v)}
            stamp={draft.confirmed === base.confirmed && draft.pickup_number.trim() === base.pickup_number.trim() ? confirmedStamp(booking.pickup_number_confirmed_by, booking.pickup_number_confirmed_at) : ""} />
          {t("pickup_date", "Appointment date", { type: "date", hint: dateHint("pickup") })}
          {t("pickup_appt_time", "Appointment time", { type: "time" })}
          {t("pickup_window", "Time window", { placeholder: "8 to 12" })}
          <Field label="Dock notes" wide>
            <textarea className={area} value={draft.pickup_notes} onChange={(e) => set("pickup_notes", e.target.value)} />
          </Field>
        </div>
      </Section>

      {draft.stops.map((x, i) => (
        <Section key={i} title={`Pickup ${i + 2}`}>
          {stopEdit ? (
            <div className={g2}>
              {stopInput(i, "name", "Name")}
              {stopInput(i, "address", "Address")}
            </div>
          ) : (
            <Place name={x.name} address={x.address} canNames={booking.can_see_names} canAddr={booking.can_see_addresses} />
          )}
          <div className={g2}>
            {stopInput(i, "contact", "Contact")}
            {stopInput(i, "phone", "Phone")}
            {stopInput(i, "dock", "Dock door")}
            <Field label="Pickup number">
              <input className={inp} value={x.pickup_number ?? ""} onChange={(e) => setStopNumber(i, e.target.value)} />
            </Field>
            <ConfirmCheck checked={!!x.confirmed} hasNumber={(x.pickup_number ?? "").trim() !== ""}
              onChange={(v) => setDraft((d) => ({ ...d, stops: d.stops.map((s, j) => (j === i ? { ...s, confirmed: v } : s)) }))}
              stamp={base.stops[i] && !!base.stops[i].confirmed === !!x.confirmed ? confirmedStamp(base.stops[i].confirmed_by, base.stops[i].confirmed_at) : ""} />
            {stopInput(i, "window", "Time window")}
            <Field label="Dock notes" wide>
              <textarea className={area} value={x.notes} onChange={(e) => setStop(i, "notes", e.target.value)} />
            </Field>
          </div>
          {stopEdit && (
            <button type="button" onClick={() => setDraft((d) => ({ ...d, stops: d.stops.filter((_, j) => j !== i) }))}
              className="flex items-center gap-1 text-[12px] text-faint hover:text-danger-ink hover:bg-danger-bg px-2 h-8 rounded-lg transition-colors">
              <Trash2 size={12} /> Remove pickup {i + 2}
            </button>
          )}
        </Section>
      ))}
      {stopEdit && draft.stops.length < 9 && (
        <button type="button" onClick={() => setDraft((d) => ({ ...d, stops: [...d.stops, blankStop()] }))}
          className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink px-2 h-8 rounded-lg border border-line hover:bg-surface-2 transition-colors">
          <Plus size={13} /> Add a pickup
        </button>
      )}

      <Section title="Delivery">
        {placeBlock("delivery")}
        <div className={g2}>
          {t("delivery_contact", "Contact")}
          {t("delivery_phone", "Phone")}
          {t("delivery_dock", "Dock door")}
          {t("delivery_window", "Time window", { placeholder: "Around 2 pm" })}
          {t("delivery_date", "Appointment date", { type: "date", hint: dateHint("delivery") })}
          {t("delivery_appt_time", "Appointment time", { type: "time" })}
          <Field label="Delivery notes" wide>
            <textarea className={area} value={draft.delivery_notes} onChange={(e) => set("delivery_notes", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="Carrier">
        <RateCard by={{ bookingId: booking.id }} onOpenCarrier={(id) => setCarrierHost({ id })} />
        <div className={g2}>
          <Field label="Carrier">
            <CarrierPicker value={draft.carrier} carrierId={draft.carrier_id} carriers={carriersError ? null : carriers} canEdit={canEditCarrier}
              onType={setCarrier} onPick={pickCarrier} onSave={(name) => setCarrierHost({ seedName: name })} onOpen={(id) => setCarrierHost({ id })} />
          </Field>
          {noMoney ? (
            <Field label="Carrier rate"><p className="text-[12px] text-muted inline-flex items-center gap-1 h-9"><Lock size={11} />Hidden by your permissions</p></Field>
          ) : (
            <Field label="Carrier rate" hint={rateErr ?? "What the carrier is expected to charge."}>
              <NumberInput className={inp} value={draft.rate} placeholder="0.00" onValue={(_n, raw) => set("rate", raw)} />
            </Field>
          )}
          {t("broker", "Broker")}
          <Field label="Equipment">
            <EquipmentSelect value={draft.equipment} onChange={(v) => set("equipment", v)} />
          </Field>
          <Field label="Service">
            <select className={inp} value={draft.service} onChange={(e) => set("service", e.target.value)}>
              {SERVICES.map((s) => <option key={s} value={s}>{s || "Not set"}</option>)}
              {draft.service && !SERVICES.includes(draft.service) && <option value={draft.service}>{draft.service}</option>}
            </select>
          </Field>
          {t("bol", "BOL number")}
          {t("pro", "PRO number")}
          {t("reference", "Carrier reference")}
          {t("tracking_url", "Tracking link", { wide: true, placeholder: "https://" })}
          {t("driver_name", "Driver name")}
          {t("driver_phone", "Driver phone")}
          {t("truck_number", "Truck number")}
          {t("trailer_number", "Trailer number")}
        </div>
      </Section>

      <Section title="Notes">
        <textarea className={area} value={draft.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything else worth writing down" />
      </Section>

      {sendBar}
    </div>
  );

  const pickupStep = (
    <div className="space-y-6">
      <Section title="Pickup">
        <Place name={draft.pickup_name} address={draft.pickup_address} canNames={booking.can_see_names} canAddr={booking.can_see_addresses} />
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          <div className="min-w-0 space-y-3">
            <div className="text-[12px] font-medium text-ink-2">Appointment</div>
            {t("pickup_date", "Date", { type: "date", hint: dateHint("pickup") })}
            {t("pickup_appt_time", "Time", { type: "time" })}
          </div>
          <div className="min-w-0 space-y-3">
            <div className="text-[12px] font-medium text-ink-2">Actual</div>
            <Field label="Date" hint="Filling this in moves the load to On the way.">
              <input className={inp} type="date" value={draft.picked_up_at} onChange={(e) => setActual("picked_up_at", e.target.value)} />
            </Field>
            {t("picked_up_time", "Time", { type: "time" })}
          </div>
        </div>
        {draft.stops.length > 0 && (
          <p className="text-[12px] text-muted">Pickup times for the other {draft.stops.length === 1 ? "stop" : "stops"} are on the Book step.</p>
        )}
      </Section>
    </div>
  );

  const deliveryStep = (
    <div className="space-y-6">
      <Section title="Delivery">
        <Place name={draft.delivery_name} address={draft.delivery_address} canNames={booking.can_see_names} canAddr={booking.can_see_addresses} />
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          <div className="min-w-0 space-y-3">
            <div className="text-[12px] font-medium text-ink-2">ETA or appointment</div>
            {t("delivery_date", "Date", { type: "date", hint: dateHint("delivery") })}
            {t("delivery_appt_time", "Time", { type: "time" })}
            {t("delivery_window", "Window", { placeholder: "Around 2 pm" })}
          </div>
          <div className="min-w-0 space-y-3">
            <div className="text-[12px] font-medium text-ink-2">Actual</div>
            <Field label="Date" hint="Filling this in moves the load to Delivered.">
              <input className={inp} type="date" value={draft.delivered_at} onChange={(e) => setActual("delivered_at", e.target.value)} />
            </Field>
            {t("delivered_time", "Time", { type: "time" })}
          </div>
        </div>
        <Field label="Delivery notes">
          <textarea className={area} value={draft.delivery_notes} onChange={(e) => set("delivery_notes", e.target.value)} />
        </Field>
      </Section>
      <Section title="Paperwork">
        <PaperworkZones booking={booking} kinds={["pod"]} onBooking={takeServerCopy} />
      </Section>
      {track && (
        <Section title="Tracking">
          <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[12.5px] text-ink-2">
            {[track.carrier, track.status || track.stage, track.last_location].filter(Boolean).join(", ") || "Waiting for the carrier's first update"}
            {track.last_update_at ? <span className="text-muted">{" "}(updated {fmtDay(track.last_update_at)})</span> : null}
          </div>
        </Section>
      )}
    </div>
  );

  const payStep = (
    <div className="space-y-6">
      <Section title="Paperwork">
        <PaperworkZones booking={booking} kinds={["bol", "pod", "carrier_invoice", "other"]} onBooking={takeServerCopy} />
      </Section>

      <Section title="Carrier payment">
        {booking.shipping_billed != null && (
          <div className="rounded-lg bg-surface-2 border border-line px-3 py-2 text-[13px]">
            <span className="text-muted">Charged to the customer for shipping:</span>{" "}
            <span className="font-semibold text-ink tabular-nums">{fmtAmount(booking.shipping_billed)}</span>
            {(booking.trucks_on_deal ?? 0) > 1 && (
              <div className="text-[11.5px] text-muted mt-0.5">for the {booking.trucks_on_deal} trucks on this shipment</div>
            )}
          </div>
        )}
        {noMoney ? (
          <p className="text-[12px] text-muted inline-flex items-center gap-1"><Lock size={11} />Shipping amounts are hidden by your permissions.</p>
        ) : (
          <>
            <div className={g2}>
              <Field label="Carrier rate" hint={rateErr ?? "What the carrier is expected to charge."}>
                <NumberInput className={inp} value={draft.rate} placeholder="0.00" onValue={(_n, raw) => set("rate", raw)} />
              </Field>
              {t("pay_due_date", "Pay due date", { type: "date", hint: "When the carrier has to be paid." })}
            </div>
            <dl className="rounded-lg bg-surface-2 border border-line px-3 py-2.5 text-[13px] space-y-2">
              <div className="min-w-0">
                <dt className="text-[11.5px] text-muted">How the carrier gets paid</dt>
                <dd className="text-ink break-words flex items-center gap-2 flex-wrap">
                  <span>{payMethodLabel(booking.carrier_pay_method) || booking.carrier_pay_method || "-"}</span>
                  {booking.carrier_id
                    ? canEditCarrier && <button type="button" onClick={() => setCarrierHost({ id: booking.carrier_id, edit: true })} className="text-[12px] text-accent font-medium hover:underline">Edit carrier</button>
                    : <span className="text-[12px] text-muted">Pick the carrier on the Book step.</span>}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11.5px] text-muted">Payment</dt>
                <dd className="text-ink break-words flex items-center gap-2 flex-wrap">
                  <span>{paymentLine(booking)}</span>
                  {booking.paid_amount != null && <BankLinkPill state={booking.bank_linked ?? ""} />}
                </dd>
              </div>
            </dl>
            {canPay && (
              <div className="flex items-center gap-2 flex-wrap">
                {booking.paid_amount == null ? (
                  <button type="button" onClick={() => setPayTarget(payFor)} className={btnPrimary}>Mark paid</button>
                ) : (
                  <>
                    <button type="button" onClick={() => setPayTarget(payFor)} className={btnGhost}>Change</button>
                    {booking.bank_linked !== "linked" && (
                      <button type="button" onClick={() => setLinkTarget(payFor)} className={btnGhost}>Link bank payment</button>
                    )}
                    <button type="button" onClick={async () => { if (await undoCarrierPaid(booking.id, payFor.label, booking.paid_amount)) reloadLoad(); }}
                      className={btnGhost}>Undo</button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Section>

      {((booking.bols?.length ?? 0) > 0 || canEditCarrier) && (
        <Section title="BOLs for this load">
          <div className="flex items-center gap-1.5 flex-wrap">
            {(booking.bols ?? []).map((x) => (
              <button key={x.id} type="button" onClick={() => leaveFor(() => openLogisticsHit({ kind: "BOL", id: x.id }))} title="Open this BOL"
                className="px-2.5 h-8 rounded-lg border border-line text-[12.5px] font-mono text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors">{x.number}</button>
            ))}
            {canEditCarrier && (
              <button type="button" onClick={() => leaveFor(() => startBolFromLoad(booking.id))}
                className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">Make a BOL from this load</button>
            )}
          </div>
        </Section>
      )}
    </div>
  );

  const stepBody: Record<LoadSection, ReactNode> = { quote: quoteStep, invoice: full ? invoiceStep : null, book: bookStep, pickup: pickupStep, delivery: deliveryStep, pay: payStep };
  const goStage = (k: StageKey) => setStep(sectionOfStage(k, full));

  // The page covers the content area (the sidebar stays): it is put into <main>, which is the positioned box
  // that area lives in. Outside the app (a test page) there is no <main> and it covers the window.
  const host = typeof document !== "undefined" ? document.querySelector("main") : null;

  const page = (
    <>
      <div
        role="dialog" aria-modal="true" aria-label={`Booking ${loadNumber(booking)}`}
        className={`${host ? "absolute" : "fixed"} inset-0 z-40 bg-surface flex flex-col animate-fade-in`}
      >
        <div className="border-b border-line px-6 pt-3 pb-3 flex-shrink-0">
          <div className="max-w-[1120px] mx-auto w-full space-y-2.5">
            <button type="button" onClick={tryClose}
              className="flex items-center gap-1.5 -ml-2 px-2 h-8 rounded-lg text-[12.5px] text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors">
              <ArrowLeft size={14} /> Back to loads
            </button>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h3 className="text-[22px] font-semibold text-ink font-mono tracking-tight">{loadNumber(booking)}</h3>
                {route && <div className="text-[13px] text-ink-2 truncate mt-0.5">{route}</div>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <FreightStatusPill status={draft.status} logistics={lg} />
                {isHot(booking) && <UrgentPill />}
                {unconfirmed && <PickupNumberPill />}
                <label className="flex items-center gap-1.5 text-[12.5px] text-ink cursor-pointer whitespace-nowrap ml-2">
                  <input type="checkbox" checked={draft.urgent} onChange={(e) => set("urgent", e.target.checked)} className="w-4 h-4 accent-danger" />
                  Urgent
                </label>
                <select aria-label="Status" value={draft.status} onChange={(e) => pickStatus(e.target.value as FreightStatus)}
                  className="h-8 rounded-lg border border-line bg-surface text-[12.5px] text-ink px-2 focus:outline-none focus:ring-2 focus:ring-accent/40">
                  {STATUS_ORDER.map((s) => <option key={s} value={s} disabled={s !== draft.status && !statusAllowed(s, booking.status, dealEdit)}>{statusWord(s, lg)}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="border-b border-line flex-shrink-0 px-4">
          <div className="max-w-[1120px] mx-auto w-full">
            <LoadTracker stages={stages} onGo={goStage} />
          </div>
        </div>

        <div className="border-b border-line flex-shrink-0 px-6">
          <div role="tablist" aria-label="Sections" className="max-w-[1120px] mx-auto w-full flex items-center gap-1 overflow-x-auto">
            {sections.map((s) => (
              <button key={s.key} type="button" role="tab" aria-selected={here === s.key} onClick={() => setStep(s.key)}
                className={`h-10 px-3.5 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  here === s.key ? "border-accent text-ink font-medium" : "border-transparent text-muted hover:text-ink-2"}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div ref={body} className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[1120px] mx-auto w-full px-6 py-5 space-y-6">
            {full && atQuote && paid && (
              <div className="rounded-xl bg-success-bg border border-success/30 px-4 py-3 text-[13px] text-success-ink" role="status">{PAID_BANNER}</div>
            )}

            {full && booking.deal && (
              <div className="text-[12.5px] text-ink-2 min-w-0">
                <span className="font-medium text-ink">{booking.deal.invoice_number || "Deal"}</span>
                {booking.deal.client_name ? <span className="text-muted">{" "}for {booking.deal.client_name}</span> : null}
              </div>
            )}

            {isHot(booking) && (
              <div className="rounded-xl bg-danger-bg border border-danger/30 px-4 py-3 text-[13px] text-danger-ink" role="status">
                <span className="font-semibold">Urgent.</span> {booking.status === "quote" ? "Quote this one first." : "Book this truck first."}
                {booking.pickup_date && <> Pickup {booking.pickup_date === localDay() ? "today" : fmtDay(booking.pickup_date)}{booking.pickup_window ? `, ${booking.pickup_window}` : ""}.</>}
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

            {stepBody[here]}

            <div className="text-[11.5px] text-muted">
              {booking.updated_by_name ? `Last changed by ${booking.updated_by_name}` : booking.created_by_name ? `Sent by ${booking.created_by_name}` : ""}
              {booking.updated_at ? ` ${fmtDay(booking.updated_at)}` : ""}
            </div>
          </div>
        </div>

        {/* Pinned: save never scrolls away. */}
        <div className="border-t border-line bg-surface px-6 py-3 flex-shrink-0">
          <div className="max-w-[1120px] mx-auto w-full space-y-2">
            {error && <div className="text-[12px] text-danger-ink" role="alert">{error}</div>}
            <div className="flex items-center gap-2 flex-wrap">
              {/* While the team fills the freight in, the team adds the trucks (the logistics person could not fill a new one). */}
              {!freightLocked && (dealEdit || !isQuoteStage(booking.status)) && (
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
              <button type="button" onClick={() => save()} disabled={!dirty || saving} className={`ml-auto ${btnPrimary}`}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {carrierHost && (
        <CarrierHost id={carrierHost.id} edit={carrierHost.edit} seedName={carrierHost.seedName} onClose={() => setCarrierHost(null)} onChanged={reloadCarriers}
          onSaved={(c) => { if (!carrierHost.id) pickCarrier(c); }} />
      )}
      {payTarget && <MarkPaidSheet target={payTarget} onClose={() => setPayTarget(null)} onDone={() => { setPayTarget(null); reloadLoad(); }} />}
      {linkTarget && <LinkBankSheet target={linkTarget} onClose={() => setLinkTarget(null)} onDone={() => { setLinkTarget(null); reloadLoad(); }} />}
      {invoiceSheet && (
        <InvoiceLineSheet
          booking={booking}
          initial={moneyText(booking.quote_amount)}
          onClose={() => setInvoiceSheet(false)}
          onDone={async (r) => {
            setInvoiceSheet(false);
            setOnInvoice(r);
            toast(`On invoice ${r.invoice_number}`);
            // The load now says it is on the invoice. A failed refresh is not worth an error: the invoice is done.
            try { takeServerCopy(await api.logistics.get(booking.id)); } catch { /* the banner above already says it */ }
          }}
        />
      )}
    </>
  );
  return host ? createPortal(page, host) : page;
}
