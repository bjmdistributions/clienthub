import { ChevronRight, Download, Eye, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, PageActions } from "./ui";
import { api, type BolData, type BolItem, type BolRow, type FreightBooking, type Me } from "../lib/api";
import { localDay } from "../lib/format";
import {
  FREIGHT_TERMS, NEW_BOL_FROM_LOAD_KEY, OPEN_BOL_KEY, UNIT_TYPES, blankBol, blankBolItem, bolChanged, bolForSave, bolHasData, bolPdfPath,
  bolPrefillOf, bolProblem, bolRecordOf, bolRouteLine, bolTotals, freightTermsKey, weightWord,
} from "../lib/logisticsBols";
import { OPEN_LOAD_KEY, canEditCarriers, encodeOpenLoad } from "../lib/logisticsCarriers";
import { isLogisticsSide, loadHaystack, loadNumber } from "../lib/logisticsLoad";
import { Field, FreightStatusPill, Section, area, inp, routeLabel } from "./LogisticsBookingForm";
import { LogisticsModal as Modal, modalGhost } from "./LogisticsCarriers";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-459: the bills of lading we make. This is separate from the files a carrier sends back for a booked
// load (those live on the load, under Pay). A BOL here has its own number from the same kind of counter
// the invoices use, can be started from a load (the load's shipper, consignee, carrier and freight come
// across) or from nothing, can be attached to a load afterwards, and is downloaded as a PDF the server
// draws. The server keeps the BOLs and decides which names and addresses a viewer sees: a field it
// blanked is kept by the server when this screen saves.

const REFRESH_MS = 30_000;


/** What the editor opens with: a saved BOL, a blank one, or one built from a load. */
interface Initial {
  id: string; number: string; bookingId: string; loadNumber: string; data: BolData; canNames: boolean; canAddresses: boolean;
}

const blankInitial = (): Initial => ({ id: "", number: "", bookingId: "", loadNumber: "", data: blankBol(localDay()), canNames: true, canAddresses: true });

// ─── pick a load ──────────────────────────────────────────────────────────

/** A search over the loads by load number, place, carrier, BOL or PRO. Used to start a BOL from a load and
 *  to attach one. */
function LoadPicker({ title, sub, onPick, onClose }: { title: string; sub: string; onPick: (b: FreightBooking) => void; onClose: () => void }) {
  const [rows, setRows] = useState<FreightBooking[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    api.logistics.list({ includeDone: true }).then((r) => { if (live) setRows(r.bookings); }).catch((e) => { if (live) { setError(String(e)); setRows([]); } });
    return () => { live = false; };
  }, []);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => (rows ?? []).filter((b) => !needle || loadHaystack(b).includes(needle)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60),
    [rows, needle],
  );
  return (
    <Modal title={title} sub={sub} onClose={onClose} wide footer={<button type="button" onClick={onClose} className={modalGhost}>Cancel</button>}>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search load number, place, carrier, BOL or PRO" aria-label="Search loads"
          className={`${inp} pl-8`} />
      </div>
      {error && <div className="text-[12.5px] text-danger-ink" role="alert">{error}</div>}
      {rows === null ? <div className="text-[12.5px] text-muted">Loading...</div>
        : shown.length === 0 ? <div className="text-[12.5px] text-muted">{needle ? "No load matches that." : "No loads yet."}</div>
        : (
          <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
            {shown.map((b) => (
              <button key={b.id} type="button" onClick={() => onPick(b)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2/60 transition-colors duration-150 min-w-0">
                <span className="tabular-nums text-[12px] text-muted flex-shrink-0">{loadNumber(b)}</span>
                <span className="text-[13px] text-ink truncate min-w-0 flex-1">{routeLabel(b) || "-"}</span>
                <FreightStatusPill status={b.status} logistics={isLogisticsSide(b)} />
              </button>
            ))}
          </div>
        )}
    </Modal>
  );
}

// ─── the in-app PDF preview ───────────────────────────────────────────────

function PdfPreview({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="relative w-full max-w-[900px] h-full" onClick={(e) => e.stopPropagation()}>
        <iframe src={url} title={name} className="w-full h-full rounded-lg bg-surface" />
        <button type="button" onClick={onClose} title="Close" className="absolute top-2 right-2 p-1.5 rounded-lg bg-surface text-muted hover:text-ink border border-line"><X size={14} /></button>
      </div>
    </div>
  );
}

