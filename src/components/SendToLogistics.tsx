import { Check, FileText, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, type DealFlow, type FreightBooking, type FreightBookingPatch, type FreightDraft, type FreightPlace, type FreightPrefill } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { carrierByName, laneEnds } from "../lib/logisticsCarriers";
import { CATCH_UP_STEPS, blankCatchUp, catchUpFields, catchUpProblem, dayLabel, type CatchUpForm } from "../lib/catchUpLoad";
import { ADDRESS_HINT, addressNote, relabelPickupError } from "../lib/fullAddress";
import { bolNote } from "../lib/bookingText";
import { fmtDayLabel, loadNumber } from "../lib/logisticsLoad";
import { applyPlace, blankSendForm, blankStop, formFromDraft, isBlank, placeInUse, sendGaps, type Gap, type PlaceTarget, type SectionKey, type SendForm, type SendStop } from "../lib/sendForm";
import { tidyAddress, tidyDims, tidyEmail, tidyName, tidyPhone, tidyWindow } from "../lib/tidy";
import StatusPill from "./StatusPill";
import { CarrierHost, CarrierPicker, useCarriers } from "./LogisticsCarriers";
import { RateCard } from "./LogisticsRates";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";
import { AccessorialsField, EquipmentSelect, FileDrop, fileBase64, fileSize, uploadFiles } from "./LogisticsBookingForm";

// R-651: Send to logistics as a full screen. It replaces the R-400 pop-up (and its R-479 "Already moving" mode).
// - Nothing is filled in by itself. It asks: a line at the top offers the supplier and buyer on the deal, and above each
//   pickup and the delivery are the places earlier loads used for that supplier or buyer (newest first, several, since a
//   supplier ships from more than one place), each bringing its phone, time and BOL email. The server finds them
//   (send_drafts.rs).
// - What each section still needs is listed on the left and on each box, from `sendGaps`, the same list the send checks.
// - Save draft keeps the form and its files on the server, so it opens again on any computer or the phone; closing with
//   changes saves too. Sending from a draft moves its files onto the load. "Already moving" keeps no draft.
// - Each box is tidied when it is left (tidy.ts): addresses, phones, times, emails and pallet sizes read one way.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:border-ink transition-colors duration-150";

