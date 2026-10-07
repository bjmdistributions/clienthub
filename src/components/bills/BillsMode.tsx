// R-449: the Bills mode of the Bills screen. A band of four figures, what Ecliptr found in the
// bank that looks like a bill, the month as a strip of due dates, then one card per bill.
import { useMemo, useState } from "react";
import { Check, HandCoins, Plus, RotateCcw, Truck } from "lucide-react";
import StatusPill from "../StatusPill";
import { fmtAmount } from "../../lib/format";
import type { BillCandidate, BillOut, BillsList, UpcomingDue } from "../../lib/billsApi";
import { amountText,
  PERIOD_PILL, STATUS_PILL, billMethodLabel, cadenceLabel, chipState, daysInMonth, dueText, longDay,
  monthTitle, shortDay, type ChipState,
} from "../../lib/billsFormat";
import type { LogisticsMark } from "../../lib/logisticsBills";
import { BillLogo, Card, Tile, btn, pri } from "./ui";

const count = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

interface Props {
  data: BillsList;
  cands: BillCandidate[];
  admin: boolean;
  /** R-464: the logistics pay dates and carrier due dates of this month, drawn on the month strip. */
  marks: LogisticsMark[];
  onMark: (m: LogisticsMark) => void;
  /** R-464: false for a mark this reader cannot open (the pay tracker is the owner's); it is drawn but not clickable. */
  markOpens?: (m: LogisticsMark) => boolean;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onTrack: (c: BillCandidate) => void;
  onIgnore: (c: BillCandidate) => void;
  onRestore: (b: BillOut) => void;
}

