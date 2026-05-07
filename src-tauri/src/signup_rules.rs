//! Signup detection: match incoming emails against user-defined rules and
//! auto-create clients via AI extraction.
//!
//! Rules are stored in the `signup_rules` table:
//!   - sender_pattern: regex matched against From: address (e.g. "noreply@typeform\\.com")
//!   - subject_pattern: regex matched against Subject (e.g. "(?i)new.*signup")
//!   - active: bool toggle
//!
//! When `process_new_emails` runs, every email is checked against active rules.
//! On match → ai::extract_structured pulls client fields → create_client + log
//! the original email as the first interaction.

use anyhow::{Context, Result};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::pool;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignupRule {
    pub id: String,
    pub name: String,
    pub sender_pattern: Option<String>,
    pub subject_pattern: Option<String>,
    pub active: bool,
    pub created_at: String,
}

pub fn ensure_table() -> Result<()> {
    let conn = pool().get()?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS signup_rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sender_pattern TEXT,
            subject_pattern TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

pub fn list_rules() -> Result<Vec<SignupRule>> {
    let conn = pool().get()?;
    let mut stmt = conn.prepare(
        "SELECT id,name,sender_pattern,subject_pattern,active,created_at
         FROM signup_rules ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SignupRule {
            id: r.get(0)?,
            name: r.get(1)?,
            sender_pattern: r.get(2)?,
            subject_pattern: r.get(3)?,
            active: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Deserialize)]
pub struct RuleInput {
    pub name: String,
    pub sender_pattern: Option<String>,
    pub subject_pattern: Option<String>,
    pub active: bool,
}

pub fn create_rule(input: RuleInput) -> Result<String> {
    // Validate regexes
    if let Some(p) = &input.sender_pattern {
        Regex::new(p).context("invalid sender pattern")?;
    }
    if let Some(p) = &input.subject_pattern {
        Regex::new(p).context("invalid subject pattern")?;
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO signup_rules (id,name,sender_pattern,subject_pattern,active,created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![
            id,
            input.name,
            input.sender_pattern,
            input.subject_pattern,
            input.active as i64,
            now
        ],
    )?;
    Ok(id)
}

pub fn delete_rule(id: &str) -> Result<()> {
    let conn = pool().get()?;
    conn.execute("DELETE FROM signup_rules WHERE id=?1", [id])?;
    Ok(())
}

pub fn toggle_rule(id: &str, active: bool) -> Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "UPDATE signup_rules SET active=?1 WHERE id=?2",
        rusqlite::params![active as i64, id],
    )?;
    Ok(())
}

/// Test whether an email matches any active rule. Returns the matching rule's name
/// if matched, None otherwise.
pub fn matches_any(from: &str, subject: &str) -> Result<Option<String>> {
    for rule in list_rules()?.iter().filter(|r| r.active) {
        let sender_ok = match &rule.sender_pattern {
            Some(p) => Regex::new(p).map(|re| re.is_match(from)).unwrap_or(false),
            None => true,
        };
        let subject_ok = match &rule.subject_pattern {
            Some(p) => Regex::new(p).map(|re| re.is_match(subject)).unwrap_or(false),
            None => true,
        };
        // At least one pattern must be specified, AND all specified must match.
        let has_any = rule.sender_pattern.is_some() || rule.subject_pattern.is_some();
        if has_any && sender_ok && subject_ok {
            return Ok(Some(rule.name.clone()));
        }
    }
    Ok(None)
}

/// Called from email::process_new_emails when a rule matches.
/// Uses AI extraction to pull client fields, creates the client,
/// and logs the original email as the first interaction.
pub async fn auto_create_client(email: &crate::email::ParsedEmail) -> Result<String> {
    let extracted = crate::ai::extract_structured(&email.body_text)
        .await
        .context("AI extraction failed")?;

    // Pull fields from extraction with sensible fallbacks.
    let client_name = extracted
        .get("client_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            email
                .from_name
                .clone()
                .unwrap_or_else(|| email.from.split('@').next().unwrap_or("New Client").to_string())
        });

    let client_email = extracted
        .get("client_email")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| Some(email.from.clone()));

    // Build a notes blurb from requested_services.
    let services = extracted
        .get("requested_services")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();

    let notes = if services.is_empty() {
        format!("Auto-imported from signup email on {}", Utc::now().format("%Y-%m-%d"))
    } else {
        format!("Requested: {}", services)
    };

    // Dedupe by email
    let conn = pool().get()?;
    if let Some(em) = &client_email {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM clients WHERE LOWER(email)=LOWER(?1)",
                [em],
                |r| r.get(0),
            )
            .ok();
        if let Some(existing_id) = exists {
            // Just log the email as an interaction on the existing client
            log_signup_interaction(&existing_id, email)?;
            return Ok(existing_id);
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let mut cols = serde_json::Map::new();
    cols.insert("name".into(), serde_json::Value::String(client_name.clone()));
    cols.insert(
        "email".into(),
        client_email
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    cols.insert("phone".into(), serde_json::Value::Null);
    cols.insert("company".into(), serde_json::Value::Null);
    cols.insert("notes".into(), serde_json::Value::String(notes.clone()));
    cols.insert("billing_status".into(), serde_json::Value::String("active".into()));
    cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
    cols.insert("updated_at".into(), serde_json::Value::String(now.clone()));

    crate::sync::record_upsert("clients", &id, cols)?;

    conn.execute(
        "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,created_at,updated_at)
         VALUES (?1,?2,?3,NULL,NULL,?4,'active',?5,?5)",
        rusqlite::params![id, client_name, client_email, notes, now],
    )?;

    log_signup_interaction(&id, email)?;
    tracing::info!("auto-created client {} from signup email", client_name);
    Ok(id)
}

fn log_signup_interaction(client_id: &str, email: &crate::email::ParsedEmail) -> Result<()> {
    let conn = pool().get()?;
    let interaction_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO interactions (id,client_id,kind,subject,body,created_at)
         VALUES (?1,?2,'signup',?3,?4,?5)",
        rusqlite::params![interaction_id, client_id, &email.subject, &email.body_text, now],
    )?;
    Ok(())
}
