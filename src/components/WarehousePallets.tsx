// R-346: a product's pallet and box measurements, and what fits.
// Jack types the pallet (footprint, its own height, the most it may stand from the floor) and each
// box size's outside measurements; the fitter (pallet_fit.rs, in Rust, the same on the phone's
// server) says how many of each fit a pallet and draws that pallet box by box. Saving the
// measurements makes the biggest box's count the pallet size Plan a load and the map use.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  DEFAULT_PALLET, feet, fitTypes, inches, palletReady, parseInches,
  type BoxSize, type Capacity, type PalletSetup, type PalletSpec,
} from "../lib/palletFit";
import { bigBox, type WarehouseItem } from "../lib/warehouse";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, n0, teamColor } from "./warehouseUi";

const PalletView3D = lazy(() => import("./PalletView3D"));

const same = (a: PalletSetup, b: PalletSetup) => JSON.stringify(a) === JSON.stringify(b);

/** A measurement box: keeps what is typed, shows when it cannot be read, reports inches or null. */
function InchField({ value, onValue, label, hint }: { value: number; onValue: (v: number | null) => void; label: string; hint?: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  const text = raw ?? (value > 0 ? inches(value) : "");
  const bad = raw !== null && raw.trim() !== "" && parseInches(raw) === null;
  return (
    <label className="block min-w-0">
      <span className="block text-[12px] text-muted mb-1.5">{label}</span>
      <input type="text" inputMode="decimal" value={text} placeholder="in" aria-invalid={bad}
        onChange={(e) => { setRaw(e.target.value); onValue(e.target.value.trim() === "" ? 0 : parseInches(e.target.value)); }}
        onBlur={() => { if (!bad) setRaw(null); }}
        style={{ background: "var(--t-input-bg)" }}
        className={`w-full border px-3 h-9 rounded-lg text-[13px] text-ink tabular-nums placeholder:text-faint focus:outline-none focus:ring-2 transition-colors ${bad ? "border-danger focus:ring-danger/30" : "border-line focus:ring-accent/40 focus:border-accent"}`} />
      {bad ? <span className="block text-[11px] text-danger-ink mt-1">Type inches, like 23.5 or 23 1/2</span> : hint ? <span className="block text-[11px] text-muted mt-1">{hint}</span> : null}
    </label>
  );
}

export default function PalletsTab({ item, onChanged }: { item: WarehouseItem; onChanged: (it: WarehouseItem) => void }) {
  const saved = useMemo<PalletSetup>(() => {
    const p = item.pallet;
    return { pallet: { ...DEFAULT_PALLET, ...(p?.pallet && p.pallet.length > 0 ? p.pallet : {}) }, boxes: { ...(p?.boxes || {}) } };
  }, [item.pallet]);
  const [draft, setDraft] = useState<PalletSetup>(saved);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [caps, setCaps] = useState<Capacity[] | null>(null);
  const [capError, setCapError] = useState("");
  const [shown, setShown] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // Bumped on Undo and Save, so every field drops what was typed into it and shows the numbers.
  const [fieldsKey, setFieldsKey] = useState(0);
  const big = bigBox(item.box_types);
  const dirty = !same(draft, saved);

  // A new version from another device replaces the form, unless Jack has typed into it (R-346
  // review: "differs from what is saved" is not the test — an incoming change differs too).
  const edited = useRef(false);
  useEffect(() => { if (!edited.current) { setDraft(saved); setInvalid(new Set()); setFieldsKey((k) => k + 1); } }, [saved]);

  const setPallet = (k: keyof PalletSpec, key: string) => (v: number | null) => {
    edited.current = true;
    setInvalid((s) => { const n = new Set(s); if (v === null) n.add(key); else n.delete(key); return n; });
    if (v !== null) setDraft((d) => ({ ...d, pallet: { ...d.pallet, [k]: v } }));
  };
  const setBox = (id: string, k: keyof BoxSize, key: string) => (v: number | boolean | null) => {
    edited.current = true;
    setInvalid((s) => { const n = new Set(s); if (v === null) n.add(key); else n.delete(key); return n; });
    if (v === null) return;
    setDraft((d) => {
      const cur: BoxSize = d.boxes[id] || { length: 0, width: 0, height: 0, side_ok: false };
      return { ...d, boxes: { ...d.boxes, [id]: { ...cur, [k]: v } } };
    });
  };

  // What fits, worked out as the measurements are typed (the same fitter the save uses).
  const types = useMemo(() => fitTypes({ box_types: item.box_types, pallet: draft }), [item.box_types, draft]);
  useEffect(() => {
    if (!palletReady(draft.pallet) || !types.length) { setCaps(null); setCapError(""); return; }
    let stale = false;
    const t = setTimeout(() => {
      api.warehousePalletCapacity(draft.pallet, types)
        .then((c) => { if (!stale) { setCaps(c); setCapError(""); } })
        .catch((e) => { if (!stale) { setCaps(null); setCapError(String(e)); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [draft.pallet, types]);

  const capOf = (id: string) => caps?.find((c) => c.type_id === id);
  const view = capOf(shown) || (big ? capOf(big.id) : undefined) || caps?.[0];
  const viewType = item.box_types.find((t) => t.id === view?.type_id);
  const load = draft.pallet.max_height - draft.pallet.deck;

  const save = async () => {
    if (invalid.size) { toast("Fix the measurements marked in red first", "error"); return; }
    setBusy(true);
    try {
      const it = await api.saveWarehouseItem({
        id: item.id, name: item.name, section_label: item.section_label, box_types: item.box_types, sections: item.sections,
        units_per_pallet: item.units_per_pallet, unit_price: item.unit_price, notes: item.notes, pallet: draft,
      });
      edited.current = false;
      setFieldsKey((k) => k + 1);
      onChanged(it);
      const c = big ? capOf(big.id) : undefined;
      toast(c && big ? `Saved. A pallet holds ${n0(c.boxes)} ${big.name} — Plan a load and the map use it now.` : "Measurements saved");
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  if (!item.box_types.length) {
    return <div className={`${WH_CARD} p-5 text-[13px] text-muted`}>Add the product's box sizes first (Edit product), then measure them here.</div>;
  }

  return (
    <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 items-start">
      <div className="space-y-4 min-w-0">
        <div className={`${WH_CARD} p-5`}>
          <div className="text-[14px] font-semibold text-ink">The pallet</div>
          <p className="text-[12.5px] text-ink-2 mt-0.5">Nothing goes past its edge; the load stops at the height you give.</p>
          <div key={`p${fieldsKey}`} className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
            <InchField label="Length" value={draft.pallet.length} onValue={setPallet("length", "p:l")} />
            <InchField label="Width" value={draft.pallet.width} onValue={setPallet("width", "p:w")} />
            <InchField label="Pallet's own height" value={draft.pallet.deck} onValue={setPallet("deck", "p:d")} />
            <InchField label="Most from the floor" value={draft.pallet.max_height} onValue={setPallet("max_height", "p:h")}
              hint={draft.pallet.max_height > 0 ? feet(draft.pallet.max_height) : "The tallest it can be"} />
          </div>
          {palletReady(draft.pallet)
            ? <p className="text-[12px] text-muted mt-3 tabular-nums">Room for boxes: {inches(load)} in ({feet(load)}) above the deck.</p>
            : <p className="text-[12px] text-warning-ink mt-3">{draft.pallet.max_height > 0 ? "The most from the floor must be above the pallet's own height." : "Enter the most the pallet may stand from the floor to see what fits."}</p>}
        </div>

        <div className={`${WH_CARD} overflow-hidden`}>
          <div className="px-5 pt-4 pb-2">
            <div className="text-[14px] font-semibold text-ink">Box sizes</div>
            <p className="text-[12.5px] text-ink-2 mt-0.5">Outside measurements. A box stands the way it is measured unless it may lie on its side.</p>
          </div>
          <div className="divide-y divide-line">
            {item.box_types.map((t) => {
              const b = draft.boxes[t.id] || { length: 0, width: 0, height: 0, side_ok: false };
              const c = capOf(t.id);
              const measured = b.length > 0 && b.width > 0 && b.height > 0;
              return (
                <div key={`${t.id}:${fieldsKey}`} className="px-5 py-3.5">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <div className="text-[13px] text-ink font-medium">{t.name} <span className="text-muted font-normal">of {t.per_box}</span></div>
                    <div className="text-[12.5px] tabular-nums">
                      {c ? <button onClick={() => setShown(t.id)} className={`hover:underline ${view?.type_id === t.id ? "text-ink font-semibold" : "text-ink-2"}`}>
                            {n0(c.boxes)} a pallet · {c.per_layer} a layer × {c.layers}{c.top_boxes ? ` + ${c.top_boxes} on their sides` : ""}
                          </button>
                        : !measured ? <span className="text-muted">Not measured</span>
                        : !palletReady(draft.pallet) ? <span className="text-muted">Waiting for the pallet</span>
                        : capError ? <span className="text-danger-ink">Could not be worked out</span>
                        : caps ? <span className="text-danger-ink">Does not fit on this pallet</span>
                        : <span className="text-muted">Working it out…</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5 mt-2.5">
                    <InchField label="Length" value={b.length} onValue={setBox(t.id, "length", `${t.id}:l`)} />
                    <InchField label="Width" value={b.width} onValue={setBox(t.id, "width", `${t.id}:w`)} />
                    <InchField label="Height" value={b.height} onValue={setBox(t.id, "height", `${t.id}:h`)} />
                  </div>
                  <label className="inline-flex items-center gap-2 mt-2.5 text-[12.5px] text-ink-2 cursor-pointer select-none">
                    <input type="checkbox" checked={b.side_ok} onChange={(e) => setBox(t.id, "side_ok", `${t.id}:s`)(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
                    May lie on its side
                  </label>
                </div>
              );
            })}
          </div>
          <div className="px-5 py-3.5 border-t border-line flex items-center gap-2 flex-wrap bg-surface-2/40">
            <button onClick={save} disabled={!dirty || busy || invalid.size > 0} className={WH_BTN_PRIMARY}>{busy ? "Saving…" : "Save measurements"}</button>
            {(dirty || invalid.size > 0) && <button onClick={() => { edited.current = false; setDraft(saved); setInvalid(new Set()); setFieldsKey((k) => k + 1); }} className={WH_BTN_SECONDARY}>Undo changes</button>}
            {big && capOf(big.id) && <span className="text-[12px] text-muted">{dirty ? "Once saved, a" : "A"} pallet is {n0(capOf(big.id)!.boxes)} {big.name} everywhere — Plan a load, Build this lot and the map.</span>}
          </div>
        </div>
      </div>

      <div className={`${WH_CARD} p-5 min-w-0`}>
        {capError ? <p className="text-[13px] text-danger-ink">{capError}</p>
          : !view || !viewType ? <p className="text-[13px] text-muted">Measure the pallet and a box size to see a full pallet of it here, box by box.</p>
          : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="text-[14px] font-semibold text-ink">A full pallet of {viewType.name}</div>
                {caps && caps.length > 1 && (
                  <div className="flex gap-1 flex-wrap">
                    {caps.map((c) => {
                      const tt = item.box_types.find((x) => x.id === c.type_id);
                      return <button key={c.type_id} onClick={() => setShown(c.type_id)}
                        className={`px-2.5 h-7 rounded-md text-[12px] border whitespace-nowrap ${c.type_id === view.type_id ? "border-accent text-ink bg-surface-2" : "border-line text-muted hover:text-ink-2"}`}>{tt?.name ?? "Box"}</button>;
                    })}
                  </div>
                )}
              </div>
              <p className="text-[12.5px] text-ink-2 tabular-nums">
                {n0(view.boxes)} boxes · {view.per_layer} a layer, {view.layers} {view.layers === 1 ? "layer" : "layers"}{view.top_boxes ? `, then ${view.top_boxes} on their sides on top` : ""}{view.on_side ? " (lying on their sides)" : ""} · {n0(view.boxes * viewType.per_box)} units · {inches(view.total_height)} in from the floor
                {view.layer_is_best && <span className="text-muted"> · no layer can hold more</span>}
              </p>
              <Suspense fallback={<div className="h-[340px] rounded-lg border border-line grid place-items-center text-[12px] text-muted">Drawing the pallet…</div>}>
                <PalletView3D pallet={view.pallet} spec={draft.pallet} colorOf={() => teamColor(`t:${viewType.id}`)} labelOf={() => viewType.name} typeName={() => viewType.name} />
              </Suspense>
            </div>
          )}
      </div>
    </div>
  );
}
