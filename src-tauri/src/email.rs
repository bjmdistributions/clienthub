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

// Secrets now live in an app-local encrypted store (secret_store) instead of the OS
// keychain, so an ad-hoc-signed build stops re-prompting for keychain access on every
// macOS update. Existing installs are migrated on first read (one keychain prompt,
// then never again). On any store error we fall back to the keyring so nothing breaks.
pub fn cred(key: &str) -> Result<String> {
    cred_opt(key).ok_or_else(|| anyhow!("missing credential: {}", key))
}

pub fn cred_opt(key: &str) -> Option<String> {
    // 1) app-local encrypted store — no keychain access, no prompt.
    if let Some(v) = crate::secret_store::get(key) {
        return Some(v);
    }
    // 2) one-time migration: read the legacy OS keyring (prompts ONCE on macOS for a
    //    still-present item), copy it into the store, then never touch the keyring
    //    again for this key. A genuinely-absent entry returns None WITHOUT prompting.
    if let Some(v) = keyring::Entry::new("clienthub", key).ok().and_then(|e| e.get_password().ok()) {
        let _ = crate::secret_store::put(key, &v);
        return Some(v);
    }
    None
}

pub fn save_cred(key: &str, value: &str) -> Result<()> {
    // Store only — a keyring WRITE also re-prompts on macOS, which would defeat the fix.
    crate::secret_store::put(key, value)
}

pub fn delete_cred(key: &str) -> Result<()> {
    let _ = crate::secret_store::remove(key);
    // Best-effort clear the legacy keyring copy so it can't be silently re-migrated.
    if let Ok(entry) = keyring::Entry::new("clienthub", key) {
        let _ = entry.delete_password();
    }
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
///
/// `scope` distinguishes an org-shared inbox (every admin inherits it) from a
/// personal one (only the admin who added it watches it). Defaults to `"org"` so
/// rows written by older builds — which had no scope field — are treated as the
/// shared org inbox (the desired "always linked" behaviour).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailInbox {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `"org"` (shared, synced, inherited by all admins) or `"me"` (personal,
    /// device-local, not synced). Absent in legacy rows → treated as `"org"`.
    #[serde(default = "default_inbox_scope")]
    pub scope: String,
    /// A placeholder entry (demo/sales accounts): counts toward "inbox linked" for
    /// display, but is never dialed by the real-time watcher or the safety-net scan.
    /// Absent in real rows → false.
    #[serde(default)]
    pub demo: bool,
    /// How this mailbox authenticates. `Password` (an app password in
    /// `imap_pass_{id}`) or `Oauth2` (a refresh token under the `inbox_oauth_{id}`
    /// credential prefix, granted by that mailbox's own owner via Connect Google).
    /// MUST keep `#[serde(default)]`: every inbox row stored before this field
    /// existed has to keep parsing, or `read_inboxes_key`'s `unwrap_or_default()`
    /// silently zeroes the whole inbox list.
    #[serde(default)]
    pub auth_method: AuthMethod,
}

fn default_inbox_scope() -> String { "org".into() }

// ── Settings keys ──────────────────────────────────────────────────────────
// The ORG-shared keys are synced (via `sync::record_upsert`) so every device and
// every signed-in admin in the org inherits the same config once it's set up
// once. The PERSONAL keys are written raw (never synced) so an admin who opts out
// keeps their own config on this device only.
const K_ORG_SETTINGS: &str = "email_settings";           // legacy key → org-shared send/monitor account
const K_ORG_INBOXES: &str = "email_inboxes";             // legacy key → org-shared monitor inboxes
const K_PERSONAL_SETTINGS: &str = "email_settings_personal";
const K_PERSONAL_INBOXES: &str = "email_inboxes_personal";
/// Per-device flag: when "0"/"false" the signed-in admin uses their PERSONAL send
/// config + inboxes instead of the org defaults. Defaults to org (unset → org).
const K_USE_ORG_DEFAULT: &str = "email_use_org_default";

/// Whether this device/account is currently using the org default send config
/// (true) or a personal override (false). Device-local; unset means org.
pub fn use_org_default() -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return true };
    conn.query_row("SELECT value FROM settings WHERE key=?1", [K_USE_ORG_DEFAULT], |r| r.get::<_, String>(0))
        .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
        .unwrap_or(true)
}

/// Set the org-default-vs-personal flag for this device. Device-local (not synced).
pub fn set_use_org_default(on: bool) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![K_USE_ORG_DEFAULT, if on { "1" } else { "0" }],
    )?;
    Ok(())
}

fn read_inboxes_key(key: &str) -> Vec<EmailInbox> {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return vec![] };
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// The org-shared monitor inboxes (synced). Every admin inherits these.
pub fn load_org_inboxes() -> Vec<EmailInbox> { read_inboxes_key(K_ORG_INBOXES) }

/// This device's personal monitor inboxes (never synced).
pub fn load_personal_inboxes() -> Vec<EmailInbox> { read_inboxes_key(K_PERSONAL_INBOXES) }

/// The EFFECTIVE monitor inboxes to load/watch: always the org-shared set, plus
/// this device's personal set. An admin can add a personal support box on top of
/// the shared one, so we watch the union. Deduped by id.
pub fn load_inboxes() -> Vec<EmailInbox> {
    let mut out = load_org_inboxes();
    let mut seen: std::collections::HashSet<String> = out.iter().map(|i| i.id.clone()).collect();
    for ib in load_personal_inboxes() {
        if seen.insert(ib.id.clone()) { out.push(ib); }
    }
    out
}

/// Persist a scoped inbox list. Org lists are written to the synced key AND pushed
/// to the sync log (so every device inherits them); personal lists are written raw
/// (device-local, never synced).
fn save_inboxes_scoped(scope: &str, list: &[EmailInbox]) -> Result<()> {
    let key = if scope == "me" { K_PERSONAL_INBOXES } else { K_ORG_INBOXES };
    let conn = pool().get()?;
    let json = serde_json::to_string(list)?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, json],
    )?;
    // Org inboxes propagate to every device/account in the org (desktop is
    // `org_default`, so a plain-key `settings` upsert is org-scoped). Personal
    // inboxes intentionally stay off the wire.
    if scope != "me" {
        let mut cols = serde_json::Map::new();
        cols.insert("value".into(), serde_json::Value::String(json));
        let _ = crate::sync::record_upsert("settings", key, cols);
    }
    Ok(())
}

