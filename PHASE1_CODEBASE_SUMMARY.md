# Phase 1 — Codebase Summary

Generated 2026-05-27. Read directly from source. Anything I could not find is flagged explicitly.

---

## Version

| Where | Value | Notes |
|---|---|---|
| `package.json` | **0.11.0** | canonical frontend version |
| `src-tauri/tauri.conf.json` | 0.11.0 | matches |
| `src-tauri/Cargo.toml` | **0.7.2** | **OUT OF SYNC — bug** |
| `clienthub-api/Cargo.toml` | 0.11.0 | matches |
| `ARCHITECTURE.md` | (undated) | **OUT OF DATE — documents only the original 7-table schema, not the current 28 migrations / suppliers / deals / deal_flows / inventory / portal / followups** |
| `DEPLOY.md` | (undated) | references TASK-001..007 which are not in the repo; deploy doc itself looks roughly current |

Tauri identifier: `com.bjmdistributions.clienthub`. Updater endpoint: `github.com/bjmdistributions/clienthub`.

---

## Database schema — all 28 migrations

Source: [src-tauri/src/db.rs](src-tauri/src/db.rs) lines 117-595.

### Migration 1 — base
- **clients**(id PK, name, email, phone, company, notes, billing_status DEFAULT 'active', created_at, updated_at)
- **interactions**(id PK, client_id FK→clients ON DELETE CASCADE, kind, subject, body, created_at)
- **invoices**(id PK, client_id FK→clients, number UNIQUE, issue_date, due_date, line_items_json, subtotal, tax DEFAULT 0, total, status DEFAULT 'draft', pdf_path, sent_at, paid_at, created_at)
- **settings**(key PK, value)
- Indexes: idx_interactions_client, idx_invoices_client, idx_invoices_status, idx_clients_email(LOWER)

### Migration 2 — email drafts
- **email_drafts**(id PK, client_id, in_reply_to_message_id, to_addr, subject, body, status DEFAULT 'pending', created_at, sent_at)

### Migration 3 — client metadata
- ALTER clients ADD metadata TEXT DEFAULT '{}'

### Migration 4 — payment methods
- **payment_methods**(id PK, kind, label, details DEFAULT '', active DEFAULT 1, sort_order DEFAULT 0)

### Migration 5 — invoice notes
- ALTER invoices ADD notes TEXT DEFAULT ''

### Migration 6 — device-local state (never synced)
- **device_state**(key PK, value)  — IMAP cursor, node_id, last_replay_cursor

### Migration 7 — lead pipeline
- ALTER clients ADD lead_status TEXT NOT NULL DEFAULT 'prospect'

### Migration 8 — payment details on invoices
- ALTER invoices ADD payment_method_label, payment_reference

### Migration 9 — perf indexes (idx_invoices_status_date, idx_interactions_client_date)

### Migration 10 — line item templates
- **line_item_templates**(id PK, description, rate, qty, sort_order)

### Migration 11 — recurring invoices
- ALTER invoices ADD recurring, next_recurring_date

### Migration 12 — newsletters
- **newsletters**(id PK, subject, body, status DEFAULT 'draft', recipient_count, sent_count, created_at, sent_at)
- **newsletter_sends**(id PK, newsletter_id FK, client_id, status DEFAULT 'pending', sent_at, error)

### Migration 13 — categories (local)
- **categories**(id PK, label, sort_order). Seeded with 9 defaults: Electronics, Clothing, General Merchandise, Toys, Shoes, Candy/Food/Drinks, Beauty/Cosmetics, OTHER, EVERYTHING.

### Migration 14 — Google Sheets sync (local)
- **sheet_sync_config**(id DEFAULT 1, sheet_url, name_col 'A', email_col 'B', phone_col 'C', company_col 'D', category_col 'E', skip_header_rows DEFAULT 1, last_synced_at, last_synced_count)
- **sheet_sync_log**(id PK, synced_at, new_clients, skipped_duplicates, errors)

### Migration 15 — sheet sync extra columns
- ALTER sheet_sync_config ADD first_name_col, last_name_col, lead_status_col, notes_col

### Migration 16 — invoice cost/profit
- ALTER invoices ADD cost_items_json, total_cost, profit, margin

