import { Fragment, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronLeft, ChevronRight, Loader2, Lock } from "lucide-react";
import { api, PersonalAccount, PersonalCandidate, PersonalTxn } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { categoryName, isMovement, monthsOf, summarize } from "../lib/personalSpend";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-660 (Jack, 2026-11-16): "a section in finacials for personal spedning. i can choose the account that is personal
// and it will break down and track where money goes for personal this will be completely sseparate from all business
// stuff ... only linked the the exact user email". Only the workspace owner sees this tab; the server hands personal
// rows to the owner's devices and phone only. A personal account's money is in no business total, list or check.

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

function Bars({ groups, total, picked, onPick, empty }: {
  groups: { key: string; name: string; amount: number; count: number }[];
  total: number;
  picked?: string | null;
  onPick?: (k: string | null) => void;
  empty: string;
}) {
  if (groups.length === 0) return <p className="ui-note py-2">{empty}</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g) => {
        const pct = total > 0 ? (g.amount / total) * 100 : 0;
        const on = picked === g.key;
        const body = (
          <>
            <div className="flex items-baseline gap-3 min-w-0">
              <span className={`min-w-0 flex-1 truncate text-[13px] ${on ? "font-medium text-ink" : "text-ink-2"}`}>{g.name}</span>
              <span className="text-[12px] text-muted tabular-nums flex-shrink-0">{Math.round(pct)}%</span>
              <span className="text-[13px] text-ink tabular-nums w-24 text-right flex-shrink-0">{fmtAmount(g.amount)}</span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div className={`h-full rounded-full ${on ? "bg-accent" : "bg-ink-2"}`} style={{ width: `${Math.max(1.5, pct)}%`, opacity: on ? 1 : 0.55 }} />
            </div>
          </>
        );
        return onPick ? (
          <button key={g.key} onClick={() => onPick(on ? null : g.key)} className="text-left min-w-0 rounded-md -mx-1.5 px-1.5 py-1 hover:bg-surface-2 transition-colors">
            {body}
          </button>
        ) : <div key={g.key} className="min-w-0 py-1">{body}</div>;
      })}
    </div>
  );
}

