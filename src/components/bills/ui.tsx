// R-449: the small pieces every Bills mode shares. Local to this screen on purpose: the cards,
// tiles and palette hook other screens use are not exported, and the copies below are the
// Brief and Dashboard card dialect (rounded-2xl, border-line, 13px semibold title).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtAmount } from "../../lib/format";
import { initials, tintIndex } from "../../lib/billsFormat";

export const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
export const btn =
  "border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-8 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 whitespace-nowrap";
export const pri =
  "px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity inline-flex items-center gap-1.5 whitespace-nowrap";

/** Money with the minus in front of the dollar sign: fmtAmount alone writes "$-12.00". Less than
 *  half a cent, and negative zero (what negating a zero total gives), read as plain $0.00. */
export const signed = (n: number) => {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return v < 0 ? "−" + fmtAmount(Math.abs(v)) : fmtAmount(v);
};

export function Card({ title, sub, right, children, className = "" }: {
  title: string; sub?: string; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`bg-surface border border-line rounded-2xl overflow-hidden min-w-0 ${className}`}>
      <div className="px-5 py-3.5 border-b border-line-2 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink tracking-tight">{title}</h3>
          {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
        </div>
        {right && <div className="min-w-0">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** One cell of a band of figures. The card around the band owns the borders. */
export function Tile({ label, value, sub, valueCls = "text-ink", className = "", action }: {
  label: string; value: string; sub?: string; valueCls?: string; className?: string; action?: ReactNode;
}) {
  return (
    <div className={`p-5 min-w-0 ${className}`}>
      <div className="text-[12px] font-medium text-muted truncate">{label}</div>
      <div className={`text-[19px] sm:text-[21px] 2xl:text-[24px] font-bold tabular-nums mt-1.5 leading-none tracking-tight truncate ${valueCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-faint mt-1.5 truncate">{sub}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** The segmented control Brief uses for Today and This week. */
export function Seg<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="flex items-center gap-0.5 bg-surface-2 border border-line rounded-lg p-0.5 max-w-full overflow-x-auto">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`px-3 h-7 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors duration-[130ms] ${value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The only logos a bill may carry (the save check's rule): a PNG or JPEG data URL. A synced row
 *  can hold anything else, and an image address would make this window fetch it. */
export const okLogo = (s?: string) => /^data:image\/(png|jpeg);base64,/.test(s || "");

/** A bill's picture: its own logo, or its initials on a tint taken from the chart tokens so a
 *  bill keeps one colour on every screen. The tile sits on surface-2 with a ring, never a white
 *  box, so a transparent logo reads on the dark theme too. */
export function BillLogo({ name, logo, size = 40 }: { name: string; logo?: string; size?: number }) {
  const box = { width: size, height: size };
  if (logo && okLogo(logo)) {
    return (
      <span style={box} className="rounded-lg bg-surface-2 ring-1 ring-line flex items-center justify-center overflow-hidden flex-shrink-0">
        <img src={logo} alt="" draggable={false} className="w-full h-full object-contain p-[3px]" />
      </span>
    );
  }
  const t = tintIndex(name);
  return (
    <span
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.36)), background: `rgb(var(--c-chart-${t}) / 0.16)`, boxShadow: `inset 0 0 0 1px rgb(var(--c-chart-${t}) / 0.3)` }}
      className="rounded-lg flex items-center justify-center font-semibold text-ink-2 flex-shrink-0 select-none"
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Close a modal or drawer with Escape. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb = (n: string) => `rgb(${cssVar(n)})`;

/** Chart colours read off the design tokens, re-read when the theme flips. */
export function useChartColors() {
  const [tick, force] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => force((x) => x + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return useMemo(() => {
    void tick;
    return {
      bills: rgb("--c-chart-1"),
      other: rgb("--c-chart-2"),
      profit: rgb("--c-chart-profit"),
      loss: rgb("--c-chart-loss"),
      grid: rgb("--c-line"),
      axis: { fontSize: 10, fill: rgb("--c-muted") },
      tip: {
        contentStyle: {
          background: rgb("--c-surface"),
          border: `1px solid ${rgb("--c-line")}`,
          borderRadius: 12,
          color: rgb("--c-ink"),
          fontSize: 12,
          padding: "9px 13px",
        },
        cursor: { fill: `rgb(${cssVar("--c-ink")} / 0.05)` },
        itemStyle: { color: rgb("--c-ink") },
        labelStyle: { color: rgb("--c-muted"), marginBottom: 3 },
      },
    };
  }, [tick]);
}
