import { useEffect, useState } from "react";
import { api, Client, ClientInput } from "../lib/api";
import { Plus, Trash2, Edit2, Search, ShoppingCart } from "lucide-react";
import ClientDetailView from "./ClientDetailView";

export default function ClientsView() {
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<Client | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = async () => {
    if (query.trim()) {
      setClients(await api.searchClients(query));
    } else {
      setClients(await api.listClients());
    }
  };
  useEffect(() => {
    load();
  }, [query]);

  const handleSave = async (input: ClientInput) => {
    if (editing) await api.updateClient(editing.id, input);
    else await api.createClient(input);
    setShowForm(false);
    setEditing(null);
    load();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this client? This is irreversible.")) {
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
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Phone</th>
              <th className="text-left p-3">Category</th>
              <th className="text-center p-3"># Invoices</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr
                key={c.id}
                onClick={() => setDetailId(c.id)}
                className="border-t hover:bg-slate-50 cursor-pointer"
              >
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3">{c.company || "—"}</td>
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
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  {query ? "No matches." : "No clients yet."}
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
