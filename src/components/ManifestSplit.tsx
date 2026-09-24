import { useEffect, useMemo, useRef, useState } from "react";
import { api, SplitEdits, SplitLine, SplitPlan, SplitPriceRule } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import { ChevronDown, ChevronRight, FolderDown, Image as ImageIcon, PackagePlus } from "lucide-react";

/**
 * R-379: split one manifest into several, by brand or category, each written as its own
 * Excel file with the source's photos and each able to become its own lot.
 *
 * Every figure here comes from Rust (`manifest_split.rs`): this screen only holds Jack's
 * answers and edits and asks for the plan again whenever one changes. There is no AI in
 * it (Jack, 2026-09-24): the questions are rules, each with a suggested answer.
 */

const MODES: { id: SplitPriceRule["mode"]; label: string }[] = [
  { id: "pct", label: "% of retail" },
  { id: "unit", label: "Per unit" },
  { id: "sheet", label: "Sheet's price" },
  { id: "none", label: "No price" },
];

const ROLE: Record<string, string> = {
  description: "description",
  quantity: "quantity",
  retail: "retail",
  retail_total: "retail total",
  sheet_price: "sheet price",
  sheet_total: "sheet total",
  sheet_pct: "sheet %",
  category: "category",
  brand: "brand",
  photo_links: "photo links",
  internal: "reads like your cost",
};

const units = (n: number) => Math.round(n || 0).toLocaleString();

