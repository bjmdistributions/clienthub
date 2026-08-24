import { DealFlow, PayoutShare, dealPayoutSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";

/**
 * Shared Cost & Profit display used by both the Deal Flow complete panel and the
 * Invoice detail panel, so the two are visually identical and read the same
 * deal_flow rows (single source of truth). Renders the 4-col P&L grid plus the
 * config-driven payout-split breakdown when the deal is complete and profitable.
 * The split is derived from the org's configured recipients — no assumed split
 * or partner names, and hidden entirely when payouts aren't set up.
 */
export default function CostProfitPanel({
  flow,
  recipients,
  fallbackRevenue,
}: {
  flow: DealFlow;
  recipients: PayoutShare[];
  /**
   * Revenue to measure against while the deal is open and the buyer has not paid yet.
   * Without it an unpaid invoice reads as a total loss — the deal's costs against zero
   * revenue. True of the cash that has moved, and useless as a margin.
   */
  fallbackRevenue?: number;
}) {
  const isComplete = flow.stage === "complete";
  const gross  = isComplete
    ? flow.gross_revenue
    : (flow.payment_received_amount > 0 ? flow.payment_received_amount : (fallbackRevenue ?? 0));
  const cost   = isComplete ? flow.total_cost    : flow.total_supplier_cost;
  const profit = gross - cost;
  const margin = gross > 0 ? (profit / gross) * 100 : 0;
  // Completed deals show the breakdown captured at completion; older deals
  // (no stored breakdown) fall back to re-deriving from the current config.
  const alloc  = dealPayoutSplit(flow, recipients);

  return (
    <div className="space-y-3">
      {/* P&L grid */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
        {[
          { label: "Revenue", value: fmtAmount(gross), clr: "text-ink" },
          { label: "Costs",   value: fmtAmount(cost),  clr: "text-ink" },
          {
            label: profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(profit),
            clr:   profit >= 0 ? "text-success-ink" : "text-danger-ink",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink",
          },
        ].map((item) => (
          <div key={item.label} className="bg-surface border border-line rounded-xl px-3 py-2.5">
            <div className="text-[12px] font-medium text-muted">{item.label}</div>
            <div className={`text-[16px] font-bold tabular-nums mt-0.5 ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Profit split preview — config-driven; hidden until payouts are set up */}
      {isComplete && profit > 0 && alloc.length > 0 && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3">
          <div className="text-[12.5px] font-medium text-muted mb-2">
            Profit Split
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {alloc.map((item, i) => (
              <div key={i}>
                <div className="text-[11px] text-muted">{item.name}</div>
                <div className="text-[13px] font-semibold text-success-ink tabular-nums">
                  {fmtAmount(item.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
