import type { ReactNode } from "react";
import type { ManifestAnalysis, ManifestPageInfo, ManifestSectionInfo, ManifestStated } from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import StatusPill from "../StatusPill";
import { fmtInt, S } from "./shared";

export type SectionChoice = "part" | "own" | "off";

const KIND: Record<ManifestPageInfo["kind"], string> = {
  lines: "Product lines", summary: "Summary", pricing: "Pricing", totals: "Totals", copy: "Copy of another page", empty: "Empty",
};

/** The sheet's own stated totals beside what was read from the lines. */
function statedLine(st: ManifestStated | null, units: number, retail: number): ReactNode {
  if (!st || (st.units == null && st.retail == null)) return null;
  const parts: string[] = [];
  if (st.units != null) parts.push(`${fmtInt(st.units)} units`);
  if (st.retail != null) parts.push(`${fmtAmount(st.retail)} retail`);
  const off = (st.units != null && Math.round(st.units) !== Math.round(units)) || (st.retail != null && Math.abs(st.retail - retail) > 1);
  return (
    <span className={off ? "text-warning-ink" : "text-muted"}>
      The sheet says {parts.join(" and ")}{st.source ? ` (${st.source})` : ""}; read {fmtInt(units)} units and {fmtAmount(retail)}.
    </span>
  );
}

function Seg({ value, onChange, disabled }: { value: SectionChoice; onChange: (v: SectionChoice) => void; disabled?: boolean }) {
  const opts: [SectionChoice, string][] = [["part", "Part of this manifest"], ["own", "Its own manifest"], ["off", "Leave out"]];
  return (
    <div className="inline-flex flex-nowrap rounded-lg border border-line-3 overflow-hidden shrink-0" role="group">
      {opts.map(([v, label], i) => (
        <button key={v} disabled={disabled} onClick={() => onChange(v)}
          className={`px-2.5 h-7 text-[11.5px] whitespace-nowrap disabled:opacity-50 ${i ? "border-l border-line-3" : ""} ${value === v ? "bg-accent/10 text-accent font-medium" : "text-ink-2 hover:bg-surface-2"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * One card per page of the workbook, and per section when a page holds several manifests one
 * under another. A sheet with one page and one section never shows this.
 */
export default function PagesSections({ analysis, choices, busy, onTogglePage, onChoice }: {
  analysis: ManifestAnalysis;
  choices: Record<string, SectionChoice>;
  busy: boolean;
  onTogglePage: (name: string) => void;
  onChoice: (key: string, v: SectionChoice) => void;
}) {
  const pages = analysis.pages || [];
  const sections = analysis.sections || [];
  if (pages.length <= 1 && sections.length <= 1) return null;
  const st = analysis.stated;
  return (
    <section id="mf-pages" className="space-y-2">
      <div>
        <p className={S.h2 + " mb-0.5"}>Pages and sections</p>
        <p className="text-[12px] text-muted max-w-[680px]">
          {pages.length > 1 ? "Tick the pages to read." : ""} {sections.some((s) => sections.filter((x) => x.page === s.page).length > 1) ? "Where one page holds several manifests, choose what each is." : ""}
        </p>
        {st && <p className="text-[12px] mt-1">{statedLine(st, analysis.total_quantity, analysis.total_retail)}</p>}
      </div>
      <div className="space-y-2">
        {pages.map((p) => {
          const secs = sections.filter((s) => s.page === p.name);
          return (
            <div key={p.name} className={`${S.card} ${p.read ? "" : "opacity-80"}`}>
              <div className="flex items-start justify-between gap-3">
                <label className="flex items-start gap-2 min-w-0 cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={p.read} disabled={busy} onChange={() => onTogglePage(p.name)} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink truncate">{p.name}</span>
                    <span className="block text-[11.5px] text-muted tabular-nums">{fmtInt(p.rows)} rows{p.same_header_as ? `, same headings as ${p.same_header_as}` : ""}</span>
                  </span>
                </label>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusPill tone={p.kind === "lines" ? "neutral" : p.kind === "copy" ? "warning" : "accent"}>{KIND[p.kind]}</StatusPill>
                  <StatusPill tone={p.read ? "success" : "neutral"}>{p.read ? "Read" : "Not read"}</StatusPill>
                </div>
              </div>
              {p.read && secs.length === 1 && (
                <p className="text-[11.5px] mt-1.5 tabular-nums">
                  {statedLine(secs[0].stated, secs[0].units, secs[0].retail) ?? <span className="text-muted">{fmtInt(secs[0].lines)} lines, {fmtInt(secs[0].units)} units, {fmtAmount(secs[0].retail)}.</span>}
                </p>
              )}
              {secs.length > 1 && (
                <ul className="mt-2 space-y-2">
                  {secs.map((s: ManifestSectionInfo) => (
                    <li key={s.key} className="border-t border-line pt-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-medium text-ink truncate">{s.name}</p>
                          <p className="text-[11.5px] text-muted tabular-nums">Rows {s.first_row} to {s.last_row}, {fmtInt(s.lines)} lines, {fmtInt(s.units)} units, {fmtAmount(s.retail)}</p>
                        </div>
                        <Seg value={choices[s.key] ?? "part"} disabled={busy || !p.read} onChange={(v) => onChoice(s.key, v)} />
                      </div>
                      {s.stated && <p className="text-[11.5px] mt-0.5 tabular-nums">{statedLine(s.stated, s.units, s.retail)}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