/// Save the ORG-shared monitor inboxes (synced to all admins).
pub fn save_inboxes(list: &[EmailInbox]) -> Result<()> {
    save_inboxes_scoped("org", list)
}

/// Save this device's PERSONAL monitor inboxes (never synced).
pub fn save_personal_inboxes(list: &[EmailInbox]) -> Result<()> {
    save_inboxes_scoped("me", list)
}

fn uid_for(key: &str) -> u32 {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return 0 };
    conn.query_row("SELECT value FROM device_state WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Whether this mailbox's cursor has been deliberately positioned.
///
/// Checked instead of `cursor != 0` because a cursor of 0 is ambiguous: it means
/// both "never seeded" AND "seeded against an empty mailbox" (UIDNEXT 1 -> head 0).
/// Reading it as "never seeded" left a newly-linked empty mailbox re-seeding on
/// every pass and never reading its first message.
///
/// A pre-existing non-zero cursor counts as seeded, so mailboxes that were already
/// scanning healthily before this guard existed are not re-seeded to head (which
/// would skip anything that arrived since their last scan).
pub fn is_seeded(inbox_id: &str) -> bool { seeded(inbox_id) }

fn seeded(inbox_id: &str) -> bool {
    let cursor_key = if inbox_id == "legacy" {
        "last_seen_uid".to_string()
    } else {
        format!("last_seen_uid_{}", inbox_id)
    };
    uid_for(&format!("inbox_seeded_{}", inbox_id)) == 1 || uid_for(&cursor_key) > 0
}

/// Whether the user explicitly asked to import this mailbox's whole history.
/// Absent (the default) means "read from now on".
fn backfill_allowed(inbox_id: &str) -> bool {
    uid_for(&format!("inbox_backfill_ok_{}", inbox_id)) == 1
}

/// Record that the user deliberately chose to import a mailbox's back catalogue.
/// Without this marker `scan()` refuses to read a mailbox sitting at cursor 0.
pub fn mark_backfill_allowed(inbox_id: &str) {
    set_uid_for(&format!("inbox_backfill_ok_{}", inbox_id), 1);
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
    /// The staff id of the admin who currently "owns" / receives this org inbox.
    /// Used by the "transfer to a different email admin" action; empty for legacy
    /// records and personal configs. Purely informational for resolution — the
    /// creds still come from the keyring / server round-trip.
    #[serde(default)]
    pub owner_staff_id: String,
    /// Address mail leaves as when it differs from the SMTP login. Blank = use `user`.
    /// Gmail silently rewrites this back to the login unless it is a verified
    /// *Send mail as* address (or an alias) on the authenticating account.
    #[serde(default)]
    pub from_email: String,
    /// Same, but used only by the invoice path, so invoices can carry a billing address
    /// while everything else goes out as the sales one. Blank = fall back to `from_email`.
    #[serde(default)]
    pub from_invoices: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Oauth2,
}

/// How to authenticate one IMAP session.
///
/// This exists because Gmail **rejects an OAuth access token in the LOGIN password
/// slot** — it requires SASL `AUTHENTICATE XOAUTH2`. Flattening both kinds to a
/// bare `String` (which is what the code did before) meant "Connect Google" made
/// sending work and reading silently fail with an auth error. The auth kind now
/// travels with the credential so a connect site cannot forget which one it holds.
#[derive(Clone, Debug)]
pub enum ImapAuth {
    Password(String),
    OAuth2(String),
}

/// SASL XOAUTH2 initial client response. The `imap` crate base64-encodes whatever
/// `process` returns, so this is the raw form Google documents:
/// `user=<addr>^Aauth=Bearer <token>^A^A`.
struct GmailOAuth<'a> {
    user: &'a str,
    access_token: &'a str,
}

impl imap::Authenticator for GmailOAuth<'_> {
    type Response = String;
    fn process(&self, _challenge: &[u8]) -> Self::Response {
        format!("user={}\x01auth=Bearer {}\x01\x01", self.user, self.access_token)
    }
}

type ImapSession = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

/// Connect + authenticate one IMAP session, honouring the auth kind. Every IMAP
/// entry point goes through here so the password/XOAUTH2 choice is made in exactly
/// one place. Safe under `spawn_blocking`.
fn imap_session(host: &str, port: u16, user: &str, auth: &ImapAuth) -> Result<ImapSession> {
    imap_session_with_socket(host, port, user, auth).map(|(s, _)| s)
}

