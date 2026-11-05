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
    <div className="min-w-0 flex-1 rounded-[10px] bg-surface-2 ring-1 ring-line px-3 py-2.5">
      <div className="ui-note">{label}</div>
      <div className="text-[13px] text-ink truncate" title={description}>{description || "No description"}</div>
      <div className="ui-note tabular-nums">{date}{amount !== undefined ? ` · ${fmtAmount(amount)}` : ""}</div>
      <div className="text-[12px] mt-0.5 text-ink-2">{note}</div>
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
    // R-579: offered on every retracted row. The rule cannot tell a cancelled charge from one the bank
    // posted under another name; the person looking at the row can.
    const ok = window.confirm(
      `Remove ${fmtAmount(r.amount)} "${r.description}" from ${r.date}?\n\n` +
        (r.booked ? "Its booking and any deal links go with it. " : "") +
        "A copy is saved first. If the bank posted this money again, book the posted copy in To book."
    );
    if (!ok) return;
    setBusy(r.id);
    try {
      const res = await api.removeCancelledTxn(r.id);
      toast(res.deals ? "Removed. The deals it was linked to are updated." : "Removed.");
      onChanged();
    } catch (e: any) {
      toast(typeof e === "string" ? e : e?.message || "Could not remove it", "error");
    } finally { setBusy(null); }
  };

  // R-579: "some transactions are legit completely different and they should not be swapped."
  const notSame = async (r: RetractedRow, m: RetractedMatch) => {
    setBusy(r.id);
    try {
      await api.markTakeoverNotSame(r.id, m.id);
      toast("Noted. That pair will not be offered or swapped again.");
      onChanged();
    } catch (e: any) {
      toast(typeof e === "string" ? e : e?.message || "Could not save that", "error");
    } finally { setBusy(null); }
  };

  if (rows.length === 0) return null;
  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 py-3">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex-1 min-w-0 flex items-center gap-2.5 text-left">
          <AlertTriangle size={16} className="text-warning-ink flex-shrink-0" />
          <span className="flex-1 min-w-0 text-[14px] text-ink">
            {rows.length === 1 ? "1 transaction your bank retracted is still on the books." : `${rows.length} transactions your bank retracted are still on the books.`}
            <span className="text-muted"> Swap each onto its posted copy, or remove it if the bank cancelled it.</span>
          </span>
          <ChevronDown size={16} className={`text-muted transition-transform duration-[180ms] ${open ? "rotate-180" : ""}`} />
        </button>
        <button onClick={onShow}
          className="ui-btn ui-btn-sm flex-shrink-0">
          Show only these
        </button>
      </div>
      {open && (
        <div className="pb-4 space-y-3 dash-load">
          {rows.map((r) => (
            <div key={r.id} className="rounded-[10px] bg-surface-2 ring-1 ring-line p-3.5 space-y-2.5">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="text-[14px] font-medium text-ink tabular-nums">
                  {fmtAmount(r.amount)} {r.direction === "in" ? "in" : "out"}
                  <span className="text-[13px] font-normal text-muted"> on {r.account}</span>
                </span>
                <span className="ui-note">
                  {r.matches.length
                    ? r.matches.some((m) => m.automatic)
                      ? "Same name, same amount: it swaps on the next bank sync unless you say it is not the same."
                      : "A posted row looks like it. Check the name and date before you swap."
                    : r.cancelled
                      // R-518: the code knows only that nothing matched (amount within 30%, same account, a shared
                      // memo word, within 10 days), not that the bank cancelled the charge.
                      ? "No matching posted copy found in 10 days. If the money shows in To book under another name, book it there first."
                      : "Waiting for your bank's posted copy."}
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
                  <span key={m.id} className="inline-flex items-center gap-1.5">
                    {/* R-614: a swap the move would refuse says why instead of failing with a red message. */}
                    {m.blocked ? (
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warning-ink">
                        <AlertTriangle size={13} className="flex-shrink-0" />
                        {r.matches.length === 1 ? "Can't swap yet. " : `Can't swap onto the ${m.date.slice(5)} copy yet. `}{m.blocked}
                      </span>
                    ) : (
                    <button onClick={() => swap(r, m)} disabled={busy !== null}
                      className="ui-btn ui-btn-sm ui-btn-ink">
                      {r.matches.length === 1 ? "Swap: move the booking to the posted copy" : `Swap onto the ${m.date.slice(5)} copy`}
                    </button>
                    )}
                    <button onClick={() => notSame(r, m)} disabled={busy !== null}
                      title="Keep both. This pair is never offered or swapped again."
                      className="ui-btn ui-btn-sm">
                      {r.matches.length === 1 ? "Not the same" : `Not the ${m.date.slice(5)} one`}
                    </button>
                  </span>
                ))}
                <button onClick={() => remove(r)} disabled={busy !== null}
                  className={`ui-btn ui-btn-sm ${r.matches.length ? "" : "ui-btn-ink"}`}>
                  Remove it
                </button>
              </div>
            </div>
          ))}
          <div className="ui-note leading-relaxed">
            Swap moves the booking and deal links onto the posted copy and removes the retracted row. Not the same keeps both and stops that pair being offered.
            Remove takes the row and its deal links off the books. Every removal writes a backup first. A row tied to a refund, loan, expense or bill is never removed: move that link first.
          </div>
        </div>
      )}
    </div>
  );
}
