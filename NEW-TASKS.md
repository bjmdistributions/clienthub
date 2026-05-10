# New Tasks — Hand to Agent

This file contains four new tasks (TASK-017 through TASK-020) for the agent to work on, plus the operating instructions.

---

## How to use this file

1. Point OpenCode at this file: tell your agent "Read NEW-TASKS.md and follow the instructions inside."
2. The agent will append the four task specs to TASKS.md.
3. You then assign tasks one at a time using the suggested order at the bottom.
4. The protocol from AGENT-PROTOCOL.md still applies: plan first, wait for approval, execute, verify.

---

## Instructions for the agent

Read this entire document. Then:

1. **Append** the four task specs (TASK-017, TASK-018, TASK-019, TASK-020) below into TASKS.md, under the P1 section. Do not modify any other tasks. Do not invent any new tasks.

2. **Confirm** to the human that the four tasks are now in TASKS.md.

3. **Wait** for the human to assign a specific task. Do not start any of them on your own.

4. When assigned a task, follow AGENT-PROTOCOL.md exactly: produce a Phase 1 plan, wait for approval, then execute, then verify.

5. Critical: ARCHITECTURE.md invariants still apply to all four tasks. In particular:
   - Invariant 1: writes to synced tables go through `sync::record_upsert` / `sync::record_delete`
   - Invariant 4: secrets (passwords, tokens) go through the keychain via `email::save_cred`
   - Invariant 5: migrations are append-only — never edit migrations 1, 2, or any prior migration

6. Do NOT bundle multiple tasks. Do NOT improve unrelated code while you're in the file. If you notice a separate issue, add it to "Discovered Work" in TASKS.md and continue with the current task only.

---

## Suggested execution order

Work tasks in this order:

1. **TASK-017** first — smallest, frontend-only, no backend changes
2. **TASK-019** second — logo support, isolated PDF + Settings changes
3. **TASK-020** third — biggest, adds a new synced table (read invariant 1 carefully)
4. **TASK-018** last — PDF preview, easier after the logo work is done because PDF generation will already be split into a reusable helper

After all four are done, the human will commit, tag a new version, and ship via the existing GitHub Actions auto-updater pipeline.

---

## Task specs to append to TASKS.md

Append everything below this line into the P1 section of TASKS.md, then confirm done and wait for assignment.

---

### TASK-017: Inline client creation during invoice flow 🟢

**Why:** Currently invoice creation requires picking from existing clients. When a new lead requests an invoice, the user has to navigate away to Clients tab, create the client, then come back. This task adds inline client creation in the invoice form.

**What to change:**
- `src/components/InvoicesView.tsx`:
  - In the InvoiceForm component, replace the client dropdown with a combobox that has two options: pick existing client OR "+ Create new client"
  - When "Create new client" is selected, show inline fields: name (required), email, phone, company
  - On invoice submit, if creating new: first call `api.createClient()`, then use the returned client ID for the invoice
  - Reuse the existing `ClientInput` type — no backend changes needed
- No changes to backend, sync, or any other view

**Acceptance:**
- Existing flow (pick from dropdown) still works
- "Create new client" option creates the client + invoice in one save action
- New client appears in Clients tab afterward (proves sync engine fired correctly)
- Form validates that name is filled when creating new

**Out of scope:** Editing existing clients from invoice form. Bulk client import (already exists in Settings).

**Dependencies:** None.

---

### TASK-018: Invoice PDF preview before send 🟢

**Why:** Currently users generate the PDF and have to open it from disk to check it. The "Send" action could send a typo-laden invoice. A preview panel inside the invoice form prevents this.

**What to change:**
- `src-tauri/src/commands.rs`: add new command `preview_invoice_pdf(input: InvoiceInput) -> Result<String, String>` that generates a PDF without saving an invoice record (returns base64-encoded PDF bytes)
- `src-tauri/src/invoice.rs`: refactor `generate_pdf` to extract a `build_pdf_bytes(items, totals, client_data, company_info, dates) -> Vec<u8>` helper. The existing `generate_pdf` calls this helper then writes to disk. The new `preview_pdf` calls the helper and returns the bytes.
- Register new command in `main.rs::invoke_handler`
- `src/lib/api.ts`: add `previewInvoicePdf(input)` returning a base64 string
- `src/components/InvoicesView.tsx`:
  - Add "Preview" button next to "Create Invoice" in the form
  - Clicking Preview calls api.previewInvoicePdf, displays the PDF inline using an `<iframe>` with `src="data:application/pdf;base64,${data}"`, takes up the bottom half of the form area
  - Preview updates only when button is clicked (don't auto-regenerate on every keystroke — that's expensive)
  - Preview panel has a "Close" button to hide it

**Acceptance:**
- Preview shows the invoice exactly as it would be saved/sent
- No actual invoice record is created until user clicks "Create Invoice"
- Preview updates correctly when line items, dates, or client are changed and Preview is re-clicked
- Works in Tauri (uses `convertFileSrc` if needed for data URLs)

**Out of scope:** Live preview that updates as you type. Editing the PDF directly in preview.

**Dependencies:** Easier to do after TASK-019 because the PDF builder will already be a reusable helper by then.

