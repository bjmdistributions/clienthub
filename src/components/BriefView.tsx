import { useEffect, useMemo, useState } from "react";
import { api, WeeklyBrief, DealFlow, ReceivablesAging, ARItem, Client, Invoice, Me, type LogisticsPayTracker } from "../lib/api";
import { billsApi, type BillsAlerts } from "../lib/billsApi";
import { alertRow } from "../lib/billsFormat";
import { can, isAdmin } from "../lib/permissions";
import { fmtAmount, localDay, parseLocalDay } from "../lib/format";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { LogisticsPayBriefBlock } from "./LogisticsPay";
import { Button, PageActions, Tabs, useCountUp } from "./ui";
import {
  RefreshCw, Printer, ChevronRight, CheckCircle2, CalendarClock, Clock,
  Banknote, FileText, Truck, TriangleAlert, Users, Receipt, PackageCheck,
} from "lucide-react";

/** Bare day out of either a `YYYY-MM-DD` or a full timestamp. */
const day = (s?: string | null) => (s ? s.slice(0, 10) : "");

/** "Sep 4": dates on this screen are read at a glance, not filed. */
const shortDate = (s?: string | null) =>
  (s ? parseLocalDay(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

/** Green for profit, red for a loss, plain ink for nothing yet. Zero is
 *  neither, and the semantic hues only ever carry one of those two meanings. */
const moneyCls = (n: number) => (n > 0 ? "text-success-ink" : n < 0 ? "text-danger-ink" : "text-ink");

/** The app writes a loss as -$1,350.00, never $-1,350.00: fmtAmount only ever prefixes
 *  the dollar sign, so the sign is placed here. */
const signedAmt = (n: number) => (n < 0 ? `−${fmtAmount(Math.abs(n))}` : fmtAmount(n));

/** Monday of the week `d` falls in, computed locally (R-159 date rules).
 *  Deliberately NOT read off `brief.week_start`: that window follows the stored
 *  brief cadence, and this screen is today and this week only. */
function mondayOf(d: string): string {
  const dt = parseLocalDay(d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return localDay(dt);
}

const goTab = (tab: string) => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: tab }));

/** Drill into the deal behind an invoice: the same stash-then-switch handoff
 *  the client screen uses. */
const openDeal = (invoiceNumber: string) => {
  try { localStorage.setItem("dealflow_invoice_filter", invoiceNumber); } catch { /* ignore */ }
  goTab("dealflow");
};

type Scope = "today" | "week";

/** The pickup/delivery gate on completing a deal (R-154): held while the delivery date, or the
 *  pickup date when there is none, is still ahead. A deal that ships direct has no gate. */
const heldByShipping = (f: DealFlow, today: string): boolean => {
  if (f.ships_direct) return false;
  const date = day(f.expected_delivery_date) || day(f.pickup_date);
  return !!date && date > today;
};

/** One thing that happened in the window, whatever produced it. */
type Happening = {
  key: string;
  on: string;
  kind: "deal" | "payment" | "invoice";
  title: string;
  meta: string;
  amount: number;
  signed: boolean;   // profit figure: green when up, red when down
  invoiceNumber: string;
};

// The profit split bar wears ink at falling strengths: identity is the name beside it, not a hue.
const SPLIT_ALPHA = [0.9, 0.62, 0.42, 0.28, 0.18, 0.12];

