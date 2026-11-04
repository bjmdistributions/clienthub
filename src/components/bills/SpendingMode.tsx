// R-446: where the money went. Bills against everything else the business spent on running
// itself, by month, by category and by payee, with a plain-language list of what changed.
// "Not booked yet" is money that left the bank with no category and no bill behind it, so the
// total can be read as "at least this much": the button takes you to Financials to book it.
import { useMemo, useState } from "react";
import { Info, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { catLabel } from "../FinancialsView";
import { fmtAmount, fmtCompactCurrency } from "../../lib/format";
import type { BillOut, SpendInsight, SpendingResponse } from "../../lib/billsApi";
import { monthLabels, pctChange } from "../../lib/billsFormat";
import { BillLogo, Card, Tile, btn, useChartColors } from "./ui";

const INSIGHT: Record<SpendInsight["kind"], { icon: React.ReactNode; cls: string }> = {
  up: { icon: <TrendingUp size={16} />, cls: "text-warning-ink" },
  down: { icon: <TrendingDown size={16} />, cls: "text-success-ink" },
  new: { icon: <Plus size={16} />, cls: "text-ink" },
  info: { icon: <Info size={16} />, cls: "text-muted" },
};

const goFinancials = () => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }));

export default function SpendingMode({ resp, bills }: { resp: SpendingResponse; bills: BillOut[] }) {
  const r = resp.report;
  const C = useChartColors();
  const [allCats, setAllCats] = useState(false);
  const byId = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  const change = pctChange(r.total, r.prev_total);
  const share = (n: number) => (r.total > 0.005 ? `${Math.round((n / r.total) * 100)}% of the total` : "Nothing out yet");

  const chart = useMemo(() => {
    const labels = monthLabels(r.months.map((m) => m.month));
    return r.months.map((m, i) => ({ label: labels[i], Bills: m.fixed, "Everything else": m.other }));
  }, [r.months]);

  const cats = useMemo(() => [...r.by_category].sort((a, b) => b.amount - a.amount), [r.by_category]);
  const catMax = cats.reduce((m, c) => Math.max(m, c.amount), 0);
  const payees = r.by_payee.slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
        <Tile label="Total out" value={fmtAmount(r.total)}
          sub={change == null ? (r.total > 0 ? "Nothing in the period before" : "Nothing out yet")
            : `${change >= 0 ? "Up" : "Down"} ${Math.abs(Math.round(change))}% from the period before`} />
        <div className="vsep hidden xl:block" />
        <Tile label="Bills" value={fmtAmount(r.fixed)} sub={share(r.fixed)} />
        <div className="vsep hidden xl:block" />
        <Tile label="Everything else" value={fmtAmount(r.other)} sub={share(r.other)} />
        <div className="vsep hidden xl:block" />
        <Tile label="Not booked yet" value={fmtAmount(resp.unbooked.amount)}
          sub={`${resp.unbooked.count} payment${resp.unbooked.count === 1 ? "" : "s"} with no category`}
          valueCls={resp.unbooked.count > 0 ? "text-warning-ink" : "text-ink"}
          action={resp.unbooked.count > 0 ? <button onClick={goFinancials} className={btn}>Book them in Financials</button> : undefined} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Month by month" sub="Bills and everything else, the last 12 months" className="xl:col-span-2"
          right={
            <div className="flex items-center gap-4 text-[12px] text-muted">
              <span style={{ color: C.bills }}>Bills</span>
              <span style={{ color: C.other }}>Everything else</span>
            </div>
          }>
          <div className="min-w-0">
            {chart.every((m) => m.Bills + m["Everything else"] < 0.005) ? (
              <div className="h-[260px] flex items-center justify-center text-[13px] text-muted">Nothing went out in these months.</div>
            ) : (
              <div className="h-[260px] min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" tick={C.axis} axisLine={false} tickLine={false} />
                    <YAxis tick={C.axis} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => fmtCompactCurrency(Number(v))} />
                    <Tooltip {...C.tip} formatter={(v) => fmtAmount(Number(v))} />
                    <Bar dataKey="Bills" stackId="s" fill={C.bills} animationDuration={800} />
                    <Bar dataKey="Everything else" stackId="s" fill={C.other} radius={[4, 4, 0, 0]} animationDuration={800} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>

        <Card title="What changed" sub="Against the period before">
          {r.insights.length === 0 ? (
            <div className="py-8 text-[13px] text-muted text-center">Nothing stands out this period.</div>
          ) : (
            <div>
              {r.insights.map((i, n) => (
                <div key={n} className="flex items-start gap-3 py-3 border-t border-line">
                  <span className={`flex-shrink-0 mt-0.5 ${INSIGHT[i.kind].cls}`}>{INSIGHT[i.kind].icon}</span>
                  <span className="text-[14px] text-ink-2 leading-snug">{i.text}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="By category" sub="Largest first, with what the period before came to">
          {cats.length === 0 ? (
            <div className="py-8 text-[13px] text-muted text-center">No spending in this period.</div>
          ) : (
            <div>
              {(allCats ? cats : cats.slice(0, 10)).map((c) => (
                <div key={c.category || "none"} className="py-2.5 min-w-0 border-t border-line">
                  <div className="flex items-baseline justify-between gap-3 min-w-0">
                    <span className="text-[14px] text-ink truncate">{c.label || (c.category ? catLabel(c.category) : "No category")}</span>
                    <span className="text-[14px] font-medium text-ink tabular-nums flex-shrink-0">{fmtAmount(c.amount)}</span>
                  </div>
                  <div className="h-1.5 bg-surface-3 rounded-full mt-1.5 overflow-hidden">
                    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${catMax > 0 ? Math.max(2, (c.amount / catMax) * 100) : 0}%`, background: C.bills }} />
                  </div>
                  <div className="ui-note mt-1 tabular-nums truncate">
                    {c.count} payment{c.count === 1 ? "" : "s"}, {c.prev_amount > 0.005 ? `${fmtAmount(c.prev_amount)} the period before` : "nothing the period before"}
                  </div>
                </div>
              ))}
              {cats.length > 10 && (
                <button onClick={() => setAllCats((v) => !v)} className="ui-link border-t border-line w-full pt-3 pb-1">
                  {allCats ? "Show fewer" : `Show ${cats.length - 10} more`}
                </button>
              )}
            </div>
          )}
        </Card>

        <Card title="Top payees" sub="Who the money went to">
          {payees.length === 0 ? (
            <div className="px-5 py-8 text-[13px] text-muted text-center">No spending in this period.</div>
          ) : (
            <div>
              {payees.map((p) => {
                const bill = p.bill_id ? byId.get(p.bill_id) : undefined;
                const name = bill?.name || p.payee || "Unnamed payee";
                return (
                  <div key={(p.bill_id || "") + p.payee} className="flex items-center gap-3 py-2.5 min-w-0 border-t border-line">
                    <BillLogo name={name} logo={bill?.logo} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] text-ink truncate">{name}</div>
                      <div className="ui-note">{p.count} payment{p.count === 1 ? "" : "s"}{bill ? ", a bill" : ""}</div>
                    </div>
                    <span className="text-[14px] font-medium text-ink tabular-nums flex-shrink-0">{fmtAmount(p.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
