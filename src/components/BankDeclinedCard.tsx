import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { api, BankCheck, BankDeclined, BankDeclinedAction } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { useSessionMe } from "../lib/useSessionMe";
import { toast } from "./Toast";

// R-586/R-587: every bank transaction that is not in the ledger exactly as the bank shows it, kept until someone
// answers it. The bank feed used to skip a likely copy, hold back a shared payment reference, or drop a change for
// a row it never had, and then move past it for good; a statement import did the same with a row it took for the
// feed's. Check against bank adds what the bank's own history shows: a posted transaction with no ledger row, a
// ledger row whose date, amount or memo is not the bank's, and a bank row the bank no longer lists.

const REASON: Record<BankDeclined["reason"], string> = {
  copy: "Looked like a copy of a row already on the books, so the bank feed did not add it.",
  held_reference: "Held back: it has the same payment reference as money already booked.",
  change_unknown: "Your bank sent a change to this transaction, and the ledger never had it.",
  statement_feed_twin: "Statement row taken for the bank feed's copy of the same amount, so it was not added.",
  missing: "Posted at your bank and not in the ledger.",
  differs: "In the ledger, but not exactly as your bank shows it.",
  not_at_bank: "In the ledger from the bank feed, but your bank no longer shows it.",
};

const FIELD: Record<string, string> = { date: "date", amount: "amount", direction: "direction", memo: "description" };

