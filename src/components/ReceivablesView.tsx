import { useEffect, useState } from "react";
import { api, ReceivablesAging, ARItem, Client, PaymentMethod } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ArrowUpRight, CalendarClock, Inbox, X, Check } from "lucide-react";

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

// "34 days overdue" / "due in 3 days" — dates in words a broker acts on.
function dueWords(it: ARItem): { text: string; overdue: boolean } {
  if (it.days_overdue > 0) return { text: `${it.days_overdue} day${it.days_overdue !== 1 ? "s" : ""} overdue`, overdue: true };
  const due = new Date(it.due_date.slice(0, 10) + "T00:00:00").getTime();
  const today = new Date(new Date().toDateString()).getTime();
  const days = Math.round((due - today) / 86400000);
  if (days <= 0) return { text: "due today", overdue: false };
  if (days === 1) return { text: "due tomorrow", overdue: false };
  return { text: `due in ${days} days`, overdue: false };
}

function lastContactWords(iso: string | null | undefined): string {
  if (!iso) return "no contact logged";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (isNaN(days)) return "no contact logged";
  if (days <= 0) return "contacted today";
  if (days === 1) return "contacted yesterday";
  return `last contact ${days}d ago`;
}

// Chase priority: big money that's been overdue longest floats to the top;
// not-yet-due invoices follow, soonest due first.
function chaseSort(items: ARItem[]): ARItem[] {
  const overdue = items.filter((i) => i.days_overdue > 0)
    .sort((a, b) => b.amount * (1 + b.days_overdue / 30) - a.amount * (1 + a.days_overdue / 30));
  const upcoming = items.filter((i) => i.days_overdue <= 0)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  return [...overdue, ...upcoming];
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

// Record a payment against an invoice — same flow the Invoices view uses.
function RecordPaymentModal({ item, onClose, onSaved }: { item: ARItem; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inp = "border border-line px-3 h-10 rounded-lg text-[14px] w-full focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

  useEffect(() => {
    api.listPaymentMethods().then((m) => setMethods(m.filter((p) => p.active))).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.markInvoicePaid(item.invoice_id, date, method || undefined, reference || undefined);
      onSaved();
    } catch (e: any) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/25 backdrop-blur-[3px]" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-xl w-[420px] max-w-[94vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-2">
          <div>
            <h3 className="text-[14px] font-semibold text-ink">Record payment</h3>
            <p className="text-[11.5px] text-muted mt-0.5">
              {item.client_name} · {item.invoice_number ? `#${item.invoice_number}` : "invoice"} · {fmtAmount(item.amount)}
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink-2 p-1 rounded-lg hover:bg-surface-3 transition-colors"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3.5">
          <div>
            <label className="block text-[11px] font-medium text-muted mb-1.5">Date received</label>
            <input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted mb-1.5">Method</label>
            <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">— select —</option>
              {methods.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted mb-1.5">Reference (optional)</label>
            <input className={inp} placeholder="e.g. wire confirmation #" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          {err && <div className="text-[12px] text-danger-ink">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-4 h-9 text-[13px] text-muted border border-line rounded-lg hover:bg-surface-2 transition-colors">Cancel</button>
            <button onClick={save} disabled={busy}
              className="bg-accent hover:bg-accent-hover text-on-accent px-5 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors flex items-center gap-1.5">
              {busy ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} {busy ? "Saving…" : "Record payment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ReceivablesView() {
  const [data, setData] = useState<ReceivablesAging | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"chase" | "client">("chase");
  const [paying, setPaying] = useState<ARItem | null>(null);

  const load = () => {
    setLoading(true);
    api.getReceivablesAging().then(setData).catch(() => setData(null)).finally(() => setLoading(false));
    api.listClients().then(setClients).catch(() => {});
  };
  useEffect(load, []);

  if (loading && !data) {
    return (
      <div className="p-6 max-w-[1100px]">
        <div className="h-7 w-40 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-14 bg-surface-2 rounded-xl animate-pulse mb-4" />
        <div className="h-72 bg-surface-2 rounded-xl animate-pulse" />
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
  const lastContact = (clientId: string) => clients.find((c) => c.id === clientId)?.last_contact_at;

  return (
    <div className="p-6 space-y-4 max-w-[1100px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Owed to you</h2>
          <p className="text-[12px] text-muted mt-0.5">
            <span className="font-semibold text-ink tabular-nums">{fmtAmount(s.total)}</span> across {s.open_count} open invoice{s.open_count !== 1 ? "s" : ""} · most urgent first
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Compact aging strip — the shape of the debt at a glance. */}
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
            {s.due_soon > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-success-ink ml-auto">
                <CalendarClock size={12} /> {fmtAmount(s.due_soon)} lands in the next 7 days
              </span>
            )}
          </div>
        </div>
      )}

      {/* Chase list / grouped toggle */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
        {([["chase", `Chase list${data.items.length ? ` · ${data.items.length}` : ""}`], ["client", "By client"]] as [typeof view, string][]).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${view === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>

      {view === "chase"
        ? <ChaseList items={chaseSort(data.items)} lastContact={lastContact} onRecord={setPaying} />
        : <ByClient data={data} />}

      {paying && (
        <RecordPaymentModal
          item={paying}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); load(); }}
        />
      )}
    </div>
  );
}

function ChaseList({ items, lastContact, onRecord }: {
  items: ARItem[];
  lastContact: (clientId: string) => string | null | undefined;
  onRecord: (it: ARItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState label="Nothing owed to you right now — all invoices are paid." />;
  }
  return (
    <div className="bg-surface border border-line rounded-xl divide-y divide-line-2 overflow-hidden">
      {items.map((it) => {
        const meta = bucketMeta(it.bucket);
        const due = dueWords(it);
        const canDrill = !!it.deal_flow_id;
        return (
          <div key={it.invoice_id} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/40 transition-colors">
            <span className="w-1.5 h-9 rounded-full flex-shrink-0" style={{ background: meta?.color || "var(--c-line-3)" }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-ink truncate">{it.client_name}</span>
                <span className={`text-[10.5px] font-semibold tabular-nums px-1.5 py-0.5 rounded flex-shrink-0 ${due.overdue ? "text-danger-ink bg-danger-bg" : "text-muted bg-surface-2"}`}>
                  {due.text}
                </span>
              </div>
              <div className="text-[11px] text-muted truncate mt-0.5">
                {it.invoice_number ? `#${it.invoice_number}` : "Invoice"}
                <span className="text-faint"> · due {it.due_date.slice(0, 10)} · {lastContactWords(lastContact(it.client_id))}</span>
              </div>
            </div>
            <span className="text-[14px] font-bold text-ink tabular-nums flex-shrink-0">{fmtAmount(it.amount)}</span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button onClick={() => onRecord(it)}
                className="bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors">
                Record payment
              </button>
              {canDrill && (
                <button onClick={() => openDeal(it.invoice_number || it.client_name)}
                  className="border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-7 rounded-lg text-[11.5px] font-medium transition-colors inline-flex items-center gap-1">
                  View deal <ArrowUpRight size={11} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ByClient({ data }: { data: ReceivablesAging }) {
  if (data.by_client.length === 0) {
    return <EmptyState label="Nothing owed to you right now — all invoices are paid." />;
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
