// R-596: a purchase order on one screen. Who it is from (the one Supplier field), their invoice number and date, the invoice as
// lines (what, how many, price each) or just a total and a unit count, the shipping in (until a truck brings it in), and notes.
// Lines make the total and the units, live as they are typed. buy_core.rs and the server check and keep them.
// R-648: a new one is Receive a load, asked as questions in order: who from, what came in, which truck already set up in
// Logistics brought it (or what the shipping cost), whether all of it arrived and the day, and whether it is on pallets and
// where. The truck is linked and the pallets made after the load is saved; boxes are never asked for.
import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { api, type BuyDetail, type FreightBooking } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { statusWord } from "../lib/logisticsLoad";
import { cleanLines, linesTotals, purchaseName, receivedProblem } from "../lib/purchases";
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
  // R-648: the questions only Receive a load asks.
  const receive = !b;
  const [trucks, setTrucks] = useState<FreightBooking[] | null>(null);
  const [truckErr, setTruckErr] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [arrived, setArrived] = useState<"all" | "some" | "notyet" | null>(null);
  const [gotCount, setGotCount] = useState(0);
  const [gotDay, setGotDay] = useState("");
  const [onPallets, setOnPallets] = useState<boolean | null>(null);
  const [palletCount, setPalletCount] = useState(0);
  const [spot, setSpot] = useState("");
  useEffect(() => {
    if (!receive) return;
    // Only a load with no deal behind it can bring stock in: a deal's truck ships that deal.
    api.logistics.list()
      .then((r) => setTrucks((r.bookings ?? []).filter((t) => t.standalone && t.status !== "cancelled")))
      .catch((e) => { setTrucks([]); setTruckErr(String(e)); });
  }, [receive]);

  const live = linesTotals(rows);
  const goods = byLines ? live.total : total;
  const count = byLines ? live.units : units;
  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => { setRows((rs) => [...rs, { key: next, what: "", qty: 0, price: 0 }]); setNext(next + 1); };
  const dropRow = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [{ key, what: "", qty: 0, price: 0 }]));

  const save = async () => {
    const lines = cleanLines(rows);
    if (receive && !supplier.trim()) { toast("Say who it is from.", "error"); return; }
    if (byLines && lines.length === 0) { toast("Add at least one line: what it is and how many.", "error"); return; }
    if (!byLines && !(goods > 0)) { toast("Enter what the invoice comes to.", "error"); return; }
    // R-648: what arrived and the day, which is always asked and never taken as today.
    let got: { units_received: number; received_at: string } | null = null;
    if (receive) {
      if (!arrived) { toast("Say whether all of it arrived.", "error"); return; }
      if (arrived !== "notyet") {
        if (arrived === "all" && !(count > 0)) { toast("Say how many units came, on the invoice.", "error"); return; }
        const n = arrived === "all" ? count : gotCount;
        const why = receivedProblem(n, gotDay);
        if (why) { toast(why === "Say the day it was counted." ? "Say the day it came in." : why, "error"); return; }
        got = { units_received: n, received_at: gotDay };
      }
      if (onPallets === null) { toast("Say whether it is on pallets.", "error"); return; }
      if (onPallets && !(palletCount >= 1 && palletCount <= 60)) { toast("Say how many pallets, 1 to 60.", "error"); return; }
    }
    setBusy(true);
    try {
      const name = b?.name || purchaseName({ supplier, invoiceNo, firstLine: lines[0]?.what });
      const input = {
        name,
        supplier_name: supplier.trim(), supplier_id: supplierId || undefined,
        invoice_no: invoiceNo.trim(), invoice_date: invoiceDate, notes,
        ...(shipLocked || chosen.length > 0 ? {} : { ship_total: ship }),
        ...(byLines ? { lines } : { lines: [], goods_total: total, units_bought: units > 0 ? units : 0 }),
        ...(got ?? {}),
      };
      if (b) { onSaved(await api.updateWarehouseBuy(b.id, input)); return; }
      const made = await api.createWarehouseBuy(input);
      const id = made.buy.id;
      // The load is saved. What hangs on it comes next; a step that fails says so and can be done from the load's page.
      for (const t of chosen) {
        await api.logistics.linkBuy(t, id).catch((e) => toast(`The load is saved, but truck ${trucks?.find((x) => x.id === t)?.code ?? ""} was not linked: ${e}`, "error"));
      }
      if (onPallets) {
        await api.createLoadPallets(name, id, palletCount, spot.trim())
          .catch((e) => toast(`The load is saved, but its pallets were not put on the map: ${e}`, "error"));
      }
      onSaved(chosen.length > 0 ? await api.getWarehouseBuy(id).catch(() => made) : made);
    } catch (e) { toast(String(e), "error"); setBusy(false); }
  };
  const pick = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const choice = (on: boolean) => `text-[12.5px] px-3 h-8 rounded-lg border transition-colors ${on ? "border-ink bg-surface-2 text-ink font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`;

  const cell = `${WH_INPUT} tabular-nums`;
  return (
    <div className={`${WH_CARD} p-5 space-y-5 max-w-[860px]`}>
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{b ? "Change this load" : "Receive a load"}</h3>
        <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
          {b ? "Change the invoice the supplier sent." : "Answer each question, top to bottom. It reads like the invoice the supplier sent."}
        </p>
      </div>

      {receive && <Question n={1} title="Who is it from?" />}

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
          <span className="text-[13px] font-semibold text-ink">{receive ? "2. What came in, line by line" : "The invoice"}</span>
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

      {receive && (
        <Question n={3} title="Which truck brought it in?" hint="Pick the load you set up in Logistics, so its carrier payment links to this load. Only loads with no deal behind them are listed.">
          {trucks === null ? <p className="text-[12.5px] text-muted">Looking in Logistics…</p>
            : trucks.length === 0 ? <p className="text-[12.5px] text-muted">{truckErr ? `Logistics could not be reached (${truckErr}).` : "No load without a deal is set up in Logistics."} Type the shipping below, or send it to logistics from the load's page later.</p>
            : (
              <div className="space-y-1.5 max-h-[220px] overflow-auto pr-0.5">
                {trucks.map((t) => (
                  <label key={t.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer ${chosen.includes(t.id) ? "border-ink bg-surface-2" : "border-line hover:bg-surface-2"}`}>
                    <input type="checkbox" checked={chosen.includes(t.id)} onChange={() => pick(t.id)} />
                    <span className="font-mono text-[12px] text-ink-2 flex-shrink-0">{t.code}</span>
                    <span className="text-[13px] text-ink truncate min-w-0">{[t.pickup_name, t.delivery_name].filter(Boolean).join(" to ") || "No places yet"}</span>
                    <span className="text-[12px] text-muted ml-auto flex-shrink-0">{[t.pickup_date, statusWord(t.status)].filter(Boolean).join(" · ")}</span>
                  </label>
                ))}
              </div>
            )}
        </Question>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {!shipLocked && chosen.length === 0 && (
          <label className="block">
            <span className="text-[12px] font-medium text-ink-2">Shipping in</span>
            <NumberInput value={ship || ""} onValue={setShip} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
            <span className="block text-[11.5px] text-muted mt-1">{receive ? "No truck above: type what the shipping cost, or leave it empty if you picked it up." : "Leave it empty until you know it. Once you send it to logistics, the trucks set it."}</span>
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

      {receive && (
        <Question n={4} title="Did all of it arrive?">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => setArrived("all")} className={choice(arrived === "all")}>Yes, all of it</button>
            <button type="button" onClick={() => setArrived("some")} className={choice(arrived === "some")}>Some is missing</button>
            <button type="button" onClick={() => setArrived("notyet")} className={choice(arrived === "notyet")}>Not here yet</button>
          </div>
          {arrived && arrived !== "notyet" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[520px] mt-3">
              {arrived === "some" && (
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-2">How many units came in</span>
                  <NumberInput integer value={gotCount || ""} onValue={setGotCount} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
                  <span className="block text-[11.5px] text-muted mt-1">The rest is a refund the supplier owes you.</span>
                </label>
              )}
              <label className="block">
                <span className="text-[12px] font-medium text-ink-2">The day it came in</span>
                <input type="date" value={gotDay} onChange={(e) => setGotDay(e.target.value)} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
              </label>
            </div>
          )}
        </Question>
      )}

      {receive && (
        <Question n={5} title="Is it on pallets?" hint="Boxes are never needed. Pallets go on the map, so you can see where the load stands.">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => setOnPallets(false)} className={choice(onPallets === false)}>No, it sits loose</button>
            <button type="button" onClick={() => setOnPallets(true)} className={choice(onPallets === true)}>Yes, on pallets</button>
          </div>
          {onPallets && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[520px] mt-3">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-2">How many pallets</span>
                <NumberInput integer value={palletCount || ""} onValue={setPalletCount} className={`${WH_INPUT} mt-1 tabular-nums`} style={WH_INPUT_BG} />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-2">Where is it? (if you want)</span>
                <input value={spot} onChange={(e) => setSpot(e.target.value)} placeholder="Like: Bay 4" className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG} />
              </label>
            </div>
          )}
        </Question>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <button onClick={onCancel} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={save} disabled={busy} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : b ? "Save changes" : "Save the load"}</button>
      </div>
    </div>
  );
}

/** R-648: one question of Receive a load, numbered, with a plain hint under it when one helps. */
function Question({ n, title, hint, children }: { n: number; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[13px] font-semibold text-ink">{n}. {title}</div>
        {hint && <p className="text-[12px] text-muted mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
