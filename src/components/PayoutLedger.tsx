import { Kpi } from "./ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, X } from "lucide-react";
import {
  api, type DealPayoutView, type PayeeKind, type PayoutLine, type PayoutPerson, type PayoutPersonDetail,
  type PayRulePerson, type PayType,
} from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { fmtDay } from "./LogisticsBookingForm";

// R-577: the commission ledger on the desktop. Every figure here comes from the server, which
// books what each person earned from each deal once and then only the differences (a refund, a
// typed amount), each saying why. Nothing here works pay out; it shows what /api/payouts answers
// and asks the server to change anything.

// A field with its own width takes `field`; `inp` fills its cell.
const field = "field-input h-9 text-[13px]";
const inp = `${field} w-full`;
const btn = "ui-btn";
const btnPrimary = "ui-btn ui-btn-ink";

const METHODS = ["Zelle", "ACH", "Check", "Cash", "Other"];
const KIND_LABEL: Record<PayeeKind, string> = { rep: "Rep", owner: "Owner", business: "Business", logistics: "Logistics" };
const PAY_TYPES: { value: PayType; label: string }[] = [
  { value: "profit_pct", label: "% of profit" },
  { value: "gross_pct", label: "% of the sale" },
  { value: "fixed", label: "$ a deal" },
];

const errText = (e: unknown) => (typeof e === "string" ? e : (e as any)?.message || String(e));
const near0 = (n: number) => Math.abs(n) < 0.005;

/** The rule as words, the same wording the server writes ("10% of profit", "$200.00 a deal"). */
export function ruleLabel(payType: string | undefined | null, value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  const plain = String(Math.round(v * 100) / 100);
  if (payType === "fixed") return `${fmtAmount(v)} a deal`;
  if (payType === "gross_pct") return `${plain}% of the sale`;
  return `${plain}% of profit`;
}

// ───────────────────────── one deal ─────────────────────────

/** What a line is, in words: the rule and share for a rep, the split share for an owner. */
function lineWhat(l: PayoutLine): string {
  if (l.kind === "rep") {
    const share = l.share_pct != null && l.share_pct < 99.995 ? `, ${l.share_pct}% share` : "";
    return `${l.rule || "No rule"}${share}`;
  }
  if (l.kind === "logistics") return l.pending ? "Logistics pay, not settled yet" : "Logistics pay, set on the Logistics pay screen";
  return l.share_pct != null ? `${l.share_pct}% of what is left` : "What is left";
}

/**
 * A deal's payouts: who gets what, from the server's engine, with the reps on the deal and any
 * amount typed over a line. Before the deal completes the lines are a projection from today's
 * rules. `fallback` is shown when the server cannot answer (offline, or not an admin).
 */
