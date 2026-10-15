// R-519: deliveries. A truckload read from its manifest (every tab: brand, group, style, colour,
// cost, MSRP and the pairs expected in each size), then every case received onto its numbered
// pallet, and what came in against what the manifest lists. Reading, checking a case and every
// count are case_core.rs (byte-identical on the server); this only draws. The phone twin is
// www/app.js whd*.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FileSpreadsheet, Plus, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { bucketLine, bucketName, buckets, byStyle, lineDesc, lineMatches, lineStatus, lineTitle, pctRate, pendingTakeKey, pickKey, type Bucket, type CaseLine, type LineCount, type LineLeft, type LoadDetail, type LoadLine, type LoadOut, type LoadSummary, type ManifestRead, type Pick, type WhCase } from "../lib/deliveries";
import { INVOICE_PREFILL_KEY, type InvoicePrefill } from "../lib/warehouse";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Seg } from "./WarehouseProduct";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

const SHEET_EXTS = ["csv", "tsv", "txt", "xlsx", "xlsm", "xls", "ods"];
const BAR = { background: "rgb(var(--c-chart-1))" };
const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const many = (n: number, one: string, more: string) => `${n0(n)} ${n === 1 ? one : more}`;

type Block = { line_id: string; qty: Record<string, number>; all?: boolean };
type Draft = { id: string | null; number: number | null; pallet: string; blocks: Block[]; notes: string; copies: string };

const blocksOf = (contents: CaseLine[]): Block[] => byStyle(contents).map((g) => ({ line_id: g.line_id, qty: Object.fromEntries(g.sizes) }));
const draftTotal = (d: Draft) => d.blocks.reduce((a, b) => a + Object.values(b.qty).reduce((x, y) => x + (y || 0), 0), 0);

export default function WarehouseDeliveries({ dropped }: { dropped: { path: string; n: number } | null }) {
  const [list, setList] = useState<LoadSummary[] | null>(null);
  const [detail, setDetail] = useState<LoadDetail | null>(null);
  const [preview, setPreview] = useState<{ read: ManifestRead; fileName: string } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState(false);

  const loadList = useCallback(() => api.listWarehouseLoads().then(setList).catch((e) => { toast(`Couldn't load the deliveries: ${e}`, "error"); setList([]); }), []);
  useEffect(() => { loadList(); }, [loadList]);

  // A case save answers without the lines (they did not change): keep the ones on hand.
  const merge = useCallback((next: LoadDetail) => setDetail((prev) => ({ ...next, load: { ...next.load, lines: next.load.lines ?? (prev && prev.load.id === next.load.id ? prev.load.lines : []) } })), []);

  // Live: cases added on the phone (or another desktop) land here as soon as they sync.
  const openId = detail?.load.id ?? null;
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("netsync-applied", () => {
      loadList();
      if (openId && !editing) api.getWarehouseLoad(openId).then(merge).catch(() => {});
    }).then((u) => { un = u; }).catch(() => {});
    return () => un?.();
  }, [loadList, openId, editing, merge]);

  const openManifest = useCallback(async (path: string) => {
    try {
      const read = await api.readLoadManifest(path);
      setPreview({ read, fileName: path.split(/[\\/]/).pop() || "Manifest" });
    } catch (e) { toast(String(e), "error"); }
  }, []);
  useEffect(() => { if (dropped) openManifest(dropped.path); }, [dropped, openManifest]);
  const pick = async () => {
    const f = await openDialog({ multiple: false, filters: [{ name: "Manifest", extensions: SHEET_EXTS }] });
    if (typeof f === "string") openManifest(f);
  };
  const open = (id: string) => api.getWarehouseLoad(id).then((d) => setDetail(d)).catch((e) => toast(String(e), "error"));

  if (preview) {
    return <ManifestPreview read={preview.read} fileName={preview.fileName} onCancel={() => setPreview(null)}
      onSaved={(d) => { setPreview(null); setDetail(d); loadList(); toast("Delivery saved"); }} />;
  }
  if (detail) {
    return <DeliveryScreen d={detail} merge={merge} setEditing={setEditing} onBack={() => { setDetail(null); loadList(); }} />;
  }

  const live = (list || []).filter((d) => !d.archived), gone = (list || []).filter((d) => d.archived);
  const card = (d: LoadSummary) => {
    const t = d.totals, pct = t.expected > 0 ? Math.min(1, t.received / t.expected) : 0;
    return (
      <button key={d.id} onClick={() => open(d.id)} className={`${WH_CARD} w-full text-left p-4 hover:border-accent/40 transition-colors`}>
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[14px] font-semibold text-ink truncate">{d.name}</div>
          <div className="text-[12px] text-muted whitespace-nowrap"><span className="text-[15px] font-semibold text-ink tabular-nums">{n0(t.received)}</span> of {n0(t.expected)} pairs</div>
        </div>
        <div className="text-[12px] text-muted mt-0.5">{many(t.lines, "style", "styles")} · {many(t.cases, "case", "cases")} on {many(t.pallets, "pallet", "pallets")}{d.source ? ` · ${d.source}` : ""}</div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-3"><div className="h-full rounded-full" style={{ ...BAR, width: `${pct * 100}%` }} /></div>
      </button>
    );
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-[12.5px] text-muted max-w-[640px]">Import a delivery's manifest: every tab is read, each style and colour with its cost, MSRP and the pairs expected in each size. Then add each case onto its pallet as the truck is unloaded.</p>
        <button onClick={pick} className={WH_BTN_PRIMARY} title="Or drop the file anywhere on this screen"><FileSpreadsheet size={14} /> Import a manifest</button>
      </div>
      {list === null ? <div className="text-[13px] text-muted">Loading…</div> : live.length ? (
        <div className="grid gap-3 grid-cols-1 xl:grid-cols-2">{live.map(card)}</div>
      ) : <div className={`${WH_CARD} p-6 text-[13px] text-muted text-center`}>No deliveries yet. Drop a manifest here or use Import a manifest.</div>}
      {gone.length > 0 && <>
        <button onClick={() => setShowRemoved((v) => !v)} className={`${WH_BTN_SECONDARY} mt-4`}>{showRemoved ? "Hide" : "Show"} removed ({gone.length})</button>
        {showRemoved && <div className="grid gap-3 grid-cols-1 xl:grid-cols-2 mt-3 opacity-80">{gone.map(card)}</div>}
      </>}
    </div>
  );
}

