import { useEffect, useState } from "react";
import { Clipboard, Layers, Plus, Truck } from "lucide-react";
import {
  api, ComingBuy, ManifestAnalysis, ManifestCheck, ManifestColumnMap, ManifestColumnMapRecord, ManifestReadOptions,
  ManifestRule, SavedManifest,
} from "../../lib/api";
import { fmtAmount } from "../../lib/format";
import { copyText, COPY_FAILED } from "../../lib/clipboard";
import { toast } from "../Toast";
import ManifestSplit from "../ManifestSplit";
import Breakdown from "./Breakdown";
import ChecksStrip from "./ChecksStrip";
import ColumnMap from "./ColumnMap";
import PagesSections, { SectionChoice } from "./PagesSections";
import Review from "./Review";
import {
  fileBase, fmtDay, fmtInt, isUnplaced, loadSettings, num, placedCounts, ResaleSettings, S, sheetAsk, storeSettings,
} from "./shared";

/** One manifest being read, or one saved manifest being looked at. */
export interface SessionData {
  /** Changes with every new manifest, so this screen starts fresh. */
  key: number;
  /** The file to read from; null when a saved manifest's file is not on this computer. */
  path: string | null;
  options: ManifestReadOptions;
  analysis: ManifestAnalysis;
  saved: SavedManifest | null;
  mappedLike: ManifestColumnMapRecord | null;
  /** The reading changed since it was saved. */
  dirty: boolean;
}

export interface SaveForm { name: string; supplier: string; ask: number | null }

const jump = (id: string) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

