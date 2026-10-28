import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ManifestAnalysis, ManifestLine, ManifestProduct } from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import StatusPill from "../StatusPill";
import {
  catLabel, facts, fmtInt, isUnplaced, fmtPct, num, PlacedPill, placedCounts, pricedLines, ResaleSettings, S, sheetAsk, unitOf,
} from "./shared";

/**
 * What is in the load, what the sheet charges, what can be paid, and every product. Every figure
 * comes from the file or from a number typed here. Products replace rows: lines that share a UPC
 * (or a style and title) are one product, with its rows listed when it is opened.
 */
export default function Breakdown({ analysis: a, settings, onSettings, ask, onAsk, rowFilter, onClearFilter, onJumpReview, onMax }: {
  analysis: ManifestAnalysis;
  settings: ResaleSettings;
  onSettings: (s: ResaleSettings) => void;
  ask: string;
  onAsk: (v: string) => void;
  rowFilter: number[] | null;
  onClearFilter: () => void;
  onJumpReview: () => void;
  /** The most that can be paid, for the Copy button beside Save. */
  onMax: (v: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"value" | "unit" | "qty" | "row">("value");
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const costOnly = a.cost_only;
  const f = useMemo(() => facts(a), [a]);
  const sheetPrice = sheetAsk(a);
  const units = a.total_quantity || 0;
  const products = a.products || [];
  const hasSheetPrice = !costOnly && a.lines.some((l) => l.sheet_price != null);
  const hasCondition = !!a.detection.condition_col;
  const counts = placedCounts(a);
  const costTotal = sheetPrice ?? (a.lines.some((l) => l.sheet_price != null) ? a.lines.reduce((s, l) => s + (l.sheet_price || 0), 0) : null);
  const manyPages = (a.pages || []).filter((p) => p.read).length > 1;

  // The bid: each category at Jack's resale rate, less his target margin. A cost-only sheet has
  // no retail, so the rate is a resale price per unit instead of a % of retail.
  const bid = useMemo(() => {
    const rows = a.categories.map((c) => {
      const cost = f.costByCat.get(c.name) ?? null;
      if (costOnly) {
        const per = num(settings.unitCats[c.name] ?? "") ?? num(settings.unit);
        return { ...c, rate: per, cost, resale: per != null ? c.quantity * per : null, counts: c.quantity > 0 };
      }
      const pct = num(settings.cats[c.name] ?? "") ?? num(settings.pct);
      return { ...c, rate: pct, cost, resale: pct != null ? c.total_retail * pct / 100 : null, counts: c.total_retail > 0 };
    });
    const set = rows.filter((r) => r.resale != null);
    const resale = set.reduce((s, r) => s + (r.resale || 0), 0);
    const missing = rows.filter((r) => r.resale == null && r.counts);
    const margin = num(settings.margin);
    const max = set.length && margin != null && margin < 100 ? resale * (1 - margin / 100) : null;
    return { rows, resale: set.length ? resale : null, missing, margin, max, ask: num(ask) };
  }, [a, f, settings, ask, costOnly]);

  useEffect(() => { onMax(bid.max); }, [bid.max]); // eslint-disable-line react-hooks/exhaustive-deps

  const byRow = useMemo(() => new Map<number, ManifestLine>(a.lines.map((l) => [l.row, l])), [a]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const only = rowFilter ? new Set(rowFilter) : null;
    const ps = products.filter((p) =>
      (!q || [p.title, p.brand || "", p.category, p.code].some((v) => v.toLowerCase().includes(q))) &&
      (!only || p.rows.some((r) => only.has(r))));
    const val = f.value;
    const key = {
      value: (p: ManifestProduct) => -val(p),
      unit: (p: ManifestProduct) => -(p.qty > 0 ? val(p) / p.qty : 0),
      qty: (p: ManifestProduct) => -p.qty,
      row: (p: ManifestProduct) => Math.min(...(p.rows.length ? p.rows : [0])),
    }[sort];
    return [...ps].sort((x, y) => key(x) - key(y));
  }, [products, query, sort, rowFilter, f]);

  const val = f.value;
  const money = costOnly ? "Cost" : "Retail";
  const unitMoney = costOnly ? "Unit cost" : "Unit retail";
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const unplacedShare = a.total_retail > 0 ? a.uncategorized_retail / a.total_retail : a.uncategorized_lines / Math.max(1, a.total_items);
  const rateLabel = costOnly ? "Resale per unit" : "Resale %";

  return (
    <div className="space-y-6">
      {/* What is in it */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(costOnly
            ? [
                ["Units", fmtInt(units)],
                ["Products", fmtInt(products.length)],
                ["Cost of the load", costTotal != null ? fmtAmount(costTotal) : "-"],
                ["Cost per unit", costTotal != null && units > 0 ? fmtAmount(costTotal / units) : "-"],
              ]
            : [
                ["Units", fmtInt(units)],
                ["Products", fmtInt(products.length)],
                ["Total retail", fmtAmount(a.total_retail)],
                ["Retail per unit", units > 0 ? fmtAmount(a.total_retail / units) : "-"],
              ]
          ).map(([l, v]) => (
            <div key={l} className={S.card}>
              <p className="text-[11.5px] font-medium text-muted">{l}</p>
              <p className="text-[17px] font-bold text-ink tabular-nums mt-0.5">{v}</p>
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted mt-2">
          {fmtInt(a.total_items)} sheet row{a.total_items === 1 ? "" : "s"} in {fmtInt(products.length)} product{products.length === 1 ? "" : "s"}. {costOnly ? "This sheet states what each unit costs and no retail value. " : ""}
          {!costOnly && a.unpriced_lines > 0 ? `${fmtInt(a.unpriced_lines)} line${a.unpriced_lines !== 1 ? "s have" : " has"} no retail value and count in units only. ` : ""}
        </p>
        {costOnly && a.sheet_pricing?.evidence && <p className="text-[11.5px] text-muted mt-1">Read from the sheet: {a.sheet_pricing.evidence}.</p>}
      </section>

      {/* The sheet's own pricing (a cost-only sheet already leads with it above) */}
      {!costOnly && (
        <section className={S.card}>
          <p className={S.h2}>The sheet's price</p>
          {sheetPrice != null ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  ["For the load", fmtAmount(sheetPrice)],
                  ["Per unit, across all units", units > 0 ? fmtAmount(sheetPrice / units) : "-"],
                  ["Of retail", a.total_retail > 0 ? fmtPct(sheetPrice / a.total_retail) : "-"],
                  ["Lines with a price", `${fmtInt(pricedLines(a))} of ${fmtInt(a.total_items)}`],
                ].map(([l, v]) => (
                  <div key={l}>
                    <p className="text-[11.5px] text-muted">{l}</p>
                    <p className="text-[15px] font-semibold text-ink tabular-nums">{v}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11.5px] text-muted mt-2">Read from the sheet: {a.sheet_pricing?.evidence}.</p>
            </>
          ) : (
            <p className="text-[12.5px] text-ink-2">
              {a.sheet_pricing ? "The sheet shows retail only. It states no price for the load." : "A PDF's price is not read. Type the asking price below."}
            </p>
          )}
        </section>
      )}

      {/* What you can pay */}
      <section className={S.card}>
        <p className={S.h2}>What you can pay</p>
        <div className="flex flex-wrap items-end gap-4">
          {costOnly ? (
            <label className="text-[11.5px] text-muted">
              <span className="block mb-1">You resell each unit for</span>
              <input className={`${S.input} w-28`} value={settings.unit} placeholder="$ e.g. 12"
                onChange={(e) => onSettings({ ...settings, unit: e.target.value })} />
            </label>
          ) : (
            <label className="text-[11.5px] text-muted">
              <span className="block mb-1">You resell at (% of retail)</span>
              <input className={`${S.input} w-28`} value={settings.pct} placeholder="e.g. 30"
                onChange={(e) => onSettings({ ...settings, pct: e.target.value })} />
            </label>
          )}
          <label className="text-[11.5px] text-muted">
            <span className="block mb-1">Your target margin (%)</span>
            <input className={`${S.input} w-28`} value={settings.margin} placeholder="e.g. 25"
              onChange={(e) => onSettings({ ...settings, margin: e.target.value })} />
          </label>
          <label className="text-[11.5px] text-muted">
            <span className="block mb-1">Asking price for the load</span>
            <input className={`${S.input} w-36`} value={ask} placeholder="$" onChange={(e) => onAsk(e.target.value)} />
          </label>
          {a.overall_margin_pct > 0 && (
            <p className="text-[11.5px] text-muted pb-2">Your completed deals average a {a.overall_margin_pct.toFixed(0)}% margin.</p>
          )}
        </div>
        {bid.resale == null ? (
          <p className="text-[12.5px] text-ink-2 mt-3">
            {costOnly
              ? "Set what you resell one unit for, here or per category below, to see what this load is worth to you."
              : "Set the % of retail you resell at, here or per category below, to see what this load is worth to you."}
          </p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
            <div>
              <p className="text-[11.5px] text-muted">You'd resell it for</p>
              <p className="text-[15px] font-semibold text-ink tabular-nums">{fmtAmount(bid.resale)}</p>
            </div>
            <div>
              <p className="text-[11.5px] text-muted">Most you can pay</p>
              <p className="text-[15px] font-semibold text-ink tabular-nums">{bid.max != null ? fmtAmount(bid.max) : "Set a margin"}</p>
            </div>
            <div>
              <p className="text-[11.5px] text-muted">Most per unit</p>
              <p className="text-[15px] font-semibold text-ink tabular-nums">{bid.max != null && units > 0 ? fmtAmount(bid.max / units) : "-"}</p>
            </div>
            <div>
              <p className="text-[11.5px] text-muted">At the asking price</p>
              {bid.ask != null && bid.ask > 0 ? (() => {
                const profit = bid.resale - bid.ask;
                return (
                  <p className={`text-[15px] font-semibold tabular-nums ${profit >= 0 && (bid.max == null || bid.ask <= bid.max) ? "text-success-ink" : "text-danger-ink"}`}>
                    {fmtAmount(profit)} <span className="text-[12px] font-medium">({bid.resale > 0 ? fmtPct(profit / bid.resale) : "-"} margin)</span>
                  </p>
                );
              })() : <p className="text-[15px] font-semibold text-muted">No asking price</p>}
            </div>
          </div>
        )}
        {bid.max != null && bid.ask != null && bid.ask > 0 && (
          <p className="text-[12px] text-ink-2 mt-2">
            {bid.ask <= bid.max
              ? `The ask is ${fmtAmount(bid.max - bid.ask)} under the most you can pay.`
              : `The ask is ${fmtAmount(bid.ask - bid.max)} over the most you can pay.`}
          </p>
        )}
        {bid.resale != null && bid.missing.length > 0 && (
          <p className="text-[11.5px] text-warning-ink mt-2">
            {costOnly
              ? `No resale per unit for ${bid.missing.map((c) => c.name).join(", ")}, so ${fmtInt(bid.missing.reduce((s, c) => s + c.quantity, 0))} units are not counted.`
              : `No resale % for ${bid.missing.map((c) => c.name).join(", ")}, so ${fmtAmount(bid.missing.reduce((s, c) => s + c.total_retail, 0))} of retail is not counted.`}
          </p>
        )}
      </section>

      {/* By category */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <p className={S.h2 + " mb-0"}>By category</p>
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            {counts.sheet > 0 && <StatusPill title="The sheet's own category column">{fmtInt(counts.sheet)} from the sheet</StatusPill>}
            {counts.rule > 0 && <StatusPill tone="accent" title="Placed by one of your rules">{fmtInt(counts.rule)} by your rule</StatusPill>}
            {counts.list > 0 && <StatusPill tone="warning" title="Read from the title words. Only a suggestion until you confirm it in the review.">{fmtInt(counts.list)} suggested</StatusPill>}
            {counts.none > 0 && <StatusPill tone="danger" title="Nothing places these yet">{fmtInt(counts.none)} unplaced</StatusPill>}
          </span>
        </div>
        {a.uncategorized_lines > 0 && (
          <p className={`text-[11.5px] mb-2 px-3 py-2 rounded-lg ${unplacedShare > 0.1 ? "text-warning-ink bg-warning-bg border border-warning" : "text-muted bg-surface-2"}`}>
            {fmtInt(a.uncategorized_lines)} of {fmtInt(a.total_items)} lines {costOnly ? "" : `(${Math.round(unplacedShare * 100)}% of retail) `}are unplaced.{" "}
            {(a.review?.groups?.length || 0) > 0 && <button onClick={onJumpReview} className="underline hover:text-accent">Place them in the review</button>}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2">
              <tr>
                <th className={`${S.th} text-left rounded-l-lg`}>Category</th>
                <th className={`${S.th} text-right`}>Lines</th>
                <th className={`${S.th} text-right`}>Units</th>
                <th className={`${S.th} text-right`}>{money}</th>
                <th className={`${S.th} text-right`}>{unitMoney}</th>
                <th className={`${S.th} text-right`}>{rateLabel}</th>
                <th className={`${S.th} text-right rounded-r-lg`}>You'd resell for</th>
              </tr>
            </thead>
            <tbody>
              {bid.rows.map((c) => {
                const suggested = f.suggestedByCat.get(c.name) || 0;
                const total = costOnly ? c.cost : c.total_retail;
                const store = costOnly ? settings.unitCats : settings.cats;
                const fallback = costOnly ? settings.unit : settings.pct;
                return (
                  <tr key={c.name} className="border-t border-line">
                    <td className="px-3 py-2 font-medium text-ink-2">
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        {catLabel(c.name)}
                        {suggested > 0 && !isUnplaced(c.name) && (
                          <StatusPill tone="warning" title="Read from the title words, not confirmed yet">{suggested === c.items ? "Suggested" : `${fmtInt(suggested)} suggested`}</StatusPill>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(c.items)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtInt(c.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{total != null ? fmtAmount(total) : "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{c.quantity > 0 && total ? fmtAmount(total / c.quantity) : "-"}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input className={`${S.input} w-20 h-7 text-right`} value={store[c.name] ?? ""} placeholder={fallback || (costOnly ? "$" : "%")}
                        onChange={(e) => {
                          const next = { ...store };
                          if (e.target.value.trim()) next[c.name] = e.target.value; else delete next[c.name];
                          onSettings(costOnly ? { ...settings, unitCats: next } : { ...settings, cats: next });
                        }} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.resale != null ? fmtAmount(c.resale) : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Where the retail sits, and the biggest products */}
      <section className="grid lg:grid-cols-2 gap-4">
        {!costOnly && (
          <div className={S.card}>
            <p className={S.h2}>Where the retail sits</p>
            <ul className="text-[12.5px] text-ink-2 space-y-1">
              <li>The top 10 products hold <span className="font-semibold text-ink tabular-nums">{fmtPct(f.top10Share)}</span> of the retail.</li>
              {f.topBrand && <li>{f.topBrand.name} is the biggest brand at <span className="font-semibold text-ink tabular-nums">{fmtPct(f.topBrandShare)}</span> of the retail.</li>}
              <li>Half the priced lines retail under <span className="font-semibold text-ink tabular-nums">{fmtAmount(f.median)}</span> a unit.</li>
            </ul>
            <table className="w-full text-[12px] mt-3">
              <thead>
                <tr className="text-muted">
                  <th className="text-left font-medium py-1">Retail per unit</th>
                  <th className="text-right font-medium py-1">Lines</th>
                  <th className="text-right font-medium py-1">Units</th>
                  <th className="text-right font-medium py-1">Retail</th>
                </tr>
              </thead>
              <tbody>
                {f.bands.map((b) => (
                  <tr key={b.name} className="border-t border-line">
                    <td className="py-1.5 text-ink-2">{b.name}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted">{fmtInt(b.lines)}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-2">{fmtInt(b.units)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtAmount(b.retail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={`${S.card} ${costOnly ? "lg:col-span-2" : ""}`}>
          <p className={S.h2}>Biggest products{costOnly ? ", by cost" : ""}</p>
          <table className="w-full text-[12px]">
            <tbody>
              {f.topProducts.map((p) => (
                <tr key={p.key} className="border-t border-line first:border-t-0">
                  <td className="py-1.5 pr-2 text-ink-2" title={p.title}><div className="truncate max-w-[150px] xl:max-w-[280px]">{p.title}</div></td>
                  <td className="py-1.5 text-right tabular-nums text-muted whitespace-nowrap">{fmtInt(p.qty)} x {p.qty > 0 ? fmtAmount(val(p) / p.qty) : "-"}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums font-medium">{fmtAmount(val(p))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* By brand */}
      {a.brands.length > 0 && (
        <section>
          <p className={S.h2}>By brand <span className="text-[11px] font-normal text-muted">from the sheet, the known-brand list and your rules</span></p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="bg-surface-2">
                <tr>
                  <th className={`${S.th} text-left rounded-l-lg`}>Brand</th>
                  <th className={`${S.th} text-right`}>Lines</th>
                  <th className={`${S.th} text-right`}>Units</th>
                  <th className={`${S.th} text-right`}>{money}</th>
                  <th className={`${S.th} text-right`}>{unitMoney}</th>
                  <th className={`${S.th} text-right rounded-r-lg`}>Share</th>
                </tr>
              </thead>
              <tbody>
                {a.brands.map((b) => (
                  <tr key={b.name} className="border-t border-line">
                    <td className="px-3 py-2 font-medium text-ink-2">{b.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtInt(b.items)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtInt(b.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtAmount(b.total_retail)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-2">{b.quantity > 0 && b.total_retail > 0 ? fmtAmount(b.total_retail / b.quantity) : "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{a.total_retail > 0 ? fmtPct(b.total_retail / a.total_retail) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Worth a look */}
      {(f.outliers.length > 0 || (!costOnly && f.noRetail.length > 0) || f.conditions.length > 0) && (
        <section className={S.card}>
          <p className={S.h2}>Worth a look</p>
          <div className="space-y-3 text-[12.5px] text-ink-2">
            {f.outliers.length > 0 && (
              <div>
                <p className="font-medium text-ink">{fmtInt(f.outliers.length)} line{f.outliers.length !== 1 ? "s retail" : " retails"} at 10 times the typical unit or more</p>
                <ul className="mt-1 space-y-0.5">
                  {f.outliers.slice(0, 8).map((l, i) => (
                    <li key={i} className="flex justify-between gap-3"><span className="truncate" title={l.title}>{l.row > 0 ? `Row ${l.row}: ` : ""}{l.title}</span><span className="tabular-nums whitespace-nowrap">{fmtAmount(unitOf(l))} a unit</span></li>
                  ))}
                </ul>
              </div>
            )}
            {!costOnly && f.noRetail.length > 0 && (
              <div>
                <p className="font-medium text-ink">{fmtInt(f.noRetail.length)} line{f.noRetail.length !== 1 ? "s have" : " has"} no retail ({fmtInt(f.noRetail.reduce((s, l) => s + l.qty, 0))} units)</p>
                <p className="text-muted truncate">{f.noRetail.slice(0, 5).map((l) => l.title).join(", ")}</p>
              </div>
            )}
            {f.conditions.length > 0 && (
              <div>
                <p className="font-medium text-ink">Condition</p>
                <ul className="mt-1 space-y-0.5">
                  {f.conditions.map(([name, c]) => (
                    <li key={name} className="flex justify-between gap-3"><span>{name}</span><span className="tabular-nums text-muted">{fmtInt(c.units)} units{costOnly ? "" : `, ${fmtAmount(c.retail)}`}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Every product */}
      <section id="mf-products">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <p className={S.h2 + " mb-0"}>Every product <span className="text-[11px] font-normal text-muted tabular-nums">{fmtInt(shown.length)} of {fmtInt(products.length)}</span></p>
          <div className="flex items-center gap-2">
            <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(100); }} placeholder="Search titles, brands, codes"
              className={`${S.input} w-64 max-w-full`} />
            <select value={sort} onChange={(e) => setSort(e.target.value as any)} className={`${S.input} pr-7`}>
              <option value="value">{costOnly ? "Biggest cost" : "Biggest retail"}</option>
              <option value="unit">{costOnly ? "Highest unit cost" : "Highest unit retail"}</option>
              <option value="qty">Most units</option>
              <option value="row">Sheet order</option>
            </select>
          </div>
        </div>
        {rowFilter && (
          <p className="text-[12px] text-ink-2 bg-surface-2 rounded-lg px-3 py-2 mb-2 flex items-center justify-between gap-3">
            <span>Showing the products on {fmtInt(rowFilter.length)} row{rowFilter.length === 1 ? "" : "s"} a check pointed to.</span>
            <button onClick={onClearFilter} className="text-accent hover:underline shrink-0">Show every product</button>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2">
              <tr>
                <th className={`${S.thL} w-6 rounded-l-lg`}></th>
                <th className={`${S.thL} text-left`}>Product</th>
                <th className={`${S.thL} text-left`}>Category</th>
                <th className={`${S.thL} text-left`}>Brand</th>
                <th className={`${S.thL} text-right`}>Units</th>
                <th className={`${S.thL} text-right`}>{unitMoney}</th>
                <th className={`${S.thL} text-right ${hasSheetPrice ? "" : "rounded-r-lg"}`}>{money}</th>
                {hasSheetPrice && <th className={`${S.thL} text-right rounded-r-lg`}>Sheet price</th>}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((p) => {
                const isOpen = open.has(p.key);
                return (
                  <Fragment key={p.key}>
                    <tr className="border-t border-line">
                      <td className="pl-2 py-1.5">
                        {p.rows.length > 1 || p.lines > 1 ? (
                          <button onClick={() => toggle(p.key)} aria-label={isOpen ? "Hide the rows" : "Show the rows"} className="text-muted hover:text-ink">
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 text-ink-2" title={p.code ? `${p.title} · ${p.code}` : p.title}>
                        <div className="truncate max-w-[170px] xl:max-w-[340px]">{p.title}</div>
                        <div className="text-[11px] text-muted tabular-nums">
                          {p.code}{p.code && p.lines > 1 ? " · " : ""}{p.lines > 1 ? `${fmtInt(p.lines)} rows` : ""}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">
                        <span className="flex items-center gap-1.5">{catLabel(p.category)}<PlacedPill placed={p.placed} /></span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">{p.brand || <span className="text-muted">-</span>}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(p.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-ink-2">{val(p) > 0 && p.qty > 0 ? fmtAmount(val(p) / p.qty) : "-"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{val(p) > 0 ? fmtAmount(val(p)) : "-"}</td>
                      {hasSheetPrice && <td className="px-2 py-1.5 text-right tabular-nums">{p.cost != null ? fmtAmount(p.cost) : "-"}</td>}
                    </tr>
                    {isOpen && p.rows.map((r) => {
                      const l = byRow.get(r);
                      if (!l) return null;
                      return (
                        <tr key={`${p.key}-${r}`} className="bg-surface-2/60">
                          <td></td>
                          <td className="px-2 py-1 text-muted" colSpan={2}>
                            Row {r}{manyPages && l.page ? `, ${l.page}` : ""}{l.section && l.section !== l.page ? `, ${l.section}` : ""}{hasCondition && l.condition ? `, ${l.condition}` : ""}
                          </td>
                          <td className="px-2 py-1"><PlacedPill placed={l.placed} /></td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtInt(l.qty)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-ink-2">{val2(l, costOnly) > 0 && l.qty > 0 ? fmtAmount(val2(l, costOnly) / l.qty) : "-"}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{val2(l, costOnly) > 0 ? fmtAmount(val2(l, costOnly)) : "-"}</td>
                          {hasSheetPrice && <td className="px-2 py-1 text-right tabular-nums">{l.sheet_price != null ? fmtAmount(l.sheet_price) : "-"}</td>}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown.length > limit && (
          <button onClick={() => setLimit((n) => n + 500)} className="mt-2 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-8 rounded-lg">
            Show {fmtInt(Math.min(500, shown.length - limit))} more
          </button>
        )}
      </section>
    </div>
  );
}

/** A line's value on this sheet: its cost when the sheet carries cost and no retail, else its retail. */
const val2 = (l: ManifestLine, costOnly: boolean) => (costOnly ? l.sheet_price ?? 0 : l.retail);
