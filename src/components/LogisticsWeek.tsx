import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { api, type LogisticsWeek } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { comingLabel } from "../lib/buyLoads";
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
  "border border-line-3 px-3 h-10 rounded-lg text-[14px] bg-transparent text-ink placeholder-faint " +
  "focus:outline-none focus:border-ink transition-colors disabled:opacity-60";

export function LogisticsWeekView({ startDay, onOpenLoad }: {
  /** Any day of the week to open on; today when left out. */
  startDay?: string;
  onOpenLoad?: (bookingId: string) => void;
  /** Kept for callers: the week no longer draws a frame of its own. */
  framed?: boolean;
}) {
  const [day, setDay] = useState(startDay || localDay());
  const [w, setW] = useState<LogisticsWeek | null>(null);
  const [err, setErr] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);
  // R-583: the confirmation is a panel under the payment, not a browser dialog.
  const [confirming, setConfirming] = useState<"record" | "undo" | null>(null);

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

  const frame = "";
  if (!w) {
    return (
      <section className={frame} aria-label="Trucks booked this week">
        <div className="py-4 text-[14px] text-muted">
          {err ? <span className="text-warning-ink">{err} <button type="button" onClick={load} className="ui-link">Try again</button></span> : "Loading the week..."}
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

  const confirmText = confirming === "undo"
    ? `Undo the ${fmtAmount(w.paid?.amount ?? 0)} payment for ${weekRange(w.start, w.end)}? Its commission is owed again.`
    : (() => {
      const extra = typed - w.to_pay;
      return `Record ${fmtAmount(typed)} paid to ${w.payee_name || "logistics"}${method ? ` by ${method}` : ""} for ${weekRange(w.start, w.end)}?${extra > 0.005 ? ` That is ${fmtAmount(extra)} more than the commission.` : ""}`;
    })();

  const record = async () => {
    setConfirming(null);
    if (problem || busy) return;
    setBusy(true);
    try { await api.logistics.pay.record(w.pay_date, { method: method || "Other", amount: typed }); toast("Payment recorded"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };
  const undo = async () => {
    setConfirming(null);
    if (!w.paid?.payout_id || busy) return;
    setBusy(true);
    try { await api.logistics.pay.undo(w.paid.payout_id); toast("Payment undone"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy(false);
  };

  return (
    <section className={frame} aria-label="Trucks booked this week">
      <div className="flex items-center justify-between gap-x-4 gap-y-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <button type="button" onClick={() => { setConfirming(null); setDay(shiftDay(w.start, -1)); }} aria-label="The week before"
            className="ui-btn !w-9 !px-0 justify-center flex-shrink-0">
            <ChevronLeft size={17} />
          </button>
          <div className="min-w-0">
            <h3 className="m-0 text-[18px] font-medium text-ink">Trucks booked, {weekRange(w.start, w.end)}</h3>
            <p className="m-0 mt-0.5 text-[14px] text-muted">
              {isThisWeek ? "This week. " : ""}{w.loads.length === 0 ? "No trucks booked." : `${w.loads.length} ${w.loads.length === 1 ? "truck" : "trucks"}, each on the day it was booked.`}
            </p>
          </div>
          <button type="button" onClick={() => { setConfirming(null); setDay(shiftDay(w.end, 1)); }} disabled={!hasNextWeek(w)} aria-label="The week after"
            className="ui-btn !w-9 !px-0 justify-center flex-shrink-0">
            <ChevronRight size={17} />
          </button>
          {!isThisWeek && (
            <button type="button" onClick={() => { setConfirming(null); setDay(localDay()); }} className="ui-link muted whitespace-nowrap">This week</button>
          )}
        </div>
        {w.money && (
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="text-right">
              <div className="ui-label">Commission</div>
              <div className="ui-fig">{fmtAmount(w.commission ?? 0)}</div>
            </div>
            {pill && <StatusPill tone={pill.tone} size="md">{pill.word}</StatusPill>}
          </div>
        )}
      </div>

      {groups.length > 0 && (
        <div className="mt-3.5">
          {groups.map((g) => (
            g.loads.map((l, i) => {
              const Row = onOpenLoad ? "button" : "div";
              return (
                <Row key={l.id} {...(onOpenLoad ? { type: "button" as const, onClick: () => onOpenLoad(l.id) } : {})}
                  style={{ boxShadow: "inset 0 1px 0 rgb(var(--c-line))" }}
                  className={`w-full flex items-baseline gap-3.5 px-2 py-[11px] min-w-0 text-left rounded-lg ${onOpenLoad ? "transition-colors duration-[130ms] hover:bg-surface-2 cursor-pointer" : ""}`}>
                  <span className="w-[104px] flex-shrink-0 text-[14px] text-muted">{i === 0 ? bookedDayLabel(g.day) : ""}</span>
                  <span className="w-[56px] flex-shrink-0 text-[14px] text-muted tabular-nums">{l.code}</span>
                  <span className="text-[15px] text-ink truncate min-w-0 flex-1">{[l.buy_name ? comingLabel(l.buy_name) : "", l.lane].filter(Boolean).join(" · ")}</span>
                  {w.money && <span className={`text-[15px] font-medium tabular-nums flex-shrink-0 ${l.commission == null ? "text-muted" : "text-ink"}`}>{l.commission == null ? "Waiting" : fmtAmount(l.commission)}</span>}
                </Row>
              );
            })
          ))}
        </div>
      )}

      {w.money && (w.paid || w.can_record || w.paid_total != null) && (
        <>
          <div className="hsep mt-2" />
          <div className="pt-3.5 flex items-center justify-between gap-x-5 gap-y-3 flex-wrap">
            <div className="min-w-0 flex items-end gap-x-3.5 gap-y-2.5 flex-wrap">
              {w.paid && <span className="text-[14px] text-ink self-center">{paidLine(w, fmtAmount)}</span>}
              {w.paid?.payout_id && (
                <button type="button" onClick={() => setConfirming("undo")} disabled={busy} className="ui-link muted self-center disabled:opacity-40">Undo</button>
              )}
              {w.can_record && (<>
                <label className="block">
                  <span className="block ui-label mb-1.5">Amount paid</span>
                  <NumberInput value={amount ?? w.to_pay} onValue={(n) => setAmount(n)} className={`${inp} w-32 tabular-nums`} aria-label="Amount paid" />
                </label>
                <label className="block">
                  <span className="block ui-label mb-1.5">Paid with</span>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${inp} w-32`}>
                    <option value="">Not set</option>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => setConfirming("record")} disabled={busy || !!problem}
                  className="ui-btn ui-btn-ink !h-10 whitespace-nowrap">
                  Record payment
                </button>
                {problem && amount != null && <span className="text-[13px] text-danger-ink self-center">{problem}</span>}
              </>)}
            </div>
            {w.paid_total != null && (
              <div className="text-[14px] text-muted flex items-baseline gap-x-[18px] gap-y-1 flex-wrap">
                <span>Paid to {who} so far <span className="font-medium text-ink tabular-nums">{fmtAmount(w.paid_total)}</span></span>
                {(w.owed_now ?? 0) > 0.005 && <span>Owed now <span className="font-medium text-ink tabular-nums">{fmtAmount(w.owed_now ?? 0)}</span></span>}
              </div>
            )}
          </div>
          {confirming && (
            <div role="alertdialog" aria-label="Confirm" className="mt-3.5 flex items-center justify-between gap-x-4 gap-y-2.5 flex-wrap rounded-xl bg-surface-2 px-4 py-3 animate-page-slide-in">
              <span className="text-[14px] leading-6 text-ink flex-1 min-w-[240px]">{confirmText}</span>
              <span className="flex gap-2">
                <button type="button" onClick={() => setConfirming(null)} className="ui-btn border-transparent">Cancel</button>
                <button type="button" onClick={confirming === "undo" ? undo : record} className="ui-btn ui-btn-ink">{confirming === "undo" ? "Undo payment" : "Record payment"}</button>
              </span>
            </div>
          )}
        </>
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 animate-fade-in" onClick={onClose}>
      <aside className="w-full max-w-[640px] h-full bg-surface overflow-y-auto animate-slide-in-right" style={{ boxShadow: "-1px 0 0 rgb(var(--c-line-3))" }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-surface px-6 py-[18px] flex items-center justify-between gap-3" style={{ boxShadow: "inset 0 -1px 0 rgb(var(--c-line))" }}>
          <h2 className="m-0 text-[17px] font-medium text-ink">Logistics pay day</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-ib">
            <X size={18} />
          </button>
        </div>
        {/* The pay date pays the week before it, so the day before it is inside that week. */}
        <div className="px-6 py-[22px]">
          <LogisticsWeekView startDay={shiftDay(payDate, -1)} framed={false} />
        </div>
      </aside>
    </div>
  );
}
