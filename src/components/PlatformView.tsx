import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "./Toast";
import { Building2, Users, UserCircle, RefreshCw, Send, Mail, MessageSquare, ClipboardList, Check, Minus } from "lucide-react";

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function relTime(s?: string | null): string {
  if (!s) return "never";
  const ms = Date.now() - new Date(s).getTime();
  if (isNaN(ms)) return "—";
  const d = Math.floor(ms / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

const PLANS = ["free", "pro", "business", "unlimited", "founder"];
const COLS = "grid grid-cols-[1.4fr_1.7fr_1fr_0.9fr_0.55fr_0.55fr_0.8fr] gap-2";

type Tab = "orgs" | "broadcast" | "waitlist" | "feedback" | "onboarding";

export default function PlatformView() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("orgs");
  const [savingPlan, setSavingPlan] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.getPlatformSignups()
      .then((r) => { setOrgs(r.orgs || []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const changePlan = (orgId: string, plan: string) => {
    setSavingPlan(orgId);
    api.adminSetOrgPlan(orgId, plan)
      .then(() => { toast("Plan updated"); load(); })
      .catch((e) => toast(String(e), "error"))
      .finally(() => setSavingPlan(null));
  };

  const totalMembers = orgs.reduce((a, o) => a + (o.members || 0), 0);
  const totalClients = orgs.reduce((a, o) => a + (o.clients || 0), 0);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-[18px] font-semibold text-ink tracking-tight">Platform</h2>
          <p className="text-[12px] text-muted mt-0.5">Every workspace signed up on Ecliptr.</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 h-9 border border-line rounded-lg text-[13px] text-ink-2 hover:bg-surface-2 transition-colors">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {err ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
            <Stat icon={Building2} label="Signups" value={orgs.length} />
            <Stat icon={UserCircle} label="Total members" value={totalMembers} />
            <Stat icon={Users} label="Total clients" value={totalClients} />
          </div>

          <div className="flex items-center gap-1 mb-4 border-b border-line">
            <TabBtn active={tab === "orgs"} onClick={() => setTab("orgs")}>Workspaces</TabBtn>
            <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")}>Broadcast</TabBtn>
            <TabBtn active={tab === "waitlist"} onClick={() => setTab("waitlist")}>Waitlist</TabBtn>
            <TabBtn active={tab === "feedback"} onClick={() => setTab("feedback")}>Feedback</TabBtn>
            <TabBtn active={tab === "onboarding"} onClick={() => setTab("onboarding")}>Onboarding</TabBtn>
          </div>

          {tab === "orgs" && (
            <div className="bg-surface border border-line rounded-xl overflow-hidden">
              <div className={`${COLS} px-4 py-2.5 text-[12.5px] font-medium text-muted border-b border-line`}>
                <div>Workspace</div><div>Owner</div><div>Plan</div><div>Signed up</div><div>Members</div><div>Clients</div><div>Last active</div>
              </div>
              {orgs.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">No signups yet.</div>}
              {orgs.map((o) => (
                <div key={o.org_id} className={`${COLS} px-4 py-2.5 text-[12.5px] items-center border-b border-line last:border-0`}>
                  <div className="text-ink font-medium truncate" title={o.name}>{o.name || "—"}</div>
                  <div className="text-ink-2 truncate" title={o.owner_email || ""}>{o.owner_email || "—"}</div>
                  <div>
                    <select
                      value={o.plan || "free"}
                      disabled={savingPlan === o.org_id}
                      onChange={(e) => changePlan(o.org_id, e.target.value)}
                      className="border border-line h-8 pl-2 pr-1 rounded-md text-[12px] text-ink-2 capitalize bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
                    >
                      {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="text-muted tabular-nums">{fmtDate(o.created_at)}</div>
                  <div className="text-ink-2 tabular-nums">{o.members ?? 0}</div>
                  <div className="text-ink-2 tabular-nums">{o.clients ?? 0}</div>
                  <div className="text-muted">{relTime(o.last_event_at)}</div>
                </div>
              ))}
            </div>
          )}

          {tab === "broadcast" && <Broadcast />}
          {tab === "waitlist" && <Waitlist />}
          {tab === "feedback" && <Feedback />}
          {tab === "onboarding" && <Onboarding />}
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted mb-2"><Icon size={13} /> {label}</div>
      <div className="text-[24px] font-bold text-ink tabular-nums">{value}</div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 h-9 text-[13px] font-medium -mb-px border-b-2 transition-colors ${active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink-2"}`}
    >
      {children}
    </button>
  );
}

// ── Broadcast composer ─────────────────────────────────────────────────────
function Broadcast() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accounts, setAccounts] = useState(true);
  const [waitlist, setWaitlist] = useState(false);
  const [preview, setPreview] = useState<{ recipients: number; sample: string[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Any edit to the audience or content invalidates a stale preview so Send
  // can never fire against a count the owner didn't actually see.
  const resetPreview = () => setPreview(null);

  const runPreview = () => {
    if (!accounts && !waitlist) { toast("Pick at least one audience.", "error"); return; }
    setPreviewing(true);
    api.adminBroadcastPreview(accounts, waitlist)
      .then((r) => setPreview(r))
      .catch((e) => { setPreview(null); toast(String(e), "error"); })
      .finally(() => setPreviewing(false));
  };

  const doSend = () => {
    setConfirm(false);
    setSending(true);
    api.adminBroadcastSend(subject.trim(), body.trim(), accounts, waitlist)
      .then((r) => {
        toast(`Broadcast queued — ${r.recipients} recipients (id ${r.id.slice(0, 8)})`);
        setSubject(""); setBody(""); setPreview(null);
      })
      .catch((e) => toast(String(e), "error"))
      .finally(() => setSending(false));
  };

  const canSend = !!preview && preview.recipients > 0 && subject.trim().length > 0 && body.trim().length > 0;

  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Mail size={15} className="text-muted" />
        <h3 className="text-[14px] font-semibold text-ink">Broadcast</h3>
      </div>
      <p className="text-[12px] text-muted mb-4">Send a one-off announcement from the Ecliptr platform email.</p>

      <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Subject</label>
      <input
        value={subject}
        onChange={(e) => { setSubject(e.target.value); resetPreview(); }}
        placeholder="What's new in Ecliptr"
        className="w-full border border-line rounded-lg px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent mb-3"
      />

      <label className="block text-[12.5px] font-medium text-ink-2 mb-1">Message</label>
      <textarea
        value={body}
        onChange={(e) => { setBody(e.target.value); resetPreview(); }}
        rows={7}
        placeholder="Write your announcement…"
        className="w-full border border-line rounded-lg px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none mb-3"
      />

      <div className="flex items-center gap-5 mb-4">
        <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
          <input type="checkbox" checked={accounts} onChange={(e) => { setAccounts(e.target.checked); resetPreview(); }} className="accent-accent" />
          Signed-up accounts
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
          <input type="checkbox" checked={waitlist} onChange={(e) => { setWaitlist(e.target.checked); resetPreview(); }} className="accent-accent" />
          Waitlist
        </label>
      </div>

      {preview && (
        <div className="bg-surface-2 border border-line rounded-lg px-3 py-2.5 mb-4 text-[12.5px] text-ink-2">
          <span className="font-medium text-ink tabular-nums">{preview.recipients}</span> recipient{preview.recipients === 1 ? "" : "s"}
          {preview.sample.length > 0 && (
            <span className="text-muted"> · {preview.sample.slice(0, 5).join(", ")}{preview.recipients > preview.sample.length ? "…" : ""}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={runPreview}
          disabled={previewing || (!accounts && !waitlist)}
          className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
        >
          {previewing ? "Checking…" : "Preview recipients"}
        </button>
        <button
          onClick={() => setConfirm(true)}
          disabled={!canSend || sending}
          title={!preview ? "Preview recipients first" : undefined}
          className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-md text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 transition-colors"
        >
          <Send size={14} /> {sending ? "Sending…" : "Send"}
        </button>
      </div>

      {confirm && preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirm(false)}>
          <div className="bg-surface border border-line rounded-2xl p-5 max-w-sm w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-ink">Send this broadcast?</h3>
            <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
              This emails <span className="font-medium text-ink tabular-nums">{preview.recipients}</span> recipient{preview.recipients === 1 ? "" : "s"} from the Ecliptr platform email. This can't be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
              <button onClick={doSend} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Send to {preview.recipients}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Waitlist ───────────────────────────────────────────────────────────────
function Waitlist() {
  const [rows, setRows] = useState<{ id: string; first_name: string; email: string; features: string; created_at: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.adminWaitlistAll()
      .then((r) => { setRows(Array.isArray(r) ? r : []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (err) return <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>;

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 text-[12.5px] text-muted">
        <ClipboardList size={13} /> <span className="font-medium text-ink-2">{rows.length}</span> waitlist signup{rows.length === 1 ? "" : "s"}
      </div>
      <div className="grid grid-cols-[1fr_1.5fr_2fr_0.9fr] gap-2 px-4 py-2 text-[12px] font-medium text-muted border-b border-line">
        <div>Name</div><div>Email</div><div>Interested in</div><div>Joined</div>
      </div>
      {rows.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">No signups yet.</div>}
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[1fr_1.5fr_2fr_0.9fr] gap-2 px-4 py-2.5 text-[12.5px] items-center border-b border-line last:border-0">
          <div className="text-ink truncate" title={r.first_name}>{r.first_name || "—"}</div>
          <div className="text-ink-2 truncate" title={r.email}>{r.email}</div>
          <div className="text-muted truncate" title={r.features}>{r.features || "—"}</div>
          <div className="text-muted tabular-nums">{fmtDate(r.created_at)}</div>
        </div>
      ))}
    </div>
  );
}

// ── Feedback ───────────────────────────────────────────────────────────────
function Feedback() {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.adminFeedbackAll()
      .then((r) => { setRows(Array.isArray(r) ? r : []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (err) return <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>;

  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 text-[12.5px] text-muted">
        <MessageSquare size={13} /> <span className="font-medium text-ink-2">{rows.length}</span> report{rows.length === 1 ? "" : "s"}
      </div>
      <div className="grid grid-cols-[1.3fr_0.7fr_2fr_0.7fr_0.9fr] gap-2 px-4 py-2 text-[12px] font-medium text-muted border-b border-line">
        <div>From</div><div>Kind</div><div>Title</div><div>Status</div><div>Date</div>
      </div>
      {rows.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">No feedback yet.</div>}
      {rows.map((r) => (
        <div key={r.id} className="border-b border-line last:border-0">
          <button
            onClick={() => setOpen(open === r.id ? null : r.id)}
            className="w-full grid grid-cols-[1.3fr_0.7fr_2fr_0.7fr_0.9fr] gap-2 px-4 py-2.5 text-[12.5px] items-center text-left hover:bg-surface-2 transition-colors"
          >
            <div className="text-ink-2 truncate" title={r.submitter_email || ""}>{r.submitter_name || r.submitter_email || "Anonymous"}</div>
            <div className="text-muted capitalize truncate">{r.kind}</div>
            <div className="text-ink truncate" title={r.title}>{r.title || "—"}</div>
            <div><span className="text-[11px] px-2 py-0.5 rounded-full border border-line text-ink-2 capitalize">{r.status}</span></div>
            <div className="text-muted tabular-nums">{fmtDate(r.created_at)}</div>
          </button>
          {open === r.id && (
            <div className="px-4 pb-3 -mt-1 text-[12.5px] text-ink-2 whitespace-pre-wrap leading-relaxed">
              {r.body || <span className="text-muted">No details provided.</span>}
              <div className="text-[11px] text-muted mt-2">{r.app} · {r.submitter_email || "no email"}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Onboarding health ──────────────────────────────────────────────────────
function Onboarding() {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.adminOnboarding()
      .then((r) => { setRows(r.orgs || []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (err) return <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>;

  const cols = "grid grid-cols-[1.6fr_0.7fr_0.5fr_0.7fr_0.7fr_0.8fr_0.8fr] gap-2";
  return (
    <div className="bg-surface border border-line rounded-xl overflow-hidden">
      <div className={`${cols} px-4 py-2.5 text-[12px] font-medium text-muted border-b border-line`}>
        <div>Workspace</div><div>Plan</div><div>Members</div><div>Client</div><div>Invoice</div><div>Inventory</div><div>Email</div>
      </div>
      {rows.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">No workspaces yet.</div>}
      {rows.map((o) => (
        <div key={o.org_id} className={`${cols} px-4 py-2.5 text-[12.5px] items-center border-b border-line last:border-0`}>
          <div className="text-ink font-medium truncate" title={o.name}>{o.name || "—"}</div>
          <div><span className="text-[11px] px-2 py-0.5 rounded-full border border-line text-ink-2 capitalize">{o.plan || "free"}</span></div>
          <div className="text-ink-2 tabular-nums">{o.members ?? 0}</div>
          <div><Mark on={o.has_client} /></div>
          <div><Mark on={o.has_invoice} /></div>
          <div><Mark on={o.has_inventory} /></div>
          <div><Mark on={o.email_configured} /></div>
        </div>
      ))}
    </div>
  );
}

function Mark({ on }: { on: boolean }) {
  return on
    ? <Check size={15} className="text-accent" />
    : <Minus size={15} className="text-faint" />;
}