### Migration 17 — deals pipeline
- **deals**(id PK, client_id, title, stage DEFAULT 'lead', line_items_json, supplier_costs_json, shipping_cost, other_costs, asking_price, payment_terms, notes, expected_close_date, created_at, updated_at, won_at, lost_at, lost_reason, converted_invoice_id, metadata)

### Migration 18 — invoice shipping
- ALTER invoices ADD carrier, tracking_number, shipping_charged, pickup_date, delivery_date, is_complete

### Migration 19 — deal stage history (local)
- **deal_stage_history**(id PK, deal_id FK, from_stage, to_stage, changed_at)

### Migration 20 — deal flows (synced)
- **deal_flows**(id PK, invoice_id, stage DEFAULT 'invoiced', payment_received_amount, payment_received_method, payment_received_at, supplier_payments_json, total_supplier_cost, completed_at, gross_revenue, total_cost, net_profit, profit_jack, profit_ben, profit_business, notes, created_at, updated_at)
- ALTER invoices ADD deal_flow_id, deal_flow_stage DEFAULT 'none'
- Stages: invoiced → payment_received → supplier_paid → complete

### Migration 21 — seed profit-split settings (40/30/30)

### Migration 22 — suppliers
- **suppliers**(id PK, name, contact_name, email, phone, address, payment_method, payment_details, payment_terms, typical_lead_time, notes, created_at, updated_at, archived DEFAULT 0, metadata)
- **supplier_price_history**(id PK, supplier_id FK, item_description, price, quantity, recorded_at, deal_flow_id, notes) — local-only
- ALTER deal_flows ADD metadata

### Migration 23 — ALTER deal_flows ADD name DEFAULT ''

### Migration 24 — scheduled sends (processed by Pi)
- **scheduled_sends**(id PK, newsletter_id, subject, body, attachment_path, scheduled_at, interval_seconds, total_recipients, recipients_json DEFAULT '[]', sent_count, failed_count, skipped_count, status DEFAULT 'pending', error, created_at)

### Migration 25 — users (local)
- **users**(id PK, name, email, role CHECK IN('owner','sales_rep','viewer') DEFAULT 'viewer', invite_code, is_active DEFAULT 1, created_at)
- ALTER interactions ADD user_name

### Migration 26 — inventory
- **inventory**(id PK, name, description, category, quantity DEFAULT 1, total_cost DEFAULT 0, asking_price DEFAULT 0, status CHECK IN('available','reserved','sold','archived') DEFAULT 'available', linked_deal_id, photos_json DEFAULT '[]', created_at, updated_at)

### Migration 27 — automation
- **followup_rules**(id PK, name, trigger_type CHECK IN('no_order','no_contact','overdue_invoice','stale_deal'), trigger_value DEFAULT 30, action_type CHECK IN('email','reminder','both'), email_subject, email_body, is_active DEFAULT 1, created_at)
- **followup_log**(id PK, rule_id, client_id, triggered_at, action_taken, details)

### Migration 28 — portal tokens
- **client_portal_tokens**(id PK, client_id FK→clients ON DELETE CASCADE, token UNIQUE, expires_at, is_active DEFAULT 1, created_at)

### Sync-engine internal tables (ensured at runtime by [sync.rs](src-tauri/src/sync.rs):168)
- **sync_meta**(event_id PK, applied_at)
- **row_clocks**(tbl, row_id, col, hlc_phys, hlc_log, hlc_node, PK(tbl,row_id,col))
- **tombstones**(tbl, row_id, hlc_phys, hlc_log, hlc_node, PK(tbl,row_id))
- **schema_migrations**(version PK, applied_at)

### Synced vs local tables

**Synced via HLC event log** (the `ALLOWED_TABLES` list at [sync.rs:362](src-tauri/src/sync.rs:362)):
`clients`, `interactions`, `invoices`, `settings`, `payment_methods`, `deals`, `deal_flows`, `suppliers`, `scheduled_sends`.

