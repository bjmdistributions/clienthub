// R-297: who a newsletter reaches, as pure functions. Used by the Newsletter audience, the
// recurring schedule's "By category" pick and Inventory's "Send to newsletter" hand-off.
//
// The phone carries the same rules in clienthub-api www/app.js (`audParseCategories`,
// `audLockReason`, `audFilterReason`); change both together or the two surfaces count
// different people.

import type { BuyerTier, Client } from "./api";

/** Tier codes that count as "ranked". Product vocabulary is P/S/A/B/C; the stray legacy `D`
 *  the old list carried matched nothing (vault 00-INDEX conflict 5) and is gone. */
export const RANKED_TIERS = ["P", "S", "A", "B", "C"];

const truthy = (v: unknown) =>
  v === true || v === 1 || v === "1" || (typeof v === "string" && v.trim().toLowerCase() === "true");

/**
 * Split a stored category value into labels.
 *
 * A client's category is a comma list, and a label that itself contains a comma is written
 * double-quoted: `Clothing, "Food, Candy & Beverages"`. Older writers left it unquoted, and
 * `metadata.categories` arrays were split on every comma, so adjacent pieces that together
 * spell a known label are joined back up. Known labels come back in their picker spelling;
 * anything else is kept as typed. Case-insensitive, de-duplicated, order kept.
 */
export function parseCategories(raw: unknown, known: string[]): string[] {
  let items: string[] = [];
  if (Array.isArray(raw)) {
    items = raw.map((x) => String(x ?? ""));
  } else if (typeof raw === "string") {
    let cur = "";
    let quoted = false;
    for (const ch of raw) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { items.push(cur); cur = ""; }
      else cur += ch;
    }
    items.push(cur);
  }
  items = items.map((s) => s.trim()).filter(Boolean);

  const byLower = new Map(known.map((k) => [k.trim().toLowerCase(), k.trim()]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; ) {
    let take = 1;
    for (let n = Math.min(4, items.length - i); n >= 2; n--) {
      if (byLower.has(items.slice(i, i + n).join(", ").toLowerCase())) { take = n; break; }
    }
    const joined = items.slice(i, i + take).join(", ");
    const label = byLower.get(joined.toLowerCase()) ?? joined;
    if (!seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); out.push(label); }
    i += take;
  }
  return out;
}

/** Every category a client buys, from every place one is stored. */
export function clientCategories(c: Client, known: string[]): string[] {
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of [c.category, m.category, m.primary_buy_category, m.other_buy_categories, m.categories]) {
    for (const label of parseCategories(src, known)) {
      if (!seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); out.push(label); }
    }
  }
  return out;
}

export type LockReason = "Blacklisted" | "Unsubscribed" | "No bulk email" | "No email";

/** Why a client can never receive a bulk send, or null. The send path enforces the same flags
 *  again (newsletter-nobulk-flag), so this is what the screen shows, not the only guard. */
export function lockReason(c: Client): LockReason | null {
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  if (c.is_blacklisted) return "Blacklisted";
  if (truthy(m.unsubscribed)) return "Unsubscribed";
  if (truthy(c.exclusive) || truthy(m.exclusive)) return "No bulk email";
  if (!(c.email ?? "").trim()) return "No email";
  return null;
}

export interface BuyerFacts {
  tier: string;
  /** Completed deals (the tiers screen's deals landed). */
  deals: number;
  /** A completed deal, or money actually paid on an invoice net of refunds. */
  bought: boolean;
}

export function buyerFacts(tiers: BuyerTier[]): Map<string, BuyerFacts> {
  const map = new Map<string, BuyerFacts>();
  for (const t of tiers) {
    const deals = t.deals_landed || 0;
    map.set(t.client_id, { tier: t.tier || "", deals, bought: deals > 0 || (t.actual_paid || 0) > 0 });
  }
  return map;
}

export type Purchase = "any" | "bought" | "never";

export interface AudienceFilters {
  tier: "all" | "ranked" | "first_contact" | string[];
  /** Only read when tier is "all": leave ranked buyers out of an "Everyone" send. */
  includeRanked: boolean;
  /** Any of these; empty means no category restriction. */
  cats: string[];
  purchase: Purchase;
  /** Upper-case state codes; empty means anywhere. */
  states: string[];
  exDormant: boolean;
  exOneTime: boolean;
  exUnder10k: boolean;
}

/** Dormant clients are left out by default: kept on record, just not contacted. */
export const defaultFilters = (includeRanked = true): AudienceFilters => ({
  tier: "all", includeRanked, cats: [], purchase: "any", states: [],
  exDormant: true, exOneTime: false, exUnder10k: false,
});

