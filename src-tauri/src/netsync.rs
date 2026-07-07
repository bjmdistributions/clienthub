//! Phase 2 — desktop network-sync client.
//!
//! When a server connection is configured (base URL + employee session token),
//! the desktop pushes its local sync events to the central server and pulls the
//! org's events back, so a hosted customer's desktop stays in sync WITHOUT a
//! shared sync folder. It is completely inert until a connection is configured —
//! BJM's existing folder-sync setup is unaffected.
//!
//! Reliability:
//!   - Outbound events persist in `netsync_outbound`, so nothing is lost across
//!     restarts or while offline; they're pushed (and removed) once back online.
//!   - Pull is idempotent: `sync::apply_remote` skips already-applied event ids,
//!     so pulling our own pushed events (which the server echoes into the org's
//!     pull log) is a harmless no-op — no echo loop.
//!   - Conflict resolution is the same per-column HLC LWW used by folder sync.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

use crate::db::pool;
use crate::sync::{self, SyncEvent};

const PUSH_BATCH: i64 = 200;
const POLL_SECS: u64 = 20;

/// The user-data tables a device clones via /api/sync/snapshot and compares via
/// /api/sync/counts. Must mirror the server's `SNAPSHOT_TABLES`. `staff_accounts`
/// arrives hash-stripped; `settings` is keyed by `key`; `deal_reps` by
/// `deal_flow_id` — both handled by `sync::primary_key`.
const SNAPSHOT_TABLES: &[&str] = &[
    "clients", "interactions", "invoices", "deals", "deal_flows", "suppliers",
    "supplier_price_history", "quotes", "inventory", "payment_methods", "payments",
    "scheduled_sends", "newsletter_schedules", "messages", "categories", "notes",
    "pending_approvals", "forms", "checkup_sessions", "checkup_items", "refunds",
    "client_credits", "rep_payouts", "intake_sources", "deal_reps", "staff_accounts",
    "settings",
];

