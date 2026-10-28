import { useEffect, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkNow, downloadIfNeeded, installNow, mayAutoInstall, readAttempts, recordAutoAttempt,
  useUpdateState, whatsNewFor, clearWhatsNew, getUpdateState, type WhatsNew,
} from "../lib/updater";

// R-561: sits above <App/> so it works on the sign-in screen too. It renders the app at
// once and never delays launch. When the launch check finds an update it covers the window
// with a progress screen, downloads, installs and lets the installer reopen the app. Any
// failure hides the screen and the app just runs; the in-app card shows the error.
export default function UpdateGate({ children }: { children: ReactNode }) {
  const st = useUpdateState();
  const [armed, setArmed] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const skippedRef = useRef(false);
  const [whatsNew, setWhatsNew] = useState<WhatsNew | null>(null);

  useEffect(() => {
    let live = true;
    getVersion().then((v) => { if (live) setWhatsNew(whatsNewFor(v)); }).catch(() => {});
    // Once the person has started typing or clicking, a slow check must not cover the window
    // and restart the app under them: that update is left to the in-app card.
    let touched = false;
    const touch = () => { touched = true; };
    window.addEventListener("keydown", touch, true);
    window.addEventListener("pointerdown", touch, true);
    (async () => {
      const u = await checkNow();
      window.removeEventListener("keydown", touch, true);
      window.removeEventListener("pointerdown", touch, true);
      // A version whose automatic download or install has already failed twice is left to the card.
      if (!live || !u || touched || !mayAutoInstall(readAttempts(), u.version)) return;
      setArmed(true);
      recordAutoAttempt(u.version);
      await downloadIfNeeded();
      if (!live) return;
      if (getUpdateState().phase !== "ready") return;
      // Skipped: the download finished anyway and the in-app card offers the restart.
      if (skippedRef.current) return;
      await installNow();
    })();
    return () => {
      live = false;
      window.removeEventListener("keydown", touch, true);
      window.removeEventListener("pointerdown", touch, true);
    };
  }, []);

  const covering = armed && !skipped && st.update && st.phase !== "error";
  const installing = st.phase === "installing" || st.phase === "ready";

  return (
    <>
      {children}
      {covering && st.update && (
        <div className="fixed inset-0 z-[300] flex flex-col items-center justify-center bg-surface px-6 text-center" role="status" aria-live="polite">
          <img src="/ecliptr-mark.svg" alt="" className="mb-5 h-16 w-16 rounded-2xl" />
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Updating Ecliptr to {st.update.version}</h1>
          <div className="mt-5 h-1.5 w-[280px] max-w-full overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${installing ? 100 : Math.max(st.progress, 3)}%` }} />
          </div>
          <p className="mt-3 text-[13px] text-muted tabular-nums">
            {installing ? "Installing" : st.progress > 0 ? `Downloading ${st.progress}%` : "Downloading"}
          </p>
          <p className="mt-1 text-[12px] text-faint">Ecliptr reopens on its own when it is done.</p>
          <button onClick={() => { skippedRef.current = true; setSkipped(true); }} className="mt-6 text-[12px] text-muted underline-offset-2 hover:underline">
            Skip this time
          </button>
        </div>
      )}
      {whatsNew && !covering && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-[420px] rounded-2xl border border-line bg-surface p-5 shadow-xl" role="dialog" aria-label="What's new">
            <h2 className="text-[16px] font-semibold text-ink">Ecliptr updated to {whatsNew.version}</h2>
            {whatsNew.notes && (
              <p className="mt-3 max-h-[40vh] overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{whatsNew.notes}</p>
            )}
            <div className="mt-5 flex justify-end">
              <button onClick={() => { clearWhatsNew(); setWhatsNew(null); }}
                className="h-9 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent">
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
