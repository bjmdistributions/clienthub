// Importing a spreadsheet into the Warehouse (R-328). Every sheet is laid out differently,
// so nothing is assumed: the server-side guess (warehouse_core.rs guess_mapping) fills in a
// first mapping, the person corrects it against the sheet itself, and a live preview shows
// exactly what will be saved before anything is.
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import { api } from "../lib/api";
import { colName, sectionBoxes, sectionUnits, type ImportResult, type Mapping, type SheetRead, type WarehouseItem } from "../lib/warehouse";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0, plural } from "./warehouseUi";

type Role = "team_col" | "size_col" | "boxes_col" | "per_box_col" | "units_col";
const ROLES: { key: Role; label: string; hint: string; layouts: Mapping["layout"][] }[] = [
  { key: "team_col", label: "Team or name", hint: "What each row is: a team, a style, a colour.", layouts: ["rows", "grouped", "across"] },
  { key: "size_col", label: "Box size", hint: "Optional. The name of the box on that row.", layouts: ["rows"] },
  { key: "boxes_col", label: "Number of boxes", hint: "", layouts: ["rows", "grouped"] },
  { key: "per_box_col", label: "Units per box", hint: "", layouts: ["rows", "grouped"] },
  { key: "units_col", label: "Total units", hint: "Optional. Used when boxes or units per box are missing.", layouts: ["rows", "grouped"] },
];
const ROLE_SHORT: Record<Role, string> = { team_col: "Team", size_col: "Size", boxes_col: "Boxes", per_box_col: "Per box", units_col: "Units" };
const LAYOUTS: { key: Mapping["layout"]; label: string; hint: string }[] = [
  { key: "rows", label: "A row per team", hint: "Or a row per team and box size. A blank team carries down from the row above." },
  { key: "grouped", label: "Teams as headings", hint: "A team on its own row, its box sizes on the rows under it." },
  { key: "across", label: "A column per box size", hint: "A row per team, and each box size has its own column of counts." },
];
const SELECT = `${WH_INPUT} pr-8`;

