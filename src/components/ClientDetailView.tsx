import { useEffect, useMemo, useState, Children } from "react";
import {
  api, Client, Interaction, Invoice, BuyerTier, PortalLink, CustomField, CompanyInfo,
  PaymentMethod, CounterpartyPaymentRow, DealFlow, Supplier, PartyLink, LineItem,
} from "../lib/api";
import { fmtAmount, fmtPhone, localDay, parseLocalDay, primarySupplierLabel } from "../lib/format";
import { parseLineItems, describeItem } from "../lib/itemSearch";
import ReliabilityBadge from "./ReliabilityBadge";
import CreditPanel from "./CreditPanel";
import PersonPayments from "./PersonPayments";
import PersonPickerModal, { PersonRef } from "./PersonPicker";
import { toast } from "./Toast";
import {
  ArrowLeft,
  ArrowRight,
  Mail,
  Phone,
  Building2,
  MapPin,
  Sparkles,
  RefreshCw,
  Plus,
  FileText,
  MessageSquare,
  ShoppingCart,
  XCircle,
  CheckCircle2,
  RotateCcw,
  Target,
  User,
  Tag,
  Pencil,
  Trash2,
  AlertTriangle,
  X,
  Send,
  Check,
  ChevronDown,
  ChevronRight,
  Link2,
  Unlink,
  Banknote,
  Truck,
  Receipt,
} from "lucide-react";

/* ── The party profile (R-153) ───────────────────────────────────────────────
 *
 * Money leads, chrome follows — the same principle that drove the supplier
 * redesign (R-116). What this party is worth, and what is waiting on them, are
 * the first two things on the screen; contact details, portal links and credit
 * limits sit behind a disclosure at the bottom where they belong.
 *
 * The four tabs (overview / emails / invoices / timeline) are gone. They were
 * four permutations of two arrays, and they rendered invoices three separate
 * times. One activity stream now carries interactions, invoices, deals and bank
 * payments together, newest first, with filter chips instead of tabs.
 *
 * THE MONEY RULES ARE BINDING HERE:
 *  * A refund subtracts from that deal's profit IN FULL and a deal CAN go
 *    negative (Jack, 2026-08-19). No cap, no floor.
 *  * Each refund counts exactly once — `refund_status_all` is the one command
 *    that already applies the UNION rule, so profit on this screen is read from
 *    it rather than re-derived.
 *  * Deal flows are deduped by invoice before any SUM.
 *  * Money paid to a party is COST and money from them is REVENUE. The two are
 *    never netted. A single combined figure is called POSITION, never profit.
 */

/* ── Role configuration ──────────────────────────────────────────────────────
 * The supplier profile is meant to be this component with a different config,
 * and another session wires that side. Everything that differs between the two
 * sides of a deal lives in this one map, so that session changes copy, never
 * layout. The pieces below (`NextActionBand`, `ActivityStream`, `PartyLinkPanel`,
 * `StatTile`) are all role-neutral and exported for exactly that reason. */
export type PartyRole = "client" | "supplier";

export const PARTY_COPY: Record<PartyRole, {
  /** What this record is called, lower case, mid-sentence. */
  self: string;
  /** The role on the other side of the link. */
  other: PartyRole;
  /** The link offer, when nothing is linked yet. */
  linkOffer: string;
  /** Heading over money that came FROM them (revenue to us). */
  theirSide: string;
  /** Heading over money that went TO them (cost to us). */
  ourSide: string;
}> = {
  client: {
    self: "client",
    other: "supplier",
    linkOffer: "This client is also a supplier",
    theirSide: "What they bought from us",
    ourSide: "What we bought from them",
  },
  supplier: {
    self: "supplier",
    other: "client",
    linkOffer: "This supplier is also a client",
    theirSide: "What they bought from us",
    ourSide: "What we bought from them",
  },
};

interface Props {
  clientId: string;
  onBack: () => void;
  /** Open the full edit form for this client (handled by the parent list view). */
  onEdit?: (client: Client) => void;
  /** Called after the client is deleted so the parent can refresh + leave. */
  onDeleted?: () => void;
}

const kindColor = (kind: string): string => {
  if (kind === "email_in")  return "bg-info-bg text-info-ink border border-info";
  if (kind === "email_out") return "bg-accent/10 text-accent-hover border border-accent/20";
  if (kind === "call")      return "bg-success-bg text-success-ink border border-success";
  if (kind === "meeting")   return "bg-warning-bg text-warning-ink border border-warning";
  if (kind === "whatsapp")  return "bg-success-bg text-success-ink border border-success";
  if (kind === "sms")       return "bg-info-bg text-info-ink border border-info";
  if (kind === "reminder")  return "bg-accent/10 text-accent border border-accent";
  return "bg-surface-3 text-ink-2 border border-line";
};

const invoiceStatusColor = (s: string): string => {
  if (s === "paid")    return "bg-warning-bg text-warning-ink border border-warning";
  if (s === "sent")    return "bg-info-bg text-info-ink border border-info";
  if (s === "overdue") return "bg-danger-bg text-danger-ink border border-danger";
  return "bg-surface-3 text-ink-2 border border-line";
};

const leadStatusColor = (s: string): string => {
  if (s === "hot_lead")        return "bg-danger-bg text-danger-ink border border-danger";
  if (s === "warm")            return "bg-warning-bg text-warning-ink border border-warning";
  if (s === "active_customer") return "bg-success-bg text-success-ink border border-success";
  if (s === "inactive")        return "bg-surface-3 text-muted border border-line";
  return "bg-accent/10 text-accent-hover border border-accent/20";
};

// Deal stages, worded as what the deal is waiting for. Stage names copied from
// STAGES in DealFlowView.tsx, which does not export them; the two must not drift.
const STAGE_LABEL: Record<string, string> = {
  invoiced: "Invoiced",
  payment_received: "Payment received",
  supplier_paid: "Supplier paid",
  complete: "Complete",
};
const WAITING_ON: Record<string, string> = {
  invoiced: "waiting on their payment",
  payment_received: "waiting on us to pay the supplier",
  supplier_paid: "waiting on us to close it out",
};

/** Drill into the deal that produced an invoice — the same handoff Receivables
 *  and Payables use: stash a search term, then switch tabs. */
const openDeal = (invoiceNumber: string) => {
  try { localStorage.setItem("dealflow_invoice_filter", invoiceNumber); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "dealflow" }));
};

/** Open one invoice's own drawer — the same stash-then-switch handoff, so a line
 *  item on this screen reaches the full invoice in one click (R-235). */
const openInvoice = (invoiceId: string) => {
  try { localStorage.setItem("invoices_open_id", invoiceId); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
};

/** Open the receipt builder on this client — same stash-then-switch handoff. */
const openStatement = (clientId: string) => {
  try { localStorage.setItem("statement_client_id", clientId); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "clientreceipt" }));
};

const openInvoices = () => window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "invoices" }));
/** Open the list the OTHER side of a party link lives in. Role-aware because the
 *  same panel now renders on a supplier profile, where the counterpart is a client. */
const openPartyList = (role: PartyRole) =>
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: role === "supplier" ? "suppliers" : "clients" }));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Sort key for a stream row. A bare YYYY-MM-DD through `new Date()` is parsed
 *  as UTC midnight and reads a day early in Central (R-159), so date-only values
 *  go through parseLocalDay and timestamps keep their time. */
