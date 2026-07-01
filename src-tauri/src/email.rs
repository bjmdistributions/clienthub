//! Email module: SMTP send (with attachments) + IMAP scan.
//!
//! IMAP uses the synchronous `imap` crate (v3) wrapped in `tokio::task::spawn_blocking`.
//! This avoids async-imap trait-compatibility issues. The imap crate is stable, well-tested,
//! and works perfectly fine inside spawn_blocking for our scan-every-5-min use case.
//!
//! Authentication:
//!   - Password / App Password (recommended with Google Workspace)
//!   - OAuth2 XOAUTH2 (refresh token stored in OS keychain)

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use mail_parser::MessageParser;
use serde::{Deserialize, Serialize};

use crate::db::pool;

// ---------- Credentials ----------

pub fn cred(key: &str) -> Result<String> {
    keyring::Entry::new("clienthub", key)
        .context("keyring entry")?
        .get_password()
        .context(format!("missing credential: {}", key))
}

pub fn cred_opt(key: &str) -> Option<String> {
    keyring::Entry::new("clienthub", key)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn save_cred(key: &str, value: &str) -> Result<()> {
    keyring::Entry::new("clienthub", key)?
        .set_password(value)
        .map_err(Into::into)
}

pub fn delete_cred(key: &str) -> Result<()> {
    let entry = keyring::Entry::new("clienthub", key)?;
    let _ = entry.delete_password();
    Ok(())
}

// ---------- Types ----------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ParsedEmail {
    pub uid: u32,
    pub message_id: Option<String>,
    pub from: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub date: Option<String>,
    pub has_attachments: bool,
    /// Which connected inbox this came from (its label). Empty for legacy single-account scans.
    #[serde(default)]
    pub source: String,
}

/// A monitor-only inbound mailbox (IMAP). Sending always uses the SMTP "send from"
/// account in EmailSettings — these are watched/loaded only.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailInbox {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// Configured inbound mailboxes (passwords live in the credential store, keyed
/// `imap_pass_{id}`).
pub fn load_inboxes() -> Vec<EmailInbox> {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return vec![] };
    conn.query_row("SELECT value FROM settings WHERE key='email_inboxes'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

pub fn save_inboxes(list: &[EmailInbox]) -> Result<()> {
    let conn = pool().get()?;
    let json = serde_json::to_string(list)?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('email_inboxes',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )?;
    Ok(())
}

fn uid_for(key: &str) -> u32 {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return 0 };
    conn.query_row("SELECT value FROM device_state WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok().and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn set_uid_for(key: &str, uid: u32) {
    if let Ok(conn) = pool().get() {
        let _ = conn.execute(
            "INSERT INTO device_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, uid.to_string()],
        );
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailSettings {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub imap_host: String,
    pub imap_port: u16,
    pub user: String,
    pub auth_method: AuthMethod,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Oauth2,
}

pub fn load_settings() -> Result<EmailSettings> {
    let conn = pool().get()?;
    let json: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key='email_settings'",
            [],
            |r| r.get(0),
        )
        .context("email_settings not configured")?;
    Ok(serde_json::from_str(&json)?)
}

pub fn save_settings(s: &EmailSettings) -> Result<()> {
    let conn = pool().get()?;
    let json = serde_json::to_string(s)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('email_settings', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )?;
    Ok(())
}

// ---------- SMTP ----------

pub async fn test_smtp() -> Result<()> {
    let settings = load_settings()?;
    let pass_or_token = match settings.auth_method {
        AuthMethod::Password => cred("smtp_pass")?,
        AuthMethod::Oauth2 => oauth2_access_token().await?,
    };
    let creds = Credentials::new(settings.user.clone(), pass_or_token);
    let mut mailer_builder =
        AsyncSmtpTransport::<Tokio1Executor>::relay(&settings.smtp_host)?.credentials(creds);
    if matches!(settings.auth_method, AuthMethod::Oauth2) {
        mailer_builder = mailer_builder.authentication(vec![Mechanism::Xoauth2]);
    }
    let mailer: AsyncSmtpTransport<Tokio1Executor> = mailer_builder.build();
    mailer.test_connection().await?;
    Ok(())
}

pub async fn send(to: &str, subject: &str, body: &str, attachment: Option<&str>) -> Result<()> {
    let settings = load_settings()?;
    let pass_or_token = match settings.auth_method {
        AuthMethod::Password => cred("smtp_pass")?,
        AuthMethod::Oauth2 => oauth2_access_token().await?,
    };

    let builder = Message::builder()
        .from(settings.user.parse()?)
        .to(to.parse()?)
        .subject(subject);

    let email = if let Some(path) = attachment {
        let bytes = tokio::fs::read(path).await?;
        let filename = std::path::Path::new(path)
            .file_name()
            .ok_or_else(|| anyhow!("bad attachment path"))?
            .to_string_lossy()
            .to_string();
        builder.multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::plain(body.to_string()))
                .singlepart(
                    Attachment::new(filename)
                        .body(bytes, ContentType::parse("application/pdf").unwrap()),
                ),
        )?
    } else {
        builder.body(body.to_string())?
    };

    let creds = Credentials::new(settings.user.clone(), pass_or_token);
    let mut mailer_builder =
        AsyncSmtpTransport::<Tokio1Executor>::relay(&settings.smtp_host)?.credentials(creds);

    if matches!(settings.auth_method, AuthMethod::Oauth2) {
        mailer_builder = mailer_builder.authentication(vec![Mechanism::Xoauth2]);
    }

    mailer_builder.build().send(email).await?;
    Ok(())
}

