import { useEffect, useState } from "react";
import { api, WeeklyBrief, ProfitSplit } from "../lib/api";
import { fmtAmount } from "../lib/format";
import {
  TrendingUp, TrendingDown, Minus, FileText, RefreshCw, Send, Printer,
  AlertCircle, DollarSign, Briefcase, Users, Target, GitBranch,
} from "lucide-react";

export default function BriefView() {
  const [brief, setBrief] = useState<WeeklyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [split, setSplit] = useState<ProfitSplit | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [b, s] = await Promise.all([api.generateWeeklyBrief(), api.getProfitSplit()]);
      setBrief(b);
      setSplit(s);
    } catch (e: any) { alert(e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const changePct = (pct: number) => {
    if (pct > 0) return <span className="text-emerald-600 flex items-center gap-0.5"><TrendingUp size={12} /> {pct.toFixed(1)}%</span>;
    if (pct < 0) return <span className="text-red-600 flex items-center gap-0.5"><TrendingDown size={12} /> {Math.abs(pct).toFixed(1)}%</span>;
    return <span className="text-gray-400 flex items-center gap-0.5"><Minus size={12} /> 0%</span>;
  };

  if (!brief && !loading) return <div className="text-[14px] text-gray-400 text-center py-10">Could not generate brief</div>;

  return (
    <div className="print-area max-w-3xl mx-auto">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6 print:hidden">
        <h2 className="text-[18px] font-semibold text-gray-900">Weekly Brief</h2>
        <div className="flex items-center gap-2">
          <button onClick={load} className="flex items-center gap-1.5 border border-gray-300 h-9 px-3 rounded-md text-[13px] text-gray-600 hover:bg-gray-50">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-4 rounded-md text-[13px] font-medium">
            <Printer size={14} /> Print
          </button>
          <button onClick={() => {
            if (brief) {
              const subj = `Weekly Brief: ${brief.week_start} to ${brief.week_end}`;
              const body = `Revenue: ${fmtAmount(brief.revenue_this_week)} | Profit: ${fmtAmount(brief.profit_this_week)} | Deals Closed: ${brief.deals_closed_this_week}`;
              alert(`To email this brief, configure email in Settings > Email.\n\nSubject: ${subj}\n\n${body}`);
            }
          }} className="flex items-center gap-1.5 border border-gray-300 h-9 px-3 rounded-md text-[13px] text-gray-600 hover:bg-gray-50">
            <Send size={14} /> Email
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-[14px] text-gray-400 text-center py-20">Generating brief...</div>
      ) : brief ? (
        <div className="space-y-6">
          {/* Header */}
          <div className="text-center border-b border-gray-200 pb-6">
            <h1 className="text-[24px] font-bold text-gray-900">ClientHub Weekly Brief</h1>
            <p className="text-[14px] text-gray-500 mt-2">
              {brief.week_start} &mdash; {brief.week_end}
            </p>
            <p className="text-[11px] text-gray-400 mt-1">
              Generated {new Date(brief.generated_at).toLocaleString()}
            </p>
          </div>

          {/* Section 1: This Week At-a-Glance */}
          <div>
            <h2 className="text-[16px] font-semibold text-gray-900 mb-3">This Week At-a-Glance</h2>
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Revenue" value={fmtAmount(brief.revenue_this_week)} change={changePct(brief.revenue_change_pct)} />
              <StatCard label="Profit" value={fmtAmount(brief.profit_this_week)} change={changePct(brief.profit_change_pct)}
                sub={`${brief.avg_margin_this_week.toFixed(1)}% margin`} />
              <StatCard label="Deals Closed" value={String(brief.deals_closed_this_week)}
                sub={`${brief.deals_lost_this_week} lost`} />
              <StatCard label="Win Rate" value={`${brief.win_rate_this_week.toFixed(0)}%`} />
            </div>
          </div>

          {/* Section 1.5: Profit from Deal Flows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[16px] font-semibold text-gray-900 flex items-center gap-2">
                <GitBranch size={16} className="text-indigo-500" />
                Profit from Deal Flows
              </h2>
              <span className="text-[11px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {brief.completed_deals_this_week} deal{brief.completed_deals_this_week !== 1 ? "s" : ""} completed
              </span>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
              {/* Net profit row */}
              <div className="flex items-center justify-between">
                <div className="text-[13px] text-gray-500">Net Profit</div>
                <div className="flex items-center gap-2">
                  <span className={`text-[26px] font-bold ${brief.net_profit_this_week >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {fmtAmount(brief.net_profit_this_week)}
                  </span>
                  <span className="text-[12px]">{changePct(brief.net_profit_change_pct)}</span>
                </div>
              </div>

              {/* Three split boxes */}
              <div className="grid grid-cols-3 gap-3">
                <div className="border-t-2 border-indigo-400 bg-indigo-50/40 rounded-lg p-3 text-center">
                  <div className="text-[10px] font-medium text-indigo-500 uppercase tracking-wide">Business {split?.business_pct ?? 40}%</div>
                  <div className="text-[18px] font-bold text-gray-900 mt-0.5">{fmtAmount(brief.profit_business_this_week)}</div>
                </div>
                <div className="border-t-2 border-emerald-400 bg-emerald-50/40 rounded-lg p-3 text-center">
                  <div className="text-[10px] font-medium text-emerald-500 uppercase tracking-wide">{split?.jack_name ?? "Jack"} {split?.jack_pct ?? 30}%</div>
                  <div className="text-[18px] font-bold text-gray-900 mt-0.5">{fmtAmount(brief.profit_jack_this_week)}</div>
                </div>
                <div className="border-t-2 border-blue-400 bg-blue-50/40 rounded-lg p-3 text-center">
                  <div className="text-[10px] font-medium text-blue-500 uppercase tracking-wide">{split?.ben_name ?? "Ben"} {split?.ben_pct ?? 30}%</div>
                  <div className="text-[18px] font-bold text-gray-900 mt-0.5">{fmtAmount(brief.profit_ben_this_week)}</div>
                </div>
              </div>

              {/* Month-to-date row */}
              {brief.net_profit_this_month !== 0 && (
                <div className="flex items-center justify-between text-[12px] text-gray-500 border-t border-gray-100 pt-3">
                  <span>
                    This month: <span className="font-semibold text-gray-700">{fmtAmount(brief.net_profit_this_month)}</span> profit
                  </span>
                  <span>
                    {split?.jack_name ?? "Jack"} MTD: <span className="font-medium text-gray-700">{fmtAmount(brief.profit_jack_this_month)}</span>
                    <span className="mx-1.5">&middot;</span>
                    {split?.ben_name ?? "Ben"} MTD: <span className="font-medium text-gray-700">{fmtAmount(brief.profit_ben_this_month)}</span>
                  </span>
                </div>
              )}

              {/* Loss warning */}
              {brief.loss_deals_this_week > 0 && (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
                  <AlertCircle size={14} className="text-amber-500 flex-shrink-0" />
                  <span className="text-[12px] text-amber-700">
                    {brief.loss_deals_this_week} deal{brief.loss_deals_this_week !== 1 ? "s" : ""} lost money this week: <span className="font-semibold">{fmtAmount(brief.loss_total_this_week)}</span>
                  </span>
                </div>
              )}

              {/* Footer note */}
              <div className="text-[10px] text-gray-400 italic">
                Profit calculated from completed deal flows only
              </div>
            </div>
          </div>

          {/* Section 2: Pipeline */}
          <div>
            <h2 className="text-[16px] font-semibold text-gray-900 mb-3">Pipeline Snapshot</h2>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center gap-4 mb-3 flex-wrap">
                {brief.deals_by_stage.map((s) => (
                  <div key={s.stage} className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-2">
                    <div className="text-[11px] font-medium text-gray-500 uppercase">{s.stage}</div>
                    <div className="text-[16px] font-bold text-gray-900">{s.count}</div>
                    <div className="text-[11px] text-gray-400">{fmtAmount(s.value)}</div>
                  </div>
                ))}
              </div>
              <div className="text-[13px] text-gray-600">
                Pipeline total: <span className="font-semibold text-gray-900">{fmtAmount(brief.pipeline_value)}</span>
              </div>

              {brief.stuck_deals.length > 0 && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <div className="text-[12px] font-medium text-amber-700 mb-1">Stuck Deals</div>
                  {brief.stuck_deals.map((d) => (
                    <div key={d.deal_id} className="text-[12px] text-gray-600 flex justify-between py-0.5">
                      <span className="truncate">{d.title}</span>
                      <span className="ml-3 flex-shrink-0 text-gray-400">{d.days_in_stage}d in {d.stage}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Customer Health */}
          {brief.at_risk_customers.length > 0 && (
            <div>
              <h2 className="text-[16px] font-semibold text-gray-900 mb-3">Customer Health Alerts</h2>
              <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
                {brief.at_risk_customers.map((h: any) => (
                  <div key={h.client_id} className="px-4 py-3 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-900">{h.client_name}</div>
                      <div className="text-[11px] text-gray-400">{h.tier === "S" ? "Diamond" : h.tier === "A" ? "Gold" : h.tier === "B" ? "Silver" : h.tier === "C" ? "Bronze" : "Prospect"}</div>
                    </div>
                    <span className={`text-[12px] font-semibold px-2 py-0.5 rounded-full ml-3 ${h.tier === "S" ? "bg-indigo-100 text-indigo-700" : h.tier === "A" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>T{h.tier}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section 4: Receivables & Follow-ups */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-2">Receivables</h3>
              {brief.overdue_invoices_count > 0 ? (
                <div>
                  <div className="text-[22px] font-bold text-red-600">{brief.overdue_invoices_count}</div>
                  <div className="text-[13px] text-gray-500">overdue invoices</div>
                  <div className="text-[18px] font-semibold text-red-600 mt-1">{fmtAmount(brief.overdue_invoices_value)}</div>
                </div>
              ) : (
                <div className="text-[13px] text-emerald-600 font-medium">No overdue invoices</div>
              )}
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="text-[13px] font-semibold text-gray-900 mb-2">Follow-ups</h3>
              {brief.follow_ups_due > 0 ? (
                <div>
                  <div className="text-[22px] font-bold text-amber-600">{brief.follow_ups_due}</div>
                  <div className="text-[13px] text-gray-500">follow-ups due today</div>
                </div>
              ) : (
                <div className="text-[13px] text-emerald-600 font-medium">All caught up</div>
              )}
            </div>
          </div>

          {/* Section 5: Highlights */}
          <div>
            <h2 className="text-[16px] font-semibold text-gray-900 mb-3">This Week's Highlights</h2>
            <div className="grid grid-cols-3 gap-4">
              {brief.best_margin_deal && (
                <div className="bg-white border border-emerald-200 rounded-lg p-4">
                  <div className="text-[11px] font-medium text-emerald-600 uppercase tracking-wide">Best Margin Deal</div>
                  <div className="text-[13px] font-semibold text-gray-900 mt-1 truncate">{brief.best_margin_deal.title}</div>
                  <div className="text-[12px] text-gray-500">{brief.best_margin_deal.client_name}</div>
                  <div className="text-[16px] font-bold text-emerald-600 mt-1">{brief.best_margin_deal.margin_pct.toFixed(1)}%</div>
                </div>
              )}
              {brief.worst_margin_deal && (
                <div className="bg-white border border-amber-200 rounded-lg p-4">
                  <div className="text-[11px] font-medium text-amber-600 uppercase tracking-wide">Lowest Margin</div>
                  <div className="text-[13px] font-semibold text-gray-900 mt-1 truncate">{brief.worst_margin_deal.title}</div>
                  <div className="text-[12px] text-gray-500">{brief.worst_margin_deal.client_name}</div>
                  <div className="text-[16px] font-bold text-amber-600 mt-1">{brief.worst_margin_deal.margin_pct.toFixed(1)}%</div>
                </div>
              )}
              {brief.biggest_invoice && (
                <div className="bg-white border border-indigo-200 rounded-lg p-4">
                  <div className="text-[11px] font-medium text-indigo-600 uppercase tracking-wide">Biggest Invoice</div>
                  <div className="text-[13px] font-semibold text-gray-900 mt-1 truncate">{brief.biggest_invoice.number}</div>
                  <div className="text-[12px] text-gray-500">{brief.biggest_invoice.client_name}</div>
                  <div className="text-[16px] font-bold text-gray-900 mt-1">{fmtAmount(brief.biggest_invoice.total)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Section 6: Activity */}
          <div>
            <h2 className="text-[16px] font-semibold text-gray-900 mb-3">Activity This Week</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4">
                <Users size={20} className="text-indigo-500" />
                <div><div className="text-[22px] font-bold text-gray-900">{brief.new_clients_this_week}</div>
                <div className="text-[12px] text-gray-500">new clients</div></div>
              </div>
              <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4">
                <Target size={20} className="text-violet-500" />
                <div><div className="text-[22px] font-bold text-gray-900">{brief.interactions_this_week}</div>
                <div className="text-[12px] text-gray-500">interactions logged</div></div>
              </div>
            </div>
          </div>

        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, change, sub }: { label: string; value: string; change?: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-[22px] font-bold text-gray-900 mt-1">{value}</div>
      {change && <div className="text-[12px] mt-0.5">{change}</div>}
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
