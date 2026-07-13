//! Sync engine: append-only event log with Hybrid Logical Clocks (HLC).
//!
//! Each device writes events to a file in the sync folder. Syncthing/Dropbox/etc
//! handles the file replication. On startup and via a file watcher, we replay
//! new events into local SQLite, ordered by HLC timestamps.
//!
//! HLCs give us:
//!   - Causal ordering (later events overwrite earlier ones)
//!   - Tie-breaking by node_id when timestamps collide
//!   - No clock-drift catastrophes (logical component bumps if physical lags)
//!
//! Conflict resolution: Last-Write-Wins per (table, row_id, column).
//! Deletes are tombstones that win over any earlier write.

use anyhow::{Context, Result};
use chrono::Utc;
use notify::{Event as NotifyEvent, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::db::pool;
use crate::sync_crypto;

// ---------- Hybrid Logical Clock ----------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hlc {
    /// Physical time in milliseconds since Unix epoch.
    pub physical_ms: u64,
    /// Logical counter; bumps when physical time hasn't advanced.
    pub logical: u32,
    /// Node identifier for tie-breaking.
    pub node_id: [u8; 8],
}

static HLC_STATE: OnceLock<Mutex<HlcState>> = OnceLock::new();
static NODE_ID: OnceLock<[u8; 8]> = OnceLock::new();

#[derive(Debug)]
struct HlcState {
    last_physical: u64,
    last_logical: u32,
}

fn node_id() -> [u8; 8] {
    *NODE_ID.get_or_init(|| {
        let conn = pool().get().expect("db");
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM device_state WHERE key='node_id'",
                [],
                |r| r.get(0),
            )
            .ok();

        if let Some(id_str) = existing {
            if let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &id_str) {
                if bytes.len() == 8 {
                    let mut arr = [0u8; 8];
                    arr.copy_from_slice(&bytes);
                    return arr;
                }
            }
        }

        let mut arr = [0u8; 8];
        let bytes = Uuid::new_v4().as_bytes()[..8].to_vec();
        arr.copy_from_slice(&bytes);
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, arr);
        let _ = conn.execute(
            "INSERT INTO device_state (key, value) VALUES ('node_id', ?1)",
            [encoded],
        );
        arr
    })
}

pub fn now_hlc() -> Hlc {
    let state = HLC_STATE.get_or_init(|| {
        Mutex::new(HlcState {
            last_physical: 0,
            last_logical: 0,
        })
    });
    let mut s = state.lock().unwrap();
    let physical = Utc::now().timestamp_millis() as u64;

    if physical > s.last_physical {
        s.last_physical = physical;
        s.last_logical = 0;
    } else {
        // Clock didn't advance; bump logical.
        s.last_logical += 1;
    }

    Hlc {
        physical_ms: s.last_physical,
        logical: s.last_logical,
        node_id: node_id(),
    }
}

/// Update HLC state when receiving a remote event with given timestamp.
pub fn observe_remote(remote: Hlc) {
    let state = HLC_STATE.get_or_init(|| {
        Mutex::new(HlcState {
            last_physical: 0,
            last_logical: 0,
        })
    });
    let mut s = state.lock().unwrap();
    let physical = Utc::now().timestamp_millis() as u64;
    let max_p = physical.max(s.last_physical).max(remote.physical_ms);

    s.last_logical = if max_p == s.last_physical && max_p == remote.physical_ms {
        s.last_logical.max(remote.logical) + 1
    } else if max_p == s.last_physical {
        s.last_logical + 1
    } else if max_p == remote.physical_ms {
        remote.logical + 1
    } else {
        0
    };
    s.last_physical = max_p;
}

// ---------- Event Log ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum SyncOp {
    Upsert {
        table: String,
        row_id: String,
        columns: serde_json::Map<String, serde_json::Value>,
    },
    Delete {
        table: String,
        row_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncEvent {
    pub id: String,           // UUID
    pub hlc: Hlc,
    pub op: SyncOp,
}

static SYNC_DIR: OnceLock<PathBuf> = OnceLock::new();
static EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn init(sync_dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&sync_dir)?;
    SYNC_DIR.set(sync_dir).ok();
    ensure_meta_tables()?;
    Ok(())
}

