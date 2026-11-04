import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  api, DashboardStats, Client, Invoice, ReceivablesAging, FinancialsOverview, FreightBooking, AnalyticsDeal, Me,
} from "../lib/api";
import { fmtCompactCurrency, fmtAmount, localDay } from "../lib/format";
import { billsApi, type BillsAlerts } from "../lib/billsApi";
import { alertRow } from "../lib/billsFormat";
import {
  Users, FileText, Mail, ChevronLeft, ChevronRight, ChevronDown, Package, Clock, TrendingUp,
  Receipt, GitBranch, Link2, DollarSign, Truck, UserPlus, ArrowRight, Calendar,
} from "lucide-react";
import PendingReviewModal from "./PendingReviewModal";
import { can, isAdmin } from "../lib/permissions";
import StatusPill from "./StatusPill";
import DashboardLoads from "./DashboardLoads";
import { isNoiseItem, parseLineItems } from "../lib/itemSearch";
import { dashboardLoads } from "../lib/logisticsLoad";
import { Button, Kpi, MonoAreaChart, PageHeader, Tabs, compact, useCountUp } from "./ui";

interface Props {
  onNavigate: (t: any) => void;
  me: Me | null | undefined;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

const invStatusTone = (s: string): "success" | "danger" | "neutral" => {
  const lo = s.toLowerCase();
  if (lo === "paid") return "success";
  if (lo === "overdue") return "danger";
  return "neutral";
};

const invStatusLabel = (s: string): string => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function CompactAmount({ value }: { value: number }) {
  const full = fmtAmount(value);
  const compactText = fmtCompactCurrency(value);
  if (full === compactText) return <>{compactText}</>;
  return (
    <span className="compact-amount" data-tip={full}>
      {compactText}
    </span>
  );
}

// A whole-number figure that counts to its new value (the Clients count).
function CountInt({ value }: { value: number }) {
  const v = useCountUp(value);
  return <>{Math.round(v ?? value).toLocaleString()}</>;
}

// Dates are local days. Every range is whole days: start and end are both included.
const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, k: number) => { const x = sod(d); x.setDate(x.getDate() + k); return x; };
const dayNum = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const short = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const long = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "long" });
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

type DashRange =
  | { kind: "month"; start: Date; end: Date }
  | { kind: "days"; n: number; start: Date; end: Date }
  | { kind: "custom"; start: Date; end: Date }
  | { kind: "all"; start: Date; end: Date };

const monthRange = (y: number, m: number): DashRange => ({ kind: "month", start: new Date(y, m, 1), end: new Date(y, m + 1, 0) });
const daysRange = (n: number, today: Date): DashRange => ({ kind: "days", n, start: addDays(today, -(n - 1)), end: sod(today) });
const allRange = (today: Date): DashRange => ({ kind: "all", start: sod(today), end: sod(today) });

// What one day contributes (a closed deal's profit and revenue on its close date, plus the bank's
// shipping and fees that day). The server returns only days that have something.
interface DayRow { profit: number; revenue: number; shipping: number; fees: number }
type MonthRows = Record<string, DayRow>;
const ZERO: DayRow = { profit: 0, revenue: 0, shipping: 0, fees: 0 };
type Metric = "profit" | "revenue" | "trueNet";

// The period before: the previous calendar month for a month, the same number of days before for the rest.
const prevStartOf = (r: DashRange): Date =>
  r.kind === "month" ? new Date(r.start.getFullYear(), r.start.getMonth() - 1, 1) : addDays(r.start, -(dayNum(r.end) - dayNum(r.start) + 1));

