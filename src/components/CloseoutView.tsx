import { ChevronRight, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, DealFlow, PayoutShare, dealPayoutSplit } from "../lib/api";
import { LogisticsPayCell, useDealLogisticsPay } from "./LogisticsPay";
import { DealPayoutsBox } from "./PayoutLedger";
import { fmtAmount, primarySupplierLabel, localDay, parseLocalDay, isShippingLine } from "../lib/format";
import { unitFigures, unitGap, type UnitLine } from "../lib/dealUnits";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Button, Kpi, PageActions } from "./ui";


// ─── helpers ─────────────────────────────────────────────────────────────────
function pct(n: number, d: number) { return d > 0 ? (n / d) * 100 : 0; }

// The margin chip: green from 30%, amber from 15%, red below. Colour only by meaning.
function MarginBadge({ margin }: { margin: number }) {
  return (
    <StatusPill tone={margin >= 30 ? "success" : margin >= 15 ? "warning" : "danger"}>
      {margin.toFixed(1)}%
    </StatusPill>
  );
}

function parseLines(json: string | null | undefined): UnitLine[] {
  try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ─── Main view ────────────────────────────────────────────────────────────────
export default function CloseoutView() {
  const [flows,   setFlows]   = useState<DealFlow[]>([]);
  const [recipients, setRecipients] = useState<PayoutShare[]>([]);
  const [lines, setLines] = useState<Record<string, UnitLine[]>>({});
  // R-402: the category and brand each completed deal carries.
  const [labels, setLabels] = useState<Record<string, { category: string; brand: string }>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [f, sp, inv] = await Promise.all([api.listDealFlows(), api.getPayoutSplit(), api.listInvoices().catch(() => [])]);
      setFlows(f.filter((fl) => fl.stage === "complete"));
      setRecipients(sp);
      setLines(Object.fromEntries(inv.map((i) => [i.id, parseLines(i.line_items_json)])));
    } catch (e) { console.error(e); }
    setLoading(false);
    api.listDealLabels().then((r) => {
      setLabels(Object.fromEntries(r.deals.map((d) => [d.id, { category: d.category_from ? d.category : "", brand: d.brand_from ? d.brand : "" }])));
    }).catch(() => { /* the table reads fine without labels */ });
  };
  useEffect(() => { load(); }, []);

  // ── Analytics ────────────────────────────────────────────────────────────
  const totalRevenue = flows.reduce((s, f) => s + f.gross_revenue, 0);
  const totalCost    = flows.reduce((s, f) => s + f.total_cost, 0);
  const totalProfit  = flows.reduce((s, f) => s + f.net_profit, 0);
  const avgMargin    = pct(totalProfit, totalRevenue);

  // Cost and charged per unit for every row, worked out once per load.
  const perUnit = useMemo(
    () => Object.fromEntries(flows.map((f) => [f.id, unitFigures(lines[f.invoice_id] ?? [], f)])),
    [flows, lines],
  );

  // Kept on screen while it reloads: only the very first load shows the skeleton.
  if (loading && flows.length === 0) return (
    <div>
      <div className="h-5 w-44 bg-surface-2 rounded animate-pulse mb-2" />
      <div className="h-3 w-28 bg-surface-2 rounded animate-pulse mb-4" />
      <div className="hsep" />
      <div className="grid grid-cols-4 gap-4 p-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2"><div className="h-3 w-20 bg-surface-2 rounded animate-pulse" /><div className="h-6 w-28 bg-surface-2 rounded animate-pulse" /></div>)}
      </div>
      <div className="hsep" />
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-14 border-t border-line first:border-t-0 flex items-center"><div className="h-3.5 w-1/3 bg-surface-2 rounded animate-pulse" /></div>)}
    </div>
  );

  return (
    <div>
      <PageActions>
        <Button onClick={load} icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}>Refresh</Button>
      </PageActions>

      <div className="mb-3 ml-1">
        <div className="text-[16px] font-medium text-ink">Completed deals</div>
        <div className="ui-note mt-0.5">{flows.length} deal{flows.length !== 1 ? "s" : ""} closed</div>
      </div>

      {/* ── Key figures ─────────────────────────────────────────────────── */}
      <div className="hsep" />
      <div className="grid grid-cols-2 lg:grid-cols-[1fr_1px_1fr_1px_1fr_1px_1fr] py-1.5">
        <Kpi label="Total revenue" value={totalRevenue} format={fmtAmount} />
        <div className="vsep hidden lg:block mt-4" />
        <Kpi label="Total cost" value={totalCost} format={fmtAmount} />
        <div className="vsep hidden lg:block mt-4" />
        <Kpi label="Net profit" value={totalProfit} format={(n) => (n < 0 ? "−" : "") + fmtAmount(Math.abs(n))} className={totalProfit >= 0 ? "[&_.ui-fig]:text-success-ink" : "[&_.ui-fig]:text-danger-ink"} />
        <div className="vsep hidden lg:block mt-4" />
        <Kpi label="Average margin" value={avgMargin} format={(n) => `${n.toFixed(1)}%`} className={avgMargin >= 20 ? "[&_.ui-fig]:text-success-ink" : avgMargin >= 10 ? "[&_.ui-fig]:text-warning-ink" : "[&_.ui-fig]:text-danger-ink"} />
      </div>
      <div className="hsep" />

      {/* ── Deals table ─────────────────────────────────────────────────── */}
      {flows.length === 0 ? (
        <div className="text-center py-24">
          <p className="text-[15px] font-medium text-ink-2 mb-1">No completed deals yet</p>
          <p className="text-[13px] text-muted">
            Deals appear here once you mark them complete in Deal Flow
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="ui-table ui-table-click [&_td]:px-2 [&_th]:px-2" aria-label="Completed deals">
            <thead>
              <tr>
                <th>Deal</th>
                <th>What it is</th>
                <th className="r" title="What you paid the supplier for the goods, per unit">Cost per unit</th>
                <th className="r" title="What the customer was billed for the goods, per unit">Charged per unit</th>
                <th className="r">Revenue</th>
                <th className="r hidden xl:table-cell">Cost</th>
                <th className="r">Profit</th>
                <th className="r">Margin</th>
                <th aria-hidden="true" className="w-8" />
              </tr>
            </thead>
            <tbody>
              {flows.map((flow) => {
                const margin = pct(flow.net_profit, flow.gross_revenue);
                const isExp  = expanded === flow.id;
                const sup    = primarySupplierLabel(flow.supplier_payments);
                const u      = perUnit[flow.id];
                const label  = labels[flow.id];
                const goods  = (lines[flow.invoice_id] ?? []).filter((l) => !isShippingLine(l.description));
                const toggle = () => setExpanded(isExp ? null : flow.id);
                return (
                  <Fragment key={flow.id}>
                    <tr aria-selected={isExp} onClick={toggle} tabIndex={0} role="button" aria-expanded={isExp}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } }}>
                      <td className="min-w-[160px]">
                        <div className="text-[14px] font-medium text-ink truncate">{flow.client_name || "None"}</div>
                        <div className="ui-note mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                          <span className="tabular-nums">{flow.invoice_number}</span>
                          {flow.completed_at && (
                            <span>
                              {parseLocalDay(flow.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          )}
                          {sup && <span className="min-w-0 truncate">{sup}</span>}
                        </div>
                      </td>
                      <td className="min-w-[140px] max-w-[220px]">
                        {(label?.category || label?.brand) && (
                          <div className="flex items-center gap-1.5 whitespace-nowrap mb-1">
                            {label.category && <StatusPill tone="neutral" title="Category">{label.category}</StatusPill>}
                            {label.brand && <StatusPill tone="neutral" title="Brand">{label.brand}</StatusPill>}
                          </div>
                        )}
                        <div className="text-[13px] text-ink-2 truncate">
                          {goods.length > 0
                            ? goods.map((l) => ((l.qty ?? 0) > 1 ? `${l.qty}× ${l.description}` : l.description)).join(" · ")
                            : <span className="text-faint">No line items</span>}
                        </div>
                      </td>
                      <td className="r">
                        {u.costPerUnit !== null ? fmtAmount(u.costPerUnit) : <span className="text-[12px] text-faint font-normal whitespace-normal">{unitGap(u, "cost")}</span>}
                      </td>
                      <td className="r">
                        {u.chargedPerUnit !== null ? fmtAmount(u.chargedPerUnit) : <span className="text-[12px] text-faint font-normal whitespace-normal">{unitGap(u, "charged")}</span>}
                      </td>
                      <td className="r font-medium">{fmtAmount(flow.gross_revenue)}</td>
                      <td className="r text-muted hidden xl:table-cell">{fmtAmount(flow.total_cost)}</td>
                      <td className={`r font-medium ${flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink"}`}>{fmtAmount(flow.net_profit)}</td>
                      <td className="r"><MarginBadge margin={margin} /></td>
                      <td className="w-8">
                        <ChevronRight size={16} className={`text-muted transition-transform duration-200 ${isExp ? "rotate-90" : ""}`} />
                      </td>
                    </tr>
                    {isExp && (
                      <tr className="!cursor-default">
                        <td colSpan={9} className="!p-0 !bg-surface-2">
                          <div className="px-5 py-5 df-in">
                            <DealBreakdown flow={flow} recipients={recipients} onReload={load} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <style>{`
            @keyframes dfIn { 0% { opacity: 0; transform: translateY(6px); } 100% { opacity: 1; transform: translateY(0); } }
            .df-in { animation: dfIn .18s cubic-bezier(.23,1,.32,1) both; }
            @media (prefers-reduced-motion: reduce) { .df-in { animation: none !important; } }
          `}</style>
        </div>
      )}
    </div>
  );
}

// ─── Expanded deal breakdown ──────────────────────────────────────────────────
function DealBreakdown({
  flow, recipients, onReload,
}: { flow: DealFlow; recipients: PayoutShare[]; onReload: () => void }) {
  const [saving, setSaving] = useState(false);
  // Completed deals show the breakdown captured at completion; older deals
  // (no stored breakdown) fall back to re-deriving from the current config.
  const alloc = dealPayoutSplit(flow, recipients);
  // R-401: the logistics pay comes off the top before the split, like a rep's cut.
  const logiPay = useDealLogisticsPay(flow.id, [flow.updated_at, flow.total_cost, flow.shipping_cost]);
  const payments = flow.supplier_payments || [];
  const margin   = pct(flow.net_profit, flow.gross_revenue);

  // Editable completion date for backlogs
  const todayStr = localDay();
  const initialDate = flow.completed_at ? flow.completed_at.slice(0, 10) : todayStr;
  const [editDate, setEditDate] = useState(initialDate);
  const [dateSaving, setDateSaving] = useState(false);

  const handleSaveDate = async () => {
    if (!editDate) return;
    setDateSaving(true);
    try { await api.updateDealCompletedAt(flow.id, editDate); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setDateSaving(false);
  };

  const handleReopen = async () => {
    if (!confirm("Reopen this deal? It will move back to the active Deal Flow.")) return;
    setSaving(true);
    try { await api.uncompleteDealFlow(flow.id); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Permanently delete this deal record? This cannot be undone.")) return;
    setSaving(true);
    try { await api.deleteDealFlow(flow.id); onReload(); }
    catch (e: any) { toast(String(e), "error"); }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      {/* Profit and loss */}
      <div className="grid grid-cols-2 lg:grid-cols-[1fr_1px_1fr_1px_1fr_1px_1fr] gap-x-4 gap-y-3">
        {[
          { label: "Revenue",                                      value: fmtAmount(flow.gross_revenue), clr: "text-ink"   },
          { label: "Total cost",                                   value: fmtAmount(flow.total_cost),    clr: "text-ink"   },
          {
            label: flow.net_profit >= 0 ? "Profit" : "Loss",
            value: fmtAmount(flow.net_profit),
            clr:   flow.net_profit >= 0 ? "text-success-ink" : "text-danger-ink",
          },
          {
            label: "Margin",
            value: `${margin.toFixed(1)}%`,
            clr:   margin >= 20 ? "text-success-ink" : margin >= 10 ? "text-warning-ink" : "text-danger-ink",
          },
        ].map((item, i) => (
          <Fragment key={item.label}>
            {i > 0 && <div className="vsep hidden lg:block" />}
            <div>
              <div className="ui-label mb-1">{item.label}</div>
              <div className={`text-[20px] font-medium tabular-nums tracking-tight ${item.clr}`}>{item.value}</div>
            </div>
          </Fragment>
        ))}
      </div>

      {/* Supplier payments */}
      {payments.length > 0 && (
        <>
          <div className="hsep" />
          <div>
            <p className="text-[14px] font-medium text-ink mb-1">Supplier payments</p>
            <div>
              {payments.map((p) => (
                <div key={p.id} className="flex items-center gap-3 py-2.5 border-t border-line first:border-t-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-ink font-medium">{p.supplier_name}</div>
                    {p.quantity != null && p.unit_price != null && (
                      <div className="text-[12px] text-muted tabular-nums">
                        {p.quantity} × {fmtAmount(p.unit_price)}
                      </div>
                    )}
                    {flow.shipping_mode && p.category === "freight" && (
                      <div className="text-[12px] text-muted">Replaced by the logistics booking, not counted</div>
                    )}
                  </div>
                  <div className={`text-[13px] font-medium tabular-nums ${flow.shipping_mode && p.category === "freight" ? "text-muted line-through" : "text-ink"}`}>
                    {fmtAmount(p.amount)}
                  </div>
                </div>
              ))}
              <div className="flex justify-between items-center py-2 border-t border-line">
                <span className="text-[12px] text-muted">Total supplier cost</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {/* With a recorded shipping leg, the goods are what the record holds less that leg, so the rows add up */}
                  {fmtAmount(flow.shipping_cost != null ? flow.total_cost - flow.shipping_cost : flow.total_supplier_cost)}
                </span>
              </div>
              {/* R-400: shipping is its own leg of the recorded cost */}
              <div className="flex justify-between items-center py-2">
                <span className="text-[12px] text-muted">Shipping</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {fmtAmount(flow.shipping_cost ?? 0)}
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-[12px] text-muted">Total cost recorded</span>
                <span className="text-[13px] font-medium text-ink tabular-nums">
                  {fmtAmount(flow.total_cost)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* R-577: who gets paid what, from the server's ledger; where it cannot answer (offline, or
          not an admin), the profit split as this computer works it out. */}
      {flow.stage === "complete" && (
        <>
          <div className="hsep" />
          <DealPayoutsBox dealFlowId={flow.id} refreshKey={flow.updated_at} fallback={
            (flow.net_profit > 0 && (alloc.length > 0 || logiPay.amount > 0.005 || logiPay.pending)) ? (
              <div>
                <p className="text-[14px] font-medium text-ink mb-3">Profit split</p>
                <div className="flex flex-wrap gap-6">
                  <LogisticsPayCell pay={logiPay} big />
                  {alloc.map((item, i) => (
                    <div key={i} className="flex-1 min-w-[90px]">
                      <div className="text-[12px] text-muted truncate">{item.name}</div>
                      <div className="text-[18px] font-medium text-success-ink tabular-nums mt-0.5">
                        {fmtAmount(item.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null
          } />
        </>
      )}

      {/* Backlog date editor */}
      <div className="hsep" />
      <div>
        <p className="text-[14px] font-medium text-ink mb-2">Completed date</p>
        <div className="flex items-center gap-2 max-w-sm">
          <input
            type="date"
            value={editDate}
            onChange={(e) => setEditDate(e.target.value)}
            className="flex-1 border border-line-3 px-2.5 h-8 rounded-lg text-[12px] bg-transparent focus:outline-none focus:border-ink transition-colors duration-150"
          />
          <Button variant="ink" size="sm" onClick={handleSaveDate} disabled={dateSaving || editDate === initialDate}>
            {dateSaving ? "Saving..." : "Save date"}
          </Button>
        </div>
        <p className="ui-note mt-1.5">
          Change to backlog a sale into the correct month or week for analytics.
        </p>
      </div>

      {/* Actions */}
      <div className="hsep" />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleReopen} disabled={saving} icon={<RotateCcw size={14} />}>Reopen deal</Button>
        <Button size="sm" variant="danger" onClick={handleDelete} disabled={saving} icon={<Trash2 size={14} />} className="ml-auto">Delete</Button>
      </div>
    </div>
  );
}
