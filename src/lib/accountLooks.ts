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

// R-688 (Jack, 2026-11-24): "it look at the most current and up to sate bank balance. if it does not match waht out
// ledger records has. the system needs to on its own check every single transaction against the books to find
// discrepencyies ... if i wanted to manual check this stuff i would have already done it." What an account's row
// says is the outcome of that automatic transaction check, never a bare "off by" figure for him to chase:
//   match      the books fit the bank's balance, or the check found nothing left on the account
//   checking   the balance does not fit and the transactions are being checked now (no click)
//   answer     the check is done and these exact transactions need his answer, shown under the row
//   waiting    everything is checked and answered; the bank's own balance has not caught up yet
//   unread     the bank could not be read for the account just now; it is tried again by itself
//   connection the bank needs reconnecting, so nothing can be checked
//   elsewhere  another of his computers feeds and checks this account
export type AccountCheck =
  | { kind: "none" } | { kind: "match" } | { kind: "checking" } | { kind: "waiting" } | { kind: "unread" } | { kind: "connection" }
  | { kind: "answer"; count: number } | { kind: "elsewhere"; on: string };

export function accountCheck(
  a: { type: string; needs_fix?: boolean; drift: number | null; checked?: boolean | null; checked_on?: string | null },
  /** How many transactions on this account are waiting on his answer. */
  todo: number,
  /** A check is running now. */
  running: boolean,
  /** A check already ran for the state this account is in. */
  tried: boolean,
): AccountCheck {
  if (a.type !== "depository" && a.type !== "credit") return { kind: "none" };
  if (a.needs_fix) return { kind: "connection" };
  if (a.drift == null) return a.checked_on ? { kind: "elsewhere", on: a.checked_on } : { kind: "none" };
  if (todo > 0) return { kind: "answer", count: todo };
  if (Math.abs(a.drift) < 0.005) return { kind: "match" };
  if (running) return { kind: "checking" };
  if (a.checked) return { kind: "waiting" };
  return tried ? { kind: "unread" } : { kind: "checking" };
}

/** Whether the row is marked red: only when there is something for him to do. */
export const needsALook = (c: AccountCheck) => c.kind === "connection" || c.kind === "answer";

// R-683 (Jack, 2026-11-23): "preset platinum gold cards in theer and pulling predesigns for all other business cards".
// A credit card is drawn in a preset finish: the metal or colour its name says (a card named Platinum is platinum),
// picked by `autoFinish` until he chooses one in Card look. These are finishes, not any bank's artwork; the bank's
// logo sits on top. "plain" is his own colour (or the bank's). The phone mirrors this list in www/app.js (ACCT_FINISHES).

export interface CardFinish {
  id: string;
  name: string;
  /** The card's face, a CSS background. */
  background: string;
  /** Near-black text on it (pale metals) rather than white. */
  dark: boolean;
  /** A hairline frame inside the edge, as metal cards have. */
  frame: boolean;
  /** Words in a card's name that mean this finish. */
  match: RegExp;
}

const metal = (a: string, b: string, c: string, d: string, e: string) =>
  `linear-gradient(125deg, ${a} 0%, ${b} 24%, ${c} 52%, ${d} 76%, ${e} 100%)`;

/** In matching order: Rose gold before Gold, the metals before the colours. */
export const CARD_FINISHES: CardFinish[] = [
  { id: "rose-gold", name: "Rose gold", dark: true, frame: true, match: /rose\s*gold/i, background: metal("#E3ADA1", "#F8DDD6", "#C58B7F", "#F0C9C0", "#B27467") },
  { id: "platinum", name: "Platinum", dark: true, frame: true, match: /platinum|\bplat\b/i, background: metal("#D7D9DD", "#F5F6F7", "#B4B8BF", "#ECEDEF", "#9FA4AC") },
  { id: "gold", name: "Gold", dark: true, frame: true, match: /gold/i, background: metal("#D9B45A", "#F6E3A1", "#B98A2E", "#F1D788", "#A67A22") },
  { id: "black", name: "Black metal", dark: false, frame: true, match: /\bblack\b|centurion|reserve|infinite|onyx/i, background: metal("#2C2C2F", "#48484C", "#121214", "#2F2F33", "#050506") },
  { id: "titanium", name: "Titanium", dark: false, frame: false, match: /titanium|graphite|\bspark\b|venture|\bmetal\b|silver/i, background: metal("#6B6F77", "#8E929A", "#4A4D54", "#767A82", "#3A3D43") },
  { id: "sapphire", name: "Sapphire", dark: false, frame: false, match: /sapphire|\bink\b|\bblue\b|preferred|unlimited/i, background: metal("#1E4AA0", "#2F66C8", "#12306E", "#1C4390", "#0B2152") },
  { id: "emerald", name: "Emerald", dark: false, frame: false, match: /\bgreen\b|emerald/i, background: metal("#12805E", "#1FA277", "#0A5A41", "#137453", "#06402E") },
  { id: "plum", name: "Plum", dark: false, frame: false, match: /\bplum\b|purple/i, background: metal("#6A2F80", "#8A46A3", "#44185A", "#5E2A74", "#2E0F3F") },
  { id: "ruby", name: "Ruby", dark: false, frame: false, match: /\bred\b|ruby/i, background: metal("#B4202C", "#D43A45", "#7F121B", "#A31C27", "#5C0B12") },
  { id: "pearl", name: "Pearl", dark: true, frame: false, match: /pearl|\bwhite\b/i, background: metal("#F7F6F2", "#FFFFFF", "#E2E0DA", "#F3F2EE", "#D5D3CC") },
];

/** The chip on a card's face. */
export const CARD_CHIP = "linear-gradient(135deg, #E8D08A 0%, #B8923A 50%, #F1DFA6 100%)";

/** The finish a card's name says, or null when it names none. */
export function autoFinish(name: string): CardFinish | null {
  return CARD_FINISHES.find((f) => f.match.test(name)) ?? null;
}

/** The finish a card is drawn in: his choice, else what its name says; null is his own colour ("plain", an unknown
 *  id from a newer version, or a name that says nothing). */
export function finishFor(chosen: string | undefined, name: string): CardFinish | null {
  if (chosen) return CARD_FINISHES.find((f) => f.id === chosen) ?? null;
  return autoFinish(name);
}