export default function Session({ s, busy, onReread, onSave, onRefreshSaved, onBack, onNavigate }: {
  s: SessionData;
  busy: boolean;
  onReread: (patch: Partial<ManifestReadOptions>, refreshRules?: boolean) => Promise<void>;
  onSave: (form: SaveForm, ownSections: { key: string; name: string }[]) => Promise<void>;
  onRefreshSaved: () => Promise<void>;
  onBack: () => void;
  onNavigate: (t: any) => void;
}) {
  const a = s.analysis, saved = s.saved, d = a.detection;
  const [settings, setSettings] = useState<ResaleSettings>(loadSettings);
  const [ask, setAsk] = useState(() => {
    if (saved?.ask != null) return String(saved.ask);
    const v = sheetAsk(a);
    return v != null ? v.toFixed(2) : "";
  });
  const [name, setName] = useState(saved?.name ?? (s.path ? fileBase(s.path) : ""));
  const [supplier, setSupplier] = useState(saved?.supplier ?? "");
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, SectionChoice>>({});
  const [mapOpen, setMapOpen] = useState(false);
  const [rowFilter, setRowFilter] = useState<number[] | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [max, setMax] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [whOpen, setWhOpen] = useState(false);
  const [buys, setBuys] = useState<ComingBuy[] | null>(null);
  const [buyId, setBuyId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => { api.listSuppliers().then((x) => setSuppliers(x.map((y) => y.name).filter(Boolean))).catch(() => {}); }, []);

  const changeSettings = (next: ResaleSettings) => { setSettings(next); storeSettings(next); };
  const choiceOf = (k: string): SectionChoice => choices[k] ?? "part";

  // A sheet the reader could not map shows only the map until it is confirmed.
  const mustMap = a.needs_map && !s.options.columns;

  const togglePage = (pname: string) => {
    const on = (a.pages || []).filter((p) => p.read).map((p) => p.name);
    onReread({ pages: on.includes(pname) ? on.filter((n) => n !== pname) : [...on, pname] });
  };
  const choose = (key: string, v: SectionChoice) => {
    const next = { ...choices, [key]: v };
    setChoices(next);
    onReread({ sections_off: (a.sections || []).filter((x) => (next[x.key] ?? "part") !== "part").map((x) => x.key) });
  };
  const applyMap = (map: ManifestColumnMap) => { setMapOpen(false); onReread({ columns: map }); };
  const applyRules = async (rules: ManifestRule[]) => {
    try {
      await api.saveManifestRules(rules);
      await onReread({}, true);
    } catch (e: any) { toast(String(e), "error"); }
  };
  const fix = (c: ManifestCheck) => {
    if (c.fix === "columns") { setMapOpen(true); jump("mf-columns"); }
    else if (c.fix === "pages") jump("mf-pages");
    else if (c.fix === "lines") { setRowFilter(c.rows.length ? c.rows : null); jump("mf-products"); }
  };

  const counts = placedCounts(a);
  const hasGroups = (a.review?.groups?.length || 0) > 0;
  const ownSections = (a.sections || []).filter((x) => choiceOf(x.key) === "own").map((x) => ({ key: x.key, name: x.name }));
  const askN = num(ask);
  // The reader's notes, each printed once, here and nowhere else.
  const notes = [...new Set([d.note, a.skipped_note || (a.skipped_rows > 0 ? `${fmtInt(a.skipped_rows)} rows left out.` : null)].filter((x): x is string => !!x))];

  const save = async () => {
    if (!name.trim()) { toast("Give the manifest a name first.", "error"); return; }
    setSaving(true);
    try { await onSave({ name: name.trim(), supplier: supplier.trim(), ask: askN }, ownSections); } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };
  const saveChanges = async () => {
    if (!saved) return;
    setSaving(true);
    try {
      if (s.dirty) await onSave({ name: name.trim() || saved.name, supplier: supplier.trim(), ask: askN }, []);
      else { await api.updateManifest(saved.id, { name: name.trim() || saved.name, ask: askN }); await onRefreshSaved(); toast("Saved."); }
    } catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const sendToInventory = () => {
    if (!saved) return;
    // Public-safe summary the storefront can render: internal retail and cost excluded.
    const summary = {
      units: Math.round(a.total_quantity) || a.total_items || 0,
      lines: a.total_items || 0,
      // "Uncategorized" says nothing to a buyer, so it stays off the storefront.
      categories: (a.categories || [])
        .filter((c) => c && c.name && !isUnplaced(c.name))
        .map((c) => ({ name: c.name, quantity: Math.round(c.quantity || 0) })),
    };
    const cost = askN ?? 0;
    const detail = {
      name: saved.name,
      quantity: Math.round(a.total_quantity) || a.total_items || 1,
      total_cost: cost,
      price_type: "total",
      manifest: summary,
      manifest_id: saved.id,
      manifest_file: saved.file_path || s.path || undefined,
    };
    if (!cost) toast("No asking price entered, so the lot's cost is left blank.");
    // Inventory is not mounted until the tab switch, so it picks this up from here.
    sessionStorage.setItem("inventory_prefill_lot", JSON.stringify(detail));
    window.dispatchEvent(new CustomEvent("inventory-prefill-lot", { detail }));
    onNavigate("inventory");
  };

  const openWarehouse = () => {
    setWhOpen((o) => !o);
    if (buys === null) api.listWarehouseBuys().then((r) => setBuys(r.coming || [])).catch(() => setBuys([]));
  };
  const sendToWarehouse = async () => {
    if (!saved) return;
    setSending(true);
    try {
      const load = await api.manifestToLoad(saved.id, buyId);
      toast(`Delivery "${load?.name || saved.name}" is ready in the Warehouse.`);
      await onRefreshSaved();
      onNavigate("warehouse");
    } catch (e: any) { toast(String(e), "error"); }
    setSending(false);
  };

  const input = S.input;

  return (
    <div className="max-w-[1120px] min-w-0 space-y-6">
      {/* Where this came from */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-ink truncate">{saved?.name || name || "New manifest"}</p>
          <p className="text-[12px] text-muted">
            {saved ? `Saved ${fmtDay(saved.created_at)}${saved.supplier ? `, ${saved.supplier}` : ""}.` : "Not saved yet."}
            {s.dirty ? " You changed how it is read, so save again to keep it." : ""}
          </p>
        </div>
        {busy && <span className="text-[12px] text-muted">Reading…</span>}
      </div>

      <ChecksStrip checks={a.checks || []} onFix={fix} />

      {mustMap && (
        <ColumnMap analysis={a} mappedLike={null} forced busy={busy} onApply={applyMap} />
      )}

      <PagesSections analysis={a} choices={choices} busy={busy} onTogglePage={togglePage} onChoice={choose} />

      {!mustMap && (
        <>
          <Review analysis={a} busy={busy} onApply={applyRules} />

          <Breakdown analysis={a} settings={settings} onSettings={changeSettings} ask={ask} onAsk={setAsk}
            rowFilter={rowFilter} onClearFilter={() => setRowFilter(null)} onJumpReview={() => jump("mf-review")} onMax={setMax} />

          {/* How it was read */}
          <section className={S.card}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11.5px] font-medium text-ink-2">Read as {d.format}</p>
                <p className="text-[11px] text-muted mt-1 leading-relaxed">
                  {[
                    d.sheet ? `Sheet ${d.sheet}` : null,
                    d.header_row > 0 ? `Headings on row ${d.header_row}` : null,
                    d.description_col ? `Description = ${d.description_col}` : null,
                    `Units = ${d.quantity_col ?? "none, 1 per line"}`,
                    d.cost_col ? `Cost = ${d.cost_col}` : null,
                    d.price_col ? `Retail = ${d.price_col}${d.price_is_extended ? " (whole line)" : ""}` : null,
                    d.category_col ? `Category = ${d.category_col}` : null,
                    d.brand_col ? `Brand = ${d.brand_col}` : null,
                    d.code_col ? `Code = ${d.code_col}` : null,
                    d.condition_col ? `Condition = ${d.condition_col}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                {s.mappedLike && <p className="text-[11.5px] text-ink-2 mt-1">Mapped like {s.mappedLike.name}{fmtDay(s.mappedLike.created_at) ? `, ${fmtDay(s.mappedLike.created_at)}` : ""}.</p>}
                {notes.map((n) => <p key={n} className="text-[11px] text-ink-2 mt-1.5 leading-relaxed">{n}</p>)}
              </div>
              <button onClick={() => { setMapOpen((o) => !o); if (!mapOpen) jump("mf-columns"); }} disabled={!s.path}
                title={s.path ? "" : "The original file is not on this computer"}
                className="shrink-0 text-[12px] text-ink-2 border border-line-3 bg-surface hover:border-accent hover:text-accent px-3 h-7 rounded-lg disabled:opacity-50">
                {mapOpen ? "Close" : "Edit"}
              </button>
            </div>
          </section>
          {mapOpen && <ColumnMap analysis={a} mappedLike={s.mappedLike} forced={false} busy={busy} onApply={applyMap} />}

          {/* Save, then send it on */}
          <section className="pt-4 border-t border-line space-y-4">
            {(!saved || s.dirty) && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-4">
                  <label className="text-[11.5px] text-muted">
                    <span className="block mb-1">Name</span>
                    <input className={`${input} w-64`} value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="text-[11.5px] text-muted">
                    <span className="block mb-1">Supplier</span>
                    <input className={`${input} w-52`} value={supplier} list="mf-suppliers" onChange={(e) => setSupplier(e.target.value)} />
                    <datalist id="mf-suppliers">{suppliers.map((x) => <option key={x} value={x} />)}</datalist>
                  </label>
                  <label className="text-[11.5px] text-muted">
                    <span className="block mb-1">Asking price</span>
                    <input className={`${input} w-32`} value={ask} placeholder="$" onChange={(e) => setAsk(e.target.value)} />
                  </label>
                  <button onClick={save} disabled={saving || busy || !s.path}
                    className={S.btnPrimary}>
                    {saving ? "Saving…" : saved ? "Save the new reading" : ownSections.length ? `Save ${ownSections.length + 1} manifests` : "Save manifest"}
                    {counts.list > 0 ? `, ${fmtInt(counts.list)} only suggested` : ""}
                  </button>
                </div>
                {(counts.list > 0 || counts.none > 0) && (
                  <p className="text-[12px] text-ink-2 max-w-[720px]">
                    {counts.list > 0 ? `${fmtInt(counts.list)} line${counts.list === 1 ? " is" : "s are"} placed only by a suggestion and will be saved marked Suggested. ` : ""}
                    {counts.none > 0 ? `${fmtInt(counts.none)} line${counts.none === 1 ? " is" : "s are"} unplaced. ` : ""}
                    {hasGroups ? "The review above turns them into rules." : counts.none > 0 ? "Place the rest above to turn them into rules." : ""}
                  </p>
                )}
              </div>
            )}
            {saved && !s.dirty && (
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-[11.5px] text-muted">
                  <span className="block mb-1">Name</span>
                  <input className={`${input} w-64`} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="text-[11.5px] text-muted">
                  <span className="block mb-1">Asking price</span>
                  <input className={`${input} w-32`} value={ask} placeholder="$" onChange={(e) => setAsk(e.target.value)} />
                </label>
                <button onClick={saveChanges} disabled={saving || (name.trim() === saved.name && (askN ?? null) === (saved.ask ?? null))} className={S.btn}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            )}

            {saved && !s.dirty && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={sendToInventory} disabled={!!saved.lot_id} className={S.btnPrimary}>
                    <Plus size={14} /> Send to Inventory{askN ? ` at ${fmtAmount(askN)} cost` : ""}
                  </button>
                  <button onClick={openWarehouse} disabled={!!saved.load_id}
                    className={`border px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50 ${whOpen ? "border-accent text-accent" : "text-ink-2 border-line-3 hover:border-accent hover:text-accent"}`}>
                    <Truck size={13} /> Send to the Warehouse
                  </button>
                  {max != null && (
                    <button onClick={() => copyText(max.toFixed(2)).then((ok) => { if (ok) toast("Most you can pay copied."); else toast(COPY_FAILED, "error"); })} className={S.btn}>
                      <Clipboard size={12} /> Copy most you can pay
                    </button>
                  )}
                  {s.path && !d.format.startsWith("pdf") && (
                    <button onClick={() => setSplitOpen((o) => !o)}
                      className={`border px-3.5 h-9 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors ${splitOpen ? "border-accent text-accent" : "text-ink-2 border-line-3 hover:border-accent hover:text-accent"}`}>
                      <Layers size={12} /> Split into separate manifests
                    </button>
                  )}
                </div>
                {(saved.lot_id || saved.load_id) && (
                  <p className="text-[12px] text-muted">
                    {saved.lot_id ? "This manifest is already a lot in Inventory. " : ""}{saved.load_id ? "This manifest is already a delivery in the Warehouse." : ""}
                  </p>
                )}
                {whOpen && !saved.load_id && (
                  <div className={`${S.card} max-w-[640px] space-y-2`}>
                    <p className="text-[12.5px] text-ink-2">Make a delivery from this manifest: one line per product, with its units and cost. Is it for a buy that is on the way?</p>
                    <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                      <input type="radio" name="mf-buy" checked={buyId === null} onChange={() => setBuyId(null)} /> No buy, just a delivery
                    </label>
                    {(buys || []).map((b) => (
                      <label key={b.id} className="flex items-center gap-2 text-[12.5px] text-ink-2">
                        <input type="radio" name="mf-buy" checked={buyId === b.id} onChange={() => setBuyId(b.id)} />
                        <span className="truncate">{b.name}</span>
                        <span className="text-muted tabular-nums whitespace-nowrap">{b.supplier_name ? `${b.supplier_name}, ` : ""}{fmtInt(b.units_bought)} units</span>
                      </label>
                    ))}
                    {buys === null && <p className="text-[12px] text-muted">Looking for buys on the way…</p>}
                    {buys !== null && buys.length === 0 && <p className="text-[12px] text-muted">No buys are on the way right now.</p>}
                    <button onClick={sendToWarehouse} disabled={sending} className={S.btnPrimary}>{sending ? "Sending…" : "Make the delivery"}</button>
                  </div>
                )}
              </div>
            )}
            <button onClick={onBack} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Back to saved manifests</button>
          </section>
        </>
      )}

      {/* Wider than the breakdown: the split table carries a price editor per row. */}
      {splitOpen && s.path && !d.format.startsWith("pdf") && (
        <div className="max-w-[1120px] mt-4"><ManifestSplit path={s.path} onNavigate={onNavigate} /></div>
      )}
      {mustMap && (
        <button onClick={onBack} className="text-[12px] text-muted hover:text-ink-2 px-3 h-9 rounded-lg hover:bg-surface-2">Back to saved manifests</button>
      )}
    </div>
  );
}