/// As `imap_session`, but also hands back a cloned handle to the underlying socket.
///
/// The clone exists for one reason: IDLE. `wait_with_timeout` sets its own read
/// deadline and then **clears it to `None`** rather than restoring ours, and the
/// `Handle` is dropped inside that same call - so the `DONE` handshake, and the
/// `logout` after it, run with no read timeout at all. On a blackholed socket (the
/// precise fault a 4-minute idle connection is most exposed to) that read blocks
/// forever inside a `spawn_blocking` task, which cannot be cancelled: the watcher
/// never loops again and the thread is leaked, one per flap. Shutting the socket
/// down from outside is the only way to unblock it.
fn imap_session_with_socket(
    host: &str,
    port: u16,
    user: &str,
    auth: &ImapAuth,
) -> Result<(ImapSession, std::net::TcpStream)> {
    use std::net::ToSocketAddrs;
    let tls = native_tls::TlsConnector::builder().build().context("TLS build")?;

    // Explicit socket timeouts. `imap::connect` sets none, so a half-open socket (a
    // VPN flap, a firewall silently dropping the connection) blocks the read
    // FOREVER inside spawn_blocking, which cannot be cancelled. That used to stall
    // one mailbox; now that `scan()` is serialised it would stall every watcher, the
    // safety sweep and the Settings command at once, while the app still looked
    // healthy. The read timeout is deliberately longer than IDLE_CYCLE so a normal
    // IDLE wait is never cut short (the crate re-arms the deadline itself anyway).
    // Try EVERY resolved address, not just the first. `TcpStream::connect` did this
    // for us; `connect_timeout` takes a single SocketAddr, so taking `.next()` quietly
    // dropped the fallback. getaddrinfo returns AAAA first on any machine with a
    // global IPv6 address, and imap.gmail.com has AAAA records - so on a box with
    // configured-but-unroutable IPv6 (split-tunnel VPN, dead 6to4 remnant, an ISP
    // prefix with no path) that turned a working mailbox into a permanent failure.
    let addrs: Vec<std::net::SocketAddr> = (host, port)
        .to_socket_addrs()
        .context("resolve IMAP host")?
        .collect();
    if addrs.is_empty() {
        return Err(anyhow!("no address for {}", host));
    }
    // Keep the aggregate near 20s however many addresses come back.
    let per_addr = std::time::Duration::from_secs(20) / (addrs.len().min(4) as u32);
    let mut last_err: Option<std::io::Error> = None;
    let stream = 'connected: {
        for addr in &addrs {
            match std::net::TcpStream::connect_timeout(addr, per_addr) {
                Ok(s) => break 'connected s,
                Err(e) => last_err = Some(e),
            }
        }
        return Err(anyhow!(
            "IMAP connect to {}: {}",
            host,
            last_err.map(|e| e.to_string()).unwrap_or_else(|| "no address reachable".into())
        ));
    };
    stream.set_read_timeout(Some(std::time::Duration::from_secs(300)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(60)))?;
    let socket = stream.try_clone().context("clone IMAP socket")?;
    let tls_stream = tls.connect(host, stream).context("IMAP TLS handshake")?;
    let mut client = imap::Client::new(tls_stream);
    // `imap::connect` did this for us. Login happens to tolerate an unconsumed
    // greeting (it skips stray untagged lines), but relying on that means a server
    // whose greeting the parser dislikes reports a LOGIN failure instead of a connect
    // failure - and the watcher treats "IMAP login" errors as a long auth backoff.
    client.read_greeting().map_err(|e| anyhow!("IMAP greeting: {}", e))?;
    let session = match auth {
        ImapAuth::Password(pass) => client
            .login(user, pass)
            .map_err(|(e, _)| anyhow!("IMAP login: {}", e))?,
        ImapAuth::OAuth2(token) => {
            let authr = GmailOAuth { user, access_token: token };
            client
                .authenticate("XOAUTH2", &authr)
                .map_err(|(e, _)| anyhow!("IMAP XOAUTH2: {}", e))?
        }
    };
    Ok((session, socket))
}

fn read_settings_key(key: &str) -> Option<EmailSettings> {
    let conn = pool().get().ok()?;
    let json: String = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// The org-shared send/monitor account (synced). Every admin inherits this.
pub fn load_org_settings() -> Option<EmailSettings> { read_settings_key(K_ORG_SETTINGS) }

/// This device's personal send/monitor account (never synced), if configured.
pub fn load_personal_settings() -> Option<EmailSettings> { read_settings_key(K_PERSONAL_SETTINGS) }

/// The EFFECTIVE send/monitor account for this device: the personal override when
/// this admin has opted out AND has one configured, otherwise the org default.
/// This is what `send()`, `test_smtp()`, and the legacy scan path use, so a fresh
/// admin with an empty personal config transparently inherits the org account.
pub fn load_settings() -> Result<EmailSettings> {
    if !use_org_default() {
        if let Some(s) = load_personal_settings() {
            return Ok(s);
        }
    }
    load_org_settings().context("email_settings not configured")
}

/// Persist the send/monitor account under a scope. `"me"` writes the personal
/// (device-local) key; anything else writes the org-shared key AND syncs it so
/// every admin/device inherits it.
pub fn save_settings_scoped(scope: &str, s: &EmailSettings) -> Result<()> {
    let key = if scope == "me" { K_PERSONAL_SETTINGS } else { K_ORG_SETTINGS };
    let conn = pool().get()?;
    let json = serde_json::to_string(s)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, json],
    )?;
    if scope != "me" {
        let mut cols = serde_json::Map::new();
        cols.insert("value".into(), serde_json::Value::String(json));
        let _ = crate::sync::record_upsert("settings", key, cols);
    }
    Ok(())
}

/// Save the org-shared send/monitor account (synced to all admins).
pub fn save_settings(s: &EmailSettings) -> Result<()> {
    save_settings_scoped("org", s)
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
    send_threaded(to, subject, body, attachment, None, None).await
}

/// Like `send`, but stamps the invoice From address (`from_invoices`) when one is set, so
/// a customer replying to an invoice reaches the billing mailbox rather than the sales one.
/// Falls back to `from_email` and then the SMTP login, same as every other send.
pub async fn send_invoice_mail(
    to: &str, subject: &str, body: &str, attachment: Option<&str>,
) -> Result<()> {
    let from = load_settings().map(|s| s.from_invoices).unwrap_or_default();
    send_threaded(to, subject, body, attachment, None, Some(&from)).await
}

