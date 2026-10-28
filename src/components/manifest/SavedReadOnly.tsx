import { useState } from "react";
import type { SavedManifestFull } from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import { catLabel, fmtDay, fmtInt, PlacedPill, S, savedTotals } from "./shared";

/** A saved manifest whose file is no longer on this computer: what was saved, shown as it was, nothing editable. */
export default function SavedReadOnly({ m, onBack }: { m: SavedManifestFull; onBack: () => void }) {
  const t = savedTotals(m);
  const [limit, setLimit] = useState(100);
  const products = m.products || [];
  return (
    <div className="max-w-[1120px] min-w-0 space-y-6">
      <div>
        <p className="text-[15px] font-semibold text-ink truncate">{m.name}</p>
        <p className="text-[12px] text-muted">Saved {fmtDay(m.created_at)}{m.supplier ? `, ${m.supplier}` : ""}.</p>
      </div>
      <p className="text-[12.5px] text-warning-ink bg-warning-bg border border-warning/30 rounded-lg px-3.5 py-2.5">
        The file this was read from is no longer on this computer, so it cannot be read again. This is what was saved.
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ["Units", fmtInt(t.units)],
          ["Products", fmtInt(products.length)],
          ["Total retail", t.retail > 0 ? fmtAmount(t.retail) : "-"],
          ["Asking price", m.ask != null && m.ask > 0 ? fmtAmount(m.ask) : "-"],
        ].map(([l, v]) => (
          <div key={l} className={S.card}>
            <p className="text-[11.5px] font-medium text-muted">{l}</p>
            <p className="text-[17px] font-bold text-ink tabular-nums mt-0.5">{v}</p>
          </div>
        ))}
      </div>
      <section>
        <p className={S.h2}>Every product <span className="text-[11px] font-normal text-muted tabular-nums">{fmtInt(products.length)}</span></p>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2">
              <tr>
                <th className={`${S.thL} text-left rounded-l-lg`}>Product</th>
                <th className={`${S.thL} text-left`}>Category</th>
                <th className={`${S.thL} text-left`}>Brand</th>
                <th className={`${S.thL} text-right`}>Units</th>
                <th className={`${S.thL} text-right rounded-r-lg`}>Retail</th>
              </tr>
            </thead>
            <tbody>
              {products.slice(0, limit).map((p) => (
                <tr key={p.key} className="border-t border-line">
                  <td className="px-2 py-1.5 text-ink-2"><div className="truncate max-w-[170px] xl:max-w-[340px]" title={p.title}>{p.title}</div></td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-ink-2"><span className="flex items-center gap-1.5">{catLabel(p.category)}<PlacedPill placed={p.placed} /></span></td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-ink-2">{p.brand || <span className="text-muted">-</span>}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(p.qty)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{p.retail > 0 ? fmtAmount(p.retail) : p.cost != null ? fmtAmount(p.cost) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {products.length > limit && (
          <button onClick={() => setLimit((n) => n + 500)} className="mt-2 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-8 rounded-lg">
            Show {fmtInt(Math.min(500, products.length - limit))} more
          </button>
        )}
      </section>
      <button onClick={onBack} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Back to saved manifests</button>
    </div>
  );
}
