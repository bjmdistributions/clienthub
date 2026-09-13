import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  Lot,
  Me,
  ShowAddonConfig,
  ShowAddonState,
  ShowBuyer,
  ShowDetail,
  ShowItem,
  ShowListRow,
  ShowSaleRow,
} from "../lib/api";
import { isAdmin } from "../lib/permissions";
import { fmtAmount, localDay, parseAmount, parseLocalDay } from "../lib/format";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import NumberInput from "./NumberInput";
import {
  ArrowLeft,
  Check,
  Gift,
  Loader2,
  Monitor,
  PackageCheck,
  Plus,
  Printer,
  SkipForward,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";

// R-271/R-272 — buyer bins for Whatnot-style live shows. `shows`/`show_items`/
// `show_buyers`/`show_sales` live on the SERVER only (never synced, never touch
// deal_flows/invoices/the Brief) — every call rides the one `show_packing_request`
// proxy command, so a rejected call carries the server's own error string straight
// through to a toast.

function fmtShowDate(iso: string): string {
  if (!iso) return "";
  try {
    return parseLocalDay(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

function showTone(status: string): "accent" | "success" | "neutral" {
  if (status === "live") return "accent";
  if (status === "done") return "success";
  return "neutral";
}

function itemTone(status: string): "success" | "accent" | "warning" | "neutral" {
  switch (status) {
    case "sold": return "success";
    case "giveaway": return "accent";
    case "unsold": return "warning";
    default: return "neutral"; // pending / removed
  }
}

export default function ShowPackingView({ me }: { me?: Me | null }) {
  // undefined = still loading, null = couldn't reach the server.
  const [addon, setAddon] = useState<ShowAddonState | null | undefined>(undefined);
  const [shows, setShows] = useState<ShowListRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShowDetail | null>(null);

  const loadAddon = useCallback(() => {
    api.showPacking.addon().then(setAddon).catch(() => setAddon(null));
  }, []);
  useEffect(() => { loadAddon(); }, [loadAddon]);

  const loadShows = useCallback(() => {
    api.showPacking.listShows().then((r) => setShows(r.shows)).catch(() => setShows([]));
  }, []);
  useEffect(() => {
    if (addon?.enabled) loadShows();
  }, [addon?.enabled, loadShows]);

  const loadDetail = useCallback(() => {
    if (!activeId) return;
    api.showPacking.getShow(activeId).then(setDetail).catch((e: any) => toast(String(e), "error"));
  }, [activeId]);
  useEffect(() => { setDetail(null); loadDetail(); }, [activeId, loadDetail]);

  if (addon === undefined) {
    return (
      <div className="p-6 flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (addon === null) {
    return (
      <div className="p-6 max-w-[560px]">
        <div className="bg-surface border border-line rounded-xl p-6 text-[13px] text-muted">
          Couldn't reach the server to check Show packing. Connect this computer to your
          Ecliptr server (Settings → Sync) and try again.
        </div>
      </div>
    );
  }

  if (!addon.enabled) {
    if (!isAdmin(me)) {
      return (
        <div className="p-6 max-w-[560px]">
          <div className="bg-surface border border-line rounded-xl p-8 flex flex-col items-center text-center">
            <div className="w-11 h-11 rounded-xl bg-surface-2 flex items-center justify-center text-muted mb-3">
              <PackageCheck size={18} />
            </div>
            <h2 className="text-[16px] font-bold text-ink">Show packing</h2>
            <p className="text-[12.5px] text-muted mt-1.5 max-w-sm leading-relaxed">
              Ask an admin to turn on show packing in this view.
            </p>
          </div>
        </div>
      );
    }
    return (
      <SetupWizard
        initialConfig={addon.config}
        onActivated={(showId) => {
          loadAddon();
          loadShows();
          setActiveId(showId);
        }}
      />
    );
  }

  if (!activeId) {
    return (
      <ShowListScreen
        shows={shows}
        onOpen={setActiveId}
        onCreated={(id) => { loadShows(); setActiveId(id); }}
      />
    );
  }

  return (
    <ShowDetailScreen
      detail={detail}
      onBack={() => setActiveId(null)}
      onChanged={loadDetail}
    />
  );
}

// ---------- Setup wizard (admin, addon off) ----------

function SetupWizard({ initialConfig, onActivated }: { initialConfig: ShowAddonConfig; onActivated: (showId: string) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [config, setConfig] = useState<ShowAddonConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(localDay());

  const turnOn = async () => {
    setSaving(true);
    try {
      await api.showPacking.setAddon(true, config);
      setStep(2);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };
  const saveFees = async () => {
    setSaving(true);
    try {
      await api.showPacking.setAddon(true, config);
      setStep(3);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };
  const createFirstShow = async () => {
    if (!name.trim()) {
      toast("Name the show first.", "error");
      return;
    }
    setSaving(true);
    try {
      const show = await api.showPacking.createShow(name.trim(), date);
      onActivated(show.id);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-[560px]">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0 mt-0.5">
          <PackageCheck size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">Show packing</h2>
          <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
            Step {step} of 3
          </p>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        {step === 1 && (
          <>
            <p className="text-[13px] text-ink leading-relaxed">
              Every buyer who wins in a live show gets a box number the first time they win —
              every later win goes to the same box, so the boxes are already the packages by the
              end of the show.
            </p>
            <button
              onClick={turnOn}
              disabled={saving}
              className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Turn on show packing
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <label className="block text-[12px] font-medium text-muted">Whatnot fees</label>
            <div className="grid grid-cols-3 gap-3">
              <FeeField label="Take rate %" value={config.fee_pct} onValue={(n) => setConfig((c) => ({ ...c, fee_pct: n }))} />
              <FeeField label="Processing %" value={config.processing_pct} onValue={(n) => setConfig((c) => ({ ...c, processing_pct: n }))} />
              <FeeField label="Processing $" value={config.processing_fixed} onValue={(n) => setConfig((c) => ({ ...c, processing_fixed: n }))} />
            </div>
            <p className="text-[11.5px] text-muted leading-relaxed">
              Used to estimate fees on sales you haven't imported a payout report for yet. Every
              show can override these later.
            </p>
            <button
              onClick={saveFees}
              disabled={saving}
              className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null} Continue
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <label className="block text-[12px] font-medium text-muted">Your first show</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Show name"
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-3 h-10 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-3 h-10 rounded-lg text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
            <button
              onClick={createFirstShow}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create and open
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FeeField({ label, value, onValue }: { label: string; value: number; onValue: (n: number) => void }) {
  return (
    <div>
      <label className="block text-[10.5px] text-muted mb-1">{label}</label>
      <NumberInput
        value={value}
        onValue={onValue}
        style={{ background: "var(--t-input-bg)" }}
        className="w-full border border-line px-2.5 h-9 rounded-lg text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
      />
    </div>
  );
}

// ---------- Show list ----------

function ShowListScreen({
  shows,
  onOpen,
  onCreated,
}: {
  shows: ShowListRow[] | null;
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(localDay());
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      const show = await api.showPacking.createShow(name.trim(), date);
      setCreating(false);
      setName("");
      onCreated(show.id);
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-[960px] space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0 mt-0.5">
            <PackageCheck size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[18px] font-bold text-ink">Show packing</h2>
            <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
              Buyer boxes for your live shows.
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreating((c) => !c)}
          className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors flex-shrink-0"
        >
          <Plus size={14} /> New show
        </button>
      </div>

      {creating && (
        <div className="bg-surface border border-line rounded-xl p-4 flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            disabled={saving}
            placeholder="Show name"
            style={{ background: "var(--t-input-bg)" }}
            className="flex-1 border border-line px-3 h-9 rounded-lg text-[13px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60"
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ background: "var(--t-input-bg)" }}
            className="border border-line px-3 h-9 rounded-lg text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
          />
          <button
            onClick={create}
            disabled={saving || !name.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : "Create"}
          </button>
        </div>
      )}

      {shows === null ? (
        <div className="flex items-center gap-2 text-[13px] text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : shows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-3 bg-surface px-6 py-10 text-center text-[13px] text-muted">
          No shows yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          {shows.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="w-full text-left bg-surface border border-line rounded-xl px-4 py-3.5 hover:border-line-3 transition-colors flex items-center gap-4 flex-wrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold text-ink truncate">{s.name}</span>
                  <StatusPill tone={showTone(s.status)}>{s.status}</StatusPill>
                </div>
                <div className="text-[11.5px] text-muted mt-0.5">{fmtShowDate(s.show_date)}</div>
              </div>
              <div className="flex items-center gap-5 text-[12.5px] text-ink-2 flex-shrink-0">
                <Stat label="items" value={s.items} />
                <Stat label="sold" value={s.sold} />
                <Stat label="buyers" value={s.buyers} />
                <Stat label="gross" value={fmtAmount(s.gross)} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-right">
      <div className="font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  );
}

// ---------- Show detail ----------

type SubTab = "prep" | "live" | "results";

function ShowDetailScreen({
  detail,
  onBack,
  onChanged,
}: {
  detail: ShowDetail | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<SubTab>("live");

  if (!detail) {
    return (
      <div className="p-6 flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" /> Loading…
      </div>
    );
  }

  const { show } = detail;

  return (
    <div className="p-6 max-w-[1100px] space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="text-muted hover:text-ink transition-colors flex-shrink-0" title="Back to shows">
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[16px] font-bold text-ink truncate">{show.name}</h2>
            <StatusPill tone={showTone(show.status)}>{show.status}</StatusPill>
          </div>
          <div className="text-[11.5px] text-muted mt-0.5">{fmtShowDate(show.show_date)}</div>
        </div>
        <div className="flex gap-1 bg-surface-2 rounded-lg p-1 border border-line-2 flex-shrink-0">
          {([["prep", "Prep"], ["live", "Live"], ["results", "Pack & results"]] as [SubTab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`text-[12.5px] px-3 h-8 rounded-md transition-colors ${tab === id ? "bg-accent text-on-accent" : "text-ink-2 hover:text-accent"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "prep" && <PrepTab detail={detail} onChanged={onChanged} />}
      {tab === "live" && <LiveTab detail={detail} onChanged={onChanged} />}
      {tab === "results" && <ResultsTab detail={detail} onChanged={onChanged} />}
    </div>
  );
}

// ---------- Prep ----------

function PrepTab({ detail, onChanged }: { detail: ShowDetail; onChanged: () => void }) {
  const { show, items } = detail;
  const visible = items.filter((i) => i.status !== "removed").sort((a, b) => a.item_number - b.item_number);

  const [lots, setLots] = useState<Lot[]>([]);
  const [sourceLotId, setSourceLotId] = useState("");
  useEffect(() => { api.listInventory().then(setLots).catch(() => setLots([])); }, []);

  const [title, setTitle] = useState("");
  const [cost, setCost] = useState<number | "">("");
  const [startPrice, setStartPrice] = useState<number | "">("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const lot = lots.find((l) => l.id === sourceLotId);
    if (lot && lot.quantity > 0) setCost(Math.round((lot.total_cost / lot.quantity) * 100) / 100);
  }, [sourceLotId, lots]);

  // Guards both add paths below: the fast-add row is meant to be hit with Enter
  // repeatedly, and without this a second Enter before the first request returns
  // (title still unchanged) would add the same item twice.
  const [adding, setAdding] = useState(false);
  const addOne = async () => {
    if (adding || !title.trim()) return;
    setAdding(true);
    try {
      await api.showPacking.addItems(show.id, [{
        title: title.trim(),
        unit_cost: cost === "" ? undefined : cost,
        start_price: startPrice === "" ? undefined : startPrice,
        source_lot_id: sourceLotId || undefined,
      }]);
      setTitle("");
      setStartPrice("");
      onChanged();
      titleRef.current?.focus();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const addPasted = async () => {
    if (adding) return;
    const titles = pasteText.split("\n").map((t) => t.trim()).filter(Boolean);
    if (titles.length === 0) return;
    setAdding(true);
    try {
      await api.showPacking.addItems(show.id, titles.map((t) => ({ title: t, source_lot_id: sourceLotId || undefined })));
      setPasteText("");
      setPasting(false);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setAdding(false);
    }
  };

  const saveField = async (item: ShowItem, patch: Partial<{ title: string; unit_cost: number; start_price: number }>) => {
    try {
      await api.showPacking.updateItem(show.id, item.id, patch);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
  };
  const remove = async (item: ShowItem) => {
    try {
      await api.showPacking.updateItem(show.id, item.id, { status: "removed" });
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const printRunSheet = async () => {
    const dest = await saveDialog({ defaultPath: `${show.name}-run-sheet.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!dest) return;
    try {
      await api.showPackingPdf("run_sheet", dest, {
        items: visible.map((i) => ({ item_number: i.item_number, title: i.title, unit_cost: i.unit_cost, start_price: i.start_price })),
      });
      toast("Run sheet saved.");
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  const [labelCount, setLabelCount] = useState(30);
  const [labeling, setLabeling] = useState(false);
  const printBinLabels = async () => {
    const dest = await saveDialog({ defaultPath: `${show.name}-box-labels.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!dest) return;
    try {
      await api.showPackingPdf("bin_labels", dest, { from: 1, to: labelCount });
      toast("Box labels saved.");
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setLabeling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-[180px]">
            <label className="block text-[10.5px] text-muted mb-1">Source lot (optional)</label>
            <select
              value={sourceLotId}
              onChange={(e) => setSourceLotId(e.target.value)}
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-2.5 h-9 rounded-lg text-[12.5px] text-ink focus:outline-none focus:border-accent transition-colors"
            >
              <option value="">None</option>
              {lots.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10.5px] text-muted mb-1">Title</label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addOne(); }}
              disabled={adding}
              placeholder="What's up next"
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-2.5 h-9 rounded-lg text-[12.5px] text-ink placeholder:text-faint focus:outline-none focus:border-accent transition-colors disabled:opacity-60"
            />
          </div>
          <div className="w-24">
            <label className="block text-[10.5px] text-muted mb-1">Cost</label>
            <NumberInput
              value={cost}
              onValue={(n) => setCost(n)}
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-2.5 h-9 rounded-lg text-[12.5px] text-ink focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <div className="w-24">
            <label className="block text-[10.5px] text-muted mb-1">Start price</label>
            <NumberInput
              value={startPrice}
              onValue={(n) => setStartPrice(n)}
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-2.5 h-9 rounded-lg text-[12.5px] text-ink focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <button
            onClick={addOne}
            disabled={adding || !title.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50 flex-shrink-0"
          >
            Add
          </button>
          <button
            onClick={() => setPasting((p) => !p)}
            disabled={adding}
            className="border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors flex-shrink-0 disabled:opacity-50"
          >
            Paste titles
          </button>
        </div>
        {pasting && (
          <div className="space-y-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"One title per line"}
              rows={4}
              style={{ background: "var(--t-input-bg)" }}
              className="w-full border border-line px-2.5 py-2 rounded-lg text-[12.5px] text-ink placeholder:text-faint focus:outline-none focus:border-accent transition-colors"
            />
            <button
              onClick={addPasted}
              disabled={adding}
              className="bg-accent hover:bg-accent-hover text-on-accent px-3.5 h-8 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
            >
              Add {pasteText.split("\n").map((t) => t.trim()).filter(Boolean).length} items
            </button>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] text-muted border-b border-line-2">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Start price</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id} className="border-b border-line-2 last:border-0">
                  <td className="px-3 py-1.5 text-muted tabular-nums">{item.item_number}</td>
                  <td className="px-3 py-1.5">
                    <input
                      key={`${item.id}-title`}
                      defaultValue={item.title}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.title) saveField(item, { title: v }); }}
                      className="w-full bg-transparent focus:outline-none focus:ring-1 focus:ring-accent/40 rounded px-1 -mx-1"
                    />
                  </td>
                  <td className="px-3 py-1.5 w-24">
                    <input
                      key={`${item.id}-cost`}
                      defaultValue={item.unit_cost}
                      onBlur={(e) => { const n = parseAmount(e.target.value, item.unit_cost); if (n !== item.unit_cost) saveField(item, { unit_cost: n }); }}
                      className="w-full bg-transparent focus:outline-none focus:ring-1 focus:ring-accent/40 rounded px-1 -mx-1 tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-1.5 w-28">
                    <input
                      key={`${item.id}-start`}
                      defaultValue={item.start_price ?? ""}
                      onBlur={(e) => { const n = parseAmount(e.target.value, 0); if (n !== (item.start_price ?? 0)) saveField(item, { start_price: n }); }}
                      className="w-full bg-transparent focus:outline-none focus:ring-1 focus:ring-accent/40 rounded px-1 -mx-1 tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-1.5"><StatusPill tone={itemTone(item.status)}>{item.status}</StatusPill></td>
                  <td className="px-3 py-1.5 text-right">
                    {item.status === "pending" && (
                      <button onClick={() => remove(item)} className="text-faint hover:text-danger-ink transition-colors" title="Remove">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted">No items yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-2.5 flex-wrap">
        <button
          onClick={printRunSheet}
          className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors"
        >
          <Printer size={13} /> Print run sheet
        </button>
        {!labeling ? (
          <button
            onClick={() => setLabeling(true)}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors"
          >
            <Printer size={13} /> Print box labels
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">Boxes 1 to</span>
            <NumberInput
              value={labelCount}
              onValue={(n) => setLabelCount(n)}
              integer
              style={{ background: "var(--t-input-bg)" }}
              className="w-16 border border-line px-2 h-8 rounded-lg text-[12.5px] text-ink focus:outline-none focus:border-accent transition-colors"
            />
            <button onClick={printBinLabels} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12px] font-medium transition-colors">Print</button>
            <button onClick={() => setLabeling(false)} className="text-muted hover:text-ink text-[12px] transition-colors">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Live ----------

function LiveTab({ detail, onChanged }: { detail: ShowDetail; onChanged: () => void }) {
  const { show, items, buyers, last_sale } = detail;

  // Second device stays in step: poll while this tab is mounted.
  useEffect(() => {
    const t = setInterval(onChanged, 3000);
    return () => clearInterval(t);
  }, [onChanged]);

  const pending = items.filter((i) => i.status === "pending").sort((a, b) => a.item_number - b.item_number);
  const current = pending[0] ?? null;
  const next = pending[1] ?? null;

  const [buyerInput, setBuyerInput] = useState("");
  // Typed item number (1 to 200 on stream). Blank = the lowest pending item.
  const [itemNo, setItemNo] = useState("");
  const itemRef = useRef<HTMLInputElement>(null);
  const buyerRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(() => {
    try { return localStorage.getItem("ec_show_packing_speak") === "1"; } catch { return false; }
  });
  const [moverDisplay, setMoverDisplay] = useState(false);

  const toggleSpeak = () => {
    setSpeak((s) => {
      const next = !s;
      try { localStorage.setItem("ec_show_packing_speak", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // Speak only on a NEW last_sale, never on the poll tick that first mounts this
  // tab with an already-existing one.
  const lastSpokenRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = last_sale?.id ?? null;
    if (lastSpokenRef.current === undefined) { lastSpokenRef.current = id; return; }
    if (id !== lastSpokenRef.current) {
      lastSpokenRef.current = id;
      if (speak && last_sale && typeof window.speechSynthesis !== "undefined") {
        try {
          const text = last_sale.bin_number != null ? `Box ${last_sale.bin_number}` : "Giveaway";
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        } catch { /* speech unavailable */ }
      }
    }
  }, [last_sale, speak]);

  const typedNumber = itemNo.trim() ? parseInt(itemNo.trim().replace(/^#/, ""), 10) : null;
  const doSell = async (giveaway: boolean) => {
    if (busy) return;
    const buyer = buyerInput.trim();
    if (typedNumber !== null && !(typedNumber >= 1)) {
      toast("Item number must be 1 or more.", "error");
      return;
    }
    if (typedNumber === null && !current) {
      toast("Type the item number.", "error");
      return;
    }
    if (!giveaway && !buyer) {
      toast("Type the buyer's Whatnot username first.", "error");
      return;
    }
    setBusy(true);
    try {
      await api.showPacking.sell(show.id, { item_number: typedNumber ?? undefined, buyer: buyer || undefined, giveaway });
      setBuyerInput("");
      setItemNo("");
      itemRef.current?.focus();
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const undoLast = async () => {
    if (!last_sale) return;
    setBusy(true);
    try {
      await api.showPacking.unsell(show.id, last_sale.id);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const skipCurrent = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await api.showPacking.updateItem(show.id, current.id, { status: "unsold" });
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const q = buyerInput.trim().toLowerCase().replace(/^@/, "");
  const chipMatches: ShowBuyer[] = q
    ? buyers.filter((b) => b.username.includes(q) || b.display_name.toLowerCase().includes(q)).slice(0, 8)
    : buyers.slice(0, 8);

  if (moverDisplay) {
    return (
      <div
        onClick={() => setMoverDisplay(false)}
        className="fixed inset-0 z-50 bg-ink text-surface flex flex-col items-center justify-center gap-4 cursor-pointer select-none"
      >
        {last_sale ? (
          <>
            <div className="text-[16vw] font-bold leading-none tabular-nums">
              {last_sale.bin_number != null ? `Box ${last_sale.bin_number}` : "Giveaway"}
            </div>
            {last_sale.buyer && <div className="text-[4vw] text-surface/70">@{last_sale.buyer}</div>}
          </>
        ) : (
          <div className="text-[4vw] text-surface/60">Waiting for the first sale…</div>
        )}
        <div className="text-[13px] text-surface/40 mt-6">Tap to exit</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-line rounded-xl p-8 text-center">
        {last_sale ? (
          <>
            <div className="text-[42px] font-bold text-ink leading-none tabular-nums">
              #{last_sale.item_number} → {last_sale.bin_number != null ? `Box ${last_sale.bin_number}` : "Giveaway"}
            </div>
            {last_sale.buyer && <div className="text-[16px] text-muted mt-2">@{last_sale.buyer}</div>}
          </>
        ) : (
          <div className="text-[16px] text-muted">No sales yet — record the first one below.</div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="text-[12.5px] text-ink">
          {typedNumber !== null
            ? <>Recording <span className="font-semibold">#{typedNumber}</span></>
            : current ? <>Now selling: <span className="font-semibold">#{current.item_number} — {current.title}</span></> : "Type the item number that just sold."}
        </div>
        <div className="flex gap-2">
          <input
            ref={itemRef}
            type="text"
            inputMode="numeric"
            autoFocus
            value={itemNo}
            onChange={(e) => setItemNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") buyerRef.current?.focus(); }}
            placeholder={current ? `#${current.item_number}` : "Item #"}
            style={{ background: "var(--t-input-bg)" }}
            className="w-24 border border-line px-3 h-11 rounded-lg text-[15px] text-ink tabular-nums placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60"
          />
          <input
            ref={buyerRef}
            type="text"
            value={buyerInput}
            onChange={(e) => setBuyerInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSell(false); }}
            placeholder="Buyer's Whatnot username"
            style={{ background: "var(--t-input-bg)" }}
            className="flex-1 min-w-0 border border-line px-3 h-11 rounded-lg text-[15px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60"
          />
          <button
            onClick={() => doSell(false)}
            disabled={busy || !buyerInput.trim()}
            className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-11 rounded-lg text-[13.5px] font-medium transition-colors disabled:opacity-50 flex-shrink-0"
          >
            Record
          </button>
        </div>
        {chipMatches.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chipMatches.map((b) => (
              <button
                key={b.id}
                onClick={() => setBuyerInput(b.username)}
                className="text-[11.5px] px-2.5 h-6 rounded-full border border-line-2 text-ink-2 hover:border-accent hover:text-accent transition-colors"
              >
                Box {b.bin_number} · @{b.username}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            onClick={() => doSell(true)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3 h-9 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
          >
            <Gift size={13} /> Giveaway
          </button>
          <button
            onClick={skipCurrent}
            disabled={busy || !current}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3 h-9 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
          >
            <SkipForward size={13} /> Skip item
          </button>
          <button
            onClick={undoLast}
            disabled={busy || !last_sale}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3 h-9 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
          >
            <Undo2 size={13} /> Undo last
          </button>
          <div className="flex-1" />
          <button
            onClick={toggleSpeak}
            className={`inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-[12.5px] font-medium transition-colors ${speak ? "bg-accent text-on-accent" : "border border-line text-ink-2 hover:bg-surface-2"}`}
          >
            {speak ? <Volume2 size={13} /> : <VolumeX size={13} />} Speak
          </button>
          <button
            onClick={() => setMoverDisplay(true)}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3 h-9 rounded-lg text-[12.5px] font-medium transition-colors"
          >
            <Monitor size={13} /> Mover display
          </button>
        </div>
      </div>

      {next && (
        <div className="text-[12px] text-muted px-1">Next: #{next.item_number} — {next.title}</div>
      )}
    </div>
  );
}

// ---------- Pack & results ----------

type ImportField = "ignore" | "order_id" | "listing_title" | "item_number" | "buyer" | "sale_price" | "fees";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  return rows;
}

function guessField(header: string): ImportField {
  const h = header.toLowerCase();
  if (h.includes("order")) return "order_id";
  if (h.includes("item") || h === "#") return "item_number";
  if (h.includes("title") || h.includes("listing")) return "listing_title";
  if (h.includes("buyer") || h.includes("user")) return "buyer";
  if (h.includes("fee")) return "fees";
  if (h.includes("price") || h.includes("sale") || h.includes("amount")) return "sale_price";
  return "ignore";
}

function ResultsTab({ detail, onChanged }: { detail: ShowDetail; onChanged: () => void }) {
  const { show, buyers, items, pnl, mismatches } = detail;
  const pendingLeft = pnl.pending ?? pnl.unsold ?? 0;

  const soldByUsername = useMemo(() => {
    const map = new Map<string, ShowItem[]>();
    for (const i of items) {
      if ((i.status === "sold" || i.status === "giveaway") && i.buyer) {
        if (!map.has(i.buyer)) map.set(i.buyer, []);
        map.get(i.buyer)!.push(i);
      }
    }
    return map;
  }, [items]);
  const noBuyerGiveaways = items.filter((i) => i.status === "giveaway" && !i.buyer);
  const sortedBuyers = [...buyers].sort((a, b) => a.bin_number - b.bin_number);

  const printPackingList = async () => {
    const dest = await saveDialog({ defaultPath: `${show.name}-packing-list.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!dest) return;
    try {
      await api.showPackingPdf("packing_list", dest, {
        buyers: sortedBuyers.map((b) => ({
          bin_number: b.bin_number,
          username: b.username,
          items: (soldByUsername.get(b.username) || []).sort((a, c) => a.item_number - c.item_number)
            .map((i) => ({ item_number: i.item_number, title: i.title, sale_price: i.sale_price ?? 0 })),
        })),
      });
      toast("Packing list saved.");
    } catch (e: any) {
      toast(String(e), "error");
    }
  };

  // ── CSV import ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [importing, setImporting] = useState(false);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsv(String(reader.result || ""));
      if (parsed.length < 1) { toast("That file has no rows.", "error"); return; }
      setRows(parsed);
      setMapping(parsed[0].map(guessField));
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!rows) return;
    const body = rows.slice(1).map((cells) => {
      const r: Record<string, any> = {};
      mapping.forEach((f, i) => {
        if (f === "ignore") return;
        const raw = cells[i] ?? "";
        if (f === "item_number") r.item_number = parseInt(raw, 10) || undefined;
        else if (f === "sale_price" || f === "fees") r[f] = parseAmount(raw, undefined as any);
        else r[f] = raw;
      });
      return r;
    });
    setImporting(true);
    try {
      const r = await api.showPacking.importRows(show.id, body);
      toast(`Imported ${r.imported} rows — ${r.matched} matched.`);
      setRows(null);
      onChanged();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <PnlTile label="Gross" value={fmtAmount(pnl.gross)} />
        <PnlTile label={`Fees (${pnl.fees_source})`} value={fmtAmount(pnl.fees)} />
        <PnlTile label="Cost" value={fmtAmount(pnl.cost)} />
        <PnlTile label="Net" value={fmtAmount(pnl.net)} />
        <PnlTile label="Sold" value={pnl.sold} />
        <PnlTile label="Giveaways" value={pnl.giveaways} />
        <PnlTile label="Pending" value={pendingLeft} />
        <PnlTile label="Avg sale" value={fmtAmount(pnl.avg_sale)} />
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[13px] font-semibold text-ink">Buyers by box</h3>
        <button
          onClick={printPackingList}
          className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors"
        >
          <Printer size={13} /> Print packing list
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {sortedBuyers.map((b) => {
          const bItems = (soldByUsername.get(b.username) || []).sort((a, c) => a.item_number - c.item_number);
          return (
            <div key={b.id} className="bg-surface border border-line rounded-xl p-3.5 min-w-0">
              <div className="text-[13px] font-semibold text-ink mb-1.5">Box {b.bin_number} — @{b.username}</div>
              <ul className="space-y-0.5 text-[12px] text-ink-2">
                {bItems.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="truncate">#{i.item_number} {i.title}</span>
                    <span className="tabular-nums flex-shrink-0">{fmtAmount(i.sale_price ?? 0)}</span>
                  </li>
                ))}
                {bItems.length === 0 && <li className="text-muted">No items yet.</li>}
              </ul>
            </div>
          );
        })}
        {noBuyerGiveaways.length > 0 && (
          <div className="bg-surface border border-line rounded-xl p-3.5 min-w-0">
            <div className="text-[13px] font-semibold text-ink mb-1.5">Giveaways (no buyer)</div>
            <ul className="space-y-0.5 text-[12px] text-ink-2">
              {noBuyerGiveaways.map((i) => <li key={i.id}>#{i.item_number} {i.title}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-[13px] font-semibold text-ink">Import Whatnot payout CSV</h3>
          <button
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors"
          >
            <Upload size={13} /> Choose file
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
        </div>
        {rows && (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr>
                    {rows[0].map((h, i) => (
                      <th key={i} className="px-2 py-1 text-left">
                        <div className="text-muted mb-1 truncate max-w-[140px]">{h}</div>
                        <select
                          value={mapping[i]}
                          onChange={(e) => setMapping((m) => m.map((f, idx) => (idx === i ? (e.target.value as ImportField) : f)))}
                          style={{ background: "var(--t-input-bg)" }}
                          className="border border-line rounded px-1 h-6 text-[11px] text-ink"
                        >
                          <option value="ignore">Ignore</option>
                          <option value="order_id">Order ID</option>
                          <option value="listing_title">Listing title</option>
                          <option value="item_number">Item #</option>
                          <option value="buyer">Buyer</option>
                          <option value="sale_price">Sale price</option>
                          <option value="fees">Fees</option>
                        </select>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(1, 6).map((r, ri) => (
                    <tr key={ri} className="border-t border-line-2">
                      {r.map((c, ci) => <td key={ci} className="px-2 py-1 text-ink-2 truncate max-w-[160px]">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doImport}
                disabled={importing}
                className="bg-accent hover:bg-accent-hover text-on-accent px-3.5 h-9 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-50"
              >
                {importing ? <Loader2 size={13} className="animate-spin" /> : `Import ${rows.length - 1} rows`}
              </button>
              <button onClick={() => setRows(null)} className="text-muted hover:text-ink text-[12.5px] transition-colors">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {mismatches.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line-2 text-[12.5px] font-semibold text-ink">Mismatches</div>
          <table className="w-full text-[12px]">
            <tbody>
              {mismatches.map((r: ShowSaleRow) => (
                <tr key={r.id} className="border-b border-line-2 last:border-0">
                  <td className="px-4 py-1.5 text-ink-2 truncate max-w-[220px]">{r.listing_title || r.order_id}</td>
                  <td className="px-4 py-1.5 text-muted">@{r.buyer}</td>
                  <td className="px-4 py-1.5 text-ink-2 tabular-nums">{fmtAmount(r.sale_price)}</td>
                  <td className="px-4 py-1.5"><StatusPill tone="warning">{r.match_status}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PnlTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-3.5 min-w-0">
      <div className="text-[18px] font-bold text-ink tabular-nums leading-none truncate">{value}</div>
      <div className="text-[10px] text-muted mt-1">{label}</div>
    </div>
  );
}
