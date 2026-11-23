import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { api, BankBalance, BankCheck } from "../lib/api";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-670 (Jack, 2026-11-18: "In a perfect world, my books and ledger every single day match 100% with all my accounts.
// I open ecliptr finacials to see new transactions, i can link them and book them"). The one answer at the top of
// every Financials screen: do the books match the bank. Green when every account agrees; otherwise what needs a
// person, each with the one place it is answered. Check against bank reads the banks' posted lists and puts the books right
// (`check_against_bank`), and the strip says what that run did.

type Go = "setup" | "needs" | "tobook" | "accounts";
export interface StatusLine { key: string; text: string; action: string; go: Go }

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What needs a person, from the counts. Kept apart from the reads so it can be tested. */
export function statusLines(banks: number, needs: number, off: number, unsorted: number): StatusLine[] {
  const out: StatusLine[] = [];
  if (banks > 0) out.push({ key: "banks", text: `${n(banks, "bank needs", "banks need")} its connection fixed, so its transactions are not coming in.`, action: "Fix it", go: "setup" });
  if (needs > 0) out.push({ key: "needs", text: `${n(needs, "transaction needs", "transactions need")} an answer from you.`, action: "Answer", go: "needs" });
  // An account that is off with nothing to answer: the next check puts it right, or its statement shows where.
  if (off > 0 && needs === 0) out.push({ key: "off", text: `${n(off, "account does", "accounts do")} not match the bank yet.`, action: "See accounts", go: "accounts" });
  if (unsorted > 0) out.push({ key: "unsorted", text: `${n(unsorted, "transaction is", "transactions are")} not booked, so the tax figure leaves ${unsorted === 1 ? "it" : "them"} out.`, action: "Book", go: "tobook" });
  return out;
}

/** What the last check did by itself, as one sentence; empty when it changed nothing. */
export function fixedSentence(f: BankCheck["fixed"]): string {
  if (!f) return "";
  const parts = [
    f.imported ? `brought in ${n(f.imported, "transaction", "transactions")}` : "",
    f.amended ? `corrected ${f.amended}` : "",
    f.removed + f.copies ? `removed ${n(f.removed + f.copies, "copy", "copies")}` : "",
    f.moved ? `moved ${n(f.moved, "booking", "bookings")} to the posted charge` : "",
    f.two_payments ? `confirmed ${n(f.two_payments, "pair", "pairs")} as two payments` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const last = parts.pop();
  return `The last check ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

export default function BooksStatus({ reloadKey, needs, onGo, onChanged }: {
  reloadKey?: unknown;
  /** How many items the Needs you list holds. */
  needs: number;
  onGo: (tab: Go) => void;
  onChanged: () => void;
}) {
  const [accounts, setAccounts] = useState<BankBalance[]>([]);
  const [check, setCheck] = useState<BankCheck | null>(null);
  const [banks, setBanks] = useState(0);
  const [unsorted, setUnsorted] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.bankBalances().then((r) => setAccounts((r?.accounts ?? []).filter((a) => a.drift != null))).catch(() => setAccounts([]));
    api.listBankDeclined().then((r) => setCheck(r?.check ?? null)).catch(() => {});
    api.plaidHealth().then((h) => setBanks((h?.banks ?? []).filter((b) => b.needs_login || (b.dropped?.length ?? 0) > 0).length)).catch(() => setBanks(0));
    api.financialsOverview()
      .then((v) => setUnsorted((v as { tax_extra?: { uncategorised_rows?: number } })?.tax_extra?.uncategorised_rows ?? 0)).catch(() => setUnsorted(0));
  };
  useEffect(() => {
    load();
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { load(); }).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
    return () => { dead = true; un?.(); };
  }, [reloadKey]);

  const run = async () => {
    setBusy(true);
    try {
      const c = await api.checkAgainstBank();
      setCheck(c);
      toast(fixedSentence(c.fixed).replace("The last check", "Checked. It") || "Checked. Nothing had to change.", "success");
      onChanged();
    } catch (e: unknown) {
      toast(typeof e === "string" ? e : (e as Error)?.message || "The banks could not be read", "error");
    } finally { setBusy(false); load(); }
  };

  const off = accounts.filter((a) => Math.abs(a.drift ?? 0) >= 0.005).length;
  const lines = statusLines(banks, needs, off, unsorted);
  const good = accounts.length > 0 && off === 0 && needs === 0 && banks === 0;
  const when = check?.checked_at
    ? new Date(check.checked_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  if (accounts.length === 0 && lines.length === 0) return null;
  const did = fixedSentence(check?.fixed);
  return (
    <div className={`rounded-xl px-4 py-3.5 flex items-start gap-3 min-w-0 ${good ? "bg-success-bg" : "bg-surface-2"}`} role="status">
      {good
        ? <CheckCircle2 size={20} className="text-success-ink flex-shrink-0 mt-0.5" />
        : <AlertTriangle size={20} className="text-warning-ink flex-shrink-0 mt-0.5" />}
      <div className="min-w-0 flex-1">
        <div className={`text-[15px] font-medium ${good ? "text-success-ink" : "text-ink"}`}>
          {good ? "Your books match the bank"
            : accounts.length > 0 ? `${accounts.length - off} of ${accounts.length} accounts match the bank` : "Your books need a look"}
        </div>
        <div className="text-[12.5px] text-muted mt-0.5">
          {good ? `All ${accounts.length} accounts, to the cent.` : ""}{when ? ` ${good ? "Checked" : "Last checked"} ${when}.` : " Not checked against the bank yet."}{did ? ` ${did}` : ""}
        </div>
        {lines.length > 0 && (
          <div className="mt-2 space-y-1">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2 flex-wrap text-[13px] min-w-0">
                <span className="text-ink">{l.text}</span>
                <button onClick={() => onGo(l.go)} className="font-medium text-ink hover:opacity-70 underline underline-offset-2">{l.action}</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* R-685: named Check against bank again. As Check now he took the button to be gone. */}
      <Button onClick={run} disabled={busy} title="Reads every posted transaction, in and out, from your banks, puts the books right where it can, and lists what is still different">
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} /> {busy ? "Checking against the bank" : "Check against bank"}
      </Button>
    </div>
  );
}