/** Today, Tomorrow or a date. A second click on the chip that is on clears it. */
export function DayChips({ label, value, onChange, bad }: { label: string; value: string; onChange: (v: string) => void; bad?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {([["Today", 0], ["Tomorrow", 1]] as const).map(([word, add]) => {
        const d = new Date(); d.setDate(d.getDate() + add);
        const v = localDay(d);
        const on = value === v;
        return (
          <button key={word} type="button" aria-pressed={on} onClick={() => onChange(on ? "" : v)}
            className={`h-8 px-3 rounded-lg border text-[12px] transition-colors duration-150 ${on ? "border-ink bg-surface-3 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
            {word}
          </button>
        );
      })}
      <input type="date" className={`${inp} w-auto ${bad ? "border-warning" : ""}`} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** The extra fields of "Already moving" (R-479): the step, the carrier from the directory, what it costs and the markup,
 *  who pays for the shipping, and the day for the step. The state lives in the screen; this only draws it. */
function CatchUpFields({ value, onChange, onOpenCarrier }: {
  value: CatchUpForm; onChange: (patch: Partial<CatchUpForm>) => void; onOpenCarrier: (id: string) => void;
}) {
  const dir = useCarriers();
  const today = localDay();
  const setCarrier = (name: string) => {
    const hit = dir.list && !dir.error ? carrierByName(name, dir.list) : null;
    onChange({ carrier: name, carrierId: hit ? hit.id : "" });
  };
  const chips: [string, number][] = value.step === "booked" ? [["Today", 0], ["Tomorrow", 1]] : [["Today", 0], ["Yesterday", -1]];
  const dayAt = (add: number) => { const d = new Date(); d.setDate(d.getDate() + add); return localDay(d); };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[12px] font-medium text-ink-2">Where the load is</div>
        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Step">
          {CATCH_UP_STEPS.map((s) => {
            const on = value.step === s.value;
            return (
              <button key={s.value} type="button" aria-pressed={on} onClick={() => onChange({ step: s.value, day: "" })}
                className={`h-8 px-3 rounded-lg border text-[12px] transition-colors duration-150 ${on ? "border-ink bg-surface-3 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      {value.step && (
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-ink-2">{dayLabel(value.step)}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {chips.map(([label, add]) => {
              const v = dayAt(add);
              const on = value.day === v;
              return (
                <button key={label} type="button" aria-pressed={on} onClick={() => onChange({ day: on ? "" : v })}
                  className={`h-8 px-3 rounded-lg border text-[12px] transition-colors duration-150 ${on ? "border-ink bg-surface-3 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                  {label}
                </button>
              );
            })}
            <input type="date" className={`${inp} w-auto`} aria-label={dayLabel(value.step)} value={value.day}
              max={value.step === "booked" ? undefined : today} onChange={(e) => onChange({ day: e.target.value })} />
          </div>
          <div className="text-[12px] text-muted">The day moves the deal's own dates.</div>
        </div>
      )}
      <div className="space-y-2">
        <div className="text-[12px] font-medium text-ink-2">Carrier</div>
        <CarrierPicker value={value.carrier} carrierId={value.carrierId} carriers={dir.list} canEdit={false}
          onType={setCarrier} onPick={(c) => onChange({ carrier: c.name, carrierId: c.id })} onSave={() => {}} onOpen={onOpenCarrier} />
        {value.carrier.trim() && !value.carrierId && dir.list && (
          <div className="text-[12px] text-muted">Pick a saved carrier so its payment terms apply.</div>
        )}
        <div className="grid grid-cols-2 gap-3 max-w-[520px]">
          <div className="min-w-0">
            <label className="block text-[12px] text-muted mb-1">Carrier cost (required)</label>
            <NumberInput className={inp} value={value.cost} placeholder="0.00" onValue={(_n, raw) => onChange({ cost: raw })} />
          </div>
          <div className="min-w-0">
            <label className="block text-[12px] text-muted mb-1">Markup (%)</label>
            <NumberInput className={inp} value={value.markup} placeholder="0" onValue={(_n, raw) => onChange({ markup: raw })} />
          </div>
        </div>
      </div>
      <label className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors duration-150 max-w-[520px] ${value.own ? "border-line-3 bg-surface-2" : "border-line hover:bg-surface-2"}`}>
        <input type="checkbox" checked={value.own} onChange={(e) => onChange({ own: e.target.checked })} className="w-4 h-4 mt-0.5 accent-accent" />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-ink">We pay the shipping ourselves</span>
          <span className="block text-[12px] text-muted">The customer is not charged for it. Set this now: it cannot be set once the load is booked.</span>
        </span>
      </label>
    </div>
  );
}

/** One box with its label. A required box that is empty says Required; once a send was tried it says Still needed. */
function Field({ label, need, bad, wide, children, under }: {
  label: string; need?: boolean; bad?: boolean; wide?: boolean; children: ReactNode; under?: ReactNode;
}) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[12px] font-medium text-ink-2">{label}</span>
        {need && <span className={`text-[12px] ${bad ? "text-warning-ink font-medium" : "text-muted"}`}>{bad ? "Still needed" : "Required"}</span>}
      </div>
      {children}
      {under}
    </div>
  );
}

/** A section of the screen: its title, what it still needs (or that it is done), and its boxes. */
function Section({ id, title, sub, gaps, optional, children }: {
  id: string; title: string; sub?: string; gaps?: Gap[]; optional?: boolean; children: ReactNode;
}) {
  const n = gaps?.length ?? 0;
  return (
    <section id={id} className="rounded-xl border border-line bg-surface scroll-mt-4">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {sub && <p className="text-[12px] text-muted mt-0.5">{sub}</p>}
        </div>
        {optional ? <span className="text-[12px] text-muted whitespace-nowrap">Optional</span>
          : gaps && (n > 0 ? <StatusPill tone="warning">{n} still needed</StatusPill>
            : <span className="inline-flex items-center gap-1 text-[12px] text-success-ink whitespace-nowrap"><Check size={13} /> Ready</span>)}
      </div>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </section>
  );
}

/** "On the deal", or the load it came from and its day. */
function sourceWord(p: FreightPlace): string {
  if (p.source === "deal") return p.load_number ? `On the deal, last used on ${p.load_number}` : "On the deal";
  return [p.load_number, fmtDayLabel(p.day)].filter(Boolean).join(", ");
}

/** The places this pickup or the delivery can be filled from. Three show, the rest behind Show more. */
function FillFrom({ places, form, target, onPick }: {
  places: FreightPlace[]; form: SendForm; target: PlaceTarget; onPick: (p: FreightPlace) => void;
}) {
  const [all, setAll] = useState(false);
  if (!places.length) return null;
  const shown = all ? places : places.slice(0, 3);
  const when = target === "delivery" ? "Deliver" : "Pick up";
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] text-muted">
        {target === "delivery" ? "Fill in from the buyer on the deal or a load sent to them before" : "Fill in from a supplier on the deal or a load picked up from them before"}
      </div>
      <div className="grid gap-1.5">
        {shown.map((p, i) => {
          const on = placeInUse(form, target, p);
          const details = [p.phone, p.window && `${when} ${p.window}`, p.bol_to && `BOL to ${p.bol_to}`, target === "delivery" ? p.notes : ""].filter(Boolean).join(" · ");
          return (
            <button key={i} type="button" onClick={() => onPick(p)} aria-pressed={on}
              className={`text-left rounded-lg border px-3 py-2 min-w-0 transition-colors duration-150 ${on ? "border-ink bg-surface-3" : "border-line hover:bg-surface-2"}`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[13px] font-medium text-ink truncate">{p.name || "No name"}</span>
                <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{sourceWord(p)}</span>
                {on && <Check size={13} className="text-success-ink flex-shrink-0" aria-label="In use" />}
              </div>
              <div className="text-[12px] text-ink-2 truncate">{p.address || "No address on file"}</div>
              {details && <div className="text-[12px] text-muted truncate">{details}</div>}
            </button>
          );
        })}
      </div>
      {places.length > 3 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="ui-link text-[12px]">
          {all ? "Show fewer" : `Show ${places.length - 3} more`}
        </button>
      )}
    </div>
  );
}

/** The places the server offers, or, from a server older than R-651, the deal's own names and addresses. */
function placesOf(pre: FreightPrefill | null): { pickups: FreightPlace[]; deliveries: FreightPlace[] } {
  if (!pre) return { pickups: [], deliveries: [] };
  const deal = (name: string, address: string): FreightPlace => ({
    source: "deal", load_number: "", day: "", name, address, phone: "", window: "", bol_to: "", notes: "", equipment: "", accessorials: "",
  });
  return {
    pickups: pre.pickup_suggestions ?? (pre.pickup_options ?? []).filter((o) => o.name || o.address).map((o) => deal(o.name, o.address)),
    deliveries: pre.delivery_suggestions ?? (pre.delivery_name || pre.delivery_address ? [deal(pre.delivery_name, pre.delivery_address)] : []),
  };
}

const SECTIONS: { id: string; key: SectionKey | "notes" | "moving"; title: string }[] = [
  { id: "stl-moving", key: "moving", title: "Where the load is" },
  { id: "stl-pickup", key: "pickup", title: "Pickup" },
  { id: "stl-delivery", key: "delivery", title: "Delivery" },
  { id: "stl-freight", key: "freight", title: "Freight" },
  { id: "stl-notes", key: "notes", title: "Note and files" },
];

const listWords = (l: string[]) => (l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);
const timeOf = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase(); };

export default function SendToLogistics({ flow, billed, moving, onClose, onSent }: {
  flow: DealFlow; billed: number | null; moving?: boolean; onClose: () => void; onSent: (made?: FreightBooking) => void;
}) {
  const [pre, setPre] = useState<FreightPrefill | null>(null);
  const [ready, setReady] = useState(false);
  const [form, setForm] = useState<SendForm>(blankSendForm);
  // What was last saved (or opened), to know whether closing has anything to keep.
  const [savedAs, setSavedAs] = useState(JSON.stringify(blankSendForm()));
  const [draft, setDraft] = useState<FreightDraft | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [cu, setCu] = useState<CatchUpForm>(blankCatchUp);
  const [byTeam, setByTeam] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"" | "send" | "save" | "close">("");
  const [err, setErr] = useState("");
  const [askFill, setAskFill] = useState(true);
  const [carrierId, setCarrierId] = useState<string | null>(null);
  // R-538: a time is tidied only when it was typed this time, not every time the box is left.
  const was = useRef("");

  const set = (patch: Partial<SendForm>) => { setForm((f) => ({ ...f, ...patch })); setErr(""); };
  const setStop = (i: number, patch: Partial<SendStop>) => setForm((f) => ({ ...f, extra_pickups: f.extra_pickups.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const setCatchUp = (patch: Partial<CatchUpForm>) => { setCu((c) => ({ ...c, ...patch })); setErr(""); };

  useEffect(() => {
    let dead = false;
    api.logistics.settings.get().then((s) => { if (!dead) setByTeam(s.freight_by_team !== false); }).catch(() => {});
    const blank: FreightPrefill = { pickup_name: "", pickup_address: "", delivery_name: "", delivery_address: "", pickup_options: [] };
    Promise.all([
      api.logistics.prefill(flow.id).catch((e) => { if (!dead) setErr(String(e)); return blank; }),
      moving ? Promise.resolve(null) : api.logistics.drafts.get(flow.id).then((r) => r.draft).catch(() => null),
    ]).then(([p, d]) => {
      if (dead) return;
      setPre(p);
      if (d) {
        const f = formFromDraft(d.body);
        setDraft(d); setForm(f); setSavedAs(JSON.stringify(f)); setAskFill(false);
      }
      setReady(true);
    });
    return () => { dead = true; };
  }, [flow.id, moving]);

  const { pickups, deliveries } = placesOf(pre);
  const gaps = useMemo(() => (moving ? [] : sendGaps(form, byTeam)), [form, byTeam, moving]);
  const gapKeys = new Set(gaps.map((g) => g.key));
  const reqKeys = useMemo(() => new Set(sendGaps(blankSendForm(), byTeam).map((g) => g.key)), [byTeam]);
  const bad = (k: string) => tried && gapKeys.has(k);
  const required = (k: string) => !moving && reqKeys.has(k);
  const bySection = (s: SectionKey) => gaps.filter((g) => g.section === s);
  const dirty = JSON.stringify(form) !== savedAs || files.length > 0;
  const lane = laneEnds(form.pickup_address, form.delivery_address);

  // The places on the deal, offered once at the top while nothing is filled in.
  const dealPickup = pickups.find((p) => p.source === "deal" && p.address);
  const dealDelivery = deliveries.find((p) => p.source === "deal" && p.address);
  const offerDeal = ready && askFill && (dealPickup || dealDelivery)
    && !form.pickup_name.trim() && !form.pickup_address.trim() && !form.delivery_name.trim() && !form.delivery_address.trim();
  const fillDeal = () => {
    setForm((f) => {
      let out = f;
      if (dealPickup) out = applyPlace(out, "pickup", dealPickup);
      if (dealDelivery) out = applyPlace(out, "delivery", dealDelivery);
      return out;
    });
    setAskFill(false);
  };

  const goTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  /** The form as it is kept and sent: every box tidied. */
  const tidied = (f: SendForm): SendForm => ({
    ...f,
    pickup_name: tidyName(f.pickup_name), pickup_address: tidyAddress(f.pickup_address), pickup_phone: tidyPhone(f.pickup_phone),
    bol_to: tidyEmail(f.bol_to), delivery_name: tidyName(f.delivery_name), delivery_address: tidyAddress(f.delivery_address),
    delivery_phone: tidyPhone(f.delivery_phone), dimensions: tidyDims(f.dimensions),
    extra_pickups: f.extra_pickups.map((s) => ({ ...s, name: tidyName(s.name), address: tidyAddress(s.address), phone: tidyPhone(s.phone) })),
  });

  const saveDraft = async (): Promise<boolean> => {
    const body = tidied(form);
    setBusy("save"); setErr("");
    try {
      let d = (await api.logistics.drafts.save(flow.id, body)).draft;
      for (const f of files) {
        try { d = (await api.logistics.drafts.addFile(flow.id, f.name, await fileBase64(f))).draft; }
        catch (e) { toast(`${f.name}: ${String(e)}`, "error"); }
      }
      setDraft(d); setFiles([]); setForm(body); setSavedAs(JSON.stringify(body));
      setBusy("");
      return true;
    } catch (e) { setErr(String(e)); setBusy(""); return false; }
  };

  const close = async () => {
    if (busy) return;
    // Nothing typed is lost: a send form with changes is kept as a draft on the way out.
    if (!moving && dirty && !(isBlank(form) && files.length === 0)) {
      if (await saveDraft()) { toast("Draft saved"); onClose(); }
      return;
    }
    onClose();
  };

  // Esc leaves the screen (saving first), unless a carrier card is open over it.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !carrierId) { e.preventDefault(); closeRef.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carrierId]);

  const discard = async () => {
    if (!draft) return;
    try { await api.logistics.drafts.discard(flow.id); } catch (e) { toast(String(e), "error"); return; }
    const f = blankSendForm();
    setDraft(null); setForm(f); setFiles([]); setSavedAs(JSON.stringify(f)); setAskFill(true); setTried(false);
    toast("Draft thrown away");
  };

  const removeDraftFile = async (id: string) => {
    try { setDraft((await api.logistics.drafts.removeFile(flow.id, id)).draft); }
    catch (e) { toast(String(e), "error"); }
  };

  const send = async () => {
    setTried(true);
    if (moving) { const problem = catchUpProblem(cu, localDay()); if (problem) { setErr(problem); goTo("stl-moving"); return; } }
    if (gaps.length) {
      setErr(`Fill in ${listWords(gaps.map((g) => g.label.charAt(0).toLowerCase() + g.label.slice(1)))} first.`);
      goTo(SECTIONS.find((s) => s.key === gaps[0].section)?.id ?? "stl-pickup");
      return;
    }
    const f = tidied(form);
    setForm(f);
    setBusy("send"); setErr("");
    // The sheet index of each extra pickup that is sent (a blank row is dropped); the server counts only those.
    const sent = f.extra_pickups.map((_, i) => i).filter((i) => f.extra_pickups[i].name.trim() || f.extra_pickups[i].address.trim());
    try {
      const lead: FreightBookingPatch = moving ? catchUpFields(cu) : { status: "quote" as const, urgent: f.urgent, pickup_date: f.pickup_date };
      const made = await api.logistics.create(flow.id, {
        ...lead,
        pickup_window: tidyWindow(f.pickup_window),
        pickup_name: f.pickup_name, pickup_address: f.pickup_address, pickup_phone: f.pickup_phone,
        ...(f.bol_to ? { pickup_notes: bolNote(f.bol_to) } : {}),
        extra_pickups: sent.map((i) => ({ ...blankStopFull(), ...f.extra_pickups[i], window: tidyWindow(f.extra_pickups[i].window) })),
        delivery_name: f.delivery_name, delivery_address: f.delivery_address, delivery_phone: f.delivery_phone,
        delivery_window: tidyWindow(f.delivery_window), delivery_notes: f.delivery_notes.trim(),
        ...(!moving && f.delivery_date ? { delivery_date: f.delivery_date } : {}),
        pallets: f.pallets.trim(), pieces: f.pieces.trim(), weight_lbs: f.weight_lbs.trim(),
        freight_class: f.freight_class.trim(), dimensions: f.dimensions, commodity: f.commodity.trim(),
        accessorials: f.accessorials.trim(), equipment: f.equipment, request_note: f.request_note.trim(),
      }, { fromDraft: !moving && !!draft });
      // The load exists now; a file that fails to upload says so and can be added on the load.
      if (files.length) await uploadFiles(made.id, files);
      toast(moving ? `${loadNumber(made)} is with Logistics` : f.urgent ? "Quote asked as urgent" : "Quote asked");
      onSent(made);
    } catch (e) { setErr(relabelPickupError(String(e), sent)); }
    setBusy("");
  };

  // Tidy a box when it is left.
  const onLeave = (k: keyof SendForm, fn: (s: string) => string) => () => {
    const v = form[k];
    if (typeof v !== "string") return;
    const t = fn(v);
    if (t !== v) set({ [k]: t } as Partial<SendForm>);
  };
  const timeBox = (value: string, onValue: (v: string) => void, label: string, placeholder: string, isBad?: boolean) => (
    <input className={`${inp} ${isBad ? "border-warning" : ""}`} aria-label={label} placeholder={placeholder} value={value}
      onChange={(e) => onValue(e.target.value)}
      onFocus={(e) => { was.current = e.target.value; }}
      onBlur={() => { if (value === was.current) return; const t = tidyWindow(value); if (t !== value) onValue(t); }} />
  );
  const cls = (k: string) => `${inp} ${bad(k) ? "border-warning" : ""}`;

  const addStop = () => {
    // A new pickup starts as the next supplier on the deal that is not already one, or blank.
    const used = [form.pickup_name, ...form.extra_pickups.map((s) => s.name)].map((n) => n.trim().toLowerCase());
    const next = pickups.find((p) => p.source === "deal" && p.name && !used.includes(p.name.trim().toLowerCase()));
    setForm((f) => ({ ...f, extra_pickups: [...f.extra_pickups, next ? { ...blankStop(), name: next.name, address: next.address } : blankStop()] }));
  };

  const shown = SECTIONS.filter((s) => (s.key === "moving" ? !!moving : true));
  const title = moving ? "Already moving" : "Send to logistics";
  const savedLine = draft ? `Draft saved ${fmtDayLabel(draft.updated_at)}${timeOf(draft.updated_at) ? `, ${timeOf(draft.updated_at)}` : ""}${draft.updated_by_name ? ` by ${draft.updated_by_name}` : ""}` : "";

  return (
    <>
      <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[60] bg-surface-2 flex flex-col">
        <header className="flex items-center gap-4 px-6 h-16 border-b border-line bg-surface flex-shrink-0">
          <button type="button" onClick={close} title="Close" aria-label="Close"
            className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-surface-3 transition-colors duration-150"><X size={18} /></button>
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold text-ink truncate">{title}</h1>
            <p className="text-[12px] text-muted truncate">
              {[flow.invoice_number, pre?.delivery_name, moving ? "Log a load the team already has moving." : "Ask logistics for a quote. You send it to book from the load once it is on the invoice and paid."].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3 flex-shrink-0">
            {!moving && ready && (
              <span className="hidden lg:inline text-[12px] text-muted">{busy === "save" ? "Saving..." : dirty ? "Changes not saved" : savedLine}</span>
            )}
            {!moving && (
              <button type="button" onClick={saveDraft} disabled={!ready || !!busy || !dirty} className="ui-btn">
                {busy === "save" ? "Saving..." : "Save draft"}
              </button>
            )}
            {!moving && ready && (
              gaps.length
                ? <span className="text-[12px] font-medium text-warning-ink whitespace-nowrap">{gaps.length} still needed</span>
                : <span className="inline-flex items-center gap-1 text-[12px] text-success-ink whitespace-nowrap"><Check size={13} /> Ready to send</span>
            )}
            <button type="button" onClick={send} disabled={!ready || !!busy} className="ui-btn ui-btn-ink">
              {busy === "send" ? (moving ? "Moving..." : "Sending...") : moving ? "Move to Logistics" : "Ask for a quote"}
            </button>
          </div>
        </header>
        {err && <div className="px-6 py-2 text-[13px] text-danger-ink bg-danger-bg border-b border-danger-ink/20" role="alert">{err}</div>}

        <div className="flex-1 min-h-0 flex">
          <nav aria-label="Sections" className="hidden md:block w-[248px] flex-shrink-0 border-r border-line bg-surface overflow-y-auto px-3 py-4 space-y-1">
            {shown.map((s) => {
              const g = s.key === "pickup" || s.key === "delivery" || s.key === "freight" ? bySection(s.key) : [];
              return (
                <button key={s.id} type="button" onClick={() => goTo(s.id)}
                  className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface-2 transition-colors duration-150">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink">{s.title}</span>
                    <span className="ml-auto">
                      {s.key === "notes" ? <span className="text-[12px] text-muted">Optional</span>
                        : s.key === "moving" ? null
                        : g.length ? <StatusPill tone="warning">{g.length}</StatusPill>
                        : ready ? <Check size={14} className="text-success-ink" aria-label="Ready" /> : null}
                    </span>
                  </div>
                  {g.length > 0 && <div className="text-[12px] text-muted mt-0.5 leading-snug">{g.map((x) => x.label).join(", ")}</div>}
                </button>
              );
            })}
            {draft && !moving && (
              <div className="pt-4 mt-3 border-t border-line px-3 space-y-1.5">
                <div className="text-[12px] text-muted">{savedLine}</div>
                <button type="button" onClick={discard} className="text-[12px] text-muted hover:text-danger-ink transition-colors duration-150">Throw away the draft</button>
              </div>
            )}
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className="max-w-[1120px] mx-auto px-6 py-6 space-y-5">
              {!ready ? <div className="text-[13px] text-muted">Loading...</div> : (
                <>
                  {offerDeal && (
                    <div className="rounded-xl border border-line bg-surface px-5 py-4 flex items-start gap-4 flex-wrap">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-[14px] font-medium text-ink">Fill in the supplier and buyer on this deal?</div>
                        {dealPickup && <div className="text-[12.5px] text-ink-2 truncate"><span className="text-muted">Pickup</span> {dealPickup.name}, {dealPickup.address}</div>}
                        {dealDelivery && <div className="text-[12.5px] text-ink-2 truncate"><span className="text-muted">Delivery</span> {dealDelivery.name}, {dealDelivery.address}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setAskFill(false)} className="ui-btn">Not now</button>
                        <button type="button" onClick={fillDeal} className="ui-btn ui-btn-ink">Fill them in</button>
                      </div>
                    </div>
                  )}

                  {billed != null && (
                    <div className={`rounded-lg border px-4 py-2.5 text-[13px] ${billed > 0.005 ? "bg-surface border-line" : "bg-warning-bg border-warning/30 text-warning-ink"}`}>
                      {billed > 0.005
                        ? <><span className="text-muted">Charged to the customer for shipping</span>{" "}<span className="font-medium text-ink tabular-nums">{fmtAmount(billed)}</span></>
                        : "The invoice has no shipping line."}
                    </div>
                  )}

                  {moving && (
                    <Section id="stl-moving" title="Where the load is" sub="The step it is at, the carrier and what it costs.">
                      <CatchUpFields value={cu} onChange={setCatchUp} onOpenCarrier={setCarrierId} />
                    </Section>
                  )}

                  {!moving && (
                    <label className={`flex items-start gap-3 rounded-xl border px-5 py-3.5 cursor-pointer transition-colors duration-150 ${form.urgent ? "border-danger-ink/30 bg-danger-bg" : "border-line bg-surface hover:bg-surface-2"}`}>
                      <input type="checkbox" checked={form.urgent} onChange={(e) => set({ urgent: e.target.checked })} className="w-4 h-4 mt-0.5 accent-danger" />
                      <span className="min-w-0">
                        <span className={`block text-[13px] font-medium ${form.urgent ? "text-danger-ink" : "text-ink"}`}>Urgent</span>
                        <span className="block text-[12px] text-muted">It goes to the top of their list in red, and they get a notice that says urgent.</span>
                      </span>
                    </label>
                  )}

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
                    <Section id="stl-pickup" title="Pickup" sub="Where the truck collects the goods." gaps={moving ? undefined : bySection("pickup")}>
                      <FillFrom places={pickups} form={form} target="pickup" onPick={(p) => setForm((f) => applyPlace(f, "pickup", p))} />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="Name" need={required("pickup_name") && !form.pickup_name.trim()} bad={bad("pickup_name")} wide>
                          <input className={cls("pickup_name")} aria-label="Pickup name" value={form.pickup_name} onChange={(e) => set({ pickup_name: e.target.value })} onBlur={onLeave("pickup_name", tidyName)} />
                        </Field>
                        <Field label="Address" need={required("pickup_address") && !form.pickup_address.trim()} bad={bad("pickup_address")} wide
                          under={addressNote(form.pickup_address) ? <div className="text-[12px] text-muted mt-1">{addressNote(form.pickup_address)}</div> : null}>
                          <textarea className={`${cls("pickup_address")} h-auto py-2`} rows={2} placeholder={ADDRESS_HINT} aria-label="Pickup address" value={form.pickup_address}
                            onChange={(e) => set({ pickup_address: e.target.value })} onBlur={onLeave("pickup_address", tidyAddress)} />
                        </Field>
                        <Field label="Pickup day" need={required("pickup_date") && !form.pickup_date} bad={bad("pickup_date")} wide
                          under={!moving ? <div className="text-[12px] text-muted mt-1">The day moves the deal's pickup date.</div> : null}>
                          <DayChips label="Pickup day" value={form.pickup_date} onChange={(v) => set({ pickup_date: v })} bad={bad("pickup_date")} />
                        </Field>
                        <Field label="Pickup time" need={required("pickup_window") && !form.pickup_window.trim()} bad={bad("pickup_window")}>
                          {timeBox(form.pickup_window, (v) => set({ pickup_window: v }), "Pickup time", "Like 8 am to 2 pm", bad("pickup_window"))}
                        </Field>
                        <Field label="Phone" need={required("pickup_phone") && !form.pickup_phone.trim()} bad={bad("pickup_phone")}>
                          <input className={cls("pickup_phone")} aria-label="Pickup phone" placeholder="555-123-4567" value={form.pickup_phone}
                            onChange={(e) => set({ pickup_phone: e.target.value })} onBlur={onLeave("pickup_phone", tidyPhone)} />
                        </Field>
                        <Field label="Send the BOL to" need={required("bol_to") && !form.bol_to.trim()} bad={bad("bol_to")} wide>
                          <input className={cls("bol_to")} type="email" aria-label="Send the BOL to" placeholder="An email address" value={form.bol_to}
                            onChange={(e) => set({ bol_to: e.target.value })} onBlur={onLeave("bol_to", tidyEmail)} />
                        </Field>
                      </div>

                      {form.extra_pickups.map((s, i) => (
                        <div key={i} className="rounded-lg border border-line px-4 py-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[13px] font-medium text-ink">Pickup {i + 2}</div>
                            <button type="button" onClick={() => setForm((f) => ({ ...f, extra_pickups: f.extra_pickups.filter((_, j) => j !== i) }))}
                              className="text-[12px] text-muted hover:text-danger-ink px-1.5 h-6 rounded-md hover:bg-danger-bg transition-colors duration-150">Remove</button>
                          </div>
                          <FillFrom places={pickups} form={form} target={i} onPick={(p) => setForm((f) => applyPlace(f, i, p))} />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Field label="Name" wide>
                              <input className={inp} aria-label={`Pickup ${i + 2} name`} value={s.name} onChange={(e) => setStop(i, { name: e.target.value })}
                                onBlur={() => { const t = tidyName(s.name); if (t !== s.name) setStop(i, { name: t }); }} />
                            </Field>
                            <Field label="Address" need={!!s.name.trim() && !s.address.trim()} bad={bad(`stop:${i}`)} wide
                              under={addressNote(s.address) ? <div className="text-[12px] text-muted mt-1">{addressNote(s.address)}</div> : null}>
                              <textarea className={`${cls(`stop:${i}`)} h-auto py-2`} rows={2} placeholder={ADDRESS_HINT} aria-label={`Pickup ${i + 2} address`} value={s.address}
                                onChange={(e) => setStop(i, { address: e.target.value })}
                                onBlur={() => { const t = tidyAddress(s.address); if (t !== s.address) setStop(i, { address: t }); }} />
                            </Field>
                            <Field label="Pickup time">
                              {timeBox(s.window, (v) => setStop(i, { window: v }), `Pickup ${i + 2} time`, "Like 8 am to 2 pm")}
                            </Field>
                            <Field label="Phone">
                              <input className={inp} aria-label={`Pickup ${i + 2} phone`} value={s.phone} onChange={(e) => setStop(i, { phone: e.target.value })}
                                onBlur={() => { const t = tidyPhone(s.phone); if (t !== s.phone) setStop(i, { phone: t }); }} />
                            </Field>
                          </div>
                        </div>
                      ))}
                      {form.extra_pickups.length < 9 && (
                        <button type="button" onClick={addStop}
                          className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink px-2.5 h-8 rounded-lg border border-line hover:bg-surface-2 transition-colors duration-150">
                          <Plus size={13} /> Add a pickup on the same truck
                        </button>
                      )}
                    </Section>

                    <Section id="stl-delivery" title="Delivery" sub="Where the truck drops the goods." gaps={moving ? undefined : bySection("delivery")}>
                      <FillFrom places={deliveries} form={form} target="delivery" onPick={(p) => setForm((f) => applyPlace(f, "delivery", p))} />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="Name" need={required("delivery_name") && !form.delivery_name.trim()} bad={bad("delivery_name")} wide>
                          <input className={cls("delivery_name")} aria-label="Delivery name" value={form.delivery_name} onChange={(e) => set({ delivery_name: e.target.value })} onBlur={onLeave("delivery_name", tidyName)} />
                        </Field>
                        <Field label="Address" need={required("delivery_address") && !form.delivery_address.trim()} bad={bad("delivery_address")} wide
                          under={addressNote(form.delivery_address) ? <div className="text-[12px] text-muted mt-1">{addressNote(form.delivery_address)}</div> : null}>
                          <textarea className={`${cls("delivery_address")} h-auto py-2`} rows={2} placeholder={ADDRESS_HINT} aria-label="Delivery address" value={form.delivery_address}
                            onChange={(e) => set({ delivery_address: e.target.value })} onBlur={onLeave("delivery_address", tidyAddress)} />
                        </Field>
                        {!moving && (
                          <Field label="Delivery day" need={required("delivery_date") && !form.delivery_date} bad={bad("delivery_date")} wide>
                            <DayChips label="Delivery day" value={form.delivery_date} onChange={(v) => set({ delivery_date: v })} bad={bad("delivery_date")} />
                          </Field>
                        )}
                        <Field label="Delivery time">
                          {timeBox(form.delivery_window, (v) => set({ delivery_window: v }), "Delivery time", "Like ASAP or before 3 pm")}
                        </Field>
                        <Field label="Phone the driver calls" need={required("delivery_phone") && !form.delivery_phone.trim()} bad={bad("delivery_phone")}>
                          <input className={cls("delivery_phone")} aria-label="Delivery phone" placeholder="555-123-4567" value={form.delivery_phone}
                            onChange={(e) => set({ delivery_phone: e.target.value })} onBlur={onLeave("delivery_phone", tidyPhone)} />
                        </Field>
                        <Field label="For the driver" wide>
                          <input className={inp} aria-label="Delivery note" placeholder="Like: call 15 minutes out" value={form.delivery_notes}
                            onChange={(e) => set({ delivery_notes: e.target.value })} />
                        </Field>
                      </div>
                    </Section>
                  </div>

                  <Section id="stl-freight" title="Freight" sub={byTeam ? "What is on the truck. Your team fills this in, so logistics can price it." : "What is on the truck. Logistics can fill this in."}
                    gaps={moving ? undefined : bySection("freight")}>
                    {lane && <RateCard by={lane} onOpenCarrier={setCarrierId} />}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <Field label="Pallets" need={required("pallets") && !form.pallets.trim()} bad={bad("pallets")}>
                        <NumberInput integer className={cls("pallets")} value={form.pallets} placeholder="How many" onValue={(_n, raw) => set({ pallets: raw })} />
                      </Field>
                      <Field label="Weight (lbs)" need={required("weight_lbs") && !form.weight_lbs.trim()} bad={bad("weight_lbs")}>
                        <NumberInput className={cls("weight_lbs")} value={form.weight_lbs} onValue={(_n, raw) => set({ weight_lbs: raw })} />
                      </Field>
                      <Field label="Pallet size (L x W x H in)" need={required("dimensions") && !form.dimensions.trim()} bad={bad("dimensions")}>
                        <input className={cls("dimensions")} placeholder="48 x 40 x 60" aria-label="Pallet dimensions" value={form.dimensions}
                          onChange={(e) => set({ dimensions: e.target.value })} onBlur={onLeave("dimensions", tidyDims)} />
                      </Field>
                      <Field label="Pieces">
                        <NumberInput integer className={inp} value={form.pieces} onValue={(_n, raw) => set({ pieces: raw })} />
                      </Field>
                      <Field label="Equipment" need={required("equipment") && !form.equipment} bad={bad("equipment")}>
                        <EquipmentSelect value={form.equipment} onChange={(v) => set({ equipment: v })} className={bad("equipment") ? "border-warning" : undefined} />
                      </Field>
                      <Field label="Freight class">
                        <input className={inp} aria-label="Freight class" value={form.freight_class} onChange={(e) => set({ freight_class: e.target.value })} />
                      </Field>
                      <Field label="Description of goods" wide>
                        <input className={inp} aria-label="Description of goods" value={form.commodity} onChange={(e) => set({ commodity: e.target.value })} />
                      </Field>
                    </div>
                    <AccessorialsField value={form.accessorials} onChange={(v) => set({ accessorials: v })} />
                  </Section>

                  <Section id="stl-notes" title="Note and files" sub="Anything else logistics should know, and the paperwork." optional>
                    <textarea
                      className="border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[80px] focus:outline-none focus:border-ink"
                      aria-label="Note for logistics" placeholder="Like: needs to go out today, call the dock first" value={form.request_note}
                      onChange={(e) => set({ request_note: e.target.value })} />
                    {((draft?.files.length ?? 0) > 0 || files.length > 0) && (
                      <div className="rounded-lg border border-line divide-y divide-line">
                        {(draft?.files ?? []).map((f) => (
                          <div key={f.id} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] min-w-0">
                            <FileText size={13} className="text-muted flex-shrink-0" />
                            <span className="truncate min-w-0 flex-1 text-ink">{f.name}</span>
                            <span className="text-[12px] text-muted flex-shrink-0">{fileSize(f.size)}, saved</span>
                            <button type="button" onClick={() => removeDraftFile(f.id)} title="Take it off"
                              className="p-1 rounded-md text-muted hover:text-danger-ink hover:bg-danger-bg flex-shrink-0"><X size={12} /></button>
                          </div>
                        ))}
                        {files.map((f, i) => (
                          <div key={`l${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] min-w-0">
                            <FileText size={13} className="text-muted flex-shrink-0" />
                            <span className="truncate min-w-0 flex-1 text-ink">{f.name}</span>
                            <span className="text-[12px] text-muted flex-shrink-0">{fileSize(f.size)}{moving ? "" : ", not saved yet"}</span>
                            <button type="button" onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} title="Take it off"
                              className="p-1 rounded-md text-muted hover:text-danger-ink hover:bg-danger-bg flex-shrink-0"><X size={12} /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    <FileDrop onFiles={(l) => setFiles((cur) => [...cur, ...l])} hint={moving ? "Sent with the load. Each file up to 15 MB." : "Kept with the draft and sent with the load. Each file up to 15 MB."} />
                  </Section>

                  {moving && <div className="text-[12px] text-muted">Link the carrier's payment once it goes out; until then this deal's profit leaves out the shipping.</div>}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {/* Beside the screen, not inside it, so the carrier card sits over it. */}
      {carrierId && <CarrierHost id={carrierId} onClose={() => setCarrierId(null)} onChanged={() => {}} />}
    </>
  );
}

/** An extra pickup as the server takes it: every stop field, the ones this screen does not show left blank. */
const blankStopFull = () => ({ name: "", address: "", window: "", contact: "", phone: "", notes: "", dock: "", pickup_number: "", confirmed: false });