/// Like `send`, but if `in_reply_to` is a message-id, sets the `In-Reply-To` and
/// `References` headers so the message lands inside the recipient's existing email
/// thread (Gmail/Outlook group a conversation by these). The id is angle-bracket
/// wrapped if it isn't already (RFC 5322 msg-id form).
pub async fn send_threaded(
    to: &str, subject: &str, body: &str, attachment: Option<&str>, in_reply_to: Option<&str>,
    from: Option<&str>,
) -> Result<()> {
    let settings = load_settings()?;
    let pass_or_token = match settings.auth_method {
        AuthMethod::Password => cred("smtp_pass")?,
        AuthMethod::Oauth2 => oauth2_access_token().await?,
    };

    // Explicit `from` (the invoice path) wins, then the configured default, then the SMTP
    // login. Note Gmail rewrites From back to the login unless the address is verified under
    // *Send mail as* on the authenticating account, so a wrong value here fails silently.
    let from_addr = [from.unwrap_or(""), &settings.from_email, &settings.user]
        .into_iter()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();

    let mut builder = Message::builder()
        .from(from_addr.parse()?)
        .to(to.parse()?)
        .subject(subject);

    // Replies belong with the address the mail went out as. Without this a customer
    // replying to an invoice lands in the sending admin's personal mailbox instead.
    if from_addr != settings.user.trim() {
        builder = builder.reply_to(from_addr.parse()?);
    }

    if let Some(mid) = in_reply_to.map(str::trim).filter(|m| !m.is_empty()) {
        use lettre::message::header::{InReplyTo, References};
        let v = if mid.starts_with('<') { mid.to_string() } else { format!("<{mid}>") };
        builder = builder
            .header(InReplyTo::from(v.clone()))
            .header(References::from(v));
    }

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

/// Cache of live access tokens, keyed by credential prefix.
///
/// Without this, every send, every 4-minute IDLE cycle and every scan did a full
/// network refresh - Google tokens last ~3600s, so that is roughly 30x more token
/// requests than needed, per mailbox. The visible symptom of hitting Google's rate
/// limit is `invalid_grant`, which looks exactly like "Google keeps disconnecting".
static TOKEN_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, std::time::Instant)>>,
> = std::sync::OnceLock::new();

fn token_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, std::time::Instant)>> {
    TOKEN_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Drop any cached token for a prefix. Called after a fresh consent so the new
/// grant is used immediately instead of the previous account's token.
pub fn invalidate_token_cache(prefix: &str) {
    if let Ok(mut m) = token_cache().lock() {
        m.remove(prefix);
    }
}

/// The primary/legacy account's Google access token (credential prefix `oauth`).
pub async fn oauth2_access_token() -> Result<String> {
    oauth_access_token_for("oauth").await
}

/// A mailbox-specific Google access token (credential prefix `inbox_oauth_{id}`).
/// This is what lets a SECOND person connect their own mailbox without ever handing
/// over a password: they consent as themselves, and only their refresh token is
/// stored, under their own inbox's prefix.
pub async fn inbox_access_token(inbox_id: &str) -> Result<String> {
    oauth_access_token_for(&format!("inbox_oauth_{}", inbox_id)).await
}

/// Exchange the stored refresh token for an access token, cached until shortly
/// before expiry. `prefix` selects which stored credential set to use.
pub async fn oauth_access_token_for(prefix: &str) -> Result<String> {
    use oauth2::reqwest::async_http_client;
    use oauth2::{
        basic::BasicClient, AuthUrl, ClientId, ClientSecret, RefreshToken, TokenResponse, TokenUrl,
    };

    if let Ok(m) = token_cache().lock() {
        if let Some((tok, expires_at)) = m.get(prefix) {
            if std::time::Instant::now() < *expires_at {
                return Ok(tok.clone());
            }
        }
    }

    let client_id = cred(&format!("{}_client_id", prefix))?;
    let client_secret = cred(&format!("{}_client_secret", prefix))?;
    let refresh = cred(&format!("{}_refresh_token", prefix))?;

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

    let access = token.access_token().secret().clone();
    // Refresh 5 minutes early so a long IDLE cycle never sends an expiring token.
    let ttl = token
        .expires_in()
        .unwrap_or_else(|| std::time::Duration::from_secs(3600))
        .saturating_sub(std::time::Duration::from_secs(300))
        .max(std::time::Duration::from_secs(60));
    if let Ok(mut m) = token_cache().lock() {
        m.insert(prefix.to_string(), (access.clone(), std::time::Instant::now() + ttl));
    }
    Ok(access)
}

/// The IMAP auth for one configured inbox, honouring its own auth method.
async fn inbox_auth(ib: &EmailInbox) -> Result<ImapAuth> {
    match ib.auth_method {
        AuthMethod::Oauth2 => Ok(ImapAuth::OAuth2(inbox_access_token(&ib.id).await?)),
        AuthMethod::Password => Ok(ImapAuth::Password(
            cred(&format!("imap_pass_{}", ib.id))
                .map_err(|_| anyhow!("no password stored for this inbox"))?,
        )),
    }
}

/// The IMAP auth for the legacy/primary account in `EmailSettings`.
async fn legacy_auth(s: &EmailSettings) -> Result<ImapAuth> {
    match s.auth_method {
        AuthMethod::Oauth2 => Ok(ImapAuth::OAuth2(oauth2_access_token().await?)),
        AuthMethod::Password => Ok(ImapAuth::Password(cred("imap_pass")?)),
    }
}

// ---------- IMAP ----------

const SCAN_FOLDER: &str = "INBOX";

/// How many unread MESSAGES a single scan will import before treating the backlog
/// as pathological and keeping only the newest. Generous enough to cover a long
/// genuine absence; tight enough that a cursor frozen for months does not trigger an
/// unbounded import. Counted in messages, never in UID distance - see the clamp in
/// `scan_blocking` for why that distinction matters on Gmail.
const MAX_CATCHUP: usize = 5_000;

/// The mailbox's current highest UID, without fetching a single message body.
/// `UIDNEXT` is served straight from the SELECT response, so this is one round
/// trip. Used to seed a cursor so a newly-linked mailbox starts from "now".
fn current_max_uid_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    auth: ImapAuth,
) -> Result<u32> {
    let mut session = imap_session(&imap_host, imap_port, &user, &auth)?;
    let mailbox = session.select(SCAN_FOLDER).context("select inbox")?;
    let max = match mailbox.uid_next {
        Some(next) => next.saturating_sub(1),
        // Rare: a server that omits UIDNEXT. Ask for the UID list instead - still
        // no bodies fetched.
        None => session
            .uid_search("ALL")
            .context("probe UID list (server gave no UIDNEXT)")?
            .into_iter()
            .max()
            .unwrap_or(0),
    };
    let _ = session.logout();
    Ok(max)
}

