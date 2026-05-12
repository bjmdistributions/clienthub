import { useEffect, useState } from "react";
import { api, Client, Invoice, LineItem, PaymentMethod, LineItemTemplate, CostItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { FileDown, Send, Plus, X, Check, Trash2, RefreshCw, Eye, Edit2, FileText, ChevronDown } from "lucide-react";

const statusColor = (s: string): string => {
  const lo = s.toLowerCase();
  if (lo === "paid")            return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (lo === "sent")            return "bg-blue-50 text-blue-700 border border-blue-200";
  if (lo === "overdue")         return "bg-red-50 text-red-700 border border-red-200";
  if (lo === "deposit_pending") return "bg-amber-50 text-amber-700 border border-amber-200";
  return "bg-gray-100 text-gray-600 border border-gray-200";
};

export default function InvoicesView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [payModal, setPayModal] = useState<string | null>(null);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState("");
  const [payRef, setPayRef] = useState("");
  const [payMethods, setPayMethods] = useState<PaymentMethod[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);

  const openDetail = async (id: string) => {
    setDetailId(id);
    try { setDetailInvoice(await api.getInvoice(id)); }
    catch { setDetailInvoice(null); }
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
    setPayMethod("");
    setPayRef("");
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

  const handleDeposit = async (id: string) => {
    if (!confirm("Mark as deposit pending?")) return;
    setBusy(id);
    try { await api.markInvoiceDepositPending(id); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  const outstanding = invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + i.total, 0);
  const overdueCount = invoices.filter((i) => i.status === "overdue").length;
  const paidCount    = invoices.filter((i) => i.status === "paid").length;

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-[18px] font-semibold text-gray-900">Invoices</h2>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium transition-colors"
        >
          <Plus size={16} /> New Invoice
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Total Invoices",  value: invoices.length,          color: "text-gray-900" },
          { label: "Outstanding",     value: fmtAmount(outstanding),   color: "text-amber-600" },
          { label: "Overdue",         value: overdueCount,             color: overdueCount > 0 ? "text-red-600" : "text-gray-400" },
          { label: "Paid",            value: paidCount,                color: "text-emerald-600" },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3.5">
            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">{s.label}</p>
            <p className={`text-[22px] font-bold tabular-nums mt-0.5 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 bg-gray-900 text-white px-4 py-2.5 rounded-lg shadow-lg text-[13px] z-50 flex items-center gap-2">
          <Check size={13} className="text-emerald-400" />
          {toast}
        </div>
      )}

      {/* Invoice form */}
      {showForm && (
        <InvoiceForm
          clients={clients}
          initial={editing}
          onClose={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}

      {/* Mark paid modal */}
      {payModal && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/30 backdrop-blur-[2px]"
          onClick={() => setPayModal(null)}
        >
          <div
            className="bg-white rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.08)] w-[420px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-[15px] font-semibold text-gray-900">Mark as Paid</h3>
              <button onClick={() => setPayModal(null)} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
                <X size={18} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Date</label>
                <input
                  type="date"
                  className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Method</label>
                <select
                  className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  <option value="">— select —</option>
                  {payMethods.map((m) => (<option key={m.id} value={m.label}>{m.label}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Reference (optional)</label>
                <input
                  className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="e.g. check #1234"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setPayModal(null)}
                  className="px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmPay}
                  disabled={busy === payModal}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"
                >
                  {busy === payModal ? "Saving..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Number</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Client</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Issue</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Due</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Total</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Profit</th>
              <th className="text-left px-4 py-3 text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr
                key={inv.id}
                className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => openDetail(inv.id)}
              >
                <td className="px-4 py-3 font-mono text-[13px] text-gray-600">{inv.number}</td>
                <td className="px-4 py-3 text-[14px] font-medium text-gray-900">{clientName(inv.client_id)}</td>
                <td className="px-4 py-3 text-[14px] text-gray-600 tabular-nums">{inv.issue_date.slice(0, 10)}</td>
                <td className="px-4 py-3 text-[14px] text-gray-600 tabular-nums">{inv.due_date.slice(0, 10)}</td>
                <td className="px-4 py-3 text-[14px] font-semibold text-gray-900 tabular-nums">{fmtAmount(inv.total)}</td>
                <td className={`px-4 py-3 text-[14px] font-semibold tabular-nums ${
                  (inv.profit ?? (inv.total_cost != null ? inv.total - (inv.total_cost ?? 0) : null)) != null
                    ? ((inv.profit ?? (inv.total_cost != null ? inv.total - (inv.total_cost ?? 0) : null))! >= 0 ? "text-emerald-600" : "text-red-600")
                    : "text-gray-400"
                }`}>
                  {inv.profit != null ? fmtAmount(inv.profit) : (inv.total_cost != null ? fmtAmount(inv.total - (inv.total_cost ?? 0)) : "—")}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide ${statusColor(inv.status)}`}>
                    {inv.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-0.5" onClick={(e) => e.stopPropagation()}>
                  {inv.status.toLowerCase() === "draft" && (
                    <>
                      <button title="Edit" onClick={() => { setEditing(inv); setShowForm(true); }}
                        className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100"><Edit2 size={14} /></button>
                      <button title="Deposit pending" onClick={() => handleDeposit(inv.id)}
                        className="text-amber-600 hover:text-amber-800 text-[12px] font-medium px-2 py-0.5 rounded hover:bg-amber-50">Deposit</button>
                    </>
                  )}
                  <button title="Delete" onClick={() => handleDelete(inv.id)}
                    className={confirmDelete === inv.id ? "text-red-600 font-medium text-[12px] px-2 py-0.5 rounded bg-red-50 hover:bg-red-100"
                      : "text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50"}>
                    {confirmDelete === inv.id ? "Sure?" : <Trash2 size={14} />}
                  </button>
                  <button title="Generate PDF" onClick={() => handlePdf(inv.id)} disabled={busy === inv.id}
                    className="text-gray-400 hover:text-indigo-600 p-1 rounded hover:bg-indigo-50 disabled:opacity-40">
                    {busy === inv.id ? <RefreshCw size={14} className="animate-spin" /> : <FileDown size={14} />}
                  </button>
                  {inv.status.toLowerCase() !== "paid" && (
                    <>
                      <button title="Send invoice" onClick={() => handleSend(inv.id)}
                        className="text-gray-400 hover:text-blue-600 p-1 rounded hover:bg-blue-50"><Send size={14} /></button>
                      <button title="Mark as paid" onClick={() => handleMarkPaid(inv.id)}
                        className="text-gray-400 hover:text-emerald-600 p-1 rounded hover:bg-emerald-50"><Check size={14} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center">
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                    <FileText size={18} className="text-gray-400" />
                  </div>
                  <p className="text-[16px] font-semibold text-gray-800 mb-1">No invoices yet</p>
                  <p className="text-[14px] text-gray-400 mb-4">Create your first invoice to send to a client</p>
                  <button
                    onClick={() => { setEditing(null); setShowForm(true); }}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium inline-flex items-center gap-2 transition-colors"
                  >
                    <Plus size={14} /> Create Invoice
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

function InvoiceForm({
  clients, initial, onClose,
}: { clients: Client[]; initial?: Invoice | null; onClose: () => void }) {
  const [clientId, setClientId] = useState(initial?.client_id ?? clients[0]?.id ?? "");
  const [clientSearch, setClientSearch] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", email: "", phone: "", company: "" });
  const [dueDate, setDueDate] = useState(() => {
    if (initial) return initial.due_date.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  });
  const [taxRate, setTaxRate] = useState<number>(
    initial && initial.subtotal > 0
      ? Math.round((initial.tax / initial.subtotal) * 10000) / 100
      : 0
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [recurring, setRecurring] = useState("");
  const [items, setItems] = useState<LineItem[]>(() => {
    if (initial) {
      const parsed: LineItem[] = JSON.parse(initial.line_items_json || "[]");
      return parsed.length ? parsed : [{ description: "", qty: 1, rate: 0, amount: 0 }];
    }
    return [{ description: "", qty: 1, rate: 0, amount: 0 }];
  });
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [templates, setTemplates] = useState<LineItemTemplate[]>([]);

  useEffect(() => {
    api.listLineItemTemplates().then(setTemplates).catch(() => {});
  }, []);

  const updateItem = (i: number, field: keyof LineItem, val: any) => {
    const copy = [...items];
    (copy[i] as any)[field] = val;
    if (field === "qty" || field === "rate") copy[i].amount = (copy[i].qty || 0) * (copy[i].rate || 0);
    setItems(copy);
  };
  const addRow = () => setItems([...items, { description: "", qty: 1, rate: 0, amount: 0 }]);
  const removeRow = (i: number) => setItems(items.filter((_, j) => j !== i));

  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;

  const handlePreview = async () => {
    if (items.length === 0) return;
    const cid = createNew ? undefined : clientId;
    if (!cid && !createNew) return;
    setPreviewing(true);
    try {
      await api.previewInvoicePdf({
        client_id: cid || clientId, due_date: dueDate, line_items: items, tax_rate: taxRate / 100,
        notes: notes || undefined,
      });
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
        const created = await api.createClient({
          name: newClient.name.trim(),
          email: newClient.email.trim() || undefined,
          phone: newClient.phone.trim() || undefined,
          company: newClient.company.trim() || undefined,
        });
        cid = created.id;
      }
      const data = { due_date: dueDate, line_items: items, tax_rate: taxRate / 100, notes: notes || undefined, recurring: recurring || undefined };
      if (initial) {
        await api.updateInvoice(initial.id, data);
      } else {
        await api.createInvoice({ ...data, client_id: cid });
      }
      onClose();
    } catch (e: any) { alert(`Error: ${e}`); }
    finally { setSubmitting(false); }
  };

  const filteredClients = clientSearch
    ? clients.filter((c) => c.name.toLowerCase().includes(clientSearch.toLowerCase()))
    : clients;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4">
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-[15px] font-semibold text-gray-900">{initial ? "Edit Invoice" : "New Invoice"}</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
          <X size={18} />
        </button>
      </div>

      {!initial && (
        <div className="grid grid-cols-3 gap-4 mb-5">
          <Field label="Client">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Type to search..."
              value={clientSearch}
              onChange={(e) => {
                setClientSearch(e.target.value);
                const match = clients.find((c) =>
                  c.name.toLowerCase().includes(e.target.value.toLowerCase())
                );
                if (match) setClientId(match.id);
              }}
            />
            <select
              className="border border-gray-300 px-3 rounded-md text-[14px] w-full mt-1 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={createNew ? "__new__" : clientId}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__new__") { setCreateNew(true); setClientSearch(""); }
                else {
                  setCreateNew(false);
                  setClientId(v);
                  const found = clients.find((c) => c.id === v);
                  if (found) setClientSearch(found.name);
                }
              }}
              size={Math.min(6, filteredClients.length + 1)}
            >
              {filteredClients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value="__new__">+ Create new client</option>
            </select>
          </Field>
          <Field label="Due date">
            <input
              type="date"
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
          <Field label="Tax %">
            <div className="relative">
              <input
                type="number"
                step="0.1"
                className="border border-gray-300 px-3 pr-8 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[14px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {initial && (
        <div className="grid grid-cols-2 gap-4 mb-5">
          <Field label="Due date">
            <input
              type="date"
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
          <Field label="Tax %">
            <div className="relative">
              <input
                type="number"
                step="0.1"
                className="border border-gray-300 px-3 pr-8 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-[14px]">%</span>
            </div>
          </Field>
        </div>
      )}

      {!initial && createNew && (
        <div className="grid grid-cols-2 gap-4 mb-5 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
          <Field label="Name *">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={newClient.name}
              onChange={(e) => setNewClient({ ...newClient, name: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={newClient.email}
              onChange={(e) => setNewClient({ ...newClient, email: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={newClient.phone}
              onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })}
            />
          </Field>
          <Field label="Company">
            <input
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={newClient.company}
              onChange={(e) => setNewClient({ ...newClient, company: e.target.value })}
            />
          </Field>
        </div>
      )}

      {/* Line items */}
      <div className="mb-5">
        <div className="grid grid-cols-12 gap-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 px-1">
          <div className="col-span-6">Description</div>
          <div className="col-span-1">Qty</div>
          <div className="col-span-2">Rate</div>
          <div className="col-span-2">Amount</div>
          <div className="col-span-1"></div>
        </div>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-1.5">
            <input
              className="col-span-6 border border-gray-300 px-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={it.description}
              onChange={(e) => updateItem(i, "description", e.target.value)}
            />
            <input
              type="number"
              step="1"
              className="col-span-1 border border-gray-300 px-2 h-9 rounded-md text-[14px] text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
              value={it.qty || ""}
              onChange={(e) => updateItem(i, "qty", e.target.value === "" ? 0 : parseFloat(e.target.value) || 0)}
            />
            <div className="col-span-2 relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-[14px]">$</span>
              <input
                type="number"
                step="0.01"
                className="w-full border border-gray-300 pl-7 pr-3 h-9 rounded-md text-[14px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={it.rate || ""}
                onChange={(e) => updateItem(i, "rate", e.target.value === "" ? 0 : parseFloat(e.target.value) || 0)}
              />
            </div>
            <input
              readOnly
              className="col-span-2 border border-gray-100 bg-gray-50 px-3 h-9 rounded-md text-[14px] text-right text-gray-600 tabular-nums"
              value={it.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            />
            <button
              onClick={() => removeRow(i)}
              className="col-span-1 text-gray-400 hover:text-red-600 flex items-center justify-center"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-3 mt-2">
          <button
            onClick={addRow}
            className="text-[13px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
          >
            <Plus size={14} /> Add line
          </button>
          {templates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] text-gray-400">Templates:</span>
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setItems([...items, { description: t.description, qty: t.qty, rate: t.rate, amount: t.qty * t.rate }])}
                  className="text-[11px] bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-full text-gray-600 transition-colors"
                >
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
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Notes</label>
            <textarea
              rows={3}
              className="border border-gray-300 px-3 py-2 rounded-md text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Shipping instructions, payment terms, special notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-gray-600 mb-1.5">Recurring</label>
            <select
              className="border border-gray-300 px-3 h-10 rounded-md text-[14px] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              value={recurring}
              onChange={(e) => setRecurring(e.target.value)}
            >
              <option value="">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annually">Annually</option>
            </select>
          </div>
        </div>
      </div>

      {/* Totals + actions */}
      <div className="border-t border-gray-200 pt-4 flex justify-end">
        <div className="w-64 text-[14px] space-y-1.5">
          <Row label="Subtotal" value={subtotal} />
          <Row label={`Tax (${taxRate}%)`} value={tax} />
          <Row label="Total" value={total} bold />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="px-4 h-9 text-[14px] text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handlePreview}
          disabled={previewing || items.length === 0}
          className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 h-9 rounded-md text-[14px] flex items-center gap-1.5 disabled:opacity-40"
        >
          <Eye size={14} /> {previewing ? "Opening..." : "Preview"}
        </button>
        <button
          onClick={submit}
          disabled={submitting || (!createNew && !clientId) || items.length === 0}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-md text-[14px] font-medium disabled:opacity-40"
        >
          {submitting ? "Saving..." : initial ? "Save Changes" : "Create Invoice"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between tabular-nums ${bold ? "font-semibold text-[15px] pt-1.5 border-t border-gray-200" : "text-gray-700"}`}>
      <span>{label}</span>
      <span>{fmtAmount(value)}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-gray-600 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function InvoiceDetailPanel({
  invoice, clientName, onClose, onPdf, onResend, onDelete, onCostSaved,
}: {
  invoice: Invoice;
  clientName: string;
  onClose: () => void;
  onPdf: () => void;
  onResend: () => void;
  onDelete: () => void;
  onCostSaved: () => void;
}) {
  const items: LineItem[] = JSON.parse(invoice.line_items_json || "[]");
  const costItems: CostItem[] = JSON.parse(invoice.cost_items_json || "[]");
  const [editingCosts, setEditingCosts] = useState(false);
  const [costs, setCosts] = useState<CostItem[]>(() =>
    costItems.length > 0 ? costItems : [{ description: "", amount: 0 }]
  );
  const [savingCosts, setSavingCosts] = useState(false);
  const statusCol = (s: string) => {
    if (s === "paid")            return "bg-emerald-50 text-emerald-700 border border-emerald-200";
    if (s === "sent")            return "bg-blue-50 text-blue-700 border border-blue-200";
    if (s === "overdue")         return "bg-red-50 text-red-700 border border-red-200";
    if (s === "deposit_pending") return "bg-amber-50 text-amber-700 border border-amber-200";
    return "bg-gray-100 text-gray-600 border border-gray-200";
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-[1px] z-40" onClick={onClose} />
      <div
        className="fixed inset-y-0 right-0 w-[480px] bg-white shadow-[0_0_40px_rgba(0,0,0,0.12)] h-full overflow-auto z-50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[16px] font-semibold text-gray-900 font-mono">{invoice.number}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 rounded hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Status */}
          <div>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide ${statusCol(invoice.status)}`}>
              {invoice.status}
            </span>
          </div>

          {/* Client */}
          <div>
            <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Client</div>
            <div className="text-[14px] font-medium text-gray-900 mt-0.5">{clientName}</div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Issue Date</div>
              <div className="text-[14px] text-gray-900 mt-0.5 tabular-nums">{invoice.issue_date.slice(0, 10)}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Due Date</div>
              <div className="text-[14px] text-gray-900 mt-0.5 tabular-nums">{invoice.due_date.slice(0, 10)}</div>
            </div>
            {invoice.sent_at && (
              <div>
                <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Sent</div>
                <div className="text-[14px] text-gray-900 mt-0.5">{new Date(invoice.sent_at).toLocaleDateString()}</div>
              </div>
            )}
            {invoice.status === "paid" && (
              <div>
                <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Paid At</div>
                <div className="text-[14px] text-gray-900 mt-0.5">—</div>
              </div>
            )}
          </div>

          {/* Line items */}
          <div>
            <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">Line Items</div>
            <table className="w-full text-[13px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Description</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Qty</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Rate</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-2.5 text-gray-700">{it.description}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{it.qty}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtAmount(it.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtAmount(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-200 pt-4 space-y-1.5 text-[14px]">
            <div className="flex justify-between text-gray-700">
              <span>Subtotal</span>
              <span className="tabular-nums">{fmtAmount(invoice.subtotal)}</span>
            </div>
            <div className="flex justify-between text-gray-700">
              <span>Tax</span>
              <span className="tabular-nums">{fmtAmount(invoice.tax)}</span>
            </div>
            <div className="flex justify-between font-semibold text-[15px] text-gray-900 pt-1.5 border-t border-gray-200">
              <span>Total</span>
              <span className="tabular-nums">{fmtAmount(invoice.total)}</span>
            </div>
           </div>

          {/* Cost & Profit */}
          <div className="border-t border-gray-200 pt-4">
            <button onClick={() => setEditingCosts(!editingCosts)}
              className="flex items-center gap-1 text-[13px] font-medium text-gray-600 hover:text-gray-900 w-full">
              <ChevronDown size={14} className={`transition-transform ${editingCosts ? "rotate-180" : ""}`} />
              Cost & Profit
            </button>
            {editingCosts && (
              <div className="mt-3 space-y-2">
                <div className="text-[12px] font-medium text-gray-500 uppercase tracking-wide mb-1">Cost Items</div>
                {costs.map((ci, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="flex-1 border border-gray-300 px-2 h-8 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="Description"
                      value={ci.description}
                      onChange={(e) => { const c = [...costs]; c[i] = { ...c[i], description: e.target.value }; setCosts(c); }}
                    />
                    <div className="relative w-28">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                      <input
                        type="number" step="0.01"
                        className="w-full border border-gray-300 pl-5 pr-2 h-8 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        value={ci.amount || ""}
                        onChange={(e) => { const c = [...costs]; c[i] = { ...c[i], amount: parseFloat(e.target.value) || 0 }; setCosts(c); }}
                      />
                    </div>
                    <button onClick={() => setCosts(costs.filter((_, j) => j !== i))}
                      className="text-gray-400 hover:text-red-500 p-1"><X size={12} /></button>
                  </div>
                ))}
                <button onClick={() => setCosts([...costs, { description: "", amount: 0 }])}
                  className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                  <Plus size={12} /> Add cost item
                </button>
                <div className="border-t border-gray-100 pt-2 space-y-1 text-[13px]">
                  <div className="flex justify-between text-gray-600"><span>Revenue</span><span>{fmtAmount(invoice.total)}</span></div>
                  <div className="flex justify-between text-gray-600"><span>Cost</span><span>{fmtAmount(costs.reduce((s, c) => s + c.amount, 0))}</span></div>
                  <div className={`flex justify-between font-semibold ${(invoice.total - costs.reduce((s, c) => s + c.amount, 0)) >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    <span>Profit</span><span>{fmtAmount(invoice.total - costs.reduce((s, c) => s + c.amount, 0))}</span>
                  </div>
                  <div className="flex justify-between text-gray-500 text-[12px]">
                    <span>Margin</span>
                    <span>{invoice.total > 0 ? ((invoice.total - costs.reduce((s, c) => s + c.amount, 0)) / invoice.total * 100).toFixed(1) : "0.0"}%</span>
                  </div>
                </div>
                <button onClick={async () => {
                  setSavingCosts(true);
                  try { await api.saveInvoiceCosts(invoice.id, costs); onCostSaved(); } catch (e: any) { alert(e); }
                  setSavingCosts(false);
                }}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-9 rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors">
                  {savingCosts ? "Saving..." : "Save Costs"}
                </button>
              </div>
            )}
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="bg-gray-50 border border-gray-100 px-4 py-3 rounded-lg text-[13px] text-gray-600">
              {invoice.notes}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex gap-3">
          <button
            onClick={onPdf}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-md text-[14px] font-medium flex-1 transition-colors"
          >
            Download PDF
          </button>
          <button
            onClick={onResend}
            className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-4 h-9 rounded-md text-[14px] flex-1 transition-colors"
          >
             Resend
          </button>
          <button
            onClick={onDelete}
            className="bg-white border border-red-200 hover:bg-red-50 text-red-600 px-3 h-9 rounded-md text-[13px] font-medium transition-colors flex items-center gap-1"
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </>
  );
}
