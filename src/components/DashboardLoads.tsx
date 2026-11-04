import { memo } from "react";
import { ArrowDown, DollarSign, Truck } from "lucide-react";
import { openDealFlow, type FreightBooking } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { dashboardLoads, laneEnds, loadCard, loadNumber, type CardTone } from "../lib/logisticsLoad";
import { buyLabelOf, openBuyInDealFlow } from "../lib/buyLoads";
import { routeLabel, timingLine } from "./LogisticsBookingForm";
import { openLoadInLogistics } from "./LogisticsPayCarriers";

// R-484: what is going on with the freight, right under the Dashboard's numbers. Each load is a card whose colour
// says where it is (teal while it ships, green the carrier is owed, red the carrier is due today or overdue; R-507),
// with the route as the headline and a three-step track. R-487: Arriving today leads; a card opens its deal on the
// Shipping step, and Load opens the load (a load with no deal the viewer may see opens the load). Nothing shows when
// neither group has a load, or when the server does not let this person see Logistics.
// R-583: flat cards (a hairline, no wash, no icon tile), and the list now comes from the Dashboard, which reads it
// once for these cards and for its "Carriers to pay" count.

const byPickup = (a: FreightBooking, b: FreightBooking) =>
  (a.pickup_date || "9999").localeCompare(b.pickup_date || "9999") || a.created_at.localeCompare(b.created_at);
const byDue = (a: FreightBooking, b: FreightBooking) =>
  (a.pay_due_date || "9999").localeCompare(b.pay_due_date || "9999") || a.created_at.localeCompare(b.created_at);

// Meaning colours only: teal for a load on the road, green for money owed to the carrier, red for due or late.
const TONE: Record<CardTone, { fill: string; ink: string }> = {
  green: { fill: "var(--c-chart-profit)", ink: "var(--c-chart-profit-ink)" },
  teal: { fill: "var(--c-chart-2)", ink: "var(--c-chart-2-ink)" },
  red: { fill: "var(--c-chart-loss)", ink: "var(--c-chart-loss-ink)" },
};

function LoadSquare({ b, today, i }: { b: FreightBooking; today: string; i: number }) {
  const c = loadCard(b, today);
  const t = TONE[c.tone];
  const { from, to, more } = laneEnds(b);
  const route = routeLabel(b);
  const pay = c.steps[0] === "Delivered";
  const sub = c.sub || timingLine(b);
  const who = b.deal ? [b.deal.invoice_number, b.deal.client_name].filter(Boolean).join(" · ") : buyLabelOf(b);
  const Icon = pay ? DollarSign : Truck;
  const deal = b.can_see_deal && b.deal?.invoice_number ? b.deal.invoice_number : "";
  // R-551: a truck that brings a buy in opens the buy, where a deal's load opens its deal.
  const buyId = b.can_see_deal && b.buy ? b.buy.id : "";
  const open = () => (deal ? openDealFlow(deal, "shipping") : buyId ? openBuyInDealFlow(buyId) : openLoadInLogistics(b.id));
  // A div, not a button: the card holds the Load button, and a button cannot hold another.
  return (
    <div
      role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      title={deal ? `Open ${deal} in Deal Flow` : buyId ? "Open the buy in Deal Flow" : "Open the load"}
      style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
      className="dash-load group relative rounded-xl p-4 min-h-[156px] flex flex-col text-left cursor-pointer min-w-0
        ring-1 ring-line hover:ring-line-3 hover:bg-surface-2 transition-[background-color,box-shadow] duration-[150ms]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex-shrink-0" style={{ color: `rgb(${t.ink})` }}>
          <Icon size={16} strokeWidth={1.75} />
        </span>
        {deal || buyId ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); openLoadInLogistics(b.id); }}
            title="Open the load in Logistics"
            className="tabular-nums text-[12px] text-muted hover:text-ink truncate px-1.5 h-6 rounded-md hover:bg-surface-3 transition-colors duration-[150ms]">
            {loadNumber(b)}
          </button>
        ) : <span className="tabular-nums text-[12px] text-muted truncate">{loadNumber(b)}</span>}
      </div>

      <div className="flex-1 flex flex-col justify-center min-w-0 py-3">
        {from || to ? (
          <>
            <div className="text-[14px] font-medium text-ink leading-tight truncate">{from || "-"}{more > 0 && <span className="text-muted"> + {more}</span>}</div>
            <ArrowDown size={13} strokeWidth={1.75} className="text-faint my-1" />
            <div className="text-[14px] font-medium text-ink leading-tight truncate">{to || "-"}</div>
          </>
        ) : (
          <div className="text-[14px] font-medium text-ink leading-snug line-clamp-3">{route || loadNumber(b)}</div>
        )}
      </div>

      <div>
        <div className="flex gap-1" aria-label={`${c.steps[c.step - 1]}, step ${c.step} of 3`}>
          {c.steps.map((s, k) => (
            <span key={s} title={s} className="h-1 flex-1 rounded-full"
              style={{ background: k < c.step ? `rgb(${t.fill})` : "rgb(var(--c-surface-3))" }} />
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-2 mt-2.5">
          <span className="text-[13px] font-medium truncate" style={{ color: `rgb(${t.ink})` }}>{c.label}</span>
          {pay && b.quoted_cost != null && b.can_see_money !== false && (
            <span className="text-[13px] font-medium text-ink tabular-nums flex-shrink-0">{fmtAmount(b.quoted_cost)}</span>
          )}
        </div>
        {sub && <div className="text-[12px] text-muted mt-0.5 truncate">{sub}</div>}
        {who && <div className="text-[12px] text-faint mt-0.5 truncate">{who}</div>}
      </div>
    </div>
  );
}

function DashboardLoads({ list }: { list: FreightBooking[] | null }) {
  if (!list) return null;
  const today = localDay();
  const { arriving, shipping, carrier } = dashboardLoads(list, today);
  if (arriving.length === 0 && shipping.length === 0 && carrier.length === 0) return null;

  const group = (title: string, rows: FreightBooking[]) => rows.length > 0 && (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="m-0 text-[14px] font-medium text-ink">{title}</h3>
        <span className="ui-count calm">{rows.length}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 min-[1500px]:grid-cols-3 gap-3">
        {rows.map((b, i) => <LoadSquare key={b.id} b={b} today={today} i={i} />)}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      {group("Arriving today", [...arriving].sort(byPickup))}
      {group("Waiting on shipping", [...shipping].sort(byPickup))}
      {group("Waiting to pay the carrier", [...carrier].sort(byDue))}
    </div>
  );
}

export default memo(DashboardLoads);
