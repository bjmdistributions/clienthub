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
use std::time::Duration;

use crate::db::pool;
use crate::sync::{self, SyncEvent};

const PUSH_BATCH: i64 = 200;
const POLL_SECS: u64 = 20;

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
    let mut applied = 0;
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
        for ev in &body.events {
            if let Err(e) = sync::apply_remote(ev) {
                tracing::warn!("netsync apply failed for {}: {}", ev.id, e);
            } else {
                applied += 1;
            }
        }
        // Advance the cursor only after applying, so a crash mid-page re-pulls it.
        state_set("netsync_pull_cursor", &body.cursor.to_string());
        if n == 0 || body.cursor <= cursor {
            break;
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
    // Only reset the cursor on the very first connect (full bootstrap). On a
    // re-login (token refresh) keep the cursor so we pull incrementally rather
    // than re-downloading the whole org history every sign-in.
    if state_get("netsync_pull_cursor").is_none() {
        state_set("netsync_pull_cursor", "0");
    }
    pull_apply().await?;
    push_pending().await.ok(); // flush anything queued before connecting
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
