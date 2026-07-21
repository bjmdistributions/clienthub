import { useEffect, useMemo, useState } from "react";
import { Archive, Package, Plus, Save, Search, Trash2, Phone, Mail, MapPin, X, ChevronRight, TrendingUp } from "lucide-react";
import { api, Supplier, SupplierInput, SupplierPriceEntry } from "../lib/api";
import { fmtAmount, fmtPhone } from "../lib/format";
import SupplierDealsModal from "./SupplierDealsModal";

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
  const [dealsModalOpen,setDealsModalOpen]= useState(false);
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
    setDealsModalOpen(false);
    setSupplierDeals([]);
    api.getSupplierPriceHistory(s.id).then(setHistory).catch(() => setHistory([]));
    api.getDealsForSupplier(s.id)
      .then(setSupplierDeals)
      .catch(() => setSupplierDeals([]));
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
    setSupplierDeals([]);
    setDealsModalOpen(false);
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setSelected(null); };

  // Reopen/Delete/payout-toggle inside a breakdown → refresh supplier totals + its
  // deals. The modal awaits this, then re-fetches its own open breakdown.
  const reloadDeal = async () => {
    const rows = await api.listSuppliers();
    setSuppliers(rows);
    const fresh = selected ? rows.find((r) => r.id === selected.id) : null;
    if (!fresh) return;
    setSelected(fresh);
    const deals = await api.getDealsForSupplier(fresh.id).catch(() => []);
    setSupplierDeals(deals);
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">Suppliers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {filtered.length} supplier{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={createNew}
          className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium transition-colors"
        >
          <Plus size={14} /> New supplier
        </button>
      </div>

      {/* Search + Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search suppliers or contacts…"
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
                  ? "bg-accent text-on-accent"
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
          <button onClick={createNew} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
            + Add supplier
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSupplier(s)}
              className={`text-left bg-surface border rounded-xl p-4 min-w-0 hover:shadow-[0_4px_14px_rgba(0,0,0,0.07)] transition-all ${
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
                  <span className="flex items-center gap-1"><Phone size={9} /> {fmtPhone(s.phone)}</span>
                )}
                {s.email && (
                  <span className="flex items-center gap-1 truncate"><Mail size={9} /> {s.email}</span>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-line-2 pt-2.5 mt-auto">
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
          <div className="relative bg-surface w-full max-w-[min(92vw,32rem)] shadow-2xl flex flex-col overflow-y-auto">
            {/* Form header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-surface z-10">
              <div>
                <h3 className="text-[15px] font-semibold text-ink">
                  {selected ? selected.name : "New supplier"}
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
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "Total paid", value: fmtAmount(selected.total_paid) },
                    { label: "Deals",      value: String(selected.deal_count) },
                    { label: "Avg deal",   value: fmtAmount(selected.avg_deal_amount) },
                    { label: "Last deal",  value: selected.last_deal_date
                        ? new Date(selected.last_deal_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "None" },
                  ].map((st) => (
                    <div key={st.label} className="bg-surface-2 border border-line rounded-lg px-3 py-2 min-w-0">
                      <div className="text-[11.5px] font-medium text-muted truncate">{st.label}</div>
                      <div className="text-[13px] font-bold text-ink mt-0.5 tabular-nums truncate">{st.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Completed deals — opens the large browser modal */}
              {selected && (
                <button
                  onClick={() => setDealsModalOpen(true)}
                  className="w-full flex items-center justify-between gap-2 px-3 h-10 bg-surface-2 border border-line rounded-lg text-[12.5px] font-medium text-ink-2 hover:border-line-3 transition-colors"
                >
                  <span>View completed deals ({supplierDeals.length})</span>
                  <ChevronRight size={14} className="text-muted flex-shrink-0" />
                </button>
              )}

              {/* Core info */}
              <div className="space-y-3">
                <p className="text-[12.5px] font-medium text-muted">Supplier info</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                <p className="text-[12.5px] font-medium text-muted">Payment</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                <p className="text-[12.5px] font-medium text-muted">Logistics</p>
                <Field label="Typical lead time">
                  <input value={input.typical_lead_time || ""} onChange={(e) => setInput({ ...input, typical_lead_time: e.target.value })} className="field-input" placeholder="e.g. 3-5 business days" />
                </Field>
                <Field label="Notes">
                  <textarea value={input.notes || ""} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={3} className="field-input resize-none" />
                </Field>
              </div>

              {/* Price history */}
              {selected && history.length > 0 && (
                <div>
                  <p className="text-[12.5px] font-medium text-muted mb-2">Price history</p>
                  <div className="border border-line rounded-lg divide-y divide-line-2 overflow-hidden">
                    {history.map((h) => (
                      <div key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="text-[12px] text-ink-2 truncate">{h.item_description}</div>
                          <div className="text-[11px] text-muted tabular-nums">
                            {new Date(h.recorded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            {h.quantity ? ` · Qty ${h.quantity}` : ""}
                          </div>
                        </div>
                        <div className="text-[12px] font-medium text-ink tabular-nums flex-shrink-0">{fmtAmount(h.price)}</div>
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
                className="flex-1 flex items-center justify-center gap-1.5 h-10 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                <Save size={14} /> {saving ? "Saving…" : "Save supplier"}
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

      {dealsModalOpen && selected && (
        <SupplierDealsModal
          supplier={selected}
          deals={supplierDeals}
          onClose={() => setDealsModalOpen(false)}
          onReload={reloadDeal}
        />
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
