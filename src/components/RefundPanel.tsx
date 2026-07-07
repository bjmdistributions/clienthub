import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";

// Self-contained payout + refund panel for a completed deal flow. Reads the
// refund-aware breakdown from the local engine (deal_flow_payout) and lets an
// admin assign the lead rep, record full/partial refunds (with the keep-rep-cut
// option), see what's still owed back, and remove a mistaken refund. Non-
// destructive: the deal's stored figures never change — everything is computed
// on top of the refunds.
export default function RefundPanel({ dealFlowId }: { dealFlowId: string }) {
  const [payout, setPayout] = useState<any>(null);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [reps, setReps] = useState<{ id: string; display_name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [amt, setAmt] = useState("");
  const [method, setMethod] = useState("");
  const [source, setSource] = useState("business");
  const [keepCut, setKeepCut] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, rf] = await Promise.all([api.dealFlowPayout(dealFlowId), api.listRefunds(dealFlowId)]);
      setPayout(p);
      setRefunds(rf || []);
    } catch (e: any) {
      setErr(typeof e === "string" ? e : e?.message || "Failed to load payout");
    }
  }, [dealFlowId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.listDealReps().then(setReps).catch(() => {}); }, []);

  if (!payout) return null;

  const refunded: number = payout.refunded || 0;
  const owed: number = payout.owed_remaining || 0;
  const enabled: boolean = !!payout.rep_payouts_enabled;
  const splits: { name: string; amount: number }[] = payout.splits || [];
  const repCut: number = payout.rep_cut || 0;
  const unmatched: boolean = !!payout.rep_unmatched;
  const unmatchedName: string = payout.unmatched_rep_name || "";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e: any) { setErr(typeof e === "string" ? e : e?.message || "Something went wrong"); }
    finally { setBusy(false); }
  };

  const recordRefund = () => {
    const n = parseFloat(amt.replace(/,/g, ""));
    if (!isFinite(n) || n <= 0) { setErr("Enter a refund amount."); return; }
    run(async () => {
      await api.createRefund(dealFlowId, n, { method: method || undefined, source, keepRepCut: keepCut, reason: reason || undefined });
      setAmt(""); setReason("");
    });
  };

  return (
    <div className="bg-surface border border-line rounded-xl px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-muted">
          Payout{enabled && payout.lead_rep_id ? " & Lead Rep" : ""}{refunded > 0 ? " · Refunded" : ""}
        </div>
        {refunded > 0 && (
          <span className="text-[10px] font-semibold text-danger-ink uppercase tracking-wide">
            −{fmtAmount(refunded)} refunded
          </span>
        )}
      </div>

      {/* Lead rep assignment + cut */}
      {enabled && (
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">Lead rep</span>
          <div className="flex items-center gap-2">
            <select
              value={payout.lead_rep_id || ""}
              disabled={busy}
              onChange={(e) => run(async () => { await api.setDealLeadRep(dealFlowId, e.target.value || null); })}
              className="bg-surface-2 border border-line rounded-lg h-7 px-2 text-[12px] text-ink"
            >
              <option value="">— Unassigned —</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.display_name}</option>)}
            </select>
            {payout.lead_rep_id && (
              <span className="tabular-nums font-semibold text-ink">
                {fmtAmount(repCut)}
                <span className="text-muted font-normal ml-1 text-[10px]">
                  {payout.pay_type === "gross_pct" ? `${payout.commission_pct}% gross` : payout.pay_type === "fixed" ? "fixed" : `${payout.commission_pct}% profit`}
                  {payout.keep_rep_cut ? " · kept" : ""}
                </span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Unmatched rep — the client's rep isn't an employee in the system */}
      {enabled && unmatched && (
        <div className="flex items-start gap-2 bg-warning-bg border border-warning rounded-lg px-3 py-2">
          <span className="text-[12px] text-warning-ink leading-snug">
            Rep <strong>“{unmatchedName}”</strong> on this client isn't an employee — no payout is calculated for them. Fix the spelling on the client, or add/invite them under <strong>Settings → Team</strong>.
          </span>
        </div>
      )}

      {/* Owner splits (after rep + refund) — config-driven; hidden until payouts
          are set up so we never show an assumed split or partner names. */}
      {splits.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-muted mb-2">
            Owner split{refunded > 0 ? " (after refund)" : ""}
          </div>
          <div className="flex flex-wrap gap-4 text-center">
            {splits.map((s, i) => (
              <div key={i} className="flex-1 min-w-[80px]">
                <div className="text-[12px] text-muted truncate">{s.name}</div>
                <div className={`text-[16px] font-bold tabular-nums mt-0.5 ${s.amount < 0 ? "text-danger-ink" : "text-success-ink"}`}>
                  {fmtAmount(s.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Owed-back banner */}
      {owed > 0 && (
        <div className="flex items-center justify-between text-[12px] bg-danger-bg border border-danger rounded-lg px-3 py-2">
          <span className="text-danger-ink font-medium">Owed back to customer</span>
          <span className="tabular-nums font-bold text-danger-ink">{fmtAmount(owed)}</span>
        </div>
      )}

      {/* Refund controls */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[12px] text-muted hover:text-ink-2 underline underline-offset-2"
      >
        {open ? "Hide refund controls" : "Refund this deal"}
      </button>

      {open && (
        <div className="space-y-3 border-t border-line pt-3">
          {/* Owed obligation */}
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-muted whitespace-nowrap">Owe back total</span>
            <input
              type="number"
              defaultValue={payout.refund_owed || ""}
              onBlur={(e) => { const v = parseFloat(e.target.value); if (isFinite(v)) run(async () => { await api.setRefundOwed(dealFlowId, v); }); }}
              placeholder="0.00"
              className="bg-surface-2 border border-line rounded-lg h-7 px-2 w-28 text-[12px] text-ink tabular-nums"
            />
            <button
              onClick={() => run(async () => { await api.setRefundOwed(dealFlowId, payout.net_profit); })}
              disabled={busy}
              className="text-[11px] text-muted hover:text-ink-2 px-2 h-7 border border-line rounded-lg"
            >
              Full ({fmtAmount(payout.net_profit)})
            </button>
          </div>

          {/* Add a refund */}
          <div className="space-y-2 bg-surface-2 rounded-lg p-2.5">
            <div className="flex items-center gap-2">
              <input
                type="number" value={amt} onChange={(e) => setAmt(e.target.value)}
                placeholder="Refund amount"
                className="bg-surface border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink tabular-nums"
              />
              <select value={source} onChange={(e) => setSource(e.target.value)} className="bg-surface border border-line rounded-lg h-8 px-2 text-[12px] text-ink">
                <option value="business">From business</option>
                <option value="supplier">Supplier reversal</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Method (optional)"
                className="bg-surface border border-line rounded-lg h-8 px-2 flex-1 text-[12px] text-ink"
              />
              <label className="flex items-center gap-1.5 text-[11.5px] text-muted whitespace-nowrap cursor-pointer">
                <input type="checkbox" checked={keepCut} onChange={(e) => setKeepCut(e.target.checked)} />
                Keep rep's cut
              </label>
            </div>
            <input
              value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)"
              className="bg-surface border border-line rounded-lg h-8 px-2 w-full text-[12px] text-ink"
            />
            <button
              onClick={recordRefund} disabled={busy}
              className="w-full h-8 rounded-lg bg-danger-bg border border-danger text-danger-ink text-[12px] font-medium hover:opacity-90"
            >
              Record refund
            </button>
            <div className="text-[10.5px] text-muted leading-snug">
              Removes net profit for the owners and the rep. Tick <em>keep rep's cut</em> if the rep was already paid — then the owners absorb it.
            </div>
          </div>

          {/* Existing refunds */}
          {refunds.length > 0 && (
            <div className="space-y-1">
              {refunds.map((r) => (
                <div key={r.id} className="flex items-center justify-between text-[11.5px] py-1 border-b border-line last:border-0">
                  <span className="text-ink tabular-nums">
                    {fmtAmount(r.amount)}
                    <span className="text-muted ml-2">{r.source === "supplier" ? "supplier" : "business"}{r.keep_rep_cut ? " · kept cut" : ""}{r.reason ? ` · ${r.reason}` : ""}</span>
                  </span>
                  <button onClick={() => run(async () => { await api.deleteRefund(r.id); })} className="text-muted hover:text-danger-ink text-[11px]">remove</button>
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
