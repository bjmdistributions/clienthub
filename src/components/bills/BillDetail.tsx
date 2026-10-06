// R-449: one bill opened from its card. The facts, the last twelve due dates, the bank payments
// behind them (unlink one, or undo an unlink) and a picker to link a payment Ecliptr did not
// match on its own. Reads are open to anyone who can see Bills; every write is admin only.
// R-453 / R-454: a payment that pays no due date reads "Extra charge", and the picker can search
// every payment out of the bank, on any date.
import { useCallback, useEffect, useState } from "react";
import { Archive, Link2, Pencil, RotateCcw, X } from "lucide-react";
import StatusPill from "../StatusPill";
import { toast } from "../Toast";
import { catLabel } from "../FinancialsView";
import { fmtAmount } from "../../lib/format";
import { billsApi, type BillDetail as Detail, type BillOut, type BillPayment, type PickTxn } from "../../lib/billsApi";
import { amountText, PERIOD_PILL, STATUS_PILL, billMethodLabel, cadenceLabel, dueText, extraNote, longDay, paysText, shortDay } from "../../lib/billsFormat";
import { BillLogo, btn, inp, useEscape } from "./ui";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function BillDetail({ id, rev, admin, onClose, onEdit, onChanged }: {
  id: string;
  /** Bumped by the screen whenever its list reloads, so this reads the bill again. */
  rev: number;
  admin: boolean;
  onClose: () => void;
  onEdit: (b: BillOut) => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // The "Link a payment" list: open or not, what is typed, what was last sent (300 ms after the
  // last key), and what came back.
  const [pickOpen, setPickOpen] = useState(false);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [rows, setRows] = useState<PickTxn[] | null>(null);
  const [pickError, setPickError] = useState("");
  useEscape(onClose);

  const load = useCallback(async () => {
    try { setD(await billsApi.get(id)); setError(""); } catch (e) { setError(msg(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load, rev]);

  const act = async (key: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await run();
      if (done) toast(done);
      await load();
      onChanged();
    } catch (e) { toast(msg(e), "error"); } finally { setBusy(""); }
  };

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Read the list again when the search changes, and when the bill's payments do (a link or an
  // unlink moves what each row would pay). An answer to an older search is dropped.
  useEffect(() => {
    if (!pickOpen) return;
    let live = true;
    billsApi.candidates(id, dq)
      .then((r) => { if (live) { setRows(r); setPickError(""); } })
      .catch((e) => { if (live) setPickError(msg(e)); });
    return () => { live = false; };
  }, [pickOpen, id, dq, d]);

  const closePicker = () => { setPickOpen(false); setRows(null); setQ(""); setDq(""); setPickError(""); };

  const b = d?.bill;
  const pill = b ? STATUS_PILL[b.state.status] : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="w-full max-w-[540px] h-full bg-surface border-l border-line overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-surface px-5 py-4 border-b border-line-2 flex items-center gap-3 min-w-0">
          {b ? <BillLogo name={b.name} logo={b.logo} size={44} /> : <div className="w-11 h-11 rounded-lg bg-surface-2 animate-pulse" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-[16px] font-semibold text-ink truncate">{b?.name || "Bill"}</h3>
              {pill && <StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
            </div>
            {b && <div className="text-[12px] text-muted truncate">{cadenceLabel(b.cadence)}{b.method ? `, ${billMethodLabel(b.method)}` : ""}</div>}
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink p-1" aria-label="Close"><X size={16} /></button>
        </div>

        {error && !d && <div className="m-5 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">{error}</div>}

        {b && d && (
          <div className="p-5 space-y-6">
            {admin && (
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => onEdit(b)} className={btn}><Pencil size={12} /> Edit</button>
                {b.status === "archived"
                  ? <button disabled={busy === "arch"} onClick={() => act("arch", () => billsApi.archive(b.id, false), "Restored")} className={btn}><RotateCcw size={12} /> Restore</button>
                  : <button disabled={busy === "arch"} onClick={() => act("arch", () => billsApi.archive(b.id, true), "Archived. It stays under Archived on the Bills screen.")} className={btn}><Archive size={12} /> Archive</button>}
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
              <Fact label={amountText(b.amount, b.state.avg_amount, fmtAmount).average ? "Costs on average" : "Amount"}
                value={amountText(b.amount, b.state.avg_amount, fmtAmount).text}
                hint={b.amount > 0 && b.cadence !== "monthly" ? `About ${fmtAmount(b.monthly)} a month`
                  : b.amount <= 0 && b.state.last_amount != null
                    ? `${(b.state.avg_count ?? 0) > 0 ? `Average of the last ${b.state.avg_count} paid. ` : ""}Last paid ${fmtAmount(b.state.last_amount)}`
                    : undefined} />
              <Fact label={b.state.status === "overdue" ? "Overdue since" : "Next due"}
                value={b.state.status === "overdue" && b.state.overdue.length > 0 ? longDay(b.state.overdue[0]) : dueText(b.state.next_due, b.state.days_until)} />
              <Fact label="Shows in the bank as" value={b.payee_match} />
              <Fact label="Counts as a match" value={b.amount > 0 ? `Within ${b.tolerance_pct}% of the amount` : "Any amount"} />
              <Fact label="Category" value={b.category ? catLabel(b.category) : "None"} />
              <Fact label="Paid on time" value={b.state.paid_count > 0 ? `${b.state.on_time_count} of ${b.state.paid_count}` : "No payments yet"} />
              {b.state.extras_year > 0 && <Fact label="Extra charges in the last year" value={fmtAmount(b.state.extras_year)} />}
              {b.website && <Fact label="Website" value={b.website} />}
              {b.notes && <div className="col-span-2"><Fact label="Notes" value={b.notes} wrap /></div>}
            </dl>

            <section>
              <h4 className="text-[13px] font-semibold text-ink mb-2">Due dates</h4>
              {b.state.history.length === 0 ? (
                <p className="text-[12.5px] text-muted">No due dates yet. The first one is {longDay(b.anchor_date)}.</p>
              ) : (
                <div className="border border-line-2 rounded-xl overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-muted border-b border-line-2">
                        <th className="font-medium px-3 py-2">Due</th>
                        <th className="font-medium px-3 py-2">Paid on</th>
                        <th className="font-medium px-3 py-2 text-right">Amount</th>
                        <th className="font-medium px-3 py-2 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-2">
                      {b.state.history.map((p) => (
                        <tr key={p.due}>
                          <td className="px-3 py-2 text-ink whitespace-nowrap">{longDay(p.due)}</td>
                          <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{p.paid_on ? shortDay(p.paid_on) : "-"}</td>
                          <td className="px-3 py-2 text-ink-2 text-right tabular-nums">
                            {p.paid_on ? fmtAmount(p.paid_amount) : "-"}
                            {p.extra_amount > 0 && <div className="text-[11px] text-muted whitespace-nowrap">{extraNote(p.extra_amount, fmtAmount)}</div>}
                          </td>
                          <td className="px-3 py-2 text-right"><StatusPill tone={PERIOD_PILL[p.state].tone}>{PERIOD_PILL[p.state].label}</StatusPill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between gap-3 mb-2">
                <h4 className="text-[13px] font-semibold text-ink">Payments</h4>
                {admin && b.status === "active" && (
                  <button onClick={() => (pickOpen ? closePicker() : setPickOpen(true))} className={btn}>
                    <Link2 size={12} /> {pickOpen ? "Close the list" : "Link a payment"}
                  </button>
                )}
              </div>

              {pickOpen && (
                <div className="mb-3 border border-line rounded-xl bg-surface-2/40">
                  <div className="px-3 py-2 border-b border-line-2">
                    <input value={q} onChange={(e) => setQ(e.target.value)} className={inp} autoFocus
                      placeholder="Search payee, amount or date" aria-label="Search payments" />
                  </div>
                  <div className="px-3 py-2 text-[12px] text-muted border-b border-line-2">
                    {dq
                      ? "Every payment out of the bank that matches, newest first. One already on another bill is greyed out."
                      : "Recent payments out of the bank that no bill has claimed, closest matches first. Search to find a payment on any date."}
                  </div>
                  {pickError ? (
                    <div className="px-3 py-3 text-[12.5px] text-danger-ink">{pickError}</div>
                  ) : rows === null ? (
                    <div className="px-3 py-4 text-[12.5px] text-muted">Loading.</div>
                  ) : rows.length === 0 ? (
                    <div className="px-3 py-4 text-[12.5px] text-muted">
                      {dq ? "No payment out of the bank matches that." : "There are no unlinked payments from the last 120 days."}
                    </div>
                  ) : (
                    <div className="divide-y divide-line-2 max-h-72 overflow-y-auto">
                      {rows.map((t) => {
                        const taken = !!t.linked_to;
                        return (
                          <div key={t.id} className={`flex items-center gap-3 px-3 py-2 min-w-0 ${taken ? "opacity-60" : ""}`}>
                            <div className="min-w-0 flex-1">
                              <div className="text-[12.5px] text-ink truncate">{t.payee || "Unnamed payee"}</div>
                              <div className="text-[11px] text-muted truncate">{longDay(t.posted_at.slice(0, 10))}{t.memo ? `, ${t.memo}` : ""}</div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-[12.5px] text-ink tabular-nums">{fmtAmount(t.amount)}</div>
                              <div className="text-[11px] text-muted max-w-[9rem] truncate" title={taken ? `Already on ${t.linked_to}` : undefined}>
                                {taken ? `Already on ${t.linked_to}` : paysText(t.due)}
                              </div>
                            </div>
                            {!taken && (
                              <button disabled={busy === "l" + t.id}
                                onClick={() => act("l" + t.id, async () => { await billsApi.link(b.id, t.id); setRows((r) => (r || []).filter((x) => x.id !== t.id)); }, "Linked")}
                                className={btn}>Link</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {d.payments.length === 0 ? (
                <p className="text-[12.5px] text-muted">No payment is linked to this bill yet.</p>
              ) : (
                <div className="border border-line-2 rounded-xl divide-y divide-line-2">
                  {d.payments.map((p) => <PaymentRow key={p.id} p={p} admin={admin} busy={busy === p.id}
                    onUnlink={() => act(p.id, () => billsApi.reject(p.id), "Unlinked. Undo is next to it.")}
                    onUndo={() => act(p.id, () => billsApi.restore(p.id), "Linked again")} />)}
                </div>
              )}
            </section>
          </div>
        )}

        {!d && !error && (
          <div className="p-5 space-y-3">
            <div className="h-24 bg-surface-2 rounded-xl animate-pulse" />
            <div className="h-48 bg-surface-2 rounded-xl animate-pulse" />
          </div>
        )}
      </aside>
    </div>
  );
}

function Fact({ label, value, hint, wrap }: { label: string; value: string; hint?: string; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-muted">{label}</dt>
      <dd className={`text-[13px] text-ink mt-0.5 ${wrap ? "whitespace-pre-wrap break-words" : "truncate"}`} title={wrap ? undefined : value}>{value}</dd>
      {hint && <dd className="text-[11px] text-muted mt-0.5 tabular-nums">{hint}</dd>}
    </div>
  );
}

function PaymentRow({ p, admin, busy, onUnlink, onUndo }: {
  p: BillPayment; admin: boolean; busy: boolean; onUnlink: () => void; onUndo: () => void;
}) {
  const rejected = p.status === "rejected";
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 min-w-0">
      <div className={`min-w-0 flex-1 ${rejected ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2 min-w-0">
          <div className={`text-[12.5px] text-ink truncate ${rejected ? "line-through" : ""}`}>{p.payee || "Unnamed payee"}</div>
          {!rejected && p.extra && <StatusPill tone="neutral">Extra charge</StatusPill>}
        </div>
        <div className="text-[11px] text-muted truncate">
          {shortDay(p.posted_at.slice(0, 10))}
          {rejected ? ", unlinked" : p.status === "auto" ? ", matched automatically" : ", linked by hand"}
          {!rejected && !p.extra && p.period ? `, pays ${shortDay(p.period)}` : ""}
        </div>
      </div>
      <div className={`text-[12.5px] tabular-nums flex-shrink-0 ${rejected ? "text-muted line-through" : "text-ink"}`}>{fmtAmount(p.amount)}</div>
      {admin && (rejected
        ? <button disabled={busy} onClick={onUndo} className={btn}><RotateCcw size={12} /> Undo</button>
        : <button disabled={busy} onClick={onUnlink} className={btn}>Unlink</button>)}
    </div>
  );
}