// ─── the editor ───────────────────────────────────────────────────────────

function PartyFields({ title, value, onChange, canNames, canAddresses, withContact = true }: {
  title: string; value: { name: string; address: string; contact?: string; phone?: string };
  onChange: (v: { name: string; address: string; contact: string; phone: string }) => void; canNames: boolean; canAddresses: boolean; withContact?: boolean;
}) {
  const set = (k: "name" | "address" | "contact" | "phone", v: string) => onChange({ name: value.name, address: value.address, contact: value.contact ?? "", phone: value.phone ?? "", [k]: v });
  return (
    <Section title={title}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" wide>
          <input className={inp} value={value.name} onChange={(e) => set("name", e.target.value)} placeholder={canNames ? "" : "Hidden by your permissions"} />
        </Field>
        <Field label="Address" wide>
          <input className={inp} value={value.address} onChange={(e) => set("address", e.target.value)} placeholder={canAddresses ? "Street, city, state ZIP" : "Hidden by your permissions"} />
        </Field>
        {withContact && (
          <>
            <Field label="Contact"><input className={inp} value={value.contact ?? ""} onChange={(e) => set("contact", e.target.value)} /></Field>
            <Field label="Phone"><input className={inp} value={value.phone ?? ""} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /></Field>
          </>
        )}
      </div>
    </Section>
  );
}

