import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, QrCode, Search, Send, UserPlus, X } from "lucide-react";
import { api, Client, CustomerPortalAccess, CustomerPortalEligible, PaymentMethod, isUnavailable } from "../lib/api";
import { isAdmin } from "../lib/permissions";
import StatusPill from "./StatusPill";
import { toast } from "./Toast";
import CustomerPortalPanel, { openCustomerPortal, portalDate } from "./CustomerPortalPanel";

type Me = Parameters<typeof isAdmin>[0];

// R-290 / R-294 customer portal — who can sign in at portal.ecliptr.app, split the way Jack
// asked to see it: who has signed up, who was invited and has not yet, and whose invite ran
// out. Also: invite every customer with a completed deal at once, and the QR codes the
// portal shows under How to pay.

type Group = "signed" | "invited" | "expired";

function groupOf(c: CustomerPortalAccess): Group | null {
  if (c.accounts.length > 0) return "signed";
  if (c.invite) return c.invite.status === "expired" ? "expired" : "invited";
  return null;
}

const GROUPS: { id: Group; title: string; empty: string }[] = [
  { id: "signed", title: "Signed up", empty: "No one has signed up yet." },
  { id: "invited", title: "Invited, not signed up yet", empty: "No invites waiting." },
  { id: "expired", title: "Invite expired", empty: "" },
];

function emailState(c: CustomerPortalAccess): { text: string; tone: "success" | "danger" | "neutral" | "accent" } | null {
  switch (c.invite?.email_status) {
    case "sent": return { text: "Email sent", tone: "success" };
    case "queued": return { text: "Sending", tone: "accent" };
    case "failed": return { text: "Email failed", tone: "danger" };
    default: return null;
  }
}

const inputCls = "w-full border border-line pl-8 pr-3 h-9 rounded-lg text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent";
const quietBtn = "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border border-line bg-surface text-ink hover:bg-surface-2 whitespace-nowrap disabled:opacity-50";
const primaryBtn = "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-accent hover:bg-accent-hover text-on-accent whitespace-nowrap disabled:opacity-50";