// ---- The preview: nothing is saved until Save delivery ---------------------------------

function ManifestPreview({ read, fileName, onCancel, onSaved }: { read: ManifestRead; fileName: string; onCancel: () => void; onSaved: (d: LoadDetail) => void }) {
  const [name, setName] = useState(fileName.replace(/\.[^.]+$/, ""));
  const [busy, setBusy] = useState(false);
  const st = read.stated;
  const stLines = st ? (st.lines ?? read.lines.length) : 0;
  const agrees = st && st.pairs === read.pairs && stLines === read.lines.length;
  const save = async () => {
    setBusy(true);
    try { onSaved(await api.createWarehouseLoad(name, fileName, read.lines)); }
    catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="max-w-[880px]">
      <button onClick={onCancel} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={13} /> Deliveries</button>
      <h2 className="text-[18px] font-semibold text-ink tracking-tight">Import a delivery</h2>
      <p className="text-[12.5px] text-muted mt-0.5">{fileName} · {many(read.lines.length, "style and colour", "styles and colours")} · {n0(read.pairs)} pairs expected</p>
      {st && <p className={`text-[12.5px] mt-2 ${agrees ? "text-muted" : "text-warning-ink"}`}>{agrees
        ? `Matches the ${st.tab} tab: ${many(stLines, "style", "styles")}, ${n0(st.pairs)} pairs.`
        : `The ${st.tab} tab says ${st.lines != null ? many(st.lines, "style", "styles") + " and " : ""}${n0(st.pairs)} pairs. The lines read add up to ${many(read.lines.length, "style", "styles")} and ${n0(read.pairs)} pairs.`}</p>}

      <label className="block mt-4 max-w-[420px]"><span className="text-[12px] text-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>

      <div className="grid gap-4 md:grid-cols-2 mt-5">
        <div className={`${WH_CARD} p-4`}>
          <div className="text-[13px] font-semibold text-ink mb-2">By brand and group</div>
          {read.groups.map((g, k) => (
            <div key={k} className="flex justify-between gap-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px]">
              <span className="text-ink-2">{g.brand}{g.group ? ` · ${g.group}` : ""}</span>
              <span className="text-muted tabular-nums whitespace-nowrap">{many(g.lines, "style", "styles")} · <span className="text-ink font-medium">{n0(g.pairs)}</span> pairs</span>
            </div>
          ))}
        </div>
        <div className={`${WH_CARD} p-4`}>
          <div className="text-[13px] font-semibold text-ink mb-2">Tabs</div>
          {read.tabs.map((t, k) => (
            <div key={k} className="flex justify-between gap-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px]">
              <span className="text-ink-2">{t.name}</span>
              <span className="text-muted tabular-nums text-right">{t.read ? `${many(t.lines, "style", "styles")}, ${n0(t.pairs)} pairs` : t.note}</span>
            </div>
          ))}
        </div>
      </div>

      {read.mismatches.length > 0 && <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[13px] font-semibold text-ink">{read.mismatches.length === 1 ? "1 line has a Total" : `${read.mismatches.length} lines have a Total`} that the sizes do not add up to</div>
        <p className="text-[12px] text-muted mt-0.5 mb-2">Cases are counted by size, so the sizes are kept. Check these when they come off the truck.</p>
        {read.mismatches.map((m) => (
          <div key={m.line_id} className="flex justify-between gap-3 py-1.5 border-t border-line text-[12.5px]">
            <span className="text-ink-2">{[m.style, m.color].filter(Boolean).join(" ")} <span className="text-muted">· {m.source}</span></span>
            <span className="text-muted tabular-nums whitespace-nowrap">sizes {n0(m.sizes)}, Total {n0(m.total)}</span>
          </div>
        ))}
      </div>}
      {read.warnings.length > 0 && <div className={`${WH_CARD} p-4 mt-4`}>
        <div className="text-[13px] font-semibold text-ink mb-1">Left out</div>
        {read.warnings.map((w, k) => <p key={k} className="text-[12px] text-muted">{w}</p>)}
      </div>}

      <div className="flex gap-2 mt-5">
        <button onClick={save} disabled={busy || !read.lines.length || !name.trim()} className={WH_BTN_PRIMARY}>Save delivery</button>
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
      </div>
    </div>
  );
}

// ---- One delivery: its pallets, and against the manifest -------------------------------

