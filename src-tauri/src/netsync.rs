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

/// What `auto_heal_if_behind` currently covers. Bump ONLY when the heal check
/// widens (e.g. new tables in `key_tables`), so devices gated off under a narrower
/// check get one more pass — without re-healing the fleet on every release.
/// "3" = the generation that added the financial tables.
const HEAL_GENERATION: &str = "3";

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
    // Financial engine tables — the server already snapshots these; without them a
    // device that missed events (or a fresh install) could never heal its ledger via
    // Repair sync. Restore is UPSERT-only, so this only ADDS rows, never prunes.
    "bank_txn", "bank_allocation", "cash_purchase", "business_expense", "reserve_entry", "loan", "deal_receipts",
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

/// NOTE: "a token string is stored", NOT "sync works" — an expired token is
/// indistinguishable from a live one here. Health is `auth_state()`.
pub fn is_enabled() -> bool {
    config().is_some()
}

/// The server accepted this device's credential. `key` is the stamp for the leg
/// that succeeded (`netsync_last_pull_at` / `netsync_last_push_at`), recorded only
/// on a real 2xx so status can never show green off an assumption.
fn note_sync_ok(key: &str) {
    state_set(key, &chrono::Utc::now().to_rfc3339());
    state_del("netsync_auth_lost");
}

/// The server rejected this device and a refresh couldn't save it: the user must
/// sign in again. Sticky until a call actually succeeds.
fn note_auth_lost() {
    state_set("netsync_auth_lost", "1");
}

/// Trade the stored token for a fresh one. The server accepts a recently-expired
/// token, so a device that was merely closed for a while heals itself. Stores and
/// returns the new token.
async fn refresh_token(base: &str, token: &str) -> Result<String> {
    let resp = http()
        .post(format!("{}/api/auth/employee/refresh", base))
        .bearer_auth(token)
        .send()
        .await
        .context("refresh request")?;
    if !resp.status().is_success() {
        anyhow::bail!("refresh failed: HTTP {}", resp.status());
    }
    let body: LoginResp = resp.json().await.context("refresh decode")?;
    let new_token = body.token.context("refresh returned no token")?;
    state_set("netsync_token", &new_token);
    tracing::info!("netsync: session token refreshed");
    Ok(new_token)
}

/// How long after the last server-confirmed pull/push this device still counts as
/// live. Three poll ticks — long enough to ride out one missed tick or a blip,
/// short enough that a device that genuinely stopped talking stops reading green.
const STALE_AFTER_SECS: i64 = (POLL_SECS as i64) * 3;

