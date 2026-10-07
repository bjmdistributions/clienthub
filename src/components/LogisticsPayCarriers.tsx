import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronRight, FileText, Landmark } from "lucide-react";
import { api, type CarrierPayRow } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import {
  OPEN_LOAD_KEY, PAY_METHODS, UNDO_PAID_PATCH, bankLinkNote, carrierPayCandidates, changePaidDefaults, encodeOpenLoad, markPaidDefaults, markPaidPatch, payDue, payMethodLabel,
  toPaySummary, type BankCandidate, type MarkPaidForm,
} from "../lib/logisticsCarriers";
import { BANK_LINK_WORD, fmtDayLabel, paymentLine, type LoadStep } from "../lib/logisticsLoad";
import { useNetsyncApplied } from "../lib/useNetsyncApplied";
import { LogisticsModal, modalGhost, modalPrimary } from "./LogisticsCarriers";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-459: paying the carriers, from the admin side. Logistics books the truck and files the paperwork; the
// team marks a carrier paid here (the amount, the day, how, a reference), sees who has been paid, and ties
// each payment to the bank transaction that moved the money, so every deal is tracked to the last dollar.
// The same record and undo pattern as the logistics pay tracker, and the same rows feed the Bills screen's
// "Carriers to pay" section. Only someone who may pay opens any of this; the server checks it too.

const REFRESH_MS = 30_000;
const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";

/** Open a load on a step from another screen: stash it, switch to Logistics, and tell a Logistics screen that
 *  is already open (the same stash-then-switch handoff `invoices_open_id` uses). */
export function openLoadInLogistics(bookingId: string, step?: LoadStep) {
  try { localStorage.setItem(OPEN_LOAD_KEY, encodeOpenLoad(bookingId, step)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "logistics" }));
  window.dispatchEvent(new CustomEvent("logistics-open-load"));
}

export function BankLinkPill({ state }: { state: string }) {
  if (!state) return null;
  return <StatusPill tone={state === "linked" ? "success" : state === "partial" ? "warning" : "neutral"}>{BANK_LINK_WORD[state] ?? state}</StatusPill>;
}

/** The rows, read now and again on a timer, on focus and when a sync lands. Nothing is asked unless `enabled`. */
export function useCarrierPay(enabled: boolean) {
  const [data, setData] = useState<{ to_pay: CarrierPayRow[]; paid: CarrierPayRow[] } | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!enabled) return;
    try { setData(await api.logistics.carrierPay.list(60)); setError(""); }
    catch (e) { setError(String(e)); setData((d) => d ?? { to_pay: [], paid: [] }); }
  }, [enabled]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(reload, REFRESH_MS);
    window.addEventListener("focus", reload);
    return () => { window.clearInterval(id); window.removeEventListener("focus", reload); };
  }, [enabled, reload]);
  useNetsyncApplied(reload);
  return { data, error, reload };
}

// ─── Mark paid ────────────────────────────────────────────────────────────

export interface PayTarget {
  bookingId: string; label: string; rate: number | null; payMethod: string; paidAmount?: number | null;
  /** R-463: a payment already on record. With it the sheet is Change: it opens with what is on record. */
  current?: { paid_amount: number | null; paid_at: string; paid_method: string; paid_note: string };
  /** R-463: whether the bank payments linked to the deal cover this one, so Change can say so. */
  bankLinked?: string;
}

/** Records the payment: the amount (the carrier rate to start), the day, how it was paid and a reference.
 *  R-463: with a payment on record (`target.current`) it is Change, so a wrong figure is fixed in one step. */
