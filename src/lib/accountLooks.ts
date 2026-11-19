// R-678: how an account's card is drawn (its colour, the text that reads on it) and what is wrong with it, kept apart
// from the screen so it can be tested. The phone mirrors these in www/app.js (acctCard*).

/** Card colours to pick from: Apple's system colours, then graphite, black and silver. */
export const CARD_COLOURS: { name: string; hex: string }[] = [
  { name: "Blue", hex: "#007AFF" },
  { name: "Indigo", hex: "#5856D6" },
  { name: "Purple", hex: "#AF52DE" },
  { name: "Pink", hex: "#FF2D55" },
  { name: "Red", hex: "#FF3B30" },
  { name: "Orange", hex: "#FF9500" },
  { name: "Green", hex: "#34C759" },
  { name: "Teal", hex: "#30B0C7" },
  { name: "Graphite", hex: "#3A3A3C" },
  { name: "Black", hex: "#1C1C1E" },
  { name: "Silver", hex: "#AEAEB2" },
];

/** A card with no colour from him or the bank. */
export const CARD_DEFAULT = "#3A3A3C";

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Relative luminance (WCAG) of a #RRGGBB colour; 0 when it is not one. */
export function luminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether a card in this colour takes dark text. White stays on the strong colours (blue, red, teal), as a bank's
 *  own card does; only pale ones (silver, yellow, light green) take near-black. */
export function darkText(hex: string): boolean {
  return luminance(hex) > 0.4;
}

export interface AccountIssue { kind: "connection" | "books"; text: string }

/** What is wrong with an account, worst first: its bank needs reconnecting, or the books do not match the bank. */
export function accountIssue(a: { needs_fix?: boolean; drift: number | null }, fmt: (n: number) => string): AccountIssue | null {
  if (a.needs_fix) return { kind: "connection", text: "The bank connection needs fixing, so this balance may be old." };
  if (a.drift != null && Math.abs(a.drift) >= 0.005) return { kind: "books", text: `Your books are ${fmt(Math.abs(a.drift))} away from what the bank shows.` };
  return null;
}
