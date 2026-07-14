import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { fmtAmount } from "../lib/format";

// Payout panel for a completed deal flow. Reads the refund-aware breakdown from the
// local engine (deal_flow_payout) and lets an admin assign the lead rep and see the
// cut, the owner splits (after refunds), the refunded total, and what's still owed
// back. All refund ACTIONS live in RefundWorkspace now; this panel is read-only over
// the deal's stored figures — nothing here changes them.
export default function RefundPanel({ dealFlowId }: { dealFlowId: string }) {
  const [payout, setPayout] = useState<any>(null);
  const [reps, setReps] = useState<{ id: string; display_name: string }[]>([]);
  const [busy, setBusy] = useState(false);
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

  return (
    <div className="bg-surface border border-line rounded-xl px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-muted">
          Payout{enabled && payout.lead_rep_id ? " & Lead Rep" : ""}{refunded > 0 ? " · Refunded" : ""}
        </div>
        {refunded > 0 && (
          <span className="text-[11px] font-semibold text-danger-ink">
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

      {/* Owed-back banner — the refund workspace below is where you clear it */}
      {owed > 0 && (
        <div className="flex items-center justify-between text-[12px] bg-danger-bg border border-danger rounded-lg px-3 py-2">
          <span className="text-danger-ink font-medium">Owed back to customer</span>
          <span className="tabular-nums font-bold text-danger-ink">{fmtAmount(owed)}</span>
        </div>
      )}

      {err && <div className="text-[11.5px] text-danger-ink">{err}</div>}
    </div>
  );
}
