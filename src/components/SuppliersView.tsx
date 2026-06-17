import { useEffect, useMemo, useState } from "react";
import { Archive, Package, Plus, Save, Search, Trash2, Phone, Mail, MapPin, X, ChevronDown, TrendingUp } from "lucide-react";
import { api, Supplier, SupplierInput, SupplierPriceEntry } from "../lib/api";
import { fmtAmount } from "../lib/format";

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

export default function SuppliersView() {
  const [suppliers,     setSuppliers]     = useState<Supplier[]>([]);
  const [selected,      setSelected]      = useState<Supplier | null>(null);
  const [input,         setInput]         = useState<SupplierInput>(emptyInput);
  const [history,       setHistory]       = useState<SupplierPriceEntry[]>([]);
  const [supplierDeals, setSupplierDeals] = useState<any[]>([]);
  const [dealsOpen,     setDealsOpen]     = useState(false);
  const [query,         setQuery]         = useState("");
  const [filter,        setFilter]        = useState<"all" | "active" | "archived">("active");
  const [saving,        setSaving]        = useState(false);
  const [showForm,      setShowForm]      = useState(false);

  const load = async () => {
    const rows = await api.listSuppliers();
    setSuppliers(rows);
  };

  useEffect(() => { load().catch(console.error); }, []);

  const selectSupplier = async (s: Supplier) => {
    setSelected(s);
    setInput({
      name:              s.name,
      contact_name:      s.contact_name      || "",
      email:             s.email             || "",
      phone:             s.phone             || "",
      address:           s.address           || "",
      payment_method:    s.payment_method    || "",
      payment_details:   s.payment_details   || "",
      payment_terms:     s.payment_terms     || "",
      typical_lead_time: s.typical_lead_time || "",
      notes:             s.notes             || "",
    });
    setShowForm(true);
    setDealsOpen(false);
    setSupplierDeals([]);
    api.getSupplierPriceHistory(s.id).then(setHistory).catch(() => setHistory([]));
    api.getDealsForSupplier(s.id).then(setSupplierDeals).catch(() => setSupplierDeals([]));
  };

  const filtered = useMemo(() => suppliers.filter((s) => {
    if (filter === "active"   && s.archived)  return false;
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
      setShowForm(false);
    } finally {
      setSaving(false);
    }
  };

  const createNew = () => {
    setSelected(null);
    setInput(emptyInput);
    setHistory([]);
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setSelected(null); };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Suppliers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {filtered.length} supplier{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={createNew}
          className="flex items-center gap-1.5 px-3 h-9 bg-ink hover:opacity-90 text-surface rounded-lg text-[13px] font-medium transition-colors"
        >
          <Plus size={14} /> New Supplier
        </button>
      </div>

      {/* Search + Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search suppliers or contacts..."
            className="w-full pl-8 pr-3 h-9 text-[13px] border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "active", "archived"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 h-9 rounded-lg text-[12px] font-medium capitalize transition-colors ${
                filter === f
                  ? "bg-gray-900 text-white"
                  : "bg-surface border border-line text-muted hover:border-line-3"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Grid of supplier cards */}
      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
            <Package size={18} className="text-faint" />
          </div>
          <p className="text-[14px] font-semibold text-ink-2">No suppliers yet</p>
          <p className="text-[12px] text-muted mt-1">Add your first supplier to get started</p>
          <button onClick={createNew} className="mt-3 text-[12px] font-medium text-accent hover:text-indigo-800">
            + Add supplier
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSupplier(s)}
              className={`text-left bg-surface border rounded-xl p-4 hover:shadow-[0_4px_14px_rgba(0,0,0,0.07)] transition-all ${
                selected?.id === s.id && showForm
                  ? "border-accent ring-2 ring-accent/10"
                  : "border-line hover:border-line"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink truncate">{s.name}</div>
                  {s.contact_name && (
                    <div className="text-[11px] text-muted mt-0.5 truncate">{s.contact_name}</div>
                  )}
                </div>
                {s.payment_method && (
                  <span className="flex-shrink-0 text-[10px] bg-surface-3 text-muted px-1.5 py-0.5 rounded font-medium">
                    {s.payment_method}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted mb-3 flex-wrap">
                {s.phone && (
                  <span className="flex items-center gap-1"><Phone size={9} /> {s.phone}</span>
                )}
                {s.email && (
                  <span className="flex items-center gap-1 truncate"><Mail size={9} /> {s.email}</span>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 pt-2.5 mt-auto">
                <div>
                  <div className="text-[11px] font-bold text-ink tabular-nums">{fmtAmount(s.total_paid)}</div>
                  <div className="text-[10px] text-muted">total paid</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-semibold text-ink-2">{s.deal_count}</div>
                  <div className="text-[10px] text-muted">deals</div>
                </div>
              </div>
              {s.archived && (
                <div className="mt-2 text-[10px] text-warning-ink font-medium">Archived</div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Slide-in detail form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20" onClick={closeForm} />
          <div className="relative bg-surface w-full max-w-lg shadow-2xl flex flex-col overflow-y-auto">
            {/* Form header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-surface z-10">
              <div>
                <h3 className="text-[15px] font-semibold text-ink">
                  {selected ? selected.name : "New Supplier"}
                </h3>
                {selected?.contact_name && (
                  <p className="text-[12px] text-muted mt-0.5">{selected.contact_name}</p>
                )}
              </div>
              <button onClick={closeForm} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors">
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 px-6 py-5 space-y-5">
              {/* Stats row if editing */}
              {selected && (
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: "Total Paid", value: fmtAmount(selected.total_paid) },
                    { label: "Deals",      value: String(selected.deal_count) },
                    { label: "Avg Deal",   value: fmtAmount(selected.avg_deal_amount) },
                    { label: "Last Deal",  value: selected.last_deal_date
                        ? new Date(selected.last_deal_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "None" },
                  ].map((st) => (
                    <div key={st.label} className="bg-surface-2 border border-line rounded-lg px-3 py-2">
                      <div className="text-[9px] uppercase font-semibold text-muted tracking-wider">{st.label}</div>
                      <div className="text-[13px] font-bold text-ink mt-0.5 tabular-nums">{st.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Core info */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest">Supplier Info</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Supplier name *">
                    <input value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} className="field-input" />
                  </Field>
                  <Field label="Contact name">
                    <input value={input.contact_name || ""} onChange={(e) => setInput({ ...input, contact_name: e.target.value })} className="field-input" placeholder="e.g. John Smith" />
                  </Field>
                  <Field label="Email">
                    <input type="email" value={input.email || ""} onChange={(e) => setInput({ ...input, email: e.target.value })} className="field-input" />
                  </Field>
                  <Field label="Phone">
                    <input type="tel" value={input.phone || ""} onChange={(e) => setInput({ ...input, phone: e.target.value })} className="field-input" />
                  </Field>
                </div>
                <Field label="Address">
                  <input value={input.address || ""} onChange={(e) => setInput({ ...input, address: e.target.value })} className="field-input" placeholder="Street, City, State ZIP" />
                </Field>
              </div>

              {/* Payment */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest">Payment</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Payment method">
                    <input value={input.payment_method || ""} onChange={(e) => setInput({ ...input, payment_method: e.target.value })} className="field-input" placeholder="e.g. Bank Transfer" />
                  </Field>
                  <Field label="Payment terms">
                    <input value={input.payment_terms || ""} onChange={(e) => setInput({ ...input, payment_terms: e.target.value })} className="field-input" placeholder="e.g. Net 30" />
                  </Field>
                </div>
                <Field label="Payment details">
                  <textarea value={input.payment_details || ""} onChange={(e) => setInput({ ...input, payment_details: e.target.value })} rows={3} className="field-input resize-none" placeholder="Bank account, routing, etc." />
                </Field>
              </div>

              {/* Logistics */}
              <div className="space-y-3">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest">Logistics</p>
                <Field label="Typical lead time">
                  <input value={input.typical_lead_time || ""} onChange={(e) => setInput({ ...input, typical_lead_time: e.target.value })} className="field-input" placeholder="e.g. 3-5 business days" />
                </Field>
                <Field label="Notes">
                  <textarea value={input.notes || ""} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={3} className="field-input resize-none" />
                </Field>
              </div>

              {/* Completed Deals */}
              {selected && (
                <div>
                  <button
                    onClick={() => setDealsOpen((v) => !v)}
                    className="w-full flex items-center justify-between text-left"
                  >
                    <p className="text-[10px] font-semibold text-muted uppercase tracking-widest">
                      Completed Deals ({supplierDeals.length})
                    </p>
                    <ChevronDown size={13} className={`text-muted transition-transform ${dealsOpen ? "rotate-180" : ""}`} />
                  </button>

                  {dealsOpen && (
                    <div className="mt-2 border border-line rounded-lg overflow-hidden">
                      {supplierDeals.length === 0 ? (
                        <div className="px-4 py-6 text-center text-[12px] text-muted">
                          No completed deals with this supplier yet
                        </div>
                      ) : (
                        <div className="divide-y divide-gray-50">
                          {supplierDeals.map((d: any) => {
                            const margin = d.gross_revenue > 0
                              ? ((d.net_profit / d.gross_revenue) * 100).toFixed(1)
                              : null;
                            return (
                              <div key={d.id} className="px-4 py-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[12px] font-medium text-ink truncate">
                                      {d.client_name || "—"}
                                    </div>
                                    <div className="text-[11px] text-muted flex items-center gap-1.5 mt-0.5">
                                      {d.invoice_number && (
                                        <span className="font-mono bg-surface-3 px-1 rounded text-ink-2">
                                          {d.invoice_number}
                                        </span>
                                      )}
                                      {d.completed_at && (
                                        <span>
                                          {new Date(d.completed_at).toLocaleDateString("en-US", {
                                            month: "short", day: "numeric", year: "numeric",
                                          })}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-[12px] font-bold text-ink tabular-nums">
                                      {fmtAmount(d.supplier_amount)}
                                    </div>
                                    {margin !== null && (
                                      <div className={`text-[10px] tabular-nums font-medium ${
                                        parseFloat(margin) >= 20 ? "text-success-ink"
                                        : parseFloat(margin) >= 0 ? "text-warning-ink"
                                        : "text-danger-ink"
                                      }`}>
                                        {margin}% margin
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Price history */}
              {selected && history.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Price History</p>
                  <div className="border border-line rounded-lg overflow-hidden">
                    <div className="grid grid-cols-4 px-3 py-2 bg-surface-2 text-[10px] font-semibold text-muted uppercase tracking-widest">
                      <span>Date</span><span>Item</span><span>Qty</span><span>Price</span>
                    </div>
                    {history.map((h) => (
                      <div key={h.id} className="grid grid-cols-4 px-3 py-2 text-[12px] border-t border-gray-50">
                        <span className="text-muted">{new Date(h.recorded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                        <span className="text-ink-2 truncate">{h.item_description}</span>
                        <span className="text-muted">{h.quantity || "—"}</span>
                        <span className="font-medium text-ink tabular-nums">{fmtAmount(h.price)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="sticky bottom-0 bg-surface border-t border-line px-6 py-4 flex items-center gap-2">
              <button
                onClick={save}
                disabled={saving || !input.name.trim()}
                className="flex-1 flex items-center justify-center gap-1.5 h-10 bg-accent hover:bg-accent-hover text-white rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                <Save size={14} /> {saving ? "Saving…" : "Save Supplier"}
              </button>
              {selected && (
                <>
                  <button
                    onClick={async () => { await api.archiveSupplier(selected.id); await load(); closeForm(); }}
                    className="flex items-center gap-1.5 h-10 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                  >
                    <Archive size={13} /> Archive
                  </button>
                  <button
                    onClick={async () => {
                      if (confirm("Permanently delete this supplier?")) {
                        await api.deleteSupplier(selected.id);
                        await load();
                        closeForm();
                      }
                    }}
                    className="flex items-center gap-1.5 h-10 px-3 border border-danger text-danger-ink hover:bg-danger-bg rounded-lg text-[12px] transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
