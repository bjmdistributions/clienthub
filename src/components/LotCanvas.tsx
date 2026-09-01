/**
 * The lot canvas — a wire diagram of how lots were built.
 *
 * Jack asked for this shape from the start: *"i wanted this from the start to be a wire
 * diagram almost of building lots"*, and then *"option 1 but i dont need to drag it. i need
 * it all formatted cleanly and to be responsive to screen changes."*
 *
 * # Two relations, drawn two different ways
 *
 * **Wires draw provenance** (`merged_from`): which lots a merge was built out of.
 * **Lanes draw containment** (`parent_id`): which branch a lot is displayed in.
 *
 * They are not the same relation and the previous screen conflated them into one indented
 * tree, which is the thing that was wrong. A merge sits *outside* the branch its sources came
 * from — Jack: *"it will be completely separate from the first branch i made"* — so a wire
 * crossing a lane boundary is not a glitch, it is the fact being reported.
 *
 * # Why this can be auto-laid-out and still legible
 *
 * A base lot may be inside at most one live merge, so every node has at most one consumer:
 * the provenance graph is an **in-forest**, not a general DAG. A forest placed by barycentre
 * has no inherent wire crossings, so nothing needs a crossing-minimisation pass and nothing
 * needs dragging.
 *
 * # Nodes in DOM, wires in SVG
 *
 * Cards carry checkboxes, buttons and focus order, so they are real DOM. Wires are rounded
 * orthogonal paths in one `aria-hidden` SVG behind them. Not `<canvas>`: a `<path>` with a
 * token class repaints on a theme flip with zero JavaScript, where a canvas would need a
 * MutationObserver and a full redraw — a liability that rots the first time a theme is added.
 * Both layers read the same layout object, so they cannot drift.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Download, Plus, Trash2 } from "lucide-react";
import { writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";
import { api, type LotBuild, type LotBuildDetail } from "../lib/api";
import { fmtAmount, parseAmount } from "../lib/format";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";

const n = (v: number) => v.toLocaleString();

/** Card and grid geometry. Kept together because the SVG and the DOM both read them. */
const NODE_W = 248;
const NODE_H = 92;
const ROW = 116;
const COL = 344;
const RAIL = 176;

const inp =
  "w-full bg-surface border border-line-2 rounded-lg px-2.5 h-8 text-[12px] text-ink " +
  "focus:outline-none focus:border-accent transition-colors";

type Placed = {
  lot: LotBuild;
  x: number;
  y: number;
  gen: number;
  row: number;
  lane: string | null;
};

type Lane = { id: string | null; branch: LotBuild | null; top: number; rows: number };

type Layout = {
  placed: Placed[];
  byId: Map<string, Placed>;
  lanes: Lane[];
  width: number;
  height: number;
  /** merge id -> the x of its shared vertical trunk */
  trunkX: Map<string, number>;
  /** every id that must render struck: sold, or a source of something sold */
  struck: Set<string>;
  /** lot id -> the merge that consumed it, if any */
  consumer: Map<string, LotBuild>;
};

/**
 * The five passes. Pure, so it can be reasoned about without a render.
 *
 * Generation grows LEFTWARD — `x = (maxGen - gen) * COL` — because Jack described combining
 * as *"a new wire to the left gets built out"*. Base lots therefore sit on the right, where
 * the eye starts, and each merge steps left of everything it consumed.
 */
