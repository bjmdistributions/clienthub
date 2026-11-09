import type { Supplier, SupplierInput } from "./api";

// R-634: reading a supplier spreadsheet (the template's columns, which Export also writes) and flagging any
// row that exactly matches a saved supplier or an earlier row of the same file on company name, email or phone.

const HEADERS: Record<string, keyof SupplierInput> = {
  "company name": "name", company: "name", name: "name", supplier: "name", "supplier name": "name",
  "contact name": "contact_name", contact: "contact_name",
  email: "email", "email address": "email",
  phone: "phone", "phone number": "phone",
  address: "address",
  "payment method": "payment_method",
  "payment details": "payment_details",
  "payment terms": "payment_terms",
  "lead time": "typical_lead_time", "typical lead time": "typical_lead_time",
  notes: "notes",
};

export interface ImportRow {
  /** The spreadsheet row number, counting from 1 as Excel does. */
  line: number;
  input: SupplierInput;
  /** Why this row may already be in Ecliptr, e.g. "Same email as Acme Liquidators". Empty when nothing matched. */
  dupes: string[];
}

// The phone's Export starts with a byte-order mark (for Excel), which would otherwise stick to "Company name".
const normName = (s: string) => s.replace(/^﻿/, "").toLowerCase().replace(/\s+/g, " ").trim();
const normEmail = (s: string) => s.toLowerCase().trim();
/** Digits only, without a leading US 1, so "(555) 010-2000" and "+1 555 010 2000" match. Short numbers never match. */
const normPhone = (s: string) => {
  const d = s.replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return n.length >= 7 ? n : "";
};

export function parseSupplierRows(rows: string[][], existing: Pick<Supplier, "name" | "email" | "phone">[]): ImportRow[] {
  const headerAt = rows.findIndex((r) => r.some((c) => HEADERS[normName(c)] === "name"));
  if (headerAt < 0) throw new Error("No Company name column was found. Use the supplier template's headers.");
  const cols = rows[headerAt].map((c) => HEADERS[normName(c)]);

  const seen = { name: new Map<string, string>(), email: new Map<string, string>(), phone: new Map<string, string>() };
  const remember = (name: string, email: string, phone: string, label: string) => {
    if (name && !seen.name.has(name)) seen.name.set(name, label);
    if (email && !seen.email.has(email)) seen.email.set(email, label);
    if (phone && !seen.phone.has(phone)) seen.phone.set(phone, label);
  };
  for (const s of existing) remember(normName(s.name || ""), normEmail(s.email || ""), normPhone(s.phone || ""), s.name);

  const out: ImportRow[] = [];
  rows.slice(headerAt + 1).forEach((r, i) => {
    const input: SupplierInput = { name: "" };
    cols.forEach((key, c) => { if (key && (r[c] ?? "").trim()) input[key] = (r[c] ?? "").trim(); });
    if (!input.name) return;
    const line = headerAt + i + 2;
    const name = normName(input.name), email = normEmail(input.email || ""), phone = normPhone(input.phone || "");
    const dupes: string[] = [];
    const hit = (m: Map<string, string>, k: string, what: string) => {
      const who = k && m.get(k);
      if (who) dupes.push(`Same ${what} as ${who}`);
    };
    hit(seen.name, name, "company name");
    hit(seen.email, email, "email");
    hit(seen.phone, phone, "phone");
    remember(name, email, phone, `row ${line} (${input.name})`);
    out.push({ line, input, dupes });
  });
  return out;
}
