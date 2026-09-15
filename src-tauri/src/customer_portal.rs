//! R-290 customer portal — the desktop side of who can sign in at portal.ecliptr.app.
//! Accounts, invites and previews live only on the server (customer password hashes
//! never enter sync), so every command here is a direct Bearer-token call through
//! `leads_server()` / `inbox_http()`, the same proxy shape as books.rs.
//!
//! A server without the R-290 routes answers 404; that becomes `{"unsupported": true}`
//! so the panel hides itself instead of toasting. Any other failure carries the
//! server's own `{error}` text, which is written for a person to read.

use crate::commands::{inbox_http, leads_server};
use serde_json::{json, Value};

async fn finish(resp: reqwest::Response, what: &str) -> Result<Value, String> {
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        // A 404 WITH an error message is the R-290 server saying "client not found";
        // a bare 404 is an older server that has no such route.
        return match body.get("error").and_then(|e| e.as_str()) {
            Some(msg) => Err(msg.to_string()),
            None => Ok(json!({ "unsupported": true })),
        };
    }
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Couldn't {what} ({status}).")));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn customer_portal_list() -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .get(format!("{base}/api/customer-portal/accounts"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "load customer portals").await
}

#[tauri::command]
pub async fn customer_portal_client(client_id: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .get(format!("{base}/api/customer-portal/clients/{client_id}"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "load portal access").await
}

#[tauri::command]
pub async fn customer_portal_invite(client_id: String, email: Option<String>, send: bool) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .post(format!("{base}/api/customer-portal/clients/{client_id}/invite"))
        .bearer_auth(&token)
        .json(&json!({ "email": email, "send": send }))
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "create the invite").await
}

#[tauri::command]
pub async fn customer_portal_revoke_invite(client_id: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .post(format!("{base}/api/customer-portal/clients/{client_id}/invite/revoke"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "revoke the invite").await
}

#[tauri::command]
pub async fn customer_portal_set_status(account_id: String, status: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .put(format!("{base}/api/customer-portal/accounts/{account_id}/status"))
        .bearer_auth(&token)
        .json(&json!({ "status": status }))
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "change portal access").await
}

/// R-294: every client with at least one completed deal, and whether each can be invited.
#[tauri::command]
pub async fn customer_portal_eligible() -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .get(format!("{base}/api/customer-portal/eligible"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "load customers to invite").await
}

#[tauri::command]
pub async fn customer_portal_invite_bulk(client_ids: Vec<String>) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .post(format!("{base}/api/customer-portal/invite-bulk"))
        .bearer_auth(&token)
        .json(&json!({ "client_ids": client_ids }))
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "send the invites").await
}

/// R-294: a payment method's QR image, uploaded as the raw file. The webview hands the
/// bytes over as base64 because an invoke argument is JSON.
#[tauri::command]
pub async fn customer_portal_upload_qr(method_id: String, data_base64: String, content_type: String) -> Result<Value, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_base64.trim())
        .map_err(|_| "That file could not be read.".to_string())?;
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .post(format!("{base}/api/customer-portal/payment-qr/{method_id}"))
        .bearer_auth(&token)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(bytes)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "upload the QR code").await
}

#[tauri::command]
pub async fn customer_portal_remove_qr(method_id: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .delete(format!("{base}/api/customer-portal/payment-qr/{method_id}"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "remove the QR code").await
}

/// The current QR image as a data URL, or null when there is none. Fetched here because the
/// image needs the Bearer token an <img> tag cannot send.
#[tauri::command]
pub async fn customer_portal_qr_image(method_id: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .get(format!("{base}/api/customer/payment-qr/{method_id}"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(Value::Null);
    }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/png").to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(json!(format!("data:{ct};base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))))
}

#[tauri::command]
pub async fn customer_portal_preview(client_id: String) -> Result<Value, String> {
    let (base, token) = leads_server()?;
    let resp = inbox_http()?
        .get(format!("{base}/api/customer-portal/clients/{client_id}/preview"))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    finish(resp, "open the preview").await
}
