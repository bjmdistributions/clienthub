import { useEffect, useState } from "react";
import { api, BuyerTier } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, Layers } from "lucide-react";
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

const TIER_ORDER = ["S", "A", "B", "C", "Prospect"];

export default function TiersView() {
  const [tiers, setTiers]     = useState<BuyerTier[]>([]);
  const [filter, setFilter]   = useState<string>("all");
  const [spendRange, setSpendRange] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setTiers(await api.buyerTiers()); } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = tiers
    .filter((t) => filter === "all" || t.tier === filter)
    .filter((t) => {
      if (spendRange === 0) return true;
      const range = SPEND_RANGES[spendRange];
      const spend = parseFloat((t.spend_per_frequency || "0").replace(/[^0-9.]/g, "")) || 0;
      return spend >= range.min && spend <= range.max;
    });

  const tierCount = (t: string) => tiers.filter((x) => x.tier === t).length;

  if (detailId) return <ClientDetailView clientId={detailId} onBack={() => setDetailId(null)} />;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Client Tiers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Ranked by spend potential and actual purchasing history.
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
      <div className="grid grid-cols-5 gap-3 my-5">
        {TIER_ORDER.map((t) => {
          const count = tierCount(t);
          return (
            <button
              key={t}
              onClick={() => setFilter(filter === t ? "all" : t)}
              className={`bg-surface border rounded-xl p-3.5 text-left transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,0,0,0.07)] ${
                filter === t ? "ring-2 ring-accent/50 border-accent/20" : "border-line"
              }`}
            >
              <div className="mb-2.5">
                <TierBadge tier={t} size="sm" />
              </div>
              <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{count}</div>
              <div className="text-[10px] text-muted mt-1 uppercase tracking-wide">clients</div>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => setFilter("all")}
          className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
            filter === "all" ? "bg-gray-900 text-white" : "bg-surface border border-line text-ink-2 hover:border-line-3"
          }`}
        >
          All tiers
        </button>

        <div className="h-4 w-px bg-surface-3" />

        <span className="text-[11px] text-muted font-medium">Spend per frequency:</span>
        {SPEND_RANGES.map((r, i) => (
          <button
            key={i}
            onClick={() => setSpendRange(i)}
            className={`px-2.5 h-7 rounded-md text-[11px] font-medium transition-colors ${
              spendRange === i
                ? "bg-accent text-on-accent"
                : "bg-surface border border-line text-ink-2 hover:border-line-3"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Result count */}
      <div className="text-[12px] text-muted mb-3">
        Showing {filtered.length} of {tiers.length} clients
      </div>

      {/* Table */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-50">
              <th className="text-left px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Client</th>
              <th className="text-center px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Tier</th>
              <th className="text-right px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Spend / Freq.</th>
              <th className="text-right px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Actually Paid</th>
              <th className="text-center px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Invoices</th>
              <th className="text-center px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Quotes</th>
              <th className="text-left px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Reliability</th>
              <th className="text-right px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Avg Margin</th>
              <th className="text-left px-5 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Frequency</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr
                key={t.client_id}
                onClick={() => setDetailId(t.client_id)}
                className="border-b border-gray-50 last:border-0 hover:bg-surface-2/60 transition-colors cursor-pointer"
                style={{ animationDelay: `${i * 20}ms` }}
              >
                <td className="px-5 py-3 text-[13px] font-medium text-ink">{t.client_name}</td>
                <td className="px-5 py-3 text-center">
                  <TierBadge tier={t.tier} />
                </td>
                <td className="px-5 py-3 text-right text-[13px] text-ink-2 tabular-nums">
                  {t.spend_per_frequency || "—"}
                </td>
                <td className="px-5 py-3 text-right text-[13px] font-semibold text-ink tabular-nums">
                  {t.actual_paid > 0 ? fmtAmount(t.actual_paid) : "—"}
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
                <td className="px-5 py-3 text-[12px] text-muted capitalize">{t.purchase_frequency || "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-16 text-center">
                  <Layers size={24} className="text-faint mx-auto mb-2" />
                  <p className="text-[13px] text-muted">No clients in this tier</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