pub fn ensure_tables() -> Result<()> {
    let conn = pool().get()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS netsync_outbound (
            event_id   TEXT PRIMARY KEY,
            event_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

// ---------- connection state (in device_state, which never syncs) ----------

fn state_get(key: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM device_state WHERE key=?1", [key], |r| r.get(0))
        .ok()
        .filter(|s: &String| !s.is_empty())
}

fn state_set(key: &str, val: &str) {
    if let Ok(conn) = pool().get() {
        let _ = conn.execute(
            "INSERT INTO device_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, val],
        );
    }
}

fn state_del(key: &str) {
    if let Ok(conn) = pool().get() {
        let _ = conn.execute("DELETE FROM device_state WHERE key=?1", [key]);
    }
}

pub struct NetConfig {
    pub url: String,
    pub token: String,
}

/// The active server connection, if one is configured.
pub fn config() -> Option<NetConfig> {
    Some(NetConfig {
        url: state_get("netsync_url")?,
        token: state_get("netsync_token")?,
    })
}

pub fn is_enabled() -> bool {
    config().is_some()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

// ---------- local → server (push) ----------

/// Queue a locally-recorded event for push. Called from `sync::record_*`. No-op
/// unless a server connection is configured.
pub fn on_local_event(event: &SyncEvent) {
    if !is_enabled() {
        return;
    }
    if let (Ok(json), Ok(conn)) = (serde_json::to_string(event), pool().get()) {
        let _ = conn.execute(
            "INSERT OR IGNORE INTO netsync_outbound (event_id, event_json, created_at) VALUES (?1,?2,?3)",
            rusqlite::params![event.id, json, chrono::Utc::now().to_rfc3339()],
        );
    }
}

/// Push all queued events to the server in batches, deleting each batch only on a
/// successful response. Leaves the queue intact on any failure so it retries.
pub async fn push_pending() -> Result<usize> {
    let cfg = match config() {
        Some(c) => c,
        None => return Ok(0),
    };
    let url = format!("{}/api/sync/push", cfg.url.trim_end_matches('/'));
    let mut total = 0;
    loop {
        let batch: Vec<(String, String)> = {
            let conn = pool().get()?;
            let mut stmt = conn.prepare(
                "SELECT event_id, event_json FROM netsync_outbound ORDER BY created_at LIMIT ?1",
            )?;
            let rows = stmt.query_map([PUSH_BATCH], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.flatten().collect()
        };
        if batch.is_empty() {
            break;
        }
        let events: Vec<serde_json::Value> = batch
            .iter()
            .filter_map(|(_, j)| serde_json::from_str(j).ok())
            .collect();
        let resp = http()
            .post(&url)
            .bearer_auth(&cfg.token)
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await
            .context("push request")?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            anyhow::bail!("unauthorized — sign in again");
        }
        if !resp.status().is_success() {
            anyhow::bail!("push failed: HTTP {}", resp.status());
        }
        let conn = pool().get()?;
        for (id, _) in &batch {
            let _ = conn.execute("DELETE FROM netsync_outbound WHERE event_id=?1", [id]);
        }
        total += batch.len();
        if (batch.len() as i64) < PUSH_BATCH {
            break;
        }
    }
    Ok(total)
}

// ---------- server → local (pull) ----------

#[derive(Deserialize)]
struct PullResp {
    events: Vec<SyncEvent>,
    cursor: i64,
}

/// Pull the org's events after our stored cursor and apply them locally, paging
/// until caught up. Idempotent — re-applying a seen event is a no-op.
pub async fn pull_apply() -> Result<usize> {
    let cfg = match config() {
        Some(c) => c,
        None => return Ok(0),
    };
    let base = cfg.url.trim_end_matches('/');
    // If a previous pass recorded a failed event but then hit a network error before it
    // could rewind (an early `?` return), honor that pending rewind now so the failed
    // event is re-pulled instead of being stranded below the advanced cursor.
    if let Some(pending) = state_get("netsync_rewind_pending").and_then(|s| s.parse::<i64>().ok()) {
        let cur: i64 = state_get("netsync_pull_cursor").and_then(|s| s.parse().ok()).unwrap_or(0);
        if pending < cur {
            state_set("netsync_pull_cursor", &pending.to_string());
        }
        state_set("netsync_rewind_pending", "");
    }
    let mut applied = 0;
    // Cursor of the first page in which an event FAILED to apply this pass. We keep
    // paging (so a later event — e.g. a not-yet-seen parent row — still gets applied),
    // then rewind the stored cursor to here so the failed events are RE-ATTEMPTED next
    // tick instead of being skipped forever. The old code advanced unconditionally,
    // permanently stranding any event that errored (the "stuck device" data-loss class).
    let mut earliest_failure: Option<i64> = None;
    loop {
        let cursor: i64 = state_get("netsync_pull_cursor")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let resp = http()
            .get(format!("{}/api/sync/pull?cursor={}", base, cursor))
            .bearer_auth(&cfg.token)
            .send()
            .await
            .context("pull request")?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            anyhow::bail!("unauthorized — sign in again");
        }
        if !resp.status().is_success() {
            anyhow::bail!("pull failed: HTTP {}", resp.status());
        }
        let body: PullResp = resp.json().await.context("pull decode")?;
        let n = body.events.len();
        let mut page_failed = false;
        for ev in &body.events {
            if let Err(e) = sync::apply_remote(ev) {
                tracing::warn!("netsync apply failed for {}: {}", ev.id, e);
                page_failed = true;
            } else {
                applied += 1;
            }
        }
        if page_failed && earliest_failure.is_none() {
            earliest_failure = Some(cursor);
            // Persist immediately so a later-page network error (an early return below)
            // can't lose the fact that this page needs re-pulling next tick.
            state_set("netsync_rewind_pending", &cursor.to_string());
        }
        // Advance the cursor only after applying, so a crash mid-page re-pulls it.
        state_set("netsync_pull_cursor", &body.cursor.to_string());
        if n == 0 || body.cursor <= cursor {
            break;
        }
    }

    // If anything failed this pass, rewind the stored cursor to the earliest failed
    // page so those events are retried next tick — but bound the retries so a genuinely
    // un-appliable ("poison") event advances after N tries (logged; run Deep repair to
    // recover) rather than re-pulling the same page forever.
    const MAX_STUCK_RETRIES: u32 = 5;
    match earliest_failure {
        Some(rewind) => {
            // We reached the end of the pass, so the crash-safety marker has done its job;
            // the bounded logic below owns the cursor from here.
            state_set("netsync_rewind_pending", "");
            let prev: i64 = state_get("netsync_stuck_cursor").and_then(|s| s.parse().ok()).unwrap_or(-1);
            let attempts: u32 = if prev == rewind {
                state_get("netsync_stuck_attempts").and_then(|s| s.parse().ok()).unwrap_or(0)
            } else {
                0
            };
            if attempts >= MAX_STUCK_RETRIES {
                tracing::error!(
                    "netsync: an event at/after cursor {} failed to apply {} times; advancing past it (logged) — run Deep repair if data is missing",
                    rewind, attempts
                );
                state_set("netsync_stuck_cursor", "");
                state_set("netsync_stuck_attempts", "0");
                // leave netsync_pull_cursor advanced (skip the poison event)
            } else {
                state_set("netsync_stuck_cursor", &rewind.to_string());
                state_set("netsync_stuck_attempts", &(attempts + 1).to_string());
                state_set("netsync_pull_cursor", &rewind.to_string());
            }
        }
        None => {
            if state_get("netsync_stuck_cursor").map(|s| !s.is_empty()).unwrap_or(false) {
                state_set("netsync_stuck_cursor", "");
                state_set("netsync_stuck_attempts", "0");
            }
        }
    }
    Ok(applied)
}

/// Background loop: push then pull every POLL_SECS. Safe to spawn unconditionally —
/// it no-ops while no connection is configured. When a pull APPLIES changes (e.g. a
/// pending client / approval was resolved on another device), emit `netsync-applied`
/// so the UI can refresh views like the approvals bell to post-sync state.
pub fn spawn_loop(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(POLL_SECS));
        loop {
            interval.tick().await;
            if !is_enabled() {
                continue;
            }
            if let Err(e) = push_pending().await {
                tracing::warn!("netsync push: {}", e);
            }
            match pull_apply().await {
                Ok(n) if n > 0 => {
                    // Remote changes landed locally — nudge the front-end to re-read
                    // (bell counts, approvals list, client list) from post-sync state.
                    let _ = app.emit("netsync-applied", n);
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("netsync pull: {}", e),
            }
        }
    });
}

