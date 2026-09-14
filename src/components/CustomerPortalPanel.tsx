import { useCallback, useEffect, useState } from "react";
import { Copy, DoorOpen, ExternalLink, Mail } from "lucide-react";
import { api, CustomerPortalAccess, isUnavailable } from "../lib/api";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";

// R-290 customer portal — one client's access to portal.ecliptr.app: who can sign in,
// the open invite, suspend or reactivate, and a read-only preview of exactly what they
// see. Used on the client profile and inside the Customer portals screen.
//
// Accounts live only on the server, so everything here is a REST call. When the desktop
// is offline or the server predates R-290 the panel renders nothing rather than an error.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 14, 2026" from an RFC 3339 timestamp, read by hand so no timezone shifts the day. */
export function portalDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : "";
}

export async function openCustomerPortal(clientId: string) {
  try {
    const { url } = await api.customerPortalPreview(clientId);
    await api.openExternal(url);
  } catch (e) {
    toast(String(e), "error");
  }
}

const btn = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium transition-colors whitespace-nowrap disabled:opacity-50";
const quiet = `${btn} border border-line bg-surface text-ink hover:bg-surface-2`;
const primary = `${btn} bg-accent hover:bg-accent-hover text-on-accent`;

export default function CustomerPortalPanel({
  clientId, clientName, clientEmail, onChange, bare, card,
}: {
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  /** Called after any change, so a list that holds this client can refresh. */
  onChange?: () => void;
  /** Leave out the heading and top rule (the Customer portals screen supplies its own). */
  bare?: boolean;
  /** Render as its own always-open card, as on the client profile (R-293). */
  card?: boolean;
}) {
  const [data, setData] = useState<CustomerPortalAccess | null>(null);
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(clientEmail || "");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    const res = await api.customerPortalClient(clientId);
    if (isUnavailable(res) || "unsupported" in res) { setHidden(true); return; }
    setData(res);
    setHidden(false);
  }, [clientId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setEmail(clientEmail || ""); }, [clientEmail]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChange?.();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast("Invite link copied");
  };

  const invite = (send: boolean) => run(async () => {
    const r = await api.customerPortalInvite(clientId, email.trim() || null, send);
    if (send && r.sent) toast(`Invite emailed to ${r.email}`);
    else if (r.send_error) { toast(r.send_error, "error"); await copy(r.link); }
    else await copy(r.link);
    setInviting(false);
  });

  if (hidden || !data) return null;

  const first = clientName.trim().split(/\s+/)[0] || "this client";
  const hasAccess = data.accounts.length > 0;
  const showForm = (!hasAccess && !data.invite) || inviting;

  return (
    <div className={card ? "bg-surface border border-line rounded-2xl mb-4 px-6 py-4" : bare ? "" : "mt-4 pt-4 border-t border-line-2"}>
      {!bare && (
        <div className="flex items-center justify-between gap-3 mb-2">
          {card
            ? <div className="flex items-center gap-2 text-[13px] font-semibold text-ink"><DoorOpen size={14} className="text-muted" />Customer portal</div>
            : <p className="text-[12.5px] font-medium text-muted">Customer portal</p>}
          <button onClick={() => openCustomerPortal(clientId)} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline">
            View their portal <ExternalLink size={12} />
          </button>
        </div>
      )}

      {data.accounts.map((a) => (
        <div key={a.id} className="flex items-center gap-3 py-2 border-b border-line-2 last:border-b-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-ink truncate">{a.email}</span>
              {a.status === "suspended" ? <StatusPill tone="warning">Suspended</StatusPill> : <StatusPill tone="success">Can sign in</StatusPill>}
            </div>
            <div className="text-[11.5px] text-muted">
              {a.last_login_at ? `Last signed in ${portalDate(a.last_login_at)}` : "Has not signed in yet"}
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              const next = a.status === "suspended" ? "active" : "suspended";
              if (next === "suspended" && !confirm(`Suspend ${a.email}? They are signed out straight away and cannot sign in until you reactivate them.`)) return;
              run(() => api.customerPortalSetStatus(a.id, next));
            }}
            className={quiet}
          >
            {a.status === "suspended" ? "Reactivate" : "Suspend"}
          </button>
        </div>
      ))}

      {data.invite && !inviting && (
        <div className="flex flex-wrap items-center gap-2 py-2">
          <div className="min-w-0 flex-1 text-[12.5px] text-ink-2">
            Invite open{data.invite.email ? ` for ${data.invite.email}` : ""}, expires {portalDate(data.invite.expires_at)}
          </div>
          <button disabled={busy} onClick={() => copy(data.invite!.link)} className={quiet}><Copy size={13} />Copy link</button>
          <button disabled={busy} onClick={() => { setEmail(data.invite!.email || email); setInviting(true); }} className={quiet}><Mail size={13} />Send again</button>
          <button disabled={busy} onClick={() => { if (confirm("Revoke this invite link? It stops working straight away.")) run(() => api.customerPortalRevokeInvite(clientId)); }}
            className={`${btn} text-danger-ink hover:bg-danger-bg`}>Revoke</button>
        </div>
      )}

      {showForm ? (
        <div className="py-1">
          {!hasAccess && !data.invite && (
            <p className="text-[12.5px] text-ink-2 mb-2">Give {first} a login to see their invoices, deals, shipping and how to pay.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email to send the invite to"
              type="email"
              className="border border-line px-3 h-8 rounded-lg text-[12.5px] bg-surface text-ink flex-1 min-w-[180px] focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
            />
            <button disabled={busy || !email.includes("@")} onClick={() => invite(true)} className={primary}><Mail size={13} />Email invite</button>
            <button disabled={busy} onClick={() => invite(false)} className={quiet}><Copy size={13} />Copy link</button>
            {inviting && <button onClick={() => setInviting(false)} className={`${btn} text-muted hover:text-ink`}>Cancel</button>}
          </div>
          <p className="text-[11px] text-muted mt-1.5">The link works once and expires in 14 days. A new invite replaces any open one.</p>
        </div>
      ) : hasAccess && !data.invite && (
        <button onClick={() => setInviting(true)} className="mt-1 text-[12px] font-medium text-accent hover:underline">Invite another person</button>
      )}
    </div>
  );
}
