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
];
