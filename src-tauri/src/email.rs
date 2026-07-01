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

/// Block on an open IMAP connection using the IDLE extension until the mailbox
/// changes (new mail) or `timeout` elapses. Returns `Ok(true)` when the server
/// signalled a change (caller should scan), `Ok(false)` on a plain timeout.
/// Connect + login + SELECT INBOX happen here; the connection is closed on return
/// so each call is a fresh, self-contained IDLE cycle (keeps it simple and robust
/// against half-dead sockets). Safe under spawn_blocking.
fn idle_once_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    password: String,
    timeout: std::time::Duration,
) -> Result<bool> {
    let tls = native_tls::TlsConnector::builder().build().context("TLS build")?;
    let client = imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls)
        .context("IMAP connect")?;
    let mut session = client
        .login(&user, &password)
        .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?;
    session.select(SCAN_FOLDER).context("select inbox")?;

    let idle = session.idle().context("start IDLE")?;
    // wait_with_timeout re-arms the read deadline internally; a MailboxChanged means
    // new/changed mail (we then run the normal scan to fetch only genuinely-new UIDs).
    let outcome = idle
        .wait_with_timeout(timeout)
        .context("IDLE wait")?;
    let changed = matches!(outcome, imap::extensions::idle::WaitOutcome::MailboxChanged);
    let _ = session.logout();
    Ok(changed)
}

/// Archive a single message (by IMAP uid) out of INBOX: mark it `\Seen`, copy it
/// to an Archive mailbox, then flag `\Deleted` + expunge so it leaves the inbox.
/// Falls back gracefully if the server has no "Archive" folder (then it's just
/// marked Seen + Deleted + expunged). Safe under spawn_blocking.
fn archive_uid_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    password: String,
    uid: u32,
) -> Result<()> {
    let tls = native_tls::TlsConnector::builder().build().context("TLS build")?;
    let client = imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls)
        .context("IMAP connect")?;
    let mut session = client
        .login(&user, &password)
        .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?;
    session.select(SCAN_FOLDER).context("select inbox")?;

    let uid_str = uid.to_string();
    // Mark read first so it's Seen even if the later steps fail.
    session
        .uid_store(&uid_str, "+FLAGS (\\Seen)")
        .context("mark seen")?;

    // Try to copy into a common archive mailbox before deleting. Gmail exposes
    // "[Gmail]/All Mail"; most others use "Archive". We try a couple and ignore
    // failures — the message still leaves the inbox via the delete+expunge below.
    let archived = ["Archive", "[Gmail]/All Mail"]
        .iter()
        .any(|folder| session.uid_copy(&uid_str, folder).is_ok());
    if !archived {
        tracing::info!("archive: no archive folder on {}, marking deleted only", imap_host);
    }

    session
        .uid_store(&uid_str, "+FLAGS (\\Deleted)")
        .context("mark deleted")?;
    let _ = session.expunge();
    let _ = session.logout();
    Ok(())
}

/// Verify an IMAP mailbox: connect + LOGIN + SELECT INBOX, then log out. Same
/// connect/login path as `scan_blocking` (minus the fetch). Safe under
/// spawn_blocking. Returns Ok(()) when the credentials work.
fn test_imap_blocking(imap_host: String, imap_port: u16, user: String, password: String) -> Result<()> {
    let tls = native_tls::TlsConnector::builder().build().context("TLS build")?;
    let client = imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls)
        .context("IMAP connect")?;
    let mut session = client
        .login(&user, &password)
        .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?;
    session.select(SCAN_FOLDER).context("select inbox")?;
    let _ = session.logout();
    Ok(())
}

/// Resolve an inbox id to its IMAP connection details + password. `"legacy"` uses
/// the account in EmailSettings (password or OAuth token); other ids use the
/// stored `imap_pass_{id}` credential. Also returns the inbox label (its `source`).
async fn resolve_inbox_creds(id: &str) -> Result<(String, u16, String, String, String)> {
    if id == "legacy" {
        let s = load_settings().context("no email account configured")?;
        if s.imap_host.is_empty() {
            return Err(anyhow!("no IMAP host configured"));
        }
        let pass = match s.auth_method {
            AuthMethod::Oauth2 => oauth2_access_token().await?,
            AuthMethod::Password => cred("imap_pass")?,
        };
        Ok((s.imap_host, s.imap_port, s.user.clone(), pass, s.user))
    } else {
        let ib = load_inboxes()
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| anyhow!("inbox not found"))?;
        let pass = cred(&format!("imap_pass_{}", id))
            .map_err(|_| anyhow!("no password stored for this inbox"))?;
        Ok((ib.host, ib.port, ib.user, pass, ib.label))
    }
}

