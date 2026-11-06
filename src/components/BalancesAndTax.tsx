import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, BankBalance, FinancialsOverview, MoneyConfig, TaxMonths } from "../lib/api";
import DriftPanel from "./DriftPanel";
import { fmtAmount } from "../lib/format";
import { RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "./Toast";
import { Button, Kpi } from "./ui";
import StatusPill from "./StatusPill";

// R-618 (Jack, 2026-11-05): Free cash is gone. The top of Balances and tax: every connected account and its balance,
// grouped, each with the books check (does the ledger agree with the bank on it; R-622: Off by opens why and the fix);
// then the tax savings, checked against the savings account he picks here, green when it holds what it should and
// its books agree. R-621: the tax is what would be owed if today were tax day, on the books' net income so far this
// year (the same figure as the Tax report below), month by month from the server. The Tax report sits below.

type Overview = FinancialsOverview & {
  reserve_account_key?: string;
  reserve_account_label?: string;
  reserve_account_linked?: boolean;
  reserve_parked?: number;
  tax_base?: number;
  tax_paid?: number;
  tax_should_have?: number;
  tax_sweep_pct?: number;
  reserve_ledger_year?: number;
  reserve_mask?: string;
  reserve_drift?: number | null;
};

const monthName = (k: string, long?: boolean) => {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: long ? "long" : "short" });
};

const GROUPS: { id: string; title: string; match: (a: BankBalance) => boolean }[] = [
  { id: "bank", title: "Checking and savings", match: (a) => a.type === "depository" },
  { id: "credit", title: "Credit cards", match: (a) => a.type === "credit" },
  { id: "loan", title: "Loans", match: (a) => a.type === "loan" },
  { id: "other", title: "Other accounts", match: (a) => !["depository", "credit", "loan"].includes(a.type) },
];

function Line({ label, value, strong, muted, tag }: { label: React.ReactNode; value: string; strong?: boolean; muted?: boolean; tag?: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 min-w-0">
      <span className={`min-w-0 flex-1 text-[13px] ${strong ? "font-medium text-ink" : muted ? "text-muted" : "text-ink-2"}`}>
        {label}{tag && <span className="text-[11px] text-faint ml-2">{tag}</span>}
      </span>
      <span className={`text-[13px] tabular-nums w-32 text-right flex-shrink-0 ${strong ? "font-medium text-ink" : muted ? "text-muted" : "text-ink-2"}`}>{value}</span>
    </div>
  );
}

