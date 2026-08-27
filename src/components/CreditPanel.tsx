import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { fmtAmount, parseAmount } from "../lib/format";

// Customer store-credit: balance + ledger, with issue (owed to customer) and
// apply/use (drawn down toward a future deal). Overdraw is rejected by the engine.
export default function CreditPanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<any>(null);
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.getClientCredit(clientId)); }
    catch (e: any) { setErr(typeof e === "string" ? e : e?.message || "Failed to load credit"); }
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return null;
  const balance: number = data.balance || 0;
  const entries: any[] = data.entries || [];

  const act = (sign: number) => {
    const n = parseAmount(amt, NaN);
    if (!isFinite(n) || n <= 0) { setErr("Enter an amount."); return; }
    setBusy(true); setErr(null);
    api.addClientCredit(clientId, sign * n, { note: note || undefined })
      .then(() => { setAmt(""); setNote(""); return load(); })
      .catch((e: any) => setErr(typeof e === "string" ? e : e?.message || "Failed"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="bg-surface border border-line rounded-xl px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-muted">Store Credit</div>
        <div className={`text-[18px] font-bold tabular-nums ${balance > 0 ? "text-success-ink" : "text-ink"}`}>{fmtAmount(balance)}</div>
      </div>
      <button onClick={() => setOpen((o) => !o)} className="text-[12px] text-muted hover:text-ink-2 underline underline-offset-2">
        {open ? "Hide" : "Manage credit"}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line pt-2">
          <div className="flex items-center gap-2">
            <input type="text" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="Amount"
              className="bg-surface-2 border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink tabular-nums" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
              className="bg-surface-2 border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink" />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => act(1)} disabled={busy}
              className="flex-1 h-8 rounded-lg border border-line text-success-ink text-[12px] font-medium hover:bg-surface-2">Issue credit</button>
            <button onClick={() => act(-1)} disabled={busy}
              className="flex-1 h-8 rounded-lg border border-line text-ink text-[12px] font-medium hover:bg-surface-2">Apply / use</button>
          </div>
          <div className="text-[10.5px] text-muted leading-snug">
            Issue = money you owe the customer (e.g. instead of a cash refund). Apply = use it toward a deal.
          </div>
          {entries.length > 0 && (
            <div className="space-y-1 pt-1">
              {entries.slice(0, 8).map((e) => (
                <div key={e.id} className="flex items-center justify-between text-[11.5px] py-0.5">
                  <span className="text-muted">{e.kind}{e.note ? ` · ${e.note}` : ""}</span>
                  <span className={`tabular-nums ${e.amount < 0 ? "text-danger-ink" : "text-success-ink"}`}>{e.amount < 0 ? "−" : "+"}{fmtAmount(Math.abs(e.amount))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {err && <div className="text-[11.5px] text-danger-ink">{err}</div>}
    </div>
  );
}
