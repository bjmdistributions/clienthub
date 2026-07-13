import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Landmark, Upload, Search, Check, X, Trash2, Loader2, Link2, ChevronRight, Sparkles, Plus,
  Building2, RefreshCw, Plug,
} from "lucide-react";
import {
  api, BankTxn, BankTxnSummary, BankPreview, BankAiPreview, BankAiImportResult, BankAllocation, DealFlow, PlaidItem,
} from "../lib/api";
import { fmtAmount } from "../lib/format";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./Toast";
import FreeCashView from "./FreeCashView";
import LoansView from "./LoansView";

declare global {
  interface Window { Plaid?: any }
}

// Categories the statement parser produces (blank = uncategorized).
const CATEGORIES: { value: string; label: string }[] = [
  { value: "",                 label: "Uncategorized" },
  { value: "receipt",          label: "Receipt (money in)" },
  { value: "payment",          label: "Payment (to supplier)" },
  { value: "fee",              label: "Fee" },
  { value: "owner_draw",       label: "Owner draw" },
  { value: "shipping",         label: "Shipping" },
  { value: "software",         label: "Software" },
  { value: "internal_transfer",label: "Internal transfer" },
  { value: "cash_in",          label: "Cash in" },
  { value: "cash_out",         label: "Cash out" },
];

const ROLES: { value: string; label: string }[] = [
  { value: "buyer_payment",    label: "Buyer payment" },
  { value: "supplier_payment", label: "Supplier payment" },
  { value: "refund_out",       label: "Refund out" },
  { value: "refund_in",        label: "Refund in" },
  { value: "adjustment",       label: "Adjustment" },
];