function DeliveryScreen({ d, merge, setEditing, onBack }: { d: LoadDetail; merge: (d: LoadDetail) => void; setEditing: (b: boolean) => void; onBack: () => void }) {
  const L = d.load, T = d.tally.totals;
  const lines = useMemo(() => L.lines ?? [], [L.lines]);
  const idx = useMemo(() => Object.fromEntries(lines.map((l) => [l.id, l])) as Record<string, LoadLine>, [lines]);
  const counts = useMemo(() => Object.fromEntries(d.tally.counts.map((c) => [c.line_id, c])) as Record<string, LineCount>, [d.tally.counts]);
  const [tab, setTab] = useState<"pallets" | "check" | "sell">("pallets");
  const [pallet, setPallet] = useState<number | null>(() => d.tally.pallets[0]?.pallet ?? null);
  const [draft, setDraftRaw] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<number[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingLine, setAddingLine] = useState<string | null>(null);
  const [sureRemove, setSureRemove] = useState(false);
  const setDraft = (x: Draft | null) => { setDraftRaw(x); setEditing(!!x); };
  const live = !L.archived;
  const nextPallet = d.tally.pallets.reduce((a, p) => Math.max(a, p.pallet), 0) + 1;

  const update = async (patch: { name?: string; archived?: boolean }) => {
    try { merge(await api.updateWarehouseLoad(L.id, patch)); return true; } catch (e) { toast(String(e), "error"); return false; }
  };
  const startCase = (c: WhCase | null, p?: number) => {
    setSaved(null);
    setDraft(c ? { id: c.id, number: c.number, pallet: String(c.pallet), blocks: blocksOf(c.contents), notes: c.notes, copies: "1" }
      : { id: null, number: null, pallet: String(p ?? pallet ?? nextPallet), blocks: [], notes: "", copies: "1" });
  };
  const saveCase = async () => {
    if (!draft) return;
    const contents: CaseLine[] = [];
    draft.blocks.forEach((b) => Object.entries(b.qty).forEach(([size, pairs]) => { if (pairs > 0) contents.push({ line_id: b.line_id, size, pairs }); }));
    if (!contents.length) { toast("Put at least one pair in the case.", "error"); return; }
    const p = parseInt(draft.pallet, 10);
    if (!(p >= 1)) { toast("Type the pallet number.", "error"); return; }
    try {
      const before = new Set(d.cases.map((c) => c.id));
      const next = await api.saveWarehouseCase(L.id, { caseId: draft.id, pallet: p, contents, notes: draft.notes, copies: draft.id ? 1 : Math.max(1, parseInt(draft.copies, 10) || 1) });
      merge(next);
      setPallet(p);
      if (draft.id) { setDraft(null); toast("Case saved"); return; }
      // The next case starts with the same pairs: most cases off one truck are the same pack.
      setSaved(next.cases.filter((c) => !before.has(c.id)).map((c) => c.number).sort((a, b) => a - b));
      setDraft({ ...draft, pallet: String(p), notes: "", copies: "1" });
    } catch (e) { toast(String(e), "error"); }
  };
  const removeCase = async () => {
    if (!draft?.id) return;
    try { merge(await api.removeWarehouseCase(L.id, draft.id)); setDraft(null); toast("Case removed"); } catch (e) { toast(String(e), "error"); }
  };

  const cs = pallet != null ? d.cases.filter((c) => c.pallet === pallet) : [];
  const ps = d.tally.pallets.find((p) => p.pallet === pallet);

  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={13} /> Deliveries</button>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          {renaming != null ? (
            <div className="flex gap-2 items-center">
              <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} w-[320px]`} />
              <button onClick={async () => { if (await update({ name: renaming })) setRenaming(null); }} className={WH_BTN_PRIMARY}>Save</button>
              <button onClick={() => setRenaming(null)} className={WH_BTN_SECONDARY}>Cancel</button>
            </div>
          ) : <h2 className="text-[18px] font-semibold text-ink tracking-tight">{L.name}</h2>}
          <p className="text-[12px] text-muted mt-0.5 tabular-nums">
            <span className="text-ink-2 font-medium">{n0(T.received)}</span> of {n0(T.expected)} pairs in · {many(T.cases, "case", "cases")} on {many(T.pallets, "pallet", "pallets")}
            {T.received > 0 && <> · {money(T.cost)} cost, {money(T.msrp)} MSRP in</>}
          </p>
          {L.archived && <p className="text-[12px] text-warning-ink mt-1">This delivery was removed. Bring it back to add cases.</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Seg size="md" value={tab} onChange={setTab} options={[{ key: "pallets", label: "Pallets" }, { key: "check", label: "Against the manifest" }, { key: "sell", label: "Sell" }]} />
          {renaming == null && <button onClick={() => setRenaming(L.name)} className={WH_BTN_SECONDARY}>Rename</button>}
          {live && <button onClick={() => setAddingLine("")} className={WH_BTN_SECONDARY}>Add a style not on the manifest</button>}
          {L.archived ? <button onClick={() => update({ archived: false })} className={WH_BTN_SECONDARY}>Bring it back</button>
            : sureRemove ? <>
              <button onClick={async () => { if (await update({ archived: true })) onBack(); }} className={WH_BTN_PRIMARY}>Remove it</button>
              <button onClick={() => setSureRemove(false)} className={WH_BTN_SECONDARY}>Keep it</button>
            </> : <button onClick={() => setSureRemove(true)} className={WH_BTN_SECONDARY} title="It moves under Removed with its cases, and can be brought back">Remove</button>}
        </div>
      </div>

      {addingLine != null && <NewLineForm lines={lines} guess={addingLine} onCancel={() => setAddingLine(null)} onAdd={async (nl) => {
        try {
          const before = new Set(lines.map((l) => l.id));
          const next = await api.addWarehouseLoadLine(L.id, nl);
          merge(next);
          setAddingLine(null);
          const added = (next.load.lines ?? []).find((l) => !before.has(l.id));
          if (draft && added) setDraft({ ...draft, blocks: [...draft.blocks, { line_id: added.id, qty: {} }] });
          else toast("Added to the delivery");
        } catch (e) { toast(String(e), "error"); }
      }} />}

      {tab === "check" ? <CheckView lines={lines} counts={counts} totals={T} /> : tab === "sell" ? <SellView d={d} lines={lines} merge={merge} live={live} /> : (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            {live && <button onClick={() => { setPallet(nextPallet); startCase(null, nextPallet); }} className={`${WH_BTN_SECONDARY} w-full justify-center`}><Plus size={14} /> Start pallet {nextPallet}</button>}
            {d.tally.pallets.map((p) => (
              <button key={p.pallet} onClick={() => { setPallet(p.pallet); setDraft(null); setSaved(null); }}
                className={`${WH_CARD} w-full text-left px-3 py-2.5 transition-colors ${pallet === p.pallet ? "ring-2 ring-accent/40 border-accent/40" : "hover:border-accent/30"}`}>
                <div className="flex justify-between items-baseline gap-2"><span className="text-[13px] font-semibold text-ink">Pallet {p.pallet}</span><span className="text-[12px] text-muted tabular-nums"><span className="text-ink font-medium">{n0(p.pairs)}</span> pairs</span></div>
                <div className="text-[11.5px] text-muted mt-0.5">{many(p.cases, "case", "cases")} · {many(p.styles, "style", "styles")} · {money(p.cost)} cost</div>
              </button>
            ))}
            {!d.tally.pallets.length && <p className="text-[12.5px] text-muted px-1">No cases yet. Start pallet 1, then add each case on it as it comes off the truck.</p>}
          </div>

          <div className="min-w-0 space-y-3">
            {draft ? (
              <CaseEditor draft={draft} setDraft={setDraft} lines={lines} idx={idx} counts={counts} cases={d.cases} saved={saved}
                onSave={saveCase} onRemove={draft.id ? removeCase : undefined} onClose={() => { setDraft(null); setSaved(null); }}
                onNotListed={(q) => setAddingLine(q)} />
            ) : pallet != null && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold text-ink">Pallet {pallet}</div>
                    {ps && <div className="text-[12px] text-muted tabular-nums">{many(ps.cases, "case", "cases")} · {n0(ps.pairs)} pairs · {many(ps.styles, "style", "styles")} · {money(ps.cost)} cost · {money(ps.msrp)} MSRP</div>}
                  </div>
                  {live && <button onClick={() => startCase(null)} className={WH_BTN_PRIMARY}><Plus size={14} /> Add a case</button>}
                </div>
                {cs.map((c) => (
                  <button key={c.id} onClick={() => live && startCase(c)} disabled={!live} className={`${WH_CARD} w-full text-left p-3.5 hover:border-accent/30 transition-colors disabled:hover:border-line`}>
                    <div className="flex justify-between items-baseline gap-3"><span className="text-[13px] font-semibold text-ink">Case {c.number}</span><span className="text-[12px] text-muted tabular-nums"><span className="text-ink font-medium">{n0(c.contents.reduce((a, x) => a + x.pairs, 0))}</span> pairs</span></div>
                    {byStyle(c.contents).map((g) => {
                      const l = idx[g.line_id];
                      return <div key={g.line_id} className="text-[12px] text-muted mt-1"><span className="text-ink-2 font-medium">{l ? lineTitle(l) : "A style no longer listed"}</span>{l?.description ? ` ${l.description}` : ""}: {g.sizes.map(([s, n]) => `${s} × ${n}`).join(" · ")}</div>;
                    })}
                    {c.notes && <div className="text-[12px] text-muted mt-1 italic">{c.notes}</div>}
                  </button>
                ))}
                {!cs.length && <p className="text-[12.5px] text-muted">Nothing on this pallet yet.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- A case being entered ----------------------------------------------------------------

function CaseEditor({ draft, setDraft, lines, idx, counts, cases, saved, onSave, onRemove, onClose, onNotListed }: {
  draft: Draft; setDraft: (d: Draft) => void; lines: LoadLine[]; idx: Record<string, LoadLine>; counts: Record<string, LineCount>; cases: WhCase[];
  saved: number[] | null; onSave: () => void; onRemove?: () => void; onClose: () => void; onNotListed: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [sure, setSure] = useState(false);
  const hits = useMemo(() => (q.trim() ? lines.filter((l) => lineMatches(l, q)).slice(0, 20) : []), [q, lines]);
  const setBlock = (k: number, b: Block) => setDraft({ ...draft, blocks: draft.blocks.map((x, i) => (i === k ? b : x)) });
  const add = (id: string) => { if (!draft.blocks.some((b) => b.line_id === id)) setDraft({ ...draft, blocks: [...draft.blocks, { line_id: id, qty: {} }] }); setQ(""); };
  const recent = useMemo(() => cases.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 15), [cases]);
  const total = draftTotal(draft);

  return (
    <div className={`${WH_CARD} p-4`}>
      {saved && saved.length > 0 && <div className="rounded-lg border border-success/30 bg-success-bg px-3 py-2 mb-3">
        <div className="text-[13px] font-medium text-success-ink">{saved.length === 1 ? `Case ${saved[0]}` : `Cases ${saved[0]} to ${saved[saved.length - 1]}`} saved on pallet {draft.pallet}</div>
        <div className="text-[12px] text-muted">The next case starts with the same pairs. Change what differs, or save it as it is.</div>
      </div>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">{draft.id ? `Case ${draft.number}` : "New case"}</div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-[12px] text-muted">Pallet<input value={draft.pallet} inputMode="numeric" onChange={(e) => setDraft({ ...draft, pallet: e.target.value.replace(/\D/g, "") })} style={WH_INPUT_BG} className={`${WH_INPUT} w-20 mt-1 tabular-nums`} /></label>
          {!draft.id && <label className="text-[12px] text-muted">Cases exactly like this<input value={draft.copies} inputMode="numeric" onChange={(e) => setDraft({ ...draft, copies: e.target.value.replace(/\D/g, "") })} style={WH_INPUT_BG} className={`${WH_INPUT} w-24 mt-1 tabular-nums`} /></label>}
          {!draft.id && recent.length > 0 && <label className="text-[12px] text-muted">Same as an earlier case
            <select value="" onChange={(e) => { const c = cases.find((x) => x.id === e.target.value); if (c) setDraft({ ...draft, blocks: blocksOf(c.contents) }); }} style={WH_INPUT_BG} className={`${WH_INPUT} w-56 mt-1`}>
              <option value="">Choose a case…</option>
              {recent.map((c) => <option key={c.id} value={c.id}>Pallet {c.pallet}, case {c.number}: {c.contents.reduce((a, x) => a + x.pairs, 0)} pairs</option>)}
            </select></label>}
        </div>
      </div>

      <div className="space-y-3 mt-4">
        {draft.blocks.map((b, k) => {
          const l = idx[b.line_id];
          if (!l) return null;
          const cnt = counts[l.id];
          const got = (s: string) => cnt?.sizes.find((x) => x.size === s)?.received ?? 0;
          const anyListed = l.sizes.some((s) => s.qty > 0);
          const shown = b.all || !anyListed ? l.sizes : l.sizes.filter((s) => s.qty > 0 || (b.qty[s.size] || 0) > 0 || got(s.size) > 0);
          const hidden = l.sizes.length - shown.length;
          return (
            <div key={b.line_id} className="rounded-lg border border-line p-3">
              <div className="flex justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] font-semibold text-ink">{lineTitle(l)}</div><div className="text-[12px] text-muted truncate">{[l.brand, l.group, lineDesc(l)].filter(Boolean).join(" · ")}</div></div>
                <button onClick={() => setDraft({ ...draft, blocks: draft.blocks.filter((_, i) => i !== k) })} className="text-muted hover:text-ink-2 h-7 w-7 grid place-items-center" aria-label="Take this style out of the case"><X size={14} /></button>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {shown.map((s) => (
                  <label key={s.size} className="w-[76px] text-center">
                    <span className="block text-[12px] font-medium text-ink-2">{s.size}</span>
                    <input value={b.qty[s.size] || ""} inputMode="numeric" placeholder="0" aria-label={`Pairs in size ${s.size}`}
                      onChange={(e) => setBlock(k, { ...b, qty: { ...b.qty, [s.size]: Math.max(0, parseInt(e.target.value.replace(/\D/g, ""), 10) || 0) } })}
                      style={WH_INPUT_BG} className={`${WH_INPUT} text-center tabular-nums mt-0.5 px-1`} />
                    <span className="block text-[11px] text-muted mt-0.5 tabular-nums">{s.qty ? `${n0(got(s.size))} of ${n0(s.qty)} in` : got(s.size) ? `${n0(got(s.size))} in` : "none listed"}</span>
                  </label>
                ))}
              </div>
              {hidden > 0 && <button onClick={() => setBlock(k, { ...b, all: true })} className="text-[12px] text-accent hover:underline mt-2">Sizes not on the manifest ({hidden})</button>}
            </div>
          );
        })}
      </div>

      <div className="relative mt-3 max-w-[560px]">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={draft.blocks.length ? "Another style in this case: type a style, colour or name" : "What is in the case: type a style, colour or name"} style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        {q.trim() && <div className={`${WH_CARD} absolute z-10 left-0 right-0 mt-1 max-h-[320px] overflow-auto shadow-[0_8px_24px_rgba(0,0,0,0.12)]`}>
          {hits.map((l) => (
            <button key={l.id} onClick={() => add(l.id)} className="w-full text-left px-3 py-2 hover:bg-surface-2 border-b border-line last:border-b-0 flex justify-between gap-3">
              <span className="min-w-0"><span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span><span className="block text-[12px] text-muted truncate">{[l.brand, l.group, lineDesc(l)].filter(Boolean).join(" · ")}</span></span>
              <span className="text-[12px] text-muted tabular-nums whitespace-nowrap">{n0(counts[l.id]?.received ?? 0)} of {n0(l.sizes.reduce((a, s) => a + s.qty, 0))}</span>
            </button>
          ))}
          {!hits.length && <div className="px-3 py-2 text-[12.5px] text-muted">Nothing on the manifest matches. <button onClick={() => onNotListed(q)} className="text-accent hover:underline">Add it as a style not on the manifest</button></div>}
        </div>}
      </div>

      <label className="block mt-3 max-w-[560px] text-[12px] text-muted">Note<input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional, for example the label on the case" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button onClick={onSave} disabled={!total} className={WH_BTN_PRIMARY}>{draft.id ? "Save changes" : "Save case"}</button>
        <button onClick={onClose} className={WH_BTN_SECONDARY}>{draft.id || !saved ? "Cancel" : "Done"}</button>
        {onRemove && (sure ? <><button onClick={onRemove} className={WH_BTN_SECONDARY}>Remove case {draft.number}</button><button onClick={() => setSure(false)} className={WH_BTN_SECONDARY}>Keep it</button></>
          : <button onClick={() => setSure(true)} className={WH_BTN_SECONDARY} title="Its pairs come off the received counts. The other cases keep their numbers.">Remove case</button>)}
        <span className="text-[12.5px] text-muted ml-auto tabular-nums">Pairs in this case: <span className="text-ink font-semibold">{n0(total)}</span></span>
      </div>
    </div>
  );
}

function NewLineForm({ lines, guess, onCancel, onAdd }: { lines: LoadLine[]; guess: string; onCancel: () => void; onAdd: (l: { brand: string; group: string; style: string; color: string; description: string; cost: number; msrp: number; sizes: string }) => void }) {
  const brands = useMemo(() => [...new Set(lines.map((l) => l.brand).filter(Boolean))], [lines]);
  const [f, setF] = useState({ brand: brands.length === 1 ? brands[0] : "", style: guess, color: "", description: "", sizes: "", cost: "", msrp: "" });
  const num = (s: string) => Number(s.replace(/[$,\s]/g, "")) || 0;
  const field = (k: keyof typeof f, label: string, ph = "", w = "") => (
    <label className={`text-[12px] text-muted ${w}`}>{label}<input value={f[k]} placeholder={ph} list={k === "brand" ? "r519-brands" : undefined} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`} /></label>
  );
  return (
    <div className={`${WH_CARD} p-4 mb-4`}>
      <div className="text-[14px] font-semibold text-ink mb-2">A style not on the manifest</div>
      <datalist id="r519-brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {field("brand", "Brand")}{field("style", "Style")}{field("color", "Colour")}{field("description", "Name", "Optional")}
        {field("sizes", "Sizes", "For example 6, 7, 8, 9, 10", "col-span-2")}{field("cost", "Cost a pair", "Optional")}{field("msrp", "MSRP", "Optional")}
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => onAdd({ brand: f.brand, group: "", style: f.style, color: f.color, description: f.description, sizes: f.sizes, cost: num(f.cost), msrp: num(f.msrp) })} className={WH_BTN_PRIMARY}>Add it</button>
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
      </div>
    </div>
  );
}

