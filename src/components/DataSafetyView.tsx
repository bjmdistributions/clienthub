import { useEffect, useState } from "react";
import { api, IntegrityItem, StrandedWrite } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ShieldAlert, ShieldCheck, FileWarning, Banknote, GitBranch, Trash2 } from "lucide-react";
import { toast } from "./Toast";

// Icon + human label per anomaly kind. Sentence-case labels only (no uppercase eyebrows).
const KIND_META: Record<IntegrityItem["kind"], { label: string; icon: typeof FileWarning }> = {
  resurrected_invoice: { label: "Resurrected invoice", icon: FileWarning },
  orphan_payment:      { label: "Orphan payment",      icon: Banknote },
  orphan_deal_flow:    { label: "Orphan deal flow",    icon: GitBranch },
};

export default function DataSafetyView() {
  const [items, setItems] = useState<IntegrityItem[] | null>(null);
  const [stranded, setStranded] = useState<StrandedWrite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.scanDataIntegrity()
      .then(setItems)
      .catch((e) => { toast(String(e), "error"); setItems([]); })
      .finally(() => setLoading(false));
    // Writes this device gave up delivering. These were previously invisible —
    // only a log line and a table nothing read — so a payment could stop reaching
    // the rest of the org while looking perfectly correct here.
    api.listStrandedWrites().then(setStranded).catch(() => setStranded([]));
  };
  useEffect(load, []);

  const converge = async (it: IntegrityItem) => {
    const rows = it.targets.map((t) => `  • ${t.label}`).join("\n");
    if (!confirm(
      `Converge "${it.title}"?\n\n` +
      `This deletes the following EVERYWHERE — this device, the server, and every other device — through the sync path. It cannot be undone from here:\n\n${rows}\n`
    )) return;
    setWorking(it.id);
    try {
      const deleted = await api.convergeIntegrityItem(it.kind, it.id);
      toast(`Converged — deleted ${deleted.join(", ")} everywhere`);
      load();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setWorking(null);
    }
  };

  const all = items ?? [];

  if (loading && items === null) {
    return (
      <div className="p-6 max-w-[1000px]">
        <div className="h-7 w-40 bg-surface-2 rounded-md animate-pulse mb-6" />
        <div className="h-64 bg-surface-2 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 max-w-[1000px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-bold text-ink flex items-center gap-2">
            <ShieldAlert size={17} className="text-accent" /> Data safety
          </h2>
          <p className="text-[12px] text-muted mt-0.5 max-w-[640px] leading-relaxed">
            Rows that disagree across devices — an invoice deleted elsewhere but still here, a payment or
            deal flow with no live invoice. Review each, then converge it to deleted everywhere through the
            sync path. Nothing is touched until you converge it.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink transition-colors flex-shrink-0">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Rescan
        </button>
      </div>

      {/* Writes this device stopped trying to deliver. Money rows first — those are the
          ones that change a figure. Deliberately shown even when the integrity scan is
          clean, because the two detect completely different failures: the scan compares
          rows that ARRIVED, this lists rows that never left. */}
      {stranded && stranded.length > 0 && (
        <div className="bg-surface border border-danger-line rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-line">
            <div className="text-[13px] font-semibold text-ink flex items-center gap-2">
              <FileWarning size={15} className="text-danger-ink" />
              {stranded.length} change{stranded.length === 1 ? "" : "s"} never reached your other devices
            </div>
            <p className="text-[12px] text-muted mt-1 leading-relaxed">
              These are correct on this computer but this device gave up sending them, so the server and
              your other devices do not have them. Nothing was lost here. Run <strong>Repair sync</strong>,
              or make the same edit again, to push them through.
            </p>
          </div>
          <div className="divide-y divide-line">
            {[...stranded].sort((a, b) => Number(b.is_money) - Number(a.is_money)).map((s) => (
              <div key={s.event_id} className="px-4 py-2.5 flex items-start gap-3 min-w-0">
                <span className={`text-[11px] px-1.5 py-0.5 rounded flex-shrink-0 ${s.is_money ? "bg-danger-bg text-danger-ink font-medium" : "bg-surface-2 text-muted"}`}>
                  {s.is_money ? "money" : s.table || "unknown"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-ink-2 truncate">
                    {s.detail || `${s.op} ${s.table || "?"} ${s.row_id}`}
                  </div>
                  <div className="text-[11.5px] text-muted mt-0.5 break-words">{s.reason}</div>
                </div>
                <span className="text-[11.5px] text-faint flex-shrink-0">{s.at.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {all.length === 0 ? (
        <div className="bg-surface border border-line rounded-xl py-16 flex flex-col items-center">
          <div className="w-10 h-10 rounded-xl bg-surface-2 flex items-center justify-center text-emerald-500 mb-3">
            <ShieldCheck size={18} />
          </div>
          <div className="text-[13px] text-muted">No anomalies found — every device agrees.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {all.map((it) => {
            const meta = KIND_META[it.kind];
            const Icon = meta.icon;
            return (
              <div key={`${it.kind}:${it.id}`} className="bg-surface border border-line-2 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <span className="w-8 h-8 rounded-lg bg-warning-bg text-warning-ink flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13.5px] font-semibold text-ink">{it.title}</span>
                      <span className="text-[10px] font-medium text-muted bg-surface-2 border border-line px-1.5 py-0.5 rounded flex-shrink-0">{meta.label}</span>
                    </div>
                    <p className="text-[12px] text-muted mt-1 leading-relaxed">{it.detail}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {it.targets.map((t, i) => (
                        <span key={i} className="text-[10.5px] text-ink-2 bg-surface-2 border border-line rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                          <Trash2 size={10} className="text-faint" /> {t.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    {it.amount != null && (
                      <span className="text-[13px] font-bold text-ink tabular-nums">{fmtAmount(it.amount)}</span>
                    )}
                    <button onClick={() => converge(it)} disabled={working === it.id}
                      className="border border-red-500/40 text-red-500 hover:bg-red-500/10 px-2.5 h-7 rounded-lg text-[11.5px] font-medium disabled:opacity-50 transition-colors inline-flex items-center gap-1">
                      {working === it.id ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />} Converge
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
