import { Check, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, DealFlow, SupplierPayment, SupplierPaymentInput, isResoldLine } from "../lib/api";
import { fmtAmount, primarySupplierLabel, localDay } from "../lib/format";
import { toast } from "./Toast";
import RefundPanel from "./RefundPanel";
import ReconciliationPanel from "./ReconciliationPanel";
import RefundWorkspace from "./RefundWorkspace";
import ResoldNote from "./ResoldNote";

// Shared field styling (matches DealFlowView's `inp` focus pattern).
const fieldCls =
  "border border-line-3 rounded-lg bg-transparent text-[13px] tabular-nums " +
  "focus:outline-none focus:border-ink transition-colors duration-150";

// ─── Completed deal full breakdown ────────────────────────────────────────
// Shared by DealFlowView's completed list and the supplier deal history.
export default function CompletedBreakdown({ flow, onReload }: { flow: DealFlow; onReload: () => void }) {
  const [saving, setSaving] = useState(false);
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  // R-438: bumped when the refund step or Link financials beside them change the deal's money.
  const [moneyRev, setMoneyRev] = useState(0);
  useEffect(() => { api.dealReconciliation(flow.id).then(setRecon).catch(() => {}); }, [flow.id, flow.updated_at, moneyRev]);

  // Once bank payments are paired, the P&L reflects what actually moved (from the
  // linked payments), not the deal's projected figures. Nothing linked → projected.
  const paired = recon ? recon.pieces.buyer_paired + recon.pieces.supplier_paired + recon.pieces.fee_paired : 0;
  const fromPayments = paired > 0.005;
  const revenue = fromPayments ? recon!.pieces.buyer_paired : flow.gross_revenue;
  const costs   = fromPayments ? recon!.pieces.supplier_paired + recon!.pieces.fee_paired + recon!.pieces.refund_total - recon!.pieces.refund_in : flow.total_cost;
  const profit  = fromPayments ? recon!.actual_profit : flow.net_profit;
  // No revenue recorded means there is no margin - "0.0%" would read as a real
  // figure. Matches marginOf on the suppliers table, which renders an em dash.
  const margin  = revenue > 0 ? (profit / revenue) * 100 : null;
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
        // R-511 FD-08: the edit sends back what the line already is, so changing the amount cannot un-bill
        // a freight line or erase a partner split.
        supplier_billed: p.supplier_billed ?? false,
        split:         p.split ?? null,
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

  const stat = (label: string, value: string, clr: string) => (
    <div className="min-w-0">
      <div className="ui-label">{label}</div>
      <div className={`text-[20px] font-medium tabular-nums tracking-tight mt-1 ${clr}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Buyer and supplier + editable closing date */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 min-w-0">
          <div className="min-w-0">
            <div className="ui-label">Buyer</div>
            <div className="text-[14px] text-ink font-medium truncate mt-0.5">{flow.client_name || "-"}</div>
          </div>
          {supplierLabel && (
            <div className="min-w-0">
              <div className="ui-label">Supplier</div>
              <div className="text-[14px] text-ink-2 truncate mt-0.5">{supplierLabel}</div>
            </div>
          )}
        </div>
        <div className="flex items-end gap-2">
          <div>
            <div className="ui-label mb-1">Closing date</div>
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
              className="ui-btn ui-btn-ink ui-btn-sm"
            >
              Save
            </button>
          )}
        </div>
      </div>
      <p className="ui-note -mt-3">Change the closing date to backlog a sale into the right month or week for the reports.</p>

      {/* Payout routing: flip past deals onto (or off) the configured split */}
      <div className="space-y-1.5">
        <div className="ui-label">Where does this deal's profit go?</div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={saving} onClick={() => setIncluded(true)} aria-pressed={payoutIncluded}
            className={`ui-opt ${payoutIncluded ? "on" : ""}`}>
            Apply profit split
          </button>
          <button type="button" disabled={saving} onClick={() => setIncluded(false)} aria-pressed={!payoutIncluded}
            className={`ui-opt ${!payoutIncluded ? "on" : ""}`}>
            Business keeps 100%
          </button>
        </div>
      </div>

      <div className="hsep" />

      {/* P&L summary: reflects linked payments once any are paired */}
      <div>
        <div className="ui-label mb-2">
          {fromPayments ? "Profit and loss, from linked payments" : "Profit and loss, projected (no payments linked yet)"}
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-[1fr_1px_1fr_1px_1fr_1px_1fr] gap-x-4 gap-y-3">
          {stat("Revenue", fmtAmount(revenue), "text-ink")}
          <div className="vsep hidden xl:block" />
          {stat("Total costs", fmtAmount(costs), "text-ink")}
          <div className="vsep hidden xl:block" />
          {stat(profit >= 0 ? "Profit" : "Loss", fmtAmount(Math.abs(profit)), profit >= 0 ? "text-success-ink" : "text-danger-ink")}
          <div className="vsep hidden xl:block" />
          {stat("Margin", margin === null ? "-" : `${margin.toFixed(1)}%`,
            margin === null ? "text-faint" : margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink")}
        </div>
      </div>

      <div className="hsep" />

      {/* Products sold: what was on the invoice */}
      <div>
        <SectionLabel>Products sold{invMeta?.number ? ` · ${invMeta.number}` : ""}</SectionLabel>
        {items.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="ui-table ui-table-sm">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="r w-16">Qty</th>
                    <th className="r w-24">Rate</th>
                    <th className="r w-28">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="text-ink-2">{it.description}</td>
                      <td className="r text-muted">{it.qty}</td>
                      <td className="r text-muted">{fmtAmount(it.rate)}</td>
                      <td className="r font-medium text-ink">{fmtAmount(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invMeta && (
              <div className="pt-2 space-y-0.5 text-[13px] border-t border-line">
                <div className="flex justify-between text-muted"><span>Subtotal</span><span className="tabular-nums">{fmtAmount(invMeta.subtotal)}</span></div>
                <div className="flex justify-between text-muted"><span>Tax</span><span className="tabular-nums">{fmtAmount(invMeta.tax)}</span></div>
                <div className="flex justify-between font-medium text-ink"><span>Total</span><span className="tabular-nums">{fmtAmount(invMeta.total)}</span></div>
              </div>
            )}
          </>
        ) : (
          <div className="py-2 text-[13px] text-muted">No line items on this invoice</div>
        )}
      </div>

      {/* Supplier breakdown: amounts editable in place */}
      {payments.length > 0 && (
        <>
          <div className="hsep" />
          <div>
            <SectionLabel>Supplier payments</SectionLabel>
            <div>
              {payments.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-2.5 border-t border-line first:border-t-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-ink font-medium truncate">{p.supplier_name}</div>
                    {p.quantity != null && p.unit_price != null && (
                      <div className="text-[12px] text-muted tabular-nums">
                        {p.quantity} × {fmtAmount(p.unit_price)}
                      </div>
                    )}
                    {flow.shipping_mode && p.category === "freight" && (
                      <div className="text-[12px] text-muted">Replaced by the logistics booking, not counted</div>
                    )}
                    {p.notes && <ResoldNote note={p.notes} />}
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
                      <button type="button" onClick={() => saveEdit(p)} disabled={saving} title="Save" aria-label="Save"
                        className="ui-ib hover:!text-success-ink disabled:opacity-50">
                        <Check size={16} />
                      </button>
                      <button type="button" onClick={cancelEdit} disabled={saving} title="Cancel" aria-label="Cancel"
                        className="ui-ib disabled:opacity-50">
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[13px] font-medium tabular-nums ${flow.shipping_mode && p.category === "freight" ? "text-muted line-through" : "text-ink"}`}>{fmtAmount(p.amount)}</span>
                      {/* A partner line's amount is worked out from its split, so it is not retyped here. */}
                      {!isResoldLine(p) && !p.split && (
                        <button type="button" onClick={() => startEdit(p)} disabled={saving} title="Edit cost" aria-label="Edit cost"
                          className="ui-ib">
                          <Pencil size={16} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <div className="flex justify-between items-center py-2 border-t border-line">
                <span className="text-[12px] text-muted">Total supplier cost</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {/* With a recorded shipping leg, the goods are what the record holds less that leg, so the rows add up */}
                  {fmtAmount(flow.shipping_cost != null ? flow.total_cost - flow.shipping_cost : flow.total_supplier_cost)}
                </span>
              </div>
              {/* R-400: shipping is its own leg of the recorded cost */}
              <div className="flex justify-between items-center py-2">
                <span className="text-[12px] text-muted">Shipping</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {fmtAmount(flow.shipping_cost ?? 0)}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[12px] text-muted">Total cost recorded</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {fmtAmount(flow.total_cost)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="hsep" />

      {/* Payout, lead rep & refunds (refund-aware owner split) */}
      <RefundPanel dealFlowId={flow.id} refreshKey={flow.updated_at} />

      <div className="hsep" />

      {/* Pair real bank transactions to the deal's money legs → actual profit */}
      <ReconciliationPanel flow={flow} reloadKey={moneyRev} onChange={() => { setMoneyRev((n) => n + 1); onReload(); }} />

      <div className="hsep" />

      {/* Full refund workflow: received money, owed, refund payments, remaining */}
      <RefundWorkspace dealFlowId={flow.id} reloadKey={moneyRev} onChange={() => { setMoneyRev((n) => n + 1); onReload(); }} />

      {/* Actions */}
      <div className="hsep" />
      <div className="flex items-center gap-3">
        <button onClick={handleReopen} disabled={saving} className="ui-btn ui-btn-sm">
          <RotateCcw size={14} /> Reopen
        </button>
        <button onClick={handleDelete} disabled={saving} className="ui-btn ui-btn-sm ui-btn-danger ml-auto">
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[14px] font-medium text-ink mb-1">
      {children}
    </div>
  );
}
