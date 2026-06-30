import { useEffect, useState } from "react";
import { api, Client, RecurringInvoice, RecurringInvoiceInput, LineItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, Trash2, Pause, Play, Edit2 } from "lucide-react";

const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function RecurringView() {
  const [templates, setTemplates] = useState<RecurringInvoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RecurringInvoice | null>(null);
  const [clientId, setClientId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [taxRate, setTaxRate] = useState(0);
  const [items, setItems] = useState<LineItem[]>([{ description: "", qty: 1, rate: 0, amount: 0 }]);

  const load = async () => {
    setTemplates(await api.listRecurringInvoices());
    setClients(await api.listClients());
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setClientId("");
    setTemplateName("");
    setFrequency("monthly");
    setTaxRate(0);
    setItems([{ description: "", qty: 1, rate: 0, amount: 0 }]);
    setShowForm(true);
  };

  const openEdit = (t: RecurringInvoice) => {
    setEditing(t);
    setClientId(t.client_id);
    setTemplateName(t.template_name);
    setFrequency(t.frequency);
    setTaxRate(t.tax_rate);
    try { setItems(JSON.parse(t.line_items_json)); } catch { setItems([{ description: "", qty: 1, rate: 0, amount: 0 }]); }
    setShowForm(true);
  };

  const save = async () => {
    if (!clientId || !templateName.trim()) return;
    const input: RecurringInvoiceInput = { client_id: clientId, template_name: templateName.trim(), frequency, tax_rate: taxRate, line_items: items };
    if (editing) await api.updateRecurringInvoice(editing.id, input);
    else await api.createRecurringInvoice(input);
    setShowForm(false);
    load();
  };

  const toggle = async (t: RecurringInvoice) => {
    if (t.is_active) await api.pauseRecurringInvoice(t.id);
    else await api.resumeRecurringInvoice(t.id);
    load();
  };

  const deleteTemplate = async (t: RecurringInvoice) => {
    if (!confirm(`Delete template "${t.template_name}"?`)) return;
    await api.deleteRecurringInvoice(t.id);
    load();
  };

  const updateItem = (i: number, field: keyof LineItem, val: string) => {
    const copy = [...items];
    if (field === "qty") { copy[i].qty = parseFloat(val) || 0; copy[i].amount = copy[i].qty * copy[i].rate; }
    else if (field === "rate") { copy[i].rate = parseFloat(val) || 0; copy[i].amount = copy[i].qty * copy[i].rate; }
    else if (field === "description") { copy[i].description = val; }
    else if (field === "amount") { copy[i].amount = parseFloat(val) || 0; }
    setItems(copy);
  };

  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const total = subtotal + (subtotal * taxRate / 100);

  const active = templates.filter(t => t.is_active);
  const paused = templates.filter(t => !t.is_active);

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <div>
          <p className="text-[12px] text-muted mt-0.5">{active.length} active, {paused.length} paused</p>
        </div>
        <button onClick={openCreate}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
          <Plus size={14} /> New Template
        </button>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        {templates.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-[14px] font-semibold text-ink mb-1">No recurring templates</p>
            <p className="text-[12px] text-muted">Create one to auto-generate draft invoices on a schedule</p>
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-line-2">
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Template</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Client</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Frequency</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Next Due</th>
                <th className="text-left px-4 py-3 text-[10px] font-semibold text-muted uppercase tracking-widest">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-line-2 last:border-0 hover:bg-surface-2/70 transition-colors">
                  <td className="px-4 py-3 text-[13px] font-medium text-ink">{t.template_name}</td>
                  <td className="px-4 py-3 text-[13px] text-ink-2">{t.client_name}</td>
                  <td className="px-4 py-3 text-[12px] text-muted capitalize">{t.frequency}</td>
                  <td className="px-4 py-3 text-[12px] text-muted tabular-nums">{t.is_active ? t.next_due_date.slice(0, 10) : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${t.is_active ? "bg-success-bg text-success-ink" : "bg-surface-3 text-muted"}`}>
                      {t.is_active ? "Active" : "Paused"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-0.5">
                    <button onClick={() => openEdit(t)} title="Edit"
                      className="text-faint hover:text-ink-2 p-1 rounded-md hover:bg-surface-3 transition-colors">
                      <Edit2 size={13} />
                    </button>
                    <button onClick={() => toggle(t)} title={t.is_active ? "Pause" : "Resume"}
                      className="text-faint hover:text-accent p-1 rounded-md hover:bg-accent/10 transition-colors">
                      {t.is_active ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <button onClick={() => deleteTemplate(t)} title="Delete"
                      className="text-faint hover:text-danger-ink p-1 rounded-md hover:bg-danger-bg transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/25 backdrop-blur-[3px]" onClick={() => setShowForm(false)}>
          <div className="bg-surface rounded-2xl shadow-xl w-[480px] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-[14px] font-semibold text-ink">{editing ? "Edit Template" : "New Template"}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-ink-2"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Template Name *</label>
                <input className={inp} value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Monthly Retainer" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Client</label>
                  <select className={inp} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                    <option value="">Select client...</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Frequency</label>
                  <select className={inp} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Tax Rate (%)</label>
                <input className={inp} type="number" step="0.1" value={taxRate || ""} onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)} placeholder="0" />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Line Items</label>
                <div className="space-y-2">
                  {items.map((li, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input className={inp + " flex-1"} placeholder="Description" value={li.description} onChange={(e) => updateItem(i, "description", e.target.value)} />
                      <input className={inp + " w-[60px]"} type="number" placeholder="Qty" value={li.qty || ""} onChange={(e) => updateItem(i, "qty", e.target.value)} />
                      <input className={inp + " w-[90px]"} type="number" step="0.01" placeholder="Rate" value={li.rate || ""} onChange={(e) => updateItem(i, "rate", e.target.value)} />
                      <span className="text-[11px] text-muted w-[70px] text-right tabular-nums">{fmtAmount(li.amount)}</span>
                      {items.length > 1 && (
                        <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="text-faint hover:text-danger-ink flex-shrink-0"><X size={14} /></button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => setItems([...items, { description: "", qty: 1, rate: 0, amount: 0 }])}
                    className="text-[11px] text-accent hover:text-accent-hover font-medium">
                    + Add line item
                  </button>
                </div>
              </div>
              <div className="flex justify-between items-center text-[12px] text-muted pt-2 border-t border-line">
                <span>Subtotal: {fmtAmount(subtotal)}</span>
                <span>Total: <span className="font-semibold text-ink">{fmtAmount(total)}</span></span>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowForm(false)} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
              <button onClick={save} disabled={!clientId || !templateName.trim()} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
                {editing ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