// ---------- OAuth2 ----------

pub async fn oauth2_access_token() -> Result<String> {
    use oauth2::reqwest::async_http_client;
    use oauth2::{
        basic::BasicClient, AuthUrl, ClientId, ClientSecret, RefreshToken, TokenResponse, TokenUrl,
    };

    let client_id = cred("oauth_client_id")?;
    let client_secret = cred("oauth_client_secret")?;
    let refresh = cred("oauth_refresh_token")?;

    let client = BasicClient::new(
        ClientId::new(client_id),
        Some(ClientSecret::new(client_secret)),
        AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".into())?,
        Some(TokenUrl::new("https://oauth2.googleapis.com/token".into())?),
    );

    let token = client
        .exchange_refresh_token(&RefreshToken::new(refresh))
        .request_async(async_http_client)
        .await
        .map_err(|e| anyhow!("oauth refresh: {}", e))?;

    Ok(token.access_token().secret().clone())
}

// ---------- IMAP ----------

const SCAN_FOLDER: &str = "INBOX";

/// Synchronous IMAP scan — safe to call from spawn_blocking.
fn scan_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    password: String,
    last_uid: u32,
) -> Result<(Vec<ParsedEmail>, u32)> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .context("TLS build")?;

    let client =
        imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls)
            .context("IMAP connect")?;

    let mut session = client
        .login(&user, &password)
        .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?;

    session.select(SCAN_FOLDER).context("select inbox")?;

    let search_query = format!("UID {}:*", last_uid + 1);
    let uid_set = session.uid_search(&search_query).unwrap_or_default();

    let mut results = Vec::new();
    let mut max_uid = last_uid;

    if uid_set.is_empty() {
        let _ = session.logout();
        return Ok((results, max_uid));
    }

    let uid_list: Vec<String> = uid_set.iter().map(|u| u.to_string()).collect();
    let fetch_set = uid_list.join(",");

    let messages = session
        .uid_fetch(&fetch_set, "RFC822")
        .context("uid_fetch")?;

    for msg in messages.iter() {
        let uid = msg.uid.unwrap_or(0);
        // IMAP `UID N:*` returns the highest-UID message even when N is past it,
        // so an inbox with no new mail keeps re-returning its last email — which
        // was getting re-logged as a fresh interaction every 5-minute scan. Skip
        // anything at or below the cursor so only genuinely-new mail is processed.
        if uid <= last_uid { continue; }
        max_uid = max_uid.max(uid);

        if let Some(body_bytes) = msg.body() {
            if let Some(parsed) = MessageParser::default().parse(body_bytes) {
                let from_addr = parsed
                    .from()
                    .and_then(|f| f.first())
                    .and_then(|a| a.address())
                    .unwrap_or("")
                    .to_string();
                let from_name = parsed
                    .from()
                    .and_then(|f| f.first())
                    .and_then(|a| a.name())
                    .map(|s| s.to_string());
                let to: Vec<String> = parsed
                    .to()
                    .map(|t| {
                        t.iter()
                            .filter_map(|a| a.address().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let subject = parsed.subject().unwrap_or("(no subject)").to_string();
                let body_text = parsed
                    .body_text(0)
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let body_html = parsed.body_html(0).map(|s| s.to_string());
                let date = parsed.date().and_then(|d| {
                    chrono::DateTime::<Utc>::from_timestamp(d.to_timestamp(), 0)
                        .map(|dt| dt.to_rfc3339())
                });
                let message_id = parsed.message_id().map(|s| s.to_string());
                let has_attachments = parsed.attachment_count() > 0;

                results.push(ParsedEmail {
                    uid,
                    message_id,
                    from: from_addr,
                    from_name,
                    to,
                    subject,
                    body_text,
                    body_html,
                    date,
                    has_attachments,
                    source: String::new(),
                });
            }
        }
    }

    let _ = session.logout();
    Ok((results, max_uid))
}

pub async fn scan() -> Result<Vec<ParsedEmail>> {
    // Inbound mailboxes to monitor. If none are configured, fall back to the
    // legacy single account (in EmailSettings) so existing setups keep working.
    let mut inboxes = load_inboxes();
    let legacy = load_settings().ok();
    if inboxes.is_empty() {
        if let Some(ref s) = legacy {
            if !s.imap_host.is_empty() {
                inboxes.push(EmailInbox {
                    id: "legacy".into(), label: s.user.clone(),
                    host: s.imap_host.clone(), port: s.imap_port, user: s.user.clone(),
                });
            }
        }
    }

    let mut all = Vec::new();
    for ib in inboxes {
        // The legacy inbox uses the account's configured auth (password or OAuth)
        // and keeps the original UID cursor key; added inboxes are password-only.
        let password = if ib.id == "legacy" {
            match legacy.as_ref().map(|s| &s.auth_method) {
                Some(AuthMethod::Oauth2) => match oauth2_access_token().await { Ok(t) => t, Err(_) => continue },
                _ => match cred("imap_pass") { Ok(p) => p, Err(_) => continue },
            }
        } else {
            match cred(&format!("imap_pass_{}", ib.id)) { Ok(p) => p, Err(_) => continue }
        };
        let uid_key = if ib.id == "legacy" { "last_seen_uid".to_string() } else { format!("last_seen_uid_{}", ib.id) };
        let last_uid = uid_for(&uid_key);
        let (host, port, user, label) = (ib.host.clone(), ib.port, ib.user.clone(), ib.label.clone());
        let res = tokio::task::spawn_blocking(move || scan_blocking(host, port, user, password, last_uid)).await;
        if let Ok(Ok((mut emails, max_uid))) = res {
            for e in &mut emails { e.source = label.clone(); }
            if max_uid > last_uid { set_uid_for(&uid_key, max_uid); }
            all.append(&mut emails);
        }
        // A single bad inbox shouldn't abort the others — errors are skipped above.
    }
    Ok(all)
}

// ---------- Background periodic scanner ----------

pub fn spawn_periodic_scan(interval_secs: u64) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        tick.tick().await; // skip first immediate tick — settings may not be configured yet
        loop {
            tick.tick().await;
            // Skip only if nothing is configured: no legacy account AND no added inboxes.
            if cred_opt("imap_pass").is_none() && cred_opt("oauth_refresh_token").is_none() && load_inboxes().is_empty() {
                continue;
            }
            match scan().await {
                Ok(emails) if !emails.is_empty() => {
                    tracing::info!("imap scan: {} new emails", emails.len());
                    if let Err(e) = process_new_emails(&emails).await {
                        tracing::warn!("process_new_emails failed: {}", e);
                    }
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("imap scan error: {}", e),
            }
        }
    });
}

