import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Button, Kpi, PageActions } from "./ui";
import { RefreshCw, Send, Check, Minus, Search, Trash2, AlertTriangle, Plus } from "lucide-react";

function fmtDate(s?: string | null): string {
  if (!s) return "None";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "None" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function relTime(s?: string | null): string {
  if (!s) return "never";
  const ms = Date.now() - new Date(s).getTime();
  if (isNaN(ms)) return "never";
  const d = Math.floor(ms / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}
const cap = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

const PLANS = ["free", "pro", "business", "unlimited", "founder"];

type Tab = "orgs" | "users" | "broadcast" | "waitlist" | "feedback" | "onboarding";
const TABS: { id: Tab; label: string }[] = [
  { id: "orgs", label: "Workspaces" },
  { id: "users", label: "Users" },
  { id: "broadcast", label: "Broadcast" },
  { id: "waitlist", label: "Waitlist" },
  { id: "feedback", label: "Feedback" },
  { id: "onboarding", label: "Onboarding" },
];

// A message in the place of a table (an error from the server, or an empty list).
const Notice = ({ children }: { children: ReactNode }) => (
  <div className="py-12 text-center text-[14px] text-muted">{children}</div>
);

export default function PlatformView() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("orgs");
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [syncWarn, setSyncWarn] = useState<{ kind: "expired" } | { kind: "mismatch"; email: string } | null>(null);

  // This tab is gated on the LOCAL login, but every data call in it uses the
  // separate server-sync session, which can be an expired or different account
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
    <div className="min-w-0">
      <PageActions>
        <Button icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={load}>Refresh</Button>
      </PageActions>

      <p className="m-0 text-[14px] leading-5 text-muted">Every workspace signed up on Ecliptr.</p>

      {syncWarn && (
        <div role="alert" className="flex items-start gap-2.5 mt-4 px-4 py-3 rounded-[10px] bg-surface-2 ring-1 ring-line-3 animate-fade-up">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5 text-warning-ink" />
          <p className="m-0 text-[13px] leading-[19px] text-ink">
            {syncWarn.kind === "expired"
              ? "Your server connection has expired. Reconnect in Settings → Sync, then reopen this tab."
              : <>This device's server connection is signed in as <span className="font-medium">{syncWarn.email}</span>, which doesn't have platform access. Reconnect the server sync with your owner account, then reopen this tab.</>}
          </p>
        </div>
      )}

      <div className="hsep mt-5" />

      {err ? (
        <Notice>{err}</Notice>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)]">
            <Kpi label="Signups" value={orgs.length} />
            <div className="vsep mt-4" />
            <Kpi label="Total members" value={totalMembers} />
            <div className="vsep mt-4" />
            <Kpi label="Total clients" value={totalClients} />
          </div>

          <div className="hsep" />

          <div className="flex flex-wrap pt-3 px-1" role="tablist" aria-label="Platform sections">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={`h-8 px-0.5 mr-4 -mb-px text-[13.5px] font-medium border-b-[1.5px] transition-colors duration-150 ${tab === t.id ? "text-ink border-ink" : "text-muted border-transparent hover:text-ink"}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="hsep" />

          <div key={tab} className="animate-fade-up pt-2">
            {tab === "orgs" && (
              <div className="overflow-x-auto">
                <table className="ui-table min-w-[820px]" aria-label="Workspaces">
                  <thead>
                    <tr>
                      <th>Workspace</th><th>Owner</th><th style={{ width: 130 }}>Plan</th><th style={{ width: 120 }}>Signed up</th>
                      <th className="r" style={{ width: 80 }}>Members</th><th className="r" style={{ width: 80 }}>Clients</th>
                      <th style={{ width: 100 }}>Last active</th><th style={{ width: 44 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgs.length === 0 && !loading && <tr><td colSpan={8}><Notice>No signups yet.</Notice></td></tr>}
                    {orgs.map((o) => (
                      <tr key={o.org_id}>
                        <td className="font-medium text-ink max-w-[220px] truncate" title={o.name}>{o.name || "Unnamed"}</td>
                        <td className="text-muted max-w-[260px] truncate" title={o.owner_email || ""}>{o.owner_email || "No owner email"}</td>
                        <td>
                          <select
                            aria-label={`Plan for ${o.name || "this workspace"}`}
                            value={o.plan || "free"}
                            disabled={savingPlan === o.org_id}
                            onChange={(e) => changePlan(o.org_id, e.target.value)}
                            className="field-input !h-8 !w-[112px] !text-[12.5px] disabled:opacity-50"
                          >
                            {PLANS.map((p) => <option key={p} value={p}>{cap(p)}</option>)}
                          </select>
                        </td>
                        <td className="text-muted tabular-nums">{fmtDate(o.created_at)}</td>
                        <td className="r">{o.members ?? 0}</td>
                        <td className="r">{o.clients ?? 0}</td>
                        <td className="text-muted">{relTime(o.last_event_at)}</td>
                        <td>
                          <div className="flex justify-end">
                            {o.org_id !== "org_default" && (
                              <button onClick={() => setDeleteTarget(o)} title="Delete workspace" aria-label={`Delete workspace ${o.name || ""}`}
                                className="ui-ib hover:!text-danger-ink">
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "users" && <PlatformUsers />}
            {tab === "broadcast" && <Broadcast />}
            {tab === "waitlist" && <Waitlist />}
            {tab === "feedback" && <Feedback />}
            {tab === "onboarding" && <Onboarding />}
          </div>
        </>
      )}

      {deleteTarget && (
        <DeleteWorkspaceDialog
          key={deleteTarget.org_id}
          org={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Dialog: a centred modal that fades and settles in on the next frame, and back out before it unmounts ──
const DialogClose = createContext<() => void>(() => {});

function Dialog({ label, width = 460, onClose, children }: { label: string; width?: number; onClose: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    window.setTimeout(onClose, 180);
  };
  useEffect(() => {
    const r = window.setTimeout(() => setOpen(true), 20);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", key);
    return () => { window.clearTimeout(r); window.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className={`ui-scrim ${open ? "open" : ""}`} onClick={close} />
      <div role="dialog" aria-label={label}
        className="fixed left-1/2 top-1/2 z-50 overflow-auto rounded-2xl bg-surface p-5 shadow-xl ring-1 ring-line-3"
        style={{ width: `min(${width}px, calc(100% - 32px))`, maxHeight: "88vh", opacity: open ? 1 : 0,
                 transform: open ? "translate(-50%, -50%)" : "translate(-50%, -47%) scale(0.98)",
                 pointerEvents: open ? "auto" : "none",
                 transition: "opacity 180ms var(--ease), transform 240ms var(--ease)" }}>
        <DialogClose.Provider value={close}>{children}</DialogClose.Provider>
      </div>
    </>
  );
}

function CancelButton() {
  const close = useContext(DialogClose);
  return <Button onClick={close}>Cancel</Button>;
}

// Checkbox drawn as a box with an ink fill when on (the page's native checkboxes were blue).
function Box({ on }: { on: boolean }) {
  return (
    <span className={`inline-grid place-items-center flex-shrink-0 w-[18px] h-[18px] rounded-[5px] transition-colors duration-150 ${on ? "bg-accent text-on-accent" : "ring-1 ring-inset ring-line-3"}`}>
      <Check size={12} className={`transition-opacity duration-150 ${on ? "opacity-100" : "opacity-0"}`} />
    </span>
  );
}

// ── Delete workspace confirmation ──────────────────────────────────────────
// Permanent, so the delete button stays disabled until the owner types the
// workspace name (or owner email, when unnamed) exactly, never one click.
function DeleteWorkspaceDialog({ org, onClose, onDeleted }: { org: any; onClose: () => void; onDeleted: () => void }) {
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
    <Dialog label="Delete this workspace" onClose={onClose}>
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-danger-ink" />
        <h2 className="m-0 text-[16px] font-medium text-ink">Delete this workspace?</h2>
      </div>
      <p className="m-0 mt-2.5 text-[13px] leading-[19px] text-muted">
        This permanently deletes the workspace <span className="font-medium text-ink">{org.name || "Unnamed"}</span>
        {org.owner_email ? <> ({org.owner_email})</> : null} and all of its data: clients, invoices, inventory, everything. This cannot be undone.
      </p>

      <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2.5 ring-1 ring-line-3 text-[13px] text-danger-ink">
        You're removing <span className="font-medium tabular-nums">{org.members ?? 0}</span> member{(org.members ?? 0) === 1 ? "" : "s"} and <span className="font-medium tabular-nums">{org.clients ?? 0}</span> client{(org.clients ?? 0) === 1 ? "" : "s"}.
      </div>

      <label className="flex flex-col gap-1.5 mt-4 text-[13px] font-medium text-muted">
        <span>Type the {label} to confirm: <span className="text-ink">{confirmValue}</span></span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches && !deleting) doDelete(); }}
          autoFocus
          placeholder={confirmValue}
          className="field-input"
        />
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <CancelButton />
        <Button variant="danger" icon={<Trash2 size={14} />} onClick={doDelete} disabled={!matches || deleting}>
          {deleting ? "Deleting…" : "Delete permanently"}
        </Button>
      </div>
    </Dialog>
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

  // Only ever emails the caller's own address, so it needs no preview gate:
  // uses the draft subject/body when present, else the server's canned test.
  const sendTest = () => {
    setTesting(true);
    api.adminBroadcastTest(subject.trim() || undefined, body.trim() || undefined)
      .then((r) => toast(`Test sent to ${r.to}. Check your inbox (and spam).`))
      .catch((e) => toast(String(e), "error"))
      .finally(() => setTesting(false));
  };

  const doSend = () => {
    setConfirm(false);
    setSending(true);
    api.adminBroadcastSend(subject.trim(), body.trim(), accounts, waitlist, Array.from(checked))
      .then((r) => {
        toast(`Broadcast queued: ${r.recipients} recipients (id ${r.id.slice(0, 8)})`);
        setSubject(""); setBody(""); resetPreview();
      })
      .catch((e) => toast(String(e), "error"))
      .finally(() => setSending(false));
  };

  const canSend = !!preview && checked.size > 0 && subject.trim().length > 0 && body.trim().length > 0;
  const q = filter.trim().toLowerCase();
  const visible = q ? recipients.filter((r) => r.toLowerCase().includes(q)) : recipients;
  const sendHint = !preview ? "Preview recipients first, then send." : checked.size === 0 ? "Select at least one recipient." : "";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_1px_minmax(300px,380px)] gap-x-6 pt-4">
      <section className="min-w-0 px-1 pb-5">
        <div className="text-[14px] font-medium text-ink">Broadcast</div>
        <p className="m-0 mt-0.5 mb-4 text-[13px] text-muted">Send a one-off announcement from the Ecliptr platform email.</p>

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-muted">Subject
            <input
              value={subject}
              onChange={(e) => { setSubject(e.target.value); resetPreview(); }}
              placeholder="What's new in Ecliptr"
              className="field-input"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-muted">Message
            <textarea
              value={body}
              onChange={(e) => { setBody(e.target.value); resetPreview(); }}
              rows={7}
              placeholder="Write your announcement…"
              className="field-input resize-none leading-relaxed"
            />
          </label>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <button role="checkbox" aria-checked={accounts} onClick={() => { setAccounts(!accounts); resetPreview(); }}
              className="inline-flex items-center gap-2 text-[14px] text-ink">
              <Box on={accounts} /> Signed-up accounts
            </button>
            <button role="checkbox" aria-checked={waitlist} onClick={() => { setWaitlist(!waitlist); resetPreview(); }}
              className="inline-flex items-center gap-2 text-[14px] text-ink">
              <Box on={waitlist} /> Waitlist
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={sendTest} disabled={testing}>{testing ? "Sending test…" : "Send test to my email"}</Button>
            <Button onClick={runPreview} disabled={previewing || (!accounts && !waitlist)}>{previewing ? "Checking…" : "Preview recipients"}</Button>
            <Button variant="ink" icon={<Send size={14} />} onClick={() => setConfirm(true)} disabled={!canSend || sending}
              title={!preview ? "Preview recipients first" : checked.size === 0 ? "Select at least one recipient" : undefined}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
          {sendHint && <div className="text-[12px] text-muted">{sendHint}</div>}
        </div>
      </section>

      <div className="vsep hidden xl:block" />

      <section className="min-w-0 px-1 pb-5" aria-label="Recipients">
        {!preview ? (
          <div className="py-14 text-center text-[13px] text-muted">Preview recipients to see who will get this.</div>
        ) : (
          <div className="animate-fade-up">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[14px] font-medium text-ink">Recipients</div>
              <div className="text-[12px] text-muted tabular-nums">{checked.size} of {recipients.length} selected</div>
            </div>
            <label className="ui-search mt-3 w-full">
              <Search size={14} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter recipients" aria-label="Filter recipients" style={{ width: "100%" }} />
            </label>
            <div className="max-h-[300px] overflow-y-auto mt-2">
              {visible.length === 0 && (
                <div className="py-5 text-center text-[13px] text-muted">{recipients.length === 0 ? "No recipients." : "No matches."}</div>
              )}
              {visible.map((email) => (
                <button key={email} role="checkbox" aria-checked={checked.has(email)} onClick={() => toggleRecipient(email)}
                  className="flex items-center gap-2.5 w-full h-9 px-1.5 rounded-lg text-[13px] text-left text-ink hover:bg-surface-2 transition-colors duration-150">
                  <Box on={checked.has(email)} />
                  <span className="truncate" title={email}>{email}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRecipient(); } }}
                placeholder="Add an email address"
                aria-label="Add an email address"
                className="field-input !h-8 flex-1 min-w-0"
              />
              <Button size="sm" icon={<Plus size={14} />} onClick={addRecipient} disabled={!addValue.trim()}>Add</Button>
            </div>
          </div>
        )}
      </section>

      {confirm && preview && (
        <Dialog label="Send this broadcast" width={400} onClose={() => setConfirm(false)}>
          <h2 className="m-0 text-[16px] font-medium text-ink">Send this broadcast?</h2>
          <p className="m-0 mt-2 text-[13px] leading-[19px] text-muted">
            This emails <span className="font-medium text-ink tabular-nums">{checked.size}</span> selected recipient{checked.size === 1 ? "" : "s"} from the Ecliptr platform email. This can't be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <CancelButton />
            <Button variant="ink" onClick={doSend}>Send to {checked.size}</Button>
          </div>
        </Dialog>
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

  if (err) return <Notice>{err}</Notice>;

  return (
    <div className="pt-2">
      <div className="px-1 pb-3 text-[13px] text-muted"><span className="tabular-nums">{rows.length}</span> waitlist signup{rows.length === 1 ? "" : "s"}</div>
      <div className="overflow-x-auto">
        <table className="ui-table" aria-label="Waitlist">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Interested in</th><th style={{ width: 120 }}>Joined</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={4}><Notice>No signups yet.</Notice></td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="font-medium text-ink max-w-[180px] truncate" title={r.first_name}>{r.first_name || "No name"}</td>
                <td className="text-muted max-w-[260px] truncate" title={r.email}>{r.email}</td>
                <td className="text-muted max-w-[320px] truncate" title={r.features}>{r.features || "Not given"}</td>
                <td className="text-muted tabular-nums">{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

  if (err) return <Notice>{err}</Notice>;

  return (
    <div className="pt-2">
      <div className="px-1 pb-3 text-[13px] text-muted"><span className="tabular-nums">{rows.length}</span> report{rows.length === 1 ? "" : "s"}</div>
      <div className="overflow-x-auto">
        <table className="ui-table ui-table-click" aria-label="Feedback">
          <thead>
            <tr><th>From</th><th>Kind</th><th>Title</th><th style={{ width: 100 }}>Status</th><th style={{ width: 120 }}>Date</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={5}><Notice>No feedback yet.</Notice></td></tr>}
            {rows.map((r) => (
              <FeedbackRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FeedbackRow({ r, open, onToggle }: { r: any; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} aria-selected={open} aria-expanded={open}
        tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <td className="max-w-[220px] truncate" title={r.submitter_email || ""}>{r.submitter_name || r.submitter_email || "Anonymous"}</td>
        <td className="text-muted max-w-[140px] truncate">{cap(r.kind)}</td>
        <td className="font-medium text-ink max-w-[360px] truncate" title={r.title}>{r.title || "Untitled"}</td>
        <td><StatusPill tone="neutral">{cap(r.status)}</StatusPill></td>
        <td className="text-muted tabular-nums">{fmtDate(r.created_at)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ boxShadow: "none", paddingTop: 0 }}>
            <div className="max-w-[760px] pb-2 text-[14px] leading-[21px] text-ink whitespace-pre-wrap animate-fade-up">
              {r.body || <span className="text-muted">No details provided.</span>}
              <div className="mt-2 text-[12px] text-muted">{r.app} · {r.submitter_email || "no email"}</div>
            </div>
          </td>
        </tr>
      )}
    </>
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

  if (err) return <Notice>{err}</Notice>;

  return (
    <div className="pt-2">
      <p className="m-0 px-1 pb-3 text-[13px] text-muted">Which steps each workspace has completed.</p>
      <div className="overflow-x-auto">
        <table className="ui-table min-w-[620px]" aria-label="Onboarding">
          <thead>
            <tr><th>Workspace</th><th>Plan</th><th>Members</th><th>Client</th><th>Invoice</th><th>Inventory</th><th>Email</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={7}><Notice>No workspaces yet.</Notice></td></tr>}
            {rows.map((o) => (
              <tr key={o.org_id}>
                <td className="font-medium text-ink max-w-[240px] truncate" title={o.name}>{o.name || "Unnamed"}</td>
                <td><StatusPill tone="neutral">{cap(o.plan || "free")}</StatusPill></td>
                <td className="tabular-nums">{o.members ?? 0}</td>
                <td><Mark on={o.has_client} label="Client" /></td>
                <td><Mark on={o.has_invoice} label="Invoice" /></td>
                <td><Mark on={o.has_inventory} label="Inventory" /></td>
                <td><Mark on={o.email_configured} label="Email" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mark({ on, label }: { on: boolean; label: string }) {
  return on
    ? <Check size={16} className="text-ink" aria-label={`${label} done`} />
    : <Minus size={16} className="text-faint" aria-label={`${label} not done`} />;
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

  if (err) return <Notice>{err}</Notice>;

  const term = q.trim().toLowerCase();
  const filtered = term
    ? rows.filter((u) =>
        (u.email || "").toLowerCase().includes(term) ||
        (u.display_name || "").toLowerCase().includes(term) ||
        (u.org_name || "").toLowerCase().includes(term))
    : rows;

  return (
    <div className="pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
        <div className="text-[13px] text-muted">
          <span className="tabular-nums">{filtered.length}</span> of <span className="tabular-nums">{rows.length}</span> user{rows.length === 1 ? "" : "s"}
        </div>
        <label className="ui-search w-[280px] max-w-full">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, or workspace" aria-label="Search users" style={{ width: "100%" }} />
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="ui-table min-w-[760px]" aria-label="Users">
          <thead>
            <tr>
              <th>User</th><th>Workspace</th><th style={{ width: 110 }}>Plan</th><th style={{ width: 90 }}>Role</th>
              <th style={{ width: 100 }}>Status</th><th style={{ width: 120 }}>Joined</th><th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && <tr><td colSpan={7}><Notice>{rows.length === 0 ? "No users yet." : "No matches."}</Notice></td></tr>}
            {filtered.map((u) => (
              <tr key={u.id}>
                <td className="max-w-[260px]">
                  <div className="font-medium text-ink truncate" title={u.display_name || ""}>{u.display_name || "No name"}</div>
                  <div className="text-[12px] text-muted truncate mt-0.5" title={u.email}>{u.email}</div>
                </td>
                <td className="max-w-[200px] truncate" title={u.org_name}>{u.org_name || "None"}</td>
                <td><StatusPill tone="neutral">{cap(u.plan || "free")}</StatusPill></td>
                <td>{cap(u.role) || "None"}</td>
                <td>
                  <StatusPill tone="neutral" className={u.status === "active" ? "text-ink bg-surface-3" : "text-muted bg-surface-3"}>{cap(u.status) || "Unknown"}</StatusPill>
                </td>
                <td className="text-muted tabular-nums">{fmtDate(u.created_at)}</td>
                <td className="tabular-nums">{u.org_clients ?? 0} clients, {u.org_invoices ?? 0} invoices</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
