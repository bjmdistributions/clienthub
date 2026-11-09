import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, FileUp, ListPlus, Mail, Pencil, Phone, Plus, Reply, Search, Settings2, X } from "lucide-react";
import StatusPill from "./StatusPill";
import { PageActions, Tabs } from "./ui";
import ColdCallsMap from "./ColdCallsMap";
import { copyText, COPY_FAILED } from "../lib/clipboard";
import { toast } from "./Toast";
import { can } from "../lib/permissions";
import { useSessionMe } from "../lib/useSessionMe";
import {
  ANSWERED_HOW, KIND_LABEL, OVERSEAS_CHECKS, isOverseas, OUTCOMES, OUTCOME_LABEL, REACH, REPLY_TAG, STATUSES, STATUS_LABEL, TOKENS, emailedLine, inReach, nextLine,
  outreach, saidLine, sendable, type DraftEmail, type ImportAnswer, type LeadListName, type Lead, type LeadDetail, type LeadList, type LeadStatus, type OutreachReply, type PumpState, type Skipped,
} from "../lib/outreach";

// R-546 Cold calls: warehouses and would-be suppliers being cold called and emailed, kept apart from
// clients and suppliers until Make supplier. The phone has the same screen. A cold email is never sent by
// the server: this PC sends the queue (switched on in Cold calls settings), weekdays 9 to 4 New York time,
// the daily limit spread across those hours, and watches the cold email inbox for replies.

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ghost = "ui-btn";
const solid = "ui-btn ui-btn-ink";
const field = "w-full bg-transparent border border-line-3 rounded-lg px-3 py-2 text-[13.5px] text-ink focus:outline-none focus:border-ink transition-colors duration-150";
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
  const [imported, setImported] = useState<ImportAnswer | null>(null);
  const [view, setView] = useState<"leads" | "map" | "text" | "replies" | "overseas">("leads");
  // R-581: the list picked at the top ("" is every list) and a status on top of the chips ("" is any). The list is kept per computer.
  const [list, setListState] = useState<string>(() => { try { return localStorage.getItem(LIST_KEY) ?? ""; } catch { return ""; } });
  const setList = (n: string) => { setListState(n); try { localStorage.setItem(LIST_KEY, n); } catch { /* blocked: kept until reload */ } };
  const [status, setStatus] = useState<string>("");
  const [renaming, setRenaming] = useState<LeadListName | null>(null);
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

  const lists = useMemo(() => data?.lists ?? [], [data]);
  const everyLead = useMemo(() => data?.leads ?? [], [data]);
  // A list that is gone (renamed on another device) falls back to every list.
  const pickedList = lists.some((x) => x.name === list) ? list : "";
  // R-631: overseas suppliers live in their own tab, never among the warehouses, the map or the texts.
  const leads = useMemo(() => everyLead.filter((l) => !isOverseas(l) && (!pickedList || l.list === pickedList)), [everyLead, pickedList]);
  const overseas = useMemo(() => everyLead.filter(isOverseas), [everyLead]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => inReach(l, filter) && (!status || l.status === status)
      && (!q || `${l.company} ${l.city} ${l.state} ${l.email} ${l.contact_name} ${l.phone}`.toLowerCase().includes(q)));
  }, [leads, filter, status, query]);
  // Failed shows only while something failed (or it is the one picked).
  const chips: [string, string, number][] = REACH.map(([k, lb]): [string, string, number] => [k, lb, leads.filter((l) => inReach(l, k)).length])
    .filter(([k, , n]) => k !== "failed" || n > 0 || filter === "failed");
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);
  const toText = leads.filter((l) => l.no_reply && l.phone && !l.texted).length;

  const emailShown = () => {
    if (!data?.settings.address_line) { toast("Add your business address in Cold calls settings first. Every cold email has to carry it.", "error"); setSettingsOpen(true); return; }
    const ids = shown.filter((l) => sendable(l.status) && l.email).map((l) => l.id);
    if (!ids.length) { toast("No one in this list can get a cold email. They need an email address and a status of New, Called, Emailed or Not now.", "error"); return; }
    setCompose({ ids, bump: false });
  };

  // R-609: everyone on the picked list (or every list) never emailed, queued in one press in the saved words.
  const notEmailed = lists.filter((x) => !pickedList || x.name === pickedList).reduce((n, x) => n + (x.not_emailed ?? 0), 0);
  const queueAll = async () => {
    if (!data?.settings.address_line) { toast("Add your business address in Cold calls settings first. Every cold email has to carry it.", "error"); setSettingsOpen(true); return; }
    if (!notEmailed) { toast("Everyone here has been emailed or is waiting to send."); return; }
    const who = notEmailed === 1 ? "the 1 warehouse" : `the ${notEmailed} warehouses`;
    if (!confirm(`Queue the first email for ${who}${pickedList ? ` on ${pickedList}` : ""} never emailed? They go in your saved email, ${data.settings.daily_cap} a day, weekdays 9 to 4. No one already emailed gets it again.`)) return;
    try {
      const r = await outreach.queueAll(pickedList);
      toast(r.queued === 1 ? "1 email queued" : `${r.queued} emails queued`);
      load();
    } catch (e) { toast(msg(e), "error"); }
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
      : `Sending from ${st.send_from || "your email"}, ${st.hours}, up to ${st.daily_cap} a day.${data?.queue.line ? " " + data.queue.line : ""}${st.pump_note ? " " + st.pump_note : ""}`;

  return (
    <div className="min-w-0">
      <PageActions>
        <button className={ghost} onClick={() => setCompose({ ids: [], bump: true })}><Reply size={14} /> Bumps</button>
        <button className={ghost} onClick={() => setForm({})}><Plus size={14} /> Add</button>
        <button className={ghost} onClick={() => fileRef.current?.click()}><FileUp size={14} /> Import a sheet</button>
        <button className={ghost} onClick={() => setSettingsOpen(true)}><Settings2 size={14} /> Settings</button>
        <button className={ghost} onClick={queueAll}><ListPlus size={14} /> Queue everyone not emailed{notEmailed ? ` (${notEmailed})` : ""}</button>
        <button className={solid} onClick={emailShown}><Mail size={14} /> Email these</button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </PageActions>
      <p className="text-[13px] text-muted mb-5">Warehouses to call and email, kept apart from your clients and suppliers until one becomes a supplier.</p>

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 text-[13px] text-danger-ink bg-danger-bg rounded-lg px-3 py-2" role="alert">
          <span className="min-w-0">{error}</span>
          <button onClick={load} className={ghost}>Try again</button>
        </div>
      )}

      {data && (
        <>
          {lists.length > 0 && (
            <div className="flex gap-2.5 mb-4 overflow-x-auto pb-1">
              <ListCard name="All lists" n={{ name: "", total: everyLead.length, emailed: everyLead.filter((l) => l.emailed).length,
                replied: everyLead.filter((l) => l.replied).length, texted: everyLead.filter((l) => l.texted).length, suppliers: 0,
                waiting: lists.reduce((n, x) => n + (x.waiting ?? 0), 0), failed: lists.reduce((n, x) => n + (x.failed ?? 0), 0),
                not_emailed: lists.reduce((n, x) => n + (x.not_emailed ?? 0), 0) }}
                on={!pickedList} onPick={() => setList("")} />
              {lists.map((x) => (
                <ListCard key={x.name} name={x.name} n={x} on={pickedList === x.name} onPick={() => setList(x.name)} onRename={() => setRenaming(x)} />
              ))}
            </div>
          )}
          <div className="hsep" />
          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-x-6 py-4">
            {([["Due today", data.due], ["Waiting to send", data.queue.waiting], ["Sent today", data.queue.sent_today]] as [string, number][]).map(([l, v], i) => (
              <Fragment key={l}>
                {i > 0 && <div className="vsep" />}
                <div className="min-w-0">
                  <div className="ui-label">{l}</div>
                  <div className="ui-fig mt-1">{v}</div>
                </div>
              </Fragment>
            ))}
          </div>
          <div className="hsep mb-3" />
          <p className={`text-[13px] mb-5 ${!seen ? "text-warning-ink" : "text-muted"}`}>
            {pumpLine}
            {data.queue.failed > 0 && (
              <button onClick={() => { setView("leads"); setFilter("failed"); setStatus(""); setQuery(""); }} className="ml-1 text-danger-ink font-medium underline underline-offset-2">
                {data.queue.failed === 1 ? "1 failed to send" : `${data.queue.failed} failed to send`}. Show them
              </button>
            )}
          </p>

          <div className="mb-4">
            <Tabs label="Cold calls" value={view} onChange={(v) => setView(v as typeof view)}
              tabs={([["leads", "Warehouses", 0], ["map", "Map", 0], ["text", "To text", toText], ["replies", "Replies", data.replies_waiting ?? 0], ["overseas", "Overseas", 0]] as ["leads" | "map" | "text" | "replies" | "overseas", string, number][])
                .map(([id, label, n]) => ({ id, label, count: n > 0 ? n : undefined }))} />
          </div>

          {view === "overseas" ? <OverseasList leads={overseas} onOpen={setOpenId} onAdd={() => setForm({ kind: "overseas" })} />
          : view === "replies" ? <Replies settings={data.settings} onOpenLead={setOpenId} onChanged={load} onSettings={() => setSettingsOpen(true)} />
          : view === "map" ? <ColdCallsMap leads={leads} onOpen={setOpenId} />
          : view === "text" ? <TextList leads={leads} onOpen={setOpenId} onChanged={load} /> : <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <label className="ui-search w-64 max-w-full">
              <Search size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Company, city, email" aria-label="Search warehouses" />
            </label>
            {chips.map(([k, l, n]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`ui-opt ${filter === k ? "on" : ""}`}>
                {l} <span className="tabular-nums opacity-60 ml-1">{n}</span>
              </button>
            ))}
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="ui-btn">
              <option value="">Any status</option>
              {STATUSES.filter((x) => statusCounts[x]).map((x) => <option key={x} value={x}>{STATUS_LABEL[x]} ({statusCounts[x]})</option>)}
            </select>
          </div>

          {leads.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-muted">No warehouses yet. Import a sheet or add one.</div>
          ) : shown.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-muted">{filter === "due" && !query && !status ? "Nothing is due today." : "No warehouses match."}</div>
          ) : (
            <div className="divide-y divide-line border-t border-line">
              {shown.map((l) => {
                const place = [l.city, l.state].filter(Boolean).join(", ");
                const next = nextLine(l.next_touch, data.today);
                const said = saidLine(l.said);
                return (
                  <button key={l.id} onClick={() => setOpenId(l.id)} className="w-full text-left flex items-start gap-4 px-3 py-3.5 hover:bg-surface-2 transition-colors duration-150 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink truncate">{l.company}</div>
                      <div className="text-[12.5px] text-muted truncate">
                        {[place, KIND_LABEL[l.kind] ?? ""].filter(Boolean).join(" · ") || "No place yet"}
                        {/* The 216px sidebar takes a step off every breakpoint: below xl the emailed line rides here. */}
                        <span className="xl:hidden"> · {emailedLine(l)}</span>
                        {next && <span className={l.due ? "text-accent-hover font-medium" : ""}> · {next}</span>}
                        {l.queued ? <span> · {l.queued} to send</span> : null}
                      </div>
                      {said && <div className={`text-[13px] mt-1 line-clamp-1 ${l.said?.kind === "reply" ? "text-ink" : "text-ink-2"}`}>{said}</div>}
                      {(l.failed ?? 0) > 0 && <div className="text-[12.5px] mt-1 line-clamp-2 text-danger-ink">Failed: {l.failed_error || "open it to try again"}</div>}
                    </div>
                    <div className="w-[150px] flex-shrink-0 pt-0.5">
                      <div className={`text-[14px] tabular-nums truncate ${l.phone ? "text-ink" : "text-muted"}`}>{l.phone_shown || l.phone || "No phone"}</div>
                      {l.texted && <div className="text-[12px] text-success-ink truncate">Texted {agoDay(l.texted.at)}</div>}
                    </div>
                    <div className={`hidden xl:block w-[110px] flex-shrink-0 pt-0.5 text-[12.5px] ${l.emailed ? "text-ink-2" : "text-muted"}`}>{emailedLine(l)}</div>
                    <div className="flex-shrink-0 flex justify-end pt-0.5"><Pill s={l.status} /></div>
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
      {renaming && <RenameList n={renaming} onClose={() => setRenaming(null)} onSaved={(to) => { setRenaming(null); setList(to); load(); }} />}
      {settingsOpen && data && <SettingsOverlay settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); load(); }} />}
      {imported && (
        <Overlay title={imported.added === 1 ? "Added 1 warehouse" : `Added ${imported.added} warehouses`} onClose={() => setImported(null)}
          footer={<button className={solid} onClick={() => setImported(null)}>Done</button>}>
          {imported.need_address ? (
            <p className="text-[13px] text-warning-ink mb-3">Add your business address in Cold calls settings, then press Queue everyone not emailed.</p>
          ) : (imported.queued ?? 0) > 0 ? (
            <p className="text-[13px] text-ink-2 mb-3">{imported.queued === 1 ? "1 is" : `${imported.queued} are`} queued to send in your saved email, {data?.settings.daily_cap ?? 30} a day, weekdays 9 to 4.</p>
          ) : null}
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

const LIST_KEY = "ecliptr_coldcalls_list";

/** "Oct 20", or "today". */
function agoDay(iso: string): string {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return "";
  return t.toDateString() === new Date().toDateString() ? "today" : t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** R-581: one imported list at the top: its name, how many, and how far it got. */
function ListCard({ name, n, on, onPick, onRename }: { name: string; n: LeadListName; on: boolean; onPick: () => void; onRename?: () => void }) {
  const pct = (k: number) => (n.total ? Math.round((k / n.total) * 100) : 0);
  return (
    <div className={`relative flex-shrink-0 w-[220px] rounded-xl border px-3.5 py-3 transition-colors duration-150 ${on ? "border-ink" : "border-line hover:bg-surface-2"}`}>
      <button onClick={onPick} className="absolute inset-0 rounded-xl" aria-label={`Show ${name}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13.5px] font-medium text-ink truncate pr-1" title={name}>{name}</div>
        {onRename && (
          <button onClick={onRename} className="relative p-1 -m-1 rounded text-muted hover:text-ink hover:bg-surface-2" aria-label={`Rename ${name}`}><Pencil size={12} /></button>
        )}
      </div>
      <div className="text-[12px] text-muted tabular-nums">{n.total === 1 ? "1 warehouse" : `${n.total} warehouses`}</div>
      <div className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden flex">
        <div className="bg-ink" style={{ width: `${pct(n.replied)}%` }} />
        <div className="bg-muted" style={{ width: `${Math.max(0, pct(n.emailed) - pct(n.replied))}%` }} />
      </div>
      <div className="mt-1.5 text-[12px] text-ink-2 tabular-nums truncate">
        {n.emailed} of {n.total} emailed, {n.replied} replied{n.texted ? `, ${n.texted} texted` : ""}
      </div>
      {(n.waiting || n.failed || n.not_emailed) ? (
        <div className="text-[12px] text-muted tabular-nums truncate">
          {[n.not_emailed ? `${n.not_emailed} not emailed` : "", n.waiting ? `${n.waiting} waiting` : ""].filter(Boolean).join(", ")}
          {n.failed ? <span className="text-danger-ink">{n.not_emailed || n.waiting ? ", " : ""}{n.failed} failed</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function RenameList({ n, onClose, onSaved }: { n: LeadListName; onClose: () => void; onSaved: (to: string) => void }) {
  const [to, setTo] = useState(n.name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!to.trim() || to.trim() === n.name) return;
    setBusy(true);
    try { await outreach.renameList(n.name, to.trim()); toast("List renamed"); onSaved(to.trim()); }
    catch (e) { toast(msg(e), "error"); setBusy(false); }
  };
  return (
    <Overlay title="Rename this list" onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy || !to.trim() || to.trim() === n.name} onClick={save}>Rename</button></>}>
      <label className={label}>Name</label>
      <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} className={field} />
      <p className="text-[12px] text-muted mt-2">Every warehouse in it stays in it. Using another list's name puts the two together.</p>
    </Overlay>
  );
}

/** A phone number big enough to read off the screen, with Copy. */
function BigPhone({ l }: { l: Lead }) {
  const shown = l.phone_shown || l.phone;
  if (!shown) return <span className="text-[13px] text-muted">No phone</span>;
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(shown);
    toast(ok ? "Number copied" : COPY_FAILED, ok ? undefined : "error");
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[18px] font-medium text-ink tabular-nums select-text whitespace-nowrap">{shown}</span>
      <button onClick={copy} className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-surface-2" aria-label="Copy the number"><Copy size={14} /></button>
    </span>
  );
}

/** R-581: everyone reached by email or a call who never came back, with the number big, to text. Anyone on the team marks one
 * texted; the mark says who and when and moves nothing else. */
function TextList({ leads, onOpen, onChanged }: { leads: Lead[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [which, setWhich] = useState<"not" | "done" | "all">("not");
  const [busy, setBusy] = useState("");
  const pool = leads.filter((l) => l.no_reply);
  const withPhone = pool.filter((l) => l.phone);
  const shown = withPhone.filter((l) => which === "all" || (which === "done" ? !!l.texted : !l.texted));
  const mark = async (l: Lead, on: boolean) => {
    setBusy(l.id);
    try { await outreach.texted(l.id, on); toast(on ? `${l.company} marked texted` : "Mark taken back"); onChanged(); }
    catch (e) { toast(msg(e), "error"); }
    setBusy("");
  };
  const chips: ["not" | "done" | "all", string, number][] = [
    ["not", "Not texted", withPhone.filter((l) => !l.texted).length], ["done", "Texted", withPhone.filter((l) => l.texted).length], ["all", "All", withPhone.length],
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {chips.map(([k, lb, n]) => (
          <button key={k} onClick={() => setWhich(k)}
            className={`ui-opt ${which === k ? "on" : ""}`}>
            {lb} <span className="tabular-nums opacity-60 ml-1">{n}</span>
          </button>
        ))}
        <span className="text-[12px] text-muted">Called or emailed, and never heard back.{pool.length > withPhone.length ? ` ${pool.length - withPhone.length} more have no phone number.` : ""}</span>
      </div>
      {shown.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-muted">
          {withPhone.length === 0 ? "No one is waiting on a text. Everyone you called or emailed has answered, or has no number." : which === "not" ? "Every number here has been texted." : "None texted yet."}
        </div>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {shown.map((l) => (
            <div key={l.id} className="flex items-center gap-4 px-4 py-3 min-w-0">
              <button onClick={() => onOpen(l.id)} className="min-w-0 flex-1 text-left">
                <div className="text-[14px] font-medium text-ink truncate">{l.company}</div>
                <div className="text-[12.5px] text-muted truncate">{[[l.city, l.state].filter(Boolean).join(", "), emailedLine(l), l.contact_name].filter(Boolean).join(" · ")}</div>
                {l.said && <div className="text-[12.5px] text-ink-2 truncate mt-0.5">{saidLine(l.said)}</div>}
              </button>
              <div className="flex-shrink-0"><BigPhone l={l} /></div>
              <div className="w-[150px] flex-shrink-0 flex justify-end">
                {l.texted ? (
                  <div className="text-right">
                    <div className="text-[12.5px] text-success-ink inline-flex items-center gap-1"><Check size={13} />Texted {agoDay(l.texted.at)}</div>
                    <div className="text-[11.5px] text-muted">{l.texted.by || "The team"}, <button className="underline hover:text-ink" disabled={busy === l.id} onClick={() => mark(l, false)}>undo</button></div>
                  </div>
                ) : (
                  <button className={solid} disabled={busy === l.id} onClick={() => mark(l, true)}>Mark texted</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const tagPill = (t: string) => {
  const [lb, tone] = REPLY_TAG[t] ?? [t, "neutral" as const];
  return <StatusPill key={t} tone={tone}>{lb}</StatusPill>;
};

/** R-563: every reply in one place. What they said at a glance, and the ones still waiting on you first.
 *  R-638: an inbox. On a wide window the list sits on the left and the open email on the right; narrower, an
 *  email opens over the list. Reply writes back from here, with your signature and logo. */
function Replies({ settings, onOpenLead, onChanged, onSettings }: {
  settings: LeadList["settings"]; onOpenLead: (leadId: string) => void; onChanged: () => void; onSettings: () => void;
}) {
  const [list, setList] = useState<OutreachReply[] | null>(null);
  const [all, setAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList((await outreach.replies()).replies); } catch (e) { toast(msg(e), "error"); }
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!list) return <div className="py-16 text-center text-[13px] text-muted">Loading replies...</div>;
  const waiting = list.filter((r) => !r.answered);
  const shown = all ? list : waiting;
  const open = list.find((r) => r.id === openId) ?? null;
  // The wide inbox always shows an email: the one picked, else the first in the list.
  const side = open ?? shown[0] ?? null;
  const answer = async (r: OutreachReply) => {
    try { await outreach.markAnswered(r.id); toast("Marked answered"); await load(); onChanged(); }
    catch (e) { toast(msg(e), "error"); }
  };
  const done = async () => { await load(); onChanged(); };
  const pane = (r: OutreachReply) => (
    <EmailPane key={r.id} r={r} settings={settings} onAnswer={() => answer(r)} onSent={done} onSettings={onSettings}
      onOpenLead={() => { setOpenId(null); onOpenLead(r.lead_id); }} />
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([[false, "To answer", waiting.length], [true, "All replies", list.length]] as [boolean, string, number][]).map(([k, lb, n]) => (
          <button key={lb} onClick={() => setAll(k)}
            className={`ui-opt ${all === k ? "on" : ""}`}>
            {lb} <span className="tabular-nums opacity-60 ml-1">{n}</span>
          </button>
        ))}
        <span className="text-[12px] text-muted">A reply counts as answered once you reply here or from your mailbox, log a call, or mark it.</span>
      </div>
      {shown.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-muted">
          {list.length === 0 ? "No replies yet. When a warehouse answers a cold email it shows here." : "You have answered every reply."}
        </div>
      ) : (
        <div className="xl:grid xl:grid-cols-[minmax(320px,400px)_1fr] xl:border xl:border-line xl:rounded-2xl xl:overflow-hidden xl:h-[calc(100vh-260px)] xl:min-h-[520px]">
          <div className="divide-y divide-line border-t border-line xl:border-t-0 xl:border-r xl:overflow-y-auto min-w-0">
            {shown.map((r) => {
              const picked = side?.id === r.id;
              return (
                <button key={r.id} onClick={() => setOpenId(r.id)}
                  className={`w-full text-left block px-3 xl:px-4 py-3.5 hover:bg-surface-2 transition-colors duration-150 min-w-0 ${picked ? "xl:bg-surface-2" : ""}`}>
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className={`text-[14px] text-ink truncate ${r.answered ? "font-medium" : "font-semibold"}`}>{r.company}</span>
                    {r.contact_name && <span className="text-[12.5px] text-muted truncate">{r.contact_name}</span>}
                    <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{ago(r.at)}</span>
                  </div>
                  <div className="text-[12.5px] text-ink-2 truncate mt-0.5">{r.subject || "(no subject)"}</div>
                  <div className={`text-[13px] mt-0.5 line-clamp-2 ${r.answered ? "text-muted" : "text-ink"}`}>
                    {r.gist || "No new words in it. Open it to see the whole email."}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 whitespace-nowrap min-w-0">
                    {r.my_reply ? <StatusPill tone={r.my_reply.status === "failed" ? "danger" : "step"} size="md">{r.my_reply.status === "failed" ? "Reply failed" : "Reply sending"}</StatusPill>
                      : r.answered ? <span className="text-[12px] text-muted inline-flex items-center gap-1"><Check size={13} />{ANSWERED_HOW[r.answered_how] ?? "Answered"}</span>
                      : <StatusPill tone="warning" size="md">To answer</StatusPill>}
                    {r.tags.slice(0, 2).map(tagPill)}
                    {r.tags.length > 2 && <span className="text-[11.5px] text-muted">+{r.tags.length - 2}</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="hidden xl:block min-w-0 overflow-y-auto">{side && pane(side)}</div>
        </div>
      )}
      {open && (
        <div className="xl:hidden">
          <Overlay title={open.company} wide onClose={() => setOpenId(null)}>{pane(open)}</Overlay>
        </div>
      )}
    </>
  );
}

/** R-638: one reply laid out as an email (who, to, when, subject, what they said, your email before it), with Reply. */
function EmailPane({ r, settings, onAnswer, onSent, onOpenLead, onSettings }: {
  r: OutreachReply; settings: LeadList["settings"]; onAnswer: () => void; onSent: () => void; onOpenLead: () => void; onSettings: () => void;
}) {
  const [whole, setWhole] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const quoted = r.body.trim() !== r.new_text.trim();
  const who = r.contact_name || r.email;
  const initial = (r.contact_name || r.company || r.email).trim().charAt(0).toUpperCase();
  const me = settings.from_name ? `${settings.from_name} <${settings.send_from}>` : settings.send_from;
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`;
  const seen = settings.pump_seen_at ? new Date(settings.pump_seen_at).getTime() : 0;
  const sender = !seen || Date.now() - seen > 10 * 60_000
    ? "No computer is sending right now. It goes once Ecliptr is open on the computer with Send from this computer on."
    : `Goes from ${settings.send_from || "your email"} within a minute, in the same thread as their email.`;
  const pending = r.my_reply && r.my_reply.status !== "failed";
  const send = async () => {
    if (!draft?.trim()) { toast("Write your reply first.", "error"); return; }
    setBusy(true);
    try { await outreach.reply(r.id, draft); toast("Reply queued"); setDraft(null); onSent(); }
    catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <div className="px-1 xl:px-6 py-1 xl:py-5 min-w-0">
      <h2 className="text-[18px] font-semibold text-ink leading-snug break-words">{r.subject || "(no subject)"}</h2>
      <div className="mt-3 flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-full bg-surface-2 border border-line flex items-center justify-center text-[14px] font-semibold text-ink-2 flex-shrink-0">{initial}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <span className="text-[14px] font-semibold text-ink">{who}</span>
            {r.contact_name && <span className="text-[12.5px] text-muted select-text">&lt;{r.email}&gt;</span>}
            <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{when(r.at)}</span>
          </div>
          <div className="text-[12.5px] text-muted truncate">{r.company}</div>
          {settings.send_from && <div className="text-[12.5px] text-muted truncate">To {me}</div>}
        </div>
      </div>
      {(r.tags.length > 0 || r.phone) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {r.tags.map(tagPill)}
          {r.phone && <span className="text-[12.5px] text-ink-2 inline-flex items-center gap-1 select-text"><Phone size={12} className="text-muted" />{r.phone}</span>}
        </div>
      )}
      <div className="mt-4 text-[14px] text-ink leading-relaxed whitespace-pre-wrap break-words select-text">
        {(whole ? r.body : r.new_text) || r.body || "The email had no text."}
      </div>
      {quoted && (
        <button className="mt-2 text-[12.5px] text-accent-hover hover:underline" onClick={() => setWhole(!whole)}>
          {whole ? "Show only what they wrote" : "Show the whole email"}
        </button>
      )}

      <div className="mt-5 text-[12.5px]">
        {r.my_reply?.status === "failed" ? <span className="text-danger-ink">Your reply did not send: {r.my_reply.error}</span>
          : pending ? <span className="text-ink-2">Your reply is waiting to send. {sender}</span>
          : r.answered ? <span className="text-muted">{ANSWERED_HOW[r.answered_how] ?? "Answered"} {ago(r.answered_at)}.</span>
          : <span className="text-warning-ink font-medium">You have not answered this yet.</span>}
      </div>

      {draft === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!pending && r.status !== "do_not_contact" && (
            <button className={solid} onClick={() => setDraft(r.my_reply?.status === "failed" ? r.my_reply.text : "")}><Reply size={14} /> Reply</button>
          )}
          {!r.answered && !pending && <button className={ghost} onClick={onAnswer}><Check size={14} /> Mark answered</button>}
          <button className={ghost} onClick={onOpenLead}>Open warehouse</button>
        </div>
      ) : (
        <div className="mt-3 border border-line-3 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line text-[12.5px] space-y-0.5">
            <div className="truncate"><span className="text-muted">To </span><span className="text-ink">{r.contact_name ? `${r.contact_name} <${r.email}>` : r.email}</span></div>
            <div className="truncate"><span className="text-muted">Subject </span><span className="text-ink">{subject}</span></div>
          </div>
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={7}
            className="w-full bg-transparent px-4 py-3 text-[14px] text-ink leading-relaxed focus:outline-none resize-y block" placeholder={`Write to ${who}`} />
          <div className="px-4 pb-3">
            {settings.signature || settings.signature_logo ? (
              <div className="text-[13px] text-ink-2 whitespace-pre-wrap border-t border-dashed border-line pt-2.5">
                {settings.signature}
                {settings.signature_logo && <img src={settings.signature_logo} alt="Your logo" className="mt-2 max-w-[200px] max-h-[80px] object-contain block" />}
              </div>
            ) : (
              <button className="text-[12.5px] text-accent-hover hover:underline" onClick={onSettings}>Add your signature and logo in Cold calls settings</button>
            )}
          </div>
          <div className="px-4 py-2.5 border-t border-line flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted min-w-0 flex-1">{sender} Their email is quoted under yours.</span>
            <button className={ghost} onClick={() => setDraft(null)}>Discard</button>
            <button className={solid} disabled={busy} onClick={send}><Reply size={14} /> Send</button>
          </div>
        </div>
      )}

      {r.yours && (
        <div className="mt-6 border-t border-line pt-4">
          <div className="text-[12px] text-muted mb-1">Your email before this, {when(r.yours.at)}</div>
          <div className="text-[12.5px] text-ink-2 whitespace-pre-wrap select-text line-clamp-[10] border-l-2 border-line pl-3">{r.yours.body}</div>
        </div>
      )}
    </div>
  );
}

/** R-631: overseas suppliers, each with how many of the safety checks it has passed. Pay no one until all are ticked. */
function OverseasList({ leads, onOpen, onAdd }: { leads: Lead[]; onOpen: (id: string) => void; onAdd: () => void }) {
  const sorted = [...leads].sort((a, b) => Number(!!b.checks?.cleared) - Number(!!a.checks?.cleared) || a.company.localeCompare(b.company));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <p className="text-[13px] text-muted flex-1 min-w-[260px]">
          Overseas suppliers of name brand closeouts. Send no money until every check on a supplier is ticked. They never get the warehouse cold email on their own.
        </p>
        <button className={solid} onClick={onAdd}><Plus size={14} /> Add overseas supplier</button>
      </div>
      {sorted.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-muted">No overseas suppliers yet. Add one when you meet them at a show, on LinkedIn or through someone you trust.</div>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {sorted.map((l) => {
            const n = Object.keys(l.checks?.done ?? {}).length;
            return (
              <button key={l.id} onClick={() => onOpen(l.id)} className="w-full text-left flex items-center gap-4 px-3 py-3.5 hover:bg-surface-2 transition-colors duration-150 min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium text-ink truncate">{l.company}</div>
                  <div className="text-[12.5px] text-muted truncate">{[l.country || "No country yet", l.contact_name, l.email].filter(Boolean).join(" · ")}</div>
                </div>
                {l.checks?.cleared
                  ? <StatusPill tone="success" size="md">Cleared</StatusPill>
                  : <StatusPill tone={n === 0 ? "danger" : "warning"} size="md">{n} of {OVERSEAS_CHECKS.length} checks</StatusPill>}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
    : e.kind === "answered" ? "Marked answered"
    : e.kind === "text" ? "Texted"
    : e.kind === "untext" ? "Texted mark taken back" : "Note";
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
                {l.phone && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <BigPhone l={l} />
                    {l.texted
                      ? <span className="text-[12.5px] text-success-ink">Texted {agoDay(l.texted.at)}{l.texted.by ? ` by ${l.texted.by}` : ""}, <button className="underline" disabled={busy} onClick={() => act(() => outreach.texted(l.id, false), "Mark taken back")}>undo</button></span>
                      : <button className={ghost + " h-8"} disabled={busy} onClick={() => act(() => outreach.texted(l.id, true), "Marked texted")}>Mark texted</button>}
                  </div>
                )}
                {l.email && <div className="flex items-center gap-2"><Mail size={13} className="text-muted" /><span className="select-text">{l.email}</span></div>}
                {site && <div><a href={site} target="_blank" rel="noreferrer" className="text-accent-hover hover:underline">{l.website}</a></div>}
                <div className="text-muted">{[[l.city, l.state, l.country].filter(Boolean).join(", "), KIND_LABEL[l.kind] ?? "", l.source].filter(Boolean).join(" · ")}</div>
                <div className="text-muted">{emailedLine(l)}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {sendable(l.status) && l.email && <button className={ghost} onClick={() => onEmail(l.id)}><Mail size={14} /> Email</button>}
                <button className={ghost} onClick={() => onEdit(l)}>Edit</button>
                {l.status !== "supplier" && mayAddSupplier && (
                  <button className={ghost} disabled={busy} onClick={() => act(() => outreach.makeSupplier(l.id), `${l.company} is now in Suppliers`)}>Make supplier</button>
                )}
              </div>
            </section>

            {/* R-631: an overseas supplier's checks, ticked one by one with who and when. Cleared only when all are. */}
            {isOverseas(l) && (
              <section>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-[13px] font-medium text-ink">Before you send money</div>
                  {l.checks?.cleared ? <StatusPill tone="success">Cleared</StatusPill> : <StatusPill tone="warning">Not cleared</StatusPill>}
                </div>
                <div className="space-y-2">
                  {OVERSEAS_CHECKS.map(([key, title, how]) => {
                    const done = l.checks?.done?.[key];
                    return (
                      <label key={key} className="flex items-start gap-3 rounded-xl border border-line px-3 py-2.5 cursor-pointer hover:bg-surface-2">
                        <input type="checkbox" className="mt-0.5" checked={!!done} disabled={busy}
                          onChange={(e) => act(() => outreach.check(l.id, key, e.target.checked))} />
                        <span className="min-w-0">
                          <span className="block text-[13.5px] text-ink">{title}</span>
                          <span className="block text-[12px] text-muted">{done ? `Ticked ${agoDay(done.at)}${done.by ? ` by ${done.by}` : ""}` : how}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            )}

            {/* R-581: what they said, always first: every reply's gist and every call, newest first. */}
            <section>
              <div className="text-[13px] font-medium text-ink mb-2">What they said</div>
              {!d.said?.length ? <div className="text-[12.5px] text-muted">Nothing yet. Replies and calls show here.</div> : (
                <div className="space-y-2">
                  {d.said.map((x, i) => (
                    <div key={i} className={`rounded-xl border px-3 py-2.5 ${x.kind === "reply" ? "border-accent/30 bg-accent/5" : "border-line"}`}>
                      <div className="flex items-baseline justify-between gap-3 text-[12px] text-muted">
                        <span className="font-medium text-ink-2">{x.kind === "reply" ? "Their reply" : x.kind === "call" ? `Call: ${OUTCOME_LABEL[x.outcome] ?? x.outcome}` : "Note"}</span>
                        <span className="whitespace-nowrap">{ago(x.at)}{x.by ? ` · ${x.by}` : ""}</span>
                      </div>
                      {x.text && <div className="text-[13.5px] text-ink mt-0.5 select-text">{x.text}</div>}
                      {x.tags.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{x.tags.map(tagPill)}</div>}
                    </div>
                  ))}
                </div>
              )}
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
      state: f.state ?? "", kind: f.kind ?? "", website: f.website ?? "", personal_line: f.personal_line ?? "", notes: f.notes ?? "", country: f.country ?? "" };
    try {
      const r = lead.id ? (await outreach.edit(lead.id, body), lead.id) : (await outreach.add(body)).id;
      onSaved(r);
    } catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <Overlay title={isOverseas(f) ? (lead.id ? "Edit overseas supplier" : "Add an overseas supplier") : lead.id ? "Edit warehouse" : "Add a warehouse"} onClose={onClose}
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
        <div><label className={label}>Country</label><input value={f.country ?? ""} onChange={set("country")} className={field} placeholder={isOverseas(f) ? "Italy" : ""} /></div>
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
  const [f, setF] = useState({ send_from: settings.send_from, from_name: settings.from_name, address_line: settings.address_line, daily_cap: String(settings.daily_cap || 30),
    signature: settings.signature ?? "", signature_logo: settings.signature_logo ?? "" });
  const [busy, setBusy] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  // R-638: the logo is shrunk here to at most 400 by 160 and kept as a PNG, so every reply carries a small picture.
  const pickLogo = (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast("Choose a PNG or JPEG picture.", "error"); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 400 / img.width, 160 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const data = c.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
      if (data.length > 400_000) { toast("That picture is too big even when shrunk. Try a simpler logo.", "error"); return; }
      setF((v) => ({ ...v, signature_logo: data }));
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("That picture could not be read.", "error"); };
    img.src = url;
  };
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
      await outreach.saveSettings({ send_from: f.send_from.trim(), from_name: f.from_name.trim(), address_line: f.address_line.trim(), daily_cap: parseInt(f.daily_cap, 10) || 30,
        signature: f.signature, signature_logo: f.signature_logo });
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
        <div>
          <label className={label}>Reply signature</label>
          <textarea value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} rows={4} className={field + " resize-y"}
            placeholder={"Jack\nBJM Distributions\n(555) 010-0000"} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {f.signature_logo && <img src={f.signature_logo} alt="Your logo" className="max-w-[200px] max-h-[80px] object-contain border border-line rounded-lg p-1" />}
            <button type="button" className={ghost} onClick={() => logoRef.current?.click()}>{f.signature_logo ? "Change logo" : "Add logo"}</button>
            {f.signature_logo && <button type="button" className={ghost} onClick={() => setF({ ...f, signature_logo: "" })}>Remove logo</button>}
            <input ref={logoRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <p className="text-[12px] text-muted mt-1">Ends every reply you send from Replies, with the logo under it. Cold emails and bumps stay plain text.</p>
        </div>
      </div>
    </Overlay>
  );
}
