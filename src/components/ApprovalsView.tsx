import { useEffect, useState } from "react";
import { api, type ApprovalRequest, type Client, type ClientInput } from "../lib/api";

const kindLabel = (k: string) =>
  k === "client_add" ? "New client" : k === "client_delete" ? "Delete client" : k;

function ApprovalDetail({ a, onClose, onResolved }: { a: ApprovalRequest; onClose: () => void; onResolved: () => void }) {
  const [client, setClient] = useState<Client | null>(null);
  const [form, setForm] = useState<ClientInput | null>(null);
  const [busy, setBusy] = useState(false);
  const isDelete = a.kind === "client_delete";

  useEffect(() => {
    if (!a.entity_id) return;
    api.getClient(a.entity_id).then((c) => {
      setClient(c);
      if (c) setForm({
        name: c.name, email: c.email, phone: c.phone, company: c.company,
        notes: c.notes, category: c.category, lead_status: c.lead_status,
      });
    }).catch(() => {});
  }, [a.entity_id]);

  const set = (key: keyof ClientInput, v: string) => setForm((f) => (f ? { ...f, [key]: v } : f));
  const Field = ({ label, k }: { label: string; k: keyof ClientInput }) => (
    <div>
      <label className="block text-[10px] uppercase tracking-wide text-muted mb-1">{label}</label>
      <input
        className="w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
        value={(form as any)?.[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        disabled={isDelete}
      />
    </div>
  );

  const save = async () => {
    if (!form || !a.entity_id) return;
    setBusy(true); await api.updateClient(a.entity_id, form).catch(() => {}); setBusy(false);
  };
  const decide = async (approve: boolean) => {
    setBusy(true);
    if (approve && !isDelete && form && a.entity_id) await api.updateClient(a.entity_id, form).catch(() => {});
    await api.resolveApprovalRequest(a.id, approve).catch(() => {});
    setBusy(false); onResolved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-5 max-h-[88vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-ink">{kindLabel(a.kind)}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink text-[15px] leading-none">✕</button>
        </div>
        <div className="text-[11px] text-muted mb-4">
          {a.requested_by_name ? `Requested by ${a.requested_by_name} · ` : ""}{new Date(a.created_at).toLocaleString()}
        </div>
        {isDelete ? (
          <div className="text-[13px] text-ink mb-4 bg-surface-2 border border-line rounded-lg p-3">
            Approving will <b>permanently delete</b> {client?.name || a.summary}.
          </div>
        ) : form ? (
          <div className="space-y-3 mb-4">
            <Field label="Name" k="name" />
            <div className="grid grid-cols-2 gap-3"><Field label="Email" k="email" /><Field label="Phone" k="phone" /></div>
            <Field label="Company" k="company" />
            <Field label="Category" k="category" />
            <Field label="Notes" k="notes" />
            <p className="text-[11px] text-muted">Your edits are saved automatically when you approve.</p>
          </div>
        ) : (
          <div className="text-[13px] text-muted mb-4">Loading…</div>
        )}
        <div className="flex gap-2">
          {!isDelete && form && (
            <button disabled={busy} onClick={save} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-9 rounded-lg text-[12px] font-medium">Save</button>
          )}
          <button disabled={busy} onClick={() => decide(true)} className="flex-1 bg-accent hover:bg-accent-hover text-on-accent h-9 rounded-lg text-[13px] font-medium">{isDelete ? "Approve deletion" : "Approve"}</button>
          <button disabled={busy} onClick={() => decide(false)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-9 rounded-lg text-[12px] font-medium">Reject</button>
        </div>
      </div>
    </div>
  );
}

export function ApprovalsView() {
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ApprovalRequest | null>(null);

  const load = () =>
    api.listApprovalRequests().then((r) => { setItems(r); setLoading(false); }).catch(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const resolved = () => { setSelected(null); load(); window.dispatchEvent(new CustomEvent("approvals-changed")); };
  const quick = async (id: string, approve: boolean) => {
    await api.resolveApprovalRequest(id, approve).catch(() => {});
    await load(); window.dispatchEvent(new CustomEvent("approvals-changed"));
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-[18px] font-semibold text-ink mb-1">Pending approvals</h2>
      <p className="text-[12px] text-muted mb-5">Click a request to review the details and edit before approving.</p>
      {loading ? null : items.length === 0 ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-10 text-center">Nothing waiting on you 🎉</div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <div key={a.id} className="bg-surface border border-line rounded-xl p-4 flex items-center justify-between gap-4">
              <button className="min-w-0 text-left flex-1" onClick={() => setSelected(a)}>
                <div className="text-[14px] font-medium text-ink truncate">{a.summary || kindLabel(a.kind)}</div>
                <div className="text-[11px] text-muted mt-0.5">
                  {kindLabel(a.kind)}{a.requested_by_name ? ` · by ${a.requested_by_name}` : ""} · {new Date(a.created_at).toLocaleString()} · <span className="text-accent">review</span>
                </div>
              </button>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => quick(a.id, true)} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium">Approve</button>
                <button onClick={() => quick(a.id, false)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {selected && <ApprovalDetail a={selected} onClose={() => setSelected(null)} onResolved={resolved} />}
    </div>
  );
}
