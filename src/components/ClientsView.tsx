import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { api, Client, ClientInput, ClientFilter, MissingInfoReport, Category, DuplicateGroup, BuyerTier, DealFlow } from "../lib/api";
import { fmtAmount, fmtPhone } from "../lib/format";
import { Plus, Trash2, Edit2, Search, Clock, Users, SlidersHorizontal, X, ChevronDown, AlertCircle, CheckCircle2, Mail, Phone, MapPin, Tag, MessageSquare, Download, Send, Ban, FileText, Calendar, StickyNote, UserPlus, ArrowRight, ArrowUp, ArrowDown } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import ClientDetailView from "./ClientDetailView";
import PendingReviewModal from "./PendingReviewModal";
import TierBadge from "./TierBadge";
import ReliabilityBadge from "./ReliabilityBadge";
import StatusPill from "./StatusPill";
import LeadBubbles from "./LeadBubbles";
import { Button, Kpi, PageActions } from "./ui";
import { useSubmit } from "../lib/useSubmit";

// What the client's most-recent touch was — icon + label + accent per kind, so
// Invoice / Quote / Newsletter read distinctly in the list. (api.clientLastActivity)
const ACTIVITY_META: Record<string, { label: string; Icon: typeof Clock; cls: string }> = {
  invoice:    { label: "Invoice",    Icon: FileText,     cls: "text-accent" },
  quote:      { label: "Quote",      Icon: FileText,     cls: "text-warning-ink" },
  newsletter: { label: "Newsletter", Icon: Send,         cls: "text-muted" },
  call:       { label: "Call",       Icon: Phone,        cls: "text-success-ink" },
  meeting:    { label: "Meeting",    Icon: Calendar,     cls: "text-success-ink" },
  note:       { label: "Note",       Icon: StickyNote,   cls: "text-muted" },
  checkup:    { label: "Check-in",   Icon: CheckCircle2, cls: "text-success-ink" },
  // In and out are deliberately distinct: "Email - 3d ago" read identically whether the
  // customer was waiting on us or we had chased them and heard nothing.
  email_in:   { label: "Email in",   Icon: Mail,         cls: "text-muted" },
  email_out:  { label: "Email out",  Icon: Send,         cls: "text-muted" },
  // Legacy rows from the mobile Add Note form, which used to write a bare "email".
  email:      { label: "Email",      Icon: Mail,         cls: "text-muted" },
};

