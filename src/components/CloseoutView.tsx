import { useEffect, useState } from "react";
import { api, DealFlow, ProfitSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  CheckCircle2, RefreshCw, ChevronDown, RotateCcw, Trash2,
  TrendingUp, DollarSign, Package,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────
function pct(n: number, d: number) { return d > 0 ? (n / d) * 100 : 0; }

function MarginBadge({ margin }: { margin: number }) {
  const cls =
    margin >= 30 ? "bg-emerald-50 text-emerald-700" :
    margin >= 15 ? "bg-amber-50 text-amber-700" :
    margin >= 0  ? "bg-red-50 text-red-600" :
                   "bg-red-100 text-red-700";
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
      <RefreshCw size={15} className="text-gray-300 animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Completed Deals</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">
            {flows.length} deal{flows.length !== 1 ? "s" : ""} closed
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-700
                     px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* ── Analytics cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          {
            label: "Total Revenue",
            value: fmtAmount(totalRevenue),
            icon: DollarSign,
            color: "text-gray-900",
            bg:    "bg-indigo-50",
            ic:    "text-indigo-500",
          },
          {
            label: "Total Cost",
            value: fmtAmount(totalCost),
            icon: Package,
            color: "text-gray-900",
            bg:    "bg-amber-50",
            ic:    "text-amber-500",
          },
          {
            label: "Net Profit",
            value: fmtAmount(totalProfit),
            icon: TrendingUp,
            color: totalProfit >= 0 ? "text-emerald-700" : "text-red-600",
            bg:    totalProfit >= 0 ? "bg-emerald-50" : "bg-red-50",
            ic:    totalProfit >= 0 ? "text-emerald-500" : "text-red-500",
          },
          {
            label: "Avg Margin",
            value: `${avgMargin.toFixed(1)}%`,
            icon: CheckCircle2,
            color: avgMargin >= 20 ? "text-emerald-700" : avgMargin >= 10 ? "text-amber-700" : "text-red-600",
            bg:    avgMargin >= 20 ? "bg-emerald-50" : avgMargin >= 10 ? "bg-amber-50" : "bg-red-50",
            ic:    avgMargin >= 20 ? "text-emerald-500" : avgMargin >= 10 ? "text-amber-500" : "text-red-500",
          },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white border border-gray-100 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
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
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
            <CheckCircle2 size={18} className="text-gray-300" />
          </div>
          <p className="text-[15px] font-semibold text-gray-700 mb-1">No completed deals yet</p>
          <p className="text-[13px] text-gray-400">
            Deals appear here once you mark them complete in Deal Flow
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_100px_100px_80px_36px] gap-x-4 px-5 py-2.5
                          border-b border-gray-50 bg-gray-50/60">
            {["Client / Invoice", "Revenue", "Cost", "Profit", "Margin", ""].map((h) => (
              <span key={h} className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
                {h}
              </span>
            ))}
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-50">
            {flows.map((flow) => {
              const margin = pct(flow.net_profit, flow.gross_revenue);
              const isExp  = expanded === flow.id;
              return (
                <div key={flow.id}>
                  {/* Summary row */}
                  <button
                    onClick={() => setExpanded(isExp ? null : flow.id)}
                    className="w-full grid grid-cols-[1fr_100px_100px_100px_80px_36px] gap-x-4
                               px-5 py-4 text-left hover:bg-gray-50/50 transition-colors items-center"
                  >
                    {/* Client + invoice */}
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-gray-900 truncate">
                        {flow.client_name || "—"}
                      </div>
                      <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                        <span className="font-mono">{flow.invoice_number}</span>
                        {flow.completed_at && (
                          <span>
                            {new Date(flow.completed_at).toLocaleDateString("en-US", {
                              month: "short", day: "numeric", year: "numeric",
                            })}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Numbers */}
                    <span className="text-[13px] font-semibold text-gray-800 tabular-nums">
                      {fmtAmount(flow.gross_revenue)}
                    </span>
                    <span className="text-[13px] text-gray-500 tabular-nums">
                      {fmtAmount(flow.total_cost)}
                    </span>
                    <span className={`text-[13px] font-semibold tabular-nums ${
                      flow.net_profit >= 0 ? "text-emerald-600" : "text-red-500"
                    }`}>
                      {fmtAmount(flow.net_profit)}
                    </span>
                    <MarginBadge margin={margin} />

                    {/* Chevron */}
                    <ChevronDown
                      size={14}
                      className={`text-gray-300 transition-transform duration-200 ${isExp ? "rotate-180" : ""}`}
                    />
                  </button>

                  {/* Expanded breakdown */}
                  {isExp && (
                    <div className="border-t border-gray-50 bg-gray-50/40 px-5 py-5">
                      <DealBreakdown flow={flow} split={split} onReload={load} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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

  const handleReopen = async () => {
    if (!confirm("Reopen this deal? It will move back to the active Deal Flow.")) return;
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); }
    catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Permanently delete this deal record? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); }
    catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* P&L grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Revenue",                                      value: fmtAmount(flow.gross_revenue), clr: "text-gray-900"   },
          { label: "Total Cost",                                   value: fmtAmount(flow.total_cost),    clr: "text-gray-900"   },
          {
            label: flow.net_profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(flow.net_profit),
            clr:   flow.net_profit >= 0 ? "text-emerald-600" : "text-red-500",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-emerald-600" : margin >= 10 ? "text-amber-600" : "text-red-500",
          },
        ].map((item) => (
          <div key={item.label} className="bg-white border border-gray-100 rounded-xl px-4 py-3">
            <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">{item.label}</div>
            <div className={`text-[18px] font-bold tabular-nums ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Supplier payments */}
      {payments.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-50">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
              Supplier Payments
            </p>
          </div>
          <div className="divide-y divide-gray-50">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-800 font-medium">{p.supplier_name}</div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-gray-400 tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-gray-900 tabular-nums">
                  {fmtAmount(p.amount)}
                </div>
              </div>
            ))}
            <div className="flex justify-between items-center px-4 py-2.5 bg-gray-50/60">
              <span className="text-[11px] text-gray-400 font-medium">Total supplier cost</span>
              <span className="text-[12px] font-bold text-gray-900 tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Profit split */}
      {split && flow.net_profit > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl px-4 py-3">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
            Profit Split
          </p>
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { name: split.jack_name, val: flow.profit_jack },
              { name: split.ben_name,  val: flow.profit_ben  },
              { name: "Business",      val: flow.profit_business },
            ].map((item) => (
              <div key={item.name}>
                <div className="text-[12px] text-gray-400">{item.name}</div>
                <div className="text-[18px] font-bold text-emerald-600 tabular-nums mt-0.5">
                  {fmtAmount(item.val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleReopen}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-700
                     px-3 h-8 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RotateCcw size={12} /> Reopen Deal
        </button>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-red-400 hover:text-red-600
                     px-3 h-8 border border-red-100 rounded-lg hover:bg-red-50 transition-colors ml-auto"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}
