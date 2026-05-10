# Tasks

The complete catalog of remaining work. **Agents pick from here. Agents do not invent tasks.**

Each task has a stable ID. Reference tasks by ID in commit messages and questions.

**Status legend:**
- 🟢 Ready — dependencies met, can be picked up now
- 🟡 Blocked — waiting on a dependency or human input
- ✅ Done — committed and verified
- 🔵 Optional — nice-to-have, low priority

---

## P0 — Required to ship

### TASK-001: Generate app icons ✅
**Why:** Without icons, the dock/start menu shows a generic placeholder and `cargo tauri build` fails on some platforms.

**What:**
1. Human supplies a `1024x1024` PNG at `src-tauri/icons/icon.png` (with transparent background).
2. Agent runs `cargo tauri icon src-tauri/icons/icon.png` to generate all platform variants.
3. Verify `src-tauri/icons/` now contains `.icns`, `.ico`, and PNG variants in expected sizes.
4. Verify `tauri.conf.json` references `icons/icon.icns` and `icons/icon.ico` (already does).

**Acceptance:**
- `ls src-tauri/icons/` shows: `icon.icns`, `icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`
- `cargo tauri build` does not fail with icon errors

**Dependencies:** Human must supply `icon.png`.

**Out of scope:** Designing the icon. Agent does not create the artwork.

---

### TASK-002: Replace placeholder bundle identifier ✅
**Why:** `com.yourco.clienthub` is a placeholder. macOS uses this for the keychain namespace and app data directory — it must be the real identifier before any build is distributed.

**What:**
1. Decide identifier with human (e.g., `com.yourbusiness.clienthub`).
2. Search-and-replace `com.yourco.clienthub` → `<chosen identifier>` in:
   - `src-tauri/tauri.conf.json` (`identifier` field)
   - `src-tauri/src/invoice.rs` (function `directories_for_app`)
   - `ARCHITECTURE.md` and `DEPLOY.md` (documentation references)
3. Verify no other matches: `grep -r "com.yourco.clienthub" .` returns nothing.

**Acceptance:**
- `grep -r "com.yourco.clienthub"` returns zero matches
- `cargo tauri build` produces a bundle with the new identifier

**Dependencies:** Human must confirm chosen identifier.

---

### TASK-003: Wire invoice.rs PDF path resolution to db::app_data_dir() ✅
**Why:** Currently `invoice.rs` reimplements its own platform-specific path resolution (the `dirs_data_local` / `directories_for_app` helpers). This duplicates `db.rs` logic and will drift on first identifier change. Single source of truth.

**What:**
1. Replace `pdf_output_dir()` in `invoice.rs` to call `crate::db::app_data_dir().join("invoices")`.
2. Delete the now-unused `directories_for_app`, `dirs_data_local`, `dirs_next` helpers.
3. Verify `cargo check` passes.

**Acceptance:**
- `invoice.rs` has no path-resolution helpers
- PDFs still land in `<app_data_dir>/invoices/<number>.pdf`

**Dependencies:** None.

**Out of scope:** Changing where PDFs are stored.

---

### TASK-004: Build the OAuth2 consent flow UI ✅
**Why:** Currently the user has to manually paste a refresh token from Google's OAuth Playground. For a polished experience, the app should launch a browser, intercept the redirect, and exchange the code for a refresh token automatically.

**What:**
1. Add to `Cargo.toml`: `tiny_http = "0.12"` for the localhost listener.
2. New file `src-tauri/src/oauth_flow.rs`:
   - Function `start_consent_flow(client_id, client_secret) -> Result<RefreshToken>`
   - Spins up `tiny_http` on a random localhost port (e.g., 7777-7799 range, find first open)
   - Builds the Google auth URL with scope `https://mail.google.com/`, redirect_uri `http://localhost:<port>/callback`
   - Opens the URL via `tauri_plugin_shell::open`
   - Blocks waiting for the redirect, extracts the `code` query param
   - Exchanges code for tokens via the `oauth2` crate
   - Stores `oauth_client_id`, `oauth_client_secret`, `oauth_refresh_token` in keychain
   - Returns
