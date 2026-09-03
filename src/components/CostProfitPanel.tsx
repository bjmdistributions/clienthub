import { DealFlow, PayoutShare, dealPayoutSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";

/**
 * Cost & Profit display for the invoice detail drawer (via InvoiceCostSection), reading
 * the same deal_flow rows Deal Flow does (single source of truth). Renders the P&L grid
 * plus the config-driven payout-split breakdown when the deal is complete and profitable.
 * The split is derived from the org's configured recipients — no assumed split or partner
 * names, and hidden entirely when payouts aren't set up.
 *
 * LAYOUT: the P&L grid is **two columns, always**. It used to be `xl:grid-cols-4`, which is
 * a VIEWPORT query — and its only host is a fixed `w-[480px]` drawer. So on any window wider
 * than 1280px the grid split into four ~102px columns while the drawer stayed 480px, and a
 * 16px bold money figure (~110px for "$214,500.00") ran straight out through the card's
 * rounded border. Do not reintroduce a screen breakpoint here: the container width does not
 * follow the window. See gotchas — a viewport breakpoint inside a fixed-width panel.
 */
/** Step the type down for long figures rather than letting them overflow the card. */
const moneySize = (v: string) =>
  v.length <= 11 ? "text-[16px]" : v.length <= 14 ? "text-[15px]" : "text-[13px]";

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
      {/* P&L grid — two columns, always. See the LAYOUT note above. */}
      <div className="grid grid-cols-2 gap-2">
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
          <div key={item.label} className="bg-surface border border-line rounded-xl px-3 py-2.5 min-w-0">
            <div className="text-[12px] font-medium text-muted">{item.label}</div>
            {/* Money is never truncated — an unreadable figure is worse than a small one —
                so an unusually long value steps the type down instead of spilling. Two
                columns fit eight figures at 16px; the steps cover the rest. */}
            <div className={`${moneySize(item.value)} font-bold tabular-nums mt-0.5 ${item.clr}`}>{item.value}</div>
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
