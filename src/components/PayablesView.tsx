import { useEffect, useState } from "react";
import { api, PayablesAging } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw } from "lucide-react";

// Age buckets (days the obligation has been owed). Colours calm → alarming.
const BUCKETS = [
  { key: "d0_30",    label: "≤ 30 days" },
  { key: "d31_60",   label: "31–60 days" },
  { key: "d61_90",   label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
] as const;

const bucketColor = (k: string) =>
  k === "d0_30" ? "#10B981" : k === "d31_60" ? "#F59E0B" : k === "d61_90" ? "#F97316" : "#EF4444";

export default function PayablesView() {
  const [data, setData] = useState<PayablesAging | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getPayablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading && !data) return <div className="p-8 text-muted text-[13px]">Loading payables…</div>;
  if (!data) return <div className="p-8 text-muted text-[13px]">Could not load payables.</div>;

  const num = (v: any) => (typeof v === "number" ? v : 0);

  return (
    <div className="p-6 space-y-5 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Payables</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {data.open_count} unpaid cost{data.open_count !== 1 ? "s" : ""} · what you owe suppliers, freight &amp; wires
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Age summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="bg-surface border border-line rounded-xl p-4 border-t-[3px]"
            style={{ borderTopColor: bucketColor(b.key) }}>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted">{b.label}</div>
            <div className="text-[19px] font-bold text-ink tabular-nums mt-1.5">{fmtAmount(num((data as any)[b.key]))}</div>
          </div>
        ))}
        <div className="bg-surface border border-line rounded-xl p-4 border-t-[3px] border-t-accent">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted">Total owed</div>
          <div className="text-[19px] font-bold text-accent tabular-nums mt-1.5">{fmtAmount(data.total)}</div>
        </div>
      </div>

      {/* Per-payee table */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-line text-[13px] font-semibold text-ink">By payee</div>
        {data.suppliers.length === 0 ? (
          <div className="p-8 text-center text-muted text-[13px]">Nothing outstanding to pay.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-muted border-b border-line">
                  <th className="text-left font-medium px-5 py-2.5">Payee</th>
                  {BUCKETS.map((b) => (
                    <th key={b.key} className="text-right font-medium px-3 py-2.5 whitespace-nowrap">{b.label}</th>
                  ))}
                  <th className="text-right font-medium px-5 py-2.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.suppliers.map((s, i) => (
                  <tr key={s.payee + i} className="border-b border-line-2 last:border-0 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-2.5 text-ink font-medium">
                      {s.payee || "(unnamed)"}
                      {s.oldest_days > 90 && (
                        <span className="ml-2 text-[9px] font-bold uppercase text-danger-ink bg-danger-bg px-1.5 py-0.5 rounded">
                          {s.oldest_days}d
                        </span>
                      )}
                    </td>
                    {BUCKETS.map((b) => (
                      <td key={b.key} className="text-right px-3 py-2.5 tabular-nums"
                        style={{ color: num((s as any)[b.key]) > 0 ? bucketColor(b.key) : "var(--c-faint)" }}>
                        {num((s as any)[b.key]) > 0 ? fmtAmount(num((s as any)[b.key])) : "—"}
                      </td>
                    ))}
                    <td className="text-right px-5 py-2.5 font-semibold text-ink tabular-nums">{fmtAmount(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
