//! Tauri command handlers. Every write goes through the sync engine
//! so changes propagate to other devices via the event log folder.

use crate::db::pool;
use crate::sync;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

// ============================================================
//  Clients
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub company: Option<String>,
    pub notes: Option<String>,
    pub billing_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Option<Value>,
    pub invoice_count: i64,
}

#[tauri::command]
pub async fn list_clients() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,name,email,phone,company,notes,billing_status,created_at,updated_at,metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=clients.id AND status IN ('sent','paid'))
             FROM clients ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Client {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                notes: r.get(5)?,
                billing_status: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                metadata: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
                invoice_count: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_client(id: String) -> Result<Option<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let res: rusqlite::Result<Client> = conn.query_row(
        "SELECT id,name,email,phone,company,notes,billing_status,created_at,updated_at,metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=clients.id AND status IN ('sent','paid'))
         FROM clients WHERE id=?1",
        [id],
        |r| {
            Ok(Client {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                notes: r.get(5)?,
                billing_status: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                metadata: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
                invoice_count: r.get(10)?,
            })
        },
    );
    match res {
        Ok(c) => Ok(Some(c)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct ClientInput {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub company: Option<String>,
    pub notes: Option<String>,
    pub metadata: Option<Value>,
}

#[tauri::command]
pub async fn create_client(input: ClientInput) -> Result<Client, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let metadata_str = input
        .metadata
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".into());

    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("company".into(), to_value(input.company.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("billing_status".into(), Value::String("active".into()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    cols.insert("metadata".into(), Value::String(metadata_str.clone()));

    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    write_client_row(&id, &input, &now, &now, "active", &metadata_str).map_err(|e| e.to_string())?;

    Ok(Client {
        id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        notes: input.notes,
        billing_status: "active".into(),
        created_at: now.clone(),
        updated_at: now,
        metadata: input.metadata,
        invoice_count: 0,
    })
}

fn write_client_row(
    id: &str,
    input: &ClientInput,
    created_at: &str,
    updated_at: &str,
    status: &str,
    metadata: &str,
) -> anyhow::Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,created_at,updated_at,metadata)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, email=excluded.email, phone=excluded.phone,
            company=excluded.company, notes=excluded.notes,
            billing_status=excluded.billing_status, updated_at=excluded.updated_at,
            metadata=excluded.metadata",
        rusqlite::params![
            id, input.name, input.email, input.phone, input.company,
            input.notes, status, created_at, updated_at, metadata
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn update_client(id: String, input: ClientInput) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let metadata_str = input
        .metadata
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "{}".into());

    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("company".into(), to_value(input.company.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    cols.insert("metadata".into(), Value::String(metadata_str.clone()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clients SET name=?1,email=?2,phone=?3,company=?4,notes=?5,updated_at=?6,metadata=?7 WHERE id=?8",
        rusqlite::params![input.name, input.email, input.phone, input.company, input.notes, now, metadata_str, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_client(id: String) -> Result<(), String> {
    sync::record_delete("clients", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clients WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn search_clients(query: String) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pattern = format!("%{}%", query.to_lowercase());
    let mut stmt = conn
        .prepare(
            "SELECT id,name,email,phone,company,notes,billing_status,created_at,updated_at,metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=clients.id AND status IN ('sent','paid'))
             FROM clients
             WHERE LOWER(name) LIKE ?1 OR LOWER(email) LIKE ?1 OR LOWER(company) LIKE ?1
                OR LOWER(metadata) LIKE ?1
             ORDER BY name LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([pattern], |r| {
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                created_at: r.get(7)?, updated_at: r.get(8)?,
                metadata: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
                invoice_count: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ============================================================
//  Interactions
// ============================================================

#[derive(Serialize, Deserialize, Debug)]
pub struct Interaction {
    pub id: String,
    pub client_id: String,
    pub kind: String,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_interactions(client_id: String) -> Result<Vec<Interaction>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,client_id,kind,subject,body,created_at
             FROM interactions WHERE client_id=?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([client_id], |r| {
            Ok(Interaction {
                id: r.get(0)?, client_id: r.get(1)?, kind: r.get(2)?,
                subject: r.get(3)?, body: r.get(4)?, created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct InteractionInput {
    pub client_id: String,
    pub kind: String,
    pub subject: Option<String>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn add_interaction(input: InteractionInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("kind".into(), Value::String(input.kind.clone()));
    cols.insert("subject".into(), to_value(input.subject.clone()));
    cols.insert("body".into(), to_value(input.body.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    sync::record_upsert("interactions", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO interactions (id,client_id,kind,subject,body,created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![id, input.client_id, input.kind, input.subject, input.body, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

// ============================================================
//  Invoices
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Invoice {
    pub id: String,
    pub client_id: String,
    pub number: String,
    pub issue_date: String,
    pub due_date: String,
    pub line_items_json: String,
    pub subtotal: f64,
    pub tax: f64,
    pub total: f64,
    pub status: String,
    pub pdf_path: Option<String>,
    pub sent_at: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn list_invoices() -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes
             FROM invoices ORDER BY issue_date DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Invoice {
                id: r.get(0)?, client_id: r.get(1)?, number: r.get(2)?,
                issue_date: r.get(3)?, due_date: r.get(4)?, line_items_json: r.get(5)?,
                subtotal: r.get(6)?, tax: r.get(7)?, total: r.get(8)?, status: r.get(9)?,
                pdf_path: r.get(10)?, sent_at: r.get(11)?, notes: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct InvoiceInput {
    pub client_id: String,
    pub due_date: String,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub tax_rate: f64,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn create_invoice(input: InvoiceInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let number = generate_invoice_number().map_err(|e| e.to_string())?;
    let issue = now.to_rfc3339();
    let line_items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();

    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("number".into(), Value::String(number.clone()));
    cols.insert("issue_date".into(), Value::String(issue.clone()));
    cols.insert("due_date".into(), Value::String(input.due_date.clone()));
    cols.insert("line_items_json".into(), Value::String(line_items_json.clone()));
    cols.insert("subtotal".into(), json!(subtotal));
    cols.insert("tax".into(), json!(tax));
    cols.insert("total".into(), json!(total));
    cols.insert("status".into(), Value::String("draft".into()));
    cols.insert("notes".into(), Value::String(notes.clone()));
    cols.insert("created_at".into(), Value::String(issue.clone()));
    sync::record_upsert("invoices", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,notes,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?4)",
        rusqlite::params![id, input.client_id, number, issue, input.due_date, line_items_json, subtotal, tax, total, notes],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}
fn generate_invoice_number() -> anyhow::Result<String> {
    // Atomic counter per year. Stored in settings table.
    let year = Utc::now().format("%Y").to_string();
    let key = format!("invoice_seq_{}", year);
    let conn = pool().get()?;
    let current: u32 = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let next = current + 1;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES (?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, next.to_string()],
    )?;
    Ok(format!("INV-{}-{:04}", year, next))
}

#[derive(Deserialize)]
pub struct UpdateInvoiceInput {
    pub due_date: String,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub tax_rate: f64,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn update_invoice(id: String, input: UpdateInvoiceInput) -> Result<(), String> {
    let line_items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();

    let mut cols = Map::new();
    cols.insert("due_date".into(), Value::String(input.due_date.clone()));
    cols.insert("line_items_json".into(), Value::String(line_items_json.clone()));
    cols.insert("subtotal".into(), json!(subtotal));
    cols.insert("tax".into(), json!(tax));
    cols.insert("total".into(), json!(total));
    cols.insert("notes".into(), Value::String(notes.clone()));
    sync::record_upsert("invoices", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET due_date=?1, line_items_json=?2, subtotal=?3, tax=?4, total=?5, notes=?6 WHERE id=?7",
        rusqlite::params![input.due_date, line_items_json, subtotal, tax, total, notes, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_invoice(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let status: String = conn
        .query_row(
            "SELECT status FROM invoices WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if status != "draft" {
        return Err("Only draft invoices can be deleted".into());
    }
    sync::record_delete("invoices", &id).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM invoices WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn generate_invoice_pdf(invoice_id: String) -> Result<String, String> {
    crate::invoice::generate_pdf(&invoice_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_invoice_pdf(app_handle: tauri::AppHandle, input: InvoiceInput) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (cname, cemail, ccompany, cmetadata): (
        String, Option<String>, Option<String>, Option<String>,
    ) = conn
        .query_row(
            "SELECT name,email,company,metadata FROM clients WHERE id=?1",
            [&input.client_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let client_address = crate::invoice::parse_client_address(&cmetadata);
    let company = crate::invoice::load_company().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();

    let pdf_bytes = crate::invoice::build_pdf_bytes(
        "PREVIEW", &now, &input.due_date, &input.line_items,
        subtotal, tax, total, &cname, &cemail, &ccompany, &client_address, &company,
        &notes,
    )
    .map_err(|e| e.to_string())?;

    let dir = crate::db::app_data_dir().join("preview");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("preview.pdf");
    std::fs::write(&path, pdf_bytes).map_err(|e| e.to_string())?;

    use tauri_plugin_shell::ShellExt;
    app_handle.shell().open(path.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn send_invoice(invoice_id: String) -> Result<(), String> {
    crate::invoice::send_invoice(&invoice_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_invoice_paid(invoice_id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String("paid".into()));
    cols.insert("paid_at".into(), Value::String(now.clone()));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET status='paid' WHERE id=?1",
        [&invoice_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Email + AI
// ============================================================

#[tauri::command]
pub async fn send_email(
    to: String,
    subject: String,
    body: String,
    attachment_path: Option<String>,
) -> Result<(), String> {
    crate::email::send(&to, &subject, &body, attachment_path.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_inbox() -> Result<Vec<crate::email::ParsedEmail>, String> {
    crate::email::scan().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn oauth_start_consent(
    app_handle: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    crate::oauth_flow::start_consent_flow(app_handle, client_id, client_secret)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_draft_reply(email_body: String, context: Option<String>) -> Result<String, String> {
    crate::ai::draft_reply(&email_body, context.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_extract_data(email_body: String) -> Result<Value, String> {
    crate::ai::extract_structured(&email_body)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_suggest_invoice(description: String) -> Result<Value, String> {
    crate::ai::suggest_invoice_items(&description)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_summarize_history(client_id: String) -> Result<String, String> {
    let rows: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT subject || ': ' || body FROM interactions
                 WHERE client_id=?1 ORDER BY created_at DESC LIMIT 20",
            )
            .map_err(|e| e.to_string())?;
        let collected: Vec<String> = stmt
            .query_map([client_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        collected
    };
    crate::ai::summarize_history(&rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_health_check() -> Result<bool, String> {
    crate::ai::health_check().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_list_models() -> Result<Vec<crate::ai::TagModel>, String> {
    crate::ai::list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_set_model(model: String) -> Result<(), String> {
    crate::ai::set_model(&model).map_err(|e| e.to_string())
}

// ============================================================
//  Settings & Credentials
// ============================================================

#[tauri::command]
pub async fn save_credential(key: String, value: String) -> Result<(), String> {
    crate::email::save_cred(&key, &value).map_err(|e| e.to_string())?;
    let roundtrip = crate::email::cred_opt(&key);
    if roundtrip.is_none() {
        return Err(format!(
            "keyring roundtrip failed: set_password succeeded but get_password returned None for key '{}'. The keyring backend may not be persisting on this system.",
            key
        ));
    }
    tracing::info!("credential '{}' saved and verified (length={})", key, value.len());
    Ok(())
}

#[tauri::command]
pub async fn delete_credential(key: String) -> Result<(), String> {
    crate::email::delete_cred(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_email_settings(settings: crate::email::EmailSettings) -> Result<(), String> {
    crate::email::save_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_email_settings() -> Result<Option<crate::email::EmailSettings>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='email_settings'",
            [],
            |r| r.get(0),
        )
        .ok();
    match json {
        Some(s) => Ok(Some(serde_json::from_str(&s).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn save_company_info(mut info: crate::invoice::CompanyInfo) -> Result<(), String> {
    let logo_dir = crate::db::app_data_dir().clone();
    let target = logo_dir.join("company_logo.png");

    if let Some(ref src) = info.logo_path {
        std::fs::create_dir_all(&logo_dir).map_err(|e| e.to_string())?;
        std::fs::copy(src, &target).map_err(|e| e.to_string())?;
        info.logo_path = Some(target.to_string_lossy().to_string());
    } else {
        let _ = std::fs::remove_file(&target);
    }

    let conn = pool().get().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&info).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('company_info',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_company_info() -> Result<Option<crate::invoice::CompanyInfo>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key='company_info'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(json.and_then(|s| serde_json::from_str(&s).ok()))
}

// ============================================================
//  Sync controls
// ============================================================

#[tauri::command]
pub async fn sync_replay() -> Result<usize, String> {
    crate::sync::replay_all()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_status() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let total_events: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_meta", [], |r| r.get(0))
        .unwrap_or(0);
    let last_applied: Option<String> = conn
        .query_row(
            "SELECT applied_at FROM sync_meta ORDER BY applied_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(json!({
        "events_applied": total_events,
        "last_applied": last_applied,
    }))
}

#[tauri::command]
pub async fn sync_set_passphrase(passphrase: String) -> Result<(), String> {
    crate::sync_crypto::set_passphrase(&passphrase).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_is_encrypted() -> Result<bool, String> {
    Ok(crate::sync_crypto::is_encryption_enabled())
}

// ============================================================
//  Dashboard stats
// ============================================================

#[tauri::command]
pub async fn dashboard_stats() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let total_clients: i64 = conn
        .query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0))
        .unwrap_or(0);
    let total_invoices: i64 = conn
        .query_row("SELECT COUNT(*) FROM invoices", [], |r| r.get(0))
        .unwrap_or(0);
    let outstanding: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM invoices WHERE status IN ('sent','overdue')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let paid_this_year: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM invoices
             WHERE status='paid' AND issue_date >= ?1",
            [format!("{}-01-01", Utc::now().format("%Y"))],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    Ok(json!({
        "clients": total_clients,
        "invoices": total_invoices,
        "outstanding": outstanding,
        "paid_ytd": paid_this_year,
    }))
}

// ============================================================
//  CSV Import
// ============================================================

#[tauri::command]
pub async fn csv_preview(path: String) -> Result<crate::csv_import::CsvPreview, String> {
    crate::csv_import::preview(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn csv_import(
    path: String,
    mapping: crate::csv_import::ColumnMapping,
) -> Result<crate::csv_import::ImportSummary, String> {
    crate::csv_import::import(&path, &mapping).map_err(|e| e.to_string())
}

// ============================================================
//  Signup Rules
// ============================================================

#[tauri::command]
pub async fn list_signup_rules() -> Result<Vec<crate::signup_rules::SignupRule>, String> {
    crate::signup_rules::list_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_signup_rule(
    input: crate::signup_rules::RuleInput,
) -> Result<String, String> {
    crate::signup_rules::create_rule(input).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_signup_rule(id: String) -> Result<(), String> {
    crate::signup_rules::delete_rule(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_signup_rule(id: String, active: bool) -> Result<(), String> {
    crate::signup_rules::toggle_rule(&id, active).map_err(|e| e.to_string())
}

// ============================================================
//  Payment Methods
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PaymentMethod {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub details: String,
    pub active: bool,
    pub sort_order: i32,
}

#[tauri::command]
pub async fn list_payment_methods() -> Result<Vec<PaymentMethod>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,kind,label,details,active,sort_order
             FROM payment_methods ORDER BY sort_order, kind",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PaymentMethod {
                id: r.get(0)?,
                kind: r.get(1)?,
                label: r.get(2)?,
                details: r.get(3)?,
                active: r.get::<_, i32>(4)? != 0,
                sort_order: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct PaymentMethodInput {
    pub kind: String,
    pub label: String,
    pub details: Option<String>,
}

#[tauri::command]
pub async fn create_payment_method(input: PaymentMethodInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let details = input.details.unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("kind".into(), Value::String(input.kind.clone()));
    cols.insert("label".into(), Value::String(input.label.clone()));
    cols.insert("details".into(), Value::String(details.clone()));
    cols.insert("active".into(), json!(1));
    cols.insert("sort_order".into(), json!(0));
    sync::record_upsert("payment_methods", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO payment_methods (id,kind,label,details,active,sort_order) VALUES (?1,?2,?3,?4,1,0)",
        rusqlite::params![id, input.kind, input.label, details],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_payment_method(id: String, input: PaymentMethodInput) -> Result<(), String> {
    let details = input.details.unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("kind".into(), Value::String(input.kind.clone()));
    cols.insert("label".into(), Value::String(input.label.clone()));
    cols.insert("details".into(), Value::String(details.clone()));
    sync::record_upsert("payment_methods", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE payment_methods SET kind=?1, label=?2, details=?3 WHERE id=?4",
        rusqlite::params![input.kind, input.label, details, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_payment_method(id: String) -> Result<(), String> {
    sync::record_delete("payment_methods", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM payment_methods WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_payment_methods(ids: Vec<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        let mut cols = Map::new();
        cols.insert("sort_order".into(), json!(i as i32));
        sync::record_upsert("payment_methods", id, cols).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE payment_methods SET sort_order=?1 WHERE id=?2",
            rusqlite::params![i as i32, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
//  Email Drafts
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailDraft {
    pub id: String,
    pub client_id: Option<String>,
    pub in_reply_to_message_id: Option<String>,
    pub to_addr: String,
    pub subject: String,
    pub body: String,
    pub status: String,
    pub created_at: String,
    pub sent_at: Option<String>,
}

#[tauri::command]
pub async fn list_drafts(status: Option<String>) -> Result<Vec<EmailDraft>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let status_filter = status.unwrap_or_else(|| "pending".into());
    let mut stmt = conn
        .prepare(
            "SELECT id,client_id,in_reply_to_message_id,to_addr,subject,body,status,created_at,sent_at
             FROM email_drafts WHERE status=?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&status_filter], |r| {
            Ok(EmailDraft {
                id: r.get(0)?,
                client_id: r.get(1)?,
                in_reply_to_message_id: r.get(2)?,
                to_addr: r.get(3)?,
                subject: r.get(4)?,
                body: r.get(5)?,
                status: r.get(6)?,
                created_at: r.get(7)?,
                sent_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn update_draft(id: String, body: String, subject: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE email_drafts SET body=?1, subject=?2 WHERE id=?3",
        rusqlite::params![body, subject, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn send_draft(id: String) -> Result<(), String> {
    let (to_addr, subject, body) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let result: rusqlite::Result<(String, String, String)> = conn.query_row(
            "SELECT to_addr, subject, body FROM email_drafts WHERE id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        );
        result.map_err(|e| e.to_string())?
    };

    crate::email::send(&to_addr, &subject, &body, None)
        .await
        .map_err(|e| e.to_string())?;

    let now = Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE email_drafts SET status='sent', sent_at=?1 WHERE id=?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn discard_draft(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE email_drafts SET status='discarded' WHERE id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Helpers
// ============================================================

fn to_value(opt: Option<String>) -> Value {
    match opt {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}
