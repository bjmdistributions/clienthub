import { useEffect, useState, Children } from "react";
import { api, Client, Interaction, Invoice, BuyerTier, PortalLink, CustomField } from "../lib/api";
import { fmtAmount } from "../lib/format";
import ReliabilityBadge from "./ReliabilityBadge";
import {
  ArrowLeft,
  Mail,
  Phone,
  Building2,
  Sparkles,
  RefreshCw,
  Plus,
  FileText,
  MessageSquare,
  ShoppingCart,
  Target,
  Calendar,
  User,
  Inbox,
  Clock,
  Tag,
} from "lucide-react";

interface Props {
  clientId: string;
  onBack: () => void;
}

const kindColor = (kind: string): string => {
  if (kind === "email_in")  return "bg-info-bg text-info-ink border border-info";
  if (kind === "email_out") return "bg-accent/10 text-accent-hover border border-accent/20";
  if (kind === "call")      return "bg-success-bg text-success-ink border border-success";
  if (kind === "meeting")   return "bg-warning-bg text-warning-ink border border-warning";
  if (kind === "whatsapp")  return "bg-success-bg text-success-ink border border-success";
  if (kind === "sms")       return "bg-info-bg text-info-ink border border-info";
  if (kind === "reminder")  return "bg-accent/10 text-accent border border-accent";
  return "bg-surface-3 text-ink-2 border border-line";
};

const invoiceStatusColor = (s: string): string => {
  if (s === "paid")    return "bg-warning-bg text-warning-ink border border-warning";
  if (s === "sent")    return "bg-info-bg text-info-ink border border-info";
  if (s === "overdue") return "bg-danger-bg text-danger-ink border border-danger";
  return "bg-surface-3 text-ink-2 border border-line";
};

const leadStatusColor = (s: string): string => {
  if (s === "hot_lead")        return "bg-danger-bg text-danger-ink border border-danger";
  if (s === "warm")            return "bg-warning-bg text-warning-ink border border-warning";
  if (s === "active_customer") return "bg-success-bg text-success-ink border border-success";
  if (s === "inactive")        return "bg-surface-3 text-muted border border-line";
  return "bg-accent/10 text-accent-hover border border-accent/20";
};

