import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Landmark, Upload, Search, Check, X, Trash2, Loader2, Link2, ChevronRight, ChevronDown, Sparkles, Plus,
  Building2, RefreshCw, Plug, Wand2, ArrowDownLeft, ArrowUpRight, Pencil, ShieldCheck, AlertTriangle,
} from "lucide-react";
import {
  api, BankTxn, BankTxnReviewPatch, BankTxnSummary, BankPreview, BankAiPreview, BankAiImportResult, BankAllocation, DealFlow, PlaidItem,
  Loan, TxnRule, DedupeResult, PlaidSyncSummary,
} from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./Toast";
import FreeCashView from "./FreeCashView";
import LoansView from "./LoansView";

// Backend errors arrive as raw Rust strings and were shown to the user verbatim,
// often prefixed "Error:" by String(e). Strip the noise and never render an empty
// toast — a failure with no message reads as nothing having happened at all.
function errText(e: unknown): string {
  const raw = typeof e === "string" ? e : ((e as { message?: string })?.message ?? String(e));
  return raw.replace(/^Error:\s*/i, "").trim() || "Something went wrong. Please try again.";
}

// ── Transaction search ──────────────────────────────────────────────────────
// Exact numeric token ("500", "$1,500.00", "1500") → number; anything else null.
const numToken = (s: string): number | null =>
  /^\$?\d[\d,]*(\.\d{1,2})?$/.test(s) ? parseFloat(s.replace(/[$,]/g, "")) : null;

// Multi-term AND search: every space-separated token must match. A numeric token
// matches the amount EXACTLY (to the cent) — so "500" no longer matches 1,500.00 —
// while a word token matches the payee or memo. "walmart 500" ⇒ payee~walmart AND $500.00.
const matchesQuery = (t: BankTxn, q: string): boolean => {
  const toks = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return toks.every((tok) => {
    const n = numToken(tok);
    if (n !== null) return Math.abs(t.amount - n) < 0.005;
    return (t.description || "").toLowerCase().includes(tok) ||
           (t.counterparty_name || "").toLowerCase().includes(tok);
  });
};

// Chart of accounts (QuickBooks-style). Legacy values (receipt/payment/fee/
// owner_draw/shipping/software/internal_transfer/cash_in/cash_out) are kept so
// existing rows keep their category. Grouped for scannable <optgroup> dropdowns.
const CATEGORIES: { value: string; label: string; group: string }[] = [
  { value: "",                 label: "Uncategorized",             group: "" },
  { value: "receipt",          label: "Sale / buyer payment",      group: "Income" },
  { value: "other_income",     label: "Other income",              group: "Income" },
  { value: "payment",          label: "Supplier payment",          group: "Cost of goods" },
  { value: "merchandise",      label: "Inventory / merchandise",   group: "Cost of goods" },
  { value: "shipping",         label: "Shipping & freight",        group: "Cost of goods" },
  { value: "meals",            label: "Meals & food",              group: "Operating expenses" },
  { value: "auto",             label: "Fuel & auto",               group: "Operating expenses" },
  { value: "travel",           label: "Travel & lodging",          group: "Operating expenses" },
  { value: "office",           label: "Office & supplies",         group: "Operating expenses" },
  { value: "utilities",        label: "Utilities & phone",         group: "Operating expenses" },
  { value: "rent",             label: "Rent & warehouse",          group: "Operating expenses" },
  { value: "software",         label: "Software & subscriptions",  group: "Operating expenses" },
  { value: "advertising",      label: "Advertising & marketing",   group: "Operating expenses" },
  { value: "insurance",        label: "Insurance",                 group: "Operating expenses" },
  { value: "professional",     label: "Professional & legal fees", group: "Operating expenses" },
  { value: "payroll",          label: "Payroll & contractors",     group: "Operating expenses" },
  { value: "fee",              label: "Bank & card fees",          group: "Operating expenses" },
  { value: "taxes",            label: "Taxes",                     group: "Operating expenses" },
  { value: "other_expense",    label: "Other expense",             group: "Operating expenses" },
  { value: "internal_transfer",label: "Internal transfer",         group: "Transfers & owner" },
  { value: "card_payment",     label: "Credit card payment",       group: "Transfers & owner" },
  { value: "owner_draw",       label: "Owner draw",                group: "Transfers & owner" },
  { value: "cash_in",          label: "Cash deposit",              group: "Transfers & owner" },
  { value: "cash_out",         label: "Cash withdrawal",           group: "Transfers & owner" },
];

const CAT_GROUP_ORDER = ["Income", "Cost of goods", "Operating expenses", "Transfers & owner"];

