import { useEffect, useState, Children } from "react";
import { api, Client, Interaction, Invoice, BuyerTier, PortalLink, CustomField } from "../lib/api";
import { fmtAmount, fmtPhone } from "../lib/format";
import ReliabilityBadge from "./ReliabilityBadge";
import CreditPanel from "./CreditPanel";
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
  Pencil,
  Trash2,
  AlertTriangle,
  X,
} from "lucide-react";

interface Props {
  clientId: string;
  onBack: () => void;
  /** Open the full edit form for this client (handled by the parent list view). */
  onEdit?: (client: Client) => void;
  /** Called after the client is deleted so the parent can refresh + leave. */
  onDeleted?: () => void;
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

// A premium labeled on/off switch. `tone` colours the ON state: accent for a
// positive flag (high-value), neutral for a quiet flag (no-bulk), danger for a
// caution flag (blacklist). Off is a calm muted rail. An internal pending guard
// swallows rapid double-clicks so the visible state can't desync from the server.
function FlagSwitch({ label, on, onToggle, title, tone = "accent" }: {
  label: string;
  on: boolean;
  onToggle: () => void | Promise<void>;
  title?: string;
  tone?: "accent" | "neutral" | "danger";
}) {
  const [busy, setBusy] = useState(false);
  const trackOn =
    tone === "danger" ? "bg-danger border-danger" :
    tone === "neutral" ? "bg-ink-2 border-ink-2" :
    "bg-accent border-accent";
  const click = () => {
    if (busy) return;
    setBusy(true);
    Promise.resolve(onToggle()).finally(() => setBusy(false));
  };
  return (
    <button
      onClick={click}
      role="switch"
      aria-checked={on}
      aria-busy={busy}
      title={title}
      disabled={busy}
      className={`group inline-flex items-center justify-between gap-3 w-[168px] pl-3 pr-2 h-8 rounded-lg border text-[12px] font-medium transition-colors disabled:opacity-70 ${
        on
          ? "bg-surface-2 border-line-3 text-ink"
          : "bg-surface border-line text-muted hover:text-ink-2 hover:border-line-3"
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`relative w-9 h-5 rounded-full flex-shrink-0 border transition-colors ${
          on ? trackOn : "bg-surface-3 border-line-3"
        }`}
      >
        <span
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-all ${
            on ? "left-[18px]" : "left-[3px]"
          }`}
        />
      </span>
    </button>
  );
}

// A calm key-stat tile for the profile header + financials.
function StatTile({ label, value, tone = "ink", hint }: { label: string; value: string; tone?: "ink" | "success" | "warning" | "danger" | "muted"; hint?: string }) {
  const valCls = tone === "success" ? "text-success-ink" : tone === "warning" ? "text-warning-ink" : tone === "danger" ? "text-danger-ink" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="bg-surface-2/60 border border-line-2 rounded-xl px-3.5 py-3">
      <div className="text-[12.5px] font-medium text-muted tracking-wide">{label}</div>
      <div className={`text-[17px] font-bold tabular-nums mt-1 truncate ${valCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-faint truncate mt-0.5">{hint}</div>}
    </div>
  );
}

function SubHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">{icon}{children}</div>;
}

export default function ClientDetailView({ clientId, onBack, onEdit, onDeleted }: Props) {
  const [client, setClient] = useState<Client | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [detailTab, setDetailTab] = useState<"overview" | "emails" | "invoices" | "timeline">("overview");
  const [tier, setTier] = useState<BuyerTier | null>(null);
  const [portalLink, setPortalLink] = useState<PortalLink | null>(null);
  const [credit, setCredit] = useState<{ credit_limit: number; exposure: number; available: number; over: boolean } | null>(null);
  const [creditEdit, setCreditEdit] = useState("");
  // Profit made from this client = sum of its completed deals' net profit.
  const [clientProfit, setClientProfit] = useState<number | null>(null);

  useEffect(() => {
    api.getClientCreditStatus(clientId)
      .then((c) => { setCredit(c); setCreditEdit(c.credit_limit > 0 ? String(c.credit_limit) : ""); })
      .catch(() => setCredit(null));
  }, [clientId]);
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const load = async () => {
    const c = await api.getClient(clientId);
    if (!c) { onBack(); return; }
    setClient(c);
    setInteractions(await api.listInteractions(clientId));
    setInvoices(await api.listInvoicesForClient(clientId));
    api.getBuyerTier(clientId).then(setTier).catch(() => {});
    // Sum net profit across this client's completed deal flows.
    api.listDealFlows().then((flows) => {
      const p = flows
        .filter((f) => f.client_id === clientId && f.stage === "complete")
        .reduce((s, f) => s + (f.net_profit || 0), 0);
      setClientProfit(p);
    }).catch(() => setClientProfit(null));
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
  const revenue = client.total_revenue || paid;

  // Sales rep — must be shown. Falls back to company name, then "Unassigned".
  const meta = client.metadata || {};
  const rep = (meta.lead_representative || meta.sales_rep || client.company || "").toString().trim();
  const repDisplay = rep || "Unassigned";
  const initials = (client.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  const lastActivityRaw = client.last_contact_at || interactions[0]?.created_at || null;
  const relTime = (d: string | null): string => {
    if (!d) return "—";
    const ms = Date.now() - new Date(d).getTime();
    if (isNaN(ms)) return "—";
    const days = Math.floor(ms / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };
  const tierLabel = tier ? (tier.tier === "S" ? "Diamond" : tier.tier === "A" ? "Gold" : tier.tier === "B" ? "Silver" : tier.tier === "C" ? "Bronze" : "Prospect") : null;
  const tierChipCls = tier ? (
    tier.tier === "S" ? "bg-accent/10 text-accent-hover" :
    tier.tier === "A" ? "bg-success-bg text-success-ink" :
    tier.tier === "B" ? "bg-warning-bg text-warning-ink" : "bg-surface-3 text-muted"
  ) : "";

  return (
    <div>
      {confirmDelete && (
        <DeleteClientModal
          name={client.name}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteClient(client.id);
            setConfirmDelete(false);
            if (onDeleted) onDeleted(); else onBack();
          }}
        />
      )}
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink mb-5 transition-colors"
      >
        <ArrowLeft size={14} /> Back to Clients
      </button>

      {/* ── Identity header ─────────────────────────────── */}
      <div className="bg-surface border border-line rounded-2xl p-6 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 text-accent-hover flex items-center justify-center text-[18px] font-bold flex-shrink-0">{initials}</div>
            <div className="min-w-0">
              <h2 className="text-[20px] font-bold text-ink truncate">{client.name}</h2>
              <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[13px] text-muted">
                {client.company && <span className="inline-flex items-center gap-1.5"><Building2 size={14} /> {client.company}</span>}
                <span className="inline-flex items-center gap-1.5" title="Sales rep"><User size={14} /> Rep: <span className={`font-medium ${rep ? "text-ink-2" : "text-faint"}`}>{repDisplay}</span></span>
              </div>
              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide border ${leadStatusColor(client.lead_status)}`}>
                  {client.lead_status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
                {tierLabel && <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${tierChipCls}`}>{tierLabel}</span>}
                {tier && tier.avg_commission_pct > 0 && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${
                    tier.avg_commission_pct >= 25 ? "bg-success-bg text-success-ink" : tier.avg_commission_pct >= 10 ? "bg-warning-bg text-warning-ink" : "bg-danger-bg text-danger-ink"
                  }`}>{tier.avg_commission_pct.toFixed(1)}% margin</span>
                )}
                {tier && <ReliabilityBadge reliability={tier.reliability} pct={tier.reliability_pct} quotesSent={tier.quotes_sent} quotesWon={tier.quotes_won} size="md" />}
              </div>
            </div>
          </div>

