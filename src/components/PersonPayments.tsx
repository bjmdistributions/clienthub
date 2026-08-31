import { useMemo, useState } from "react";
import { ArrowRight, X, UserCog } from "lucide-react";
import { api, CounterpartyPaymentRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import PersonPickerModal, { PersonRef } from "./PersonPicker";
import { toast } from "./Toast";

/* ── Bank payments on a client or supplier profile (R-156, W1-d/e/f) ─────────
 *
 * One component for both profiles. The two sides of a deal should read
 * identically (R-153), and the memo classifier below would otherwise have to be
 * copied into two screens instead of one.
 *
 * THREE GROUPS, NEVER SILENTLY MERGED (W1-d, R-157/F2+F3). A payment reaches
 * this screen in one of three states, and each carries a different claim:
 *   1. booked to a deal that is genuinely THEIRS — that deal already counts it;
 *   2. booked to somebody else's deal — it counts there, and not here at all;
 *   3. tagged to them and booked nowhere — no deal counts it.
 * State 2 exists because an allocation only ever says "booked", never "booked to
 * them": a $100,000 buyer payment on another client's invoice can be tagged to
 * this person, and calling that "booked to their deals" put six figures of
 * someone else's money in their total. Every row lands in exactly one group.
 *
 * MONEY IN AND MONEY OUT ARE NEVER NETTED. One party can be both a buyer and a
 * supplier (R-155); a single signed "total" for such a party would read as a
 * profit figure while being nothing of the kind.
 *
 * A tag is IDENTITY, NOT ACCOUNTING. Nothing in this file feeds deal profit,
 * cost, Free Cash or any reconciliation figure, and nothing here may start.
 */

/** All six come back from `counterparty_payments` but are not on
 *  `CounterpartyPaymentRow` yet (api.ts belongs to another session — see the
 *  report), so they are declared here rather than read off an `any`. */
type Row = CounterpartyPaymentRow & {
  confirmed_method?: string | null;
  rail?: string | null;
  bank_method?: string | null;
  deal_is_theirs?: boolean;
  booked_amount?: number;
};

// Roles a bank allocation can carry. Labels copied from ROLES in
// FinancialsView.tsx, which does not export them; the two must not drift. A role
// the app does not know is shown as it is stored rather than guessed at.
const ROLE_LABELS: Record<string, string> = {
  buyer_payment: "Payment from the buyer",
  supplier_payment: "Payment to the supplier",
  refund_out: "Refund back to the buyer",
  refund_in: "Money back from the supplier",
  fee: "Fee",
  adjustment: "Adjustment",
};
const roleLabel = (v: string) => ROLE_LABELS[v] ?? v;

/** Which roles a deal's own figures are actually built from. `deal_bank_actuals`
 *  (commands.rs:4474) is the single derivation, and it reads exactly four:
 *      revenue = buyer_payment
 *      cost    = supplier_payment + fee − refund_in
 *      net     = revenue − cost, deliberately PRE-REFUND
 *  `refund_out` is in neither line and `adjustment` is read by nothing anywhere,
 *  so a deal's recorded profit does not contain them. That is not an oversight to
 *  paper over: a refund is counted once, against REVENUE, and never against
 *  profit — netting it out of profit reported Tyler Cobb at −$85,720 on deals
 *  that earned nothing. So "that deal already counts this money" is false for
 *  every refund on this screen: five of them, $52,890, sit under it on Kameron
 *  Alvarado's profile today. The group keeps them — they ARE booked to the deal —
 *  and the caption states the two claims separately instead of one vague one. */
const IN_DEAL_FIGURES = new Set(["buyer_payment", "supplier_payment", "fee", "refund_in"]);

// ── Payment method (W1-f) ───────────────────────────────────────────────────
// MUST stay identical to BANK_METHODS in commands.rs and METHODS in
// FinancialsView.tsx. A method added on one side alone silently fails.
type Method = "wire" | "ach" | "zelle" | "rtp" | "check" | "card" | "cash" | "transfer";

const METHODS: { value: Method; label: string }[] = [
  { value: "wire",     label: "Wire" },
  { value: "ach",      label: "ACH" },
  { value: "zelle",    label: "Zelle" },
  { value: "rtp",      label: "Real-time payment" },
  { value: "check",    label: "Check" },
  { value: "card",     label: "Card" },
  { value: "cash",     label: "Cash" },
  { value: "transfer", label: "Internal transfer" },
];
const methodLabel = (v: string) => METHODS.find((m) => m.value === v)?.label ?? v;

// Ordered — first match wins, so a specific rail beats the generic wording it
// contains. Copied from FinancialsView.METHOD_PATTERNS, which does not export
// it; the two must not drift. `card` has no pattern on purpose: this bank
// prints a card purchase as the merchant alone, so guessing would be worse than
// saying nothing, and the unclassified count says how many.
const METHOD_PATTERNS: { method: Method; re: RegExp }[] = [
  { method: "wire",     re: /\bFEDWIRE\b/ },
  { method: "wire",     re: /\bWIRE TYPE\b/ },
  { method: "wire",     re: /\bWIRE TRANSFER\b/ },
  { method: "wire",     re: /\bWIRE\b/ },
  { method: "wire",     re: /\bCHIPS\b/ },
  { method: "wire",     re: /\bBOOK TRANSFER\b/ },
  { method: "zelle",    re: /\bZELLE\b/ },
  { method: "zelle",    re: /\bQUICKPAY\b/ },
  { method: "rtp",      re: /\bREAL TIME (?:PAYMENT|TRANSFER)\b/ },
  { method: "rtp",      re: /\bRTP\b/ },
  { method: "check",    re: /\bCHECK\s*#/ },
  { method: "ach",      re: /\bACH\b/ },
  { method: "ach",      re: /\bORIG CO NAME\b/ },
  { method: "ach",      re: /\b(?:PPD|CCD)\b/ },
  { method: "cash",     re: /\bATM\b/ },
  { method: "cash",     re: /\bCASH (?:DEPOSIT|WITHDRAWAL)\b/ },
  { method: "cash",     re: /\bTELLER\b/ },
  { method: "transfer", re: /\bONLINE TRANSFER\b/ },
  { method: "transfer", re: /\bTRANSFER (?:TO|FROM)\b/ },
];

// An institution's own vocabulary. Anything unrecognised returns null and falls
// through to the memo — mapping an unknown string onto a method invents a fact.
const bankFieldMethod = (raw?: string | null): Method | null => {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v.includes("wire")) return "wire";
  if (v.includes("zelle")) return "zelle";
  if (v.includes("ach") || v.includes("standard entry")) return "ach";
  if (v.includes("check") || v.includes("cheque")) return "check";
  if (v.includes("card")) return "card";
  if (v.includes("cash")) return "cash";
  if (v.includes("rtp") || v.includes("real-time") || v.includes("real time")) return "rtp";
  if (v.includes("transfer")) return "transfer";
  return null;
};

type MethodRead = { method: Method | ""; state: "certain" | "likely" | "unclassified"; reason: string };

/** Three states, never two, in FinancialsView.readMethod's order — the branches
 *  below are that function minus its payee memory. That map is built from the
 *  WHOLE ledger; a version built from one person's rows would answer differently
 *  on the two screens for the same transaction, which is worse than not having
 *  it here.
 *
 *  Only the first two branches are facts. `confirmed_method` is the ONLY column a
 *  human ever answered, so it is the only thing that can make the screen say he
 *  set it; `rail` is the statement importer's own memo guess and sits down with
 *  the rest of the guesswork, because that is what it is. Reading `rail` as
 *  certain — which this file did until the query started sending it — launders a
 *  guess into "you set this method" over a method Jack never picked. */
const readMethod = (p: Row): MethodRead => {
  if (p.confirmed_method) return { method: p.confirmed_method as Method, state: "certain", reason: "You set this method" };
  const field = bankFieldMethod(p.bank_method);
  if (field) return { method: field, state: "certain", reason: "The bank supplied this method" };
  const hay = `${p.description || ""} ${p.counterparty_name || ""}`.toUpperCase();
  const hit = METHOD_PATTERNS.find((m) => m.re.test(hay));
  if (hit) return { method: hit.method, state: "likely", reason: "Read off the memo, not confirmed" };
  if (p.rail) return { method: p.rail as Method, state: "likely", reason: "The statement importer read it off the memo, not confirmed" };
  return { method: "", state: "unclassified", reason: "" };
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Read the date out of the string. A date-only value through `new Date()` is
 *  parsed as UTC and rendered in Central lands a day early — that shipped once.
 *  The list is no longer capped at 12 rows, so it spans years: name the year
 *  whenever it is not the current one. */
const dayLabel = (raw: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw || "");
  if (!m) return "";
  const day = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  return Number(m[1]) === new Date().getFullYear() ? day : `${day}, ${m[1]}`;
};

type Totals = { n: number; moneyIn: number; moneyOut: number };

const totalsOf = (rows: Row[]): Totals => {
  let moneyIn = 0, moneyOut = 0;
  for (const r of rows) {
    if (r.direction === "in") moneyIn += r.amount; else moneyOut += r.amount;
  }
  return { n: rows.length, moneyIn, moneyOut };
};

/** "4 payments · $12,300.00 in · $900.00 out". Each direction stands on its own
 *  — see the no-netting rule at the top of this file. */
const totalsLabel = (t: Totals): string => {
  const parts = [`${t.n} payment${t.n === 1 ? "" : "s"}`];
  if (t.moneyIn > 0) parts.push(`${fmtAmount(t.moneyIn)} in`);
  if (t.moneyOut > 0) parts.push(`${fmtAmount(t.moneyOut)} out`);
  return parts.join(" · ");
};

/** True when the transaction was split across deals and only part of it landed
 *  on theirs. `booked_amount` is the part that did; `amount` is the whole
 *  statement line, which is what the row shows. */
const partlyBooked = (r: Row): boolean =>
  typeof r.booked_amount === "number" && r.booked_amount > 0 && Math.abs(r.booked_amount - r.amount) > 0.01;

/** Open the ledger on one transaction. FinancialsView opens its row and scrolls
 *  to it, and opens every filter first so the jump cannot land on a row the
 *  current filters were hiding. */
const openTxn = (txnId: string) => {
  (window as any).__pendingBankTxn = txnId;
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }));
};