function day(iso: string): string {
  return (iso || "").slice(0, 10);
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function signed(amount: number, direction: string): string {
  return `${direction === "in" ? "+" : "-"}${fmtAmount(amount)}`;
}

interface Props {
  /** Bumped by the screen after a pull or an import, so the card re-reads. */
  version: number;
  /** "tobook" shows only what needs an answer; "check" adds the last Check against bank and its button. */
  mode: "tobook" | "check";
  /** After an answer changed the ledger. */
  onChanged: () => void;
  /** Opens a ledger row on the Ledger. */
  onOpenRow: (id: string, amount: number) => void;
  /** From To book: go to Check books. */
  onCheckBooks?: () => void;
}

export default function BankDeclinedCard({ version, mode, onChanged, onOpenRow, onCheckBooks }: Props) {
  const me = useSessionMe();
  const [rows, setRows] = useState<BankDeclined[]>([]);
  const [check, setCheck] = useState<BankCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);

  const load = () => {
    api.listBankDeclined().then((r) => { setRows(r.rows); setCheck(r.check); }).catch(() => {});
  };
  // Re-read every minute: the bank feed adds rows in the background.
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => { if (version > 0) load(); }, [version]);

  const answer = async (r: BankDeclined, action: BankDeclinedAction) => {
    if (busy) return;
    setBusy(r.id);
    try {
      const res = await api.resolveBankDeclined(r.id, action, me?.display_name || me?.email || "");
      if (!res.ok) {
        const deals = (res.delete?.needs_unlink ?? []).flatMap((n) => n.deals);
        toast(deals.length > 0
          ? `This row is linked to ${deals.join(", ")}. Unlink it on the Ledger first, then remove it here.`
          : "This row holds a refund, loan, purchase, expense or bill. Unlink that on the Ledger first.", "error");
        return;
      }
      const said: Record<BankDeclinedAction, string> = {
        import: "Imported into the ledger.",
        copy: "Marked as already on the books.",
        use_bank: "The ledger row now matches your bank.",
        keep: "Kept as it is. You will be asked again only if the bank changes it.",
        remove: "Removed. A backup was kept.",
        reopen: "Back on the list.",
      };
      toast(said[action], "success");
      load();
      if (action !== "copy" && action !== "keep" && action !== "reopen") onChanged();
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const c = await api.checkAgainstBank();
      setCheck(c);
      const off = c.missing + c.differs + c.not_at_bank;
      toast(off === 0 ? "Every posted transaction matches your bank." : `${off} ${off === 1 ? "transaction does" : "transactions do"} not match your bank. They are listed here.`, off === 0 ? "success" : undefined);
      load();
      onChanged();
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setChecking(false);
    }
  };

  const open = rows.filter((r) => r.status === "open");
  const answered = rows.filter((r) => r.status !== "open");
  if (mode === "tobook" && open.length === 0) return null;

  const button = (label: string, onClick: () => void, primary: boolean, id: string) => (
    <button
      onClick={onClick}
      disabled={busy !== null}
      className={`flex-shrink-0 h-8 px-3 rounded-lg text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-60 ${
        primary ? "bg-accent hover:bg-accent-hover text-on-accent" : "border border-line text-ink-2 hover:bg-surface-2"}`}
    >
      {busy === id && primary ? <Loader2 size={13} className="animate-spin" /> : label}
    </button>
  );

  const actions = (r: BankDeclined) => {
    if (r.reason === "differs") return <>{button("Use the bank's figures", () => answer(r, "use_bank"), true, r.id)}{button("Keep the ledger's", () => answer(r, "keep"), false, r.id)}</>;
    if (r.reason === "not_at_bank") return <>{button("Remove", () => answer(r, "remove"), false, r.id)}{button("Keep it", () => answer(r, "keep"), false, r.id)}</>;
    return <>{button("Import", () => answer(r, "import"), true, r.id)}{button("It is a copy", () => answer(r, "copy"), false, r.id)}</>;
  };

  const row = (r: BankDeclined) => {
    const ledger = r.bank.ledger;
    const fields = r.bank.fields ?? [];
    const matched = r.reason === "not_at_bank" || r.reason === "differs" ? [] : r.matched;
    return (
      <div key={r.id} className="flex items-start gap-3 px-3.5 py-3 min-w-0 flex-wrap sm:flex-nowrap">
        <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-medium text-ink tabular-nums whitespace-nowrap">{signed(r.amount, r.direction)}</span>
            <span className="text-ink truncate">{r.description || "No description"}</span>
          </div>
          <div className="text-[12px] text-muted tabular-nums">{day(r.posted_at)} · {r.account_id}</div>
          <div className="text-[12.5px] text-ink-2 mt-0.5">
            {REASON[r.reason]}
            {r.bank.removed_before && " It was removed from the books earlier."}
          </div>
          {r.reason === "differs" && ledger && (
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
              <span className="text-muted">Bank</span>
              <span className="text-ink tabular-nums min-w-0 truncate">{day(r.bank.posted_at || "")} · {signed(r.bank.amount ?? 0, r.bank.direction || "")} · {r.bank.description}</span>
              <span className="text-muted">Ledger</span>
              <span className="text-ink-2 tabular-nums min-w-0 truncate">{day(ledger.posted_at)} · {signed(ledger.amount, ledger.direction)} · {ledger.description}</span>
              <span />
              <span className="text-muted">Different: {fields.map((f) => FIELD[f] || f).join(", ")}</span>
            </div>
          )}
          {(r.reason === "differs" || r.reason === "not_at_bank" || matched.length > 0) && (
            <button
              onClick={() => onOpenRow(r.reason === "differs" || r.reason === "not_at_bank" ? r.matched[0] : matched[0], ledger ? ledger.amount : r.amount)}
              className="mt-1 text-[12px] font-medium text-accent hover:text-accent-hover"
            >
              {r.reason === "differs" || r.reason === "not_at_bank" ? "Open the ledger row" : matched.length === 1 ? "Open the row it was matched to" : `Open the first of ${matched.length} rows it was matched to`}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">{actions(r)}</div>
      </div>
    );
  };

  return (
    <div className="space-y-3 min-w-0">
      {mode === "check" && (
        <div className="border border-line-2 rounded-lg px-3.5 py-3 min-w-0">
          <div className="flex items-start gap-3 min-w-0 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-ink">Check against bank</div>
              <p className="text-[12.5px] text-ink-2 mt-0.5 leading-relaxed">
                Reads every posted transaction your bank holds and holds each one to the ledger: the date, the amount to the cent, the direction and the description.
                Nothing in the ledger changes until you answer a row below. It also runs once a day on its own.
              </p>
            </div>
            <button
              onClick={runCheck}
              disabled={checking}
              className="flex-shrink-0 flex items-center gap-1.5 h-8 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[12.5px] font-medium disabled:opacity-60 transition-colors"
            >
              {checking && <Loader2 size={13} className="animate-spin" />}
              {checking ? "Reading your bank" : "Check against bank"}
            </button>
          </div>
          {check ? (
            <div className="mt-3 flex flex-col divide-y divide-line-2 border-t border-line-2">
              {check.accounts.map((a) => (
                <div key={a.account} className="flex items-center gap-2.5 py-2 min-w-0 text-[13px]">
                  {a.not_exact === 0
                    ? <CheckCircle2 size={15} className="text-success-ink flex-shrink-0" />
                    : <AlertTriangle size={15} className="text-warning-ink flex-shrink-0" />}
                  <span className="text-ink truncate min-w-0 flex-1">{a.account}</span>
                  <span className="text-ink-2 tabular-nums whitespace-nowrap">
                    {a.not_exact === 0
                      ? `${a.posted} posted, all exact`
                      : `${a.not_exact} of ${a.posted} not exact`}
                  </span>
                </div>
              ))}
              {check.errors.map((e) => (
                <div key={e.institution} className="flex items-center gap-2.5 py-2 min-w-0 text-[13px]">
                  <AlertTriangle size={15} className="text-danger-ink flex-shrink-0" />
                  <span className="text-ink-2 min-w-0">Could not read {e.institution || "a bank"}: {e.error.replace(/^Plaid:\s*/, "")}. Its accounts were not checked.</span>
                </div>
              ))}
              <div className="pt-2 text-[12px] text-muted">Checked {when(check.checked_at)}.</div>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-muted">Not checked yet.</p>
          )}
        </div>
      )}

      {open.length > 0 && (
        <div className="border border-warning/40 rounded-lg divide-y divide-line-2 min-w-0">
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 min-w-0">
            <AlertTriangle size={15} className="text-warning-ink flex-shrink-0" />
            <span className="text-[13px] text-ink min-w-0 flex-1">
              <span className="font-medium tabular-nums">{open.length}</span>{" "}
              {open.length === 1 ? "transaction from your bank is" : "transactions from your bank are"} not in the ledger exactly as the bank shows {open.length === 1 ? "it" : "them"}.
            </span>
            {mode === "tobook" && onCheckBooks && (
              <button onClick={onCheckBooks} className="flex-shrink-0 text-[12px] font-medium text-accent hover:text-accent-hover">Check books</button>
            )}
          </div>
          {open.map(row)}
        </div>
      )}

      {mode === "check" && answered.length > 0 && (
        <div className="min-w-0">
          <button
            onClick={() => setAnsweredOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2"
          >
            {answeredOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Answered recently ({answered.length})
          </button>
          {answeredOpen && (
            <div className="mt-2 border border-line-2 rounded-lg divide-y divide-line-2 min-w-0">
              {answered.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-3.5 py-2 min-w-0 text-[12.5px]">
                  <span className="tabular-nums text-ink whitespace-nowrap">{signed(r.amount, r.direction)}</span>
                  <span className="text-ink-2 truncate min-w-0 flex-1">{day(r.posted_at)} · {r.description}</span>
                  <span className="text-muted whitespace-nowrap">
                    {{ imported: "Imported", copy: "Already on the books", fixed: "Matched to the bank", kept: "Kept", removed: "Removed", open: "" }[r.status]}
                    {r.resolved_by ? ` by ${r.resolved_by}` : ""}{r.resolved_at ? `, ${when(r.resolved_at)}` : ""}
                  </span>
                  {r.status !== "removed" && (
                    <button onClick={() => answer(r, "reopen")} disabled={busy !== null} className="flex-shrink-0 text-[12px] font-medium text-accent hover:text-accent-hover disabled:opacity-60">Undo</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