          {/* Flag switches — clear on/off */}
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            {/* Edit / Delete — restored after the profile redesign. Delete is a
                deliberate two-step (type-the-name) confirm to prevent data loss. */}
            <div className="flex items-center gap-1.5 mb-0.5">
              <button
                onClick={() => onEdit?.(client)}
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 transition-colors"
              >
                <Pencil size={13} /> Edit
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete client"
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-line text-faint hover:text-danger-ink hover:border-danger hover:bg-danger-bg transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <FlagSwitch label="High-value" tone="accent"
              on={!!(client.high_value || client.metadata?.high_value)}
              title="A positive label for your best buyers. Purely a tag — it does not change who receives newsletters."
              onToggle={async () => {
                const val = await api.toggleClientHighValue(client.id);
                setClient((c) => c ? { ...c, high_value: val, metadata: { ...(c.metadata || {}), high_value: val } } : c);
              }} />
            <FlagSwitch label="No bulk email" tone="neutral"
              on={!!(client.exclusive || client.metadata?.exclusive)}
              title="Keeps this client off mass newsletters and auto-add — for people you don't want to bulk-email."
              onToggle={async () => {
                const val = await api.toggleClientExclusive(client.id);
                setClient((c) => c ? { ...c, exclusive: val, metadata: { ...(c.metadata || {}), exclusive: val } } : c);
              }} />
            <FlagSwitch label="Blacklisted" tone="danger"
              on={!!client.is_blacklisted}
              title="Blacklisted clients are excluded from all sends."
              onToggle={async () => {
                const val = await api.toggleClientBlacklist(client.id);
                setClient((c) => c ? { ...c, is_blacklisted: val } : c);
              }} />
          </div>
        </div>

