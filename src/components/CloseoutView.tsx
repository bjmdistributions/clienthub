import { useEffect, useState, useRef } from "react";
import { api, Invoice, Client } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { CheckCircle2, Clock, ChevronDown, Trash2, Edit3, RefreshCw, RotateCcw } from "lucide-react";

const inp = "border border-gray-200 px-3 h-9 rounded-lg text-[13px] w-full focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors";

export default function CloseoutView() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [inv, cls] = await Promise.all([api.listInvoices(), api.listClients()]);
      setInvoices(inv);
      setClients(cls);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const pending = invoices.filter((i) => ["sent", "overdue"].includes(i.status.toLowerCase()));
  const paid = invoices.filter((i) => i.status.toLowerCase() === "paid" && !i.is_complete);
  const completed = invoices.filter((i) => i.is_complete);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this invoice? This cannot be undone.")) return;
    await api.deleteInvoice(id);
    if (detailId === id) setDetailId(null);
    showToast("Invoice deleted");
    load();
  };

  const handleMarkComplete = async (inv: Invoice) => {
    await api.markInvoicePaid(inv.id, new Date().toISOString().slice(0, 10));
    await api.saveInvoiceShipping(inv.id, {
      carrier: inv.carrier || undefined,
      tracking_number: inv.tracking_number || undefined,
      shipping_charged: inv.shipping_charged ?? undefined,
      pickup_date: inv.pickup_date || undefined,
      delivery_date: inv.delivery_date ?? "",
      is_complete: true,
    });
    showToast("Marked as complete");
    load();
  };

  const handleReopen = async (inv: Invoice) => {
    await api.saveInvoiceShipping(inv.id, {
      carrier: inv.carrier || undefined,
      tracking_number: inv.tracking_number || undefined,
      shipping_charged: inv.shipping_charged ?? undefined,
      pickup_date: inv.pickup_date || undefined,
      delivery_date: inv.delivery_date ?? "",
      is_complete: false,
    });
    showToast("Moved back to closeout");
    load();
  };

  return (
    <div ref={topRef}>
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[100] bg-emerald-600 text-white px-4 py-2.5 rounded-lg shadow-lg text-[13px] font-medium animate-fade-in">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-[18px] font-semibold text-gray-900 tracking-tight">Closeout</h2>
          <p className="text-[12px] text-gray-400 mt-0.5">Track pending, paid, and completed orders.</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-700 px-2.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors mt-0.5"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {detailId && (
        <InvoiceCloseoutPanel
          invoiceId={detailId}
          onClose={() => { setDetailId(null); load(); }}
          onSaved={(msg) => { setDetailId(null); load(); showToast(msg); topRef.current?.scrollIntoView({ behavior: "smooth" }); }}
        />
      )}

      {/* Kanban board */}
      <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 400 }}>
        <KanbanColumn title="Pending" count={pending.length} accentClass="text-amber-600" countClass="bg-amber-50 text-amber-600 ring-1 ring-amber-200/70">
          {pending.map((inv) => (
            <InvoiceCard key={inv.id} inv={inv} clientName={clientName(inv.client_id)}
              onEdit={() => setDetailId(inv.id)} onComplete={() => handleMarkComplete(inv)} onDelete={() => handleDelete(inv.id)}
              badge={<StatusChip status={inv.status} />} />
          ))}
          {pending.length === 0 && <EmptyColumnState text="No pending invoices" />}
        </KanbanColumn>

        <KanbanColumn title="Paid" count={paid.length} accentClass="text-emerald-600" countClass="bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/70">
          {paid.map((inv) => (
            <InvoiceCard key={inv.id} inv={inv} clientName={clientName(inv.client_id)}
              onEdit={() => setDetailId(inv.id)} onComplete={() => handleMarkComplete(inv)} onDelete={() => handleDelete(inv.id)}
              badge={<span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-600 ring-1 ring-amber-200/70"><Clock size={9} /> Needs closeout</span>} />
          ))}
          {paid.length === 0 && <EmptyColumnState text="No paid invoices awaiting closeout" />}
        </KanbanColumn>
      </div>

      {/* Completed section */}
      <div className="mt-2">
        <button onClick={() => setShowCompleted(!showCompleted)}
          className={`flex items-center gap-2 px-3 h-9 rounded-lg text-[12px] font-medium border transition-colors ${
            showCompleted ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"
          }`}>
          <CheckCircle2 size={13} /> Completed ({completed.length})
          <ChevronDown size={12} className={`transition-transform ${showCompleted ? "rotate-180" : ""}`} />
        </button>

        {showCompleted && (
          <div className="bg-white border border-gray-100 rounded-xl mt-3 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-50">
              <span className="text-[10px] font-semibold text-emerald-600 uppercase tracking-widest">Completed Invoices</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
              {completed.map((inv) => (
                <div key={inv.id} className="bg-gray-50/60 border border-gray-100 rounded-xl p-4 hover:border-gray-200 transition-colors">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[13px] font-medium text-gray-900 truncate flex-1">{clientName(inv.client_id)}</span>
                    <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0 ml-2" />
                  </div>
                  <div className="text-[18px] font-bold text-gray-900 tabular-nums leading-none mb-1">{fmtAmount(inv.total)}</div>
                  {inv.profit != null && (
                    <div className={`text-[11px] font-medium ${inv.profit >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                      Profit: {fmtAmount(inv.profit)}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-gray-100">
                    <button onClick={() => setDetailId(inv.id)}
                      className="text-[11px] px-2.5 py-1 bg-white border border-gray-200 hover:bg-gray-50 rounded-md text-gray-600 flex items-center gap-1 transition-colors">
                      <Edit3 size={10} /> Edit
                    </button>
                    <button onClick={() => handleReopen(inv)}
                      className="text-[11px] px-2.5 py-1 bg-amber-50 hover:bg-amber-100 rounded-md text-amber-700 flex items-center gap-1 transition-colors">
                      <RotateCcw size={10} /> Reopen
                    </button>
                    <button onClick={() => handleDelete(inv.id)}
                      className="text-[11px] px-2 py-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-md flex items-center gap-1 ml-auto transition-colors">
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              ))}
              {completed.length === 0 && <div className="text-[13px] text-gray-400 text-center py-8 col-span-3">No completed invoices yet.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({ title, count, accentClass, countClass, children }: {
  title: string; count: number; accentClass: string; countClass: string; children: React.ReactNode;
}) {
  return (
    <div className="flex-shrink-0 w-[300px] bg-white border border-gray-100 rounded-xl flex flex-col">
      <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
        <span className={`text-[10px] font-semibold uppercase tracking-widest ${accentClass}`}>{title}</span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${countClass}`}>{count}</span>
      </div>
      <div className="flex-1 p-3 space-y-2.5 overflow-y-auto">{children}</div>
    </div>
  );
}

function InvoiceCard({ inv, clientName, onEdit, onComplete, onDelete, badge }: {
  inv: Invoice; clientName: string; onEdit: () => void; onComplete: () => void; onDelete: () => void; badge: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-3.5 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,0,0,0.07)] hover:border-gray-200 transition-all duration-150">
      <div className="flex justify-between items-start mb-2">
        <button onClick={onEdit} className="text-[13px] font-medium text-gray-900 truncate flex-1 text-left hover:text-indigo-600 transition-colors">{clientName}</button>
        <span className="text-[11px] text-gray-300 ml-2 flex-shrink-0 tabular-nums">#{inv.number.slice(-6)}</span>
      </div>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[16px] font-bold text-gray-900 tabular-nums leading-none">{fmtAmount(inv.total)}</span>
        {badge}
      </div>
      <div className="flex items-center gap-1.5 pt-2.5 border-t border-gray-50">
        <button onClick={onEdit} className="text-[10px] px-2.5 py-1 bg-gray-50 hover:bg-gray-100 rounded-md text-gray-600 transition-colors">Edit</button>
        <button onClick={onComplete} className="text-[10px] px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 rounded-md text-emerald-700 font-medium transition-colors">Complete</button>
        <button onClick={onDelete} className="text-gray-200 hover:text-red-500 hover:bg-red-50 p-1 rounded-md ml-auto transition-colors"><Trash2 size={11} /></button>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    overdue: "bg-red-100 text-red-800",
    sent: "bg-blue-100 text-blue-800",
  };
  const cls = map[status.toLowerCase()] ?? "bg-gray-50 text-gray-500 ring-1 ring-gray-200";
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md capitalize ${cls}`}>{status.replace("_", " ")}</span>;
}

function EmptyColumnState({ text }: { text: string }) {
  return <div className="text-[12px] text-gray-300 text-center py-8">{text}</div>;
}

function InvoiceCloseoutPanel({ invoiceId, onClose, onSaved }: { invoiceId: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getInvoice(invoiceId).then((i) => { setInvoice(i); setLoading(false); });
  }, [invoiceId]);

  if (loading || !invoice) return null;

  return <InvoiceDetailPanel invoice={invoice} onClose={onClose} onSaved={onSaved} />;
}

function InvoiceDetailPanel({ invoice: initialInvoice, onClose, onSaved }: { invoice: Invoice; onClose: () => void; onSaved: (msg: string) => void }) {
  const [invoice, setInvoice] = useState(initialInvoice);
  const [sentDate, setSentDate] = useState(invoice.sent_at?.slice(0, 10) || "");
  const [costs, setCosts] = useState<any[]>(() => JSON.parse(invoice.cost_items_json || "[]"));
  const [carrier, setCarrier] = useState(invoice.carrier || "");
  const [tracking, setTracking] = useState(invoice.tracking_number || "");
  const [shipCharged, setShipCharged] = useState(invoice.shipping_charged || 0);
  const [pickupDate, setPickupDate] = useState(invoice.pickup_date || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveAll = async (markComplete: boolean) => {
    setSaving(true);
    try {
      if (costs.length > 0) await api.saveInvoiceCosts(invoice.id, costs);
      await api.saveInvoiceShipping(invoice.id, {
        carrier: carrier || undefined,
        tracking_number: tracking || undefined,
        shipping_charged: shipCharged,
        pickup_date: pickupDate || undefined,
        delivery_date: invoice.delivery_date ?? "",
        is_complete: markComplete,
      });
      if (markComplete && invoice.status.toLowerCase() !== "paid") {
        await api.markInvoicePaid(invoice.id, new Date().toISOString().slice(0, 10));
      }
      if (sentDate) await api.setInvoiceSentDate(invoice.id, sentDate);

      setSaved(true);
      setTimeout(() => {
        onSaved(markComplete ? "Marked as complete" : "Changes saved");
      }, 600);
    } catch (e: any) { alert(e); }
    setSaving(false);
  };

  const totalCosts = costs.reduce((s: number, c: any) => s + (c.amount || 0), 0) + (shipCharged || 0);
  const profit = (invoice.total || 0) - totalCosts;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" />
      <div className="relative w-[520px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_24px_48px_rgba(0,0,0,0.12)] h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        {/* Sticky header */}
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900">Closeout</h3>
            <p className="text-[12px] text-gray-400">#{invoice.number.slice(-6)}</p>
          </div>
          {saved && (
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600">
              <CheckCircle2 size={14} /> Saved
            </span>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100 transition-colors">✕</button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto p-6 space-y-5">
          <div className="flex justify-between items-center text-[14px] py-2 border-b border-gray-50">
            <span className="text-gray-400">Invoice total</span>
            <span className="font-semibold text-gray-900 tabular-nums">{fmtAmount(invoice.total)}</span>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Sent Date</label>
            <input type="date" className={inp} value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Cost Items</label>
            <div className="space-y-2">
              {costs.map((c: any, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <input className="flex-1 border border-gray-200 px-3 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
                    placeholder="Description" value={c.description}
                    onChange={(e) => { const cp = [...costs]; cp[i] = { ...cp[i], description: e.target.value }; setCosts(cp); }} />
                  <div className="relative w-28">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                    <input type="number" inputMode="decimal" step="0.01"
                      className="w-full border border-gray-200 pl-6 pr-2 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
                      value={c.amount || ""}
                      onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); const cp = [...costs]; cp[i] = { ...cp[i], amount: isNaN(v) ? 0 : v }; setCosts(cp); }} />
                  </div>
                  <button onClick={() => setCosts(costs.filter((_: any, j: number) => j !== i))} className="text-gray-300 hover:text-red-500 transition-colors">✕</button>
                </div>
              ))}
              <button onClick={() => setCosts([...costs, { description: "", amount: 0 }])}
                className="text-[12px] text-indigo-600 hover:text-indigo-700 font-medium">+ Add cost</button>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-5">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Shipping (optional)</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Carrier</label>
                <input className={inp} placeholder="UPS / FedEx..." value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Tracking</label>
                <input className={inp} value={tracking} onChange={(e) => setTracking(e.target.value)} />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Shipping Charged</label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[12px]">$</span>
                  <input type="number" inputMode="decimal" step="0.01"
                    className="w-full border border-gray-200 pl-6 pr-2 h-9 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
                    value={shipCharged || ""} onChange={(e) => { const v = parseFloat(e.target.value.replace(/,/g, '')); setShipCharged(isNaN(v) ? 0 : v); }} />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">Pickup Date</label>
                <input type="date" className={inp} value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="bg-gray-50/80 border border-gray-100 rounded-xl p-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1">Revenue</div>
                <div className="text-[15px] font-semibold text-gray-900 tabular-nums">{fmtAmount(invoice.total)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1">Costs</div>
                <div className="text-[15px] font-semibold text-gray-900 tabular-nums">{fmtAmount(totalCosts)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1">Profit</div>
                <div className={`text-[15px] font-semibold tabular-nums ${profit >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtAmount(profit)}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 bg-white/95 backdrop-blur-sm border-t border-gray-100 px-6 py-4 space-y-2">
          <button onClick={() => saveAll(true)} disabled={saving}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-10 rounded-lg text-[14px] font-medium disabled:opacity-50 transition-colors">
            {saving ? "Saving..." : saved ? "Saved ✓" : invoice.is_complete ? "Save Changes" : "Save & Mark Complete"}
          </button>
          {invoice.is_complete && (
            <button onClick={() => saveAll(false)} disabled={saving}
              className="w-full bg-white border border-amber-300 hover:bg-amber-50 text-amber-700 h-9 rounded-lg text-[13px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors">
              <RotateCcw size={13} /> Remove from Closeout
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
