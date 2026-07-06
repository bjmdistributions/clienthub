import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  CopyPlus,
  ExternalLink,
  Link2,
  Loader2,
  AlertCircle,
  Check,
  Info,
  Lock,
} from "lucide-react";

interface CloneResult {
  title: string;
  newUrl: string;
  sheetCount: number;
  warnings: string[];
}

export default function SheetCopyView() {
  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Live elapsed-seconds counter while a copy is running, so a long large-sheet
  // copy visibly progresses instead of looking frozen.
  useEffect(() => {
    if (!working) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [working]);

  // Belt-and-suspenders plan gate: the tab is already hidden off-plan in App.tsx,
  // but if this view is somehow opened without Unlimited we show a calm notice
  // rather than a broken-looking tool. undefined = still resolving.
  const [plan, setPlan] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api
      .getMyPlan()
      .then((p) => setPlan(p.plan))
      .catch(() => setPlan(null));
  }, []);

  const submit = async () => {
    const trimmed = url.trim();
    if (!trimmed || working) return;
    setWorking(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const r = await api.cloneGoogleSheet(trimmed);
      setResult(r);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const openResult = () => {
    if (result) api.openExternal(result.newUrl).catch(() => {});
  };

  const copyLink = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.newUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const needsGoogle = !!error && /connect your google/i.test(error);

  // ── Plan gate (belt-and-suspenders; the tab is already hidden off-plan) ──
  // Render the tool ONLY once Unlimited is confirmed. While the plan is still
  // resolving (undefined) we show a calm loading card instead of flashing the
  // full tool — a downgraded user could have "sheetcopy" as their persisted tab.
  if (plan !== "unlimited") {
    const loading = plan === undefined;
    return (
      <div className="p-6 max-w-[720px]">
        <div className="bg-surface border border-line rounded-xl p-8 flex flex-col items-center text-center">
          <div className="w-11 h-11 rounded-xl bg-surface-2 flex items-center justify-center text-muted mb-3">
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Lock size={18} />}
          </div>
          <h2 className="text-[16px] font-bold text-ink">Sheet copy</h2>
          {!loading && (
            <p className="text-[12.5px] text-muted mt-1.5 max-w-sm leading-relaxed">
              This tool is available on the Unlimited plan. Upgrade to rebuild view-only supplier
              sheets into your own editable copies.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[720px] space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center text-accent flex-shrink-0 mt-0.5">
          <CopyPlus size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[18px] font-bold text-ink">Sheet copy</h2>
          <p className="text-[12.5px] text-muted mt-0.5 leading-relaxed">
            Paste a supplier's Google Sheets link to make your own editable copy for re-pricing.
          </p>
        </div>
      </div>

      {/* Input card */}
      <div className="bg-surface border border-line rounded-xl p-5 space-y-3">
        <label className="block text-[12px] font-medium text-muted">Google Sheets link</label>
        <div className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={working}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            style={{ background: "var(--t-input-bg)" }}
            className="flex-1 border border-line px-3 h-10 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60"
          />
          <button
            onClick={submit}
            disabled={working || !url.trim()}
            className="inline-flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {working ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Copying…
              </>
            ) : (
              <>
                <CopyPlus size={14} /> Copy to my Drive
              </>
            )}
          </button>
        </div>

        <div className="flex items-start gap-1.5 text-[11.5px] text-muted leading-relaxed">
          <Info size={13} className="text-faint flex-shrink-0 mt-0.5" />
          <span>
            Works on any sheet shared with your Google account — even when copying is disabled.
            Charts, images, and pivot tables may not carry over.
          </span>
        </div>
      </div>

      {/* Working */}
      {working && (
        <div className="bg-surface border border-accent/30 rounded-xl p-5">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin text-accent flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-ink">Copying your sheet… ({elapsed}s)</div>
              <div className="text-[12px] text-muted mt-0.5 leading-relaxed">
                Reading every tab and rebuilding it in your Drive. A large sheet can take a minute or
                two — keep this page open. It'll show a link here when it's done.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-danger-bg border border-danger-ink/20 rounded-xl p-4">
          <div className="flex items-start gap-2 text-[12.5px] text-danger-ink leading-relaxed">
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          {needsGoogle && (
            <p className="text-[11.5px] text-muted mt-2 ml-[23px] leading-relaxed">
              Head to Settings → Google Sheets to connect your Google account, then try again.
            </p>
          )}
        </div>
      )}

      {/* Success */}
      {result && (
        <div className="bg-surface border border-line-2 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2.5 px-5 py-4 border-b border-line-2 bg-success-bg/40">
            <span className="w-8 h-8 rounded-lg bg-success-bg text-success-ink flex items-center justify-center flex-shrink-0">
              <Check size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold text-ink">Done — your copy is ready</div>
              <div className="text-[11.5px] text-muted mt-0.5 truncate">
                {result.title} · {result.sheetCount}{" "}
                {result.sheetCount === 1 ? "tab" : "tabs"} · saved in your Google Drive
              </div>
            </div>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div className="flex flex-wrap gap-2.5">
              <button
                onClick={openResult}
                className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
              >
                Open in Google Sheets <ExternalLink size={13} />
              </button>
              <button
                onClick={copyLink}
                className="inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-4 h-9 rounded-lg text-[13px] font-medium transition-colors"
              >
                {copied ? (
                  <>
                    <Check size={13} className="text-success-ink" /> Copied
                  </>
                ) : (
                  <>
                    <Link2 size={13} /> Copy link
                  </>
                )}
              </button>
            </div>

            {result.warnings.length > 0 && (
              <div className="pt-1">
                <div className="text-[11px] font-medium text-muted mb-1.5">
                  A few things didn't carry over
                </div>
                <ul className="space-y-1">
                  {result.warnings.map((w, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-1.5 text-[11.5px] text-muted leading-relaxed"
                    >
                      <span className="w-1 h-1 rounded-full bg-faint flex-shrink-0 mt-[7px]" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
