import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Trash2, Plus, X, Search } from "lucide-react";
import { api, DealFlow, DealAllocation, UnallocatedTxn } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Payments & reconciliation ────────────────────────────────────────────
// Pair real bank transactions to a completed deal's money legs (buyer payment,
// supplier payment, wire fees), show actual-vs-expected profit, and surface a
// "fully reconciled" state. A transaction can be SPLIT across deals: the picker
// shows what's still free to allocate (original − everything already claimed),
// so a $40k cash receipt put $20k on one deal still offers $20k on the next.

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
  const [cands, setCands] = useState<UnallocatedTxn[] | null>(null);

  const openPicker = async (leg: Leg) => {
    setPicker(leg);
    setCands(null);
    try {
      const res = await api.unallocatedBankTxns(flow.id);
      const list = leg.direction === "in" ? res.money_in : res.money_out;
      const ranked = [...list].sort((a, b) => {
        const ma = matches(a, leg, flow) ? 0 : 1;
        const mb = matches(b, leg, flow) ? 0 : 1;
        if (ma !== mb) return ma - mb;
        return (b.posted_at || "").localeCompare(a.posted_at || "");
      });
      setCands(ranked);
    } catch (e: any) {
      toast(String(e), "error");
      setCands([]);
    }
  };

  const pair = async (t: UnallocatedTxn, leg: Leg, amount?: number) => {
    if (busy) return;
    const amt = Math.min(amount ?? t.unallocated, t.unallocated);
    if (!(amt > 0.005)) { toast("Enter an amount to allocate.", "error"); return; }
    setBusy(true);
    try {
      // allow_split=true: part of this transaction can already be on another deal
      // (e.g. a $40k cash receipt split across two deals) — take only this deal's slice.
      await api.allocateBankTxn(t.id, flow.id, amt, leg.role, "", true);
      setPicker(null);
      setCands(null);
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
          cands={cands}
          busy={busy}
          flow={flow}
          onOpen={openPicker}
          onClose={() => { setPicker(null); setCands(null); }}
          onPair={pair}
          onUnpair={unpair}
          pairLabel="Pair payment"
          manualOpen={manualLeg === "buyer_payment"}
          onOpenManual={() => { setManualLeg("buyer_payment"); setPicker(null); setCands(null); }}
          onCloseManual={() => setManualLeg(null)}
          onAddManual={addManual}
        />

        {/* Supplier paid (money-out) */}
        <LegBlock
          title="Supplier paid"
          leg={{ role: "supplier_payment", direction: "out", label: "Supplier paid", target: flow.total_supplier_cost }}
          rows={supplier}
          picker={picker}
          cands={cands}
          busy={busy}
          flow={flow}
          onOpen={openPicker}
          onClose={() => { setPicker(null); setCands(null); }}
          onPair={pair}
          onUnpair={unpair}
          pairLabel="Pair supplier payment"
          manualOpen={manualLeg === "supplier_payment"}
          onOpenManual={() => { setManualLeg("supplier_payment"); setPicker(null); setCands(null); }}
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
                onOpen={() => { setManualLeg("fee"); setPicker(null); setCands(null); }}
                onClose={() => setManualLeg(null)}
              />
              <PairButton
                active={picker?.role === "fee"}
                label="Attach wire fee"
                onOpen={() => openPicker({ role: "fee", direction: "out", label: "Wire fee", target: 0 })}
                onClose={() => { setPicker(null); setCands(null); }}
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
          {picker?.role === "fee" && (
            <Picker leg={picker} cands={cands} busy={busy} flow={flow} onPair={pair} />
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
                onOpen={() => { setManualLeg("refund_in"); setPicker(null); setCands(null); }}
                onClose={() => setManualLeg(null)}
              />
              <PairButton
                active={picker?.role === "refund_in"}
                label="Attach supplier refund"
                onOpen={() => openPicker({ role: "refund_in", direction: "in", label: "Supplier refund", target: 0 })}
                onClose={() => { setPicker(null); setCands(null); }}
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
          {picker?.role === "refund_in" && (
            <Picker leg={picker} cands={cands} busy={busy} flow={flow} onPair={pair} />
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
    </div>
  );
}

// ── One money leg: title, paired rows or empty state, inline picker ──
function LegBlock({
  title, leg, rows, picker, cands, busy, flow, onOpen, onClose, onPair, onUnpair, pairLabel,
  manualOpen, onOpenManual, onCloseManual, onAddManual,
}: {
  title: string;
  leg: Leg;
  rows: DealAllocation[];
  picker: Leg | null;
  cands: UnallocatedTxn[] | null;
  busy: boolean;
  flow: DealFlow;
  onOpen: (leg: Leg) => void;
  onClose: () => void;
  onPair: (t: UnallocatedTxn, leg: Leg, amount?: number) => void;
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

      {open && (
        <Picker
          leg={leg}
          cands={cands}
          busy={busy}
          flow={flow}
          onPair={onPair}
          capTo={leg.target > 0 ? Math.max(0, leg.target - sum) : undefined}
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

// ── Candidate picker: unallocated txns of the right direction, matches ranked first ──
function Picker({ leg, cands, busy, flow, onPair, capTo }: {
  leg: Leg;
  cands: UnallocatedTxn[] | null;
  busy: boolean;
  flow: DealFlow;
  onPair: (t: UnallocatedTxn, leg: Leg, amount?: number) => void;
  capTo?: number; // sensible default allocation (what this leg still needs)
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const num = query.replace(/[^0-9.]/g, "");

  // Default view is SMART: only transactions right around the expected price (within
  // 25%, min $50, of the leg target) plus payer matches — so a supplier leg doesn't
  // list every expense. Typing searches ALL unallocated txns by payer or amount.
  const near = (t: UnallocatedTxn) =>
    leg.target <= 0
      ? true
      : Math.abs(t.unallocated - leg.target) <= Math.max(leg.target * 0.25, 50) || matches(t, leg, flow);

  const shown = (cands ?? []).filter((t) => {
    if (!query) return near(t);
    const payer = `${t.counterparty_name || ""} ${t.description || ""}`.toLowerCase();
    return payer.includes(query) || (num.length > 0 && (t.unallocated.toFixed(2).includes(num) || String(t.unallocated).includes(num)));
  });

  return (
    <div className="mt-2 border border-line rounded-lg overflow-hidden">
      {cands === null ? (
        <div className="px-3 py-3 text-[12px] text-muted">Loading transactions…</div>
      ) : cands.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-muted">
          No unallocated {leg.direction === "in" ? "incoming" : "outgoing"} transactions to pair.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line-2 bg-surface-2/50">
            <Search size={13} className="text-muted flex-shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={leg.target > 0 ? `Near ${fmtAmount(leg.target)} — or search payee / amount` : "Search payee or amount"}
              className="w-full bg-transparent text-[12px] text-ink placeholder:text-muted focus:outline-none"
            />
          </div>
          {shown.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted">
              {query ? "No transactions match your search." : `No transactions near ${fmtAmount(leg.target)} — type to search all.`}
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-line-2">
              {shown.map((t) => (
                <PickerRow key={t.id} t={t} leg={leg} flow={flow} busy={busy} capTo={capTo} onPair={onPair} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── One candidate row: shows the amount still free to allocate (across all deals),
// the original total when part is already spent elsewhere, and an editable amount so
// you can put just a slice of one transaction on this deal ($20k of a $40k receipt). ──
function PickerRow({ t, leg, flow, busy, capTo, onPair }: {
  t: UnallocatedTxn;
  leg: Leg;
  flow: DealFlow;
  busy: boolean;
  capTo?: number;
  onPair: (t: UnallocatedTxn, leg: Leg, amount?: number) => void;
}) {
  const remaining = t.unallocated;
  const original = t.original ?? t.amount;
  const elsewhere = Math.max(0, (t.allocated ?? 0) - (t.mine ?? 0));
  const splitOff = elsewhere > 0.005 || (t.mine ?? 0) > 0.005;
  // Default to what this leg still needs, capped by what's free on the transaction.
  const smart = capTo && capTo > 0.005 ? Math.min(remaining, capTo) : remaining;
  const [amt, setAmt] = useState<string>(smart.toFixed(2));
  const isMatch = matches(t, leg, flow);
  const payer = t.counterparty_name?.trim() || t.description?.trim() || "Bank transaction";
  const clr = t.direction === "out" ? "text-danger-ink" : "text-success-ink";
  const sign = t.direction === "out" ? "−" : "";
  const val = parseFloat(amt);
  const invalid = !(val > 0.005) || val > remaining + 0.005;

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink truncate flex items-center gap-1.5">
            <span className="truncate">{payer}</span>
            {isMatch && <span className="text-[10px] text-accent font-semibold flex-shrink-0">match</span>}
          </div>
          <div className="text-[11px] text-muted tabular-nums">
            {fmtShortDate(t.posted_at)}
            {splitOff && (
              <span> · {fmtAmount(remaining)} left of {fmtAmount(original)}</span>
            )}
          </div>
        </div>
        <span className={`text-[12px] font-semibold tabular-nums ${clr} flex-shrink-0`}>{sign}{fmtAmount(remaining)}</span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <span className="text-[11px] text-muted flex-shrink-0">Allocate</span>
          <div className="flex items-center h-7 px-2 rounded-lg border border-line bg-surface-2 flex-1 min-w-0 max-w-[160px]">
            <span className="text-[12px] text-muted">$</span>
            <input
              value={amt}
              onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              className="w-full bg-transparent text-[12px] text-ink tabular-nums focus:outline-none ml-0.5"
            />
          </div>
          {remaining - val > 0.005 && !invalid && (
            <span className="text-[11px] text-muted tabular-nums flex-shrink-0">{fmtAmount(remaining - val)} left after</span>
          )}
        </div>
        <button
          type="button"
          disabled={busy || invalid}
          onClick={() => onPair(t, leg, val)}
          className="h-7 px-3 flex items-center gap-1 rounded-lg bg-accent text-on-accent text-[12px] font-semibold disabled:opacity-40 transition-colors flex-shrink-0"
        >
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

// Match hint: same buyer name, or amount ≈ the expected leg amount.
function matches(t: UnallocatedTxn, leg: Leg, flow: DealFlow): boolean {
  const cp = (t.counterparty_name || "").trim().toLowerCase();
  const name = (flow.client_name || "").toLowerCase();
  const byName = cp.length > 2 && name.length > 0 && (name.includes(cp) || cp.includes(name));
  const byAmount = !!leg.target && Math.abs(leg.target - t.unallocated) < 0.5;
  return byName || byAmount;
}
