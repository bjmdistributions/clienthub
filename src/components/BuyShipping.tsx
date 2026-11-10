import { useState } from "react";
import { ExternalLink, Link2, Truck } from "lucide-react";
import { api, type BuyDetail, type FreightBooking, type TruckRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { can, isAdmin } from "../lib/permissions";
import { canAttachPayments } from "../lib/logisticsCarriers";
import { truckWhen, truckWord } from "../lib/buyLoads";
import { statusWord } from "../lib/logisticsLoad";
import { toast } from "./Toast";
import { useSessionMe } from "../lib/useSessionMe";
import StatusPill from "./StatusPill";
import BuySendSheet from "./BuySendSheet";
import { FreightStatusPill } from "./LogisticsBookingForm";
import { openLoadInLogistics, usePaidControls } from "./LogisticsPayCarriers";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD } from "./warehouseUi";

// R-551: the Shipping in section of a buy. Its trucks (each a load in Logistics, quoted and booked there), what they cost
// so far, his markup on them, and tying each carrier's bank payment, which pays the buy's shipping in. This desktop never
// writes a truck: Send to logistics asks the server, and the trucks come back through sync.

/** A truck whose carrier can be paid: sent to book or later (the server refuses a quote). */
const BOOKED_OR_LATER = ["requested", "booked", "picked_up", "delivered"];
const GHOST = "px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-40 whitespace-nowrap";

