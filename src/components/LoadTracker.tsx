import { Check } from "lucide-react";
import type { Stage, StageKey, StageState } from "../lib/loadProgress";

// R-464: where a load is in Jack's flow, as a picture. A horizontal track of numbered nodes with the
// words under them and a line between: done is green with a check, the current stage is blue with a ring
// and its word in bold, what is still to do is a grey outline, and a stage a load from before this flow
// passed without is dashed. The words come from `loadProgress`, so the website's tracker and this one say
// the same thing. Below about 760 px the track scrolls sideways inside itself; the page never does.

const NODE: Record<StageState, string> = {
  done: "bg-success text-surface",
  current: "bg-info/15 text-info-ink ring-2 ring-info",
  todo: "bg-surface border border-line-3 text-muted",
  skipped: "bg-surface border border-dashed border-line-3 text-faint",
};

const STATE_WORD: Record<StageState, string> = { done: "done", current: "current", todo: "to do", skipped: "skipped" };

/** The half of the connecting line on one side of a node: solid green once the stage before it is done, dashed
 *  next to a skipped stage, grey otherwise. */
function Half({ side, filled, dashed }: { side: "left" | "right"; filled: boolean; dashed: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute top-[13px] h-0 ${side === "left" ? "left-0 right-1/2" : "left-1/2 right-0"} ${
        dashed ? "border-t-2 border-dashed border-line-3" : filled ? "border-t-2 border-success/60" : "border-t-2 border-line"}`}
    />
  );
}

export function LoadTracker({ stages, onGo }: { stages: Stage[]; onGo: (key: StageKey) => void }) {
  return (
    <ol className="flex w-full overflow-x-auto px-2 py-3 list-none m-0" aria-label="Where this load is">
      {stages.map((s, i) => {
        const prev = stages[i - 1];
        return (
          <li key={s.key} className="relative flex-1 min-w-[92px] flex flex-col items-center">
            {i > 0 && <Half side="left" filled={prev?.state === "done"} dashed={s.state === "skipped" || prev?.state === "skipped"} />}
            {i < stages.length - 1 && <Half side="right" filled={s.state === "done"} dashed={s.state === "skipped" || stages[i + 1]?.state === "skipped"} />}
            <button
              type="button" onClick={() => onGo(s.key)}
              aria-current={s.state === "current" ? "step" : undefined}
              aria-label={`Stage ${i + 1}, ${s.label}, ${STATE_WORD[s.state]}${s.note ? `, ${s.note}` : ""}`}
              className="relative flex flex-col items-center gap-1.5 px-1 rounded-lg hover:bg-surface-2/70 transition-colors w-full"
            >
              <span className={`w-[27px] h-[27px] rounded-full flex items-center justify-center text-[11.5px] font-semibold tabular-nums ${NODE[s.state]}`}>
                {s.state === "done" ? <Check size={14} strokeWidth={2.8} /> : i + 1}
              </span>
              <span className={`text-[12px] leading-tight text-center whitespace-nowrap ${
                s.state === "current" ? "font-semibold text-ink" : s.state === "done" ? "text-ink-2" : s.state === "skipped" ? "text-faint" : "text-muted"}`}>
                {s.label}
              </span>
              {s.note && <span className="text-[11px] leading-tight text-muted text-center max-w-[120px]">{s.note}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const DOT: Record<StageState, string> = {
  done: "bg-success",
  current: "bg-info ring-2 ring-info/30",
  todo: "bg-surface border border-line-3",
  skipped: "bg-surface border border-dashed border-line-3",
};

/** The small one for a card on the deal's Shipping step: a dot per stage and only the current stage in words. */
export function LoadTrackerCompact({ stages }: { stages: Stage[] }) {
  const cur = stages.find((s) => s.state === "current");
  const n = stages.findIndex((s) => s.state === "current") + 1;
  const word = cur ? [cur.label, cur.note].filter(Boolean).join(", ") : "All done";
  return (
    <div className="flex items-center gap-1.5 min-w-0" role="img" aria-label={cur ? `Stage ${n} of ${stages.length}: ${word}` : "All stages done"}>
      <div className="flex items-center flex-shrink-0">
        {stages.map((s, i) => (
          <span key={s.key} className="flex items-center">
            {i > 0 && <span className={`w-2.5 h-0 border-t-2 ${s.state === "skipped" || stages[i - 1].state === "skipped" ? "border-dashed border-line-3" : stages[i - 1].state === "done" ? "border-success/60" : "border-line"}`} />}
            <span className={`w-2.5 h-2.5 rounded-full ${DOT[s.state]}`} />
          </span>
        ))}
      </div>
      <span className="text-[11.5px] font-medium text-ink-2 truncate min-w-0">{word}</span>
    </div>
  );
}
