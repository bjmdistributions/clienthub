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
        <h2 className="text-[18px] font-semibold text-gray-900">Customer Health</h2>
        <button onClick={load} className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-700">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4">
        {["all", "healthy", "watch", "at_risk", "critical"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 h-8 rounded-full text-[12px] font-medium transition-colors ${
              filter === f
                ? f === "critical" ? "bg-red-600 text-white" :
                  f === "at_risk" ? "bg-amber-500 text-white" :
                  f === "watch" ? "bg-yellow-500 text-white" :
                  f === "healthy" ? "bg-emerald-600 text-white" :
                  "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            {f === "all" ? "All" : f.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            {f !== "all" && <span className="ml-1 opacity-70">({scores.filter((s) => s.risk_level === f).length})</span>}
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Client</th>
              <th className="text-center px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Score</th>
              <th className="text-center px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Risk</th>
              <th className="text-center px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Trend</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Risk Factors</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((h) => (
              <tr key={h.client_id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 text-[14px] font-medium text-gray-900">{h.client_name}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-[13px] font-bold ${
                    h.risk_level === "critical" ? "bg-red-100 text-red-700" :
                    h.risk_level === "at_risk" ? "bg-amber-100 text-amber-700" :
                    h.risk_level === "watch" ? "bg-yellow-50 text-yellow-700" : "bg-emerald-50 text-emerald-700"
                  }`}>{h.score}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${
                    h.risk_level === "critical" ? "bg-red-50 text-red-700" :
                    h.risk_level === "at_risk" ? "bg-amber-50 text-amber-700" :
                    h.risk_level === "watch" ? "bg-yellow-50 text-yellow-700" : "bg-emerald-50 text-emerald-700"
                  }`}>{h.risk_level.replace("_", " ")}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  {h.trend === "improving" ? <TrendingUp size={14} className="text-emerald-500 inline" /> :
                   h.trend === "declining" ? <TrendingDown size={14} className="text-red-500 inline" /> :
                   <Minus size={14} className="text-gray-400 inline" />}
                </td>
                <td className="px-4 py-3 text-[12px] text-gray-600">{h.risk_factors.slice(0, 2).join(" · ") || "—"}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-16 text-center text-[14px] text-gray-400">No clients match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
