import { useCallback, useEffect, useState } from "react";
import { api, BankDeclined, NearDupPair, RetractedRow } from "../lib/api";
import { fmtAmount } from "../lib/format";
import { useSessionMe } from "../lib/useSessionMe";
import { toast } from "./Toast";
import { Button } from "./ui";

// R-670 (Jack, 2026-11-18: "the view for looking at 2 payments looking alike or retracted transactions are still too
// complicated and not clean"). One list for everything about the bank feed that needs a person, in place of three
// panels with three layouts (Likely duplicates, Retracted by bank, Not imported). Check against bank now settles what
// the bank's own list can settle, so what reaches this list is only what is a judgement. Every item is the same shape:
// one question, the transactions it is about, and at most two answers.

export interface NeedLine { tag: string; date: string; description: string; amount?: number; note?: string }
export interface NeedAnswer { id: string; label: string; primary?: boolean; confirm?: boolean }
export interface Need {
  key: string;
  kind: "pair" | "retracted" | "declined";
  question: string;
  detail: string;
  lines: NeedLine[];
  answers: NeedAnswer[];
  /** Why an answer is not offered, in plain words. */
  blocked?: string;
}

const day = (d: string) =>
  /^\d{4}-\d\d-\d\d/.test(d) ? new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : d;
const money = (amount: number, direction: string) => `${fmtAmount(amount)} ${direction === "in" ? "in" : "out"}`;
const bookedAs = (booked: boolean, category: string, links: string[] = []) =>
  links.length ? links.join(", ") : booked ? `Booked as ${(category || "reviewed").replace(/_/g, " ")}` : "Not booked";

const PAIR_WHY: Record<string, string> = {
  pending_and_posted: "One is still pending and the other has posted.",
  two_sources: "One came from a statement you imported and one from the bank feed.",
  two_connections: "They came through two bank connections.",
  different_text: "Same account and amount, a few days apart, with different names.",
};

const DECLINED: Record<string, { question: string; detail: string }> = {
  missing: { question: "Your bank lists this and your books do not", detail: "The books already hold a payment like it, so it was not brought in twice." },
  differs: { question: "Your bank shows this one differently", detail: "The bank's figures could not be used as they are." },
  not_at_bank: { question: "Your books have this and your bank does not list it", detail: "It is tied to a deal or a record, so it was not removed for you." },
  copy: { question: "The bank sent this and it looked like a copy", detail: "It matches a transaction already in your books, so it was not added." },
  held_reference: { question: "The bank sent this with a reference you already booked", detail: "It has the same payment reference as money already in your books." },
  change_unknown: { question: "The bank changed a transaction your books do not have", detail: "It was not added, because the original was never here." },
  statement_feed_twin: { question: "A statement line matches one from the bank feed", detail: "The same amount on the same account within a day, so it was not added twice." },
  feed_statement_twin: { question: "The bank sent this and a statement already has it", detail: "The same amount on the same account within a day, so it was not added twice." },
};

