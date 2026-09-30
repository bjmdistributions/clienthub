import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import {
  api, type LogisticsPayDate, type LogisticsPayMine, type LogisticsPaySettings, type LogisticsPayTracker,
  type LogisticsPayTrackerLine,
} from "../lib/api";
import { fmtAmount, localDay, parseLocalDay } from "../lib/format";
import { isLogisticsOnly } from "../lib/permissions";
import { describeSchedule, logisticsPayFor, WEEKDAYS } from "../lib/logisticsPay";
import NumberInput from "./NumberInput";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { fmtDay } from "./LogisticsBookingForm";

// R-401: everything the logistics pay puts on a screen. The rule is one setting the server
// owns, and every figure here is worked out there (the desktop's own copy of the rule only
// feeds the deal's Shipping section), so these components print what they are given and ask
// the server to change anything. Nothing here types an amount: a payment is recorded for a pay
// date and the server adds up what is due.

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60";
const REFRESH_MS = 30_000;

const METHODS = ["Zelle", "ACH", "Check", "Cash", "Other"];
const FREQUENCIES: { value: LogisticsPaySettings["frequency"]; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
];

const DEFAULTS: LogisticsPaySettings = {
  enabled: false, surplus_mode: "pay", payee_id: "", payee_name: "", share_pct: 100, cover_losses: true, loss_pay_pct: 0,
  frequency: "weekly", pay_weekday: 4, anchor_date: "", pay_day_of_month: 1, method: "", details: "",
};

const RULE_WORD: Record<string, string> = {
  share: "Share of the profit",
  loss_cover: "Loss covered",
  loss_share: "Share of the loss",
  pending: "Waiting on the amount",
  tracked: "Tracked, not paid",
};
const SOURCE_WORD: Record<string, string> = { bank: "from the bank", paid: "paid", quote: "quoted", mixed: "paid and quoted" };

const signed = (n: number) => `${n < -0.005 ? "-" : ""}${fmtAmount(Math.abs(n))}`;

/** The logistics pay on one deal, off the deal's payout (`deal_flow_payout`): the amount taken
 *  off the top before the owner split, and whether it is still waiting on the freight amount.
 *  `again` are the figures that change it, so the row moves when a booking or a link does. */
