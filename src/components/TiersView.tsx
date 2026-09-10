import { useEffect, useRef, useState } from "react";
import { api, BuyerTier } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, Layers, ArrowLeftRight, ArrowUp, ArrowDown } from "lucide-react";
import TierBadge from "./TierBadge";
import ReliabilityBadge from "./ReliabilityBadge";
import ClientDetailView from "./ClientDetailView";

const SPEND_RANGES = [
  { label: "All",           min: 0,     max: Infinity },
  { label: "$0",            min: 0,     max: 0 },
  { label: "$1 – $999",     min: 1,     max: 999 },
  { label: "$1k – $4.9k",   min: 1000,  max: 4999 },
  { label: "$5k – $9.9k",   min: 5000,  max: 9999 },
  { label: "$10k – $49.9k", min: 10000, max: 49999 },
  { label: "$50k+",         min: 50000, max: Infinity },
];

// Profit can be negative once refunds are netted out, so this ladder is not the
// spend one with different labels — it needs a loss bucket at the bottom.
const PROFIT_RANGES = [
  { label: "Any profit",     min: -Infinity, max: Infinity },
  { label: "At a loss",      min: -Infinity, max: -0.01 },
  { label: "None",           min: 0,         max: 0 },
  { label: "$1 – $999",      min: 1,         max: 999 },
  { label: "$1k – $4.9k",    min: 1000,      max: 4999 },
  { label: "$5k – $24.9k",   min: 5000,      max: 24999 },
  { label: "$25k+",          min: 25000,     max: Infinity },
];

const FREQUENCIES = ["weekly", "bi-weekly", "monthly", "quarterly", "annually"];

const TIER_ORDER = ["P", "S", "A", "B", "C", "Prospect"];

// R-252: deals-landed / reliability / last-active / margin filters.
const DEALS_LANDED_OPTIONS = [
  { key: "any", label: "Any deals landed", min: 0 },
  { key: "1",   label: "1+ deals landed",  min: 1 },
  { key: "3",   label: "3+ deals landed",  min: 3 },
  { key: "6",   label: "6+ deals landed",  min: 6 },
  { key: "12",  label: "12+ deals landed", min: 12 },
  { key: "25",  label: "25+ deals landed", min: 25 },
];

const RELIABILITY_OPTIONS = [
  { key: "any",      label: "Any reliability" },
  { key: "reliable", label: "Reliable" },
  { key: "mixed",    label: "Mixed" },
  { key: "low",      label: "Low" },
  { key: "unrated",  label: "Unrated" },
];

const LAST_ACTIVE_OPTIONS = [
  { key: "any",   label: "Any time" },
  { key: "30",    label: "Last 30 days" },
  { key: "90",    label: "Last 90 days" },
  { key: "182",   label: "Last 6 months" },
  { key: "365",   label: "Last year" },
  { key: "over",  label: "Over a year ago" },
  { key: "never", label: "Never invoiced" },
];

const MARGIN_OPTIONS = [
  { key: "any",     label: "Any margin" },
  { key: "under10", label: "Under 10%" },
  { key: "10-25",   label: "10 – 25%" },
  { key: "25plus",  label: "25%+" },
];

const SORT_OPTIONS: { key: string; label: string }[] = [
  { key: "default",    label: "Default" },
  { key: "name",       label: "Name" },
  { key: "tier",       label: "Tier" },
  { key: "paid",       label: "Actually paid" },
  { key: "profit",     label: "Profit" },
  { key: "deals",      label: "Deals landed" },
  { key: "avgDeal",    label: "Avg deal" },
  { key: "cadence",    label: "Cadence" },
  { key: "margin",     label: "Margin" },
  { key: "lastActive", label: "Last active" },
];

// Measured purchase cadence -> the same five buckets the frequency filter uses.
function cadenceBucket(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 10) return "weekly";
  if (days <= 20) return "bi-weekly";
  if (days <= 45) return "monthly";
  if (days <= 135) return "quarterly";
  return "annually";
}

// Days since last_invoice_date. Defensive: the date can be null and can carry a time part.
function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}

function dealsLandedMin(key: string): number {
  return DEALS_LANDED_OPTIONS.find((o) => o.key === key)?.min ?? 0;
}

function lastActiveMatches(dateStr: string | null, key: string): boolean {
  if (key === "any") return true;
  if (key === "never") return daysSince(dateStr) == null;
  const d = daysSince(dateStr);
  if (d == null) return false;
  if (key === "30") return d <= 30;
  if (key === "90") return d <= 90;
  if (key === "182") return d <= 182;
  if (key === "365") return d <= 365;
  if (key === "over") return d > 365;
  return true;
}