/// Fire-and-forget an immediate push of queued local events. Called right after a
/// user action that must reach the server promptly (e.g. resolving an approval) so
/// other devices see the resolution without waiting for the next poll tick. No-op
/// when no server connection is configured.
pub fn push_now() {
    if !is_enabled() {
        return;
    }
    tauri::async_runtime::spawn(async {
        if let Err(e) = push_pending().await {
            tracing::warn!("netsync push_now: {}", e);
        }
    });
}

// ---------- connection management ----------

/// The signed-in account's identity from the server login body. Used to
/// materialize the account into an empty local store so login succeeds without
/// depending on the async pull restoring the RBAC rows.
#[derive(Deserialize, Clone, Default)]
pub struct ServerIdentity {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub org_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub role_id: String,
    #[serde(default)]
    pub role_name: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub phone: String,
}

#[derive(Deserialize)]
struct LoginResp {
    token: Option<String>,
    #[serde(default)]
    user: Option<ServerIdentity>,
}

/// Authenticate against the server WITHOUT touching local state — used to learn a
/// signing-in account's identity (esp. its org id) before deciding which local
/// store to use. Returns `(token, identity)`. Does not store the connection or
/// pull anything.
pub async fn probe_login(url: &str, email: &str, password: &str) -> Result<(String, ServerIdentity)> {
    let base = url.trim_end_matches('/').to_string();
    let resp = http()
        .post(format!("{}/api/auth/employee/login", base))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .context("login request")?;
    if !resp.status().is_success() {
        anyhow::bail!("login failed: HTTP {}", resp.status());
    }
    let body: LoginResp = resp.json().await.context("login decode")?;
    let token = body.token.context("server did not return a token")?;
    let identity = body.user.unwrap_or_default();
    Ok((token, identity))
}

/// Log in to the server, store the connection, and bootstrap by pulling the full
/// org history (cursor 0). Returns the account's identity (from the login body) so
/// the caller can claim/verify the active store AND materialize the account
/// locally.
pub async fn connect(url: &str, email: &str, password: &str) -> Result<ServerIdentity> {
    let base = url.trim_end_matches('/').to_string();
    let (token, identity) = probe_login(&base, email, password).await?;
    state_set("netsync_url", &base);
    state_set("netsync_token", &token);
    // Persist identity so diagnostics can show who/which org this device is bound to
    // without another round-trip.
    state_set("netsync_email", &identity.email);
    state_set("netsync_org", &identity.org_id);
    // Only reset the cursor on the very first connect (full bootstrap). On a
    // re-login (token refresh) keep the cursor so we pull incrementally rather
    // than re-downloading the whole org history every sign-in.
    if state_get("netsync_pull_cursor").is_none() {
        state_set("netsync_pull_cursor", "0");
    }
    pull_apply().await?;
    push_pending().await.ok(); // flush anything queued before connecting
    // If event replay left this device behind the server (poisoned clocks /
    // stranded rows), clone the current state directly. Runs at most once per
    // install; best-effort so a hiccup never blocks sign-in.
    auto_heal_if_behind().await;
    Ok(identity)
}

