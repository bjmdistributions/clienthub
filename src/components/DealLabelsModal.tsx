import { useEffect, useMemo, useRef, useState } from "react";
import { X, Check, Search, Loader2 } from "lucide-react";
import { api, DealLabel, DealLabelInput, DealLabelList, LabelFrom } from "../lib/api";
import { fmtAmount, parseLocalDay } from "../lib/format";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-402: where Jack gives every closed deal one category and one brand. What he sets is
// stored on the deal (deal_flows.category / .brand) and teaches the guesses for every deal
// he has not set (src-tauri/src/deal_label.rs), so the list is re-read after each save and
// other rows can change their guess while he works. The phone has the same screen
// (clienthub-api/www/app.js, anOpenLabels).

type Filter = "look" | "uncategorized" | "unbranded" | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "look", label: "Needs a look" },
  { id: "uncategorized", label: "Uncategorized" },
  { id: "unbranded", label: "No brand" },
  { id: "all", label: "All" },
];
const GUESSED = (f: LabelFrom) => f === "learned" || f === "reader" || f === "buyer";
// R-410: a deal needs a look while its category is not one you set, or its brand is a guess
// waiting for you. A brand nobody could read ("Nothing to go on yet") does not keep a deal
// here forever; it lives under No brand. Before this the list could never reach zero.
const needsLook = (d: DealLabel) => d.category_from !== "you" || GUESSED(d.brand_from);
const PAGE = 60;

export interface LabelFocus { kind: "category" | "brand"; name: string }

