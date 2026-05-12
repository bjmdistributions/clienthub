import { useEffect, useState, useRef, useCallback } from "react";
import { api, Client, ClientInput, ClientFilter, MissingInfoReport, Category } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, Trash2, Edit2, Search, ShoppingCart, Clock, Users, SlidersHorizontal, X, ChevronDown, AlertCircle, CheckCircle2, Mail, Phone, MapPin, Tag, MessageSquare } from "lucide-react";
import ClientDetailView from "./ClientDetailView";

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
  if (s === "hot_lead")        return "bg-red-50 text-red-700 border border-red-200";
  if (s === "warm")            return "bg-orange-50 text-orange-700 border border-orange-200";
  if (s === "active_customer") return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (s === "inactive")        return "bg-gray-100 text-gray-500 border border-gray-200";
  return "bg-indigo-50 text-indigo-700 border border-indigo-200";
};

export default function ClientsView() {
  const [clients, setClients] = useState<Client[]>([]);
  const [totalClients, setTotalClients] = useState(0);
  const [editing, setEditing] = useState<Client | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filter, setFilter] = useState<ClientFilter>({});
  const [searchText, setSearchText] = useState("");
  const [missingInfo, setMissingInfo] = useState<MissingInfoReport | null>(null);
  const [showHealth, setShowHealth] = useState(false);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [summaryStats, setSummaryStats] = useState({ total: 0, active: 0, hotLeads: 0, revenue: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const loadMissingInfo = () => {
    api.clientsMissingInfo().then(setMissingInfo).catch(console.error);
  };

  const applyFilter = useCallback(async (f: ClientFilter) => {
    const hasFilter = f.search || f.lead_status || f.category || f.tag || f.state || f.stale_days || f.missing || f.needs_review;
    if (hasFilter) {
      setClients(await api.listClientsFiltered(f));
    } else {
      setClients(await api.listClients());
    }
  }, []);

  useEffect(() => {
    api.listClients().then((all) => {
      setClients(all);
      setSummaryStats({
        total:    all.length,
        active:   all.filter((c) => c.lead_status === "active_customer").length,
        hotLeads: all.filter((c) => c.lead_status === "hot_lead").length,
        revenue:  all.reduce((s, c) => s + (c.total_revenue || 0), 0),
      });
    });
    api.listCategories().then(setAllCategories);
    loadMissingInfo();
  }, []);

  useEffect(() => {
    api.listClients().then((c) => setTotalClients(c.length));
  }, [clients]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      applyFilter({ ...filter, search: searchText.trim() || undefined });
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchText]);

  const updateFilter = (patch: Partial<ClientFilter>) => {
    const next = { ...filter, ...patch };
    Object.keys(patch).forEach((k) => {
      if (!patch[k as keyof ClientFilter]) delete (next as any)[k];
    });
    setFilter(next);
    applyFilter(next);
  };

  const clearAll = () => {
    setFilter({});
    setSearchText("");
    applyFilter({});
  };

  const hasAnyFilter = filter.search || filter.lead_status || filter.category || filter.tag || filter.state || filter.stale_days || filter.missing || filter.needs_review;

  const categoryLabels = allCategories.map((c) => c.label);

  const chips: { label: string; key: keyof ClientFilter }[] = [];
  if (filter.lead_status) chips.push({ label: `Status: ${statusLabel(filter.lead_status)}`, key: "lead_status" });
  if (filter.category) chips.push({ label: `Category: ${filter.category === "__none__" ? "None" : filter.category}`, key: "category" });
  if (filter.tag) chips.push({ label: `Tag: ${filter.tag}`, key: "tag" });
  if (filter.state) chips.push({ label: `State: ${filter.state}`, key: "state" });
  if (filter.stale_days) chips.push({ label: `Last contact: ${filter.stale_days}+ days`, key: "stale_days" });
  if (filter.missing) chips.push({ label: `Missing: ${filter.missing}`, key: "missing" });
  if (filter.needs_review) chips.push({ label: "Needs review", key: "needs_review" });

  const handleSave = async (input: ClientInput) => {
    if (editing) await api.updateClient(editing.id, input);
    else await api.createClient(input);
    setShowForm(false);
    setEditing(null);
    applyFilter(filter);
    loadMissingInfo();
  };

  const handleDelete = async (id: string) => {
    const client = clients.find((c) => c.id === id);
    const name = client?.name || "this client";
    if (confirm(`Delete ${name}? This will also delete all their interactions. This cannot be undone.`)) {
      await api.deleteClient(id);
      applyFilter(filter);
      loadMissingInfo();
    }
  };

  if (detailId) {
    return (
      <ClientDetailView
        clientId={detailId}
        onBack={() => {
          setDetailId(null);
          applyFilter(filter);
        }}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-[18px] font-semibold text-gray-900">Clients</h2>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors"
        >
          <Plus size={16} /> New Client
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Total Clients",   value: summaryStats.total,                      color: "text-gray-900" },
          { label: "Active Customers",value: summaryStats.active,                     color: "text-emerald-600" },
          { label: "Hot Leads",       value: summaryStats.hotLeads,                   color: "text-red-600" },
          { label: "Total Revenue",   value: fmtAmount(summaryStats.revenue), color: "text-indigo-600" },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3.5">
            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">{s.label}</p>
            <p className={`text-[22px] font-bold tabular-nums mt-0.5 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Data Health Panel */}
      {missingInfo && missingInfo.total_incomplete > 0 && (
        <div className="mb-4 border border-amber-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setShowHealth(!showHealth)}
            className="w-full flex items-center justify-between px-4 py-3 bg-amber-50 hover:bg-amber-100 transition-colors text-left"
          >
            <span className="flex items-center gap-2 text-[14px] font-medium text-amber-800">
              <AlertCircle size={16} className="text-amber-500" />
              {missingInfo.total_incomplete} client{missingInfo.total_incomplete !== 1 ? "s" : ""} have incomplete data
            </span>
            <ChevronDown size={16} className={`text-amber-500 transition-transform ${showHealth ? "rotate-180" : ""}`} />
          </button>
          {showHealth && (
            <div className="px-4 py-3 space-y-2 bg-white">
              {[
                { label: "Missing email", count: missingInfo.missing_email.length, icon: Mail, missing: "email" },
                { label: "Missing phone", count: missingInfo.missing_phone.length, icon: Phone, missing: "phone" },
                { label: "Missing address", count: missingInfo.missing_address.length, icon: MapPin, missing: "address" },
                { label: "Missing category", count: missingInfo.missing_category.length, icon: Tag, missing: "category" },
                { label: "Never contacted", count: missingInfo.never_contacted.length, icon: MessageSquare, missing: undefined },
                { label: "Needs review", count: missingInfo.needs_review.length, icon: AlertCircle, needs_review: true },
              ].map((row: any) => (
                <div key={row.label} className="flex items-center justify-between py-1.5">
                  <span className="flex items-center gap-2 text-[13px] text-gray-700">
                    <row.icon size={14} className="text-gray-400" />
                    {row.label}
                    <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full text-[11px] font-medium">{row.count}</span>
                  </span>
                  <button
                    onClick={() => {
                      const patch: Partial<ClientFilter> = {};
                      if (row.missing) patch.missing = row.missing;
                      if (row.label === "Never contacted") patch.stale_days = 9999;
                      if (row.needs_review) patch.needs_review = true;
                      updateFilter(patch);
                    }}
                    className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 px-2 py-1 rounded hover:bg-indigo-50 transition-colors"
                  >
                    View
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {missingInfo && missingInfo.total_incomplete === 0 && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
          <CheckCircle2 size={14} /> All client data complete
        </div>
      )}

      {/* Search + Quick Filters */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            placeholder="Search by name, company, or email..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="border border-gray-300 w-full pl-9 pr-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
        <select
          value={filter.category ?? ""}
          onChange={(e) => updateFilter({ category: e.target.value || undefined })}
          className="border border-gray-300 h-10 px-3 rounded-md text-[14px] text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white min-w-[140px]"
        >
          <option value="">All Categories</option>
          <option value="__none__">No category</option>
          {categoryLabels.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filter.lead_status ?? ""}
          onChange={(e) => updateFilter({ lead_status: e.target.value || undefined })}
          className="border border-gray-300 h-10 px-3 rounded-md text-[14px] text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white min-w-[130px]"
        >
          <option value="">All Statuses</option>
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`flex items-center gap-1.5 h-10 px-3 rounded-md text-[14px] font-medium border transition-colors ${
            showAdvanced ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
          }`}
        >
          <SlidersHorizontal size={14} /> Filters
        </button>
      </div>

      {/* Advanced Filters */}
      {showAdvanced && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">State</label>
            <input
              placeholder="e.g. NY"
              value={filter.state ?? ""}
              onChange={(e) => updateFilter({ state: e.target.value || undefined })}
              className="border border-gray-300 h-9 px-3 rounded-md text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Tag</label>
            <input
              placeholder="e.g. vip"
              value={filter.tag ?? ""}
              onChange={(e) => updateFilter({ tag: e.target.value || undefined })}
              className="border border-gray-300 h-9 px-3 rounded-md text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Last Contact</label>
            <select
              value={filter.stale_days ?? ""}
              onChange={(e) => updateFilter({ stale_days: e.target.value ? Number(e.target.value) : undefined })}
              className="border border-gray-300 h-9 px-3 rounded-md text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value="">Any time</option>
              <option value="30">30+ days</option>
              <option value="60">60+ days</option>
              <option value="90">90+ days</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Missing Info</label>
            <select
              value={filter.missing ?? ""}
              onChange={(e) => updateFilter({ missing: e.target.value || undefined })}
              className="border border-gray-300 h-9 px-3 rounded-md text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value="">Any</option>
              <option value="email">Missing email</option>
              <option value="phone">Missing phone</option>
              <option value="address">Missing address</option>
              <option value="category">Missing category</option>
            </select>
          </div>
          <div className="col-span-2 lg:col-span-4 flex justify-end">
            <button onClick={clearAll} className="text-[13px] text-gray-500 hover:text-gray-700 underline">
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {chips.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 pl-2.5 pr-1.5 py-1 rounded-full text-[12px] font-medium"
            >
              {chip.label}
              <button onClick={() => updateFilter({ [chip.key]: undefined })} className="hover:bg-indigo-100 rounded-full p-0.5">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Result count */}
      {hasAnyFilter && (
        <div className="text-[13px] text-gray-500 mb-3">
          Showing {clients.length} of {totalClients} clients
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <ClientForm
          initial={editing}
          categories={allCategories}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditing(null); }}
        />
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Name</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Company</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Email</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Phone</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Category</th>
              <th className="text-center px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Invoices</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Last Contact</th>
              <th className="text-right px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Revenue</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr
                key={c.id}
                onClick={() => setDetailId(c.id)}
                className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 text-[14px] font-medium text-gray-900">
                  <span className="flex items-center gap-1.5">
                    {c.name}
                    {c.needs_review && <AlertCircle size={14} className="text-amber-500 flex-shrink-0" />}
                    {!c.email && <Mail size={11} className="text-gray-300 flex-shrink-0" />}
                    {!c.phone && <Phone size={11} className="text-gray-300 flex-shrink-0" />}
                    {!c.street_address && <MapPin size={11} className="text-gray-300 flex-shrink-0" />}
                    {!c.category && <Tag size={11} className="text-gray-300 flex-shrink-0" />}
                  </span>
                </td>
                <td className="px-4 py-3 text-[14px] text-gray-600">{c.company || "—"}</td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <select
                    className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full cursor-pointer appearance-none ${statusColor(c.lead_status)}`}
                    value={c.lead_status}
                    onChange={async (e) => {
                      await api.updateClientStatus(c.id, e.target.value);
                      applyFilter(filter);
                    }}
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>{statusLabel(s)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3 text-[13px] text-gray-600">{c.email || "—"}</td>
                <td className="px-4 py-3 text-[13px] text-gray-600">{c.phone || "—"}</td>
                <td className="px-4 py-3 text-[13px] text-gray-600">
                  {c.category || "—"}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="inline-flex items-center gap-1 text-[13px] font-medium text-gray-700">
                    <ShoppingCart size={12} className="text-gray-400" />
                    {c.invoice_count}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-[13px] text-gray-500">
                    <Clock size={12} className="text-gray-400" />
                    {relTime(c.last_contact_at)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-[14px] font-semibold text-gray-900 tabular-nums">
                  {fmtAmount(c.total_revenue || 0)}
                </td>
                <td className="px-4 py-3 text-right space-x-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => { setEditing(c); setShowForm(true); }}
                    title="Edit"
                    className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    title="Delete"
                    className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-16 text-center">
                  {hasAnyFilter ? (
                    <div className="text-[14px] text-gray-400">No clients match the current filters</div>
                  ) : (
                    <div>
                      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                        <Users size={18} className="text-gray-400" />
                      </div>
                      <p className="text-[16px] font-semibold text-gray-800 mb-1">No clients yet</p>
                      <p className="text-[14px] text-gray-400 mb-4">Add your first client to get started</p>
                      <button
                        onClick={() => { setEditing(null); setShowForm(true); }}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium inline-flex items-center gap-2 transition-colors"
                      >
                        <Plus size={14} /> Add Client
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
  categories,
  onSave,
  onCancel,
}: {
  initial: Client | null;
  categories: Category[];
  onSave: (input: ClientInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ClientInput>({
    name: initial?.name ?? "",
    email: initial?.email ?? "",
    phone: initial?.phone ?? "",
    company: initial?.company ?? "",
    notes: initial?.notes ?? "",
    lead_status: initial?.lead_status ?? "prospect",
    category: initial?.category ?? "",
    tags: initial?.tags ?? "",
    street_address: initial?.street_address ?? "",
    city: initial?.city ?? "",
    state: initial?.state ?? "",
    zip_code: initial?.zip_code ?? "",
    next_follow_up_date: initial?.next_follow_up_date ?? "",
    needs_review: initial?.needs_review ?? false,
  });

  const set = (k: keyof ClientInput, v: string | boolean | null) => setForm({ ...form, [k]: v });

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4 space-y-6">
      <h3 className="text-[15px] font-semibold text-gray-900">
        {initial ? "Edit Client" : "New Client"}
      </h3>

      {/* Section 1 — Basic Info */}
      <div>
        <div className="text-[12px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Basic Info</div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name *">
            <input className={inp} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Company">
            <input className={inp} value={form.company ?? ""} onChange={(e) => set("company", e.target.value)} />
          </Field>
          <Field label="Email">
            <input className={inp} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone">
            <input className={inp} type="tel" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
          </Field>
        </div>
      </div>

      {/* Section 2 — Classification */}
      <div>
        <div className="text-[12px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Classification</div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Category">
            <input className={inp} list="categories" value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} />
          </Field>
          <Field label="Lead Status">
            <select className={inp} value={form.lead_status ?? "prospect"} onChange={(e) => set("lead_status", e.target.value)}>
              <option value="prospect">Prospect</option>
              <option value="hot lead">Hot Lead</option>
              <option value="warm">Warm</option>
              <option value="active customer">Active Customer</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
          <Field label="Tags">
            <input className={inp} placeholder="e.g. vip, new-york, apparel" value={form.tags ?? ""} onChange={(e) => set("tags", e.target.value)} />
          </Field>
        </div>
        <datalist id="categories">
          {categories.map((c) => <option key={c.id} value={c.label} />)}
        </datalist>
      </div>

      {/* Section 3 — Address */}
      <div>
        <div className="text-[12px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Address</div>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Field label="Street Address">
              <input className={inp} value={form.street_address ?? ""} onChange={(e) => set("street_address", e.target.value)} />
            </Field>
          </div>
          <Field label="City">
            <input className={inp} value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="State">
              <input className={inp} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} />
            </Field>
            <Field label="ZIP Code">
              <input className={inp} value={form.zip_code ?? ""} onChange={(e) => set("zip_code", e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            id="needs-review"
            checked={form.needs_review ?? false}
            onChange={(e) => set("needs_review", e.target.checked)}
            className="rounded border-gray-300 text-amber-500 focus:ring-amber-500"
          />
          <label htmlFor="needs-review" className="text-[13px] text-gray-700">Needs more information / review</label>
        </div>
      </div>
      </div>

      {/* Section 4 — Notes & Follow-up */}
      <div>
        <div className="text-[12px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Notes & Follow-up</div>
        <Field label="Internal Notes">
          <textarea
            rows={3}
            className={inp + " py-2"}
            placeholder="Private notes about this client — not visible to client"
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
        <div className="mt-3">
          <Field label="Next Follow-up Date">
            <input className={inp} type="date" value={form.next_follow_up_date ?? ""} onChange={(e) => set("next_follow_up_date", e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onCancel}
          className="px-4 h-9 text-[14px] text-gray-600 hover:text-gray-900 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={!form.name.trim()}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium disabled:opacity-40 transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}

const inp = "border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <label className="block text-[12px] font-medium text-gray-600 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