function marginMatches(pct: number, key: string): boolean {
  if (key === "any") return true;
  if (key === "under10") return pct < 10;
  if (key === "10-25") return pct >= 10 && pct < 25;
  if (key === "25plus") return pct >= 25;
  return true;
}

function sortValue(t: BuyerTier, key: string): number | string {
  switch (key) {
    case "name":       return t.client_name.toLowerCase();
    case "tier":       return TIER_ORDER.indexOf(t.tier);
    case "paid":       return t.actual_paid;
    case "profit":     return t.total_profit;
    case "deals":      return t.deals_landed;
    case "avgDeal":    return t.avg_deal_value;
    case "cadence":    return t.purchase_cadence_days ?? Infinity;
    case "margin":     return t.avg_commission_pct;
    case "lastActive": return daysSince(t.last_invoice_date) ?? Infinity;
    default:           return 0;
  }
}

// R-251: money/frequency column toggles (avg deal <-> avg profit, per-deal <-> per-month).
const DAYS_PER_MONTH = 30.44; // mean calendar days per month

function dealsPerMonth(cadenceDays: number | null): number | null {
  return cadenceDays != null ? DAYS_PER_MONTH / cadenceDays : null;
}

function tierMoney(
  t: BuyerTier,
  moneyMode: "revenue" | "profit",
  periodMode: "deal" | "month"
): number | null {
  const n = t.deals_landed;
  const avgProfit = n > 0 ? t.total_profit / n : 0;
  const money = moneyMode === "profit" ? avgProfit : t.avg_deal_value;
  if (periodMode === "month") {
    const dpm = dealsPerMonth(t.purchase_cadence_days);
    return dpm != null ? money * dpm : null;
  }
  return n > 0 ? money : null;
}

// R-252: the spinning-digit odometer for the money/frequency columns. A full 0-9
// rotation is unreadable at the house 130ms hover/swap-icon duration, so the roll
// gets a deliberate one-off exception at 380ms ease-out — every other transition
// on this screen (hover, the swap icon, colour) stays at 130ms.
const ODOMETER_ROLL_MS = 380;
const EM_DASH = "—";

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// One rolling digit: a 1em window over a 20-cell strip (the digits 0-9 twice, stacked).
// Rolling means resetting instantly (no transition) to the TARGET digit's first copy,
// forcing a reflow, then transitioning down exactly 10em to the target's second copy —
// always a full cycle that lands back on the same digit, regardless of what showed before.
function OdometerDigit({ digit, roll, delayMs }: { digit: number; roll: boolean; delayMs: number }) {
  const stripRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    if (!roll) {
      el.style.transition = "none";
      el.style.transitionDelay = "0ms";
      el.style.transform = `translateY(-${digit}em)`;
      return;
    }
    el.style.transition = "none";
    el.style.transform = `translateY(-${digit}em)`;
    void el.offsetHeight; // force reflow so the instant reset above isn't merged into the transition
    el.style.transition = `transform ${ODOMETER_ROLL_MS}ms ease-out`;
    el.style.transitionDelay = `${delayMs}ms`;
    el.style.transform = `translateY(-${digit + 10}em)`;
  }, [digit, roll, delayMs]);

  return (
    <span className="odometer-window" aria-hidden="true">
      {/* R-257: the in-flow ghost gives the window this digit's real width and baseline. */}
      <span className="odometer-ghost">{digit}</span>
      <span className="odometer-clip">
        <span ref={stripRef} className="odometer-strip" style={{ transform: `translateY(-${digit}em)` }}>
          {Array.from({ length: 20 }, (_, i) => <span key={i}>{i % 10}</span>)}
        </span>
      </span>
    </span>
  );
}

// Renders `value` with each 0-9 character as a rolling OdometerDigit; everything else
// ($ , . space letters -) is a plain static span. `roll` comes from the parent and is true
// only on the render caused by a toggle click — so a digit that appears mid-flip (the value
// gained or lost a digit) rolls with its neighbours, while a filter change never rolls
// anything. An em-dash never rolls, and prefers-reduced-motion renders the plain string.
//
// The strips are aria-hidden because each literally contains 0-9 twice; `odometer-value`
// carries the real number for assistive tech and for anyone selecting the cell.
function Odometer({ value, roll, rowDelayMs }: { value: string; roll: boolean; rowDelayMs: number }) {
  if (value === EM_DASH || reducedMotion()) return <>{value}</>;
  let digitIdx = 0;
  return (
    <>
      <span className="odometer-value">{value}</span>
      {value.split("").map((ch, i) => {
        if (ch >= "0" && ch <= "9") {
          const delayMs = rowDelayMs + Math.min(digitIdx * 40, 240);
          digitIdx += 1;
          return <OdometerDigit key={i} digit={Number(ch)} roll={roll} delayMs={delayMs} />;
        }
        return <span key={i} aria-hidden="true">{ch}</span>;
      })}
    </>
  );
}

