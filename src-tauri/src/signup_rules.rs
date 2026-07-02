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
    /// Which inbox this rule watches. Empty = all inboxes. When set, it must equal
    /// the scanned email's `source` (the inbox label) for the rule to match.
    #[serde(default)]
    pub inbox_source: String,
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
    // Bind a rule to one inbox (by its label). Idempotent for existing DBs; the
    // duplicate-column error is benign and ignored.
    let _ = conn.execute("ALTER TABLE signup_rules ADD COLUMN inbox_source TEXT NOT NULL DEFAULT ''", []);
    Ok(())
}

pub fn list_rules() -> Result<Vec<SignupRule>> {
    let conn = pool().get()?;
    let mut stmt = conn.prepare(
        "SELECT id,name,sender_pattern,subject_pattern,active,created_at,COALESCE(inbox_source,'')
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
            inbox_source: r.get(6)?,
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
    /// Inbox label this rule is bound to. Empty/omitted = all inboxes.
    #[serde(default)]
    pub inbox_source: Option<String>,
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
    let inbox_source = input.inbox_source.clone().unwrap_or_default();
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO signup_rules (id,name,sender_pattern,subject_pattern,active,created_at,inbox_source)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            id,
            input.name,
            input.sender_pattern,
            input.subject_pattern,
            input.active as i64,
            now,
            inbox_source
        ],
    )?;
    Ok(id)
}

