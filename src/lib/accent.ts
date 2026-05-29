import { useEffect, useState } from "react";

export type AccentId = "indigo" | "red" | "green" | "black";

export interface AccentPalette {
  c50: string;
  c100: string;
  c400: string;
  c500: string;
  c600: string;
  c700: string;
  glow: string;
}

// Keep these hexes in sync with the CSS variables in index.css.
const PALETTES: Record<AccentId, AccentPalette> = {
  indigo: { c50: "#EEF2FF", c100: "#E0E7FF", c400: "#818CF8", c500: "#6366F1", c600: "#4F46E5", c700: "#4338CA", glow: "rgba(99,102,241,0.4)" },
  red:    { c50: "#FEF2F2", c100: "#FEE2E2", c400: "#F87171", c500: "#EF4444", c600: "#DC2626", c700: "#B91C1C", glow: "rgba(239,68,68,0.4)" },
  green:  { c50: "#ECFDF5", c100: "#D1FAE5", c400: "#34D399", c500: "#10B981", c600: "#059669", c700: "#047857", glow: "rgba(16,185,129,0.4)" },
  black:  { c50: "#F4F4F5", c100: "#E4E4E7", c400: "#71717A", c500: "#52525B", c600: "#27272A", c700: "#18181B", glow: "rgba(24,24,27,0.35)" },
};

export function paletteFor(id: string): AccentPalette {
  return PALETTES[(id as AccentId)] || PALETTES.indigo;
}

export function currentAccentId(): AccentId {
  const a = (localStorage.getItem("clienthub_accent") || "indigo") as AccentId;
  return PALETTES[a] ? a : "indigo";
}

export function getAccentPalette(): AccentPalette {
  return PALETTES[currentAccentId()];
}

/** React hook that returns the live accent palette and re-renders on change. */
export function useAccent(): AccentPalette {
  const [palette, setPalette] = useState<AccentPalette>(() => getAccentPalette());
  useEffect(() => {
    const handler = () => setPalette(getAccentPalette());
    window.addEventListener("accent-change", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("accent-change", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return palette;
}