/// Clear the token (disables sync). Keeps the URL + cursor for a cheap reconnect.
pub fn disconnect() {
    state_del("netsync_token");
}

pub fn status_json() -> serde_json::Value {
    let pending: i64 = pool()
        .get()
        .ok()
        .and_then(|c| c.query_row("SELECT COUNT(*) FROM netsync_outbound", [], |r| r.get(0)).ok())
        .unwrap_or(0);
    serde_json::json!({
        "connected": is_enabled(),
        "url": state_get("netsync_url").unwrap_or_default(),
        "pending_push": pending,
        "pull_cursor": state_get("netsync_pull_cursor").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
    })
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn netsync_connect(url: String, email: String, password: String) -> Result<(), String> {
    connect(&url, &email, &password).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn netsync_status() -> serde_json::Value {
    status_json()
}

#[tauri::command]
pub fn netsync_disconnect() -> Result<(), String> {
    disconnect();
    Ok(())
}

/// Force an immediate sync cycle (used by the UI's "Sync now" affordance).
#[tauri::command]
pub async fn netsync_sync_now() -> Result<serde_json::Value, String> {
    let pushed = push_pending().await.map_err(|e| e.to_string())?;
    let pulled = pull_apply().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "pushed": pushed, "pulled": pulled }))
}

/// Repair a device that has fallen behind the server — e.g. earlier apply
/// failures that skipped rows before the pull cursor advanced past them, leaving
/// a device showing only a fraction of the workspace. Rewinds the pull cursor to
/// 0 and re-applies the entire org history. Idempotent: rows already present are
/// last-write-wins no-ops (nothing local is lost), while missing rows are
/// re-created. Finishes by flushing any queued local changes back up.
#[tauri::command]
pub async fn netsync_repair() -> Result<serde_json::Value, String> {
    if config().is_none() {
        return Err("Sign in to your workspace first, then run Repair.".into());
    }
    state_set("netsync_pull_cursor", "0");
    let reapplied = pull_apply().await.map_err(|e| e.to_string())?;
    let pushed = push_pending().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "reapplied": reapplied, "pushed": pushed }))
}

/// Deep repair — for a device that plain Repair CAN'T heal. Older builds could
/// record a "phantom clock" for a partial upsert that silently no-op'd on a
/// not-yet-created row (a NOT-NULL violation swallowed by INSERT OR IGNORE), then
/// mark the event applied — permanently blocking the real create event from ever
/// materializing the row. Plain Repair re-pulls but SKIPS already-applied events,
/// so it can never fix that. This wipes the sync bookkeeping (applied-event log,
/// per-column clocks, tombstones, replayed-file log) so the ENTIRE server history
/// re-applies from scratch, then re-pulls from cursor 0.
///
/// Safe: it does NOT delete any real data rows (clients/deals/invoices/…). Re-apply
/// is idempotent last-write-wins and rebuilds the clocks as it goes; any local
/// changes still queued are re-pushed at the end. Combined with the apply_upsert
/// fix (0-row inserts no longer record clocks), the re-pull can't re-poison itself.
#[tauri::command]
pub async fn netsync_repair_hard() -> Result<serde_json::Value, String> {
    if config().is_none() {
        return Err("Sign in to your workspace first, then run Deep repair.".into());
    }
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "DELETE FROM sync_meta;
             DELETE FROM row_clocks;
             DELETE FROM tombstones;
             DELETE FROM replayed_files;",
        )
        .map_err(|e| e.to_string())?;
    }
    state_set("netsync_pull_cursor", "0");
    let reapplied = pull_apply().await.map_err(|e| e.to_string())?;
    let pushed = push_pending().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "reapplied": reapplied, "pushed": pushed }))
}

// ---------- snapshot restore + auto-heal + diagnostics ----------

