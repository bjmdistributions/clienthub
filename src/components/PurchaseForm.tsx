// R-596: a purchase order on one screen. Who it is from (the one Supplier field), their invoice number and date, the invoice as
// lines (what, how many, price each) or just a total and a unit count, the shipping in (until a truck brings it in), and notes.
// Lines make the total and the units, live as they are typed. buy_core.rs and the server check and keep them.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { api, type BuyDetail } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { cleanLines, linesTotals, purchaseName } from "../lib/purchases";
import { SupplierField } from "./BuyPanel";
import NumberInput from "./NumberInput";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

interface Row { key: number; what: string; qty: number; price: number }

export default function PurchaseForm({ detail, onSaved, onCancel }: { detail: BuyDetail | null; onSaved: (d: BuyDetail) => void; onCancel: () => void }) {
  const b = detail?.buy;
  const shipLocked = (detail?.truck_cost.live ?? 0) > 0;
  const [supplier, setSupplier] = useState(b?.supplier_name ?? "");
  const [supplierId, setSupplierId] = useState(b?.supplier_id ?? "");
  const [invoiceNo, setInvoiceNo] = useState(b?.invoice_no ?? "");
  const [invoiceDate, setInvoiceDate] = useState(b?.invoice_date ?? "");
  const [byLines, setByLines] = useState(b ? b.lines.length > 0 : true);
  const [next, setNext] = useState(100);
  const [rows, setRows] = useState<Row[]>(b && b.lines.length > 0 ? b.lines.map((l, i) => ({ key: i, ...l })) : [{ key: 0, what: "", qty: 0, price: 0 }]);
  const [total, setTotal] = useState<number>(b && b.lines.length === 0 ? b.goods_total : 0);
  const [units, setUnits] = useState<number>(b && b.lines.length === 0 ? b.units_bought : 0);
  const [ship, setShip] = useState<number>(b?.ship_typed ?? 0);
  const [notes, setNotes] = useState(b?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const live = linesTotals(rows);
  const goods = byLines ? live.total : total;
  const count = byLines ? live.units : units;
  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => { setRows((rs) => [...rs, { key: next, what: "", qty: 0, price: 0 }]); setNext(next + 1); };
  const dropRow = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [{ key, what: "", qty: 0, price: 0 }]));

  const save = async () => {
    const lines = cleanLines(rows);
    if (byLines && lines.length === 0) { toast("Add at least one line: what it is and how many.", "error"); return; }
    if (!byLines && !(goods > 0)) { toast("Enter what the invoice comes to.", "error"); return; }
    setBusy(true);
    try {
      const input = {
        name: b?.name || purchaseName({ supplier, invoiceNo, firstLine: lines[0]?.what }),
        supplier_name: supplier.trim(), supplier_id: supplierId || undefined,
        invoice_no: invoiceNo.trim(), invoice_date: invoiceDate, notes,
        ...(shipLocked ? {} : { ship_total: ship }),
        ...(byLines ? { lines } : { lines: [], goods_total: total, units_bought: units > 0 ? units : 0 }),
      };
      onSaved(b ? await api.updateWarehouseBuy(b.id, input) : await api.createWarehouseBuy(input));
    } catch (e) { toast(String(e), "error"); setBusy(false); }
  };

  const cell = `${WH_INPUT} tabular-nums`;
  return (
    <div className={`${WH_CARD} p-5 space-y-5 max-w-[860px]`}>
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{b ? "Change this order" : "New order"}</h3>
        <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
          Type in the invoice the supplier sent. Nothing goes in the warehouse unless you choose to put it there.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-1"><SupplierField name={supplier} saved={b?.supplier_name} onChange={(n, i) => { setSupplier(n); setSupplierId(i); }} /></div>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Their invoice number</span>
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Invoice date</span>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[13px] font-semibold text-ink">The invoice</span>
          <span className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="How to enter the invoice">
            <button type="button" aria-pressed={byLines} onClick={() => setByLines(true)}
              className={`text-[12px] px-2.5 h-7 rounded-md ${byLines ? "bg-surface-2 text-ink font-medium" : "text-muted"}`}>Line by line</button>
            <button type="button" aria-pressed={!byLines} onClick={() => setByLines(false)}
              className={`text-[12px] px-2.5 h-7 rounded-md ${!byLines ? "bg-surface-2 text-ink font-medium" : "text-muted"}`}>Just a total</button>
          </span>
        </div>
        {byLines ? (
          <div className="space-y-2">
            <div className="hidden md:grid grid-cols-[1fr_110px_130px_110px_28px] gap-2 text-[12px] text-muted px-0.5">
              <span>What it is</span><span className="text-right">How many</span><span className="text-right">Price each</span><span className="text-right">Line total</span><span />
            </div>
            {rows.map((r) => (
              <div key={r.key} className="grid grid-cols-2 md:grid-cols-[1fr_110px_130px_110px_28px] gap-2 items-center">
                <input value={r.what} onChange={(e) => setRow(r.key, { what: e.target.value })} aria-label="What it is" placeholder="Like: Nike shoes, men's"
                  className={`${WH_INPUT} col-span-2 md:col-span-1`} style={WH_INPUT_BG} />
                <NumberInput integer value={r.qty || ""} onValue={(n) => setRow(r.key, { qty: n })} aria-label="How many" className={`${cell} text-right`} style={WH_INPUT_BG} />
                <NumberInput value={r.price || ""} onValue={(n) => setRow(r.key, { price: n })} aria-label="Price each" className={`${cell} text-right`} style={WH_INPUT_BG} />
                <span className="text-right text-[13px] tabular-nums text-ink-2">{fmtAmount(Math.round(r.qty) * Math.max(0, r.price))}</span>
                <button type="button" onClick={() => dropRow(r.key)} aria-label="Remove this line" className="text-faint hover:text-danger-ink justify-self-end"><X size={14} /></button>
              </div>
            ))}
            <button type="button" onClick={addRow} className="inline-flex items-center gap-1.5 text-[12.5px] text-accent-hover hover:underline"><Plus size={13} /> Add a line</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[520px]">
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">What the invoice comes to</span>
              <NumberInput value={total || ""} onValue={setTotal} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
              <span className="block text-[11.5px] text-muted mt-1">The goods, without the shipping.</span>
            </label>
            <label className="block">
              <span className="text-[12px] font-medium text-ink-2">How many units (if you know)</span>
              <NumberInput integer value={units || ""} onValue={setUnits} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
            </label>
          </div>
        )}
        <div className="text-[13px] text-ink-2 tabular-nums">
          {count > 0 || goods > 0
            ? <>The invoice comes to <span className="font-semibold text-ink">{fmtAmount(goods)}</span>{count > 0 ? <> for <span className="font-semibold text-ink">{n0(count)}</span> {count === 1 ? "unit" : "units"}</> : null}.</>
            : "Nothing on the invoice yet."}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {!shipLocked && (
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">Shipping in</span>
            <NumberInput value={ship || ""} onValue={setShip} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
            <span className="block text-[11.5px] text-muted mt-1">Leave it empty until you know it. Once you send it to logistics, the trucks set it.</span>
          </label>
        )}
        {shipLocked && (
          <div className="block">
            <span className="text-[12px] font-medium text-ink-2">Shipping in</span>
            <div className={`${WH_INPUT} mt-1 flex items-center tabular-nums text-ink-2 bg-surface-2`}>{fmtAmount(b?.ship_total ?? 0)}</div>
            <span className="block text-[11.5px] text-muted mt-1">From the trucks, so there is nothing to type here.</span>
          </div>
        )}
        <label className="block">
          <span className="text-[12px] font-medium text-ink-2">Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <button onClick={onCancel} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : b ? "Save changes" : "Save the order"}</button>
      </div>
    </div>
  );
}