fn sync_dir() -> &'static Path {
    SYNC_DIR.get().expect("sync dir not initialized")
}

fn ensure_meta_tables() -> Result<()> {
    let conn = pool().get()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sync_meta (
            event_id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS row_clocks (
            tbl TEXT NOT NULL,
            row_id TEXT NOT NULL,
            col TEXT NOT NULL,
            hlc_phys INTEGER NOT NULL,
            hlc_log INTEGER NOT NULL,
            hlc_node BLOB NOT NULL,
            PRIMARY KEY (tbl, row_id, col)
        );
        CREATE TABLE IF NOT EXISTS tombstones (
            tbl TEXT NOT NULL,
            row_id TEXT NOT NULL,
            hlc_phys INTEGER NOT NULL,
            hlc_log INTEGER NOT NULL,
            hlc_node BLOB NOT NULL,
            PRIMARY KEY (tbl, row_id)
        );
        -- Folder-sync event files we've already replayed, tracked individually by
        -- name so out-of-order peer arrivals are never skipped. (The old single
        -- high-water-mark cursor dropped any file that synced in "in the past".)
        CREATE TABLE IF NOT EXISTS replayed_files (
            name TEXT PRIMARY KEY
        );
        "#,
    )?;
    Ok(())
}

/// Record a local mutation. Writes both to SQLite (immediately) and to the event log.
pub fn record_upsert(
    table: &str,
    row_id: &str,
    columns: serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let event = SyncEvent {
        id: Uuid::new_v4().to_string(),
        hlc: now_hlc(),
        op: SyncOp::Upsert {
            table: table.to_string(),
            row_id: row_id.to_string(),
            columns: columns.clone(),
        },
    };
    update_row_clocks(table, row_id, &columns, event.hlc)?;
    write_event_file(&event)?;
    mark_applied(&event.id)?;
    crate::netsync::on_local_event(&event); // queue for network push (no-op if not connected)
    Ok(())
}

pub fn record_delete(table: &str, row_id: &str) -> Result<()> {
    let event = SyncEvent {
        id: Uuid::new_v4().to_string(),
        hlc: now_hlc(),
        op: SyncOp::Delete {
            table: table.to_string(),
            row_id: row_id.to_string(),
        },
    };
    write_tombstone(table, row_id, event.hlc)?;
    write_event_file(&event)?;
    mark_applied(&event.id)?;
    crate::netsync::on_local_event(&event); // queue for network push (no-op if not connected)
    Ok(())
}

/// Apply an event received from the central server (network sync). Same idempotent
/// per-column LWW path as folder-sync replay; safe to call with already-seen ids.
pub fn apply_remote(event: &SyncEvent) -> Result<()> {
    apply_event(event)
}

fn write_event_file(event: &SyncEvent) -> Result<()> {
    let counter = EVENT_COUNTER.fetch_add(1, Ordering::SeqCst);
    let node_hex: String = event.hlc.node_id.iter().map(|b| format!("{:02x}", b)).collect();
    let encrypted = sync_crypto::is_encryption_enabled();
    let ext = if encrypted { ".enc.json" } else { ".json" };
    let filename = format!(
        "{:016}-{:08}-{}-{}-{}{}",
        event.hlc.physical_ms,
        event.hlc.logical,
        node_hex,
        counter,
        &event.id[..8],
        ext
    );
    let path = sync_dir().join(filename);
    let json = serde_json::to_vec_pretty(event)?;
    let data = if encrypted {
        sync_crypto::encrypt_to_wrapper(&json)?.into_bytes()
    } else {
        json
    };
    std::fs::write(&path, data).context("write event file")?;
    Ok(())
}

