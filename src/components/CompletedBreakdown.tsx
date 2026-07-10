import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api, DealFlow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";
import RefundPanel from "./RefundPanel";

// ─── Completed deal full breakdown ────────────────────────────────────────
// Shared by DealFlowView's completed list and the supplier deal history.
export default function CompletedBreakdown({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [saving, setSaving] = useState(false);

  const margin = flow.gross_revenue > 0 ? (flow.net_profit / flow.gross_revenue) * 100 : 0;
  const payments = flow.supplier_payments || [];

  // Current payout routing for this completed deal, flippable in place — so deals
  // completed under the old silent default (excluded → 100% business) can adopt the
  // configured split without uncomplete→recomplete.
  const payoutIncluded = (() => { try { return !!JSON.parse((flow as any).metadata || "{}").payout_included; } catch { return false; } })();
  const setIncluded = async (v: boolean) => {
    if (v === payoutIncluded || saving) return;
    setSaving(true);
    try { await api.setDealPayoutIncluded(flow.id, v); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleReopen = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this completed deal? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* Payout routing — flip past deals onto (or off) the configured split */}
      <div className="space-y-1">
        <div className="text-[11px] text-muted">Where does this deal's profit go?</div>
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
          <button type="button" disabled={saving} onClick={() => setIncluded(true)}
            className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            Apply profit split
          </button>
          <button type="button" disabled={saving} onClick={() => setIncluded(false)}
            className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${!payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            Business keeps 100%
          </button>
        </div>
      </div>

      {/* P&L summary */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          { label: "Revenue",                                    value: fmtAmount(flow.gross_revenue), clr: "text-ink"   },
          { label: "Total costs",                                value: fmtAmount(flow.total_cost),    clr: "text-ink"   },
          {
            label: flow.net_profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(flow.net_profit),
            clr:   flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink",
          },
        ].map((item) => (
          <div key={item.label} className="bg-surface border border-line rounded-xl px-4 py-3">
            <div className="text-[12px] font-medium text-muted">{item.label}</div>
            <div className={`text-[18px] font-bold tabular-nums mt-1 ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Supplier breakdown */}
      {payments.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line-2">
            <SectionLabel>Supplier Payments</SectionLabel>
          </div>
          <div className="divide-y divide-line-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink font-medium">{p.supplier_name}</div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-muted tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(p.amount)}</div>
              </div>
            ))}
            <div className="flex justify-between items-center px-4 py-2.5 bg-surface-2/60">
              <span className="text-[11px] text-muted font-medium">Total supplier cost</span>
              <span className="text-[12px] font-bold text-ink tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Payout, lead rep & refunds (refund-aware owner split) */}
      <RefundPanel dealFlowId={flow.id} />

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleReopen}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                     px-3 h-8 border border-line rounded-lg hover:bg-surface-2 transition-colors"
        >
          <RotateCcw size={12} /> Reopen
        </button>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-danger-ink hover:text-danger-ink
                     px-3 h-8 border border-danger rounded-lg hover:bg-danger-bg transition-colors ml-auto"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-semibold text-ink-2 mb-0.5">
      {children}
    </div>
  );
}
