import { useEffect, useState, useCallback } from "react";
import {
  Check, ChevronDown, ChevronRight, Search, Plus, X,
  AlertTriangle, RotateCcw, RefreshCw, Trash2,
  DollarSign, CheckCircle2, Truck, Package, FileDown, XCircle,
} from "lucide-react";
import {
  api, DealFlow, SupplierPayment, Invoice, Supplier, PayoutShare,
} from "../lib/api";
import { fmtAmount, primarySupplierLabel } from "../lib/format";
import { toast } from "./Toast";
import CostProfitPanel from "./CostProfitPanel";
import CompletedBreakdown from "./CompletedBreakdown";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

// ─── helpers ──────────────────────────────────────────────────────────────
function parseAmt(v: string): number { return parseFloat(v.replace(/,/g, "")) || 0; }

const STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"] as const;
type Stage = typeof STAGES[number];
function si(s: string): number { return STAGES.indexOf(s as Stage); }

const NODE_LABELS: Record<Stage, string> = {
  invoiced:         "Invoiced",
  payment_received: "Payment in",
  supplier_paid:    "Supplier paid",
  complete:         "Complete",
};

// Auto-open the panel for the NEXT step needed
function defaultPanel(stage: Stage): Stage {
  const idx = si(stage);
  return STAGES[Math.min(idx + 1, STAGES.length - 1)];
}

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Non-supplier deal costs (freight, wire fees) — entered as categorized cost lines
// so net_profit reflects them. `supplier` is the default for existing/normal lines.
const COST_CATS: { value: string; label: string }[] = [
  { value: "freight",  label: "Freight" },
  { value: "wire_in",  label: "Incoming wire fee" },
  { value: "wire_out", label: "Outgoing wire fee" },
  { value: "other",    label: "Other cost" },
];
const catLabel = (c?: string | null) =>
  c === "freight" ? "Freight" : c === "wire_in" ? "Wire in" :
  c === "wire_out" ? "Wire out" : c === "other" ? "Other" : "Supplier";

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
      // includes drafts so invoices and deal flow stay fully in sync. Exclude
      // VOIDED invoices: list_deal_flows hides their flows, so they're never
      // "covered" and would retrigger createDealFlow every load — which errors
      // ("deal flow already exists") and, via Promise.all, blanked the whole view.
      const coveredIds = new Set(deduped.map((fl) => fl.invoice_id));
      const missing = inv.filter((i) => !i.is_complete && !i.voided && !coveredIds.has(i.id));
      if (missing.length > 0) {
        // allSettled, not all: one failed create must never blank the pipeline.
        await Promise.allSettled(missing.map((i) => api.createDealFlow(i.id, null, i.number)));
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

  // Skeleton mirrors the real layout (header, search, deal cards) — and only on
  // first load, so refreshes after an action don't blank the whole view.
  if (loading && flows.length === 0) return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-6 w-32 bg-surface-2 rounded-md animate-pulse" />
          <div className="h-3.5 w-48 bg-surface-2 rounded animate-pulse mt-2" />
        </div>
        <div className="h-8 w-40 bg-surface-2 rounded-lg animate-pulse" />
      </div>
      <div className="h-9 w-full max-w-xs bg-surface-2 rounded-lg animate-pulse" />
      <div className="space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-surface border border-line rounded-xl px-5 py-3.5 flex items-center gap-3">
            <div className="flex items-center gap-1">
              {[0, 1, 2, 3].map((j) => <span key={j} className="w-2.5 h-2.5 rounded-full bg-surface-2 animate-pulse" />)}
            </div>
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-1/3 bg-surface-2 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-surface-2 rounded animate-pulse" />
            </div>
            <div className="h-6 w-20 bg-surface-2 rounded-full animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );

  const handleExportDealFlows = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "deal-flows.csv" });
    if (!path) return;
    const count = await api.exportDealFlowsCsv(path as string);
    toast(`Exported ${count} deal flow${count !== 1 ? "s" : ""} to CSV`);
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Deal Flow</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {active.length} active deal{active.length !== 1 ? "s" : ""}
            {totalCompleted > 0 ? ` · ${totalCompleted} completed` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 px-2.5 h-8 rounded-lg hover:bg-surface-3 transition-colors"
          >
            <RefreshCw size={13} /> Refresh
          </button>
          <button onClick={handleExportDealFlows}
            className="flex items-center gap-1.5 border border-line text-ink-2 px-3 h-8 rounded-lg text-[12px] font-medium hover:bg-surface-2 transition-colors">
            <FileDown size={13} /> Export
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          type="text"
          placeholder="Search invoice or client…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-8 h-9 border border-line rounded-lg text-[13px] bg-surface
                     focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-muted"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* ── Completed deals drawer ──────────────────────────────────────── */}
      {totalCompleted > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {/* Drawer toggle */}
          <button
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-surface-2/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <CheckCircle2 size={14} className="text-success-ink" />
              <span className="text-[13px] font-semibold text-ink">Completed deals</span>
              <span className="text-[11px] font-medium text-muted bg-surface-3 px-2 py-0.5 rounded-full">
                {totalCompleted}
              </span>
            </div>
            <ChevronDown
              size={14}
              className={`text-muted transition-transform duration-200 ${drawerOpen ? "rotate-180" : ""}`}
            />
          </button>

          {/* Drawer body */}
          {drawerOpen && (
            <div className="border-t border-line divide-y divide-line-2">
              {completedFiltered.length === 0 ? (
                <p className="text-[12px] text-faint text-center py-8">
                  {search ? "No completed deals match your search" : "No completed deals yet"}
                </p>
              ) : (
                completedFiltered.map((flow) => {
                  const margin = flow.gross_revenue > 0
                    ? (flow.net_profit / flow.gross_revenue) * 100
                    : 0;
                  const isExp = expandedDone === flow.id;
                  const sup = primarySupplierLabel(flow.supplier_payments);
                  return (
                    <div key={flow.id}>
                      <button
                        onClick={() => setExpandedDone(isExp ? null : flow.id)}
                        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-2/40 transition-colors"
                      >
                        <ChevronRight
                          size={12}
                          className={`text-faint flex-shrink-0 transition-transform ${isExp ? "rotate-90" : ""}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-ink">
                            {flow.client_name || "—"}
                          </div>
                          <div className="text-[11px] text-muted mt-0.5 truncate">
                            {flow.invoice_number}
                            {flow.completed_at
                              ? ` · ${new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                              : ""}
                            {sup ? ` → ${sup}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-5 flex-shrink-0">
                          <Stat label="Revenue" value={fmtAmount(flow.gross_revenue)} />
                          <Stat
                            label="Profit"
                            value={fmtAmount(flow.net_profit)}
                            clr={flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}
                          />
                          <Stat
                            label="Margin"
                            value={`${margin.toFixed(1)}%`}
                            clr={margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink"}
                          />
                        </div>
                      </button>
                      {isExp && (
                        <div className="border-t border-line-2 bg-surface-2/40 px-5 py-5">
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
        <div className="bg-surface border border-line rounded-xl py-16 flex flex-col items-center">
          <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
            <CheckCircle2 size={18} />
          </div>
          <div className="text-[13px] text-muted">
            {search
              ? "No active deals match your search"
              : "No active deals — deals appear automatically when invoices are sent"}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {active.map((flow, i) => (
            <DealFlowCard
              key={flow.id}
              flow={flow}
              onReload={load}

              zebra={i % 2 === 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Small stat helper ────────────────────────────────────────────────────
function Stat({ label, value, clr = "text-ink" }: { label: string; value: string; clr?: string }) {
  return (
    <div className="text-right">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={`text-[13px] font-semibold tabular-nums ${clr}`}>{value}</div>
    </div>
  );
}

// ─── Deal flow card ───────────────────────────────────────────────────────
function invoiceStatusPill(status: string | undefined): { label: string; cls: string } {
  const s = (status ?? "").toLowerCase();
  if (s === "draft")           return { label: "Draft",   cls: "bg-surface-3 text-muted" };
  if (s === "sent")            return { label: "Sent",    cls: "bg-info-bg text-info-ink" };
  if (s === "deposit_pending") return { label: "Sent",    cls: "bg-info-bg text-info-ink" };
  if (s === "paid")            return { label: "Paid",    cls: "bg-success-bg text-success-ink" };
  if (s === "overdue")         return { label: "Overdue", cls: "bg-danger-bg text-danger-ink" };
  return { label: status ?? "—", cls: "bg-surface-3 text-muted" };
}

function DealFlowCard({
  flow, onReload, zebra,
}: { flow: DealFlow; onReload: () => void; zebra: boolean }) {
  const currentSi = si(flow.stage);
  const [isOpen,    setIsOpen]    = useState(false); // collapsed by default
  const [panel,     setPanel]     = useState<Stage>(() => defaultPanel(flow.stage as Stage));
  const [invStatus, setInvStatus] = useState<string | undefined>(undefined);
  const [invItems,  setInvItems]  = useState<{ description: string; qty: number; rate: number; amount: number }[]>([]);
  const [invMeta,   setInvMeta]   = useState<{ subtotal: number; tax: number; total: number; number: string } | null>(null);

  useEffect(() => { setPanel(defaultPanel(flow.stage as Stage)); }, [flow.stage]);

  // Fetch invoice status + line items for the header
  useEffect(() => {
    api.getInvoice(flow.invoice_id)
      .then((inv) => {
        setInvStatus(inv.status);
        setInvMeta({ subtotal: inv.subtotal ?? 0, tax: inv.tax ?? 0, total: inv.total ?? 0, number: inv.number ?? "" });
        try {
          const li: any[] = JSON.parse(inv.line_items_json || "[]");
          setInvItems(li.map((it: any) => ({ description: it.description, qty: it.qty, rate: it.rate ?? 0, amount: it.amount ?? 0 })));
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
    invoiced:         "bg-info-bg text-info-ink",
    payment_received: "bg-warning-bg text-warning-ink",
    supplier_paid:    "bg-accent/10 text-accent",
    complete:         "bg-success-bg text-success-ink",
  };

  const invPill = invoiceStatusPill(invStatus);

  return (
    <div
      className={`border border-line rounded-xl shadow-[0_1px_4px_rgba(0,0,0,0.05)] overflow-hidden ${zebra ? "bg-surface-2/40" : "bg-surface"}`}
    >
      {/* ── Collapsed header — always visible, click to expand ── */}
      <button
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-surface-2/40 transition-colors"
        onClick={() => setIsOpen((v) => !v)}
      >
        {/* Mini node dots (always visible at-a-glance progress) */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {STAGES.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all ${
                i < currentSi
                  ? "w-2.5 h-2.5 bg-accent"
                  : i === currentSi
                  ? "w-2.5 h-2.5 bg-accent ring-2 ring-accent/20 ring-offset-1"
                  : "w-2 h-2 bg-surface-3"
              }`}
            />
          ))}
        </div>

        {/* Invoice # + client → supplier + item preview */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[12px] font-mono text-muted flex-shrink-0">
              {flow.invoice_number}
            </span>
            <span className="text-[14px] text-ink truncate min-w-0">
              <span className="font-semibold">{flow.client_name || "Unknown"}</span>
              {(() => {
                const sup = primarySupplierLabel(flow.supplier_payments);
                return sup ? <span className="text-[12px] text-muted"> → {sup}</span> : null;
              })()}
            </span>
          </div>
          {invItems.length > 0 && (
            <div className="text-[11px] text-muted truncate mt-0.5">
              {invItems.map((it) => it.qty > 1 ? `${it.qty}× ${it.description}` : it.description).join(" · ")}
            </div>
          )}
        </div>

        {/* Total + projected profit + invoice status + deal flow stage + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[13px] font-semibold text-ink-2 tabular-nums">
              {fmtAmount(flow.invoice_total)}
            </span>
            {flow.stage !== "complete" && (() => {
              const proj = flow.invoice_total - flow.total_supplier_cost;
              return (
                <span className={`text-[11px] font-semibold tabular-nums ${proj >= 0 ? "text-success-ink" : "text-danger-ink"}`}
                  title="Projected profit — revenue minus supplier costs entered so far">
                  {fmtAmount(proj)} <span className="text-[8px] text-muted uppercase">proj</span>
                </span>
              );
            })()}
          </div>
          {/* Invoice status — tells you where the invoice actually is */}
          <span className={`text-[12.5px] font-medium px-2 py-0.5 rounded-full ${invPill.cls}`}>
            {invPill.label}
          </span>
          {/* Deal flow stage — only show if it goes beyond step 1 */}
          {flow.stage !== "invoiced" && (
            <span className={`text-[12.5px] font-medium px-2 py-0.5 rounded-full ${stagePill[flow.stage as Stage]}`}>
              {NODE_LABELS[flow.stage as Stage]}
            </span>
          )}
          <ChevronDown size={14} className={`text-muted transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* ── Expanded body ── */}
      {isOpen && (
        <>
          {/* Node progress bar */}
          <div className="px-5 pt-4 pb-3 border-t border-line">
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
                          isDone    ? "bg-accent text-on-accent" :
                          isCurrent ? "bg-surface border-2 border-accent text-accent shadow-[0_0_0_4px_var(--accent-tint)]" :
                          i === currentSi + 1
                                    ? "bg-surface border-2 border-line-3 text-muted hover:border-accent hover:text-accent"
                                    : "bg-surface-3 border-2 border-line text-faint cursor-default",
                          isActive && clickable ? "ring-2 ring-accent ring-offset-2" : "",
                        ].join(" ")}
                      >
                        {isDone ? <Check size={14} strokeWidth={2.5} /> : <span>{i + 1}</span>}
                      </button>
                      <span
                        className={[
                          "text-[10px] font-medium mt-1.5 text-center leading-tight",
                          isFuture  ? "text-faint"  :
                          isCurrent ? "text-accent" : "text-muted",
                        ].join(" ")}
                        style={{ maxWidth: 68 }}
                      >
                        {NODE_LABELS[key]}
                      </span>
                    </div>
                    {i < STAGES.length - 1 && (
                      <div className={[
                        "h-[2px] flex-1 mx-2 mt-[18px] rounded-full",
                        i < currentSi ? "bg-accent" : "bg-surface-3",
                      ].join(" ")} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Invoice breakdown — what was bought, exactly as on the invoice */}
          {invItems.length > 0 && (
            <div className="px-5 pb-4 border-t border-line">
              <div className="text-[12.5px] font-medium text-muted mt-3 mb-2">
                Invoice breakdown{invMeta?.number ? ` · ${invMeta.number}` : ""}
              </div>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left font-semibold py-1">Description</th>
                    <th className="text-right font-semibold py-1 w-12">Qty</th>
                    <th className="text-right font-semibold py-1 w-20">Rate</th>
                    <th className="text-right font-semibold py-1 w-24">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invItems.map((it, i) => (
                    <tr key={i} className="border-t border-line-2">
                      <td className="py-1.5 text-ink-2">{it.description}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted">{it.qty}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted">{fmtAmount(it.rate)}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium text-ink">{fmtAmount(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {invMeta && (
                <div className="mt-2 pt-2 border-t border-line space-y-0.5 text-[12px]">
                  <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(invMeta.subtotal)}</span></div>
                  <div className="flex justify-between text-muted"><span>Tax</span><span className="tabular-nums">{fmtAmount(invMeta.tax)}</span></div>
                  <div className="flex justify-between font-semibold text-ink"><span>Total</span><span className="tabular-nums">{fmtAmount(invMeta.total)}</span></div>
                </div>
              )}
            </div>
          )}

          {/* Action panel */}
          <div className="border-t border-line bg-surface-2 px-5 py-4">
            {/* Row actions — mark fell through (voids the invoice) + archive */}
            <div className="flex justify-end gap-1.5 mb-3">
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm("Mark this deal as fallen through? It drops from the pipeline and its invoice is voided. You can restore it from the Archive.")) return;
                  try { await api.setDealFlowFellThrough(flow.id, true); toast("Deal marked as fell through"); onReload(); }
                  catch (err: any) { toast(String(err), "error"); }
                }}
                className="flex items-center gap-1 text-[11px] text-faint hover:text-warning-ink hover:bg-warning-bg px-2 py-1 rounded-lg transition-colors"
              >
                <XCircle size={11} /> Mark deal fell through
              </button>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm("Move to Archive? You can restore it anytime.")) return;
                  try { await api.deleteDealFlow(flow.id); toast("Moved to Archive"); onReload(); }
                  catch (err: any) { toast(String(err), "error"); }
                }}
                className="flex items-center gap-1 text-[11px] text-faint hover:text-danger-ink hover:bg-danger-bg px-2 py-1 rounded-lg transition-colors"
              >
                <Trash2 size={11} /> Archive
              </button>
            </div>

            {panel === "invoiced"         && <PanelInvoiced     flow={flow} />}
            {panel === "payment_received" && <PanelPayment      flow={flow} onReload={onReload} />}
            {panel === "supplier_paid"    && <PanelSupplierPaid flow={flow} onReload={onReload} onGoToComplete={() => setPanel("complete")} />}
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
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="grid grid-cols-[1fr_48px_90px_90px] gap-x-3 px-3 py-1.5 bg-surface-2
                          text-[12.5px] font-medium text-muted">
            <span>Item</span><span className="text-center">Qty</span>
            <span className="text-right">Rate</span><span className="text-right">Total</span>
          </div>
          {items.map((item, i) => (
            <div key={i}
              className="grid grid-cols-[1fr_48px_90px_90px] gap-x-3 px-3 py-2 border-t border-line-2 text-[13px]">
              <span className="text-ink-2 truncate">{item.description}</span>
              <span className="text-muted text-center tabular-nums">{item.qty}</span>
              <span className="text-muted text-right tabular-nums">{fmtAmount(item.rate)}</span>
              <span className="text-ink font-medium text-right tabular-nums">{fmtAmount(item.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between px-3 py-2 border-t border-line bg-surface-2/60">
            <span className="text-[12px] text-muted font-medium">Invoice Total</span>
            <span className="text-[13px] font-bold text-ink tabular-nums">
              {fmtAmount(flow.invoice_total)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-faint">No line items on this invoice</p>
      )}
      <div className="flex items-center gap-2 text-[12px] text-success-ink">
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
  // Actual dollars received — defaults to the invoice total but the user can
  // enter a different amount (e.g. a slight underpayment they'll eat).
  const [receivedAmount, setReceivedAmount] = useState<string>((flow.invoice_total ? flow.invoice_total.toFixed(2) : ""));
  useEffect(() => { setReceivedAmount((flow.invoice_total ? flow.invoice_total.toFixed(2) : "")); }, [flow.invoice_total]);
  // A partial up-front deposit — SEPARATE from the full amount received. The
  // balance owed (invoice total − deposit) stays outstanding until the full
  // payment is marked; recording a deposit does not advance the stage.
  const [depositAmount, setDepositAmount] = useState<string>((flow.deposit_amount ? flow.deposit_amount.toFixed(2) : ""));
  useEffect(() => { setDepositAmount(flow.deposit_amount ? flow.deposit_amount.toFixed(2) : ""); }, [flow.deposit_amount]);
  const [savingDeposit, setSavingDeposit] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [costType, setCostType] = useState("freight");
  const [costAmt,  setCostAmt]  = useState("");
  const [costNote, setCostNote] = useState("");

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
    const filledItems = items.filter((it) => parseAmt(it.myRate) > 0);
    // Allow a ZERO-cost deal (free goods / consignment): instead of blocking, confirm
    // once so a forgotten rate doesn't silently book $0, then record a single $0
    // supplier payment. Any positive rate → normal per-item flow (unchanged).
    const zeroCost = filledItems.length === 0;
    if (zeroCost && !confirm("Submit $0 as the supplier cost for this deal? Your profit will equal the full revenue. Are you sure?")) {
      return;
    }
    setSaving(true);
    try {
      if (zeroCost) {
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(),
          supplier_id:   selSupplier?.id || null,
          amount:        0,
          quantity:      items.reduce((s, it) => s + it.qty, 0) || 1,
          unit_price:    0,
          method:        selSupplier?.payment_method || null,
        });
      } else {
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
      }
      setSuppName(""); setSelSupplier(null); setSuppResults([]);
      setItems((prev) => prev.map((it) => ({ ...it, myRate: "" })));
      setShowForm(false);
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleAddCost = async () => {
    const amt = parseAmt(costAmt);
    if (amt <= 0) { toast("Enter a cost amount", "error"); return; }
    setSaving(true);
    try {
      const label = COST_CATS.find((c) => c.value === costType)?.label || "Cost";
      await api.addSupplierPayment(flow.id, {
        supplier_name: costNote.trim() || label,
        supplier_id:   null,
        amount:        amt,
        category:      costType,
      });
      setCostAmt(""); setCostNote(""); setShowCost(false);
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleMarkReceived = async () => {
    const amt = parseFloat(receivedAmount);
    if (isNaN(amt) || amt < 0) { toast("Enter a valid amount received", "error"); return; }
    // No supplier on this deal → it books as 100% profit (no cost). Confirm so it's
    // intentional, then proceed. You can complete the deal directly from here.
    if (!hasSuppliers && !confirm("No supplier cost on this deal — it will be recorded as 100% profit. Mark payment received?")) return;
    setSaving(true);
    try {
      await api.markPaymentReceived(flow.id, { amount: amt, method: null, notes: null });
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleUndo = async () => {
    setSaving(true);
    try { await api.unmarkPaymentReceived(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleSaveDeposit = async () => {
    const amt = parseFloat(depositAmount) || 0;
    if (amt < 0) { toast("Enter a valid deposit amount", "error"); return; }
    setSavingDeposit(true);
    try {
      await api.setDeposit(flow.id, amt);
      toast(amt > 0 ? "Deposit saved" : "Deposit cleared", "success");
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSavingDeposit(false);
  };

  return (
    <div className="space-y-4">
      <SectionLabel>{isDone ? "Payment received" : "Add supplier & receive payment"}</SectionLabel>

      {/* Existing supplier payments */}
      {existingPayments.length > 0 && (
        <div className="space-y-1.5">
          {existingPayments.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-line rounded-lg">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1.5">
                  {p.supplier_name}
                  {p.category && p.category !== "supplier" && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-accent bg-accent/10 border border-accent/20 px-1.5 py-0.5 rounded flex-shrink-0">{catLabel(p.category)}</span>
                  )}
                </div>
                {p.quantity != null && p.unit_price != null && (
                  <div className="text-[11px] text-muted tabular-nums">
                    {p.quantity} × {fmtAmount(p.unit_price)}
                  </div>
                )}
              </div>
              <div className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(p.amount)}</div>
              {!isDone && (
                <button
                  onClick={async () => { await api.removeSupplierPayment(flow.id, p.id); onReload(); }}
                  className="text-faint hover:text-danger-ink transition-colors"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
          {!isDone && (() => {
            const byCat = existingPayments.reduce((m: Record<string, number>, p) => {
              const k = p.category && p.category !== "supplier" ? p.category : "supplier";
              m[k] = (m[k] || 0) + p.amount; return m;
            }, {});
            const totalCost = existingPayments.reduce((s, p) => s + p.amount, 0);
            const keys = ["supplier", "freight", "wire_in", "wire_out", "other"].filter((k) => byCat[k]);
            return (
              <div className="text-[11px] text-muted pr-1 space-y-0.5">
                {keys.length > 1 && keys.map((k) => (
                  <div key={k} className="flex justify-end gap-2">
                    <span>{catLabel(k)}</span>
                    <span className="font-medium text-ink-2 tabular-nums w-24 text-right">{fmtAmount(byCat[k])}</span>
                  </div>
                ))}
                <div className="flex justify-end gap-2 border-t border-line pt-0.5 mt-0.5">
                  <span>Total cost</span>
                  <span className="font-semibold text-ink tabular-nums w-24 text-right">{fmtAmount(totalCost)}</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Chooser — pick which kind of cost to add (supplier primary + first) */}
      {!isDone && !showForm && !showCost && (
        <div className="space-y-2">
          <div className="text-[13px] font-semibold text-ink-2">Add a cost to this deal</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button onClick={() => { setShowForm(true); setShowCost(false); }}
              className="flex items-start gap-2.5 p-3 rounded-xl border border-line bg-surface hover:bg-surface-2 hover:border-accent/40 text-left transition-colors">
              <Package size={16} className="text-accent shrink-0 mt-0.5" />
              <div className="min-w-0"><div className="text-[13px] font-medium text-ink">Supplier cost</div><div className="text-[11.5px] text-muted">What you pay for the goods, itemized</div></div>
            </button>
            <button onClick={() => { setShowCost(true); setShowForm(false); }}
              className="flex items-start gap-2.5 p-3 rounded-xl border border-line bg-surface hover:bg-surface-2 hover:border-accent/40 text-left transition-colors">
              <Truck size={16} className="text-accent shrink-0 mt-0.5" />
              <div className="min-w-0"><div className="text-[13px] font-medium text-ink">Freight or fee</div><div className="text-[11.5px] text-muted">Shipping, wire fees, other costs</div></div>
            </button>
          </div>
        </div>
      )}

      {/* Add freight / wire fee / other cost form (categorized → counted in net profit) */}
      {!isDone && showCost && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Truck size={15} className="text-accent" />
            <div className="text-[13px] font-medium text-ink">Freight or fee</div>
          </div>
          <select value={costType} onChange={(e) => setCostType(e.target.value)} className={inp}>
            {COST_CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input type="text" placeholder="Note (optional — e.g. DHL, bank ref)" value={costNote}
            onChange={(e) => setCostNote(e.target.value)} className={inp} />
          <input type="number" inputMode="decimal" placeholder="Amount" value={costAmt}
            onChange={(e) => setCostAmt(e.target.value)} className={inp} />
          <div className="flex gap-2">
            <button onClick={handleAddCost} disabled={saving}
              className="flex-1 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-semibold disabled:opacity-50">Add cost</button>
            <button onClick={() => { setShowCost(false); setCostAmt(""); setCostNote(""); }}
              className="px-4 h-9 rounded-lg border border-line text-[13px] text-muted">Cancel</button>
          </div>
        </div>
      )}

      {/* Supplier form + deposit + mark payment received */}
      {!isDone && (
        <>
          {showForm && (
            <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <Package size={15} className="text-accent" />
                  <div className="text-[13px] font-medium text-ink">Supplier cost</div>
                </div>
                <div className="text-[11.5px] text-muted mt-0.5">Itemized — your cost vs the client quote per line</div>
              </div>

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
                  <div className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-xl
                                  shadow-[0_8px_24px_rgba(0,0,0,0.08)] max-h-40 overflow-y-auto">
                    {suppResults.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => pickSupplier(s)}
                        className="w-full text-left px-4 py-2.5 hover:bg-surface-2 transition-colors first:rounded-t-xl last:rounded-b-xl"
                      >
                        <div className="text-[13px] font-medium text-ink">{s.name}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {s.contact_name && (
                            <span className="text-[11px] text-muted">{s.contact_name}</span>
                          )}
                          {s.payment_method && (
                            <span className="text-[11px] text-muted">· {s.payment_method}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selSupplier && (
                <div className="text-[11px] text-accent bg-accent/10 border border-accent/10 rounded-lg px-3 py-2 space-y-0.5">
                  {selSupplier.contact_name && (
                    <div className="font-medium text-accent-hover">{selSupplier.contact_name}</div>
                  )}
                  {(selSupplier.payment_method || selSupplier.payment_details) && (
                    <div>{selSupplier.payment_method}{selSupplier.payment_details ? ` · ${selSupplier.payment_details}` : ""}</div>
                  )}
                </div>
              )}

              {/* Invoice items with per-item cost inputs */}
              {items.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-[12.5px] font-medium text-muted">Item Costs</div>
                  <div className="rounded-lg border border-line overflow-hidden">
                    {/* Column header */}
                    <div className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-1.5
                                    bg-surface-2 text-[12.5px] font-medium text-muted">
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
                                     border-t border-line-2 items-center"
                        >
                          <span className="text-[12px] text-ink-2 truncate" title={item.description}>
                            {item.description}
                          </span>
                          <span className="text-[12px] text-muted text-center tabular-nums">
                            {item.qty}
                          </span>
                          <span className="text-[12px] text-muted text-right tabular-nums">
                            {fmtAmount(item.clientRate)}
                          </span>
                          {/* My rate input */}
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[11px] pointer-events-none">
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
                              className="w-full border border-line pl-5 pr-1 h-8 rounded-md text-[12px]
                                         text-right focus:outline-none focus:ring-1 focus:ring-accent
                                         focus:border-accent transition-colors tabular-nums"
                            />
                          </div>
                          {/* My total + margin */}
                          <div className="text-right">
                            <div className="text-[12px] font-medium text-ink tabular-nums">
                              {myRate > 0 ? fmtAmount(myTotal) : "—"}
                            </div>
                            {saving_pct !== null && myRate > 0 && (
                              <div className={`text-[10px] tabular-nums ${
                                saving_pct >= 20 ? "text-success-ink"
                                : saving_pct >= 0 ? "text-warning-ink"
                                : "text-danger-ink"
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
                      <div className="flex justify-between items-center px-3 py-2 border-t border-line bg-surface-2/60">
                        <span className="text-[11px] text-muted font-medium">Total supplier cost</span>
                        <span className="text-[12px] font-bold text-ink tabular-nums">
                          {fmtAmount(suppTotal)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* Fallback if invoice has no line items */
                <div className="space-y-2">
                  <div className="text-[12.5px] font-medium text-muted">Amount</div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
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
                      className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px]
                                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleAddSupplier}
                  disabled={saving || !suppName.trim()}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px]
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
                  className="text-[13px] text-muted hover:text-ink-2 px-3 h-9
                             hover:bg-surface-3 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Deposit — a partial up-front payment, separate from the full amount */}
          <div className="rounded-lg border border-line bg-surface p-3">
            <label className="block text-[12.5px] font-medium text-muted mb-1">Deposit received (optional)</label>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                <input
                  type="number" step="0.01" min="0"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  className="border border-line bg-surface text-ink pl-6 pr-3 h-9 rounded-lg text-[13px] w-40 tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                />
              </div>
              {(() => {
                const dep = parseFloat(depositAmount) || 0;
                const total = flow.invoice_total || 0;
                if (dep <= 0) return <span className="text-[11px] text-muted">A partial payment now — the rest stays owed until paid in full</span>;
                if (dep > total + 0.005) return <span className="text-[11px] font-medium text-danger-ink">exceeds invoice {fmtAmount(total)}</span>;
                return <span className="text-[11px] font-medium text-ink-2 tabular-nums">balance owed {fmtAmount(Math.max(0, total - dep))} of {fmtAmount(total)}</span>;
              })()}
              <button
                onClick={handleSaveDeposit}
                disabled={savingDeposit}
                className="flex items-center gap-1.5 border border-line hover:bg-surface-3 text-ink-2 px-3 h-9 rounded-lg text-[12.5px] font-medium disabled:opacity-40 transition-colors"
              >
                {flow.deposit_amount ? "Update deposit" : "Save deposit"}
              </button>
            </div>
          </div>

          {/* Mark payment received */}
          <div className="space-y-2">
            {!hasSuppliers && (
              <div className="flex items-center gap-1.5 text-[12px] text-muted">
                <AlertTriangle size={12} />
                No supplier added — this deal will be recorded as 100% profit (no cost). Add one above if you had a cost.
              </div>
            )}
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Amount received</label>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                  <input
                    type="number" step="0.01" min="0"
                    value={receivedAmount}
                    onChange={(e) => setReceivedAmount(e.target.value)}
                    className="border border-line bg-surface text-ink pl-6 pr-3 h-9 rounded-lg text-[13px] w-40 tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent disabled:opacity-50"
                  />
                </div>
                {(() => {
                  const amt = parseFloat(receivedAmount);
                  const diff = (isNaN(amt) ? 0 : amt) - (flow.invoice_total || 0);
                  if (!isFinite(diff) || Math.abs(diff) < 0.005) return <span className="text-[11px] text-muted">matches invoice {fmtAmount(flow.invoice_total)}</span>;
                  return <span className={`text-[11px] font-medium ${diff < 0 ? "text-danger-ink" : "text-success-ink"}`}>{diff < 0 ? "−" : "+"}{fmtAmount(Math.abs(diff))} vs invoice {fmtAmount(flow.invoice_total)}</span>;
                })()}
              </div>
            </div>
            <button
              onClick={handleMarkReceived}
              disabled={saving}
              className="flex items-center gap-2 bg-success hover:opacity-90 text-on-accent
                         px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-all"
            >
              <DollarSign size={14} /> Mark payment received
            </button>
          </div>
        </>
      )}

      {/* Completed state */}
      {isDone && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[13px] text-success-ink font-medium">
            <CheckCircle2 size={14} />
            {fmtAmount(flow.payment_received_amount)} received
          </div>
          <button
            onClick={handleUndo}
            disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-warning-ink hover:text-warning-ink
                       px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors"
          >
            <RotateCcw size={11} /> Undo payment
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Panel 3: Mark Supplier Paid ─────────────────────────────────────────
function PanelSupplierPaid({ flow, onReload, onGoToComplete }: { flow: DealFlow; onReload: () => void; onGoToComplete: () => void }) {
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
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  // Undo: unmark all paid
  const unmarkAll = async () => {
    setSaving(true);
    try {
      const paid = payments.filter((p) => p.paid);
      await Promise.all(paid.map((p) => api.unmarkSupplierPaymentPaid(flow.id, p.id)));
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <SectionLabel>Supplier Payments</SectionLabel>

      {payments.length === 0 ? (
        <div className="space-y-2.5">
          <p className="text-[12px] text-muted">
            No supplier cost on this deal — nothing to pay. Continue to record it as 100% profit.
          </p>
          <button
            onClick={onGoToComplete}
            className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-on-accent
                       px-5 h-9 rounded-lg text-[13px] font-medium transition-colors w-full justify-center"
          >
            <Check size={14} strokeWidth={2.5} /> Continue to Complete
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Cost breakdown — read-only, shows what was entered per item */}
          <div className="rounded-lg border border-line overflow-hidden bg-surface">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-line-2 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1.5">
                  {p.supplier_name}
                  {p.category && p.category !== "supplier" && (
                    <span className="text-[9px] font-bold uppercase tracking-wide text-accent bg-accent/10 border border-accent/20 px-1.5 py-0.5 rounded flex-shrink-0">{catLabel(p.category)}</span>
                  )}
                </div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-muted tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                  {p.method && <div className="text-[11px] text-muted">{p.method}</div>}
                  {p.price_changed && p.original_amount != null && (
                    <div className="flex items-center gap-1 text-[11px] text-warning-ink mt-0.5">
                      <AlertTriangle size={10} />
                      Price changed: {fmtAmount(p.original_amount)} → {fmtAmount(p.amount)}
                    </div>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-ink tabular-nums">
                  {fmtAmount(p.amount)}
                </div>
              </div>
            ))}
            <div className="flex justify-between items-center px-3 py-2 bg-surface-2/60 border-t border-line">
              <span className="text-[11px] text-muted font-medium">Total supplier cost</span>
              <span className="text-[13px] font-bold text-ink tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>

          {/* Single action: mark everything paid at once */}
          {!isDone && (
            allPaid ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] text-success-ink font-medium">
                  <CheckCircle2 size={14} />
                  All supplier payments marked paid
                </div>
                <button
                  onClick={unmarkAll}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-[12px] text-warning-ink hover:text-warning-ink
                             px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors"
                >
                  <RotateCcw size={11} /> Undo suppliers paid
                </button>
              </div>
            ) : (
              <button
                onClick={markAllPaid}
                disabled={saving || payments.length === 0}
                className="flex items-center gap-2 bg-accent hover:bg-accent text-on-accent
                           px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors w-full justify-center"
              >
                <Check size={14} strokeWidth={2.5} />
                Mark Supplier Paid — {fmtAmount(flow.total_supplier_cost)}
              </button>
            )
          )}

          {isDone && (
            <div className="flex items-center gap-2 text-[13px] text-success-ink font-medium">
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
  const [recipients,   setRecipients]   = useState<PayoutShare[]>([]);
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
  // Default = apply the configured split. The old default (false) silently routed
  // 100% of every completed deal to the business share, burying the user's split.
  const [payoutIncluded, setPayoutIncluded] = useState(true);

  useEffect(() => { api.getPayoutSplit().then(setRecipients).catch(() => {}); }, []);

  const canComplete = flow.stage === "payment_received" || flow.stage === "supplier_paid";
  const isComplete  = flow.stage === "complete";
  const gross  = isComplete ? flow.gross_revenue       : flow.payment_received_amount;
  const cost   = isComplete ? flow.total_cost          : flow.total_supplier_cost;
  const profit = gross - cost;

  const runComplete = async () => {
    setSaving(true);
    try {
      const result = await api.completeDealFlow(flow.id, "none", completedDate || null, payoutIncluded);
      if (result.is_loss && result.warning) toast(result.warning, "error");
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
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
      await api.completeDealFlow(flow.id, "none", completedDate || null, payoutIncluded);
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleUndo = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <SectionLabel>Deal Summary</SectionLabel>

      {/* P&L grid + profit split (shared with Invoice detail) */}
      <CostProfitPanel flow={flow} recipients={recipients} />

      {/* ── Complete action area ── */}
      {canComplete && shipHold === "idle" && (
        <div className="space-y-2">
          {/* Completion date — defaults to today, can be backdated for backlog */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted whitespace-nowrap">Completed date</label>
            <input
              type="date"
              value={completedDate}
              max={todayStr}
              onChange={(e) => setCompletedDate(e.target.value)}
              className="flex-1 border border-line px-2.5 h-8 rounded-lg text-[12px] bg-surface
                         focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
          </div>
          {/* Explicit payout decision — the old tiny checkbox defaulted everything to
              business-keeps-all without the user noticing. */}
          <div className="py-1 space-y-1">
            <div className="text-[11px] text-muted">Where does this deal's profit go?</div>
            <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
              <button type="button" onClick={() => setPayoutIncluded(true)}
                className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                Apply profit split
              </button>
              <button type="button" onClick={() => setPayoutIncluded(false)}
                className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${!payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                Business keeps 100%
              </button>
            </div>
          </div>
          <button
            onClick={handleCompleteClick}
            disabled={saving}
            className="w-full bg-accent hover:bg-accent-hover text-on-accent h-10 rounded-lg
                       text-[14px] font-medium disabled:opacity-40 transition-colors"
          >
            Complete deal
          </button>
        </div>
      )}

      {/* Step A: shipping question */}
      {canComplete && shipHold === "asking" && (
        <div className="bg-warning-bg border border-warning rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-ink">
            <Truck size={15} className="text-warning-ink" />
            Does this deal require shipping?
          </div>
          <p className="text-[12px] text-warning-ink">
            If items are being shipped, hold here and track the shipment before closing out.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShipHold("shipping")}
              className="flex items-center gap-1.5 bg-warning hover:opacity-90 text-on-accent
                         px-4 h-9 rounded-lg text-[13px] font-medium transition-all"
            >
              <Truck size={13} /> Yes, track shipping
            </button>
            <button
              onClick={handleCompleteNow}
              disabled={saving}
              className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent
                         px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"
            >
              <Check size={13} /> No, complete now
            </button>
            <button
              onClick={() => setShipHold("idle")}
              className="text-[13px] text-muted hover:text-ink-2 px-3 h-9
                         hover:bg-surface-3 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step B: shipping form — hold until confirmed */}
      {canComplete && shipHold === "shipping" && (
        <div className="bg-surface border border-warning rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-warning-ink" />
            <span className="text-[13px] font-semibold text-ink">Shipping hold</span>
            <span className="ml-auto text-[11px] text-warning-ink bg-warning-bg border border-warning
                             px-2 py-0.5 rounded-full font-medium">
              Awaiting delivery
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted font-medium mb-1">Carrier</label>
              <input
                className={inp}
                placeholder="FedEx, UPS…"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-muted font-medium mb-1">Tracking #</label>
              <input
                className={inp}
                placeholder="Tracking number"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-muted font-medium mb-1">Pickup date</label>
              <input
                type="date"
                className={inp}
                value={pickupDate}
                onChange={(e) => setPickupDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] text-muted font-medium mb-1">Delivery date</label>
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
              className="flex items-center gap-1.5 bg-success hover:opacity-90 text-on-accent
                         px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-all"
            >
              <Check size={13} /> Confirm delivery & complete
            </button>
            <button
              onClick={() => setShipHold("idle")}
              className="text-[13px] text-muted hover:text-ink-2 px-3 h-9
                         hover:bg-surface-3 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Completed state */}
      {isComplete && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[12px] text-success-ink font-medium">
            <CheckCircle2 size={13} />
            Completed{flow.completed_at
              ? ` ${new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
              : ""}
          </div>
          <button
            onClick={handleUndo}
            disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-warning-ink hover:text-warning-ink
                       px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors"
          >
            <RotateCcw size={11} /> Undo Complete
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-semibold text-ink-2 mb-0.5">
      {children}
    </div>
  );
}