export default function PersonalView() {
  const [accounts, setAccounts] = useState<PersonalAccount[] | null>(null);
  const [txns, setTxns] = useState<PersonalTxn[]>([]);
  const [candidates, setCandidates] = useState<PersonalCandidate[]>([]);
  const [month, setMonth] = useState(thisMonth);
  const [cat, setCat] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api.personalOverview()
      .then((r) => { setAccounts(r.accounts); setTxns(r.txns); setCandidates(r.candidates); })
      .catch((e) => { setAccounts([]); toast(String(e?.message || e), "error"); });
  };
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    let un: (() => void) | null = null;
    let dead = false;
    listen("netsync-applied", () => { load(); }).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
    return () => { window.clearInterval(t); dead = true; un?.(); };
  }, []);

  const months = useMemo(() => {
    const m = monthsOf(txns);
    return m.includes(thisMonth()) ? m : [thisMonth(), ...m];
  }, [txns]);
  const s = useMemo(() => summarize(txns, month), [txns, month]);
  const shown = cat ? s.rows.filter((t) => (t.category || "OTHER") === cat) : s.rows;
  const byDay = useMemo(() => {
    const out: [string, PersonalTxn[]][] = [];
    for (const t of shown) {
      const last = out[out.length - 1];
      if (last && last[0] === t.posted_at) last[1].push(t); else out.push([t.posted_at, [t]]);
    }
    return out;
  }, [shown]);
  const at = months.indexOf(month);
  const go = (d: number) => { const m = months[at + d]; if (m) { setMonth(m); setCat(null); } };

  const cash = (accounts ?? []).filter((a) => a.type === "depository").reduce((x, a) => x + (a.balance ?? 0), 0);
  const owed = (accounts ?? []).filter((a) => a.type === "credit").reduce((x, a) => x + Math.abs(a.balance ?? 0), 0);
  const chosen = candidates.find((c) => c.account_key === pick) ?? null;

  const mark = async () => {
    if (!chosen) return;
    if (armed !== `mark:${chosen.account_key}`) { setArmed(`mark:${chosen.account_key}`); return; }
    setArmed(null);
    setBusy(chosen.account_key);
    try {
      const r = await api.personalMark(chosen.account_key, chosen.label, chosen.institution, chosen.type);
      const kept = r.kept.length;
      toast(
        `${chosen.label} is personal now.${r.moved ? ` Moved ${r.moved} ${r.moved === 1 ? "transaction" : "transactions"} off the business books.` : ""}` +
          (kept ? ` ${kept} stay${kept === 1 ? "s" : ""} on the books because ${kept === 1 ? "it is" : "they are"} tied to a deal, refund, loan or bill.` : ""),
        "success",
      );
      setPick("");
      load();
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setBusy(null);
    }
  };

  const unmark = async (a: PersonalAccount) => {
    if (armed !== `unmark:${a.account_key}`) { setArmed(`unmark:${a.account_key}`); return; }
    setArmed(null);
    setBusy(a.account_key);
    try {
      const r = await api.personalUnmark(a.account_key);
      toast(`${a.label} is business again. ${r.back} ${r.back === 1 ? "transaction went" : "transactions went"} back to the books.`, "success");
      load();
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setBusy(null);
    }
  };

  const figures: [string, string, string][] = [
    ["Spent", fmtAmount(s.spent), `${monthLabel(month)}, returns taken off`],
    ["Money in", fmtAmount(s.income), "Pay and other income"],
    ["Left over", fmtAmount(s.income - s.spent), s.income - s.spent >= 0 ? "Money in less spent" : "Spent more than came in"],
    ["Personal balances", fmtAmount(cash - owed), owed > 0 ? `${fmtAmount(cash)} cash, ${fmtAmount(owed)} owed on cards` : "Cash in your personal accounts"],
  ];

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink flex items-center gap-2">Personal <Lock size={13} className="text-muted" /></h3>
          <p className="ui-note mt-0.5">Only you see this. Personal accounts stay out of the books, every business total, Balances and tax, and Accounts.</p>
        </div>
        {(accounts ?? []).length > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={() => go(1)} disabled={at >= months.length - 1} className="ui-btn ui-btn-sm disabled:opacity-40" aria-label="Earlier month"><ChevronLeft size={14} /></button>
            <span className="text-[13px] font-medium text-ink w-36 text-center tabular-nums">{monthLabel(month)}</span>
            <button onClick={() => go(-1)} disabled={at <= 0} className="ui-btn ui-btn-sm disabled:opacity-40" aria-label="Later month"><ChevronRight size={14} /></button>
          </div>
        )}
      </div>

      {accounts !== null && accounts.length === 0 && (
        <p className="text-[13px] text-ink-2 leading-relaxed pt-2">
          No account is personal yet. Pick one below, such as a personal card you connected by mistake: its transactions leave the business books and are tracked here instead, by where the money went.
        </p>
      )}

      {(accounts ?? []).length > 0 && (
        <>
          <div className="hsep" />
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-x-6 gap-y-4 py-4">
            {figures.map(([label, value, sub], i) => (
              <Fragment key={label}>
                {i > 0 && <div className={`vsep ${i === 2 ? "hidden xl:block" : "hidden sm:block"}`} />}
                <div className="min-w-0">
                  <div className="ui-label">{label}</div>
                  <div className="ui-fig mt-1 tabular-nums truncate">{value}</div>
                  <div className="text-[12px] text-muted truncate mt-0.5" title={sub}>{sub}</div>
                </div>
              </Fragment>
            ))}
          </div>
          <div className="hsep" />
          {s.moved > 0.004 && (
            <p className="ui-note pt-3">{fmtAmount(s.moved)} moved between your own accounts this month (transfers and card payments). Not counted as spending or money in.</p>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-6 pt-4">
            <section className="min-w-0">
              <h4 className="text-[13px] font-medium text-ink mb-3">Where it went</h4>
              <Bars groups={s.byCategory} total={s.spent} picked={cat} onPick={setCat} empty="Nothing spent this month." />
            </section>
            <section className="min-w-0">
              <h4 className="text-[13px] font-medium text-ink mb-3">Top places</h4>
              <Bars groups={s.byPlace.slice(0, 8)} total={s.spent} empty="Nothing spent this month." />
            </section>
          </div>
          <section className="pt-6 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-[13px] font-medium text-ink">Transactions</h4>
              {cat && (
                <button onClick={() => setCat(null)} className="ui-btn ui-btn-sm">{categoryName(cat)}, show all</button>
              )}
            </div>
            {byDay.length === 0 && <p className="ui-note py-2">No transactions this month.</p>}
            <div className="rounded-xl ring-1 ring-line divide-y divide-line min-w-0">
              {byDay.map(([day, rows]) => (
                <div key={day} className="px-3.5 py-2 min-w-0">
                  <div className="text-[12px] text-muted pb-1">{dayLabel(day)}</div>
                  {rows.map((t) => {
                    const code = t.category || "OTHER";
                    const moved = isMovement(code);
                    return (
                      <div key={t.id} className="flex items-center gap-3 py-1.5 min-w-0">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] text-ink truncate" title={t.description}>{t.merchant || t.description}</div>
                          <div className="text-[12px] text-muted truncate">
                            {categoryName(code)} · {t.account}{t.pending ? " · pending" : ""}{moved ? " · not counted" : ""}
                          </div>
                        </div>
                        <span className={`text-[13px] tabular-nums flex-shrink-0 ${t.direction === "in" ? "text-success-ink" : moved ? "text-muted" : "text-ink"}`}>
                          {t.direction === "in" ? "+" : ""}{fmtAmount(t.amount)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="pt-6 min-w-0">
        <h4 className="text-[13px] font-medium text-ink mb-3">Personal accounts</h4>
        {(accounts ?? []).length > 0 && (
          <div className="rounded-xl ring-1 ring-line divide-y divide-line min-w-0 mb-4">
            {(accounts ?? []).map((a) => (
              <div key={a.account_key} className="flex items-center gap-3 px-3.5 py-2.5 min-w-0 flex-wrap sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink truncate">{a.label}</div>
                  <div className="text-[12px] text-muted truncate">
                    {a.institution || "Account"}
                    {a.balance !== null ? ` · ${a.type === "credit" ? "owed" : "balance"} ${fmtAmount(Math.abs(a.balance))}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => unmark(a)}
                  disabled={busy !== null}
                  className={`ui-btn ui-btn-sm flex-shrink-0 disabled:opacity-60 ${armed === `unmark:${a.account_key}` ? "ui-btn-ink" : ""}`}
                >
                  {busy === a.account_key && <Loader2 size={13} className="animate-spin" />}
                  {armed === `unmark:${a.account_key}` ? "Yes, put it back in the books" : "Make it business again"}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={pick}
            onChange={(e) => { setPick(e.target.value); setArmed(null); }}
            className="h-9 px-2.5 rounded-lg border border-line bg-surface text-[13px] text-ink min-w-0 max-w-full"
          >
            <option value="">Make an account personal…</option>
            {candidates.map((c) => (
              <option key={c.account_key} value={c.account_key}>
                {c.label}{c.institution ? `, ${c.institution}` : ""}{c.rows ? ` (${c.rows} on the books)` : ""}
              </option>
            ))}
          </select>
          {chosen && (
            <Button onClick={mark} disabled={busy !== null} variant={armed === `mark:${chosen.account_key}` ? "ink" : "outline"}>
              {busy === chosen.account_key && <Loader2 size={14} className="animate-spin" />}
              {armed === `mark:${chosen.account_key}` ? "Yes, make it personal" : "Make personal"}
            </Button>
          )}
        </div>
        {chosen && armed === `mark:${chosen.account_key}` && (
          <p className="text-[12px] text-ink-2 mt-2 leading-relaxed">
            {chosen.rows > 0
              ? `Moves ${chosen.rows} ${chosen.rows === 1 ? "transaction" : "transactions"} under ${chosen.label} off the business books into Personal, and its new ones come here from now on. A transaction tied to a deal, refund, loan or bill stays on the books. You can put it back any time.`
              : `New transactions on ${chosen.label} come here from now on, never into the books. You can put it back any time.`}
          </p>
        )}
      </section>
    </div>
  );
}
