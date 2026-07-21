import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "./Toast";
import { Building2, Users, UserCircle, RefreshCw, Send, Mail, MessageSquare, ClipboardList, Check, Minus, Search, Trash2, AlertTriangle, Plus } from "lucide-react";

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
const COLS = "grid grid-cols-[1.4fr_1.7fr_1fr_0.9fr_0.55fr_0.55fr_0.8fr_36px] gap-2 min-w-[820px]";

type Tab = "orgs" | "users" | "broadcast" | "waitlist" | "feedback" | "onboarding";

export default function PlatformView() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("orgs");
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [syncWarn, setSyncWarn] = useState<{ kind: "expired" } | { kind: "mismatch"; email: string } | null>(null);

  // This tab is gated on the LOCAL login, but every data call in it uses the
  // separate server-sync session — which can be an expired or different account
  // on this device (classic symptom: loads on one machine, blank on another).
  // Ask the server who it thinks this device is and warn when that identity
  // can't read platform data.
  useEffect(() => {
    Promise.all([
      api.netsyncWhoami().catch(() => null),
      api.localIsSuperadmin().catch(() => true),
    ]).then(([who, localSuper]) => {
      if (!localSuper) return; // reconnect copy is owner-directed
      if (!who) setSyncWarn({ kind: "expired" });
      else if (!who.is_superadmin) setSyncWarn({ kind: "mismatch", email: who.email });
    });
  }, []);

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

      {syncWarn && (
        <div className="flex items-start gap-2.5 bg-warning-bg border border-warning rounded-lg px-4 py-3 mb-4">
          <AlertTriangle size={15} className="text-warning-ink flex-shrink-0 mt-px" />
          <p className="text-[12.5px] text-warning-ink leading-relaxed">
            {syncWarn.kind === "expired"
              ? "Your server connection has expired — reconnect in Settings → Sync, then reopen this tab."
              : <>This device's server connection is signed in as <span className="font-medium">{syncWarn.email}</span>, which doesn't have platform access. Reconnect the server sync with your owner account, then reopen this tab.</>}
          </p>
        </div>
      )}

      {err ? (
        <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-5">
            <Stat icon={Building2} label="Signups" value={orgs.length} />
            <Stat icon={UserCircle} label="Total members" value={totalMembers} />
            <Stat icon={Users} label="Total clients" value={totalClients} />
          </div>

          <div className="flex items-center gap-1 mb-4 border-b border-line">
            <TabBtn active={tab === "orgs"} onClick={() => setTab("orgs")}>Workspaces</TabBtn>
            <TabBtn active={tab === "users"} onClick={() => setTab("users")}>Users</TabBtn>
            <TabBtn active={tab === "broadcast"} onClick={() => setTab("broadcast")}>Broadcast</TabBtn>
            <TabBtn active={tab === "waitlist"} onClick={() => setTab("waitlist")}>Waitlist</TabBtn>
            <TabBtn active={tab === "feedback"} onClick={() => setTab("feedback")}>Feedback</TabBtn>
            <TabBtn active={tab === "onboarding"} onClick={() => setTab("onboarding")}>Onboarding</TabBtn>
          </div>

          {tab === "orgs" && (
            <div className="bg-surface border border-line rounded-xl overflow-x-auto">
              <div className={`${COLS} px-4 py-2.5 text-[12.5px] font-medium text-muted border-b border-line`}>
                <div>Workspace</div><div>Owner</div><div>Plan</div><div>Signed up</div><div>Members</div><div>Clients</div><div>Last active</div><div></div>
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
                  <div className="flex justify-end">
                    {o.org_id !== "org_default" && (
                      <button
                        onClick={() => setDeleteTarget(o)}
                        title="Delete workspace"
                        className="text-faint hover:text-danger-ink hover:bg-danger-bg p-1 rounded-md transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "users" && <PlatformUsers />}
          {tab === "broadcast" && <Broadcast />}
          {tab === "waitlist" && <Waitlist />}
          {tab === "feedback" && <Feedback />}
          {tab === "onboarding" && <Onboarding />}
        </>
      )}

      {deleteTarget && (
        <DeleteWorkspaceModal
          key={deleteTarget.org_id}
          org={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Delete workspace confirmation ──────────────────────────────────────────
// Permanent, so the delete button stays disabled until the owner types the
// workspace name (or owner email, when unnamed) exactly — never one click.
function DeleteWorkspaceModal({ org, onClose, onDeleted }: { org: any; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const confirmValue = (org.name || org.owner_email || "").trim();
  const label = org.name ? "workspace name" : "owner email";
  const matches = typed.trim() === confirmValue && confirmValue.length > 0;

  const doDelete = () => {
    if (!matches) return;
    setDeleting(true);
    api.adminDeleteWorkspace(org.org_id)
      .then(() => { toast("Workspace deleted"); onDeleted(); })
      .catch((e) => { toast(String(e), "error"); setDeleting(false); });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl p-5 max-w-md w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle size={16} className="text-danger-ink" />
          <h3 className="text-[15px] font-semibold text-ink">Delete this workspace?</h3>
        </div>
        <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
          This permanently deletes the workspace <span className="font-medium text-ink">{org.name || "—"}</span>
          {org.owner_email ? <> (<span className="text-ink-2">{org.owner_email}</span>)</> : null} and all of its data — clients, invoices, inventory, everything. This cannot be undone.
        </p>

        <div className="bg-danger-bg border border-danger-ink/25 rounded-lg px-3 py-2.5 mt-3 text-[12.5px] text-danger-ink">
          You're removing <span className="font-medium tabular-nums">{org.members ?? 0}</span> member{(org.members ?? 0) === 1 ? "" : "s"} and <span className="font-medium tabular-nums">{org.clients ?? 0}</span> client{(org.clients ?? 0) === 1 ? "" : "s"}.
        </div>

        <label className="block text-[12.5px] font-medium text-ink-2 mt-4 mb-1">
          Type the {label} to confirm: <span className="text-ink font-semibold">{confirmValue}</span>
        </label>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches && !deleting) doDelete(); }}
          autoFocus
          placeholder={confirmValue}
          className="w-full bg-surface-2 border border-line rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-danger/40 focus:border-danger transition-colors"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
          <button
            onClick={doDelete}
            disabled={!matches || deleting}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg bg-danger text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
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
  const [preview, setPreview] = useState<{ recipients: number; emails: string[] } | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [addValue, setAddValue] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Any edit to the audience or content invalidates a stale preview so Send
  // can never fire against a list the owner didn't actually see.
  const resetPreview = () => {
    setPreview(null);
    setRecipients([]);
    setChecked(new Set());
    setFilter("");
    setAddValue("");
  };

  const runPreview = () => {
    if (!accounts && !waitlist) { toast("Pick at least one audience.", "error"); return; }
    setPreviewing(true);
    api.adminBroadcastPreview(accounts, waitlist)
      .then((r) => {
        setPreview(r);
        setRecipients(r.emails);
        setChecked(new Set(r.emails)); // everyone starts included
        setFilter("");
        setAddValue("");
      })
      .catch((e) => { resetPreview(); toast(String(e), "error"); })
      .finally(() => setPreviewing(false));
  };

  const toggleRecipient = (email: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };

  const addRecipient = () => {
    const v = addValue.trim();
    if (!v.includes("@")) { toast("Enter a valid email address.", "error"); return; }
    if (recipients.some((r) => r.toLowerCase() === v.toLowerCase())) {
      toast("That address is already in the list.", "error");
      return;
    }
    setRecipients((prev) => [...prev, v]);
    setChecked((prev) => new Set(prev).add(v));
    setAddValue("");
  };

  // Only ever emails the caller's own address, so it needs no preview gate —
  // uses the draft subject/body when present, else the server's canned test.
  const sendTest = () => {
    setTesting(true);
    api.adminBroadcastTest(subject.trim() || undefined, body.trim() || undefined)
      .then((r) => toast(`Test sent to ${r.to} — check your inbox (and spam).`))
      .catch((e) => toast(String(e), "error"))
      .finally(() => setTesting(false));
  };

  const doSend = () => {
    setConfirm(false);
    setSending(true);
    api.adminBroadcastSend(subject.trim(), body.trim(), accounts, waitlist, Array.from(checked))
      .then((r) => {
        toast(`Broadcast queued — ${r.recipients} recipients (id ${r.id.slice(0, 8)})`);
        setSubject(""); setBody(""); resetPreview();
      })
      .catch((e) => toast(String(e), "error"))
      .finally(() => setSending(false));
  };

  const canSend = !!preview && checked.size > 0 && subject.trim().length > 0 && body.trim().length > 0;
  const q = filter.trim().toLowerCase();
  const visible = q ? recipients.filter((r) => r.toLowerCase().includes(q)) : recipients;

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
        <div className="bg-surface-2 border border-line rounded-lg mb-4">
          <div className="px-3 py-2 border-b border-line flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter recipients"
                className="w-full border border-line rounded-lg bg-surface pl-7 pr-3 h-8 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
            </div>
            <span className="text-[12px] text-muted tabular-nums whitespace-nowrap">
              {checked.size} of {recipients.length} selected
            </span>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {visible.length === 0 && (
              <div className="px-3 py-4 text-center text-[12.5px] text-muted">
                {recipients.length === 0 ? "No recipients." : "No matches."}
              </div>
            )}
            {visible.map((email) => (
              <label key={email} className="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-ink-2 cursor-pointer hover:bg-surface border-b border-line last:border-0">
                <input
                  type="checkbox"
                  checked={checked.has(email)}
                  onChange={() => toggleRecipient(email)}
                  className="accent-accent"
                />
                <span className="truncate" title={email}>{email}</span>
              </label>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-line flex items-center gap-2">
            <input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRecipient(); } }}
              placeholder="Add an email address"
              className="flex-1 border border-line rounded-lg bg-surface px-3 h-8 text-[12.5px] focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            />
            <button
              onClick={addRecipient}
              disabled={!addValue.trim()}
              className="border border-line text-ink-2 hover:bg-surface px-3 h-8 rounded-lg text-[12.5px] font-medium flex items-center gap-1 disabled:opacity-50 transition-colors"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={sendTest}
          disabled={testing}
          className="border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
        >
          {testing ? "Sending test…" : "Send test to my email"}
        </button>
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
          title={!preview ? "Preview recipients first" : checked.size === 0 ? "Select at least one recipient" : undefined}
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
              This emails <span className="font-medium text-ink tabular-nums">{checked.size}</span> selected recipient{checked.size === 1 ? "" : "s"} from the Ecliptr platform email. This can't be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="border border-line text-ink-2 px-4 h-9 rounded-lg text-[13px]">Cancel</button>
              <button onClick={doSend} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium">Send to {checked.size}</button>
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
    <div className="bg-surface border border-line rounded-xl overflow-x-auto">
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
    <div className="bg-surface border border-line rounded-xl overflow-x-auto">
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

  const cols = "grid grid-cols-[1.6fr_0.7fr_0.5fr_0.7fr_0.7fr_0.8fr_0.8fr] gap-2 min-w-[620px]";
  return (
    <div className="bg-surface border border-line rounded-xl overflow-x-auto">
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

// ── Platform users (every signed-up user across all workspaces) ─────────────
function PlatformUsers() {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.adminPlatformUsers()
      .then((r) => { setRows(r.users || []); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (err) return <div className="text-[13px] text-muted bg-surface border border-line rounded-xl p-8 text-center">{err}</div>;

  const term = q.trim().toLowerCase();
  const filtered = term
    ? rows.filter((u) =>
        (u.email || "").toLowerCase().includes(term) ||
        (u.display_name || "").toLowerCase().includes(term) ||
        (u.org_name || "").toLowerCase().includes(term))
    : rows;

  const cols = "grid grid-cols-[2fr_1.3fr_0.8fr_0.8fr_0.7fr_0.8fr_0.9fr] gap-2 min-w-[760px]";
  return (
    <div className="bg-surface border border-line rounded-xl overflow-x-auto">
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-3">
        <div className="flex items-center gap-2 text-[12.5px] text-muted shrink-0">
          <Users size={13} /> <span className="font-medium text-ink-2 tabular-nums">{filtered.length}</span> of <span className="tabular-nums">{rows.length}</span> user{rows.length === 1 ? "" : "s"}
        </div>
        <div className="relative ml-auto w-64 max-w-full">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, or workspace"
            className="w-full border border-line h-8 pl-8 pr-2.5 rounded-md text-[12.5px] text-ink-2 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>
      </div>
      <div className={`${cols} px-4 py-2 text-[12px] font-medium text-muted border-b border-line`}>
        <div>User</div><div>Workspace</div><div>Plan</div><div>Role</div><div>Status</div><div>Joined</div><div>Activity</div>
      </div>
      {filtered.length === 0 && !loading && <div className="px-4 py-10 text-center text-[13px] text-muted">{rows.length === 0 ? "No users yet." : "No matches."}</div>}
      {filtered.map((u) => (
        <div key={u.id} className={`${cols} px-4 py-2.5 text-[12.5px] items-center border-b border-line last:border-0`}>
          <div className="min-w-0">
            <div className="text-ink font-medium truncate" title={u.display_name || ""}>{u.display_name || "—"}</div>
            <div className="text-muted truncate" title={u.email}>{u.email}</div>
          </div>
          <div className="text-ink-2 truncate" title={u.org_name}>{u.org_name || "—"}</div>
          <div><span className="text-[11px] px-2 py-0.5 rounded-full border border-line text-ink-2 capitalize">{u.plan || "free"}</span></div>
          <div className="text-ink-2 capitalize truncate">{u.role || "—"}</div>
          <div>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border capitalize ${u.status === "active" ? "border-accent/40 text-accent" : "border-line text-muted"}`}>
              {u.status || "—"}
            </span>
          </div>
          <div className="text-muted tabular-nums">{fmtDate(u.created_at)}</div>
          <div className="text-ink-2 tabular-nums">{u.org_clients ?? 0} clients · {u.org_invoices ?? 0} inv</div>
        </div>
      ))}
    </div>
  );
}
