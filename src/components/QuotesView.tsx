import { useEffect, useMemo, useState } from "react";
import { api, Quote, Client, LineItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, FileText, Send, FileDown, Trash2, ArrowRightCircle, Check } from "lucide-react";

interface Props { onNavigate?: (t: any) => void; }

const STATUSES = ["all", "draft", "sent", "accepted", "declined", "expired"] as const;
type Filter = typeof STATUSES[number];

const statusStyle = (s: string): string => {
  switch (s) {
    case "accepted": return "bg-emerald-100 text-emerald-800";
    case "sent":     return "bg-blue-100 text-blue-800";
    case "declined": return "bg-red-100 text-red-700";
    case "expired":  return "bg-amber-100 text-amber-800";
    default:         return "bg-gray-100 text-gray-600";
  }
};

const inp = "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

// A sent quote whose valid-until date has passed reads as "expired".
const displayStatus = (q: Quote): string =>
  q.status === "sent" && q.valid_until && new Date(q.valid_until.slice(0, 10)) < new Date(new Date().toDateString())
    ? "expired" : q.status;

export default function QuotesView({ onNavigate }: Props) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };
  const load = async () => { setQuotes(await api.listQuotes()); };
  useEffect(() => { load(); api.listClients().then(setClients).catch(() => {}); }, []);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "—";

  const filtered = quotes.filter((q) => filter === "all" || displayStatus(q) === filter);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: quotes.length };
    for (const s of STATUSES) if (s !== "all") c[s] = quotes.filter((q) => displayStatus(q) === s).length;
    return c;
  }, [quotes]);

  const handlePdf = async (id: string) => {
    setBusy(id);
    try { await api.generateQuotePdf(id); flash("PDF saved — check your quotes folder"); load(); }
    catch (e: any) { alert(`Error: ${e}`); } finally { setBusy(null); }
  };
  const handleSend = async (id: string) => {
    if (!confirm("Email this quote to the client?")) return;
    setBusy(id);
    try { await api.sendQuote(id); flash("Quote sent"); load(); }
    catch (e: any) { alert(`Error: ${e}`); } finally { setBusy(null); }
  };
  const setStatus = async (id: string, status: string) => {
    try { await api.setQuoteStatus(id, status); load(); } catch (e: any) { alert(e); }
  };
  const del = async (id: string) => {
    if (!confirm("Delete this quote? This cannot be undone.")) return;
    try { await api.deleteQuote(id); load(); } catch (e: any) { alert(e); }
  };

  // Convert: create an invoice from the quote, link it, mark accepted, then
  // jump to the Invoices tab where it can be edited before sending.
  const convert = async (q: Quote) => {
    if (!confirm("Create an invoice from this quote? You can edit it in the Invoices tab before sending.")) return;
    setBusy(q.id);
    try {
      const items: LineItem[] = JSON.parse(q.line_items_json || "[]");
      const taxRate = q.subtotal > 0 ? q.tax / q.subtotal : 0;
      const invId = await api.createInvoice({
        client_id: q.client_id,
        due_date: q.valid_until,
        line_items: items,
        tax_rate: taxRate,
        notes: q.notes || undefined,
      });
      await api.markQuoteConverted(q.id, invId);
      flash("Invoice created from quote");
      onNavigate?.("invoices");
    } catch (e: any) { alert(`Error: ${e}`); } finally { setBusy(null); }
  };

  return (
    <div>
      {toast && (
        <div className="fixed bottom-5 right-5 bg-[#1A1A1E] text-white px-4 py-2.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[13px] z-50 animate-fade-in">{toast}</div>
      )}

      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Quotes</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">{counts.all} quotes · estimates for reaching out to customers</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
          <Plus size={14} /> New Quote
        </button>
      </div>

      <div className="flex gap-1.5 mb-4 flex-wrap">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 h-8 rounded-lg text-[12px] font-medium capitalize transition-colors ${filter === s ? "bg-indigo-50 text-indigo-700" : "text-gray-500 hover:bg-gray-50"}`}>
            {s} <span className="text-gray-400">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              {["Quote #", "Client", "Issued", "Valid Until", "Total", "Status", ""].map((h, i) => (
                <th key={h} className={`text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400 ${i >= 4 ? "text-right" : ""} ${i === 2 ? "hidden md:table-cell" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((q) => {
              const ds = displayStatus(q);
              return (
                <tr key={q.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-[12px] text-gray-700">{q.number}</td>
                  <td className="px-4 py-3 text-[13px] font-medium text-gray-900">{clientName(q.client_id)}</td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 tabular-nums hidden md:table-cell">{q.issue_date.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 tabular-nums">{q.valid_until.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-right text-[13px] font-bold text-gray-900 tabular-nums">{fmtAmount(q.total)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusStyle(ds)}`}>{ds}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button disabled={busy === q.id} onClick={() => handlePdf(q.id)} title="Generate PDF" className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"><FileDown size={14} /></button>
                      <button disabled={busy === q.id} onClick={() => handleSend(q.id)} title="Email quote" className="p-1.5 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50"><Send size={14} /></button>
                      {q.status !== "accepted" && (
                        <button disabled={busy === q.id} onClick={() => convert(q)} title="Convert to invoice" className="p-1.5 rounded-md text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50"><ArrowRightCircle size={14} /></button>
                      )}
                      {q.converted_invoice_id && (
                        <span title="Converted to an invoice" className="p-1.5 text-emerald-500"><Check size={14} /></span>
                      )}
                      <button onClick={() => { setEditing(q); setShowForm(true); }} className="px-2 py-1 text-[11px] text-gray-400 hover:text-gray-700 rounded hover:bg-gray-50">Edit</button>
                      {ds === "sent" && (
                        <button onClick={() => setStatus(q.id, "declined")} className="px-2 py-1 text-[11px] text-red-400 hover:text-red-600 rounded hover:bg-red-50">Decline</button>
                      )}
                      <button onClick={() => del(q.id)} title="Delete" className="p-1.5 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-14">
                <FileText size={24} className="mx-auto mb-2 text-gray-300" />
                <p className="text-[13px] text-gray-500">No quotes yet</p>
                <button onClick={() => { setEditing(null); setShowForm(true); }} className="mt-2 text-[12px] font-medium text-indigo-600">Create your first quote →</button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <QuoteForm
          initial={editing}
          clients={clients}
          onClose={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function QuoteForm({ initial, clients, onClose }: { initial: Quote | null; clients: Client[]; onClose: () => void }) {
  const blankItem = (): LineItem => ({ description: "", qty: 1, rate: 0, amount: 0 });
  const [clientId, setClientId] = useState(initial?.client_id ?? "");
  const [validUntil, setValidUntil] = useState(
    initial?.valid_until?.slice(0, 10) ?? new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
  );
  const [items, setItems] = useState<LineItem[]>(() => {
    try { const a = JSON.parse(initial?.line_items_json ?? "[]"); return a.length ? a : [blankItem()]; }
    catch { return [blankItem()]; }
  });
  const [taxRate, setTaxRate] = useState<number>(initial && initial.subtotal > 0 ? Math.round((initial.tax / initial.subtotal) * 10000) / 100 : 0);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);

  const setItem = (i: number, f: keyof LineItem, v: any) => {
    setItems((prev) => {
      const copy = [...prev];
      const it = { ...copy[i], [f]: v } as LineItem;
      it.amount = (Number(it.qty) || 0) * (Number(it.rate) || 0);
      copy[i] = it;
      return copy;
    });
  };

  const subtotal = items.reduce((s, i) => s + (i.amount || 0), 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const canSave = !!clientId && items.some((i) => i.description.trim() && i.amount > 0);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const clean = items.filter((i) => i.description.trim());
      const payload = { client_id: clientId, valid_until: validUntil, line_items: clean, tax_rate: taxRate / 100, notes: notes || undefined };
      if (initial) await api.updateQuote(initial.id, payload);
      else await api.createQuote(payload);
      onClose();
    } catch (e: any) { alert(e); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[7vh] bg-black/30 backdrop-blur-[3px] overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-[620px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-gray-100">
          <h3 className="text-[15px] font-semibold text-gray-900">{initial ? `Edit Quote ${initial.number}` : "New Quote"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Client *</label>
              <select className={inp} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Select a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` — ${c.company}` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Valid Until</label>
              <input type="date" className={inp} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>

          {/* Line items */}
          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1.5">Line Items</label>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input className={inp + " flex-1"} placeholder="Description" value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} />
                  <input className={inp + " w-16 text-right"} type="number" step="1" placeholder="Qty" value={it.qty || ""} onChange={(e) => setItem(i, "qty", parseFloat(e.target.value) || 0)} />
                  <input className={inp + " w-24 text-right"} type="number" step="0.01" placeholder="Rate" value={it.rate || ""} onChange={(e) => setItem(i, "rate", parseFloat(e.target.value) || 0)} />
                  <span className="w-24 text-right text-[13px] font-medium text-gray-700 tabular-nums">{fmtAmount(it.amount)}</span>
                  <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="text-gray-300 hover:text-red-500 p-1"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, blankItem()])} className="mt-2 text-[12px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1"><Plus size={12} /> Add item</button>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Tax %</label>
              <input className={inp} type="number" step="0.1" value={taxRate} onChange={(e) => { const v = parseFloat(e.target.value); setTaxRate(isNaN(v) ? 0 : v); }} />
            </div>
            <div className="text-right text-[12px] text-gray-500 space-y-0.5 pb-1">
              <div>Subtotal <span className="font-medium text-gray-800 tabular-nums ml-2">{fmtAmount(subtotal)}</span></div>
              <div>Tax <span className="font-medium text-gray-800 tabular-nums ml-2">{fmtAmount(tax)}</span></div>
              <div className="text-[14px] text-gray-900 font-bold">Total <span className="tabular-nums ml-2">{fmtAmount(total)}</span></div>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-1">Notes</label>
            <textarea className={inp + " h-auto py-2"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional message shown on the quote" />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} className="px-4 h-9 text-[13px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={!canSave || saving} className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving…" : initial ? "Save" : "Create Quote"}
          </button>
        </div>
      </div>
    </div>
  );
}
