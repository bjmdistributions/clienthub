import { useState } from "react";
import { api, ManifestAnalysis, ManifestColumnMap, ManifestColumnMapRecord } from "../../lib/api";
import { toast } from "../Toast";
import { colLetter, fmtDay, S } from "./shared";

/** The roles a manifest's columns can play, in the words a person uses. */
const ROLES: { id: string; label: string; need?: boolean; help?: string }[] = [
  { id: "description", label: "Product description", need: true },
  { id: "quantity", label: "Units", need: true, help: "If there is none, every line counts as 1 unit." },
  { id: "retail_unit", label: "Retail price of one unit" },
  { id: "retail_ext", label: "Retail price of the whole line", help: "Already multiplied by the units." },
  { id: "cost", label: "Cost price" },
  { id: "sheet_price", label: "The sheet's price" },
  { id: "category", label: "Category" },
  { id: "brand", label: "Brand" },
  { id: "code", label: "UPC or style code" },
  { id: "condition", label: "Condition" },
  { id: "photo", label: "Picture link" },
];

/**
 * Which column is which. Shown at once when the reader could not tell (a sheet with no heading
 * row, or a missing description, units or price), otherwise folded under "How it was read" and
 * opened with Edit. Nothing here is a guess: each role names a column and shows three values from it.
 */
export default function ColumnMap({ analysis, mappedLike, forced, busy, onApply }: {
  analysis: ManifestAnalysis;
  mappedLike: ManifestColumnMapRecord | null;
  forced: boolean;
  busy: boolean;
  onApply: (map: ManifestColumnMap) => void;
}) {
  const cols = analysis.columns || [];
  const [roles, setRoles] = useState<Record<string, number>>(() => {
    const r: Record<string, number> = {};
    for (const c of cols) if (c.role && !(c.role in r)) r[c.role] = c.index;
    return r;
  });
  const [headerRow, setHeaderRow] = useState(String(Math.max(0, analysis.detection.header_row || 0)));
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const colName = (i: number) => {
    const h = (cols.find((c) => c.index === i)?.header || "").trim();
    return h ? `${h} (column ${colLetter(i)})` : `Column ${colLetter(i)}`;
  };
  const set = (role: string, v: string) => {
    const next = { ...roles };
    if (v === "") delete next[role]; else next[role] = Number(v);
    setRoles(next);
  };
  const hr = parseInt(headerRow, 10);
  const map = (): ManifestColumnMap => ({ header_row: Number.isFinite(hr) && hr > 0 ? hr : null, roles });
  const hasPrice = ["retail_unit", "retail_ext", "cost", "sheet_price"].some((r) => r in roles);
  const ready = "description" in roles && hasPrice;

  const apply = async () => {
    const m = map();
    if (remember && name.trim()) {
      setSaving(true);
      try {
        await api.saveColumnMap(analysis.header_signature, name.trim(), m);
        toast(`Remembered. The next sheet with these headings is read the same way.`);
      } catch (e: any) { toast(String(e), "error"); }
      setSaving(false);
    }
    onApply(m);
  };

  return (
    <section id="mf-columns" className={`${S.card} border ${forced ? "border-warning" : "border-transparent"}`}>
      <p className={S.h2}>Which column is which</p>
      <p className="text-[12.5px] text-ink-2 mb-3 max-w-[680px]">
        {forced
          ? "Ecliptr could not tell for sure which column is which on this sheet, so nothing is counted yet. Check each one below, pick the right column where it is wrong, then press Read it this way."
          : "Change any column that was read wrongly, then press Read it this way. Three values from each column are shown so you can see what it holds."}
      </p>
      {mappedLike && !forced && (
        <p className="text-[12px] text-muted mb-2">Mapped like {mappedLike.name}{fmtDay(mappedLike.created_at) ? `, ${fmtDay(mappedLike.created_at)}` : ""}.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-muted text-left">
              <th className="py-1.5 pr-3 font-medium">What it is</th>
              <th className="py-1.5 pr-3 font-medium">Column on the sheet</th>
              <th className="py-1.5 font-medium">Three values from it</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => {
              const idx = roles[r.id];
              const sample = idx != null ? cols.find((c) => c.index === idx)?.samples?.slice(0, 3) ?? [] : [];
              return (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3 text-ink-2 whitespace-nowrap">
                    {r.label}{r.need ? <span className="text-danger-ink"> *</span> : null}
                    {r.help && <div className="text-[11px] text-muted whitespace-normal max-w-[200px]">{r.help}</div>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <select value={idx == null ? "" : String(idx)} onChange={(e) => set(r.id, e.target.value)}
                      className={`${S.input} w-56 max-w-full pr-7`}>
                      <option value="">Not on this sheet</option>
                      {cols.map((c) => <option key={c.index} value={c.index}>{colName(c.index)}</option>)}
                    </select>
                  </td>
                  <td className="py-2 text-muted text-[12px]">
                    <div className="truncate max-w-[320px] xl:max-w-[520px]" title={sample.join("  |  ")}>
                      {idx == null ? "" : sample.length ? sample.join("  ·  ") : "Nothing in the first rows"}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-4 mt-3">
        <label className="text-[11.5px] text-muted">
          <span className="block mb-1">Headings are on row (0 if the sheet has none)</span>
          <input className={`${S.input} w-24`} value={headerRow} inputMode="numeric"
            onChange={(e) => setHeaderRow(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2 pb-1.5">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this layout for the next sheet like it
        </label>
        {remember && (
          <label className="text-[11.5px] text-muted">
            <span className="block mb-1">Name it after the supplier</span>
            <input className={`${S.input} w-48`} value={name} placeholder="e.g. WLG" onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <button onClick={apply} disabled={busy || saving || !ready || (remember && !name.trim())} className={S.btnPrimary}>
          {busy ? "Reading…" : "Read it this way"}
        </button>
      </div>
      {!ready && <p className="text-[11.5px] text-warning-ink mt-2">Pick a column for the description and at least one price before reading.</p>}
    </section>
  );
}
