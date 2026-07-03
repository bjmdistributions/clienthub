import { useEffect, useMemo, useState } from "react";
import { api, ArchiveItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, RotateCcw, Archive as ArchiveIcon, FileText, GitBranch, Briefcase } from "lucide-react";
import { toast } from "./Toast";

const KIND_META: Record<ArchiveItem["kind"], { label: string; icon: typeof FileText }> = {
  invoice:   { label: "Invoice",   icon: FileText },
  deal:      { label: "Deal",      icon: Briefcase },
  deal_flow: { label: "Deal flow", icon: GitBranch },
};

function reasonPill(reason: ArchiveItem["reason"]) {
  return reason === "fell_through"
    ? <span className="text-[10px] font-semibold uppercase tracking-wide text-warning-ink bg-warning-bg border border-warning/30 px-1.5 py-0.5 rounded">Fell through</span>
    : <span className="text-[10px] font-semibold uppercase tracking-wide text-muted bg-surface-2 border border-line px-1.5 py-0.5 rounded">Deleted</span>;
}

function whenWords(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

type KindFilter = "all" | ArchiveItem["kind"];
type ReasonFilter = "all" | ArchiveItem["reason"];

export default function ArchiveView() {
  const [items, setItems] = useState<ArchiveItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<KindFilter>("all");
  const [reason, setReason] = useState<ReasonFilter>("all");
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listArchive().then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const all = items ?? [];
  const filtered = useMemo(() => all.filter((it) =>
    (kind === "all" || it.kind === kind) && (reason === "all" || it.reason === reason)
  ), [all, kind, reason]);

  const restore = async (it: ArchiveItem) => {
    const key = `${it.kind}:${it.id}`;
    setRestoring(key);
    try { await api.restoreArchived(it.kind, it.id); toast("Restored"); load(); }
    catch (e: any) { toast(String(e), "error"); }
    finally { setRestoring(null); }
  };

  if (loading && items === null) {
    return (
      <div className="p-6 max-w-[1000px]">
        <div className="h-7 w-32 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-9 w-64 bg-surface-2 rounded-lg animate-pulse mb-4" />
        <div className="h-72 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }

  const kindCount = (k: KindFilter) => k === "all" ? all.length : all.filter((i) => i.kind === k).length;

  return (
    <div className="p-6 space-y-4 max-w-[1000px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-ink">Archive</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Deleted and fallen-through records — restore anything, nothing is destroyed.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Filters — by kind + by reason */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
          {([["all", "All"], ["invoice", "Invoices"], ["deal", "Deals"], ["deal_flow", "Deal flows"]] as [KindFilter, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`px-3 h-8 rounded-md text-[12.5px] font-medium transition-colors ${kind === k ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
              {label}{kindCount(k) > 0 ? ` · ${kindCount(k)}` : ""}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit">
          {([["all", "Any reason"], ["deleted", "Deleted"], ["fell_through", "Fell through"]] as [ReasonFilter, string][]).map(([r, label]) => (
            <button key={r} onClick={() => setReason(r)}
              className={`px-3 h-8 rounded-md text-[12.5px] font-medium transition-colors ${reason === r ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl py-16 flex flex-col items-center">
          <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-faint mb-3">
            <ArchiveIcon size={18} />
          </div>
          <div className="text-[13px] text-muted">
            {all.length === 0 ? "Nothing archived — deleted items will appear here." : "Nothing matches these filters."}
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-line-2 rounded-xl divide-y divide-line-2 overflow-hidden">
          {filtered.map((it, i) => {
            const meta = KIND_META[it.kind];
            const Icon = meta.icon;
            const key = `${it.kind}:${it.id}`;
            return (
              <div key={key} className={`flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2 ${i % 2 === 1 ? "bg-surface-2/40" : ""}`}>
                <span className="w-8 h-8 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center flex-shrink-0"><Icon size={14} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink truncate">{it.title || "(untitled)"}</span>
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted bg-surface-2 border border-line px-1.5 py-0.5 rounded flex-shrink-0">{meta.label}</span>
                  </div>
                  <div className="text-[11px] text-muted truncate mt-0.5">
                    {it.client_name || "—"}{it.archived_at && <span className="text-faint"> · archived {whenWords(it.archived_at)}</span>}
                  </div>
                </div>
                {reasonPill(it.reason)}
                <span className="text-[13px] font-bold text-ink tabular-nums flex-shrink-0 w-24 text-right">{fmtAmount(it.amount)}</span>
                <button onClick={() => restore(it)} disabled={restoring === key}
                  className="border border-line text-ink-2 hover:bg-surface-2 px-2.5 h-7 rounded-lg text-[11.5px] font-medium disabled:opacity-50 transition-colors inline-flex items-center gap-1 flex-shrink-0">
                  {restoring === key ? <RefreshCw size={11} className="animate-spin" /> : <RotateCcw size={11} />} Restore
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
