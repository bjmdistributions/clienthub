import { useEffect, useState } from "react";
import { FileDown, Loader2, Plus, Trash2, ShoppingCart } from "lucide-react";
import { api, type PurchaseOrderLine } from "../lib/api";
import { toast } from "./Toast";

const DEFAULT_TERMS = `This purchase order is binding only once the buyer verifies every condition below in full. Funds are released only after all of them are met.

1. Live inspection. Before any payment or deposit, the buyer inspects the entire lot live, in person at the warehouse or on a scheduled FaceTime or video call. Recorded video or photos alone do not satisfy this.

2. Proof of life. The seller sends current photos and video showing the inventory packed and ready, with a handwritten note placed visibly on or beside the goods naming the buyer, today's date, the current time, and this PO number.

3. Authenticity. Every pair must be 100% authentic, original manufacturer stock, brand new in original boxes unless written otherwise. Release of payment is subject to an authentication check (CheckCheck, Legit App, or in-person verification). If any pair fails, or arrives counterfeit, grey-market or an unauthorized replica, this order is void at once, any payment is returned in full immediately, and the seller bears the return liability.

4. Condition and shortage. Units must match the SKU manifest and condition above. Any missing pairs, damaged boxes, or a discrepancy in the size runs means an immediate downward price adjustment or cancellation of the order.`;

const INPUT_CLASS =
  "w-full border border-line px-3 h-10 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const money = (n: number) => "$" + (Number.isFinite(n) ? n.toFixed(2) : "0.00");

const blankLine = (): PurchaseOrderLine => ({
  style: "",
  sku: "",
  size: "",
  condition: "New",
  qty: 0,
  unit_price: 0,
});