const openFinancials = (person?: { type: "client" | "supplier"; id: string }) => {
  // Same handoff shape as __pendingBankTxn: FinancialsView reads this on mount,
  // switches to the ledger, selects the person and opens every other filter.
  if (person) (window as any).__financialsPerson = { type: person.type, id: person.id };
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" }));
};

const linkCls = "inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:text-accent-hover transition-colors";

export default function PersonPayments({ person, payments, onUntag, people, onChanged }: {
  person: { type: "client" | "supplier"; id: string; name: string };
  payments: CounterpartyPaymentRow[];
  onUntag: (txnId: string) => void;
  /** Every client and supplier, for the "who is this actually with?" picker.
   *  Omitted, the picker is simply not offered - the rest of the screen is
   *  unchanged, so a caller that has not loaded them yet still renders. */
  people?: PersonRef[];
  /** Re-fetch after an edit made here. Without it the row keeps showing what it
   *  showed before the write, which reads as the edit having failed. */
  onChanged?: () => void;
}) {
  const [method, setMethod] = useState<"all" | Method | "unclassified">("all");
  const [pickerFor, setPickerFor] = useState<Row | null>(null);
  const [busyTxn, setBusyTxn] = useState<string | null>(null);

  // Re-tagging is IDENTITY ONLY: it rewrites counterparty_type/counterparty_id on
  // the transaction and touches no allocation, so no deal figure can move. Since
  // R-175 the tag is also exclusive - the payment leaves every other profile the
  // deal inference had put it on, which is the whole point of correcting it here.
  const retag = async (row: Row, to: PersonRef) => {
    setBusyTxn(row.txn_id);
    try {
      await api.tagBankTxnCounterparty(row.txn_id, to.type, to.id);
      toast(`Filed under ${to.name}`);
      setPickerFor(null);
      onChanged?.();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusyTxn(null);
    }
  };

  // The payment belongs to somebody who was never entered. Which side of the book
  // they go on is not a guess: money out went to a supplier, money in came from a
  // client. Creating the record and tagging it are one step, because leaving to
  // create it and coming back is the dead end this exists to close.
  const createAndRetag = async (row: Row, name: string) => {
    setBusyTxn(row.txn_id);
    try {
      const type: PersonRef["type"] = row.direction === "in" ? "client" : "supplier";
      const id = type === "client"
        ? (await api.createClient({ name })).id
        : await api.createSupplier({ name });
      await api.tagBankTxnCounterparty(row.txn_id, type, id);
      toast(`Created ${name} and filed it under them`);
      setPickerFor(null);
      onChanged?.();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusyTxn(null);
    }
  };

  // A patch write - `set_bank_txn_review` sends only the column named, so
  // confirming a method here cannot re-stamp category or the reviewed flag.
  const confirmMethod = async (row: Row, value: string) => {
    setBusyTxn(row.txn_id);
    try {
      await api.setBankTxnReview(row.txn_id, { confirmed_method: value });
      onChanged?.();
    } catch (e: any) {
      toast(String(e), "error");
    } finally {
      setBusyTxn(null);
    }
  };

  const read = useMemo(
    () => (payments as Row[]).map((r) => ({ r, m: readMethod(r) })),
    [payments],
  );

  // Counted over every row on this profile, which is exactly the set the facet
  // chooses from — so a number on the control is the number picking it produces.
  // `confirmed` counts the human's own column, NOT the `certain` state: a method
  // the bank itself supplied is certain and nobody confirmed it, so counting it
  // under "you confirmed" would put a false claim in the caption below.
  const counts = useMemo(() => {
    const total: Record<string, number> = {};
    const confirmed: Record<string, number> = {};
    let unclassified = 0;
    for (const { r, m } of read) {
      if (m.state === "unclassified") { unclassified += 1; continue; }
      total[m.method] = (total[m.method] || 0) + 1;
      if (r.confirmed_method) confirmed[m.method] = (confirmed[m.method] || 0) + 1;
    }
    return { total, confirmed, unclassified };
  }, [read]);

  const shown = useMemo(() => {
    if (method === "all") return read;
    return read.filter(({ m }) => (method === "unclassified" ? m.state === "unclassified" : m.method === method));
  }, [read, method]);

  // Three states, decided by the backend: it derives `deal_is_theirs` by joining
  // the allocation's deal back to this person. The deal id alone cannot answer
  // it — it only says the money is booked, not whose deal it is booked to.
  const booked = shown.filter(({ r }) => !!r.deal_flow_id && r.deal_is_theirs === true);
  const elsewhere = shown.filter(({ r }) => !!r.deal_flow_id && r.deal_is_theirs !== true);
  const tagOnly = shown.filter(({ r }) => !r.deal_flow_id);

  // The role this profile is the obvious side of — labelled on a row only when
  // it is something else, which is exactly when the reader would assume wrong.
  const ownRole = person.type === "supplier" ? "supplier_payment" : "buyer_payment";
  // One payment can be split across several deals. Where only part of it landed
  // on theirs, the row says how much, so the group's claim covers every row.
  const anySplit = booked.some(({ r }) => partlyBooked(r));

  // Booked is one group, but the deal's figures treat the roles in it two
  // different ways, so the caption makes two claims rather than one that fits
  // neither. Each row's role is printed on the row itself whenever it is not the
  // side this profile is obviously on, so the split is visible, not asserted.
  const nBuilds  = booked.filter(({ r }) => IN_DEAL_FIGURES.has(r.role || "")).length;
  const nRefunds = booked.filter(({ r }) => r.role === "refund_out").length;
  const nUnread  = booked.length - nBuilds - nRefunds;
  // A count only appears when the group really is mixed — "3 of these" with
  // nothing to count against reads as an error.
  const all = (n: number) => n === booked.length;
  const bookedCaption = [
    nBuilds > 0 &&
      (all(nBuilds)
        ? "Tied to one of their deals, and that deal's recorded revenue and cost are built from this money."
        : `${nBuilds} of these ${nBuilds === 1 ? "builds" : "build"} that deal's recorded revenue and cost.`),
    nRefunds > 0 &&
      `${all(nRefunds) ? (nRefunds === 1 ? "This is a refund" : "Every one is a refund") : `${nRefunds} ${nRefunds === 1 ? "is a refund" : "are refunds"}`} back to the buyer: booked to the deal and counted in its refund total, but never in its recorded profit — that figure is taken before refunds, and the refund comes off revenue instead.`,
    nUnread > 0 &&
      `${all(nUnread) ? (nUnread === 1 ? "This carries a role" : "Every one carries a role") : `${nUnread} ${nUnread === 1 ? "carries a role" : "carry a role"}`} no deal figure reads, so no deal total counts ${nUnread === 1 ? "it" : "them"}.`,
    anySplit &&
      "A payment split across deals says how much of it landed on theirs; the total counts the whole payment.",
  ].filter(Boolean).join(" ");

  const heading = <p className="text-[12.5px] font-medium text-muted">Bank payments</p>;

  if (payments.length === 0) {
    return (
      <div className="space-y-2">
        {heading}
        <div className="bg-surface-2 border border-line rounded-lg px-3 py-3">
          <p className="text-[12px] text-ink-2">No bank payment is linked to {person.name} yet.</p>
          <p className="text-[11.5px] text-faint mt-1 leading-relaxed">
            Two things put one here: booking a transaction to one of their deals, or linking a
            transaction straight to them in Financials. Neither has happened for them yet.
          </p>
          <button onClick={() => openFinancials()} className={`${linkCls} mt-2`}>
            Open Financials <ArrowRight size={12} />
          </button>
        </div>
      </div>
    );
  }

  const methodOptions = METHODS.filter((m) => (counts.total[m.value] || 0) > 0 || method === m.value);
  const showFacet = methodOptions.length + (counts.unclassified > 0 ? 1 : 0) >= 2;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {heading}
        {showFacet && (
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as any)}
            aria-label="Payment method"
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All methods</option>
            {methodOptions.map((m) => (
              <option key={m.value} value={m.value}>{m.label} · {counts.total[m.value] || 0}</option>
            ))}
            <option value="unclassified">No method read · {counts.unclassified}</option>
          </select>
        )}
      </div>

      {/* What the facet is NOT showing. A heuristic filter that quietly drops
          what it could not read is a filter that lies. The second figure is
          worded "not confirmed" rather than "read off the memo" because it covers
          three different origins — a memo match, the statement importer's stored
          `rail`, and a method the bank itself supplied — and a caption has to be
          true for every row it counts. */}
      {method !== "all" && (
        <p className="text-[11.5px] text-muted leading-relaxed">
          {method === "unclassified" ? (
            <>
              <span className="text-ink font-medium tabular-nums">{counts.unclassified}</span>{" "}
              of their payments carry no method the memo could name. Set one on the row in Financials and it sticks.
            </>
          ) : (
            <>
              Showing <span className="text-ink font-medium tabular-nums">{counts.total[method] || 0}</span>{" "}
              {methodLabel(method).toLowerCase()} — <span className="tabular-nums">{counts.confirmed[method] || 0}</span>{" "}
              you confirmed, <span className="tabular-nums">{(counts.total[method] || 0) - (counts.confirmed[method] || 0)}</span>{" "}
              not confirmed.{" "}
              <span className="tabular-nums">{counts.unclassified}</span> could not be read and are not in this list.{" "}
              <button onClick={() => setMethod("unclassified")} className="font-medium text-accent hover:text-accent-hover transition-colors">
                Show them
              </button>
            </>
          )}
        </p>
      )}

      <Group
        title="Booked to their deals"
        caption={bookedCaption}
        rows={booked}
        empty={method === "all" ? "None of their payments are booked to one of their deals." : "None under this method."}
        showClient={person.type === "supplier"}
        showTaggedBadge
        ownRole={ownRole}
        onUntag={onUntag}
        onPick={people ? (r) => setPickerFor(r) : undefined}
        onMethod={confirmMethod}
        busyTxn={busyTxn}
      />

      {/* Only when there is one. It is the anomaly bucket — a payment tagged to
          this person that the money itself says belongs to another deal — so it
          appears when it exists and stays out of the way when it does not. */}
      {elsewhere.length > 0 && (
        <div className="pt-3 mt-3 border-t border-line-2">
          <Group
            title="Booked to someone else's deal — worth a look"
            caption={`Filed under ${person.name}, but booked to a deal that does not list them. One of the two is wrong: either the payment belongs to somebody else (change who it is filed under), or the deal is missing them. It counts on that deal — none of it counts here.`}
            rows={elsewhere}
            empty="None under this method."
            showClient
            ownRole={ownRole}
        onUntag={onUntag}
        onPick={people ? (r) => setPickerFor(r) : undefined}
        onMethod={confirmMethod}
        busyTxn={busyTxn}
          />
        </div>
      )}

      <div className="pt-3 mt-3 border-t border-line-2">
        <Group
          title="Tagged to them only"
          caption="Says whose money it is. It is not booked to any deal, so no deal counts it."
          rows={tagOnly}
          empty={method === "all" ? "Nothing is tagged to them outside their deals." : "None under this method."}
          showClient={person.type === "supplier"}
          ownRole={ownRole}
        onUntag={onUntag}
        onPick={people ? (r) => setPickerFor(r) : undefined}
        onMethod={confirmMethod}
        busyTxn={busyTxn}
        />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <button
          onClick={() => openFinancials(person)}
          title={`Opens the ledger filtered to ${person.name}, with every other filter opened up`}
          className={linkCls}
        >
          See all in Financials <ArrowRight size={12} />
        </button>
        {payments.length >= 100 && (
          <span className="text-[11px] text-faint">Their 100 most recent — older ones are in Financials.</span>
        )}
      </div>

      {pickerFor && people && (
        <PersonPickerModal
          txn={{ direction: pickerFor.direction, amount: pickerFor.amount, posted_at: pickerFor.posted_at }}
          people={people}
          candidates={[]}
          current={pickerFor.tagged ? { type: person.type, id: person.id, name: person.name } : null}
          busy={busyTxn === pickerFor.txn_id}
          onClose={() => setPickerFor(null)}
          onPick={(to) => retag(pickerFor, to)}
          onCreate={(name) => createAndRetag(pickerFor, name)}
          createLabel={pickerFor.direction === "in" ? "Add a new client" : "Add a new supplier"}
        />
      )}
    </div>
  );
}

