import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Truck } from "lucide-react";
import { api, type ShipmentDeal, type Shipments } from "../lib/api";
import { fmtAmount, localDay } from "../lib/format";
import { SHIPMENT_RANGES, shipmentRange, type ShipmentRangeKey } from "../lib/shipmentRange";
import { FreightStatusPill } from "./LogisticsBookingForm";

// R-415: every shipment on our side. One row per deal that has at least one booking (cancelled
// trucks included, marked): what the customer was charged for shipping, what the carrier was
// paid and what is left. The server works out every figure and decides who may read the list, so
// this screen only prints what it is given.

const REFRESH_MS = 30_000;
const signed = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function Figure({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-muted truncate">{label}</div>
      <div className={`text-[20px] font-bold tabular-nums leading-tight mt-0.5 ${tone === "danger" ? "text-danger-ink" : "text-ink"}`}>{value}</div>
    </div>
  );
}

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
          <span className="font-mono text-[11.5px] text-muted flex-shrink-0">{t.code}</span>
          <FreightStatusPill status={t.status} />
          {t.carrier && <span className="text-[12px] text-ink-2 truncate min-w-0">{t.carrier}</span>}
        </div>
      ))}
    </div>
  );
}

function Surplus({ d }: { d: ShipmentDeal }) {
  if (d.surplus == null) return <span className="text-[12px] text-muted">Waiting on the amount paid</span>;
  return <span className={`tabular-nums font-semibold ${d.surplus < -0.005 ? "text-danger-ink" : "text-ink"}`}>{signed(d.surplus)}</span>;
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
    setData(null);
    load();
    const id = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => { window.clearInterval(id); window.removeEventListener("focus", load); };
  }, [load]);

  const tot = data?.totals;
  const paying = tot?.mode === "pay";
  const waiting = tot?.waiting ?? (data?.deals ?? []).filter((d) => d.surplus == null && d.trucks.some((t) => t.status !== "cancelled")).length;

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line flex-wrap" role="group" aria-label="Date range">
          {SHIPMENT_RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={key === r.key} onClick={() => setKey(r.key)}
              className={`h-8 px-3 rounded-md text-[12.5px] whitespace-nowrap transition-colors ${key === r.key ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
              {r.label}
            </button>
          ))}
        </div>
        {key === "custom" && (
          <div className="flex items-center gap-2">
            <input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="border border-line px-2.5 h-9 rounded-lg text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
            <span className="text-[12px] text-muted">to</span>
            <input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="border border-line px-2.5 h-9 rounded-lg text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-bg px-4 py-3 text-[12.5px] text-warning-ink" role="alert">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={load} className="font-medium underline flex-shrink-0">Try again</button>
        </div>
      )}

      {data === null ? (
        <div className="space-y-3" aria-busy="true">
          <div className="h-[72px] bg-surface-2 rounded-xl animate-pulse" />
          <div className="h-[180px] bg-surface-2 rounded-xl animate-pulse" />
        </div>
      ) : (
        <>
          <section className="bg-surface border border-line rounded-xl px-4 py-3.5">
            <div className={`grid gap-x-6 gap-y-3 ${paying ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
              <Figure label="Charged" value={fmtAmount(tot?.billed ?? 0)} />
              <Figure label="Paid" value={fmtAmount(tot?.paid ?? 0)} />
              <Figure label="Surplus" value={signed(tot?.surplus ?? 0)} tone={(tot?.surplus ?? 0) < -0.005 ? "danger" : undefined} />
              {paying && <Figure label="Logistics pay" value={fmtAmount(tot?.pay ?? 0)} />}
            </div>
            <div className="text-[11.5px] text-muted mt-2.5">
              {tot?.deals ?? 0} deal{(tot?.deals ?? 0) !== 1 ? "s" : ""}, {tot?.trucks ?? 0} truck{(tot?.trucks ?? 0) !== 1 ? "s" : ""}
              {waiting > 0 ? `, ${waiting} waiting on the amount paid (not in the figures above)` : ""}
            </div>
          </section>

          {data.deals.length === 0 ? (
            <div className="bg-surface border border-line rounded-xl px-6 py-12 text-center">
              <Truck size={22} className="mx-auto text-faint mb-2" />
              <div className="text-[14px] font-medium text-ink">No shipments in this range</div>
              <div className="text-[12.5px] text-muted mt-1">A deal shows up here once it has a truck sent to logistics.</div>
            </div>
          ) : (
            <section className="bg-surface border border-line rounded-xl overflow-hidden">
              <table className="w-full text-[12.5px] border-collapse">
                <thead>
                  <tr className="text-left text-[11.5px] text-muted border-b border-line bg-surface-2/50">
                    <th className="font-medium px-4 py-2">Deal</th>
                    <th className="font-medium px-2 py-2">Trucks</th>
                    <th className="font-medium px-2 py-2 text-right">Charged</th>
                    <th className="font-medium px-2 py-2 text-right">Paid</th>
                    <th className="font-medium px-2 py-2 text-right">Surplus</th>
                    <th className="w-7" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.deals.map((d) => (
                    <tr key={d.deal_flow_id} onClick={() => openDeal(d.invoice_number)}
                      className="cursor-pointer hover:bg-surface-2/60 transition-colors align-top">
                      <td className="px-4 py-3 min-w-0 max-w-[220px]">
                        <button type="button" onClick={(e) => { e.stopPropagation(); openDeal(d.invoice_number); }}
                          className="text-left min-w-0 max-w-full">
                          <span className="block text-[13px] font-medium text-ink truncate">{d.invoice_number || "Deal"}</span>
                          <span className="block text-[12px] text-muted truncate">{d.client_name}</span>
                        </button>
                      </td>
                      <td className="px-2 py-3 min-w-0"><Trucks d={d} /></td>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{d.billed > 0.005 ? fmtAmount(d.billed) : "-"}</td>
                      <td className="px-2 py-3 text-right tabular-nums text-ink">{d.freight > 0.005 ? fmtAmount(d.freight) : "-"}</td>
                      <td className="px-2 py-3 text-right max-w-[120px]"><Surplus d={d} /></td>
                      <td className="pr-3 py-3"><ChevronRight size={14} className="text-faint" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
