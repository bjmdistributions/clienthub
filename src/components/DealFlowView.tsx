import { useEffect, useState, useCallback } from "react";
import {
  Check, ChevronDown, ChevronRight, Search, Plus, X,
  AlertTriangle, RotateCcw, RefreshCw, Trash2,
  DollarSign, CheckCircle2, Truck, FileDown,
} from "lucide-react";
import {
  api, DealFlow, SupplierPayment, Invoice, Supplier, ProfitSplit,
} from "../lib/api";
import { fmtAmount } from "../lib/format";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

// ─── helpers ──────────────────────────────────────────────────────────────
function parseAmt(v: string): number { return parseFloat(v.replace(/,/g, "")) || 0; }

const STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"] as const;
type Stage = typeof STAGES[number];
function si(s: string): number { return STAGES.indexOf(s as Stage); }

const NODE_LABELS: Record<Stage, string> = {
  invoiced:         "Invoiced",
  payment_received: "Payment In",
  supplier_paid:    "Supplier Paid",
  complete:         "Complete",
};

// Auto-open the panel for the NEXT step needed
function defaultPanel(stage: Stage): Stage {
  const idx = si(stage);
  return STAGES[Math.min(idx + 1, STAGES.length - 1)];
}

const inp =
  "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full bg-white " +
  "focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

