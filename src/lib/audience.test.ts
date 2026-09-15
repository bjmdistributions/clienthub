import { describe, it, expect } from "vitest";
import {
  parseCategories,
  clientCategories,
  lockReason,
  buyerFacts,
  filterReason,
  resolveAudience,
  countReach,
  categoryOptions,
  stateOptions,
  defaultFilters,
  type AudienceFilters,
  type BuyerFacts as BuyerFactsType,
  type Overrides,
} from "./audience";
import type { Client, BuyerTier } from "./api";

// Picker's known category labels, in their canonical spelling — mirrors what the
// Newsletter screen passes as `known`.
const KNOWN = [
  "Clothing",
  "Shoes",
  "Electronics",
  "Food, Candy & Beverages",
  "General Merchandise",
  "Jewelry & Accessories",
  "Other",
];

const noOverrides: Overrides = { removed: new Set(), added: new Set(), picked: null };

// ---------------------------------------------------------------------------
// parseCategories
// ---------------------------------------------------------------------------

describe("parseCategories", () => {
  it("splits a plain comma list", () => {
    expect(parseCategories("Clothing, Shoes", KNOWN)).toEqual(["Clothing", "Shoes"]);
  });

  it("rejoins an unquoted comma label an older writer split apart", () => {
    expect(
      parseCategories("Electronics, Food, Candy & Beverages, General Merchandise", KNOWN),
    ).toEqual(["Electronics", "Food, Candy & Beverages", "General Merchandise"]);
  });

  it("respects a double-quoted comma label", () => {
    expect(parseCategories('Clothing, "Food, Candy & Beverages"', KNOWN)).toEqual([
      "Clothing",
      "Food, Candy & Beverages",
    ]);
  });

  it("rejoins a naively-split metadata.categories array", () => {
    expect(parseCategories(["Electronics", "Food", "Candy & Beverages"], KNOWN)).toEqual([
      "Electronics",
      "Food, Candy & Beverages",
    ]);
  });

  it("drops a trailing comma and blank items", () => {
    expect(parseCategories("Clothing,,Shoes,", KNOWN)).toEqual(["Clothing", "Shoes"]);
  });

  it("canonicalises to picker spelling regardless of case", () => {
    expect(parseCategories("jewelry & accessories", KNOWN)).toEqual(["Jewelry & Accessories"]);
  });

  it("de-dupes case-insensitively, keeping order", () => {
    expect(parseCategories("Clothing, Clothing", KNOWN)).toEqual(["Clothing"]);
    expect(parseCategories("Clothing, clothing", KNOWN)).toEqual(["Clothing"]);
  });

  it("keeps an unknown token as typed", () => {
    expect(parseCategories("Vintage Toys", KNOWN)).toEqual(["Vintage Toys"]);
  });

  it("returns [] for null, undefined, and non-string/array values", () => {
    expect(parseCategories(null, KNOWN)).toEqual([]);
    expect(parseCategories(undefined, KNOWN)).toEqual([]);
    expect(parseCategories(42, KNOWN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clientCategories
// ---------------------------------------------------------------------------

describe("clientCategories", () => {
  it("unions c.category with metadata.categories, including 'Other'", () => {
    const c = {
      category: "Clothing",
      metadata: { categories: ["Other"] },
    } as unknown as Client;
    expect(clientCategories(c, KNOWN)).toEqual(["Clothing", "Other"]);
  });

  it("de-dupes across every source, in c.category / metadata.category / primary / other / categories order", () => {
    const c = {
      category: "Clothing",
      metadata: {
        category: "Clothing",
        primary_buy_category: "Shoes",
        other_buy_categories: "Shoes, Electronics",
        categories: ["Electronics", "Other"],
      },
    } as unknown as Client;
    expect(clientCategories(c, KNOWN)).toEqual(["Clothing", "Shoes", "Electronics", "Other"]);
  });

  it("returns [] when nothing is set", () => {
    const c = {} as unknown as Client;
    expect(clientCategories(c, KNOWN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lockReason
// ---------------------------------------------------------------------------

describe("lockReason", () => {
  it("returns null when nothing locks the client", () => {
    const c = { email: "a@b.com" } as unknown as Client;
    expect(lockReason(c)).toBeNull();
  });

  it("Blacklisted beats every other reason", () => {
    const c = {
      is_blacklisted: true,
      email: "",
      exclusive: true,
      metadata: { unsubscribed: true, exclusive: true },
    } as unknown as Client;
    expect(lockReason(c)).toBe("Blacklisted");
  });

  it("Unsubscribed beats No bulk email and No email", () => {
    const c = {
      is_blacklisted: false,
      email: "",
      exclusive: true,
      metadata: { unsubscribed: true },
    } as unknown as Client;
    expect(lockReason(c)).toBe("Unsubscribed");
  });

  it("No bulk email beats No email, via the exclusive column", () => {
    const c = { email: "", exclusive: true } as unknown as Client;
    expect(lockReason(c)).toBe("No bulk email");
  });

  it("No bulk email beats No email, via metadata.exclusive", () => {
    const c = { email: "", metadata: { exclusive: true } } as unknown as Client;
    expect(lockReason(c)).toBe("No bulk email");
  });

  it("No email when the email is blank or whitespace", () => {
    expect(lockReason({ email: "" } as unknown as Client)).toBe("No email");
    expect(lockReason({ email: "   " } as unknown as Client)).toBe("No email");
    expect(lockReason({} as unknown as Client)).toBe("No email");
  });

  it("accepts every truthy spelling for metadata.unsubscribed", () => {
    for (const v of [true, 1, "1", "true"]) {
      const c = { email: "a@b.com", metadata: { unsubscribed: v } } as unknown as Client;
      expect(lockReason(c)).toBe("Unsubscribed");
    }
  });

  it("accepts every truthy spelling for metadata.exclusive", () => {
    for (const v of [true, 1, "1", "true"]) {
      const c = { email: "a@b.com", metadata: { exclusive: v } } as unknown as Client;
      expect(lockReason(c)).toBe("No bulk email");
    }
  });

  it("does not lock on falsy-but-set values", () => {
    const c = {
      email: "a@b.com",
      metadata: { unsubscribed: false, exclusive: "0" },
    } as unknown as Client;
    expect(lockReason(c)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buyerFacts
// ---------------------------------------------------------------------------

describe("buyerFacts", () => {
  it("bought via deals_landed even with no money recorded", () => {
    const tiers = [{ client_id: "c1", tier: "A", deals_landed: 2, actual_paid: 0 }] as unknown as BuyerTier[];
    const facts = buyerFacts(tiers);
    expect(facts.get("c1")).toEqual({ tier: "A", deals: 2, bought: true });
  });

  it("bought via actual_paid even with zero completed deals", () => {
    const tiers = [{ client_id: "c1", tier: "B", deals_landed: 0, actual_paid: 150 }] as unknown as BuyerTier[];
    const facts = buyerFacts(tiers);
    expect(facts.get("c1")).toEqual({ tier: "B", deals: 0, bought: true });
  });

  it("not bought when neither deals nor money is present", () => {
    const tiers = [{ client_id: "c1", tier: "C", deals_landed: 0, actual_paid: 0 }] as unknown as BuyerTier[];
    expect(buyerFacts(tiers).get("c1")).toEqual({ tier: "C", deals: 0, bought: false });
  });

  it("defaults missing deals_landed/actual_paid/tier to falsy", () => {
    const tiers = [{ client_id: "c1" }] as unknown as BuyerTier[];
    expect(buyerFacts(tiers).get("c1")).toEqual({ tier: "", deals: 0, bought: false });
  });
});

// ---------------------------------------------------------------------------
// filterReason
// ---------------------------------------------------------------------------

describe("filterReason", () => {
  const passingFilters: AudienceFilters = {
    ...defaultFilters(),
    exDormant: false,
    exOneTime: false,
    exUnder10k: false,
  };
  const passingFacts: BuyerFactsType = { tier: "", deals: 0, bought: false };

  it("returns null when nothing fails", () => {
    const c = { state: "TX" } as unknown as Client;
    expect(filterReason(c, [], passingFilters, passingFacts)).toBeNull();
  });

  it("Dormant when exDormant and the client is inactive", () => {
    const c = { lead_status: "inactive" } as unknown as Client;
    const f = { ...passingFilters, exDormant: true };
    expect(filterReason(c, [], f, passingFacts)).toBe("Dormant");
  });

  it("One-time buyer when exOneTime and the metadata says so", () => {
    const c = { metadata: { purchase_frequency: "As Needed / One Time" } } as unknown as Client;
    const f = { ...passingFilters, exOneTime: true };
    expect(filterReason(c, [], f, passingFacts)).toBe("One-time buyer");
  });

  it("One-time buyer matches the intake form's stored spelling too", () => {
    const c = { metadata: { purchase_frequency: "As Needed/ One Time" } } as unknown as Client;
    const f = { ...passingFilters, exOneTime: true };
    expect(filterReason(c, [], f, passingFacts)).toBe("One-time buyer");
  });

  it("Under $10k when exUnder10k and the metadata says so", () => {
    const c = { metadata: { estimated_annual_spend: "Under $10,000" } } as unknown as Client;
    const f = { ...passingFilters, exUnder10k: true };
    expect(filterReason(c, [], f, passingFacts)).toBe("Under $10k");
  });

  it("Already emailed for tier 'first_contact' when the client has no first_contact", () => {
    const c = { first_contact: false } as unknown as Client;
    const f: AudienceFilters = { ...passingFilters, tier: "first_contact" };
    expect(filterReason(c, [], f, passingFacts)).toBe("Already emailed");
    const c2 = { first_contact: true } as unknown as Client;
    expect(filterReason(c2, [], f, passingFacts)).toBeNull();
  });

  it("Not a ranked buyer for tier 'ranked' when the client's tier isn't P/S/A/B/C", () => {
    const f: AudienceFilters = { ...passingFilters, tier: "ranked" };
    expect(filterReason({} as unknown as Client, [], f, { tier: "D", deals: 0, bought: false })).toBe(
      "Not a ranked buyer",
    );
    expect(filterReason({} as unknown as Client, [], f, { tier: "P", deals: 0, bought: false })).toBeNull();
  });

  it("Not in chosen tiers for an explicit tier list", () => {
    const f: AudienceFilters = { ...passingFilters, tier: ["A", "B"] };
    expect(filterReason({} as unknown as Client, [], f, { tier: "C", deals: 0, bought: false })).toBe(
      "Not in chosen tiers",
    );
    expect(filterReason({} as unknown as Client, [], f, { tier: "A", deals: 0, bought: false })).toBeNull();
  });

  it("Ranked buyer for tier 'all' with includeRanked false", () => {
    const f: AudienceFilters = { ...passingFilters, tier: "all", includeRanked: false };
    expect(filterReason({} as unknown as Client, [], f, { tier: "P", deals: 0, bought: false })).toBe(
      "Ranked buyer",
    );
    expect(filterReason({} as unknown as Client, [], f, { tier: "", deals: 0, bought: false })).toBeNull();
  });

  it("Hasn't bought yet for purchase 'bought' when the client hasn't", () => {
    const f: AudienceFilters = { ...passingFilters, purchase: "bought" };
    expect(filterReason({} as unknown as Client, [], f, { tier: "", deals: 0, bought: false })).toBe(
      "Hasn't bought yet",
    );
    expect(filterReason({} as unknown as Client, [], f, { tier: "", deals: 1, bought: true })).toBeNull();
  });

  it("Has bought before for purchase 'never' when the client has", () => {
    const f: AudienceFilters = { ...passingFilters, purchase: "never" };
    expect(filterReason({} as unknown as Client, [], f, { tier: "", deals: 1, bought: true })).toBe(
      "Has bought before",
    );
    expect(filterReason({} as unknown as Client, [], f, { tier: "", deals: 0, bought: false })).toBeNull();
  });

  it("Outside chosen states, comparing normalised state codes", () => {
    const f: AudienceFilters = { ...passingFilters, states: ["CA", "NY"] };
    expect(filterReason({ state: "TX" } as unknown as Client, [], f, passingFacts)).toBe(
      "Outside chosen states",
    );
    expect(filterReason({ state: " ca " } as unknown as Client, [], f, passingFacts)).toBeNull();
  });

  it("Not in chosen categories, comparing case-insensitively", () => {
    const f: AudienceFilters = { ...passingFilters, cats: ["Clothing"] };
    expect(filterReason({} as unknown as Client, ["Shoes"], f, passingFacts)).toBe(
      "Not in chosen categories",
    );
    expect(filterReason({} as unknown as Client, ["clothing"], f, passingFacts)).toBeNull();
  });

  it("returns the first failing reason, in rule order", () => {
    // Dormant fires before One-time buyer, Under $10k, or anything downstream.
    const c = {
      lead_status: "inactive",
      metadata: {
        purchase_frequency: "As Needed / One Time",
        estimated_annual_spend: "Under $10,000",
      },
    } as unknown as Client;
    const f: AudienceFilters = { ...passingFilters, exDormant: true, exOneTime: true, exUnder10k: true };
    expect(filterReason(c, [], f, passingFacts)).toBe("Dormant");

    // With Dormant off, One-time buyer fires before Under $10k.
    const f2: AudienceFilters = { ...f, exDormant: false };
    expect(filterReason(c, [], f2, passingFacts)).toBe("One-time buyer");
  });
});

// ---------------------------------------------------------------------------
// resolveAudience
// ---------------------------------------------------------------------------

describe("resolveAudience", () => {
  const filters: AudienceFilters = { ...defaultFilters(), exDormant: false };

  it("removed: a client who would receive is excluded, marked 'Removed by you'", () => {
    const clients = [{ id: "c1", email: "a@b.com" } as unknown as Client];
    const o: Overrides = { removed: new Set(["c1"]), added: new Set(), picked: null };
    const [row] = resolveAudience(clients, KNOWN, filters, new Map(), o);
    expect(row.reason).toBe("Removed by you");
    expect(row.receiving).toBe(false);
  });

  it("added: a client who was filtered out is included, reason cleared", () => {
    const clients = [{ id: "c1", email: "a@b.com", lead_status: "inactive" } as unknown as Client];
    const dormantFilters: AudienceFilters = { ...defaultFilters(), exDormant: true };
    const o: Overrides = { removed: new Set(), added: new Set(["c1"]), picked: null };
    const [row] = resolveAudience(clients, KNOWN, dormantFilters, new Map(), o);
    expect(row.reason).toBeNull();
    expect(row.receiving).toBe(true);
  });

  it("added cannot revive a locked client", () => {
    const clients = [{ id: "c1", email: "a@b.com", is_blacklisted: true } as unknown as Client];
    const o: Overrides = { removed: new Set(), added: new Set(["c1"]), picked: null };
    const [row] = resolveAudience(clients, KNOWN, filters, new Map(), o);
    expect(row.reason).toBe("Blacklisted");
    expect(row.receiving).toBe(false);
  });

  it("picked replaces filter results: unpicked clients read 'Not picked'", () => {
    const clients = [
      { id: "c1", email: "a@b.com" } as unknown as Client,
      { id: "c2", email: "b@b.com" } as unknown as Client,
    ];
    const o: Overrides = { removed: new Set(), added: new Set(), picked: new Set(["c1"]) };
    const rows = resolveAudience(clients, KNOWN, filters, new Map(), o);
    expect(rows.find((r) => r.client.id === "c1")!.reason).toBeNull();
    expect(rows.find((r) => r.client.id === "c2")!.reason).toBe("Not picked");
  });

  it("picked + removed: a picked client can still be hand-removed", () => {
    const clients = [{ id: "c1", email: "a@b.com" } as unknown as Client];
    const o: Overrides = { removed: new Set(["c1"]), added: new Set(), picked: new Set(["c1"]) };
    const [row] = resolveAudience(clients, KNOWN, filters, new Map(), o);
    expect(row.reason).toBe("Removed by you");
  });

  it("picked + added: added clears 'Not picked' for a client outside the pick", () => {
    const clients = [{ id: "c1", email: "a@b.com" } as unknown as Client];
    const o: Overrides = { removed: new Set(), added: new Set(["c1"]), picked: new Set() };
    const [row] = resolveAudience(clients, KNOWN, filters, new Map(), o);
    expect(row.reason).toBeNull();
    expect(row.receiving).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countReach
// ---------------------------------------------------------------------------

describe("countReach", () => {
  it("ignores hand edits and counts by filterReason alone (locks still excluded)", () => {
    const dormantFilters: AudienceFilters = { ...defaultFilters(), exDormant: true };
    const clients = [
      { id: "a", email: "a@b.com" } as unknown as Client, // passes on its own
      { id: "b", email: "b@b.com", lead_status: "inactive" } as unknown as Client, // fails, hand-added
      { id: "c", email: "c@b.com" } as unknown as Client, // passes, hand-removed
      { id: "d", email: "d@b.com", is_blacklisted: true } as unknown as Client, // would pass, but locked
    ];
    const o: Overrides = { removed: new Set(["c"]), added: new Set(["b"]), picked: null };
    const rows = resolveAudience(clients, KNOWN, dormantFilters, new Map(), o);

    // Sanity check the hand edits actually changed `receiving`.
    expect(rows.find((r) => r.client.id === "b")!.receiving).toBe(true);
    expect(rows.find((r) => r.client.id === "c")!.receiving).toBe(false);

    // countReach ignores all of that: only "a" and "c" pass filterReason on their own,
    // "b" fails it (Dormant), and "d" is excluded for being locked.
    expect(countReach(rows, dormantFilters)).toBe(2);
  });

  it("recomputes against a different filter set (the chip's own number)", () => {
    const clients = [
      { id: "a", email: "a@b.com" } as unknown as Client,
      { id: "b", email: "b@b.com", lead_status: "inactive" } as unknown as Client,
    ];
    const o: Overrides = { removed: new Set(), added: new Set(), picked: null };
    const looseFilters: AudienceFilters = { ...defaultFilters(), exDormant: false };
    const rows = resolveAudience(clients, KNOWN, looseFilters, new Map(), o);

    const strictFilters: AudienceFilters = { ...defaultFilters(), exDormant: true };
    expect(countReach(rows, strictFilters)).toBe(1); // only "a" survives Dormant
    expect(countReach(rows, looseFilters)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// categoryOptions
// ---------------------------------------------------------------------------

describe("categoryOptions", () => {
  const known = ["Clothing", "Shoes", "Electronics", "Jewelry & Accessories"];
  const filters: AudienceFilters = { ...defaultFilters(), exDormant: false };

  const clients = [
    { id: "c1", email: "1@b.com", category: "Clothing" } as unknown as Client,
    { id: "c2", email: "2@b.com", category: "Clothing" } as unknown as Client,
    { id: "c3", email: "3@b.com", category: "Shoes" } as unknown as Client,
    { id: "c4", email: "4@b.com", category: "Vintage" } as unknown as Client, // unknown token
    { id: "c5", email: "5@b.com", category: "Electronics", is_blacklisted: true } as unknown as Client,
  ];
  const rows = resolveAudience(clients, known, filters, new Map(), noOverrides);

  it("orders by unlocked-carrier count, then label, and drops labels nobody carries", () => {
    expect(categoryOptions(rows, known)).toEqual([
      { label: "Clothing", base: 2 },
      { label: "Shoes", base: 1 },
      { label: "Vintage", base: 1 },
      { label: "Electronics", base: 0 },
    ]);
    // "Jewelry & Accessories" is a known label nobody carries: excluded entirely.
    expect(categoryOptions(rows, known).some((o) => o.label === "Jewelry & Accessories")).toBe(false);
  });

  it("keeps a label carried only by locked clients, at base 0", () => {
    const electronics = categoryOptions(rows, known).find((o) => o.label === "Electronics");
    expect(electronics).toEqual({ label: "Electronics", base: 0 });
  });
});

// ---------------------------------------------------------------------------
// stateOptions
// ---------------------------------------------------------------------------

describe("stateOptions", () => {
  const filters: AudienceFilters = { ...defaultFilters(), exDormant: false };
  const clients = [
    { id: "c1", email: "1@b.com", state: "Il" } as unknown as Client,
    { id: "c2", email: "2@b.com", state: "IL" } as unknown as Client,
    { id: "c3", email: "3@b.com", state: "ca" } as unknown as Client,
    { id: "c4", email: "4@b.com", state: "NY", is_blacklisted: true } as unknown as Client, // locked, excluded
    { id: "c5", email: "5@b.com", state: "" } as unknown as Client, // blank, excluded
  ];
  const rows = resolveAudience(clients, KNOWN, filters, new Map(), noOverrides);

  it("normalises case/whitespace so 'Il' and 'IL' count together, most clients first", () => {
    expect(stateOptions(rows)).toEqual([
      { code: "IL", base: 2 },
      { code: "CA", base: 1 },
    ]);
  });
});
