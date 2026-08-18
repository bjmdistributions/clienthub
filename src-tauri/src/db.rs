//! Database initialization with versioned migrations.
//!
//! Uses WAL mode for better concurrent read performance.
//! Migrations are append-only; never edit existing ones.

use anyhow::{Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{App, Manager};

pub type DbPool = Pool<SqliteConnectionManager>;
static POOL: OnceLock<DbPool> = OnceLock::new();
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn pool() -> &'static DbPool {
    POOL.get().expect("DB pool not initialized")
}

pub fn app_data_dir() -> &'static PathBuf {
    APP_DATA_DIR.get().expect("app data dir not initialized")
}

/// Name of the pointer file (in the app-data ROOT) that records which per-account
/// store is active. Absent → the main account, whose store is the root itself
/// (the existing `clienthub.db` + `sync/`), byte-for-byte unchanged.
const ACTIVE_STORE_FILE: &str = "active_store";

/// Resolve the ACTIVE data-store directory under the app-data root.
///
/// Per-account isolation: each signed-in account gets its own store directory so
/// its local SQLite + sync folder never mix with another account's. The MAIN
/// account keeps the root directory itself (existing data untouched). A different
/// account is stored under `accounts/<key>/`.
///
/// The active store is chosen by the `active_store` pointer file in the root:
///   - missing / empty            → the root (main account) — the default for
///                                   every existing install, so nothing moves.
///   - a relative dir name (key)  → `<root>/accounts/<key>/` (a fresh account).
///
/// The pointer lives OUTSIDE any DB (a plain file) precisely because "which
/// account is active" cannot be read from a DB we haven't opened yet.
fn resolve_store_dir(root: &std::path::Path) -> PathBuf {
    let pointer = root.join(ACTIVE_STORE_FILE);
    let key = std::fs::read_to_string(&pointer)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match key {
        // Main account (or any install predating per-account stores): the root.
        None => root.to_path_buf(),
        // A specific account: an isolated subdirectory. `sanitize_store_key`
        // guarantees the key can't escape `accounts/`.
        Some(k) => root.join("accounts").join(sanitize_store_key(&k)),
    }
}

/// Keep a store key filesystem-safe and confined to a single path component (no
/// separators / traversal). Used when routing an account to `accounts/<key>/`.
pub fn sanitize_store_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() { "default".to_string() } else { trimmed.to_string() }
}

/// Marker file (inside a store dir) recording which org owns that store. Written
/// the first time an org occupies a store; used to decide whether a signing-in
/// account belongs here or needs its own store.
const STORE_ORG_FILE: &str = "store_org";

/// The app-data ROOT (parent of all per-account stores). Distinct from
/// `app_data_dir()`, which returns the ACTIVE store dir (root or a subdir).
static APP_ROOT_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn app_root_dir() -> &'static PathBuf {
    APP_ROOT_DIR.get().expect("app root dir not initialized")
}

/// The org id that owns the ACTIVE store, if recorded yet (None on a brand-new
/// empty store that no account has claimed).
pub fn active_store_org() -> Option<String> {
    std::fs::read_to_string(app_data_dir().join(STORE_ORG_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Record which org owns the ACTIVE store (idempotent; only writes if unset). Call
/// once an account is confirmed to belong to this store so future logins can tell
/// whether they match.
pub fn claim_active_store_org(org_id: &str) {
    if org_id.trim().is_empty() { return; }
    let marker = app_data_dir().join(STORE_ORG_FILE);
    if !marker.exists() {
        let _ = std::fs::write(&marker, org_id.trim());
    }
}

/// Point the app at the store for `org_id` (relative to the root) and return the
/// store key written to the pointer. Empty pointer (root) is used for the org that
/// already owns the root store; otherwise `accounts/<org_id>/`. Does NOT move data
/// and does NOT restart — the caller restarts so `init` re-runs cleanly.
pub fn set_active_store_for_org(org_id: &str) -> Result<()> {
    let root = app_root_dir();
    let pointer = root.join(ACTIVE_STORE_FILE);
    // If the root store is unclaimed or already owned by this org, use the root.
    let root_org = std::fs::read_to_string(root.join(STORE_ORG_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let use_root = match &root_org {
        None => true,                       // root not yet claimed → this org takes it
        Some(o) => o == org_id.trim(),      // root already this org → stay
    };
    if use_root {
        // Empty/absent pointer means "root store".
        let _ = std::fs::remove_file(&pointer);
    } else {
        let key = sanitize_store_key(org_id);
        std::fs::write(&pointer, &key).context("write active_store pointer")?;
    }
    Ok(())
}

pub fn init(app: &App) -> Result<()> {
    let root = app.path().app_data_dir().context("app_data_dir")?;
    std::fs::create_dir_all(&root)?;
    APP_ROOT_DIR.set(root.clone()).ok();
    // The active store may be the root (main account) or a per-account subdir.
    let dir = resolve_store_dir(&root);
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("clienthub.db");

    // Pending restore: if a restore was staged, swap it in before opening the DB
    let pending = dir.join("clienthub.db.pending_restore");
    if pending.exists() {
        if std::fs::copy(&pending, &db_path).is_ok() {
            tracing::info!("restored database from pending restore file");
        } else {
            tracing::warn!("pending restore file corrupted, keeping existing database");
        }
        let _ = std::fs::remove_file(&pending);
    }

    APP_DATA_DIR.set(dir.clone()).ok();

    let manager = SqliteConnectionManager::file(&db_path).with_init(|c| {
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=MEMORY;",
        )
    });
    let pool = Pool::builder()
        .max_size(8)
        .build(manager)
        .context("build pool")?;

    {
        let conn = pool.get()?;
        run_migrations(&conn)?;
        seed_defaults(&conn)?;

        // Claim the ROOT store for the main workspace on existing installs. If this
        // is the root store, has no owner marker yet, but already holds real data
        // (accounts or clients), it's the pre-existing main account's store — stamp
        // it `org_default` so a DIFFERENT account signing in later is routed to its
        // own store instead of mixing into this one. A genuinely fresh install has
        // no such rows, stays unclaimed, and is claimed by whoever first signs in.
        if dir == root && !dir.join(STORE_ORG_FILE).exists() {
            let has_data: bool = conn
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM staff_accounts) + (SELECT COUNT(*) FROM clients)",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            if has_data {
                let _ = std::fs::write(dir.join(STORE_ORG_FILE), "org_default");
                tracing::info!("claimed root data store for org_default (existing install)");
            }
        }
    }

    POOL.set(pool).ok();
    Ok(())
}

fn run_migrations(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
         )",
        [],
    )?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    for (version, sql) in MIGRATIONS.iter() {
        if (*version as i64) > current {
            tracing::info!("running migration {}", version);
            // Run each statement individually so a benign, already-applied change
            // (e.g. a column that exists from a different build lineage) doesn't
            // abort the whole migration — and, via the old code path, the app.
            //
            // The split is naive. A ';' anywhere in a migration body — including
            // inside a `--` comment or a quoted literal — starts a new fragment,
            // and the leftover text is not valid SQL, which is not a benign error.
            // Migration 21 carried one from v0.15.14 to v0.15.143 and no fresh
            // database could get past it. Never put a ';' in a migration comment.
            for stmt in sql.split(';') {
                let trimmed = stmt.trim();
                if trimmed.is_empty() { continue; }
                if let Err(e) = conn.execute_batch(trimmed) {
                    if is_benign_migration_error(&e) {
                        tracing::warn!("migration {}: skipping benign error: {}", version, e);
                        continue;
                    }
                    return Err(e).with_context(|| format!("migration {}", version));
                }
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![*version as i64, chrono::Utc::now().to_rfc3339()],
            )?;
        }
    }
    Ok(())
}