const selectCls =
  "border border-line h-8 px-2.5 rounded-lg text-[12px] text-ink-2 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function TiersView() {
  const [tiers, setTiers]     = useState<BuyerTier[]>([]);
  const [selectedTiers, setSelectedTiers] = useState<string[]>([]);
  const [search, setSearch]   = useState("");
  const [sortBy, setSortBy]   = useState("default");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [paidRange, setPaidRange]     = useState(0);
  const [profitRange, setProfitRange] = useState(0);
  const [spendRange, setSpendRange]   = useState(0);
  const [freqFilter, setFreqFilter]   = useState("");
  const [dealsFilter, setDealsFilter] = useState("any");
  const [reliabilityFilter, setReliabilityFilter] = useState("any");
  const [lastActiveFilter, setLastActiveFilter]   = useState("any");
  const [marginFilter, setMarginFilter] = useState("any");
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  const [moneyMode, setMoneyMode] = useState<"revenue" | "profit">("revenue");
  const [periodMode, setPeriodMode] = useState<"deal" | "month">("deal");
  const [flipSeq, setFlipSeq] = useState(0);
  const toggleMoney = () => { setMoneyMode((m) => (m === "revenue" ? "profit" : "revenue")); setFlipSeq((s) => s + 1); };
  const togglePeriod = () => { setPeriodMode((p) => (p === "deal" ? "month" : "deal")); setFlipSeq((s) => s + 1); };

  // True only on the render a toggle caused. The digits read this rather than comparing
  // their own previous value, so a digit that mounts mid-flip rolls with the rest — and a
  // digit that mounts because a filter changed the visible rows stays still.
  const rolledSeq = useRef(0);
  const isRollRender = flipSeq !== rolledSeq.current;
  useEffect(() => { rolledSeq.current = flipSeq; });

  const load = async () => {
    setLoading(true);
    try { setTiers(await api.buyerTiers()); } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const toggleTier = (t: string) => {
    setSelectedTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const filtered = tiers
    .filter((t) => selectedTiers.length === 0 || selectedTiers.includes(t.tier))
    .filter((t) => !search.trim() || t.client_name.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((t) => {
      if (paidRange === 0) return true;
      const r = SPEND_RANGES[paidRange];
      return t.actual_paid >= r.min && t.actual_paid <= r.max;
    })
    .filter((t) => {
      if (profitRange === 0) return true;
      const r = PROFIT_RANGES[profitRange];
      return t.total_profit >= r.min && t.total_profit <= r.max;
    })
    .filter((t) => {
      if (spendRange === 0) return true;
      const range = SPEND_RANGES[spendRange];
      return t.avg_deal_value >= range.min && t.avg_deal_value <= range.max;
    })
    .filter((t) => !freqFilter || cadenceBucket(t.purchase_cadence_days) === freqFilter)
    .filter((t) => t.deals_landed >= dealsLandedMin(dealsFilter))
    .filter((t) => reliabilityFilter === "any" || t.reliability === reliabilityFilter)
    .filter((t) => lastActiveMatches(t.last_invoice_date, lastActiveFilter))
    .filter((t) => marginMatches(t.avg_commission_pct, marginFilter));

  // Default order (tier rank, then actual_paid desc, then invoices_sent desc) is whatever
  // the API already returns — nothing moves unless "Sort by" is actively changed.
  const sorted = sortBy === "default" ? filtered : [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    const av = sortValue(a, sortBy);
    const bv = sortValue(b, sortBy);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  const anyFilter = selectedTiers.length > 0 || !!search.trim() || paidRange > 0 || profitRange > 0 || spendRange > 0 ||
    !!freqFilter || dealsFilter !== "any" || reliabilityFilter !== "any" || lastActiveFilter !== "any" || marginFilter !== "any" ||
    sortBy !== "default";
  const clearFilters = () => {
    setSelectedTiers([]); setSearch(""); setPaidRange(0); setProfitRange(0); setSpendRange(0); setFreqFilter("");
    setDealsFilter("any"); setReliabilityFilter("any"); setLastActiveFilter("any"); setMarginFilter("any");
    setSortBy("default"); setSortDir("desc");
  };

  const tierCount = (t: string) => tiers.filter((x) => x.tier === t).length;

  const moneyHeaderLabel =
    periodMode === "month"
      ? moneyMode === "profit" ? "Profit / mo" : "Revenue / mo"
      : moneyMode === "profit" ? "Profit" : "Revenue";

  if (detailId) return <ClientDetailView clientId={detailId} onBack={() => setDetailId(null)} />;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Client tiers</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Ranked by actual purchasing history.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 px-2.5 py-1.5 rounded-lg hover:bg-surface-3 transition-colors mt-0.5"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients"
          className="h-8 px-3 rounded-lg text-[12px] text-ink bg-surface border border-line placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors w-48"
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={selectCls}>
          {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.key === "default" ? "Sort: default" : `Sort: ${o.label}`}</option>)}
        </select>
        {sortBy !== "default" && (
          <button
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            title={sortDir === "asc" ? "Ascending" : "Descending"}
            className={`${selectCls} px-2 text-ink-2 hover:text-ink`}
          >
            {sortDir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          </button>
        )}
      </div>

      {/* Tier summary cards — desktop tier control (multi-select) */}
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3 my-5">
        {TIER_ORDER.map((t) => {
          const count = tierCount(t);
          const active = selectedTiers.includes(t);
          return (
            <button
              key={t}
              onClick={() => toggleTier(t)}
              className={`bg-surface border rounded-xl p-3.5 text-left transition-shadow hover:shadow-[0_4px_12px_rgba(0,0,0,0.07)] ${
                active ? "ring-2 ring-accent/50 border-accent/20" : "border-line"
              }`}
            >
              <div className="mb-2.5">
                <TierBadge tier={t} size="sm" />
              </div>
              <div className="text-[22px] font-bold text-ink tabular-nums leading-none">{count}</div>
              <div className="text-[10px] text-muted mt-1">clients</div>
            </button>
          );
        })}
      </div>


      {/* Filters — range/enum selects */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setSelectedTiers([])}
          className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
            selectedTiers.length === 0 ? "bg-accent text-on-accent" : "bg-surface border border-line text-ink-2 hover:border-line-3"
          }`}
        >
          All tiers
        </button>

        <div className="h-4 w-px bg-surface-3 mx-1" />

        <select value={paidRange} onChange={(e) => setPaidRange(Number(e.target.value))} className={selectCls}>
          {SPEND_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? "Any spend" : `Spent ${r.label}`}</option>
          ))}
        </select>

        <select value={profitRange} onChange={(e) => setProfitRange(Number(e.target.value))} className={selectCls}>
          {PROFIT_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? r.label : `Profit ${r.label}`}</option>
          ))}
        </select>

        <select value={spendRange} onChange={(e) => setSpendRange(Number(e.target.value))} className={selectCls}>
          {SPEND_RANGES.map((r, i) => (
            <option key={i} value={i}>{i === 0 ? "Any avg deal" : `Avg deal ${r.label}`}</option>
          ))}
        </select>

        <select value={freqFilter} onChange={(e) => setFreqFilter(e.target.value)} className={selectCls}>
          <option value="">Any frequency</option>
          {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>

        <select value={dealsFilter} onChange={(e) => setDealsFilter(e.target.value)} className={selectCls}>
          {DEALS_LANDED_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        <select value={reliabilityFilter} onChange={(e) => setReliabilityFilter(e.target.value)} className={selectCls}>
          {RELIABILITY_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        <select value={lastActiveFilter} onChange={(e) => setLastActiveFilter(e.target.value)} className={selectCls}>
          {LAST_ACTIVE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        <select value={marginFilter} onChange={(e) => setMarginFilter(e.target.value)} className={selectCls}>
          {MARGIN_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        {anyFilter && (
          <button onClick={clearFilters} className="text-[12px] text-muted hover:text-ink-2 px-2 h-8 rounded-lg hover:bg-surface-3 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Result count */}
      <div className="text-[12px] text-muted mb-3">
        Showing {sorted.length} of {tiers.length} clients
      </div>

      {/* Table */}
      <div className="bg-surface border border-line rounded-xl overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-line-2">
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Client</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Tier</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Actually paid</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Profit</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Invoices</th>
              <th className="text-center px-5 py-3 text-[12px] font-medium text-muted">Quotes</th>
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">Reliability</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">Avg margin</th>
              <th className="text-right px-5 py-3 text-[12px] font-medium text-muted">
                <button
                  onClick={toggleMoney}
                  title={moneyMode === "revenue" ? "Switch to profit" : "Switch to revenue"}
                  className="group inline-flex items-center gap-1 justify-end w-full cursor-pointer hover:text-ink-2 transition-colors"
                >
                  {moneyHeaderLabel}
                  <ArrowLeftRight
                    size={11}
                    className="text-faint group-hover:text-ink-2 transition-transform duration-[130ms] ease-out"
                    style={{ transform: moneyMode === "profit" ? "rotate(180deg)" : "rotate(0deg)" }}
                  />
                </button>
              </th>
              <th className="text-left px-5 py-3 text-[12px] font-medium text-muted">
                <button
                  onClick={togglePeriod}
                  title={periodMode === "deal" ? "Switch to monthly view" : "Switch to per-deal view"}
                  className="group inline-flex items-center gap-1 cursor-pointer hover:text-ink-2 transition-colors"
                >
                  Frequency
                  <ArrowLeftRight
                    size={11}
                    className="text-faint group-hover:text-ink-2 transition-transform duration-[130ms] ease-out"
                    style={{ transform: periodMode === "month" ? "rotate(180deg)" : "rotate(0deg)" }}
                  />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, i) => {
              const moneyValue = tierMoney(t, moneyMode, periodMode);
              const dpm = dealsPerMonth(t.purchase_cadence_days);
              const stagger = Math.min(i * 14, 220);
              const moneyStr = moneyValue == null ? EM_DASH : `${moneyValue < 0 ? "−" : ""}${fmtAmount(Math.abs(moneyValue))}`;
              const freqStr = periodMode === "month"
                ? (dpm != null ? `${dpm.toFixed(1)} deals / mo` : EM_DASH)
                : (t.purchase_cadence_days != null ? `Every ${Math.round(t.purchase_cadence_days)} days` : EM_DASH);
              return (
              <tr
                key={t.client_id}
                onClick={() => setDetailId(t.client_id)}
                className="border-b border-line-2 last:border-0 hover:bg-surface-2/60 transition-colors cursor-pointer"
              >
                <td className="px-5 py-3 text-[13px] font-medium text-ink">{t.client_name}</td>
                <td className="px-5 py-3 text-center">
                  <TierBadge tier={t.tier} />
                </td>
                <td className="px-5 py-3 text-right text-[13px] font-semibold text-ink tabular-nums">
                  {t.actual_paid > 0 ? fmtAmount(t.actual_paid) : "—"}
                </td>
                <td className={`px-5 py-3 text-right text-[13px] font-semibold tabular-nums ${
                  t.total_profit < 0 ? "text-danger-ink" : "text-ink"
                }`}>
                  {t.total_profit !== 0 ? <>{t.total_profit < 0 ? "−" : ""}{fmtAmount(Math.abs(t.total_profit))}</> : "—"}
                </td>
                <td className="px-5 py-3 text-center text-[13px] text-ink-2 tabular-nums">{t.invoices_sent}</td>
                <td className="px-5 py-3 text-center text-[13px] text-ink-2 tabular-nums">{t.quotes_sent || "—"}</td>
                <td className="px-5 py-3">
                  <ReliabilityBadge reliability={t.reliability} pct={t.reliability_pct} quotesSent={t.quotes_sent} quotesWon={t.quotes_won} />
                </td>
                <td className="px-5 py-3 text-right">
                  {t.avg_commission_pct > 0 ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums ${
                      t.avg_commission_pct >= 25 ? "bg-success-bg text-success-ink"
                      : t.avg_commission_pct >= 10 ? "bg-warning-bg text-warning-ink"
                      : "bg-danger-bg text-danger-ink"
                    }`}>
                      {t.avg_commission_pct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-[12px] text-faint">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right text-[13px] tabular-nums">
                  <span className={moneyValue != null && moneyValue < 0 ? "text-danger-ink" : "text-ink-2"}>
                    <Odometer value={moneyStr} roll={isRollRender} rowDelayMs={stagger} />
                  </span>
                </td>
                <td
                  className="px-5 py-3 text-[12px] text-muted"
                  title={`Measured from ${t.deals_landed} completed deal${t.deals_landed === 1 ? "" : "s"}`}
                >
                  <Odometer value={freqStr} roll={isRollRender} rowDelayMs={stagger} />
                </td>
              </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="px-5 py-16 text-center">
                  <Layers size={24} className="text-faint mx-auto mb-2" />
                  <p className="text-[13px] text-muted">No clients match these filters</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