export default function ClientDetailView({ clientId, onBack }: Props) {
  const [client, setClient] = useState<Client | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [detailTab, setDetailTab] = useState<"overview" | "emails" | "invoices" | "timeline">("overview");
  const [tier, setTier] = useState<BuyerTier | null>(null);
  const [portalLink, setPortalLink] = useState<PortalLink | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const load = async () => {
    const c = await api.getClient(clientId);
    if (!c) { onBack(); return; }
    setClient(c);
    setInteractions(await api.listInteractions(clientId));
    setInvoices(await api.listInvoicesForClient(clientId));
    api.getBuyerTier(clientId).then(setTier).catch(() => {});
    api.listPortalLinks(clientId).then((links) => {
      const active = links.find((l) => l.is_active && new Date(l.expires_at) > new Date());
      if (active) setPortalLink(active);
    }).catch(() => {});
  };

  useEffect(() => { load(); }, [clientId]);
  useEffect(() => { api.listCustomFields().then(setCustomFields).catch(() => {}); }, []);

  const handleSummarize = async () => {
    setSummarizing(true);
    try {
      const s = await api.aiSummarizeHistory(clientId);
      setSummary(s);
    } catch (e: any) { alert(`AI error: ${e}`); }
    finally { setSummarizing(false); }
  };

  if (!client)
    return (
      <div className="text-muted">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink mb-5">
          <ArrowLeft size={14} /> Back
        </button>
        Loading...
      </div>
    );

  const outstanding = invoices
    .filter((i) => i.status === "sent" || i.status === "overdue")
    .reduce((s, i) => s + i.total, 0);
  const paid = invoices
    .filter((i) => i.status === "paid")
    .reduce((s, i) => s + i.total, 0);

  return (
    <div>
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink mb-5 transition-colors"
      >
        <ArrowLeft size={14} /> Back to Clients
      </button>

      {/* Header card */}
      <div className="bg-surface border border-line rounded-lg p-6 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[18px] font-semibold text-ink">{client.name}</h2>
            {client.company && (
              <div className="text-[13px] text-muted flex items-center gap-1.5 mt-1">
                <Building2 size={14} /> {client.company}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${leadStatusColor(client.lead_status)}`}>
                {client.lead_status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </span>
              {tier && (
                <>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ml-2 ${
                    tier.tier === "S" ? "bg-accent/10 text-accent-hover" :
                    tier.tier === "A" ? "bg-success-bg text-success-ink" :
                    tier.tier === "B" ? "bg-warning-bg text-warning-ink" :
                    "bg-surface-3 text-muted"
                  }`}>
                    Tier: {tier.tier === "S" ? "Diamond" : tier.tier === "A" ? "Gold" : tier.tier === "B" ? "Silver" : tier.tier === "C" ? "Bronze" : "Prospect"}
                  </span>
                  {tier.avg_commission_pct > 0 && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ml-1 ${
                      tier.avg_commission_pct >= 25 ? "bg-success-bg text-success-ink" :
                      tier.avg_commission_pct >= 10 ? "bg-warning-bg text-warning-ink" :
                      "bg-danger-bg text-danger-ink"
                    }`}>
                      {tier.avg_commission_pct.toFixed(1)}% avg margin
                    </span>
                  )}
                  <span className="ml-1 inline-flex">
                    <ReliabilityBadge reliability={tier.reliability} pct={tier.reliability_pct} quotesSent={tier.quotes_sent} quotesWon={tier.quotes_won} size="md" />
                  </span>
                </>
              )}
            </div>
            <div className="flex gap-4 mt-3">
              {client.email && (
                <div className="flex items-center gap-1.5">
                  <a
                    href={`mailto:${client.email}`}
                    className="flex items-center gap-1.5 text-[13px] text-accent hover:text-accent-hover"
                  >
                    <Mail size={14} /> {client.email}
                  </a>
                  <CopyEmail email={client.email} />
                </div>
              )}
              {client.phone && (
                <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <Phone size={14} /> {client.phone}
                </span>
              )}
            </div>
          </div>

          {/* Financial summary */}
          <div className="text-right">
            <div className="text-[12px] font-medium text-muted uppercase tracking-wide">Outstanding</div>
            <div className="text-[20px] font-semibold text-warning-ink tabular-nums mt-0.5">
              {fmtAmount(outstanding)}
            </div>
            <div className="text-[12px] font-medium text-muted uppercase tracking-wide mt-3">Paid</div>
            <div className="text-[16px] font-semibold text-success-ink tabular-nums mt-0.5">
              {fmtAmount(paid)}
            </div>
          </div>
        </div>

        {client.notes && (
          <div className="mt-4 px-4 py-3 bg-surface-2 border border-line rounded-lg text-[13px] text-ink-2">
            {client.notes}
          </div>
        )}

        <div className="mt-4 inline-flex items-center gap-2 bg-surface-3 text-ink-2 px-3 py-1.5 rounded-full text-[13px] font-medium">
          <ShoppingCart size={14} />
          <span className="font-semibold">{client.invoice_count}</span> invoices sent
        </div>

        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Client Portal</p>
          {portalLink ? (
            <>
              <div className="flex items-center gap-2">
                <input readOnly className="border border-line px-3 h-8 rounded-lg text-[12px] text-ink-2 bg-surface-2 flex-1 font-mono" value={portalLink.portal_url} />
                <button onClick={async () => { await navigator.clipboard.writeText(portalLink.portal_url); }}
                  className="bg-accent hover:bg-accent-hover text-white px-3 h-8 rounded-lg text-[11px] font-medium flex items-center gap-1">
                  Copy
                </button>
                <button onClick={async () => { if (confirm("Revoke this portal link?")) { await api.revokePortalLink(portalLink.token); setPortalLink(null); load(); } }}
                  className="text-[11px] text-danger-ink hover:text-danger-ink px-2 h-8 rounded-lg hover:bg-danger-bg">
                  Revoke
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input className="border border-line px-2 h-7 rounded text-[10px] w-48" placeholder="Portal base URL" value={portalLink.portal_url.split("/portal/")[0] || ""}
                  onChange={(e) => api.savePortalBaseUrl(e.target.value).then(() => load())} />
                <span className="text-[9px] text-muted">Set your domain or IP</span>
              </div>
            </>
          ) : (
            <button onClick={async () => { const l = await api.generatePortalLink(clientId); setPortalLink(l); }}
              className="bg-accent hover:bg-accent-hover text-white px-4 h-8 rounded-lg text-[12px] font-medium">
              Generate Portal Link
            </button>
          )}
          <p className="text-[10px] text-muted mt-1.5">Share this link so {client.name} can view their invoices. Expires in 30 days.</p>
        </div>
      </div>

      {/* Metadata cards */}
      {client.metadata && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <MetadataCard title="Contact Info" icon={<User size={14} />}>
            {client.metadata.job_title && <MetaRow label="Title" value={client.metadata.job_title} />}
            {client.metadata.street_address && <MetaRow label="Address" value={client.metadata.street_address} />}
            {(client.metadata.city || client.metadata.state) && (
              <MetaRow
                label=""
                value={[client.metadata.city, client.metadata.state, client.metadata.zip_code].filter(Boolean).join(" ")}
              />
            )}
            {client.metadata.country && <MetaRow label="Country" value={client.metadata.country} />}
          </MetadataCard>

          <MetadataCard title="Business Info" icon={<Building2 size={14} />}>
            {client.metadata.website && <MetaRow label="Website" value={client.metadata.website} />}
            {client.metadata.tax_id && <MetaRow label="Tax ID" value={client.metadata.tax_id} />}
            {client.metadata.primary_buy_category && <MetaRow label="Buy Category" value={client.metadata.primary_buy_category} />}
            {client.metadata.other_buy_categories && <MetaRow label="Other Categories" value={client.metadata.other_buy_categories} />}
            {client.metadata.estimated_annual_spend && <MetaRow label="Spend Per Frequency" value={client.metadata.estimated_annual_spend} />}
            {client.metadata.purchase_frequency && <MetaRow label="Frequency" value={client.metadata.purchase_frequency} />}
          </MetadataCard>

          <MetadataCard title="Lead Info" icon={<Target size={14} />}>
            {client.metadata.lead_source && <MetaRow label="Source" value={client.metadata.lead_source} />}
            {client.metadata.interest_level && <MetaRow label="Interest" value={client.metadata.interest_level} />}
            {client.metadata.buyer_type && <MetaRow label="Buyer Type" value={client.metadata.buyer_type} />}
            {client.metadata.lead_id && <MetaRow label="Lead ID" value={client.metadata.lead_id} />}
            {client.metadata.lead_representative && <MetaRow label="Rep" value={client.metadata.lead_representative} />}
            {client.metadata.date_added && <MetaRow label="Added" value={client.metadata.date_added} />}
            {client.metadata.last_contact_date && <MetaRow label="Last Contact" value={client.metadata.last_contact_date} />}
            {client.metadata.next_follow_up_date && (
              <div className="mt-2 first:mt-0">
                <span className="block text-[11px] font-medium text-muted uppercase tracking-wide mb-1">Follow Up</span>
                <input
                  type="date"
                  className="border border-line-3 px-2 h-8 rounded-md text-[13px] w-full focus:outline-none focus:ring-1 focus:ring-accent"
                  value={client.metadata.next_follow_up_date}
                  onChange={async (e) => {
                    const meta = { ...(client.metadata || {}), next_follow_up_date: e.target.value };
                    await api.updateClient(client.id, {
                      name: client.name, email: client.email, phone: client.phone,
                      company: client.company, notes: client.notes, metadata: meta,
                    });
                    load();
                  }}
                />
              </div>
            )}
          </MetadataCard>

          {customFields.length > 0 && (
            <MetadataCard title="Custom Fields" icon={<Tag size={14} />}>
              {customFields.map(f => (
                <MetaRow key={f.id} label={f.label} value={(client.metadata as any)?.[f.field_key] ?? ""} />
              ))}
            </MetadataCard>
          )}
        </div>
      )}

      {/* Detail tabs — underline style */}
      <div className="flex gap-0 border-b border-line mb-4">
        {(["overview", "emails", "invoices", "timeline"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setDetailTab(t)}
            className={`px-4 py-2.5 text-[14px] border-b-2 -mb-px capitalize transition-colors ${
              detailTab === t
                ? "border-accent text-accent-hover font-medium"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {detailTab === "overview" && (
        <>
          {/* AI Summary */}
          <div className="bg-accent/10 border border-accent/20 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[14px] font-semibold text-accent-hover flex items-center gap-2">
                <Sparkles size={14} /> AI Summary
              </h3>
              <button
                onClick={handleSummarize}
                disabled={summarizing || interactions.length === 0}
                className="text-[12px] font-medium bg-accent hover:bg-accent-hover text-white px-3 h-7 rounded-md disabled:opacity-50 flex items-center gap-1.5"
              >
                {summarizing && <RefreshCw size={10} className="animate-spin" />}
                {summary ? "Re-summarize" : "Summarize History"}
              </button>
            </div>
            {summary ? (
              <div className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{summary}</div>
            ) : (
              <p className="text-[13px] text-accent-hover">
                Click to generate a 3–5 bullet summary of outstanding asks, deliverables, and billing context.
              </p>
            )}
          </div>

          {/* Two-column: interactions + invoices */}
          <div className="grid grid-cols-2 gap-4">
            {/* Interactions */}
            <div className="bg-surface border border-line rounded-lg">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-line">
                <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2">
                  <MessageSquare size={14} className="text-muted" /> Interactions ({interactions.length})
                </h3>
                <button
                  onClick={() => setShowNoteForm(true)}
                  className="text-[12px] font-medium text-accent hover:text-accent-hover flex items-center gap-1"
                >
                  <Plus size={12} /> Add Note
                </button>
              </div>
              {showNoteForm && (
                <NoteForm
                  clientId={clientId}
                  onClose={() => { setShowNoteForm(false); load(); }}
                />
              )}
              <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                {["call", "meeting", "email_out", "whatsapp", "sms", "note"].map((k) => (
                  <button key={k} onClick={() => setKindFilter(kindFilter === k ? null : k)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize transition-colors ${kindFilter === k ? "bg-accent text-white border-accent" : "bg-surface text-muted border-line hover:bg-surface-2"}`}>
                    {k.replace("_", " ")}
                  </button>
                ))}
              </div>
              <div className="max-h-[500px] overflow-auto">
                {interactions.filter((it) => !kindFilter || it.kind === kindFilter).map((it) => (
                  <div key={it.id} className="px-4 py-3 border-b border-line last:border-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${kindColor(it.kind)}`}>
                        {it.kind}
                      </span>
                      <span className="text-[11px] text-muted">
                        {new Date(it.created_at).toLocaleString()}
                      </span>
                    </div>
                    {it.subject && <div className="text-[14px] font-medium text-ink">{it.subject}</div>}
                    {it.body && <div className="text-[13px] text-ink-2 mt-0.5 whitespace-pre-wrap">{it.body}</div>}
                  </div>
                ))}
                {interactions.length === 0 && (
                  <div className="px-4 py-8 text-center text-[14px] text-muted">No interactions yet.</div>
                )}
              </div>
            </div>

            {/* Invoices */}
            <div className="bg-surface border border-line rounded-lg">
              <div className="px-4 py-3.5 border-b border-line">
                <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2">
                  <FileText size={14} className="text-muted" /> Invoices ({invoices.length})
                </h3>
              </div>
              <div className="max-h-[500px] overflow-auto">
                {invoices.map((inv) => (
                  <div key={inv.id} className="px-4 py-3 border-b border-line last:border-0">
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-[12px] text-muted">{inv.number}</span>
                      <span className="text-[14px] font-semibold text-ink tabular-nums">{fmtAmount(inv.total)}</span>                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-[12px] text-muted">Due {inv.due_date.slice(0, 10)}</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${invoiceStatusColor(inv.status)}`}>
                        {inv.status}
                      </span>
                    </div>
                  </div>
                ))}
                {invoices.length === 0 && (
                  <div className="px-4 py-8 text-center text-[14px] text-muted">No invoices yet.</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Emails tab */}
      {detailTab === "emails" && (
        <div className="bg-surface border border-line rounded-lg">
          <div className="px-4 py-3.5 border-b border-line">
            <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2">
              <Inbox size={14} className="text-muted" /> Email Thread
            </h3>
          </div>
          <div className="max-h-[600px] overflow-auto">
            {interactions
              .filter((it) => it.kind === "email_in" || it.kind === "email_out")
              .map((it) => (
                <div key={it.id} className="px-4 py-3.5 border-b border-line last:border-0">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border mb-2 ${
                    it.kind === "email_in"
                      ? "bg-info-bg text-info-ink border-info"
                      : "bg-accent/10 text-accent-hover border-accent/20"
                  }`}>
                    {it.kind === "email_in" ? "Received" : "Sent"}
                  </span>
                  {it.subject && <div className="text-[14px] font-medium text-ink mb-1">{it.subject}</div>}
                  {it.body && <div className="text-[13px] text-ink-2 whitespace-pre-wrap">{it.body}</div>}
                  <div className="text-[11px] text-muted mt-1.5">{new Date(it.created_at).toLocaleString()}</div>
                </div>
              ))}
            {interactions.filter((it) => it.kind === "email_in" || it.kind === "email_out").length === 0 && (
              <div className="px-4 py-8 text-center text-[14px] text-muted">No email interactions yet.</div>
            )}
          </div>
        </div>
      )}

      {/* Invoices tab */}
      {detailTab === "invoices" && (
        <div className="bg-surface border border-line rounded-lg">
          <div className="px-4 py-3.5 border-b border-line">
            <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2">
              <FileText size={14} className="text-muted" /> Invoices ({invoices.length})
            </h3>
          </div>
          <div className="max-h-[600px] overflow-auto">
            {invoices.map((inv) => (
              <div key={inv.id} className="px-4 py-3 border-b border-line last:border-0">
                <div className="flex justify-between items-center">
                  <span className="font-mono text-[12px] text-muted">{inv.number}</span>
                  <span className="text-[14px] font-semibold text-ink tabular-nums">{fmtAmount(inv.total)}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[12px] text-muted">Due {inv.due_date.slice(0, 10)}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${invoiceStatusColor(inv.status)}`}>
                    {inv.status}
                  </span>
                </div>
              </div>
            ))}
            {invoices.length === 0 && (
              <div className="px-4 py-8 text-center text-[14px] text-muted">No invoices yet.</div>
            )}
          </div>
        </div>
      )}

      {/* Timeline tab */}
      {detailTab === "timeline" && (
        <div className="bg-surface border border-line rounded-lg">
          <div className="px-4 py-3.5 border-b border-line">
            <h3 className="text-[14px] font-semibold text-ink flex items-center gap-2">
              <Clock size={14} className="text-muted" /> Timeline
            </h3>
          </div>
          <div className="max-h-[600px] overflow-auto">
            {[
              ...interactions.map((it) => ({ type: "interaction", data: it, date: it.created_at })),
              ...invoices.map((inv) => ({ type: "invoice", data: inv, date: inv.issue_date })),
            ]
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .map((item, i) => (
                <div key={i} className="px-4 py-3 border-b border-line last:border-0">
                  <div className="text-[11px] text-muted mb-1">{new Date(item.date).toLocaleString()}</div>
                  {item.type === "interaction" && (
                    <>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${kindColor((item.data as Interaction).kind)}`}>
                        {(item.data as Interaction).kind}
                      </span>
                      {(item.data as Interaction).subject && (
                        <span className="text-[14px] font-medium text-ink ml-2">{(item.data as Interaction).subject}</span>
                      )}
                    </>
                  )}
                  {item.type === "invoice" && (
                    <>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-3 text-ink-2 border border-line uppercase tracking-wide">
                        invoice
                      </span>
                      <span className="font-mono text-[12px] text-muted ml-2">{(item.data as Invoice).number}</span>
                      <span className="text-[14px] font-semibold text-ink ml-2 tabular-nums">{fmtAmount((item.data as Invoice).total)}</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ml-2 ${invoiceStatusColor((item.data as Invoice).status)}`}>
                        {(item.data as Invoice).status}
                      </span>
                    </>
                  )}
                </div>
              ))}
            {interactions.length + invoices.length === 0 && (
              <div className="px-4 py-8 text-center text-[14px] text-muted">No activity yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataCard({
  title, icon, children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasContent = Children.toArray(children).length > 0;
  if (!hasContent) return null;
  return (
    <div className="bg-surface border border-line rounded-lg p-4">
      <h3 className="text-[12px] font-semibold text-muted uppercase tracking-wide flex items-center gap-2 mb-3 pb-2 border-b border-line">
        {icon}
        {title}
      </h3>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 first:mt-0">
      {label && <span className="block text-[11px] font-medium text-muted uppercase tracking-wide">{label}</span>}
      <span className="text-[13px] text-ink">{value}</span>
    </div>
  );
}

function NoteForm({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("note");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.addInteraction({
        client_id: clientId,
        kind,
        subject: subject || undefined,
        body,
      });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="px-4 py-3 bg-surface-2 border-b border-line">
      <div className="flex gap-2 mb-2">
        <select
          className="border border-line-3 px-2 h-8 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
          <option value="email_out">Email out</option>
        </select>
        <input
          placeholder="Subject (optional)"
          className="border border-line-3 px-3 h-8 rounded-md text-[13px] flex-1 focus:outline-none focus:ring-1 focus:ring-accent"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <textarea
        placeholder="Notes..."
        rows={3}
        className="border border-line-3 px-3 py-2 rounded-md text-[13px] w-full mb-2 focus:outline-none focus:ring-2 focus:ring-accent"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-[12px] text-muted hover:text-ink">Cancel</button>
        <button
          onClick={save}
          disabled={saving || !body.trim()}
          className="bg-accent hover:bg-accent-hover text-white px-3 h-7 rounded-md text-[12px] font-medium disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function CopyEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(email);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[12px] text-muted hover:text-ink-2"
      title="Copy email"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}