// ─── Main view ────────────────────────────────────────────────────────────
export default function DealFlowView() {
  const [flows,        setFlows]        = useState<DealFlow[]>([]);
  const [invoices,     setInvoices]     = useState<Invoice[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [expandedDone, setExpandedDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let [f, inv] = await Promise.all([api.listDealFlows(), api.listInvoices()]);

      // Deduplicate: keep only one flow per invoice_id (the most-progressed one).
      // This handles stale duplicate records that may exist in the DB.
      const deduped = Object.values(
        f.reduce<Record<string, DealFlow>>((acc, fl) => {
          const prev = acc[fl.invoice_id];
          if (!prev || si(fl.stage) > si(prev.stage)) acc[fl.invoice_id] = fl;
          return acc;
        }, {})
      );

      // Auto-create deal flows for ALL invoices that aren't already complete —
      // includes drafts so invoices and deal flow stay fully in sync.
      const coveredIds = new Set(deduped.map((fl) => fl.invoice_id));
      const missing = inv.filter((i) => !i.is_complete && !coveredIds.has(i.id));
      if (missing.length > 0) {
        await Promise.all(missing.map((i) => api.createDealFlow(i.id, null, i.number)));
        const fresh = await api.listDealFlows();
        // Re-deduplicate after creation
        const freshDeduped = Object.values(
          fresh.reduce<Record<string, DealFlow>>((acc, fl) => {
            const prev = acc[fl.invoice_id];
            if (!prev || si(fl.stage) > si(prev.stage)) acc[fl.invoice_id] = fl;
            return acc;
          }, {})
        );
        setFlows(freshDeduped);
      } else {
        setFlows(deduped);
      }
      setInvoices(inv);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Cross-tab navigation restore
  useEffect(() => {
    const stored = localStorage.getItem("dealflow_invoice_filter");
    if (stored) { setSearch(stored); localStorage.removeItem("dealflow_invoice_filter"); }
  }, []);

  const q        = search.toLowerCase();
  const matchFl  = (f: DealFlow) =>
    !q ||
    (f.invoice_number || "").toLowerCase().includes(q) ||
    (f.client_name    || "").toLowerCase().includes(q) ||
    (f.name           || "").toLowerCase().includes(q);

  // An active deal flow must have a corresponding invoice that is still live
  // (not is_complete, not draft). This prevents stale flows from counting.
  // Active = any invoice not yet marked complete (drafts included — all invoices track through deal flow)
  const isInvoiceActive = (flow: DealFlow) => {
    const inv = invoices.find((i) => i.id === flow.invoice_id);
    if (!inv) return false;
    return !inv.is_complete;
  };

  const active    = flows.filter(
    (f) => f.stage !== "complete" && isInvoiceActive(f) && matchFl(f)
  );
  const completed = flows.filter((f) => f.stage === "complete");
  const completedFiltered = completed.filter(matchFl);
  const totalCompleted    = completed.length;

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <RefreshCw size={15} className="text-gray-300 animate-spin" />
    </div>
  );

  const handleExportDealFlows = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "deal-flows.csv" });
    if (!path) return;
    const count = await api.exportDealFlowsCsv(path as string);
    alert(`Exported ${count} deal flows to CSV.`);
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Deal Flow</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">
            {active.length} active deal{active.length !== 1 ? "s" : ""}
            {totalCompleted > 0 ? ` · ${totalCompleted} completed` : ""}
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-700 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <RefreshCw size={13} /> Refresh
        </button>
        <button onClick={handleExportDealFlows}
          className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 h-8 rounded-lg text-[12px] hover:bg-gray-50 transition-colors">
          <FileDown size={13} /> Export
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Search invoice or client…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-8 h-9 border border-gray-200 rounded-lg text-[13px] bg-white
                     focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* ── Completed deals drawer ──────────────────────────────────────── */}
      {totalCompleted > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          {/* Drawer toggle */}
          <button
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-gray-50/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle2 size={14} className="text-emerald-500" />
              <span className="text-[13px] font-semibold text-gray-900">Completed Deals</span>
              <span className="text-[11px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {totalCompleted}
              </span>
            </div>
            <ChevronDown
              size={14}
              className={`text-gray-400 transition-transform duration-200 ${drawerOpen ? "rotate-180" : ""}`}
            />
          </button>

          {/* Drawer body */}
          {drawerOpen && (
            <div className="border-t border-gray-100 divide-y divide-gray-50">
              {completedFiltered.length === 0 ? (
                <p className="text-[12px] text-gray-300 text-center py-8">
                  {search ? "No completed deals match your search" : "No completed deals yet"}
                </p>
              ) : (
                completedFiltered.map((flow) => {
                  const margin = flow.gross_revenue > 0
                    ? (flow.net_profit / flow.gross_revenue) * 100
                    : 0;
                  const isExp = expandedDone === flow.id;
                  return (
                    <div key={flow.id}>
                      <button
                        onClick={() => setExpandedDone(isExp ? null : flow.id)}
                        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50/40 transition-colors"
                      >
                        <ChevronRight
                          size={12}
                          className={`text-gray-300 flex-shrink-0 transition-transform ${isExp ? "rotate-90" : ""}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-gray-900">
                            {flow.client_name || "—"}
                          </div>
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            {flow.invoice_number}
                            {flow.completed_at
                              ? ` · ${new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                              : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-5 flex-shrink-0">
                          <Stat label="Revenue" value={fmtAmount(flow.gross_revenue)} />
                          <Stat
                            label="Profit"
                            value={fmtAmount(flow.net_profit)}
                            clr={flow.net_profit >= 0 ? "text-emerald-600" : "text-red-500"}
                          />
                          <Stat
                            label="Margin"
                            value={`${margin.toFixed(1)}%`}
                            clr={margin >= 20 ? "text-emerald-600" : margin >= 10 ? "text-amber-600" : "text-red-500"}
                          />
                        </div>
                      </button>
                      {isExp && (
                        <div className="border-t border-gray-50 bg-gray-50/40 px-5 py-5">
                          <CompletedBreakdown flow={flow} onReload={load} />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Active deals ──────────────────────────────────────────────── */}
      {active.length === 0 ? (
        <div className="text-center py-24 text-[13px] text-gray-300">
          {search
            ? "No active deals match your search"
            : "No active deals — deals appear automatically when invoices are sent"}
        </div>
      ) : (
        <div className="space-y-4">
          {active.map((flow, i) => (
            <DealFlowCard
              key={flow.id}
              flow={flow}
              onReload={load}
              animDelay={i * 45}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Small stat helper ────────────────────────────────────────────────────
function Stat({ label, value, clr = "text-gray-900" }: { label: string; value: string; clr?: string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-widest text-gray-400">{label}</div>
      <div className={`text-[13px] font-semibold tabular-nums ${clr}`}>{value}</div>
    </div>
  );
}

// ─── Deal flow card ───────────────────────────────────────────────────────
function invoiceStatusPill(status: string | undefined): { label: string; cls: string } {
  const s = (status ?? "").toLowerCase();
  if (s === "draft")           return { label: "Draft",   cls: "bg-gray-100 text-gray-500" };
  if (s === "sent")            return { label: "Sent",    cls: "bg-blue-50 text-blue-600" };
  if (s === "deposit_pending") return { label: "Sent",    cls: "bg-blue-50 text-blue-600" };
  if (s === "paid")            return { label: "Paid",    cls: "bg-emerald-50 text-emerald-700" };
  if (s === "overdue")         return { label: "Overdue", cls: "bg-red-50 text-red-600" };
  return { label: status ?? "—", cls: "bg-gray-100 text-gray-500" };
}

function DealFlowCard({
  flow, onReload, animDelay,
}: { flow: DealFlow; onReload: () => void; animDelay: number }) {
  const currentSi = si(flow.stage);
  const [isOpen,    setIsOpen]    = useState(false); // collapsed by default
  const [panel,     setPanel]     = useState<Stage>(() => defaultPanel(flow.stage as Stage));
  const [invStatus, setInvStatus] = useState<string | undefined>(undefined);
  const [invItems,  setInvItems]  = useState<{ description: string; qty: number }[]>([]);

  useEffect(() => { setPanel(defaultPanel(flow.stage as Stage)); }, [flow.stage]);

  // Fetch invoice status + line items for the header
  useEffect(() => {
    api.getInvoice(flow.invoice_id)
      .then((inv) => {
        setInvStatus(inv.status);
        try {
          const li: any[] = JSON.parse(inv.line_items_json || "[]");
          setInvItems(li.map((it: any) => ({ description: it.description, qty: it.qty })));
        } catch {}
      })
      .catch(() => {});
  }, [flow.invoice_id]);

  const clickNode = (key: Stage) => {
    if (si(key) > currentSi + 1) return;
    setPanel((prev) => (prev === key ? defaultPanel(flow.stage as Stage) : key));
  };

  // Deal flow stage pill color
  const stagePill: Record<Stage, string> = {
    invoiced:         "bg-blue-50 text-blue-600",
    payment_received: "bg-amber-50 text-amber-600",
    supplier_paid:    "bg-violet-50 text-violet-600",
    complete:         "bg-emerald-50 text-emerald-600",
  };

  const invPill = invoiceStatusPill(invStatus);

  return (
    <div
      className="bg-white border border-gray-100 rounded-xl shadow-[0_1px_4px_rgba(0,0,0,0.05)] overflow-hidden animate-fade-up [animation-fill-mode:backwards]"
      style={{ animationDelay: `${animDelay}ms` }}
    >
      {/* ── Collapsed header — always visible, click to expand ── */}
      <button
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-gray-50/40 transition-colors"
        onClick={() => setIsOpen((v) => !v)}
      >
        {/* Mini node dots (always visible at-a-glance progress) */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {STAGES.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all ${
                i < currentSi
                  ? "w-2.5 h-2.5 bg-indigo-500"
                  : i === currentSi
                  ? "w-2.5 h-2.5 bg-indigo-300 ring-2 ring-indigo-200 ring-offset-1"
                  : "w-2 h-2 bg-gray-200"
              }`}
            />
          ))}
        </div>

        {/* Invoice # + client + item preview */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-mono text-gray-400 flex-shrink-0">
              {flow.invoice_number}
            </span>
            <span className="text-[14px] font-semibold text-gray-900 truncate">
              {flow.client_name || "Unknown"}
            </span>
          </div>
          {invItems.length > 0 && (
            <div className="text-[11px] text-gray-400 truncate mt-0.5">
              {invItems.map((it) => it.qty > 1 ? `${it.qty}× ${it.description}` : it.description).join(" · ")}
            </div>
          )}
        </div>

        {/* Total + projected profit + invoice status + deal flow stage + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[13px] font-semibold text-gray-700 tabular-nums">
              {fmtAmount(flow.invoice_total)}
            </span>
            {flow.stage !== "complete" && (() => {
              const proj = flow.invoice_total - flow.total_supplier_cost;
              return (
                <span className={`text-[11px] font-semibold tabular-nums ${proj >= 0 ? "text-emerald-600" : "text-red-500"}`}
                  title="Projected profit — revenue minus supplier costs entered so far">
                  {fmtAmount(proj)} <span className="text-[8px] text-gray-400 uppercase">proj</span>
                </span>
              );
            })()}
          </div>
          {/* Invoice status — tells you where the invoice actually is */}
          <span className={`text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full ${invPill.cls}`}>
            {invPill.label}
          </span>
          {/* Deal flow stage — only show if it goes beyond step 1 */}
          {flow.stage !== "invoiced" && (
            <span className={`text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full ${stagePill[flow.stage as Stage]}`}>
              {NODE_LABELS[flow.stage as Stage]}
            </span>
          )}
          <ChevronDown size={14} className={`text-gray-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* ── Expanded body ── */}
      {isOpen && (
        <>
          {/* Node progress bar */}
          <div className="px-5 pt-4 pb-3 border-t border-gray-100">
            <div className="flex items-start">
              {STAGES.map((key, i) => {
                const isDone    = i < currentSi;
                const isCurrent = i === currentSi;
                const isFuture  = i > currentSi + 1;
                const isActive  = panel === key;
                const clickable = !isFuture;

                return (
                  <div key={key} className="flex items-start flex-1 last:flex-none last:w-auto">
                    <div className="flex flex-col items-center" style={{ minWidth: 0 }}>
                      <button
                        onClick={() => clickNode(key)}
                        disabled={!clickable}
                        title={NODE_LABELS[key]}
                        className={[
                          "w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold transition-all duration-200",
                          isDone    ? "bg-indigo-600 text-white" :
                          isCurrent ? "bg-white border-2 border-indigo-500 text-indigo-600 shadow-[0_0_0_4px_var(--accent-tint)]" :
                          i === currentSi + 1
                                    ? "bg-white border-2 border-gray-300 text-gray-400 hover:border-indigo-400 hover:text-indigo-500"
                                    : "bg-gray-100 border-2 border-gray-200 text-gray-300 cursor-default",
                          isActive && clickable ? "ring-2 ring-indigo-300 ring-offset-2" : "",
                        ].join(" ")}
                      >
                        {isDone ? <Check size={14} strokeWidth={2.5} /> : <span>{i + 1}</span>}
                      </button>
                      <span
                        className={[
                          "text-[10px] font-medium mt-1.5 text-center leading-tight",
                          isFuture  ? "text-gray-300"  :
                          isCurrent ? "text-indigo-600" : "text-gray-500",
                        ].join(" ")}
                        style={{ maxWidth: 68 }}
                      >
                        {NODE_LABELS[key]}
                      </span>
                    </div>
                    {i < STAGES.length - 1 && (
                      <div className={[
                        "h-[2px] flex-1 mx-2 mt-[18px] rounded-full",
                        i < currentSi ? "bg-indigo-400" : "bg-gray-200",
                      ].join(" ")} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action panel */}
          <div className="border-t border-gray-100 bg-gray-50 px-5 py-4">
            {/* Delete button row */}
            <div className="flex justify-end mb-3">
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (confirm("Delete this deal flow? This cannot be undone.")) {
                    await api.deleteDealFlow(flow.id);
                    onReload();
                  }
                }}
                className="flex items-center gap-1 text-[11px] text-gray-300 hover:text-red-400 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors"
              >
                <Trash2 size={11} /> Delete
              </button>
            </div>

            {panel === "invoiced"         && <PanelInvoiced     flow={flow} />}
            {panel === "payment_received" && <PanelPayment      flow={flow} onReload={onReload} />}
            {panel === "supplier_paid"    && <PanelSupplierPaid flow={flow} onReload={onReload} />}
            {panel === "complete"         && <PanelComplete     flow={flow} onReload={onReload} />}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Panel 1: Invoice Sent (informational) ────────────────────────────────
function PanelInvoiced({ flow }: { flow: DealFlow }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);

  useEffect(() => {
    api.getInvoice(flow.invoice_id).then(setInvoice).catch(() => {});
  }, [flow.invoice_id]);

  const items: { description: string; qty: number; rate: number; amount: number }[] = invoice
    ? (() => { try { return JSON.parse(invoice.line_items_json || "[]"); } catch { return []; } })()
    : [];

  return (
    <div className="space-y-3">
      <SectionLabel>Invoice Details</SectionLabel>
      {items.length > 0 ? (
        <div className="rounded-lg border border-gray-100 overflow-hidden">
          <div className="grid grid-cols-[1fr_48px_90px_90px] gap-x-3 px-3 py-1.5 bg-gray-50
                          text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
            <span>Item</span><span className="text-center">Qty</span>
            <span className="text-right">Rate</span><span className="text-right">Total</span>
          </div>
          {items.map((item, i) => (
            <div key={i}
              className="grid grid-cols-[1fr_48px_90px_90px] gap-x-3 px-3 py-2 border-t border-gray-50 text-[13px]">
              <span className="text-gray-700 truncate">{item.description}</span>
              <span className="text-gray-500 text-center tabular-nums">{item.qty}</span>
              <span className="text-gray-500 text-right tabular-nums">{fmtAmount(item.rate)}</span>
              <span className="text-gray-800 font-medium text-right tabular-nums">{fmtAmount(item.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between px-3 py-2 border-t border-gray-100 bg-gray-50/60">
            <span className="text-[12px] text-gray-400 font-medium">Invoice Total</span>
            <span className="text-[13px] font-bold text-gray-900 tabular-nums">
              {fmtAmount(flow.invoice_total)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-gray-300">No line items on this invoice</p>
      )}
      <div className="flex items-center gap-2 text-[12px] text-emerald-600">
        <Check size={13} strokeWidth={2.5} /> Invoice sent to client
      </div>
    </div>
  );
}

// ─── Panel 2: Add Supplier + Mark Payment Received ────────────────────────
function PanelPayment({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [invoice,     setInvoice]     = useState<Invoice | null>(null);
  const [suppName,    setSuppName]    = useState("");
  const [suppResults, setSuppResults] = useState<Supplier[]>([]);
  const [selSupplier, setSelSupplier] = useState<Supplier | null>(null);
  const [items, setItems] = useState<
    { description: string; qty: number; clientRate: number; myRate: string }[]
  >([]);
  const [showForm, setShowForm] = useState(false);
  const [saving,   setSaving]   = useState(false);

  const isDone = si(flow.stage) > si("invoiced");

  useEffect(() => {
    api.getInvoice(flow.invoice_id).then((inv) => {
      setInvoice(inv);
      try {
        const li: any[] = JSON.parse(inv.line_items_json || "[]");
        setItems(li.map((it) => ({
          description: it.description,
          qty:         it.qty,
          clientRate:  it.rate,
          myRate:      "",
        })));
      } catch {}
    }).catch(() => {});
  }, [flow.invoice_id]);

  // Supplier search
  useEffect(() => {
    if (!suppName || selSupplier?.name === suppName) { setSuppResults([]); return; }
    const t = setTimeout(() =>
      api.searchSuppliers(suppName).then(setSuppResults).catch(() => setSuppResults([])),
    250);
    return () => clearTimeout(t);
  }, [suppName, selSupplier?.name]);

  const existingPayments = flow.supplier_payments || [];
  const hasSuppliers     = existingPayments.length > 0;
  const anyRateEntered   = items.some((it) => parseAmt(it.myRate) > 0);
  const suppTotal        = items.reduce((s, it) => s + it.qty * parseAmt(it.myRate), 0);

  const pickSupplier = (s: Supplier) => {
    setSelSupplier(s);
    setSuppName(s.name);
    setSuppResults([]);
  };

  const handleAddSupplier = async () => {
    if (!suppName.trim()) return;
    setSaving(true);
    try {
      const filledItems = items.filter((it) => parseAmt(it.myRate) > 0);
      if (filledItems.length === 0) {
        alert("Enter at least one item rate before adding the supplier.");
        setSaving(false);
        return;
      }
      for (const it of filledItems) {
        const rate = parseAmt(it.myRate);
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(),
          supplier_id:   selSupplier?.id || null,
          amount:        it.qty * rate,
          quantity:      it.qty,
          unit_price:    rate,
          method:        selSupplier?.payment_method || null,
        });
      }
      setSuppName(""); setSelSupplier(null); setSuppResults([]);
      setItems((prev) => prev.map((it) => ({ ...it, myRate: "" })));
      setShowForm(false);
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleMarkReceived = async () => {
    if (!hasSuppliers) return;
    setSaving(true);
    try {
      await api.markPaymentReceived(flow.id, {
        amount: flow.invoice_total, method: null, notes: null,
      });
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleUndo = async () => {
    setSaving(true);
    try { await api.unmarkPaymentReceived(flow.id); onReload(); } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <SectionLabel>{isDone ? "Payment Received" : "Add Supplier & Receive Payment"}</SectionLabel>

      {/* Existing supplier payments */}
      {existingPayments.length > 0 && (
        <div className="space-y-1.5">
          {existingPayments.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-white border border-gray-100 rounded-lg">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-gray-800 truncate">{p.supplier_name}</div>
                {p.quantity != null && p.unit_price != null && (
                  <div className="text-[11px] text-gray-400 tabular-nums">
                    {p.quantity} × {fmtAmount(p.unit_price)}
                  </div>
                )}
              </div>
              <div className="text-[13px] font-semibold text-gray-900 tabular-nums">{fmtAmount(p.amount)}</div>
              {!isDone && (
                <button
                  onClick={async () => { await api.removeSupplierPayment(flow.id, p.id); onReload(); }}
                  className="text-gray-300 hover:text-red-400 transition-colors"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {!isDone && (
            <div className="flex justify-end text-[11px] text-gray-400 pr-1">
              Supplier total: <span className="font-semibold text-gray-700 ml-1 tabular-nums">
                {fmtAmount(existingPayments.reduce((s, p) => s + p.amount, 0))}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Add supplier form */}
      {!isDone && (
        <>
          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 text-[12px] text-indigo-600 hover:text-indigo-700 font-medium"
            >
              <Plus size={13} /> Add Supplier
            </button>
          ) : (
            <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
              <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Supplier</div>

              {/* Supplier search */}
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search supplier name…"
                  value={suppName}
                  onChange={(e) => { setSuppName(e.target.value); setSelSupplier(null); }}
                  className={inp}
                />
                {suppResults.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full bg-white border border-gray-100 rounded-xl
                                  shadow-[0_8px_24px_rgba(0,0,0,0.08)] max-h-40 overflow-y-auto">
                    {suppResults.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => pickSupplier(s)}
                        className="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                      >
                        <div className="text-[13px] font-medium text-gray-800">{s.name}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {s.contact_name && (
                            <span className="text-[11px] text-gray-500">{s.contact_name}</span>
                          )}
                          {s.payment_method && (
                            <span className="text-[11px] text-gray-400">· {s.payment_method}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selSupplier && (
                <div className="text-[11px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 space-y-0.5">
                  {selSupplier.contact_name && (
                    <div className="font-medium text-indigo-700">{selSupplier.contact_name}</div>
                  )}
                  {(selSupplier.payment_method || selSupplier.payment_details) && (
                    <div>{selSupplier.payment_method}{selSupplier.payment_details ? ` · ${selSupplier.payment_details}` : ""}</div>
                  )}
                </div>
              )}

              {/* Invoice items with per-item cost inputs */}
              {items.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Item Costs</div>
                  <div className="rounded-lg border border-gray-100 overflow-hidden">
                    {/* Column header */}
                    <div className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-1.5
                                    bg-gray-50 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
                      <span>Item</span>
                      <span className="text-center">Qty</span>
                      <span className="text-right">Our Quote</span>
                      <span className="text-right">My Rate</span>
                      <span className="text-right">My Total</span>
                    </div>

                    {items.map((item, i) => {
                      const myRate      = parseAmt(item.myRate);
                      const myTotal     = item.qty * myRate;
                      const clientTotal = item.qty * item.clientRate;
                      const saving_pct  = clientTotal > 0 && myTotal > 0
                        ? ((clientTotal - myTotal) / clientTotal) * 100
                        : null;
                      return (
                        <div
                          key={i}
                          className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-2
                                     border-t border-gray-50 items-center"
                        >
                          <span className="text-[12px] text-gray-700 truncate" title={item.description}>
                            {item.description}
                          </span>
                          <span className="text-[12px] text-gray-500 text-center tabular-nums">
                            {item.qty}
                          </span>
                          <span className="text-[12px] text-gray-400 text-right tabular-nums">
                            {fmtAmount(item.clientRate)}
                          </span>
                          {/* My rate input */}
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[11px] pointer-events-none">
                              $
                            </span>
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              placeholder="0.00"
                              value={item.myRate}
                              onChange={(e) => {
                                const copy = [...items];
                                copy[i] = { ...copy[i], myRate: e.target.value };
                                setItems(copy);
                              }}
                              className="w-full border border-gray-200 pl-5 pr-1 h-8 rounded-md text-[12px]
                                         text-right focus:outline-none focus:ring-1 focus:ring-indigo-400
                                         focus:border-indigo-400 transition-colors tabular-nums"
                            />
                          </div>
                          {/* My total + margin */}
                          <div className="text-right">
                            <div className="text-[12px] font-medium text-gray-800 tabular-nums">
                              {myRate > 0 ? fmtAmount(myTotal) : "—"}
                            </div>
                            {saving_pct !== null && myRate > 0 && (
                              <div className={`text-[10px] tabular-nums ${
                                saving_pct >= 20 ? "text-emerald-600"
                                : saving_pct >= 0 ? "text-amber-600"
                                : "text-red-500"
                              }`}>
                                {saving_pct.toFixed(0)}% margin
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {/* Totals row */}
                    {anyRateEntered && (
                      <div className="flex justify-between items-center px-3 py-2 border-t border-gray-100 bg-gray-50/60">
                        <span className="text-[11px] text-gray-400 font-medium">Total supplier cost</span>
                        <span className="text-[12px] font-bold text-gray-900 tabular-nums">
                          {fmtAmount(suppTotal)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Fallback if invoice has no line items */
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Amount</div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      placeholder="0.00"
                      value={items[0]?.myRate ?? ""}
                      onChange={(e) =>
                        setItems([{
                          description: "Supplier cost", qty: 1,
                          clientRate: flow.invoice_total, myRate: e.target.value,
                        }])
                      }
                      className="w-full border border-gray-200 pl-8 pr-3 h-9 rounded-lg text-[13px]
                                 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleAddSupplier}
                  disabled={saving || !suppName.trim() || !anyRateEntered}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px]
                             font-medium disabled:opacity-40 transition-colors flex items-center gap-1.5"
                >
                  <Plus size={13} /> Add Supplier
                </button>
                <button
                  onClick={() => {
                    setShowForm(false);
                    setSuppName(""); setSelSupplier(null); setSuppResults([]);
                    setItems((prev) => prev.map((it) => ({ ...it, myRate: "" })));
                  }}
                  className="text-[13px] text-gray-400 hover:text-gray-600 px-3 h-9
                             hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Mark payment received */}
          <div className="space-y-2">
            {!hasSuppliers && (
              <div className="flex items-center gap-1.5 text-[12px] text-amber-600">
                <AlertTriangle size={12} />
                Add at least one supplier before marking payment received
              </div>
            )}
            <button
              onClick={handleMarkReceived}
              disabled={saving || !hasSuppliers}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white
                         px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
            >
              <DollarSign size={14} /> Mark Payment Received
            </button>
          </div>
        </>
      )}

      {/* Completed state */}
      {isDone && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[13px] text-emerald-600 font-medium">
            <CheckCircle2 size={14} />
            {fmtAmount(flow.payment_received_amount)} received
          </div>
          <button
            onClick={handleUndo}
            disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-600
                       px-2.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <RotateCcw size={11} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Panel 3: Mark Supplier Paid ─────────────────────────────────────────
function PanelSupplierPaid({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [saving, setSaving] = useState(false);
  const payments  = flow.supplier_payments || [];
  const isDone    = si(flow.stage) > si("payment_received");
  const allPaid   = payments.length > 0 && payments.every((p) => p.paid);

  // Mark ALL unpaid supplier payments in one shot — one button, one reload
  const markAllPaid = async () => {
    setSaving(true);
    try {
      const unpaid = payments.filter((p) => !p.paid);
      await Promise.all(unpaid.map((p) => api.markSupplierPaymentPaid(flow.id, p.id)));
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  // Undo: unmark all paid
  const unmarkAll = async () => {
    setSaving(true);
    try {
      const paid = payments.filter((p) => p.paid);
      await Promise.all(paid.map((p) => api.unmarkSupplierPaymentPaid(flow.id, p.id)));
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <SectionLabel>Supplier Payments</SectionLabel>

      {payments.length === 0 ? (
        <p className="text-[12px] text-gray-300">
          No suppliers recorded yet — go to the Payment In step to add one
        </p>
      ) : (
        <div className="space-y-2">
          {/* Cost breakdown — read-only, shows what was entered per item */}
          <div className="rounded-lg border border-gray-100 overflow-hidden bg-white">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-gray-800 truncate">{p.supplier_name}</div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-gray-400 tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                  {p.method && <div className="text-[11px] text-gray-400">{p.method}</div>}
                  {p.price_changed && p.original_amount != null && (
                    <div className="flex items-center gap-1 text-[11px] text-amber-600 mt-0.5">
                      <AlertTriangle size={10} />
                      Price changed: {fmtAmount(p.original_amount)} → {fmtAmount(p.amount)}
                    </div>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-gray-900 tabular-nums">
                  {fmtAmount(p.amount)}
                </div>
              </div>
            ))}
            <div className="flex justify-between items-center px-3 py-2 bg-gray-50/60 border-t border-gray-100">
              <span className="text-[11px] text-gray-400 font-medium">Total supplier cost</span>
              <span className="text-[13px] font-bold text-gray-900 tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>

          {/* Single action: mark everything paid at once */}
          {!isDone && (
            allPaid ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] text-emerald-600 font-medium">
                  <CheckCircle2 size={14} />
                  All supplier payments marked paid
                </div>
                <button
                  onClick={unmarkAll}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-600
                             px-2.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <RotateCcw size={11} /> Undo
                </button>
              </div>
            ) : (
              <button
                onClick={markAllPaid}
                disabled={saving || payments.length === 0}
                className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white
                           px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors w-full justify-center"
              >
                <Check size={14} strokeWidth={2.5} />
                Mark Supplier Paid — {fmtAmount(flow.total_supplier_cost)}
              </button>
            )
          )}

          {isDone && (
            <div className="flex items-center gap-2 text-[13px] text-emerald-600 font-medium">
              <CheckCircle2 size={14} />
              Supplier paid — {fmtAmount(flow.total_supplier_cost)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Panel 4: Complete deal ───────────────────────────────────────────────
type ShippingHold = "idle" | "asking" | "shipping";

function PanelComplete({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [split,        setSplit]        = useState<ProfitSplit | null>(null);
  const [saving,       setSaving]       = useState(false);
  const [shipHold,     setShipHold]     = useState<ShippingHold>("idle");
  // Shipping form fields
  const [carrier,      setCarrier]      = useState("");
  const [tracking,     setTracking]     = useState("");
  const [pickupDate,   setPickupDate]   = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  // Backlog date: defaults to today but user can pick any past date
  const todayStr = new Date().toISOString().slice(0, 10);
  const [completedDate, setCompletedDate] = useState(todayStr);

  useEffect(() => { api.getProfitSplit().then(setSplit).catch(() => {}); }, []);

  const canComplete = flow.stage === "payment_received" || flow.stage === "supplier_paid";
  const isComplete  = flow.stage === "complete";
  const gross  = isComplete ? flow.gross_revenue       : flow.payment_received_amount;
  const cost   = isComplete ? flow.total_cost          : flow.total_supplier_cost;
  const profit = gross - cost;
  const margin = gross > 0 ? (profit / gross) * 100 : 0;

  const runComplete = async () => {
    setSaving(true);
    try {
      const result = await api.completeDealFlow(flow.id, "none", completedDate || null);
      if (result.is_loss && result.warning) alert(result.warning);
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleCompleteClick = () => {
    if (profit < 0) {
      const ok = confirm(
        `Warning: This deal is at a loss.\n\nRevenue: ${fmtAmount(gross)}\nCosts: ${fmtAmount(cost)}\nLoss: ${fmtAmount(profit)}\n\nMark complete anyway?`
      );
      if (!ok) return;
    }
    setShipHold("asking");
  };

  const handleCompleteNow = () => { setShipHold("idle"); runComplete(); };

  const handleShippingComplete = async () => {
    setSaving(true);
    try {
      // Save shipping info first
      await api.saveInvoiceShipping(flow.invoice_id, {
        carrier:          carrier   || undefined,
        tracking_number:  tracking  || undefined,
        pickup_date:      pickupDate   || undefined,
        delivery_date:    deliveryDate || undefined,
        is_complete:      true,
      });
      await api.completeDealFlow(flow.id, "none", completedDate || null);
      onReload();
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleUndo = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <SectionLabel>Deal Summary</SectionLabel>

      {/* P&L grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          { label: "Revenue", value: fmtAmount(gross), clr: "text-gray-900" },
          { label: "Costs",   value: fmtAmount(cost),  clr: "text-gray-900" },
          {
            label: profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(profit),
            clr:   profit >= 0 ? "text-emerald-600" : "text-red-500",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-emerald-600" : margin >= 10 ? "text-amber-600" : "text-red-500",
          },
        ].map((item) => (
          <div key={item.label} className="bg-white border border-gray-100 rounded-xl px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-widest text-gray-400">{item.label}</div>
            <div className={`text-[16px] font-bold tabular-nums mt-0.5 ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Profit split preview */}
      {split && isComplete && profit > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl px-4 py-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">
            Profit Split
          </div>
          <div className="flex gap-6">
            {[
              { name: split.jack_name, val: flow.profit_jack    },
              { name: split.ben_name,  val: flow.profit_ben     },
              { name: "Business",      val: flow.profit_business },
            ].map((item) => (
              <div key={item.name}>
                <div className="text-[11px] text-gray-400">{item.name}</div>
                <div className="text-[13px] font-semibold text-emerald-600 tabular-nums">
                  {fmtAmount(item.val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Complete action area ── */}
      {canComplete && shipHold === "idle" && (
        <div className="space-y-2">
          {/* Completion date — defaults to today, can be backdated for backlog */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-gray-400 whitespace-nowrap">Completed date</label>
            <input
              type="date"
              value={completedDate}
              max={todayStr}
              onChange={(e) => setCompletedDate(e.target.value)}
              className="flex-1 border border-gray-200 px-2.5 h-8 rounded-lg text-[12px] bg-white
                         focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
            />
          </div>
          <button
            onClick={handleCompleteClick}
            disabled={saving}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-10 rounded-lg
                       text-[14px] font-medium disabled:opacity-40 transition-colors"
          >
            Complete Deal
          </button>
        </div>
      )}

      {/* Step A: shipping question */}
      {canComplete && shipHold === "asking" && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
            <Truck size={15} className="text-amber-500" />
            Does this deal require shipping?
          </div>
          <p className="text-[12px] text-amber-700">
            If items are being shipped, hold here and track the shipment before closing out.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShipHold("shipping")}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white
                         px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
            >
              <Truck size={13} /> Yes, track shipping
            </button>
            <button
              onClick={handleCompleteNow}
              disabled={saving}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white
                         px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
            >
              <Check size={13} /> No, complete now
            </button>
            <button
              onClick={() => setShipHold("idle")}
              className="text-[13px] text-gray-400 hover:text-gray-600 px-3 h-9
                         hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step B: shipping form — hold until confirmed */}
      {canComplete && shipHold === "shipping" && (
        <div className="bg-white border border-amber-100 rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-amber-500" />
            <span className="text-[13px] font-semibold text-gray-800">Shipping Hold</span>
            <span className="ml-auto text-[11px] text-amber-600 bg-amber-50 border border-amber-100
                             px-2 py-0.5 rounded-full font-medium">
              Awaiting delivery
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-gray-500 font-medium mb-1">Carrier</label>
              <input
                className={inp}
                placeholder="FedEx, UPS…"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-500 font-medium mb-1">Tracking #</label>
              <input
                className={inp}
                placeholder="Tracking number"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-500 font-medium mb-1">Pickup Date</label>
              <input
                type="date"
                className={inp}
                value={pickupDate}
                onChange={(e) => setPickupDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-500 font-medium mb-1">Delivery Date</label>
              <input
                type="date"
                className={inp}
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleShippingComplete}
              disabled={saving}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white
                         px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
            >
              <Check size={13} /> Confirm Delivery & Complete
            </button>
            <button
              onClick={() => setShipHold("idle")}
              className="text-[13px] text-gray-400 hover:text-gray-600 px-3 h-9
                         hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Completed state */}
      {isComplete && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[12px] text-emerald-600 font-medium">
            <CheckCircle2 size={13} />
            Completed{flow.completed_at
              ? ` ${new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
              : ""}
          </div>
          <button
            onClick={handleUndo}
            disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-amber-600 hover:text-amber-800
                       px-2.5 py-1 rounded-lg hover:bg-amber-50 border border-amber-200 transition-colors"
          >
            <RotateCcw size={11} /> Undo Complete
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Completed deal full breakdown ────────────────────────────────────────
function CompletedBreakdown({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [split,  setSplit]  = useState<ProfitSplit | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.getProfitSplit().then(setSplit).catch(() => {}); }, []);

  const margin = flow.gross_revenue > 0 ? (flow.net_profit / flow.gross_revenue) * 100 : 0;
  const payments = flow.supplier_payments || [];

  const handleReopen = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this completed deal? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* P&L summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Revenue",                                    value: fmtAmount(flow.gross_revenue), clr: "text-gray-900"   },
          { label: "Total Costs",                                value: fmtAmount(flow.total_cost),    clr: "text-gray-900"   },
          {
            label: flow.net_profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(flow.net_profit),
            clr:   flow.net_profit >= 0 ? "text-emerald-600" : "text-red-500",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-emerald-600" : margin >= 10 ? "text-amber-600" : "text-red-500",
          },
        ].map((item) => (
          <div key={item.label} className="bg-white border border-gray-100 rounded-xl px-4 py-3">
            <div className="text-[10px] uppercase tracking-widest text-gray-400">{item.label}</div>
            <div className={`text-[18px] font-bold tabular-nums mt-1 ${item.clr}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Supplier breakdown */}
      {payments.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-50">
            <SectionLabel>Supplier Payments</SectionLabel>
          </div>
          <div className="divide-y divide-gray-50">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-800 font-medium">{p.supplier_name}</div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-gray-400 tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-gray-900 tabular-nums">{fmtAmount(p.amount)}</div>
              </div>
            ))}
            <div className="flex justify-between items-center px-4 py-2.5 bg-gray-50/60">
              <span className="text-[11px] text-gray-400 font-medium">Total supplier cost</span>
              <span className="text-[12px] font-bold text-gray-900 tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Profit split */}
      {split && flow.net_profit > 0 && (
        <div className="bg-white border border-gray-100 rounded-xl px-4 py-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
            Profit Split
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { name: split.jack_name, val: flow.profit_jack     },
              { name: split.ben_name,  val: flow.profit_ben      },
              { name: "Business",      val: flow.profit_business  },
            ].map((item) => (
              <div key={item.name}>
                <div className="text-[12px] text-gray-400">{item.name}</div>
                <div className="text-[18px] font-bold text-emerald-600 tabular-nums mt-0.5">
                  {fmtAmount(item.val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleReopen}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-700
                     px-3 h-8 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RotateCcw size={12} /> Reopen
        </button>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-red-400 hover:text-red-600
                     px-3 h-8 border border-red-100 rounded-lg hover:bg-red-50 transition-colors ml-auto"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">
      {children}
    </div>
  );
}
