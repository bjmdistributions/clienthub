import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronRight, FileText, Search } from "lucide-react";
import { api, type CarrierPayResponse, type CarrierPayRow, type PaidState } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import {
  OPEN_LOAD_KEY, UNDO_PAID_PATCH, carrierPayCandidates, encodeOpenLoad, linkAmountCheck, linkAmountStart, payDue, payMethodLabel,
  toPaySummary, type BankCandidate,
} from "../lib/logisticsCarriers";
import { fmtDayLabel, paidView, type LoadStep, type PaidFacts, type PaidView } from "../lib/logisticsLoad";
import { useNetsyncApplied } from "../lib/useNetsyncApplied";
import { LogisticsModal, modalGhost, modalPrimary } from "./LogisticsCarriers";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-459: paying the carriers, from the admin side. Logistics books the truck and files the paperwork; the
// team sees who is owed and who has been paid here, and the only way a load becomes paid is by linking the bank
// transaction that moved the money (R-470: nobody types an amount paid), so every deal is tracked to the last
// dollar. The same rows feed the Bills screen's "Carriers to pay" section. Only someone who may pay opens any of
// this; the server checks it too.

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

/** The rows, read now and again on a timer, on focus and when a sync lands. Nothing is asked unless `enabled`. */
export function useCarrierPay(enabled: boolean) {
  const [data, setData] = useState<CarrierPayResponse | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!enabled) return;
    try { setData(await api.logistics.carrierPay.list(60)); setError(""); }
    catch (e) { setError(String(e)); setData((d) => d ?? { to_pay: [], to_link: [], paid: [] }); }
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

// ─── Paid means linked to the bank (R-470) ────────────────────────────────

/** The load a payment control acts on. `rate` is the carrier rate, for the amount a link opens with. */
export interface PayTarget { bookingId: string; label: string; rate: number | null }

/** The bank rows that look like this payment (money out, with money left on it, around the pay day). Picking one
 *  asks for the amount to book on this load, then books it against the deal as shipping and marks the load paid.
 *  This is the only way a load becomes paid. */
