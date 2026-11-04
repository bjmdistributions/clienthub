import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, Me } from "../lib/api";

// Accounts are created on the website — the desktop only ever signs in. A
// website-created account signing in on a fresh device is restored (account +
// data) from the server, so we show a calm "Restoring…" state, not an error.
const REGISTER_URL = "https://ecliptr.app/register";
const FORGOT_URL = "https://ecliptr.app/forgot";

// The backend returns this sentinel when the credentials belong to a DIFFERENT
// workspace than the one occupying this device's active store. Each workspace lives
// in its own local store, so switching just re-points to that store and restarts —
// the current workspace's data is left completely intact and separate.
const SWITCH_PREFIX = "__SWITCH_WORKSPACE__:";

/**
 * Full-screen Ecliptr sign-in: the mark on a still, near-black ground (no glow, no
 * motion; R-511 DG-28). On success it returns the signed-in `Me` to the app.
 */
export default function AuthView({
  onAuthed,
}: {
  onAuthed: (me: Me) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R-433: a workspace switch restarted the app; finish the sign-in it carried over.
  useEffect(() => {
    setBusy(true);
    const restoreTimer = setTimeout(() => setRestoring(true), 900);
    api.resumeSwitchLogin()
      .then((me) => {
        clearTimeout(restoreTimer);
        if (me) onAuthed(me); else { setBusy(false); setRestoring(false); }
      })
      .catch((e: any) => {
        clearTimeout(restoreTimer);
        setError(typeof e === "string" ? e : (e?.message || "Something went wrong"));
        setBusy(false); setRestoring(false);
      });
  }, []);

  const submit = async () => {
    if (!email.trim() || !password) return;
    setError(null);
    setBusy(true);
    // A fresh device restores account + data from the server on sign-in; show a
    // calm "Restoring…" state after a short delay so quick logins don't flash it.
    const restoreTimer = setTimeout(() => setRestoring(true), 900);
    try {
      const me = await api.login(email.trim(), password);
      clearTimeout(restoreTimer);
      onAuthed(me);
    } catch (e: any) {
      clearTimeout(restoreTimer);
      const msg = typeof e === "string" ? e : (e?.message || "Something went wrong");
      // Different-workspace credentials: confirm, then wipe + restart into it.
      if (msg.startsWith(SWITCH_PREFIX)) {
        if (confirm(`These credentials belong to a different workspace. Switch to it now? Your current workspace stays intact and separate, so you can switch back anytime by signing in with its email. The app will restart.`)) {
          // R-433: the switch is written only now, after Yes, and this sign-in is
          // finished after the restart instead of being asked for again.
          try {
            await api.confirmWorkspaceSwitch(email.trim(), password);
            const { relaunch } = await import("@tauri-apps/plugin-process"); await relaunch(); return;
          }
          catch (err: any) { setError(typeof err === "string" ? err : (err?.message || "Couldn't switch workspace")); }
        }
        setBusy(false); setRestoring(false);
        return;
      }
      setError(msg);
      setBusy(false); setRestoring(false);
    }
  };

  const openRegister = () => { api.openExternal(REGISTER_URL).catch(() => {}); };
  const openForgot = () => { api.openExternal(FORGOT_URL).catch(() => {}); };

  const inp = "w-full h-11 px-3.5 rounded-lg text-[14px] bg-transparent border border-line-3 text-ink placeholder:text-faint focus:outline-none focus:border-ink transition-colors";

  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center bg-surface text-ink">

      <div className="relative z-10 w-full max-w-[380px] px-6 animate-auth-rise">
        <div className="flex flex-col items-center text-center mb-7">
          <div className="auth-logo-tile mb-4">
            <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-16 w-16" />
          </div>
          <p className="text-[14px] font-medium text-ink mb-2">Ecliptr</p>
          <h1 className="text-[24px] font-medium tracking-tight text-ink">Welcome back</h1>
          <p className="text-[13px] text-muted mt-1.5 max-w-[300px]">Sign in to your workspace.</p>
        </div>

        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!busy) submit(); }}>
          <input className={inp} type="email" autoCapitalize="off" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <div className="relative">
            <input
              className={inp}
              type={showPw ? "text" : "password"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              style={{ paddingRight: 56 }}
            />
            <button
              type="button"
              // preventDefault on mousedown keeps the input focused and stops a
              // focus/blur race that made the toggle miss clicks intermittently;
              // functional update always flips regardless of a stale render.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-[13px] font-medium text-muted hover:text-ink px-3 py-2 select-none"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>

          <div className="flex justify-end -mt-1">
            <button type="button" onClick={openForgot} className="text-[12px] text-muted hover:text-ink transition-colors">
              Forgot password?
            </button>
          </div>

          {error && (
            <div className="text-[12px] text-danger-ink bg-danger-bg rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="ui-btn ui-btn-ink w-full !h-11 !text-[14px] disabled:opacity-60 gap-2"
          >
            {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-on-accent/30 border-t-on-accent animate-spin" />}
            {restoring ? "Restoring your account…" : busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-center text-[12px] text-muted mt-6">
          Don't have an account?{" "}
          <button onClick={openRegister} className="group inline-flex items-center gap-1 text-ink hover:opacity-70 font-medium transition-opacity">
            Sign up at ecliptr.app
            <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
          </button>
        </p>
      </div>

      <style>{`
        @keyframes authRise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
        .animate-auth-rise { animation: authRise 0.2s cubic-bezier(0.16,1,0.3,1); }
        .auth-logo-tile {
          width: 64px; height: 64px; border-radius: 15px; display: flex; align-items: center; justify-content: center;
          /* The mark carries its own dark tile (R-424). R-583: no shadow under it. */
        }
      `}</style>
    </div>
  );
}
