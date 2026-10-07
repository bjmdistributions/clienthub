import type { ReactNode } from "react";
import { Check } from "lucide-react";

// The numbered step bar Deal Flow and the load page share: a dot per step, filled with a tick once
// the step is done, the open one lit, every step one click away. It owns only the strip itself. What
// a screen puts after the last step (Deal Flow's Refund button) goes in as children.

export interface StepBarProps<K extends string> {
  steps: readonly { key: K; label: string }[];
  current: K | string;
  done: Partial<Record<K, boolean>>;
  /** The step that just finished: its dot pops. */
  flash?: K | string | null;
  onGo: (k: K) => void;
  /** "responsive" (Deal Flow, beside a 216px sidebar): a step that is not open keeps its number and
   *  loses the word until xl. "always" (the load drawer): every step keeps its word. */
  labels?: "responsive" | "always";
  /** Tighter buttons, for a bar that sits in a narrow drawer. */
  compact?: boolean;
  children?: ReactNode;
}

export default function StepBar<K extends string>({ steps, current, done, flash, onGo, labels = "responsive", compact, children }: StepBarProps<K>) {
  return (
    <div className={`flex items-center py-3 overflow-x-auto ${compact ? "px-3" : "px-4"}`}>
      {steps.map((s, i) => {
        const isCur = s.key === current;
        const isDone = !!done[s.key];
        return (
          <div key={s.key} className="flex items-center flex-shrink-0">
            <button
              type="button"
              onClick={() => onGo(s.key)}
              title={s.label}
              aria-label={s.label}
              className={`flex items-center h-9 rounded-lg text-[12px] font-semibold transition-all ${compact ? "gap-1.5 px-2" : "gap-2 px-3"} ${
                isCur ? "bg-accent/10 text-accent ring-1 ring-accent/25" : isDone ? "text-ink-2 hover:bg-surface-3" : "text-muted hover:bg-surface-3"
              }`}
            >
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${flash === s.key ? "df-pop " : ""}${
                isDone ? "bg-accent text-on-accent" : isCur ? "bg-accent/15 text-accent ring-1 ring-accent/40" : "bg-surface-3 text-faint"
              }`}>
                {isDone ? <Check size={13} strokeWidth={2.6} /> : i + 1}
              </span>
              {/* R-400: six steps no longer fit a card beside a 216px sidebar below 1280px, so the
                  steps that are not open keep their number and lose the word until there is room. */}
              <span className={`${labels === "always" ? "" : isCur ? "hidden sm:block" : "hidden xl:block"} whitespace-nowrap`}>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <div className={`h-[2px] mx-0.5 rounded-full flex-shrink-0 ${compact ? "w-2" : "w-4"} ${isDone ? "bg-accent/50" : "bg-surface-3"}`} />
            )}
          </div>
        );
      })}
      {children}
    </div>
  );
}