export default function CustomerPortalsView({ me }: { me?: Me }) {
  const [rows, setRows] = useState<CustomerPortalAccess[] | null>(null);
  const [portalUrl, setPortalUrl] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [pickQ, setPickQ] = useState("");
  const [picked, setPicked] = useState<Client | null>(null);
  const [eligible, setEligible] = useState<CustomerPortalEligible[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await api.customerPortalList();
    if (isUnavailable(res) || "unsupported" in res) { setUnsupported(true); setRows([]); return; }
    setUnsupported(false);
    setRows(res.clients);
    setPortalUrl(res.portal_url);
    const el = await api.customerPortalEligible();
    if (!isUnavailable(el) && !("unsupported" in el)) setEligible(el.clients);
  }, []);

  useEffect(() => { load(); api.listClients().then(setClients).catch(() => setClients([])); }, [load]);

  // While any invite email is still going out, look again every few seconds.
  const sending = (rows || []).some((r) => r.invite?.email_status === "queued");
  useEffect(() => {
    if (!sending) return;
    const t = window.setTimeout(load, 4000);
    return () => window.clearTimeout(t);
  }, [sending, rows, load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!rows) return [];
    if (!s) return rows;
    return rows.filter((r) => [r.client_name, r.company, r.client_email, r.invite?.email, ...r.accounts.map((a) => a.email)].some((v) => (v || "").toLowerCase().includes(s)));
  }, [rows, q]);

  const matches = useMemo(() => {
    const s = pickQ.trim().toLowerCase();
    if (!s) return [];
    return clients.filter((c) => [c.name, c.company, c.email].some((v) => (v || "").toLowerCase().includes(s))).slice(0, 6);
  }, [clients, pickQ]);

  const counts = useMemo(() => {
    const c = { signed: 0, invited: 0, expired: 0 };
    for (const r of rows || []) { const g = groupOf(r); if (g) c[g] += 1; }
    return c;
  }, [rows]);
  const invitable = eligible.filter((e) => !e.blocked && !e.open_invite).length;

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
        {rows && (
          <div className="flex gap-6 text-right">
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{counts.signed}</div><div className="text-[11.5px] text-muted">signed up</div></div>
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{counts.invited}</div><div className="text-[11.5px] text-muted">invited, waiting</div></div>
            <div><div className="text-[20px] font-semibold tabular-nums text-ink">{counts.expired}</div><div className="text-[11.5px] text-muted">invite expired</div></div>
          </div>
        )}
      </div>

      {unsupported ? (
        <div className="bg-surface border border-line rounded-xl p-6 text-[13px] text-muted">
          Customer portals need a connection to the Ecliptr server. Check Settings, then Sync.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink mb-1"><Send size={15} className="text-muted" />Invite customers you've done deals with</div>
              <p className="text-[12.5px] text-muted mb-3">
                {eligible.length === 0
                  ? "No customer has a completed deal yet."
                  : `${eligible.length} customer${eligible.length === 1 ? " has" : "s have"} a completed deal. ${invitable} can be invited now.`}
              </p>
              <button disabled={eligible.length === 0} onClick={() => setBulkOpen(true)} className={primaryBtn}>Choose customers</button>
            </div>

            <div className="bg-surface border border-line rounded-xl p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink mb-2"><UserPlus size={15} className="text-muted" />Give one client access</div>
              {picked ? (
                <div>
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="text-[13px] text-ink font-medium truncate">{picked.name}{picked.company ? <span className="text-muted font-normal"> · {picked.company}</span> : null}</div>
                    <button onClick={() => { setPicked(null); setPickQ(""); }} className="text-[12px] text-muted hover:text-ink whitespace-nowrap">Choose someone else</button>
                  </div>
                  <CustomerPortalPanel bare clientId={picked.id} clientName={picked.name} clientEmail={picked.email} onChange={load} />
                </div>
              ) : (
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-2.5 text-faint" />
                  <input value={pickQ} onChange={(e) => setPickQ(e.target.value)} placeholder="Search clients by name, company or email" className={inputCls} />
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
          </div>

          {rows && rows.length > 5 && (
            <div className="relative w-[280px] mb-3">
              <Search size={14} className="absolute left-3 top-2.5 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or email" className={inputCls} />
            </div>
          )}

          {rows === null ? (
            <div className="bg-surface border border-line rounded-xl p-6 text-[13px] text-muted">Loading</div>
          ) : rows.length === 0 ? (
            <div className="bg-surface border border-line rounded-xl p-8 text-center">
              <div className="text-[13.5px] font-medium text-ink">No customers have portal access yet</div>
              <div className="text-[12.5px] text-muted mt-0.5">Invite the customers you've done deals with, or give one client access above.</div>
            </div>
          ) : GROUPS.map((g) => {
            const list = filtered.filter((r) => groupOf(r) === g.id);
            if (list.length === 0 && (g.id === "expired" || q)) return null;
            return (
              <div key={g.id} className="mb-5">
                <h2 className="text-[14px] font-semibold text-ink mb-2">{g.title} <span className="text-muted font-normal tabular-nums">{list.length}</span></h2>
                <div className="bg-surface border border-line rounded-xl overflow-hidden">
                  {list.length === 0 ? (
                    <div className="px-4 py-4 text-[12.5px] text-muted">{g.empty}</div>
                  ) : list.map((r) => (
                    <PortalRow key={r.client_id} r={r} group={g.id} open={open === r.client_id} onToggle={() => setOpen(open === r.client_id ? null : r.client_id)} onChange={load} />
                  ))}
                </div>
              </div>
            );
          })}

          {isAdmin(me) && <PaymentQrCodes />}
        </>
      )}

      {bulkOpen && <BulkInvite eligible={eligible} onClose={() => setBulkOpen(false)} onSent={load} />}
    </div>
  );
}

