import { useEffect, useMemo, useState } from "react";
import { api, ArchiveItem } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, RotateCcw, Archive as ArchiveIcon } from "lucide-react";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Button, PageActions } from "./ui";

const KIND_LABEL: Record<ArchiveItem["kind"], string> = {
  invoice: "Invoice",
  deal: "Deal",
  deal_flow: "Deal flow",
};

function reasonPill(reason: ArchiveItem["reason"]) {
  return reason === "fell_through"
    ? <StatusPill tone="danger">Fell through</StatusPill>
    : <StatusPill tone="neutral">Deleted</StatusPill>;
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
  const [recovering, setRecovering] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false); // the "search your backups?" question, asked in the page

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

  const recover = async () => {
    setRecovering(true);
    try {
      const r = await api.recoverDeletedFromBackups();
      const n = r.deal_flows + r.invoices;
      toast(n === 0
        ? "No additional deleted records found in your backups."
        : `Recovered ${r.deal_flows} deal${r.deal_flows === 1 ? "" : "s"} and ${r.invoices} invoice${r.invoices === 1 ? "" : "s"} into the Archive`);
      load();
    } catch (e: any) { toast(String(e), "error"); }
    finally { setRecovering(false); setRecoverOpen(false); }
  };

  if (loading && items === null) {
    return (
      <div className="min-w-0">
        <div className="skeleton h-5 w-96 rounded-md mb-6" />
        <div className="skeleton h-7 w-80 rounded-lg mb-4" />
        <div className="skeleton h-72 rounded-xl" />
      </div>
    );
  }

  const kindCount = (k: KindFilter) => k === "all" ? all.length : all.filter((i) => i.kind === k).length;
  const chip = (on: boolean) =>
    `inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12.5px] font-medium whitespace-nowrap transition-colors duration-150 ${on ? "bg-ink text-surface" : "bg-surface-3 text-muted hover:text-ink"}`;

  return (
    <div className="min-w-0">
      <PageActions>
        <Button icon={<RotateCcw size={14} />} aria-expanded={recoverOpen} onClick={() => setRecoverOpen((o) => !o)}>Recover deleted from backups</Button>
        <Button icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={load}>Refresh</Button>
      </PageActions>

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="m-0 text-[14px] leading-5 text-muted">Deleted and fallen-through records. Restore anything, nothing here is destroyed.</p>
        <div className="text-[12px] text-muted">{all.length} {all.length === 1 ? "record" : "records"} you can restore</div>
      </div>

      <div className="hsep mt-5" />

      {recoverOpen && (
        <>
          <section className="py-5 px-1 animate-fade-up" aria-label="Recover deleted records from backups">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex-1 min-w-[280px] max-w-[720px]">
                <div className="text-[14px] font-medium text-ink">Search your daily backups for deleted records?</div>
                <p className="m-0 mt-1 text-[13px] leading-[19px] text-muted">
                  This looks for deals and invoices that were deleted before the archive existed, and restores any it finds into this Archive. It only adds archived records. It never changes or deletes anything you currently have.
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setRecoverOpen(false)} disabled={recovering}>Cancel</Button>
                <Button variant="ink" onClick={recover} disabled={recovering}
                  icon={recovering ? <RefreshCw size={14} className="animate-spin" /> : undefined}>Search backups</Button>
              </div>
            </div>
          </section>
          <div className="hsep" />
        </>
      )}

      {/* Filters: by kind, then by reason */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-1 pt-5 pb-4">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          {([["all", "All"], ["invoice", "Invoices"], ["deal", "Deals"], ["deal_flow", "Deal flows"]] as [KindFilter, string][]).map(([k, label]) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={chip(kind === k)}>
              {label}{kindCount(k) > 0 && <span className="opacity-65">{kindCount(k)}</span>}
            </button>
          ))}
        </div>
        <div className="vsep" style={{ height: 20 }} />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by reason">
          {([["all", "Any reason"], ["deleted", "Deleted"], ["fell_through", "Fell through"]] as [ReasonFilter, string][]).map(([r, label]) => (
            <button key={r} aria-pressed={reason === r} onClick={() => setReason(r)} className={chip(reason === r)}>{label}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-20 flex flex-col items-center text-center animate-fade-up">
          <ArchiveIcon size={20} className="text-faint" />
          <div className="mt-2.5 text-[14px] text-muted">
            {all.length === 0 ? "Nothing archived. Deleted items will appear here." : "Nothing matches these filters."}
          </div>
        </div>
      ) : (
        <table className="ui-table" aria-label="Archived records">
          <thead>
            <tr>
              <th>Record</th>
              <th style={{ width: 96 }}>Kind</th>
              <th style={{ width: 116 }}>Reason</th>
              <th className="r" style={{ width: 112 }}>Amount</th>
              <th className="r" style={{ width: 120 }}>Put it back</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((it) => {
              const key = `${it.kind}:${it.id}`;
              return (
                <tr key={key} style={{ opacity: restoring === key ? 0.55 : 1, transition: "opacity 150ms var(--ease)" }}>
                  <td style={{ maxWidth: 0 }}>
                    <div className="truncate font-medium text-ink">{it.title || "(untitled)"}</div>
                    <div className="truncate mt-0.5 text-[12px] text-muted">
                      {it.client_name || "No client"}{it.archived_at && <>, archived {whenWords(it.archived_at)}</>}
                    </div>
                  </td>
                  <td><StatusPill tone="neutral">{KIND_LABEL[it.kind]}</StatusPill></td>
                  <td>{reasonPill(it.reason)}</td>
                  <td className="r font-medium text-ink">{fmtAmount(it.amount)}</td>
                  <td className="r">
                    <Button variant="ink" size="sm" className="min-w-[92px] justify-center" disabled={restoring === key} onClick={() => restore(it)}
                      icon={restoring === key ? <RefreshCw size={12} className="animate-spin" /> : <RotateCcw size={12} />}>
                      Restore
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