export function MarkPaidSheet({ target, onClose, onDone }: { target: PayTarget; onClose: () => void; onDone: () => void }) {
  const change = !!target.current;
  const [f, setF] = useState<MarkPaidForm>(() => target.current
    ? changePaidDefaults(target.current, localDay())
    : markPaidDefaults({ rate: target.rate, pay_method: target.payMethod }, localDay()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (patch: Partial<MarkPaidForm>) => setF((x) => ({ ...x, ...patch }));
  const go = async () => {
    const r = markPaidPatch(f);
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr("");
    try { await api.logistics.update(target.bookingId, r.patch); toast(change ? "Payment changed" : "Marked paid"); onDone(); }
    catch (e) { setErr(String(e)); setBusy(false); }
  };
  const methods = PAY_METHODS.map((m) => m.label);
  return (
    <LogisticsModal title={change ? "Change payment" : "Mark paid"} sub={target.label} onClose={onClose}
      footer={<>
        <button onClick={onClose} className={modalGhost}>Cancel</button>
        <button onClick={go} disabled={busy} className={modalPrimary}>{busy ? "Saving..." : change ? "Save payment" : "Mark paid"}</button>
      </>}>
      {change && bankLinkNote(target.bankLinked, target.paidAmount) && (
        <p className="text-[12.5px] text-warning-ink bg-warning-bg border border-warning/30 rounded-lg px-3 py-2" role="status">{bankLinkNote(target.bankLinked, target.paidAmount)}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <label className="block text-[12px] font-medium text-muted mb-1">Amount paid</label>
          <NumberInput className={inp} value={f.amount} placeholder="0.00" onValue={(_n, raw) => set({ amount: raw })} />
        </div>
        <div className="min-w-0">
          <label className="block text-[12px] font-medium text-muted mb-1">Paid on</label>
          <input type="date" className={inp} value={f.paidAt} onChange={(e) => set({ paidAt: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label className="block text-[12px] font-medium text-muted mb-1">Paid by</label>
          <select className={inp} value={f.method} onChange={(e) => set({ method: e.target.value })}>
            <option value="">Not set</option>
            {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            {f.method && !methods.includes(f.method) && <option value={f.method}>{f.method}</option>}
          </select>
        </div>
        <div className="min-w-0">
          <label className="block text-[12px] font-medium text-muted mb-1">Reference</label>
          <input className={inp} value={f.note} placeholder="Confirmation number" onChange={(e) => set({ note: e.target.value })} />
        </div>
      </div>
      {!change && target.rate == null && <p className="text-[12px] text-muted">This load has no carrier rate yet, so type what was paid.</p>}
      {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
    </LogisticsModal>
  );
}

/** Undo a payment: asks first, then clears the amount. Returns whether it was undone. */
export async function undoCarrierPaid(bookingId: string, label: string, paid?: number | null): Promise<boolean> {
  if (!confirm(`Undo the payment${paid != null ? ` of ${fmtAmount(paid)}` : ""} for ${label}? The load shows as owed again.`)) return false;
  try { await api.logistics.update(bookingId, UNDO_PAID_PATCH); toast("Payment undone"); return true; }
  catch (e) { toast(String(e), "error"); return false; }
}

// ─── Link the bank payment ────────────────────────────────────────────────

/** The bank transactions that look like this payment (money out for about the amount, around the day it was
 *  paid). Picking one books it against the deal as shipping, for what was paid on this load. */
export function LinkBankSheet({ target, onClose, onDone }: { target: PayTarget; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<BankCandidate[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let dead = false;
    api.logistics.carrierPay.candidates(target.bookingId)
      .then((r) => { if (!dead) setRows(carrierPayCandidates(r)); })
      .catch((e) => { if (!dead) { setErr(String(e)); setRows([]); } });
    return () => { dead = true; };
  }, [target.bookingId]);
  const link = async (c: BankCandidate) => {
    setBusy(c.txnId); setErr("");
    try { await api.logistics.carrierPay.link(target.bookingId, c.txnId); toast("Linked to the bank payment"); onDone(); }
    catch (e) { setErr(String(e)); setBusy(""); }
  };
  return (
    <LogisticsModal title="Link bank payment" sub={target.label} wide onClose={onClose}
      footer={<button onClick={onClose} className={modalPrimary}>Close</button>}>
      <p className="text-[12.5px] text-muted">
        Money that left the account for about {target.paidAmount != null ? fmtAmount(target.paidAmount) : "this amount"}, within a few days of the payment.
        Linking it books the payment on the deal as shipping.
      </p>
      {rows === null ? <p className="text-[12.5px] text-muted">Looking...</p> : rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">{err ? "" : "No matching bank payment yet. It shows up here once the money leaves the account."}</p>
      ) : (
        <div className="rounded-lg border border-line divide-y divide-line">
          {rows.map((c) => (
            <div key={c.txnId} className="flex items-center gap-3 px-3 py-2.5 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink truncate">{c.who || c.memo || "Bank payment"}</div>
                <div className="text-[11.5px] text-muted truncate">{[fmtDayLabel(c.day), c.who && c.memo ? c.memo : "", c.reason].filter(Boolean).join(" · ")}</div>
              </div>
              {c.amount != null && <span className="text-[13px] tabular-nums text-ink flex-shrink-0">{fmtAmount(c.amount)}</span>}
              <button onClick={() => link(c)} disabled={busy !== ""}
                className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink hover:bg-surface-2 disabled:opacity-40 whitespace-nowrap">
                {busy === c.txnId ? "Linking..." : "Link"}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
    </LogisticsModal>
  );
}

// ─── a file on a load, opened in place ────────────────────────────────────

function useOpenFile() {
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const open = async (bookingId: string, fileId: string) => {
    try {
      const got = await api.logistics.files.get(bookingId, fileId);
      if (!(got.mime.startsWith("image/") || got.mime === "application/pdf")) {
        const dest = await saveDialog({ defaultPath: got.name });
        if (dest) { await api.logistics.files.saveAs(bookingId, fileId, dest); toast(`Saved ${got.name}`); }
        return;
      }
      const bin = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
      setPreview({ url: URL.createObjectURL(new Blob([bin], { type: got.mime })), name: got.name, mime: got.mime });
    } catch (e) { toast(String(e), "error"); }
  };
  const node = preview && (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6" onClick={() => setPreview(null)}>
      {preview.mime === "application/pdf"
        ? <iframe src={preview.url} title={preview.name} className="w-full max-w-[900px] h-full rounded-lg bg-surface" />
        : <img src={preview.url} alt={preview.name} className="max-w-full max-h-full rounded-lg shadow-xl" />}
    </div>
  );
  return { open, node };
}

// ─── the Pay carriers view ────────────────────────────────────────────────

function Group({ title, count, note, children }: { title: string; count: number; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 flex-wrap">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <StatusPill tone="neutral">{count}</StatusPill>
        {note && <span className="text-[12px] text-muted ml-auto">{note}</span>}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function Who({ r, onOpen }: { r: CarrierPayRow; onOpen: () => void }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2 min-w-0">
        <button type="button" onClick={onOpen} className="font-mono text-[12px] text-accent hover:underline flex-shrink-0" title="Open the load on its Pay step">{r.load_number}</button>
        <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{r.carrier || "Carrier not named"}</span>
      </div>
      <div className="text-[12px] text-muted mt-0.5 truncate">{[r.route, r.deal_label].filter(Boolean).join(" · ")}</div>
    </div>
  );
}

export function PayCarriersView({ onOpenLoad, rev }: { onOpenLoad: (bookingId: string, step: LoadStep) => void; rev?: number }) {
  const { data, error, reload } = useCarrierPay(true);
  // A load was saved or closed from its page: read the rows again.
  useEffect(() => { if (rev) reload(); }, [rev, reload]);
  const file = useOpenFile();
  const [pay, setPay] = useState<PayTarget | null>(null);
  const [link, setLink] = useState<PayTarget | null>(null);
  const today = localDay();
  const targetOf = (r: CarrierPayRow): PayTarget => ({
    bookingId: r.booking_id, label: `${r.carrier || "Carrier"}, ${r.load_number}`, rate: r.rate, payMethod: r.pay_method, paidAmount: r.paid_amount,
  });
  // R-463: a paid row changes through the same sheet, opened with what is on record.
  const changeTargetOf = (r: CarrierPayRow): PayTarget => ({
    ...targetOf(r), bankLinked: r.bank_linked,
    current: { paid_amount: r.paid_amount, paid_at: r.paid_at, paid_method: r.paid_method, paid_note: r.paid_note },
  });
  const sum = useMemo(() => toPaySummary(data?.to_pay ?? [], today), [data, today]);

  if (data === null) {
    return <div className="space-y-3" aria-busy="true"><div className="h-[120px] bg-surface-2 rounded-xl animate-pulse" /><div className="h-[120px] bg-surface-2 rounded-xl animate-pulse" /></div>;
  }
  return (
    <div className="space-y-5 min-w-0">
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={reload} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}

      <Group title="To pay" count={data.to_pay.length}
        note={data.to_pay.length > 0 ? <>{sum.late > 0 ? `${sum.late} due or late, ` : ""}{fmtAmount(sum.total)} owed{sum.noRate > 0 ? `, ${sum.noRate} with no rate` : ""}</> : undefined}>
        {data.to_pay.length === 0 && <div className="px-4 py-4 text-[12.5px] text-muted">No carrier is waiting to be paid.</div>}
        {data.to_pay.map((r) => {
          const due = payDue(r, today);
          return (
            <div key={r.booking_id} className="flex items-center gap-3 px-4 py-3 min-w-0 flex-wrap">
              <Who r={r} onOpen={() => onOpenLoad(r.booking_id, "pay")} />
              <div className="text-[12px] text-muted min-w-0 max-w-[260px]">
                <div className="truncate">{payMethodLabel(r.pay_method) ? `Pay by ${payMethodLabel(r.pay_method)}` : "No pay method saved"}</div>
                {r.pay_details && <div className="truncate" title={r.pay_details}>{r.pay_details}</div>}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <StatusPill tone={due.tone}>{due.label}</StatusPill>
                {r.carrier_invoice_file_id
                  ? <button type="button" onClick={() => file.open(r.booking_id, r.carrier_invoice_file_id)}
                      className="flex items-center gap-1 px-2 h-7 rounded-lg border border-line text-[12px] text-ink-2 hover:bg-surface-2 whitespace-nowrap"><FileText size={12} /> Carrier invoice</button>
                  : <StatusPill tone="warning">No carrier invoice</StatusPill>}
              </div>
              <span className="text-[14px] font-semibold tabular-nums text-ink w-24 text-right flex-shrink-0">{r.rate != null ? fmtAmount(r.rate) : "No rate"}</span>
              <button type="button" onClick={() => setPay(targetOf(r))}
                className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12.5px] font-medium whitespace-nowrap flex-shrink-0">
                Mark paid
              </button>
            </div>
          );
        })}
      </Group>

      <Group title="Paid" count={data.paid.length} note="Last 60 days">
        {data.paid.length === 0 && <div className="px-4 py-4 text-[12.5px] text-muted">Nothing paid in the last 60 days.</div>}
        {data.paid.map((r) => (
          <div key={r.booking_id} className="flex items-center gap-3 px-4 py-3 min-w-0 flex-wrap">
            <Who r={r} onOpen={() => onOpenLoad(r.booking_id, "pay")} />
            <div className="text-[12.5px] text-ink-2 min-w-0 max-w-[320px] truncate">{paymentLine({ paid_amount: r.paid_amount, paid_at: r.paid_at, paid_method: r.paid_method, paid_note: r.paid_note })}</div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <BankLinkPill state={r.bank_linked} />
              <button type="button" onClick={() => setPay(changeTargetOf(r))}
                className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">Change</button>
              {r.bank_linked !== "linked" && (
                <button type="button" onClick={() => setLink(targetOf(r))}
                  className="flex items-center gap-1 px-2.5 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 whitespace-nowrap"><Landmark size={12} /> Link bank payment</button>
              )}
              <button type="button" onClick={async () => { if (await undoCarrierPaid(r.booking_id, `${r.carrier || "the carrier"}, ${r.load_number}`, r.paid_amount)) reload(); }}
                className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 whitespace-nowrap">Undo</button>
            </div>
          </div>
        ))}
      </Group>

      {pay && <MarkPaidSheet target={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); reload(); }} />}
      {link && <LinkBankSheet target={link} onClose={() => setLink(null)} onDone={() => { setLink(null); reload(); }} />}
      {file.node}
    </div>
  );
}

// ─── Bills: Carriers to pay ───────────────────────────────────────────────

/** The top of the Bills screen: every carrier still owed, with when it is due and how it gets paid. A row opens
 *  the load on its Pay step. Nothing renders unless someone is owed, and nothing is asked of the server unless
 *  `canPay` (the carrier-pay routes are for the people who may pay). */
export function CarriersToPaySection({ canPay }: { canPay: boolean }) {
  const { data } = useCarrierPay(canPay);
  const today = localDay();
  const rows = useMemo(() => data?.to_pay ?? [], [data]);
  const sum = useMemo(() => toPaySummary(rows, today), [rows, today]);
  if (!canPay || rows.length === 0) return null;
  return (
    <section className="mb-5 bg-surface border border-line rounded-2xl overflow-hidden" aria-label="Carriers to pay">
      <div className="px-4 py-3 border-b border-line flex items-center gap-2 flex-wrap">
        <h3 className="text-[14px] font-semibold text-ink">Carriers to pay</h3>
        <StatusPill tone={sum.late > 0 ? "danger" : "neutral"}>{rows.length}</StatusPill>
        <span className="text-[12px] text-muted ml-auto">{fmtAmount(sum.total)} owed{sum.noRate > 0 ? `, ${sum.noRate} with no rate` : ""}</span>
      </div>
      <div className="divide-y divide-line">
        {rows.map((r) => {
          const due = payDue(r, today);
          return (
            <button key={r.booking_id} type="button" onClick={() => openLoadInLogistics(r.booking_id, "pay")}
              className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60 transition-colors min-w-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{r.carrier || "Carrier not named"}</span>
                  <span className="font-mono text-[12px] text-muted flex-shrink-0">{r.load_number}</span>
                </div>
                <div className="text-[12px] text-muted truncate">{payMethodLabel(r.pay_method) ? `Pay by ${payMethodLabel(r.pay_method)}` : "No pay method saved"}</div>
              </div>
              <StatusPill tone={due.tone}>{due.label}</StatusPill>
              <span className="text-[13.5px] font-semibold tabular-nums text-ink w-24 text-right flex-shrink-0">{r.rate != null ? fmtAmount(r.rate) : "No rate"}</span>
              <ChevronRight size={14} className="text-faint flex-shrink-0" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