/** Everything that needs a person, in the order to answer it. Kept apart from the reads so it can be tested. */
export function needsYou(pairs: NearDupPair[], retracted: RetractedRow[], declined: BankDeclined[]): Need[] {
  const out: Need[] = [];
  for (const r of retracted) {
    // Waiting for the bank's posted copy needs nothing from a person yet.
    if (r.matches.length === 0 && !r.cancelled) continue;
    const lines: NeedLine[] = [{ tag: "Taken back", date: r.date, description: r.description, amount: r.amount, note: bookedAs(r.booked, r.category) }];
    for (const m of r.matches) lines.push({ tag: "Posted", date: m.date, description: m.description, amount: m.amount, note: bookedAs(m.booked, m.category) });
    const one = r.matches.length === 1 ? r.matches[0] : null;
    if (r.matches.length === 0) {
      out.push({
        key: `r:${r.id}`, kind: "retracted", question: "Your bank cancelled this charge",
        detail: `${money(r.amount, r.direction)} on ${r.account}. No posted charge replaced it within ten days, so the money did not move.`,
        lines, answers: [{ id: "remove", label: "Take it off the books", primary: true, confirm: true }],
      });
    } else {
      out.push({
        key: `r:${r.id}`, kind: "retracted", question: one ? "Is the posted charge the same payment?" : "Which posted charge is this payment?",
        detail: `${money(r.amount, r.direction)} on ${r.account}. Your bank took the first one back after you booked it.`,
        lines,
        answers: one
          ? [...(one.blocked ? [] : [{ id: `swap:${one.id}`, label: "Yes, move the booking", primary: true }]), { id: `not:${one.id}`, label: "No, different payments" }]
          : r.matches.filter((m) => !m.blocked).map((m, i) => ({ id: `swap:${m.id}`, label: `The one on ${day(m.date)}`, primary: i === 0 })),
        blocked: r.matches.find((m) => m.blocked)?.blocked ?? undefined,
      });
    }
  }
  for (const p of pairs) {
    out.push({
      key: `p:${p.keep.id}:${p.extra.id}`, kind: "pair", question: "One payment or two?",
      detail: `${money(p.keep.amount, p.keep.direction)} on ${p.keep.account}, ${p.gap_days ? `${p.gap_days} ${p.gap_days === 1 ? "day" : "days"} apart` : "the same day"}. ${PAIR_WHY[p.reason] ?? ""}`,
      lines: [p.keep, p.extra].map((x, i) => ({
        tag: i === 0 ? "First" : "Second", date: x.date, description: x.description,
        note: `${bookedAs(x.booked, x.category, x.links)}${x.pending ? " · pending" : ""}`,
      })),
      answers: [{ id: "same", label: "One payment", primary: true }, { id: "two", label: "Two payments" }],
    });
  }
  for (const d of declined) {
    if (d.status !== "open") continue;
    const text = DECLINED[d.reason] ?? DECLINED.missing;
    const removedBefore = d.reason === "missing" && !!d.bank.removed_before;
    const lines: NeedLine[] = d.reason === "differs" && d.bank.ledger
      ? [{ tag: "Your books", date: d.bank.ledger.posted_at, description: d.bank.ledger.description, amount: d.bank.ledger.amount },
         { tag: "Your bank", date: d.bank.posted_at ?? d.posted_at, description: d.bank.description ?? d.description, amount: d.bank.amount ?? d.amount }]
      : [{ tag: d.reason === "not_at_bank" ? "Your books" : "Your bank", date: d.posted_at, description: d.description, amount: d.amount }];
    const answers: NeedAnswer[] = d.reason === "differs"
      ? [{ id: "use_bank", label: "Use the bank's", primary: true }, { id: "keep", label: "Keep mine" }]
      : d.reason === "not_at_bank"
        ? [{ id: "remove", label: "Take it off the books", primary: true, confirm: true }, { id: "keep", label: "Keep it" }]
        : [{ id: "import", label: removedBefore ? "Bring it back" : "Bring it in", primary: true }, { id: "copy", label: removedBefore ? "Leave it out" : "It is already here" }];
    out.push({
      key: `d:${d.id}`, kind: "declined",
      question: removedBefore ? "You removed this and your bank still lists it" : text.question,
      detail: `${money(d.amount, d.direction)} on ${d.account_id}. ${removedBefore ? "It was not brought back for you." : text.detail}`,
      lines, answers,
    });
  }
  return out;
}

/** The three lists behind Needs you, read together. `reloadKey` re-reads them. */
export function useNeedsYou(reloadKey: unknown) {
  const [pairs, setPairs] = useState<NearDupPair[]>([]);
  const [retracted, setRetracted] = useState<RetractedRow[]>([]);
  const [declined, setDeclined] = useState<BankDeclined[]>([]);
  const reload = useCallback(() => {
    api.listNearDuplicates().then((v) => setPairs(v ?? [])).catch(() => setPairs([]));
    api.listRetracted().then((v) => setRetracted(v ?? [])).catch(() => setRetracted([]));
    api.listBankDeclined().then((v) => setDeclined(v?.rows ?? [])).catch(() => setDeclined([]));
  }, []);
  useEffect(() => { reload(); }, [reload, reloadKey]);
  return { pairs, retracted, declined, items: needsYou(pairs, retracted, declined), reload };
}

