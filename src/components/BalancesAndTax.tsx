import { Fragment, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, BankBalance, FinancialsOverview, MoneyConfig, TaxMonths } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-617/R-618/R-621 (Jack, 2026-11): the tax is what would be owed if today were tax day, on the books' net income so
// far this year (the same figure as the Tax report below), month by month from the server, held against the savings
// he keeps for it.
//
// R-689 (Jack, 2026-11-24): "allow me to select two accounts at least for the tax page and makw it a cooler dashboard
// that makes it clear as day how much money was netted each month and how much should be put aside each month and the
// if tax season was today we would need to owe x ammount." So this page is a dashboard and nothing else:
//   - the top line answers the three questions at a glance: what would be owed today, what the tax savings hold, and
//     whether that is short or ahead (with what to move for the month just ended);
//   - month by month, one row each: what was netted (a bar and the figure) and what to set aside for it;
//   - the tax savings are any number of his checking and savings accounts, ticked here, added together.
// The list of every account, with its books check, left this page: it is Accounts (R-659, R-688), which checks itself.

type Overview = FinancialsOverview & {
  /** R-689: one account key per line. */
  reserve_account_key?: string;
  reserve_account_linked?: boolean;
  reserve_parked?: number;
  tax_base?: number;
  tax_paid?: number;
  tax_should_have?: number;
  /** R-665: this year's transfers on the tax savings accounts by the books, and this year's rows with no category
   *  the books know (they are not in net income yet). */
  tax_extra?: { reserve_in_year: number; reserve_out_year: number; uncategorised_in: number; uncategorised_out: number; uncategorised_rows: number };
  tax_sweep_pct?: number;
};

