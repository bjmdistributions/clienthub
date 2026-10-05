// R-447: true profit. Deal profit has shipping and bank fees taken off (that is "true net", the
// figure Analytics already shows), and here the running costs come off as well: rent, insurance,
// the car note, software and the like. Shipping that sits inside a deal's own costs is already in
// deal profit, so it is shown once as a note and never taken off again.
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtAmount, fmtCompactCurrency } from "../../lib/format";
import type { SpendingResponse } from "../../lib/billsApi";
import { monthLabels, monthTitle } from "../../lib/billsFormat";
import { Card, signed, useChartColors } from "./ui";

const tone = (n: number) => (n > 0.005 ? "text-success-ink" : n < -0.005 ? "text-danger-ink" : "text-ink");

export default function TrueProfitMode({ resp }: { resp: SpendingResponse }) {
  const { months, totals, shipping_in_deals } = resp.profit;
  const C = useChartColors();
  const chart = useMemo(() => {
    const labels = monthLabels(months.map((m) => m.month));
    return months.map((m, i) => ({ label: labels[i], value: m.true_profit }));
  }, [months]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Card title="From deal profit to true profit" sub="Each step takes one kind of cost off" className="xl:col-span-2">
          <div className="px-5 py-2">
            <Step label="Deal profit" hint="Profit on the deals closed in this period" value={fmtAmount(totals.profit)} />
            <Step label="Less shipping not on a deal" hint="Bank shipping that no deal has claimed" value={signed(-totals.shipping)} sub />
            <Step label="Less bank and wire fees" hint="Fees with no deal behind them" value={signed(-totals.fees)} sub />
            <Step label="True net" hint="The figure Analytics shows" value={signed(totals.true_net)} total cls={tone(totals.true_net)} />
            <Step label="Less running costs" hint="Bills and the other costs of running the business" value={signed(-totals.operating)} sub />
            <Step label="True profit" hint="What is left after everything" value={signed(totals.true_profit)} total big cls={tone(totals.true_profit)} />
          </div>
          <div className="px-5 py-3 border-t border-line-2 text-[11.5px] text-muted tabular-nums">
            Shipping already inside deal costs: {fmtAmount(shipping_in_deals)} (already in deal profit)
          </div>
        </Card>

        <Card title="True profit by month" sub="Green is a month in profit, red a month at a loss" className="xl:col-span-3">
          <div className="p-4 min-w-0">
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
                    <Bar dataKey="value" name="True profit" radius={[4, 4, 0, 0]} isAnimationActive={false}>
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
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead>
                <tr className="text-left text-muted border-b border-line-2">
                  <th className="font-medium px-5 py-2.5">Month</th>
                  <th className="font-medium px-3 py-2.5 text-right">Deal profit</th>
                  <th className="font-medium px-3 py-2.5 text-right">Shipping</th>
                  <th className="font-medium px-3 py-2.5 text-right">Bank fees</th>
                  <th className="font-medium px-3 py-2.5 text-right">True net</th>
                  <th className="font-medium px-3 py-2.5 text-right">Running costs</th>
                  <th className="font-medium px-5 py-2.5 text-right">True profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2 tabular-nums">
                {months.map((m) => (
                  <tr key={m.month}>
                    <td className="px-5 py-2.5 text-ink whitespace-nowrap">{monthTitle(m.month + "-01")}</td>
                    <td className="px-3 py-2.5 text-right text-ink-2">{signed(m.profit)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-2">{signed(-m.shipping)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-2">{signed(-m.fees)}</td>
                    <td className="px-3 py-2.5 text-right text-ink">{signed(m.true_net)}</td>
                    <td className="px-3 py-2.5 text-right text-ink-2">{signed(-m.operating)}</td>
                    <td className={`px-5 py-2.5 text-right font-semibold ${tone(m.true_profit)}`}>{signed(m.true_profit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-semibold tabular-nums">
                  <td className="px-5 py-2.5 text-ink">Total</td>
                  <td className="px-3 py-2.5 text-right text-ink">{signed(totals.profit)}</td>
                  <td className="px-3 py-2.5 text-right text-ink">{signed(-totals.shipping)}</td>
                  <td className="px-3 py-2.5 text-right text-ink">{signed(-totals.fees)}</td>
                  <td className="px-3 py-2.5 text-right text-ink">{signed(totals.true_net)}</td>
                  <td className="px-3 py-2.5 text-right text-ink">{signed(-totals.operating)}</td>
                  <td className={`px-5 py-2.5 text-right ${tone(totals.true_profit)}`}>{signed(totals.true_profit)}</td>
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
    <div className={`flex items-baseline justify-between gap-4 py-3 min-w-0 ${total ? "border-t border-line-2" : ""} ${sub ? "pl-3" : ""}`}>
      <div className="min-w-0">
        <div className={`${big ? "text-[14px] font-semibold" : total ? "text-[13px] font-semibold" : "text-[13px]"} text-ink`}>{label}</div>
        <div className="text-[11px] text-muted mt-0.5">{hint}</div>
      </div>
      <div className={`${big ? "text-[22px] font-bold" : total ? "text-[16px] font-bold" : "text-[14px] font-medium"} tabular-nums flex-shrink-0 ${sub ? "text-ink-2" : cls}`}>{value}</div>
    </div>
  );
}
