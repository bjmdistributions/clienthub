import { describe, it, expect } from "vitest";
import { ADDRESS_EXAMPLE, ADDRESS_HINT, addressLack, addressNote, isFullAddress, keptPickupRows, relabelAddressGap, relabelPickupError } from "./fullAddress";

// R-483: invented addresses. The server's full_address is tested against the same cases.
describe("isFullAddress", () => {
  const full = [
    "9 Depot Rd, Warehouse City, NV 89001",
    "9 Depot Rd, Warehouse City, NV 89001-1234",
    "9 Depot Rd, Warehouse City, Nevada 89001",
    "9 Depot Rd, Warehouse City, nv 89001",
    "9 Depot Rd, Warehouse City, NV 89001, USA",
    "9 Depot Rd, Warehouse City, NV 89001, United States",
    "9 Depot Rd, Warehouse City, NV, 89001",
    "9 Depot Rd\nWarehouse City, NV 89001",
    "9 Depot Rd\r\nWarehouse City\r\nNV 89001",
    "1 Main St, Albany, New York 12207",
    "1 Main St, Washington, DC 20001",
    "9 Depot Rd, Suite 4, Warehouse City, NV 89001",
    "  9 Depot Rd ,  Warehouse City , NV   89001  ",
    "1 Main St, Charleston, West Virginia 25301",
    "1 Main St, Washington, District of Columbia 20001",
    "1 Main St, San Juan, PR 00901",
    // R-502: the ways people write an address that R-483 refused (the server's list, case for case).
    "9 Depot Rd, Warehouse City NV 89001",
    "9 Depot Rd, Reno NV 89501",
    "9 Depot Rd, Reno nv 89501",
    "9 Depot Rd Warehouse City NV 89001",
    "9 Depot Rd. Reno NV 89501",
    "9 Depot Rd, Reno, NV 89501.",
    "9 Depot Rd, Reno Nevada 89501",
    "1 Main St, Charleston West Virginia 25301",
    "1 Main St Washington District of Columbia 20001",
    "9 Depot Rd, Reno NV, 89501",
    "9 Depot Rd, Reno NV 89501, USA",
    "1200 Hwy 50 Carson City NV 89701",
    "9 Depot Rd Suite 4 Reno NV 89501",
    "9 Depot Rd\nReno NV 89501",
    "9 Depot Rd Dock B Reno NV 89501",
    "9 Depot Rd NW Reno NV 89501",
  ];
  for (const a of full) it(`is full: ${JSON.stringify(a)}`, () => expect(isFullAddress(a)).toBe(true));

  const notFull = [
    ["", "empty", "empty"],
    ["   ", "blank", "empty"],
    [",,", "only separators", "empty"],
    ["Warehouse City, NV 89001", "no street", "street"],
    ["Reno NV 89501", "a city alone", "street"],
    ["9 Depot Rd, Warehouse City, NV", "no ZIP", "zip"],
    ["9 Depot Rd, Warehouse City, NV 8900", "a ZIP of four digits", "zip"],
    ["9 Depot Rd, Warehouse City, NV 89001-12", "a short ZIP+4", "zip"],
    ["9 Depot Rd, Warehouse City, XX 89001", "not a state", "state"],
    ["9 Depot Rd, Warehouse City 89001", "no state", "state"],
    ["9 Depot Rd NV 89001", "a street and no city", "city"],
    ["9 Depot Rd, NV 89001", "a street and no city, with a comma", "city"],
    ["1200 Park Ave NV 10001", "a street ending in a street word, no city", "city"],
    ["9 Depot Rd Suite 4 NV 89501", "a suite is not a city", "city"],
    ["9 Depot Rd #4 NV 89501", "a unit number is not a city", "city"],
    ["9 Depot Rd NW NV 89501", "a direction is not a city", "city"],
    ["9 Depot Rd Dock B NV 89501", "the word after a unit is part of the unit", "city"],
    ["Depot Rd Reno NV 89501", "no street number and no comma", "street"],
    ["89001", "only a ZIP", "state"],
    ["9 Depot Rd, Warehouse City, USA", "a country in place of state and ZIP", "zip"],
    ["NV 89001", "only a state and ZIP", "street"],
    ["USA", "only a country", "zip"],
    ["Warehouse City, NV, 89001", "no street, state and ZIP as two parts", "street"],
    ["9 Depot Rd, Warehouse City, 89001", "a ZIP with no state", "state"],
    ["9 Depot Rd, 89001", "a street and a ZIP", "state"],
    ["9 Depot Rd, Warehouse City, NV 890011", "a ZIP of six digits", "zip"],
    ["9 Depot Rd, Warehouse City, Nevadaa 89001", "a misspelt state", "state"],
    ["9 Depot Rd, Warehouse City, NV, USA", "a state and a country, no ZIP", "zip"],
    ["9 Depot Rd, Warehouse City, NV 89001, Mexico", "another country", "zip"],
    ["12 Test Way, Testville", "a street and a city only", "zip"],
    ["9 Depot Rd, Warehouse City, constructor 89001", "a word that is not a state, even one every object has", "state"],
  ] as const;
  for (const [a, why, lack] of notFull) {
    it(`is not full: ${why}`, () => {
      expect(isFullAddress(a)).toBe(false);
      expect(addressLack(a)).toBe(lack);
    });
  }

  it("reads a missing value as not full", () => {
    expect(isFullAddress(null)).toBe(false);
    expect(isFullAddress(undefined)).toBe(false);
  });
});