function Group({ title, caption, rows, empty, showClient, showTaggedBadge, ownRole, onUntag,
                 onPick, onMethod, busyTxn }: {
  title: string;
  caption: string;
  rows: { r: Row; m: MethodRead }[];
  empty: string;
  showClient: boolean;
  showTaggedBadge?: boolean;
  ownRole: string;
  onUntag: (txnId: string) => void;
  /** Undefined when the caller has not supplied the people list - the control
   *  is then not rendered at all rather than rendered dead. */
  onPick?: (r: Row) => void;
  onMethod: (r: Row, value: string) => void;
  busyTxn: string | null;
}) {
  const t = totalsOf(rows.map((x) => x.r));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
        <span className="text-[12.5px] font-semibold text-ink">{title}</span>
        <span className="text-[11.5px] text-muted tabular-nums">{totalsLabel(t)}</span>
      </div>
      {/* An empty group has no claim to make — the caption is now assembled from
          the roles actually present, so it can legitimately come back blank. */}
      {caption && <p className="text-[11px] text-faint mb-1.5 leading-relaxed">{caption}</p>}
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-faint bg-surface-2 border border-line rounded-lg px-3 py-2.5">{empty}</p>
      ) : (
        <div className="border border-line rounded-lg divide-y divide-line-2 overflow-hidden max-h-[360px] overflow-y-auto">
          {rows.map(({ r, m }) => (
            <div key={r.txn_id} className={`flex items-start justify-between gap-3 px-3 py-2.5 ${busyTxn === r.txn_id ? "opacity-50" : ""}`}>
              <div className="min-w-0">
                <div className="text-[12px] text-ink-2 truncate" title={r.description || undefined}>
                  {r.description || r.counterparty_name || "Bank transaction"}
                  {showTaggedBadge && r.tagged && (
                    <span className="ml-1.5 inline-block align-middle text-[9.5px] font-semibold text-accent border border-accent/30 bg-accent/5 rounded px-1 py-px">Tagged</span>
                  )}
                  {r.tagged && (
                    <button
                      onClick={() => onUntag(r.txn_id)}
                      title="Remove this link — the payment itself stays exactly as it is"
                      className="ml-1 inline-flex align-middle items-center justify-center w-4 h-4 rounded text-faint hover:text-ink-2 hover:bg-surface-2 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-muted tabular-nums">
                  {dayLabel(r.posted_at)}
                  {r.invoice_number ? ` · #${r.invoice_number}` : ""}
                  {/* Only when it is not the side this profile is obviously on —
                      a refund or a fee reads as an ordinary payment otherwise. */}
                  {r.role && r.role !== ownRole ? ` · ${roleLabel(r.role)}` : ""}
                  {showClient && r.client_name ? ` · ${r.client_name}` : ""}
                  {partlyBooked(r) ? ` · ${fmtAmount(r.booked_amount as number)} of it on their deals` : ""}
                  {" · "}
                  {/* Editable in place. A method the memo only suggests stays
                      visibly unconfirmed until Jack picks one, so a guess and an
                      answer never look the same. */}
                  <select
                    value={r.confirmed_method || ""}
                    onChange={(e) => onMethod(r, e.target.value)}
                    disabled={busyTxn === r.txn_id}
                    aria-label="Payment method"
                    title={r.confirmed_method ? "You confirmed this method" : m.reason || "Set the payment method"}
                    className={`bg-transparent border-none p-0 text-[11px] cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/40 rounded ${
                      r.confirmed_method ? "text-muted" : "text-faint italic"
                    }`}
                  >
                    <option value="">{m.method ? `${methodLabel(m.method)}?` : "No method"}</option>
                    {METHODS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className={`text-[12.5px] font-semibold tabular-nums ${r.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
                  {r.direction === "in" ? "+" : "−"}{fmtAmount(r.amount)}
                </div>
                <div className="flex items-center justify-end gap-0.5 mt-1">
                  {onPick && (
                    <button
                      onClick={() => onPick(r)}
                      disabled={busyTxn === r.txn_id}
                      title="File this payment under someone else"
                      aria-label="File this payment under someone else"
                      className="w-5 h-5 inline-flex items-center justify-center rounded text-faint hover:text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors"
                    >
                      <UserCog size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => openTxn(r.txn_id)}
                    title="Open this transaction in Financials"
                    aria-label="Open this transaction in Financials"
                    className="w-5 h-5 inline-flex items-center justify-center rounded text-faint hover:text-ink-2 hover:bg-surface-2 transition-colors"
                  >
                    <ArrowRight size={11} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
