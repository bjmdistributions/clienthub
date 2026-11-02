//! R-577 the commission ledger on the desktop.
//!
//! The ledger lives on the server (`/api/payouts/*`, server-only tables): what each person earned
//! from each deal and what they were paid. The desktop holds none of it and does no payout math;
//! `payouts_request` is the one door to those routes, like `logistics_request`.

use serde_json::Value;

/// Only the payout routes may be reached through `payouts_request`. A payee id can hold a letter
/// outside ASCII (an owner's id is their name), so an encoded character is let through, but never
/// an encoded dot, slash, backslash or percent sign.
fn payouts_path_ok(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('#')
        || ["%2e", "%2f", "%5c", "%25"].iter().any(|e| lower.contains(e))
        || path.chars().any(|c| c.is_control() || c == ' ')
    {
        return false;
    }
    let shaped = match path.strip_prefix("/api/payouts") {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'),
        None => false,
    };
    shaped
        && reqwest::Url::parse("http://server.invalid")
            .and_then(|base| base.join(path))
            .map(|u| u.path() == "/api/payouts" || u.path().starts_with("/api/payouts/"))
            .unwrap_or(false)
}

/// One call to the server's payout routes as the signed-in account. A refusal comes back as the
/// server's own sentence (it is written to be shown as it is). This computer's changes are pushed
/// first, so the server works from what is on screen (a deal just completed here is complete
/// there). After a change, the rows the server wrote (a rate on the account, the split, a deal's
/// lead rep) are pulled in at once.
#[tauri::command]
pub async fn payouts_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if !matches!(m.as_str(), "GET" | "POST" | "PUT" | "DELETE") || !payouts_path_ok(&path) {
        return Err("That request is not allowed here.".into());
    }
    if let Err(e) = crate::netsync::push_pending().await {
        tracing::warn!("payouts: push before {} {} failed: {}", m, path, e);
    }
    let (status, value) = crate::netsync::server_request(&m, &path, body).await.map_err(|e| {
        let s = e.to_string();
        if s.starts_with("Sign in") { s } else { "Could not reach the server. Check your connection and try again.".to_string() }
    })?;
    if !(200..300).contains(&status) {
        let said = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
        return Err(said.unwrap_or_else(|| match status {
            401 => "Sign in again to see payouts.".to_string(),
            403 => "Only an admin can see or change payouts.".to_string(),
            404 => "That was not found.".to_string(),
            _ => "The server could not do that. Try again in a moment.".to_string(),
        }));
    }
    if m != "GET" {
        if let Err(e) = crate::netsync::pull_apply().await {
            tracing::warn!("payouts: pull after {} {} failed: {}", m, path, e);
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::payouts_path_ok;

    #[test]
    fn only_the_payout_routes_pass() {
        assert!(payouts_path_ok("/api/payouts"));
        assert!(payouts_path_ok("/api/payouts/people/owner/jos%C3%A9"));
        assert!(payouts_path_ok("/api/payouts/deals/df_1/reps"));
        assert!(!payouts_path_ok("/api/payoutsx"));
        assert!(!payouts_path_ok("/api/payouts/../staff"));
        assert!(!payouts_path_ok("/api/payouts/%2e%2e/staff"));
        assert!(!payouts_path_ok("/api/payouts/%2F%2Fevil"));
        assert!(!payouts_path_ok("/api/logistics/pay"));
    }
}