/// Fetch the server's current-state snapshot and UPSERT every row straight into the
/// local DB by primary key. This deliberately BYPASSES the oplog/LWW path
/// (`row_clocks`/`sync_meta` are never touched), so it always lands the server's
/// current row even on a device whose clocks are poisoned or whose event replay is
/// stranded — the surest heal when Repair / Deep repair still leave rows missing.
/// Only columns that exist locally are written (schema-drift safe), and both table
/// and column names are validated as plain identifiers before interpolation. Per-row
/// best-effort: a bad row is logged and skipped, never aborting the restore. Returns
/// `{ table: rows_applied, ... }`.
pub async fn restore_snapshot() -> Result<serde_json::Value> {
    let cfg = config().context("Sign in to your workspace first, then run Restore.")?;
    let base = cfg.url.trim_end_matches('/');
    // Capture the (table,row_id) keys queued locally BEFORE we drain the push queue.
    // Even if push succeeds HTTP-wise, the server can silently drop an event that fails
    // to apply (e.g. a column it lacks under version skew) while still returning 200 —
    // so we must never prune a row this device just pushed.
    let pushing: std::collections::HashSet<String> = {
        let mut set = std::collections::HashSet::new();
        if let Ok(conn) = pool().get() {
            if let Ok(mut stmt) = conn.prepare("SELECT event_json FROM netsync_outbound") {
                if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                    for j in rows.flatten() {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&j) {
                            let op = v.get("op");
                            let t = op.and_then(|o| o.get("table")).and_then(|x| x.as_str());
                            let rid = op.and_then(|o| o.get("row_id")).and_then(|x| x.as_str());
                            if let (Some(t), Some(rid)) = (t, rid) {
                                set.insert(format!("{}\u{0}{}", t, rid));
                            }
                        }
                    }
                }
            }
        }
        set
    };
    // Flush locally-queued changes to the server BEFORE mirroring its snapshot, so a
    // row created here but not yet pushed isn't seen as "missing on the server" and
    // pruned. If the push doesn't fully succeed we still heal missing rows but skip
    // pruning entirely (below) so unpushed local data can never be deleted.
    let pushed_ok = push_pending().await.is_ok();
    if !pushed_ok {
        tracing::warn!("restore_snapshot: local push incomplete — healing rows but NOT pruning");
    }
    let resp = http()
        .get(format!("{}/api/sync/snapshot", base))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .context("snapshot request")?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        anyhow::bail!("unauthorized — sign in again");
    }
    if !resp.status().is_success() {
        anyhow::bail!("snapshot failed: HTTP {}", resp.status());
    }
    #[derive(Deserialize)]
    struct SnapResp {
        #[serde(default)]
        tables: HashMap<String, Vec<serde_json::Map<String, serde_json::Value>>>,
    }
    let body: SnapResp = resp.json().await.context("snapshot decode")?;

    let mut applied = serde_json::Map::new();
    for (table, rows) in &body.tables {
        // Only clone into snapshot tables we recognize (defense-in-depth; the table
        // name is interpolated into SQL below).
        if !SNAPSHOT_TABLES.contains(&table.as_str()) {
            tracing::warn!("restore_snapshot: skipping unknown table {}", table);
            continue;
        }
        let conn = match pool().get() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("restore_snapshot: no conn for {}: {}", table, e);
                continue;
            }
        };
        let pk = sync::primary_key(table);
        let present = sync::existing_columns(&conn, table);
        let mut count: i64 = 0;
        for row in rows {
            // Keep only columns that exist locally, and require the primary key.
            let cols: Vec<&String> = row.keys().filter(|k| present.contains(*k)).collect();
            if !cols.iter().any(|c| c.as_str() == pk) {
                continue; // can't upsert without the key
            }
            // Validate every column name as a plain identifier before it reaches the
            // SQL text (same guard as `apply_upsert`).
            let mut safe = true;
            for c in &cols {
                if c.is_empty()
                    || c.as_bytes()[0].is_ascii_digit()
                    || !c.bytes().all(|b| b == b'_' || b.is_ascii_alphanumeric())
                {
                    tracing::warn!("restore_snapshot: unsafe column {:?} in {}", c, table);
                    safe = false;
                    break;
                }
            }
            if !safe {
                continue;
            }
            let col_names: Vec<String> = cols.iter().map(|c| (*c).clone()).collect();
            let placeholders: Vec<String> =
                (1..=col_names.len()).map(|i| format!("?{}", i)).collect();
            // UPSERT: set every non-PK column from the incoming row on conflict.
            let updates: Vec<String> = col_names
                .iter()
                .filter(|c| c.as_str() != pk)
                .map(|c| format!("{}=excluded.{}", c, c))
                .collect();
            let sql = if updates.is_empty() {
                format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) DO NOTHING",
                    table,
                    col_names.join(","),
                    placeholders.join(","),
                    pk
                )
            } else {
                format!(
                    "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) DO UPDATE SET {}",
                    table,
                    col_names.join(","),
                    placeholders.join(","),
                    pk,
                    updates.join(",")
                )
            };
            let params: Vec<Box<dyn rusqlite::ToSql>> =
                col_names.iter().map(|c| sync::json_to_sql(&row[c])).collect();
            let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            match conn.execute(&sql, refs.as_slice()) {
                Ok(_) => count += 1,
                Err(e) => {
                    tracing::warn!("restore_snapshot: row upsert failed for {}: {}", table, e);
                    continue;
                }
            }
        }

        // RECONCILE (mirror): remove stale local rows whose primary key isn't in the
        // server's set. This is what fixes WRONG TOTALS after a heal — leftover
        // deals/invoices that were deleted on the server but never removed here (they
        // inflate revenue / open-deal counts). SAFETY: only prune when the server
        // returned a NON-EMPTY set for this table — the server sends [] for a table it
        // failed to read, and pruning on that would mass-delete real local data. Never
        // prune the user's own account rows or device-local settings.
        // Never prune: the user's own account rows, device-local settings, and
        // deal_reps (keyed per-deal_flow, so a single-key DELETE could remove grouped
        // rows — and it doesn't affect the revenue/open-deal totals we're fixing).
        const NO_PRUNE: &[&str] = &["staff_accounts", "settings", "deal_reps"];
        // Only prune when the pre-push fully succeeded — otherwise a locally-created,
        // not-yet-pushed row would be absent from the server set and wrongly deleted.
        if pushed_ok && !NO_PRUNE.contains(&table.as_str()) && !rows.is_empty() {
            let server_pks: std::collections::HashSet<String> = rows
                .iter()
                .filter_map(|r| {
                    r.get(pk).map(|v| match v {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Number(n) => n.to_string(),
                        other => other.to_string(),
                    })
                })
                .collect();
            let local_pks: Vec<String> = {
                let mut v = Vec::new();
                if let Ok(mut stmt) =
                    conn.prepare(&format!("SELECT CAST({} AS TEXT) FROM {}", pk, table))
                {
                    if let Ok(rws) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                        for r in rws.flatten() {
                            v.push(r);
                        }
                    }
                }
                v
            };
            let mut pruned: i64 = 0;
            for lp in &local_pks {
                // Never prune a row this device just pushed (guards against the server
                // silently dropping a pushed event under schema drift), nor one still
                // present on the server.
                if !server_pks.contains(lp) && !pushing.contains(&format!("{}\u{0}{}", table, lp)) {
                    match conn.execute(&format!("DELETE FROM {} WHERE {}=?1", table, pk), [lp]) {
                        Ok(n) => pruned += n as i64,
                        Err(e) => tracing::warn!(
                            "restore_snapshot: prune failed for {}/{}: {}",
                            table, lp, e
                        ),
                    }
                }
            }
            if pruned > 0 {
                tracing::info!("restore_snapshot: pruned {} stale rows from {}", pruned, table);
            }
        }

        applied.insert(table.clone(), serde_json::Value::from(count));
    }
    Ok(serde_json::Value::Object(applied))
}

