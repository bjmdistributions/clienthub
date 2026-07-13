//! Plaid live bank/card feed. On the Trial plan this uses Plaid's PRODUCTION APIs
//! (real data, free up to 10 linked banks, OAuth to Chase/Amex) — no client
//! certificate needed; requests carry the client_id + secret in the JSON body.
//!
//! Secrets (client_id, secret) and per-item access tokens live device-LOCAL and are
//! never synced (written with a plain execute, not record_upsert). The resulting
//! transactions land in the synced `bank_txn` ledger like every other import.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

/// The Plaid environment ("sandbox" for testing with a fake bank, "production" for
/// real data on the free Trial plan). Each environment has its OWN secret.
pub fn get_env() -> String {
    let conn = match crate::db::pool().get() { Ok(c) => c, Err(_) => return "production".into() };
    conn.query_row("SELECT value FROM settings WHERE key='plaid_env'", [], |r| r.get::<_, String>(0))
        .ok()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s == "sandbox" || s == "production")
        .unwrap_or_else(|| "production".into())
}

fn base_url() -> String {
    match get_env().as_str() {
        "sandbox" => "https://sandbox.plaid.com".into(),
        _ => "https://production.plaid.com".into(),
    }
}

/// The stored Plaid client_id + secret (device-local), or None if not set up.
pub fn get_keys() -> Option<(String, String)> {
    let conn = crate::db::pool().get().ok()?;
    let read = |k: &str| conn
        .query_row("SELECT value FROM settings WHERE key=?1", [k], |r| r.get::<_, String>(0))
        .ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some((read("plaid_client_id")?, read("plaid_secret")?))
}

pub fn has_keys() -> bool { get_keys().is_some() }

/// Store the keys + environment device-local (plain execute — NOT record_upsert —
/// so they never sync, matching the anthropic_api_key pattern). Each environment
/// uses a different secret, so switching env means re-entering the matching secret.
pub fn set_keys(client_id: &str, secret: &str, env: &str) -> Result<()> {
    let env = if env.trim().eq_ignore_ascii_case("sandbox") { "sandbox" } else { "production" };
    let conn = crate::db::pool().get()?;
    for (k, v) in [("plaid_client_id", client_id), ("plaid_secret", secret), ("plaid_env", env)] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            rusqlite::params![k, v.trim()],
        )?;
    }
    Ok(())
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(std::time::Duration::from_secs(45)).build()?)
}

/// POST to a Plaid endpoint with client_id + secret injected. Surfaces Plaid's
/// error_message on non-2xx.
async fn post(path: &str, mut body: Value) -> Result<Value> {
    let (cid, sec) = get_keys().ok_or_else(|| anyhow!(
        "Plaid isn't set up. Add your Plaid client_id and secret in Settings first."
    ))?;
    body["client_id"] = json!(cid);
    body["secret"] = json!(sec);
    let resp = http()?.post(format!("{}{}", base_url(), path)).json(&body).send().await?;
    let status = resp.status();
    let v: Value = resp.json().await.context("Plaid returned invalid JSON")?;
    if !status.is_success() {
        let msg = v.get("error_message").and_then(|m| m.as_str())
            .or_else(|| v.get("error_code").and_then(|m| m.as_str()))
            .unwrap_or("Plaid API error");
        return Err(anyhow!("Plaid: {}", msg));
    }
    Ok(v)
}

/// Create a Link token to open Plaid Link in the UI.
pub async fn create_link_token() -> Result<String> {
    let v = post("/link/token/create", json!({
        "user": { "client_user_id": "bjm-owner" },
        "client_name": "Ecliptr",
        "products": ["transactions"],
        "country_codes": ["US"],
        "language": "en"
    })).await?;
    v.get("link_token").and_then(|t| t.as_str()).map(String::from)
        .ok_or_else(|| anyhow!("No link_token in Plaid response"))
}

/// Create a HOSTED Link token — the user completes the flow in their real browser
/// (where bank logins/OAuth work, unlike an embedded webview). Returns
/// (link_token, hosted_link_url). Poll link_token_get() for the result.
pub async fn create_hosted_link() -> Result<(String, String)> {
    let v = post("/link/token/create", json!({
        "user": { "client_user_id": "bjm-owner" },
        "client_name": "Ecliptr",
        "products": ["transactions"],
        "country_codes": ["US"],
        "language": "en",
        "hosted_link": {}
    })).await?;
    let token = v.get("link_token").and_then(|t| t.as_str()).map(String::from)
        .ok_or_else(|| anyhow!("No link_token in Plaid response"))?;
    let url = v.get("hosted_link_url").and_then(|t| t.as_str()).map(String::from)
        .ok_or_else(|| anyhow!("Plaid didn't return a hosted link URL — enable Hosted Link in your Plaid dashboard (Link → Hosted Link)."))?;
    Ok((token, url))
}

/// Poll a hosted-link session's status/results. After the user finishes, the
/// public_token appears under link_sessions[].results.item_add_results[] (or
/// on_success). Available for 6h after completion.
pub async fn link_token_get(link_token: &str) -> Result<Value> {
    post("/link/token/get", json!({ "link_token": link_token })).await
}

/// Exchange a Link public_token for a long-lived access_token + item_id.
pub async fn exchange(public_token: &str) -> Result<(String, String)> {
    let v = post("/item/public_token/exchange", json!({ "public_token": public_token })).await?;
    let access = v.get("access_token").and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("No access_token in Plaid response"))?.to_string();
    let item = v.get("item_id").and_then(|t| t.as_str()).unwrap_or("").to_string();
    Ok((access, item))
}

/// Accounts for an item (used to label transactions "Institution · name ··mask").
pub async fn accounts_get(access_token: &str) -> Result<Value> {
    post("/accounts/get", json!({ "access_token": access_token })).await
}

/// One page of the transactions sync (added/modified/removed + next_cursor + has_more).
pub async fn transactions_sync(access_token: &str, cursor: &str) -> Result<Value> {
    let mut body = json!({ "access_token": access_token, "count": 500 });
    if !cursor.is_empty() { body["cursor"] = json!(cursor); }
    post("/transactions/sync", body).await
}

/// Best-effort: tell Plaid to forget an item when the user disconnects a bank.
pub async fn remove_item(access_token: &str) -> Result<()> {
    let _ = post("/item/remove", json!({ "access_token": access_token })).await;
    Ok(())
}
