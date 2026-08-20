import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowLeft, Package, Pencil, Plus, Save, Search, Trash2, Phone, Mail, MapPin, X, ChevronRight, ArrowUp, ArrowDown } from "lucide-react";
import { api, Supplier, SupplierInput, SupplierPriceEntry, CounterpartyPaymentRow } from "../lib/api";
import { fmtAmount, fmtPhone } from "../lib/format";
import SupplierDealsModal from "./SupplierDealsModal";
import PersonPayments from "./PersonPayments";
import { PersonRef } from "./PersonPicker";

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

const SPEND_RANGES = [
  { label: "Any spend",       min: -Infinity, max: Infinity },
  { label: "None",            min: 0,         max: 0 },
  { label: "$1 – $9.9k",      min: 1,         max: 9999 },
  { label: "$10k – $49.9k",   min: 10000,     max: 49999 },
  { label: "$50k – $199k",    min: 50000,     max: 199999 },
  { label: "$200k+",          min: 200000,    max: Infinity },
];

// Separate ladder from spend: a supplier's profit can be negative, and "None" is a
// meaningful state on its own (7 of 19 suppliers have never been on a completed deal).
const PROFIT_RANGES = [
  { label: "Any profit",      min: -Infinity, max: Infinity },
  { label: "At a loss",       min: -Infinity, max: -0.01 },
  { label: "None",            min: 0,         max: 0 },
  { label: "$1 – $4.9k",      min: 1,         max: 4999 },
  { label: "$5k – $19.9k",    min: 5000,      max: 19999 },
  { label: "$20k+",           min: 20000,     max: Infinity },
];

const ACTIVITY = [
  { label: "Any time",        days: 0 },
  { label: "Used in 30 days", days: 30 },
  { label: "Used in 90 days", days: 90 },
  { label: "Never used",      days: -1 },
];

type SortKey = "name" | "total_paid" | "total_profit" | "margin" | "deal_count" | "avg_deal_amount" | "last_deal_date";

const selectCls =
  "border border-line h-8 px-2.5 rounded-lg text-[12px] text-ink-2 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

/** Margin only exists once we've recorded revenue on their deals — 0 revenue is "—", not "0%". */
const marginOf = (s: Supplier) => (s.total_revenue > 0 ? (s.total_profit / s.total_revenue) * 100 : null);

/** `deal_flows.completed_at` is a bare `YYYY-MM-DD`, which `new Date()` reads as UTC
 *  midnight — rendered in Central that lands on the *previous* day, so every date on
 *  this screen was one early. Parse date-only strings as local; leave real timestamps
 *  (price history `recorded_at`) to the normal parser. */
const parseDay = (d: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
};