export const normState = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** The first filter a (sendable) client fails, as the words the screen shows, or null. */
export function filterReason(c: Client, cats: string[], f: AudienceFilters, facts: BuyerFacts | undefined): string | null {
  const m = (c.metadata ?? {}) as Record<string, unknown>;
  if (f.exDormant && c.lead_status === "inactive") return "Dormant";
  // Stored as "As Needed/ One Time" by the intake form; compared without spaces or case so
  // either spelling counts (the exact "As Needed / One Time" matched no one).
  if (f.exOneTime && String(m.purchase_frequency ?? "").replace(/\s+/g, "").toLowerCase() === "asneeded/onetime") return "One-time buyer";
  if (f.exUnder10k && m.estimated_annual_spend === "Under $10,000") return "Under $10k";
  const tier = facts?.tier ?? "";
  if (f.tier === "first_contact") { if (!c.first_contact) return "Already emailed"; }
  else if (f.tier === "ranked") { if (!RANKED_TIERS.includes(tier)) return "Not a ranked buyer"; }
  else if (Array.isArray(f.tier)) { if (!f.tier.includes(tier)) return "Not in chosen tiers"; }
  else if (!f.includeRanked && RANKED_TIERS.includes(tier)) return "Ranked buyer";
  const bought = facts?.bought ?? false;
  if (f.purchase === "bought" && !bought) return "Hasn't bought yet";
  if (f.purchase === "never" && bought) return "Has bought before";
  if (f.states.length && !f.states.includes(normState(c.state))) return "Outside chosen states";
  if (f.cats.length) {
    const mine = new Set(cats.map((x) => x.toLowerCase()));
    if (!f.cats.some((x) => mine.has(x.toLowerCase()))) return "Not in chosen categories";
  }
  return null;
}

export interface Overrides {
  /** Would receive, but unticked by hand. */
  removed: Set<string>;
  /** Filtered out, but ticked by hand. A locked client can never be added. */
  added: Set<string>;
  /** Hand-picked elsewhere (Clients > Email): these people instead of the filters. */
  picked: Set<string> | null;
}

export interface AudienceRow {
  client: Client;
  cats: string[];
  facts: BuyerFacts | undefined;
  lock: LockReason | null;
  /** Why this row is not receiving; null when it is. */
  reason: string | null;
  receiving: boolean;
}

export function resolveAudience(
  clients: Client[], known: string[], f: AudienceFilters,
  facts: Map<string, BuyerFacts>, o: Overrides,
): AudienceRow[] {
  return clients.map((client) => {
    const cats = clientCategories(client, known);
    const fx = facts.get(client.id);
    const lock = lockReason(client);
    let reason: string | null = lock;
    if (!lock) {
      reason = o.picked ? (o.picked.has(client.id) ? null : "Not picked") : filterReason(client, cats, f, fx);
      if (reason === null && o.removed.has(client.id)) reason = "Removed by you";
      if (reason !== null && o.added.has(client.id)) reason = null;
    }
    return { client, cats, facts: fx, lock, reason, receiving: reason === null };
  });
}

/** How many sendable clients a filter change would reach, ignoring hand edits — what a chip's
 *  number means: "pick only this, with everything else as it is". */
export function countReach(rows: AudienceRow[], f: AudienceFilters): number {
  let n = 0;
  for (const r of rows) if (!r.lock && filterReason(r.client, r.cats, f, r.facts) === null) n++;
  return n;
}

/** Every category that at least one client carries, picker labels first in spelling, ordered by
 *  how many sendable clients carry it. `base` is how many, before any filter. */
export function categoryOptions(rows: AudienceRow[], known: string[]): { label: string; base: number }[] {
  const counts = new Map<string, { label: string; base: number; any: number }>();
  for (const k of known) counts.set(k.toLowerCase(), { label: k, base: 0, any: 0 });
  for (const r of rows) {
    for (const label of r.cats) {
      const e = counts.get(label.toLowerCase()) ?? { label, base: 0, any: 0 };
      e.any++;
      if (!r.lock) e.base++;
      counts.set(label.toLowerCase(), e);
    }
  }
  return [...counts.values()]
    .filter((e) => e.any > 0)
    .sort((a, b) => b.base - a.base || a.label.localeCompare(b.label))
    .map(({ label, base }) => ({ label, base }));
}

/** States that sendable clients are in, most clients first. */
export function stateOptions(rows: AudienceRow[]): { code: string; base: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = normState(r.client.state);
    if (s && !r.lock) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, base]) => ({ code, base }));
}
