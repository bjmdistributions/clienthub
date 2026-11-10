// R-648: Warehouse > Loads, the first thing the Warehouse shows. Every load received (a purchase order, warehouse_buys: R-596),
// one row each: who from, when it came in, how many units are left of how many, what the goods and the shipping in cost, the
// average cost a unit (goods and shipping over the units, buy_core.rs) and what its sales made so far. Receive a load asks the
// questions (PurchaseForm); a load opens on its page (PurchasePanel); Import Whatnot sales books a Whatnot export against loads.
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ChevronRight, FileSpreadsheet, Plus, Search } from "lucide-react";
import { api, type BuyDetail, type PurchaseRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { OPEN_BUY_KEY, perUnit } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { dayWord, STATE_TONE, STATE_WORD } from "../lib/purchases";
import { useSessionMe } from "../lib/useSessionMe";
import { PageActions } from "./ui";
import PurchaseForm from "./PurchaseForm";
import PurchasePanel from "./PurchasePanel";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import WhatnotImport from "./WhatnotImport";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

export default function WarehouseLoads({ onOpenStock, onShowPallets, onAddManifest }: {
  /** A load whose stock is an older product or delivery opens it there. */
  onOpenStock: (d: BuyDetail) => void;
  /** A load on pallets shows them on the map. */
  onShowPallets: (loadId: string) => void;
  /** Import a load's manifest box by box (Older stock, Deliveries). */
  onAddManifest: (b: { id: string; name: string }) => void;
}) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [whatnot, setWhatnot] = useState(false);
  const [q, setQ] = useState("");

  // Another screen asked for one load (a truck in Logistics, Financials): read once, on arriving.
  useEffect(() => {
    try {
      const want = localStorage.getItem(OPEN_BUY_KEY);
      if (want) { localStorage.removeItem(OPEN_BUY_KEY); setOpen(want); }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(() => api.listWarehouseBuys().then((r) => setRows(r.purchases ?? [])).catch((e) => { toast(`Couldn't load the loads: ${e}`, "error"); setRows([]); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

  if (whatnot) {
    return <WhatnotImport loads={rows ?? []} onClose={(done) => { setWhatnot(false); if (done) load(); }} />;
  }
  if (creating) {
    return (
      <div className="space-y-4">
        <Back onClick={() => setCreating(false)} />
        <PurchaseForm detail={null} onCancel={() => setCreating(false)} onSaved={(d) => { setCreating(false); setOpen(d.buy.id); load(); }} />
      </div>
    );
  }
  if (open) {
    return (
      <div className="space-y-4">
        <Back onClick={() => { setOpen(null); load(); }} />
        <PurchasePanel buyId={open} onChanged={load} onRemoved={() => { setOpen(null); load(); }} onOpenWarehouse={onOpenStock} onShowPallets={onShowPallets} onAddManifest={onAddManifest} />
      </div>
    );
  }

  const live = rows ?? [];
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = live.filter((p) => words.every((w) => `${p.name} ${p.supplier_name} ${p.buy.invoice_no}`.toLowerCase().includes(w)));
  const sum = live.reduce((a, p) => ({ left: a.left + Math.max(0, p.rollup.left), onHand: a.onHand + p.rollup.cost_on_hand, made: a.made + p.rollup.made_so_far }), { left: 0, onHand: 0, made: 0 });
  return (
    <div className="space-y-4">
      <PageActions>
        <button onClick={() => setWhatnot(true)} className={WH_BTN_SECONDARY}><FileSpreadsheet size={13} /> Import Whatnot sales</button>
        <button onClick={() => setCreating(true)} className={WH_BTN_PRIMARY}><Plus size={14} /> Receive a load</button>
      </PageActions>

      {live.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-muted">
            <span className="text-ink-2 tabular-nums">{n0(sum.left)}</span> units in stock
            {numbers && <><span className="text-faint"> · </span><span className="text-ink-2 tabular-nums">{fmtAmount(sum.onHand)}</span> what they cost
              <span className="text-faint"> · </span><span className={`tabular-nums ${sum.made >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(sum.made)}</span> made so far</>}
          </p>
          <div className="relative w-full sm:w-72">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by supplier or invoice" aria-label="Search the loads" className={`${WH_INPUT} pl-8`} style={WH_INPUT_BG} />
          </div>
        </div>
      )}

      {rows === null ? (
        <div className="text-[13px] text-muted py-10 text-center">Loading…</div>
      ) : shown.length === 0 ? (
        <div className={`${WH_CARD} py-14 px-6 text-center`}>
          {q ? <p className="text-[13px] text-muted">No load matches your search.</p> : (
            <>
              <div className="text-[14px] font-semibold text-ink">Nothing received yet</div>
              <p className="text-[13px] text-muted mt-1">Press Receive a load and answer the questions. It reads like the supplier's invoice.</p>
              <button onClick={() => setCreating(true)} className={`${WH_BTN_PRIMARY} mt-4`}><Plus size={14} /> Receive a load</button>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui-table ui-table-click">
            <thead>
              <tr>
                <th>Load</th>
                <th>Came in</th>
                <th className="text-right">Units left</th>
                {numbers && <th className="text-right">Goods</th>}
                {numbers && <th className="text-right">Shipping</th>}
                {numbers && <th className="text-right">Average a unit</th>}
                {numbers && <th className="text-right">Made so far</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const r = p.rollup;
                return (
                  <tr key={p.id} onClick={() => setOpen(p.id)}>
                    <td className="min-w-0">
                      <div className="text-ink font-medium truncate max-w-[280px]">{p.supplier_name || p.name || "No supplier yet"}</div>
                      <div className="text-[11.5px] text-muted truncate max-w-[280px]">{p.buy.invoice_no ? `Invoice ${p.buy.invoice_no}` : p.supplier_name ? p.name : ""}</div>
                    </td>
                    <td className="text-ink-2 whitespace-nowrap">{p.buy.received_at ? dayWord(p.buy.received_at) : "Not yet"}</td>
                    <td className="r whitespace-nowrap">{n0(Math.max(0, r.left))} <span className="text-muted">of {n0(r.bought)}</span></td>
                    {numbers && <td className="r">{fmtAmount(r.goods_total)}</td>}
                    {numbers && <td className="r">{fmtAmount(r.ship_total)}</td>}
                    {numbers && <td className="r font-medium">{r.bought > 0 ? perUnit(r.unit_cost) : "-"}</td>}
                    {numbers && <td className={`r ${r.sold > 0 ? (r.made_so_far >= 0 ? "text-success-ink" : "text-danger-ink") : "text-muted"}`}>{r.sold > 0 ? fmtAmount(r.made_so_far) : "-"}</td>}
                    <td className="r">
                      <span className="inline-flex items-center gap-2">
                        <StatusPill tone={STATE_TONE[r.state]}>{STATE_WORD[r.state]}</StatusPill>
                        <ChevronRight size={14} className="text-faint" />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2">
      <ArrowLeft size={13} /> All loads
    </button>
  );
}
