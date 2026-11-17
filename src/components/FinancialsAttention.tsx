import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle } from "lucide-react";
import { api } from "../lib/api";

// R-665 (Jack: "overall imporvements all aroubnd to ui and functionality"): one strip at the top of Financials that
// says what needs a person, each with the one place it is answered. Nothing is shown when nothing needs anything.
// - a bank that needs signing in to again, or stopped sending an account (answered in Setup, Fix connection);
// - accounts whose books do not agree with the bank (answered on Balances and tax, Why?);
// - this year's transactions with no category, which the tax figure leaves out (answered in To book).

type Go = "setup" | "report" | "tobook";

export interface AttentionItem { key: string; text: string; action: string; go: Go }

/** The lines to show, from the three counts. Kept apart from the reads so it can be tested. */
export function attentionItems(banks: number, off: number, unsorted: number): AttentionItem[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const out: AttentionItem[] = [];
  if (banks > 0) out.push({ key: "banks", text: `${n(banks, "bank needs", "banks need")} its connection fixed.`, action: "Fix connection", go: "setup" });
  if (off > 0) out.push({ key: "off", text: `${n(off, "account does", "accounts do")} not agree with the bank.`, action: "See why", go: "report" });
  if (unsorted > 0) out.push({ key: "unsorted", text: `${n(unsorted, "transaction is", "transactions are")} not in the tax figure yet.`, action: "Sort them", go: "tobook" });
  return out;
}

export default function FinancialsAttention({ reloadKey, onGo }: { reloadKey?: unknown; onGo: (tab: Go) => void }) {
  const [counts, setCounts] = useState<[number, number, number]>([0, 0, 0]);

  const load = () => {
    Promise.all([
      api.plaidHealth().then((h) => h.banks.filter((b) => b.needs_login || (b.dropped?.length ?? 0) > 0).length).catch(() => 0),
      api.reconcileAccounts().then((r) => r.filter((a) => a.baseline != null && Math.abs(a.drift) >= 0.005).length).catch(() => 0),
      api.financialsOverview()
        .then((v) => (v as { tax_extra?: { uncategorised_rows?: number } }).tax_extra?.uncategorised_rows ?? 0).catch(() => 0),
    ]).then(([banks, off, unsorted]) => setCounts([banks, off, unsorted]));
  };

  useEffect(() => {
    load();
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { load(); }).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
    return () => { dead = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const items = attentionItems(...counts);
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl bg-warning-bg px-4 py-3 flex items-start gap-3 min-w-0" role="status">
      <AlertTriangle size={18} className="text-warning-ink flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-2 flex-wrap text-[13px] min-w-0">
            <span className="text-ink">{it.text}</span>
            <button onClick={() => onGo(it.go)} className="font-medium text-ink hover:opacity-70 underline underline-offset-2">{it.action}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
