// R-559: a lot may come off the site on its own, `expire_days` after its last renewal
// (`updated_at`, the same clock the "Renew or mark sold" ask reads). The server archives
// it (clienthub-api routes/lot_timer.rs) and hides it from the storefront the minute it
// is due; this file only says when. Absent or 0 = the lot stays up until taken down.
// The phone's copy is lotTimeLeft in www/app.js.

export const MAX_EXPIRE_DAYS = 365;

type TimedLot = { status: string; updated_at: string; details_json?: string | null };

export function expireDays(detailsJson?: string | null): number {
  try {
    const n = Math.floor(Number(JSON.parse(detailsJson || "{}")?.expire_days) || 0);
    return n > 0 ? Math.min(n, MAX_EXPIRE_DAYS) : 0;
  } catch { return 0; }
}

/** "1d 4h" until an available timed lot comes off, "now" once due, null when it has no timer. */
export function timeLeft(lot: TimedLot, now = Date.now()): string | null {
  const days = expireDays(lot.details_json);
  if (lot.status !== "available" || days <= 0) return null;
  const t = Date.parse(lot.updated_at);
  if (Number.isNaN(t)) return null;
  const left = t + days * 86_400_000 - now;
  if (left <= 0) return "now";
  const h = Math.ceil(left / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`;
}
