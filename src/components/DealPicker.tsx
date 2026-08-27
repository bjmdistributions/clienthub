import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { BankSuggestCandidate, DealFlow } from "../lib/api";
import { fmtAmount, parseLocalDay } from "../lib/format";

/* ── Which deal does this payment belong to? ──────────────────────────────────
 *
 * R-204. Jack, on the list this replaces: "the active deals dont stand out
 * enough and mix with completed deals when suggestioning."
 *
 * He was describing two faults, both measured in the code before this was
 * written. The old picker was one flat list of twenty deals with a ten-pixel
 * "Completed"/"Open" word on the right, and its recency tiebreak was
 * `completed_at || created_at` — so a deal completed yesterday outranked a deal
 * invoiced last week that was actually waiting for its money. It did not merely
 * fail to separate live deals from dead ones; it preferred the dead ones.
 *
 * Three sections now, in the order the answer is usually in:
 *
 *   Suggested   the server engine's ranked candidates, each carrying the reason
 *               it was nominated. That reasoning existed all along and never
 *               reached the screen — a server-nominated deal was silently
 *               boosted to the top of the flat list with nothing to explain it.
 *   Active      still in the pipeline, with what each one still expects.
 *   Completed   collapsed behind a count, and dimmed.
 *
 * Completed deals are never REMOVED. A late buyer payment, a supplier settled
 * after the fact and every refund book against a closed deal, so the group
 * opens itself whenever the chosen role is a refund — for a refund the closed
 * deal is the expected answer, not the unlikely one.
 *
 * The modelled-on component is PersonPicker: same section headers, same divider,
 * same reason hint on a suggested row.
 */

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

/** How many rows of a section to render before "Show more". The old picker cut
 *  the list at twenty with no indication, so the twenty-first best deal was
 *  unreachable unless you happened to type its name. */
const PAGE = 12;

const dealLabel = (d: DealFlow) =>
  d.client_name?.trim() || d.name?.trim() || (d.invoice_number ? `Invoice #${d.invoice_number}` : "Untitled deal");

const STAGE_WORDS: Record<string, string> = {
  invoiced: "Invoiced",
  payment_received: "Paid by buyer",
  supplier_paid: "Supplier paid",
  complete: "Completed",
};