/// One-time cleanup of the `email_in` interactions that the pre-fix scanner
/// re-logged every 5 minutes (the IMAP `N:*` bug). Keeps the earliest row per
/// (client, subject, body) and tombstones the rest so the deletes sync. Guarded
/// by a settings flag so it runs at most once. Safe to call on every startup.
pub fn dedup_email_interactions_once() {
    let conn = match crate::db::pool().get() { Ok(c) => c, Err(_) => return };
    let done = conn
        .query_row("SELECT value FROM settings WHERE key='email_dedup_v1_done'", [], |r| r.get::<_, String>(0))
        .map(|v| v == "1")
        .unwrap_or(false);
    if done {
        return;
    }
    let ids: Vec<String> = {
        let mut stmt = match conn.prepare(
            "SELECT id FROM interactions WHERE kind='email_in' AND id NOT IN (
                 SELECT id FROM (
                     SELECT id, ROW_NUMBER() OVER (
                         PARTITION BY client_id, COALESCE(subject,''), COALESCE(body,'') ORDER BY created_at
                     ) rn
                     FROM interactions WHERE kind='email_in'
                 ) WHERE rn = 1
             )",
        ) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("email dedup query failed: {}", e); return; }
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|x| x.ok()).collect())
            .unwrap_or_default()
    };
    // Mark done first so a mid-run interruption can't loop; the deletes below are
    // idempotent (already-deleted rows are simply no-ops).
    let _ = conn.execute(
        "INSERT INTO settings (key,value) VALUES ('email_dedup_v1_done','1') ON CONFLICT(key) DO UPDATE SET value='1'",
        [],
    );
    drop(conn);
    let mut n = 0u32;
    for id in &ids {
        if let Ok(conn) = crate::db::pool().get() {
            let _ = conn.execute("DELETE FROM interactions WHERE id=?1", [id]);
        }
        let _ = crate::sync::record_delete("interactions", id);
        n += 1;
    }
    tracing::info!("email dedup: removed {} re-logged email_in interactions", n);
}