/// Seed an inbox's UID cursor to the mailbox's current head, so the first scan
/// reads only mail that arrives from now on.
///
/// WHY THIS EXISTS: `uid_for` returns 0 for an unknown key, which makes
/// `scan_blocking` search `UID 1:*` and fetch the ENTIRE mailbox. Every message is
/// then logged as an interaction stamped `Utc::now()` (not the email's own date),
/// so linking a mailbox with years of history would rewrite every matched client's
/// "last contact" to today across desktop and mobile, and replay old form mail
/// through the capture rules as fresh leads. Seeding the cursor first is what makes
/// linking a second mailbox a safe, reversible action.
pub async fn seed_uid_cursor(inbox_id: &str) -> Result<u32> {
    let (host, port, user, auth, _label) = resolve_inbox_creds(inbox_id).await?;
    let max = tokio::task::spawn_blocking(move || current_max_uid_blocking(host, port, user, auth))
        .await
        .context("imap uid probe task")??;
    let key = if inbox_id == "legacy" {
        "last_seen_uid".to_string()
    } else {
        format!("last_seen_uid_{}", inbox_id)
    };
    set_uid_for(&key, max);
    // Record the FACT of seeding separately: `max` is legitimately 0 for an empty
    // mailbox, and a 0 cursor is otherwise indistinguishable from "never seeded".
    set_uid_for(&format!("inbox_seeded_{}", inbox_id), 1);
    Ok(max)
}

/// Synchronous IMAP scan — safe to call from spawn_blocking.
fn scan_blocking(
    imap_host: String,
    imap_port: u16,
    user: String,
    auth: ImapAuth,
    last_uid: u32,
    allow_backfill: bool,
) -> Result<(Vec<ParsedEmail>, u32)> {
    let mut session = imap_session(&imap_host, imap_port, &user, &auth)?;

    session.select(SCAN_FOLDER).context("select inbox")?;

    let search_query = format!("UID {}:*", last_uid + 1);
    let uid_set = session.uid_search(&search_query).unwrap_or_default();

    let mut results = Vec::new();
    let mut max_uid = last_uid;

    if uid_set.is_empty() {
        let _ = session.logout();
        return Ok((results, max_uid));
    }

    let mut uid_list: Vec<u32> = uid_set.into_iter().collect();
    uid_list.sort_unstable();
    // `UID N:*` returns the highest-UID message even when N is past it, so drop
    // anything at or below the cursor before counting.
    uid_list.retain(|u| *u > last_uid);
    if uid_list.is_empty() {
        let _ = session.logout();
        return Ok((results, max_uid));
    }

    // THE STALENESS CLAMP, measured in MESSAGES rather than UID distance.
    //
    // A cursor can fall behind legitimately (a laptop closed for a fortnight) or
    // pathologically (a mailbox configured but silently unread for months). Only the
    // second should be abandoned. Distance in UID-space cannot tell them apart: on
    // Gmail the INBOX UID counter advances for every message that ever carried the
    // label, including everything a filter auto-archived, so an inbox-zero user can
    // be thousands of UIDs behind with a nearly empty INBOX. Clamping on that
    // distance threw away real, wanted mail.
    //
    // When it does fire we keep the NEWEST MAX_CATCHUP messages rather than jumping
    // to the head and processing none - the recent mail is the part worth having.
    if !allow_backfill && uid_list.len() > MAX_CATCHUP {
        let dropped = uid_list.len() - MAX_CATCHUP;
        tracing::warn!(
            "inbox {} has {} messages since uid {}; importing only the newest {} and skipping {}",
            user, uid_list.len(), last_uid, MAX_CATCHUP, dropped
        );
        uid_list.drain(..dropped);
    }

    // Fetch in chunks. A comma-joined set over a whole mailbox builds an IMAP
    // command line hundreds of kilobytes long (past what Gmail accepts) and
    // materialises every full message body in memory at once; chunking bounds both.
    // A chunk failure commits the completed PREFIX rather than discarding the pass.
    // Chunks ascend and each is all-or-nothing, so every uid at or below `max_uid`
    // has been parsed into `results`; returning them advances the cursor to exactly
    // the last fully-processed uid. Without this, a backlog too large to finish in
    // one session re-downloads from the start every pass and never catches up - and
    // since `scan()` is serialised, every other mailbox queues behind the retries.
    const FETCH_CHUNK: usize = 200;

    for chunk in uid_list.chunks(FETCH_CHUNK) {
    let fetch_set = chunk.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");

    let messages = match session.uid_fetch(&fetch_set, "RFC822") {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                "inbox {} fetch failed after uid {}; keeping what was read and resuming there: {}",
                user, max_uid, e
            );
            break;
        }
    };

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
    } // end fetch chunk

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
    auth: ImapAuth,
    timeout: std::time::Duration,
) -> Result<bool> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let (mut session, socket) = imap_session_with_socket(&imap_host, imap_port, &user, &auth)?;
    session.select(SCAN_FOLDER).context("select inbox")?;

    // Watchdog. `wait_with_timeout` arms its own deadline for the wait itself, but
    // clears the socket's read timeout to None afterwards instead of restoring ours -
    // and the Handle's Drop (which writes DONE and reads the ack) runs inside that
    // same call, unprotected. Rather than trying to re-arm a timeout we never get a
    // chance to set, bound the whole cycle from outside: if it overruns, shut the
    // socket down, which makes any blocked read return immediately.
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let watchdog = {
        let done = done.clone();
        let socket = socket.try_clone().context("clone IMAP socket for watchdog")?;
        let limit = timeout + std::time::Duration::from_secs(60);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + limit;
            while std::time::Instant::now() < deadline {
                if done.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if !done.load(Ordering::Relaxed) {
                tracing::warn!("IDLE on {} overran; closing the socket to unblock it", user);
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        })
    };

    // Immediately-invoked so the Handle's Drop (the DONE handshake) runs inside the
    // watchdog window, AND so an early failure cannot skip the teardown below - a `?`
    // here would return past the join and leave the watchdog to shut down a socket
    // nobody is waiting on any more.
    let outcome = (|| -> Result<imap::extensions::idle::WaitOutcome> {
        let idle = session.idle().context("start IDLE")?;
        idle.wait_with_timeout(timeout).context("IDLE wait")
    })();
    let _ = session.logout();
    done.store(true, Ordering::Relaxed);
    let _ = watchdog.join();

    // A MailboxChanged means new/changed mail; we then run the normal scan, which
    // fetches only genuinely-new UIDs.
    let changed = matches!(outcome?, imap::extensions::idle::WaitOutcome::MailboxChanged);
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
    auth: ImapAuth,
    uid: u32,
) -> Result<()> {
    let mut session = imap_session(&imap_host, imap_port, &user, &auth)?;
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
fn test_imap_blocking(imap_host: String, imap_port: u16, user: String, auth: ImapAuth) -> Result<()> {
    let mut session = imap_session(&imap_host, imap_port, &user, &auth)?;
    session.select(SCAN_FOLDER).context("select inbox")?;
    let _ = session.logout();
    Ok(())
}

/// Resolve an inbox id to its IMAP connection details + password. `"legacy"` uses
/// the account in EmailSettings (password or OAuth token); other ids use the
/// stored `imap_pass_{id}` credential. Also returns the inbox label (its `source`).
async fn resolve_inbox_creds(id: &str) -> Result<(String, u16, String, ImapAuth, String)> {
    if id == "legacy" {
        let s = load_settings().context("no email account configured")?;
        if s.imap_host.is_empty() {
            return Err(anyhow!("no IMAP host configured"));
        }
        let auth = legacy_auth(&s).await?;
        Ok((s.imap_host, s.imap_port, s.user.clone(), auth, s.user))
    } else {
        let ib = load_inboxes()
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| anyhow!("inbox not found"))?;
        let auth = inbox_auth(&ib).await?;
        Ok((ib.host, ib.port, ib.user, auth, ib.label))
    }
}

