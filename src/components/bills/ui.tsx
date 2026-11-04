// R-449: the small pieces every Bills mode shares. Local to this screen on purpose.
// R-583: the mockups' dialect. A Card is a titled section divided by the fading hairline (no box),
// a Tile is a label and a 24px figure, and Seg is the shared Tabs track.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fmtAmount } from "../../lib/format";
import { initials } from "../../lib/billsFormat";
import { Tabs } from "../ui";

export const inp = "field-input w-full";
export const btn = "ui-btn ui-btn-sm";
export const pri = "ui-btn ui-btn-ink";

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
    <section className={`min-w-0 ${className}`}>
      <div className="hsep" />
      <div className="pt-4 pb-2.5 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="m-0 text-[14px] font-medium text-ink">{title}</h3>
          {sub && <p className="ui-note m-0 mt-0.5">{sub}</p>}
        </div>
        {right && <div className="min-w-0">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** One figure of a band. The band lays tiles out with a vsep between them. */
export function Tile({ label, value, sub, valueCls = "text-ink", className = "", action }: {
  label: string; value: string; sub?: string; valueCls?: string; className?: string; action?: ReactNode;
}) {
  return (
    <div className={`p-4 min-w-0 ${className}`}>
      <div className="ui-label truncate">{label}</div>
      <div className={`ui-fig mt-2 truncate ${valueCls}`}>{value}</div>
      {sub && <div className="ui-note mt-1.5 truncate">{sub}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** The segmented control: the shared Tabs track. */
export function Seg<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <Tabs value={value} onChange={(id) => onChange(id as T)} tabs={options.map((o) => ({ id: o.value, label: o.label }))} />
  );
}

/** The only logos a bill may carry (the save check's rule): a PNG or JPEG data URL. A synced row
 *  can hold anything else, and an image address would make this window fetch it. */
export const okLogo = (s?: string) => /^data:image\/(png|jpeg);base64,/.test(s || "");

/** A bill's picture: its own logo, or its initials on the ink, as in the mockups. A logo sits on
 *  surface-2 with a ring, never a white box, so a transparent logo reads on the dark theme too. */
export function BillLogo({ name, logo, size = 40 }: { name: string; logo?: string; size?: number }) {
  const box = { width: size, height: size };
  if (logo && okLogo(logo)) {
    return (
      <span style={box} className="rounded-full bg-surface-2 ring-1 ring-line flex items-center justify-center overflow-hidden flex-shrink-0">
        <img src={logo} alt="" draggable={false} className="w-full h-full object-contain p-[3px]" />
      </span>
    );
  }
  return (
    <span
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.32)) }}
      className="rounded-full flex items-center justify-center font-bold bg-ink text-surface flex-shrink-0 select-none"
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
      bills: cssVar("--chart-hi"),
      other: cssVar("--chart-line"),
      profit: rgb("--c-chart-profit"),
      loss: rgb("--c-chart-loss"),
      grid: cssVar("--chart-grid"),
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
