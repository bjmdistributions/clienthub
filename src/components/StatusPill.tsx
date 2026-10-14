import type { ReactNode } from "react";

// One pill for every status / flag / source tag in the app.
//
// It exists because the same markup was hand-rolled ~44 times across ~20 files and drifted
// every time: uppercase micro-labels (a standing veto), 8px/9px text (11px is the floor since R-511), and — the defect that
// prompted it — no whitespace-nowrap, so a chip inside a narrow table cell wrapped its own
// label into a two-line box and stacked. Route new status tags through here rather than
// writing the span again.
//
// Always sentence case, always one line, never shrinks below its own text.

type Tone = "accent" | "danger" | "warning" | "success" | "neutral" | "shipping" | "step";

const TONES: Record<Tone, string> = {
  accent:  "text-accent-hover bg-accent/10 border-accent/25",
  danger:  "text-danger-ink bg-danger-bg border-danger-ink/20",
  warning: "text-warning-ink bg-warning-bg border-warning/30",
  success: "text-success-ink bg-success-bg border-success/25",
  neutral: "text-muted bg-surface-2 border-line",
  // R-507 / R-511: teal is the shipping colour (Booked, On the way) and blue is the step a thing is on
  // (a quote asked or given). Both are meaning colours, so they hold under mono as well.
  shipping: "text-ship-ink bg-ship/10 border-ship/30",
  step:     "text-step-now bg-step-now/10 border-step-now/25",
};

interface StatusPillProps {
  children: ReactNode;
  tone?: Tone;
  /** Computed colour classes (e.g. invStatusCls(status)). Replaces `tone` when given. */
  className?: string;
  title?: string;
  /** `md` for a row a person reads at a glance (Logistics, 12.5px); `sm` is the default 11px. */
  size?: "sm" | "md";
}

// Computed classes rarely carry a border colour (invoice/quote status helpers are bg + text
// only), and a bare `border` then falls back to Tailwind's gray-200 - a white box around the
// pill in dark mode (R-405). So those get a transparent border. Only when they name none:
// `border-transparent` is emitted AFTER the theme colours and would erase leadStatusColor's.
export default function StatusPill({ children, tone = "neutral", className, title, size = "sm" }: StatusPillProps) {
  const cls = className
    ? (className.includes("border-") ? className : `border-transparent ${className}`)
    : TONES[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap flex-shrink-0 rounded border font-medium leading-none ${size === "md" ? "px-2.5 py-1 text-[12.5px]" : "px-2 py-0.5 text-[11px]"} ${cls}`}
    >
      {children}
    </span>
  );
}