/// Resolve an inbox by its LABEL (what we stamp on captured clients as `src_inbox`,
/// i.e. `ParsedEmail.source`). Falls back to the legacy account when the label
/// matches its user. Returns the same tuple as `resolve_inbox_creds`.
async fn resolve_inbox_creds_by_label(label: &str) -> Result<(String, u16, String, ImapAuth, String)> {
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
    let (host, port, user, auth, _label) = resolve_inbox_creds_by_label(inbox_label).await?;
    tokio::task::spawn_blocking(move || archive_uid_blocking(host, port, user, auth, uid))
        .await
        .context("imap archive task")?
}

/// Prove a mailbox's Google grant works by opening it with an OAuth token, without
/// depending on the inbox's stored `auth_method`. Called immediately after consent
/// so a bad or wrong-account grant is caught BEFORE the app password is discarded.
pub async fn verify_inbox_oauth(inbox_id: &str) -> Result<()> {
    let ib = load_inboxes()
        .into_iter()
        .find(|i| i.id == inbox_id)
        .ok_or_else(|| anyhow!("inbox not found"))?;
    let auth = ImapAuth::OAuth2(inbox_access_token(inbox_id).await?);
    let (host, port, user) = (ib.host.clone(), ib.port, ib.user.clone());
    tokio::task::spawn_blocking(move || test_imap_blocking(host, port, user, auth))
        .await
        .context("imap verify task")?
}

