// R-648: Import Whatnot sales. Pick Whatnot's sales export (CSV or Excel), check which column is which (each is guessed from its
// heading), say which load the items sold from (once for the whole file, or row by row), and book them: one invoice to the
// client Whatnot, one line a sale at its net, so the deal it makes counts the revenue; each load gives its units at its
// average cost a unit, so the profit is the net less that cost. The same export is never booked twice (its mark is kept in the
// invoice's notes). The rules are lib/whatnot.ts.
import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { api, type PurchaseRow } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { perUnit } from "../lib/buyLoads";
import { fingerprint, guessColumns, invoiceLines, lastDay, plan, readRows, WN_LABEL, type WnCol, type WnMap } from "../lib/whatnot";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

const COLS: WnCol[] = ["item", "qty", "net", "date", "order"];

export default function WhatnotImport({ loads, onClose }: { loads: PurchaseRow[]; onClose: (done: boolean) => void }) {
  const [file, setFile] = useState("");
  const [sheet, setSheet] = useState<string[][] | null>(null);
  const [map, setMap] = useState<WnMap | null>(null);
  const [all, setAll] = useState("");
  const [own, setOwn] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const choices = loads.filter((l) => l.rollup.left > 0);
  const read = useMemo(() => (sheet && map ? readRows(sheet, map) : { rows: [], skipped: 0 }), [sheet, map]);
  const sales = read.rows;
  const picks = sales.map((_, i) => own[i] ?? all);
  const p = plan(sales, picks, loads.map((l) => ({ id: l.id, left: l.rollup.left, unit_cost: l.rollup.unit_cost })));
  const nameOf = (id: string) => { const l = loads.find((x) => x.id === id); return l ? (l.supplier_name || l.name) : "That load"; };

  const pick = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Whatnot export", extensions: ["csv", "xlsx", "xls"] }] });
    if (!path || Array.isArray(path)) return;
    try {
      const got = await api.readLotImportSheet(path);
      if (got.rows.length < 2) { toast("That file has no sales in it.", "error"); return; }
      setFile(path.split(/[\\/]/).pop() || "Whatnot export");
      setSheet(got.rows);
      setMap(guessColumns(got.rows[0]));
      setOwn({});
    } catch (e) { toast(String(e), "error"); }
  };

  const book = async () => {
    if (!sales.length) { toast("No sale could be read. Check which column is the item and which is the net.", "error"); return; }
    if (p.unpicked > 0) { toast("Say which load every item sold from.", "error"); return; }
    if (p.over.length) { toast(p.over.map((o) => `${nameOf(o.id)} has ${n0(o.left)} left, not ${n0(o.units)}`).join(". ") + ".", "error"); return; }
    setBusy(true);
    try {
      const mark = `Whatnot ref ${fingerprint(sales)}`;
      const before = (await api.listInvoices()).find((i) => (i.notes ?? "").includes(mark) && !i.voided);
      if (before) { toast(`These sales are already booked, as invoice ${before.number}.`, "error"); return; }
      const clients = await api.listClients();
      const whatnot = clients.find((c) => c.name.trim().toLowerCase() === "whatnot")
        ?? await api.createClient({ name: "Whatnot", notes: "Sales made on Whatnot, booked from Warehouse, Import Whatnot sales." });
      const day = lastDay(sales, localDay());
      const invId = await api.createInvoice({
        client_id: whatnot.id, issue_date: day, due_date: day, line_items: invoiceLines(sales), tax_rate: 0,
        notes: `Whatnot sales from ${file}: ${sales.length} ${sales.length === 1 ? "sale" : "sales"}, booked at what Whatnot paid after its fees. ${mark}.`,
      });
      let failed = 0;
      for (const b of p.byLoad) {
        await api.addWarehouseBuyOrder(b.id, invId, b.units, null)
          .catch((e) => { failed++; toast(`The invoice is made, but ${nameOf(b.id)} did not give its ${n0(b.units)} units (${e}). Open the load to add the sale.`, "error"); });
      }
      if (!failed) toast(`${sales.length} Whatnot ${sales.length === 1 ? "sale" : "sales"} booked: ${fmtAmount(p.net)} net, ${fmtAmount(p.made)} made.`);
      onClose(true);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <button onClick={() => onClose(false)} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2"><ArrowLeft size={13} /> All loads</button>
      <div className={`${WH_CARD} p-5 space-y-5 max-w-[960px]`}>
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Import Whatnot sales</h3>
          <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
            Download your sales from Whatnot's Seller Hub and pick the file. Each sale is booked at its net, what Whatnot paid you
            after its fees, and costed at its load's average a unit, so the profit is always counted.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={pick} className={sheet ? WH_BTN_SECONDARY : WH_BTN_PRIMARY}><FileSpreadsheet size={13} /> {sheet ? "Pick another file" : "Pick the Whatnot export"}</button>
          {file && <span className="text-[12.5px] text-ink-2">{file}</span>}
        </div>

        {sheet && map && (
          <>
            <div className="space-y-2">
              <div className="text-[13px] font-semibold text-ink">1. Which column is which?</div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {COLS.map((c) => (
                  <label key={c} className="block">
                    <span className="text-[12px] font-medium text-ink-2">{WN_LABEL[c]}</span>
                    <select value={map[c]} onChange={(e) => setMap({ ...map, [c]: Number(e.target.value) })} className={`${WH_INPUT} mt-1`} style={WH_INPUT_BG}>
                      <option value={-1}>{c === "qty" ? "None, one each" : "None"}</option>
                      {sheet[0].map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <p className="text-[12px] text-muted">
                {sales.length} {sales.length === 1 ? "sale" : "sales"} read{read.skipped ? `, ${read.skipped} ${read.skipped === 1 ? "row" : "rows"} skipped (no item, no net, or a count that is not a whole number)` : ""}.
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-[13px] font-semibold text-ink">2. Which load did they sell from?</div>
              {choices.length === 0 ? <p className="text-[12.5px] text-muted">No load has units left. Receive a load first.</p> : (
                <select value={all} onChange={(e) => { setAll(e.target.value); setOwn({}); }} className={`${WH_INPUT} max-w-[520px]`} style={WH_INPUT_BG}>
                  <option value="">Pick the load</option>
                  {choices.map((l) => <option key={l.id} value={l.id}>{`${l.supplier_name || l.name}, ${n0(l.rollup.left)} left, ${perUnit(l.rollup.unit_cost)} a unit`}</option>)}
                </select>
              )}
              <p className="text-[12px] text-muted">A row that came from another load can be changed below.</p>
            </div>

            {sales.length > 0 && (
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-line rounded-lg">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-[12px] text-muted border-b border-line">
                      <th className="font-medium px-3 py-2">Item</th>
                      <th className="font-medium px-3 py-2 text-right">How many</th>
                      <th className="font-medium px-3 py-2 text-right">Net</th>
                      <th className="font-medium px-3 py-2">Day</th>
                      <th className="font-medium px-3 py-2">From load</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((r, i) => (
                      <tr key={i} className="border-b border-line last:border-0">
                        <td className="px-3 py-1.5 text-ink truncate max-w-[320px]">{r.item}{r.order ? <span className="text-muted">, order {r.order}</span> : null}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{n0(r.qty)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.net < 0 ? "text-danger-ink" : ""}`}>{fmtAmount(r.net)}</td>
                        <td className="px-3 py-1.5 text-ink-2 whitespace-nowrap">{r.date || "-"}</td>
                        <td className="px-3 py-1.5">
                          <select value={picks[i]} onChange={(e) => setOwn({ ...own, [i]: e.target.value })} aria-label="The load it sold from" className="h-7 rounded-md border border-line bg-surface text-[12px] px-1.5 max-w-[220px]">
                            <option value="">Pick</option>
                            {choices.map((l) => <option key={l.id} value={l.id}>{l.supplier_name || l.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sales.length > 0 && (
              <div className="grid grid-cols-3 gap-3 max-w-[560px] text-[13px]">
                <div><div className="text-[12px] text-muted">Net from Whatnot</div><div className="font-semibold text-ink tabular-nums">{fmtAmount(p.net)}</div></div>
                <div><div className="text-[12px] text-muted">What the units cost</div><div className="font-semibold text-ink tabular-nums">{fmtAmount(p.cost)}</div></div>
                <div><div className="text-[12px] text-muted">Made</div><div className={`font-semibold tabular-nums ${p.made >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(p.made)}</div></div>
              </div>
            )}
            {p.over.length > 0 && <p className="text-[12.5px] text-danger-ink">{p.over.map((o) => `${nameOf(o.id)} has ${n0(o.left)} left, not ${n0(o.units)}`).join(". ")}.</p>}

            <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
              <button onClick={() => onClose(false)} disabled={busy} className={WH_BTN_SECONDARY}>Cancel</button>
              <button onClick={book} disabled={busy || !sales.length} className={WH_BTN_PRIMARY}>{busy ? "Booking…" : `Book ${sales.length} ${sales.length === 1 ? "sale" : "sales"}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
