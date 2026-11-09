import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isUnavailable, type ApprovalRequest, type Client, type LeadNotification, type Me } from "../lib/api";
import PendingReviewModal from "./PendingReviewModal";
import { Inbox, X, Store, Reply } from "lucide-react";
import StatusPill from "./StatusPill";
import { openLoadInLogistics } from "./LogisticsPayCarriers";
import { LEAD_OPEN_KEY } from "./SupplierLeadsInbox";
import {
  BILL_OPEN_KEY, CALL_OPEN_KEY, canOpenTarget, canSeeGroup, compareRows, customerRow, groupRows, moneyTone, noticeRow, noticeTarget, requestRow, tierOf, whenWearsUrgency, whenWords,
  type NoticeGroup, type NoticeRow, type NoticeTarget, type Urgency,
} from "../lib/notices";
import type { NoticeState } from "../lib/useNotices";
import { isAdmin } from "../lib/permissions";
import { localDay } from "../lib/format";
import { renewalLine } from "../lib/renewals";
import { Button, PageActions } from "./ui";

const kindLabel = (k: string) => (k === "client_delete" ? "Delete client" : k);

function sourceLabel(m: Record<string, any> | null | undefined): string {
  const s = String(m?.source || "");
  if (s === "shopify") return "Shopify";
  if (s === "intake") return "Web form";
  if (s === "form") return "Ecliptr form";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function ApprovalDetail({ a, onClose, onResolved }: { a: ApprovalRequest; onClose: () => void; onResolved: () => void }) {
  const [client, setClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!a.entity_id) return;
    api.getClient(a.entity_id).then((c) => setClient(c)).catch(() => {});
  }, [a.entity_id]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    await api.resolveApprovalRequest(a.id, approve).catch(() => {});
    setBusy(false); onResolved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-5 max-h-[88vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[16px] font-medium text-ink">{kindLabel(a.kind)}</h3>
          <button onClick={onClose} aria-label="Close" className="ui-ib"><X size={16} /></button>
        </div>
        <div className="ui-note mb-4">
          {a.requested_by_name ? `Requested by ${a.requested_by_name}, ` : ""}{new Date(a.created_at).toLocaleString()}
        </div>
        <div className="text-[14px] text-ink mb-4 bg-surface-2 rounded-lg p-3">
          Approving will <b>permanently delete</b> {client?.name || a.summary}.
        </div>
        <div className="flex gap-2">
          <Button variant="ink" className="flex-1" disabled={busy} onClick={() => decide(true)}>Approve deletion</Button>
          <Button disabled={busy} onClick={() => decide(false)}>Reject</Button>
        </div>
      </div>
    </div>
  );
}