export default function BalancesAndTax({ onCheckBooks, onOpenRow }: { onCheckBooks?: () => void; onOpenRow?: (id: string, amount: number) => void }) {
  const [openDrift, setOpenDrift] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BankBalance[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [tm, setTm] = useState<TaxMonths | null>(null);
  const [cfg, setCfg] = useState<MoneyConfig | null>(null);
  const [rateStr, setRateStr] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    return Promise.all([
      // R-622: the books check runs first, so an account connected since takes its starting point today (R-618
      // dropped the Free cash load that did this).
      api.reconcileAccounts().catch(() => null).then(() => api.bankBalances())
        .then((b) => { setAccounts(b.accounts); setLastSync(b.last_sync); }).catch(() => setAccounts([])),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const cash = list.filter((a) => a.type === "depository").reduce((s, a) => s + a.balance, 0);
  const owed = list.filter((a) => a.type === "credit").reduce((s, a) => s + Math.abs(a.balance), 0);
  const loans = list.filter((a) => a.type === "loan").reduce((s, a) => s + Math.abs(a.balance), 0);
  const reserveKey = ov?.reserve_account_key ?? "";
  const savingsChoices = list.filter((a) => a.type === "depository");
  const savings = list.find((a) => a.key === reserveKey);

  // R-621: what would be owed if today were tax day, from this computer's books: net income so far this year at the
  // rate, less the estimated tax already paid. The server's months say how each month moved it.
  const netIncome = ov?.tax_base ?? 0;
  const taxYear = ov?.tax_reserve ?? 0;
  const taxPaid = ov?.tax_paid ?? 0;
  const taxShould = ov?.tax_should_have ?? 0;
  const target = taxShould;
  const held = savings ? savings.balance : 0;
  const short = Math.max(0, target - held);
  const drift = savings?.drift ?? null;
  const booksAgree = drift == null || Math.abs(drift) < 0.005;
  const clear = !!savings && short < 0.005 && booksAgree;
  const lastMonth = tm ? [...tm.months].reverse().find((m) => m.closed) : undefined;
  const thisMonth = tm?.months.find((m) => !m.closed);
  const monthNet = (m: TaxMonths["months"][number]) => m.net ?? m.base;
  const monthRows = tm ? tm.months.filter((m) => Math.abs(monthNet(m)) > 0.005 || Math.abs(m.due) > 0.005) : [];
  const ratePct = Math.round((ov?.tax_sweep_pct ?? tm?.rate ?? 0.3) * 1000) / 10;

  return (
    <div className="space-y-8 min-w-0">
      {/* ── Every account ─────────────────────────────── */}
      <section className="min-w-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium text-ink">Accounts and balances</h3>
            <p className="ui-note mt-0.5">
              {lastSync ? `From your banks, last pulled ${new Date(lastSync).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.` : "From your connected banks."}
              {" "}A check means the ledger agrees with the bank on that account.
            </p>
          </div>
          <Button onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Kpi small label="Cash in the bank" value={cash} format={fmtAmount} />
          <Kpi small label="Owed on cards" value={owed} format={fmtAmount} />
          <Kpi small label={loans > 0.005 ? "After cards and loans" : "After cards"} value={cash - owed - loans} format={fmtAmount} />
        </div>
        {accounts !== null && list.length === 0 && (
          <p className="ui-note mt-4">No bank is connected on this computer. Connect one under Setup to see its accounts here.</p>
        )}
        <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-4">
          {GROUPS.map((g) => {
            const rows = list.filter(g.match);
            if (rows.length === 0) return null;
            const total = rows.reduce((s, a) => s + (g.id === "credit" || g.id === "loan" ? Math.abs(a.balance) : a.balance), 0);
            return (
              <div key={g.id} className="min-w-0">
                <div className="flex items-center gap-3 pb-1.5 border-b border-line">
                  <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">{g.title}</span>
                  <span className="text-[13px] tabular-nums font-medium text-ink">{fmtAmount(total)}</span>
                </div>
                <div className="divide-y divide-line-2">
                  {rows.map((a) => (
                    <div key={a.key} className="flex items-center gap-3 py-2.5 min-w-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-ink truncate">
                          {a.name}{a.mask && <span className="text-muted"> ··{a.mask}</span>}
                        </div>
                        <div className="text-[11.5px] text-muted truncate">
                          {a.institution}{a.subtype ? ` · ${a.subtype}` : ""}
                          {a.available != null && a.type === "depository" && Math.abs(a.available - a.balance) > 0.005 ? ` · ${fmtAmount(a.available)} available` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                        {a.key === reserveKey && <StatusPill tone="accent">Tax savings</StatusPill>}
                        {a.drift == null ? null : Math.abs(a.drift) < 0.005
                          ? <StatusPill tone="success" title="The ledger agrees with the bank">Books agree</StatusPill>
                          : <button onClick={() => setOpenDrift(openDrift === a.label ? null : a.label)} title="Why, and how to fix it">
                              <StatusPill tone="danger">Off by {fmtAmount(Math.abs(a.drift))}{openDrift === a.label ? "" : ". Why?"}</StatusPill>
                            </button>}
                      </div>
                      <span className="text-[13px] tabular-nums text-ink w-32 text-right flex-shrink-0">{fmtAmount(a.balance)}</span>
                    </div>
                  )).flatMap((row, i) => {
                    const a = rows[i];
                    return openDrift === a.label && a.drift != null && Math.abs(a.drift) >= 0.005
                      ? [row, <DriftPanel key={a.key + "-why"} account={a.label} name={a.name} card={a.type === "credit"} onCheckBooks={onCheckBooks} onOpenRow={onOpenRow}
                          onChanged={() => { setOpenDrift(null); load(); }} />]
                      : [row];
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Tax savings ───────────────────────────────── */}
      <section className="min-w-0 border-t border-line pt-6">
        <h3 className="text-[15px] font-medium text-ink">Tax savings</h3>
        <p className="ui-note mt-0.5">
          What you would owe if today were tax day: your books' net income so far this year, after every expense, at your tax rate, less the estimated tax you already paid.
          {!tm && " The month by month figures need the server, which could not be reached."}
        </p>

        <div className={`mt-4 rounded-xl px-4 py-3 flex items-start gap-3 ${clear ? "bg-success-bg" : "bg-surface-2"}`}>
          {clear
            ? <CheckCircle2 size={18} className="text-success-ink flex-shrink-0 mt-0.5" />
            : <AlertTriangle size={18} className={`${savings ? "text-danger-ink" : "text-muted"} flex-shrink-0 mt-0.5`} />}
          <div className="min-w-0 text-[13px]">
            {!savings && <span className="text-ink-2">Pick the account you keep tax money in, and it is checked against what should be there.</span>}
            {savings && clear && <span className="font-medium text-success-ink">In the clear. {savings.name} holds {fmtAmount(held)}, and {fmtAmount(target)} should be there.</span>}
            {savings && !clear && short >= 0.005 && <span className="font-medium text-danger-ink">Move {fmtAmount(short)} into {savings.name}. It holds {fmtAmount(held)} and {fmtAmount(target)} should be there.</span>}
            {savings && !clear && short < 0.005 && <span className="font-medium text-danger-ink">The money is there, but the books do not agree with the bank yet.</span>}
            {savings && !booksAgree && (
              <span className="block text-ink-2 mt-0.5">
                The ledger and the bank disagree by {fmtAmount(Math.abs(drift!))} on this account, so a transfer is missing or doubled in your books.
                {onCheckBooks && <button onClick={onCheckBooks} className="ml-1.5 font-medium text-ink hover:opacity-70">Check books</button>}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-4">
          <div className="min-w-0 space-y-4">
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Savings account for tax</label>
              <select
                value={reserveKey}
                disabled={saving || !cfg}
                onChange={(e) => save({ reserveKey: e.target.value })}
                className="w-full border border-line-3 rounded-lg h-9 px-2.5 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent"
              >
                <option value="">None picked</option>
                {savingsChoices.map((a) => (
                  <option key={a.key} value={a.key}>{a.institution} · {a.name}{a.mask ? ` (${a.mask})` : ""} · {fmtAmount(a.balance)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Tax rate set aside</label>
              <p className="text-[11px] text-muted mb-1.5 leading-snug">The share of your net income you keep for tax. Set it with your accountant.</p>
              <div className="flex items-center gap-2">
                <div className="relative w-28">
                  <input inputMode="decimal" value={rateStr} onChange={(e) => setRateStr(e.target.value)} disabled={!cfg}
                    className="w-full border border-line-3 rounded-lg h-9 pl-2.5 pr-7 text-[13.5px] text-ink tabular-nums focus:outline-none focus:border-accent" />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-[12px]">%</span>
                </div>
                <Button onClick={saveRate} disabled={saving || !cfg}>Save</Button>
              </div>
            </div>
            {tm && (
              <div className="divide-y divide-line-2 border-t border-line">
                {lastMonth && (lastMonth.due >= 0
                  ? <Line label={`${monthName(lastMonth.month, true)}: move to savings`} value={fmtAmount(lastMonth.due)} strong />
                  : <Line label={`${monthName(lastMonth.month, true)} lost money: owed went down`} value={`-${fmtAmount(-lastMonth.due)}`} strong />)}
                {thisMonth && <Line label={`${monthName(thisMonth.month, true)} so far`} tag="not due yet" value={thisMonth.due < 0 ? `-${fmtAmount(-thisMonth.due)}` : fmtAmount(thisMonth.due)} muted />}
              </div>
            )}
          </div>

          <div className="min-w-0 divide-y divide-line-2 border-t border-line xl:border-t-0">
            {monthRows.length > 0 && (
              <div className="py-2">
                <div className="text-[12px] text-muted mb-1">Each month</div>
                {monthRows.map((m) => (
                  <div key={m.month} className="flex items-center gap-3 py-1 min-w-0">
                    <span className="min-w-0 flex-1 text-[12.5px] text-ink-2 truncate">
                      {monthName(m.month)}
                      <span className="text-muted"> · net income {monthNet(m) < 0 ? "-" : ""}{fmtAmount(Math.abs(monthNet(m)))}</span>
                    </span>
                    <span className={`text-[12.5px] tabular-nums w-32 text-right flex-shrink-0 ${m.closed ? "text-ink-2" : "text-muted"}`}>
                      {m.due < 0 ? `-${fmtAmount(-m.due)}` : fmtAmount(m.due)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Line label="Net income so far this year" tag="from your books, the Tax report below" value={`${netIncome < 0 ? "-" : ""}${fmtAmount(Math.abs(netIncome))}`} />
            <Line label={`Tax at ${ratePct}%`} tag={netIncome <= 0 ? "nothing owed on a loss" : undefined} value={fmtAmount(taxYear)} />
            {taxPaid > 0.005 && <Line label="Estimated tax already paid this year" value={`-${fmtAmount(taxPaid)}`} />}
            <Line label="Owed if today were tax day" value={fmtAmount(taxShould)} strong />
            {savings && <Line label={`In ${savings.name} now`} value={fmtAmount(held)} strong />}
          </div>
        </div>
      </section>
    </div>
  );
}
