import { useEffect, useState } from "react";
import { api, FollowUpLogEntry, FollowUpRule } from "../lib/api";
import { X, AlertCircle, CheckCircle2, Clock } from "lucide-react";

export default function AutomationLogView() {
  const [log, setLog] = useState<FollowUpLogEntry[]>([]);
  const [rules, setRules] = useState<FollowUpRule[]>([]);
  const [filterRule, setFilterRule] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [since, setSince] = useState("30");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [l, r] = await Promise.all([api.getFollowupLog(), api.listFollowupRules()]);
    setLog(l); setRules(r);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const ruleName = (ruleId: string) => rules.find(r => r.id === ruleId)?.name || ruleId.slice(0, 8);

  const sinceDate = () => {
    const d = new Date();
    if (since !== "all") d.setDate(d.getDate() - parseInt(since));
    return d.toISOString();
  };

  const filtered = log.filter(e => {
    if (filterRule && e.rule_id !== filterRule) return false;
    if (since !== "all" && e.triggered_at < sinceDate()) return false;
    return true;
  });

  return (
    <div>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <select value={filterRule} onChange={e => setFilterRule(e.target.value)}
          className="border border-line h-9 px-3 rounded-lg text-[13px] text-ink-2 bg-surface">
          <option value="">All rules</option>
          {rules.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input placeholder="Search..." value={filterClient} onChange={e => setFilterClient(e.target.value)}
          className="border border-line h-9 px-3 rounded-lg text-[13px] w-[180px] focus:outline-none focus:ring-2 focus:ring-accent/40" />
        <select value={since} onChange={e => setSince(e.target.value)}
          className="border border-line h-9 px-3 rounded-lg text-[13px] text-ink-2 bg-surface">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-[13px] text-muted"><Clock size={16} className="inline mr-1 animate-spin" /> Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[13px] text-muted">No automation activity yet</div>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50">
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Date</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Rule</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Action</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map(e => {
                const ok = !e.details?.includes("failed") && !e.details?.includes("error") && !e.details?.includes("SMTP");
                return (
                  <tr key={e.id} className="border-b border-gray-50 last:border-0 hover:bg-surface-2/60">
                    <td className="px-4 py-2.5 text-[12px] text-muted tabular-nums whitespace-nowrap">
                      {new Date(e.triggered_at).toLocaleDateString()} {new Date(e.triggered_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-2.5 text-[13px] font-medium text-ink">{ruleName(e.rule_id)}</td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-2">{e.action_taken}</td>
                    <td className="px-4 py-2.5">
                      {ok
                        ? <span className="inline-flex items-center gap-1 text-[11px] text-success-ink"><CheckCircle2 size={12} /> {e.details || "OK"}</span>
                        : <span className="inline-flex items-center gap-1 text-[11px] text-danger-ink"><AlertCircle size={12} /> {e.details || "Failed"}</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