const roleLabel = (v: string) => ROLES.find((r) => r.value === v)?.label ?? v;
const dealLabel = (d: DealFlow) => (d.name?.trim() || d.invoice_number || "Deal");

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function FinancialsView() {
  const [txns, setTxns]       = useState<BankTxn[]>([]);
  const [summary, setSummary] = useState<BankTxnSummary | null>(null);
  const [deals, setDeals]     = useState<DealFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<"overview" | "transactions" | "loans">("overview");
  const [aiBusy, setAiBusy]   = useState(false);
  const [newDealBusy, setNewDealBusy] = useState(false);

  // Import
  const [accountId, setAccountId]     = useState("chase-business");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview]         = useState<BankPreview | null>(null);
  const [importing, setImporting]     = useState(false);

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
  const [plaidEnv, setPlaidEnv]             = useState<"sandbox" | "production">("sandbox");
  const [plaidTesting, setPlaidTesting]     = useState(false);

  // AI import (any statement — credit cards / other banks)
  const [aiPreviewPath, setAiPreviewPath] = useState<string | null>(null);
  const [aiPreview, setAiPreview]         = useState<BankAiPreview | null>(null);
  const [aiExtracting, setAiExtracting]   = useState(false);
  const [aiImporting, setAiImporting]     = useState(false);

  // Filters
  const [search, setSearch]           = useState("");
  const [dirFilter, setDirFilter]     = useState<"all" | "in" | "out">("all");
  const [acctFilter, setAcctFilter]   = useState("all");
  const [catFilter, setCatFilter]     = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "unreviewed" | "unallocated_in">("all");
  const [fromDate, setFromDate]       = useState("");
  const [toDate, setToDate]           = useState("");

  // Allocation panel (inline expanding row)
  const [openId, setOpenId]           = useState<string | null>(null);
  const [allocs, setAllocs]           = useState<BankAllocation[]>([]);
  const [allocLoading, setAllocLoading] = useState(false);
  const [dealQuery, setDealQuery]     = useState("");
  const [selectedDeal, setSelectedDeal] = useState<DealFlow | null>(null);
  const [dealListOpen, setDealListOpen] = useState(false);
  const [amountStr, setAmountStr]     = useState("");
  const [role, setRole]               = useState("buyer_payment");
  const [note, setNote]               = useState("");
  const [allocBusy, setAllocBusy]     = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [t, s, d] = await Promise.all([
          api.listBankTxns(), api.bankTxnSummary(), api.listDealFlows(),
        ]);
        setTxns(t); setSummary(s); setDeals(d);
      } catch (e: any) { toast(String(e), "error"); }
      finally { setLoading(false); }
    })();
    // Bank feed is secondary — load separately so a Plaid hiccup never blocks the list.
    (async () => {
      try {
        const cfg = await api.plaidConfig();
        setPlaidReady(cfg.has_keys);
        if (cfg.env === "sandbox" || cfg.env === "production") setPlaidEnv(cfg.env);
      } catch { setPlaidReady(false); }
      try { setPlaidItems(await api.plaidListItems()); } catch { /* no banks / not set up yet */ }
    })();
  }, []);

  // Reload txns + summary, and (optionally) the open row's allocations.
  const refreshAll = async (keepOpen = true) => {
    const [t, s] = await Promise.all([api.listBankTxns(), api.bankTxnSummary()]);
    setTxns(t); setSummary(s);
    if (keepOpen && openId) {
      const a = await api.listBankAllocationsForTxn(openId);
      setAllocs(a);
      const nt = t.find((x) => x.id === openId);
      setAmountStr(nt ? String(nt.unallocated) : "");
    }
  };

  // Load Plaid's Link script once (CSP is disabled, so the CDN loads fine).
  const loadPlaidSdk = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (window.Plaid) { resolve(); return; }
      const s = document.createElement("script");
      s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load Plaid Link"));
      document.head.appendChild(s);
    });

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
    } catch (e: any) { toast(String(e), "error"); }
    finally { setPlaidSavingKeys(false); }
  };

  const testPlaidKeys = async () => {
    setPlaidTesting(true);
    try {
      toast(await api.plaidTestKeys());
    } catch (e: any) { toast(String(e), "error"); }
    finally { setPlaidTesting(false); }
  };

  const connectBank = async () => {
    setPlaidConnecting(true);
    try {
      const linkToken = await api.plaidLinkToken();
      await loadPlaidSdk();
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: async (public_token: string, metadata: any) => {
          try {
            const inst = metadata?.institution?.name || "Bank";
            await api.plaidExchange(public_token, inst);
            toast(`Connected ${inst}`);
            setPlaidItems(await api.plaidListItems());
            const r = await api.plaidSync();
            toast(`Synced ${r.imported} transaction${r.imported === 1 ? "" : "s"}`);
            await refreshAll(false);
          } catch (e: any) { toast(String(e), "error"); }
        },
        onExit: (err: any) => {
          if (err) toast(String(err?.display_message || err?.error_message || err), "error");
        },
      });
      handler.open();
    } catch (e: any) { toast(String(e), "error"); }
    finally { setPlaidConnecting(false); }
  };

  const syncPlaid = async () => {
    setPlaidSyncing(true);
    try {
      const r = await api.plaidSync();
      toast(`Synced ${r.imported} new transaction${r.imported === 1 ? "" : "s"}${r.removed > 0 ? `, removed ${r.removed}` : ""}`);
      await refreshAll(false);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setPlaidSyncing(false); }
  };

  const disconnectBank = async (item: PlaidItem) => {
    if (!confirm(`Disconnect ${item.institution}? Its imported transactions stay in the list.`)) return;
    try {
      await api.plaidRemoveItem(item.id);
      toast("Bank disconnected");
      setPlaidItems(await api.plaidListItems());
    } catch (e: any) { toast(String(e), "error"); }
  };

  // Open/close a row's allocation panel.
  const toggleRow = (t: BankTxn) => {
    if (openId === t.id) { setOpenId(null); return; }
    setOpenId(t.id);
    setDealQuery(""); setSelectedDeal(null); setDealListOpen(false); setNote("");
    setRole(t.direction === "out" ? "supplier_payment" : "buyer_payment");
    setAmountStr(String(t.unallocated));
    setAllocLoading(true);
    api.listBankAllocationsForTxn(t.id)
      .then(setAllocs)
      .catch((e: any) => toast(String(e), "error"))
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
    try {
      const p = await api.bankPreview(selected);
      setPreview(p);
    } catch (e: any) { toast(String(e), "error"); setPreviewPath(null); }
  };

  // Import many statements sequentially, all into the current account.
  const bulkImport = async (paths: string[], ai: boolean) => {
    const acct = accountId.trim() || "chase-business";
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
      const s = await api.bankImport(previewPath, accountId.trim() || "chase-business");
      toast(`Imported ${s.imported}, skipped ${s.skipped} (already imported)`);
      setPreview(null); setPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(String(e), "error"); }
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
    } catch (e: any) { toast(String(e), "error"); setAiPreviewPath(null); }
    finally { setAiExtracting(false); }
  };

  const doImportAi = async () => {
    if (!aiPreviewPath) return;
    setAiImporting(true);
    try {
      const s = await api.bankImportAi(aiPreviewPath, accountId.trim() || "chase-business");
      toast(`AI imported ${s.imported} (extracted ${s.extracted}); skipped ${s.skipped} already-imported. Review + allocate below.`);
      setAiPreview(null); setAiPreviewPath(null);
      await refreshAll(false);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setAiImporting(false); }
  };

  // Save classification / reviewed flag (merges with existing fields).
  const saveReview = async (
    t: BankTxn,
    patch: Partial<Pick<BankTxn, "category" | "counterparty_name" | "counterparty_type" | "counterparty_id" | "reviewed">>,
  ) => {
    const m = {
      category:          t.category || "",
      counterparty_name: t.counterparty_name || "",
      counterparty_type: t.counterparty_type || "",
      counterparty_id:   t.counterparty_id || "",
      reviewed:          t.reviewed,
      ...patch,
    };
    try {
      await api.setBankTxnReview(t.id, m.category, m.counterparty_name, m.counterparty_type, m.counterparty_id, m.reviewed);
      setTxns((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...m } : x)));
      const s = await api.bankTxnSummary();
      setSummary(s);
    } catch (e: any) { toast(String(e), "error"); }
  };

  const submitAlloc = async () => {
    if (!openId || !selectedDeal) { toast("Pick a deal first", "error"); return; }
    const amt = parseFloat(amountStr);
    if (!(amt > 0)) { toast("Enter an amount", "error"); return; }
    setAllocBusy(true);
    try {
      await api.allocateBankTxn(openId, selectedDeal.id, amt, role, note.trim());
      toast("Allocated to deal");
      setSelectedDeal(null); setDealQuery(""); setNote("");
      await refreshAll(true);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setAllocBusy(false); }
  };

  const removeAlloc = async (id: string) => {
    try {
      await api.removeBankAllocation(id);
      toast("Allocation removed");
      await refreshAll(true);
    } catch (e: any) { toast(String(e), "error"); }
  };

  // Suggest categories with AI. Suggestions only — does NOT mark reviewed.
  const aiCategorize = async () => {
    setAiBusy(true);
    try {
      const { updated } = await api.aiCategorizeBankTxns();
      toast(`AI categorized ${updated} transaction${updated === 1 ? "" : "s"}`);
      await refreshAll(true);
    } catch (e: any) { toast(String(e), "error"); }
    finally { setAiBusy(false); }
  };

  // Rebuild a never-tracked brokering deal from a bank receipt:
  // client → backfilled invoice → deal flow → allocate this receipt to it.
  const createDealFromTxn = async (
    t: BankTxn, dealName: string, buyerName: string, expectedSale: number, noteVal: string,
  ): Promise<boolean> => {
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
    } catch (e: any) { toast(String(e), "error"); return false; }
    finally { setNewDealBusy(false); }
  };

  const filtered = useMemo(
    () =>
      txns.filter((t) => {
        if (dirFilter !== "all" && t.direction !== dirFilter) return false;
        if (acctFilter !== "all" && t.account_id !== acctFilter) return false;
        if (catFilter !== "all" && (t.category || "") !== catFilter) return false;
        if (statusFilter === "unreviewed" && t.reviewed) return false;
        if (statusFilter === "unallocated_in" && !(t.direction === "in" && t.unallocated > 0.0001)) return false;
        const d = (t.posted_at || "").slice(0, 10);
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          if (
            !(t.description || "").toLowerCase().includes(q) &&
            !(t.counterparty_name || "").toLowerCase().includes(q)
          ) return false;
        }
        return true;
      }),
    [txns, dirFilter, acctFilter, catFilter, statusFilter, fromDate, toDate, search],
  );

  // Distinct account ids present in the loaded transactions (for the filter).
  const accounts = useMemo(
    () => Array.from(new Set(txns.map((t) => t.account_id).filter(Boolean))).sort(),
    [txns],
  );

  const filteredDeals = useMemo(() => {
    const q = dealQuery.toLowerCase();
    return deals
      .filter((d) => `${d.name || ""} ${d.invoice_number || ""} ${d.client_name || ""}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [deals, dealQuery]);

  const allocIndicator = (t: BankTxn) => {
    if (t.allocated <= 0.0001) return <span className="text-muted">—</span>;
    if (t.unallocated <= 0.0001)
      return <span className="inline-flex items-center gap-1 text-success-ink"><Link2 size={11} /> Linked</span>;
    return (
      <span className="text-warning-ink tabular-nums">
        {fmtAmount(t.allocated)} of {fmtAmount(t.amount)}
      </span>
    );
  };

  const openTxn = openId ? txns.find((t) => t.id === openId) ?? null : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="min-w-0 flex items-center gap-2.5">
        <Landmark size={20} className="text-accent flex-shrink-0" strokeWidth={1.8} />
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">Financials</h2>
          <p className="text-[12px] text-muted mt-0.5">Import statements, classify money, tie receipts to deals</p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1">
        {([
          ["overview", "Overview"],
          ["transactions", "Transactions"],
          ["loans", "Loans"],
        ] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`px-3.5 h-9 rounded-lg text-[13px] font-medium transition-colors ${
              tab === v ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <FreeCashView />}
      {tab === "loans" && <LoansView />}

      {tab === "transactions" && (
      <div className="space-y-5">
      {/* Import + AI toolbar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-end gap-2 flex-wrap">
          {bulkProgress && (
            <span className="mr-auto flex items-center gap-1.5 text-[12px] text-muted">
              <Loader2 size={13} className="animate-spin" /> {bulkProgress}
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
            disabled={bulkBusy}
            className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import statement
          </button>
          <button
            onClick={pickAndPreviewAi}
            disabled={aiExtracting || bulkBusy}
            className="flex items-center gap-1.5 px-4 h-9 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {aiExtracting || bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Smart import (AI)
          </button>
        </div>
        <p className="text-[11px] text-muted text-right leading-relaxed">
          Smart import reads any statement with AI — for credit cards and other banks. Set a distinct account per card
          (e.g. chase-card, amex) so each groups and dedupes separately. Selecting several files imports them all to the
          Account above, so import one account's statements together.
        </p>
      </div>

      {/* Bank feed (Plaid) — live transactions straight from the bank */}
      <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 size={15} className="text-accent flex-shrink-0" strokeWidth={1.8} />
          <div className="text-[13px] font-semibold text-ink">Bank feed (Plaid)</div>
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Plaid pulls clean transactions straight from the bank — no statement uploads. After connecting,
          transactions appear in the list below to review and allocate.
        </p>

        {plaidReady !== null && (
          <div className="border border-line-2 rounded-lg p-3.5 space-y-3 bg-surface-2/40">
            {plaidReady === true && (
              <div className="flex items-center gap-1.5 text-[12px] text-ink-2 min-w-0">
                <Check size={13} className="text-success-ink flex-shrink-0" />
                <span className="truncate">
                  Keys saved · environment:{" "}
                  <span className="font-medium text-ink">{plaidEnv === "sandbox" ? "Sandbox" : "Production"}</span>
                </span>
              </div>
            )}
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
            </div>
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
                <button
                  onClick={syncPlaid}
                  disabled={plaidSyncing}
                  className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50 transition-colors"
                >
                  {plaidSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
                </button>
              )}
            </div>

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
      </div>

      {/* Import preview / confirm card */}
      {preview && (
        <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[13px] text-ink">
              Detected <span className="font-semibold uppercase">{preview.format}</span> ·{" "}
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
      {aiPreview && (
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

      {/* Summary tiles */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
          <Tile label="Transactions" value={String(summary.total)} />
          <Tile label="Reviewed" value={`${summary.reviewed} / ${summary.total}`} />
          <Tile label="Money in" value={fmtAmount(summary.sum_in)} tone="in" />
          <Tile label="Money out" value={fmtAmount(summary.sum_out)} />
          <Tile label="Needs a deal" value={String(summary.unallocated_in)} tone="warn" />
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description or counterparty…"
            className="w-full pl-8 pr-3 h-9 text-[13px] border border-line rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "in", "out"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setDirFilter(f)}
              className={`px-3 h-9 rounded-lg text-[12px] font-medium capitalize transition-colors ${
                dirFilter === f ? "bg-accent text-on-accent" : "bg-surface border border-line text-muted hover:border-line-3"
              }`}
            >
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
        {accounts.length > 0 && (
          <select
            value={acctFilter}
            onChange={(e) => setAcctFilter(e.target.value)}
            className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
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
          className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.value || "none"} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="h-9 px-2.5 rounded-lg text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="all">All statuses</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="unallocated_in">Needs a deal</option>
        </select>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="border border-line h-9 px-2 rounded-lg text-[12px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <span className="text-[11px] text-muted">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="border border-line h-9 px-2 rounded-lg text-[12px] bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </div>
      </div>

      {/* Transaction list */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : txns.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
            <Landmark size={18} className="text-faint" />
          </div>
          <p className="text-[14px] font-semibold text-ink-2">No transactions yet</p>
          <p className="text-[12px] text-muted mt-1">Import a Chase statement to get started</p>
          <button onClick={pickAndPreview} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
            Import statement
          </button>
        </div>
      ) : (
        <div className="border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-[13px] min-w-[820px]">
            <thead>
              <tr className="text-left text-muted border-b border-line bg-surface-2/40">
                <th className="font-medium px-3 py-2.5 whitespace-nowrap">Date</th>
                <th className="font-medium px-3 py-2.5">Description</th>
                <th className="font-medium px-3 py-2.5">Counterparty</th>
                <th className="font-medium px-3 py-2.5">Category</th>
                <th className="font-medium px-3 py-2.5 text-right whitespace-nowrap">Amount</th>
                <th className="font-medium px-3 py-2.5 whitespace-nowrap">Allocation</th>
                <th className="font-medium px-3 py-2.5 text-center whitespace-nowrap">Done</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {filtered.map((t) => (
                <Fragment key={t.id}>
                  <tr
                    onClick={() => toggleRow(t)}
                    className={`cursor-pointer transition-colors ${openId === t.id ? "bg-surface-2" : "hover:bg-surface-2/50"}`}
                  >
                    <td className="px-3 py-2.5 tabular-nums text-muted whitespace-nowrap align-top">
                      <span className="inline-flex items-center gap-1">
                        <ChevronRight
                          size={12}
                          className={`text-faint transition-transform duration-150 ${openId === t.id ? "rotate-90" : ""}`}
                        />
                        {(t.posted_at || "").slice(0, 10)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-2 max-w-[280px] align-top">
                      <span className="truncate block" title={t.description}>{t.description}</span>
                      {t.account_id && (
                        <span className="inline-block mt-0.5 text-[10px] text-muted bg-surface-2 border border-line-2 rounded px-1.5 py-0.5">
                          {t.account_id}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted max-w-[160px] align-top">
                      <span className="truncate block">{t.counterparty_name || "—"}</span>
                    </td>
                    <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={t.category || ""}
                        onChange={(e) => saveReview(t, { category: e.target.value })}
                        className="h-8 px-1.5 rounded-md text-[12px] border border-line bg-surface text-ink-2 focus:outline-none focus:ring-2 focus:ring-accent/40 max-w-[150px]"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c.value || "none"} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap align-top ${t.direction === "in" ? "text-success-ink" : "text-ink"}`}>
                      {t.direction === "in" ? "+" : ""}{fmtAmount(t.amount)}
                      <div className="text-[10px] text-muted font-normal">{t.direction === "in" ? "in" : "out"}</div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] whitespace-nowrap align-top">{allocIndicator(t)}</td>
                    <td className="px-3 py-2.5 text-center align-top" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => saveReview(t, { reviewed: !t.reviewed })}
                        title={t.reviewed ? "Reviewed" : "Mark reviewed"}
                        className={`w-6 h-6 rounded-md inline-flex items-center justify-center border transition-colors ${
                          t.reviewed
                            ? "bg-success-bg border-success-ink/30 text-success-ink"
                            : "border-line text-faint hover:text-muted hover:border-line-3"
                        }`}
                      >
                        <Check size={13} strokeWidth={t.reviewed ? 2.4 : 1.8} />
                      </button>
                    </td>
                  </tr>

                  {openId === t.id && (
                    <tr className="bg-surface-2">
                      <td colSpan={7} className="px-3 pb-4 pt-1">
                        <AllocationPanel
                          txn={t}
                          allocs={allocs}
                          loading={allocLoading}
                          filteredDeals={filteredDeals}
                          dealQuery={dealQuery}
                          setDealQuery={(v) => { setDealQuery(v); setSelectedDeal(null); setDealListOpen(true); }}
                          dealListOpen={dealListOpen}
                          setDealListOpen={setDealListOpen}
                          selectedDeal={selectedDeal}
                          onPickDeal={(d) => { setSelectedDeal(d); setDealQuery(dealLabel(d)); setDealListOpen(false); }}
                          amountStr={amountStr}
                          setAmountStr={setAmountStr}
                          role={role}
                          setRole={setRole}
                          note={note}
                          setNote={setNote}
                          busy={allocBusy}
                          onSubmit={submitAlloc}
                          onRemove={removeAlloc}
                          newDealBusy={newDealBusy}
                          onCreateDeal={createDealFromTxn}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-10 text-[12px] text-muted">No transactions match these filters</div>
          )}
        </div>
      )}
      </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "in" | "warn" }) {
  const valueColor = tone === "in" ? "text-success-ink" : tone === "warn" ? "text-warning-ink" : "text-ink";
  return (
    <div className="bg-surface border border-line rounded-xl p-3.5 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-[18px] font-semibold mt-1 tabular-nums truncate ${valueColor}`}>{value}</div>
    </div>
  );
}

function AllocationPanel(props: {
  txn: BankTxn;
  allocs: BankAllocation[];
  loading: boolean;
  filteredDeals: DealFlow[];
  dealQuery: string;
  setDealQuery: (v: string) => void;
  dealListOpen: boolean;
  setDealListOpen: (v: boolean) => void;
  selectedDeal: DealFlow | null;
  onPickDeal: (d: DealFlow) => void;
  amountStr: string;
  setAmountStr: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onRemove: (id: string) => void;
  newDealBusy: boolean;
  onCreateDeal: (t: BankTxn, name: string, buyer: string, sale: number, note: string) => Promise<boolean>;
}) {
  const {
    txn, allocs, loading, filteredDeals, dealQuery, setDealQuery, dealListOpen, setDealListOpen,
    selectedDeal, onPickDeal, amountStr, setAmountStr, role, setRole, note, setNote, busy, onSubmit, onRemove,
    newDealBusy, onCreateDeal,
  } = props;

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

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px] text-ink-2">
          {txn.direction === "in" ? "Receipt" : "Payment"} of{" "}
          <span className="font-semibold tabular-nums text-ink">{fmtAmount(txn.amount)}</span>
        </div>
        <div className="text-[12px] text-muted">
          Unallocated{" "}
          <span className={`font-semibold tabular-nums ${txn.unallocated > 0.0001 ? "text-warning-ink" : "text-success-ink"}`}>
            {fmtAmount(txn.unallocated)}
          </span>
        </div>
      </div>

      {/* Existing allocations */}
      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted"><Loader2 size={13} className="animate-spin" /> Loading…</div>
      ) : allocs.length > 0 ? (
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
      ) : (
        <div className="text-[12px] text-muted">Not tied to any deal yet.</div>
      )}

      {/* Add allocation form */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
        <div className="sm:col-span-5 relative min-w-0">
          <input
            value={dealQuery}
            onChange={(e) => setDealQuery(e.target.value)}
            onFocus={() => setDealListOpen(true)}
            placeholder="Search a deal…"
            className={inp}
          />
          {dealListOpen && filteredDeals.length > 0 && (
            <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg">
              {filteredDeals.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onPickDeal(d)}
                  className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors"
                >
                  <div className="text-[12px] font-medium text-ink truncate">{dealLabel(d)}</div>
                  <div className="text-[11px] text-muted truncate">
                    {d.client_name || "—"}{d.invoice_total ? ` · ${fmtAmount(d.invoice_total)}` : ""}
                  </div>
                </button>
              ))}
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
          {ROLES.map((r) => (
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
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className={`${inp} flex-1 min-w-[180px]`}
        />
        <button
          onClick={() => (showNewDeal ? setShowNewDeal(false) : openNewDeal())}
          className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 rounded-lg text-[12px] font-medium hover:bg-surface-2 transition-colors"
        >
          <Plus size={13} /> New deal from this transaction
        </button>
      </div>

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
