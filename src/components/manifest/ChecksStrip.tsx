import type { ManifestCheck } from "../../lib/api";
import StatusPill from "../StatusPill";

const FIX_LABEL: Record<ManifestCheck["fix"], string> = {
  columns: "Fix the columns", lines: "See the lines", pages: "See the pages", none: "",
};

/** What the reader noticed, worst first, each with the place to put it right. Nothing here is saved or hidden. */
export default function ChecksStrip({ checks, onFix }: { checks: ManifestCheck[]; onFix: (c: ManifestCheck) => void }) {
  if (!checks.length) return null;
  const sorted = [...checks].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
  return (
    <section className="space-y-1.5" aria-label="Checks">
      {sorted.map((c, i) => (
        <div key={`${c.code}-${i}`}
          className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3.5 py-2.5 border ${c.severity === "red" ? "bg-danger-bg border-danger-ink/20" : "bg-warning-bg border-warning/30"}`}>
          <StatusPill tone={c.severity === "red" ? "danger" : "warning"}>{c.severity === "red" ? "Fix before saving" : "Check"}</StatusPill>
          <p className={`text-[12.5px] flex-1 min-w-[220px] ${c.severity === "red" ? "text-danger-ink" : "text-warning-ink"}`}>{c.text}</p>
          {c.fix !== "none" && (
            <button onClick={() => onFix(c)}
              className="text-[12px] font-medium text-ink-2 border border-line-3 bg-surface hover:border-accent hover:text-accent px-3 h-7 rounded-lg transition-colors">
              {FIX_LABEL[c.fix]}{c.fix === "lines" && c.rows.length ? ` (${c.rows.length})` : ""}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
