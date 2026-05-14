import { useEffect, useMemo, useState } from "react";
import { Archive, Package, Plus, Save, Search, Trash2 } from "lucide-react";
import { api, Supplier, SupplierInput, SupplierPriceEntry } from "../lib/api";

const emptyInput: SupplierInput = {
  name: "",
  contact_name: "",
  email: "",
  phone: "",
  address: "",
  payment_method: "",
  payment_details: "",
  payment_terms: "",
  typical_lead_time: "",
  notes: "",
};

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function SuppliersView() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [input, setInput] = useState<SupplierInput>(emptyInput);
  const [history, setHistory] = useState<SupplierPriceEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "archived">("active");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const rows = await api.listSuppliers();
    setSuppliers(rows);
    if (!selected && rows.length > 0) selectSupplier(rows[0]);
  };

  useEffect(() => { load().catch(console.error); }, []);

  const selectSupplier = async (s: Supplier) => {
    setSelected(s);
    setInput({
      name: s.name,
      contact_name: s.contact_name || "",
      email: s.email || "",
      phone: s.phone || "",
      address: s.address || "",
      payment_method: s.payment_method || "",
      payment_details: s.payment_details || "",
      payment_terms: s.payment_terms || "",
      typical_lead_time: s.typical_lead_time || "",
      notes: s.notes || "",
    });
    api.getSupplierPriceHistory(s.id).then(setHistory).catch(() => setHistory([]));
  };

  const filtered = useMemo(() => suppliers.filter((s) => {
    if (filter === "active" && s.archived) return false;
    if (filter === "archived" && !s.archived) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.contact_name || "").toLowerCase().includes(q);
  }), [suppliers, filter, query]);

  const save = async () => {
    if (!input.name.trim()) return;
    setSaving(true);
    try {
      if (selected) {
        await api.updateSupplier(selected.id, input);
      } else {
        await api.createSupplier(input);
      }
      await load();
    } finally {
      setSaving(false);
    }
  };

  const createNew = () => {
    setSelected(null);
    setInput(emptyInput);
    setHistory([]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 flex items-center gap-2"><Package size={24} />Suppliers</h1>
          <p className="text-sm text-zinc-500 mt-1">Contacts, payment details, and pricing history.</p>
        </div>
        <button onClick={createNew} className="flex items-center gap-1.5 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800">
          <Plus size={15} /> New Supplier
        </button>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-5">
        <aside className="bg-white border border-zinc-200 rounded-xl p-3 h-[calc(100vh-170px)] overflow-hidden flex flex-col">
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search suppliers..." className="w-full pl-9 pr-3 py-2 text-sm border border-zinc-200 rounded-lg" />
          </div>
          <div className="flex gap-1 mb-3">
            {(["all", "active", "archived"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`flex-1 px-2 py-1.5 rounded-md text-xs capitalize ${filter === f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>{f}</button>
            ))}
          </div>
          <div className="overflow-y-auto space-y-2">
            {filtered.map((s) => (
              <button key={s.id} onClick={() => selectSupplier(s)} className={`w-full text-left rounded-lg border p-3 ${selected?.id === s.id ? "border-indigo-300 bg-indigo-50" : "border-zinc-100 hover:bg-zinc-50"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-sm text-zinc-900 truncate">{s.name}</div>
                  {s.payment_method && <span className="text-[10px] bg-zinc-100 px-1.5 py-0.5 rounded text-zinc-500">{s.payment_method}</span>}
                </div>
                <div className="text-xs text-zinc-400 mt-1 truncate">{s.contact_name || s.phone || "No contact info"}</div>
                <div className="flex justify-between text-xs text-zinc-500 mt-2"><span>{fmt(s.total_paid)}</span><span>{s.deal_count} deals</span></div>
              </button>
            ))}
          </div>
        </aside>

        <section className="bg-white border border-zinc-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-zinc-900">{selected ? selected.name : "New Supplier"}</h2>
            <button onClick={save} disabled={saving || !input.name.trim()} className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-50">
              <Save size={14} /> {saving ? "Saving..." : "Save"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Supplier name"><input value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} className="input" /></Field>
            <Field label="Contact name"><input value={input.contact_name || ""} onChange={(e) => setInput({ ...input, contact_name: e.target.value })} className="input" /></Field>
            <Field label="Email"><input value={input.email || ""} onChange={(e) => setInput({ ...input, email: e.target.value })} className="input" /></Field>
            <Field label="Phone"><input value={input.phone || ""} onChange={(e) => setInput({ ...input, phone: e.target.value })} className="input" /></Field>
            <Field label="Payment method"><input value={input.payment_method || ""} onChange={(e) => setInput({ ...input, payment_method: e.target.value })} className="input" /></Field>
            <Field label="Payment terms"><input value={input.payment_terms || ""} onChange={(e) => setInput({ ...input, payment_terms: e.target.value })} className="input" /></Field>
            <Field label="Typical lead time"><input value={input.typical_lead_time || ""} onChange={(e) => setInput({ ...input, typical_lead_time: e.target.value })} className="input" /></Field>
            <Field label="Address"><input value={input.address || ""} onChange={(e) => setInput({ ...input, address: e.target.value })} className="input" /></Field>
          </div>
          <Field label="Payment details"><textarea value={input.payment_details || ""} onChange={(e) => setInput({ ...input, payment_details: e.target.value })} rows={3} className="input h-auto py-2" /></Field>
          <Field label="Notes"><textarea value={input.notes || ""} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={3} className="input h-auto py-2" /></Field>

          {selected && (
            <>
              <div className="grid grid-cols-4 gap-3 my-5">
                <Stat label="Total paid" value={fmt(selected.total_paid)} />
                <Stat label="Deals" value={String(selected.deal_count)} />
                <Stat label="Avg deal" value={fmt(selected.avg_deal_amount)} />
                <Stat label="Last deal" value={selected.last_deal_date ? new Date(selected.last_deal_date).toLocaleDateString() : "None"} />
              </div>

              <h3 className="text-sm font-semibold text-zinc-800 mb-2">Price History</h3>
              <div className="border border-zinc-100 rounded-lg overflow-hidden mb-5">
                {history.length === 0 ? <div className="p-4 text-sm text-zinc-400">No price history yet.</div> : history.map((h) => (
                  <div key={h.id} className="grid grid-cols-4 gap-2 px-3 py-2 text-xs border-b last:border-0">
                    <span>{new Date(h.recorded_at).toLocaleDateString()}</span><span>{h.item_description}</span><span>{h.quantity || "-"}</span><span>{fmt(h.price)}</span>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <button onClick={async () => { await api.archiveSupplier(selected.id); await load(); }} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border text-zinc-500"><Archive size={13} /> Archive</button>
                <button onClick={async () => { if (confirm("Delete supplier?")) { await api.deleteSupplier(selected.id); setSelected(null); await load(); } }} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border text-red-500"><Trash2 size={13} /> Delete</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mb-4"><span className="block text-xs text-zinc-500 mb-1.5">{label}</span>{children}</label>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="bg-zinc-50 border border-zinc-100 rounded-lg p-3"><div className="text-[10px] uppercase text-zinc-400 font-semibold">{label}</div><div className="text-sm font-bold text-zinc-800 mt-1">{value}</div></div>;
}
