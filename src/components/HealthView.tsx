import { useEffect, useState } from "react";
import { api, CustomerHealth } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react";

export default function HealthView() {
  const [scores, setScores] = useState<CustomerHealth[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setScores([]);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = filter === "all" ? scores : scores.filter((s) => s.risk_level === filter);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Customer health</h2>
          <p className="text-[12px] text-muted mt-0.5">Which customers are slipping, and why.</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink-2">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {["all", "healthy", "watch", "at_risk", "critical"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 h-8 rounded-full text-[12px] font-medium transition-colors border ${
              filter === f
                ? f === "critical" ? "bg-danger-bg text-danger-ink border-danger" :
                  f === "at_risk" || f === "watch" ? "bg-warning-bg text-warning-ink border-warning" :
                  f === "healthy" ? "bg-success-bg text-success-ink border-success" :
                  "bg-accent text-on-accent border-accent"
                : "bg-surface-2 text-ink-2 border-line hover:bg-surface-3"
            }`}>
            {f === "all" ? "All" : f.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase())}
            {f !== "all" && <span className="ml-1 opacity-70">({scores.filter((s) => s.risk_level === f).length})</span>}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-line-2 rounded-lg overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-surface-2 border-b border-line">
            <tr>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Client</th>
              <th className="text-center px-4 py-3 text-[12px] font-medium text-muted">Score</th>
              <th className="text-center px-4 py-3 text-[12px] font-medium text-muted">Risk</th>
              <th className="text-center px-4 py-3 text-[12px] font-medium text-muted">Trend</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Risk factors</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((h) => (
              <tr key={h.client_id} className="border-b border-line last:border-0 hover:bg-surface-2">
                <td className="px-4 py-3 text-[14px] font-medium text-ink">{h.client_name}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-[13px] font-bold ${
                    h.risk_level === "critical" ? "bg-danger-bg text-danger-ink" :
                    h.risk_level === "at_risk" ? "bg-warning-bg text-warning-ink" :
                    h.risk_level === "watch" ? "bg-warning-bg text-warning-ink" : "bg-success-bg text-success-ink"
                  }`}>{h.score}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${
                    h.risk_level === "critical" ? "bg-danger-bg text-danger-ink" :
                    h.risk_level === "at_risk" ? "bg-warning-bg text-warning-ink" :
                    h.risk_level === "watch" ? "bg-warning-bg text-warning-ink" : "bg-success-bg text-success-ink"
                  }`}>{h.risk_level.replace("_", " ")}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  {h.trend === "improving" ? <TrendingUp size={14} className="text-success-ink inline" /> :
                   h.trend === "declining" ? <TrendingDown size={14} className="text-danger-ink inline" /> :
                   <Minus size={14} className="text-muted inline" />}
                </td>
                <td className="px-4 py-3 text-[12px] text-ink-2">{h.risk_factors.slice(0, 2).join(" · ") || "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-16 text-center text-[14px] text-muted">No clients match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
