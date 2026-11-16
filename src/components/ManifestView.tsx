import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { api, DEFAULT_READ_OPTIONS, ManifestColumnMapRecord, ManifestGridSheet, ManifestLine, SavedManifest, SavedManifestFull } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "./Toast";
import { Check, ChevronLeft, Upload } from "lucide-react";
import { Button, Kpi, PageActions, Tabs } from "./ui";
import { colLetter, fromRoles, headingRow, num, Pick, Picks, PICKS, read, setPick, signature, toRoles } from "../lib/manifestGrid";

/**
 * Manifest analyzer, R-653. Drop a manifest and it opens as the spreadsheet it is. Jack clicks the
 * headings that matter (name, quantity, brand, price) and the figures on top add them up. The picks
 * are remembered by the headings, so the next sheet laid out the same way opens with them set. Save
 * keeps it in the list to open again. No column is guessed and nothing is read by AI.
 */

const EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xlsb", "xls", "ods", "pdf"];
const ACCEPTED = new RegExp(`\\.(${EXTS.join("|")})$`, "i");
const fileName = (p: string) => p.split(/[/\\]/).pop() || p;
const baseName = (p: string) => fileName(p).replace(/\.[^.]+$/, "");
const fmtInt = (n: number) => Math.round(n || 0).toLocaleString("en-US");
const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const totalsOf = (m: SavedManifest) => {
  try {
    const t = m.totals && typeof m.totals === "object" ? m.totals : JSON.parse(m.totals_json || "{}");
    return { units: Number(t.units) || 0, price: Number(t.retail) || 0 };
  } catch { return { units: 0, price: 0 }; }
};
const rolesOf = (r: ManifestColumnMapRecord | null): Record<string, number> | null => {
  if (!r) return null;
  if (r.map) return r.map.roles;
  try { return r.map_json ? JSON.parse(r.map_json).roles : null; } catch { return null; }
};
const labelOf = (p: Pick) => PICKS.find((x) => x.id === p)?.label || p;
/** A number set to the right, as a spreadsheet does. A UPC or a code with a leading zero is not one. */
const isFigure = (c: string) => num(c) !== null && !/^0\d|^\d{8,}$/.test(c.trim());

/** Rows drawn at first; the rest wait for Show all, so a big sheet opens at once. */
const FIRST_ROWS = 500;

interface Page { name: string; rows: string[][]; h: number; sig: string; width: number }
interface Open {
  key: number;
  /** The file on this computer; null when it is gone and the saved lines are shown instead. */
  path: string | null;
  title: string;
  pages: Page[];
  saved: SavedManifest | null;
}

const pagesOf = (sheets: ManifestGridSheet[]): Page[] => sheets.map((s) => {
  const h = headingRow(s.rows);
  return { name: s.name, rows: s.rows, h, sig: signature(s.rows, h), width: Math.max(0, ...s.rows.map((r) => r.length)) };
});
/** Where a page's picks are kept: by its headings, so pages laid out alike share them. */
const keyOf = (p: Page) => p.sig || `page:${p.name}`;

