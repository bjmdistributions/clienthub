import { useEffect, useState, useCallback } from "react";
import { api, DealFlow } from "../lib/api";
import { fmtAmount, parseAmount } from "../lib/format";

// Customer store-credit: balance + ledger, with issue (owed to customer) and
// apply/use (drawn down toward a future deal). Overdraw is rejected by the engine.
// When a credit was raised — the invoice form prints the same date on the line it adds,
// so the customer's invoice and this ledger say the same thing.
const fmtDay = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export default function CreditPanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<any>(null);
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Provenance (Jack: "link financials to everything that happens on the program") —
  // which deal a credit came from (Issue) or is being drawn down against (Apply).
  const [deals, setDeals] = useState<DealFlow[]>([]);
  const [fromDeal, setFromDeal] = useState("");
  const [appliedDeal, setAppliedDeal] = useState("");

  const load = useCallback(async () => {
    try { setData(await api.getClientCredit(clientId)); }
    catch (e: any) { setErr(typeof e === "string" ? e : e?.message || "Failed to load credit"); }
  }, [clientId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.listDealFlows().then((all) => setDeals(all.filter((d) => d.client_id === clientId))).catch(() => {});
  }, [clientId]);

  if (!data) return null;
  const balance: number = data.balance || 0;
  const entries: any[] = data.entries || [];
  const dealLabel = (d: DealFlow) => `#${d.invoice_number || "–"} · ${fmtAmount(d.invoice_total)}`;
  const dealNo = (id: string) => deals.find((d) => d.id === id)?.invoice_number || "";

  const act = (sign: number) => {
    const n = parseAmount(amt, NaN);
    if (!isFinite(n) || n <= 0) { setErr("Enter an amount."); return; }
    setBusy(true); setErr(null);
    const opts: { note?: string; sourceDealFlowId?: string; appliedDealFlowId?: string } = { note: note || undefined };
    if (sign > 0 && fromDeal) opts.sourceDealFlowId = fromDeal;
    if (sign < 0 && appliedDeal) opts.appliedDealFlowId = appliedDeal;
    api.addClientCredit(clientId, sign * n, opts)
      .then(() => { setAmt(""); setNote(""); setFromDeal(""); setAppliedDeal(""); return load(); })
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
          {deals.length > 0 && (
            <div className="flex items-center gap-2">
              <select value={fromDeal} onChange={(e) => setFromDeal(e.target.value)}
                className="bg-surface-2 border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink-2">
                <option value="">From deal (optional)</option>
                {deals.map((d) => <option key={d.id} value={d.id}>{dealLabel(d)}</option>)}
              </select>
              <select value={appliedDeal} onChange={(e) => setAppliedDeal(e.target.value)}
                className="bg-surface-2 border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink-2">
                <option value="">Applied to deal (optional)</option>
                {deals.map((d) => <option key={d.id} value={d.id}>{dealLabel(d)}</option>)}
              </select>
            </div>
          )}
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
                <div key={e.id} className="flex items-center justify-between text-[11.5px] py-0.5 gap-2">
                  <span className="text-muted min-w-0 truncate" title={e.note || undefined}>
                    {fmtDay(e.created_at)}{fmtDay(e.created_at) ? " · " : ""}{e.kind}
                    {e.source_deal_flow_id && dealNo(e.source_deal_flow_id) ? ` · from #${dealNo(e.source_deal_flow_id)}` : ""}
                    {e.applied_deal_flow_id && dealNo(e.applied_deal_flow_id) ? ` · applied to #${dealNo(e.applied_deal_flow_id)}` : ""}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
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