export default function NeedsYou({ data, onChanged }: { data: ReturnType<typeof useNeedsYou>; onChanged: () => void }) {
  const { pairs, retracted, declined, items, reload } = data;
  const me = useSessionMe();
  const [busy, setBusy] = useState("");
  const [armed, setArmed] = useState("");
  // A second, deliberate step some answers lead to: the books already hold the payment, or a deal is tied to the row.
  const [follow, setFollow] = useState<Record<string, { note: string; answers: NeedAnswer[] }>>({});

  const done = (msg: string) => { toast(msg, "success"); reload(); onChanged(); };
  const answer = async (n: Need, a: NeedAnswer) => {
    if (a.confirm && armed !== n.key + a.id) { setArmed(n.key + a.id); return; }
    setBusy(n.key); setArmed("");
    try {
      if (n.kind === "pair") {
        const p = pairs.find((x) => `p:${x.keep.id}:${x.extra.id}` === n.key);
        if (!p) return;
        const r = await api.resolveNearDuplicate(p.keep.id, p.extra.id, a.id === "same");
        if (a.id === "same" && r.over_allocated?.length) toast(`The copy is gone, and the payment now has more linked than its amount: ${r.over_allocated.join("; ")}.`, "error");
        done(a.id === "same" ? "Kept as one payment. The booking is on the one that stays." : "Kept as two payments.");
      } else if (n.kind === "retracted") {
        const r = retracted.find((x) => `r:${x.id}` === n.key);
        if (!r) return;
        const [what, id] = a.id.split(":");
        if (what === "swap") {
          const res = await api.takeOverBooking(r.id, id);
          if (res.over_allocated?.length) toast(`The booking moved. The posted amount is lower than what is linked: ${res.over_allocated.join("; ")}.`, "error");
          done("The booking is on the posted charge now.");
        } else if (what === "not") {
          await api.markTakeoverNotSame(r.id, id);
          done("Kept apart. That pair will not be asked about again.");
        } else {
          await api.removeCancelledTxn(r.id);
          done("Taken off the books. A copy was saved first.");
        }
      } else {
        const d = declined.find((x) => `d:${x.id}` === n.key);
        if (!d) return;
        const res = await api.resolveBankDeclined(d.id, a.id as Parameters<typeof api.resolveBankDeclined>[1], me?.display_name || me?.email || "");
        if (res.already) {
          setFollow({ ...follow, [n.key]: {
            note: `Your books already have one like it: ${day(res.already.posted_at)}, ${res.already.description}.`,
            answers: [{ id: "copy", label: "It is the same one", primary: true }, { id: "import_anyway", label: "Bring it in as a second payment" }],
          } });
          return;
        }
        const deals = (res.delete?.needs_unlink ?? []).flatMap((x) => x.deals);
        if (res.ok === false && deals.length) {
          setFollow({ ...follow, [n.key]: {
            note: `It is linked to ${deals.join(", ")}. Taking it off the books takes that money off the deal.`,
            answers: [{ id: "remove_unlink", label: "Take it off the deal too", primary: true, confirm: true }, { id: "keep", label: "Keep it" }],
          } });
          return;
        }
        if (res.ok === false) { toast("Nothing was changed. It is tied to a refund, loan, purchase or bill: move that link first.", "error"); return; }
        done(a.id === "keep" || a.id === "copy" ? "Left as it is." : a.id.startsWith("remove") ? "Taken off the books. A copy was saved first." : a.id === "use_bank" ? "Your books now show what the bank shows." : "Brought in. It is in To book.");
      }
    } catch (e: unknown) {
      toast(typeof e === "string" ? e : (e as Error)?.message || "That could not be saved", "error");
    } finally { setBusy(""); }
  };

  if (items.length === 0) {
    return (
      <div className="rounded-xl bg-surface-2 px-5 py-8 text-center">
        <div className="text-[15px] font-medium text-ink">Nothing needs you</div>
        <p className="ui-note mt-1">Every transaction your banks list is in your books, and nothing is waiting on an answer.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3 min-w-0">
      <p className="ui-note">
        {items.length === 1 ? "One thing" : `${items.length} things`} the app could not settle from your bank's list. Each answer is saved at once, and anything removed is backed up first.
      </p>
      {items.map((n) => {
        const f = follow[n.key];
        const answers = f?.answers ?? n.answers;
        return (
          <div key={n.key} className="rounded-xl ring-1 ring-line bg-surface p-4 min-w-0">
            <div className="text-[14px] font-medium text-ink">{n.question}</div>
            <div className="text-[12.5px] text-muted mt-0.5">{n.detail}</div>
            <div className="mt-3 rounded-lg bg-surface-2 px-3 divide-y divide-line-2">
              {n.lines.map((l, i) => (
                <div key={i} className="flex items-center gap-3 py-2 min-w-0 text-[12.5px]">
                  <span className="w-20 flex-shrink-0 text-muted">{l.tag}</span>
                  <span className="w-24 flex-shrink-0 text-ink-2 tabular-nums">{day(l.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-ink" title={l.description}>{l.description || "No description"}</span>
                  {l.note && <span className="hidden md:block w-56 flex-shrink-0 truncate text-muted text-right" title={l.note}>{l.note}</span>}
                  {l.amount !== undefined && <span className="w-24 flex-shrink-0 text-right tabular-nums text-ink">{fmtAmount(l.amount)}</span>}
                </div>
              ))}
            </div>
            {(f?.note || n.blocked) && <div className="mt-2 text-[12.5px] text-warning-ink">{f?.note ?? n.blocked}</div>}
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {answers.map((a) => {
                const isArmed = armed === n.key + a.id;
                return (
                  <Button key={a.id} size="sm" variant={isArmed ? "danger" : a.primary ? "ink" : "outline"} disabled={busy !== ""} onClick={() => answer(n, a)}>
                    {isArmed ? "Click again to confirm" : a.label}
                  </Button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
