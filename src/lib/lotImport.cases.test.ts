// R-559: the cases the server's copy of these rules (clienthub-api src/routes/lot_feed_rules.rs)
// is tested against. lotImport.cases.json is byte-identical in both repos; this test checks the
// desktop still gives every `expect` in it, the Rust test checks the server does. After a
// deliberate rule change, update the `expect` this test prints as wrong, copy the file to
// clienthub-api/src/, and make the Rust copy pass.
import { describe, it, expect } from "vitest";
import { parseSheet, markDuplicates, TEMPLATE_HEADERS, type ImportRow } from "./lotImport";
import type { Lot } from "./api";
import casesJson from "./lotImport.cases.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cases: any = casesJson;

const out = (r: ImportRow) => ({
  name: r.draft.name, description: r.draft.description, category: r.draft.category, quantity: r.draft.quantity,
  total_cost: r.draft.total_cost, asking_price: r.draft.asking_price, price_type: r.draft.price_type, notes: r.draft.notes,
  supplier: r.draft.supplier, location: r.draft.location, sent_whatsapp: r.draft.sent_whatsapp, sent_email: r.draft.sent_email,
  details: r.draft.details_json ? JSON.parse(r.draft.details_json) : null, photos: r.photos.map((p) => p.ref), manifest: r.manifestRef,
  problems: r.problems, notes_out: r.notes,
});

const lot = (c: { name: string; quantity: number; asking_price: number; supplier: string | null; location: string | null }): Lot => ({
  id: "lot_1", name: c.name, description: null, category: null, quantity: c.quantity, total_cost: 0, asking_price: c.asking_price, status: "available",
  linked_deal_id: null, photos_json: "[]", created_at: "", updated_at: "", notes: null, sent_whatsapp: false, sent_email: false,
  sent_facebook: false, supplier: c.supplier, location: c.location, manifest_path: null, price_type: "per_unit", details_json: null,
});

describe("lotImport.cases.json (shared with the server's copy)", () => {
  it("uses the template's headers", () => {
    expect(cases.headers).toEqual(TEMPLATE_HEADERS);
  });

  it("every row reads as expected", () => {
    for (const c of cases.rows) {
      const p = parseSheet([cases.headers, cases.headers.map((h: string) => c.input[h] ?? "")], cases.ctx);
      if (typeof p === "string") throw new Error(p);
      expect(out(p.rows[0]), c.label).toEqual(c.expect);
    }
    for (const c of cases.duplicates) {
      const p = parseSheet([cases.headers, cases.headers.map((h: string) => (h === "Name" ? c.a.name : h === "Quantity" ? String(c.a.quantity) : h === "Selling price" ? String(c.a.asking_price) : h === "Supplier" ? (c.a.supplier ?? "") : h === "Location" ? (c.a.location ?? "") : ""))], { categories: [], suppliers: [], tags: [] });
      if (typeof p === "string") throw new Error(p);
      const [r] = markDuplicates(p.rows, [lot(c.b)]);
      expect(r.dup ? { strength: r.dup.strength, why: r.dup.why } : null, c.label).toEqual(c.expect);
    }
  });
});
