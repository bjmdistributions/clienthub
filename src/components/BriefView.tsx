import { useEffect, useMemo, useState } from "react";
import { api, WeeklyBrief, DealFlow, ReceivablesAging, ARItem, Client, Invoice } from "../lib/api";
import { fmtAmount, localDay, parseLocalDay } from "../lib/format";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import {
  RefreshCw, Printer, ArrowRight, CheckCircle2, CalendarClock, Clock,
  Banknote, FileText, Truck, AlertTriangle, Users, Receipt, PackageCheck,
} from "lucide-react";

// Colors for payout-recipient boxes. Business uses the app accent; other
// recipients cycle through a fixed palette so any number of them stay distinct.
// The recipient's name used to be printed in its own hue, which meant a literal
// that reads at ~3:1 on one theme and ~2:1 on the other. The identity is now the
// 2.5px top rule and the tint; the name and the figure are theme tokens.
const BIZ_COLOR = { accent: "var(--accent-400)", accentBg: "var(--accent-tint)", accentBorder: "var(--accent-glow)" };
const RECIP_COLORS = [
  { accent: "#34D399", accentBg: "rgba(16,185,129,0.08)", accentBorder: "rgba(16,185,129,0.2)" },
  { accent: "#60A5FA", accentBg: "rgba(59,130,246,0.08)", accentBorder: "rgba(59,130,246,0.2)" },
  { accent: "#A78BFA", accentBg: "rgba(139,92,246,0.08)", accentBorder: "rgba(139,92,246,0.2)" },
  { accent: "#F472B6", accentBg: "rgba(236,72,153,0.08)", accentBorder: "rgba(236,72,153,0.2)" },
  { accent: "#FBBF24", accentBg: "rgba(245,158,11,0.08)", accentBorder: "rgba(245,158,11,0.2)" },
];

/** Bare day out of either a `YYYY-MM-DD` or a full timestamp. */
const day = (s?: string | null) => (s ? s.slice(0, 10) : "");

/** "Sep 4" — dates on this screen are read at a glance, not filed. */
const shortDate = (s?: string | null) =>
  (s ? parseLocalDay(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** Emerald for profit, rose for a loss, plain ink for nothing yet — zero is
 *  neither, and the semantic hues only ever carry one of those two meanings. */
const moneyCls = (n: number) => (n > 0 ? "text-success-ink" : n < 0 ? "text-danger-ink" : "text-ink");

/** Monday of the week `d` falls in, computed locally (R-159 date rules).
 *  Deliberately NOT read off `brief.week_start` — that window follows the stored
 *  brief cadence, and this screen is today and this week only. */
function mondayOf(d: string): string {
  const dt = parseLocalDay(d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return localDay(dt);
}

const goTab = (tab: string) => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: tab }));

/** Drill into the deal behind an invoice — the same stash-then-switch handoff
 *  Receivables, Payables and the client screen use. */
const openDeal = (invoiceNumber: string) => {
  try { localStorage.setItem("dealflow_invoice_filter", invoiceNumber); } catch { /* ignore */ }
  goTab("dealflow");
};

type Scope = "today" | "week";

/** One thing that happened in the window, whatever produced it. */
type Happening = {
  key: string;
  on: string;
  kind: "deal" | "payment" | "invoice";
  title: string;
  meta: string;
  amount: number;
  signed: boolean;   // profit figure → emerald when up, rose when down
  invoiceNumber: string;
};

