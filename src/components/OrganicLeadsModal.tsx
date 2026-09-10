import { useEffect, useState } from "react";
import { api, LeadClick, LeadDashboardStats, OrUnavailable, isUnavailable } from "../lib/api";
import { X, MessageCircle } from "lucide-react";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The "Organic leads" bubble's sub-view: WhatsApp click totals (decision 7 in the
// plan — these are events, not notifications) plus a per-lot breakdown.
export default function OrganicLeadsModal({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<OrUnavailable<LeadDashboardStats> | null>(null);
  const [clicks, setClicks] = useState<OrUnavailable<LeadClick[]> | null>(null);

  useEffect(() => {
    api.leadDashboardStats().then(setStats);
    api.listLeadClicks().then(setClicks);
  }, []);

  const statsUnavailable = stats !== null && isUnavailable(stats);
  const clicksUnavailable = clicks !== null && isUnavailable(clicks);
  const organic = stats !== null && !isUnavailable(stats) ? stats.organic_leads : null;
  const clickList = clicks !== null && !isUnavailable(clicks) ? clicks : [];

  // Group per lot; groups ordered by click count, each carrying its most recent click.
  const groups = (() => {
    const m = new Map<string, { lotName: string; count: number; latest: string }>();
    for (const c of clickList) {
      const key = c.lot_id || c.lot_name || "unknown";
      const label = c.lot_name || "Unlabeled lot";
      const g = m.get(key);
      if (g) { g.count += 1; if (c.created_at > g.latest) g.latest = c.created_at; }
      else m.set(key, { lotName: label, count: 1, latest: c.created_at });
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Organic leads</h2>
            <p className="text-[12px] text-muted mt-0.5">WhatsApp clicks from your storefront.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 border-b border-line-2">
          {statsUnavailable ? (
            <div className="text-[13px] text-muted">Unavailable</div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[20px] font-bold text-ink tabular-nums leading-none">{organic?.total ?? 0}</div>
                <div className="text-[11.5px] text-muted mt-1">Total</div>
              </div>
              <div>
                <div className="text-[20px] font-bold text-ink tabular-nums leading-none">{organic?.last_30d ?? 0}</div>
                <div className="text-[11.5px] text-muted mt-1">Last 30 days</div>
              </div>
              <div>
                <div className="text-[20px] font-bold text-ink tabular-nums leading-none">{organic?.today ?? 0}</div>
                <div className="text-[11.5px] text-muted mt-1">Today</div>
              </div>
            </div>
          )}
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">
          <div className="text-[12.5px] font-medium text-muted mb-2.5">By lot</div>
          {clicksUnavailable ? (
            <div className="text-[13px] text-muted text-center py-6">Unavailable</div>
          ) : groups.length === 0 ? (
            <div className="text-[13px] text-muted text-center py-6">No clicks yet.</div>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.lotName} className="flex items-center gap-3 bg-surface-2 border border-line rounded-lg px-3.5 py-2.5">
                  <span className="w-7 h-7 rounded-md bg-surface text-ink-2 border border-line-2 flex items-center justify-center flex-shrink-0"><MessageCircle size={13} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink truncate">{g.lotName}</div>
                    <div className="text-[11px] text-muted">Last click {fmtWhen(g.latest)}</div>
                  </div>
                  <div className="text-[13px] font-semibold text-ink tabular-nums flex-shrink-0">{g.count}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
