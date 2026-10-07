// R-449 Bills, R-446 Spending, R-447 True profit. One screen, three modes on a segmented control.
// Lazy-loaded from App.tsx (it is the only importer of recharts besides Analytics and Dashboard).
// Visible to admins and to anyone holding financials:view; every write control is admin only, and
// the server refuses a non-admin's write as well.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, RefreshCw } from "lucide-react";
import { toast } from "./Toast";
import type { Me } from "../lib/api";
import { localDay } from "../lib/format";
import { can, isAdmin } from "../lib/permissions";
import { canPayCarriers } from "../lib/logisticsCarriers";
import { BILL_OPEN_KEY } from "../lib/notices";
import {
  billsApi, type BillCandidate, type BillFields, type BillOut, type BillsList, type SpendingResponse,
} from "../lib/billsApi";
import { PERIODS, periodRange, rangeText, type PeriodKind } from "../lib/billsFormat";
import { CarriersToPaySection } from "./LogisticsPayCarriers";
import BillsMode from "./bills/BillsMode";
import BillDetail from "./bills/BillDetail";
import BillForm from "./bills/BillForm";
import SpendingMode from "./bills/SpendingMode";
import TrueProfitMode from "./bills/TrueProfitMode";
import { Seg, btn, pri } from "./bills/ui";

type Mode = "bills" | "spending" | "profit";

const MODES: { value: Mode; label: string }[] = [
  { value: "bills", label: "Bills" },
  { value: "spending", label: "Spending" },
  { value: "profit", label: "True profit" },
];