**Local-only** (never propagated to peers):
`email_drafts`, `signup_rules`, `device_state`, `line_item_templates`, `newsletters`, `newsletter_sends`, `categories`, `sheet_sync_config`, `sheet_sync_log`, `deal_stage_history`, `supplier_price_history`, `users`, `inventory`, `followup_rules`, `followup_log`, `client_portal_tokens`, `sync_meta`, `row_clocks`, `tombstones`, `schema_migrations`.

⚠ **`users` is local-only but `invite_user` and `claim_invite` and `remove_user` call `sync::record_upsert("users", ...)`** ([commands.rs:3197, 3224, 3248](src-tauri/src/commands.rs:3197)) — `users` is **not** in ALLOWED_TABLES, so these sync events will be **rejected** on peer apply with `anyhow::bail!("unknown table users")` at [sync.rs:373](src-tauri/src/sync.rs:373). This is a latent bug. Local writes still succeed; cross-device user sharing does not work.

⚠ Similar issue: `claim_invite` mismatch — the `for (key,value) in &pairs` loop in `save_profit_split` ([clienthub-api/src/routes/settings.rs:230](clienthub-api/src/routes/settings.rs:230)) records each profit-split key as a separate row in `settings` but synced as if `settings` were keyed by `row_id` of the setting key — works because `settings.key` IS the row id, but this only works because `settings` IS in ALLOWED_TABLES.

---

## Tauri commands (desktop backend → frontend invoke)

Source: invoke handler in [src-tauri/src/main.rs:178-380](src-tauri/src/main.rs:178). 156 commands total.

### Clients (11)
list_clients, get_client, create_client, update_client, update_client_status, delete_client, search_clients, list_stale_clients, due_followups, list_clients_filtered, clients_missing_info

### Interactions (2)
list_interactions, add_interaction

### Invoices (14)
list_invoices, get_invoice, list_invoices_for_client, create_invoice, update_invoice, delete_invoice, mark_overdue_invoices, generate_recurring_invoices, generate_invoice_pdf, preview_invoice_pdf, send_invoice, mark_invoice_paid, save_invoice_costs, save_invoice_shipping, set_invoice_sent_date, detect_duplicate_clients, cleanup_clients

### Deals (8)
list_deals, list_deals_by_stage, get_deal, create_deal, update_deal, update_deal_stage, delete_deal, convert_deal_to_invoice, supplier_name_suggestions

### Deal flows (17)
create_deal_flow, get_deal_flow_by_invoice, get_deal_flow, list_deal_flows, list_deal_flows_by_stage, mark_payment_received, unmark_payment_received, add_supplier_payment, update_supplier_payment, remove_supplier_payment, mark_supplier_payment_paid, unmark_supplier_payment_paid, complete_deal_flow, uncomplete_deal_flow, update_deal_completed_at, update_deal_flow_notes, update_deal_flow_name, delete_deal_flow

### Profit split (2)
get_profit_split, save_profit_split

### Suppliers (9)
list_suppliers, get_supplier, create_supplier, update_supplier, archive_supplier, delete_supplier, search_suppliers, get_supplier_price_history, record_supplier_price, check_price_changes, revert_supplier_price_change, get_deal_flow_node_map

### Customer health / tiers (4)
buyer_tiers, get_buyer_tier, generate_weekly_brief, pipeline_analytics

### Geocoding (2)
geocode_client, geocode_all_clients

### Email & AI (10)
send_email, scan_inbox, oauth_start_consent; ai_draft_reply, ai_extract_data, ai_suggest_invoice, ai_summarize_history, ai_health_check, ai_list_models, ai_set_model, ai_draft_newsletter

### Settings & creds (7)
save_credential, delete_credential, save_email_settings, get_email_settings, save_company_info, get_company_info, get_onboarding_status, complete_onboarding

### Backup (4)
backup_database, restore_database, list_backups, get_backup_status

### Users (8)
list_users, create_owner_user, invite_user, claim_invite, remove_user, update_user_role, get_current_user, set_current_user

### Inventory (5)
list_inventory, create_lot, update_lot, archive_lot, link_lot_to_deal

### Follow-up rules (7)
list_followup_rules, create_followup_rule, update_followup_rule, delete_followup_rule, toggle_followup_rule, process_followup_rules, get_followup_log

### Portal (3)
generate_portal_link, revoke_portal_link, list_portal_links

