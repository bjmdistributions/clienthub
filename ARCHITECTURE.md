# Architecture

This is the canonical description of how ClientHub is structured. Read it before changing any module. The decisions here are **fixed** unless explicitly revisited by the human.

---

## High-level shape

```
┌─────────────────────────────────────────────────────────┐
│                  React UI (TypeScript)                   │
│  Dashboard │ Clients │ Invoices │ Email │ Settings       │
└──────────────────────┬──────────────────────────────────┘
                       │  Tauri invoke (typed via api.ts)
┌──────────────────────▼──────────────────────────────────┐
│              commands.rs (thin wrappers)                 │
└──┬─────────┬─────────┬──────────┬──────────┬────────────┘
   │         │         │          │          │
   ▼         ▼         ▼          ▼          ▼
┌──────┐ ┌──────┐ ┌─────────┐ ┌──────┐ ┌──────────────┐
│ db   │ │ sync │ │ email   │ │ ai   │ │ invoice (PDF)│
└──┬───┘ └──┬───┘ └────┬────┘ └──┬───┘ └──────┬───────┘
   │        │          │          │           │
   ▼        ▼          ▼          ▼           ▼
SQLite   sync/     SMTP/IMAP   Ollama     printpdf
        folder     + keychain  HTTP         (file)
```

Each device has its own SQLite. Devices share state by writing JSON event files to a folder that Syncthing replicates.

---

## Core invariants (do not violate)

### Invariant 1: All writes to synced tables go through the sync engine
Synced tables: `clients`, `interactions`, `invoices`, `settings`.

```rust
// CORRECT
sync::record_upsert("clients", &id, columns)?;  // writes event log + applies locally

// WRONG — silent data divergence between devices
conn.execute("UPDATE clients SET name=?1 WHERE id=?2", ...)?;
```

The pattern in `commands.rs` is: build a `serde_json::Map` of columns, call `sync::record_upsert`, then mirror the change via direct SQL for the local row. The direct SQL is needed because `sync::record_upsert` writes the event but the local apply path is independent — that's how peer events arrive too.

### Invariant 2: HLC monotonicity
`sync::now_hlc()` must produce strictly-increasing values within a single device. The implementation enforces this with a mutex over `HlcState`. Don't bypass it, don't manufacture HLCs by hand.

When applying a remote event, call `sync::observe_remote(event.hlc)` to keep the local clock ahead of any peer.

### Invariant 3: Tombstones win
A delete with HLC `H_d` invalidates any upsert with HLC `H_u <= H_d`. The check is in `sync::apply_event::Upsert` — it consults `tombstone_clock` before applying.

If you add a new synced table, you must respect this in any custom apply path. Better: don't add custom apply paths.

### Invariant 4: Secrets never hit disk in plaintext
Use `email::save_cred` / `cred` / `delete_cred`. The keychain implementation is platform-native (Keychain Access on macOS, Credential Manager on Windows).

Do not log credentials. Do not put them in error messages. Do not include them in panic messages. The `keyring` crate's errors are safe to log.

### Invariant 5: Migrations are append-only
`db::MIGRATIONS` is a const array. To change schema, **append a new migration**. Never edit migrations 1, 2, ... that have already shipped, even in development — devices that ran them won't re-run them.

---

## Module contracts

### `db.rs`

**Owns:** Database initialization, connection pool, migrations.

**Public API:**
- `init(app: &App) -> Result<()>` — called once from `main.rs::setup`
- `pool() -> &'static DbPool` — get a connection: `pool().get()?`
- `app_data_dir() -> &'static PathBuf` — for code that needs to write files near the DB

**Constraints:**
- WAL mode is required (concurrent reads during writes)
- Foreign keys must be ON
- Pool size 8 is calibrated for 3-device usage; don't reduce

### `sync.rs`

**Owns:** Event log, HLC clock, replay, file watcher, conflict resolution.

**Public API:**
- `init(sync_dir: PathBuf) -> Result<()>` — called once
- `record_upsert(table, row_id, columns)` — write event + apply locally
- `record_delete(table, row_id)` — write tombstone event
- `replay_all() -> Result<usize>` — scan sync folder, apply all events not already applied
- `start_watcher(rt) -> Result<()>` — react to peer events in real-time
- `now_hlc()` / `observe_remote(hlc)` — clock management