/// Honest sync health: `auth_lost` (server rejected us — user action needed), `ok`
/// (server confirmed a pull/push within STALE_AFTER_SECS), else `offline`.
fn auth_state() -> &'static str {
    if !is_enabled() {
        return "offline";
    }
    if state_get("netsync_auth_lost").is_some() {
        return "auth_lost";
    }
    let newest = ["netsync_last_pull_at", "netsync_last_push_at"]
        .iter()
        .filter_map(|k| state_get(k))
        .filter_map(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .max();
    match newest {
        Some(t) if (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() <= STALE_AFTER_SECS => "ok",
        _ => "offline",
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

// ---------- local → server (push) ----------

/// Queue a locally-recorded event for push. Called from `sync::record_*`.
///
/// Enqueue is UNCONDITIONAL — deliberately not gated on `is_enabled()`. A write made
/// while disconnected / signed-out / auth-lost is precisely the write that exists in
/// only one place, and gating here dropped it with no trace: the row lived on locally
/// while no event ever reached the server, and restore then read that absence as
/// "deleted upstream" and pruned the only copy. Only PUSHING is gated on being
/// configured + authed (`push_pending` / `push_now` / `spawn_loop`); the durable record
/// is not. This is also what `connect`'s "flush anything queued before connecting"
/// push has always assumed.
///
/// No age/count cap, on purpose: the queue is the only durable evidence that a local
/// write has not reached the server, so evicting the oldest entries would delete
/// exactly the events least likely to have been pushed — these are the books. Growth is
/// self-limiting: local events are ~700 bytes and a heavy day is ~1k events (well under
/// 1 MB/day, and SQLite does not care), and the queue drains to empty on the first poll
/// tick after a connection exists.
pub fn on_local_event(event: &SyncEvent) {
    // A swallowed failure here is the very bug this function exists to prevent, so it
    // is logged loudly rather than dropped on the floor (`ensure_tables` only warns on
    // failure, so a missing queue table is reachable).
    let queued = (|| -> Result<()> {
        let json = serde_json::to_string(event)?;
        pool().get()?.execute(
            "INSERT OR IGNORE INTO netsync_outbound (event_id, event_json, created_at) VALUES (?1,?2,?3)",
            rusqlite::params![event.id, json, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    })();
    if let Err(e) = queued {
        tracing::error!(
            "netsync: FAILED to queue local event {} — this write may never reach the server: {}",
            event.id, e
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
    let base = cfg.url.trim_end_matches('/').to_string();
    let url = format!("{}/api/sync/push", base);
    let mut token = cfg.token;
    // One refresh attempt per pass — a token that's still rejected after a fresh
    // mint is a real sign-out, not an expiry, and retrying can't fix it.
    let mut refreshed = false;
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
            .bearer_auth(&token)
            .json(&serde_json::json!({ "events": events }))
            .send()
            .await
            .context("push request")?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Nothing was deleted from the queue, so re-entering the loop re-selects
            // and re-sends this exact batch with the new token.
            if !refreshed {
                refreshed = true;
                match refresh_token(&base, &token).await {
                    Ok(t) => {
                        token = t;
                        continue;
                    }
                    Err(e) => tracing::warn!("netsync push: token refresh failed: {}", e),
                }
            }
            note_auth_lost();
            anyhow::bail!("unauthorized — sign in again");
        }
        if !resp.status().is_success() {
            anyhow::bail!("push failed: HTTP {}", resp.status());
        }
        note_sync_ok("netsync_last_push_at");
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
    let base = cfg.url.trim_end_matches('/').to_string();
    let mut token = cfg.token;
    // One refresh attempt per pass — see push_pending.
    let mut refreshed = false;
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
            .bearer_auth(&token)
            .send()
            .await
            .context("pull request")?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Nothing was applied and the cursor is untouched, so re-entering the loop
            // re-issues this exact request with the new token.
            if !refreshed {
                refreshed = true;
                match refresh_token(&base, &token).await {
                    Ok(t) => {
                        token = t;
                        continue;
                    }
                    Err(e) => tracing::warn!("netsync pull: token refresh failed: {}", e),
                }
            }
            note_auth_lost();
            anyhow::bail!("unauthorized — sign in again");
        }
        if !resp.status().is_success() {
            anyhow::bail!("pull failed: HTTP {}", resp.status());
        }
        note_sync_ok("netsync_last_pull_at");
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
        let mut ticks: u32 = 0;
        loop {
            interval.tick().await;
            // Runs on the first tick (an immediate baseline at startup) and every
            // CHECK_EVERY_TICKS after. Sits ABOVE the is_enabled gate on purpose: the
            // orphan-link invariant is about this device's books and holds whether or
            // not a server is configured.
            if ticks % CHECK_EVERY_TICKS == 0 {
                run_invariant_checks();
            }
            ticks = ticks.wrapping_add(1);
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
    // The login just succeeded, so any earlier auth-lost verdict is stale — clear it
    // now rather than leaving a red "signed out" up until the first pull confirms.
    state_del("netsync_auth_lost");
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
    // Pull any org-shared connection secrets this device is missing (email, Stripe,
    // Google, Shopify, Plaid keys + linked banks) so a fresh admin inherits the
    // team's connections without re-typing. Best-effort — only writes what's absent.
    let _ = materialize_all_secrets_from_server().await;
    // Baseline the invariants for this store now that the bootstrap pull and any heal
    // have landed, rather than leaving the panel blank until the first periodic check.
    run_invariant_checks();
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
        // "a server is configured" — NOT health. Read `auth` for that.
        "connected": is_enabled(),
        "url": state_get("netsync_url").unwrap_or_default(),
        "pending_push": pending,
        "pull_cursor": state_get("netsync_pull_cursor").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
        "auth": auth_state(),
        "last_pull_at": state_get("netsync_last_pull_at").unwrap_or_default(),
        "last_push_at": state_get("netsync_last_push_at").unwrap_or_default(),
        // Last result of `run_invariant_checks` — stored rather than recomputed here,
        // because the UI re-reads status far more often than the checks are worth
        // running. `invariants_at` is how stale the verdict is.
        "invariants": state_get("netsync_invariants")
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .unwrap_or_else(|| serde_json::json!([])),
        "invariants_at": state_get("netsync_invariants_at").unwrap_or_default(),
    })
}

// ---------- standing invariant checks ----------

/// Poll ticks between self-checks (~30 min at POLL_SECS=20). The checks read two
/// small tables — too much to repeat on every 20s tick, nothing at this spacing.
const CHECK_EVERY_TICKS: u32 = 90;

/// A local change still queued this long WHILE the server is answering our calls
/// means the push leg is failing silently. Well clear of a normal backlog: a
/// reconnecting device drains its whole queue inside one `push_pending` pass.
const QUEUE_STALL_SECS: i64 = 15 * 60;

/// Assert the invariants this build actually holds, and LOG whatever breaks them.
///
/// A smoke alarm, not a repair crew: it never mutates data. The repairs already exist
/// (`cleanup_orphan_allocations`, Repair sync, Restore from server) and stay the
/// user's to run — a check that silently "fixed" the books would destroy the evidence
/// of the defect that caused the divergence. Findings go to the daily file log at
/// error level and into `status_json` for the Settings panel.
///
/// Deliberately NOT checked — neither is an invariant this build holds:
///   - "every local row reached the server or sits in netsync_outbound": undecidable
///     on this device. A drained queue cannot distinguish "pushed and accepted" from
///     "written while disconnected and never queued", and the server can drop a pushed
///     event and still answer 200 (`restore_snapshot`'s reconcile note works through
///     exactly this). Proving it needs per-event acks. The queue check below is the
///     half that IS observable: work that got queued is still moving.
///   - "the pull cursor never went backwards": it deliberately goes backwards, and
///     those are the healthy paths — rewind-on-apply-failure, Repair, Deep repair.
///     Nothing else writes it: the only other writer stores the server's cursor, and
///     `pull_events` seeds `max_seq` with the caller's cursor and only ever raises it,
///     so a smaller value can't come back. There is no unintentional regression left
///     to detect, so the check could only fire on a deliberate rewind.
fn run_invariant_checks() {
    let mut findings: Vec<String> = Vec::new();
    if let Ok(conn) = pool().get() {
        // INVARIANT: queued local work reaches the server. Only meaningful while the
        // server is confirming our calls — an offline device is SUPPOSED to hold a
        // backlog, and saying otherwise would cry wolf on every closed laptop.
        if auth_state() == "ok" {
            let queued: Option<(i64, Option<String>)> = conn
                .query_row("SELECT COUNT(*), MIN(created_at) FROM netsync_outbound", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .ok();
            if let Some((n, Some(oldest))) = queued {
                let age = chrono::DateTime::parse_from_rfc3339(&oldest)
                    .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds())
                    .unwrap_or(0);
                if n > 0 && age > QUEUE_STALL_SECS {
                    findings.push(format!(
                        "{} local change(s) have been waiting to upload for {} min while the server is reachable — this device is holding the only copy",
                        n,
                        age / 60
                    ));
                }
            }
        }

        // INVARIANT: no allocation points at a bank transaction that no longer exists.
        // Re-importing a statement replaces txn ids and can strand the allocations that
        // referenced them. The money SUMs are guarded with EXISTS(bank_txn) so an orphan
        // no longer doubles a deal's profit, but it still means a link the user made is
        // silently doing nothing.
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM bank_allocation a
                 WHERE NOT EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if orphans > 0 {
            findings.push(format!(
                "{} bank link(s) point at a transaction that no longer exists — open Deal flow to clear them",
                orphans
            ));
        }
    }

    for f in &findings {
        tracing::error!("invariant check: {}", f);
    }
    state_set(
        "netsync_invariants",
        &serde_json::to_string(&findings).unwrap_or_else(|_| "[]".into()),
    );
    state_set("netsync_invariants_at", &chrono::Utc::now().to_rfc3339());
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
    // Flush locally-queued changes to the server BEFORE mirroring its snapshot, so the
    // rows applied below are as current as possible. Best-effort: the mirror below never
    // deletes, so a failed push no longer costs data — it only means the snapshot may lag
    // this device.
    if let Err(e) = push_pending().await {
        tracing::warn!("restore_snapshot: local push incomplete: {}", e);
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

        // RECONCILE (mirror): REPORT local rows whose primary key isn't in the server's
        // set — never delete them. Deleting one requires positive proof the server holds
        // that row's data, and this device cannot produce that proof for any candidate:
        // a candidate is by definition absent from the snapshot; an empty
        // `netsync_outbound` cannot tell "pushed and accepted" apart from "written while
        // disconnected and never queued"; and the server can drop a pushed event that
        // fails to apply while still returning 200. Absence of evidence never authorises
        // a delete, so the row is kept and logged. The cost is stale rows skewing totals
        // (a leftover deal/invoice inflates revenue / open-deal counts) until per-event
        // acks make proof possible — recoverable, unlike deleting the only copy of
        // unsynced work.
        // Not reported: tables the mirror never considered anyway — the user's own
        // account rows, device-local settings, and deal_reps (keyed per-deal_flow, so its
        // keys aren't row-unique) — and tables the server returned [] for, which it also
        // does for a table it failed to read.
        const NO_PRUNE: &[&str] = &["staff_accounts", "settings", "deal_reps"];
        if !NO_PRUNE.contains(&table.as_str()) && !rows.is_empty() {
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
            let kept: Vec<&String> = local_pks
                .iter()
                .filter(|lp| !server_pks.contains(*lp))
                .collect();
            if !kept.is_empty() {
                // Bounded sample: this runs against every table and is written to the
                // daily log file.
                let sample: Vec<&str> = kept.iter().take(20).map(|s| s.as_str()).collect();
                tracing::warn!(
                    "restore_snapshot: KEPT {} local {} row(s) absent from the server snapshot \
                     — no proof they ever reached the server, so they were NOT deleted \
                     (may skew totals; ids: {}{})",
                    kept.len(),
                    table,
                    sample.join(","),
                    if kept.len() > sample.len() { ", …" } else { "" }
                );
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
/// at most once per heal GENERATION via `netsync_autoheal_gen`.
async fn auto_heal_if_behind() {
    // Keyed by what heal COVERS, not by app version: the old one-shot flag ('1',
    // already set on shipped devices) gated heal off forever, but keying on the
    // version instead would re-heal every device on every release — a heal storm
    // for releases that don't change heal at all. Bump HEAL_GENERATION only when
    // the coverage below widens; devices that healed under a narrower check then
    // get exactly one more pass. Costs nothing otherwise — returns before the
    // network.
    if state_get("netsync_autoheal_gen").as_deref() == Some(HEAL_GENERATION) {
        return;
    }
    let server = server_counts().await;
    if server.is_empty() {
        return; // couldn't reach server — don't heal blindly; a later connect retries
    }
    let local = local_counts();
    // Heal when this device DIVERGES from the server on any key table — in EITHER
    // direction: missing rows (behind) OR stale extra rows (which skew revenue /
    // open-deal totals). restore_snapshot upserts the server's rows but never deletes
    // local ones, so it fixes the missing-rows direction and only REPORTS extra rows.
    // Financial tables included: these are exactly the ones that went missing on the
    // Mac, and heal skipping them meant a device could never recover its ledger.
    let key_tables = [
        "clients", "invoices", "deals", "deal_flows", "payments",
        "bank_txn", "bank_allocation", "deal_receipts", "cash_purchase",
        "business_expense", "reserve_entry", "loan",
    ];
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
    state_set("netsync_autoheal_gen", HEAL_GENERATION);
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

// ---------- connection sharing: ALL sharable secrets ↔ server org store ----------

/// Org `settings` keys (NOT keyring-backed) that carry sharable secrets: the
/// Shopify webhook secret and the Plaid client_id/secret. These are materialized
/// straight into the local `settings` table, never into the encrypted keyring.
const SHARABLE_SETTINGS_KEYS: [&str; 3] = ["shopify_webhook_secret", "plaid_client_id", "plaid_secret"];

/// Read a `settings` value (trimmed, non-empty) from the local DB.
fn settings_get(key: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Write a `settings` value locally (device-local plain execute — never synced).
fn settings_put(key: &str, val: &str) {
    if let Ok(conn) = pool().get() {
        let _ = conn.execute(
            "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, val],
        );
    }
}

/// Push EVERY sharable connection secret this device holds up to the org store so
/// teammates on other devices can materialize them without re-typing — the
/// "Share my connections with my team" action. Carries: SMTP/IMAP passwords
/// (shared + each org monitor inbox), Stripe keys, Google refresh tokens, the
/// Shopify webhook secret, the Plaid client_id/secret, and every linked Plaid item
/// (as JSON under `plaid_item_{item_id}`). Best-effort: no-ops (Ok(0)) when offline
/// / not signed in, and only sends the secrets actually present locally. Returns
/// the number of secrets sent.
///
/// WRITE half of the bridge (mirrors `push_email_secrets_to_server`, widened).
pub async fn push_all_secrets_to_server() -> Result<u32, String> {
    let cfg = match config() { Some(c) => c, None => return Ok(0) };
    let mut secrets = serde_json::Map::new();

    // Keyring-backed credentials (via the encrypted secret_store).
    for key in ["smtp_pass", "imap_pass", "stripe_publishable_key", "stripe_secret_key",
                "stripe_webhook_secret", "oauth_refresh_token", "gcontacts_refresh_token"] {
        if let Some(v) = crate::email::cred_opt(key).filter(|p| !p.is_empty()) {
            secrets.insert(key.into(), serde_json::Value::String(v));
        }
    }
    // Per-org-inbox IMAP passwords (keyed `imap_pass_{id}`).
    for ib in crate::email::load_org_inboxes() {
        let k = format!("imap_pass_{}", ib.id);
        if let Some(v) = crate::email::cred_opt(&k).filter(|p| !p.is_empty()) {
            secrets.insert(k, serde_json::Value::String(v));
        }
    }
    // Settings-backed secrets (Shopify webhook + Plaid keys).
    for key in SHARABLE_SETTINGS_KEYS {
        if let Some(v) = settings_get(key) {
            secrets.insert(key.into(), serde_json::Value::String(v));
        }
    }
    // Each linked Plaid item, serialized as a JSON string under `plaid_item_{item_id}`.
    if let Ok(conn) = pool().get() {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT item_id, access_token, institution, accounts_json, env FROM plaid_items",
        ) {
            let rows: Vec<serde_json::Value> = stmt
                .query_map([], |r| Ok(serde_json::json!({
                    "item_id": r.get::<_, String>(0)?,
                    "access_token": r.get::<_, String>(1)?,
                    "institution": r.get::<_, String>(2)?,
                    "accounts_json": r.get::<_, String>(3)?,
                    "env": r.get::<_, String>(4)?,
                })))
                .map(|it| it.flatten().collect())
                .unwrap_or_default();
            for row in rows {
                if let Some(item_id) = row.get("item_id").and_then(|v| v.as_str()) {
                    secrets.insert(format!("plaid_item_{}", item_id), serde_json::Value::String(row.to_string()));
                }
            }
        }
    }

    if secrets.is_empty() {
        return Ok(0);
    }
    let count = secrets.len() as u32;
    let resp = http()
        .put(format!("{}/api/org-secrets", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({ "secrets": secrets }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server — check your connection.".to_string())?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Admin permission required.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(count)
}

/// Materialize the org's shared connection secrets into THIS device by fetching
/// them once from the server (admin-gated, same-org). Only writes a secret that is
/// MISSING locally, so a device that already holds it is untouched. Routes each
/// returned key to the right store: keyring creds (smtp/imap/stripe/oauth/gcontacts),
/// settings values (Shopify + Plaid keys), and `plaid_item_{id}` rows into
/// `plaid_items`. Best-effort: no-op offline / not signed in. Returns count cached.
///
/// READ half of the bridge (mirrors `materialize_email_secrets_from_server`).
pub async fn materialize_all_secrets_from_server() -> Result<u32, String> {
    let cfg = match config() { Some(c) => c, None => return Ok(0) };
    let resp = http()
        .get(format!("{}/api/org-secrets/materialize", cfg.url.trim_end_matches('/')))
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
    let obj = match body.as_object() { Some(o) => o, None => return Ok(0) };
    let mut cached = 0u32;
    for (skey, val) in obj {
        let value = match val.as_str().filter(|s| !s.is_empty()) { Some(v) => v, None => continue };
        if let Some(item_id) = skey.strip_prefix("plaid_item_") {
            if materialize_plaid_item(item_id, value) { cached += 1; }
        } else if SHARABLE_SETTINGS_KEYS.contains(&skey.as_str()) {
            if settings_get(skey).is_none() { settings_put(skey, value); cached += 1; }
        } else {
            // Everything else is a keyring-backed credential.
            if crate::email::cred_opt(skey).filter(|p| !p.is_empty()).is_none()
                && crate::email::save_cred(skey, value).is_ok() { cached += 1; }
        }
    }
    Ok(cached)
}

/// Insert a Plaid item shared by a teammate into this device's `plaid_items` if it
/// isn't already present. `payload` is the JSON string emitted by
/// `push_all_secrets_to_server`. Returns true when a new row was written.
fn materialize_plaid_item(item_id: &str, payload: &str) -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return false };
    let exists: bool = conn.query_row("SELECT 1 FROM plaid_items WHERE item_id=?1", [item_id], |_| Ok(())).is_ok();
    if exists { return false; }
    let row: serde_json::Value = match serde_json::from_str(payload) { Ok(v) => v, Err(_) => return false };
    let access = match row.get("access_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        Some(a) => a, None => return false,
    };
    let inst = row.get("institution").and_then(|v| v.as_str()).unwrap_or("Bank");
    let accounts_json = row.get("accounts_json").and_then(|v| v.as_str()).unwrap_or("[]");
    let env = row.get("env").and_then(|v| v.as_str()).unwrap_or("production");
    let id = format!("pi_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO plaid_items (id, item_id, access_token, institution, cursor, accounts_json, created_at, env)
         VALUES (?1,?2,?3,?4,'',?5,?6,?7)",
        rusqlite::params![id, item_id, access, inst, accounts_json, now, env],
    ).is_ok()
}

/// Best-effort: hand a freshly-linked Plaid item's token to the server so the org's
/// hosted sync (and teammates) can use it. No-op offline / not signed in — the
/// device-local `plaid_items` row remains the fallback either way.
pub async fn push_plaid_item_to_server(
    item_id: &str,
    access_token: &str,
    institution: &str,
    accounts_json: &str,
    env: &str,
) -> Result<(), String> {
    let cfg = match config() { Some(c) => c, None => return Ok(()) };
    let resp = http()
        .post(format!("{}/api/plaid/items", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({
            "item_id": item_id,
            "access_token": access_token,
            "institution": institution,
            "accounts_json": accounts_json,
            "env": env,
        }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
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

/// Upload ONE inventory photo's bytes to the server so the hosted storefront can display
/// it from any device. Photo files don't travel over the DB sync oplog (only the
/// photos_json path text does), so a photo added on a device without a media bridge to the
/// host would otherwise never reach the server. `rel` is the photos_json entry, e.g.
/// "media/inventory/<lot>/photos/photo_001.jpg". Best-effort — callers ignore failures
/// (the local copy still exists; a later save or backfill retries).
pub async fn upload_inventory_photo(lot_id: &str, rel: &str) -> Result<(), String> {
    let cfg = config().ok_or("not signed in")?;
    let name = rel.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.contains("..") {
        return Err("bad photo path".into());
    }
    let local = crate::db::app_data_dir().join("sync").join(rel);
    let bytes = std::fs::read(&local).map_err(|e| e.to_string())?;
    let ctype = if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    let resp = http()
        .post(format!("{}/api/inventory/{}/photo/{}", cfg.url.trim_end_matches('/'), lot_id, name))
        .bearer_auth(&cfg.token)
        .header("content-type", ctype)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "couldn't reach the server".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
    }
    Ok(())
}

/// Upload a lot's manifest FILE to the server so the public storefront can serve it
/// (the sync oplog only carries the manifest_path text, not the bytes). `rel` is the
/// stored path "media/inventory/<lot>/manifest.<ext>".
pub async fn upload_inventory_manifest(lot_id: &str, rel: &str) -> Result<(), String> {
    let cfg = config().ok_or("not signed in")?;
    let name = rel.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.contains("..") {
        return Err("bad manifest path".into());
    }
    let local = crate::db::app_data_dir().join("sync").join(rel);
    let bytes = std::fs::read(&local).map_err(|e| e.to_string())?;
    let ctype = if name.ends_with(".pdf") {
        "application/pdf"
    } else if name.ends_with(".csv") || name.ends_with(".tsv") || name.ends_with(".txt") {
        "text/csv"
    } else {
        "application/octet-stream"
    };
    let resp = http()
        .post(format!("{}/api/inventory/{}/manifest/{}", cfg.url.trim_end_matches('/'), lot_id, name))
        .bearer_auth(&cfg.token)
        .header("content-type", ctype)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "couldn't reach the server".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("server returned {}", resp.status()));
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

/// Early-access waitlist signups (superadmin). Server returns a bare JSON array.
#[tauri::command]
pub async fn admin_waitlist_all() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/waitlist/all", cfg.url.trim_end_matches('/')))
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

/// Feedback / bug reports (superadmin). Server returns a bare JSON array.
#[tauri::command]
pub async fn admin_feedback_all() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/feedback/all", cfg.url.trim_end_matches('/')))
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

/// Superadmin: set any workspace's plan tier (free|pro|business|unlimited|founder).
#[tauri::command]
pub async fn admin_set_org_plan(org_id: String, plan: String) -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .post(format!("{}/api/admin/org/plan", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({ "org_id": org_id, "plan": plan }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("Superadmin only.".into());
    }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Workspace not found.".into());
    }
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        return Err("Invalid plan.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Superadmin: permanently delete a whole workspace (org) and all its data.
/// The server guards against deleting `org_default` or the caller's own workspace.
#[tauri::command]
pub async fn admin_delete_workspace(org_id: String) -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .delete(format!("{}/api/admin/workspace/{}", cfg.url.trim_end_matches('/'), org_id))
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
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Workspace not found.".into());
    }
    if !resp.status().is_success() {
        // Surface the server's explanation (e.g. "You can't delete your own
        // workspace here.") when it sends a JSON error body, else the status.
        let status = resp.status();
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            if let Some(msg) = body.get("error").and_then(|v| v.as_str()) {
                return Err(msg.to_string());
            }
        }
        return Err(format!("Server returned {}", status));
    }
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

/// Superadmin: per-org onboarding signals (who's set up, who's stuck).
#[tauri::command]
pub async fn admin_onboarding() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/admin/onboarding", cfg.url.trim_end_matches('/')))
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

/// Superadmin: every signed-up user across all workspaces (owner's god-view).
#[tauri::command]
pub async fn admin_platform_users() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/admin/platform-users", cfg.url.trim_end_matches('/')))
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

/// Superadmin: preview how many recipients a broadcast would reach. The broadcast
/// endpoints answer 200 with an `error` field on failure (superadmin gate etc.),
/// so surface that as a command error rather than trusting the HTTP status alone.
#[tauri::command]
pub async fn admin_broadcast_preview(
    include_accounts: bool,
    include_waitlist: bool,
) -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .post(format!("{}/api/admin/broadcast/preview", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({
            "include_accounts": include_accounts,
            "include_waitlist": include_waitlist,
        }))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = body.get("error").and_then(|v| v.as_str()) {
        return Err(e.to_string());
    }
    Ok(body)
}

/// Superadmin: send the broadcast. The UI gates this behind an explicit two-step
/// confirm; this command just proxies. Surfaces the server's `error` body (e.g.
/// "Platform email is not configured") as a command error.
#[tauri::command]
pub async fn admin_broadcast_send(
    subject: String,
    body: String,
    include_accounts: bool,
    include_waitlist: bool,
    emails: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let mut payload = serde_json::json!({
        "subject": subject,
        "body": body,
        "include_accounts": include_accounts,
        "include_waitlist": include_waitlist,
    });
    // Explicit recipient list from the composer's checklist — server uses it verbatim
    // (minus dedupe/unsubscribes) instead of re-resolving from the source flags.
    if let Some(list) = emails {
        payload["emails"] = serde_json::json!(list);
    }
    let resp = http()
        .post(format!("{}/api/admin/broadcast/send", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    let out: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = out.get("error").and_then(|v| v.as_str()) {
        return Err(e.to_string());
    }
    Ok(out)
}

/// Superadmin: send the broadcast as a single test email to the caller's own
/// address. Subject/body are optional — when omitted the server sends its
/// canned test message. Same 200-with-`error` handling as the send endpoint.
#[tauri::command]
pub async fn admin_broadcast_test(
    subject: Option<String>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let mut payload = serde_json::Map::new();
    if let Some(s) = subject {
        payload.insert("subject".into(), serde_json::Value::String(s));
    }
    if let Some(b) = body {
        payload.insert("body".into(), serde_json::Value::String(b));
    }
    let resp = http()
        .post(format!("{}/api/admin/broadcast/test", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .json(&serde_json::Value::Object(payload))
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your session expired — sign in again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    let out: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = out.get("error").and_then(|v| v.as_str()) {
        return Err(e.to_string());
    }
    Ok(out)
}

/// Who the SERVER-SYNC session is signed in as. The desktop has two identities —
/// the local login and this sync token — and they can disagree (a stale sync
/// session makes superadmin data calls fail with no explanation). The Platform
/// tab uses this to say exactly which account the server sees.
#[tauri::command]
pub async fn netsync_whoami() -> Result<serde_json::Value, String> {
    let cfg = config().ok_or("Sign in to the server first.")?;
    let resp = http()
        .get(format!("{}/api/auth/whoami", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|_| "Couldn't reach the server.".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("session expired".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    let out: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = out.get("error").and_then(|v| v.as_str()) {
        return Err(e.to_string());
    }
    Ok(out)
}