export function LinkBankSheet({ target, onClose, onDone }: { target: PayTarget; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<BankCandidate[] | null>(null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<BankCandidate | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let dead = false;
    const id = window.setTimeout(() => {
      api.logistics.carrierPay.candidates(target.bookingId, q)
        .then((r) => { if (!dead) { setRows(carrierPayCandidates(r)); setErr(""); } })
        .catch((e) => { if (!dead) { setErr(String(e)); setRows((prev) => prev ?? []); } });
    }, q.trim() ? 250 : 0);
    return () => { dead = true; window.clearTimeout(id); };
  }, [target.bookingId, q]);

  const pick = (c: BankCandidate) => {
    const start = linkAmountStart(c, target.rate);
    setPicked(c); setAmount(start == null ? "" : String(start)); setErr("");
  };
  const go = async () => {
    if (!picked) return;
    const r = linkAmountCheck(amount, picked.free);
    if ("error" in r) { setErr(r.error); return; }
    setBusy(true); setErr("");
    try { await api.logistics.carrierPay.link(target.bookingId, picked.txnId, r.amount); toast("Linked to the bank payment"); onDone(); }
    catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <LogisticsModal title="Link bank payment" sub={target.label} wide onClose={onClose}
      footer={picked
        ? <>
            <button onClick={() => { setPicked(null); setErr(""); }} disabled={busy} className={modalGhost}>Back</button>
            <button onClick={go} disabled={busy} className={modalPrimary}>{busy ? "Linking..." : "Link payment"}</button>
          </>
        : <button onClick={onClose} className={modalPrimary}>Close</button>}>
      {picked ? (
        <>
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 min-w-0">
            <div className="flex items-baseline gap-3 min-w-0">
              <div className="text-[13px] text-ink truncate min-w-0 flex-1">{picked.who || picked.memo || "Bank payment"}</div>
              {picked.amount != null && <span className="text-[13px] tabular-nums text-ink flex-shrink-0">{fmtAmount(picked.amount)}</span>}
            </div>
            <div className="text-[11.5px] text-muted truncate">{[fmtDayLabel(picked.day), picked.who && picked.memo ? picked.memo : ""].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="min-w-0">
            <label className="block text-[12px] font-medium text-muted mb-1">Amount to link to this load</label>
            <NumberInput className={inp} value={amount} placeholder="0.00" autoFocus onValue={(_n, raw) => setAmount(raw)} />
            <div className="text-[11px] text-muted mt-1">
              {[picked.free != null ? `${fmtAmount(picked.free)} free on this payment.` : "", target.rate != null ? `Carrier rate ${fmtAmount(target.rate)}.` : ""].filter(Boolean).join(" ")}
              {" "}Linking books this amount on the deal as shipping and marks the load paid.
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12.5px] text-muted">
            Money that left the account in the last few months and is not fully booked yet. Pick the payment that went to this carrier.
          </p>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an amount or words" aria-label="Search bank payments"
              className={`${inp} pl-8`} />
          </div>
          {rows === null ? <p className="text-[12.5px] text-muted">Looking...</p> : rows.length === 0 ? (
            <p className="text-[12.5px] text-ink-2">{err ? "" : q.trim() ? "No bank payment matches that." : "No bank payment to link yet. It shows up here once the money leaves the account."}</p>
          ) : (
            <div className="rounded-lg border border-line divide-y divide-line">
              {rows.map((c) => (
                <div key={c.txnId} className="flex items-center gap-3 px-3 py-2.5 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink truncate">{c.who || c.memo || "Bank payment"}</div>
                    <div className="text-[11.5px] text-muted truncate">
                      {[fmtDayLabel(c.day), c.who && c.memo ? c.memo : "", c.method, c.reason].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {c.amount != null && <div className="text-[13px] tabular-nums text-ink">{fmtAmount(c.amount)}</div>}
                    {c.free != null && <div className="text-[11px] tabular-nums text-muted">{fmtAmount(c.free)} free on it</div>}
                  </div>
                  <button onClick={() => pick(c)}
                    className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink hover:bg-surface-2 whitespace-nowrap">Choose</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {err && <div className="text-[12px] text-danger-ink" role="alert">{err}</div>}
    </LogisticsModal>
  );
}

/** What the payment controls on one screen share: the link picker, and Unlink and Undo with their questions.
 *  `onChanged` runs after any of them changes the load, so the screen reads it again. */
export function usePaidControls(onChanged: () => void) {
  const [target, setTarget] = useState<PayTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await what(); toast(done); onChanged(); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return {
    busy,
    open: target !== null,
    link: (t: PayTarget) => setTarget(t),
    unlink: async (t: PayTarget) => {
      if (!confirm("Unlink this bank payment? The load goes back to To pay.")) return;
      await run(() => api.logistics.carrierPay.unlink(t.bookingId), "Bank payment unlinked");
    },
    /** Takes back a payment somebody typed that was never linked. A linked one is refused by the server in its own words. */
    undo: async (t: PayTarget) => {
      if (!confirm(`Undo the payment on ${t.label}? The load goes back to To pay.`)) return;
      await run(() => api.logistics.update(t.bookingId, UNDO_PAID_PATCH), "Payment undone");
    },
    sheet: target ? <LinkBankSheet target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); onChanged(); }} /> : null,
  };
}

const ghostBtn = "px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-40 whitespace-nowrap";
const primaryBtn = "bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12.5px] font-medium disabled:opacity-40 whitespace-nowrap";

const TONE_TEXT: Record<PaidView["tone"], string> = {
  neutral: "text-ink-2", warning: "text-warning-ink", danger: "text-danger-ink", success: "text-success-ink",
};

/** A load's payment in words: not paid yet and when it is due, marked paid but not linked, or paid and linked. */
export function PaidSummary({ b, today, className = "" }: { b: PaidFacts; today: string; className?: string }) {
  const v = paidView(b, today);
  return (
    <div className={`min-w-0 ${className}`}>
      <div className={`text-[13px] break-words ${TONE_TEXT[v.tone]} ${v.state === "unpaid" ? "" : "font-medium"}`}>{v.text}</div>
      {v.note && <div className={`text-[12px] break-words ${v.noteTone === "neutral" ? "text-muted" : TONE_TEXT[v.noteTone]}`}>{v.note}</div>}
    </div>
  );
}

/** The buttons for a load's payment. Not paid: Link bank payment. Marked paid: Link bank payment and Undo (and Unlink when
 *  part of it is linked). Paid: Unlink. Nothing at all for someone who may not change payments. */
export function PaidButtons({ state, bankLinked, canLink, canChange, target, controls }: {
  state: PaidState; bankLinked?: string | null; canLink: boolean; canChange: boolean; target: PayTarget; controls: ReturnType<typeof usePaidControls>;
}) {
  const linkBtn = canLink && state !== "paid" && (
    <button type="button" onClick={() => controls.link(target)} disabled={controls.busy} className={primaryBtn}>Link bank payment</button>
  );
  const undoBtn = canChange && state === "marked" && (
    <button type="button" onClick={() => controls.undo(target)} disabled={controls.busy} className={ghostBtn}>Undo</button>
  );
  const unlinkBtn = canChange && (state === "paid" || (state === "marked" && (bankLinked === "linked" || bankLinked === "partial"))) && (
    <button type="button" onClick={() => controls.unlink(target)} disabled={controls.busy} className={ghostBtn}>Unlink</button>
  );
  if (!linkBtn && !undoBtn && !unlinkBtn) return null;
  return <div className="flex items-center gap-1.5 flex-wrap">{linkBtn}{undoBtn}{unlinkBtn}</div>;
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
  const controls = usePaidControls(reload);
  const today = localDay();
  const targetOf = (r: CarrierPayRow): PayTarget => ({ bookingId: r.booking_id, label: `${r.carrier || "Carrier"}, ${r.load_number}`, rate: r.rate });
  const sum = useMemo(() => toPaySummary(data?.to_pay ?? [], today), [data, today]);

  if (data === null) {
    return <div className="space-y-3" aria-busy="true"><div className="h-[120px] bg-surface-2 rounded-xl animate-pulse" /><div className="h-[120px] bg-surface-2 rounded-xl animate-pulse" /></div>;
  }
  const toLink = data.to_link ?? [];
  const buttons = (r: CarrierPayRow, state: PaidState) => (
    <PaidButtons state={state} bankLinked={r.bank_linked} canLink canChange target={targetOf(r)} controls={controls} />
  );
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
              {buttons(r, "unpaid")}
            </div>
          );
        })}
      </Group>

      <Group title="Link the bank payment" count={toLink.length}
        note={toLink.length > 0 ? "Marked paid before, but not tied to a bank payment" : undefined}>
        {toLink.length === 0 && <div className="px-4 py-4 text-[12.5px] text-muted">Every paid load is linked to the bank.</div>}
        {toLink.map((r) => (
          <div key={r.booking_id} className="flex items-center gap-3 px-4 py-3 min-w-0 flex-wrap">
            <Who r={r} onOpen={() => onOpenLoad(r.booking_id, "pay")} />
            <PaidSummary b={{ ...r, paid_state: "marked" }} today={today} className="max-w-[320px]" />
            {buttons(r, "marked")}
          </div>
        ))}
      </Group>

      <Group title="Paid" count={data.paid.length} note="Last 60 days">
        {data.paid.length === 0 && <div className="px-4 py-4 text-[12.5px] text-muted">Nothing paid in the last 60 days.</div>}
        {data.paid.map((r) => (
          <div key={r.booking_id} className="flex items-center gap-3 px-4 py-3 min-w-0 flex-wrap">
            <Who r={r} onOpen={() => onOpenLoad(r.booking_id, "pay")} />
            <PaidSummary b={{ ...r, paid_state: "paid" }} today={today} className="max-w-[320px]" />
            {buttons(r, "paid")}
          </div>
        ))}
      </Group>

      {controls.sheet}
      {file.node}
    </div>
  );
}

// ─── Bills: Carriers to pay ───────────────────────────────────────────────

/** The top of the Bills screen: every carrier still owed, with when it is due and how it gets paid. A row opens
 *  the load on its Pay step. Nothing renders unless someone is owed, and nothing is asked of the server unless
 *  `canPay` (the carrier-pay routes are for the people who may pay). Pass `data` to share rows already read. */
export function CarriersToPaySection({ canPay, data: given }: { canPay: boolean; data?: CarrierPayResponse | null }) {
  // R-464: the Bills screen reads the rows once and hands them to this section and to its month strip.
  const own = useCarrierPay(canPay && given === undefined);
  const data = given === undefined ? own.data : given;
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
