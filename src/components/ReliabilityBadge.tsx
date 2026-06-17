import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";

/**
 * Buyer reliability — how often the quotes we send a client actually convert
 * into a deal. Only meaningful after a few quotes; flagged once >= 3 are sent.
 * "low" is shown boldly so a client who keeps getting quotes but never buys
 * stands out as not a serious buyer.
 */
export default function ReliabilityBadge({
  reliability, pct, quotesSent, quotesWon, size = "sm", compact = false,
}: {
  reliability: string;
  pct: number;
  quotesSent: number;
  quotesWon: number;
  size?: "sm" | "md";
  compact?: boolean;
}) {
  if (reliability === "unrated") {
    if (quotesSent === 0 || compact) return null;
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted" title={`${quotesSent} quote(s) sent — need 3 to rate reliability`}>
        <MinusCircle size={11} /> Unrated
      </span>
    );
  }

  const cfg = {
    reliable: { cls: "bg-success-bg text-success-ink border-success", icon: CheckCircle2, label: compact ? "Reliable" : "Reliable buyer" },
    mixed:    { cls: "bg-warning-bg text-warning-ink border-warning",       icon: AlertTriangle, label: compact ? "Mixed" : "Mixed" },
    low:      { cls: "bg-danger-bg text-danger-ink border-danger",            icon: AlertTriangle, label: compact ? "Low intent" : "Not a serious buyer" },
  }[reliability] ?? { cls: "bg-surface-2 text-muted border-line", icon: MinusCircle, label: reliability };

  const Icon = cfg.icon;
  const pad = size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";
  const tip = `Converted ${quotesWon} of ${quotesSent} quotes (${pct.toFixed(0)}%)`;

  return (
    <span title={tip}
      className={`inline-flex items-center gap-1 rounded-full border font-semibold ${pad} ${cfg.cls} ${reliability === "low" ? "uppercase tracking-wide" : ""}`}>
      <Icon size={size === "md" ? 13 : 11} className="flex-shrink-0" />
      {cfg.label}
      <span className="font-normal opacity-70">· {pct.toFixed(0)}%</span>
    </span>
  );
}
