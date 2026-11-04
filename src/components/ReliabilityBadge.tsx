import StatusPill from "./StatusPill";

/**
 * Buyer reliability: how often the quotes we send a client actually convert
 * into a deal. Only meaningful after a few quotes; flagged once >= 3 are sent.
 * "low" is shown in the loss red so a client who keeps getting quotes but never buys
 * stands out as not a serious buyer. R-583: it is a StatusPill like every other badge.
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
      <span className="inline-flex items-center text-[12px] font-medium text-muted" title={`${quotesSent} quote(s) sent: need 3 to rate reliability`}>
        Unrated
      </span>
    );
  }

  const cfg = ({
    reliable: { tone: "success", label: compact ? "Reliable" : "Reliable buyer" },
    mixed:    { tone: "warning", label: "Mixed" },
    low:      { tone: "danger",  label: compact ? "Low intent" : "Not a serious buyer" },
  } as const)[reliability as "reliable" | "mixed" | "low"] ?? { tone: "neutral" as const, label: reliability };

  const tip = `Converted ${quotesWon} of ${quotesSent} quotes (${pct.toFixed(0)}%)`;

  return (
    <StatusPill tone={cfg.tone} size={size === "md" ? "md" : "sm"} title={tip}>
      <span className="truncate">{cfg.label}</span>
      <span className="font-normal opacity-70 flex-shrink-0 ml-1">{pct.toFixed(0)}%</span>
    </StatusPill>
  );
}
