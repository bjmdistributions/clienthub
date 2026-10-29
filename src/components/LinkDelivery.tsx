// R-574: link an invoice to a shoe delivery, from the delivery's Sell tab, an invoice or a deal.
// Jack, 2026-10-29: "I select where the cost goes and the cost should include the shipping price combined ... its fully
// landed, that gets slapped on whatever line on the invoice i please. i keep shipping separate".
// The landed cost a pair (the buy's goods + shipping in) is offered, can be changed, and goes on the deal only for the
// invoice lines he ticks. Shipping lines are never offered: the buyer's shipping is never touched.

import { useEffect, useState } from "react";
import { api, type BuyBrief, type Invoice } from "../lib/api";
import { parseLineItems } from "../lib/itemSearch";
import { isShippingLine } from "../lib/format";
import type { CaseLine, LoadDetail, LoadSummary } from "../lib/deliveries";
import { toast } from "./Toast";
import { WH_BTN_PRIMARY, WH_BTN_SECONDARY, WH_CARD, WH_INPUT, WH_INPUT_BG, n0 } from "./warehouseUi";

const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (s: string) => Number(String(s).replace(/[$,\s]/g, "")) || 0;

/** An invoice as the pickers name it: its number, who is buying, its date and total. */
export const invoiceLabel = (i: Invoice, buyer: string) => [i.number, buyer, i.issue_date, money(i.total)].filter(Boolean).join(" · ");

/** The landed cost a pair the buy works out: its goods and its shipping in. */
export const landedOf = (b: BuyBrief) => r2(b.unit_goods + b.unit_ship);

/** The goods share to type on the order so its one line comes to `landed` a pair: the shipping in stays the buy's. */
export function typedGoods(b: BuyBrief, landed: number, pairs: number): number | null {
  if (!(landed > 0) || Math.abs(landed - landedOf(b)) <= 0.005) return null;
  return Math.max(0, r2(landed * pairs - pairs * b.unit_ship));
}

