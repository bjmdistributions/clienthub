import { useEffect, useState, Children } from "react";
import { api, Client, Interaction, Invoice } from "../lib/api";
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
  MapPin,
  Globe,
  Hash,
  TrendingUp,
  Target,
  Calendar,
  User,
} from "lucide-react";

interface Props {
  clientId: string;
  onBack: () => void;
}

export default function ClientDetailView({ clientId, onBack }: Props) {
  const [client, setClient] = useState<Client | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);

  const load = async () => {
    const c = await api.getClient(clientId);
    setClient(c);
    const i = await api.listInteractions(clientId);
    setInteractions(i);
    const all = await api.listInvoices();
    setInvoices(all.filter((inv) => inv.client_id === clientId));
  };

  useEffect(() => {
    load();
  }, [clientId]);

  const handleSummarize = async () => {
    setSummarizing(true);
    try {
      const s = await api.aiSummarizeHistory(clientId);
      setSummary(s);
    } catch (e: any) {
      alert(`AI error: ${e}`);
    } finally {
      setSummarizing(false);
    }
  };

  if (!client)
    return (
      <div className="text-slate-400">
        <button onClick={onBack} className="flex items-center gap-1 text-sm mb-4">
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
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-4"
      >
        <ArrowLeft size={14} /> Back to Clients
      </button>

      {/* Header card */}
      <div className="bg-white rounded-lg shadow p-6 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold">{client.name}</h2>
            {client.company && (
              <div className="text-slate-500 flex items-center gap-1 mt-1 text-sm">
                <Building2 size={14} /> {client.company}
              </div>
            )}
            <div className="flex gap-4 mt-3 text-sm">
              {client.email && (
                <a
                  href={`mailto:${client.email}`}
                  className="flex items-center gap-1 text-slate-600 hover:text-slate-900"
                >
                  <Mail size={14} /> {client.email}
                </a>
              )}
              {client.phone && (
                <span className="flex items-center gap-1 text-slate-600">
                  <Phone size={14} /> {client.phone}
                </span>
              )}
            </div>
          </div>
          <div className="text-right text-sm">
            <div className="text-slate-500">Outstanding</div>
            <div className="text-xl font-bold text-amber-600">
              ${outstanding.toFixed(2)}
            </div>
            <div className="text-slate-500 mt-2">Paid</div>
            <div className="text-base font-semibold text-green-600">
              ${paid.toFixed(2)}
            </div>
          </div>
        </div>

        {client.notes && (
          <div className="mt-4 p-3 bg-slate-50 rounded text-sm">{client.notes}</div>
        )}

        <div className="mt-4 inline-flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 rounded-full text-sm">
          <ShoppingCart size={14} />
          <span className="font-bold">{client.invoice_count}</span> invoices sent
        </div>
      </div>

      {client.metadata && (
        <div className="grid grid-cols-3 gap-4 mb-4">
          <MetadataCard title="Contact Info" icon={<User size={14} />}>
            {client.metadata.job_title && (
              <MetaRow label="Title" value={client.metadata.job_title} />
            )}
            {client.metadata.street_address && (
              <MetaRow label="Address" value={client.metadata.street_address} />
            )}
            {(client.metadata.city || client.metadata.state) && (
              <MetaRow
                label=""
                value={[client.metadata.city, client.metadata.state, client.metadata.zip_code]
                  .filter(Boolean)
                  .join(" ")}
              />
            )}
            {client.metadata.country && (
              <MetaRow label="Country" value={client.metadata.country} />
            )}
          </MetadataCard>

          <MetadataCard title="Business Info" icon={<Building2 size={14} />}>
            {client.metadata.website && (
              <MetaRow label="Website" value={client.metadata.website} />
            )}
            {client.metadata.tax_id && (
              <MetaRow label="Tax ID" value={client.metadata.tax_id} />
            )}
            {client.metadata.primary_buy_category && (
              <MetaRow
                label="Buy Category"
                value={client.metadata.primary_buy_category}
              />
            )}
            {client.metadata.other_buy_categories && (
              <MetaRow
                label="Other Categories"
                value={client.metadata.other_buy_categories}
              />
            )}
            {client.metadata.estimated_annual_spend && (
              <MetaRow
                label="Annual Spend"
                value={client.metadata.estimated_annual_spend}
              />
            )}
            {client.metadata.purchase_frequency && (
              <MetaRow
                label="Frequency"
                value={client.metadata.purchase_frequency}
              />
            )}
          </MetadataCard>

          <MetadataCard title="Lead Info" icon={<Target size={14} />}>
            {client.metadata.lead_source && (
              <MetaRow label="Source" value={client.metadata.lead_source} />
            )}
            {client.metadata.interest_level && (
              <MetaRow label="Interest" value={client.metadata.interest_level} />
            )}
            {client.metadata.buyer_type && (
              <MetaRow label="Buyer Type" value={client.metadata.buyer_type} />
            )}
            {client.metadata.lead_id && (
              <MetaRow label="Lead ID" value={client.metadata.lead_id} />
            )}
            {client.metadata.lead_representative && (
              <MetaRow label="Rep" value={client.metadata.lead_representative} />
            )}
            {client.metadata.date_added && (
              <MetaRow label="Added" value={client.metadata.date_added} />
            )}
            {client.metadata.last_contact_date && (
              <MetaRow label="Last Contact" value={client.metadata.last_contact_date} />
            )}
            {client.metadata.next_follow_up_date && (
              <MetaRow label="Follow Up" value={client.metadata.next_follow_up_date} />
            )}
          </MetadataCard>
        </div>
      )}

      {/* AI Summary */}
      <div className="bg-violet-50 border border-violet-200 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-violet-900 flex items-center gap-2">
            <Sparkles size={14} /> AI Summary
          </h3>
          <button
            onClick={handleSummarize}
            disabled={summarizing || interactions.length === 0}
            className="text-xs bg-violet-600 text-white px-3 py-1 rounded disabled:opacity-50 flex items-center gap-1"
          >
            {summarizing && <RefreshCw size={10} className="animate-spin" />}
            {summary ? "Re-summarize" : "Summarize History"}
          </button>
        </div>
        {summary ? (
          <div className="text-sm text-slate-700 whitespace-pre-wrap">{summary}</div>
        ) : (
          <p className="text-sm text-violet-700">
            Click to generate a 3-5 bullet summary of outstanding asks, deliverables,
            and billing context.
          </p>
        )}
      </div>

      {/* Two-column: interactions + invoices */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="font-semibold flex items-center gap-2">
              <MessageSquare size={14} /> Interactions ({interactions.length})
            </h3>
            <button
              onClick={() => setShowNoteForm(true)}
              className="text-xs text-slate-600 hover:text-slate-900 flex items-center gap-1"
            >
              <Plus size={12} /> Add Note
            </button>
          </div>
          {showNoteForm && (
            <NoteForm
              clientId={clientId}
              onClose={() => {
                setShowNoteForm(false);
                load();
              }}
            />
          )}
          <div className="max-h-[500px] overflow-auto">
            {interactions.map((it) => (
              <div key={it.id} className="p-3 border-b text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${kindColor(it.kind)}`}
                  >
                    {it.kind}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(it.created_at).toLocaleString()}
                  </span>
                </div>
                {it.subject && (
                  <div className="font-semibold text-sm">{it.subject}</div>
                )}
                {it.body && (
                  <div className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">
                    {it.body}
                  </div>
                )}
              </div>
            ))}
            {interactions.length === 0 && (
              <div className="p-6 text-center text-slate-400 text-sm">
                No interactions yet.
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b">
            <h3 className="font-semibold flex items-center gap-2">
              <FileText size={14} /> Invoices ({invoices.length})
            </h3>
          </div>
          <div className="max-h-[500px] overflow-auto">
            {invoices.map((inv) => (
              <div key={inv.id} className="p-3 border-b text-sm">
                <div className="flex justify-between items-center">
                  <span className="font-mono text-xs">{inv.number}</span>
                  <span className="font-semibold">${inv.total.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center mt-1 text-xs text-slate-500">
                  <span>Due {inv.due_date.slice(0, 10)}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded ${invoiceStatusColor(
                      inv.status
                    )}`}
                  >
                    {inv.status}
                  </span>
                </div>
              </div>
            ))}
            {invoices.length === 0 && (
              <div className="p-6 text-center text-slate-400 text-sm">
                No invoices yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetadataCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasContent = Children.toArray(children).length > 0;
  if (!hasContent) return null;
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold text-sm text-slate-700 flex items-center gap-2 mb-3 border-b pb-2">
        {icon}
        {title}
      </h3>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label && <span className="text-xs text-slate-400 block">{label}</span>}
      <span className="text-slate-700">{value}</span>
    </div>
  );
}

function NoteForm({
  clientId,
  onClose,
}: {
  clientId: string;
  onClose: () => void;
}) {
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3 bg-slate-50 border-b">
      <div className="flex gap-2 mb-2">
        <select
          className="border p-1 rounded text-sm"
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
          className="border p-1 rounded text-sm flex-1"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <textarea
        placeholder="Notes..."
        rows={3}
        className="border p-2 rounded text-sm w-full mb-2"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-xs">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving || !body.trim()}
          className="bg-slate-900 text-white px-3 py-1 rounded text-xs disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function kindColor(kind: string): string {
  if (kind === "email_in") return "bg-blue-100 text-blue-700";
  if (kind === "email_out") return "bg-violet-100 text-violet-700";
  if (kind === "call") return "bg-green-100 text-green-700";
  if (kind === "meeting") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function invoiceStatusColor(s: string): string {
  if (s === "paid") return "bg-green-100 text-green-700";
  if (s === "sent") return "bg-blue-100 text-blue-700";
  if (s === "overdue") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}
