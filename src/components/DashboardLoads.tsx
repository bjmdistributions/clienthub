import { useEffect, useState } from "react";
import { ArrowDown, Banknote, Truck } from "lucide-react";
import { api, openDealFlow, type FreightBooking } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { dashboardLoads, laneEnds, loadCard, loadNumber, type CardTone } from "../lib/logisticsLoad";
import { routeLabel, timingLine } from "./LogisticsBookingForm";
import { openLoadInLogistics } from "./LogisticsPayCarriers";

// R-484: what is going on with the freight, right under the Dashboard's numbers. Round 2 (Jack, 2026-10-09: "square
// grid view ... more life"): each load is a square card whose colour says where it is (indigo booked, teal on the
// way, orange the carrier is owed, red the carrier is due today or overdue), with the route as the headline and a
// three-step track. R-487: Arriving today (green) leads; a card opens its deal on the Shipping step, and Load opens
// the load (a load with no deal the viewer may see opens the load). Nothing shows when neither group has a load, or when the server does not
// let this person see Logistics.

const byPickup = (a: FreightBooking, b: FreightBooking) =>
  (a.pickup_date || "9999").localeCompare(b.pickup_date || "9999") || a.created_at.localeCompare(b.created_at);
const byDue = (a: FreightBooking, b: FreightBooking) =>
  (a.pay_due_date || "9999").localeCompare(b.pay_due_date || "9999") || a.created_at.localeCompare(b.created_at);

// Apple system colours (the chart tokens): the fill for the wash, the track and the icon; the -ink for words.
const TONE: Record<CardTone, { fill: string; ink: string }> = {
  green: { fill: "var(--c-chart-profit)", ink: "var(--c-chart-profit-ink)" },
  indigo: { fill: "var(--c-chart-3)", ink: "var(--c-chart-3)" },
  teal: { fill: "var(--c-chart-2)", ink: "var(--c-chart-2-ink)" },
  orange: { fill: "var(--c-chart-caution)", ink: "var(--c-chart-caution-ink)" },
  red: { fill: "var(--c-chart-loss)", ink: "var(--c-chart-loss-ink)" },
};

function LoadSquare({ b, today, i }: { b: FreightBooking; today: string; i: number }) {
  const c = loadCard(b, today);
  const t = TONE[c.tone];
  const { from, to, more } = laneEnds(b);
  const route = routeLabel(b);
  const pay = c.steps[0] === "Delivered";
  const sub = c.sub || timingLine(b);
  const who = b.deal ? [b.deal.invoice_number, b.deal.client_name].filter(Boolean).join(" · ") : "";
  const Icon = pay ? Banknote : Truck;
  const deal = b.can_see_deal && b.deal?.invoice_number ? b.deal.invoice_number : "";
  const open = () => (deal ? openDealFlow(deal, "shipping") : openLoadInLogistics(b.id));
  // A div, not a button: the card holds the Load button, and a button cannot hold another.
  return (
    <div
      role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      title={deal ? `Open ${deal} in Deal Flow` : "Open the load"}
      style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
      className="dash-load glass group relative rounded-2xl p-4 aspect-square flex flex-col text-left cursor-pointer
        ring-1 ring-line hover:-translate-y-0.5 hover:shadow-lg transition-[transform,box-shadow] duration-[130ms] min-w-0
        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {/* A wash of the state's colour from the top corner, so the grid reads by colour at a glance. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ background: `linear-gradient(155deg, rgb(${t.fill} / 0.16) 0%, rgb(${t.fill} / 0.04) 45%, transparent 70%)` }} />
      <div className="relative flex items-center justify-between gap-2">
        <span className="w-9 h-9 rounded-xl grid place-items-center flex-shrink-0" style={{ background: `rgb(${t.fill} / 0.16)`, color: `rgb(${t.ink})` }}>
          <Icon size={17} strokeWidth={2} />
        </span>
        {deal ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); openLoadInLogistics(b.id); }}
            title="Open the load in Logistics"
            className="font-mono text-[11.5px] text-muted hover:text-ink truncate px-1.5 h-6 rounded-md hover:bg-surface-2 transition-colors duration-[130ms]">
            {loadNumber(b)}
          </button>
        ) : <span className="font-mono text-[11.5px] text-muted truncate">{loadNumber(b)}</span>}
      </div>

      <div className="relative flex-1 flex flex-col justify-center min-w-0 py-2">
        {from || to ? (
          <>
            <div className="text-[15px] font-semibold text-ink leading-tight truncate">{from || "-"}{more > 0 && <span className="text-muted font-medium"> + {more}</span>}</div>
            <ArrowDown size={13} className="text-faint my-1" />
            <div className="text-[15px] font-semibold text-ink leading-tight truncate">{to || "-"}</div>
          </>
        ) : (
          <div className="text-[14px] font-semibold text-ink leading-snug line-clamp-3">{route || loadNumber(b)}</div>
        )}
      </div>

      <div className="relative">
        <div className="flex gap-1" aria-label={`${c.steps[c.step - 1]}, step ${c.step} of 3`}>
          {c.steps.map((s, k) => (
            <span key={s} title={s} className="h-1.5 flex-1 rounded-full"
              style={{ background: k < c.step ? `rgb(${t.fill})` : "rgb(var(--c-line))" }} />
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-2 mt-2.5">
          <span className="text-[13px] font-semibold truncate" style={{ color: `rgb(${t.ink})` }}>{c.label}</span>
          {pay && b.quoted_cost != null && b.can_see_money !== false && (
            <span className="text-[13px] font-semibold text-ink tabular-nums flex-shrink-0">{fmtAmount(b.quoted_cost)}</span>
          )}
        </div>
        {sub && <div className="text-[11.5px] text-muted mt-0.5 truncate">{sub}</div>}
        {who && <div className="text-[11.5px] text-faint mt-0.5 truncate">{who}</div>}
      </div>
    </div>
  );
}

export default function DashboardLoads() {
  const [list, setList] = useState<FreightBooking[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.logistics.list().then((r) => { if (alive) setList(r.bookings ?? []); }).catch(() => { if (alive) setList(null); });
    return () => { alive = false; };
  }, []);
  if (!list) return null;
  const today = localDay();
  const { arriving, shipping, carrier } = dashboardLoads(list, today);
  if (arriving.length === 0 && shipping.length === 0 && carrier.length === 0) return null;

  const group = (title: string, rows: FreightBooking[]) => rows.length > 0 && (
    <section>
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <span className="text-[13px] text-muted tabular-nums">{rows.length}</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {rows.map((b, i) => <LoadSquare key={b.id} b={b} today={today} i={i} />)}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-5">
      {group("Arriving today", [...arriving].sort(byPickup))}
      {group("Waiting on shipping", [...shipping].sort(byPickup))}
      {group("Waiting to pay the carrier", [...carrier].sort(byDue))}
    </div>
  );
}
