import { useEffect, useState } from "react";
import { api, DriftCause, DriftExplain } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-622 (Jack, 2026-11-06): "it says 3 of 5 of my accounts are off by ammounts and i need a way to check how and fix
// how". Opened from an account's Off by on Balances and tax: what the bank says against what the books say, every
// row the check can see behind the difference with what it does to it and where it is fixed, the last statement and
// the last Check against bank held against it, and, once it is answered, starting the check again from today.

const signed = (x: number) => `${x < 0 ? "-" : "+"}${fmtAmount(Math.abs(x))}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso.length <= 10 ? iso + "T12:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

/** What each kind of row is, and how it is fixed. `list` = answered on the Not imported list (Check books). */
const KIND: Record<DriftCause["kind"], { title: (n: number) => string; fix: string; where: "list" | "row" | "none" }> = {
  missing: {
    title: (n) => `${plural(n, "transaction", "transactions")} the bank lists that ${n === 1 ? "is" : "are"} not in your books`,
    fix: "Import each one on the Not imported list.", where: "list",
  },
  differs: {
    title: (n) => `${plural(n, "transaction", "transactions")} where your books do not match the bank's amount or date`,
    fix: "Use the bank's figures for each one on the Not imported list.", where: "list",
  },
  not_at_bank: {
    title: (n) => `${plural(n, "transaction", "transactions")} in your books the bank no longer lists`,
    fix: "Remove each one on the Not imported list, or keep it if you know it happened.", where: "list",
  },
  withdrawn: {
    title: (n) => `${plural(n, "transaction", "transactions")} the bank took back, still in your books`,
    fix: "Open each one and remove it. It is under Retracted by bank in To book.", where: "row",
  },
  duplicate: {
    title: (n) => `${plural(n, "possible duplicate", "possible duplicates")} in your books`,
    fix: "Open each one and remove the extra copy, or mark the pair Not the same if both happened.", where: "row",
  },
  late: {
    title: (n) => `${plural(n, "transaction", "transactions")} that came in after the check started, for days before it`,
    fix: "Nothing is wrong with these. The bank's balance already held them when the check started. Start the check from today.", where: "none",
  },
  removed: {
    title: (n) => `${plural(n, "transaction", "transactions")} deleted from your books since the check started`,
    fix: "If each delete was right (a copy), start the check from today. If one was real, bring it back from the bank on the Not imported list.", where: "none",
  },
};

