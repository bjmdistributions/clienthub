import { useEffect, useState } from "react";
import { api, Me } from "../lib/api";

/**
 * Full-screen animated Ecliptr auth. Shows "Create owner account" (bootstrap) when
 * no accounts exist yet, otherwise a sign-in form. On success it returns the
 * signed-in `Me` to the app.
 */
export default function AuthView({
  mode,
  onAuthed,
}: {
  mode: "bootstrap" | "login";
  onAuthed: (me: Me) => void;
}) {
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getOrganizationName().then((n) => setOrgName((n || "").trim())).catch(() => {});
    if (mode === "bootstrap") {
      // Pre-fill the owner email from company info if we have it.
      api.getCompanyInfo().then((c) => { if (c?.email) setEmail(c.email); }).catch(() => {});
    }
  }, [mode]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const me = mode === "bootstrap"
        ? await api.employeeBootstrap(name.trim(), email.trim(), password)
        : await api.employeeLogin(email.trim(), password);
      onAuthed(me);
    } catch (e: any) {
      setError(typeof e === "string" ? e : (e?.message || "Something went wrong"));
      setBusy(false);
    }
  };

  const inp = "w-full h-11 px-3.5 rounded-xl text-[14px] bg-white/5 border border-white/12 text-white placeholder-white/35 focus:outline-none focus:ring-2 focus:ring-white/30 focus:border-white/25 transition";

  return (
    <div className="fixed inset-0 overflow-hidden flex items-center justify-center" style={{ background: "#0A0A0B" }}>
      {/* Animated gradient aurora background */}
      <div className="auth-aurora" />
      <div className="auth-grid" />

      <div className="relative z-10 w-full max-w-[380px] px-6 animate-auth-rise">
        <div className="flex flex-col items-center text-center mb-7">
          <div className="auth-logo-tile mb-4">
            <img src="/ecliptr-mark.svg" alt="Ecliptr" className="h-10 w-10" />
          </div>
          <p className="text-[16px] font-semibold tracking-tight text-white/90 mb-2">Ecliptr</p>
          <h1 className="text-[26px] font-bold tracking-tight text-white">
            {mode === "bootstrap" ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-[13px] text-white/55 mt-1.5 max-w-[300px]">
            {mode === "bootstrap"
              ? `Set up the owner account for ${orgName || "your organization"}. This becomes your login on web and mobile too.`
              : `Sign in to ${orgName || "Ecliptr"}.`}
          </p>
        </div>

        <div className="space-y-3">
          {mode === "bootstrap" && (
            <input className={inp} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input className={inp} type="email" autoCapitalize="off" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            className={inp}
            type="password"
            placeholder={mode === "bootstrap" ? "Create a password (8+ chars)" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }}
          />

          {error && (
            <div className="text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full h-11 rounded-xl text-[14px] font-semibold text-white transition-all duration-150 disabled:opacity-50 hover:-translate-y-px"
            style={{ background: "linear-gradient(135deg, #3B82F6, #2563EB)", boxShadow: "0 8px 24px rgba(37,99,235,0.35)" }}
          >
            {busy ? "Please wait…" : mode === "bootstrap" ? "Create account" : "Sign in"}
          </button>
        </div>

        <p className="text-center text-[11px] text-white/30 mt-8">Ecliptr</p>
      </div>

      <style>{`
        @keyframes authRise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
        .animate-auth-rise { animation: authRise 0.5s cubic-bezier(0.16,1,0.3,1); }
        .auth-logo-tile {
          width: 64px; height: 64px; border-radius: 18px; display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg, #2563EB, #1D4ED8);
          box-shadow: 0 0 40px rgba(37,99,235,0.45), inset 0 1px 0 rgba(255,255,255,0.2);
          animation: logoFloat 4s ease-in-out infinite;
        }
        @keyframes logoFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        .auth-aurora {
          position: absolute; inset: -20%; z-index: 0; filter: blur(70px); opacity: 0.55;
          background:
            radial-gradient(38% 38% at 25% 30%, rgba(37,99,235,0.55), transparent 70%),
            radial-gradient(34% 34% at 78% 28%, rgba(124,58,237,0.45), transparent 70%),
            radial-gradient(40% 40% at 60% 80%, rgba(13,148,136,0.40), transparent 70%);
          animation: auroraDrift 16s ease-in-out infinite alternate;
        }
        @keyframes auroraDrift {
          0%   { transform: translate3d(0,0,0) rotate(0deg) scale(1); }
          100% { transform: translate3d(2%, -3%, 0) rotate(8deg) scale(1.1); }
        }
        .auth-grid {
          position: absolute; inset: 0; z-index: 0; opacity: 0.05;
          background-image: linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px);
          background-size: 44px 44px;
          mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 30%, transparent 75%);
        }
      `}</style>
    </div>
  );
}