function ItemCard({ n, item, onChange, onRemove, only }: { n: number; item: BolItem; onChange: (p: Partial<BolItem>) => void; onRemove: () => void; only: boolean }) {
  return (
    <div className="rounded-lg border border-line p-3 space-y-2.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink-2">Item {n}</span>
        <button type="button" onClick={onRemove} disabled={only} title="Remove this item"
          className="ui-btn ui-btn-sm !border-transparent text-muted hover:text-danger-ink">
          <Trash2 size={14} /> Remove
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Units"><NumberInput integer className={inp} value={item.units} onValue={(_, raw) => onChange({ units: raw })} /></Field>
        <Field label="Unit type">
          <select className={inp} value={item.unit_type} onChange={(e) => onChange({ unit_type: e.target.value })} aria-label={`Item ${n} unit type`}>
            {(UNIT_TYPES as readonly string[]).includes(item.unit_type) ? null : <option value={item.unit_type}>{item.unit_type}</option>}
            {UNIT_TYPES.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </Field>
        <Field label="Pieces"><NumberInput integer className={inp} value={item.pieces} onValue={(_, raw) => onChange({ pieces: raw })} /></Field>
      </div>
      <Field label="Description">
        <input className={inp} value={item.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="What is on it" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Weight (lbs)"><NumberInput className={inp} value={item.weight_lbs} onValue={(_, raw) => onChange({ weight_lbs: raw })} /></Field>
        <Field label="Class"><input className={inp} value={item.class} onChange={(e) => onChange({ class: e.target.value })} /></Field>
        <Field label="NMFC"><input className={inp} value={item.nmfc} onChange={(e) => onChange({ nmfc: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-[12.5px] text-ink cursor-pointer">
        <input type="checkbox" checked={item.hazmat} onChange={(e) => onChange({ hazmat: e.target.checked })} className="w-4 h-4 accent-ink" />
        Hazardous material
      </label>
    </div>
  );
}

function BolEditor({ initial, readOnly, onClose, onSaved, onGone, onOpenLoad }: {
  initial: Initial; readOnly: boolean; onClose: () => void; onSaved: () => void; onGone: () => void; onOpenLoad: (bookingId: string) => void;
}) {
  const [rec, setRec] = useState({ id: initial.id, number: initial.number });
  const [base, setBase] = useState<BolData>(initial.data);
  const [draft, setDraft] = useState<BolData>(initial.data);
  const [baseBooking, setBaseBooking] = useState(initial.bookingId);
  const [bookingId, setBookingId] = useState(initial.bookingId);
  const [loadNo, setLoadNo] = useState(initial.loadNumber);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdf, setPdf] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);

  // A brand new BOL with nothing typed is not unsaved work: a start from a load is, because it was filled in for the person.
  const isNew = !rec.id;
  const dirty = bolChanged(base, draft) || bookingId !== baseBooking || (isNew && initial.bookingId !== "");
  const set = <K extends keyof BolData>(k: K, v: BolData[K]) => { setDraft((d) => ({ ...d, [k]: v })); setError(""); };
  const setItem = (i: number, p: Partial<BolItem>) => set("items", draft.items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const totals = bolTotals(draft.items);

  const tryClose = useCallback(() => {
    if (dirty && !readOnly && !confirm("You have changes that are not saved. Leave without saving them?")) return;
    onClose();
  }, [dirty, readOnly, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") tryClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tryClose]);

  /** Save, then say where it stands. Returns the saved id, or "" when it could not be saved. */
  const save = async (): Promise<string> => {
    const problem = bolProblem(draft);
    if (problem) { setError(problem); return ""; }
    setSaving(true); setError("");
    try {
      const body = bolForSave(draft);
      const resp = rec.id ? await api.logistics.bols.update(rec.id, bookingId, body) : await api.logistics.bols.create(bookingId, body);
      const r = bolRecordOf(resp);
      const id = r.id || rec.id;
      // An answer with no data must not blank what was typed: keep our own copy.
      const kept = bolHasData(resp) ? r.data : body;
      setRec({ id, number: r.number || rec.number });
      setBase(kept); setDraft(kept);
      setBaseBooking(bookingId);
      if (r.loadNumber) setLoadNo(r.loadNumber);
      toast(rec.id ? "Saved" : `Saved as ${r.number || "a new BOL"}`);
      onSaved();
      return id;
    } catch (e) { setError(String(e)); return ""; }
    finally { setSaving(false); }
  };

  const attach = (b: FreightBooking) => {
    setPicking(false);
    setBookingId(b.id);
    setLoadNo(loadNumber(b));
    // The load's number goes on the BOL's references when nobody has typed one.
    if (!draft.refs.load_number.trim()) set("refs", { ...draft.refs, load_number: loadNumber(b) });
  };
  const detach = () => { setBookingId(""); setLoadNo(""); };

  /** The PDF shows what is saved, so a changed BOL is saved first. */
  const withSaved = async (then: (id: string) => Promise<void>) => {
    let id = rec.id;
    if (!id || dirty) { id = await save(); if (!id) return; }
    setBusy(true);
    try { await then(id); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const download = () => withSaved(async (id) => {
    const where = await api.logistics.saveDownload(bolPdfPath(id));
    if (where) toast("PDF saved");
  });
  const preview = () => withSaved(async (id) => {
    const got = await api.logistics.bols.pdf(id);
    const bin = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
    setPdf((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { url: URL.createObjectURL(new Blob([bin], { type: got.mime || "application/pdf" })), name: got.name }; });
  });

  const archive = async () => {
    if (!rec.id) return;
    if (!confirm(`Remove ${rec.number || "this BOL"}? It leaves the list. Its number is not reused.`)) return;
    try { await api.logistics.bols.archive(rec.id); toast("Removed"); onGone(); }
    catch (e) { setError(String(e)); }
  };

  const route = bolRouteLine({ shipper: draft.shipper.name, consignee: draft.consignee.name });

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40 animate-fade-in" onClick={tryClose} />
      <div role="dialog" aria-modal="true" aria-label={rec.number ? `BOL ${rec.number}` : "New BOL"}
        className="fixed inset-y-0 right-0 w-[680px] max-w-[96vw] bg-surface shadow-[0_0_50px_rgba(0,0,0,0.12)] z-50 flex flex-col animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-6 pt-4 pb-3 flex-shrink-0 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[20px] font-medium text-ink tabular-nums tracking-tight">{rec.number || "New BOL"}</h3>
              <div className="text-[13px] text-ink-2 truncate mt-0.5">{route || (rec.number ? "" : "The number is assigned when you save.")}</div>
            </div>
            <button type="button" onClick={tryClose} title="Close" aria-label="Close" className="ui-ib flex-shrink-0"><X size={16} /></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {bookingId
              ? (
                <button type="button" onClick={() => onOpenLoad(bookingId)} title="Open the load"
                  className="ui-btn ui-btn-sm">
                  Load <span className="tabular-nums">{loadNo || "attached"}</span><ChevronRight size={12} />
                </button>
              )
              : <StatusPill tone="neutral">Not attached to a load</StatusPill>}
            {!readOnly && (
              <>
                <button type="button" onClick={() => setPicking(true)} className="ui-btn ui-btn-sm !border-transparent text-muted">
                  {bookingId ? "Change load" : "Attach to a load"}
                </button>
                {bookingId && <button type="button" onClick={detach} className="ui-btn ui-btn-sm !border-transparent text-muted hover:text-danger-ink">Detach</button>}
              </>
            )}
          </div>
        </div>

        <fieldset disabled={readOnly} className="flex-1 min-h-0 min-w-0 m-0 p-0 border-0 overflow-y-auto">
          <div className="px-6 py-5 space-y-6">
            <Section title="Shipment">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ship date"><input type="date" className={inp} value={draft.ship_date} onChange={(e) => set("ship_date", e.target.value)} /></Field>
                <Field label="Freight terms">
                  <select className={inp} value={draft.freight_terms} onChange={(e) => set("freight_terms", freightTermsKey(e.target.value))} aria-label="Freight terms">
                    {FREIGHT_TERMS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            <PartyFields title="Shipper" value={draft.shipper} onChange={(v) => set("shipper", v)} canNames={initial.canNames} canAddresses={initial.canAddresses} />
            <PartyFields title="Consignee" value={draft.consignee} onChange={(v) => set("consignee", v)} canNames={initial.canNames} canAddresses={initial.canAddresses} />
            <PartyFields title="Bill to" value={draft.bill_to} withContact={false}
              onChange={(v) => set("bill_to", { name: v.name, address: v.address })} canNames={initial.canNames} canAddresses={initial.canAddresses} />

            <Section title="Carrier">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Carrier name" wide><input className={inp} value={draft.carrier.name} onChange={(e) => set("carrier", { ...draft.carrier, name: e.target.value })} /></Field>
                <Field label="SCAC"><input className={inp} value={draft.carrier.scac} onChange={(e) => set("carrier", { ...draft.carrier, scac: e.target.value })} /></Field>
                <Field label="PRO number"><input className={inp} value={draft.carrier.pro} onChange={(e) => set("carrier", { ...draft.carrier, pro: e.target.value })} /></Field>
                <Field label="Trailer"><input className={inp} value={draft.carrier.trailer} onChange={(e) => set("carrier", { ...draft.carrier, trailer: e.target.value })} /></Field>
                <Field label="Seal"><input className={inp} value={draft.carrier.seal} onChange={(e) => set("carrier", { ...draft.carrier, seal: e.target.value })} /></Field>
              </div>
            </Section>

            <Section title="References">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Load number"><input className={inp} value={draft.refs.load_number} onChange={(e) => set("refs", { ...draft.refs, load_number: e.target.value })} /></Field>
                <Field label="Pickup number"><input className={inp} value={draft.refs.pickup_number} onChange={(e) => set("refs", { ...draft.refs, pickup_number: e.target.value })} /></Field>
                <Field label="PO number"><input className={inp} value={draft.refs.po} onChange={(e) => set("refs", { ...draft.refs, po: e.target.value })} /></Field>
                <Field label="Customer reference"><input className={inp} value={draft.refs.customer_ref} onChange={(e) => set("refs", { ...draft.refs, customer_ref: e.target.value })} /></Field>
              </div>
            </Section>

            <Section title="Items">
              <div className="space-y-3">
                {draft.items.map((it, i) => (
                  <ItemCard key={i} n={i + 1} item={it} only={draft.items.length === 1}
                    onChange={(p) => setItem(i, p)} onRemove={() => set("items", draft.items.filter((_, j) => j !== i))} />
                ))}
                {!readOnly && (
                  <button type="button" onClick={() => set("items", [...draft.items, blankBolItem()])}
                    className="ui-btn ui-btn-sm">
                    <Plus size={13} /> Add an item
                  </button>
                )}
                <div className="flex items-center gap-4 flex-wrap text-[12.5px] text-ink-2 pt-1" aria-label="Totals">
                  <span>Units <span className="text-ink font-medium tabular-nums">{totals.units || "-"}</span></span>
                  <span>Pieces <span className="text-ink font-medium tabular-nums">{totals.pieces || "-"}</span></span>
                  <span>Weight <span className="text-ink font-medium tabular-nums">{weightWord(totals.weight)}</span></span>
                </div>
              </div>
            </Section>

            <Section title="Notes and values">
              <div className="space-y-3">
                <Field label="Special instructions">
                  <textarea className={area} rows={3} value={draft.special_instructions} onChange={(e) => set("special_instructions", e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="COD amount" hint="Leave empty when it is not collect on delivery.">
                    <NumberInput className={inp} value={draft.cod_amount} onValue={(_, raw) => set("cod_amount", raw)} />
                  </Field>
                  <Field label="Declared value">
                    <NumberInput className={inp} value={draft.declared_value} onValue={(_, raw) => set("declared_value", raw)} />
                  </Field>
                </div>
              </div>
            </Section>
          </div>
        </fieldset>

        <div className="border-t border-line px-6 py-3 flex-shrink-0 space-y-2">
          {error && <div className="text-[12.5px] text-danger-ink" role="alert">{error}</div>}
          <div className="flex items-center gap-2 flex-wrap">
            {!isNew && !readOnly && (
              <button type="button" onClick={archive}
                className="ui-btn !border-transparent text-muted hover:text-danger-ink">
                <Trash2 size={12} /> Remove
              </button>
            )}
            <button type="button" onClick={preview} disabled={busy || saving || (isNew && !dirty)}
              className="ui-btn">
              <Eye size={13} /> Preview
            </button>
            <button type="button" onClick={download} disabled={busy || saving || (isNew && !dirty)}
              className="ui-btn">
              <Download size={13} /> Download PDF
            </button>
            {!readOnly && (
              <button type="button" onClick={() => { void save(); }} disabled={(!dirty && !isNew) || saving}
                className="ui-btn ui-btn-ink">
                {saving ? "Saving..." : isNew ? "Save BOL" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
      {picking && <LoadPicker title="Attach to a load" sub="Pick the load this BOL is for." onPick={attach} onClose={() => setPicking(false)} />}
      {pdf && <PdfPreview url={pdf.url} name={pdf.name} onClose={() => setPdf(null)} />}
    </>
  );
}

// ─── the screen ───────────────────────────────────────────────────────────

export default function BolsView({ me }: { me: Me | null | undefined }) {
  const canWrite = canEditCarriers(me);
  const [rows, setRows] = useState<BolRow[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [editor, setEditor] = useState<{ key: number; initial: Initial } | null>(null);
  const [picking, setPicking] = useState(false);
  const seq = useRef(0);
  const reqId = useRef(0);

  const load = useCallback(async (text: string) => {
    const mine = ++reqId.current;
    try {
      const r = await api.logistics.bols.list(text.trim());
      if (mine !== reqId.current) return;
      setRows(r.bols); setError("");
    } catch (e) {
      if (mine !== reqId.current) return;
      setError(String(e)); setRows((prev) => prev ?? []);
    }
  }, []);
  // The search asks the server (it matches number, load number, names and carrier), a beat after the last key.
  useEffect(() => {
    const t = window.setTimeout(() => load(q), q ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [q, load]);
  useEffect(() => {
    // BOLs are not synced: another person's changes arrive when this asks again.
    const id = window.setInterval(() => load(q), REFRESH_MS);
    const onFocus = () => load(q);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [load, q]);

  const open = useCallback((initial: Initial) => setEditor({ key: ++seq.current, initial }), []);

  const openBol = useCallback(async (id: string) => {
    try {
      const r = bolRecordOf(await api.logistics.bols.get(id));
      open({ id: r.id || id, number: r.number, bookingId: r.bookingId, loadNumber: r.loadNumber, data: r.data, canNames: r.canNames, canAddresses: r.canAddresses });
    } catch (e) { toast(String(e), "error"); }
  }, [open]);

  const fromLoad = useCallback(async (bookingId: string) => {
    try {
      const p = bolPrefillOf(await api.logistics.bols.prefill(bookingId), bookingId);
      open({ id: "", number: "", bookingId: p.bookingId, loadNumber: p.loadNumber, data: p.data, canNames: true, canAddresses: true });
    } catch (e) { toast(String(e), "error"); }
  }, [open]);

  // Another screen stashed a BOL to open, or a load to start one from, then switched here.
  const takeHandoff = useCallback(() => {
    try {
      const id = localStorage.getItem(OPEN_BOL_KEY);
      if (id) { localStorage.removeItem(OPEN_BOL_KEY); if (id.trim()) openBol(id.trim()); }
      const from = localStorage.getItem(NEW_BOL_FROM_LOAD_KEY);
      if (from) { localStorage.removeItem(NEW_BOL_FROM_LOAD_KEY); if (from.trim()) fromLoad(from.trim()); }
    } catch { /* storage can be blocked: nothing to open */ }
  }, [openBol, fromLoad]);
  useEffect(() => {
    takeHandoff();
    window.addEventListener("bols-open", takeHandoff);
    return () => window.removeEventListener("bols-open", takeHandoff);
  }, [takeHandoff]);

  /** The load a BOL is attached to, on the Logistics screen. */
  const openLoad = (bookingId: string) => {
    try { localStorage.setItem(OPEN_LOAD_KEY, encodeOpenLoad(bookingId)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "logistics" }));
  };

  if (rows === null) {
    return (
      <div className="space-y-5" aria-busy="true">
        <div className="h-5 w-28 bg-surface-2 rounded-md animate-pulse" />
        <div className="h-8 w-full max-w-sm bg-surface-2 rounded-lg animate-pulse" />
        <div className="h-[180px] bg-surface-2 rounded-lg animate-pulse" />
      </div>
    );
  }

  const empty: ReactNode = (
    <div className="px-6 py-12 text-center">
      <div className="text-[14px] font-medium text-ink">{q.trim() ? "Nothing matches that search" : "No BOLs yet"}</div>
      <div className="text-[12.5px] text-muted mt-1">
        {q.trim() ? "Try a BOL number, a load number, a name or a carrier." : canWrite ? "Make one blank, or start from a load and its details come across." : "BOLs made by your team show up here."}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 min-w-0">
      <PageActions>
        <label className="ui-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search BOL number, load, name or carrier" aria-label="Search BOLs" style={{ width: 280 }} />
        </label>
        {canWrite && (
          <>
            <Button onClick={() => setPicking(true)}>From a load</Button>
            <Button variant="ink" onClick={() => open(blankInitial())} icon={<Plus size={14} />}>New BOL</Button>
          </>
        )}
      </PageActions>

      <div className="min-w-0 ml-1">
        <div className="text-[16px] font-medium text-ink">BOLs</div>
        <p className="text-[13px] text-muted mt-0.5">Bills of lading we make. The signed BOL a carrier sends back is filed on the load, under Pay.</p>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-3 px-4 py-3 text-[12.5px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => load(q)} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}

      {rows.length === 0 && !error ? empty : rows.length > 0 && (
        <section className="border-t border-line animate-fade-in">
          {rows.map((r) => {
            const ends = bolRouteLine(r);
            return (
              <button key={r.id} type="button" onClick={() => openBol(r.id)}
                className="w-full text-left flex items-center gap-3 px-3 py-3 border-b border-line hover:bg-surface-2 transition-colors duration-150 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="tabular-nums text-[12px] text-muted flex-shrink-0">{r.number}</span>
                    <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{ends || "-"}</span>
                  </div>
                  <div className="text-[12px] text-muted mt-0.5 truncate">
                    {[r.ship_date, r.carrier].filter(Boolean).join(" · ") || "No date or carrier yet"}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {r.load_number ? <StatusPill tone="neutral">{`Load ${r.load_number}`}</StatusPill> : null}
                </div>
                <ChevronRight size={16} className="text-muted flex-shrink-0" />
              </button>
            );
          })}
        </section>
      )}

      {picking && (
        <LoadPicker title="Start from a load" sub="The load's shipper, consignee, carrier and freight come across. You can change all of it."
          onPick={(b) => { setPicking(false); fromLoad(b.id); }} onClose={() => setPicking(false)} />
      )}
      {editor && (
        <BolEditor key={editor.key} initial={editor.initial} readOnly={!canWrite}
          onClose={() => setEditor(null)} onSaved={() => load(q)} onGone={() => { setEditor(null); load(q); }} onOpenLoad={openLoad} />
      )}
    </div>
  );
}