// Every month the range and the period before it touch.
function monthsFor(r: DashRange): string[] {
  const out: string[] = [];
  const a = prevStartOf(r), b = r.end;
  for (let y = a.getFullYear(), m = a.getMonth(); y < b.getFullYear() || (y === b.getFullYear() && m <= b.getMonth()); ) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

interface Run { profit: number[]; revenue: number[]; trueNet: number[]; sums: { profit: number; revenue: number; trueNet: number; shipping: number; fees: number } }

function buildSeries(range: DashRange, cache: Map<string, MonthRows>, today: Date) {
  const n = dayNum(range.end) - dayNum(range.start) + 1;
  const last = Math.min(dayNum(range.end), dayNum(today));
  const m = Math.max(0, last - dayNum(range.start) + 1);
  const prevStart = prevStartOf(range);
  const prevN = range.kind === "month" ? new Date(range.start.getFullYear(), range.start.getMonth(), 0).getDate() : n;
  const rowOf = (d: Date): DayRow => cache.get(monthKey(d))?.[localDay(d)] ?? ZERO;
  const run = (start: Date, count: number): Run => {
    const out: Run = { profit: [], revenue: [], trueNet: [], sums: { profit: 0, revenue: 0, trueNet: 0, shipping: 0, fees: 0 } };
    let p = 0, r = 0, t = 0, sh = 0, fe = 0;
    for (let i = 0; i < count; i++) {
      const row = rowOf(addDays(start, i));
      p += row.profit; r += row.revenue; sh += row.shipping; fe += row.fees; t += row.profit - row.shipping - row.fees;
      out.profit.push(p); out.revenue.push(r); out.trueNet.push(t);
    }
    out.sums = { profit: p, revenue: r, trueNet: t, shipping: sh, fees: fe };
    return out;
  };
  return { n, m, prevStart, cur: run(range.start, m), prev: run(prevStart, prevN), prevSame: run(prevStart, Math.min(m, prevN)) };
}

const pctChange = (now: number, before: number): number | null => (before ? (now - before) / Math.abs(before) : null);
const pctText = (r: number) => `${Math.abs(r * 100).toFixed(1)}%`;

// ── the range control: Go back a month, the range menu with a calendar, the dates ───────────────

function RangeMenu({ range, today, onPick }: { range: DashRange; today: Date; onPick: (r: DashRange) => void }) {
  const [picking, setPicking] = useState(false);
  const [cal, setCal] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [a, setA] = useState<Date | null>(null);
  const [b, setB] = useState<Date | null>(null);

  const presets: { label: string; sub: string; make: () => DashRange; is: boolean }[] = [
    { label: "This month", sub: `${short(new Date(today.getFullYear(), today.getMonth(), 1))} to ${short(new Date(today.getFullYear(), today.getMonth() + 1, 0))}`,
      make: () => monthRange(today.getFullYear(), today.getMonth()), is: range.kind === "month" && sameMonth(range.start, today) },
    ...[7, 14, 30, 60, 90].map((n) => ({ label: `Last ${n} days`, sub: "", make: () => daysRange(n, today), is: range.kind === "days" && range.n === n })),
    { label: "All time", sub: "Since the start", make: () => allRange(today), is: range.kind === "all" },
  ];

  const first = new Date(cal.y, cal.m, 1);
  const daysIn = new Date(cal.y, cal.m + 1, 0).getDate();
  const lo = a && b ? (a < b ? a : b) : a;
  const hi = a && b ? (a < b ? b : a) : a;
  const cells: (Date | null)[] = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(new Date(cal.y, cal.m, d));
  const step = (k: number) => setCal((c) => { const d = new Date(c.y, c.m + k, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const clickDay = (d: Date) => {
    if (d > today) return;
    if (!a || b) { setA(d); setB(null); } else setB(d);
  };

  return (
    <div className="ui-pop mt-2 left-0 top-full w-[292px]" role="menu">
      {!picking ? (
        <>
          {presets.map((p) => (
            <button key={p.label} role="menuitemradio" aria-checked={p.is} className="ui-pop-item" onClick={() => onPick(p.make())}>
              <span>{p.label}</span>
              <span className="sub">{p.is ? "Showing" : p.sub}</span>
            </button>
          ))}
          <div className="hsep my-1.5" />
          <button className="ui-pop-item" onClick={() => { setPicking(true); setA(null); setB(null); setCal({ y: today.getFullYear(), m: today.getMonth() }); }}>
            <span>Pick dates</span>
            <ChevronRight size={14} strokeWidth={1.75} className="text-muted" />
          </button>
        </>
      ) : (
        <div>
          <div className="flex items-center justify-between px-1 pt-1 pb-2">
            <button className="ui-ib" onClick={() => step(-1)} aria-label="Previous month"><ChevronLeft size={14} strokeWidth={1.75} /></button>
            <span className="text-[13px] font-medium text-ink">{first.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
            <button className="ui-ib" onClick={() => step(1)} aria-label="Next month"><ChevronRight size={14} strokeWidth={1.75} /></button>
          </div>
          <div className="grid grid-cols-7 text-center text-[12px] text-muted mb-1">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((d, i) => {
              if (!d) return <span key={i} />;
              const future = d > today;
              const edge = (lo && +d === +lo) || (hi && +d === +hi);
              const inside = lo && hi && d > lo && d < hi;
              return (
                <button key={i} disabled={future} onClick={() => clickDay(d)}
                  className={`h-8 text-[13px] tabular-nums transition-colors duration-[130ms] ${
                    edge ? "rounded-lg bg-ink text-surface"
                      : inside ? "bg-surface-3 text-ink"
                      : future ? "rounded-lg text-faint opacity-40 cursor-default"
                      : "rounded-lg text-ink hover:bg-surface-3"}`}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2 px-1 pt-3 pb-0.5">
            <span className="text-[12px] text-muted">{lo ? short(lo) + (hi && +hi !== +lo ? ` to ${short(hi)}` : "") : "Pick a start day"}</span>
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => setPicking(false)}>Cancel</Button>
              <Button size="sm" variant="ink" disabled={!(lo && hi)} onClick={() => lo && hi && onPick({ kind: "custom", start: lo, end: hi })}>Apply</Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── deals closed, one dot a day ────────────────────────────────────────────────────────────────

const WEEKS = 31;
const HEAT_DAYS = WEEKS * 7;
const HEAT_LVL = ["var(--heat-0)", "var(--heat-1)", "var(--heat-2)", "var(--heat-3)"];

interface HeatCell { d: Date; n: number; profit: number }

const HeatGrid = memo(function HeatGrid({ cells, onHover }: { cells: HeatCell[]; onHover: (i: number | null) => void }) {
  const months = Array.from({ length: WEEKS }, (_, w) => {
    const d = cells[w * 7].d, p = w ? cells[(w - 1) * 7].d : null;
    return !p || p.getMonth() !== d.getMonth() ? d.toLocaleDateString("en-US", { month: "short" }) : "";
  });
  return (
    <div className="flex gap-2.5 mt-5">
      <div className="grid gap-1 pt-5 w-7 text-[12px] text-muted" style={{ gridTemplateRows: "repeat(7, minmax(0, 1fr))" }} aria-hidden>
        <span /><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span />
      </div>
      <div className="flex-1 min-w-0">
        <div className="grid gap-1 h-4 mb-1 text-[12px] text-muted" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }} aria-hidden>
          {months.map((m, i) => <span key={i} className="whitespace-nowrap">{m}</span>)}
        </div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`, gridTemplateRows: "repeat(7, auto)", gridAutoFlow: "column" }}
          onMouseLeave={() => onHover(null)}>
          {cells.map((c, i) => (
            <span key={i} data-i={i} onMouseEnter={() => onHover(i)}
              className="aspect-square rounded-[3px] transition-transform duration-[150ms] hover:scale-125"
              style={{ background: c.n < 0 ? "transparent" : HEAT_LVL[Math.min(3, c.n)] }} />
          ))}
        </div>
      </div>
    </div>
  );
});

// ── the gauge and the tick bars ────────────────────────────────────────────────────────────────

const Gauge = memo(function Gauge({ fraction }: { fraction: number }) {
  const T = 56, c = 124, r1 = 96, r2 = 116;
  const ticks = Array.from({ length: T }, (_, i) => {
    const a = ((140 + (260 * i) / (T - 1)) * Math.PI) / 180;
    return { x1: c + r1 * Math.cos(a), y1: c + r1 * Math.sin(a), x2: c + r2 * Math.cos(a), y2: c + r2 * Math.sin(a), on: i / (T - 1) <= fraction };
  });
  return (
    <svg width="248" height="248" viewBox="0 0 248 248" aria-hidden className="absolute left-0 top-0">
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1.toFixed(1)} y1={t.y1.toFixed(1)} x2={t.x2.toFixed(1)} y2={t.y2.toFixed(1)} strokeWidth="5" strokeLinecap="round"
          style={{ stroke: t.on ? "var(--chart-hi)" : "var(--chart-lo)", transition: "stroke .3s var(--ease)" }} />
      ))}
    </svg>
  );
});

function ClientTicks({ fraction, label }: { fraction: number; label: string }) {
  const N = 70;
  return (
    <div className="relative flex items-end gap-0.5 h-10 mt-3.5" role="img" aria-label={label}>
      {Array.from({ length: N }, (_, i) => {
        const f = i / N, mark = Math.abs(f - fraction) < 0.0075;
        return <span key={i} className="flex-1 rounded-[1px]"
          style={{ height: mark ? "100%" : "62%", background: mark ? "rgb(var(--c-ink))" : f < fraction ? "var(--heat-2)" : "var(--chart-lo)" }} />;
      })}
      <span className="absolute -top-4 -translate-x-1/2 text-[12px] font-medium text-ink tabular-nums" style={{ left: `${fraction * 100}%` }}>{Math.round(fraction * 100)}%</span>
    </div>
  );
}

// A row of the Needs attention list: a count that opens the place where it is dealt with.
function AttentionRow({ icon: Icon, label, sub, n, urgent, onClick }: {
  icon: typeof Link2; label: string; sub?: string; n: number; urgent?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="group flex w-full items-center gap-3 min-h-[46px] px-3 py-2.5 rounded-[10px] text-left text-[14px] font-medium text-muted hover:bg-surface-2 hover:text-ink transition-colors duration-[150ms]">
      <Icon size={16} strokeWidth={1.75} className="flex-shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {sub ? <span className="block truncate text-[12px] font-normal text-muted">{sub}</span> : null}
      </span>
      <span className={`ui-count ${urgent ? "urgent" : ""}`}>{n}</span>
      <ChevronRight size={14} strokeWidth={1.75} className="flex-shrink-0 transition-transform duration-[150ms] group-hover:translate-x-0.5" />
    </button>
  );
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────────

export default function DashboardView({ onNavigate, me }: Props) {
  // Org money (cash position, revenue, profit) is hidden from reps/viewers
  // unless they hold deal_flow:view_numbers. Admins/owners carry "*" and pass.
  const showMoney = can(me, "deal_flow:view_numbers");
  // R-449: bills read like the books (admins and financials:view), not like deal numbers.
  const showBills = isAdmin(me) || can(me, "financials:view");

  const today = useMemo(() => sod(new Date()), []);

  const [stats, setStats]               = useState<DashboardStats | null>(null);
  const [ar, setAr]                     = useState<ReceivablesAging | null>(null);
  const [followups, setFollowups]       = useState<Client[]>([]);
  const [pendingApprovals, setPending]  = useState<Client[]>([]);
  const [billAlerts, setBillAlerts]     = useState<BillsAlerts | null>(null);
  const [reviewClient, setReviewClient] = useState<Client | null>(null);
  const [allInvoices, setAllInvoices]   = useState<Invoice[]>([]);
  const [clients, setClients]           = useState<Client[]>([]);
  const [loads, setLoads]               = useState<FreightBooking[] | null>(null);
  const [overview, setOverview]         = useState<FinancialsOverview | null>(null);
  const [unlinkedIn, setUnlinkedIn]     = useState<number | null>(null);
  const [heatDeals, setHeatDeals]       = useState<{ deals: AnalyticsDeal[]; capped: boolean } | null>(null);
  const [heatBefore, setHeatBefore]     = useState<number | null>(null);
  const [heatHover, setHeatHover]       = useState<number | null>(null);
  const [chartMetric, setChartMetric]   = useState<"profit" | "revenue">("profit");
  const [scrub, setScrub]               = useState<number | null>(null);

  // The range being shown. Opens on the 1st to the last day of this month, or on All time if that is how it was left.
  const [range, setRangeState] = useState<DashRange>(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("ec_dash_range"); } catch { /* storage blocked: use the month */ }
    return saved === "all" ? allRange(today) : monthRange(today.getFullYear(), today.getMonth());
  });
  // The range whose numbers are on screen. It trails `range` by the time the new days take to arrive, so the old
  // figures and chart stay (and morph) instead of flashing empty.
  const [shownRange, setShownRange] = useState<DashRange | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const cacheRef = useRef(new Map<string, MonthRows>());
  const seqRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadAll = () => {
    api.dueFollowups().then(setFollowups).catch(() => {});
    api.getPendingApprovals().then(setPending).catch(() => {});
    if (showBills) billsApi.alerts().then(setBillAlerts).catch(() => setBillAlerts(null));
    // Hero counts (clients / open deals / completed this month) are non-sensitive
    // and shown to everyone, so dashboard stats load for all users.
    api.dashboardStats().then(setStats).catch(console.error);
    // Money-bearing data (AR, the invoice list) is only fetched for users who may see it.
    if (!showMoney) return;
    api.getReceivablesAging().then(setAr).catch(() => setAr(null));
    api.listInvoices().then(setAllInvoices).catch(() => {});
  };

  // Show a range: fetch the months it and the period before it need (those not already held), then swap it in.
  const showRange = async (r: DashRange) => {
    setRangeState(r);
    setMenuOpen(false);
    try { localStorage.setItem("ec_dash_range", r.kind === "all" ? "all" : "month"); } catch { /* ignore */ }
    if (r.kind === "all") { seqRef.current++; setShownRange(r); return; }
    const id = ++seqRef.current;
    const need = monthsFor(r).filter((k) => !cacheRef.current.has(k));
    await Promise.all(need.map(async (k) => {
      try {
        const raw = await api.getMonthlyProfit(k);
        const rows: MonthRows = {};
        raw.forEach((x) => { rows[x.day] = { profit: x.profit, revenue: x.revenue, shipping: x.shipping, fees: x.fees }; });
        cacheRef.current.set(k, rows);
      } catch { /* that month shows as no closed deals until the next load */ }
    }));
    if (id === seqRef.current) setShownRange(r);
  };

  useEffect(() => {
    loadAll();
    api.listClients().then(setClients).catch(console.error);
    api.logistics.list().then((r) => setLoads(r.bookings ?? [])).catch(() => setLoads(null));
    if (showMoney) showRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMoney]);

  // What the books say about the money in: the linked total, the tax set aside and the rows still to link.
  useEffect(() => {
    if (!showBills) return;
    api.financialsOverview().then(setOverview).catch(() => setOverview(null));
    api.unallocatedBankTxns().then((r) => {
      const DEAL_CAPABLE = ["", "receipt", "payment", "merchandise", "shipping", "customs", "customer_refund", "supplier_refund", "cash_in", "cash_out"];
      setUnlinkedIn(r.money_in.filter((t) => DEAL_CAPABLE.includes(t.category || "") && t.unallocated > 0.0001).reduce((s, t) => s + t.unallocated, 0));
    }).catch(() => setUnlinkedIn(null));
  }, [showBills]);

  // Deals closed per day, the last 31 weeks, and how many closed in the 31 weeks before.
  const heatStart = useMemo(() => addDays(today, -today.getDay() - (WEEKS - 1) * 7), [today]);
  useEffect(() => {
    if (!showMoney) return;
    let alive = true;
    api.getAnalyticsRange(localDay(heatStart), localDay(today))
      .then((r) => { if (alive) setHeatDeals({ deals: r.completed_deals, capped: r.completed_deals_capped }); })
      .catch(() => { if (alive) setHeatDeals(null); });
    api.getAnalyticsRange(localDay(addDays(heatStart, -HEAT_DAYS)), localDay(addDays(heatStart, -1)))
      .then((r) => { if (alive) setHeatBefore(r.deal_count); })
      .catch(() => { if (alive) setHeatBefore(null); });
    return () => { alive = false; };
  }, [showMoney, heatStart, today]);

  // R-313: the Settings "Show true net on the dashboard" switch dispatches this so an
  // already-open dashboard picks up the new preference without a manual refresh.
  useEffect(() => {
    const onPrefsChange = () => { api.dashboardStats().then(setStats).catch(() => {}); };
    window.addEventListener("dashboard-prefs-change", onPrefsChange);
    return () => window.removeEventListener("dashboard-prefs-change", onPrefsChange);
  }, []);

  // The range menu closes on a click outside it or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const down = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [menuOpen]);

  const series = useMemo(
    () => (shownRange && shownRange.kind !== "all" ? buildSeries(shownRange, cacheRef.current, today) : null),
    [shownRange, today],
  );

  const resolvedApproval = (id: string) => {
    setPending((p) => p.filter((x) => x.id !== id));
    window.dispatchEvent(new CustomEvent("approvals-changed"));
  };

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "-";
  const recentInvoices = useMemo(() => allInvoices.slice(0, 6), [allInvoices]);

  // ── figures ──
  const trueNetEnabled = !!stats?.true_net_enabled;
  const isAll = range.kind === "all";
  const shownAll = shownRange?.kind === "all";
  const ready = shownAll ? !!stats : !!series;

  const cur = series?.cur.sums;
  const before = series?.prevSame.sums;
  const revenue = shownAll ? (stats?.revenue_all_time ?? 0) : cur?.revenue ?? null;
  const profit = shownAll ? (stats?.profit_all_time ?? 0) : cur?.profit ?? null;
  const trueNet = shownAll ? (stats?.true_net_all_time ?? 0) : cur?.trueNet ?? null;
  const shipping = shownAll ? (stats?.shipping_all_time ?? 0) : cur?.shipping ?? 0;
  const fees = shownAll ? (stats?.fees_all_time ?? 0) : cur?.fees ?? 0;
  const revDelta = !shownAll && cur && before ? pctChange(cur.revenue, before.revenue) : null;
  const profDelta = !shownAll && cur && before ? pctChange(cur.profit, before.profit) : null;
  const netDelta = !shownAll && cur && before ? pctChange(cur.trueNet, before.trueNet) : null;

  const sr = shownRange;
  const isMonth = sr?.kind === "month";
  const isCurMonth = !!(isMonth && sr && sameMonth(sr.start, today));
  const vsText = !series || !sr ? "" : isMonth ? `vs ${monthName(series.prevStart)}${isCurMonth ? " to date" : ""}` : `vs the ${series.n} days before`;
  const onText = vsText.replace(/^vs /, "on ");
  const prevName = !series || !sr ? "Period before" : isMonth ? `${monthName(series.prevStart)}${isCurMonth ? ", same days" : ""}` : `The ${series.n} days before`;

  const rangeLabel = isAll ? "All time"
    : range.kind === "month" ? (sameMonth(range.start, today) ? "This month" : range.start.toLocaleDateString("en-US", { month: "long", year: "numeric" }))
    : range.kind === "days" ? `Last ${range.n} days` : "Custom dates";
  const rangeDates = isAll ? "Since the start" : `${short(range.start)} to ${short(range.end)}, ${range.end.getFullYear()}`;

  // ── the chart ──
  const metric: Metric = chartMetric === "revenue" ? "revenue" : trueNetEnabled ? "trueNet" : "profit";
  const metricName = metric === "revenue" ? "Revenue" : metric === "trueNet" ? "True net" : "Profit";
  const allMonths = useMemo(() => [...(stats?.monthly_profit ?? [])].sort((a, b) => a.month.localeCompare(b.month)), [stats]);
  const chart = useMemo(() => {
    if (shownAll) {
      let t = 0;
      const vals = allMonths.map((r) => (t += metric === "revenue" ? r.revenue : metric === "trueNet" ? r.true_net : r.profit));
      return { values: vals, total: Math.max(1, vals.length), prev: undefined as number[] | undefined,
        label: (i: number) => { const m = allMonths[i]?.month; return m ? new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : ""; },
        tip: (i: number) => { const m = allMonths[i]?.month; return m ? new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : ""; } };
    }
    if (!series || !sr) return { values: [] as number[], total: 1, prev: undefined as number[] | undefined, label: () => "", tip: () => "" };
    return { values: series.cur[metric], total: series.n, prev: series.prev[metric],
      label: (i: number) => short(addDays(sr.start, i)), tip: (i: number) => long(addDays(sr.start, i)) };
  }, [shownAll, allMonths, series, sr, metric]);
  const chartTotal = chart.values.length ? chart.values[chart.values.length - 1] : 0;
  const chartBig = scrub !== null && scrub < chart.values.length ? chart.values[scrub] : chartTotal;
  const chartDelta = !shownAll && series && series.prevSame[metric].length
    ? pctChange(series.cur[metric][series.cur[metric].length - 1] ?? 0, series.prevSame[metric][series.prevSame[metric].length - 1] ?? 0) : null;
  const chartTitle = shownAll ? `${metricName} added up, by month`
    : sr ? `${metricName} added up, ${short(sr.start)} to ${short(sr.end)}` : metricName;

  // ── what the range paid out ──
  const costs = revenue !== null && profit !== null ? Math.max(0, revenue - profit) : 0;
  const overhead = Math.max(0, shipping + fees);
  const netPart = trueNet !== null ? Math.max(0, trueNet) : 0;
  const parts = costs + overhead + netPart;

  // ── client ticks ──
  const totalClients = stats?.total_clients ?? stats?.clients ?? 0;
  const openDeals = stats?.open_deals ?? 0;
  const completedThisMonth = stats?.completed_this_month ?? 0;
  const bought = useMemo(() => {
    const since = localDay(addDays(today, -90));
    const ids = new Set<string>();
    allInvoices.forEach((i) => { if (!i.voided && (i.issue_date || "").slice(0, 10) >= since) ids.add(i.client_id); });
    return ids.size;
  }, [allInvoices, today]);
  const boughtShare = totalClients > 0 ? Math.min(1, bought / totalClients) : 0;

  // ── deals closed ──
  const heat = useMemo(() => {
    const by = new Map<string, { n: number; profit: number }>();
    (heatDeals?.deals ?? []).forEach((d) => {
      const x = by.get(d.completed_on) ?? { n: 0, profit: 0 };
      x.n += 1; x.profit += d.net_profit; by.set(d.completed_on, x);
    });
    const cells: HeatCell[] = Array.from({ length: HEAT_DAYS }, (_, i) => {
      const d = addDays(heatStart, i), x = by.get(localDay(d));
      return { d, n: d > today ? -1 : x?.n ?? 0, profit: x?.profit ?? 0 };
    });
    const closed = cells.reduce((s, c) => s + Math.max(0, c.n), 0);
    const peak = cells.reduce<HeatCell | null>((b, c) => (c.n > (b?.n ?? 0) ? c : b), null);
    return { cells, closed, peak };
  }, [heatDeals, heatStart, today]);
  const heatChange = heatBefore ? (heat.closed - heatBefore) / heatBefore : null;
  const hc = heatHover !== null ? heat.cells[heatHover] : null;
  const heatLine = hc
    ? `${long(hc.d)}${hc.n > 0 ? `: ${hc.n} ${hc.n === 1 ? "deal" : "deals"}, ${fmtAmount(hc.profit)} profit` : ": none closed"}`
    : "Point at a day to see what closed";

  // ── money in, linked ──
  const linkedIn = overview?.allocated_actuals?.buyer_in ?? 0;
  const linkedFraction = unlinkedIn !== null && linkedIn + unlinkedIn > 0 ? linkedIn / (linkedIn + unlinkedIn) : null;

  // ── tax set aside ──
  const ovx = overview as (FinancialsOverview & {
    reserve_account_key?: string; reserve_account_linked?: boolean; reserve_parked?: number; reserve_shortfall?: number;
    tax_sweep_pct?: number; tax_should_have?: number;
  }) | null;
  const reserveLinked = !!ovx?.reserve_account_key && ovx?.reserve_account_linked !== false;
  const reserveTotal = ovx ? ovx.tax_reserve + ovx.refund_reserve : 0;
  const shortfall = ovx?.reserve_shortfall ?? reserveTotal;

  // ── needs attention ──
  const overdueAmt   = ar ? ar.summary.total - ar.summary.current : 0;
  const overdueCount = ar ? ar.items.filter((i) => i.days_overdue > 0).length : 0;
  const shippingCount = stats?.incomplete_shipping ?? 0;
  const billRow = alertRow(billAlerts);
  const loadSets = loads ? dashboardLoads(loads, localDay(today)) : null;
  const carrierCount = loadSets ? loadSets.carrier.length : 0;
  const loadGroups = loadSets ? loadSets.arriving.length + loadSets.shipping.length + loadSets.carrier.length : 0;
  const toLink = ovx?.alerts?.stale_unallocated_in ?? 0;
  const attention = [
    { key: "link", show: showBills && toLink > 0, icon: Link2, label: "Payments to link", n: toLink, to: "financials" },
    { key: "overdue", show: showMoney && overdueCount > 0, icon: DollarSign, label: "Invoices overdue", n: overdueCount, urgent: true, to: "invoices", sub: `${fmtAmount(overdueAmt)} to chase first` },
    { key: "carriers", show: carrierCount > 0, icon: Truck, label: "Carriers to pay", n: carrierCount, to: "logistics" },
    { key: "ship", show: shippingCount > 0, icon: Package, label: "Invoices need shipping info", n: shippingCount, to: "invoices", sub: "Carrier and tracking close them out" },
    { key: "bills", show: !!billRow, icon: Receipt, label: billRow?.title ?? "", n: (billAlerts?.overdue_count ?? 0) + (billAlerts?.due_soon_count ?? 0), urgent: billRow?.tone === "danger", to: "bills", sub: billRow?.sub },
    { key: "follow", show: followups.length > 0, icon: Clock, label: `Follow-up${followups.length !== 1 ? "s" : ""} due today`, n: followups.length, to: "clients",
      sub: followups.slice(0, 3).map((c) => c.name).join(", ") + (followups.length > 3 ? "..." : "") },
    { key: "new", show: pendingApprovals.length > 0, icon: UserPlus, label: "New customers to review", n: pendingApprovals.length, to: "approvals" },
  ].filter((a) => a.show);

  // ── header ──
  const first = (me?.display_name || "").trim().split(/\s+/)[0];
  const hour = new Date().getHours();
  const greeting = `Good ${hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}${first ? `, ${first}` : ""}`;
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const monthBase = range.kind === "month" ? range.start : new Date(today.getFullYear(), today.getMonth(), 1);
  const canForward = range.kind === "month" && !sameMonth(range.start, today);

  const headerActions = (
    <>
      {showMoney && (
        <div ref={menuRef} className="relative flex items-center gap-2">
          <Button icon={<ChevronLeft size={14} strokeWidth={1.75} />} onClick={() => showRange(monthRange(monthBase.getFullYear(), monthBase.getMonth() - 1))}>Go back a month</Button>
          {canForward && (
            <button className="ui-ib" aria-label="Go forward a month" title="Go forward a month"
              onClick={() => showRange(monthRange(monthBase.getFullYear(), monthBase.getMonth() + 1))}><ChevronRight size={14} strokeWidth={1.75} /></button>
          )}
          <Button aria-haspopup="true" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            {rangeLabel}<ChevronDown size={14} strokeWidth={1.75} className="text-muted" />
          </Button>
          {menuOpen && <RangeMenu range={range} today={today} onPick={showRange} />}
        </div>
      )}
      {showMoney && (
        <span className="ui-btn cursor-default select-none"><Calendar size={14} strokeWidth={1.75} />{rangeDates}</span>
      )}
      <Button icon={<GitBranch size={14} strokeWidth={1.75} />} onClick={() => onNavigate("dealflow")}>Deal Flow</Button>
    </>
  );

  const Divider = () => <div className="hsep" />;

  return (
    <div>
      {reviewClient && (
        <PendingReviewModal
          client={reviewClient}
          onClose={() => setReviewClient(null)}
          onResolved={() => { resolvedApproval(reviewClient.id); setReviewClient(null); }}
        />
      )}

      <PageHeader title={greeting} subtitle={dateStr} actions={headerActions} />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_1px_328px] xl:gap-x-2">
        {/* ── left: the numbers, the chart, loads, deals closed, recent invoices ── */}
        <div className="min-w-0">

          {/* New customers awaiting review: inline decisions. */}
          {pendingApprovals.length > 0 && (
            <>
              <section className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="m-0 text-[14px] font-medium text-ink">New customers to review</h2>
                  <span className="ui-count">{pendingApprovals.length}</span>
                </div>
                {pendingApprovals.slice(0, 4).map((c) => {
                  const initials = (c.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
                  return (
                    <div key={c.id} className="flex items-center gap-3 py-2.5">
                      <span className="w-8 h-8 rounded-full bg-surface-3 text-ink grid place-items-center text-[12px] font-medium flex-shrink-0">{initials}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-ink truncate">{c.name}</div>
                        <div className="text-[12px] text-muted truncate">New customer to review{c.email ? `, ${c.email}` : ""}</div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button size="sm" onClick={() => setReviewClient(c)}>Review</Button>
                        <Button size="sm" variant="ink" onClick={async () => { await api.approveClient(c.id); resolvedApproval(c.id); }}>Approve</Button>
                        <Button size="sm" variant="danger" onClick={async () => { await api.rejectClient(c.id); resolvedApproval(c.id); }}>Reject</Button>
                      </div>
                    </div>
                  );
                })}
                {pendingApprovals.length > 4 && (
                  <button className="ui-link muted mt-1" onClick={() => onNavigate("approvals")}>
                    {pendingApprovals.length - 4} more waiting for review<ArrowRight size={13} strokeWidth={1.75} />
                  </button>
                )}
              </section>
              <Divider />
            </>
          )}

          {showMoney && (
            <>
              {/* Revenue, Profit, Owed to you: no boxes, a fading rule between. */}
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
                <Kpi label="Revenue" value={ready ? revenue : null} format={fmtAmount}
                  delta={revDelta !== null ? pctText(revDelta) : undefined} tone={revDelta === null ? "flat" : revDelta >= 0 ? "up" : "down"}
                  caption={revDelta !== null ? vsText : shownAll ? "deals closed, all time" : undefined} />
                <div className="vsep hidden sm:block mt-4" />
                <Kpi label="Profit" value={ready ? profit : null} format={fmtAmount}
                  delta={profDelta !== null ? pctText(profDelta) : undefined} tone={profDelta === null ? "flat" : profDelta >= 0 ? "up" : "down"}
                  caption={profDelta !== null ? vsText : shownAll ? "deals closed, all time" : undefined} />
                <div className="vsep hidden sm:block mt-4" />
                <Kpi label="Owed to you" value={ar ? ar.summary.total : null} format={fmtAmount}
                  delta={ar && overdueAmt > 0 ? `${fmtAmount(overdueAmt)} late` : undefined} tone={ar && overdueAmt > 0 ? "down" : "flat"}
                  caption={ar ? `${ar.summary.open_count} ${ar.summary.open_count === 1 ? "invoice" : "invoices"}` : undefined} />
              </div>

              {/* The chart: running total for the range, the period before dashed. */}
              <div className="px-4 pt-6 pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="ui-fig">{ready ? fmtAmount(chartBig) : " "}</div>
                    <div className="ui-label mt-0.5">{chartTitle}</div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Tabs label="Chart shows" value={chartMetric} onChange={(id) => setChartMetric(id as "profit" | "revenue")}
                      tabs={[{ id: "profit", label: trueNetEnabled ? "True net" : "Profit" }, { id: "revenue", label: "Revenue" }]} />
                    {!shownAll && chartDelta !== null && (
                      <div className="text-right">
                        <span className={`ui-delta ${chartDelta >= 0 ? "up" : "down"}`}>{chartDelta >= 0 ? "Up " : "Down "}{pctText(chartDelta)}</span>
                        <span className="ui-note"> {vsText}</span>
                        <div className="ui-note mt-1 flex items-center justify-end gap-1.5">
                          <span className="inline-block w-3.5 border-t-[1.5px] border-dashed border-faint" />{prevName}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-5">
                  <MonoAreaChart values={chart.values} total={chart.total} prev={chart.prev}
                    label={chart.label} tipLabel={chart.tip} format={fmtAmount} formatAxis={(v) => `$${compact(v)}`}
                    seriesName={`${metricName} so far`} prevName={prevName} height={206}
                    ariaLabel={`${chartTitle}. Use the left and right arrow keys to move along it.`}
                    onScrub={setScrub} />
                </div>
                {ready && chart.values.length === 0 && (
                  <p className="m-0 mt-2 text-[13px] text-muted">{shownAll ? "No closed deals yet." : "No closed deals in this range yet."}</p>
                )}
              </div>

              <Divider />

              {/* True net and where the money went. */}
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] md:gap-x-2">
                <div className="p-4 md:pl-6">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-[14px] font-medium text-ink"><TrendingUp size={16} strokeWidth={1.75} />{shownAll ? "All time" : rangeLabel}</span>
                    <button className="ui-link muted" onClick={() => onNavigate("brief")}>Open Brief</button>
                  </div>
                  <p className="m-0 mt-5 text-[18px] leading-7 text-muted">
                    {!ready ? " "
                      : shownAll ? <>Profit since the start is <span className="font-medium text-ink">{fmtAmount(profit ?? 0)}</span>.</>
                      : profDelta === null ? <>Nothing closed before this range to compare it with.</>
                      : <>Profit is {profDelta >= 0 ? "up" : "down"} by <span className="font-medium text-ink">{pctText(profDelta)}</span> {onText}.</>}
                  </p>
                  <div className="mt-5">
                    <div className="ui-label">True net</div>
                    <div className={`ui-fig mt-1 ${trueNet !== null && trueNet < 0 ? "text-danger-ink" : ""}`}>{ready ? fmtAmount(trueNet ?? 0) : " "}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5">
                      {netDelta !== null && <span className={`ui-delta ${netDelta >= 0 ? "up" : "down"}`}>{netDelta >= 0 ? "Up " : "Down "}{pctText(netDelta)}</span>}
                      <span className="ui-note tabular-nums">after {fmtAmount(shipping)} shipping and {fmtAmount(fees)} bank and wire fees</span>
                    </div>
                  </div>
                </div>
                <div className="vsep hidden md:block mt-4" />
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="ui-label">Where the money went</div>
                      <div className="ui-fig mt-1">{ready ? fmtAmount(revenue ?? 0) : " "}</div>
                    </div>
                    {showBills && <button className="ui-link muted" onClick={() => onNavigate("financials")}>Open Money</button>}
                  </div>
                  {ready && parts > 0 ? (
                    <>
                      <div className="flex gap-1 mt-5">
                        {[
                          { v: costs, bg: "var(--heat-2)" },
                          { v: overhead, bg: "var(--heat-1)" },
                          { v: netPart, bg: "var(--chart-hi)" },
                        ].map((p, i) => p.v > 0 && (
                          <div key={i} style={{ flex: `${p.v} 0 0`, minWidth: 0 }}>
                            <div className="ui-note mb-1.5 h-[18px] whitespace-nowrap">{p.v / parts >= 0.08 ? `${Math.round((p.v / parts) * 100)}%` : ""}</div>
                            <div className="h-3 rounded" style={{ background: p.bg }} />
                          </div>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[12px] text-muted">
                        <span>Costs <span className="text-ink tabular-nums">{fmtAmount(costs)}</span></span>
                        <span>Shipping and fees <span className="text-ink tabular-nums">{fmtAmount(overhead)}</span></span>
                        <span>True net <span className="text-ink tabular-nums">{fmtAmount(trueNet ?? 0)}</span></span>
                      </div>
                    </>
                  ) : ready ? (
                    <p className="m-0 mt-5 text-[13px] text-muted">Nothing closed in this range yet.</p>
                  ) : null}
                </div>
              </div>

              <Divider />
            </>
          )}

          {/* R-483: the loads waiting on shipping and on the carrier's pay, right under the numbers. */}
          {loadGroups > 0 && (
            <>
              <div className="p-4"><DashboardLoads list={loads} /></div>
              <Divider />
            </>
          )}

          {showMoney && (
            <>
              {/* Deals closed, a dot a day for 31 weeks. */}
              <section className="px-4 pt-5 pb-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="ui-fig">{heatDeals ? heat.closed.toLocaleString() : " "}</div>
                    <div className="ui-label mt-0.5">Deals closed since {heatStart.toLocaleDateString("en-US", { month: "long" })}</div>
                  </div>
                  {heatDeals && (
                    <div className="text-right">
                      {heat.peak && heat.peak.n > 0 && (
                        <div className="ui-note">Peak <span className="font-medium text-ink">{heat.peak.n}</span> on <span className="font-medium text-ink">{short(heat.peak.d)}</span></div>
                      )}
                      {heatChange !== null && (
                        <div className="mt-1">
                          <span className={`ui-delta ${heatChange >= 0 ? "up" : "down"}`}>{heatChange >= 0 ? "+" : "-"}{Math.abs(Math.round(heatChange * 100))}%</span>
                          <span className="ui-note"> over the {WEEKS} weeks before</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <HeatGrid cells={heat.cells} onHover={setHeatHover} />
                <div className="flex flex-wrap items-center justify-between gap-2.5 mt-3 text-[12px] text-muted">
                  <span>{heatLine}{heatDeals?.capped ? ". Showing the most recent 300 deals." : ""}</span>
                  <span className="flex items-center gap-1">
                    None
                    {HEAT_LVL.map((c, i) => <span key={i} className="w-2.5 h-2.5 rounded-[3px]" style={{ background: c }} />)}
                    3 or more
                  </span>
                </div>
              </section>

              <Divider />

              {/* Recent invoices. */}
              <section className="p-4">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <h2 className="m-0 text-[14px] font-medium text-ink">Recent invoices</h2>
                  <button className="ui-link muted" onClick={() => onNavigate("invoices")}>View all</button>
                </div>
                {recentInvoices.length === 0 ? (
                  <div className="py-8 flex flex-col items-start gap-2">
                    <p className="m-0 text-[14px] text-muted">No invoices yet</p>
                    <button className="ui-link" onClick={() => onNavigate("invoices")}>Create your first invoice</button>
                  </div>
                ) : (
                  <table className="ui-table ui-table-click">
                    <thead>
                      <tr><th>Client</th><th>Due</th><th>Status</th><th className="!text-right">Total</th></tr>
                    </thead>
                    <tbody>
                      {recentInvoices.map((inv) => {
                        // R-490/R-491: what each one is for, as on the Invoices screen and the phone's Home; a row opens its invoice.
                        const goods = parseLineItems(inv.line_items_json).map((it) => (it.description || "").trim()).filter((d) => d && !isNoiseItem(d));
                        return (
                          <tr key={inv.id} tabIndex={0}
                            onClick={() => { try { localStorage.setItem("invoices_open_id", inv.id); } catch { /* storage blocked: Invoices just opens */ } onNavigate("invoices"); }}
                            onKeyDown={(e) => { if (e.key === "Enter") { try { localStorage.setItem("invoices_open_id", inv.id); } catch { /* ignore */ } onNavigate("invoices"); } }}>
                            <td className="min-w-0 max-w-[320px]">
                              <div className="text-[14px] font-medium text-ink truncate">{clientName(inv.client_id)}</div>
                              {goods.length > 0 && (
                                <div className="text-[13px] text-ink-2 truncate">{goods.slice(0, 2).join(", ")}{goods.length > 2 ? ` and ${goods.length - 2} more` : ""}</div>
                              )}
                              <div className="text-[12px] text-muted truncate"><span className="font-mono">{inv.number}</span></div>
                            </td>
                            <td className="text-[13px] text-muted whitespace-nowrap tabular-nums">{inv.due_date.slice(0, 10)}</td>
                            <td><StatusPill tone={invStatusTone(inv.status)}>{invStatusLabel(inv.status)}</StatusPill></td>
                            <td className="r font-medium text-ink"><CompactAmount value={inv.total} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </section>

              <Divider />
            </>
          )}

          {/* ── Quick actions ── */}
          <div className="flex flex-wrap items-center gap-2 p-4">
            <Button icon={<Users size={14} strokeWidth={1.75} />} onClick={() => onNavigate("clients")}>Add client</Button>
            {/* Only surface the invoice action to users who can see the money. */}
            {showMoney && <Button variant="ink" icon={<FileText size={14} strokeWidth={1.75} />} onClick={() => onNavigate("invoices")}>New invoice</Button>}
            <Button icon={<Mail size={14} strokeWidth={1.75} />} onClick={() => onNavigate("newsletter")}>Newsletter</Button>
          </div>
        </div>

        <div className="vsep hidden xl:block" />

        {/* ── right: money in linked, clients, tax set aside, needs attention ── */}
        <div className="min-w-0 mt-6 xl:mt-0">
          {showBills && linkedFraction !== null && (
            <>
              <div className="p-4 text-center">
                <div className="relative w-[248px] h-[214px] mx-auto">
                  <Gauge fraction={linkedFraction} />
                  <div className="absolute inset-x-0" style={{ top: 86 }}>
                    <Link2 size={18} strokeWidth={1.75} className="mx-auto text-muted" />
                    <div className="ui-label mt-1.5">Money in, linked</div>
                    <div className="text-[14px] font-medium tabular-nums mt-0.5" style={{ letterSpacing: "-0.35px" }}>{fmtAmount(linkedIn)}</div>
                  </div>
                </div>
                <div className="flex justify-center gap-4 text-[12px] text-muted mt-1">
                  <span><span className="text-ink">{Math.round(linkedFraction * 100)}%</span> on a deal</span>
                  <span><span className="text-ink tabular-nums">{fmtAmount(unlinkedIn ?? 0)}</span> not linked</span>
                </div>
                <Button block className="mt-4" onClick={() => onNavigate("financials")}>Link the rest<ArrowRight size={14} strokeWidth={1.75} /></Button>
              </div>
              <Divider />
            </>
          )}

          {/* Clients, and the counts everyone sees. */}
          <div className="p-4">
            <div className="ui-label">Clients</div>
            <button className="ui-fig block mt-0.5 text-left hover:opacity-70 transition-opacity duration-[150ms]" onClick={() => onNavigate("clients")}>
              {stats ? <CountInt value={totalClients} /> : " "}
            </button>
            {showMoney && totalClients > 0 && allInvoices.length > 0 && (
              <>
                <ClientTicks fraction={boughtShare} label={`${bought} of ${totalClients} clients ordered in the last 90 days`} />
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[12px] text-muted">
                  <span><span className="text-ink tabular-nums">{bought}</span> ordered in 90 days</span>
                  <span><span className="text-ink tabular-nums">{Math.max(0, totalClients - bought)}</span> quiet</span>
                </div>
              </>
            )}
            <div className="mt-3">
              <button className="ui-kv w-full text-left hover:opacity-70 transition-opacity duration-[150ms]" onClick={() => onNavigate("dealflow")}>
                <span>Open deals</span><span className="text-ink">{stats ? openDeals.toLocaleString() : ""}</span>
              </button>
              <button className="ui-kv w-full text-left hover:opacity-70 transition-opacity duration-[150ms]" onClick={() => onNavigate("completed")}>
                <span>Completed this month</span><span className="text-ink">{stats ? completedThisMonth.toLocaleString() : ""}</span>
              </button>
            </div>
          </div>

          <Divider />

          {showBills && ovx && (
            <>
              <div className="p-4">
                <div className="ui-label mb-2.5">Tax set aside</div>
                <div className="ui-kv"><span>Tax at {Math.round((ovx.tax_sweep_pct ?? 0.3) * 100)}% of net</span><span>{fmtAmount(ovx.tax_should_have ?? ovx.tax_reserve)}</span></div>
                <div className="ui-kv"><span>Refunds</span><span>{fmtAmount(ovx.refund_reserve)}</span></div>
                {reserveLinked && <div className="ui-kv"><span>In savings</span><span>{fmtAmount(ovx.reserve_parked ?? 0)}</span></div>}
                <div className="ui-kv items-center">
                  <span>Status</span>
                  {reserveLinked
                    ? (shortfall > 0.005 ? <StatusPill tone="danger">{fmtAmount(shortfall)} short</StatusPill> : <StatusPill tone="success">Covered</StatusPill>)
                    : <StatusPill>No savings account set</StatusPill>}
                </div>
                <Button block className="mt-3.5" onClick={() => onNavigate("financials")}>View details<ArrowRight size={14} strokeWidth={1.75} /></Button>
              </div>
              <Divider />
            </>
          )}

          <div className="p-4">
            <div className="ui-label mb-2">Needs attention</div>
            {attention.length === 0 ? (
              <p className="m-0 px-3 py-3 text-[13px] text-muted">All clear, nothing needs you right now</p>
            ) : (
              attention.map((a) => (
                <AttentionRow key={a.key} icon={a.icon} label={a.label} sub={a.sub} n={a.n} urgent={a.urgent} onClick={() => onNavigate(a.to)} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
