# Phase 3 — Feature Plans

Each feature plan is precise enough that a developer can implement without asking questions. No code is written in this document.

Conventions used throughout:
- Synced writes always go through `sync::record_upsert(table, id, cols)` **and** the local `INSERT/UPDATE` (the Invariant 1 pattern). When adding a new synced table you must add it to `ALLOWED_TABLES` in [src-tauri/src/sync.rs:362](src-tauri/src/sync.rs:362) **and** the matching Pi list at [clienthub-api/src/sync.rs:424](../clienthub-api/src/sync.rs:424).
- Every new Tauri command must be added in three places: `#[tauri::command]` in `commands.rs`, the `invoke_handler!` list in `main.rs`, and the `api` object in `src/lib/api.ts`.
- "M-N" below = a database migration index N appended to MIGRATIONS in [db.rs:117](src-tauri/src/db.rs:117). Current max is 28; the next migration starts at 29.

---

## REVISIONS — Phase 5 Q&A applied (2026-05-27)

This document was written before Q&A. The following amendments override the original text where they conflict. Original sections below are kept for context but should be read with these deltas in mind. See [PHASE6_SAAS_PIVOT.md](PHASE6_SAAS_PIVOT.md) for the post-pivot picture.

### Feature 1 (Stripe) — Q9, Q10, Q32
- **Single business Stripe account.** No Stripe Connect, no sub-accounts.
- **Stripe-hosted Checkout** (not embedded Elements). Owner clicks "Request Payment" → server creates a Stripe Checkout Session → URL handed to client → client pays on Stripe's page.
- **Webhook stays as a TODO** in this batch (current arch has no public IP for friends/family installs). The webhook handler activates only when the SaaS server is live ([PHASE6_SAAS_PIVOT.md §8](PHASE6_SAAS_PIVOT.md)). For now, manual "Mark as paid" remains the path; Stripe payments require manual reconciliation until pivot.
- All other DB + UI work in Feature 1 proceeds as planned.

### Feature 2 (Sheets sync) — Q11, Q12
- **Drop the URL-based scheme entirely for new users.** Replace with Google Sheets API v4 + OAuth (`https://www.googleapis.com/auth/spreadsheets.readonly` and `…/spreadsheets`).
- New OAuth flow registered with separate scope (not bundled with Gmail OAuth — Q16).
- `get_sheet_headers` calls `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/Sheet1!1:1` with bearer token.
- `sync_from_sheet` reads via `…/values/Sheet1!A2:Z` (capped per `skip_header_rows`).
- Bidirectional push uses `PUT …/values/Sheet1!A{row}:Z{row}` per modified row.
- Conflict semantics: **LWW with ClientHub bias on tie** (Q12). Track `last_pushed_at` per row in a new `sheet_row_state(client_id, last_pushed_at, last_pulled_at)` mini-table. On a conflict (both sides changed since the snapshot), ClientHub wins.

### Feature 3 (PDF) — Q13, Q14
- **Light-tint watermark is acceptable** — stay on `printpdf 0.7`. No crate switch.
- **Totals only on the last page** of a multi-page invoice. No "continued" pattern.

