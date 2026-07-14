import { useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, X, Pencil, CheckCircle2, Landmark, ChevronRight, Loader2 } from "lucide-react";
import { api, Loan, LoanLedger } from "../lib/api";
import { fmtAmount } from "../lib/format";

const today = () => new Date().toISOString().slice(0, 10);

// received_at is a "YYYY-MM-DD" date string; anchor it to local midnight so it
// doesn't slip a day in negative timezones.
const fmtDate = (s: string) => {
  if (!s) return "—";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime())
    ? "—"
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

  const load = async () => {
    const ls = await api.listLoans();
    setLoans(ls);
    // Preload ledgers so each card's feed summary is accurate before expanding.
    const pairs = await Promise.all(
      ls.map(async (l) => [l.id, await api.loanLedger(l.id).catch(() => null)] as const),
    );
    setLedgers(Object.fromEntries(pairs.filter(([, v]) => v) as [string, LoanLedger][]));
  };
  useEffect(() => { load().catch(console.error); }, []);

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
    } finally {
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
    const principal = parseFloat(fPrincipal) || 0;
    setSaving(true);
    try {
      if (editingId) {
        const l = loans.find((x) => x.id === editingId);
        if (l) {
          // Edit only touches name/lender/principal/note — keep set_aside + status.
          await api.updateLoan(editingId, fName.trim(), fLender.trim(), principal, l.set_aside, l.status, fNote);
        }
      } else {
        await api.createLoan(fName.trim(), fLender.trim(), principal, fReceived, "", fNote);
      }
      await load();
      closeForm();
    } finally {
      setSaving(false);
    }
  };

  const startAside = (l: Loan) => {
    setAsideId(l.id);
    setAsideBuf(String(l.set_aside));
    setShowForm(false);
  };

  const saveAside = async (l: Loan) => {
    const setAside = parseFloat(asideBuf) || 0;
    await api.updateLoan(l.id, l.name, l.lender, l.principal, setAside, l.status, l.note);
    setAsideId(null);
    await load();
  };

  const markPaid = async (l: Loan) => {
    await api.updateLoan(l.id, l.name, l.lender, l.principal, l.set_aside, "paid", l.note);
    await load();
  };

  const removeLoan = async (l: Loan) => {
    if (!confirm(`Delete loan "${l.name}"? This can't be undone.`)) return;
    await api.deleteLoan(l.id);
    await load();
  };

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold text-ink tracking-tight truncate">Loans</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Money you received and owe back. It sits in your bank but reduces your free cash until it's paid off.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 h-9 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium transition-colors"
        >
          <Plus size={14} /> Add loan
        </button>
      </div>

      {/* Total outstanding tile */}
      <div className="bg-surface-2 border border-line rounded-xl px-5 py-4 max-w-sm">
        <div className="text-[11.5px] font-medium text-muted">Total outstanding</div>
        <div className="text-[24px] font-bold text-ink tabular-nums mt-0.5">{fmtAmount(totalOutstanding)}</div>
        <div className="text-[11px] text-muted mt-0.5">
          across {openCount} open loan{openCount !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Add / edit form */}
      {showForm && (
        <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink">
              {editingId ? "Edit loan" : "Add loan"}
            </h3>
            <button
              onClick={closeForm}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-3 text-muted hover:text-ink-2 transition-colors"
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
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  placeholder="0.00"
                  value={fPrincipal}
                  onChange={(e) => setFPrincipal(e.target.value)}
                  className="field-input tabular-nums"
                  style={{ paddingLeft: 22 }}
                />
              </div>
            </Field>
            {!editingId && (
              <Field label="Date received">
                <input
                  type="date"
                  value={fReceived}
                  onChange={(e) => setFReceived(e.target.value)}
                  className="field-input tabular-nums"
                />
              </Field>
            )}
          </div>

          <Field label="Note">
            <textarea
              value={fNote}
              onChange={(e) => setFNote(e.target.value)}
              rows={2}
              placeholder="Optional — terms, purpose, etc."
              className="field-input resize-none"
            />
          </Field>

          <div className="flex items-center gap-2">
            <button
              onClick={saveForm}
              disabled={saving || !fName.trim()}
              className="flex items-center justify-center gap-1.5 h-9 px-4 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              <Save size={14} /> {saving ? "Saving…" : editingId ? "Save changes" : "Add loan"}
            </button>
            <button
              onClick={closeForm}
              className="h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loan list */}
      {loans.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center mx-auto mb-3">
            <Landmark size={18} className="text-faint" />
          </div>
          <p className="text-[14px] font-semibold text-ink-2">No loans yet</p>
          <p className="text-[12px] text-muted mt-1">Record money the business borrowed to track what you owe back</p>
          <button onClick={openCreate} className="mt-3 text-[12px] font-medium text-accent hover:text-accent-hover">
            + Add loan
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {loans.map((l) => {
            const paid = l.status === "paid";
            const led = ledgers[l.id];
            const feedOpen = expanded.has(l.id);
            const canApply = !paid && led && led.repaid_total > l.set_aside + 0.0001;
            return (
              <div
                key={l.id}
                className={`bg-surface border border-line rounded-xl p-4 min-w-0 transition-opacity ${paid ? "opacity-60" : ""}`}
              >
                {/* Top: name / lender + status */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-ink truncate">{l.name}</div>
                    <div className="text-[11px] text-muted mt-0.5 truncate">
                      {l.lender || "—"} · received {fmtDate(l.received_at)}
                    </div>
                  </div>
                  <span
                    className={`flex-shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      paid ? "bg-success-bg text-success-ink" : "bg-warning-bg text-warning-ink"
                    }`}
                  >
                    {paid ? "Paid off" : "Open"}
                  </span>
                </div>

                {/* Money row */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { label: "Principal",   value: fmtAmount(l.principal),   cls: "text-ink" },
                    { label: "Set aside",   value: fmtAmount(l.set_aside),   cls: "text-ink-2" },
                    { label: "Outstanding", value: fmtAmount(l.outstanding), cls: paid ? "text-success-ink" : "text-ink" },
                  ].map((m) => (
                    <div key={m.label} className="bg-surface-2 border border-line rounded-lg px-3 py-2 min-w-0">
                      <div className="text-[10.5px] font-medium text-muted truncate">{m.label}</div>
                      <div className={`text-[13px] font-bold mt-0.5 tabular-nums truncate ${m.cls}`}>{m.value}</div>
                    </div>
                  ))}
                </div>

                {l.note && <div className="text-[11.5px] text-muted mb-3 whitespace-pre-wrap">{l.note}</div>}

                {/* Feed activity — transactions tagged to this loan */}
                {led && led.entries.length > 0 && (
                  <div className="border-t border-line-2 pt-3 mb-3">
                    <button
                      onClick={() => toggleExpand(l.id)}
                      className="flex items-center gap-1.5 text-[11.5px] text-muted hover:text-ink-2 transition-colors"
                    >
                      <ChevronRight
                        size={12}
                        className={`text-faint transition-transform duration-150 ${feedOpen ? "rotate-90" : ""}`}
                      />
                      <span className="tabular-nums">{led.entries.length}</span> tagged ·{" "}
                      <span className="tabular-nums">{fmtAmount(led.repaid_total)}</span> repaid via feed
                    </button>
                    {feedOpen && (
                      <div className="mt-2 border border-line-2 rounded-lg overflow-x-auto">
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="text-left text-muted border-b border-line-2">
                              <th className="font-medium px-3 py-2 whitespace-nowrap">Date</th>
                              <th className="font-medium px-3 py-2">Description</th>
                              <th className="font-medium px-3 py-2 text-right whitespace-nowrap">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line-2">
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
                  <div className="flex items-center gap-2 flex-wrap border-t border-line-2 pt-3">
                    <span className="text-[11px] text-muted">Set aside toward repayment</span>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-[12px]">$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
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
                      className="flex items-center gap-1.5 h-9 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[12px] font-medium transition-colors"
                    >
                      <Save size={13} /> Save
                    </button>
                    <button
                      onClick={() => setAsideId(null)}
                      className="h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap border-t border-line-2 pt-3">
                    {!paid && (
                      <>
                        <button
                          onClick={() => startAside(l)}
                          className="h-9 px-3 border border-line text-ink-2 hover:bg-surface-2 rounded-lg text-[12px] font-medium transition-colors"
                        >
                          Set aside
                        </button>
                        {canApply && (
                          <button
                            onClick={() => applyToSetAside(l)}
                            disabled={applyingId === l.id}
                            className="flex items-center gap-1.5 h-9 px-3 border border-line text-ink-2 hover:bg-surface-2 rounded-lg text-[12px] font-medium disabled:opacity-50 transition-colors"
                          >
                            {applyingId === l.id ? <Loader2 size={13} className="animate-spin" /> : null}
                            Apply {fmtAmount(led!.repaid_total)} repaid to set aside
                          </button>
                        )}
                        <button
                          onClick={() => markPaid(l)}
                          className="flex items-center gap-1.5 h-9 px-3 border border-line text-success-ink hover:bg-success-bg rounded-lg text-[12px] font-medium transition-colors"
                        >
                          <CheckCircle2 size={13} /> Mark paid off
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => openEdit(l)}
                      className="flex items-center gap-1.5 h-9 px-3 border border-line text-muted hover:bg-surface-2 rounded-lg text-[12px] transition-colors"
                    >
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      onClick={() => removeLoan(l)}
                      className="flex items-center gap-1.5 h-9 px-3 border border-danger text-danger-ink hover:bg-danger-bg rounded-lg text-[12px] transition-colors"
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
      <span className="block text-[11px] text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}
