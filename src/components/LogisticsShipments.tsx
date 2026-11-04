import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Truck } from "lucide-react";
import { api, type ShipmentDeal, type Shipments } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { SHIPMENT_RANGES, shipmentRange, type ShipmentRangeKey } from "../lib/shipmentRange";
import { FreightStatusPill } from "./LogisticsBookingForm";
import { Kpi, Tabs } from "./ui";

// R-415: every shipment on our side. One row per deal that has at least one booking (cancelled
// trucks included, marked): what the customer was charged for shipping, what the carrier was
// paid and what is left. The server works out every figure and decides who may read the list, so
// this screen only prints what it is given.

const REFRESH_MS = 30_000;
const signed = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function openDeal(invoiceNumber: string) {
  if (invoiceNumber) {
    try { localStorage.setItem("dealflow_invoice_filter", invoiceNumber); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "dealflow" }));
}

function Trucks({ d }: { d: ShipmentDeal }) {
  return (
    <div className="space-y-1 min-w-0">
      {d.trucks.map((t) => (
        <div key={t.id} className={`flex items-center gap-2 min-w-0 ${t.status === "cancelled" ? "opacity-60" : ""}`}>
          <span className="text-[12px] text-muted tabular-nums flex-shrink-0">{t.code}</span>
          <FreightStatusPill status={t.status} />
          {t.carrier && <span className="text-[13px] text-ink-2 truncate min-w-0">{t.carrier}</span>}
        </div>
      ))}
    </div>
  );
}

function Surplus({ d }: { d: ShipmentDeal }) {
  // A deal whose trucks were all cancelled waits on nothing.
  if (d.trucks.length > 0 && d.trucks.every((t) => t.status === "cancelled")) return <span className="text-[13px] text-muted">Cancelled</span>;
  if (d.surplus == null) return <span className="text-[13px] text-muted">Waiting on the amount paid</span>;
  return <span className={`tabular-nums ${d.surplus < -0.005 ? "text-danger-ink" : "text-ink"}`}>{signed(d.surplus)}</span>;
}

export default function LogisticsShipments() {
  const [key, setKey] = useState<ShipmentRangeKey>("month");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [data, setData] = useState<Shipments | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const range = useMemo(() => shipmentRange(key, localDay(), custom), [key, custom]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const got = await api.logistics.shipments(range);
      if (mine === seq.current) { setData(got); setError(""); }
    } catch (e) {
      if (mine === seq.current) { setError(String(e)); setData((prev) => prev ?? { deals: [], totals: { deals: 0, trucks: 0, billed: 0, paid: 0, surplus: 0, pay: 0 } }); }
    }
  }, [range]);
  useEffect(() => {
    // The old rows stay on screen while a new range loads, so the table never flashes empty.
    load();
    const id = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => { window.clearInterval(id); window.removeEventListener("focus", load); };
  }, [load]);

  const tot = data?.totals;
  const paying = tot?.mode === "pay";
  const waiting = tot?.waiting ?? (data?.deals ?? []).filter((d) => d.surplus == null && d.trucks.some((t) => t.status !== "cancelled")).length;
  const surplus = tot?.surplus ?? 0;

  return (
    <div className="space-y-5 min-w-0">
      <div className="flex items-center gap-2.5 flex-wrap">
        <Tabs label="Date range" value={key} onChange={(k) => setKey(k as ShipmentRangeKey)} tabs={SHIPMENT_RANGES.map((r) => ({ id: r.key, label: r.label }))} />
        {key === "custom" && (
          <div className="flex items-center gap-2">
            <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="border border-line-3 px-2.5 h-9 rounded-lg text-[13px] bg-transparent text-ink focus:outline-none focus:border-ink" />
            <span className="text-[13px] text-muted">to</span>
            <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="border border-line-3 px-2.5 h-9 rounded-lg text-[13px] bg-transparent text-ink focus:outline-none focus:border-ink" />
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-warning-bg px-4 py-3 text-[13px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={load} className="ui-link flex-shrink-0">Try again</button>
        </div>
      )}

      {data === null ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-[96px] bg-surface-2 rounded-xl animate-pulse" />
          <div className="h-[220px] bg-surface-2 rounded-xl animate-pulse" />
        </div>
      ) : (
        <div className="space-y-5 animate-page-slide-in">
          <section>
            <div className={`grid items-stretch ${paying ? "grid-cols-2 xl:grid-cols-[1fr_1px_1fr_1px_1fr_1px_1fr]" : "grid-cols-1 sm:grid-cols-[1fr_1px_1fr_1px_1fr]"}`}>
              <Kpi label="Charged" value={tot?.billed ?? 0} format={fmtAmount} />
              <div className="vsep hidden sm:block" />
              <Kpi label="Paid" value={tot?.paid ?? 0} format={fmtAmount} />
              <div className="vsep hidden sm:block" />
              <Kpi label="Surplus" value={surplus} format={signed} tone={surplus < -0.005 ? "down" : "flat"} />
              {paying && <><div className="vsep hidden xl:block" /><Kpi label="Logistics pay" value={tot?.pay ?? 0} format={fmtAmount} /></>}
            </div>
            <div className="ui-note px-4 mt-1">
              {tot?.deals ?? 0} deal{(tot?.deals ?? 0) !== 1 ? "s" : ""}, {tot?.trucks ?? 0} truck{(tot?.trucks ?? 0) !== 1 ? "s" : ""}
              {waiting > 0 ? `, ${waiting} waiting on the amount paid (not in the figures above)` : ""}
            </div>
          </section>

          <div className="hsep" />

          {data.deals.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <Truck size={20} className="mx-auto text-faint mb-2" />
              <div className="text-[15px] font-medium text-ink">No shipments in this range</div>
              <div className="text-[13px] text-muted mt-1">A deal shows up here once it has a truck sent to logistics.</div>
            </div>
          ) : (
            <table className="ui-table ui-table-click">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Trucks</th>
                  <th className="r">Charged</th>
                  <th className="r">Paid</th>
                  <th className="r">Surplus</th>
                  <th className="w-7" />
                </tr>
              </thead>
              <tbody>
                {data.deals.map((d) => (
                  <tr key={d.deal_flow_id} onClick={() => openDeal(d.invoice_number)} className="align-top">
                    <td className="min-w-0 max-w-[220px]">
                      <button type="button" onClick={(e) => { e.stopPropagation(); openDeal(d.invoice_number); }}
                        className="text-left min-w-0 max-w-full">
                        <span className="block text-[14px] font-medium text-ink truncate">{d.invoice_number || "Deal"}</span>
                        <span className="block text-[13px] text-muted truncate">{d.client_name}</span>
                      </button>
                    </td>
                    <td className="min-w-0"><Trucks d={d} /></td>
                    <td className="r">{d.billed > 0.005 ? fmtAmount(d.billed) : "-"}</td>
                    <td className="r">{d.freight > 0.005 ? fmtAmount(d.freight) : "-"}</td>
                    <td className="r"><Surplus d={d} /></td>
                    <td className="!pr-3"><ChevronRight size={16} className="text-faint" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
