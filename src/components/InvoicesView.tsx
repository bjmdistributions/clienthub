import { useEffect, useState } from "react";
import { api, Client, Invoice, LineItem, PaymentMethod, LineItemTemplate, CostItem, ShippingInfo } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { FileDown, Send, Plus, X, Check, Trash2, RefreshCw, Eye, Edit2, FileText, ChevronDown, Package, GitBranch } from "lucide-react";

const statusColor = (inv: Invoice): string => {
  const s = inv.status;
  const lo = s.toLowerCase();
  if (lo === "paid" && inv.is_complete) return "bg-green-100 text-green-800";
  if (lo === "paid")                    return "bg-amber-100 text-amber-800";
  if (lo === "sent" || lo === "deposit_pending") return "bg-blue-100 text-blue-800";
  if (lo === "overdue")                 return "bg-red-100 text-red-800";
  return "bg-gray-100 text-gray-700";
};

const statusLabel = (inv: Invoice): string => {
  const lo = inv.status.toLowerCase();
  if (lo === "paid" && inv.is_complete) return "Completed";
  if (lo === "paid") return "Paid";
  if (lo === "deposit_pending") return "Sent";
  return inv.status.replace(/_/g, " ");
};

const FLOW_STAGES = ["invoiced", "payment_received", "supplier_paid", "complete"];
function flowStageSi(stage?: string | null): number {
  if (!stage) return -1;
  return FLOW_STAGES.indexOf(stage);
}