---

### TASK-019: Company logo on invoices 🟢

**Why:** A logo at the top of invoices makes them look professional. Currently the invoice header is text-only.

**What to change:**
- `src-tauri/src/invoice.rs`:
  - Modify `CompanyInfo` struct to add `logo_path: Option<String>` field
  - In the PDF generation function, if `logo_path` is set and the file exists, embed the image at the top-left of the invoice using `printpdf::Image::from_dynamic_image()`
  - Logo should be sized to ~30mm wide × 30mm tall max (preserve aspect ratio)
  - Move the company name text to the right of the logo when a logo is present, or below it if logo is wide
- `Cargo.toml`: add `image = "0.25"` for image decoding (printpdf needs it)
- `src/components/SettingsView.tsx` CompanyTab:
  - Add a "Company Logo" section
  - "Choose Logo" button that opens a file picker (PNG/JPG only) using `@tauri-apps/plugin-dialog`
  - Show preview of selected logo
  - On save, copy the logo file to `<app_data_dir>/company_logo.png` (so the path is stable across launches and survives sync) and store that fixed path in CompanyInfo
  - "Remove Logo" button to clear it
- Logo file is **local-only** (not in the sync folder) — each device sets its own. CompanyInfo stays synced but `logo_path` references a local path.

**Acceptance:**
- User can upload a PNG or JPG via Settings → Company
- Logo appears on every PDF generated thereafter
- Logo persists across app restarts
- Removing the logo reverts invoices to text-only header
- PDFs without a logo still generate correctly (logo is optional)

**Out of scope:** Logo cropping/resizing UI. Multiple logos. Logo positions other than top-left.

**Dependencies:** None.

**Note for agent:** The logo file path goes in CompanyInfo (which IS synced), but the actual logo image file lives at `<app_data_dir>/company_logo.png` (which is NOT synced — each device picks its own logo locally). This is intentional: business owners might want device-specific logos for testing, and large image files in the sync folder would bloat sync events.

---

### TASK-020: Payment methods in settings + on invoices 🟢

**Why:** Invoices currently say "Please remit payment by the due date" generically. Real invoices need specific payment instructions: ACH details, Stripe link, Venmo, check mailing address, etc. This task lets the user define their accepted payment methods once in Settings, then automatically appends them to every invoice's footer.

**What to change:**
- New table in migration v3 (append to db.rs): `payment_methods (id TEXT PRIMARY KEY, kind TEXT, label TEXT, details TEXT, active INTEGER, sort_order INTEGER)`. This IS a synced table — payment methods should be the same on all devices.
- Add `"payment_methods"` to `sync::ALLOWED_TABLES` in `sync.rs`
- `src-tauri/src/commands.rs`: add `list_payment_methods`, `create_payment_method`, `update_payment_method`, `delete_payment_method`, `reorder_payment_methods` (all going through sync engine via `sync::record_upsert` / `sync::record_delete`)
- `src-tauri/src/invoice.rs`: in PDF generation, after the totals section, render a "Payment Options" block listing each active payment method (kind heading + details text)
- New tab in SettingsView: "Payment Methods"
  - List of methods with: kind (dropdown: ACH, Wire, Stripe Link, PayPal, Venmo, Zelle, Check, Other), label (e.g. "ACH transfer"), details (multi-line: account #, instructions, URL, etc.), active toggle, drag-to-reorder
  - Add/Edit/Delete buttons
  - Empty state: "Add a payment method to display options on your invoices"
- Register new commands in main.rs and api.ts

**Acceptance:**
- User can add multiple payment methods in Settings
- Methods sync between all devices (verify after building by checking that creating a method on PC propagates to a Mac via Syncthing)
- Active methods appear on every PDF generated
- Inactive methods don't appear (lets user temporarily disable without deleting)
- Reordering in Settings reflects in PDF order
- Empty state: if no payment methods are defined, the invoice still renders cleanly without an empty "Payment Options" section

**Out of scope:** Auto-generating payment links (Stripe/PayPal API integration). QR codes. Per-invoice payment method selection (all active methods always shown).

**Dependencies:** None.

**Critical for agent:** This is the first task in the project that adds a new synced table. ARCHITECTURE.md Invariant 1 says all writes to synced tables go through `sync::record_upsert` / `sync::record_delete`. The new commands in commands.rs must follow this pattern (build a `serde_json::Map` of columns, call `sync::record_upsert`, then mirror via direct SQL — same pattern as `create_client` in the existing code). Also update `sync::ALLOWED_TABLES` to include `"payment_methods"`. If either of those is missing, the data won't sync to other devices and the bug will silently corrupt user data across multi-device setups.

---

## Once all four are done

The human will:

1. `git add . && git commit -m "Add invoice features: inline clients, logo, payment methods, PDF preview"`
2. `git push`
3. `git tag v0.2.0 && git push origin v0.2.0`
4. Wait for GitHub Actions to build (~15 min)
5. Publish the draft release at github.com/bjmdistributions/clienthub/releases
6. On all 3 devices: open ClientHub → Settings → Check for Updates → install

Then all four features are live across all devices.