export function DealPayoutsBox({ dealFlowId, refreshKey, fallback }: { dealFlowId: string; refreshKey?: unknown; fallback?: ReactNode }) {
  const [view, setView] = useState<DealPayoutView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState<{ key: string; amount: number } | null>(null);
  const [editingReps, setEditingReps] = useState(false);

  const load = useCallback(async () => {
    try { setView(await api.payouts.deal(dealFlowId)); setErr(""); }
    catch (e) { setErr(errText(e)); }
  }, [dealFlowId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (!view) {
    // A screen that passes a fallback shows it (or nothing) when the server cannot answer.
    if (err) return fallback !== undefined ? <>{fallback}</> : <div className="text-[12.5px] text-warning-ink">{err}</div>;
    return null;
  }

  const run = async (f: () => Promise<{ problem?: string | null } | unknown>) => {
    setBusy(true);
    try {
      const r = await f();
      const problem = (r as any)?.problem;
      if (problem) toast(problem, "error");
      await load();
      return true;
    } catch (e) { toast(errText(e), "error"); return false; }
    finally { setBusy(false); }
  };
  const saveTyped = async (l: PayoutLine, amount: number | null) => {
    if (await run(() => api.payouts.setTyped(dealFlowId, l.kind, l.payee_id, amount))) setTyping(null);
  };

  const p = view.payout;
  const lines = p ? p.lines.filter((l) => !(l.kind === "logistics" && near0(l.amount) && !l.pending)) : [];
  return (
    <div className="border-t border-line pt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-medium text-ink">Payouts</div>
        {view.projected && <StatusPill tone="neutral" title="The deal has not completed, so nothing is booked yet.">Projected</StatusPill>}
      </div>
      {view.projected && (
        <div className="text-[12px] text-muted -mt-1.5">What today's rules would pay. It is booked when the deal completes.</div>
      )}
      {view.problem && <div className="text-[12.5px] text-warning-ink" role="alert">{view.problem}</div>}
      {err && (
        <div className="text-[12.5px] text-warning-ink" role="alert">
          These figures could not be refreshed and may be out of date. {err}{" "}
          <button type="button" onClick={load} className="underline font-medium">Try again</button>
        </div>
      )}

      <RepsField view={view} busy={busy} editing={editingReps} setEditing={setEditingReps}
        onSave={async (reps) => { if (await run(() => api.payouts.setReps(dealFlowId, reps))) setEditingReps(false); }} />

      {p && (
        <div className="divide-y divide-line border-t border-line">
          {lines.map((l) => {
            const key = `${l.kind}:${l.payee_id}`;
            const isTyping = typing?.key === key;
            return (
              <div key={key} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-ink">{l.name}</span>
                    {l.name !== KIND_LABEL[l.kind] && <StatusPill tone="neutral">{KIND_LABEL[l.kind]}</StatusPill>}
                    {l.typed && <StatusPill tone="accent" title="An amount was typed over the rule's figure.">Typed</StatusPill>}
                  </div>
                  <div className="text-[12px] text-muted mt-0.5">{lineWhat(l)}</div>
                  {l.typed && !isTyping && (
                    <div className="text-[12px] text-muted mt-0.5">
                      The rule says {fmtAmount(l.computed)}.{" "}
                      <button type="button" disabled={busy} onClick={() => saveTyped(l, null)} className="text-ink font-medium hover:underline disabled:opacity-50">Use the rule</button>
                    </div>
                  )}
                </div>
                {isTyping ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[12px] text-muted">$</span>
                    <NumberInput value={typing.amount} onValue={(n) => setTyping({ key, amount: n })} autoFocus
                      className={`${field} w-28 text-right tabular-nums`} />
                    <button type="button" disabled={busy} onClick={() => saveTyped(l, typing.amount)} className={btnPrimary}>Save</button>
                    <button type="button" onClick={() => setTyping(null)} className="h-9 w-8 flex items-center justify-center text-muted hover:text-ink" title="Cancel"><X size={14} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[14px] font-medium tabular-nums ${l.amount < -0.005 ? "text-danger-ink" : "text-ink"}`}>
                      {l.pending ? "Pending" : fmtAmount(l.amount)}
                    </span>
                    {l.kind !== "logistics" && (
                      <button type="button" disabled={busy} onClick={() => setTyping({ key, amount: l.amount })}
                        className="ui-ib disabled:opacity-50"
                        title="Type a different amount" aria-label={`Type a different amount for ${l.name}`}><Pencil size={14} /></button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {p.unallocated > 0.005 && (
            <div className="py-2.5 flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-warning-ink">Not given to anyone: no profit split is set up.</span>
              <span className="text-[14px] font-medium tabular-nums text-warning-ink">{fmtAmount(p.unallocated)}</span>
            </div>
          )}
          <div className="pt-2.5 flex items-center justify-between gap-3 text-[12.5px]">
            <span className="text-muted">Net profit{p.gross > 0 ? `, from a ${fmtAmount(p.gross)} sale` : ""}</span>
            <span className="tabular-nums font-medium text-ink">{fmtAmount(p.net)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The reps on a deal: none, one, or several splitting it by share. */
function RepsField({ view, busy, editing, setEditing, onSave }: {
  view: DealPayoutView; busy: boolean; editing: boolean; setEditing: (on: boolean) => void;
  onSave: (reps: { rep_id: string; share_pct: number }[]) => void;
}) {
  const [people, setPeople] = useState<PayRulePerson[] | null>(null);
  const [rows, setRows] = useState<{ rep_id: string; share_pct: number }[]>([]);

  const start = async () => {
    setRows(view.reps.map((r) => ({ rep_id: r.rep_id, share_pct: r.share_pct })));
    setEditing(true);
    if (!people) {
      try { setPeople((await api.payouts.rules()).people.filter((x) => !x.logistics_only)); }
      catch (e) { toast(errText(e), "error"); setEditing(false); }
    }
  };
  // A second rep splits the deal evenly; the shares can then be changed.
  const add = () => {
    const free = (people || []).find((x) => !rows.some((r) => r.rep_id === x.staff_id));
    if (!free) return;
    const n = rows.length + 1;
    const even = Math.floor((100 / n) * 100) / 100;
    const next = [...rows, { rep_id: free.staff_id, share_pct: 0 }].map((r) => ({ ...r, share_pct: even }));
    next[0].share_pct = Math.round((100 - even * (n - 1)) * 100) / 100;
    setRows(next);
  };
  const total = rows.reduce((a, r) => a + (Number(r.share_pct) || 0), 0);
  const adds = rows.length <= 1 || Math.abs(total - 100) < 0.01;

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-muted">{view.reps.length > 1 ? "Reps" : "Rep"}</div>
          <div className="text-[13px] text-ink mt-0.5">
            {view.reps.length === 0 ? "No rep"
              : view.reps.map((r) => (view.reps.length > 1 ? `${r.name} ${r.share_pct}%` : r.name)).join(", ")}
          </div>
          {view.reps.length > 0 && !view.reps_paid && (
            <div className="text-[12px] text-muted mt-0.5">Rep pay is off, so no rep is paid on this deal.</div>
          )}
        </div>
        <button type="button" disabled={busy} onClick={start} className={btn}>{view.reps.length ? "Change" : "Add a rep"}</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[12px] text-muted">{rows.length > 1 ? "Reps and their share of the deal" : "Rep"}</div>
      {people === null && <div className="text-[12.5px] text-muted">Loading...</div>}
      {people !== null && rows.length === 0 && <div className="text-[13px] text-ink">No rep</div>}
      {people !== null && rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select className={`${field} flex-1 min-w-0`} value={r.rep_id}
            onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rep_id: e.target.value } : x)))}>
            {people.filter((x) => x.staff_id === r.rep_id || !rows.some((y) => y.rep_id === x.staff_id)).map((x) => (
              <option key={x.staff_id} value={x.staff_id}>{x.name}</option>
            ))}
          </select>
          {rows.length > 1 && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <NumberInput value={r.share_pct} onValue={(n) => setRows(rows.map((x, j) => (j === i ? { ...x, share_pct: n } : x)))}
                className={`${field} w-20 text-right tabular-nums`} aria-label="Share" />
              <span className="text-[12px] text-muted">%</span>
            </div>
          )}
          <button type="button" onClick={() => setRows(rows.length === 2 ? rows.filter((_, j) => j !== i).map((x) => ({ ...x, share_pct: 100 })) : rows.filter((_, j) => j !== i))}
            className="h-9 w-8 flex items-center justify-center text-muted hover:text-danger-ink flex-shrink-0" title="Take off this deal"><X size={14} /></button>
        </div>
      ))}
      {rows.length > 1 && !adds && (
        <div className="text-[12px] text-warning-ink">The shares add up to {Math.round(total * 100) / 100}%. They must come to 100%.</div>
      )}
      {!view.reps_paid && rows.length > 0 && (
        <div className="text-[12px] text-muted">Rep pay is off. Reps you set here are paid on this deal.</div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {people !== null && people.some((x) => !rows.some((r) => r.rep_id === x.staff_id)) && (
          <button type="button" onClick={rows.length === 0 ? () => setRows([{ rep_id: people[0].staff_id, share_pct: 100 }]) : add} className={btn}>
            <Plus size={14} /> {rows.length === 0 ? "Add a rep" : "Add another rep"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setEditing(false)} className={btn}>Cancel</button>
          <button type="button" disabled={busy || people === null || !adds}
            onClick={() => onSave(rows.length === 1 ? [{ rep_id: rows[0].rep_id, share_pct: 100 }] : rows)} className={btnPrimary}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── everyone ─────────────────────────

/** The Payouts screen: one row per person (reps, owners, the business) with what they earned,
 *  were paid and are owed; open one to see their deals and payments, pay them, or undo. */
export function PayoutsLedgerPanel() {
  const [data, setData] = useState<{ people: PayoutPerson[]; problems: { deal_flow_id?: string; error?: string }[]; ledger_since: string | null } | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<{ kind: PayeeKind; id: string } | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.payouts.people()); setErr(""); }
    catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (open) {
    return <PersonLedger kind={open.kind} id={open.id} since={data?.ledger_since || null} onBack={() => { setOpen(null); load(); }} />;
  }
  if (!data) {
    return err
      ? <div className="text-[12.5px] text-warning-ink" role="alert">{err} <button type="button" onClick={load} className="underline font-medium">Try again</button></div>
      : <div className="text-[12.5px] text-muted">Loading...</div>;
  }
  const people = data.people;
  return (
    <div className="space-y-4">
      {data.ledger_since && (
        <div className="ui-note">
          The ledger started on {fmtDay(data.ledger_since)}. Deals from before then were worked out afterwards, at the rates in force then.
        </div>
      )}
      {data.problems.length > 0 && (
        <div className="text-[12.5px] text-warning-ink" role="alert">
          {data.problems.length === 1 ? "One deal" : `${data.problems.length} deals`} could not be worked out: {data.problems.map((p) => p.error).filter(Boolean).slice(0, 2).join(" ")}
        </div>
      )}
      {people.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)] max-w-[720px]">
          <Kpi label="Earned" value={people.reduce((n, p) => n + p.earned, 0)} format={fmtAmount} />
          <div className="vsep" />
          <Kpi label="Paid" value={people.reduce((n, p) => n + p.paid, 0)} format={fmtAmount} className="text-success-ink" />
          <div className="vsep" />
          <Kpi label="Owed" value={people.reduce((n, p) => n + p.balance, 0)} format={fmtAmount} />
        </div>
      )}
      {people.length === 0 ? (
        <div className="text-[12.5px] text-muted py-4 text-center">No one has earned anything yet. Lines appear here once a deal completes.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui-table ui-table-click min-w-[560px]">
            <thead>
              <tr>
                {["Name", "Deals", "Earned", "Paid", "Owed", ""].map((h, i) => (
                  <th key={i} className={i >= 2 ? "r" : ""}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={`${p.kind}:${p.payee_id}`} onClick={() => setOpen({ kind: p.kind, id: p.payee_id })}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{p.name}</span>
                      {p.name !== KIND_LABEL[p.kind] && <StatusPill tone="neutral">{KIND_LABEL[p.kind]}</StatusPill>}
                    </div>
                  </td>
                  <td className="text-muted tabular-nums">{p.deals}</td>
                  <td className="r text-muted">{fmtAmount(p.earned)}</td>
                  <td className="r text-muted">{fmtAmount(p.paid)}</td>
                  <td className={`r font-medium ${p.balance < -0.005 ? "text-danger-ink" : "text-ink"}`}>{fmtAmount(p.balance)}</td>
                  <td className="r text-faint"><ChevronRight size={16} className="inline" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {err && <div className="text-[12px] text-warning-ink">{err}</div>}
    </div>
  );
}

const REASON: Record<string, { label: string; title: string }> = {
  earned: { label: "Earned", title: "Booked when the deal completed." },
  backfilled: { label: "Worked out afterwards", title: "A deal from before the ledger started, worked out at the rates in force then." },
  adjusted: { label: "Change", title: "The deal changed after it was booked." },
};

function PersonLedger({ kind, id, since, onBack }: { kind: PayeeKind; id: string; since: string | null; onBack: () => void }) {
  const [d, setD] = useState<PayoutPersonDetail | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState(0);
  const [paidOn, setPaidOn] = useState(localDay());
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const got = await api.payouts.person(kind, id);
      setD(got);
      setAmount(got.balance > 0.005 ? got.balance : 0);
      setErr("");
    } catch (e) { setErr(errText(e)); }
  }, [kind, id]);
  useEffect(() => { load(); }, [load]);

  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await f(); toast(done); await load(); }
    catch (e) { toast(errText(e), "error"); }
    setBusy(false);
  };

  const back = (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
      <ChevronLeft size={14} /> Everyone
    </button>
  );
  if (!d) {
    return (
      <div className="space-y-3">
        {back}
        {err ? <div className="text-[12.5px] text-warning-ink" role="alert">{err}</div> : <div className="text-[12.5px] text-muted">Loading...</div>}
      </div>
    );
  }

  const pay = () => {
    if (!(amount > 0.005)) { toast("Type how much was paid.", "error"); return; }
    if (!confirm(`Record ${fmtAmount(amount)} paid to ${d.name} on ${fmtDay(paidOn)}${method ? ` by ${method}` : ""}?`)) return;
    act(() => api.payouts.pay(d.kind, d.payee_id, amount, paidOn, method, note.trim()), "Payment recorded").then(() => setNote(""));
  };
  const settle = () => {
    if (!confirm(`Count ${fmtAmount(d.before_ledger)} earned before ${since ? fmtDay(since) : "the ledger started"} as already paid to ${d.name}? You can undo this.`)) return;
    act(() => api.payouts.settleBefore(d.kind, d.payee_id), "Counted as paid");
  };

  return (
    <div className="space-y-5">
      {back}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-medium text-ink">{d.name || "Unknown"}</span>
            {d.name !== KIND_LABEL[d.kind] && <StatusPill tone="neutral">{KIND_LABEL[d.kind]}</StatusPill>}
          </div>
          <div className="flex items-baseline gap-3 mt-1.5 flex-wrap">
            <span className={`ui-fig ${d.balance < -0.005 ? "text-danger-ink" : "text-ink"}`}>{fmtAmount(Math.abs(d.balance))}</span>
            <span className="text-[13px] text-ink-2">{d.balance < -0.005 ? "paid ahead" : "owed"}</span>
          </div>
          <div className="text-[12.5px] text-muted mt-1.5">
            Earned {fmtAmount(d.earned)} on {d.deals} {d.deals === 1 ? "deal" : "deals"}, paid {fmtAmount(d.paid)}.
          </div>
          {d.balance < -0.005 && (
            <div className="text-[12.5px] text-danger-ink mt-1">Paid more than earned, after a refund or a change. It comes off the next payment.</div>
          )}
        </div>
      </div>

      {d.before_ledger > 0.005 && (
        <div className="border-y border-line py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[12.5px] text-ink-2 min-w-0">
            {fmtAmount(d.before_ledger)} of this was earned before the ledger started{since ? ` on ${fmtDay(since)}` : ""}. If it was paid outside the app, count it as paid.
          </div>
          <button type="button" disabled={busy} onClick={settle} className={btn}>Count as paid</button>
        </div>
      )}

      <div className="space-y-3">
        <div className="hsep" />
        <div className="text-[14px] font-medium text-ink">Record a payment</div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">Amount</label>
            <NumberInput value={amount || ""} onValue={(n) => setAmount(n)} className={`${inp} text-right tabular-nums`} />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">Day paid</label>
            <input type="date" value={paidOn} max={localDay()} onChange={(e) => setPaidOn(e.target.value)} className={inp} />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">Paid with</label>
            <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">Not set</option>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1.5">Note</label>
            <input className={inp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" disabled={busy || !(amount > 0.005)} onClick={pay} className={btnPrimary}>Record payment</button>
        </div>
      </div>

      <div>
        <div className="hsep mb-4" />
        <div className="text-[14px] font-medium text-ink mb-2">Payments</div>
        {d.payments.length === 0 ? (
          <div className="text-[12.5px] text-muted">None recorded.</div>
        ) : (
          <div className="divide-y divide-line border-y border-line">
            {[...d.payments].reverse().map((p) => (
              <div key={p.id} className={`py-2.5 flex items-center justify-between gap-3 ${p.undone ? "opacity-60" : ""}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[13px] font-medium tabular-nums text-ink ${p.undone ? "line-through" : ""}`}>{fmtAmount(p.amount)}</span>
                    <span className="text-[12.5px] text-ink-2">{fmtDay(p.paid_on)}</span>
                    {p.method === "settled"
                      ? <StatusPill tone="neutral">Counted as paid</StatusPill>
                      : p.method ? <span className="text-[12.5px] text-muted">{p.method}</span> : null}
                    {p.undone && <StatusPill tone="warning">Undone</StatusPill>}
                  </div>
                  {(p.note || p.recorded_by) && (
                    <div className="text-[12px] text-muted mt-0.5">{[p.note, p.recorded_by ? `Recorded by ${p.recorded_by}` : ""].filter(Boolean).join(". ")}</div>
                  )}
                </div>
                {p.undone ? (
                  <button type="button" disabled={busy} onClick={() => act(() => api.payouts.restore(p.id), "Payment restored")} className={btn}>Restore</button>
                ) : (
                  <button type="button" disabled={busy}
                    onClick={() => { if (confirm(`Undo the ${fmtAmount(p.amount)} payment on ${fmtDay(p.paid_on)}? What it covered is owed again.`)) act(() => api.payouts.undo(p.id), "Payment undone"); }}
                    className={btn}>Undo</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="hsep mb-4" />
        <div className="text-[14px] font-medium text-ink mb-2">Deals</div>
        {d.lines.length === 0 ? (
          <div className="text-[12.5px] text-muted">Nothing earned yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="ui-table ui-table-sm min-w-[620px]">
              <thead>
                <tr>
                  {["Day", "Deal", "How", "Amount"].map((h, i) => (
                    <th key={h} className={i === 3 ? "r" : ""}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...d.lines].reverse().map((l) => {
                  const r = REASON[l.reason] || REASON.adjusted;
                  const how = l.reason === "adjusted"
                    ? l.note || "Changed after it was booked"
                    : [l.rule, l.share_pct != null && l.share_pct < 99.995 ? `${l.share_pct}% share` : "", l.typed ? `typed, the rule said ${fmtAmount(l.computed ?? 0)}` : ""].filter(Boolean).join(", ");
                  return (
                    <tr key={l.id}>
                      <td className="text-muted whitespace-nowrap">{fmtDay(l.on_day)}</td>
                      <td>
                        <div className="text-ink">{l.invoice_number || "Deal"}{l.client ? `, ${l.client}` : ""}</div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusPill tone={l.reason === "adjusted" ? "warning" : "neutral"} title={r.title}>{r.label}</StatusPill>
                          {how && <span className="ui-note">{how}</span>}
                        </div>
                      </td>
                      <td className={`r font-medium ${l.amount < -0.005 ? "text-danger-ink" : "text-ink"}`}>{fmtAmount(l.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── pay rules ─────────────────────────

/** Each person's pay rule, from the server. A change starts today: deals already done keep the
 *  rule they were booked on. People on a Logistics-only account are paid on the Logistics pay
 *  screen and are not listed. */
export function PayRulesPanel({ onSaved }: { onSaved?: () => void }) {
  const [people, setPeople] = useState<PayRulePerson[] | null>(null);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Record<string, { pay_type: PayType; value: number }>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setPeople((await api.payouts.rules()).people.filter((p) => !p.logistics_only)); setErr(""); }
    catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!people) {
    return err
      ? <div className="text-[12.5px] text-warning-ink" role="alert">{err} <button type="button" onClick={load} className="underline font-medium">Try again</button></div>
      : <div className="text-[12.5px] text-muted">Loading...</div>;
  }
  if (people.length === 0) return <div className="text-[12.5px] text-muted">No team members yet, invite people from the Team tab.</div>;

  const save = async (p: PayRulePerson) => {
    const d = draft[p.staff_id];
    if (!d) return;
    setBusy(p.staff_id);
    try {
      await api.payouts.saveRule(p.staff_id, d.pay_type, d.value);
      toast(`${p.name}: ${ruleLabel(d.pay_type, d.value)} from today`);
      setDraft((m) => { const n = { ...m }; delete n[p.staff_id]; return n; });
      await load();
      onSaved?.();
    } catch (e) { toast(errText(e), "error"); }
    setBusy("");
  };

  return (
    <div className="divide-y divide-line">
      {people.map((p) => {
        const now = p.rule_now || { pay_type: "profit_pct" as PayType, value: 0, label: ruleLabel("profit_pct", 0) };
        const d = draft[p.staff_id] || { pay_type: now.pay_type, value: now.value };
        const changed = d.pay_type !== now.pay_type || Math.abs(d.value - now.value) > 0.004;
        const latest = p.rules.length ? p.rules[p.rules.length - 1] : null;
        const earlier = p.rules.length > 1 ? p.rules[p.rules.length - 2] : null;
        return (
          <div key={p.staff_id} className="py-3 first:pt-0 last:pb-0 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{p.name}</div>
                <div className="text-[12px] text-muted">
                  {now.label}
                  {latest && latest.from_day !== "1970-01-01" ? ` since ${fmtDay(latest.from_day)}` : ""}
                  {earlier ? `, was ${earlier.label}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <select className={`${field} w-36`} value={d.pay_type}
                  onChange={(e) => setDraft((m) => ({ ...m, [p.staff_id]: { ...d, pay_type: e.target.value as PayType } }))}>
                  {PAY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <NumberInput value={d.value} onValue={(n) => setDraft((m) => ({ ...m, [p.staff_id]: { ...d, value: n } }))}
                  className={`${field} w-24 text-right tabular-nums`} aria-label={`${p.name} rate`} />
                <button type="button" disabled={!changed || busy === p.staff_id} onClick={() => save(p)} className={btnPrimary}>Save</button>
              </div>
            </div>
            {changed && (
              <div className="text-[12px] text-muted">{ruleLabel(d.pay_type, d.value)} from today. Deals already done keep the rate they had.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