function layout(rows: LotBuild[]): Layout {
  const lots = rows.filter((r) => (r.kind || "lot") !== "branch");
  const branches = rows
    .filter((r) => (r.kind || "lot") === "branch")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byIdLot = new Map(lots.map((l) => [l.id, l]));

  // 1. graph
  const sources = new Map<string, string[]>();
  const consumer = new Map<string, LotBuild>();
  for (const l of lots) {
    const from = (l.merged_from || []).filter((s) => byIdLot.has(s));
    sources.set(l.id, from);
    for (const s of from) consumer.set(s, l);
  }

  // 2. generation, memoised. Acyclic by construction — a lot may have one consumer, and
  // combine refuses a lot that already has one — but the guard costs nothing.
  const gen = new Map<string, number>();
  const genOf = (id: string, seen = new Set<string>()): number => {
    const hit = gen.get(id);
    if (hit !== undefined) return hit;
    if (seen.has(id)) return 0;
    seen.add(id);
    const from = sources.get(id) || [];
    const g = from.length === 0 ? 0 : 1 + Math.max(...from.map((s) => genOf(s, seen)));
    gen.set(id, g);
    return g;
  };
  lots.forEach((l) => genOf(l.id));
  const maxGen = lots.length ? Math.max(...lots.map((l) => gen.get(l.id) ?? 0)) : 0;

  // 3. lanes — the unbranched lot lane first, then one band per branch.
  const laneIds: (string | null)[] = [null, ...branches.map((b) => b.id)];
  const laneOf = (l: LotBuild) => (l.parent_id && branches.some((b) => b.id === l.parent_id) ? l.parent_id : null);

  // 4. rows — one global cursor, walked lane by lane. A merge lands at the barycentre of
  // whichever of its sources share its lane; a source in another lane keeps its own row.
  const rowOf = new Map<string, number>();
  const lanes: Lane[] = [];
  let cursor = 0;
  for (const laneId of laneIds) {
    const members = lots.filter((l) => laneOf(l) === laneId);
    if (!members.length && laneId === null) continue;
    const top = cursor;
    const roots = members
      .filter((m) => !consumer.has(m.id) || laneOf(consumer.get(m.id)!) !== laneId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const visit = (m: LotBuild) => {
      if (rowOf.has(m.id)) return;
      const inLane = (sources.get(m.id) || [])
        .map((s) => byIdLot.get(s)!)
        .filter((s) => s && laneOf(s) === laneId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (!inLane.length) {
        rowOf.set(m.id, cursor++);
        return;
      }
      inLane.forEach(visit);
      const rs = inLane.map((s) => rowOf.get(s.id)!);
      rowOf.set(m.id, rs.reduce((t, r) => t + r, 0) / rs.length);
    };
    roots.forEach(visit);
    // Anything the walk did not reach (a merge whose sources are all elsewhere).
    members.forEach((m) => {
      if (!rowOf.has(m.id)) rowOf.set(m.id, cursor++);
    });
    lanes.push({
      id: laneId,
      branch: laneId ? branches.find((b) => b.id === laneId) ?? null : null,
      top,
      rows: Math.max(1, cursor - top),
    });
    cursor += 1; // one blank row between bands
  }

  // 5. coordinates
  const placed: Placed[] = lots.map((l) => {
    const g = gen.get(l.id) ?? 0;
    return {
      lot: l,
      gen: g,
      row: rowOf.get(l.id) ?? 0,
      lane: laneOf(l),
      x: (maxGen - g) * COL + RAIL,
      y: (rowOf.get(l.id) ?? 0) * ROW,
    };
  });
  const byId = new Map(placed.map((p) => [p.lot.id, p]));

  // One vertical trunk per merge, staggered within its column so two never share a line.
  const trunkX = new Map<string, number>();
  const merges = placed.filter((p) => (sources.get(p.lot.id) || []).length > 0);
  const byGen = new Map<number, Placed[]>();
  merges.forEach((m) => byGen.set(m.gen, [...(byGen.get(m.gen) || []), m]));
  byGen.forEach((list) => {
    list
      .sort((a, b) => a.row - b.row)
      .forEach((m, i) => trunkX.set(m.lot.id, m.x + NODE_W + 16 + i * 10));
  });

  // The red strike travels DOWN the wire only. Selling a source never strikes its merge —
  // that combination is refused when the merge is made.
  const struck = new Set<string>();
  const strike = (id: string) => {
    if (struck.has(id)) return;
    struck.add(id);
    (sources.get(id) || []).forEach(strike);
  };
  lots.filter((l) => l.status === "sold").forEach((l) => strike(l.id));

  return {
    placed,
    byId,
    lanes,
    width: (maxGen + 1) * COL + RAIL,
    height: Math.max(cursor, 1) * ROW,
    trunkX,
    struck,
    consumer,
  };
}

/** One source→merge wire: an orthogonal bracket onto the merge's shared trunk. */
function wirePath(s: Placed, m: Placed, t: number): string {
  const sx = s.x;
  const sy = s.y + NODE_H / 2;
  const mx = m.x + NODE_W;
  const my = m.y + NODE_H / 2;
  const R = 8;
  if (Math.abs(sy - my) < 2 * R) return `M ${sx} ${sy} H ${mx}`;
  const down = my > sy;
  const a = down ? sy + R : sy - R;
  const b = down ? my - R : my + R;
  return (
    `M ${sx} ${sy} H ${t + R} Q ${t} ${sy} ${t} ${a} V ${b} Q ${t} ${my} ${t + R} ${my} H ${mx}`
  );
}

export default function LotCanvas({
  sheetId,
  onChanged,
}: {
  sheetId: string;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<LotBuild[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, LotBuildDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState<string | null>(null);
  const [combineName, setCombineName] = useState("");
  const [combinePct, setCombinePct] = useState("");
  const [narrow, setNarrow] = useState(false);
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  const [confirmRemove, setConfirmRemove] = useState<LotBuild | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pctDraft, setPctDraft] = useState<Record<string, string>>({});
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const wrap = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setDetail({});
    setSelected(new Set());
    api.listLotBuilds(sheetId).then(setRows).catch((e) => toast(String(e), "error"));
  }, [sheetId]);
  useEffect(load, [load]);

  // The phone/narrow layout is chosen from the PANE, not the viewport. The desktop shell is
  // a fixed 216px sidebar beside the content, so a viewport media query fires a step early
  // and the canvas would go narrow while there is still room for it.
  // Keyed on `rows` because the measured element does not exist until the first load
  // finishes: an effect that ran once on mount attached to nothing and never retried, so the
  // canvas stayed wide on a phone. The observer is cheap to re-attach.
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setNarrow(el.getBoundingClientRect().width < 720);
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);

  const L = useMemo(() => layout(rows ?? []), [rows]);
  const branches = useMemo(
    () => (rows ?? []).filter((r) => (r.kind || "lot") === "branch"),
    [rows],
  );

  /** Everything in this node's provenance tree, for the focus/dim pass. */
  const related = useMemo(() => {
    if (!focus) return null;
    const keep = new Set<string>([focus]);
    const down = (id: string) => {
      const p = L.byId.get(id);
      (p?.lot.merged_from || []).forEach((s) => {
        if (keep.has(s)) return;
        keep.add(s);
        down(s);
      });
    };
    down(focus);
    let up = L.consumer.get(focus);
    while (up) {
      keep.add(up.id);
      up = L.consumer.get(up.id);
    }
    return keep;
  }, [focus, L]);

  const pickable = (b: LotBuild) =>
    b.status === "saved" && !b.archived && !L.consumer.has(b.id) && (b.kind || "lot") !== "branch";

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const pickedPct = useMemo(() => {
    const kids = (rows ?? []).filter((r) => selected.has(r.id));
    const s = new Set(kids.map((k) => k.price_pct));
    return s.size === 1 ? [...s][0] : null;
  }, [rows, selected]);

  const newBranch = async (name: string) => {
    if (!name.trim()) return;
    try {
      await api.createLotBranch(sheetId, name.trim());
      setBranchDraft(null);
      load();
      toast(`Branch "${name.trim()}" added.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const combine = async (branchId: string | null) => {
    const ids = [...selected];
    const pct = pickedPct ?? parseAmount(combinePct) / 100;
    if (!(pct > 0)) {
      toast("Those lots are priced differently — set the percentage first.", "error");
      return;
    }
    setBusy("combine");
    try {
      const b = await api.combineLotBuilds({
        sheetId,
        name: combineName.trim() || `Combined ${new Date().toISOString().slice(0, 10)}`,
        childIds: ids,
        pricePct: pct,
        branchId,
      });
      setCombineName("");
      setCombinePct("");
      load();
      onChanged();
      toast(`${b.name} — ${n(b.units)} units from ${ids.length} lots. They stay sellable on their own.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const markSold = async (b: LotBuild, sold: boolean) => {
    setBusy(b.id);
    try {
      const touched = await api.markLotSold(b.id, sold);
      load();
      onChanged();
      toast(
        sold
          ? touched > 1
            ? `${b.name} sold — and the ${touched - 1} lots it was built from. Cross them off your master spreadsheet.`
            : `${b.name} sold.`
          : `${b.name} is back on.`,
      );
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const download = async (b: LotBuild, kind: "branch" | "lot") => {
    const safe = b.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = await saveDialog({
      defaultPath: `${safe}.xlsx`,
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (!dest) return;
    setBusy(b.id);
    try {
      const r =
        kind === "branch"
          ? await api.exportBranchWorkbook(sheetId, b.id === "__top" ? null : b.id, b.name, dest)
          : await api.exportLotWorkbook(b.id, dest);
      toast(
        kind === "branch"
          ? `${n(r.rows)} lots, one page each, plus the breakdown.`
          : `Two pages — the breakdown and ${n(r.rows)} lines.`,
      );
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  /** The three stack exports. Straight to a save dialog, as they always were. */
  const exportOne = async (b: LotBuild, kind: "manifest" | "brands" | "pull") => {
    const safe = b.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = await saveDialog({
      defaultPath: `${safe}-${kind}.${format}`,
      filters: [
        format === "xlsx"
          ? { name: "Excel workbook", extensions: ["xlsx"] }
          : { name: "CSV", extensions: ["csv"] },
      ],
    });
    if (!dest) return;
    setBusy(b.id);
    try {
      const r = await api.exportLotBuild(b.id, kind, { format, destPath: dest });
      toast(`${n(r.rows)} rows written.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  /**
   * The slot codes, on the clipboard in one action — the thing Jack reaches for most.
   *
   * The NATIVE clipboard, never navigator.clipboard: the web API throws NotAllowedError in
   * this webview because the click has already been through an await (the codes are fetched
   * first) and no longer counts as the user gesture it demands. Same reason as R-214.
   */
  const copyCodes = async (b: LotBuild) => {
    setBusy(b.id);
    try {
      const codes = await api.lotBuildLocationCodes(b.id);
      await clipboardWrite(codes);
      toast(`${n(codes.split("\n").filter(Boolean).length)} codes copied.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const rename = async (b: LotBuild) => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name === b.name) return;
    try {
      await api.renameLotBuild(b.id, name);
      load();
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  /** One percentage across this one lot, replacing any per-category rates. */
  const reprice = async (b: LotBuild) => {
    const pct = pctDraft[b.id] ? parseAmount(pctDraft[b.id]) / 100 : b.price_pct;
    const cost = costDraft[b.id] ? parseAmount(costDraft[b.id]) / 100 : b.cost_pct;
    setBusy(b.id);
    try {
      await api.repriceLotBuild(b.id, pct, cost);
      setPctDraft((d) => ({ ...d, [b.id]: "" }));
      setCostDraft((d) => ({ ...d, [b.id]: "" }));
      load();
      onChanged();
      toast("Repriced.");
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const archive = async (b: LotBuild) => {
    try {
      await api.archiveLotBuild(b.id, true);
      load();
      onChanged();
      toast("Lot archived. Slots that were only staged are back in the pool.");
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const putBack = async (b: LotBuild) => {
    try {
      await api.removeLotFromMasterList(b.id, false);
      load();
      onChanged();
      toast("Put back on the master list.");
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const expand = async (b: LotBuild) => {
    if (open === b.id) {
      setOpen(null);
      return;
    }
    setOpen(b.id);
    if (detail[b.id]) return;
    try {
      const d = await api.lotBuildDetail(b.id);
      setDetail((m) => ({ ...m, [b.id]: d }));
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  if (!rows)
    return (
      <div ref={wrap}>
        <div className="h-40 rounded-xl bg-surface-2 animate-pulse" />
      </div>
    );

  return (
    <div ref={wrap} className="space-y-3">
      <Chrome
        rows={rows}
        branches={branches}
        branchDraft={branchDraft}
        setBranchDraft={setBranchDraft}
        newBranch={newBranch}
      />

      {selected.size > 0 && (
        <CombineBar
          count={selected.size}
          units={[...selected].reduce((t, id) => t + (L.byId.get(id)?.lot.units ?? 0), 0)}
          branches={branches}
          name={combineName}
          setName={setCombineName}
          pct={combinePct}
          setPct={setCombinePct}
          needsPct={pickedPct === null}
          busy={busy === "combine"}
          onCombine={combine}
          onClear={() => setSelected(new Set())}
        />
      )}

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          No lots built from this sheet yet. Build one on the first tab and it appears here.
        </p>
      ) : narrow ? (
        <Outline
          L={L}
          branches={branches}
          selected={selected}
          pickable={pickable}
          onToggle={toggle}
          onSold={markSold}
          onDownload={download}
          onExpand={expand}
          open={open}
          detail={detail}
          busy={busy}
          onPricing={load}
        />
      ) : (
        <Canvas
          L={L}
          selected={selected}
          related={related}
          pickable={pickable}
          onToggle={toggle}
          onFocus={setFocus}
          onSold={markSold}
          onDownload={download}
          onExpand={expand}
          open={open}
          busy={busy}
          onPricing={load}
        />
      )}

      {/* THE WORKBENCH. A 248px card cannot hold eight controls, so the canvas navigates
          and this panel does the work — everything the old list row had, on the lot you
          clicked. Removing these was the mistake this panel exists to undo. */}
      {open && detail[open] && (
        <LotWorkbench
          build={detail[open].build}
          detail={detail[open]}
          format={format}
          setFormat={setFormat}
          renaming={renaming === open}
          draft={draft}
          setDraft={setDraft}
          startRename={(b) => {
            setDraft(b.name);
            setRenaming(b.id);
          }}
          onRename={rename}
          pctDraft={pctDraft[open] ?? ""}
          setPctDraft={(v) => setPctDraft((d) => ({ ...d, [open]: v }))}
          costDraft={costDraft[open] ?? ""}
          setCostDraft={(v) => setCostDraft((d) => ({ ...d, [open]: v }))}
          onReprice={reprice}
          onExport={exportOne}
          onWorkbook={(b) => download(b, "lot")}
          onCopyCodes={copyCodes}
          onSold={markSold}
          onRemove={setConfirmRemove}
          onPutBack={putBack}
          onArchive={archive}
          onClose={() => setOpen(null)}
          busy={busy}
        />
      )}

      {confirmRemove && (
        <div
          className="fixed inset-0 z-50 bg-ink/30 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-surface rounded-2xl border border-line max-w-[460px] w-full p-5">
            <p className="text-[15px] font-semibold text-ink">
              Take {confirmRemove.locations} slots off the master list?
            </p>
            <p className="text-[12.5px] text-muted mt-2 leading-relaxed">
              This says the stock has physically left. Those locations stay off every future
              search, and they stay off even when a refreshed export still lists them — absent
              means shipped, not undone. Nothing is deleted, and you can put them back from
              here.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmRemove(null)}
                className="text-[12.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const b = confirmRemove;
                  setConfirmRemove(null);
                  try {
                    const c = await api.removeLotFromMasterList(b.id, true);
                    load();
                    onChanged();
                    toast(`${n(c)} locations are off the master list for good.`);
                  } catch (e: any) {
                    toast(String(e), "error");
                  }
                }}
                className="text-[12.5px] bg-danger text-on-accent px-3 h-9 rounded-lg hover:opacity-90 transition-opacity"
              >
                Take them off
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ chrome ----------- */

function Chrome(p: {
  rows: LotBuild[];
  branches: LotBuild[];
  branchDraft: string | null;
  setBranchDraft: (v: string | null) => void;
  newBranch: (name: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <p className="text-[12.5px] text-muted">
        {p.rows.length === 0
          ? "Nothing here yet."
          : `${n(p.rows.length - p.branches.length)} lots in ${p.branches.length} ${
              p.branches.length === 1 ? "branch" : "branches"
            }. Wires show what each combined lot was built from.`}
      </p>
      {p.branchDraft === null ? (
        <button
          onClick={() => p.setBranchDraft("")}
          className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-8 rounded-lg transition-colors"
        >
          <Plus size={12} /> New branch
        </button>
      ) : (
        <input
          autoFocus
          className={`${inp} max-w-[240px]`}
          placeholder="Name this branch, then Enter"
          value={p.branchDraft}
          onChange={(e) => p.setBranchDraft(e.target.value)}
          onBlur={() => (p.branchDraft!.trim() ? p.newBranch(p.branchDraft!) : p.setBranchDraft(null))}
          onKeyDown={(e) => {
            if (e.key === "Enter") p.newBranch(p.branchDraft!);
            if (e.key === "Escape") p.setBranchDraft(null);
          }}
        />
      )}
    </div>
  );
}

function CombineBar(p: {
  count: number;
  units: number;
  branches: LotBuild[];
  name: string;
  setName: (v: string) => void;
  pct: string;
  setPct: (v: string) => void;
  needsPct: boolean;
  busy: boolean;
  onCombine: (branchId: string | null) => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-0 z-30 rounded-xl border border-accent bg-surface-2 px-3.5 py-2.5 flex items-center gap-2.5 flex-wrap">
      <p className="text-[12.5px] text-ink">
        <span className="font-semibold tabular-nums">{n(p.count)}</span> picked ·{" "}
        <span className="tabular-nums">{n(p.units)}</span> units
      </p>
      <div className="flex-1" />
      {p.count < 2 ? (
        <p className="text-[11.5px] text-muted">Pick one more to combine them into a new lot.</p>
      ) : (
        <>
          <input
            className={`${inp} max-w-[190px]`}
            placeholder="Name the new lot"
            value={p.name}
            onChange={(e) => p.setName(e.target.value)}
          />
          {p.needsPct && (
            <label className="text-[11px] text-muted flex items-center gap-1.5">
              Sell at %
              <NumberInput
                className="w-16 bg-surface border border-line-2 rounded-md px-2 h-8 text-[12px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors"
                placeholder="30"
                value={p.pct}
                onValue={(_, raw) => p.setPct(raw)}
              />
            </label>
          )}
          <Btn onClick={() => p.onCombine(null)} busy={p.busy}>
            Combine
          </Btn>
          {p.branches.map((b) => (
            <Btn key={b.id} onClick={() => p.onCombine(b.id)} busy={p.busy}>
              into {b.name}
            </Btn>
          ))}
        </>
      )}
      <Btn onClick={p.onClear}>Clear</Btn>
    </div>
  );
}

function Btn(p: { onClick: () => void; busy?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={p.onClick}
      disabled={p.busy}
      className="text-[11.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-2.5 h-8 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
    >
      {p.busy ? "…" : p.children}
    </button>
  );
}

/* ------------------------------------------------------------------ the canvas ------- */

function Canvas(p: {
  L: Layout;
  selected: Set<string>;
  related: Set<string> | null;
  pickable: (b: LotBuild) => boolean;
  onToggle: (id: string) => void;
  onFocus: (id: string | null) => void;
  onSold: (b: LotBuild, sold: boolean) => void;
  onDownload: (b: LotBuild, kind: "branch" | "lot") => void;
  onExpand: (b: LotBuild) => void;
  open: string | null;
  busy: string | null;
  onPricing: () => void;
}) {
  const { L } = p;
  const dim = (id: string) => (p.related && !p.related.has(id) ? "opacity-30" : "");

  return (
    <div className="rounded-xl border border-line bg-surface overflow-x-auto overscroll-x-contain">
      <div className="relative" style={{ width: L.width, height: L.height + 24 }}>
        {/* Lane bands, behind everything. No border box: a frame round a branch would be
            crossed by every wire leaving it, and would assert exactly the containment the
            model denies — a merge lives OUTSIDE the branch its sources came from. */}
        {L.lanes.map((lane, i) => (
          <div
            key={lane.id ?? "loose"}
            className={`absolute left-0 right-0 ${i % 2 ? "bg-surface-2" : ""}`}
            style={{ top: lane.top * ROW - 8, height: lane.rows * ROW }}
          />
        ))}

        {/* Wires. aria-hidden on purpose: provenance reaches a screen reader through each
            merged card's own label, which is better than a <title> on a path. */}
        <svg
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          width={L.width}
          height={L.height + 24}
        >
          {L.placed.flatMap((m) =>
            (m.lot.merged_from || [])
              .map((sid) => L.byId.get(sid))
              .filter((s): s is Placed => !!s)
              .map((s) => {
                const t = L.trunkX.get(m.lot.id) ?? m.x + NODE_W + 16;
                const isStruck = L.struck.has(m.lot.id);
                const lit = !!p.related?.has(m.lot.id) && !!p.related?.has(s.lot.id);
                return (
                  <path
                    key={`${s.lot.id}->${m.lot.id}`}
                    d={wirePath(s, m, t)}
                    fill="none"
                    strokeWidth={isStruck || lit ? 1.5 : 1}
                    className={
                      isStruck
                        ? "stroke-danger-ink"
                        : lit
                          ? "stroke-accent"
                          : `stroke-muted ${p.related ? "opacity-20" : "opacity-40"}`
                    }
                    style={{ transition: "opacity 130ms" }}
                  />
                );
              }),
          )}
        </svg>

        {/* Lane rails, sticky so the branch name and its money stay put while the
            generations scroll sideways. */}
        {L.lanes.map((lane) => (
          <div
            key={`rail-${lane.id ?? "loose"}`}
            className="absolute sticky left-0 z-20 pr-3"
            style={{ top: lane.top * ROW, width: RAIL }}
          >
            <LaneRail
              lane={lane}
              L={L}
              onDownload={p.onDownload}
              busy={p.busy}
              onPricing={p.onPricing}
            />
          </div>
        ))}

        {L.placed.map((pl) => (
          <div
            key={pl.lot.id}
            className={`absolute transition-opacity ${dim(pl.lot.id)}`}
            style={{ left: pl.x, top: pl.y, width: NODE_W }}
            onMouseEnter={() => p.onFocus(pl.lot.id)}
            onMouseLeave={() => p.onFocus(null)}
          >
            <Node
              pl={pl}
              L={L}
              picked={p.selected.has(pl.lot.id)}
              pickable={p.pickable(pl.lot)}
              onToggle={p.onToggle}
              onSold={p.onSold}
              onDownload={p.onDownload}
              onExpand={p.onExpand}
              open={p.open === pl.lot.id}
              busy={p.busy}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A branch's title, its money, and the one control that prices every lot inside it. */
function LaneRail(p: {
  lane: Lane;
  L: Layout;
  onDownload: (b: LotBuild, kind: "branch" | "lot") => void;
  busy: string | null;
  onPricing: () => void;
}) {
  const members = p.L.placed.filter((x) => x.lane === p.lane.id && x.lot.status === "saved");
  const units = members.reduce((t, m) => t + m.lot.units, 0);
  const ask = members.reduce((t, m) => t + m.lot.ask_total, 0);
  const cost = members.reduce((t, m) => t + m.lot.msrp_total * m.lot.cost_pct, 0);
  const b = p.lane.branch;
  const [pct, setPct] = useState("");
  const [cpct, setCpct] = useState("");
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    if (!b) return;
    const sell = parseAmount(pct) / 100;
    if (!(sell > 0)) {
      toast("Type the percentage of retail you sell at.", "error");
      return;
    }
    setSaving(true);
    try {
      const count = await api.setBranchPricing(
        b.id,
        sell,
        cpct ? parseAmount(cpct) / 100 : undefined,
      );
      toast(`${n(count)} lots repriced.`);
      p.onPricing();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setSaving(false);
  };

  return (
    <div className="bg-surface/95 backdrop-blur rounded-lg border border-line-2 p-2.5">
      <p className="text-[13px] font-semibold text-ink truncate">
        {b ? b.name : "Not in a branch"}
      </p>
      <p className="text-[10.5px] text-muted tabular-nums mt-0.5">
        {n(members.length)} {members.length === 1 ? "lot" : "lots"} · {n(units)} units
      </p>
      <p className="text-[11px] text-ink-2 tabular-nums mt-1">{fmtAmount(ask)}</p>
      {cost > 0 && (
        <p className="text-[10.5px] text-accent tabular-nums">You keep {fmtAmount(ask - cost)}</p>
      )}
      {/* The top level is a level too. Before this it had no Spreadsheet button at all, so
          twenty-one unbranched lots had nowhere to download from — the single worst thing
          the canvas rewrite broke. Its workbook is the same shape as a branch's. */}
      {!b && (
        <button
          onClick={() =>
            p.onDownload(
              { id: "__top", name: "Master list" } as unknown as LotBuild,
              "branch",
            )
          }
          disabled={p.busy === "__top"}
          className="w-full mt-2 h-7 rounded-md border border-line-3 text-[11px] text-ink-2 hover:border-accent hover:text-accent transition-colors flex items-center justify-center gap-1"
        >
          <Download size={11} /> Spreadsheet
        </button>
      )}
      {b && (
        <>
          {/* One percentage and one cost for the WHOLE branch. It overrides whatever each lot
              was priced at, which is what "applies to every single lot" asks for. */}
          <div className="grid grid-cols-2 gap-1.5 mt-2">
            <NumberInput
              className="bg-surface border border-line-2 rounded-md px-1.5 h-7 text-[11px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors"
              placeholder={`${(b.price_pct * 100).toFixed(0)}%`}
              value={pct}
              onValue={(_, raw) => setPct(raw)}
            />
            <NumberInput
              className="bg-surface border border-line-2 rounded-md px-1.5 h-7 text-[11px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors"
              placeholder={b.cost_pct > 0 ? `${(b.cost_pct * 100).toFixed(0)}%` : "cost"}
              value={cpct}
              onValue={(_, raw) => setCpct(raw)}
            />
          </div>
          <button
            onClick={apply}
            disabled={saving}
            className="w-full mt-1.5 h-7 rounded-md bg-accent text-on-accent text-[11px] font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? "…" : "Price every lot"}
          </button>
          <button
            onClick={() => p.onDownload(b, "branch")}
            disabled={p.busy === b.id}
            className="w-full mt-1 h-7 rounded-md border border-line-3 text-[11px] text-ink-2 hover:border-accent hover:text-accent transition-colors flex items-center justify-center gap-1"
          >
            <Download size={11} /> Spreadsheet
          </button>
        </>
      )}
    </div>
  );
}

function Node(p: {
  pl: Placed;
  L: Layout;
  picked: boolean;
  pickable: boolean;
  onToggle: (id: string) => void;
  onSold: (b: LotBuild, sold: boolean) => void;
  onDownload: (b: LotBuild, kind: "branch" | "lot") => void;
  onExpand: (b: LotBuild) => void;
  open: boolean;
  busy: string | null;
}) {
  const b = p.pl.lot;
  const merged = (b.merged_from || []).length > 0;
  const struck = p.L.struck.has(b.id);
  const consumer = p.L.consumer.get(b.id);
  const sold = b.status === "sold";

  // The reason a lot cannot be picked belongs ON the card, not in a toast after the click.
  const pill = sold
    ? consumer && !merged
      ? `sold in ${consumer.name}`
      : "sold"
    : b.status === "sent"
      ? "off the list"
      : consumer
        ? `in ${consumer.name}`
        : merged
          ? `merged from ${b.merged_from.length}`
          : "in a lot";

  return (
    <div
      className={`rounded-xl border px-2.5 py-2 ${
        merged ? "bg-surface-2 border-line-3 ring-1 ring-accent/30" : "bg-surface border-line"
      } ${struck ? "border-danger" : ""} ${p.picked ? "border-accent" : ""} ${
        b.status === "sent" ? "opacity-60" : ""
      }`}
      style={{ minHeight: NODE_H }}
    >
      <div className="flex items-start gap-1.5">
        {p.pickable && (
          <input
            type="checkbox"
            checked={p.picked}
            onChange={() => p.onToggle(b.id)}
            className="mt-0.5 accent-accent shrink-0"
            aria-label={`Pick ${b.name} to combine`}
          />
        )}
        <button
          onClick={() => p.onExpand(b)}
          className="min-w-0 flex-1 text-left group"
          aria-expanded={p.open}
          aria-label={
            merged
              ? `${b.name}, merged from ${b.merged_from.length} lots`
              : consumer
                ? `${b.name}, inside ${consumer.name}`
                : b.name
          }
        >
          <span
            className={`block text-[12.5px] font-semibold truncate group-hover:text-accent transition-colors ${
              struck ? "line-through text-danger-ink" : "text-ink"
            }`}
          >
            {b.name}
          </span>
        </button>
        <span className="text-[9.5px] text-muted shrink-0 mt-0.5 max-w-[86px] truncate">
          {pill}
        </span>
      </div>
      <p className="text-[10.5px] text-ink-2 tabular-nums mt-1">
        {n(b.units)} units · {fmtAmount(b.msrp_total)} ·{" "}
        <span className="text-accent font-medium">{fmtAmount(b.ask_total)}</span>
      </p>
      {b.cost_pct > 0 && (
        <p className="text-[10px] text-muted tabular-nums">
          You keep {fmtAmount(b.ask_total - b.msrp_total * b.cost_pct)}
        </p>
      )}
      {struck && (
        <p className="text-[9.5px] text-danger-ink mt-0.5 leading-tight">
          cross this off your master spreadsheet
        </p>
      )}
      <div className="flex items-center gap-1 mt-1.5">
        <MiniBtn onClick={() => p.onDownload(b, "lot")} busy={p.busy === b.id}>
          <Download size={10} /> Sheet
        </MiniBtn>
        <MiniBtn onClick={() => p.onSold(b, !sold)} busy={p.busy === b.id}>
          {sold ? "Not sold" : "Sold"}
        </MiniBtn>
      </div>
    </div>
  );
}

function MiniBtn(p: { onClick: () => void; busy?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={p.onClick}
      disabled={p.busy}
      className="text-[10px] text-muted border border-line-2 hover:border-accent hover:text-accent px-1.5 h-6 rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
    >
      {p.children}
    </button>
  );
}

/* ------------------------------------------------------------------ narrow ----------- */

/**
 * The narrow layout. **Not a shrunken canvas** — Jack asked for *"a cleaner layout that still
 * is easy to tell"* on small screens, and wires drawn at phone width are unreadable however
 * they are routed.
 *
 * Provenance reads as an indented "built from" list under each merge instead of a wire. It
 * carries the same information in the same direction and survives 21 lots, which a scaled
 * canvas does not.
 */
function Outline(p: {
  L: Layout;
  branches: LotBuild[];
  selected: Set<string>;
  pickable: (b: LotBuild) => boolean;
  onToggle: (id: string) => void;
  onSold: (b: LotBuild, sold: boolean) => void;
  onDownload: (b: LotBuild, kind: "branch" | "lot") => void;
  onExpand: (b: LotBuild) => void;
  open: string | null;
  detail: Record<string, LotBuildDetail>;
  busy: string | null;
  onPricing: () => void;
}) {
  return (
    <div className="space-y-4">
      {p.L.lanes.map((lane) => {
        const members = p.L.placed.filter((x) => x.lane === lane.id);
        return (
          <section key={lane.id ?? "loose"} className="space-y-2">
            <LaneRail
              lane={lane}
              L={p.L}
              onDownload={p.onDownload}
              busy={p.busy}
              onPricing={p.onPricing}
            />
            {members.map((pl) => (
              <div key={pl.lot.id} className="space-y-1">
                <Node
                  pl={pl}
                  L={p.L}
                  picked={p.selected.has(pl.lot.id)}
                  pickable={p.pickable(pl.lot)}
                  onToggle={p.onToggle}
                  onSold={p.onSold}
                  onDownload={p.onDownload}
                  onExpand={p.onExpand}
                  open={p.open === pl.lot.id}
                  busy={p.busy}
                />
                {(pl.lot.merged_from || []).length > 0 && (
                  <ul className="pl-4 border-l border-line-2 ml-2 space-y-0.5">
                    {pl.lot.merged_from.map((sid) => {
                      const s = p.L.byId.get(sid);
                      if (!s) return null;
                      const struck = p.L.struck.has(sid);
                      return (
                        <li
                          key={sid}
                          className={`text-[11px] tabular-nums ${
                            struck ? "line-through text-danger-ink" : "text-muted"
                          }`}
                        >
                          built from {s.lot.name} · {n(s.lot.units)} units
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** The per-lot breakdown, unchanged in substance from the one the Lots tab already had. */
function Breakdown({ detail }: { detail: LotBuildDetail }) {
  const t = detail.totals;
  const risk = t.title_risk_units;
  const flagged = risk[2] + risk[3];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fig label="Units" value={n(t.units)} />
        <Fig label="Styles" value={n(t.styles)} />
        <Fig label="Retail" value={fmtAmount(t.msrp)} />
        <Fig label="Price" value={fmtAmount(t.ask)} accent />
      </div>
      {t.by_brand.length > 0 && (
        <Table
          title="By brand"
          rows={t.by_brand.map((g) => [g.name, n(g.units), `${(g.share * 100).toFixed(1)}%`, fmtAmount(g.ask)])}
        />
      )}
      {t.by_segment && t.by_segment.length > 0 && (
        <Table
          title="Who it is for"
          rows={t.by_segment.map((g) => [g.name, n(g.units), `${(g.share * 100).toFixed(1)}%`, fmtAmount(g.ask)])}
        />
      )}
      {flagged > 0 && (
        <p className="text-[11px] text-warning-ink bg-warning-bg border border-warning rounded-md px-2 py-1.5 leading-snug">
          {n(flagged)} units carry a description we could not take from the sheet.
        </p>
      )}
    </div>
  );
}

function Fig(p: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 border border-line-2 px-2.5 py-1.5">
      <p className="text-[10px] text-muted">{p.label}</p>
      <p className={`text-[13px] tabular-nums font-medium ${p.accent ? "text-accent" : "text-ink"}`}>
        {p.value}
      </p>
    </div>
  );
}

function Table(p: { title: string; rows: string[][] }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-ink-2 mb-1">{p.title}</p>
      <div className="space-y-0.5">
        {p.rows.slice(0, 10).map((r) => (
          <div key={r[0]} className="flex items-center gap-2 text-[11px]">
            <span className="flex-1 truncate text-ink-2">{r[0]}</span>
            <span className="tabular-nums text-muted w-16 text-right">{r[1]}</span>
            <span className="tabular-nums text-muted w-14 text-right">{r[2]}</span>
            <span className="tabular-nums text-ink-2 w-20 text-right">{r[3]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ workbench -------- */

/**
 * Everything a lot can do, on the lot you clicked.
 *
 * This is the part the canvas rewrite dropped and Jack noticed immediately: *"i cant even
 * click on each individual lots to get codes i need. you took away all the main features."*
 * Copy codes, the three stack exports, rename, reprice, archive and remove-from-master-list
 * were all working before and none of them were his to lose.
 */
function LotWorkbench(p: {
  build: LotBuild;
  detail: LotBuildDetail;
  format: "csv" | "xlsx";
  setFormat: (v: "csv" | "xlsx") => void;
  renaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  startRename: (b: LotBuild) => void;
  onRename: (b: LotBuild) => void;
  pctDraft: string;
  setPctDraft: (v: string) => void;
  costDraft: string;
  setCostDraft: (v: string) => void;
  onReprice: (b: LotBuild) => void;
  onExport: (b: LotBuild, kind: "manifest" | "brands" | "pull") => void;
  onWorkbook: (b: LotBuild) => void;
  onCopyCodes: (b: LotBuild) => void;
  onSold: (b: LotBuild, sold: boolean) => void;
  onRemove: (b: LotBuild) => void;
  onPutBack: (b: LotBuild) => void;
  onArchive: (b: LotBuild) => void;
  onClose: () => void;
  busy: string | null;
}) {
  const b = p.build;
  const sold = b.status === "sold";
  const sent = b.status === "sent";
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        {p.renaming ? (
          <input
            autoFocus
            className={`${inp} max-w-[320px]`}
            value={p.draft}
            onChange={(e) => p.setDraft(e.target.value)}
            onBlur={() => p.onRename(b)}
            onKeyDown={(e) => {
              if (e.key === "Enter") p.onRename(b);
              if (e.key === "Escape") p.onClose();
            }}
          />
        ) : (
          <p className="text-[14px] font-semibold text-ink truncate">{b.name}</p>
        )}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted">Download as</span>
          <div className="flex gap-1 bg-surface-2 rounded-lg p-1 border border-line-2">
            {(
              [
                ["xlsx", "Excel"],
                ["csv", "CSV"],
              ] as ["csv" | "xlsx", string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => p.setFormat(id)}
                className={`text-[11.5px] px-2.5 h-6 rounded-md transition-colors ${
                  p.format === id ? "bg-accent text-on-accent" : "text-ink-2 hover:text-accent"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={p.onClose}
            className="text-[11.5px] text-muted hover:text-accent transition-colors ml-1"
          >
            Close
          </button>
        </div>
      </div>

      {/* Priced here, before it is downloaded — one number across every line. */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 border border-line-2 px-2.5 py-2">
        <label className="text-[10.5px] text-muted">
          Sell at, % of retail
          <NumberInput
            className="w-20 bg-surface border border-line-2 rounded-md px-2 h-7 text-[11.5px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors mt-0.5"
            placeholder={(b.price_pct * 100).toFixed(1)}
            value={p.pctDraft}
            onValue={(_, raw) => p.setPctDraft(raw)}
          />
        </label>
        <label className="text-[10.5px] text-muted">
          Cost, %
          <NumberInput
            className="w-20 bg-surface border border-line-2 rounded-md px-2 h-7 text-[11.5px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors mt-0.5"
            placeholder={b.cost_pct > 0 ? (b.cost_pct * 100).toFixed(1) : "none"}
            value={p.costDraft}
            onValue={(_, raw) => p.setCostDraft(raw)}
          />
        </label>
        <Btn onClick={() => p.onReprice(b)} busy={p.busy === b.id}>
          Apply to all {n(b.units)} units
        </Btn>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Btn onClick={() => p.onWorkbook(b)} busy={p.busy === b.id}>
          Workbook — 2 pages
        </Btn>
        <Btn onClick={() => p.onExport(b, "manifest")} busy={p.busy === b.id}>
          Manifest
        </Btn>
        <Btn onClick={() => p.onExport(b, "brands")} busy={p.busy === b.id}>
          Brand counts
        </Btn>
        <Btn onClick={() => p.onExport(b, "pull")} busy={p.busy === b.id}>
          Pull sheet
        </Btn>
        <Btn onClick={() => p.onCopyCodes(b)} busy={p.busy === b.id}>
          Copy codes
        </Btn>
        <Btn onClick={() => p.startRename(b)}>Rename</Btn>
        <div className="flex-1" />
        <Btn onClick={() => p.onSold(b, !sold)} busy={p.busy === b.id}>
          {sold ? "Not sold after all" : "Mark sold"}
        </Btn>
        <Btn onClick={() => (sent ? p.onPutBack(b) : p.onRemove(b))}>
          {sent ? "Put back on the list" : "Remove from master list"}
        </Btn>
        <Btn onClick={() => p.onArchive(b)}>Archive</Btn>
      </div>

      <Breakdown detail={p.detail} />
    </div>
  );
}
