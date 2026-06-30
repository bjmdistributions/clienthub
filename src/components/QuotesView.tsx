import { useEffect, useMemo, useState } from "react";
import { api, Quote, Client, LineItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { Plus, X, FileText, Send, FileDown, Trash2, ArrowRightCircle, Check } from "lucide-react";

interface Props { onNavigate?: (t: any) => void; }

const STATUSES = ["all", "draft", "sent", "accepted", "declined", "expired"] as const;
type Filter = typeof STATUSES[number];

const statusStyle = (s: string): string => {
  switch (s) {
    case "accepted": return "bg-success-bg text-success-ink";
    case "sent":     return "bg-info-bg text-info-ink";
    case "declined": return "bg-danger-bg text-danger-ink";
    case "expired":  return "bg-warning-bg text-warning-ink";
    default:         return "bg-surface-3 text-ink-2";
  }
};

const inp = "border border-line bg-surface text-ink placeholder-muted px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
// Narrow variant (no w-full) for the line-item editor columns.
const inpNarrow = "border border-line bg-surface text-ink placeholder-muted px-2 h-10 rounded-lg text-[14px] text-right focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

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
  const [detailId, setDetailId] = useState<string | null>(null);

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
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Quotes</h2>
          <p className="text-[12px] text-muted mt-0.5">{counts.all} quotes · estimates for reaching out to customers</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5">
          <Plus size={14} /> New Quote
        </button>
      </div>

      <div className="flex gap-1.5 mb-4 flex-wrap">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 h-8 rounded-lg text-[12px] font-medium capitalize transition-colors ${filter === s ? "bg-accent/10 text-accent-hover" : "text-muted hover:bg-surface-2"}`}>
            {s} <span className="text-muted">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-line">
              {["Quote #", "Client", "Issued", "Valid Until", "Total", "Status", ""].map((h, i) => (
                <th key={h} className={`text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted ${i >= 4 ? "text-right" : ""} ${i === 2 ? "hidden md:table-cell" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((q) => {
              const ds = displayStatus(q);
              return (
                <tr key={q.id} onClick={() => setDetailId(q.id)} className="border-b border-gray-50 hover:bg-surface-2/50 transition-colors cursor-pointer">
                  <td className="px-4 py-3 font-mono text-[12px] text-ink-2">{q.number}</td>
                  <td className="px-4 py-3 text-[13px] font-medium text-ink">{clientName(q.client_id)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted tabular-nums hidden md:table-cell">{q.issue_date.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-[12px] text-muted tabular-nums">{q.valid_until.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-right text-[13px] font-bold text-ink tabular-nums">{fmtAmount(q.total)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusStyle(ds)}`}>{ds}</span>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button disabled={busy === q.id} onClick={() => handlePdf(q.id)} title="Generate PDF" className="p-1.5 rounded-md text-muted hover:text-ink-2 hover:bg-surface-3"><FileDown size={14} /></button>
                      <button disabled={busy === q.id} onClick={() => handleSend(q.id)} title="Email quote" className="p-1.5 rounded-md text-muted hover:text-accent hover:bg-accent/10"><Send size={14} /></button>
                      {q.status !== "accepted" && (
                        <button disabled={busy === q.id} onClick={() => convert(q)} title="Convert to invoice" className="p-1.5 rounded-md text-success-ink hover:text-success-ink hover:bg-success-bg"><ArrowRightCircle size={14} /></button>
                      )}
                      {q.converted_invoice_id && (
                        <span title="Converted to an invoice" className="p-1.5 text-success-ink"><Check size={14} /></span>
                      )}
                      <button onClick={() => { setEditing(q); setShowForm(true); }} className="px-2 py-1 text-[11px] text-muted hover:text-ink-2 rounded hover:bg-surface-2">Edit</button>
                      {ds === "sent" && (
                        <button onClick={() => setStatus(q.id, "declined")} className="px-2 py-1 text-[11px] text-danger-ink hover:text-danger-ink rounded hover:bg-danger-bg">Decline</button>
                      )}
                      <button onClick={() => del(q.id)} title="Delete" className="p-1.5 rounded-md text-faint hover:text-danger-ink hover:bg-danger-bg"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-14">
                <FileText size={24} className="mx-auto mb-2 text-faint" />
                <p className="text-[13px] text-muted">No quotes yet</p>
                <button onClick={() => { setEditing(null); setShowForm(true); }} className="mt-2 text-[12px] font-medium text-accent">Create your first quote →</button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {detailId && (() => {
        const q = quotes.find((x) => x.id === detailId);
        if (!q) return null;
        return (
          <QuoteDetailPanel
            quote={q}
            clientName={clientName(q.client_id)}
            displayStatus={displayStatus(q)}
            onClose={() => setDetailId(null)}
            onPdf={() => handlePdf(q.id)}
            onSend={() => handleSend(q.id)}
            onConvert={() => convert(q)}
            onDecline={() => setStatus(q.id, "declined")}
            onEdit={() => { setEditing(q); setShowForm(true); setDetailId(null); }}
            onDelete={() => { del(q.id); setDetailId(null); }}
          />
        );
      })()}

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

function QuoteDetailPanel({ quote, clientName, displayStatus, onClose, onPdf, onSend, onConvert, onDecline, onEdit, onDelete }: {
  quote: Quote; clientName: string; displayStatus: string; onClose: () => void;
  onPdf: () => void; onSend: () => void; onConvert: () => void; onDecline: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const items: LineItem[] = (() => { try { return JSON.parse(quote.line_items_json || "[]"); } catch { return []; } })();
  return (
    <>
      <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-[480px] max-w-[95vw] bg-surface shadow-[0_0_50px_rgba(0,0,0,0.12)] h-full overflow-auto z-50 animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-surface/95 backdrop-blur-sm border-b border-line px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-[14px] font-semibold text-ink font-mono">{quote.number}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><X size={16} /></button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusStyle(displayStatus)}`}>{displayStatus}</span>

          <div>
            <div className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-0.5">Client</div>
            <div className="text-[14px] font-medium text-ink mt-0.5">{clientName}</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Issued", val: quote.issue_date.slice(0, 10) },
              { label: "Valid Until", val: quote.valid_until.slice(0, 10) },
              ...(quote.sent_at ? [{ label: "Sent", val: new Date(quote.sent_at).toLocaleDateString() }] : []),
            ].map((r) => (
              <div key={r.label}>
                <div className="text-[10px] font-semibold text-muted uppercase tracking-widest">{r.label}</div>
                <div className="text-[13px] text-ink mt-0.5 tabular-nums">{r.val}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-2">Line Items</div>
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-muted uppercase tracking-widest rounded-l-lg">Description</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-muted uppercase tracking-widest">Qty</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-muted uppercase tracking-widest">Rate</th>
                  <th className="text-right px-3 py-2 text-[10px] font-semibold text-muted uppercase tracking-widest rounded-r-lg">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-50">
                    <td className="px-3 py-2.5 text-ink-2">{it.description}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{it.qty}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{fmtAmount(it.rate)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmtAmount(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-line pt-4 space-y-1.5 text-[13px]">
            <div className="flex justify-between text-ink-2"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(quote.subtotal)}</span></div>
            <div className="flex justify-between text-ink-2"><span>Tax</span><span className="tabular-nums">{fmtAmount(quote.tax)}</span></div>
            <div className="flex justify-between text-[15px] font-bold text-ink pt-1"><span>Total</span><span className="tabular-nums">{fmtAmount(quote.total)}</span></div>
          </div>

          {quote.notes && (
            <div>
              <div className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Notes</div>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          <div className="border-t border-line pt-4 flex flex-wrap gap-2">
            <button onClick={onEdit} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Edit</button>
            <button onClick={onPdf} className="flex items-center gap-1.5 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><FileDown size={13} /> PDF</button>
            <button onClick={onSend} className="flex items-center gap-1.5 border border-line text-ink-2 px-3 h-9 rounded-lg text-[12px] hover:bg-surface-2"><Send size={13} /> Email</button>
            {quote.status !== "accepted" && (
              <button onClick={onConvert} className="flex items-center gap-1.5 border border-success text-success-ink px-3 h-9 rounded-lg text-[12px] hover:bg-success-bg"><ArrowRightCircle size={13} /> Convert to Invoice</button>
            )}
            {displayStatus === "sent" && (
              <button onClick={onDecline} className="border border-danger text-danger-ink px-3 h-9 rounded-lg text-[12px] hover:bg-danger-bg">Mark Declined</button>
            )}
            <button onClick={onDelete} className="flex items-center gap-1.5 border border-line text-muted hover:text-danger-ink hover:border-danger px-3 h-9 rounded-lg text-[12px]"><Trash2 size={13} /> Delete</button>
          </div>
        </div>
      </div>
    </>
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
      <div className="bg-surface rounded-2xl shadow-xl w-[620px] max-w-[94vw] mb-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-line">
          <h3 className="text-[15px] font-semibold text-ink">{initial ? `Edit Quote ${initial.number}` : "New Quote"}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Client *</label>
              <select className={inp} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Select a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` — ${c.company}` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Valid Until</label>
              <input type="date" className={inp} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>

          {/* Line items */}
          <div>
            <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1.5">Line Items</label>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input className={`${inpNarrow} flex-1 text-left`} placeholder="Description" value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} />
                  <input className={`${inpNarrow} w-16`} type="number" step="1" placeholder="Qty" value={it.qty || ""} onChange={(e) => setItem(i, "qty", parseFloat(e.target.value) || 0)} />
                  <input className={`${inpNarrow} w-24`} type="number" step="0.01" placeholder="Rate" value={it.rate || ""} onChange={(e) => setItem(i, "rate", parseFloat(e.target.value) || 0)} />
                  <span className="w-24 text-right text-[13px] font-medium text-ink-2 tabular-nums flex-shrink-0">{fmtAmount(it.amount)}</span>
                  <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="text-faint hover:text-danger-ink p-1 flex-shrink-0"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, blankItem()])} className="mt-2 text-[12px] text-accent hover:text-accent-hover flex items-center gap-1"><Plus size={12} /> Add item</button>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Tax %</label>
              <input className={inp} type="number" step="0.1" value={taxRate} onChange={(e) => { const v = parseFloat(e.target.value); setTaxRate(isNaN(v) ? 0 : v); }} />
            </div>
            <div className="text-right text-[12px] text-muted space-y-0.5 pb-1">
              <div>Subtotal <span className="font-medium text-ink tabular-nums ml-2">{fmtAmount(subtotal)}</span></div>
              <div>Tax <span className="font-medium text-ink tabular-nums ml-2">{fmtAmount(tax)}</span></div>
              <div className="text-[14px] text-ink font-bold">Total <span className="tabular-nums ml-2">{fmtAmount(total)}</span></div>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-muted uppercase tracking-widest mb-1">Notes</label>
            <textarea className={inp + " h-auto py-2"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional message shown on the quote" />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-line">
          <button onClick={onClose} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2">Cancel</button>
          <button onClick={submit} disabled={!canSave || saving} className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40">
            {saving ? "Saving…" : initial ? "Save" : "Create Quote"}
          </button>
        </div>
      </div>
    </div>
  );
}