### Manifest, Forecast, Sync, Dashboard (12)
analyze_manifest; get_profit_forecast; sync_replay, sync_status, sync_set_passphrase, sync_is_encrypted; dashboard_stats, get_monthly_profit, get_analytics_range, list_deals_for_supplier

### CSV import (2)
csv_preview, csv_import

### Signup rules (4)
list_signup_rules, create_signup_rule, delete_signup_rule, toggle_signup_rule

### Payment methods (5), Line item templates (4), Email drafts (4)
list_/create_/update_/delete_/reorder_payment_methods, list_/create_/delete_/reorder_line_item_templates, list_drafts, update_draft, send_draft, discard_draft

### Newsletters (5) + Scheduled sends (7)
list_newsletters, save_newsletter, delete_newsletter, send_newsletter, ai_draft_newsletter; schedule_newsletter_send, cancel_scheduled_send, list_scheduled_sends, get_scheduled_send_progress, save_smtp_settings_for_pi, get_smtp_settings_for_pi

### Categories (5), Sheet sync (4)
list_/create_/update_/delete_/reorder_categories, get_sheet_sync_config, save_sheet_sync_config, sync_from_sheet, get_sheet_sync_log

⚠ **Commands declared in api.ts but not registered in invoke_handler**:
- `customer_health_scores`, `get_customer_health` — exported by [api.ts:886-887](src/lib/api.ts:886) but not in main.rs:178-380. Will fail at runtime if called.

---

## Pi REST API routes

Source: [clienthub-api/src/main.rs](../clienthub-api/src/main.rs) and `clienthub-api/src/routes/*`.

Server: axum, binds `0.0.0.0:8080`. Auth: JWT in HttpOnly cookie via 6-digit PIN, rate-limited 5 attempts / 15 min lockout per IP.

### Public (no auth)
- `GET  /api/health`
- `POST /api/auth/setup-pin`        body `{pin}` — only valid if no PIN set
- `POST /api/auth/login`            body `{pin}` → sets cookie
- `POST /api/auth/logout`
- `GET  /api/auth/status`
- `GET  /api/portal/:token`         → JSON for client portal page
- `GET  /portal/:token`             → serves www/portal.html
- `GET  /` (static) → serves www/ (mobile UI)

### Protected (cookie required)

**Clients** [routes/clients.rs:12](../clienthub-api/src/routes/clients.rs:12):
- `GET /api/clients` (query: search, lead_status, category, tag, state, missing, needs_review, stale_days)
- `POST /api/clients`, `GET/PUT/DELETE /api/clients/:id`
- `GET /api/clients/missing`, `GET /api/clients/tiers`
- `GET /api/clients/:id/health`, `PUT /api/clients/:id/status`
- `GET /api/clients/:id/interactions`, `GET /api/clients/:id/invoices`

**Interactions** [routes/interactions.rs](../clienthub-api/src/routes/interactions.rs):
- `GET /api/interactions/:client_id`, `POST /api/interactions`

**Invoices** [routes/invoices.rs:12](../clienthub-api/src/routes/invoices.rs:12):
- `GET /api/invoices` (query: status, client_id), `POST /api/invoices`
- `GET/PUT/DELETE /api/invoices/:id`
- `POST /api/invoices/mark-overdue`
- `POST /api/invoices/:id/pay`, `/costs`, `/shipping`, `/send`

**Deals** [routes/deals.rs:12](../clienthub-api/src/routes/deals.rs:12):
- `GET /api/deals` (query: stage, client_id), `POST /api/deals`
- `GET /api/deals/analytics`
- `GET/PUT/DELETE /api/deals/:id`, `PUT /api/deals/:id/stage`

**Deal flows** [routes/deal_flows.rs:13](../clienthub-api/src/routes/deal_flows.rs:13):
- `GET /api/deal-flows` (query: stage), `POST /api/deal-flows`
- `GET /api/deal-flows/invoice/:invoice_id`
- `GET/DELETE /api/deal-flows/:id`
- `PUT /api/deal-flows/:id/notes`, `/name`, `/completed-at`
- `POST /api/deal-flows/:id/mark-payment-received`, `/unmark-payment-received`
- `POST /api/deal-flows/:id/supplier-payments`
- `PUT/DELETE /api/deal-flows/:id/supplier-payments/:payment_id`
- `POST /api/deal-flows/:id/supplier-payments/:payment_id/mark-paid` and `/unmark-paid`
- `POST /api/deal-flows/:id/complete`, `/uncomplete`

