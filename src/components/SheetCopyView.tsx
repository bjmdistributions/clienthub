import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "./Toast";
import { copyText, COPY_FAILED } from "../lib/clipboard";
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

  const copyLink = async () => {
    if (!result) return;
    if (!(await copyText(result.newUrl))) { toast(COPY_FAILED, "error"); return; }
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
      <div className="max-w-[720px]">
        <div className="py-8 flex flex-col items-center text-center">
          <span className="text-muted mb-3">
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Lock size={18} />}
          </span>
          <h2 className="text-[16px] font-medium text-ink">Sheet copy</h2>
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
    <div className="max-w-[720px] space-y-5">
      <p className="text-[13px] text-muted">
        Paste a supplier's Google Sheets link to make your own editable copy for re-pricing.
      </p>

      {/* Input */}
      <div className="space-y-3">
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
            className="flex-1 border border-line-3 px-3 h-9 rounded-lg text-[13.5px] text-ink placeholder:text-faint focus:outline-none focus:border-ink transition-colors disabled:opacity-60"
          />
          <button
            onClick={submit}
            disabled={working || !url.trim()}
            className="ui-btn ui-btn-ink justify-center flex-shrink-0"
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
            Works on any sheet shared with your Google account (even when copying is disabled).
            Charts, images, and pivot tables may not carry over.
          </span>
        </div>
      </div>

      {/* Working */}
      {working && (
        <div className="border-t border-line pt-5">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin text-ink-2 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">Copying your sheet… ({elapsed}s)</div>
              <div className="text-[12px] text-muted mt-0.5 leading-relaxed">
                Reading every tab and rebuilding it in your Drive. A large sheet can take a minute or
                two. Keep this page open. It'll show a link here when it's done.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-danger-bg rounded-xl p-4">
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
        <div className="border-t border-line">
          <div className="flex items-center gap-2.5 py-4 border-b border-line">
            <Check size={16} className="text-success-ink flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-ink">Done: your copy is ready</div>
              <div className="text-[11.5px] text-muted mt-0.5 truncate">
                {result.title} · {result.sheetCount}{" "}
                {result.sheetCount === 1 ? "tab" : "tabs"} · saved in your Google Drive
              </div>
            </div>
          </div>

          <div className="py-4 space-y-4">
            <div className="flex flex-wrap gap-2.5">
              <button
                onClick={openResult}
                className="ui-btn ui-btn-ink"
              >
                Open in Google Sheets <ExternalLink size={13} />
              </button>
              <button
                onClick={copyLink}
                className="ui-btn"
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
                      <span className="text-faint flex-shrink-0">-</span>
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