// Small 4-dot progress indicator for deal flow
function FlowDots({ stage }: { stage?: string | null }) {
  if (!stage) return null;
  const cur = flowStageSi(stage);
  const colors = ["bg-indigo-500", "bg-amber-400", "bg-violet-500", "bg-emerald-500"];
  return (
    <div className="flex items-center gap-0.5 ml-2">
      {FLOW_STAGES.map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all ${
            i <= cur
              ? `w-2 h-2 ${colors[i]}`
              : "w-1.5 h-1.5 bg-gray-200"
          }`}
        />
      ))}
    </div>
  );
}

const inp = "border border-gray-200 px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

export default function InvoicesView() {
  const [invoices, setInvoices]         = useState<Invoice[]>([]);
  const [clients, setClients]           = useState<Client[]>([]);
  const [showForm, setShowForm]         = useState(false);
  const [editing, setEditing]           = useState<Invoice | null>(null);
  const [busy, setBusy]                 = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [toast, setToast]               = useState<string | null>(null);
  const [payModal, setPayModal]         = useState<string | null>(null);
  const [payDate, setPayDate]           = useState(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod]       = useState("");
  const [payRef, setPayRef]             = useState("");
  const [payMethods, setPayMethods]     = useState<PaymentMethod[]>([]);
  const [detailId, setDetailId]         = useState<string | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);

  const openDetail = async (id: string) => {
    setDetailId(id);
    try { setDetailInvoice(await api.getInvoice(id)); } catch { setDetailInvoice(null); }
  };

  const load = async () => {
    const [inv, cli] = await Promise.all([api.listInvoices(), api.listClients()]);
    setInvoices(inv);
    setClients(cli);
  };
  useEffect(() => { load(); }, []);

  const handlePdf = async (id: string) => {
    setBusy(id);
    try {
      await api.generateInvoicePdf(id);
      setToast("PDF saved — check your invoices folder");
      setTimeout(() => setToast(null), 3000);
      load();
    } catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const handleSend = async (id: string) => {
    if (!confirm("Send invoice via email?")) return;
    setBusy(id);
    try { await api.sendInvoice(id); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const handleMarkPaid = (id: string) => {
    setPayModal(id);
    setPayDate(new Date().toISOString().slice(0, 10));
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
    } catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const handleDelete = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setConfirmDelete(null);
    try { await api.deleteInvoice(id); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;
  const outstanding   = invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + i.total, 0);
  const overdueCount  = invoices.filter((i) => i.status === "overdue").length;
  const paidCount     = invoices.filter((i) => i.status === "paid").length;
  const completedCount = invoices.filter((i) => i.is_complete).length;
  const sentCount     = invoices.filter((i) => i.status === "sent").length;
  const draftCount    = invoices.filter((i) => i.status === "draft").length;
  // Only count profit once a deal is fully closed (is_complete = true)
  const totalProfit   = invoices.filter((i) => i.is_complete).reduce((s, i) => s + (i.profit ?? 0), 0);

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Invoices</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">{invoices.length} total</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
        >
          <Plus size={14} /> New Invoice
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
        {[
          { label: "Total",          value: invoices.length,          color: "text-gray-900" },
          { label: "Completed",      value: completedCount,           color: completedCount > 0 ? "text-green-700" : "text-gray-400" },
          { label: "Paid",           value: paidCount - completedCount, color: (paidCount - completedCount) > 0 ? "text-amber-700" : "text-gray-400" },
          { label: "Sent",           value: sentCount,                color: sentCount > 0 ? "text-blue-700" : "text-gray-400" },
          { label: "Overdue",        value: overdueCount,             color: overdueCount > 0 ? "text-red-700" : "text-gray-400" },
          { label: "Total Profit",   value: fmtAmount(totalProfit),   color: totalProfit >= 0 ? "text-emerald-700" : "text-red-700" },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-gray-100 rounded-xl px-4 py-3.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">{s.label}</p>
            <p className={`text-[22px] font-bold tabular-nums ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 bg-[#1A1A1E] text-white px-4 py-2.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[13px] z-50 flex items-center gap-2 animate-fade-in">
          <Check size={12} className="text-emerald-400" /> {toast}
        </div>
      )}

      {/* Invoice form */}
      {showForm && (
        <InvoiceForm clients={clients} initial={editing} onClose={() => { setShowForm(false); setEditing(null); load(); }} />
      )}

      {/* Mark paid modal */}
      {payModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/25 backdrop-blur-[3px]" onClick={() => setPayModal(null)}>
          <div className="bg-white rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.14)] w-[420px] animate-fade-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-50">
              <h3 className="text-[14px] font-semibold text-gray-900">Mark as Paid</h3>
              <button onClick={() => setPayModal(null)} className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3.5">
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Date</label>
                <input type="date" className={inp} value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Method</label>
                <select className={inp} value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                  <option value="">— select —</option>
                  {payMethods.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Reference (optional)</label>
                <input className={inp} placeholder="e.g. check #1234" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setPayModal(null)} className="px-4 h-9 text-[13px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                <button onClick={confirmPay} disabled={busy === payModal}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
                  {busy === payModal ? "Saving..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-50">
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Number</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Client</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Issue</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Due</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Total</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Profit</th>
              <th className="text-left px-4 py-3 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const profit = inv.profit != null ? inv.profit : (inv.total_cost != null ? inv.total - (inv.total_cost ?? 0) : null);
              return (
                <tr key={inv.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/70 cursor-pointer transition-colors" onClick={() => openDetail(inv.id)}>
                  <td className="px-4 py-3 font-mono text-[11px] text-gray-400">{inv.number}</td>
                  <td className="px-4 py-3 text-[13px] font-medium text-gray-900">{clientName(inv.client_id)}</td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 tabular-nums">{inv.issue_date.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 tabular-nums">{inv.due_date.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-[13px] font-semibold text-gray-900 tabular-nums">{fmtAmount(inv.total)}</td>
                  <td className={`px-4 py-3 text-[13px] font-semibold tabular-nums ${profit != null ? (profit >= 0 ? "text-emerald-600" : "text-red-600") : "text-gray-300"}`}>
                    {profit != null ? fmtAmount(profit) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-0 flex-wrap gap-y-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${statusColor(inv)}`}>
                        {statusLabel(inv)}
                      </span>
                      {/* Deal flow progress dots */}
                      <FlowDots stage={inv.deal_flow_stage} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right space-x-0.5" onClick={(e) => e.stopPropagation()}>
                    <button title="Edit" onClick={() => { setEditing(inv); setShowForm(true); }}
                      className="text-gray-300 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors">
                      <Edit2 size={13} />
                    </button>
                    <button title="Delete" onClick={() => handleDelete(inv.id)}
                      className={confirmDelete === inv.id
                        ? "text-red-600 font-semibold text-[11px] px-2 py-0.5 rounded-md bg-red-50"
                        : "text-gray-300 hover:text-red-500 p-1 rounded-md hover:bg-red-50 transition-colors"}>
                      {confirmDelete === inv.id ? "Sure?" : <Trash2 size={13} />}
                    </button>
                    <button title="Generate PDF" onClick={() => handlePdf(inv.id)} disabled={busy === inv.id}
                      className="text-gray-300 hover:text-indigo-500 p-1 rounded-md hover:bg-indigo-50 disabled:opacity-40 transition-colors">
                      {busy === inv.id ? <RefreshCw size={13} className="animate-spin" /> : <FileDown size={13} />}
                    </button>
                    {inv.status.toLowerCase() !== "paid" && (
                      <>
                        <button title="Send invoice" onClick={() => handleSend(inv.id)}
                          className="text-gray-300 hover:text-blue-500 p-1 rounded-md hover:bg-blue-50 transition-colors"><Send size={13} /></button>
                        <button title="Mark as paid" onClick={() => handleMarkPaid(inv.id)}
                          className="text-gray-300 hover:text-emerald-500 p-1 rounded-md hover:bg-emerald-50 transition-colors"><Check size={13} /></button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                    <FileText size={16} className="text-gray-400" />
                  </div>
                  <p className="text-[15px] font-semibold text-gray-800 mb-1">No invoices yet</p>
                  <p className="text-[13px] text-gray-400 mb-4">Create your first invoice to send to a client</p>
                  <button onClick={() => { setEditing(null); setShowForm(true); }}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors">
                    <Plus size={13} /> Create Invoice
                  </button>
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
          onDelete={() => {
            if (confirm("Delete this invoice? This cannot be undone.")) {
              handleDelete(detailInvoice.id);
              setDetailId(null); setDetailInvoice(null);
            }
          }}
          onCostSaved={() => { setDetailInvoice(null); api.getInvoice(detailInvoice.id).then(setDetailInvoice); }}
          clientName={clientName(detailInvoice.client_id)}
        />
      )}
    </div>
  );
}

function InvoiceForm({ clients, initial, onClose }: { clients: Client[]; initial?: Invoice | null; onClose: () => void }) {
  const [clientId, setClientId]     = useState(initial?.client_id ?? clients[0]?.id ?? "");
  const [clientSearch, setClientSearch] = useState("");
  const [createNew, setCreateNew]   = useState(false);
  const [newClient, setNewClient]   = useState({ name: "", email: "", phone: "", company: "" });
  const [dueDate, setDueDate]       = useState(() => initial ? initial.due_date.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [issueDate, setIssueDate]   = useState(() => initial ? initial.issue_date.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [taxRate, setTaxRate]       = useState<number>(initial && initial.subtotal > 0 ? Math.round((initial.tax / initial.subtotal) * 10000) / 100 : 0);
  const [notes, setNotes]           = useState(initial?.notes ?? "");
  const [recurring, setRecurring]   = useState("");
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

  useEffect(() => { api.listLineItemTemplates().then(setTemplates).catch(() => {}); }, []);

  const updateItem = (i: number, field: keyof LineItem, val: any) => {
    const copy = [...items];
    (copy[i] as any)[field] = val;
    if (field === "qty" || field === "rate") copy[i].amount = (copy[i].qty || 0) * (copy[i].rate || 0);
    setItems(copy);
  };

  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const handlePreview = async () => {
    if (items.length === 0) return;
    setPreviewing(true);
    try {
      await api.previewInvoicePdf({ client_id: createNew ? clientId : clientId, due_date: dueDate, issue_date: issueDate, line_items: items, tax_rate: taxRate / 100, notes: notes || undefined });
    } catch (e: any) { alert(`Preview error: ${e}`); }
    finally { setPreviewing(false); }
  };

  const submit = async () => {
    if (items.length === 0) return;
    setSubmitting(true);
    try {
      let cid = clientId;
      if (createNew) {
        if (!newClient.name.trim()) { alert("Client name required."); setSubmitting(false); return; }
        const created = await api.createClient({ name: newClient.name.trim(), email: newClient.email.trim() || undefined, phone: newClient.phone.trim() || undefined, company: newClient.company.trim() || undefined });
        cid = created.id;
      }
      const data = { due_date: dueDate, issue_date: issueDate, line_items: items, tax_rate: taxRate / 100, notes: notes || undefined, recurring: recurring || undefined };
      if (initial) await api.updateInvoice(initial.id, data);
      else await api.createInvoice({ ...data, client_id: cid });
      onClose();
    } catch (e: any) { alert(`Error: ${e}`); }
    finally { setSubmitting(false); }
  };

  const filteredClients = clientSearch ? clients.filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase())) : clients;

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-6 mb-4 shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-[14px] font-semibold text-gray-900">{initial ? "Edit Invoice" : "New Invoice"}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100 transition-colors"><X size={16} /></button>
      </div>

      {/* New invoice: full header including client picker */}
      {!initial && (
        <div className="grid grid-cols-3 gap-4 mb-5">
          <Field label="Client">
            <input className={inp} placeholder="Type to search..." value={clientSearch}
              onChange={(e) => { setClientSearch(e.target.value); const match = clients.find((c) => c.name.toLowerCase().includes(e.target.value.toLowerCase())); if (match) setClientId(match.id); }} />
            <select className="border border-gray-200 px-3 rounded-lg text-[13px] w-full mt-1 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 bg-white"
              value={createNew ? "__new__" : clientId}
              onChange={(e) => { const v = e.target.value; if (v === "__new__") { setCreateNew(true); setClientSearch(""); } else { setCreateNew(false); setClientId(v); const found = clients.find((c) => c.id === v); if (found) setClientSearch(found.name); } }}
              size={Math.min(6, filteredClients.length + 1)}>
              {filteredClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new__">+ Create new client</option>
            </select>
          </Field>
          <Field label="Due date"><input type="date" className={inp} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Issue date"><input type="date" className={inp} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Tax %">
            <div className="relative">
              <input type="number" inputMode="decimal" step="0.1" className={inp + " pr-8"} value={taxRate} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); setTaxRate(isNaN(v) ? 0 : v); }} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[13px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {/* Edit mode: show dates + tax (no client change) */}
      {initial && (
        <div className="grid grid-cols-3 gap-4 mb-5 p-4 bg-amber-50/50 border border-amber-100 rounded-xl">
          <div className="col-span-3 text-[11px] text-amber-700 font-medium -mb-1">
            Editing a {initial.status.toLowerCase() === "paid" ? "paid" : "sent"} invoice — amounts and dates can be adjusted.
          </div>
          <Field label="Due date"><input type="date" className={inp} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Issue date"><input type="date" className={inp} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Tax %">
            <div className="relative">
              <input type="number" inputMode="decimal" step="0.1" className={inp + " pr-8"} value={taxRate} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); setTaxRate(isNaN(v) ? 0 : v); }} />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[13px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {!initial && createNew && (
        <div className="grid grid-cols-2 gap-4 mb-5 p-4 bg-indigo-50/60 border border-indigo-100 rounded-xl">
          <Field label="Name *"><input className={inp} value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} /></Field>
          <Field label="Email"><input className={inp} value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} /></Field>
          <Field label="Phone"><input className={inp} value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} /></Field>
          <Field label="Company"><input className={inp} value={newClient.company} onChange={(e) => setNewClient({ ...newClient, company: e.target.value })} /></Field>
        </div>
      )}

      {/* Line items */}
      <div className="mb-5">
        <div className="grid grid-cols-12 gap-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2 px-1">
          <div className="col-span-6">Description</div>
          <div className="col-span-1">Qty</div>
          <div className="col-span-2">Rate</div>
          <div className="col-span-2">Amount</div>
          <div className="col-span-1"></div>
        </div>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-1.5">
            <input className="col-span-6 border border-gray-200 px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
              value={it.description} onChange={(e) => updateItem(i, "description", e.target.value)} />
            <input type="number" inputMode="decimal" step="1" className="col-span-1 border border-gray-200 px-2 h-9 rounded-lg text-[13px] text-center focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
              value={it.qty || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); updateItem(i, "qty", e.target.value === "" ? 0 : isNaN(v) ? 0 : v); }} />
            <div className="col-span-2 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[13px]">$</span>
              <input type="number" inputMode="decimal" step="0.01" className="w-full border border-gray-200 pl-7 pr-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
                value={it.rate || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); updateItem(i, "rate", e.target.value === "" ? 0 : isNaN(v) ? 0 : v); }} />
            </div>
            <input readOnly className="col-span-2 border border-gray-100 bg-gray-50 px-3 h-9 rounded-lg text-[13px] text-right text-gray-500 tabular-nums"
              value={it.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} />
            <button onClick={() => setItems(items.filter((_, j) => j !== i))}
              className="col-span-1 text-gray-300 hover:text-red-500 flex items-center justify-center transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-3 mt-2">
          <button onClick={() => setItems([...items, { description: "", qty: 1, rate: 0, amount: 0 }])}
            className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors">
            <Plus size={13} /> Add line
          </button>
          {templates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400">Templates:</span>
              {templates.map((t) => (
                <button key={t.id} onClick={() => setItems([...items, { description: t.description, qty: t.qty, rate: t.rate, amount: t.qty * t.rate }])}
                  className="text-[11px] bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-full text-gray-600 transition-colors">
                  {t.description}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Notes + recurring */}
      <div className="mb-5">
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Notes</label>
            <textarea rows={3} className="border border-gray-200 px-3 py-2 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
              placeholder="Shipping instructions, payment terms..." value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1.5">Recurring</label>
            <select className="border border-gray-200 px-3 h-10 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
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
      <div className="border-t border-gray-100 pt-4 flex justify-end">
        <div className="w-60 text-[13px] space-y-1.5">
          <Row label="Subtotal" value={subtotal} />
          <Row label={`Tax (${taxRate}%)`} value={tax} />
          <Row label="Total" value={total} bold />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 h-9 text-[13px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handlePreview} disabled={previewing || items.length === 0}
          className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 h-9 rounded-lg text-[13px] flex items-center gap-1.5 disabled:opacity-40 transition-colors">
          <Eye size={13} /> {previewing ? "Opening..." : "Preview"}
        </button>
        <button onClick={submit} disabled={submitting || (!createNew && !clientId) || items.length === 0}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
          {submitting ? "Saving..." : initial ? "Save Changes" : "Create Invoice"}
        </button>
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
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  return (
    <div className="border border-gray-200 rounded-xl p-5 mb-4">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Field label="Subtotal">
          <div className="border border-gray-200 px-3 h-9 rounded-lg text-[13px] text-gray-500 bg-gray-50 flex items-center tabular-nums">{fmtAmount(subtotal)}</div>
        </Field>
        <Field label="Tax %">
          <div className="relative">
            <input type="number" inputMode="decimal" step="0.1" className={inp + " pr-8"} value={taxRate} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); setTaxRate(isNaN(v) ? 0 : v); }} />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[13px]">%</span>
          </div>
        </Field>
      </div>

      <div className="flex justify-between items-center py-3 border-t border-gray-100 mt-4">
        <div className="text-[14px] text-gray-500">Total: <span className="font-semibold text-gray-900">{fmtAmount(total)}</span></div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-4 h-9 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 transition-colors">Cancel</button>
          <button onClick={save} disabled={saving} className="px-5 h-9 rounded-lg text-[13px] font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {saving ? "Saving..." : "Update Tax"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between tabular-nums ${bold ? "font-semibold text-[14px] pt-1.5 border-t border-gray-100" : "text-gray-600"}`}>
      <span>{label}</span><span>{fmtAmount(value)}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function InvoiceDetailPanel({ invoice, clientName, onClose, onPdf, onResend, onDelete, onCostSaved }: {
  invoice: Invoice; clientName: string; onClose: () => void;
  onPdf: () => void; onResend: () => void; onDelete: () => void; onCostSaved: () => void;
}) {
  const items: LineItem[]  = JSON.parse(invoice.line_items_json || "[]");
  const costItems: CostItem[] = JSON.parse(invoice.cost_items_json || "[]");
  const [editingCosts, setEditingCosts]   = useState(false);
  const [costs, setCosts]                 = useState<CostItem[]>(() => costItems.length > 0 ? costItems : [{ description: "", amount: 0 }]);
  const [savingCosts, setSavingCosts]     = useState(false);
  const [editingShipping, setEditingShipping] = useState(invoice.status === "paid" && !invoice.is_complete);
  const [shipping, setShipping]           = useState<ShippingInfo>({ carrier: invoice.carrier ?? "", tracking_number: invoice.tracking_number ?? "", shipping_charged: invoice.shipping_charged ?? 0, pickup_date: invoice.pickup_date ?? "", delivery_date: invoice.delivery_date ?? "", is_complete: invoice.is_complete ?? false });
  const [savingShipping, setSavingShipping] = useState(false);

  const statCol = (s: string) => {
    if (s === "paid")    return invoice.is_complete ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";
    if (s === "sent")    return "bg-blue-100 text-blue-800";
    if (s === "overdue") return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-700";
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-[480px] bg-white shadow-[0_0_50px_rgba(0,0,0,0.12)] h-full overflow-auto z-50 animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[14px] font-semibold text-gray-900 font-mono">{invoice.number}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100 transition-colors"><X size={16} /></button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statCol(invoice.status)}`}>
            {invoice.status.replace(/_/g, " ")}
          </span>

          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-0.5">Client</div>
            <div className="text-[14px] font-medium text-gray-900 mt-0.5">{clientName}</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Issue Date", val: invoice.issue_date.slice(0, 10) },
              { label: "Due Date",   val: invoice.due_date.slice(0, 10) },
              ...(invoice.sent_at ? [{ label: "Sent", val: new Date(invoice.sent_at).toLocaleDateString() }] : []),
            ].map((r) => (
              <div key={r.label}>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{r.label}</div>
                <div className="text-[13px] text-gray-900 mt-0.5 tabular-nums">{r.val}</div>
              </div>
            ))}
          </div>

          {/* Line items */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Line Items</div>
            <table className="w-full text-[13px]">
              <thead className="bg-gray-50 rounded-lg">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest rounded-l-lg">Description</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Qty</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Rate</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest rounded-r-lg">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="px-3 py-2.5 text-gray-700">{it.description}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{it.qty}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-500">{fmtAmount(it.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtAmount(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-100 pt-4 space-y-1.5 text-[13px]">
            <div className="flex justify-between text-gray-600"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(invoice.subtotal)}</span></div>
            <div className="flex justify-between text-gray-600"><span>Tax</span><span className="tabular-nums">{fmtAmount(invoice.tax)}</span></div>
            <div className="flex justify-between font-semibold text-[14px] text-gray-900 pt-1.5 border-t border-gray-100">
              <span>Total</span><span className="tabular-nums">{fmtAmount(invoice.total)}</span>
            </div>
          </div>

          {/* Cost & Profit */}
          <div className="border-t border-gray-100 pt-4">
            <button onClick={() => setEditingCosts(!editingCosts)}
              className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-gray-900 w-full transition-colors">
              <ChevronDown size={13} className={`transition-transform ${editingCosts ? "rotate-180" : ""}`} />
              Cost & Profit
            </button>
            {editingCosts && (
              <div className="mt-3 space-y-2">
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Cost Items</div>
                {costs.map((ci, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input className="flex-1 border border-gray-200 px-2 h-8 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors" placeholder="Description"
                      value={ci.description} onChange={(e) => { const c = [...costs]; c[i] = { ...c[i], description: e.target.value }; setCosts(c); }} />
                    <div className="relative w-28">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[11px]">$</span>
                      <input type="number" inputMode="decimal" step="0.01" className="w-full border border-gray-200 pl-5 pr-2 h-8 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
                        value={ci.amount || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); const c = [...costs]; c[i] = { ...c[i], amount: isNaN(v) ? 0 : v }; setCosts(c); }} />
                    </div>
                    <button onClick={() => setCosts(costs.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500 p-1 transition-colors"><X size={12} /></button>
                  </div>
                ))}
                <button onClick={() => setCosts([...costs, { description: "", amount: 0 }])}
                  className="text-[11px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors">
                  <Plus size={11} /> Add cost item
                </button>
                <div className="border-t border-gray-100 pt-2 space-y-1 text-[12px]">
                  <div className="flex justify-between text-gray-500"><span>Revenue</span><span className="tabular-nums">{fmtAmount(invoice.total)}</span></div>
                  <div className="flex justify-between text-gray-500"><span>Cost</span><span className="tabular-nums">{fmtAmount(costs.reduce((s, c) => s + c.amount, 0))}</span></div>
                  <div className={`flex justify-between font-semibold ${(invoice.total - costs.reduce((s, c) => s + c.amount, 0)) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    <span>Profit</span><span className="tabular-nums">{fmtAmount(invoice.total - costs.reduce((s, c) => s + c.amount, 0))}</span>
                  </div>
                </div>
                <button onClick={async () => { setSavingCosts(true); try { await api.saveInvoiceCosts(invoice.id, costs); onCostSaved(); } catch (e: any) { alert(e); } setSavingCosts(false); }}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-9 rounded-lg text-[12px] font-medium transition-colors">
                  {savingCosts ? "Saving..." : "Save Costs"}
                </button>
              </div>
            )}
          </div>

          {/* Shipping */}
          <div className="border-t border-gray-100 pt-4">
            <button onClick={() => setEditingShipping(!editingShipping)}
              className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-gray-900 w-full transition-colors">
              <Package size={13} />
              <ChevronDown size={13} className={`transition-transform ${editingShipping ? "rotate-180" : ""}`} />
              Shipping
              {!invoice.is_complete && invoice.status === "paid" && <span className="text-amber-500 text-[11px] ml-1">— needs info</span>}
              {invoice.is_complete && <span className="text-emerald-500 text-[11px] ml-1">— complete</span>}
            </button>
            {editingShipping && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Carrier", key: "carrier" as const, type: "text", placeholder: "UPS / FedEx / etc." },
                    { label: "Tracking #", key: "tracking_number" as const, type: "text", placeholder: "1Z..." },
                    { label: "Pickup Date", key: "pickup_date" as const, type: "date", placeholder: "" },
                  ].map((f) => (
                    <div key={f.key}>
                      <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">{f.label}</label>
                      <input type={f.type} placeholder={f.placeholder}
                        className="mt-0.5 border border-gray-200 px-2 h-9 rounded-lg text-[12px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
                        value={(shipping[f.key] as string) || ""}
                        onChange={(e) => setShipping({ ...shipping, [f.key]: e.target.value })} />
                    </div>
                  ))}
                  <div>
                    <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">Shipping Charged</label>
                    <div className="relative mt-0.5">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[11px]">$</span>
                      <input type="number" inputMode="decimal" step="0.01" className="w-full border border-gray-200 pl-5 pr-2 h-9 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
                        value={shipping.shipping_charged || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); setShipping({ ...shipping, shipping_charged: isNaN(v) ? 0 : v }); }} />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-gray-400 uppercase tracking-widest">Delivery Date</label>
                  <input type="date" className="mt-0.5 border border-gray-200 px-2 h-9 rounded-lg text-[12px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 transition-colors"
                    value={shipping.delivery_date || ""} onChange={(e) => setShipping({ ...shipping, delivery_date: e.target.value })} />
                </div>
                <button onClick={async () => { setSavingShipping(true); try { await api.saveInvoiceShipping(invoice.id, shipping); } catch (e: any) { alert(e); } setSavingShipping(false); }}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-9 rounded-lg text-[12px] font-medium transition-colors">
                  {savingShipping ? "Saving..." : "Save Shipping"}
                </button>
              </div>
            )}
          </div>

          {invoice.notes && (
            <div className="bg-gray-50 border border-gray-100 px-4 py-3 rounded-xl text-[12px] text-gray-600">
              {invoice.notes}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white/95 backdrop-blur-sm border-t border-gray-100 px-6 py-4 flex gap-2.5">
          <button onClick={onPdf} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex-1 transition-colors">Download PDF</button>
          <button onClick={onResend} className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-lg text-[13px] flex-1 transition-colors">Resend</button>
          <button onClick={onDelete} className="bg-white border border-red-100 hover:bg-red-50 text-red-500 px-3 h-9 rounded-lg text-[12px] font-medium transition-colors flex items-center gap-1">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
    </>
  );
}
