// R-466: inventory renewals get their own screen. A storefront listing that has not been renewed in five days
// raises a "Renew or mark sold" request (kind listing_stale). The Notifications screen used to list every one
// as a card and the bell counted each; now Notifications carries one line, the bell counts renewals as one
// item, and the Renewals screen lists them compactly. The rules for that live here so they are tested.

import { daysBetween } from "./billsFormat";

/** The few fields of an approval request these rules read. */
export interface RenewalRequest { id: string; kind: string; entity_id: string | null; summary: string; created_at: string }

export const STALE_KIND = "listing_stale";
export const isRenewal = (a: Pick<RenewalRequest, "kind">): boolean => a.kind === STALE_KIND;

/** The requests that are renewals, in the order given. */
export function renewalsOf<T extends Pick<RenewalRequest, "kind">>(items: readonly T[] | null | undefined): T[] {
  return (items ?? []).filter(isRenewal);
}

/** "5 listings to renew" / "1 listing to renew". */
export function renewalLine(n: number): string {
  return `${n} ${n === 1 ? "listing" : "listings"} to renew`;
}

/** The listing's name: the request's summary without its "Renew or mark sold:" lead. */
export function renewalTitle(a: Pick<RenewalRequest, "summary">): string {
  return (a.summary || "").replace(/^Renew or mark sold:\s*/i, "").trim() || "Listing";
}

/** The number on the bell for the approval queue: pending customers, team requests that are not a plain
 *  new-client add, supplier leads, and all the renewals together as ONE item. A new-client request is
 *  already represented by its pending customer, so it is not counted again. */
export function approvalsBellCount(pendingCustomers: number, requests: readonly Pick<RenewalRequest, "kind">[], supplierLeads: number): number {
  const teamRequests = requests.filter((a) => a.kind !== "client_add" && !isRenewal(a)).length;
  const renewals = requests.some(isRenewal) ? 1 : 0;
  return pendingCustomers + teamRequests + renewals + supplierLeads;
}

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? iso.slice(0, 10) : "");

/** How long the listing has gone without a renewal, in words. `renewedAt` is the lot's last write (its renewal
 *  clock) when it is known; otherwise the request's own date is used and the words say it was flagged, not when
 *  it was last renewed. Days are counted on the plain date, never through a timezone. */
export function sinceRenewed(renewedAt: string | null | undefined, flaggedAt: string, today: string): string {
  const from = day(renewedAt ?? "");
  if (from) {
    const n = Math.max(0, daysBetween(from, today));
    return n === 0 ? "Renewed today" : n === 1 ? "Renewed 1 day ago" : `Renewed ${n} days ago`;
  }
  const f = day(flaggedAt);
  if (!f) return "Not renewed in 5 or more days";
  const n = Math.max(0, daysBetween(f, today));
  return n === 0 ? "Flagged today" : n === 1 ? "Flagged 1 day ago" : `Flagged ${n} days ago`;
}
