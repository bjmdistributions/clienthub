import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api, AccountStatementData, StatementLine, StatementPoint } from "../lib/api";
import { fmtAmount } from "../lib/format";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-667 (Jack, 2026-11-17): "my book is wrong on all balances. it doesn't give me a way to identify or scan through
// and cross check to see what the discrepancy is. This is important to always be accurate."
// One account as a statement: every posted transaction, newest first, with the balance after it, counted back from
// what the bank says today. Held beside the bank's own site, the balance on any day must match. A day he reads off the
// bank's site is kept (and an imported statement's ending is held the same way); the newest day that differs and the
// day above it that agrees bracket the fault, and the screen says so.

const FIELD = "border border-line-3 rounded-lg h-8 px-2.5 text-[13px] text-ink bg-surface focus:outline-none focus:border-accent";
const PAGE = 300;

const longDay = (d: string) => /^\d{4}-\d\d-\d\d$/.test(d)
  ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
  : "No date";
const monthName = (m: string) =>
  new Date(m + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });

/** What a person typed for a balance: "$1,234.56", "-40", "(40.00)". Null when it is not a number. */
export function parseMoney(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/[$\s]/g, ""));
  const n = Number(t.replace(/[$,\s()-]/g, ""));
  if (!Number.isFinite(n) || !/\d/.test(t)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

export interface StatementDay { date: string; end: number; point: StatementPoint | null; lines: StatementLine[] }

/**
 * The statement as days, newest first. `end` is the balance at the end of the day whatever the filter hides, and a
 * checked day with no transaction of its own still gets its line (unless a filter is on).
 */
export function statementDays(lines: StatementLine[], points: StatementPoint[], keep: (l: StatementLine) => boolean, filtered: boolean): StatementDay[] {
  const ends = new Map<string, number>();
  for (const l of lines) if (!ends.has(l.date) && l.balance != null) ends.set(l.date, l.balance);
  const byDate = new Map<string, StatementDay>();
  const point = (d: string) => points.find((p) => p.date === d) ?? null;
  for (const l of lines) {
    if (!keep(l)) continue;
    let day = byDate.get(l.date);
    if (!day) { day = { date: l.date, end: ends.get(l.date) ?? 0, point: point(l.date), lines: [] }; byDate.set(l.date, day); }
    day.lines.push(l);
  }
  if (!filtered) {
    for (const p of points) if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, end: p.books, point: p, lines: [] });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export default function AccountStatement({ account, name, card, onClose, onOpenRow }: {
  /** The account's label, as the books hold it. */
  account: string;
  name: string;
  /** A credit card: every balance is what is owed. */
  card: boolean;
  onClose: () => void;
  onOpenRow?: (id: string, amount: number) => void;
}) {
  const [x, setX] = useState<AccountStatementData | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState("");
  const [onlyWindow, setOnlyWindow] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [editing, setEditing] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [openList, setOpenList] = useState<"" | "pending" | "withdrawn">("");

  useEffect(() => {
    setX(null); setErr("");
    api.accountStatement(account, card).then(setX).catch((e: unknown) => setErr(String((e as Error)?.message || e)));
  }, [account, card]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A card's balance is what is owed, so it reads the other way round from the books' sign.
  const bal = (n: number) => fmtAmount(card ? -n : n);
  const months = useMemo(() => [...new Set((x?.lines ?? []).map((l) => l.date.slice(0, 7)).filter((m) => m.length === 7))], [x]);
  const copies = useMemo(() => new Set(x?.copies ?? []), [x]);
  const same = useMemo(() => new Set(x?.window?.same_amount ?? []), [x]);
  const w = x?.window ?? null;
  const needle = q.trim().toLowerCase();
  const filtered = !!needle || !!month || onlyWindow;
  const days = useMemo(() => {
    if (!x) return [];
    const keep = (l: StatementLine) =>
      (!month || l.date.startsWith(month))
      && (!onlyWindow || !w || (l.date > w.after && (!w.through || l.date <= w.through)))
      && (!needle || l.description.toLowerCase().includes(needle) || l.amount.toFixed(2).includes(needle.replace(/[$,]/g, "")));
    return statementDays(x.lines, x.points, keep, filtered);
  }, [x, month, onlyWindow, needle, filtered, w]);

  const save = async (date: string, balance: number | null) => {
    setBusy(true);
    try {
      // He types what the bank's site shows; for a card that is what was owed.
      setX(await api.accountStatementMark(account, date, balance == null ? null : card ? -balance : balance, card));
      setEditing(null); setTyped("");
    } catch (e: unknown) { toast(String((e as Error)?.message || e), "error"); }
    finally { setBusy(false); }
  };

  let left = shown;
  const visible: StatementDay[] = [];
  for (const d of days) {
    if (left <= 0) break;
    visible.push(d.lines.length > left ? { ...d, lines: d.lines.slice(0, left) } : d);
    left -= Math.max(1, d.lines.length);
  }
  const total = days.reduce((s, d) => s + d.lines.length, 0);
  const drawn = visible.reduce((s, d) => s + d.lines.length, 0);
  const agree = !!x && Math.abs(x.drift) < 0.005;
  const oldest = x && x.points.length > 0 ? x.points[x.points.length - 1].date : "";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${name} statement`}
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-4xl h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-semibold text-ink truncate">{name}</h2>
              {x && (agree
                ? <StatusPill tone="success">Books agree with the bank</StatusPill>
                : <StatusPill tone="danger">Off by {fmtAmount(Math.abs(x.drift))}</StatusPill>)}
            </div>
            <p className="text-[12px] text-muted mt-0.5">
              Every posted transaction, newest first, with {card ? "what you owed" : "the balance"} after it, counted back from what the {card ? "card company" : "bank"} says today.
              Open your {card ? "card's" : "bank's"} site beside it: any day should match.
            </p>
          </div>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 flex-shrink-0"><X size={16} /></button>
        </div>

        {err && <div className="px-5 py-4 text-[13px] text-danger-ink">{err}</div>}
        {!x && !err && <div className="px-5 py-4 text-[13px] text-muted">Adding up every transaction on this account…</div>}

        {x && (
          <>
            <div className="px-5 py-4 border-b border-line space-y-3">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
                {([
                  [card ? "Owed today" : "In the bank today", bal(x.bank_balance), card ? "What the card company says" : "What the bank says"],
                  ["Posted transactions", String(x.lines.length), "Each one below, with the balance after it"],
                  [card ? "Owed before the first one" : "Before the first one", bal(x.opening), Math.abs(x.opening) < 0.005 ? "Your books hold this account from its first day" : card ? "What you owed before the first transaction here" : "What it held before the first transaction here"],
                  ["Pending", fmtAmount(x.pending_total), `${x.pending.length} not in the ${card ? "card company's" : "bank's"} balance yet`],
                ] as [string, string, string][]).map(([label, value, sub]) => (
                  <div key={label} className="min-w-0">
                    <div className="ui-label">{label}</div>
                    <div className="text-[17px] font-medium text-ink tabular-nums truncate mt-0.5">{value}</div>
                    <div className="text-[11.5px] text-muted truncate" title={sub}>{sub}</div>
                  </div>
                ))}
              </div>

              {w ? (
                <div className="rounded-xl bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed">
                  <div className="font-medium text-danger-ink">
                    Your books and the {card ? "card company" : "bank"} agree {w.through ? `on ${longDay(w.through)}` : "today"} and differ by {fmtAmount(Math.abs(w.gap))} on {longDay(w.after)}.
                  </div>
                  <div className="text-ink-2 mt-0.5">
                    The cause is among the {w.count} {w.count === 1 ? "transaction" : "transactions"} after {longDay(w.after)}{w.through ? ` and up to ${longDay(w.through)}` : ""}: one missing from your books, in them twice, or with a different amount.
                    {same.size > 0 && ` ${same.size} of them ${same.size === 1 ? "is" : "are"} exactly ${fmtAmount(Math.abs(w.gap))}. Check ${same.size === 1 ? "it is" : "they are"} not in your books twice.`}
                    {" "}Check a day inside that stretch to narrow it down.
                  </div>
                  <button onClick={() => { setOnlyWindow(!onlyWindow); setShown(PAGE); }} className="mt-1.5 font-medium text-ink hover:opacity-70">
                    {onlyWindow ? "Show every day again" : "Show only those days"}
                  </button>
                </div>
              ) : x.points.length > 0 ? (
                <div className="rounded-xl bg-success-bg px-4 py-3 text-[12.5px] font-medium text-success-ink">
                  Every day checked against the {card ? "card company" : "bank"} agrees: {x.points.length} {x.points.length === 1 ? "day" : "days"}, back to {longDay(oldest)}.
                </div>
              ) : (
                <div className="rounded-xl bg-surface-2 px-4 py-3 text-[12.5px] text-ink-2 leading-relaxed">
                  To check a day, click its balance and type what your {card ? "card's" : "bank's"} site shows for the end of that day. It is kept, and this screen then tells you between which two days the books stop matching.
                </div>
              )}

              {(x.pending.length > 0 || x.withdrawn.length > 0) && (
                <div className="text-[12.5px] text-ink-2 space-y-1">
                  {([["pending", x.pending, x.pending_total, `pending, not in the ${card ? "card company's" : "bank's"} balance yet, so not counted here`],
                     ["withdrawn", x.withdrawn, x.withdrawn_total, "taken back by the bank and still in your books (answer them under Needs you), not counted here"]] as const)
                    .filter(([, rows]) => rows.length > 0).map(([kind, rows, sum, what]) => (
                    <div key={kind} className="min-w-0">
                      <button onClick={() => setOpenList(openList === kind ? "" : kind)} className="text-left hover:opacity-70">
                        <span className="font-medium text-ink">{rows.length} {what}</span>
                        <span className="tabular-nums text-muted"> · {fmtAmount(sum)} · {openList === kind ? "Hide" : "Show"}</span>
                      </button>
                      {openList === kind && (
                        <div className="mt-1 divide-y divide-line-2">
                          {rows.map((l) => <Line key={l.id} l={l} bal={bal} onOpen={onOpenRow && ((id, amt) => { onClose(); onOpenRow(id, amt); })} withDate />)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Find a name or an amount" className={`${FIELD} w-56`} />
                <select value={month} onChange={(e) => { setMonth(e.target.value); setShown(PAGE); }} className={FIELD} aria-label="Month">
                  <option value="">Every month</option>
                  {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                </select>
                {filtered && <span className="text-[12px] text-muted tabular-nums">{total} of {x.lines.length} transactions. Balances are the real ones, not a total of what is shown.</span>}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-5">
              <div className="sticky top-0 z-[1] bg-surface flex items-center gap-3 py-2 text-[12px] font-medium text-muted border-b border-line">
                <span className="min-w-0 flex-1">Transaction</span>
                <span className="w-28 text-right flex-shrink-0">Amount</span>
                <span className="w-32 text-right flex-shrink-0">{card ? "Owed after" : "Balance after"}</span>
                {onOpenRow && <span className="w-10 flex-shrink-0" />}
              </div>
              {days.length === 0 && <p className="ui-note py-4">{filtered ? "Nothing matches." : "No posted transaction is on the books for this account."}</p>}
              {visible.map((d) => {
                const p = d.point;
                const ok = !!p && Math.abs(p.gap) < 0.005;
                return (
                  <section key={d.date} className="min-w-0">
                    <div className="flex items-center gap-3 pt-3 pb-1.5 border-b border-line min-w-0 flex-wrap">
                      <span className="min-w-0 flex-1 text-[13px] font-medium text-ink whitespace-nowrap">{longDay(d.date)}</span>
                      {p && (ok
                        ? <StatusPill tone="success" title={p.source === "you" ? "You checked this day" : "The ending balance of a statement you imported"}>{card ? "Card company" : "Bank"} agrees</StatusPill>
                        : <StatusPill tone="danger" title={p.source === "you" ? "You checked this day" : "The ending balance of a statement you imported"}>
                            {card ? "Card company" : "Bank"} shows {bal(p.bank)}, differs by {fmtAmount(Math.abs(p.gap))}
                          </StatusPill>)}
                      {editing === d.date ? (
                        <form className="flex items-center gap-1.5 flex-wrap" onSubmit={(e) => {
                          e.preventDefault();
                          const n = parseMoney(typed);
                          if (n == null) { toast("Type the balance as a number.", "error"); return; }
                          save(d.date, n);
                        }}>
                          <span className="text-[12px] text-muted">{card ? "Your card's site shows you owed" : "Your bank's site shows"}</span>
                          <input autoFocus inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} className={`${FIELD} w-32 tabular-nums`} />
                          <Button size="sm" variant="ink" type="submit" disabled={busy}>Keep</Button>
                          {p?.source === "you" && <Button size="sm" onClick={() => save(d.date, null)} disabled={busy}>Clear</Button>}
                          <Button size="sm" onClick={() => { setEditing(null); setTyped(""); }} disabled={busy}>Cancel</Button>
                        </form>
                      ) : (
                        <button onClick={() => { setEditing(d.date); setTyped(p?.source === "you" ? String(card ? -p.bank : p.bank) : ""); }}
                          title="Check this day against your bank" className="text-[12.5px] text-ink-2 hover:opacity-70 whitespace-nowrap">
                          End of day <span className="font-medium text-ink tabular-nums">{bal(d.end)}</span>
                          <span className="text-muted"> · {p?.source === "you" ? "Change" : "Check"}</span>
                        </button>
                      )}
                    </div>
                    <div className="divide-y divide-line-2">
                      {d.lines.map((l) => (
                        <Line key={l.id} l={l} bal={bal} copy={copies.has(l.id)} same={same.has(l.id)}
                          onOpen={onOpenRow && ((id, amt) => { onClose(); onOpenRow(id, amt); })} />
                      ))}
                    </div>
                  </section>
                );
              })}
              {drawn < total && (
                <div className="pt-4">
                  <Button onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, total - drawn)} older</Button>
                  <span className="ml-3 text-[12px] text-muted tabular-nums">{drawn} of {total} shown</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Line({ l, bal, copy, same, onOpen, withDate }: {
  l: StatementLine;
  bal: (n: number) => string;
  copy?: boolean;
  same?: boolean;
  onOpen?: (id: string, amount: number) => void;
  withDate?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 min-w-0 text-[12.5px]">
      {withDate && <span className="text-muted tabular-nums w-24 flex-shrink-0">{l.date}</span>}
      <span className="min-w-0 flex-1 flex items-center gap-2">
        <span className="truncate text-ink-2" title={l.description}>{l.description || "No description"}</span>
        {same && <StatusPill tone="danger" title="Exactly the amount the books and the bank differ by">Same as the difference</StatusPill>}
        {copy && <StatusPill tone="warning" title="Looks like a second copy of another transaction">Possible copy</StatusPill>}
      </span>
      <span className={`tabular-nums w-28 text-right flex-shrink-0 ${l.direction === "in" ? "text-success-ink" : "text-ink-2"}`}>
        {l.direction === "in" ? "+" : "-"}{fmtAmount(l.amount)}
      </span>
      <span className="tabular-nums w-32 text-right flex-shrink-0 text-ink">{l.balance == null ? "" : bal(l.balance)}</span>
      {onOpen && <button onClick={() => onOpen(l.id, l.amount)} className="w-10 text-right font-medium text-ink hover:opacity-70 flex-shrink-0">Open</button>}
    </div>
  );
}
