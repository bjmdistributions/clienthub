import { useCallback, useEffect, useState } from "react";
import { History, X } from "lucide-react";
import { api, BooksChange, BooksChangesResponse, isUnavailable } from "../lib/api";
import { fmtAmount } from "../lib/format";
import StatusPill from "./StatusPill";
import { catLabel, methodLabel, fmtShortDate } from "./FinancialsView";

// R-282 accountant portal — the desktop-side view of the change feed the server
// writes every time the accountant edits a bank transaction on the web
// (ecliptr.app/staff). The edits themselves already arrive through normal sync;
// this panel only shows WHO changed WHAT, so it's a read-only feed, never a form.
//
// Hides itself entirely (no button, no error toast) when the connected server
// doesn't have the R-282 routes yet (`unsupported`) or the desktop is offline
// (`unavailable`, from api.ts's `safe()`) — an old server or a disconnected
// device should look like this feature doesn't exist, not like it's broken.

const confirmedMethodLabel = (v: string) => (v ? methodLabel(v) : "Not confirmed");

function describeChange(c: BooksChange): string {
  switch (c.field) {
    case "category":
      return `Category: ${catLabel(c.old_value)} → ${catLabel(c.new_value)}`;
    case "confirmed_method":
      return `Payment method: ${confirmedMethodLabel(c.old_value)} → ${confirmedMethodLabel(c.new_value)}`;
    case "reviewed":
      return c.new_value === "true" ? "Marked booked" : "Marked not booked";
    case "note":
      if (!c.new_value) return "Removed the note";
      return `${c.old_value ? "Changed the note to" : "Added a note"}: ${c.new_value}`;
    default:
      return `${c.field}: ${c.old_value} → ${c.new_value}`;
  }
}

// Local date + time, e.g. "Sep 14 · 2:40 PM" — `created_at` is a full RFC3339
// timestamp from the server, unlike the bare bank dates `fmtShortDate` parses.
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export default function AccountantChanges() {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<BooksChangesResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    const res = await api.listBooksChanges(100);
    if (isUnavailable(res) || "unsupported" in res) { setReady(false); setData(null); return; }
    setData(res);
    setReady(true);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open) load(); }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const markSeen = async () => {
    setMarking(true);
    try {
      await api.markBooksChangesSeen();
      await load();
    } finally {
      setMarking(false);
    }
  };

  if (!ready || !data) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Changes your accountant made on the web"
        className="flex items-center gap-1.5 text-[12px] text-muted hover:text-ink-2 transition-colors duration-[130ms] whitespace-nowrap"
      >
        <History size={13} />
        Accountant changes
        {data.unseen > 0 && <StatusPill tone="accent">{data.unseen}</StatusPill>}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Accountant changes"
            className="bg-surface border border-line rounded-2xl w-full max-w-xl max-h-[82vh] shadow-xl flex flex-col min-w-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-ink truncate">Accountant changes</div>
                <div className="text-[11.5px] text-muted mt-0.5">Edits made on the web by your accountant</div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                {data.unseen > 0 && (
                  <button
                    onClick={markSeen}
                    disabled={marking}
                    className="text-[12px] font-medium text-accent hover:text-accent-hover disabled:opacity-50 transition-colors duration-[130ms] whitespace-nowrap"
                  >
                    Mark all as seen
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg text-muted hover:text-ink-2 hover:bg-surface-2"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="px-5 py-4 overflow-y-auto flex flex-col gap-2">
              {data.changes.length === 0 ? (
                <div className="text-center py-8 text-[12.5px] text-muted">No changes from your accountant yet.</div>
              ) : (
                data.changes.map((c) => {
                  const unseen = !c.seen_at;
                  return (
                    <div
                      key={c.id}
                      className={`rounded-lg border border-line px-3 py-2.5 min-w-0 ${unseen ? "bg-accent/5" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className={`text-[12.5px] truncate ${unseen ? "font-semibold text-ink" : "text-ink-2"}`}>
                          {c.user_name}
                        </span>
                        <span className="text-[11px] text-muted flex-shrink-0 whitespace-nowrap">{fmtWhen(c.created_at)}</span>
                      </div>
                      <div className="text-[11.5px] text-muted truncate mt-0.5">
                        {fmtShortDate(c.txn_posted_at)} · {c.txn_description}
                        {" · "}
                        <span className={c.txn_direction === "in" ? "text-success-ink" : "text-danger-ink"}>
                          {c.txn_direction === "in" ? "+" : "−"}{fmtAmount(c.txn_amount)}
                        </span>
                      </div>
                      <div className="text-[12.5px] text-ink-2 mt-1 min-w-0 whitespace-pre-wrap break-words">{describeChange(c)}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
