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
        -- Default profit split percentages and partner names
        INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_split_business', '40');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_split_jack', '30');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_split_ben', '30');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_split_jack_name', 'Jack');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_split_ben_name', 'Ben');
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
];
