import { useEffect, useState } from "react";
import { RotateCcw, Trash2, Pencil, Check, X } from "lucide-react";
import { api, DealFlow, SupplierPayment, SupplierPaymentInput } from "../lib/api";
import { fmtAmount, primarySupplierLabel, localDay } from "../lib/format";
import { toast } from "./Toast";
import RefundPanel from "./RefundPanel";
import ReconciliationPanel from "./ReconciliationPanel";
import RefundWorkspace from "./RefundWorkspace";

// Shared field styling (matches DealFlowView's `inp` focus pattern).
const fieldCls =
  "border border-line rounded-lg bg-surface text-[13px] tabular-nums " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// ─── Completed deal full breakdown ────────────────────────────────────────
// Shared by DealFlowView's completed list and the supplier deal history.
export default function CompletedBreakdown({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [saving, setSaving] = useState(false);
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id]);

  // Once bank payments are paired, the P&L reflects what actually moved (from the
  // linked payments), not the deal's projected figures. Nothing linked → projected.
  const paired = recon ? recon.pieces.buyer_paired + recon.pieces.supplier_paired + recon.pieces.fee_paired : 0;
  const fromPayments = paired > 0.005;
  const revenue = fromPayments ? recon!.pieces.buyer_paired : flow.gross_revenue;
  const costs   = fromPayments ? recon!.pieces.supplier_paired + recon!.pieces.fee_paired + recon!.pieces.refund_total - recon!.pieces.refund_in : flow.total_cost;
  const profit  = fromPayments ? recon!.actual_profit : flow.net_profit;
  const margin  = revenue > 0 ? (profit / revenue) * 100 : 0;
  const payments = flow.supplier_payments || [];
  const supplierLabel = primarySupplierLabel(flow.supplier_payments);

  // The DealFlow payload has no line items — load them off the invoice (mirrors DealFlowView).
  const [items, setItems] = useState<{ description: string; qty: number; rate: number; amount: number }[]>([]);
  const [invMeta, setInvMeta] = useState<{ subtotal: number; tax: number; total: number; number: string } | null>(null);
  useEffect(() => {
    api.getInvoice(flow.invoice_id)
      .then((inv) => {
        setInvMeta({ subtotal: inv.subtotal ?? 0, tax: inv.tax ?? 0, total: inv.total ?? 0, number: inv.number ?? "" });
        try {
          const li: any[] = JSON.parse(inv.line_items_json || "[]");
          setItems(li.map((it: any) => ({ description: it.description, qty: it.qty, rate: it.rate ?? 0, amount: it.amount ?? 0 })));
        } catch {}
      })
      .catch(() => {});
  }, [flow.invoice_id]);

  // Editable closing date — replaces the reopen→recomplete dance that re-stamped a new date.
  const today = localDay();
  const savedDate = flow.completed_at?.slice(0, 10) || "";
  const [dateStr, setDateStr] = useState(savedDate);
  useEffect(() => { setDateStr(flow.completed_at?.slice(0, 10) || ""); }, [flow.completed_at]);
  const handleSaveDate = async () => {
    if (!dateStr || dateStr === savedDate || saving) return;
    setSaving(true);
    try { await api.updateDealCompletedAt(flow.id, dateStr); toast("Closing date updated"); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  // Inline edit of an existing supplier-payment amount — no reopen, preserves the closing date.
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmt, setEditAmt] = useState("");
  const startEdit = (p: SupplierPayment) => { setEditId(p.id); setEditAmt(String(p.amount)); };
  const cancelEdit = () => { setEditId(null); setEditAmt(""); };
  const saveEdit = async (p: SupplierPayment) => {
    const amount = parseFloat(editAmt.replace(/,/g, ""));
    if (!isFinite(amount) || amount < 0) { toast("Enter a valid amount", "error"); return; }
    setSaving(true);
    try {
      const input: SupplierPaymentInput = {
        supplier_name: p.supplier_name,
        supplier_id:   p.supplier_id ?? null,
        amount,
        quantity:      p.quantity ?? null,
        unit_price:    p.quantity ? amount / p.quantity : (p.unit_price ?? null),
        method:        p.method ?? null,
        notes:         p.notes ?? null,
        category:      p.category ?? null,
      };
      await api.updateSupplierPayment(flow.id, p.id, input);
      toast("Supplier cost updated");
      cancelEdit();
      onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  // Current payout routing for this completed deal, flippable in place — so deals
  // completed under the old silent default (excluded → 100% business) can adopt the
  // configured split without uncomplete→recomplete.
  const payoutIncluded = (() => { try { return !!JSON.parse((flow as any).metadata || "{}").payout_included; } catch { return false; } })();
  const setIncluded = async (v: boolean) => {
    if (v === payoutIncluded || saving) return;
    setSaving(true);
    try { await api.setDealPayoutIncluded(flow.id, v); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleReopen = async () => {
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this completed deal? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* Buyer → supplier + editable closing date */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 min-w-0">
          <div className="min-w-0">
            <div className="text-[11px] text-muted">Buyer</div>
            <div className="text-[13px] text-ink font-medium truncate">{flow.client_name || "—"}</div>
          </div>
          {supplierLabel && (
            <div className="min-w-0">
              <div className="text-[11px] text-muted">Supplier</div>
              <div className="text-[13px] text-ink-2 truncate">{supplierLabel}</div>
            </div>
          )}
        </div>
        <div className="flex items-end gap-2">
          <div>
            <div className="text-[11px] text-muted mb-1">Closing date</div>
            <input
              type="date"
              max={today}
              value={dateStr}
              disabled={saving}
              onChange={(e) => setDateStr(e.target.value)}
              className={`${fieldCls} px-2.5 h-8 text-[12px]`}
            />
          </div>
          {dateStr && dateStr !== savedDate && (
            <button
              type="button"
              onClick={handleSaveDate}
              disabled={saving}
              className="h-8 px-3 rounded-lg bg-accent text-on-accent text-[12px] font-semibold disabled:opacity-50 transition-colors"
            >
              Save
            </button>
          )}
        </div>
      </div>

      {/* Payout routing — flip past deals onto (or off) the configured split */}
      <div className="space-y-1">
        <div className="text-[11px] text-muted">Where does this deal's profit go?</div>
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
          <button type="button" disabled={saving} onClick={() => setIncluded(true)}
            className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            Apply profit split
          </button>
          <button type="button" disabled={saving} onClick={() => setIncluded(false)}
            className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${!payoutIncluded ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            Business keeps 100%
          </button>
        </div>
      </div>

      {/* P&L summary — reflects linked payments once any are paired */}
      <div>
        <div className="text-[11px] text-muted mb-2">
          {fromPayments ? "Profit & loss — from linked payments" : "Profit & loss — projected (no payments linked yet)"}
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label: "Revenue",     value: fmtAmount(revenue), clr: "text-ink" },
            { label: "Total costs", value: fmtAmount(costs),   clr: "text-ink" },
            {
              label: profit >= 0 ? "Profit" : "Loss",
              value: fmtAmount(profit),
              clr:   profit >= 0 ? "text-success-ink" : "text-danger-ink",
            },
            {
              label: "Margin",
              value: `${margin.toFixed(1)}%`,
              clr:   margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink",
            },
          ].map((item) => (
            <div key={item.label} className="bg-surface border border-line rounded-xl px-4 py-3">
              <div className="text-[12px] font-medium text-muted">{item.label}</div>
              <div className={`text-[18px] font-bold tabular-nums mt-1 ${item.clr}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Products sold — what was on the invoice */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-line-2">
          <SectionLabel>Products sold{invMeta?.number ? ` · ${invMeta.number}` : ""}</SectionLabel>
        </div>
        {items.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-muted">
                    <th className="text-left font-semibold px-4 py-2">Description</th>
                    <th className="text-right font-semibold px-2 py-2 w-12">Qty</th>
                    <th className="text-right font-semibold px-2 py-2 w-20">Rate</th>
                    <th className="text-right font-semibold px-4 py-2 w-24">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i} className="border-t border-line-2">
                      <td className="px-4 py-1.5 text-ink-2">{it.description}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted">{it.qty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted">{fmtAmount(it.rate)}</td>
                      <td className="px-4 py-1.5 text-right tabular-nums font-medium text-ink">{fmtAmount(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invMeta && (
              <div className="px-4 py-2.5 border-t border-line space-y-0.5 text-[12px] bg-surface-2/60">
                <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(invMeta.subtotal)}</span></div>
                <div className="flex justify-between text-muted"><span>Tax</span><span className="tabular-nums">{fmtAmount(invMeta.tax)}</span></div>
                <div className="flex justify-between font-semibold text-ink"><span>Total</span><span className="tabular-nums">{fmtAmount(invMeta.total)}</span></div>
              </div>
            )}
          </>
        ) : (
          <div className="px-4 py-3 text-[12px] text-muted">No line items on this invoice</div>
        )}
      </div>

      {/* Supplier breakdown — amounts editable in place */}
      {payments.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line-2">
            <SectionLabel>Supplier payments</SectionLabel>
          </div>
          <div className="divide-y divide-line-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink font-medium truncate">{p.supplier_name}</div>
                  {p.quantity != null && p.unit_price != null && (
                    <div className="text-[11px] text-muted tabular-nums">
                      {p.quantity} × {fmtAmount(p.unit_price)}
                    </div>
                  )}
                </div>
                {editId === p.id ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <input
                      type="text"
                      inputMode="decimal"
                      autoFocus
                      value={editAmt}
                      disabled={saving}
                      onChange={(e) => setEditAmt(e.target.value)}
                      className={`${fieldCls} w-24 px-2 h-8 text-right`}
                    />
                    <button type="button" onClick={() => saveEdit(p)} disabled={saving} title="Save"
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-50 transition-colors">
                      <Check size={13} />
                    </button>
                    <button type="button" onClick={cancelEdit} disabled={saving} title="Cancel"
                      className="h-8 w-8 flex items-center justify-center rounded-lg border border-line text-muted hover:text-ink-2 transition-colors">
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(p.amount)}</span>
                    <button type="button" onClick={() => startEdit(p)} disabled={saving} title="Edit cost"
                      className="h-7 w-7 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors">
                      <Pencil size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex justify-between items-center px-4 py-2.5 bg-surface-2/60">
              <span className="text-[11px] text-muted font-medium">Total supplier cost</span>
              <span className="text-[12px] font-bold text-ink tabular-nums">
                {fmtAmount(flow.total_supplier_cost)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Payout, lead rep & refunds (refund-aware owner split) */}
      <RefundPanel dealFlowId={flow.id} />

      {/* Pair real bank transactions to the deal's money legs → actual profit */}
      <ReconciliationPanel flow={flow} />

      {/* Full refund workflow: received money, owed, refund payments, remaining */}
      <RefundWorkspace dealFlowId={flow.id} onChange={onReload} />

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleReopen}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2
                     px-3 h-8 border border-line rounded-lg hover:bg-surface-2 transition-colors"
        >
          <RotateCcw size={12} /> Reopen
        </button>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="flex items-center gap-1.5 text-[12px] text-danger-ink hover:text-danger-ink
                     px-3 h-8 border border-danger rounded-lg hover:bg-danger-bg transition-colors ml-auto"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-semibold text-ink-2 mb-0.5">
      {children}
    </div>
  );
}
