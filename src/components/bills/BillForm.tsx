// R-449: add or edit a bill. The part that matters is "Shows in the bank as": every word typed
// there must appear in the payee or description of a payment, and the preview under it lists
// the payments that would match right now, so a typo shows up before the bill is saved.
import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, Upload, X } from "lucide-react";
import NumberInput from "../NumberInput";
import { CATEGORIES, catLabel } from "../FinancialsView";
import { fmtAmount } from "../../lib/format";
import { billsApi, type BillFields, type BillOut, type Cadence, type PreviewTxn } from "../../lib/billsApi";
import { CADENCE_OPTIONS, METHOD_OPTIONS, shortDay } from "../../lib/billsFormat";
import { resizeLogo } from "../../lib/logoImage";
import { BillLogo, btn, inp, pri } from "./ui";

/** The groups a bill's category is picked from: money that leaves the business on a schedule. */
const GROUPS = ["Operating expenses", "Taxes & licences", "Cost of goods"];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Draft {
  name: string;
  payee_match: string;
  amount: number;
  varies: boolean;
  tolerance_pct: number;
  cadence: Cadence;
  anchor_date: string;
  category: string;
  method: string;
  website: string;
  logo: string;
  notes: string;
}

function draftOf(bill: BillOut | undefined, seed: Partial<BillFields> | undefined): Draft {
  const s = { ...(bill || {}), ...(seed || {}) } as Partial<BillFields>;
  return {
    name: s.name ?? "",
    payee_match: s.payee_match ?? "",
    amount: s.amount ?? 0,
    // A saved bill with no amount varies; a brand new one starts with an amount to fill in.
    varies: bill ? (s.amount ?? 0) <= 0 : false,
    tolerance_pct: s.tolerance_pct ?? 10,
    cadence: (s.cadence as Cadence) ?? "monthly",
    anchor_date: s.anchor_date ?? "",
    category: s.category ?? "",
    method: s.method ?? "",
    website: s.website ?? "",
    logo: s.logo ?? "",
    notes: s.notes ?? "",
  };
}

