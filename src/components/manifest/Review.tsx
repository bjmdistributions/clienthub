import { useEffect, useMemo, useState } from "react";
import { api, ManifestAnalysis, ManifestProduct, ManifestReviewGroup, ManifestRule } from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import { fmtInt, isUnplaced, S } from "./shared";

const SHOWN = 12;

/** Whether a line belongs to a review group, by the word, phrase or UPC prefix the group is named for. */
const inGroup = (l: { title: string; code: string }, g: ManifestReviewGroup): boolean => {
  if (g.kind === "upc_prefix") return !!g.pattern && l.code.startsWith(g.pattern);
  if (g.kind === "sheet_category" || !g.pattern) return false;
  const esc = g.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(l.title);
};

/**
 * The step before saving. Lines the sheet did not categorise, and brands the reader does not
 * know, are grouped by what they share. One answer per group is saved as a rule, so the same
 * word, brand or UPC is placed on its own on the next manifest. Nothing is placed on a guess:
 * a suggestion stays a suggestion until the answer is applied.
 */
export default function Review({ analysis, busy, onApply }: {
  analysis: ManifestAnalysis;
  busy: boolean;
  onApply: (rules: ManifestRule[]) => Promise<void>;
}) {
  const groups = analysis.review?.groups || [];
  const brands = analysis.review?.brands || [];
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [orgCats, setOrgCats] = useState<string[]>([]);
  const [all, setAll] = useState({ cat: false, brand: false, rest: false });
  useEffect(() => { api.listCategories().then((cs) => setOrgCats(cs.map((c) => c.label).filter(Boolean))).catch(() => {}); }, []);

  const options = useMemo(() => {
    const seen = new Set<string>(), out: string[] = [];
    for (const n of [...(analysis.review?.category_names || []), ...orgCats, ...analysis.categories.map((c) => c.name)]) {
      const k = n.trim().toLowerCase();
      if (!k || isUnplaced(k) || seen.has(k)) continue;
      seen.add(k); out.push(n.trim());
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [analysis, orgCats]);

  // A group whose lines carry different suggestions is shown as one row per suggestion, so no
  // single prefill is applied to lines it does not fit.
  const catGroups = useMemo(() => {
    const out: { g: ManifestReviewGroup; split: boolean }[] = [];
    for (const g of groups) {
      if (g.suggested) { out.push({ g, split: false }); continue; }
      const mine = analysis.lines.filter((l) => l.placed === "list" && !isUnplaced(l.category) && inGroup(l, g));
      const cats = new Map<string, typeof mine>();
      for (const l of mine) cats.set(l.category, [...(cats.get(l.category) || []), l]);
      if (cats.size < 2) { out.push({ g, split: false }); continue; }
      for (const [cat, ls] of cats) {
        out.push({
          split: true,
          g: {
            ...g, key: `${g.key}|${cat}`, label: `${g.label} (${cat})`, suggested: cat,
            lines: ls.length, units: ls.reduce((n, l) => n + l.qty, 0), retail: ls.reduce((n, l) => n + l.retail, 0),
            // Each title in the row is placed by its own phrase rule; one word cannot mean two categories.
            pattern: JSON.stringify([...new Set(ls.map((l) => l.title))]),
          },
        });
      }
    }
    return out;
  }, [groups, analysis.lines]);

  // Unplaced products no group covers: the guard for a reader that gave no groups.
  const rest = useMemo(
    () => (groups.length ? [] : (analysis.products || []).filter((p) => p.placed === "none" || isUnplaced(p.category))),
    [groups.length, analysis.products]);

  if (!groups.length && !brands.length && !rest.length) return null;

  const pickOf = (g: ManifestReviewGroup, kind: "cat" | "brand") => picks[`${kind}:${g.key}`] ?? g.suggested ?? "";
  const rulesOf = (g: ManifestReviewGroup, kind: "cat" | "brand"): ManifestRule[] => {
    const v = pickOf(g, kind).trim();
    if (!v) return [];
    if (kind === "brand") return [{ id: "", kind: "brand_word", pattern: g.pattern, category: null, brand: v }];
    if (g.key.includes("|") && g.pattern.startsWith("[")) {
      try { return (JSON.parse(g.pattern) as string[]).map((t) => ({ id: "", kind: "phrase" as const, pattern: t, category: v, brand: null })); } catch { return []; }
    }
    return [{ id: "", kind: g.kind, pattern: g.pattern, category: v, brand: null }];
  };
  const filled = [
    ...catGroups.flatMap(({ g }) => rulesOf(g, "cat")), ...brands.flatMap((g) => rulesOf(g, "brand")),
  ];
  const restRule = (p: ManifestProduct): ManifestRule | null => {
    const v = (picks[`rest:${p.key}`] ?? "").trim();
    return v ? { id: "", kind: "phrase", pattern: p.title, category: v, brand: null } : null;
  };

  const row = (g: ManifestReviewGroup, kind: "cat" | "brand") => (
    <li key={`${kind}:${g.key}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2 border-t border-line first:border-t-0">
      <div className="min-w-[200px] flex-1">
        <p className="text-[13px] font-medium text-ink">{g.label}</p>
        <p className="text-[11.5px] text-muted tabular-nums">
          {fmtInt(g.lines)} line{g.lines === 1 ? "" : "s"}, {fmtInt(g.units)} units{g.retail > 0 ? `, ${fmtAmount(g.retail)} retail` : ""}
        </p>
      </div>
      <input className={`${S.input} w-52`} list={kind === "cat" ? "mf-cat-options" : undefined}
        value={pickOf(g, kind)} placeholder={kind === "cat" ? "Pick or type a category" : "Type the brand"}
        onChange={(e) => setPicks({ ...picks, [`${kind}:${g.key}`]: e.target.value })} />
      {g.suggested && !(`${kind}:${g.key}` in picks) && (
        <span className="text-[11.5px] text-muted">Suggested</span>
      )}
      <button disabled={busy || !pickOf(g, kind).trim()} onClick={() => { const r = rulesOf(g, kind); if (r.length) onApply(r); }}
        className={S.btn}>
        Apply to all {fmtInt(g.lines)} line{g.lines === 1 ? "" : "s"}
      </button>
    </li>
  );

  const block = (title: string, hint: string, list: ManifestReviewGroup[], kind: "cat" | "brand") => {
    if (!list.length) return null;
    const open = all[kind];
    const shown = open ? list : list.slice(0, SHOWN);
    return (
      <div>
        <p className="text-[12.5px] font-medium text-ink">{title} <span className="text-[11.5px] font-normal text-muted tabular-nums">{fmtInt(list.length)}</span></p>
        <p className="text-[11.5px] text-muted mb-1">{hint}</p>
        <ul>{shown.map((g) => row(g, kind))}</ul>
        {list.length > SHOWN && (
          <button onClick={() => setAll({ ...all, [kind]: !open })} className="mt-1 text-[12px] text-ink-2 hover:text-accent">
            {open ? "Show fewer" : `Show all ${fmtInt(list.length)}`}
          </button>
        )}
      </div>
    );
  };

  return (
    <section id="mf-review" className={`${S.card} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={S.h2 + " mb-0.5"}>Review before saving</p>
          <p className="text-[12.5px] text-ink-2 max-w-[680px]">
            These could not be placed from the sheet. Your answer is remembered as a rule, so the next manifest with the same words is placed on its own.
          </p>
        </div>
        {filled.length > 1 && (
          <button disabled={busy} onClick={() => onApply(filled)} className={S.btnPrimary}>
            Apply all {fmtInt(filled.length)} as shown
          </button>
        )}
      </div>
      <datalist id="mf-cat-options">{options.map((o) => <option key={o} value={o} />)}</datalist>
      {block("Which category are these?", "Grouped by the word, model or UPC they share.", catGroups.map((x) => x.g), "cat")}
      {rest.length > 0 && (
        <div>
          <p className="text-[12.5px] font-medium text-ink">Place the rest <span className="text-[11.5px] font-normal text-muted tabular-nums">{fmtInt(rest.length)}</span></p>
          <p className="text-[11.5px] text-muted mb-1">These products have no category yet. Each answer is remembered for that exact title.</p>
          <ul>
            {(all.rest ? rest : rest.slice(0, SHOWN)).map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-2 border-t border-line first:border-t-0">
                <div className="min-w-[200px] flex-1">
                  <p className="text-[13px] font-medium text-ink truncate max-w-[420px]" title={p.title}>{p.title}</p>
                  <p className="text-[11.5px] text-muted tabular-nums">{fmtInt(p.qty)} units{p.retail > 0 ? `, ${fmtAmount(p.retail)} retail` : ""}</p>
                </div>
                <input className={`${S.input} w-52`} list="mf-cat-options" value={picks[`rest:${p.key}`] ?? ""} placeholder="Pick or type a category"
                  onChange={(e) => setPicks({ ...picks, [`rest:${p.key}`]: e.target.value })} />
                <button disabled={busy || !restRule(p)} onClick={() => { const r = restRule(p); if (r) onApply([r]); }} className={S.btn}>Place it</button>
              </li>
            ))}
          </ul>
          {rest.length > SHOWN && (
            <button onClick={() => setAll({ ...all, rest: !all.rest })} className="mt-1 text-[12px] text-ink-2 hover:text-accent">
              {all.rest ? "Show fewer" : `Show all ${fmtInt(rest.length)}`}
            </button>
          )}
        </div>
      )}
      {block("Which brand is this?", "The brand is never taken from the first word of a title.", brands, "brand")}
    </section>
  );
}