export default function WarehouseImport({ read, fileName, items, defaultTargetId, onClose, onImported }: {
  read: SheetRead; fileName: string; items: WarehouseItem[]; defaultTargetId: string | null;
  onClose: () => void; onImported: (it: WarehouseItem) => void;
}) {
  const rows = read.rows;
  const width = useMemo(() => rows.reduce((a, r) => Math.max(a, r.length), 0), [rows]);
  const [m, setM] = useState<Mapping>(() => ({ ...read.guess, size_cols: read.guess.size_cols || [] }));
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [target, setTarget] = useState<string>(defaultTargetId && items.some((i) => i.id === defaultTargetId) ? defaultTargetId : "new");
  const [name, setName] = useState(fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim());
  const [label, setLabel] = useState("Team");
  const [add, setAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-read the sheet with the mapping on every change — debounced, and the answer to a
  // stale mapping is dropped.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.warehouseImportPreview(rows, m).then((p) => { if (live) setPreview(p); }).catch((e) => toast(String(e), "error"));
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [rows, m]);

  const colOptions = (
    <>
      <option value="">Not in this sheet</option>
      {Array.from({ length: width }, (_, c) => (
        <option key={c} value={c}>{colName(c)}{rows[m.header_row]?.[c] ? ` · ${rows[m.header_row][c]}` : ""}</option>
      ))}
    </>
  );
  const roleOf = (c: number): Role | null => (ROLES.find((r) => r.layouts.includes(m.layout) && m[r.key] === c)?.key ?? null);
  const sizeColOf = (c: number) => m.size_cols.find((s) => s.col === c);
  const first = Math.max(0, m.header_row - 1);
  const shown = rows.slice(first, first + 14);

  const setRole = (key: Role, v: string) => setM({ ...m, [key]: v === "" ? null : Number(v) });
  const toggleSizeCol = (c: number) => {
    const has = sizeColOf(c);
    if (has) setM({ ...m, size_cols: m.size_cols.filter((s) => s.col !== c) });
    else {
      // A number in the heading ("Big (72)") is the box size; otherwise it has to be typed.
      const h = rows[m.header_row]?.[c] || "";
      const per = Number((h.match(/(\d+)/) || [])[1] || 0);
      setM({ ...m, size_cols: [...m.size_cols, { col: c, name: "", per_box: per }].sort((a, b) => a.col - b.col) });
    }
  };

  const totals = preview ? {
    boxes: preview.sections.reduce((a, s) => a + sectionBoxes(s), 0),
    units: preview.sections.reduce((a, s) => a + sectionUnits(preview.box_types, s), 0),
  } : null;
  const canImport = !!preview && preview.sections.length > 0 && (target !== "new" || name.trim().length > 0);

  const doImport = async () => {
    setBusy(true);
    try {
      const it = await api.warehouseImport(rows, m, target === "new"
        ? { name: name.trim(), sectionLabel: label.trim() || "Section" }
        : { targetId: target, add });
      toast(`Imported ${preview?.sections.length ?? 0} ${plural(target === "new" ? label : items.find((i) => i.id === target)?.section_label || "row")}`);
      onImported(it);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <button onClick={onClose} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 mb-3 transition-colors">
        <ArrowLeft size={13} /> Warehouse
      </button>
      <div className="flex items-start gap-3 mb-5">
        <FileSpreadsheet size={18} className="text-accent mt-1 flex-shrink-0" />
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">Import {fileName}</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {n0(rows.length)} rows{read.sheet_name ? ` · sheet ${read.sheet_name}` : ""}{read.note ? ` · ${read.note}` : ""}.
            Check what each column is. The preview below updates as you change it.
          </p>
        </div>
      </div>

      {/* The mapping */}
      <div className={`${WH_CARD} p-5 mb-4`}>
        <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(0,1fr)] gap-5">
          <div>
            <label className="block text-[12px] text-muted mb-1.5">The headings are on row</label>
            <select value={m.header_row} onChange={(e) => setM({ ...m, header_row: Number(e.target.value) })} style={WH_INPUT_BG} className={SELECT}>
              {rows.slice(0, 40).map((r, i) => (
                <option key={i} value={i}>{i + 1}{r.some((c) => c.trim()) ? ` · ${r.filter((c) => c.trim()).slice(0, 3).join(", ")}` : " · empty"}</option>
              ))}
            </select>
            <div className="text-[12px] text-muted mt-3 mb-1.5">How the sheet is laid out</div>
            <div className="space-y-1.5">
              {LAYOUTS.map((l) => (
                <button key={l.key} onClick={() => setM({ ...m, layout: l.key })}
                  className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${m.layout === l.key ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2"}`}>
                  <div className="text-[13px] font-medium text-ink">{l.label}</div>
                  <div className="text-[11.5px] text-muted leading-snug">{l.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="min-w-0">
            {m.layout !== "across" ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-3">
                {ROLES.filter((r) => r.layouts.includes(m.layout)).map((r) => (
                  <div key={r.key}>
                    <label className="block text-[12px] text-muted mb-1.5">{r.label}{m.layout === "grouped" && r.key === "team_col" ? " (and the box size on the rows under it)" : ""}</label>
                    <select value={m[r.key] ?? ""} onChange={(e) => setRole(r.key, e.target.value)} style={WH_INPUT_BG} className={SELECT}>{colOptions}</select>
                    {r.hint && <div className="text-[11.5px] text-faint mt-1">{r.hint}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div>
                <label className="block text-[12px] text-muted mb-1.5">Team or name</label>
                <select value={m.team_col ?? ""} onChange={(e) => setRole("team_col", e.target.value)} style={WH_INPUT_BG} className={`${SELECT} max-w-[320px]`}>{colOptions}</select>
                <div className="text-[12px] text-muted mt-4 mb-1.5">Tick each column that is a box size, and say how many units that box holds.</div>
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: width }, (_, c) => c).filter((c) => c !== m.team_col).map((c) => {
                    const sc = sizeColOf(c);
                    return (
                      <div key={c} className={`rounded-lg border px-2.5 py-2 ${sc ? "border-accent bg-accent/10" : "border-line"}`}>
                        <label className="flex items-center gap-2 text-[12.5px] text-ink cursor-pointer">
                          <input type="checkbox" className="accent-accent" checked={!!sc} onChange={() => toggleSizeCol(c)} />
                          <span className="font-medium">{colName(c)}</span>
                          <span className="text-muted truncate max-w-[140px]">{rows[m.header_row]?.[c] || ""}</span>
                        </label>
                        {sc && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <NumberInput integer value={sc.per_box || ""} placeholder="0" style={WH_INPUT_BG}
                              onValue={(n) => setM({ ...m, size_cols: m.size_cols.map((x) => (x.col === c ? { ...x, per_box: n } : x)) })}
                              className="w-16 border border-line px-2 h-7 rounded-md text-right tabular-nums text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent/40" />
                            <span className="text-[11.5px] text-muted">per box</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* The sheet itself, with what each column was taken to be */}
      <div className={`${WH_CARD} mb-4 overflow-hidden`}>
        <div className="px-5 pt-4 pb-2 text-[14px] font-semibold text-ink">The sheet</div>
        <div className="overflow-x-auto">
          <table className="text-[12.5px] min-w-full">
            <thead>
              <tr className="border-y border-line bg-surface-2">
                <th className="w-12 py-1.5 pl-5 pr-2 text-left text-[11px] font-medium text-faint" />
                {Array.from({ length: width }, (_, c) => {
                  const role = roleOf(c);
                  const sc = m.layout === "across" && sizeColOf(c);
                  return (
                    <th key={c} className="py-1.5 px-2 text-left font-medium text-muted whitespace-nowrap">
                      {colName(c)}
                      {role && <span className="ml-1.5 inline-flex items-center rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-hover">{ROLE_SHORT[role]}</span>}
                      {sc && <span className="ml-1.5 inline-flex items-center rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-hover">Size of {sc.per_box || "?"}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const rowIdx = first + i;
                const isHead = rowIdx === m.header_row;
                return (
                  <tr key={rowIdx} className={`border-b border-line-2 ${isHead ? "bg-accent/5 font-semibold text-ink" : rowIdx < m.header_row ? "text-faint" : "text-ink-2"}`}>
                    <td className="py-1.5 pl-5 pr-2 text-[11px] text-faint tabular-nums">{rowIdx + 1}</td>
                    {Array.from({ length: width }, (_, c) => (
                      <td key={c} className={`py-1.5 px-2 whitespace-nowrap max-w-[220px] truncate ${roleOf(c) !== null || (m.layout === "across" && sizeColOf(c)) ? "bg-accent/5" : ""}`}>{r[c] ?? ""}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > first + shown.length && <div className="px-5 py-2 text-[12px] text-muted">…and {n0(rows.length - first - shown.length)} more rows.</div>}
      </div>

      {/* What it becomes */}
      <div className={`${WH_CARD} mb-4 overflow-hidden`}>
        <div className="px-5 pt-4 pb-3">
          <div className="text-[14px] font-semibold text-ink">What will be imported</div>
          {preview && totals ? (
            <div className="text-[13px] text-ink-2 mt-0.5 tabular-nums">
              <span className="font-semibold text-ink">{n0(preview.sections.length)}</span> {plural(label || "row")} ·{" "}
              <span className="font-semibold text-ink">{n0(preview.box_types.length)}</span> box sizes ·{" "}
              <span className="font-semibold text-ink">{n0(totals.boxes)}</span> boxes ·{" "}
              <span className="font-semibold text-ink">{n0(totals.units)}</span> units
              <span className="text-muted"> · {n0(preview.rows_used)} rows read, {n0(preview.rows_skipped)} skipped</span>
            </div>
          ) : <div className="text-[12px] text-muted mt-0.5">Reading…</div>}
          {preview && preview.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {preview.warnings.map((w, i) => <li key={i} className="text-[12.5px] text-warning-ink">{w}</li>)}
            </ul>
          )}
          {preview && preview.box_types.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {preview.box_types.map((t) => (
                <span key={t.id} className="inline-flex items-center rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[12px] text-ink-2">{t.name} · {t.per_box}</span>
              ))}
            </div>
          )}
        </div>
        {preview && preview.sections.length > 0 && (
          <div className="overflow-x-auto max-h-[320px] overflow-y-auto border-t border-line">
            <table className="w-full text-[13px]" style={{ minWidth: 260 + preview.box_types.length * 96 }}>
              <thead className="sticky top-0 bg-surface">
                <tr className="text-[12px] text-muted border-b border-line">
                  <th className="text-left font-medium py-2 pl-5 pr-3">{label || "Row"}</th>
                  {preview.box_types.map((t) => <th key={t.id} className="text-right font-medium py-2 px-2 whitespace-nowrap">{t.name}</th>)}
                  <th className="text-right font-medium py-2 px-2">Loose</th>
                  <th className="text-right font-medium py-2 pl-3 pr-5">Units</th>
                </tr>
              </thead>
              <tbody>
                {preview.sections.map((s) => (
                  <tr key={s.name} className="border-b border-line-2 last:border-0">
                    <td className="py-1.5 pl-5 pr-3 text-ink font-medium">{s.name}</td>
                    {preview.box_types.map((t) => <td key={t.id} className="py-1.5 px-2 text-right tabular-nums text-ink-2">{s.counts[t.id] ? n0(s.counts[t.id]) : <span className="text-faint">·</span>}</td>)}
                    <td className="py-1.5 px-2 text-right tabular-nums text-ink-2">{s.loose ? n0(s.loose) : <span className="text-faint">·</span>}</td>
                    <td className="py-1.5 pl-3 pr-5 text-right tabular-nums text-ink">{n0(sectionUnits(preview.box_types, s))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Where it goes */}
      <div className={`${WH_CARD} p-5 mb-4`}>
        <div className="text-[14px] font-semibold text-ink mb-3">Where it goes</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label className="block text-[12px] text-muted mb-1.5">Product</label>
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={WH_INPUT_BG} className={SELECT}>
              <option value="new">A new product</option>
              {items.map((i) => <option key={i.id} value={i.id}>Into {i.name}</option>)}
            </select>
          </div>
          {target === "new" ? (
            <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
              <div>
                <label className="block text-[12px] text-muted mb-1.5">Name it</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" style={WH_INPUT_BG} className={WH_INPUT} />
              </div>
              <div>
                <label className="block text-[12px] text-muted mb-1.5">Each row is a</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Team" style={WH_INPUT_BG} className={WH_INPUT} />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-[12px] text-muted mb-1.5">The counts in the sheet</label>
              <div className="flex rounded-lg border border-line p-0.5 bg-surface-2 w-fit" role="tablist">
                {[false, true].map((a) => (
                  <button key={String(a)} role="tab" aria-selected={add === a} onClick={() => setAdd(a)}
                    className={`px-3 h-8 rounded-md text-[12.5px] transition-colors ${add === a ? "bg-surface text-ink font-medium shadow-sm ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                    {a ? "Add to what is there" : "Replace what is there"}
                  </button>
                ))}
              </div>
              <div className="text-[11.5px] text-muted mt-1.5">
                {add ? "A delivery: the sheet's boxes are added on top." : "A recount: the sheet's rows take the sheet's counts. Rows the sheet leaves out keep theirs."}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={WH_BTN_SECONDARY}>Cancel</button>
        <button onClick={doImport} disabled={!canImport || busy} className={WH_BTN_PRIMARY}>
          {busy ? "Importing…" : `Import ${preview ? n0(preview.sections.length) : ""} ${plural(label || "row")}`}
        </button>
      </div>
    </div>
  );
}
