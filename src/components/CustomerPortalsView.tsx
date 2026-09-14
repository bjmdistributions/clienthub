import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ExternalLink, Search, UserPlus } from "lucide-react";
import { api, Client, CustomerPortalAccess, isUnavailable } from "../lib/api";
import StatusPill from "./StatusPill";
import CustomerPortalPanel, { openCustomerPortal, portalDate } from "./CustomerPortalPanel";

// R-290 customer portal — every client who can sign in at portal.ecliptr.app, or has an
// open invite, with a one-click read-only preview of what they see. Inviting a new client
// starts from the picker at the top or from the client's own profile.

function accessLabel(c: CustomerPortalAccess): { text: string; tone: "success" | "warning" | "accent" | "neutral" } {
  const active = c.accounts.filter((a) => a.status === "active").length;
  if (active > 0) return { text: active === 1 ? "1 login" : `${active} logins`, tone: "success" };
  if (c.accounts.length > 0) return { text: "Suspended", tone: "warning" };
  if (c.invite) return { text: "Invite open", tone: "accent" };
  return { text: "No access", tone: "neutral" };
}

export default function CustomerPortalsView() {
  const [rows, setRows] = useState<CustomerPortalAccess[] | null>(null);
  const [portalUrl, setPortalUrl] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [pickQ, setPickQ] = useState("");
  const [picked, setPicked] = useState<Client | null>(null);

  const load = useCallback(async () => {
    const res = await api.customerPortalList();
    if (isUnavailable(res) || "unsupported" in res) { setUnsupported(true); setRows([]); return; }
    setUnsupported(false);
    setRows(res.clients);
    setPortalUrl(res.portal_url);
  }, []);

  useEffect(() => { load(); api.listClients().then(setClients).catch(() => setClients([])); }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!rows) return [];
    if (!s) return rows;
    return rows.filter((r) => [r.client_name, r.company, r.client_email, ...r.accounts.map((a) => a.email)].some((v) => (v || "").toLowerCase().includes(s)));
  }, [rows, q]);

  const matches = useMemo(() => {
    const s = pickQ.trim().toLowerCase();
    if (!s) return [];
    return clients.filter((c) => [c.name, c.company, c.email].some((v) => (v || "").toLowerCase().includes(s))).slice(0, 6);
  }, [clients, pickQ]);

  const signedIn30 = (rows || []).filter((r) => r.accounts.some((a) => a.last_login_at && Date.now() - new Date(a.last_login_at).getTime() < 30 * 86400000)).length;

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Customer portals</h1>
          <p className="text-[13px] text-muted mt-0.5">
            Buyers sign in at{" "}
            {portalUrl ? <button onClick={() => api.openExternal(portalUrl)} className="text-accent hover:underline">{portalUrl.replace(/^https?:\/\//, "")}</button> : "their portal"}
            {" "}to see their invoices, deals, shipping and how to pay.
          </p>
        </div>
        {rows && rows.length > 0 && (
          <div className="flex gap-6 text-right">
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{rows.filter((r) => r.accounts.some((a) => a.status === "active")).length}</div><div className="text-[11.5px] text-muted">with a login</div></div>
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{signedIn30}</div><div className="text-[11.5px] text-muted">signed in this month</div></div>
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{rows.filter((r) => r.invite).length}</div><div className="text-[11.5px] text-muted">invites open</div></div>
          </div>
        )}
      </div>

      {unsupported ? (
        <div className="bg-surface border border-line rounded-xl p-6 text-[13px] text-muted">
          Customer portals need a connection to the Ecliptr server. Check Settings, then Sync.
        </div>
      ) : (
        <>
          <div className="bg-surface border border-line rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink mb-2"><UserPlus size={15} className="text-muted" />Give a client access</div>
            {picked ? (
              <div>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="text-[13px] text-ink font-medium">{picked.name}{picked.company ? <span className="text-muted font-normal"> · {picked.company}</span> : null}</div>
                  <button onClick={() => { setPicked(null); setPickQ(""); }} className="text-[12px] text-muted hover:text-ink">Choose someone else</button>
                </div>
                <CustomerPortalPanel bare clientId={picked.id} clientName={picked.name} clientEmail={picked.email} onChange={load} />
              </div>
            ) : (
              <div className="relative max-w-[420px]">
                <Search size={14} className="absolute left-3 top-2.5 text-faint" />
                <input value={pickQ} onChange={(e) => setPickQ(e.target.value)} placeholder="Search clients by name, company or email"
                  className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
                {matches.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg overflow-hidden">
                    {matches.map((c) => (
                      <button key={c.id} onClick={() => { setPicked(c); setPickQ(""); }} className="w-full text-left px-3 py-2 hover:bg-surface-2 border-b border-line-2 last:border-b-0">
                        <div className="text-[13px] text-ink">{c.name}</div>
                        <div className="text-[11.5px] text-muted truncate">{[c.company, c.email].filter(Boolean).join(" · ") || "No email on file"}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="text-[14px] font-semibold text-ink">Who has access</h2>
            {rows && rows.length > 3 && (
              <div className="relative w-[260px]">
                <Search size={14} className="absolute left-3 top-2.5 text-faint" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter"
                  className="w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent" />
              </div>
            )}
          </div>

          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {rows === null ? (
              <div className="p-6 text-[13px] text-muted">Loading</div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-[13.5px] font-medium text-ink">{rows.length ? "No one matches that filter" : "No customers have portal access yet"}</div>
                <div className="text-[12.5px] text-muted mt-0.5">{rows.length ? "Try another name or email." : "Search for a client above, or open a client and send an invite from their profile."}</div>
              </div>
            ) : filtered.map((r) => {
              const label = accessLabel(r);
              const last = r.accounts.map((a) => a.last_login_at).filter(Boolean).sort().pop();
              const isOpen = open === r.client_id;
              return (
                <div key={r.client_id} className="border-b border-line-2 last:border-b-0">
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors">
                    <button onClick={() => setOpen(isOpen ? null : r.client_id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                      <ChevronDown size={15} className={`text-faint flex-shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium text-ink truncate">{r.client_name}</div>
                        <div className="text-[12px] text-muted truncate">{[r.company, r.accounts[0]?.email || r.invite?.email || r.client_email].filter(Boolean).join(" · ")}</div>
                      </div>
                      <StatusPill tone={label.tone}>{label.text}</StatusPill>
                      <div className="w-[150px] text-right text-[12px] text-muted hidden md:block">
                        {last ? `Signed in ${portalDate(last)}` : r.invite ? `Invited ${portalDate(r.invite.created_at)}` : "Not signed in yet"}
                      </div>
                    </button>
                    <button onClick={() => openCustomerPortal(r.client_id)} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border border-line bg-surface text-ink hover:bg-surface-2 whitespace-nowrap">
                      View portal <ExternalLink size={12} />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="px-4 pb-3 pl-11">
                      <CustomerPortalPanel bare clientId={r.client_id} clientName={r.client_name} clientEmail={r.client_email} onChange={load} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
