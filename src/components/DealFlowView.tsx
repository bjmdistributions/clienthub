import { useEffect, useState, useCallback } from "react";
import {
  Check, ChevronDown, ChevronRight, Search, Plus, X,
  AlertTriangle, RotateCcw, RefreshCw, Trash2,
  DollarSign, CheckCircle2, Truck, Package, FileDown, XCircle,
} from "lucide-react";
import {
  api, DealFlow, SupplierPayment, Invoice, Supplier, PayoutShare, dealPayoutSplit,
} from "../lib/api";
import { fmtAmount, primarySupplierLabel } from "../lib/format";
import { toast } from "./Toast";
import ReconciliationPanel from "./ReconciliationPanel";
import RefundWorkspace from "./RefundWorkspace";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

// ─── helpers ──────────────────────────────────────────────────────────────
function parseAmt(v: string): number { return parseFloat(v.replace(/,/g, "")) || 0; }

const STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"] as const;
type Stage = typeof STAGES[number];
function si(s: string): number { return STAGES.indexOf(s as Stage); }

const NODE_LABELS: Record<Stage, string> = {
  invoiced:         "Invoiced",
  payment_received: "Cost & payment",
  supplier_paid:    "Supplier paid",
  complete:         "Review & complete",
};

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
  const [syncing,      setSyncing]      = useState(false);
  const [recon, setRecon] = useState<Record<string, { payment_received_paired: boolean; supplier_paid_paired: boolean; fully_reconciled: boolean; has_payment: boolean; has_financials: boolean; no_buyer_link: boolean; no_supplier_link: boolean; needs_financials: boolean; buyer_missing: boolean; supplier_missing: boolean; needs_review: boolean }>>({});
  // Refund mode per deal (refund_owed > 0 OR any refund recorded), at any stage.
  const [refundMap, setRefundMap] = useState<Record<string, { refund_owed: number; refunded: number; remaining: number; done: boolean }>>({});
  // Open by default — refunds are money owed back, not an archive to go looking for.
  const [refundsOpen, setRefundsOpen] = useState(true);
  const [showDoneRefunds, setShowDoneRefunds] = useState(false);
  const [expandedRefund, setExpandedRefund] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let [f, inv, reconList, refundList] = await Promise.all([
        api.listDealFlows(), api.listInvoices(), api.reconciliationStatusAll().catch(() => []),
        api.refundStatusAll().catch(() => []),
      ]);
      setRecon(Object.fromEntries(reconList.map((r) => [r.deal_flow_id, r])));
      setRefundMap(Object.fromEntries(refundList.map((r) => [r.deal_flow_id, r])));

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

  // Self-heal: re-point payments stranded on duplicate deal_flow rows, then archive
  // the duplicate/orphan rows themselves so no aggregate counts them. Idempotent.
  useEffect(() => {
    api.cleanupGhostDealFlows().then((n) => { if (n > 0) load(); }).catch(() => {});
    // NOTE: cleanupOrphanAllocations is deliberately NOT run here any more. It DELETES
    // bank_allocation rows org-wide with no recovery copy and then rewrites the deal's
    // recorded profit — far too destructive to fire from merely opening a screen, and
    // it ran on every mount. The allocations it targets point at a transaction that is
    // currently missing, which is often temporary (a re-import in progress, a sync that
    // has not landed yet), so "clean" could mean "throw away the only record of which
    // deal a payment belonged to" the moment a page was opened. Every money SUM is
    // already guarded with EXISTS(bank_txn), so a stale link cannot inflate a figure —
    // it is untidy, not dangerous, and tidying it is a deliberate act, not a side
    // effect. Same reasoning removed the over-allocation healer from Financials.
  }, [load]);

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

  // ANY deal with refund activity is a refund, not an active pipeline deal — it lives
  // in the Refunds section (even fully-refunded, until marked fully done) and never
  // shows in the active list.
  const active    = flows.filter(
    (f) => f.stage !== "complete" && !refundMap[f.id] && isInvoiceActive(f) && matchFl(f)
  );
  const completed = flows.filter((f) => f.stage === "complete");
  // Completed deals, most recent completion first, so the list always reads top-down
  // by date. Missing dates sort last.
  const completedFiltered = completed.filter(matchFl).sort((a, b) => {
    const ta = a.completed_at ? Date.parse(a.completed_at) : 0;
    const tb = b.completed_at ? Date.parse(b.completed_at) : 0;
    return tb - ta;
  });
  const totalCompleted    = completed.length;
  // A completed deal "needs review" when a money leg has no linked bank transaction
  // and hasn't been marked "no record" — so we flag exactly which side is missing.
  const needsWorkCount    = completed.filter((f) => recon[f.id]?.needs_review).length;

  // Refunds section: everything with refund activity, most-owed first — active refunds
  // AND fully-refunded ones (so a fully-refunded deal stays here, not in the pipeline),
  // until it's marked "fully done". "Show done" reveals the closed-out ones.
  //
  // "Done" means done AND nothing left owed. The flag was written once and never
  // re-checked against the numbers, so a refund closed out while it looked settled —
  // then given a higher refund_owed, or whose refund payment later vanished — stopped
  // being anyone's problem while money was still owed. It comes back to the open list.
  const isRefundDone = (id: string) => !!refundMap[id]?.done && refundMap[id].remaining <= 0.01;
  // The whole drawer is keyed off every refunded deal, never the filtered list: "Show
  // done" lives INSIDE it, so gating on the filtered list meant closing out the last
  // open refund deleted the only way back to any of them.
  const refundAll   = flows.filter((f) => refundMap[f.id]);
  const refundFlows = refundAll
    .filter((f) => showDoneRefunds || !isRefundDone(f.id))
    .sort((a, b) => refundMap[b.id].remaining - refundMap[a.id].remaining);
  const doneRefundCount = refundAll.filter((f) => isRefundDone(f.id)).length;

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

  const syncCompleted = async () => {
    setSyncing(true);
    try {
      const n = await api.resyncAllCompletedDeals();
      toast(`Synced ${n} completed deal${n !== 1 ? "s" : ""} from bank — numbers and dates updated`);
      await load();
    } catch (e: any) { toast(String(e), "error"); }
    setSyncing(false);
  };

  const handleExportDealFlows = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "deal-flows.csv" });
    if (!path) return;
    const count = await api.exportDealFlowsCsv(path as string);
    toast(`Exported ${count} deal flow${count !== 1 ? "s" : ""} to CSV`);
  };

  return (
    <div className="space-y-5">
      <style>{`
        @keyframes dfIn  { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
        @keyframes dfPop { 0% { transform: scale(.55); } 55% { transform: scale(1.2); } 100% { transform: scale(1); } }
        .df-anim { animation: dfIn .18s ease-out; }
        .df-pop  { animation: dfPop .5s cubic-bezier(.2,.7,.3,1.4); }
        @media (prefers-reduced-motion: reduce) { .df-anim, .df-pop { animation: none !important; } }
      `}</style>

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
          <div className="w-full flex items-center justify-between px-5 py-3.5">
            <button onClick={() => setDrawerOpen(!drawerOpen)} className="flex items-center gap-2.5 text-left min-w-0">
              <CheckCircle2 size={14} className="text-success-ink flex-shrink-0" />
              <span className="text-[13px] font-semibold text-ink">Completed deals</span>
              <span className="text-[11px] font-medium text-muted bg-surface-3 px-2 py-0.5 rounded-full">{totalCompleted}</span>
              {needsWorkCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-ink bg-warning-bg px-2 py-0.5 rounded-full">
                  <AlertTriangle size={10} /> {needsWorkCount} need review
                </span>
              )}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={syncCompleted} disabled={syncing}
                className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 px-2.5 h-8 rounded-lg hover:bg-surface-3 disabled:opacity-50 transition-colors"
                title="Re-pull recorded numbers from the bank and date each completed deal to when the supplier was actually paid">
                <RefreshCw size={13} className={syncing ? "animate-spin" : ""} /> Sync from bank
              </button>
              <button onClick={() => setDrawerOpen(!drawerOpen)} className="p-1 rounded-lg hover:bg-surface-3 transition-colors">
                <ChevronDown size={14} className={`text-muted transition-transform duration-200 ${drawerOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
          </div>
          {drawerOpen && (
            <div className="border-t border-line p-4 space-y-4">
              {completedFiltered.length === 0 ? (
                <p className="text-[12px] text-faint text-center py-8">
                  {search ? "No completed deals match your search" : "No completed deals yet"}
                </p>
              ) : (
                completedFiltered.map((flow, i) => (
                  <DealFlowCard key={flow.id} flow={flow} onReload={load} refund={refundMap[flow.id]} zebra={i % 2 === 1} reconStatus={recon[flow.id]} />
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Refunds drawer ──────────────────────────────────────────────── */}
      {refundAll.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          {/* Drawer header */}
          <div className="w-full flex items-center justify-between px-5 py-3.5">
            <button onClick={() => setRefundsOpen(!refundsOpen)} className="flex items-center gap-2.5 text-left min-w-0">
              <RotateCcw size={14} className="text-danger-ink flex-shrink-0" />
              <span className="text-[13px] font-semibold text-ink">Refunds</span>
              <span className="text-[11px] font-medium text-muted bg-surface-3 px-2 py-0.5 rounded-full">{refundFlows.length}</span>
            </button>
            <div className="flex items-center gap-2">
              {doneRefundCount > 0 && (
                <button onClick={() => setShowDoneRefunds((v) => !v)}
                  className={`text-[11.5px] font-medium px-2.5 h-8 rounded-lg border transition-colors ${showDoneRefunds ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink-2"}`}>
                  {showDoneRefunds ? "Hide done" : `Show done (${doneRefundCount})`}
                </button>
              )}
              <button onClick={() => setRefundsOpen(!refundsOpen)} className="p-1 rounded-lg hover:bg-surface-3 transition-colors">
                <ChevronDown size={14} className={`text-muted transition-transform duration-200 ${refundsOpen ? "rotate-180" : ""}`} />
              </button>
            </div>
          </div>

          {/* Drawer body */}
          {refundsOpen && (
            <div className="border-t border-line divide-y divide-line-2">
              {refundFlows.length === 0 && (
                <div className="px-5 py-6 text-[12.5px] text-muted">
                  {doneRefundCount > 0 ? (
                    <>
                      {/* Booking the last refund payment closes the deal out, which hides
                          it — so the drawer looked empty right after the work landed.
                          Name the count and make the way back a button, not a hint. */}
                      Every refund is closed out —{" "}
                      <button
                        onClick={() => setShowDoneRefunds(true)}
                        className="font-medium text-accent hover:text-accent-hover"
                      >
                        show {doneRefundCount} closed refund{doneRefundCount === 1 ? "" : "s"}
                      </button>
                      .
                    </>
                  ) : (
                    "No refunds on any deal."
                  )}
                </div>
              )}
              {refundFlows.map((flow) => {
                const r = refundMap[flow.id];
                const isExp = expandedRefund === flow.id;
                const fullyRefunded = r.remaining <= 0.01;
                const done = isRefundDone(flow.id);
                // Marked done, but the numbers moved since — say so instead of hiding it.
                const staleDone = r.done && !fullyRefunded;
                return (
                  <div key={flow.id} className={done ? "opacity-60" : ""}>
                    <button
                      onClick={() => setExpandedRefund(isExp ? null : flow.id)}
                      className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-2/40 cursor-pointer transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink truncate">{flow.client_name || "—"}</div>
                        <div className="text-[11px] text-muted mt-0.5 truncate">{flow.invoice_number || "—"}</div>
                        {staleDone && (
                          <div className="text-[11px] text-warning-ink mt-1 inline-flex items-center gap-1">
                            <AlertTriangle size={11} /> Was marked fully done, but {fmtAmount(r.remaining)} is still owed
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-5 flex-shrink-0">
                        <Stat label="Owed" value={fmtAmount(r.refund_owed)} />
                        <Stat label="Refunded" value={fmtAmount(r.refunded)} />
                        <div className="text-right">
                          <div className="text-[12px] font-medium text-muted">Remaining</div>
                          {fullyRefunded ? (
                            <div className="text-[13px] font-bold tabular-nums text-danger-ink">Fully refunded</div>
                          ) : (
                            <div className="text-[13px] font-semibold tabular-nums text-danger-ink">{fmtAmount(r.remaining)}</div>
                          )}
                        </div>
                        {/* Mark fully done / reopen — only once there's nothing left owed */}
                        {fullyRefunded && (done ? (
                          <span className="inline-flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-[10.5px] font-semibold text-success-ink inline-flex items-center gap-1"><CheckCircle2 size={11} /> Done</span>
                            <span role="button" tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); api.setRefundDone(flow.id, false).then(() => { toast("Refund reopened"); load(); }).catch((err) => toast(String(err), "error")); }}
                              className="text-[11px] text-muted hover:text-ink-2 px-2 h-7 flex items-center rounded-lg border border-line transition-colors">Reopen</span>
                          </span>
                        ) : (
                          <span role="button" tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); api.setRefundDone(flow.id, true).then(() => { toast("Marked fully done"); load(); }).catch((err) => toast(String(err), "error")); }}
                            className="text-[11px] font-medium text-success-ink hover:bg-success-bg px-2.5 h-7 flex items-center gap-1 rounded-lg border border-success/40 flex-shrink-0 transition-colors">
                            <Check size={12} /> Mark fully done
                          </span>
                        ))}
                        <ChevronDown size={14} className={`text-muted transition-transform duration-200 ${isExp ? "rotate-180" : ""}`} />
                      </div>
                    </button>
                    {isExp && (
                      <div className="px-5 pb-4 pt-1 bg-surface-2/30">
                        <RefundWorkspace dealFlowId={flow.id} primary onChange={load} />
                      </div>
                    )}
                  </div>
                );
              })}
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
              refund={refundMap[flow.id]}
              zebra={i % 2 === 1}
              reconStatus={recon[flow.id]}
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

