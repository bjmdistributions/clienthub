import { useState } from "react";
import { ChevronDown, AlertTriangle } from "lucide-react";
import type { MovedBooking } from "../lib/api";
import { fmtAmount } from "../lib/format";

// ─── Moved bookings (R-614) ──────────────────────────────────────────────────
// Jack: "i started spamming it and now i dont remeber what transactions they were and if i screwed up
// deals". Every booking Take over, Swap or the bank sync moved off one bank row onto another copy of
// the same payment, newest first, with the deals it carried. Read from this computer's backups, which
// never sync, so a move made on another computer or the phone is not listed here.

const WHY: Record<MovedBooking["reason"], string> = {
  plaid_settled_inferred: "Take over, Swap or the bank sync",
  plaid_settled: "The bank posted a pending charge",
  link_twin: "A copy from your other bank link",
  not_at_bank_copy: "Your bank no longer showed the booked row",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso.slice(0, 16) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const cat = (c: string) => (c ? c.replace(/_/g, " ") : "");

export default function MovedBookings({ rows }: { rows: MovedBooking[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const today = new Date().toDateString();
  const todayCount = rows.filter((r) => new Date(r.moved_at).toDateString() === today).length;
  const flagged = rows.filter((r) => r.short || !r.now).length;
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center gap-2.5 py-3 text-left">
        <span className="flex-1 min-w-0 text-[14px] text-ink">
          {rows.length === 1 ? "1 booking was moved onto the bank's copy of its payment." : `${rows.length} bookings were moved onto the bank's copy of their payment.`}
          <span className="text-muted">
            {todayCount > 0 ? ` ${todayCount} today.` : ""}
            {flagged > 0 ? ` ${flagged} to check.` : " Every deal still points at the same money."}
          </span>
        </span>
        <ChevronDown size={16} className={`text-muted transition-transform duration-[180ms] ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="pb-4">
          <table className="ui-table ui-table-sm">
            <thead>
              <tr>
                <th className="whitespace-nowrap">Moved</th>
                <th>Payment</th>
                <th>Was on</th>
                <th>Now on</th>
                <th>Deals it carried</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap tabular-nums text-muted">{when(r.moved_at)}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtAmount(r.old.amount)} {r.old.direction === "in" ? "in" : "out"}
                    <div className="ui-note truncate max-w-[220px]" title={r.old.description}>{r.old.description || "No description"}</div>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {r.old.date}
                    <div className="ui-note">{cat(r.old.category)}</div>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {r.now ? (
                      <>
                        {r.now.date}{Math.abs(r.now.amount - r.old.amount) > 0.005 && <> · {fmtAmount(r.now.amount)}</>}
                        <div className="ui-note">{cat(r.now.category)}</div>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-warning-ink"><AlertTriangle size={13} /> That copy is gone too</span>
                    )}
                  </td>
                  <td>
                    {r.deals.length === 0 ? <span className="text-muted">None</span> : r.deals.map((d) => (
                      <div key={d.deal_flow_id + d.role} className="whitespace-nowrap">
                        {d.invoice_number || "Deal"}{d.client ? ` · ${d.client}` : ""} <span className="text-muted tabular-nums">{fmtAmount(d.amount)}</span>
                      </div>
                    ))}
                    {r.short && (
                      <div className="inline-flex items-center gap-1 text-warning-ink text-[12px]"><AlertTriangle size={13} /> The copy is smaller than what is linked</div>
                    )}
                  </td>
                  <td className="text-muted">{WHY[r.reason] ?? r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ui-note leading-relaxed mt-2">
            Each move kept the payment on the same deals. Only the bank row changed, and the old row was backed up before it was removed.
            This list reads this computer's backups. A move made on another computer is listed there, and one made on the phone is not listed yet.
          </div>
        </div>
      )}
    </div>
  );
}
