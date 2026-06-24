import { useEffect, useState } from "react";
import { api, type ApprovalRequest } from "../lib/api";

const kindLabel = (k: string) =>
  k === "client_add" ? "New client" : k === "client_delete" ? "Delete client" : k;

export function ApprovalsView() {
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.listApprovalRequests()
      .then((r) => { setItems(r); setLoading(false); })
      .catch(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const resolve = async (id: string, approve: boolean) => {
    await api.resolveApprovalRequest(id, approve).catch(() => {});
    await load();
    // Let the sidebar badge refresh its count.
    window.dispatchEvent(new CustomEvent("approvals-changed"));
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-[18px] font-semibold text-ink mb-1">Pending approvals</h2>
      <p className="text-[12px] text-muted mb-5">Requests from your team that need a decision.</p>
      {loading ? null : items.length === 0 ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-10 text-center">
          Nothing waiting on you 🎉
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <div key={a.id} className="bg-surface border border-line rounded-xl p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink truncate">{a.summary || kindLabel(a.kind)}</div>
                <div className="text-[11px] text-muted mt-0.5">
                  {kindLabel(a.kind)}{a.requested_by_name ? ` · by ${a.requested_by_name}` : ""} · {new Date(a.created_at).toLocaleString()}
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => resolve(a.id, true)}
                  className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-lg text-[12px] font-medium">Approve</button>
                <button onClick={() => resolve(a.id, false)}
                  className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
