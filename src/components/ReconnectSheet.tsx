import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "./Toast";

// R-560: the sheet that asks for the password again when the server stops accepting this device's
// session. The device is never signed out: the person stays in the app, their unsent work stays
// queued, and a right password lifts the state. Settings opens the same sheet from its banner.

/** The words for why the server refused this device, from the `reason` it gave on the refresh route. */
export function authReasonWords(reason?: string | null): string {
  switch (reason) {
    case "expired": return "This device was not used for 90 days, so it was signed out.";
    case "password_changed": return "Your password was changed, so this device needs the new one.";
    case "account_off": return "This account is switched off. Ask the owner to turn it back on.";
    default: return "The server did not accept this device's sign-in.";
  }
}

/** Window event Settings fires to bring the sheet back after Not now. */
export const RECONNECT_EVENT = "open-reconnect";

const inp =
  "border border-line px-3 h-9 rounded-lg text-[13px] w-full bg-surface text-ink placeholder-muted " +
  "focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";

export default function ReconnectSheet({ email, reason, onClose, onDone }: {
  email: string; reason?: string; onClose: () => void; onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    if (!password) { setErr("Enter your password."); return; }
    setBusy(true);
    setErr("");
    try {
      await api.netsyncReconnect(password);
      toast("Signed in again. Syncing.");
      setBusy(false);
      setPassword("");
      onDone();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Sign in again to keep syncing"
        className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-[16px] font-semibold text-ink">Sign in again to keep syncing</h2>
          <p className="text-[12.5px] text-muted mt-1">{authReasonWords(reason)}</p>
        </div>
        <div className="px-5 pb-4 space-y-3">
          <div className="space-y-1">
            <div className="text-[12px] font-medium text-ink-2">Account</div>
            <div className="text-[13px] text-ink truncate">{email}</div>
          </div>
          <div className="space-y-1">
            <label htmlFor="reconnect-password" className="text-[12px] font-medium text-ink-2">Password</label>
            <input id="reconnect-password" ref={field} className={inp} type="password" autoComplete="current-password"
              value={password} disabled={busy}
              onChange={(e) => { setPassword(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </div>
          {err && <div role="alert" className="text-[12.5px] text-danger-ink bg-danger-bg border border-danger-ink/20 rounded-lg px-3 py-2">{err}</div>}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={submit} disabled={busy}
              className="bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium disabled:opacity-40 whitespace-nowrap">
              {busy ? "Signing in..." : "Reconnect"}
            </button>
            <button onClick={onClose} disabled={busy}
              className="px-4 h-9 rounded-lg border border-line text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-40 whitespace-nowrap">
              Not now
            </button>
          </div>
          <p className="text-[12px] text-muted">Your work on this device is kept and uploads once you reconnect.</p>
        </div>
      </div>
    </div>
  );
}
