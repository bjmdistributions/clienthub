/**
 * Saved lots — one screen, one list.
 *
 * This replaces a 1,661-line file that carried a wire diagram, a barycentre layout pass, an
 * SVG router, a narrow outline AND a list behind a view toggle. Jack: *"you made a list
 * diagram and a wire view and they both suck ass. it should be one view."* He is right, and
 * the over-building was mine.
 *
 * # Two acts, and they are NOT the same act
 *
 * **Group into a branch** — `parent_id`. A branch is a folder and nothing more. Put 21 lots
 * in it, download, get a 22-page workbook: page 1 the master list, then one page per lot.
 * **Nothing is merged.** Jack: *"i dont want stuff combined when its in a branch."*
 *
 * **Combine into one lot** — `merged_from`. A separate, explicit button that makes ONE new
 * lot out of the picked ones. The originals carry on existing exactly as they were —
 * *"they both can exist at the same time"*.
 *
 * The previous screen had no way to do the first at all: `setLotParent` was never called, and
 * the button labelled "into <branch>" ran combine. So the only route into a branch merged the
 * lots. That is the defect this file exists to fix.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Download, FolderPlus, Layers, Plus } from "lucide-react";
import { writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";
import { api, type LotBuild, type LotBuildDetail } from "../lib/api";
import { fmtAmount, parseAmount } from "../lib/format";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";

const n = (v: number) => v.toLocaleString();

/** The manifest line section of one lot: what is actually in it. */
type LotLines = { title: string; headers: string[]; rows: string[][] };

const inp =
  "bg-surface border border-line-2 rounded-lg px-2.5 h-8 text-[12px] text-ink " +
  "focus:outline-none focus:border-accent transition-colors";

const kindOf = (b: LotBuild) => b.kind || "lot";

