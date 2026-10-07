import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Search, Truck, X } from "lucide-react";
import { api, type CarrierPayMethod, type FreightCarrier, type FreightCarrierDetail, type FreightCarrierInput } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  PAY_METHODS, canEditCarriers, canSeePayDetails, carrierByName, carrierIds, filterCarriers, offerSaveCarrier, payMethodLabel, termsWord,
} from "../lib/logisticsCarriers";
import { fmtDayLabel } from "../lib/logisticsLoad";
import { useSessionMe } from "../lib/useSessionMe";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-459: the carriers directory. A carrier is saved once with how to reach it and how it gets paid
// (Zelle, wire, ACH, credit card, check), and a load picks it from the list. The server keeps the
// directory and seals the payment details; this screen only prints what it is given and writes what
// a person types. It lives under Logistics beside Bookings and is also opened from a load (the
// carrier picker, the rate popup, the Pay step).

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";
const area =
  "border border-line px-3 py-2 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted resize-y min-h-[64px] " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const REFRESH_MS = 30_000;

/** The whole directory, read once and again on demand. `list` is null until the first answer, so a screen can
 *  tell "not loaded" from "empty". */
export function useCarriers() {
  const [list, setList] = useState<FreightCarrier[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try { setList((await api.logistics.carriers.list()).carriers); setError(""); }
    catch (e) { setError(String(e)); setList((prev) => prev ?? []); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { list, error, reload };
}

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <label className="block text-[12px] font-medium text-muted mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

// The open sheets, oldest first: Escape closes only the top one, and never reaches the drawer under them.
const openModals: symbol[] = [];

function Modal({ title, sub, onClose, children, footer, wide }: { title: string; sub?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = Symbol("modal");
    openModals.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (openModals[openModals.length - 1] === me) close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); openModals.splice(openModals.indexOf(me), 1); };
  }, []);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`bg-surface border border-line rounded-2xl shadow-2xl w-full ${wide ? "max-w-xl" : "max-w-md"} max-h-[88vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink truncate">{title}</h2>
            {sub && <p className="text-[12px] text-muted mt-0.5">{sub}</p>}
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-4">{children}</div>
        {footer && <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-line">{footer}</div>}
      </div>
    </div>
  );
}

export const modalPrimary = "bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap";
export const modalGhost = "px-4 h-9 rounded-lg text-[13px] text-ink-2 hover:bg-surface-2 whitespace-nowrap";
export { Modal as LogisticsModal };

// ─── add or change a carrier ──────────────────────────────────────────────

/** `carrier` is set to change one, `seedName` starts a new one from a name typed on a load. */
export function CarrierForm({ carrier, seedName, canDetails, onClose, onSaved }: {
  carrier?: FreightCarrierDetail; seedName?: string; canDetails: boolean; onClose: () => void; onSaved: (c: FreightCarrierDetail) => void;
}) {
  const [f, setF] = useState(() => ({
    name: carrier?.name ?? seedName ?? "", mc_number: carrier?.mc_number ?? "", dot_number: carrier?.dot_number ?? "",
    contact_name: carrier?.contact_name ?? "", phone: carrier?.phone ?? "", email: carrier?.email ?? "", address: carrier?.address ?? "",
    pay_method: (carrier?.pay_method ?? "") as CarrierPayMethod, pay_details: carrier?.pay_details ?? "",
    terms: carrier?.pay_terms_days == null ? "" : String(carrier.pay_terms_days), notes: carrier?.notes ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const text = (k: "name" | "mc_number" | "dot_number" | "contact_name" | "phone" | "email" | "address", label: string, opts?: { wide?: boolean; placeholder?: string }) => (
    <Field label={label} wide={opts?.wide}>
      <input className={inp} value={f[k]} placeholder={opts?.placeholder} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );

  const save = async () => {
    if (!f.name.trim()) { setErr("Add the carrier's name."); return; }
    const body: FreightCarrierInput = {
      name: f.name.trim(), mc_number: f.mc_number.trim(), dot_number: f.dot_number.trim(), contact_name: f.contact_name.trim(),
      phone: f.phone.trim(), email: f.email.trim(), address: f.address.trim(), pay_method: f.pay_method,
      pay_terms_days: f.terms.trim() === "" ? null : Math.max(0, Math.round(Number(f.terms) || 0)), notes: f.notes.trim(),
      // Only someone who may see the details writes them: a blank that only means hidden is never sent back.
      ...(canDetails ? { pay_details: f.pay_details.trim() } : {}),
    };
    setBusy(true); setErr("");
    try {
      const saved = carrier ? await api.logistics.carriers.update(carrier.id, body) : await api.logistics.carriers.create(body);
      toast(carrier ? "Carrier saved" : "Carrier added");
      onSaved(saved);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <Modal title={carrier ? `Edit ${carrier.name}` : "Add a carrier"} onClose={onClose} wide
      footer={<>
        <button onClick={onClose} className={modalGhost}>Cancel</button>
        <button onClick={save} disabled={busy} className={modalPrimary}>{busy ? "Saving..." : "Save"}</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        {text("name", "Name", { wide: true })}
        {text("mc_number", "MC number")}
        {text("dot_number", "DOT number")}
        {text("contact_name", "Contact")}
        {text("phone", "Phone")}
        {text("email", "Email", { wide: true })}
        {text("address", "Address", { wide: true })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="How the carrier gets paid">
          <select className={inp} value={f.pay_method} onChange={(e) => set({ pay_method: e.target.value as CarrierPayMethod })}>
            <option value="">Not set</option>
            {PAY_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Pays within (days)" hint="Sets the pay due date when a load is delivered.">
          <NumberInput integer className={inp} value={f.terms} placeholder="30" onValue={(_n, raw) => set({ terms: raw })} />
        </Field>
        {canDetails && (
          <Field label="Payment details" wide hint="Zelle email or phone, wire or ACH numbers, or how to charge the card. Stored sealed.">
            <textarea className={area} value={f.pay_details} onChange={(e) => set({ pay_details: e.target.value })} />
          </Field>
        )}
        <Field label="Notes" wide>
          <textarea className={area} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
    </Modal>
  );
}

// ─── the carrier card ─────────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className="text-[13px] text-ink break-words">{children}</dd>
    </div>
  );
}

/** One carrier: how to reach it, how it gets paid, and the last loads it carried. `onOpenLoad` makes the
 *  load numbers in its history open that load. */
export function CarrierCard({ carrier, onClose, onChanged, onOpenLoad, startEditing }: {
  carrier: FreightCarrierDetail; onClose: () => void; onChanged: () => void; onOpenLoad?: (bookingId: string) => void; startEditing?: boolean;
}) {
  const me = useSessionMe();
  const canEdit = canEditCarriers(me), canDetails = canSeePayDetails(me);
  const [c, setC] = useState(carrier);
  const [editing, setEditing] = useState(!!startEditing);
  const archive = async () => {
    if (!confirm(`Archive ${c.name}? Loads that used it keep the name. It leaves the carrier list.`)) return;
    try { await api.logistics.carriers.archive(c.id); toast("Carrier archived"); onChanged(); onClose(); }
    catch (e) { toast(String(e), "error"); }
  };

  if (editing) {
    return <CarrierForm carrier={c} canDetails={canDetails} onClose={() => (startEditing ? onClose() : setEditing(false))}
      onSaved={(s) => { setC(s); setEditing(false); onChanged(); if (startEditing) onClose(); }} />;
  }
  const ids = carrierIds(c);
  return (
    <Modal title={c.name} sub={ids || undefined} onClose={onClose} wide
      footer={<>
        {canEdit && <button onClick={archive} className="mr-auto px-3 h-9 rounded-lg text-[13px] text-faint hover:text-danger-ink hover:bg-danger-bg whitespace-nowrap">Archive</button>}
        {canEdit && <button onClick={() => setEditing(true)} className={modalGhost}>Edit carrier</button>}
        <button onClick={onClose} className={modalPrimary}>Close</button>
      </>}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="Contact">{c.contact_name || "-"}</Fact>
        <Fact label="Phone">{c.phone || "-"}</Fact>
        <Fact label="Email">{c.email || "-"}</Fact>
        <Fact label="Address">{c.address || "-"}</Fact>
        <Fact label="How they get paid">
          <span className="flex items-center gap-2 flex-wrap">
            {c.pay_method ? <StatusPill tone="accent">{payMethodLabel(c.pay_method)}</StatusPill> : "-"}
            {termsWord(c.pay_terms_days) && <span className="text-ink-2">{termsWord(c.pay_terms_days)}</span>}
          </span>
        </Fact>
        <Fact label="Payment details">
          {canDetails
            ? <span className="whitespace-pre-wrap">{c.pay_details || "-"}</span>
            : <span className="text-muted">Hidden by your permissions</span>}
        </Fact>
        {c.notes.trim() && <div className="col-span-2"><Fact label="Notes"><span className="whitespace-pre-wrap">{c.notes}</span></Fact></div>}
      </dl>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-ink">Last loads</h3>
        {c.history.length === 0 ? (
          <p className="text-[12.5px] text-muted">No loads with this carrier yet.</p>
        ) : (
          <div className="rounded-lg border border-line divide-y divide-line">
            {c.history.map((h) => (
              <div key={h.booking_id} className="flex items-center gap-3 px-3 py-2 text-[12.5px] min-w-0">
                {onOpenLoad
                  ? <button type="button" onClick={() => onOpenLoad(h.booking_id)} className="font-mono text-accent hover:underline flex-shrink-0">{h.load_number}</button>
                  : <span className="font-mono text-ink-2 flex-shrink-0">{h.load_number}</span>}
                <span className="text-muted flex-shrink-0">{fmtDayLabel(h.day)}</span>
                <span className="text-ink-2 truncate min-w-0 flex-1">{h.lane || ""}</span>
                {h.rate != null && <span className="tabular-nums text-ink flex-shrink-0">{fmtAmount(h.rate)}</span>}
                <StatusPill tone={h.paid ? "success" : "neutral"}>{h.paid ? "Paid" : "Not paid"}</StatusPill>
              </div>
            ))}
          </div>
        )}
      </section>
    </Modal>
  );
}

/** Opens a carrier by id (read from the server first), or the add form when there is no id. */
export function CarrierHost({ id, edit, seedName, onClose, onChanged, onSaved, onOpenLoad }: {
  id?: string; edit?: boolean; seedName?: string; onClose: () => void; onChanged: () => void;
  /** After an add or a change, with the saved carrier (the load page picks it). */
  onSaved?: (c: FreightCarrierDetail) => void; onOpenLoad?: (bookingId: string) => void;
}) {
  const me = useSessionMe();
  const [c, setC] = useState<FreightCarrierDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!id) return;
    let dead = false;
    api.logistics.carriers.get(id).then((x) => { if (!dead) setC(x); }).catch((e) => { if (!dead) setErr(String(e)); });
    return () => { dead = true; };
  }, [id]);
  if (!id) {
    return <CarrierForm seedName={seedName} canDetails={canSeePayDetails(me)} onClose={onClose}
      onSaved={(s) => { onChanged(); onSaved?.(s); onClose(); }} />;
  }
  if (err) {
    return <Modal title="Carrier" onClose={onClose} footer={<button onClick={onClose} className={modalPrimary}>Close</button>}><p className="text-[12.5px] text-danger-ink" role="alert">{err}</p></Modal>;
  }
  if (!c) return null;
  return <CarrierCard carrier={c} startEditing={edit} onClose={onClose} onOpenLoad={onOpenLoad}
    onChanged={() => { onChanged(); api.logistics.carriers.get(c.id).then((x) => onSaved?.(x)).catch(() => {}); }} />;
}

// ─── the picker on a load ─────────────────────────────────────────────────

/** A text box that lists the saved carriers as you type. Picking one sets the load's carrier and its id; a name that
 *  is not saved offers "Save to carriers". `onType` is every keystroke, so the load keeps whatever is typed. */
export function CarrierPicker({ value, carrierId, carriers, onType, onPick, onSave, onOpen, canEdit }: {
  value: string; carrierId: string; carriers: FreightCarrier[] | null;
  onType: (name: string) => void; onPick: (c: FreightCarrier) => void; onSave: (name: string) => void; onOpen: (id: string) => void; canEdit: boolean;
}) {
  const [focus, setFocus] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const list = useMemo(() => carriers ?? [], [carriers]);
  const shown = useMemo(() => filterCarriers(list, value), [list, value]);
  const saved = (carrierId && list.find((c) => c.id === carrierId)) || carrierByName(value, list);
  const offer = canEdit && offerSaveCarrier(value, carriers) && !carrierId;
  return (
    <div ref={box} className="relative min-w-0">
      <input className={inp} value={value} role="combobox" aria-expanded={focus && shown.length > 0} aria-autocomplete="list" aria-label="Carrier"
        onChange={(e) => onType(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} placeholder="Type a name or pick a saved carrier" />
      {focus && shown.length > 0 && (
        <ul role="listbox" className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg py-1">
          {shown.map((c) => (
            <li key={c.id} role="option" aria-selected={c.id === carrierId}>
              {/* mousedown, not click: the box blurs first and would close the list before a click lands. */}
              <button type="button" onMouseDown={(e) => { e.preventDefault(); onPick(c); setFocus(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-surface-2 flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] text-ink truncate min-w-0">{c.name}</span>
                <span className="text-[11.5px] text-muted flex-shrink-0">{[carrierIds(c), payMethodLabel(c.pay_method)].filter(Boolean).join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[11.5px] text-muted">
        {saved && (
          <>
            <span>Saved carrier{saved.pay_method ? `, paid by ${payMethodLabel(saved.pay_method)}` : ""}.</span>
            <button type="button" onClick={() => onOpen(saved.id)} className="text-accent font-medium hover:underline">View carrier</button>
          </>
        )}
        {offer && (
          <button type="button" onClick={() => onSave(value.trim())} className="text-accent font-medium hover:underline">Save to carriers</button>
        )}
      </div>
    </div>
  );
}

// ─── the Carriers view ────────────────────────────────────────────────────

export function CarriersView({ openId, onOpenLoad, onHostClose }: { openId?: string; onOpenLoad: (bookingId: string) => void; onHostClose?: () => void }) {
  const me = useSessionMe();
  const canEdit = canEditCarriers(me);
  const { list, error, reload } = useCarriers();
  const [q, setQ] = useState("");
  const [host, setHost] = useState<{ id?: string } | null>(openId ? { id: openId } : null);
  useEffect(() => { if (openId) setHost({ id: openId }); }, [openId]);
  useEffect(() => {
    const id = window.setInterval(reload, REFRESH_MS);
    window.addEventListener("focus", reload);
    return () => { window.clearInterval(id); window.removeEventListener("focus", reload); };
  }, [reload]);

  const rows = useMemo(() => filterCarriers(list ?? [], q, 500), [list, q]);
  if (list === null) {
    return <div className="space-y-3" aria-busy="true"><div className="h-9 w-full max-w-sm bg-surface-2 rounded-lg animate-pulse" /><div className="h-[160px] bg-surface-2 rounded-xl animate-pulse" /></div>;
  }
  return (
    <div className="space-y-4 min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="relative w-full max-w-[320px] min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, MC or DOT" aria-label="Search carriers"
            className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
        </div>
        {canEdit && (
          <button type="button" onClick={() => setHost({})}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3.5 h-9 rounded-lg text-[13px] font-medium whitespace-nowrap">
            <Plus size={14} /> Add a carrier
          </button>
        )}
      </div>
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={reload} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}
      {rows.length === 0 && !error ? (
        <div className="bg-surface border border-line rounded-xl px-6 py-12 text-center">
          <Truck size={22} className="mx-auto text-faint mb-2" />
          <div className="text-[14px] font-medium text-ink">{q.trim() ? "No carrier matches that" : "No carriers saved yet"}</div>
          <div className="text-[12.5px] text-muted mt-1">
            {q.trim() ? "Try a name, an MC number or a DOT number." : canEdit ? "Add the carriers you book so each load can pick one and how they get paid is on file." : "Carriers your team saves show up here."}
          </div>
        </div>
      ) : rows.length > 0 && (
        <section className="bg-surface border border-line rounded-xl overflow-hidden divide-y divide-line">
          {rows.map((c) => (
            <button key={c.id} type="button" onClick={() => setHost({ id: c.id })}
              className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60 transition-colors min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink truncate">{c.name}</div>
                <div className="text-[12px] text-muted mt-0.5 truncate">
                  {[carrierIds(c), c.contact_name, c.phone].filter(Boolean).join(" · ") || "No contact saved"}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {c.pay_method && <StatusPill tone="accent">{payMethodLabel(c.pay_method)}</StatusPill>}
                <span className="text-[12px] text-muted whitespace-nowrap">{c.load_count} {c.load_count === 1 ? "load" : "loads"}</span>
                {c.last_used && <span className="text-[12px] text-muted whitespace-nowrap hidden lg:inline">last {fmtDayLabel(c.last_used)}</span>}
                {c.last_rate != null && <span className="text-[12.5px] text-ink tabular-nums whitespace-nowrap">{fmtAmount(c.last_rate)}</span>}
              </div>
            </button>
          ))}
        </section>
      )}
      {host && <CarrierHost id={host.id} onClose={() => { setHost(null); onHostClose?.(); }} onChanged={reload} onOpenLoad={(id) => { setHost(null); onHostClose?.(); onOpenLoad(id); }} />}
    </div>
  );
}
