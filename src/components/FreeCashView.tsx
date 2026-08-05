import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, FinancialsOverview, MoneyConfig } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, SlidersHorizontal, X, AlertTriangle } from "lucide-react";
import { toast } from "./Toast";

const inputCls =
  "w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Status → plain colored text (no dot, no pill, never the orange accent).

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
  // Guard for the Adjust dialog: saving is refused unless the stored figures were
  // actually read back, so a failed read can never be saved over them as zeros.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
      .then((v) => { setOv(v); setLoadError(null); })
      .catch((e: any) => { setLoadError(String(e?.message || e)); toast(String(e?.message || e), "error"); })
      .finally(() => setRefreshing(false));
  };

  // Round a percentage for display: 0.07 * 100 is 7.000000000000001 in binary float,
  // which was rendering in the input and drifting a little further on every save.
  const pct = (frac: number) => String(Math.round(frac * 1000000) / 10000);

  const loadConfig = () =>
    api
      .getMoneyConfig()
      .then((c: MoneyConfig) => {
        setBankStr(String(c.bank_balance));
        setCardStr(String(c.credit_card_balance));
        setFloorStr(String(c.cash_floor));
        // Stored as fractions (0.30) — shown and edited as percentages (30).
        setTaxStr(pct(c.tax_sweep_pct));
        setRefundStr(pct(c.refund_reserve_pct));
        setWarStr(String(c.war_chest));
        setConfigLoaded(true);
      })
      .catch((e: any) => {
        // Do NOT leave the buffers empty and pretend all is well: save() coerces
        // empty to 0, so a silent failure here plus a Save wrote zeros over the cash
        // floor, both reserve percentages and the war chest — and those keys sync.
        setConfigLoaded(false);
        setConfigError(String(e?.message || e));
      });

  useEffect(() => {
    loadOverview();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Free cash is derived from allocations, refunds and loans — all of which another
  // admin can change. Without this the number sat stale while the Transactions tab
  // beside it updated, so the two tabs disagreed on screen.
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { loadOverview(); })
      .then((u) => { if (dead) u(); else un = u; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    // Never write a config we never successfully read — that turns a transient read
    // failure into six zeroed settings, synced to every device.
    if (!configLoaded) {
      toast("Your saved figures could not be loaded, so saving is blocked to avoid overwriting them with zeros. Close and reopen this dialog.", "error");
      return;
    }
    const num = (s: string, label: string): number | null => {
      const n = Number(s.trim().replace(/[$,%\s]/g, ""));
      if (!Number.isFinite(n)) { toast(`${label} is not a number`, "error"); return null; }
      if (n < 0) { toast(`${label} cannot be negative`, "error"); return null; }
      return n;
    };
    const bank = num(bankStr, "Bank balance"), card = num(cardStr, "Credit card balance");
    const floor = num(floorStr, "Cash floor"), tax = num(taxStr, "Tax sweep");
    const refund = num(refundStr, "Refund reserve"), war = num(warStr, "War chest");
    if (bank === null || card === null || floor === null || tax === null || refund === null || war === null) return;
    if (tax > 100 || refund > 100) { toast("Percentages cannot be above 100", "error"); return; }
    setSaving(true);
    try {
      await api.setMoneyConfig(bank, card, floor, tax / 100, refund / 100, war);
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
        { label: `Refund reserve · ${Math.round((ov.refund_reserve_pct ?? 0.3) * 100)}% of ${fmtAmount(ov.refund_reserve_base ?? 0)} net profit`, tag: "set aside", value: ov.refund_reserve },
        { label: "Cash floor",                         tag: "untouchable",  value: ov.cash_floor },
        { label: "Loans outstanding",                  tag: "not yours",    value: ov.loan_outstanding },
      ]
    : [];

  const reconciled = ov
    ? ov.allocated_actuals.buyer_in + ov.allocated_actuals.supplier_paid + ov.allocated_actuals.refunds_out
    : 0;
  // Runway / traffic-light removed: it derived from business_expense, which has no
  // writer, so it was always "green" / "— months". Colour the number by whether
  // free cash is actually negative — an honest signal we can back up.
  const numCls  = ov && ov.free_cash < 0 ? "text-danger-ink" : "text-ink";
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

        {ov === null && loadError ? (
          // A failed load used to leave the skeleton pulsing forever, which reads as
          // "still loading" rather than "this failed and here's why".
          <div className="border border-line rounded-2xl p-5">
            <div className="text-[13px] font-semibold text-ink-2">Could not load your figures</div>
            <div className="text-[12px] text-muted mt-1 break-words">{loadError}</div>
            <div className="text-[11.5px] text-faint mt-1">Nothing has changed — this is a read that failed.</div>
            <button onClick={() => loadOverview()} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
              Try again
            </button>
          </div>
        ) : ov === null ? (
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
              </div>
            </div>

            {/* ── The breakdown — hairlines, not a card ──── */}
            <div>
              <h3 className="text-[13px] font-semibold text-ink tracking-tight">Where it comes from</h3>
              <p className="text-[11px] text-muted mt-0.5">Bank balance, minus everything that isn't yours to spend</p>
              <div className="mt-3 border-t border-line-2">
                <div className="flex items-center gap-3 py-2.5 min-w-0 border-b border-line-2">
                  <span className="min-w-0 flex-1 text-[13px] text-ink">
                    Bank balance
                    {ov.balance_source === "synced" && (
                      <span className="block text-[10.5px] text-muted mt-0.5">
                        Synced from your connected device{ov.balance_as_of ? ` · as of ${new Date(ov.balance_as_of).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                      </span>
                    )}
                  </span>
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
              {configError && (
                <div className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-bg/40 px-3 py-2.5">
                  <AlertTriangle size={14} className="text-danger-ink flex-shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-ink-2">Your saved figures could not be loaded</div>
                    <div className="text-[11.5px] text-muted mt-0.5 break-words">{configError}</div>
                    <div className="text-[11.5px] text-muted mt-0.5">Saving is blocked so these fields can't overwrite your settings with zeros.</div>
                    <button onClick={() => loadConfig()} className="mt-1.5 text-[11.5px] font-medium text-accent hover:text-accent-hover">
                      Try again
                    </button>
                  </div>
                </div>
              )}
              <NumField
                label="Current bank balance"
                hint={ov?.has_plaid ? "Live from your connected bank — managed automatically." : ov?.balance_source === "synced" ? "Synced from your connected device — change it on the device that has the bank linked." : "Enter from your latest statement — this figure is maintained by you."}
                prefix="$"
                value={ov?.has_plaid || ov?.balance_source === "synced" ? String(ov?.bank_balance ?? 0) : bankStr}
                onChange={setBankStr}
                disabled={!!ov?.has_plaid || ov?.balance_source === "synced"}
              />
              <NumField
                label="Credit card balance owed"
                hint={ov?.has_plaid ? "Live from your connected card — managed automatically." : ov?.balance_source === "synced" ? "Synced from your connected device — change it on the device that has the bank linked." : "Total owed across your business credit cards — enter from your latest statements."}
                prefix="$"
                value={ov?.has_plaid || ov?.balance_source === "synced" ? String(ov?.credit_card_balance ?? 0) : cardStr}
                onChange={setCardStr}
                disabled={!!ov?.has_plaid || ov?.balance_source === "synced"}
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
                hint="Share of this year's net profit to set aside for refunds — the amount to park in a separate account (link it later and reconcile)."
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
