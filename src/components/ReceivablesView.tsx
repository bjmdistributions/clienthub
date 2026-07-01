import { useEffect, useState } from "react";
import { api, ReceivablesAging, ARItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ArrowUpRight, CalendarClock, Inbox } from "lucide-react";

// Aging buckets, oldest-money on the right; a calm → alarming ramp.
const BUCKETS = [
  { key: "current",  label: "Current",   short: "Current", color: "var(--c-success)" },
  { key: "d1_30",    label: "1–30 days", short: "1–30d",   color: "#84CC16" },
  { key: "d31_60",   label: "31–60 days",short: "31–60d",  color: "var(--c-warning)" },
  { key: "d61_90",   label: "61–90 days",short: "61–90d",  color: "#F97316" },
  { key: "d90_plus", label: "90+ days",  short: "90+d",    color: "var(--c-danger)" },
] as const;

const num = (v: any) => (typeof v === "number" ? v : 0);
const bucketMeta = (key: string) => BUCKETS.find((b) => b.key === key);

// Drill into the deal-flow that produced an invoice: stash a search term the
// Deal Flow view reads on mount, then switch tabs. Matches how invoices deep-link.
function openDeal(searchTerm: string) {
  try { localStorage.setItem("dealflow_invoice_filter", searchTerm); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "deals" }));
}

// A single proportional aging bar — the aging read at a glance, not just numbers.
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

export default function ReceivablesView() {
  const [data, setData] = useState<ReceivablesAging | null>(null);
  const [ap, setAp] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"client" | "items">("client");

  const load = () => {
    setLoading(true);
    api.getReceivablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
    api.getPayablesAging().then((p) => setAp(p.summary.total)).catch(() => setAp(null));
  };
  useEffect(load, []);

  if (loading && !data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="h-7 w-40 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-24 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-16 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-64 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="bg-surface border border-line rounded-xl p-12 text-center">
          <div className="text-[13px] text-muted">Could not load receivables.</div>
          <button onClick={load} className="mt-3 text-[12px] text-accent hover:text-accent-hover">Try again</button>
        </div>
      </div>
    );
  }

  const s = data.summary;
  const net = ap !== null ? s.total - ap : null;

  return (
    <div className="p-6 space-y-5 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Receivables</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {s.open_count} open invoice{s.open_count !== 1 ? "s" : ""} · aged by due date
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Cash position — owed to you − you owe = net float */}
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="grid grid-cols-3 divide-x divide-line">
          <div className="p-4">
            <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">Owed to you</div>
            <div className="text-[22px] font-bold text-success-ink tabular-nums mt-1">{fmtAmount(s.total)}</div>
          </div>
          <div className="p-4">
            <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">You owe</div>
            <div className="text-[22px] font-bold text-danger-ink tabular-nums mt-1">{ap !== null ? fmtAmount(ap) : "—"}</div>
          </div>
          <div className="p-4">
            <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">Net float</div>
            <div className={`text-[22px] font-bold tabular-nums mt-1 ${net === null ? "text-faint" : net >= 0 ? "text-ink" : "text-danger-ink"}`}>
              {net !== null ? fmtAmount(net) : "—"}
            </div>
          </div>
        </div>
        {s.due_soon > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-line bg-success-bg/40 text-[12.5px]">
            <CalendarClock size={14} className="text-success-ink flex-shrink-0" />
            <span className="text-ink-2"><span className="font-bold text-success-ink tabular-nums">{fmtAmount(s.due_soon)}</span> lands in the next 7 days</span>
          </div>
        )}
      </div>

      {/* Aging — a single proportional bar + a legend that reads left to right */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[13px] font-semibold text-ink">Aging</span>
          <span className="text-[12px] text-muted tabular-nums">{fmtAmount(s.total)} total open</span>
        </div>
        <AgingBar row={s as any} />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-3 mt-4">
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
                <div className="text-[10.5px] text-faint tabular-nums">{pct}% of open</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Grouped / itemized segmented toggle */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
        {([["client", "By client"], ["items", `Open invoices${data.items.length ? ` · ${data.items.length}` : ""}`]] as [typeof view, string][]).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${view === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>

      {view === "client" ? <ByClient data={data} /> : <ItemsList items={data.items} />}
    </div>
  );
}

function ByClient({ data }: { data: ReceivablesAging }) {
  if (data.by_client.length === 0) {
    return <EmptyState label="No outstanding invoices." />;
  }
  return (
    <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
      {data.by_client.map((c) => (
        <div key={c.client_id} className="px-5 py-3.5 hover:bg-surface-2/50 transition-colors">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] font-semibold text-ink truncate">{c.client_name}</span>
              {c.oldest_days > 90 && (
                <span className="text-[9px] font-bold uppercase text-danger-ink bg-danger-bg px-1.5 py-0.5 rounded flex-shrink-0">{c.oldest_days}d overdue</span>
              )}
            </div>
            <span className="text-[15px] font-bold text-ink tabular-nums flex-shrink-0">{fmtAmount(c.total)}</span>
          </div>
          <AgingBar row={c as any} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {BUCKETS.filter((b) => num((c as any)[b.key]) > 0).map((b) => (
              <span key={b.key} className="text-[11px] tabular-nums" style={{ color: b.color }}>
                {b.short}: {fmtAmount(num((c as any)[b.key]))}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ItemsList({ items }: { items: ARItem[] }) {
  if (items.length === 0) {
    return <EmptyState label="No open receivables." />;
  }
  return (
    <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
      {items.map((it) => {
        const meta = bucketMeta(it.bucket);
        const overdue = it.days_overdue > 0;
        const canDrill = !!it.deal_flow_id;
        return (
          <div key={it.invoice_id}
            onClick={canDrill ? () => openDeal(it.invoice_number || it.client_name) : undefined}
            className={`flex items-center gap-3 px-5 py-3 transition-colors ${canDrill ? "cursor-pointer hover:bg-surface-2" : ""}`}>
            <span className="w-1.5 h-8 rounded-full flex-shrink-0" style={{ background: meta?.color || "var(--c-line-3)" }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-ink truncate">{it.client_name}</span>
                {canDrill && <ArrowUpRight size={12} className="text-faint flex-shrink-0" />}
              </div>
              <div className="text-[11px] text-muted truncate">
                {it.invoice_number ? `#${it.invoice_number}` : "Invoice"}
                <span className="text-faint"> · due {it.due_date}</span>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-[14px] font-bold text-ink tabular-nums">{fmtAmount(it.amount)}</div>
              <div className={`text-[10.5px] font-medium tabular-nums ${overdue ? "text-danger-ink" : "text-faint"}`}>
                {overdue ? `${it.days_overdue}d overdue` : "not yet due"}
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