/// Server-side per-table row counts for the caller's org (best-effort). Returns an
/// empty map on any failure so callers can treat "unknown" as "don't heal".
pub async fn server_counts() -> HashMap<String, i64> {
    let cfg = match config() {
        Some(c) => c,
        None => return HashMap::new(),
    };
    let base = cfg.url.trim_end_matches('/');
    let resp = match http()
        .get(format!("{}/api/sync/counts", base))
        .bearer_auth(&cfg.token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return HashMap::new(),
    };
    #[derive(Deserialize)]
    struct CountsResp {
        #[serde(default)]
        counts: HashMap<String, i64>,
    }
    match resp.json::<CountsResp>().await {
        Ok(b) => b.counts,
        Err(_) => HashMap::new(),
    }
}

/// Local per-table row count for the snapshot tables.
fn local_counts() -> HashMap<String, i64> {
    let mut out = HashMap::new();
    if let Ok(conn) = pool().get() {
        for &tbl in SNAPSHOT_TABLES {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {}", tbl), [], |r| r.get(0))
                .unwrap_or(0);
            out.insert(tbl.to_string(), n);
        }
    }
    out
}

/// After the initial bootstrap pull, compare the server's `clients` count to this
/// device's. If the device is materially behind (fewer clients than the server), the
/// event replay left rows stranded — clone the current state directly. Gated to run
/// at most once per install via `netsync_autoheal_done` unless that flag is cleared.
async fn auto_heal_if_behind() {
    // v2 flag: re-runs once for installs that already healed under the old
    // clients-only check, so the mirror-reconcile (which also fixes wrong totals
    // from stale local rows) gets a chance to run.
    if state_get("netsync_autoheal_v2_done").is_some() {
        return;
    }
    let server = server_counts().await;
    if server.is_empty() {
        return; // couldn't reach server — don't heal blindly; a later connect retries
    }
    let local = local_counts();
    // Heal when this device DIVERGES from the server on any key table — in EITHER
    // direction: missing rows (behind) OR stale extra rows (which skew revenue /
    // open-deal totals). restore_snapshot upserts the server's rows AND prunes the
    // stale local ones, so a mismatch on any of these is enough to reconcile.
    let key_tables = ["clients", "invoices", "deals", "deal_flows", "payments"];
    let diverged = key_tables.iter().any(|t| {
        match server.get(*t) {
            Some(&sv) => *local.get(*t).unwrap_or(&0) != sv,
            None => false,
        }
    });
    if diverged {
        tracing::info!(
            "netsync auto-heal: local/server counts diverge (local={:?} server={:?}) — reconciling",
            local, server
        );
        match restore_snapshot().await {
            Ok(applied) => tracing::info!("netsync auto-heal: reconciled {:?}", applied),
            Err(e) => {
                tracing::warn!("netsync auto-heal: restore failed: {}", e);
                return; // don't mark done so a later connect retries
            }
        }
    }
    state_set("netsync_autoheal_v2_done", "1");
}

