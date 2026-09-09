import { describe, it, expect } from "vitest";
import { defaultSendFrom } from "./FromPicker";
import type { FromOption } from "../lib/api";

// The picker's displayed default has to match the address the backend actually sends
// as when the picker is left untouched (R-194 review finding): send_invoice_mail prefers
// from_invoices, then from_email, then the SMTP login; every other send path calls
// send_threaded directly and skips from_invoices, preferring from_email then the login.

const login: FromOption = { address: "jack@bjm.com", label: "Default", kind: "login" };
const sales: FromOption = { address: "sales@bjm.com", label: "Sales", kind: "sales" };
const invoices: FromOption = { address: "invoices@bjm.com", label: "Invoices", kind: "invoices" };

describe("defaultSendFrom", () => {
  it("general sends prefer sales over the login, and never pick invoices", () => {
    expect(defaultSendFrom([login, sales, invoices])).toBe(sales.address);
    expect(defaultSendFrom([login, invoices])).toBe(login.address);
  });

  it("invoice sends prefer invoices, then sales, then the login", () => {
    expect(defaultSendFrom([login, sales, invoices], true)).toBe(invoices.address);
    expect(defaultSendFrom([login, sales], true)).toBe(sales.address);
    expect(defaultSendFrom([login], true)).toBe(login.address);
  });
});
