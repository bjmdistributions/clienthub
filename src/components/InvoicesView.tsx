import { Fragment, useEffect, useRef, useState } from "react";
import { api, Client, Invoice, LineItem, PaymentMethod, LineItemTemplate, Payment, CompanyInfo, InvoiceTemplate, DealFlow } from "../lib/api";
import { parseLineItems, queryTokens, matchesAllTokens, matchingItems, describeItem, isNoiseItem } from "../lib/itemSearch";
import { fmtAmount, localDay } from "../lib/format";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FileDown, Send, Plus, X, Check, Trash2, ExternalLink, Edit2, FileText, RotateCcw, CreditCard, Download, XCircle, Search, MoreVertical, type LucideIcon } from "lucide-react";
import RecurringView from "./RecurringView";
import InvoicePreview, { DEFAULT_INVOICE_TEMPLATE } from "./InvoicePreview";
import ReconciliationPanel from "./ReconciliationPanel";
import RefundWorkspace from "./RefundWorkspace";
import InvoiceCostSection from "./InvoiceCostSection";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";

const isVoided = (inv: Invoice): boolean => !!inv.voided;

const statusColor = (inv: Invoice): string => {
  const s = inv.status;
  const lo = s.toLowerCase();
  if (lo === "void")                    return "bg-surface-3 text-muted line-through";
  if (lo === "paid" && inv.is_complete) return "bg-success-bg text-success-ink";
  if (lo === "paid")                    return "bg-warning-bg text-warning-ink";
  if (lo === "sent" || lo === "deposit_pending") return "bg-info-bg text-info-ink";
  if (lo === "overdue")                 return "bg-danger-bg text-danger-ink";
  return "bg-surface-3 text-ink-2";
};