/// Resolve an inbox by its LABEL (what we stamp on captured clients as `src_inbox`,
/// i.e. `ParsedEmail.source`). Falls back to the legacy account when the label
/// matches its user. Returns the same tuple as `resolve_inbox_creds`.
async fn resolve_inbox_creds_by_label(label: &str) -> Result<(String, u16, String, String, String)> {
    if let Some(ib) = load_inboxes().into_iter().find(|i| i.label == label) {
        return resolve_inbox_creds(&ib.id).await;
    }
    // Legacy account: its "label" is the account user.
    if let Ok(s) = load_settings() {
        if s.user == label && !s.imap_host.is_empty() {
            return resolve_inbox_creds("legacy").await;
        }
    }
    Err(anyhow!("no inbox matches label '{}'", label))
}

/// Archive a captured lead's source email from its inbox: mark `\Seen`, copy to an
/// Archive folder, `\Deleted` + expunge. `inbox_label` is the client's stored
/// `src_inbox` (the inbox label); `uid` is its stored `src_uid`. Best-effort — the
/// caller treats a failure as non-fatal so approval is never blocked.
pub async fn archive_source_email(inbox_label: &str, uid: u32) -> Result<()> {
    let (host, port, user, password, _label) = resolve_inbox_creds_by_label(inbox_label).await?;
    tokio::task::spawn_blocking(move || archive_uid_blocking(host, port, user, password, uid))
        .await
        .context("imap archive task")?
}

/// Test one configured inbox by id (matches `EmailInbox.id`; `"legacy"` uses the
/// account in EmailSettings). Reuses the stored credential (`imap_pass_{id}`, or
/// the legacy account's password/OAuth token). Ok(()) means the connection + auth
/// succeeded.
pub async fn test_inbox(id: &str) -> Result<()> {
    let (host, port, user, password, _label) = resolve_inbox_creds(id).await?;
    tokio::task::spawn_blocking(move || test_imap_blocking(host, port, user, password))
        .await
        .context("imap test task")?
}

/// Fetch the most recent email in an inbox whose From matches `sender_pattern`
/// (regex, optional) and Subject matches `subject_pattern` (regex, optional), if
/// any. Reuses the IMAP fetch behind `scan`. Returns the parsed email (its
/// `source` is set to the inbox label). Scans the newest ~50 messages.
pub async fn fetch_latest_matching(
    inbox_id: &str,
    sender_pattern: Option<String>,
    subject_pattern: Option<String>,
) -> Result<Option<ParsedEmail>> {
    let (host, port, user, password, label) = resolve_inbox_creds(inbox_id).await?;
    let res = tokio::task::spawn_blocking(move || {
        fetch_latest_matching_blocking(host, port, user, password, sender_pattern, subject_pattern)
    })
    .await
    .context("imap fetch task")??;
    Ok(res.map(|mut e| {
        e.source = label.clone();
        e
    }))
}

