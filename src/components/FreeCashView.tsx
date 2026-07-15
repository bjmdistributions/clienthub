import { useEffect, useState } from "react";
import { api, FinancialsOverview, MoneyConfig } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, SlidersHorizontal, X, AlertTriangle } from "lucide-react";
import { toast } from "./Toast";

const inputCls =
  "w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Status → plain colored text (no dot, no pill, never the orange accent).
const STATUS: Record<FinancialsOverview["status"], { label: string; cls: string }> = {
  green:  { label: "Healthy",  cls: "text-success-ink" },
  yellow: { label: "Tight",    cls: "text-warning-ink" },
  red:    { label: "Critical", cls: "text-danger-ink" },
};

// One deduction row in the ledger. Money right-aligned, tabular, shown negative.
// `strong` lifts a figure that deserves attention (e.g. the tax set-aside).
function DeductionRow({ label, tag, value, strong }: { label: string; tag: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5 min-w-0">
      <div className="min-w-0 flex-1">
        <span className={`text-[13px] ${strong ? "font-medium text-ink" : "text-ink-2"}`}>{label}</span>
        <span className="text-[11px] text-faint ml-2">{tag}</span>
      </div>
      <span className={`text-[13px] tabular-nums w-28 text-right flex-shrink-0 ${strong ? "text-ink-2" : "text-muted"}`}>
        &minus; {fmtAmount(value)}
      </span>
    </div>
  );
}

