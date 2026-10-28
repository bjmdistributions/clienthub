import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileUp, Mail, Phone, Plus, Reply, Search, Settings2, X } from "lucide-react";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { can } from "../lib/permissions";
import { useSessionMe } from "../lib/useSessionMe";
import {
  ANSWERED_HOW, KIND_LABEL, OUTCOMES, OUTCOME_LABEL, REPLY_TAG, STATUSES, STATUS_LABEL, TOKENS, nextLine, outreach, sendable,
  type DraftEmail, type Lead, type LeadDetail, type LeadList, type LeadStatus, type OutreachReply, type PumpState, type Skipped,
} from "../lib/outreach";

// R-546 Cold calls: warehouses and would-be suppliers being cold called and emailed, kept apart from
// clients and suppliers until Make supplier. The phone has the same screen. A cold email is never sent by
// the server: this PC sends the queue (switched on in Cold calls settings), weekdays 9 to 4 New York time,
// the daily limit spread across those hours, and watches the cold email inbox for replies.

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ghost = "border border-line text-ink-2 hover:bg-surface-2 px-3 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5";
const solid = "bg-accent hover:bg-accent-hover text-on-accent px-3 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap inline-flex items-center gap-1.5";
const field = "w-full bg-surface border border-line rounded-lg px-3 py-2 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/30";
const label = "block text-[12px] font-medium text-ink-2 mb-1";