/// True for migration errors that mean "this change is already present" — safe
/// to skip so a machine with a slightly different schema history still launches.
fn is_benign_migration_error(e: &rusqlite::Error) -> bool {
    let m = e.to_string().to_lowercase();
    m.contains("duplicate column name")
        || m.contains("already exists")
        || m.contains("duplicate column")
        || m.contains("no such table")
}

fn seed_defaults(conn: &rusqlite::Connection) -> Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM categories", [], |r| r.get(0),
    ).unwrap_or(0);
    if count == 0 {
        let defaults = [
            "Electronics", "Clothing", "General Merchandise", "Toys",
            "Shoes", "Candy/Food/Drinks", "Beauty/Cosmetics", "OTHER", "EVERYTHING",
        ];
        for (i, label) in defaults.iter().enumerate() {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO categories (id, label, sort_order) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, label, i as i64],
            )?;
        }
        tracing::info!("seeded {} default categories", defaults.len());
    }
    Ok(())
}

const MIGRATIONS: &[(u32, &str)] = &[
    (
        1,
        r#"
        CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            company TEXT,
            notes TEXT,
            billing_status TEXT DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interactions (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            subject TEXT,
            body TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS invoices (
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
            FOREIGN KEY (client_id) REFERENCES clients(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_interactions_client ON interactions(client_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
        CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(LOWER(email));
        "#,
    ),
    (
        2,
        r#"
        -- Add email_drafts table for AI-generated replies awaiting human review.
        CREATE TABLE IF NOT EXISTS email_drafts (
            id TEXT PRIMARY KEY,
            client_id TEXT,
            in_reply_to_message_id TEXT,
            to_addr TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|discarded
            created_at TEXT NOT NULL,
            sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_drafts_status ON email_drafts(status);
        "#,
    ),
    (
        3,
        r#"
        -- Add metadata JSON column for extended client fields (lead form, buy categories, etc.)
        ALTER TABLE clients ADD COLUMN metadata TEXT DEFAULT '{}';
        "#,
    ),
    (
        4,
        r#"
        -- Payment methods shown on invoice footers. Synced across devices.
        CREATE TABLE IF NOT EXISTS payment_methods (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        "#,
    ),
    (
        5,
        r#"
        -- Add notes column to invoices for shipping notes, terms, etc.
        ALTER TABLE invoices ADD COLUMN notes TEXT DEFAULT '';
        "#,
    ),
    (
        6,
        r#"
        -- Device-local state that must never sync (IMAP cursor, node ID, etc.)
        CREATE TABLE IF NOT EXISTS device_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    ),
    (
        7,
        r#"
        -- Client pipeline: prospect, hot_lead, warm, active_customer, inactive
        ALTER TABLE clients ADD COLUMN lead_status TEXT NOT NULL DEFAULT 'prospect';
        "#,
    ),
    (
        8,
        r#"
        -- Payment details when marking an invoice as paid
        ALTER TABLE invoices ADD COLUMN payment_method_label TEXT DEFAULT '';
        ALTER TABLE invoices ADD COLUMN payment_reference TEXT DEFAULT '';
        "#,
    ),
    (
        9,
        r#"
        -- Performance indexes for common query patterns
        CREATE INDEX IF NOT EXISTS idx_invoices_status_date ON invoices(status, issue_date);
        CREATE INDEX IF NOT EXISTS idx_interactions_client_date ON interactions(client_id, created_at);
        "#,
    ),
    (
        10,
        r#"
        -- Premade line item templates for quick invoice creation. Local-only.
        CREATE TABLE IF NOT EXISTS line_item_templates (
            id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            rate REAL NOT NULL DEFAULT 0,
            qty REAL NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        "#,
    ),
    (
        11,
        r#"
        -- Recurring invoice support
        ALTER TABLE invoices ADD COLUMN recurring TEXT DEFAULT '';
        ALTER TABLE invoices ADD COLUMN next_recurring_date TEXT DEFAULT '';
        "#,
    ),
    (
        12,
        r#"
        -- Newsletter support (local-only, not synced)
        CREATE TABLE IF NOT EXISTS newsletters (
            id TEXT PRIMARY KEY,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            recipient_count INTEGER DEFAULT 0,
            sent_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            sent_at TEXT
        );
        CREATE TABLE IF NOT EXISTS newsletter_sends (
            id TEXT PRIMARY KEY,
            newsletter_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            sent_at TEXT,
            error TEXT,
            FOREIGN KEY (newsletter_id) REFERENCES newsletters(id)
        );
        "#,
    ),
    (
        13,
        r#"
        -- Manageable category labels for clients (local-only, not synced)
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        "#,
    ),
    (
        14,
        r#"
        -- Google Sheets sync config & log (local-only, not synced)
        CREATE TABLE IF NOT EXISTS sheet_sync_config (
            id INTEGER PRIMARY KEY DEFAULT 1,
            sheet_url TEXT,
            name_col TEXT DEFAULT 'A',
            email_col TEXT DEFAULT 'B',
            phone_col TEXT DEFAULT 'C',
            company_col TEXT DEFAULT 'D',
            category_col TEXT DEFAULT 'E',
            skip_header_rows INTEGER DEFAULT 1,
            last_synced_at TEXT,
            last_synced_count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sheet_sync_log (
            id TEXT PRIMARY KEY,
            synced_at TEXT NOT NULL,
            new_clients INTEGER DEFAULT 0,
            skipped_duplicates INTEGER DEFAULT 0,
            errors TEXT
        );
        "#,
    ),
    (
        15,
        r#"
        ALTER TABLE sheet_sync_config ADD COLUMN first_name_col TEXT DEFAULT '';
        ALTER TABLE sheet_sync_config ADD COLUMN last_name_col TEXT DEFAULT '';
        ALTER TABLE sheet_sync_config ADD COLUMN lead_status_col TEXT DEFAULT '';
        ALTER TABLE sheet_sync_config ADD COLUMN notes_col TEXT DEFAULT '';
        "#,
    ),
    (
        16,
        r#"
        -- Invoice cost & profit tracking (synced)
        ALTER TABLE invoices ADD COLUMN cost_items_json TEXT;
        ALTER TABLE invoices ADD COLUMN total_cost REAL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN profit REAL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN margin REAL DEFAULT 0;
        "#,
    ),
    (
        17,
        r#"
        -- Deal pipeline tracking (synced)
        CREATE TABLE IF NOT EXISTS deals (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            title TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'lead',
            line_items_json TEXT NOT NULL DEFAULT '[]',
            supplier_costs_json TEXT NOT NULL DEFAULT '[]',
            shipping_cost REAL DEFAULT 0,
            other_costs REAL DEFAULT 0,
            asking_price REAL DEFAULT 0,
            payment_terms TEXT,
            notes TEXT,
            expected_close_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            won_at TEXT,
            lost_at TEXT,
            lost_reason TEXT,
            converted_invoice_id TEXT,
            metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
        CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_id);
        CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at);
        "#,
    ),
    (
        18,
        r#"
        -- Shipping info tracking on invoices (synced)
        ALTER TABLE invoices ADD COLUMN carrier TEXT;
        ALTER TABLE invoices ADD COLUMN tracking_number TEXT;
        ALTER TABLE invoices ADD COLUMN shipping_charged REAL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN pickup_date TEXT;
        ALTER TABLE invoices ADD COLUMN delivery_date TEXT;
        ALTER TABLE invoices ADD COLUMN is_complete INTEGER DEFAULT 0;
        "#,
    ),
    (
        19,
        r#"
        -- Deal stage history tracking (local-only, not synced)
        CREATE TABLE IF NOT EXISTS deal_stage_history (
            id TEXT PRIMARY KEY,
            deal_id TEXT NOT NULL,
            from_stage TEXT,
            to_stage TEXT NOT NULL,
            changed_at TEXT NOT NULL,
            FOREIGN KEY (deal_id) REFERENCES deals(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history(deal_id);
        "#,
    ),
    (
        20,
        r#"
        -- Deal flow lifecycle tracking (synced)
        CREATE TABLE IF NOT EXISTS deal_flows (
            id TEXT PRIMARY KEY,
            invoice_id TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'invoiced',
            payment_received_amount REAL DEFAULT 0,
            payment_received_method TEXT,
            payment_received_at TEXT,
            supplier_payments_json TEXT NOT NULL DEFAULT '[]',
            total_supplier_cost REAL DEFAULT 0,
            completed_at TEXT,
            gross_revenue REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            net_profit REAL DEFAULT 0,
            profit_jack REAL DEFAULT 0,
            profit_ben REAL DEFAULT 0,
            profit_business REAL DEFAULT 0,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_deal_flows_invoice ON deal_flows(invoice_id);
        CREATE INDEX IF NOT EXISTS idx_deal_flows_stage ON deal_flows(stage);
        CREATE INDEX IF NOT EXISTS idx_deal_flows_completed ON deal_flows(completed_at);

        ALTER TABLE invoices ADD COLUMN deal_flow_id TEXT;
        ALTER TABLE invoices ADD COLUMN deal_flow_stage TEXT DEFAULT 'none';
        "#,
    ),
    (
        21,
        r#"
        -- (Removed) Payout split is now fully user-configured. We never seed
        -- default percentages or partner names. Unconfigured orgs show no split.
        SELECT 1;
        "#,
    ),
    (
        22,
        r#"
        -- Supplier contacts (synced)
        CREATE TABLE IF NOT EXISTS suppliers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            contact_name TEXT,
            email TEXT,
            phone TEXT,
            address TEXT,
            payment_method TEXT,
            payment_details TEXT,
            payment_terms TEXT,
            typical_lead_time TEXT,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived INTEGER DEFAULT 0,
            metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

        -- Supplier price history (local-only, not synced)
        CREATE TABLE IF NOT EXISTS supplier_price_history (
            id TEXT PRIMARY KEY,
            supplier_id TEXT NOT NULL,
            item_description TEXT NOT NULL,
            price REAL NOT NULL,
            quantity INTEGER,
            recorded_at TEXT NOT NULL,
            deal_flow_id TEXT,
            notes TEXT,
            FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
        );
        CREATE INDEX IF NOT EXISTS idx_price_history_supplier ON supplier_price_history(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_price_history_date ON supplier_price_history(recorded_at);

        ALTER TABLE deal_flows ADD COLUMN metadata TEXT;
        "#,
    ),
    (
        23,
        r#"
        -- Optional display name for deal flows
        ALTER TABLE deal_flows ADD COLUMN name TEXT DEFAULT '';
        "#,
    ),
    (
        24,
        r#"
        -- Scheduled newsletter sends (processed by Pi scheduler)
        CREATE TABLE IF NOT EXISTS scheduled_sends (
            id TEXT PRIMARY KEY,
            newsletter_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            attachment_path TEXT,
            scheduled_at TEXT NOT NULL,
            interval_seconds INTEGER NOT NULL,
            total_recipients INTEGER NOT NULL DEFAULT 0,
            recipients_json TEXT NOT NULL DEFAULT '[]',
            sent_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_sends_status ON scheduled_sends(status);
        "#,
    ),
    (
        25,
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('owner','sales_rep','viewer')),
            invite_code TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        ALTER TABLE interactions ADD COLUMN user_name TEXT;
        "#,
    ),
    (
        26,
        r#"
        CREATE TABLE IF NOT EXISTS inventory (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            category TEXT,
            quantity INTEGER NOT NULL DEFAULT 1,
            total_cost REAL NOT NULL DEFAULT 0,
            asking_price REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','sold','archived')),
            linked_deal_id TEXT,
            photos_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    ),
    (
        27,
        r#"
        CREATE TABLE IF NOT EXISTS followup_rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL CHECK(trigger_type IN ('no_order','no_contact','overdue_invoice','stale_deal')),
            trigger_value INTEGER NOT NULL DEFAULT 30,
            action_type TEXT NOT NULL CHECK(action_type IN ('email','reminder','both')),
            email_subject TEXT,
            email_body TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS followup_log (
            id TEXT PRIMARY KEY,
            rule_id TEXT NOT NULL,
            client_id TEXT,
            triggered_at TEXT NOT NULL,
            action_taken TEXT NOT NULL,
            details TEXT
        );
        "#,
    ),
    (
        28,
        r#"
        CREATE TABLE IF NOT EXISTS client_portal_tokens (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        );
        "#,
    ),
    (
        29,
        r#"
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            invoice_id TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'usd',
            status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','refunded')) DEFAULT 'pending',
            payment_method TEXT,
            stripe_payment_intent_id TEXT,
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
        "#,
    ),
    (
        30,
        r#"
        CREATE TABLE IF NOT EXISTS recurring_invoices (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            template_name TEXT NOT NULL,
            line_items_json TEXT NOT NULL,
            tax_rate REAL NOT NULL DEFAULT 0,
            notes TEXT,
            payment_method_label TEXT,
            frequency TEXT NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly')),
            next_due_date TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (client_id) REFERENCES clients(id)
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_next ON recurring_invoices(next_due_date, is_active);
        "#,
    ),
    (
        31,
        r#"
        CREATE TABLE IF NOT EXISTS tier_history (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            from_tier TEXT,
            to_tier TEXT NOT NULL,
            changed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tier_history_client ON tier_history(client_id);

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
        "#,
    ),
    (
        32,
        r#"
        CREATE TABLE IF NOT EXISTS custom_fields (
            id TEXT PRIMARY KEY,
            field_key TEXT UNIQUE NOT NULL,
            label TEXT NOT NULL,
            field_type TEXT NOT NULL DEFAULT 'text'
                CHECK(field_type IN ('text','number','date','boolean','dropdown')),
            options_json TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        ALTER TABLE sheet_sync_config ADD COLUMN field_mapping_json TEXT NOT NULL DEFAULT '{}';
        "#,
    ),
    (
        33,
        r#"
        ALTER TABLE inventory ADD COLUMN notes TEXT;
        ALTER TABLE inventory ADD COLUMN sent_whatsapp INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE inventory ADD COLUMN sent_email INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        34,
        r#"
        ALTER TABLE inventory ADD COLUMN supplier TEXT;
        ALTER TABLE inventory ADD COLUMN location TEXT;
        "#,
    ),
    (
        35,
        r#"
        CREATE TABLE IF NOT EXISTS quotes (
            id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            number TEXT UNIQUE NOT NULL,
            issue_date TEXT NOT NULL,
            valid_until TEXT NOT NULL,
            line_items_json TEXT NOT NULL,
            subtotal REAL NOT NULL,
            tax REAL DEFAULT 0,
            total REAL NOT NULL,
            status TEXT DEFAULT 'draft',
            pdf_path TEXT,
            sent_at TEXT,
            notes TEXT,
            converted_invoice_id TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_id);
        CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
        "#,
    ),
    (
        36,
        r#"
        ALTER TABLE inventory ADD COLUMN manifest_path TEXT;
        "#,
    ),
    (
        37,
        r#"
        ALTER TABLE inventory ADD COLUMN price_type TEXT NOT NULL DEFAULT 'per_unit' CHECK(price_type IN ('per_unit','total'));
        "#,
    ),
    (
        38,
        r#"
        ALTER TABLE clients ADD COLUMN is_blacklisted INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        39,
        r#"
        ALTER TABLE clients ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'active' CHECK(approval_status IN ('active','pending','rejected'));
        CREATE INDEX IF NOT EXISTS idx_clients_approval ON clients(approval_status);
        "#,
    ),
    (
        40,
        r#"
        CREATE TABLE IF NOT EXISTS newsletter_schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            recipient_filter TEXT NOT NULL DEFAULT '{"mode":"all"}',
            interval_type TEXT NOT NULL DEFAULT 'weekly',
            interval_value INTEGER NOT NULL DEFAULT 1,
            send_hour INTEGER NOT NULL DEFAULT 9,
            next_run_at TEXT NOT NULL,
            last_run_at TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_newsletter_schedules_active ON newsletter_schedules(active, next_run_at);
        "#,
    ),
    (
        41,
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            sender_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            read_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_id);
        "#,
    ),
    (
        42,
        // Multi-tenancy: every business table gains org_id (existing data → the
        // default org). Statements run individually; benign "duplicate column"
        // / "no such table" are skipped by run_migrations.
        r#"
        ALTER TABLE clients ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE interactions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE invoices ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE deals ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE deal_flows ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE suppliers ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE supplier_price_history ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE quotes ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE inventory ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE payment_methods ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE payments ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE scheduled_sends ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE newsletters ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE newsletter_sends ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE newsletter_schedules ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE messages ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE categories ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE recurring_invoices ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE settings ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
        ALTER TABLE roles ADD COLUMN system_key TEXT;
        CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(org_id);
        CREATE INDEX IF NOT EXISTS idx_deal_flows_org ON deal_flows(org_id);
        "#,
    ),
    (
        43,
        // Sticky notes — workspace-wide timestamped notes, synced like other data.
        r#"
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            body TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'yellow',
            pinned INTEGER NOT NULL DEFAULT 0,
            author TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_org ON notes(org_id);
        "#,
    ),
    (
        44,
        // Draggable note board positions.
        r#"
        ALTER TABLE notes ADD COLUMN x REAL NOT NULL DEFAULT 0;
        ALTER TABLE notes ADD COLUMN y REAL NOT NULL DEFAULT 0;
        "#,
    ),
    (
        45,
        // One-time cleanup: this desktop is single-tenant (org_default). Earlier the
        // server's shared sync folder leaked OTHER workspaces' rows here (test orgs),
        // which showed up as duplicate roles/staff/clients. Purge any non-default-org
        // rows. Each runs individually; missing tables/columns are skipped as benign.
        r#"
        DELETE FROM clients WHERE org_id != 'org_default';
        DELETE FROM invoices WHERE org_id != 'org_default';
        DELETE FROM deal_flows WHERE org_id != 'org_default';
        DELETE FROM suppliers WHERE org_id != 'org_default';
        DELETE FROM quotes WHERE org_id != 'org_default';
        DELETE FROM inventory WHERE org_id != 'org_default';
        DELETE FROM payment_methods WHERE org_id != 'org_default';
        DELETE FROM payments WHERE org_id != 'org_default';
        DELETE FROM interactions WHERE org_id != 'org_default';
        DELETE FROM messages WHERE org_id != 'org_default';
        DELETE FROM newsletter_schedules WHERE org_id != 'org_default';
        DELETE FROM categories WHERE org_id != 'org_default';
        DELETE FROM notes WHERE org_id != 'org_default';
        DELETE FROM roles WHERE org_id != 'org_default';
        DELETE FROM staff_accounts WHERE org_id != 'org_default';
        DELETE FROM invites WHERE org_id != 'org_default';
        DELETE FROM orgs WHERE id != 'org_default';
        "#,
    ),
    (
        46,
        // Admin approval queue (rep client add/delete requests). Mirrors the
        // server table so synced events apply; whitelisted for sync.
        r#"
        CREATE TABLE IF NOT EXISTS pending_approvals (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            kind TEXT NOT NULL,
            entity_id TEXT,
            summary TEXT NOT NULL DEFAULT '',
            requested_by TEXT,
            requested_by_name TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            resolved_by TEXT,
            resolved_at TEXT
        );
        "#,
    ),
    (
        47,
        // Custom lead-capture forms, authored here + synced to the server which
        // renders the public page (/f/:id) and accepts submissions.
        r#"
        CREATE TABLE IF NOT EXISTS forms (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            name TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            intro TEXT NOT NULL DEFAULT '',
            fields_json TEXT NOT NULL DEFAULT '[]',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    ),
    (
        48,
        // Self-service profile fields on staff accounts (synced).
        r#"
        ALTER TABLE staff_accounts ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
        ALTER TABLE staff_accounts ADD COLUMN title TEXT NOT NULL DEFAULT '';
        ALTER TABLE staff_accounts ADD COLUMN phone TEXT NOT NULL DEFAULT '';
        "#,
    ),
    (
        49,
        // Checkup sessions: guided one-by-one client review (synced).
        r#"
        CREATE TABLE IF NOT EXISTS checkup_sessions (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            name TEXT NOT NULL DEFAULT '',
            owner_id TEXT,
            owner_name TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checkup_items (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            session_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            reviewed INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            reviewed_at TEXT,
            created_at TEXT NOT NULL
        );
        "#,
    ),
    (
        50,
        // Checkup 3-stage workflow: 0=to reach out, 1=reached out, 2=done.
        // reached_out_at drives Last activity; interaction_id lets undo remove the log.
        r#"
        ALTER TABLE checkup_items ADD COLUMN stage INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE checkup_items ADD COLUMN reached_out_at TEXT;
        ALTER TABLE checkup_items ADD COLUMN interaction_id TEXT;
        "#,
    ),
    (
        51,
        // Refunds + customer credits + rep payout statements (all synced).
        //   deal_flows.refund_owed = amount still owed back on a deal; refunds pay it down.
        //   refunds.keep_rep_cut   = rep already paid, so the refund comes out of the owners'
        //                            share and the rep keeps their full original cut.
        //   client_credits         = per-customer ledger (+issued / -applied); balance = SUM(amount).
        //   rep_payouts            = a rep's owed/paid statement for one payout period.
        r#"
        ALTER TABLE deal_flows ADD COLUMN refund_owed REAL NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS refunds (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            deal_flow_id TEXT NOT NULL,
            client_id TEXT,
            amount REAL NOT NULL DEFAULT 0,
            method TEXT,
            source TEXT,
            source_supplier_ref TEXT,
            keep_rep_cut INTEGER NOT NULL DEFAULT 0,
            reason TEXT,
            refunded_at TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_refunds_deal ON refunds(deal_flow_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_client ON refunds(client_id);
        CREATE TABLE IF NOT EXISTS client_credits (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            client_id TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'issued',
            source_deal_flow_id TEXT,
            applied_deal_flow_id TEXT,
            note TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_client_credits_client ON client_credits(client_id);
        CREATE TABLE IF NOT EXISTS rep_payouts (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            rep_id TEXT NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            paid_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rep_payouts_rep ON rep_payouts(rep_id);
        "#,
    ),
    (
        52,
        // Intake sources: external forms/sites that create pending clients. mapping_json
        // maps an incoming field key -> an app field ("name"/"email"/"phone"/"company"/
        // "notes", "cf:<key>" for a custom/meta field, or "ignore").
        r#"
        CREATE TABLE IF NOT EXISTS intake_sources (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            name TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'website',
            token TEXT NOT NULL DEFAULT '',
            mapping_json TEXT NOT NULL DEFAULT '{}',
            sample_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_intake_sources_token ON intake_sources(token);
        "#,
    ),
    (
        53,
        // Subcategories: a category with a non-null parent_id is a child of that
        // category. Top-level categories have parent_id = NULL.
        r#"
        ALTER TABLE categories ADD COLUMN parent_id TEXT;
        "#,
    ),
    (
        54,
        // Promote the High-Value + Exclusive flags out of the metadata blob into
        // real columns, so later metadata writes can't clobber them. Backfill from
        // any existing metadata.high_value / metadata.exclusive (true/1).
        r#"
        ALTER TABLE clients ADD COLUMN high_value INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE clients ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0;
        UPDATE clients SET high_value=1
          WHERE json_valid(metadata)
            AND json_extract(metadata,'$.high_value') IN (1, 'true');
        UPDATE clients SET exclusive=1
          WHERE json_valid(metadata)
            AND json_extract(metadata,'$.exclusive') IN (1, 'true');
        "#,
    ),
    (
        55,
        // Invoice VOID flag: a deal that fell through. Kept (never deleted) but
        // excluded from receivables/AR "owed", the dashboard cash position, and
        // revenue/profit rollups. Original `status` is preserved so unvoiding is
        // lossless. Synced like any other invoice column.
        r#"
        ALTER TABLE invoices ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        56,
        // Soft-delete: deleting an invoice/deal/deal_flow now flips `archived=1`
        // instead of a hard DELETE. This avoids the FK crash (payments → invoices,
        // no cascade), syncs reliably (record_upsert), and feeds the Archive view.
        // Nothing is destroyed; restore clears the flag. Synced columns.
        r#"
        ALTER TABLE invoices ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN archived_at TEXT;
        ALTER TABLE deals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE deals ADD COLUMN archived_at TEXT;
        ALTER TABLE deal_flows ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE deal_flows ADD COLUMN archived_at TEXT;
        "#,
    ),
    (
        57,
        // Google Sheets WRITE-BACK toggle. When a lead is APPROVED the desktop
        // appends a row to the connected sheet (sheet_writeback.rs). This flag lets
        // the user turn that direction on/off from Settings → Google Sheets. Default
        // ON (1) preserves the prior always-on behaviour. Local-only (the whole
        // sheet_sync_config row is local, never synced).
        r#"
        ALTER TABLE sheet_sync_config ADD COLUMN writeback_enabled INTEGER NOT NULL DEFAULT 1;
        "#,
    ),
    (
        58,
        // Structured extras for a lot (pallets, MSRP, avg MSRP, MOQ, size run) as a
        // single JSON blob so the storefront/blast can show them and the parser can
        // fill them. Public fields; supplier + cost stay in their own columns (internal).
        r#"
        ALTER TABLE inventory ADD COLUMN details_json TEXT;
        "#,
    ),
    (
        59,
        // Up-front deposit taken on a deal, SEPARATE from the full payment_received_amount.
        // Balance owed = invoice total − deposit (computed, not stored). Synced; the
        // clienthub-api server backfills the same column in sync.rs so upserts round-trip.
        r#"
        ALTER TABLE deal_flows ADD COLUMN deposit_amount REAL NOT NULL DEFAULT 0;
        "#,
    ),
    (
        60,
        // ── Financial / treasury engine (BJM books) ────────────────────────────
        // Deal-level terms the money engine needs (all optional; expected_sale/cost
        // are DERIVED from invoice_total / total_supplier_cost, so not stored here).
        // Plus five new synced tables: raw immutable bank transactions, allocations
        // (bank money → deals, the core of the truth engine), cash purchases, business
        // expenses, and the append-only reserve ledger (tax + refund holds).
        // Every new table carries org_id + NOT NULL DEFAULTs so partial/out-of-order
        // upserts can stub-insert. Column sets are kept BYTE-IDENTICAL with
        // clienthub-api schema.sql + sync.rs ensure_meta_tables so upserts round-trip
        // (the server has no schema-drift tolerance — a missing column stalls sync).
        r#"
        ALTER TABLE deal_flows ADD COLUMN model TEXT;
        ALTER TABLE deal_flows ADD COLUMN payment_rail TEXT;
        ALTER TABLE deal_flows ADD COLUMN closed_by TEXT;
        ALTER TABLE deal_flows ADD COLUMN settlement_days INTEGER;
        ALTER TABLE deal_flows ADD COLUMN inspection_days INTEGER;

        CREATE TABLE IF NOT EXISTS bank_txn (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            account_id TEXT NOT NULL DEFAULT '',
            posted_at TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            direction TEXT NOT NULL DEFAULT 'out',
            description TEXT NOT NULL DEFAULT '',
            memo_raw TEXT NOT NULL DEFAULT '',
            rail TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            counterparty_type TEXT NOT NULL DEFAULT '',
            counterparty_id TEXT NOT NULL DEFAULT '',
            counterparty_name TEXT NOT NULL DEFAULT '',
            fitid TEXT NOT NULL DEFAULT '',
            wire_ref TEXT NOT NULL DEFAULT '',
            check_num TEXT NOT NULL DEFAULT '',
            balance REAL NOT NULL DEFAULT 0,
            source_format TEXT NOT NULL DEFAULT '',
            reviewed INTEGER NOT NULL DEFAULT 0,
            raw_json TEXT NOT NULL DEFAULT '',
            imported_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_bank_txn_org_date ON bank_txn(org_id, posted_at);

        CREATE TABLE IF NOT EXISTS bank_allocation (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            bank_txn_id TEXT NOT NULL DEFAULT '',
            deal_flow_id TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            role TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_bank_allocation_txn ON bank_allocation(bank_txn_id);
        CREATE INDEX IF NOT EXISTS idx_bank_allocation_deal ON bank_allocation(deal_flow_id);

        CREATE TABLE IF NOT EXISTS cash_purchase (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            deal_flow_id TEXT NOT NULL DEFAULT '',
            supplier_id TEXT NOT NULL DEFAULT '',
            withdrawal_txn_id TEXT NOT NULL DEFAULT '',
            paid_at TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            discount_pct REAL NOT NULL DEFAULT 0,
            invoice_url TEXT NOT NULL DEFAULT '',
            supplier_ein TEXT NOT NULL DEFAULT '',
            returned_to_bank REAL NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_cash_purchase_deal ON cash_purchase(deal_flow_id);

        CREATE TABLE IF NOT EXISTS business_expense (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            date TEXT NOT NULL DEFAULT '',
            vendor TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            recurring INTEGER NOT NULL DEFAULT 0,
            bank_txn_id TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS reserve_entry (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            date TEXT NOT NULL DEFAULT '',
            ledger TEXT NOT NULL DEFAULT '',
            direction TEXT NOT NULL DEFAULT 'in',
            amount REAL NOT NULL DEFAULT 0,
            deal_flow_id TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_reserve_entry_ledger ON reserve_entry(org_id, ledger);
        "#,
    ),
    (
        61,
        // Loans: money RECEIVED that must be paid back (a liability, not revenue — e.g.
        // the Jan $15k that funded the first deal). `set_aside` = amount put aside/repaid
        // toward it; outstanding = principal − set_aside; a loan drops off Free Cash when
        // status='paid'. Synced + org-scoped (mirrored on clienthub-api).
        r#"
        CREATE TABLE IF NOT EXISTS loan (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            name TEXT NOT NULL DEFAULT '',
            lender TEXT NOT NULL DEFAULT '',
            principal REAL NOT NULL DEFAULT 0,
            set_aside REAL NOT NULL DEFAULT 0,
            received_at TEXT NOT NULL DEFAULT '',
            bank_txn_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open',
            paid_at TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        "#,
    ),
    (
        62,
        // Plaid linked banks — DEVICE-LOCAL ONLY (never synced): access tokens are
        // secrets. The transactions they pull land in the synced bank_txn ledger.
        // Deliberately NOT added to sync ALLOWED_TABLES.
        r#"
        CREATE TABLE IF NOT EXISTS plaid_items (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL DEFAULT '',
            access_token TEXT NOT NULL DEFAULT '',
            institution TEXT NOT NULL DEFAULT '',
            cursor TEXT NOT NULL DEFAULT '',
            accounts_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT ''
        );
        "#,
    ),
    (
        63,
        // Stamp the Plaid environment each item was linked under. An access_token is
        // only valid against the environment (and matching secret) it was created in,
        // so sync must use the item's own env — otherwise a later env switch silently
        // invalidates every previously-linked item. Device-local, like plaid_items.
        r#"
        ALTER TABLE plaid_items ADD COLUMN env TEXT NOT NULL DEFAULT 'production';
        "#,
    ),
    (
        64,
        // Memorized auto-tag rules for the bank feed — DEVICE-LOCAL ONLY (never
        // synced): a rule matches an incoming transaction by counterparty (exact) or
        // description (contains) and pre-fills its category / loan target. Only the
        // resulting bank_txn edits sync; the rules themselves are per-device, so this
        // is deliberately NOT added to sync ALLOWED_TABLES.
        r#"
        CREATE TABLE IF NOT EXISTS txn_rule (
            id TEXT PRIMARY KEY,
            match_counterparty TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            target_type TEXT NOT NULL DEFAULT '',
            target_id TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT ''
        );
        "#,
    ),
    (
        65,
        // Direction-scope a rule ('' = any, 'in' = money in only, 'out' = money out
        // only) so e.g. Whatnot payouts and Whatnot charges can carry different
        // categories. Device-local; the duplicate-column error is benign.
        r#"
        ALTER TABLE txn_rule ADD COLUMN direction TEXT NOT NULL DEFAULT '';
        "#,
    ),
    (
        66,
        // Refund workspace. (1) Link a refund payment to the bank transaction it was
        // paid from — nullable, so an unlinked refund is a custom/manual amount.
        // (2) deal_receipts: money RECEIVED on a deal that isn't in the bank feed
        // (custom lines). Bank-linked received money already lives in
        // bank_allocation(buyer_payment); this table is only the manual side. Both
        // sync (the apply path tolerates the added column on older peers).
        r#"
        ALTER TABLE refunds ADD COLUMN bank_txn_id TEXT;
        CREATE TABLE IF NOT EXISTS deal_receipts (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            deal_flow_id TEXT NOT NULL DEFAULT '',
            amount REAL NOT NULL DEFAULT 0,
            label TEXT NOT NULL DEFAULT '',
            received_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_deal_receipts_deal ON deal_receipts(deal_flow_id);
        "#,
    ),
    (
        67,
        // Resizable sticky notes — per-note width/height on the board so a note can
        // be stretched bigger/more important. Defaults match the old fixed size.
        r#"
        ALTER TABLE notes ADD COLUMN w REAL NOT NULL DEFAULT 226;
        ALTER TABLE notes ADD COLUMN h REAL NOT NULL DEFAULT 190;
        "#,
    ),
    (
        68,
        // When an invoice was voided (deal fell through) — lets the brief count
        // "deals lost this period". Historical voids stay NULL (untimestamped).
        r#"
        ALTER TABLE invoices ADD COLUMN voided_at TEXT;
        "#,
    ),
    (
        69,
        // Advisory edit-lock on a sticky note: who is currently editing and when
        // they last touched it (TTL-expired on the reader side). Synced columns so
        // the lock is visible on every device.
        r#"
        ALTER TABLE notes ADD COLUMN editing_by TEXT NOT NULL DEFAULT '';
        ALTER TABLE notes ADD COLUMN editing_at TEXT NOT NULL DEFAULT '';
        "#,
    ),
    (
        70,
        // Urgency + review tracking for notes. `urgency` ('normal'|'high'|'urgent')
        // drives how prominently a note surfaces and how quickly it's considered
        // "posted too long"; `reviewed_at` is the last time someone confirmed the note
        // is still needed (the "keep active" check) — staleness is measured from it
        // (falling back to created_at). Synced so attention travels between devices.
        r#"
        ALTER TABLE notes ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal';
        ALTER TABLE notes ADD COLUMN reviewed_at TEXT;
        "#,
    ),
    (
        71,
        // inventory.price_type was created with CHECK(price_type IN ('per_unit','total')),
        // but the app supports a third value 'custom' — a lot priced by descriptive text
        // ("Send offer" / "Best offer"). Saving a custom lot silently hit the CHECK and
        // failed ("won't let me put custom text"). Rebuild the column WITHOUT the CHECK,
        // preserving values. SQLite 3.46 (rusqlite 0.32 bundled) supports DROP/RENAME
        // COLUMN; a duplicate-column error on re-run is benign and skipped.
        r#"
        ALTER TABLE inventory ADD COLUMN price_type_tmp TEXT NOT NULL DEFAULT 'per_unit';
        UPDATE inventory SET price_type_tmp = COALESCE(price_type,'per_unit');
        ALTER TABLE inventory DROP COLUMN price_type;
        ALTER TABLE inventory RENAME COLUMN price_type_tmp TO price_type;
        "#,
    ),
    (
        72,
        // Buyer offers submitted from the public storefront ("Make an offer"). Written
        // server-side by the public endpoint and synced down; the desktop reads them on
        // the lot. status: new | accepted | declined | archived.
        r#"
        CREATE TABLE IF NOT EXISTS offers (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org_default',
            lot_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            amount REAL,
            message TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_offers_lot ON offers(lot_id);
        "#,
    ),
    (
        73,
        // A buyer's offer can be priced PER UNIT or for the FULL LOT — store which.
        r#"
        ALTER TABLE offers ADD COLUMN offer_type TEXT NOT NULL DEFAULT 'lot';
        "#,
    ),
    (
        74,
        // Third share channel: mark a lot as posted to Facebook (like sent_whatsapp/email).
        r#"
        ALTER TABLE inventory ADD COLUMN sent_facebook INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        75,
        // Local-only recovery buffer for the duplicate-transaction cleanup. A removed row's
        // full contents are copied here BEFORE the durable delete, so a wrongly-merged txn
        // can be recovered. NOT synced (absent from ALLOWED_TABLES), so it stays on this
        // device and never propagates.
        r#"
        CREATE TABLE IF NOT EXISTS bank_txn_deleted_backup (
            id TEXT PRIMARY KEY,
            row_json TEXT NOT NULL,
            survivor_id TEXT,
            reason TEXT,
            deleted_at TEXT NOT NULL
        );
        "#,
    ),
    (
        76,
        // txn_rule becomes a SYNCED table (R-018 second half) — booking memory must be
        // org knowledge, not device trivia: a rule taught on the desktop has to fire on
        // the Mac too, or the same payee re-asks on every machine. org_id at the author
        // (schema default files every tenant under org_default — same lesson as
        // add_cash_transaction), auto_book is the per-rule opt-in that books a matched
        // row outright instead of only pre-filling it, updated_at because synced rows
        // carry one. Writes go through sync::record_upsert/record_delete from v0.15.139;
        // rules created before that are emitted once by sync::emit_unsynced_txn_rules.
        r#"
        ALTER TABLE txn_rule ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default';
        ALTER TABLE txn_rule ADD COLUMN auto_book INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE txn_rule ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        "#,
    ),
    (
        77,
        // Shipping lifecycle on a deal (R-154, decided 2026-08-17). The four money
        // stages say nothing about "agreed, paid for, truck hasn't come yet" — which
        // is most of the life of a deal. `pickup_date` is when it LEAVES,
        // `expected_delivery_date` is when it LANDS ('YYYY-MM-DD', the same string
        // shape the rest of the app parses).
        //
        // REAL COLUMNS, deliberately not `metadata`: that is one JSON blob under
        // per-column LWW, so two devices editing different keys clobber each other,
        // and a date that gates completion is load-bearing.
        //
        // `ships_direct` makes "no pickup / ships direct" an EXPLICIT answer, so an
        // empty date stays a genuine unanswered question the card can flag instead of
        // quietly meaning "not applicable".
        //
        // `*_prev` keeps the value a reschedule replaced. Pickups slip constantly
        // here; without it the card silently claims it was always Thursday.
        //
        // All nullable with no NOT NULL: a partial upsert that violates a NOT NULL on
        // a row that does not exist yet is dropped by INSERT OR IGNORE (insert branch)
        // or errors and rewinds the pull cursor (update branch) — see
        // architecture/sync-engine §10. Mirrored byte-for-byte in clienthub-api
        // (schema.sql + sync.rs ensure_meta_tables); the server must be DEPLOYED FIRST
        // or the mirror logs SCHEMA DRIFT and drops these columns on the floor.
        r#"
        ALTER TABLE deal_flows ADD COLUMN pickup_date TEXT;
        ALTER TABLE deal_flows ADD COLUMN expected_delivery_date TEXT;
        ALTER TABLE deal_flows ADD COLUMN ships_direct INTEGER DEFAULT 0;
        ALTER TABLE deal_flows ADD COLUMN pickup_date_prev TEXT;
        ALTER TABLE deal_flows ADD COLUMN expected_delivery_date_prev TEXT;
        "#,
    ),
    (
        78,
        // The payment method a HUMAN confirmed (R-157/F1, decided 2026-08-17).
        //
        // `rail` cannot carry this and never could. `bank_import::classify` writes
        // `rail` from a string-match over the raw memo on every statement parse path
        // (OFX, CSV, PDF) and its own doc comment calls it "a SUGGESTION only".
        // Replaying that classifier over this ledger's 1,342 rows sets a non-empty
        // `rail` on 690 of them. Reading `rail` as a confirmation would therefore
        // render 690 machine guesses as facts and — worse — let the payee memory
        // teach from them, which is precisely the laundering R-018 forbids: only a
        // reviewed or confirmed row may teach.
        //
        // So `rail` stays the machine's column and this is the human's. Additive, so
        // the guesses already stored in `rail` are not lost, just correctly demoted to
        // "likely"; making bank_import stop writing `rail` instead would leave those
        // rows forever indistinguishable from confirmations.
        //
        // Nullable, no NOT NULL, no CHECK: a partial upsert that violates one on a row
        // that does not exist yet is swallowed with no clock by INSERT OR IGNORE
        // (insert branch) or errors and rewinds the pull cursor (update branch) — see
        // architecture/sync-engine §10 failure modes 1 and 2. The value set is
        // enforced in `valid_method` at the one command that writes it.
        //
        // Mirrored in clienthub-api (schema.sql + sync.rs ensure_meta_tables); the
        // server must be DEPLOYED FIRST or apply_upsert logs SCHEMA DRIFT at warn
        // level and drops the column out of every bank_txn event.
        r#"
        ALTER TABLE bank_txn ADD COLUMN confirmed_method TEXT;
        "#,
    ),
];
