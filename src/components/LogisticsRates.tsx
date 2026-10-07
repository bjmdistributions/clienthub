import { useEffect, useState } from "react";
import { api, type RatesResponse } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { lastRate, rateOf } from "../lib/logisticsCarriers";
import { fmtDayLabel } from "../lib/logisticsLoad";
import StatusPill from "./StatusPill";
import { LogisticsModal, modalPrimary } from "./LogisticsCarriers";

// R-459: the smart rate comparison. On a load's Quote and Book steps, and on the team's send sheet once the
// two addresses are in, a card says who carried this lane last and at what, with the whole history one click
// away and the carrier's card behind its name. The server matches the lane (it can read addresses the viewer
// cannot), so this only prints what it is given: a figure the viewer may not see is simply absent.

/** A carrier name that opens the carrier card when the load named one. */
function CarrierName({ id, name, onOpen }: { id: string; name: string; onOpen: (id: string) => void }) {
  return id
    ? <button type="button" onClick={() => onOpen(id)} className="font-medium text-accent hover:underline">{name}</button>
    : <span className="font-medium text-ink">{name}</span>;
}

type By = { bookingId: string } | { pickup: string; delivery: string };

export function RateCard({ by, onOpenCarrier }: { by: By | null; onOpenCarrier: (carrierId: string) => void }) {
  const [r, setR] = useState<RatesResponse | null | "none">(null);
  const [all, setAll] = useState(false);
  const key = by ? ("bookingId" in by ? by.bookingId : `${by.pickup}|${by.delivery}`) : "";

  useEffect(() => {
    if (!by) { setR(null); return; }
    let dead = false;
    setR(null);
    // The send sheet asks as an address is typed, so a pause comes first.
    const t = window.setTimeout(() => {
      api.logistics.rates(by).then((x) => { if (!dead) setR(x); }).catch(() => { if (!dead) setR("none"); });
    }, "bookingId" in by ? 0 : 450);
    return () => { dead = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // No lane yet, or the server cannot say (an older server, or a refusal): the card stays out of the way.
  if (!by || r === "none") return null;
  if (r === null) return <div className="rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5 text-[12.5px] text-muted">Looking up this lane...</div>;

  const last = lastRate(r);
  return (
    <>
      <div className="rounded-xl border border-line bg-surface-2/50 px-3.5 py-2.5 flex items-start justify-between gap-3" role="status" aria-label="Rate on this lane">
        <div className="text-[13px] text-ink-2 min-w-0 break-words">
          {last ? <>{last.lead} <CarrierName id={last.carrierId} name={last.carrier} onOpen={onOpenCarrier} /> {last.tail}</> : "No past loads on this lane yet."}
        </div>
        {r.matches.length > 0 && (
          <button type="button" onClick={() => setAll(true)} className="text-[12.5px] text-accent font-medium hover:underline whitespace-nowrap flex-shrink-0">See all rates</button>
        )}
      </div>
      {all && (
        <LogisticsModal title="Rates on this lane" sub={[r.lane.from, r.lane.to].filter(Boolean).join(" to ") || undefined} wide onClose={() => setAll(false)}
          footer={<button onClick={() => setAll(false)} className={modalPrimary}>Close</button>}>
          <div className="rounded-lg border border-line divide-y divide-line">
            {r.matches.map((m) => {
              const rate = rateOf(m);
              return (
                <div key={m.booking_id} className="flex items-center gap-3 px-3 py-2 text-[12.5px] min-w-0">
                  <span className="font-mono text-ink-2 flex-shrink-0">{m.load_number}</span>
                  <span className="text-muted flex-shrink-0">{fmtDayLabel(m.day)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <CarrierName id={m.carrier_id} name={m.carrier || "Carrier not named"} onOpen={onOpenCarrier} />
                    {m.equipment && <span className="text-muted">{" "}{m.equipment}</span>}
                  </span>
                  {!m.exact && <StatusPill tone="neutral">Same states</StatusPill>}
                  {rate != null && <span className="tabular-nums text-ink flex-shrink-0">{fmtAmount(rate)}</span>}
                </div>
              );
            })}
          </div>
        </LogisticsModal>
      )}
    </>
  );
}
