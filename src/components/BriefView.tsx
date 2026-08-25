import { useEffect, useState } from "react";
import { api, WeeklyBrief } from "../lib/api";
import { fmtAmount, localDay, localMonth, parseLocalDay } from "../lib/format";
import { toast } from "./Toast";
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, Send, Printer,
  AlertCircle, Users, Target, GitBranch,
  ChevronLeft, ChevronRight,
} from "lucide-react";

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const FREQ_PRESETS: { label: string; days: number }[] = [
  { label: "Daily", days: 1 },
  { label: "Weekly", days: 7 },
  { label: "Biweekly", days: 14 },
  { label: "Monthly", days: 30 },
];

// Colors for payout-recipient boxes. Business uses the app accent; other
// recipients cycle through a fixed palette so any number of them stay distinct.
const BIZ_COLOR = { accent: "var(--accent-400)", accentBg: "var(--accent-tint)", accentBorder: "var(--accent-glow)", labelColor: "var(--accent-500)" };
const RECIP_COLORS = [
  { accent: "#34D399", accentBg: "rgba(16,185,129,0.08)", accentBorder: "rgba(16,185,129,0.2)", labelColor: "#10B981" },
  { accent: "#60A5FA", accentBg: "rgba(59,130,246,0.08)", accentBorder: "rgba(59,130,246,0.2)", labelColor: "#3B82F6" },
  { accent: "#A78BFA", accentBg: "rgba(139,92,246,0.08)", accentBorder: "rgba(139,92,246,0.2)", labelColor: "#8B5CF6" },
  { accent: "#F472B6", accentBg: "rgba(236,72,153,0.08)", accentBorder: "rgba(236,72,153,0.2)", labelColor: "#EC4899" },
  { accent: "#FBBF24", accentBg: "rgba(245,158,11,0.08)", accentBorder: "rgba(245,158,11,0.2)", labelColor: "#F59E0B" },
];

