import { useEffect, useState } from "react";
import { api, Client, isUnavailable } from "../lib/api";
import { X, ChevronRight } from "lucide-react";
import StatusPill from "./StatusPill";
import PendingReviewModal from "./PendingReviewModal";

// Same source-label mapping used by PendingReviewModal / ApprovalsView.
function sourceLabel(m: Record<string, any> | null | undefined): string {
  const s = String(m?.source || "");
  if (s === "shopify") return "Shopify";
  if (s === "intake") return "Web form";
  if (s === "form") return "Ecliptr form";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

// The "New customer requests" bubble's sub-view. Pending requests reuse
// PendingReviewModal for accept/deny so approval logic lives in one place;
// the Archive toggle shows resolved requests read-only via listResolvedApprovalRequests
// (server-backed, Pass 2 — unavailable until then).
export default function CustomerRequestsModal({ pending, onClose, onResolved }: {
  pending: Client[];
  onClose: () => void;
  onResolved: () => void;
}) {
  const [list, setList] = useState(pending);
  useEffect(() => { setList(pending); }, [pending]);

  const [archived, setArchived] = useState(false);
  const [resolved, setResolved] = useState<Client[] | null>(null);
  const [resolvedUnavailable, setResolvedUnavailable] = useState(false);
  const [loadingResolved, setLoadingResolved] = useState(false);
  const [reviewClient, setReviewClient] = useState<Client | null>(null);

  useEffect(() => {
    if (!archived || resolved !== null) return;
    setLoadingResolved(true);
    api.listResolvedApprovalRequests().then((r) => {
      if (isUnavailable(r)) { setResolvedUnavailable(true); setResolved([]); }
      else setResolved(r);
    }).finally(() => setLoadingResolved(false));
  }, [archived, resolved]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">New customer requests</h2>
            <p className="text-[12px] text-muted mt-0.5">Customers waiting on your review.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>

        <div className="px-5 pt-3 flex-shrink-0">
          <div className="inline-flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
            <button onClick={() => setArchived(false)}
              className={`px-3 h-7 rounded-md text-[12px] font-medium transition-colors ${!archived ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
              Pending
            </button>
            <button onClick={() => setArchived(true)}
              className={`px-3 h-7 rounded-md text-[12px] font-medium transition-colors ${archived ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
              Archive
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          {!archived ? (
            list.length === 0 ? (
              <div className="text-[13px] text-muted text-center py-10">No pending requests.</div>
            ) : (
              <div className="divide-y divide-line-2 -mx-5">
                {list.map((c) => {
                  const src = sourceLabel(c.metadata);
                  return (
                    <button key={c.id} onClick={() => setReviewClient(c)}
                      className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2 transition-colors">
                      <span className="w-9 h-9 rounded-full bg-accent/10 text-accent-hover flex items-center justify-center text-[13px] font-bold flex-shrink-0">{initials(c.name)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-semibold text-ink truncate">{c.name}</span>
                          {src && <StatusPill tone="neutral">{src}</StatusPill>}
                        </div>
                        <div className="text-[11.5px] text-muted truncate">{[c.email, c.company].filter(Boolean).join(" · ") || "New customer to review"}</div>
                      </div>
                      <ChevronRight size={14} className="text-faint flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            )
          ) : resolvedUnavailable ? (
            <div className="text-[13px] text-muted text-center py-10">Unavailable</div>
          ) : loadingResolved ? (
            <div className="text-[13px] text-muted text-center py-10">Loading…</div>
          ) : (resolved ?? []).length === 0 ? (
            <div className="text-[13px] text-muted text-center py-10">No resolved requests yet.</div>
          ) : (
            <div className="divide-y divide-line-2 -mx-5">
              {(resolved ?? []).map((c) => {
                const src = sourceLabel(c.metadata);
                const approved = c.approval_status === "approved";
                return (
                  <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="w-9 h-9 rounded-full bg-surface-2 text-muted flex items-center justify-center text-[13px] font-bold flex-shrink-0">{initials(c.name)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13.5px] font-semibold text-ink truncate">{c.name}</span>
                        {src && <StatusPill tone="neutral">{src}</StatusPill>}
                      </div>
                      <div className="text-[11.5px] text-muted truncate">{[c.email, c.company].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                    <StatusPill tone={approved ? "success" : "danger"}>{approved ? "Approved" : "Rejected"}</StatusPill>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {reviewClient && (
        <PendingReviewModal
          client={reviewClient}
          onClose={() => setReviewClient(null)}
          onResolved={() => {
            setList((l) => l.filter((x) => x.id !== reviewClient.id));
            setReviewClient(null);
            onResolved();
          }}
        />
      )}
    </div>
  );
}
