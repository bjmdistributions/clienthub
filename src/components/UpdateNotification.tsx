import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, X, Check } from "lucide-react";

export default function UpdateNotification() {
  const [update, setUpdate] = useState<any>(null);
  const [dismissed, setDismissed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const u = await check();
        if (u) {
          const saved = localStorage.getItem("clienthub_update_dismissed");
          if (saved !== u.version) setUpdate(u);
        }
      } catch (e: any) { console.warn("Update check failed:", e?.message ?? e); }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (!update || dismissed) return null;

  const handleInstall = async () => {
    setError(null);
    setDownloading(true);
    let total = 0, got = 0;
    try {
      await update.downloadAndInstall((e: any) => {
        // Tauri v2 emits Started / Progress / Finished with payload on `e.data`.
        if (e.event === "Started") total = e.data?.contentLength ?? 0;
        if (e.event === "Progress") {
          got += e.data?.chunkLength ?? 0;
          if (total > 0) setProgress(Math.round((got / total) * 100));
        }
        if (e.event === "Finished") { setDownloading(false); setInstalling(true); }
      });
      await relaunch();
    } catch (err: any) {
      // Never swallow silently — a signing-key mismatch or download failure must
      // be visible, not look like a no-op click.
      setDownloading(false);
      setInstalling(false);
      setError(err?.message ?? String(err));
      console.error("Update failed:", err);
    }
  };

  const handleLater = () => {
    setDismissed(true);
    localStorage.setItem("clienthub_update_dismissed", update.version);
  };

  return (
    <div className="sticky top-0 z-50 flex items-center justify-between px-5 py-3"
      style={{ background: "var(--accent-tint)", borderBottom: "1px solid var(--accent-glow)" }}>
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: "linear-gradient(135deg, var(--accent-500), var(--accent-700))", boxShadow: "0 0 12px var(--accent-glow)" }}>
          <Download size={14} className="text-on-accent" />
        </div>
        <div>
          <p className="text-[13px] font-semibold" style={{ color: "var(--t-tx1)" }}>Ecliptr {update.version} is available</p>
          <p className="text-[11px]" style={{ color: error ? "var(--danger, #ef4444)" : "var(--t-tx3)" }}>
            {error ? `Update failed: ${error}` : installing ? "Installing… app will restart" : downloading ? `Downloading… ${progress}%` : "Update now to get the latest features and fixes"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {!installing && (
          <button onClick={handleLater} className="h-8 px-3 rounded-lg text-[12px] font-medium transition-colors"
            style={{ color: "var(--t-tx2)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-glow)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
            Later
          </button>
        )}
        <button
          onClick={handleInstall}
          disabled={downloading || installing}
          className="h-8 px-4 rounded-lg text-[12px] font-semibold text-on-accent disabled:opacity-50 transition-all flex items-center gap-1.5"
          style={{ background: "linear-gradient(135deg, var(--accent-600), var(--accent-500))", boxShadow: "0 2px 8px var(--accent-glow)" }}
        >
          {installing ? <Check size={12} /> : downloading ? <span className="w-3 h-3 border-2 border-on-accent/40 border-t-on-accent rounded-full animate-spin" /> : null}
          {installing ? "Restarting…" : downloading ? "Downloading" : "Install Now"}
        </button>
      </div>
    </div>
  );
}
