import { useEffect, useState } from "react";
import { api, BuyerTier } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, Layers, ArrowLeftRight } from "lucide-react";
import TierBadge from "./TierBadge";
import ReliabilityBadge from "./ReliabilityBadge";
import ClientDetailView from "./ClientDetailView";

const SPEND_RANGES = [
  { label: "All",           min: 0,     max: Infinity },
  { label: "$0",            min: 0,     max: 0 },
  { label: "$1 – $999",     min: 1,     max: 999 },
  { label: "$1k – $4.9k",   min: 1000,  max: 4999 },
  { label: "$5k – $9.9k",   min: 5000,  max: 9999 },
  { label: "$10k – $49.9k", min: 10000, max: 49999 },
  { label: "$50k+",         min: 50000, max: Infinity },
];

// Profit can be negative once refunds are netted out, so this ladder is not the
// spend one with different labels — it needs a loss bucket at the bottom.
const PROFIT_RANGES = [
  { label: "Any profit",     min: -Infinity, max: Infinity },
  { label: "At a loss",      min: -Infinity, max: -0.01 },
  { label: "None",           min: 0,         max: 0 },
  { label: "$1 – $999",      min: 1,         max: 999 },
  { label: "$1k – $4.9k",    min: 1000,      max: 4999 },
  { label: "$5k – $24.9k",   min: 5000,      max: 24999 },
  { label: "$25k+",          min: 25000,     max: Infinity },
];

const FREQUENCIES = ["weekly", "bi-weekly", "monthly", "quarterly", "annually"];

const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect"];

// Measured purchase cadence -> the same five buckets the frequency filter uses.
function cadenceBucket(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 10) return "weekly";
  if (days <= 20) return "bi-weekly";
  if (days <= 45) return "monthly";
  if (days <= 135) return "quarterly";
  return "annually";
}

// R-251: money/frequency column toggles (avg deal <-> avg profit, per-deal <-> per-month).
const DAYS_PER_MONTH = 30.44; // mean calendar days per month

function dealsPerMonth(cadenceDays: number | null): number | null {
  return cadenceDays != null ? DAYS_PER_MONTH / cadenceDays : null;
}

function tierMoney(
  t: BuyerTier,
  moneyMode: "revenue" | "profit",
  periodMode: "deal" | "month"
): number | null {
  const n = t.deals_landed;
  const avgProfit = n > 0 ? t.total_profit / n : 0;
  const money = moneyMode === "profit" ? avgProfit : t.avg_deal_value;
  if (periodMode === "month") {
    const dpm = dealsPerMonth(t.purchase_cadence_days);
    return dpm != null ? money * dpm : null;
  }
  return n > 0 ? money : null;
}

