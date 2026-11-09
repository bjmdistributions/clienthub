import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Phone, Reply, Settings2, X } from "lucide-react";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import { shrinkLogo } from "../lib/logo";
import { LEAD_HOW, outreach, type OutreachSettings, type SupplierLead } from "../lib/outreach";

// R-642: supplier leads from the website form, as an inbox. On a wide window the list sits on the left and the open
// lead on the right; narrower, a lead opens over the list. Each one reads like an email: who, how to reach them, what
// they told the form, then every email since. Reply sends from the computer that sends cold email, within a minute,
// with the signature and logo. The leads are the notifications the form already makes; nothing is copied.

/** Where Notifications' Reply asks this inbox to open on a lead. */
export const LEAD_OPEN_KEY = "ecliptr_supplier_lead_open";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ghost = "ui-btn";
const solid = "ui-btn ui-btn-ink";
const field = "w-full bg-transparent border border-line-3 rounded-lg px-3 py-2 text-[13.5px] text-ink focus:outline-none focus:border-ink transition-colors duration-150";

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

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

export default function SupplierLeadsInbox({ onCount }: { onCount?: (n: number) => void }) {
  const [list, setList] = useState<SupplierLead[] | null>(null);
  const [settings, setSettings] = useState<OutreachSettings | null>(null);
  const [all, setAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sigOpen, setSigOpen] = useState(false);

  const countRef = useRef(onCount);
  countRef.current = onCount;
  const load = useCallback(async () => {
    try {
      const r = await outreach.supplierLeads();
      setList(r.leads);
      countRef.current?.(r.waiting);
    } catch (e) { toast(msg(e), "error"); }
  }, []);
  // Notifications' Reply leaves the lead's id here and says so; the inbox opens on it whether or not it was showing.
  useEffect(() => {
    const take = () => {
      try {
        const id = localStorage.getItem(LEAD_OPEN_KEY);
        if (id) { setOpenId(id); localStorage.removeItem(LEAD_OPEN_KEY); }
      } catch { /* storage blocked */ }
    };
    take();
    window.addEventListener("supplier-lead-open", take);
    return () => window.removeEventListener("supplier-lead-open", take);
  }, []);
  useEffect(() => {
    load();
    outreach.settings().then(setSettings).catch(() => {});
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!list) return <div className="py-16 text-center text-[13px] text-muted">Loading supplier leads...</div>;
  const waiting = list.filter((l) => !l.answered);
  const opened = list.find((l) => l.id === openId) ?? null;
  // A lead opened from Notifications shows even when it is not in the filter.
  const shown = all ? list : waiting.concat(opened && opened.answered ? [opened] : []);
  const side = opened ?? shown[0] ?? null;
  const answer = async (l: SupplierLead) => {
    try { await outreach.supplierAnswered(l.id); toast("Marked answered"); await load(); }
    catch (e) { toast(msg(e), "error"); }
  };
  const pane = (l: SupplierLead) => (
    <LeadPane key={l.id} l={l} settings={settings} onAnswer={() => answer(l)} onSent={load} onSignature={() => setSigOpen(true)} />
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([[false, "To answer", waiting.length], [true, "All leads", list.length]] as [boolean, string, number][]).map(([k, lb, n]) => (
          <button key={lb} onClick={() => setAll(k)} className={`ui-opt ${all === k ? "on" : ""}`}>
            {lb} <span className="tabular-nums opacity-60 ml-1">{n}</span>
          </button>
        ))}
        <span className="text-[12px] text-muted">Suppliers who filled out the form on your website. A lead counts as answered once you reply here or from your mailbox, or mark it.</span>
        <button className={`${ghost} ml-auto`} onClick={() => setSigOpen(true)}><Settings2 size={14} /> Signature</button>
      </div>
      {shown.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-muted">
          {list.length === 0 ? "No supplier leads yet. When a supplier fills out the form on your website it shows here." : "You have answered every supplier lead."}
        </div>
      ) : (
        <div className="xl:grid xl:grid-cols-[minmax(320px,400px)_1fr] xl:border xl:border-line xl:rounded-2xl xl:overflow-hidden xl:h-[calc(100vh-220px)] xl:min-h-[520px]">
          <div className="divide-y divide-line border-t border-line xl:border-t-0 xl:border-r xl:overflow-y-auto min-w-0">
            {shown.map((l) => (
              <button key={l.id} onClick={() => setOpenId(l.id)}
                className={`w-full text-left block px-3 xl:px-4 py-3.5 hover:bg-surface-2 transition-colors duration-150 min-w-0 ${side?.id === l.id ? "xl:bg-surface-2" : ""}`}>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className={`text-[14px] text-ink truncate ${l.answered ? "font-medium" : "font-semibold"}`}>{l.name || l.company || l.email || "Supplier lead"}</span>
                  {l.name && l.company && <span className="text-[12.5px] text-muted truncate">{l.company}</span>}
                  <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{ago(l.last_at)}</span>
                </div>
                <div className="text-[12.5px] text-ink-2 truncate mt-0.5">{l.subject}</div>
                <div className={`text-[13px] mt-0.5 line-clamp-2 ${l.answered ? "text-muted" : "text-ink"}`}>{l.gist || "No details came with this one."}</div>
                <div className="mt-1.5 flex items-center gap-1.5 whitespace-nowrap min-w-0">
                  {l.my_reply ? <StatusPill tone={l.my_reply.status === "failed" ? "danger" : "step"} size="md">{l.my_reply.status === "failed" ? "Reply failed" : "Reply sending"}</StatusPill>
                    : l.answered ? <span className="text-[12px] text-muted inline-flex items-center gap-1"><Check size={13} />{LEAD_HOW[l.answered_how] ?? "Answered"}</span>
                    : <StatusPill tone="warning" size="md">To answer</StatusPill>}
                  {l.thread.length > 0 && <span className="text-[12px] text-muted">{l.thread.length + 1} messages</span>}
                </div>
              </button>
            ))}
          </div>
          <div className="hidden xl:block min-w-0 overflow-y-auto">{side && pane(side)}</div>
        </div>
      )}
      {opened && (
        <div className="xl:hidden">
          <Overlay title={opened.name || opened.company || "Supplier lead"} wide onClose={() => setOpenId(null)}>{pane(opened)}</Overlay>
        </div>
      )}
      {sigOpen && <SignatureOverlay settings={settings} onClose={() => setSigOpen(false)} onSaved={(s) => { setSettings(s); setSigOpen(false); }} />}
    </>
  );
}