export function useDealLogisticsPay(dealFlowId: string, again: unknown[] = []): { amount: number; pending: boolean } {
  const [v, setV] = useState({ amount: 0, pending: false });
  useEffect(() => {
    let dead = false;
    api.dealFlowPayout(dealFlowId)
      .then((p) => { if (!dead) setV({ amount: Number(p?.logistics_pay) || 0, pending: !!p?.logistics_pay_pending }); })
      .catch(() => { if (!dead) setV({ amount: 0, pending: false }); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealFlowId, ...again]);
  return v;
}

/** One "Logistics pay" cell for a profit split, or nothing when the deal has none. */
export function LogisticsPayCell({ pay, big }: { pay: { amount: number; pending: boolean }; big?: boolean }) {
  if (pay.amount <= 0.005 && !pay.pending) return null;
  return (
    <div className={big ? "flex-1 min-w-[90px]" : ""}>
      <div className={`${big ? "text-[12px] truncate" : "text-[11px]"} text-muted`}>Logistics pay</div>
      <div className={`${big ? "text-[18px] font-bold mt-0.5" : "text-[13px] font-semibold"} text-ink-2 tabular-nums`}>
        {pay.pending ? "Waiting on the freight amount" : fmtAmount(pay.amount)}
      </div>
    </div>
  );
}

/** Polls while a screen is open: another person changes these figures from another device. */
function useRefresh(load: () => void) {
  useEffect(() => {
    load();
    const id = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => { window.clearInterval(id); window.removeEventListener("focus", load); };
  }, [load]);
}

function Switch({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`w-11 h-6 rounded-full relative transition-colors ring-1 flex-shrink-0 disabled:opacity-50 ${on ? "bg-accent ring-accent" : "bg-surface-3 ring-line-3"}`}>
      <span className={`absolute top-0.5 left-0 w-5 h-5 rounded-full shadow-sm transition-transform ${on ? "bg-on-accent translate-x-[22px]" : "bg-surface translate-x-0.5"}`} />
    </button>
  );
}

function Seg<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-full">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`flex-1 inline-flex items-center justify-center h-8 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap px-2 ${value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-muted mb-1.5">{label}</label>
      {children}
      {hint && <div className="text-[11.5px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

// ─── Settings: the rule and the schedule ──────────────────────────────────

type Person = { id: string; name: string; logisticsOnly: boolean };

/** R-415: one choice for what the shipping surplus does. */
const SURPLUS_CHOICES: { mode: "off" | "pay" | "track"; title: string; hint: string }[] = [
  { mode: "off", title: "Off", hint: "Logistics earns nothing from the shipping surplus and the Brief has no shipping block." },
  { mode: "pay", title: "Pay the surplus", hint: "Logistics earns a share of the shipping profit: what the customer was charged for shipping, less what the carrier was paid. Counted once the freight is confirmed booked." },
  { mode: "track", title: "Track the surplus in the Brief only", hint: "The Brief and the tracker show the surplus on each load. Nothing is paid and nothing comes off the profit split. A load already paid keeps what it was paid." },
];

/** R-415: who fills in the freight before a deal is sent to logistics. An admin's setting, saved the moment it is switched. */
export function LogisticsFreightSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setOn((await api.logistics.settings.get()).freight_by_team !== false); setErr(""); }
    catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const flip = async () => {
    if (on === null) return;
    const next = !on;
    setBusy(true); setErr("");
    try { const saved = await api.logistics.settings.save({ freight_by_team: next }); setOn(saved.freight_by_team !== false); toast("Saved"); }
    catch (e) { setErr(String(e)); }
    setBusy(false);
  };
  if (on === null) {
    return err
      ? <div className="text-[12.5px] text-warning-ink" role="alert">{err} <button type="button" onClick={load} className="underline font-medium">Try again</button></div>
      : <div className="text-[12.5px] text-muted">Loading...</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">We fill in the freight details before sending to logistics</div>
          <div className="text-[12px] text-muted mt-0.5">Pallets, weight, dimensions and accessorials. Off: the logistics person fills them in.</div>
        </div>
        <Switch on={on} onClick={flip} disabled={busy} label="We fill in the freight details before sending to logistics" />
      </div>
      {err && <div className="text-[12.5px] text-danger-ink" role="alert">{err}</div>}
    </div>
  );
}

