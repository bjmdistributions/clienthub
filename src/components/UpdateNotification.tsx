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

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const u = await check();
        if (u) {
          const saved = localStorage.getItem("clienthub_update_dismissed");
          if (saved !== u.version) setUpdate(u);
        }
      } catch {}
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  if (!update || dismissed) return null;

  const handleInstall = async () => {
    setDownloading(true);
    try {
      await update.downloadAndInstall((e: any) => {
        if (e.event === "Downloaded") {
          const pct = Math.round((e.payload.contentLength ?? 0) / 1_000_000);
          if (pct > 0) setProgress(pct);
        }
        if (e.event === "Finished") { setDownloading(false); setInstalling(true); }
      });
      await relaunch();
    } catch {
      setDownloading(false);
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
          <Download size={14} className="text-white" />
        </div>
        <div>
          <p className="text-[13px] font-semibold" style={{ color: "var(--t-tx1)" }}>ClientHub {update.version} is available</p>
          <p className="text-[11px]" style={{ color: "var(--t-tx3)" }}>
            {installing ? "Installing… app will restart" : downloading ? `Downloading… ${progress}MB` : "Update now to get the latest features and fixes"}
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
          className="h-8 px-4 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50 transition-all flex items-center gap-1.5"
          style={{ background: "linear-gradient(135deg, var(--accent-600), var(--accent-500))", boxShadow: "0 2px 8px var(--accent-glow)" }}
        >
          {installing ? <Check size={12} /> : downloading ? <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : null}
          {installing ? "Restarting…" : downloading ? "Downloading" : "Install Now"}
        </button>
      </div>
    </div>
  );
}
