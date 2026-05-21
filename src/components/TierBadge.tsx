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
    bg: "linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 40%, #BAE6FD 70%, #EFF6FF 100%)",
    border: "rgba(14,165,233,0.45)",
    color: "#0369A1",
    shadow: "0 0 16px rgba(14,165,233,0.22), 0 0 4px rgba(186,230,253,0.5), inset 0 1px 0 rgba(255,255,255,0.8)",
  },
  A: {
    label: "Gold",
    glyph: "★",
    bg: "linear-gradient(135deg, #FEFCE8 0%, #FEF9C3 50%, #FEF08A 100%)",
    border: "rgba(202,138,4,0.45)",
    color: "#854D0E",
    shadow: "0 0 12px rgba(234,179,8,0.22), inset 0 1px 0 rgba(255,255,255,0.6)",
  },
  B: {
    label: "Silver",
    glyph: "●",
    bg: "linear-gradient(135deg, #F8FAFC 0%, #E2E8F0 50%, #F1F5F9 100%)",
    border: "rgba(100,116,139,0.4)",
    color: "#334155",
    shadow: "0 0 8px rgba(148,163,184,0.15), inset 0 1px 0 rgba(255,255,255,0.7)",
  },
  C: {
    label: "Bronze",
    glyph: "○",
    bg: "linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 50%, #FED7AA 100%)",
    border: "rgba(194,65,12,0.35)",
    color: "#9A3412",
    shadow: "0 0 8px rgba(234,88,12,0.1), inset 0 1px 0 rgba(255,255,255,0.4)",
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
      data-tier={tier}
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
