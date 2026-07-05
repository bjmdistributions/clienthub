import { useEffect, useState } from "react";
import { api, DealFlow, ProfitSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";
import {
  CheckCircle2, RefreshCw, ChevronDown, RotateCcw, Trash2,
  TrendingUp, DollarSign, Package,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────
function pct(n: number, d: number) { return d > 0 ? (n / d) * 100 : 0; }

function MarginBadge({ margin }: { margin: number }) {
  const cls =
    margin >= 30 ? "bg-success-bg text-success-ink" :
    margin >= 15 ? "bg-warning-bg text-warning-ink" :
    margin >= 0  ? "bg-danger-bg text-danger-ink" :
                   "bg-danger-bg text-danger-ink";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>
      {margin.toFixed(1)}%
    </span>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────
export default function CloseoutView() {
  const [flows,   setFlows]   = useState<DealFlow[]>([]);
  const [split,   setSplit]   = useState<ProfitSplit | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [f, sp] = await Promise.all([api.listDealFlows(), api.getProfitSplit()]);
      setFlows(f.filter((fl) => fl.stage === "complete"));
      setSplit(sp);
    } catch (e) { console.error(e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // ── Analytics ────────────────────────────────────────────────────────────
  const totalRevenue = flows.reduce((s, f) => s + f.gross_revenue, 0);
  const totalCost    = flows.reduce((s, f) => s + f.total_cost, 0);
  const totalProfit  = flows.reduce((s, f) => s + f.net_profit, 0);
  const avgMargin    = pct(totalProfit, totalRevenue);

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <RefreshCw size={15} className="text-faint animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Completed deals</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {flows.length} deal{flows.length !== 1 ? "s" : ""} closed
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                     px-2.5 py-1.5 rounded-lg hover:bg-surface-3 transition-colors"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* ── Analytics cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          {
            label: "Total Revenue",
            value: fmtAmount(totalRevenue),
            icon: DollarSign,
            color: "text-ink",
            bg:    "bg-accent/10",
            ic:    "text-accent",
          },
          {
            label: "Total Cost",
            value: fmtAmount(totalCost),
            icon: Package,
            color: "text-ink",
            bg:    "bg-warning-bg",
            ic:    "text-warning-ink",
          },
          {
            label: "Net Profit",
            value: fmtAmount(totalProfit),
            icon: TrendingUp,
            color: totalProfit >= 0 ? "text-success-ink" : "text-danger-ink",
            bg:    totalProfit >= 0 ? "bg-success-bg" : "bg-danger-bg",
            ic:    totalProfit >= 0 ? "text-success-ink" : "text-danger-ink",
          },
          {
            label: "Avg Margin",
            value: `${avgMargin.toFixed(1)}%`,
            icon: CheckCircle2,
            color: avgMargin >= 20 ? "text-success-ink" : avgMargin >= 10 ? "text-warning-ink" : "text-danger-ink",
            bg:    avgMargin >= 20 ? "bg-success-bg" : avgMargin >= 10 ? "bg-warning-bg" : "bg-danger-bg",
            ic:    avgMargin >= 20 ? "text-success-ink" : avgMargin >= 10 ? "text-warning-ink" : "text-danger-ink",
          },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-surface border border-line rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[12.5px] font-medium text-muted">
                  {card.label}
                </p>
                <div className={`w-7 h-7 rounded-lg ${card.bg} flex items-center justify-center`}>
                  <Icon size={13} className={card.ic} />
                </div>
              </div>
              <p className={`text-[22px] font-bold tabular-nums leading-none ${card.color}`}>
                {card.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* ── Deals table ─────────────────────────────────────────────────── */}
      {flows.length === 0 ? (
        <div className="text-center py-24">
          <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 size={18} className="text-faint" />
          </div>
          <p className="text-[15px] font-semibold text-ink-2 mb-1">No completed deals yet</p>
          <p className="text-[13px] text-muted">
            Deals appear here once you mark them complete in Deal Flow
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {flows.map((flow) => {
            const margin = pct(flow.net_profit, flow.gross_revenue);
            const isExp  = expanded === flow.id;
            return (
              <div
                key={flow.id}
                className="bg-surface border border-line rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow"
              >
                {/* Summary row */}
                <button
                  onClick={() => setExpanded(isExp ? null : flow.id)}
                  className="w-full px-5 py-4 text-left hover:bg-surface-2/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-4">
                    {/* Left: client + invoice info */}
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-ink truncate">
                        {flow.client_name || "—"}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5 flex items-center gap-2 flex-wrap">
                        <span className="font-mono bg-surface-3 px-1.5 py-0.5 rounded text-ink-2">
                          {flow.invoice_number}
                        </span>
                        {flow.completed_at && (
                          <span>
                            Completed {new Date(flow.completed_at).toLocaleDateString("en-US", {
                              month: "short", day: "numeric", year: "numeric",
                            })}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right: financial summary */}
                    <div className="flex items-center gap-6 flex-shrink-0">
                      <div className="text-right hidden sm:block">
                        <div className="text-[12px] font-medium text-muted">Revenue</div>
                        <div className="text-[13px] font-semibold text-ink tabular-nums">
                          {fmtAmount(flow.gross_revenue)}
                        </div>
                      </div>
                      <div className="text-right hidden sm:block">
                        <div className="text-[12px] font-medium text-muted">Cost</div>
                        <div className="text-[13px] text-muted tabular-nums">
                          {fmtAmount(flow.total_cost)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[12px] font-medium text-muted">Profit</div>
                        <div className={`text-[14px] font-bold tabular-nums ${
                          flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"
                        }`}>
                          {fmtAmount(flow.net_profit)}
                        </div>
                      </div>
                      <MarginBadge margin={margin} />
                      <ChevronDown
                        size={14}
                        className={`text-faint transition-transform duration-200 flex-shrink-0 ${isExp ? "rotate-180" : ""}`}
                      />
                    </div>
                  </div>
                </button>

                {/* Expanded breakdown */}
                {isExp && (
                  <div className="border-t border-line bg-surface-2/50 px-5 py-5">
                    <DealBreakdown flow={flow} split={split} onReload={load} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Expanded deal breakdown ──────────────────────────────────────────────────
function DealBreakdown({
  flow, split, onReload,
}: { flow: DealFlow; split: ProfitSplit | null; onReload: () => void }) {
  const [saving, setSaving] = useState(false);
  const payments = flow.supplier_payments || [];
  const margin   = pct(flow.net_profit, flow.gross_revenue);

  // Editable completion date for backlogs
  const todayStr = new Date().toISOString().slice(0, 10);
  const initialDate = flow.completed_at ? flow.completed_at.slice(0, 10) : todayStr;
  const [editDate, setEditDate] = useState(initialDate);
  const [dateSaving, setDateSaving] = useState(false);

  const handleSaveDate = async () => {
    if (!editDate) return;
    setDateSaving(true);
    try { await api.updateDealCompletedAt(flow.id, editDate); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setDateSaving(false);
  };

  const handleReopen = async () => {
    if (!confirm("Reopen this deal? It will move back to the active Deal Flow.")) return;
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Permanently delete this deal record? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* P&L grid */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          { label: "Revenue",                                      value: fmtAmount(flow.gross_revenue), clr: "text-ink"   },
          { label: "Total Cost",                                   value: fmtAmount(flow.total_cost),    clr: "text-ink"   },
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
            <div className="text-[12px] font-medium text-muted mb-1">{item.label}</div>
            <div className={`text-[18px] font-bold tabular-nums ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Supplier payments */}
      {payments.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line-2">
            <p className="text-[12.5px] font-medium text-muted">
              Supplier Payments
            </p>
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
                <div className="text-[13px] font-semibold text-ink tabular-nums">
                  {fmtAmount(p.amount)}
                </div>
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

      {/* Profit split */}
      {split && flow.net_profit > 0 && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3">
          <p className="text-[12.5px] font-medium text-muted mb-3">
            Profit Split
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
            {[
              { name: split.jack_name, val: flow.profit_jack },
              { name: split.ben_name,  val: flow.profit_ben  },
              { name: "Business",      val: flow.profit_business },
            ].map((item) => (
              <div key={item.name}>
                <div className="text-[12px] text-muted">{item.name}</div>
                <div className="text-[18px] font-bold text-success-ink tabular-nums mt-0.5">
                  {fmtAmount(item.val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Backlog date editor */}
      <div className="bg-surface border border-line rounded-xl px-4 py-3">
        <p className="text-[12.5px] font-medium text-muted mb-2">
          Completed Date
        </p>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={editDate}
            onChange={(e) => setEditDate(e.target.value)}
            className="flex-1 border border-line px-2.5 h-8 rounded-lg text-[12px] bg-surface
                       focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
          />
          <button
            onClick={handleSaveDate}
            disabled={dateSaving || editDate === initialDate}
            className="px-3 h-8 bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium
                       rounded-lg disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {dateSaving ? "Saving…" : "Save Date"}
          </button>
        </div>
        <p className="text-[10px] text-muted mt-1.5">
          Change to backlog a sale into the correct month/week for analytics.
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleReopen}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                     px-3 h-8 border border-line rounded-lg hover:bg-surface-2 transition-colors"
        >
          <RotateCcw size={12} /> Reopen Deal
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