export default function BillsMode({ data, cands, admin, marks, onMark, markOpens, onOpen, onAdd, onTrack, onIgnore, onRestore }: Props) {
  const s = data.summary;
  const active = data.bills.filter((b) => b.status === "active");
  const archived = data.bills.filter((b) => b.status === "archived");

  if (active.length === 0 && archived.length === 0 && cands.length === 0) {
    return (
      <div className="space-y-4">
        {marks.length > 0 && <MonthStrip today={data.today} upcoming={data.upcoming} bills={active} marks={marks} onMark={onMark} markOpens={markOpens} onOpen={onOpen} />}
        <div className="bg-surface border border-line rounded-2xl py-14 px-6 flex flex-col items-center text-center">
          <div className="text-[14px] font-semibold text-ink">No bills yet</div>
          <p className="text-[12.5px] text-muted mt-1 max-w-[420px]">
            Add rent, insurance or a car note. Ecliptr watches your bank for the payment and tells you when one is late.
          </p>
          {admin && <button onClick={onAdd} className={pri + " mt-4"}><Plus size={14} /> Add a bill</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-2xl overflow-hidden">
        <div className="grid grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-line-2">
          <Tile label="Due in the next 30 days" value={fmtAmount(s.due_30_total)}
            sub={count(s.due_30_count, "bill") + (s.due_soon_count > 0 ? `, ${s.due_soon_count} due soon` : "")} />
          <Tile label="Every month" value={fmtAmount(s.monthly_total)} sub={count(s.active, "active bill")} />
          <Tile label="Overdue"
            value={s.overdue_count > 0 ? fmtAmount(s.overdue_total) : "Nothing overdue"}
            valueCls={s.overdue_count > 0 ? "text-danger-ink" : "text-ink"}
            sub={s.overdue_count > 0 ? count(s.overdue_count, "bill") + " past due" : data.feed_latest ? `Bank feed to ${shortDay(data.feed_latest)}` : "No bank feed yet"}
            className="border-t border-line-2 xl:border-t-0" />
          <Tile label="Paid this month" value={`${s.paid_this_month} of ${s.expected_this_month}`}
            sub={s.expected_this_month === 0 ? "Nothing falls due" : "Due dates matched to a payment"}
            className="border-t border-line-2 xl:border-t-0" />
        </div>
      </div>

      {cands.length > 0 && <Found cands={cands} admin={admin} onTrack={onTrack} onIgnore={onIgnore} />}

      {(active.length > 0 || marks.length > 0) && <MonthStrip today={data.today} upcoming={data.upcoming} bills={active} marks={marks} onMark={onMark} markOpens={markOpens} onOpen={onOpen} />}

      {active.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {active.map((b) => <BillCard key={b.id} bill={b} onOpen={onOpen} />)}
        </div>
      )}

      {archived.length > 0 && (
        <Card title="Archived" sub="Kept for the history. A restored bill picks its payments up again.">
          <div className="divide-y divide-line-2">
            {archived.map((b) => (
              <div key={b.id} className="flex items-center gap-3 px-5 py-2.5 min-w-0 hover:bg-surface-2/40 transition-colors">
                <button onClick={() => onOpen(b.id)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                  <BillLogo name={b.name} logo={b.logo} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink truncate">{b.name}</span>
                    <span className="block text-[11px] text-muted truncate">{cadenceLabel(b.cadence)}</span>
                  </span>
                  <span className="text-[13px] tabular-nums text-ink-2 flex-shrink-0">
                    {amountText(b.amount, b.state.avg_amount, fmtAmount).text}
                    {amountText(b.amount, b.state.avg_amount, fmtAmount).average && <span className="text-[11px] font-medium text-muted ml-1">avg</span>}
                  </span>
                </button>
                {admin && <button onClick={() => onRestore(b)} className={btn}><RotateCcw size={12} /> Restore</button>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- found in your bank

function Found({ cands, admin, onTrack, onIgnore }: {
  cands: BillCandidate[]; admin: boolean; onTrack: (c: BillCandidate) => void; onIgnore: (c: BillCandidate) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? cands : cands.slice(0, 3);
  return (
    <Card title="Found in your bank" sub="Payments that repeat on a schedule and are not tracked yet">
      <div className="divide-y divide-line-2">
        {shown.map((c) => (
          <div key={c.key} className="flex items-center gap-3 px-5 py-3 min-w-0">
            <BillLogo name={c.name} size={36} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
              <div className="text-[11.5px] text-muted">{c.why}</div>
            </div>
            <div className="text-right flex-shrink-0 hidden sm:block">
              <div className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(c.amount)}</div>
              <div className="text-[11px] text-muted">{cadenceLabel(c.cadence)}</div>
            </div>
            {admin && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button onClick={() => onTrack(c)} className="bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors whitespace-nowrap">
                  Track it
                </button>
                <button onClick={() => onIgnore(c)} className="border border-line text-muted hover:text-ink hover:bg-surface-2 px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors whitespace-nowrap">
                  Not a bill
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {cands.length > 3 && (
        <button onClick={() => setAll((v) => !v)} className="w-full px-5 py-2.5 text-left text-[12px] text-accent font-medium border-t border-line-2 hover:bg-surface-2/40 transition-colors">
          {all ? "Show fewer" : `Show ${cands.length - 3} more`}
        </button>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------- this month strip

const RING: Record<ChipState, string> = {
  paid: "",
  overdue: "ring-2 ring-danger",
  soon: "ring-2 ring-warning",
  plain: "",
};

/** The cell for a logistics mark: a small square with the pay-date or truck icon, ringed the way a bill chip is. */
function MarkChip({ m, onMark, opens = true }: { m: LogisticsMark; onMark: (m: LogisticsMark) => void; opens?: boolean }) {
  const Icon = m.kind === "pay" ? HandCoins : Truck;
  const Wrap = opens ? "button" : "span";
  return (
    <Wrap {...(opens ? { onClick: () => onMark(m) } : {})} title={m.title} aria-label={m.title}
      className={`relative rounded-[10px] p-[2px] ${RING[m.state]} ${m.state === "paid" ? "opacity-50 hover:opacity-100" : ""} transition-opacity`}>
      <span className="w-[22px] h-[22px] rounded-lg bg-surface-3 text-ink-2 flex items-center justify-center">
        <Icon size={13} strokeWidth={2} />
      </span>
      {m.state === "paid" && (
        <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-success-bg text-success-ink ring-1 ring-success/30 flex items-center justify-center">
          <Check size={9} strokeWidth={3} />
        </span>
      )}
    </Wrap>
  );
}

function MonthStrip({ today, upcoming, bills, marks, onMark, markOpens, onOpen }: {
  today: string; upcoming: UpcomingDue[]; bills: BillOut[]; marks: LogisticsMark[]; onMark: (m: LogisticsMark) => void; markOpens?: (m: LogisticsMark) => boolean; onOpen: (id: string) => void;
}) {
  const days = daysInMonth(today);
  const month = today.slice(0, 7);
  const byId = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  const perDay = useMemo(() => {
    const m = new Map<number, UpcomingDue[]>();
    for (const u of upcoming) {
      if (!u.due.startsWith(month) || !byId.has(u.bill_id)) continue;
      const d = +u.due.slice(8, 10);
      m.set(d, [...(m.get(d) || []), u]);
    }
    return m;
  }, [upcoming, byId, month]);
  const marksPerDay = useMemo(() => {
    const m = new Map<number, LogisticsMark[]>();
    for (const k of marks) m.set(k.day, [...(m.get(k.day) || []), k]);
    return m;
  }, [marks]);
  const todayN = +today.slice(8, 10);
  const hasPay = marks.some((k) => k.kind === "pay");
  const hasCarrier = marks.some((k) => k.kind === "carrier");

  return (
    <Card title={monthTitle(today)} sub="Every due date this month"
      right={
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded ring-2 ring-warning" /> Due soon</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded ring-2 ring-danger" /> Overdue</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-surface-3 flex items-center justify-center text-success-ink"><Check size={9} /></span> Paid</span>
          {hasPay && <span className="inline-flex items-center gap-1.5"><HandCoins size={12} /> Logistics pay</span>}
          {hasCarrier && <span className="inline-flex items-center gap-1.5"><Truck size={12} /> Carrier due</span>}
        </div>
      }>
      {perDay.size === 0 && marks.length === 0 ? (
        <div className="px-5 py-8 text-[13px] text-muted text-center">Nothing falls due this month.</div>
      ) : (
        <div className="overflow-x-auto">
          {/* 28px a day is the least a chip (22px logo, 2px padding, a 2px ring) fits in; below that the strip scrolls. */}
          <div className="grid" style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))`, minWidth: days * 28 }}>
            {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
              const items = perDay.get(d) || [];
              const dayMarks = marksPerDay.get(d) || [];
              // Up to three bill chips, then the logistics marks, four cells in all; the rest is counted.
              const shown = items.slice(0, 3);
              const shownMarks = dayMarks.slice(0, Math.max(0, 4 - shown.length));
              const more = items.length - shown.length + dayMarks.length - shownMarks.length;
              return (
                <div key={d} className={`min-h-[78px] py-2 flex flex-col items-center gap-1.5 border-l border-line-2 first:border-l-0 ${d === todayN ? "bg-accent/5" : ""}`}>
                  <span className={`text-[10px] tabular-nums leading-none ${d === todayN ? "text-accent-hover font-bold" : d < todayN ? "text-faint" : "text-muted"}`}>{d}</span>
                  {shown.map((u) => {
                    const b = byId.get(u.bill_id)!;
                    const st = chipState(u, b.state.overdue, today);
                    return (
                      <button key={u.bill_id + u.due} onClick={() => onOpen(b.id)}
                        title={`${b.name}, ${longDay(u.due)}${u.amount > 0 ? ", " + fmtAmount(u.amount) : ""}${st === "paid" ? ", paid" : st === "overdue" ? ", overdue" : ""}`}
                        className={`relative rounded-[10px] p-[2px] ${RING[st]} ${st === "paid" ? "opacity-50 hover:opacity-100" : ""} transition-opacity`}>
                        <BillLogo name={b.name} logo={b.logo} size={22} />
                        {st === "paid" && (
                          <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-success-bg text-success-ink ring-1 ring-success/30 flex items-center justify-center">
                            <Check size={9} strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {shownMarks.map((m) => <MarkChip key={m.key} m={m} onMark={onMark} opens={markOpens ? markOpens(m) : true} />)}
                  {more > 0 && <span className="text-[10px] text-muted tabular-nums">+{more}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------- bill card

const DOT: Record<string, string> = {
  paid: "bg-success",
  late: "bg-warning",
  missed: "bg-danger",
  due: "bg-surface-3 ring-1 ring-line",
};

function BillCard({ bill: b, onOpen }: { bill: BillOut; onOpen: (id: string) => void }) {
  const st = b.state;
  const pill = STATUS_PILL[st.status];
  const dots = st.history.slice(0, 6).reverse();
  const when = st.status === "overdue" && st.overdue.length > 0
    ? `Was due ${shortDay(st.overdue[0])}${st.overdue.length > 1 ? `, ${st.overdue.length - 1} more` : ""}`
    : dueText(st.next_due, st.days_until);
  return (
    <button onClick={() => onOpen(b.id)}
      className="text-left bg-surface border border-line rounded-2xl p-4 min-w-0 flex flex-col gap-3.5 hover:border-line-3 hover:bg-surface-2/40 transition-colors">
      <div className="flex items-start gap-3 min-w-0">
        <BillLogo name={b.name} logo={b.logo} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink truncate">{b.name}</div>
          <div className="text-[11.5px] text-muted truncate">
            {cadenceLabel(b.cadence)}{b.method ? `, ${billMethodLabel(b.method)}` : ""}
          </div>
        </div>
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>

      <div className="flex items-end justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-[22px] font-bold text-ink tabular-nums leading-none truncate">
            {amountText(b.amount, st.avg_amount, fmtAmount).text}
            {amountText(b.amount, st.avg_amount, fmtAmount).average && <span className="text-[12px] font-medium text-muted ml-1.5">avg</span>}
          </div>
          {b.amount <= 0 && st.last_amount != null && (
            <div className="text-[11px] text-muted mt-1.5 tabular-nums truncate">Last paid {fmtAmount(st.last_amount)}</div>
          )}
        </div>
        <div className="text-right min-w-0">
          <div className="text-[11px] text-muted">{st.status === "overdue" ? "Overdue" : "Next due"}</div>
          <div className={`text-[12.5px] font-medium truncate ${st.status === "overdue" ? "text-danger-ink" : "text-ink"}`}>{when}</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-line-2 min-w-0">
        {dots.length === 0 ? (
          <span className="text-[11px] text-faint">No payments seen yet</span>
        ) : (
          <>
            <div className="flex items-center gap-1.5" aria-label="Last payments">
              {dots.map((p) => (
                <span key={p.due} className={`w-2.5 h-2.5 rounded-full ${DOT[p.state]}`}
                  title={`${longDay(p.due)}: ${PERIOD_PILL[p.state].label}${p.paid_on ? ` on ${shortDay(p.paid_on)}` : ""}`} />
              ))}
            </div>
            <span className="text-[11px] text-muted tabular-nums truncate">
              {st.paid_count > 0 ? `${st.on_time_count} of ${st.paid_count} on time` : "None paid yet"}
            </span>
          </>
        )}
      </div>
    </button>
  );
}
