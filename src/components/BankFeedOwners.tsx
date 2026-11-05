import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, BankFeedAccount } from "../lib/api";
import { toast } from "./Toast";

// R-590: one bank link per account feeds the books. Jack's Mac and PC each held their own link to the same
// accounts; the bank gives one payment a different id on each, so payments arrived twice and each computer judged
// copies and retractions alone. Now one computer imports each account and the other stands by; everyone with
// Financials (his accountant, his brother's admin login) sees the one feed through sync. A standby computer takes
// over by itself after a day without a clean pull of that account by the feeding one, or here with one click.

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function BankFeedOwners({ version }: { version: number }) {
  const [rows, setRows] = useState<BankFeedAccount[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => { api.bankFeedOwners().then((r) => setRows(r.accounts)).catch(() => {}); };
  useEffect(() => { load(); }, [version]);

  const takeOver = async (a: BankFeedAccount) => {
    if (armed !== a.key) { setArmed(a.key); return; }
    setArmed(null);
    setBusy(a.key);
    try {
      await api.setBankFeedHere(a.key);
      toast(`This computer now brings in ${a.label}.`, "success");
      load();
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return null;
  return (
    <div className="border border-line-2 rounded-lg divide-y divide-line-2 min-w-0">
      <p className="px-3.5 py-2.5 text-[12px] text-muted leading-relaxed">
        One computer brings in each account, so no payment arrives twice. Everyone with Financials sees the same feed.
      </p>
      {rows.map((a) => (
        <div key={a.key} className="flex items-center gap-3 px-3.5 py-2.5 min-w-0 flex-wrap sm:flex-nowrap">
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
            <div className="text-ink truncate">{a.label}</div>
            <div className="text-[12px] text-ink-2">
              {a.here
                ? <>This computer brings it in.</>
                : a.set
                  ? <>{a.owner_name || "Another computer"} brings it in{a.last_pull ? `, last pulled ${when(a.last_pull)}` : ""}. This computer stands by.</>
                  : <>Not decided yet. The next bank pull decides it.</>}
            </div>
          </div>
          {!a.here && (
            <button
              onClick={() => takeOver(a)}
              disabled={busy !== null}
              className={`flex-shrink-0 h-8 px-3 rounded-lg text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-60 ${
                armed === a.key ? "bg-accent hover:bg-accent-hover text-on-accent" : "border border-line text-ink-2 hover:bg-surface-2"}`}
            >
              {busy === a.key ? <Loader2 size={13} className="animate-spin" /> : armed === a.key ? "Yes, use this computer" : "Bring it in here"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