// ─── Section model ────────────────────────────────────────────────────────
// Five focused steps. The DB keeps its four stages; these sections just present
// them (plus the bank-linking + profit review) one screen at a time.
const SECTIONS = [
  { key: "supplier", label: "Supplier & cost" },
  { key: "money",    label: "Money movement" },
  { key: "link",     label: "Link financials" },
  { key: "profit",   label: "Profit" },
  { key: "complete", label: "Review & complete" },
] as const;
type SectionKey = typeof SECTIONS[number]["key"];
const sIdx = (k: SectionKey) => SECTIONS.findIndex((s) => s.key === k);

function DealFlowCard({
  flow, onReload, zebra, refund, reconStatus,
}: { flow: DealFlow; onReload: () => void; zebra: boolean; refund?: { refund_owed: number; refunded: number; remaining: number }; reconStatus?: { needs_financials: boolean; has_financials: boolean; fully_reconciled: boolean; buyer_missing: boolean; supplier_missing: boolean; needs_review: boolean } }) {
  const [isOpen,    setIsOpen]    = useState(false); // collapsed by default
  const [refundOverride, setRefundOverride] = useState<boolean | null>(null);
  const refundView = refundOverride ?? !!refund;
  const [invStatus, setInvStatus] = useState<string | undefined>(undefined);
  const [invItems,  setInvItems]  = useState<{ description: string; qty: number; rate: number; amount: number }[]>([]);
  const [invMeta,   setInvMeta]   = useState<{ subtotal: number; tax: number; total: number; number: string } | null>(null);
  const [showInvoice, setShowInvoice] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [reconLinked, setReconLinked] = useState(false);

  // Derived section-completion from the deal's real state.
  const payments      = flow.supplier_payments || [];
  const hasSuppliers  = payments.length > 0;
  const received      = si(flow.stage) >= si("payment_received");
  const suppliersPaid = hasSuppliers ? payments.every((p) => p.paid || p.kept) : true; // nothing to send → satisfied
  const moneyDone     = received && suppliersPaid;
  const isComplete    = flow.stage === "complete";
  const supplierDone  = hasSuppliers || si(flow.stage) > si("invoiced") || received;

  // `reconStatus` comes from the list-level fetch and covers EVERY live deal, so the
  // dots are right on a collapsed card. `reconLinked` is this card's own fetch, which
  // only runs once opened — it's OR'd in so pairing inside the card fills the dot
  // straight away instead of waiting for a reload.
  const hasLinks = !!reconStatus?.has_financials || reconLinked;

  const done: Record<SectionKey, boolean> = {
    supplier: supplierDone,
    money:    moneyDone,
    // The link dot fills only when there's nothing left to link — every money leg
    // that's owed is either paired to the bank or explicitly marked "no record"
    // (reconStatus.needs_review === false). Being complete is NOT enough on its own:
    // you can complete now and reconcile later, and the dot must stay empty until you do.
    link:     isComplete ? (!!reconStatus && !reconStatus.needs_review) : hasLinks,
    profit:   hasLinks || isComplete,
    complete: isComplete,
  };

  const firstOpen = (): SectionKey => {
    if (isComplete) return "complete";
    if (!supplierDone) return "supplier";
    if (!moneyDone) return "money";
    return "link";
  };
  const [section, setSection] = useState<SectionKey>(firstOpen);
  const [animKey, setAnimKey] = useState(0);
  const [flash,   setFlash]   = useState<SectionKey | null>(null);

  const go = (k: SectionKey) => { setSection(k); setAnimKey((a) => a + 1); };
  // Advance to the next section with a little "step complete" flourish.
  const advance = (from: SectionKey) => {
    const next = SECTIONS[Math.min(sIdx(from) + 1, SECTIONS.length - 1)].key;
    setFlash(from);
    setTimeout(() => setFlash(null), 550);
    go(next);
  };

  // When the deal's stage changes underneath us, keep the view on a sensible step.
  useEffect(() => { setSection(firstOpen()); /* eslint-disable-next-line */ }, [flow.stage]);

  // Fetch invoice status + line items for the header / breakdown.
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

  // Know whether any bank transaction is linked, so the Link/Profit steps show as done.
  useEffect(() => {
    if (!isOpen) return;
    api.dealReconciliation(flow.id)
      .then((r) => {
        const p = r?.pieces;
        setReconLinked(!!p && ((p.buyer_paired || 0) + (p.supplier_paired || 0) + (p.fee_paired || 0) + (p.refund_total || 0) + (p.refund_in || 0) > 0.005));
      })
      .catch(() => {});
  }, [flow.id, isOpen, flow.stage]);

  const stagePill: Record<Stage, string> = {
    invoiced:         "bg-info-bg text-info-ink",
    payment_received: "bg-warning-bg text-warning-ink",
    supplier_paid:    "bg-accent/10 text-accent",
    complete:         "bg-success-bg text-success-ink",
  };
  const invPill = invoiceStatusPill(invStatus);
  const locked  = isComplete && !editMode; // completed deals are read-only until "Edit" is pressed

  return (
    <div
      className={`border border-line rounded-xl shadow-[0_1px_4px_rgba(0,0,0,0.05)] overflow-hidden ${zebra ? "bg-surface-2/40" : "bg-surface"}`}
    >
      {/* ── Collapsed header ── */}
      <button
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-surface-2/40 transition-colors"
        onClick={() => setIsOpen((v) => !v)}
      >
        {/* Section progress dots */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {SECTIONS.map((s) => (
            <div
              key={s.key}
              className={`rounded-full transition-all ${
                done[s.key] ? "w-2.5 h-2.5 bg-accent"
                : s.key === section && isOpen ? "w-2.5 h-2.5 bg-accent ring-2 ring-accent/20 ring-offset-1"
                : "w-2 h-2 bg-surface-3"
              }`}
            />
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[12px] font-mono text-muted flex-shrink-0">{flow.invoice_number}</span>
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

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[13px] font-semibold text-ink-2 tabular-nums">{fmtAmount(flow.invoice_total)}</span>
            {!isComplete && (() => {
              const proj = flow.invoice_total - flow.total_supplier_cost;
              return (
                <span className={`text-[11px] font-semibold tabular-nums ${proj >= 0 ? "text-success-ink" : "text-danger-ink"}`}
                  title="Projected profit — revenue minus supplier costs entered so far">
                  {fmtAmount(proj)} <span className="text-[8px] text-muted uppercase">proj</span>
                </span>
              );
            })()}
            {isComplete && (() => {
              const mgn = flow.gross_revenue > 0 ? (flow.net_profit / flow.gross_revenue) * 100 : 0;
              return (
                <span className={`text-[11px] font-semibold tabular-nums ${flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}
                  title="Recorded profit · margin (net profit ÷ revenue)">
                  {fmtAmount(flow.net_profit)} <span className="text-[8px] text-muted uppercase">{mgn.toFixed(0)}% mgn</span>
                </span>
              );
            })()}
          </div>
          <span className={`text-[12.5px] font-medium px-2 py-0.5 rounded-full ${invPill.cls}`}>{invPill.label}</span>
          {flow.stage !== "invoiced" && !isComplete && (
            <span className={`text-[12.5px] font-medium px-2 py-0.5 rounded-full ${stagePill[flow.stage as Stage]}`}>
              {NODE_LABELS[flow.stage as Stage]}
            </span>
          )}
          {/* Completed deals: date + which payment link (if any) is potentially missing */}
          {isComplete && flow.completed_at && (
            <span className="text-[11.5px] text-muted tabular-nums flex-shrink-0">
              {new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
          {isComplete && reconStatus?.needs_review && (
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-full bg-warning-bg text-warning-ink flex-shrink-0">
              <AlertTriangle size={10} />
              {reconStatus.buyer_missing && reconStatus.supplier_missing ? "Missing links"
                : reconStatus.buyer_missing ? "Missing buyer payment"
                : "Missing supplier payment"}
            </span>
          )}
          {isComplete && reconStatus && !reconStatus.needs_review && reconStatus.fully_reconciled && (
            <span className="inline-flex items-center gap-1 text-[11.5px] font-medium px-2 py-0.5 rounded-full bg-success-bg text-success-ink flex-shrink-0">
              <CheckCircle2 size={10} /> Reconciled
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setIsOpen(true); setRefundOverride(!refundView); }}
            className={refund
              ? "text-[12.5px] font-medium px-2 py-0.5 rounded-full bg-danger-bg text-danger-ink inline-flex items-center gap-1 flex-shrink-0 hover:opacity-90 transition-opacity"
              : "text-[11.5px] font-medium px-2 py-0.5 rounded-full border border-line text-muted hover:text-danger-ink hover:border-danger inline-flex items-center gap-1 flex-shrink-0 transition-colors"}
          >
            <RotateCcw size={11} />
            {refundView ? "Back to deal" : refund ? (refund.remaining > 0 ? `Refund mode · ${fmtAmount(refund.remaining)} left` : "Refunded") : "Refund"}
          </button>
          <ChevronDown size={14} className={`text-muted transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* ── Expanded body ── */}
      {isOpen && (
        <>
          {refund && refund.refund_owed > 0 && refund.remaining === 0 && (
            <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg bg-danger-bg border border-danger px-4 py-3">
              <RotateCcw size={18} className="text-danger-ink flex-shrink-0" strokeWidth={2.2} />
              <span className="text-[15px] font-bold text-danger-ink">Fully refunded</span>
              <span className="ml-auto text-[12px] text-danger-ink tabular-nums">{fmtAmount(refund.refunded)} refunded</span>
            </div>
          )}

          {refundView ? (
            <div className="border-t border-line bg-surface-2 px-5 py-4">
              <RefundWorkspace dealFlowId={flow.id} primary onChange={onReload} />
            </div>
          ) : (
            <>
              {/* Section switcher — always visible, click any step */}
              <div className="border-t border-line">
                <SectionNav current={section} done={done} flash={flash} onGo={go} />
              </div>

              {/* Completed banner + edit toggle */}
              {isComplete && (
                <div className="mx-5 mt-1 mb-1 flex items-center justify-between gap-2 rounded-lg bg-success-bg/60 border border-success/30 px-3 py-2">
                  <div className="flex items-center gap-2 text-[12px] text-success-ink font-medium">
                    <CheckCircle2 size={13} />
                    Completed{flow.completed_at ? ` ${new Date(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""} — every section stays editable
                  </div>
                  <button
                    onClick={() => setEditMode((v) => !v)}
                    className={`text-[11.5px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${editMode ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink-2"}`}
                  >
                    {editMode ? "Done editing" : "Edit"}
                  </button>
                </div>
              )}

              {/* Invoice breakdown — reference, collapsed by default */}
              {invItems.length > 0 && (
                <div className="px-5 pt-2">
                  <button onClick={() => setShowInvoice((v) => !v)}
                    className="flex items-center gap-1.5 text-[11.5px] text-muted hover:text-ink-2 transition-colors">
                    <ChevronRight size={12} className={`transition-transform ${showInvoice ? "rotate-90" : ""}`} />
                    Invoice breakdown{invMeta?.number ? ` · ${invMeta.number}` : ""}
                  </button>
                  {showInvoice && (
                    <table className="w-full text-[12px] mt-2">
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
                  )}
                </div>
              )}

              {/* Active section body */}
              <div className="border-t border-line bg-surface-2 px-5 py-4">
                <div key={animKey} className="df-anim">
                  {section === "supplier" && <SectionSupplier flow={flow} onReload={onReload} onAdvance={() => advance("supplier")} locked={locked} />}
                  {section === "money"    && <SectionMoney    flow={flow} onReload={onReload} onAdvance={() => advance("money")} locked={locked} />}
                  {section === "link"     && <SectionLink     flow={flow} onReload={onReload} onAdvance={() => advance("link")} />}
                  {section === "profit"   && <SectionProfit   flow={flow} onAdvance={() => advance("profit")} />}
                  {section === "complete" && <PanelComplete   flow={flow} onReload={onReload} />}
                </div>

                {/* Row actions */}
                <div className="flex justify-end gap-1.5 mt-4 pt-3 border-t border-line-2">
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
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Section switcher ──
function SectionNav({ current, done, flash, onGo }: {
  current: SectionKey; done: Record<SectionKey, boolean>; flash: SectionKey | null; onGo: (k: SectionKey) => void;
}) {
  return (
    <div className="flex items-center px-4 py-3 overflow-x-auto">
      {SECTIONS.map((s, i) => {
        const isCur  = s.key === current;
        const isDone = done[s.key];
        return (
          <div key={s.key} className="flex items-center flex-shrink-0">
            <button
              onClick={() => onGo(s.key)}
              className={`flex items-center gap-2 h-9 px-3 rounded-lg text-[12px] font-semibold transition-all ${
                isCur ? "bg-accent/10 text-accent ring-1 ring-accent/25" : isDone ? "text-ink-2 hover:bg-surface-3" : "text-muted hover:bg-surface-3"
              }`}
            >
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${flash === s.key ? "df-pop " : ""}${
                isDone ? "bg-accent text-on-accent" : isCur ? "bg-accent/15 text-accent ring-1 ring-accent/40" : "bg-surface-3 text-faint"
              }`}>
                {isDone ? <Check size={13} strokeWidth={2.6} /> : i + 1}
              </span>
              <span className="hidden sm:block whitespace-nowrap">{s.label}</span>
            </button>
            {i < SECTIONS.length - 1 && (
              <div className={`w-4 h-[2px] mx-0.5 rounded-full flex-shrink-0 ${isDone ? "bg-accent/50" : "bg-surface-3"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Section 1: Supplier & cost ───────────────────────────────────────────
function SectionSupplier({ flow, onReload, onAdvance, locked }: { flow: DealFlow; onReload: () => void; onAdvance: () => void; locked: boolean }) {
  const [suppName,    setSuppName]    = useState("");
  const [suppResults, setSuppResults] = useState<Supplier[]>([]);
  const [selSupplier, setSelSupplier] = useState<Supplier | null>(null);
  const [items, setItems] = useState<{ description: string; qty: number; clientRate: number; myRate: string }[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [costType, setCostType] = useState("freight");
  const [costAmt,  setCostAmt]  = useState("");
  const [costNote, setCostNote] = useState("");

  useEffect(() => {
    api.getInvoice(flow.invoice_id).then((inv) => {
      try {
        const li: any[] = JSON.parse(inv.line_items_json || "[]");
        setItems(li.map((it) => ({ description: it.description, qty: it.qty, clientRate: it.rate, myRate: "" })));
      } catch {}
    }).catch(() => {});
  }, [flow.invoice_id]);

  useEffect(() => {
    if (!suppName || selSupplier?.name === suppName) { setSuppResults([]); return; }
    const t = setTimeout(() => api.searchSuppliers(suppName).then(setSuppResults).catch(() => setSuppResults([])), 250);
    return () => clearTimeout(t);
  }, [suppName, selSupplier?.name]);

  const existingPayments = flow.supplier_payments || [];
  const anyRateEntered   = items.some((it) => parseAmt(it.myRate) > 0);
  const suppTotal        = items.reduce((s, it) => s + it.qty * parseAmt(it.myRate), 0);
  const totalCost        = existingPayments.reduce((s, p) => s + p.amount, 0);

  const pickSupplier = (s: Supplier) => { setSelSupplier(s); setSuppName(s.name); setSuppResults([]); };

  const handleAddSupplier = async () => {
    if (!suppName.trim()) return;
    const filledItems = items.filter((it) => parseAmt(it.myRate) > 0);
    const zeroCost = filledItems.length === 0;
    if (zeroCost && !confirm("Submit $0 as the supplier cost for this deal? Your profit will equal the full revenue. Are you sure?")) return;
    setSaving(true);
    try {
      if (zeroCost) {
        await api.addSupplierPayment(flow.id, {
          supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
          amount: 0, quantity: items.reduce((s, it) => s + it.qty, 0) || 1, unit_price: 0,
          method: selSupplier?.payment_method || null,
        });
      } else {
        for (const it of filledItems) {
          const rate = parseAmt(it.myRate);
          await api.addSupplierPayment(flow.id, {
            supplier_name: suppName.trim(), supplier_id: selSupplier?.id || null,
            amount: it.qty * rate, quantity: it.qty, unit_price: rate,
            method: selSupplier?.payment_method || null,
          });
        }
      }
      setSuppName(""); setSelSupplier(null); setSuppResults([]);
      setItems((prev) => prev.map((it) => ({ ...it, myRate: "" })));
      setShowForm(false);
      // Keep completed-deal numbers correct after a manual cost edit.
      if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
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
      await api.addSupplierPayment(flow.id, { supplier_name: costNote.trim() || label, supplier_id: null, amount: amt, category: costType });
      setCostAmt(""); setCostNote(""); setShowCost(false);
      if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const removePayment = async (pid: string) => {
    try {
      await api.removeSupplierPayment(flow.id, pid);
      if (flow.stage === "complete") { try { await api.recalcDealFromBank(flow.id); } catch {} }
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink">Supplier &amp; cost</div>
        <div className="text-[12px] text-muted mt-0.5">What you're paying for the goods. Add each supplier and cost, then continue.</div>
      </div>

      {/* Existing cost lines */}
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
                  <div className="text-[11px] text-muted tabular-nums">{p.quantity} × {fmtAmount(p.unit_price)}</div>
                )}
              </div>
              <div className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(p.amount)}</div>
              {!locked && (
                <button onClick={() => removePayment(p.id)} className="text-faint hover:text-danger-ink transition-colors"><X size={13} /></button>
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2 text-[11px] text-muted pr-1">
            <span>Total cost</span>
            <span className="font-semibold text-ink tabular-nums w-24 text-right">{fmtAmount(totalCost)}</span>
          </div>
        </div>
      )}

      {locked ? null : (
      <>
      {/* Chooser */}
      {!showForm && !showCost && (
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
      )}

      {/* Freight / fee form */}
      {showCost && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2"><Truck size={15} className="text-accent" /><div className="text-[13px] font-medium text-ink">Freight or fee</div></div>
          <select value={costType} onChange={(e) => setCostType(e.target.value)} className={inp}>
            {COST_CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <input type="text" placeholder="Note (optional — e.g. DHL, bank ref)" value={costNote} onChange={(e) => setCostNote(e.target.value)} className={inp} />
          <input type="number" inputMode="decimal" placeholder="Amount" value={costAmt} onChange={(e) => setCostAmt(e.target.value)} className={inp} />
          <div className="flex gap-2">
            <button onClick={handleAddCost} disabled={saving} className="flex-1 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-semibold disabled:opacity-50">Add cost</button>
            <button onClick={() => { setShowCost(false); setCostAmt(""); setCostNote(""); }} className="px-4 h-9 rounded-lg border border-line text-[13px] text-muted">Cancel</button>
          </div>
        </div>
      )}

      {/* Supplier form */}
      {showForm && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div>
            <div className="flex items-center gap-2"><Package size={15} className="text-accent" /><div className="text-[13px] font-medium text-ink">Supplier cost</div></div>
            <div className="text-[11.5px] text-muted mt-0.5">Itemized — your cost vs the client quote per line</div>
          </div>
          <div className="relative">
            <input type="text" placeholder="Search supplier name…" value={suppName}
              onChange={(e) => { setSuppName(e.target.value); setSelSupplier(null); }} className={inp} />
            {suppResults.length > 0 && (
              <div className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.08)] max-h-40 overflow-y-auto">
                {suppResults.map((s) => (
                  <button key={s.id} onClick={() => pickSupplier(s)} className="w-full text-left px-4 py-2.5 hover:bg-surface-2 transition-colors first:rounded-t-xl last:rounded-b-xl">
                    <div className="text-[13px] font-medium text-ink">{s.name}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {s.contact_name && <span className="text-[11px] text-muted">{s.contact_name}</span>}
                      {s.payment_method && <span className="text-[11px] text-muted">· {s.payment_method}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {selSupplier && (
            <div className="text-[11px] text-accent bg-accent/10 border border-accent/10 rounded-lg px-3 py-2 space-y-0.5">
              {selSupplier.contact_name && <div className="font-medium text-accent-hover">{selSupplier.contact_name}</div>}
              {(selSupplier.payment_method || selSupplier.payment_details) && (
                <div>{selSupplier.payment_method}{selSupplier.payment_details ? ` · ${selSupplier.payment_details}` : ""}</div>
              )}
            </div>
          )}
          {items.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[12.5px] font-medium text-muted">Item costs</div>
              <div className="rounded-lg border border-line overflow-hidden">
                <div className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-1.5 bg-surface-2 text-[12.5px] font-medium text-muted">
                  <span>Item</span><span className="text-center">Qty</span><span className="text-right">Our quote</span><span className="text-right">My rate</span><span className="text-right">My total</span>
                </div>
                {items.map((item, i) => {
                  const myRate = parseAmt(item.myRate);
                  const myTotal = item.qty * myRate;
                  const clientTotal = item.qty * item.clientRate;
                  const saving_pct = clientTotal > 0 && myTotal > 0 ? ((clientTotal - myTotal) / clientTotal) * 100 : null;
                  return (
                    <div key={i} className="grid grid-cols-[1fr_44px_80px_80px_80px] gap-x-2 px-3 py-2 border-t border-line-2 items-center">
                      <span className="text-[12px] text-ink-2 truncate" title={item.description}>{item.description}</span>
                      <span className="text-[12px] text-muted text-center tabular-nums">{item.qty}</span>
                      <span className="text-[12px] text-muted text-right tabular-nums">{fmtAmount(item.clientRate)}</span>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-[11px] pointer-events-none">$</span>
                        <input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={item.myRate}
                          onChange={(e) => { const copy = [...items]; copy[i] = { ...copy[i], myRate: e.target.value }; setItems(copy); }}
                          className="w-full border border-line pl-5 pr-1 h-8 rounded-md text-[12px] text-right focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors tabular-nums" />
                      </div>
                      <div className="text-right">
                        <div className="text-[12px] font-medium text-ink tabular-nums">{myRate > 0 ? fmtAmount(myTotal) : "—"}</div>
                        {saving_pct !== null && myRate > 0 && (
                          <div className={`text-[10px] tabular-nums ${saving_pct >= 20 ? "text-success-ink" : saving_pct >= 0 ? "text-warning-ink" : "text-danger-ink"}`}>{saving_pct.toFixed(0)}% margin</div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {anyRateEntered && (
                  <div className="flex justify-between items-center px-3 py-2 border-t border-line bg-surface-2/60">
                    <span className="text-[11px] text-muted font-medium">Total supplier cost</span>
                    <span className="text-[12px] font-bold text-ink tabular-nums">{fmtAmount(suppTotal)}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[12.5px] font-medium text-muted">Amount</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={items[0]?.myRate ?? ""}
                  onChange={(e) => setItems([{ description: "Supplier cost", qty: 1, clientRate: flow.invoice_total, myRate: e.target.value }])}
                  className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleAddSupplier} disabled={saving || !suppName.trim()}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors flex items-center gap-1.5">
              <Plus size={13} /> Add supplier
            </button>
            <button onClick={() => { setShowForm(false); setSuppName(""); setSelSupplier(null); setSuppResults([]); setItems((prev) => prev.map((it) => ({ ...it, myRate: "" }))); }}
              className="text-[13px] text-muted hover:text-ink-2 px-3 h-9 hover:bg-surface-3 rounded-lg transition-colors">Cancel</button>
          </div>
        </div>
      )}
      </>
      )}

      {/* Advance */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11.5px] text-muted">
          {existingPayments.length > 0 ? "Cost recorded" : "No supplier cost yet — you can continue and record this as 100% profit"}
        </span>
        <button onClick={onAdvance}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
          Continue to money <Check size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ─── Section 2: Money movement (received + sent) ──────────────────────────
function SectionMoney({ flow, onReload, onAdvance, locked }: { flow: DealFlow; onReload: () => void; onAdvance: () => void; locked: boolean }) {
  const payments      = flow.supplier_payments || [];
  const hasSuppliers  = payments.length > 0;
  const received      = si(flow.stage) >= si("payment_received");
  const suppliersPaid = hasSuppliers ? payments.every((p) => p.paid || p.kept) : true;
  const [saving, setSaving] = useState(false);
  const [receivedAmount, setReceivedAmount] = useState<string>(flow.invoice_total ? flow.invoice_total.toFixed(2) : "");
  useEffect(() => { setReceivedAmount(flow.invoice_total ? flow.invoice_total.toFixed(2) : ""); }, [flow.invoice_total]);
  const [depositAmount, setDepositAmount] = useState<string>(flow.deposit_amount ? flow.deposit_amount.toFixed(2) : "");
  useEffect(() => { setDepositAmount(flow.deposit_amount ? flow.deposit_amount.toFixed(2) : ""); }, [flow.deposit_amount]);
  const [savingDeposit, setSavingDeposit] = useState(false);

  const handleMarkReceived = async () => {
    const amt = parseFloat(receivedAmount);
    if (isNaN(amt) || amt < 0) { toast("Enter a valid amount received", "error"); return; }
    if (!hasSuppliers && !confirm("No supplier cost on this deal — it will be recorded as 100% profit. Mark payment received?")) return;
    setSaving(true);
    try { await api.markPaymentReceived(flow.id, { amount: amt, method: null, notes: null }); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  const undoReceived = async () => { setSaving(true); try { await api.unmarkPaymentReceived(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); } setSaving(false); };
  const handleSaveDeposit = async () => {
    const amt = parseFloat(depositAmount) || 0;
    if (amt < 0) { toast("Enter a valid deposit amount", "error"); return; }
    setSavingDeposit(true);
    try { await api.setDeposit(flow.id, amt); toast(amt > 0 ? "Deposit saved" : "Deposit cleared", "success"); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSavingDeposit(false);
  };
  const markAllPaid = async () => {
    setSaving(true);
    try { await Promise.all(payments.filter((p) => !p.paid).map((p) => api.markSupplierPaymentPaid(flow.id, p.id))); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  const unmarkAllPaid = async () => {
    setSaving(true);
    try { await Promise.all(payments.filter((p) => p.paid).map((p) => api.unmarkSupplierPaymentPaid(flow.id, p.id))); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  // "Didn't pay — kept it": drop this supplier's amount from the deal's cost.
  const toggleKept = async (paymentId: string, kept: boolean) => {
    setSaving(true);
    try { await api.setSupplierPaymentKept(flow.id, paymentId, kept); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const canReceive = !received; // show the mark-received form only when it isn't yet received
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink">Money movement</div>
        <div className="text-[12px] text-muted mt-0.5">Both legs must be done to continue: money in from the buyer, money out to the supplier.</div>
      </div>

      {/* Money received */}
      <div className={`rounded-xl border p-4 ${received ? "border-success/40 bg-success-bg/30" : "border-line bg-surface"}`}>
        <div className="flex items-center gap-2 mb-2">
          {received ? <CheckCircle2 size={15} className="text-success-ink" /> : <AlertTriangle size={15} className="text-warning-ink" />}
          <span className="text-[13px] font-semibold text-ink">Money received</span>
          {received && <span className="ml-auto text-[12px] text-success-ink font-medium tabular-nums">{fmtAmount(flow.payment_received_amount)} received</span>}
        </div>
        {received && !locked ? (
          <button onClick={undoReceived} disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-warning-ink px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors">
            <RotateCcw size={11} /> Undo payment
          </button>
        ) : canReceive ? (
          <div className="space-y-2.5">
            <div className="rounded-lg border border-line bg-surface p-3">
              <label className="block text-[12.5px] font-medium text-muted mb-1">Deposit received (optional)</label>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                  <input type="number" step="0.01" min="0" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} placeholder="0.00"
                    className="border border-line bg-surface text-ink pl-6 pr-3 h-9 rounded-lg text-[13px] w-40 tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
                </div>
                {(() => {
                  const dep = parseFloat(depositAmount) || 0; const total = flow.invoice_total || 0;
                  if (dep <= 0) return <span className="text-[11px] text-muted">A partial payment now — the rest stays owed until paid in full</span>;
                  if (dep > total + 0.005) return <span className="text-[11px] font-medium text-danger-ink">exceeds invoice {fmtAmount(total)}</span>;
                  return <span className="text-[11px] font-medium text-ink-2 tabular-nums">balance owed {fmtAmount(Math.max(0, total - dep))} of {fmtAmount(total)}</span>;
                })()}
                <button onClick={handleSaveDeposit} disabled={savingDeposit}
                  className="flex items-center gap-1.5 border border-line hover:bg-surface-3 text-ink-2 px-3 h-9 rounded-lg text-[12.5px] font-medium disabled:opacity-40 transition-colors">
                  {flow.deposit_amount ? "Update deposit" : "Save deposit"}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Amount received</label>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                  <input type="number" step="0.01" min="0" value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)}
                    className="border border-line bg-surface text-ink pl-6 pr-3 h-9 rounded-lg text-[13px] w-40 tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
                </div>
                {(() => {
                  const amt = parseFloat(receivedAmount); const diff = (isNaN(amt) ? 0 : amt) - (flow.invoice_total || 0);
                  if (!isFinite(diff) || Math.abs(diff) < 0.005) return <span className="text-[11px] text-muted">matches invoice {fmtAmount(flow.invoice_total)}</span>;
                  return <span className={`text-[11px] font-medium ${diff < 0 ? "text-danger-ink" : "text-success-ink"}`}>{diff < 0 ? "−" : "+"}{fmtAmount(Math.abs(diff))} vs invoice {fmtAmount(flow.invoice_total)}</span>;
                })()}
              </div>
            </div>
            <button onClick={handleMarkReceived} disabled={saving}
              className="flex items-center gap-2 bg-success hover:opacity-90 text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-all">
              <DollarSign size={14} /> Mark payment received
            </button>
          </div>
        ) : null}
      </div>

      {/* Money sent to supplier */}
      <div className={`rounded-xl border p-4 ${suppliersPaid && hasSuppliers ? "border-success/40 bg-success-bg/30" : "border-line bg-surface"}`}>
        <div className="flex items-center gap-2 mb-2">
          {suppliersPaid ? <CheckCircle2 size={15} className="text-success-ink" /> : <AlertTriangle size={15} className="text-warning-ink" />}
          <span className="text-[13px] font-semibold text-ink">Money sent to supplier</span>
          {hasSuppliers && <span className="ml-auto text-[12px] text-muted tabular-nums">{fmtAmount(flow.total_supplier_cost)}</span>}
        </div>
        {!hasSuppliers ? (
          <p className="text-[12px] text-muted">No supplier cost on this deal — nothing to send.</p>
        ) : (
          <>
            <div className="rounded-lg border border-line overflow-hidden bg-surface mb-2">
              {payments.map((p) => (
                <div key={p.id} className="flex items-center gap-3 px-3 py-2 border-b border-line-2 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1.5">
                      {p.supplier_name}
                      {p.category && p.category !== "supplier" && (
                        <span className="text-[9px] font-bold uppercase tracking-wide text-accent bg-accent/10 border border-accent/20 px-1.5 py-0.5 rounded flex-shrink-0">{catLabel(p.category)}</span>
                      )}
                    </div>
                    {p.paid && <div className="text-[10.5px] text-success-ink font-medium">Paid</div>}
                    {p.kept && <div className="text-[10.5px] text-accent font-medium">Kept — didn't pay, not counted as a cost</div>}
                    {!locked && !p.paid && (
                      <button onClick={() => toggleKept(p.id, !p.kept)} disabled={saving}
                        className="text-[10.5px] text-muted hover:text-ink-2 mt-0.5 disabled:opacity-40">
                        {p.kept ? "Undo — I did pay this" : "Didn't pay — keep it"}
                      </button>
                    )}
                  </div>
                  <div className={`text-[13px] font-semibold tabular-nums ${p.kept ? "text-muted line-through" : "text-ink"}`}>{fmtAmount(p.amount)}</div>
                </div>
              ))}
            </div>
            {suppliersPaid ? (
              !locked && (
                <button onClick={unmarkAllPaid} disabled={saving}
                  className="flex items-center gap-1.5 text-[12px] text-warning-ink px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors">
                  <RotateCcw size={11} /> Undo suppliers paid
                </button>
              )
            ) : (
              !locked && (
                <button onClick={markAllPaid} disabled={saving}
                  className="flex items-center gap-2 bg-accent hover:bg-accent text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors w-full justify-center">
                  <Check size={14} strokeWidth={2.5} /> Mark supplier paid — {fmtAmount(flow.total_supplier_cost)}
                </button>
              )
            )}
          </>
        )}
      </div>

      {/* Advance — gated on both legs */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11.5px] text-muted">
          {received && suppliersPaid ? "Both legs done" : !received ? "Mark the buyer payment received" : "Mark the supplier paid"}
        </span>
        <button onClick={onAdvance} disabled={!(received && suppliersPaid)}
          title={received && suppliersPaid ? undefined : "Complete both money legs first"}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          Continue to financials <Check size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ─── Section 3: Link financials ───────────────────────────────────────────
function SectionLink({ flow, onReload, onAdvance }: { flow: DealFlow; onReload: () => void; onAdvance: () => void }) {
  const meta = (() => { try { return JSON.parse((flow as any).metadata || "{}"); } catch { return {}; } })();
  const [noBuyer,    setNoBuyer]    = useState<boolean>(!!meta.no_buyer_link);
  const [noSupplier, setNoSupplier] = useState<boolean>(!!meta.no_supplier_link);
  const saveNa = async (nb: boolean, ns: boolean) => {
    setNoBuyer(nb); setNoSupplier(ns);
    try { await api.setDealLinkNa(flow.id, nb, ns); onReload(); } catch (e: any) { toast(String(e), "error"); }
  };
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink">Link financials</div>
        <div className="text-[12px] text-muted mt-0.5">
          Pair the real bank transactions to this deal — buyer payment, supplier payment, wire fees, refunds.
          Anything you link here (or from Bank statements) is what the recorded profit is built from.
        </div>
      </div>
      <ReconciliationPanel flow={flow} onChange={onReload} />

      {/* "Didn't happen" — mark a leg as having no bank record to link (cash, etc.) so
          this deal stops being flagged as needing financials. */}
      <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
        <div className="text-[12px] font-medium text-muted mb-2">No bank record for a leg? Mark it so this deal isn't flagged.</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => saveNa(!noBuyer, noSupplier)}
            className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-8 rounded-lg border transition-colors ${noBuyer ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink-2"}`}>
            {noBuyer ? <Check size={12} /> : <X size={12} />} No buyer payment to link
          </button>
          <button onClick={() => saveNa(noBuyer, !noSupplier)}
            className={`inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 h-8 rounded-lg border transition-colors ${noSupplier ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink-2"}`}>
            {noSupplier ? <Check size={12} /> : <X size={12} />} No supplier payment to link
          </button>
        </div>
      </div>

      <DealNotes flow={flow} onReload={onReload} />

      <div className="flex items-center justify-end pt-1">
        <button onClick={onAdvance}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
          Continue to profit <Check size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ── Deal notes — explain anything (e.g. why a leg has no bank record) ──
function DealNotes({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [val, setVal] = useState(flow.notes || "");
  const [saving, setSaving] = useState(false);
  const dirty = (flow.notes || "") !== val;
  const save = async () => {
    setSaving(true);
    try { await api.updateDealFlowNotes(flow.id, val.trim() || null); toast("Note saved"); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[12px] font-medium text-muted mb-1.5">Notes</div>
      <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={2}
        placeholder="Explain anything about this deal — e.g. why a payment has no bank record"
        className="w-full border border-line rounded-lg px-2.5 py-2 text-[12.5px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y" />
      {dirty && (
        <div className="flex justify-end mt-1.5">
          <button onClick={save} disabled={saving}
            className="text-[12px] font-medium px-3 h-8 rounded-lg bg-accent text-on-accent disabled:opacity-50 transition-colors">Save note</button>
        </div>
      )}
    </div>
  );
}

// ─── Section 4: Profit from financials ────────────────────────────────────
function SectionProfit({ flow, onAdvance }: { flow: DealFlow; onAdvance: () => void }) {
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id]);

  const p = recon?.pieces;
  const anyLinked = !!p && ((p.buyer_paired || 0) + (p.supplier_paired || 0) + (p.fee_paired || 0) + (p.refund_total || 0) + (p.refund_in || 0) > 0.005);
  const actual   = recon?.actual_profit ?? 0;
  const expected = recon?.expected_profit ?? (flow.invoice_total - flow.total_supplier_cost);
  const variance = actual - expected;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink">Profit from financials</div>
        <div className="text-[12px] text-muted mt-0.5">
          {anyLinked
            ? "Derived from the bank transactions you linked. This is what gets recorded and shown in analytics."
            : "No bank transactions linked yet — until you link some, the recorded profit uses the figures you entered."}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="text-[11px] text-muted">Actual profit {anyLinked ? "(from bank)" : "(entered)"}</div>
          <div className={`text-[22px] font-bold tabular-nums mt-0.5 ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
            {actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <div className="text-[11px] text-muted">Expected (entered)</div>
          <div className="text-[22px] font-bold tabular-nums mt-0.5 text-ink-2">{fmtAmount(expected)}</div>
          {Math.abs(variance) >= 0.5 && (
            <div className={`text-[11px] tabular-nums mt-0.5 ${variance >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
              {variance >= 0 ? "+" : "−"}{fmtAmount(Math.abs(variance))} vs expected
            </div>
          )}
        </div>
      </div>

      {anyLinked && p && (
        <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] space-y-1.5">
          <div className="text-[12px] font-medium text-muted mb-1">From linked transactions</div>
          <Row label="Payments received" value={`+${fmtAmount(p.buyer_paired)}`} clr="text-success-ink" />
          <Row label="Supplier paid" value={`−${fmtAmount(p.supplier_paired)}`} clr="text-danger-ink" />
          {p.fee_paired > 0.005 && <Row label="Wire fees" value={`−${fmtAmount(p.fee_paired)}`} clr="text-danger-ink" />}
          {p.refund_total > 0.005 && <Row label="Refunds paid" value={`−${fmtAmount(p.refund_total)}`} clr="text-danger-ink" />}
          {p.refund_in > 0.005 && <Row label="Supplier refund received" value={`+${fmtAmount(p.refund_in)}`} clr="text-success-ink" />}
          <div className="flex items-center justify-between pt-1.5 border-t border-line-2">
            <span className="font-semibold text-ink">Actual profit</span>
            <span className={`font-bold tabular-nums ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <span className="text-[11.5px] text-muted">{recon?.fully_reconciled ? "Fully reconciled with the bank" : "You can complete now and finish linking later"}</span>
        <button onClick={onAdvance}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
          Review &amp; complete <Check size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, clr }: { label: string; value: string; clr: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-2">{label}</span>
      <span className={`tabular-nums ${clr}`}>{value}</span>
    </div>
  );
}

// ─── Panel 4: Complete deal ───────────────────────────────────────────────
type ShippingHold = "idle" | "asking" | "shipping";

function PanelComplete({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [recipients, setRecipients] = useState<PayoutShare[]>([]);
  const [recon,      setRecon]      = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  const [saving,     setSaving]     = useState(false);
  const [shipHold,   setShipHold]   = useState<ShippingHold>("idle");
  const [carrier,      setCarrier]      = useState("");
  const [tracking,     setTracking]     = useState("");
  const [pickupDate,   setPickupDate]   = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const todayStr = new Date().toISOString().slice(0, 10);
  const [completedDate, setCompletedDate] = useState(todayStr);
  const [payoutIncluded, setPayoutIncluded] = useState(true);
  const [moneyLinked, setMoneyLinked] = useState(false);

  useEffect(() => { api.getPayoutSplit().then(setRecipients).catch(() => {}); }, []);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id, flow.stage]);
  // Default the completion date to when the BUYER's payment actually landed (bank
  // date of the last buyer leg), falling back to the recorded payment date — a deal
  // closed on the day the money came in, so backdated / backlogged deals land right.
  useEffect(() => {
    if (flow.stage === "complete") return;
    api.dealAllocations(flow.id).then((allocs) => {
      const paid = allocs.filter((a) => a.role === "buyer_payment" && a.posted_at).map((a) => a.posted_at as string).sort();
      if (paid.length) setCompletedDate(paid[paid.length - 1].slice(0, 10));
      else if (flow.payment_received_at) setCompletedDate(flow.payment_received_at.slice(0, 10));
    }).catch(() => {});
  }, [flow.id, flow.stage]);

  const canComplete = flow.stage === "payment_received" || flow.stage === "supplier_paid";
  const isComplete  = flow.stage === "complete";

  // What gets recorded — the BANK numbers. A completed deal shows its permanent
  // recorded figures (captured at completion, survive even if statements are lost).
  // An open deal previews from live links, falling back to the entered figure only
  // for a leg with nothing linked yet.
  const pc = recon?.pieces;
  const buyerBank = pc?.buyer_paired ?? 0;
  const costBank  = (pc?.supplier_paired ?? 0) + (pc?.fee_paired ?? 0);
  const revFromBank  = buyerBank > 0.005;
  const costFromBank = costBank > 0.005;
  const recRev  = isComplete ? flow.gross_revenue : (revFromBank ? buyerBank : flow.payment_received_amount);
  const recCost = isComplete ? flow.total_cost    : (costFromBank ? costBank : flow.total_supplier_cost);
  const recNet  = isComplete ? flow.net_profit    : recRev - recCost;
  const bankBacked = isComplete ? true : (revFromBank || costFromBank);
  const refundTotal = pc?.refund_total ?? 0;

  // Fail-proof record: transactions snapshotted onto the deal at completion.
  let snapshot: any[] = [];
  try { const m = JSON.parse((flow as any).metadata || "{}"); if (Array.isArray(m.bank_snapshot)) snapshot = m.bank_snapshot; } catch {}

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
    if (recNet < 0) {
      const ok = confirm(`Warning: This deal is at a loss.\n\nRevenue: ${fmtAmount(recRev)}\nCosts: ${fmtAmount(recCost)}\nLoss: ${fmtAmount(recNet)}\n\nMark complete anyway?`);
      if (!ok) return;
    }
    setShipHold("asking");
  };

  const handleCompleteNow = () => { setShipHold("idle"); runComplete(); };

  const handleShippingComplete = async () => {
    setSaving(true);
    try {
      await api.saveInvoiceShipping(flow.invoice_id, {
        carrier: carrier || undefined, tracking_number: tracking || undefined,
        pickup_date: pickupDate || undefined, delivery_date: deliveryDate || undefined, is_complete: true,
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

  const split = isComplete && recNet > 0 ? dealPayoutSplit(flow, recipients) : [];

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-ink">Review &amp; complete</div>
        <div className="text-[12px] text-muted mt-0.5">
          {isComplete
            ? "Recorded from the linked bank transactions — saved with the deal so it never disappears."
            : bankBacked
              ? "These are the real bank numbers that get recorded and shown everywhere."
              : "No bank transactions linked yet — these use your entered figures. Link them in step 3 for bank-accurate profit."}
        </div>
      </div>

      {/* What gets recorded */}
      <div className={`rounded-xl border p-4 ${recNet >= 0 ? "border-line" : "border-danger/40"} bg-surface`}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[12.5px] font-semibold text-ink-2">{isComplete ? "Recorded profit" : "What gets recorded"}</span>
          {bankBacked
            ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success-ink"><CheckCircle2 size={12} /> From bank{recon?.fully_reconciled ? " · fully reconciled" : ""}</span>
            : <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-ink"><AlertTriangle size={12} /> Entered figures</span>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <RecCell label="Revenue" value={fmtAmount(recRev)}  sub={isComplete ? undefined : (revFromBank ? "from bank" : "entered")} />
          <RecCell label="Cost"    value={fmtAmount(recCost)} sub={isComplete ? undefined : (costFromBank ? "from bank" : "entered")} />
          <RecCell label={recNet >= 0 ? "Profit" : "Loss"} value={fmtAmount(recNet)} sub={`${recRev > 0 ? ((recNet / recRev) * 100).toFixed(1) : "0.0"}% margin`} clr={recNet >= 0 ? "text-success-ink" : "text-danger-ink"} big />
        </div>
        {refundTotal > 0.005 && (
          <div className="mt-2.5 text-[11px] text-muted">Refunds of {fmtAmount(refundTotal)} are tracked separately and reduce profit in reports.</div>
        )}
      </div>

      {/* Snapshot of linked transactions — the fail-proof record */}
      {snapshot.length > 0 && (
        <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="text-[12px] font-medium text-muted mb-1.5">Linked transactions saved with this deal</div>
          <div className="space-y-1">
            {snapshot.map((s: any, i: number) => {
              const clickable = !!s.txn_id;
              const openInFinancials = () => {
                if (!clickable) return;
                // Hand the target transaction to Financials, then switch to it.
                // FinancialsView reads this on mount and opens the txn's detail.
                (window as any).__pendingBankTxn = s.txn_id;
                window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }));
              };
              return (
                <div
                  key={i}
                  onClick={openInFinancials}
                  title={clickable ? "View this transaction in Financials" : undefined}
                  className={`flex items-center gap-2 text-[12px] ${clickable ? "cursor-pointer hover:bg-surface-2 -mx-1.5 px-1.5 py-0.5 rounded-md transition-colors" : ""}`}
                >
                  <span className="text-ink-2 flex-1 truncate">
                    {roleLabel(s.role)} · {s.counterparty || "—"}
                    {s.posted_at ? ` · ${new Date(s.posted_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                  </span>
                  <span className={`tabular-nums font-medium ${s.direction === "out" ? "text-danger-ink" : "text-success-ink"}`}>
                    {s.direction === "out" ? "−" : ""}{fmtAmount(s.amount)}
                  </span>
                  {clickable && <ChevronRight size={13} className="text-muted shrink-0" />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Profit split (completed + profitable) */}
      {split.length > 0 && (
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <div className="text-[12px] font-medium text-muted mb-2">Profit split</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {split.map((it, i) => (
              <div key={i}>
                <div className="text-[11px] text-muted">{it.name}</div>
                <div className="text-[13px] font-semibold text-success-ink tabular-nums">{fmtAmount(it.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Complete action area ── */}
      {canComplete && shipHold === "idle" && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted whitespace-nowrap">Completed date</label>
            <input type="date" value={completedDate} max={todayStr} onChange={(e) => setCompletedDate(e.target.value)}
              className="flex-1 border border-line px-2.5 h-8 rounded-lg text-[12px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" />
          </div>
          <div className="py-1 space-y-1">
            <div className="text-[11px] text-muted">Where does this deal's profit go?</div>
            <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
              <button type="button" onClick={() => setPayoutIncluded(true)}
                className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>Apply profit split</button>
              <button type="button" onClick={() => setPayoutIncluded(false)}
                className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${!payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>Business keeps 100%</button>
            </div>
          </div>
          <button type="button" onClick={() => setMoneyLinked((v) => !v)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${moneyLinked ? "border-success bg-success-bg" : "border-line bg-surface hover:border-accent/40"}`}>
            {moneyLinked ? <CheckCircle2 size={16} className="text-success-ink flex-shrink-0" /> : <AlertTriangle size={16} className="text-warning-ink flex-shrink-0" />}
            <span className={`text-[12.5px] leading-snug ${moneyLinked ? "text-success-ink font-medium" : "text-ink-2"}`}>
              This is all the money that will ever be linked to this deal
            </span>
          </button>
          <button onClick={handleCompleteClick} disabled={saving || !moneyLinked}
            title={!moneyLinked ? "Confirm all money is linked first" : undefined}
            className="w-full bg-accent hover:bg-accent-hover text-on-accent h-10 rounded-lg text-[14px] font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {moneyLinked ? `Complete deal — record ${fmtAmount(recNet)} profit` : "Complete deal — confirm money linked above"}
          </button>
        </div>
      )}

      {/* Step A: shipping question */}
      {canComplete && shipHold === "asking" && (
        <div className="bg-warning-bg border border-warning rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-ink"><Truck size={15} className="text-warning-ink" /> Does this deal require shipping?</div>
          <p className="text-[12px] text-warning-ink">If items are being shipped, hold here and track the shipment before closing out.</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setShipHold("shipping")} className="flex items-center gap-1.5 bg-warning hover:opacity-90 text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-all"><Truck size={13} /> Yes, track shipping</button>
            <button onClick={handleCompleteNow} disabled={saving} className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors"><Check size={13} /> No, complete now</button>
            <button onClick={() => setShipHold("idle")} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9 hover:bg-surface-3 rounded-lg transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Step B: shipping form */}
      {canComplete && shipHold === "shipping" && (
        <div className="bg-surface border border-warning rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-warning-ink" />
            <span className="text-[13px] font-semibold text-ink">Shipping hold</span>
            <span className="ml-auto text-[11px] text-warning-ink bg-warning-bg border border-warning px-2 py-0.5 rounded-full font-medium">Awaiting delivery</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-[11px] text-muted font-medium mb-1">Carrier</label><input className={inp} placeholder="FedEx, UPS…" value={carrier} onChange={(e) => setCarrier(e.target.value)} /></div>
            <div><label className="block text-[11px] text-muted font-medium mb-1">Tracking #</label><input className={inp} placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} /></div>
            <div><label className="block text-[11px] text-muted font-medium mb-1">Pickup date</label><input type="date" className={inp} value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} /></div>
            <div><label className="block text-[11px] text-muted font-medium mb-1">Delivery date</label><input type="date" className={inp} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleShippingComplete} disabled={saving} className="flex items-center gap-1.5 bg-success hover:opacity-90 text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-all"><Check size={13} /> Confirm delivery &amp; complete</button>
            <button onClick={() => setShipHold("idle")} className="text-[13px] text-muted hover:text-ink-2 px-3 h-9 hover:bg-surface-3 rounded-lg transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Completed controls */}
      {isComplete && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button onClick={handleUndo} disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-warning-ink px-2.5 py-1 rounded-lg hover:bg-warning-bg border border-warning transition-colors">
            <RotateCcw size={11} /> Reopen deal
          </button>
          <button onClick={async () => { setSaving(true); try { const r = await api.recalcDealFromBank(flow.id); toast(r?.from_bank ? `Recalculated from bank — profit ${fmtAmount(r?.net_profit ?? 0)}` : "No bank transactions linked — kept recorded figures", "success"); onReload(); } catch (e: any) { toast(String(e), "error"); } setSaving(false); }}
            disabled={saving}
            className="flex items-center gap-1.5 text-[12px] text-accent px-2.5 py-1 rounded-lg hover:bg-accent/10 border border-accent/30 transition-colors">
            <RefreshCw size={11} /> Recalculate from bank
          </button>
        </div>
      )}
    </div>
  );
}

const roleLabel = (r: string) =>
  r === "buyer_payment" ? "Payment in" : r === "supplier_payment" ? "Supplier paid" :
  r === "fee" ? "Wire fee" : r === "refund_out" ? "Refund out" : r === "refund_in" ? "Supplier refund" : r;

function RecCell({ label, value, sub, clr = "text-ink", big }: { label: string; value: string; sub?: string; clr?: string; big?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2/60 border border-line-2 px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`${big ? "text-[18px]" : "text-[15px]"} font-bold tabular-nums mt-0.5 ${clr}`}>{value}</div>
      {sub && <div className="text-[10px] text-faint mt-0.5">{sub}</div>}
    </div>
  );
}