const TONE: Record<LeadStatus, "neutral" | "step" | "accent" | "warning" | "success" | "danger"> = {
  new: "neutral", called: "step", emailed: "step", talking: "accent", has_goods: "warning",
  supplier: "success", not_now: "neutral", do_not_contact: "danger",
};
const Pill = ({ s }: { s: LeadStatus }) => <StatusPill tone={TONE[s] ?? "neutral"} size="md">{STATUS_LABEL[s] ?? s}</StatusPill>;

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Overlay({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh] bg-black/25 backdrop-blur-[2px]" onClick={onClose}>
      <div className={`bg-surface border border-line rounded-2xl shadow-2xl ${wide ? "w-[760px]" : "w-[520px]"} max-w-[94vw] max-h-[88vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
          <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-2" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-auto min-h-0">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export default function ColdCallsView() {
  const [data, setData] = useState<LeadList | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string>("due");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Lead> | null>(null);
  const [compose, setCompose] = useState<{ ids: string[]; bump: boolean } | null>(null);
  const [review, setReview] = useState<{ emails: DraftEmail[]; skipped: Skipped[] } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [imported, setImported] = useState<{ added: number; skipped: Skipped[] } | null>(null);
  const [view, setView] = useState<"leads" | "replies">("leads");
  const fileRef = useRef<HTMLInputElement>(null);
  const me = useSessionMe();
  // Make supplier writes a supplier, the suppliers write bar (the server checks it too).
  const mayAddSupplier = can(me, "inventory:edit");

  const load = useCallback(async () => {
    try { setData(await outreach.list()); setError(""); }
    catch (e) { setError(msg(e)); }
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const leads = useMemo(() => data?.leads ?? [], [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => (filter === "all" || (filter === "due" ? l.due : l.status === filter))
      && (!q || `${l.company} ${l.city} ${l.state} ${l.email} ${l.contact_name}`.toLowerCase().includes(q)));
  }, [leads, filter, query]);
  const chips: [string, string, number][] = [
    ["due", "Due today", data?.due ?? 0], ["all", "All", leads.length],
    ...STATUSES.filter((s) => data?.counts?.[s]).map((s) => [s, STATUS_LABEL[s], data?.counts?.[s] ?? 0] as [string, string, number]),
  ];

  const emailShown = () => {
    if (!data?.settings.address_line) { toast("Add your business address in Cold calls settings first. Every cold email has to carry it.", "error"); setSettingsOpen(true); return; }
    const ids = shown.filter((l) => sendable(l.status) && l.email).map((l) => l.id);
    if (!ids.length) { toast("No one in this list can get a cold email. They need an email address and a status of New, Called, Emailed or Not now.", "error"); return; }
    setCompose({ ids, bump: false });
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try {
        const r = await outreach.importSheet(f.name, String(rd.result).split(",")[1] ?? "");
        setImported(r);
        setFilter("due");
        load();
      } catch (e) { toast(msg(e), "error"); }
    };
    rd.readAsDataURL(f);
  };

  const st = data?.settings;
  const seen = st?.pump_seen_at ? new Date(st.pump_seen_at).getTime() : 0;
  const pumpLine = !st ? "" : !seen
    ? "No computer is sending these yet. Turn on Send from this computer in Cold calls settings."
    : Date.now() - seen > 10 * 60_000
      ? `The computer that sends these last checked in ${ago(st.pump_seen_at)}. Emails wait until Ecliptr is open on it.`
      : `Sending from ${st.send_from || "your email"}, ${st.hours}, up to ${st.daily_cap} a day.${st.pump_note ? " " + st.pump_note : ""}`;

  return (
    <div className="max-w-5xl mx-auto min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Cold calls</h2>
          <p className="text-[12.5px] text-muted mt-0.5">Warehouses to call and email, kept apart from your clients and suppliers until one becomes a supplier.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={solid} onClick={emailShown}><Mail size={14} /> Email these</button>
          <button className={ghost} onClick={() => setCompose({ ids: [], bump: true })}><Reply size={14} /> Bumps</button>
          <button className={ghost} onClick={() => setForm({})}><Plus size={14} /> Add</button>
          <button className={ghost} onClick={() => fileRef.current?.click()}><FileUp size={14} /> Import a sheet</button>
          <button className={ghost} onClick={() => setSettingsOpen(true)}><Settings2 size={14} /> Settings</button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2" role="alert">
          <span className="min-w-0">{error}</span>
          <button onClick={load} className={ghost}>Try again</button>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-2">
            {([["Due today", data.due], ["Waiting to send", data.queue.waiting], ["Sent today", data.queue.sent_today]] as [string, number][]).map(([l, v]) => (
              <div key={l} className="bg-surface border border-line rounded-2xl px-4 py-3">
                <div className="text-[12px] text-muted">{l}</div>
                <div className="text-[22px] font-semibold text-ink tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <p className={`text-[12.5px] mb-4 ${!seen ? "text-warning-ink" : "text-muted"}`}>
            {pumpLine}
            {data.queue.failed > 0 && <span className="text-danger-ink font-medium"> {data.queue.failed} failed to send: open the warehouse to try again.</span>}
          </p>

          <div className="inline-flex p-0.5 mb-3 bg-surface-2 border border-line rounded-lg">
            {([["leads", "Warehouses", 0], ["replies", "Replies", data.replies_waiting ?? 0]] as ["leads" | "replies", string, number][]).map(([k, lb, n]) => (
              <button key={k} onClick={() => setView(k)}
                className={`h-8 px-3.5 rounded-md text-[13px] inline-flex items-center gap-1.5 transition-colors ${view === k ? "bg-surface text-ink font-medium shadow-sm" : "text-ink-2 hover:text-ink"}`}>
                {lb}
                {n > 0 && <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-on-accent text-[11px] font-semibold tabular-nums inline-flex items-center justify-center">{n}</span>}
              </button>
            ))}
          </div>

          {view === "replies" ? <Replies onOpenLead={setOpenId} onChanged={load} /> : <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative w-64 max-w-full">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Company, city, email" className={field + " pl-8 h-9 py-0"} />
            </div>
            {chips.map(([k, l, n]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`h-8 px-3 rounded-full border text-[12.5px] whitespace-nowrap transition-colors ${filter === k ? "bg-accent/10 border-accent/40 text-accent-hover font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                {l} <span className="tabular-nums text-muted">{n}</span>
              </button>
            ))}
          </div>

          {leads.length === 0 ? (
            <div className="bg-surface border border-line rounded-2xl py-12 text-center text-[13px] text-muted">No warehouses yet. Import a sheet or add one.</div>
          ) : shown.length === 0 ? (
            <div className="bg-surface border border-line rounded-2xl py-12 text-center text-[13px] text-muted">{filter === "due" && !query ? "Nothing is due today." : "No warehouses match."}</div>
          ) : (
            <div className="bg-surface border border-line rounded-2xl divide-y divide-line-2 overflow-hidden">
              {shown.map((l) => {
                const place = [l.city, l.state].filter(Boolean).join(", ");
                const next = nextLine(l.next_touch, data.today);
                return (
                  <button key={l.id} onClick={() => setOpenId(l.id)} className="w-full text-left flex items-center gap-4 px-4 py-3 hover:bg-surface-2 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink truncate">{l.company}</div>
                      <div className="text-[12.5px] text-muted truncate">
                        {[place, KIND_LABEL[l.kind] ?? ""].filter(Boolean).join(" · ") || "No place yet"}
                        {/* The 216px sidebar takes a step off every breakpoint: below xl the next touch rides this line. */}
                        {next && <span className={`xl:hidden ${l.due ? "text-accent-hover font-medium" : ""}`}> · {next}</span>}
                      </div>
                    </div>
                    <div className="hidden 2xl:block w-56 min-w-0 text-[12.5px] text-ink-2 truncate">{l.email || l.phone || ""}</div>
                    <div className={`hidden xl:block w-48 min-w-0 truncate text-[12.5px] ${l.due ? "text-accent-hover font-medium" : "text-muted"}`}>
                      {next}{l.queued ? <span className="text-muted font-normal"> · {l.queued} to send</span> : null}
                    </div>
                    <div className="flex-shrink-0 flex justify-end"><Pill s={l.status} /></div>
                  </button>
                );
              })}
            </div>
          )}
          </>}
        </>
      )}

      {openId && data && (
        <LeadDrawer id={openId} today={data.today} mayAddSupplier={mayAddSupplier} onClose={() => setOpenId(null)} onChanged={load}
          onEdit={(l) => { setOpenId(null); setForm(l); }} onEmail={(lid) => setCompose({ ids: [lid], bump: false })} />
      )}
      {form && <LeadForm lead={form} onClose={() => setForm(null)} onSaved={(lid) => { setForm(null); load(); setOpenId(lid); }} />}
      {compose && data && (
        <Compose ids={compose.ids} bump={compose.bump} settings={data.settings} onClose={() => setCompose(null)}
          onNext={(r) => { setCompose(null); setReview(r); load(); }} />
      )}
      {review && <Review emails={review.emails} skipped={review.skipped} onClose={() => setReview(null)} onQueued={() => { setReview(null); setOpenId(null); load(); }} />}
      {settingsOpen && data && <SettingsOverlay settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); load(); }} />}
      {imported && (
        <Overlay title={imported.added === 1 ? "Added 1 warehouse" : `Added ${imported.added} warehouses`} onClose={() => setImported(null)}
          footer={<button className={solid} onClick={() => setImported(null)}>Done</button>}>
          {imported.skipped.length === 0 ? <p className="text-[13px] text-muted">Every row was added.</p> : (
            <>
              <p className="text-[13px] text-ink-2 mb-2">{imported.skipped.length === 1 ? "1 row was" : `${imported.skipped.length} rows were`} left out:</p>
              <div className="text-[12.5px] text-muted space-y-1 max-h-[50vh] overflow-auto">
                {imported.skipped.map((x, i) => <div key={i}>Row {x.row}{x.company ? `, ${x.company}` : ""}: {x.reason}</div>)}
              </div>
            </>
          )}
        </Overlay>
      )}
    </div>
  );
}