// ---- Against the manifest ------------------------------------------------------------------

type Filter = "all" | "none" | "short" | "over" | "done";

function CheckView({ lines, counts, totals: T }: { lines: LoadLine[]; counts: Record<string, LineCount>; totals: LoadDetail["tally"]["totals"] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [openLine, setOpenLine] = useState<string | null>(null);
  const rows = useMemo(() => lines.filter((l) => {
    const c = counts[l.id];
    if (!c || !lineMatches(l, q)) return false;
    const s = lineStatus(c);
    if (filter === "none") return c.received === 0 && c.expected > 0;
    if (filter === "short") return s.short > 0 && c.received > 0;
    if (filter === "over") return s.over > 0;
    if (filter === "done") return s.short === 0 && s.over === 0 && c.received > 0;
    return true;
  }), [lines, counts, filter, q]);
  let head = "";
  return (
    <div>
      <div className={`${WH_CARD} p-4 mb-3`}>
        <div className="text-[14px] text-ink tabular-nums"><span className="font-semibold">{n0(T.received)}</span> of {n0(T.expected)} pairs in</div>
        <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-2"><div className="h-full rounded-full" style={{ ...BAR, width: `${T.expected > 0 ? Math.min(100, (T.received / T.expected) * 100) : 0}%` }} /></div>
        <div className="text-[12px] text-muted mt-2 tabular-nums">{n0(T.short)} pairs still to come, size by size{T.over ? ` · ${n0(T.over)} more than the manifest lists` : ""}</div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Seg value={filter} onChange={setFilter} options={[{ key: "all", label: "All" }, { key: "none", label: "Not in" }, { key: "short", label: "Short" }, { key: "over", label: "Over" }, { key: "done", label: "All in" }]} />
        <div className="relative w-[320px] max-w-full">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a style, colour or name" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        </div>
        <span className="text-[12px] text-muted">{many(rows.length, "style", "styles")}</span>
      </div>
      <div className={`${WH_CARD} overflow-hidden`}>
        {rows.map((l) => {
          const c = counts[l.id], s = lineStatus(c);
          const h = l.brand + (l.group ? ` · ${l.group}` : "");
          const showHead = h !== head; head = h;
          const open = openLine === l.id;
          return (
            <div key={l.id}>
              {showHead && <div className="px-4 py-2 text-[12px] font-semibold text-ink-2 bg-surface-2 border-b border-line">{h}</div>}
              <button onClick={() => setOpenLine(open ? null : l.id)} className="w-full text-left px-4 py-2.5 border-b border-line hover:bg-surface-2/60 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span>
                    <span className="text-[12px] text-muted"> {lineDesc(l)}{c.pallets.length ? ` · pallet ${c.pallets.join(", ")}` : ""}</span>
                  </div>
                  <span className="text-[12.5px] text-muted tabular-nums whitespace-nowrap"><span className="text-ink font-medium">{n0(c.received)}</span> of {n0(c.expected)}</span>
                  <span className="w-[150px] flex justify-end">
                    {c.received === 0 && c.expected > 0 ? <StatusPill tone="neutral">Not in yet</StatusPill>
                      : s.short > 0 ? <StatusPill tone="warning">Short {n0(s.short)}{s.over ? `, over ${n0(s.over)}` : ""}</StatusPill>
                      : s.over > 0 ? <StatusPill tone="accent">Over {n0(s.over)}</StatusPill>
                      : <StatusPill tone="success">All in</StatusPill>}
                  </span>
                </div>
                {open && <div className="flex flex-wrap gap-1.5 mt-2">
                  {c.sizes.filter((z) => z.expected || z.received).map((z) => (
                    <span key={z.size} className={`w-[64px] rounded-md px-1 py-1 text-center bg-surface-2 ${z.received < z.expected ? "ring-1 ring-warning/50" : z.received > z.expected ? "ring-1 ring-accent/50" : ""}`}>
                      <span className="block text-[11px] text-muted">{z.size}</span>
                      <span className="block text-[13px] font-semibold text-ink tabular-nums">{n0(z.received)}</span>
                      <span className="block text-[11px] text-muted tabular-nums">of {n0(z.expected)}</span>
                    </span>
                  ))}
                </div>}
              </button>
            </div>
          );
        })}
        {!rows.length && <div className="px-4 py-6 text-[13px] text-muted text-center">Nothing here.</div>}
      </div>
    </div>
  );
}

// ---- Sell (R-519 phase 2): pick by brand and group, price per pair, send to an invoice -----
// What is left comes from case_core::stock. The pick is a draft kept on this device until its
// invoice exists; the invoice form then takes the pairs (take_load_pairs). The phone twin is
// whdSell* in www/app.js.

function readJson<T>(key: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; } catch { return fallback; }
}

