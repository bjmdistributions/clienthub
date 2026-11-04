import { ArrowRightCircle, Ban, Check, Edit2, FileDown, Plus, Search, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, Quote, Client, LineItem } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";

import { Button, PageActions, Tabs } from "./ui";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { FromPicker, useSendFromOptions } from "./FromPicker";

interface Props { onNavigate?: (t: any) => void; }

const STATUSES = ["all", "draft", "sent", "accepted", "declined", "expired"] as const;
type Filter = typeof STATUSES[number];

const statusStyle = (s: string): string => {
  switch (s) {
    case "accepted": return "bg-surface-3 text-success-ink";
    case "sent":     return "bg-surface-3 text-muted";
    case "declined": return "bg-surface-3 text-danger-ink";
    case "expired":  return "bg-surface-3 text-warning-ink";
    default:         return "bg-surface-3 text-ink-2";
  }
};

const statusLabel = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const inp = "border border-line-3 bg-transparent text-ink placeholder-muted px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:border-ink transition-colors duration-150";
// Narrow variant (no w-full) for the line-item editor columns.
const inpNarrow = "border border-line-3 bg-transparent text-ink placeholder-muted px-2 h-10 rounded-lg text-[14px] text-right focus:outline-none focus:border-ink transition-colors duration-150";

// A sent quote whose valid-until date has passed reads as "expired".
const displayStatus = (q: Quote): string =>
  q.status === "sent" && q.valid_until && new Date(q.valid_until.slice(0, 10)) < new Date(new Date().toDateString())
    ? "expired" : q.status;