/// Update an existing rule in place (name, patterns, active, inbox binding).
pub fn update_rule(id: &str, input: RuleInput) -> Result<()> {
    if let Some(p) = &input.sender_pattern {
        Regex::new(p).context("invalid sender pattern")?;
    }
    if let Some(p) = &input.subject_pattern {
        Regex::new(p).context("invalid subject pattern")?;
    }
    let inbox_source = input.inbox_source.clone().unwrap_or_default();
    let conn = pool().get()?;
    conn.execute(
        "UPDATE signup_rules
         SET name=?1, sender_pattern=?2, subject_pattern=?3, active=?4, inbox_source=?5
         WHERE id=?6",
        rusqlite::params![
            input.name,
            input.sender_pattern,
            input.subject_pattern,
            input.active as i64,
            inbox_source,
            id
        ],
    )?;
    Ok(())
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

/// A matched signup rule, plus whether it was matched purely on its inbox binding
/// (no sender/subject pattern). `patternless` gates the safety rule in
/// `auto_create_client`: an inbox-only rule only creates from a real parsed form.
#[derive(Debug, Clone)]
pub struct RuleMatch {
    pub name: String,
    /// True when the rule had NO sender AND NO subject pattern (inbox-only).
    pub patternless: bool,
}

/// Whether a rule's `inbox_source` binding matches the email's `source` (inbox
/// label). Tolerant of the v0.14.81 bug where the UI saved the inbox ID instead of
/// the label: matches when the binding equals the source (label) OR equals the ID
/// of the inbox whose label == source. Empty binding = any inbox.
fn inbox_binding_ok(inbox_source: &str, source: &str) -> bool {
    if inbox_source.is_empty() {
        return true; // not bound → any inbox
    }
    if inbox_source == source {
        return true; // saved the label (correct)
    }
    // Saved the ID: resolve the inbox whose label == source and compare its id.
    crate::email::load_inboxes()
        .iter()
        .any(|ib| ib.label == source && ib.id == inbox_source)
}

/// Test whether an email matches any active rule. `source` is the inbox label the
/// email came from (`ParsedEmail.source`). A rule bound to a specific inbox only
/// matches mail from that inbox; an inbox-bound rule with no sender/subject pattern
/// matches on the binding alone (the inbox IS the filter). Returns the matched
/// rule (name + whether it was patternless) if any.
pub fn matches_any(from: &str, subject: &str, source: &str) -> Result<Option<RuleMatch>> {
    for rule in list_rules()?.iter().filter(|r| r.active) {
        // Inbox binding: empty = any inbox; else tolerant label/ID compare.
        if !inbox_binding_ok(&rule.inbox_source, source) {
            continue;
        }
        let sender_ok = match &rule.sender_pattern {
            Some(p) if !p.is_empty() => Regex::new(p).map(|re| re.is_match(from)).unwrap_or(false),
            _ => true,
        };
        let subject_ok = match &rule.subject_pattern {
            Some(p) if !p.is_empty() => Regex::new(p).map(|re| re.is_match(subject)).unwrap_or(false),
            _ => true,
        };
        let has_pattern = rule.sender_pattern.as_deref().map(|p| !p.is_empty()).unwrap_or(false)
            || rule.subject_pattern.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
        let is_inbox_bound = !rule.inbox_source.is_empty();
        // Match when: any specified patterns match AND (there's at least one pattern
        // OR the rule is inbox-bound). A rule with NO pattern and NO inbox binding is
        // still ignored (it would match everything).
        if sender_ok && subject_ok && (has_pattern || is_inbox_bound) {
            return Ok(Some(RuleMatch { name: rule.name.clone(), patternless: !has_pattern }));
        }
    }
    Ok(None)
}

/// Called from email::process_new_emails when a rule matches. Tries the
/// deterministic form-email parser first (Shopify-style `Label:\n<value>`); only
/// falls back to AI extraction when the body has no recognizable label structure.
/// Creates a PENDING client (awaiting approval), logs the email as the first
/// interaction, and dedups by email.
/// `patternless` = the matched rule had no sender/subject pattern (inbox-only). In
/// that case we ONLY create from a real parsed form and never AI-create arbitrary
/// mail — returns `Ok(None)` when the email isn't a recognizable form. When the
/// rule specified patterns, the AI fallback is kept for freeform emails.
pub async fn auto_create_client(email: &crate::email::ParsedEmail, patternless: bool) -> Result<Option<String>> {
    // 1. Deterministic path (preferred): structured contact-form email.
    if let Some(customer) = crate::form_parser::parse_form_email(&email.body_text) {
        return Ok(Some(create_client_from_customer(&customer, email)?));
    }

    // Safety: an inbox-only rule (no patterns) must not turn every email into a
    // client. Without a real parsed form, skip — no AI create.
    if patternless {
        return Ok(None);
    }

    // 2. Fallback: AI extraction for freeform emails (only when the rule had patterns).
    let extracted = crate::ai::extract_structured(&email.body_text)
        .await
        .context("AI extraction failed")?;

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
        .unwrap_or_else(|| email.from.clone());

    let services = extracted
        .get("requested_services")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let notes = if services.is_empty() {
        format!("Auto-imported from signup email on {}", Utc::now().format("%Y-%m-%d"))
    } else {
        format!("Requested: {}", services)
    };

    let mut customer = crate::form_parser::ExtractedCustomer::default();
    customer.name = client_name;
    customer.email = client_email;
    Ok(Some(create_client_from_customer_with_notes(&customer, email, &notes)?))
}

/// Create a PENDING client from a parsed customer (default notes).
fn create_client_from_customer(
    customer: &crate::form_parser::ExtractedCustomer,
    email: &crate::email::ParsedEmail,
) -> Result<String> {
    let notes = format!("Auto-imported from web form on {}", Utc::now().format("%Y-%m-%d"));
    create_client_from_customer_with_notes(customer, email, &notes)
}

/// Shared client-creation path used by both the deterministic and AI branches.
/// Address / title / tax_id / categories / extra all land in `metadata`. Dedups
/// by email (logs the interaction on the existing client and returns its id).
fn create_client_from_customer_with_notes(
    customer: &crate::form_parser::ExtractedCustomer,
    email: &crate::email::ParsedEmail,
    notes: &str,
) -> Result<String> {
    // Resolve display name + email with fallbacks to the sending address.
    let name = if !customer.name.trim().is_empty() {
        customer.name.trim().to_string()
    } else {
        let fl = format!("{} {}", customer.first_name, customer.last_name);
        if !fl.trim().is_empty() {
            fl.trim().to_string()
        } else {
            email.from_name.clone().unwrap_or_else(|| {
                email.from.split('@').next().unwrap_or("New Client").to_string()
            })
        }
    };
    let client_email = if !customer.email.trim().is_empty() {
        customer.email.trim().to_string()
    } else {
        email.from.clone()
    };

    // Dedup against EXISTING clients (ANY approval_status) → just log the contact as
    // an interaction on that client and return its id. No new pending client, no
    // approval-queue row, no notification (the caller only notifies when a genuinely
    // new PENDING client is created). Match on trimmed+lowercased email; when there's
    // no email at all, fall back to an exact trimmed (case-insensitive) name match so
    // repeat no-email submissions from the same person don't create duplicates.
    let conn = pool().get()?;
    let existing: Option<String> = if !client_email.trim().is_empty() {
        conn.query_row(
            "SELECT id FROM clients WHERE LOWER(TRIM(email))=LOWER(TRIM(?1)) LIMIT 1",
            [&client_email],
            |r| r.get(0),
        ).ok()
    } else if !name.trim().is_empty() {
        conn.query_row(
            "SELECT id FROM clients WHERE LOWER(TRIM(name))=LOWER(TRIM(?1)) LIMIT 1",
            [&name],
            |r| r.get(0),
        ).ok()
    } else {
        None
    };
    if let Some(existing_id) = existing {
        log_signup_interaction(&existing_id, email)?;
        return Ok(existing_id);
    }

    // Build metadata: address parts, title, tax_id, categories, extra, source.
    let mut meta = serde_json::Map::new();
    let mut put = |k: &str, v: &str| {
        if !v.trim().is_empty() {
            meta.insert(k.to_string(), serde_json::Value::String(v.trim().to_string()));
        }
    };
    put("street_address", &customer.address);
    put("city", &customer.city);
    put("state", &customer.state);
    put("zip_code", &customer.zip);
    put("country", &customer.country);
    put("title", &customer.title);
    put("tax_id", &customer.tax_id);
    put("first_name", &customer.first_name);
    put("last_name", &customer.last_name);
    // Sales rep: default to the company name when blank (mirrors the parser, but
    // also covers the AI-fallback path which doesn't run the parser). Written to
    // both `sales_rep` (the capture field) and `lead_representative` (what the
    // client profile reads for "Rep").
    let sales_rep = if !customer.sales_rep.trim().is_empty() {
        customer.sales_rep.trim().to_string()
    } else {
        customer.company.trim().to_string()
    };
    if !sales_rep.is_empty() {
        meta.insert("sales_rep".into(), serde_json::Value::String(sales_rep.clone()));
        meta.insert("lead_representative".into(), serde_json::Value::String(sales_rep.clone()));
    }
    if !customer.categories.is_empty() {
        meta.insert(
            "categories".into(),
            serde_json::Value::Array(
                customer.categories.iter().map(|c| serde_json::Value::String(c.clone())).collect(),
            ),
        );
    }
    for (k, v) in &customer.extra {
        // Prefix custom form fields so they don't collide with known metadata keys.
        meta.insert(format!("cf:{k}"), serde_json::Value::String(v.clone()));
    }
    meta.insert("source".into(), serde_json::Value::String("web_form".into()));
    let metadata_str = serde_json::to_string(&serde_json::Value::Object(meta)).unwrap_or_else(|_| "{}".into());

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let company = customer.company.trim().to_string();
    let phone = customer.phone.trim().to_string();

    let mut cols = serde_json::Map::new();
    cols.insert("name".into(), serde_json::Value::String(name.clone()));
    cols.insert("email".into(), serde_json::Value::String(client_email.clone()));
    cols.insert("phone".into(), serde_json::Value::String(phone.clone()));
    cols.insert("company".into(), serde_json::Value::String(company.clone()));
    cols.insert("notes".into(), serde_json::Value::String(notes.to_string()));
    cols.insert("billing_status".into(), serde_json::Value::String("active".into()));
    cols.insert("lead_status".into(), serde_json::Value::String("prospect".into()));
    cols.insert("approval_status".into(), serde_json::Value::String("pending".into()));
    cols.insert("metadata".into(), serde_json::Value::String(metadata_str.clone()));
    cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
    cols.insert("updated_at".into(), serde_json::Value::String(now.clone()));
    crate::sync::record_upsert("clients", &id, cols)?;

    conn.execute(
        "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,lead_status,created_at,updated_at,metadata,approval_status,is_blacklisted)
         VALUES (?1,?2,?3,?4,?5,?6,'active','prospect',?7,?7,?8,'pending',0)",
        rusqlite::params![id, name, client_email, phone, company, notes, now, metadata_str],
    )?;

    log_signup_interaction(&id, email)?;

    // Add every detected category to the SYSTEM category list (case-insensitive
    // dedup) so they become selectable options everywhere.
    if !customer.categories.is_empty() {
        let added = crate::commands::ensure_system_categories(&customer.categories);
        if added > 0 {
            tracing::info!("form capture added {} new system categories", added);
        }
    }

    // Raise a pending-approval so the captured lead shows in the approvals bell for
    // a human to review (mirrors the intake path). Non-fatal if it can't be queued.
    if let Err(e) = crate::commands::queue_client_approval(
        "client_add",
        &id,
        &format!("New lead via web form: {}", name),
    ) {
        tracing::warn!("queue_client_approval for {}: {}", id, e);
    }

    tracing::info!("auto-created pending client {} from form/signup email", name);
    Ok(id)
}

fn log_signup_interaction(client_id: &str, email: &crate::email::ParsedEmail) -> Result<()> {
    let conn = pool().get()?;
    let interaction_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let mut cols = serde_json::Map::new();
    cols.insert("client_id".into(), serde_json::Value::String(client_id.to_string()));
    cols.insert("kind".into(), serde_json::Value::String("signup".into()));
    cols.insert("subject".into(), serde_json::Value::String(email.subject.clone()));
    cols.insert("body".into(), serde_json::Value::String(email.body_text.clone()));
    cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
    crate::sync::record_upsert("interactions", &interaction_id, cols)
        .context("sync record_upsert signup interaction")?;

    conn.execute(
        "INSERT INTO interactions (id,client_id,kind,subject,body,created_at)
         VALUES (?1,?2,'signup',?3,?4,?5)",
        rusqlite::params![interaction_id, client_id, &email.subject, &email.body_text, now],
    )?;
    Ok(())
}