export default function LinkDelivery({ loadId, invoice, exclude, pick, onLinked, onCancel }: {
  /** The delivery, when linking from its Sell tab. */
  loadId?: string;
  /** The invoice, when linking from the Invoices or Deal Flow page. */
  invoice?: Invoice;
  /** Invoices already on this delivery, left out of the picker. */
  exclude?: Set<string>;
  /** The styles picked on the Sell tab, which can be linked instead of a pair count. */
  pick?: { pairs: number; takes: CaseLine[] };
  /** `usedPick`: the picked styles were linked, so the pick is done with. */
  onLinked: (d: LoadDetail, usedPick: boolean) => void;
  onCancel: () => void;
}) {
  const [invoices, setInvoices] = useState<Invoice[]>(invoice ? [invoice] : []);
  const [buyers, setBuyers] = useState<Record<string, string>>({});
  const [loads, setLoads] = useState<LoadSummary[]>([]);
  const [invId, setInvId] = useState(invoice?.id ?? "");
  const [lid, setLid] = useState(loadId ?? "");
  const [onLoad, setOnLoad] = useState<number | null>(null);
  const [buy, setBuy] = useState<BuyBrief | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [pairsText, setPairsText] = useState("");
  const [landedText, setLandedText] = useState("");
  const [by, setBy] = useState<"count" | "pick">(pick && pick.pairs > 0 ? "pick" : "count");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listClients().then((cs) => setBuyers(Object.fromEntries(cs.map((c) => [c.id, c.name])))).catch(() => {});
    if (!invoice) api.listInvoices().then(setInvoices).catch((e) => toast(String(e), "error"));
    if (!loadId) api.listWarehouseLoads().then((ls) => setLoads(ls.filter((l) => !l.archived))).catch((e) => toast(String(e), "error"));
  }, [invoice, loadId]);

  // The delivery's buy, its landed cost a pair, and whether this invoice is already on it.
  useEffect(() => {
    setBuy(null); setOnLoad(null);
    if (!lid) return;
    api.warehouseBuyFor({ loadId: lid }).then((r) => { setBuy(r.buy); setLandedText(r.buy ? landedOf(r.buy).toFixed(2) : ""); }).catch(() => setBuy(null));
    if (invId && !loadId) api.getWarehouseLoad(lid).then((d) => {
      const o = d.outs.find((x) => !x.undone && x.invoice_id === invId);
      setOnLoad(o ? o.pairs : null);
    }).catch(() => {});
  }, [lid, invId, loadId]);

  const inv = invoices.find((i) => i.id === invId);
  const items = inv ? parseLineItems(inv.line_items_json) : [];
  const goodsIdx = items.map((it, i) => (isShippingLine(it.description) ? -1 : i)).filter((i) => i >= 0);
  const shipLines = items.filter((it) => isShippingLine(it.description) && (Number(it.amount) || 0) !== 0);
  const chosenPairs = [...chosen].reduce((a, i) => a + Math.max(0, Math.round(Number(items[i]?.qty) || 0)), 0);

  // A new invoice ticks every line that is not shipping, and its pairs are theirs.
  useEffect(() => {
    const all = new Set(goodsIdx);
    setChosen(all);
    setPairsText(String([...all].reduce((a, i) => a + Math.max(0, Math.round(Number(items[i]?.qty) || 0)), 0) || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invId, invoices]);
  const tick = (i: number) => {
    const next = new Set(chosen);
    if (next.has(i)) next.delete(i); else next.add(i);
    setChosen(next);
    setPairsText(String([...next].reduce((a, j) => a + Math.max(0, Math.round(Number(items[j]?.qty) || 0)), 0) || ""));
  };

  const count = Math.max(0, Math.floor(num(pairsText)));
  const pairs = by === "pick" && pick ? pick.pairs : count;
  const landed = r2(num(landedText));
  const costOn = !!buy && chosen.size > 0;
  const ready = !!inv && !!lid && pairs > 0 && onLoad === null && (!costOn || landed > 0);
  const linkable = invoices.filter((i) => !i.voided && !exclude?.has(i.id)).sort((a, b) => (b.issue_date || "").localeCompare(a.issue_date || ""));
  const lineName = (i: number) => items[i]?.description?.trim() || "Line " + (i + 1);

  const link = async () => {
    if (!inv || !ready) return;
    setBusy(true);
    try {
      const names = [...chosen].sort((a, b) => a - b).map(lineName).join(", ");
      const note = names ? `Linked: ${names}`.slice(0, 200) : "Linked";
      const d = await api.takeLoadPairs(lid, { invoiceId: inv.id, reference: inv.number, note, takes: by === "pick" && pick ? pick.takes : [], over: true, pairs: by === "count" ? count : undefined });
      onLinked(d, by === "pick");
      if (!buy) { toast(`${inv.number} linked: ${n0(pairs)} pairs off this delivery. No buy is recorded on this delivery, so no cost went on the deal. Record it on the Buy tab.`, "error"); return; }
      await api.addWarehouseBuyOrder(buy.id, inv.id, pairs, costOn ? typedGoods(buy, landed, pairs) : null, !costOn)
        .then((r) => toast(!costOn ? `${inv.number} linked: ${n0(pairs)} pairs off this delivery. No cost went on the deal.`
          : r.own_cost ? `${inv.number} linked: ${n0(pairs)} pairs off this delivery. Its deal already has a supplier cost you typed, so that was kept.`
          : `${inv.number} linked: ${n0(pairs)} pairs at ${money(landed)} landed, ${money(r2(pairs * landed))} on its deal.`))
        .catch((e: any) => toast(`${inv.number} linked, but its cost did not reach the deal (${e}). The Buy tab can add it.`, "error"));
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className={`${WH_CARD} p-4 mb-3`}>
      <div className="text-[14px] font-semibold text-ink">{loadId ? "Link an invoice to this delivery" : "Link this invoice to a delivery"}</div>
      <p className="text-[12.5px] text-muted mt-0.5">Its pairs come off the delivery, even past what is in boxes. The landed cost a pair goes on the deal only for the lines you tick. The invoice itself is not changed.</p>

      {invoice ? (
        <div className="mt-3 text-[13px] text-ink">{invoiceLabel(invoice, buyers[invoice.client_id] || "")}</div>
      ) : (
        <label className="block mt-3 text-[12px] text-muted max-w-[520px]">Invoice
          <select value={invId} onChange={(e) => setInvId(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}>
            <option value="">Choose an invoice</option>
            {linkable.map((i) => <option key={i.id} value={i.id}>{invoiceLabel(i, buyers[i.client_id] || "")}</option>)}
          </select>
        </label>
      )}
      {!loadId && (
        <label className="block mt-3 text-[12px] text-muted max-w-[520px]">Delivery
          <select value={lid} onChange={(e) => setLid(e.target.value)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1`}>
            <option value="">Choose a delivery</option>
            {loads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
      {onLoad !== null && <p className="text-[12.5px] text-warning-ink mt-2">This invoice is already linked to that delivery ({n0(onLoad)} pairs).</p>}

      {inv && (
        <div className="mt-3">
          <div className="text-[12px] text-muted">Lines this cost goes on</div>
          {goodsIdx.length === 0 && <p className="text-[12.5px] text-muted mt-1">This invoice has no lines besides shipping.</p>}
          {goodsIdx.map((i) => (
            <label key={i} className="flex items-center gap-2 mt-1.5 text-[13px] text-ink-2">
              <input type="checkbox" checked={chosen.has(i)} onChange={() => tick(i)} />
              <span className="min-w-0 truncate">{lineName(i)}</span>
              <span className="text-[12px] text-muted tabular-nums whitespace-nowrap">{n0(Number(items[i].qty) || 0)} × {money(Number(items[i].rate) || 0)}</span>
            </label>
          ))}
          {shipLines.length > 0 && <p className="text-[12px] text-muted mt-1.5">Shipping on the invoice ({money(r2(shipLines.reduce((a, it) => a + (Number(it.amount) || 0), 0)))}) stays separate. No cost goes on it.</p>}
          {goodsIdx.length > 0 && chosen.size === 0 && <p className="text-[12px] text-muted mt-1.5">No line ticked: the pairs come off the delivery and no cost goes on the deal.</p>}
        </div>
      )}

      {pick && pick.pairs > 0 && (
        <div className="flex flex-wrap gap-4 mt-3 text-[13px] text-ink-2">
          <label className="flex items-center gap-2"><input type="radio" checked={by === "count"} onChange={() => setBy("count")} /> By the pair count</label>
          <label className="flex items-center gap-2"><input type="radio" checked={by === "pick"} onChange={() => setBy("pick")} /> The styles I picked ({n0(pick.pairs)} pairs)</label>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4 mt-3">
        {by === "count" && (
          <label className="block text-[12px] text-muted w-[160px]">Pairs
            <input value={pairsText} onChange={(e) => setPairsText(e.target.value)} inputMode="numeric" placeholder={String(chosenPairs || 0)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} />
          </label>
        )}
        {costOn && buy && (
          <label className="block text-[12px] text-muted w-[180px]">Landed cost a pair
            <input value={landedText} onChange={(e) => setLandedText(e.target.value)} inputMode="decimal" placeholder={landedOf(buy).toFixed(2)} style={WH_INPUT_BG} className={`${WH_INPUT} mt-1 tabular-nums`} />
          </label>
        )}
      </div>
      {by === "count" && <p className="text-[12px] text-muted mt-1">No style is named, so the delivery's total goes down but no one style does.</p>}
      {lid && !buy && <p className="text-[12px] text-muted mt-1">No buy is recorded on this delivery, so there is no cost to put on. Record it on the delivery's Buy tab.</p>}
      {costOn && buy && (
        <p className="text-[12.5px] text-ink-2 mt-2 tabular-nums">
          {money(r2(buy.unit_goods))} a pair + {money(r2(buy.unit_ship))} shipping in = {money(landedOf(buy))} landed, from {buy.name}.
          {pairs > 0 && landed > 0 && <> On the deal: {n0(pairs)} pairs × {money(landed)} = <span className="font-semibold text-ink">{money(r2(pairs * landed))}</span>, one supplier line.</>}
        </p>
      )}
      <div className="flex gap-2 mt-3">
        <button onClick={() => { void link(); }} disabled={!ready || busy} className={WH_BTN_PRIMARY}>{busy ? "Linking" : "Link it"}</button>
        <button onClick={onCancel} className={WH_BTN_SECONDARY}>Cancel</button>
      </div>
    </div>
  );
}

/** The card over any page: from an invoice or a deal. */
export function LinkDeliveryModal({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-[640px] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <LinkDelivery invoice={invoice} onLinked={() => onClose()} onCancel={onClose} />
      </div>
    </div>
  );
}
