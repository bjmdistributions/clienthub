import { isShippingLine, projectedCostOf, shippingEstimateOf } from "./format";

// R-583: what a deal sold, what each unit cost and what each unit was billed, read at a glance on the deal list
// and the open deal. Only real fields: the invoice's goods lines (quantity and amount, shipping lines left out) and
// the deal's supplier cost (`projected_cost` less the shipping leg, the same figure the card's projection uses).
// A figure that cannot be worked out is null, never a guess: no quantity means no unit count, no cost line means no cost.

export interface UnitLine { description?: string | null; qty?: number | null; rate?: number | null; amount?: number | null }
export interface UnitDeal {
  supplier_payments?: unknown[] | null;
  projected_cost?: number | null;
  total_supplier_cost?: number | null;
  shipping_estimate?: number | null;
}
export interface UnitFigures {
  /** Units on the invoice's goods lines, null when no line has a quantity. */
  units: number | null;
  /** What the customer was billed for goods, shipping left out. */
  billed: number;
  /** Supplier cost for the goods, null until a cost line is entered. */
  cost: number | null;
  costPerUnit: number | null;
  chargedPerUnit: number | null;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;

export function unitFigures(lines: UnitLine[], deal: UnitDeal): UnitFigures {
  const goods = lines.filter((l) => !isShippingLine(l.description));
  const units = goods.reduce((s, l) => s + Math.max(num(l.qty), 0), 0);
  const billed = goods.reduce((s, l) => s + (l.amount === undefined || l.amount === null ? num(l.qty) * num(l.rate) : num(l.amount)), 0);
  const hasCost = (deal.supplier_payments ?? []).length > 0;
  const cost = hasCost ? Math.max(projectedCostOf(deal) - shippingEstimateOf(deal), 0) : null;
  return {
    units: units > 0 ? units : null,
    billed: round2(billed),
    cost: cost === null ? null : round2(cost),
    costPerUnit: units > 0 && cost !== null ? round2(cost / units) : null,
    chargedPerUnit: units > 0 ? round2(billed / units) : null,
  };
}

/** The plain-words reason a per-unit figure is missing, or "" when it is there. */
export function unitGap(f: UnitFigures, which: "cost" | "charged"): string {
  if (f.units === null) return "Unit count unknown";
  if (which === "cost" && f.cost === null) return "No cost entered";
  return "";
}
