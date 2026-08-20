import { useState } from "react";
import { X, ChevronRight, Loader2 } from "lucide-react";
import { api, Supplier, DealFlow } from "../lib/api";
import { fmtAmount, parseLocalDay } from "../lib/format";
import CompletedBreakdown from "./CompletedBreakdown";

// Fixed columns, shared by the header row, every deal row and the totals row —
// auto-width figures put each label and value at a different x on every line.
const STAT_GRID = "grid grid-cols-[104px_104px_60px_104px] gap-x-6 flex-shrink-0 text-right items-baseline";

/** −$4,300.00, not $-4,300.00 — the sign convention used on the suppliers table. */
const signedAmount = (n: number) => `${n < 0 ? "−" : ""}${fmtAmount(Math.abs(n))}`;

// Large-screen browser for a supplier's completed deals. Launched from the
// suppliers drawer; stacks above it (z-60) so the narrow drawer stays mounted.
export default function SupplierDealsModal({
  supplier,
  deals,
  onClose,
  onReload,
}: {
  supplier: Supplier;
  deals: any[];
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const [expandedDealId,  setExpandedDealId]  = useState<string | null>(null);
  const [dealFlow,        setDealFlow]        = useState<DealFlow | null>(null);
  const [dealFlowLoading, setDealFlowLoading] = useState(false);

  // Thin supplier-deal rows lack the full P&L, so fetch the whole flow on expand.
  const toggleDeal = async (dealId: string) => {
    if (expandedDealId === dealId) {
      setExpandedDealId(null);
      setDealFlow(null);
      return;
    }
    setExpandedDealId(dealId);
    setDealFlow(null);
    setDealFlowLoading(true);
    try {
      setDealFlow(await api.getDealFlow(dealId));
    } catch {
      setDealFlow(null);
    } finally {
      setDealFlowLoading(false);
    }
  };

  // Refresh the parent supplier totals, then re-fetch the currently-open flow so
  // Reopen/Delete/edits inside the breakdown stay in sync in both places.
  const handleReload = async () => {
    await onReload();
    if (expandedDealId) {
      setDealFlow(await api.getDealFlow(expandedDealId).catch(() => null));
    }
  };

  // Footer totals. `supplier_amount` is what this supplier was paid; revenue and
  // profit are the whole deal's, so the blended margin here is the deal-side one.
  const totals = deals.reduce(
    (a: { revenue: number; profit: number; paid: number }, d: any) => ({
      revenue: a.revenue + (Number(d.gross_revenue)   || 0),
      profit:  a.profit  + (Number(d.net_profit)      || 0),
      paid:    a.paid    + (Number(d.supplier_amount) || 0),
    }),
    { revenue: 0, profit: 0, paid: 0 },
  );
  const totalMargin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-[92vw] max-w-[1100px] max-h-[88vh] flex flex-col rounded-2xl bg-surface border border-line shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-line sticky top-0 bg-surface z-10">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink truncate">{supplier.name}</h3>
            <p className="text-[12px] text-muted mt-0.5">
              {deals.length} completed deal{deals.length !== 1 ? "s" : ""}
            </p>
            <p className="text-[11px] text-faint mt-0.5">
              Revenue and profit are the whole deal's, before refunds. The last column is what this supplier was paid.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {deals.length === 0 ? (
            <div className="px-6 py-16 text-center text-[13px] text-muted">
              No completed deals with this supplier yet
            </div>
          ) : (
            <div className="divide-y divide-line-2">
              {/* One header row instead of a label repeated on every figure. */}
              <div className="flex items-center gap-4 px-6 py-2 sticky top-0 z-[1] bg-surface-2/60 backdrop-blur-sm">
                <div className="w-[13px] flex-shrink-0" />
                <div className="flex-1 min-w-0 text-[11px] font-medium text-muted">Deal</div>
                <div className={`${STAT_GRID} text-[11px] font-medium text-muted`}>
                  <div>Revenue</div>
                  <div>Profit</div>
                  <div>Margin</div>
                  <div>Paid them</div>
                </div>
              </div>
              {deals.map((d: any) => {
                const margin = d.gross_revenue > 0
                  ? (d.net_profit / d.gross_revenue) * 100
                  : null;
                const open = expandedDealId === d.id;
                return (
                  <div key={d.id}>
                    <button
                      onClick={() => toggleDeal(d.id)}
                      className="w-full flex items-center gap-4 px-6 py-4 text-left hover:bg-surface-2/40 transition-colors"
                    >
                      <ChevronRight
                        size={13}
                        className={`text-faint flex-shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">
                          {d.client_name || "—"}
                        </div>
                        <div className="text-[11px] text-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
                          {d.invoice_number && (
                            <span className="bg-surface-3 px-1.5 py-0.5 rounded text-ink-2">
                              {d.invoice_number}
                            </span>
                          )}
                          {d.completed_at && (
                            <span>
                              {parseLocalDay(d.completed_at).toLocaleDateString("en-US", {
                                month: "short", day: "numeric", year: "numeric",
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={STAT_GRID}>
                        <Stat value={fmtAmount(d.gross_revenue)} />
                        <Stat
                          value={signedAmount(d.net_profit)}
                          clr={d.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}
                        />
                        <Stat
                          value={margin === null ? "—" : `${margin.toFixed(1)}%`}
                          clr={
                            margin === null ? "text-faint"
                            : margin >= 20 ? "text-success-ink"
                            : margin >= 10 ? "text-warning-ink"
                            : "text-danger-ink"
                          }
                        />
                        <Stat value={fmtAmount(d.supplier_amount)} />
                      </div>
                    </button>

                    {open && (
                      <div className="border-t border-line-2 bg-surface-2/40 px-6 py-5">
                        {dealFlowLoading ? (
                          <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted">
                            <Loader2 size={14} className="animate-spin" /> Loading breakdown…
                          </div>
                        ) : dealFlow ? (
                          <CompletedBreakdown flow={dealFlow} onReload={handleReload} />
                        ) : (
                          <div className="py-8 text-center text-[12px] text-muted">
                            Couldn't load this deal's breakdown
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {deals.length > 1 && (
                <div className="flex items-center gap-4 px-6 py-3 bg-surface-2/40">
                  <div className="w-[13px] flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-[12px] font-medium text-ink-2">Total</div>
                  <div className={STAT_GRID}>
                    <Stat value={fmtAmount(totals.revenue)} />
                    <Stat
                      value={signedAmount(totals.profit)}
                      clr={totals.profit >= 0 ? "text-success-ink" : "text-danger-ink"}
                    />
                    <Stat
                      value={totalMargin === null ? "—" : `${totalMargin.toFixed(1)}%`}
                      clr={totalMargin === null ? "text-faint" : "text-ink-2"}
                    />
                    <Stat value={fmtAmount(totals.paid)} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, clr = "text-ink" }: { value: string; clr?: string }) {
  return <div className={`text-[13px] font-semibold tabular-nums ${clr}`}>{value}</div>;
}