// A number input bound to a raw string buffer so it can be cleared and accept
// decimals (coerced to a number only on save).
function NumField({
  label, hint, prefix, suffix, value, onChange, disabled,
}: {
  label: string;
  hint?: string;
  prefix?: string;
  suffix?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-[12.5px] font-medium text-ink-2 mb-1">{label}</label>
      {hint && <p className="text-[11px] text-muted mb-1.5 leading-snug">{hint}</p>}
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">{prefix}</span>
        )}
        <input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0"
          readOnly={disabled}
          className={inputCls + (prefix ? " pl-6" : "") + (suffix ? " pr-8" : "") + (disabled ? " opacity-50 cursor-not-allowed" : "")}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export default function FreeCashView() {
  const [ov, setOv] = useState<FinancialsOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Config editor buffers (raw strings — coerced on save).
  const [bankStr, setBankStr]     = useState("");
  const [cardStr, setCardStr]     = useState("");
  const [floorStr, setFloorStr]   = useState("");
  const [taxStr, setTaxStr]       = useState("");
  const [refundStr, setRefundStr] = useState("");
  const [warStr, setWarStr]       = useState("");

  const loadOverview = () => {
    setRefreshing(true);
    return api
      .financialsOverview()
      .then(setOv)
      .catch((e: any) => toast(String(e?.message || e), "error"))
      .finally(() => setRefreshing(false));
  };

  const loadConfig = () =>
    api
      .getMoneyConfig()
      .then((c: MoneyConfig) => {
        setBankStr(String(c.bank_balance));
        setCardStr(String(c.credit_card_balance));
        setFloorStr(String(c.cash_floor));
        // Stored as fractions (0.30) — shown and edited as percentages (30).
        setTaxStr(String(c.tax_sweep_pct * 100));
        setRefundStr(String(c.refund_reserve_pct * 100));
        setWarStr(String(c.war_chest));
      })
      .catch(() => {});

  useEffect(() => {
    loadOverview();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.setMoneyConfig(
        Number(bankStr)   || 0,
        Number(cardStr)   || 0,
        Number(floorStr)  || 0,
        (Number(taxStr)    || 0) / 100, // percent → fraction
        (Number(refundStr) || 0) / 100,
        Number(warStr)    || 0,
      );
      setAdjustOpen(false);
      await loadOverview();
      toast("Saved");
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setSaving(false);
    }
  };

  const deductions: { label: string; tag: string; value: number; strong?: boolean }[] = ov
    ? [
        { label: "Credit cards owed",                  tag: "not yours",    value: ov.credit_card_balance },
        { label: "Supplier payables",                  tag: "not yours",    value: ov.supplier_payables },
        { label: "Refund liability (we owe buyers)",   tag: "not yours",    value: ov.refund_liability },
        { label: "Tax reserve",                        tag: "untouchable",  value: ov.tax_reserve, strong: true },
        { label: "Refund reserve",                     tag: "untouchable",  value: ov.refund_reserve },
        { label: "Cash floor",                         tag: "untouchable",  value: ov.cash_floor },
        { label: "Loans outstanding",                  tag: "not yours",    value: ov.loan_outstanding },
      ]
    : [];

  const reconciled = ov
    ? ov.allocated_actuals.buyer_in + ov.allocated_actuals.supplier_paid + ov.allocated_actuals.refunds_out
    : 0;
  const status  = ov ? STATUS[ov.status] : null;
  const numCls  = ov && ov.status === "red" ? "text-danger-ink" : "text-ink";
  const hasAlerts = !!ov && (ov.alerts.refund_deals > 0 || ov.alerts.stale_unallocated_in > 0);

  return (
    <div className="min-h-full flex flex-col" style={{ background: "var(--t-bg)" }}>

      {/* ── Page header ─────────────────────────────────── */}
      <div className="px-6 py-4 flex items-center justify-between flex-shrink-0 bg-surface border-b border-line">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Free cash</h2>
          <p className="text-[12px] text-muted mt-0.5">What's actually yours to spend</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadOverview()}
            disabled={refreshing}
            title="Refresh"
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-line text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => { loadConfig(); setAdjustOpen(true); }}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 transition-colors"
          >
            <SlidersHorizontal size={14} /> Adjust
          </button>
        </div>
      </div>

      <div className="flex-1 p-6 flex flex-col gap-5 max-w-[720px] w-full mx-auto">

        {ov === null ? (
          <div className="h-[168px] bg-surface-2 rounded-2xl animate-pulse" />
        ) : (
          <>
            {/* ── The number — quiet, no card, no pill ───── */}
            <div>
              <div className="text-[12.5px] font-medium text-muted">Free cash</div>
              <div className="flex items-baseline gap-3 mt-1.5 flex-wrap">
                <span className={`text-[34px] font-semibold tabular-nums leading-none tracking-tight ${numCls}`}>
                  {fmtAmount(ov.free_cash)}
                </span>
                {status && <span className={`text-[13px] font-semibold ${status.cls}`}>{status.label}</span>}
              </div>
              <div className="text-[11.5px] text-faint mt-2 tabular-nums">
                {ov.runway_months < 0 ? "—" : `${ov.runway_months.toFixed(1)} months of runway`}
              </div>
            </div>

            {/* ── The breakdown — hairlines, not a card ──── */}
            <div>
              <h3 className="text-[13px] font-semibold text-ink tracking-tight">Where it comes from</h3>
              <p className="text-[11px] text-muted mt-0.5">Bank balance, minus everything that isn't yours to spend</p>
              <div className="mt-3 border-t border-line-2">
                <div className="flex items-center gap-3 py-2.5 min-w-0 border-b border-line-2">
                  <span className="min-w-0 flex-1 text-[13px] text-ink">Bank balance</span>
                  <span className="text-[13px] tabular-nums text-ink w-28 text-right flex-shrink-0">
                    {fmtAmount(ov.bank_balance)}
                  </span>
                </div>
                <div className="divide-y divide-line-2">
                  {deductions.map((d) => (
                    <DeductionRow key={d.label} label={d.label} tag={d.tag} value={d.value} strong={d.strong} />
                  ))}
                </div>
                <div className="border-t border-line py-3 flex items-center gap-3 min-w-0">
                  <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">Free cash</span>
                  <span className={`text-[15px] font-bold tabular-nums w-28 text-right flex-shrink-0 ${numCls}`}>
                    {fmtAmount(ov.free_cash)}
                  </span>
                </div>
                {reconciled > 0 && (
                  <div className="border-t border-line-2 py-2.5 text-[11px] text-muted">
                    {fmtAmount(reconciled)} reconciled from the bank feed
                    {ov.allocated_actuals.supplier_paid > 0 && ` · ${fmtAmount(ov.allocated_actuals.supplier_paid)} to suppliers`}
                    {ov.allocated_actuals.refunds_out > 0 && ` · ${fmtAmount(ov.allocated_actuals.refunds_out)} refunded`}
                  </div>
                )}
              </div>
            </div>

            {/* ── War chest progress (informational target, not deducted) ── */}
            {ov.war_chest > 0 && (
              <div className="min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="min-w-0 flex-1 text-[13px] text-ink-2">War chest target</span>
                  <span className="text-[13px] tabular-nums text-muted flex-shrink-0">
                    {fmtAmount(Math.max(0, ov.free_cash))} / {fmtAmount(ov.war_chest)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-ink-2 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, (ov.free_cash / ov.war_chest) * 100))}%` }}
                  />
                </div>
              </div>
            )}

            {/* ── Aging alerts (only when present) ───────── */}
            {hasAlerts && (
              <div className="border-t border-line-2">
                {ov.alerts.refund_deals > 0 && (
                  <div className="flex items-center gap-2.5 py-2.5 min-w-0 border-b border-line-2">
                    <AlertTriangle size={15} className="text-danger-ink flex-shrink-0" />
                    <span className="text-[13px] text-danger-ink min-w-0">
                      {ov.alerts.refund_deals} deal{ov.alerts.refund_deals !== 1 ? "s" : ""} with a refund you owe
                    </span>
                  </div>
                )}
                {ov.alerts.stale_unallocated_in > 0 && (
                  <div className="flex items-center gap-2.5 py-2.5 min-w-0 border-b border-line-2">
                    <AlertTriangle size={15} className="text-danger-ink flex-shrink-0" />
                    <span className="text-[13px] text-danger-ink min-w-0">
                      {ov.alerts.stale_unallocated_in} incoming payment{ov.alerts.stale_unallocated_in !== 1 ? "s" : ""} unallocated over 7 days
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Adjust config modal ──────────────────────────── */}
      {adjustOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setAdjustOpen(false)}
        >
          <div
            className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
              <div>
                <h2 className="text-[16px] font-semibold text-ink">Adjust cash settings</h2>
                <p className="text-[12px] text-muted mt-0.5">These shape what counts as free cash</p>
              </div>
              <button
                onClick={() => setAdjustOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
              <NumField
                label="Current bank balance"
                hint={ov?.has_plaid ? "Live from your connected bank — managed automatically." : "Enter from your latest statement — this figure is maintained by you."}
                prefix="$"
                value={ov?.has_plaid ? String(ov.bank_balance) : bankStr}
                onChange={setBankStr}
                disabled={!!ov?.has_plaid}
              />
              <NumField
                label="Credit card balance owed"
                hint={ov?.has_plaid ? "Live from your connected card — managed automatically." : "Total owed across your business credit cards — enter from your latest statements."}
                prefix="$"
                value={ov?.has_plaid ? String(ov.credit_card_balance) : cardStr}
                onChange={setCardStr}
                disabled={!!ov?.has_plaid}
              />
              <NumField
                label="Cash floor"
                hint="3× monthly operating expenses you want to keep untouchable."
                prefix="$"
                value={floorStr}
                onChange={setFloorStr}
              />
              <NumField
                label="Tax sweep"
                hint="Share of this year's completed-deal profit set aside for taxes."
                suffix="%"
                value={taxStr}
                onChange={setTaxStr}
              />
              <NumField
                label="Refund reserve"
                hint="Share of this year's completed-deal revenue held back against future refunds."
                suffix="%"
                value={refundStr}
                onChange={setRefundStr}
              />
              <NumField
                label="War chest target"
                hint="Rainy-day balance you're building toward."
                prefix="$"
                value={warStr}
                onChange={setWarStr}
              />
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
              <button
                onClick={() => setAdjustOpen(false)}
                className="h-9 px-3.5 rounded-lg border border-line text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="h-9 px-4 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12.5px] font-medium transition-colors disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