const relTime = (d: string | null | undefined): string => {
  if (!d) return "Never";
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

const inp = "border border-line-3 px-3 h-9 rounded-lg text-[14px] w-full bg-transparent text-ink focus:outline-none focus:border-ink transition-colors duration-150";
// Toolbar selects (32px, like the outline buttons) and the compact variant for the bulk bar.
const sel = "border border-line-3 h-8 px-2.5 rounded-lg text-[13px] text-ink-2 bg-transparent focus:outline-none focus:border-ink transition-colors duration-150";
const selSm = "border border-line-3 h-7 px-2 rounded-lg text-[12.5px] text-ink-2 bg-transparent focus:outline-none focus:border-ink transition-colors duration-150";
const fld = "border border-line-3 h-8 px-2.5 rounded-lg text-[13px] w-full text-ink-2 bg-transparent focus:outline-none focus:border-ink transition-colors duration-150";

// Headline numbers are always read off the WHOLE client set, never off the
// filtered table, so they don't move as you type. A rejected lead was never
// accepted as a client, so it is out of every headline — the rows stay in the
// table, badged, so the difference is visible rather than mysterious.
const statsOf = (all: Client[]) => {
  const live = all.filter((c) => c.approval_status !== "rejected");
  return {
    total:    live.length,
    active:   live.filter((c) => c.lead_status === "active_customer").length,
    hotLeads: live.filter((c) => c.lead_status === "hot_lead").length,
    revenue:  live.reduce((s, c) => s + (c.total_revenue || 0), 0),
  };
};

// The table's sortable columns, in render order. The list opens sorted by profit,
// descending — that is the figure that decides who matters.
const COLUMNS = [
  ["name",    "Name",          "left"],
  ["company", "Company",       "left"],
  ["tier",    "Tier",          "left"],
  ["email",   "Email",         "left"],
  ["phone",   "Phone",         "left"],
  ["address", "Address",       "left"],
  ["last",    "Last activity", "left"],
  ["deals",   "Current deals", "right"],
  ["profit",  "Profit",        "right"],
  ["revenue", "Revenue",       "right"],
] as const;

// The three shortcuts offered by the sort dropdown; any other key comes from
// clicking a column header.
const SORT_CHOICES = ["profit", "revenue", "name"];

export default function ClientsView() {
  const [clients, setClients]               = useState<Client[]>([]);
  // Every client, regardless of the current filter — the source for the stats
  // bar, the pending banner and the unsubscribed count.
  const [allClients, setAllClients]         = useState<Client[]>([]);
  const [loading, setLoading]               = useState(true);
  const [editing, setEditing]               = useState<Client | null>(null);
  const [showForm, setShowForm]             = useState(false);
  const [detailId, setDetailId]             = useState<string | null>(null);
  const [activity, setActivity]             = useState<Record<string, { kind: string; at: string }>>({});
  const [inboxLinked, setInboxLinked]       = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced]     = useState(false);
  const [filter, setFilter]                 = useState<ClientFilter>({});
  const [searchText, setSearchText]         = useState("");
  const [missingInfo, setMissingInfo]       = useState<MissingInfoReport | null>(null);
  const [showHealth, setShowHealth]         = useState(false);
  const [allCategories, setAllCategories]   = useState<Category[]>([]);
  const [buyerTiers, setBuyerTiers]         = useState<BuyerTier[]>([]);
  const [dealFlows, setDealFlows]           = useState<DealFlow[]>([]);
  const [duplicates, setDuplicates]         = useState<DuplicateGroup[]>([]);
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set());
  // Inline "type DELETE to confirm" for bulk-deleting >10 clients — window.prompt()
  // is inert in the Tauri webview, so this mirrors LotEngineView's branch/combine
  // naming inputs (state + focused <input>) rather than a native dialog.
  const [deleteTyped, setDeleteTyped]       = useState<string | null>(null);
  const [showTiers, setShowTiers]           = useState(false);
  const [sortKey, setSortKey]               = useState<string>("profit");
  const [sortDir, setSortDir]               = useState<1 | -1>(-1);
  const [reps, setReps]                     = useState<string[]>([]);
  const [sources, setSources]               = useState<{ name: string; count: number }[]>([]);
  const [reviewId, setReviewId]             = useState<string | null>(null);
  // Client-side "never emailed" filter — reads the first_contact flag.
  const [fcOnly, setFcOnly]                 = useState(false);
  const [loadError, setLoadError]           = useState<string | null>(null);
  const del = useSubmit();
  const tierDropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const loadMissingInfo = () => {
    api.clientsMissingInfo().then(setMissingInfo).catch(console.error);
  };

  // Refresh the unfiltered set after anything that can add or remove a client.
  // Deliberately NOT called on filter/search changes — that was a full refetch
  // on every keystroke.
  const loadAll = useCallback(() => {
    api.listClients().then(setAllClients).catch(() => {});
  }, []);

  const loadActivity = useCallback(() => {
    api.clientLastActivity().then((rows) => {
      const m: Record<string, { kind: string; at: string }> = {};
      for (const r of rows) m[r.client_id] = { kind: r.kind, at: r.at };
      setActivity(m);
    }).catch(() => {});
  }, []);

  const applyFilter = useCallback(async (f: ClientFilter) => {
    const hasFilter = f.search || (f.tiers && f.tiers.length > 0) || f.category || f.tag || f.state || f.stale_days || f.missing || f.needs_review || f.unsubscribed || f.rep || f.sort_by || f.lead_status;
    setLoading(true);
    try {
      if (hasFilter) setClients(await api.listClientsFiltered(f));
      else setClients(await api.listClients());
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
    loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    loadActivity();
    api.getEmailInboxes().then((l) => setInboxLinked(l.length > 0)).catch(() => setInboxLinked(null));
    api.listClients().then((all) => {
      setClients(all);
      setAllClients(all);
    }).catch((e) => setLoadError(String(e))).finally(() => setLoading(false));
    api.listCategories().then(setAllCategories).catch(() => {});
    api.listClientReps().then(setReps).catch(() => {});
    api.listClientSources().then(setSources).catch(() => {});
    api.buyerTiers().then(setBuyerTiers).catch(() => {});
    api.listDealFlows().then(setDealFlows).catch(() => {});
    api.detectDuplicateClients().then(setDuplicates).catch(() => {});
    loadMissingInfo();

    const preselect = sessionStorage.getItem("clienthub.globe.clientId");
    if (preselect) {
      sessionStorage.removeItem("clienthub.globe.clientId");
      setDetailId(preselect);
    }

    const preFilter = sessionStorage.getItem("clienthub.clients.filter.missing");
    if (preFilter) {
      sessionStorage.removeItem("clienthub.clients.filter.missing");
      updateFilter({ missing: preFilter });
    }

    const savedSearch = localStorage.getItem("clienthub_clients_search");
    if (savedSearch) setSearchText(savedSearch);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = searchText.trim();
      // Keep the applied filter's `search` in lock-step with the box so later
      // filter changes (category/tier/etc.) don't silently drop the query — and
      // clearing the box restores the full list.
      setFilter((prev) => {
        const next = { ...prev };
        if (trimmed) next.search = trimmed; else delete next.search;
        applyFilter(next);
        return next;
      });
      if (trimmed) localStorage.setItem("clienthub_clients_search", trimmed);
      else localStorage.removeItem("clienthub_clients_search");
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchText]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tierDropdownRef.current && !tierDropdownRef.current.contains(e.target as Node)) setShowTiers(false);
    };
    if (showTiers) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTiers]);

  const updateFilter = (patch: Partial<ClientFilter>) => {
    const next = { ...filter, ...patch };
    Object.keys(patch).forEach((k) => {
      if (!patch[k as keyof ClientFilter]) delete (next as any)[k];
    });
    setFilter(next);
    applyFilter(next);
  };

  const clearAll = () => { setFilter({}); setSearchText(""); setFcOnly(false); applyFilter({}); };

  const summaryStats = useMemo(() => statsOf(allClients), [allClients]);

  const hasAnyFilter = filter.search || (filter.tiers && filter.tiers.length > 0) || filter.category || filter.tag || filter.state || filter.stale_days || filter.missing || filter.needs_review || filter.unsubscribed || filter.rep || filter.source || filter.sort_by || filter.lead_status;

  // Tier row per client, keyed — the sort reads it once per comparison, so the
  // repeated linear scan it replaced showed up on a 141-row list.
  const tierOf = useMemo(() => {
    const m = new Map<string, BuyerTier>();
    for (const t of buyerTiers) m.set(t.client_id, t);
    return m;
  }, [buyerTiers]);

  // Current deals = still in deal flow, same definition ClientDetailView uses for
  // its "in progress" band (stage !== "complete"). list_deal_flows already excludes
  // voided invoices, so a fell-through deal never counts here.
  const openDealsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of dealFlows) {
      if (f.stage === "complete" || !f.client_id) continue;
      m.set(f.client_id, (m.get(f.client_id) ?? 0) + 1);
    }
    return m;
  }, [dealFlows]);

  // Client-side sort by any column. Profit comes off the tier row (buyerTiers) —
  // it is net of refunds, and it can be negative.
  const TIER_RANK: Record<string, number> = { P: 6, S: 5, A: 4, B: 3, C: 2, New: 1, Prospect: 0 };
  const sortVal = (c: Client, key: string): string | number => {
    switch (key) {
      case "company": return (c.company || "").toLowerCase();
      case "email": return (c.email || "").toLowerCase();
      case "phone": return c.phone || "";
      case "profit": return tierOf.get(c.id)?.total_profit ?? 0;
      case "revenue": return c.total_revenue || 0;
      case "last": return activity[c.id]?.at || c.last_contact_at || "";
      case "tier": return TIER_RANK[tierOf.get(c.id)?.tier || "New"] ?? 0;
      case "address": return [c.city, c.state].filter(Boolean).join(", ").toLowerCase() || (c.street_address || "").toLowerCase();
      case "deals": return openDealsOf.get(c.id) ?? 0;
      default: return (c.name || "").toLowerCase();
    }
  };
  const sorted = [...clients].sort((a, b) => {
    const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    // Ties on a money column would otherwise fall in whatever order the query
    // returned; name keeps the list stable.
    return (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase());
  });
  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "profit" || key === "revenue" ? -1 : 1); }
  };
  // The dropdown shortcut. Revenue still asks the backend for its own ordering;
  // profit is computed here, so it clears that hint.
  const chooseSort = (key: string) => {
    setSortKey(key);
    setSortDir(key === "name" ? 1 : -1);
    const nextSortBy = key === "revenue" ? "revenue_desc" : undefined;
    if (nextSortBy !== filter.sort_by) updateFilter({ sort_by: nextSortBy });
  };

  // "No contact yet" is filtered client-side off the first_contact flag.
  const fcCount = clients.filter((c) => c.first_contact).length;
  const displayed = fcOnly ? sorted.filter((c) => c.first_contact) : sorted;

  const chips: { label: string; key: keyof ClientFilter }[] = [];
  const tierLabels: Record<string, string> = { P: "Platinum", S: "Diamond", A: "Gold", B: "Silver", C: "Bronze", Prospect: "Prospect" };
  if (filter.tiers && filter.tiers.length > 0) chips.push({ label: `Tiers: ${filter.tiers.map(t => tierLabels[t] || t).join(", ")}`, key: "tiers" });
  if (filter.category) chips.push({ label: `Category: ${filter.category === "__none__" ? "None" : filter.category}`, key: "category" });
  if (filter.tag) chips.push({ label: `Tag: ${filter.tag}`, key: "tag" });
  if (filter.state) chips.push({ label: `State: ${filter.state}`, key: "state" });
  if (filter.stale_days) chips.push({ label: `Last contact: ${filter.stale_days}+ days`, key: "stale_days" });
  if (filter.missing) chips.push({ label: `Missing: ${filter.missing}`, key: "missing" });
  if (filter.needs_review) chips.push({ label: "Needs review", key: "needs_review" });
  if (filter.unsubscribed) chips.push({ label: "Unsubscribed", key: "unsubscribed" });
  if (filter.rep) chips.push({ label: `Rep: ${filter.rep}`, key: "rep" });
  if (filter.source) chips.push({ label: `Source: ${filter.source}`, key: "source" });
  if (filter.lead_status) {
    const statusLabels: Record<string, string> = { active_not_dormant: "Active (not dormant)", prospect: "Prospect", hot_lead: "Hot lead", active_customer: "Active customer", inactive: "Dormant" };
    chips.push({ label: `Status: ${statusLabels[filter.lead_status] || filter.lead_status}`, key: "lead_status" });
  }

  const handleSave = async (input: ClientInput) => {
    if (editing) await api.updateClient(editing.id, input);
    else await api.createClient(input);
    setShowForm(false);
    setEditing(null);
    applyFilter(filter);
    loadAll();
    loadMissingInfo();
  };

  const handleDelete = async (id: string) => {
    const name = clients.find((c) => c.id === id)?.name || "this client";
    if (confirm(`Delete ${name}? This will also delete all their interactions. This cannot be undone.`)) {
      await del.run(async () => {
        await api.deleteClient(id);
        applyFilter(filter);
        loadAll();
        loadMissingInfo();
      });
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Select-all means "everything you can currently see" — never rows hidden by
  // the active filters.
  const allDisplayedSelected = displayed.length > 0 && displayed.every((c) => selectedIds.has(c.id));
  const toggleSelectAll = () => {
    setSelectedIds(allDisplayedSelected ? new Set() : new Set(displayed.map((c) => c.id)));
  };

  const runBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    let deleted = 0;
    try {
      deleted = await api.bulkDeleteClients(ids);
    } catch (e) {
      alert(`Couldn't delete: ${e}`);
      return;
    }
    setSelectedIds(new Set());
    applyFilter(filter);
    loadAll();
    loadMissingInfo();
    // The command skips any client the database refuses to delete (invoices,
    // deals or other records still point at it) and reports how many it got
    // through — say so rather than reporting a clean sweep.
    if (deleted < ids.length) {
      const failed = ids.length - deleted;
      alert(`Deleted ${deleted} of ${ids.length} clients. ${failed} couldn't be deleted because they still have invoices, deals or other linked records.`);
    }
  };

  const handleBulkDelete = async () => {
    const n = selectedIds.size;
    if (n > 10) {
      setDeleteTyped("");
      return;
    }
    if (!confirm(`Delete ${n} clients? This cannot be undone.`)) return;
    await runBulkDelete();
  };

  // Commits only on an exact "DELETE" match; anything else just closes the input.
  const commitDeleteTyped = () => {
    const typed = deleteTyped;
    setDeleteTyped(null);
    if (typed === "DELETE") runBulkDelete();
  };

  const handleBulkCategory = async (cat: string) => {
    const n = selectedIds.size;
    if (!confirm(`Apply category "${cat}" to ${n} clients?`)) return;
    await api.bulkUpdateCategory(Array.from(selectedIds), cat);
    setSelectedIds(new Set());
    applyFilter(filter);
  };

  const handleBulkLeadStatus = async (status: string) => {
    const n = selectedIds.size;
    if (!confirm(`Set status to "${status}" for ${n} clients?`)) return;
    await api.bulkUpdateLeadStatus(Array.from(selectedIds), status);
    setSelectedIds(new Set());
    applyFilter(filter);
    loadAll();
  };

  const handleBulkEmail = () => {
    if (selectedIds.size === 0) return;
    // Hand the selection to the Newsletter composer via sessionStorage, then
    // switch tabs. EmailView reads the stash once its client list has loaded.
    sessionStorage.setItem("email_preselect_ids", JSON.stringify(Array.from(selectedIds)));
    window.dispatchEvent(new CustomEvent("navigate-tab", { detail: "newsletter" }));
    setSelectedIds(new Set());
  };

  const handleExportCsv = async () => {
    const path = await saveDialog({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: "clients.csv" });
    if (!path) return;
    const count = await api.exportClientsCsv(Array.from(selectedIds), path as string);
    alert(`Exported ${count} clients to CSV.`);
  };

  const runCleanup = async () => {
    const groups = duplicates.length;
    const detail = groups > 0
      ? `merge ${groups} duplicate client group${groups === 1 ? "" : "s"} and remove empty placeholder clients`
      : "scan for duplicate and empty placeholder clients and merge/remove any it finds";
    if (!window.confirm(`This will permanently ${detail}.\n\nMerged clients' invoices, deals, quotes and history move to the client that's kept. This can't be undone.\n\nContinue?`)) return;
    let r: { duplicates_merged: number; ghosts_removed: number; remaining_clients: number };
    try {
      r = await api.cleanupClients();
    } catch (e) {
      alert(`Cleanup failed: ${e}`);
      return;
    }
    if (r.duplicates_merged > 0 || r.ghosts_removed > 0) {
      const msg = [];
      if (r.duplicates_merged > 0) msg.push(`${r.duplicates_merged} duplicates merged`);
      if (r.ghosts_removed > 0) msg.push(`${r.ghosts_removed} empty clients removed`);
      alert(`Done! ${msg.join(", ")}. ${r.remaining_clients} clients remaining.`);
    } else {
      alert(`No duplicates or empty clients found. ${r.remaining_clients} clients total.`);
    }
    api.listClients().then((all) => {
      setClients(all);
      setAllClients(all);
    }).catch(() => {});
    api.detectDuplicateClients().then(setDuplicates).catch(() => {});
    loadMissingInfo();
  };

  if (detailId) {
    return (
      <ClientDetailView
        clientId={detailId}
        onBack={() => { setDetailId(null); applyFilter(filter); }}
        onEdit={(c) => { setDetailId(null); setEditing(c); setShowForm(true); applyFilter(filter); }}
        onDeleted={() => { setDetailId(null); applyFilter(filter); loadAll(); loadMissingInfo(); }}
      />
    );
  }

  // Approvals and the unsubscribed tally describe the whole book of clients,
  // so they must not move when the table is filtered or searched.
  const pending = allClients.filter((c) => c.approval_status === "pending");
  const reviewClient = allClients.find((c) => c.id === reviewId) || null;

  return (
    <div>
      {reviewClient && (
        <PendingReviewModal
          client={reviewClient}
          onClose={() => setReviewId(null)}
          onResolved={async () => {
            const next = pending.find((c) => c.id !== reviewId);
            await applyFilter(filter);
            loadAll();
            setReviewId(next ? next.id : null);
          }}
        />
      )}

      <PageActions>
        <Button onClick={runCleanup}>Clean duplicates</Button>
        <Button variant="ink" icon={<Plus size={14} />} onClick={() => { setEditing(null); setShowForm(true); }}>
          New client
        </Button>
      </PageActions>

      {pending.length > 0 && (
        <button
          onClick={() => setReviewId(pending[0].id)}
          className="w-full mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-surface-2 text-left text-ink hover:bg-surface-3 transition-colors duration-150"
        >
          <span className="flex items-center gap-2.5 text-[13px]">
            <UserPlus size={16} className="text-warning-ink" />
            <span className="font-medium">
              {pending.length === 1 ? "1 new customer is" : `${pending.length} new customers are`} awaiting your approval
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-[13px] font-medium">Review <ArrowRight size={14} /></span>
        </button>
      )}

      {/* Headline numbers, read off the whole client set */}
      <div className="grid grid-cols-2 xl:grid-cols-[1fr_1px_1fr_1px_1fr_1px_1fr]">
        <Kpi label="Total clients" value={summaryStats.total} />
        <div className="vsep hidden xl:block mt-3" />
        <Kpi label="Active customers" value={summaryStats.active} />
        <div className="vsep hidden xl:block mt-3" />
        <Kpi label="Hot leads" value={summaryStats.hotLeads} />
        <div className="vsep hidden xl:block mt-3" />
        <Kpi label="Total revenue" value={summaryStats.revenue} format={fmtAmount} />
      </div>
      <div className="hsep" />

      {/* The lead programme: customer requests, booked calls, organic leads (moved from the dashboard) */}
      <LeadBubbles pendingApprovals={pending} onApprovalsChanged={() => { applyFilter(filter); loadAll(); window.dispatchEvent(new CustomEvent("approvals-changed")); }} />
      <div className="hsep mb-5" />

      <div className="flex flex-col gap-2.5 mb-4">
        {/* Inbox-not-linked flag: without a linked inbox, client email replies aren't
            captured, so "Last activity" is incomplete. */}
        {inboxLinked === false && (
          <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-surface-2 text-[13px] text-muted">
            <Mail size={15} className="flex-shrink-0" />
            <span className="flex-1">
              <span className="font-medium text-ink">Inbox not linked.</span> Customer email replies aren't being tracked, so <span className="font-medium text-ink">Last activity</span> may be incomplete. Link your inbox in <span className="font-medium text-ink">Settings, Email</span> to capture activity automatically.
            </span>
          </div>
        )}

        {/* Data health */}
        {missingInfo && missingInfo.total_incomplete > 0 && (
          <div>
            <button
              onClick={() => setShowHealth(!showHealth)}
              aria-expanded={showHealth}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors duration-150 text-left"
            >
              <span className="flex items-center gap-2.5 text-[13px] font-medium text-ink">
                <AlertCircle size={15} className="text-warning-ink" />
                {missingInfo.total_incomplete} client{missingInfo.total_incomplete !== 1 ? "s" : ""} have incomplete data
              </span>
              <ChevronDown size={15} className={`text-muted transition-transform duration-200 ${showHealth ? "rotate-180" : ""}`} />
            </button>
            {showHealth && (
              <div className="px-4 pt-1.5 pb-1">
                {[
                  { label: "Missing email",    count: missingInfo.missing_email.length,    icon: Mail,          missing: "email" },
                  { label: "Missing phone",    count: missingInfo.missing_phone.length,    icon: Phone,         missing: "phone" },
                  { label: "Missing address",  count: missingInfo.missing_address.length,  icon: MapPin,        missing: "address" },
                  { label: "Missing category", count: missingInfo.missing_category.length, icon: Tag,           missing: "category" },
                  { label: "Never contacted",  count: missingInfo.never_contacted.length,  icon: MessageSquare, missing: undefined },
                  { label: "Needs review",     count: missingInfo.needs_review.length,     icon: AlertCircle,   needs_review: true },
                  { label: "Unsubscribed",     count: allClients.filter((c: any) => c.metadata?.unsubscribed).length, icon: Ban, unsubscribed: true },
                ].map((row: any) => (
                  <div key={row.label} className="flex items-center justify-between min-h-[40px] py-1.5 shadow-[inset_0_1px_0_rgb(var(--c-line))] first:shadow-none">
                    <span className="flex items-center gap-2.5 text-[13px] text-ink-2">
                      <row.icon size={14} className="text-muted" />
                      {row.label}
                      <span className="ui-count">{row.count}</span>
                    </span>
                    <button
                      onClick={() => {
                        const patch: Partial<ClientFilter> = {};
                        if (row.missing) patch.missing = row.missing;
                        if (row.label === "Never contacted") patch.stale_days = 9999;
                        if (row.needs_review) patch.needs_review = true;
                        if (row.unsubscribed) patch.unsubscribed = true;
                        updateFilter(patch);
                      }}
                      className="ui-link"
                    >
                      View
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Duplicates banner */}
        {duplicates.length > 0 && (
          <div className="rounded-xl bg-surface-2 px-4 py-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2.5 text-[13px] font-medium text-danger-ink">
                <AlertCircle size={15} /> {duplicates.reduce((s, g) => s + g.count - 1, 0)} potential duplicates found
              </span>
              <Button variant="danger" size="sm" onClick={runCleanup}>Auto-merge all</Button>
            </div>
            {duplicates.map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-3 text-[13px]">
                <div className="text-ink-2 min-w-0 truncate">
                  <span className="font-medium text-ink">{g.key}</span>
                  <span className="text-muted ml-1.5">{g.names.join(", ")}</span>
                </div>
                <div className="flex items-center gap-3">
                  {g.client_ids.slice(1).map((id, i) => (
                    <button
                      key={id}
                      onClick={async () => { if (!window.confirm("Delete this duplicate client? If your workspace requires approval, it'll be queued for an admin instead.")) return; try { await api.deleteClient(id); } catch (e) { alert(`Couldn't delete: ${e}`); return; } setDuplicates(duplicates.filter((d) => d.key !== g.key)); loadMissingInfo(); }}
                      className="ui-link text-danger-ink"
                    >
                      Delete #{i + 2}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {missingInfo && missingInfo.total_incomplete === 0 && duplicates.length === 0 && (
          <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-surface-2 text-[13px] font-medium text-success-ink">
            <CheckCircle2 size={15} /> All client data complete
          </div>
        )}
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <label className="ui-search relative flex-1 min-w-[220px]">
          <Search size={14} className="flex-shrink-0" />
          <input
            placeholder="Search by name, company, email, or phone"
            aria-label="Search clients"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="flex-1 w-full"
          />
          {searchText && (
            <button
              onClick={(e) => { e.preventDefault(); setSearchText(""); }}
              title="Clear search"
              aria-label="Clear search"
              className="ui-ib -mr-2"
            >
              <X size={14} />
            </button>
          )}
        </label>
        <select
          value={filter.category ?? ""}
          onChange={(e) => updateFilter({ category: e.target.value || undefined })}
          aria-label="Category"
          className={sel}
        >
          <option value="">All categories</option>
          <option value="__none__">No category</option>
          {allCategories.map((c) => <option key={c.id} value={c.label}>{c.label}</option>)}
        </select>
        {reps.length > 0 && (
          <select
            value={filter.rep ?? ""}
            onChange={(e) => updateFilter({ rep: e.target.value || undefined })}
            aria-label="Rep"
            className={sel}
          >
            <option value="">All reps</option>
            {reps.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {/* R-285: where each client signed up from, with how many came from each. */}
        {sources.length > 0 && (
          <select
            value={filter.source ?? ""}
            onChange={(e) => updateFilter({ source: e.target.value || undefined })}
            aria-label="Source"
            className={sel}
          >
            <option value="">All sources</option>
            {sources.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.count})</option>)}
          </select>
        )}
        <div className="relative" ref={tierDropdownRef}>
          <button onClick={() => setShowTiers(!showTiers)} aria-haspopup="true" aria-expanded={showTiers}
            className={`ui-btn ${(filter.tiers?.length ?? 0) > 0 ? "ui-btn-soft" : ""}`}>
            {(filter.tiers?.length ?? 0) > 0 ? `${filter.tiers!.length} tier${filter.tiers!.length > 1 ? "s" : ""}` : "All tiers"} <ChevronDown size={13} />
          </button>
          {showTiers && (
            <div className="ui-pop top-full mt-1 left-0 min-w-[170px]" role="menu">
              {(["P","S","A","B","C","Prospect"] as const).map((t) => (
                <label key={t} className="ui-pop-item justify-start gap-2.5 cursor-pointer">
                  <input type="checkbox" className="accent-accent" checked={(filter.tiers ?? []).includes(t)}
                    onChange={() => {
                      const cur = filter.tiers ?? [];
                      const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
                      updateFilter({ tiers: next.length > 0 ? next : undefined });
                    }} />
                  <TierBadge tier={t} size="sm" />
                </label>
              ))}
            </div>
          )}
        </div>
        {fcCount > 0 && (
          <button
            onClick={() => setFcOnly((v) => !v)}
            title="Clients you've never emailed"
            className={`ui-btn ${fcOnly ? "ui-btn-soft" : ""}`}
          >
            No contact yet, {fcCount}
          </button>
        )}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`ui-btn ${showAdvanced ? "ui-btn-soft" : ""}`}
        >
          <SlidersHorizontal size={14} /> Filters
        </button>
        <select value={SORT_CHOICES.includes(sortKey) ? sortKey : "column"} onChange={(e) => chooseSort(e.target.value)}
          aria-label="Sort" className={sel}>
          {!SORT_CHOICES.includes(sortKey) && (
            <option value="column" disabled>Sort: {COLUMNS.find(([k]) => k === sortKey)?.[1] ?? sortKey}</option>
          )}
          <option value="profit">Sort: Profit, highest first</option>
          <option value="revenue">Sort: Revenue, highest first</option>
          <option value="name">Sort: Name A to Z</option>
        </select>
      </div>

      {/* Advanced filters */}
      {showAdvanced && (
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 py-4 mb-3 shadow-[inset_0_1px_0_rgb(var(--c-line)),inset_0_-1px_0_rgb(var(--c-line))]">
          <div>
            <label className="ui-label block mb-1.5">State</label>
            <input placeholder="e.g. NY" value={filter.state ?? ""} onChange={(e) => updateFilter({ state: e.target.value || undefined })}
              className={fld} />
          </div>
          <div>
            <label className="ui-label block mb-1.5">Tag</label>
            <input placeholder="e.g. vip" value={filter.tag ?? ""} onChange={(e) => updateFilter({ tag: e.target.value || undefined })}
              className={fld} />
          </div>
          <div>
            <label className="ui-label block mb-1.5">Status</label>
            <select value={filter.lead_status ?? ""} onChange={(e) => updateFilter({ lead_status: e.target.value || undefined })}
              className={fld}>
              <option value="">Any status</option>
              <option value="active_not_dormant">Active (not dormant)</option>
              <option value="prospect">Prospect</option>
              <option value="hot_lead">Hot lead</option>
              <option value="active_customer">Active customer</option>
              <option value="inactive">Dormant only</option>
            </select>
          </div>
          <div>
            <label className="ui-label block mb-1.5">Last contact</label>
            <select value={filter.stale_days ?? ""} onChange={(e) => updateFilter({ stale_days: e.target.value ? Number(e.target.value) : undefined })}
              className={fld}>
              <option value="">Any time</option>
              <option value="30">30+ days</option>
              <option value="60">60+ days</option>
              <option value="90">90+ days</option>
              {filter.stale_days === 9999 && <option value="9999">Never contacted</option>}
            </select>
          </div>
          <div>
            <label className="ui-label block mb-1.5">Missing info</label>
            <select value={filter.missing ?? ""} onChange={(e) => updateFilter({ missing: e.target.value || undefined })}
              className={fld}>
              <option value="">Any</option>
              <option value="email">Missing email</option>
              <option value="phone">Missing phone</option>
              <option value="address">Missing address</option>
              <option value="category">Missing category</option>
            </select>
          </div>
          <div className="col-span-2 xl:col-span-5 flex justify-end">
            <button onClick={clearAll} className="ui-link muted">
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {chips.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {chips.map((chip) => (
            <span key={chip.key} className="inline-flex items-center gap-1 bg-surface-3 text-ink-2 pl-2.5 pr-1 h-6 rounded-full text-[12px] font-medium">
              {chip.label}
              <button onClick={() => updateFilter({ [chip.key]: undefined })} aria-label="Remove filter" className="hover:bg-surface-2 rounded-full p-0.5 transition-colors duration-150">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {(hasAnyFilter || fcOnly) && (
        <div className="ui-note mb-3">
          Showing {displayed.filter((c) => c.approval_status !== "rejected").length} of {summaryStats.total} clients
        </div>
      )}

      {/* Inline form */}
      {showForm && (
        <ClientForm
          initial={editing}
          categories={allCategories}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditing(null); }}
        />
      )}

      {/* Bulk toolbar */}
      {selectedIds.size > 0 && (
        <div className="bg-surface-3 rounded-xl px-4 py-2.5 mb-3 flex items-center gap-2.5 flex-wrap">
          <span className="text-[13px] font-medium text-ink">{selectedIds.size} selected</span>
          <button onClick={() => setSelectedIds(new Set())} className="ui-link muted">Clear</button>
          <div className="flex-1" />
          <select className={selSm} aria-label="Set category for selected" value="" onChange={(e) => { if (e.target.value) handleBulkCategory(e.target.value); }}>
            <option value="">Category...</option>
            {allCategories.map((cat) => <option key={cat.id} value={cat.label}>{cat.label}</option>)}
          </select>
          <select className={selSm} aria-label="Set status for selected" value="" onChange={(e) => { if (e.target.value) handleBulkLeadStatus(e.target.value); }}>
            <option value="">Status...</option>
            <option value="prospect">Prospect</option>
            <option value="hot_lead">Hot lead</option>
            <option value="active_customer">Active customer</option>
            <option value="inactive">Dormant</option>
          </select>
          <Button size="sm" icon={<Send size={13} />} onClick={handleBulkEmail}>Email</Button>
          <Button size="sm" icon={<Download size={13} />} onClick={handleExportCsv}>Export CSV</Button>
          {deleteTyped === null ? (
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={handleBulkDelete}>Delete</Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                className="h-7 px-2.5 rounded-lg text-[12.5px] border border-danger text-ink placeholder:text-faint focus:outline-none w-[230px]"
                placeholder={`Type DELETE to confirm deleting ${selectedIds.size}`}
                value={deleteTyped}
                onChange={(e) => setDeleteTyped(e.target.value)}
                onBlur={() => setDeleteTyped(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitDeleteTyped();
                  if (e.key === "Escape") setDeleteTyped(null);
                }}
              />
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 size={13} />}
                onMouseDown={(e) => e.preventDefault()}
                onClick={commitDeleteTyped}
              >
                Confirm
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="ui-table ui-table-click min-w-[1120px]">
          <thead>
            <tr>
              <th className="w-10">
                <input type="checkbox" className="accent-accent" aria-label="Select all shown" checked={allDisplayedSelected} onChange={toggleSelectAll} />
              </th>
              {COLUMNS.map(([k, label, align]) => (
                <th key={k} onClick={() => toggleSort(k)}
                  className={`text-${align} cursor-pointer select-none hover:text-ink transition-colors duration-150`}>
                  <span className={`inline-flex items-center gap-1 ${sortKey === k ? "text-ink" : ""}`}>
                    {label}
                    {sortKey === k && (sortDir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </span>
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((c) => {
              const bt = tierOf.get(c.id);
              // Status flags as data, so the row can cap how many it renders. The name cell is
              // only ~118px wide at a 900px window; letting these wrap tripled the row height.
              const flags: { tone: "accent" | "danger" | "neutral"; label: string; title: string }[] = [];
              if (c.is_blacklisted) {
                flags.push({ tone: "danger", label: "Blacklisted", title: "Blacklisted: excluded from all sends" });
              } else {
                if (c.metadata?.high_value) flags.push({ tone: "accent", label: "High value", title: "High-Value: one of your best buyers (label only)" });
                if (c.metadata?.unsubscribed) flags.push({ tone: "neutral", label: "Unsubscribed", title: "Unsubscribed: opted out via an email link; kept off all sends" });
                if (c.metadata?.exclusive && !c.metadata?.unsubscribed) flags.push({ tone: "accent", label: "No bulk", title: "No bulk-email: kept off mass newsletters & auto-add" });
                if (c.first_contact) flags.push({ tone: "accent", label: "No contact yet", title: "Never been sent an email: introduce yourself" });
              }
              if (c.approval_status === "pending") flags.push({ tone: "accent", label: "Pending", title: "Pending approval" });
              if (c.approval_status === "rejected") flags.push({ tone: "neutral", label: "Rejected", title: "Rejected: kept for the record, and left out of the headline counts" });
              const missingInfo = !c.email || !c.phone || !c.street_address || !c.category;
              return (
                <tr
                  key={c.id}
                  onClick={() => setDetailId(c.id)}
                  aria-selected={selectedIds.has(c.id) ? true : undefined}
                >
                  <td className="w-10" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="accent-accent" aria-label={`Select ${c.name}`} checked={selectedIds.has(c.id)} onChange={() => toggleSelect(c.id)} />
                  </td>
                  <td className="text-[14px] font-medium text-ink max-w-[240px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {c.needs_review && <AlertCircle size={13} className="text-warning-ink flex-shrink-0" />}
                      <span className="truncate">{c.name}</span>
                    </div>
                    {(flags.length > 0 || missingInfo) && (
                      <div className="flex items-center gap-1 mt-1 flex-nowrap overflow-hidden">
                        {flags.slice(0, 2).map((f) => (
                          <StatusPill key={f.label} tone={f.tone} title={f.title}>{f.label}</StatusPill>
                        ))}
                        {flags.length > 2 && (
                          <StatusPill tone="neutral" title={flags.slice(2).map((f) => f.label).join(", ")}>
                            +{flags.length - 2}
                          </StatusPill>
                        )}
                        {missingInfo && (
                          <span className="inline-flex items-center gap-0.5 text-faint flex-shrink-0" title="Missing profile info (email, phone, address or category)">
                            {!c.email && <Mail size={11} />}
                            {!c.phone && <Phone size={11} />}
                            {!c.street_address && <MapPin size={11} />}
                            {!c.category && <Tag size={11} />}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="text-[13px] text-muted">{c.company || "-"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col items-start gap-1">
                      <TierBadge tier={bt ? bt.tier : "New"} size="sm" />
                      {bt && <ReliabilityBadge reliability={bt.reliability} pct={bt.reliability_pct} quotesSent={bt.quotes_sent} quotesWon={bt.quotes_won} compact />}
                    </div>
                  </td>
                  <td className="text-[13px] text-muted">{c.email || "-"}</td>
                  <td className="text-[13px] text-muted whitespace-nowrap">{c.phone ? fmtPhone(c.phone) : "-"}</td>
                  <td className="text-[13px] text-muted whitespace-nowrap">
                    {[c.city, c.state].filter(Boolean).join(", ") || c.street_address || <span className="text-faint">-</span>}
                  </td>
                  <td>
                    {(() => {
                      const a = activity[c.id];
                      const at = a?.at || c.last_contact_at;
                      const meta = a ? ACTIVITY_META[a.kind] : undefined;
                      if (!at) return <span className="text-[13px] text-faint">-</span>;
                      const Icon = meta?.Icon || Clock;
                      return (
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted whitespace-nowrap">
                          <Icon size={13} className={meta?.cls || "text-faint"} />
                          {meta && <span className={`font-medium ${meta.cls}`}>{meta.label}</span>}
                          <span>{relTime(at)}</span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="r text-[13px] text-muted">
                    {openDealsOf.get(c.id) ?? 0}
                  </td>
                  <td className={`r font-medium ${
                    (bt?.total_profit ?? 0) < 0 ? "text-danger-ink" : "text-ink"
                  }`}>
                    {bt && bt.total_profit !== 0
                      ? <>{fmtAmount(bt.total_profit)}</>
                      : <span className="text-faint">-</span>}
                  </td>
                  <td className="r text-[13px] text-muted">
                    {fmtAmount(c.total_revenue || 0)}
                  </td>
                  <td className="text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex items-center">
                      <button onClick={async (ev) => { ev.stopPropagation(); const val = await api.toggleClientBlacklist(c.id); const updated = clients.find(x => x.id === c.id); if (updated) updated.is_blacklisted = val; setClients([...clients]); }}
                        title={c.is_blacklisted ? "Remove from blacklist" : "Blacklist"}
                        aria-label={c.is_blacklisted ? "Remove from blacklist" : "Blacklist"}
                        className={`ui-ib ${c.is_blacklisted ? "!text-danger-ink" : "hover:!text-danger-ink"}`}>
                        <Ban size={14} />
                      </button>
                      <button onClick={() => { setEditing(c); setShowForm(true); }} title="Edit" aria-label="Edit" className="ui-ib">
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => handleDelete(c.id)} disabled={del.busy} title="Delete" aria-label="Delete"
                        className="ui-ib hover:!text-danger-ink disabled:opacity-40">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {loadError && (
              <tr>
                <td colSpan={12} className="py-16 text-center">
                  <p className="text-[14px] text-danger-ink mb-3">Couldn't load clients. {loadError}</p>
                  <Button onClick={() => applyFilter(filter)}>Try again</Button>
                </td>
              </tr>
            )}
            {loading && displayed.length === 0 && !loadError && (
              <tr>
                <td colSpan={12} className="py-16 text-center text-[14px] text-muted">
                  Loading clients...
                </td>
              </tr>
            )}
            {!loading && !loadError && displayed.length === 0 && (
              <tr>
                <td colSpan={12} className="py-16 text-center">
                  {hasAnyFilter || fcOnly ? (
                    <p className="text-[14px] text-muted">No clients match the current filters</p>
                  ) : (
                    <div className="flex flex-col items-center">
                      <Users size={18} className="text-muted mb-3" />
                      <p className="text-[15px] font-medium text-ink mb-1">No clients yet</p>
                      <p className="text-[14px] text-muted mb-4">Add your first client to get started</p>
                      <Button variant="ink" icon={<Plus size={14} />} onClick={() => { setEditing(null); setShowForm(true); }}>
                        Add client
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClientForm({
  initial, categories, onSave, onCancel,
}: { initial: Client | null; categories: Category[]; onSave: (input: ClientInput) => Promise<unknown>; onCancel: () => void; }) {
  const [form, setForm] = useState<ClientInput>({
    name: initial?.name ?? "", email: initial?.email ?? "", phone: initial?.phone ?? "",
    company: initial?.company ?? "", notes: initial?.notes ?? "",
    lead_status: initial?.lead_status ?? "prospect", category: initial?.category ?? "",
    tags: initial?.tags ?? "", street_address: initial?.street_address ?? "",
    city: initial?.city ?? "", state: initial?.state ?? "", zip_code: initial?.zip_code ?? "",
    country: initial?.country ?? "",
    next_follow_up_date: initial?.next_follow_up_date ?? "", needs_review: initial?.needs_review ?? false,
  });

  const set = (k: keyof ClientInput, v: string | boolean | null) => setForm({ ...form, [k]: v });
  const { busy, run } = useSubmit();

  return (
    <div className="pt-5 pb-2 mb-3 shadow-[inset_0_1px_0_rgb(var(--c-line)),inset_0_-1px_0_rgb(var(--c-line))]">
      <h3 className="text-[16px] font-medium text-ink mb-4">{initial ? "Edit client" : "New client"}</h3>

      <div className="mb-5">
        <div className="ui-label mb-2">Basic info</div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Field label="Name *"><input className={inp} value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Company"><input className={inp} value={form.company ?? ""} onChange={(e) => set("company", e.target.value)} /></Field>
          <Field label="Email"><input className={inp} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Phone"><input className={inp} type="tel" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
        </div>
      </div>

      <div className="mb-5">
        <div className="ui-label mb-2">Classification</div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <Field label="Category">
            <input className={inp} list="categories" value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} />
          </Field>
          {/* One vocabulary, the underscore set the stats and the filters read.
              The spaced spellings this form used to write ("hot lead", "active
              customer") were a second vocabulary that matched nothing. */}
          <Field label="Lead status">
            <select className={inp} value={form.lead_status ?? "prospect"} onChange={(e) => set("lead_status", e.target.value)}>
              <option value="prospect">Prospect</option>
              <option value="hot_lead">Hot lead</option>
              <option value="active_customer">Active customer</option>
              <option value="inactive">Dormant</option>
            </select>
          </Field>
          <Field label="Tags"><input className={inp} placeholder="e.g. vip, new-york" value={form.tags ?? ""} onChange={(e) => set("tags", e.target.value)} /></Field>
        </div>
        <datalist id="categories">{categories.map((c) => <option key={c.id} value={c.label} />)}</datalist>
      </div>

      <div className="mb-5">
        <div className="ui-label mb-2">Address</div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="col-span-2 xl:col-span-4">
            <Field label="Street address"><input className={inp} value={form.street_address ?? ""} onChange={(e) => set("street_address", e.target.value)} /></Field>
          </div>
          <Field label="City"><input className={inp} value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label="State or province"><input className={inp} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
          <Field label="ZIP or postal"><input className={inp} value={form.zip_code ?? ""} onChange={(e) => set("zip_code", e.target.value)} /></Field>
          <Field label="Country"><input className={inp} value={form.country ?? ""} onChange={(e) => set("country", e.target.value)} placeholder="e.g. United States, Canada" /></Field>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input type="checkbox" id="needs-review" checked={form.needs_review ?? false}
            onChange={(e) => set("needs_review", e.target.checked)}
            className="accent-accent" />
          <label htmlFor="needs-review" className="text-[13px] text-ink-2">Needs more information or review</label>
        </div>
      </div>

      <div className="mb-5">
        <div className="ui-label mb-2">Notes and follow-up</div>
        <div className="grid grid-cols-1 xl:grid-cols-[3fr_1fr] gap-3">
          <Field label="Internal notes">
            <textarea rows={3} className={inp + " py-2 h-auto"} placeholder="Private notes about this client"
              value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Field label="Next follow-up date">
            <input className={inp} type="date" value={form.next_follow_up_date ?? ""} onChange={(e) => set("next_follow_up_date", e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-2 pb-3">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="ink" onClick={() => run(() => onSave(form))} disabled={busy || !form.name.trim()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="ui-label block mb-1.5">{label}</label>
      {children}
    </div>
  );
}