export default function BillForm({ bill, seed, onClose, onSaved }: {
  /** The bill being edited; absent when adding. */
  bill?: BillOut;
  /** Values to start an added bill from (a suggestion from the bank). */
  seed?: Partial<BillFields>;
  onClose: () => void;
  onSaved: (linked: number, bill: BillOut) => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(bill, seed));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoErr, setLogoErr] = useState("");
  const [pv, setPv] = useState<{ count: number; txns: PreviewTxn[] } | null>(null);
  const [pvBusy, setPvBusy] = useState(false);
  const seq = useRef(0);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // The live preview: what the words and amount match today. Debounced, and an answer that
  // arrives after a newer keystroke is dropped.
  const text = (d.payee_match || d.name).trim();
  useEffect(() => {
    const id = ++seq.current;
    if (!text) { setPv(null); setPvBusy(false); return; }
    setPvBusy(true);
    const t = setTimeout(() => {
      billsApi.preview(text, d.varies ? 0 : d.amount, d.tolerance_pct)
        .then((r) => { if (id === seq.current) setPv(r); })
        .catch(() => { if (id === seq.current) setPv(null); })
        .finally(() => { if (id === seq.current) setPvBusy(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [text, d.amount, d.varies, d.tolerance_pct]);

  const options = useMemo(() => {
    const inGroups = CATEGORIES.filter((c) => !c.hidden && GROUPS.includes(c.group));
    const known = d.category === "" || inGroups.some((c) => c.value === d.category);
    return { inGroups, extra: known ? null : d.category };
  }, [d.category]);

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setLogoBusy(true); setLogoErr("");
    try { set({ logo: await resizeLogo(f) }); } catch (x) { setLogoErr(msg(x)); } finally { setLogoBusy(false); }
  };

  const useIcon = async () => {
    setLogoBusy(true); setLogoErr("");
    try { set({ logo: await resizeLogo(await billsApi.icon(d.website.trim())) }); } catch (x) { setLogoErr(msg(x)); } finally { setLogoBusy(false); }
  };

  const submit = async () => {
    const amount = d.varies ? 0 : d.amount;
    if (!d.name.trim()) return setError("Give the bill a name.");
    if (!d.anchor_date) return setError("Pick the first due date. Later dates follow from it.");
    if (!d.varies && !(amount > 0)) return setError("Enter the amount, or tick Amount varies.");
    if (!(d.tolerance_pct >= 1 && d.tolerance_pct <= 50)) return setError("The amount band is a percentage from 1 to 50.");
    const all: BillFields = {
      name: d.name.trim(),
      payee_match: (d.payee_match || d.name).trim(),
      amount,
      tolerance_pct: d.tolerance_pct,
      cadence: d.cadence,
      anchor_date: d.anchor_date,
      category: d.category,
      method: d.method as BillFields["method"],
      website: d.website.trim(),
      logo: d.logo,
      notes: d.notes.trim(),
    };
    // An edit sends only what changed, so a 30 KB logo is not sent again for a date change.
    const fields: Partial<BillFields> = bill
      ? Object.fromEntries((Object.keys(all) as (keyof BillFields)[]).filter((k) => all[k] !== bill[k]).map((k) => [k, all[k]]))
      : all;
    if (bill && Object.keys(fields).length === 0) return onClose();
    setBusy(true); setError("");
    try {
      const r = await billsApi.save(bill?.id ?? null, fields);
      onSaved(r.linked, r.bill);
    } catch (x) {
      setError(msg(x));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      {/* No click-away or Escape: this form is long, and a stray click should not lose it. */}
      <div className="bg-surface border border-line rounded-2xl w-full max-w-xl p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-ink">{bill ? "Edit bill" : "Add a bill"}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink p-0.5" aria-label="Close"><X size={15} /></button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-[12px] text-muted">Name</span>
            <input className={inp} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Warehouse rent" autoFocus />
          </label>

          <div>
            <label className="block">
              <span className="text-[12px] text-muted">Shows in the bank as</span>
              <input className={inp} value={d.payee_match} onChange={(e) => set({ payee_match: e.target.value })}
                placeholder={d.name ? `Defaults to ${d.name}` : "Words from the payee, like oak street"} />
            </label>
            <p className="text-[11px] text-muted mt-1">Every word you type has to appear in the payee or description of the payment.</p>
            <Preview text={text} pv={pv} busy={pvBusy} />
          </div>

          <div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[12px] text-muted">Amount</span>
                <NumberInput className={inp + (d.varies ? " opacity-50" : "")} value={d.varies ? "" : d.amount || ""} disabled={d.varies}
                  placeholder={d.varies ? "Varies" : "2,400.00"} onValue={(n) => set({ amount: n })} />
              </label>
              <label className="block">
                <span className="text-[12px] text-muted">Close enough, within</span>
                <div className="relative">
                  <NumberInput className={inp + " pr-8" + (d.varies ? " opacity-50" : "")} value={d.tolerance_pct} disabled={d.varies}
                    onValue={(n) => set({ tolerance_pct: n })} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted">%</span>
                </div>
              </label>
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2 mt-2 cursor-pointer select-none">
              <input type="checkbox" checked={d.varies} onChange={(e) => set({ varies: e.target.checked })} /> Amount varies
              <span className="text-muted">(a utility bill, say; only the words and the date are checked)</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[12px] text-muted">How often</span>
              <select className={inp} value={d.cadence} onChange={(e) => set({ cadence: e.target.value as Cadence })}>
                {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] text-muted">First due date</span>
              <input type="date" className={inp} value={d.anchor_date} onChange={(e) => set({ anchor_date: e.target.value })} />
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[12px] text-muted">Category</span>
              <select className={inp} value={d.category} onChange={(e) => set({ category: e.target.value })}>
                <option value="">No category</option>
                {options.extra && <option value={options.extra}>{catLabel(options.extra)}</option>}
                {GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {options.inGroups.filter((c) => c.group === g).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] text-muted">Paid by</span>
              <select className={inp} value={d.method} onChange={(e) => set({ method: e.target.value })}>
                {METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <div>
            <span className="text-[12px] text-muted">Website</span>
            <div className="flex gap-2 mt-0.5">
              <input className={inp} value={d.website} onChange={(e) => set({ website: e.target.value })} placeholder="oakstreet.example.com" />
              <button type="button" onClick={useIcon} disabled={!d.website.trim() || logoBusy} className={btn + " h-9"}>
                <Globe size={13} /> Use the website's icon
              </button>
            </div>
          </div>

          <div>
            <span className="text-[12px] text-muted">Logo</span>
            <div className="flex items-center gap-3 mt-1">
              <BillLogo name={d.name || "Bill"} logo={d.logo} size={56} />
              <div className="flex items-center gap-2 flex-wrap">
                <label className={btn + " cursor-pointer " + (logoBusy ? "opacity-50 pointer-events-none" : "")}>
                  <Upload size={12} /> {logoBusy ? "Working" : "Upload a logo"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pickFile} />
                </label>
                {d.logo && <button type="button" onClick={() => set({ logo: "" })} className="text-[12px] text-muted hover:text-danger-ink">Remove</button>}
              </div>
            </div>
            {logoErr ? <p className="text-[11.5px] text-danger-ink mt-1.5">{logoErr}</p>
              : !d.logo && <p className="text-[11px] text-muted mt-1.5">Without a logo the bill shows its initials.</p>}
          </div>

          <label className="block">
            <span className="text-[12px] text-muted">Notes</span>
            <textarea className={inp + " h-20 py-2 resize-y"} value={d.notes} onChange={(e) => set({ notes: e.target.value })}
              placeholder="Account number, who to call, when the lease ends." />
          </label>
        </div>

        {error && <div className="mt-4 text-[12.5px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className={btn + " h-9"}>Cancel</button>
          <button onClick={submit} disabled={busy} className={pri}>{busy ? "Saving" : bill ? "Save changes" : "Add bill"}</button>
        </div>
      </div>
    </div>
  );
}

function Preview({ text, pv, busy }: { text: string; pv: { count: number; txns: PreviewTxn[] } | null; busy: boolean }) {
  if (!text) return null;
  return (
    <div className="mt-2 border border-line-2 rounded-lg bg-surface-2/50">
      <div className="px-3 py-2 text-[12px] text-ink-2">
        {pv == null
          ? (busy ? "Checking your bank..." : "Could not check the bank just now.")
          : pv.count === 0
            ? "Matches no payments yet. Check the spelling, or loosen the amount."
            : `Matches ${pv.count} payment${pv.count === 1 ? "" : "s"}`}
      </div>
      {pv && pv.txns.length > 0 && (
        <div className="divide-y divide-line-2 border-t border-line-2">
          {pv.txns.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-3 py-1.5 text-[12px] min-w-0">
              <span className="text-muted w-14 flex-shrink-0 tabular-nums">{shortDay(t.posted_at.slice(0, 10))}</span>
              <span className="text-ink truncate flex-1 min-w-0">{t.payee}</span>
              <span className="text-ink-2 tabular-nums flex-shrink-0">{fmtAmount(t.amount)}</span>
            </div>
          ))}
          {pv.count > pv.txns.length && (
            <div className="px-3 py-1.5 text-[11px] text-muted">and {pv.count - pv.txns.length} more</div>
          )}
        </div>
      )}
    </div>
  );
}
