import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCountUp } from "./motion";

// A label (12px muted), the figure (24px/500, slight negative tracking) and, optionally, a change
// with what it is measured against. When `value` is a number the figure counts to its new value
// whenever it changes; a string is shown as is. No box, no grid lines: lay KPIs out in a grid with a
// <div className="vsep" /> between them (see the Home mockup).

export interface KpiProps {
  label: ReactNode;
  value: number | string | null;
  /** How a number is written ($1,234.56, 12 deals). Default: grouped digits. */
  format?: (n: number) => string;
  /** The change, already written ("11.9%", "$2,180 late"). The arrow comes from `tone`. */
  delta?: ReactNode;
  /** up = green with an up arrow, down = red with a down arrow, flat = muted. */
  tone?: "up" | "down" | "flat";
  /** What the change is against ("vs October to date"). */
  caption?: ReactNode;
  className?: string;
}

const group = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export default function Kpi({ label, value, format, delta, tone = "flat", caption, className }: KpiProps) {
  const counted = useCountUp(typeof value === "number" ? value : null);
  const text = typeof value === "number"
    ? (format ?? group)(counted ?? value)
    : value === null ? "" : value;
  return (
    <div className={`min-w-0 p-4 ${className || ""}`}>
      <div className="ui-label">{label}</div>
      <div className="ui-fig mt-2">{text}</div>
      {(delta || caption) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {delta ? (
            <span className={`ui-delta ${tone === "up" ? "up" : tone === "down" ? "down" : ""}`} style={tone === "flat" ? { color: "rgb(var(--c-muted))" } : undefined}>
              {tone === "up" ? <ArrowUp size={12} /> : tone === "down" ? <ArrowDown size={12} /> : null}
              {delta}
            </span>
          ) : null}
          {caption ? <span className="ui-note">{caption}</span> : null}
        </div>
      )}
    </div>
  );
}