const NOTE = "Like 9 Depot Rd, Reno, NV 89501.";

describe("addressNote", () => {
  it("says nothing for an empty box or a full address, and names the missing part of a half typed one", () => {
    expect(addressNote("")).toBeUndefined();
    expect(addressNote("9 Depot Rd, Warehouse City, NV 89001")).toBeUndefined();
    expect(addressNote("9 Depot Rd, Reno NV 89501")).toBeUndefined();
    expect(addressNote("Warehouse City, NV")).toBe(`Needs its 5-digit ZIP code at the end. ${NOTE}`);
    expect(addressNote("9 Depot Rd, Reno, 89501")).toBe(`Needs its state, just before the ZIP code. ${NOTE}`);
    expect(addressNote("9 Depot Rd, NV 89501")).toBe(`Needs its city. ${NOTE}`);
    expect(addressNote("Reno, NV 89501")).toBe(`Needs its street and number. ${NOTE}`);
  });
  it("ends with the server's worked example, which passes the rule", () => {
    expect(ADDRESS_EXAMPLE).toBe(NOTE);
    expect(isFullAddress("9 Depot Rd, Reno, NV 89501")).toBe(true);
  });
  it("names the shape the boxes ask for", () => {
    expect(ADDRESS_HINT).toBe("Street, city, state ZIP");
  });
});

describe("relabelPickupError", () => {
  const sentence = (n: number) => `Add the full address of pickup ${n} with its ZIP code.`;
  it("with no blank row the number is unchanged", () => {
    expect(relabelPickupError(sentence(2), [0, 1])).toBe(sentence(2));
    expect(relabelPickupError(sentence(3), [0, 1])).toBe(sentence(3));
  });
  it("a blank first row and a short second row: the server's pickup 2 is the sheet's Pickup 3", () => {
    expect(relabelPickupError(sentence(2), [1])).toBe(sentence(3));
  });
  it("maps each number by the rows that were sent", () => {
    expect(relabelPickupError(sentence(2), [1, 3])).toBe(sentence(3));
    expect(relabelPickupError(sentence(3), [1, 3])).toBe(sentence(5));
  });
  it("keeps the wording and the Error prefix, and leaves a sentence with no number alone", () => {
    expect(relabelPickupError("Error: Add the full address of pickup 2 with its ZIP code.", [2])).toBe("Error: Add the full address of pickup 4 with its ZIP code.");
    for (const m of ["Add the full pickup address with its ZIP code (street, city, state, ZIP).", "Add the full delivery address with its ZIP code.", ""]) {
      expect(relabelPickupError(m, [1])).toBe(m);
    }
  });
  it("leaves a number the sheet did not send alone", () => {
    expect(relabelPickupError(sentence(5), [1])).toBe(sentence(5));
    expect(relabelPickupError(sentence(1), [1])).toBe(sentence(1));
  });
});

// The booking form (Quote and Book steps) sends every row as it stands and the server drops a row with nothing in it,
// then numbers the rest from 2. Invented rows.
describe("keptPickupRows and relabelAddressGap", () => {
  const blank = { name: "", address: "", window: "", contact: "", phone: "", notes: "", dock: "", pickup_number: "" };
  const short = { ...blank, name: "Dock B", address: "2 Dock Rd, Reno" };
  const sentence = (n: number) => `Add the full address of pickup ${n} with its ZIP code. ${NOTE}`;
  it("a blank row above an incomplete one: the server's pickup 2 is the sheet's Pickup 3", () => {
    const kept = keptPickupRows([blank, short]);
    expect(kept).toEqual([1]);
    expect(relabelAddressGap(sentence(2), kept)).toBe(sentence(3));
  });
  it("counts only what the server counts as something in a row", () => {
    expect(keptPickupRows([{ ...blank, name: "   " }, { ...blank, window: "Before 4 pm" }, { ...blank, pickup_number: "PU-1" }, blank, { ...blank, dock: "4" }])).toEqual([1, 2, 4]);
    expect(keptPickupRows([{ name: "A" }, {}])).toEqual([0]);
    expect(keptPickupRows([])).toEqual([]);
  });
  it("R-502: the sentences that name the missing part are relabelled the same way", () => {
    const kept = keptPickupRows([blank, short]);
    for (const m of [`The address of pickup 2 needs its city. ${NOTE}`, "Your team needs to finish the address of pickup 2 (its city) before this can go on."]) {
      expect(relabelAddressGap(m, kept)).toBe(m.replace("pickup 2", "pickup 3"));
    }
  });
  it("with no blank row the number is unchanged", () => {
    const kept = keptPickupRows([{ ...blank, name: "Dock A", address: "1 Dock Rd, Reno, NV 89501" }, short]);
    expect(relabelAddressGap(sentence(3), kept)).toBe(sentence(3));
  });
  it("leaves the server's other pickup sentences alone, since they already count the sheet's rows", () => {
    for (const m of ["Error: Pickup 3 address is too long. It can hold 500 characters.", "Pickup 3 must be a name, an address and its details.", "A truck can have at most 10 pickups."]) {
      expect(relabelAddressGap(m, [1])).toBe(m);
    }
    expect(relabelAddressGap("Add the full pickup address with its ZIP code.", [1])).toBe("Add the full pickup address with its ZIP code.");
  });
});