/// #[tauri::command] wrapper for the Settings "Restore from server" button.
#[tauri::command]
pub async fn netsync_restore_snapshot() -> Result<serde_json::Value, String> {
    restore_snapshot().await.map_err(|e| e.to_string())
}

/// Diagnostics for the Settings → Cloud sync card: connection identity, pull
/// position, and a local-vs-server row-count comparison so a user (or support) can
/// see at a glance whether the device is behind.
#[tauri::command]
pub async fn netsync_diagnostics(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let version = app.package_info().version.to_string();
    let local = local_counts();
    let server = server_counts().await;
    let server_json = if server.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::to_value(&server).unwrap_or(serde_json::Value::Null)
    };
    Ok(serde_json::json!({
        "version": version,
        "connected": is_enabled(),
        "url": state_get("netsync_url").unwrap_or_default(),
        "email": state_get("netsync_email").unwrap_or_default(),
        "org": state_get("netsync_org").unwrap_or_default(),
        "pull_cursor": state_get("netsync_pull_cursor").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
        "local_counts": local,
        "server_counts": server_json,
    }))
}

/// Fetch the signed-in workspace's plan + usage from the server (for the My Plan view).
/// Requires a server connection; errors clearly when offline / not signed in.
#[tauri::command]
pub async fn get_my_plan() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server to see your plan.")?;
    let resp = http()
        .get(format!("{}/api/org", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server — check your connection.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Push the org's shared email secrets (SMTP send password + primary IMAP monitor
/// password) up to the server's per-org settings store so sibling admins on other
/// devices can materialize them without re-typing. Called after an admin saves the
/// ORG send config. Best-effort: silently no-ops when offline / not signed in, and
/// only sends the passwords that are actually present in this device's keyring.
///
/// This is the WRITE half of the "secrets never sync in the oplog, but travel via
/// an authed server round-trip" bridge (mirrors `push_desktop_smtp_to_pi`, but
/// also carries the IMAP monitor password).
pub async fn push_email_secrets_to_server() -> Result<(), String> {
    let cfg = match config() { Some(c) => c, None => return Ok(()) };
    let smtp_pass = crate::email::cred_opt("smtp_pass").filter(|p| !p.is_empty());
    let imap_pass = crate::email::cred_opt("imap_pass").filter(|p| !p.is_empty());
    if smtp_pass.is_none() && imap_pass.is_none() {
        return Ok(());
    }
    let mut body = serde_json::Map::new();
    if let Some(p) = smtp_pass { body.insert("smtp_password".into(), serde_json::Value::String(p)); }
    if let Some(p) = imap_pass { body.insert("imap_password".into(), serde_json::Value::String(p)); }
    let resp = http()
        .put(format!("{}/api/settings/smtp", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

/// Push one org monitor-inbox's IMAP password to the server org store (keyed by
/// inbox id) so sibling admins can materialize it. Best-effort / no-op offline.
pub async fn push_inbox_secret_to_server(inbox_id: &str, password: &str) -> Result<(), String> {
    let cfg = match config() { Some(c) => c, None => return Ok(()) };
    let body = serde_json::json!({ "inbox_secrets": { inbox_id: password } });
    let resp = http()
        .put(format!("{}/api/settings/smtp", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

/// Materialize the org's shared email secrets into THIS device's keyring by
/// fetching them once from the server (admin-gated, same-org only). Only writes a
/// keyring entry that isn't already present, so a device that already has the
/// password is untouched. Returns the number of secrets newly cached.
///
/// This is the READ half of the secret bridge: on a fresh admin's device the org
/// config syncs down via the oplog but the keyring is empty, so the first scan
/// calls this to pull `smtp_pass` / `imap_pass` from the server org store.
pub async fn materialize_email_secrets_from_server() -> Result<u32, String> {
    let cfg = match config() { Some(c) => c, None => return Ok(0) };
    // The shared send/monitor secrets (`smtp_pass`/`imap_pass`) only apply to the
    // org account — never clobber a personal-override device's own keyring.
    let on_org = crate::email::use_org_default();
    let need_smtp = on_org && crate::email::cred_opt("smtp_pass").filter(|p| !p.is_empty()).is_none();
    let need_imap = on_org && crate::email::cred_opt("imap_pass").filter(|p| !p.is_empty()).is_none();
    // Any org monitor inbox whose per-inbox keyring secret is missing on this
    // device also needs materializing.
    let missing_inbox_ids: Vec<String> = crate::email::load_org_inboxes()
        .into_iter()
        .filter(|ib| crate::email::cred_opt(&format!("imap_pass_{}", ib.id)).filter(|p| !p.is_empty()).is_none())
        .map(|ib| ib.id)
        .collect();
    if !need_smtp && !need_imap && missing_inbox_ids.is_empty() {
        return Ok(0);
    }
    let resp = http()
        .get(format!("{}/api/settings/smtp?reveal=1", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Admin permission required.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut cached = 0u32;
    if need_smtp {
        if let Some(p) = body.get("smtp_password").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) {
            if crate::email::save_cred("smtp_pass", p).is_ok() { cached += 1; }
        }
    }
    if need_imap {
        if let Some(p) = body.get("imap_password").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) {
            if crate::email::save_cred("imap_pass", p).is_ok() { cached += 1; }
        }
    }
    // Per-inbox secrets come back under `inbox_secrets: { id: password }`.
    if let Some(map) = body.get("inbox_secrets").and_then(|v| v.as_object()) {
        for id in &missing_inbox_ids {
            if let Some(p) = map.get(id).and_then(|v| v.as_str()).filter(|p| !p.is_empty()) {
                if crate::email::save_cred(&format!("imap_pass_{}", id), p).is_ok() { cached += 1; }
            }
        }
    }
    Ok(cached)
}

/// Upload the current company logo bytes to the server so the hosted invoice
/// PDF renderer can draw it (the server never has the desktop's local logo
/// path). Reads `<app_data>/company_logo.png` — the single PNG that
/// `save_company_info` always writes — and POSTs it to the per-org, admin-gated
/// upload endpoint. No-op-friendly: callers can fire-and-forget after a save.
#[tauri::command]
pub async fn upload_company_logo() -> Result<(), String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let path = crate::db::app_data_dir().join("company_logo.png");
    let bytes = std::fs::read(&path).map_err(|_| "No logo saved yet.".to_string())?;
    let resp = http()
        .post(format!("{}/api/settings/company/logo", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .header("content-type", "image/png")
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server — check your connection.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Admin permission required to sync the logo.".into());
    }
    if resp.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err("Logo is too large — use an image under 1 MB.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

/// Platform-owner (superadmin) signups overview: every workspace with owner email,
/// plan, signup date and usage. Server gates this to the org_default owner.
#[tauri::command]
pub async fn get_platform_signups() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/admin/sync-health", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Superadmin only.".into());
    }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}
