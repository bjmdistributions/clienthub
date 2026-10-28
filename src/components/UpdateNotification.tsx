import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api } from "../lib/api";
import { checkNow, downloadIfNeeded, installNow, friendlyError, useUpdateState, getUpdateState, mayAutoInstall, readAttempts } from "../lib/updater";

// R-409: one update check per launch, shared by every mount. This used to be remounted on
// every tab click, and each mount hid it and ran check() again two seconds later, so it
// popped back in and pushed the page down each time ("the top bar flashes repeatedly").
// The check, the download and the state now live in lib/updater, so a remount renders the
// answer it already has, at once.
//
// R-561: a visible card instead of a thin strip. It floats in the corner, so it never
// moves the page. The update downloads quietly in the background; the card appears when
// it is ready (or when the download failed). Later hides it for this session only.
const RECHECK_MS = 4 * 60 * 60 * 1000;
let recheckTimer: ReturnType<typeof setInterval> | null = null;
let laterVersion: string | null = null;

// A remount (leaving the globe tab) does not re-download after a failure; the 4-hour re-check does.
function lookForUpdate(force: boolean) {
  checkNow(force).then((u) => { if (u && (force || getUpdateState().phase !== "error")) downloadIfNeeded(); });
}

export default function UpdateNotification() {
  const st = useUpdateState();
  const [later, setLater] = useState(laterVersion);

  useEffect(() => {
    lookForUpdate(false);
    if (!recheckTimer) recheckTimer = setInterval(() => lookForUpdate(true), RECHECK_MS);
  }, []);

  const u = st.update;
  if (!u || later === u.version) return null;
  if (st.phase !== "ready" && st.phase !== "installing" && st.phase !== "error") return null;

  const error = st.phase === "error" ? st.error : null;
  const installing = st.phase === "installing";
  const handleLater = () => { laterVersion = u.version; setLater(u.version); };
  // Fallback when the in-app updater can't write in place (common on macOS when the
  // app is quarantined/translocated): send the user to the download page, which
  // starts a direct download of the newest installer, never a GitHub page.
  const openDownload = () => { api.openExternal("https://ecliptr.app/download").catch(() => {}); };

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[340px] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-line bg-surface p-4 shadow-xl" role="status">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--accent-600)" }}>
          <Download size={16} className="text-on-accent" />
        </div>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink">
            {error ? `Ecliptr ${u.version} is available` : `Ecliptr ${u.version} is ready`}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: error ? "var(--danger, #ef4444)" : "var(--t-tx3)" }}>
            {error ? friendlyError(error) : installing ? "Restarting…" : mayAutoInstall(readAttempts(), u.version) ? "It installs the next time you open Ecliptr." : "Restart now to install it."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {!installing && (
          <button onClick={handleLater} className="h-8 rounded-lg px-3 text-[12px] font-medium text-ink-2 transition-colors hover:bg-surface-2">
            Later
          </button>
        )}
        <button
          onClick={error ? openDownload : () => installNow()}
          disabled={installing}
          className="flex h-8 items-center gap-1.5 rounded-lg px-4 text-[12px] font-semibold text-on-accent transition-all disabled:opacity-50"
          style={{ background: "var(--accent-600)" }}
        >
          {error ? "Download update" : installing ? "Restarting…" : "Restart now"}
        </button>
      </div>
    </div>
  );
}
