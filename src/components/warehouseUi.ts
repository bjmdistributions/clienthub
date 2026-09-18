// Shared look and small helpers for the Warehouse screens (R-326..R-328).

export const WH_INPUT =
  "w-full border border-line px-3 h-9 rounded-lg text-[13px] text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
export const WH_INPUT_BG = { background: "var(--t-input-bg)" };
export const WH_BTN_PRIMARY =
  "inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40";
export const WH_BTN_SECONDARY =
  "inline-flex items-center gap-1.5 border border-line text-ink-2 hover:bg-surface-2 px-3.5 h-9 rounded-lg text-[13px] transition-colors disabled:opacity-40";
export const WH_CARD = "bg-surface border border-line rounded-xl";

export const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
export const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36));

/** "Team" -> "teams", "Category" -> "categories". */
export function plural(label: string): string {
  const l = (label || "Section").trim().toLowerCase();
  if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/.test(l)) return l + "es";
  return l + "s";
}
