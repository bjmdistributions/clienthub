import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ComingBuy } from "../lib/api";
import { COMING_TONE, COMING_WORD, comingState, truckDays } from "../lib/buyLoads";
import { fmtAmount } from "../lib/format";
import StatusPill from "./StatusPill";
import { WH_CARD } from "./warehouseUi";

// R-551: the buys started before their stock is here (On the way), one row each: what it is, who from, what you pay, when each
// truck arrives, and where its trucks stand. Deal Flow's Inventory opens one; the Warehouse's Deliveries lists the same rows
// with Add the manifest. `action` is drawn beside the pill.

export default function ComingBuys({ items, numbers, onOpen, action }: {
  items: ComingBuy[]; numbers: boolean; onOpen: (b: ComingBuy) => void; action?: (b: ComingBuy) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className={`${WH_CARD} overflow-hidden`} aria-label="On the way">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">On the way</span>
        <span className="text-[12px] text-muted">{items.length} {items.length === 1 ? "buy" : "buys"}</span>
      </div>
      <div className="divide-y divide-line">
        {items.map((b) => {
          const state = comingState(b.trucks);
          const days = truckDays(b.trucks);
          return (
            <div key={b.id} role="button" tabIndex={0} onClick={() => onOpen(b)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(b); } }}
              className="flex items-center gap-3 px-4 py-3 min-w-0 cursor-pointer hover:bg-surface-2/50 transition-colors duration-[130ms] flex-wrap">
              <div className="min-w-0 flex-1 basis-[240px]">
                <div className="text-[13.5px] font-medium text-ink truncate">{b.name}</div>
                <div className="text-[12px] text-muted mt-0.5 truncate">
                  {[b.supplier_name ? `From ${b.supplier_name}` : "", numbers ? `You pay ${fmtAmount(b.goods_total)}` : "", days || "No truck yet"].filter(Boolean).join(" · ")}
                </div>
              </div>
              <StatusPill tone={COMING_TONE[state]}>{COMING_WORD[state]}</StatusPill>
              {action?.(b)}
              <ChevronRight size={14} className="text-faint flex-shrink-0" />
            </div>
          );
        })}
      </div>
    </section>
  );
}