export default function PurchaseOrderView() {
  const [poNumber, setPoNumber] = useState(() => "PO-" + new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [buyerName, setBuyerName] = useState("");
  const [buyerCompany, setBuyerCompany] = useState("");
  const [buyerContact, setBuyerContact] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [sellerCompany, setSellerCompany] = useState("");
  const [sellerContact, setSellerContact] = useState("");
  const [items, setItems] = useState<PurchaseOrderLine[]>([blankLine()]);
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [buyerSignName, setBuyerSignName] = useState("");
  const [sellerSignName, setSellerSignName] = useState("");
  const [working, setWorking] = useState(false);

  // The buyer is our own company, so prefill it once and let the user change it.
  useEffect(() => {
    api.getCompanyInfo().then((c) => {
      if (!c) return;
      setBuyerCompany(c.name || "");
      setBuyerContact(c.phone || c.email || "");
    }).catch(() => {});
  }, []);

  const setLine = (i: number, patch: Partial<PurchaseOrderLine>) =>
    setItems((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const totalUnits = items.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalPrice = items.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);

  const download = async () => {
    if (working) return;
    setWorking(true);
    try {
      const path = await api.generatePurchaseOrder({
        po_number: poNumber.trim(),
        po_date: poDate,
        buyer_name: buyerName.trim(),
        buyer_company: buyerCompany.trim(),
        buyer_contact: buyerContact.trim(),
        seller_name: sellerName.trim(),
        seller_company: sellerCompany.trim(),
        seller_contact: sellerContact.trim(),
        items: items
          .filter((l) => l.style.trim() || l.sku.trim())
          .map((l) => ({ ...l, qty: Number(l.qty) || 0, unit_price: Number(l.unit_price) || 0 })),
        terms,
        buyer_sign_name: buyerSignName.trim(),
        seller_sign_name: sellerSignName.trim(),
        output_path: "",
      });
      toast(`Saved to Downloads: ${path.split(/[\\/]/).pop()}`);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="p-6 max-w-[860px] space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0 mt-0.5">
          <ShoppingCart size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">Purchase order</h2>
          <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
            Build a purchase order on your letterhead. The terms below default to full
            protection, inspection before payment and authenticity checks; edit them to fit.
          </p>
        </div>
      </div>

      {/* Parties */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2.5">
            <div className="text-[12px] font-semibold text-ink-2 uppercase tracking-wide">Buyer (you)</div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Name</label>
              <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Your name" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Company</label>
              <input value={buyerCompany} onChange={(e) => setBuyerCompany(e.target.value)} placeholder="Company name" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Contact</label>
              <input value={buyerContact} onChange={(e) => setBuyerContact(e.target.value)} placeholder="Phone, WhatsApp or email" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
          </div>
          <div className="space-y-2.5">
            <div className="text-[12px] font-semibold text-ink-2 uppercase tracking-wide">Seller</div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Name</label>
              <input value={sellerName} onChange={(e) => setSellerName(e.target.value)} placeholder="Seller name" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Company</label>
              <input value={sellerCompany} onChange={(e) => setSellerCompany(e.target.value)} placeholder="Seller company" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-[12px] font-medium text-muted">Contact</label>
              <input value={sellerContact} onChange={(e) => setSellerContact(e.target.value)} placeholder="Phone or email" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
            </div>
          </div>
        </div>
      </div>

      {/* Order details */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-muted">PO number</label>
            <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-muted">Date</label>
            <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[12px] font-semibold text-ink-2 uppercase tracking-wide">Inventory schedule</div>
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-[11px] text-muted text-left">
                  <th className="font-medium py-1 pr-2 min-w-[140px]">Style / model</th>
                  <th className="font-medium py-1 pr-2 min-w-[96px]">SKU / style #</th>
                  <th className="font-medium py-1 pr-2 min-w-[52px]">Size</th>
                  <th className="font-medium py-1 pr-2 min-w-[84px]">Condition</th>
                  <th className="font-medium py-1 pr-2 w-16 text-right">Qty</th>
                  <th className="font-medium py-1 pr-2 w-24 text-right">Unit price</th>
                  <th className="font-medium py-1 w-24 text-right">Extended</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((l, i) => (
                  <tr key={i} className="border-t border-line-2">
                    <td className="py-1.5 pr-2">
                      <input value={l.style} onChange={(e) => setLine(i, { style: e.target.value })} placeholder="Nike Dunk Low Retro" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} placeholder="DD1391-100" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={l.size} onChange={(e) => setLine(i, { size: e.target.value })} placeholder="10" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={l.condition} onChange={(e) => setLine(i, { condition: e.target.value })} placeholder="New" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input type="number" min={0} value={l.qty || ""} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="0" style={{ background: "var(--t-input-bg)" }} className={`${INPUT_CLASS} text-right`} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input type="number" min={0} step="0.01" value={l.unit_price || ""} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} placeholder="0.00" style={{ background: "var(--t-input-bg)" }} className={`${INPUT_CLASS} text-right`} />
                    </td>
                    <td className="py-1.5 text-right text-ink-2 tabular-nums font-medium whitespace-nowrap">
                      {money((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}
                    </td>
                    <td className="py-1.5 pl-1">
                      <button onClick={() => setItems((x) => x.filter((_, j) => j !== i))} title="Remove row"
                        className="p-1.5 rounded-lg text-faint hover:text-danger-ink hover:bg-danger-bg transition-colors disabled:opacity-30" disabled={items.length <= 1}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => setItems((x) => [...x, blankLine()])}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium border border-line text-ink-2 hover:bg-surface-2 px-3 h-8 rounded-lg transition-colors">
            <Plus size={13} /> Add line
          </button>
          <div className="flex justify-end gap-6 pt-1 border-t border-line-2 text-[13px]">
            <span className="text-muted">Total units <span className="tabular-nums text-ink-2 font-medium">{totalUnits}</span></span>
            <span className="text-muted">Total purchase price <span className="tabular-nums text-ink font-semibold">{money(totalPrice)}</span></span>
          </div>
        </div>
      </div>

      {/* Terms */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-2.5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <label className="text-[12px] font-medium text-muted">Terms &amp; contingencies of purchase</label>
          <span className="text-[11.5px] text-faint">Editable. It ships with the protection clauses below.</span>
        </div>
        <textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={16}
          style={{ background: "var(--t-input-bg)" }}
          className="w-full border border-line px-3 py-2.5 rounded-lg text-[13px] text-ink leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y" />
      </div>

      {/* Signatures */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <div className="text-[12px] font-semibold text-ink-2 uppercase tracking-wide">Signatures</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-muted">Buyer (signed by)</label>
            <input value={buyerSignName} onChange={(e) => setBuyerSignName(e.target.value)} placeholder="Your name" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-muted">Seller (signed by)</label>
            <input value={sellerSignName} onChange={(e) => setSellerSignName(e.target.value)} placeholder="Seller name" style={{ background: "var(--t-input-bg)" }} className={INPUT_CLASS} />
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={download} disabled={working}
          className="inline-flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          {working ? (<><Loader2 size={14} className="animate-spin" /> Saving…</>) : (<><FileDown size={14} /> Download PDF</>)}
        </button>
      </div>
    </div>
  );
}