export default function ShippingIn({ d, numbers, onChanged }: { d: BuyDetail; numbers: boolean; onChanged: () => void }) {
  const me = useSessionMe();
  const attach = canAttachPayments(me);
  const mayAsk = isAdmin(me) || can(me, "deal_flow:edit");
  const [sending, setSending] = useState(false);
  // R-648: a load already set up in Logistics with no deal behind it, linked to this one (or unlinked again).
  const [linking, setLinking] = useState<FreightBooking[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const openLinking = () => api.logistics.list()
    .then((r) => setLinking((r.bookings ?? []).filter((t) => t.standalone && t.status !== "cancelled")))
    .catch((e) => toast(`Logistics could not be reached: ${e}`, "error"));
  const linkTo = async (truckId: string, buyId: string, done: string) => {
    setLinkBusy(true);
    try { await api.logistics.linkBuy(truckId, buyId); toast(done); setLinking(null); api.netsyncSyncNow().catch(() => {}).finally(onChanged); }
    catch (e) { toast(String(e), "error"); }
    finally { setLinkBusy(false); }
  };
  // Linking asks the server, which writes the truck and the buy; pull it back before the screen reads the buy again.
  const controls = usePaidControls(() => { api.netsyncSyncNow().catch(() => {}).finally(onChanged); });
  const tc = d.truck_cost;
  const live = d.trucks.filter((t) => t.status !== "cancelled");
  const cancelled = d.trucks.filter((t) => t.status === "cancelled");
  const target = (t: TruckRow) => ({ bookingId: t.id, label: `${t.carrier || "Carrier"}, ${t.code}`, rate: t.rate > 0.005 ? t.rate : null, buy: true });

  const row = (t: TruckRow) => {
    const word = truckWord(t);
    const dead = t.status === "cancelled";
    const tied = !!t.bank_txn_id;
    return (
      <div key={t.id} className={`flex items-center gap-x-3 gap-y-1.5 px-4 py-3 min-w-0 flex-wrap ${dead ? "opacity-60" : ""}`}>
        <div className="min-w-0 flex-1 basis-[220px]">
          <div className="flex items-baseline gap-2 min-w-0">
            <button type="button" onClick={() => openLoadInLogistics(t.id)} title="Open the truck in Logistics" className="font-mono text-[12px] text-accent hover:underline flex-shrink-0">{t.code}</button>
            {word && <span className="text-[12.5px] text-ink-2 flex-shrink-0">{word}</span>}
            <span className="text-[13.5px] font-medium text-ink truncate min-w-0">{t.carrier || "Carrier not chosen yet"}</span>
          </div>
          <div className="text-[12px] text-muted mt-0.5 truncate">{truckWhen(t) || "No delivery day yet"}</div>
        </div>
        <FreightStatusPill status={t.status} />
        {numbers && !dead && (
          <span className="text-[13.5px] font-semibold tabular-nums text-ink w-28 text-right flex-shrink-0">
            {t.rate > 0.005 ? fmtAmount(t.rate) : <span className="font-normal text-muted text-[12.5px]">Waiting for a quote</span>}
          </span>
        )}
        {!dead && (
          tied || (t.paid != null && t.paid > 0.005)
            ? <StatusPill tone="success">Paid</StatusPill>
            : t.rate > 0.005 ? <StatusPill tone="neutral">Not paid yet</StatusPill> : null
        )}
        {numbers && !dead && t.paid != null && t.paid > 0.005 && <span className="text-[12px] text-muted tabular-nums">{fmtAmount(t.paid)} from the bank</span>}
        {!dead && mayAsk && !tied && !(t.paid != null && t.paid > 0.005) && (
          <button type="button" onClick={() => linkTo(t.id, "", `${t.code} is no longer on this load`)} disabled={linkBusy} className={GHOST} title="Take this truck off the load. It stays in Logistics as a load with no deal.">Unlink</button>
        )}
        {!dead && attach && numbers && (
          tied
            ? <button type="button" onClick={() => controls.unlink(target(t))} disabled={controls.busy} className={GHOST}>Take the bank payment off</button>
            : BOOKED_OR_LATER.includes(t.status) && <button type="button" onClick={() => controls.link(target(t))} disabled={controls.busy} className={GHOST}>Tie the bank payment</button>
        )}
      </div>
    );
  };

  return (
    <div id="buy-sec-ship" className={`${WH_CARD} overflow-hidden scroll-mt-4`}>
      <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[13px] font-semibold text-ink">Shipping in</span>
        <div className="flex items-center gap-2 flex-wrap">
          {live.length > 0 && <button type="button" onClick={() => openLoadInLogistics(live[0].id)} className={`${WH_BTN_SECONDARY} !h-8 !px-3 !text-[12.5px]`}><ExternalLink size={12} /> Open in Logistics</button>}
          {mayAsk && <button type="button" onClick={openLinking} className={`${WH_BTN_SECONDARY} !h-8 !px-3 !text-[12.5px]`}><Link2 size={12} /> Link a truck</button>}
          {mayAsk && (
            <button type="button" onClick={() => setSending(true)} className={`${live.length === 0 ? WH_BTN_PRIMARY : WH_BTN_SECONDARY} ${live.length === 0 ? "" : "!h-8 !px-3 !text-[12.5px]"}`}>
              <Truck size={13} /> Send to logistics
            </button>
          )}
        </div>
      </div>

      {live.length === 0 ? (
        <div className="px-4 py-5 text-[12.5px] text-muted leading-relaxed">
          No truck yet. Send it to logistics: they quote each truck, you tie each carrier's bank payment here, and what the trucks cost goes into what each one costs the moment it is quoted.
          {d.buy.ship_typed > 0.005 && numbers ? ` Until then the ${fmtAmount(d.buy.ship_typed)} you typed for shipping in counts.` : ""}
        </div>
      ) : (
        <>
          <div className="divide-y divide-line">{live.map(row)}</div>
          <div className="px-4 py-3 border-t border-line space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-ink-2">{tc.live} {tc.live === 1 ? "truck" : "trucks"}{tc.priced < tc.live ? `, ${tc.priced} priced so far` : ""}{tc.paid > 0 ? `, ${tc.paid} paid` : ""}</span>
              {numbers && <span className="font-semibold text-ink tabular-nums">{fmtAmount(d.buy.ship_total)}</span>}
            </div>
            {numbers && d.buy.markup_total > 0.005 && (
              <div className="flex items-baseline justify-between gap-3 text-[12.5px] text-muted">
                <span>Logistics markup on the trucks: his pay off the split, not in your cost</span>
                <span className="tabular-nums">{fmtAmount(d.buy.markup_total)}</span>
              </div>
            )}
            {numbers && <p className="text-[11.5px] text-muted">Each truck counts at what its carrier was paid, else its rate, else the cost its quote was built on.</p>}
          </div>
        </>
      )}
      {cancelled.length > 0 && (
        <div className="border-t border-line divide-y divide-line">{cancelled.map(row)}</div>
      )}
      {numbers && !attach && live.length > 0 && <p className="px-4 pb-3 text-[12px] text-muted">Tying a bank payment to a truck needs the Financials switch on your role.</p>}
      {linking && (
        <div className="border-t border-line px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-medium text-ink">Which load in Logistics brought it in?</span>
            <button type="button" onClick={() => setLinking(null)} className="text-[12px] text-muted hover:text-ink-2">Close</button>
          </div>
          {linking.length === 0 ? <p className="text-[12.5px] text-muted">No load without a deal is set up in Logistics. Send it to logistics instead.</p> : linking.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-line">
              <span className="font-mono text-[12px] text-ink-2 flex-shrink-0">{t.code}</span>
              <span className="text-[13px] text-ink truncate min-w-0">{[t.pickup_name, t.delivery_name].filter(Boolean).join(" to ") || "No places yet"}</span>
              <span className="text-[12px] text-muted ml-auto flex-shrink-0">{[t.pickup_date, statusWord(t.status)].filter(Boolean).join(" · ")}</span>
              <button type="button" onClick={() => linkTo(t.id, d.buy.id, `${t.code} brings this load in`)} disabled={linkBusy} className={GHOST}>Link</button>
            </div>
          ))}
        </div>
      )}
      {controls.sheet}
      {sending && (
        <BuySendSheet buy={{ id: d.buy.id, name: d.buy.name }} live={live.length} onClose={() => setSending(false)}
          onSent={() => { setSending(false); api.netsyncSyncNow().catch(() => {}).finally(onChanged); }} />
      )}
    </div>
  );
}
