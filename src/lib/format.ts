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
