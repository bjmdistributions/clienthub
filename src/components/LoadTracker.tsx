import { Check } from "lucide-react";
import type { Stage, StageKey, StageState } from "../lib/loadProgress";

// R-464: where a load is in Jack's flow, as a picture. R-583: a row of segments, one per stage, a 4px bar on top
// (light when done, ink for the current stage, faint while to do, dashed for a stage a load from before this flow
// passed without), then the number and the word under it, and a short note. The words come from `loadProgress`, so
// the website's tracker and this one say the same thing. Below about 760 px the row scrolls sideways inside itself;
// the page never does.

const STATE_WORD: Record<StageState, string> = { done: "done", current: "current", todo: "to do", skipped: "skipped" };

const BAR: Record<StageState, string> = {
  done: "bg-ink-2",
  current: "bg-ink",
  todo: "bg-surface-3",
  skipped: "bg-transparent border-t-2 border-dashed border-line-3",
};

const WORD: Record<StageState, string> = {
  done: "text-muted",
  current: "text-ink font-medium",
  todo: "text-faint",
  skipped: "text-faint",
};

export function LoadTracker({ stages, onGo }: { stages: Stage[]; onGo: (key: StageKey) => void }) {
  return (
    <ol className="flex gap-1.5 w-full overflow-x-auto list-none m-0 p-0" aria-label="Where this load is">
      {stages.map((s, i) => (
        <li key={s.key} className="flex-1 min-w-[98px]">
          <button
            type="button" onClick={() => onGo(s.key)}
            aria-current={s.state === "current" ? "step" : undefined}
            aria-label={`Stage ${i + 1}, ${s.label}, ${STATE_WORD[s.state]}${s.note ? `, ${s.note}` : ""}`}
            className="w-full text-left flex flex-col gap-[7px] rounded-lg px-1.5 pt-2.5 pb-2 transition-colors duration-[130ms] hover:bg-surface-2"
          >
            <span className={`block w-full rounded-sm transition-colors duration-200 ${s.state === "skipped" ? "h-0" : "h-1"} ${BAR[s.state]}`} />
            <span className={`flex items-center gap-1.5 text-[14px] ${WORD[s.state]}`}>
              {s.state === "done" && <Check size={14} className="flex-shrink-0" />}
              <span className="text-muted tabular-nums font-normal">{i + 1}</span>
              {s.label}
            </span>
            {s.note && <span className="text-[12px] leading-[1.3] text-muted">{s.note}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The small one for a card on the deal's Shipping step: a segment per stage and only the current stage in words. */
export function LoadTrackerCompact({ stages }: { stages: Stage[] }) {
  const cur = stages.find((s) => s.state === "current");
  const n = stages.findIndex((s) => s.state === "current") + 1;
  const word = cur ? [cur.label, cur.note].filter(Boolean).join(", ") : "All done";
  return (
    <div className="flex items-center gap-2 min-w-0" role="img" aria-label={cur ? `Stage ${n} of ${stages.length}: ${word}` : "All stages done"}>
      <div className="flex items-center gap-[3px] flex-shrink-0">
        {stages.map((s) => (
          <span key={s.key} className={`block w-3.5 rounded-sm ${s.state === "skipped" ? "h-0 border-t-2 border-dashed border-line-3" : "h-[3px]"} ${s.state === "skipped" ? "" : BAR[s.state]}`} />
        ))}
      </div>
      <span className="text-[12px] font-medium text-ink-2 truncate min-w-0">{word}</span>
    </div>
  );
}
