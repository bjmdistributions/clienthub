import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { FreightBooking } from "../lib/api";
import { parseLocalDay } from "../lib/format";
import { deliveryDays } from "../lib/logisticsLoad";

// R-487: when loads are expected to be delivered, the next 14 days, one bar per day. Each bar stacks what is coming
// that day: delivered (today only, green), on the way (teal), booked (light teal), the same colours as the Dashboard's
// cards. Loads whose delivery day has passed stand in their own red Late column on the left. A bar opens its loads
// under the chart, in the list's own rows (`renderRow`).

const SEG = [
  { key: "delivered", label: "Delivered", color: "var(--c-chart-profit)" },
  { key: "way", label: "On the way", color: "var(--c-chart-2)" },
  // R-507: teal while a load ships; booked is the same teal at 45% so the two still stack apart (it reads as rgb(... / 0.45)).
  { key: "booked", label: "Booked", color: "var(--c-chart-2) / 0.45" },
] as const;
const LATE = "var(--c-chart-loss)";
const PLOT_H = 140;

function dayLabel(day: string, i: number): [string, string] {
  if (i === 0) return ["Today", ""];
  const d = parseLocalDay(day);
  return [d.toLocaleDateString(undefined, { weekday: "short" }), String(d.getDate())];
}

export default function LogisticsDeliveryChart({ rows, today, renderRow }: {
  rows: FreightBooking[]; today: string; renderRow: (b: FreightBooking) => ReactNode;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const { days, late, undated } = deliveryDays(rows, today);
  const counts = days.map((d) => d.delivered.length + d.way.length + d.booked.length);
  const max = Math.max(1, late.length, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const picked: FreightBooking[] = pick === "late" ? late
    : (() => { const d = days.find((x) => x.day === pick); return d ? [...d.delivered, ...d.way, ...d.booked] : []; })();
  const pickedTitle = pick === "late" ? "Late" : pick ? (pick === today ? "Today" : parseLocalDay(pick).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })) : "";

  const column = (key: string, i: number, segs: { n: number; color: string; label: string }[], label: [string, string], tip: string) => {
    const n = segs.reduce((a, s) => a + s.n, 0);
    const on = pick === key;
    const isLate = key === "late";
    return (
      <button key={key} type="button" onClick={() => setPick(on ? null : key)} disabled={n === 0}
        title={tip} aria-pressed={on}
        className={`group flex-1 min-w-0 flex flex-col items-center rounded-lg pt-1 pb-2 transition-colors duration-[130ms]
          ${on ? "bg-surface-3" : n > 0 ? "hover:bg-surface-2" : "cursor-default"}`}>
        <span className={`text-[13px] font-medium tabular-nums h-[18px] ${n > 0 ? (isLate ? "text-danger-ink" : "text-ink") : "text-transparent"}`}>{n || 0}</span>
        <span className="w-full flex flex-col-reverse items-center justify-start gap-[2px]" style={{ height: PLOT_H }}>
          {segs.filter((s) => s.n > 0).map((s, k, arr) => (
            <span key={s.label} className="w-[62%] max-w-[26px] transition-[height] duration-300 ease-out"
              style={{ height: Math.max(4, (s.n / max) * PLOT_H - 2), background: `rgb(${s.color})`,
                borderRadius: k === arr.length - 1 ? "4px 4px 1px 1px" : "1px" }} />
          ))}
          {n === 0 && <span className="w-[62%] max-w-[26px] h-[2px] rounded-full bg-surface-3" />}
        </span>
        <span className={`mt-2 text-[13px] leading-4 ${i === 0 ? "font-medium text-ink" : isLate ? "text-danger-ink" : "text-muted"}`}>{label[0]}</span>
        <span className="text-[13px] leading-4 text-muted tabular-nums h-4">{label[1]}</span>
      </button>
    );
  };

  const legendTone: Record<string, string> = { delivered: "text-success-ink", way: "text-ship-ink", booked: "text-ship-ink opacity-60", late: "text-danger-ink" };

  return (
    <section aria-label="Deliveries, next 14 days">
      <div className="flex items-start justify-between gap-x-5 gap-y-2.5 flex-wrap">
        <div className="min-w-0">
          <h3 className="m-0 text-[18px] font-medium text-ink">Deliveries, next 14 days</h3>
          <p className="m-0 mt-1 text-[14px] text-muted">
            {total + late.length === 0 ? "Nothing is expected in the next 14 days." : `${total} expected${late.length ? `, ${late.length} late` : ""}${undated ? `, ${undated} with no delivery day yet` : ""}. Click a day to see its loads.`}
          </p>
        </div>
        <div className="flex items-center gap-y-1 gap-x-[18px] flex-wrap text-[13px]">
          {[...SEG.slice().reverse(), ...(late.length ? [{ key: "late", label: "Late", color: LATE }] : [])].map((s) => (
            <span key={s.key} className={legendTone[s.key]}>{s.label}</span>
          ))}
        </div>
      </div>
      <div className="mt-3.5 flex items-end gap-0.5 overflow-x-auto pb-1">
        {late.length > 0 && (
          <div className="flex items-end pr-1.5 mr-1.5 w-[52px] flex-shrink-0" style={{ boxShadow: "1px 0 0 rgb(var(--c-line))" }}>
            {column("late", -1, [{ n: late.length, color: LATE, label: "Late" }], ["Late", ""],
              `${late.length} late: the delivery day has passed and the load is not delivered`)}
          </div>
        )}
        {days.map((d, i) => column(d.day, i, SEG.map((s) => ({ n: d[s.key].length, color: s.color, label: s.label })), dayLabel(d.day, i),
          `${dayLabel(d.day, i).join(" ")}: ${SEG.map((s) => `${d[s.key].length} ${s.label.toLowerCase()}`).join(", ")}`))}
      </div>
      {pick && picked.length > 0 && (
        <div className="mt-3.5 animate-page-slide-in">
          <div className="hsep" />
          <div className="flex items-baseline gap-2.5 px-2 pt-3.5 pb-1.5">
            {pick === "late" && <AlertTriangle size={16} className="text-danger-ink self-center" />}
            <h4 className="m-0 text-[16px] font-medium text-ink">{pickedTitle}</h4>
            <span className="text-[12px] text-muted tabular-nums">{picked.length}</span>
          </div>
          <div>{picked.map(renderRow)}</div>
        </div>
      )}
    </section>
  );
}