export default function BriefView({ currentUser }: { currentUser?: any }) {
  // Org-wide detail (whose invoice, which deal, how much) stays with the people
  // who already see the numbers; a rep gets the brief's own rep-filtered figures.
  const showOrg = currentUser?.role !== "sales_rep";

  const [brief, setBrief]         = useState<WeeklyBrief | null>(null);
  const [flows, setFlows]         = useState<DealFlow[]>([]);
  const [invoices, setInvoices]   = useState<Invoice[]>([]);
  const [ar, setAr]               = useState<ReceivablesAging | null>(null);
  const [followups, setFollowups] = useState<Client[]>([]);
  const [loading, setLoading]     = useState(true);
  const [scope, setScope]         = useState<Scope>("today");

  const today = localDay();
  const weekStart = mondayOf(today);
  const from = scope === "today" ? today : weekStart;
  const inWindow = (s?: string | null) => { const d = day(s); return !!d && d >= from && d <= today; };

  const load = async () => {
    setLoading(true);
    try {
      const repName = currentUser?.role === "sales_rep" ? currentUser.name : null;
      // The screen asks for the window it is labelling (7 = this Monday–Sunday week),
      // rather than leaning on the org-shared cadence, which follows the emailed brief.
      const b = await api.generateWeeklyBrief(null, repName, 7);
      setBrief(b);
    } catch (e: any) { toast(String(e), "error"); }
    if (showOrg) {
      api.listDealFlows().then(setFlows).catch(() => {});
      api.listInvoices().then(setInvoices).catch(() => {});
      api.getReceivablesAging().then(setAr).catch(() => setAr(null));
    }
    api.dueFollowups().then(setFollowups).catch(() => {});
    setLoading(false);
  };

  useEffect(() => {
    // The window is an argument to the brief command, not the org-shared cadence:
    // `brief_frequency_days` belongs to the periodic brief and syncs to every device,
    // so this screen must never rewrite it just to make its own heading true.
    load();
  }, []);

  // ── What happened in the window ───────────────────────────────────────────
  const invoiceClient = useMemo(() => {
    const m: Record<string, string> = {};
    flows.forEach((f) => { if (f.invoice_id && f.client_name) m[f.invoice_id] = f.client_name; });
    return m;
  }, [flows]);

  const completed = useMemo(
    () => flows.filter((f) => f.stage === "complete" && inWindow(f.completed_at)),
    [flows, from, today],
  );
  const paidIn = useMemo(
    () => flows.filter((f) => inWindow(f.payment_received_at) && f.payment_received_amount > 0),
    [flows, from, today],
  );
  const sent = useMemo(
    () => invoices.filter((i) => !i.voided && inWindow(i.sent_at)),
    [invoices, from, today],
  );

  const dealRevenue = completed.reduce((s, f) => s + (f.gross_revenue || 0), 0);
  const dealProfit  = completed.reduce((s, f) => s + (f.net_profit || 0), 0);
  const moneyIn     = paidIn.reduce((s, f) => s + (f.payment_received_amount || 0), 0);
  const sentTotal   = sent.reduce((s, i) => s + (i.total || 0), 0);

  const happenings: Happening[] = useMemo(() => {
    const out: Happening[] = [];
    completed.forEach((f) => out.push({
      key: `d-${f.id}`, on: day(f.completed_at), kind: "deal",
      title: f.client_name || f.name || "Deal",
      meta: `Deal completed${f.invoice_number ? ` · ${f.invoice_number}` : ""}`,
      amount: f.net_profit || 0, signed: true, invoiceNumber: f.invoice_number || "",
    }));
    paidIn.forEach((f) => out.push({
      key: `p-${f.id}`, on: day(f.payment_received_at), kind: "payment",
      title: f.client_name || f.name || "Payment",
      meta: `Payment in${f.payment_received_method ? ` · ${f.payment_received_method}` : ""}`,
      amount: f.payment_received_amount || 0, signed: false, invoiceNumber: f.invoice_number || "",
    }));
    sent.forEach((i) => {
      const who = invoiceClient[i.id];
      out.push({
        key: `i-${i.id}`, on: day(i.sent_at), kind: "invoice",
        title: who || `Invoice ${i.number}`,
        meta: who ? `Invoice ${i.number} sent · due ${shortDate(i.due_date)}`
                  : `Sent · due ${shortDate(i.due_date)}`,
        amount: i.total || 0, signed: false, invoiceNumber: i.number,
      });
    });
    return out.sort((a, b) => (a.on === b.on ? a.kind.localeCompare(b.kind) : b.on.localeCompare(a.on)));
  }, [completed, paidIn, sent, invoiceClient]);

  // ── What needs you now ────────────────────────────────────────────────────
  const overdue = useMemo(
    () => (ar?.items ?? []).filter((i) => i.days_overdue > 0 && i.committed)
      .sort((a, b) => b.days_overdue - a.days_overdue),
    [ar],
  );
  const overdueValue = overdue.reduce((s, i) => s + i.amount, 0);
  const awaitingSupplier = useMemo(
    () => flows.filter((f) => f.stage === "payment_received" && f.supplier_owed > 0),
    [flows],
  );
  const readyToClose = useMemo(() => flows.filter((f) => f.stage === "supplier_paid"), [flows]);

  // ── What is at risk ───────────────────────────────────────────────────────
  const aged = useMemo(() => (ar?.items ?? []).filter((i) => i.days_overdue > 30), [ar]);
  const agedValue = aged.reduce((s, i) => s + i.amount, 0);
  const speculative = useMemo(() => (ar?.items ?? []).filter((i) => !i.committed), [ar]);
  const speculativeValue = speculative.reduce((s, i) => s + i.amount, 0);
  const slipping = useMemo(
    () => flows.filter((f) => f.stage !== "complete" && f.expected_delivery_date && day(f.expected_delivery_date) < today),
    [flows, today],
  );

  const needsNothing = overdue.length === 0 && followups.length === 0
    && awaitingSupplier.length === 0 && readyToClose.length === 0;
  const riskNothing = aged.length === 0 && speculative.length === 0 && slipping.length === 0;

  const scopeWord = scope === "today" ? "today" : "this week";
  const dateLine = scope === "today"
    ? parseLocalDay(today).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : `${parseLocalDay(weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${parseLocalDay(today).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div className="print-area">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Brief</h2>
          <p className="text-[12px] text-muted mt-0.5">{dateLine}</p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <div className="flex items-center gap-0.5 bg-surface-2 border border-line rounded-lg p-0.5">
            {([["today", "Today"], ["week", "This week"]] as [Scope, string][]).map(([id, label]) => (
              <button key={id} onClick={() => setScope(id)}
                className={`px-3 h-7 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors duration-[130ms] ${scope === id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={load}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] text-ink-2 border border-line hover:bg-surface-2 transition-colors duration-[130ms]">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent h-9 px-4 rounded-lg text-[13px] font-medium transition-colors duration-[130ms]">
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {loading && !brief ? (
        <div className="space-y-4">
          <div className="h-36 bg-surface-2 rounded-2xl animate-pulse" />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2 h-64 bg-surface-2 rounded-2xl animate-pulse" />
            <div className="h-64 bg-surface-2 rounded-2xl animate-pulse" />
          </div>
        </div>
      ) : (
      <div className="space-y-4">

        {/* ── What happened ──────────────────────────────────────────────── */}
        <div className="bg-surface border border-line rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-line-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-ink tracking-tight">What happened {scopeWord}</h3>
              <p className="text-[11px] text-muted mt-0.5">Deals closed out, money in, invoices sent</p>
            </div>
            <StatusPill tone={happenings.length > 0 ? "accent" : "neutral"}>
              {happenings.length} update{happenings.length !== 1 ? "s" : ""}
            </StatusPill>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-line-2">
            <Tile label="Deals completed" value={String(completed.length)}
              sub={completed.length > 0 ? `${fmtAmount(dealRevenue)} revenue` : "Nothing closed out yet"} />
            <Tile label="Profit booked" value={fmtAmount(dealProfit)}
              valueCls={moneyCls(dealProfit)}
              sub="From completed deals only" />
            <Tile label="Money in" value={fmtAmount(moneyIn)}
              sub={`${paidIn.length} buyer payment${paidIn.length !== 1 ? "s" : ""}`}
              className="border-t border-line-2 xl:border-t-0" />
            <Tile label="Invoices sent" value={String(sent.length)}
              sub={sent.length > 0 ? fmtAmount(sentTotal) : "None sent yet"}
              className="border-t border-line-2 xl:border-t-0" />
          </div>

          {happenings.length === 0 ? (
            <div className="px-5 py-8 text-[13px] text-muted text-center border-t border-line-2">
              Nothing has been recorded {scopeWord} yet.
            </div>
          ) : (
            <div className="divide-y divide-line-2 border-t border-line-2">
              {happenings.slice(0, 8).map((h) => (
                <HappeningRow key={h.key} h={h} showDate={scope === "week"} />
              ))}
              {happenings.length > 8 && (
                <div className="px-5 py-2.5 text-[12px] text-muted">
                  {happenings.length - 8} more {scope === "today" ? "today" : "this week"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Needs you now · at risk · people ───────────────────────────── */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

          <div className="xl:col-span-2 min-w-0 bg-surface border border-line rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-line-2">
              <h3 className="text-[13px] font-semibold text-ink tracking-tight">What needs you now</h3>
              <p className="text-[11px] text-muted mt-0.5">Chasing, calls and deals waiting on a step from you</p>
            </div>

            {needsNothing ? (
              <div className="py-10 flex flex-col items-center">
                <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-success-ink mb-3">
                  <CheckCircle2 size={18} />
                </div>
                <div className="text-[13px] text-muted">All clear, nothing needs you right now</div>
              </div>
            ) : (
              <div className="divide-y divide-line-2">
                {overdue.length > 0 && (
                  <ActionRow
                    tone="danger" icon={<CalendarClock size={14} />}
                    title={`${overdue.length} invoice${overdue.length !== 1 ? "s" : ""} overdue`}
                    sub="Chase these first"
                    amount={fmtAmount(overdueValue)}
                    onClick={() => goTab("receivables")}
                  />
                )}
                {overdue.slice(0, 4).map((i) => <OverdueRow key={i.invoice_id} item={i} />)}
                {overdue.length > 4 && (
                  <button onClick={() => goTab("receivables")}
                    className="w-full flex items-center gap-2 px-5 py-2.5 text-left text-[12px] text-accent font-medium hover:bg-surface-2/40 transition-colors duration-[130ms]">
                    {overdue.length - 4} more overdue <ArrowRight size={12} className="text-faint" />
                  </button>
                )}

                {followups.length > 0 && (
                  <ActionRow
                    tone="warning" icon={<Clock size={14} />}
                    title={`${followups.length} follow-up${followups.length !== 1 ? "s" : ""} due`}
                    sub={followups.slice(0, 3).map((c) => c.name).join(", ") + (followups.length > 3 ? "…" : "")}
                    onClick={() => goTab("clients")}
                  />
                )}

                {awaitingSupplier.length > 0 && (
                  <ActionRow
                    tone="neutral" icon={<Banknote size={14} />}
                    title={`${awaitingSupplier.length} deal${awaitingSupplier.length !== 1 ? "s" : ""} waiting on a supplier payment`}
                    sub="Paid by the buyer, supplier still owed"
                    amount={fmtAmount(awaitingSupplier.reduce((s, f) => s + f.supplier_owed, 0))}
                    onClick={() => goTab("dealflow")}
                  />
                )}

                {readyToClose.length > 0 && (
                  <ActionRow
                    tone="success" icon={<PackageCheck size={14} />}
                    title={`${readyToClose.length} deal${readyToClose.length !== 1 ? "s" : ""} ready to close out`}
                    sub="Supplier paid: mark them complete to book the profit"
                    onClick={() => goTab("dealflow")}
                  />
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            {/* At risk */}
            <div className="bg-surface border border-line rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-line-2">
                <h3 className="text-[13px] font-semibold text-ink tracking-tight">What is at risk</h3>
                <p className="text-[11px] text-muted mt-0.5">Money and dates that have slipped</p>
              </div>
              {riskNothing ? (
                <div className="px-5 py-8 text-[13px] text-muted text-center">Nothing aged or slipping.</div>
              ) : (
                <div className="divide-y divide-line-2">
                  {aged.length > 0 && (
                    <RiskRow
                      icon={<AlertTriangle size={14} />} tone="danger"
                      title={`${aged.length} receivable${aged.length !== 1 ? "s" : ""} over 30 days`}
                      value={fmtAmount(agedValue)} onClick={() => goTab("receivables")}
                    />
                  )}
                  {slipping.length > 0 && (
                    <RiskRow
                      icon={<Truck size={14} />} tone="warning"
                      title={`${slipping.length} delivery date${slipping.length !== 1 ? "s" : ""} passed`}
                      value={`${slipping.length} deal${slipping.length !== 1 ? "s" : ""}`}
                      onClick={() => goTab("dealflow")}
                    />
                  )}
                  {speculative.length > 0 && (
                    <RiskRow
                      icon={<Receipt size={14} />} tone="neutral"
                      title={`${speculative.length} invoice${speculative.length !== 1 ? "s" : ""} not yet committed`}
                      value={fmtAmount(speculativeValue)} onClick={() => goTab("receivables")}
                    />
                  )}
                </div>
              )}
            </div>

            {/* People and activity — brief-window figures, labelled with that window */}
            {brief && (
              <div className="bg-surface border border-line rounded-2xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-line-2">
                  <h3 className="text-[13px] font-semibold text-ink tracking-tight">New clients and interactions</h3>
                  <p className="text-[11px] text-muted mt-0.5">{shortDate(brief.week_start)} – {shortDate(brief.week_end)}</p>
                </div>
                <div className="grid grid-cols-2 divide-x divide-line-2">
                  <CountCell icon={<Users size={16} />} value={brief.new_clients_this_week} label="new clients" />
                  <CountCell icon={<FileText size={16} />} value={brief.interactions_this_week} label="interactions" />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Where the profit went ──────────────────────────────────────── */}
        {brief && (
          <div className="bg-surface border border-line rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-line-2 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h3 className="text-[13px] font-semibold text-ink tracking-tight">Where the profit went</h3>
                <p className="text-[11px] text-muted mt-0.5">Each recipient's cut, {shortDate(brief.week_start)} – {shortDate(brief.week_end)}</p>
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[11px] text-muted">Net profit</span>
                <span className={`text-[20px] font-bold tabular-nums ${moneyCls(brief.net_profit_this_week)}`}>
                  {fmtAmount(brief.net_profit_this_week)}
                </span>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {brief.payout_totals && brief.payout_totals.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {(() => {
                      let nb = 0;
                      return brief.payout_totals.map((r, i) => {
                        const c = r.is_business ? BIZ_COLOR : RECIP_COLORS[(nb++) % RECIP_COLORS.length];
                        return (
                          <SplitBox key={i}
                            accent={c.accent} accentBg={c.accentBg} accentBorder={c.accentBorder}
                            label={r.name} value={fmtAmount(r.this_week)}
                          />
                        );
                      });
                    })()}
                  </div>

                  {brief.net_profit_this_month !== 0 && (
                    <div className="flex items-center justify-between gap-3 flex-wrap text-[12px] text-muted pt-3 border-t border-line-2">
                      <span className="min-w-0">
                        {parseLocalDay(brief.week_start).toLocaleString("en-US", { month: "long" })} so far:{" "}
                        <span className="font-semibold text-ink-2 tabular-nums">{fmtAmount(brief.net_profit_this_month)}</span> profit
                      </span>
                      <span className="min-w-0 text-right">
                        {brief.payout_totals.map((r, i) => (
                          <span key={i}>
                            {i > 0 && <span className="mx-1.5">&middot;</span>}
                            {r.name} to date: <span className="font-medium text-ink-2 tabular-nums">{fmtAmount(r.this_month)}</span>
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-[12px] text-muted min-w-0">Set up a payout split to see how each recipient's cut breaks down.</span>
                  <button onClick={() => goTab("settings")}
                    className="text-[12px] font-medium text-accent hover:underline">
                    Set up payout split
                  </button>
                </div>
              )}

              {brief.rep_earnings_this_week > 0 && (
                <div className="flex items-center justify-between gap-3 bg-surface-2 border border-line rounded-lg px-4 py-2.5">
                  <span className="text-[12px] text-muted min-w-0">Your earnings this period, after any refunds</span>
                  <span className="text-[15px] font-bold text-success-ink tabular-nums">{fmtAmount(brief.rep_earnings_this_week)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Where the numbers went (R-316) */}
        <div className="flex items-center justify-between gap-3 flex-wrap px-1 pb-2">
          <span className="text-[12px] text-muted min-w-0">
            Revenue, margins, monthly history, win rate and what people bought now live on Analytics.
          </span>
          <button onClick={() => goTab("analytics")}
            className="flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline print:hidden">
            Open analytics <ArrowRight size={12} />
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

// ─── One cell of the "what happened" row (the card owns the border) ──────────
function Tile({ label, value, sub, valueCls = "text-ink", className = "" }: {
  label: string; value: string; sub?: string; valueCls?: string; className?: string;
}) {
  return (
    <div className={`p-5 min-w-0 ${className}`}>
      <div className="text-[12px] font-medium text-muted truncate">{label}</div>
      <div className={`text-[24px] font-bold tabular-nums mt-1.5 leading-none truncate ${valueCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-faint mt-1.5 truncate">{sub}</div>}
    </div>
  );
}

// ─── One recorded event in the window ───────────────────────────────────────
const HAPPENING_ICON = {
  deal:    <PackageCheck size={14} />,
  payment: <Banknote size={14} />,
  invoice: <FileText size={14} />,
};
const HAPPENING_TONE = {
  deal:    "bg-success-bg text-success-ink",
  payment: "bg-accent/10 text-accent-hover",
  invoice: "bg-surface-2 text-ink-2",
};

function HappeningRow({ h, showDate }: { h: Happening; showDate: boolean }) {
  const amountCls = h.signed ? moneyCls(h.amount) : "text-ink";
  const body = (
    <>
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${HAPPENING_TONE[h.kind]}`}>
        {HAPPENING_ICON[h.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate">{h.title}</div>
        <div className="text-[11px] text-muted truncate">
          {showDate && <>{parseLocalDay(h.on).toLocaleDateString("en-US", { weekday: "short" })} &middot; </>}
          {h.meta}
        </div>
      </div>
      <span className={`text-[13px] font-semibold tabular-nums flex-shrink-0 ${amountCls}`}>
        {/* The app writes a loss as −$1,350.00, never $-1,350.00: fmtAmount only
            ever prefixes the dollar sign, so the sign is placed here. */}
        {h.amount < 0 ? `−${fmtAmount(Math.abs(h.amount))}` : fmtAmount(h.amount)}
      </span>
    </>
  );
  if (!h.invoiceNumber) return <div className="flex items-center gap-3 px-5 py-3">{body}</div>;
  return (
    <button onClick={() => openDeal(h.invoiceNumber)}
      className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors duration-[130ms] group">
      {body}
      <ArrowRight size={13} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[130ms] flex-shrink-0" />
    </button>
  );
}

// ─── One thing waiting on you ───────────────────────────────────────────────
const ACTION_TONE = {
  danger:  "bg-danger-bg text-danger-ink",
  warning: "bg-warning-bg text-warning-ink",
  success: "bg-success-bg text-success-ink",
  neutral: "bg-surface-2 text-ink-2",
};

function ActionRow({ tone, icon, title, sub, amount, onClick }: {
  tone: keyof typeof ACTION_TONE; icon: React.ReactNode;
  title: string; sub: string; amount?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors duration-[130ms] group">
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${ACTION_TONE[tone]}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate">{title}</div>
        <div className="text-[11px] text-muted truncate">{sub}</div>
      </div>
      {amount && <span className="text-[13px] font-bold text-ink tabular-nums flex-shrink-0">{amount}</span>}
      <ArrowRight size={13} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[130ms] flex-shrink-0" />
    </button>
  );
}

// ─── One overdue invoice, named so it can actually be chased ────────────────
function OverdueRow({ item }: { item: ARItem }) {
  return (
    <button onClick={() => openDeal(item.invoice_number)}
      className="w-full flex items-center gap-3 pl-16 pr-5 py-2.5 text-left hover:bg-surface-2/40 transition-colors duration-[130ms] group">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-ink truncate">{item.client_name}</div>
        <div className="text-[11px] text-muted truncate">{item.invoice_number} &middot; due {shortDate(item.due_date)}</div>
      </div>
      <StatusPill tone={item.days_overdue > 30 ? "danger" : "warning"}>
        {item.days_overdue}d late
      </StatusPill>
      <span className="text-[12.5px] font-medium text-ink tabular-nums flex-shrink-0 w-24 text-right">{fmtAmount(item.amount)}</span>
    </button>
  );
}

// ─── One at-risk line ───────────────────────────────────────────────────────
function RiskRow({ icon, tone, title, value, onClick }: {
  icon: React.ReactNode; tone: keyof typeof ACTION_TONE; title: string; value: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-surface-2/40 transition-colors duration-[130ms]">
      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${ACTION_TONE[tone]}`}>{icon}</span>
      <span className="text-[12.5px] text-ink-2 min-w-0 flex-1 truncate">{title}</span>
      <span className="text-[12.5px] font-semibold text-ink tabular-nums flex-shrink-0">{value}</span>
    </button>
  );
}

// ─── One counted figure ─────────────────────────────────────────────────────
function CountCell({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <div className="px-5 py-4 flex items-center gap-3 min-w-0">
      <span className="w-9 h-9 rounded-xl bg-surface-2 text-ink-2 flex items-center justify-center flex-shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[22px] font-bold text-ink leading-none tabular-nums">{value}</div>
        <div className="text-[11px] text-muted mt-1 leading-tight">{label}</div>
      </div>
    </div>
  );
}

// ─── Profit split box ───────────────────────────────────────────────────────
function SplitBox({ accent, accentBg, accentBorder, label, value }: {
  accent: string; accentBg: string; accentBorder: string; label: string; value: string;
}) {
  return (
    <div className="rounded-xl p-4 text-center min-w-0"
      style={{ background: accentBg, border: `1px solid ${accentBorder}`, borderTop: `2.5px solid ${accent}` }}>
      <div className="text-[12.5px] font-medium text-ink-2 mb-2 truncate">{label}</div>
      <div className="text-[20px] font-bold text-ink tabular-nums truncate">{value}</div>
    </div>
  );
}
