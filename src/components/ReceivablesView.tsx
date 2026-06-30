import { useEffect, useState } from "react";
import { api, ReceivablesAging } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw } from "lucide-react";

// Aging buckets, oldest-money on the right; colours go calm → alarming.
const BUCKETS = [
  { key: "current",  label: "Current" },
  { key: "d1_30",    label: "1–30 days" },
  { key: "d31_60",   label: "31–60 days" },
  { key: "d61_90",   label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
] as const;

const bucketColor = (k: string) =>
  k === "current" ? "#10B981" : k === "d1_30" ? "#84CC16" :
  k === "d31_60" ? "#F59E0B" : k === "d61_90" ? "#F97316" : "#EF4444";

export default function ReceivablesView() {
  const [data, setData] = useState<ReceivablesAging | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getReceivablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading && !data) return <div className="p-8 text-muted text-[13px]">Loading receivables…</div>;
  if (!data) return <div className="p-8 text-muted text-[13px]">Could not load receivables.</div>;

  const num = (v: any) => (typeof v === "number" ? v : 0);

  return (
    <div className="p-6 space-y-5 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Receivables</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {data.open_count} open invoice{data.open_count !== 1 ? "s" : ""} · aged by due date
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Aging summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {BUCKETS.map((b) => (
          <div key={b.key} className="bg-surface border border-line rounded-xl p-4 border-t-[3px]"
            style={{ borderTopColor: bucketColor(b.key) }}>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted">{b.label}</div>
            <div className="text-[19px] font-bold text-ink tabular-nums mt-1.5">{fmtAmount(num((data as any)[b.key]))}</div>
          </div>
        ))}
        <div className="bg-surface border border-line rounded-xl p-4 border-t-[3px] border-t-accent">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted">Total open</div>
          <div className="text-[19px] font-bold text-accent tabular-nums mt-1.5">{fmtAmount(data.total)}</div>
        </div>
      </div>

      {/* Per-client aging table */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-line text-[13px] font-semibold text-ink">By client</div>
        {data.clients.length === 0 ? (
          <div className="p-8 text-center text-muted text-[13px]">No outstanding invoices.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-muted border-b border-line">
                  <th className="text-left font-medium px-5 py-2.5">Client</th>
                  {BUCKETS.map((b) => (
                    <th key={b.key} className="text-right font-medium px-3 py-2.5 whitespace-nowrap">{b.label}</th>
                  ))}
                  <th className="text-right font-medium px-5 py-2.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.client_id} className="border-b border-line-2 last:border-0 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-2.5 text-ink font-medium">
                      {c.client_name}
                      {c.oldest_days > 90 && (
                        <span className="ml-2 text-[9px] font-bold uppercase text-danger-ink bg-danger-bg px-1.5 py-0.5 rounded">
                          {c.oldest_days}d
                        </span>
                      )}
                    </td>
                    {BUCKETS.map((b) => (
                      <td key={b.key} className="text-right px-3 py-2.5 tabular-nums"
                        style={{ color: num((c as any)[b.key]) > 0 ? bucketColor(b.key) : "var(--c-faint)" }}>
                        {num((c as any)[b.key]) > 0 ? fmtAmount(num((c as any)[b.key])) : "—"}
                      </td>
                    ))}
                    <td className="text-right px-5 py-2.5 font-semibold text-ink tabular-nums">{fmtAmount(c.total)}</td>
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
