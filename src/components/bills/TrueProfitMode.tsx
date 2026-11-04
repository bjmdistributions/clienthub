// R-447: true profit. Deal profit has shipping and bank fees taken off (that is "true net", the
// figure Analytics already shows), and here the running costs come off as well: rent, insurance,
// the car note, software and the like. Shipping that sits inside a deal's own costs is already in
// deal profit, so it is shown once as a note and never taken off again.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtAmount, fmtCompactCurrency } from "../../lib/format";
import type { ProfitBlock } from "../../lib/billsApi";
import { monthLabels, monthTitle } from "../../lib/billsFormat";
import { Card, signed, useChartColors } from "./ui";

const tone = (n: number) => (n > 0.005 ? "text-success-ink" : n < -0.005 ? "text-danger-ink" : "text-ink");

export default function TrueProfitMode({ profit }: { profit: ProfitBlock }) {
  const { months, totals, shipping_in_deals } = profit;
  const C = useChartColors();
  const chart = useMemo(() => {
    const labels = monthLabels(months.map((m) => m.month));
    return months.map((m, i) => ({ label: labels[i], value: m.true_profit }));
  }, [months]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_1px_minmax(0,3fr)] gap-x-8 gap-y-4">
        <Card title="From deal profit to true profit" sub="Each step takes one kind of cost off">
          <div>
            <Step label="Deal profit" hint="Profit on the deals closed in this period" value={fmtAmount(totals.profit)} />
            <Step label="Less shipping not on a deal" hint="Bank shipping that no deal has claimed" value={signed(-totals.shipping)} sub />
            <Step label="Less bank and wire fees" hint="Fees with no deal behind them" value={signed(-totals.fees)} sub />
            <Step label="True net" hint="The figure Analytics shows" value={signed(totals.true_net)} total cls={tone(totals.true_net)} />
            <Step label="Less running costs" hint="Bills and the other costs of running the business" value={signed(-totals.operating)} sub />
            <Step label="True profit" hint="What is left after everything" value={signed(totals.true_profit)} total big cls={tone(totals.true_profit)} />
          </div>
          <div className="py-3 border-t border-line ui-note tabular-nums">
            Shipping already inside deal costs: {fmtAmount(shipping_in_deals)} (already in deal profit)
          </div>
        </Card>
        <div className="vsep hidden xl:block" />

        <Card title="True profit by month" sub="Green is a month in profit, red a month at a loss">
          <div className="min-w-0">
            {chart.length === 0 ? (
              <div className="h-[280px] flex items-center justify-center text-[13px] text-muted">No closed deals or running costs in this period.</div>
            ) : (
              <div className="h-[280px] min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" tick={C.axis} axisLine={false} tickLine={false} />
                    <YAxis tick={C.axis} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => fmtCompactCurrency(Number(v))} />
                    <Tooltip {...C.tip} formatter={(v) => signed(Number(v))} />
                    <ReferenceLine y={0} stroke={C.grid} />
                    <Bar dataKey="value" name="True profit" radius={[4, 4, 0, 0]} animationDuration={800}>
                      {chart.map((m, i) => <Cell key={i} fill={m.value >= 0 ? C.profit : C.loss} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>
      </div>

      {months.length > 0 && (
        <Card title="Month by month" sub="The same steps for each month">
          <div className="overflow-x-auto">
            <table className="ui-table ui-table-sm min-w-[720px]">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="r">Deal profit</th>
                  <th className="r">Shipping</th>
                  <th className="r">Bank fees</th>
                  <th className="r">True net</th>
                  <th className="r">Running costs</th>
                  <th className="r">True profit</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <td className="text-ink whitespace-nowrap">{monthTitle(m.month + "-01")}</td>
                    <td className="r text-ink-2">{signed(m.profit)}</td>
                    <td className="r text-ink-2">{signed(-m.shipping)}</td>
                    <td className="r text-ink-2">{signed(-m.fees)}</td>
                    <td className="r text-ink">{signed(m.true_net)}</td>
                    <td className="r text-ink-2">{signed(-m.operating)}</td>
                    <td className={`r font-medium ${tone(m.true_profit)}`}>{signed(m.true_profit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium tabular-nums">
                  <td className="text-ink border-t border-line">Total</td>
                  <td className="r text-ink border-t border-line">{signed(totals.profit)}</td>
                  <td className="r text-ink border-t border-line">{signed(-totals.shipping)}</td>
                  <td className="r text-ink border-t border-line">{signed(-totals.fees)}</td>
                  <td className="r text-ink border-t border-line">{signed(totals.true_net)}</td>
                  <td className="r text-ink border-t border-line">{signed(-totals.operating)}</td>
                  <td className={`r border-t border-line ${tone(totals.true_profit)}`}>{signed(totals.true_profit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/** One line of the ladder. A subtotal ("total") gets a rule above it; the last one is larger. */
function Step({ label, hint, value, sub, total, big, cls = "text-ink" }: {
  label: string; hint: string; value: string; sub?: boolean; total?: boolean; big?: boolean; cls?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-3 min-w-0 ${total ? "border-t border-line" : ""} ${sub ? "pl-3" : ""}`}>
      <div className="min-w-0">
        <div className={`${big ? "text-[15px] font-medium" : total ? "text-[14px] font-medium" : "text-[14px]"} text-ink`}>{label}</div>
        <div className="ui-note mt-0.5">{hint}</div>
      </div>
      <div className={`${big ? "text-[24px] font-medium tracking-[-0.6px]" : total ? "text-[16px] font-medium" : "text-[14px] font-medium"} tabular-nums flex-shrink-0 ${sub ? "text-ink-2" : cls}`}>{value}</div>
    </div>
  );
}