export function LogisticsPaySettingsForm() {
  const [s, setS] = useState<LogisticsPaySettings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const got = await api.logistics.pay.settings();
      setS({ ...DEFAULTS, ...got } as LogisticsPaySettings);
      setLoadErr("");
    } catch (e) { setLoadErr(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Every active account, the Logistics-only ones first: they are who this is for.
    Promise.all([api.listStaff(), api.listRoles()]).then(([staff, roles]) => {
      const perms = new Map(roles.roles.map((r) => [r.id, r.permissions]));
      setPeople(staff.filter((u) => u.status === "active")
        .map((u) => ({ id: u.id, name: u.display_name || u.email, logisticsOnly: isLogisticsOnly(perms.get(u.role_id)) }))
        .sort((a, b) => Number(b.logisticsOnly) - Number(a.logisticsOnly) || a.name.localeCompare(b.name)));
    }).catch(() => {});
  }, []);

  const set = (patch: Partial<LogisticsPaySettings>) => { setS((prev) => (prev ? { ...prev, ...patch } : prev)); setDirty(true); setErr(""); };

  const save = async () => {
    if (!s) return;
    const paying = s.enabled && s.surplus_mode !== "track";
    if (paying && !s.payee_id) { setErr("Choose who gets the logistics pay."); return; }
    if (paying && s.frequency === "biweekly" && !s.anchor_date) { setErr("Pick the first pay date for every two weeks."); return; }
    setBusy(true); setErr("");
    try {
      const saved = await api.logistics.pay.saveSettings(s);
      setS({ ...DEFAULTS, ...saved });
      setDirty(false);
      toast("Logistics pay saved");
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const mode: "off" | "pay" | "track" = !s ? "off" : !s.enabled ? "off" : s.surplus_mode === "track" ? "track" : "pay";
  const setMode = (m: "off" | "pay" | "track") =>
    set(m === "off" ? { enabled: false } : { enabled: true, surplus_mode: m });
  const payee = useMemo(() => s && (people.find((p) => p.id === s.payee_id)?.name || s.payee_name), [s, people]);
  const example = useMemo(() => {
    if (!s) return [];
    return [[500, 350], [300, 350]].map(([charged, freight]) => {
      const r = logisticsPayFor(s, charged, freight);
      return `Charged ${fmtAmount(charged)}, paid ${fmtAmount(freight)}: ${payee || "logistics"} gets ${signed(r.pay)}.`;
    });
  }, [s, payee]);

  if (!s) {
    return loadErr
      ? <div className="text-[12.5px] text-warning-ink" role="alert">{loadErr} <button type="button" onClick={load} className="underline font-medium">Try again</button></div>
      : <div className="text-[12.5px] text-muted">Loading...</div>;
  }

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="What to do with the shipping surplus" className="space-y-2">
        {SURPLUS_CHOICES.map((c) => {
          const on = mode === c.mode;
          return (
            <button key={c.mode} type="button" role="radio" aria-checked={on} onClick={() => setMode(c.mode)}
              className={`w-full text-left flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${on ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2/60"}`}>
              <span className={`mt-0.5 w-4 h-4 rounded-full border flex-shrink-0 flex items-center justify-center ${on ? "border-accent" : "border-line-3"}`} aria-hidden>
                {on && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{c.title}</span>
                <span className="block text-[12px] text-muted mt-0.5">{c.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {mode !== "off" && <div className="text-[11.5px] text-muted -mt-2">Changes apply to loads that have not been paid yet.</div>}

      {mode === "pay" && (<>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Who gets it">
          <select className={inp} value={s.payee_id} onChange={(e) => {
            const p = people.find((x) => x.id === e.target.value);
            set({ payee_id: e.target.value, payee_name: p?.name ?? "" });
          }}>
            <option value="">Choose a person</option>
            {s.payee_id && !people.some((p) => p.id === s.payee_id) && <option value={s.payee_id}>{s.payee_name || "Current person"}</option>}
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.logisticsOnly ? " (Logistics)" : ""}</option>)}
          </select>
        </Field>
        <Field label="Share of the shipping profit">
          <div className="flex items-center gap-1.5">
            <NumberInput className={`${inp} text-right tabular-nums`} value={s.share_pct} onValue={(n) => set({ share_pct: Math.min(100, Math.max(0, n)) })} />
            <span className="w-3 shrink-0 text-[12px] text-muted">%</span>
          </div>
        </Field>
      </div>

      <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink">I cover loads that lose money</div>
            <div className="text-[12px] text-muted mt-0.5">On, the business takes the loss and the pay below still goes out. Off, a losing load pays the same share of the loss.</div>
          </div>
          <Switch on={s.cover_losses} onClick={() => set({ cover_losses: !s.cover_losses })} label="I cover loads that lose money" />
        </div>
        {s.cover_losses && (
          <Field label="Pay on a load that breaks even or loses money" hint="A percent of what the carrier was paid.">
            <div className="flex items-center gap-1.5 max-w-[200px]">
              <NumberInput className={`${inp} text-right tabular-nums`} value={s.loss_pay_pct} onValue={(n) => set({ loss_pay_pct: Math.min(100, Math.max(0, n)) })} />
              <span className="w-3 shrink-0 text-[12px] text-muted">%</span>
            </div>
          </Field>
        )}
      </div>

      <div className="space-y-3">
        <Field label="Pay schedule">
          <Seg value={s.frequency} onChange={(v) => set({ frequency: v })} options={FREQUENCIES} />
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {s.frequency === "weekly" && (
            <Field label="Pay day">
              <select className={inp} value={s.pay_weekday} onChange={(e) => set({ pay_weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
          )}
          {s.frequency === "biweekly" && (
            <Field label="First pay date" hint="Every pay date after it lands two weeks apart.">
              <input type="date" className={inp} value={s.anchor_date} onChange={(e) => set({ anchor_date: e.target.value })} />
            </Field>
          )}
          {s.frequency === "monthly" && (
            <Field label="Day of the month" hint="Days 1 to 28, so every month has one.">
              <select className={inp} value={s.pay_day_of_month} onChange={(e) => set({ pay_day_of_month: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          )}
          <div className="text-[12px] text-muted self-end pb-2.5">{describeSchedule(s, fmtDay)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="How the pay is sent">
          <select className={inp} value={s.method} onChange={(e) => set({ method: e.target.value })}>
            <option value="">Not set</option>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Payment details">
          <input className={inp} value={s.details} placeholder="Account, handle or where to send it" onChange={(e) => set({ details: e.target.value })} />
        </Field>
      </div>

      <div className="rounded-xl border border-line bg-surface px-4 py-3 space-y-1">
        <div className="text-[12px] font-medium text-muted">Example</div>
        {example.map((l) => <div key={l} className="text-[13px] text-ink tabular-nums">{l}</div>)}
        {!s.cover_losses && <div className="text-[11.5px] text-muted pt-1">A negative amount comes off the next pay date.</div>}
      </div>
      </>)}

      {err && <div className="text-[12.5px] text-danger-ink" role="alert">{err}</div>}
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={busy || !dirty}
          className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-colors">
          <Check size={14} strokeWidth={2.5} /> {busy ? "Saving..." : "Save"}
        </button>
        <span className="text-[12px] text-muted">
          {dirty ? "Not saved yet." : s.updated_at ? `Saved${s.updated_by_name ? ` by ${s.updated_by_name}` : ""} ${fmtDay(s.updated_at.slice(0, 10))}.` : ""}
        </span>
      </div>
    </div>
  );
}

// ─── Tracker: what is owed, on which date, for which loads ────────────────

function LoadRow({ l }: { l: LogisticsPayTrackerLine }) {
  // A load that was paid and then lost its booking or its invoice is money taken back.
  if (l.dropped) {
    return (
      <div className="py-2.5 text-[12.5px] min-w-0 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ink font-medium truncate">{l.invoice_number}{l.client_name ? ` for ${l.client_name}` : ""}</div>
          <div className="text-[11px] text-muted truncate">{l.booking_codes.length > 0 ? `${l.booking_codes.join(", ")} · ` : ""}Taken back: booking cancelled or invoice voided</div>
        </div>
        <div className="tabular-nums text-ink font-semibold flex-shrink-0">{signed(l.owed)}</div>
      </div>
    );
  }
  // Two lines, so it reads at any width: who and what it pays, then how the pay was worked out.
  return (
    <div className="py-2.5 text-[12.5px] min-w-0">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-ink font-medium truncate">{l.invoice_number}{l.client_name ? ` for ${l.client_name}` : ""}</div>
          <div className="text-[11px] text-muted truncate">{l.booking_codes.join(", ")} · earned {fmtDay(l.earned_on)}</div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="tabular-nums text-ink font-semibold">{l.pay == null ? "-" : signed(l.pay)}</div>
          <div className="text-[11px] text-muted">{RULE_WORD[l.rule] ?? l.rule}</div>
        </div>
      </div>
      <div className="text-[11.5px] text-ink-2 tabular-nums mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>Charged {fmtAmount(l.charged)}</span>
        <span>Freight {fmtAmount(l.freight)} <span className="text-muted">{SOURCE_WORD[l.freight_source] ?? l.freight_source}</span></span>
        <span className={l.surplus < 0 ? "text-danger-ink" : ""}>Profit {signed(l.surplus)}</span>
      </div>
    </div>
  );
}

/** The surplus of the loads whose freight is known. The server sends `totals`; an older one does not. */
function trackedTotals(t: LogisticsPayTracker) {
  if (t.totals) return t.totals;
  const known = t.lines.filter((l) => !l.pending && !l.dropped);
  const sum = (f: (l: LogisticsPayTrackerLine) => number) => known.reduce((n, l) => n + f(l), 0);
  return { charged: sum((l) => l.charged), freight: sum((l) => l.freight), surplus: sum((l) => l.surplus), loads: t.lines.length, pending_loads: t.lines.filter((l) => l.pending).length };
}

/** R-415: one load while the surplus is only tracked: what was charged, what the carrier was paid,
 *  what is left. No pay, no pay date. */
function TrackedRow({ l }: { l: LogisticsPayTrackerLine }) {
  return (
    <div className="py-2.5 text-[12.5px] min-w-0">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <div className="text-ink font-medium truncate">{l.invoice_number}{l.client_name ? ` for ${l.client_name}` : ""}</div>
          <div className="text-[11px] text-muted truncate">{l.booking_codes.join(", ")} · earned {fmtDay(l.earned_on)}</div>
        </div>
        <div className="text-right flex-shrink-0">
          {l.pending
            ? <div className="text-[12px] text-muted">Waiting on the amount paid</div>
            : <div className={`tabular-nums font-semibold ${l.surplus < 0 ? "text-danger-ink" : "text-ink"}`}>{signed(l.surplus)}</div>}
        </div>
      </div>
      <div className="text-[11.5px] text-ink-2 tabular-nums mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>Charged {fmtAmount(l.charged)}</span>
        {!l.pending && <span>Freight {fmtAmount(l.freight)} <span className="text-muted">{SOURCE_WORD[l.freight_source] ?? l.freight_source}</span></span>}
        {l.paid > 0.005 && <span className="text-muted">Paid earlier {fmtAmount(l.paid)}</span>}
      </div>
    </div>
  );
}

/** R-415: the tracker while the surplus is only tracked: the loads with their charged, freight and
 *  surplus and a total. No pay dates, no Record payment. */
function TrackedPanel({ t }: { t: LogisticsPayTracker }) {
  const tot = trackedTotals(t);
  const loads = t.lines.filter((l) => !l.dropped).sort((a, b) => b.earned_on.localeCompare(a.earned_on));
  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-muted">Shipping surplus, tracked</div>
        <div className="flex items-baseline gap-3 flex-wrap mt-1">
          <span className={`text-[24px] font-bold tabular-nums leading-none ${tot.surplus < 0 ? "text-danger-ink" : "text-ink"}`}>{signed(tot.surplus)}</span>
          <span className="text-[13px] text-ink-2">on {tot.loads - tot.pending_loads} load{tot.loads - tot.pending_loads !== 1 ? "s" : ""}</span>
          {tot.pending_loads > 0 && <StatusPill tone="neutral">{tot.pending_loads} waiting on the amount paid</StatusPill>}
        </div>
        <div className="text-[11.5px] text-muted mt-1.5 tabular-nums">Charged {fmtAmount(tot.charged)}, paid to carriers {fmtAmount(tot.freight)}</div>
      </div>
      {loads.length === 0
        ? <div className="text-[12.5px] text-muted py-3 text-center border border-line rounded-xl">Nothing tracked yet. A load counts once its amount paid is entered.</div>
        : <section className="border border-line rounded-xl px-4 divide-y divide-line">{loads.map((l) => <TrackedRow key={l.deal_flow_id} l={l} />)}</section>}
    </div>
  );
}

const STATUS_TONE: Record<LogisticsPayDate["status"], "success" | "warning" | "neutral"> = { paid: "success", due: "warning", upcoming: "neutral" };
const STATUS_WORD: Record<LogisticsPayDate["status"], string> = { paid: "Paid", due: "Due", upcoming: "Coming up" };

export function LogisticsPayTrackerPanel() {
  const [t, setT] = useState<LogisticsPayTracker | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [method, setMethod] = useState("");

  const load = useCallback(async () => {
    try {
      const got = await api.logistics.pay.tracker();
      setT(got);
      setMethod((m) => m || got.settings?.method || "");
      setErr("");
    } catch (e) { setErr(String(e)); }
  }, []);
  useRefresh(load);

  const record = async (d: LogisticsPayDate) => {
    if (!t) return;
    const payee = t.settings.payee_name || "logistics";
    // The date's total already holds what was carried in from an earlier one.
    if (!confirm(`Record ${fmtAmount(d.total)} paid to ${payee} for ${fmtDay(d.pay_date)}${method ? ` by ${method}` : ""}? The amount is what the loads below add up to.`)) return;
    setBusy(d.pay_date);
    try { await api.logistics.pay.record(d.pay_date, { method: method || "Other" }); toast("Payment recorded"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy("");
  };
  const undo = async (d: LogisticsPayDate) => {
    if (!t || !d.payout_id) return;
    if (!confirm(`Undo the ${fmtAmount(d.total)} payment for ${fmtDay(d.pay_date)}? What it covered is owed again.`)) return;
    setBusy(d.pay_date);
    try { await api.logistics.pay.undo(d.payout_id); toast("Payment undone"); await load(); }
    catch (e) { toast(String(e), "error"); }
    setBusy("");
  };

  if (!t) {
    return err
      ? <div className="text-[12.5px] text-warning-ink" role="alert">{err} <button type="button" onClick={load} className="underline font-medium">Try again</button></div>
      : <div className="text-[12.5px] text-muted">Loading...</div>;
  }
  if (!t.settings.enabled) {
    return <div className="text-[12.5px] text-muted">Logistics pay is off. Turn it on under <strong>Splits</strong>.</div>;
  }
  if (t.mode === "track" || t.settings.surplus_mode === "track") return <TrackedPanel t={t} />;

  const payouts = new Map(t.payouts.map((p) => [p.id, p]));
  const pending = t.lines.filter((l) => l.pending);
  const dates = t.dates.filter((d) => d.status !== "upcoming" || Math.abs(d.total) > 0.005 || d.pay_date === t.next_pay_date);
  // Payment is recorded oldest first: only the earliest date still unpaid takes the button.
  const earliestUnpaid = t.dates.filter((d) => d.status !== "paid" && d.total > 0.005).map((d) => d.pay_date).sort()[0] ?? "";

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-muted">Next pay date{t.settings.payee_name ? `, ${t.settings.payee_name}` : ""}</div>
          <div className="flex items-baseline gap-3 flex-wrap mt-1">
            <span className="text-[24px] font-bold tabular-nums text-ink leading-none">{fmtAmount(t.next_total)}</span>
            <span className="text-[13px] text-ink-2">{t.next_pay_date ? fmtDay(t.next_pay_date) : "No pay date yet"}</span>
            {t.due_now_total > 0.005 && <StatusPill tone="warning">Due now {fmtAmount(t.due_now_total)}</StatusPill>}
          </div>
          <div className="text-[11.5px] text-muted mt-1.5">{describeSchedule(t.settings, fmtDay)}</div>
        </div>
        <div className="w-44">
          <label className="block text-[12px] font-medium text-muted mb-1.5">Paid with</label>
          <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Not set</option>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {dates.length === 0 && pending.length === 0 && (
        <div className="text-[12.5px] text-muted py-3 text-center border border-line rounded-xl">Nothing earned yet. A load counts once its freight is confirmed booked.</div>
      )}

      {dates.map((d) => {
        const loads = t.lines.filter((l) => !l.pending && l.due_date === d.pay_date && Math.abs(l.owed) > 0.005);
        const paidLoads = d.status === "paid" ? t.lines.filter((l) => !l.pending && l.due_date === d.pay_date) : [];
        const shown = d.status === "paid" ? (paidLoads.length ? paidLoads : loads) : loads;
        const p = d.payout_id ? payouts.get(d.payout_id) : undefined;
        return (
          <section key={d.pay_date} className="border border-line rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-surface-2/50 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13.5px] font-semibold text-ink">{fmtDay(d.pay_date)}</span>
                  <StatusPill tone={STATUS_TONE[d.status]}>{STATUS_WORD[d.status]}</StatusPill>
                </div>
                <div className="text-[11.5px] text-muted mt-0.5">
                  Loads earned {fmtDay(d.period_start)} to {fmtDay(d.period_end)}
                  {Math.abs(d.carried_in) > 0.005 ? ` · includes ${signed(d.carried_in)} carried from the last date` : ""}
                  {p ? ` · paid ${fmtDay(p.paid_at || p.created_at.slice(0, 10))}${p.method ? ` by ${p.method}` : ""}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[15px] font-bold tabular-nums text-ink">{fmtAmount(d.total)}</span>
                {d.status === "due" && d.total > 0.005 && d.pay_date === earliestUnpaid && (
                  <button type="button" onClick={() => record(d)} disabled={busy === d.pay_date}
                    className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[12.5px] font-medium disabled:opacity-40 transition-colors whitespace-nowrap">
                    Record payment
                  </button>
                )}
                {d.status === "paid" && d.payout_id && (
                  <button type="button" onClick={() => undo(d)} disabled={busy === d.pay_date}
                    className="px-3 h-8 rounded-lg border border-line text-[12.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-40 transition-colors">
                    Undo
                  </button>
                )}
              </div>
            </div>
            {shown.length > 0 && (
              <div className="px-4 divide-y divide-line">{shown.map((l) => <LoadRow key={l.deal_flow_id} l={l} />)}</div>
            )}
          </section>
        );
      })}

      {pending.length > 0 && (
        <section className="border border-line rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-surface-2/50 flex items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">Waiting on the freight amount</span>
            <StatusPill tone="neutral">{pending.length}</StatusPill>
          </div>
          <div className="divide-y divide-line">
            {pending.map((l) => (
              <div key={l.deal_flow_id} className="px-4 py-2.5 flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="min-w-0 truncate text-ink-2">{l.invoice_number}{l.client_name ? ` for ${l.client_name}` : ""} · {l.booking_codes.join(", ")}</span>
                <span className="text-muted flex-shrink-0">Charged {fmtAmount(l.charged)}, not counted until the amount paid is entered</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Brief: one block for the owner ───────────────────────────────────────

/** `from` is the Monday the brief's week began, as YYYY-MM-DD. */
export function LogisticsPayBriefBlock({ t, from, onOpen }: { t: LogisticsPayTracker; from: string; onOpen: () => void }) {
  if (!t.settings.enabled) return null;
  // The brief's week, as the server counts it: loads earned from the Monday up to, not including,
  // the next one. A load still waiting on its freight amount counts as a load, with nothing earned.
  const end = (() => { const d = parseLocalDay(from); d.setDate(d.getDate() + 7); return localDay(d); })();
  const week = t.lines.filter((l) => !l.dropped && l.earned_on >= from && l.earned_on < end);
  const earned = week.reduce((s, l) => s + (l.pay ?? 0), 0);
  const waiting = t.lines.filter((l) => l.pending).length;
  // R-415: what the week's loads were charged, what the carriers were paid, and the difference
  // (only loads whose freight is known).
  const known = week.filter((l) => !l.pending);
  const billed = known.reduce((s, l) => s + l.charged, 0);
  const carriers = known.reduce((s, l) => s + l.freight, 0);
  const surplus = known.reduce((s, l) => s + l.surplus, 0);
  const tracking = t.mode === "track" || t.settings.surplus_mode === "track";
  const figure = (value: number, label: string) => (
    <div className="px-5 py-4 min-w-0">
      <div className={`text-[22px] font-bold leading-none tabular-nums ${value < -0.005 ? "text-danger-ink" : "text-ink"}`}>{signed(value)}</div>
      <div className="text-[11px] text-muted mt-1 leading-tight">{label}</div>
    </div>
  );
  return (
    <div className="bg-surface border border-line rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-line-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink tracking-tight">{tracking ? "Logistics" : "Logistics pay"}</h3>
          <p className="text-[11px] text-muted mt-0.5 truncate">
            {tracking ? "Tracked, not paid" : `${t.settings.payee_name || "Logistics"} · ${describeSchedule(t.settings, fmtDay)}`}
          </p>
        </div>
        {!tracking && t.due_now_total > 0.005 && <StatusPill tone="warning">Due now {fmtAmount(t.due_now_total)}</StatusPill>}
      </div>
      {tracking ? (
        <div className="grid grid-cols-3 divide-x divide-line-2">
          {figure(billed, "charged this week")}
          {figure(carriers, "paid to carriers")}
          {figure(surplus, `surplus on ${known.length} load${known.length !== 1 ? "s" : ""}`)}
        </div>
      ) : (
      <div className="grid grid-cols-2 divide-x divide-line-2">
        <div className="px-5 py-4 min-w-0">
          <div className="text-[22px] font-bold text-ink leading-none tabular-nums">{fmtAmount(t.next_total)}</div>
          <div className="text-[11px] text-muted mt-1 leading-tight">{t.next_pay_date ? `next pay, ${fmtDay(t.next_pay_date)}` : "next pay, no date yet"}</div>
        </div>
        <div className="px-5 py-4 min-w-0">
          <div className="text-[22px] font-bold text-ink leading-none tabular-nums">{fmtAmount(earned)}</div>
          <div className="text-[11px] text-muted mt-1 leading-tight">earned this week on {week.length} load{week.length !== 1 ? "s" : ""}</div>
        </div>
      </div>
      )}
      <div className="border-t border-line-2 px-5 py-2.5 text-[12px] text-ink-2 tabular-nums">
        {tracking
          ? `Shipping surplus ${signed(surplus)} this week (tracked, not paid)`
          : `Shipping surplus ${signed(surplus)} this week, paid to ${t.settings.payee_name || "logistics"}`}
      </div>
      <div className="border-t border-line-2 px-5 py-3 flex items-center justify-between gap-3">
        <span className="text-[12px] text-ink-2">
          {waiting > 0 ? `${waiting} load${waiting !== 1 ? "s" : ""} waiting on the freight amount` : "No loads waiting on an amount"}
        </span>
        <button type="button" onClick={onOpen} className="flex items-center gap-1 text-[12px] text-accent font-medium">
          Open the tracker <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── His own view: Your pay ───────────────────────────────────────────────

const LOAD_WORD: Record<string, string> = { earned: "Earned", pending: "Waiting on the amount paid", paid: "Paid" };
const LOAD_TONE: Record<string, "accent" | "warning" | "success"> = { earned: "accent", pending: "warning", paid: "success" };
const DATE_WORD: Record<string, string> = { paid: "Paid", due: "Due", upcoming: "Coming up" };

/** Shown at the top of the Logistics screen when the person viewing it is the one being paid.
 *  The server answers `{enabled: false}` to anyone else, and never sends what the customer was
 *  charged, so there is nothing here to hide. */
export function YourPayCard() {
  const [m, setM] = useState<LogisticsPayMine | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setM(await api.logistics.pay.mine()); } catch { setM(null); }
  }, []);
  useRefresh(load);

  if (!m || !m.enabled) return null;
  const loads = m.loads ?? [];
  const dates = m.dates ?? [];
  return (
    <section className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-3.5 flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">Your pay</h3>
          <div className="flex items-baseline gap-3 flex-wrap mt-1.5">
            <span className="text-[24px] font-bold tabular-nums text-ink leading-none">{fmtAmount(m.next_total ?? 0)}</span>
            <span className="text-[13px] text-ink-2">{m.next_pay_date ? `on ${fmtDay(m.next_pay_date)}` : "No pay date yet"}</span>
            {(m.due_now_total ?? 0) > 0.005 && <StatusPill tone="warning">Due now {fmtAmount(m.due_now_total ?? 0)}</StatusPill>}
          </div>
          {m.method && <div className="text-[11.5px] text-muted mt-1.5">Paid by {m.method}</div>}
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink font-medium">
          <ChevronRight size={13} className={`text-muted transition-transform ${open ? "rotate-90" : ""}`} />
          {open ? "Hide the loads" : "Show the loads"}
        </button>
      </div>
      {open && (
        <div className="border-t border-line">
          {loads.length === 0 ? <div className="px-4 py-4 text-[12.5px] text-muted">No loads earned yet.</div> : (
            <div className="divide-y divide-line">
              {loads.map((l) => {
                // The server already leaves a name empty when his switch is off.
                const route = [l.pickup_name, l.delivery_name].filter(Boolean).join(" to ");
                return (
                  <div key={l.code} className="px-4 py-2.5 flex items-center gap-3 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="font-mono text-[12px] text-muted flex-shrink-0">{l.code}</span>
                        {route && <span className="text-[13px] text-ink truncate min-w-0">{route}</span>}
                      </div>
                      <div className="text-[11.5px] text-muted mt-0.5">Earned {fmtDay(l.earned_on)}{l.due_date && l.status !== "pending" ? `, pays ${fmtDay(l.due_date)}` : ""}</div>
                    </div>
                    <StatusPill tone={LOAD_TONE[l.status] ?? "neutral"}>{LOAD_WORD[l.status] ?? l.status}</StatusPill>
                    <span className="text-[13px] font-semibold text-ink tabular-nums w-20 text-right">{l.status === "pending" ? "-" : fmtAmount(l.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {dates.length > 0 && (
            <div className="border-t border-line px-4 py-3 space-y-1.5">
              <div className="text-[12px] font-medium text-muted">Pay dates</div>
              {dates.map((d) => (
                <div key={d.pay_date} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="text-ink-2">{fmtDay(d.pay_date)} <span className="text-muted">· {DATE_WORD[d.status] ?? d.status}{d.status === "paid" && d.paid_at ? ` ${fmtDay(d.paid_at)}` : ""}</span></span>
                  <span className="tabular-nums text-ink font-medium">{fmtAmount(d.total)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
