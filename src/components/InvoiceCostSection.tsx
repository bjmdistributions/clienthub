import { useEffect, useMemo, useState } from "react";
import { X, Plus } from "lucide-react";
import { api, DealFlow, Supplier, PayoutShare } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";
import CostProfitPanel from "./CostProfitPanel";
import StatusPill from "./StatusPill";

/**
 * Cost & profit on an invoice — read and written through the DEAL, never stored on the
 * invoice.
 *
 * There is exactly one place a deal's cost may live: `deal_flows.supplier_payments`. It
 * carries the supplier the money is owed to, whether that leg has gone out, and whether
 * the bill was kept rather than paid — which is what feeds payables, the payout split and
 * `total_supplier_cost`. A free-text cost typed against the invoice has none of that, and
 * writing one to `invoices.total_cost/profit/margin` puts it in direct conflict with the
 * deal-flow pipeline, which owns those three columns and rewrites them on complete and
 * uncomplete. That is why the only cost editor on this screen is this one.
 *
 * Deliberately the same controls as the Deal Flow supplier section, because a cost entered
 * from an invoice and a cost entered from the deal must produce identical rows.
 */

const COST_TYPES = [
  { value: "supplier", label: "Supplier" },
  { value: "freight",  label: "Freight" },
  { value: "wire_in",  label: "Incoming wire fee" },
  { value: "wire_out", label: "Outgoing wire fee" },
  { value: "other",    label: "Other cost" },
];
const catLabel = (c?: string | null) =>
  c === "freight" ? "Freight" : c === "wire_in" ? "Wire in" :
  c === "wire_out" ? "Wire out" : c === "other" ? "Other" : "Supplier";

const parseAmt = (v: string) => parseFloat(String(v).replace(/[^0-9.-]/g, "")) || 0;

