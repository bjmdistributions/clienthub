import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight, Plus, X, Trash2, Search, Link2,
  CheckCircle2, AlertTriangle, ArrowDownLeft, ArrowUpRight,
} from "lucide-react";
import { api, DealAllocation, DealReceipt, RefundRow, UnallocatedTxn } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Refund workspace ───────────────────────────────────────────────────────
// One place to run a deal's refund end to end: mark the money received (link the
// real bank transactions, or add a custom line for anything not in the feed), set
// how much is owed back, record each refund payment (linked to a bank transaction
// or a custom amount), and watch the remaining balance fall to zero.
//
// Received money links live in bank_allocation(buyer_payment); custom received
// lines in deal_receipts; refund payments in the refunds table (linked ones also
// mirror to bank_allocation(refund_out)). Everything is exclusive — a transaction
// linked here never shows up for another deal.

const fmtDate = (s?: string) => {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// A searchable list of unallocated bank transactions to pick from. Numeric queries
// match the remaining amount exactly (to the cent); words match payee or memo.
function TxnPicker({ txns, onPick, onClose }: {
  txns: UnallocatedTxn[]; onPick: (t: UnallocatedTxn, amount: number) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  // After a row is picked, ask how much to apply — so a single payment can be
  // linked in part (the rest stays available to split onto another deal).
  const [picked, setPicked] = useState<UnallocatedTxn | null>(null);
  const [amt, setAmt] = useState("");
  const ql = q.trim().toLowerCase();
  const filtered = txns.filter((t) => {
    if (!ql) return true;
    const isNum = /^[$\d., ]+$/.test(ql);
    if (isNum) {
      const n = parseFloat(ql.replace(/[$,\s]/g, ""));
      if (isFinite(n)) return Math.abs(t.unallocated - n) < 0.005 || t.unallocated.toFixed(2).includes(ql.replace(/[$,\s]/g, ""));
    }
    return (t.counterparty_name || "").toLowerCase().includes(ql) || (t.description || "").toLowerCase().includes(ql);
  });

  if (picked) {
    const max = picked.unallocated;
    const confirm = () => {
      const n = amt.trim() ? parseFloat(amt.replace(/[$,\s]/g, "")) : max;
      if (!isFinite(n) || n <= 0 || n > max + 0.005) return;
      onPick(picked, Math.min(n, max));
    };
    return (
      <div className="border border-line rounded-lg bg-surface-2 mt-2 p-3 space-y-2">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="flex-1 min-w-0 truncate text-ink">{picked.counterparty_name || picked.description || "—"}</span>
          <span className={`tabular-nums font-medium ${picked.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(max)}</span>
        </div>
        <div className="flex items-center gap-2">
          <input autoFocus value={amt} onChange={(e) => setAmt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
            placeholder={max.toFixed(2)}
            className="bg-surface border border-line rounded-lg h-8 px-2 w-28 text-[12px] text-ink tabular-nums" />
          <span className="text-[11px] text-muted">of {fmtAmount(max)} available</span>
          <button onClick={confirm} className="ml-auto h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium transition-colors">Link</button>
          <button onClick={() => setPicked(null)} className="text-muted hover:text-ink-2"><X size={14} /></button>
        </div>
        <div className="text-[10.5px] text-muted">Enter a smaller amount to apply only part of this transaction; the rest stays available.</div>
      </div>
    );
  }

  return (
    <div className="border border-line rounded-lg bg-surface-2 mt-2 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 h-8 border-b border-line-2">
        <Search size={13} className="text-muted flex-shrink-0" />
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search payee or exact amount…"
          className="flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-muted focus:outline-none"
        />
        <button onClick={onClose} className="text-muted hover:text-ink-2"><X size={14} /></button>
      </div>
      <div className="max-h-56 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-muted text-center leading-relaxed">
            {txns.length === 0
              ? "No unlinked transactions in the bank feed."
              : "No match. Transfers between your own accounts aren't listed here — find those in Financials, or add a custom line."}
          </div>
        ) : filtered.map((t) => (
          <button
            key={t.id} onClick={() => { setPicked(t); setAmt(""); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-3 border-b border-line-2 last:border-0 transition-colors"
          >
            <span className="text-muted tabular-nums text-[11px] w-11 flex-shrink-0">{fmtDate(t.posted_at)}</span>
            <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink">{t.counterparty_name || t.description || "—"}</span>
            <span className={`tabular-nums text-[12.5px] font-medium ${t.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
              {fmtAmount(t.unallocated)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function RefundWorkspace({ dealFlowId, primary = false }: { dealFlowId: string; primary?: boolean }) {
  const [allocs, setAllocs] = useState<DealAllocation[]>([]);
  const [receipts, setReceipts] = useState<DealReceipt[]>([]);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [payout, setPayout] = useState<any>(null);
  const [unalloc, setUnalloc] = useState<{ money_in: UnallocatedTxn[]; money_out: UnallocatedTxn[] }>({ money_in: [], money_out: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);

  // Section-local input state.
  const [pickReceived, setPickReceived] = useState(false);
  const [showCustomRecv, setShowCustomRecv] = useState(false);
  const [customRecvAmt, setCustomRecvAmt] = useState("");
  const [customRecvLabel, setCustomRecvLabel] = useState("");
  const [pickRefund, setPickRefund] = useState(false);
  const [showManualRefund, setShowManualRefund] = useState(false);
  const [refundAmt, setRefundAmt] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundSource, setRefundSource] = useState("business");

  const load = useCallback(async () => {
    try {
      const [a, rc, rf, p, un] = await Promise.all([
        api.dealAllocations(dealFlowId),
        api.listDealReceipts(dealFlowId),
        api.listRefunds(dealFlowId),
        api.dealFlowPayout(dealFlowId).catch(() => null),
        api.unallocatedBankTxns(dealFlowId).catch(() => ({ money_in: [], money_out: [] })),
      ]);
      setAllocs(a || []); setReceipts(rc || []); setRefunds(rf || []); setPayout(p);
      setUnalloc(un || { money_in: [], money_out: [] });
    } catch (e: any) {
      setErr(typeof e === "string" ? e : e?.message || "Failed to load refund data");
    }
  }, [dealFlowId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Something went wrong";
      setErr(msg); toast(msg, "error");
    }
    finally { setBusy(false); }
  };

  const receivedLinked = allocs.filter((a) => a.role === "buyer_payment");
  const totalReceived = receivedLinked.reduce((s, a) => s + a.amount, 0) + receipts.reduce((s, r) => s + r.amount, 0);
  const refundOwed: number = payout?.refund_owed || 0;
  const totalRefunded = refunds.reduce((s, r) => s + r.amount, 0);
  const remaining = Math.max(refundOwed - totalRefunded, 0);

  const hasActivity = refundOwed > 0 || refunds.length > 0;
  // As the primary view (refund mode) it's always open — no collapse.
  const open = primary ? true : (openOverride ?? hasActivity);

  // Actions
  const linkReceived = (t: UnallocatedTxn, amount: number) => run(async () => {
    await api.allocateBankTxn(t.id, dealFlowId, amount, "buyer_payment", "Payment received");
    setPickReceived(false);
  });
  const addCustomReceived = () => {
    const n = parseFloat(customRecvAmt.replace(/[$,]/g, ""));
    if (!isFinite(n) || n <= 0) { setErr("Enter a received amount."); return; }
    run(async () => {
      await api.addDealReceipt(dealFlowId, n, customRecvLabel.trim() || undefined);
      setCustomRecvAmt(""); setCustomRecvLabel(""); setShowCustomRecv(false);
    });
  };
  const linkRefund = (t: UnallocatedTxn, amount: number) => run(async () => {
    await api.createRefund(dealFlowId, amount, { source: "business", bankTxnId: t.id });
    setPickRefund(false);
  });
  const addManualRefund = () => {
    const n = parseFloat(refundAmt.replace(/[$,]/g, ""));
    if (!isFinite(n) || n <= 0) { setErr("Enter a refund amount."); return; }
    run(async () => {
      await api.createRefund(dealFlowId, n, { source: refundSource, reason: refundReason.trim() || undefined });
      setRefundAmt(""); setRefundReason(""); setShowManualRefund(false);
    });
  };

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      {/* Header — always visible, toggles the workspace + shows the balance */}
      <button
        onClick={() => { if (!primary) setOpenOverride(!open); }}
        className={`w-full px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${primary ? "cursor-default" : "hover:bg-surface-2"}`}
      >
        <span className={`flex items-center gap-1.5 font-semibold text-ink-2 ${primary ? "text-[14px]" : "text-[13px]"}`}>
          {!primary && <ChevronRight size={14} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
          Refund
        </span>
        {remaining > 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-danger-ink">
            <AlertTriangle size={12} /> {fmtAmount(remaining)} still owed
          </span>
        ) : refundOwed > 0 ? (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-success-ink">
            <CheckCircle2 size={13} /> Fully refunded
          </span>
        ) : (
          <span className="text-[11px] text-muted">Start a refund</span>
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-line-2">
          {/* 1 · Money received */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12.5px] font-medium text-ink-2">Money received</span>
              <span className="tabular-nums text-[13px] font-semibold text-success-ink">{fmtAmount(totalReceived)}</span>
            </div>
            <div className="space-y-0.5">
              {receivedLinked.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[12px] py-1">
                  <ArrowDownLeft size={13} className="text-success-ink flex-shrink-0" />
                  <span className="text-muted tabular-nums text-[11px] w-11 flex-shrink-0">{fmtDate(a.posted_at)}</span>
                  <span className="flex-1 min-w-0 truncate text-ink" title={a.counterparty_name || a.description}>
                    {a.counterparty_name || a.description || "Payment"}
                  </span>
                  <span className="tabular-nums text-ink">{fmtAmount(a.amount)}</span>
                  <button onClick={() => run(async () => { await api.removeBankAllocation(a.id); })} disabled={busy}
                    title="Unlink" className="text-faint hover:text-danger-ink transition-colors"><X size={13} /></button>
                </div>
              ))}
              {receipts.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[12px] py-1">
                  <span className="w-[13px] flex-shrink-0" />
                  <span className="text-muted text-[11px] w-11 flex-shrink-0">custom</span>
                  <span className="flex-1 min-w-0 truncate text-ink">{r.label || "Received (manual)"}</span>
                  <span className="tabular-nums text-ink">{fmtAmount(r.amount)}</span>
                  <button onClick={() => run(async () => { await api.deleteDealReceipt(r.id); })} disabled={busy}
                    title="Remove" className="text-faint hover:text-danger-ink transition-colors"><X size={13} /></button>
                </div>
              ))}
              {receivedLinked.length === 0 && receipts.length === 0 && (
                <div className="text-[11.5px] text-muted py-1">No payments recorded yet.</div>
              )}
            </div>
            <div className="flex items-center gap-4 mt-2">
              <button onClick={() => { setPickReceived((v) => !v); setShowCustomRecv(false); }}
                className="flex items-center gap-1 text-[11.5px] text-accent hover:text-accent-hover"><Link2 size={12} /> Link a payment</button>
              <button onClick={() => { setShowCustomRecv((v) => !v); setPickReceived(false); }}
                className="flex items-center gap-1 text-[11.5px] text-muted hover:text-ink-2"><Plus size={12} /> Add custom line</button>
            </div>
            {pickReceived && <TxnPicker txns={unalloc.money_in} onPick={linkReceived} onClose={() => setPickReceived(false)} />}
            {showCustomRecv && (
              <div className="flex items-center gap-2 mt-2">
                <input value={customRecvAmt} onChange={(e) => setCustomRecvAmt(e.target.value)} placeholder="Amount"
                  className="bg-surface-2 border border-line rounded-lg h-8 px-2 w-28 text-[12px] text-ink tabular-nums" />
                <input value={customRecvLabel} onChange={(e) => setCustomRecvLabel(e.target.value)} placeholder="Label (e.g. cash, Zelle)"
                  className="bg-surface-2 border border-line rounded-lg h-8 px-2 flex-1 min-w-0 text-[12px] text-ink" />
                <button onClick={addCustomReceived} disabled={busy}
                  className="h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium transition-colors">Add</button>
              </div>
            )}
          </section>

          <div className="border-t border-line-2" />

          {/* 2 · Refund owed */}
          <section className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-ink-2 flex-1">Refund owed</span>
            <input
              type="number" key={refundOwed} defaultValue={refundOwed || ""}
              onBlur={(e) => { const v = parseFloat(e.target.value); if (isFinite(v)) run(async () => { await api.setRefundOwed(dealFlowId, v); }); }}
              placeholder="0.00"
              className="bg-surface-2 border border-line rounded-lg h-8 px-2 w-28 text-[12px] text-ink tabular-nums text-right"
            />
            <button onClick={() => run(async () => { await api.setRefundOwed(dealFlowId, totalReceived); })} disabled={busy || totalReceived <= 0}
              className="text-[11px] text-muted hover:text-ink-2 px-2 h-8 border border-line rounded-lg whitespace-nowrap disabled:opacity-40 transition-colors">
              Full ({fmtAmount(totalReceived)})
            </button>
          </section>

          <div className="border-t border-line-2" />

          {/* 3 · Refund payments */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12.5px] font-medium text-ink-2">Refund payments</span>
              <span className="tabular-nums text-[13px] font-semibold text-danger-ink">
                {totalRefunded > 0 ? `−${fmtAmount(totalRefunded)}` : fmtAmount(0)}
              </span>
            </div>
            <div className="space-y-0.5">
              {refunds.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-[12px] py-1">
                  <ArrowUpRight size={13} className="text-danger-ink flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-ink">
                    {r.bank_txn_id
                      ? <span className="inline-flex items-center gap-1 text-[10.5px] text-success-ink mr-1.5 align-middle"><Link2 size={10} /> linked</span>
                      : <span className="text-[10.5px] text-muted mr-1.5">custom</span>}
                    {r.reason || (r.source === "supplier" ? "Supplier reversal" : "Refund")}
                  </span>
                  <span className="tabular-nums text-ink">{fmtAmount(r.amount)}</span>
                  <button onClick={() => run(async () => { await api.deleteRefund(r.id); })} disabled={busy}
                    title="Remove refund" className="text-faint hover:text-danger-ink transition-colors"><Trash2 size={12} /></button>
                </div>
              ))}
              {refunds.length === 0 && <div className="text-[11.5px] text-muted py-1">No refunds recorded yet.</div>}
            </div>
            <div className="flex items-center gap-4 mt-2">
              <button onClick={() => { setPickRefund((v) => !v); setShowManualRefund(false); }}
                className="flex items-center gap-1 text-[11.5px] text-accent hover:text-accent-hover"><Link2 size={12} /> Link a refund payment</button>
              <button onClick={() => { setShowManualRefund((v) => !v); setPickRefund(false); }}
                className="flex items-center gap-1 text-[11.5px] text-muted hover:text-ink-2"><Plus size={12} /> Add custom amount</button>
            </div>
            {pickRefund && <TxnPicker txns={unalloc.money_out} onPick={linkRefund} onClose={() => setPickRefund(false)} />}
            {showManualRefund && (
              <div className="space-y-2 mt-2 bg-surface-2 rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <input value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} placeholder="Refund amount"
                    className="bg-surface border border-line rounded-lg h-8 px-2 flex-1 min-w-0 text-[12px] text-ink tabular-nums" />
                  <select value={refundSource} onChange={(e) => setRefundSource(e.target.value)}
                    className="bg-surface border border-line rounded-lg h-8 px-2 text-[12px] text-ink">
                    <option value="business">From business</option>
                    <option value="supplier">Supplier reversal</option>
                  </select>
                </div>
                <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Reason (optional)"
                  className="bg-surface border border-line rounded-lg h-8 px-2 w-full text-[12px] text-ink" />
                <button onClick={addManualRefund} disabled={busy}
                  className="w-full h-8 rounded-lg bg-danger-bg border border-danger text-danger-ink text-[12px] font-medium hover:opacity-90 transition-opacity">
                  Record refund
                </button>
              </div>
            )}
          </section>

          {/* 4 · Remaining owed */}
          {(refundOwed > 0 || totalRefunded > 0) && (
            <div className={`flex items-center justify-between rounded-lg px-3 py-2 border ${remaining > 0 ? "bg-danger-bg border-danger" : "bg-success-bg border-success"}`}>
              <span className={`text-[12px] font-medium ${remaining > 0 ? "text-danger-ink" : "text-success-ink"}`}>
                {remaining > 0 ? "Still owed to customer" : "Fully refunded"}
              </span>
              <span className={`tabular-nums font-bold ${remaining > 0 ? "text-danger-ink" : "text-success-ink"}`}>
                {fmtAmount(remaining)}
              </span>
            </div>
          )}

          {err && <div className="text-[11.5px] text-danger-ink">{err}</div>}
        </div>
      )}
    </div>
  );
}