export default function BriefView({ currentUser }: { currentUser?: any }) {
  const [brief,   setBrief]   = useState<WeeklyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [anchorDate, setAnchorDate] = useState<string | null>(null);
  const [freq,    setFreq]    = useState(7);

  const load = async (date?: string | null) => {
    setLoading(true);
    try {
      const repName = currentUser?.role === "sales_rep" ? currentUser.name : null;
      const b = await api.generateWeeklyBrief(date ?? null, repName);
      setBrief(b);
    } catch (e: any) { toast(String(e), "error"); }
    setLoading(false);
  };
  useEffect(() => {
    api.getBriefFrequency().then(setFreq).catch(() => {});
    load(null);
  }, []);

  // Persist a new cadence and regenerate the brief immediately.
  const changeFreq = async (days: number) => {
    setFreq(days);
    try { await api.setBriefFrequency(days); } catch (e: any) { toast(String(e), "error"); }
    load(anchorDate);
  };

  // R-159: step from the server-computed period bounds — the day before the
  // period start / after the period end always lands in the adjacent calendar
  // block, whatever the cadence (the old ±30-day hop repeated or skipped months).
  const goToPrevWeek = () => {
    const prev = brief ? addDays(brief.week_start, -1) : addDays(anchorDate ?? localDay(), -freq);
    setAnchorDate(prev);
    load(prev);
  };
  const goToNextWeek = () => {
    if (!anchorDate || !brief) return;
    const next = addDays(brief.week_end, 1);
    const today = localDay();
    const nextIsCurrent = next >= today
      || (freq >= 28 ? next.slice(0, 7) === localMonth() : addDays(next, freq - 1) >= today);
    if (nextIsCurrent) { setAnchorDate(null); load(null); }
    else { setAnchorDate(next); load(next); }
  };
  const isCurrentWeek = !anchorDate;
  const periodLabel = FREQ_PRESETS.find((p) => p.days === freq)?.label
    ?? `${freq}-day`;

  const changePct = (pct: number) => {
    if (pct > 0) return <span className="text-success-ink flex items-center gap-0.5"><TrendingUp size={12} /> {pct.toFixed(1)}%</span>;
    if (pct < 0) return <span className="text-danger-ink flex items-center gap-0.5"><TrendingDown size={12} /> {Math.abs(pct).toFixed(1)}%</span>;
    return <span className="text-muted flex items-center gap-0.5"><Minus size={12} /> 0%</span>;
  };

  if (!brief && !loading) return (
    <div className="text-[14px] text-muted text-center py-10">Could not generate brief</div>
  );

  return (
    <div className="print-area max-w-3xl mx-auto">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 print:hidden">
        <div className="flex items-center gap-3">
          <h2 className="text-[18px] font-semibold text-ink">Brief</h2>
          <select
            value={freq}
            onChange={(e) => changeFreq(parseInt(e.target.value))}
            className="h-8 px-2 rounded-lg text-[12px] text-ink-2 bg-transparent focus:outline-none focus:ring-2 focus:ring-accent/40"
            style={{ border: "1px solid var(--t-b1)" }}
            title="How often you want briefs"
          >
            {FREQ_PRESETS.map((p) => (
              <option key={p.days} value={p.days}>{p.label}</option>
            ))}
            {!FREQ_PRESETS.some((p) => p.days === freq) && (
              <option value={freq}>{freq}-day</option>
            )}
          </select>
          <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: "var(--t-s3)" }}>
            <button onClick={goToPrevWeek}
              className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 transition-colors"
              onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s1)")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <ChevronLeft size={14} />
            </button>
            <span className="text-[12px] font-medium text-ink-2 px-1 whitespace-nowrap">
              {isCurrentWeek ? `Current (${periodLabel})` : brief ? `${brief.week_start} – ${brief.week_end}` : "Previous"}
            </span>
            <button onClick={goToNextWeek} disabled={isCurrentWeek}
              className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 transition-colors disabled:opacity-30"
              onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s1)")}
              onMouseLeave={e => (e.currentTarget.style.background = "")}>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load(anchorDate)}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] text-ink-2 transition-colors"
            style={{ border: "1px solid var(--t-b1)" }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
            onMouseLeave={e => (e.currentTarget.style.background = "")}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent h-9 px-4 rounded-lg text-[13px] font-medium transition-colors">
            <Printer size={14} /> Print
          </button>
          <button onClick={() => {
            if (brief) toast("Emailing briefs isn't set up yet — connect email in Settings → Email", "error");
          }}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] text-ink-2 transition-colors"
            style={{ border: "1px solid var(--t-b1)" }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--t-s2)")}
            onMouseLeave={e => (e.currentTarget.style.background = "")}>
            <Send size={14} /> Email
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4 py-2">
          <div className="h-16 bg-surface-2 rounded-xl animate-pulse" />
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 bg-surface-2 rounded-xl animate-pulse" />)}
          </div>
          <div className="h-48 bg-surface-2 rounded-xl animate-pulse" />
        </div>
      ) : brief ? (
        <div className="space-y-6">

          {/* Header */}
          <div className="text-center pb-6" style={{ borderBottom: "1px solid var(--t-b1)" }}>
            <h1 className="text-[24px] font-bold text-ink">{periodLabel} brief</h1>
            <p className="text-[14px] text-muted mt-2">{brief.week_start} &mdash; {brief.week_end}</p>
            <p className="text-[11px] text-muted mt-1">
              Generated {new Date(brief.generated_at).toLocaleString()}
            </p>
          </div>

          {/* Section 1: At-a-glance hero — one calm divided row (mirrors the dashboard) */}
          <div>
            <h2 className="text-[15px] font-semibold text-ink mb-3">This {freq >= 28 ? "month" : freq === 7 ? "week" : "period"} at a glance</h2>
            <div className="rounded-2xl overflow-hidden" style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
              <div className="grid grid-cols-2 xl:grid-cols-4 divide-x divide-line">
                <HeroCell label="Revenue" value={fmtAmount(brief.revenue_this_week)} extra={changePct(brief.revenue_change_pct)} />
                <HeroCell label="Profit" value={fmtAmount(brief.profit_this_week)} extra={changePct(brief.profit_change_pct)}
                  sub={`${(+brief.avg_margin_this_week || 0).toFixed(1)}% margin`} />
                <HeroCell label="Deals closed" value={String(brief.deals_closed_this_week)} sub={`${brief.deals_lost_this_week} lost`} />
                <HeroCell label="Win rate" value={`${(+brief.win_rate_this_week || 0).toFixed(0)}%`} />
              </div>
            </div>
          </div>

          {/* Section 2: Profit from deal flows */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[15px] font-semibold text-ink flex items-center gap-2">
                <GitBranch size={15} className="text-accent" />
                Profit from deal flows
              </h2>
              <span className="text-[11px] font-medium text-muted px-2 py-0.5 rounded-full"
                style={{ background: "var(--t-s3)", border: "1px solid var(--t-b1)" }}>
                {brief.completed_deals_this_week} deal{brief.completed_deals_this_week !== 1 ? "s" : ""} completed
              </span>
            </div>

            <div className="rounded-xl p-5 space-y-4" style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
              {/* Net profit */}
              <div className="flex items-center justify-between">
                <div className="text-[13px] text-muted">Net profit</div>
                <div className="flex items-center gap-2">
                  <span className={`text-[26px] font-bold ${brief.net_profit_this_week >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
                    {fmtAmount(brief.net_profit_this_week)}
                  </span>
                  <span className="text-[12px]">{changePct(brief.net_profit_change_pct)}</span>
                </div>
              </div>

              {/* Payout split — config-driven; shown only when recipients are set up.
                  Never assumes a split or shows partner names. */}
              {brief.payout_totals && brief.payout_totals.length > 0 ? (
                <>
                  <div className="text-[11px] text-muted">
                    Each recipient's cut this period ({brief.week_start} – {brief.week_end})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {(() => {
                      let nb = 0;
                      return brief.payout_totals.map((r, i) => {
                        const c = r.is_business ? BIZ_COLOR : RECIP_COLORS[(nb++) % RECIP_COLORS.length];
                        return (
                          <SplitBox key={i}
                            accent={c.accent} accentBg={c.accentBg} accentBorder={c.accentBorder}
                            label={r.name} value={fmtAmount(r.this_week)} labelColor={c.labelColor}
                          />
                        );
                      });
                    })()}
                  </div>

                  {/* Month-to-date */}
                  {brief.net_profit_this_month !== 0 && (
                    <div className="flex items-center justify-between gap-3 flex-wrap text-[12px] text-muted pt-3"
                      style={{ borderTop: "1px solid var(--t-b1)" }}>
                      <span>
                        {parseLocalDay(brief.week_start).toLocaleString("en-US", { month: "long" })} so far: <span className="font-semibold text-ink-2">{fmtAmount(brief.net_profit_this_month)}</span> profit
                      </span>
                      <span className="text-right">
                        {brief.payout_totals.map((r, i) => (
                          <span key={i}>
                            {i > 0 && <span className="mx-1.5">&middot;</span>}
                            {r.name} MTD: <span className="font-medium text-ink-2">{fmtAmount(r.this_month)}</span>
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                /* Unconfigured → net only + a setup link (no assumed split, no names) */
                <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                  <span className="text-[12px] text-muted">Set up a payout split to see how each recipient's cut breaks down.</span>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "settings" }))}
                    className="text-[12px] font-medium text-accent hover:underline"
                  >
                    Set up payout split →
                  </button>
                </div>
              )}

              {/* Explicit margin breakdown + all-time month history (per Jack) */}
              <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[12px] text-muted pt-3"
                style={{ borderTop: "1px solid var(--t-b1)" }}>
                <span className="font-medium text-ink-2">Margin</span>
                <span>This month <span className="font-semibold text-ink-2">{(+brief.avg_margin_this_month || 0).toFixed(1)}%</span></span>
                <span>All-time <span className="font-semibold text-ink-2">{(+brief.avg_margin_all_time || 0).toFixed(1)}%</span></span>
              </div>

              {brief.monthly_breakdown?.length > 0 && (
                <div className="pt-3" style={{ borderTop: "1px solid var(--t-b1)" }}>
                  <div className="text-[12px] font-medium text-ink-2 mb-2">Every month you've closed deals</div>
                  {/* These rows are deal-scoped, so the money column is the deals' own
                      revenue — not the paid-invoice revenue in the headline above, which
                      is a different (larger) figure. The header says so explicitly. */}
                  <div className="flex items-center gap-3 text-[11px] text-muted mb-1">
                    <span className="w-24">Month</span>
                    <span className="w-16">Deals</span>
                    <span className="flex-1">Deal revenue</span>
                    <span className="w-20 text-right">Profit</span>
                    <span className="w-14 text-right">Margin</span>
                  </div>
                  <div className="space-y-1">
                    {[...brief.monthly_breakdown].reverse().map((m) => (
                      <div key={m.month} className="flex items-center gap-3 text-[12px]">
                        <span className="w-24 text-ink-2 font-medium">{parseLocalDay(m.month).toLocaleString("en-US", { month: "short", year: "numeric" })}</span>
                        <span className="text-muted w-16 tabular-nums">{m.count}</span>
                        <span className="text-muted tabular-nums flex-1">{fmtAmount(m.revenue)}</span>
                        <span className={`tabular-nums font-medium w-20 text-right ${m.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(m.net_profit)}</span>
                        <span className="text-muted tabular-nums w-14 text-right">{(+m.margin_pct || 0).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Loss warning */}
              {brief.loss_deals_this_week > 0 && (
                <div className="flex items-center gap-2 bg-warning-bg border border-warning rounded-lg px-4 py-2.5">
                  <AlertCircle size={14} className="text-warning-ink flex-shrink-0" />
                  <span className="text-[12px] text-warning-ink">
                    {brief.loss_deals_this_week} deal{brief.loss_deals_this_week !== 1 ? "s" : ""} lost money this period:{" "}
                    <span className="font-semibold">{fmtAmount(brief.loss_total_this_week)}</span>
                  </span>
                </div>
              )}

              {/* Refunded deals — happened but fell through */}
              {brief.refunded_deals_this_week > 0 && (
                <div className="flex items-center gap-2 bg-warning-bg border border-warning rounded-lg px-4 py-2.5">
                  <AlertCircle size={14} className="text-warning-ink flex-shrink-0" />
                  <span className="text-[12px] text-warning-ink">
                    {brief.refunded_deals_this_week} deal{brief.refunded_deals_this_week !== 1 ? "s" : ""} refunded this period — happened but fell through:{" "}
                    <span className="font-semibold">{fmtAmount(brief.refunded_total_this_week)}</span> returned
                  </span>
                </div>
              )}

              {/* Rep's own earnings (shown when viewing a single rep's brief) */}
              {brief.rep_earnings_this_week > 0 && (
                <div className="flex items-center justify-between bg-surface border border-line rounded-lg px-4 py-2.5">
                  <span className="text-[12px] text-muted">Your earnings this period (after any refunds)</span>
                  <span className="text-[15px] font-bold text-success-ink tabular-nums">{fmtAmount(brief.rep_earnings_this_week)}</span>
                </div>
              )}

              <div className="text-[10px] text-muted italic">
                Profit calculated from completed deal flows only
              </div>
            </div>
          </div>

          {/* Section 3: Receivables & Follow-ups */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl p-4" style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
              <h3 className="text-[13px] font-semibold text-ink mb-3">Receivables</h3>
              {brief.overdue_invoices_count > 0 ? (
                <div>
                  <div className="text-[28px] font-bold text-danger-ink leading-none">{brief.overdue_invoices_count}</div>
                  <div className="text-[12px] text-muted mt-1">overdue invoice{brief.overdue_invoices_count !== 1 ? "s" : ""}</div>
                  <div className="text-[18px] font-bold text-danger-ink mt-2">{fmtAmount(brief.overdue_invoices_value)}</div>
                </div>
              ) : (
                <div className="text-[13px] text-success-ink font-medium">No overdue invoices</div>
              )}
            </div>
            <div className="rounded-xl p-4" style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
              <h3 className="text-[13px] font-semibold text-ink mb-3">Follow-ups</h3>
              {brief.follow_ups_due > 0 ? (
                <div>
                  <div className="text-[28px] font-bold text-warning-ink leading-none">{brief.follow_ups_due}</div>
                  <div className="text-[12px] text-muted mt-1">follow-ups due today</div>
                </div>
              ) : (
                <div className="text-[13px] text-success-ink font-medium">All caught up</div>
              )}
            </div>
          </div>

          {/* Section 4: Highlights */}
          {(brief.best_margin_deal || brief.worst_margin_deal || brief.biggest_invoice) && (
            <div>
              <h2 className="text-[15px] font-semibold text-ink mb-3">This {freq >= 28 ? "month" : freq === 7 ? "week" : "period"}'s highlights</h2>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {brief.best_margin_deal && (
                  <HighlightCard
                    accent="emerald"
                    title="Best margin"
                    name={brief.best_margin_deal.title}
                    sub={brief.best_margin_deal.client_name}
                    stat={`${brief.best_margin_deal.margin_pct.toFixed(1)}%`}
                  />
                )}
                {brief.worst_margin_deal && (
                  <HighlightCard
                    accent="amber"
                    title="Lowest margin"
                    name={brief.worst_margin_deal.title}
                    sub={brief.worst_margin_deal.client_name}
                    stat={`${brief.worst_margin_deal.margin_pct.toFixed(1)}%`}
                  />
                )}
                {brief.biggest_invoice && (
                  <HighlightCard
                    accent="indigo"
                    title="Biggest invoice"
                    name={brief.biggest_invoice.number}
                    sub={brief.biggest_invoice.client_name}
                    stat={fmtAmount(brief.biggest_invoice.total)}
                  />
                )}
              </div>
            </div>
          )}

          {/* Section 5: Activity */}
          <div>
            <h2 className="text-[15px] font-semibold text-ink mb-3">Activity this {freq >= 28 ? "month" : freq === 7 ? "week" : "period"}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl p-4 flex items-center gap-4"
                style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--accent-tint)" }}>
                  <Users size={18} className="text-accent" />
                </div>
                <div>
                  <div className="text-[24px] font-bold text-ink leading-none">{brief.new_clients_this_week}</div>
                  <div className="text-[12px] text-muted mt-0.5">new clients</div>
                </div>
              </div>
              <div className="rounded-xl p-4 flex items-center gap-4"
                style={{ background: "var(--t-s1)", border: "1px solid var(--t-b1)" }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "rgba(124,58,237,0.1)" }}>
                  <Target size={18} className="text-accent" />
                </div>
                <div>
                  <div className="text-[24px] font-bold text-ink leading-none">{brief.interactions_this_week}</div>
                  <div className="text-[12px] text-muted mt-0.5">interactions logged</div>
                </div>
              </div>
            </div>
          </div>

        </div>
      ) : null}
    </div>
  );
}

