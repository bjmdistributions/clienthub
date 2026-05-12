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
    bg: "linear-gradient(135deg, rgba(99,102,241,0.13) 0%, rgba(139,92,246,0.13) 100%)",
    border: "rgba(139,92,246,0.3)",
    color: "#6D28D9",
    shadow: "0 0 14px rgba(99,102,241,0.2), inset 0 1px 0 rgba(255,255,255,0.15)",
  },
  A: {
    label: "Gold",
    glyph: "★",
    bg: "linear-gradient(135deg, rgba(245,158,11,0.11) 0%, rgba(251,191,36,0.11) 100%)",
    border: "rgba(245,158,11,0.3)",
    color: "#B45309",
    shadow: "0 0 10px rgba(245,158,11,0.15), inset 0 1px 0 rgba(255,255,255,0.1)",
  },
  B: {
    label: "Silver",
    glyph: "●",
    bg: "linear-gradient(135deg, rgba(100,116,139,0.09) 0%, rgba(148,163,184,0.09) 100%)",
    border: "rgba(148,163,184,0.3)",
    color: "#475569",
    shadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
  },
  C: {
    label: "Bronze",
    glyph: "○",
    bg: "linear-gradient(135deg, rgba(120,53,15,0.08) 0%, rgba(180,83,9,0.08) 100%)",
    border: "rgba(180,83,9,0.22)",
    color: "#92400E",
    shadow: "none",
  },
  Prospect: {
    label: "Prospect",
    glyph: "·",
    bg: "rgba(249,250,251,1)",
    border: "rgba(209,213,219,1)",
    color: "#9CA3AF",
    shadow: "none",
  },
};

export default function TierBadge({ tier, size = "md" }: TierBadgeProps) {
  const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG["Prospect"];

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
