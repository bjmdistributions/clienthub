interface TierBadgeProps {
  tier: string;
  size?: "sm" | "md";
}

// Flat tier tags — tier hue as a data color (dot + text) on a quiet tint.
// Alpha tints sit correctly on both light and dark surfaces.
const TIER_CONFIG: Record<string, { label: string; hue: string }> = {
  P:        { label: "Platinum", hue: "139,92,246" },   // violet — the top tier, above Diamond
  S:        { label: "Diamond",  hue: "14,165,233" },   // sky
  A:        { label: "Gold",     hue: "202,138,4" },
  B:        { label: "Silver",   hue: "100,116,139" },
  C:        { label: "Bronze",   hue: "194,65,12" },
  Prospect: { label: "Prospect", hue: "107,114,128" },
  New:      { label: "New",      hue: "107,114,128" },
};

export default function TierBadge({ tier, size = "md" }: TierBadgeProps) {
  const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG["New"];

  return (
    <span
      data-tier={tier}
      style={{
        background: `rgba(${cfg.hue}, 0.10)`,
        border: `1px solid rgba(${cfg.hue}, 0.28)`,
        color: `rgb(${cfg.hue})`,
      }}
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold leading-none whitespace-nowrap ${
        size === "sm"
          ? "px-2 py-[3px] text-[9px]"
          : "px-2.5 py-[5px] text-[11px]"
      }`}
    >
      <span className={`rounded-full flex-shrink-0 ${size === "sm" ? "w-1 h-1" : "w-1.5 h-1.5"}`}
        style={{ background: `rgb(${cfg.hue})` }} />
      {cfg.label}
    </span>
  );
}
