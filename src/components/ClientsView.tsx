import { useEffect, useState } from "react";
import { api, Client, ClientInput } from "../lib/api";
import { Plus, Trash2, Edit2, Search, ShoppingCart, Clock } from "lucide-react";
import ClientDetailView from "./ClientDetailView";

const fmtAmount = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const relTime = (d: string | null | undefined): string => {
  if (!d) return "Never";
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

const STALE_OPTIONS = [30, 60, 90];
const LEAD_STATUSES = ["prospect", "hot_lead", "warm", "active_customer", "inactive"];

const statusLabel = (s: string): string => {
  const m: Record<string, string> = {
    prospect: "Prospect",
    hot_lead: "Hot Lead",
    warm: "Warm",
    active_customer: "Active",
    inactive: "Inactive",
  };
  return m[s] ?? s;
};

const statusColor = (s: string): string => {
  if (s === "hot_lead") return "bg-red-100 text-red-700";
  if (s === "warm") return "bg-orange-100 text-orange-700";
  if (s === "active_customer") return "bg-green-100 text-green-700";
  if (s === "inactive") return "bg-gray-100 text-gray-700";
  return "bg-blue-100 text-blue-700";
};

export default function ClientsView() {
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<Client | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [staleDays, setStaleDays] = useState<number | null>(null);
  const [leadFilter, setLeadFilter] = useState<string | null>(null);

  const load = async () => {
    if (query.trim()) {
      setClients(await api.searchClients(query));
    } else if (staleDays) {
      setClients(await api.listStaleClients(staleDays));
    } else {
      setClients(await api.listClients());
    }
  };
  useEffect(() => {
    load();
  }, [query, staleDays]);

  const filtered = leadFilter
    ? clients.filter((c) => c.lead_status === leadFilter)
    : clients;

  const handleSave = async (input: ClientInput) => {
    if (editing) await api.updateClient(editing.id, input);
    else await api.createClient(input);
    setShowForm(false);
    setEditing(null);
    load();
  };

  const handleDelete = async (id: string) => {
    const client = clients.find((c) => c.id === id);
    const name = client?.name || "this client";
    if (confirm(`Delete ${name}? This will also delete all their interactions. This cannot be undone.`)) {
      await api.deleteClient(id);
      load();
    }
  };

  if (detailId) {
    return (
      <ClientDetailView
        clientId={detailId}
        onBack={() => {
          setDetailId(null);
          load();
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Clients</h2>
        <button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
          className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded text-sm"
        >
          <Plus size={16} /> New Client
        </button>
      </div>

      <div className="relative mb-4">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
        <input
          placeholder="Search clients..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="border w-full pl-9 pr-3 py-2 rounded text-sm"
        />
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setStaleDays(null)}
          className={`px-3 py-1 text-xs rounded ${staleDays === null ? "bg-slate-900 text-white" : "bg-slate-100"}`}
        >
          All
        </button>
        {STALE_OPTIONS.map((d) => (
          <button
            key={d}
            onClick={() => setStaleDays(staleDays === d ? null : d)}
            className={`px-3 py-1 text-xs rounded ${staleDays === d ? "bg-slate-900 text-white" : "bg-slate-100"}`}
          >
            {d}+ days
          </button>
        ))}
        <span className="text-slate-300 mx-1">|</span>
        {LEAD_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setLeadFilter(leadFilter === s ? null : s)}
            className={`px-3 py-1 text-xs rounded ${leadFilter === s ? "bg-slate-900 text-white" : "bg-slate-100"}`}
          >
            {statusLabel(s)}
          </button>
        ))}
      </div>

      {showForm && (
        <ClientForm
          initial={editing}
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Company</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Phone</th>
              <th className="text-left p-3">Category</th>
              <th className="text-center p-3"># Invoices</th>
              <th className="text-left p-3">Last Contact</th>
              <th className="text-right p-3">Revenue</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => setDetailId(c.id)}
                className="border-t hover:bg-slate-50 cursor-pointer"
              >
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3">{c.company || "—"}</td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  <select
                    className={`text-xs px-2 py-0.5 rounded border-0 cursor-pointer ${statusColor(c.lead_status)}`}
                    value={c.lead_status}
                    onChange={async (e) => {
                      await api.updateClientStatus(c.id, e.target.value);
                      load();
                    }}
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>{statusLabel(s)}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">{c.email || "—"}</td>
                <td className="p-3">{c.phone || "—"}</td>
                <td className="p-3 text-sm">
                  {c.metadata?.primary_buy_category || "—"}
                </td>
                <td className="p-3 text-center">
                  <span className="inline-flex items-center gap-1 text-sm font-semibold">
                    <ShoppingCart size={12} />
                    {c.invoice_count}
                  </span>
                </td>
                <td className="p-3 text-sm">
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <Clock size={12} />
                    {relTime(c.last_contact_at)}
                  </span>
                </td>
                <td className="p-3 text-right font-semibold text-sm">
                  {fmtAmount(c.total_revenue || 0)}
                </td>
                <td className="p-3 text-right space-x-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => {
                      setEditing(c);
                      setShowForm(true);
                    }}
                    title="Edit"
                    className="text-slate-600 hover:text-slate-900"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    title="Delete"
                    className="text-red-500 hover:text-red-700"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-slate-400">
                  {query ? "No matches." : (
                    <div className="py-8">
                      <p className="text-lg mb-2">No clients yet</p>
                      <p className="text-sm mb-4">Add your first client to get started</p>
                      <button onClick={() => { setEditing(null); setShowForm(true); }}
                        className="bg-slate-900 text-white px-4 py-2 rounded text-sm">
                        Add Client
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClientForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Client | null;
  onSave: (input: ClientInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ClientInput>({
    name: initial?.name ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    company: initial?.company ?? "",
    notes: initial?.notes ?? "",
  });

  return (
    <div className="bg-white rounded-lg shadow p-5 mb-4">
      <h3 className="font-semibold mb-3">{initial ? "Edit Client" : "New Client"}</h3>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Field label="Name *">
          <input
            className="border p-2 rounded w-full"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Company">
          <input
            className="border p-2 rounded w-full"
            value={form.company ?? ""}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            className="border p-2 rounded w-full"
            value={form.email ?? ""}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input
            className="border p-2 rounded w-full"
            value={form.phone ?? ""}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          rows={3}
          className="border p-2 rounded w-full"
          value={form.notes ?? ""}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="px-4 py-2 text-sm">
          Cancel
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={!form.name.trim()}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <label className="block text-xs font-semibold text-slate-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}
