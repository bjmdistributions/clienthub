# Architecture

Canonical description of ClientHub. Read before changing any module.

---

## Repos

| Repo | Role |
|------|------|
| `bjmdistributions/clienthub` | Tauri desktop app (Windows/macOS) |
| `bjmdistributions/clienthub-api` | Axum REST API (Raspberry Pi, port 8080) |

---

## Desktop — Tech Stack

- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, Zustand
- **Backend**: Tauri v2, rusqlite (r2d2 pool, WAL mode), 28 migrations
- **Sync**: HLC (hybrid logical clocks), event-log files in `app_data_dir/sync/`, ChaCha20-Poly1305 encryption, file watcher
- **Desktop-only features**: PDF generation (printpdf), IMAP inbox scan, Ollama AI, Globe.gl 3D view, geocoding (embedded US cities CSV)

---

## Database — 28 Migrations

Source: `src-tauri/src/db.rs:117-595`

**Tables**: clients, interactions, invoices, settings, email_drafts, payment_methods, device_state, line_item_templates, newsletters, newsletter_sends, categories, sheet_sync_config, sheet_sync_log, deals, deal_stage_history, deal_flows, suppliers, supplier_price_history, scheduled_sends, users, inventory, followup_rules, followup_log, client_portal_tokens

**Sync-engine internal tables**: sync_meta, row_clocks, tombstones, schema_migrations

**Synced via HLC** (ALLOWED_TABLES): clients, interactions, invoices, settings, payment_methods, deals, deal_flows, suppliers, scheduled_sends, users

**Local-only** (never propagated): email_drafts, newsletters, categories, sheet_sync, users (desktop-side), inventory, followup_rules, followup_log, client_portal_tokens, device_state

---

## React Components

Source: `src/components/*.tsx`, entry: `src/App.tsx`

`App.tsx` — sidebar nav (13 tabs gated by `canView(role,tab)`), dark mode, sync footer, UpdateNotification banner, OnboardingWizard/UserPicker guards

| Component | Purpose |
|-----------|---------|
| DashboardView | MTD/YTD stats, pipeline, monthly profit chart, top spenders, profit forecast card |
| ClientsView | Client list + filters, create/edit modal, opens ClientDetailView |
| ClientDetailView | Client profile, interactions, invoices, portal link generator |
| InvoicesView | Invoice CRUD, PDF preview, send, mark paid, costs, shipping |
| DealsView | Kanban board, drag stages, convert to invoice |
| DealFlowView | Lifecycle: invoiced → payment → supplier → complete |
| SuppliersView | Directory, price history, archive toggle |
| InventoryView | Lot board with status filters + Manifest Analyzer |
| CloseoutView | Completed deals |
| HealthView | Customer health table |
| TiersView | Buyer tier list (Diamond/Gold/Silver/Bronze/Prospect) |
| BriefView | Weekly brief with comparisons |
| AnalyticsView | Revenue-range chart, pipeline analytics |
| GlobeView | 3D globe plotting clients by lat/lng, geocode on first load |
| EmailView | Newsletter composer, send/schedule |
| SettingsView | 13 settings tabs (email, company, AI, sync, import, automation, payments, templates, sheets, splits, backup, team, categories) |
| OnboardingWizard | 5-step: welcome → business → email → CSV import → done |
| QuickLogModal | Press "L" → log interaction |
| UpdateNotification | Tauri auto-updater banner |

---

## Pi API

- **Server**: axum, binds `0.0.0.0:8080`
- **Auth**: JWT in HttpOnly cookie, 6-digit PIN (bcrypt), rate-limited (5 attempts / 15 min lockout)
- **DB access**: `Mutex<Connection>` (NOT r2d2 — non-reentrant lock)
- **Public routes**: `/api/health`, `/api/auth/*` (PIN setup/login/logout/status), `/api/portal/:token`, `/portal/:token` (portal HTML)
- **Protected routes**: clients, invoices, deals, deal flows, suppliers, dashboard, settings, newsletters, interactions — full CRUD
- **Background**: scheduler (60s tick for newsletter sends), sync (HLC event replay from shared folder)
- **Web UI**: `www/index.html` SPA — Dashboard, Clients, Invoices, Flows, Brief, News, Settings
- **Portal**: `www/portal.html` — client-facing invoice view
- **DB path**: default `/home/jack/clienthub-data/clienthub.db`, overridable via `CLIENTHUB_DB_PATH` env var

---

## Key Design Decisions

1. **Local-first sync**: HLC + event-log files, Syncthing for peer-to-peer, no central DB. The Pi API is a convenience server, not the source of truth.
2. **Desktop trust model**: No passwords. User selects a profile on launch. Permissions are frontend-gated (`canView`/`canEdit`/`canDelete` in `permissions.ts`).
3. **Backup**: Daily file copy with WAL checkpoint, 30-day retention, pending-restore recovery on startup.
4. **Auto-updater**: Checks GitHub Releases for newer version, downloads via Tauri updater plugin.
5. **Follow-ups**: Rules engine runs every 6 hours, triggers emails (SMTP) or creates reminders based on client behavior.

---

## Forward Path

The SaaS pivot is documented in `PHASE6_SAAS_PIVOT.md`. This covers: hosted server, account system, org model with roles, multiple SMTP profiles, Stripe webhook activation, Google Sheets API v4 OAuth, and migration from current desktop installs.

---

_Version: v0.11.0 — updated 2026-05-27 to reflect 28 migrations, 156 commands, and SaaS pivot plan._
