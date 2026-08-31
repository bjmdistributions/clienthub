import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  LotAllow,
  LotAutoResult,
  LotBuild,
  LotBuildDetail,
  LotFacets,
  LotGroupTotal,
  LotRankResult,
  LotRankedSlot,
  LotSheet,
  LotSheetReport,
  LotTotals,
  LotUpcConflict,
  LotWant,
} from "../lib/api";
import { fmtAmount, parseAmount } from "../lib/format";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "./Toast";
import NumberInput from "./NumberInput";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  Layers,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

/**
 * The lot engine. A warehouse manifest becomes priced, pickable lots.
 *
 * Two rules shape every control on this screen:
 *
 *  1. **A location is all or nothing.** The filters rank and qualify SLOTS; they never
 *     select items. That is why a card shows the whole slot — including the brands you did
 *     not ask for — before the click, and why "only footwear" means "only slots holding
 *     nothing but footwear" rather than "hide the apparel".
 *  2. **Two rows typed differently are two products.** Nothing here merges a title, which
 *     is why the Barcodes tab exists: it is the counterweight, and it owes the user a way
 *     to see what any barcode actually means.
 *
 * Every number on screen is computed in Rust by `src-tauri/src/lot_engine/`, which is shared
 * byte-for-byte with the server. This file adds nothing up on its own — including the lot's
 * running total, which goes to `previewLotTotals` precisely so the figure here is the figure
 * the buyer's manifest will carry.
 */

const SHEET_EXTS = ["xlsx", "xlsm", "xlsb", "xls", "ods", "csv", "tsv", "txt"];
const ACCEPTED = new RegExp(`\\.(${SHEET_EXTS.join("|")})$`, "i");

/** Matches LocationField's tested keystroke harness. */
const DEBOUNCE_MS = 140;
const CARD_LIMIT = 150;

const inp =
  "w-full bg-surface border border-line-2 rounded-lg px-2.5 h-8 text-[12.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

const n = (v: number) => Math.round(v).toLocaleString();

const emptyWant = (): LotWant => ({
  brands: [],
  size_min: null,
  size_max: null,
  msrp_min: null,
  msrp_max: null,
});
const emptyAllow = (): LotAllow => ({
  categories: [],
  segments: [],
  described_only: false,
  brand_lock: [],
});

type Tab = "sheets" | "build" | "auto" | "quality" | "barcodes" | "lots";

