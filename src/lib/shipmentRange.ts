// R-415: the date range on the Logistics screen's All shipments list. Pure string math on
// YYYY-MM-DD days, so a range never slips a day across a time zone.

export type ShipmentRangeKey = "month" | "last" | "year" | "all" | "custom";

export const SHIPMENT_RANGES: { key: ShipmentRangeKey; label: string }[] = [
  { key: "month", label: "This month" },
  { key: "last", label: "Last month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" },
];

const two = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(y, m, 0).getDate();

/** `from` and `to` are inclusive days, either may be absent. `today` is the local day. A custom
 *  range passes through as typed (an empty end stays open). */
export function shipmentRange(
  key: ShipmentRangeKey, today: string, custom?: { from?: string; to?: string },
): { from?: string; to?: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (key === "month") return { from: `${y}-${two(m)}-01`, to: `${y}-${two(m)}-${two(lastDayOf(y, m))}` };
  if (key === "last") {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${two(pm)}-01`, to: `${py}-${two(pm)}-${two(lastDayOf(py, pm))}` };
  }
  if (key === "year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (key === "custom") return { from: custom?.from || undefined, to: custom?.to || undefined };
  return {};
}