function PortalRow({ r, group, open, onToggle, onChange }: {
  r: CustomerPortalAccess; group: Group; open: boolean; onToggle: () => void; onChange: () => void;
}) {
  const signedUp = r.accounts.map((a) => a.created_at).filter(Boolean).sort()[0];
  const last = r.accounts.map((a) => a.last_login_at).filter(Boolean).sort().pop();
  const suspended = r.accounts.length > 0 && r.accounts.every((a) => a.status === "suspended");
  const mail = emailState(r);
  const who = group === "signed" ? r.accounts.map((a) => a.email).join(", ") : r.invite?.email || r.client_email;
  return (
    <div className="border-b border-line-2 last:border-b-0">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 transition-colors">
        <button onClick={onToggle} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <ChevronDown size={15} className={`text-faint flex-shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-ink truncate">{r.client_name}{r.company ? <span className="text-muted font-normal"> · {r.company}</span> : null}</div>
            <div className="text-[12px] text-muted truncate">{who || "No email"}</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {suspended && <StatusPill tone="warning">Suspended</StatusPill>}
            {group !== "signed" && mail && <StatusPill tone={mail.tone}>{mail.text}</StatusPill>}
          </div>
          <div className="w-[190px] text-right text-[12px] text-muted hidden md:block leading-tight">
            {group === "signed" && <>
              <div className="text-ink-2">Signed up {portalDate(signedUp || "")}</div>
              <div>{last ? `Last signed in ${portalDate(last)}` : "Has not signed in yet"}</div>
            </>}
            {group === "invited" && r.invite && <>
              <div className="text-ink-2">Invited {portalDate(r.invite.created_at)}</div>
              <div>Expires {portalDate(r.invite.expires_at)}</div>
            </>}
            {group === "expired" && r.invite && <>
              <div className="text-ink-2">Invited {portalDate(r.invite.created_at)}</div>
              <div>Expired {portalDate(r.invite.expires_at)}</div>
            </>}
          </div>
        </button>
        <button onClick={() => openCustomerPortal(r.client_id)} className={quietBtn}>
          View portal <ExternalLink size={12} />
        </button>
      </div>
      {open && (
        <div className="px-4 pb-3 pl-11">
          {r.invite?.email_status === "failed" && r.invite.email_error && (
            <div className="text-[12px] text-danger-ink mb-2">The invite email failed: {r.invite.email_error}</div>
          )}
          <CustomerPortalPanel bare clientId={r.client_id} clientName={r.client_name} clientEmail={r.client_email} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function BulkInvite({ eligible, onClose, onSent }: { eligible: CustomerPortalEligible[]; onClose: () => void; onSent: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(eligible.filter((e) => !e.blocked && !e.open_invite).map((e) => e.client_id)));
  const [busy, setBusy] = useState(false);
  const selectable = eligible.filter((e) => !e.blocked);

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const send = async () => {
    if (chosen.size === 0) return;
    if (!confirm(`Email a portal invite to ${chosen.size} customer${chosen.size === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    try {
      const r = await api.customerPortalInviteBulk([...chosen]);
      toast(`Sending ${r.queued} invite${r.queued === 1 ? "" : "s"}${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}`);
      onSent();
      onClose();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-xl w-full max-w-[640px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Invite customers you've done deals with</h2>
            <p className="text-[12.5px] text-muted">Each one gets an email with their own sign-up link, sent one after another.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="flex items-center gap-3 px-5 py-2 border-b border-line-2 text-[12px]">
          <button onClick={() => setChosen(new Set(selectable.map((e) => e.client_id)))} className="text-accent hover:underline">Select all</button>
          <button onClick={() => setChosen(new Set())} className="text-accent hover:underline">Select none</button>
          <span className="ml-auto text-muted">{chosen.size} selected</span>
        </div>
        <div className="overflow-y-auto flex-1">
          {eligible.map((e) => {
            const disabled = !!e.blocked;
            return (
              <label key={e.client_id} className={`flex items-center gap-3 px-5 py-2.5 border-b border-line-2 last:border-b-0 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-surface-2"}`}>
                <input type="checkbox" disabled={disabled} checked={chosen.has(e.client_id)} onChange={() => toggle(e.client_id)} className="accent-[var(--accent)] w-4 h-4 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink truncate">{e.client_name}{e.company ? <span className="text-muted"> · {e.company}</span> : null}</div>
                  <div className="text-[11.5px] text-muted truncate">{e.email || "No email on file"}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  {e.blocked ? <StatusPill tone={e.blocked === "Already signed up" ? "success" : "neutral"}>{e.blocked}</StatusPill>
                    : e.open_invite ? <StatusPill tone="accent">Invite already open</StatusPill> : null}
                  <div className="text-[11px] text-muted mt-0.5">{e.completed_deals} completed deal{e.completed_deals === 1 ? "" : "s"}</div>
                </div>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          <button onClick={onClose} className={quietBtn}>Cancel</button>
          <button disabled={busy || chosen.size === 0} onClick={send} className={primaryBtn}>
            <Send size={14} />Email {chosen.size} invite{chosen.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentQrCodes() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);

  const loadImage = useCallback(async (id: string) => {
    const img = await api.customerPortalQrImage(id).catch(() => null);
    setImages((prev) => ({ ...prev, [id]: img }));
  }, []);

  useEffect(() => {
    api.listPaymentMethods().then((all) => {
      const active = all.filter((m) => m.active);
      setMethods(active);
      active.forEach((m) => loadImage(m.id));
    }).catch(() => setMethods([]));
  }, [loadImage]);

  const onFile = async (file: File | undefined) => {
    const id = target.current;
    if (!file || !id) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) { toast("Use a PNG or JPEG image of the QR code.", "error"); return; }
    setBusy(id);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await api.customerPortalUploadQr(id, btoa(bin), file.type);
      await loadImage(id);
      toast("QR code saved. Customers see it under How to pay.");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (methods.length === 0) return null;
  return (
    <div className="bg-surface border border-line rounded-xl p-4 mt-2">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink mb-1"><QrCode size={15} className="text-muted" />Payment QR codes</div>
      <p className="text-[12.5px] text-muted mb-3">Customers see these on How to pay in their portal. Save the QR code from your bank app, then upload it here.</p>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {methods.map((m) => {
          const img = images[m.id];
          return (
            <div key={m.id} className="flex items-center gap-4 border border-line-2 rounded-lg p-3">
              {img
                ? <img src={img} alt={`${m.kind} QR code`} className="w-24 h-24 object-contain rounded-md border border-line p-1 flex-shrink-0" style={{ background: "white" }} />
                : <div className="w-24 h-24 rounded-md border border-dashed border-line flex items-center justify-center text-[11px] text-muted text-center flex-shrink-0">No QR code yet</div>}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{m.kind}</div>
                {m.label && m.label !== m.kind && <div className="text-[12px] text-muted truncate">{m.label}</div>}
                <div className="flex flex-wrap gap-2 mt-2">
                  <button disabled={busy === m.id} onClick={() => { target.current = m.id; fileRef.current?.click(); }} className={quietBtn}>
                    {img ? "Replace image" : "Upload QR image"}
                  </button>
                  {img && (
                    <button disabled={busy === m.id} onClick={async () => {
                      if (!confirm(`Remove the ${m.kind} QR code from the portal?`)) return;
                      setBusy(m.id);
                      try { await api.customerPortalRemoveQr(m.id); await loadImage(m.id); } catch (e) { toast(String(e), "error"); } finally { setBusy(null); }
                    }} className="inline-flex items-center h-8 px-3 rounded-lg text-[12px] font-medium text-danger-ink hover:bg-danger-bg">Remove</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