/// Synchronous side of `fetch_latest_matching`. Fetches the most recent messages,
/// parses them newest-first, returns the first one matching the given regexes.
fn fetch_latest_matching_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    password: String,
    sender_pattern: Option<String>,
    subject_pattern: Option<String>,
) -> Result<Option<ParsedEmail>> {
    let sender_re = match &sender_pattern {
        Some(p) if !p.is_empty() => Some(regex::Regex::new(p).context("invalid sender pattern")?),
        _ => None,
    };
    let subject_re = match &subject_pattern {
        Some(p) if !p.is_empty() => Some(regex::Regex::new(p).context("invalid subject pattern")?),
        _ => None,
    };

    let tls = native_tls::TlsConnector::builder().build().context("TLS build")?;
    let client = imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls)
        .context("IMAP connect")?;
    let mut session = client
        .login(&user, &password)
        .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?;
    let mailbox = session.select(SCAN_FOLDER).context("select inbox")?;

    // Look at the newest ~50 messages by sequence number.
    let total = mailbox.exists;
    if total == 0 {
        let _ = session.logout();
        return Ok(None);
    }
    let start = total.saturating_sub(49).max(1);
    let fetch_set = format!("{}:{}", start, total);
    let messages = session.fetch(&fetch_set, "RFC822").context("fetch")?;

    // Collect (seq, ParsedEmail) so we can scan newest-first.
    let mut parsed: Vec<(u32, ParsedEmail)> = Vec::new();
    for msg in messages.iter() {
        let seq = msg.message;
        if let Some(body_bytes) = msg.body() {
            if let Some(p) = MessageParser::default().parse(body_bytes) {
                let from = p.from().and_then(|f| f.first()).and_then(|a| a.address()).unwrap_or("").to_string();
                let from_name = p.from().and_then(|f| f.first()).and_then(|a| a.name()).map(|s| s.to_string());
                let to: Vec<String> = p.to().map(|t| t.iter().filter_map(|a| a.address().map(|s| s.to_string())).collect()).unwrap_or_default();
                let subject = p.subject().unwrap_or("(no subject)").to_string();
                let body_text = p.body_text(0).map(|s| s.to_string()).unwrap_or_default();
                let body_html = p.body_html(0).map(|s| s.to_string());
                let date = p.date().and_then(|d| chrono::DateTime::<Utc>::from_timestamp(d.to_timestamp(), 0).map(|dt| dt.to_rfc3339()));
                let message_id = p.message_id().map(|s| s.to_string());
                let has_attachments = p.attachment_count() > 0;
                parsed.push((seq, ParsedEmail {
                    uid: 0, message_id, from, from_name, to, subject,
                    body_text, body_html, date, has_attachments, source: String::new(),
                }));
            }
        }
    }
    let _ = session.logout();

    // Newest sequence number first; return the first match.
    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    for (_seq, e) in parsed {
        let sender_ok = sender_re.as_ref().map(|re| re.is_match(&e.from)).unwrap_or(true);
        let subject_ok = subject_re.as_ref().map(|re| re.is_match(&e.subject)).unwrap_or(true);
        if sender_ok && subject_ok {
            return Ok(Some(e));
        }
    }
    Ok(None)
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

// ---------- Real-time inbox watcher (IMAP IDLE) ----------

/// How long a single IDLE cycle blocks before we re-issue it. Kept under the RFC
/// 2177 29-minute ceiling so servers don't drop us; on each wake we reconnect
/// fresh. New mail wakes us immediately regardless of this value.
const IDLE_CYCLE: std::time::Duration = std::time::Duration::from_secs(4 * 60);

/// True when at least one mailbox is configured (legacy account or an added inbox).
fn any_inbox_configured() -> bool {
    !(cred_opt("imap_pass").is_none()
        && cred_opt("oauth_refresh_token").is_none()
        && load_inboxes().is_empty())
}