export default function InvoiceCostSection({
  flow, invoiceTotal, onReload,
}: {
  flow: DealFlow;
  /** Revenue to measure margin against while the buyer has not paid yet. */
  invoiceTotal: number;
  onReload: () => void;
}) {
  const [recipients, setRecipients] = useState<PayoutShare[]>([]);
  const [adding,  setAdding]  = useState(false);
  const [saving,  setSaving]  = useState(false);
  // A completed deal is read-only until explicitly unlocked — the same rule as the Deals
  // screen, so a finished deal's recorded profit cannot be moved by a stray click.
  const [unlocked, setUnlocked] = useState(false);

  const [costType,   setCostType]   = useState("supplier");
  const [suppName,   setSuppName]   = useState("");
  const [suppHits,   setSuppHits]   = useState<Supplier[]>([]);
  const [selSupp,    setSelSupp]    = useState<Supplier | null>(null);
  const [qty,        setQty]        = useState("");
  const [unitPrice,  setUnitPrice]  = useState("");
  const [amount,     setAmount]     = useState("");
  const [note,       setNote]       = useState("");

  useEffect(() => { api.getPayoutSplit().then(setRecipients).catch(() => {}); }, []);

  // Supplier search — debounced, and skipped once the typed name IS the picked supplier,
  // so choosing one does not immediately re-open the dropdown underneath the cursor.
  useEffect(() => {
    if (costType !== "supplier" || !suppName || selSupp?.name === suppName) { setSuppHits([]); return; }
    const t = setTimeout(() => api.searchSuppliers(suppName).then(setSuppHits).catch(() => setSuppHits([])), 250);
    return () => clearTimeout(t);
  }, [suppName, selSupp?.name, costType]);

  // Quantity × unit price fills the amount, but never overwrites a figure typed by hand.
  useEffect(() => {
    const q = parseAmt(qty), p = parseAmt(unitPrice);
    if (q && p) setAmount((q * p).toFixed(2));
  }, [qty, unitPrice]);

  const payments   = flow.supplier_payments || [];
  const isComplete = flow.stage === "complete";
  const locked     = isComplete && !unlocked;
  // A kept bill was never paid, so it is not a cost — the same exclusion
  // `total_supplier_cost` makes. Counting it here would contradict the profit above it.
  const totalCost  = useMemo(
    () => payments.filter((p) => !p.kept).reduce((s, p) => s + p.amount, 0),
    [payments],
  );

  const resetForm = () => {
    setCostType("supplier"); setSuppName(""); setSelSupp(null); setSuppHits([]);
    setQty(""); setUnitPrice(""); setAmount(""); setNote("");
  };

  const add = async () => {
    const isSupp = costType === "supplier";
    const name = isSupp
      ? suppName.trim()
      : (note.trim() || COST_TYPES.find((c) => c.value === costType)?.label || "Cost");
    if (!name) { toast("Name the supplier or the cost", "error"); return; }
    const amt = parseAmt(amount);
    // $0 is legitimate (free goods, consignment) but is far more often a forgotten field,
    // and it books the whole invoice as profit — so it asks.
    if (!amt && !confirm("Submit $0 as the cost for this deal? Your profit will equal the full revenue. Are you sure?")) return;
    setSaving(true);
    try {
      await api.addSupplierPayment(flow.id, {
        supplier_name: name,
        supplier_id: isSupp ? (selSupp?.id ?? null) : null,
        amount: amt,
        quantity:   isSupp && parseAmt(qty)       ? parseAmt(qty)       : null,
        unit_price: isSupp && parseAmt(unitPrice) ? parseAmt(unitPrice) : null,
        category: costType,
      });
      resetForm(); setAdding(false); onReload();
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    try { await fn(); onReload(); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const inp = "w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12.5px] font-medium text-muted">Cost &amp; profit</div>
          <div className="text-[11px] text-muted mt-0.5">Recorded on the deal — the same lines show under Deal Flow.</div>
        </div>
        {isComplete && (
          <button onClick={() => setUnlocked((v) => !v)}
            className="text-[11.5px] text-muted hover:text-ink-2 border border-line rounded-lg px-2.5 py-1 transition-colors">
            {locked ? "Edit" : "Done editing"}
          </button>
        )}
      </div>

      <CostProfitPanel flow={flow} recipients={recipients} fallbackRevenue={invoiceTotal} />

      {payments.length > 0 && (
        <div className="space-y-1.5">
          {payments.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-line rounded-lg">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1.5">
                  {p.supplier_name}
                  {p.category && p.category !== "supplier" && (
                    <StatusPill tone="accent">{catLabel(p.category)}</StatusPill>
                  )}
                </div>
                {p.quantity != null && p.unit_price != null && (
                  <div className="text-[11px] text-muted tabular-nums">{p.quantity} × {fmtAmount(p.unit_price)}</div>
                )}
                {p.paid && <div className="text-[10.5px] text-success-ink font-medium">Paid</div>}
                {p.kept && <div className="text-[10.5px] text-accent font-medium">Kept — didn't pay, not counted as a cost</div>}
                {!locked && (
                  <div className="flex items-center gap-2.5 mt-0.5">
                    {!p.kept && (
                      <button disabled={saving}
                        onClick={() => act(() => p.paid ? api.unmarkSupplierPaymentPaid(flow.id, p.id) : api.markSupplierPaymentPaid(flow.id, p.id))}
                        className="text-[10.5px] text-muted hover:text-ink-2 disabled:opacity-40">
                        {p.paid ? "Undo — not paid yet" : "Mark paid"}
                      </button>
                    )}
                    {!p.paid && (
                      <button disabled={saving}
                        onClick={() => {
                          // Keeping a bill CHANGES THE RECORDED PROFIT, so it asks first.
                          if (!p.kept && !confirm(`Drop ${fmtAmount(p.amount)} for ${p.supplier_name} from this deal's cost? Profit goes up by that amount.`)) return;
                          act(() => api.setSupplierPaymentKept(flow.id, p.id, !p.kept));
                        }}
                        className="text-[10.5px] text-muted hover:text-ink-2 disabled:opacity-40">
                        {p.kept ? "Undo — I did pay this" : "Didn't pay — keep it"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className={`text-[13px] font-semibold tabular-nums ${p.kept ? "text-muted line-through" : "text-ink"}`}>{fmtAmount(p.amount)}</div>
              {!locked && (
                <button title="Remove this cost line" disabled={saving}
                  onClick={() => { if (confirm("Remove this cost line?")) act(() => api.removeSupplierPayment(flow.id, p.id)); }}
                  className="text-faint hover:text-danger-ink transition-colors disabled:opacity-40"><X size={13} /></button>
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2 text-[11px] text-muted pr-1">
            <span>Total cost</span>
            <span className="font-semibold text-ink tabular-nums w-24 text-right">{fmtAmount(totalCost)}</span>
          </div>
        </div>
      )}

      {payments.length === 0 && !adding && (
        <div className="text-[12px] text-muted px-1">No cost recorded yet.</div>
      )}

      {!locked && !adding && (
        <button onClick={() => setAdding(true)}
          className="w-full flex items-center justify-center gap-1.5 border border-dashed border-line-3 hover:border-accent/40 hover:bg-accent/5 text-ink-2 h-9 rounded-lg text-[12.5px] font-medium transition-colors">
          <Plus size={13} /> Add cost
        </button>
      )}

      {!locked && adding && (
        <div className="border border-line rounded-xl p-3 space-y-2.5 bg-surface-2/40">
          <select value={costType} onChange={(e) => { setCostType(e.target.value); setSelSupp(null); }} className={inp}>
            {COST_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>

          {costType === "supplier" ? (
            <>
              <div className="relative">
                <input className={inp} placeholder="Search suppliers, or type a new name"
                  value={suppName}
                  onChange={(e) => { setSuppName(e.target.value); setSelSupp(null); }} />
                {suppHits.length > 0 && (
                  <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg max-h-44 overflow-auto">
                    {suppHits.map((s) => (
                      <button key={s.id} onClick={() => { setSelSupp(s); setSuppName(s.name); setSuppHits([]); }}
                        className="w-full text-left px-3 py-2 text-[13px] text-ink-2 hover:bg-surface-2 transition-colors">
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input className={inp} placeholder="Qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
                <input className={inp} placeholder="Your unit cost" inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
              </div>
            </>
          ) : (
            <input className={inp} placeholder="What is this cost? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          )}

          <input className={inp} placeholder="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />

          <div className="flex gap-2">
            <button onClick={add} disabled={saving}
              className="flex-1 bg-accent hover:bg-accent-hover text-on-accent h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
              {saving ? "Saving…" : "Add cost"}
            </button>
            <button onClick={() => { resetForm(); setAdding(false); }}
              className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px] hover:bg-surface-2 transition-colors">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
