import { useEffect, useState } from "react";
import { api, PayablesAging, APItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ArrowUpRight, Inbox, Check } from "lucide-react";

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

// Pay priority: big money owed longest floats to the top.
function chaseSort(items: APItem[]): APItem[] {
  return [...items].sort(
    (a, b) => b.amount * (1 + Math.max(b.days, 0) / 30) - a.amount * (1 + Math.max(a.days, 0) / 30)
  );
}

function owedWords(days: number): string {
  if (days <= 0) return "new";
  if (days === 1) return "owed 1 day";
  return `owed ${days} days`;
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
  const [view, setView] = useState<"chase" | "payee">("chase");
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    api.getPayablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Mark one AP item paid: the aging item carries the deal-flow id but not the
  // supplier-payment id, so fetch the flow and match the unpaid line by payee +
  // amount. Ambiguous/missing matches fall back to opening the deal.
  const itemKey = (it: APItem, i: number) => `${it.deal_flow_id}-${it.payee}-${it.amount}-${i}`;
  const markPaid = async (it: APItem, key: string) => {
    if (!confirm(`Mark ${fmtAmount(it.amount)} to ${it.payee || "this payee"} as paid?`)) return;
    setPayingKey(key);
    setRowErr((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      const flow = await api.getDealFlow(it.deal_flow_id);
      const matches = (flow.supplier_payments || []).filter(
        (p) => !p.paid && (p.supplier_name || "") === (it.payee || "") && Math.abs(p.amount - it.amount) < 0.005
      );
      if (matches.length === 0) {
        setRowErr((e) => ({ ...e, [key]: "Couldn't match this cost on the deal — open the deal to mark it there." }));
      } else {
        await api.markSupplierPaymentPaid(flow.id, matches[0].id);
        load();
      }
    } catch (e: any) {
      setRowErr((er) => ({ ...er, [key]: String(e) }));
    } finally {
      setPayingKey(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="h-7 w-36 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-14 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-72 bg-surface-2 rounded-xl animate-pulse" />
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
    <div className="p-6 space-y-4 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">You owe</h2>
          <p className="text-[12px] text-muted mt-0.5">
            <span className="font-semibold text-ink tabular-nums">{fmtAmount(s.total)}</span> across {s.open_count} unpaid cost{s.open_count !== 1 ? "s" : ""} · suppliers, freight &amp; wires
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Compact aging strip */}
      {s.total > 0 && (
        <div className="bg-surface border border-line rounded-xl px-4 py-3">
          <AgingBar row={s as any} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
            {BUCKETS.map((b) => {
              const v = num((s as any)[b.key]);
              if (v <= 0) return null;
              return (
                <span key={b.key} className="inline-flex items-center gap-1.5 text-[11px] tabular-nums text-muted">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color }} />
                  {b.short} <span className="font-semibold text-ink-2">{fmtAmount(v)}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Chase list / grouped toggle */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
        {([["chase", `Pay list${data.items.length ? ` · ${data.items.length}` : ""}`], ["payee", "By payee"]] as [typeof view, string][]).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${view === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>

      {view === "chase" ? (
        data.items.length === 0 ? (
          <EmptyState label="Nothing to pay right now — every cost is settled." />
        ) : (
          <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
            {chaseSort(data.items).map((it, i) => {
              const key = itemKey(it, i);
              const meta = bucketMeta(it.bucket);
              const drillTerm = it.invoice_number || it.client_name || "";
              const canDrill = !!it.deal_flow_id && !!drillTerm;
              // Which customer/deal is this supplier cost for — the key AP insight.
              const dealLabel = it.client_name
                ? (it.invoice_number ? `${it.client_name} · #${it.invoice_number}` : it.client_name)
                : (it.invoice_number ? `#${it.invoice_number}` : "Unlinked cost");
              return (
                <div key={key} className="px-5 py-3 hover:bg-surface-2/40 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="w-1.5 h-9 rounded-full flex-shrink-0" style={{ background: meta?.color || "var(--c-line-3)" }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink truncate">{it.payee || "(unnamed)"}</span>
                        <span className={`text-[10.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded flex-shrink-0 ${it.days > 90 ? "text-danger-ink bg-danger-bg" : "text-muted bg-surface-2"}`}>
                          {owedWords(it.days)}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted truncate mt-0.5">for {dealLabel}</div>
                    </div>
                    <span className="text-[14px] font-bold text-ink tabular-nums flex-shrink-0">{fmtAmount(it.amount)}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => markPaid(it, key)} disabled={payingKey === key}
                        className="bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-lg text-[11.5px] font-medium disabled:opacity-50 transition-colors inline-flex items-center gap-1">
                        {payingKey === key ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Mark paid
                      </button>
                      {canDrill && (
                        <button onClick={() => openDeal(drillTerm)}
                          className="border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors inline-flex items-center gap-1">
                          View deal <ArrowUpRight size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                  {rowErr[key] && (
                    <div className="mt-1.5 ml-4 text-[11.5px] text-danger-ink">
                      {rowErr[key]}{canDrill && <button onClick={() => openDeal(drillTerm)} className="ml-1.5 text-accent hover:text-accent-hover font-medium">Open deal</button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <ByPayee data={data} />
      )}
    </div>
  );
}

function ByPayee({ data }: { data: PayablesAging }) {
  if (data.by_payee.length === 0) {
    return <EmptyState label="Nothing to pay right now — every cost is settled." />;
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
