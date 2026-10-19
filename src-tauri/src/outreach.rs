//! R-546 Cold calls on the desktop.
//!
//! The list lives on the server (`/api/outreach/*`, server-only tables), so this file holds no rows. It is
//! three things:
//!
//!  * `outreach_request`: the one door to `/api/outreach/*`, like `logistics_request`.
//!  * The send pump: a cold email never leaves through the server (Resend carries every phone invoice and
//!    can close an account over complaints, and the droplet cannot reach SMTP), so this PC sends the queue.
//!    About once a minute it asks the server for the next email (`/pump/claim`); the server says when one may
//!    go (weekdays 9 to 4 New York time, the daily limit spread across those hours) and re-checks the lead.
//!    The PC sends it over SMTP from the cold email address and reports back (`/pump/done`). Only a computer
//!    switched on in Cold calls settings sends, so two computers never send as two different logins.
//!  * The reply scan: every ten minutes, the monitored inbox for the cold email address is searched for mail
//!    from the warehouses that were emailed, and each one found is reported (`/pump/replies`). The server
//!    logs it once, moves the lead to Talking (or Do not contact on a stop) and cancels what was waiting.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db::pool;

const PUMP_KEY: &str = "outreach_pump_on";

/// Only the Cold calls routes may be reached through `outreach_request`.
fn outreach_path_ok(path: &str) -> bool {
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('#') || path.contains('%')
        || path.chars().any(|c| c.is_control() || c == ' ')
    {
        return false;
    }
    let shaped = match path.strip_prefix("/api/outreach") {
        Some(rest) => rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'),
        None => false,
    };
    shaped
        && reqwest::Url::parse("http://server.invalid")
            .and_then(|base| base.join(path))
            .map(|u| u.path() == "/api/outreach" || u.path().starts_with("/api/outreach/"))
            .unwrap_or(false)
}

/// One call to the server's Cold calls routes as the signed-in account. A refusal comes back as the server's
/// own sentence (it is written to be shown as it is).
#[tauri::command]
pub async fn outreach_request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if !matches!(m.as_str(), "GET" | "POST") || !outreach_path_ok(&path) {
        return Err("That request is not allowed here.".into());
    }
    let (status, value) = crate::netsync::server_request(&m, &path, body).await.map_err(|e| {
        let s = e.to_string();
        if s.starts_with("Sign in") { s } else { "Could not reach the server. Check your connection and try again.".to_string() }
    })?;
    if !(200..300).contains(&status) {
        let said = value.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
        return Err(said.unwrap_or_else(|| match status {
            401 => "Sign in again to use Cold calls.".to_string(),
            403 => "Your account does not have permission for that.".to_string(),
            404 => "That warehouse was not found.".to_string(),
            _ => "The server could not do that. Try again in a moment.".to_string(),
        }));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------------------

#[derive(Default, Clone)]
struct PumpState {
    last_error: String,
    last_sent_at: String,
    watching: String,
}

static STATE: Mutex<Option<PumpState>> = Mutex::new(None);

fn state() -> PumpState {
    STATE.lock().ok().and_then(|g| g.clone()).unwrap_or_default()
}

fn set_state(f: impl FnOnce(&mut PumpState)) {
    if let Ok(mut g) = STATE.lock() {
        let s = g.get_or_insert_with(PumpState::default);
        f(s);
    }
}

fn pump_on() -> bool {
    pool()
        .get()
        .ok()
        .and_then(|c| c.query_row("SELECT value FROM settings WHERE key=?1", [PUMP_KEY], |r| r.get::<_, String>(0)).ok())
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// What this computer is doing with the queue, for Cold calls settings on the desktop.
#[tauri::command]
pub async fn outreach_pump_get() -> Result<Value, String> {
    let st = state();
    let login = crate::email::load_settings().map(|s| s.user).unwrap_or_default();
    let inboxes: Vec<String> = crate::email::load_inboxes().into_iter().filter(|i| !i.demo).map(|i| i.user).collect();
    Ok(json!({
        "on": pump_on(), "login": login, "inboxes": inboxes,
        "last_error": st.last_error, "last_sent_at": st.last_sent_at, "watching": st.watching,
    }))
}

/// Switches sending on or off for this computer only (a local setting, never synced).
#[tauri::command]
pub async fn outreach_pump_set(on: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![PUMP_KEY, if on { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    if !on {
        set_state(|s| s.last_error.clear());
    }
    Ok(())
}

/// About once a minute while switched on; the server's answer decides the real wait.
pub fn spawn_pump() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(40)).await;
        let mut next_scan = Instant::now();
        loop {
            let wait = if pump_on() { tick(&mut next_scan).await } else { 120 };
            tokio::time::sleep(Duration::from_secs(wait.clamp(30, 900))).await;
        }
    });
}