### Feature 4 (Bulk actions) — Q15
- **Bulk delete blocks** when any selected client has invoices. Error message: "Cannot delete a client with existing invoices. Archive the client instead."
- **Add `ON DELETE RESTRICT`** to the `invoices.client_id` foreign key. This is a schema change to fix a latent bug in migration 1 ([db.rs:158](src-tauri/src/db.rs:158)) — invoices have a FK without an ON DELETE clause. New migration **29-pre** (rebuild invoices table since SQLite can't ALTER a FK constraint):
  ```sql
  -- New migration before Feature 1's migration. Renumber Feature 1's to 30.
  CREATE TABLE invoices_new (
      -- copy all columns from existing invoices schema as of migration 28
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      number TEXT UNIQUE NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      line_items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      tax REAL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT DEFAULT 'draft',
      pdf_path TEXT,
      sent_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      notes TEXT DEFAULT '',
      payment_method_label TEXT DEFAULT '',
      payment_reference TEXT DEFAULT '',
      recurring TEXT DEFAULT '',
      next_recurring_date TEXT DEFAULT '',
      cost_items_json TEXT,
      total_cost REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      margin REAL DEFAULT 0,
      carrier TEXT,
      tracking_number TEXT,
      shipping_charged REAL DEFAULT 0,
      pickup_date TEXT,
      delivery_date TEXT,
      is_complete INTEGER DEFAULT 0,
      deal_flow_id TEXT,
      deal_flow_stage TEXT DEFAULT 'none',
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT
  );
  INSERT INTO invoices_new SELECT * FROM invoices;
  DROP TABLE invoices;
  ALTER TABLE invoices_new RENAME TO invoices;
  CREATE INDEX idx_invoices_client ON invoices(client_id);
  CREATE INDEX idx_invoices_status ON invoices(status);
  CREATE INDEX idx_invoices_status_date ON invoices(status, issue_date);
  ```

### Feature 5 (Google Contacts) — Q16
- **Separate OAuth consent from Gmail.** Independent refresh token under `gcontacts_oauth_refresh` keychain key. Disconnecting Gmail does not affect Contacts.

### Feature 6 (Email variables)
- No revisions. Plan stands.

### Feature 7 (Inventory photos)
- No revisions. Plan stands.

### Feature 8 (Enterprise portal) — Q17
- **Deferred.** Keep the plan document for reference. Do not implement in current batch.
- See [PHASE6_SAAS_PIVOT.md](PHASE6_SAAS_PIVOT.md) which supersedes the original Feature 8 design — the org/sharing model now lives in the SaaS plan instead.

### Feature 9 (Auto-backup)
- No revisions to logic. Plan stands. The `name.len() == 33` → `30` bug is confirmed and ships in the Bug batch.

### Feature 10 (Follow-up enhancements) — Q20, Q21
- **Tier-drop trigger** only fires when `tier_history` has at least one prior entry for that client (Q20). First sync never fires tier_drop.
- **Unsubscribe detection** uses Ollama AI intent (Q21) instead of regex. Add a call to `ai::extract_unsubscribe_intent(body) -> bool` in `process_new_emails` ([email.rs:372](src-tauri/src/email.rs:372)). Implementation: Ollama prompt — *"Does this email body indicate the sender wants to unsubscribe from marketing emails? Reply with only 'yes' or 'no'."* Result cached by message-id to avoid duplicate calls.

### Feature 11 (WhatsApp)
- No revisions. Architecture-only deliverable, not implemented.

### Feature 12 (Shortcuts) — Q22, Q23
- Cmd+K safe to claim. ? safe to claim. Plan stands.

### Feature 13 (Exports)
- No revisions. Plan stands.

### Feature 14 (Custom invoice numbering) — Q24, Q25
- **Mixed numbering is acceptable**, no normalization tool.
- **No duplicate-number coordination needed** — current arch has one user per device, SaaS has one invoice-stream per org. Race window is acceptable.

### Feature 15 (Recurring invoices) — Q26
- **Keep existing `recurring` and `next_recurring_date` columns on `invoices`** for now. Don't drop in this batch.
- Migration 33 still creates the new `recurring_invoices` table and migrates existing recurring data into it.
- Schedule a follow-up release (post-batch) to drop the legacy columns after verifying nothing reads them.

### Cross-feature corrections from Q&A

- **Q4 (Pi DB path)**: when fixing Bug 2, also rename to `/home/jack/clienthub-data/clienthub.db` and delete the symlink-creation block at [clienthub-api/src/main.rs:30-36](../clienthub-api/src/main.rs:30). Update both the systemd unit and the default in `db.rs:10`.
- **Q5 (geocode logging)**: in addition to the existing `tracing::info!` log lines, write geocode results to a plaintext file at `<app_data_dir>/logs/geocode.log` (one line per run: `<rfc3339_timestamp> matched=X skipped=Y not_found=Z total=N`). Operator can read with `Get-Content "$env:APPDATA\com.bjmdistributions.clienthub\logs\geocode.log"`.
- **Q28 (unregistered commands)**: implement `customer_health_scores` and `get_customer_health` in [src-tauri/src/commands.rs](src-tauri/src/commands.rs) per the `CustomerHealth` type in [api.ts:442-453](src/lib/api.ts:442) — scoring formula reuses the Pi's `compute_health` at [clienthub-api/src/routes/clients.rs:385-432](../clienthub-api/src/routes/clients.rs:385) ported to desktop. Wire into HealthView and the `invoke_handler!` list.
- **Q29 (version sync)**: bump `src-tauri/Cargo.toml` to 0.11.0. Add a build-time check (a `build.rs` assertion that reads both versions and panics on mismatch) so this doesn't drift again.
- **Q30 (hardcoded version)**: replace `"clienthub-api v0.1.0"` at [clienthub-api/src/main.rs:83](../clienthub-api/src/main.rs:83) with `concat!("clienthub-api v", env!("CARGO_PKG_VERSION"))`.
- **Q31 (manifest trait)**: define `pub trait ManifestParser { fn parse(&self, path: &Path) -> Result<Vec<ManifestRow>>; }` in [src-tauri/src/manifest.rs](src-tauri/src/manifest.rs). Default impl `CsvManifestParser` wraps the existing CSV code. Dispatch in `analyze()`: `if path.ends_with(".pdf") { <pdf_impl>.parse(path) } else { CsvManifestParser.parse(path) }`. `<pdf_impl>` is a stub today (`unimplemented!("external PDF parser not yet integrated")`) that the external tech swaps in.
- **Q33 (globe dark mode)**: confirmed by design. No change. Globe stays forced-dark.
- **Q27 (ARCHITECTURE.md)**: scheduled as a separate task in the bug batch (Priority 1.5). Rewrite using [PHASE1_CODEBASE_SUMMARY.md](PHASE1_CODEBASE_SUMMARY.md) as the source of truth. Add a "Future architecture" pointer to PHASE6.

---

## Feature 1 — Stripe Payment Infrastructure (bare bones)

### Files

**Desktop changes**:
- [src-tauri/src/db.rs](src-tauri/src/db.rs) — add migration 29
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — add `payments` module of commands (~10 new commands)
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register new commands in `invoke_handler!`
- [src-tauri/src/sync.rs:362](src-tauri/src/sync.rs:362) — add `"payments"` to ALLOWED_TABLES
- [src-tauri/src/email.rs:113-115](src-tauri/src/email.rs:113) — re-use `save_cred`/`cred` helpers for Stripe keys (same keychain pattern as smtp_pass)
- [src/lib/api.ts](src/lib/api.ts) — add `Payment` type and api methods
- New file `src/components/PaymentBadge.tsx` (small status pill)
- [src/components/InvoicesView.tsx](src/components/InvoicesView.tsx) — add "Request Payment" button and status badge in invoice row + detail
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — add "Billing → Stripe" tab section

**Pi changes**:
- [clienthub-api/src/sync.rs:424](../clienthub-api/src/sync.rs:424) — add `"payments"` to ALLOWED_TABLES
- New file `clienthub-api/src/routes/payments.rs` registered in [routes/mod.rs](../clienthub-api/src/routes/mod.rs)
- [clienthub-api/src/main.rs](../clienthub-api/src/main.rs) — protected route mount via `routes::router()`

### Migration 29

```sql
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','refunded')) DEFAULT 'pending',
    payment_method TEXT,                            -- 'card', 'ach', 'manual', etc.
    stripe_payment_intent_id TEXT,                  -- nullable; populated once Stripe is enabled
    stripe_charge_id TEXT,
    stripe_customer_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_pi ON payments(stripe_payment_intent_id);
```

### New Tauri commands

- `list_payments(invoice_id: Option<String>) -> Result<Vec<Payment>, String>` — all payments, or filter by invoice.
- `get_payment(id: String) -> Result<Option<Payment>, String>`.
- `create_payment_request(invoice_id: String) -> Result<Payment, String>` — creates a row with status='pending', amount=invoice.total, currency='usd'. **TODO marker**: where Stripe `PaymentIntent.create` would be invoked, with the call site clearly commented `// TODO(stripe): replace with stripe::PaymentIntent::create when keys are configured`.
- `update_payment_status(id: String, status: String, stripe_id: Option<String>) -> Result<(), String>` — for webhook-driven updates later.
- `mark_payment_failed(id: String, error: String) -> Result<(), String>`.
- `refund_payment(id: String, reason: Option<String>) -> Result<(), String>` — **TODO marker** for `stripe::Refund::create`.
- `save_stripe_keys(publishable: String, secret: String, webhook_secret: String) -> Result<(), String>` — uses `email::save_cred("stripe_publishable_key", …)`, same for secret and webhook_secret. Stores a *placeholder* boolean `stripe_configured` in settings table for the UI to read without leaking secrets.
- `get_stripe_config() -> Result<StripeConfigStatus, String>` — returns `{ configured: bool, publishable_key_present: bool, secret_key_present: bool, webhook_secret_present: bool }` (never returns the secret values themselves).
- `delete_stripe_keys() -> Result<(), String>` — clears all three keychain entries and unsets `stripe_configured`.

All payment writes go through `sync::record_upsert("payments", id, cols)`.

### New Pi API routes

- `GET  /api/invoices/:id/payment` — returns latest payment record for invoice or `null`.
- `POST /api/invoices/:id/payment` — creates a new payment request. Body: `{}` (amount inferred from invoice.total). Returns the created Payment row.
- `POST /api/payments/:id/webhook` — placeholder route returning 501 Not Implemented until live Stripe is wired. Comment marker for the webhook signature check.

### Settings → Billing UI

Layout in SettingsView.tsx, new tab section "Billing":

```
┌─────────────────────────────────────────────────────┐
│ Stripe (Coming Soon)                                │
│                                                      │
│ Publishable Key  [ pk_test_ ............... ]   ◯   │
│ Secret Key       [ sk_test_ ............... ]   ◯   │
│ Webhook Secret   [ whsec_  ................ ]   ◯   │
│                                                      │
│ When keys are entered, you'll be able to request    │
│ payments from invoices and receive them via Stripe. │
│                                                      │
│ [ Save Keys ]    [ Clear Keys ]                     │
└─────────────────────────────────────────────────────┘
```

Inputs disabled / greyed and labelled "Coming soon" by default (controlled by a top-level "Enable Stripe (preview)" toggle). When enabled, inputs become editable. Keys masked after save (show only first/last 4 chars). Status indicator dots (◯) turn green ●  once the corresponding keychain entry is present (verified by `get_stripe_config`).

### Invoice detail "Request Payment" UI

In [InvoicesView.tsx](src/components/InvoicesView.tsx), the invoice detail block gains:
- **If no payment row exists for this invoice**: a button "Request Payment" (greyed out + tooltip "Configure Stripe in Settings → Billing" if `stripe_configured=false`).
- **If a payment row exists**: a `<PaymentBadge>` showing status — pending (amber), paid (emerald), failed (red), refunded (slate). Clicking opens a small popover with payment ID, created_at, error_message (if any), and "Refund" button (visible only when status=paid).

### Verification

1. Run migration 29 cleanly on a 0.11.0 DB (`SELECT name FROM sqlite_master WHERE name='payments'` returns one row).
2. From Invoices list, click "Request Payment" on a draft invoice → a payments row appears with status='pending', amount=invoice.total.
3. Status badge renders next to the invoice row and updates when `update_payment_status` is called.
4. From another device, observe the payment row appears via sync (replay the sync log).
5. Pi: `curl http://pi:8080/api/invoices/<id>/payment` with valid cookie returns the row.
6. `save_stripe_keys` stores values in keychain; `get_stripe_config` returns `{configured: true, …}` without exposing the keys themselves.
7. Search for the string `TODO(stripe)` in the codebase — every Stripe API call site is present and clearly marked.

---

## Feature 2 — Google Sheets Sync (enhanced with custom field mapping)

### Files

- [src-tauri/src/db.rs](src-tauri/src/db.rs) — migration 30 (custom_fields metadata)
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — extend `sync_from_sheet`, `get_sheet_sync_config`, `save_sheet_sync_config`; new `list_custom_fields` / `save_custom_field` / `delete_custom_field` commands; new `get_sheet_headers` command
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — invoke_handler additions
- [src/lib/api.ts](src/lib/api.ts) — extend SheetSyncConfig type, add CustomField type and methods
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — replace existing sheet sync UI with a column-mapping editor + new "Custom Fields" sub-tab

### Migration 30

```sql
-- Custom-field schema for client metadata (local-only — these are personal taxonomy).
CREATE TABLE IF NOT EXISTS custom_fields (
    id TEXT PRIMARY KEY,
    field_key TEXT UNIQUE NOT NULL,                 -- snake_case key used in metadata JSON
    label TEXT NOT NULL,                            -- display label shown on client profile
    field_type TEXT NOT NULL DEFAULT 'text'         -- 'text','number','date','boolean','dropdown'
        CHECK(field_type IN ('text','number','date','boolean','dropdown')),
    options_json TEXT,                              -- for 'dropdown' type
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

-- Extend sheet_sync_config with an arbitrary mapping JSON. Existing first_name_col etc. remain
-- for backwards compatibility; the new field is preferred when non-empty.
ALTER TABLE sheet_sync_config ADD COLUMN field_mapping_json TEXT NOT NULL DEFAULT '{}';
-- field_mapping_json shape: { "name": "A", "email": "B", "custom_loyalty_tier": "E", ... }
ALTER TABLE sheet_sync_config ADD COLUMN custom_field_mapping_json TEXT NOT NULL DEFAULT '{}';
-- custom_field_mapping_json: maps sheet column letter → custom_fields.field_key
ALTER TABLE sheet_sync_config ADD COLUMN write_back_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sheet_sync_config ADD COLUMN last_pushed_at TEXT;
```

### New Tauri commands

- `get_sheet_headers(sheet_url: String) -> Result<Vec<SheetHeader>, String>` — fetches row 1 of the sheet via the existing Google Sheets HTTP path used by `sync_from_sheet`; returns `[{column_letter:"A", header_text:"First Name"}, …]`. UI uses this to populate the left column of the mapping editor.
- `list_custom_fields() -> Result<Vec<CustomField>, String>`.
- `save_custom_field(input: CustomFieldInput) -> Result<CustomField, String>` — id optional (insert or update).
- `delete_custom_field(id: String) -> Result<(), String>` — removes the row; does **not** strip the key from existing clients' metadata (lossless).
- `reorder_custom_fields(ids: Vec<String>) -> Result<(), String>`.
- `push_to_sheet() -> Result<SheetPushResult, String>` — if `write_back_enabled=1`, reads all clients and writes back to the sheet via the same mapping. Result: `{ rows_updated, rows_skipped, errors }`.

### Conflict resolution

ClientHub-wins (per the user's spec, matches existing HLC LWW semantics). The Pi sync engine and desktop sync engine both already implement LWW per-column; this Sheets sync uses a simpler pattern: on each scheduled sync (every 10 min, [main.rs:144](src-tauri/src/main.rs:144)), pull rows from sheet *first*, then push ClientHub state back. The pull respects existing dedup-by-email-or-name in [csv_import.rs:165-189](src-tauri/src/csv_import.rs:165). The push overwrites the sheet cells with current ClientHub values.

### UI — Settings → Integrations → Google Sheets

Layout (Settings → Integrations → Google Sheets):

```
┌─ Google Sheets Sync ─────────────────────────────────────────────┐
│ Sheet URL    [ https://docs.google.com/spreadsheets/d/.../edit ] │
│ Skip rows    [ 1 ]    (header rows to skip)                       │
│                                                                    │
│ ┌─ Column Mapping ─────────────────────────────────────────────┐ │
│ │  YOUR SHEET HEADERS               CLIENTHUB FIELDS           │ │
│ │  ┌────────────────┐               ┌────────────────────────┐│ │
│ │  │ A: First Name  │ ───drag────→  │ first_name             ││ │
│ │  │ B: Last Name   │ ───drag────→  │ last_name              ││ │
│ │  │ C: Email       │ ───drag────→  │ email                  ││ │
│ │  │ D: Phone       │ ───drag────→  │ phone                  ││ │
│ │  │ E: Loyalty Tier│ ───drag────→  │ + Create custom field… ││ │
│ │  │ F: Last Order  │      ⊘        │ — skip —               ││ │
│ │  └────────────────┘               └────────────────────────┘│ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ ☐  Push ClientHub changes back to the sheet                       │
│                                                                    │
│ [ Test Mapping ]   [ Save & Sync Now ]                            │
└──────────────────────────────────────────────────────────────────┘
```

The mapping editor is also available as a dropdown (per row, instead of drag), accommodating users who don't want drag. "Create custom field" inline opens a small modal: label, key (auto-snake-cased from label), type (text/number/date/dropdown), options for dropdown.

### UI — Settings → Custom Fields (separate sub-tab)

Simple table:

```
┌─ Custom Fields ──────────────────────────────────────────────────┐
│  ↕  Label              Key                Type       Actions      │
│  ↕  Loyalty Tier       loyalty_tier       dropdown   [Edit][Del]  │
│  ↕  Birthday           birthday           date       [Edit][Del]  │
│  ↕  Sales Rep Notes    sales_rep_notes    text       [Edit][Del]  │
│                                                                    │
│  [ + Add Custom Field ]                                            │
└──────────────────────────────────────────────────────────────────┘
```

Drag (↕) handles reorder. Edit opens the same modal as the create flow. Delete asks for confirmation; tells the user existing metadata is preserved.

### Client profile rendering

In [ClientDetailView.tsx](src/components/ClientDetailView.tsx), after the existing fields block, render a "Custom Fields" panel listing all CustomFields with their current values pulled from `client.metadata[field_key]`. Each custom field is editable inline; saving updates `client.metadata` and triggers an `update_client` call.

### Verification

1. Migration 30 applies. `custom_fields` table exists.
2. Set a sheet URL → `get_sheet_headers` returns headers. Map two columns. Save. Verify `sheet_sync_config.field_mapping_json` is non-empty.
3. Create a custom field "Loyalty Tier" with dropdown options. Map sheet column E to it.
4. Manually trigger sync. Check that imported clients have `metadata.loyalty_tier` populated.
5. Edit a value on a client; with write_back enabled, manually trigger push. Verify the cell in the sheet updates.
6. Restart the app; mapping persists.
7. Conflict test: edit a value in ClientHub *and* the same cell in the sheet to different values; after the next periodic sync (10 min) the sheet shows ClientHub's value.

---

## Feature 3 — Invoice PDF Polish

### Current state read from [src-tauri/src/invoice.rs](src-tauri/src/invoice.rs):
- US Letter (215.9 × 279.4 mm); MARGIN_L = MARGIN_R = 20 mm; CONTENT_R = 195.9 mm.
- Logo box: LOGO_MAX_W=50mm, LOGO_MAX_H=25mm, LOGO_TOP=268mm.
- Font: Helvetica + HelveticaBold (already consistent).
- INVOICE title at (Mm(150), Mm(263)) at 28pt.
- Single page only; line items truncate at 60 chars at [invoice.rs:282-286](src-tauri/src/invoice.rs:282).
- Payment Options block sourced from `payment_methods` rows at [invoice.rs:468-481](src-tauri/src/invoice.rs:468) — already in footer.

### What the user wants vs current

| Requirement | Current | Needed |
|---|---|---|
| Logo top-left, max 200 px W × 80 px H, never stretched | 50 mm × 25 mm box, preserves aspect, never stretched | Convert to px: 200 px = 70.6 mm @ 72 DPI; 80 px = 28.2 mm. Update `LOGO_MAX_W=70.6`, `LOGO_MAX_H=28.2`. |
| No logo → business name large bold same position | Already renders company name + address as text fallback | Increase the no-logo fallback `company.name` from 12 pt to ~18 pt and place at logo's top edge |
| Single font family | Helvetica everywhere | No change |
| Column alignment: desc left / qty center / unit right / total right | All left | Change `use_text` x-coords for QTY/RATE/AMOUNT to right-anchor each cell |
| Subtotal/tax/total right-aligned, separated | Already right-aligned at x=150/178 | Already done — verify the horizontal divider above subtotal is bold enough (currently outline thickness 0.5 mm at [invoice.rs:206](src-tauri/src/invoice.rs:206)) |
| Payment instructions in footer from `payment_methods` | Done at [invoice.rs:340-359](src-tauri/src/invoice.rs:340) | No change |
| Diagonal "PAID" green watermark when status='paid' | Missing | Add 90 pt PAID text rotated 45° centered at page midpoint with green fill, semi-transparent |
| Diagonal "OVERDUE" red watermark when past due | Missing | Same pattern, red, when `due_date < today AND status NOT IN ('paid','draft','void')` |
| Page numbers if multi-page | Single page only | Implement pagination when line_items overflow |
| Exact dimensions specified | — | (Below) |

### Exact layout — page dimensions

| Element | x (mm from left) | y (mm from bottom) | size | weight |
|---|---|---|---|---|
| Logo bounding box | 20 | 268 (top edge) | up to 70.6 × 28.2 mm | preserve aspect ratio, max scale = 1.0 |
| Business name (no logo) | 20 | 268 | 18 pt | bold |
| Company name (below logo) | 20 | logo_bottom − 5 | 11 pt | bold |
| Company address | 20 | logo_bottom − 9 | 9 pt | regular |
| Company email | 20 | logo_bottom − 13 | 9 pt | regular |
| Company phone | 20 | logo_bottom − 17 | 9 pt | regular |
| "INVOICE" title | 150 | 263 | 28 pt | bold |
| "# <number>" | 150 | 255 | 11 pt | regular |
| Header divider line | 20→195.9 | header_bottom (computed) | 0.5 mm thickness | — |
| BILL TO label | 20 | divider_y − 8 | 9 pt | bold |
| Client name | 20 | divider_y − 14 | 11 pt | bold |
| Client company / address lines | 20 | step −5 each | 10 pt | regular |
| ISSUE DATE label | 140 | divider_y − 8 | 9 pt | bold |
| ISSUE DATE value | 140 | divider_y − 14 | 10 pt | regular |
| DUE DATE label | 170 | divider_y − 8 | 9 pt | bold |
| DUE DATE value | 170 | divider_y − 14 | 10 pt | regular |
| Line items header band | 20 → 195.9 | table_top + 2 → table_top − 5 | grey RGB 0.95/0.95/0.95 fill | — |
| DESCRIPTION header (left-anchored) | 22 | table_top − 2 | 9 pt | bold |
| QTY header (center-anchored at x=130) | 130 | table_top − 2 | 9 pt | bold |
| UNIT PRICE header (right-anchored at x=160) | 160 | table_top − 2 | 9 pt | bold |
| AMOUNT header (right-anchored at x=193) | 193 | table_top − 2 | 9 pt | bold |
| Line item row description (left) | 22 | row_y | 10 pt | regular |
| Line item qty (center at x=130) | 130 | row_y | 10 pt | regular |
| Line item unit price (right at x=160) | 160 | row_y | 10 pt | regular |
| Line item amount (right at x=193) | 193 | row_y | 10 pt | regular |
| Row height | — | 7 mm | — | — |
| Totals divider line | 120 → 195.9 | totals_y | 0.5 mm | — |
| "Subtotal" label | 150 | row_y | 10 pt | regular |
| Subtotal amount (right at x=193) | 193 | row_y | 10 pt | regular |
| "Tax" label / value | 150 / 193 | row_y −5 | 10 pt | regular |
| "TOTAL" label / value | 150 / 193 | row_y −12 | 12 pt | bold |
| Payment Options header | 20 | totals_block_bottom − 10 | 10 pt | bold |
| Payment method kind | 20 | step | 9 pt | bold |
| Payment method detail line | 25 | step −4 | 8 pt | regular |
| Notes header | 20 | payment_block_bottom − 8 | 9 pt | bold |
| Notes line | 25 | step −5 | 8 pt | regular |
| Footer "Thank you" | 20 | 18 | 9 pt | regular |
| Footer Tax ID | 20 | 13 | 8 pt | regular |
| Page-number `Page N of M` (multi-page only) | 195.9 (right-anchor) | 10 | 8 pt | regular |
| PAID watermark | center (108, 140) | — | 90 pt rotated 45° | bold, color RGB 0.2/0.7/0.3, alpha 0.18 |
| OVERDUE watermark | center (108, 140) | — | 90 pt rotated 45° | bold, color RGB 0.85/0.15/0.15, alpha 0.18 |

### Right-anchoring in printpdf

printpdf has no built-in right-align — you compute string width using the chosen font and subtract. Add a helper `text_right(layer, text, font, size_pt, right_x_mm, y_mm)` that uses `printpdf::BuiltinFont::get_width(...)` equivalent (printpdf 0.7's font metrics → compute width in points → convert to mm at 72 DPI). All right-anchored elements in the table above use this helper.

### Multi-page pagination

If `items.len()` * 7 mm of row space exceeds the available vertical region between `table_top` (≈ bill_top − 35) and 90 mm (where the totals + payment options + notes + footer need to fit), spill onto a second page:
- Continuation pages have the same header (logo + INVOICE title) at smaller scale: 50% size, top 50 mm reserved.
- Line items continue from y = page_top − 60. Same column geometry.
- Last page carries the totals, payment options, notes, footer.
- Page numbers: render `Page X of N` at (195.9, 10) on every page; right-anchored 8 pt.

### Watermark drawing

After all content is written, before saving:
- Compute orientation: `let rotate = if paid || overdue { Some(45.0) } else { None };`
- printpdf 0.7 does not directly support transparency on text — use `set_fill_color` with low-alpha approximation by setting the color to a light tint. A better implementation: render a large rectangle behind using `set_fill_color` with `Rgb { r, g, b, icc: None }` followed by setting the *text* color to a saturated tint matching the alpha intent. (The visible result is a soft pastel-colored stamp.)
- "PAID" if `status == 'paid'`. "OVERDUE" if `due_date < today AND status IN ('sent','overdue')`. Mutually exclusive; PAID wins.

### Files changing

- [src-tauri/src/invoice.rs](src-tauri/src/invoice.rs) — substantial rewrite of `build_pdf_bytes`. Introduce helpers `text_right`, `draw_watermark`, `paginate_line_items`. Update constants block.
- [src-tauri/src/commands.rs:generate_invoice_pdf](src-tauri/src/commands.rs) — no change to signature; pass `status` and `due_date` already available in invoice row.
- No DB migration needed.

### Verification

1. Generate a PDF for a draft invoice → no watermark, all columns aligned as specified.
2. Mark an invoice paid → re-generate PDF → green PAID stamp visible diagonally across the center.
3. Mark an invoice sent with `due_date` set to yesterday → red OVERDUE stamp visible.
4. Create an invoice with 60+ line items → PDF spans 2 pages, "Page 1 of 2" / "Page 2 of 2" rendered.
5. Logo path empty → business name renders large in the logo position.
6. Logo path set to a wide PNG (2000×500) → logo scales to fit 70.6 × 28.2 mm with correct aspect ratio.
7. Subtotal / Tax / Total all right-aligned at x=193 mm, visually inspected.
8. Payment Options block populates from active rows in `payment_methods`.

---

## Feature 4 — Bulk Client Actions

### Files

- [src/components/ClientsView.tsx](src/components/ClientsView.tsx) — checkbox column, bulk toolbar, selection state, bulk action handlers
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — extend `update_client_status` already exists; add `bulk_delete_clients`, `bulk_update_category`, `bulk_update_lead_status`, `export_clients_csv`
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register new commands
- [src/lib/api.ts](src/lib/api.ts) — new methods

### Migration

None.

### New Tauri commands

- `bulk_delete_clients(ids: Vec<String>) -> Result<u32, String>` — iterates, calls existing `delete_client` logic per row. Each row writes its own `sync::record_delete` event. Returns count deleted.
- `bulk_update_category(ids: Vec<String>, category: String) -> Result<u32, String>` — iterates, for each: reads metadata, sets `metadata.category`, calls `sync::record_upsert` and local UPDATE. Per-row sync events.
- `bulk_update_lead_status(ids: Vec<String>, lead_status: String) -> Result<u32, String>` — same pattern.
- `export_clients_csv(ids: Vec<String>, output_path: String) -> Result<u32, String>` — reads each client row + computes `total_revenue` and `last_contact_at`, writes CSV with columns: `name, company, email, phone, street_address, city, state, zip_code, category, lead_status, tier, total_revenue, last_contact_at`. Uses the `csv` crate already in Cargo.toml. The frontend will prompt the user with a save dialog (tauri-plugin-dialog `save`) before calling this command.

### UI

ClientsView additions:

```
┌─ Clients (153) ──────────────────── [+ New Client] ─┐
│ Filters: [Category ▾] [Status ▾] [State ▾] [Search…] │
├──────────────────────────────────────────────────────┤
│ ☐ Select all visible                                  │ ← header checkbox
├──────────────────────────────────────────────────────┤
│ ☑  Alice Co.        alice@…    Active    Wholesale  │
│ ☐  Bob Inc.         bob@…      Prospect  Retail     │
│ ☑  Carol LLC        carol@…    Active    Wholesale  │
│ ...                                                   │
└──────────────────────────────────────────────────────┘

When ≥1 selected, a sticky toolbar appears at top:
┌─ 47 clients selected ─────────── [✕ Clear] ──────────┐
│  [📧 Send Email] [🏷 Category ▾] [📊 Status ▾]        │
│  [⬇ Export CSV] [🗑 Delete]                            │
└──────────────────────────────────────────────────────┘
```

- Checkbox state held in `useState<Set<string>>` keyed by client id.
- "Select all visible" toggles every row currently rendered (respecting filters).
- "Send Email" → navigates to EmailView with `?recipients=ids,joined,by,comma` query, pre-populates the To list.
- "Category" and "Status" dropdowns open a small popover with the same options as the single-edit forms. On select, fire confirm dialog "Apply 'X' to 47 clients?" → invoke bulk command.
- "Export CSV" → opens Tauri save dialog → invokes `export_clients_csv` with chosen path.
- "Delete" → confirmation dialog with the count, requires typing "DELETE" for >10 clients.

### Verification

1. Select 3 clients, bulk-update category to "Wholesale" → each row updates locally and **3 separate sync events appear in the sync folder** (each `clients-<id>-...json`).
2. Export 5 selected clients → CSV opens correctly in Excel with the listed columns and computed total_revenue.
3. Bulk delete 3 clients → 3 tombstone events written; rows gone locally.
4. From a peer device, replay sync events → 3 deletions and 3 category updates land independently. (Per-row events satisfy "HLC sync events per client".)
5. Filter to Status=Prospect → "Select all visible" selects only filtered rows.
6. Empty selection → bulk toolbar hidden.

---

## Feature 5 — Client Import from Google Contacts

### Files

- [src-tauri/src/oauth_flow.rs](src-tauri/src/oauth_flow.rs) — extend to accept extra scopes (currently `https://mail.google.com/`); add `https://www.googleapis.com/auth/contacts.readonly` as an OR variant.
- New file `src-tauri/src/google_contacts.rs` — fetch contacts via Google People API
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — new commands: `google_contacts_oauth_start`, `google_contacts_list`, `google_contacts_import`
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register module + invoke_handler
- [src-tauri/src/email.rs:113-115](src-tauri/src/email.rs:113) — re-use keychain helpers for tokens (`gcontacts_oauth_refresh`, `gcontacts_oauth_client_id`, `gcontacts_oauth_client_secret`)
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — Data → Import tab gains second tab "From Google Contacts"

### Migration

None. Imported contacts go through existing `create_client` path; OAuth tokens live in keychain.

### Google People API endpoint
`GET https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,addresses&pageSize=1000` — already covered by `https://www.googleapis.com/auth/contacts.readonly`. Returns paginated `connections[]`.

### New Tauri commands

- `google_contacts_oauth_start() -> Result<(), String>` — invokes [oauth_flow::start_consent_flow](src-tauri/src/oauth_flow.rs) with the contacts-readonly scope. Stores tokens under `gcontacts_*` keychain keys (distinct from `oauth_refresh_token` used for Gmail).
- `google_contacts_list() -> Result<Vec<GoogleContact>, String>` — refreshes access token using stored refresh token, paginates People API. Returns `[{resource_name, name, email, phone, organization, street_address, city, state, zip_code}, …]`.
- `google_contacts_import(contacts: Vec<GoogleContact>) -> Result<ImportSummary, String>` — same dedupe-by-email-else-name logic as [csv_import.rs:165-189](src-tauri/src/csv_import.rs:165), same `sync::record_upsert("clients", …)` pattern. Returns `{imported, skipped, errors}` (re-uses existing `ImportSummary` struct from csv_import.rs).

### UI

Settings → Data → Import Clients (two tabs):

```
┌─ Import Clients ──────────────────────────────────────────┐
│  [ From CSV ] [ From Google Contacts ] ← tabs              │
├────────────────────────────────────────────────────────────┤
│  Google Contacts                                            │
│                                                             │
│  ◯ Not connected.   [ Connect Google Account ]              │
│  ● Connected as you@gmail.com.   [ Disconnect ]             │
│                                                             │
│  [ Fetch Contacts ]   (after connect)                       │
│                                                             │
│  ┌─ Contacts (847) ───────────────────────────────────────┐│
│  │ Search [ ……………… ]                          [Select All]││
│  │ ☑ Alice Anderson      alice@a.com    +1 555…  Acme    ││
│  │ ☑ Bob Bell            bob@b.io       +1 555…          ││
│  │ ☐ Carol Connor        carol@c.com    +1 555…  Cco     ││
│  │ ...                                                     ││
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  [ Import 547 selected ]                                    │
│                                                             │
│  Result: 532 imported, 13 skipped (duplicates), 2 failed    │
└────────────────────────────────────────────────────────────┘
```

Field mapping is **fixed** (per the user's spec): Full Name → name, Organization → company, Email → email, Phone → phone, Address → street_address/city/state/zip_code. Same fixed mapping is applied to every selected contact.

### Verification

1. Click "Connect Google Account" → browser opens → user consents to contacts scope → token saved in keychain.
2. Click "Fetch Contacts" → list of contacts renders, paginated through `nextPageToken`.
3. Search filter narrows the list client-side.
4. Select 10 contacts → "Import 10 selected" → result summary shows up to 10 imported (less if duplicates).
5. Verify in Clients list that imported entries have correct name, email, phone, company.
6. Existing email match is skipped (Bob Bell already exists with bob@b.io → skipped=1).
7. Disconnect button clears the three keychain entries; UI returns to "Not connected" state.

---

## Feature 6 — Email Template Variables

### Files

- New file `src-tauri/src/template.rs` — single `substitute_variables(template, client_id) -> Result<String>` function used by all email contexts
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — `send_newsletter` and the follow-up rule trigger and `send_email` (manual) call `template::substitute_variables` before sending
- [clienthub-api/src/scheduler.rs:142-145](../clienthub-api/src/scheduler.rs:142) — replace the hardcoded `{{first_name}}` replacement with a port of the full variable substitution
- [src/components/EmailView.tsx](src/components/EmailView.tsx) — add a "Insert Variable" toolbar button in the body and subject inputs
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — Follow-up rule editor gets the same Insert Variable button
- New file `src/components/VariablePicker.tsx` — shared component (popover with the list of variables)

### Migration

None. Variables read from existing clients/invoices tables.

### Variable resolution table (in `template.rs`)

| Token | Lookup | Empty string when |
|---|---|---|
| `{first_name}` | `client.name`, split on whitespace, take first | name is null/empty |
| `{full_name}` | `client.name` | null |
| `{company}` | `client.company` | null |
| `{city}` | `metadata.city` | not set |
| `{invoice_number}` | most recent invoice for client: `SELECT number FROM invoices WHERE client_id=?1 ORDER BY issue_date DESC LIMIT 1` | no invoices |
| `{amount_due}` | most recent unpaid: `SELECT total FROM invoices WHERE client_id=?1 AND status IN ('sent','overdue') ORDER BY issue_date DESC LIMIT 1`, formatted `$X,XXX.XX` | no unpaid |
| `{due_date}` | same row's `due_date` short-form YYYY-MM-DD | no unpaid |
| `{days_overdue}` | `JULIANDAY('now') - JULIANDAY(due_date)` of latest overdue, integer | not overdue |
| `{last_order_date}` | latest completed invoice's `issue_date` | none |
| `{tier}` | computed by existing `buyer_tier` logic (Diamond/Gold/Silver/Bronze/Prospect) | always returns a value |

Substitution is a simple regex `\{([a-z_]+)\}` (since `{` doesn't appear in normal email body text). Pi side mirrors the same regex and same SQL queries.

### UI — VariablePicker

Popover triggered by a "Variables ▾" button next to the body/subject textarea. Clicking a variable name inserts it at the current cursor position in the focused textarea. Each variable has a one-line description shown in the popover.

```
┌─ Insert Variable ──────────────────────────────┐
│  {first_name}        Client's first name        │
│  {full_name}         Client's full name         │
│  {company}           Company name               │
│  {city}              City                       │
│  {invoice_number}    Latest invoice number      │
│  {amount_due}        Latest unpaid total        │
│  {due_date}          Latest invoice due date    │
│  {days_overdue}      Days past due              │
│  {last_order_date}   Date of last completed inv │
│  {tier}              Buyer tier                 │
└─────────────────────────────────────────────────┘
```

### Backwards compat

The existing `{{first_name}}` (double-braces, used in newsletter scheduler at [clienthub-api/src/scheduler.rs:143](../clienthub-api/src/scheduler.rs:143)) must still work. The new function recognizes both `{first_name}` and `{{first_name}}` as the same token. Migrate stored newsletter templates to single-braces lazily — leave double-braces working forever.

### Verification

1. In a newsletter body, click Variables → click `{first_name}` → token inserted at cursor.
2. Send newsletter to a real client → received email shows the actual name.
3. Use `{amount_due}` for a client with one unpaid invoice → renders `$1,234.56`.
4. Use `{amount_due}` for a client with no unpaid invoices → renders empty string (not `{amount_due}`).
5. Use a typo variable like `{firstname}` (no underscore) → left untouched in output (visible to recipient — by design, so author notices).
6. Pi scheduler-driven send: schedule a newsletter through the Pi → variables resolve correctly.

---

## Feature 7 — Inventory Photos Display

### Current state read

`inventory` table has `photos_json TEXT NOT NULL DEFAULT '[]'` ([db.rs:551](src-tauri/src/db.rs:551)). API type `Lot` has `photos_json: string` field ([api.ts:624-637](src/lib/api.ts:624)). UI in [InventoryView.tsx](src/components/InventoryView.tsx) renders cards but does not display photos.

### Files

- [src/components/InventoryView.tsx](src/components/InventoryView.tsx) — major UI additions
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — extend `update_lot` to accept a `photos` array; ensure `create_lot` already takes `photos` (already in [api.ts:1042](src/lib/api.ts:1042))
- (Optional) tauri-plugin-fs read permission to display local image paths via custom protocol or convertFileSrc

### Migration

None.

### UI

**Lot card** (compact, in the inventory grid):

```
┌──────────────────────────┐
│ [thumbnail or icon]       │  ← 80×80 px square at top-right
│                            │
│ Lot name                   │
│ Category badge             │
│ Qty: 12   $3,200 / lot     │
│ Status: available          │
└──────────────────────────┘
```

If `photos_json` empty → render a `Image` icon from lucide-react (placeholder). Else render the first photo URL as background-cover.

**Lot detail / edit modal**:

```
┌─ Edit Lot ─────────────────────────────────────────────┐
│ Name        [ ………………………………… ]                          │
│ Description [ ………………………………………………… ]                    │
│ Category    [ ▾ ]   Quantity [ 12 ]                     │
│ Total cost  [ 1500 ]   Asking price [ 3200 ]            │
│ Status      [ ▾ available ]                             │
│                                                          │
│ ─── Photos ─────────────────────────────────────────────│
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                             │
│ │ 1✕ │ │ 2✕ │ │ 3✕ │ │ +  │   ← drag to reorder (1 = thumbnail) │
│ └────┘ └────┘ └────┘ └────┘                             │
│ (Click thumbnail to view full size in lightbox)         │
│                                                          │
│ [ Save ]   [ Cancel ]                                   │
└─────────────────────────────────────────────────────────┘
```

- Click a thumbnail → opens a full-screen lightbox showing the photo at native resolution. Arrow keys to navigate, Esc to close.
- `+` button → opens Tauri's `open` file dialog filtered to `png|jpg|jpeg|webp`, multi-select enabled. Selected paths appended to `photos_json`.
- `✕` on a thumbnail → removes that path from `photos_json` (does not delete the file from disk).
- Drag thumbnails to reorder. Persisted on save.

### How photos are referenced

Photos stored as **absolute paths** on the local filesystem. UI uses Tauri's `convertFileSrc()` ([@tauri-apps/api/core](https://docs.rs/tauri-apps-api/)) to render a `tauri://` URL the webview can load. This requires:
- `tauri.conf.json` already has `tauri-plugin-fs` enabled.
- Add an explicit `assetProtocol: { enable: true, scope: ["**"] }` to `tauri.conf.json` if not present.

Since photos are local-path-referenced, they are **device-specific**. Document this clearly in tooltip: "Photos are stored as paths on this device; other devices won't see them."

### Verification

1. Create a new lot, add 3 photos via the file picker → photos render in the modal, first is card thumbnail.
2. Drag photo #3 to position #1 → save → reopen the lot → photo #3 is now the card thumbnail.
3. Click a thumbnail → lightbox opens; arrow key advances; Esc closes.
4. Click ✕ on a thumbnail → photo removed; original file untouched.
5. Migrate a lot with empty photos → placeholder icon renders.

---

## Feature 8 — Enterprise Plan: Shared Business Portal

### Architecture overview

```
┌──── Company A ────┐                    ┌──── Company B ────┐
│  ClientHub.app    │                    │  ClientHub.app    │
│  (local SQLite)   │                    │  (local SQLite)   │
└──────┬────────────┘                    └────────┬──────────┘
       │ HTTPS                                     │ HTTPS
       │ (separate from HLC P2P sync)              │
       │                                           │
       ▼                                           ▼
┌──────────────────────────────────────────────────────────────┐
│              Cloud workspace server                           │
│  (Rust axum on yourdomain.com — NEW REPO `clienthub-cloud`)   │
│   • Auth: company creds (bcrypt password OR magic link)      │
│   • Tables: workspaces, workspace_members,                    │
│     shared_clients, shared_inventory, workspace_messages      │
│   • REST API + simple HTML/JS web portal at /workspace        │
└──────────────────────────────────────────────────────────────┘
```

This is a third codebase (not the desktop app or the Pi API). I'll call it `clienthub-cloud`. The desktop app talks to it over HTTPS; the Pi has no involvement.

### Database design

On the cloud server:

```sql
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,         -- 8-char alpha-numeric
    created_by TEXT NOT NULL,                 -- companies.id
    created_at TEXT NOT NULL
);

CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','member')) DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, company_id)
);

CREATE TABLE shared_clients (
    id TEXT PRIMARY KEY,                      -- cloud-side id
    workspace_id TEXT NOT NULL,
    source_company_id TEXT NOT NULL,
    source_client_id TEXT NOT NULL,           -- the local ClientHub id on the source company's machine
    name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    city TEXT,
    state TEXT,
    metadata_json TEXT,
    notes TEXT,
    shared_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_shared_clients_workspace ON shared_clients(workspace_id);

CREATE TABLE shared_inventory (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_company_id TEXT NOT NULL,
    source_lot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    quantity INTEGER NOT NULL,
    asking_price REAL NOT NULL,
    photos_json TEXT,                          -- URLs not paths — uploaded to cloud blob storage
    status TEXT NOT NULL DEFAULT 'available',
    shared_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_shared_inventory_workspace ON shared_inventory(workspace_id);

CREATE TABLE workspace_messages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    from_company_id TEXT NOT NULL,
    to_company_id TEXT,                        -- NULL = broadcast to all members
    content TEXT NOT NULL,
    referenced_inventory_id TEXT,              -- optional link to a shared_inventory row
    referenced_client_id TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
);
```

### Desktop changes

- [src-tauri/src/db.rs](src-tauri/src/db.rs) — migration 31:
  - ALTER `clients` ADD `is_shared INTEGER DEFAULT 0`, `workspace_id TEXT`
  - ALTER `inventory` ADD `is_shared INTEGER DEFAULT 0`, `workspace_id TEXT`
  - New `workspace_config` table (id PK 1, server_url, company_id, auth_token, workspace_id)

- New file `src-tauri/src/workspace.rs` — HTTP client that talks to clienthub-cloud:
  - `workspace_login(email, password) -> Result<AuthToken>`
  - `workspace_create(name) -> Result<{workspace_id, invite_code}>`
  - `workspace_join(invite_code) -> Result<workspace_id>`
  - `workspace_list_members() -> Result<Vec<Company>>`
  - `workspace_push_client(client_id) -> Result<()>` (called whenever a client's `is_shared` flag is set or its data changes)
  - `workspace_push_inventory(lot_id) -> Result<()>`
  - `workspace_pull() -> Result<{added_clients, added_inventory, new_messages}>` — periodic 60-s tick
  - `workspace_send_message(to_company_id, content, referenced_inventory_id) -> Result<()>`

- [src-tauri/src/main.rs](src-tauri/src/main.rs) — startup spawn: if `workspace_config` row exists, run `workspace_pull` every 60 s.
- New commands registered in `invoke_handler!`.

- New file `src/components/WorkspaceView.tsx` — new sidebar tab "Workspace":
  - Tabs: "Shared Inventory", "Shared Clients", "Messages", "Members".
  - Shared Inventory grid (similar to InventoryView but read-only for items from other companies).
  - Shared Clients list (similar to ClientsView).
  - Messages thread per partner company.
  - Members list with role.

- On ClientDetailView and InventoryView: add a "Share with Workspace" toggle (only visible when workspace is connected). Toggling on writes `is_shared=1` and calls `workspace_push_client`/`workspace_push_inventory`.

### Cloud `clienthub-cloud` REST API

(Brand-new repo. Same tech stack as Pi: axum + rusqlite. Hosted on a small VPS.)

- `POST /auth/signup` — `{name, email, password}` → `{company_id, token}`
- `POST /auth/login`  — `{email, password}` → `{company_id, token}`
- `POST /workspaces` — auth required → `{workspace_id, invite_code}`
- `POST /workspaces/join` — `{invite_code}` → `{workspace_id}`
- `GET  /workspaces/:id/members`
- `GET  /workspaces/:id/clients`
- `POST /workspaces/:id/clients` — push a client
- `GET  /workspaces/:id/inventory`
- `POST /workspaces/:id/inventory`
- `POST /workspaces/:id/inventory/:lot_id/photos` — photo upload (multipart)
- `GET  /workspaces/:id/messages`
- `POST /workspaces/:id/messages`

Auth: bearer token (JWT signed by cloud server's secret) in `Authorization: Bearer …` header. Tokens 30-day expiry.

### Web portal (at clienthub-cloud `/workspace`)

Plain server-side HTML + a small `app.js` for interactivity (like the existing Pi `www/`). Login page, then dashboard listing all workspaces the company belongs to, then a workspace view with the four tabs. Layout mirrors the desktop WorkspaceView but in a browser.

### How sharing/privacy works

- Default: every client and inventory lot has `is_shared=0`. Items are private.
- On ClientDetailView, a checkbox "Share with [Workspace Name]" toggles `is_shared`. On change, the row is pushed to the cloud (`workspace_push_client`) and marked `is_shared=1` locally. Un-checking calls a `workspace_remove_client` endpoint (DELETE on cloud).
- The cloud always stores the *source company id* and *source local id*, so a company can only edit/delete its own shared items.
- A "Read-only" badge appears on shared items from other companies.

### Verification

1. Two desktop installations on different machines, each registers a cloud account.
2. Company A creates a workspace → gets invite code.
3. Company B joins with that code → both appear in `workspace_list_members`.
4. Company A marks a client as shared → 60 s later it appears in Company B's WorkspaceView → Shared Clients tab.
5. Company A creates an inventory lot and shares it → appears in B's shared inventory.
6. Company B sends a message about that lot → appears in A's messages.
7. Cloud server is offline → desktop continues to function normally (workspace tab shows "disconnected" but everything else works).
8. Privacy: a non-shared client/lot is NEVER pushed to cloud (verified by inspecting cloud DB tables directly).

---

## Feature 9 — Auto-Backup Audit + Integrity Check

### Current state (read from source)

- WAL checkpoint runs before copy: ✅ [commands.rs:3061](src-tauri/src/commands.rs:3061) `PRAGMA wal_checkpoint(TRUNCATE)`.
- 30-day retention with pattern check: ✅ [commands.rs:3070-3083](src-tauri/src/commands.rs:3070). Pattern: `starts_with("clienthub-backup-") && ends_with(".db") && name.len() == 33`. 33 = len("clienthub-backup-YYYY-MM-DD.db") = 17 + 10 + 3 = 30. **Actually 30, not 33** — let me re-check: "clienthub-backup-" (17) + "YYYY-MM-DD" (10) + ".db" (3) = 30. But the code says `name.len() == 33`. Off-by-three.

  Wait — count again: `clienthub-backup-` is c,l,i,e,n,t,h,u,b,-,b,a,c,k,u,p,- = 17 chars. `2026-05-27` = 10 chars. `.db` = 3 chars. Total = 30. The code's `== 33` will **never match** the documented pattern. So the cleanup never runs. Bug.

- `pending_restore` flow: ✅ [db.rs:30-39](src-tauri/src/db.rs:30) checks for `clienthub.db.pending_restore`, copies it over `clienthub.db`, removes the staging file. Looks correct.
- Backup on startup if >23h: ✅ [main.rs:57-83](src-tauri/src/main.rs:57). Correct.
- Settings tab UI: in SettingsView.tsx — I did not read this section in full, but it presumably uses the `list_backups`, `backup_database`, `restore_database`, `get_backup_status` commands which all exist.

### Files

- [src-tauri/src/commands.rs:3075](src-tauri/src/commands.rs:3075) and [commands.rs:3102](src-tauri/src/commands.rs:3102) — **fix the `name.len() == 33` to `name.len() == 30`** in both `backup_database` cleanup and `list_backups`.
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — add `verify_backup_integrity(path: String) -> Result<bool, String>` command.
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — extend `BackupEntry` struct to include `is_valid: bool` and have `list_backups` populate it via `verify_backup_integrity`.
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — backup tab adds a red ⚠ icon on rows where `is_valid=false`, with a tooltip "Could not open this backup; restore may fail."

### Migration

None.

### Integrity check

`verify_backup_integrity(path)` opens the file as a SQLite database (`Connection::open`), runs `PRAGMA integrity_check` and verifies it returns the string "ok". Falls through to returning `false` if either open fails or integrity_check returns non-"ok".

Also runs `SELECT MAX(version) FROM schema_migrations` — if it's less than the *current* MIGRATIONS max (28), still returns `true` for *integrity* but the restore command should warn that the backup is from an older schema version.

### UI

```
┌─ Backup ────────────────────────────────────────────────────────┐
│ Last backup: 2026-05-26 03:00 UTC  (today at 3 AM)                │
│ Backup directory: /Users/jack/Documents/ClientHub Backups          │
│ [ Change… ]   [ Backup Now ]                                       │
│                                                                     │
│ ┌── Available backups ───────────────────────────────────────────┐│
│ │ 2026-05-26    18.4 MB    [Restore]                              ││
│ │ 2026-05-25    18.3 MB    [Restore]                              ││
│ │ 2026-05-24    18.3 MB    [Restore]                              ││
│ │ 2026-05-20  ⚠  17.9 MB    [Restore]   ← red warning icon        ││
│ │ ...                                                              ││
│ └─────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Verification

1. Backups older than 30 days are deleted on the next `backup_database` call (after the `name.len()` fix).
2. Manually corrupt a backup file (`echo > clienthub-backup-2026-05-20.db`) → `list_backups` returns `is_valid: false` for that row; UI shows the ⚠ icon.
3. Click Restore on a valid backup → app restarts (or user is asked to restart) → `pending_restore` swap happens on next startup → data matches the chosen backup.
4. Click Restore on a corrupted backup → confirmation dialog blocks the action with "This backup is corrupted and cannot be restored."
5. On startup with no prior backup, after the 10 s delay, a backup is created. `last_backup` updates.

---

## Feature 10 — Follow-Up Rule Enhancements

### Files

- [src-tauri/src/db.rs](src-tauri/src/db.rs) — migration 32 (tier_history) + extend `followup_rules` CHECK
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — `process_followup_rules` extended for new trigger types; `tier_history` tracker
- New file `src/components/AutomationLogView.tsx` + new sidebar tab
- [src/App.tsx](src/App.tsx) — add new tab "Automation Log"
- [src/components/EmailView.tsx](src/components/EmailView.tsx) — IMAP scan: if body lowercase contains "unsubscribe", set client's `metadata.newsletter_contact_frequency = 'never'`

### Migration 32

```sql
-- Tier history tracking — local-only since tiers are derived per-device.
CREATE TABLE IF NOT EXISTS tier_history (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    from_tier TEXT,
    to_tier TEXT NOT NULL,
    changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tier_history_client ON tier_history(client_id);

-- Extend followup_rules to support new triggers.
-- SQLite cannot ALTER a CHECK constraint, so we rebuild the table.
CREATE TABLE followup_rules_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN (
        'no_order','no_contact','overdue_invoice','stale_deal','tier_drop','birthday'
    )),
    trigger_value INTEGER NOT NULL DEFAULT 30,
    action_type TEXT NOT NULL CHECK(action_type IN ('email','reminder','both')),
    email_subject TEXT,
    email_body TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
INSERT INTO followup_rules_new SELECT * FROM followup_rules;
DROP TABLE followup_rules;
ALTER TABLE followup_rules_new RENAME TO followup_rules;
```

### Tier drop tracking

When `buyer_tiers` is computed (existing logic in [routes/clients.rs:526-637](../clienthub-api/src/routes/clients.rs:526) and equivalent desktop command), record any change vs. the previous computation. Approach: store the "current tier" snapshot in `metadata.buyer_tier`. On each `process_followup_rules` tick (every 6 h):
1. For each client, compute current tier.
2. If `metadata.buyer_tier` exists and differs from new value, insert a `tier_history` row.
3. Compare tier rank (Diamond > Gold > Silver > Bronze > Prospect). If new < old, this is a "tier drop" → fire matching `followup_rules` with trigger_type='tier_drop'.
4. Update `metadata.buyer_tier` to current value.

### Birthday trigger

New optional metadata field on clients: `metadata.birthday` (format YYYY-MM-DD, year optional → use MM-DD only). On each rules tick, for active `birthday` rules, find clients where `metadata.birthday` MM-DD matches today's MM-DD. Send the configured email.

### Per-category win rate (existing data uses deal_stage_history)

In `get_profit_forecast` ([commands.rs:3706](src-tauri/src/commands.rs:3706)), extend to compute per-category win rate by joining `deals.metadata.category` (or `deals → clients → metadata.category`) with the existing won/lost stage filter, grouped by category. Returns a new field `per_category_win_rate: Vec<{category, win_rate, sample_size}>`.

### Automation Log UI

New sidebar tab "Automation Log" between "Brief" and "Globe". Component `AutomationLogView.tsx`:

```
┌─ Automation Log ──────────────────────────────────────────────────┐
│ Rule [ All ▾ ]  Client [ Search… ]  Date [ Last 30 days ▾ ]        │
├────────────────────────────────────────────────────────────────────┤
│ Date     Time   Rule              Client       Action     Result   │
│ 05-26    14:23  Re-engage Stale   Alice Co.    email      ✓ sent   │
│ 05-26    14:23  Re-engage Stale   Bob Inc.     email      ✗ failed │
│ 05-25    09:00  Overdue Invoice   Carol LLC    reminder   ✓ logged │
│ 05-24    18:45  Birthday          Dan Co.      email      ✓ sent   │
│ ...                                                                 │
└────────────────────────────────────────────────────────────────────┘
```

Data source: existing `followup_log` table. New API: `get_followup_log_filtered(filter: {rule_id, client_id, since, until}) -> Vec<FollowUpLogEntry>` (or just paginate existing `get_followup_log`).

### Unsubscribe inbox detection

In `process_new_emails` ([email.rs:372](src-tauri/src/email.rs:372)), after known-client matching, check if `body_text.to_lowercase().contains("unsubscribe")` (full word match, regex `\bunsubscribe\b`). If yes, update that client's `metadata.newsletter_contact_frequency = "never"`. Log an interaction `kind='unsubscribe'`. Existing newsletter send paths must respect this flag — add the check to `send_newsletter` and the Pi scheduler's per-recipient loop.

### Verification

1. Migration 32 applies; old rules retained.
2. Create a rule of type `tier_drop` with email body "Sorry to see you go". Manually demote a client (set metadata.buyer_tier = 'Bronze' via DB tool when it should be 'Gold'). Trigger `process_followup_rules` → email sent, `followup_log` row + `tier_history` row created.
3. Add `metadata.birthday = '05-27'` to a client. Trigger `process_followup_rules` on 2026-05-27 → birthday email sent.
4. Send an email to your IMAP inbox with body "Please unsubscribe me". After next IMAP scan, the matching client's `metadata.newsletter_contact_frequency` is `"never"`. Subsequent newsletters skip them.
5. Automation Log tab shows all log entries with filters.
6. Profit forecast returns per-category win rates.

---

## Feature 11 — WhatsApp Business API (architecture only)

This is a *planning* deliverable — no implementation today.

### Data model

```sql
-- New migration (33 when this lands):
CREATE TABLE whatsapp_messages (
    id TEXT PRIMARY KEY,                        -- our id
    wa_message_id TEXT UNIQUE,                  -- WhatsApp's id (server-assigned)
    client_id TEXT,                             -- FK to clients
    phone_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    body TEXT NOT NULL,
    media_url TEXT,                             -- if image/file
    media_type TEXT,                            -- 'image','audio','video','document'
    status TEXT NOT NULL DEFAULT 'sent'         -- sent | delivered | read | failed
        CHECK(status IN ('sent','delivered','read','failed','received')),
    received_at TEXT,
    sent_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_wa_client ON whatsapp_messages(client_id);
CREATE INDEX idx_wa_phone ON whatsapp_messages(phone_number);
CREATE INDEX idx_wa_received ON whatsapp_messages(received_at);

-- Extend clients metadata.whatsapp_opt_in: bool (per WhatsApp's 24-hour conversation window rules)
-- Extend settings for WhatsApp config:
--   wa_business_id, wa_phone_number_id, wa_access_token (in keychain), wa_webhook_verify_token, wa_webhook_secret
```

### Interaction mapping

Map each WhatsApp message to the existing `interactions` table:
- `kind='whatsapp_in'` or `'whatsapp_out'`
- `subject = ''` (WA has no subject)
- `body = whatsapp_messages.body`
- `created_at = received_at OR sent_at`

The whatsapp_messages table is the canonical store; `interactions` is a denormalized projection for the unified client-history timeline view (already used by ClientDetailView).

### UI layout (WhatsApp inbox)

New sidebar tab "WhatsApp" between Email and Brief, gated by `settings.wa_configured = true`:

```
┌─ WhatsApp Inbox ────────────────────────────────────────────────────────────┐
│ ┌── Conversations ────────────┐  ┌── Thread: Alice Co. (+15551234567) ────┐│
│ │ 🟢 Alice Co.    2 min ago    │  │ Hi, do you have any electronics       ││
│ │    "Hi, do you have…"        │  │ lots available?                       ││
│ │ ⚪ Bob Inc.     1 hr ago     │  │                            10:14 ✓✓   ││
│ │ ⚪ Carol LLC    yesterday    │  │                                        ││
│ │ ...                          │  │ Yes — we have a mixed retail lot      ││
│ │                              │  │ at $2,400. Want details?              ││
│ │  [+ Start new conv]          │  │                            10:18 ✓✓✓  ││
│ └──────────────────────────────┘  │                                        ││
│                                   │ [ Type a message…                   ] ││
│                                   │ [📎] [Send]                            ││
│                                   └────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### Sending a message

A new Tauri command `wa_send_message(client_id, body, media_path: Option<String>) -> Result<()>`:
1. Look up `client.phone` (E.164 format required).
2. POST to `https://graph.facebook.com/v18.0/{wa_phone_number_id}/messages` with the WhatsApp Business Cloud API payload, using `wa_access_token` from keychain.
3. On success, insert a row into `whatsapp_messages` with the server-returned `wa_message_id`.
4. Mirror an `interactions` row with `kind='whatsapp_out'`.

### Receiving messages — webhooks

WhatsApp delivers inbound messages and status updates via webhook to a public URL. We need a public-facing endpoint:
- The Pi already has a public URL pattern (`/api/...`). Add a route on the Pi: `POST /api/whatsapp/webhook` and `GET /api/whatsapp/webhook` (for the one-time verify handshake).
- The Pi forwards inbound messages by writing rows into `whatsapp_messages` and a sync event so the desktop sees them.
- Webhook signature verification via `wa_webhook_secret`.

### What needs to happen before we can implement

1. Apply for a Facebook Business verification (legal entity, business website, certified bank info — multi-day process).
2. Create a Meta App, enable WhatsApp Business product, link a phone number that's *not* registered on personal WhatsApp.
3. Obtain `wa_access_token`, `wa_phone_number_id`, set up the webhook in Meta dashboard pointing at the Pi's public URL.
4. Comply with WhatsApp's 24-hour conversation window: outbound messages outside a conversation must use a pre-approved Message Template. Plan: store an `approved_template_id` setting and have `wa_send_message` use it when outside the window.

### Out-of-scope for this planning doc

- No code today. The Cargo.toml will need `reqwest` (already present).
- No Pi webhook code yet. The route signature and schema above is sufficient to wire it up later.

### Verification (when implemented)

Will require live WhatsApp Business API access — out of scope today.

---

## Feature 12 — Keyboard Shortcuts + Global Search

### Files

- [src/App.tsx](src/App.tsx) — global key handler already exists at [App.tsx:116-129](src/App.tsx:116) for "L" and "N"; extend with new shortcuts
- New file `src/components/CommandPalette.tsx` — VS-Code-style command palette / search overlay
- New file `src/components/ShortcutsModal.tsx` — modal showing all shortcuts
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — new `global_search(query: String) -> Result<GlobalSearchResults>` command
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register

### Global search command signature

```
global_search(query: String) -> Result<GlobalSearchResults, String>

GlobalSearchResults {
    clients: Vec<{ id, name, company, email }>,        // top 5
    invoices: Vec<{ id, number, client_name }>,        // top 5
    deals: Vec<{ id, title, client_name }>,            // top 5
    suppliers: Vec<{ id, name }>,                      // top 5
}
```

Implementation: 4 parallel SQL `LIKE %query%` searches with LIMIT 5 each.

### Shortcut map

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Open global search command palette |
| `Cmd/Ctrl + N` | New item — context-sensitive: ClientsView → new client modal; InvoicesView → new invoice modal; DealsView → new deal modal; SuppliersView → new supplier modal; InventoryView → new lot |
| `Cmd/Ctrl + S` | Save current open form (fire a `<form>.requestSubmit()` on the active form) |
| `Escape` | Close current modal (already handled per-modal; consolidate into a `useModalEscapeListener` hook) |
| `Cmd/Ctrl + ,` | Open Settings (`setTab('settings')`) |
| `?` | Show shortcuts help modal |
| `L` | QuickLog (already present, [App.tsx:118-122](src/App.tsx:118)) |

### Command palette layout

Triggered by Cmd/Ctrl+K, full-screen overlay:

```
┌─ Search ─────────────────────────────────────────────────────────┐
│ 🔍  alice                                                   ⌘K   │
├──────────────────────────────────────────────────────────────────┤
│  CLIENTS                                                          │
│    👤  Alice Anderson      alice@a.com   Acme Co.    →            │
│    👤  Alice Brown         alice@b.com   B Wholesale →            │
│                                                                    │
│  INVOICES                                                          │
│    📄  INV-2026-0042       Alice Anderson           →             │
│                                                                    │
│  DEALS                                                             │
│    💼  Q2 reorder          Alice Anderson           →             │
└──────────────────────────────────────────────────────────────────┘
```

- Up/Down arrows navigate.
- Enter selects the highlighted item — navigates the app to the relevant view and selects the item (`window.dispatchEvent(new CustomEvent('navigate-to-client', { detail: id }))` etc., following the existing `navigate-tab` event pattern at [App.tsx:111-115](src/App.tsx:111)).
- Esc or click outside closes.
- Debounce input by 150 ms.
- Empty query → shows recent items (last 5 visited from localStorage).

### Verification

1. Cmd+K opens palette anywhere in the app, even mid-form (form state preserved when closed).
2. Type "alice" → results render in <200 ms with 3 categories.
3. Arrow down + Enter → navigates to the selected client.
4. Cmd+N on InvoicesView → new invoice modal opens.
5. Cmd+S in any form → form submits.
6. `?` opens shortcuts help.
7. Esc closes the palette.
8. Cmd+, opens settings.

---

## Feature 13 — Export CSV/Excel for All Views

### Files

- [src-tauri/Cargo.toml](src-tauri/Cargo.toml) — add `rust_xlsxwriter = "0.77"` (`xlsx` crate per spec — `rust_xlsxwriter` is the maintained one)
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — new generic export module:
  - `export_clients_csv(filter: ClientFilter, path: String) -> Result<u32>`  *(reuses Feature 4's command)*
  - `export_invoices_csv(filter: {status, client_id, since, until}, path: String) -> Result<u32>`
  - `export_deals_csv(filter: {stage}, path: String) -> Result<u32>`
  - `export_deal_flows_csv(filter: {stage}, path: String) -> Result<u32>`
  - `export_inventory_csv(filter: {status}, path: String) -> Result<u32>`
  - `export_analytics_xlsx(path: String) -> Result<()>` — multi-sheet
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register
- Each list-view component gets an "Export ▾" button: ClientsView, InvoicesView, DealsView, DealFlowView, SuppliersView, InventoryView, CloseoutView, AnalyticsView

### Export respects current filters

Frontend always passes its current filter object to the export command — the export command runs the same SQL as the list query.

### Analytics Excel layout

```
Sheet 1: Summary
  A1: "ClientHub Analytics Export"
  A2: "Generated: 2026-05-27 14:23 UTC"
  A4: Section headers + key metrics from dashboard_stats:
     Total clients | Total invoices | Outstanding | Paid YTD | Pipeline value | Pipeline count

Sheet 2: Revenue by Month
  A1: month | revenue | cost | profit | margin_pct
  ... rows from dashboard_stats.monthly_profit

Sheet 3: Top Clients
  A1: name | company | invoice_count | total_spent | total_profit | margin_pct
  ... rows from dashboard_stats.top_spenders

Sheet 4: Deal Pipeline
  A1: stage | count | value
  ... rows from pipeline_analytics.funnel_counts joined with funnel_values
```

### Implementation notes

- CSV uses the existing `csv` crate.
- XLSX uses `rust_xlsxwriter`. Header rows in bold, currency columns formatted `$#,##0.00`.
- The frontend opens a Tauri save dialog (`tauri-plugin-dialog::save`) with a default filename `clienthub-clients-2026-05-27.csv` (or `.xlsx` for analytics).

### Verification

1. ClientsView → Export ▾ → CSV — opens dialog, save → file contains exactly the rows currently visible.
2. Apply a filter (Status=Prospect) → Export → CSV contains only those clients.
3. AnalyticsView → Export → Excel → file has 4 sheets with the expected data.
4. Opens cleanly in Excel + LibreOffice + Numbers without warnings.

---

## Feature 14 — Custom Invoice Numbering

### Files

- [src-tauri/src/db.rs](src-tauri/src/db.rs) — no migration needed (use existing `settings`)
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs):
  - Modify `create_invoice` to read `invoice_prefix`, `invoice_next_number`, `invoice_padding` from settings instead of the existing auto-increment scheme at [clienthub-api/src/routes/invoices.rs:74-91](../clienthub-api/src/routes/invoices.rs:74) (the desktop has its own implementation — read it carefully before changing; **I did not read the desktop's `create_invoice` in full above**, but the Pi version is shown).
  - New commands: `get_invoice_numbering_config() -> Result<{prefix, next_number, padding, preview}>` and `save_invoice_numbering_config({prefix, next_number, padding}) -> Result<()>`.
- [clienthub-api/src/routes/invoices.rs:74-91](../clienthub-api/src/routes/invoices.rs:74) — mirror the new logic on the Pi.
- [src/components/SettingsView.tsx](src/components/SettingsView.tsx) — new "Invoice Numbering" section under the Invoices tab in Settings.

### Settings keys (all stored in `settings` table)

- `invoice_prefix` (e.g. "INV-", "2026-", "ACME-"). Default: "INV-".
- `invoice_next_number` (e.g. 1000). Default: 1.
- `invoice_padding` (e.g. 4 → 0042). Default: 4.

### Number generation

When `create_invoice` runs:
1. Read the three settings.
2. Format: `{prefix}{next_number:0>{padding}}` → e.g. `INV-0043`.
3. Write `invoice_next_number = next_number + 1` back.
4. **Existing invoices are not renumbered**: the migration to the new scheme just starts at the current `invoice_next_number` value. Existing numbers like `INV-2026-0042` from the Pi's current year-based scheme are preserved untouched.

### UI

```
┌─ Invoice Numbering ─────────────────────────────────────────────┐
│ Prefix     [ INV- ]    (e.g. "INV-" or "2026-" or "ACME-")       │
│ Padding    [ 4 ]       (digits — 4 = "0042")                     │
│ Start at   [ 1000 ]    (next invoice number)                     │
│                                                                   │
│ Preview: Your next invoice will be: INV-1000                      │
│                                                                   │
│ [ Save ]                                                          │
└──────────────────────────────────────────────────────────────────┘
```

Preview updates live as the user types in any of the three fields.

### Verification

1. Save prefix="ACME-", padding=4, start=1000.
2. Create a new invoice → number is "ACME-1000".
3. Create another → "ACME-1001".
4. Old invoices retain their original numbers.
5. Change padding to 6 → next invoice is "ACME-001002" (i.e. `1002` padded to 6).

---

## Feature 15 — Recurring Invoice Templates

### Note: existing partial implementation

The current `invoices` table has `recurring` and `next_recurring_date` columns (migration 11). The desktop runs `generate_recurring_invoices` on startup ([main.rs:103](src-tauri/src/main.rs:103)). **I did not read the implementation in full** — there's already some recurring infrastructure. The user's spec describes a *separate* `recurring_invoices` table approach. The right call is to keep the existing column-based approach but layer a UI on top — *or* to introduce the new table for cleanliness. The user's spec says "new `recurring_invoices` table", so the plan below uses the new table approach and migrates existing recurring invoices to it.

### Files

- [src-tauri/src/db.rs](src-tauri/src/db.rs) — migration 33 (or 32 if Feature 10 is not in this batch; assume sequential numbering)
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs) — modify `generate_recurring_invoices`, add new CRUD commands
- [src-tauri/src/main.rs](src-tauri/src/main.rs) — register
- [src/components/InvoicesView.tsx](src/components/InvoicesView.tsx) — "Recurring" sub-tab
- New file `src/components/RecurringInvoicesView.tsx`

### Migration 33

```sql
CREATE TABLE recurring_invoices (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    template_name TEXT NOT NULL,
    line_items_json TEXT NOT NULL,
    tax_rate REAL NOT NULL DEFAULT 0,
    notes TEXT,
    payment_method_label TEXT,
    frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly')),
    next_due_date TEXT NOT NULL,                -- next date a draft will be auto-created
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id)
);
CREATE INDEX idx_recurring_next ON recurring_invoices(next_due_date, is_active);

-- Migrate existing recurring invoices into the new table.
INSERT INTO recurring_invoices (id, client_id, template_name, line_items_json, tax_rate,
                                notes, frequency, next_due_date, is_active, created_at, updated_at)
SELECT
    LOWER(HEX(RANDOMBLOB(16))),
    client_id,
    'Migrated from invoice ' || number,
    line_items_json,
    CASE WHEN total > 0 THEN tax / total ELSE 0 END,
    notes,
    CASE recurring WHEN 'weekly' THEN 'weekly'
                   WHEN 'monthly' THEN 'monthly'
                   WHEN 'quarterly' THEN 'quarterly'
                   ELSE 'monthly' END,
    next_recurring_date,
    1,
    created_at,
    issue_date
FROM invoices
WHERE recurring IS NOT NULL AND recurring <> '' AND next_recurring_date IS NOT NULL AND next_recurring_date <> '';

-- Clear the legacy columns once migrated (defer this — leave columns for one release for safety).
```

### New Tauri commands

- `list_recurring_invoices() -> Result<Vec<RecurringInvoice>>`
- `create_recurring_invoice(input) -> Result<String>` — input includes client_id, template_name, line_items, frequency, start_date
- `update_recurring_invoice(id, input) -> Result<()>`
- `pause_recurring_invoice(id) -> Result<()>` — sets `is_active=0`
- `resume_recurring_invoice(id) -> Result<()>` — sets `is_active=1`, also re-computes `next_due_date` if it's in the past
- `delete_recurring_invoice(id) -> Result<()>`

### Auto-creation flow (replaces existing `generate_recurring_invoices`)

On startup ([main.rs:103-107](src-tauri/src/main.rs:103)):
1. Query `SELECT * FROM recurring_invoices WHERE is_active=1 AND next_due_date <= date('now')`.
2. For each:
   - Create a new invoice via the standard `create_invoice` path with `status='draft'`, `issue_date=today`, `due_date=today+30days` (configurable per template later — for now hardcoded).
   - Update the recurring row: `next_due_date = today + frequency_days` (7/30/90).
3. Show a Tauri notification: "N recurring invoices created — review and send."

Drafts are never auto-sent. The notification + the Invoices view's existing Drafts filter handle the review step.

### UI — InvoicesView gains a "Recurring" sub-tab

```
┌─ Invoices ─ [ All ] [ Drafts ] [ Sent ] [ Paid ] [ Recurring ] ──┐
│                                                                    │
│  Recurring Templates (4 active, 1 paused)              [+ New ▾]   │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Template       Client        Frequency   Next Due    Actions  ││
│  │ Weekly Bagels  Alice Co.     weekly      2026-06-02  [Edit][⏸]││
│  │ Q1 Inventory   Bob Inc.      quarterly   2026-07-01  [Edit][⏸]││
│  │ Monthly Retainer Carol LLC   monthly     2026-06-15  [Edit][⏸]││
│  │ Pizza Friday   Dan Co.       weekly      paused      [Edit][▶]││
│  └──────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
```

The Create / Edit modal looks like the invoice editor minus dates (which are computed from frequency).

### Verification

1. Migration 33 applies cleanly; existing recurring invoices appear in the new table.
2. Create a recurring template with frequency=weekly, next_due=tomorrow.
3. Tomorrow on startup: a draft invoice is created from the template, the recurring template's `next_due_date` advances by 7 days, and a system notification fires.
4. Pause a template → no new drafts are created on its next_due.
5. Resume a template that has been paused for 3 months → next_due_date is bumped forward to the next valid future date (no backlog of 12 drafts).
6. Edit a template's line items → the change applies to future auto-created drafts only; the already-created drafts are unchanged.

---

## Feature interactions / shared infrastructure

- **Feature 6 (template variables)** is used by **Feature 10 (follow-up rules' email_body)** and **Feature 15's** template line items if templates use variables in description.
- **Feature 1 (Stripe)** depends on **Feature 4 (bulk actions)** only loosely — bulk "Request Payment" is a reasonable add-on once Stripe is wired, but not in the bare-bones scope.
- **Feature 13 (export)** is decoupled but **Feature 4's** `export_clients_csv` is the prototype.
- **Feature 8 (shared workspace)** is the largest piece and is independent of all others.
- The `users` table sync bug (see Phase 1 issue #3) is implicitly fixed by Feature 8's auth model on cloud OR explicitly by adding `"users"` to `ALLOWED_TABLES`.
