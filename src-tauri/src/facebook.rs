//! Facebook Page auto-posting for inventory lots.
//!
//! Meta removed the ability for apps to publish to GROUPS in 2020, so this targets a
//! Facebook PAGE the user manages, via the official Graph API. The one-time connect is a
//! standard OAuth flow: the user approves in Facebook's own login page (we never see their
//! password) and we keep the long-lived Page access token in the app-local encrypted
//! secret store — it never reaches the frontend. Posting reads the lot's photos from disk
//! and uploads them straight to the Graph API, so it doesn't depend on the storefront
//! being reachable.

use serde::Serialize;
use std::time::Duration;

const GRAPH: &str = "https://graph.facebook.com/v21.0";
const OAUTH_PORT: u16 = 8712;
const REDIRECT_URI: &str = "http://localhost:8712/callback";

const K_APP_ID: &str = "fb_app_id";
const K_APP_SECRET: &str = "fb_app_secret";
const K_PAGE_TOKEN: &str = "fb_page_token";
const K_PAGE_ID: &str = "fb_page_id";
const K_PAGE_NAME: &str = "fb_page_name";
const K_PENDING: &str = "fb_pending_pages";

#[derive(Serialize)]
pub struct FbStatus {
    pub has_app: bool,
    pub connected: bool,
    pub page_name: Option<String>,
    /// The exact redirect URI to register in the Meta app — shown in Settings.
    pub redirect_uri: String,
}

#[derive(Serialize)]
pub struct FbPageLite {
    pub id: String,
    pub name: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .unwrap_or_default()
}

fn secret(key: &str) -> Option<String> {
    crate::secret_store::get(key).filter(|s| !s.is_empty())
}

/// Non-secret status for the Settings UI. Never returns tokens.
#[tauri::command]
pub fn fb_status() -> FbStatus {
    let has_app = secret(K_APP_ID).is_some() && secret(K_APP_SECRET).is_some();
    let page_name = secret(K_PAGE_NAME);
    let connected = secret(K_PAGE_TOKEN).is_some() && page_name.is_some();
    FbStatus { has_app, connected, page_name, redirect_uri: REDIRECT_URI.into() }
}

/// Save the Meta app's ID + secret (from developers.facebook.com). Stored encrypted; the
/// secret never leaves the backend again.
#[tauri::command]
pub fn fb_set_app(app_id: String, app_secret: String) -> Result<(), String> {
    let app_id = app_id.trim();
    let app_secret = app_secret.trim();
    if app_id.is_empty() || app_secret.is_empty() {
        return Err("Enter both the App ID and App secret.".into());
    }
    crate::secret_store::put(K_APP_ID, app_id).map_err(|e| e.to_string())?;
    crate::secret_store::put(K_APP_SECRET, app_secret).map_err(|e| e.to_string())?;
    Ok(())
}

/// Disconnect the Page — keeps the app credentials so reconnecting is one click.
#[tauri::command]
pub fn fb_disconnect() -> Result<(), String> {
    let _ = crate::secret_store::remove(K_PAGE_TOKEN);
    let _ = crate::secret_store::remove(K_PAGE_ID);
    let _ = crate::secret_store::remove(K_PAGE_NAME);
    let _ = crate::secret_store::remove(K_PENDING);
    Ok(())
}