**Suppliers** [routes/suppliers.rs:12](../clienthub-api/src/routes/suppliers.rs:12):
- `GET /api/suppliers` (query: search, archived), `POST /api/suppliers`
- `GET/PUT/DELETE /api/suppliers/:id`
- `PUT /api/suppliers/:id/archive`, `GET /api/suppliers/:id/price-history`

**Dashboard / Brief** [routes/dashboard.rs:12](../clienthub-api/src/routes/dashboard.rs:12):
- `GET /api/dashboard/stats`, `/health`, `/followups`, `/weekly-brief?date=YYYY-MM-DD`

**Settings** [routes/settings.rs:11](../clienthub-api/src/routes/settings.rs:11):
- `GET/PUT /api/settings/company`
- `GET /api/settings/categories`
- `GET/POST/PUT /api/settings/payment-methods` (and `:id` PUT/DELETE)
- `GET/PUT /api/settings/profit-split`

**Newsletters** [routes/newsletters.rs](../clienthub-api/src/routes/newsletters.rs):
- `GET /api/newsletters/scheduled` (query: status)
- `GET /api/newsletters/scheduled/:id`
- `PUT /api/newsletters/scheduled/:id/cancel`

**Pi background process**: scheduler ([scheduler.rs](../clienthub-api/src/scheduler.rs)) loops every 60 s, picks up rows from `scheduled_sends`, drip-sends per `interval_seconds`, writes `newsletter_sends` rows for each recipient, emits `status` change as a sync event.

**Pi auth invariants**: PIN stored as bcrypt hash in `settings.mobile_api_pin_hash`. JWT secret persisted at `/home/jack/clienthub-data/api-jwt-secret.txt` (auto-generated UUID if missing) ([auth.rs:18, 40-49](../clienthub-api/src/auth.rs:18)).

**Pi node_id**: persisted at `/home/jack/clienthub-data/api-node-id.txt` (base64 8 bytes) — sync events from the Pi participate in HLC just like desktop devices ([sync.rs:34](../clienthub-api/src/sync.rs:34)).

---

## React components

Source: `src/components/*.tsx` + `src/App.tsx`.

