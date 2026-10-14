//! R-513: supplier invoice files on a deal, reached over the server's `/api/deal-flows/:id/files`
//! routes. The list lives in `deal_flows.files` and syncs like any other column; the sealed bytes
//! live in the server's `deal_flow_files` table, so this module is a narrow proxy: every request
//! must stay under `/api/deal-flows/` and rides the stored session token, exactly like the
//! Logistics screen's `freight::logistics_request`.

use serde_json::Value;

/// A path this proxy will send: nothing with a dot segment or an encoded character, and the
/// joined path must stay under /api/deal-flows.
fn deal_files_path_ok(path: &str) -> bool {
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('#') || path.contains('%') || path.chars().any(|c| c.is_control() || c == ' ') {
        return false;
    }
    let shaped = match path.strip_prefix("/api/deal-flows") {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'),
        None => false,
    };
    shaped
        && reqwest::Url::parse("http://server.invalid")
            .and_then(|base| base.join(path))
            .map(|u| u.path() == "/api/deal-flows" || u.path().starts_with("/api/deal-flows/"))
            .unwrap_or(false)
}

/// One call to the server's deal-flow file routes as the signed-in account. `method` is GET,
/// POST or DELETE and `path` starts `/api/deal-flows`. Returns the JSON the server answered; a
/// refusal comes back as the server's own sentence (it is written to be shown as it is).
#[tauri::command]
pub async fn deal_files_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if !matches!(m.as_str(), "GET" | "POST" | "DELETE") {
        return Err("That request is not allowed here.".into());
    }
    if !deal_files_path_ok(&path) {
        return Err("That request is not allowed here.".into());
    }
    let (status, value) = crate::netsync::server_request(&m, &path, body).await.map_err(|e| {
        let s = e.to_string();
        if s.starts_with("Sign in") { s } else { "Could not reach the server. Check your connection and try again.".to_string() }
    })?;
    if !(200..300).contains(&status) {
        let said = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
        return Err(said.unwrap_or_else(|| match status {
            401 => "Sign in again to use Deal Flow.".to_string(),
            403 => "Your account does not have permission for that.".to_string(),
            404 => "That file was not found.".to_string(),
            _ => "The server could not do that. Try again in a moment.".to_string(),
        }));
    }
    // Bring the changed deal (with its new files list) in now rather than on the next sync tick.
    if m != "GET" && !crate::netsync::logistics_only_device() {
        if let Err(e) = crate::netsync::pull_apply().await {
            tracing::warn!("deal files: pull after {} {} failed: {}", m, path, e);
        }
    }
    Ok(value)
}

/// Save one file on a deal to `dest` (a path the person just chose in the save dialog). The
/// bytes come from the server's file route, never from the page.
#[tauri::command]
pub async fn deal_files_save_as(deal_flow_id: String, file_id: String, dest: String) -> Result<(), String> {
    use base64::Engine;
    let ok_id = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok_id(&deal_flow_id) || !ok_id(&file_id) {
        return Err("That file was not found.".into());
    }
    let got = deal_files_request("GET".into(), format!("/api/deal-flows/{deal_flow_id}/files/{file_id}"), None).await?;
    let data = got.get("data").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "The file could not be read.".to_string())?;
    std::fs::write(&dest, bytes).map_err(|e| format!("Could not save the file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_deal_flow_file_paths_pass() {
        assert!(deal_files_path_ok("/api/deal-flows/df_x/files"));
        assert!(deal_files_path_ok("/api/deal-flows/df_x/files/df_y"));
        assert!(!deal_files_path_ok("/api/logistics/bookings/fb_x/files"));
        assert!(!deal_files_path_ok("/api/deal-flows/../settings"));
        assert!(!deal_files_path_ok("/api/deal-flows%2e%2e"));
        assert!(!deal_files_path_ok("https://evil.invalid/api/deal-flows/x/files"));
        assert!(!deal_files_path_ok("/api/deal-flows/x/files/../../plaid"));
    }
}