        {/* Key stats row */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mt-5">
          <StatTile label="Revenue" value={fmtAmount(revenue)} tone="ink" />
          <StatTile label="Profit" value={clientProfit === null ? "—" : fmtAmount(clientProfit)} tone={clientProfit !== null && clientProfit < 0 ? "danger" : "success"} hint={clientProfit === null ? undefined : "completed deals"} />
          <StatTile label="Orders" value={String(client.invoice_count)} tone="ink" hint={`${outstanding > 0 ? fmtAmount(outstanding) + " open" : "none open"}`} />
          <StatTile label="Last activity" value={relTime(lastActivityRaw)} tone="ink"
            hint={client.first_contact ? "no contact yet — never emailed" : undefined} />
        </div>

        {/* Contact line */}
        {(client.email || client.phone) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-4 pt-4 border-t border-line-2">
            {client.email && (
              <div className="flex items-center gap-1.5">
                <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 text-[13px] text-accent hover:text-accent-hover"><Mail size={14} /> {client.email}</a>
                <CopyEmail email={client.email} />
              </div>
            )}
            {client.phone && <span className="flex items-center gap-1.5 text-[13px] text-ink-2"><Phone size={14} /> {fmtPhone(client.phone)}</span>}
          </div>
        )}
      </div>

      {/* ── Financials: credit + portal ─────────────────── */}
      <div className="bg-surface border border-line rounded-2xl p-6 mb-4">
        <SubHeading icon={<ShoppingCart size={15} className="text-muted" />}>Financials</SubHeading>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
          <StatTile label="Outstanding" value={fmtAmount(outstanding)} tone={outstanding > 0 ? "warning" : "muted"} />
          <StatTile label="Paid" value={fmtAmount(paid)} tone="success" />
          <StatTile label="Invoices sent" value={String(client.invoice_count)} tone="ink" />
        </div>