// ─── Stat card (at-a-glance row) ─────────────────────────────────────────────
// One cell of the at-a-glance hero row (the row card owns the border).
function HeroCell({
  label, value, extra, sub,
}: { label: string; value: string; extra?: React.ReactNode; sub?: string }) {
  return (
    <div className="p-5">
      <div className="text-[12.5px] font-medium text-muted">{label}</div>
      <div className="text-[24px] font-bold text-ink tabular-nums mt-1.5 leading-none">{value}</div>
      {(extra || sub) && (
        <div className="mt-1.5 flex items-center gap-2 text-[12px]">
          {extra}
          {sub && <span className="text-[11px] text-faint">{sub}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Profit split box ─────────────────────────────────────────────────────────
function SplitBox({
  accent, accentBg, accentBorder, label, value, labelColor,
}: {
  accent: string;
  accentBg: string;
  accentBorder: string;
  label: string;
  value: string;
  labelColor: string;
}) {
  return (
    <div
      className="rounded-xl p-4 text-center"
      style={{
        background: accentBg,
        border: `1px solid ${accentBorder}`,
        borderTop: `2.5px solid ${accent}`,
      }}
    >
      <div className="text-[12.5px] font-medium mb-2" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="text-[20px] font-bold text-ink tabular-nums">{value}</div>
    </div>
  );
}

// ─── Highlight card ───────────────────────────────────────────────────────────
function HighlightCard({
  accent, title, name, sub, stat,
}: { accent: "emerald" | "amber" | "indigo"; title: string; name: string; sub: string; stat: string }) {
  const clr = {
    emerald: { label: "text-success-ink", stat: "text-success-ink", borderClr: "rgba(16,185,129,0.25)" },
    amber:   { label: "text-warning-ink",   stat: "text-warning-ink",   borderClr: "rgba(245,158,11,0.25)"  },
    indigo:  { label: "text-accent",  stat: "text-ink",    borderClr: "var(--accent-glow)"  },
  }[accent];

  return (
    <div className="rounded-xl p-4 bg-surface" style={{ border: `1px solid ${clr.borderClr}` }}>
      <div className={`text-[12.5px] font-medium mb-2 ${clr.label}`}>{title}</div>
      <div className="text-[13px] font-semibold text-ink truncate">{name}</div>
      <div className="text-[11px] text-muted mt-0.5 truncate">{sub}</div>
      <div className={`text-[18px] font-bold mt-2 ${clr.stat}`}>{stat}</div>
    </div>
  );
}
