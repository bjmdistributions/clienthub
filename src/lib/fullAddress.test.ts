import { describe, it, expect } from "vitest";
import { ADDRESS_HINT, addressNote, isFullAddress, keptPickupRows, relabelAddressGap, relabelPickupError } from "./fullAddress";

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
  ];
  for (const a of full) it(`is full: ${JSON.stringify(a)}`, () => expect(isFullAddress(a)).toBe(true));

  const notFull = [
    ["", "empty"],
    ["   ", "blank"],
    ["Warehouse City, NV 89001", "no street"],
    ["9 Depot Rd, Warehouse City, NV", "no ZIP"],
    ["9 Depot Rd, Warehouse City, NV 8900", "a ZIP of four digits"],
    ["9 Depot Rd, Warehouse City, NV 89001-12", "a short ZIP+4"],
    ["9 Depot Rd, Warehouse City, XX 89001", "not a state"],
    ["9 Depot Rd, Warehouse City 89001", "no state"],
    ["9 Depot Rd NV 89001", "one part"],
    ["89001", "only a ZIP"],
    ["9 Depot Rd, Warehouse City, USA", "a country in place of state and ZIP"],
    [",,", "only separators"],
    ["NV 89001", "only a state and ZIP"],
    ["USA", "only a country"],
    ["Warehouse City, NV, 89001", "no street, state and ZIP as two parts"],
    ["9 Depot Rd, Warehouse City, 89001", "a ZIP with no state"],
    ["9 Depot Rd, 89001", "a street and a ZIP"],
    ["9 Depot Rd, Warehouse City, NV 890011", "a ZIP of six digits"],
    ["9 Depot Rd, Warehouse City, Nevadaa 89001", "a misspelt state"],
    ["9 Depot Rd Warehouse City NV 89001", "no commas"],
    ["9 Depot Rd, Warehouse City NV 89001", "no comma before the state"],
    ["9 Depot Rd, Warehouse City, NV, USA", "a state and a country, no ZIP"],
    ["9 Depot Rd, Warehouse City, NV 89001, Mexico", "another country"],
    ["9 Depot Rd, Warehouse City, constructor 89001", "a word that is not a state, even one every object has"],
  ] as const;
  for (const [a, why] of notFull) it(`is not full: ${why}`, () => expect(isFullAddress(a)).toBe(false));

  it("reads a missing value as not full", () => {
    expect(isFullAddress(null)).toBe(false);
    expect(isFullAddress(undefined)).toBe(false);
  });
});

const NOTE = "Write it as street, city, state ZIP with commas between: 9 Depot Rd, Reno, NV 89501.";

describe("addressNote", () => {
  it("says nothing for an empty box or a full address, and asks for the rest of a half typed one", () => {
    expect(addressNote("")).toBeUndefined();
    expect(addressNote("9 Depot Rd, Warehouse City, NV 89001")).toBeUndefined();
    expect(addressNote("Warehouse City, NV")).toBe(NOTE);
  });
  it("always carries the worked example, so an address with all four parts but no commas says what to change", () => {
    for (const a of ["9 Depot Rd, Warehouse City NV 89001", "9 Depot Rd Warehouse City NV 89001", "Warehouse City, NV 89001", "9 Depot Rd"]) {
      expect(addressNote(a)).toBe(NOTE);
    }
    expect(NOTE).toContain("commas");
    expect(NOTE).toContain("9 Depot Rd, Reno, NV 89501");
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