const selectCls =
  "border border-line h-8 px-2.5 rounded-lg text-[12px] text-ink-2 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function TiersView() {
  const [tiers, setTiers]     = useState<BuyerTier[]>([]);
  const [filter, setFilter]   = useState<string>("all");
  const [paidRange, setPaidRange]     = useState(0);
  const [profitRange, setProfitRange] = useState(0);
  const [spendRange, setSpendRange]   = useState(0);
  const [freqFilter, setFreqFilter]   = useState("");
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  const [moneyMode, setMoneyMode] = useState<"revenue" | "profit">("revenue");
  const [periodMode, setPeriodMode] = useState<"deal" | "month">("deal");
  const [flipSeq, setFlipSeq] = useState(0);
  const toggleMoney = () => { setMoneyMode((m) => (m === "revenue" ? "profit" : "revenue")); setFlipSeq((s) => s + 1); };
  const togglePeriod = () => { setPeriodMode((p) => (p === "deal" ? "month" : "deal")); setFlipSeq((s) => s + 1); };

  const load = async () => {
    setLoading(true);
    try { setTiers(await api.buyerTiers()); } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = tiers
    .filter((t) => filter === "all" || t.tier === filter)
    .filter((t) => {
      if (paidRange === 0) return true;
      const r = SPEND_RANGES[paidRange];
      return t.actual_paid >= r.min && t.actual_paid <= r.max;
    })
    .filter((t) => {
      if (profitRange === 0) return true;
      const r = PROFIT_RANGES[profitRange];
      return t.total_profit >= r.min && t.total_profit <= r.max;
    })
    .filter((t) => {
      if (spendRange === 0) return true;
      const range = SPEND_RANGES[spendRange];
      return t.avg_deal_value >= range.min && t.avg_deal_value <= range.max;
    })
    .filter((t) => !freqFilter || cadenceBucket(t.purchase_cadence_days) === freqFilter);

  const anyFilter = filter !== "all" || paidRange > 0 || profitRange > 0 || spendRange > 0 || !!freqFilter;
  const clearFilters = () => {
    setFilter("all"); setPaidRange(0); setProfitRange(0); setSpendRange(0); setFreqFilter("");
  };

  const tierCount = (t: string) => tiers.filter((x) => x.tier === t).length;

  const moneyHeaderLabel =
    periodMode === "month"
      ? moneyMode === "profit" ? "Profit / mo" : "Revenue / mo"
      : moneyMode === "profit" ? "Avg profit" : "Avg deal";

  if (detailId) return <ClientDetailView clientId={detailId} onBack={() => setDetailId(null)} />;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Client tiers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Ranked by actual purchasing history.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 px-2.5 py-1.5 rounded-lg hover:bg-surface-3 transition-colors mt-0.5"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Tier summary cards */}
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3 my-5">
        {TIER_ORDER.map((t) => {
          const count = tierCount(t);
          return (
            <button
              key={t}
              onClick={() => setFilter(filter === t ? "all" : t)}
              className={`bg-surface border rounded-xl p-3.5 text-left transition-shadow hover:shadow-[0_4px_12px_rgba(0,0,0,0.07)] ${
                filter === t ? "ring-2 ring-accent/50 border-accent/20" : "border-line"
              }`}
            >
              <div className="mb-2.5">
                <TierBadge tier={t} size="sm" />
              </div>
              <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{count}</div>
              <div className="text-[10px] text-muted mt-1">clients</div>
            </button>
          );
        })}
      </div>

      {/* Filters — same order as the columns they filter */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setFilter("all")}
          className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
            filter === "all" ? "bg-accent text-on-accent" : "bg-surface border border-line text-ink-2 hover:border-line-3"
          }`}
        >
          All tiers
        </button>

        <div className="h-4 w-px bg-surface-3 mx-1" />

        <select value={paidRange} onChange={(e) => setPaidRange(Number(e.target.value))} className={selectCls}>
          {SPEND_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? "Any spend" : `Spent ${r.label}`}</option>
          ))}
        </select>

        <select value={profitRange} onChange={(e) => setProfitRange(Number(e.target.value))} className={selectCls}>
          {PROFIT_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? r.label : `Profit ${r.label}`}</option>
          ))}
        </select>

        <select value={spendRange} onChange={(e) => setSpendRange(Number(e.target.value))} className={selectCls}>
          {SPEND_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? "Any avg deal" : `Avg deal ${r.label}`}</option>
          ))}
        </select>

        <select value={freqFilter} onChange={(e) => setFreqFilter(e.target.value)} className={selectCls}>
          <option value="">Any frequency</option>
          {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>

        {anyFilter && (
          <button onClick={clearFilters} className="text-[12px] text-muted hover:text-ink-2 px-2 h-8 rounded-lg hover:bg-surface-3 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Result count */}
      <div className="text-[12px] text-muted mb-3">
        Showing {filtered.length} of {tiers.length} clients
      </div>

      {/* Table */}
      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-line-2">
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Client</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Tier</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Actually paid</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Profit</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Invoices</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Quotes</th>
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Reliability</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Avg margin</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">
                <button
                  onClick={toggleMoney}
                  title={moneyMode === "revenue" ? "Switch to profit" : "Switch to revenue"}
                  className="group inline-flex items-center gap-1 justify-end w-full cursor-pointer hover:text-ink-2 transition-colors"
                >
                  {moneyHeaderLabel}
                  <ArrowLeftRight
                    size={11}
                    className="text-faint group-hover:text-ink-2 transition-transform duration-[130ms] ease-out"
                    style={{ transform: moneyMode === "profit" ? "rotate(180deg)" : "rotate(0deg)" }}
                  />
                </button>
              </th>
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">
                <button
                  onClick={togglePeriod}
                  title={periodMode === "deal" ? "Switch to monthly view" : "Switch to per-deal view"}
                  className="group inline-flex items-center gap-1 cursor-pointer hover:text-ink-2 transition-colors"
                >
                  Frequency
                  <ArrowLeftRight
                    size={11}
                    className="text-faint group-hover:text-ink-2 transition-transform duration-[130ms] ease-out"
                    style={{ transform: periodMode === "month" ? "rotate(180deg)" : "rotate(0deg)" }}
                  />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => {
              const moneyValue = tierMoney(t, moneyMode, periodMode);
              const dpm = dealsPerMonth(t.purchase_cadence_days);
              const stagger = Math.min(i * 14, 220);
              return (
              <tr
                key={t.client_id}
                onClick={() => setDetailId(t.client_id)}
                className="border-b border-line-2 last:border-0 hover:bg-surface-2/60 transition-colors cursor-pointer"
              >
                <td className="px-5 py-3 text-[13px] font-medium text-ink">{t.client_name}</td>
                <td className="px-5 py-3 text-center">
                  <TierBadge tier={t.tier} />
                </td>
                <td className="px-5 py-3 text-right text-[13px] font-semibold text-ink tabular-nums">
                  {t.actual_paid > 0 ? fmtAmount(t.actual_paid) : "—"}
                </td>
                <td className={`px-5 py-3 text-right text-[13px] font-semibold tabular-nums ${
                  t.total_profit < 0 ? "text-danger-ink" : "text-ink"
                }`}>
                  {t.total_profit !== 0 ? <>{t.total_profit < 0 ? "−" : ""}{fmtAmount(Math.abs(t.total_profit))}</> : "—"}
                </td>
                <td className="px-5 py-3 text-center text-[13px] text-ink-2 tabular-nums">{t.invoices_sent}</td>
                <td className="px-5 py-3 text-center text-[13px] text-ink-2 tabular-nums">{t.quotes_sent || "—"}</td>
                <td className="px-5 py-3">
                  <ReliabilityBadge reliability={t.reliability} pct={t.reliability_pct} quotesSent={t.quotes_sent} quotesWon={t.quotes_won} />
                </td>
                <td className="px-5 py-3 text-right">
                  {t.avg_commission_pct > 0 ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums ${
                      t.avg_commission_pct >= 25 ? "bg-success-bg text-success-ink"
                      : t.avg_commission_pct >= 10 ? "bg-warning-bg text-warning-ink"
                      : "bg-danger-bg text-danger-ink"
                    }`}>
                      {t.avg_commission_pct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-[12px] text-faint">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right text-[13px] tabular-nums">
                  <span
                    key={`money-${flipSeq}`}
                    className={`tier-value-in ${moneyValue != null && moneyValue < 0 ? "text-danger-ink" : "text-ink-2"}`}
                    style={{ animationDelay: `${stagger}ms` }}
                  >
                    {moneyValue == null ? "—" : <>{moneyValue < 0 ? "−" : ""}{fmtAmount(Math.abs(moneyValue))}</>}
                  </span>
                </td>
                <td
                  className="px-5 py-3 text-[12px] text-muted"
                  title={`Measured from ${t.deals_landed} completed deal${t.deals_landed === 1 ? "" : "s"}`}
                >
                  <span key={`freq-${flipSeq}`} className="tier-value-in" style={{ animationDelay: `${stagger}ms` }}>
                    {periodMode === "month"
                      ? (dpm != null ? `${dpm.toFixed(1)} deals / mo` : "—")
                      : (t.purchase_cadence_days != null ? `Every ${Math.round(t.purchase_cadence_days)} days` : "—")}
                  </span>
                </td>
              </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-5 py-16 text-center">
                  <Layers size={24} className="text-faint mx-auto mb-2" />
                  <p className="text-[13px] text-muted">No clients match these filters</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