export default function LotEngineView() {
  const [sheets, setSheets] = useState<LotSheet[]>([]);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [facets, setFacets] = useState<LotFacets | null>(null);
  const [tab, setTab] = useState<Tab>("build");
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const sheet = sheets.find((s) => s.id === sheetId) ?? null;

  const loadSheets = useCallback(async (select?: string) => {
    try {
      const rows = await api.listLotSheets();
      setSheets(rows);
      setSheetId((cur) => select ?? cur ?? rows[0]?.id ?? null);
    } catch (e: any) {
      toast(String(e), "error");
    }
  }, []);

  useEffect(() => {
    loadSheets();
  }, [loadSheets]);

  const refreshFacets = useCallback(async () => {
    if (!sheetId) {
      setFacets(null);
      return;
    }
    try {
      setFacets(await api.lotSheetFacets(sheetId));
    } catch (e: any) {
      toast(String(e), "error");
    }
  }, [sheetId]);

  useEffect(() => {
    refreshFacets();
  }, [refreshFacets]);

  const importSheet = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        const r = await api.importLotSheet(path);
        await loadSheets(r.sheet.id);
        setTab("quality");
        const gap = r.quality.units_in - r.quality.units - r.quality.units_dropped;
        toast(
          gap === 0
            ? `${n(r.quality.stacks)} stacks across ${n(r.quality.locations)} locations. Everything reconciles.`
            : `Imported, but the units are off by ${n(gap)} — read the quality report before selling from it.`,
          gap === 0 ? undefined : "error",
        );
      } catch (e: any) {
        toast(String(e), "error");
      }
      setBusy(false);
    },
    [loadSheets],
  );

  const pick = async () => {
    const f = await openDialog({
      multiple: false,
      filters: [{ name: "Warehouse sheet", extensions: SHEET_EXTS }],
    });
    if (typeof f === "string") importSheet(f);
  };

  // Native drag-drop: the HTML5 drop event hands over a File with no path, and the reader
  // reads from a path.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDragActive(true);
        else if (p.type === "leave") setDragActive(false);
        else if (p.type === "drop") {
          setDragActive(false);
          const file = p.paths.find((x) => ACCEPTED.test(x));
          if (file) importSheet(file);
          else if (p.paths.length)
            toast("That file can't be read as a warehouse sheet — drop an Excel or CSV export.", "error");
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else un = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, [importSheet]);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold text-ink flex items-center gap-2">
            <Layers size={18} className="text-accent" /> Lot engine
          </h1>
          <p className="text-[13px] text-muted mt-1 max-w-[620px]">
            Build a lot by taking whole warehouse locations. Filters rank and qualify slots — they
            never pick items out of one, because a slot is all or nothing.
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {sheets.length > 1 && (
            <select
              value={sheetId ?? ""}
              onChange={(e) => setSheetId(e.target.value)}
              className="bg-surface border border-line-2 rounded-lg px-2.5 h-9 text-[12.5px] text-ink focus:outline-none focus:border-accent transition-colors max-w-[220px]"
            >
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={pick}
            disabled={busy}
            className="flex items-center gap-1.5 text-[12px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors disabled:opacity-50"
          >
            <Upload size={13} /> {busy ? "Reading…" : sheets.length ? "Import another" : "Import a sheet"}
          </button>
        </div>
      </div>

      {dragActive && (
        <div className="fixed inset-0 z-40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center">
            <p className="text-[15px] font-semibold text-ink">Drop to import this sheet</p>
            <p className="text-[12px] text-muted mt-1">It becomes a new sheet — nothing already here changes.</p>
          </div>
        </div>
      )}

      {!sheet && !busy && (
        <button
          onClick={pick}
          className="w-full max-w-[640px] rounded-2xl border border-dashed border-line-3 hover:border-accent hover:bg-surface-2 bg-surface transition-colors py-14 px-6 flex flex-col items-center text-center"
        >
          <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-4">
            <Upload size={20} className="text-accent" />
          </div>
          <p className="text-[15px] font-semibold text-ink">Drop a warehouse sheet here, or click to browse</p>
          <p className="text-[12.5px] text-muted mt-1 max-w-[420px]">
            Excel or CSV. Six columns matter — barcode, location, box, quantity, description and retail.
            Column order doesn't, and the header row can sit below junk rows.
          </p>
        </button>
      )}

      {sheet && (
        <>
          <PoolBar sheet={sheet} facets={facets} />
          <div className="flex items-center gap-1 border-b border-line mt-4 mb-4">
            {(
              [
                ["sheets", "Sheets"],
                ["build", "Build a lot"],
                ["auto", "Auto lots"],
                ["quality", "Quality"],
                ["barcodes", "Barcodes"],
                ["lots", "Saved lots"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`text-[12.5px] px-3 h-9 -mb-px border-b-2 transition-colors ${
                  tab === id
                    ? "border-accent text-ink font-medium"
                    : "border-transparent text-muted hover:text-ink-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "build" && facets && (
            // Keyed on the sheet so switching sheets starts a fresh build. Without it the
            // picked locations survived the change and were saved — and STAGED — against
            // the new sheet; codes repeat across exports of the same warehouse, so they
            // resolved silently rather than erroring. The phone resets on the same event.
            <Builder key={sheet.id} sheet={sheet} facets={facets} onChanged={refreshFacets} />
          )}
          {tab === "sheets" && (
            <SheetsTab
              sheets={sheets}
              activeId={sheet.id}
              onOpen={(id) => {
                setSheetId(id);
                setTab("build");
              }}
              onChanged={() => loadSheets(sheetId ?? undefined)}
              onImport={pick}
            />
          )}
          {tab === "auto" && facets && (
            <AutoLotsTab key={sheet.id} sheet={sheet} facets={facets} onChanged={refreshFacets} />
          )}
          {tab === "quality" && <QualityTab sheetId={sheet.id} />}
          {tab === "barcodes" && <BarcodesTab sheetId={sheet.id} />}
          {tab === "lots" && <SavedLotsTab sheetId={sheet.id} onChanged={refreshFacets} />}
        </>
      )}
    </div>
  );
}

/** What is left in the pool right now. Counts available stock only, so it drops as slots are
 *  staged into a lot and removed from the master list. */
function PoolBar({ sheet, facets }: { sheet: LotSheet; facets: LotFacets | null }) {
  const claimed = sheet.staged_slots + sheet.removed_slots;
  const cells = [
    { label: "Still on the master list", value: facets ? n(facets.pool_units) : "—", accent: true },
    { label: "Its retail", value: facets ? fmtAmount(facets.pool_msrp) : "—" },
    { label: "Slots left to sell", value: facets ? n(facets.pool_slots) : "—" },
    { label: "Claimed by a lot", value: n(sheet.staged_slots) },
    { label: "Shipped — gone for good", value: n(sheet.removed_slots) },
  ];
  return (
    <>
      {!sheet.has_stacks && (
        <p className="text-[11.5px] text-info-ink bg-info-bg border border-info rounded-lg px-3 py-2 mb-2.5 leading-snug">
          This sheet was imported on another device. Its rows are here — the stock itself is
          being fetched, and the numbers below fill in once it lands.
        </p>
      )}
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2.5">
      {cells.map((c) => (
        <div
          key={c.label}
          className={`rounded-lg px-3.5 py-2.5 min-w-0 ${
            c.accent ? "bg-accent/10 ring-1 ring-accent/30" : "bg-surface-2"
          }`}
        >
          <p className="text-[11.5px] font-medium text-muted truncate">{c.label}</p>
          <p className="text-[17px] font-bold text-ink tabular-nums mt-0.5 truncate">{c.value}</p>
        </div>
      ))}
    </div>
    {claimed > 0 && (
      <p className="text-[11.5px] text-muted mt-2 leading-snug">
        <span className="tabular-nums font-medium text-ink-2">{n(claimed)}</span> of this sheet's{" "}
        <span className="tabular-nums">{n(sheet.locations)}</span> locations are off the master
        list — {n(sheet.staged_slots)} claimed by a saved lot and {n(sheet.removed_slots)} shipped.
        They cannot appear in a search or in another lot, so no two lots can ever contain the same
        shoes.
      </p>
    )}
    </>
  );
}

// =========================================================================================
// Build a lot
// =========================================================================================

function Builder({
  sheet,
  facets,
  onChanged,
}: {
  sheet: LotSheet;
  facets: LotFacets;
  onChanged: () => void;
}) {
  const [want, setWant] = useState<LotWant>(emptyWant);
  const [allow, setAllow] = useState<LotAllow>(emptyAllow);
  const [slack, setSlack] = useState(0);
  const [sort, setSort] = useState<"concentration" | "volume">("concentration");
  const [minUnits, setMinUnits] = useState(0);
  const [minPct, setMinPct] = useState(0);
  const [result, setResult] = useState<LotRankResult | null>(null);
  const [ranking, setRanking] = useState(false);

  const [picked, setPicked] = useState<string[]>([]);
  const [lotName, setLotName] = useState("");
  const [pricePct, setPricePct] = useState(26);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [totals, setTotals] = useState<LotTotals | null>(null);
  const [saving, setSaving] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const seq = useRef(0);

  // Debounced re-rank with a stale-response guard: an earlier request that lands late must
  // never overwrite a later one's results.
  useEffect(() => {
    const mine = ++seq.current;
    setRanking(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.rankLotSlots(
          sheet.id,
          want,
          allow,
          {
            slack: slack / 100,
            sort,
            min_units: minUnits,
            min_pct: minPct / 100,
            limit: CARD_LIMIT,
          },
          picked,
        );
        if (seq.current === mine) setResult(r);
      } catch (e: any) {
        if (seq.current === mine) toast(String(e), "error");
      } finally {
        if (seq.current === mine) setRanking(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sheet.id, want, allow, slack, sort, minUnits, minPct, picked]);

  // The lot's own figures come from the engine, not from adding up card totals here — with
  // per-category percentages, a UI that did its own arithmetic would drift from the manifest.
  useEffect(() => {
    if (!picked.length) {
      setTotals(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const v = await api.previewLotTotals(
          sheet.id,
          picked,
          pricePct / 100,
          JSON.stringify(mapPct(overrides)),
        );
        if (live) setTotals(v);
      } catch (e: any) {
        if (live) toast(String(e), "error");
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sheet.id, picked, pricePct, overrides]);

  const reset = () => {
    setWant(emptyWant());
    setAllow(emptyAllow());
    setSlack(0);
    setMinUnits(0);
    setMinPct(0);
  };

  const activeFilters =
    want.brands.length +
    allow.categories.length +
    allow.segments.length +
    allow.brand_lock.length +
    (allow.described_only ? 1 : 0) +
    (want.size_min != null || want.size_max != null ? 1 : 0) +
    (want.msrp_min != null || want.msrp_max != null ? 1 : 0) +
    (minPct > 0 ? 1 : 0);

  const save = async () => {
    if (!picked.length) return;
    const name = lotName.trim() || `Lot ${new Date().toISOString().slice(0, 10)}`;
    setSaving(true);
    try {
      const b = await api.saveLotBuild({
        sheetId: sheet.id,
        name,
        slots: picked,
        pricePct: pricePct / 100,
        priceOverrides: JSON.stringify(mapPct(overrides)),
      });
      toast(`${b.name} saved. Its ${n(b.locations)} slots are out of the pool.`);
      setPicked([]);
      setLotName("");
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setSaving(false);
  };

  const lotPanel = (
    <LotPanel
      picked={picked}
      totals={totals}
      lotName={lotName}
      setLotName={setLotName}
      pricePct={pricePct}
      setPricePct={setPricePct}
      overrides={overrides}
      setOverrides={setOverrides}
      onRemove={(loc) => setPicked((p) => p.filter((x) => x !== loc))}
      onClear={() => setPicked([])}
      onSave={save}
      saving={saving}
    />
  );

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[264px_minmax(0,1fr)] 2xl:grid-cols-[264px_minmax(0,1fr)_336px] items-start">
        {/* Filters — a drawer below xl, a rail above it. */}
        <div className="xl:hidden">
          <button
            onClick={() => setFiltersOpen(true)}
            className="flex items-center gap-1.5 text-[12.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-3 h-9 rounded-lg transition-colors"
          >
            <Search size={13} /> Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}
          </button>
        </div>
        {/* Its own scroller. Sticky alone leaves the bottom of a rail taller than the
            viewport permanently below the fold — the only way to reach the sort controls
            was to scroll the whole page to the end of the results. */}
        <div className="hidden xl:block sticky top-2 max-h-[calc(100vh-1.5rem)] overflow-y-auto overscroll-contain pr-1">
          <Filters
            facets={facets}
            want={want}
            setWant={setWant}
            allow={allow}
            setAllow={setAllow}
            slack={slack}
            setSlack={setSlack}
            sort={sort}
            setSort={setSort}
            minUnits={minUnits}
            setMinUnits={setMinUnits}
            minPct={minPct}
            setMinPct={setMinPct}
            onReset={reset}
          />
        </div>

        <div className="min-w-0">
          <Results
            result={result}
            ranking={ranking}
            picked={picked}
            onAdd={(loc) => setPicked((p) => (p.includes(loc) ? p : [...p, loc]))}
            onAddAll={() =>
              setPicked((p) => {
                const next = new Set(p);
                (result?.slots ?? []).forEach((s) => next.add(s.location));
                return Array.from(next);
              })
            }
          />
        </div>

        <div className="hidden 2xl:block sticky top-2 max-h-[calc(100vh-1.5rem)] overflow-y-auto overscroll-contain pr-1">
          {lotPanel}
        </div>
      </div>

      {/* Below 2xl the lot lives in a bar pinned to the bottom, so the running total is
          never off screen while you are picking. */}
      {picked.length > 0 && (
        <div className="2xl:hidden sticky bottom-0 mt-4 -mx-1 px-1 pb-1 pt-2 bg-surface/95 backdrop-blur border-t border-line">
          {lotPanel}
        </div>
      )}

      {filtersOpen && (
        <div className="fixed inset-0 z-50 flex xl:hidden" role="dialog" aria-modal="true">
          <div className="flex-1 bg-ink/20" onClick={() => setFiltersOpen(false)} />
          <div className="w-[300px] max-w-[85vw] bg-surface border-l border-line h-full overflow-y-auto p-4 animate-slide-in-right">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[13px] font-semibold text-ink">Filters</p>
              <button onClick={() => setFiltersOpen(false)} className="text-muted hover:text-ink transition-colors">
                <X size={16} />
              </button>
            </div>
            <Filters
              facets={facets}
              want={want}
              setWant={setWant}
              allow={allow}
              setAllow={setAllow}
              slack={slack}
              setSlack={setSlack}
              sort={sort}
              setSort={setSort}
              minUnits={minUnits}
              setMinUnits={setMinUnits}
              minPct={minPct}
              setMinPct={setMinPct}
              onReset={reset}
            />
          </div>
        </div>
      )}
    </>
  );
}

function mapPct(o: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) if (v > 0) out[k] = v / 100;
  return out;
}

// =========================================================================================
// Filters
// =========================================================================================

function Chip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count?: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[11.5px] px-2 h-7 rounded-md border transition-colors flex items-center gap-1.5 ${
        on
          ? "bg-accent text-on-accent border-accent"
          : "bg-surface text-ink-2 border-line-2 hover:border-accent hover:text-accent"
      }`}
    >
      <span className="truncate max-w-[132px]">{label}</span>
      {count != null && (
        <span className={`tabular-nums ${on ? "opacity-80" : "text-muted"}`}>{n(count)}</span>
      )}
    </button>
  );
}

/** One side of an either/or. A radio in everything but the input type — the two options are
 *  mutually exclusive and both are always on screen, because the choice between them is the
 *  thing people get wrong. */
function ModeRow({
  on,
  onClick,
  title,
  hint,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`w-full text-left rounded-md border px-2 py-1.5 transition-colors ${
        on ? "border-accent bg-accent/10" : "border-line-2 bg-surface hover:border-line-3"
      }`}
    >
      <span className="flex items-start gap-1.5">
        <span
          className={`mt-[3px] w-2.5 h-2.5 rounded-full shrink-0 ${
            on ? "bg-accent ring-2 ring-accent/30" : "ring-1 ring-line-3"
          }`}
        />
        <span className="min-w-0">
          <span className={`block text-[11.5px] leading-snug ${on ? "text-ink font-medium" : "text-ink-2"}`}>
            {title}
          </span>
          <span className="block text-[10.5px] text-muted leading-snug mt-0.5">{hint}</span>
        </span>
      </span>
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-[12px] font-semibold text-ink">{title}</p>
      <p className="text-[11px] text-muted mt-0.5 mb-2 leading-snug">{hint}</p>
      {children}
    </div>
  );
}

function Filters(p: {
  facets: LotFacets;
  want: LotWant;
  setWant: (w: LotWant) => void;
  allow: LotAllow;
  setAllow: (a: LotAllow) => void;
  slack: number;
  setSlack: (v: number) => void;
  sort: "concentration" | "volume";
  setSort: (v: "concentration" | "volume") => void;
  minUnits: number;
  setMinUnits: (v: number) => void;
  minPct: number;
  setMinPct: (v: number) => void;
  onReset: () => void;
}) {
  const wantIsSet =
    p.want.brands.length > 0 ||
    p.want.size_min != null ||
    p.want.size_max != null ||
    p.want.msrp_min != null ||
    p.want.msrp_max != null;

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  // A cleared box means "no limit", not zero — so an empty string stays null.
  const num = (v: string): number | null => (/\d/.test(v) ? parseAmount(v) : null);

  return (
    <div className="bg-surface-2 rounded-xl p-3.5 border border-line">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12.5px] font-semibold text-ink">Filters</p>
        <button
          onClick={p.onReset}
          className="text-[11px] text-muted hover:text-accent transition-colors flex items-center gap-1"
        >
          <RotateCcw size={11} /> Reset
        </button>
      </div>

      <Section title="What you want" hint="Ranks the slots. Excludes nothing — a slot holding one unit of it still shows.">
        <div className="flex flex-wrap gap-1.5">
          {p.facets.brands.slice(0, 18).map((b) => (
            <Chip
              key={b.name}
              label={b.name}
              count={b.units}
              on={p.want.brands.includes(b.name)}
              onClick={() => p.setWant({ ...p.want, brands: toggle(p.want.brands, b.name) })}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2.5">
          <label className="text-[11px] text-muted">
            Size from
            <NumberInput
              className={inp}
              placeholder={p.facets.size_min?.toString() ?? "any"}
              value={p.want.size_min ?? ""}
              onValue={(_, raw) => p.setWant({ ...p.want, size_min: num(raw) })}
            />
          </label>
          <label className="text-[11px] text-muted">
            to
            <NumberInput
              className={inp}
              placeholder={p.facets.size_max?.toString() ?? "any"}
              value={p.want.size_max ?? ""}
              onValue={(_, raw) => p.setWant({ ...p.want, size_max: num(raw) })}
            />
          </label>
          <label className="text-[11px] text-muted">
            Retail from
            <NumberInput
              className={inp}
              placeholder={Math.floor(p.facets.msrp_min).toString()}
              value={p.want.msrp_min ?? ""}
              onValue={(_, raw) => p.setWant({ ...p.want, msrp_min: num(raw) })}
            />
          </label>
          <label className="text-[11px] text-muted">
            to
            <NumberInput
              className={inp}
              placeholder={Math.ceil(p.facets.msrp_max).toString()}
              value={p.want.msrp_max ?? ""}
              onValue={(_, raw) => p.setWant({ ...p.want, msrp_max: num(raw) })}
            />
          </label>
        </div>
      </Section>

      {/* The floor on WANT. It gets its own section rather than living inside "What you
          want", because WANT itself still ranks without excluding — and because the whole
          point is that it is NOT the brand lock two sections down. */}
      <Section
        title="How concentrated a slot must be"
        hint="A floor under the percentage on each card. Slots below it are hidden — but everything else in the ones above still comes with them. This is not 'nothing but'."
      >
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={p.minPct}
            onChange={(e) => p.setMinPct(parseInt(e.target.value, 10))}
            className="flex-1 accent-accent"
            aria-label="Least of a slot that must be what you want"
          />
          <span className="text-[12px] text-ink tabular-nums w-10 text-right">
            {p.minPct > 0 ? `${p.minPct}%` : "off"}
          </span>
        </div>
        {p.minPct > 0 && !wantIsSet && (
          <p className="text-[10.5px] text-muted mt-1.5 leading-snug">
            Nothing is wanted yet, so every slot counts as 100% and the floor changes nothing. Pick a
            brand, or a size or retail range, above.
          </p>
        )}
      </Section>

      <Section
        title="What a slot may contain"
        hint="Decides which slots qualify at all. Because the take is all or nothing, this is about the whole slot — not the lines in it."
      >
        <div className="flex flex-wrap gap-1.5">
          {p.facets.categories.map((c) => (
            <Chip
              key={c.name}
              label={c.name}
              count={c.units}
              on={p.allow.categories.includes(c.name)}
              onClick={() => p.setAllow({ ...p.allow, categories: toggle(p.allow.categories, c.name) })}
            />
          ))}
        </div>
        {p.facets.segments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {p.facets.segments.map((s) => (
              <Chip
                key={s.name}
                label={s.name}
                count={s.units}
                on={p.allow.segments.includes(s.name)}
                onClick={() => p.setAllow({ ...p.allow, segments: toggle(p.allow.segments, s.name) })}
              />
            ))}
          </div>
        )}
        <label className="flex items-start gap-2 mt-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={p.allow.described_only}
            onChange={(e) => p.setAllow({ ...p.allow, described_only: e.target.checked })}
            className="mt-0.5 accent-accent"
          />
          <span className="text-[11.5px] text-ink-2 leading-snug">
            Only slots where every line was described in the source sheet
          </span>
        </label>
        {/* The one distinction people get wrong, so it is a visible either/or rather than a
            checkbox: ranking by brand still takes the WHOLE location, and only this says
            otherwise. */}
        {p.want.brands.length > 0 && (
          <div className="mt-2.5 rounded-lg border border-line-2 bg-surface p-2">
            <p className="text-[11px] font-medium text-ink-2 mb-1.5">
              And what comes with {p.want.brands.join(", ")}?
            </p>
            <div className="space-y-1">
              <ModeRow
                on={p.allow.brand_lock.length === 0}
                onClick={() => p.setAllow({ ...p.allow, brand_lock: [] })}
                title="Everything else in the location comes too"
                hint="The normal way. You are buying shelves, not shoes — the other brands ride along, and each card shows exactly what they are."
              />
              <ModeRow
                on={p.allow.brand_lock.length > 0}
                onClick={() => p.setAllow({ ...p.allow, brand_lock: [...p.want.brands] })}
                title="Only locations holding nothing else"
                hint="Cherry-picked. Discards a slot that is 95% what you want plus 5% of something else, so it finds far fewer."
              />
            </div>
          </div>
        )}
      </Section>

      <Section
        title="How much you'll tolerate"
        hint="The share of a slot allowed to break the rules above. Zero is strict."
      >
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={100}
            value={p.slack}
            onChange={(e) => p.setSlack(parseInt(e.target.value, 10))}
            className="flex-1 accent-accent"
          />
          <span className="text-[12px] text-ink tabular-nums w-10 text-right">{p.slack}%</span>
        </div>
      </Section>

      <Section title="Order" hint="Concentration puts the purest slots first; volume puts the biggest first.">
        <div className="flex gap-1 bg-surface rounded-lg p-1 border border-line-2">
          {(
            [
              ["concentration", "Concentration"],
              ["volume", "Volume"],
            ] as ["concentration" | "volume", string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => p.setSort(id)}
              className={`flex-1 text-[11.5px] h-7 rounded-md transition-colors ${
                p.sort === id ? "bg-accent text-on-accent" : "text-ink-2 hover:text-accent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="text-[11px] text-muted block mt-2">
          Skip slots smaller than
          <NumberInput
            integer
            className={inp}
            placeholder="0"
            value={p.minUnits || ""}
            onValue={(n) => p.setMinUnits(n)}
          />
        </label>
      </Section>
    </div>
  );
}

// =========================================================================================
// Results
// =========================================================================================

function Results({
  result,
  ranking,
  picked,
  onAdd,
  onAddAll,
}: {
  result: LotRankResult | null;
  ranking: boolean;
  picked: string[];
  onAdd: (loc: string) => void;
  onAddAll: () => void;
}) {
  if (!result) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[104px] rounded-xl bg-surface-2 animate-pulse" />
        ))}
      </div>
    );
  }

  if (result.matched_slots === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-3 bg-surface px-6 py-10 text-center">
        <p className="text-[14px] font-semibold text-ink">No slot qualifies</p>
        <p className="text-[12.5px] text-muted mt-1.5 max-w-[440px] mx-auto leading-relaxed">
          {result.rejected_by_pct > 0
            ? `${n(result.rejected_by_pct)} slots hold what you want, but none of them reach the concentration floor. Lower it to see them.`
            : result.rejected_by_allow > 0
              ? `${n(result.rejected_by_allow)} slots hold what you want but also hold something the filters don't allow. Raise the tolerance to take them anyway.`
              : result.rejected_by_want > 0
                ? `${n(result.rejected_by_want)} slots qualify but hold none of what you asked for.`
                : "Nothing is left in the pool for these filters."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink-2">
            <span className="font-semibold text-ink tabular-nums">{n(result.matched_slots)}</span> slots ·{" "}
            <span className="tabular-nums">{n(result.matched_units)}</span> units ·{" "}
            <span className="tabular-nums">{fmtAmount(result.matched_msrp)}</span> retail ·{" "}
            <span className="tabular-nums font-medium text-accent">{n(result.matched_want_units)}</span> you want
          </p>
          {result.matched_want_units > 0 && result.tagalong_ratio > 0 && (
            <p className="text-[11.5px] text-muted mt-1">
              Taking all of them brings about{" "}
              <span className="tabular-nums">{result.tagalong_ratio.toFixed(1)}</span> units of something else
              for every unit you wanted.
            </p>
          )}
          {result.rejected_by_pct > 0 && (
            <p className="text-[11.5px] text-muted mt-1">
              <span className="tabular-nums">{n(result.rejected_by_pct)}</span> more hold what you want but
              sit below the concentration floor.
            </p>
          )}
        </div>
        <button
          onClick={onAddAll}
          className="shrink-0 flex items-center gap-1.5 text-[11.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-2.5 h-8 rounded-lg transition-colors"
        >
          <Plus size={12} /> Add all shown
        </button>
      </div>

      {result.sort_note && <p className="text-[11px] text-muted mb-3">{result.sort_note}</p>}

      <div className={`space-y-2 transition-opacity ${ranking ? "opacity-60" : ""}`}>
        {result.slots.map((s) => (
          <SlotCard key={s.location} slot={s} picked={picked.includes(s.location)} onAdd={() => onAdd(s.location)} />
        ))}
      </div>

      {result.matched_slots > result.slots.length && (
        <p className="text-[11.5px] text-muted mt-3">
          Showing the top {n(result.slots.length)} of {n(result.matched_slots)}. The ranking ran over all of
          them — narrow the filters to see further down.
        </p>
      )}
    </div>
  );
}

/**
 * One slot. Because the take is all or nothing, the whole slot has to be visible BEFORE the
 * click — which is what the "comes with" line is for. It is the single most important
 * element on this screen.
 */
function SlotCard({ slot, picked, onAdd }: { slot: LotRankedSlot; picked: boolean; onAdd: () => void }) {
  const top = slot.brands[0]?.units ?? 1;
  return (
    <div className="rounded-xl border border-line bg-surface px-3.5 py-3 hover:border-line-3 transition-colors">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13.5px] font-semibold text-ink tabular-nums truncate">{slot.location}</p>
        <p className="text-[12px] text-accent font-medium tabular-nums shrink-0">
          {Math.round(slot.pct * 100)}% of it
        </p>
      </div>
      <p className="text-[11.5px] text-muted mt-0.5 tabular-nums">
        {n(slot.total)} units · {n(slot.styles)} styles · {fmtAmount(slot.msrp)} retail ·{" "}
        <span className="text-ink-2 font-medium">{n(slot.want)} you want</span>
      </p>

      <div className="mt-2 space-y-1">
        {slot.brands.slice(0, 4).map((b) => (
          <div key={b.name} className="flex items-center gap-2">
            <span className="text-[11px] text-ink-2 w-[104px] truncate shrink-0">{b.name}</span>
            <span className="flex-1 h-[6px] rounded-full bg-surface-3 ring-1 ring-line overflow-hidden">
              <span
                className="block h-full bg-accent"
                style={{ width: `${Math.max(3, (b.units / top) * 100)}%` }}
              />
            </span>
            <span className="text-[11px] text-muted tabular-nums w-9 text-right shrink-0">{n(b.units)}</span>
          </div>
        ))}
        {slot.brands.length > 4 && (
          <p className="text-[10.5px] text-muted">and {slot.brands.length - 4} more</p>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 mt-2.5">
        <p className="text-[11.5px] text-ink-2 min-w-0">
          {slot.comes_with.length > 0 ? (
            <>
              Comes with {n(slot.total - slot.want)} other units:{" "}
              <span className="text-muted">
                {slot.comes_with.slice(0, 3).map((c) => `${c.name} ${n(c.units)}`).join(", ")}
                {slot.comes_with.length > 3 ? `, and ${slot.comes_with.length - 3} more` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted">Nothing in it you didn't ask for.</span>
          )}
          {slot.unverified_units > 0 && (
            <span className="block text-warning-ink mt-1 flex items-center gap-1">
              <AlertTriangle size={11} /> {n(slot.unverified_units)} units need their description checked
            </span>
          )}
        </p>
        <button
          onClick={onAdd}
          disabled={picked}
          className={`shrink-0 flex items-center gap-1.5 text-[11.5px] px-2.5 h-8 rounded-lg transition-colors ${
            picked
              ? "bg-success-bg text-success-ink cursor-default"
              : "bg-accent text-on-accent hover:bg-accent-hover"
          }`}
        >
          {picked ? (
            <>
              <Check size={12} /> In the lot
            </>
          ) : (
            <>
              Add whole location <ArrowRight size={12} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// =========================================================================================
// The lot being built
// =========================================================================================

function LotPanel(p: {
  picked: string[];
  totals: LotTotals | null;
  lotName: string;
  setLotName: (v: string) => void;
  pricePct: number;
  setPricePct: (v: number) => void;
  overrides: Record<string, number>;
  setOverrides: (v: Record<string, number>) => void;
  onRemove: (loc: string) => void;
  onClear: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const [showSlots, setShowSlots] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const t = p.totals;

  if (!p.picked.length) {
    return (
      <div className="rounded-xl border border-dashed border-line-3 bg-surface px-4 py-6 text-center">
        <p className="text-[12.5px] font-medium text-ink">No lot yet</p>
        <p className="text-[11.5px] text-muted mt-1 leading-snug">
          Add a location and it leaves the pool straight away, so nothing can end up in two lots.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3.5">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <p className="text-[12.5px] font-semibold text-ink">The lot</p>
        <button onClick={p.onClear} className="text-[11px] text-muted hover:text-danger transition-colors">
          Clear
        </button>
      </div>

      <input
        className={inp}
        placeholder="Name this lot"
        value={p.lotName}
        onChange={(e) => p.setLotName(e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2 mt-2.5">
        <Stat label="Slots" value={n(p.picked.length)} />
        <Stat label="Units" value={t ? n(t.units) : "…"} />
        <Stat label="Retail" value={t ? fmtAmount(t.msrp) : "…"} />
        <Stat label="Price" value={t ? fmtAmount(t.ask) : "…"} accent />
      </div>

      {t && (
        <p className="text-[11.5px] text-muted mt-2 tabular-nums">
          {fmtAmount(t.per_unit)} a unit · {(t.effective_pct * 100).toFixed(1)}% of retail · {n(t.styles)} styles
        </p>
      )}

      <button
        onClick={() => setShowPricing((v) => !v)}
        className="text-[11.5px] text-ink-2 hover:text-accent transition-colors mt-2.5"
      >
        {showPricing ? "Hide pricing" : "Pricing"}
      </button>
      {showPricing && (
        <div className="mt-2 rounded-lg bg-surface p-2.5 border border-line-2">
          <label className="text-[11px] text-muted block">
            Percent of retail
            <div className="flex items-center gap-2 mt-0.5">
              <NumberInput
                className={inp}
                value={p.pricePct}
                onValue={(n) => p.setPricePct(n)}
              />
            </div>
          </label>
          <p className="text-[10.5px] text-muted mt-1.5 leading-snug">
            Every line is priced at this share of its own retail, so a $75 shoe at 26% is $19.50.
          </p>
          {t && t.by_category.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              <p className="text-[11px] font-medium text-ink-2">Per category</p>
              {t.by_category.map((c) => (
                <div key={c.name} className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-2 flex-1 truncate">{c.name}</span>
                  <span className="text-[10.5px] text-muted tabular-nums w-14 text-right shrink-0">
                    {fmtAmount(c.per_unit)}/u
                  </span>
                  <NumberInput
                    placeholder={p.pricePct.toString()}
                    value={p.overrides[c.name] ?? ""}
                    onValue={(v) => {
                      const next = { ...p.overrides };
                      if (v > 0) next[c.name] = v;
                      else delete next[c.name];
                      p.setOverrides(next);
                    }}
                    className="w-14 bg-surface border border-line-2 rounded-md px-1.5 h-7 text-[11px] text-ink text-right tabular-nums focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {t && t.by_brand.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-ink-2 mb-1.5">Brand mix</p>
          <div className="space-y-1">
            {t.by_brand.slice(0, 6).map((b) => (
              <div key={b.name} className="flex items-center gap-2">
                <span className="text-[11px] text-ink-2 flex-1 truncate">{b.name}</span>
                <span className="text-[11px] text-muted tabular-nums shrink-0">
                  {n(b.units)} · {(b.share * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {t && t.title_risk_units[2] + t.title_risk_units[3] > 0 && (
        <p className="text-[11px] text-warning-ink bg-warning-bg border border-warning rounded-md px-2 py-1.5 mt-2.5 leading-snug">
          {n(t.title_risk_units[2] + t.title_risk_units[3])} units carry a description we could not take from
          the sheet. The manifest says so on those lines.
        </p>
      )}

      <button
        onClick={() => setShowSlots((v) => !v)}
        className="text-[11.5px] text-ink-2 hover:text-accent transition-colors mt-2.5"
      >
        {showSlots ? "Hide" : "Show"} {n(p.picked.length)} slots
      </button>
      {showSlots && (
        <div className="mt-1.5 max-h-[220px] overflow-y-auto space-y-0.5 pr-1">
          {p.picked.map((loc) => (
            <div key={loc} className="flex items-center justify-between gap-2 group">
              <span className="text-[11.5px] text-ink-2 tabular-nums truncate">{loc}</span>
              <button
                onClick={() => p.onRemove(loc)}
                className="text-muted hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
                aria-label={`Take ${loc} out of the lot`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Said before the click, not in a toast after it. Saving is what makes a lot
          un-overlappable, and that only works if it is obvious that the stock leaves. */}
      <p className="text-[11px] text-ink-2 bg-surface-3 rounded-md px-2 py-1.5 mt-3 leading-snug">
        Saving takes these <span className="tabular-nums font-medium">{n(p.picked.length)}</span>{" "}
        locations{t ? ` (${n(t.units)} units)` : ""} off the master list. They stop appearing in
        every search from then on, so nothing you build later can contain the same shoes.
      </p>

      <button
        onClick={p.onSave}
        disabled={p.saving}
        className="w-full mt-2 h-9 rounded-lg bg-accent text-on-accent text-[12.5px] font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
      >
        {p.saving ? "Saving…" : `Save lot — ${n(p.picked.length)} locations leave the list`}
      </button>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-surface rounded-lg px-2.5 py-2 border border-line-2 min-w-0">
      <p className="text-[10.5px] text-muted truncate">{label}</p>
      <p className={`text-[14px] font-semibold tabular-nums truncate ${accent ? "text-accent" : "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}

// =========================================================================================
// Quality
// =========================================================================================

function QualityTab({ sheetId }: { sheetId: string }) {
  const [r, setR] = useState<LotSheetReport | null>(null);

  useEffect(() => {
    api.lotSheetReport(sheetId).then(setR).catch((e) => toast(String(e), "error"));
  }, [sheetId]);

  if (!r) return <div className="h-40 rounded-xl bg-surface-2 animate-pulse" />;
  const q = r.quality;
  const gap = q ? q.units_in - q.units - q.units_dropped : 0;

  return (
    <div className="max-w-[880px]">
      <div
        className={`rounded-xl px-4 py-3 mb-4 border ${
          gap === 0 ? "bg-success-bg border-success" : "bg-danger-bg border-danger"
        }`}
      >
        <p className={`text-[13px] font-semibold ${gap === 0 ? "text-success-ink" : "text-danger-ink"}`}>
          {gap === 0 ? "Everything is accounted for" : `The units are off by ${n(gap)}`}
        </p>
        <p className={`text-[11.5px] mt-0.5 ${gap === 0 ? "text-success-ink" : "text-danger-ink"}`}>
          {gap === 0
            ? "Every unit in the sheet is either in a stack or in a reported drop below."
            : "The input, the stacks and the drops don't add up. Treat every total from this sheet as unproven."}
        </p>
      </div>

      {q && q.warnings.length > 0 && (
        <div className="rounded-xl bg-warning-bg border border-warning px-4 py-3 mb-4 space-y-1.5">
          {q.warnings.map((w, i) => (
            <p key={i} className="text-[11.5px] text-warning-ink leading-snug">
              {w}
            </p>
          ))}
        </div>
      )}

      <pre className="text-[11.5px] leading-relaxed text-ink-2 bg-surface-2 rounded-xl p-4 overflow-x-auto whitespace-pre">
        {r.report_text}
      </pre>

      <p className="text-[11px] text-muted mt-2.5">
        The full audit map of every location spelling and what it became is written next to the sheet as a
        CSV — it is how an unexpected merge gets traced, and what the warehouse needs to fix the spellings at
        source.
      </p>
    </div>
  );
}

// =========================================================================================
// Barcodes — the counterweight to never merging a title
// =========================================================================================

const GRADE_WORDS: Record<string, string> = {
  split: "Two brands in real quantity — hand this one back to the floor",
  stray: "One or two stray units against the rest — a typo, not an ambiguity",
  same_brand: "One brand under several names — kept as separate products, and the buyer gets the line they were shown",
  other: "Mixed brands, small numbers",
};

function BarcodesTab({ sheetId }: { sheetId: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LotUpcConflict[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const seq = useRef(0);

  // The screen shows the list; this is the copy that leaves the app. The genuinely split
  // barcodes cannot be resolved by software — they can only be handed back to the floor.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api.exportLotConflicts(sheetId);
      toast(`${n(r.rows)} rows written to ${r.path}`);
    } catch (e: any) {
      toast(String(e), "error");
    }
    setExporting(false);
  };

  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .lotSheetConflicts(sheetId, q)
        .then((v) => {
          if (seq.current === mine) setRows(v);
        })
        .catch((e) => toast(String(e), "error"));
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sheetId, q]);

  return (
    <div className="max-w-[880px]">
      <p className="text-[12.5px] text-muted mb-3 max-w-[620px] leading-relaxed">
        Nothing here merges a description, so a barcode can carry more than one product. This is where you
        see what any barcode actually means — and the export is the list the warehouse needs in order to
        fix the habit at source.
      </p>
      <div className="flex items-center gap-2 mb-3">
        <input
          className={`${inp} max-w-[320px]`}
          placeholder="Search a barcode, brand or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ActBtn onClick={exportCsv} busy={exporting} icon={<Download size={12} />}>
          {exporting ? "Writing…" : "Export CSV"}
        </ActBtn>
      </div>

      {!rows && <div className="h-32 rounded-xl bg-surface-2 animate-pulse" />}
      {rows && rows.length === 0 && (
        <p className="text-[12.5px] text-muted">No barcode in this sheet carries more than one product name.</p>
      )}

      <div className="space-y-1.5">
        {(rows ?? []).map((c) => (
          <div key={c.upc} className="rounded-xl border border-line bg-surface">
            <button
              onClick={() => setOpen(open === c.upc ? null : c.upc)}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left"
            >
              <span className="text-[12.5px] font-medium text-ink tabular-nums shrink-0">{c.upc}</span>
              <span className="text-[11px] text-muted flex-1 truncate">
                {c.names.length} names · {n(c.units)} units
              </span>
              <span
                className={`text-[10.5px] px-1.5 h-5 rounded-md flex items-center shrink-0 ${
                  c.grade === "split"
                    ? "bg-warning-bg text-warning-ink"
                    : "bg-surface-3 text-muted"
                }`}
              >
                {c.grade === "same_brand" ? "same brand" : c.grade}
              </span>
            </button>
            {open === c.upc && (
              <div className="px-3.5 pb-3 border-t border-line pt-2.5">
                <p className="text-[11px] text-muted mb-2">{GRADE_WORDS[c.grade] ?? ""}</p>
                {c.one_price && (
                  <p className="text-[11px] text-info-ink bg-info-bg border border-info rounded-md px-2 py-1.5 mb-2 leading-snug">
                    Every name on this barcode carries the same price — the signature of a barcode used as a
                    price tier rather than a product code. That is a floor habit, not a typo.
                  </p>
                )}
                <div className="space-y-1.5">
                  {c.names.map((nm) => (
                    <div key={nm.title} className="flex items-baseline gap-2">
                      <span className="text-[11.5px] text-ink-2 flex-1 min-w-0 truncate">{nm.title}</span>
                      <span className="text-[11px] text-muted tabular-nums shrink-0">
                        {nm.brand ? `${nm.brand} · ` : ""}
                        {n(nm.units)} units · {(nm.share * 100).toFixed(0)}% · {nm.locations} slots ·{" "}
                        {fmtAmount(nm.msrp)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// =========================================================================================
// Saved lots
// =========================================================================================

function SavedLotsTab({ sheetId, onChanged }: { sheetId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<LotBuild[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<LotBuild | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  // Cached per lot: the breakdown reads every stack in the lot, so re-opening a row it has
  // already read should cost nothing. Cleared whenever the list itself is reloaded.
  const [detail, setDetail] = useState<Record<string, LotBuildDetail>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const load = useCallback(() => {
    setDetail({});
    api.listLotBuilds(sheetId).then(setRows).catch((e) => toast(String(e), "error"));
  }, [sheetId]);

  useEffect(load, [load]);

  // Straight to a save dialog, so the file lands where it is wanted rather than in a
  // folder beside the sheet that the toast then has to name.
  const exportOne = async (b: LotBuild, kind: "manifest" | "brands" | "pull") => {
    const label = kind === "pull" ? "Pull sheet" : kind === "brands" ? "Brand counts" : "Manifest";
    const safe = b.name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = await saveDialog({
      defaultPath: `${safe}-${kind}.${format}`,
      filters: [
        format === "xlsx"
          ? { name: "Excel workbook", extensions: ["xlsx"] }
          : { name: "CSV", extensions: ["csv"] },
      ],
    });
    if (!dest) return; // cancelled — not an error, and not a silent write somewhere else
    setBusy(b.id);
    try {
      const r = await api.exportLotBuild(b.id, kind, { format, destPath: dest });
      toast(
        r.reconciled
          ? `${label} saved — ${n(r.rows)} rows, and the three exports agree on the unit total.`
          : `Saved, but the manifest, brand counts and pull sheet DISAGREE on the unit total. Don't send it.`,
        r.reconciled ? undefined : "error",
      );
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const expand = async (b: LotBuild) => {
    if (open === b.id) {
      setOpen(null);
      return;
    }
    setOpen(b.id);
    if (detail[b.id]) return;
    setLoadingDetail(b.id);
    try {
      const d = await api.lotBuildDetail(b.id);
      setDetail((x) => ({ ...x, [b.id]: d }));
    } catch (e: any) {
      toast(String(e), "error");
      setOpen(null);
    }
    setLoadingDetail(null);
  };

  const copyCodes = async (b: LotBuild) => {
    try {
      await navigator.clipboard.writeText(await api.lotBuildLocationCodes(b.id));
      toast(`${n(b.locations)} location codes copied.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  if (!rows) return <div className="h-32 rounded-xl bg-surface-2 animate-pulse" />;
  if (!rows.length)
    return (
      <p className="text-[12.5px] text-muted">
        No lots built from this sheet yet. Build one on the first tab and it appears here.
      </p>
    );

  return (
    <div className="max-w-[900px] space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12.5px] text-muted">
          {n(rows.length)} {rows.length === 1 ? "lot" : "lots"} built from this sheet. Each one's
          locations are already off the master list.
        </p>
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
                onClick={() => setFormat(id)}
                className={`text-[11.5px] px-2.5 h-6 rounded-md transition-colors ${
                  format === id ? "bg-accent text-on-accent" : "text-ink-2 hover:text-accent"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {rows.map((b) => (
        <div key={b.id} className="rounded-xl border border-line bg-surface px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            {/* The whole heading opens the breakdown — a saved lot's first question is
                always "how much of each brand", and until now that answer was only in an
                exported CSV. */}
            <button
              onClick={() => expand(b)}
              className="flex items-start gap-2 min-w-0 text-left group"
              aria-expanded={open === b.id}
            >
              <span className="text-muted group-hover:text-accent transition-colors mt-0.5 shrink-0">
                {open === b.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-semibold text-ink truncate group-hover:text-accent transition-colors">
                  {b.name}
                </span>
                <span className="block text-[11.5px] text-muted mt-0.5 tabular-nums">
                  {n(b.locations)} slots · {n(b.units)} units · {n(b.styles)} styles ·{" "}
                  {fmtAmount(b.msrp_total)} retail ·{" "}
                  <span className="text-accent font-medium">{fmtAmount(b.ask_total)}</span> at{" "}
                  {(b.price_pct * 100).toFixed(1)}%
                </span>
              </span>
            </button>
            <span
              className={`text-[10.5px] px-1.5 h-5 rounded-md flex items-center shrink-0 ${
                b.status === "sent" ? "bg-success-bg text-success-ink" : "bg-surface-3 text-muted"
              }`}
            >
              {b.status === "sent" ? "off the list" : "in a lot"}
            </span>
          </div>

          {open === b.id &&
            (detail[b.id] ? (
              <LotBreakdown detail={detail[b.id]} />
            ) : loadingDetail === b.id ? (
              <div className="h-28 rounded-lg bg-surface-2 animate-pulse mt-2.5" />
            ) : null)}

          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            <ActBtn onClick={() => exportOne(b, "manifest")} busy={busy === b.id} icon={<Download size={12} />}>
              Manifest
            </ActBtn>
            <ActBtn onClick={() => exportOne(b, "brands")} busy={busy === b.id} icon={<Download size={12} />}>
              Brand counts
            </ActBtn>
            <ActBtn onClick={() => exportOne(b, "pull")} busy={busy === b.id} icon={<Download size={12} />}>
              Pull sheet
            </ActBtn>
            <ActBtn onClick={() => copyCodes(b)} icon={<ClipboardCopy size={12} />}>
              Copy codes
            </ActBtn>
            <div className="flex-1" />
            <ActBtn
              onClick={() =>
                b.status === "sent"
                  ? api
                      .removeLotFromMasterList(b.id, false)
                      .then(() => {
                        load();
                        onChanged();
                        toast("Put back on the master list.");
                      })
                      .catch((e) => toast(String(e), "error"))
                  : setConfirmRemove(b)
              }
              icon={<Trash2 size={12} />}
            >
              {b.status === "sent" ? "Put back on the list" : "Remove from master list"}
            </ActBtn>
            <ActBtn
              onClick={() =>
                api
                  .archiveLotBuild(b.id, true)
                  .then(() => {
                    load();
                    onChanged();
                    toast("Lot archived. Its slots that were only staged are back in the pool.");
                  })
                  .catch((e) => toast(String(e), "error"))
              }
            >
              Archive
            </ActBtn>
          </div>
        </div>
      ))}

      {confirmRemove && (
        <div className="fixed inset-0 z-50 bg-ink/30 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-surface rounded-2xl border border-line max-w-[460px] w-full p-5 animate-fade-up">
            <p className="text-[15px] font-semibold text-ink">
              Take {confirmRemove.locations} slots off the master list?
            </p>
            <p className="text-[12.5px] text-muted mt-2 leading-relaxed">
              This says the stock has physically left. Those locations stay off every future search, and they
              stay off even when a refreshed export still lists them — absent means shipped, not undone.
              Nothing is deleted, and you can put them back from this screen.
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
                    await api.removeLotFromMasterList(b.id, true);
                    load();
                    onChanged();
                    toast(`${n(b.locations)} slots are off the master list.`);
                  } catch (e: any) {
                    toast(String(e), "error");
                  }
                }}
                className="text-[12.5px] bg-accent text-on-accent px-3 h-9 rounded-lg hover:bg-accent-hover transition-colors"
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

/**
 * A saved lot, opened up.
 *
 * Every figure comes from `lotBuildDetail`, which prices the lot through the same engine the
 * manifest does — so what is on screen is what the buyer's paperwork will say. Nothing here
 * is added up in TypeScript.
 *
 * The brand table is the spec's **Brand counts** artifact rendered in place: brand, units,
 * share of the lot, styles, how many slots hold it, retail and the price per unit. It is the
 * first question anyone asks about a lot, and until now the only way to answer it was to
 * export a CSV and open it somewhere else.
 */
function LotBreakdown({ detail }: { detail: LotBuildDetail }) {
  const t = detail.totals;
  const risk = t.title_risk_units;
  const codes = detail.location_codes.split("\n").filter(Boolean);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail.location_codes);
      toast(`${n(codes.length)} location codes copied.`);
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-line space-y-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Slots" value={n(t.locations)} />
        <Stat label="Units" value={n(t.units)} />
        <Stat label="Styles" value={n(t.styles)} />
        <Stat label="Retail" value={fmtAmount(t.msrp)} />
        <Stat label="Price" value={fmtAmount(t.ask)} accent />
        <Stat label="A unit" value={fmtAmount(t.per_unit)} />
      </div>
      <p className="text-[11px] text-muted -mt-1.5 tabular-nums">
        {(t.effective_pct * 100).toFixed(1)}% of retail across the whole lot · {n(t.stacks)} lines on the
        manifest
      </p>

      <GroupTable title="Brand counts" nameHeader="Brand" rows={t.by_brand} />
      <GroupTable title="Categories" nameHeader="Category" rows={t.by_category} />

      <div>
        <p className="text-[11.5px] font-medium text-ink-2 mb-1.5">Where the descriptions came from</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <RiskCell units={risk[0]} label="typed into the source sheet" />
          <RiskCell units={risk[1]} label="named from a clean barcode" />
          <RiskCell units={risk[2]} label="to verify — a barcode used for several products" warn />
          <RiskCell units={risk[3]} label="no description in the source sheet" warn />
        </div>
        <p className="text-[10.5px] text-muted mt-1.5 leading-snug">
          Only the last two can mis-describe the lot, and each carries that note on its own manifest line.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className="text-[11.5px] font-medium text-ink-2">
            Locations, in walk order
            <span className="text-muted font-normal"> · {n(codes.length)}</span>
          </p>
          <button
            onClick={copy}
            className="flex items-center gap-1 text-[11px] text-muted hover:text-accent transition-colors"
          >
            <ClipboardCopy size={11} /> Copy codes
          </button>
        </div>
        <div className="max-h-[128px] overflow-y-auto rounded-lg bg-surface-2 border border-line-2 px-2.5 py-2">
          <p className="text-[11px] text-ink-2 tabular-nums leading-relaxed break-all">{codes.join(" · ")}</p>
        </div>
      </div>
    </div>
  );
}

/** Brand counts and category totals share a shape, so they share a table. */
function GroupTable({
  title,
  nameHeader,
  rows,
}: {
  title: string;
  nameHeader: string;
  rows: LotGroupTotal[];
}) {
  if (!rows.length) return null;
  const top = rows[0].units || 1;
  return (
    <div>
      <p className="text-[11.5px] font-medium text-ink-2 mb-1">{title}</p>
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div className="grid grid-cols-[minmax(0,1fr)_54px_46px_46px_42px_74px_58px] gap-x-2 text-[10.5px] text-muted pb-1 border-b border-line">
            <span>{nameHeader}</span>
            <span className="text-right">Units</span>
            <span className="text-right">Share</span>
            <span className="text-right">Styles</span>
            <span className="text-right">Slots</span>
            <span className="text-right">Retail</span>
            <span className="text-right">A unit</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.name}
              className="grid grid-cols-[minmax(0,1fr)_54px_46px_46px_42px_74px_58px] gap-x-2 items-center text-[11px] py-1 border-b border-line/60 last:border-0"
            >
              <span className="min-w-0">
                <span className="block truncate text-ink-2">{r.name}</span>
                <span className="block h-[3px] rounded-full bg-surface-3 ring-1 ring-line overflow-hidden mt-0.5">
                  <span
                    className="block h-full bg-accent"
                    style={{ width: `${Math.max(2, (r.units / top) * 100)}%` }}
                  />
                </span>
              </span>
              <span className="text-right tabular-nums text-ink">{n(r.units)}</span>
              <span className="text-right tabular-nums text-muted">{(r.share * 100).toFixed(1)}%</span>
              <span className="text-right tabular-nums text-muted">{n(r.styles)}</span>
              <span className="text-right tabular-nums text-muted">{n(r.locations)}</span>
              <span className="text-right tabular-nums text-muted">{fmtAmount(r.msrp)}</span>
              <span className="text-right tabular-nums text-accent">{fmtAmount(r.per_unit)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RiskCell({ units, label, warn }: { units: number; label: string; warn?: boolean }) {
  const live = units > 0;
  return (
    <div
      className={`rounded-lg px-2.5 py-2 border min-w-0 ${
        warn && live ? "bg-warning-bg border-warning" : "bg-surface border-line-2"
      }`}
    >
      <p
        className={`text-[14px] font-semibold tabular-nums ${
          warn && live ? "text-warning-ink" : "text-ink"
        }`}
      >
        {n(units)}
      </p>
      <p className={`text-[10.5px] leading-snug mt-0.5 ${warn && live ? "text-warning-ink" : "text-muted"}`}>
        {label}
      </p>
    </div>
  );
}

// =========================================================================================
// Sheets — the master menu
// =========================================================================================

/**
 * Every warehouse sheet this device holds, so several can be worked on over days rather
 * than one at a time. `renameLotSheet`, `archiveLotSheet` and the `includeArchived` flag
 * all existed from the start and nothing called them: a mis-named sheet was permanent and
 * a finished one could never be put away.
 */
function SheetsTab({
  sheets,
  activeId,
  onOpen,
  onChanged,
  onImport,
}: {
  sheets: LotSheet[];
  activeId: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onImport: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<LotSheet[] | null>(null);

  useEffect(() => {
    if (!showArchived) return;
    api
      .listLotSheets(true)
      .then((all) => setArchived(all.filter((s) => s.archived)))
      .catch((e) => toast(String(e), "error"));
  }, [showArchived, sheets]);

  const rename = async (s: LotSheet) => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name === s.name) return;
    try {
      await api.renameLotSheet(s.id, name);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const setArchivedFlag = async (s: LotSheet, v: boolean) => {
    setBusy(s.id);
    try {
      await api.archiveLotSheet(s.id, v);
      toast(v ? `${s.name} put away. Nothing in it is deleted.` : `${s.name} is back.`);
      setArchived(null);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const card = (s: LotSheet, isArchived: boolean) => {
    const claimed = s.staged_slots + s.removed_slots;
    const left = Math.max(0, s.locations - claimed);
    const pctWorked = s.locations > 0 ? claimed / s.locations : 0;
    return (
      <div
        key={s.id}
        className={`rounded-xl border bg-surface px-3.5 py-3 ${
          s.id === activeId && !isArchived ? "border-accent" : "border-line"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {renaming === s.id ? (
              <input
                autoFocus
                className={`${inp} max-w-[320px]`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => rename(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(s);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <p className="text-[13.5px] font-semibold text-ink truncate">
                {s.name}
                {s.id === activeId && !isArchived && (
                  <span className="ml-2 text-[10.5px] font-normal text-accent">open now</span>
                )}
              </p>
            )}
            <p className="text-[11.5px] text-muted mt-0.5 tabular-nums">
              {n(s.locations)} locations · {n(s.units)} units · {n(s.products)} products ·{" "}
              {fmtAmount(s.msrp_total)} retail
              {s.source_filename ? ` · ${s.source_filename}` : ""}
            </p>
          </div>
          {!s.has_stacks && (
            <span className="text-[10.5px] px-1.5 h-5 rounded-md flex items-center shrink-0 bg-info-bg text-info-ink">
              still arriving
            </span>
          )}
        </div>

        {/* How far through the sheet you are — the thing you need when picking up a sheet
            you last touched three days ago. */}
        <div className="mt-2.5">
          <div className="flex items-center justify-between text-[11px] text-muted mb-1">
            <span>
              <span className="tabular-nums font-medium text-ink-2">{n(left)}</span> locations still
              on the master list
            </span>
            <span className="tabular-nums">
              {n(s.staged_slots)} in lots · {n(s.removed_slots)} shipped
            </span>
          </div>
          <span className="block h-[5px] rounded-full bg-surface-3 ring-1 ring-line overflow-hidden">
            <span className="block h-full bg-accent" style={{ width: `${Math.round(pctWorked * 100)}%` }} />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {!isArchived && (
            <ActBtn onClick={() => onOpen(s.id)} icon={<ArrowRight size={12} />}>
              {s.id === activeId ? "Go to it" : "Open this sheet"}
            </ActBtn>
          )}
          <ActBtn
            onClick={() => {
              setDraft(s.name);
              setRenaming(s.id);
            }}
          >
            Rename
          </ActBtn>
          <div className="flex-1" />
          <ActBtn onClick={() => setArchivedFlag(s, !isArchived)} busy={busy === s.id}>
            {isArchived ? "Put back" : "Put away"}
          </ActBtn>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-[900px]">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <p className="text-[12.5px] text-muted max-w-[560px] leading-relaxed">
          Every sheet you have imported. Each keeps its own master list, so you can work a load
          today, put it away, and pick it up where you left it. Nothing is ever deleted.
        </p>
        <ActBtn onClick={onImport} icon={<Upload size={12} />}>
          Import a sheet
        </ActBtn>
      </div>

      <div className="space-y-2">{sheets.map((s) => card(s, false))}</div>

      <button
        onClick={() => setShowArchived((v) => !v)}
        className="text-[11.5px] text-ink-2 hover:text-accent transition-colors mt-3"
      >
        {showArchived ? "Hide" : "Show"} sheets you have put away
      </button>
      {showArchived && (
        <div className="space-y-2 mt-2">
          {!archived && <div className="h-16 rounded-xl bg-surface-2 animate-pulse" />}
          {archived && archived.length === 0 && (
            <p className="text-[12px] text-muted">Nothing has been put away yet.</p>
          )}
          {(archived ?? []).map((s) => card(s, true))}
        </div>
      )}
    </div>
  );
}

// =========================================================================================
// Auto lots — cut the pool into several at once
// =========================================================================================

/**
 * *"Nike and adidas, footwear, about a thousand units a lot, as many as you can."*
 *
 * The plan comes from `plan_lot_builds`, which is the same ranking the Build tab uses read
 * greedily — so lot 1 gets the purest slots and no location can land in two lots. Nothing is
 * written until Save: each planned lot then goes through the ordinary save, so it is staged
 * and checked exactly like one built by hand.
 */
function AutoLotsTab({
  sheet,
  facets,
  onChanged,
}: {
  sheet: LotSheet;
  facets: LotFacets;
  onChanged: () => void;
}) {
  const [want, setWant] = useState<LotWant>(emptyWant);
  const [allow, setAllow] = useState<LotAllow>(emptyAllow);
  const [target, setTarget] = useState(1000);
  const [maxLots, setMaxLots] = useState(0);
  const [minPct, setMinPct] = useState(0);
  const [pricePct, setPricePct] = useState(26);
  const [result, setResult] = useState<LotAutoResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  useEffect(() => {
    const mine = ++seq.current;
    setPlanning(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.planLotBuilds(
          sheet.id,
          want,
          allow,
          { slack: 0, sort: "concentration", min_units: 0, min_pct: minPct / 100, limit: 0 },
          { target_units: Math.max(1, target), max_lots: Math.max(0, maxLots), min_lot_units: 0 },
        );
        if (seq.current === mine) setResult(r);
      } catch (e: any) {
        if (seq.current === mine) toast(String(e), "error");
      } finally {
        if (seq.current === mine) setPlanning(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [sheet.id, want, allow, target, maxLots, minPct]);

  const saveAll = async () => {
    if (!result?.lots.length) return;
    setSaving(true);
    const stamp = new Date().toISOString().slice(0, 10);
    let made = 0;
    try {
      // One at a time, through the ordinary save. Sequential on purpose: each save stages
      // its own slots, and the next lot must see that before it writes.
      for (const l of result.lots) {
        await api.saveLotBuild({
          sheetId: sheet.id,
          name: `${stamp} lot ${l.index}`,
          slots: l.locations,
          pricePct: pricePct / 100,
          priceOverrides: undefined,
        });
        made += 1;
      }
      toast(`${n(made)} lots saved. Their locations are off the master list.`);
      setResult(null);
      onChanged();
    } catch (e: any) {
      toast(
        made > 0
          ? `Saved ${n(made)} of ${n(result.lots.length)}, then stopped: ${String(e)}`
          : String(e),
        "error",
      );
      onChanged();
    }
    setSaving(false);
  };

  return (
    <div className="max-w-[980px]">
      <p className="text-[12.5px] text-muted mb-3 max-w-[620px] leading-relaxed">
        Pick what you want and how big a lot should be, and this cuts the master list into as
        many as it can — best slots first. Nothing is saved until you say so.
      </p>

      <div className="rounded-xl border border-line bg-surface-2 p-3.5 mb-4">
        <p className="text-[12px] font-semibold text-ink mb-2">Brands you want</p>
        <div className="flex flex-wrap gap-1.5">
          {facets.brands.slice(0, 18).map((b) => (
            <Chip
              key={b.name}
              label={b.name}
              count={b.units}
              on={want.brands.includes(b.name)}
              onClick={() => setWant({ ...want, brands: toggle(want.brands, b.name) })}
            />
          ))}
        </div>

        <p className="text-[12px] font-semibold text-ink mt-3 mb-2">Categories a location may hold</p>
        <div className="flex flex-wrap gap-1.5">
          {facets.categories.map((c) => (
            <Chip
              key={c.name}
              label={c.name}
              count={c.units}
              on={allow.categories.includes(c.name)}
              onClick={() => setAllow({ ...allow, categories: toggle(allow.categories, c.name) })}
            />
          ))}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mt-3">
          <label className="text-[11px] text-muted">
            Units per lot, roughly
            <NumberInput integer className={inp} value={target} onValue={(v) => setTarget(v)} />
          </label>
          <label className="text-[11px] text-muted">
            How many lots (0 = as many as fit)
            <NumberInput integer className={inp} value={maxLots} onValue={(v) => setMaxLots(v)} />
          </label>
          <label className="text-[11px] text-muted">
            Least of a lot that is your brands
            <div className="flex items-center gap-2 mt-0.5">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={minPct}
                onChange={(e) => setMinPct(parseInt(e.target.value, 10))}
                className="flex-1 accent-accent"
              />
              <span className="text-[12px] text-ink tabular-nums w-9 text-right">
                {minPct > 0 ? `${minPct}%` : "off"}
              </span>
            </div>
          </label>
          <label className="text-[11px] text-muted">
            Percent of retail
            <NumberInput className={inp} value={pricePct} onValue={(v) => setPricePct(v)} />
          </label>
        </div>
        <p className="text-[10.5px] text-muted mt-2 leading-snug">
          A location is never split, so each lot lands a little over the target rather than
          exactly on it. Everything else in a location still comes with it.
        </p>
      </div>

      {!result && planning && <div className="h-24 rounded-xl bg-surface-2 animate-pulse" />}

      {result && (
        <div className={`transition-opacity ${planning ? "opacity-60" : ""}`}>
          <div className="flex items-start justify-between gap-3 mb-2.5 flex-wrap">
            <div className="min-w-0">
              <p className="text-[12.5px] text-ink-2">
                <span className="font-semibold text-ink tabular-nums">{n(result.lots.length)}</span>{" "}
                lots · <span className="tabular-nums">{n(result.total_units)}</span> units ·{" "}
                <span className="tabular-nums">{fmtAmount(result.total_msrp)}</span> retail ·{" "}
                <span className="tabular-nums font-medium text-accent">
                  {n(result.total_want_units)}
                </span>{" "}
                you want
              </p>
              <p className="text-[11px] text-muted mt-1 max-w-[620px] leading-snug">{result.note}</p>
            </div>
            {result.lots.length > 0 && (
              <button
                onClick={saveAll}
                disabled={saving}
                className="shrink-0 h-9 px-3 rounded-lg bg-accent text-on-accent text-[12.5px] font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                {saving
                  ? "Saving…"
                  : `Save all ${n(result.lots.length)} — ${n(result.lots.reduce((a, l) => a + l.locations.length, 0))} locations leave the list`}
              </button>
            )}
          </div>

          <div className="space-y-2">
            {result.lots.map((l) => (
              <div key={l.index} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[13.5px] font-semibold text-ink">Lot {l.index}</p>
                  <p className="text-[12px] text-accent font-medium tabular-nums shrink-0">
                    {Math.round(l.pct * 100)}% what you want
                  </p>
                </div>
                <p className="text-[11.5px] text-muted mt-0.5 tabular-nums">
                  {n(l.units)} units · {n(l.locations.length)} locations · {fmtAmount(l.msrp)} retail ·{" "}
                  <span className="text-ink-2 font-medium">{n(l.want_units)} you want</span>
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
                  {l.brands.slice(0, 6).map((b) => (
                    <span key={b.name} className="text-[11px] text-muted tabular-nums">
                      {b.name} <span className="text-ink-2">{n(b.units)}</span>
                    </span>
                  ))}
                  {l.brands.length > 6 && (
                    <span className="text-[11px] text-muted">and {l.brands.length - 6} more</span>
                  )}
                </div>
                {l.unverified_units > 0 && (
                  <p className="text-[11px] text-warning-ink mt-1.5 flex items-center gap-1">
                    <AlertTriangle size={11} /> {n(l.unverified_units)} units need their description
                    checked
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ActBtn({
  onClick,
  children,
  icon,
  busy,
}: {
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 text-[11.5px] text-ink-2 border border-line-3 hover:border-accent hover:text-accent px-2.5 h-8 rounded-lg transition-colors disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}
