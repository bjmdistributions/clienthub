// R-488: the stock in hand, each product and delivery with what it cost and what it has made.
// Deal Flow's Inventory view and the Inventory screen's In the warehouse section both draw this,
// from the same warehouse rows, so the two can never disagree with the Warehouse itself.
// Opening one shows its buy and every order taken from it (BuyPanel); Open in the Warehouse goes
// to where its orders are picked and sent to invoices.
// R-596: the buys started before their stock is here (New buy, On the way) moved to Purchases, where a buy is a purchase order.
// Deal Flow's Inventory keeps one line that goes there. A buy is never in the pipeline: it is a reader, not a deal.
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ChevronRight, Warehouse } from "lucide-react";
import { api, type StockWithBuy } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { perUnit } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { useSessionMe } from "../lib/useSessionMe";
import BuyPanel from "./BuyPanel";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { WAREHOUSE_OPEN_KEY } from "../lib/warehouse";
import { WH_BTN_SECONDARY, WH_CARD, n0 } from "./warehouseUi";

export function openInWarehouse(s: { kind: "item" | "load"; id: string }) {
  try { localStorage.setItem(WAREHOUSE_OPEN_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "warehouse" }));
}

/** What is open: a product or delivery with its buy. */
type Open = StockWithBuy;

export default function BuysView({ search = "", compact = false }: { search?: string; compact?: boolean }) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [stock, setStock] = useState<StockWithBuy[] | null>(null);
  const [open, setOpen] = useState<Open | null>(null);

  const load = useCallback(() => api.listWarehouseBuys().then((r) => { setStock(r.stock); }).catch((e) => { toast(`Couldn't load the stock: ${e}`, "error"); setStock([]); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

  if (open) {
    const stockOpen = open;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <button onClick={() => { setOpen(null); load(); }} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2">
            <ArrowLeft size={13} /> All stock
          </button>
          <button onClick={() => openInWarehouse(stockOpen)} className={WH_BTN_SECONDARY}><Warehouse size={13} /> Open in the Warehouse</button>
        </div>
        <BuyPanel itemId={stockOpen.kind === "item" ? stockOpen.id : undefined} loadId={stockOpen.kind === "load" ? stockOpen.id : undefined}
          stockName={stockOpen.name} unit={stockOpen.unit} defaultUnits={stockOpen.left} onChanged={load} />
      </div>
    );
  }

  if (stock === null) return <div className="text-[13px] text-muted py-10 text-center">Loading…</div>;
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = stock.filter((s) => words.every((w) => `${s.name} ${s.buy?.supplier_name ?? ""} ${s.buy?.name ?? ""}`.toLowerCase().includes(w)));
  const toPurchases = !compact && (
    <p className="text-[13px] text-muted">
      Buying stock in? Receive it, send it to logistics and see what is owed back in{" "}
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "warehouse" }))}
        className="text-accent-hover hover:underline">Warehouse, Loads</button>.
    </p>
  );
  if (shown.length === 0) {
    return (
      <div className="space-y-4">
        {toPurchases}
        <div className={`${WH_CARD} py-14 text-center text-[13px] text-muted`}>
          {search ? "No stock matches your search." : "Nothing in the Warehouse yet. Import a sheet there and it shows here."}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {toPurchases}
      <div>
        {!compact && (
          <p className="pb-3 text-[13px] text-muted">
            Stock in the Warehouse. Each sale from it is its own deal in the pipeline; here is what each buy cost and has made.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="ui-table ui-table-click">
            <thead>
              <tr>
                <th>Stock</th>
                <th className="text-right">Left</th>
                <th className="text-right">Sold</th>
                {numbers && <th className="text-right">Cost a unit</th>}
                {numbers && <th className="text-right">Made on what is sold</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const r = s.buy?.rollup;
                return (
                  <tr key={`${s.kind}:${s.id}`} onClick={() => setOpen(s)}>
                    <td className="min-w-0">
                      <div className="text-ink font-medium truncate max-w-[320px]">{s.name || "Unnamed"}</div>
                      <div className="text-[11.5px] text-muted truncate max-w-[320px]">
                        {s.kind === "load" ? "Delivery" : "Product"}{s.buy?.supplier_name ? ` from ${s.buy.supplier_name}` : ""}
                      </div>
                    </td>
                    <td className="r">{n0(s.left)} {s.unit}</td>
                    <td className="r">{r ? `${n0(r.sold)} of ${n0(r.bought)}` : "-"}</td>
                    {numbers && <td className="r">{r ? perUnit(r.unit_cost) : "-"}</td>}
                    {numbers && (
                      <td className={`r font-medium ${r && r.sold > 0 ? (r.made_on_sold >= 0 ? "text-success-ink" : "text-danger-ink") : "text-muted"}`}>
                        {r && r.sold > 0 ? fmtAmount(r.made_on_sold) : "-"}
                      </td>
                    )}
                    <td className="r">
                      <span className="inline-flex items-center gap-2">
                        {!s.buy ? <StatusPill tone="warning">Cost not recorded</StatusPill>
                          : r?.sold_out ? <StatusPill tone="success">Sold out</StatusPill>
                          : s.buy.missing > 0 || !s.buy.in_step ? <StatusPill tone="warning">Needs a look</StatusPill>
                          : <StatusPill tone="neutral">{s.buy.orders} {s.buy.orders === 1 ? "order" : "orders"}</StatusPill>}
                        <ChevronRight size={14} className="text-faint" />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
