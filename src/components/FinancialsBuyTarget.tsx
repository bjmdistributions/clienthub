// R-552: Financials > a money out row > Inventory buy. A buy is never a deal, so it is never in the deal list; this ties the
// row to the buy the way the buy's own picker does (pay_warehouse_buy), and the buy spreads it over its orders' deals.
// A payment more than is left to pay asks first (PayAsk), the same question the buy screen asks.
import { useEffect, useState } from "react";
import { Link2, Loader2, Search } from "lucide-react";
import { api, type BankTxn, type BuyChoice, type BuyKind } from "../lib/api";
import { legOf, payChoice, type BuyTake, type PayChoice } from "../lib/buyPay";
import { fmtAmount } from "../lib/format";
import { PayAsk, paidToast } from "./BuyPanel";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

const field = "border border-line px-2.5 h-9 rounded-lg text-[13px] w-full bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function FinancialsBuyTarget({ txn, preselect, onDone }: { txn: BankTxn; preselect?: string; onDone: () => void }) {
  const [buys, setBuys] = useState<BuyChoice[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<BuyChoice | null>(null);
  const [kind, setKind] = useState<BuyKind>("goods");
  const [asking, setAsking] = useState<Extract<PayChoice, { kind: "ask" }> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.warehouseBuyChoices().then((r) => {
      setBuys(r);
      if (preselect) setPicked(r.find((b) => b.id === preselect) ?? null);
    }).catch((e) => { toast(`Couldn't load the buys: ${e}`, "error"); setBuys([]); });
  }, [preselect]);
  useEffect(() => { setAsking(null); }, [picked, kind]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (buys || []).filter((b) => words.every((w) => `${b.name} ${b.supplier_name} ${b.stock_name}`.toLowerCase().includes(w))).slice(0, 40);
  const room = txn.unallocated > 0.005 ? txn.unallocated : 0;
  const shipByTruck = !!picked && kind === "ship" && picked.trucks > 0;

  const send = async (take?: BuyTake, raised = false) => {
    if (!picked) return;
    setBusy(true);
    try {
      const d = await api.payWarehouseBuy(picked.id, kind, { txnId: txn.id, take });
      paidToast(d, kind, raised);
      setAsking(null);
      onDone();
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  const link = () => {
    if (!picked) { toast("Pick the buy first", "error"); return; }
    const c = payChoice(legOf(picked, kind).total, legOf(picked, kind).paid, room);
    if (c.kind === "none") { toast("Nothing is left on this payment to book.", "error"); return; }
    if (c.kind === "ask") { setAsking(c); return; }
    send(undefined, c.raisesTo !== undefined);
  };

  return (
    <div className="space-y-2">
      {picked ? (
        <div className="flex items-center justify-between gap-3 border border-line-2 rounded-lg px-3 py-2">
          <BuyLine b={picked} kind={kind} />
          <button onClick={() => setPicked(null)} className="flex-shrink-0 text-[12px] text-accent hover:text-accent-hover">Change</button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a buy by its name or supplier" className={`${field} pl-8`} />
          </div>
          <div className="max-h-60 overflow-y-auto border border-line-2 rounded-lg divide-y divide-line-2">
            {buys === null ? <p className="text-[12px] text-muted px-3 py-2">Loading…</p>
              : shown.length === 0 ? <p className="text-[12px] text-muted px-3 py-2">{q ? "No buy matches that." : "No buys yet. Record one on a Warehouse product, or start one in Deal Flow, Inventory."}</p>
              : shown.map((b) => (
                <button key={b.id} onClick={() => setPicked(b)} className="w-full text-left px-3 py-2 hover:bg-surface-2/60">
                  <BuyLine b={b} kind={kind} />
                </button>
              ))}
          </div>
        </>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
        <select value={kind} onChange={(e) => setKind(e.target.value as BuyKind)} aria-label="What this money is" className={`${field} sm:col-span-8`}>
          <option value="goods">Paid to the supplier for the goods</option>
          <option value="ship">Paid for the shipping in</option>
        </select>
        <button onClick={link} disabled={busy || !picked || shipByTruck || room <= 0}
          className="sm:col-span-4 flex items-center justify-center gap-1.5 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Link to the buy
        </button>
      </div>
      {shipByTruck && <p className="text-[11.5px] text-muted">This buy comes in on its own trucks, so a carrier payment is tied to its truck in Logistics, Pay carriers.</p>}
      {!shipByTruck && <p className="text-[11.5px] text-muted">The buy spreads it over every order sold from it, as each one's cost, and holds the rest until the stock sells.</p>}
      {asking && <PayAsk choice={asking} busy={busy} onTake={(t) => send(t, t === "all")} onCancel={() => setAsking(null)} />}
    </div>
  );
}

function BuyLine({ b, kind }: { b: BuyChoice; kind: BuyKind }) {
  const leg = legOf(b, kind);
  return (
    <span className="min-w-0 flex-1 flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-ink truncate">{b.name || b.stock_name || "Unnamed buy"}</span>
        <span className="block text-[11.5px] text-muted truncate">{b.supplier_name ? `From ${b.supplier_name}` : "No supplier named"}</span>
      </span>
      <span className="flex items-center gap-2 flex-shrink-0">
        {b.on_the_way && <StatusPill tone="neutral">On the way</StatusPill>}
        <span className="text-[11.5px] text-muted tabular-nums whitespace-nowrap">
          {leg.total > 0.005 ? `${fmtAmount(leg.paid)} of ${fmtAmount(leg.total)} paid` : kind === "goods" ? "No price yet" : "No shipping in yet"}
        </span>
      </span>
    </span>
  );
}