export default function BriefView({ currentUser, me }: { currentUser?: any; me?: Me | null }) {
  // Org-wide detail (whose invoice, which deal, how much) stays with the people
  // who already see the numbers; a rep gets the brief's own rep-filtered figures.
  const showOrg = currentUser?.role !== "sales_rep";
  // R-449: bills read like the books, so the same people see them here.
  const showBills = showOrg && (isAdmin(me) || can(me, "financials:view"));

  const [brief, setBrief]         = useState<WeeklyBrief | null>(null);
  const [flows, setFlows]         = useState<DealFlow[]>([]);
  const [invoices, setInvoices]   = useState<Invoice[]>([]);
  const [ar, setAr]               = useState<ReceivablesAging | null>(null);
  const [followups, setFollowups] = useState<Client[]>([]);
  // R-401: the logistics pay, for an owner only. Anyone the server will not show it to gets nothing.
  const [logiPay, setLogiPay]     = useState<LogisticsPayTracker | null>(null);
  // R-449: bills that are overdue or due within three days. Null for anyone who may not see bills.
  const [billAlerts, setBillAlerts] = useState<BillsAlerts | null>(null);
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
      // The screen asks for the window it is labelling (7 = this Monday to Sunday week),
      // rather than leaning on the org-shared cadence, which follows the emailed brief.
      const b = await api.generateWeeklyBrief(null, repName, 7);
      setBrief(b);
      // R-577: "Where the profit went" and a rep's earnings come from the server's commission
      // ledger (this computer holds none of it), so they agree with every deal's Payouts. When the
      // server cannot answer, the figures worked out here stay.
      const next = (d: string, months = 0) => { const x = parseLocalDay(d); return localDay(new Date(x.getFullYear(), x.getMonth() + months, x.getDate() + (months ? 0 : 1))); };
      const monthFrom = `${localDay().slice(0, 7)}-01`;
      api.payouts.brief(b.week_start, next(b.week_end), monthFrom, next(monthFrom, 1))
        .then((r) => setBrief((cur) => cur === b ? {
          ...b,
          // A rep's brief covers their own deals: the business-wide rows are not theirs to see.
          payout_totals: repName ? b.payout_totals : r.payout_totals,
          rep_earnings_this_week: repName ? (r.mine_this_week ?? 0) : b.rep_earnings_this_week,
        } : cur))
        .catch(() => {});
    } catch (e: any) { toast(String(e), "error"); }
    if (showOrg) {
      api.listDealFlows().then(setFlows).catch(() => {});
      api.listInvoices().then(setInvoices).catch(() => {});
      api.getReceivablesAging().then(setAr).catch(() => setAr(null));
      api.logistics.pay.tracker().then(setLogiPay).catch(() => setLogiPay(null));
    }
    if (showBills) billsApi.alerts().then(setBillAlerts).catch(() => setBillAlerts(null));
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
      meta: `Deal completed${f.invoice_number ? `, ${f.invoice_number}` : ""}`,
      amount: f.net_profit || 0, signed: true, invoiceNumber: f.invoice_number || "",
    }));
    paidIn.forEach((f) => out.push({
      key: `p-${f.id}`, on: day(f.payment_received_at), kind: "payment",
      title: f.client_name || f.name || "Payment",
      meta: `Payment in${f.payment_received_method ? `, ${f.payment_received_method}` : ""}`,
      amount: f.payment_received_amount || 0, signed: false, invoiceNumber: f.invoice_number || "",
    }));
    sent.forEach((i) => {
      const who = invoiceClient[i.id];
      out.push({
        key: `i-${i.id}`, on: day(i.sent_at), kind: "invoice",
        title: who || `Invoice ${i.number}`,
        meta: who ? `Invoice ${i.number} sent, due ${shortDate(i.due_date)}`
                  : `Sent, due ${shortDate(i.due_date)}`,
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
  // R-401: a deal is ready to close once the buyer has paid. Nothing tracks the supplier being
  // paid any more, so the stage that used to mean "ready" is no longer reached by a button. A
  // deal whose pickup or delivery is still ahead is held by the shipping gate, so it waits.
  const readyToClose = useMemo(
    () => flows.filter((f) => (f.stage === "payment_received" || f.stage === "supplier_paid") && !heldByShipping(f, today)),
    [flows, today],
  );

  // ── What is at risk ───────────────────────────────────────────────────────
  const aged = useMemo(() => (ar?.items ?? []).filter((i) => i.days_overdue > 30), [ar]);
  const agedValue = aged.reduce((s, i) => s + i.amount, 0);
  const speculative = useMemo(() => (ar?.items ?? []).filter((i) => !i.committed), [ar]);
  const speculativeValue = speculative.reduce((s, i) => s + i.amount, 0);
  const slipping = useMemo(
    () => flows.filter((f) => f.stage !== "complete" && f.expected_delivery_date && day(f.expected_delivery_date) < today),
    [flows, today],
  );

  const billRow = alertRow(billAlerts);
  const needsNothing = overdue.length === 0 && followups.length === 0 && readyToClose.length === 0 && !billRow;
  const riskNothing = aged.length === 0 && speculative.length === 0 && slipping.length === 0;

  const scopeWord = scope === "today" ? "today" : "this week";
  const dateLine = scope === "today"
    ? parseLocalDay(today).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : `${parseLocalDay(weekStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${parseLocalDay(today).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  // The profit split: the share each recipient took of the week's net profit.
  const split = brief?.payout_totals ?? [];
  const splitSum = split.reduce((s, r) => s + Math.max(0, r.this_week), 0);
  const netWeek = brief?.net_profit_this_week ?? 0;

  return (
    <div className="print-area">
      <PageActions>
        <Tabs label="Window" value={scope} onChange={(id) => setScope(id as Scope)}
          tabs={[{ id: "today", label: "Today" }, { id: "week", label: "This week" }]} />
        <Button onClick={load} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>Refresh</Button>
        <Button variant="ink" onClick={() => window.print()} icon={<Printer size={14} />}>Print</Button>
      </PageActions>

      <div className="text-[13px] text-muted mt-1 mb-2">{dateLine}</div>

      {loading && !brief ? (
        <div className="space-y-4" aria-busy="true">
          <div className="h-[128px] rounded-xl bg-surface-2 animate-pulse" />
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_1px_328px] gap-x-2 gap-y-4">
            <div className="h-72 rounded-xl bg-surface-2 animate-pulse" />
            <div className="hidden xl:block" />
            <div className="h-72 rounded-xl bg-surface-2 animate-pulse" />
          </div>
        </div>
      ) : (
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_1px_328px] xl:gap-x-2 animate-fade-up motion-reduce:animate-none">

        {/* ── Left: what happened, what needs you, where the profit went ── */}
        <div className="min-w-0">

          <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-1">
            <div>
              <div className="text-[14px] font-medium leading-5">What happened {scopeWord}</div>
              <div className="ui-note mt-0.5">Deals closed out, money in, invoices sent</div>
            </div>
            <span className="ui-count">{happenings.length}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
            <Tile label="Deals completed" value={completed.length}
              sub={completed.length > 0 ? `${fmtAmount(dealRevenue)} revenue` : "Nothing closed out yet"} />
            <div className="vsep hidden md:block mt-4" />
            <Tile label="Profit booked" value={dealProfit} money valueCls={moneyCls(dealProfit)}
              sub="From completed deals only" />
            <div className="vsep hidden md:block mt-4" />
            <Tile label="Money in" value={moneyIn} money
              sub={`${paidIn.length} buyer payment${paidIn.length !== 1 ? "s" : ""}`} />
            <div className="vsep hidden md:block mt-4" />
            <Tile label="Invoices sent" value={sent.length}
              sub={sent.length > 0 ? fmtAmount(sentTotal) : "None sent yet"} />
          </div>

          <div className="hsep" />

          <div className="py-2 px-1">
            {happenings.length === 0 ? (
              <div className="py-7 text-[13px] text-muted text-center">
                Nothing has been recorded {scopeWord} yet.
              </div>
            ) : (
              <>
                {happenings.slice(0, 8).map((h) => (
                  <HappeningRow key={h.key} h={h} showDate={scope === "week"} />
                ))}
                {happenings.length > 8 && (
                  <div className="ui-note px-3 pt-2.5 pb-1">
                    {happenings.length - 8} more {scope === "today" ? "today" : "this week"}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="hsep" />

          <div className="px-4 pt-5 pb-2">
            <div className="text-[14px] font-medium leading-5">What needs you now</div>
            <div className="ui-note mt-0.5">Chasing, calls and deals waiting on a step from you</div>
          </div>

          <div className="px-1 pb-4">
            {needsNothing ? (
              <div className="py-8 flex flex-col items-center gap-2 text-muted">
                <CheckCircle2 size={18} className="text-success-ink" />
                <div className="text-[13px]">All clear, nothing needs you right now</div>
              </div>
            ) : (
              <div className="[&>button+button]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                {overdue.length > 0 && (
                  <ActionRow
                    tone="danger" icon={<CalendarClock size={18} />}
                    title={`${overdue.length} invoice${overdue.length !== 1 ? "s" : ""} overdue`}
                    sub="Chase these first"
                    amount={fmtAmount(overdueValue)} amountCls="text-danger-ink"
                    onClick={() => goTab("dealflow")}
                  />
                )}
                {overdue.slice(0, 4).map((i) => <OverdueRow key={i.invoice_id} item={i} />)}
                {overdue.length > 4 && (
                  <button onClick={() => goTab("dealflow")}
                    className="w-full flex items-center gap-1.5 pl-[42px] pr-3 py-2.5 text-left text-[13px] text-muted hover:text-ink rounded-[10px] hover:bg-surface-2 transition-colors duration-[130ms]">
                    {overdue.length - 4} more overdue <ChevronRight size={13} className="text-faint" />
                  </button>
                )}

                {billRow && (
                  <ActionRow
                    tone={billRow.tone} icon={<Receipt size={18} />}
                    title={billRow.title} sub={billRow.sub}
                    onClick={() => goTab("bills")}
                  />
                )}

                {followups.length > 0 && (
                  <ActionRow
                    tone="warning" icon={<Clock size={18} />}
                    title={`${followups.length} follow-up${followups.length !== 1 ? "s" : ""} due`}
                    sub={followups.slice(0, 3).map((c) => c.name).join(", ") + (followups.length > 3 ? "..." : "")}
                    onClick={() => goTab("clients")}
                  />
                )}

                {readyToClose.length > 0 && (
                  <ActionRow
                    tone="success" icon={<PackageCheck size={18} />}
                    title={`${readyToClose.length} deal${readyToClose.length !== 1 ? "s" : ""} ready to close out`}
                    sub="The buyer has paid: complete them to book the profit"
                    onClick={() => goTab("dealflow")}
                  />
                )}
              </div>
            )}
          </div>

          {/* ── Where the profit went ─────────────────────────────────── */}
          {brief && (
            <>
              <div className="hsep" />
              <div className="px-4 pt-5 pb-2 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium leading-5">Where the profit went</div>
                  <div className="ui-note mt-0.5">
                    Who earned what from deals, {shortDate(brief.week_start)} to {shortDate(brief.week_end)}. Read from the commission ledger, so it agrees with every deal's Payouts.
                  </div>
                </div>
                <div className="text-right">
                  <div className="ui-note">Net profit</div>
                  <div className={`ui-fig !text-[22px] !leading-7 ${moneyCls(brief.net_profit_this_week)}`}>
                    {signedAmt(brief.net_profit_this_week)}
                  </div>
                </div>
              </div>

              {split.length > 0 ? (
                <>
                  {splitSum > 0 && (
                    <div className="px-4 pt-2 pb-1">
                      <div className="flex gap-0.5 h-2.5" aria-hidden="true">
                        {split.map((r, i) => (
                          <span key={i} className="rounded-[3px] transition-[flex-grow] duration-500"
                            style={{
                              flex: `${Math.max(0, r.this_week)} 0 0`,
                              background: `rgb(var(--c-ink) / ${SPLIT_ALPHA[Math.min(i, SPLIT_ALPHA.length - 1)]})`,
                            }} />
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="px-1 pb-1 overflow-x-auto">
                    <table className="ui-table min-w-[480px]">
                      <thead>
                        <tr>
                          <th>Recipient</th>
                          <th className="r">Share</th>
                          <th className="r">This week</th>
                          <th className="r">{parseLocalDay(localDay()).toLocaleString("en-US", { month: "long" })} to date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {split.map((r, i) => (
                          <tr key={i}>
                            <td>
                              <span className="block font-medium truncate max-w-[260px]">{r.name}</span>
                              {(r.kind === "reps" || r.kind === "logistics") && (
                                <span className="block ui-note">Taken off before the owners' split</span>
                              )}
                            </td>
                            <td className="r text-muted">{netWeek !== 0 ? `${Math.round((r.this_week / netWeek) * 100)}%` : ""}</td>
                            <td className="r font-medium">{signedAmt(r.this_week)}</td>
                            <td className="r text-muted">{signedAmt(r.this_month)}</td>
                          </tr>
                        ))}
                        <tr className="font-medium">
                          <td>Net profit</td>
                          <td className="r text-muted">{netWeek !== 0 ? "100%" : ""}</td>
                          <td className={`r ${moneyCls(brief.net_profit_this_week)}`}>{signedAmt(brief.net_profit_this_week)}</td>
                          <td className={`r ${moneyCls(brief.net_profit_this_month)}`}>{signedAmt(brief.net_profit_this_month)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {brief.net_profit_this_month !== 0 && (
                    <div className="ui-note px-4 pt-2.5">
                      {parseLocalDay(localDay()).toLocaleString("en-US", { month: "long" })} so far{" "}
                      <span className="text-ink font-medium tabular-nums">{signedAmt(brief.net_profit_this_month)}</span> profit
                    </div>
                  )}
                </>
              ) : (
                <div className="px-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-[13px] text-muted min-w-0">Set up a payout split to see how each recipient's cut breaks down.</span>
                  <button onClick={() => goTab("settings")} className="ui-link">Set up payout split</button>
                </div>
              )}

              {brief.rep_earnings_this_week > 0 && (
                <div className="mx-4 mt-3 mb-5 flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-[10px] bg-surface-2 ring-1 ring-line">
                  <span className="text-[13px] text-muted min-w-0">Your earnings this period, after any refunds</span>
                  <span className="text-[15px] font-medium text-success-ink tabular-nums">{fmtAmount(brief.rep_earnings_this_week)}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="vsep hidden xl:block" />
        <div className="hsep xl:hidden" />

        {/* ── Right: at risk, logistics pay, people ──────────────────── */}
        <div className="min-w-0">
          <div className="p-4">
            <div className="text-[14px] font-medium leading-5">What is at risk</div>
            <div className="ui-note mt-0.5">Money and dates that have slipped</div>
            {riskNothing ? (
              <div className="py-6 text-[13px] text-muted text-center">Nothing aged or slipping.</div>
            ) : (
              <div className="mt-2 [&>button+button]:shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                {aged.length > 0 && (
                  <RiskRow
                    tone="danger" icon={<TriangleAlert size={16} />}
                    title={`${aged.length} receivable${aged.length !== 1 ? "s" : ""} over 30 days`}
                    value={fmtAmount(agedValue)} valueCls="text-danger-ink" onClick={() => goTab("dealflow")}
                  />
                )}
                {slipping.length > 0 && (
                  <RiskRow
                    tone="warning" icon={<Truck size={16} />}
                    title={`${slipping.length} delivery date${slipping.length !== 1 ? "s" : ""} passed`}
                    value={`${slipping.length} deal${slipping.length !== 1 ? "s" : ""}`}
                    onClick={() => goTab("dealflow")}
                  />
                )}
                {speculative.length > 0 && (
                  <RiskRow
                    icon={<Receipt size={16} />}
                    title={`${speculative.length} invoice${speculative.length !== 1 ? "s" : ""} not yet committed`}
                    value={fmtAmount(speculativeValue)} onClick={() => goTab("dealflow")}
                  />
                )}
              </div>
            )}
          </div>

          {/* R-401: what the logistics person is owed, when, and what is waiting on an amount */}
          {logiPay && (
            <>
              <div className="hsep" />
              <div className="p-4"><LogisticsPayBriefBlock t={logiPay} from={weekStart} onOpen={() => goTab("settings")} /></div>
            </>
          )}

          {/* People and activity: brief-window figures, labelled with that window */}
          {brief && (
            <>
              <div className="hsep" />
              <div className="p-4">
                <div className="text-[14px] font-medium leading-5">New clients and interactions</div>
                <div className="ui-note mt-0.5">{shortDate(brief.week_start)} to {shortDate(brief.week_end)}</div>
                <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] gap-x-3 mt-3.5">
                  <CountCell icon={<Users size={18} />} value={brief.new_clients_this_week} label="new clients" />
                  <div className="vsep" />
                  <CountCell icon={<FileText size={18} />} value={brief.interactions_this_week} label="interactions" />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Where the numbers went (R-316) */}
        <div className="xl:col-span-3">
          <div className="hsep mt-2" />
          <div className="flex items-center justify-between gap-x-4 gap-y-2 flex-wrap px-4 py-3.5">
            <span className="text-[13px] text-muted min-w-0">
              Revenue, margins, monthly history, win rate and what people bought now live on Analytics.
            </span>
            <button onClick={() => goTab("analytics")} className="ui-link print:hidden">Open analytics</button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ─── One figure of the "what happened" row: no box, a fading hairline between them ───
function Tile({ label, value, sub, money, valueCls = "text-ink" }: {
  label: string; value: number; sub?: string; money?: boolean; valueCls?: string;
}) {
  const shown = useCountUp(value) ?? value;
  return (
    <div className="p-4 min-w-0">
      <div className="ui-label truncate">{label}</div>
      <div className={`ui-fig mt-2 ${valueCls}`}>{money ? signedAmt(shown) : Math.round(shown).toLocaleString("en-US")}</div>
      {sub && <div className="ui-note mt-1.5 truncate">{sub}</div>}
    </div>
  );
}

// ─── One recorded event in the window ───────────────────────────────────────
const HAPPENING_ICON = {
  deal:    <PackageCheck size={18} />,
  payment: <Banknote size={18} />,
  invoice: <FileText size={18} />,
};

function HappeningRow({ h, showDate }: { h: Happening; showDate: boolean }) {
  const amountCls = h.signed ? moneyCls(h.amount) : "text-ink";
  const body = (
    <>
      <span className="flex-none text-muted">{HAPPENING_ICON[h.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink truncate">{h.title}</span>
        <span className="block ui-note truncate mt-px">
          {showDate && <>{parseLocalDay(h.on).toLocaleDateString("en-US", { weekday: "short" })}, </>}
          {h.meta}
        </span>
      </span>
      <span className={`text-[14px] font-medium tabular-nums flex-shrink-0 ${amountCls}`}>{signedAmt(h.amount)}</span>
    </>
  );
  const row = "flex items-center gap-3 min-h-[56px] px-3 py-2 rounded-[10px] w-full text-left";
  if (!h.invoiceNumber) return <div className={row}>{body}</div>;
  return (
    <button onClick={() => openDeal(h.invoiceNumber)} title="Open the deal"
      className={`${row} group hover:bg-surface-2 transition-colors duration-[130ms]`}>
      {body}
      <ChevronRight size={14} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[130ms] flex-shrink-0" />
    </button>
  );
}

// ─── One thing waiting on you ───────────────────────────────────────────────
// Meaning is carried by the icon's ink alone (no tinted chip): red late, amber due soon, green ready.
const TONE_INK = { danger: "text-danger-ink", warning: "text-warning-ink", success: "text-success-ink", neutral: "text-muted" };
type Tone = keyof typeof TONE_INK;

function ActionRow({ tone = "neutral", icon, title, sub, amount, amountCls = "text-ink", onClick }: {
  tone?: Tone; icon: React.ReactNode; title: string; sub: string; amount?: string; amountCls?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 min-h-[54px] px-3 py-2 text-left rounded-[10px] group hover:bg-surface-2 transition-colors duration-[130ms]">
      <span className={`flex-none ${TONE_INK[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink truncate">{title}</span>
        <span className="block ui-note truncate">{sub}</span>
      </span>
      {amount && <span className={`text-[14px] font-medium tabular-nums flex-shrink-0 ${amountCls}`}>{amount}</span>}
      <ChevronRight size={14} className="text-faint opacity-0 group-hover:opacity-100 transition-opacity duration-[130ms] flex-shrink-0" />
    </button>
  );
}

// ─── One overdue invoice, named so it can actually be chased ────────────────
function OverdueRow({ item }: { item: ARItem }) {
  return (
    <button onClick={() => openDeal(item.invoice_number)}
      className="w-full flex items-center gap-3 min-h-[48px] pl-[42px] pr-3 py-2 text-left rounded-[10px] hover:bg-surface-2 transition-colors duration-[130ms]">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] text-ink truncate">{item.client_name}</span>
        <span className="block ui-note truncate">{item.invoice_number}, due {shortDate(item.due_date)}</span>
      </span>
      <StatusPill tone={item.days_overdue > 30 ? "danger" : "warning"}>
        {item.days_overdue}d late
      </StatusPill>
      <span className="text-[13.5px] text-ink tabular-nums flex-shrink-0 w-24 text-right">{fmtAmount(item.amount)}</span>
    </button>
  );
}

// ─── One at-risk line ───────────────────────────────────────────────────────
function RiskRow({ tone = "neutral", icon, title, value, valueCls = "text-ink", onClick }: {
  tone?: Tone; icon: React.ReactNode; title: string; value: string; valueCls?: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 min-h-[46px] py-2 text-left text-[13px] text-ink-2 hover:text-ink transition-colors duration-[130ms]">
      <span className={`flex-none ${TONE_INK[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className={`font-medium tabular-nums flex-shrink-0 ${valueCls}`}>{value}</span>
    </button>
  );
}

// ─── One counted figure ─────────────────────────────────────────────────────
function CountCell({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  const shown = useCountUp(value) ?? value;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="flex-none text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="ui-fig !text-[22px] !leading-7">{Math.round(shown).toLocaleString("en-US")}</div>
        <div className="ui-note">{label}</div>
      </div>
    </div>
  );
}