export default function ManifestView(_: { onNavigate: (t: any) => void }) {
  const [list, setList] = useState<SavedManifest[] | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [picks, setPicks] = useState<Record<string, Picks>>({});
  const [page, setPage] = useState(0);
  const [mine, setMine] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [saveBox, setSaveBox] = useState<{ name: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const seq = useRef(0);
  const undoTimer = useRef<number | undefined>(undefined);

  const loadList = async (deleted = showDeleted) => {
    try { setList(await (deleted ? api.listManifestsDeleted() : api.listManifests())); } catch (e: any) { setList([]); toast(String(e), "error"); }
  };
  useEffect(() => { loadList(false); }, []);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);
  useEffect(() => {
    if (!menu && !saveBox) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); setSaveBox(null); } };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [menu, saveBox]);

  /** Show pages on screen, with the picks remembered for their headings (and a saved manifest's own). */
  const show = async (pages: Page[], o: Omit<Open, "key" | "pages">, given: Record<string, Picks> = {}) => {
    const next: Record<string, Picks> = { ...given };
    for (const p of pages) {
      if (!p.sig || next[p.sig]) continue;
      const roles = rolesOf(await api.findColumnMap(p.sig).catch(() => null));
      if (roles && Object.keys(roles).length) next[p.sig] = fromRoles(roles);
    }
    const cm = o.saved?.column_map as { roles?: Record<string, number>; sheet?: string } | null | undefined;
    if (cm?.roles && Object.keys(cm.roles).length) {
      const pg = pages.find((p) => p.name === cm.sheet) || [...pages].sort((a, b) => b.rows.length - a.rows.length)[0];
      if (pg && !next[keyOf(pg)]) next[keyOf(pg)] = fromRoles(cm.roles);
    }
    // Open on the biggest page with picks, else the biggest page: a summary tab is rarely the manifest.
    const withPicks = pages.map((_, i) => i).filter((i) => next[keyOf(pages[i])]);
    const pool = withPicks.length ? withPicks : pages.map((_, i) => i);
    setPicks(next);
    setPage(pool.reduce((b, i) => (pages[i].rows.length > pages[b].rows.length ? i : b), pool[0]));
    setMine(false); setShowAll(false); setMenu(null); setSaveBox(null);
    setOpen({ key: ++seq.current, pages, ...o });
  };

  const begin = async (path: string, saved: SavedManifest | null = null) => {
    setBusy(true);
    try {
      const pages = pagesOf(await api.manifestGrid(path));
      await show(pages, { path, title: saved?.name || baseName(path), saved });
    } catch (e: any) { toast(String(e), "error"); }
    setBusy(false);
  };

  const upload = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: EXTS }] });
    if (typeof f === "string") begin(f);
  };

  // Native file drag-drop onto the screen (Tauri webview): the HTML5 drop event gives a File with
  // no path, and the reader reads from a path.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragActive(true);
      else if (p.type === "leave") setDragActive(false);
      else if (p.type === "drop") {
        setDragActive(false);
        const file = p.paths.find((path) => ACCEPTED.test(path));
        if (file) begin(file);
        else if (p.paths.length) toast("That file can't be read as a manifest. Drop a CSV, Excel, TSV or PDF.", "error");
      }
    }).then((fn) => { if (cancelled) fn(); else un = fn; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  const openSaved = async (m: SavedManifest) => {
    setWorking(m.id);
    try {
      const full: SavedManifestFull = await api.getManifest(m.id);
      if (full.file_path) {
        await begin(full.file_path, full);
      } else {
        // The file is not on this computer: the lines it was saved with, as a sheet of their own.
        const rows = [["Name", "Brand", "Quantity", "Price"], ...(full.lines || []).map((l) => [l.title, l.brand || "", String(l.qty), String(l.retail)])];
        const pages: Page[] = [{ name: full.name, rows, h: 0, sig: "", width: 4 }];
        await show(pages, { path: null, title: full.name, saved: full }, { [`page:${full.name}`]: { name: 0, brand: 1, qty: 2, line: 3 } });
      }
    } catch (e: any) { toast(String(e), "error"); }
    setWorking(null);
  };

  const cur = open ? open.pages[Math.min(page, open.pages.length - 1)] : null;
  const pk: Picks = cur ? picks[keyOf(cur)] || {} : {};
  const readings = useMemo(() => (open ? open.pages.map((p) => read(p.rows, p.h, picks[keyOf(p)] || {})) : []), [open, picks]);
  const r = cur ? readings[open!.pages.indexOf(cur)] : null;

  const choose = (col: number, what: Pick | null) => {
    if (!open || !cur) return;
    const k = keyOf(cur);
    const next = setPick(picks[k] || {}, col, what);
    setPicks({ ...picks, [k]: next });
    setMenu(null);
    if (open.path && cur.sig) {
      // Remembered for these headings on every device; the picks on screen hold either way.
      api.saveColumnMap(cur.sig, open.title, { header_row: cur.h + 1, roles: toRoles(next) }).catch(() => {});
    }
  };

  const save = async (name: string) => {
    if (!open?.path || !cur) return;
    const lines: ManifestLine[] = [];
    let units = 0, price = 0;
    open.pages.forEach((pg, i) => {
      const rd = readings[i];
      units += rd.qty; price += rd.price;
      for (const l of rd.lines) {
        lines.push({
          row: l.row + 1, title: l.name, qty: l.qty ?? 0, retail: l.value ?? 0, sheet_price: null, category: "",
          brand: l.brand || null, guessed: false, code: "", condition: "", page: pg.name, section: "",
          placed: "none", brand_from: l.brand ? "sheet" : "none",
        });
      }
    });
    const cm = { header_row: cur.h >= 0 ? cur.h + 1 : null, roles: toRoles(pk), sheet: cur.name };
    try {
      const s = await api.saveManifest({
        id: open.saved?.id ?? null, path: open.path, name: name.trim() || open.title,
        supplier: open.saved?.supplier ?? null, source_name: fileName(open.path), ask: open.saved?.ask ?? null,
        status: open.saved?.status || "saved", pages: [], sections: [], column_map: cm,
        options: { ...DEFAULT_READ_OPTIONS, columns: cm }, stated: null,
        totals: { lines: lines.length, units, retail: Math.round(price * 100) / 100 }, lines, products: [],
      });
      setOpen((o) => (o && o.key === open.key ? { ...o, saved: s, title: s.name } : o));
      setSaveBox(null);
      toast("Saved. It is in your list.");
      loadList(false);
    } catch (e: any) { toast(String(e), "error"); }
  };

  const commitRename = async () => {
    const rn = renaming;
    setRenaming(null);
    if (!rn) return;
    const m = list?.find((x) => x.id === rn.id);
    if (!rn.text.trim() || !m || rn.text.trim() === m.name) return;
    try { await api.updateManifest(rn.id, { name: rn.text.trim() }); await loadList(); } catch (e: any) { toast(String(e), "error"); }
  };
  const remove = async (m: SavedManifest) => {
    try {
      await api.deleteManifest(m.id);
      setList((l) => (l || []).filter((x) => x.id !== m.id));
      setUndo({ id: m.id, name: m.name });
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 10000);
    } catch (e: any) { toast(String(e), "error"); }
  };
  const restore = async (id: string) => {
    try { await api.restoreManifest(id); setUndo(null); await loadList(); toast("Restored."); } catch (e: any) { toast(String(e), "error"); }
  };

  const openMenu = (col: number, e: MouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setMenu({ col, x: Math.min(b.left, window.innerWidth - 240), y: b.bottom + 4 });
  };
  const pickAt = (col: number) => (Object.keys(pk) as Pick[]).find((k) => pk[k] === col) || null;
  const picked = pk.name != null || pk.qty != null || pk.each != null || pk.line != null;

  // ── the sheet ───────────────────────────────────────────────────────────────
  const sheet = () => {
    if (!open || !cur || !r) return null;
    const cols = Array.from({ length: cur.width }, (_, j) => j);
    const head = (j: number) => (cur.h >= 0 ? String(cur.rows[cur.h][j] ?? "").trim() : "");
    const body = cur.rows.map((_, i) => i).filter((i) => i !== cur.h);
    const rows = showAll ? body : body.slice(0, FIRST_ROWS);
    const lines = showAll ? r.lines : r.lines.slice(0, FIRST_ROWS);
    const more = (mine ? r.lines.length : body.length) - (mine ? lines.length : rows.length);
    const priced = pk.each != null || pk.line != null;
    const withLines = readings.filter((x) => x.lines.length > 0);
    const all = withLines.length >= 2 ? {
      pages: withLines.length,
      lines: withLines.reduce((s, x) => s + x.lines.length, 0),
      qty: withLines.reduce((s, x) => s + x.qty, 0),
      price: withLines.reduce((s, x) => s + x.price, 0),
    } : null;

    return (
      <div className="max-w-[1400px] min-w-0 space-y-4">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => { setOpen(null); loadList(); }} className="ui-link muted shrink-0"><ChevronLeft size={14} />All manifests</button>
          <span className="text-[13px] text-muted truncate" title={open.path || ""}>{open.saved ? open.title : open.path ? fileName(open.path) : open.title}</span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
          <Kpi label="Total quantity" value={pk.qty != null ? r.qty : "-"} caption={pk.qty != null ? undefined : "Click the quantity heading"} />
          <div className="vsep hidden lg:block mt-4" />
          <Kpi label="Lines" value={picked ? r.lines.length : "-"} caption={picked ? undefined : "Click the name heading"} />
          <div className="vsep hidden lg:block mt-4" />
          <Kpi label="Brands" value={pk.brand != null ? r.brands : "-"} caption={pk.brand != null ? undefined : "Click the brand heading, if there is one"} />
          <div className="vsep hidden lg:block mt-4" />
          <Kpi label="Total price" value={priced ? r.price : "-"} format={fmtAmount}
            caption={priced ? (pk.line == null && pk.qty != null ? "price each times quantity" : undefined) : "Click a price heading, if there is one"} />
        </div>
        {all && (
          <p className="ui-note">Across {all.pages} pages: {fmtInt(all.qty)} units, {fmtInt(all.lines)} lines{all.price > 0 ? `, ${fmtAmount(all.price)}` : ""}.</p>
        )}

        {open.pages.length > 1 && (
          <Tabs label="Pages" tabs={open.pages.map((p, i) => ({ id: String(i), label: p.name, count: readings[i].lines.length }))}
            value={String(open.pages.indexOf(cur))} onChange={(id) => { setPage(Number(id)); setShowAll(false); setMenu(null); }} />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="ui-note">{open.path ? "Click a heading to say what it holds. Grey rows are not added up." : "The file is not on this computer, so these are the lines it was saved with."}</p>
          <div className="flex items-center gap-1.5">
            <button className={`ui-opt ${!mine ? "on" : ""}`} onClick={() => setMine(false)}>Whole sheet</button>
            <button className={`ui-opt ${mine ? "on" : ""}`} onClick={() => setMine(true)} disabled={!picked}>Just my columns</button>
          </div>
        </div>

        {mine ? (
          <div className="overflow-x-auto">
            <table className="ui-table ui-table-sm">
              <thead>
                <tr>
                  {pk.name != null && <th>Name</th>}
                  {pk.brand != null && <th>Brand</th>}
                  {pk.qty != null && <th className="r">Quantity</th>}
                  {pk.each != null && <th className="r">Price each</th>}
                  {priced && <th className="r">Line total</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.row}>
                    {pk.name != null && <td className="max-w-[520px] truncate" title={l.name}>{l.name}</td>}
                    {pk.brand != null && <td className="text-ink-2">{l.brand || <span className="text-faint">-</span>}</td>}
                    {pk.qty != null && <td className="r">{l.qty != null ? fmtInt(l.qty) : "-"}</td>}
                    {pk.each != null && <td className="r">{l.each != null ? fmtAmount(l.each) : "-"}</td>}
                    {priced && <td className="r">{l.value != null ? fmtAmount(l.value) : "-"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mg-scroll">
            <table className="mg-grid">
              <thead>
                <tr>
                  <th className="mg-rn"></th>
                  {cols.map((j) => {
                    const what = pickAt(j);
                    return (
                      <th key={j} className={what ? "on" : ""}>
                        <button className="mg-head" onClick={(e) => (open.path ? openMenu(j, e) : undefined)} disabled={!open.path} title={head(j) || `Column ${colLetter(j)}`}>
                          <span className="mg-letter">{colLetter(j)}</span>
                          <span className="mg-title">{head(j) || `Column ${colLetter(j)}`}</span>
                          {what && <span className="mg-tag">{labelOf(what)}</span>}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => {
                  const row = cur.rows[i];
                  return (
                    <tr key={i} className={picked && !r.counted[i] ? "off" : ""}>
                      <td className="mg-rn">{i + 1}</td>
                      {cols.map((j) => {
                        const c = String(row[j] ?? "");
                        return <td key={j} className={`${pickAt(j) ? "on" : ""} ${isFigure(c) ? "n" : ""}`} title={c.length > 32 ? c : undefined}>{c}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {more > 0 && (
          <button className="ui-link muted" onClick={() => setShowAll(true)}>Show the other {fmtInt(more)} rows</button>
        )}
      </div>
    );
  };

  // ── the saved list ──────────────────────────────────────────────────────────
  const savedList = () => (
    <div className="max-w-[1120px] min-w-0 space-y-4">
      <button onClick={upload} disabled={busy}
        className={`w-full rounded-2xl border border-dashed transition-colors duration-150 flex items-center justify-center text-center disabled:opacity-60 ${
          list && list.length > 0 && !showDeleted ? "py-5 px-6 gap-3" : "py-14 px-6 flex-col"
        } ${dragActive ? "border-ink bg-surface-2" : "border-line-3 hover:border-ink hover:bg-surface-2"}`}>
        <Upload size={18} className="text-ink-2" />
        <span>
          <span className="block text-[14px] font-medium text-ink">{busy ? "Reading…" : dragActive ? "Drop it here" : "Drop a manifest here, or click to browse"}</span>
          <span className="block text-[12.5px] text-muted mt-0.5">CSV, Excel, TSV or a PDF with real text. It opens as a spreadsheet.</span>
        </span>
      </button>

      <Tabs label="Manifests" tabs={[{ id: "saved", label: "Saved" }, { id: "deleted", label: "Deleted" }]} value={showDeleted ? "deleted" : "saved"}
        onChange={(id) => { const d = id === "deleted"; setShowDeleted(d); setList(null); loadList(d); }} />

      {list === null ? <p className="text-[13px] text-muted">Loading…</p> : list.length === 0 ? (
        <p className="text-[13px] text-muted">{showDeleted ? "Nothing has been deleted." : "Nothing saved yet. Open a manifest and press Save to keep it here."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ui-table">
            <thead>
              <tr>
                <th>Manifest</th>
                <th>Date</th>
                <th className="r">Units</th>
                <th className="r">Price</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const t = totalsOf(m);
                const isBusy = working === m.id;
                return (
                  <tr key={m.id}>
                    <td className="text-ink">
                      {renaming?.id === m.id ? (
                        <input autoFocus className="h-8 px-2.5 rounded-lg border border-line-3 bg-transparent text-[13px] outline-none focus:border-ink w-56"
                          value={renaming.text} onChange={(e) => setRenaming({ id: m.id, text: e.target.value })} onBlur={commitRename}
                          onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }} />
                      ) : (
                        <>
                          <div className="font-medium truncate max-w-[260px] xl:max-w-[420px]" title={m.name}>{m.name}</div>
                          {m.source_name && <div className="text-[11.5px] text-muted truncate max-w-[260px] xl:max-w-[420px]">{m.source_name}</div>}
                        </>
                      )}
                    </td>
                    <td className="text-muted whitespace-nowrap">{fmtDay(m.created_at)}</td>
                    <td className="r">{t.units > 0 ? fmtInt(t.units) : "-"}</td>
                    <td className="r">{t.price > 0 ? fmtAmount(t.price) : "-"}</td>
                    <td>
                      <span className="flex items-center justify-end gap-3">
                        {showDeleted ? (
                          <button onClick={() => restore(m.id)} className="ui-link muted">Restore</button>
                        ) : (
                          <>
                            <button onClick={() => openSaved(m)} disabled={isBusy} className="ui-link disabled:opacity-50">{isBusy ? "Opening…" : "Open"}</button>
                            <button onClick={() => setRenaming({ id: m.id, text: m.name })} className="ui-link muted">Rename</button>
                            <button onClick={() => remove(m)} className="ui-link muted">Delete</button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageActions>
        {open?.path && (
          <Button onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            setSaveBox(saveBox ? null : { name: open.title, x: Math.min(b.left, window.innerWidth - 300), y: b.bottom + 6 });
          }}>{open.saved ? "Save changes" : "Save"}</Button>
        )}
        <Button variant="ink" onClick={upload} disabled={busy} icon={<Upload size={14} />}>
          {busy ? "Reading…" : open ? "Open another" : "Open a manifest"}
        </Button>
      </PageActions>

      {dragActive && open && (
        <div className="fixed inset-0 z-40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-ink bg-surface px-8 py-6 text-center">
            <p className="text-[15px] font-medium text-ink">Drop to open this manifest</p>
            <p className="text-[12px] text-muted mt-1">It replaces the one on screen.</p>
          </div>
        </div>
      )}

      {open ? sheet() : savedList()}

      {menu && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} />
          <div className="ui-pop" style={{ position: "fixed", left: menu.x, top: menu.y }} role="menu">
            {PICKS.map((p) => (
              <button key={p.id} className="ui-pop-item" role="menuitem" onClick={() => choose(menu.col, p.id)}>
                {p.label}
                {pk[p.id] === menu.col && <Check size={14} />}
              </button>
            ))}
            {pickAt(menu.col) && (
              <button className="ui-pop-item" role="menuitem" onClick={() => choose(menu.col, null)}>
                <span className="text-muted">Not needed</span>
              </button>
            )}
          </div>
        </>
      )}

      {saveBox && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setSaveBox(null)} />
          <form className="ui-pop p-3 space-y-2.5 w-[280px]" style={{ position: "fixed", left: saveBox.x, top: saveBox.y }}
            onSubmit={(e) => { e.preventDefault(); save(saveBox.name); }}>
            <label className="block">
              <span className="ui-label block mb-1">Name</span>
              <input autoFocus value={saveBox.name} onChange={(e) => setSaveBox({ ...saveBox, name: e.target.value })}
                className="h-8 w-full px-2.5 rounded-lg border border-line-3 bg-transparent text-[13px] outline-none focus:border-ink" />
            </label>
            <Button type="submit" variant="ink" block>{open?.saved ? "Save changes" : "Save"}</Button>
          </form>
        </>
      )}

      {undo && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] bg-ink text-surface text-[13px] rounded-xl px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.18)] flex items-center gap-4">
          <span className="truncate max-w-[320px]">Deleted {undo.name}.</span>
          <button onClick={() => restore(undo.id)} className="font-medium underline shrink-0">Undo</button>
        </div>
      )}
    </div>
  );
}
