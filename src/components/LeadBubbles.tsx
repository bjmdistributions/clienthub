import { useEffect, useState } from "react";
import { api, Client, LeadDashboardStats, OrUnavailable, isUnavailable } from "../lib/api";
import { UserPlus, PhoneCall, Radar } from "lucide-react";
import StatusPill from "./StatusPill";
import CustomerRequestsModal from "./CustomerRequestsModal";
import BookedCallsModal from "./BookedCallsModal";
import OrganicLeadsModal from "./OrganicLeadsModal";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type Sub = "requests" | "calls" | "leads" | null;

// R-263: three metric bubbles beneath the Clients / Open deals / Completed
// this month row. Bubble 1 reuses the pending-approvals data DashboardView
// already loads; bubbles 2 and 3 are server-proxied (Pass 2) and read
// "Unavailable" — never crash — until those commands exist.
export default function LeadBubbles({ pendingApprovals, onApprovalsChanged }: {
  pendingApprovals: Client[];
  onApprovalsChanged: () => void;
}) {
  const [stats, setStats] = useState<OrUnavailable<LeadDashboardStats> | null>(null);
  const [open, setOpen] = useState<Sub>(null);

  const loadStats = () => { api.leadDashboardStats().then(setStats); };
  useEffect(() => { loadStats(); }, []);

  const statsUnavailable = stats !== null && isUnavailable(stats);
  const loaded = stats !== null && !isUnavailable(stats);
  const pendingCalls = loaded ? stats.pending_calls : 0;
  const nextCall = loaded ? stats.next_call : null;
  const organic = loaded ? stats.organic_leads : null;

  return (
    <>
      <div className="bg-surface-2/60 border border-line-2 rounded-2xl overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-line-2">
          <button onClick={() => setOpen("requests")}
            className="min-w-0 px-5 py-4 flex items-center gap-3.5 text-left hover:bg-surface-2 transition-colors">
            <span className="w-9 h-9 rounded-lg bg-surface text-ink-2 border border-line-2 flex items-center justify-center flex-shrink-0"><UserPlus size={16} strokeWidth={1.75} /></span>
            <div className="min-w-0">
              <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{pendingApprovals.length}</div>
              <div className="text-[12px] text-muted mt-1">New customer requests</div>
            </div>
          </button>

          <button onClick={() => setOpen("calls")}
            className="min-w-0 px-5 py-4 flex items-center gap-3.5 text-left hover:bg-surface-2 transition-colors">
            <span className="w-9 h-9 rounded-lg bg-surface text-ink-2 border border-line-2 flex items-center justify-center flex-shrink-0"><PhoneCall size={16} strokeWidth={1.75} /></span>
            <div className="min-w-0 flex-1">
              {statsUnavailable ? (
                <>
                  <div className="text-[13px] font-medium text-faint">Unavailable</div>
                  <div className="text-[12px] text-muted mt-1">Booked calls</div>
                </>
              ) : (
                <>
                  <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{pendingCalls}</div>
                  <div className="text-[12px] text-muted mt-1">Booked calls</div>
                  {nextCall && (
                    <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
                      <StatusPill tone="success">Next</StatusPill>
                      <span className="text-[11px] text-ink-2 truncate">{nextCall.name} · {fmtWhen(nextCall.scheduled_at)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </button>

          <button onClick={() => setOpen("leads")}
            className="min-w-0 px-5 py-4 flex items-center gap-3.5 text-left hover:bg-surface-2 transition-colors">
            <span className="w-9 h-9 rounded-lg bg-surface text-ink-2 border border-line-2 flex items-center justify-center flex-shrink-0"><Radar size={16} strokeWidth={1.75} /></span>
            <div className="min-w-0">
              {statsUnavailable ? (
                <>
                  <div className="text-[13px] font-medium text-faint">Unavailable</div>
                  <div className="text-[12px] text-muted mt-1">Organic leads</div>
                </>
              ) : (
                <>
                  <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{organic?.total ?? 0}</div>
                  <div className="text-[12px] text-muted mt-1">Organic leads</div>
                  <div className="text-[11px] text-faint mt-1">{organic?.last_30d ?? 0} in 30 days · {organic?.today ?? 0} today</div>
                </>
              )}
            </div>
          </button>
        </div>
      </div>

      {open === "requests" && (
        <CustomerRequestsModal
          pending={pendingApprovals}
          onClose={() => setOpen(null)}
          onResolved={onApprovalsChanged}
        />
      )}
      {open === "calls" && (
        <BookedCallsModal onClose={() => setOpen(null)} onChanged={loadStats} />
      )}
      {open === "leads" && (
        <OrganicLeadsModal onClose={() => setOpen(null)} />
      )}
    </>
  );
}