fn mark_applied(event_id: &str) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT OR IGNORE INTO sync_meta (event_id, applied_at) VALUES (?1, ?2)",
        rusqlite::params![event_id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn already_applied(event_id: &str) -> Result<bool> {
    let conn = pool().get()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_meta WHERE event_id=?1",
        [event_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Whether a folder-sync event file (by exact name) has already been replayed.
fn file_replayed(name: &str) -> Result<bool> {
    let conn = pool().get()?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM replayed_files WHERE name=?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn mark_file_replayed(name: &str) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT OR IGNORE INTO replayed_files (name) VALUES (?1)",
        [name],
    )?;
    Ok(())
}

// ---------- Conflict resolution ----------

fn update_row_clocks(
    table: &str,
    row_id: &str,
    columns: &serde_json::Map<String, serde_json::Value>,
    hlc: Hlc,
) -> Result<()> {
    let conn = pool().get()?;
    for col in columns.keys() {
        conn.execute(
            "INSERT INTO row_clocks (tbl,row_id,col,hlc_phys,hlc_log,hlc_node)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(tbl,row_id,col) DO UPDATE SET
               hlc_phys=excluded.hlc_phys,
               hlc_log=excluded.hlc_log,
               hlc_node=excluded.hlc_node",
            rusqlite::params![table, row_id, col, hlc.physical_ms as i64, hlc.logical, hlc.node_id.to_vec()],
        )?;
    }
    Ok(())
}

fn col_clock(table: &str, row_id: &str, col: &str) -> Result<Option<Hlc>> {
    let conn = pool().get()?;
    let res: rusqlite::Result<(i64, u32, Vec<u8>)> = conn.query_row(
        "SELECT hlc_phys,hlc_log,hlc_node FROM row_clocks WHERE tbl=?1 AND row_id=?2 AND col=?3",
        rusqlite::params![table, row_id, col],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    match res {
        Ok((p, l, n)) => {
            let mut node = [0u8; 8];
            if n.len() == 8 {
                node.copy_from_slice(&n);
            }
            Ok(Some(Hlc {
                physical_ms: p as u64,
                logical: l,
                node_id: node,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The newest HLC recorded across ALL of a row's column clocks — i.e. the last
/// time anything on this row was written. Used by `apply_delete` to decide
/// whether an incoming tombstone actually wins.
fn max_row_clock(table: &str, row_id: &str) -> Result<Option<Hlc>> {
    let conn = pool().get()?;
    let mut stmt = conn.prepare(
        "SELECT hlc_phys,hlc_log,hlc_node FROM row_clocks WHERE tbl=?1 AND row_id=?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![table, row_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?, r.get::<_, Vec<u8>>(2)?))
    })?;
    let mut best: Option<Hlc> = None;
    for row in rows {
        let (p, l, n) = row?;
        let mut node = [0u8; 8];
        if n.len() == 8 {
            node.copy_from_slice(&n);
        }
        let h = Hlc { physical_ms: p as u64, logical: l, node_id: node };
        if best.map_or(true, |b| h > b) {
            best = Some(h);
        }
    }
    Ok(best)
}

fn write_tombstone(table: &str, row_id: &str, hlc: Hlc) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO tombstones (tbl,row_id,hlc_phys,hlc_log,hlc_node) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(tbl,row_id) DO UPDATE SET
           hlc_phys=excluded.hlc_phys, hlc_log=excluded.hlc_log, hlc_node=excluded.hlc_node",
        rusqlite::params![table, row_id, hlc.physical_ms as i64, hlc.logical, hlc.node_id.to_vec()],
    )?;
    Ok(())
}

fn tombstone_clock(table: &str, row_id: &str) -> Result<Option<Hlc>> {
    let conn = pool().get()?;
    let res: rusqlite::Result<(i64, u32, Vec<u8>)> = conn.query_row(
        "SELECT hlc_phys,hlc_log,hlc_node FROM tombstones WHERE tbl=?1 AND row_id=?2",
        rusqlite::params![table, row_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    match res {
        Ok((p, l, n)) => {
            let mut node = [0u8; 8];
            if n.len() == 8 {
                node.copy_from_slice(&n);
            }
            Ok(Some(Hlc {
                physical_ms: p as u64,
                logical: l,
                node_id: node,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// ---------- Apply remote events ----------

const ALLOWED_TABLES: &[&str] = &["clients", "interactions", "invoices", "settings", "payment_methods", "deals", "deal_flows", "suppliers", "supplier_price_history", "scheduled_sends", "users", "payments", "inventory", "quotes", "messages", "newsletter_schedules", "staff_accounts", "roles", "invites", "deal_reps", "orgs", "notes", "pending_approvals", "forms", "checkup_sessions", "checkup_items", "refunds", "client_credits", "rep_payouts", "intake_sources", "categories", "bank_txn", "bank_allocation", "cash_purchase", "business_expense", "reserve_entry"];

/// True if peers will actually apply an event for `table`. Emitting a record for a
/// table outside this set produces an event that the apply side rejects — which (with
/// the pull retry loop) stalls a peer's sync. Callers that reassign rows across tables
/// should broadcast ONLY for synced tables; the local UPDATE keeps this device correct.
pub fn is_synced_table(table: &str) -> bool {
    ALLOWED_TABLES.contains(&table)
}

fn apply_event(event: &SyncEvent) -> Result<()> {
    if already_applied(&event.id)? {
        return Ok(());
    }
    observe_remote(event.hlc);

    match &event.op {
        SyncOp::Upsert { table, row_id, columns } => {
            if !ALLOWED_TABLES.contains(&table.as_str()) {
                anyhow::bail!("unknown table {}", table);
            }
            // If a tombstone with newer or equal HLC exists, skip.
            if let Some(ts) = tombstone_clock(table, row_id)? {
                if ts >= event.hlc {
                    mark_applied(&event.id)?;
                    return Ok(());
                }
            }
            apply_upsert(table, row_id, columns, event.hlc)?;
        }
        SyncOp::Delete { table, row_id } => {
            if !ALLOWED_TABLES.contains(&table.as_str()) {
                anyhow::bail!("unknown table {}", table);
            }
            apply_delete(table, row_id, event.hlc)?;
        }
    }
    mark_applied(&event.id)?;
    Ok(())
}

/// Primary-key column for a synced table (most use `id`).
pub(crate) fn primary_key(table: &str) -> &'static str {
    match table {
        "settings" => "key",
        "invites" => "token",
        "deal_reps" => "deal_flow_id",
        _ => "id",
    }
}

/// Column names that physically exist in the local `table`. Used to make sync
/// application resilient to schema drift between devices (see `apply_upsert`).
pub(crate) fn existing_columns(conn: &rusqlite::Connection, table: &str) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({})", table)) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.flatten() {
                set.insert(c);
            }
        }
    }
    set
}

fn apply_upsert(
    table: &str,
    row_id: &str,
    columns: &serde_json::Map<String, serde_json::Value>,
    hlc: Hlc,
) -> Result<()> {
    let conn = pool().get()?;
    let pk = primary_key(table);

    // Column names are interpolated into the SQL below and can originate from a
    // server pull (ultimately another org member's push), so reject anything that
    // isn't a plain identifier before it reaches the query text.
    for col in columns.keys() {
        if col.is_empty()
            || col.as_bytes()[0].is_ascii_digit()
            || !col.bytes().all(|b| b == b'_' || b.is_ascii_alphanumeric())
        {
            anyhow::bail!("unsafe column name in sync event for {}: {:?}", table, col);
        }
    }

    // Per-column LWW: only apply columns whose existing clock is older.
    let mut winning: Vec<(String, serde_json::Value)> = Vec::new();
    for (col, val) in columns {
        let current = col_clock(table, row_id, col)?;
        let win = match current {
            None => true,
            Some(c) => hlc > c,
        };
        if win {
            winning.push((col.clone(), val.clone()));
        }
    }
    if winning.is_empty() {
        return Ok(());
    }

    // Resilience against schema drift between devices. A device on an older (or
    // newer) schema can receive an event that references a column it doesn't have
    // yet. Building SQL with that column makes `conn.execute` fail with
    // "no such column", which drops the ENTIRE event — and because the pull
    // cursor advances regardless, that row is skipped permanently (this is what
    // left a MacBook stuck at a fraction of the clients). Instead, apply only the
    // columns that exist locally and — because we record clocks solely for what we
    // applied (below) — a later re-pull fills the rest once a migration adds them.
    let present = existing_columns(&conn, table);
    winning.retain(|(c, _)| present.contains(c));
    if winning.is_empty() {
        return Ok(());
    }

    // Upsert row with id, then update individual columns.
    // Insert sentinel if row doesn't exist.
    let exists: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {} WHERE {}=?1", table, pk),
            [row_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if exists == 0 {
        // Insert a stub row; required-NOT-NULL columns must be present in `winning`.
        let cols = std::iter::once(pk.to_string())
            .chain(winning.iter().map(|(c, _)| c.clone()))
            .collect::<Vec<_>>();
        let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "INSERT OR IGNORE INTO {} ({}) VALUES ({})",
            table,
            cols.join(","),
            placeholders.join(",")
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(row_id.to_string())];
        for (_, v) in &winning {
            params.push(json_to_sql(v));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let n = conn.execute(&sql, refs.as_slice())?;
        if n == 0 {
            // INSERT OR IGNORE no-op: a PARTIAL upsert reached a row that doesn't
            // exist yet and hit a NOT-NULL constraint (e.g. clients.name). The row
            // was NOT created. Critically, do NOT record clocks here — otherwise
            // these columns get "phantom" clocks that permanently block the real
            // create event from ever materializing the row (per-column LWW sees an
            // existing clock and skips). Events can arrive out of causal order
            // (the server serves them by arrival seq, not HLC), so a partial can
            // precede its create; leaving clocks unset lets the later create win
            // and insert the row. (This is what stranded a MacBook at a fraction
            // of its clients — see Deep repair for healing already-poisoned devices.)
            tracing::warn!(
                "apply_upsert: 0-row INSERT OR IGNORE for {}/{} (missing required column on a \
                 not-yet-created row); skipping clock record so a later create still applies",
                table, row_id
            );
            return Ok(());
        }
    } else {
        let set_clause: Vec<String> = winning
            .iter()
            .enumerate()
            .map(|(i, (c, _))| format!("{}=?{}", c, i + 1))
            .collect();
        let sql = format!(
            "UPDATE {} SET {} WHERE {}=?{}",
            table,
            set_clause.join(","),
            pk,
            winning.len() + 1
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = winning.iter().map(|(_, v)| json_to_sql(v)).collect();
        params.push(Box::new(row_id.to_string()));
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, refs.as_slice())?;
    }

    // Record clocks only for the columns we actually wrote, so any column we had
    // to skip (missing from the local schema) can still arrive on a future pull.
    let applied: serde_json::Map<String, serde_json::Value> =
        winning.iter().map(|(c, v)| (c.clone(), v.clone())).collect();
    update_row_clocks(table, row_id, &applied, hlc)?;
    Ok(())
}

fn apply_delete(table: &str, row_id: &str, hlc: Hlc) -> Result<()> {
    // LWW for deletes, symmetric with the upsert guard: the tombstone only wins
    // if it's NEWER than every existing column write on the row. Events arrive in
    // server-seq order (not causal), so a stale delete from an offline device can
    // land AFTER a newer edit — without this guard it would hard-delete the row
    // the newer edit should have kept, silently and unrecoverably (the edit is
    // already in sync_meta and won't re-apply).
    let newest = max_row_clock(table, row_id)?;
    // Keep the tombstone record monotonic: never let a stale delete downgrade a
    // newer tombstone (which would weaken the upsert guard).
    let existing_tomb = tombstone_clock(table, row_id)?;
    if existing_tomb.map_or(true, |t| hlc > t) {
        write_tombstone(table, row_id, hlc)?;
    }
    if let Some(latest) = newest {
        if hlc <= latest {
            tracing::info!(
                "apply_delete: stale tombstone for {}/{} (row has newer writes) — keeping row",
                table, row_id
            );
            return Ok(());
        }
    }
    let conn = pool().get()?;
    conn.execute(&format!("DELETE FROM {} WHERE {}=?1", table, primary_key(table)), [row_id])?;
    Ok(())
}

pub(crate) fn json_to_sql(v: &serde_json::Value) -> Box<dyn rusqlite::ToSql> {
    match v {
        serde_json::Value::Null => Box::new(Option::<String>::None),
        serde_json::Value::Bool(b) => Box::new(*b as i64),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(n.to_string())
            }
        }
        serde_json::Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

// ---------- Replay loop & file watcher ----------

fn read_event_file(path: &Path) -> Result<SyncEvent> {
    let bytes = std::fs::read(path).context("read event file")?;
    let is_encrypted = path
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(false, |n| n.ends_with(".enc.json"));

    if is_encrypted {
        let plain = sync_crypto::decrypt_from_wrapper(std::str::from_utf8(&bytes)?)?;
        Ok(serde_json::from_slice(&plain)?)
    } else {
        Ok(serde_json::from_slice(&bytes)?)
    }
}

async fn read_event_file_async(path: &Path) -> Result<SyncEvent> {
    let bytes = tokio::fs::read(path).await.context("read event file")?;
    let is_encrypted = path
        .file_name()
        .and_then(|n| n.to_str())
        .map_or(false, |n| n.ends_with(".enc.json"));

    if is_encrypted {
        let plain = sync_crypto::decrypt_from_wrapper(std::str::from_utf8(&bytes)?)?;
        Ok(serde_json::from_slice(&plain)?)
    } else {
        Ok(serde_json::from_slice(&bytes)?)
    }
}

pub async fn replay_all() -> Result<usize> {
    let dir = sync_dir();

    // Retire the old high-water-mark cursor. It permanently skipped any event
    // file whose name sorted at-or-below the mark — which happens routinely when
    // a peer's file (earlier wall-clock / HLC timestamp) is delivered by the
    // folder-sync layer AFTER we've already advanced past that time. Those events
    // were dropped forever. We now track replayed files individually by name, so
    // dropping the cursor here also triggers a one-time recovery rescan.
    {
        let conn = pool().get()?;
        let _ = conn.execute("DELETE FROM device_state WHERE key='last_replay_cursor'", []);
    }

    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "json"))
        .collect();
    // Apply in filename order (≈ HLC order) so causally-earlier events tend to
    // land first; correctness never depends on order (already_applied + LWW).
    entries.sort_by_key(|e| e.file_name());

    let mut count = 0;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip only files we have already replayed, by exact name — never by
        // timestamp ordering, so out-of-order arrivals are always applied.
        if file_replayed(&name).unwrap_or(false) {
            continue;
        }
        match read_event_file(&entry.path()) {
            Ok(event) => match apply_event(&event) {
                Ok(()) => {
                    count += 1;
                    let _ = mark_file_replayed(&name);
                }
                Err(e) => tracing::warn!("apply_event failed for {:?}: {}", entry.path(), e),
            },
            // Likely a partially-synced file; leave it unrecorded so we retry.
            Err(e) => tracing::warn!("read/parse failed {:?}: {}", entry.path(), e),
        }
    }

    Ok(count)
}

pub fn start_watcher() -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();
    let dir = sync_dir().to_path_buf();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<NotifyEvent>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                for path in event.paths {
                    if path.extension().map_or(false, |x| x == "json") {
                        let _ = tx.send(path);
                    }
                }
            }
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;

    // Leak the watcher so it lives for the process lifetime.
    Box::leak(Box::new(watcher));

    tauri::async_runtime::spawn(async move {
        while let Some(path) = rx.recv().await {
            if path.extension().map_or(false, |x| x == "json") {
                match read_event_file_async(&path).await {
                    Ok(event) => match apply_event(&event) {
                        Ok(()) => {
                            if let Some(n) = path.file_name().and_then(|x| x.to_str()) {
                                let _ = mark_file_replayed(n);
                            }
                        }
                        Err(e) => tracing::warn!("watcher apply failed {:?}: {}", path, e),
                    },
                    Err(e) => tracing::warn!("watcher read failed {:?}: {}", path, e),
                }
            }
        }
    });
    Ok(())
}