const statusLabel = (inv: Invoice): string => {
  const lo = inv.status.toLowerCase();
  if (lo === "void") return "Void";
  if (lo === "paid" && inv.is_complete) return "Completed";
  if (lo === "paid") return "Paid";
  if (lo === "deposit_pending") return "Sent";
  const s = inv.status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const FLOW_STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"];
function flowStageSi(stage?: string | null): number {
  if (!stage) return -1;
  return FLOW_STAGES.indexOf(stage);
}

const FLOW_LABELS = ["Invoiced", "Payment in", "Supplier paid", "Complete"];

// 4-dot deal flow progress indicator — red → amber → lime → green gradient
function FlowDots({ stage }: { stage?: string | null }) {
  const colors    = ["bg-danger", "bg-warning", "bg-lime-500", "bg-success"];
  const cur       = flowStageSi(stage ?? null);
  const label     = cur >= 0 ? FLOW_LABELS[cur] : "No flow";
  return (
    <div
      className="flex items-center gap-0.5 ml-2"
      title={`Deal flow: ${label}`}
    >
      {FLOW_STAGES.map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all ${
            cur < 0
              ? "w-1.5 h-1.5 bg-surface-3"           // no flow yet — faint grey
              : i <= cur
              ? `w-2 h-2 ${colors[i]}`               // completed step
              : "w-1.5 h-1.5 bg-surface-3"            // future step
          }`}
        />
      ))}
    </div>
  );
}

const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function InvoicesView() {
  const [invoices, setInvoices]         = useState<Invoice[]>([]);
  const [refundMap, setRefundMap]       = useState<Record<string, { refund_owed: number; refunded: number; remaining: number }>>({});
  const [clients, setClients]           = useState<Client[]>([]);
  const [showForm, setShowForm]         = useState(false);
  const [editing, setEditing]           = useState<Invoice | null>(null);
  const [busy, setBusy]                 = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [viewTab, setViewTab]            = useState<"active" | "all" | "drafts" | "sent" | "paid" | "recurring">("active");
  const [search, setSearch]              = useState("");
  // Completed invoices are hidden by default to cut list bloat.
  const [showCompleted, setShowCompleted] = useState(false);
  const [payModal, setPayModal]         = useState<string | null>(null);
  const [payDate, setPayDate]           = useState(localDay());
  const [payMethod, setPayMethod]       = useState("");
  const [payRef, setPayRef]             = useState("");
  const [payMethods, setPayMethods]     = useState<PaymentMethod[]>([]);
  const [detailId, setDetailId]         = useState<string | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);

  const openDetail = async (id: string) => {
    setDetailId(id);
    try { setDetailInvoice(await api.getInvoice(id)); } catch { setDetailInvoice(null); }
  };

  // invoice_id -> { stage, cost } from in-progress deal flows, for projected profit
  const [flowMap, setFlowMap] = useState<Record<string, { stage: string; cost: number }>>({});

  const load = async () => {
    const [inv, cli, flows, refundList] = await Promise.all([api.listInvoices(), api.listClients(), api.listDealFlows().catch(() => []), api.refundStatusAll().catch(() => [])]);
    setInvoices(inv);
    setClients(cli);
    const fm: Record<string, { stage: string; cost: number }> = {};
    for (const f of flows) fm[f.invoice_id] = { stage: f.stage, cost: f.total_supplier_cost ?? 0 };
    setFlowMap(fm);
    setRefundMap(Object.fromEntries(refundList.map((r) => [r.deal_flow_id, r])));
  };
  useEffect(() => { load(); }, []);

  // R-235: the client screen hands an invoice over by stashing its id, the same
  // way it hands a deal to Deal flow. Read it once and clear it, so returning to
  // this tab later does not reopen a drawer he already closed.
  useEffect(() => {
    let wanted: string | null = null;
    try {
      wanted = localStorage.getItem("invoices_open_id");
      if (wanted) localStorage.removeItem("invoices_open_id");
    } catch { /* ignore */ }
    if (wanted) openDetail(wanted);
  }, []);

  const handlePdf = async (id: string) => {
    setBusy(id);
    try {
      await api.generateInvoicePdf(id);
      toast("PDF saved — check your invoices folder");
      load();
    } catch (e: any) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };

  const handleSend = async (id: string) => {
    if (!confirm("Send invoice via email?")) return;
    setBusy(id);
    try { await api.sendInvoice(id); load(); }
    catch (e: any) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };

  const handleMarkPaid = (id: string) => {
    setPayModal(id);
    setPayDate(localDay());
    setPayMethod(""); setPayRef("");
    api.listPaymentMethods().then((m) => setPayMethods(m.filter((p) => p.active))).catch(() => {});
  };

  const confirmPay = async () => {
    if (!payModal) return;
    setBusy(payModal);
    try {
      await api.markInvoicePaid(payModal, payDate, payMethod || undefined, payRef || undefined);
      setPayModal(null);
      load();
    } catch (e: any) { toast(String(e), "error"); }
    finally { setBusy(null); }
  };

  // Delete is now a soft archive (restorable), so the confirm is reworded.
  const handleDelete = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    try { await api.deleteInvoice(id); toast("Moved to Archive"); load(); }
    catch (e: any) { toast(String(e), "error"); }
  };

  // Void ("deal fell through") — two-step confirm; un-void reverses it.
  const handleVoid = async (id: string, voided: boolean) => {
    if (voided && !confirm("Mark this deal as fallen through? The invoice is voided — it drops out of receivables and owed totals, but nothing is deleted.")) return;
    try { await api.setInvoiceVoid(id, voided); toast(voided ? "Invoice voided" : "Invoice restored"); load(); }
    catch (e: any) { toast(String(e), "error"); }
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;
  const q = search.trim().toLowerCase();
  // R-234: searching is a search of everything sold, not of the current tab.
  // A product sold months ago is by definition completed, and completed rows are
  // hidden on every tab but Paid/All — so honouring the tab here would make the
  // feature unable to find the exact thing it exists to find.
  const qTokens = queryTokens(search);
  const searching = qTokens.length > 0;
  // The status tab filters the table (recurring renders its own view). Voided
  // invoices only show under "all" so they stay out of the working lists.
  const visible = invoices.filter((i) => {
    const lo = i.status.toLowerCase();
    const inRefund = !!(i.deal_flow_id && refundMap[i.deal_flow_id]);
    // "Active" is the default working view: live deals only — hide fell-through
    // (voided) invoices and anything in a refund. They stay reachable under the
    // "All" tab (voided dimmed) and Deal Flow → Refunds.
    if (searching) {
      // Every non-archived invoice is in scope; voided rows still render dimmed.
    } else if (viewTab === "active") {
      if (isVoided(i) || inRefund) return false;
    } else if (isVoided(i)) {
      if (viewTab === "drafts" || viewTab === "sent" || viewTab === "paid") return false;
    } else if (viewTab === "drafts") { if (lo !== "draft") return false; }
    else if (viewTab === "sent")   { if (!(lo === "sent" || lo === "deposit_pending" || lo === "overdue")) return false; }
    else if (viewTab === "paid")   { if (lo !== "paid") return false; }
    // Completed invoices hidden unless the toggle is on (or on the paid/all tabs).
    // "All" is the see-everything archive — every invoice ever, always searchable.
    if (!searching && !showCompleted && viewTab !== "paid" && viewTab !== "all" && i.is_complete) return false;
    // Search by number / client / amount — and by what was actually sold. Every
    // token must appear somewhere, in any order, so "lego crocs" matches
    // "Crocs - Lego collab". Freight lines are not products and never match.
    if (searching) {
      // Freight lines are excluded here as well as in matchingItems below —
      // otherwise "shipping" matches the invoice but highlights nothing on it,
      // and the row appears with no reason attached.
      const goods = parseLineItems(i.line_items_json)
        .filter((it) => !isNoiseItem(it.description || ""))
        .map((it) => it.description || "")
        .join(" ");
      const hay = `${i.number} ${clientName(i.client_id)} ${i.total} ${goods}`;
      if (!matchesAllTokens(hay, qTokens)) return false;
    }
    return true;
  });
  // Voided invoices are excluded from all money totals.
  const outstanding   = invoices.filter((i) => i.status !== "paid" && !isVoided(i)).reduce((s, i) => s + i.total, 0);
  // R-131: past due is a date test, not a status label. Reading status === "overdue"
  // alone missed genuinely late "sent" rows (the overdue sweep is a job, not a
  // guarantee) and counted voided paper — mark_overdue_invoices has historically
  // stamped "overdue" onto rows that were later voided. Mirrors the mobile
  // isInvoicePastDue predicate so both surfaces show the same number. Archived rows
  // need no guard here: list_invoices already filters COALESCE(archived,0)=0.
  // Compare YYYY-MM-DD strings against localDay() — new Date on a bare date string
  // parses UTC midnight and reads a day early in Central (R-159).
  const todayLocal    = localDay();
  const overdueCount  = invoices.filter((i) =>
    (i.status === "sent" || i.status === "overdue")
    && !isVoided(i)
    && !!i.due_date && i.due_date.slice(0, 10) < todayLocal
  ).length;
  const paidCount     = invoices.filter((i) => i.status === "paid").length;
  const completedCount = invoices.filter((i) => i.is_complete).length;
  const sentCount     = invoices.filter((i) => i.status === "sent").length;
  const draftCount    = invoices.filter((i) => i.status === "draft").length;
  // Only count profit once a deal is fully closed (is_complete = true); voided out.
  const totalProfit   = invoices.filter((i) => i.is_complete && !isVoided(i)).reduce((s, i) => s + (i.profit ?? 0), 0);

  const handleExportInvoices = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "invoices.csv" });
    if (!path) return;
    const count = await api.exportInvoicesCsv(path as string);
    toast(`Exported ${count} invoice${count !== 1 ? "s" : ""} to CSV`);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center gap-3 flex-wrap mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Invoices</h2>
          <p className="text-[12px] text-muted mt-0.5">{invoices.length} total · {fmtAmount(outstanding)} outstanding</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportInvoices}
            className="flex items-center gap-1.5 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] font-medium hover:bg-surface-2 transition-colors">
            <FileDown size={13} /> Export CSV
          </button>
          <button
            onClick={() => { setEditing(null); setShowForm(true); }}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
          >
            <Plus size={14} /> New invoice
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit mb-5">
        {(["active", "all", "drafts", "sent", "paid", "recurring"] as const).map((t) => (
          <button key={t} onClick={() => setViewTab(t)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors capitalize ${viewTab === t ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {t}
          </button>
        ))}
      </div>

      {viewTab === "recurring" ? (
        <RecurringView />
      ) : (
        <>
      {/* Search + show-completed */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by item, number, client, or amount…"
            className="w-full pl-9 pr-8 h-9 border border-line rounded-lg text-[13px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint hover:text-muted">
              <X size={12} />
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer select-none whitespace-nowrap">
          <input type="checkbox" className="accent-accent" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed
        </label>
      </div>

      {/* R-234: a search deliberately ignores the tab, so say so rather than
          leaving him to wonder why completed and voided rows appeared. */}
      {searching && (
        <p className="-mt-2 mb-4 text-[12px] text-muted">
          Searching every invoice — {visible.length} match{visible.length === 1 ? "" : "es"}, including completed and fell-through.
        </p>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3 mb-5">
        {[
          { label: "Total",          value: invoices.length,          color: "text-ink" },
          { label: "Completed",      value: completedCount,           color: completedCount > 0 ? "text-success-ink" : "text-muted" },
          { label: "Paid",           value: paidCount - completedCount, color: (paidCount - completedCount) > 0 ? "text-warning-ink" : "text-muted" },
          { label: "Sent",           value: sentCount,                color: sentCount > 0 ? "text-info-ink" : "text-muted" },
          { label: "Overdue",        value: overdueCount,             color: overdueCount > 0 ? "text-danger-ink" : "text-muted" },
          { label: "Total profit",   value: fmtAmount(totalProfit),   color: totalProfit >= 0 ? "text-success-ink" : "text-danger-ink" },
        ].map((s) => (
          <div key={s.label} className="bg-surface border border-line rounded-xl px-4 py-3.5">
            <p className="text-[12.5px] font-medium text-muted mb-1">{s.label}</p>
            <p className={`text-[22px] font-bold tabular-nums ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Invoice form */}
      {showForm && (
        <InvoiceForm clients={clients} initial={editing} onClose={() => { setShowForm(false); setEditing(null); load(); }} />
      )}

      {/* Mark paid modal */}
      {payModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/25 backdrop-blur-[3px]" onClick={() => setPayModal(null)}>
          <div className="bg-surface rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.14)] w-[420px] max-w-[92vw] animate-fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-line-2">
              <h3 className="text-[14px] font-semibold text-ink">Mark as paid</h3>
              <button onClick={() => setPayModal(null)} className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">Date</label>
                <input type="date" className={inp} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">Method</label>
                <select className={inp} value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  <option value="">— select —</option>
                  {payMethods.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-muted mb-1.5">Reference (optional)</label>
                <input className={inp} placeholder="e.g. check #1234" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setPayModal(null)} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2 transition-colors">Cancel</button>
                <button onClick={confirmPay} disabled={busy === payModal}
                  className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
                  {busy === payModal ? "Saving…" : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-surface border border-line-2 rounded-xl overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-line-2">
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Number</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Client</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Issue</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Due</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Total</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Profit</th>
              <th className="text-left px-4 py-3 text-[12px] font-medium text-muted">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inv, rowIdx) => {
              // Completed → actual profit. In-progress deal flow → projected
              // (revenue − supplier costs entered so far). Else fall back to costs.
              const df = flowMap[inv.id];
              let profit: number | null;
              let projected = false;
              if (inv.is_complete && inv.profit != null) {
                profit = inv.profit;
              } else if (df && df.stage !== "complete") {
                profit = inv.total - df.cost;
                projected = true;
              } else if (inv.profit != null) {
                profit = inv.profit;
              } else if (inv.total_cost != null) {
                profit = inv.total - inv.total_cost;
              } else {
                profit = null;
              }
              const voided = isVoided(inv);
              // R-234: when a search is running, show WHICH goods matched, with
              // what they fetched. That is the whole point of searching by item.
              const hits = searching ? matchingItems(parseLineItems(inv.line_items_json), qTokens) : [];
              return (
                <Fragment key={inv.id}>
                <tr className={`border-b border-line-2 last:border-0 hover:bg-surface-2 cursor-pointer transition-colors ${rowIdx % 2 === 1 ? "bg-surface-2/40" : ""} ${voided ? "opacity-55" : ""}`} onClick={() => openDetail(inv.id)}>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted">{inv.number}</td>
                  <td className="px-4 py-3 text-[13px] font-medium text-ink">{clientName(inv.client_id)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted tabular-nums">{inv.issue_date.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted tabular-nums">{inv.due_date.slice(0, 10)}</td>
                  <td className={`px-4 py-3 text-[13px] font-semibold text-ink tabular-nums ${voided ? "line-through" : ""}`}>{fmtAmount(inv.total)}</td>
                  <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${voided ? "text-faint" : profit != null ? (profit >= 0 ? "text-success-ink" : "text-danger-ink") : "text-faint"}`}>
                    {profit != null ? (
                      <span className="inline-flex items-baseline gap-1" title={projected ? "Projected profit — revenue minus costs entered so far" : undefined}>
                        {fmtAmount(profit)}
                        {projected && <span className="text-[9px] font-semibold text-muted">Proj</span>}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-0 flex-wrap gap-y-1">
                      <StatusPill className={statusColor(inv)}>{statusLabel(inv)}</StatusPill>
                      {/* Deal flow progress dots — a completed invoice always shows all stages filled. */}
                      <FlowDots stage={inv.is_complete ? "complete" : inv.deal_flow_stage} />
                      {inv.deal_flow_id && refundMap[inv.deal_flow_id] && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-danger-ink ml-1.5">
                          <RotateCcw size={10} />
                          {refundMap[inv.deal_flow_id].remaining > 0 ? `Refund · ${fmtAmount(refundMap[inv.deal_flow_id].remaining)}` : "Refunded"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {/* Common actions inline; secondary and destructive ones live in the overflow menu. */}
                    <div className="inline-flex items-center gap-0.5">
                      <button title="Edit" onClick={() => { setEditing(inv); setShowForm(true); }}
                        className="flex items-center justify-center w-8 h-7 rounded-md text-faint hover:text-ink-2 hover:bg-surface-3 transition-colors">
                        <Edit2 size={13} />
                      </button>
                      {!voided && !inv.sent_at && (
                        <button title="Send invoice" onClick={() => handleSend(inv.id)}
                          className="flex items-center justify-center w-8 h-7 rounded-md text-faint hover:text-info-ink hover:bg-info-bg transition-colors"><Send size={13} /></button>
                      )}
                      {!voided && inv.status.toLowerCase() !== "paid" && (
                        <button title="Mark as paid" onClick={() => handleMarkPaid(inv.id)}
                          className="flex items-center justify-center w-8 h-7 rounded-md text-faint hover:text-success-ink hover:bg-success-bg transition-colors"><Check size={13} /></button>
                      )}
                      <RowActionsMenu>
                        {(close) => (
                          <>
                            <MenuItem icon={FileDown} label="Save PDF" onClick={() => { handlePdf(inv.id); close(); }} />
                            <MenuItem icon={ExternalLink} label="View" onClick={() => { api.openInvoicePdf(inv.id).catch((e: any) => toast(String(e), "error")); close(); }} />
                            {!voided && inv.is_complete && inv.deal_flow_id && (
                              <MenuItem icon={RotateCcw} label="Reopen deal" onClick={async () => {
                                close();
                                if (!confirm("Reopen this deal? It will move back to active Deal Flow.")) return;
                                try { await api.uncompleteDealFlow(inv.deal_flow_id!); await load(); }
                                catch (e: any) { toast(String(e), "error"); }
                              }} />
                            )}
                            {voided ? (
                              <MenuItem icon={RotateCcw} label="Restore invoice" onClick={() => { handleVoid(inv.id, false); close(); }} />
                            ) : (
                              <MenuItem icon={XCircle} label="Mark deal fell through" onClick={() => { handleVoid(inv.id, true); close(); }} />
                            )}
                            <div className="my-1 border-t border-line-2" />
                            <MenuItem icon={Trash2} danger label={confirmDelete === inv.id ? "Confirm delete" : "Delete"}
                              onClick={() => { const confirming = confirmDelete === inv.id; handleDelete(inv.id); if (confirming) close(); }} />
                          </>
                        )}
                      </RowActionsMenu>
                    </div>
                  </td>
                </tr>
                {hits.length > 0 && (
                  <tr className={`border-b border-line-2 cursor-pointer hover:bg-surface-2 ${voided ? "opacity-55" : ""}`} onClick={() => openDetail(inv.id)}>
                    <td colSpan={8} className="px-4 pb-2.5 pt-0">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 border-l-2 border-accent/40 ml-1">
                        {hits.map((it, n) => (
                          <span key={n} className="text-[12px] text-ink-2">
                            {it.description}
                            <span className="text-muted"> · {describeItem(it)}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <div className="w-10 h-10 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
                    <FileText size={16} className="text-muted" />
                  </div>
                  <p className="text-[15px] font-semibold text-ink mb-1">No invoices yet</p>
                  <p className="text-[13px] text-muted mb-4">Create your first invoice to send to a client</p>
                  <button onClick={() => { setEditing(null); setShowForm(true); }}
                    className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors">
                    <Plus size={13} /> Create invoice
                  </button>
                </td>
              </tr>
            ) : visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[13px] text-muted">
                  {search ? "No invoices match your search" : `No ${viewTab === "drafts" ? "draft" : viewTab} invoices`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {detailId && detailInvoice && (
        <InvoiceDetailPanel
          invoice={detailInvoice}
          onClose={() => { setDetailId(null); setDetailInvoice(null); }}
          onPdf={() => handlePdf(detailInvoice.id)}
          onResend={() => { if (confirm("Re-send this invoice?")) handleSend(detailInvoice.id); }}
          onDelete={async () => {
            if (!confirm("Move to Archive? You can restore it anytime.")) return;
            try { await api.deleteInvoice(detailInvoice.id); toast("Moved to Archive"); } catch (e: any) { toast(String(e), "error"); }
            setDetailId(null); setDetailInvoice(null); load();
          }}
          onVoid={async (voided) => {
            await handleVoid(detailInvoice.id, voided);
            api.getInvoice(detailInvoice.id).then(setDetailInvoice).catch(() => {});
          }}
          clientName={clientName(detailInvoice.client_id)}
        />
      )}
        </>
      )}
    </div>
  );
}

function InvoiceForm({ clients, initial, onClose }: { clients: Client[]; initial?: Invoice | null; onClose: () => void }) {
  const [clientId, setClientId]     = useState(initial?.client_id ?? clients[0]?.id ?? "");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientPicker, setShowClientPicker] = useState(true);
  const [createNew, setCreateNew]   = useState(false);
  const [newClient, setNewClient]   = useState({ name: "", email: "", phone: "", company: "" });
  const [dueDate, setDueDate]       = useState(() => initial ? initial.due_date.slice(0, 10) : localDay());
  const [issueDate, setIssueDate]   = useState(() => initial ? initial.issue_date.slice(0, 10) : localDay());
  const [taxRate, setTaxRate]       = useState<number>(initial && initial.subtotal > 0 ? Math.round((initial.tax / initial.subtotal) * 10000) / 100 : 0);
  const [notes, setNotes]           = useState(initial?.notes ?? "");
  const [recurring, setRecurring]   = useState("");
  // R-162 policy clauses. An EXISTING invoice shows the wording it was actually sent
  // under (frozen on the row) — never today's settings default, or reopening an old
  // invoice would silently restate it. A NEW one prefills from the default below.
  const [policyOn, setPolicyOn]     = useState(!!(initial?.return_policy || "").trim());
  const [policyText, setPolicyText] = useState(initial?.return_policy ?? "");
  const [noticeClause, setNoticeClause] = useState<[string, string] | null>(null);
  const [items, setItems]           = useState<LineItem[]>(() => {
    if (initial) {
      const parsed: LineItem[] = JSON.parse(initial.line_items_json || "[]");
      return parsed.length ? parsed : [{ description: "", qty: 1, rate: 0, amount: 0 }];
    }
    return [{ description: "", qty: 1, rate: 0, amount: 0 }];
  });
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [templates, setTemplates]   = useState<LineItemTemplate[]>([]);
  // Company info + branding drive the live in-app preview (same sources as Settings).
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>({ name: "", address: "", email: "", phone: "", tax_id: "" });
  const [template, setTemplate]       = useState<InvoiceTemplate>(DEFAULT_INVOICE_TEMPLATE);

  useEffect(() => { api.listLineItemTemplates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => {
    api.getCompanyInfo().then((c) => { if (c) setCompanyInfo(c); }).catch(() => {});
    api.getInvoiceTemplate().then((t) => { if (t) setTemplate(t); }).catch(() => {});
  }, []);

  // Credit guardrail: for a NEW invoice, warn if it would push the buyer over limit.
  const [credit, setCredit] = useState<{ credit_limit: number; exposure: number } | null>(null);
  useEffect(() => {
    if (initial || createNew || !clientId) { setCredit(null); return; }
    api.getClientCreditStatus(clientId).then(setCredit).catch(() => setCredit(null));
  }, [clientId, createNew, initial]);

  // R-243 store credit: money already owed back to this buyer, spent as a negative line
  // on their next invoice. Same trigger as the limit guardrail above — a NEW invoice for
  // an existing client. `creditApplied` is what this form has drawn down so far; it is
  // clamped against the lines actually present before any drawdown is recorded, so
  // deleting the line by hand cannot spend a credit.
  const [storeCredit, setStoreCredit] = useState<{ balance: number; entries: any[] } | null>(null);
  const [creditApplied, setCreditApplied] = useState(0);
  useEffect(() => {
    setCreditApplied(0);
    if (initial || createNew || !clientId) { setStoreCredit(null); return; }
    api.getClientCredit(clientId).then(setStoreCredit).catch(() => setStoreCredit(null));
  }, [clientId, createNew, initial]);

  const updateItem = (i: number, field: keyof LineItem, val: any) => {
    const copy = [...items];
    (copy[i] as any)[field] = val;
    if (field === "qty" || field === "rate") copy[i].amount = (copy[i].qty || 0) * (copy[i].rate || 0);
    setItems(copy);
  };

  // Standing clause config. The 24-hour notice is display-only here (it is a standing
  // term, set once in Settings); the return policy seeds a NEW invoice's editable box.
  useEffect(() => {
    api.getPolicyClauseSettings().then((c) => {
      if (c.notice_24h_enabled && c.notice_24h_text.trim()) setNoticeClause(["Notice", c.notice_24h_text]);
      if (!initial && c.return_policy_enabled && c.return_policy_text.trim()) {
        setPolicyOn(true);
        setPolicyText(c.return_policy_text);
      }
    }).catch(() => {});
  }, [initial]);

  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const overLimit = !!(credit && credit.credit_limit > 0 && credit.exposure + total > credit.credit_limit);

  // The date the credit was raised, printed on the line so the invoice says what it is
  // for. Entries come back newest-first, so this is the most recent one still owed.
  const creditIssuedOn = (() => {
    const issued = (storeCredit?.entries || []).find((e: any) => e.amount > 0 && e.created_at);
    if (!issued) return "";
    const d = new Date(issued.created_at);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  })();
  const creditLeft = Math.round(((storeCredit?.balance || 0) - creditApplied) * 100) / 100;

  // Never let the credit exceed what is being invoiced — a credit bigger than the goods
  // would make the invoice negative, and the remainder stays on the ledger for next time.
  const applyCredit = () => {
    const use = Math.round(Math.min(creditLeft, Math.max(subtotal, 0)) * 100) / 100;
    if (use <= 0) return;
    setItems([...items, {
      description: `Credit applied${creditIssuedOn ? ` — issued ${creditIssuedOn}` : ""}`,
      qty: 1, rate: -use, amount: -use,
    }]);
    setCreditApplied(creditApplied + use);
  };

  // Feed the live in-app preview with the current edits; missing fields fall back
  // to sample content inside InvoicePreview.
  const selectedClient = clients.find((c) => c.id === clientId);
  const fmtPreviewDate = (d: string) => d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
  const previewData = {
    clientName: createNew ? (newClient.name.trim() || "New client") : (selectedClient?.name || "—"),
    clientAddress: createNew ? "" : [selectedClient?.street_address, selectedClient?.city, selectedClient?.state, selectedClient?.zip_code].filter(Boolean).join(", "),
    number: initial?.number,
    issueDate: fmtPreviewDate(issueDate),
    dueDate: fmtPreviewDate(dueDate),
    items: items.filter((it) => it.description.trim() || it.amount),
    taxRate,
    notes,
    clauses: [
      ...(noticeClause ? [noticeClause] : []),
      ...(policyOn && policyText.trim() ? [["Return policy", policyText] as [string, string]] : []),
    ] as [string, string][],
  };

  // Opens the real generated PDF in the OS viewer. Disabled for a brand-new,
  // unsaved client (there is no client_id to render against yet).
  const handlePreview = async () => {
    if (items.length === 0) return;
    setPreviewing(true);
    try {
      await api.previewInvoicePdf({ client_id: clientId, due_date: dueDate, issue_date: issueDate, line_items: items, tax_rate: taxRate / 100, notes: notes || undefined });
    } catch (e: any) { toast(`Preview failed: ${e}`, "error"); }
    finally { setPreviewing(false); }
  };

  const submit = async () => {
    if (items.length === 0) return;
    setSubmitting(true);
    try {
      let cid = clientId;
      if (createNew) {
        if (!newClient.name.trim()) { toast("Client name required", "error"); setSubmitting(false); return; }
        const created = await api.createClient({ name: newClient.name.trim(), email: newClient.email.trim() || undefined, phone: newClient.phone.trim() || undefined, company: newClient.company.trim() || undefined });
        cid = created.id;
      }
      // "" (not undefined) when the toggle is off, so switching it off on an existing
      // invoice actually clears the stored clause instead of merging the old one back.
      const data = { due_date: dueDate, issue_date: issueDate, line_items: items, tax_rate: taxRate / 100, notes: notes || undefined, recurring: recurring || undefined, return_policy: policyOn ? policyText : "" };
      if (initial) await api.updateInvoice(initial.id, data);
      else {
        const invId = await api.createInvoice({ ...data, client_id: cid });
        // Draw the credit down only for what the invoice actually carries: if the line
        // was deleted again by hand, `negTotal` is 0 and nothing is spent.
        const negTotal = -items.reduce((sum, it) => sum + Math.min(it.amount, 0), 0);
        const draw = Math.round(Math.min(creditApplied, negTotal) * 100) / 100;
        if (draw > 0) {
          const number = await api.getInvoice(invId).then((v) => v?.number).catch(() => "");
          await api.addClientCredit(cid, -draw, { kind: "applied", note: number ? `Applied to invoice ${number}` : "Applied to an invoice" })
            .catch((e: any) => toast(`Invoice created, but the credit was not drawn down: ${e}`, "error"));
        }
      }
      onClose();
    } catch (e: any) { toast(String(e), "error"); }
    finally { setSubmitting(false); }
  };

  const filteredClients = clientSearch ? clients.filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase())) : clients;

  return (
    <div className="flex flex-col xl:flex-row gap-5 items-start mb-4">
      <div className="w-full xl:flex-1 min-w-0 bg-surface border border-line rounded-xl p-6 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-[14px] font-semibold text-ink">{initial ? "Edit invoice" : "New invoice"}</h3>
        <button onClick={onClose} className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><X size={16} /></button>
      </div>

      {/* New invoice: full header including client picker */}
      {!initial && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
          <Field label="Client">
            {!createNew && !showClientPicker && clientId ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-ink font-medium">{clients.find((c) => c.id === clientId)?.name ?? "Unknown"}</span>
                <button type="button" onClick={() => { setShowClientPicker(true); setClientSearch(""); }}
                  className="text-[11px] text-accent hover:text-accent-hover underline">Change</button>
              </div>
            ) : (
              <>
                <input className={inp} placeholder="Type to search clients…" value={clientSearch}
                  onChange={(e) => { setClientSearch(e.target.value); }}
                  onFocus={() => setShowClientPicker(true)} />
                {showClientPicker && (
                  <div className="border border-line rounded-lg mt-1 max-h-[160px] overflow-y-auto bg-surface">
                    {filteredClients.map((c) => (
                      <button key={c.id} type="button"
                        onClick={() => { setClientId(c.id); setClientSearch(c.name); setShowClientPicker(false); setCreateNew(false); }}
                        className="w-full text-left px-3 py-2 text-[13px] hover:bg-accent/10 border-b border-line-2 last:border-0 transition-colors">
                        {c.name}
                      </button>
                    ))}
                    <button type="button"
                      onClick={() => { setCreateNew(true); setShowClientPicker(false); setClientSearch(""); }}
                      className="w-full text-left px-3 py-2 text-[13px] text-accent hover:bg-accent/10 transition-colors">
                      + Create new client
                    </button>
                  </div>
                )}
              </>
            )}
            {createNew && (
              <div className="mt-2 space-y-2 p-3 bg-surface-2 rounded-lg border border-line">
                <input className={inp} placeholder="Client name" value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} />
                <input className={inp} placeholder="Email (optional)" value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} />
                <input className={inp} placeholder="Phone (optional)" value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} />
                <button type="button" onClick={() => { setCreateNew(false); setShowClientPicker(true); }}
                  className="text-[11px] text-muted hover:text-ink-2 underline">Cancel</button>
              </div>
            )}
          </Field>
          <Field label="Due date"><input type="date" className={inp} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Issue date"><input type="date" className={inp} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Tax %">
            <div className="relative">
              <NumberInput className={inp + " pr-8"} value={taxRate} onValue={(n) => setTaxRate(n)} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {/* Edit mode: show dates + tax (no client change) */}
      {initial && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5 p-4 bg-surface-2 border border-line rounded-xl">
          <div className="lg:col-span-3 text-[11px] text-warning-ink font-medium -mb-1">
            Editing a {initial.status.toLowerCase() === "paid" ? "paid" : "sent"} invoice — amounts and dates can be adjusted.
          </div>
          <Field label="Due date"><input type="date" className={inp} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Issue date"><input type="date" className={inp} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Tax %">
            <div className="relative">
              <NumberInput className={inp + " pr-8"} value={taxRate} onValue={(n) => setTaxRate(n)} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {!initial && createNew && (
        <div className="grid grid-cols-2 gap-4 mb-5 p-4 bg-accent/10 border border-accent/10 rounded-xl">
          <Field label="Name *"><input className={inp} value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} /></Field>
          <Field label="Email"><input className={inp} value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} /></Field>
          <Field label="Phone"><input className={inp} value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} /></Field>
          <Field label="Company"><input className={inp} value={newClient.company} onChange={(e) => setNewClient({ ...newClient, company: e.target.value })} /></Field>
        </div>
      )}

      {/* R-243. Sits directly above the line items because that is where it writes, and
          it is always visible rather than behind a hover — an owed credit forgotten at
          invoice time is money given away twice. */}
      {!initial && storeCredit && storeCredit.balance > 0 && (
        <div className="mb-5 p-4 bg-accent/10 border border-accent/10 rounded-xl flex items-center justify-between gap-4 flex-wrap">
          <div className="text-[13px] text-ink min-w-0">
            <strong className="font-semibold">You owe this buyer {fmtAmount(storeCredit.balance)} in credit.</strong>
            {creditIssuedOn ? ` Issued ${creditIssuedOn}.` : ""}
            {creditApplied > 0
              ? ` ${fmtAmount(creditApplied)} is on this invoice as a line below${creditLeft > 0 ? `, leaving ${fmtAmount(creditLeft)} for next time` : ""}.`
              : " Apply it and it comes off this invoice as a line."}
          </div>
          {creditLeft > 0 && subtotal > 0 && (
            <button type="button" onClick={applyCredit}
              className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors flex-shrink-0">
              Apply {fmtAmount(Math.min(creditLeft, subtotal))}
            </button>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="mb-5">
        <div className="grid grid-cols-12 gap-2 text-[12.5px] font-medium text-muted mb-2 px-1">
          <div className="col-span-6">Description</div>
          <div className="col-span-1">Qty</div>
          <div className="col-span-2">Rate</div>
          <div className="col-span-2">Amount</div>
          <div className="col-span-1"></div>
        </div>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-1.5">
            <input className="col-span-6 border border-line px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              value={it.description} onChange={(e) => updateItem(i, "description", e.target.value)} />
            <NumberInput className="col-span-1 border border-line px-2 h-9 rounded-lg text-[13px] text-center focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors"
              value={it.qty || ""} onValue={(n) => updateItem(i, "qty", n)} />
            <div className="col-span-2 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
              <NumberInput className="w-full border border-line pl-7 pr-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors"
                value={it.rate || ""} onValue={(n) => updateItem(i, "rate", n)} />
            </div>
            <input readOnly className="col-span-2 border border-line bg-surface-2 px-3 h-9 rounded-lg text-[13px] text-right text-muted tabular-nums"
              value={it.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} />
            <button onClick={() => setItems(items.filter((_, j) => j !== i))}
              className="col-span-1 text-faint hover:text-danger-ink flex items-center justify-center transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-3 mt-2">
          <button onClick={() => setItems([...items, { description: "", qty: 1, rate: 0, amount: 0 }])}
            className="text-[12px] font-medium text-accent hover:text-accent-hover flex items-center gap-1 transition-colors">
            <Plus size={13} /> Add line
          </button>
          {templates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted">Templates:</span>
              {templates.map((t) => (
                <button key={t.id} onClick={() => setItems([...items, { description: t.description, qty: t.qty, rate: t.rate, amount: t.qty * t.rate }])}
                  className="text-[11px] bg-surface-3 hover:bg-surface-3 px-2.5 py-1 rounded-full text-ink-2 transition-colors">
                  {t.description}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Return policy (R-162). Sits directly above Notes because it is a term, not an
          instruction — and because the toggle has to be visible on the row, never hidden
          behind a hover or a drawer. The box is prefilled from the settings default on a
          new invoice and freely editable per deal before finalizing. */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-1.5">
          <label className="text-[11px] font-medium text-muted">Return policy</label>
          {/* Same token treatment as the Settings clause switch: a white knob vanished
              against both the near-white OFF track and mono-dark's near-white accent,
              so an OFF toggle read as nothing at all. See ClauseSwitch in SettingsView.
              `left-0` is load-bearing: a button centres its content, so an absolute knob
              with no left anchors to the track's MIDPOINT, and translate-x-[22px] then
              threw it clean off the right edge — ON rendered as a solid accent blob with
              no knob at all. Same defect in the other button-based switches. */}
          <button type="button" onClick={() => setPolicyOn((v) => !v)} role="switch" aria-checked={policyOn}
            aria-label="Include the return policy on this invoice"
            className={`w-11 h-6 rounded-full relative transition-colors ring-1 ${policyOn ? "bg-accent ring-accent" : "bg-surface-3 ring-line-3"}`}>
            <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full shadow-sm transition-transform ${policyOn ? "bg-on-accent translate-x-[22px]" : "bg-faint translate-x-0.5"}`} />
          </button>
          {policyOn && !policyText.trim() && (
            <span className="text-[11px] text-muted">Add the wording in Settings, or type it here.</span>
          )}
        </div>
        {policyOn && (
          <textarea rows={3} className="border border-line px-3 py-2 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            placeholder="Return policy wording that prints on this invoice and repeats in the send email"
            value={policyText} onChange={(e) => setPolicyText(e.target.value)} />
        )}
        {noticeClause && (
          <p className="text-[11px] text-muted mt-1.5">
            The 24-hour notice also prints on this invoice. Edit it in Settings under Email.
          </p>
        )}
      </div>

      {/* Notes + recurring */}
      <div className="mb-5">
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-muted mb-1.5">Notes</label>
            <textarea rows={3} className="border border-line px-3 py-2 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
              placeholder="Shipping instructions, payment terms…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted mb-1.5">Recurring</label>
            <select className="border border-line px-3 h-10 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors"
              value={recurring} onChange={(e) => setRecurring(e.target.value)}>
              <option value="">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
            </select>
          </div>
        </div>
      </div>

      {/* Totals */}
      <div className="border-t border-line pt-4 flex justify-end">
        <div className="w-60 text-[13px] space-y-1.5">
          <Row label="Subtotal" value={subtotal} />
          <Row label={`Tax (${taxRate}%)`} value={tax} />
          <Row label="Total" value={total} bold />
        </div>
      </div>
      {overLimit && credit && (
        <div className="mt-4 bg-danger-bg border border-danger-ink/25 rounded-lg px-4 py-3">
          <span className="text-[13px] text-danger-ink">
            <strong>Over credit limit.</strong> This invoice ({fmtAmount(total)}) puts this buyer's open exposure at {fmtAmount(credit.exposure + total)}, above their {fmtAmount(credit.credit_limit)} limit. You can still create it.
          </span>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4 flex-wrap">
        <button onClick={onClose} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2 transition-colors">Cancel</button>
        <button onClick={handlePreview} disabled={previewing || items.length === 0 || createNew}
          title={createNew ? "Save the new client first to open the real PDF" : undefined}
          className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] flex items-center gap-1.5 disabled:opacity-40 transition-colors">
          <ExternalLink size={13} /> {previewing ? "Opening…" : "View actual PDF"}
        </button>
        <button onClick={submit} disabled={submitting || (!createNew && !clientId) || items.length === 0}
          className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
          {submitting ? "Saving…" : initial ? "Save changes" : "Create invoice"}
        </button>
      </div>
      </div>

      {/* Live in-app preview — reflects the current edits; the PDF stays the ground truth. */}
      <div className="w-full xl:w-[360px] xl:flex-shrink-0 xl:sticky xl:top-4">
        <div className="text-[12.5px] font-medium text-muted mb-2.5">Live preview</div>
        <InvoicePreview info={companyInfo} tpl={template} logoVersion={0} data={previewData} />
        <p className="text-[11px] text-muted mt-2 text-center">A close approximation — the PDF is the ground truth.</p>
      </div>
    </div>
  );
}

function InvoiceEditForm2({ invoice, onCancel, onSaved }: { invoice: Invoice; onCancel: () => void; onSaved: () => void }) {
  const [taxRate, setTaxRate] = useState(invoice.subtotal > 0 ? Math.round((invoice.tax / invoice.subtotal) * 10000) / 100 : 0);
  const [saving, setSaving] = useState(false);

  const items: any[] = JSON.parse(invoice.line_items_json || "[]");
  const subtotal = items.reduce((s: number, it: any) => s + it.amount, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateInvoice(invoice.id, {
        due_date: invoice.due_date,
        line_items: items,
        tax_rate: taxRate,
        notes: invoice.notes || undefined,
      });
      onSaved();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="border border-line rounded-xl p-5 mb-4">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Field label="Subtotal">
          <div className="border border-line px-3 h-9 rounded-lg text-[13px] text-muted bg-surface-2 flex items-center tabular-nums">{fmtAmount(subtotal)}</div>
        </Field>
        <Field label="Tax %">
          <div className="relative">
            <NumberInput className={inp + " pr-8"} value={taxRate} onValue={(n) => setTaxRate(n)} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">%</span>
          </div>
        </Field>
      </div>

      <div className="flex justify-between items-center py-3 border-t border-line mt-4">
        <div className="text-[14px] text-muted">Total: <span className="font-semibold text-ink">{fmtAmount(total)}</span></div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-4 h-9 rounded-lg text-[13px] text-muted hover:bg-surface-3 transition-colors">Cancel</button>
          <button onClick={save} disabled={saving} className="px-5 h-9 rounded-lg text-[13px] font-medium bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : "Update tax"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between tabular-nums ${bold ? "font-semibold text-[14px] pt-1.5 border-t border-line" : "text-ink-2"}`}>
      <span>{label}</span><span>{fmtAmount(value)}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}

// Per-row overflow menu for secondary + destructive actions. Positioned with
// fixed coords so it escapes the table's overflow-x-auto clipping.
function RowActionsMenu({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef  = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onScroll = () => close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) { close(); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  return (
    <>
      <button ref={btnRef} title="More actions" onClick={toggle}
        className={`flex items-center justify-center w-8 h-7 rounded-md transition-colors ${open ? "text-ink-2 bg-surface-3" : "text-faint hover:text-ink-2 hover:bg-surface-3"}`}>
        <MoreVertical size={13} />
      </button>
      {open && (
        <div ref={menuRef} className="fixed z-50 min-w-[184px] bg-surface border border-line rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.14)] py-1"
          style={{ top: pos.top, right: pos.right }}>
          {children(close)}
        </div>
      )}
    </>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: {
  icon: LucideIcon; label: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 h-8 text-[12.5px] text-left transition-colors ${danger ? "text-danger-ink hover:bg-danger-bg" : "text-ink-2 hover:bg-surface-2"}`}>
      <Icon size={13} className="flex-shrink-0" /> {label}
    </button>
  );
}

function InvoiceDetailPanel({ invoice, clientName, onClose, onPdf, onResend, onDelete, onVoid }: {
  invoice: Invoice; clientName: string; onClose: () => void;
  onPdf: () => void; onResend: () => void; onDelete: () => void;
  onVoid: (voided: boolean) => void;
}) {
  const voided = isVoided(invoice);
  const items: LineItem[]  = JSON.parse(invoice.line_items_json || "[]");

  // Load the deal flow behind this invoice (if any) so bank payments can be paired
  // right here. Voided/draft invoices with no flow simply won't show the panel.
  const [dealFlow, setDealFlow] = useState<DealFlow | null>(null);
  useEffect(() => {
    let alive = true;
    if (voided) { setDealFlow(null); return; }
    api.getDealFlowByInvoice(invoice.id).then((f) => { if (alive) setDealFlow(f); }).catch(() => {});
    return () => { alive = false; };
  }, [invoice.id, voided]);

  const statCol = (s: string) => {
    if (s === "void")    return "bg-surface-3 text-muted";
    if (s === "paid")    return invoice.is_complete ? "bg-success-bg text-success-ink" : "bg-warning-bg text-warning-ink";
    if (s === "sent")    return "bg-info-bg text-info-ink";
    if (s === "overdue") return "bg-danger-bg text-danger-ink";
    return "bg-surface-3 text-ink-2";
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-[480px] max-w-[92vw] bg-surface shadow-[0_0_50px_rgba(0,0,0,0.12)] h-full overflow-auto z-50 animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-surface/95 backdrop-blur-sm border-b border-line px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[14px] font-semibold text-ink font-mono">{invoice.number}</h3>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><X size={16} /></button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <StatusPill className={statCol(invoice.status.toLowerCase())}>{statusLabel(invoice)}</StatusPill>

          {voided && (
            <div className="flex items-center gap-2 bg-surface-2 border border-line rounded-xl px-4 py-3 text-[12.5px] text-ink-2">
              <XCircle size={15} className="text-muted flex-shrink-0" />
              <span>This deal fell through — the invoice is voided and excluded from receivables. Nothing was deleted; you can restore it.</span>
            </div>
          )}

          <div>
            <div className="text-[12.5px] font-medium text-muted mb-0.5">Client</div>
            <div className="text-[14px] font-medium text-ink mt-0.5">{clientName}</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Issue date", val: invoice.issue_date.slice(0, 10) },
              { label: "Due date",   val: invoice.due_date.slice(0, 10) },
              ...(invoice.sent_at ? [{ label: "Sent", val: new Date(invoice.sent_at).toLocaleDateString() }] : []),
            ].map((r) => (
              <div key={r.label}>
                <div className="text-[12.5px] font-medium text-muted">{r.label}</div>
                <div className="text-[13px] text-ink mt-0.5 tabular-nums">{r.val}</div>
              </div>
            ))}
          </div>

          {/* Line items */}
          <div>
            <div className="text-[12.5px] font-medium text-muted mb-2">Line items</div>
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2 rounded-lg">
                <tr>
                  <th className="text-left px-3 py-2 text-[12px] font-medium text-muted rounded-l-lg">Description</th>
                  <th className="text-right px-3 py-2 text-[12px] font-medium text-muted">Qty</th>
                  <th className="text-right px-3 py-2 text-[12px] font-medium text-muted">Rate</th>
                  <th className="text-right px-3 py-2 text-[12px] font-medium text-muted rounded-r-lg">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-line-2">
                    <td className="px-3 py-2.5 text-ink-2">{it.description}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{it.qty}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{fmtAmount(it.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtAmount(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-line pt-4 space-y-1.5 text-[13px]">
            <div className="flex justify-between text-ink-2"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(invoice.subtotal)}</span></div>
            <div className="flex justify-between text-ink-2"><span>Tax</span><span className="tabular-nums">{fmtAmount(invoice.tax)}</span></div>
            <div className="flex justify-between font-semibold text-[14px] text-ink pt-1.5 border-t border-line">
              <span>Total</span><span className="tabular-nums">{fmtAmount(invoice.total)}</span>
            </div>
          </div>

          {invoice.notes && (
            <div className="bg-surface-2 border border-line px-4 py-3 rounded-xl text-[12px] text-ink-2">
              {invoice.notes}
            </div>
          )}

          {/* Cost & profit — the DEAL's costs, with supplier search. Never stored on the
              invoice: `/costs` writes the same three columns the deal-flow pipeline owns,
              so a cost typed against an invoice fights the deal for them and is reverted
              the next time it recomputes. No deal yet → nothing to cost, and no editor. */}
          {dealFlow && (
            <InvoiceCostSection
              flow={dealFlow}
              invoiceTotal={invoice.total}
              onReload={() => api.getDealFlowByInvoice(invoice.id).then(setDealFlow).catch(() => {})}
            />
          )}

          {/* Pair the buyer payment to this invoice's deal, then run any refund. */}
          {dealFlow && <ReconciliationPanel flow={dealFlow} />}
          {dealFlow && <RefundWorkspace dealFlowId={dealFlow.id} />}
        </div>

        <div className="sticky bottom-0 bg-surface/95 backdrop-blur-sm border-t border-line px-6 py-4 space-y-2.5">
          <button onClick={async () => { try { await api.openInvoicePdf(invoice.id); } catch (e: any) { toast(String(e), "error"); } }}
            title="Open the invoice PDF in your browser"
            className="w-full bg-surface border border-line hover:bg-surface-2 text-ink-2 h-10 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-2">
            <ExternalLink size={15} /> View invoice
          </button>
          <button onClick={onPdf} title="Save the invoice PDF to your invoices folder"
            className="w-full bg-accent hover:bg-accent-hover text-on-accent h-10 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-2">
            <Download size={15} /> Download PDF
          </button>
          {voided ? (
            <div className="flex gap-2.5">
              <button onClick={() => onVoid(false)} title="Restore this voided invoice"
                className="flex-1 bg-surface border border-line hover:bg-success-bg hover:border-success text-ink-2 hover:text-success-ink h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <RotateCcw size={13} /> Un-void invoice
              </button>
              <button onClick={onDelete} title="Move to Archive (restorable)"
                className="flex-1 bg-surface border border-danger hover:bg-danger-bg text-danger-ink h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <Trash2 size={13} /> Delete
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2.5">
                <button onClick={onResend} title={invoice.sent_at ? "Resend invoice" : "Send invoice"}
                  className="flex-1 bg-surface border border-line hover:bg-surface-2 text-ink-2 h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                  <Send size={13} /> {invoice.sent_at ? "Resend" : "Send"}
                </button>
                <button onClick={async () => { try { await api.createPaymentRequest(invoice.id); } catch(e: any) { toast(String(e), "error"); } }}
                  className="flex-1 bg-surface border border-line hover:bg-accent/10 hover:border-accent/30 text-accent h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5"
                  title="Request payment via Stripe">
                  <CreditCard size={13} /> Pay
                </button>
                <button onClick={onDelete} title="Move to Archive (restorable)"
                  className="flex-1 bg-surface border border-danger hover:bg-danger-bg text-danger-ink h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                  <Trash2 size={13} /> Delete
                </button>
              </div>
              <button onClick={() => onVoid(true)} title="Void this invoice — drops it from receivables; nothing is deleted"
                className="w-full bg-surface border border-line hover:bg-warning-bg hover:border-warning text-muted hover:text-warning-ink h-9 rounded-lg text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5">
                <XCircle size={13} /> Mark deal fell through
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