/// Begin OAuth connect: open Facebook's login in the browser, catch the loopback redirect,
/// then return the Pages the user manages (id + name only). The caller follows with
/// `fb_select_page`. Page tokens are stashed encrypted between the two calls, never sent
/// to the frontend.
#[tauri::command]
pub async fn fb_connect(app: tauri::AppHandle) -> Result<Vec<FbPageLite>, String> {
    use tauri_plugin_shell::ShellExt;
    let app_id = secret(K_APP_ID).ok_or("Enter your Facebook App ID and secret first.")?;
    let app_secret = secret(K_APP_SECRET).ok_or("Enter your Facebook App ID and secret first.")?;

    // A loopback CSRF token. SystemTime is fine here — this only guards the local redirect.
    let state = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let scope = "pages_show_list,pages_manage_posts,pages_read_engagement";
    let auth_url = format!(
        "https://www.facebook.com/v21.0/dialog/oauth?client_id={}&redirect_uri={}&scope={}&response_type=code&state={}",
        pe(&app_id),
        pe(REDIRECT_URI),
        pe(scope),
        state
    );

    // Start the loopback listener BEFORE opening the browser so the redirect can't race it.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let want_state = state.clone();
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(format!("127.0.0.1:{}", OAUTH_PORT)) {
            Ok(s) => s,
            Err(e) => {
                let _ = tx.send(Err(format!(
                    "Couldn't start the local sign-in listener on port {} — close whatever is using it and try again ({}).",
                    OAUTH_PORT, e
                )));
                return;
            }
        };
        let request = match server.recv() {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(Err(format!("sign-in listener error: {}", e)));
                return;
            }
        };
        let result = parse_callback(request.url(), &want_state);
        let body = match &result {
            Ok(_) => "<html><body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:80px;color:#1a1a1a\"><h1>Connected</h1><p>You can close this tab and return to Ecliptr.</p></body></html>".to_string(),
            Err(e) => format!("<html><body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:80px;color:#1a1a1a\"><h1>Couldn't connect</h1><p>{}</p></body></html>", e),
        };
        let resp = tiny_http::Response::from_string(body).with_header(tiny_http::Header {
            field: "Content-Type".parse().unwrap(),
            value: "text/html".parse().unwrap(),
        });
        let _ = request.respond(resp);
        let _ = tx.send(result);
    });

    app.shell()
        .open(auth_url, None)
        .map_err(|e| format!("Couldn't open the browser: {}", e))?;

    let code = tokio::time::timeout(Duration::from_secs(180), rx)
        .await
        .map_err(|_| "Timed out waiting for Facebook sign-in.".to_string())?
        .map_err(|_| "sign-in channel closed".to_string())??;

    let c = client();

    // code -> short-lived user token
    let tok: serde_json::Value = c
        .get(format!("{}/oauth/access_token", GRAPH))
        .query(&[
            ("client_id", app_id.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_secret", app_secret.as_str()),
            ("code", code.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Couldn't reach Facebook.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let user_token = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| fb_err(&tok, "Facebook didn't return an access token."))?
        .to_string();

    // short -> long-lived user token (so the Page tokens it yields are long-lived too)
    let long: serde_json::Value = c
        .get(format!("{}/oauth/access_token", GRAPH))
        .query(&[
            ("grant_type", "fb_exchange_token"),
            ("client_id", app_id.as_str()),
            ("client_secret", app_secret.as_str()),
            ("fb_exchange_token", user_token.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "Couldn't reach Facebook.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let long_token = long
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or(&user_token)
        .to_string();

    // list the Pages this user manages, each with its own posting token
    let pages: serde_json::Value = c
        .get(format!("{}/me/accounts", GRAPH))
        .query(&[("access_token", long_token.as_str()), ("fields", "id,name,access_token")])
        .send()
        .await
        .map_err(|_| "Couldn't reach Facebook.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let data = pages
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| fb_err(&pages, "Facebook didn't return any Pages."))?;
    if data.is_empty() {
        return Err("Your Facebook account doesn't manage any Pages. Create a Page first, then reconnect.".into());
    }

    // stash the full pages (with tokens) for the select step; hand back id+name only
    let stash = serde_json::to_string(data).map_err(|e| e.to_string())?;
    crate::secret_store::put(K_PENDING, &stash).map_err(|e| e.to_string())?;
    let lite = data
        .iter()
        .filter_map(|p| {
            Some(FbPageLite {
                id: p.get("id")?.as_str()?.to_string(),
                name: p.get("name").and_then(|v| v.as_str()).unwrap_or("Page").to_string(),
            })
        })
        .collect();
    Ok(lite)
}

/// Pick which Page to post to; persists that Page's long-lived token.
#[tauri::command]
pub fn fb_select_page(page_id: String) -> Result<String, String> {
    let stash = secret(K_PENDING).ok_or("Connect to Facebook again — the session expired.")?;
    let pages: serde_json::Value = serde_json::from_str(&stash).map_err(|e| e.to_string())?;
    let page = pages
        .as_array()
        .and_then(|a| a.iter().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(page_id.as_str())))
        .ok_or("That Page wasn't in the list — reconnect and try again.")?;
    let token = page
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("That Page didn't include a posting token.")?;
    let name = page.get("name").and_then(|v| v.as_str()).unwrap_or("Page");
    crate::secret_store::put(K_PAGE_TOKEN, token).map_err(|e| e.to_string())?;
    crate::secret_store::put(K_PAGE_ID, &page_id).map_err(|e| e.to_string())?;
    crate::secret_store::put(K_PAGE_NAME, name).map_err(|e| e.to_string())?;
    let _ = crate::secret_store::remove(K_PENDING);
    Ok(name.to_string())
}

/// Post a lot to the connected Page: uploads its photos and creates a feed post with the
/// caption. `photo_rels` are photos_json entries ("media/inventory/<lot>/photos/x.jpg").
/// Returns the new post id. Facebook allows at most 10 attached photos per post.
#[tauri::command]
pub async fn fb_post_lot(message: String, photo_rels: Vec<String>) -> Result<String, String> {
    let page_id = secret(K_PAGE_ID).ok_or("Connect a Facebook Page first.")?;
    let token = secret(K_PAGE_TOKEN).ok_or("Connect a Facebook Page first.")?;
    let c = client();

    // Upload each photo unpublished to get a media id we can attach to the post.
    let mut media_ids: Vec<String> = Vec::new();
    for rel in photo_rels.iter().take(10) {
        let rel = rel.replace('\\', "/");
        if !rel.starts_with("media/") || rel.contains("..") {
            continue;
        }
        let local = crate::db::app_data_dir().join("sync").join(&rel);
        // If this device synced the lot's row but not the file, pull it from the server first.
        if !local.exists() {
            let _ = crate::netsync::download_media(&rel).await;
        }
        let bytes = match std::fs::read(&local) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let name = rel.rsplit('/').next().unwrap_or("photo.jpg").to_string();
        let ctype = if name.ends_with(".png") {
            "image/png"
        } else if name.ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        };
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name)
            .mime_str(ctype)
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .text("published", "false")
            .text("access_token", token.clone())
            .part("source", part);
        let resp: serde_json::Value = c
            .post(format!("{}/{}/photos", GRAPH, page_id))
            .multipart(form)
            .send()
            .await
            .map_err(|_| "Couldn't reach Facebook.".to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        match resp.get("id").and_then(|v| v.as_str()) {
            Some(id) => media_ids.push(id.to_string()),
            None => return Err(fb_err(&resp, "Facebook rejected a photo upload.")),
        }
    }

    // Create the feed post, attaching any uploaded photos.
    let mut form: Vec<(String, String)> = vec![
        ("access_token".into(), token.clone()),
        ("message".into(), message.clone()),
    ];
    for (i, id) in media_ids.iter().enumerate() {
        form.push((format!("attached_media[{}]", i), format!("{{\"media_fbid\":\"{}\"}}", id)));
    }
    let resp: serde_json::Value = c
        .post(format!("{}/{}/feed", GRAPH, page_id))
        .form(&form)
        .send()
        .await
        .map_err(|_| "Couldn't reach Facebook.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    match resp.get("id").and_then(|v| v.as_str()) {
        Some(id) => Ok(id.to_string()),
        None => Err(fb_err(&resp, "Facebook rejected the post.")),
    }
}

/// Pull the human-readable message out of a Graph API error body, else a fallback.
fn fb_err(v: &serde_json::Value, fallback: &str) -> String {
    v.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_callback(url: &str, want_state: &str) -> Result<String, String> {
    let query = url.split('?').nth(1).ok_or("no query string in callback")?;
    let params: Vec<(&str, &str)> = query
        .split('&')
        .filter_map(|p| {
            let mut it = p.splitn(2, '=');
            Some((it.next()?, it.next().unwrap_or("")))
        })
        .collect();
    if let Some((_, err)) = params.iter().find(|(k, _)| *k == "error") {
        let desc = params
            .iter()
            .find(|(k, _)| *k == "error_description")
            .map(|(_, v)| *v)
            .unwrap_or("");
        return Err(format!("{} {}", urldecode(err), urldecode(desc)).trim().to_string());
    }
    let state = params.iter().find(|(k, _)| *k == "state").map(|(_, v)| *v).unwrap_or("");
    if state != want_state {
        return Err("sign-in state mismatch — try again".into());
    }
    params
        .iter()
        .find(|(k, _)| *k == "code")
        .map(|(_, v)| urldecode(v))
        .ok_or_else(|| "no code in callback".to_string())
}

/// Minimal percent-encode for building the auth URL (RFC 3986 unreserved set).
fn pe(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut o: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    o.push(b);
                    i += 3;
                } else {
                    o.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                o.push(b' ');
                i += 1;
            }
            b => {
                o.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&o).to_string()
}
