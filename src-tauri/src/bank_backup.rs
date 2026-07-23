//! Append-only Google Sheet safety log for bank transactions.
//!
//! An independent, human-readable copy of every bank transaction that the user
//! owns and can open outside the app — a recovery source and audit trail that
//! survives even if the app is broken, mid-update, or wrong (see the v0.15.116
//! "blank financials" scare that motivated it).
//!
//! Design:
//!  - APPEND-ONLY. We only ever ADD rows, keyed by `bank_txn.id`. A transaction
//!    deleted inside the app KEEPS its row in the sheet — a safety net the app can
//!    erase is not a safety net.
//!  - Deduped by reading column A (the id column) before appending, so re-runs and
//!    two devices pointed at the same sheet never double-write the same transaction.
//!  - Batched (<=500 rows/request) so a bulk Plaid import doesn't hammer the API.
//!  - Reuses the connected Google account (`crate::email::oauth2_access_token`,
//!    `spreadsheets` scope) — the same token the leads write-back uses.
//!  - BEST-EFFORT everywhere the auto-hook runs: any failure is logged and swallowed
//!    so a backup problem can never break a sync or the app.

use anyhow::{anyhow, Context, Result};
use serde_json::json;

use crate::db::pool;

const HEADER: [&str; 12] = [
    "Transaction ID", "Date", "Time", "Direction", "Amount", "Description",
    "Counterparty", "Account", "Category", "Reviewed", "Allocated", "Backed up at",
];

/// Extract the spreadsheet id from a Google Sheets URL.
fn spreadsheet_id(url: &str) -> Option<String> {
    let after = url.split("/d/").nth(1)?;
    let id = after.split('/').next()?.split('?').next()?.split('#').next()?;
    if id.is_empty() { None } else { Some(id.to_string()) }
}

fn get_setting(key: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0)).ok()
}

fn set_setting(key: &str, value: &str) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// (sheet_url, enabled). Enabled defaults OFF — a backup that silently isn't happening
/// is worse than one the user knowingly turned on.
fn load_cfg() -> (Option<String>, bool) {
    let url = get_setting("bank_backup_sheet_url").filter(|s| !s.trim().is_empty());
    let enabled = get_setting("bank_backup_enabled").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    (url, enabled)
}

async fn read_column_a(http: &reqwest::Client, spreadsheet: &str, access: &str) -> Result<std::collections::HashSet<String>> {
    let url = format!("https://sheets.googleapis.com/v4/spreadsheets/{}/values/A:A", spreadsheet);
    let resp = http.get(&url).bearer_auth(access).send().await.context("sheets read A:A")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets read failed: HTTP {} {}", status, text));
    }
    let body: serde_json::Value = resp.json().await.context("sheets read parse")?;
    let mut set = std::collections::HashSet::new();
    if let Some(rows) = body.get("values").and_then(|v| v.as_array()) {
        for row in rows {
            if let Some(cell) = row.as_array().and_then(|a| a.first()).and_then(|c| c.as_str()) {
                let v = cell.trim();
                if !v.is_empty() { set.insert(v.to_string()); }
            }
        }
    }
    Ok(set)
}

async fn put_values(http: &reqwest::Client, spreadsheet: &str, access: &str, range: &str, values: Vec<Vec<String>>) -> Result<()> {
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}?valueInputOption=RAW",
        spreadsheet, range
    );
    let resp = http.put(&url).bearer_auth(access).json(&json!({ "values": values })).send().await.context("sheets put")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets header write failed: HTTP {} {}", status, text));
    }
    Ok(())
}

async fn append_rows(http: &reqwest::Client, spreadsheet: &str, access: &str, rows: &[Vec<String>]) -> Result<()> {
    for chunk in rows.chunks(500) {
        let url = format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
            spreadsheet
        );
        let resp = http.post(&url).bearer_auth(access).json(&json!({ "values": chunk })).send().await.context("sheets append")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("sheets append failed: HTTP {} {}", status, text));
        }
    }
    Ok(())
}