export const atMs = (raw: string): number => {
  const s = (raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseLocalDay(s).getTime();
  const v = new Date(s).getTime();
  return Number.isFinite(v) ? v : 0;
};

/** "Aug 19", "Aug 19, 2025", or "Aug 19 · 3:24 PM" when there is a real time. */
const whenLabel = (raw: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((raw || "").trim());
  if (!m) return "";
  const day = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const dated = Number(m[1]) === new Date().getFullYear() ? day : `${day}, ${m[1]}`;
  if (!/T\d{2}:\d{2}/.test(raw)) return dated;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return dated;
  return `${dated} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};

const relTime = (d: string | null): string => {
  if (!d) return "—";
  const ms = Date.now() - atMs(d);
  if (!Number.isFinite(ms)) return "—";
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

/** Whole days from today to `day` (negative = in the past), in local time. */
const daysFromToday = (day: string): number =>
  Math.round((parseLocalDay(day.slice(0, 10)).getTime() - parseLocalDay(localDay()).getTime()) / 86400000);

/** One deal flow per invoice, keeping the LOWEST id — the same survivor rule the
 *  backend uses (`MIN(d2.id)`). Duplicate rows for one invoice are a known live
 *  condition and would double every total taken over them. */
export const dedupeByInvoice = (flows: DealFlow[]): DealFlow[] => {
  const best = new Map<string, DealFlow>();
  for (const f of flows) {
    const cur = best.get(f.invoice_id);
    if (!cur || f.id < cur.id) best.set(f.invoice_id, f);
  }
  return [...best.values()];
};

// A premium labeled on/off switch. `tone` colours the ON state: accent for a
// positive flag (high-value), neutral for a quiet flag (no-bulk), danger for a
// caution flag (blacklist). Off is a calm muted rail. An internal pending guard
// swallows rapid double-clicks so the visible state can't desync from the server.
function FlagSwitch({ label, on, onToggle, title, tone = "accent" }: {
  label: string;
  on: boolean;
  onToggle: () => void | Promise<void>;
  title?: string;
  tone?: "accent" | "neutral" | "danger";
}) {
  const [busy, setBusy] = useState(false);
  const trackOn =
    tone === "danger" ? "bg-danger border-danger" :
    tone === "neutral" ? "bg-ink-2 border-ink-2" :
    "bg-accent border-accent";
  const click = () => {
    if (busy) return;
    setBusy(true);
    Promise.resolve(onToggle()).finally(() => setBusy(false));
  };
  return (
    <button
      onClick={click}
      role="switch"
      aria-checked={on}
      aria-busy={busy}
      title={title}
      disabled={busy}
      className={`group inline-flex items-center justify-between gap-3 w-[168px] pl-3 pr-2 h-8 rounded-lg border text-[12px] font-medium transition-colors disabled:opacity-70 ${
        on
          ? "bg-surface-2 border-line-3 text-ink"
          : "bg-surface border-line text-muted hover:text-ink-2 hover:border-line-3"
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`relative w-9 h-5 rounded-full flex-shrink-0 border transition-colors ${
          on ? trackOn : "bg-surface-3 border-line-3"
        }`}
      >
        <span
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-all ${
            on ? "left-[18px]" : "left-[3px]"
          }`}
        />
      </span>
    </button>
  );
}

// A calm key-stat tile for the money band. Role-neutral.
export function StatTile({ label, value, tone = "ink", hint }: { label: string; value: string; tone?: "ink" | "success" | "warning" | "danger" | "muted"; hint?: string }) {
  const valCls = tone === "success" ? "text-success-ink" : tone === "warning" ? "text-warning-ink" : tone === "danger" ? "text-danger-ink" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="bg-surface-2/60 border border-line-2 rounded-xl px-3.5 py-3">
      <div className="text-[12.5px] font-medium text-muted tracking-wide">{label}</div>
      <div className={`text-[17px] font-bold tabular-nums mt-1 truncate ${valCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-faint truncate mt-0.5">{hint}</div>}
    </div>
  );
}

function SubHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">{icon}{children}</div>;
}

/** A section that stays shut until asked for. The admin drawer at the bottom of
 *  the profile is one of these — portal links and credit limits used to sit
 *  above the history of the relationship. */
function Disclosure({ title, icon, children, defaultOpen = false }: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface border border-line rounded-2xl mb-4 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-6 py-4 text-left text-[13px] font-semibold text-ink hover:bg-surface-2 transition-colors"
      >
        {open ? <ChevronDown size={15} className="text-muted flex-shrink-0" /> : <ChevronRight size={15} className="text-muted flex-shrink-0" />}
        {icon}
        {title}
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </div>
  );
}

/* ── The next-action line ────────────────────────────────────────────────────
 * What is owed, what is overdue, what is waiting on them. Role-neutral: the
 * caller assembles the actions, this renders them. The most urgent leads; the
 * rest ride the same band as a quiet second line, so the screen is a worklist
 * and not a record. */
export type NextAction = {
  tone: "danger" | "warning" | "muted";
  text: string;
  /** Optional one-click hop to wherever the action gets done. */
  go?: { label: string; onClick: () => void };
};

