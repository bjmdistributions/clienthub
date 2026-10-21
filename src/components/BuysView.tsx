// R-488: the stock in hand, each product and delivery with what it cost and what it has made.
// Deal Flow's Inventory view and the Inventory screen's In the warehouse section both draw this,
// from the same warehouse rows, so the two can never disagree with the Warehouse itself.
// Opening one shows its buy and every order taken from it (BuyPanel); Open in the Warehouse goes
// to where its orders are picked and sent to invoices.
// R-551: Deal Flow's Inventory also starts a buy (New buy) before its stock is here, and lists the buys still On the way above
// the stock. They never go in the pipeline: a buy is a reader, not a deal.
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ChevronRight, Plus, Warehouse } from "lucide-react";
import { api, type ComingBuy, type StockWithBuy } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { OPEN_BUY_KEY, openManifestForBuy, perUnit } from "../lib/buyLoads";
import { canSeePayments } from "../lib/dealPayments";
import { useSessionMe } from "../lib/useSessionMe";
import BuyPanel, { NewBuyForm } from "./BuyPanel";
import ComingBuys from "./ComingBuys";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { WAREHOUSE_OPEN_KEY } from "../lib/warehouse";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, n0 } from "./warehouseUi";

export function openInWarehouse(s: { kind: "item" | "load"; id: string }) {
  try { localStorage.setItem(WAREHOUSE_OPEN_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "warehouse" }));
}

/** What is open: a product or delivery with its buy, or a buy by itself (one still on the way has no stock to open it by). */
type Open = StockWithBuy | { kind: "buy"; id: string; name: string };

export default function BuysView({ search = "", compact = false }: { search?: string; compact?: boolean }) {
  const me = useSessionMe();
  const numbers = canSeePayments(me);
  const [stock, setStock] = useState<StockWithBuy[] | null>(null);
  const [coming, setComing] = useState<ComingBuy[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [creating, setCreating] = useState(false);
  // R-551: another screen asked for one buy (a truck in Logistics, the Warehouse): read once, on arriving.
  useEffect(() => {
    try {
      const want = localStorage.getItem(OPEN_BUY_KEY);
      if (want) { localStorage.removeItem(OPEN_BUY_KEY); setOpen({ kind: "buy", id: want, name: "" }); }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(() => api.listWarehouseBuys().then((r) => { setStock(r.stock); setComing(r.coming ?? []); }).catch((e) => { toast(`Couldn't load the stock: ${e}`, "error"); setStock([]); }), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => { load(); }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [load]);

  if (creating) {
    return (
      <div className="space-y-4">
        <button onClick={() => setCreating(false)} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2">
          <ArrowLeft size={13} /> All stock
        </button>
        <NewBuyForm onCancel={() => setCreating(false)} onSaved={(d) => { setCreating(false); setOpen({ kind: "buy", id: d.buy.id, name: d.buy.name }); load(); }} />
      </div>
    );
  }

  if (open) {
    const stockOpen = open.kind !== "buy" ? open : null;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <button onClick={() => { setOpen(null); load(); }} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted hover:text-ink-2">
            <ArrowLeft size={13} /> All stock
          </button>
          {stockOpen && <button onClick={() => openInWarehouse(stockOpen)} className={WH_BTN_SECONDARY}><Warehouse size={13} /> Open in the Warehouse</button>}
        </div>
        {stockOpen ? (
          <BuyPanel itemId={stockOpen.kind === "item" ? stockOpen.id : undefined} loadId={stockOpen.kind === "load" ? stockOpen.id : undefined}
            stockName={stockOpen.name} unit={stockOpen.unit} defaultUnits={stockOpen.left} onChanged={load} />
        ) : (
          <BuyPanel buyId={open.id} stockName={open.name} onChanged={load} onAddManifest={openManifestForBuy}
            onOpenWarehouse={(d) => openInWarehouse({ kind: d.buy.load_id ? "load" : "item", id: d.buy.load_id || d.buy.item_id })} />
        )}
      </div>
    );
  }

  if (stock === null) return <div className="text-[13px] text-muted py-10 text-center">Loading…</div>;
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = stock.filter((s) => words.every((w) => `${s.name} ${s.buy?.supplier_name ?? ""} ${s.buy?.name ?? ""}`.toLowerCase().includes(w)));
  const coming_ = compact ? [] : coming.filter((c) => words.every((w) => `${c.name} ${c.supplier_name}`.toLowerCase().includes(w)));
  const newBuy = !compact && (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <p className="text-[12.5px] text-muted max-w-[640px]">Buying a load in? Start it here before it arrives, send it to logistics, and add its manifest when it is unloaded.</p>
      <button onClick={() => setCreating(true)} className={WH_BTN_PRIMARY}><Plus size={14} /> New buy</button>
    </div>
  );
  const onTheWay = <ComingBuys items={coming_} numbers={numbers} onOpen={(b) => setOpen({ kind: "buy", id: b.id, name: b.name })} />;
  if (shown.length === 0) {
    return (
      <div className="space-y-4">
        {newBuy}
        {onTheWay}
        {(compact || coming_.length === 0 || !search) && (
          <div className={`${WH_CARD} py-14 text-center text-[13px] text-muted`}>
            {search ? "No stock matches your search." : "Nothing in the Warehouse yet. Import a sheet there and it shows here."}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {newBuy}
      {onTheWay}
      <div className={`${WH_CARD} overflow-hidden`}>
        {!compact && (
          <div className="px-4 py-3 border-b border-line text-[12.5px] text-muted">
            Stock in the Warehouse. Each sale from it is its own deal in the pipeline; here is what each buy cost and has made.
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-muted border-b border-line">
                <th className="font-medium px-4 py-2">Stock</th>
                <th className="font-medium px-3 py-2 text-right">Left</th>
                <th className="font-medium px-3 py-2 text-right">Sold</th>
                {numbers && <th className="font-medium px-3 py-2 text-right">Cost a unit</th>}
                {numbers && <th className="font-medium px-3 py-2 text-right">Made on what is sold</th>}
                <th className="font-medium px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const r = s.buy?.rollup;
                return (
                  <tr key={`${s.kind}:${s.id}`} onClick={() => setOpen(s)} className="border-b border-line last:border-0 cursor-pointer hover:bg-surface-2/50">
                    <td className="px-4 py-2.5 min-w-0">
                      <div className="text-ink font-medium truncate max-w-[320px]">{s.name || "Unnamed"}</div>
                      <div className="text-[11.5px] text-muted truncate max-w-[320px]">
                        {s.kind === "load" ? "Delivery" : "Product"}{s.buy?.supplier_name ? ` from ${s.buy.supplier_name}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{n0(s.left)} {s.unit}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{r ? `${n0(r.sold)} of ${n0(r.bought)}` : "–"}</td>
                    {numbers && <td className="px-3 py-2.5 text-right tabular-nums">{r ? perUnit(r.unit_cost) : "–"}</td>}
                    {numbers && (
                      <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${r && r.sold > 0 ? (r.made_on_sold >= 0 ? "text-success-ink" : "text-danger-ink") : "text-muted"}`}>
                        {r && r.sold > 0 ? fmtAmount(r.made_on_sold) : "–"}
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
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
