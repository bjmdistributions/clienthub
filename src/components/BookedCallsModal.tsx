import { useState, useEffect } from "react";
import { api, CallRequest, OrUnavailable, isUnavailable } from "../lib/api";
import { X } from "lucide-react";
import StatusPill from "./StatusPill";
import { Button } from "./ui";

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Next day at 10:00 / 14:00 / 18:00 depending on the caller's morning/afternoon/evening
// choice — formatted for an <input type="datetime-local">.
function prefillDateTime(bestTime: string | null): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const t = (bestTime || "").toLowerCase();
  const hour = t.includes("afternoon") ? 14 : t.includes("evening") ? 18 : 10;
  d.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ActionKind = "cancel" | "reschedule" | "archive";

// Step 1 of the two-step confirm: states the consequence, and for cancel only,
// an optional reason. Mirrors CheckupView's lighter delete-session modal.
function ConsequenceStep({ kind, call, reason, setReason, onCancel, onNext }: {
  kind: ActionKind; call: CallRequest; reason: string; setReason: (v: string) => void;
  onCancel: () => void; onNext: () => void;
}) {
  const title = kind === "cancel" ? "Cancel this call?" : kind === "reschedule" ? "Reschedule this call?" : "Archive this call?";
  const text = kind === "cancel"
    ? `This cancels the call with ${call.name} and lets them know it's no longer happening.`
    : kind === "reschedule"
    ? `You're about to reschedule the call with ${call.name}. You'll pick a new date and time on the next step.`
    : `This archives the call with ${call.name}. It moves out of the active list, and nothing is deleted.`;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-surface border border-line rounded-2xl p-5 max-w-sm w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[16px] font-medium text-ink">{title}</h3>
        <p className="text-[13px] text-muted mt-1.5 leading-relaxed">{text}</p>
        {kind === "cancel" && (
          <div className="mt-3">
            <label className="block text-[12px] font-medium text-muted mb-1">Reason (optional)</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
              className="w-full bg-transparent border border-line-3 rounded-lg px-2.5 py-2 text-[13px] text-ink resize-none focus:outline-none focus:border-ink" />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Never mind</Button>
          <Button variant="danger" onClick={onNext}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

// Step 2: the caller's name typed to match, following ClientDetailView's
// DeleteClientModal pattern. Reschedule carries the new datetime-local too.
function TypedConfirmStep({ kind, call, rescheduleAt, setRescheduleAt, onBack, onConfirm, busy }: {
  kind: ActionKind; call: CallRequest; rescheduleAt: string; setRescheduleAt: (v: string) => void;
  onBack: () => void; onConfirm: () => void; busy: boolean;
}) {
  const [typed, setTyped] = useState("");
  const match = typed.trim() === call.name.trim();
  const label = kind === "cancel" ? "Cancel call" : kind === "reschedule" ? "Reschedule call" : "Archive call";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onBack}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-[16px] font-medium text-ink">{label}</h2>
          <p className="text-[12px] text-muted mt-0.5">To confirm, type <span className="font-medium text-ink">{call.name}</span> below.</p>
        </div>
        <div className="px-5 pb-2 space-y-3">
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={call.name}
            className="w-full bg-transparent border border-line-3 rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:border-ink"
          />
          {kind === "reschedule" && (
            <div>
              <label className="block text-[12px] font-medium text-muted mb-1">New date and time</label>
              <input type="datetime-local" value={rescheduleAt} onChange={(e) => setRescheduleAt(e.target.value)}
                className="w-full bg-transparent border border-line-3 rounded-lg h-10 px-3 text-[13.5px] text-ink focus:outline-none focus:border-ink" />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 mt-2">
          <Button onClick={onBack} disabled={busy}>Back</Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={!match || busy || (kind === "reschedule" && !rescheduleAt)}
          >
            {busy ? "Working..." : label}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PendingCallRow({ call, onAccept, onDecline }: {
  call: CallRequest;
  onAccept: (id: string, scheduledAt: string, sendEmail: boolean) => Promise<void>;
  onDecline: (id: string) => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(() => prefillDateTime(call.best_time));
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try { await onAccept(call.id, new Date(scheduledAt).toISOString(), sendEmail); }
    finally { setBusy(false); setAccepting(false); }
  };

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink truncate">{call.name}{call.company ? ` · ${call.company}` : ""}</div>
          <div className="text-[12px] text-muted mt-0.5 truncate">{[call.phone, call.email].filter(Boolean).join(" · ")}</div>
          {call.best_time && <div className="text-[12px] text-faint mt-1">Best time: {call.best_time}</div>}
          {call.questions && <div className="text-[12px] text-ink-2 mt-1.5 whitespace-pre-wrap">{call.questions}</div>}
        </div>
        {!accepting && (
          <div className="flex gap-1.5 flex-shrink-0">
            <Button variant="ink" size="sm" onClick={() => setAccepting(true)}>Accept</Button>
            <Button size="sm" onClick={() => onDecline(call.id)}>Decline</Button>
          </div>
        )}
      </div>

      {accepting && (
        <div className="mt-3 bg-surface-2 rounded-xl p-3.5 space-y-3">
          <div>
            <label className="block text-[12px] font-medium text-muted mb-1">Date and time</label>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full bg-transparent border border-line-3 rounded-lg h-9 px-2.5 text-[13px] text-ink focus:outline-none " />
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} className="accent-accent" />
            Send confirmation from sales@
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setAccepting(false)} disabled={busy}>Cancel</Button>
            <Button variant="ink" size="sm" onClick={confirm} disabled={busy || !scheduledAt}>
              {busy ? "Confirming..." : "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmedCallRow({ call, onAction }: { call: CallRequest; onAction: (kind: ActionKind, call: CallRequest) => void }) {
  return (
    <div className="px-5 py-3.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-ink truncate">{call.name}{call.company ? ` · ${call.company}` : ""}</span>
          <StatusPill tone="success">Confirmed</StatusPill>
        </div>
        <div className="text-[12px] text-ink-2 mt-1 tabular-nums">{call.scheduled_at ? fmtWhen(call.scheduled_at) : "-"}</div>
        {call.confirmation_sent_via && (
          <div className="text-[12px] text-faint mt-1">
            Confirmation sent via {call.confirmation_sent_via === "desktop_smtp" ? "sales@ (desktop)" : "no-reply@ecliptr.app"}
          </div>
        )}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        <Button size="sm" onClick={() => onAction("reschedule", call)}>Reschedule</Button>
        <Button size="sm" onClick={() => onAction("cancel", call)}>Cancel</Button>
        <Button size="sm" onClick={() => onAction("archive", call)}>Archive</Button>
      </div>
    </div>
  );
}

// The "Booked calls" bubble's sub-view. Pending requests accept/decline inline;
// confirmed calls carry date/time and how the confirmation went out, with
// Cancel/Reschedule/Archive gated behind the two-step confirm.
export default function BookedCallsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [calls, setCalls] = useState<OrUnavailable<CallRequest[]> | null>(null);
  const load = () => { api.listCallRequests(false).then(setCalls); };
  useEffect(() => { load(); }, []);

  const [action, setAction] = useState<{ kind: ActionKind; call: CallRequest } | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState("");
  const [rescheduleAt, setRescheduleAt] = useState("");
  const [busy, setBusy] = useState(false);

  const openAction = (kind: ActionKind, call: CallRequest) => {
    setAction({ kind, call });
    setStep(1);
    setReason("");
    setRescheduleAt(prefillDateTime(call.best_time));
  };
  const closeAction = () => { setAction(null); setStep(1); };

  const doAccept = async (id: string, scheduledAt: string, sendEmail: boolean) => {
    await api.confirmCallRequest(id, scheduledAt, sendEmail);
    load(); onChanged();
  };
  const doDecline = async (id: string) => { await api.cancelCallRequest(id); load(); onChanged(); };

  const doConfirmAction = async () => {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === "cancel") await api.cancelCallRequest(action.call.id);
      else if (action.kind === "reschedule") await api.rescheduleCallRequest(action.call.id, new Date(rescheduleAt).toISOString());
      else await api.archiveCallRequest(action.call.id);
    } finally {
      setBusy(false);
      closeAction();
      load(); onChanged();
    }
  };

  const unavailable = calls !== null && isUnavailable(calls);
  const list = calls !== null && !isUnavailable(calls) ? calls : [];
  const pendingCalls = list.filter((c) => c.status === "pending");
  const confirmedCalls = list.filter((c) => c.status === "confirmed");
  const otherCalls = list.filter((c) => c.status === "cancelled" || c.status === "declined");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line-2">
          <div>
            <h2 className="text-[16px] font-medium text-ink">Booked calls</h2>
            <p className="text-[12px] text-muted mt-0.5">Accept, confirm, and manage 15 minute call requests.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="ui-ib -mr-1 -mt-1"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto flex-1">
          {calls === null ? (
            <div className="text-[13px] text-muted text-center py-10">Loading...</div>
          ) : unavailable ? (
            <div className="text-[13px] text-muted text-center py-10">Unavailable</div>
          ) : list.length === 0 ? (
            <div className="text-[13px] text-muted text-center py-10">No call requests yet.</div>
          ) : (
            <>
              {pendingCalls.length > 0 && (
                <div>
                  <div className="px-5 pt-4 pb-1.5 text-[12.5px] font-medium text-muted">Pending</div>
                  <div className="divide-y divide-line-2">
                    {pendingCalls.map((c) => <PendingCallRow key={c.id} call={c} onAccept={doAccept} onDecline={doDecline} />)}
                  </div>
                </div>
              )}
              {confirmedCalls.length > 0 && (
                <div>
                  <div className="px-5 pt-4 pb-1.5 text-[12.5px] font-medium text-muted">Confirmed</div>
                  <div className="divide-y divide-line-2">
                    {confirmedCalls.map((c) => <ConfirmedCallRow key={c.id} call={c} onAction={openAction} />)}
                  </div>
                </div>
              )}
              {otherCalls.length > 0 && (
                <div>
                  <div className="px-5 pt-4 pb-1.5 text-[12.5px] font-medium text-muted">Cancelled and declined</div>
                  <div className="divide-y divide-line-2">
                    {otherCalls.map((c) => (
                      <div key={c.id} className="px-5 py-3 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                        </div>
                        <StatusPill tone={c.status === "declined" ? "neutral" : "danger"}>{c.status === "declined" ? "Declined" : "Cancelled"}</StatusPill>
                        <Button size="sm" onClick={() => openAction("archive", c)}>Archive</Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {action && step === 1 && (
        <ConsequenceStep kind={action.kind} call={action.call} reason={reason} setReason={setReason}
          onCancel={closeAction} onNext={() => setStep(2)} />
      )}
      {action && step === 2 && (
        <TypedConfirmStep kind={action.kind} call={action.call} rescheduleAt={rescheduleAt} setRescheduleAt={setRescheduleAt}
          onBack={() => setStep(1)} onConfirm={doConfirmAction} busy={busy} />
      )}
    </div>
  );
}
