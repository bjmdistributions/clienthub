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
    <div className="sticky top-0 z-50 flex items-center justify-between px-5 py-3 border-b border-indigo-200/50"
      style={{ background: "linear-gradient(135deg, var(--accent-50) 0%, var(--accent-100) 50%, var(--accent-100) 100%)" }}>
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
          <Download size={14} className="text-white" />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-indigo-900">ClientHub {update.version} is available</p>
          <p className="text-[11px] text-indigo-500">
            {installing ? "Installing… app will restart" : downloading ? `Downloading… ${progress}MB` : "Update now to get the latest features and fixes"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {!installing && (
          <button onClick={handleLater} className="h-8 px-3 rounded-lg text-[12px] font-medium text-indigo-500 hover:bg-indigo-100/60 transition-colors">
            Later
          </button>
        )}
        <button
          onClick={handleInstall}
          disabled={downloading || installing}
          className="h-8 px-4 rounded-lg text-[12px] font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        >
          {installing ? <Check size={12} /> : downloading ? <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : null}
          {installing ? "Restarting…" : downloading ? "Downloading" : "Install Now"}
        </button>
      </div>
    </div>
  );
}