export default function ManifestSplit({ path, onNavigate }: { path: string; onNavigate: (t: any) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<SplitEdits>({});
  const [plan, setPlan] = useState<SplitPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState<"files" | "lots" | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [lineQuery, setLineQuery] = useState("");
  const [lineLimit, setLineLimit] = useState(100);
  const seq = useRef(0);
  // Every split name seen, so a combined split (gone from the plan) can still be named
  // in the list of combines that undoes it.
  const seen = useRef<Record<string, string>>({});
  if (plan) for (const s of plan.splits) seen.current[s.key] = s.name;

  // A new file starts from nothing.
  useEffect(() => { setAnswers({}); setEdits({}); setOpenKey(null); setPlan(null); }, [path]);

  // Ask for the plan again whenever an answer or an edit changes. Typing in a price
  // box changes edits on every keystroke, so this waits a moment, and a slow answer
  // that arrives after a newer one is dropped.
  useEffect(() => {
    const id = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const p = await api.manifestSplitPlan(path, answers, edits);
        if (id !== seq.current) return;
        setPlan(p); setError(null);
      } catch (e: any) {
        if (id === seq.current) setError(String(e));
      }
      if (id === seq.current) setBusy(false);
    }, plan ? 180 : 0);
    return () => clearTimeout(t);
  }, [path, answers, edits]);

  // The open split's lines follow the plan.
  useEffect(() => {
    if (!openKey || !plan) return;
    if (!plan.splits.some((s) => s.key === openKey)) { setOpenKey(null); return; }
    let live = true;
    api.manifestSplitLines(path, answers, edits, openKey).then((l) => { if (live) setLines(l); }).catch(() => {});
    return () => { live = false; };
  }, [plan, openKey]);

  const answer = (id: string, value: string) => {
    setAnswers((a) => ({ ...a, [id]: value }));
    // A different pricing choice means a different number: 30 was a %, not $30 a unit.
    const q = plan?.questions.find((x) => x.id === id);
    if (q && q.answer !== value && q.choices.some((c) => c.input)) {
      setAnswers((a) => { const n = { ...a }; delete n[`${id}_value`]; return n; });
    }
    // Another sheet is another set of rows: line prices and combines no longer apply.
    if (id === "sheet") { setEdits({}); setOpenKey(null); }
  };
  const edit = (fn: (e: SplitEdits) => SplitEdits) => setEdits((e) => fn({ ...e }));

  const setRule = (key: string, rule: SplitPriceRule) =>
    edit((e) => ({ ...e, pricing: { ...(e.pricing || {}), [key]: rule } }));
  const rename = (key: string, name: string) =>
    edit((e) => ({ ...e, names: { ...(e.names || {}), [key]: name } }));
  const combine = (key: string, into: string) =>
    edit((e) => {
      const c = { ...(e.combine || {}) };
      if (into) c[key] = into; else delete c[key];
      return { ...e, combine: c };
    });
  const toggleSkip = (key: string) =>
    edit((e) => {
      const s = new Set(e.skip || []);
      if (s.has(key)) s.delete(key); else s.add(key);
      return { ...e, skip: [...s] };
    });
  // A cost-like column starts left out, so clicking it puts it back (show_cols); any
  // other column starts in, so clicking it leaves it out (hidden_cols).
  const toggleCol = (index: number, internal: boolean) =>
    edit((e) => {
      const field = internal ? "show_cols" : "hidden_cols";
      const s = new Set(e[field] || []);
      if (s.has(index)) s.delete(index); else s.add(index);
      return { ...e, [field]: [...s] };
    });
  const linePrice = (row: number, raw: string, n: number) =>
    edit((e) => {
      const lp = { ...(e.line_prices || {}) };
      if (raw.trim() === "") delete lp[String(row)]; else lp[String(row)] = n;
      return { ...e, line_prices: lp };
    });

  const live = plan ? plan.splits.filter((s) => !s.skipped) : [];
  const splitBy = plan?.questions.find((q) => q.id === "split_by")?.answer;
  const shownLines = useMemo(() => {
    const q = lineQuery.trim().toLowerCase();
    return q ? lines.filter((l) => l.desc.toLowerCase().includes(q)) : lines;
  }, [lines, lineQuery]);

  const saveFiles = async () => {
    const folder = await openDialog({ directory: true, multiple: false, title: "Choose a folder for the new manifests" });
    if (typeof folder !== "string") return;
    setWriting("files");
    try {
      const out = await api.manifestSplitExport(path, answers, edits, folder);
      toast(`Saved ${out.length} manifest${out.length === 1 ? "" : "s"} to ${folder}.`);
    } catch (e: any) { toast(String(e), "error"); }
    setWriting(null);
  };

  const sendToInventory = async () => {
    setWriting("lots");
    try {
      const out = await api.manifestSplitExport(path, answers, edits, null);
      const lots = out.map((x) => ({
        name: x.name,
        quantity: Math.round(x.units) || x.lines || 1,
        total_cost: x.cost ?? 0,
        asking_price: x.price ?? 0,
        price_type: "total",
        category: splitBy === "category" ? x.name : undefined,
        // Public-safe summary, the same shape the single-lot handoff sends.
        manifest: { units: Math.round(x.units) || x.lines, lines: x.lines, categories: x.categories },
        manifest_file: x.file,
        photo_paths: x.photos,
      }));
      // Inventory is not mounted until the tab switch, so it picks this up from here.
      sessionStorage.setItem("inventory_prefill_lot", JSON.stringify({ lots }));
      window.dispatchEvent(new CustomEvent("inventory-prefill-lot", { detail: { lots } }));
      onNavigate("inventory");
    } catch (e: any) { toast(String(e), "error"); }
    setWriting(null);
  };

  if (!plan) {
    return (
      <div className="mt-6 pt-5 border-t border-line">
        <h2 className="text-[15px] font-semibold text-ink">Split this manifest</h2>
        <p className={`text-[12.5px] mt-1 ${error ? "text-danger-ink" : "text-muted"}`}>{error ?? "Reading the manifest…"}</p>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-5 border-t border-line">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">Split this manifest</h2>
          <p className="text-[12.5px] text-muted mt-1 max-w-[620px]">
            One new manifest per brand or category, with every column and photo of its own lines. Answer what you know;
            anything you leave uses the suggested answer.
          </p>
        </div>
        {busy && <span className="text-[11.5px] text-muted shrink-0 mt-1">Updating…</span>}
      </div>
      {error && <p className="text-[12px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2 mt-3">{error}</p>}

      <div className="space-y-2 mt-4">
        {plan.questions.map((q) => (
          <div key={q.id} className="bg-surface-2 rounded-lg px-3.5 py-3">
            <p className="text-[13px] text-ink">{q.text}</p>
            {q.detail && <p className="text-[11.5px] text-muted mt-0.5">{q.detail}</p>}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {q.choices.map((c) => {
                const on = q.answer === c.id;
                return (
                  <span key={c.id} className="inline-flex items-center gap-1.5">
                    <button onClick={() => answer(q.id, c.id)}
                      className={`h-8 px-3 rounded-lg text-[12px] border transition-colors duration-[130ms] ${
                        on ? "border-accent text-accent bg-accent/10 font-medium" : "border-line-3 text-ink-2 hover:border-accent hover:text-accent"
                      }`}>
                      {c.label}
                    </button>
                    {on && c.input && (
                      <span className="inline-flex items-center gap-1">
                        {c.input === "money" && <span className="text-[12px] text-muted">$</span>}
                        <NumberInput value={answers[`${q.id}_value`] ?? (q.value ?? "")}
                          onValue={(_, raw) => answer(`${q.id}_value`, raw)}
                          placeholder={c.input === "pct" ? "12" : "4.50"}
                          className="w-20 h-8 px-2 rounded-lg border border-line-3 bg-surface text-[12px] text-ink tabular-nums focus:border-accent outline-none" />
                        {c.input === "pct" && <span className="text-[12px] text-muted">% of retail</span>}
                      </span>
                    )}
                  </span>
                );
              })}
              {!q.answered && <span className="text-[11px] text-muted ml-1">Suggested</span>}
            </div>
          </div>
        ))}
      </div>

      {plan.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {plan.notes.map((n, i) => (
            <li key={i} className="text-[11.5px] text-muted leading-relaxed flex gap-1.5">
              {n.startsWith("Found") ? <ImageIcon size={12} className="shrink-0 mt-[3px] text-ink-2" /> : null}
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <p className="text-[12px] font-semibold text-ink-2">Columns in the new manifests</p>
        <p className="text-[11px] text-muted mt-0.5">
          Read from {plan.sheet ? `the ${plan.sheet} sheet, ` : ""}{plan.header_row > 0 ? `header on row ${plan.header_row}` : "a file with no header row"}. Click a column to leave it out.
        </p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {plan.columns.map((c) => {
            const fixed = c.role === "description";
            const priceCol = c.role.startsWith("sheet_") && !plan.show_price;
            return (
              <button key={c.index} disabled={fixed || priceCol} onClick={() => toggleCol(c.index, c.role === "internal")}
                title={priceCol ? "Left out because the files carry no price" : fixed ? "Every manifest keeps its description" : undefined}
                className={`h-7 px-2.5 rounded-md border text-[11.5px] transition-colors duration-[130ms] ${
                  c.hidden || priceCol ? "border-line text-muted line-through" : "border-line-3 text-ink-2 hover:border-accent"
                } disabled:cursor-default`}>
                {c.header}{ROLE[c.role] ? <span className="text-muted no-underline"> ({ROLE[c.role]})</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-x-auto mt-5">
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2">
            <tr>
              <th className="text-left px-2.5 py-2 font-medium text-muted rounded-l-lg">Manifest</th>
              <th className="text-right px-2.5 py-2 font-medium text-muted">Lines</th>
              <th className="text-right px-2.5 py-2 font-medium text-muted">Units</th>
              <th className="text-right px-2.5 py-2 font-medium text-muted">Retail</th>
              <th className="text-left px-2.5 py-2 font-medium text-muted">Price</th>
              <th className="text-right px-2.5 py-2 font-medium text-muted rounded-r-lg">Total</th>
            </tr>
          </thead>
          <tbody>
            {plan.splits.map((s) => {
              const open = openKey === s.key;
              const others = plan.splits.filter((o) => o.key !== s.key && !(edits.combine || {})[o.key]);
              return [
                <tr key={s.key} className={`border-t border-line align-top ${s.skipped ? "opacity-50" : ""}`}>
                  <td className="px-2.5 py-2 min-w-[180px]">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setOpenKey(open ? null : s.key); setLines([]); setLineQuery(""); setLineLimit(100); }}
                        className="w-6 h-6 flex items-center justify-center rounded text-muted hover:text-ink-2 hover:bg-surface-2" title="Lines">
                        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <input value={(edits.names || {})[s.key] ?? s.name} onChange={(e) => rename(s.key, e.target.value)}
                        className="flex-1 min-w-0 h-7 px-2 rounded-md border border-transparent hover:border-line-3 focus:border-accent bg-transparent text-[12.5px] font-medium text-ink-2 outline-none" />
                    </div>
                    {s.examples.length > 0 && <p className="text-[11px] text-muted mt-0.5 ml-7 line-clamp-1 max-w-[340px]">{s.examples.join(", ")}</p>}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 ml-7">
                      <select value="" onChange={(e) => combine(s.key, e.target.value)}
                        className="h-6 text-[11px] text-muted bg-transparent border border-line rounded px-1 hover:border-line-3 max-w-[160px]">
                        <option value="">Combine with…</option>
                        {others.map((o) => <option key={o.key} value={o.key}>{(edits.names || {})[o.key] ?? o.name}</option>)}
                      </select>
                      <button onClick={() => toggleSkip(s.key)} className="text-[11px] text-muted hover:text-ink-2">
                        {s.skipped ? "Include" : "Leave out"}
                      </button>
                      <span className="text-[11px] text-muted inline-flex items-center gap-1">
                        <ImageIcon size={11} /> {s.photos.toLocaleString()} photo{s.photos === 1 ? "" : "s"}
                      </span>
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-muted">{s.lines.toLocaleString()}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-ink-2">{units(s.units)}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{fmtAmount(s.retail)}</td>
                  <td className="px-2.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <select value={s.rule.mode} onChange={(e) => setRule(s.key, { mode: e.target.value as SplitPriceRule["mode"], value: null })}
                        className="h-7 text-[12px] bg-surface border border-line-3 rounded-md px-1.5 text-ink-2">
                        {MODES.filter((m) => m.id !== "sheet" || plan.sheet_pricing.total != null).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                      {(s.rule.mode === "pct" || s.rule.mode === "unit") && (
                        <NumberInput value={s.rule.value ?? ""} onValue={(n, raw) => setRule(s.key, { mode: s.rule.mode, value: raw.trim() === "" ? null : n })}
                          placeholder={s.rule.mode === "pct" ? "%" : "$"}
                          className="w-16 h-7 px-2 rounded-md border border-line-3 bg-surface text-[12px] text-ink tabular-nums focus:border-accent outline-none" />
                      )}
                    </div>
                    {s.sheet_price != null && <p className="text-[11px] text-muted mt-1">Sheet: {fmtAmount(s.sheet_price)}</p>}
                    {s.unpriced > 0 && (
                      <p className="text-[11px] text-warning-ink mt-1">
                        {s.unpriced === s.lines ? "No line has a price yet" : `${s.unpriced.toLocaleString()} line${s.unpriced === 1 ? " has" : "s have"} no price, so the total leaves ${s.unpriced === 1 ? "it" : "them"} out`}
                      </p>
                    )}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums font-medium">{s.price != null ? fmtAmount(s.price) : <span className="text-muted">None</span>}</td>
                </tr>,
                open && (
                  <tr key={`${s.key}-lines`} className="bg-surface-2/60">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <input value={lineQuery} onChange={(e) => { setLineQuery(e.target.value); setLineLimit(100); }} placeholder="Search these lines"
                          className="h-8 px-2.5 rounded-lg border border-line-3 bg-surface text-[12px] w-64 max-w-full outline-none focus:border-accent" />
                        <p className="text-[11px] text-muted">Type a unit price on a line to set it by hand. Clear it to go back to the rule.</p>
                      </div>
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="text-muted">
                            <th className="text-left font-medium py-1">Description</th>
                            <th className="text-right font-medium py-1 px-2">Qty</th>
                            <th className="text-right font-medium py-1 px-2">Retail</th>
                            {plan.sheet_pricing.total != null && <th className="text-right font-medium py-1 px-2">Sheet</th>}
                            <th className="text-right font-medium py-1 px-2">Unit price</th>
                            <th className="text-right font-medium py-1 pl-2">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shownLines.slice(0, lineLimit).map((l) => (
                            <tr key={l.row} className="border-t border-line">
                              <td className="py-1.5 pr-2 text-ink-2">
                                <span className="inline-flex items-center gap-1.5">
                                  {l.photo && <ImageIcon size={11} className="text-muted shrink-0" />}
                                  <span className="line-clamp-1">{l.desc}</span>
                                </span>
                              </td>
                              <td className="py-1.5 px-2 text-right tabular-nums">{units(l.qty)}</td>
                              <td className="py-1.5 px-2 text-right tabular-nums">{fmtAmount(l.retail)}</td>
                              {plan.sheet_pricing.total != null && <td className="py-1.5 px-2 text-right tabular-nums text-muted">{l.sheet != null ? fmtAmount(l.sheet) : ""}</td>}
                              <td className="py-1 px-2 text-right">
                                <NumberInput value={l.edited ? l.unit ?? "" : ""} onValue={(n, raw) => linePrice(l.row, raw, n)}
                                  placeholder={l.unit != null ? l.unit.toFixed(2) : ""}
                                  className={`w-20 h-7 px-2 rounded-md border bg-surface text-[12px] text-right tabular-nums outline-none focus:border-accent ${l.edited ? "border-accent text-ink" : "border-line-3 text-ink-2"}`} />
                              </td>
                              <td className="py-1.5 pl-2 text-right tabular-nums font-medium">{l.total != null ? fmtAmount(l.total) : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {shownLines.length > lineLimit && (
                        <button onClick={() => setLineLimit((n) => n + 100)} className="mt-2 text-[12px] text-ink-2 hover:text-accent">
                          Show {Math.min(100, shownLines.length - lineLimit)} more of {shownLines.length.toLocaleString()}
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      {Object.keys(edits.combine || {}).length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3">
          {Object.entries(edits.combine || {}).map(([from, into]) => (
            <span key={from} className="text-[11.5px] text-muted inline-flex items-center gap-1.5">
              {seen.current[from] ?? from} is in {(edits.names || {})[into] ?? seen.current[into] ?? into}
              <button onClick={() => combine(from, "")} className="text-ink-2 hover:text-accent">Undo</button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-line flex flex-wrap items-center justify-between gap-3">
        <p className={`text-[12px] ${plan.reconciles ? "text-muted" : "text-danger-ink"}`}>
          {live.length} manifest{live.length === 1 ? "" : "s"} from {plan.totals.lines.toLocaleString()} lines, {units(plan.totals.units)} units
          and {fmtAmount(plan.totals.retail)} retail{plan.totals.price != null ? `, priced at ${fmtAmount(plan.totals.price)}` : ""}.
          {plan.reconciles ? " Every line is in exactly one, and they add back up to the whole." : " They do not add back up to the whole, so nothing can be written."}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={sendToInventory} disabled={!!writing || !plan.reconciles || live.length === 0}
            className="text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3.5 h-9 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5 transition-colors duration-[130ms] disabled:opacity-50">
            <PackagePlus size={14} /> {writing === "lots" ? "Preparing…" : `Send to inventory as ${live.length} lot${live.length === 1 ? "" : "s"}`}
          </button>
          <button onClick={saveFiles} disabled={!!writing || !plan.reconciles || live.length === 0}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50">
            <FolderDown size={14} /> {writing === "files" ? "Saving…" : "Save the files"}
          </button>
        </div>
      </div>
    </div>
  );
}
