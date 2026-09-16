// DEV ONLY — the fixture behind r309-harness.html. Nothing in the app imports this and
// index.html does not reference the page, so it never reaches a build.
//
// Renders the REAL InventoryView for three requests at once:
//   R-309 — the category picker: every category listed, a checkmark on the picked ones,
//           clicking one does not empty the list, no OS autocorrect bubble over the menu.
//   R-310 — brand / style tags: the chip field, the Detected row, the chips on the card
//           and the detail, and the tag filter in the toolbar.
//   R-311 — the price hierarchy: per-unit big, minimum order under it, whole-lot total
//           under that — and a flat-rate load that keeps its own figure.
// Every name, supplier, location and figure below is invented.
import ReactDOM from "react-dom/client";
import InventoryView from "./components/InventoryView";
import "./index.css";

const lot = (
  id: string, name: string, category: string, quantity: number, total_cost: number,
  asking_price: number, price_type: string, details: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) => ({
  id, name, description: null, category, quantity, total_cost, asking_price,
  status: "available", linked_deal_id: null, photos_json: "[]",
  created_at: "2026-09-02", updated_at: "2026-09-12", notes: null,
  sent_whatsapp: false, sent_email: false, sent_facebook: false,
  supplier: "Kelso Returns Co", location: "Vineland, NJ", manifest_path: null,
  price_type, details_json: details ? JSON.stringify(details) : null, ...extra,
});

const LOTS = [
  // Per-unit with a ladder: headline $3.16 / unit, 5,000 unit minimum, load total under it.
  lot("l1", "Mixed athletic sneakers — Nike, New Balance, adidas", "Shoes", 50_000, 1.9, 3.16, "per_unit",
      { categories: ["Shoes", "Streetwear"], tags: ["Nike", "New Balance", "adidas", "Sneakers"],
        moq: 5_000, price_tiers: [{ min_qty: 5_000, price: 3.16 }, { min_qty: 20_000, price: 2.9 }],
        condition: "Customer returns" }),
  // Quoted by the pallet with a units range: the headline is the per-unit BAND.
  lot("l2", "Air Max overstock — 20 pallets", "Shoes", 9_000, 21_000, 30_000, "total",
      { categories: ["Shoes"], tags: ["Nike", "Air Max"], pallets: 20, price_basis: "per_pallet",
        price_per_pallet: 1_500, qty_basis: "per_pallet", qty_per_pallet: 450, qty_per_pallet_max: 500 }),
  // One flat rate, nothing to divide by — the figure stays in the headline and says so.
  lot("l3", "Single pallet — assorted homeware", "General Merchandise", 0, 3_800, 9_500, "total", null),
  // Priced only by its ladder: no ask of its own, so the band is the price.
  lot("l4", "Crew socks, mixed colours", "Apparel", 40_000, 0.42, 0, "per_unit",
      { categories: ["Apparel", "Socks"], tags: ["Hanes", "Crew Socks"], moq: 5_000,
        price_tiers: [{ min_qty: 5_000, price: 0.9 }, { min_qty: 20_000, price: 0.75 }] }),
  // Custom price text: shown verbatim, no per-unit and no total beside it.
  lot("l5", "Pallet of mixed designer handbags", "Accessories", 120, 14_000, 0, "custom",
      { categories: ["Accessories"], tags: ["Michael Kors", "Coach"], price_text: "Make an offer — truckload only", moq: 40 }),
  // Heavily tagged: proves the card strip caps at 3 with a +N instead of stacking.
  lot("l6", "Winter outerwear mixed lot", "Apparel", 2_400, 13.75, 24.5, "per_unit",
      { categories: ["Apparel", "Outerwear"], tags: ["Columbia", "The North Face", "Patagonia", "Eddie Bauer", "Jacket"] }),
  // No categories, no tags, no price — the quiet end of the grid.
  lot("l7", "Unsorted returns — awaiting manifest", "", 600, 2, 0, "per_unit", null),
];

const CATEGORIES = [
  // 24 of them on purpose: the menu has to scroll ALL of them, not show six.
  "Apparel", "Accessories", "Appliances", "Beauty/Cosmetics", "Electronics", "Footwear",
  "General Merchandise", "Hats", "Home & garden", "Jewelry & Accessories", "Outerwear",
  "Pet supplies", "Shoes", "Socks", "Sporting goods", "Streetwear", "Toys",
  "Tools & hardware", "Books & stationery", "Food & beverages", "Furniture", "Health",
  "Kitchen", "Luggage",
].map((label, i) => ({ id: "cat" + i, label, sort_order: i, parent_id: null }));

const EMPTY_OK = new Set([
  "list_interactions", "list_portal_links", "counterparty_payments", "list_clients",
  "list_suppliers", "list_custom_fields", "refund_status_all", "list_deals", "list_offers",
  "list_payment_methods", "list_line_item_templates", "list_lot_warnings", "list_bank_txns",
  "find_lot_matches", "lot_media_issues",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "list_lots": case "list_inventory": return LOTS;
    case "list_categories": return CATEGORIES;
    case "get_storefront_config": return null;
    case "get_company_info": return { name: "Rivermount Trading", address: "", email: "", phone: null, tax_id: null };
    case "create_category": return null;
    default:
      if (EMPTY_OK.has(cmd)) return [];
      return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-bg min-h-screen">
    <InventoryView />
  </div>,
);
