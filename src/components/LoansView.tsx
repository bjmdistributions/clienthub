import { Fragment, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Plus, Save, Trash2, X, Pencil, CheckCircle2, Landmark, ChevronRight, Loader2, RotateCcw, RefreshCw, AlertTriangle } from "lucide-react";
import { api, Loan, LoanLedger } from "../lib/api";
import { fmtAmount, localDay, parseAmount } from "../lib/format";
import { toast } from "./Toast";
import StatusPill from "./StatusPill";
import { Button, Kpi, PageActions } from "./ui";

const today = () => localDay();

// received_at is a "YYYY-MM-DD" date string; anchor it to local midnight so it
// doesn't slip a day in negative timezones.
const fmtDate = (s: string) => {
  if (!s) return "No date";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime())
    ? "No date"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export default function LoansView() {
  const [loans,    setLoans]    = useState<Loan[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId,setEditingId]= useState<string | null>(null);
  const [saving,   setSaving]   = useState(false);

  // Add / edit form fields (money bound to a raw string so it can be cleared).
  const [fName,      setFName]      = useState("");
  const [fLender,    setFLender]    = useState("");
  const [fPrincipal, setFPrincipal] = useState("");
  const [fReceived,  setFReceived]  = useState(today());
  const [fNote,      setFNote]      = useState("");

  // Single active "set aside" inline editor.
  const [asideId,  setAsideId]  = useState<string | null>(null);
  const [asideBuf, setAsideBuf] = useState("");

  // Feed activity (transactions tagged to each loan): ledger cache + expansion.
  const [ledgers,  setLedgers]  = useState<Record<string, LoanLedger>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError,  setLoadError]  = useState<string | null>(null);

  const load = async () => {
    const ls = await api.listLoans();
    setLoans(ls);
    // Preload ledgers so each card's feed summary is accurate before expanding.
    const pairs = await Promise.all(
      ls.map(async (l) => [l.id, await api.loanLedger(l.id).catch(() => null)] as const),
    );
    setLedgers(Object.fromEntries(pairs.filter(([, v]) => v) as [string, LoanLedger][]));
  };

  // A failed load left `loans` empty, which is pixel-identical to "no loans yet" —
  // so a broken read looked like your loans had disappeared.
  const refresh = async (showSpinner = true) => {
    if (showSpinner) setRefreshing(true);
    try { await load(); setLoadError(null); }
    catch (e: any) { setLoadError(String(e?.message || e)); }
    finally { setRefreshing(false); setLoading(false); }
  };

  useEffect(() => { refresh(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Loans move when another admin tags a repayment in the feed — without this the
  // tab sat stale with no way to refresh at all.
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen("netsync-applied", () => { refresh(false).catch(() => {}); })
      .then((u) => { if (dead) u(); else un = u; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const applyToSetAside = async (l: Loan) => {
    setApplyingId(l.id);
    try {
      await api.applyLoanRepaymentsToSetAside(l.id);
      await load();
    } catch (e: any) { toast(String(e), "error"); }
    finally {
      setApplyingId(null);
    }
  };

  const totalOutstanding = useMemo(
    () => loans.filter((l) => l.status === "open").reduce((s, l) => s + l.outstanding, 0),
    [loans],
  );
  const openCount = useMemo(() => loans.filter((l) => l.status === "open").length, [loans]);

  const openCreate = () => {
    setEditingId(null);
    setFName(""); setFLender(""); setFPrincipal(""); setFReceived(today()); setFNote("");
    setShowForm(true);
  };

  const openEdit = (l: Loan) => {
    setEditingId(l.id);
    setFName(l.name);
    setFLender(l.lender);
    setFPrincipal(String(l.principal));
    setFReceived(l.received_at ? l.received_at.slice(0, 10) : today());
    setFNote(l.note);
    setShowForm(true);
    setAsideId(null);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); };

  const saveForm = async () => {
    if (!fName.trim()) return;
    const principal = parseAmount(fPrincipal);
    setSaving(true);
    try {
      if (editingId) {
        const l = loans.find((x) => x.id === editingId);
        if (l) {
          // Edit keeps set_aside + status; name/lender/principal/note/received date editable.
          await api.updateLoan(editingId, fName.trim(), fLender.trim(), principal, l.set_aside, l.status, fNote, fReceived);
        }
      } else {
        await api.createLoan(fName.trim(), fLender.trim(), principal, fReceived, "", fNote);
      }
      await load();
      closeForm();
    } catch (e: any) { toast(String(e), "error"); }
    finally {
      setSaving(false);
    }
  };

  const startAside = (l: Loan) => {
    setAsideId(l.id);
    setAsideBuf(String(l.set_aside));
    setShowForm(false);
  };

  const saveAside = async (l: Loan) => {
    const setAside = parseAmount(asideBuf);
    try {
      await api.updateLoan(l.id, l.name, l.lender, l.principal, setAside, l.status, l.note);
      setAsideId(null);
      await load();
    } catch (e: any) { toast(String(e), "error"); }
  };

  const markPaid = async (l: Loan) => {
    if (!confirm(`Mark "${l.name}" as paid off? It drops out of your outstanding loans and Free Cash.`)) return;
    try { await api.updateLoan(l.id, l.name, l.lender, l.principal, l.set_aside, "paid", l.note); await load(); }
    catch (e: any) { toast(String(e), "error"); }
  };

  // Reopen a loan mis-marked as paid — the backend clears paid_at on any non-'paid'
  // status, so it returns to outstanding.
  const reopenLoan = async (l: Loan) => {
    try { await api.updateLoan(l.id, l.name, l.lender, l.principal, l.set_aside, "open", l.note); await load(); }
    catch (e: any) { toast(String(e), "error"); }
  };

  const removeLoan = async (l: Loan) => {
    // Say how many transactions this touches BEFORE asking. Deleting used to leave
    // them tagged to a loan that no longer existed, where they showed as a nameless
    // loan row and stayed out of the review queue.
    const n = ledgers[l.id]?.entries.length ?? 0;
    const tail = n > 0
      ? `\n\n${n} tagged transaction${n === 1 ? "" : "s"} will be returned to your review queue, unclassified. The transactions themselves are not deleted.`
      : "";
    if (!confirm(`Delete loan "${l.name}"? This can't be undone.${tail}`)) return;
    try {
      const untagged = await api.deleteLoan(l.id);
      await refresh(false);
      toast(untagged > 0 ? `Loan deleted · ${untagged} transaction${untagged === 1 ? "" : "s"} returned to your queue` : "Loan deleted");
    }
    catch (e: any) { toast(String(e?.message || e), "error"); }
  };

  return (
    <div className="space-y-6 max-w-[1120px]">

      <PageActions>
        <Button
          onClick={() => refresh()}
          disabled={refreshing}
          title="Refresh"
          icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
        >
          Refresh
        </Button>
        <Button variant="ink" onClick={openCreate} icon={<Plus size={14} />}>Add loan</Button>
      </PageActions>
      <p className="text-[13px] text-muted -mb-2">
        Money you received and owe back. It sits in your bank but reduces your free cash until it is paid off.
      </p>

      {loadError && (
        <div className="flex items-start gap-2 border-y border-line py-3">
          <AlertTriangle size={15} className="text-danger-ink flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-ink-2">Could not load your loans</div>
            <div className="text-[12px] text-muted mt-0.5 break-words">{loadError}</div>
            <div className="text-[11.5px] text-faint mt-0.5">Nothing has changed. This is a read that failed.</div>
            <button onClick={() => refresh()} className="mt-1.5 text-[12px] font-medium text-ink hover:opacity-70">
              Try again
            </button>
          </div>
        </div>
      )}

      <Kpi label="Total outstanding" value={totalOutstanding} format={fmtAmount} caption={`across ${openCount} open loan${openCount !== 1 ? "s" : ""}`} className="!px-0" />

      {/* Add / edit form */}
      {showForm && (
        <div className="border-y border-line py-5 space-y-4 dash-load">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-medium text-ink">
              {editingId ? "Edit loan" : "Add loan"}
            </h3>
            <button
              onClick={closeForm}
              className="ui-ib"
              aria-label="Close the form"
            >
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Loan name">
              <input
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="e.g. Smart Source seed"
                className="field-input"
              />
            </Field>
            <Field label="Lender">
              <input
                value={fLender}
                onChange={(e) => setFLender(e.target.value)}
                placeholder="Who lent it"
                className="field-input"
              />
            </Field>
            <Field label="Amount received">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={fPrincipal}
                  onChange={(e) => setFPrincipal(e.target.value)}
                  className="field-input tabular-nums"
                  style={{ paddingLeft: 22 }}
                />
              </div>
            </Field>
            <Field label="Date received">
              <input
                type="date"
                value={fReceived}
                onChange={(e) => setFReceived(e.target.value)}
                className="field-input tabular-nums"
              />
            </Field>
          </div>

          <Field label="Note">
            <textarea
              value={fNote}
              onChange={(e) => setFNote(e.target.value)}
              rows={2}
              placeholder="Optional: terms, purpose, etc."
              className="field-input resize-none"
            />
          </Field>

          <div className="flex items-center gap-2">
            <button
              onClick={saveForm}
              disabled={saving || !fName.trim()}
              className="ui-btn ui-btn-ink disabled:opacity-50"
            >
              <Save size={14} /> {saving ? "Saving…" : editingId ? "Save changes" : "Add loan"}
            </button>
            <button
              onClick={closeForm}
              className="ui-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loan list */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : loans.length === 0 && loadError ? null : loans.length === 0 ? (
        <div className="text-center py-20">
          <div className="flex items-center justify-center mx-auto mb-3 text-faint">
            <Landmark size={18} className="text-faint" />
          </div>
          <p className="text-[14px] font-medium text-ink-2">No loans yet</p>
          <p className="text-[12px] text-muted mt-1">Record money the business borrowed to track what you owe back</p>
          <button onClick={openCreate} className="mt-3 text-[12px] font-medium text-ink hover:opacity-70">
            + Add loan
          </button>
        </div>
      ) : (
        <div>
          {loans.map((l) => {
            const paid = l.status === "paid";
            const led = ledgers[l.id];
            const feedOpen = expanded.has(l.id);
            const canApply = !paid && led && led.repaid_total > l.set_aside + 0.0001;
            return (
              <div
                key={l.id}
                className={`border-t border-line py-5 min-w-0 transition-opacity duration-200 ${paid ? "opacity-60" : ""}`}
              >
                {/* Top: name / lender + status */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium text-ink truncate">{l.name}</div>
                    <div className="ui-note mt-0.5 truncate">
                      {l.lender || "No lender"} · received {fmtDate(l.received_at)}
                    </div>
                  </div>
                  <StatusPill tone={paid ? "success" : "warning"}>{paid ? "Paid off" : "Open"}</StatusPill>
                </div>

                {/* Money row */}
                <div className="grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)] mb-3 max-w-[720px]">
                  {[
                    { label: "Principal",   value: fmtAmount(l.principal),   cls: "text-ink" },
                    { label: "Set aside",   value: fmtAmount(l.set_aside),   cls: "text-ink-2" },
                    { label: "Outstanding", value: fmtAmount(l.outstanding), cls: paid ? "text-success-ink" : "text-ink" },
                  ].map((m, i) => (
                    <Fragment key={m.label}>
                      {i > 0 && <div className="vsep" />}
                      <div className={`min-w-0 py-1 ${i === 0 ? "pr-5" : i === 2 ? "pl-5" : "px-5"}`}>
                        <div className="ui-label truncate">{m.label}</div>
                        <div className={`text-[18px] font-medium mt-0.5 tabular-nums truncate ${m.cls}`}>{m.value}</div>
                      </div>
                    </Fragment>
                  ))}
                </div>

                {l.note && <div className="ui-note mb-3 whitespace-pre-wrap">{l.note}</div>}

                {/* Feed activity — transactions tagged to this loan */}
                {led && led.entries.length > 0 && (
                  <div className="mb-3">
                    <button
                      onClick={() => toggleExpand(l.id)}
                      className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors"
                    >
                      <ChevronRight
                        size={12}
                        className={`text-faint transition-transform duration-150 ${feedOpen ? "rotate-90" : ""}`}
                      />
                      <span className="tabular-nums">{led.entries.length}</span> tagged ·{" "}
                      <span className="tabular-nums">{fmtAmount(led.repaid_total)}</span> repaid via feed
                    </button>
                    {feedOpen && (
                      <div className="mt-2 overflow-x-auto dash-load">
                        <table className="ui-table ui-table-sm">
                          <thead>
                            <tr>
                              <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                              <th className="font-medium px-3 py-2">Description</th>
                              <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {led.entries.map((e, i) => (
                              <tr key={i}>
                                <td className="px-3 py-2 tabular-nums text-muted whitespace-nowrap">{(e.posted_at || "").slice(0, 10)}</td>
                                <td className="px-3 py-2 text-ink-2 max-w-0 truncate"><span className="truncate block">{e.description}</span></td>
                                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${e.kind === "received" ? "text-success-ink" : "text-ink"}`}>
                                  {e.kind === "received" ? "+" : "-"}{fmtAmount(e.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Set-aside inline editor */}
                {asideId === l.id ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="ui-note">Set aside toward repayment</span>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={asideBuf}
                        onChange={(e) => setAsideBuf(e.target.value)}
                        autoFocus
                        className="field-input tabular-nums w-32"
                        style={{ paddingLeft: 22 }}
                      />
                    </div>
                    <button
                      onClick={() => saveAside(l)}
                      className="ui-btn ui-btn-ink"
                    >
                      <Save size={13} /> Save
                    </button>
                    <button
                      onClick={() => setAsideId(null)}
                      className="ui-btn"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    {!paid && (
                      <>
                        <button
                          onClick={() => startAside(l)}
                          className="ui-btn"
                        >
                          Set aside
                        </button>
                        {canApply && (
                          <button
                            onClick={() => applyToSetAside(l)}
                            disabled={applyingId === l.id}
                            className="ui-btn disabled:opacity-50"
                          >
                            {applyingId === l.id ? <Loader2 size={13} className="animate-spin" /> : null}
                            Apply {fmtAmount(led!.repaid_total)} repaid to set aside
                          </button>
                        )}
                        <button
                          onClick={() => markPaid(l)}
                          className="ui-btn"
                        >
                          <CheckCircle2 size={14} /> Mark paid off
                        </button>
                      </>
                    )}
                    {paid && (
                      <button
                        onClick={() => reopenLoan(l)}
                        className="ui-btn"
                      >
                        <RotateCcw size={13} /> Reopen
                      </button>
                    )}
                    <button
                      onClick={() => openEdit(l)}
                      className="ui-btn"
                    >
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      onClick={() => removeLoan(l)}
                      className="ui-btn ui-btn-danger"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-medium text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
