import { useEffect, useState } from "react";
import { api, type FreightBooking } from "../lib/api";
import { dashboardLoads, groupOf } from "../lib/logisticsLoad";
import StatusPill from "./StatusPill";
import { BookingRow } from "./LogisticsView";
import { openLoadInLogistics } from "./LogisticsPayCarriers";

// R-483: what is going on with the freight, right under the Dashboard's numbers. Two groups in one card, the
// same rows as the Logistics list: the loads waiting on shipping (booked or on the way) and the delivered loads
// whose carrier is not paid yet. A row opens the load. Nothing shows when neither group has a load, or when the
// server does not let this person see Logistics.

const byPickup = (a: FreightBooking, b: FreightBooking) =>
  (a.pickup_date || "9999").localeCompare(b.pickup_date || "9999") || a.created_at.localeCompare(b.created_at);
const byDue = (a: FreightBooking, b: FreightBooking) =>
  (a.pay_due_date || "9999").localeCompare(b.pay_due_date || "9999") || a.created_at.localeCompare(b.created_at);

export default function DashboardLoads() {
  const [list, setList] = useState<FreightBooking[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.logistics.list().then((r) => { if (alive) setList(r.bookings ?? []); }).catch(() => { if (alive) setList(null); });
    return () => { alive = false; };
  }, []);
  if (!list) return null;
  const { shipping, carrier } = dashboardLoads(list);
  if (shipping.length === 0 && carrier.length === 0) return null;

  const group = (title: string, rows: FreightBooking[]) => rows.length > 0 && (
    <div>
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <StatusPill tone="neutral">{rows.length}</StatusPill>
      </div>
      <div className="divide-y divide-line">
        {rows.map((b) => (
          <BookingRow key={b.id} b={b} group={groupOf(b) ?? "delivered"} onOpen={() => openLoadInLogistics(b.id)} />
        ))}
      </div>
    </div>
  );

  return (
    <section className="bg-surface border border-line rounded-2xl overflow-hidden divide-y divide-line">
      {group("Waiting on shipping", [...shipping].sort(byPickup))}
      {group("Waiting to pay the carrier", [...carrier].sort(byDue))}
    </section>
  );
}
