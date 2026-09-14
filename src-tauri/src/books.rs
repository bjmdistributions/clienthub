//! R-282 accountant portal — the desktop-side FEED for changes the accountant makes
//! on the web (ecliptr.app/staff). The edits themselves (bank_txn columns) already
//! reach this device through normal sync; this module only proxies the server's
//! change log so Jack can see who changed what. Same server-proxy shape as the
//! leads/show-packing sections in commands.rs: no synced table, just a direct
//! Bearer-token call through `leads_server()` / `inbox_http()`.
//!
//! Old servers (not yet carrying R-282) answer these routes with 404 — that must
//! NOT surface as an error. `{"unsupported": true}` lets the UI hide itself quietly
//! instead of showing a toast for a feature the connected server doesn't have yet.

use crate::commands::{inbox_http, leads_server};
use serde_json::{json, Value};

#[tauri::command]
pub async fn list_books_changes(limit: Option<i64>) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let limit = limit.unwrap_or(100);
    let resp = inbox_http()?
        .get(format!("{base}/api/books/changes"))
        .query(&[("limit", limit.to_string()), ("offset", "0".to_string())])
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({ "unsupported": true }));
    }
    if !resp.status().is_success() {
        return Err(format!("Couldn't load accountant changes ({}).", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_books_changes_seen() -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .post(format!("{base}/api/books/changes/seen"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(json!({ "unsupported": true }));
    }
    if !resp.status().is_success() {
        return Err(format!("Couldn't mark changes seen ({}).", resp.status()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}