export default function LotsView({
  sheetId,
  onChanged,
}: {
  sheetId: string;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<LotBuild[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, LotBuildDetail>>({});
  const [lines, setLines] = useState<Record<string, LotLines>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  const [confirmRemove, setConfirmRemove] = useState<LotBuild | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pctDraft, setPctDraft] = useState<Record<string, string>>({});
  const [costDraft, setCostDraft] = useState<Record<string, string>>({});
  const [combineName, setCombineName] = useState("");
  const [combinePct, setCombinePct] = useState("");
  const [branchDraft, setBranchDraft] = useState<string | null>(null);

  const load = useCallback(() => {
    setDetail({});
    setLines({});
    setSelected(new Set());
    api.listLotBuilds(sheetId).then(setRows).catch((e) => toast(String(e), "error"));
  }, [sheetId]);
  useEffect(load, [load]);

  const branches = useMemo(
    () => (rows ?? []).filter((b) => kindOf(b) === "branch"),
    [rows],
  );
  const lots = useMemo(() => (rows ?? []).filter((b) => kindOf(b) !== "branch"), [rows]);

  /** lot id -> the combined lot it was merged into, if any. */
  const consumer = useMemo(() => {
    const m = new Map<string, LotBuild>();
    lots.forEach((l) => (l.merged_from || []).forEach((s) => m.set(s, l)));
    return m;
  }, [lots]);

  /**
   * Sold, or a source of something sold. Travels DOWN the merge list only — selling a source
   * never strikes the combined lot it went into.
   */
  const struck = useMemo(() => {
    const out = new Set<string>();
    const byId = new Map(lots.map((l) => [l.id, l]));
    const walk = (id: string) => {
      if (out.has(id)) return;
      out.add(id);
      (byId.get(id)?.merged_from || []).forEach(walk);
    };
    lots.filter((l) => l.status === "sold").forEach((l) => walk(l.id));
    return out;
  }, [lots]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const picked = useMemo(() => lots.filter((l) => selected.has(l.id)), [lots, selected]);

  // ---------------------------------------------------------------- the two acts -------

  /** GROUP. Moves the picked lots into a branch. Merges nothing. */
  const groupInto = async (branchId: string) => {
    setBusy("group");
    try {
      for (const l of picked) await api.setLotParent(l.id, branchId);
      const name = branches.find((b) => b.id === branchId)?.name ?? "the branch";
      load();
      onChanged();
      toast(`${n(picked.length)} lots moved into ${name}. Nothing was combined.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const ungroup = async (b: LotBuild) => {
    try {
      await api.setLotParent(b.id, null);
      load();
      toast(`${b.name} taken out of its branch.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const newBranch = async (name: string, thenGroup: boolean) => {
    if (!name.trim()) return;
    try {
      const b = await api.createLotBranch(sheetId, name.trim());
      setBranchDraft(null);
      if (thenGroup && picked.length) {
        for (const l of picked) await api.setLotParent(l.id, b.id);
        toast(`${b.name} created with ${n(picked.length)} lots in it.`);
      } else {
        toast(`Branch "${b.name}" added.`);
      }
      load();
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  /** COMBINE. Makes ONE new lot. The originals stay exactly where they are. */
  const combine = async () => {
    const pcts = new Set(picked.map((p) => p.price_pct));
    const pct = pcts.size === 1 ? [...pcts][0] : parseAmount(combinePct) / 100;
    if (!(pct > 0)) {
      toast("Those lots are priced differently — set the percentage first.", "error");
      return;
    }
    setBusy("combine");
    try {
      const b = await api.combineLotBuilds({
        sheetId,
        name: combineName.trim() || `Combined ${new Date().toISOString().slice(0, 10)}`,
        childIds: picked.map((p) => p.id),
        pricePct: pct,
      });
      setCombineName("");
      setCombinePct("");
      load();
      onChanged();
      toast(`${b.name} — ${n(b.units)} units. The ${picked.length} lots it came from are untouched.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  // ---------------------------------------------------------------- per-lot ------------

  const expand = async (b: LotBuild) => {
    if (open === b.id) {
      setOpen(null);
      return;
    }
    setOpen(b.id);
    if (!detail[b.id]) {
      try {
        const d = await api.lotBuildDetail(b.id);
        setDetail((m) => ({ ...m, [b.id]: d }));
      } catch (e: any) {
        toast(String(e), "error");
      }
    }
    if (!lines[b.id]) {
      try {
        const l = await api.lotBuildLines(b.id);
        setLines((m) => ({ ...m, [b.id]: l }));
      } catch (e: any) {
        toast(String(e), "error");
      }
    }
  };

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
   * The NATIVE clipboard, never `navigator.clipboard`: the web API throws NotAllowedError in
   * this webview because the click has already been through an await.
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

  /** The workbook. `node` null is the top level, a branch id is that branch. */
  const downloadLevel = async (node: LotBuild | null, title: string) => {
    const safe = title.replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = await saveDialog({
      defaultPath: `${safe}.xlsx`,
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (!dest) return;
    setBusy(node?.id ?? "__top");
    try {
      const r = await api.exportBranchWorkbook(sheetId, node?.id ?? null, title, dest);
      toast(`${n(r.rows + 1)} pages — MASTER, then one per lot.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const downloadLot = async (b: LotBuild) => {
    const safe = b.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = await saveDialog({
      defaultPath: `${safe}.xlsx`,
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (!dest) return;
    setBusy(b.id);
    try {
      await api.exportLotWorkbook(b.id, dest);
      toast("Two pages — the breakdown and every line.");
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

  const markSold = async (b: LotBuild, sold: boolean) => {
    setBusy(b.id);
    try {
      const touched = await api.markLotSold(b.id, sold);
      load();
      onChanged();
      toast(
        sold && touched > 1
          ? `${b.name} sold, and the ${touched - 1} lots it was built from. Cross them off your master sheet.`
          : sold
            ? `${b.name} sold.`
            : `${b.name} is back on.`,
      );
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const simple = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      load();
      onChanged();
      toast(msg);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  if (!rows) return <div className="h-40 rounded-xl bg-surface-2 animate-pulse" />;

  const inBranch = (id: string | null) =>
    lots.filter((l) => (l.parent_id ?? null) === id);
  const levels: { id: string | null; branch: LotBuild | null; title: string }[] = [
    { id: null, branch: null, title: "Not in a branch" },
    ...branches.map((b) => ({ id: b.id, branch: b, title: b.name })),
  ];

  return (
    <div className="max-w-[1000px] space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12.5px] text-muted">
          {lots.length === 0
            ? "No lots built from this sheet yet. Build one on the first tab and it appears here."
            : `${n(lots.length)} lots. Put them in a branch to download one spreadsheet with a page for each.`}
        </p>
        {branchDraft === null ? (
          <button
            onClick={() => setBranchDraft("")}
            className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-8 rounded-lg transition-colors"
          >
            <Plus size={12} /> New branch
          </button>
        ) : (
          <input
            autoFocus
            className={`${inp} w-[240px]`}
            placeholder="Name this branch, then Enter"
            value={branchDraft}
            onChange={(e) => setBranchDraft(e.target.value)}
            onBlur={() => (branchDraft.trim() ? newBranch(branchDraft, false) : setBranchDraft(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") newBranch(branchDraft, false);
              if (e.key === "Escape") setBranchDraft(null);
            }}
          />
        )}
      </div>

      {selected.size > 0 && (
        <SelectionBar
          picked={picked}
          branches={branches}
          busy={busy}
          combineName={combineName}
          setCombineName={setCombineName}
          combinePct={combinePct}
          setCombinePct={setCombinePct}
          onGroup={groupInto}
          onNewBranchWith={(name) => newBranch(name, true)}
          onCombine={combine}
          onClear={() => setSelected(new Set())}
        />
      )}

      {levels.map((lv) => {
        const members = inBranch(lv.id);
        if (lv.id === null && members.length === 0) return null;
        return (
          <section key={lv.id ?? "loose"} className="space-y-1.5">
            <LevelHeading
              level={lv}
              members={members}
              busy={busy}
              onDownload={() => downloadLevel(lv.branch, lv.branch ? lv.branch.name : "Master list")}
              onPriceAll={load}
              onRemoveBranch={
                lv.branch
                  ? () =>
                      simple(
                        () => api.archiveLotBuild(lv.branch!.id, true),
                        `Branch "${lv.branch!.name}" archived. Its lots went back to the top.`,
                      )
                  : undefined
              }
            />
            {members.length === 0 ? (
              <p className="text-[11.5px] text-muted pl-1">
                Empty. Tick lots above and press <b>Group into branch</b>.
              </p>
            ) : (
              members.map((b) => (
                <div key={b.id}>
                  <Row
                    b={b}
                    picked={selected.has(b.id)}
                    struck={struck.has(b.id)}
                    consumer={consumer.get(b.id)}
                    open={open === b.id}
                    onToggle={() => toggle(b.id)}
                    onExpand={() => expand(b)}
                  />
                  {open === b.id && (
                    <div className="mt-1 mb-2">
                      {detail[b.id] ? (
                        <Workbench
                          b={detail[b.id].build}
                          detail={detail[b.id]}
                          lines={lines[b.id]}
                          format={format}
                          setFormat={setFormat}
                          renaming={renaming === b.id}
                          draft={draft}
                          setDraft={setDraft}
                          startRename={() => {
                            setDraft(b.name);
                            setRenaming(b.id);
                          }}
                          onRename={() => rename(b)}
                          pctDraft={pctDraft[b.id] ?? ""}
                          setPctDraft={(v) => setPctDraft((d) => ({ ...d, [b.id]: v }))}
                          costDraft={costDraft[b.id] ?? ""}
                          setCostDraft={(v) => setCostDraft((d) => ({ ...d, [b.id]: v }))}
                          onReprice={() => reprice(b)}
                          onExport={(k) => exportOne(b, k)}
                          onWorkbook={() => downloadLot(b)}
                          onCopyCodes={() => copyCodes(b)}
                          onSold={() => markSold(b, b.status !== "sold")}
                          onRemove={() => setConfirmRemove(b)}
                          onPutBack={() =>
                            simple(
                              () => api.removeLotFromMasterList(b.id, false),
                              "Put back on the master list.",
                            )
                          }
                          onArchive={() =>
                            simple(() => api.archiveLotBuild(b.id, true), "Lot archived.")
                          }
                          onUngroup={b.parent_id ? () => ungroup(b) : undefined}
                          onClose={() => setOpen(null)}
                          busy={busy}
                        />
                      ) : (
                        <div className="h-32 rounded-xl bg-surface-2 animate-pulse" />
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        );
      })}

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
              means shipped, not undone. Nothing is deleted, and you can put them back here.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmRemove(null)}
                className="text-[12.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const b = confirmRemove;
                  setConfirmRemove(null);
                  simple(
                    () => api.removeLotFromMasterList(b.id, true),
                    "Those locations are off the master list for good.",
                  );
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

/* ------------------------------------------------------------------ selection -------- */

/**
 * The two acts, side by side and labelled for what they do.
 *
 * They were one button before, and that button merged — which is how grouping lots into a
 * branch ended up combining them.
 */
function SelectionBar(p: {
  picked: LotBuild[];
  branches: LotBuild[];
  busy: string | null;
  combineName: string;
  setCombineName: (v: string) => void;
  combinePct: string;
  setCombinePct: (v: string) => void;
  onGroup: (branchId: string) => void;
  onNewBranchWith: (name: string) => void;
  onCombine: () => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<null | "group" | "combine">(null);
  const [newName, setNewName] = useState("");
  const units = p.picked.reduce((t, b) => t + b.units, 0);
  const samePct = new Set(p.picked.map((b) => b.price_pct)).size === 1;

  return (
    <div className="sticky top-0 z-30 rounded-xl border border-accent bg-surface-2 px-3.5 py-2.5 space-y-2">
      <div className="flex items-center gap-2.5 flex-wrap">
        <p className="text-[12.5px] text-ink">
          <span className="font-semibold tabular-nums">{n(p.picked.length)}</span> picked ·{" "}
          <span className="tabular-nums">{n(units)}</span> units
        </p>
        <div className="flex-1" />
        <button
          onClick={() => setMode(mode === "group" ? null : "group")}
          className={`flex items-center gap-1.5 text-[12px] px-3 h-8 rounded-lg border transition-colors ${
            mode === "group"
              ? "bg-accent text-on-accent border-accent"
              : "text-ink-2 border-line-3 hover:border-accent hover:text-accent"
          }`}
        >
          <FolderPlus size={12} /> Group into branch
        </button>
        <button
          onClick={() => setMode(mode === "combine" ? null : "combine")}
          disabled={p.picked.length < 2}
          className={`flex items-center gap-1.5 text-[12px] px-3 h-8 rounded-lg border transition-colors disabled:opacity-40 ${
            mode === "combine"
              ? "bg-accent text-on-accent border-accent"
              : "text-ink-2 border-line-3 hover:border-accent hover:text-accent"
          }`}
        >
          <Layers size={12} /> Combine into one lot
        </button>
        <button
          onClick={p.onClear}
          className="text-[11.5px] text-muted hover:text-accent transition-colors px-1"
        >
          Clear
        </button>
      </div>

      {mode === "group" && (
        <div className="flex items-center gap-2 flex-wrap border-t border-line-2 pt-2">
          <span className="text-[11.5px] text-muted">
            Moves them into a branch. <b>Nothing is combined</b> — each keeps its own page.
          </span>
          <div className="flex-1" />
          {p.branches.map((b) => (
            <button
              key={b.id}
              onClick={() => p.onGroup(b.id)}
              disabled={p.busy === "group"}
              className="text-[11.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-2.5 h-8 rounded-lg transition-colors disabled:opacity-50"
            >
              {b.name}
            </button>
          ))}
          <input
            className={`${inp} w-[170px]`}
            placeholder="or a new branch…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) p.onNewBranchWith(newName);
            }}
          />
        </div>
      )}

      {mode === "combine" && (
        <div className="flex items-center gap-2 flex-wrap border-t border-line-2 pt-2">
          <span className="text-[11.5px] text-muted">
            Makes <b>one new lot</b>. The {p.picked.length} you picked stay exactly as they are.
          </span>
          <div className="flex-1" />
          <input
            className={`${inp} w-[190px]`}
            placeholder="Name the new lot"
            value={p.combineName}
            onChange={(e) => p.setCombineName(e.target.value)}
          />
          {!samePct && (
            <label className="text-[11px] text-muted flex items-center gap-1.5">
              Sell at %
              <NumberInput
                className={`${inp} w-16 text-right tabular-nums`}
                placeholder="30"
                value={p.combinePct}
                onValue={(_, raw) => p.setCombinePct(raw)}
              />
            </label>
          )}
          <button
            onClick={p.onCombine}
            disabled={p.busy === "combine"}
            className="text-[12px] bg-accent text-on-accent px-3 h-8 rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {p.busy === "combine" ? "…" : "Combine"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ level ------------ */

function LevelHeading(p: {
  level: { id: string | null; branch: LotBuild | null; title: string };
  members: LotBuild[];
  busy: string | null;
  onDownload: () => void;
  onPriceAll: () => void;
  onRemoveBranch?: () => void;
}) {
  const live = p.members.filter((b) => b.status === "saved");
  const units = live.reduce((t, b) => t + b.units, 0);
  const ask = live.reduce((t, b) => t + b.ask_total, 0);
  const cost = live.reduce((t, b) => t + b.msrp_total * b.cost_pct, 0);
  const b = p.level.branch;
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
      const c = await api.setBranchPricing(b.id, sell, cpct ? parseAmount(cpct) / 100 : undefined);
      toast(`${n(c)} lots repriced.`);
      p.onPriceAll();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setSaving(false);
  };

  return (
    <div className="flex items-end justify-between gap-3 flex-wrap pt-3 border-t border-line-2">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-ink truncate">{p.level.title}</p>
        <p className="text-[11.5px] text-muted tabular-nums mt-0.5">
          {n(live.length)} {live.length === 1 ? "lot" : "lots"} · {n(units)} units ·{" "}
          {fmtAmount(ask)}
          {cost > 0 && <> · you keep {fmtAmount(ask - cost)}</>}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {b && (
          <>
            <NumberInput
              className={`${inp} w-16 text-right tabular-nums`}
              placeholder={`${(b.price_pct * 100).toFixed(0)}%`}
              value={pct}
              onValue={(_, raw) => setPct(raw)}
            />
            <NumberInput
              className={`${inp} w-16 text-right tabular-nums`}
              placeholder={b.cost_pct > 0 ? `${(b.cost_pct * 100).toFixed(0)}%` : "cost"}
              value={cpct}
              onValue={(_, raw) => setCpct(raw)}
            />
            <Btn onClick={apply} busy={saving}>
              Price all
            </Btn>
          </>
        )}
        <button
          onClick={p.onDownload}
          disabled={p.busy === (p.level.id ?? "__top")}
          className="flex items-center gap-1.5 text-[12px] bg-accent text-on-accent px-3 h-8 rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          <Download size={12} /> Download spreadsheet
        </button>
        {p.onRemoveBranch && <Btn onClick={p.onRemoveBranch}>Delete branch</Btn>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ row -------------- */

function Row(p: {
  b: LotBuild;
  picked: boolean;
  struck: boolean;
  consumer: LotBuild | undefined;
  open: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const { b } = p;
  const merged = (b.merged_from || []).length > 0;
  const sold = b.status === "sold";
  return (
    <div
      className={`rounded-xl border bg-surface px-3.5 py-2.5 ${
        p.picked ? "border-accent" : "border-line"
      } ${b.status === "sent" ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={p.picked}
          onChange={p.onToggle}
          className="accent-accent shrink-0"
          aria-label={`Pick ${b.name}`}
        />
        <button
          onClick={p.onExpand}
          className="flex items-center gap-2 min-w-0 flex-1 text-left group"
          aria-expanded={p.open}
        >
          <span className="text-muted group-hover:text-accent transition-colors shrink-0">
            {p.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="min-w-0">
            <span
              className={`block text-[13.5px] font-semibold truncate group-hover:text-accent transition-colors ${
                p.struck ? "line-through text-danger-ink" : "text-ink"
              }`}
            >
              {b.name}
            </span>
            <span className="block text-[11.5px] text-muted tabular-nums mt-0.5">
              {n(b.units)} units · {n(b.styles)} styles · {fmtAmount(b.msrp_total)} retail ·{" "}
              <span className="text-accent font-medium">{fmtAmount(b.ask_total)}</span> at{" "}
              {(b.price_pct * 100).toFixed(1)}%
            </span>
          </span>
        </button>
        {merged && (
          <span className="text-[10.5px] text-muted shrink-0">
            combined from {b.merged_from.length}
          </span>
        )}
        {p.consumer && (
          <span className="text-[10.5px] text-muted shrink-0 truncate max-w-[150px]">
            also in {p.consumer.name}
          </span>
        )}
        <span
          className={`text-[10.5px] px-1.5 h-5 rounded-md flex items-center shrink-0 ${
            b.status === "sent"
              ? "bg-success-bg text-success-ink"
              : sold
                ? "bg-warning-bg text-warning-ink"
                : "bg-surface-3 text-muted"
          }`}
        >
          {b.status === "sent" ? "off the list" : sold ? "sold" : "in a lot"}
        </span>
      </div>
      {p.struck && (
        <p className="text-[10.5px] text-danger-ink mt-1 pl-6">
          cross this off your master spreadsheet
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ workbench -------- */

function Workbench(p: {
  b: LotBuild;
  detail: LotBuildDetail;
  lines: LotLines | undefined;
  format: "csv" | "xlsx";
  setFormat: (v: "csv" | "xlsx") => void;
  renaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  startRename: () => void;
  onRename: () => void;
  pctDraft: string;
  setPctDraft: (v: string) => void;
  costDraft: string;
  setCostDraft: (v: string) => void;
  onReprice: () => void;
  onExport: (kind: "manifest" | "brands" | "pull") => void;
  onWorkbook: () => void;
  onCopyCodes: () => void;
  onSold: () => void;
  onRemove: () => void;
  onPutBack: () => void;
  onArchive: () => void;
  onUngroup?: () => void;
  onClose: () => void;
  busy: string | null;
}) {
  const b = p.b;
  const sold = b.status === "sold";
  const sent = b.status === "sent";
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {p.renaming ? (
          <input
            autoFocus
            className={`${inp} w-[320px]`}
            value={p.draft}
            onChange={(e) => p.setDraft(e.target.value)}
            onBlur={p.onRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") p.onRename();
              if (e.key === "Escape") p.onClose();
            }}
          />
        ) : (
          <p className="text-[14px] font-semibold text-ink truncate">{b.name}</p>
        )}
        <div className="flex items-center gap-1.5">
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

      <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 border border-line-2 px-2.5 py-2">
        <label className="text-[10.5px] text-muted">
          Sell at, % of retail
          <NumberInput
            className={`${inp} w-20 text-right tabular-nums mt-0.5`}
            placeholder={(b.price_pct * 100).toFixed(1)}
            value={p.pctDraft}
            onValue={(_, raw) => p.setPctDraft(raw)}
          />
        </label>
        <label className="text-[10.5px] text-muted">
          Cost, %
          <NumberInput
            className={`${inp} w-20 text-right tabular-nums mt-0.5`}
            placeholder={b.cost_pct > 0 ? (b.cost_pct * 100).toFixed(1) : "none"}
            value={p.costDraft}
            onValue={(_, raw) => p.setCostDraft(raw)}
          />
        </label>
        <Btn onClick={p.onReprice} busy={p.busy === b.id}>
          Apply to all {n(b.units)} units
        </Btn>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Btn onClick={p.onWorkbook} busy={p.busy === b.id}>
          Workbook — 2 pages
        </Btn>
        <Btn onClick={() => p.onExport("manifest")} busy={p.busy === b.id}>
          Manifest
        </Btn>
        <Btn onClick={() => p.onExport("brands")} busy={p.busy === b.id}>
          Brand counts
        </Btn>
        <Btn onClick={() => p.onExport("pull")} busy={p.busy === b.id}>
          Pull sheet
        </Btn>
        <Btn onClick={p.onCopyCodes} busy={p.busy === b.id}>
          Copy codes
        </Btn>
        <Btn onClick={p.startRename}>Rename</Btn>
        {p.onUngroup && <Btn onClick={p.onUngroup}>Take out of branch</Btn>}
        <div className="flex-1" />
        <Btn onClick={p.onSold} busy={p.busy === b.id}>
          {sold ? "Not sold after all" : "Mark sold"}
        </Btn>
        <Btn onClick={sent ? p.onPutBack : p.onRemove}>
          {sent ? "Put back on the list" : "Remove from master list"}
        </Btn>
        <Btn onClick={p.onArchive}>Archive</Btn>
      </div>

      <Lines lines={p.lines} />
      <Breakdown detail={p.detail} />
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

/** What is actually in the lot — the same rows that go on its page in the workbook. */
function Lines({ lines }: { lines: LotLines | undefined }) {
  if (!lines) return <div className="h-24 rounded-lg bg-surface-2 animate-pulse" />;
  const qty = lines.headers.findIndex((h) => h.toLowerCase() === "qty");
  return (
    <div>
      <p className="text-[11px] font-medium text-ink-2 mb-1">
        What is in it — {n(lines.rows.length)} lines
      </p>
      <div className="rounded-lg border border-line-2 overflow-hidden">
        <div className="max-h-[300px] overflow-y-auto overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                {lines.headers.map((h, i) => (
                  <th
                    key={h}
                    className={`px-2 py-1.5 font-medium text-muted whitespace-nowrap ${
                      i >= qty ? "text-right" : "text-left"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.rows.map((r, i) => (
                <tr key={i} className="border-t border-line-2">
                  {r.map((c, j) => (
                    <td
                      key={j}
                      className={`px-2 py-1 text-ink-2 ${
                        j >= qty ? "text-right tabular-nums whitespace-nowrap" : ""
                      } ${j === 1 ? "max-w-[360px] truncate" : ""}`}
                      title={j === 1 ? c : undefined}
                    >
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Breakdown({ detail }: { detail: LotBuildDetail }) {
  const t = detail.totals;
  const risk = t.title_risk_units;
  const flagged = risk[2] + risk[3];
  const table = (title: string, gs: typeof t.by_brand) =>
    gs.length > 0 && (
      <div>
        <p className="text-[11px] font-medium text-ink-2 mb-1">{title}</p>
        <div className="space-y-0.5">
          {gs.slice(0, 8).map((g) => (
            <div key={g.name} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 truncate text-ink-2">{g.name}</span>
              <span className="tabular-nums text-muted w-16 text-right">{n(g.units)}</span>
              <span className="tabular-nums text-muted w-14 text-right">
                {(g.share * 100).toFixed(1)}%
              </span>
              <span className="tabular-nums text-ink-2 w-20 text-right">{fmtAmount(g.ask)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="grid sm:grid-cols-3 gap-4">
      {table("By brand", t.by_brand)}
      {table("By category", t.by_category)}
      {table("Who it is for", t.by_segment ?? [])}
      {flagged > 0 && (
        <p className="sm:col-span-3 text-[11px] text-warning-ink bg-warning-bg border border-warning rounded-md px-2 py-1.5 leading-snug">
          {n(flagged)} units carry a description we could not take from the sheet.
        </p>
      )}
    </div>
  );
}