        {credit && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 bg-surface-2 border border-line rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted uppercase tracking-wide font-semibold">Credit limit</span>
              <input value={creditEdit} onChange={(e) => setCreditEdit(e.target.value)}
                onBlur={async () => { const v = parseFloat(creditEdit) || 0; await api.setClientCreditLimit(client.id, v); const c = await api.getClientCreditStatus(client.id); setCredit(c); setCreditEdit(c.credit_limit > 0 ? String(c.credit_limit) : ""); }}
                placeholder="none" className="w-24 text-[13px] bg-surface border border-line rounded-lg px-2 py-1 text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
            <div className="text-[12px]"><span className="text-muted">Exposure: </span><span className="font-semibold text-ink tabular-nums">{fmtAmount(credit.exposure)}</span></div>
            {credit.credit_limit > 0 && <div className="text-[12px]"><span className="text-muted">Available: </span><span className={`font-semibold tabular-nums ${credit.over ? "text-danger-ink" : "text-success-ink"}`}>{fmtAmount(credit.available)}</span></div>}
            {credit.over && <span className="text-[10px] font-bold uppercase text-danger-ink bg-danger-bg border border-danger-ink/20 px-2 py-0.5 rounded">Over limit</span>}
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-line-2">
          <p className="text-[12.5px] font-medium text-muted mb-2">Client portal</p>
          {portalLink ? (
            <>
              <div className="flex items-center gap-2">
                <input readOnly className="border border-line px-3 h-8 rounded-lg text-[12px] text-ink-2 bg-surface-2 flex-1 font-mono" value={portalLink.portal_url} />
                <button onClick={async () => { await navigator.clipboard.writeText(portalLink.portal_url); }} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[11px] font-medium">Copy</button>
                <button onClick={async () => { if (confirm("Revoke this portal link?")) { await api.revokePortalLink(portalLink.token); setPortalLink(null); load(); } }} className="text-[11px] text-danger-ink px-2 h-8 rounded-lg hover:bg-danger-bg">Revoke</button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input className="border border-line px-2 h-7 rounded text-[10px] w-48" placeholder="Portal base URL" value={portalLink.portal_url.split("/portal/")[0] || ""} onChange={(e) => api.savePortalBaseUrl(e.target.value).then(() => load())} />
                <span className="text-[9px] text-muted">Set your domain or IP</span>
              </div>
            </>
          ) : (
            <button onClick={async () => { const l = await api.generatePortalLink(clientId); setPortalLink(l); }} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[12px] font-medium">Generate portal link</button>
          )}
          <p className="text-[10px] text-muted mt-1.5">Share this link so {client.name} can view their invoices. Expires in 30 days.</p>
        </div>

        {client.notes && (
          <div className="mt-4 pt-4 border-t border-line-2">
            <p className="text-[12.5px] font-medium text-muted mb-1.5">Notes</p>
            <div className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{client.notes}</div>
          </div>
        )}
      </div>

      {/* Metadata cards */}
      {client.metadata && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">
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
                <span className="block text-[12.5px] font-medium text-muted mb-1">Follow Up</span>
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

          <CreditPanel clientId={client.id} />

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
                className="text-[12px] font-medium bg-accent hover:bg-accent-hover text-on-accent px-3 h-7 rounded-md disabled:opacity-50 flex items-center gap-1.5"
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Interactions */}
            <div className="bg-surface border border-line rounded-lg min-w-0">
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
                    className={`text-[10px] px-2 py-0.5 rounded-full border font-medium capitalize transition-colors ${kindFilter === k ? "bg-accent text-on-accent border-accent" : "bg-surface text-muted border-line hover:bg-surface-2"}`}>
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
            <div className="bg-surface border border-line rounded-lg min-w-0">
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
      <h3 className="text-[13px] font-semibold text-ink-2 flex items-center gap-2 mb-3 pb-2 border-b border-line">
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
      {label && <span className="block text-[12.5px] font-medium text-muted">{label}</span>}
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
          className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-7 rounded-md text-[12px] font-medium disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// Deliberate two-step delete: the operator must type the client's exact name
// before the destructive action unlocks. Deletion cascades to interactions, so
// Jack wants this to always be intentional.
function DeleteClientModal({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const match = typed.trim() === name.trim();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-danger-bg text-danger-ink flex-shrink-0"><AlertTriangle size={17} /></span>
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Delete client</h2>
              <p className="text-[12px] text-muted mt-0.5">This permanently removes the client and all their interactions.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>
        <div className="px-5 pb-4">
          <p className="text-[13px] text-ink-2 mb-2">
            To confirm, type <span className="font-semibold text-ink">{name}</span> below.
          </p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && match && !busy) { setBusy(true); Promise.resolve(onConfirm()).finally(() => setBusy(false)); } }}
            placeholder={name}
            className="w-full bg-surface-2 border border-line rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-danger/40 focus:border-danger transition-colors"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={onClose} disabled={busy}
            className="px-4 h-9 rounded-lg border border-line text-ink-2 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => { setBusy(true); Promise.resolve(onConfirm()).finally(() => setBusy(false)); }}
            disabled={!match || busy}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg bg-danger text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            <Trash2 size={14} /> {busy ? "Deleting…" : "Delete client"}
          </button>
        </div>
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