const shortDate = (s?: string | null) => {
  if (!s) return "";
  const d = parseLocalDay(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** What this deal still expects from the buyer.
 *
 *  The server sends `outstanding` on a candidate (invoice total less what is
 *  already bank-linked). Everything else falls back to the deal's own recorded
 *  figures — combined with `max`, never summed: a deposit is usually part of
 *  the payment recorded later, and adding them calls a half-paid deal paid. */
export const openBalance = (d: DealFlow, fromServer?: number): number => {
  if (typeof fromServer === "number") return Math.max(0, fromServer);
  const total = d.invoice_total || 0;
  const recorded = Math.max(d.payment_received_amount || 0, d.deposit_amount || 0);
  return Math.max(0, total - recorded);
};

/** What this deal still owes its suppliers — the figure that decides whether a
 *  money-OUT payment fits, where the buyer's balance says nothing at all. */
const legsOwed = (d: DealFlow): number =>
  (d.supplier_payments || [])
    .filter((l) => !l.paid && !l.kept && l.amount > 0)
    .reduce((s, l) => s + l.amount, 0);

/** The money figure to put on a row, and what it means. A picker that shows the
 *  buyer's balance while you are booking a payment TO a supplier is showing the
 *  wrong side of the deal. */
const rowMoney = (d: DealFlow, direction: "in" | "out" | undefined, serverOutstanding?: number) => {
  const total = d.invoice_total || 0;
  if (direction === "out") {
    const owed = legsOwed(d);
    return owed > 0.005
      ? { value: owed, label: "supplier owed", fits: true }
      : { value: total, label: "suppliers settled", fits: false };
  }
  const open = openBalance(d, serverOutstanding);
  if (open <= 0.005) return { value: total, label: "buyer paid", fits: false };
  return {
    value: open,
    label: open + 0.005 < total ? `of ${fmtAmount(total)}` : "owed",
    fits: true,
  };
};

/** A number the user typed, if they typed one. "47,000" and "$47000" both count,
 *  so an amount can be searched the way it is read off the transaction. */
const parseAmountQuery = (q: string): number | null => {
  const cleaned = q.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
};

type Row = { d: DealFlow; cand?: BankSuggestCandidate };

export default function DealPicker({
  deals,
  candidates,
  txnAmount,
  direction,
  role,
  query,
  onQueryChange,
  onPick,
  placeholder,
  autoFocus,
  disabled,
  variant,
  busy,
}: {
  /** The pool, already deduped by the caller (`survivorDeals`) — a suggestion
   *  must never land on a duplicate deal_flow row the deal screen hides. */
  deals: DealFlow[];
  /** Server-scored candidates for the transaction being booked, best first. */
  candidates: BankSuggestCandidate[];
  /** Used to mark a deal whose balance the payment covers exactly. */
  txnAmount: number;
  /** Which side of the deal this payment is on. It decides which balance the
   *  rows carry: money in is measured against the buyer's outstanding invoice,
   *  money out against what the deal still owes its suppliers. Omitted (the
   *  bulk modal, where a selection can be mixed) falls back to the buyer side. */
  direction?: "in" | "out";
  /** The allocation role currently chosen. A refund expects a closed deal, so
   *  the Completed group opens itself. */
  role: string;
  query: string;
  onQueryChange: (v: string) => void;
  onPick: (d: DealFlow, cand?: BankSuggestCandidate) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** `dropdown` (default) floats the list over the form; `inline` renders it in
   *  the flow, for the bulk modal, which is already a list on a panel. Both get
   *  the same sections — the bulk list used to be unsectioned, unranked and
   *  sorted newest-completed-first, so a tag affecting twenty rows was MORE
   *  likely to land on a dead deal than a tag affecting one. */
  variant?: "dropdown" | "inline";
  /** Disables rows while a bulk write is in flight. */
  busy?: boolean;
}) {
  const inline = variant === "inline";
  const [open, setOpen] = useState(inline);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showAllActive, setShowAllActive] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const isRefund = role === "refund_in" || role === "refund_out";
  const [doneOpen, setDoneOpen] = useState(isRefund);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A refund's target is a closed deal, so switching to one opens the group
  // rather than leaving the likely answer behind a disclosure.
  useEffect(() => {
    if (isRefund) setDoneOpen(true);
  }, [isRefund]);

  // Dismissal the old dropdown had neither of: it closed only when you picked
  // something, and Escape closed the entire booking drawer out from under it
  // while the list sat on top of the amount and role controls.
  useEffect(() => {
    if (!open || inline) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    // Capture phase so the drawer's own Escape handler never sees it first.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, inline]);

  const { suggested, active, done, activeTotal, doneTotal } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const amountQ = parseAmountQuery(query);
    const byId = new Map(deals.map((d) => [d.id, d]));

    // Suggested: the server's order, kept verbatim. It already ranks open deals
    // above closed ones and knows about supplier legs, which no client-side
    // ranking here can see.
    //
    // Dropped once something is typed, the same rule PersonPicker uses: a
    // search means you already know the answer, and pinning two unrelated
    // guesses above it is noise.
    const seen = new Set<string>();
    const suggested: Row[] = [];
    if (!q) {
      for (const c of candidates) {
        const d = byId.get(c.deal_id);
        if (!d || seen.has(d.id)) continue;
        seen.add(d.id);
        suggested.push({ d, cand: c });
      }
    }

    const matches = (d: DealFlow) => {
      if (!q) return true;
      const hay = `${d.client_name || ""} ${d.name || ""} ${d.invoice_number || ""}`.toLowerCase();
      if (hay.includes(q)) return true;
      // Searching by amount: the figure on the transaction is usually the
      // fastest way to name the deal, and the old search could not read it.
      if (amountQ !== null) {
        const tol = Math.max(1, amountQ * 0.01);
        if (Math.abs((d.invoice_total || 0) - amountQ) <= tol) return true;
        if (Math.abs(rowMoney(d, direction).value - amountQ) <= tol) return true;
      }
      return false;
    };

    const rest = deals.filter((d) => !seen.has(d.id)).filter(matches);
    const fit = (d: DealFlow) => {
      const m = rowMoney(d, direction);
      return txnAmount > 0 && m.fits && Math.abs(m.value - txnAmount) < 0.5 ? 1 : 0;
    };
    // Live deals rank by how well the payment fits, then by what the deal has
    // been doing lately — never by `completed_at`, which is what made a closed
    // deal outrank a live one.
    const activeAll = rest
      .filter((d) => d.stage !== "complete")
      .sort(
        (a, b) =>
          fit(b) - fit(a) ||
          (Date.parse(b.updated_at || b.created_at || "") || 0) - (Date.parse(a.updated_at || a.created_at || "") || 0)
      );
    const doneAll = rest
      .filter((d) => d.stage === "complete")
      .sort((a, b) => (Date.parse(b.completed_at || "") || 0) - (Date.parse(a.completed_at || "") || 0));

    return {
      suggested,
      active: showAllActive ? activeAll : activeAll.slice(0, PAGE),
      done: showAllDone ? doneAll : doneAll.slice(0, PAGE),
      activeTotal: activeAll.length,
      doneTotal: doneAll.length,
    };
  }, [deals, candidates, query, txnAmount, direction, showAllActive, showAllDone]);

  // Everything the arrow keys can land on, in render order.
  const walk: Row[] = useMemo(
    () => [...suggested, ...active.map((d) => ({ d })), ...(doneOpen ? done.map((d) => ({ d })) : [])],
    [suggested, active, done, doneOpen]
  );

  useEffect(() => setActiveIdx(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? activeIdx + 1 : activeIdx - 1;
      const clamped = Math.max(0, Math.min(walk.length - 1, next));
      setActiveIdx(clamped);
      listRef.current?.querySelector(`[data-idx="${clamped}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const row = walk[activeIdx];
      if (row) {
        e.preventDefault();
        pick(row);
      }
    }
  };

  const pick = (r: Row) => {
    if (busy) return;
    onPick(r.d, r.cand);
    if (!inline) setOpen(false);
  };

  const row = (r: Row, idx: number, dim?: boolean) => {
    const { d, cand } = r;
    const money = rowMoney(d, direction, cand?.outstanding);
    const isActive = d.stage !== "complete";
    const exact = txnAmount > 0 && money.fits && Math.abs(money.value - txnAmount) < 0.5;
    return (
      <button
        key={`${d.id}-${cand?.role ?? ""}`}
        data-idx={idx}
        onMouseEnter={() => setActiveIdx(idx)}
        onClick={() => pick(r)}
        disabled={busy}
        className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-start gap-2 min-w-0 disabled:opacity-50 ${
          idx === activeIdx ? "bg-surface-2" : "hover:bg-surface-2"
        } ${dim ? "opacity-70" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink truncate">{dealLabel(d)}</div>
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
            <span
              className={`text-[10px] px-1.5 py-px rounded-md border flex-shrink-0 ${
                isActive ? "border-accent/40 bg-accent/5 text-accent" : "border-line bg-surface-2 text-muted"
              }`}
            >
              {STAGE_WORDS[d.stage] ?? d.stage}
            </span>
            <span className="text-[11px] text-muted truncate min-w-0">
              {d.invoice_number ? `#${d.invoice_number}` : ""}
              {d.invoice_number && (d.completed_at || d.created_at) ? " · " : ""}
              {shortDate(d.completed_at || d.created_at)}
            </span>
          </div>
          {cand?.reason && (
            <div className="text-[11px] text-accent truncate mt-0.5">
              {cand.reason}
              {cand.role === "supplier_payment" && cand.supplier_name ? ` · ${cand.supplier_name}` : ""}
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className={`text-[12.5px] tabular-nums ${exact ? "text-accent font-semibold" : "text-ink-2"}`}>
            {money.value ? fmtAmount(money.value) : "—"}
          </div>
          <div className="text-[10px] text-muted tabular-nums">{money.label}</div>
        </div>
      </button>
    );
  };

  const header = (text: string) => (
    <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted">{text}</div>
  );

  const more = (shown: number, total: number, onMore: () => void) =>
    total > shown ? (
      <button
        onClick={onMore}
        className="w-full text-left px-3 py-1.5 text-[11px] text-accent hover:bg-surface-2 rounded-lg transition-colors"
      >
        Showing {shown} of {total} — show the rest
      </button>
    ) : null;

  let idx = -1;
  const nothing = suggested.length === 0 && activeTotal === 0 && doneTotal === 0;

  return (
    <div ref={wrapRef} className={inline ? "min-w-0 flex flex-col min-h-0" : "relative min-w-0"}>
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={() => setOpen(true)}
        // `onFocus` alone leaves the list unreachable after Escape: the input
        // still holds focus, so clicking it again fires no focus event and the
        // dropdown stays shut with no way back except tabbing away and back.
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder || "Search a deal, or type an amount…"}
        aria-label="Search deals"
        aria-expanded={open}
        className={inp}
      />
      {open && (
        <div
          ref={listRef}
          className={
            inline
              ? "mt-2 flex-1 min-h-0 overflow-y-auto -mx-1 px-1"
              : "absolute z-20 mt-1 w-full max-h-[22rem] overflow-y-auto bg-surface border border-line rounded-lg shadow-lg p-1"
          }
        >
          {nothing ? (
            <div className="px-3 py-3 text-[11px] text-muted">
              No deals match{query.trim() ? ` "${query.trim()}"` : " yet"}.
            </div>
          ) : (
            <>
              {suggested.length > 0 && (
                <>
                  {header("Suggested for this payment")}
                  {suggested.map((r) => row(r, ++idx))}
                  <div className="my-1 border-t border-line-2" />
                </>
              )}
              {active.length > 0 && (
                <>
                  {header(suggested.length > 0 ? "Other active deals" : "Active deals")}
                  {active.map((d) => row({ d }, ++idx))}
                  {more(active.length, activeTotal, () => setShowAllActive(true))}
                </>
              )}
              {doneTotal > 0 && (
                <>
                  {(suggested.length > 0 || active.length > 0) && <div className="my-1 border-t border-line-2" />}
                  <button
                    onClick={() => setDoneOpen((v) => !v)}
                    aria-expanded={doneOpen}
                    className="w-full flex items-center gap-1 px-3 pt-2 pb-1 text-[11px] font-medium text-muted hover:text-ink-2 transition-colors"
                  >
                    {doneOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Completed deals
                    <span className="tabular-nums">({doneTotal})</span>
                    {isRefund && <span className="ml-1 text-accent">refunds usually go here</span>}
                  </button>
                  {doneOpen && (
                    <>
                      {done.map((d) => row({ d }, ++idx, true))}
                      {more(done.length, doneTotal, () => setShowAllDone(true))}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