// Grouped <option>s for any category <select>. Set includeUncat={false} to omit
// the blank "Uncategorized" entry (e.g. a "Set category…" placeholder select).
function CategoryOptions({ includeUncat = true }: { includeUncat?: boolean }) {
  return (
    <>
      {includeUncat && <option value="">Uncategorized</option>}
      {CAT_GROUP_ORDER.map((g) => (
        <optgroup key={g} label={g}>
          {CATEGORIES.filter((c) => c.group === g).map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

const ROLES: { value: string; label: string }[] = [
  { value: "buyer_payment",    label: "Buyer payment" },
  { value: "supplier_payment", label: "Supplier payment" },
  { value: "refund_out",       label: "Refund out" },
  { value: "refund_in",        label: "Refund in" },
  { value: "adjustment",       label: "Adjustment" },
];

const roleLabel = (v: string) => ROLES.find((r) => r.value === v)?.label ?? v;
const catLabel = (v: string) => CATEGORIES.find((c) => c.value === v)?.label ?? (v || "Uncategorized");
// Identify a deal by its BUYER first — an invoice number alone is meaningless when
// scanning for the right deal to tie a payment to.
const dealLabel = (d: DealFlow) =>
  d.client_name?.trim() || d.name?.trim() || (d.invoice_number ? `Invoice #${d.invoice_number}` : "Untitled deal");

const fmtShortDate = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

// Time-of-day from a bank timestamp (Plaid datetime), e.g. "2:40 PM". Empty when the
// bank didn't provide one or the string is date-only.
const fmtTime = (s?: string | null) => {
  if (!s || !s.includes("T")) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

// Does this deal plausibly match a bank transaction — same buyer name, or same
// amount as the invoice? Drives the "match" badge + surfacing the right deal.
const dealMatchesTxn = (d: DealFlow, txn: { counterparty_name?: string | null; amount: number }) => {
  const cp = (txn.counterparty_name || "").trim().toLowerCase();
  const byName = cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp);
  const byAmount = !!txn.amount && !!d.invoice_total && Math.abs(d.invoice_total - txn.amount) < 0.5;
  return byName || byAmount;
};

// The one obvious deal for a transaction — same signals the deal picker ranks by
// (payer name, exact invoice amount), but only surfaced when EXACTLY ONE deal in the
// pool carries them. Two deals for the same amount, or a repeat buyer with several
// open deals, means the answer isn't obvious, so the row says nothing rather than
// guessing loudly. Pass survivorDeals(deals) — never the raw list — so a suggestion
// can't land on a duplicate deal_flow row the deal view hides.
const CONFIDENT_SCORE = 60;
const confidentMatch = (t: BankTxn, pool: DealFlow[]): { deal: DealFlow; reason: string } | null => {
  // Loan-tagged rows aren't deals; anything already tied (in part or in full) is a
  // deliberate allocation and must not be second-guessed by a one-click button.
  if (t.counterparty_type === "loan") return null;
  if (t.allocated > 0.0001) return null;
  if (!(t.unallocated > 0.0001)) return null;
  const cp = (t.counterparty_name || "").trim().toLowerCase();
  const hits: { d: DealFlow; score: number }[] = [];
  for (const d of pool) {
    let score = 0;
    if (cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp)) score += 100;
    if (t.amount && d.invoice_total && Math.abs(d.invoice_total - t.amount) < 0.5) score += 60;
    if (score >= CONFIDENT_SCORE) hits.push({ d, score });
  }
  if (hits.length !== 1) return null;
  const { d, score } = hits[0];
  return {
    deal: d,
    reason:
      score >= 160 ? "payer name and exact amount match"
      : score >= 100 ? "payer name matches"
      : "exact amount match",
  };
};

// "#0041 · Costco pallets" — invoice first, then who the deal is with. Falls back to
// one or the other when the deal carries no name beyond its invoice number.
const matchLabel = (d: DealFlow) => {
  const inv = d.invoice_number ? `#${d.invoice_number}` : "";
  const name = dealLabel(d);
  if (!inv) return name;
  return name === `Invoice #${d.invoice_number}` ? inv : `${inv} · ${name}`;
};

// A rich, scannable deal row: buyer · date · amount · completed/open — used by both
// the allocate picker and the bulk-tag modal so they stay identical.
function DealRowContent({ d, match }: { d: DealFlow; match?: boolean }) {
  const invLabel = d.invoice_number ? `Invoice #${d.invoice_number}` : "";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-ink truncate flex items-center gap-1.5">
          <span className="truncate">{dealLabel(d)}</span>
          {match && <span className="text-[10px] text-accent font-semibold flex-shrink-0">match</span>}
        </div>
        <div className="text-[11px] text-muted truncate">
          {d.completed_at ? fmtShortDate(d.completed_at) : "In progress"}
          {invLabel && dealLabel(d) !== invLabel ? ` · #${d.invoice_number}` : ""}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[12px] tabular-nums text-ink-2">{d.invoice_total ? fmtAmount(d.invoice_total) : "—"}</div>
        <div className={`text-[10px] ${d.stage === "complete" ? "text-success-ink" : "text-muted"}`}>
          {d.stage === "complete" ? "Completed" : "Open"}
        </div>
      </div>
    </div>
  );
}
const loanLabel = (l: Loan) => (l.name?.trim() || l.lender?.trim() || "Loan");
// Loan tags live on the txn (counterparty_type "loan"); the backend derives the
// category by direction — money-in is a loan drawdown, money-out a repayment.
const loanTagLabel = (direction: string) => (direction === "in" ? "Loan received" : "Loan repayment");

// Roles valid for a transaction's direction (must match the backend guard in
// allocate_bank_txn — money-in can't be a supplier payment, etc.).
const rolesFor = (direction: string) =>
  direction === "out"
    ? ROLES.filter((r) => ["supplier_payment", "refund_out"].includes(r.value))
    : ROLES.filter((r) => ["buyer_payment", "refund_in"].includes(r.value));

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

// Collapse duplicate deal_flow rows for one invoice to the single highest-stage
// survivor — the same row Deal Flow shows — so an allocation (single OR bulk) can
// never land on a ghost duplicate the deal view hides.
const DEAL_STAGE_RANK: Record<string, number> = { invoiced: 0, payment_received: 1, supplier_paid: 2, complete: 3 };
const survivorDeals = (deals: DealFlow[]): DealFlow[] => {
  const byInv: Record<string, DealFlow> = {};
  for (const d of deals) {
    const key = d.invoice_id || d.id;
    const prev = byInv[key];
    if (!prev || (DEAL_STAGE_RANK[d.stage || ""] ?? -1) > (DEAL_STAGE_RANK[prev.stage || ""] ?? -1)) byInv[key] = d;
  }
  return Object.values(byInv);
};

export default function FinancialsView() {
  const [txns, setTxns]       = useState<BankTxn[]>([]);
  const [summary, setSummary] = useState<BankTxnSummary | null>(null);
  const [deals, setDeals]     = useState<DealFlow[]>([]);
  const [loans, setLoans]     = useState<Loan[]>([]);
  const [rules, setRules]     = useState<TxnRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Four surfaces: To book (the daily queue) opens first; Ledger is the full
  // history; Cash holds Free cash + Loans; Setup is every once-in-a-while tool.
  // The chosen surface survives leaving and re-entering the page — losing your
  // place on every visit was one of the audit's standing complaints.
  const [tab, setTabRaw] = useState<"tobook" | "ledger" | "cash" | "setup">(() => {
    const t = localStorage.getItem("fin_tab");
    return t === "ledger" || t === "cash" || t === "setup" ? t : "tobook";
  });
  const setTab = (v: "tobook" | "ledger" | "cash" | "setup") => {
    setTabRaw(v);
    localStorage.setItem("fin_tab", v);
  };
  const [cashTab, setCashTab] = useState<"freecash" | "loans">("freecash");
  const [aiBusy, setAiBusy]   = useState(false);
  const [newDealBusy, setNewDealBusy] = useState(false);
  // Record-cash modal (a manual cash txn that then allocates across deals).
  const [cashOpen, setCashOpen]     = useState(false);
  const [cashAmount, setCashAmount] = useState("");
  const [cashDir, setCashDir]       = useState<"in" | "out">("in");
  const [cashDate, setCashDate]     = useState("");
  const [cashCp, setCashCp]         = useState("");
  const [cashNote, setCashNote]     = useState("");
  const [cashSaving, setCashSaving] = useState(false);

  // Import — default to the last account used on this device (generic fallback).
  const [accountId, setAccountId]     = useState(() => localStorage.getItem("fin_last_account") || "business");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview]         = useState<BankPreview | null>(null);
  const [importing, setImporting]     = useState(false);
  const [clearing, setClearing]       = useState(false);

  // Bulk import (multiple statement files in one go)
  const [bulkBusy, setBulkBusy]         = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");

  // Bank feed (Plaid) — live transactions straight from the bank
  const [plaidReady, setPlaidReady]         = useState<boolean | null>(null); // has keys
  const [plaidItems, setPlaidItems]         = useState<PlaidItem[]>([]);
  const [plaidClientId, setPlaidClientId]   = useState("");
  const [plaidSecret, setPlaidSecret]       = useState("");
  const [plaidSavingKeys, setPlaidSavingKeys] = useState(false);
  const [plaidConnecting, setPlaidConnecting] = useState(false);
  const [plaidSyncing, setPlaidSyncing]     = useState(false);
  const [dedupe, setDedupe]                 = useState<DedupeResult | null>(null); // preview/result modal
  const [dedupeRunning, setDedupeRunning]   = useState(false);
  const [dedupeDone, setDedupeDone]         = useState(false); // modal is showing the post-run report
  const [dedupeAggressive, setDedupeAggressive] = useState(false); // remove every exact match, not just safe ones
  const [backupUrl, setBackupUrl]           = useState("");    // Google Sheet safety-log URL
  const [backupEnabled, setBackupEnabled]   = useState(false);
  const [backupLast, setBackupLast]         = useState<{ at: string; total: string }>({ at: "", total: "" });
  const [backupBusy, setBackupBusy]         = useState(false);
  const [plaidEnv, setPlaidEnv]             = useState<"sandbox" | "production">("sandbox");
  const [plaidTesting, setPlaidTesting]     = useState(false);
  const [showKeys, setShowKeys]             = useState(false); // reveal the keys/env form once set up
  const [bankFeedOpen, setBankFeedOpen]     = useState(false); // collapse the whole feed panel once connected
  // Did the last importing sync carry Plaid's pending_transaction_id? Drives the
  // one-line health note in Setup; "unknown" until a sync actually imports something.
  const [pendingRefSeen, setPendingRefSeen] = useState<"unknown" | "yes" | "no">("unknown");
  // Plaid is still extracting a freshly-linked bank's history (a 2-year pull can
  // take ~a minute) — keep re-syncing in the background until transactions land.
  const [plaidPreparing, setPlaidPreparing] = useState(false);
  // Hosted Link connect flow — poll the browser-based connect to completion.
  const pollTimerRef  = useRef<number | null>(null);
  const pollCancelRef = useRef(false);
  const prepTimerRef  = useRef<number | null>(null);

  // AI import (any statement — credit cards / other banks)
  const [aiPreviewPath, setAiPreviewPath] = useState<string | null>(null);
  const [aiPreview, setAiPreview]         = useState<BankAiPreview | null>(null);
  const [aiExtracting, setAiExtracting]   = useState(false);
  const [previewing, setPreviewing]       = useState(false); // parsing a single statement for preview
  const [aiImporting, setAiImporting]     = useState(false);

  // Filters
  const [search, setSearch]           = useState("");
  const [dirFilter, setDirFilter]     = useState<"all" | "in" | "out">("all");
  const [acctFilter, setAcctFilter]   = useState("all");
  const [catFilter, setCatFilter]     = useState("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "unclassified" | "unallocated_in" | "unallocated_out"
  >("all");
  const [fromDate, setFromDate]       = useState(`${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate]           = useState("");

  // Ledger scope: the full history by default; To book / Booked narrow it.
  const [queue, setQueue]             = useState<"all" | "todo" | "booked">("all");

  // To-book queue controls — search and account only. A queue is a queue: no date
  // window, no status dropdowns, nothing that silently hides work.
  const [toBookSearch, setToBookSearch] = useState("");
  const [toBookAcct, setToBookAcct]     = useState("all");

  // Split view: money-in and money-out side by side, each with its own search —
  // for reconciling a refund against the original payment. Plus a collapse that
  // tucks away rows still missing a category so they don't clutter the list.
  const [splitView, setSplitView]     = useState(false);
  const [searchIn, setSearchIn]       = useState("");
  const [searchOut, setSearchOut]     = useState("");

  // Inline payee rename. Plaid mislabels transfers constantly (a Zelle to a person
  // shows as a store), so the fix lives in the row itself — the old prompt() sat
  // behind a hover-only pencil and so didn't exist on touch at all.
  const [payeeEditId, setPayeeEditId] = useState<string | null>(null);
  const [payeeDraft, setPayeeDraft]   = useState("");
  // Escape blurs the input, and blur commits — this flag tells the two apart.
  const payeeCancelRef = useRef(false);

  // Smart grouping suggestions — dismissed groups (payee|dir keys) + per-group
  // category overrides for the session.
  const [dismissedGroups, setDismissedGroups]   = useState<Set<string>>(new Set());
  const [groupCatOverride, setGroupCatOverride] = useState<Record<string, string>>({});

  // Bulk selection + actions (clean a year fast — loop existing commands).
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [bulkCat, setBulkCat]           = useState("");
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [bulkAllocOpen, setBulkAllocOpen]   = useState(false);
  const [aiProgress, setAiProgress]     = useState("");

  // Allocation panel (inline expanding row)
  const [openId, setOpenId]           = useState<string | null>(null);
  const [allocs, setAllocs]           = useState<BankAllocation[]>([]);
  const [allocLoading, setAllocLoading] = useState(false);

  // A linked transaction clicked from the Deal Flow section hands off its id via
  // window.__pendingBankTxn, then navigates here. Pick it up on mount, then (once the
  // txn list has loaded) open its detail via the same toggleRow the row click uses and
  // scroll it into view — so the click lands you right on that transaction.
  const pendingOpenRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = (window as any).__pendingBankTxn;
    if (pending) { pendingOpenRef.current = pending; (window as any).__pendingBankTxn = null; }
  }, []);
  useEffect(() => {
    const id = pendingOpenRef.current;
    if (!id) return;
    const t = txns.find((x) => x.id === id);
    if (!t) return;
    pendingOpenRef.current = null;
    if (openId !== id) toggleRow(t);
    setTimeout(() => {
      document.querySelector(`[data-txn-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns]);
  const [targetType, setTargetType]   = useState<"deal" | "loan" | "expense">("deal");
  const [dealQuery, setDealQuery]     = useState("");
  const [selectedDeal, setSelectedDeal] = useState<DealFlow | null>(null);
  const [dealListOpen, setDealListOpen] = useState(false);
  const [loanQuery, setLoanQuery]     = useState("");
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [loanListOpen, setLoanListOpen] = useState(false);
  const [amountStr, setAmountStr]     = useState("");
  const [role, setRole]               = useState("buyer_payment");
  const [note, setNote]               = useState("");
  const [allocBusy, setAllocBusy]     = useState(false);
  // Which row's one-click "Tie it" is in flight (id, not a bool, so only that row spins).
  const [tyingId, setTyingId]         = useState<string | null>(null);
  // Split mode: allow one transaction to be divided across multiple deals (partial
  // amounts, leg by leg). The backend keeps the running total <= the txn amount.
  const [allowSplit, setAllowSplit]   = useState(false);
  // A failed first load must never render as "No transactions yet" — that reads as
  // data loss and hides the real cause. Hold the message and offer a retry.
  const [loadError, setLoadError]     = useState<string | null>(null);
  const [refreshing, setRefreshing]   = useState(false);
  // Latest refreshAll, for the mounted-once sync listener (see below).
  const refreshRef = useRef<((keepOpen?: boolean) => Promise<void>) | null>(null);

  const loadAll = async () => {
    setLoadError(null);
    try {
      const [t, s, d, ln, r] = await Promise.all([
        api.listBankTxns(), api.bankTxnSummary(), api.listDealFlows(), api.listLoans(), api.listTxnRules(),
      ]);
      setTxns(t); setSummary(s); setDeals(d); setLoans(ln); setRules(r);
      // Heal payments paired to duplicate deal_flow rows AND archive the duplicate
      // rows so pickers/aggregates stay clean (idempotent; usually a no-op).
      api.cleanupGhostDealFlows().then((n) => { if (n > 0) api.listDealFlows().then(setDeals).catch(() => {}); }).catch(() => {});
      // NOTE: healOverallocatedTxns is deliberately NOT run here. It deletes the
      // most recently created allocation, which is as likely to be the correct leg
      // as the duplicate — too destructive to fire from merely opening the screen.
      // Over-allocation is surfaced below instead, for a human to resolve.
    } catch (e: any) {
      setLoadError(String(e?.message || e));
    } finally { setLoading(false); }
  };

  const loadPlaid = async () => {
    try {
      const cfg = await api.plaidConfig();
      setPlaidReady(cfg.has_keys);
      if (cfg.env === "sandbox" || cfg.env === "production") setPlaidEnv(cfg.env);
    } catch { setPlaidReady(false); }
    try { setPlaidItems(await api.plaidListItems()); } catch { /* no banks / not set up yet */ }
  };

  useEffect(() => {
    loadAll();
    // Bank feed is secondary — load separately so a Plaid hiccup never blocks the list.
    loadPlaid();
  }, []);

  // Live-refresh when a sync pull applies remote rows — e.g. a second admin (a
  // brother's login on the same org) links a payment or records a refund on his
  // device. Without this the Financials tab shows stale data until it's remounted.
  //
  // The listener mounts once, so it must call through a ref: capturing refreshAll
  // directly froze the first render's openId (always null), which meant an OPEN
  // allocation panel kept showing stale allocations while the table underneath
  // refreshed — the exact state that causes a double-book.
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { refreshRef.current?.(true).catch(() => {}); })
      .then((u) => { if (dead) u(); else un = u; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // Escape closes the booking sheet (the payee editor stops propagation so its
  // own Escape doesn't also close the sheet).
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  // Stop any in-flight bank-connect polling when this view unmounts.
  useEffect(() => () => {
    pollCancelRef.current = true;
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current);
    if (prepTimerRef.current !== null) clearTimeout(prepTimerRef.current);
  }, []);

  // Reload txns + summary, and (optionally) the open row's allocations.
  const refreshAll = async (keepOpen = true) => {
    // Loan tags change outstanding, so refresh loans alongside txns (cheap). Deals
    // too — a deal added on another device (the netsync-applied path) or elsewhere
    // in the app must reach the allocation picker without a full remount.
    const [t, s, ln, d] = await Promise.all([api.listBankTxns(), api.bankTxnSummary(), api.listLoans(), api.listDealFlows()]);
    setTxns(t); setSummary(s); setLoans(ln); setDeals(d);
    if (keepOpen && openId) {
      const a = await api.listBankAllocationsForTxn(openId);
      setAllocs(a);
      const nt = t.find((x) => x.id === openId);
      setAmountStr(nt ? String(nt.unallocated) : "");
    }
  };
  refreshRef.current = refreshAll;

  // Screen-level refresh. Deliberately NOT gated on a Plaid link: on a device that
  // has never linked a bank itself, every other refresh control on this screen is
  // hidden, which left no way to re-read the ledger without leaving the tab.
  const refreshScreen = async () => {
    setRefreshing(true);
    try { await refreshAll(true); }
    catch (e: any) { toast(errText(e), "error"); }
    finally { setRefreshing(false); }
  };

  const recordCash = async () => {
    const amt = Number(cashAmount);
    if (!(amt > 0)) { toast("Enter a cash amount greater than zero", "error"); return; }
    setCashSaving(true);
    try {
      await api.addCashTransaction(amt, cashDir, cashDate || new Date().toISOString().slice(0, 10), cashCp.trim() || undefined, cashNote.trim() || undefined);
      setCashOpen(false); setCashAmount(""); setCashCp(""); setCashNote("");
      await refreshAll(false);
      toast(`Cash ${cashDir === "out" ? "payment" : "receipt"} recorded — allocate it to deals below`);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setCashSaving(false); }
  };

  const savePlaidKeys = async () => {
    const cid = plaidClientId.trim(), sec = plaidSecret.trim();
    if (!cid || !sec) { toast("Enter both the client ID and secret", "error"); return; }
    setPlaidSavingKeys(true);
    try {
      await api.plaidSetKeys(cid, sec, plaidEnv);
      const cfg = await api.plaidConfig();
      setPlaidReady(cfg.has_keys);
      if (cfg.env === "sandbox" || cfg.env === "production") setPlaidEnv(cfg.env);
      setPlaidClientId(""); setPlaidSecret("");
      toast("Plaid keys saved");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSavingKeys(false); }
  };

  const testPlaidKeys = async () => {
    setPlaidTesting(true);
    try {
      toast(await api.plaidTestKeys());
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidTesting(false); }
  };

  // Stop the hosted-link poll loop (shared by success, timeout, error and Cancel).
  const stopPolling = () => {
    pollCancelRef.current = true;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Booking-destroying events must never pass silently. The bank retracting rows
  // already reviewed or allocated (the pending→posted churn) and amendments below
  // the booked total used to be surfaced only on the manual Sync-now path — the
  // background prep-retry timer and the post-connect sync swallowed them, which is
  // why a destroyed booking felt unexplained rather than like a warning that was
  // shown. Every plaidSync-shaped result now reports through here.
  const surfaceSyncWarnings = (r: PlaidSyncSummary) => {
    // Canary: if a sync imported transactions but not one carried Plaid's
    // pending_transaction_id, the automatic pending→posted carry-forward cannot
    // fire for these institutions. It is inert, not broken — bookings are still
    // never destroyed — but Jack should know the safety net is doing nothing.
    if (r.imported > 0) setPendingRefSeen(r.with_pending_ref > 0 ? "yes" : "no");
    // Work the bank moved for you, carried automatically onto the posted twin.
    if (r.settled > 0) {
      toast(`${r.settled} transaction${r.settled === 1 ? "" : "s"} settled at your bank — ${r.settled === 1 ? "its booking was" : "their bookings were"} carried over, no re-work needed.`, "success");
    }
    if (r.over_allocated?.length) {
      toast(
        `${r.over_allocated.length} transaction${r.over_allocated.length === 1 ? " was" : "s were"} changed by the bank to less than what's booked against ${r.over_allocated.length === 1 ? "it" : "them"}: ${r.over_allocated.join("; ")}. Nothing was removed — please review the allocations.`,
        "error",
      );
    }
    // The bank retracted work already reviewed or booked, and no replacement could
    // be identified. Since v0.15.137 the row is KEPT — nothing was deleted, so there
    // is nothing to "re-link"; the old copy said the opposite and was wrong.
    if (r.retracted_kept > 0) {
      toast(`Your bank retracted ${r.retracted_kept} transaction${r.retracted_kept === 1 ? "" : "s"} you'd already reviewed or booked. Nothing was deleted — ${r.retracted_kept === 1 ? "it is" : "they are"} still in your ledger. If the replacement has landed, use "Re-pull all" in Setup to move your work onto it.`, "error");
    }
    // A pending/posted pair was identified but the booking could not be moved
    // automatically. Both rows are intact; which one keeps the work is a human call.
    if (r.settle_refused?.length) {
      toast(`${r.settle_refused.length} settled transaction${r.settle_refused.length === 1 ? "" : "s"} couldn't have the booking moved automatically: ${r.settle_refused.join("; ")}. Nothing was changed — please re-link by hand.`, "error");
    }
    // Surface the actual per-bank Plaid error so a silent empty result is never a mystery.
    for (const x of r.results.filter((x) => x.status === "error")) {
      toast(`${x.institution || "A bank"} couldn't sync: ${x.error}`, "error");
    }
  };

  // While a freshly-linked bank is still being prepared by Plaid, re-sync in the
  // background a few times (~every 20s) until transactions land, then stop.
  const schedulePrepRetries = (left: number) => {
    if (prepTimerRef.current !== null) clearTimeout(prepTimerRef.current);
    if (left <= 0) {
      // Retries exhausted — clear the "preparing" banner so it doesn't sit forever,
      // and tell the user how to finish once the bank's history is ready.
      setPlaidPreparing(false);
      toast("Your bank is still preparing transactions — use Sync now in a few minutes.");
      return;
    }
    prepTimerRef.current = window.setTimeout(async () => {
      prepTimerRef.current = null;
      try {
        const r = await api.plaidSync();
        surfaceSyncWarnings(r);
        if (r.imported > 0 || r.removed > 0) {
          setPlaidPreparing(false);
          await refreshAll(false);
          toast(`Synced ${r.imported} transaction${r.imported === 1 ? "" : "s"}`);
          return;
        }
        if (r.preparing) { schedulePrepRetries(left - 1); }
        else { setPlaidPreparing(false); await refreshAll(false); }
      } catch { schedulePrepRetries(left - 1); }
    }, 20000);
  };

  // Connect a bank via Plaid Hosted Link: open Plaid in the system browser (where
  // bank logins / OAuth actually work — the embedded widget stalls inside the
  // Tauri webview), then poll every 3s until the server reports it exchanged.
  const connectBank = async () => {
    if (plaidConnecting) return; // guard against double-clicks
    setPlaidConnecting(true);
    pollCancelRef.current = false;
    try {
      const { hosted_link_url, link_token } = await api.plaidConnectStart();
      await api.openExternal(hosted_link_url);
      let attempts = 0;
      let pollErrors = 0;
      const maxAttempts = 100; // ~5 minutes at 3s each
      const tick = async () => {
        if (pollCancelRef.current) return;
        attempts += 1;
        try {
          const r = await api.plaidConnectPoll(link_token);
          if (pollCancelRef.current) return;
          pollErrors = 0; // a good poll resets the tolerance
          if (r.status === "connected") {
            stopPolling();
            const inst = r.institution || "bank";
            toast(`Connected ${inst}`);
            setPlaidItems(await api.plaidListItems());
            const s = await api.plaidSync();
            surfaceSyncWarnings(s);
            if (s.imported > 0) {
              toast(`Synced ${s.imported} transaction${s.imported === 1 ? "" : "s"}`);
              await refreshAll(false);
            } else if (s.preparing) {
              setPlaidPreparing(true);
              schedulePrepRetries(6); // ~2 min of background re-syncs
            } else {
              await refreshAll(false);
            }
            setPlaidConnecting(false);
            return;
          }
          if (attempts >= maxAttempts) {
            stopPolling();
            toast("Didn't detect a completed connection — click Connect a bank to try again.", "error");
            setPlaidConnecting(false);
            return;
          }
          pollTimerRef.current = window.setTimeout(tick, 3000);
        } catch (e: any) {
          // A transient blip (network, laptop sleep) shouldn't abort a valid connect
          // while the user is mid-login. Tolerate a few in a row before giving up.
          pollErrors += 1;
          if (pollCancelRef.current) return;
          if (pollErrors >= 5) {
            stopPolling();
            toast(errText(e), "error");
            setPlaidConnecting(false);
          } else {
            pollTimerRef.current = window.setTimeout(tick, 3000);
          }
        }
      };
      pollTimerRef.current = window.setTimeout(tick, 3000);
    } catch (e: any) {
      stopPolling();
      toast(errText(e), "error");
      setPlaidConnecting(false);
    }
  };

  // Cancel the wait — stops polling only; nothing is undone server-side.
  const cancelConnect = () => {
    stopPolling();
    setPlaidConnecting(false);
  };

  // "sync" reads Plaid's cached copy; "full" resets the cursor and re-pulls;
  // "refresh" first FORCES the bank to hand Plaid its very latest activity (today's
  // wires/spend) before syncing — the only path that surfaces same-day money.
  const syncPlaid = async (mode: "sync" | "full" | "refresh" = "sync") => {
    setPlaidSyncing(true);
    try {
      const r = mode === "full" ? await api.plaidResyncAll()
              : mode === "refresh" ? await api.plaidRefreshSync()
              : await api.plaidSync();
      const stillPreparing = r.preparing || r.results.some((x) => x.status === "preparing");
      const amended = r.amended ?? 0;
      if (r.imported === 0 && r.removed === 0 && amended === 0 && stillPreparing) {
        setPlaidPreparing(true);
        schedulePrepRetries(6);
        toast("Plaid is still preparing your transactions — this can take a minute.");
      } else {
        setPlaidPreparing(stillPreparing);
        if (mode === "refresh" && r.imported === 0 && r.removed === 0 && amended === 0) {
          toast("Refreshed from bank — nothing new yet. Same-day wires can take a few hours to post; try again shortly.");
        } else {
          const lead = mode === "refresh" ? "Refreshed — " : "";
          const bits = [`Synced ${r.imported} new transaction${r.imported === 1 ? "" : "s"}`];
          if (r.removed > 0) bits.push(`removed ${r.removed}`);
          // The bank changed a transaction we already held (a pending row settling at
          // a different amount, a corrected date). These used to be discarded silently.
          if (amended > 0) bits.push(`updated ${amended} the bank changed`);
          toast(`${lead}${bits.join(", ")}`);
        }
        await refreshAll(false);
      }
      surfaceSyncWarnings(r);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSyncing(false); }
  };

  // A bulk clear keeps anything reviewed or linked to a deal; those only go if
  // you're told exactly what they are and say yes a second time.
  const clearTxnsGuarded = async (scope: "statements" | "all") => {
    const r = await api.clearBankTxns(scope);
    const n = r.kept;
    if (n === 0) return r;
    if (!confirm(
      `Kept ${n} transaction${n === 1 ? "" : "s"} that ${n === 1 ? "is" : "are"} already reviewed or linked to a deal.\n\nDelete ${n === 1 ? "it" : "them"} too? Any deal linked to ${n === 1 ? "it" : "them"} loses that money from its recorded profit. This can't be undone.`
    )) return r;
    const f = await api.clearBankTxns(scope, true);
    return { deleted: r.deleted + f.deleted, allocations_removed: r.allocations_removed + f.allocations_removed, kept: 0 };
  };

  const clearAndRepull = async () => {
    if (!confirm(
      "Clear bank transactions and re-pull fresh from your currently connected banks?\n\nAnything reviewed or linked to a deal is kept — you'll be asked separately before those go. Use this after removing a wrong account. This can't be undone."
    )) return;
    setPlaidSyncing(true);
    try {
      const c = await clearTxnsGuarded("all");
      const r = await api.plaidResyncAll();
      const stillPreparing = r.preparing || r.results.some((x) => x.status === "preparing");
      setPlaidPreparing(stillPreparing);
      if (stillPreparing) schedulePrepRetries(6);
      toast(`Cleared ${c.deleted} old, pulled ${r.imported} fresh transaction${r.imported === 1 ? "" : "s"}${c.kept > 0 ? ` (kept ${c.kept} reviewed or deal-linked)` : ""}`);
      surfaceSyncWarnings(r);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setPlaidSyncing(false); }
  };

  // Duplicate cleanup: preview first (dry run), then the user confirms in the modal.
  // aggressive=true removes every exact match (same date/amount/memo), not just the
  // clearly-safe ones — still never a booked row, and everything is backed up.
  const previewDedupe = async (aggressive: boolean) => {
    setDedupeAggressive(aggressive);
    setDedupeRunning(true);
    setDedupeDone(false);
    try {
      const r = await api.dedupeBankTxns(true, aggressive);
      setDedupe(r);
      if ((r.auto_remove || 0) === 0 && r.review_count === 0) {
        toast("No duplicate transactions found", "success");
        setDedupe(null);
      }
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setDedupeRunning(false); }
  };

  const executeDedupe = async () => {
    setDedupeRunning(true);
    try {
      const r = await api.dedupeBankTxns(false, dedupeAggressive);
      setDedupe(r);
      setDedupeDone(true);
      await refreshAll(false);
      toast(`Removed ${r.removed || 0} duplicate${(r.removed || 0) === 1 ? "" : "s"}${r.review_count ? ` · ${r.review_count} still need a look` : ""}`, "success");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setDedupeRunning(false); }
  };

  // Google Sheet safety log for bank transactions.
  useEffect(() => {
    api.getBankBackupSettings().then((s) => {
      setBackupUrl(s.sheet_url || "");
      setBackupEnabled(!!s.enabled);
      setBackupLast({ at: s.last_at || "", total: s.last_total || "" });
    }).catch(() => {});
  }, []);

  const saveBackupSettings = async (url: string, enabled: boolean) => {
    setBackupUrl(url); setBackupEnabled(enabled);
    try { await api.setBankBackupSettings(url, enabled); } catch (e: any) { toast(errText(e), "error"); }
  };

  const runBackupNow = async () => {
    setBackupBusy(true);
    try {
      const r = await api.backupBankTxnsNow();
      setBackupLast({ at: r.at, total: String(r.total) });
      toast(r.added > 0 ? `Backed up ${r.added} transaction${r.added === 1 ? "" : "s"} to your sheet` : "Sheet is already up to date", "success");
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setBackupBusy(false); }
  };

  const disconnectBank = async (item: PlaidItem) => {
    if (!confirm(
      `Disconnect ${item.institution}?\n\nThe live feed from this bank stops. Transactions already imported stay in the list — nothing is deleted — but to start pulling again you'd have to link the bank from scratch.`
    )) return;
    try {
      await api.plaidRemoveItem(item.id);
      toast("Bank disconnected");
      const items = await api.plaidListItems();
      setPlaidItems(items);
      if (items.length === 0) {
        if (prepTimerRef.current !== null) { clearTimeout(prepTimerRef.current); prepTimerRef.current = null; }
        setPlaidPreparing(false);
      }
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // Open/close a row's allocation panel.
  //
  // This is the ONLY place openId changes, so it is also where the panel is reset.
  // Every field has to be cleared here or it bleeds into the next row: split mode
  // left on re-primes the amount for a different deal, and stale allocs render
  // under the new transaction whenever its fetch fails (the catch below clears
  // allocLoading but would otherwise leave the previous row's list on screen).
  // A useEffect on [openId] cannot do this — it runs after the commit and would
  // wipe the amount and role prefilled just below.
  const toggleRow = (t: BankTxn) => {
    if (openId === t.id) { setOpenId(null); return; }
    setOpenId(t.id);
    setTargetType("deal");
    setDealQuery(""); setSelectedDeal(null); setDealListOpen(false); setNote("");
    setLoanQuery(""); setSelectedLoan(null); setLoanListOpen(false);
    setAllowSplit(false);
    setAllocs([]);
    setRole(t.direction === "out" ? "supplier_payment" : "buyer_payment");
    setAmountStr(String(t.unallocated));
    setAllocLoading(true);
    api.listBankAllocationsForTxn(t.id)
      .then(setAllocs)
      .catch((e: any) => toast(errText(e), "error"))
      .finally(() => setAllocLoading(false));
  };

  // Normalize the dialog result (string | string[] | null) to a list of paths.
  const asPaths = (sel: string | string[] | null): string[] =>
    Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];

  // Import flow — one file previews first; multiple files import straight through.
  const pickAndPreview = async () => {
    const paths = asPaths(await openDialog({
      multiple: true,
      filters: [{ name: "Bank statement", extensions: ["pdf", "ofx", "qbo", "qfx", "csv"] }],
    }));
    if (paths.length === 0) return;
    if (paths.length > 1) { await bulkImport(paths, false); return; }
    const selected = paths[0];
    setPreviewPath(selected);
    setPreview(null);
    setPreviewing(true);
    try {
      const p = await api.bankPreview(selected);
      setPreview(p);
    } catch (e: any) { toast(errText(e), "error"); setPreviewPath(null); }
    finally { setPreviewing(false); }
  };

  // Import many statements sequentially, all into the current account.
  const bulkImport = async (paths: string[], ai: boolean) => {
    const acct = accountId.trim() || "business";
    localStorage.setItem("fin_last_account", acct);
    setBulkBusy(true);
    let imported = 0, extracted = 0, skipped = 0;
    const errors: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      setBulkProgress(`Importing ${i + 1} of ${paths.length}…`);
      try {
        const s = ai ? await api.bankImportAi(paths[i], acct) : await api.bankImport(paths[i], acct);
        imported += s.imported;
        skipped += s.skipped;
        if (ai) extracted += (s as BankAiImportResult).extracted;
      } catch (e: any) { errors.push(String(e)); }
    }
    setBulkProgress("");
    setBulkBusy(false);
    const failNote = errors.length ? ` — ${errors.length} file${errors.length === 1 ? "" : "s"} failed` : "";
    toast(
      ai
        ? `AI imported ${imported} (extracted ${extracted}), skipped ${skipped} across ${paths.length} files${failNote}`
        : `Imported ${imported}, skipped ${skipped} across ${paths.length} files${failNote}`,
      errors.length ? "error" : "success",
    );
    await refreshAll(false);
  };

  const doImport = async () => {
    if (!previewPath) return;
    setImporting(true);
    try {
      const acct = accountId.trim() || "business";
      localStorage.setItem("fin_last_account", acct);
      const s = await api.bankImport(previewPath, acct);
      toast(`Imported ${s.imported}, skipped ${s.skipped} (already imported)`);
      setPreview(null); setPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setImporting(false); }
  };

  // AI import flow — reads ANY statement (credit cards, other banks) via LLM.
  const pickAndPreviewAi = async () => {
    const paths = asPaths(await openDialog({
      multiple: true,
      filters: [{ name: "Statement", extensions: ["pdf", "ofx", "qbo", "qfx", "csv"] }],
    }));
    if (paths.length === 0) return;
    if (paths.length > 1) { await bulkImport(paths, true); return; }
    const selected = paths[0];
    setAiPreviewPath(selected);
    setAiPreview(null);
    setAiExtracting(true);
    try {
      const p = await api.bankPreviewAi(selected);
      setAiPreview(p);
    } catch (e: any) { toast(errText(e), "error"); setAiPreviewPath(null); }
    finally { setAiExtracting(false); }
  };

  const doImportAi = async () => {
    if (!aiPreviewPath) return;
    setAiImporting(true);
    try {
      const acct = accountId.trim() || "business";
      localStorage.setItem("fin_last_account", acct);
      const s = await api.bankImportAi(aiPreviewPath, acct);
      toast(`AI imported ${s.imported} (extracted ${s.extracted}); skipped ${s.skipped} already-imported. Review + allocate below.`);
      setAiPreview(null); setAiPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAiImporting(false); }
  };

  // Remove statement-imported transactions (PDF/OFX/CSV/AI) — keeps the live
  // bank feed (Plaid) so the two don't overlap. Allocations go with them.
  const clearStatementImports = async () => {
    if (clearing) return;
    if (!window.confirm(
      "Remove all transactions imported from statement files (PDF/OFX/CSV)? This keeps everything from the live bank feed (Plaid), plus anything reviewed or linked to a deal — you'll be asked separately before those go. This can't be undone (you can re-import statements later)."
    )) return;
    setClearing(true);
    try {
      const r = await clearTxnsGuarded("statements");
      toast(
        [
          `Removed ${r.deleted} statement transactions`,
          r.allocations_removed > 0 ? ` (${r.allocations_removed} allocations cleared)` : "",
          r.kept > 0 ? ` — kept ${r.kept} reviewed or deal-linked` : "",
        ].join(""),
      );
      await refreshAll(false);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setClearing(false); }
  };

  // Save classification / reviewed flag. Sends ONLY the field being changed —
  // never the whole cached row. Sync is per-column last-write-wins, so re-sending
  // an untouched field re-stamps it with a fresh clock and lets this device's
  // (possibly stale) copy beat a newer edit from another device. That is how
  // changing a category used to un-book a transaction booked elsewhere.
  const saveReview = async (t: BankTxn, patch: BankTxnReviewPatch) => {
    try {
      await api.setBankTxnReview(t.id, patch);
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
      const s = await api.bankTxnSummary();
      setSummary(s);
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // Enter and blur both land here; Escape sets payeeCancelRef first so the blur it
  // causes closes the editor without writing. An empty or unchanged name is a no-op
  // (clearing the payee is not what a blank box means).
  const commitPayeeEdit = (t: BankTxn, raw: string) => {
    setPayeeEditId(null);
    if (payeeCancelRef.current) { payeeCancelRef.current = false; return; }
    const next = raw.trim();
    if (!next || next === (t.counterparty_name || "").trim()) return;
    saveReview(t, { counterparty_name: next });
  };

  const submitAlloc = async () => {
    if (!openId) return;
    if (targetType === "loan") {
      if (!selectedLoan) { toast("Pick a loan first", "error"); return; }
      setAllocBusy(true);
      try {
        await api.tagBankTxnToLoan(openId, selectedLoan.id);
        toast("Tagged to loan");
        await refreshAll(true);
      } catch (e: any) { toast(errText(e), "error"); }
      finally { setAllocBusy(false); }
      return;
    }
    if (!selectedDeal) { toast("Pick a deal first", "error"); return; }
    const amt = parseFloat(amountStr);
    if (!(amt > 0)) { toast("Enter an amount", "error"); return; }
    setAllocBusy(true);
    try {
      await api.allocateBankTxn(openId, selectedDeal.id, amt, role, note.trim(), allowSplit);
      toast(allowSplit ? "Split leg allocated" : "Allocated to deal");
      // In split mode keep the panel primed for the next leg; otherwise reset.
      setSelectedDeal(null); setDealQuery(""); setNote("");
      if (!allowSplit) setAmountStr("");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAllocBusy(false); }
  };

  // One-click allocate for an unambiguous match: the full remaining amount, role read
  // from the direction (money in = buyer payment, money out = supplier payment — the
  // same pairing bulk allocate uses and the only roles rolesFor allows). This calls the
  // exact command the panel calls, so nothing here skips a backend check; the row is
  // re-checked for remaining amount at click time in case it went stale.
  const tieMatch = async (t: BankTxn, d: DealFlow) => {
    if (tyingId) return;
    if (!(t.unallocated > 0.0001)) { toast("Nothing left to tie on this transaction", "error"); return; }
    setTyingId(t.id);
    try {
      const r = t.direction === "out" ? "supplier_payment" : "buyer_payment";
      await api.allocateBankTxn(t.id, d.id, t.unallocated, r, "");
      toast(`Tied ${fmtAmount(t.unallocated)} to ${dealLabel(d)}`);
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setTyingId(null); }
  };

  const untagLoan = async (bankTxnId: string) => {
    setAllocBusy(true);
    try {
      await api.untagBankTxnLoan(bankTxnId);
      toast("Loan tag removed");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
    finally { setAllocBusy(false); }
  };

  // Memorize a rule AND immediately tag every matching transaction — one click
  // handles the whole backlog instead of tagging each row by hand.
  const createRule = async (
    matchCounterparty: string, category: string, tType: "deal" | "loan" | "expense", targetId: string,
    direction: string,
  ): Promise<boolean> => {
    try {
      await api.createTxnRule(matchCounterparty, category, tType, targetId, "", direction);
      const r = await api.applyTxnRules();
      const dirWord = direction === "in" ? " money-in" : direction === "out" ? " money-out" : "";
      toast(`Rule saved — tagged ${r.updated}${dirWord} transaction${r.updated === 1 ? "" : "s"}`);
      setRules(await api.listTxnRules());
      await refreshAll(false);
      return true;
    } catch (e: any) { toast(errText(e), "error"); return false; }
  };

  const deleteRule = async (id: string) => {
    try {
      await api.deleteTxnRule(id);
      setRules(await api.listTxnRules());
    } catch (e: any) { toast(errText(e), "error"); }
  };

  const applyRules = async () => {
    try {
      const r = await api.applyTxnRules();
      toast(`Applied to ${r.updated} transaction${r.updated === 1 ? "" : "s"}`);
      await refreshAll(true);
      setRules(await api.listTxnRules());
    } catch (e: any) { toast(errText(e), "error"); }
  };

  const removeAlloc = async (id: string) => {
    try {
      await api.removeBankAllocation(id);
      toast("Allocation removed");
      await refreshAll(true);
    } catch (e: any) { toast(errText(e), "error"); }
  };

  // ── Bulk actions ────────────────────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Run an action over the current selection, one existing command at a time, with a
  // running counter; then a single refresh. Skips rows already gone from the list.
  const runBulk = async (fn: (t: BankTxn) => Promise<unknown> | undefined) => {
    const ids = Array.from(selected);
    setBulkActionBusy(true);
    let done = 0, failed = 0;
    let firstErr = ""; // surface WHY (usually "already linked to another deal")
    for (const id of ids) {
      const t = txns.find((x) => x.id === id);
      if (!t) continue;
      try { await fn(t); } catch (e: any) { failed += 1; if (!firstErr) firstErr = String(e?.message || e); }
      done += 1;
      setBulkProgress(`Updating ${done} of ${ids.length}…`);
    }
    setBulkProgress("");
    setBulkActionBusy(false);
    clearSelection();
    await refreshAll(true);
    if (failed > 0) toast(`${failed} of ${ids.length} couldn't be updated${firstErr ? ` — ${firstErr}` : ""}`, "error");
  };

  const bulkSetCategory = (cat: string) =>
    runBulk((t) => api.setBankTxnReview(t.id, { category: cat }));
  const bulkSetReviewed = (val: boolean) =>
    runBulk((t) => api.setBankTxnReview(t.id, { reviewed: val }));
  // Allocate each selected txn's remaining amount to one deal; role auto-picked by
  // direction so mixed in/out selections book to the correct side.
  const bulkAllocate = (deal: DealFlow) =>
    runBulk((t) => {
      if (!(t.unallocated > 0.0001)) return undefined;
      const r = t.direction === "out" ? "supplier_payment" : "buyer_payment";
      return api.allocateBankTxn(t.id, deal.id, t.unallocated, r, "");
    });
  // Tag each selected txn to one loan; the backend derives received/repayment per
  // direction, so a mixed selection books each side correctly.
  const bulkTagLoan = (loan: Loan) =>
    runBulk((t) => api.tagBankTxnToLoan(t.id, loan.id));

  // Delete hand-picked transactions — the escape hatch for duplicates the automatic
  // cleanup refuses to touch. Anything booked to a deal/loan/refund is skipped by the
  // backend (removing it would silently change recorded profit) and reported back.
  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}?\n\n` +
        `Anything linked to a deal, loan or refund is kept — those are skipped and reported.\n` +
        `This can't be undone from here, though a copy of everything removed is saved locally.`
    );
    if (!ok) return;
    setBulkActionBusy(true);
    try {
      const r = await api.deleteBankTxns(ids);
      clearSelection();
      await refreshAll(true);
      const extra = r.skipped_booked > 0 ? ` · ${r.skipped_booked} kept (linked to a deal)` : "";
      toast(`Deleted ${r.deleted} transaction${r.deleted === 1 ? "" : "s"}${extra}`, "success");
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setBulkActionBusy(false);
    }
  };

  // Suggest categories with AI. Suggestions only — does NOT mark reviewed. Loops the
  // batched command until the backlog is clear (or the model stops making progress).
  const aiCategorize = async () => {
    setAiBusy(true);
    let total = 0;
    try {
      for (let round = 0; round < 25; round++) {
        const { updated, remaining } = await api.aiCategorizeBankTxns();
        total += updated;
        if (remaining > 0 && updated > 0) setAiProgress(`Categorized ${total} — ${remaining} left…`);
        if (remaining <= 0 || updated === 0) break;
      }
      setAiProgress("");
      toast(`AI categorized ${total} transaction${total === 1 ? "" : "s"}`);
      await refreshAll(true);
    } catch (e: any) { setAiProgress(""); toast(errText(e), "error"); }
    finally { setAiBusy(false); }
  };

  // Rebuild a never-tracked brokering deal from a bank receipt:
  // client → backfilled invoice → deal flow → allocate this receipt to it.
  const createDealFromTxn = async (
    t: BankTxn, dealName: string, buyerName: string, expectedSale: number, noteVal: string,
  ): Promise<boolean> => {
    // Guard: this backfills a deal from a RECEIVED payment (allocated as
    // buyer_payment). A money-out txn would create an orphan client/invoice/deal
    // and then fail the allocation on the direction guard.
    if (t.direction !== "in") { toast("New-deal backfill is for money-in receipts only", "error"); return false; }
    setNewDealBusy(true);
    try {
      const client = await api.createClient({ name: buyerName });
      const today = new Date().toISOString().slice(0, 10);
      const invoiceId = await api.createInvoice({
        client_id: client.id,
        issue_date: today,
        due_date: today,
        line_items: [{ description: dealName, qty: 1, rate: expectedSale, amount: expectedSale }],
        tax_rate: 0,
        notes: "Backfilled from bank import",
      });
      const dealId = await api.createDealFlow(invoiceId, "Backfilled from bank import", dealName);
      await api.allocateBankTxn(t.id, dealId, t.unallocated, "buyer_payment", noteVal);
      toast("Deal created and receipt allocated");
      setDeals(await api.listDealFlows());
      await refreshAll(true);
      return true;
    } catch (e: any) { toast(errText(e), "error"); return false; }
    finally { setNewDealBusy(false); }
  };

  // Shared filters — everything except direction + search. Reused by the combined
  // list and both split panes so all three stay consistent.
  // `bypass` = a search term is active: an exact-amount / payee lookup should span
  // the WHOLE ledger, not just the To-do queue and the current-year window —
  // otherwise a booked or prior-year transfer is silently hidden even when the
  // amount matches exactly. Account / category / status stay applied (those are
  // deliberate user choices, not defaults).
  const passesBase = useCallback((t: BankTxn, bypass = false) => {
    if (!bypass) {
      if (queue === "todo" && t.reviewed) return false;
      if (queue === "booked" && !t.reviewed) return false;
    }
    if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
    if (catFilter !== "all" && (t.category || "") !== catFilter) return false;
    if (statusFilter === "unclassified" && (t.category || "") !== "") return false;
    if (statusFilter === "unallocated_in" && !(t.direction === "in" && (t.category || "") !== "internal_transfer" && t.unallocated > 0.0001)) return false;
    if (statusFilter === "unallocated_out" && !(t.direction === "out" && (t.category || "") !== "internal_transfer" && t.unallocated > 0.0001)) return false;
    if (!bypass) {
      const d = (t.posted_at || "").slice(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
    }
    return true;
  }, [queue, acctFilter, catFilter, statusFilter, fromDate, toDate]);

  const filtered = useMemo(
    () => txns.filter((t) =>
      passesBase(t, !!search.trim()) &&
      (dirFilter === "all" || t.direction === dirFilter) &&
      matchesQuery(t, search)),
    [txns, passesBase, dirFilter, search],
  );

  // Split-view panes: forced direction + independent search per side.
  const filteredIn = useMemo(
    () => txns.filter((t) => t.direction === "in" && passesBase(t, !!searchIn.trim()) && matchesQuery(t, searchIn)),
    [txns, passesBase, searchIn],
  );
  const filteredOut = useMemo(
    () => txns.filter((t) => t.direction === "out" && passesBase(t, !!searchOut.trim()) && matchesQuery(t, searchOut)),
    [txns, passesBase, searchOut],
  );

  // Distinct account ids present in the loaded transactions (for the filter).
  const accounts = useMemo(
    () => Array.from(new Set(txns.map((t) => t.account_id).filter(Boolean))).sort(),
    [txns],
  );

  // Smart grouping — cluster un-booked rows by (payer, direction) so a whole
  // backlog of look-alikes can be tagged in one click. Payer + direction keeps the
  // same payer's money-in and money-out apart (a Zelle to "Walmart Loads" never
  // merges with a "Walmart" store purchase). Surface the top 3 groups of 4+.
  const suggestedGroups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; payee: string; direction: "in" | "out"; count: number; cats: Record<string, number>; defaultCat: string }
    >();
    for (const t of txns) {
      if (t.reviewed) continue;
      const payee = (t.counterparty_name || "").trim();
      if (!payee) continue;
      const key = `${payee.toLowerCase()}|${t.direction}`;
      let g = map.get(key);
      if (!g) { g = { key, payee, direction: t.direction, count: 0, cats: {}, defaultCat: "" }; map.set(key, g); }
      g.count += 1;
      if (t.category) g.cats[t.category] = (g.cats[t.category] || 0) + 1;
    }
    const groups = Array.from(map.values()).filter((g) => g.count >= 3 && !dismissedGroups.has(g.key));
    for (const g of groups) {
      let best = "", bestN = 0;
      for (const [c, n] of Object.entries(g.cats)) if (n > bestN) { best = c; bestN = n; }
      g.defaultCat = best; // most common existing category in the group (or blank)
    }
    return groups.sort((a, b) => b.count - a.count).slice(0, 10);
  }, [txns, dismissedGroups]);

  const dismissGroup = (key: string) => setDismissedGroups((prev) => new Set(prev).add(key));

  // Summary scoped to the active date range so the To-do/Booked counts (and the
  // figures strip) reflect only what's in view — pre-January rows you've excluded
  // via the date filter don't inflate the "left to review" count.
  const rangeSummary = useMemo(() => {
    let total = 0, reviewed = 0, sumIn = 0, sumOut = 0, unclassified = 0, needsDeal = 0;
    for (const t of txns) {
      const d = (t.posted_at || "").slice(0, 10);
      if (fromDate && d < fromDate) continue;
      if (toDate && d > toDate) continue;
      total++;
      if (t.reviewed) reviewed++;
      // Money-in/out excludes internal transfers (they hit both sides) and card
      // payments (the same spend already counted as the card purchase) so the
      // totals reflect real external cash movement, not double counts.
      const cat = t.category || "";
      if (cat !== "internal_transfer" && cat !== "card_payment") {
        if (t.direction === "in") sumIn += t.amount; else sumOut += t.amount;
      }
      if (!(t.category || "").trim()) unclassified++;
      // "Needs a deal" = still in the review queue (reviewed=0) with money to tie
      // out. Booking a row as an expense marks it reviewed, so it clears the flag —
      // the counter can now actually reach zero instead of counting every expense.
      // Keep this in step with the backend: bank_txn_summary.unallocated_in and
      // financials_overview.stale_unallocated use the same exclusions. Three
      // different definitions of "needs a deal" is why the tab count and the
      // summary figure never matched.
      if (
        !t.reviewed &&
        t.counterparty_type !== "loan" &&
        !["internal_transfer", "loan_received", "loan_repayment"].includes(t.category || "") &&
        t.unallocated > 0.0001
      ) needsDeal++;
    }
    return { total, reviewed, sumIn, sumOut, unclassified, needsDeal };
  }, [txns, fromDate, toDate]);

  // ── To book — the daily queue ────────────────────────────────────────────────
  // Every unbooked transaction, org-wide, newest first. Search and account narrow
  // it; nothing else hides rows.
  const toBookRows = useMemo(
    () => txns
      .filter((t) => !t.reviewed &&
        (toBookAcct === "all" || t.account_id === toBookAcct) &&
        matchesQuery(t, toBookSearch))
      .sort((a, b) => (b.posted_at || "").localeCompare(a.posted_at || "")),
    [txns, toBookAcct, toBookSearch],
  );

  // Headline figures: rows waiting, and money still needing a deal — the same
  // definition as rangeSummary.needsDeal (kept in step with bank_txn_summary and
  // financials_overview.stale_unallocated), with no date window.
  const toBookStats = useMemo(() => {
    let count = 0, needsDealAmt = 0;
    for (const t of txns) {
      if (t.reviewed) continue;
      count++;
      if (
        t.counterparty_type !== "loan" &&
        !["internal_transfer", "loan_received", "loan_repayment"].includes(t.category || "") &&
        t.unallocated > 0.0001
      ) needsDealAmt += t.unallocated;
    }
    return { count, needsDealAmt };
  }, [txns]);

  // Rows grouped by posted day, newest day first (toBookRows is already sorted).
  const toBookGroups = useMemo(() => {
    const groups: { date: string; rows: BankTxn[] }[] = [];
    for (const t of toBookRows) {
      const d = (t.posted_at || "").slice(0, 10);
      const g = groups[groups.length - 1];
      if (g && g.date === d) g.rows.push(t); else groups.push({ date: d, rows: [t] });
    }
    return groups;
  }, [toBookRows]);

  // What was accomplished this month — the caught-up state should read like an
  // achievement, not a shrug.
  const monthBooked = useMemo(() => {
    const now = new Date();
    const pfx = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let amt = 0, n = 0;
    for (const t of txns) {
      if (!(t.posted_at || "").startsWith(pfx)) continue;
      if (t.allocated > 0.0001) { amt += t.allocated; n++; }
    }
    return { amt, n };
  }, [txns]);

  // Local-constructed date (never `new Date("YYYY-MM-DD")` — that parses as UTC
  // and renders a day early in Central time).
  const localDay = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const dayHeading = (iso: string) => {
    if (!iso) return "No date";
    if (iso === localDay(new Date())) return "Today";
    if (iso === localDay(new Date(Date.now() - 86400000))) return "Yesterday";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: y === new Date().getFullYear() ? undefined : "numeric" });
  };

  // The left rail carries state: solid accent = needs a deal, faded = partly
  // tied, none = nothing owed. That is what colour is for on this screen.
  const railClass = (t: BankTxn) => {
    if (t.counterparty_type === "loan") return "border-l-2 border-transparent";
    if (t.allocated > 0.0001 && t.unallocated > 0.0001) return "border-l-2 border-accent/40";
    if (
      t.unallocated > 0.0001 &&
      !["internal_transfer", "loan_received", "loan_repayment"].includes(t.category || "")
    ) return "border-l-2 border-accent";
    return "border-l-2 border-transparent";
  };

  // The subline says what the row NEEDS, not what it is.
  const needsLine = (t: BankTxn) => {
    const acct = t.account_id ? ` · ${t.account_id}` : "";
    if (t.counterparty_type === "loan") return `${loanTagLabel(t.direction)}${acct}`;
    if (t.allocated > 0.0001 && t.unallocated > 0.0001)
      return `${fmtAmount(t.allocated)} of ${fmtAmount(t.amount)} tied${acct}`;
    if (t.allocated > 0.0001) return `Tied to a deal — book it${acct}`;
    const noCat = !(t.category || "").trim();
    const needsDeal =
      !["internal_transfer", "loan_received", "loan_repayment"].includes(t.category || "") &&
      t.unallocated > 0.0001;
    if (needsDeal && noCat) return `Needs a deal or a category${acct}`;
    if (needsDeal) return `${catLabel(t.category || "")} — needs a deal${acct}`;
    if (noCat) return `Needs a category${acct}`;
    return `${catLabel(t.category || "")} — ready to book${acct}`;
  };

  // Reset every Ledger filter in one click — the filtered-to-nothing state used
  // to be a grey line with no exit.
  const clearFilters = () => {
    setSearch(""); setSearchIn(""); setSearchOut("");
    setDirFilter("all"); setAcctFilter("all"); setCatFilter("all"); setStatusFilter("all");
    setQueue("all");
    setFromDate(`${new Date().getFullYear()}-01-01`); setToDate("");
  };

  const filteredDeals = useMemo(() => {
    const q = dealQuery.trim().toLowerCase();
    const ot = openId ? txns.find((t) => t.id === openId) : null;
    const cp = (ot?.counterparty_name || "").trim().toLowerCase();
    const amt = ot?.amount || 0;
    return survivorDeals(deals)
      .filter((d) => !q || `${d.client_name || ""} ${d.name || ""} ${d.invoice_number || ""}`.toLowerCase().includes(q))
      .map((d) => {
        // Rank deals that match the open transaction (same buyer / same amount) to
        // the top so the right deal is one glance away.
        let score = 0;
        if (cp.length > 2 && (d.client_name || "").toLowerCase().includes(cp)) score += 100;
        if (amt && d.invoice_total && Math.abs(d.invoice_total - amt) < 0.5) score += 60;
        const when = Date.parse(d.completed_at || d.created_at || "") || 0;
        return { d, score, when };
      })
      .sort((a, b) => b.score - a.score || b.when - a.when)
      .slice(0, 20)
      .map((x) => x.d);
  }, [deals, dealQuery, openId, txns]);

  // txn id → the single obvious deal for it, if there is one. Computed once per data
  // change (not per row render) and shared by every table instance.
  const confidentMatches = useMemo(() => {
    const pool = survivorDeals(deals);
    const m = new Map<string, { deal: DealFlow; reason: string }>();
    for (const t of txns) {
      const c = confidentMatch(t, pool);
      if (c) m.set(t.id, c);
    }
    return m;
  }, [txns, deals]);

  const filteredLoans = useMemo(() => {
    const q = loanQuery.toLowerCase();
    return loans
      .filter((l) => `${l.name || ""} ${l.lender || ""}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [loans, loanQuery]);

  // Deal column — quiet allocation state only. A confident match is no longer
  // announced here: it renders as the chip under the payee, which names the deal and
  // carries the one-click "Tie it". A bare accent "match" in this cell said less, had
  // no action attached, and read as a typo rather than an affordance.
  const dealCell = (t: BankTxn) => {
    if (t.counterparty_type === "loan") return <span className="text-muted">—</span>;
    if (t.allocated > 0.0001 && t.unallocated <= 0.0001) return <span className="text-muted">Linked</span>;
    if (t.allocated > 0.0001)
      return <span className="text-muted tabular-nums">{fmtAmount(t.allocated)} of {fmtAmount(t.amount)}</span>;
    return <span className="text-muted">Link a deal</span>;
  };

  const openTxn = openId ? txns.find((t) => t.id === openId) ?? null : null;

  // One transaction table for a given row set — reused by the combined list, each
  // split pane, and the "needs a category" collapse. Selection and the inline
  // allocation panel behave identically in every instance (openId is global, so
  // only one row is ever expanded at a time).
  const renderTxnTable = (rows: BankTxn[]) => (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[560px]">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="py-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all shown transactions"
                    checked={rows.length > 0 && rows.every((t) => selected.has(t.id))}
                    ref={(el) => {
                      if (el) el.indeterminate =
                        rows.some((t) => selected.has(t.id)) && !rows.every((t) => selected.has(t.id));
                    }}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) rows.forEach((t) => next.add(t.id));
                        else rows.forEach((t) => next.delete(t.id));
                        return next;
                      })
                    }
                    className="align-middle accent-accent"
                  />
                </th>
                <th className="w-7" aria-label="Direction" />
                <th className="text-[11px] font-medium text-muted py-2 pr-3 whitespace-nowrap">Date</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Payee</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Category</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3 text-right whitespace-nowrap">Amount</th>
                <th className="text-[11px] font-medium text-muted py-2 pr-3">Deal</th>
                <th className="text-[11px] font-medium text-muted py-2 text-center whitespace-nowrap w-12">Book</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const payee = t.counterparty_name?.trim();
                const mainLabel = payee || t.description || "—";
                const memo = payee ? t.description : "";
                // The obvious-deal suggestion. Hidden while the row is expanded — the
                // full allocate panel is already open there.
                const cm = openId === t.id ? null : confidentMatches.get(t.id) ?? null;
                return (
                <Fragment key={t.id}>
                  <tr
                    data-txn-id={t.id}
                    onClick={() => toggleRow(t)}
                    className={`${cm ? "" : "border-b border-line-2"} cursor-pointer transition-colors ${
                      selected.has(t.id) || openId === t.id ? "bg-surface-2" : "hover:bg-surface-2"
                    }`}
                  >
                    <td className="py-3 pr-2 align-top" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Select transaction"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        className="align-middle accent-accent"
                      />
                    </td>
                    <td className="py-3 align-top">
                      {t.direction === "in"
                        ? <ArrowDownLeft size={15} className="text-success-ink" strokeWidth={2} />
                        : <ArrowUpRight size={15} className="text-danger-ink" strokeWidth={2} />}
                    </td>
                    <td className="py-3 pr-3 tabular-nums text-muted whitespace-nowrap align-top">
                      <div>{(t.posted_at || "").slice(0, 10)}</div>
                      {fmtTime(t.posted_dt) && <div className="text-[10px] text-faint">{fmtTime(t.posted_dt)}</div>}
                    </td>
                    <td
                      className="py-3 pr-3 align-top max-w-[300px]"
                      onClick={(e) => { if (payeeEditId === t.id) e.stopPropagation(); }}
                    >
                      {payeeEditId === t.id ? (
                        <input
                          autoFocus
                          value={payeeDraft}
                          aria-label="Payee name"
                          onChange={(e) => setPayeeDraft(e.target.value)}
                          onBlur={(e) => commitPayeeEdit(t, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                            else if (e.key === "Escape") { e.preventDefault(); payeeCancelRef.current = true; e.currentTarget.blur(); }
                          }}
                          className="w-full min-w-0 bg-surface border border-line rounded px-1.5 py-0.5 text-[13px] font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-semibold text-ink truncate" title={mainLabel}>{mainLabel}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPayeeDraft(payee || t.description || "");
                              setPayeeEditId(t.id);
                            }}
                            title="Rename payee"
                            aria-label="Rename payee"
                            className="text-faint hover:text-ink-2 flex-shrink-0 transition-colors"
                          >
                            <Pencil size={12} />
                          </button>
                        </div>
                      )}
                      {memo && <div className="text-[11px] text-faint truncate" title={memo}>{memo}</div>}
                    </td>
                    <td className="py-3 pr-3 align-top" onClick={(e) => e.stopPropagation()}>
                      {t.counterparty_type === "loan" ? (
                        <span className="text-[12px] text-ink-2 whitespace-nowrap">{loanTagLabel(t.direction)}</span>
                      ) : (
                        <span className="relative inline-flex items-center">
                          <select
                            value={t.category || ""}
                            aria-label="Category"
                            onChange={(e) => saveReview(t, { category: e.target.value })}
                            className={`appearance-none h-7 pl-2 pr-6 rounded-md border text-[12px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors ${
                              t.category
                                ? "bg-transparent border-line text-ink-2 hover:border-line-3"
                                : "bg-accent/5 border-accent/40 text-accent font-semibold hover:bg-accent/10"
                            }`}
                          >
                            <option value="">Set category</option>
                            <CategoryOptions includeUncat={false} />
                          </select>
                          <ChevronDown
                            size={12}
                            className={`pointer-events-none absolute right-1.5 ${t.category ? "text-faint" : "text-accent"}`}
                          />
                        </span>
                      )}
                    </td>
                    <td className={`py-3 pr-3 text-right tabular-nums whitespace-nowrap align-top font-medium ${t.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
                      {t.direction === "in" ? "+" : "−"}{fmtAmount(t.amount)}
                    </td>
                    <td className="py-3 pr-3 text-[12px] whitespace-nowrap align-top">{dealCell(t)}</td>
                    <td className="py-3 text-center align-top" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => saveReview(t, { reviewed: !t.reviewed })}
                        title={t.reviewed ? "Booked — click to reopen" : "Mark this transaction booked"}
                        className={`h-7 px-2.5 rounded-md inline-flex items-center gap-1 justify-center border text-[11.5px] font-semibold transition-colors whitespace-nowrap ${
                          t.reviewed
                            ? "bg-ink border-ink text-surface"
                            : "border-accent/40 bg-accent/5 text-accent hover:bg-accent/10"
                        }`}
                      >
                        <Check size={11} strokeWidth={2.4} /> {t.reviewed ? "Booked" : "Book"}
                      </button>
                    </td>
                  </tr>

                  {cm && (
                    <tr className={`border-b border-line-2 ${selected.has(t.id) ? "bg-surface-2" : ""}`}>
                      <td colSpan={3} />
                      <td colSpan={5} className="pb-3 pr-3 align-top">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span className="text-[11.5px] text-muted min-w-0">
                            Looks like <span className="text-ink-2 font-medium">{matchLabel(cm.deal)}</span> — {cm.reason}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); tieMatch(t, cm.deal); }}
                            disabled={tyingId === t.id}
                            title={`Tie the full ${fmtAmount(t.unallocated)} to ${dealLabel(cm.deal)} as ${t.direction === "out" ? "a supplier payment" : "a buyer payment"}`}
                            className="flex items-center gap-1 h-6 px-2 rounded-md border border-accent/40 bg-accent/5 text-accent text-[11.5px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors flex-shrink-0"
                          >
                            {tyingId === t.id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />} Tie it
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="text-center py-10 text-[12px] text-muted">
              No transactions match these filters
              <button
                onClick={clearFilters}
                className="block mx-auto mt-2 text-[12px] font-medium text-accent hover:text-accent-hover"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
  );

  // Loading placeholder at roughly row height, so the page stops jumping.
  const skeletonRows = (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-[52px] rounded-lg bg-surface-2 animate-pulse" />
      ))}
    </div>
  );

  // A load failure must never render as an empty ledger — that reads as data
  // loss and hides the real cause. Shared by the To-book and Ledger surfaces.
  const errorState = (
    <div className="text-center py-20">
      <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
        <AlertTriangle size={18} className="text-danger-ink" />
      </div>
      <p className="text-[14px] font-semibold text-ink-2">Could not load your transactions</p>
      <p className="text-[12px] text-muted mt-1 max-w-[420px] mx-auto break-words">{loadError}</p>
      <p className="text-[11.5px] text-faint mt-1">Nothing has been changed or lost — this is a read that failed.</p>
      <button
        onClick={() => { setLoading(true); loadAll(); }}
        className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover"
      >
        Try again
      </button>
    </div>
  );

  // First run: the right door is the bank feed, not a statement upload.
  const firstRunState = (
    <div className="text-center py-20">
      <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
        <Landmark size={18} className="text-faint" />
      </div>
      <p className="text-[14px] font-semibold text-ink-2">No transactions yet</p>
      <p className="text-[12px] text-muted mt-1">
        {plaidItems.length > 0
          ? "Nothing has arrived from your bank yet"
          : "Connect your bank for a live feed, or import a statement"}
      </p>
      <button onClick={() => setTab("setup")} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
        {plaidItems.length > 0 ? "Open setup" : "Connect your bank"}
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="min-w-0 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold text-ink tracking-tight truncate">Financials</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {tab === "tobook" ? "Book the money that came in and went out"
              : tab === "ledger" ? "Everything ever — search, filter, drill in"
              : tab === "cash" ? "Free cash, reserves and loans"
              : "Bank connections, statement imports and cleanup tools"}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {plaidItems.length > 0 && (
            // Honest wording: the bank feed is pulled on a 20-minute timer by this
            // device (main.rs), not continuously. "Auto-syncing" read as live.
            <span className="text-[11.5px] text-muted whitespace-nowrap">Bank feed checked every 20 min</span>
          )}
          <button
            onClick={refreshScreen}
            disabled={refreshing}
            title="Re-read transactions, deals and loans"
            className="text-[12px] text-muted hover:text-ink-2 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* Surface nav — To book is the daily queue and opens first; its count is
          the one number that says whether there is work to do. */}
      <div className="flex items-center gap-5 border-b border-line">
        {([
          ["tobook", "To book"],
          ["ledger", "Ledger"],
          ["cash", "Cash"],
          ["setup", "Setup"],
        ] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`-mb-px pb-2 text-[13px] border-b-2 transition-colors ${
              tab === v ? "text-ink font-semibold border-ink" : "text-muted border-transparent hover:text-ink-2"
            }`}
          >
            {label}
            {v === "tobook" && toBookStats.count > 0 && (
              <span className="ml-1.5 font-normal text-muted tabular-nums">{toBookStats.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Cash — free cash and loans together; the best-designed screens stay as they are. */}
      {tab === "cash" && (
        <div className="space-y-4">
          <div className="flex items-center gap-1">
            {([["freecash", "Free cash"], ["loans", "Loans"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setCashTab(v)}
                className={`px-3 h-8 rounded-lg text-[12.5px] font-medium transition-colors ${
                  cashTab === v ? "bg-surface-2 text-ink border border-line" : "text-muted hover:text-ink-2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {cashTab === "freecash" ? <FreeCashView /> : <LoansView />}
        </div>
      )}

      {tab !== "cash" && (
      <div className="space-y-5">
      {/* To book — headline row: how much work waits, plus the daily controls. */}
      {tab === "tobook" && (
        <div className="min-w-0 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-[14px] text-ink min-w-0">
            <span className="font-semibold tabular-nums">
              {toBookStats.count === 0 ? "Nothing to book" : `${toBookStats.count} to book`}
            </span>
            {toBookStats.needsDealAmt > 0.005 && (
              <span className="text-muted"> · <span className="tabular-nums">{fmtAmount(toBookStats.needsDealAmt)}</span> waiting on a deal</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="flex items-center gap-1.5 min-w-[190px] bg-surface-2 border border-line rounded-lg px-2.5 h-9">
              <Search size={13} className="text-muted flex-shrink-0" />
              <input
                value={toBookSearch}
                onChange={(e) => setToBookSearch(e.target.value)}
                placeholder="Search payee, memo, exact amount…"
                className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
            {accounts.length > 1 && (
              <select
                value={toBookAcct}
                onChange={(e) => setToBookAcct(e.target.value)}
                className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-9 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="all">All accounts</option>
                {accounts.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => { setCashDate(new Date().toISOString().slice(0, 10)); setCashOpen(true); }}
              className="flex-shrink-0 flex items-center gap-1.5 px-4 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 transition-colors"
            >
              <Plus size={14} /> Record cash
            </button>
          </div>
        </div>
      )}

      {/* Setup — import + cleanup toolbar. The container stays mounted (as
          display:contents on other surfaces, so it adds no gap) because the dedupe
          and record-cash modals live inside it and must open from any surface. */}
      <div className={tab === "setup" ? "space-y-1.5" : "contents"}>
        {tab === "setup" && (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          {/* Duplicate cleanup lives here — the primary transactions toolbar — because the
              bank-feed panel it used to sit in collapses itself once a bank is connected. */}
          <button
            onClick={() => previewDedupe(false)}
            disabled={dedupeRunning || bulkBusy}
            title="Find transactions imported more than once (e.g. the same bank connected on two devices) and remove the extra copies."
            className="mr-auto flex items-center gap-1.5 px-3 h-9 border border-accent/40 bg-accent/5 text-accent rounded-lg text-[13px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors"
          >
            {dedupeRunning && !dedupe ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Clean up duplicates
          </button>
          <button
            onClick={clearStatementImports}
            disabled={clearing || bulkBusy}
            title="Delete transactions imported from statement files — keeps the live bank feed"
            className="flex items-center gap-1.5 px-3 h-9 border border-line text-muted rounded-lg text-[13px] font-medium hover:text-danger-ink hover:border-danger-ink/30 hover:bg-danger-bg disabled:opacity-50 transition-colors"
          >
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Remove statement imports
          </button>
          {(bulkProgress || aiProgress) && (
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {bulkProgress || aiProgress}
            </span>
          )}
          <button
            onClick={aiCategorize}
            disabled={aiBusy}
            className="flex items-center gap-1.5 px-3 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Auto-categorize with AI
          </button>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            Account
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="border border-line px-2.5 h-9 rounded-lg text-[13px] w-40 bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <button
            onClick={pickAndPreview}
            disabled={bulkBusy || previewing}
            className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {bulkBusy || previewing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import statement
          </button>
          <button
            onClick={pickAndPreviewAi}
            disabled={aiExtracting || bulkBusy}
            className="flex items-center gap-1.5 px-4 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {aiExtracting || bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Smart import (AI)
          </button>
        </div>
        )}

        {dedupe && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => !dedupeRunning && setDedupe(null)}>
            <div className="bg-surface border border-line rounded-2xl w-full max-w-lg max-h-[82vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-line flex items-center justify-between">
                <div className="text-[15px] font-semibold text-ink">{dedupeDone ? "Duplicates cleaned up" : "Clean up duplicate transactions"}</div>
                <button onClick={() => setDedupe(null)} disabled={dedupeRunning} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 disabled:opacity-40"><X size={16} /></button>
              </div>

              <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
                {dedupeDone ? (
                  <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success-bg/50 px-4 py-3">
                    <Check size={18} className="text-success-ink mt-0.5 shrink-0" />
                    <div className="text-[13px] text-ink-2 leading-relaxed">
                      Removed <span className="font-semibold text-ink">{dedupe.removed || 0}</span> duplicate transaction{(dedupe.removed || 0) === 1 ? "" : "s"}.
                      {(dedupe.skipped_now_referenced || 0) > 0 && <> {dedupe.skipped_now_referenced} were skipped because they became linked to a deal while cleaning.</>}
                      {" "}A copy of everything removed is kept locally, so nothing is truly lost.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                        <div className="text-[11px] text-muted">Total</div>
                        <div className="text-[18px] font-semibold text-ink tabular-nums">{dedupe.total_transactions ?? "—"}</div>
                      </div>
                      <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5">
                        <div className="text-[11px] text-muted">Auto-remove</div>
                        <div className="text-[18px] font-semibold text-accent tabular-nums">{dedupe.auto_remove ?? 0}</div>
                      </div>
                      <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
                        <div className="text-[11px] text-muted">To review</div>
                        <div className="text-[18px] font-semibold text-ink tabular-nums">{dedupe.review_count}</div>
                      </div>
                    </div>

                    {/* Same card linked twice under two masks — the reason already-booked
                        transactions kept re-appearing as "needs booking". */}
                    {(dedupe.account_merges?.length || 0) > 0 && (
                      <div className="rounded-xl border border-accent/40 bg-accent/5 px-3.5 py-3">
                        <div className="text-[12.5px] font-semibold text-ink flex items-center gap-1.5">
                          <Landmark size={14} className="text-accent" /> Same account connected twice
                        </div>
                        <p className="text-[11.5px] text-muted leading-relaxed mt-1">
                          These look like one account that got connected twice (the bank returned a different last-4 each time), which is why transactions you already booked keep coming back unbooked. They'll be combined into one account, keeping your reviewed ones.
                        </p>
                        <div className="mt-2 space-y-1">
                          {dedupe.account_merges!.map((m, i) => (
                            <div key={i} className="text-[11.5px] text-ink-2 tabular-nums">
                              <span className="text-muted">{m.from}</span> <span className="text-faint">→</span> <span className="font-medium">{m.to}</span> <span className="text-muted">({m.rows} moved)</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mode: clearly-safe only, or every exact match (same date/amount/memo). */}
                    <div className="flex items-center gap-1 p-1 rounded-xl border border-line bg-surface-2/40">
                      <button onClick={() => previewDedupe(false)} disabled={dedupeRunning}
                        className={`flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors ${!dedupeAggressive ? "bg-surface text-ink shadow-sm border border-line" : "text-muted hover:text-ink-2"}`}>
                        Only clearly-safe
                      </button>
                      <button onClick={() => previewDedupe(true)} disabled={dedupeRunning}
                        className={`flex-1 h-8 rounded-lg text-[12px] font-medium transition-colors ${dedupeAggressive ? "bg-surface text-ink shadow-sm border border-line" : "text-muted hover:text-ink-2"}`}>
                        Every exact match
                      </button>
                    </div>
                    <p className="text-[12px] text-muted leading-relaxed">
                      {dedupeAggressive
                        ? "Removes every extra copy that matches on date, amount, direction and description — including round amounts and generic memos. Anything reviewed or linked to a deal, loan or refund is still never touched, and every removed row is backed up. Run this from one device."
                        : "Removes only the clearly-safe extra copies. Round amounts and generic memos (like ATM / cash / transfer) are left for you below — switch to “Every exact match” to remove those too. Anything reviewed or linked to a deal is never touched. Run this from one device."}
                    </p>
                    {(dedupe.sample?.length || 0) > 0 && (
                      <div>
                        <div className="text-[12px] font-medium text-muted mb-1.5">Will remove (sample)</div>
                        <div className="rounded-xl border border-line divide-y divide-line max-h-40 overflow-y-auto">
                          {dedupe.sample!.map((g, i) => (
                            <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                              <div className="min-w-0">
                                <div className="text-ink-2 truncate">{g.description || "(no memo)"}</div>
                                <div className="text-muted text-[11px]">{g.date} · {g.account}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {g.cross_account && <span className="text-[10px] text-accent bg-accent/10 border border-accent/30 rounded px-1.5 py-0.5">merged acct</span>}
                                <span className={`tabular-nums font-medium ${g.direction === "in" ? "text-success-ink" : "text-ink-2"}`}>{g.direction === "in" ? "+" : "−"}${g.amount.toFixed(2)}</span>
                                <span className="text-[10px] text-muted bg-surface-2 border border-line rounded px-1.5 py-0.5">−{(g.remove?.length || 1)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {dedupe.review.length > 0 && (
                  <div>
                    <div className="text-[12px] font-medium text-warning-ink mb-1.5">Needs your review — not removed</div>
                    <div className="rounded-xl border border-warning/40 bg-warning-bg/30 divide-y divide-warning/20 max-h-48 overflow-y-auto">
                      {dedupe.review.slice(0, 60).map((g, i) => (
                        <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                          <div className="min-w-0">
                            <div className="text-ink-2 truncate">{g.description || "(no memo)"}</div>
                            <div className="text-muted text-[11px]">{g.date} · {g.account} · {g.count ?? 2} copies · {g.reason}</div>
                          </div>
                          <span className={`tabular-nums font-medium shrink-0 ${g.direction === "in" ? "text-success-ink" : "text-ink-2"}`}>{g.direction === "in" ? "+" : "−"}${g.amount.toFixed(2)}</span>
                        </div>
                      ))}
                      {dedupe.review.length > 60 && <div className="px-3 py-2 text-[11px] text-muted">+ {dedupe.review.length - 60} more…</div>}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
                {dedupeDone ? (
                  <button onClick={() => setDedupe(null)} className="h-9 px-4 rounded-lg text-[13px] font-medium bg-accent text-on-accent hover:bg-accent-hover transition-colors">Done</button>
                ) : (
                  <>
                    <button onClick={() => setDedupe(null)} disabled={dedupeRunning} className="h-9 px-4 rounded-lg text-[13px] font-medium border border-line text-ink-2 hover:bg-surface-2 disabled:opacity-40 transition-colors">Cancel</button>
                    <button onClick={executeDedupe} disabled={dedupeRunning || (dedupe.auto_remove || 0) === 0}
                      className="flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-40 transition-colors">
                      {dedupeRunning ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Remove {dedupe.auto_remove || 0} duplicate{(dedupe.auto_remove || 0) === 1 ? "" : "s"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {cashOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCashOpen(false)}>
            <div className="bg-surface border border-line rounded-2xl w-full max-w-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-line flex items-center justify-between">
                <div className="text-[15px] font-semibold text-ink">Record a cash transaction</div>
                <button onClick={() => setCashOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2"><X size={16} /></button>
              </div>
              <div className="px-5 py-4 flex flex-col gap-3">
                <div className="flex gap-2">
                  <button onClick={() => setCashDir("in")} className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${cashDir === "in" ? "bg-success-bg border-success text-success-ink" : "border-line text-muted hover:bg-surface-2"}`}>Cash received</button>
                  <button onClick={() => setCashDir("out")} className={`flex-1 h-9 rounded-lg text-[13px] font-medium border transition-colors ${cashDir === "out" ? "bg-warning-bg border-warning text-warning-ink" : "border-line text-muted hover:bg-surface-2"}`}>Cash paid out</button>
                </div>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Amount</span>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[13px]">$</span>
                    <input inputMode="decimal" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} placeholder="0"
                      className="w-full bg-surface-2 border border-line rounded-lg h-9 pl-6 pr-2.5 text-[13.5px] text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-accent/40" />
                  </div>
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Date</span>
                  <input type="date" value={cashDate} onChange={(e) => setCashDate(e.target.value)}
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Who (optional)</span>
                  <input value={cashCp} onChange={(e) => setCashCp(e.target.value)} placeholder="Buyer / supplier name"
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <label className="block">
                  <span className="block text-[12px] font-medium text-ink-2 mb-1">Note (optional)</span>
                  <input value={cashNote} onChange={(e) => setCashNote(e.target.value)} placeholder="e.g. cash pickup"
                    className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                </label>
                <p className="text-[11px] text-muted">Saved as a cash transaction — then allocate it across deals below. It tracks how much is left of the original.</p>
              </div>
              <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
                <button onClick={() => setCashOpen(false)} className="px-4 h-9 rounded-lg border border-line text-[13px] text-ink-2 hover:bg-surface-2">Cancel</button>
                <button onClick={recordCash} disabled={cashSaving} className="px-5 h-9 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[13px] font-medium disabled:opacity-50">
                  {cashSaving ? "Saving…" : "Record"}
                </button>
              </div>
            </div>
          </div>
        )}
        {tab === "setup" && (
        <p className="text-[11px] text-muted text-right leading-relaxed">
          Smart import reads any statement with AI — for credit cards and other banks. Set a distinct account per card
          (e.g. chase-card, amex) so each groups and dedupes separately. Selecting several files imports them all to the
          Account above, so import one account's statements together.
        </p>
        )}
      </div>

      {/* Bank feed (Plaid) — live transactions straight from the bank */}
      {tab === "setup" && (
      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 size={15} className="text-muted flex-shrink-0" strokeWidth={1.8} />
          <div className="text-[13px] font-semibold text-ink">Bank feed (Plaid)</div>
          {plaidItems.length > 0 && (
            <>
              <span className="text-[12px] text-muted tabular-nums">· {plaidItems.length} connected</span>
              <div className="ml-auto flex items-center gap-2">
                {!bankFeedOpen && (
                  <button
                    onClick={() => syncPlaid("refresh")}
                    disabled={plaidSyncing}
                    title="Ask your bank for today's latest activity, then sync."
                    className="flex items-center gap-1.5 h-8 px-2.5 border border-line text-ink-2 rounded-lg text-[12px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
                  </button>
                )}
                <button
                  onClick={() => setBankFeedOpen((o) => !o)}
                  title={bankFeedOpen ? "Hide bank feed" : "Manage bank feed"}
                  className="text-muted hover:text-ink-2 transition-colors"
                >
                  <ChevronDown size={16} className={`transition-transform ${bankFeedOpen ? "rotate-180" : ""}`} />
                </button>
              </div>
            </>
          )}
        </div>
        {(plaidItems.length === 0 || bankFeedOpen) && (
          <>
        <p className="text-[11px] text-muted leading-relaxed">
          Plaid pulls clean transactions straight from the bank — no statement uploads. After connecting,
          transactions appear in the list below to review and allocate.
        </p>

        {plaidReady !== null && (
          <div className="border border-line-2 rounded-lg p-3.5 bg-surface-2/40">
            {plaidReady === true && !showKeys ? (
              <div className="flex items-center justify-between gap-2 min-w-0">
                {/* This reflects SAVED API KEYS only — not a linked bank, and not a
                    healthy feed. It used to read "Connected", which everyone took to
                    mean a bank was connected. The bank list below is the real state. */}
                <div className="flex items-center gap-1.5 text-[12px] text-ink-2 min-w-0">
                  <Check size={13} className={plaidItems.length > 0 ? "text-success-ink flex-shrink-0" : "text-muted flex-shrink-0"} />
                  <span className="truncate">
                    {plaidItems.length > 0
                      ? <>Bank connected · <span className="font-medium text-ink">{plaidItems.length} {plaidItems.length === 1 ? "bank" : "banks"}</span></>
                      : <>API keys saved · <span className="font-medium text-ink">no bank linked yet</span></>}
                    <span className="text-faint"> · {plaidEnv === "sandbox" ? "Sandbox" : "Production"}</span>
                  </span>
                </div>
                <button
                  onClick={() => setShowKeys(true)}
                  className="text-[11px] text-muted hover:text-ink-2 flex-shrink-0"
                >
                  Manage keys
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-0">
                  <label className="block min-w-0 sm:col-span-2">
                    <span className="block text-[11px] text-muted mb-1">Environment</span>
                    <select
                      value={plaidEnv}
                      onChange={(e) => setPlaidEnv(e.target.value as "sandbox" | "production")}
                      className={`${inp} text-ink-2`}
                    >
                      <option value="sandbox">Sandbox (test)</option>
                      <option value="production">Production (real data)</option>
                    </select>
                  </label>
                  <label className="block min-w-0">
                    <span className="block text-[11px] text-muted mb-1">Client ID</span>
                    <input
                      value={plaidClientId}
                      onChange={(e) => setPlaidClientId(e.target.value)}
                      placeholder="Plaid client ID"
                      className={inp}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="block text-[11px] text-muted mb-1">Secret</span>
                    <input
                      type="password"
                      value={plaidSecret}
                      onChange={(e) => setPlaidSecret(e.target.value)}
                      placeholder={plaidReady ? "Enter secret to update" : "Plaid secret"}
                      className={inp}
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  Each environment has its own secret. Start in Sandbox to test the flow instantly — in the connect popup,
                  log in with username <span className="font-medium text-ink-2">user_good</span> and password{" "}
                  <span className="font-medium text-ink-2">pass_good</span>. Switch to Production with your production secret
                  for real accounts once your Plaid OAuth is approved. Stored only on this device.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={savePlaidKeys}
                    disabled={plaidSavingKeys}
                    className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    {plaidSavingKeys ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save keys
                  </button>
                  {plaidReady === true && (
                    <button
                      onClick={testPlaidKeys}
                      disabled={plaidTesting}
                      className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                    >
                      {plaidTesting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Test connection
                    </button>
                  )}
                  {plaidReady === true && (
                    <button onClick={() => setShowKeys(false)} className="text-[11px] text-muted hover:text-ink-2 ml-auto">
                      Done
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {plaidReady === true && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={connectBank}
                disabled={plaidConnecting}
                className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {plaidConnecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Connect a bank
              </button>
              {plaidItems.length > 0 && (
                <>
                  <button
                    onClick={() => syncPlaid("refresh")}
                    disabled={plaidSyncing}
                    title="Ask your bank for the very latest activity — today's wires and spending — then sync. Use this when something you just did isn't showing yet."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={14} className="animate-spin" /> : <Building2 size={14} />} Refresh from bank
                  </button>
                  <button
                    onClick={() => syncPlaid()}
                    disabled={plaidSyncing}
                    title="Pull the latest transactions Plaid has already fetched."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    {plaidSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
                  </button>
                  <button
                    onClick={() => syncPlaid("full")}
                    disabled={plaidSyncing}
                    title="Reset each bank's sync position and re-pull all transactions from the start — use if transactions are missing."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                  >
                    Re-pull all
                  </button>
                  <button
                    onClick={clearAndRepull}
                    disabled={plaidSyncing}
                    title="Delete every bank transaction (and its tags/allocations) and re-pull fresh — use after removing a wrong account."
                    className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted rounded-lg text-[13px] font-medium hover:text-danger-ink hover:border-danger-ink/30 hover:bg-danger-bg disabled:opacity-50 transition-colors"
                  >
                    <Trash2 size={14} /> Clear all & re-pull
                  </button>
                </>
              )}
            </div>

            <p className="text-[11px] text-muted leading-relaxed">
              Connecting opens Plaid in your browser (that's where bank logins work). Finish there, then come back — it
              syncs automatically.{plaidEnv === "sandbox" && (
                <> Sandbox test login: <span className="font-medium text-ink-2">user_good</span> /{" "}
                <span className="font-medium text-ink-2">pass_good</span>.</>
              )}
            </p>

            {/* Safety backup — an independent, append-only copy of every bank transaction in
                a Google Sheet you own, so you always have a readable record outside the app. */}
            <div className="rounded-xl border border-line bg-surface-2/30 p-3.5 space-y-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink flex items-center gap-1.5"><ShieldCheck size={14} className="text-success-ink" /> Backup to Google Sheet</div>
                  <p className="text-[11px] text-muted leading-relaxed mt-0.5">
                    Keeps an append-only copy of every transaction in a sheet you own — a record that stays even if a transaction is removed here. Uses your connected Google account.
                  </p>
                </div>
                <button
                  onClick={runBackupNow}
                  disabled={backupBusy || !backupUrl.trim()}
                  title={backupUrl.trim() ? "Append any new transactions to the sheet now" : "Add your Google Sheet link first"}
                  className="flex items-center gap-1.5 h-9 px-3 shrink-0 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  {backupBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Back up now
                </button>
              </div>
              <input
                value={backupUrl}
                onChange={(e) => setBackupUrl(e.target.value)}
                onBlur={() => saveBackupSettings(backupUrl, backupEnabled)}
                placeholder="Paste a Google Sheet link (e.g. https://docs.google.com/spreadsheets/d/…)"
                className={inp}
              />
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer">
                  <input type="checkbox" checked={backupEnabled} onChange={(e) => saveBackupSettings(backupUrl, e.target.checked)} className="accent-[var(--accent)]" />
                  Automatically back up after each sync
                </label>
                {backupLast.at && (
                  <span className="text-[11px] text-muted">Last backed up {fmtShortDate(backupLast.at)}{backupLast.total ? ` · ${backupLast.total} transactions` : ""}</span>
                )}
              </div>
            </div>

            {plaidConnecting && (
              <div className="flex items-center gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <Loader2 size={15} className="animate-spin text-accent flex-shrink-0" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0">
                  Finish connecting your bank in the browser window that just opened, then come back here — it syncs
                  automatically.
                </p>
                <button
                  onClick={cancelConnect}
                  className="flex-shrink-0 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {plaidPreparing && !plaidConnecting && (
              <div className="flex items-center gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <Loader2 size={15} className="animate-spin text-accent flex-shrink-0" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0">
                  Plaid is preparing your transactions — this can take a minute. They'll appear here automatically, or
                  use Sync now to check again.
                </p>
              </div>
            )}

            {/* Is the pending→posted carry-forward actually armed? It relies on Plaid
                sending pending_transaction_id; if a sync imports rows and none carry
                it, the carry is inert for these banks. Bookings are still never
                destroyed either way — a retraction now keeps the row. */}
            {pendingRefSeen === "no" && (
              <div className="flex items-start gap-2.5 border border-line-2 rounded-lg px-3.5 py-3 bg-surface-2/40 min-w-0">
                <AlertTriangle size={15} className="text-warning-ink flex-shrink-0 mt-0.5" />
                <p className="text-[12px] text-ink-2 flex-1 min-w-0 leading-relaxed">
                  Your bank isn't telling us which pending transaction each posted one replaces, so bookings can't be
                  carried over automatically when something settles. Nothing gets deleted — you'll be told instead, and
                  can move the booking yourself.
                </p>
              </div>
            )}

            {plaidItems.length > 0 && (
              <div className="border border-line-2 rounded-lg divide-y divide-line-2 overflow-hidden">
                {plaidItems.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 px-3 py-2 min-w-0">
                    <Landmark size={14} className="text-muted flex-shrink-0" strokeWidth={1.8} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-ink truncate">{it.institution}</div>
                      <div className="text-[11px] text-muted tabular-nums">
                        {it.account_count} account{it.account_count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <button
                      onClick={() => disconnectBank(it)}
                      className="flex-shrink-0 h-8 px-2.5 rounded-md text-[12px] text-muted hover:text-danger-ink hover:bg-danger-bg transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
      )}

      {/* Import preview / confirm card */}
      {tab === "setup" && preview && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] text-ink">
              Detected <span className="font-semibold">{preview.format.toUpperCase()}</span> ·{" "}
              <span className="tabular-nums font-semibold">{preview.total}</span> transaction{preview.total !== 1 ? "s" : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doImport}
                disabled={importing}
                className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {importing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Import
              </button>
              <button
                onClick={() => { setPreview(null); setPreviewPath(null); }}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          {!preview.has_fitid && (
            <p className="text-[11px] text-muted leading-relaxed">
              This format has no transaction id — duplicates are caught by a fingerprint, so re-importing is safe but
              near-identical same-day rows could collide.
            </p>
          )}

          <div className="border border-line-2 rounded-lg overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-muted border-b border-line-2">
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                  <th className="font-medium px-3 py-2">Description</th>
                  <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {preview.sample.slice(0, 6).map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 tabular-nums text-muted whitespace-nowrap">{(r.posted_at || "").slice(0, 10)}</td>
                    <td className="px-3 py-2 text-ink-2 max-w-0 truncate"><span className="truncate block">{r.description}</span></td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${r.direction === "in" ? "text-success-ink" : "text-ink"}`}>
                      {fmtAmount(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AI import preview / confirm card */}
      {tab === "setup" && aiPreview && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] text-ink">
              Extracted <span className="tabular-nums font-semibold">{aiPreview.total}</span> transaction{aiPreview.total !== 1 ? "s" : ""}
              {aiPreview.ending_balance != null && (
                <span className="text-muted">
                  {" "}· statement ending balance{" "}
                  <span className="tabular-nums font-semibold text-ink-2">{fmtAmount(aiPreview.ending_balance)}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={doImportAi}
                disabled={aiImporting}
                className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
              >
                {aiImporting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Import
              </button>
              <button
                onClick={() => { setAiPreview(null); setAiPreviewPath(null); }}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="border border-line-2 rounded-lg overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-muted border-b border-line-2">
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                  <th className="font-medium px-3 py-2">Description</th>
                  <th className="font-medium px-3 py-2 whitespace-nowrap">Category</th>
                  <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {aiPreview.sample.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 tabular-nums text-muted whitespace-nowrap">{(r.date || "").slice(0, 10)}</td>
                    <td className="px-3 py-2 text-ink-2 max-w-0 truncate"><span className="truncate block">{r.description}</span></td>
                    <td className="px-3 py-2 text-muted whitespace-nowrap">{r.category || "—"}</td>
                    <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${r.direction === "in" ? "text-success-ink" : "text-ink"}`}>
                      {r.direction === "in" ? "+" : "-"}{fmtAmount(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Summary — a quiet figures strip, not stat cards */}
      {tab === "ledger" && txns.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] border-b border-line pb-3">
          <span className="text-muted">Transactions <span className="text-ink font-medium tabular-nums">{rangeSummary.total}</span></span>
          <span className="text-muted">Reviewed <span className="text-ink font-medium tabular-nums">{rangeSummary.reviewed}/{rangeSummary.total}</span></span>
          <span className="text-muted">Money in <span className="text-success-ink font-medium tabular-nums">{fmtAmount(rangeSummary.sumIn)}</span></span>
          <span className="text-muted">Money out <span className="text-danger-ink font-medium tabular-nums">{fmtAmount(rangeSummary.sumOut)}</span></span>
          <span className="text-muted">Uncategorized <span className={`font-medium tabular-nums ${rangeSummary.unclassified > 0 ? "text-ink" : "text-muted"}`}>{rangeSummary.unclassified}</span></span>
          <span className="text-muted">Needs a deal <span className={`font-medium tabular-nums ${rangeSummary.needsDeal > 0 ? "text-ink" : "text-muted"}`}>{rangeSummary.needsDeal}</span></span>
        </div>
      )}

      {/* Ledger toolbar — scope (left) + search & filters (right) */}
      {tab === "ledger" && (
      <div className="border-t border-b border-line flex items-center gap-x-5 gap-y-2 py-2.5 flex-wrap">
        <div className="flex items-center gap-5">
          {([["all", "All"], ["todo", "To book"], ["booked", "Booked"]] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setQueue(v)}
              className={`text-[13px] transition-colors ${queue === v ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
            >
              {label}
              <span className="ml-1.5 font-normal text-muted tabular-nums">
                {v === "all" ? rangeSummary.total : v === "todo" ? rangeSummary.total - rangeSummary.reviewed : rangeSummary.reviewed}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-x-4 gap-y-2 flex-wrap">
          {!splitView && (
            <div className="flex items-center gap-1.5 min-w-[190px] bg-surface-2 border border-line rounded-lg px-2.5 h-8">
              <Search size={13} className="text-muted flex-shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search payee, memo, exact amount…"
                className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
              />
            </div>
          )}
          {!splitView && (
            <div className="flex items-center gap-3">
              {(["all", "in", "out"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setDirFilter(f)}
                  className={`text-[12px] transition-colors ${dirFilter === f ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
                >
                  {f === "all" ? "All" : f === "in" ? "In" : "Out"}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setSplitView((v) => !v)}
            title="Show money in and money out side by side, each with its own search — for reconciling a refund."
            className={`text-[12px] transition-colors ${splitView ? "text-ink font-semibold" : "text-muted hover:text-ink-2"}`}
          >
            {splitView ? "Combined" : "Split in/out"}
          </button>
          {accounts.length > 0 && (
            <select
              value={acctFilter}
              onChange={(e) => setAcctFilter(e.target.value)}
              className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="all">All accounts</option>
              {accounts.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          )}
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All categories</option>
            <CategoryOptions />
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="bg-surface-2 border border-line text-[12px] text-ink-2 hover:border-line-3 rounded-lg px-2 h-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="all">All statuses</option>
            <option value="unclassified">Uncategorized</option>
            <option value="unallocated_in">Needs a deal (in)</option>
            <option value="unallocated_out">Needs a deal (out)</option>
          </select>
          <div className="flex items-center gap-1.5 text-[12px] text-muted bg-surface-2 border border-line rounded-lg px-2.5 h-8">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-transparent text-[12px] text-muted rounded focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:light] dark:[color-scheme:dark]"
            />
            <span>to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-transparent text-[12px] text-muted rounded focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:light] dark:[color-scheme:dark]"
            />
          </div>
        </div>
      </div>
      )}

      {/* Smart grouping suggestions — clear look-alike backlogs in one click */}
      {tab === "tobook" && suggestedGroups.length > 0 && (
        <div className="space-y-1">
          {/* Show a rolling few so the suggestions never bury the transaction list;
              clearing one surfaces the next. */}
          {suggestedGroups.slice(0, 3).map((g) => {
            const cat = groupCatOverride[g.key] ?? g.defaultCat;
            return (
              <div key={g.key} className="flex items-center gap-3 flex-wrap border border-line-2 rounded-lg px-2.5 py-1.5 text-[12px]">
                <span className="text-ink-2 min-w-0">
                  <span className="font-semibold text-ink tabular-nums">{g.count}</span> transactions from{" "}
                  <span className="font-semibold text-ink">{g.payee}</span>{" "}
                  <span className={g.direction === "in" ? "text-success-ink" : "text-danger-ink"}>
                    ({g.direction === "in" ? "money in" : "money out"})
                  </span>
                </span>
                <div className="ml-auto flex items-center gap-2.5">
                  <select
                    value={cat}
                    onChange={(e) => setGroupCatOverride((prev) => ({ ...prev, [g.key]: e.target.value }))}
                    className="h-7 px-2 rounded-md text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
                  >
                    <option value="">Set category…</option>
                    <CategoryOptions includeUncat={false} />
                  </select>
                  <button
                    onClick={async () => {
                      const c = groupCatOverride[g.key] ?? g.defaultCat;
                      if (!c) return;
                      // Only dismiss on success — otherwise a failed rule left the
                      // rows untagged AND hid the group so they couldn't be found.
                      if (await createRule(g.payee, c, "expense", "", g.direction)) dismissGroup(g.key);
                    }}
                    disabled={!cat}
                    className="text-[12px] font-medium text-accent hover:text-accent-hover disabled:text-faint disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    Tag all <span className="tabular-nums">{g.count}</span>
                  </button>
                  <button
                    onClick={() => dismissGroup(g.key)}
                    title="Dismiss"
                    className="text-muted hover:text-ink-2 transition-colors flex-shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk bar — a plain full-width row of text actions once rows are selected */}
      {(tab === "tobook" || tab === "ledger") && selected.size > 0 && (
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap border-b border-line py-2.5 text-[12.5px]">
          <span className="font-semibold text-ink whitespace-nowrap tabular-nums">{selected.size} selected</span>
          {bulkProgress && (
            <span className="flex items-center gap-1.5 text-muted">
              <Loader2 size={12} className="animate-spin" /> {bulkProgress}
            </span>
          )}
          <span className="text-faint">·</span>
          <div className="flex items-center gap-2">
            <select
              value={bulkCat}
              onChange={(e) => setBulkCat(e.target.value)}
              disabled={bulkActionBusy}
              className="h-8 px-2 rounded-md text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            >
              <option value="">Set category…</option>
              <CategoryOptions includeUncat={false} />
            </select>
            <button
              onClick={() => bulkCat && bulkSetCategory(bulkCat)}
              disabled={bulkActionBusy || !bulkCat}
              className="text-ink-2 hover:text-ink disabled:text-faint disabled:cursor-not-allowed transition-colors"
            >
              Apply
            </button>
          </div>
          <span className="text-faint">·</span>
          <button
            onClick={() => setBulkAllocOpen(true)}
            disabled={bulkActionBusy}
            className="text-ink-2 hover:text-ink disabled:opacity-50 transition-colors"
          >
            Tag all to a deal
          </button>
          <span className="text-faint">·</span>
          <button
            onClick={() => bulkSetReviewed(true)}
            disabled={bulkActionBusy}
            className="font-medium text-accent hover:text-accent-hover disabled:opacity-50 transition-colors"
          >
            Book
          </button>
          <button
            onClick={() => bulkSetReviewed(false)}
            disabled={bulkActionBusy}
            className="text-ink-2 hover:text-ink disabled:opacity-50 transition-colors"
          >
            Reopen
          </button>
          <span className="text-faint">·</span>
          <button
            onClick={bulkDelete}
            disabled={bulkActionBusy}
            title="Delete the selected transactions (booked ones are kept)"
            className="text-danger-ink hover:opacity-80 disabled:opacity-50 transition-opacity"
          >
            Delete
          </button>
          <button
            onClick={clearSelection}
            disabled={bulkActionBusy}
            className="ml-auto text-muted hover:text-ink-2 disabled:opacity-50 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* To book — the queue, grouped by day. Card rows: the left rail carries
          allocation state, the subline says what the row needs, and the obvious
          match is one click. */}
      {tab === "tobook" && (
        loading ? skeletonRows
        : loadError ? errorState
        : txns.length === 0 ? firstRunState
        : toBookRows.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
              <Check size={18} className="text-success-ink" />
            </div>
            <p className="text-[14px] font-semibold text-ink-2">
              {toBookSearch.trim() || toBookAcct !== "all" ? "Nothing here matches" : "You're all caught up"}
            </p>
            <p className="text-[12px] text-muted mt-1">
              {toBookSearch.trim() || toBookAcct !== "all"
                ? "No unbooked transactions match this search"
                : monthBooked.n > 0
                  ? `${fmtAmount(monthBooked.amt)} tied to deals this month across ${monthBooked.n} transaction${monthBooked.n === 1 ? "" : "s"}`
                  : "Every transaction is booked"}
            </p>
            {(toBookSearch.trim() !== "" || toBookAcct !== "all") && (
              <button
                onClick={() => { setToBookSearch(""); setToBookAcct("all"); }}
                className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {toBookGroups.map((g) => (
              <div key={g.date} className="bg-surface border border-line rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-surface-2/60 border-b border-line text-[11.5px] font-semibold text-ink-2">
                  {dayHeading(g.date)}
                </div>
                <div className="divide-y divide-line-2">
                  {g.rows.map((t) => {
                    const payee = t.counterparty_name?.trim();
                    const mainLabel = payee || t.description || "—";
                    const memo = payee ? t.description : "";
                    const cm = openId === t.id ? null : confidentMatches.get(t.id) ?? null;
                    const isLoan = t.counterparty_type === "loan";
                    return (
                      <div
                        key={t.id}
                        data-txn-id={t.id}
                        onClick={() => toggleRow(t)}
                        className={`${railClass(t)} pl-3 pr-3 py-3 cursor-pointer transition-colors ${
                          selected.has(t.id) || openId === t.id ? "bg-surface-2" : "hover:bg-surface-2"
                        }`}
                      >
                        {/* One booking row: everything needed to book lives HERE — the
                            category select, the deal action and a labeled Book button.
                            The drawer (row click) is for detail, never a requirement. */}
                        <div className="flex items-center gap-3 min-w-0 flex-wrap lg:flex-nowrap">
                          <input
                            type="checkbox"
                            aria-label="Select transaction"
                            checked={selected.has(t.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(t.id)}
                            className="align-middle accent-accent flex-shrink-0"
                          />
                          {t.direction === "in"
                            ? <ArrowDownLeft size={15} className="text-success-ink flex-shrink-0" strokeWidth={2} />
                            : <ArrowUpRight size={15} className="text-danger-ink flex-shrink-0" strokeWidth={2} />}
                          <div className="min-w-0 flex-1 basis-full lg:basis-auto order-1 lg:order-none">
                            <div className="text-[13px] font-semibold text-ink truncate" title={mainLabel}>{mainLabel}</div>
                            <div className="text-[11.5px] text-muted truncate">
                              {needsLine(t)}
                              {memo ? <span className="text-faint"> · {memo}</span> : null}
                            </div>
                          </div>
                          <div
                            className={`text-[13.5px] tabular-nums whitespace-nowrap font-semibold flex-shrink-0 lg:order-none ${
                              t.direction === "in" ? "text-success-ink" : "text-danger-ink"
                            }`}
                          >
                            {t.direction === "in" ? "+" : "−"}{fmtAmount(t.amount)}
                          </div>
                          {/* Category — a real, visible control on the row itself. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            {isLoan ? (
                              <span className="inline-flex items-center h-8 px-2.5 rounded-lg bg-surface-2 border border-line text-[12px] text-ink-2 whitespace-nowrap">
                                {loanTagLabel(t.direction)}
                              </span>
                            ) : (
                              <span className="relative inline-flex items-center">
                                <select
                                  value={t.category || ""}
                                  aria-label="Category"
                                  onChange={(e) => saveReview(t, { category: e.target.value })}
                                  className={`appearance-none h-8 pl-2.5 pr-7 rounded-lg border text-[12px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/40 transition-colors ${
                                    t.category
                                      ? "bg-surface border-line text-ink-2 hover:border-line-3"
                                      : "bg-accent/5 border-accent/40 text-accent font-semibold hover:bg-accent/10"
                                  }`}
                                >
                                  <option value="">Set category</option>
                                  <CategoryOptions includeUncat={false} />
                                </select>
                                <ChevronDown
                                  size={12}
                                  className={`pointer-events-none absolute right-2 ${t.category ? "text-faint" : "text-accent"}`}
                                />
                              </span>
                            )}
                          </span>
                          {/* Deal — tie the obvious match in one click, or open the picker. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            {isLoan ? null : t.allocated > 0.0001 && t.unallocated <= 0.0001 ? (
                              <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-success-bg/60 border border-success/40 text-[12px] text-success-ink whitespace-nowrap">
                                <Link2 size={11} /> Linked
                              </span>
                            ) : cm ? (
                              <button
                                onClick={() => tieMatch(t, cm.deal)}
                                disabled={tyingId === t.id}
                                title={`Tie the full ${fmtAmount(t.unallocated)} to ${dealLabel(cm.deal)} as ${t.direction === "out" ? "a supplier payment" : "a buyer payment"} — ${cm.reason}`}
                                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-accent/40 bg-accent/5 text-accent text-[12px] font-semibold hover:bg-accent/10 disabled:opacity-50 transition-colors whitespace-nowrap max-w-[220px]"
                              >
                                {tyingId === t.id ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                                <span className="truncate">Tie to {matchLabel(cm.deal)}</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => toggleRow(t)}
                                title="Pick a deal to tie this payment to"
                                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line text-[12px] text-ink-2 font-medium hover:bg-surface-2 hover:border-line-3 transition-colors whitespace-nowrap"
                              >
                                <Link2 size={11} /> {t.allocated > 0.0001 ? `${fmtAmount(t.allocated)} tied` : "Link deal"}
                              </button>
                            )}
                          </span>
                          {/* Book — labeled, always visible, never hover-only. */}
                          <span className="flex-shrink-0 order-2 lg:order-none" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => saveReview(t, { reviewed: true })}
                              title="Mark this transaction booked"
                              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent hover:bg-accent-hover text-on-accent text-[12px] font-semibold transition-colors whitespace-nowrap"
                            >
                              <Check size={12} strokeWidth={2.4} /> Book
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Ledger — the full history */}
      {tab === "ledger" && (
        loading ? skeletonRows
        : loadError ? errorState
        : txns.length === 0 ? firstRunState
        : splitView ? (
        // Money in and money out, side by side, each with its own search — pin the
        // received side and the sent side at once to reconcile a refund.
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-semibold text-success-ink whitespace-nowrap">
                Money in <span className="text-muted font-normal tabular-nums">{filteredIn.length}</span>
              </span>
              <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-2.5 h-8">
                <Search size={13} className="text-muted flex-shrink-0" />
                <input value={searchIn} onChange={(e) => setSearchIn(e.target.value)} placeholder="Search received…"
                  className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none" />
              </div>
            </div>
            {renderTxnTable(filteredIn)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[12px] font-semibold text-danger-ink whitespace-nowrap">
                Money out <span className="text-muted font-normal tabular-nums">{filteredOut.length}</span>
              </span>
              <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-2.5 h-8">
                <Search size={13} className="text-muted flex-shrink-0" />
                <input value={searchOut} onChange={(e) => setSearchOut(e.target.value)} placeholder="Search sent…"
                  className="w-full bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none" />
              </div>
            </div>
            {renderTxnTable(filteredOut)}
          </div>
        </div>
      ) : (
        renderTxnTable(filtered)
      )
      )}

      {bulkAllocOpen && (
        <BulkAllocateModal
          deals={deals}
          loans={loans}
          count={selected.size}
          busy={bulkActionBusy}
          onClose={() => setBulkAllocOpen(false)}
          onPickDeal={async (d) => { setBulkAllocOpen(false); await bulkAllocate(d); }}
          onPickLoan={async (l) => { setBulkAllocOpen(false); await bulkTagLoan(l); }}
        />
      )}

      {/* Auto-tag rules — managed from Setup, next to the tools that act on them */}
      {tab === "setup" && (
        <RulesCard
          rules={rules}
          open={rulesOpen}
          setOpen={setRulesOpen}
          onApply={applyRules}
          onDelete={deleteRule}
          onCreate={(cp, cat, dir) => createRule(cp, cat, "expense", "", dir)}
        />
      )}
      </div>
      )}

      {/* Booking sheet — the allocation panel out of the table. One transaction,
          full height, Escape or the overlay closes it, and it can no longer be
          scrolled away from its own row. */}
      {openTxn && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          onClick={() => setOpenId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Book transaction"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            className="h-full w-full max-w-[560px] bg-surface border-l border-line shadow-2xl overflow-y-auto p-5 space-y-4 focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {payeeEditId === openTxn.id ? (
                  <input
                    autoFocus
                    value={payeeDraft}
                    aria-label="Payee name"
                    onChange={(e) => setPayeeDraft(e.target.value)}
                    onBlur={(e) => commitPayeeEdit(openTxn, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); payeeCancelRef.current = true; e.currentTarget.blur(); }
                    }}
                    className="w-full min-w-0 bg-surface border border-line rounded px-1.5 py-0.5 text-[16px] font-semibold text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[16px] font-semibold text-ink truncate">
                      {openTxn.counterparty_name?.trim() || openTxn.description || "Transaction"}
                    </span>
                    <button
                      onClick={() => {
                        setPayeeDraft(openTxn.counterparty_name?.trim() || openTxn.description || "");
                        setPayeeEditId(openTxn.id);
                      }}
                      title="Rename payee"
                      aria-label="Rename payee"
                      className="text-faint hover:text-ink-2 flex-shrink-0 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
                <div className="text-[12px] text-muted mt-0.5 truncate">
                  {(openTxn.posted_at || "").slice(0, 10)}
                  {fmtTime(openTxn.posted_dt) ? ` · ${fmtTime(openTxn.posted_dt)}` : ""}
                  {openTxn.counterparty_name?.trim() && openTxn.description ? ` · ${openTxn.description}` : ""}
                </div>
              </div>
              <button
                onClick={() => setOpenId(null)}
                aria-label="Close"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 flex-shrink-0 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className={`text-[20px] font-semibold tabular-nums ${openTxn.direction === "in" ? "text-success-ink" : "text-danger-ink"}`}>
                {openTxn.direction === "in" ? "+" : "−"}{fmtAmount(openTxn.amount)}
              </div>
              <button
                onClick={() => saveReview(openTxn, { reviewed: !openTxn.reviewed })}
                className={`flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium transition-colors ${
                  openTxn.reviewed
                    ? "border border-line text-ink-2 hover:bg-surface-2"
                    : "bg-accent hover:bg-accent-hover text-on-accent"
                }`}
              >
                <Check size={14} /> {openTxn.reviewed ? "Booked — reopen" : "Book it"}
              </button>
            </div>

            {openTxn.counterparty_type !== "loan" && (
              <label className="block">
                <span className="block text-[12px] font-medium text-ink-2 mb-1">Category</span>
                <select
                  value={openTxn.category || ""}
                  onChange={(e) => saveReview(openTxn, { category: e.target.value })}
                  className={`${inp} text-ink-2`}
                >
                  <CategoryOptions />
                </select>
              </label>
            )}

            <AllocationPanel
              txn={openTxn}
              allocs={allocs}
              loading={allocLoading}
              targetType={targetType}
              setTargetType={setTargetType}
              filteredDeals={filteredDeals}
              dealQuery={dealQuery}
              setDealQuery={(v) => { setDealQuery(v); setSelectedDeal(null); setDealListOpen(true); }}
              dealListOpen={dealListOpen}
              setDealListOpen={setDealListOpen}
              selectedDeal={selectedDeal}
              onPickDeal={(d) => { setSelectedDeal(d); setDealQuery(dealLabel(d)); setDealListOpen(false); }}
              filteredLoans={filteredLoans}
              loanQuery={loanQuery}
              setLoanQuery={(v) => { setLoanQuery(v); setSelectedLoan(null); setLoanListOpen(true); }}
              loanListOpen={loanListOpen}
              setLoanListOpen={setLoanListOpen}
              selectedLoan={selectedLoan}
              onPickLoan={(l) => { setSelectedLoan(l); setLoanQuery(loanLabel(l)); setLoanListOpen(false); }}
              amountStr={amountStr}
              setAmountStr={setAmountStr}
              role={role}
              setRole={setRole}
              note={note}
              setNote={setNote}
              allowSplit={allowSplit}
              setAllowSplit={setAllowSplit}
              busy={allocBusy}
              onSubmit={submitAlloc}
              onRemove={removeAlloc}
              onUntagLoan={untagLoan}
              onCreateRule={createRule}
              newDealBusy={newDealBusy}
              onCreateDeal={createDealFromTxn}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Pick one deal or loan, then tag every selected transaction to it. For deals the
// remaining amount is allocated (role auto-picked by direction); for loans the whole
// txn is tagged (received/repayment derived by direction).
function BulkAllocateModal({
  deals, loans, count, busy, onClose, onPickDeal, onPickLoan,
}: {
  deals: DealFlow[];
  loans: Loan[];
  count: number;
  busy: boolean;
  onClose: () => void;
  onPickDeal: (d: DealFlow) => void;
  onPickLoan: (l: Loan) => void;
}) {
  const [mode, setMode] = useState<"deal" | "loan">("deal");
  const [q, setQ] = useState("");
  const dealList = useMemo(() => {
    const s = q.toLowerCase();
    // Same survivor dedup as the single-row picker — a bulk tag must never land on
    // a ghost duplicate the deal view hides.
    return survivorDeals(deals)
      .filter((d) => `${d.client_name || ""} ${d.name || ""} ${d.invoice_number || ""}`.toLowerCase().includes(s))
      .sort((a, b) =>
        (Date.parse(b.completed_at || b.created_at || "") || 0) - (Date.parse(a.completed_at || a.created_at || "") || 0))
      .slice(0, 40);
  }, [deals, q]);
  const loanList = useMemo(() => {
    const s = q.toLowerCase();
    return loans.filter((l) => `${l.name || ""} ${l.lender || ""}`.toLowerCase().includes(s)).slice(0, 30);
  }, [loans, q]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">
              {mode === "deal" ? `Tag ${count} to a deal` : `Tag ${count} to a loan`}
            </h2>
            <p className="text-[12px] text-muted mt-0.5">
              {mode === "deal"
                ? "Each remaining amount is tied to the deal you pick — receipts as buyer payments, payments as supplier payments."
                : "Each transaction is tagged to the loan you pick — money in as loan received, money out as repayment."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2 transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-line space-y-3">
          <div className="flex gap-1">
            {([["deal", "Deal"], ["loan", "Loan"]] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => { setMode(v); setQ(""); }}
                className={`px-3 h-8 rounded-lg text-[12px] font-medium transition-colors ${
                  mode === v ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "deal" ? "Search a deal…" : "Search a loan…"}
            className={inp}
          />
        </div>
        <div className="overflow-y-auto divide-y divide-line-2">
          {mode === "deal" ? (
            dealList.length === 0 ? (
              <div className="text-center py-10 text-[12px] text-muted">No deals match</div>
            ) : (
              dealList.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onPickDeal(d)}
                  disabled={busy}
                  className="w-full text-left px-5 py-2.5 hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  <DealRowContent d={d} />
                </button>
              ))
            )
          ) : loanList.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-muted">No loans match</div>
          ) : (
            loanList.map((l) => (
              <button
                key={l.id}
                onClick={() => onPickLoan(l)}
                disabled={busy}
                className="w-full text-left px-5 py-2.5 hover:bg-surface-2 disabled:opacity-50 transition-colors"
              >
                <div className="text-[13px] font-medium text-ink truncate">{loanLabel(l)}</div>
                <div className="text-[11px] text-muted truncate tabular-nums">
                  {l.lender || "—"}{l.outstanding ? ` · ${fmtAmount(l.outstanding)} outstanding` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AllocationPanel(props: {
  txn: BankTxn;
  allocs: BankAllocation[];
  loading: boolean;
  targetType: "deal" | "loan" | "expense";
  setTargetType: (v: "deal" | "loan" | "expense") => void;
  filteredDeals: DealFlow[];
  dealQuery: string;
  setDealQuery: (v: string) => void;
  dealListOpen: boolean;
  setDealListOpen: (v: boolean) => void;
  selectedDeal: DealFlow | null;
  onPickDeal: (d: DealFlow) => void;
  filteredLoans: Loan[];
  loanQuery: string;
  setLoanQuery: (v: string) => void;
  loanListOpen: boolean;
  setLoanListOpen: (v: boolean) => void;
  selectedLoan: Loan | null;
  onPickLoan: (l: Loan) => void;
  amountStr: string;
  setAmountStr: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  allowSplit: boolean;
  setAllowSplit: (v: boolean) => void;
  busy: boolean;
  onSubmit: () => void;
  onRemove: (id: string) => void;
  onUntagLoan: (bankTxnId: string) => void;
  onCreateRule: (matchCounterparty: string, category: string, tType: "deal" | "loan" | "expense", targetId: string, direction: string) => void;
  newDealBusy: boolean;
  onCreateDeal: (t: BankTxn, name: string, buyer: string, sale: number, note: string) => Promise<boolean>;
}) {
  const {
    txn, allocs, loading, targetType, setTargetType, filteredDeals, dealQuery, setDealQuery, dealListOpen, setDealListOpen,
    selectedDeal, onPickDeal, filteredLoans, loanQuery, setLoanQuery, loanListOpen, setLoanListOpen, selectedLoan, onPickLoan,
    amountStr, setAmountStr, role, setRole, note, setNote, allowSplit, setAllowSplit, busy, onSubmit, onRemove, onUntagLoan, onCreateRule,
    newDealBusy, onCreateDeal,
  } = props;

  // Live split math: how much of this transaction is still unallocated across ALL deals.
  const splitAllocated = allocs.reduce((s, a) => s + (a.amount || 0), 0);
  const splitRemaining = Math.max((txn.amount || 0) - splitAllocated, 0);

  // "Create a deal from this transaction" — retroactive backfill form (local state).
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [ndName, setNdName]   = useState("");
  const [ndBuyer, setNdBuyer] = useState("");
  const [ndSale, setNdSale]   = useState("");
  const [ndNote, setNdNote]   = useState("");

  const openNewDeal = () => {
    const base = txn.counterparty_name?.trim() || txn.description || "";
    setNdName(base);
    setNdBuyer(txn.counterparty_name?.trim() || base);
    setNdSale(txn.unallocated > 0 ? String(txn.unallocated) : "");
    setNdNote("");
    setShowNewDeal(true);
  };

  const submitNewDeal = async () => {
    const name = ndName.trim();
    const buyer = ndBuyer.trim();
    const sale = parseFloat(ndSale);
    if (!name) { toast("Deal name required", "error"); return; }
    if (!buyer) { toast("Buyer name required", "error"); return; }
    if (!(sale > 0)) { toast("Enter an expected sale amount", "error"); return; }
    if (await onCreateDeal(txn, name, buyer, sale, ndNote.trim())) setShowNewDeal(false);
  };

  const isLoanTagged = txn.counterparty_type === "loan";
  const counterparty = txn.counterparty_name?.trim() || "";
  // Remember future rows with this counterparty: a loan tag memorizes the loan
  // (recurring lender repayments), otherwise it memorizes the category only — a
  // one-off deal id shouldn't auto-apply to unrelated future transactions.
  const isLoanRule = isLoanTagged || (targetType === "loan" && !!selectedLoan);
  const alwaysTag = () => {
    if (!counterparty) return;
    const dir = txn.direction; // scope the rule to this txn's direction (in vs out)
    if (isLoanTagged && txn.counterparty_id) onCreateRule(counterparty, "", "loan", txn.counterparty_id, dir);
    else if (targetType === "loan" && selectedLoan) onCreateRule(counterparty, "", "loan", selectedLoan.id, dir);
    else onCreateRule(counterparty, txn.category || "", "expense", "", dir);
  };

  const renderRuleButton = () => {
    const dirWord = txn.direction === "in" ? "money-in" : "money-out";
    const canTag = !!counterparty && (isLoanRule || !!txn.category);
    const label = !counterparty
      ? "Always tag like this"
      : isLoanRule
        ? `Tag all ${dirWord} from "${counterparty}" to this loan`
        : `Tag all ${dirWord} from "${counterparty}" as ${catLabel(txn.category || "")}`;
    return (
      <button
        onClick={alwaysTag}
        disabled={!canTag}
        title={
          !counterparty ? "This transaction has no payer name to match on"
          : !canTag ? "Pick a category for this transaction first"
          : "Create a rule and tag every matching transaction now"
        }
        className={`flex items-center gap-1.5 h-9 px-3 border border-line rounded-lg text-[12px] font-medium transition-colors ${
          canTag ? "text-ink-2 hover:bg-surface-2" : "text-faint opacity-60 cursor-not-allowed"
        }`}
      >
        <Wand2 size={13} /> {label}
      </button>
    );
  };

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px] text-ink-2 min-w-0">
          {txn.direction === "in" ? "Receipt" : "Payment"} of{" "}
          <span className="font-semibold tabular-nums text-ink">{fmtAmount(txn.amount)}</span>
          {/* The account moved here when it left the table row — it is near-constant
              down the column, but it must stay visible somewhere per transaction. */}
          {txn.account_id ? <span className="text-muted"> · {txn.account_id}</span> : null}
        </div>
        <div className="text-[12px] text-muted">
          Unallocated{" "}
          <span className={`font-semibold tabular-nums ${txn.unallocated > 0.0001 ? "text-warning-ink" : "text-success-ink"}`}>
            {fmtAmount(txn.unallocated)}
          </span>
        </div>
      </div>

      {/* Existing allocations / loan tag */}
      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          {isLoanTagged && (
            <div className="border border-line-2 rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2">
                <Landmark size={14} className="text-muted flex-shrink-0" strokeWidth={1.8} />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-ink truncate">{txn.counterparty_name || "Loan"}</div>
                  <div className="text-[11px] text-muted">{loanTagLabel(txn.direction)}</div>
                </div>
                <button
                  onClick={() => onUntagLoan(txn.id)}
                  disabled={busy}
                  title="Remove loan tag"
                  className="flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-faint hover:text-danger-ink hover:bg-danger-bg disabled:opacity-50 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )}
          {allocs.length > 0 && (
            <div className="border border-line-2 rounded-lg divide-y divide-line-2 overflow-hidden">
              {allocs.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-ink truncate">
                      {a.deal_name?.trim() || a.invoice_number || "Deal"}
                      {a.client_name && <span className="text-muted font-normal"> · {a.client_name}</span>}
                    </div>
                    <div className="text-[11px] text-muted">
                      {roleLabel(a.role)}{a.invoice_number ? ` · ${a.invoice_number}` : ""}{a.note ? ` · ${a.note}` : ""}
                    </div>
                  </div>
                  <div className="text-[12px] font-semibold text-ink tabular-nums flex-shrink-0">{fmtAmount(a.amount)}</div>
                  <button
                    onClick={() => onRemove(a.id)}
                    title="Remove allocation"
                    className="flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-faint hover:text-danger-ink hover:bg-danger-bg transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!isLoanTagged && allocs.length === 0 && (
            <div className="text-[12px] text-muted">Not tied to any deal or loan yet.</div>
          )}
        </>
      )}

      {/* Where this transaction belongs */}
      <div className="flex gap-1 flex-wrap">
        {([["deal", "Deal"], ["loan", "Loan"], ["expense", "Expense / income"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTargetType(v)}
            className={`px-3 h-9 rounded-lg text-[12px] font-medium transition-colors ${
              targetType === v ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Deal target */}
      {targetType === "deal" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
            <div className="sm:col-span-5 relative min-w-0">
              <input
                value={dealQuery}
                onChange={(e) => setDealQuery(e.target.value)}
                onFocus={() => setDealListOpen(true)}
                placeholder="Search a deal…"
                className={inp}
              />
              {dealListOpen && (
                <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg">
                  {filteredDeals.length > 0 ? (
                    filteredDeals.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => onPickDeal(d)}
                        className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors border-b border-line/40 last:border-0"
                      >
                        <DealRowContent d={d} match={dealMatchesTxn(d, txn)} />
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-3 text-[11px] text-muted">No deals match{dealQuery ? ` "${dealQuery}"` : " yet"}.</div>
                  )}
                </div>
              )}
            </div>
            <input
              type="number"
              step="0.01"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="Amount"
              className={`${inp} sm:col-span-2 tabular-nums`}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="sm:col-span-3 border border-line px-2.5 h-9 rounded-lg text-[13px] w-full bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {rolesFor(txn.direction).map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button
              onClick={onSubmit}
              disabled={busy || !selectedDeal}
              className="sm:col-span-2 flex items-center justify-center gap-1.5 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Allocate
            </button>
          </div>
          {/* Split one payment across multiple deals — allocate a partial amount to
              each; the backend keeps the running total within the transaction. */}
          <label className="flex items-center gap-2 text-[12px] text-ink-2 cursor-pointer mt-1">
            <input type="checkbox" checked={allowSplit} onChange={(e) => setAllowSplit(e.target.checked)} className="accent-accent" />
            Split this payment across multiple deals
          </label>
          {allowSplit && (
            <div className="flex items-center gap-2 text-[11.5px] text-muted mt-1 flex-wrap">
              <span>Enter a partial amount, pick a deal + role, Allocate — repeat for each deal.</span>
              <span className="ml-auto tabular-nums whitespace-nowrap">
                Unallocated <span className={`font-semibold ${splitRemaining > 0.005 ? "text-ink" : "text-success-ink"}`}>{fmtAmount(splitRemaining)}</span> of {fmtAmount(txn.amount)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className={`${inp} flex-1 min-w-[180px]`}
            />
            {/* Backfills a deal from a RECEIVED payment — only valid for money-in.
                On money-out it created an orphan client/invoice/deal then errored. */}
            {txn.direction === "in" && (
              <button
                onClick={() => (showNewDeal ? setShowNewDeal(false) : openNewDeal())}
                className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[12px] font-medium hover:bg-surface-2 transition-colors"
              >
                <Plus size={13} /> New deal from this transaction
              </button>
            )}
            {renderRuleButton()}
          </div>
        </>
      )}

      {/* Loan target — tags the whole transaction (received / repayment by direction) */}
      {targetType === "loan" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
            <div className="sm:col-span-7 relative min-w-0">
              <input
                value={loanQuery}
                onChange={(e) => setLoanQuery(e.target.value)}
                onFocus={() => setLoanListOpen(true)}
                placeholder="Search a loan…"
                className={inp}
              />
              {loanListOpen && filteredLoans.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg">
                  {filteredLoans.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => onPickLoan(l)}
                      className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors"
                    >
                      <div className="text-[12px] font-medium text-ink truncate">{loanLabel(l)}</div>
                      <div className="text-[11px] text-muted truncate tabular-nums">
                        {l.lender || "—"}{l.outstanding ? ` · ${fmtAmount(l.outstanding)} outstanding` : ""}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="sm:col-span-3 h-9 flex items-center px-3 border border-line-2 rounded-lg text-[12px] text-muted bg-surface-2/40 truncate">
              Records as {loanTagLabel(txn.direction).toLowerCase()}
            </div>
            <button
              onClick={onSubmit}
              disabled={busy || !selectedLoan}
              className="sm:col-span-2 flex items-center justify-center gap-1.5 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />} Tag to loan
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">{renderRuleButton()}</div>
        </>
      )}

      {/* Expense / income — no target, just the row's category */}
      {targetType === "expense" && (
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[12px] text-muted flex-1 min-w-[180px]">
            Tracked by category only — set the category on the row above; it isn't tied to a deal or loan.
          </p>
          {renderRuleButton()}
        </div>
      )}

      {/* Create a deal retroactively from this transaction */}
      {showNewDeal && (
        <div className="border border-line rounded-xl p-3.5 space-y-3 bg-surface-2/40">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-medium text-ink">Create a deal from this transaction</div>
            <button
              onClick={() => setShowNewDeal(false)}
              title="Cancel"
              className="text-faint hover:text-muted transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 min-w-0">
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Deal name</span>
              <input value={ndName} onChange={(e) => setNdName(e.target.value)} placeholder="Deal name" className={inp} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Buyer / client</span>
              <input value={ndBuyer} onChange={(e) => setNdBuyer(e.target.value)} placeholder="Buyer name" className={inp} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Expected sale</span>
              <input type="number" step="0.01" value={ndSale} onChange={(e) => setNdSale(e.target.value)} placeholder="0.00" className={`${inp} tabular-nums`} />
            </label>
            <label className="block min-w-0">
              <span className="block text-[11px] text-muted mb-1">Note (optional)</span>
              <input value={ndNote} onChange={(e) => setNdNote(e.target.value)} placeholder="Note" className={inp} />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] text-muted min-w-0">Creates a client, a backfilled invoice and a deal, then ties this receipt to it.</p>
            <button
              onClick={submitNewDeal}
              disabled={newDealBusy}
              className="flex items-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {newDealBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create deal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Memorized auto-tag rules — collapsible management home next to the queue they act on.
function RulesCard({
  rules, open, setOpen, onApply, onDelete, onCreate,
}: {
  rules: TxnRule[];
  open: boolean;
  setOpen: (v: boolean) => void;
  onApply: () => void;
  onDelete: (id: string) => void;
  onCreate: (matchCounterparty: string, category: string, direction: string) => void;
}) {
  const [cp, setCp]   = useState("");
  const [cat, setCat] = useState("");
  const [dir, setDir] = useState("");

  const add = () => {
    if (!cp.trim()) { toast("Enter a counterparty to match", "error"); return; }
    // A rule applies its category to EVERY matching un-booked transaction — an
    // empty ("Uncategorized") rule would mass-clear categories across the ledger.
    if (!cat) { toast("Pick a category for the rule", "error"); return; }
    onCreate(cp.trim(), cat, dir);
    setCp(""); setCat(""); setDir("");
  };

  return (
    <div className="border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <ChevronRight size={14} className={`text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <span className="text-[13px] font-semibold text-ink">Auto-tag rules</span>
          <span className="text-[12px] text-muted tabular-nums">· {rules.length}</span>
        </button>
        <button
          onClick={onApply}
          className="text-[12px] font-medium text-accent hover:text-accent-hover transition-colors"
        >
          Apply rules now
        </button>
      </div>

      {open && (
        <div className="pt-3 space-y-3">
          <p className="text-[11px] text-muted leading-relaxed">
            Open a transaction, set its category, and choose "Tag all like this" — it creates a rule and instantly tags
            every matching transaction. A rule can be limited to money in or money out, so the same payer (e.g. Whatnot)
            can be a sale one way and an expense the other. Tagged rows stay in To-do until you book them.
          </p>

          {rules.length > 0 && (
            <div className="border-t border-line-2">
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-2 border-b border-line-2">
                  <div className="min-w-0 flex-1 text-[12.5px]">
                    {r.direction && (
                      <span className={r.direction === "in" ? "text-success-ink" : "text-danger-ink"}>
                        {r.direction === "in" ? "Money in" : "Money out"} ·{" "}
                      </span>
                    )}
                    <span className="font-semibold text-ink">{r.match_counterparty}</span>
                    <span className="text-faint"> → </span>
                    <span className="text-ink-2">{r.target_type === "loan" ? (r.loan_name || "Loan") : catLabel(r.category)}</span>
                  </div>
                  <button
                    onClick={() => onDelete(r.id)}
                    title="Delete rule"
                    className="flex-shrink-0 text-faint hover:text-danger-ink transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add rule (edit = delete then re-add) */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={cp}
              onChange={(e) => setCp(e.target.value)}
              placeholder="Counterparty to match…"
              className={`${inp} flex-1 min-w-[160px]`}
            />
            <select
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              title="Which direction this rule applies to"
              className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <option value="">Any direction</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
            <select
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <CategoryOptions />
            </select>
            <button
              onClick={add}
              className="flex items-center gap-1.5 h-9 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[12px] font-medium transition-colors"
            >
              <Plus size={13} /> Add rule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
