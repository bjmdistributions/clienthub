// Shared look and small helpers for the Warehouse screens (R-326..R-328).

export const WH_INPUT =
  "w-full border border-line-3 px-3 h-8 rounded-lg text-[13px] text-ink placeholder:text-faint focus:outline-none focus:border-ink transition-colors duration-150";
export const WH_INPUT_BG = { background: "var(--t-input-bg)" };
export const WH_BTN_PRIMARY =
  "ui-btn ui-btn-ink";
export const WH_BTN_SECONDARY =
  "ui-btn";
export const WH_CARD = "border border-line rounded-xl";

export const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
export const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36));

/** "Team" -> "teams", "Category" -> "categories". */
export function plural(label: string): string {
  const l = (label || "Section").trim().toLowerCase();
  if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/.test(l)) return l + "es";
  return l + "s";
}

/** Team colours on the warehouse map — Apple system colours, as "r g b" for rgb(... / alpha).
 *  Never the brand accent, never ochre or gold. Labels always sit beside the colour, so a
 *  colour repeating after ten teams is fine. */
const TEAM_COLORS = [
  "var(--c-chart-1)", "var(--c-chart-2)", "var(--c-chart-3)", "var(--c-chart-4)", "var(--c-chart-5)",
  "var(--c-chart-6)", "var(--c-chart-profit)", "var(--c-chart-loss)", "0 199 190", "50 173 230",
];

/** A stable colour for whatever a map spot holds (see lib/warehouse cellKey). */
export function teamColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}
export const rgba = (triplet: string, a: number) => `rgb(${triplet} / ${a})`;

/** How full a spot is, as colour (R-332): full green, partly full orange, empty red — the
 *  Apple semantic colours. A spot with nothing marked on it takes none. */
export const FILL_COLORS = { full: "var(--c-chart-profit)", partial: "var(--c-chart-caution)", empty: "var(--c-chart-loss)" } as const;
