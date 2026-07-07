import { useEffect, useRef, useState } from "react";
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
 * Full-screen animated Ecliptr sign-in. On success it returns the signed-in
 * `Me` to the app.
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
  const starRef = useRef<HTMLCanvasElement | null>(null);

  // Parallax twinkling starfield behind the eclipse.
  useEffect(() => {
    const cv = starRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0, stars: { x: number; y: number; z: number; r: number; t: number }[] = [], raf = 0, last = 0;
    const resize = () => {
      w = cv.width = cv.offsetWidth * DPR;
      h = cv.height = cv.offsetHeight * DPR;
      const n = Math.max(70, Math.min(200, Math.floor((cv.offsetWidth * cv.offsetHeight) / 9000)));
      stars = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, z: Math.random() * 0.85 + 0.15, r: Math.random() * 1.3 + 0.2, t: Math.random() * 6.28 }));
    };
    resize();
    window.addEventListener("resize", resize);
    const frame = (ts: number) => {
      const dt = Math.min(0.05, (ts - last) / 1000 || 0);
      last = ts;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.x -= s.z * 9 * dt * DPR;
        if (s.x < 0) { s.x = w; s.y = Math.random() * h; }
        s.t += dt * 2.2;
        ctx.globalAlpha = (0.55 + 0.45 * Math.sin(s.t)) * s.z;
        ctx.fillStyle = s.z > 0.7 ? "#dfeaff" : "#a9c2ff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * DPR, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
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
        if (confirm(`These credentials belong to a different workspace. Switch to it now? Your current workspace stays intact and separate — you can switch back anytime by signing in with its email. The app will restart.`)) {
          try { const { relaunch } = await import("@tauri-apps/plugin-process"); await relaunch(); return; }
          catch { /* fall through to reset busy state */ }
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

  const inp = "w-full h-11 px-3.5 rounded-xl text-[14px] bg-white/5 border border-white/12 text-white placeholder-white/35 focus:outline-none focus:ring-2 focus:ring-white/30 focus:border-white/25 transition";

  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center" style={{ background: "#0A0A0B" }}>
      {/* Animated eclipse / space background */}
      <canvas ref={starRef} className="auth-stars" />
      <div className="auth-aurora" />
      <div className="auth-eclipse" />

      <div className="relative z-10 w-full max-w-[380px] px-6 animate-auth-rise">
        <div className="flex flex-col items-center text-center mb-7">
          <div className="auth-logo-tile mb-4">
            <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-16 w-16" />
          </div>
          <p className="text-[16px] font-semibold tracking-tight text-white/90 mb-2">Ecliptr</p>
          <h1 className="text-[26px] font-bold tracking-tight text-white">Welcome back</h1>
          <p className="text-[13px] text-white/55 mt-1.5 max-w-[300px]">Sign in to your workspace.</p>
        </div>

        <div className="space-y-3">
          <input className={inp} type="email" autoCapitalize="off" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <div className="relative">
            <input
              className={inp}
              type={showPw ? "text" : "password"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }}
              disabled={busy}
              style={{ paddingRight: 56 }}
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[13px] font-semibold text-white/50 hover:text-white/80 px-2 py-1"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>

          <div className="flex justify-end -mt-1">
            <button type="button" onClick={openForgot} className="text-[12px] text-white/45 hover:text-white/70 transition-colors">
              Forgot password?
            </button>
          </div>

          {error && (
            <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full h-11 rounded-xl text-[14px] font-semibold text-white transition-all duration-150 disabled:opacity-60 hover:-translate-y-px flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg, #FFAF4A, #FF6520 55%, #E83A00)", boxShadow: "0 8px 24px rgba(255,101,32,0.35)" }}
          >
            {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />}
            {restoring ? "Restoring your account…" : busy ? "Signing in…" : "Sign in"}
          </button>
        </div>

        <p className="text-center text-[12px] text-white/45 mt-6">
          Don't have an account?{" "}
          <button onClick={openRegister} className="group inline-flex items-center gap-1 text-[#FFA45C]/90 hover:text-[#FFC08F] font-medium transition-colors">
            Sign up at ecliptr.app
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </button>
        </p>
      </div>

      <style>{`
        @keyframes authRise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
        .animate-auth-rise { animation: authRise 0.5s cubic-bezier(0.16,1,0.3,1); }
        .auth-logo-tile {
          width: 64px; height: 64px; border-radius: 15px; display: flex; align-items: center; justify-content: center;
          /* The mark carries its own dark tile — just float it and glow orange. */
          box-shadow: 0 0 44px rgba(255,101,32,0.32);
          animation: logoFloat 4s ease-in-out infinite;
        }
        @keyframes logoFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        .auth-stars { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; }
        .auth-eclipse {
          position: absolute; top: 38%; left: 50%; z-index: 0; pointer-events: none;
          width: min(60vmin, 620px); height: min(60vmin, 620px); transform: translate(-50%,-50%);
          border-radius: 50%;
          background: radial-gradient(closest-side, transparent 56%, rgba(255,101,32,0.10) 60%, rgba(255,138,71,0.5) 64%, rgba(255,101,32,0.12) 73%, transparent 82%);
          animation: authEclipsePulse 6.5s ease-in-out infinite;
        }
        @keyframes authEclipsePulse {
          0%,100% { opacity: 0.7; transform: translate(-50%,-50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%,-50%) scale(1.04); }
        }
        .auth-aurora {
          position: absolute; inset: -20%; z-index: 0; filter: blur(70px); opacity: 0.55;
          background:
            radial-gradient(38% 38% at 25% 30%, rgba(255,101,32,0.50), transparent 70%),
            radial-gradient(34% 34% at 78% 28%, rgba(124,58,237,0.45), transparent 70%),
            radial-gradient(40% 40% at 60% 80%, rgba(13,148,136,0.40), transparent 70%);
          animation: auroraDrift 16s ease-in-out infinite alternate;
        }
        @keyframes auroraDrift {
          0%   { transform: translate3d(0,0,0) rotate(0deg) scale(1); }
          100% { transform: translate3d(2%, -3%, 0) rotate(8deg) scale(1.1); }
        }
      `}</style>
    </div>
  );
}
