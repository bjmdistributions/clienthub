// R-596: Purchases. Every order for your own stock, in one list: who from, their invoice, how many got here of how many were
// ordered, the money spent, the refund still owed, and where it stands. A purchase order is a buy (warehouse_buys), never a deal,
// so no profit screen counts it as one. Opening one shows the order (PurchasePanel); New order is one screen (PurchaseForm).
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ChevronRight, Plus, Search } from "lucide-react";
import { api, type PurchaseRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { OPEN_BUY_KEY } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { gotWord, dayWord, STATE_TONE, STATE_WORD } from "../lib/purchases";
import { useSessionMe } from "../lib/useSessionMe";
import { Button, PageHeader } from "./ui";
import PurchaseForm from "./PurchaseForm";
import PurchasePanel from "./PurchasePanel";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { openInWarehouse } from "./BuysView";
import { WH_CARD, WH_INPUT, WH_INPUT_BG } from "./warehouseUi";

export default function PurchasesView() {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");

  // Another screen asked for one order (a truck in Logistics, the Warehouse): read once, on arriving.
  useEffect(() => {
    try {
      const want = localStorage.getItem(OPEN_BUY_KEY);
      if (want) { localStorage.removeItem(OPEN_BUY_KEY); setOpen(want); }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(() => api.listWarehouseBuys().then((r) => setRows(r.purchases ?? [])).catch((e) => { toast(`Couldn't load the orders: ${e}`, "error"); setRows([]); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

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
        <PurchasePanel buyId={open} onChanged={load} onRemoved={() => { setOpen(null); load(); }}
          onOpenWarehouse={(d) => openInWarehouse({ kind: d.buy.load_id ? "load" : "item", id: d.buy.load_id || d.buy.item_id })} />
      </div>
    );
  }

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (rows ?? []).filter((p) => words.every((w) => `${p.name} ${p.supplier_name} ${p.buy.invoice_no}`.toLowerCase().includes(w)));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Purchases"
        subtitle="Stock you bought for your own warehouse. Type in the supplier's invoice, tie the payments, send the shipping to logistics, and see what you spent and what is owed back."
        actions={<Button variant="ink" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New order</Button>}
      />
      <div className="flex items-center justify-end gap-3 flex-wrap">
        <div className="relative w-full sm:w-72">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by supplier or invoice" aria-label="Search the orders" className={`${WH_INPUT} pl-8`} style={WH_INPUT_BG} />
        </div>
      </div>
      {rows === null ? (
        <div className="text-[13px] text-muted py-10 text-center">Loading…</div>
      ) : shown.length === 0 ? (
        <div className={`${WH_CARD} py-14 text-center text-[13px] text-muted`}>
          {q ? "No order matches your search." : "No orders yet. Press New order and type in the invoice you got."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui-table ui-table-click">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Invoice</th>
                <th className="text-right">Got</th>
                {numbers && <th className="text-right">Spent</th>}
                {numbers && <th className="text-right">Refund owed</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const r = p.rollup;
                return (
                  <tr key={p.id} onClick={() => setOpen(p.id)}>
                    <td className="min-w-0">
                      <div className="text-ink font-medium truncate max-w-[300px]">{p.supplier_name || p.name || "No supplier yet"}</div>
                      <div className="text-[11.5px] text-muted truncate max-w-[300px]">{p.supplier_name ? p.name : ""}</div>
                    </td>
                    <td>
                      <div className="text-ink-2">{p.buy.invoice_no || "-"}</div>
                      <div className="text-[11.5px] text-muted">{dayWord(p.buy.invoice_date)}</div>
                    </td>
                    <td className="r">{gotWord(r)}</td>
                    {numbers && <td className="r">{fmtAmount(r.spent)}</td>}
                    {numbers && <td className={`r ${r.refund_left > 0.005 ? "text-warning-ink font-medium" : "text-muted"}`}>{r.refund_left > 0.005 ? fmtAmount(r.refund_left) : "-"}</td>}
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
      <ArrowLeft size={13} /> All orders
    </button>
  );
}