3. New Tauri command `oauth_start_consent` in `commands.rs`.
4. Add to `api.ts`: `oauthStartConsent(clientId, clientSecret) -> Promise<void>`.
5. In `SettingsView::EmailTab`, when auth method is `oauth2`:
   - Show fields for Client ID + Client Secret (these the user still copy-pastes from Google Console — they're not sensitive enough to flow-automate)
   - Replace the "Refresh Token" field with a button: "Authorize with Google"
   - Button calls `api.oauthStartConsent(...)`, shows a spinner, success state when done

**Acceptance:**
- User clicks "Authorize with Google" → browser opens to Google consent → user approves → returns to app showing success
- Subsequent IMAP scans and SMTP sends work without manual token paste
- `keyring` shows the three OAuth keys are populated

**Dependencies:** Working `email.rs` OAuth2 path (already done).

**Out of scope:** Microsoft/Outlook OAuth (separate task if needed).

**Edge cases to handle:**
- User closes browser without approving → 60s timeout, return error
- Port collision → try next port up to 7799, then fail clearly
- Google returns error in callback → surface verbatim

---

### TASK-005: Email drafts review queue UI ✅
**Why:** The `email_drafts` table exists (migration v2) and the AI can produce reply drafts, but there's no UI to review/approve/discard them. The intended flow: AI auto-drafts replies in the background → drafts land in the queue → human reviews and sends.

**What:**
1. New backend commands in `commands.rs`:
   - `list_drafts(status?) -> Vec<EmailDraft>` — pending by default, filter optional
   - `update_draft(id, body, subject) -> ()` — edit before sending
   - `send_draft(id) -> ()` — calls `email::send`, updates status to `sent`, sets `sent_at`
   - `discard_draft(id) -> ()` — sets status to `discarded`
2. Type `EmailDraft` in `commands.rs` mirroring the table.
3. Register all in `main.rs::invoke_handler`.
4. Add to `api.ts`.
5. New tab in `EmailView`: "Drafts (N)" where N is pending count.
6. Drafts tab shows a list with: client name (lookup if `client_id` set), subject, body preview, age, and three buttons: Edit, Send, Discard.
7. Edit opens a textarea inline; Save updates the draft.

**Acceptance:**
- Drafts tab shows pending drafts
- Edit → save persists
- Send → email goes out, draft disappears (filtered by status)
- Discard → draft disappears
- Counter on tab updates in real-time

**Dependencies:** None for the UI; the auto-draft generation is TASK-006.

**Out of scope:** Auto-generating drafts (that's TASK-006).

---

### TASK-006: Auto-generate drafts on inbound emails ✅
**Why:** The infrastructure to draft replies (AI) and queue them (drafts table) exists but they're not connected. Currently `process_new_emails` only logs interactions; it should also produce a draft when the inbound email looks like it warrants a reply.

**What:**
1. In `email.rs::process_new_emails`, after logging an interaction for a known client, call:
   ```rust
   if should_draft(&email) { spawn_draft_generation(client_id, email) }
   ```
2. Implement `should_draft(email) -> bool`: returns true if the email is not auto-generated (heuristic: From doesn't contain `noreply`, `no-reply`, `donotreply`, `mailer-daemon`).
3. Implement `spawn_draft_generation`: in a tokio task, calls `ai::draft_reply` with the email body and a fetched context (interaction history summary), writes the result to `email_drafts` with status `pending`, `in_reply_to_message_id` set, `to_addr` set to original sender.
4. Errors in draft generation are logged at WARN level, never propagated.

**Acceptance:**
- An inbound email from a known client (non-auto) → within ~10s, a pending draft appears in the Drafts tab
- An auto-generated email (e.g., a newsletter) → no draft created
- AI failures don't break the IMAP scan loop

**Dependencies:** TASK-005 (UI must exist to see results).

**Out of scope:** Per-client toggle for auto-drafting (could be a future task).

---

### TASK-007: Wire auto-updater ✅
**Why:** Once you ship to 3 devices, you'll want updates without re-running installers. Tauri has an auto-updater plugin that pulls from GitHub Releases (free).

**What:**
1. Add `tauri-plugin-updater = "2.0"` to `Cargo.toml`.
2. Add `@tauri-apps/plugin-updater` to `package.json`.
3. Register plugin in `main.rs`.
4. Generate signing keypair (human runs `cargo tauri signer generate -w ~/.tauri/clienthub.key` once, stores private key in GitHub Secrets as `TAURI_SIGNING_PRIVATE_KEY`, public key goes in tauri.conf.json).
5. Add `updater` block to `tauri.conf.json` with endpoints pointing at GitHub Releases JSON.
6. Add a "Check for updates" button in Settings → Sync tab (or a new About tab).
7. The GitHub Actions workflow already passes `TAURI_SIGNING_PRIVATE_KEY` — verify it works end-to-end.

**Acceptance:**
- Tagging a new release on GitHub → all 3 devices show an update prompt within 24h
- User clicks "Update" → app downloads, verifies signature, installs, relaunches

**Dependencies:** TASK-001 (icons must exist for releases).

**Out of scope:** Delta updates (Tauri does full bundle replacement).

---

## P1 — Strongly recommended

### TASK-008: Add encryption-at-rest for sync events ✅
**Why:** Sync events are JSON files in a folder Syncthing replicates. If a device is compromised or a backup is exfiltrated, the entire database history is readable. Encrypting the events with a shared key (entered once per device) closes this hole.

**What:**
1. New module `src-tauri/src/sync_crypto.rs` using `ring::aead::CHACHA20_POLY1305`.
2. Key derivation: PBKDF2 from a passphrase + a fixed salt (stored in `settings`). Passphrase entered on each device once, stored in keychain under `sync_passphrase`.
3. In `sync::write_event_file`: serialize event → encrypt → write `.enc.json` extension.
4. In `sync::apply_event`/replay: detect `.enc.json`, decrypt before parsing.
5. Backward-compat: support both `.json` (legacy) and `.enc.json` files during a migration window.
6. Settings → Sync tab: "Encryption" subsection with a "Set passphrase" button (asks user, derives key, stores).

**Acceptance:**
- New events written are encrypted (`file content does not contain "row_id"`)
- Old plaintext events still apply during transition
- A device without the passphrase fails replay with a clear error message (not a parse error)

**Dependencies:** None.

**Out of scope:** Re-encrypting existing plaintext events (separate migration task if needed).

---

### TASK-018: Inline client creation during invoice flow ✅

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

### TASK-019: Invoice PDF preview before send ✅

**Why:** Currently users generate the PDF and have to open it from disk to check it. The "Send" action could send a typo-laden invoice. A preview panel inside the invoice form prevents this.

**What to change:**
- `src-tauri/src/commands.rs`: add new command `preview_invoice_pdf(input: InvoiceInput) -> Result<String, String>` that generates a PDF without saving an invoice record (returns base64-encoded PDF bytes)
- `src-tauri/src/invoice.rs`: refactor `generate_pdf` to extract a `build_pdf_bytes(items, totals, client_data, company_info, dates) -> Vec<u8>` helper. The existing `generate_pdf` calls this helper then writes to disk. The new `preview_pdf` calls the helper and returns the bytes.
- Register new command in `main.rs::invoke_handler`
- `src/lib/api.ts`: add `previewInvoicePdf(input)` returning a base64 string
- `src/components/InvoicesView.tsx`:
  - Add "Preview" button next to "Create Invoice" in the form
  - Clicking Preview calls api.previewInvoicePdf, displays the PDF inline using an `<iframe>` with `src="data:application/pdf;base64,${data}"`, takes up the bottom half of the form area
  - Preview updates only when button is clicked (don't auto-regenerate on every keystroke)
  - Preview panel has a "Close" button to hide it

**Acceptance:**
- Preview shows the invoice exactly as it would be saved/sent
- No actual invoice record is created until user clicks "Create Invoice"
- Preview updates correctly when line items, dates, or client are changed and Preview is re-clicked

**Out of scope:** Live preview that updates as you type. Editing the PDF directly in preview.

**Dependencies:** Easier to do after TASK-020 because the PDF builder will already be a reusable helper by then.

---

### TASK-020: Company logo on invoices ✅

**Why:** A logo at the top of invoices makes them look professional. Currently the invoice header is text-only.

**What to change:**
- `src-tauri/src/invoice.rs`:
  - Modify `CompanyInfo` struct to add `logo_path: Option<String>` field
  - If `logo_path` is set and the file exists, embed the image at the top-left of the invoice using `printpdf::Image::from_dynamic_image()`
  - Logo should be sized to ~30mm wide × 30mm tall max (preserve aspect ratio)
  - Move the company name text to the right of the logo when a logo is present
- `Cargo.toml`: add `image = "0.25"` for image decoding
- `src/components/SettingsView.tsx` CompanyTab:
  - Add a "Company Logo" section
  - "Choose Logo" button that opens a file picker (PNG/JPG only) using `@tauri-apps/plugin-dialog`
  - Show preview of selected logo
  - On save, copy the logo file to `<app_data_dir>/company_logo.png` and store that fixed path in CompanyInfo
  - "Remove Logo" button to clear it
- Logo file is **local-only** — each device sets its own. CompanyInfo stays synced but `logo_path` references a local path.

**Acceptance:**
- User can upload a PNG or JPG via Settings → Company
- Logo appears on every PDF generated thereafter and persists across app restarts
- Removing the logo reverts invoices to text-only header

**Out of scope:** Logo cropping/resizing UI. Multiple logos.

**Dependencies:** None.

---

### TASK-021: Payment methods in settings + on invoices ✅

**Why:** Invoices currently say "Please remit payment by the due date" generically. Real invoices need specific payment instructions: ACH details, Stripe link, Venmo, check mailing address, etc.

**What to change:**
- New table in migration v4 (append to db.rs): `payment_methods (id TEXT PK, kind TEXT, label TEXT, details TEXT, active INTEGER, sort_order INTEGER)`. This IS a synced table — add `"payment_methods"` to `sync::ALLOWED_TABLES`.
- `src-tauri/src/commands.rs`: add `list_payment_methods`, `create_payment_method`, `update_payment_method`, `delete_payment_method`, `reorder_payment_methods` (all via `sync::record_upsert` / `sync::record_delete`)
- `src-tauri/src/invoice.rs`: in PDF generation, after totals, render a "Payment Options" block listing each active payment method
- New tab in SettingsView: "Payment Methods" — list with kind (dropdown: ACH, Wire, Stripe Link, PayPal, Venmo, Zelle, Check, Other), label, details (multi-line), active toggle, reorder, add/edit/delete
- Register new commands in main.rs and api.ts

**Acceptance:**
- User can add multiple payment methods in Settings that sync between devices
- Active methods appear on every PDF; inactive ones don't
- Reordering in Settings reflects in PDF order
- Empty state: no payment methods → no "Payment Options" section on invoices

**Out of scope:** Auto-generating payment links. QR codes. Per-invoice method selection.

**Critical for agent:** New synced table — Invariant 1 applies. All writes via `sync::record_upsert` / `sync::record_delete`. Same pattern as `create_client`. Update `sync::ALLOWED_TABLES`. Missing either = silent data divergence.

---

### TASK-009: Calendar/booking integration via webhook receiver 🔵
**Why:** Calendly / Cal.com / Google Calendar events that come via email work via TASK-006's signup rules, but a webhook is faster and more structured. This is a stretch goal.

**What:**
1. Optional local HTTP server bound to `localhost:PORT` (configurable).
2. Endpoint `/webhook/calendly` accepting POSTs.
3. Maps calendar events to interactions (`kind=meeting`).
4. Requires reverse tunnel (ngrok, Cloudflare Tunnel) for external access — out of scope here, document only.

**Acceptance:** Deferred. Skip unless human asks.

**Dependencies:** TASK-002.

---

### TASK-010: Per-client custom fields 🔵
**Why:** Different businesses track different things. A simple `metadata: Json<Map<String, Value>>` column on clients enables per-business customization without schema churn.

**What:**
1. New migration v3: `ALTER TABLE clients ADD COLUMN metadata TEXT DEFAULT '{}'`.
2. Settings → Company tab: section to define custom fields (name + type: text/number/date).
3. ClientForm renders the custom fields below the standard ones.
4. Custom field values stored in `metadata` JSON.

**Acceptance:** Custom field defined → appears in client form → saves and displays.

**Dependencies:** None.

**Out of scope:** Field validation rules, conditional fields.

---

## P2 — Polish / nice-to-have

### TASK-011: Search across interactions and invoices 🔵
**Why:** Currently search is limited to clients. SQLite FTS5 over interactions.body and invoices.line_items_json is cheap and high-value.

### TASK-012: Export to CSV 🔵
**Why:** Mirror of the import. One button per table.

### TASK-013: Bulk client operations 🔵
**Why:** Multi-select in the clients table for bulk delete / bulk tag / bulk export.

### TASK-014: Recurring invoices 🔵
**Why:** Many businesses bill monthly. A "recurring" flag on invoices + a daily check that generates new invoices when due.

### TASK-015: Light/dark theme toggle 🔵
**Why:** Tailwind already has dark variants in some places; finish them and add a toggle.

---

## TASK-016: Expand client schema + CSV import for lead form ✅

**Why:** The user tracks clients in a Google Sheets form with 26 columns (name, address, buy categories, lead source, etc.). The current `clients` table only has name/email/phone/company/notes. Need to import this CSV format, store the extended data, and compute invoice counts per client.

**What:**

1. **Migration v3** in `db.rs`: `ALTER TABLE clients ADD COLUMN metadata TEXT DEFAULT '{}'`
2. **Update `csv_import.rs`**: Auto-detect the specific header names from the user's Google Sheets form. Map core fields to real columns (First Name + Last Name → `name` as "First Last", Email → `email`, Phone → `phone`, Company Name → `company`, Notes → `notes`). All other fields go into `metadata` JSON: interest_level, job_title, primary_buy_category, other_buy_categories, street_address, city, state, zip_code, country, estimated_annual_spend, purchase_frequency, tax_id, website, lead_source, buyer_type, last_contact_date, next_follow_up_date, lead_id, date_added, lead_representative.
3. **Update `commands.rs`**: Add `metadata` to `Client` struct. Update `create_client` / `update_client` to accept optional metadata. Add `invoice_count` computed field (dynamic `SELECT COUNT(*) FROM invoices WHERE client_id=? AND status IN ('sent','paid')` — not stored, always accurate).
4. **Update `invoice.rs`**: Bill To block now includes address from client metadata (street, city, state, zip) when available.
5. **Update `api.ts`**: Add `metadata` and `invoice_count` to `Client` type. Update input types.

**Acceptance:**
- Import the user's exact CSV → all 26 columns captured (core fields in columns, rest in metadata)
- `Client` struct includes `metadata: Option<Value>` and `invoice_count: i64`
- Invoice PDF Bill To shows full address when present
- `invoice_count` is always a live count from the invoices table
- `cargo check` passes

**Dependencies:** None.

**Out of scope:** Frontend views (TASK-017), signup rules auto-populate from form data.

---

## TASK-017: Update client views for expanded schema ✅

**Why:** With 26+ fields per client, the list and detail views need to show meaningful data organized in sections.

**What:**

1. **`ClientsView.tsx`**: Update list to show: Company (or name if no company), Email, Phone, Primary Buy Category, Invoice Count. Update search to also match against buy categories and lead source in metadata.
2. **`ClientDetailView.tsx`**: Sections: Contact Info (name, email, phone, job title, full address), Business Info (company, website, tax id, buy categories, estimated spend, purchase frequency), Lead Info (source, interest level, buyer type, dates), Notes. Invoice count prominently displayed.
3. **`SettingsView.tsx` Import tab**: Auto-detect the user's specific CSV header format and pre-fill the mapping. Show all 26 columns in the mapping UI.

**Acceptance:**
- Imported clients display correctly in list view with key fields
- Clicking a client shows all fields organized in sections
- Search finds clients by name, company, email, buy categories
- CSV import auto-maps the user's specific header format

**Dependencies:** TASK-016 (schema must exist first).

**Out of scope:** Editing metadata fields inline (future task).

---

## Discovered work (additions during execution)

When an agent finds something during execution that isn't a current task but seems worth doing, append it here. **Don't act on it during the current task.**

(empty)

- **Human request 2026-05-09 — Comma formatting for invoice numbers:** Display subtotal, tax, and total with thousands separators (e.g., "$1,234.56") in InvoicesView list and InvoiceForm totals. PDF already fine.

- **Human request 2026-05-09 — Edit existing invoices:** Add ability to modify an existing invoice (line items, dates, tax rate) via a new `update_invoice` command following the sync pattern (`sync::record_upsert` + mirror SQL). Add Edit button to invoice list rows, reuse InvoiceForm with pre-populated data from the selected invoice.

These are small — I'll plan both as a combined micro-task and wait for your go-ahead.

- **IMAP crate switch (discovered during TASK-003 verification):** IMAP scanner uses synchronous `imap = "2.4"` crate inside `tokio::task::spawn_blocking`. This was chosen over `async-imap` because `async-imap` 0.10 has internal compile errors with the tokio feature flag, and `async-imap` requires `futures::AsyncRead/AsyncWrite` traits which are incompatible with `tokio::net::TcpStream`. The blocking approach is fine for our scan-every-5-min use case and avoids the trait-bridging complexity entirely.

- **lib.rs broken re-export (discovered during TASK-003 verification):** `src-tauri/src/lib.rs` had `pub use crate::commands::*` which fails because `lib.rs` doesn't declare the module tree. Fixed by replacing contents with a minimal comment. Desktop Tauri 2 entry point is `main.rs`.

- **keyring v3 broken on Windows (discovered during email testing):** `keyring = "3"` on Windows reports `set_password` success but `get_password` returns `None` — credentials never actually persist. Downgraded to `keyring = "2"` which uses a proven Windows Credential Manager backend. Also added a round-trip verification check in `save_credential` to catch this class of failure early.

---

## Task selection guidance

- **For the human:** Open this file, decide which P0 you want first, hand the task ID to your agent.
- **For the agent:** Don't look outside this file for work. If something needs doing and isn't here, propose adding it (with format) and wait.
- **Order matters where dependencies exist.** TASK-001 before TASK-007 (icons before updater). TASK-005 before TASK-006 (UI before the feature that fills it). TASK-002 anywhere before first build.

A reasonable initial sequence:
1. TASK-002 (10 min) — replace identifier
2. TASK-001 (5 min) — generate icons (after human supplies PNG)
3. TASK-003 (15 min) — clean up path resolution
4. TASK-005 (1 hr) — drafts review UI
5. TASK-006 (30 min) — auto-draft generation
6. TASK-004 (1.5 hr) — OAuth consent flow
7. TASK-007 (45 min) — auto-updater
8. TASK-008 (2 hr) — sync encryption

Total: ~6 hours of agent work to reach a fully polished v1.