| File | What it renders |
|---|---|
| [App.tsx](src/App.tsx) | Shell: sidebar nav (13 tabs gated by `canView(role,tab)`), dark-mode toggle, sync footer, Ollama status, QuickLogModal trigger, UpdateNotification banner, hosts the OnboardingWizard or UserPicker before the main pane. Tab persisted in localStorage. |
| [DashboardView.tsx](src/components/DashboardView.tsx) | Hero stats (MTD / YTD / pipeline), monthly profit chart, top spenders, category breakdown, top suppliers — all from `dashboard_stats` |
| [ClientsView.tsx](src/components/ClientsView.tsx) | Client list + filters (category, lead status, state, stale, missing-info, needs-review) + create/edit modal; opens ClientDetailView |
| [ClientDetailView.tsx](src/components/ClientDetailView.tsx) | Client profile, interactions timeline, invoices list, edit form, **portal-link generator with hardcoded `http://pi:8080/portal/${token}` (Bug 4)** |
| [InvoicesView.tsx](src/components/InvoicesView.tsx) | Invoice list, create/edit with line items, preview PDF, send, mark paid, costs, shipping |
| [DealsView.tsx](src/components/DealsView.tsx) | Kanban-style deals board, drag between stages, convert to invoice |
| [DealFlowView.tsx](src/components/DealFlowView.tsx) | Lifecycle view (invoiced → payment_received → supplier_paid → complete), supplier payment matrix, profit-split breakdown |
| [SuppliersView.tsx](src/components/SuppliersView.tsx) | Supplier directory, price history, contact info, archive toggle |
| [InventoryView.tsx](src/components/InventoryView.tsx) | Lot board with status filters; photos_json read but **display not yet implemented well (Feature 7)** |
| [CloseoutView.tsx](src/components/CloseoutView.tsx) | Completed-deals view (deal_flows with stage='complete') |
| [HealthView.tsx](src/components/HealthView.tsx) | Customer health table (calls `customer_health_scores` which is **not registered as a Tauri command** — see warning above) |
| [TiersView.tsx](src/components/TiersView.tsx) | Buyer tier list (Diamond/Gold/Silver/Bronze/Prospect) |
| [TierBadge.tsx](src/components/TierBadge.tsx) | Small tier-colored badge component |
| [BriefView.tsx](src/components/BriefView.tsx) | Weekly brief with prev-week comparisons |
| [AnalyticsView.tsx](src/components/AnalyticsView.tsx) | Revenue-range chart, pipeline analytics |
| [GlobeView.tsx](src/components/GlobeView.tsx) | 3D Globe (`globe.gl`) plotting clients by lat/lng from `metadata.lat`/`metadata.lng`. Auto-runs `geocode_all_clients` on first load if 0 mapped. Loads `https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg` — **external network dependency** at runtime. |
| [EmailView.tsx](src/components/EmailView.tsx) | Newsletter composer, draft list, send/schedule |
| [SettingsView.tsx](src/components/SettingsView.tsx) | All settings tabs: email, company, AI model, payment methods, categories, signup rules, follow-up rules, sheet sync, users, sync passphrase, backup, profit split |
| [OnboardingWizard.tsx](src/components/OnboardingWizard.tsx) | 5-step wizard: welcome → business → email → CSV import → done. Creates owner user only if biz.user.trim() non-empty (line 104). |
| [QuickLogModal.tsx](src/components/QuickLogModal.tsx) | Press "L" anywhere → modal to log a quick interaction against a client |
| [UpdateNotification.tsx](src/components/UpdateNotification.tsx) | Tauri auto-updater banner |

UserPicker (defined inline in [App.tsx:332](src/App.tsx:332)) is shown when `currentUser === null` — relevant to Bug 1.

Mobile web UI: `clienthub-api/www/`: `index.html`, `portal.html`, `app.js`, `style.css` (not read in detail — out of scope for current features).

---

## Frontend libs

- [src/lib/api.ts](src/lib/api.ts) — single source of truth for `invoke()` calls and TypeScript types (1068 lines). Two stale entries: `customerHealthScores`, `getCustomerHealth` reference unregistered commands.
- [src/lib/store.ts](src/lib/store.ts) — Zustand store (aiOnline, checkAi). Not exhaustively read.
- [src/lib/format.ts](src/lib/format.ts) — fmtAmount helper.
- [src/lib/permissions.ts](src/lib/permissions.ts) — `canView(role, tab)` role-gating.

---

## Rust backend module map

| Module | Purpose |
|---|---|
| [main.rs](src-tauri/src/main.rs) | Tauri builder, startup orchestration, invoke_handler!, periodic timers (auto-backup, sync replay, mark-overdue, recurring invoices, IMAP scan every 5 min, sheet sync every 10 min, follow-up rules every 6 h, geocode_all on startup) |
| [db.rs](src-tauri/src/db.rs) | r2d2 pool, WAL mode, 28 migrations, pending-restore swap on startup, seeds 9 default categories |
| [sync.rs](src-tauri/src/sync.rs) | HLC, event-log files, replay, file watcher, per-column LWW, tombstones, encryption-aware (.enc.json) |
| [sync_crypto.rs](src-tauri/src/sync_crypto.rs) | ChaCha20-Poly1305, PBKDF2-HMAC-SHA256 100k iterations, salt in settings, passphrase in keychain |
| [commands.rs](src-tauri/src/commands.rs) | 6035 lines — all Tauri command handlers |
| [email.rs](src-tauri/src/email.rs) | SMTP send (lettre), IMAP scan via `spawn_blocking`, OAuth2 XOAUTH2, keychain cred helpers, signup-rule pipeline |
| [ai.rs](src-tauri/src/ai.rs) | Ollama HTTP at localhost:11434, models config in settings, retry 2× exp-backoff, 8192 ctx, draft_reply/extract_structured/summarize_history/suggest_invoice_items/draft_newsletter |
| [invoice.rs](src-tauri/src/invoice.rs) | printpdf PDF builder — Helvetica, US Letter, transparent-PNG flattening, payment methods footer, notes footer |
| [geocode.rs](src-tauri/src/geocode.rs) | Embeds `assets/uscities.csv` via `include_str!`, builds in-memory city/state→lat,lng map |
| [signup_rules.rs](src-tauri/src/signup_rules.rs) | Regex rules over From: + Subject:, AI extraction on match → auto-create client + log interaction |
| [csv_import.rs](src-tauri/src/csv_import.rs) | CSV preview + import with first/last/legacy name handling, dedupe by email else by name |
| [manifest.rs](src-tauri/src/manifest.rs) | Manifest CSV analyzer: keyword→category mapping, suggested-bid formula `total_retail × avg_margin% × 0.85` |
| [oauth_flow.rs](src-tauri/src/oauth_flow.rs) | Google OAuth2 PKCE-like with localhost tiny_http callback on ports 7777-7799, scope `https://mail.google.com/` |

