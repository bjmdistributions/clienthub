import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { api, type LogisticsWeek } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { amountProblem, bookedDayLabel, byBookedDay, hasNextWeek, paidLine, shiftDay, weekPill, weekRange } from "../lib/logisticsWeek";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-542 (Jack: "i need a better view to see all the trucks my logistics guy booked every week only"): one week of
// trucks, each under the day it was booked, with his commission on each and the week's total. The booked day alone
// decides the week. The admin records the week's payment here, typing what was actually paid (the commission or
// more). Everyone with the Logistics screen sees the trucks; the money only shows to whoever the server lets see his
// pay (the admin, a deal viewer with the dollar switch, and the person being paid).

const REFRESH_MS = 30_000;
const METHODS = ["Zelle", "ACH", "Check", "Cash", "Other"];
const inp =
  "border border-line px-3 h-10 rounded-lg text-[14px] bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";

export function LogisticsWeekView({ startDay, onOpenLoad, framed = true }: {
  /** Any day of the week to open on; today when left out. */
  startDay?: string;
  onOpenLoad?: (bookingId: string) => void;
  /** false inside a panel that draws its own frame. */
  framed?: boolean;
}) {
  const [day, setDay] = useState(startDay || localDay());
  const [w, setW] = useState<LogisticsWeek | null>(null);
  const [err, setErr] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setW(await api.logistics.pay.week(day)); setErr(""); }
    catch (e) { setErr(String(e)); }
  }, [day]);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("focus", load); };
  }, [load]);
  // A new week starts its payment from that week's commission and the usual method.
  useEffect(() => { setAmount(null); }, [w?.start, w?.to_pay]);
  useEffect(() => { if (w?.pay_method) setMethod((m) => m || w.pay_method); }, [w?.pay_method]);

  const frame = framed ? "bg-surface border border-line rounded-xl overflow-hidden" : "";
  if (!w) {
    return (
      <section className={frame} aria-label="Trucks booked this week">
        <div className="px-4 py-4 text-[13px] text-muted">
          {err ? <span className="text-warning-ink">{err} <button type="button" onClick={load} className="underline font-medium">Try again</button></span> : "Loading the week..."}
        </div>
      </section>
    );
  }

  const groups = byBookedDay(w.loads);
  const pill = weekPill(w);
  const isThisWeek = w.start <= w.today && w.today <= w.end;
  const typed = amount ?? w.to_pay;
  const problem = amountProblem(typed, w.to_pay, fmtAmount);
  const who = w.mine ? "you" : w.payee_name || "him";

  const record = async () => {
    if (problem || busy) return;
    const extra = typed - w.to_pay;
    if (!confirm(`Record ${fmtAmount(typed)} paid to ${w.payee_name || "logistics"}${method ? ` by ${method}` : ""} for ${weekRange(w.start, w.end)}?${extra > 0.005 ? ` That is ${fmtAmount(extra)} more than the commission.` : ""}`)) return;
    setBusy(true);
    try { await api.logistics.pay.record(w.pay_date, { method: method || "Other", amount: typed }); toast("Payment recorded"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };
  const undo = async () => {
    if (!w.paid?.payout_id || busy) return;
    if (!confirm(`Undo the ${fmtAmount(w.paid.amount)} payment for ${weekRange(w.start, w.end)}? Its commission is owed again.`)) return;
    setBusy(true);
    try { await api.logistics.pay.undo(w.paid.payout_id); toast("Payment undone"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };

  return (
    <section className={frame} aria-label="Trucks booked this week">
      <div className="px-4 pt-3.5 pb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={() => setDay(shiftDay(w.start, -1))} aria-label="The week before"
            className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 flex items-center justify-center flex-shrink-0 transition-colors duration-[130ms]">
            <ChevronLeft size={17} />
          </button>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink">Trucks booked, {weekRange(w.start, w.end)}</h3>
            <p className="text-[12.5px] text-muted mt-0.5">
              {isThisWeek ? "This week. " : ""}{w.loads.length === 0 ? "No trucks booked." : `${w.loads.length} ${w.loads.length === 1 ? "truck" : "trucks"}, each on the day it was booked.`}
            </p>
          </div>
          <button type="button" onClick={() => setDay(shiftDay(w.end, 1))} disabled={!hasNextWeek(w)} aria-label="The week after"
            className="w-9 h-9 rounded-lg border border-line text-ink-2 hover:bg-surface-2 flex items-center justify-center flex-shrink-0 transition-colors duration-[130ms] disabled:opacity-35 disabled:hover:bg-transparent">
            <ChevronRight size={17} />
          </button>
          {!isThisWeek && (
            <button type="button" onClick={() => setDay(localDay())} className="text-[12.5px] text-ink-2 hover:text-ink underline ml-1 whitespace-nowrap">This week</button>
          )}
        </div>
        {w.money && (
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="text-right">
              <div className="text-[12px] text-muted">Commission</div>
              <div className="text-[20px] font-bold tabular-nums text-ink leading-tight">{fmtAmount(w.commission ?? 0)}</div>
            </div>
            {pill && <StatusPill tone={pill.tone} size="md">{pill.word}</StatusPill>}
          </div>
        )}
      </div>

      {groups.length > 0 && (
        <div className="border-t border-line divide-y divide-line">
          {groups.map((g) => (
            <div key={g.day} className="px-4 py-2 flex gap-4 min-w-0">
              <div className="w-[104px] flex-shrink-0 pt-1.5 text-[13.5px] font-medium text-ink-2">{bookedDayLabel(g.day)}</div>
              <div className="flex-1 min-w-0">
                {g.loads.map((l) => {
                  const Row = onOpenLoad ? "button" : "div";
                  return (
                    <Row key={l.id} {...(onOpenLoad ? { type: "button" as const, onClick: () => onOpenLoad(l.id) } : {})}
                      className={`w-full flex items-baseline gap-3 py-1.5 min-w-0 text-left rounded-md ${onOpenLoad ? "hover:bg-surface-2/70 px-1.5 -mx-1.5 transition-colors duration-[130ms]" : ""}`}>
                      <span className="font-mono text-[13px] text-muted flex-shrink-0">{l.code}</span>
                      <span className="text-[14px] text-ink truncate min-w-0 flex-1">{l.lane}</span>
                      {w.money && <span className="text-[14px] font-semibold tabular-nums text-ink flex-shrink-0">{l.commission == null ? "Waiting" : fmtAmount(l.commission)}</span>}
                    </Row>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {w.money && (w.paid || w.can_record || w.paid_total != null) && (
        <div className="border-t border-line px-4 py-3 flex items-center justify-between gap-x-4 gap-y-2.5 flex-wrap bg-surface-2/40">
          <div className="min-w-0 flex items-center gap-3 flex-wrap">
            {w.paid && <span className="text-[13.5px] text-ink">{paidLine(w, fmtAmount)}</span>}
            {w.paid?.payout_id && (
              <button type="button" onClick={undo} disabled={busy} className="text-[12.5px] text-muted hover:text-ink underline disabled:opacity-40">Undo</button>
            )}
            {w.can_record && (
              <div className="flex items-end gap-2 flex-wrap">
                <label className="block">
                  <span className="block text-[12px] font-medium text-muted mb-1">Amount paid</span>
                  <NumberInput value={amount ?? w.to_pay} onValue={(n) => setAmount(n)} className={`${inp} w-32 tabular-nums`} aria-label="Amount paid" />
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-muted mb-1">Paid with</span>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inp} w-32`}>
                    <option value="">Not set</option>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <button type="button" onClick={record} disabled={busy || !!problem}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13.5px] font-medium disabled:opacity-40 transition-colors whitespace-nowrap">
                  Record payment
                </button>
                {problem && amount != null && <span className="text-[12.5px] text-warning-ink self-center">{problem}</span>}
              </div>
            )}
          </div>
          {w.paid_total != null && (
            <div className="text-[13px] text-ink-2 flex items-baseline gap-4 flex-wrap">
              <span>Paid to {who} so far <span className="font-semibold text-ink tabular-nums">{fmtAmount(w.paid_total)}</span></span>
              {(w.owed_now ?? 0) > 0.005 && <span>Owed now <span className="font-semibold text-ink tabular-nums">{fmtAmount(w.owed_now ?? 0)}</span></span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** R-542: a pay day on Bills opens the week it pays: the trucks booked that week, the commission and the payment. */
export function LogisticsWeekPanel({ payDate, onClose }: { payDate: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="w-full max-w-[640px] h-full bg-surface border-l border-line overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-surface px-4 py-3.5 border-b border-line flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-ink">Logistics pay day</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg text-muted hover:text-ink hover:bg-surface-2 flex items-center justify-center">
            <X size={18} />
          </button>
        </div>
        {/* The pay date pays the week before it, so the day before it is inside that week. */}
        <LogisticsWeekView startDay={shiftDay(payDate, -1)} framed={false} />
      </aside>
    </div>
  );
}
