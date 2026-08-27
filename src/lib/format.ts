/** Coerce anything (null, undefined, NaN, a string) to a finite number, else 0.
 *  Money fields come straight from the API/DB and an occasional null/NaN would throw
 *  inside toLocaleString and, without an error boundary, blank the whole app. */
const safeNum = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

export const fmtAmount = (n: number) =>
  "$" + safeNum(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtFullAmount = (n: number) =>
  "$" + safeNum(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Format a phone number as xxx-xxx-xxxx (US), dropping a leading +1/1 and any
 *  parentheses/spaces. Non-10-digit input returns the cleaned digits as-is. */
export function fmtPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

/** The supplier name(s) to show on a deal — real product suppliers only
 *  (category null or "supplier"; freight/wire_in/wire_out/other are cost lines,
 *  NOT the supplier). Returns null when there is no supplier yet, a single name,
 *  or "First +N" when there are several (full list belongs in a title/tooltip). */
export function primarySupplierLabel(
  payments: { supplier_name?: string | null; category?: string | null }[] | null | undefined,
): string | null {
  if (!payments || !payments.length) return null;
  const names = Array.from(
    new Set(
      payments
        .filter((p) => p.category == null || p.category === "supplier")
        .map((p) => (p.supplier_name || "").trim())
        .filter(Boolean),
    ),
  );
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

/** Today as YYYY-MM-DD in LOCAL time (R-159). toISOString() is UTC — from
 *  6/7pm Central it is already tomorrow, so evening defaults landed entries
 *  on the wrong day (and, at month-end, in the wrong month). */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Current month as YYYY-MM in LOCAL time (R-159). */
export const localMonth = (): string => localDay().slice(0, 7);

/** Parse a bare YYYY-MM-DD or YYYY-MM at LOCAL midnight (R-159) —
 *  new Date("YYYY-MM-DD") parses UTC midnight, which renders one day/month
 *  early in Central. Full timestamps fall through to normal parsing. */
export function parseLocalDay(s: string): Date {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec((s || "").slice(0, 10));
  return m ? new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1) : new Date(s);
}

export function fmtCompactCurrency(n: number): string {
  n = safeNum(n);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return sign + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs < 1_000_000) {
    const k = abs / 1000;
    return sign + "$" + (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + "k";
  }
  return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
}

/** Parse a number a person typed or PASTED — "$1,234.56", "1,234", " 12.50 " (R-206).
 *
 *  `<input type="number">` refuses a value it cannot parse, so a pasted "1,234.56"
 *  leaves the element in bad-input state and `e.target.value` reads back as the
 *  empty string. Every caller then did `parseFloat("") || 0` and stored **0** — the
 *  bug Jack reported as "I paste a number and it saves as zero". Currency symbols,
 *  thousands separators and spaces are stripped here instead, so the figure survives
 *  whichever way it arrived. A string with no number in it returns `fallback`. */
export function parseAmount(v: string | number | null | undefined, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (v == null) return fallback;
  const n = parseFloat(String(v).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

/** `parseAmount` for a whole-number field — quantities, pallets, ports, days.
 *  "1,250" → 1250, "12.9" → 12 (truncated, the same as the parseInt it replaces). */
export function parseCount(v: string | number | null | undefined, fallback = 0): number {
  const n = parseAmount(v, NaN);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
