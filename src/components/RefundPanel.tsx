import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { DealPayoutsBox } from "./PayoutLedger";

// Payout panel for a completed deal flow. R-577: who gets paid what comes from the server's
// ledger (DealPayoutsBox: the reps and their shares, each line, any amount typed over); what is
// still owed back to the buyer is read here. All refund ACTIONS live in RefundWorkspace.
export default function RefundPanel({ dealFlowId, refreshKey }: { dealFlowId: string; refreshKey?: unknown }) {
  const [owed, setOwed] = useState(0);
  useEffect(() => {
    api.dealFlowPayout(dealFlowId).then((p) => setOwed(Number(p?.owed_remaining) || 0)).catch(() => {});
  }, [dealFlowId, refreshKey]);
  return (
    <div className="space-y-2">
      <DealPayoutsBox dealFlowId={dealFlowId} refreshKey={refreshKey} fallback={<LocalPayoutPanel dealFlowId={dealFlowId} />} />
      {/* Owed-back banner: the refund workspace below is where you clear it */}
      {owed > 0 && (
        <div className="flex items-center justify-between text-[12px] bg-danger-bg border border-danger rounded-lg px-3 py-2">
          <span className="text-danger-ink font-medium">Owed back to customer</span>
          <span className="tabular-nums font-medium text-danger-ink">{fmtAmount(owed)}</span>
        </div>
      )}
    </div>
  );
}

// The breakdown as this computer works it out (deal_flow_payout), for when the server cannot
// answer: offline, or an account that is not an admin.
function LocalPayoutPanel({ dealFlowId }: { dealFlowId: string }) {
  const [payout, setPayout] = useState<any>(null);
  const [reps, setReps] = useState<{ id: string; display_name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPayout(await api.dealFlowPayout(dealFlowId));
    } catch (e: any) {
      setErr(typeof e === "string" ? e : e?.message || "Failed to load payout");
    }
  }, [dealFlowId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.listDealReps().then(setReps).catch(() => {}); }, []);

  if (!payout) return null;

  const refunded: number = payout.refunded || 0;
  const enabled: boolean = !!payout.rep_payouts_enabled;
  const splits: { name: string; amount: number }[] = payout.splits || [];
  const repCut: number = payout.rep_cut || 0;
  const unmatched: boolean = !!payout.rep_unmatched;
  const unmatchedName: string = payout.unmatched_rep_name || "";


  return (
    <div className="py-1 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-muted">
          Payout{enabled && payout.lead_rep_id ? " & Lead Rep" : ""}{refunded > 0 ? " · Refunded" : ""}
        </div>
        {refunded > 0 && (
          <span className="text-[12px] font-medium text-danger-ink">
            −{fmtAmount(refunded)} refunded
          </span>
        )}
      </div>

      {/* Lead rep assignment + cut */}
      {enabled && (
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">Lead rep</span>
          <div className="flex items-center gap-2">
            {/* R-577: shown, never changed here; a deal's reps are set on its Payouts box. */}
            <span className="text-ink">{payout.lead_rep_name || reps.find((r) => r.id === payout.lead_rep_id)?.display_name || "No rep"}</span>
            {payout.lead_rep_id && (
              <span className="tabular-nums font-medium text-ink">
                {fmtAmount(repCut)}
                <span className="text-muted font-normal ml-1 text-[11px]">
                  {payout.pay_type === "gross_pct" ? `${payout.commission_pct}% gross` : payout.pay_type === "fixed" ? "fixed" : `${payout.commission_pct}% profit`}
                  {payout.keep_rep_cut ? " · kept" : ""}
                </span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* R-401: the logistics pay comes off the top beside the rep's cut */}
      {(Math.abs(Number(payout.logistics_pay)) > 0.005 || payout.logistics_pay_pending) && (
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">Logistics pay</span>
          <span className="tabular-nums font-medium text-ink">
            {payout.logistics_pay_pending ? "Waiting on the freight amount" : `${Number(payout.logistics_pay) < 0 ? "-" : ""}${fmtAmount(Math.abs(Number(payout.logistics_pay)))}`}
          </span>
        </div>
      )}

      {/* Unmatched rep — the client's rep isn't an employee in the system */}
      {enabled && unmatched && (
        <div className="flex items-start gap-2 bg-warning-bg border border-warning rounded-lg px-3 py-2">
          <span className="text-[12px] text-warning-ink leading-snug">
            Rep <strong>"{unmatchedName}"</strong> on this client isn't an employee. No payout is calculated for them. Fix the spelling on the client, or add/invite them under <strong>Settings → Team</strong>.
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
                <div className={`text-[16px] font-medium tabular-nums mt-0.5 ${s.amount < 0 ? "text-danger-ink" : "text-success-ink"}`}>
                  {fmtAmount(s.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <div className="text-[12px] text-danger-ink">{err}</div>}
    </div>
  );
}