/// Run the shared scan + process pipeline once and fire an OS notification for any
/// newly-captured lead. Used by both the real-time wake path and the periodic
/// safety-net sweep.
async fn scan_and_notify(app: &tauri::AppHandle) {
    match scan().await {
        Ok(emails) if !emails.is_empty() => {
            tracing::info!("imap scan: {} new emails", emails.len());
            match process_new_emails(&emails).await {
                Ok(leads) => notify_new_leads(app, &leads),
                Err(e) => tracing::warn!("process_new_emails failed: {}", e),
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("imap scan error: {}", e),
    }
}

/// Raise a system notification for each newly-captured lead. Best-effort.
fn notify_new_leads(app: &tauri::AppHandle, leads: &[NewLead]) {
    use tauri_plugin_notification::NotificationExt;
    for lead in leads {
        let _ = app
            .notification()
            .builder()
            .title("New lead")
            .body(format!("New lead: {}", lead.name))
            .show();
        tracing::info!("notified new lead {} ({})", lead.name, &lead.client_id[..8.min(lead.client_id.len())]);
    }
}

/// Resolve the connection details + password for one inbox id, synchronously where
/// possible. The legacy account may use OAuth (needs an async token refresh), so
/// this is async. Returns None when the inbox has no usable credential.
async fn inbox_conn(ib: &EmailInbox) -> Option<(String, u16, String, String)> {
    let password = if ib.id == "legacy" {
        match load_settings().ok().map(|s| s.auth_method) {
            Some(AuthMethod::Oauth2) => oauth2_access_token().await.ok()?,
            _ => cred("imap_pass").ok()?,
        }
    } else {
        cred(&format!("imap_pass_{}", ib.id)).ok()?
    };
    Some((ib.host.clone(), ib.port, ib.user.clone(), password))
}

/// Enumerate the mailboxes to watch: every added inbox, plus the legacy account
/// (from EmailSettings) when it has an IMAP host — mirrors `scan()`.
fn watchable_inboxes() -> Vec<EmailInbox> {
    let mut inboxes = load_inboxes();
    if let Ok(s) = load_settings() {
        if !s.imap_host.is_empty() {
            inboxes.push(EmailInbox {
                id: "legacy".into(),
                label: s.user.clone(),
                host: s.imap_host,
                port: s.imap_port,
                user: s.user,
            });
        }
    }
    inboxes
}

/// One resilient IDLE loop for a single inbox. Holds a connection open (via IDLE),
/// wakes on new mail, runs the scan+process pipeline, then re-idles. Reconnects on
/// drop with exponential backoff; backs off hardest on auth failures so we never
/// hammer the server. Exits if the inbox is removed from config.
fn spawn_inbox_watcher(app: tauri::AppHandle, inbox_id: String) {
    tauri::async_runtime::spawn(async move {
        // Backoff state: grows on error, resets on a clean IDLE cycle.
        let mut backoff_secs: u64 = 0;
        loop {
            // Stop watching if this inbox no longer exists (removed in settings).
            let ib = match watchable_inboxes().into_iter().find(|i| i.id == inbox_id) {
                Some(ib) => ib,
                None => {
                    tracing::info!("inbox watcher {} exiting (inbox removed)", inbox_id);
                    return;
                }
            };

            if backoff_secs > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            }

            let (host, port, user, password) = match inbox_conn(&ib).await {
                Some(c) => c,
                None => {
                    // No credential yet — wait a while, don't spin.
                    backoff_secs = 60;
                    continue;
                }
            };

            // Do an initial sweep so anything that arrived while we were down (or
            // before the first IDLE) is captured immediately.
            scan_and_notify(&app).await;

            let idle_res = tokio::task::spawn_blocking(move || {
                idle_once_blocking(host, port, user, password, IDLE_CYCLE)
            })
            .await;

            match idle_res {
                Ok(Ok(changed)) => {
                    backoff_secs = 0; // healthy cycle
                    if changed {
                        // New/changed mail signalled — fetch + process only new UIDs.
                        scan_and_notify(&app).await;
                    }
                    // On a plain timeout we just loop and re-issue IDLE.
                }
                Ok(Err(e)) => {
                    let msg = e.to_string();
                    // Auth failures: back off hard (5 min) so we don't lock the account.
                    let is_auth = msg.contains("IMAP login") || msg.to_lowercase().contains("auth");
                    backoff_secs = if is_auth {
                        300
                    } else {
                        // Exponential: 5s → 10 → 20 … capped at 2 min.
                        (backoff_secs.max(5) * 2).min(120)
                    };
                    tracing::warn!("inbox {} IDLE error ({}); retrying in {}s", inbox_id, msg, backoff_secs);
                }
                Err(join_err) => {
                    backoff_secs = (backoff_secs.max(5) * 2).min(120);
                    tracing::warn!("inbox {} IDLE task join error: {}", inbox_id, join_err);
                }
            }
        }
    });
}

/// Start near-real-time inbox monitoring. Spawns one IMAP-IDLE watcher per
/// configured inbox and a lightweight supervisor that (a) picks up inboxes added
/// at runtime and (b) runs a periodic safety-net full scan in case a server
/// doesn't support IDLE or an IDLE wake was missed. Replaces the old fixed-interval
/// poll (`spawn_periodic_scan`).
pub fn spawn_realtime_watchers(app: tauri::AppHandle) {
    use std::collections::HashSet;
    tauri::async_runtime::spawn(async move {
        let mut watched: HashSet<String> = HashSet::new();
        // Safety-net sweep interval — much longer than the old 300s poll since IDLE
        // is doing the real work; this only catches IDLE-incapable servers.
        let mut safety = tokio::time::interval(std::time::Duration::from_secs(600));
        safety.tick().await; // consume immediate tick
        loop {
            if any_inbox_configured() {
                for ib in watchable_inboxes() {
                    if watched.insert(ib.id.clone()) {
                        tracing::info!("starting real-time watcher for inbox {}", ib.id);
                        spawn_inbox_watcher(app.clone(), ib.id.clone());
                    }
                }
            }
            // Re-check config for new inboxes every 60s; run the safety sweep on its
            // own (longer) cadence.
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {}
                _ = safety.tick() => {
                    if any_inbox_configured() {
                        scan_and_notify(&app).await;
                    }
                }
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

/// A lead newly captured during a scan: its client id + display name. Returned so
/// the real-time watcher can raise an OS notification ("New lead: <name>").
pub struct NewLead {
    pub client_id: String,
    pub name: String,
}

/// Match emails against signup rules, then known clients. Returns the leads that
/// were newly auto-created (for the caller to notify on).
async fn process_new_emails(emails: &[ParsedEmail]) -> Result<Vec<NewLead>> {
    let mut new_leads: Vec<NewLead> = Vec::new();
    for email in emails {
        // Signup detection first
        if let Ok(Some(m)) =
            crate::signup_rules::matches_any(&email.from, &email.subject, &email.source)
        {
            tracing::info!("signup rule '{}' matched (patternless={})", m.name, m.patternless);
            // A patternless (inbox-only) rule must ONLY create from a real parsed
            // form — never AI-create arbitrary inbox mail into a client.
            match crate::signup_rules::auto_create_client(email, m.patternless).await {
                Ok(Some(client_id)) => {
                    // Record the source email's identity so the client can be archived
                    // from its inbox once approved (best-effort; never fatal).
                    record_source_email(&client_id, email);
                    // Only treat as a "new lead" (notify) when this scan actually
                    // created a NEW pending client — dedup returns an existing id
                    // that's already active, which we don't want to re-announce.
                    if let Some(name) = pending_client_name(&client_id) {
                        new_leads.push(NewLead { client_id, name });
                    }
                }
                Ok(None) => tracing::info!("signup: skipped non-form email under inbox-only rule"),
                Err(e) => tracing::warn!("auto_create_client failed: {}", e),
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
    Ok(new_leads)
}

/// Return the name of a client only if it's currently PENDING approval. Used to
/// gate the "new lead" notification: a dedup that returned an already-active
/// client's id shouldn't re-announce it.
fn pending_client_name(client_id: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row(
        "SELECT name FROM clients WHERE id=?1 AND approval_status='pending'",
        [client_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

/// Stamp the source email's identity onto a captured client's metadata so the
/// message can be archived from its inbox once the client is approved. Writes the
/// keys `src_inbox` (inbox label / `source`), `src_uid` (IMAP uid), and
/// `src_message_id`. Best-effort: a failure here must never abort capture.
fn record_source_email(client_id: &str, email: &ParsedEmail) {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return };
    // json_set the source keys; message_id is only written when present.
    let res = if let Some(mid) = email.message_id.as_deref() {
        conn.execute(
            "UPDATE clients SET metadata = json_set(COALESCE(metadata,'{}'), \
                '$.src_inbox', ?2, '$.src_uid', ?3, '$.src_message_id', ?4) WHERE id=?1",
            rusqlite::params![client_id, email.source, email.uid as i64, mid],
        )
    } else {
        conn.execute(
            "UPDATE clients SET metadata = json_set(COALESCE(metadata,'{}'), \
                '$.src_inbox', ?2, '$.src_uid', ?3) WHERE id=?1",
            rusqlite::params![client_id, email.source, email.uid as i64],
        )
    };
    match res {
        Ok(_) => {
            // Mirror the change into the sync log so peers see the source metadata.
            let meta: Option<String> = conn
                .query_row("SELECT metadata FROM clients WHERE id=?1", [client_id], |r| r.get(0))
                .ok();
            if let Some(meta) = meta {
                let mut cols = serde_json::Map::new();
                cols.insert("metadata".into(), serde_json::Value::String(meta));
                let _ = crate::sync::record_upsert("clients", client_id, cols);
            }
        }
        Err(e) => tracing::warn!("record_source_email for {}: {}", client_id, e),
    }
}