const tagPill = (t: string) => {
  const [lb, tone] = REPLY_TAG[t] ?? [t, "neutral" as const];
  return <StatusPill key={t} tone={tone}>{lb}</StatusPill>;
};

/** R-563: every reply in one place. What they said at a glance, and the ones still waiting on you first. */
function Replies({ onOpenLead, onChanged }: { onOpenLead: (leadId: string) => void; onChanged: () => void }) {
  const [list, setList] = useState<OutreachReply[] | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<OutreachReply | null>(null);

  const load = useCallback(async () => {
    try { setList((await outreach.replies()).replies); } catch (e) { toast(msg(e), "error"); }
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!list) return <div className="bg-surface border border-line rounded-2xl py-12 text-center text-[13px] text-muted">Loading replies...</div>;
  const waiting = list.filter((r) => !r.answered);
  const shown = all ? list : waiting;
  const answer = async (r: OutreachReply) => {
    try { await outreach.markAnswered(r.id); toast("Marked answered"); setOpen(null); await load(); onChanged(); }
    catch (e) { toast(msg(e), "error"); }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([[false, "To answer", waiting.length], [true, "All replies", list.length]] as [boolean, string, number][]).map(([k, lb, n]) => (
          <button key={lb} onClick={() => setAll(k)}
            className={`h-8 px-3 rounded-full border text-[12.5px] whitespace-nowrap transition-colors ${all === k ? "bg-accent/10 border-accent/40 text-accent-hover font-medium" : "border-line text-ink-2 hover:bg-surface-2"}`}>
            {lb} <span className="tabular-nums text-muted">{n}</span>
          </button>
        ))}
        <span className="text-[12px] text-muted">A reply counts as answered once you email them from your mailbox, log a call, or mark it.</span>
      </div>
      {shown.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl py-12 text-center text-[13px] text-muted">
          {list.length === 0 ? "No replies yet. When a warehouse answers a cold email it shows here." : "You have answered every reply."}
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-2xl divide-y divide-line-2 overflow-hidden">
          {shown.map((r) => (
            <button key={r.id} onClick={() => setOpen(r)} className="w-full text-left flex items-start gap-4 px-4 py-3 hover:bg-surface-2 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[14px] font-medium text-ink truncate">{r.company}</span>
                  {r.contact_name && <span className="text-[12.5px] text-muted truncate">{r.contact_name}</span>}
                  <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{ago(r.at)}</span>
                </div>
                <div className={`text-[13.5px] mt-0.5 line-clamp-2 ${r.answered ? "text-ink-2" : "text-ink"}`}>
                  {r.gist || <span className="text-muted">No new words in it. Open it to see the whole email.</span>}
                </div>
                {(r.tags.length > 0 || r.phone) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                    {r.tags.slice(0, 2).map(tagPill)}
                    {r.tags.length > 2 && <span className="text-[11.5px] text-muted">+{r.tags.length - 2}</span>}
                    {r.phone && <span className="text-[12px] text-ink-2 inline-flex items-center gap-1"><Phone size={12} className="text-muted" />{r.phone}</span>}
                  </div>
                )}
              </div>
              <div className="flex-shrink-0 w-36 flex justify-end pt-0.5">
                {r.answered
                  ? <span className="text-[12px] text-muted inline-flex items-center gap-1"><Check size={13} />{ANSWERED_HOW[r.answered_how] ?? "Answered"}</span>
                  : <StatusPill tone="warning" size="md">To answer</StatusPill>}
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <ReplyReader r={open} onClose={() => setOpen(null)} onAnswer={() => answer(open)} onOpenLead={() => { setOpen(null); onOpenLead(open.lead_id); }} />}
    </>
  );
}

function ReplyReader({ r, onClose, onAnswer, onOpenLead }: { r: OutreachReply; onClose: () => void; onAnswer: () => void; onOpenLead: () => void }) {
  const [whole, setWhole] = useState(false);
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const quoted = r.body.trim() !== r.new_text.trim();
  return (
    <Overlay title={r.company} wide onClose={onClose}
      footer={<>
        <button className={ghost} onClick={onOpenLead}>Open warehouse</button>
        {!r.answered && <button className={solid} onClick={onAnswer}><Check size={14} /> Mark answered</button>}
      </>}>
      <div className="text-[12.5px] text-muted mb-3">
        {[r.contact_name, r.email, when(r.at)].filter(Boolean).join(", ")}
        <div className="text-ink-2 mt-0.5">{r.subject}</div>
      </div>
      {(r.tags.length > 0 || r.phone) && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {r.tags.map(tagPill)}
          {r.phone && <span className="text-[12.5px] text-ink-2 inline-flex items-center gap-1 select-text"><Phone size={12} className="text-muted" />{r.phone}</span>}
        </div>
      )}
      <div className="text-[12px] text-muted mb-1">What they said</div>
      <div className="text-[14px] text-ink leading-relaxed whitespace-pre-wrap select-text bg-surface-2 border border-line rounded-xl px-4 py-3">
        {(whole ? r.body : r.new_text) || r.body || "The email had no text."}
      </div>
      {quoted && (
        <button className="mt-2 text-[12.5px] text-accent-hover hover:underline" onClick={() => setWhole(!whole)}>
          {whole ? "Show only what they wrote" : "Show the whole email"}
        </button>
      )}
      <div className={`mt-4 text-[12.5px] ${r.answered ? "text-muted" : "text-warning-ink font-medium"}`}>
        {r.answered ? `${ANSWERED_HOW[r.answered_how] ?? "Answered"} ${ago(r.answered_at)}.` : "You have not answered this yet."}
      </div>
      {r.yours && (
        <div className="mt-4">
          <div className="text-[12px] text-muted mb-1">Your email before this, {when(r.yours.at)}</div>
          <div className="text-[12.5px] text-ink-2 whitespace-pre-wrap select-text line-clamp-[10] border-l-2 border-line pl-3">{r.yours.body}</div>
        </div>
      )}
    </Overlay>
  );
}

function LeadDrawer({ id, today, mayAddSupplier, onClose, onChanged, onEdit, onEmail }: {
  id: string; today: string; mayAddSupplier: boolean; onClose: () => void; onChanged: () => void;
  onEdit: (l: Lead) => void; onEmail: (id: string) => void;
}) {
  const [d, setD] = useState<LeadDetail | null>(null);
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [newNote, setNewNote] = useState("");

  const load = useCallback(async () => {
    try { setD(await outreach.get(id)); } catch (e) { toast(msg(e), "error"); onClose(); }
  }, [id, onClose]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const act = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await f(); if (done) toast(done); await load(); onChanged(); }
    catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  const l = d?.lead;
  const evLabel = (e: LeadDetail["events"][number]) => e.kind === "call" ? `Call: ${OUTCOME_LABEL[e.outcome] ?? e.outcome}`
    : e.kind === "email" ? (e.outcome === "bump" ? "Bump sent" : "Email sent")
    : e.kind === "reply" ? (e.outcome === "stop" ? "Replied: asked to stop" : "Replied")
    : e.kind === "status" ? `Status: ${STATUS_LABEL[e.outcome as LeadStatus] ?? e.outcome}`
    : e.kind === "import" ? "Imported"
    : e.kind === "answer" ? "You emailed them"
    : e.kind === "answered" ? "Marked answered" : "Note";
  const site = l?.website ? (/^https?:\/\//i.test(l.website) ? l.website : `https://${l.website}`) : "";

  return (
    <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose}>
      <aside className="absolute inset-y-0 right-0 w-[460px] max-w-[96vw] bg-surface border-l border-line shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-ink truncate">{l?.company ?? "Loading..."}</h3>
            {l && <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted"><Pill s={l.status} />{l.contact_name && <span>{l.contact_name}</span>}</div>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted hover:bg-surface-2" aria-label="Close"><X size={16} /></button>
        </div>
        {l && d && (
          <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
            <section>
              <div className="text-[13px] text-ink-2 space-y-1.5">
                {l.phone && <div className="flex items-center gap-2"><Phone size={13} className="text-muted" /><span className="select-text">{l.phone}</span></div>}
                {l.email && <div className="flex items-center gap-2"><Mail size={13} className="text-muted" /><span className="select-text">{l.email}</span></div>}
                {site && <div><a href={site} target="_blank" rel="noreferrer" className="text-accent-hover hover:underline">{l.website}</a></div>}
                <div className="text-muted">{[[l.city, l.state].filter(Boolean).join(", "), KIND_LABEL[l.kind] ?? "", l.source].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {sendable(l.status) && l.email && <button className={ghost} onClick={() => onEmail(l.id)}><Mail size={14} /> Email</button>}
                <button className={ghost} onClick={() => onEdit(l)}>Edit</button>
                {l.status !== "supplier" && mayAddSupplier && (
                  <button className={ghost} disabled={busy} onClick={() => act(() => outreach.makeSupplier(l.id), `${l.company} is now in Suppliers`)}>Make supplier</button>
                )}
              </div>
            </section>

            <section className="bg-surface-2 border border-line rounded-xl p-3">
              <div className="text-[13px] font-medium text-ink mb-2">Log a call</div>
              <div className="flex flex-wrap gap-1.5">
                {OUTCOMES.map(([k, lb]) => (
                  <button key={k} onClick={() => setOutcome(outcome === k ? "" : k)}
                    className={`h-8 px-2.5 rounded-lg border text-[12.5px] ${outcome === k ? "bg-accent/10 border-accent/40 text-accent-hover font-medium" : "border-line text-ink-2 bg-surface hover:bg-surface-2"}`}>{lb}</button>
                ))}
              </div>
              {outcome && (
                <div className="mt-3 space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Who you spoke to, what they said" className={field} />
                  <div className="flex items-center gap-2">
                    <label className="text-[12px] text-muted whitespace-nowrap">Next touch</label>
                    <input type="date" value={next} onChange={(e) => setNext(e.target.value)} className={field + " w-44"} />
                    <span className="text-[11.5px] text-muted">Empty keeps the usual next step.</span>
                  </div>
                  <button className={solid} disabled={busy} onClick={() => act(async () => {
                    await outreach.logCall(l.id, outcome, note.trim(), next);
                    setOutcome(""); setNote(""); setNext("");
                  }, "Call logged")}>Save the call</button>
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-medium text-ink">{nextLine(l.next_touch, today) || "No next touch set"}</div>
                <input type="date" value={l.next_touch} onChange={(e) => act(() => outreach.edit(l.id, { next_touch: e.target.value }))} className={field + " w-44"} aria-label="Next touch" />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[12.5px] text-muted">Status</span>
                <select value={l.status} disabled={l.status === "supplier" || busy} onChange={(e) => act(() => outreach.edit(l.id, { status: e.target.value as LeadStatus }))} className={field + " w-48 py-1.5"}>
                  {STATUSES.filter((s) => s !== "supplier" || l.status === "supplier").map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </div>
            </section>

            {l.personal_line && <section><div className="text-[12px] text-muted mb-1">Personal line</div><div className="text-[13px] text-ink-2 whitespace-pre-wrap">{l.personal_line}</div></section>}
            {l.notes && <section><div className="text-[12px] text-muted mb-1">Notes</div><div className="text-[13px] text-ink-2 whitespace-pre-wrap select-text">{l.notes}</div></section>}

            {d.queue.length > 0 && (
              <section>
                <div className="text-[13px] font-medium text-ink mb-2">Emails not sent yet</div>
                <div className="space-y-2">
                  {d.queue.map((q) => (
                    <div key={q.id} className="border border-line rounded-xl p-3">
                      <div className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="font-medium text-ink truncate">{q.subject}</span>
                        <StatusPill tone={q.status === "failed" ? "danger" : "neutral"}>{q.status === "failed" ? "Failed" : q.status === "sending" ? "Sending" : "Waiting to send"}</StatusPill>
                      </div>
                      {q.status === "failed" && q.error && <div className="text-[12.5px] text-danger-ink mt-1">{q.error}</div>}
                      {q.status !== "sending" && (
                        <div className="mt-2 flex gap-2">
                          {q.status === "failed" && <button className={ghost} disabled={busy} onClick={() => act(() => outreach.retry(q.id), "Queued again")}>Try again</button>}
                          <button className={ghost} disabled={busy} onClick={() => act(() => outreach.cancel(q.id), "Not sent")}>Don't send</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="text-[13px] font-medium text-ink mb-2">What happened</div>
              <div className="flex gap-2 mb-3">
                <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Add a note" className={field} />
                <button className={ghost} disabled={busy || !newNote.trim()} onClick={() => act(async () => { await outreach.note(l.id, newNote.trim()); setNewNote(""); })}>Add</button>
              </div>
              {d.events.length === 0 ? <div className="text-[12.5px] text-muted">Nothing yet</div> : (
                <div className="divide-y divide-line-2">
                  {d.events.map((e) => (
                    <div key={e.id} className="py-2.5">
                      <div className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="font-medium text-ink">{evLabel(e)}</span>
                        <span className="text-[11.5px] text-muted whitespace-nowrap">{ago(e.at)}{e.by ? ` · ${e.by}` : ""}</span>
                      </div>
                      {e.subject && <div className="text-[12.5px] text-ink-2 mt-0.5">{e.subject}</div>}
                      {e.body && <div className="text-[12.5px] text-muted mt-1 whitespace-pre-wrap line-clamp-6 select-text">{e.body}</div>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="pt-2 border-t border-line">
              <button className="text-[12.5px] text-danger-ink hover:underline" disabled={busy}
                onClick={() => { if (confirm(`Remove ${l.company} from Cold calls? Its history is kept.`)) act(async () => { await outreach.remove(l.id); onClose(); }); }}>
                Remove from the list
              </button>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function LeadForm({ lead, onClose, onSaved }: { lead: Partial<Lead>; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState<Partial<Lead>>({ ...lead });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Lead) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    if (!f.company?.trim()) { toast("Type the company name first", "error"); return; }
    setBusy(true);
    const body = { company: f.company, contact_name: f.contact_name ?? "", phone: f.phone ?? "", email: f.email ?? "", city: f.city ?? "",
      state: f.state ?? "", kind: f.kind ?? "", website: f.website ?? "", personal_line: f.personal_line ?? "", notes: f.notes ?? "" };
    try {
      const r = lead.id ? (await outreach.edit(lead.id, body), lead.id) : (await outreach.add(body)).id;
      onSaved(r);
    } catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <Overlay title={lead.id ? "Edit warehouse" : "Add a warehouse"} onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy} onClick={save}>Save</button></>}>
      <div className="space-y-3">
        <div><label className={label}>Company</label><input autoFocus value={f.company ?? ""} onChange={set("company")} className={field} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Contact</label><input value={f.contact_name ?? ""} onChange={set("contact_name")} className={field} /></div>
          <div><label className={label}>Phone</label><input value={f.phone ?? ""} onChange={set("phone")} className={field} /></div>
        </div>
        <div><label className={label}>Email</label><input value={f.email ?? ""} onChange={set("email")} className={field} /></div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className={label}>City</label><input value={f.city ?? ""} onChange={set("city")} className={field} /></div>
          <div><label className={label}>State</label><input value={f.state ?? ""} onChange={set("state")} className={field} /></div>
          <div><label className={label}>Type</label>
            <select value={f.kind ?? ""} onChange={set("kind")} className={field}>
              <option value="">Not set</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div><label className={label}>Website</label><input value={f.website ?? ""} onChange={set("website")} className={field} /></div>
        <div><label className={label}>Personal line</label><textarea rows={2} value={f.personal_line ?? ""} onChange={set("personal_line")} className={field}
          placeholder="One line written for this warehouse, used where an email says {personal_line}" /></div>
        <div><label className={label}>Notes</label><textarea rows={3} value={f.notes ?? ""} onChange={set("notes")} className={field} /></div>
      </div>
    </Overlay>
  );
}

function Compose({ ids, bump, settings, onClose, onNext }: {
  ids: string[]; bump: boolean; settings: LeadList["settings"]; onClose: () => void;
  onNext: (r: { emails: DraftEmail[]; skipped: Skipped[] }) => void;
}) {
  const [subject, setSubject] = useState(settings.subject);
  const [body, setBody] = useState(bump ? settings.bump : settings.body);
  const [busy, setBusy] = useState(false);
  const last = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const insert = (tk: string) => {
    const el = last.current;
    if (!el) { setBody((b) => b + tk); return; }
    const a = el.selectionStart ?? el.value.length, z = el.selectionEnd ?? a;
    const v = el.value.slice(0, a) + tk + el.value.slice(z);
    if (el.tagName === "INPUT") setSubject(v); else setBody(v);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + tk.length; });
  };
  const next = async () => {
    if (!body.trim() || (!bump && !subject.trim())) { toast("Write the subject and the email first", "error"); return; }
    setBusy(true);
    try {
      const r = bump ? await outreach.bumps(body) : await outreach.preview(ids, subject, body);
      if (!r.emails.length) {
        toast(bump ? "No one is due a bump today." : "None of these can get a cold email. " + r.skipped.map((x) => `${x.company}: ${x.reason}`).join(". "), "error");
      } else onNext(r);
    } catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <Overlay wide title={bump ? "Bumps" : ids.length === 1 ? "Email 1 warehouse" : `Email ${ids.length} warehouses`} onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy} onClick={next}>Check each email</button></>}>
      <div className="space-y-3">
        {bump ? (
          <p className="text-[12.5px] text-muted">Goes as a reply in the same thread to everyone emailed 4 or more days ago who has not answered and has had no bump yet.</p>
        ) : (
          <div><label className={label}>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={(e) => { last.current = e.target; }} className={field} /></div>
        )}
        <div><label className={label}>{bump ? "The bump" : "The email"}</label>
          <textarea rows={bump ? 5 : 13} value={body} onChange={(e) => setBody(e.target.value)} onFocus={(e) => { last.current = e.target; }} className={field + " leading-relaxed"} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TOKENS.map(([tk, lb]) => <button key={tk} onClick={() => insert(tk)} className="h-7 px-2.5 rounded-full border border-line text-[12px] text-ink-2 hover:bg-surface-2">{lb}</button>)}
        </div>
        <p className="text-[12px] text-muted">Each one ends with your business address and "Reply stop and I won't email again." No links or pictures are added. You see every email before it goes.</p>
      </div>
    </Overlay>
  );
}

function Review({ emails, skipped, onClose, onQueued }: { emails: DraftEmail[]; skipped: Skipped[]; onClose: () => void; onQueued: () => void }) {
  const [list, setList] = useState(emails.map((e) => ({ ...e, on: true })));
  const [busy, setBusy] = useState(false);
  const n = list.filter((e) => e.on).length;
  const upd = (i: number, k: "subject" | "body" | "on", v: string | boolean) => setList((L) => L.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  const go = async () => {
    setBusy(true);
    try {
      const r = await outreach.queue(list.filter((e) => e.on).map(({ lead_id, subject, body, reply_to, bump }) => ({ lead_id, subject, body, reply_to, bump })));
      const left = r.skipped.length;
      toast(`${r.queued} ${r.queued === 1 ? "email" : "emails"} waiting. They go out weekdays 9 to 4.${left ? ` ${left} left out.` : ""}`);
      onQueued();
    } catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <Overlay wide title="Check each email" onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy || n === 0} onClick={go}>{n === 1 ? "Queue 1 email" : `Queue ${n} emails`}</button></>}>
      {skipped.length > 0 && <p className="text-[12.5px] text-muted mb-3">Left out: {skipped.map((x) => `${x.company} (${x.reason.toLowerCase()})`).join(", ")}</p>}
      <div className="space-y-3">
        {list.map((e, i) => (
          <div key={e.lead_id} className={`border border-line rounded-xl p-3 ${e.on ? "" : "opacity-55"}`}>
            <label className="flex items-center gap-2 text-[13px] mb-2 cursor-pointer">
              <input type="checkbox" checked={e.on} onChange={(ev) => upd(i, "on", ev.target.checked)} className="w-4 h-4 accent-accent" />
              <span className="font-medium text-ink">{e.company}</span><span className="text-muted">{e.to}</span>
            </label>
            {e.bump ? <div className="text-[12.5px] text-muted mb-1">{e.subject}</div>
              : <input value={e.subject} disabled={!e.on} onChange={(ev) => upd(i, "subject", ev.target.value)} className={field + " mb-2"} aria-label="Subject" />}
            <textarea value={e.body} disabled={!e.on} onChange={(ev) => upd(i, "body", ev.target.value)} className={field + " leading-relaxed"} aria-label="Email"
              rows={Math.min(22, Math.max(6, e.body.split("\n").reduce((k, ln) => k + Math.max(1, Math.ceil(ln.length / 90)), 0)))} />
          </div>
        ))}
      </div>
    </Overlay>
  );
}

function SettingsOverlay({ settings, onClose, onSaved }: { settings: LeadList["settings"]; onClose: () => void; onSaved: () => void }) {
  const [pump, setPump] = useState<PumpState | null>(null);
  const [f, setF] = useState({ send_from: settings.send_from, from_name: settings.from_name, address_line: settings.address_line, daily_cap: String(settings.daily_cap || 30) });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    outreach.pump().then((p) => {
      setPump(p);
      if (!settings.send_from && p.login) setF((v) => ({ ...v, send_from: v.send_from || p.login }));
    }).catch(() => {});
  }, [settings.send_from]);
  const from = f.send_from.trim().toLowerCase();
  const login = (pump?.login ?? "").trim().toLowerCase();
  const watched = !!pump && pump.inboxes.some((x) => x.trim().toLowerCase() === from);
  const save = async () => {
    setBusy(true);
    try {
      await outreach.saveSettings({ send_from: f.send_from.trim(), from_name: f.from_name.trim(), address_line: f.address_line.trim(), daily_cap: parseInt(f.daily_cap, 10) || 30 });
      toast("Saved");
      onSaved();
    } catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  const flip = async (on: boolean) => {
    try { await outreach.setPump(on); setPump(await outreach.pump()); toast(on ? "This computer sends the cold emails" : "This computer no longer sends cold emails"); }
    catch (e) { toast(msg(e), "error"); }
  };
  return (
    <Overlay title="Cold calls settings" onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy} onClick={save}>Save</button></>}>
      <div className="space-y-4">
        <div className="bg-surface-2 border border-line rounded-xl p-3">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span>
              <span className="block text-[13.5px] font-medium text-ink">Send from this computer</span>
              <span className="block text-[12px] text-muted">Only one computer should send. Emails wait while Ecliptr is closed on it.</span>
            </span>
            <input type="checkbox" checked={!!pump?.on} onChange={(e) => flip(e.target.checked)} className="w-5 h-5 accent-accent" />
          </label>
          {pump?.on && pump.last_error && <p className="text-[12px] text-danger-ink mt-2">{pump.last_error}</p>}
          {pump?.on && pump.last_sent_at && <p className="text-[12px] text-muted mt-1">Last sent {ago(pump.last_sent_at)}.</p>}
        </div>
        <div>
          <label className={label}>Send from</label>
          <input value={f.send_from} onChange={(e) => setF({ ...f, send_from: e.target.value })} className={field} placeholder="you@yourcompany.com" />
          {pump && (
            <div className="text-[12px] mt-1.5 space-y-1">
              {login && from && from !== login && (
                <p className="text-warning-ink">This computer signs in to email as {pump.login}. Gmail sends as {f.send_from.trim()} only if it is set up as Send mail as on that account; if it is not, Gmail sends as {pump.login} and says nothing.</p>
              )}
              <p className={watched ? "text-muted" : "text-warning-ink"}>
                {watched ? `Replies are watched in ${f.send_from.trim()}, so a warehouse that answers moves to Talking by itself.`
                  : `Add ${f.send_from.trim() || "this address"} as an inbox in Settings, Email, so a warehouse that answers moves to Talking by itself.`}
              </p>
            </div>
          )}
        </div>
        <div><label className={label}>Your name</label><input value={f.from_name} onChange={(e) => setF({ ...f, from_name: e.target.value })} className={field} />
          <p className="text-[12px] text-muted mt-1">Shown as the sender, and used where an email says {"{from_name}"}.</p></div>
        <div><label className={label}>Business address</label><input value={f.address_line} onChange={(e) => setF({ ...f, address_line: e.target.value })} className={field} placeholder="Company, street, city, state" />
          <p className="text-[12px] text-muted mt-1">Every cold email ends with it. The law asks for a real postal address.</p></div>
        <div><label className={label}>Emails a day</label><input type="number" min={1} max={200} value={f.daily_cap} onChange={(e) => setF({ ...f, daily_cap: e.target.value })} className={field + " w-32"} />
          <p className="text-[12px] text-muted mt-1">Spread across {settings.hours}. 30 to 40 a day keeps a mailbox out of spam folders.</p></div>
      </div>
    </Overlay>
  );
}