const monthName = (k: string, long?: boolean) => {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: long ? "long" : "short" });
};
const signed = (n: number) => `${n < 0 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

function Line({ label, value, strong, tag }: { label: React.ReactNode; value: string; strong?: boolean; tag?: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 min-w-0">
      <span className={`min-w-0 flex-1 text-[13px] ${strong ? "font-medium text-ink" : "text-ink-2"}`}>
        {label}{tag && <span className="text-[11.5px] text-muted ml-2">{tag}</span>}
      </span>
      <span className={`text-[13px] tabular-nums text-right flex-shrink-0 ${strong ? "font-medium text-ink" : "text-ink-2"}`}>{value}</span>
    </div>
  );
}

export default function BalancesAndTax({ onToBook }: { onCheckBooks?: () => void; onToBook?: () => void; onOpenRow?: (id: string, amount: number) => void }) {
  const [accounts, setAccounts] = useState<BankBalance[] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [tm, setTm] = useState<TaxMonths | null>(null);
  const [cfg, setCfg] = useState<MoneyConfig | null>(null);
  const [rateStr, setRateStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    return Promise.all([
      api.bankBalances().then((b) => setAccounts(b.accounts)).catch(() => setAccounts([])),
      api.financialsOverview().then((v) => setOv(v as Overview)).catch(() => setOv(null)),
      api.payouts.taxMonths().then(setTm).catch(() => setTm(null)),
      api.getMoneyConfig().then((c) => { setCfg(c); setRateStr(String(Math.round(c.tax_sweep_pct * 10000) / 100)); }).catch(() => setCfg(null)),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { load(); }).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // Saving needs the stored figures read back first, so a failed read can never be saved over them as zeros.
  const save = async (patch: { taxPct?: number; reserveKey?: string }) => {
    if (!cfg || !ov) { toast("Your saved settings could not be read, so nothing was saved. Refresh and try again.", "error"); return; }
    setSaving(true);
    try {
      await invoke<void>("set_money_config", {
        bankBalance: cfg.bank_balance,
        creditCardBalance: cfg.credit_card_balance,
        cashFloor: cfg.cash_floor,
        taxSweepPct: patch.taxPct ?? cfg.tax_sweep_pct,
        refundReservePct: cfg.refund_reserve_pct,
        warChest: cfg.war_chest,
        publishManual: ov.balance_source === "manual",
        reserveAccountKey: patch.reserveKey ?? ov.reserve_account_key ?? "",
      });
      await load();
      toast("Saved");
    } catch (e: unknown) {
      toast(String((e as Error)?.message || e), "error");
    } finally {
      setSaving(false);
    }
  };

  const saveRate = () => {
    const n = Number(rateStr.trim().replace(/[%\s]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100) { toast("The tax rate is a percentage from 0 to 100", "error"); return; }
    save({ taxPct: n / 100 });
  };

  const list = accounts ?? [];
  // R-689: the tax savings accounts, one key per line of the setting.
  const keys = (ov?.reserve_account_key ?? "").split("\n").map((k) => k.trim()).filter(Boolean);
  const choices = list.filter((a) => a.type === "depository");
  const savings = choices.filter((a) => keys.includes(a.key));
  const toggle = (key: string) => save({ reserveKey: (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]).join("\n") });
  const where = savings.length === 0 ? "" : savings.length === 1 ? savings[0].name : `${savings.length} accounts`;

  // R-621: what would be owed if today were tax day, from this computer's books: net income so far this year at the
  // rate, less the estimated tax already paid. The server's months say how each month moved it.
  const netIncome = ov?.tax_base ?? 0;
  const taxYear = ov?.tax_reserve ?? 0;
  const taxPaid = ov?.tax_paid ?? 0;
  const owedToday = ov?.tax_should_have ?? 0;
  const held = savings.reduce((s, a) => s + a.balance, 0);
  const short = Math.max(0, owedToday - held);
  const over = Math.max(0, held - owedToday);
  const uncatRows = ov?.tax_extra?.uncategorised_rows ?? 0;
  const uncatIn = ov?.tax_extra?.uncategorised_in ?? 0;
  const uncatOut = ov?.tax_extra?.uncategorised_out ?? 0;
  const putIn = ov?.tax_extra?.reserve_in_year ?? 0;
  const tookOut = ov?.tax_extra?.reserve_out_year ?? 0;
  const ratePct = Math.round((ov?.tax_sweep_pct ?? tm?.rate ?? 0.3) * 1000) / 10;

  const monthNet = (m: TaxMonths["months"][number]) => m.net ?? m.base;
  const months = tm ? tm.months.filter((m) => Math.abs(monthNet(m)) > 0.005 || Math.abs(m.due) > 0.005) : [];
  const biggest = Math.max(1, ...months.map((m) => Math.abs(monthNet(m))));
  const lastMonth = tm ? [...tm.months].reverse().find((m) => m.closed) : undefined;
  const thisMonth = tm?.months.find((m) => !m.closed);
  // R-667: the tax is on the year so far, so a month adds nothing while the year is still at a loss.
  const yearSoFar = new Map<string, number>();
  if (tm) { let run = 0; for (const m of tm.months) { run += monthNet(m); yearSoFar.set(m.month, run); } }
  const setAsideTotal = months.reduce((s, m) => s + m.due, 0);

  // The top line: three answers and the next thing to do.
  const position: [string, string, string, string] = savings.length === 0
    ? ["Tax savings", "None picked", "Tick the accounts you keep tax money in, below", "text-muted"]
    : short >= 0.005
      ? ["Short by", fmtAmount(short), `Move it into ${where} to be covered`, "text-danger-ink"]
      : over >= 0.005
        ? ["Ahead by", fmtAmount(over), "More than you would owe today", "text-success-ink"]
        : ["Covered", fmtAmount(held), "Exactly what you would owe today", "text-success-ink"];
  const figures: [string, string, string, string][] = [
    ["Owed if tax day were today", fmtAmount(owedToday), `${ratePct}% of ${signed(netIncome)} net income this year${taxPaid > 0.005 ? `, less ${fmtAmount(taxPaid)} already paid` : ""}`, "text-ink"],
    ["In tax savings now", savings.length ? fmtAmount(held) : fmtAmount(0), savings.length ? `${where}, from your bank` : "No account picked yet", "text-ink"],
    position,
    lastMonth
      ? [`Set aside for ${monthName(lastMonth.month, true)}`, signed(lastMonth.due), lastMonth.due >= 0 ? `${monthName(lastMonth.month, true)} netted ${signed(monthNet(lastMonth))}` : `${monthName(lastMonth.month, true)} lost money, so less is owed`, "text-ink"]
      : ["Set aside this month", thisMonth ? signed(thisMonth.due) : fmtAmount(0), "So far, not due yet", "text-ink"],
  ];

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">Tax</h3>
          <p className="ui-note mt-0.5">
            What you would owe if today were tax day, what you have put away for it, and what each month added.
            {!tm && " The month by month figures need the server, which could not be reached."}
          </p>
        </div>
        <Button onClick={() => load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>
      <div className="hsep" />
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-x-6 gap-y-4 py-4">
        {figures.map(([label, value, sub, tone], i) => (
          <Fragment key={label}>
            {i > 0 && <div className={`vsep ${i === 2 ? "hidden xl:block" : "hidden sm:block"}`} />}
            <div className="min-w-0">
              <div className="ui-label">{label}</div>
              <div className={`ui-fig mt-1 tabular-nums truncate ${tone}`}>{value}</div>
              <div className="text-[12px] text-muted mt-0.5 leading-snug" title={sub}>{sub}</div>
            </div>
          </Fragment>
        ))}
      </div>
      <div className="hsep" />

      {uncatRows > 0 && (
        <div className="mt-4 rounded-xl px-4 py-3 flex items-start gap-3 bg-warning-bg">
          <AlertTriangle size={18} className="text-warning-ink flex-shrink-0 mt-0.5" />
          <div className="min-w-0 text-[13px]">
            <span className="font-medium text-warning-ink">
              {uncatRows} {uncatRows === 1 ? "transaction is" : "transactions are"} not in these figures yet.
            </span>
            <span className="block text-ink-2 mt-0.5">
              {uncatRows === 1 ? "It has" : "They have"} no category, so {uncatRows === 1 ? "it counts" : "they count"} as neither income nor expense:
              {" "}{fmtAmount(uncatIn)} in and {fmtAmount(uncatOut)} out this year. Sort {uncatRows === 1 ? "it" : "them"} and the tax figure is complete.
              {onToBook && <button onClick={onToBook} className="ml-1.5 font-medium text-ink hover:opacity-70">Open To book</button>}
            </span>
          </div>
        </div>
      )}

      {/* ── Month by month ─────────────────────────────── */}
      <section className="pt-6 min-w-0">
        <div className="grid grid-cols-[72px_minmax(0,1fr)_130px_130px] lg:grid-cols-[110px_minmax(0,1fr)_150px_150px_150px] items-center gap-x-5 pb-2.5">
          <h4 className="text-[14px] font-medium text-ink col-span-2">Month by month</h4>
          <div className="ui-label text-right">Netted</div>
          <div className="ui-label text-right">Set aside</div>
          <div className="ui-label text-right hidden lg:block">Year so far</div>
        </div>
        {months.length === 0 && <p className="ui-note border-t border-line py-4">{tm ? "No month has income or costs in your books yet this year." : "The months could not be read from the server."}</p>}
        {months.map((m) => {
          const net = monthNet(m);
          return (
            <div key={m.month} className="grid grid-cols-[72px_minmax(0,1fr)_130px_130px] lg:grid-cols-[110px_minmax(0,1fr)_150px_150px_150px] items-center gap-x-5 py-3 border-t border-line">
              <div className="text-[14px] font-medium text-ink truncate">
                {monthName(m.month, true)}
                {!m.closed && <span className="block text-[11.5px] font-normal text-muted">so far</span>}
              </div>
              {/* What the month netted, against the best month of the year: ink for a gain, red for a loss. */}
              <div className="h-2.5 rounded-full bg-line overflow-hidden" role="img" aria-label={`${monthName(m.month, true)} netted ${signed(net)}`}>
                <div className={`h-full rounded-full ${net < 0 ? "bg-danger" : "bg-ink"}`} style={{ width: `${Math.max(1.5, (Math.abs(net) / biggest) * 100)}%` }} />
              </div>
              <div className={`text-right text-[15px] font-medium tabular-nums ${net < 0 ? "text-danger-ink" : "text-ink"}`}>{signed(net)}</div>
              <div className={`text-right text-[15px] font-medium tabular-nums ${m.closed ? "text-ink" : "text-muted"}`}>{signed(m.due)}</div>
              <div className="text-right text-[13px] tabular-nums text-muted hidden lg:block">{signed(yearSoFar.get(m.month) ?? 0)}</div>
            </div>
          );
        })}
        {months.length > 0 && (
          <div className="grid grid-cols-[72px_minmax(0,1fr)_130px_130px] lg:grid-cols-[110px_minmax(0,1fr)_150px_150px_150px] items-center gap-x-5 py-3 border-t border-line-3">
            <div className="text-[14px] font-medium text-ink col-span-2">This year</div>
            <div className={`text-right text-[15px] font-medium tabular-nums ${netIncome < 0 ? "text-danger-ink" : "text-ink"}`}>{signed(netIncome)}</div>
            <div className="text-right text-[15px] font-medium tabular-nums text-ink">{signed(setAsideTotal)}</div>
            <div className="hidden lg:block" />
          </div>
        )}
        <p className="text-[12px] text-muted mt-2 leading-snug max-w-3xl">
          Tax is on the year so far, not on one month. While the year is at a loss there is nothing to set aside, and a good month first makes up the earlier losses.
        </p>
      </section>

      {/* ── Where the tax money is kept, and how the figure adds up ─────────────────────────────── */}
      <div className="pt-8 grid grid-cols-1 xl:grid-cols-2 gap-x-12 gap-y-8 min-w-0">
        <section className="min-w-0">
          <h4 className="text-[14px] font-medium text-ink">Tax savings accounts</h4>
          <p className="ui-note mt-0.5">Tick every account you keep tax money in. Their balances are added together.</p>
          <div className="mt-3 border-b border-line">
            {choices.length === 0 && <p className="ui-note border-t border-line py-3">No checking or savings account is connected on this computer.</p>}
            {choices.map((a) => {
              const on = keys.includes(a.key);
              return (
                <label key={a.key} className="flex items-center gap-3 py-3 border-t border-line cursor-pointer min-w-0">
                  <input type="checkbox" checked={on} disabled={saving || !cfg} onChange={() => toggle(a.key)} className="flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] text-ink truncate">{a.name}{a.mask && <span className="text-muted tabular-nums"> ··{a.mask}</span>}</span>
                    <span className="block text-[12px] text-muted truncate">{a.institution}{a.subtype ? ` · ${a.subtype}` : ""}</span>
                  </span>
                  <span className={`text-[13.5px] tabular-nums flex-shrink-0 ${on ? "font-medium text-ink" : "text-muted"}`}>{fmtAmount(a.balance)}</span>
                </label>
              );
            })}
          </div>
          {savings.length > 1 && <Line label={`In ${savings.length} accounts`} value={fmtAmount(held)} strong />}

          <h4 className="text-[14px] font-medium text-ink mt-6">Tax rate</h4>
          <p className="ui-note mt-0.5">The share of your net income you keep for tax. Set it with your accountant.</p>
          <div className="flex items-center gap-2 mt-2">
            <div className="relative w-28">
              <input inputMode="decimal" value={rateStr} onChange={(e) => setRateStr(e.target.value)} disabled={!cfg}
                className="w-full border border-line-3 rounded-lg h-9 pl-2.5 pr-7 text-[13.5px] text-ink bg-surface tabular-nums focus:outline-none focus:border-accent" />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-[12px]">%</span>
            </div>
            <Button onClick={saveRate} disabled={saving || !cfg}>Save</Button>
          </div>
        </section>

        <section className="min-w-0">
          <h4 className="text-[14px] font-medium text-ink">How it adds up</h4>
          <div className="mt-3 divide-y divide-line border-y border-line">
            <Line label="Net income so far this year" tag="from your books" value={signed(netIncome)} />
            <Line label={`Tax at ${ratePct}%`} tag={netIncome <= 0 ? "nothing owed on a loss" : undefined} value={fmtAmount(taxYear)} />
            {taxPaid > 0.005 && <Line label="Estimated tax already paid this year" value={`-${fmtAmount(taxPaid)}`} />}
            <Line label="Owed if tax day were today" value={fmtAmount(owedToday)} strong />
            {savings.length > 0 && <Line label="Moved into tax savings this year" tag="from your books" value={fmtAmount(putIn)} />}
            {savings.length > 0 && tookOut > 0.005 && <Line label="Taken out of tax savings this year" value={`-${fmtAmount(tookOut)}`} />}
            {savings.length > 0 && <Line label="In tax savings now" tag="the bank's balance" value={fmtAmount(held)} strong />}
            {savings.length > 0 && short >= 0.005 && <Line label="Short by" value={fmtAmount(short)} strong />}
            {savings.length > 0 && short < 0.005 && over >= 0.005 && <Line label="Ahead by" value={fmtAmount(over)} strong />}
          </div>
        </section>
      </div>
    </div>
  );
}