async fn tick(next_scan: &mut Instant) -> u64 {
    if Instant::now() >= *next_scan {
        *next_scan = Instant::now() + Duration::from_secs(600);
        if let Err(e) = scan_replies().await {
            tracing::warn!("cold calls: reply scan: {e}");
            set_state(|s| s.last_error = format!("Could not look for replies: {e}"));
        }
    }
    let watching = state().watching;
    let note = if watching.is_empty() {
        "Replies are not being watched: add the send from address as an inbox in the desktop's Settings, Email.".to_string()
    } else {
        format!("Replies are watched in {watching}.")
    };
    let (status, v) = match crate::netsync::server_request("POST", "/api/outreach/pump/claim", Some(json!({ "note": note }))).await {
        Ok(x) => x,
        Err(e) => {
            set_state(|s| s.last_error = format!("Could not reach the server: {e}"));
            return 300;
        }
    };
    if !(200..300).contains(&status) {
        set_state(|s| s.last_error = v.get("error").and_then(|e| e.as_str()).unwrap_or("The server refused the send queue.").to_string());
        return 600;
    }
    let retry = v.get("retry_in").and_then(|n| n.as_u64()).unwrap_or(120);
    let Some(email) = v.get("email").filter(|e| e.is_object()) else { return retry };
    let s = |k: &str| email.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let reply_to = s("reply_to");
    let sent = crate::email::send_outreach(
        &s("to"), &s("subject"), &s("body"), &s("from"), &s("from_name"),
        if reply_to.is_empty() { None } else { Some(reply_to.as_str()) },
    )
    .await;
    let done = match &sent {
        Ok(mid) => json!({ "id": s("id"), "ok": true, "message_id": mid }),
        Err(e) => json!({ "id": s("id"), "ok": false, "error": format!("The email could not be sent: {e}") }),
    };
    match &sent {
        Ok(_) => set_state(|st| {
            st.last_sent_at = chrono::Utc::now().to_rfc3339();
            st.last_error.clear();
        }),
        Err(e) => set_state(|st| st.last_error = format!("The last email could not be sent: {e}")),
    }
    // A report that does not arrive leaves the email at "sending"; the server fails it after half an hour
    // and never sends it again on its own, so a lost report cannot become a second copy.
    if let Err(e) = crate::netsync::server_request("POST", "/api/outreach/pump/done", Some(done)).await {
        tracing::warn!("cold calls: report after send: {e}");
    }
    30
}

/// `FROM "a"`, or `OR FROM "a" OR FROM "b" FROM "c"` for several (IMAP's OR takes two keys).
pub fn from_any(addrs: &[String]) -> String {
    match addrs {
        [] => String::new(),
        [one] => format!("FROM \"{}\"", one.replace('"', "")),
        [first, rest @ ..] => format!("OR FROM \"{}\" {}", first.replace('"', ""), from_any(rest)),
    }
}

async fn scan_replies() -> Result<(), String> {
    let (status, w) = crate::netsync::server_request("GET", "/api/outreach/pump/watch", None).await.map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err("the server refused".into());
    }
    let send_from = w.get("send_from").and_then(|x| x.as_str()).unwrap_or_default().trim().to_lowercase();
    let login = crate::email::load_settings().map(|s| s.user.trim().to_lowercase()).unwrap_or_default();
    let want = if send_from.is_empty() { login } else { send_from };
    let inbox = crate::email::load_inboxes().into_iter().find(|i| !i.demo && i.user.trim().eq_ignore_ascii_case(&want));
    let Some(inbox) = inbox else {
        set_state(|s| s.watching.clear());
        return Ok(());
    };
    set_state(|s| s.watching = inbox.user.clone());
    let emails: Vec<String> = w
        .get("emails")
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).filter(|s| s.contains('@')).collect())
        .unwrap_or_default();
    let since = w.get("since").and_then(|x| x.as_str()).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
    let (Some(since), false) = (since, emails.is_empty()) else { return Ok(()) };
    let day = since.format("%d-%b-%Y").to_string();
    let mut replies = Vec::new();
    for chunk in emails.chunks(15) {
        let query = format!("SINCE {day} {}", from_any(chunk));
        let found = crate::email::search_inbox(&inbox.id, query, 50, 200_000).await.map_err(|e| e.to_string())?;
        for m in found {
            let Some(mid) = m.message_id.clone().filter(|x| !x.trim().is_empty()) else { continue };
            replies.push(json!({
                "from": m.from, "message_id": mid, "subject": m.subject,
                "text": m.body_text.chars().take(2000).collect::<String>(), "at": m.date.unwrap_or_default(),
            }));
        }
    }
    if replies.is_empty() {
        return Ok(());
    }
    crate::netsync::server_request("POST", "/api/outreach/pump/replies", Some(json!({ "replies": replies })))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_cold_calls_routes_pass() {
        for p in ["/api/outreach/leads", "/api/outreach/leads/abc/call", "/api/outreach?x=1"] {
            assert!(outreach_path_ok(p), "{p}");
        }
        for p in ["/api/outreachx", "/api/outreach/../bank", "/api/outreach/%2e%2e/bank", "/api/bank", "/api/outreach//x"] {
            assert!(!outreach_path_ok(p), "{p}");
        }
    }

    #[test]
    fn the_reply_search() {
        assert_eq!(from_any(&["a@x.co".into()]), "FROM \"a@x.co\"");
        assert_eq!(
            from_any(&["a@x.co".into(), "b@y.co".into(), "c@z.co".into()]),
            "OR FROM \"a@x.co\" OR FROM \"b@y.co\" FROM \"c@z.co\""
        );
    }
}