/** One lead as an email: the form as their first message, then every email since, then Reply. */
function LeadPane({ l, settings, onAnswer, onSent, onSignature }: {
  l: SupplierLead; settings: OutreachSettings | null; onAnswer: () => void; onSent: () => void; onSignature: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = l.name || l.company || l.email;
  const initial = (who || "?").trim().charAt(0).toUpperCase();
  const me = settings?.from_name ? `${settings.from_name} <${settings.send_from}>` : settings?.send_from || "";
  const lastIn = [...l.thread].reverse().find((m) => m.dir === "in");
  const base = lastIn?.subject || l.subject;
  const subject = /^re:/i.test(base) ? base : `Re: ${base}`;
  const seen = settings?.pump_seen_at ? new Date(settings.pump_seen_at).getTime() : 0;
  const sender = !seen || Date.now() - seen > 10 * 60_000
    ? "No computer is sending right now. It goes once Ecliptr is open on the computer with Send from this computer on (Cold calls settings)."
    : `Goes from ${settings?.send_from || "your email"} within a minute.`;
  const pending = l.my_reply && l.my_reply.status !== "failed";
  const send = async () => {
    if (!draft?.trim()) { toast("Write your reply first.", "error"); return; }
    setBusy(true);
    try { await outreach.supplierReply(l.id, draft); toast("Reply queued"); setDraft(null); onSent(); }
    catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  const message = l.lines.find((x) => x.label === "Message");
  const facts = l.lines.filter((x) => x.label !== "Message");
  return (
    <div className="px-1 xl:px-6 py-1 xl:py-5 min-w-0">
      <h2 className="text-[18px] font-semibold text-ink leading-snug break-words">{l.subject}</h2>
      <div className="mt-3 flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-full bg-surface-2 border border-line flex items-center justify-center text-[14px] font-semibold text-ink-2 flex-shrink-0">{initial}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <span className="text-[14px] font-semibold text-ink">{who}</span>
            {l.email && who !== l.email && <span className="text-[12.5px] text-muted select-text">&lt;{l.email}&gt;</span>}
            <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{when(l.at)}</span>
          </div>
          {l.name && l.company && <div className="text-[12.5px] text-muted truncate">{l.company}</div>}
          <div className="text-[12.5px] text-muted truncate">Sent from the form on your website{me ? `, to ${me}` : ""}</div>
          {l.phone && <div className="text-[12.5px] text-ink-2 inline-flex items-center gap-1 select-text mt-0.5"><Phone size={12} className="text-muted" />{l.phone}</div>}
        </div>
      </div>
      <div className="mt-4 text-[14px] text-ink leading-relaxed select-text min-w-0">
        {message && <p className="whitespace-pre-wrap break-words mb-3">{message.value}</p>}
        {facts.length > 0 ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {facts.map((x) => (
              <div key={x.label} className="contents">
                <dt className="text-muted">{x.label}</dt>
                <dd className="text-ink break-words min-w-0">{x.value}</dd>
              </div>
            ))}
          </dl>
        ) : !message && <p className="text-muted">No details came with this one.</p>}
      </div>

      {l.thread.map((m, i) => (
        <div key={i} className="mt-5 border-t border-line pt-4 min-w-0">
          <div className="flex items-baseline gap-2 text-[12.5px] min-w-0">
            <span className="font-semibold text-ink">{m.dir === "in" ? who : "You"}</span>
            <span className="text-muted truncate">{m.subject}</span>
            <span className="ml-auto text-muted whitespace-nowrap">{when(m.at)}</span>
          </div>
          <div className={`mt-1.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words select-text ${m.dir === "in" ? "text-ink" : "text-ink-2"}`}>{m.body || m.whole || "The email had no text."}</div>
        </div>
      ))}

      <div className="mt-5 text-[12.5px]">
        {l.my_reply?.status === "failed" ? <span className="text-danger-ink">Your reply did not send: {l.my_reply.error}</span>
          : pending ? <span className="text-ink-2">Your reply is waiting to send. {sender}</span>
          : l.answered ? <span className="text-muted">{LEAD_HOW[l.answered_how] ?? "Answered"}{l.answered_at ? ` ${ago(l.answered_at)}` : ""}.</span>
          : <span className="text-warning-ink font-medium">You have not answered this yet.</span>}
      </div>

      {draft === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!pending && l.email && <button className={solid} onClick={() => setDraft(l.my_reply?.status === "failed" ? l.my_reply.text : `Hi${l.name ? " " + l.name.split(/\s+/)[0] : ""},\n\n`)}><Reply size={14} /> Reply</button>}
          {!l.answered && !pending && <button className={ghost} onClick={onAnswer}><Check size={14} /> Mark answered</button>}
          {!l.email && <span className="text-[12.5px] text-muted self-center">They left no email address, so there is nobody to reply to.</span>}
        </div>
      ) : (
        <div className="mt-3 border border-line-3 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line text-[12.5px] space-y-0.5">
            <div className="truncate"><span className="text-muted">To </span><span className="text-ink">{l.name ? `${l.name} <${l.email}>` : l.email}</span></div>
            <div className="truncate"><span className="text-muted">Subject </span><span className="text-ink">{subject}</span></div>
          </div>
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={7}
            className="w-full bg-transparent px-4 py-3 text-[14px] text-ink leading-relaxed focus:outline-none resize-y block" placeholder={`Write to ${who}`} />
          <div className="px-4 pb-3">
            {settings?.signature || settings?.signature_logo ? (
              <div className="text-[13px] text-ink-2 whitespace-pre-wrap border-t border-dashed border-line pt-2.5">
                {settings.signature}
                {settings.signature_logo && <img src={settings.signature_logo} alt="Your logo" className="mt-2 max-w-[200px] max-h-[80px] object-contain block" />}
              </div>
            ) : (
              <button className="text-[12.5px] text-accent-hover hover:underline" onClick={onSignature}>Add your signature and logo</button>
            )}
          </div>
          <div className="px-4 py-2.5 border-t border-line flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted min-w-0 flex-1">{sender} {lastIn ? "Their last email is quoted under yours." : "What they sent the form is quoted under yours."}</span>
            <button className={ghost} onClick={() => setDraft(null)}>Discard</button>
            <button className={solid} disabled={busy} onClick={send}><Reply size={14} /> Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The reply signature and logo, shared with Cold calls replies. */
function SignatureOverlay({ settings, onClose, onSaved }: { settings: OutreachSettings | null; onClose: () => void; onSaved: (s: OutreachSettings) => void }) {
  const [sig, setSig] = useState(settings?.signature ?? "");
  const [logo, setLogo] = useState(settings?.signature_logo ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const save = async () => {
    setBusy(true);
    try { const s = await outreach.saveSignature(sig.replace(/\s+$/, ""), logo); toast("Saved"); onSaved(s); }
    catch (e) { toast(msg(e), "error"); }
    setBusy(false);
  };
  return (
    <Overlay title="Reply signature" onClose={onClose}
      footer={<><button className={ghost} onClick={onClose}>Cancel</button><button className={solid} disabled={busy} onClick={save}>Save</button></>}>
      <textarea value={sig} onChange={(e) => setSig(e.target.value)} rows={4} className={field + " resize-y"} placeholder={"Your name\nCompany\nPhone"} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {logo && <img src={logo} alt="Your logo" className="max-w-[200px] max-h-[80px] object-contain border border-line rounded-lg p-1" />}
        <button type="button" className={ghost} onClick={() => ref.current?.click()}>{logo ? "Change logo" : "Add logo"}</button>
        {logo && <button type="button" className={ghost} onClick={() => setLogo("")}>Remove logo</button>}
        <input ref={ref} type="file" accept="image/png,image/jpeg" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) shrinkLogo(f).then(setLogo).catch((x) => toast(msg(x), "error")); }} />
      </div>
      <p className="text-[12px] text-muted mt-2">Ends every reply you send to a supplier lead or a Cold calls reply, with the logo under it.</p>
    </Overlay>
  );
}