/// Match emails against signup rules, then known clients.
async fn process_new_emails(emails: &[ParsedEmail]) -> Result<()> {
    for email in emails {
        // Signup detection first
        if let Ok(Some(rule_name)) =
            crate::signup_rules::matches_any(&email.from, &email.subject)
        {
            tracing::info!("signup rule '{}' matched", rule_name);
            if let Err(e) = crate::signup_rules::auto_create_client(email).await {
                tracing::warn!("auto_create_client failed: {}", e);
            }
            continue;
        }

        // Known client match
        let client_id: Option<String> = {
            let conn = pool().get()?;
            conn.query_row(
                "SELECT id FROM clients WHERE LOWER(email)=LOWER(?1) LIMIT 1",
                [&email.from],
                |r| r.get(0),
            )
            .ok()
        };

        if let Some(cid) = client_id {
            {
                let conn = pool().get()?;
                let invoice_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM invoices WHERE client_id=?1",
                        [&cid],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                if invoice_count == 0 {
                    let current: Option<String> = conn
                        .query_row(
                            "SELECT lead_status FROM clients WHERE id=?1",
                            [&cid],
                            |r| r.get(0),
                        )
                        .ok();
                    if current.as_deref() != Some("prospect") {
                        let mut cols = serde_json::Map::new();
                        cols.insert("lead_status".into(), serde_json::Value::String("prospect".into()));
                        crate::sync::record_upsert("clients", &cid, cols)
                            .context("sync record_upsert lead_status")?;
                        conn.execute(
                            "UPDATE clients SET lead_status=?1 WHERE id=?2",
                            rusqlite::params!["prospect", &cid],
                        )?;
                        tracing::info!("auto-promoted client {} to prospect (no spend history)", cid);
                    }
                }
            }

            if regex::Regex::new(r"(?i)\bunsubscribe\b").map_or(false, |re| re.is_match(&email.body_text)) {
                let conn = pool().get()?;
                let _ = conn.execute(
                    "UPDATE clients SET metadata = json_set(COALESCE(metadata,'{}'), '$.newsletter_contact_frequency', 'never') WHERE id=?1",
                    [&cid],
                );
                let iid = uuid::Uuid::new_v4().to_string();
                let now = Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO interactions (id,client_id,kind,subject,body,created_at) VALUES (?1,?2,'unsubscribe','Unsubscribe request detected',?3,?4)",
                    rusqlite::params![iid, &cid, &email.subject, now],
                )?;
                tracing::info!("client {} unsubscribed via email", &cid[..8]);
                continue;
            }

            let conn = pool().get()?;
            let interaction_id = uuid::Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();

            let mut cols = serde_json::Map::new();
            cols.insert("client_id".into(), serde_json::Value::String(cid.clone()));
            cols.insert("kind".into(), serde_json::Value::String("email_in".into()));
            cols.insert("subject".into(), serde_json::Value::String(email.subject.clone()));
            cols.insert("body".into(), serde_json::Value::String(email.body_text.clone()));
            cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
            crate::sync::record_upsert("interactions", &interaction_id, cols)
                .context("sync record_upsert interaction")?;

            conn.execute(
                "INSERT INTO interactions (id,client_id,kind,subject,body,created_at)
                 VALUES (?1,?2,'email_in',?3,?4,?5)",
                rusqlite::params![
                    interaction_id,
                    cid,
                    &email.subject,
                    &email.body_text,
                    now,
                ],
            )?;

            let body = email.body_text.clone();
            tokio::spawn(async move {
                let _ = crate::ai::extract_structured(&body).await;
            });
        }
    }
    Ok(())
}
