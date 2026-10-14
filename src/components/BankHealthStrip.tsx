import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { api, PlaidHealth, PlaidHealthBank } from "../lib/api";
import { toast } from "./Toast";

// R-518: what the bank feed needs from a person, on To book where the work is.
//
// Background pulls (the 10-minute timer and the doorbell) make almost every pull now, and they
// used to log only "imported N". A bank whose login broke failed every one of them silently while
// a healthy bank kept "Bank checked" moving, and the warnings a pull raises (a booking it could not
// move, a row booked for more than the bank row, a row it could not save) reached only a log
// file. Each bank's health and those warnings are kept on this device; this strip shows them.

const WARNING_LEAD: Record<string, string> = {
  over_allocated: "Booked for more than the bank row now says",
  settle_refused: "Booking not moved to the posted copy",
  skipped_unsaved: "Not saved yet, tried again on the next pull",
  retracted_kept: "Withdrawn by your bank after you booked it, kept under Retracted by bank",
  held_reference_collision: "Held back, same payment reference as money already booked",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

interface Props {
  /** Bumped by the screen after any pull it ran, so the strip re-reads at once. */
  version: number;
  /** After a bank signs in again and pulls, the screen refreshes its lists. */
  onSynced: () => void;
}

export default function BankHealthStrip({ version, onSynced }: Props) {
  const [health, setHealth] = useState<PlaidHealth | null>(null);
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const load = () => { api.plaidHealth().then(setHealth).catch(() => {}); };

  // Re-read every minute: a background pull changes the health without telling the screen.
  useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => { window.clearInterval(t); cancelRef.current = true; };
  }, []);
  useEffect(() => { if (version > 0) load(); }, [version]);

  const signIn = async (b: PlaidHealthBank) => {
    if (signingIn) return;
    setSigningIn(b.id);
    cancelRef.current = false;
    try {
      const { hosted_link_url, link_token } = await api.plaidReconnectStart(b.id);
      await api.openExternal(hosted_link_url);
      toast(`Sign in to ${b.institution || "your bank"} in the browser window that opened.`);
      for (let i = 0; i < 100 && !cancelRef.current; i++) {
        await new Promise((r) => window.setTimeout(r, 3000));
        const r = await api.plaidReconnectPoll(link_token, b.id).catch(() => ({ status: "pending" }));
        if (r.status === "done") {
          toast(`${b.institution || "Your bank"} is signed in again. Pulling what it held back.`, "success");
          await api.plaidSync().catch(() => null);
          load();
          onSynced();
          return;
        }
        if (r.status === "exited") { toast("The bank sign-in was closed before it finished. Nothing changed."); return; }
      }
      if (!cancelRef.current) toast("Did not see the sign-in finish. Try again when you are ready.", "error");
    } catch (e: any) {
      toast(String(e?.message || e), "error");
    } finally {
      setSigningIn(null);
    }
  };

  const dismiss = async () => {
    await api.plaidHealthDismiss().catch(() => {});
    setOpen(false);
    load();
  };

  if (!health) return null;
  const broken = health.banks.filter((b) => b.error);
  const warnings = health.warnings;
  if (broken.length === 0 && warnings.length === 0) return null;

  return (
    <div className="border border-line-2 rounded-lg divide-y divide-line-2 min-w-0">
      {broken.map((b) => (
        <div key={b.id} className="flex items-start gap-2.5 px-3.5 py-3 min-w-0">
          <AlertTriangle size={15} className={`${b.needs_login ? "text-danger-ink" : "text-warning-ink"} flex-shrink-0 mt-0.5`} />
          <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
            {b.needs_login ? (
              <>
                <span className="font-medium text-ink">{b.institution || "A bank"} stopped sending transactions{b.last_ok ? ` after ${when(b.last_ok)}` : ""}.</span>{" "}
                <span className="text-ink-2">It needs you to sign in to the bank again. Until then nothing new from it reaches Ecliptr.</span>
              </>
            ) : (
              <>
                <span className="font-medium text-ink">{b.institution || "A bank"} could not be reached{b.last_try ? ` at ${when(b.last_try)}` : ""}.</span>{" "}
                <span className="text-ink-2">{b.error.replace(/^Plaid:\s*/, "")}. Ecliptr tries again every 10 minutes.</span>
                {b.last_ok && <span className="text-muted"> Last good pull {when(b.last_ok)}.</span>}
              </>
            )}
          </div>
          {b.needs_login && (
            <button
              onClick={() => signIn(b)}
              disabled={signingIn !== null}
              className="flex-shrink-0 flex items-center gap-1.5 h-8 px-3 bg-accent hover:bg-accent-hover text-on-accent rounded-lg text-[12.5px] font-medium disabled:opacity-60 transition-colors"
            >
              {signingIn === b.id && <Loader2 size={13} className="animate-spin" />}
              Sign in to {b.institution || "the bank"}
            </button>
          )}
        </div>
      ))}
      {warnings.length > 0 && (
        <div className="px-3.5 py-2.5 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1.5 min-w-0 flex-1 text-left text-[13px] text-ink hover:text-ink-2"
            >
              {open ? <ChevronDown size={14} className="text-muted flex-shrink-0" /> : <ChevronRight size={14} className="text-muted flex-shrink-0" />}
              <span className="font-medium tabular-nums">{warnings.length}</span>
              <span className="truncate">{warnings.length === 1 ? "thing" : "things"} from your bank to look at</span>
            </button>
            <button
              onClick={dismiss}
              className="flex-shrink-0 h-7 px-2.5 border border-line text-muted hover:bg-surface-2 rounded-md text-[12px] transition-colors"
            >
              Dismiss
            </button>
          </div>
          {open && (
            <ul className="mt-2 flex flex-col gap-1.5 pl-5">
              {warnings.map((w, i) => (
                <li key={`${w.kind}-${i}`} className="text-[12.5px] leading-relaxed min-w-0">
                  <span className="text-ink-2">{WARNING_LEAD[w.kind] || "From the bank"}:</span>{" "}
                  <span className="text-ink break-words">{w.text}</span>
                  <span className="text-muted"> ({when(w.at)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
