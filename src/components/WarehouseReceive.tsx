// R-568: Receive. One screen to take a truck in: a box is ready with its code to write on it, every tag
// scanned lands in it (a known barcode on its style and size, an unknown one waiting to be matched), and
// Complete box saves it and readies the next. Loose shoe boxes go straight onto the pallet the same way.
// A barcode is matched once (the company's item_codes) and every unit of it waiting, in every box, moves.
// The rules are case_core.rs (byte-identical on the server); this only draws. The phone twin is
// www/app.js whr*.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus, Search, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { lineMatches, lineTitle, unitWord, type LoadDetail, type LoadLine, type PalletView, type WhCase } from "../lib/deliveries";
import { addScan, boxRows, boxUnits, brandHint, cleanBarcode, emptyBox, lineWords, newBoxId, ScanReader, setCount, settleMatch, showBarcode, undoScan, waitingUnits, type ItemCode, type OpenBox, type Resolved } from "../lib/receive";
import { toast } from "./Toast";
import { Seg } from "./WarehouseProduct";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

const BIG_PRIMARY = "inline-flex items-center justify-center gap-2 bg-accent hover:bg-accent-hover text-on-accent px-6 h-14 rounded-xl text-[17px] font-semibold transition-colors disabled:opacity-40";
const BIG_SECONDARY = "inline-flex items-center justify-center gap-2 border border-line text-ink-2 hover:bg-surface-2 px-5 h-14 rounded-xl text-[16px] transition-colors disabled:opacity-40";
const draftKey = (loadId: string) => `ecliptr.r568.open.${loadId}`;

/** A short sound for each scan: a tick when it landed, a lower double note when it waits on a match. */
function useBeep() {
  const ctx = useRef<AudioContext | null>(null);
  return useCallback((kind: "ok" | "new" | "bad") => {
    try {
      ctx.current ??= new AudioContext();
      const a = ctx.current;
      const notes = kind === "ok" ? [[1320, 0.06]] : kind === "new" ? [[660, 0.09], [520, 0.12]] : [[220, 0.25]];
      let t = a.currentTime;
      for (const [f, d] of notes) {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = f; g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(a.destination); o.start(t); o.stop(t + d); t += d + 0.02;
      }
    } catch { /* no sound is fine */ }
  }, []);
}

const isTyping = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

