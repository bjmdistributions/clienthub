// R-459: finding a load, a BOL or a carrier by number from the command palette. The server answers
// /api/logistics/search with up to eight of each. These rules turn that answer into palette rows and
// say what a click opens, so they are tested without a screen. The phone's search hub carries the
// same sections in www/app.js.

import type { LogisticsSearchResults } from "./api";
import { NEW_BOL_FROM_LOAD_KEY, OPEN_BOL_KEY } from "./logisticsBols";
import { OPEN_CARRIER_KEY, OPEN_LOAD_KEY, encodeOpenLoad } from "./logisticsCarriers";
import { statusWord } from "./logisticsLoad";

export type LogisticsHitKind = "Load" | "BOL" | "Carrier";

export interface LogisticsHit { kind: LogisticsHitKind; id: string; label: string; sub: string }

/** The search starts at two characters: one letter matches nearly every load. */
export const SEARCH_MIN_CHARS = 2;
export const searchable = (q: string): boolean => q.trim().length >= SEARCH_MIN_CHARS;

const join = (...parts: (string | undefined | null | false)[]): string => parts.filter((p): p is string => !!p && !!p.trim()).join(" · ");

/** Loads, then BOLs, then carriers, each as one palette row. Missing lists read as empty. A load shows its
 *  status in the words its side of the screen uses (`logistics`: the Logistics account reads "Quote needed"). */
export function searchHits(res: Partial<LogisticsSearchResults> | null | undefined, logistics = false): LogisticsHit[] {
  if (!res) return [];
  const out: LogisticsHit[] = [];
  for (const l of res.loads ?? []) {
    out.push({ kind: "Load", id: l.id, label: l.load_number || "Load", sub: join(l.route, statusWord(l.status, logistics), l.carrier, l.deal_label) });
  }
  for (const b of res.bols ?? []) {
    const ends = join(b.shipper && b.consignee ? `${b.shipper} to ${b.consignee}` : b.shipper || b.consignee);
    out.push({ kind: "BOL", id: b.id, label: b.number || "BOL", sub: join(ends, b.load_number && `Load ${b.load_number}`) });
  }
  for (const c of res.carriers ?? []) {
    out.push({ kind: "Carrier", id: c.id, label: c.name || "Carrier", sub: c.mc_number ? `MC ${c.mc_number}` : "" });
  }
  return out;
}

/** What a hit opens: the tab, the value to stash for that screen to read when it appears, and the event
 *  that tells it when it is already open. */
export function handoffFor(kind: LogisticsHitKind, id: string): { tab: "logistics" | "bols"; key: string; value: string; event: string } {
  if (kind === "BOL") return { tab: "bols", key: OPEN_BOL_KEY, value: id, event: "bols-open" };
  if (kind === "Carrier") return { tab: "logistics", key: OPEN_CARRIER_KEY, value: id, event: "logistics-open-load" };
  return { tab: "logistics", key: OPEN_LOAD_KEY, value: encodeOpenLoad(id), event: "logistics-open-load" };
}

/** Open the record a hit names: stash it, switch to its screen, and nudge the screen when it is already open. */
export function openLogisticsHit(h: Pick<LogisticsHit, "kind" | "id">): void {
  const t = handoffFor(h.kind, h.id);
  try { localStorage.setItem(t.key, t.value); } catch { /* storage blocked: the screen just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: t.tab }));
  setTimeout(() => window.dispatchEvent(new CustomEvent(t.event)), 100);
}

/** A load's page starts a BOL from that load: the BOLs screen builds it from the load's prefill. */
export const newBolHandoff = (bookingId: string): { tab: "bols"; key: string; value: string; event: string } =>
  ({ tab: "bols", key: NEW_BOL_FROM_LOAD_KEY, value: bookingId, event: "bols-open" });

export function startBolFromLoad(bookingId: string): void {
  const t = newBolHandoff(bookingId);
  try { localStorage.setItem(t.key, t.value); } catch { /* storage blocked: the screen just opens */ }
  window.dispatchEvent(new CustomEvent("navigate-tab", { detail: t.tab }));
  setTimeout(() => window.dispatchEvent(new CustomEvent(t.event)), 100);
}

/** R-460: the Deal Flow search box. A deal matches its invoice number, its client, its name, or the number of
 *  any of its loads (`load_numbers`, space-joined: the live and quote-stage trucks). An empty search matches all. */
export function dealMatchesQuery(
  f: { invoice_number?: string | null; client_name?: string | null; name?: string | null; load_numbers?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [f.invoice_number, f.client_name, f.name, f.load_numbers].some((v) => (v || "").toLowerCase().includes(q));
}
