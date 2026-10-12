import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { api, RetractedMatch, RetractedRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { toast } from "./Toast";

// ─── Retracted by bank (R-497) ───────────────────────────────────────────────
// Jack: "how do i ensure that that is actually the case ... i dont like that now i have to
// worry about rebooking a financial that showed up again". A row is retracted only when the
// bank feed removes that exact transaction; it is kept because it holds booked work. This
// lists every one with the posted copies that match it (the R-289 take-over rule), so the
// booking can be swapped onto the copy the bank kept. One with no posted copy ten days on was
// cancelled by the bank, and can be removed.

function booking(booked: boolean, category: string) {
  return booked ? `Booked as ${(category || "reviewed").replace(/_/g, " ")}` : "Not booked";
}

function Side({ label, date, amount, description, note }: {
  label: string; date: string; amount?: number; description: string; note: string;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className="text-[12px] text-ink truncate" title={description}>{description || "No description"}</div>
      <div className="text-[11px] text-muted tabular-nums">{date}{amount !== undefined ? ` · ${fmtAmount(amount)}` : ""}</div>
      <div className="text-[11px] mt-0.5 text-ink-2">{note}</div>
    </div>
  );
}

export default function RetractedRows({ rows, onChanged, onShow }: {
  rows: RetractedRow[]; onChanged: () => void; onShow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const swap = async (r: RetractedRow, m: RetractedMatch) => {
    setBusy(r.id);
    try {
      const res = await api.takeOverBooking(r.id, m.id);
      toast(res.over_allocated?.length
        ? `Booking moved. The posted amount is lower than what's linked: ${res.over_allocated.join("; ")}.`
        : "Booking moved to the posted copy. The retracted row is removed.", res.over_allocated?.length ? "error" : "success");
      onChanged();
    } catch (e: any) {
      toast(typeof e === "string" ? e : e?.message || "Could not swap that booking", "error");
    } finally { setBusy(null); }
  };

  const remove = async (r: RetractedRow) => {
    setBusy(r.id);
    try {
      const res = await api.removeCancelledTxn(r.id);
      toast(res.deals ? "Removed. The deals it was linked to are updated." : "Removed.");
      onChanged();
    } catch (e: any) {
      toast(typeof e === "string" ? e : e?.message || "Could not remove it", "error");
    } finally { setBusy(null); }
  };

  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning-bg">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen((v) => !v)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
          <AlertTriangle size={14} className="text-warning-ink flex-shrink-0" />
          <span className="flex-1 min-w-0 text-[12.5px] font-medium text-ink">
            {rows.length === 1 ? "1 transaction your bank retracted is still on the books." : `${rows.length} transactions your bank retracted are still on the books.`}
            <span className="text-muted font-normal"> Swap each onto its posted copy, or remove it if the bank cancelled it.</span>
          </span>
          <ChevronDown size={14} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <button onClick={onShow}
          className="h-7 px-2.5 rounded-lg border border-line text-[11.5px] text-ink-2 hover:bg-surface flex-shrink-0 transition-colors">
          Show only these
        </button>
      </div>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-line bg-surface-2 p-3 space-y-2">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-ink tabular-nums">
                  {fmtAmount(r.amount)} {r.direction === "in" ? "in" : "out"}
                  <span className="text-[11.5px] font-normal text-muted"> on {r.account}</span>
                </span>
                <span className="text-[11px] text-muted">
                  {r.matches.length
                    ? r.matches.some((m) => m.automatic) ? "Your bank posted it again. It swaps on the next bank sync." : "Your bank posted it again."
                    : r.cancelled ? "No posted copy in 10 days, so your bank cancelled it." : "Waiting for your bank's posted copy."}
                </span>
              </div>
              <div className="flex gap-2 flex-col sm:flex-row">
                <Side label="Retracted by bank" date={r.date} description={r.description} note={booking(r.booked, r.category)} />
                {r.matches.map((m) => (
                  <Side key={m.id} label="Posted copy" date={m.date}
                    amount={Math.abs(m.amount - r.amount) > 0.005 ? m.amount : undefined}
                    description={m.description} note={booking(m.booked, m.category)} />
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {r.matches.map((m) => (
                  <button key={m.id} onClick={() => swap(r, m)} disabled={busy !== null}
                    className="h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium disabled:opacity-40 transition-colors">
                    {r.matches.length === 1 ? "Swap: move the booking to the posted copy" : `Swap onto the ${m.date.slice(5)} copy`}
                  </button>
                ))}
                {r.cancelled && (
                  <button onClick={() => remove(r)} disabled={busy !== null}
                    className="h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium disabled:opacity-40 transition-colors">
                    Remove it
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="text-[10.5px] text-muted">
            Swap moves the booking and deal links onto the posted copy and removes the retracted row. Remove takes the row and its deal links off the books.
            Both write a backup first. A row tied to a refund, loan, expense or bill is never removed: move that link first.
          </div>
        </div>
      )}
    </div>
  );
}