function SellView({ d, lines, merge, live }: { d: LoadDetail; lines: LoadLine[]; merge: (d: LoadDetail) => void; live: boolean }) {
  const loadId = d.load.id;
  const left = useMemo(() => Object.fromEntries(d.stock.lines.map((l) => [l.line_id, l])) as Record<string, LineLeft>, [d.stock.lines]);
  const leftOf = useCallback((lid: string, size: string) => left[lid]?.sizes.find((z) => z.size === size)?.left ?? 0, [left]);
  const [pick, setPickRaw] = useState<Pick>(() => readJson<Pick>(pickKey(loadId), {}));
  const [tray, setTray] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [pct, setPct] = useState("");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [group, setGroup] = useState("");
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [sureClear, setSureClear] = useState(false);
  const [sureUndo, setSureUndo] = useState<string | null>(null);
  const [pending, setPending] = useState(() => readJson<{ invoice_id: string; reference: string; takes: CaseLine[] } | null>(pendingTakeKey(loadId), null));
  const setPick = (p: Pick) => { setPickRaw(p); try { localStorage.setItem(pickKey(loadId), JSON.stringify(p)); } catch { /* ignore */ } };

  // A pick never asks for more than is left now (another device may have sold some).
  useEffect(() => {
    setPickRaw((p) => {
      let changed = false;
      const next: Pick = {};
      for (const [lid, sizes] of Object.entries(p)) {
        for (const [s, n] of Object.entries(sizes)) {
          const v = Math.min(n, leftOf(lid, s));
          if (v !== n) changed = true;
          if (v > 0) (next[lid] ||= {})[s] = v;
        }
      }
      return changed ? next : p;
    });
  }, [leftOf]);

  const setSize = (lid: string, size: string, n: number) => {
    const v = Math.max(0, Math.min(leftOf(lid, size), Math.floor(n) || 0));
    const sizes = { ...(pick[lid] || {}) };
    if (v > 0) sizes[size] = v; else delete sizes[size];
    const next = { ...pick };
    if (Object.keys(sizes).length) next[lid] = sizes; else delete next[lid];
    setPick(next);
  };
  const allLeft = (p: Pick, lid: string) => {
    const l = left[lid];
    if (!l) return p;
    const sizes: Record<string, number> = {};
    for (const z of l.sizes) if (z.left > 0) sizes[z.size] = z.left;
    const next = { ...p };
    if (Object.keys(sizes).length) next[lid] = sizes; else delete next[lid];
    return next;
  };
  const pickedOf = (lid: string) => Object.values(pick[lid] || {}).reduce((a, b) => a + b, 0);
  const matches = (l: LoadLine) => (!brand || l.brand === brand) && (!group || l.group === group) && lineMatches(l, q);
  const shown = lines.filter((l) => ((left[l.id]?.left ?? 0) > 0 || pickedOf(l.id) > 0) && matches(l));
  const withLeft = lines.filter((l) => (left[l.id]?.left ?? 0) > 0);
  const brands = [...new Set(withLeft.map((l) => l.brand).filter(Boolean))];
  const groups = [...new Set(withLeft.filter((l) => !brand || l.brand === brand).map((l) => l.group).filter(Boolean))];
  const bs = buckets(lines, pick);
  const totalPairs = bs.reduce((a, b) => a + b.pairs, 0), totalStyles = bs.reduce((a, b) => a + b.styles, 0);
  const rateOf = (b: Bucket) => { const v = Number(String(rates[b.key] ?? "").replace(/[$,\s]/g, "")); return v > 0 ? Math.round(v * 100) / 100 : 0; };
  const orderTotal = bs.reduce((a, b) => a + Math.round(b.pairs * rateOf(b) * 100) / 100, 0);
  const orderCost = bs.reduce((a, b) => a + b.cost, 0);
  const ready = bs.length > 0 && bs.every((b) => rateOf(b) > 0);

  const send = () => {
    if (!ready) { toast("Give every line a price per pair.", "error"); return; }
    const prefill: InvoicePrefill = {
      lines: bs.map((b) => { const rate = rateOf(b); return { description: bucketLine(b), qty: b.pairs, rate, amount: Math.round(b.pairs * rate * 100) / 100, dl: { takes: b.takes, cost: b.cost } }; }),
      delivery: { load_id: loadId, load_name: d.load.name },
    };
    try { localStorage.setItem(INVOICE_PREFILL_KEY, JSON.stringify(prefill)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
  };
  const finishPending = async () => {
    if (!pending) return;
    try {
      merge(await api.takeLoadPairs(loadId, { invoiceId: pending.invoice_id, reference: pending.reference, note: "Invoiced", takes: pending.takes }));
      try { localStorage.removeItem(pendingTakeKey(loadId)); localStorage.removeItem(pickKey(loadId)); } catch { /* ignore */ }
      setPending(null); setPickRaw({});
      toast("Done: the pairs left the delivery");
    } catch (e) { toast(String(e), "error"); }
  };
  const undo = async (o: LoadOut) => {
    try { merge(await api.undoLoadOut(loadId, o.id)); setSureUndo(null); toast("Put back"); } catch (e) { toast(String(e), "error"); }
  };

  if (tray) {
    return (
      <div className="max-w-[760px]">
        <div className={`${WH_CARD} p-4 mb-3`}>
          <div className="text-[15px] font-semibold text-ink">Price the order</div>
          <p className="text-[12.5px] text-muted mt-0.5">{n0(totalPairs)} pairs, {many(totalStyles, "style", "styles")}. One invoice line for each brand and group, priced per pair.</p>
          <label className="block mt-3 text-[12px] text-muted w-[220px]">% of MSRP for every line
            <input value={pct} inputMode="decimal" placeholder="Optional, e.g. 20" style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}
              onChange={(e) => {
                setPct(e.target.value);
                const p = Number(e.target.value.replace(/[%\s]/g, ""));
                if (p > 0) setRates(Object.fromEntries(bs.map((b) => { const r = pctRate(b, p); return [b.key, r > 0 ? r.toFixed(2) : ""]; })));
              }} />
          </label>
        </div>
        <div className={`${WH_CARD} overflow-hidden`}>
          {bs.map((b) => (
            <div key={b.key} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-ink">{bucketName(b)}</div>
                <div className="text-[12px] text-muted tabular-nums">{n0(b.pairs)} pairs, {many(b.styles, "style", "styles")} · cost {money(b.cost)} · MSRP {money(b.msrp)}</div>
              </div>
              <label className="text-[12px] text-muted">Price a pair
                <input value={rates[b.key] ?? ""} inputMode="decimal" placeholder="0.00" style={WH_INPUT_BG} className={`${WH_INPUT} w-28 mt-1 tabular-nums`}
                  onChange={(e) => setRates({ ...rates, [b.key]: e.target.value })} />
              </label>
              <div className="w-28 text-right text-[13px] font-semibold text-ink tabular-nums">{money(Math.round(b.pairs * rateOf(b) * 100) / 100)}</div>
            </div>
          ))}
        </div>
        <div className={`${WH_CARD} p-4 mt-3`}>
          <div className="flex justify-between text-[13.5px]"><span className="text-ink-2">Order total</span><span className="font-semibold text-ink tabular-nums">{money(orderTotal)}</span></div>
          <div className="flex justify-between text-[12.5px] text-muted mt-1"><span>What the pairs cost</span><span className="tabular-nums">{money(orderCost)}</span></div>
          {orderTotal > 0 && orderTotal < orderCost && <p className="text-[12.5px] text-warning-ink mt-1">This order is {money(Math.round((orderCost - orderTotal) * 100) / 100)} below what the pairs cost.</p>}
          <p className="text-[12px] text-muted mt-2">The cost is shown so you can enter it in Deal Flow. Pairs leave this delivery only when the invoice is created.</p>
          <div className="flex gap-2 mt-3">
            <button onClick={send} disabled={!ready} className={WH_BTN_PRIMARY}>Send to invoice</button>
            <button onClick={() => setTray(false)} className={WH_BTN_SECONDARY}>Back to picking</button>
          </div>
        </div>
      </div>
    );
  }

  let head = "";
  return (
    <div>
      {pending && (
        <div className={`${WH_CARD} p-4 mb-3 border-warning/40`}>
          <div className="text-[13.5px] font-semibold text-ink">Invoice {pending.reference} is saved, its pairs have not left yet</div>
          <p className="text-[12.5px] text-muted mt-0.5">The call failed after the invoice was created. Finish it so the {n0(pending.takes.reduce((a, x) => a + x.pairs, 0))} pairs come off this delivery.</p>
          <button onClick={finishPending} className={`${WH_BTN_PRIMARY} mt-2`}>Take them out now</button>
        </div>
      )}
      <div className={`${WH_CARD} p-3.5 mb-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-10`}>
        <div>
          <div className="text-[14px] text-ink tabular-nums"><span className="font-semibold">{n0(totalPairs)}</span> pairs picked <span className="text-muted text-[12.5px]">· {many(totalStyles, "style", "styles")}</span></div>
          <div className="text-[12px] text-muted tabular-nums">{n0(d.stock.left)} of {n0(d.stock.received)} pairs left to sell</div>
        </div>
        <div className="flex gap-2">
          {totalPairs > 0 && (sureClear
            ? <><button onClick={() => { setPick({}); setSureClear(false); }} className={WH_BTN_SECONDARY}>Clear the pick</button><button onClick={() => setSureClear(false)} className={WH_BTN_SECONDARY}>Keep it</button></>
            : <button onClick={() => setSureClear(true)} className={WH_BTN_SECONDARY}>Clear</button>)}
          <button onClick={() => setTray(true)} disabled={!totalPairs || !live} className={WH_BTN_PRIMARY}>Price it</button>
        </div>
      </div>
      {d.stock.oversold.length > 0 && <p className="text-[12.5px] text-warning-ink mb-3">{d.stock.oversold.length === 1 ? "1 size has" : `${d.stock.oversold.length} sizes have`} more pairs sold than received. Check those cases, or put back one of the orders.</p>}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative w-[300px] max-w-full">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a style, colour or name" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9`} />
        </div>
        {brands.length > 1 && <div className="w-48"><select value={brand} onChange={(e) => { setBrand(e.target.value); setGroup(""); }} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Brand">
          <option value="">Every brand</option>{brands.map((b) => <option key={b} value={b}>{b}</option>)}</select></div>}
        {groups.length > 1 && <div className="w-44"><select value={group} onChange={(e) => setGroup(e.target.value)} style={WH_INPUT_BG} className={WH_INPUT} aria-label="Group">
          <option value="">Every group</option>{groups.map((g) => <option key={g} value={g}>{g}</option>)}</select></div>}
      </div>
      <div className={`${WH_CARD} overflow-hidden`}>
        {shown.map((l) => {
          const h = `${l.brand}\u0001${l.group}`;
          const showHead = h !== head; head = h;
          const ll = left[l.id];
          const picked = pickedOf(l.id);
          const open = openLine === l.id;
          const groupLeft = showHead ? shown.filter((x) => x.brand === l.brand && x.group === l.group).reduce((a, x) => a + (left[x.id]?.left ?? 0), 0) : 0;
          return (
            <div key={l.id}>
              {showHead && (
                <div className="flex items-center justify-between gap-3 px-4 py-2 bg-surface-2 border-b border-line">
                  <span className="text-[12.5px] font-semibold text-ink-2">{[l.brand, l.group].filter(Boolean).join(" · ")} <span className="font-normal text-muted">· {n0(groupLeft)} left</span></span>
                  {live && <button onClick={() => setPick(shown.filter((x) => x.brand === l.brand && x.group === l.group).reduce((p, x) => allLeft(p, x.id), pick))} className="text-[12.5px] text-accent hover:underline">Take all</button>}
                </div>
              )}
              <div className="px-4 py-2.5 border-b border-line">
                <button onClick={() => setOpenLine(open ? null : l.id)} className="w-full text-left flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-ink">{lineTitle(l)}</span>
                    <span className="text-[12px] text-muted"> {lineDesc(l)}{ll?.pallets.length ? ` · ${ll.pallets.length === 1 ? "pallet" : "pallets"} ${ll.pallets.join(", ")}` : ""}</span>
                  </div>
                  <span className="text-[12.5px] text-muted tabular-nums whitespace-nowrap"><span className="text-ink font-medium">{n0(ll?.left ?? 0)}</span> left</span>
                  <span className="w-[100px] flex justify-end">{picked > 0 && <StatusPill tone="success">{n0(picked)} picked</StatusPill>}</span>
                </button>
                {open && ll && (
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-2">
                      {ll.sizes.filter((z) => z.left > 0 || (pick[l.id]?.[z.size] ?? 0) > 0).map((z) => (
                        <label key={z.size} className="w-[76px] text-center">
                          <span className="block text-[12px] font-medium text-ink-2">{z.size}</span>
                          <input value={pick[l.id]?.[z.size] || ""} inputMode="numeric" placeholder="0" aria-label={`Pairs of size ${z.size}`} disabled={!live}
                            onChange={(e) => setSize(l.id, z.size, parseInt(e.target.value.replace(/\D/g, ""), 10) || 0)}
                            style={WH_INPUT_BG} className={`${WH_INPUT} text-center tabular-nums mt-0.5 px-1`} />
                          <span className="block text-[11px] text-muted mt-0.5 tabular-nums">{n0(z.left)} left</span>
                        </label>
                      ))}
                    </div>
                    {live && <div className="flex gap-3 mt-2">
                      <button onClick={() => setPick(allLeft(pick, l.id))} className="text-[12.5px] text-accent hover:underline">All left</button>
                      {picked > 0 && <button onClick={() => { const next = { ...pick }; delete next[l.id]; setPick(next); }} className="text-[12.5px] text-muted hover:text-ink-2">Clear</button>}
                    </div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!shown.length && <div className="px-4 py-6 text-[13px] text-muted text-center">Nothing left here. Clear the filters, or this delivery is sold.</div>}
      </div>

      {d.outs.length > 0 && <>
        <div className="text-[13px] font-semibold text-ink mt-5 mb-2">Sold from this delivery</div>
        <div className={`${WH_CARD} overflow-hidden`}>
          {d.outs.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-ink">{o.reference || "Taken out"}</span>
                <span className="text-[12px] text-muted tabular-nums"> · {n0(o.pairs)} pairs · {money(o.cost)} cost · {new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </div>
              {o.undone ? <StatusPill tone="neutral">Back on the delivery</StatusPill>
                : o.invoice_state === "voided" ? <StatusPill tone="warning">Invoice voided, pairs still out</StatusPill>
                : o.invoice_state === "removed" || o.invoice_state === "gone" ? <StatusPill tone="warning">Invoice removed, pairs still out</StatusPill> : null}
              {live && !o.undone && (sureUndo === o.id
                ? <><button onClick={() => undo(o)} className={WH_BTN_SECONDARY} title="The pairs count as on this delivery again. The invoice is not changed.">Put {n0(o.pairs)} pairs back</button><button onClick={() => setSureUndo(null)} className={WH_BTN_SECONDARY}>Keep them out</button></>
                : <button onClick={() => setSureUndo(o.id)} className={WH_BTN_SECONDARY}>Put back</button>)}
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}