Pi-side modules mirror desktop equivalents in spirit (sync.rs is a near-clone; same HLC, same ALLOWED_TABLES) but Pi has no rusqlite r2d2 pool — uses `Mutex<Connection>` ([db.rs:6](../clienthub-api/src/db.rs:6)).

---

## Immediately obvious issues / inconsistencies

1. **Version mismatch**: package.json/tauri.conf.json = 0.11.0, Cargo.toml = 0.7.2.
2. **ARCHITECTURE.md stale**: documents 7 tables, not 28. Says "no central server" but the Pi API server is exactly that for mobile/portal.
3. **`users` table sync attempts will fail silently**: see ⚠ note above ([commands.rs:3197, 3224, 3248](src-tauri/src/commands.rs:3197) calling sync into a table not in ALLOWED_TABLES at [sync.rs:362](src-tauri/src/sync.rs:362)).
4. **Two unregistered Tauri commands**: `customer_health_scores`, `get_customer_health` exist in [api.ts:886-887](src/lib/api.ts:886) but no `#[tauri::command]` in commands.rs and not in `invoke_handler!`. HealthView likely fails when opened.
5. **Hardcoded portal URL**: [ClientDetailView.tsx:200, 201, 205](src/components/ClientDetailView.tsx:200) build `http://pi:8080/portal/${token}` — no `portal_base_url` setting (Bug 4).
6. **Pi DB init order**: [clienthub-api/src/main.rs:27](../clienthub-api/src/main.rs:27) opens DB *before* creating the spaces-path symlink at lines 30-36. If symlink absent at startup, an empty DB is created at the env-var path (Bug 2 root).
7. **systemd service file in repo** ([clienthub-api/clienthub-api.service:10](../clienthub-api/clienthub-api.service:10)) sets `CLIENTHUB_DB_PATH=/home/jack/clienthub.db` (no spaces, no quotes), but the user reports the deployed unit uses the spaces path. The two are inconsistent.
8. **Globe's earth texture is fetched from unpkg.com** ([GlobeView.tsx:154-155](src/components/GlobeView.tsx:154)) — runtime CDN dependency; offline use breaks.
9. **No multi-page invoice PDF** ([invoice.rs](src-tauri/src/invoice.rs)) — line items truncated to 60 chars, ~30 fit on one page; longer invoices clip.
10. **`save_invoice_costs` recomputes profit/margin** on Pi side but the desktop has a separate path; risk of divergence if Pi computes one way and desktop another. (Skim only — not deeply verified.)
11. **OnboardingWizard does not require "Your name"**: pressing Next from step 1 only checks `biz.company.trim()` ([OnboardingWizard.tsx:278](src/components/OnboardingWizard.tsx:278)). `finish()` then only creates an owner user if `biz.user.trim()` is non-empty ([:104](src/components/OnboardingWizard.tsx:104)) — root path into Bug 1.
12. **No dedicated `scheduler.rs` on desktop**: follow-up scheduler logic is inlined in [main.rs:147-174](src-tauri/src/main.rs:147) calling `commands::process_followup_rules`. The user-supplied task list mentioned `scheduler.rs` for the desktop; it does not exist.
