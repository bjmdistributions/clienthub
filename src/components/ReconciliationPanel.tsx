import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, Trash2, Plus, X, Search } from "lucide-react";
import { api, DealFlow, DealAllocation, BankTxn } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Payments & reconciliation ────────────────────────────────────────────
// Pair real bank transactions to a completed deal's money legs (buyer payment,
// supplier payment, wire fees), show actual-vs-expected profit, and surface a
// "fully reconciled" state. A transaction can be SPLIT across deals: the picker
// shows what's still free to allocate (original − everything already claimed),
// so a $40k cash receipt put $20k on one deal still offers $20k on the next.
//
// The picker reads the SAME list as Financials → Transactions (`list_bank_txns`)
// and shows every transaction of the leg's direction that still has money left —
// no "near the expected amount" pre-filter. That filter used to hide a wire
// larger than the invoice from the default view entirely.

const fmtShortDate = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

type Leg = {
  role: "buyer_payment" | "supplier_payment" | "fee" | "refund_in";
  direction: "in" | "out";
  label: string;
  target: number; // expected amount, drives the "match" hint
};

export default function ReconciliationPanel({ flow, onChange }: { flow: DealFlow; onChange?: () => void }) {
  const [allocs, setAllocs] = useState<DealAllocation[]>([]);
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof api.dealReconciliation>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.dealAllocations(flow.id), api.dealReconciliation(flow.id)]);
      setAllocs(a);
      setRecon(r);
    } catch (e: any) {
      toast(String(e), "error");
    }
  }, [flow.id]);

  useEffect(() => { load(); }, [load]);

  const byRole = (role: string) => allocs.filter((a) => a.role === role);
  const buyer = byRole("buyer_payment");
  const supplier = byRole("supplier_payment");
  const fees = byRole("fee");
  const feeSum = fees.reduce((s, f) => s + f.amount, 0);
  // Money BACK from a supplier (a short-shipped or lost load, a price correction).
  // It offsets what the goods actually cost us, so it lifts actual profit.
  const refundIn = byRole("refund_in");
  const refundInSum = refundIn.reduce((s, r) => s + r.amount, 0);

  const buyerSum = buyer.reduce((s, a) => s + a.amount, 0);
  const supplierSum = supplier.reduce((s, a) => s + a.amount, 0);
  const buyerComplete = flow.invoice_total > 0 ? buyerSum >= flow.invoice_total - 0.5 : buyer.length > 0;
  const supplierComplete = flow.total_supplier_cost > 0 ? supplierSum >= flow.total_supplier_cost - 0.5 : supplier.length > 0;
  const fullyReconciled = recon?.fully_reconciled ?? (buyerComplete && supplierComplete);
  const anyPaired = buyer.length > 0 || supplier.length > 0 || fees.length > 0 || refundIn.length > 0;

  const expected = recon?.expected_profit ?? flow.net_profit;
  const actual = recon?.actual_profit ?? 0;
  const variance = actual - expected;

  // ── pairing picker ──
  const [picker, setPicker] = useState<Leg | null>(null);
  const [txns, setTxns] = useState<BankTxn[] | null>(null);
  // An allocation bigger than the leg still expects changes recorded profit, so it
  // is never done silently — this holds the pending pair until it's confirmed.
  const [overpay, setOverpay] = useState<{ t: BankTxn; leg: Leg; amt: number; expects: number } | null>(null);

  const closePicker = () => { setPicker(null); setTxns(null); setOverpay(null); };

  const openPicker = async (leg: Leg) => {
    setPicker(leg);
    setTxns(null);
    try {
      setTxns(await api.listBankTxns());
    } catch (e: any) {
      toast(String(e), "error");
      setTxns([]);
    }
  };

  // What this leg still expects — drives both the overpay confirmation and the
  // "Overpaid" hint. 0 for legs with no expected figure (fees, supplier refunds).
  const stillExpected = (leg: Leg) => {
    if (!(leg.target > 0)) return 0;
    const paired = allocs.filter((a) => a.role === leg.role).reduce((s, a) => s + a.amount, 0);
    return Math.max(0, leg.target - paired);
  };

  const pair = (t: BankTxn, leg: Leg, amount?: number) => {
    if (busy) return;
    const amt = Math.min(amount ?? t.unallocated, t.unallocated);
    if (!(amt > 0.005)) { toast("Enter an amount to allocate.", "error"); return; }
    const expects = stillExpected(leg);
    if (leg.target > 0 && amt > expects + 0.005) { setOverpay({ t, leg, amt, expects }); return; }
    void doPair(t, leg, amt);
  };

  const doPair = async (t: BankTxn, leg: Leg, amt: number) => {
    setBusy(true);
    try {
      // allow_split=true: part of this transaction can already be on another deal
      // (e.g. a $40k cash receipt split across two deals) — take only this deal's slice.
      await api.allocateBankTxn(t.id, flow.id, amt, leg.role, "", true);
      closePicker();
      await load();
      onChange?.();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(false);
  };

  const unpair = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.removeBankAllocation(id);
      await load();
      onChange?.();
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(false);
  };

  // ── manual (non-bank) lines ──
  // Which leg currently has its "add by hand" form open. Only one at a time, and
  // never at the same time as the bank picker.
  const [manualLeg, setManualLeg] = useState<Leg["role"] | null>(null);

  const addManual = async (role: Leg["role"], amount: number, date: string, who: string, note: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.addManualDealLine(flow.id, role, amount, date, who, note);
      setManualLeg(null);
      await load();
      onChange?.();
      toast("Line added");
    } catch (e: any) {
      toast(String(e), "error");
    }
    setBusy(false);
  };

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line-2 flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-ink-2">Payments &amp; reconciliation</div>
        {fullyReconciled ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-success-ink">
            <CheckCircle2 size={13} /> Fully reconciled
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <AlertTriangle size={12} className="text-warning-ink" />
            {!buyerComplete && !supplierComplete ? "Not yet reconciled" : !buyerComplete ? "Payment received incomplete" : "Supplier payment incomplete"}
          </span>
        )}
      </div>

      <div className="divide-y divide-line-2">
        {/* Payment received (buyer, money-in) */}
        <LegBlock
          title="Payment received"
          leg={{ role: "buyer_payment", direction: "in", label: "Payment received", target: flow.invoice_total }}
          rows={buyer}
          picker={picker}
          busy={busy}
          flow={flow}
          onOpen={openPicker}
          onClose={closePicker}
          onUnpair={unpair}
          pairLabel="Pair payment"
          manualOpen={manualLeg === "buyer_payment"}
          onOpenManual={() => { setManualLeg("buyer_payment"); closePicker(); }}
          onCloseManual={() => setManualLeg(null)}
          onAddManual={addManual}
        />

        {/* Supplier paid (money-out) */}
        <LegBlock
          title="Supplier paid"
          leg={{ role: "supplier_payment", direction: "out", label: "Supplier paid", target: flow.total_supplier_cost }}
          rows={supplier}
          picker={picker}
          busy={busy}
          flow={flow}
          onOpen={openPicker}
          onClose={closePicker}
          onUnpair={unpair}
          pairLabel="Pair supplier payment"
          manualOpen={manualLeg === "supplier_payment"}
          onOpenManual={() => { setManualLeg("supplier_payment"); closePicker(); }}
          onCloseManual={() => setManualLeg(null)}
          onAddManual={addManual}
        />

        {/* Wire fees (money-out, optional, subtract from actual profit) */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-ink">Wire fees</div>
            <div className="flex items-center gap-2">
              {feeSum > 0 && <span className="text-[13px] font-semibold text-danger-ink tabular-nums">−{fmtAmount(feeSum)}</span>}
              <ManualButton
                active={manualLeg === "fee"}
                onOpen={() => { setManualLeg("fee"); closePicker(); }}
                onClose={() => setManualLeg(null)}
              />
              <PairButton
                active={picker?.role === "fee"}
                label="Attach wire fee"
                onOpen={() => openPicker({ role: "fee", direction: "out", label: "Wire fee", target: 0 })}
                onClose={closePicker}
              />
            </div>
          </div>
          {fees.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {fees.map((f) => <PairedRow key={f.id} a={f} onUnpair={unpair} busy={busy} />)}
            </div>
          )}
          {manualLeg === "fee" && (
            <ManualLineForm
              leg={{ role: "fee", direction: "out", label: "Wire fee", target: 0 }}
              busy={busy}
              defaultWho=""
              onAdd={addManual}
              onCancel={() => setManualLeg(null)}
            />
          )}
        </div>

        {/* Supplier refund (money-in, optional, adds back to actual profit) — a lost /
            short-shipped load or a price correction where the supplier sends money back. */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-ink">Supplier refund</div>
            <div className="flex items-center gap-2">
              {refundInSum > 0 && <span className="text-[13px] font-semibold text-success-ink tabular-nums">+{fmtAmount(refundInSum)}</span>}
              <ManualButton
                active={manualLeg === "refund_in"}
                onOpen={() => { setManualLeg("refund_in"); closePicker(); }}
                onClose={() => setManualLeg(null)}
              />
              <PairButton
                active={picker?.role === "refund_in"}
                label="Attach supplier refund"
                onOpen={() => openPicker({ role: "refund_in", direction: "in", label: "Supplier refund", target: 0 })}
                onClose={closePicker}
              />
            </div>
          </div>
          {refundIn.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {refundIn.map((r) => <PairedRow key={r.id} a={r} onUnpair={unpair} busy={busy} />)}
            </div>
          )}
          {manualLeg === "refund_in" && (
            <ManualLineForm
              leg={{ role: "refund_in", direction: "in", label: "Supplier refund", target: 0 }}
              busy={busy}
              defaultWho=""
              onAdd={addManual}
              onCancel={() => setManualLeg(null)}
            />
          )}
        </div>
      </div>

      {/* Actual vs expected profit + complete-pairing breakdown */}
      <div className="border-t border-line bg-surface-2/60">
        <div className="px-4 py-3 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] text-muted">Expected profit</div>
            <div className="text-[18px] font-bold tabular-nums text-ink mt-0.5">{fmtAmount(expected)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted">Actual profit (from bank)</div>
            {!anyPaired ? (
              <div className="text-[18px] font-bold tabular-nums mt-0.5 text-faint">—</div>
            ) : (
              <div className={`text-[18px] font-bold tabular-nums mt-0.5 ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
                {actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}
              </div>
            )}
            {anyPaired && recon && Math.abs(variance) >= 0.5 && (
              <div className="text-[11px] tabular-nums text-muted mt-0.5">
                {variance >= 0 ? "+" : "−"}{fmtAmount(Math.abs(variance))} vs expected
              </div>
            )}
          </div>
        </div>

        {/* Profit from what's linked — updates live as you pair, no button needed */}
        {anyPaired && recon && (
          <div className="px-4 pb-4">
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] space-y-1.5">
              <div className="text-[12px] font-medium text-muted mb-1">Profit from linked payments</div>
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Payments received</span>
                <span className="tabular-nums text-success-ink">+{fmtAmount(recon.pieces.buyer_paired)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Supplier paid</span>
                <span className="tabular-nums text-danger-ink">−{fmtAmount(recon.pieces.supplier_paired)}</span>
              </div>
              {recon.pieces.fee_paired > 0.005 && (
                <div className="flex items-center justify-between">
                  <span className="text-ink-2">Wire fees</span>
                  <span className="tabular-nums text-danger-ink">−{fmtAmount(recon.pieces.fee_paired)}</span>
                </div>
              )}
              {recon.pieces.refund_total > 0.005 && (
                <div className="flex items-center justify-between">
                  <span className="text-ink-2">Refunds paid</span>
                  <span className="tabular-nums text-danger-ink">−{fmtAmount(recon.pieces.refund_total)}</span>
                </div>
              )}
              {recon.pieces.refund_in > 0.005 && (
                <div className="flex items-center justify-between">
                  <span className="text-ink-2">Supplier refund received</span>
                  <span className="tabular-nums text-success-ink">+{fmtAmount(recon.pieces.refund_in)}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-1.5 border-t border-line-2">
                <span className="font-semibold text-ink">Actual profit</span>
                <span className={`font-bold tabular-nums ${actual >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
                  {actual < 0 ? "−" : ""}{fmtAmount(Math.abs(actual))}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted">
                <span>Expected profit</span>
                <span className="tabular-nums">{fmtAmount(expected)}</span>
              </div>
              {Math.abs(variance) >= 0.5 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Difference</span>
                  <span className={`tabular-nums font-medium ${variance >= 0 ? "text-success-ink" : "text-danger-ink"}`}>
                    {variance >= 0 ? "+" : "−"}{fmtAmount(Math.abs(variance))}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {picker && (
        <TxnPickerModal
          leg={picker}
          txns={txns}
          flow={flow}
          busy={busy}
          expects={stillExpected(picker)}
          onClose={closePicker}
          onPair={pair}
        />
      )}

      {overpay && (
        <OverpayConfirm
          info={overpay}
          busy={busy}
          onCancel={() => setOverpay(null)}
          onConfirm={() => { const o = overpay; setOverpay(null); void doPair(o.t, o.leg, o.amt); }}
        />
      )}
    </div>
  );
}

// ── One money leg: title, paired rows or empty state, inline picker ──
function LegBlock({
  title, leg, rows, picker, busy, flow, onOpen, onClose, onUnpair, pairLabel,
  manualOpen, onOpenManual, onCloseManual, onAddManual,
}: {
  title: string;
  leg: Leg;
  rows: DealAllocation[];
  picker: Leg | null;
  busy: boolean;
  flow: DealFlow;
  onOpen: (leg: Leg) => void;
  onClose: () => void;
  onUnpair: (id: string) => void;
  pairLabel: string;
  manualOpen: boolean;
  onOpenManual: () => void;
  onCloseManual: () => void;
  onAddManual: (role: Leg["role"], amount: number, date: string, who: string, note: string) => void;
}) {
  const paired = rows.length > 0;
  const sum = rows.reduce((s, a) => s + a.amount, 0);
  const complete = leg.target > 0 ? sum >= leg.target - 0.5 : paired;
  const partial = paired && !complete;
  // More money linked than this leg expected. Allowed on purpose — a wire can be
  // bigger than the invoice — but it moves recorded profit, so it is never silent.
  const over = paired && leg.target > 0 && sum > leg.target + 0.5;
  const open = picker?.role === leg.role;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {complete
            ? <CheckCircle2 size={14} className="text-success-ink flex-shrink-0" />
            : <AlertTriangle size={14} className="text-warning-ink flex-shrink-0" />}
          <span className="text-[13px] font-medium text-ink truncate">{title}</span>
          {!paired && <span className="text-[11px] text-warning-ink">Not paired</span>}
          {partial && leg.target > 0 && (
            <span className="text-[11px] text-warning-ink tabular-nums">
              Partially paired · {fmtAmount(sum)} of {fmtAmount(leg.target)}
            </span>
          )}
          {over && (
            <span className="text-[11px] text-warning-ink tabular-nums">
              Overpaid · {fmtAmount(sum)} of {fmtAmount(leg.target)} expected · +{fmtAmount(sum - leg.target)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ManualButton active={manualOpen} onOpen={onOpenManual} onClose={onCloseManual} />
          <PairButton active={open} label={paired ? "Pair another" : pairLabel} onOpen={() => onOpen(leg)} onClose={onClose} />
        </div>
      </div>

      {paired && (
        <div className="mt-2 space-y-1.5">
          {rows.map((a) => <PairedRow key={a.id} a={a} onUnpair={onUnpair} busy={busy} />)}
        </div>
      )}

      {manualOpen && (
        <ManualLineForm
          leg={leg}
          busy={busy}
          defaultWho={leg.direction === "in" ? (flow.client_name || "") : ""}
          onAdd={onAddManual}
          onCancel={onCloseManual}
        />
      )}
    </div>
  );
}

// ── A paired transaction row: payer/desc + date on the left, amount + unpair right ──
function PairedRow({ a, onUnpair, busy }: { a: DealAllocation; onUnpair: (id: string) => void; busy: boolean }) {
  const manual = a.source_format === "manual_cash";
  const payer = a.counterparty_name?.trim() || a.description?.trim() || (manual ? "Cash" : "Bank transaction");
  const sign = a.direction === "out" ? "−" : "";
  const clr = a.direction === "out" ? "text-danger-ink" : "text-success-ink";
  return (
    <div className="flex items-center gap-2 bg-surface-2 border border-line-2 rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink truncate flex items-center gap-1.5">
          <span className="truncate">{payer}</span>
          {/* A hand-entered line must never read as something that came off a statement. */}
          {manual && (
            <span className="text-[10px] font-medium text-muted border border-line rounded px-1 py-px flex-shrink-0"
              title="Entered by hand — not matched to a bank statement">
              Cash
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted truncate">
          {fmtShortDate(a.posted_at)}
          {manual && a.note?.trim() ? ` · ${a.note.trim()}` : ""}
        </div>
      </div>
      <span className={`text-[13px] font-semibold tabular-nums ${clr}`}>{sign}{fmtAmount(a.amount)}</span>
      <button
        type="button"
        onClick={() => onUnpair(a.id)}
        disabled={busy}
        title="Unpair"
        className="h-7 w-7 flex items-center justify-center rounded-lg text-muted hover:text-danger-ink hover:bg-danger-bg disabled:opacity-50 transition-colors flex-shrink-0"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ── Add a money line that never hit the bank statement ──
// Cash on the side, a payment that netted off against something else. It books a
// real cash transaction against the deal, so it counts in actual profit exactly
// like a paired one — and is labelled "Cash" everywhere so the two never blur.
function ManualLineForm({ leg, busy, defaultWho, onAdd, onCancel }: {
  leg: Leg;
  busy: boolean;
  defaultWho: string;
  onAdd: (role: Leg["role"], amount: number, date: string, who: string, note: string) => void;
  onCancel: () => void;
}) {
  const [amt,  setAmt]  = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [who,  setWho]  = useState(defaultWho);
  const [note, setNote] = useState("");
  const val = parseFloat(amt);
  const invalid = !(val > 0.005);
  const submit = () => { if (!invalid) onAdd(leg.role, val, date, who.trim(), note.trim()); };

  return (
    <div className="mt-2 border border-line rounded-lg bg-surface-2/50 px-3 py-3 space-y-2.5">
      <div className="text-[11.5px] text-muted">
        Records money that never showed on a statement. It counts toward this deal's actual
        profit and is marked as cash, not as a bank match.
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center h-8 px-2 rounded-lg border border-line bg-surface w-[130px]">
          <span className="text-[12px] text-muted">$</span>
          <input
            value={amt}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            inputMode="decimal"
            autoFocus
            placeholder="0.00"
            className="w-full bg-transparent text-[12.5px] text-ink tabular-nums focus:outline-none ml-0.5"
          />
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 px-2 rounded-lg border border-line bg-surface text-[12.5px] text-ink focus:outline-none"
        />
        <input
          value={who}
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={leg.direction === "in" ? "Received from" : "Paid to"}
          className="h-8 px-2.5 rounded-lg border border-line bg-surface text-[12.5px] text-ink placeholder:text-muted focus:outline-none flex-1 min-w-[120px]"
        />
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="What happened — e.g. cash on the side, cancelled out the wire on the statement"
        className="w-full h-8 px-2.5 rounded-lg border border-line bg-surface text-[12.5px] text-ink placeholder:text-muted focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || invalid}
          onClick={submit}
          className="h-7 px-3 flex items-center gap-1 rounded-lg bg-accent text-on-accent text-[12px] font-semibold disabled:opacity-40 transition-colors"
        >
          <Plus size={12} /> Add {leg.direction === "in" ? "payment" : "payment out"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-line text-[12px] text-muted hover:text-ink-2 transition-colors"
        >
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  );
}

// ── Opens the by-hand form for a leg ──
function ManualButton({ active, onOpen, onClose }: { active: boolean; onOpen: () => void; onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={active ? onClose : onOpen}
      className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-line text-[12px] font-medium text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"
      title="Record cash or an offset that never appeared on the bank statement"
    >
      {active ? <X size={12} /> : <Plus size={12} />} By hand
    </button>
  );
}

// ── Pair / cancel toggle button ──
function PairButton({ active, label, onOpen, onClose }: { active: boolean; label: string; onOpen: () => void; onClose: () => void }) {
  if (active) {
    return (
      <button
        type="button"
        onClick={onClose}
        className="h-7 px-2.5 flex items-center gap-1 rounded-lg border border-line text-[12px] text-muted hover:text-ink-2 transition-colors flex-shrink-0"
      >
        <X size={12} /> Cancel
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="h-7 px-2.5 flex items-center gap-1 rounded-lg bg-accent text-on-accent text-[12px] font-semibold transition-colors flex-shrink-0"
    >
      <Plus size={12} /> {label}
    </button>
  );
}

// ── Full-screen transaction picker ────────────────────────────────────────
// Every transaction of the leg's direction that still has money left to allocate,
// read from the same `list_bank_txns` the Financials list uses, laid out the same
// way (date · payee · category · account · amount). Nothing is hidden by default
// except internal transfers and loan money — which never carry a deal allocation —
// and a chip brings even those back.
function TxnPickerModal({ leg, txns, flow, busy, expects, onClose, onPair }: {
  leg: Leg;
  txns: BankTxn[] | null;
  flow: DealFlow;
  busy: boolean;
  expects: number; // what this leg still expects, 0 when it has no expected figure
  onClose: () => void;
  onPair: (t: BankTxn, leg: Leg, amount?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState("all");
  const [sort, setSort] = useState<"newest" | "largest" | "closest">(leg.target > 0 ? "closest" : "newest");
  const [nearOnly, setNearOnly] = useState(false);
  const [showOther, setShowOther] = useState(false); // transfers + loan money
  const [sel, setSel] = useState<BankTxn | null>(null);
  const [amt, setAmt] = useState("");

  // Loan money and internal transfers never get a deal allocation (money invariant
  // 17), so they are noise here — but a miscategorised wire would be hidden with
  // them, which is why the chip exists rather than a hard exclusion.
  const isOther = (t: BankTxn) =>
    t.category === "internal_transfer" || t.category === "loan_received" ||
    t.category === "loan_repayment" || t.counterparty_type === "loan";

  const pool = useMemo(
    () => (txns ?? []).filter((t) => t.direction === leg.direction && t.unallocated > 0.005 && (showOther || !isOther(t))),
    [txns, leg.direction, showOther],
  );

  const accounts = useMemo(
    () => Array.from(new Set(pool.map((t) => t.account_id).filter(Boolean))).sort(),
    [pool],
  );

  // Space-separated tokens, all of which must hit somewhere on the row — the same
  // shape as the Financials search, so payee + amount + date narrow together.
  const toks = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hit = (t: BankTxn) => {
    if (toks.length === 0) return true;
    const hay = [
      t.counterparty_name, t.description, t.account_id, t.category, t.wire_ref,
      t.posted_at?.slice(0, 10), t.unallocated.toFixed(2), t.amount.toFixed(2),
    ].join(" ").toLowerCase();
    return toks.every((k) => hay.includes(k));
  };

  const shown = useMemo(() => {
    const list = pool.filter((t) =>
      (acct === "all" || t.account_id === acct) &&
      (!nearOnly || leg.target <= 0 || Math.abs(t.unallocated - leg.target) <= Math.max(leg.target * 0.25, 50)) &&
      hit(t));
    const byDate = (a: BankTxn, b: BankTxn) => (b.posted_at || "").localeCompare(a.posted_at || "");
    return [...list].sort((a, b) => {
      if (sort === "largest") return b.unallocated - a.unallocated || byDate(a, b);
      if (sort === "closest" && leg.target > 0) {
        const d = Math.abs(a.unallocated - leg.target) - Math.abs(b.unallocated - leg.target);
        if (Math.abs(d) > 0.005) return d;
      }
      return byDate(a, b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, acct, nearOnly, q, sort, leg.target]);

  const pick = (t: BankTxn) => { setSel(t); setAmt(t.unallocated.toFixed(2)); };
  const val = parseFloat(amt);
  const invalid = !sel || !(val > 0.005) || val > sel.unallocated + 0.005;
  const surplus = sel && leg.target > 0 ? val - expects : 0;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-[94vw] max-w-[1100px] h-[90vh] flex flex-col rounded-2xl bg-surface border border-line shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-3.5 border-b border-line">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink truncate">{leg.label}</h3>
            <div className="text-[12px] text-muted mt-0.5 truncate">
              {flow.client_name || flow.name || "This deal"}
              {leg.target > 0 && <> · expected {fmtAmount(leg.target)}{expects < leg.target - 0.005 && <> · {fmtAmount(expects)} still to pair</>}</>}
              {" · showing money "}{leg.direction === "in" ? "in" : "out"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-surface-2 transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap px-5 py-2.5 border-b border-line-2 bg-surface-2/40">
          <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line bg-surface flex-1 min-w-[220px]">
            <Search size={13} className="text-muted flex-shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder="Search payee, amount, date, account"
              className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-muted focus:outline-none"
            />
          </div>
          {accounts.length > 1 && (
            <select
              value={acct}
              onChange={(e) => setAcct(e.target.value)}
              className="h-8 px-2 rounded-lg border border-line bg-surface text-[12px] text-ink-2 focus:outline-none max-w-[200px]"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as any)}
            className="h-8 px-2 rounded-lg border border-line bg-surface text-[12px] text-ink-2 focus:outline-none"
          >
            {leg.target > 0 && <option value="closest">Closest to expected</option>}
            <option value="newest">Newest first</option>
            <option value="largest">Largest first</option>
          </select>
          {leg.target > 0 && (
            <Chip active={nearOnly} onClick={() => setNearOnly((v) => !v)} label={`Near ${fmtAmount(leg.target)}`} />
          )}
          <Chip active={showOther} onClick={() => setShowOther((v) => !v)} label="Transfers & loans" />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {txns === null ? (
            <div className="px-5 py-6 text-[12.5px] text-muted">Loading transactions…</div>
          ) : shown.length === 0 ? (
            <div className="px-5 py-6 text-[12.5px] text-muted">
              {pool.length === 0
                ? `No ${leg.direction === "in" ? "incoming" : "outgoing"} transactions have money left to pair.`
                : "No transactions match these filters."}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="text-left border-b border-line">
                  <th className="text-[11px] font-medium text-muted py-2 pl-5 pr-3 whitespace-nowrap">Date</th>
                  <th className="text-[11px] font-medium text-muted py-2 pr-3">Payee</th>
                  <th className="text-[11px] font-medium text-muted py-2 pr-3">Category</th>
                  <th className="text-[11px] font-medium text-muted py-2 pr-3 whitespace-nowrap">Account</th>
                  <th className="text-[11px] font-medium text-muted py-2 pr-5 text-right whitespace-nowrap">Free to pair</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const payer = t.counterparty_name?.trim() || t.description?.trim() || "Bank transaction";
                  const part = t.allocated > 0.005;
                  const active = sel?.id === t.id;
                  return (
                    <tr
                      key={t.id}
                      onClick={() => pick(t)}
                      className={`border-b border-line-2 cursor-pointer transition-colors ${active ? "bg-accent/10" : "hover:bg-surface-2"}`}
                    >
                      <td className="py-2 pl-5 pr-3 text-[12px] text-muted whitespace-nowrap tabular-nums">{fmtShortDate(t.posted_at)}</td>
                      <td className="py-2 pr-3 min-w-0">
                        <div className="text-[12.5px] text-ink truncate max-w-[380px] flex items-center gap-1.5">
                          <span className="truncate">{payer}</span>
                          {matches(t, leg, flow) && <span className="text-[10px] text-accent font-semibold flex-shrink-0">match</span>}
                        </div>
                        {t.description?.trim() && t.counterparty_name?.trim() && (
                          <div className="text-[11px] text-muted truncate max-w-[380px]">{t.description}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-[11.5px] text-muted truncate max-w-[140px]">{t.category || "—"}</td>
                      <td className="py-2 pr-3 text-[11.5px] text-muted truncate max-w-[160px]">{t.account_id}</td>
                      <td className="py-2 pr-5 text-right whitespace-nowrap">
                        <div className={`text-[12.5px] font-semibold tabular-nums ${t.direction === "out" ? "text-danger-ink" : "text-success-ink"}`}>
                          {t.direction === "out" ? "−" : ""}{fmtAmount(t.unallocated)}
                        </div>
                        {part && <div className="text-[11px] text-muted tabular-nums">of {fmtAmount(t.amount)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Selected transaction → amount → add */}
        <div className="border-t border-line px-5 py-3 bg-surface-2/40">
          {!sel ? (
            <div className="text-[12px] text-muted">
              {txns === null ? "" : `${shown.length} transaction${shown.length === 1 ? "" : "s"} — pick one to pair it with this deal.`}
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-ink truncate">
                  {sel.counterparty_name?.trim() || sel.description?.trim() || "Bank transaction"}
                </div>
                <div className="text-[11px] text-muted tabular-nums">
                  {fmtShortDate(sel.posted_at)} · {fmtAmount(sel.unallocated)} free of {fmtAmount(sel.amount)}
                </div>
              </div>
              {surplus > 0.005 && (
                <span className="text-[11px] text-warning-ink tabular-nums">
                  {fmtAmount(surplus)} more than this leg expects
                </span>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] text-muted">Allocate</span>
                <div className="flex items-center h-8 px-2 rounded-lg border border-line bg-surface w-[140px]">
                  <span className="text-[12px] text-muted">$</span>
                  <input
                    value={amt}
                    onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter" && !invalid && !busy) onPair(sel, leg, val); }}
                    inputMode="decimal"
                    className="w-full bg-transparent text-[12.5px] text-ink tabular-nums focus:outline-none ml-0.5"
                  />
                </div>
              </div>
              <button
                type="button"
                disabled={busy || invalid}
                onClick={() => onPair(sel, leg, val)}
                className="h-8 px-3.5 flex items-center gap-1 rounded-lg bg-accent text-on-accent text-[12.5px] font-semibold disabled:opacity-40 transition-colors"
              >
                <Plus size={13} /> Add to deal
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Filter chip ──
function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-2.5 rounded-lg border text-[12px] font-medium transition-colors ${
        active ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink-2"
      }`}
    >
      {label}
    </button>
  );
}

// ── Confirm counting money above what the leg expected ────────────────────
// Allocating more than the invoice is allowed, but recorded profit is derived from
// what is linked — so the surplus lands straight in the deal's profit (or cost).
// Jack asked for this to be a decision, not a side effect.
function OverpayConfirm({ info, busy, onCancel, onConfirm }: {
  info: { t: BankTxn; leg: Leg; amt: number; expects: number };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { leg, amt, expects } = info;
  const surplus = amt - expects;
  const moneyIn = leg.direction === "in";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative w-[92vw] max-w-[440px] rounded-2xl bg-surface border border-line shadow-2xl overflow-hidden">
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={15} className="text-warning-ink flex-shrink-0" />
            <h3 className="text-[14px] font-semibold text-ink">
              {moneyIn ? "Count the overpayment as profit?" : "Count the extra as cost?"}
            </h3>
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed">
            {fmtAmount(amt)} is <span className="font-semibold tabular-nums">{fmtAmount(surplus)}</span> more than this deal's{" "}
            {leg.role === "buyer_payment" ? "invoice" : "expected supplier cost"} of {fmtAmount(leg.target)}
            {expects < leg.target - 0.005 && <> ({fmtAmount(expects)} still unpaired)</>}.
          </div>
          <div className="text-[12.5px] text-ink-2 leading-relaxed mt-2">
            Add it all and this deal's recorded profit {moneyIn ? "goes up" : "goes down"} by{" "}
            <span className="font-semibold tabular-nums">{fmtAmount(surplus)}</span>.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-surface-2/40">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-lg border border-line text-[12.5px] text-muted hover:text-ink-2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-8 px-3.5 rounded-lg bg-accent text-on-accent text-[12.5px] font-semibold disabled:opacity-40 transition-colors"
          >
            Yes, add the full {fmtAmount(amt)}
          </button>
        </div>
      </div>
    </div>
  );
}

// Match hint: same buyer name, or amount ≈ the expected leg amount.
function matches(t: BankTxn, leg: Leg, flow: DealFlow): boolean {
  const cp = (t.counterparty_name || "").trim().toLowerCase();
  const name = (flow.client_name || "").toLowerCase();
  const byName = cp.length > 2 && name.length > 0 && (name.includes(cp) || cp.includes(name));
  const byAmount = !!leg.target && Math.abs(leg.target - t.unallocated) < 0.5;
  return byName || byAmount;
}
