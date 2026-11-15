import { describe, expect, it } from "vitest";
import cases from "./tidy.cases.json";
import { addressLack, addressParts } from "./fullAddress";
import { tidyAddress, tidyDims, tidyEmail, tidyName, tidyPhone, tidyWindow } from "./tidy";

// R-651: the same cases the website's lgTidy* are checked against.
describe("tidy", () => {
  const run = (name: string, list: string[][], fn: (s: string) => string) =>
    it(name, () => { for (const [inp, out] of list) expect([inp, fn(inp)]).toEqual([inp, out]); });
  run("address", cases.address, tidyAddress);
  run("name", cases.name, tidyName);
  run("phone", cases.phone, tidyPhone);
  run("window", cases.window, tidyWindow);
  run("email", cases.email, tidyEmail);
  run("dims", cases.dims, tidyDims);

  it("reads an address in parts exactly when it is full", () => {
    for (const [inp, out] of cases.address) {
      expect([inp, addressParts(inp) !== null]).toEqual([inp, addressLack(inp) === undefined]);
      // A tidied address is still full or still not, and tidying it again changes nothing.
      expect([inp, addressLack(out) === undefined]).toEqual([inp, addressLack(inp) === undefined]);
      expect(tidyAddress(out)).toBe(out);
    }
  });
});