export default function WarehouseReceive({ d, merge, onClose, startPallet: firstPallet }: { d: LoadDetail; merge: (d: LoadDetail) => void; onClose: () => void; startPallet: number | null }) {
  const L = d.load, T = d.tally.totals;
  const lines = useMemo(() => L.lines ?? [], [L.lines]);
  const idx = useMemo(() => Object.fromEntries(lines.map((l) => [l.id, l])) as Record<string, LoadLine>, [lines]);
  const word = (n: number) => unitWord(L, n);
  const pallets: PalletView[] = d.pallets ?? [];
  const live = !L.archived;
  const beep = useBeep();

  // The pallet asked for, unless it is full: then the newest open one.
  const [pallet, setPallet] = useState<number | null>(() => {
    const open = pallets.filter((p) => !p.closed).map((p) => p.pallet);
    if (firstPallet != null && open.includes(firstPallet)) return firstPallet;
    return open.pop() ?? firstPallet ?? pallets[0]?.pallet ?? null;
  });
  const [mode, setMode] = useState<"box" | "loose">("box");
  const [box, setBoxRaw] = useState<OpenBox | null>(null);
  const [codes, setCodes] = useState<Record<string, Resolved>>({});
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [flash, setFlash] = useState<string>("");
  const [matching, setMatching] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ n: number; full: boolean } | null>(null);
  const [typed, setTyped] = useState("");
  const [byHand, setByHand] = useState(false);
  const [editRow, setEditRow] = useState<{ line_id: string; size: string; v: string } | null>(null);

  // The open box is kept on this computer after every scan, so closing the app mid-box loses nothing.
  // `boxRef` is the box as of the last scan, so scans arriving faster than the screen redraws all count.
  const boxRef = useRef<OpenBox | null>(null);
  boxRef.current = box;
  const setBox = useCallback((b: OpenBox | null) => {
    boxRef.current = b;
    setBoxRaw(b);
    try { if (b) localStorage.setItem(draftKey(L.id), JSON.stringify(b)); else localStorage.removeItem(draftKey(L.id)); } catch { /* ignore */ }
  }, [L.id]);

  const loadCodes = useCallback(() => api.getLoadCodes(L.id).then((r) => setCodes(Object.fromEntries(r.codes.map((c) => [c.code, c])))).catch(() => {}), [L.id]);
  useEffect(() => { loadCodes(); }, [loadCodes]);

  const ps = pallets.find((p) => p.pallet === pallet);
  const casesHere = (n: number) => d.cases.filter((c) => c.pallet === n);
  const emptyHere = (n: number) => casesHere(n).find((c) => c.kind !== "loose" && !c.contents.length && !waitingUnits(c.unmatched));

  // Ready a box on the pallet: the box kept on this computer, an empty one already there, or a new one.
  const ready = useCallback(async (n: number, kind: "box" | "loose") => {
    let kept: OpenBox | null = null;
    try { kept = JSON.parse(localStorage.getItem(draftKey(L.id)) || "null"); } catch { kept = null; }
    const keptLive = !!kept && (kept.kind === "loose" || d.cases.some((c) => c.id === kept!.id));
    if (kept && keptLive && kept.pallet === n && kept.kind === kind) { setBoxRaw(kept); return; }
    // A box left with scans in it, on another pallet or the other mode, is where Receive opens, never overwritten.
    if (kept && keptLive && boxUnits(kept)) { setMode(kept.kind); setPallet(kept.pallet); setBoxRaw(kept); return; }
    if (kind === "loose") { setBox(emptyBox(newBoxId(), n, "loose")); return; }
    const e = emptyHere(n);
    if (e) { setBox(emptyBox(e.id, n, "box", e.code || String(e.number))); return; }
    const id = newBoxId();
    try {
      const next = await api.saveWarehouseCase(L.id, { caseId: id, pallet: n, contents: [], create: true });
      merge(next);
      const c = next.cases.find((x) => x.id === id);
      setBox(emptyBox(id, n, "box", c?.code || String(c?.number ?? "")));
    } catch (e) { toast(String(e), "error"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L.id, d.cases, merge, setBox]);

  // A pallet with nothing on it and no place yet is asked where it stands first, so its box codes carry
  // the place (A3-1); a box is readied once that is answered or skipped.
  useEffect(() => {
    if (pallet == null || !live) return;
    if (box && box.pallet === pallet && box.kind === mode) return;
    // A box left with scans in it, on another pallet or the other mode, is where Receive opens, never overwritten.
    let kept: OpenBox | null = null;
    try { kept = JSON.parse(localStorage.getItem(draftKey(L.id)) || "null"); } catch { kept = null; }
    if (kept && boxUnits(kept) && (kept.pallet !== pallet || kept.kind !== mode) && (kept.kind === "loose" || d.cases.some((c) => c.id === kept!.id))) {
      setAsking(null); setMode(kept.kind); setPallet(kept.pallet); setBoxRaw(kept); return;
    }
    if (mode === "box" && ps && !ps.location && !casesHere(pallet).length && !asking) { setAsking({ n: pallet, full: false }); return; }
    if (!asking) void ready(pallet, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pallet, mode, live, asking]);

  const scan = useCallback((raw: string) => {
    const cur = boxRef.current;
    if (!cur || busy) return;
    const c = cleanBarcode(raw);
    if ("error" in c) { beep("bad"); toast(c.error, "error"); return; }
    const r = codes[c.code];
    setBox(addScan(cur, c.code, r));
    setFlash(r?.line_id ? `l|${r.line_id}|${r.size}` : `c|${c.code}`);
    beep(r?.line_id ? "ok" : "new");
  }, [busy, codes, beep, setBox]);

  // A scanner types fast and ends with Enter. Taken whatever has focus, except a field being typed in.
  useEffect(() => {
    const reader = new ScanReader(100, 8);
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 && e.key !== "Enter") return;
      e.preventDefault(); e.stopPropagation();
      const r = reader.key(e.key, performance.now());
      if (r) scan(r.scan);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [scan]);

  const complete = async () => {
    if (!box || busy) return;
    if (!boxUnits(box)) { toast(mode === "loose" ? "Scan what is on the pallet first." : "Scan the tags in the box first.", "error"); return; }
    setBusy(true);
    // The next box: an empty one already numbered on this pallet (Number boxes ahead), lowest first, else a new one.
    const spare = box.kind === "box" ? d.cases.filter((c) => c.pallet === box.pallet && c.id !== box.id && c.kind !== "loose" && !c.contents.length && !waitingUnits(c.unmatched)).sort((a, b) => a.number - b.number)[0] : undefined;
    const nextId = box.kind === "box" && !spare ? newBoxId() : undefined;
    try {
      const next = await api.saveWarehouseCase(L.id, { caseId: box.id, pallet: box.pallet, contents: box.contents, unmatched: box.unmatched, create: true, kind: box.kind, nextId });
      merge(next);
      setUnsaved(false);
      const n = boxUnits(box);
      toast(box.kind === "loose" ? `${n0(n)} loose ${word(n)} saved on pallet ${box.pallet}` : `Box ${box.code} saved, ${n0(n)} ${word(n)}`);
      if (box.kind === "loose") setBox(emptyBox(newBoxId(), box.pallet, "loose"));
      else if (spare) setBox(emptyBox(spare.id, box.pallet, "box", spare.code || String(spare.number)));
      else {
        const c = next.cases.find((x) => x.id === nextId);
        setBox(c ? emptyBox(c.id, box.pallet, "box", c.code || String(c.number)) : null);
      }
    } catch (e) {
      // Kept on this computer; sent again it lands once (the box id is this computer's).
      setUnsaved(true);
      toast(`Not saved yet: ${e}`, "error");
    } finally { setBusy(false); }
  };

  const sameAs = (c: WhCase) => {
    if (!box) return;
    let b: OpenBox = { ...box, contents: [], unmatched: {}, log: [] };
    for (const x of c.contents) b = addScan(b, "", { code: "", line_id: x.line_id, size: x.size, item: {} as ItemCode }, x.pairs);
    for (const [code, n] of Object.entries(c.unmatched ?? {})) b = addScan(b, code, undefined, n);
    setBox(b);
  };

  const fullPallet = async (n: number, location: string) => {
    setBusy(true);
    try {
      // What is scanned into the open box is saved first: a full pallet never loses a scan.
      if (box && box.pallet === n && boxUnits(box)) {
        try {
          merge(await api.saveWarehouseCase(L.id, { caseId: box.id, pallet: box.pallet, contents: box.contents, unmatched: box.unmatched, create: true, kind: box.kind }));
        } catch (e) { setUnsaved(true); setAsking(null); toast(`Not saved yet: ${e}`, "error"); return; }
      } else if (box && box.pallet === n && box.kind === "box" && d.cases.some((c) => c.id === box.id)) {
        // The empty box readied on it is taken off again, so the pallet's count stays true.
        merge(await api.removeWarehouseCase(L.id, box.id));
      }
      const next = await api.saveLoadPallet(L.id, n, { location, closed: true, startNext: true });
      merge(next);
      const open = (next.pallets ?? []).filter((x) => !x.closed).map((x) => x.pallet);
      setBox(null); setAsking(null);
      if (open.length) setPallet(Math.max(...open));
      toast(`Pallet ${n} is full.${open.length ? ` Now on pallet ${Math.max(...open)}.` : ""}`);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  const setPlace = async (n: number, location: string) => {
    try { if (location.trim()) merge(await api.saveLoadPallet(L.id, n, { location })); setAsking(null); } catch (e) { toast(String(e), "error"); }
  };
  // A box with scans in it is completed (or undone) before moving on, so nothing scanned is dropped.
  const held = () => {
    if (box && boxUnits(box)) { toast(`${box.kind === "loose" ? "Save the loose items" : `Complete box ${box.code}`} first, or Undo its scans.`, "error"); return true; }
    return false;
  };
  const newPallet = async () => {
    if (held()) return;
    setBusy(true);
    try {
      const next = await api.startLoadPallet(L.id);
      merge(next);
      setBox(null);
      setPallet(next.started ?? Math.max(...(next.pallets ?? []).map((p) => p.pallet)));
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  // Every barcode waiting to be matched: in saved boxes, and in the open one.
  const waiting = useMemo(() => {
    const m = new Map<string, { n: number; boxes: number }>();
    for (const c of d.cases) for (const [code, n] of Object.entries(c.unmatched ?? {})) { if (c.id === box?.id) continue; const w = m.get(code) ?? { n: 0, boxes: 0 }; w.n += n; w.boxes += 1; m.set(code, w); }
    for (const [code, n] of Object.entries(box?.unmatched ?? {})) { const w = m.get(code) ?? { n: 0, boxes: 0 }; w.n += n; w.boxes += 1; m.set(code, w); }
    return [...m.entries()].map(([code, w]) => ({ code, ...w })).sort((a, b) => b.n - a.n);
  }, [d.cases, box]);
  const waitingTotal = waiting.reduce((a, w) => a + w.n, 0);

  const matched = (r: Resolved, next: LoadDetail) => {
    merge(next);
    setCodes((c) => ({ ...c, [r.code]: r }));
    if (box) setBox(settleMatch(box, r));
    setMatching(null);
  };

  const recent = useMemo(() => d.cases.filter((c) => c.kind !== "loose" && (c.contents.length || waitingUnits(c.unmatched))).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12), [d.cases]);
  const rows = box ? boxRows(box) : [];
  const units = box ? boxUnits(box) : 0;

  if (matching) return <MatchPanel loadId={L.id} code={matching} lines={lines} known={codes} waiting={waiting.find((w) => w.code === matching)?.n ?? 0} onDone={matched} onCancel={() => setMatching(null)} />;

  return (
    <div>
      <button onClick={onClose} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={14} /> Back to the delivery</button>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[22px] font-semibold text-ink tracking-tight">Receive {L.name}</h2>
          <p className="text-[15px] text-muted mt-1 tabular-nums"><span className="text-ink font-semibold">{n0(T.received)}</span>{T.expected ? ` of ${n0(T.expected)}` : ""} {word(2)} in{waitingTotal ? <> · <span className="text-ink-2 font-medium">{n0(waitingTotal)}</span> waiting to be matched</> : ""}</p>
        </div>
        <Seg size="md" value={mode} onChange={(m) => { if (m === mode || held()) return; setMode(m); setBoxRaw(null); }} options={[{ key: "box", label: "Into a box" }, { key: "loose", label: "Loose on the pallet" }]} />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-2">
          {live && <button onClick={newPallet} disabled={busy} className={`${WH_BTN_SECONDARY} w-full justify-center h-11 text-[14px]`}><Plus size={15} /> Start a pallet</button>}
          {pallets.map((p) => (
            <button key={p.pallet} onClick={() => { if (p.pallet === pallet || held()) return; setPallet(p.pallet); setBoxRaw(null); setAsking(null); }}
              className={`${WH_CARD} w-full text-left px-3.5 py-3 transition-colors ${pallet === p.pallet ? "ring-2 ring-accent/40 border-accent/40" : "hover:border-accent/30"}`}>
              <div className="text-[15px] font-semibold text-ink">Pallet {p.pallet}{p.location && <span className="font-normal text-muted"> at {p.location}</span>}</div>
              <div className="text-[13px] text-muted mt-0.5 tabular-nums">{n0(p.boxes)} {p.boxes === 1 ? "box" : "boxes"} · {n0(p.pairs + (p.unmatched ?? 0))} {word(p.pairs + (p.unmatched ?? 0))}{p.closed ? " · full" : ""}</div>
            </button>
          ))}
        </div>

        <div className="min-w-0 space-y-3">
          {!live ? <p className="text-[14px] text-muted">This delivery was removed. Bring it back to receive onto it.</p>
            : pallet == null ? <p className="text-[14px] text-muted">Start a pallet to begin.</p>
            : asking ? (
              <PlaceAsk n={asking.n} full={asking.full} busy={busy} recent={[...new Set([...pallets.map((p) => p.location).filter(Boolean), ...(d.recent_locations ?? [])])].slice(0, 8)}
                onSave={(loc) => (asking.full ? fullPallet(asking.n, loc) : setPlace(asking.n, loc))} onSkip={() => (asking.full ? fullPallet(asking.n, "") : setAsking(null))} onCancel={asking.full ? () => setAsking(null) : undefined} />
            ) : !box ? <p className="text-[14px] text-muted">Getting the box ready…</p> : (
              <div className={`${WH_CARD} p-5`}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="text-[30px] font-semibold text-ink tracking-tight tabular-nums">{box.kind === "loose" ? `Loose on pallet ${box.pallet}` : `Box ${box.code}`}</div>
                  <div className="text-[15px] text-muted">{box.kind === "loose" ? "Scan each tag on the pallet" : "Write this on the box, then scan each tag"}</div>
                </div>
                {unsaved && <div className="mt-3 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-[14px] text-warning-ink">Not saved yet. It is kept on this computer. Press Complete box again.</div>}
                <div className="mt-4 divide-y divide-line border-y border-line">
                  {!rows.length && <div className="py-5 text-[16px] text-muted">Nothing scanned yet.</div>}
                  {rows.map((r) => {
                    const key = r.kind === "line" ? `l|${r.line_id}|${r.size}` : `c|${r.code}`;
                    const on = flash === key;
                    if (r.kind === "code") {
                      const known = codes[r.code];
                      return (
                        <div key={key} className={`flex items-center justify-between gap-3 min-h-[56px] transition-colors ${on ? "bg-surface-2" : ""}`}>
                          <div className="min-w-0"><div className="text-[17px] text-ink">{known ? `${known.item.description || known.item.style} ${known.item.color_name || known.item.color} ${known.size}` : "New barcode"}</div><div className="text-[13px] text-muted tabular-nums">{showBarcode(r.code)}{known ? ", not on this delivery yet" : ""}</div></div>
                          <div className="flex items-center gap-3"><span className="text-[20px] font-semibold text-ink tabular-nums w-12 text-right">{r.n}</span><button onClick={() => setMatching(r.code)} className={`${WH_BTN_SECONDARY} h-10`}>{known ? "Add it" : "Match"}</button></div>
                        </div>
                      );
                    }
                    const l = idx[r.line_id];
                    const editing = editRow && editRow.line_id === r.line_id && editRow.size === r.size;
                    return (
                      <div key={key} className={`flex items-center justify-between gap-3 min-h-[56px] transition-colors ${on ? "bg-surface-2" : ""}`}>
                        <div className="min-w-0"><div className="text-[17px] text-ink truncate">{l ? lineWords(l) : "A style no longer listed"} <span className="font-semibold">{r.size}</span></div><div className="text-[13px] text-muted truncate">{l ? lineTitle(l) : ""}</div></div>
                        {editing ? (
                          <input autoFocus value={editRow.v} inputMode="numeric" onChange={(e) => setEditRow({ ...editRow, v: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                            onKeyDown={(e) => { if (e.key === "Enter") { setBox(setCount(box, r.line_id, r.size, parseInt(editRow.v, 10) || 0)); setEditRow(null); } if (e.key === "Escape") setEditRow(null); }}
                            onBlur={() => { setBox(setCount(box, r.line_id, r.size, parseInt(editRow.v, 10) || 0)); setEditRow(null); }}
                            style={WH_INPUT_BG} className={`${WH_INPUT} w-20 h-11 text-[18px] text-right tabular-nums`} aria-label="How many" />
                        ) : <button onClick={() => setEditRow({ line_id: r.line_id, size: r.size, v: String(r.n) })} className="text-[20px] font-semibold text-ink tabular-nums w-16 text-right h-11 rounded-lg hover:bg-surface-2" title="Type how many">{r.n}</button>}
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-baseline justify-between mt-3"><span className="text-[15px] text-muted">In this {box.kind === "loose" ? "scan" : "box"}</span><span className="text-[22px] font-semibold text-ink tabular-nums">{n0(units)} {word(units)}</span></div>

                <div className="flex flex-wrap gap-2 mt-4">
                  <button onClick={complete} disabled={busy || !units} className={`${BIG_PRIMARY} flex-1 min-w-[200px]`}>{busy ? "Saving…" : box.kind === "loose" ? "Save loose items" : "Complete box"}</button>
                  <button onClick={() => setBox(undoScan(box))} disabled={!box.log.length} className={BIG_SECONDARY}><Undo2 size={18} /> Undo last</button>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  {box.kind === "box" && recent.length > 0 && (
                    <select value="" onChange={(e) => { const c = d.cases.find((x) => x.id === e.target.value); if (c) sameAs(c); (e.target as HTMLSelectElement).blur(); }} style={WH_INPUT_BG} className={`${WH_INPUT} h-11 w-64 text-[14px]`} aria-label="Same as an earlier box">
                      <option value="">Same as an earlier box</option>
                      {recent.map((c) => <option key={c.id} value={c.id}>Box {c.code || c.number}: {n0(c.contents.reduce((a, x) => a + x.pairs, 0) + waitingUnits(c.unmatched))} {word(2)}</option>)}
                    </select>
                  )}
                  <button onClick={() => setByHand((v) => !v)} className={`${WH_BTN_SECONDARY} h-11 text-[14px]`}>Add by hand</button>
                  {!ps?.closed && <button onClick={() => setAsking({ n: box.pallet, full: true })} className={`${WH_BTN_SECONDARY} h-11 text-[14px]`}>Pallet full</button>}
                  <form className="flex gap-2 ml-auto" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { scan(typed); setTyped(""); } }}>
                    <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a barcode" style={WH_INPUT_BG} className={`${WH_INPUT} h-11 w-48 text-[14px]`} />
                    <button type="submit" className={`${WH_BTN_SECONDARY} h-11 text-[14px]`}>Add</button>
                  </form>
                </div>
                {byHand && <ByHand lines={lines} onAdd={(line_id, size) => { setBox(addScan(box, "", { code: "", line_id, size, item: {} as ItemCode })); setFlash(`l|${line_id}|${size}`); beep("ok"); }} />}
              </div>
            )}

          {waiting.length > 0 && (
            <div className={`${WH_CARD} p-4`}>
              <div className="flex items-baseline justify-between gap-3"><div className="text-[17px] font-semibold text-ink">To match</div><div className="text-[14px] text-muted tabular-nums">{waiting.length} {waiting.length === 1 ? "barcode" : "barcodes"}, {n0(waitingTotal)} {word(waitingTotal)}</div></div>
              <p className="text-[13px] text-muted mt-0.5">Each barcode is matched once. Every {word(1)} of it already scanned, in every box, moves to that style and size.</p>
              <div className="mt-2 divide-y divide-line">
                {waiting.slice(0, 40).map((w) => (
                  <div key={w.code} className="flex items-center justify-between gap-3 min-h-[52px]">
                    <div className="min-w-0"><div className="text-[16px] text-ink tabular-nums">{showBarcode(w.code)}</div><div className="text-[13px] text-muted">{n0(w.n)} {word(w.n)} in {w.boxes} {w.boxes === 1 ? "box" : "boxes"}{codes[w.code] ? `, known as ${codes[w.code].item.description || codes[w.code].item.style} ${codes[w.code].size}` : ""}</div></div>
                    <button onClick={() => setMatching(w.code)} className={`${WH_BTN_SECONDARY} h-10`}>{codes[w.code] ? "Add it" : "Match"}</button>
                  </div>
                ))}
              </div>
              {waiting.length > 40 && <p className="text-[13px] text-muted mt-2">And {waiting.length - 40} more.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where a pallet stands: asked when it starts (so its box codes carry the place) and when it is full. */
function PlaceAsk({ n, full, busy, recent, onSave, onSkip, onCancel }: { n: number; full: boolean; busy: boolean; recent: string[]; onSave: (loc: string) => void; onSkip: () => void; onCancel?: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className={`${WH_CARD} p-5`}>
      <div className="text-[20px] font-semibold text-ink">{full ? `Pallet ${n} is full. Where does it stand?` : `Where does pallet ${n} stand?`}</div>
      <p className="text-[14px] text-muted mt-1">{full ? "The next pallet starts once this is saved." : "Its box codes start with the place, A3-1, A3-2. Skip it and they start with P" + n + "."}</p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <input autoFocus value={v} maxLength={40} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && v.trim()) onSave(v.trim()); }} placeholder="For example A3" style={WH_INPUT_BG} className={`${WH_INPUT} h-11 w-56 text-[16px]`} />
        {recent.map((l) => <button key={l} onClick={() => onSave(l)} disabled={busy} className={`${WH_BTN_SECONDARY} h-11 text-[14px]`}>{l}</button>)}
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => onSave(v.trim())} disabled={busy || !v.trim()} className={WH_BTN_PRIMARY}>{full ? "Save, start the next pallet" : "Save"}</button>
        <button onClick={onSkip} disabled={busy} className={WH_BTN_SECONDARY}>{full ? "Skip the place" : "Skip"}</button>
        {onCancel && <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>}
      </div>
    </div>
  );
}

/** A tag with no barcode: find its style, tap its size, and one goes in the box. */
function ByHand({ lines, onAdd }: { lines: LoadLine[]; onAdd: (line_id: string, size: string) => void }) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<LoadLine | null>(null);
  const hits = useMemo(() => (q.trim() ? lines.filter((l) => lineMatches(l, q)).slice(0, 12) : []), [q, lines]);
  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      {pick ? (
        <div>
          <div className="flex items-baseline justify-between gap-3"><div className="text-[16px] font-semibold text-ink">{lineWords(pick)} <span className="font-normal text-muted">{lineTitle(pick)}</span></div><button onClick={() => setPick(null)} className="text-[13px] text-muted hover:text-ink-2">Another style</button></div>
          <div className="flex flex-wrap gap-2 mt-2">{pick.sizes.map((s) => <button key={s.size} onClick={() => onAdd(pick.id, s.size)} className={`${WH_BTN_SECONDARY} h-12 min-w-[56px] justify-center text-[16px] font-semibold`}>{s.size}</button>)}</div>
          <p className="text-[13px] text-muted mt-2">Each tap adds one.</p>
        </div>
      ) : (
        <>
          <div className="relative"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a style, colour or name" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9 h-11 text-[15px]`} /></div>
          <div className="mt-1">{hits.map((l) => <button key={l.id} onClick={() => setPick(l)} className="w-full text-left px-2 py-2.5 hover:bg-surface-2 rounded-lg"><span className="text-[15px] text-ink">{lineWords(l)}</span> <span className="text-[13px] text-muted">{lineTitle(l)}</span></button>)}</div>
          {q.trim() && !hits.length && <p className="text-[13px] text-muted mt-2">Nothing on the manifest matches.</p>}
        </>
      )}
    </div>
  );
}

/** Match one barcode: pick its style and size on the delivery, or say what it is when the delivery does
 *  not list it. A barcode the company already knows from another delivery is added in one press. */
function MatchPanel({ loadId, code, lines, known, waiting, onDone, onCancel }: {
  loadId: string; code: string; lines: LoadLine[]; known: Record<string, Resolved>; waiting: number;
  onDone: (r: Resolved, next: LoadDetail) => void; onCancel: () => void;
}) {
  const knownHere = known[code];
  const hint = useMemo(() => brandHint(code, Object.values(known)), [code, known]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<LoadLine | null>(null);
  const [busy, setBusy] = useState(false);
  const [other, setOther] = useState(!lines.length);
  const [f, setF] = useState({ brand: knownHere?.item.brand ?? hint, style: knownHere?.item.style ?? "", color: knownHere?.item.color_name || knownHere?.item.color || "", size: knownHere?.item.size ?? "" });
  const brands = useMemo(() => [...new Set(lines.map((l) => l.brand).filter(Boolean))], [lines]);
  const [brand, setBrand] = useState(hint && brands.includes(hint) ? hint : "");
  const hits = useMemo(() => {
    const base = lines.filter((l) => !brand || l.brand === brand);
    return (q.trim() ? base.filter((l) => lineMatches(l, q)) : base).slice(0, 30);
  }, [lines, brand, q]);
  const send = async (m: { lineId?: string; size?: string; item?: ItemCode }) => {
    setBusy(true);
    try {
      const r = await api.matchLoadCode(loadId, code, m);
      toast(r.boxes_moved ? `Matched. ${r.boxes_moved} ${r.boxes_moved === 1 ? "box" : "boxes"} updated.` : "Matched. The next scan of it lands on its own.");
      onDone(r.resolved, r);
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  const asItem = (): ItemCode => ({ code, brand: f.brand.trim(), style: f.style.trim(), color: "", color_name: f.color.trim(), description: f.style.trim(), size: f.size.trim(), how: "matched" });
  return (
    <div className="max-w-[860px]">
      <button onClick={onCancel} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink-2 mb-3"><ArrowLeft size={14} /> Back to receiving</button>
      <div className={`${WH_CARD} p-5`}>
        <div className="text-[22px] font-semibold text-ink tabular-nums">Barcode {showBarcode(code)}</div>
        <p className="text-[14px] text-muted mt-1">{waiting ? `${n0(waiting)} scanned so far. ` : ""}Match it once and every one of it moves to that style and size.</p>
        {knownHere && !knownHere.line_id && (
          <div className="mt-4 rounded-lg border border-line p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-[16px] text-ink">Known as {[knownHere.item.brand, knownHere.item.description || knownHere.item.style, knownHere.item.color_name || knownHere.item.color, knownHere.item.size].filter(Boolean).join(" ")}</div>
            <button disabled={busy} onClick={() => send({ item: { ...knownHere.item } })} className={WH_BTN_PRIMARY}>Add it to this delivery</button>
          </div>
        )}
        {!other ? (
          pick ? (
            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-3"><div className="text-[18px] font-semibold text-ink">{lineWords(pick)} <span className="font-normal text-muted text-[15px]">{lineTitle(pick)}</span></div><button onClick={() => setPick(null)} className="text-[13px] text-muted hover:text-ink-2">Another style</button></div>
              <p className="text-[14px] text-muted mt-1">Which size is this barcode?</p>
              <div className="flex flex-wrap gap-2 mt-2">{pick.sizes.map((s) => <button key={s.size} disabled={busy} onClick={() => send({ lineId: pick.id, size: s.size })} className={`${WH_BTN_SECONDARY} h-14 min-w-[64px] justify-center text-[18px] font-semibold`}>{s.size}</button>)}</div>
            </div>
          ) : (
            <div className="mt-4">
              {brands.length > 1 && <div className="flex flex-wrap gap-2 mb-2">
                <button onClick={() => setBrand("")} className={`${WH_BTN_SECONDARY} h-10 ${!brand ? "ring-2 ring-accent/40" : ""}`}>Every brand</button>
                {brands.map((b) => <button key={b} onClick={() => setBrand(b)} className={`${WH_BTN_SECONDARY} h-10 ${brand === b ? "ring-2 ring-accent/40" : ""}`}>{b}</button>)}
              </div>}
              <div className="relative"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type the style from the label, for example MUM1913OA" style={WH_INPUT_BG} className={`${WH_INPUT} pl-9 h-11 text-[15px]`} /></div>
              <div className="mt-1 max-h-[420px] overflow-auto">{hits.map((l) => <button key={l.id} onClick={() => setPick(l)} className="w-full text-left px-2 py-3 hover:bg-surface-2 rounded-lg"><span className="text-[16px] text-ink">{lineWords(l)}</span> <span className="text-[13px] text-muted">{lineTitle(l)}{l.brand ? ` · ${l.brand}` : ""}</span></button>)}</div>
              <button onClick={() => setOther(true)} className="text-[14px] text-accent hover:underline mt-2">It is not on the manifest</button>
            </div>
          )
        ) : (
          <div className="mt-4">
            <p className="text-[14px] text-muted">What is it? It is added to this delivery and known on every delivery after.</p>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4 mt-2">
              {(["brand", "style", "color", "size"] as const).map((k) => (
                <label key={k} className="text-[13px] text-muted">{k === "brand" ? "Brand" : k === "style" ? "Style or name" : k === "color" ? "Colour" : "Size"}
                  <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={k === "size" ? "11, M, or One size" : ""} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 h-11 text-[15px]`} /></label>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button disabled={busy || !f.style.trim() || !f.size.trim()} onClick={() => send({ item: asItem() })} className={WH_BTN_PRIMARY}>Match</button>
              {lines.length > 0 && <button onClick={() => setOther(false)} className={WH_BTN_SECONDARY}>Pick from the manifest</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
