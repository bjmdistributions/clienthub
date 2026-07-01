import { useEffect, useState } from "react";
import { api, PayablesAging, APItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ArrowUpRight, Inbox } from "lucide-react";

// Age buckets (days the obligation has been owed). Calm → alarming ramp.
const BUCKETS = [
  { key: "d0_30",    label: "≤ 30 days", short: "≤30d",   color: "var(--c-success)" },
  { key: "d31_60",   label: "31–60 days",short: "31–60d", color: "var(--c-warning)" },
  { key: "d61_90",   label: "61–90 days",short: "61–90d", color: "#F97316" },
  { key: "d90_plus", label: "90+ days",  short: "90+d",   color: "var(--c-danger)" },
] as const;

const num = (v: any) => (typeof v === "number" ? v : 0);
const bucketMeta = (key: string) => BUCKETS.find((b) => b.key === key);

function openDeal(searchTerm: string) {
  try { localStorage.setItem("dealflow_invoice_filter", searchTerm); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "deals" }));
}

function AgingBar({ row }: { row: Record<string, number> }) {
  const total = BUCKETS.reduce((s, b) => s + num(row[b.key]), 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-surface-2">
      {BUCKETS.map((b) => {
        const v = num(row[b.key]);
        if (v <= 0) return null;
        return (
          <div key={b.key} title={`${b.label}: ${fmtAmount(v)}`}
            style={{ width: `${(v / total) * 100}%`, background: b.color }} />
        );
      })}
    </div>
  );
}

export default function PayablesView() {
  const [data, setData] = useState<PayablesAging | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"payee" | "items">("payee");

  const load = () => {
    setLoading(true);
    api.getPayablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading && !data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="h-7 w-36 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-16 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-64 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="bg-surface border border-line rounded-xl p-12 text-center">
          <div className="text-[13px] text-muted">Could not load payables.</div>
          <button onClick={load} className="mt-3 text-[12px] text-accent hover:text-accent-hover">Try again</button>
        </div>
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="p-6 space-y-5 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Payables</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {s.open_count} unpaid cost{s.open_count !== 1 ? "s" : ""} · owed to suppliers, freight &amp; wires
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Total owed + aging bar */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-end justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">Total owed</div>
            <div className="text-[24px] font-bold text-danger-ink tabular-nums mt-0.5">{fmtAmount(s.total)}</div>
          </div>
          <div className="text-[12px] text-muted tabular-nums pb-1">{s.open_count} open</div>
        </div>
        <AgingBar row={s as any} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mt-4">
          {BUCKETS.map((b) => {
            const v = num((s as any)[b.key]);
            const pct = s.total > 0 ? Math.round((v / s.total) * 100) : 0;
            return (
              <div key={b.key}>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color }} />
                  <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted">{b.label}</span>
                </div>
                <div className="text-[15px] font-bold text-ink tabular-nums mt-1">{fmtAmount(v)}</div>
                <div className="text-[10.5px] text-faint tabular-nums">{pct}% of owed</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Grouped / itemized segmented toggle */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
        {([["payee", "By payee"], ["items", `Open costs${data.items.length ? ` · ${data.items.length}` : ""}`]] as [typeof view, string][]).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${view === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>

      {view === "payee" ? <ByPayee data={data} /> : <ItemsList items={data.items} />}
    </div>
  );
}

function ByPayee({ data }: { data: PayablesAging }) {
  if (data.by_payee.length === 0) {
    return <EmptyState label="Nothing outstanding to pay." />;
  }
  return (
    <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
      {data.by_payee.map((p, i) => (
        <div key={p.payee + i} className="px-5 py-3.5 hover:bg-surface-2/50 transition-colors">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] font-semibold text-ink truncate">{p.payee || "(unnamed)"}</span>
              {p.oldest_days > 90 && (
                <span className="text-[9px] font-bold uppercase text-danger-ink bg-danger-bg px-1.5 py-0.5 rounded flex-shrink-0">{p.oldest_days}d</span>
              )}
            </div>
            <span className="text-[15px] font-bold text-ink tabular-nums flex-shrink-0">{fmtAmount(p.total)}</span>
          </div>
          <AgingBar row={p as any} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {BUCKETS.filter((b) => num((p as any)[b.key]) > 0).map((b) => (
              <span key={b.key} className="text-[11px] tabular-nums" style={{ color: b.color }}>
                {b.short}: {fmtAmount(num((p as any)[b.key]))}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ItemsList({ items }: { items: APItem[] }) {
  if (items.length === 0) {
    return <EmptyState label="No open payables." />;
  }
  return (
    <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
      {items.map((it, i) => {
        const meta = bucketMeta(it.bucket);
        const drillTerm = it.invoice_number || it.client_name || "";
        const canDrill = !!it.deal_flow_id && !!drillTerm;
        // Which customer/deal is this supplier cost for — the key AP insight.
        const dealLabel = it.client_name
          ? (it.invoice_number ? `${it.client_name} · #${it.invoice_number}` : it.client_name)
          : (it.invoice_number ? `#${it.invoice_number}` : "Unlinked cost");
        return (
          <div key={it.deal_flow_id + "-" + i}
            onClick={canDrill ? () => openDeal(drillTerm) : undefined}
            className={`flex items-center gap-3 px-5 py-3 transition-colors ${canDrill ? "cursor-pointer hover:bg-surface-2" : ""}`}>
            <span className="w-1.5 h-8 rounded-full flex-shrink-0" style={{ background: meta?.color || "var(--c-line-3)" }} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink truncate">{it.payee || "(unnamed)"}</div>
              <div className="flex items-center gap-1 text-[11px] text-muted truncate">
                <span className="truncate">for {dealLabel}</span>
                {canDrill && <ArrowUpRight size={12} className="text-faint flex-shrink-0" />}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-[14px] font-bold text-ink tabular-nums">{fmtAmount(it.amount)}</div>
              <div className={`text-[10.5px] font-medium tabular-nums ${it.days > 90 ? "text-danger-ink" : "text-faint"}`}>
                {it.days}d owed
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="bg-surface border border-line rounded-xl py-14 flex flex-col items-center">
      <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
        <Inbox size={18} />
      </div>
      <div className="text-[13px] text-muted">{label}</div>
    </div>
  );
}
