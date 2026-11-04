import StatusPill from "./StatusPill";

interface TierBadgeProps {
  tier: string;
  size?: "sm" | "md";
}

// R-583: a tier is rank, not meaning, so it is grey like every other non-status tag: the top three read in
// the ink, the lower two and a new client in the muted greys. Still a StatusPill, so it never wraps.
const TIER_CONFIG: Record<string, { label: string; cls: string }> = {
  P:        { label: "Platinum", cls: "text-ink" },
  S:        { label: "Diamond",  cls: "text-ink" },
  A:        { label: "Gold",     cls: "text-ink" },
  B:        { label: "Silver",   cls: "text-muted" },
  C:        { label: "Bronze",   cls: "text-muted" },
  Prospect: { label: "Prospect", cls: "text-faint" },
  New:      { label: "New",      cls: "text-faint" },
};

export default function TierBadge({ tier, size = "md" }: TierBadgeProps) {
  const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG["New"];
  return (
    <span data-tier={tier} className="inline-flex">
      <StatusPill className={`bg-surface-3 ${cfg.cls}`} size={size === "sm" ? "sm" : "md"}>{cfg.label}</StatusPill>
    </span>
  );
}