// R-642: Reply opens the lead in Suppliers > Website leads, where it reads like an email and the reply goes from
// Ecliptr with the signature and logo (R-366 opened a Gmail compose). The website's forms send `email`; a
// hand-mapped form may call it anything, so any value shaped like an address counts. No address, no Reply.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function replyToLead(n: LeadNotification) {
  try { localStorage.setItem(LEAD_OPEN_KEY, n.id); } catch { /* storage blocked: the inbox just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "suppliers" }));
  setTimeout(() => window.dispatchEvent(new CustomEvent("supplier-lead-open")), 100);
}

// R-460: where Open goes. A load opens on the step the notice names (the same stash-then-switch handoff
// the Bills screen uses to open a load), a bill opens on the Bills screen.
function openTarget(t: NoticeTarget) {
  if (t.to === "load") { openLoadInLogistics(t.id, t.step); return; }
  if (t.to === "logistics") { window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "logistics" })); return; }
  if (t.to === "bank") { window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "financials" })); return; }
  if (t.to === "call") {
    try { localStorage.setItem(CALL_OPEN_KEY, t.id); } catch { /* storage blocked: Clients just opens */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clients" }));
    setTimeout(() => window.dispatchEvent(new CustomEvent("calls-open")), 100);
    return;
  }
  if (t.to === "deal") {
    try { localStorage.setItem("dealflow_invoice_filter", t.invoice); } catch { /* storage blocked: Deal Flow just opens */ }
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "dealflow" }));
    return;
  }
  try { if (t.id) localStorage.setItem(BILL_OPEN_KEY, t.id); } catch { /* storage blocked: Bills just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "bills" }));
  setTimeout(() => window.dispatchEvent(new CustomEvent("bills-open")), 100);
}

// R-477: one row shape for everything on this screen. Its urgency shows in the colour of the label
// (red overdue, amber needs you, grey for your information). A coloured dot ahead of a label is a
// standing veto in the design rules, so the colour rides the words instead.
const URGENCY_TEXT: Record<Urgency, string> = { overdue: "text-danger-ink", needs: "text-warning-ink", info: "text-muted" };
// R-571: a money row's label is green for money in and plain ink for a charge; an urgent row sits on its colour's ground.
const labelText = (r: NoticeRow): string => {
  const m = moneyTone(r);
  return m === "in" ? "text-success-ink" : m === "out" ? "text-ink" : URGENCY_TEXT[r.urgency];
};
const urgentGround = (_r: NoticeRow): string => "";
const BTN_SOLID = "ui-btn ui-btn-ink";
const BTN_LINE = "ui-btn";
// The buttons keep one width inside a group, so the "when" column lines up whichever buttons a row has.
// One width for every group (the widest, Approve and Reject), so the when column is one straight line down the screen.
const BUTTONS_W: Record<NoticeGroup, string> = { bills: "w-[172px]", logistics: "w-[172px]", bank: "w-[172px]", leads: "w-[172px]", customers: "w-[172px]", requests: "w-[172px]", calls: "w-[172px]" };

/** A row plus whatever it was made from, so its buttons know what to act on. */
type Item = NoticeRow & { n?: LeadNotification; c?: Client; a?: ApprovalRequest };

const fieldLabel = (k: string) => { const s = k.replace(/[_-]/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

// The lead's own details, opened under its row: every field of the form in two columns, and the Reply.
function LeadDetails({ n }: { n: LeadNotification }) {
  let fields: Record<string, any> = {};
  try { fields = n.payload_json ? JSON.parse(n.payload_json) : {}; } catch { /* ignore */ }
  const entries = Object.entries(fields).filter(([, v]) => v != null && v !== "");
  const canReply = [fields.email, ...Object.values(fields)].some((v) => EMAIL_RE.test(String(v ?? "").trim()));
  return (
    <div className="px-2 pb-4 animate-fade-in">
      {entries.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {entries.map(([k, v]) => (
            <div key={k} className="text-[14px] min-w-0">
              <span className="text-muted">{fieldLabel(k)}: </span>
              <span className="text-ink break-words">{String(v)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-muted">{n.body || "No details came with this one."}</div>
      )}
      {canReply && (
        <button onClick={() => replyToLead(n)} title="Opens this lead in Suppliers, Website leads"
          className={`${BTN_SOLID} mt-3`}>
          <Reply size={14} /> Reply
        </button>
      )}
    </div>
  );
}

export function ApprovalsView({ me, notices }: { me?: Me | null; notices?: NoticeState }) {
  // R-460: someone who only sees deals or the books has no customers or requests to review, only the
  // logistics and bill notices below. The admin calls are never made for them.
  const admin = isAdmin(me);
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [pending, setPending] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  // R-477: a read that fails says so in its own group; it never reads as "Nothing waiting on you".
  const [requestsFailed, setRequestsFailed] = useState(false);
  const [customersFailed, setCustomersFailed] = useState(false);
  const [selected, setSelected] = useState<ApprovalRequest | null>(null);
  const [reviewClient, setReviewClient] = useState<Client | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // Archive toggle — swaps the whole page to resolved (approved/rejected)
  // requests, read-only. Server-backed (Pass 2); loaded once, on first switch.
  const [archived, setArchived] = useState(false);
  const [resolvedList, setResolvedList] = useState<Client[] | null>(null);
  const [resolvedUnavailable, setResolvedUnavailable] = useState(false);
  const [loadingResolved, setLoadingResolved] = useState(false);

  // The server's notices (bills, logistics, supplier leads) arrive through `notices`, read once by the app's
  // hook; only the pending customers and the approval requests are read here.
  const load = useCallback(() =>
    !admin ? Promise.resolve().then(() => setLoading(false)) :
    Promise.all([
      api.listApprovalRequests().then((r) => { setItems(r); setRequestsFailed(false); }).catch(() => setRequestsFailed(true)),
      api.getPendingApprovals().then((r) => { setPending(r); setCustomersFailed(false); }).catch(() => setCustomersFailed(true)),
    ]).finally(() => setLoading(false)), [admin]);
  // R-477: read again when something is settled anywhere (this screen, another, another device), and once
  // a minute like the notices do.
  useEffect(() => {
    load();
    const un: (() => void)[] = [];
    let dead = false;
    listen("netsync-applied", () => load()).then((u) => { if (dead) u(); else un.push(u); }).catch(() => {});
    window.addEventListener("approvals-changed", load);
    const t = window.setInterval(load, 60_000);
    return () => { dead = true; un.forEach((u) => u()); window.removeEventListener("approvals-changed", load); window.clearInterval(t); };
  }, [load]);

  useEffect(() => {
    if (!archived || resolvedList !== null) return;
    setLoadingResolved(true);
    api.listResolvedApprovalRequests().then((r) => {
      if (isUnavailable(r)) { setResolvedUnavailable(true); setResolvedList([]); }
      else setResolvedList(r);
    }).finally(() => setLoadingResolved(false));
  }, [archived, resolvedList]);

  const changed = () => window.dispatchEvent(new CustomEvent("approvals-changed"));
  const resolved = () => { setSelected(null); changed(); };
  const quick = async (id: string, approve: boolean) => {
    await api.resolveApprovalRequest(id, approve).catch(() => {});
    changed();
  };
  // An unsubscribe is already applied; clearing it only closes the request.
  const clearRequest = async (a: ApprovalRequest) => {
    setItems((l) => l.filter((x) => x.id !== a.id));
    await api.resolveApprovalRequest(a.id, true).catch(() => {});
    changed();
  };
  // Clear reads the notice; Open reads it too, then goes to it. The bell reads the server again after either.
  const clearNotice = async (n: LeadNotification) => {
    notices?.drop(n.id);
    await api.ackLeadNotification(n.id).catch(() => {});
    changed();
  };
  const openNotice = async (n: LeadNotification) => {
    const t = noticeTarget(n);
    await clearNotice(n);
    if (t) openTarget(t);
  };

  // Stale storefront listings (renew or mark sold) are one line that opens the Renewals screen (R-466).
  const staleListings = requestsFailed ? [] : items.filter((a) => a.kind === "listing_stale");

  // R-477: every source becomes the same kind of row, then the rows are grouped and put most urgent first.
  const noticesFailed = !!notices?.failed;
  const today = localDay();
  // R-571: what is urgent (money in today, an overdue bill or carrier, the pay day) is lifted into one block above the
  // groups, most pressing first; the groups hold the rest.
  const { urgent, groups } = useMemo(() => {
    const rows: Item[] = [];
    if (notices && !notices.failed) {
      for (const n of [...notices.team, ...notices.leads]) { const r = noticeRow(n); if (r) rows.push({ ...r, n }); }
    }
    if (!customersFailed) for (const c of pending) rows.push({ ...customerRow(c), c });
    if (!requestsFailed) for (const a of items) { const r = requestRow(a); if (r) rows.push({ ...r, a }); }
    const failed: NoticeGroup[] = [
      ...(noticesFailed ? (["bills", "logistics", "leads", "calls"] as const).filter((g) => canSeeGroup(g, me)) : []),
      ...(customersFailed ? (["customers"] as const) : []),
      ...(requestsFailed ? (["requests"] as const) : []),
    ];
    const isUrgent = (r: Item) => tierOf(r, today) === "urgent";
    return { urgent: rows.filter(isUrgent).sort(compareRows), groups: groupRows(rows.filter((r) => !isUrgent(r)), failed) };
  }, [notices, noticesFailed, pending, items, customersFailed, requestsFailed, me, today]);
  const retry = (g: NoticeGroup) => { if (g === "customers" || g === "requests") load(); else notices?.refresh(); };
  const ready = !loading && (!notices || notices.loaded);

  const buttons = (r: Item) => {
    const clear = (what: () => void) => (
      <button onClick={what} aria-label="Clear" title="Clear" className="ui-btn">Clear</button>
    );
    if (r.c) return <button onClick={() => setReviewClient(r.c!)} className={BTN_SOLID}>Review</button>;
    if (r.a?.kind === "client_delete") {
      return (<>
        <button onClick={() => quick(r.a!.id, true)} className={BTN_SOLID}>Approve</button>
        <button onClick={() => quick(r.a!.id, false)} className={BTN_LINE}>Reject</button>
      </>);
    }
    // R-559: the server adds the lot, or renews it with its new price, once the answer reaches it.
    if (r.a?.kind === "lot_feed_new" || r.a?.kind === "lot_feed_repeat") {
      const repeat = r.a.kind === "lot_feed_repeat";
      return (<>
        <button onClick={() => quick(r.a!.id, true)} className={BTN_SOLID}>{repeat ? "Reset time" : "Add"}</button>
        <button onClick={() => quick(r.a!.id, false)} className={BTN_LINE}>{repeat ? "Remove duplicate" : "Discard"}</button>
      </>);
    }
    if (r.a) return clear(() => clearRequest(r.a!));
    const n = r.n!;
    if (r.group === "leads") {
      return (<>
        <button onClick={() => setOpened((k) => (k === r.key ? null : r.key))} aria-expanded={opened === r.key} className={`${BTN_SOLID} min-w-[72px]`}>
          {opened === r.key ? "Close" : "Open"}
        </button>
        {clear(() => clearNotice(n))}
      </>);
    }
    return (<>
      {r.kind !== "bill_paid" && canOpenTarget(noticeTarget(n), me) && <button onClick={() => openNotice(n)} className={BTN_SOLID}>Open</button>}
      {clear(() => clearNotice(n))}
    </>);
  };

  const rowView = (r: Item, ground = "") => (
    <div key={r.key} className={ground}>
      <div className="px-2 py-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <span className={`w-[116px] flex-shrink-0 text-[14px] font-medium ${labelText(r)}`}>{r.label}</span>
        {/* The subject wraps to a second line before it is cut, so a load number at its end stays in view. */}
        {r.a?.kind === "client_delete" ? (
          <button onClick={() => setSelected(r.a!)} title="Review this request"
            className="min-w-[120px] flex-1 text-left text-[14px] leading-snug text-ink hover:underline underline-offset-2">
            <span className="line-clamp-2 break-words">{r.subject}</span>
          </button>
        ) : (
          <span className="min-w-[120px] flex-1 text-[14px] leading-snug text-ink line-clamp-2 break-words" title={r.subject}>{r.subject}</span>
        )}
        {/* An overdue row's when wears the label's colour, so "3 days overdue" is as plain as "Bill overdue". */}
        <span className={`w-[108px] flex-shrink-0 text-[13px] ${whenWearsUrgency(r) ? URGENCY_TEXT[r.urgency] : "text-muted"}`}>{whenWords(r, today)}</span>
        <div className={`flex items-center justify-end gap-2 flex-shrink-0 ml-auto ${BUTTONS_W[r.group]}`}>{buttons(r)}</div>
      </div>
      {r.n && opened === r.key && <LeadDetails n={r.n} />}
    </div>
  );

  return (
    <div className="max-w-4xl">
      {admin && (
        <PageActions>
          <button onClick={() => setArchived(false)} className={`ui-opt ${!archived ? "on" : ""}`}>Pending</button>
          <button onClick={() => setArchived(true)} className={`ui-opt ${archived ? "on" : ""}`}>Archive</button>
        </PageActions>
      )}
      <p className="text-[14px] text-muted mb-5">What needs you, grouped by type, the most urgent first.</p>

      {archived && admin ? (
        resolvedUnavailable ? (
          <div className="py-14 flex flex-col items-center">
            <div className="text-[14px] text-muted">Unavailable</div>
          </div>
        ) : loadingResolved ? (
          <div className="py-14 flex flex-col items-center">
            <div className="text-[14px] text-muted">Loading...</div>
          </div>
        ) : (resolvedList ?? []).length === 0 ? (
          <div className="py-14 flex flex-col items-center">
            <Inbox size={18} className="text-faint mb-3" />
            <div className="text-[14px] text-muted">No resolved requests yet</div>
          </div>
        ) : (
          <div>
            {(resolvedList ?? []).map((c) => {
              const src = sourceLabel(c.metadata);
              const approved = c.approval_status === "approved";
              const initials = (c.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
              return (
                <div key={c.id} className="flex items-center gap-3 px-2 py-3 shadow-[inset_0_1px_0_rgb(var(--c-line))]">
                  <span className="w-9 h-9 rounded-full bg-surface-3 text-ink-2 flex items-center justify-center text-[12px] font-medium flex-shrink-0">{initials}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-ink truncate">{c.name}</span>
                      {src && <StatusPill tone="neutral">{src}</StatusPill>}
                    </div>
                    <div className="text-[13px] text-muted truncate">{[c.email, c.company].filter(Boolean).join(" · ") || "-"}</div>
                  </div>
                  <StatusPill tone={approved ? "success" : "danger"}>{approved ? "Approved" : "Rejected"}</StatusPill>
                </div>
              );
            })}
          </div>
        )
      ) : !ready ? null : urgent.length === 0 && groups.length === 0 && staleListings.length === 0 ? (
        <div className="py-14 flex flex-col items-center">
          <Inbox size={18} className="text-faint mb-3" />
          <div className="text-[14px] text-muted">Nothing waiting on you</div>
        </div>
      ) : (
        <div>
          {urgent.length > 0 && (
            <section>
              <div className="hsep" />
              <div className="flex items-center gap-2 pt-5 pb-2">
                <h3 className="text-[16px] font-medium text-ink">Urgent</h3>
                <StatusPill tone="danger">{urgent.length}</StatusPill>
              </div>
              <div className="pb-5">
                {urgent.map((r) => rowView(r, urgentGround(r)))}
              </div>
            </section>
          )}
          {groups.map((g) => (
            <section key={g.group}>
              <div className="hsep" />
              <div className="flex items-center gap-2 pt-5 pb-2">
                <h3 className="text-[16px] font-medium text-ink">{g.label}</h3>
                {!g.failed && <StatusPill tone="neutral">{g.rows.length}</StatusPill>}
              </div>
              <div className="pb-5">
                {g.failed ? (
                  <div className="px-2 py-3.5 flex items-center justify-between gap-4">
                    <span className="text-[14px] text-muted">Could not load {g.label.toLowerCase()}.</span>
                    <button onClick={() => retry(g.group)} className={BTN_LINE}>Try again</button>
                  </div>
                ) : g.rows.map((r) => rowView(r))}
              </div>
            </section>
          ))}

          {/* R-466: the stale storefront listings are one line here; the Renewals screen lists them. */}
          {staleListings.length > 0 && (
            <section>
              <div className="hsep" />
              <div className="px-2 py-4 flex items-center gap-3">
                <Store size={16} className="text-muted flex-shrink-0" />
                <span className="text-[14px] font-medium text-ink min-w-0 flex-1 truncate">{renewalLine(staleListings.length)}</span>
                <button onClick={() => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "renewals" }))}
                  className={`${BTN_LINE} flex-shrink-0`}>Open</button>
              </div>
            </section>
          )}
        </div>
      )}

      {reviewClient && (
        <PendingReviewModal client={reviewClient}
          onClose={() => setReviewClient(null)}
          onResolved={() => { setReviewClient(null); changed(); }} />
      )}
      {selected && <ApprovalDetail a={selected} onClose={() => setSelected(null)} onResolved={resolved} />}
    </div>
  );
}
