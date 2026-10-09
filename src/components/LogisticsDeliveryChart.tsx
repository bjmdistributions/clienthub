import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { FreightBooking } from "../lib/api";
import { parseLocalDay } from "../lib/format";
import { deliveryDays } from "../lib/logisticsLoad";

// R-487: when loads are expected to be delivered, the next 14 days, one bar per day. Each bar stacks what is coming
// that day: delivered (today only, green), on the way (teal), booked (indigo), the same colours as the Dashboard's
// cards. Loads whose delivery day has passed stand in their own red Late column on the left. A bar opens its loads
// under the chart, in the list's own rows (`renderRow`).

const SEG = [
  { key: "delivered", label: "Delivered", color: "var(--c-chart-profit)" },
  { key: "way", label: "On the way", color: "var(--c-chart-2)" },
  { key: "booked", label: "Booked", color: "var(--c-chart-3)" },
] as const;
const LATE = "var(--c-chart-loss)";
const PLOT_H = 120;

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
    return (
      <button key={key} type="button" onClick={() => setPick(on ? null : key)} disabled={n === 0}
        title={tip} aria-pressed={on}
        className={`group flex-1 min-w-0 flex flex-col items-center rounded-lg pt-1 pb-1.5 transition-colors duration-[130ms]
          ${on ? "bg-surface-2 ring-1 ring-line" : n > 0 ? "hover:bg-surface-2/70" : "cursor-default"}`}>
        <span className={`text-[11.5px] tabular-nums h-4 ${n > 0 ? "text-ink font-semibold" : "text-transparent"}`}>{n || 0}</span>
        <span className="w-full flex flex-col-reverse items-center justify-start gap-[2px]" style={{ height: PLOT_H }}>
          {segs.filter((s) => s.n > 0).map((s, k, arr) => (
            <span key={s.label} className="w-[62%] max-w-[26px]"
              style={{ height: Math.max(4, (s.n / max) * PLOT_H - 2), background: `rgb(${s.color})`,
                borderRadius: k === arr.length - 1 ? "4px 4px 1px 1px" : "1px" }} />
          ))}
          {n === 0 && <span className="w-[62%] max-w-[26px] h-[2px] rounded-full bg-line" />}
        </span>
        <span className={`mt-1.5 text-[11px] leading-tight ${i === 0 ? "font-semibold text-ink" : "text-muted"}`}>{label[0]}</span>
        <span className="text-[11px] leading-tight text-muted tabular-nums h-3.5">{label[1]}</span>
      </button>
    );
  };

  return (
    <section className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 pt-3.5 pb-1 flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">Deliveries, next 14 days</h3>
          <p className="text-[12.5px] text-muted mt-0.5">
            {total + late.length === 0 ? "Nothing is expected in the next 14 days." : `${total} expected${late.length ? `, ${late.length} late` : ""}${undated ? `, ${undated} with no delivery day yet` : ""}. Click a day to see its loads.`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[11.5px] text-ink-2">
          {[...SEG.slice().reverse(), ...(late.length ? [{ key: "late", label: "Late", color: LATE }] : [])].map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: `rgb(${s.color})` }} />{s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="px-2 pb-2 flex items-end gap-0.5 overflow-x-auto">
        {late.length > 0 && (
          <div className="flex items-end pr-1 mr-1 border-r border-line">
            {column("late", -1, [{ n: late.length, color: LATE, label: "Late" }], ["Late", ""],
              `${late.length} late: the delivery day has passed and the load is not delivered`)}
          </div>
        )}
        {days.map((d, i) => column(d.day, i, SEG.map((s) => ({ n: d[s.key].length, color: s.color, label: s.label })), dayLabel(d.day, i),
          `${dayLabel(d.day, i).join(" ")}: ${SEG.map((s) => `${d[s.key].length} ${s.label.toLowerCase()}`).join(", ")}`))}
      </div>
      {pick && picked.length > 0 && (
        <div className="border-t border-line">
          <div className="px-4 py-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
            {pick === "late" && <AlertTriangle size={13} style={{ color: "rgb(var(--c-chart-loss-ink))" }} />}
            {pickedTitle}<span className="text-muted font-normal tabular-nums">{picked.length}</span>
          </div>
          <div className="divide-y divide-line border-t border-line">{picked.map(renderRow)}</div>
        </div>
      )}
    </section>
  );
}
