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

pub fn init(app: &App) -> Result<()> {
    let dir = app.path().app_data_dir().context("app_data_dir")?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("clienthub.db");
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
            conn.execute_batch(sql).with_context(|| format!("migration {}", version))?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![*version as i64, chrono::Utc::now().to_rfc3339()],
            )?;
        }
    }
    Ok(())
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
];