const shortDate = (d?: string | null) =>
  d ? parseDay(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

const daysSince = (d?: string | null) =>
  d ? (Date.now() - parseDay(d).getTime()) / 86400000 : Infinity;

export default function SuppliersView() {
  const [suppliers,     setSuppliers]     = useState<Supplier[]>([]);
  const [selected,      setSelected]      = useState<Supplier | null>(null);
  const [editing,       setEditing]       = useState(false);
  const [input,         setInput]         = useState<SupplierInput>(emptyInput);
  const [history,       setHistory]       = useState<SupplierPriceEntry[]>([]);
  const [payments,      setPayments]      = useState<CounterpartyPaymentRow[]>([]);
  // Both sides of the address book, for re-filing a payment under the party it
  // actually belongs to (R-175). Loaded once; failure only costs the picker.
  const [people,        setPeople]        = useState<PersonRef[]>([]);
  const [supplierDeals, setSupplierDeals] = useState<any[]>([]);
  const [dealsModalOpen,setDealsModalOpen]= useState(false);
  const [query,         setQuery]         = useState("");
  const [filter,        setFilter]        = useState<"all" | "active" | "archived">("active");
  const [spendRange,    setSpendRange]    = useState(0);
  const [profitRange,   setProfitRange]   = useState(0);
  const [activity,      setActivity]      = useState(0);
  const [sortKey,       setSortKey]       = useState<SortKey>("total_paid");
  const [sortAsc,       setSortAsc]       = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [open,          setOpen]          = useState(false);

  const load = async () => setSuppliers(await api.listSuppliers());
  useEffect(() => { load().catch(console.error); }, []);
  useEffect(() => {
    Promise.all([api.listClients(), api.listSuppliers()])
      .then(([cs, ss]) => setPeople([
        ...cs.map((c): PersonRef => ({ type: "client", id: c.id, name: c.name })),
        ...ss.filter((x) => !x.archived).map((x): PersonRef => ({ type: "supplier", id: x.id, name: x.name })),
      ]))
      .catch(() => {});
  }, []);

  const inputFrom = (s: Supplier): SupplierInput => ({
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

  // Opens the READ view. Editing is a deliberate second step — glancing at a
  // supplier's numbers used to mean sitting inside a form with a Save button.
  const openSupplier = (s: Supplier) => {
    setSelected(s);
    setInput(inputFrom(s));
    setEditing(false);
    setOpen(true);
    setDealsModalOpen(false);
    setSupplierDeals([]);
    setPayments([]);
    api.getSupplierPriceHistory(s.id).then(setHistory).catch(() => setHistory([]));
    api.getDealsForSupplier(s.id).then(setSupplierDeals).catch(() => setSupplierDeals([]));
    // Bank payments this supplier touches: tagged rows + supplier_payment legs.
    api.counterpartyPayments("supplier", s.id, s.name).then(setPayments).catch(() => setPayments([]));
  };

  // Remove a wrong supplier tag — the payment itself stays booked. Re-fetch so a
  // tag-only row disappears and a deal-linked row merely loses its badge.
  const reloadPayments = async () => {
    if (!selected) return;
    setPayments(await api.counterpartyPayments("supplier", selected.id, selected.name).catch(() => []));
  };

  const untagPayment = async (txnId: string) => {
    if (!selected) return;
    try {
      await api.untagBankTxnCounterparty(txnId);
      const rows = await api.counterpartyPayments("supplier", selected.id, selected.name);
      setPayments(rows);
    } catch {}
  };

  const createNew = () => {
    setSelected(null);
    setInput(emptyInput);
    setHistory([]);
    setSupplierDeals([]);
    setDealsModalOpen(false);
    setEditing(true);
    setOpen(true);
  };

  const closePanel = () => { setOpen(false); setSelected(null); setEditing(false); };

  const filtered = useMemo(() => {
    const rows = suppliers.filter((s) => {
      if (filter === "active"   && s.archived)  return false;
      if (filter === "archived" && !s.archived) return false;
      if (query) {
        const q = query.toLowerCase();
        // Phone matches on digits alone, so 8155932342 finds (815) 593-2342. It only
        // joins in from 3 digits up - one digit would match nearly every number.
        const qDigits = q.replace(/\D/g, "");
        const text = `${s.name} ${s.contact_name || ""} ${s.email || ""}`.toLowerCase();
        const phoneHit = qDigits.length >= 3 && (s.phone || "").replace(/\D/g, "").includes(qDigits);
        if (!text.includes(q) && !phoneHit) return false;
      }
      const sr = SPEND_RANGES[spendRange];
      if (s.total_paid < sr.min || s.total_paid > sr.max) return false;
      const pr = PROFIT_RANGES[profitRange];
      if (s.total_profit < pr.min || s.total_profit > pr.max) return false;
      const act = ACTIVITY[activity];
      if (act.days === -1 && s.last_deal_date) return false;
      if (act.days > 0 && daysSince(s.last_deal_date) > act.days) return false;
      return true;
    });
    const val = (s: Supplier): number | string => {
      switch (sortKey) {
        case "name":           return s.name.toLowerCase();
        case "margin":         return marginOf(s) ?? -Infinity;
        case "last_deal_date": return s.last_deal_date ? parseDay(s.last_deal_date).getTime() : -Infinity;
        default:               return s[sortKey] as number;
      }
    };
    return rows.sort((a, b) => {
      const x = val(a), y = val(b);
      const cmp = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [suppliers, filter, query, spendRange, profitRange, activity, sortKey, sortAsc]);

  const totals = useMemo(() => {
    const live = suppliers.filter((s) => !s.archived);
    const spent  = live.reduce((n, s) => n + s.total_paid, 0);
    const profit = live.reduce((n, s) => n + s.total_profit, 0);
    const rev    = live.reduce((n, s) => n + s.total_revenue, 0);
    return { spent, profit, rev, count: live.length, used: live.filter((s) => s.deal_count > 0).length };
  }, [suppliers]);

  const anyFilter = filter !== "active" || !!query || spendRange > 0 || profitRange > 0 || activity > 0;
  const clearFilters = () => {
    setFilter("active"); setQuery(""); setSpendRange(0); setProfitRange(0); setActivity(0);
  };

  const sortBy = (k: SortKey) => {
    if (k === sortKey) { setSortAsc(!sortAsc); return; }
    setSortKey(k);
    setSortAsc(k === "name");   // names read A→Z; every money column reads biggest-first
  };

  const save = async () => {
    if (!input.name.trim()) return;
    setSaving(true);
    try {
      if (selected) await api.updateSupplier(selected.id, input);
      else          await api.createSupplier(input);
      const rows = await api.listSuppliers();
      setSuppliers(rows);
      if (selected) {
        const fresh = rows.find((r) => r.id === selected.id);
        if (fresh) { setSelected(fresh); setInput(inputFrom(fresh)); }
        setEditing(false);          // back to the profile, not out of the panel
      } else {
        closePanel();
      }
    } finally {
      setSaving(false);
    }
  };

  // Reopen/Delete/payout-toggle inside a breakdown → refresh supplier totals + its deals.
  const reloadDeal = async () => {
    const rows = await api.listSuppliers();
    setSuppliers(rows);
    const fresh = selected ? rows.find((r) => r.id === selected.id) : null;
    if (!fresh) return;
    setSelected(fresh);
    setSupplierDeals(await api.getDealsForSupplier(fresh.id).catch(() => []));
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">Suppliers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Ranked by what you spend with them and what it earned.
          </p>
        </div>
        <button
          onClick={createNew}
          className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium transition-colors"
        >
          <Plus size={14} /> New supplier
        </button>
      </div>

      {/* Summary — active suppliers only, so archiving actually changes the picture */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Spent with suppliers", value: fmtAmount(totals.spent) },
          { label: "Profit on their stock", value: fmtAmount(totals.profit) },
          { label: "Blended margin", value: totals.rev > 0 ? `${((totals.profit / totals.rev) * 100).toFixed(1)}%` : "—" },
          { label: "Suppliers used", value: `${totals.used} of ${totals.count}` },
        ].map((c) => (
          <div key={c.label} className="bg-surface border border-line rounded-xl px-4 py-3 min-w-0">
            <div className="text-[11.5px] text-muted truncate">{c.label}</div>
            <div className="text-[19px] font-bold text-ink tabular-nums leading-tight mt-1 truncate">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Search + filters, in the order the columns appear */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search suppliers, contacts, email or phone…"
            className="w-full pl-8 pr-3 h-8 text-[13px] border border-line rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>

        <select value={spendRange} onChange={(e) => setSpendRange(Number(e.target.value))} className={selectCls}>
          {SPEND_RANGES.map((r, i) => <option key={i} value={i}>{i === 0 ? r.label : `Spent ${r.label}`}</option>)}
        </select>

        <select value={profitRange} onChange={(e) => setProfitRange(Number(e.target.value))} className={selectCls}>
          {PROFIT_RANGES.map((r, i) => <option key={i} value={i}>{i === 0 ? r.label : `Profit ${r.label}`}</option>)}
        </select>

        <select value={activity} onChange={(e) => setActivity(Number(e.target.value))} className={selectCls}>
          {ACTIVITY.map((a, i) => <option key={i} value={i}>{a.label}</option>)}
        </select>

        <select value={filter} onChange={(e) => setFilter(e.target.value as any)} className={selectCls}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>

        {anyFilter && (
          <button onClick={clearFilters} className="text-[12px] text-muted hover:text-ink-2 px-2 h-8 rounded-lg hover:bg-surface-3 transition-colors">
            Clear
          </button>
        )}
      </div>

      <div className="text-[12px] text-muted">
        Showing {filtered.length} of {suppliers.length} suppliers
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 bg-surface border border-line rounded-xl">
          <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
            <Package size={18} className="text-faint" />
          </div>
          <p className="text-[14px] font-semibold text-ink-2">
            {suppliers.length === 0 ? "No suppliers yet" : "No suppliers match these filters"}
          </p>
          {suppliers.length === 0 && (
            <>
              <p className="text-[12px] text-muted mt-1">Add your first supplier to get started</p>
              <button onClick={createNew} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
                + Add supplier
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full min-w-[1040px] text-sm">
            <thead>
              <tr className="border-b border-line-2">
                <Th label="Supplier"  k="name"             sortKey={sortKey} asc={sortAsc} onSort={sortBy} align="left" />
                <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Contact</th>
                <Th label="Spent"     k="total_paid"       sortKey={sortKey} asc={sortAsc} onSort={sortBy} />
                <Th label="Profit"    k="total_profit"     sortKey={sortKey} asc={sortAsc} onSort={sortBy} />
                <Th label="Margin"    k="margin"           sortKey={sortKey} asc={sortAsc} onSort={sortBy} />
                <Th label="Deals"     k="deal_count"       sortKey={sortKey} asc={sortAsc} onSort={sortBy} align="center" />
                <Th label="Avg deal"  k="avg_deal_amount"  sortKey={sortKey} asc={sortAsc} onSort={sortBy} />
                <Th label="Last deal" k="last_deal_date"   sortKey={sortKey} asc={sortAsc} onSort={sortBy} align="left" />
                <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Payment</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const m = marginOf(s);
                return (
                  <tr
                    key={s.id}
                    onClick={() => openSupplier(s)}
                    className="border-b border-line-2 last:border-0 hover:bg-surface-2/60 transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-3">
                      <div className="text-[13px] font-medium text-ink truncate max-w-[220px]">{s.name}</div>
                      {s.archived && <div className="text-[10px] text-warning-ink font-medium mt-0.5">Archived</div>}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-muted truncate max-w-[160px]">{s.contact_name || "—"}</td>
                    <td className="px-5 py-3 text-right text-[13px] font-semibold text-ink tabular-nums">
                      {s.total_paid > 0 ? fmtAmount(s.total_paid) : "—"}
                    </td>
                    <td className={`px-5 py-3 text-right text-[13px] font-semibold tabular-nums ${
                      s.total_profit < 0 ? "text-danger-ink" : "text-ink"
                    }`}>
                      {s.total_profit !== 0
                        ? <>{s.total_profit < 0 ? "−" : ""}{fmtAmount(Math.abs(s.total_profit))}</>
                        : "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {m === null ? (
                        <span className="text-[12px] text-faint">—</span>
                      ) : (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums ${
                          m >= 25 ? "bg-success-bg text-success-ink"
                          : m >= 10 ? "bg-warning-bg text-warning-ink"
                          : "bg-danger-bg text-danger-ink"
                        }`}>
                          {m.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-center text-[13px] text-ink-2 tabular-nums">{s.deal_count || "—"}</td>
                    <td className="px-5 py-3 text-right text-[13px] text-ink-2 tabular-nums">
                      {s.avg_deal_amount > 0 ? fmtAmount(s.avg_deal_amount) : "—"}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-muted">{shortDate(s.last_deal_date)}</td>
                    <td className="px-5 py-3 text-[12px] text-muted truncate max-w-[140px]">{s.payment_method || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Slide-in panel — profile by default, form only when editing */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20" onClick={closePanel} />
          <div className="relative bg-surface w-full max-w-[min(92vw,34rem)] shadow-2xl flex flex-col overflow-y-auto">

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-line sticky top-0 bg-surface z-10">
              <div className="flex items-center gap-2 min-w-0">
                {editing && selected && (
                  <button
                    onClick={() => { setInput(inputFrom(selected)); setEditing(false); }}
                    className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors flex-shrink-0"
                    title="Back to profile"
                  >
                    <ArrowLeft size={16} />
                  </button>
                )}
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-ink truncate">
                    {selected ? (editing ? `Editing ${selected.name}` : selected.name) : "New supplier"}
                  </h3>
                  {selected?.contact_name && !editing && (
                    <p className="text-[12px] text-muted mt-0.5 truncate">{selected.contact_name}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {selected && !editing && (
                  <button
                    onClick={() => setEditing(true)}
                    className="flex items-center gap-1.5 h-8 px-3 border border-line rounded-lg text-[12px] text-ink-2 hover:border-line-3 transition-colors"
                  >
                    <Pencil size={13} /> Edit
                  </button>
                )}
                <button onClick={closePanel} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="flex-1 px-6 py-5 space-y-5">
              {selected && !editing ? (
                <Profile
                  s={selected}
                  history={history}
                  payments={payments}
                  dealCount={supplierDeals.length}
                  onOpenDeals={() => setDealsModalOpen(true)}
                  onUntagPayment={untagPayment}
                  people={people}
                  onPaymentsChanged={reloadPayments}
                />
              ) : (
                <Form input={input} setInput={setInput} />
              )}
            </div>

            {(editing || !selected) && (
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
                      onClick={async () => { await api.archiveSupplier(selected.id); await load(); closePanel(); }}
                      className="flex items-center gap-1.5 h-10 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                    >
                      <Archive size={13} /> Archive
                    </button>
                    <button
                      onClick={async () => {
                        if (confirm("Permanently delete this supplier?")) {
                          await api.deleteSupplier(selected.id);
                          await load();
                          closePanel();
                        }
                      }}
                      className="flex items-center gap-1.5 h-10 px-3 border border-danger text-danger-ink hover:bg-danger-bg rounded-lg text-[12px] transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            )}
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

function Th({ label, k, sortKey, asc, onSort, align = "right" }: {
  label: string; k: SortKey; sortKey: SortKey; asc: boolean;
  onSort: (k: SortKey) => void; align?: "left" | "right" | "center";
}) {
  const active = sortKey === k;
  const just = align === "left" ? "justify-start" : align === "center" ? "justify-center" : "justify-end";
  return (
    <th className={`px-5 py-3 text-[12px] font-medium ${align === "left" ? "text-left" : align === "center" ? "text-center" : "text-right"}`}>
      <button
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 w-full ${just} transition-colors ${active ? "text-ink-2" : "text-muted hover:text-ink-2"}`}
      >
        {label}
        {active && (asc ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );
}

function Profile({ s, history, payments, dealCount, onOpenDeals, onUntagPayment, people, onPaymentsChanged }: {
  s: Supplier; history: SupplierPriceEntry[]; payments: CounterpartyPaymentRow[]; dealCount: number; onOpenDeals: () => void; onUntagPayment: (txnId: string) => void;
  people: PersonRef[]; onPaymentsChanged: () => void;
}) {
  const m = marginOf(s);
  return (
    <>
      {/* Money first */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Spent with them", value: s.total_paid > 0 ? fmtAmount(s.total_paid) : "—" },
          { label: "Profit on their stock", value: s.total_profit !== 0
              ? `${s.total_profit < 0 ? "−" : ""}${fmtAmount(Math.abs(s.total_profit))}` : "—",
            danger: s.total_profit < 0 },
          { label: "Margin",   value: m === null ? "—" : `${m.toFixed(1)}%` },
          { label: "Deals",    value: String(s.deal_count) },
          { label: "Avg deal", value: s.avg_deal_amount > 0 ? fmtAmount(s.avg_deal_amount) : "—" },
          { label: "Last deal",value: shortDate(s.last_deal_date) },
        ].map((st) => (
          <div key={st.label} className="bg-surface-2 border border-line rounded-lg px-3 py-2 min-w-0">
            <div className="text-[11.5px] text-muted truncate">{st.label}</div>
            <div className={`text-[14px] font-bold mt-0.5 tabular-nums truncate ${st.danger ? "text-danger-ink" : "text-ink"}`}>
              {st.value}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onOpenDeals}
        className="w-full flex items-center justify-between gap-2 px-3 h-10 bg-surface-2 border border-line rounded-lg text-[12.5px] font-medium text-ink-2 hover:border-line-3 transition-colors"
      >
        <span>View completed deals ({dealCount})</span>
        <ChevronRight size={14} className="text-muted flex-shrink-0" />
      </button>

      {/* Bank payments this supplier touches — tagged rows plus supplier legs on
          deals. THREE groups, never merged (R-156 W1-d, R-157/F2): booked to a deal
          that names them, which that deal already counts; booked to a deal that
          does not, which counts on that deal and not here at all; and tagged to
          them only, which no deal counts. The middle group is why the split is
          three and not two — one $279,500 supplier wire in this ledger is split
          across deals belonging to four different clients. */}
      <PersonPayments
        person={{ type: "supplier", id: s.id, name: s.name }}
        payments={payments}
        onUntag={onUntagPayment}
        people={people}
        onChanged={onPaymentsChanged}
      />

      {/* Contact */}
      {(s.phone || s.email || s.address) && (
        <div className="space-y-2">
          <p className="text-[12.5px] font-medium text-muted">Contact</p>
          <div className="border border-line rounded-lg divide-y divide-line-2 overflow-hidden">
            {s.phone && <Row icon={<Phone size={12} />} value={fmtPhone(s.phone)} href={`tel:${s.phone}`} />}
            {s.email && <Row icon={<Mail size={12} />} value={s.email} href={`mailto:${s.email}`} />}
            {s.address && <Row icon={<MapPin size={12} />} value={s.address} />}
          </div>
        </div>
      )}

      {/* Terms */}
      {(s.payment_method || s.payment_terms || s.typical_lead_time || s.payment_details) && (
        <div className="space-y-2">
          <p className="text-[12.5px] font-medium text-muted">Payment and logistics</p>
          <div className="border border-line rounded-lg divide-y divide-line-2 overflow-hidden">
            {s.payment_method    && <Row label="Method"    value={s.payment_method} />}
            {s.payment_terms     && <Row label="Terms"     value={s.payment_terms} />}
            {s.typical_lead_time && <Row label="Lead time" value={s.typical_lead_time} />}
            {s.payment_details   && <Row label="Details"   value={s.payment_details} />}
          </div>
        </div>
      )}

      {s.notes && (
        <div className="space-y-2">
          <p className="text-[12.5px] font-medium text-muted">Notes</p>
          <p className="text-[12.5px] text-ink-2 whitespace-pre-wrap bg-surface-2 border border-line rounded-lg px-3 py-2.5">{s.notes}</p>
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12.5px] font-medium text-muted">Price history</p>
          <div className="border border-line rounded-lg divide-y divide-line-2 overflow-hidden">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12px] text-ink-2 truncate">{h.item_description}</div>
                  <div className="text-[11px] text-muted tabular-nums">
                    {shortDate(h.recorded_at)}{h.quantity ? ` · Qty ${h.quantity}` : ""}
                  </div>
                </div>
                <div className="text-[12px] font-medium text-ink tabular-nums flex-shrink-0">{fmtAmount(h.price)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Row({ icon, label, value, href }: { icon?: React.ReactNode; label?: string; value: string; href?: string }) {
  const body = (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-[11.5px] text-muted flex-shrink-0">
        {icon}{label}
      </span>
      <span className={`text-[12.5px] text-right whitespace-pre-wrap break-words min-w-0 ${href ? "text-accent" : "text-ink-2"}`}>
        {value}
      </span>
    </div>
  );
  return href ? <a href={href} className="block hover:bg-surface-2 transition-colors">{body}</a> : body;
}

function Form({ input, setInput }: { input: SupplierInput; setInput: (i: SupplierInput) => void }) {
  return (
    <>
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

      <div className="space-y-3">
        <p className="text-[12.5px] font-medium text-muted">Logistics</p>
        <Field label="Typical lead time">
          <input value={input.typical_lead_time || ""} onChange={(e) => setInput({ ...input, typical_lead_time: e.target.value })} className="field-input" placeholder="e.g. 3-5 business days" />
        </Field>
        <Field label="Notes">
          <textarea value={input.notes || ""} onChange={(e) => setInput({ ...input, notes: e.target.value })} rows={3} className="field-input resize-none" />
        </Field>
      </div>
    </>
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
