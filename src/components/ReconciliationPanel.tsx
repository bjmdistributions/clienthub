import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Trash2, Plus, X, Search } from "lucide-react";
import { api, DealFlow, DealAllocation, UnallocatedTxn } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Payments & reconciliation ────────────────────────────────────────────
// Pair real bank transactions to a completed deal's money legs (buyer payment,
// supplier payment, wire fees), show actual-vs-expected profit, and surface a
// "fully reconciled" state. Links are exclusive: the picker only ever shows
// transactions not yet allocated to any other deal.

const fmtShortDate = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

type Leg = {
  role: "buyer_payment" | "supplier_payment" | "fee";
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

  const buyerSum = buyer.reduce((s, a) => s + a.amount, 0);
  const supplierSum = supplier.reduce((s, a) => s + a.amount, 0);
  const buyerComplete = flow.invoice_total > 0 ? buyerSum >= flow.invoice_total - 0.5 : buyer.length > 0;
  const supplierComplete = flow.total_supplier_cost > 0 ? supplierSum >= flow.total_supplier_cost - 0.5 : supplier.length > 0;
  const fullyReconciled = recon?.fully_reconciled ?? (buyerComplete && supplierComplete);
  const anyPaired = buyer.length > 0 || supplier.length > 0 || fees.length > 0;

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

  const pair = async (t: UnallocatedTxn, leg: Leg) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.allocateBankTxn(t.id, flow.id, t.unallocated, leg.role, "");
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
        />

        {/* Wire fees (money-out, optional, subtract from actual profit) */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium text-ink">Wire fees</div>
            <div className="flex items-center gap-2">
              {feeSum > 0 && <span className="text-[13px] font-semibold text-danger-ink tabular-nums">−{fmtAmount(feeSum)}</span>}
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
          {picker?.role === "fee" && (
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
  onPair: (t: UnallocatedTxn, leg: Leg) => void;
  onUnpair: (id: string) => void;
  pairLabel: string;
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
        <PairButton active={open} label={paired ? "Pair another" : pairLabel} onOpen={() => onOpen(leg)} onClose={onClose} />
      </div>

      {paired && (
        <div className="mt-2 space-y-1.5">
          {rows.map((a) => <PairedRow key={a.id} a={a} onUnpair={onUnpair} busy={busy} />)}
        </div>
      )}

      {open && <Picker leg={leg} cands={cands} busy={busy} flow={flow} onPair={onPair} />}
    </div>
  );
}

// ── A paired transaction row: payer/desc + date on the left, amount + unpair right ──
function PairedRow({ a, onUnpair, busy }: { a: DealAllocation; onUnpair: (id: string) => void; busy: boolean }) {
  const payer = a.counterparty_name?.trim() || a.description?.trim() || "Bank transaction";
  const sign = a.direction === "out" ? "−" : "";
  const clr = a.direction === "out" ? "text-danger-ink" : "text-success-ink";
  return (
    <div className="flex items-center gap-2 bg-surface-2 border border-line-2 rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink truncate">{payer}</div>
        <div className="text-[11px] text-muted">{fmtShortDate(a.posted_at)}</div>
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
function Picker({ leg, cands, busy, flow, onPair }: {
  leg: Leg;
  cands: UnallocatedTxn[] | null;
  busy: boolean;
  flow: DealFlow;
  onPair: (t: UnallocatedTxn, leg: Leg) => void;
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
            <div className="max-h-64 overflow-y-auto divide-y divide-line-2">
              {shown.map((t) => {
                const isMatch = matches(t, leg, flow);
                const payer = t.counterparty_name?.trim() || t.description?.trim() || "Bank transaction";
                const clr = t.direction === "out" ? "text-danger-ink" : "text-success-ink";
                const sign = t.direction === "out" ? "−" : "";
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={busy}
                    onClick={() => onPair(t, leg)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-ink truncate flex items-center gap-1.5">
                        <span className="truncate">{payer}</span>
                        {isMatch && <span className="text-[10px] text-accent font-semibold flex-shrink-0">match</span>}
                      </div>
                      <div className="text-[11px] text-muted">{fmtShortDate(t.posted_at)}</div>
                    </div>
                    <span className={`text-[12px] font-semibold tabular-nums ${clr}`}>{sign}{fmtAmount(t.unallocated)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
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