export default function DealLabelsModal({ focus, onClose }: {
  /** Open on the deals in one row of a card, e.g. everything counted as Uncategorized. */
  focus: LabelFocus | null;
  /** `changed` is true when anything was saved, so the cards behind re-read. */
  onClose: (changed: boolean) => void;
}) {
  const [data, setData] = useState<DealLabelList | null>(null);
  const [filter, setFilter] = useState<Filter>(focus ? "all" : "look");
  const [only, setOnly] = useState<LabelFocus | null>(focus);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [changed, setChanged] = useState(false);

  const load = () => api.listDealLabels().then(setData).catch((e) => toast(String(e), "error"));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(changed); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changed, onClose]);

  const rows = useMemo(() => {
    const all = data?.deals ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((d) => {
      if (only && (only.kind === "category" ? d.category : d.brand) !== only.name) return false;
      if (filter === "look" && !needsLook(d)) return false;
      if (filter === "uncategorized" && d.category_from !== "") return false;
      if (filter === "unbranded" && d.brand_from !== "") return false;
      if (!needle) return true;
      return [d.number, d.buyer, d.category, d.brand, ...d.products].some((s) => s.toLowerCase().includes(needle));
    });
  }, [data, filter, only, q]);

  // Only the rows on screen: the button says "shown", and a guess nobody has seen must not
  // become a label that then teaches every other deal (R-410).
  const guesses: DealLabelInput[] = useMemo(() => rows.slice(0, shown).flatMap((d) => {
    const it: DealLabelInput = { id: d.id };
    if (GUESSED(d.category_from)) it.category = d.category;
    if (GUESSED(d.brand_from)) it.brand = d.brand;
    return it.category !== undefined || it.brand !== undefined ? [it] : [];
  }), [rows, shown]);

  // Saves run one after another, and the boxes stay live while they do (R-410): disabling
  // them dropped keyboard focus after every save, so type-and-Enter needed the mouse. `then`
  // runs once the list has been re-read, which is how Enter moves on to the next deal.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [saving, setSaving] = useState(0);
  const busy = saving > 0;
  const save = (items: DealLabelInput[], note?: string, then?: () => void) => {
    if (items.length === 0) return;
    setSaving((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        await api.setDealLabels(items);
        setChanged(true);
        await load();
        if (note) toast(note);
        if (then) setTimeout(then, 0);
      } catch (e) {
        toast(String(e), "error");
      }
      setSaving((n) => n - 1);
    });
  };

  const count = (f: Filter) => (data?.deals ?? []).filter((d) =>
    f === "look" ? needsLook(d)
    : f === "uncategorized" ? d.category_from === ""
    : f === "unbranded" ? d.brand_from === ""
    : true).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => onClose(changed)} />

      <div className="relative w-[94vw] max-w-[1120px] max-h-[88vh] flex flex-col rounded-2xl bg-surface border border-line shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-line">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-ink">Identify categories and brands</h3>
            <p className="text-[12px] text-muted mt-0.5">
              One category and one brand for every closed deal. What you set here teaches the guesses for the rest.
            </p>
          </div>
          <button onClick={() => onClose(changed)} aria-label="Close"
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-line-2">
          <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-0.5">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => { setFilter(f.id); setShown(PAGE); }}
                className={`px-2.5 h-7 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${
                  filter === f.id ? "bg-surface text-ink ring-1 ring-line" : "text-muted hover:text-ink-2"}`}>
                {f.label} <span className="tabular-nums text-faint">{data ? count(f.id) : ""}</span>
              </button>
            ))}
          </div>
          {only && (
            <button onClick={() => setOnly(null)}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg ring-1 ring-line text-[12px] text-ink-2 hover:bg-surface-2">
              {only.kind === "category" ? "Category" : "Brand"}: {only.name}
              <X size={12} className="text-muted" />
            </button>
          )}
          <div className="relative flex-1 min-w-[180px] max-w-[320px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
              placeholder="Search buyer, invoice or product"
              className="w-full ring-1 ring-line bg-surface h-8 pl-8 pr-2 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-accent/40" />
          </div>
          <div className="flex-1" />
          {busy && <Loader2 size={14} className="animate-spin text-muted" />}
          {guesses.length > 0 && (
            <button disabled={busy}
              onClick={() => save(guesses, `Confirmed ${guesses.length} deal${guesses.length !== 1 ? "s" : ""}`)}
              className="h-8 px-3 rounded-lg bg-accent text-on-accent text-[12px] font-medium disabled:opacity-40 hover:bg-accent-hover transition-colors">
              Accept {guesses.length} guess{guesses.length !== 1 ? "es" : ""} shown
            </button>
          )}
        </div>

        <datalist id="r402-categories">{(data?.categories ?? []).map((c) => <option key={c} value={c} />)}</datalist>
        <datalist id="r402-brands">{(data?.brands ?? []).map((b) => <option key={b} value={b} />)}</datalist>

        <div className="flex-1 overflow-y-auto">
          {!data ? (
            <div className="px-6 py-16 text-center text-[13px] text-muted">Reading your deals</div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-[13px] text-muted">
              {filter === "look" ? "Nothing needs a look. Every deal has a category you set and no brand guess waiting." : "No deals match."}
            </div>
          ) : (
            <div className="divide-y divide-line-2">
              <div className="grid grid-cols-[minmax(0,1fr)_220px_200px] gap-4 px-6 py-2 sticky top-0 z-[1] bg-surface-2/80 backdrop-blur-sm text-[11px] font-medium text-muted">
                <div>Deal</div><div>Category</div><div>Brand</div>
              </div>
              {rows.slice(0, shown).map((d, i, list) => (
                <Row key={d.id} d={d} next={list[i + 1]?.id ?? null}
                  onSave={(it, note, then) => save([{ id: d.id, ...it }], note, then)} />
              ))}
              {rows.length > shown && (
                <div className="px-6 py-3">
                  <button onClick={() => setShown(rows.length)} className="text-[12px] font-medium text-accent hover:underline">
                    Show all {rows.length} deals
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Enter in a box moves to the same box on the next deal once the save has landed.
const focusBox = (deal: string | null, kind: string) => {
  if (!deal) return;
  document.querySelector<HTMLInputElement>(`input[data-deal="${CSS.escape(deal)}"][data-kind="${kind}"]`)?.focus();
};

function Row({ d, next, onSave }: {
  d: DealLabel; next: string | null;
  onSave: (it: Omit<DealLabelInput, "id">, note?: string, then?: () => void) => void;
}) {
  const day = d.day ? parseLocalDay(d.day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_220px_200px] gap-4 px-6 py-3.5 items-start">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[13px] font-medium text-ink truncate">{d.buyer || "No buyer"}</span>
          <span className="text-[11px] text-faint whitespace-nowrap">{d.number}{day ? ` · ${day}` : ""}</span>
        </div>
        <div className="text-[12px] text-ink-2 mt-0.5 truncate" title={d.products.join("\n")}>
          {d.products.length ? d.products.slice(0, 2).join(", ") : "No product lines on the invoice"}
          {d.products.length > 2 ? `, and ${d.products.length - 2} more` : ""}
        </div>
        <div className="text-[11px] text-muted mt-0.5 tabular-nums">
          {fmtAmount(d.revenue)} revenue · {d.profit < 0 ? "−" + fmtAmount(Math.abs(d.profit)) : fmtAmount(d.profit)} profit
        </div>
      </div>
      <LabelField deal={d.id} kind="category" value={d.category} from={d.category_from} why={d.category_why}
        list="r402-categories" empty="Uncategorized" onNext={() => focusBox(next, "category")}
        onSave={(v, note, advance) => onSave({ category: v }, note, advance ? () => focusBox(next, "category") : undefined)} />
      <LabelField deal={d.id} kind="brand" value={d.brand} from={d.brand_from} why={d.brand_why}
        list="r402-brands" empty="No brand" onNext={() => focusBox(next, "brand")}
        onSave={(v, note, advance) => onSave({ brand: v }, note, advance ? () => focusBox(next, "brand") : undefined)} />
    </div>
  );
}

// One label. A guess sits in the box ready to accept (the tick, or Enter); typing another
// name and pressing Enter or leaving the box sets that instead. Leaving an unchanged guess
// does NOT accept it, so tabbing through the list changes nothing. Enter also moves to the
// same box on the next deal.
function LabelField({ deal, kind, value, from, why, list, empty, onSave, onNext }: {
  deal: string; kind: "category" | "brand"; value: string; from: LabelFrom; why: string; list: string; empty: string;
  onSave: (v: string, note?: string, advance?: boolean) => void;
  onNext: () => void;
}) {
  const current = from === "" ? "" : value;
  const [draft, setDraft] = useState(current);
  // What this box last sent: Enter saves, and the blur that follows must not send it again
  // before the re-read lands.
  const sent = useRef<string | null>(null);
  useEffect(() => { setDraft(current); sent.current = null; }, [current]);
  const guessed = GUESSED(from);
  const commit = (accept: boolean) => {
    const v = draft.trim();
    if (!v) { setDraft(current); return; }
    if (v === sent.current) return;
    if (v === current && !(accept && guessed)) { if (accept) onNext(); return; }
    sent.current = v;
    onSave(v, undefined, accept);
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <input value={draft} list={list} placeholder={empty} data-deal={deal} data-kind={kind}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(true); } }}
          onBlur={() => commit(false)}
          className={`w-full min-w-0 ring-1 bg-surface h-8 px-2.5 rounded-lg text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent/40 ${
            guessed && draft === current ? "ring-line/70 text-muted" : "ring-line text-ink"}`} />
        {guessed && (
          <button onClick={() => onSave(value)} title="Accept this guess" aria-label="Accept this guess"
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg ring-1 ring-line text-success-ink hover:bg-success-bg disabled:opacity-40 transition-colors">
            <Check size={14} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-1 min-w-0">
        {from === "you" ? (
          <>
            <span className="text-[11px] text-faint">Set by you</span>
            <button onClick={() => onSave("", "Cleared. It will be guessed again.")}
              className="text-[11px] text-muted hover:text-ink-2 hover:underline">Clear</button>
          </>
        ) : guessed ? (
          <>
            <StatusPill tone="accent">Guessed</StatusPill>
            <span className="text-[11px] text-faint truncate" title={why}>{why}</span>
          </>
        ) : (
          <span className="text-[11px] text-faint">Nothing to go on yet</span>
        )}
      </div>
    </div>
  );
}