/// Test one configured inbox by id (matches `EmailInbox.id`; `"legacy"` uses the
/// account in EmailSettings). Reuses the stored credential (`imap_pass_{id}`, or
/// the legacy account's password/OAuth token). Ok(()) means the connection + auth
/// succeeded.
pub async fn test_inbox(id: &str) -> Result<()> {
    let (host, port, user, auth, _label) = resolve_inbox_creds(id).await?;
    tokio::task::spawn_blocking(move || test_imap_blocking(host, port, user, auth))
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
    let (host, port, user, auth, label) = resolve_inbox_creds(inbox_id).await?;
    let res = tokio::task::spawn_blocking(move || {
        fetch_latest_matching_blocking(host, port, user, auth, sender_pattern, subject_pattern)
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
    auth: ImapAuth,
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

    let mut session = imap_session(&imap_host, imap_port, &user, &auth)?;
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

/// Serialises `scan()`. The read-fetch-write of a UID cursor is not atomic - it
/// yields at the `spawn_blocking` await - so two concurrent scans interleave and
/// import the same messages twice. Every watcher plus the periodic safety sweep can
/// all call `scan()` at once, so this lock is what makes the cursor authoritative.
static SCAN_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn scan_lock() -> &'static tokio::sync::Mutex<()> {
    SCAN_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub async fn scan() -> Result<Vec<ParsedEmail>> {
    let _serialised = scan_lock().lock().await;
    // On a fresh admin's device the org config syncs down but the keyring is
    // empty. If a password-auth org secret (send/monitor account, or any org
    // monitor inbox) is missing locally, pull it once from the server org store
    // into the keyring so the shared inbox works without re-typing. Best-effort.
    //
    // Only do this while USING the org default — an admin on a personal override
    // manages their own keyring, and we must not overwrite their `imap_pass` with
    // the org account's secret. (Per-inbox org secrets are always safe to fetch:
    // they're keyed by the shared inbox's own id.)
    let legacy_pw_missing = use_org_default() && load_org_settings().is_some_and(|s| {
        matches!(s.auth_method, AuthMethod::Password)
            && !s.imap_host.is_empty()
            && cred_opt("imap_pass").filter(|p| !p.is_empty()).is_none()
    });
    // Google-linked mailboxes have no password by design. Counting them as "missing"
    // pulls the org secret bundle down again and restores the very app password that
    // signing in with Google just deleted, silently putting the mailbox back on
    // password auth.
    let org_inbox_pw_missing = load_org_inboxes()
        .iter()
        .filter(|ib| ib.auth_method == AuthMethod::Password)
        .any(|ib| cred_opt(&format!("imap_pass_{}", ib.id)).filter(|p| !p.is_empty()).is_none());
    if legacy_pw_missing || org_inbox_pw_missing {
        let _ = crate::netsync::materialize_email_secrets_from_server().await;
    }

    // Inbound mailboxes to monitor: every added inbox, PLUS the legacy account in
    // EmailSettings whenever it has an IMAP host.
    //
    // This used to add the legacy account only `if inboxes.is_empty()`, while
    // `watchable_inboxes()` added it unconditionally. The result was a mailbox whose
    // IDLE watcher connected and woke on new mail, but whose messages were never
    // fetched: configured, apparently healthy, and silently unread the moment any
    // other inbox existed. The two lists must agree.
    let mut inboxes = distinct_watchable();

    let mut all = Vec::new();
    for ib in inboxes {
        // Each mailbox authenticates on its own terms: the legacy account from
        // EmailSettings, an added inbox from its own auth_method (app password, or
        // a refresh token its own owner granted).
        // A credential that cannot be resolved is now the MOST likely failure, not a
        // rare one: an org inbox linked to Google carries `auth_method = oauth2` to
        // every device through the shared settings blob, but the refresh token stays
        // in the linking device's keyring. Every other device lands here. Skipping is
        // correct; skipping SILENTLY is how a mailbox stays unread without anyone
        // noticing, so say so.
        let auth = if ib.id == "legacy" {
            match load_settings() {
                Ok(s) => match legacy_auth(&s).await {
                    Ok(a) => a,
                    Err(e) => {
                        tracing::warn!("legacy inbox ({}) has no usable credential: {}", ib.user, e);
                        continue;
                    }
                },
                Err(e) => {
                    tracing::warn!("legacy inbox not configured: {}", e);
                    continue;
                }
            }
        } else {
            match inbox_auth(&ib).await {
                Ok(a) => a,
                Err(e) => {
                    tracing::warn!("inbox {} ({}) has no usable credential: {}", ib.id, ib.user, e);
                    continue;
                }
            }
        };
        let uid_key = if ib.id == "legacy" { "last_seen_uid".to_string() } else { format!("last_seen_uid_{}", ib.id) };
        let mut last_uid = uid_for(&uid_key);

        // THE BACKFILL GUARD, enforced here rather than trusted from the add path.
        //
        // An unseeded mailbox makes `scan_blocking` search `UID 1:*` and fetch its
        // entire contents. Seeding when a mailbox is ADDED is not enough: the seed can
        // fail (offline, or a mailbox added with no credential yet so it can be linked
        // to Google next), and a best-effort guard that fails open re-arms exactly the
        // hazard it exists to prevent. So the last word belongs to the reader - an
        // unseeded mailbox is seeded here, and simply not read this pass if it cannot
        // be.
        //
        // This applies to the LEGACY account too. It was briefly exempted on the
        // reasoning that a first-run account importing into an empty client list is
        // harmless - which is wrong: `settings` and `clients` sync between devices but
        // `device_state` does not, so a reinstall or a second admin's machine has the
        // full client list AND a zero cursor.
        //
        // `read_from_now = false` records an explicit marker, so a deliberate history
        // import still works.
        if !seeded(&ib.id) && !backfill_allowed(&ib.id) {
            match seed_uid_cursor(&ib.id).await {
                Ok(max) => {
                    tracing::info!("inbox {} seeded at uid {}; reading from here on", ib.id, max);
                    last_uid = max;
                }
                Err(e) => {
                    tracing::warn!("inbox {} not seeded yet ({}); skipping until it is", ib.id, e);
                    continue;
                }
            }
        }
        let (host, port, user, label) = (ib.host.clone(), ib.port, ib.user.clone(), ib.label.clone());
        let allow_backfill = backfill_allowed(&ib.id);
        let res = tokio::task::spawn_blocking(move || {
            scan_blocking(host, port, user, auth, last_uid, allow_backfill)
        })
        .await;
        match res {
            Ok(Ok((mut emails, max_uid))) => {
                for e in &mut emails { e.source = label.clone(); }
                if max_uid > last_uid { set_uid_for(&uid_key, max_uid); }
                // Consume the one-shot history-import consent. Leaving it set turned a
                // single deliberate import into a permanent exemption from the clamp,
                // so a later stranded cursor on the same mailbox would refetch
                // everything unbounded.
                if allow_backfill {
                    set_uid_for(&format!("inbox_backfill_ok_{}", ib.id), 0);
                }
                all.append(&mut emails);
            }
            // A single bad inbox must not abort the others - but it must not vanish
            // either. A silently-swallowed scan error is indistinguishable from an
            // empty mailbox, which is exactly how a configured account stayed unread
            // for seven weeks without anyone noticing. The cursor is left untouched,
            // so the same range is retried next pass.
            Ok(Err(e)) => tracing::warn!("inbox {} ({}) scan failed: {}", ib.id, ib.user, e),
            Err(join) => tracing::warn!("inbox {} ({}) scan task failed: {}", ib.id, ib.user, join),
        }
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
///
/// Re-checks each lead's CURRENT state at notify time: a lead captured here, synced
/// to the server, and already approved/rejected on another device (mobile) — with
/// the resolution pulled back before we announce — must stay silent. Only announce
/// when the client is still `pending` AND its approval-queue row is still open.
fn notify_new_leads(app: &tauri::AppHandle, leads: &[NewLead]) {
    use tauri_plugin_notification::NotificationExt;
    for lead in leads {
        if !still_pending_lead(&lead.client_id) {
            tracing::info!("skipped stale new-lead notification for {} (already resolved)", lead.name);
            continue;
        }
        let _ = app
            .notification()
            .builder()
            .title("New lead")
            .body(format!("New lead: {}", lead.name))
            .show();
        tracing::info!("notified new lead {} ({})", lead.name, &lead.client_id[..8.min(lead.client_id.len())]);
    }
}

/// Whether a captured lead is STILL awaiting review right now: the client row is
/// `approval_status='pending'` AND it has an open (`status='pending'`) approval-queue
/// row. False once it's been approved/rejected on any device (and synced back).
fn still_pending_lead(client_id: &str) -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return false };
    let client_pending = conn
        .query_row(
            "SELECT 1 FROM clients WHERE id=?1 AND approval_status='pending'",
            [client_id],
            |_| Ok(()),
        )
        .is_ok();
    if !client_pending {
        return false;
    }
    conn.query_row(
        "SELECT 1 FROM pending_approvals WHERE entity_id=?1 AND kind='client_add' AND status='pending' LIMIT 1",
        [client_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// Resolve the connection details + password for one inbox id, synchronously where
/// possible. The legacy account may use OAuth (needs an async token refresh), so
/// this is async. Returns None when the inbox has no usable credential.
async fn inbox_conn(ib: &EmailInbox) -> Option<(String, u16, String, ImapAuth)> {
    let auth = if ib.id == "legacy" {
        legacy_auth(&load_settings().ok()?).await.ok()?
    } else {
        inbox_auth(ib).await.ok()?
    };
    Some((ib.host.clone(), ib.port, ib.user.clone(), auth))
}

/// Enumerate the mailboxes to watch: every added inbox, plus the legacy account
/// (from EmailSettings) when it has an IMAP host — mirrors `scan()`. Demo/placeholder
/// inboxes (real accounts used for sales demos) are excluded — they exist only to
/// satisfy the "inbox linked" display and are never actually dialed.
fn watchable_inboxes() -> Vec<EmailInbox> {
    let mut inboxes: Vec<EmailInbox> = load_inboxes().into_iter().filter(|ib| !ib.demo).collect();
    if let Ok(s) = load_settings() {
        if !s.imap_host.is_empty() {
            inboxes.push(EmailInbox {
                id: "legacy".into(),
                label: s.user.clone(),
                host: s.imap_host,
                port: s.imap_port,
                user: s.user,
                scope: "org".into(),
                demo: false,
                auth_method: s.auth_method,
            });
        }
    }
    inboxes
}

/// `watchable_inboxes()` deduped by (host, user).
///
/// The same mailbox can be reachable both as the legacy account and as an added
/// inbox row. Scanning it twice double-logs every message; watching it twice keeps
/// a second IDLE connection open whose row's cursor never advances. Added rows win
/// - they carry their own credential and their own cursor.
pub fn distinct_watchable() -> Vec<EmailInbox> {
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut out = watchable_inboxes();
    out.retain(|ib| seen.insert((ib.host.to_lowercase(), ib.user.to_lowercase())));
    out
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
            let ib = match distinct_watchable().into_iter().find(|i| i.id == inbox_id) {
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
                for ib in distinct_watchable() {
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

/// One-time migration: promote any pre-existing device-local email config
/// (`email_settings` / `email_inboxes`) into the sync log so existing single-admin
/// setups become the ORG-shared default that all admins inherit — WITHOUT the user
/// re-saving. Before this change these keys were written raw and never synced, so
/// each admin/device configured email from scratch; this backfills them once.
///
/// Only the config JSON is synced (never the keyring secrets) — sibling admins
/// materialize the passwords via the server round-trip in `scan()`. Guarded by a
/// settings flag so it runs at most once. Safe on every startup.
pub fn migrate_email_config_to_org_once() {
    let conn = match crate::db::pool().get() { Ok(c) => c, Err(_) => return };
    let done = conn
        .query_row("SELECT value FROM settings WHERE key='email_org_migrate_v1_done'", [], |r| r.get::<_, String>(0))
        .map(|v| v == "1")
        .unwrap_or(false);
    if done {
        return;
    }
    // Read the existing org-key rows straight from the local table.
    let read = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0)).ok()
    };
    let settings_json = read(K_ORG_SETTINGS);
    let inboxes_json = read(K_ORG_INBOXES);
    // Mark done first so a mid-run interruption can't loop.
    let _ = conn.execute(
        "INSERT INTO settings (key,value) VALUES ('email_org_migrate_v1_done','1') ON CONFLICT(key) DO UPDATE SET value='1'",
        [],
    );
    drop(conn);
    // Emit sync upserts for whatever config already exists locally. record_upsert
    // is a no-op-safe idempotent LWW write; if this row already synced it just
    // re-affirms it.
    if let Some(json) = settings_json {
        let mut cols = serde_json::Map::new();
        cols.insert("value".into(), serde_json::Value::String(json));
        let _ = crate::sync::record_upsert("settings", K_ORG_SETTINGS, cols);
    }
    if let Some(json) = inboxes_json {
        let mut cols = serde_json::Map::new();
        cols.insert("value".into(), serde_json::Value::String(json));
        let _ = crate::sync::record_upsert("settings", K_ORG_INBOXES, cols);
    }
    // Best-effort: push existing keyring secrets to the server so other admins can
    // materialize them. Fire-and-forget on a background task (needs the async
    // netsync client); no-ops when offline / not signed in.
    tauri::async_runtime::spawn(async {
        let _ = crate::netsync::push_email_secrets_to_server().await;
    });
    tracing::info!("email config org-migration: promoted local email settings/inboxes to org-shared");
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
            // The message's OWN date, not the moment we happened to read it. A mailbox
            // read late (a laptop closed for a week, a mailbox linked long after it
            // started receiving) must produce history that is true, not a block of
            // activity dated today. `last_contact_at` counts email_in/email_out, so
            // using `now` here silently rewrote the real last-contact date on every
            // client an imported message matched, on every synced device.
            let now = email
                .date
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
                .map(|d| d.with_timezone(&Utc).to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());

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
                // Cap concurrency: this runs a local LLM generation, and a batch
                // import would otherwise start one per message simultaneously.
                static AI_SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
                let sem = AI_SLOTS.get_or_init(|| tokio::sync::Semaphore::new(2));
                let _permit = match sem.acquire().await { Ok(p) => p, Err(_) => return };
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
        // Capture the subject alongside the id so a reply (e.g. a quote sent into this
        // thread) can use a matching "Re: …" subject for reliable conversation grouping.
        conn.execute(
            "UPDATE clients SET metadata = json_set(COALESCE(metadata,'{}'), \
                '$.src_inbox', ?2, '$.src_uid', ?3, '$.src_message_id', ?4, '$.src_subject', ?5) WHERE id=?1",
            rusqlite::params![client_id, email.source, email.uid as i64, mid, email.subject],
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