/// Every bank transaction as a sheet row, chronological. `already` is the set of ids
/// already on the sheet — those are skipped so the append is idempotent.
fn rows_to_append(already: &std::collections::HashSet<String>, backed_up_at: &str) -> Result<Vec<Vec<String>>> {
    let conn = pool().get()?;
    let mut stmt = conn.prepare(
        "SELECT bt.id, bt.posted_at, CASE WHEN json_valid(bt.raw_json) THEN json_extract(bt.raw_json,'$.dt') END, \
                bt.direction, bt.amount, COALESCE(bt.description,''), COALESCE(bt.counterparty_name,''), \
                COALESCE(bt.account_id,''), COALESCE(bt.category,''), COALESCE(bt.reviewed,0), \
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id),0) \
         FROM bank_txn bt ORDER BY bt.posted_at ASC, bt.created_at ASC",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        if already.contains(&id) { continue; }
        let date: String = r.get::<_, Option<String>>(1)?.unwrap_or_default();
        let dt: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
        let time = dt.split('T').nth(1).map(|s| s.chars().take(5).collect::<String>()).unwrap_or_default();
        let direction: String = r.get(3)?;
        let amount: f64 = r.get(4)?;
        let desc: String = r.get(5)?;
        let cp: String = r.get(6)?;
        let account: String = r.get(7)?;
        let category: String = r.get(8)?;
        let reviewed: i64 = r.get(9)?;
        let allocated: f64 = r.get(10)?;
        out.push(vec![
            id,
            date,
            time,
            if direction == "in" { "In".to_string() } else { "Out".to_string() },
            format!("{:.2}", amount),
            desc,
            cp,
            account,
            category,
            if reviewed != 0 { "Yes".to_string() } else { "No".to_string() },
            format!("{:.2}", allocated),
            backed_up_at.to_string(),
        ]);
    }
    Ok(out)
}

/// Core: append every not-yet-logged bank transaction to the configured sheet.
/// `explicit` = a user button press (loud errors, ignores the enabled toggle — the
/// click is the consent); otherwise the auto-hook (respects the toggle, best-effort).
async fn run(explicit: bool) -> Result<serde_json::Value, String> {
    let (url, enabled) = load_cfg();
    if !explicit && !enabled {
        return Ok(json!({ "skipped": "disabled" }));
    }
    let url = url.ok_or_else(|| "Add a Google Sheet URL for the backup in Financials → Backup first.".to_string())?;
    let spreadsheet = spreadsheet_id(&url).ok_or_else(|| "That doesn't look like a Google Sheet link. Paste the sheet's URL.".to_string())?;
    let access = crate::email::oauth2_access_token().await
        .map_err(|_| "Connect your Google account in Settings first (the same one used for the leads sheet).".to_string())?;

    let http = reqwest::Client::new();

    // Header row: write it once if the sheet is empty.
    let existing = read_column_a(&http, &spreadsheet, &access).await.map_err(|e| e.to_string())?;
    if existing.is_empty() {
        let header = HEADER.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        put_values(&http, &spreadsheet, &access, "A1:L1", vec![header]).await.map_err(|e| e.to_string())?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let rows = rows_to_append(&existing, &now).map_err(|e| e.to_string())?;
    let added = rows.len();
    if added > 0 {
        append_rows(&http, &spreadsheet, &access, &rows).await.map_err(|e| e.to_string())?;
    }

    let _ = set_setting("bank_backup_last_at", &now);
    let total: i64 = { pool().get().ok().and_then(|c| c.query_row("SELECT COUNT(*) FROM bank_txn", [], |r| r.get(0)).ok()).unwrap_or(0) };
    let _ = set_setting("bank_backup_last_total", &total.to_string());
    Ok(json!({ "added": added, "total": total, "at": now }))
}

/// User button: back up now (loud errors, consent = the click).
#[tauri::command]
pub async fn backup_bank_txns_now() -> Result<serde_json::Value, String> {
    run(true).await
}

/// Settings for the backup: the target sheet + on/off + last-run status.
#[tauri::command]
pub async fn get_bank_backup_settings() -> Result<serde_json::Value, String> {
    let (url, enabled) = load_cfg();
    Ok(json!({
        "sheet_url": url.unwrap_or_default(),
        "enabled": enabled,
        "last_at": get_setting("bank_backup_last_at").unwrap_or_default(),
        "last_total": get_setting("bank_backup_last_total").unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn set_bank_backup_settings(sheet_url: String, enabled: bool) -> Result<(), String> {
    set_setting("bank_backup_sheet_url", sheet_url.trim()).map_err(|e| e.to_string())?;
    set_setting("bank_backup_enabled", if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
    Ok(())
}

/// Fire-and-forget backup after a sync/import. Never blocks, never surfaces an error —
/// a backup hiccup must not affect the operation that triggered it.
pub fn spawn_auto_backup() {
    tauri::async_runtime::spawn(async {
        match run(false).await {
            Ok(v) if v.get("added").and_then(|a| a.as_u64()).unwrap_or(0) > 0 =>
                tracing::info!("bank backup: appended {} row(s) to the sheet", v["added"]),
            Ok(_) => {}
            Err(e) => tracing::warn!("bank backup (auto) skipped: {}", e),
        }
    });
}
