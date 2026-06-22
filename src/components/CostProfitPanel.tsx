import { DealFlow, ProfitSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";

/**
 * Shared Cost & Profit display used by both the Deal Flow complete panel and the
 * Invoice detail panel, so the two are visually identical and read the same
 * deal_flow rows (single source of truth). Renders the 4-col P&L grid plus the
 * profit-split breakdown when the deal is complete and profitable.
 */
export default function CostProfitPanel({
  flow,
  split,
}: {
  flow: DealFlow;
  split: ProfitSplit | null;
}) {
  const isComplete = flow.stage === "complete";
  const gross  = isComplete ? flow.gross_revenue : flow.payment_received_amount;
  const cost   = isComplete ? flow.total_cost    : flow.total_supplier_cost;
  const profit = gross - cost;
  const margin = gross > 0 ? (profit / gross) * 100 : 0;

  return (
    <div className="space-y-3">
      {/* P&L grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
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
            <div className="text-[10px] uppercase tracking-widest text-muted">{item.label}</div>
            <div className={`text-[16px] font-bold tabular-nums mt-0.5 ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Profit split preview */}
      {split && isComplete && profit > 0 && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3">
          <div className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">
            Profit Split
          </div>
          <div className="flex gap-6">
            {[
              { name: split.jack_name, val: flow.profit_jack    },
              { name: split.ben_name,  val: flow.profit_ben     },
              { name: "Business",      val: flow.profit_business },
            ].map((item) => (
              <div key={item.name}>
                <div className="text-[11px] text-muted">{item.name}</div>
                <div className="text-[13px] font-semibold text-success-ink tabular-nums">
                  {fmtAmount(item.val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
