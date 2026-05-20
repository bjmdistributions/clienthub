interface TierBadgeProps {
  tier: string;
  size?: "sm" | "md";
}

const TIER_CONFIG: Record<string, {
  label: string;
  glyph: string;
  bg: string;
  border: string;
  color: string;
  shadow: string;
}> = {
  S: {
    label: "Diamond",
    glyph: "◆",
    bg: "linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(251,191,36,0.14) 100%)",
    border: "rgba(245,158,11,0.35)",
    color: "#92400E",
    shadow: "0 0 12px rgba(245,158,11,0.2), inset 0 1px 0 rgba(255,255,255,0.15)",
  },
  A: {
    label: "Gold",
    glyph: "★",
    bg: "linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(129,140,248,0.1) 100%)",
    border: "rgba(99,102,241,0.28)",
    color: "#4338CA",
    shadow: "0 0 8px rgba(99,102,241,0.12), inset 0 1px 0 rgba(255,255,255,0.1)",
  },
  B: {
    label: "Silver",
    glyph: "●",
    bg: "linear-gradient(135deg, rgba(16,185,129,0.1) 0%, rgba(52,211,153,0.1) 100%)",
    border: "rgba(16,185,129,0.28)",
    color: "#047857",
    shadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
  },
  C: {
    label: "Bronze",
    glyph: "○",
    bg: "linear-gradient(135deg, rgba(249,115,22,0.1) 0%, rgba(251,146,60,0.1) 100%)",
    border: "rgba(249,115,22,0.25)",
    color: "#C2410C",
    shadow: "none",
  },
  Prospect: {
    label: "Prospect",
    glyph: "·",
    bg: "rgba(249,250,251,1)",
    border: "rgba(209,213,219,1)",
    color: "#6B7280",
    shadow: "none",
  },
  New: {
    label: "New",
    glyph: "✦",
    bg: "rgba(249,250,251,1)",
    border: "rgba(209,213,219,1)",
    color: "#6B7280",
    shadow: "none",
  },
};

export default function TierBadge({ tier, size = "md" }: TierBadgeProps) {
  const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG["New"];

  return (
    <span
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        color: cfg.color,
        boxShadow: cfg.shadow,
      }}
      className={`inline-flex items-center gap-1 rounded-full font-semibold leading-none whitespace-nowrap ${
        size === "sm"
          ? "px-2 py-[3px] text-[9px]"
          : "px-2.5 py-[5px] text-[11px]"
      }`}
    >
      <span className={size === "sm" ? "text-[7px]" : "text-[8px]"}>{cfg.glyph}</span>
      {cfg.label}
    </span>
  );
}
