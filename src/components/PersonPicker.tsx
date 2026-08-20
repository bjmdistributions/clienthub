import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { BankPersonCandidate } from "../lib/api";
import { fmtAmount } from "../lib/format";

/* ── Who is this payment with? ───────────────────────────────────────────────
 *
 * One picker, now three entry points: the Financials ledger row, the booking
 * sheet, and a payment row on a client or supplier profile (R-175). Jack has to
 * be able to correct an attribution where he SEES it wrong, which is on the
 * profile, not only where the money was booked.
 *
 * A tag is IDENTITY, NOT ACCOUNTING. Picking someone here records who the money
 * is with. It ties nothing to a deal and moves no profit, cost, Free Cash or
 * reconciliation figure - the tag says who, the allocation says what it paid for.
 */

export type PersonRef = { type: "client" | "supplier"; id: string; name: string };
export const personKey = (p: { type: string; id: string }) => `${p.type}:${p.id}`;

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function PersonPickerModal({
  txn, people, candidates, current, busy, onClose, onPick,
}: {
  /** Only the three fields the header prints - a profile row has no full BankTxn. */
  txn: { direction: string; amount: number; posted_at?: string | null };
  people: PersonRef[];
  candidates: BankPersonCandidate[];
  current: PersonRef | null;
  busy: boolean;
  onClose: () => void;
  onPick: (p: PersonRef) => void;
}) {
  const [q, setQ] = useState("");
  const suggested = candidates.filter((c) => !current || personKey(c) !== personKey(current));
  const suggestedKeys = new Set(suggested.map(personKey));
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people
      .filter((p) => !suggestedKeys.has(personKey(p)))
      .filter((p) => !s || p.name.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, q, candidates, current]);
  const clients = matches.filter((p) => p.type === "client");
  const suppliers = matches.filter((p) => p.type === "supplier");

  const row = (p: PersonRef, hint?: string) => (
    <button
      key={personKey(p)}
      onClick={() => onPick(p)}
      disabled={busy}
      className="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-2 disabled:opacity-50 transition-colors flex items-center gap-2 min-w-0"
    >
      <span className="text-[13px] text-ink truncate min-w-0">{p.name}</span>
      {hint && <span className="ml-auto text-[11px] text-muted truncate flex-shrink-0 max-w-[55%]">{hint}</span>}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link this payment to a person"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-ink">Who is this payment with?</h2>
            <p className="text-[12px] text-muted mt-0.5">
              {txn.direction === "in" ? "Money in" : "Money out"} · {fmtAmount(txn.amount)} ·{" "}
              {(txn.posted_at || "").slice(0, 10)}
            </p>
            <p className="text-[12px] text-muted mt-1.5">
              This records who the money is with. It doesn't tie it to a deal and it changes no figure —
              tie it to a deal below if it belongs to one.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-line">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search clients and suppliers…"
            className={inp}
          />
        </div>
        <div className="overflow-y-auto p-2">
          {current && (
            <div className="px-3 py-2 text-[12px] text-muted">
              Linked to <span className="text-ink-2 font-medium">{current.name}</span> — picking someone else replaces it.
            </div>
          )}
          {suggested.length > 0 && !q.trim() && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted">Suggested from the bank memo</div>
              {suggested.map((c) => row(
                { type: c.type, id: c.id, name: c.name },
                c.reason,
              ))}
              <div className="my-1 border-t border-line-2" />
            </>
          )}
          {clients.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted">Clients</div>
              {clients.map((p) => row(p))}
            </>
          )}
          {suppliers.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted">Suppliers</div>
              {suppliers.map((p) => row(p))}
            </>
          )}
          {suggested.length === 0 && matches.length === 0 && (
            <div className="text-center py-8 text-[12px] text-muted">Nobody matches that name</div>
          )}
        </div>
      </div>
    </div>
  );
}
