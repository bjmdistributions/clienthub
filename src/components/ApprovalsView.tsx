import { useEffect, useState } from "react";
import { api, isUnavailable, type ApprovalRequest, type Client, type ClientInput, type LeadNotification, type OrUnavailable } from "../lib/api";
import PendingReviewModal from "./PendingReviewModal";
import { UserPlus, Inbox, ChevronRight, X, Store, Megaphone, Check } from "lucide-react";
import StatusPill from "./StatusPill";

const kindLabel = (k: string) =>
  k === "client_add" ? "New client" : k === "client_delete" ? "Delete client" : k === "listing_stale" ? "Storefront listing" : k === "unsubscribe" ? "Unsubscribed" : k;

function sourceLabel(m: Record<string, any> | null | undefined): string {
  const s = String(m?.source || "");
  if (s === "shopify") return "Shopify";
  if (s === "intake") return "Web form";
  if (s === "form") return "Ecliptr form";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

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
      <label className="block text-[12px] font-medium text-muted mb-1">{label}</label>
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
          <button onClick={onClose} className="text-muted hover:text-ink p-0.5"><X size={15} /></button>
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

// A standardized supply-lead alert (decision 3 in the R-263 plan): "Add as supplier"
// is a follow-up, not v1, so Acknowledge is the only action here. Server-backed
// (Pass 2) — shows "Unavailable" rather than the section disappearing. Fetched by
// the parent so its count can feed the page's empty-state check.
function SupplyLeadsSection({ leads, onAck }: { leads: OrUnavailable<LeadNotification[]> | null; onAck: (id: string) => void }) {
  if (leads === null) return null;
  const unavailable = isUnavailable(leads);
  const list = unavailable ? [] : leads;
  if (!unavailable && list.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5">
        <Megaphone size={15} className="text-muted" />
        <h3 className="text-[13px] font-semibold text-ink">Supplier leads</h3>
        {!unavailable && <span className="text-[11px] font-semibold text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full tabular-nums">{list.length}</span>}
      </div>
      {unavailable ? (
        <div className="text-[12px] text-muted bg-surface border border-line rounded-xl p-4">Unavailable</div>
      ) : (
        <div className="space-y-2.5">
          {list.map((n) => {
            let fields: Record<string, any> = {};
            try { fields = n.payload_json ? JSON.parse(n.payload_json) : {}; } catch { /* ignore */ }
            const fieldEntries = Object.entries(fields).filter(([, v]) => v != null && v !== "");
            return (
              <div key={n.id} className="bg-surface border border-line rounded-xl p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-ink">{n.title}</div>
                    <div className="text-[12px] text-muted mt-0.5">{n.body}</div>
                  </div>
                  <button onClick={() => onAck(n.id)}
                    className="flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium flex-shrink-0">
                    <Check size={13} /> Acknowledge
                  </button>
                </div>
                {fieldEntries.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-line-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {fieldEntries.map(([k, v]) => (
                      <div key={k} className="text-[12px]">
                        <span className="text-muted capitalize">{k.replace(/[_-]/g, " ")}: </span>
                        <span className="text-ink-2">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-[11px] text-faint mt-2">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ApprovalsView() {
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [pending, setPending] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ApprovalRequest | null>(null);
  const [reviewClient, setReviewClient] = useState<Client | null>(null);
  const [supplyLeads, setSupplyLeads] = useState<OrUnavailable<LeadNotification[]> | null>(null);

  // Archive toggle — swaps the whole page to resolved (approved/rejected)
  // requests, read-only. Server-backed (Pass 2); loaded once, on first switch.
  const [archived, setArchived] = useState(false);
  const [resolvedList, setResolvedList] = useState<Client[] | null>(null);
  const [resolvedUnavailable, setResolvedUnavailable] = useState(false);
  const [loadingResolved, setLoadingResolved] = useState(false);

  const load = () =>
    Promise.all([
      api.listApprovalRequests().then(setItems).catch(() => {}),
      api.getPendingApprovals().then(setPending).catch(() => {}),
      api.listLeadNotifications("supply_lead", "unread").then(setSupplyLeads),
    ]).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!archived || resolvedList !== null) return;
    setLoadingResolved(true);
    api.listResolvedApprovalRequests().then((r) => {
      if (isUnavailable(r)) { setResolvedUnavailable(true); setResolvedList([]); }
      else setResolvedList(r);
    }).finally(() => setLoadingResolved(false));
  }, [archived, resolvedList]);

  const resolved = () => { setSelected(null); load(); window.dispatchEvent(new CustomEvent("approvals-changed")); };
  const quick = async (id: string, approve: boolean) => {
    await api.resolveApprovalRequest(id, approve).catch(() => {});
    await load(); window.dispatchEvent(new CustomEvent("approvals-changed"));
  };
  const ackSupplyLead = async (id: string) => {
    await api.ackLeadNotification(id);
    setSupplyLeads((l) => (l && !isUnavailable(l) ? l.filter((n) => n.id !== id) : l));
  };

  // Stale storefront listings (renew or mark sold) get their own section; other
  // non-client_add requests (e.g. deletions) are team requests.
  const staleListings = items.filter((a) => a.kind === "listing_stale");
  const teamRequests = items.filter((a) => a.kind !== "client_add" && a.kind !== "listing_stale");
  const supplyLeadsCount = supplyLeads && !isUnavailable(supplyLeads) ? supplyLeads.length : 0;
  const total = pending.length + staleListings.length + teamRequests.length + supplyLeadsCount;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="text-[18px] font-semibold text-ink">Notifications</h2>
        <div className="inline-flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 flex-shrink-0">
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
      <p className="text-[12px] text-muted mb-5">Customers waiting on your review, and any requests from your team.</p>

      {archived ? (
        resolvedUnavailable ? (
          <div className="bg-surface border border-line rounded-2xl py-14 flex flex-col items-center">
            <div className="text-[13px] text-muted">Unavailable</div>
          </div>
        ) : loadingResolved ? (
          <div className="bg-surface border border-line rounded-2xl py-14 flex flex-col items-center">
            <div className="text-[13px] text-muted">Loading…</div>
          </div>
        ) : (resolvedList ?? []).length === 0 ? (
          <div className="bg-surface border border-line rounded-2xl py-14 flex flex-col items-center">
            <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3"><Inbox size={18} /></div>
            <div className="text-[13px] text-muted">No resolved requests yet</div>
          </div>
        ) : (
          <div className="bg-surface border border-line rounded-2xl divide-y divide-line-2 overflow-hidden">
            {(resolvedList ?? []).map((c) => {
              const src = sourceLabel(c.metadata);
              const approved = c.approval_status === "approved";
              const initials = (c.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
              return (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-9 h-9 rounded-full bg-surface-2 text-muted flex items-center justify-center text-[13px] font-bold flex-shrink-0">{initials}</span>
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
        )
      ) : loading ? null : total === 0 ? (
        <div className="bg-surface border border-line rounded-2xl py-14 flex flex-col items-center">
          <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3"><Inbox size={18} /></div>
          <div className="text-[13px] text-muted">Nothing waiting on you</div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Pending customers — click to open the full review */}
          {pending.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2.5">
                <UserPlus size={15} className="text-muted" />
                <h3 className="text-[13px] font-semibold text-ink">Pending customers</h3>
                <span className="text-[11px] font-semibold text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full tabular-nums">{pending.length}</span>
              </div>
              <div className="bg-surface border border-line rounded-2xl divide-y divide-line-2 overflow-hidden">
                {pending.map((c) => {
                  const src = sourceLabel(c.metadata);
                  const initials = (c.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
                  return (
                    <button key={c.id} onClick={() => setReviewClient(c)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                      <span className="w-9 h-9 rounded-full bg-accent/10 text-accent-hover flex items-center justify-center text-[13px] font-bold flex-shrink-0">{initials}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-semibold text-ink truncate">{c.name}</span>
                          {src && <StatusPill tone="neutral">{src}</StatusPill>}
                        </div>
                        <div className="text-[11.5px] text-muted truncate">{[c.email, c.company].filter(Boolean).join(" · ") || "New customer to review"}</div>
                      </div>
                      <span className="text-[11px] font-medium text-accent flex items-center gap-0.5 flex-shrink-0">Review <ChevronRight size={13} /></span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Storefront listings that have gone stale — renew or mark sold */}
          {staleListings.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2.5">
                <Store size={15} className="text-muted" />
                <h3 className="text-[13px] font-semibold text-ink">Storefront listings</h3>
                <span className="text-[11px] font-semibold text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full tabular-nums">{staleListings.length}</span>
              </div>
              <div className="space-y-2.5">
                {staleListings.map((a) => (
                  <div key={a.id} className="bg-surface border border-line rounded-xl p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink truncate">{(a.summary || "").replace(/^Renew or mark sold:\s*/, "") || "Listing"}</div>
                      <div className="text-[11px] text-muted mt-0.5">On your storefront 2+ days — renew to keep it live, or mark it sold.</div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => quick(a.id, true)} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium">Renew</button>
                      <button onClick={() => quick(a.id, false)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">Mark sold</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Team requests (deletions, etc.) */}
          {teamRequests.length > 0 && (
            <section>
              <h3 className="text-[13px] font-semibold text-ink mb-2.5">Team requests</h3>
              <div className="space-y-2.5">
                {teamRequests.map((a) => (
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
            </section>
          )}

          <SupplyLeadsSection leads={supplyLeads} onAck={ackSupplyLead} />
        </div>
      )}

      {reviewClient && (
        <PendingReviewModal client={reviewClient}
          onClose={() => setReviewClient(null)}
          onResolved={() => { setReviewClient(null); load(); window.dispatchEvent(new CustomEvent("approvals-changed")); }} />
      )}
      {selected && <ApprovalDetail a={selected} onClose={() => setSelected(null)} onResolved={resolved} />}
    </div>
  );
}