export default function DriftPanel({ account, name, card, onCheckBooks, onOpenRow, onChanged }: {
  account: string;
  name: string;
  /** A credit card: its balance is what is owed, so the sentences say so. */
  card?: boolean;
  onCheckBooks?: () => void;
  onOpenRow?: (id: string, amount: number) => void;
  onChanged: () => void;
}) {
  const [x, setX] = useState<DriftExplain | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "accept">("");
  const [armed, setArmed] = useState(false);
  const [all, setAll] = useState<Record<string, boolean>>({});

  const load = () => {
    setErr("");
    return api.explainBankDrift(account).then(setX).catch((e: unknown) => setErr(String((e as Error)?.message || e)));
  };
  useEffect(() => { load(); }, [account]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkNow = async () => {
    setBusy("check");
    try { await api.checkAgainstBank(); await load(); toast("Checked against the bank"); }
    catch (e: unknown) { toast(String((e as Error)?.message || e), "error"); }
    finally { setBusy(""); }
  };
  const accept = async () => {
    if (!armed) { setArmed(true); return; }
    setBusy("accept");
    try { await api.acceptBankFigures(account); toast(`${name}'s check starts from today`); onChanged(); }
    catch (e: unknown) { toast(String((e as Error)?.message || e), "error"); setBusy(""); setArmed(false); }
  };

  if (err) {
    return (
      <div className="py-3 text-[12.5px] text-ink-2">
        <span className="text-danger-ink">Could not work out why:</span> {err}
        <button onClick={load} className="ml-2 font-medium text-ink hover:opacity-70">Try again</button>
      </div>
    );
  }
  if (!x) return <div className="py-3 text-[12.5px] text-muted">Looking at every row on this account…</div>;

  const st = x.statement;
  const stAgrees = !!st && Math.abs(st.gap) < 0.005;
  const bc = x.bank_check;
  const listKinds = x.causes.some((c) => c.kind === "missing" || c.kind === "differs" || c.kind === "not_at_bank");
  const bankExact = !!bc && bc.posted > 0 && bc.exact === bc.posted && !listKinds;
  const residualLeft = Math.abs(x.residual) >= 0.005;

  // The one sentence that says where it stands.
  let verdict: string;
  if (stAgrees) {
    verdict = `Your books match your last statement (ending ${day(st!.end)}) and every transaction since, so the books are right. The check started from a wrong point. Start it from today.`;
  } else if (x.causes.length > 0 && !residualLeft) {
    verdict = "The transactions below explain all of it. Fix each one, and the account agrees again.";
  } else if (x.causes.length > 0) {
    verdict = `The transactions below explain ${signed(x.explained)} of it. ${signed(x.residual)} is left that no transaction the check can see explains.`;
  } else if (bankExact) {
    verdict = `Every one of the ${bc!.posted} transactions the bank lists is in your books exactly (checked ${day(bc!.checked_at)}), and nothing is doubled or taken back. The books are right. The check started from a wrong point, usually while an account's history was still coming in after it was connected. Start it from today.`;
  } else {
    verdict = "No transaction the check can see explains it.";
  }

  return (
    <div className="my-1 mb-3 rounded-xl bg-surface-2 px-4 py-3.5 space-y-3 text-[12.5px] min-w-0">
      {card ? (
        <div className="text-ink-2 leading-relaxed">
          The card company says you owe <span className="font-medium text-ink tabular-nums">{fmtAmount(Math.abs(x.bank_balance))}</span> on {name}.
          {x.books_balance != null && <> Your books say <span className="font-medium text-ink tabular-nums">{fmtAmount(Math.abs(x.books_balance))}</span>: what was owed when the check started{x.baseline_at ? ` (${day(x.baseline_at)})` : ""} plus every transaction since.</>}
          {" "}The card company says you owe {x.drift > 0 ? "less" : "more"} than your books do, by <span className="font-medium text-ink tabular-nums">{fmtAmount(Math.abs(x.drift))}</span>.
          It is transactions missing from, doubled in or different in your books.
        </div>
      ) : (
        <div className="text-ink-2 leading-relaxed">
          The bank says {name} holds <span className="font-medium text-ink tabular-nums">{fmtAmount(x.bank_balance)}</span>.
          {x.books_balance != null && <> Your books say <span className="font-medium text-ink tabular-nums">{fmtAmount(x.books_balance)}</span>: the balance when the check started{x.baseline_at ? ` (${day(x.baseline_at)})` : ""} plus every transaction since.</>}
          {" "}That is {x.drift > 0 ? "more" : "less"} money in the bank than your books account for, by <span className="font-medium text-ink tabular-nums">{fmtAmount(Math.abs(x.drift))}</span>.
          It is not money missing from the bank. It is transactions missing from, doubled in or different in your books.
        </div>
      )}

      <div className={`font-medium ${stAgrees || bankExact ? "text-success-ink" : "text-ink"}`}>{verdict}</div>

      {x.causes.map((c) => {
        const k = KIND[c.kind];
        const rows = all[c.kind] ? c.rows : c.rows.slice(0, 8);
        return (
          <div key={c.kind} className="border-t border-line pt-2.5 min-w-0">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 font-medium text-ink">{k.title(c.rows.length)}</span>
              <span className="tabular-nums text-ink-2 flex-shrink-0">{signed(c.effect)}</span>
            </div>
            <div className="text-muted mt-0.5">{k.fix}</div>
            <div className="mt-1.5 divide-y divide-line-2">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-1.5 min-w-0">
                  <span className="text-muted tabular-nums w-24 flex-shrink-0">{day(r.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={r.description}>{r.description || "No description"}</span>
                  <span className="tabular-nums text-ink-2 w-28 text-right flex-shrink-0">{r.direction === "in" ? "" : "-"}{fmtAmount(r.amount)}</span>
                  {k.where === "row" && onOpenRow && (
                    <button onClick={() => onOpenRow(r.id, r.amount)} className="font-medium text-ink hover:opacity-70 flex-shrink-0">Open</button>
                  )}
                </div>
              ))}
            </div>
            {c.rows.length > rows.length && (
              <button onClick={() => setAll({ ...all, [c.kind]: true })} className="mt-1 font-medium text-ink hover:opacity-70">Show all {c.rows.length}</button>
            )}
            {k.where === "list" && onCheckBooks && (
              <button onClick={onCheckBooks} className="mt-1 font-medium text-ink hover:opacity-70">Open the Not imported list</button>
            )}
          </div>
        );
      })}

      {st && !stAgrees && (
        <div className="border-t border-line pt-2.5 text-ink-2 leading-relaxed">
          From your last statement (ending {day(st.end)}, {fmtAmount(st.ending)}) plus every transaction since, your books say the bank should hold {fmtAmount(st.expected)}.
          The bank holds {fmtAmount(x.bank_balance)}, so {fmtAmount(Math.abs(st.gap))} is {st.gap > 0 ? "missing from" : "doubled in"} your books since {day(st.end)}.
        </div>
      )}
      {!st && !card && (
        <div className="border-t border-line pt-2.5 text-muted leading-relaxed">
          No statement is imported for this account. Import its latest statement under Setup, and the check can say whether the books are right from that day on.
        </div>
      )}
      {residualLeft && !x.baseline_at && x.causes.length > 0 && (
        <div className="text-muted leading-relaxed">
          This account's check started before the check kept its date, so transactions that came in late or were deleted since cannot be named. Some of the transactions above may be older than the check, and then they do not count toward the difference.
        </div>
      )}
      {bc && !bankExact && (
        <div className="text-muted">
          Last Check against bank{bc.checked_at ? `, ${day(bc.checked_at)}` : ""}: {bc.exact} of the bank's {bc.posted} transactions are in your books exactly.
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap border-t border-line pt-3">
        <Button size="sm" onClick={checkNow} disabled={!!busy}>{busy === "check" ? "Checking…" : "Check against bank now"}</Button>
        {onCheckBooks && <Button size="sm" onClick={onCheckBooks} disabled={!!busy}>Open Check books</Button>}
        <Button size="sm" variant={armed ? "danger" : "outline"} onClick={accept} disabled={!!busy}
          title="Use when every transaction above is answered, or the books are shown to be right">
          {armed ? "Click again: start this account's check from today" : "These books are right: start the check from today"}
        </Button>
      </div>
    </div>
  );
}
