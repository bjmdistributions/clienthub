import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { api, NearDupPair, NearDupRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Likely duplicates (R-456) ───────────────────────────────────────────────
// Jack: "they have slightly different title but shows twice as the same exact number sent".
// The identical-on-every-detail cleanup (R-287) never compares rows with different text, so a
// wire's pending and posted copies, or a statement row beside the bank feed's, both stayed.
// This lists every pair the near-duplicate rule finds (same account, direction and amount to
// the cent, a few days apart) and asks: same payment, or two real payments. Removing the extra
// moves its booking and deal links onto the copy that stays, with a backup written first.

const REASON: Record<string, string> = {
  pending_and_posted: "The bank's pending copy and the posted copy of one payment.",
  two_sources: "Once from a statement import and once from the bank feed.",
  two_connections: "Delivered by two bank connections.",
  different_text: "Same account and amount, a few days apart, with different titles.",
};

function Side({ label, row }: { label: string; row: NearDupRow }) {
  return (
    <div className="min-w-0 flex-1 rounded-[10px] bg-surface-2 ring-1 ring-line px-3 py-2.5">
      <div className="ui-note">{label}</div>
      <div className="text-[13px] text-ink truncate" title={row.description}>{row.description || "No description"}</div>
      <div className="ui-note tabular-nums">
        {row.date}{row.pending ? " · pending at the bank" : ""}{row.source && row.source !== "plaid" ? ` · from a ${row.source} import` : ""}
      </div>
      <div className="text-[12px] mt-0.5 text-ink-2">
        {row.links.length ? row.links.join(", ") : row.booked ? `Booked as ${row.category || "reviewed"}` : "Not booked or linked"}
      </div>
    </div>
  );
}

export default function NearDuplicates({ reloadKey, onChanged }: { reloadKey: unknown; onChanged: () => void }) {
  const [pairs, setPairs] = useState<NearDupPair[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.listNearDuplicates().then(setPairs).catch(() => setPairs([]));
  useEffect(() => { load(); }, [reloadKey]);

  const resolve = async (pairKey: string, keep: NearDupRow, extra: NearDupRow, same: boolean) => {
    setBusy(pairKey);
    try {
      const r = await api.resolveNearDuplicate(keep.id, extra.id, same);
      if (same && r.over_allocated && r.over_allocated.length) {
        toast(`Extra copy removed, but the payment now has more linked than its amount: ${r.over_allocated.join("; ")}. Fix that deal's links.`, "error");
      } else {
        toast(same ? "Extra copy removed. Its booking moved to the copy that stays." : "Kept both as two real payments");
      }
      await load();
      onChanged();
    } catch (e: any) {
      toast(typeof e === "string" ? e : e?.message || "Could not resolve that pair", "error");
    } finally { setBusy(null); }
  };

  if (pairs.length === 0) return null;
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-2.5 py-3 text-left">
        <AlertTriangle size={16} className="text-warning-ink flex-shrink-0" />
        <span className="flex-1 min-w-0 text-[14px] text-ink">
          {pairs.length === 1 ? "1 payment looks like it is on the books twice." : `${pairs.length} payments look like they are on the books twice.`}
          <span className="text-muted"> Review before it throws the numbers off.</span>
        </span>
        <ChevronDown size={16} className={`text-muted transition-transform duration-[180ms] ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="pb-4 space-y-3 dash-load">
          {pairs.map((p) => {
            const key = p.extra.id + p.keep.id;
            return (
              <div key={key} className="rounded-[10px] bg-surface-2 ring-1 ring-line p-3.5 space-y-2.5">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <span className="text-[14px] font-medium text-ink tabular-nums">
                    {fmtAmount(p.keep.amount)} {p.keep.direction === "in" ? "in" : "out"}
                    <span className="text-[13px] font-normal text-muted"> on {p.keep.account}{p.gap_days ? `, ${p.gap_days} day${p.gap_days === 1 ? "" : "s"} apart` : ", same day"}</span>
                  </span>
                  <span className="ui-note">{REASON[p.reason] || ""}</span>
                </div>
                <div className="flex gap-2 flex-col sm:flex-row">
                  <Side label="Stays" row={p.keep} />
                  <Side label="Extra copy" row={p.extra} />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => resolve(key, p.keep, p.extra, true)} disabled={busy !== null}
                    className="ui-btn ui-btn-sm ui-btn-ink">
                    Same payment: remove the extra
                  </button>
                  <button onClick={() => resolve(key, p.extra, p.keep, true)} disabled={busy !== null}
                    className="ui-btn ui-btn-sm">
                    Keep the other copy instead
                  </button>
                  <button onClick={() => resolve(key, p.keep, p.extra, false)} disabled={busy !== null}
                    className="ui-btn ui-btn-sm">
                    Two real payments
                  </button>
                </div>
              </div>
            );
          })}
          <div className="ui-note leading-relaxed">
            Removing a copy writes a backup first and moves its booking, deal links and bill payment onto the copy that stays.
            A copy tied to a refund, loan or expense is never removed: move that link first.
          </div>
        </div>
      )}
    </div>
  );
}