**Internals (don't depend on these from other modules):**
- `apply_event` — internal dispatcher
- `row_clocks` table — per-column LWW state
- `tombstones` table — delete markers
- `sync_meta` table — applied event IDs

### `email.rs`

**Owns:** SMTP send, IMAP scan, mail parsing, OAuth2, keychain.

**Public API:**
- `send(to, subject, body, attachment)` — SMTP send with optional PDF attachment
- `scan() -> Vec<ParsedEmail>` — pull new messages since last scan
- `spawn_periodic_scan(rt, interval_secs)` — background task
- `save_cred / cred / delete_cred` — keychain wrappers
- `EmailSettings` / `save_settings` / `load_settings` — non-secret email config

**Cred keys used (canonical names):**
- `smtp_user`, `smtp_pass`, `imap_pass`
- `oauth_client_id`, `oauth_client_secret`, `oauth_refresh_token`

**Constraints:**
- IMAP scan is incremental via `last_seen_uid` in settings — don't refetch all UIDs
- After matching emails to clients, fire-and-forget AI extraction (best-effort, must not block scan completion)
- Signup rules are checked **before** known-client matching

### `ai.rs`

**Owns:** Ollama integration.

**Public API:**
- `draft_reply(body, context) -> String`
- `extract_structured(body) -> Value` — JSON-mode, schema in the prompt
- `summarize_history(interactions) -> String`
- `suggest_invoice_items(description) -> Value`
- `health_check() -> bool`
- `list_models() -> Vec<TagModel>` / `set_model(name)`

**Constraints:**
- Default model: `llama3.1:8b` (changeable via Settings)
- Timeout: 120s
- Max retries: 2 with exponential backoff
- Context window: 8192 tokens
- All errors must surface as `anyhow::Error` to the command layer; UI shows them verbatim

### `invoice.rs`

**Owns:** PDF generation via `printpdf`, send-with-attachment helper.

**Public API:**
- `generate_pdf(invoice_id) -> String` (returns PDF path)
- `send_invoice(invoice_id)` — generates PDF if missing, sends email
- `compute_totals(items, tax_rate) -> (subtotal, tax, total)`
- `LineItem`, `CompanyInfo` types

**Constraints:**
- US Letter only for now (215.9mm × 279.4mm)
- Helvetica builtin (no font files to bundle)
- PDF path stored in `invoices.pdf_path` so peers see it after sync (paths are local but the column existence flags "PDF generated")

### `csv_import.rs`

**Owns:** CSV preview + import for Google Sheets exports.

**Public API:**
- `preview(path) -> CsvPreview` — first 5 rows + headers + total count
- `import(path, mapping) -> ImportSummary`

**Constraints:**
- Dedupe by email (case-insensitive)
- `name` field is required in the mapping; others optional
- Goes through `sync::record_upsert` per row

### `signup_rules.rs`

**Owns:** Pattern-matching incoming emails to auto-create clients.

**Public API:**
- `list_rules / create_rule / delete_rule / toggle_rule`
- `matches_any(from, subject) -> Option<rule_name>`
- `auto_create_client(email) -> client_id`

**Constraints:**
- Rules are local (not synced) — each device manages its own automation
- Both sender and subject patterns must match (AND semantics) when both are specified
- AI extraction is the only way client data is filled — no regex extraction of fields

### `commands.rs`

**Owns:** Tauri command handlers.

**Constraints:**
- Every handler returns `Result<T, String>` — `String` so it crosses the FFI cleanly
- Every write to a synced table calls `sync::record_*` first, then SQL
- New commands must be added to `main.rs::invoke_handler!`
- New commands must be added to `src/lib/api.ts` with matching types

### `main.rs`

**Owns:** Tauri builder, plugin registration, startup orchestration.

**Startup order (must not change):**
1. `db::init` — opens DB, runs migrations
2. `signup_rules::ensure_table` — depends on db
3. `sync::init` — depends on db (for node_id storage)
4. `sync::replay_all` — applies any events that arrived while offline
5. `sync::start_watcher` — real-time peer event reaction
6. `email::spawn_periodic_scan` — depends on db + sync (writes interactions)

---

## Database schema

```
clients(id PK, name, email, phone, company, notes, billing_status, created_at, updated_at)
interactions(id PK, client_id FK, kind, subject, body, created_at)
invoices(id PK, client_id FK, number UNIQUE, issue_date, due_date,
         line_items_json, subtotal, tax, total, status, pdf_path, sent_at, paid_at, created_at)
settings(key PK, value)
email_drafts(id PK, client_id, in_reply_to_message_id, to_addr, subject, body, status, created_at, sent_at)
signup_rules(id PK, name, sender_pattern, subject_pattern, active, created_at)

-- Sync internals (do not modify from outside sync.rs)
sync_meta(event_id PK, applied_at)
row_clocks(tbl, row_id, col, hlc_phys, hlc_log, hlc_node, PK(tbl,row_id,col))
tombstones(tbl, row_id, hlc_phys, hlc_log, hlc_node, PK(tbl,row_id))
schema_migrations(version PK, applied_at)
```

Synced tables: `clients`, `interactions`, `invoices`, `settings`.
Local-only tables: `email_drafts`, `signup_rules`, `sync_meta`, `row_clocks`, `tombstones`, `schema_migrations`.

---

## Frontend architecture

- **State:** Zustand store in `src/lib/store.ts` for cross-view state (clients list, AI online status). Per-view local state via `useState`.
- **API:** All backend calls go through `src/lib/api.ts`. No direct `invoke()` calls in components.
- **Components:** One view per file in `src/components/`. Subcomponents (forms, modals) live in the same file as their parent view. Don't cross-import between view files.
- **Styling:** Tailwind utilities only. No CSS modules, no styled-components.
- **Icons:** `lucide-react` only.

### View-to-feature map

| View | Backend modules touched |
|------|------------------------|
| `DashboardView` | `commands::dashboard_stats` only |
| `ClientsView` + `ClientDetailView` | `clients`, `interactions`, `ai_summarize_history` |
| `InvoicesView` | `invoices`, `ai_suggest_invoice`, `email::send` |
| `EmailView` | `email::scan`, `email::send`, `ai::draft_reply`, `ai::extract_structured` |
| `SettingsView` | `email_settings`, `company_info`, `csv_import`, `signup_rules`, `sync_status`, `keychain` |

---

## What's intentionally NOT in the architecture

These are decisions that have been considered and rejected. Don't reintroduce them without explicit approval.

- **No central server.** Sync is P2P via filesystem. Adding a server breaks the cost model.
- **No SaaS LLM (OpenAI, Anthropic).** Only local Ollama. Privacy + zero recurring cost.
- **No Electron.** Tauri's binary size + security model is the value prop.
- **No NoSQL.** SQLite is sufficient for 3-device scale and simplifies sync semantics.
- **No background daemon process.** Everything runs inside the Tauri app's own runtime.
- **No telemetry.** Local-first means local-only.
- **No web version.** Native installers only.