const SUB: Record<Mode, string> = {
  bills: "What goes out on a schedule, and whether it has been paid",
  spending: "Where the money went, bills and everything else",
  profit: "Deal profit after shipping, bank fees and the cost of running the business",
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function BillsView({ me }: { me: Me | null | undefined }) {
  const admin = isAdmin(me);
  const [pick, setPick] = useState<Mode>("bills");
  const [period, setPeriod] = useState<PeriodKind>("this_month");
  const [data, setData] = useState<BillsList | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cands, setCands] = useState<BillCandidate[]>([]);
  const [rev, setRev] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ bill?: BillOut; seed?: Partial<BillFields> } | null>(null);
  const [sp, setSp] = useState<{ resp?: SpendingResponse; error?: string; busy: boolean }>({ busy: false });
  const spSeq = useRef(0);

  // R-460: a notification stashed a bill to open, then switched here (or this screen was already open).
  // Read on arrival and when told; the bill opens on the Bills list.
  useEffect(() => {
    const take = () => {
      try {
        const id = localStorage.getItem(BILL_OPEN_KEY);
        if (id) { localStorage.removeItem(BILL_OPEN_KEY); setPick("bills"); setOpen(id.trim()); }
      } catch { /* storage blocked: Bills just opens */ }
    };
    take();
    window.addEventListener("bills-open", take);
    return () => window.removeEventListener("bills-open", take);
  }, []);

  // True profit is deal profit, the figures Analytics holds: admins and anyone with analytics:view
  // see it. An answer without a profit block falls back to Spending the same way.
  const resp = sp.resp;
  const hideProfit = !(admin || can(me, "analytics:view")) || (!!resp && resp.profit == null);
  const mode: Mode = pick === "profit" && hideProfit ? "spending" : pick;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await billsApi.list();
      setData(d);
      setError("");
      setRev((r) => r + 1);
      if (d.suggestions > 0) billsApi.detect().then(setCands).catch(() => setCands([]));
      else setCands([]);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // The list reloads when a bill or a link changes anywhere: this device wrote it (bills-changed)
  // or a sync from another device or the phone brought it in (netsync-applied).
  useEffect(() => {
    load();
    const un: (() => void)[] = [];
    let dead = false;
    for (const ev of ["bills-changed", "netsync-applied"]) {
      listen(ev, () => load()).then((u) => { if (dead) u(); else un.push(u); }).catch(() => {});
    }
    return () => { dead = true; un.forEach((u) => u()); };
  }, [load]);

  // Spending and True profit read the same answer for the period, so it is fetched once.
  const today = data?.today || localDay();
  const range = periodRange(period, today);
  const wantsSpend = mode !== "bills" && !!data;
  useEffect(() => {
    if (!wantsSpend) return;
    const id = ++spSeq.current;
    setSp((s) => ({ ...s, busy: true }));
    billsApi.spending(range.from, range.to)
      .then((resp) => { if (id === spSeq.current) setSp({ resp, busy: false }); })
      .catch((e) => { if (id === spSeq.current) setSp((s) => ({ resp: s.resp, error: msg(e), busy: false })); });
  }, [wantsSpend, range.from, range.to, rev]);

  const track = (c: BillCandidate) => setForm({
    seed: {
      name: c.name, payee_match: c.key, amount: c.amount, tolerance_pct: c.tolerance_pct,
      cadence: c.cadence, anchor_date: c.anchor, category: c.category,
    },
  });
  const ignore = async (c: BillCandidate) => {
    try { await billsApi.ignore(c.key, c.name); toast("Okay. It will not be suggested again."); await load(); } catch (e) { toast(msg(e), "error"); }
  };
  const restore = async (b: BillOut) => {
    try { await billsApi.archive(b.id, false); toast("Restored"); await load(); } catch (e) { toast(msg(e), "error"); }
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Bills</h2>
          <p className="text-[12px] text-muted mt-0.5">{SUB[mode]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Seg value={mode} onChange={setPick} options={hideProfit ? MODES.filter((m) => m.value !== "profit") : MODES} />
          <button onClick={load} className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] text-ink-2 border border-line hover:bg-surface-2 transition-colors duration-[130ms]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          {admin && mode === "bills" && <button onClick={() => setForm({})} className={pri}><Plus size={14} /> Add a bill</button>}
        </div>
      </div>

      {/* R-459: the carriers the team owes, above the recurring bills. Nothing shows when no one is owed. */}
      {mode === "bills" && <CarriersToPaySection canPay={canPayCarriers(me)} />}

      {mode !== "bills" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
          <Seg value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.kind, label: p.label }))} />
          <span className="text-[12px] text-muted">
            {rangeText(range.from, range.to)}
            {mode === "spending" && resp ? `, compared with ${rangeText(resp.prev_from, resp.prev_to)}` : ""}
          </span>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">
          <span className="min-w-0">{error}</span>
          <button onClick={load} className={btn}>Try again</button>
        </div>
      )}

      {data === null ? (
        error ? null : (
          <div className="space-y-4">
            <div className="h-24 bg-surface-2 rounded-2xl animate-pulse" />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => <div key={i} className="h-44 bg-surface-2 rounded-2xl animate-pulse" />)}
            </div>
          </div>
        )
      ) : mode === "bills" ? (
        <BillsMode data={data} cands={cands} admin={admin} onOpen={setOpen} onAdd={() => setForm({})}
          onTrack={track} onIgnore={ignore} onRestore={restore} />
      ) : !resp ? (
        sp.error ? (
          <div className="flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">
            <span className="min-w-0">{sp.error}</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="h-24 bg-surface-2 rounded-2xl animate-pulse" />
            <div className="h-72 bg-surface-2 rounded-2xl animate-pulse" />
          </div>
        )
      ) : (
        <div className={`transition-opacity duration-[130ms] ${sp.busy ? "opacity-60" : ""}`}>
          {sp.error && <div className="mb-4 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">{sp.error}</div>}
          {mode === "profit" && resp.profit ? <TrueProfitMode profit={resp.profit} /> : <SpendingMode resp={resp} bills={data.bills} />}
        </div>
      )}

      {open && (
        <BillDetail id={open} rev={rev} admin={admin} onClose={() => { if (!form) setOpen(null); }}
          onEdit={(b) => setForm({ bill: b })} onChanged={load} />
      )}
      {form && (
        <BillForm bill={form.bill} seed={form.seed} onClose={() => setForm(null)}
          onSaved={(linked) => {
            setForm(null);
            toast(linked > 0 ? `Saved. ${linked} payment${linked === 1 ? "" : "s"} linked.` : "Saved");
            load();
          }} />
      )}
    </div>
  );
}