export default function QuotesView({ onNavigate }: Props) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sendModal, setSendModal] = useState<{ quote: Quote; thread: boolean } | null>(null);
  const [sendFrom, setSendFrom] = useState<string | undefined>(undefined);
  const fromOptions = useSendFromOptions();

  const load = async () => { setQuotes(await api.listQuotes()); };
  useEffect(() => { load(); api.listClients().then(setClients).catch(() => {}); }, []);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "-";
  const clientEmail = (id: string) => clients.find((c) => c.id === id)?.email ?? "";
  // The most recent inbound email captured from this client — the conversation a quote
  // can reply into. Returns its subject (may be "") when a thread exists, else null.
  const clientThread = (id: string): { subject: string } | null => {
    const m = clients.find((c) => c.id === id)?.metadata as Record<string, any> | null | undefined;
    const mid = m?.src_message_id;
    if (typeof mid !== "string" || !mid.trim()) return null;
    return { subject: typeof m?.src_subject === "string" ? m.src_subject : "" };
  };

  const term = search.trim().toLowerCase();
  const filtered = quotes.filter((q) => {
    if (filter !== "all" && displayStatus(q) !== filter) return false;
    if (!term) return true;
    // Match on customer name or quote number.
    return clientName(q.client_id).toLowerCase().includes(term) || (q.number || "").toLowerCase().includes(term);
  });
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: quotes.length };
    for (const s of STATUSES) if (s !== "all") c[s] = quotes.filter((q) => displayStatus(q) === s).length;
    return c;
  }, [quotes]);

  const handlePdf = async (id: string) => {
    setBusy(id);
    try { await api.generateQuotePdf(id); toast("PDF saved: check your quotes folder"); load(); }
    catch (e: any) { toast(String(e), "error"); } finally { setBusy(null); }
  };
  // Open the send dialog (lets you choose to reply into the customer's email thread).
  const handleSend = (id: string) => {
    const q = quotes.find((x) => x.id === id);
    if (!q) return;
    setSendModal({ quote: q, thread: !!clientThread(q.client_id) });
    setSendFrom(undefined);
  };
  const confirmSend = async () => {
    if (!sendModal) return;
    const { quote, thread } = sendModal;
    const threaded = thread && !!clientThread(quote.client_id);
    setBusy(quote.id);
    try {
      await api.sendQuote(quote.id, threaded, sendFrom);
      toast(threaded ? "Quote sent into the email thread" : "Quote sent");
      setSendModal(null);
      load();
    } catch (e: any) { toast(String(e), "error"); } finally { setBusy(null); }
  };
  const setStatus = async (id: string, status: string) => {
    try { await api.setQuoteStatus(id, status); load(); } catch (e: any) { toast(String(e), "error"); }
  };
  const del = async (id: string) => {
    if (!confirm("Delete this quote? This cannot be undone.")) return;
    try { await api.deleteQuote(id); load(); } catch (e: any) { toast(String(e), "error"); }
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
      toast("Invoice created from quote");
      onNavigate?.("invoices");
    } catch (e: any) { toast(String(e), "error"); } finally { setBusy(null); }
  };

  return (
    <div>
      <PageActions>
        <label className="ui-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer or quote #"
            aria-label="Search quotes"
          />
        </label>
        <Button variant="ink" onClick={() => { setEditing(null); setShowForm(true); }} icon={<Plus size={14} />}>New quote</Button>
      </PageActions>

      <p className="m-0 mb-3.5 ml-1 text-[14px] text-muted">{counts.all} quotes · estimates for reaching out to customers</p>

      <div className="mb-4">
        <Tabs label="Quote status" value={filter} onChange={(id) => setFilter(id as Filter)}
          tabs={STATUSES.map((s) => ({ id: s, label: statusLabel(s), count: counts[s] ?? 0, countTone: "calm" as const }))} />
      </div>

      <div className="overflow-x-auto">
        <table className="ui-table ui-table-click min-w-[640px]">
          <thead>
            <tr>
              {["Quote #", "Client", "Issued", "Valid until", "Total", "Status", ""].map((h, i) => (
                <th key={h || "actions"} className={`${i >= 4 ? "r" : ""} ${i === 2 ? "hidden md:table-cell" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((q) => {
              const ds = displayStatus(q);
              return (
                <tr key={q.id} onClick={() => setDetailId(q.id)}>
                  <td className="text-[13px] text-muted tabular-nums">{q.number}</td>
                  <td className="font-medium text-ink">{clientName(q.client_id)}</td>
                  <td className="text-[13px] text-muted tabular-nums hidden md:table-cell">{q.issue_date.slice(0, 10)}</td>
                  <td className="text-[13px] text-muted tabular-nums">{q.valid_until.slice(0, 10)}</td>
                  <td className="r font-medium text-ink">{fmtAmount(q.total)}</td>
                  <td className="text-right">
                    <StatusPill className={statusStyle(ds)}>{statusLabel(ds)}</StatusPill>
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    {/* Quiet icon buttons: save, email, convert, edit, decline, delete. */}
                    <div className="inline-flex items-center gap-0.5">
                      <button disabled={busy === q.id} onClick={() => handlePdf(q.id)} title="Save PDF" aria-label="Save PDF"
                        className="ui-ib disabled:opacity-50"><FileDown size={16} /></button>
                      <button disabled={busy === q.id} onClick={() => handleSend(q.id)} title="Email quote" aria-label="Email quote"
                        className="ui-ib disabled:opacity-50"><Send size={16} /></button>
                      {q.status !== "accepted" && (
                        <button disabled={busy === q.id} onClick={() => convert(q)} title="Convert to invoice" aria-label="Convert to invoice"
                          className="ui-ib hover:!text-success-ink disabled:opacity-50"><ArrowRightCircle size={16} /></button>
                      )}
                      {q.converted_invoice_id && (
                        <span title="Converted to an invoice" className="inline-grid place-items-center w-7 h-7 text-success-ink"><Check size={16} /></span>
                      )}
                      <button onClick={() => { setEditing(q); setShowForm(true); }} title="Edit" aria-label="Edit"
                        className="ui-ib"><Edit2 size={16} /></button>
                      {ds === "sent" && (
                        <button onClick={() => setStatus(q.id, "declined")} title="Mark declined" aria-label="Mark declined"
                          className="ui-ib hover:!text-danger-ink"><Ban size={16} /></button>
                      )}
                      <button onClick={() => del(q.id)} title="Delete" aria-label="Delete"
                        className="ui-ib hover:!text-danger-ink"><Trash2 size={16} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center !py-14">
                {term || filter !== "all" ? (
                  <p className="text-[13px] text-muted">No quotes match{term ? ` "${search.trim()}"` : ""}.</p>
                ) : (
                  <>
                    <p className="text-[13px] text-muted">No quotes yet</p>
                    <button onClick={() => { setEditing(null); setShowForm(true); }} className="ui-link mt-2">Create your first quote</button>
                  </>
                )}
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

      {sendModal && (() => {
        const q = sendModal.quote;
        const email = clientEmail(q.client_id);
        const thread = clientThread(q.client_id);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-fade-in" onClick={() => setSendModal(null)}>
            <div className="bg-surface ring-1 ring-line-3 rounded-2xl w-full max-w-sm shadow-2xl animate-fade-up" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 flex items-center justify-between">
                <div className="text-[16px] font-medium text-ink">Email quote {q.number}</div>
                <button onClick={() => setSendModal(null)} aria-label="Close" className="ui-ib"><X size={16} /></button>
              </div>
              <div className="px-5 pb-4 flex flex-col gap-3">
                <div className="text-[13px] text-ink-2">
                  To <span className="font-medium text-ink">{clientName(q.client_id)}</span>
                  {email ? <span className="text-muted"> · {email}</span> : <span className="text-danger-ink"> · no email on file</span>}
                </div>
                {thread ? (
                  <label className="flex items-start gap-2.5 rounded-lg border border-line-3 px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={sendModal.thread} onChange={(e) => setSendModal({ quote: q, thread: e.target.checked })} className="accent-ink mt-0.5" />
                    <span className="text-[12.5px] text-ink-2">
                      <span className="font-medium text-ink">Reply into their email thread</span>
                      <span className="block text-[12px] text-muted mt-0.5">{thread.subject ? `Threads under "${thread.subject}"` : "Lands in your last conversation with them"}</span>
                    </span>
                  </label>
                ) : (
                  <div className="text-[12px] text-muted rounded-lg border border-line-3 px-3 py-2.5">No prior email from this customer to reply to. This sends as a new email.</div>
                )}
                <FromPicker options={fromOptions} value={sendFrom} onChange={setSendFrom} />
              </div>
              <div className="hsep" />
              <div className="px-5 py-4 flex justify-end gap-2">
                <button onClick={() => setSendModal(null)} className="ui-btn">Cancel</button>
                <button onClick={confirmSend} disabled={!email || busy === q.id} className="ui-btn ui-btn-ink">
                  {busy === q.id ? "Sending..." : "Send quote"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
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
          <h3 className="text-[14px] font-medium text-ink font-mono">{quote.number}</h3>
          <button onClick={onClose} aria-label="Close" className="ui-ib"><X size={16} /></button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <StatusPill className={statusStyle(displayStatus)}>{statusLabel(displayStatus)}</StatusPill>

          <div>
            <div className="text-[12.5px] font-medium text-muted mb-0.5">Client</div>
            <div className="text-[14px] font-medium text-ink mt-0.5">{clientName}</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Issued", val: quote.issue_date.slice(0, 10) },
              { label: "Valid until", val: quote.valid_until.slice(0, 10) },
              ...(quote.sent_at ? [{ label: "Sent", val: new Date(quote.sent_at).toLocaleDateString() }] : []),
            ].map((r) => (
              <div key={r.label}>
                <div className="text-[12.5px] font-medium text-muted">{r.label}</div>
                <div className="text-[13px] text-ink mt-0.5 tabular-nums">{r.val}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="text-[12.5px] font-medium text-muted mb-2">Line items</div>
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2">
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

          <div className="border-t border-line pt-4 space-y-1.5 text-[13px]">
            <div className="flex justify-between text-ink-2"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(quote.subtotal)}</span></div>
            <div className="flex justify-between text-ink-2"><span>Tax</span><span className="tabular-nums">{fmtAmount(quote.tax)}</span></div>
            <div className="flex justify-between text-[15px] font-medium text-ink pt-1"><span>Total</span><span className="tabular-nums">{fmtAmount(quote.total)}</span></div>
          </div>

          {quote.notes && (
            <div>
              <div className="text-[12.5px] font-medium text-muted mb-1">Notes</div>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          <div className="border-t border-line pt-4 flex flex-wrap gap-2">
            <button onClick={onEdit} className="ui-btn ui-btn-ink">Edit</button>
            <button onClick={onPdf} className="ui-btn"><FileDown size={14} /> PDF</button>
            <button onClick={onSend} className="ui-btn"><Send size={14} /> Email</button>
            {quote.status !== "accepted" && (
              <button onClick={onConvert} className="ui-btn text-success-ink"><ArrowRightCircle size={14} /> Convert to invoice</button>
            )}
            {displayStatus === "sent" && (
              <button onClick={onDecline} className="ui-btn ui-btn-danger">Mark declined</button>
            )}
            <button onClick={onDelete} className="ui-btn ui-btn-danger"><Trash2 size={14} /> Delete</button>
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
    initial?.valid_until?.slice(0, 10) ?? localDay(new Date(Date.now() + 30 * 864e5))
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
    } catch (e: any) { toast(String(e), "error"); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[7vh] bg-black/40 overflow-y-auto animate-fade-in" onClick={onClose}>
      <div className="bg-surface ring-1 ring-line-3 rounded-2xl shadow-2xl w-[620px] max-w-[94vw] mb-10 animate-fade-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5">
          <h3 className="text-[16px] font-medium text-ink m-0">{initial ? `Edit quote ${initial.number}` : "New quote"}</h3>
          <button onClick={onClose} aria-label="Close" className="ui-ib"><X size={16} /></button>
        </div>
        <div className="hsep" />

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Client *</label>
              <select className={inp} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Select a client...</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Valid until</label>
              <input type="date" className={inp} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>

          {/* Line items */}
          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1.5">Line items</label>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input className={`${inpNarrow} flex-1 text-left`} placeholder="Description" value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} />
                  <NumberInput className={`${inpNarrow} w-16`} placeholder="Qty" value={it.qty || ""} onValue={(n) => setItem(i, "qty", n)} />
                  <NumberInput className={`${inpNarrow} w-24`} placeholder="Rate" value={it.rate || ""} onValue={(n) => setItem(i, "rate", n)} />
                  <span className="w-24 text-right text-[13px] font-medium text-ink-2 tabular-nums flex-shrink-0">{fmtAmount(it.amount)}</span>
                  <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} aria-label="Remove item" className="ui-ib hover:!text-danger-ink flex-shrink-0"><X size={16} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, blankItem()])} className="ui-btn ui-btn-sm mt-2"><Plus size={14} /> Add item</button>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[12.5px] font-medium text-muted mb-1">Tax %</label>
              <NumberInput className={inp} value={taxRate} onValue={(n) => setTaxRate(n)} />
            </div>
            <div className="text-right text-[12px] text-muted space-y-0.5 pb-1">
              <div>Subtotal <span className="font-medium text-ink tabular-nums ml-2">{fmtAmount(subtotal)}</span></div>
              <div>Tax <span className="font-medium text-ink tabular-nums ml-2">{fmtAmount(tax)}</span></div>
              <div className="text-[14px] text-ink font-medium">Total <span className="tabular-nums ml-2">{fmtAmount(total)}</span></div>
            </div>
          </div>

          <div>
            <label className="block text-[12.5px] font-medium text-muted mb-1">Notes</label>
            <textarea className={inp + " h-auto py-2"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional message shown on the quote" />
          </div>
        </div>

        <div className="hsep" />
        <div className="flex justify-end gap-2 p-5">
          <button onClick={onClose} className="ui-btn">Cancel</button>
          <button onClick={submit} disabled={!canSave || saving} className="ui-btn ui-btn-ink">
            {saving ? "Saving..." : initial ? "Save" : "Create quote"}
          </button>
        </div>
      </div>
    </div>
  );
}