export function NextActionBand({ actions, followUp, onFollowUp }: {
  actions: NextAction[];
  /** YYYY-MM-DD, or "" when none is set. Always offered — it used to render only
   *  when a date already existed, nine cards down inside a metadata panel. */
  followUp: string;
  onFollowUp: (day: string) => void | Promise<void>;
}) {
  const head = actions[0];
  const rest = actions.slice(1);
  const band =
    head?.tone === "danger" ? "bg-danger-bg border-danger" :
    head?.tone === "warning" ? "bg-warning-bg border-warning" :
    "bg-surface-2 border-line";
  const headCls =
    head?.tone === "danger" ? "text-danger-ink" :
    head?.tone === "warning" ? "text-warning-ink" :
    "text-ink-2";
  return (
    <div className={`mt-4 rounded-xl border px-4 py-3 ${band}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className={`text-[13.5px] font-semibold flex items-center gap-2 ${headCls}`}>
            {head?.tone === "danger" && <AlertTriangle size={14} className="flex-shrink-0" />}
            {head ? head.text : "Nothing is waiting on them right now."}
          </div>
          {rest.length > 0 && (
            <div className="text-[12px] text-muted mt-1 leading-relaxed">{rest.map((a) => a.text).join(" · ")}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {head?.go && (
            <button onClick={head.go.onClick} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:text-accent-hover transition-colors">
              {head.go.label} <ArrowRight size={12} />
            </button>
          )}
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            Follow up
            <input
              type="date"
              value={followUp}
              onChange={(e) => onFollowUp(e.target.value)}
              className="bg-surface border border-line rounded-lg h-7 px-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

/* ── The activity stream ─────────────────────────────────────────────────────
 * Interactions, invoices, deals and bank payments in one list, newest first.
 * Role-neutral — the caller builds the items. */
export type StreamGroup = "contact" | "email" | "invoice" | "deal" | "payment";

export type StreamItem = {
  key: string;
  at: string;
  group: StreamGroup;
  chip: string;
  chipCls: string;
  title?: string | null;
  body?: string | null;
  /** Who logged it. `interactions.user_name` has carried this since migration 25
   *  (R-152-c) — no row should read as anonymous once the desktop SELECT returns it. */
  author?: string | null;
  amount?: number | null;
  amountTone?: "ink" | "success" | "danger";
  meta?: string | null;
  go?: { label: string; onClick: () => void };
};

const GROUP_LABEL: Record<StreamGroup, string> = {
  contact: "Notes & calls",
  email: "Emails",
  invoice: "Invoices",
  deal: "Deals",
  payment: "Payments",
};

export function ActivityStream({ items, header }: { items: StreamItem[]; header?: React.ReactNode }) {
  const [group, setGroup] = useState<StreamGroup | "all">("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) c[it.group] = (c[it.group] || 0) + 1;
    return c;
  }, [items]);
  const shown = useMemo(
    () => (group === "all" ? items : items.filter((i) => i.group === group)),
    [items, group],
  );
  const chips = (Object.keys(GROUP_LABEL) as StreamGroup[]).filter((g) => (counts[g] || 0) > 0 || group === g);

  return (
    <div className="bg-surface border border-line rounded-2xl">
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-4 border-b border-line">
        <SubHeading icon={<MessageSquare size={15} className="text-muted" />}>Activity</SubHeading>
        {header}
      </div>
      <div className="flex flex-wrap gap-1.5 px-6 pt-3">
        <button
          onClick={() => setGroup("all")}
          className={`text-[11.5px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
            group === "all" ? "bg-accent text-on-accent border-accent" : "bg-surface text-muted border-line hover:bg-surface-2"
          }`}
        >
          Everything · {items.length}
        </button>
        {chips.map((g) => (
          <button
            key={g}
            onClick={() => setGroup(group === g ? "all" : g)}
            className={`text-[11.5px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
              group === g ? "bg-accent text-on-accent border-accent" : "bg-surface text-muted border-line hover:bg-surface-2"
            }`}
          >
            {GROUP_LABEL[g]} · {counts[g] || 0}
          </button>
        ))}
      </div>
      <div className="mt-2 max-h-[640px] overflow-auto">
        {shown.map((it) => (
          <div key={it.key} className="px-6 py-3 border-t border-line-2 first:border-t-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium border ${it.chipCls}`}>
                    {it.chip}
                  </span>
                  <span className="text-[11px] text-muted tabular-nums">{whenLabel(it.at)}</span>
                  {it.author && <span className="text-[11px] text-ink-2">{it.author}</span>}
                </div>
                {it.title && <div className="text-[13.5px] font-medium text-ink mt-1">{it.title}</div>}
                {it.body && <div className="text-[13px] text-ink-2 mt-0.5 whitespace-pre-wrap leading-relaxed">{it.body}</div>}
                {it.meta && <div className="text-[11.5px] text-muted mt-0.5">{it.meta}</div>}
              </div>
              <div className="flex-shrink-0 text-right">
                {typeof it.amount === "number" && (
                  <div className={`text-[13px] font-semibold tabular-nums ${
                    it.amountTone === "success" ? "text-success-ink" : it.amountTone === "danger" ? "text-danger-ink" : "text-ink"
                  }`}>
                    {fmtAmount(it.amount)}
                  </div>
                )}
                {it.go && (
                  <button
                    onClick={it.go.onClick}
                    title={it.go.label}
                    aria-label={it.go.label}
                    className="mt-1 w-5 h-5 inline-flex items-center justify-center rounded text-faint hover:text-ink-2 hover:bg-surface-2 transition-colors"
                  >
                    <ArrowRight size={11} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-muted">
            {items.length === 0 ? "Nothing has happened with them yet." : "Nothing under this filter."}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── The three deal sections (R-235) ─────────────────────────────────────────
 *
 * Jack, 2026-09-03: "I want to see 3 sections, deals completed, deals fell
 * throguh, and current deals meaning theyre still in deal flow. I want it to
 * explicitly show the items on the invoice with all details and alllow me to
 * click on any of them to see them fully."
 *
 * The buckets are built off `invoices`, NEVER off `flows`. `list_deal_flows`
 * filters `COALESCE(i.voided,0)=0`, so a fell-through deal is invisible to it by
 * construction — which is why this screen could not show his losses at all
 * before this section existed. `list_invoices_for_client` filters `archived`
 * only and carries both `voided` and `line_items_json`, so every bucket and
 * every line item comes from data the screen already held in memory.
 *
 * Fell-through wins where an invoice is both voided and complete (Jack,
 * 2026-09-03): voiding is the later act and the deliberate one.
 */

export type DealRow = {
  invoice: Invoice;
  flow: DealFlow | undefined;
  items: LineItem[];
  refunded: number;
};

function DealSection({ title, icon, rows, tone, empty, defaultOpen, showStage }: {
  title: string;
  icon: React.ReactNode;
  rows: DealRow[];
  tone: "success" | "danger" | "accent";
  empty: string;
  defaultOpen: boolean;
  showStage: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const value = rows.reduce((sum, r) => sum + (r.invoice.total || 0), 0);
  const badge = {
    success: "bg-success-bg text-success-ink border-success-line",
    danger: "bg-danger-bg text-danger-ink border-danger-line",
    accent: "bg-accent/10 text-accent-hover border-accent/20",
  }[tone];

  return (
    <div className="bg-surface border border-line rounded-2xl p-6 mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 text-left">
        <span className="flex items-center gap-2">
          {icon}
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium border ${badge}`}>
            {rows.length}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <span className="text-[13px] font-semibold text-ink tabular-nums">{fmtAmount(value)}</span>
          <ChevronDown size={15} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (rows.length === 0 ? (
        <p className="text-[12.5px] text-muted mt-3">{empty}</p>
      ) : (
        <div className="mt-3 border border-line rounded-lg divide-y divide-line-2 overflow-hidden">
          {rows.map(({ invoice, flow, items, refunded }) => {
            const supplier = flow ? primarySupplierLabel(flow.supplier_payments) : "";
            return (
              <div key={invoice.id} className="px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      onClick={() => openInvoice(invoice.id)}
                      title="Open this invoice"
                      className="text-[13px] text-ink hover:text-accent-hover transition-colors text-left truncate"
                    >
                      {invoice.number ? `Invoice ${invoice.number}` : flow?.name || "Deal"}
                    </button>
                    {showStage && flow && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-accent/10 text-accent-hover border border-accent/20">
                        {STAGE_LABEL[flow.stage] || flow.stage}
                      </span>
                    )}
                    {refunded > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[10.5px] font-semibold text-danger-ink">
                        <RotateCcw size={10} /> Refunded {fmtAmount(refunded)}
                      </span>
                    )}
                    <div className="text-[11.5px] text-muted mt-0.5">
                      {[
                        invoice.issue_date ? invoice.issue_date.slice(0, 10) : null,
                        showStage && flow ? WAITING_ON[flow.stage] : null,
                        supplier ? `supplier ${supplier}` : null,
                      ].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[13px] font-semibold tabular-nums ${tone === "danger" ? "line-through text-faint" : "text-ink"}`}>
                      {fmtAmount(invoice.total)}
                    </span>
                    {invoice.number && (
                      <button onClick={() => openDeal(invoice.number)} title="Open this deal in Deal flow"
                        aria-label="Open this deal in Deal flow"
                        className="w-6 h-6 inline-flex items-center justify-center rounded text-faint hover:text-ink-2 hover:bg-surface-2 transition-colors">
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* What was actually on it. This is the half he asked for by
                    name: the goods, with quantity and price, without opening
                    anything. Clicking one opens the invoice it sits on. */}
                {items.length > 0 && (
                  <div className="mt-2 pl-2 border-l-2 border-line-2 space-y-0.5">
                    {items.map((it, n) => (
                      <button
                        key={n}
                        onClick={() => openInvoice(invoice.id)}
                        title="Open this invoice"
                        className="w-full flex items-baseline justify-between gap-3 text-left hover:bg-surface-2 rounded px-1 -mx-1 py-0.5 transition-colors"
                      >
                        <span className="text-[12px] text-ink-2 truncate">
                          {it.description || "(no description)"}
                        </span>
                        <span className="text-[11.5px] text-muted tabular-nums flex-shrink-0">
                          {describeItem(it)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── The party link ──────────────────────────────────────────────────────────
 * Dual-role parties are LINKED, not merged (v0.16.1, `linked_party_id` on both
 * `clients` and `suppliers`). The two sides render as SEPARATE sections and
 * nothing appears twice. Money paid to them is cost and money from them is
 * revenue; the two are never netted. The one combined figure below is labelled
 * POSITION and says on its face that it is not profit. */
export function PartyLinkPanel({
  role, selfName, link, linked, linkedPayments, theirDeals, theirSide, ourSide, position,
  onOpenPicker, onUnlink, onUntagLinked, busy,
}: {
  role: PartyRole;
  selfName: string;
  link: PartyLink | null;
  /** The record on the other side of the link, when it has loaded — a supplier on a
   *  client profile, a client on a supplier profile. */
  linked: Supplier | Client | null;
  linkedPayments: CounterpartyPaymentRow[];
  /** Deals where the linked party supplied the goods. */
  theirDeals: { flow: DealFlow; amount: number; paid: number }[];
  theirSide: { revenue: number; open: number; invoices: number };
  ourSide: { cost: number; deals: number; last: string | null };
  position: number;
  onOpenPicker: () => void;
  onUnlink: () => void;
  /** Remove a counterparty tag from one of the supplier side's payments. The
   *  payment itself stays exactly as it is — the tag says who, not what. */
  onUntagLinked: (txnId: string) => void;
  busy: boolean;
}) {
  const copy = PARTY_COPY[role];

  if (!link) {
    return (
      <div className="bg-surface border border-line rounded-2xl px-6 py-4 mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <SubHeading icon={<Link2 size={15} className="text-muted" />}>{copy.linkOffer}</SubHeading>
          <p className="text-[12px] text-muted mt-1 leading-relaxed">
            Link the two records and both sides show here, kept apart. Nothing is merged and no figure is
            netted — what they pay us stays revenue, what we pay them stays cost.
          </p>
        </div>
        <button
          onClick={onOpenPicker}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          <Link2 size={13} /> Link a {copy.other}
        </button>
      </div>
    );
  }

  /* The linked record's own detail — its deals and its tagged payments. It belongs under
   * whichever heading describes the LINKED record, and that flips with the role: on a
   * client profile the linked party is a supplier, so the detail is money we paid out and
   * sits in the cost block; on a supplier profile the linked party is a client, so the
   * same detail is money that came in and belongs in the revenue block. Rendered
   * unconditionally in the cost block it printed a client's incoming payments directly
   * under "Money to them. This is cost." */
  const linkedDetailIsCost = role === "client";
  const linkedDetail = (
    <>
      {theirDeals.length > 0 && (
        <div className="mt-3 border border-line rounded-lg divide-y divide-line-2 overflow-hidden max-h-[280px] overflow-y-auto">
          {theirDeals.map(({ flow, amount, paid }) => (
            <div key={flow.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[12.5px] text-ink truncate">
                  {flow.invoice_number ? `#${flow.invoice_number}` : "Deal"}
                  <span className="text-muted"> · {STAGE_LABEL[flow.stage] || flow.stage}</span>
                </div>
                <div className="text-[11px] text-muted">
                  {flow.client_name || "—"}{paid < amount - 0.01 ? ` · ${fmtAmount(amount - paid)} still to pay them` : " · paid"}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[12.5px] font-semibold text-ink tabular-nums">{fmtAmount(amount)}</span>
                {flow.invoice_number && (
                  <button onClick={() => openDeal(flow.invoice_number as string)} title="Open this deal"
                    aria-label="Open this deal"
                    className="w-5 h-5 inline-flex items-center justify-center rounded text-faint hover:text-ink-2 hover:bg-surface-2 transition-colors">
                    <ArrowRight size={11} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {linkedPayments.length > 0 && (
        <div className="mt-4">
          <PersonPayments
            person={{ type: copy.other, id: link.linked_id, name: link.linked_name }}
            payments={linkedPayments}
            onUntag={onUntagLinked}
          />
        </div>
      )}
    </>
  );

  return (
    <div className="bg-surface border border-line rounded-2xl p-6 mb-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <SubHeading icon={<Link2 size={15} className="text-muted" />}>
            {selfName} is also a {copy.other}: <span className="text-accent-hover ml-1">{link.linked_name}</span>
          </SubHeading>
          <p className="text-[12px] text-muted mt-1 leading-relaxed">
            Two records, linked, never merged. The two sides below stand on their own and no row appears in both.
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Honest label: this opens the supplier LIST. Landing on the supplier's
              own profile needs a handoff SuppliersView reads, and that file
              belongs to another session — see the report. */}
          <button onClick={() => openPartyList(copy.other)} title={`Opens the ${copy.other} list`}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 transition-colors">
            {copy.other === "supplier" ? "Suppliers" : "Clients"} <ArrowRight size={12} />
          </button>
          <button onClick={onOpenPicker} disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 disabled:opacity-50 transition-colors">
            Change
          </button>
          <button onClick={onUnlink} disabled={busy} title="Remove the link — neither record is changed otherwise"
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line text-faint hover:text-ink-2 hover:border-line-3 disabled:opacity-50 transition-colors">
            <Unlink size={13} />
          </button>
        </div>
      </div>

      {/* Their side — revenue. */}
      <div className="mt-5">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <Banknote size={14} className="text-muted" /> {copy.theirSide}
        </div>
        <p className="text-[11px] text-faint mt-0.5">Money from them. This is revenue.</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
          <StatTile label="Paid us" value={fmtAmount(theirSide.revenue)} tone="success" />
          <StatTile label="Still open" value={fmtAmount(theirSide.open)} tone={theirSide.open > 0 ? "warning" : "muted"} />
          <StatTile label="Invoices" value={String(theirSide.invoices)} tone="ink" />
        </div>
        {!linkedDetailIsCost && linkedDetail}
      </div>

      {/* Our side — cost. Never added to the block above. */}
      <div className="mt-5 pt-5 border-t border-line-2">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          <Truck size={14} className="text-muted" /> {copy.ourSide}
        </div>
        <p className="text-[11px] text-faint mt-0.5">Money to them. This is cost, and it is never subtracted from the figures above.</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
          <StatTile label="We paid them" value={fmtAmount(ourSide.cost)} tone="ink" />
          <StatTile label="Deals supplied" value={String(ourSide.deals)} tone="ink" />
          <StatTile label="Last supplied" value={ourSide.last ? whenLabel(ourSide.last) : "—"} tone="muted" />
        </div>

        {linkedDetailIsCost && linkedDetail}
      </div>

      {/* The one combined number, and what it is not. */}
      <div className="mt-5 pt-4 border-t border-line-2 flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-[12.5px] text-muted">
          Position — what they paid us less what we paid them. It is not profit and no deal reads it.
        </span>
        <span className={`text-[15px] font-bold tabular-nums ${position < 0 ? "text-danger-ink" : "text-ink"}`}>
          {fmtAmount(position)}
        </span>
      </div>
    </div>
  );
}

export default function ClientDetailView({ clientId, onBack, onEdit, onDeleted }: Props) {
  const role: PartyRole = "client";
  const [client, setClient] = useState<Client | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showSendDetails, setShowSendDetails] = useState(false);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [tier, setTier] = useState<BuyerTier | null>(null);
  const [portalLink, setPortalLink] = useState<PortalLink | null>(null);
  const [credit, setCredit] = useState<{ credit_limit: number; exposure: number; available: number; over: boolean } | null>(null);
  const [creditEdit, setCreditEdit] = useState("");
  // This client's deal flows, deduped by invoice. Previously fetched, summed into
  // one tile and thrown away — the screen held the live pipeline and never showed it.
  const [flows, setFlows] = useState<DealFlow[]>([]);
  // Refunded per deal, counted exactly ONCE (`refund_status_all` applies the
  // refunds-UNION-refund_out rule). Profit on this screen is net_profit minus
  // this, uncapped — a deal can legitimately go negative.
  const [refundByDeal, setRefundByDeal] = useState<Record<string, number>>({});
  // Bank payments this client touches: tagged rows + buyer_payment allocations.
  const [payments, setPayments] = useState<CounterpartyPaymentRow[]>([]);
  // Both sides of the address book, for re-filing a payment under the party it
  // actually belongs to (R-175) and for picking the linked party. Loaded once.
  const [people, setPeople] = useState<PersonRef[]>([]);

  // ── The party link (R-175) ───────────────────────────────────────────────
  // `linked_party_id` shipped in v0.16.1 with no readers and no writers, and the
  // two Tauri commands that read and write it live in commands.rs, which this
  // session does not own (see the handoff in the report). So the surface is
  // capability-detected: if `get_party_link` is not there yet the whole panel
  // stays hidden rather than offering a control that cannot work. The moment the
  // Rust half lands, this lights up with no further change here.
  const [linkSupported, setLinkSupported] = useState(false);
  const [link, setLink] = useState<PartyLink | null>(null);
  const [linkedSupplier, setLinkedSupplier] = useState<Supplier | null>(null);
  const [linkedPayments, setLinkedPayments] = useState<CounterpartyPaymentRow[]>([]);
  const [linkPicker, setLinkPicker] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);

  useEffect(() => {
    api.getClientCreditStatus(clientId)
      .then((c) => { setCredit(c); setCreditEdit(c.credit_limit > 0 ? String(c.credit_limit) : ""); })
      .catch(() => setCredit(null));
  }, [clientId]);

  const load = async () => {
    const c = await api.getClient(clientId);
    if (!c) { onBack(); return; }
    setClient(c);
    setInteractions(await api.listInteractions(clientId));
    setInvoices(await api.listInvoicesForClient(clientId));
    api.getBuyerTier(clientId).then(setTier).catch(() => {});
    api.listDealFlows()
      .then((all) => setFlows(dedupeByInvoice(all.filter((f) => f.client_id === clientId))))
      .catch(() => setFlows([]));
    api.refundStatusAll()
      .then((rows) => {
        const m: Record<string, number> = {};
        for (const r of rows) m[r.deal_flow_id] = r.refunded || 0;
        setRefundByDeal(m);
      })
      .catch(() => setRefundByDeal({}));
    api.listPortalLinks(clientId).then((links) => {
      const active = links.find((l) => l.is_active && new Date(l.expires_at) > new Date());
      if (active) setPortalLink(active);
    }).catch(() => {});
    api.counterpartyPayments("client", clientId, c.name).then(setPayments).catch(() => setPayments([]));
  };

  const loadLink = async () => {
    try {
      const l = await api.getPartyLink("client", clientId);
      setLinkSupported(true);
      setLink(l);
      if (l) {
        api.getSupplier(l.linked_id).then(setLinkedSupplier).catch(() => setLinkedSupplier(null));
        api.counterpartyPayments("supplier", l.linked_id, l.linked_name)
          .then(setLinkedPayments).catch(() => setLinkedPayments([]));
      } else {
        setLinkedSupplier(null);
        setLinkedPayments([]);
      }
    } catch (e) {
      // The command is not in this build yet — offer nothing rather than a dead control.
      // The degrade stays graceful, but the rejection is NAMED: a bare `catch {}` here
      // hid a wrong command name through eleven published tags, because a panel that
      // never appears looks exactly like a panel nobody linked anything on.
      console.warn("[party link] linked_party_payments rejected — the panel stays hidden:", e);
      setLinkSupported(false);
    }
  };

  // Remove a wrong client tag — the payment itself stays booked. Re-fetch so a
  // tag-only row disappears and a deal-linked row merely loses its badge.
  const reloadPayments = async () => {
    setPayments(await api.counterpartyPayments("client", clientId, client?.name || "").catch(() => []));
  };

  const untagPayment = async (txnId: string) => {
    try {
      await api.untagBankTxnCounterparty(txnId);
      const rows = await api.counterpartyPayments("client", clientId, client?.name || "");
      setPayments(rows);
    } catch {}
  };

  // Same as untagPayment, on the linked party's side of the screen.
  const untagLinkedPayment = async (txnId: string) => {
    if (!link) return;
    try {
      await api.untagBankTxnCounterparty(txnId);
      setLinkedPayments(await api.counterpartyPayments("supplier", link.linked_id, link.linked_name));
    } catch {}
  };

  useEffect(() => { load(); loadLink(); }, [clientId]);
  useEffect(() => {
    Promise.all([api.listClients(), api.listSuppliers()])
      .then(([cs, ss]) => setPeople([
        ...cs.map((c): PersonRef => ({ type: "client", id: c.id, name: c.name })),
        ...ss.filter((x) => !x.archived).map((x): PersonRef => ({ type: "supplier", id: x.id, name: x.name })),
      ]))
      .catch(() => {});
  }, []);
  useEffect(() => { api.listCustomFields().then(setCustomFields).catch(() => {}); }, []);

  const handleSummarize = async () => {
    setSummarizing(true);
    setShowSummary(true);
    try {
      const s = await api.aiSummarizeHistory(clientId);
      setSummary(s);
    } catch (e: any) { toast(`AI error: ${e}`, "error"); }
    finally { setSummarizing(false); }
  };

  const setLinkedParty = async (p: PersonRef) => {
    setLinkBusy(true);
    try {
      await api.setPartyLink("client", clientId, p.id);
      setLinkPicker(false);
      toast(`Linked to ${p.name}`);
      await loadLink();
    } catch (e: any) {
      toast(String(e), "error");
    } finally { setLinkBusy(false); }
  };

  const clearLinkedParty = async () => {
    setLinkBusy(true);
    try {
      await api.setPartyLink("client", clientId, null);
      await loadLink();
    } catch (e: any) {
      toast(String(e), "error");
    } finally { setLinkBusy(false); }
  };

  // Create the missing supplier record and link it in one step. PersonPicker can
  // now offer this; before R-153 it could only filter what already existed, so a
  // company we buy from that had never been entered as a supplier was a dead end.
  const createAndLink = async (name: string) => {
    setLinkBusy(true);
    try {
      const id = await api.createSupplier({ name });
      await api.setPartyLink("client", clientId, id);
      setLinkPicker(false);
      toast(`Created ${name} and linked them`);
      setPeople((ps) => [...ps, { type: "supplier", id, name }]);
      await loadLink();
    } catch (e: any) {
      toast(String(e), "error");
    } finally { setLinkBusy(false); }
  };

  if (!client)
    return (
      <div className="text-muted">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink mb-5">
          <ArrowLeft size={14} /> Back
        </button>
        Loading...
      </div>
    );

  // Fell-through (voided) invoices are excluded from the money tiles — a voided
  // sent invoice isn't really outstanding, and a voided paid one isn't revenue.
  const live = invoices.filter((i) => !i.voided);
  const today = localDay();
  const unpaid = live.filter((i) => i.status === "sent" || i.status === "overdue");
  const overdueInvs = unpaid.filter((i) => i.status === "overdue" || i.due_date.slice(0, 10) < today);
  const overdueTotal = overdueInvs.reduce((s, i) => s + i.total, 0);
  const outstanding = unpaid.reduce((s, i) => s + i.total, 0);
  const notYetDue = outstanding - overdueTotal;
  const paid = live.filter((i) => i.status === "paid").reduce((s, i) => s + i.total, 0);
  // total_revenue is the authoritative refund-netted figure from the backend.
  const revenue = client.total_revenue ?? paid;
  const sentCount = live.filter((i) => ["sent", "overdue", "paid"].includes(i.status)).length;

  // Profit = completed deals' net profit less every refund on those deals, in
  // full and uncapped. `net_profit` alone is deliberately PRE-refund, so reading
  // it raw overstates a refunded client — and capping the subtraction at the
  // deal's profit is the rule Jack revoked on 2026-08-19. `buyer_tiers.total_profit`
  // used to cap and no longer does, on either surface, so this figure and the client
  // list now agree; do not reintroduce a cap in either place. Six deals legitimately
  // report a loss.
  const completed = flows.filter((f) => f.stage === "complete");
  const dealProfit = (f: DealFlow) => (f.net_profit || 0) - (refundByDeal[f.id] || 0);
  const clientProfit = completed.reduce((s, f) => s + dealProfit(f), 0);
  const refundedTotal = completed.reduce((s, f) => s + (refundByDeal[f.id] || 0), 0);
  const openDeals = flows.filter((f) => f.stage !== "complete");

  // R-235 — the three sections, bucketed off `invoices` rather than `flows`,
  // because `list_deal_flows` filters voided invoices out by construction and a
  // fell-through deal would therefore be unreachable here. Measured on the live
  // DB 2026-09-03: the three buckets cover every non-archived invoice, with none
  // left over. Where an invoice is both voided and complete (one live row today)
  // fell-through wins — voiding is the later, deliberate act.
  const dealRows = (() => {
    const flowFor = new Map<string, DealFlow>();
    for (const f of flows) if (f.invoice_id) flowFor.set(f.invoice_id, f);
    const completed: DealRow[] = [], fellThrough: DealRow[] = [], current: DealRow[] = [];
    for (const invoice of invoices) {
      const flow = flowFor.get(invoice.id);
      const row: DealRow = {
        invoice,
        flow,
        items: parseLineItems(invoice.line_items_json),
        refunded: flow ? (refundByDeal[flow.id] || 0) : 0,
      };
      if (invoice.voided) fellThrough.push(row);
      else if (flow?.stage === "complete" || invoice.is_complete) completed.push(row);
      else current.push(row);
    }
    return { completed, fellThrough, current };
  })();

  const meta = client.metadata || {};
  // Sales rep — must be shown. No rep set reads "Unassigned"; it used to fall
  // back to the CLIENT'S OWN company name, which put the buyer's company beside
  // a person icon labelled "Rep:" and read as a fact (R-153 finding 6).
  const rep = (meta.lead_representative || meta.sales_rep || "").toString().trim();
  const repDisplay = rep || "Unassigned";
  const initials = (client.name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  const address = [
    client.street_address || meta.street_address,
    [client.city || meta.city, client.state || meta.state, client.zip_code || meta.zip_code].filter(Boolean).join(" "),
  ].map((v) => (v || "").toString().trim()).filter(Boolean).join(", ");

  const lastActivityRaw = client.last_contact_at || interactions[0]?.created_at || null;
  const followUp = ((client.next_follow_up_date || meta.next_follow_up_date || "") as string).slice(0, 10);

  const tierLabel = tier ? (tier.tier === "P" ? "Platinum" : tier.tier === "S" ? "Diamond" : tier.tier === "A" ? "Gold" : tier.tier === "B" ? "Silver" : tier.tier === "C" ? "Bronze" : "Prospect") : null;
  const tierChipCls = tier ? (
    tier.tier === "P" ? "bg-[#8B5CF6]/12 text-[#8B5CF6]" :
    tier.tier === "S" ? "bg-accent/10 text-accent-hover" :
    tier.tier === "A" ? "bg-success-bg text-success-ink" :
    tier.tier === "B" ? "bg-warning-bg text-warning-ink" : "bg-surface-3 text-muted"
  ) : "";

  // Merge-on-write: `update_client` writes lead_status unconditionally and
  // defaults it to "prospect" when the caller omits it, so this call has to send
  // the stored value back or saving a follow-up date silently demotes the client.
  const saveFollowUp = async (day: string) => {
    await api.updateClient(client.id, {
      name: client.name, email: client.email, phone: client.phone,
      company: client.company, notes: client.notes,
      lead_status: client.lead_status,
      metadata: { ...(client.metadata || {}), next_follow_up_date: day },
      next_follow_up_date: day,
    });
    load();
  };

  // ── What is waiting, most urgent first ───────────────────────────────────
  const actions: NextAction[] = [];
  if (overdueInvs.length > 0) {
    const oldest = [...overdueInvs].sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    const days = Math.abs(daysFromToday(oldest.due_date));
    actions.push({
      tone: "danger",
      text: `${fmtAmount(overdueTotal)} overdue across ${overdueInvs.length} invoice${overdueInvs.length === 1 ? "" : "s"} — oldest ${days} day${days === 1 ? "" : "s"} past due`,
      go: oldest.number ? { label: "Open the deal", onClick: () => openDeal(oldest.number) } : undefined,
    });
  }
  if (followUp) {
    const d = daysFromToday(followUp);
    if (d < 0) actions.push({ tone: "danger", text: `Follow-up was due ${Math.abs(d)} day${d === -1 ? "" : "s"} ago` });
    else if (d === 0) actions.push({ tone: "warning", text: "Follow up today" });
    else actions.push({ tone: "muted", text: `Follow up in ${d} day${d === 1 ? "" : "s"}` });
  }
  if (openDeals.length > 0) {
    const byStage = openDeals[0];
    actions.push({
      tone: "warning",
      text: `${openDeals.length} deal${openDeals.length === 1 ? "" : "s"} in progress — ${WAITING_ON[byStage.stage] || STAGE_LABEL[byStage.stage] || byStage.stage}`,
      go: byStage.invoice_number ? { label: "Open the deal", onClick: () => openDeal(byStage.invoice_number as string) } : undefined,
    });
  }
  if (notYetDue > 0.01) {
    actions.push({ tone: "muted", text: `${fmtAmount(notYetDue)} invoiced and not yet due` });
  }
  if (client.first_contact) {
    actions.push({ tone: "muted", text: "Never emailed" });
  }
  // Urgent first, so the band's headline is genuinely the headline.
  const TONE_RANK = { danger: 0, warning: 1, muted: 2 } as const;
  actions.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);

  // ── One stream ───────────────────────────────────────────────────────────
  const stream: StreamItem[] = [];
  for (const it of interactions) {
    const isEmail = it.kind === "email_in" || it.kind === "email_out";
    stream.push({
      key: `i:${it.id}`,
      at: it.created_at,
      group: isEmail ? "email" : "contact",
      chip: it.kind.replace("_", " "),
      chipCls: kindColor(it.kind),
      title: it.subject,
      body: it.body,
      author: it.user_name || null,
    });
  }
  for (const inv of invoices) {
    stream.push({
      key: `v:${inv.id}`,
      at: inv.issue_date,
      group: "invoice",
      chip: inv.voided ? "invoice · voided" : "invoice",
      chipCls: invoiceStatusColor(inv.voided ? "" : inv.status),
      title: `Invoice ${inv.number}`,
      meta: `Due ${inv.due_date.slice(0, 10)} · ${inv.status}`,
      amount: inv.total,
      amountTone: "ink",
      go: inv.number ? { label: "Open the deal", onClick: () => openDeal(inv.number) } : undefined,
    });
  }
  for (const f of flows) {
    const supplier = primarySupplierLabel(f.supplier_payments);
    if (f.stage === "complete" && f.completed_at) {
      const p = dealProfit(f);
      stream.push({
        key: `dc:${f.id}`,
        at: f.completed_at,
        group: "deal",
        chip: "deal completed",
        chipCls: "bg-success-bg text-success-ink border border-success",
        title: f.invoice_number ? `Deal ${f.invoice_number} closed` : "Deal closed",
        meta: [
          supplier ? `Supplier ${supplier}` : null,
          `Profit ${fmtAmount(p)}`,
          (refundByDeal[f.id] || 0) > 0 ? `after ${fmtAmount(refundByDeal[f.id])} refunded` : null,
        ].filter(Boolean).join(" · "),
        amount: f.invoice_total,
        amountTone: "ink",
        go: f.invoice_number ? { label: "Open the deal", onClick: () => openDeal(f.invoice_number as string) } : undefined,
      });
    } else {
      stream.push({
        key: `do:${f.id}`,
        at: f.updated_at || f.created_at,
        group: "deal",
        chip: `deal · ${STAGE_LABEL[f.stage] || f.stage}`,
        chipCls: "bg-accent/10 text-accent-hover border border-accent/20",
        title: f.invoice_number ? `Deal ${f.invoice_number}` : "Deal",
        meta: [supplier ? `Supplier ${supplier}` : null, WAITING_ON[f.stage]].filter(Boolean).join(" · "),
        amount: f.invoice_total,
        amountTone: "ink",
        go: f.invoice_number ? { label: "Open the deal", onClick: () => openDeal(f.invoice_number as string) } : undefined,
      });
    }
  }
  for (const p of payments) {
    stream.push({
      key: `p:${p.txn_id}`,
      at: p.posted_at,
      group: "payment",
      chip: p.direction === "in" ? "payment in" : "payment out",
      chipCls: p.direction === "in" ? "bg-success-bg text-success-ink border border-success" : "bg-warning-bg text-warning-ink border border-warning",
      title: p.description || p.counterparty_name || "Bank transaction",
      meta: [p.invoice_number ? `#${p.invoice_number}` : null, p.tagged ? "tagged to them" : null].filter(Boolean).join(" · "),
      amount: p.amount,
      amountTone: p.direction === "in" ? "success" : "danger",
    });
  }
  stream.sort((a, b) => atMs(b.at) - atMs(a.at));

  // ── The linked side, kept separate ───────────────────────────────────────
  // Deals the linked supplier supplied. Their cost legs only — this never touches
  // the revenue figures above and the two are never added together.
  const linkedId = link?.linked_id || "";
  const theirDeals = linkedId
    ? flows
        .map((flow) => {
          const legs = (flow.supplier_payments || []).filter((sp) => sp.supplier_id === linkedId && !sp.kept);
          const amount = legs.reduce((s, sp) => s + (sp.amount || 0), 0);
          const paidLegs = legs.filter((sp) => sp.paid).reduce((s, sp) => s + (sp.amount || 0), 0);
          return { flow, amount, paid: paidLegs, n: legs.length };
        })
        .filter((d) => d.n > 0)
        .sort((a, b) => atMs(b.flow.created_at) - atMs(a.flow.created_at))
    : [];
  // Nothing may appear twice: a transaction already listed on the client side is
  // not repeated under the supplier side.
  const clientTxnIds = new Set(payments.map((p) => p.txn_id));
  const linkedPaymentsShown = linkedPayments.filter((p) => !clientTxnIds.has(p.txn_id));
  const costToThem = linkedSupplier ? linkedSupplier.total_paid : theirDeals.reduce((s, d) => s + d.paid, 0);

  return (
    <div>
      {confirmDelete && (
        <DeleteClientModal
          name={client.name}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteClient(client.id);
            setConfirmDelete(false);
            if (onDeleted) onDeleted(); else onBack();
          }}
        />
      )}
      {showSendDetails && (
        <SendOurDetailsModal
          clientName={client.name}
          clientEmail={client.email}
          onClose={() => setShowSendDetails(false)}
        />
      )}
      {linkPicker && (
        <PersonPickerModal
          title={`Which supplier is ${client.name}?`}
          subtitle="Links the two records. Nothing is merged, no money moves, and what we pay them stays cost."
          only="supplier"
          people={people}
          candidates={[]}
          current={link ? { type: "supplier", id: link.linked_id, name: link.linked_name } : null}
          busy={linkBusy}
          onClose={() => setLinkPicker(false)}
          onPick={setLinkedParty}
          onCreate={createAndLink}
          createLabel="Add a new supplier"
        />
      )}

      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink mb-5 transition-colors"
      >
        <ArrowLeft size={14} /> Back to Clients
      </button>

      {/* ── Identity, money, next action ─────────────────── */}
      <div className="bg-surface border border-line rounded-2xl p-6 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-14 h-14 rounded-2xl bg-accent/10 text-accent-hover flex items-center justify-center text-[18px] font-bold flex-shrink-0">{initials}</div>
            <div className="min-w-0">
              <h2 className="text-[20px] font-bold text-ink truncate">{client.name}</h2>
              <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[13px] text-muted">
                {client.company && <span className="inline-flex items-center gap-1.5"><Building2 size={14} /> {client.company}</span>}
                <span className="inline-flex items-center gap-1.5" title="Sales rep"><User size={14} /> Rep: <span className={`font-medium ${rep ? "text-ink-2" : "text-faint"}`}>{repDisplay}</span></span>
              </div>
              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${leadStatusColor(client.lead_status)}`}>
                  {client.lead_status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
                {tierLabel && <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${tierChipCls}`}>{tierLabel}</span>}
                {tier && tier.avg_commission_pct > 0 && (
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${
                    tier.avg_commission_pct >= 25 ? "bg-success-bg text-success-ink" : tier.avg_commission_pct >= 10 ? "bg-warning-bg text-warning-ink" : "bg-danger-bg text-danger-ink"
                  }`}>{tier.avg_commission_pct.toFixed(1)}% margin</span>
                )}
                {tier && <ReliabilityBadge reliability={tier.reliability} pct={tier.reliability_pct} quotesSent={tier.quotes_sent} quotesWon={tier.quotes_won} size="md" />}
              </div>
            </div>
          </div>

          {/* Flag switches — clear on/off */}
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            {/* Edit / Delete — restored after the profile redesign. Delete is a
                deliberate two-step (type-the-name) confirm to prevent data loss. */}
            <div className="flex items-center gap-1.5 mb-0.5">
              <button
                onClick={() => setShowSendDetails(true)}
                title="Email this contact your company + payment details so they can invoice or pay you."
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 transition-colors"
              >
                <Send size={13} /> Send our details
              </button>
              <button
                onClick={() => openStatement(client.id)}
                title="Build a receipt covering their deals — every payment with its date — to download or email."
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 transition-colors"
              >
                <Receipt size={13} /> Receipt
              </button>
              <button
                onClick={() => onEdit?.(client)}
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 transition-colors"
              >
                <Pencil size={13} /> Edit
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete client"
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-line text-faint hover:text-danger-ink hover:border-danger hover:bg-danger-bg transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <FlagSwitch label="High-value" tone="accent"
              on={!!(client.high_value || client.metadata?.high_value)}
              title="A positive label for your best buyers. Purely a tag — it does not change who receives newsletters."
              onToggle={async () => {
                const val = await api.toggleClientHighValue(client.id);
                setClient((c) => c ? { ...c, high_value: val, metadata: { ...(c.metadata || {}), high_value: val } } : c);
              }} />
            <FlagSwitch label="No bulk email" tone="neutral"
              on={!!(client.exclusive || client.metadata?.exclusive)}
              title="Keeps this client off mass newsletters and auto-add — for people you don't want to bulk-email."
              onToggle={async () => {
                try {
                  const val = await api.toggleClientExclusive(client.id);
                  setClient((c) => c ? { ...c, exclusive: val, metadata: { ...(c.metadata || {}), exclusive: val } } : c);
                } catch (e: any) {
                  // Opted-out client: turning No-bulk off alone won't resume their emails.
                  // Offer a deliberate resubscribe that also clears their opt-out.
                  if (String(e).includes("UNSUBSCRIBED_CONFIRM")) {
                    const when = client.metadata?.unsubscribed_at ? " on " + new Date(client.metadata.unsubscribed_at).toLocaleDateString() : "";
                    if (confirm(`This client unsubscribed themselves${when}. Turning off "No bulk email" won't resume their emails unless you also resubscribe them.\n\nResubscribe ${client.name || "this client"} and resume emails?`)) {
                      await api.resubscribeClient(client.id);
                      setClient((c) => c ? { ...c, exclusive: false, metadata: { ...(c.metadata || {}), exclusive: false, unsubscribed: false } } : c);
                    }
                  } else {
                    throw e;
                  }
                }
              }} />
            <FlagSwitch label="Blacklisted" tone="danger"
              on={!!client.is_blacklisted}
              title="Blacklisted clients are excluded from all sends."
              onToggle={async () => {
                const val = await api.toggleClientBlacklist(client.id);
                setClient((c) => c ? { ...c, is_blacklisted: val } : c);
              }} />
            {client.metadata?.unsubscribed && (
              <span className="inline-flex items-center text-[10px] font-semibold text-ink-2 bg-surface-3 border border-line px-2 py-1 rounded-lg"
                title={`Unsubscribed via an email link${client.metadata?.unsubscribed_at ? " on " + new Date(client.metadata.unsubscribed_at).toLocaleDateString() : ""} — kept off all sends`}>
                Unsubscribed
              </span>
            )}
          </div>
        </div>

        {/* Money first. Profit leads — it is the figure Jack has said repeatedly
            is the one that matters. */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mt-5">
          <StatTile
            label="Profit"
            value={flows.length === 0 ? "—" : fmtAmount(clientProfit)}
            tone={clientProfit < 0 ? "danger" : "success"}
            hint={refundedTotal > 0 ? `after ${fmtAmount(refundedTotal)} refunded` : `${completed.length} completed deal${completed.length === 1 ? "" : "s"}`}
          />
          <StatTile label="Revenue" value={fmtAmount(revenue)} tone="ink" hint="paid invoices, net of refunds" />
          <StatTile
            label="Overdue"
            value={fmtAmount(overdueTotal)}
            tone={overdueTotal > 0 ? "danger" : "muted"}
            hint={notYetDue > 0.01 ? `${fmtAmount(notYetDue)} more not yet due` : undefined}
          />
          <StatTile
            label="Open deals"
            value={String(openDeals.length)}
            tone={openDeals.length > 0 ? "warning" : "muted"}
            hint={`${sentCount} invoice${sentCount === 1 ? "" : "s"} sent · last activity ${relTime(lastActivityRaw)}`}
          />
        </div>

        <NextActionBand actions={actions} followUp={followUp} onFollowUp={saveFollowUp} />

        {/* Contact line — address included, which Jack named as must-be-glanceable. */}
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-4 pt-4 border-t border-line-2">
          {client.email ? (
            <div className="flex items-center gap-1.5">
              <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 text-[13px] text-accent hover:text-accent-hover"><Mail size={14} /> {client.email}</a>
              <CopyEmail email={client.email} />
            </div>
          ) : (
            <span className="flex items-center gap-1.5 text-[13px] text-faint"><Mail size={14} /> No email</span>
          )}
          {client.phone
            ? <span className="flex items-center gap-1.5 text-[13px] text-ink-2"><Phone size={14} /> {fmtPhone(client.phone)}</span>
            : <span className="flex items-center gap-1.5 text-[13px] text-faint"><Phone size={14} /> No phone</span>}
          {address
            ? <span className="flex items-center gap-1.5 text-[13px] text-ink-2"><MapPin size={14} /> {address}</span>
            : <span className="flex items-center gap-1.5 text-[13px] text-faint"><MapPin size={14} /> No address</span>}
        </div>
      </div>

      {/* ── The three deal sections (R-235) ──────────────── */}
      {/* His order, his words: completed, fell through, current. Current opens
          by default because it is the only one that needs an action today. */}
      <DealSection
        title="Current deals"
        icon={<ShoppingCart size={15} className="text-muted" />}
        rows={dealRows.current}
        tone="accent"
        empty="Nothing live with them right now."
        defaultOpen
        showStage
      />
      <DealSection
        title="Deals completed"
        icon={<CheckCircle2 size={15} className="text-muted" />}
        rows={dealRows.completed}
        tone="success"
        empty="They have not closed a deal yet."
        defaultOpen
        showStage={false}
      />
      <DealSection
        title="Deals fell through"
        icon={<XCircle size={15} className="text-muted" />}
        rows={dealRows.fellThrough}
        tone="danger"
        empty="Nothing has fallen through with them."
        defaultOpen={false}
        showStage={false}
      />

      {/* ── The party link ───────────────────────────────── */}
      {linkSupported && (
        <PartyLinkPanel
          role={role}
          selfName={client.name}
          link={link}
          linked={linkedSupplier}
          linkedPayments={linkedPaymentsShown}
          theirDeals={theirDeals}
          theirSide={{ revenue, open: outstanding, invoices: sentCount }}
          ourSide={{ cost: costToThem, deals: theirDeals.length, last: linkedSupplier?.last_deal_date || null }}
          position={revenue - costToThem}
          onOpenPicker={() => setLinkPicker(true)}
          onUnlink={clearLinkedParty}
          onUntagLinked={untagLinkedPayment}
          busy={linkBusy}
        />
      )}

      {/* ── Activity ─────────────────────────────────────── */}
      {/* R-235, Jack 2026-09-03: "bank payments and activity take up too much
          screen and dont really give me a good break down." The three deal
          sections above are the breakdown; this is demoted to a disclosure
          rather than deleted, because it is the only home on this screen for
          calls, notes and email — nothing else carries them. */}
      <Disclosure title="Activity — notes, calls and email" icon={<MessageSquare size={14} className="text-muted" />}>
        {showNoteForm && (
          <div className="bg-surface border border-line rounded-2xl mb-3 overflow-hidden">
            <NoteForm clientId={clientId} onClose={() => { setShowNoteForm(false); load(); }} />
          </div>
        )}
        {showSummary && (
          <div className="bg-surface-2 border border-line rounded-2xl px-6 py-4 mb-3">
            <div className="flex items-center justify-between gap-3">
              <SubHeading icon={<Sparkles size={15} className="text-muted" />}>Summary of the history</SubHeading>
              <button onClick={() => setShowSummary(false)} className="text-muted hover:text-ink transition-colors" aria-label="Close the summary"><X size={15} /></button>
            </div>
            {summarizing
              ? <p className="text-[13px] text-muted mt-2 flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Reading everything on file…</p>
              : <div className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed mt-2">{summary || "Nothing came back."}</div>}
          </div>
        )}
        <ActivityStream
          items={stream}
          header={
            <div className="flex items-center gap-2">
              <button
                onClick={handleSummarize}
                disabled={summarizing || interactions.length === 0}
                title={interactions.length === 0 ? "There is nothing on file to summarise yet" : "Summarise the history with AI"}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-line text-ink-2 text-[12px] font-medium hover:bg-surface-2 hover:border-line-3 disabled:opacity-40 transition-colors"
              >
                <Sparkles size={13} /> {summary ? "Re-summarise" : "Summarise"}
              </button>
              <button
                onClick={() => setShowNoteForm(true)}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-medium transition-colors"
              >
                <Plus size={13} /> Add a note
              </button>
            </div>
          }
        />
      </Disclosure>

      {/* ── Bank payments ────────────────────────────────── */}
      {/* Was open by default because it shipped in v0.15.141 and Jack did not
          know it existed. Now collapsed (R-235): the deal sections carry the
          money story, and this was one of the two blocks eating the screen. */}
      <Disclosure title="Bank payments" icon={<Banknote size={14} className="text-muted" />}>
        {/* THREE groups, never merged (R-156 W1-d, R-157/F2): booked to a deal of
            their own, which that deal already counts; booked to somebody else's
            deal, which counts on that deal and not here at all; and tagged to them
            only, which no deal counts. The middle group is why the split is three
            and not two — an allocation says the money is booked, never that it is
            booked to them. */}
        <PersonPayments
          person={{ type: "client", id: clientId, name: client.name }}
          payments={payments}
          onUntag={untagPayment}
          people={people}
          onChanged={reloadPayments}
        />
      </Disclosure>

      {/* ── Everything else, out of the way ──────────────── */}
      <Disclosure title="Details and settings for this client" icon={<Target size={14} className="text-muted" />}>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          <MetadataCard title="Contact info" icon={<User size={14} />}>
            {client.metadata?.job_title && <MetaRow label="Title" value={client.metadata.job_title} />}
            {address && <MetaRow label="Address" value={address} />}
            {client.metadata?.country && <MetaRow label="Country" value={client.metadata.country} />}
          </MetadataCard>

          <MetadataCard title="Business info" icon={<Building2 size={14} />}>
            {client.category && <MetaRow label="Category" value={client.category} />}
            {client.metadata?.website && <MetaRow label="Website" value={client.metadata.website} />}
            {client.metadata?.tax_id && <MetaRow label="Tax ID" value={client.metadata.tax_id} />}
            {client.metadata?.primary_buy_category && <MetaRow label="Buy category" value={client.metadata.primary_buy_category} />}
            {client.metadata?.other_buy_categories && <MetaRow label="Other categories" value={client.metadata.other_buy_categories} />}
            {client.metadata?.estimated_annual_spend && <MetaRow label="Spend per frequency" value={client.metadata.estimated_annual_spend} />}
            {client.metadata?.purchase_frequency && <MetaRow label="Frequency" value={client.metadata.purchase_frequency} />}
          </MetadataCard>

          <MetadataCard title="Lead info" icon={<Target size={14} />}>
            {client.metadata?.lead_source && <MetaRow label="Source" value={client.metadata.lead_source} />}
            {client.metadata?.interest_level && <MetaRow label="Interest" value={client.metadata.interest_level} />}
            {client.metadata?.buyer_type && <MetaRow label="Buyer type" value={client.metadata.buyer_type} />}
            {client.metadata?.lead_id && <MetaRow label="Lead ID" value={client.metadata.lead_id} />}
            {client.metadata?.lead_representative && <MetaRow label="Rep" value={client.metadata.lead_representative} />}
            {client.metadata?.date_added && <MetaRow label="Added" value={client.metadata.date_added} />}
            {client.metadata?.last_contact_date && <MetaRow label="Last contact" value={client.metadata.last_contact_date} />}
          </MetadataCard>

          <CreditPanel clientId={client.id} />

          {customFields.length > 0 && (
            <MetadataCard title="Custom fields" icon={<Tag size={14} />}>
              {customFields.map(f => (
                <MetaRow key={f.id} label={f.label} value={(client.metadata as any)?.[f.field_key] ?? ""} />
              ))}
            </MetadataCard>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-line-2 grid grid-cols-1 lg:grid-cols-3 gap-3">
          <StatTile label="Outstanding" value={fmtAmount(outstanding)} tone={outstanding > 0 ? "warning" : "muted"} />
          <StatTile label="Paid" value={fmtAmount(paid)} tone="success" />
          <StatTile label="Invoices sent" value={String(sentCount)} tone="ink" />
        </div>

        {credit && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 bg-surface-2 border border-line rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted font-medium">Credit limit</span>
              <input value={creditEdit} onChange={(e) => setCreditEdit(e.target.value)}
                onBlur={async () => { const v = parseFloat(creditEdit) || 0; await api.setClientCreditLimit(client.id, v); const c = await api.getClientCreditStatus(client.id); setCredit(c); setCreditEdit(c.credit_limit > 0 ? String(c.credit_limit) : ""); }}
                placeholder="none" className="w-24 text-[13px] bg-surface border border-line rounded-lg px-2 py-1 text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
            <div className="text-[12px]"><span className="text-muted">Exposure: </span><span className="font-semibold text-ink tabular-nums">{fmtAmount(credit.exposure)}</span></div>
            {credit.credit_limit > 0 && <div className="text-[12px]"><span className="text-muted">Available: </span><span className={`font-semibold tabular-nums ${credit.over ? "text-danger-ink" : "text-success-ink"}`}>{fmtAmount(credit.available)}</span></div>}
            {credit.over && <span className="text-[10px] font-semibold text-danger-ink bg-danger-bg border border-danger-ink/20 px-2 py-0.5 rounded">Over limit</span>}
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-line-2">
          <p className="text-[12.5px] font-medium text-muted mb-2">Client portal</p>
          {portalLink ? (
            <>
              <div className="flex items-center gap-2">
                <input readOnly className="border border-line px-3 h-8 rounded-lg text-[12px] text-ink-2 bg-surface-2 flex-1 font-mono" value={portalLink.portal_url} />
                <button onClick={async () => { await navigator.clipboard.writeText(portalLink.portal_url); }} className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-8 rounded-lg text-[11px] font-medium">Copy</button>
                <button onClick={async () => { if (confirm("Revoke this portal link?")) { await api.revokePortalLink(portalLink.token); setPortalLink(null); load(); } }} className="text-[11px] text-danger-ink px-2 h-8 rounded-lg hover:bg-danger-bg">Revoke</button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input className="border border-line px-2 h-7 rounded text-[10px] w-48" placeholder="Portal base URL" value={portalLink.portal_url.split("/portal/")[0] || ""} onChange={(e) => api.savePortalBaseUrl(e.target.value).then(() => load())} />
                <span className="text-[9px] text-muted">Set your domain or IP</span>
              </div>
            </>
          ) : (
            <button onClick={async () => { const l = await api.generatePortalLink(clientId); setPortalLink(l); }} className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-8 rounded-lg text-[12px] font-medium">Generate portal link</button>
          )}
          <p className="text-[10px] text-muted mt-1.5">Share this link so {client.name} can view their invoices. Expires in 30 days.</p>
        </div>

        {client.notes && (
          <div className="mt-4 pt-4 border-t border-line-2">
            <p className="text-[12.5px] font-medium text-muted mb-1.5">Notes</p>
            <div className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{client.notes}</div>
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-line-2">
          <button onClick={openInvoices} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:text-accent-hover transition-colors">
            <FileText size={13} /> See every invoice in Invoices <ArrowRight size={12} />
          </button>
        </div>
      </Disclosure>
    </div>
  );
}

function MetadataCard({
  title, icon, children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const hasContent = Children.toArray(children).length > 0;
  if (!hasContent) return null;
  return (
    <div className="bg-surface-2 border border-line rounded-lg p-4">
      <h3 className="text-[13px] font-semibold text-ink-2 flex items-center gap-2 mb-3 pb-2 border-b border-line">
        {icon}
        {title}
      </h3>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 first:mt-0">
      {label && <span className="block text-[12.5px] font-medium text-muted">{label}</span>}
      <span className="text-[13px] text-ink">{value}</span>
    </div>
  );
}

function NoteForm({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("note");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api.addInteraction({
        client_id: clientId,
        kind,
        subject: subject || undefined,
        body,
      });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="px-4 py-3 bg-surface-2 border-b border-line">
      <div className="flex gap-2 mb-2">
        <select
          className="border border-line-3 px-2 h-8 rounded-md text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
          <option value="email_out">Email out</option>
        </select>
        <input
          placeholder="Subject (optional)"
          className="border border-line-3 px-3 h-8 rounded-md text-[13px] flex-1 focus:outline-none focus:ring-1 focus:ring-accent"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <textarea
        placeholder="Notes..."
        rows={3}
        className="border border-line-3 px-3 py-2 rounded-md text-[13px] w-full mb-2 focus:outline-none focus:ring-2 focus:ring-accent"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-[12px] text-muted hover:text-ink">Cancel</button>
        <button
          onClick={save}
          disabled={saving || !body.trim()}
          className="bg-accent hover:bg-accent-hover text-on-accent px-3 h-7 rounded-md text-[12px] font-medium disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// Deliberate two-step delete: the operator must type the client's exact name
// before the destructive action unlocks. Deletion cascades to interactions, so
// Jack wants this to always be intentional.
function DeleteClientModal({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const match = typed.trim() === name.trim();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-danger-bg text-danger-ink flex-shrink-0"><AlertTriangle size={17} /></span>
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Delete client</h2>
              <p className="text-[12px] text-muted mt-0.5">This permanently removes the client and all their interactions.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>
        <div className="px-5 pb-4">
          <p className="text-[13px] text-ink-2 mb-2">
            To confirm, type <span className="font-semibold text-ink">{name}</span> below.
          </p>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && match && !busy) { setBusy(true); Promise.resolve(onConfirm()).finally(() => setBusy(false)); } }}
            placeholder={name}
            className="w-full bg-surface-2 border border-line rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-danger/40 focus:border-danger transition-colors"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={onClose} disabled={busy}
            className="px-4 h-9 rounded-lg border border-line text-ink-2 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => { setBusy(true); Promise.resolve(onConfirm()).finally(() => setBusy(false)); }}
            disabled={!match || busy}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg bg-danger text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            <Trash2 size={14} /> {busy ? "Deleting…" : "Delete client"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(email);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[12px] text-muted hover:text-ink-2"
      title="Copy email"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// Compose the default body from the org's own company info + active payment
// methods. Every missing value is skipped so the email never shows blank lines,
// and the whole payment section drops out when there are no active methods.
// This intentionally only reflects the org's own details — never any supplier
// or cost data.
function composeDetailsBody(clientName: string, info: CompanyInfo | null, methods: PaymentMethod[]): string {
  const firstName = (clientName || "").trim().split(/\s+/)[0] || "there";
  const lines: string[] = [`Hi ${firstName},`, "", "Here are our details for invoicing or payment:", ""];

  const detailBlock = [info?.name, info?.address, info?.email, info?.phone]
    .map((v) => (v || "").toString().trim())
    .filter(Boolean);
  lines.push(...detailBlock);

  const active = methods.filter((m) => m.active);
  if (active.length > 0) {
    lines.push("", "Payment methods:");
    for (const m of active) {
      const kind = (m.kind || "").trim();
      const label = (m.label || "").trim();
      const details = (m.details || "").trim();
      const head = [kind, label].filter(Boolean).join(" — ");
      const line = details ? (head ? `${head}: ${details}` : details) : head;
      if (line) lines.push(`- ${line}`);
    }
  }

  const signOff = (info?.name || "").toString().trim();
  lines.push("", "Thanks,", signOff || "");
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n").trim() + "\n";
}

const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// Review modal for "Send our details". Pre-fills recipient / subject / body from
// the org's own company info + active payment methods, all editable. The review
// step IS the confirmation — nothing sends until the user clicks Send.
function SendOurDetailsModal({ clientName, clientEmail, onClose }: {
  clientName: string;
  clientEmail: string | null;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState(clientEmail || "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [info, methods] = await Promise.all([
        api.getCompanyInfo().catch(() => null),
        api.listPaymentMethods().catch(() => [] as PaymentMethod[]),
      ]);
      if (cancelled) return;
      const companyName = (info?.name || "").toString().trim();
      setSubject(`Our billing & payment details${companyName ? ` — ${companyName}` : ""}`);
      setBody(composeDetailsBody(clientName, info, methods));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [clientName]);

  const canSend = !loading && !sending && looksLikeEmail(recipient) && !!body.trim();

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await api.sendEmail(recipient.trim(), subject, body);
      setSent(true);
      setTimeout(onClose, 1200);
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e?.message || "Failed to send. Check your email settings."));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-accent-hover flex-shrink-0"><Send size={16} /></span>
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Send our details</h2>
              <p className="text-[12px] text-muted mt-0.5">Review before sending — nothing goes out until you click Send.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>

        <div className="px-5 pb-4 space-y-3 overflow-auto">
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1">Recipient</label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="name@example.com"
              className="w-full bg-surface-2 border border-line rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1">Subject</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full bg-surface-2 border border-line rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              placeholder={loading ? "Loading your details…" : ""}
              className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] text-ink leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y"
            />
          </div>
          {error && <p className="text-[12px] text-danger-ink">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={onClose} disabled={sending}
            className="px-4 h-9 rounded-lg border border-line text-ink-2 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-semibold hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sent ? <><Check size={14} /> Sent</> : sending ? <><RefreshCw size={14} className="animate-spin" /> Sending…</> : <><Send size={14} /> Send</>}
          </button>
        </div>
      </div>
    </div>
  );
}
