//! R-441 company documents, desktop half. The papers live on the server (sealed in its
//! database, admin only, in the daily off-site backup); this module is the desktop's
//! window onto `/api/documents` plus a local copy of every current version under
//! `<store>/company-documents/`, so the business's papers also sit on this computer.
//!
//! Every call is scoped to the documents routes: there is no general-purpose proxy here.

use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn client() -> reqwest::Client {
    // A 25 MB scan on a slow line needs longer than the shared client's 30 s.
    reqwest::Client::builder().timeout(Duration::from_secs(180)).build().unwrap_or_default()
}

fn base() -> Result<(String, String), String> {
    let cfg = crate::netsync::config().ok_or("Sign in to the Ecliptr server to use company documents.")?;
    Ok((format!("{}/api/documents", cfg.url.trim_end_matches('/')), cfg.token))
}

async fn read(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
        return Err(e.to_string());
    }
    if !status.is_success() {
        return Err(format!("The server answered {status}."));
    }
    Ok(v)
}

fn offline(_: reqwest::Error) -> String {
    "Couldn't reach the server. Check your connection.".into()
}

#[tauri::command]
pub async fn docs_list() -> Result<Value, String> {
    let (url, token) = base()?;
    read(client().get(url).bearer_auth(token).send().await.map_err(offline)?).await
}

#[tauri::command]
pub async fn docs_upload(title: String, category: String, checklist_key: String, filename: String, bytes_b64: String) -> Result<Value, String> {
    let (url, token) = base()?;
    let bytes = B64.decode(bytes_b64).map_err(|_| "The file could not be read.".to_string())?;
    let resp = client()
        .post(url)
        .query(&[("title", title), ("category", category), ("checklist_key", checklist_key), ("filename", filename)])
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(offline)?;
    read(resp).await
}

#[tauri::command]
pub async fn docs_update(id: String, patch: Value) -> Result<Value, String> {
    let (url, token) = base()?;
    read(client().put(format!("{url}/{id}")).bearer_auth(token).json(&patch).send().await.map_err(offline)?).await
}

#[tauri::command]
pub async fn docs_new_version(id: String, filename: Option<String>, note: String, bytes_b64: String) -> Result<Value, String> {
    let (url, token) = base()?;
    let bytes = B64.decode(bytes_b64).map_err(|_| "The file could not be read.".to_string())?;
    let mut q = vec![("note", note)];
    if let Some(f) = filename {
        q.push(("filename", f));
    }
    let resp = client()
        .post(format!("{url}/{id}/versions"))
        .query(&q)
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(offline)?;
    read(resp).await
}

#[tauri::command]
pub async fn docs_archive(id: String, archived: bool) -> Result<Value, String> {
    let (url, token) = base()?;
    read(client().post(format!("{url}/{id}/archive")).bearer_auth(token).json(&serde_json::json!({ "archived": archived })).send().await.map_err(offline)?).await
}

async fn fetch(id: &str, version: Option<i64>) -> Result<Vec<u8>, String> {
    let (url, token) = base()?;
    let mut req = client().get(format!("{url}/{id}/file")).bearer_auth(token);
    if let Some(v) = version {
        req = req.query(&[("v", v)]);
    }
    let resp = req.send().await.map_err(offline)?;
    if !resp.status().is_success() {
        return Err(read(resp).await.err().unwrap_or_else(|| "The file could not be downloaded.".into()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(offline)
}

/// The file's bytes, base64, for viewing or editing in the window.
#[tauri::command]
pub async fn docs_file(id: String, version: Option<i64>) -> Result<String, String> {
    Ok(B64.encode(fetch(&id, version).await?))
}

/// Download one version to a path the user picked.
#[tauri::command]
pub async fn docs_save_as(id: String, version: Option<i64>, dest: String) -> Result<(), String> {
    let bytes = fetch(&id, version).await?;
    std::fs::write(&dest, bytes).map_err(|e| format!("Could not save the file: {e}"))
}

#[tauri::command]
pub async fn docs_signature_get() -> Result<Value, String> {
    let (url, token) = base()?;
    read(client().get(format!("{url}/signature")).bearer_auth(token).send().await.map_err(offline)?).await
}

#[tauri::command]
pub async fn docs_signature_put(png: String) -> Result<Value, String> {
    let (url, token) = base()?;
    read(client().put(format!("{url}/signature")).bearer_auth(token).json(&serde_json::json!({ "png": png })).send().await.map_err(offline)?).await
}

fn local_dir() -> PathBuf {
    crate::db::app_data_dir().join("company-documents")
}

fn safe_part(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')') { c } else { '_' })
        .take(90)
        .collect();
    let t = t.trim().trim_matches('.').to_string();
    if t.is_empty() { "document".into() } else { t }
}

/// Copy every current version that is not on this computer yet into
/// `<store>/company-documents/<category>/<title> (vN).<ext>`. Never removes a file.
/// Returns { folder, copied }.
#[tauri::command]
pub async fn docs_mirror() -> Result<Value, String> {
    let list = docs_list().await?;
    let root = local_dir();
    let mut copied = 0u32;
    for d in list.get("documents").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        if d.get("archived").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let id = d["id"].as_str().unwrap_or_default().to_string();
        let ver = d["current_version"].as_i64().unwrap_or(1);
        let filename = d["versions"]
            .as_array()
            .and_then(|vs| vs.iter().find(|v| v["version"].as_i64() == Some(ver)))
            .and_then(|v| v["filename"].as_str())
            .unwrap_or("document");
        let ext = filename.rsplit_once('.').map(|(_, e)| format!(".{}", safe_part(e))).unwrap_or_default();
        let dir = root.join(safe_part(d["category"].as_str().unwrap_or("other")));
        let path = dir.join(format!("{} (v{}){}", safe_part(d["title"].as_str().unwrap_or("document")), ver, ext));
        if path.exists() {
            continue;
        }
        let bytes = match fetch(&id, Some(ver)).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&path, bytes).is_ok() {
            copied += 1;
        }
    }
    Ok(serde_json::json!({ "folder": root.to_string_lossy(), "copied": copied }))
}

#[tauri::command]
pub fn docs_open_folder() -> Result<(), String> {
    let dir = local_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}
