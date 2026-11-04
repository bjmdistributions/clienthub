import { useEffect, useState } from "react";
import { api, IntegrityItem, StrandedWrite } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { RefreshCw, ShieldCheck, FileWarning, Trash2 } from "lucide-react";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Button, PageActions } from "./ui";

// Human label per anomaly kind. Sentence-case labels only (no uppercase eyebrows).
const KIND_LABEL: Record<IntegrityItem["kind"], string> = {
  resurrected_invoice: "Resurrected invoice",
  orphan_payment:      "Orphan payment",
  orphan_deal_flow:    "Orphan deal flow",
};

export default function DataSafetyView() {
  const [items, setItems] = useState<IntegrityItem[] | null>(null);
  const [stranded, setStranded] = useState<StrandedWrite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null); // the row whose "delete everywhere" is waiting on a second click

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
    setConfirmKey(null);
    setWorking(it.id);
    try {
      const deleted = await api.convergeIntegrityItem(it.kind, it.id);
      toast(`Converged: deleted ${deleted.join(", ")} everywhere`);
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
      <div className="min-w-0">
        <div className="skeleton h-10 w-[700px] max-w-full rounded-md mb-6" />
        <div className="skeleton h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <PageActions>
        <Button icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={load}>Rescan</Button>
      </PageActions>

      <p className="m-0 max-w-[700px] text-[14px] leading-5 text-muted">
        Rows that disagree across devices: an invoice deleted elsewhere but still here, a payment or
        deal flow with no live invoice. Review each, then converge it to deleted everywhere through the
        sync path. Nothing is touched until you converge it.
      </p>

      <div className="hsep mt-5" />

      {/* Writes this device stopped trying to deliver. Money rows first, those are the
          ones that change a figure. Deliberately shown even when the integrity scan is
          clean, because the two detect completely different failures: the scan compares
          rows that ARRIVED, this lists rows that never left. */}
      {stranded && stranded.length > 0 && (
        <>
          <section className="py-5 px-1" aria-label="Changes that never left this device">
            <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <FileWarning size={16} className="text-danger-ink" />
              {stranded.length} change{stranded.length === 1 ? "" : "s"} never reached your other devices
            </div>
            <p className="m-0 mt-1.5 mb-3 max-w-[760px] text-[13px] leading-[19px] text-muted">
              These are correct on this computer but this device gave up sending them, so the server and
              your other devices do not have them. Nothing was lost here. Run <span className="font-medium text-ink">Repair sync</span>,
              or make the same edit again, to push them through.
            </p>
            <table className="ui-table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Kind</th>
                  <th>Change and reason</th>
                  <th className="r" style={{ width: 96 }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {[...stranded].sort((a, b) => Number(b.is_money) - Number(a.is_money)).map((s) => (
                  <tr key={s.event_id} className="align-top">
                    <td><StatusPill tone={s.is_money ? "danger" : "neutral"}>{s.is_money ? "money" : s.table || "unknown"}</StatusPill></td>
                    <td style={{ maxWidth: 0 }}>
                      <div className="text-[14px] text-ink truncate">{s.detail || `${s.op} ${s.table || "?"} ${s.row_id}`}</div>
                      <div className="mt-0.5 text-[12px] text-muted break-words">{s.reason}</div>
                    </td>
                    <td className="r text-[12px] text-muted">{s.at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="hsep" />
        </>
      )}

      {all.length === 0 ? (
        <div className="py-[88px] flex flex-col items-center text-center animate-fade-up">
          <ShieldCheck size={20} className="text-success-ink" />
          <div className="mt-2.5 text-[14px] text-muted">No anomalies found. Every device agrees.</div>
        </div>
      ) : (
        <section className="pt-5 px-1" aria-label="Rows that disagree">
          <div className="mb-1 text-[14px] font-medium text-ink">
            {all.length} {all.length === 1 ? "row disagrees" : "rows disagree"} across your devices
          </div>
          {all.map((it) => {
            const key = `${it.kind}:${it.id}`;
            const confirming = confirmKey === key;
            return (
              <div key={key} className="border-t border-line py-4 px-1">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-[280px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium text-ink">{it.title}</span>
                      <StatusPill tone="neutral">{KIND_LABEL[it.kind]}</StatusPill>
                    </div>
                    <p className="m-0 mt-1 text-[13px] leading-[19px] text-muted">{it.detail}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                      <span className="text-[12px] text-muted">Converging removes</span>
                      {it.targets.map((t, i) => (
                        <StatusPill key={i} className="text-ink bg-surface-3">{t.label}</StatusPill>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2.5">
                    {it.amount != null && (
                      <span className="text-[14px] font-medium text-ink tabular-nums">{fmtAmount(it.amount)}</span>
                    )}
                    <Button size="sm" variant="danger" disabled={working === it.id}
                      icon={working === it.id ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      onClick={() => setConfirmKey(confirming ? null : key)}>
                      Converge
                    </Button>
                  </div>
                </div>
                {confirming && (
                  <div className="mt-3.5 rounded-[10px] bg-surface-2 px-4 py-3.5 ring-1 ring-line-3 animate-fade-up">
                    <div className="text-[14px] font-medium text-ink">Converge "{it.title}"?</div>
                    <p className="m-0 mt-1 mb-2 text-[13px] leading-[19px] text-muted">
                      This deletes the following everywhere: this device, the server and every other device, through the sync path. It cannot be undone from here.
                    </p>
                    {it.targets.map((t, i) => <div key={i} className="text-[13px] leading-[22px] text-ink">{t.label}</div>)}
                    <div className="flex gap-2 mt-3">
                      <Button size="sm" onClick={() => setConfirmKey(null)}>Cancel</Button>
                      <Button size="sm" variant="danger" onClick={() => converge(it)}>Delete everywhere</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
