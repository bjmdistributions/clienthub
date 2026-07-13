import { useState } from "react";
import { X, ChevronRight, Loader2 } from "lucide-react";
import { api, Supplier, DealFlow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import CompletedBreakdown from "./CompletedBreakdown";

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
                              {new Date(d.completed_at).toLocaleDateString("en-US", {
                                month: "short", day: "numeric", year: "numeric",
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-5 sm:gap-7 flex-shrink-0">
                        <Stat label="Revenue" value={fmtAmount(d.gross_revenue)} />
                        <Stat
                          label="Profit"
                          value={fmtAmount(d.net_profit)}
                          clr={d.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}
                        />
                        {margin !== null && (
                          <Stat
                            label="Margin"
                            value={`${margin.toFixed(1)}%`}
                            clr={margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink"}
                          />
                        )}
                        <Stat label="Supplier" value={fmtAmount(d.supplier_amount)} />
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, clr = "text-ink" }: { label: string; value: string; clr?: string }) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={`text-[13px] font-semibold tabular-nums ${clr}`}>{value}</div>
    </div>
  );
}
