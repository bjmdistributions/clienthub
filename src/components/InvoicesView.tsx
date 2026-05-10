import { useEffect, useState } from "react";
import { api, Client, Invoice, LineItem } from "../lib/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  FileDown,
  Send,
  Plus,
  X,
  Sparkles,
  Check,
  Trash2,
  RefreshCw,
  Eye,
  Edit2,
} from "lucide-react";

const fmtAmount = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InvoicesView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setInvoices(await api.listInvoices());
    setClients(await api.listClients());
  };
  useEffect(() => { load(); }, []);

  const handlePdf = async (id: string) => {
    setBusy(id);
    try { const path = await api.generateInvoicePdf(id); alert(`PDF saved:\n${path}`); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const handleSend = async (id: string) => {
    if (!confirm("Send invoice via email to the client?")) return;
    setBusy(id);
    try { await api.sendInvoice(id); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
    finally { setBusy(null); }
  };

  const handleMarkPaid = async (id: string) => {
    setBusy(id);
    try { await api.markInvoicePaid(id); load(); }
    finally { setBusy(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this draft invoice?")) return;
    try { await api.deleteInvoice(id); load(); }
    catch (e: any) { alert(`Error: ${e}`); }
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  const statusColor = (s: string) => {
    if (s === "paid") return "bg-green-100 text-green-700";
    if (s === "sent") return "bg-blue-100 text-blue-700";
    if (s === "overdue") return "bg-red-100 text-red-700";
    return "bg-slate-100 text-slate-700";
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Invoices</h2>
        <button onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded text-sm">
          <Plus size={16} /> New Invoice
        </button>
      </div>

      {showForm && (
        <InvoiceForm clients={clients} initial={editing}
          onClose={() => { setShowForm(false); setEditing(null); load(); }} />
      )}

      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left p-3">Number</th>
              <th className="text-left p-3">Client</th>
              <th className="text-left p-3">Issue</th>
              <th className="text-left p-3">Due</th>
              <th className="text-left p-3">Total</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-t hover:bg-slate-50">
                <td className="p-3 font-mono text-xs">{inv.number}</td>
                <td className="p-3">{clientName(inv.client_id)}</td>
                <td className="p-3">{inv.issue_date.slice(0, 10)}</td>
                <td className="p-3">{inv.due_date.slice(0, 10)}</td>
                <td className="p-3 font-semibold">{fmtAmount(inv.total)}</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 text-xs rounded ${statusColor(inv.status)}`}>{inv.status}</span>
                </td>
                <td className="p-3 text-right space-x-2">
                  {inv.status === "draft" && (
                    <>
                      <button title="Edit"
                        onClick={() => { setEditing(inv); setShowForm(true); }}
                        className="text-slate-600 hover:text-slate-900">
                        <Edit2 size={14} />
                      </button>
                      <button title="Delete" onClick={() => handleDelete(inv.id)}
                        className="text-red-500 hover:text-red-700">
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                  <button title="Generate PDF" onClick={() => handlePdf(inv.id)}
                    disabled={busy === inv.id}
                    className="text-slate-600 hover:text-slate-900 disabled:opacity-50">
                    {busy === inv.id ? <RefreshCw size={14} className="animate-spin inline" /> : <FileDown size={14} />}
                  </button>
                  {inv.status !== "paid" && (
                    <>
                      <button title="Send invoice" onClick={() => handleSend(inv.id)}
                        className="text-slate-600 hover:text-slate-900">
                        <Send size={14} />
                      </button>
                      <button title="Mark as paid" onClick={() => handleMarkPaid(inv.id)}
                        className="text-green-600 hover:text-green-800">
                        <Check size={14} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">No invoices yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceForm({
  clients, initial, onClose,
}: { clients: Client[]; initial?: Invoice | null; onClose: () => void }) {
  const [clientId, setClientId] = useState(initial?.client_id ?? clients[0]?.id ?? "");
  const [createNew, setCreateNew] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", email: "", phone: "", company: "" });
  const [dueDate, setDueDate] = useState(() => {
    if (initial) return initial.due_date.slice(0, 10);
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [taxRate, setTaxRate] = useState(0);
  const [items, setItems] = useState<LineItem[]>(() => {
    if (initial) {
      const parsed: LineItem[] = JSON.parse(initial.line_items_json || "[]");
      return parsed.length ? parsed : [{ description: "", qty: 1, rate: 0, amount: 0 }];
    }
    return [{ description: "", qty: 1, rate: 0, amount: 0 }];
  });
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<string | null>(null);

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

  const handleAiSuggest = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const result = await api.aiSuggestInvoice(aiPrompt);
      if (result.items?.length) setItems(result.items);
      if (result.suggested_due_days) {
        const d = new Date(); d.setDate(d.getDate() + result.suggested_due_days);
        setDueDate(d.toISOString().slice(0, 10));
      }
    } catch (e: any) { alert(`AI error: ${e}`); }
    finally { setAiBusy(false); }
  };

  const handlePreview = async () => {
    if (items.length === 0) return;
    const cid = createNew ? undefined : clientId;
    if (!cid && !createNew) return;
    setPreviewing(true);
    try {
      const path = await api.previewInvoicePdf({
        client_id: cid || clientId, due_date: dueDate, line_items: items, tax_rate: taxRate / 100,
      });
      setPreviewData(convertFileSrc(path));
    } catch (e: any) { alert(`Preview error: ${e}`); }
    finally { setPreviewing(false); }
  };

  const submit = async () => {
    if (items.length === 0) return;
    setSubmitting(true);
    try {
      let cid = clientId;
      if (createNew) {
        if (!newClient.name.trim()) { alert("Client name is required."); setSubmitting(false); return; }
        const created = await api.createClient({
          name: newClient.name.trim(),
          email: newClient.email.trim() || undefined,
          phone: newClient.phone.trim() || undefined,
          company: newClient.company.trim() || undefined,
        });
        cid = created.id;
      }
      if (initial) {
        await api.updateInvoice(initial.id, { due_date: dueDate, line_items: items, tax_rate: taxRate / 100 });
      } else {
        await api.createInvoice({ client_id: cid, due_date: dueDate, line_items: items, tax_rate: taxRate / 100 });
      }
      onClose();
    } catch (e: any) { alert(`Error: ${e}`); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="bg-white rounded-lg shadow p-5 mb-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold">{initial ? "Edit Invoice" : "New Invoice"}</h3>
        <button onClick={onClose}><X size={18} /></button>
      </div>

      {!initial && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Field label="Client">
            <select className="border p-2 rounded w-full"
              value={createNew ? "__new__" : clientId}
              onChange={(e) => { const v = e.target.value; if (v === "__new__") setCreateNew(true); else { setCreateNew(false); setClientId(v); } }}>
              {clients.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              <option value="__new__">+ Create new client</option>
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" className="border p-2 rounded w-full" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Tax %">
            <input type="number" step="0.01" className="border p-2 rounded w-full" value={taxRate} onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)} />
          </Field>
        </div>
      )}

      {initial && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Field label="Due date">
            <input type="date" className="border p-2 rounded w-full" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Tax %">
            <input type="number" step="0.01" className="border p-2 rounded w-full" value={taxRate} onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)} />
          </Field>
        </div>
      )}

      {!initial && createNew && (
        <div className="grid grid-cols-2 gap-3 mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
          <Field label="Name *">
            <input className="border p-2 rounded w-full" value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <input className="border p-2 rounded w-full" value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input className="border p-2 rounded w-full" value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} />
          </Field>
          <Field label="Company">
            <input className="border p-2 rounded w-full" value={newClient.company} onChange={(e) => setNewClient({ ...newClient, company: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="bg-violet-50 border border-violet-200 rounded p-3 mb-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-violet-900 mb-2">
          <Sparkles size={14} /> AI Assist
        </div>
        <div className="flex gap-2">
          <input className="border border-violet-300 p-2 rounded flex-1 text-sm"
            placeholder="Describe the work..." value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
          <button onClick={handleAiSuggest} disabled={aiBusy || !aiPrompt}
            className="bg-violet-600 text-white px-3 rounded text-sm disabled:opacity-50">
            {aiBusy ? <RefreshCw size={14} className="animate-spin" /> : "Suggest"}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <div className="grid grid-cols-12 gap-2 text-xs font-semibold text-slate-600 mb-1 px-1">
          <div className="col-span-6">Description</div>
          <div className="col-span-1">Qty</div>
          <div className="col-span-2">Rate</div>
          <div className="col-span-2">Amount</div>
          <div className="col-span-1"></div>
        </div>
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 mb-1">
            <input className="col-span-6 border p-2 rounded text-sm" value={it.description}
              onChange={(e) => updateItem(i, "description", e.target.value)} />
            <input type="number" className="col-span-1 border p-2 rounded text-sm" value={it.qty}
              onChange={(e) => updateItem(i, "qty", parseFloat(e.target.value) || 0)} />
            <input type="number" className="col-span-2 border p-2 rounded text-sm" value={it.rate}
              onChange={(e) => updateItem(i, "rate", parseFloat(e.target.value) || 0)} />
            <input readOnly className="col-span-2 border p-2 rounded text-sm bg-slate-50"
              value={it.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} />
            <button onClick={() => removeRow(i)} className="col-span-1 text-red-500 hover:text-red-700">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button onClick={addRow} className="text-sm text-slate-600 hover:text-slate-900 mt-2 flex items-center gap-1">
          <Plus size={14} /> Add line
        </button>
      </div>

      <div className="border-t pt-3 flex justify-end">
        <div className="w-64 text-sm space-y-1">
          <Row label="Subtotal" value={subtotal} />
          <Row label={`Tax (${taxRate}%)`} value={tax} />
          <Row label="Total" value={total} bold />
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm">Cancel</button>
        <button onClick={handlePreview} disabled={previewing || items.length === 0}
          className="bg-slate-100 text-slate-700 px-4 py-2 rounded text-sm flex items-center gap-1 disabled:opacity-50">
          <Eye size={14} /> {previewing ? "Generating..." : "Preview"}
        </button>
        <button onClick={submit}
          disabled={submitting || (!createNew && !clientId) || items.length === 0}
          className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
          {submitting ? "Saving..." : initial ? "Save Changes" : "Create Invoice"}
        </button>
      </div>

      {previewData && (
        <div className="mt-4 border rounded overflow-hidden">
          <div className="flex justify-between items-center bg-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">PDF Preview</span>
            <button onClick={() => setPreviewData(null)} className="text-slate-500 hover:text-slate-700"><X size={14} /></button>
          </div>
          <embed src={previewData} type="application/pdf" className="w-full h-[500px] border-0" />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold text-base" : ""}`}>
      <span>{label}</span>
      <span>{fmtAmount(value)}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
