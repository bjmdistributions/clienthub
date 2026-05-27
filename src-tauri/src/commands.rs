//! Tauri command handlers. Every write goes through the sync engine
//! so changes propagate to other devices via the event log folder.

use crate::db::pool;
use crate::sync;
use chrono::{Utc, Datelike};
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
    pub lead_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: Option<Value>,
    pub invoice_count: i64,
    pub last_contact_at: Option<String>,
    pub total_revenue: f64,
    pub category: Option<String>,
    pub tags: Option<String>,
    pub street_address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip_code: Option<String>,
    pub next_follow_up_date: Option<String>,
    pub needs_review: bool,
}

fn extract_meta_str(meta: &Option<Value>, key: &str) -> Option<String> {
    meta.as_ref()?.get(key)?.as_str().map(|s| s.to_string())
}

fn extract_client_fields(meta: &Option<Value>) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, bool) {
    let needs_review = meta.as_ref()
        .and_then(|m| m.get("needs_review"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (
        extract_meta_str(meta, "category").or_else(|| extract_meta_str(meta, "primary_buy_category")),
        extract_meta_str(meta, "tags"),
        extract_meta_str(meta, "street_address"),
        extract_meta_str(meta, "city"),
        extract_meta_str(meta, "state"),
        extract_meta_str(meta, "zip_code"),
        extract_meta_str(meta, "next_follow_up_date"),
        needs_review,
    )
}

#[tauri::command]
pub async fn list_clients() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=c.id),
                    MAX(i.created_at),
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id), 0)
             FROM clients c
             LEFT JOIN interactions i ON i.client_id = c.id
             GROUP BY c.id
             ORDER BY c.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            Ok(Client {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                notes: r.get(5)?,
                billing_status: r.get(6)?,
                lead_status: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                metadata: meta,
                invoice_count: r.get(11)?,
                last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
                category, tags, street_address, city, state, zip_code, next_follow_up_date,
                needs_review,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_client(id: String) -> Result<Option<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let res: rusqlite::Result<Client> = conn.query_row(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND 1=1),
                MAX(i.created_at),
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND 1=1), 0)
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id
         WHERE c.id=?1
         GROUP BY c.id",
        [&id],
        |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            Ok(Client {
                id: r.get(0)?,
                name: r.get(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                notes: r.get(5)?,
                billing_status: r.get(6)?,
                lead_status: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                metadata: meta,
                invoice_count: r.get(11)?,
                last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
                category, tags, street_address, city, state, zip_code, next_follow_up_date,
                needs_review,
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
    pub lead_status: Option<String>,
    pub category: Option<String>,
    pub tags: Option<String>,
    pub street_address: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub zip_code: Option<String>,
    pub next_follow_up_date: Option<String>,
    pub needs_review: Option<bool>,
}

#[tauri::command]
pub async fn create_client(input: ClientInput) -> Result<Client, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let lead_status_val = input.lead_status.clone().unwrap_or_else(|| "prospect".into());

    let mut meta = input.metadata.clone().unwrap_or_else(|| serde_json::json!({}));
    if let Some(v) = &input.category { meta["category"] = Value::String(v.clone()); }
    if let Some(v) = &input.tags { meta["tags"] = Value::String(v.clone()); }
    if let Some(v) = &input.street_address { meta["street_address"] = Value::String(v.clone()); }
    if let Some(v) = &input.city { meta["city"] = Value::String(v.clone()); }
    if let Some(v) = &input.state { meta["state"] = Value::String(v.clone()); }
    if let Some(v) = &input.zip_code { meta["zip_code"] = Value::String(v.clone()); }
    if let Some(v) = &input.next_follow_up_date { meta["next_follow_up_date"] = Value::String(v.clone()); }
    if let Some(v) = input.needs_review { meta["needs_review"] = Value::Bool(v); }
    let metadata_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());

    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("company".into(), to_value(input.company.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("billing_status".into(), Value::String("active".into()));
    cols.insert("lead_status".into(), Value::String(lead_status_val.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    cols.insert("metadata".into(), Value::String(metadata_str.clone()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    write_client_row(&id, &input, &now, &now, "active", &metadata_str, &lead_status_val).map_err(|e| e.to_string())?;

    Ok(Client {
        id, name: input.name, email: input.email, phone: input.phone,
        company: input.company, notes: input.notes, billing_status: "active".into(),
        lead_status: lead_status_val, created_at: now.clone(), updated_at: now,
        metadata: Some(meta), invoice_count: 0, last_contact_at: None,
        total_revenue: 0.0,
        category: input.category, tags: input.tags,
        street_address: input.street_address, city: input.city,
        state: input.state, zip_code: input.zip_code,
        next_follow_up_date: input.next_follow_up_date,
        needs_review: input.needs_review.unwrap_or(false),
    })
}

fn write_client_row(id: &str, input: &ClientInput, created_at: &str, updated_at: &str, status: &str, metadata: &str, lead_status: &str) -> anyhow::Result<()> {
    let conn = pool().get()?;
    conn.execute(
        "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,lead_status,created_at,updated_at,metadata)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, email=excluded.email, phone=excluded.phone,
            company=excluded.company, notes=excluded.notes,
            billing_status=excluded.billing_status, lead_status=excluded.lead_status,
            updated_at=excluded.updated_at, metadata=excluded.metadata",
        rusqlite::params![id, input.name, input.email, input.phone, input.company, input.notes, status, lead_status, created_at, updated_at, metadata],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn update_client(id: String, input: ClientInput) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let lead_status_val = input.lead_status.clone().unwrap_or_else(|| "prospect".into());

    let mut meta = input.metadata.clone().unwrap_or_else(|| serde_json::json!({}));
    if let Some(v) = &input.category { meta["category"] = Value::String(v.clone()); }
    if let Some(v) = &input.tags { meta["tags"] = Value::String(v.clone()); }
    if let Some(v) = &input.street_address { meta["street_address"] = Value::String(v.clone()); }
    if let Some(v) = &input.city { meta["city"] = Value::String(v.clone()); }
    if let Some(v) = &input.state { meta["state"] = Value::String(v.clone()); }
    if let Some(v) = &input.zip_code { meta["zip_code"] = Value::String(v.clone()); }
    if let Some(v) = &input.next_follow_up_date { meta["next_follow_up_date"] = Value::String(v.clone()); }
    if let Some(v) = input.needs_review { meta["needs_review"] = Value::Bool(v); }
    let metadata_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());

    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("company".into(), to_value(input.company.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("lead_status".into(), Value::String(lead_status_val.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    cols.insert("metadata".into(), Value::String(metadata_str.clone()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clients SET name=?1,email=?2,phone=?3,company=?4,notes=?5,lead_status=?6,updated_at=?7,metadata=?8 WHERE id=?9",
        rusqlite::params![input.name, input.email, input.phone, input.company, input.notes, lead_status_val, now, metadata_str, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_client_status(id: String, status: String) -> Result<(), String> {
    let mut cols = Map::new();
    cols.insert("lead_status".into(), Value::String(status.clone()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE clients SET lead_status=?1 WHERE id=?2", rusqlite::params![status, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_client(id: String) -> Result<(), String> {
    sync::record_delete("clients", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clients WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn search_clients(query: String) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pattern = format!("%{}%", query.to_lowercase());
    let mut stmt = conn.prepare(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND 1=1),
                MAX(i.created_at),
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND 1=1), 0)
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id
         WHERE LOWER(c.name) LIKE ?1 OR LOWER(c.email) LIKE ?1 OR LOWER(c.company) LIKE ?1 OR LOWER(c.metadata) LIKE ?1
         GROUP BY c.id
         ORDER BY c.name LIMIT 50",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([pattern], |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, next_follow_up_date,
            needs_review,
            })
        }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_stale_clients(days: u32) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let cutoff = format!("-{} days", days);
    let mut stmt = conn.prepare(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND 1=1),
                MAX(i.created_at),
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND 1=1), 0)
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id
         GROUP BY c.id
     HAVING MAX(i.created_at) IS NULL OR MAX(i.created_at) < datetime('now', ?1)
     ORDER BY MAX(i.created_at) ASC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([cutoff], |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, next_follow_up_date,
            needs_review,
            })
        }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn due_followups() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND 1=1),
                    NULL,
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND 1=1), 0)
             FROM clients c
             WHERE json_extract(c.metadata, '$.next_follow_up_date') IS NOT NULL
             AND json_extract(c.metadata, '$.next_follow_up_date') <= date('now')
             ORDER BY json_extract(c.metadata, '$.next_follow_up_date') ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
                metadata: meta,
                invoice_count: r.get(11)?,
                last_contact_at: None,
                total_revenue: r.get(12)?,
                category, tags, street_address, city, state, zip_code, next_follow_up_date,
                needs_review,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct ClientFilter {
    pub category: Option<String>,
    pub lead_status: Option<String>,
    pub tag: Option<String>,
    pub state: Option<String>,
    pub stale_days: Option<u32>,
    pub missing: Option<String>,
    pub needs_review: Option<bool>,
    pub search: Option<String>,
}

#[tauri::command]
pub async fn list_clients_filtered(filter: ClientFilter) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    let mut sql = String::from(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id),
                MAX(i.created_at),
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id), 0)
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id"
    );
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref s) = filter.search {
        let pat = format!("%{}%", s.to_lowercase());
        conds.push(format!(
            "(LOWER(c.name) LIKE ?{p} OR LOWER(c.email) LIKE ?{p} OR LOWER(c.company) LIKE ?{p})",
            p = param_idx
        ));
        params.push(Box::new(pat));
        param_idx += 1;
    }
    if let Some(ref s) = filter.lead_status {
        conds.push(format!("c.lead_status = ?{}", param_idx));
        params.push(Box::new(s.clone()));
        param_idx += 1;
    }
    if let Some(ref s) = filter.category {
        if s == "__none__" {
            conds.push("(json_extract(c.metadata, '$.category') IS NULL OR json_extract(c.metadata, '$.category') = '') AND (json_extract(c.metadata, '$.primary_buy_category') IS NULL OR json_extract(c.metadata, '$.primary_buy_category') = '')".into());
        } else {
            conds.push(format!("(LOWER(json_extract(c.metadata, '$.category')) LIKE LOWER('%' || ?{p} || '%') OR LOWER(json_extract(c.metadata, '$.primary_buy_category')) LIKE LOWER('%' || ?{p} || '%'))", p = param_idx));
            params.push(Box::new(s.clone()));
            param_idx += 1;
        }
    }
    if let Some(ref s) = filter.tag {
        conds.push(format!("json_extract(c.metadata, '$.tags') LIKE ?{}", param_idx));
        let pat = format!("%{}%", s);
        params.push(Box::new(pat));
        param_idx += 1;
    }
    if let Some(ref s) = filter.state {
        conds.push(format!("LOWER(json_extract(c.metadata, '$.state')) = LOWER(?{})", param_idx));
        params.push(Box::new(s.clone()));
        param_idx += 1;
    }
    if let Some(ref m) = filter.missing {
        match m.as_str() {
            "email" => conds.push("(c.email IS NULL OR c.email = '')".into()),
            "phone" => conds.push("(c.phone IS NULL OR c.phone = '')".into()),
            "address" => conds.push("(json_extract(c.metadata, '$.street_address') IS NULL OR json_extract(c.metadata, '$.street_address') = '')".into()),
            "category" => conds.push("(json_extract(c.metadata, '$.category') IS NULL OR json_extract(c.metadata, '$.category') = '') AND (json_extract(c.metadata, '$.primary_buy_category') IS NULL OR json_extract(c.metadata, '$.primary_buy_category') = '')".into()),
            _ => {}
        }
    }
    if let Some(true) = filter.needs_review {
        conds.push("json_extract(c.metadata, '$.needs_review') = 1".into());
    }

    if !conds.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conds.join(" AND "));
    }

    sql.push_str(" GROUP BY c.id");

    if let Some(days) = filter.stale_days {
        let cutoff = format!("-{} days", days);
        sql.push_str(&format!(" HAVING MAX(i.created_at) IS NULL OR MAX(i.created_at) < datetime('now', ?{})", param_idx));
        params.push(Box::new(cutoff));
    }

    sql.push_str(" ORDER BY c.name");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
            total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, next_follow_up_date,
            needs_review,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Serialize)]
pub struct MissingInfoReport {
    pub missing_email: Vec<Client>,
    pub missing_phone: Vec<Client>,
    pub missing_address: Vec<Client>,
    pub missing_category: Vec<Client>,
    pub never_contacted: Vec<Client>,
    pub needs_review: Vec<Client>,
    pub total_incomplete: u32,
}

fn query_clients_where(conn: &rusqlite::Connection, where_clause: &str, params: &[&dyn rusqlite::types::ToSql]) -> Result<Vec<Client>, String> {
    let sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id),
                NULL,
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id), 0)
         FROM clients c
         WHERE {}", where_clause
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta, invoice_count: r.get(11)?, last_contact_at: None,
            total_revenue: r.get(12)?,
            category, tags, street_address, city, state, zip_code, next_follow_up_date,
            needs_review,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn clients_missing_info() -> Result<MissingInfoReport, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let missing_email = query_clients_where(&conn, "(c.email IS NULL OR c.email = '')", &[])?;
    let missing_phone = query_clients_where(&conn, "(c.phone IS NULL OR c.phone = '')", &[])?;
    let missing_address = query_clients_where(&conn, "(json_extract(c.metadata, '$.street_address') IS NULL OR json_extract(c.metadata, '$.street_address') = '')", &[])?;
    let missing_category = query_clients_where(&conn, "(json_extract(c.metadata, '$.category') IS NULL OR json_extract(c.metadata, '$.category') = '') AND (json_extract(c.metadata, '$.primary_buy_category') IS NULL OR json_extract(c.metadata, '$.primary_buy_category') = '')", &[])?;
    let never_contacted: Vec<Client> = {
        let sql = "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                          (SELECT COUNT(*) FROM invoices WHERE client_id=c.id),
                          NULL,
                          COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id), 0)
                   FROM clients c
                   LEFT JOIN interactions i ON i.client_id = c.id
                   WHERE i.id IS NULL";
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
                metadata: meta, invoice_count: r.get(11)?, last_contact_at: None,
                total_revenue: r.get(12)?,
                category, tags, street_address, city, state, zip_code, next_follow_up_date,
                needs_review,
            })
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let needs_review = query_clients_where(&conn, "json_extract(c.metadata, '$.needs_review') = 1", &[])?;
    let mut seen = std::collections::HashSet::new();
    missing_email.iter().for_each(|c| { seen.insert(c.id.clone()); });
    missing_phone.iter().for_each(|c| { seen.insert(c.id.clone()); });
    missing_address.iter().for_each(|c| { seen.insert(c.id.clone()); });
    missing_category.iter().for_each(|c| { seen.insert(c.id.clone()); });
    never_contacted.iter().for_each(|c| { seen.insert(c.id.clone()); });
    needs_review.iter().for_each(|c| { seen.insert(c.id.clone()); });
    Ok(MissingInfoReport {
        missing_email, missing_phone, missing_address, missing_category, never_contacted, needs_review,
        total_incomplete: seen.len() as u32,
    })
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
    let conn = pool().get().map_err(|e| e.to_string())?;
    let user_name: Option<String> = conn.query_row(
        "SELECT u.name FROM users u JOIN settings s ON s.value = u.id WHERE s.key = 'current_user_id' AND u.is_active = 1",
        [], |r| r.get(0),
    ).ok();
    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("kind".into(), Value::String(input.kind.clone()));
    cols.insert("subject".into(), to_value(input.subject.clone()));
    cols.insert("body".into(), to_value(input.body.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    if let Some(ref un) = user_name { cols.insert("user_name".into(), Value::String(un.clone())); }
    sync::record_upsert("interactions", &id, cols).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO interactions (id,client_id,kind,subject,body,created_at,user_name)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![id, input.client_id, input.kind, input.subject, input.body, now, user_name],
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
    pub cost_items_json: Option<String>,
    pub total_cost: Option<f64>,
    pub profit: Option<f64>,
    pub margin: Option<f64>,
    pub carrier: Option<String>,
    pub tracking_number: Option<String>,
    pub shipping_charged: Option<f64>,
    pub pickup_date: Option<String>,
    pub delivery_date: Option<String>,
    pub is_complete: bool,
    pub deal_flow_id: Option<String>,
    pub deal_flow_stage: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShippingInfo {
    pub carrier: Option<String>,
    pub tracking_number: Option<String>,
    pub shipping_charged: Option<f64>,
    pub pickup_date: Option<String>,
    pub delivery_date: Option<String>,
    pub is_complete: bool,
}

#[tauri::command]
pub async fn list_invoices() -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage
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
                cost_items_json: r.get(13)?, total_cost: r.get(14)?,
                profit: r.get(15)?, margin: r.get(16)?,
                carrier: r.get(17)?, tracking_number: r.get(18)?,
                shipping_charged: r.get(19)?, pickup_date: r.get(20)?,
                delivery_date: r.get(21)?, is_complete: r.get(22)?,
                deal_flow_id: r.get(23)?, deal_flow_stage: r.get(24)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_invoice(id: String) -> Result<Invoice, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage
         FROM invoices WHERE id=?1",
        [&id],
        |r| Ok(Invoice {
            id: r.get(0)?, client_id: r.get(1)?, number: r.get(2)?,
            issue_date: r.get(3)?, due_date: r.get(4)?, line_items_json: r.get(5)?,
            subtotal: r.get(6)?, tax: r.get(7)?, total: r.get(8)?, status: r.get(9)?,
            pdf_path: r.get(10)?, sent_at: r.get(11)?, notes: r.get(12)?,
            cost_items_json: r.get(13)?, total_cost: r.get(14)?,
            profit: r.get(15)?, margin: r.get(16)?,
            carrier: r.get(17)?, tracking_number: r.get(18)?,
            shipping_charged: r.get(19)?, pickup_date: r.get(20)?,
            delivery_date: r.get(21)?, is_complete: r.get(22)?,
            deal_flow_id: r.get(23)?, deal_flow_stage: r.get(24)?,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_invoices_for_client(client_id: String) -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage
         FROM invoices WHERE client_id=?1 ORDER BY issue_date DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([client_id], |r| {
        Ok(Invoice {
            id: r.get(0)?, client_id: r.get(1)?, number: r.get(2)?,
            issue_date: r.get(3)?, due_date: r.get(4)?, line_items_json: r.get(5)?,
            subtotal: r.get(6)?, tax: r.get(7)?, total: r.get(8)?, status: r.get(9)?,
            pdf_path: r.get(10)?, sent_at: r.get(11)?, notes: r.get(12)?,
            cost_items_json: r.get(13)?, total_cost: r.get(14)?,
            profit: r.get(15)?, margin: r.get(16)?,
            carrier: r.get(17)?, tracking_number: r.get(18)?,
            shipping_charged: r.get(19)?, pickup_date: r.get(20)?,
            delivery_date: r.get(21)?, is_complete: r.get(22)?,
            deal_flow_id: r.get(23)?, deal_flow_stage: r.get(24)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct InvoiceInput {
    pub client_id: String,
    pub due_date: String,
    pub issue_date: Option<String>,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub tax_rate: f64,
    pub notes: Option<String>,
    pub recurring: Option<String>,
}

#[tauri::command]
pub async fn create_invoice(input: InvoiceInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let number = generate_invoice_number().map_err(|e| e.to_string())?;
    let issue = input.issue_date.clone().unwrap_or_else(|| now.to_rfc3339());
    let line_items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();
    let recurring = input.recurring.unwrap_or_default();
    let next_date = if !recurring.is_empty() { issue.clone() } else { String::new() };

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
    cols.insert("recurring".into(), Value::String(recurring.clone()));
    cols.insert("next_recurring_date".into(), Value::String(next_date.clone()));
    cols.insert("created_at".into(), Value::String(issue.clone()));
    sync::record_upsert("invoices", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,notes,recurring,next_recurring_date,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?11,?12,?4)",
        rusqlite::params![id, input.client_id, number, issue, input.due_date, line_items_json, subtotal, tax, total, notes, recurring, next_date],
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
    sync::record_delete("invoices", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM invoices WHERE id=?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mark_overdue_invoices() -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM invoices WHERE status='sent' AND due_date < date('now')")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut count = 0u32;
    for id in &ids {
        let mut cols = Map::new();
        cols.insert("status".into(), Value::String("overdue".into()));
        if let Err(e) = sync::record_upsert("invoices", id, cols) {
            tracing::warn!("mark_overdue: sync failed for {}: {}", id, e);
            continue;
        }
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE invoices SET status='overdue' WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

#[tauri::command]
pub async fn generate_recurring_invoices() -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let ids: Vec<(String, String, String, String, String, f64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, client_id, line_items_json, recurring, next_recurring_date, tax FROM invoices
             WHERE recurring != '' AND next_recurring_date <= date('now')",
        ).map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String, String, String, f64)> = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        rows
    };

    let mut count = 0u32;
    for (source_id, client_id, items_json, freq, _next_date, tax_amt) in &ids {
        let items: Vec<crate::invoice::LineItem> = serde_json::from_str(items_json).unwrap_or_default();
        let (subtotal, tax, total) = crate::invoice::compute_totals(&items, *tax_amt as f64 / 100.0);
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let number = generate_invoice_number().map_err(|e| e.to_string())?;
        let issue = now.to_rfc3339();
        let due = compute_next_due(freq);
        let line_items_json = serde_json::to_string(&items).map_err(|e| e.to_string())?;

        let mut cols = Map::new();
        cols.insert("client_id".into(), Value::String(client_id.clone()));
        cols.insert("number".into(), Value::String(number.clone()));
        cols.insert("issue_date".into(), Value::String(issue.clone()));
        cols.insert("due_date".into(), Value::String(due.clone()));
        cols.insert("line_items_json".into(), Value::String(line_items_json.clone()));
        cols.insert("subtotal".into(), json!(subtotal));
        cols.insert("tax".into(), json!(tax));
        cols.insert("total".into(), json!(total));
        cols.insert("status".into(), Value::String("draft".into()));
        cols.insert("created_at".into(), Value::String(issue.clone()));
        sync::record_upsert("invoices", &id, cols).map_err(|e| e.to_string())?;

        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?4)",
            rusqlite::params![id, client_id, number, issue, due, line_items_json, subtotal, tax, total],
        ).map_err(|e| e.to_string())?;

        let next = compute_next_recurring(&now.to_rfc3339(), freq);
        let _ = conn.execute("UPDATE invoices SET next_recurring_date=?1 WHERE id=?2", rusqlite::params![next, source_id]);

        count += 1;
    }
    Ok(count)
}

fn compute_next_due(freq: &str) -> String {
    let now = Utc::now();
    let next = match freq {
        "monthly" => now + chrono::Duration::days(30),
        "quarterly" => now + chrono::Duration::days(90),
        "annually" => now + chrono::Duration::days(365),
        _ => now + chrono::Duration::days(30),
    };
    next.to_rfc3339()
}

fn compute_next_recurring(current_date: &str, freq: &str) -> String {
    let dt = chrono::DateTime::parse_from_rfc3339(current_date).unwrap_or_else(|_| Utc::now().fixed_offset());
    let next = match freq {
        "monthly" => dt + chrono::Duration::days(30),
        "quarterly" => dt + chrono::Duration::days(90),
        "annually" => dt + chrono::Duration::days(365),
        _ => dt + chrono::Duration::days(30),
    };
    next.to_rfc3339()
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
pub async fn mark_invoice_paid(
    invoice_id: String,
    paid_date: String,
    payment_method_label: Option<String>,
    payment_reference: Option<String>,
) -> Result<(), String> {
    let method = payment_method_label.unwrap_or_default();
    let reference = payment_reference.unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String("paid".into()));
    cols.insert("paid_at".into(), Value::String(paid_date.clone()));
    cols.insert("payment_method_label".into(), Value::String(method.clone()));
    cols.insert("payment_reference".into(), Value::String(reference.clone()));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET status='paid', paid_at=?1, payment_method_label=?2, payment_reference=?3 WHERE id=?4",
        rusqlite::params![paid_date, method, reference, invoice_id],
    )
    .map_err(|e| e.to_string())?;

    let (flow_id, amount, current_stage): (String, f64, String) = {
        let flow_id = get_or_create_deal_flow_for_invoice(&invoice_id)?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        let amount: f64 = conn.query_row("SELECT total FROM invoices WHERE id=?1", [&invoice_id], |r| r.get(0)).unwrap_or(0.0);
        let current_stage: String = conn.query_row("SELECT stage FROM deal_flows WHERE id=?1", [&flow_id], |r| r.get(0)).unwrap_or_else(|_| "invoiced".into());
        (flow_id, amount, current_stage)
    };
    if current_stage == "invoiced" {
        let now = Utc::now().to_rfc3339();
        let mut df_cols = Map::new();
        df_cols.insert("stage".into(), Value::String("payment_received".into()));
        df_cols.insert("payment_received_amount".into(), json!(amount));
        df_cols.insert("payment_received_method".into(), Value::String(method.clone()));
        df_cols.insert("payment_received_at".into(), Value::String(paid_date.clone()));
        df_cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_flows", &flow_id, df_cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET stage='payment_received', payment_received_amount=?1, payment_received_method=?2, payment_received_at=?3, updated_at=?4 WHERE id=?5",
            rusqlite::params![amount, method, paid_date, now, flow_id],
        ).map_err(|e| e.to_string())?;
        sync_invoice_stage(&invoice_id, "payment_received")?;
    }
    Ok(())
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct CostItem {
    pub description: String,
    pub amount: f64,
}

#[tauri::command]
pub async fn save_invoice_costs(invoice_id: String, cost_items: Vec<CostItem>) -> Result<(), String> {
    let total_cost: f64 = cost_items.iter().map(|ci| ci.amount).sum();
    let total: f64 = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT total FROM invoices WHERE id=?1", [&invoice_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    let profit = total - total_cost;
    let margin = if total > 0.0 { (profit / total) * 100.0 } else { 0.0 };
    let cost_json = serde_json::to_string(&cost_items).map_err(|e| e.to_string())?;

    let mut cols = Map::new();
    cols.insert("cost_items_json".into(), Value::String(cost_json.clone()));
    cols.insert("total_cost".into(), json!(total_cost));
    cols.insert("profit".into(), json!(profit));
    cols.insert("margin".into(), json!(margin));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET cost_items_json=?1, total_cost=?2, profit=?3, margin=?4 WHERE id=?5",
        rusqlite::params![cost_json, total_cost, profit, margin, invoice_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn save_invoice_shipping(invoice_id: String, info: ShippingInfo) -> Result<(), String> {
    let has_shipping = info.carrier.as_deref().map_or(false, |s| !s.is_empty())
        && info.tracking_number.as_deref().map_or(false, |s| !s.is_empty())
        && info.pickup_date.as_deref().map_or(false, |s| !s.is_empty());
    let is_complete = info.is_complete || has_shipping;

    let mut cols = Map::new();
    cols.insert("carrier".into(), to_value(info.carrier.clone()));
    cols.insert("tracking_number".into(), to_value(info.tracking_number.clone()));
    cols.insert("shipping_charged".into(), json!(info.shipping_charged.unwrap_or(0.0)));
    cols.insert("pickup_date".into(), to_value(info.pickup_date.clone()));
    cols.insert("delivery_date".into(), to_value(info.delivery_date.clone()));
    cols.insert("is_complete".into(), json!(is_complete));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET carrier=?1, tracking_number=?2, shipping_charged=?3, pickup_date=?4, delivery_date=?5, is_complete=?6 WHERE id=?7",
        rusqlite::params![info.carrier, info.tracking_number, info.shipping_charged.unwrap_or(0.0), info.pickup_date, info.delivery_date, is_complete as i64, invoice_id],
    ).map_err(|e| e.to_string())?;
    if is_complete {
        let flow_id: Option<String> = conn.query_row("SELECT id FROM deal_flows WHERE invoice_id=?1", [&invoice_id], |r| r.get(0)).ok();
        if let Some(flow_id) = flow_id {
            let now = Utc::now().to_rfc3339();
            let meta_json = serde_json::to_string(&json!({"shipping_status": "shipped"})).map_err(|e| e.to_string())?;
            let mut df_cols = Map::new();
            df_cols.insert("metadata".into(), Value::String(meta_json.clone()));
            df_cols.insert("updated_at".into(), Value::String(now.clone()));
            sync::record_upsert("deal_flows", &flow_id, df_cols).map_err(|e| e.to_string())?;
            conn.execute("UPDATE deal_flows SET metadata=?1, updated_at=?2 WHERE id=?3", rusqlite::params![meta_json, now, flow_id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_invoice_sent_date(invoice_id: String, sent_date: String) -> Result<(), String> {
    let mut cols = Map::new();
    cols.insert("sent_at".into(), Value::String(sent_date.clone()));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE invoices SET sent_at=?1 WHERE id=?2", rusqlite::params![sent_date, invoice_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Deals (deal pipeline — synced)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Deal {
    pub id: String,
    pub client_id: String,
    pub title: String,
    pub stage: String,
    pub line_items_json: String,
    pub supplier_costs_json: String,
    pub shipping_cost: f64,
    pub other_costs: f64,
    pub asking_price: f64,
    pub payment_terms: Option<String>,
    pub notes: Option<String>,
    pub expected_close_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub won_at: Option<String>,
    pub lost_at: Option<String>,
    pub lost_reason: Option<String>,
    pub converted_invoice_id: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Deserialize)]
pub struct DealInput {
    pub client_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub supplier_costs: Vec<DealCostItem>,
    pub shipping_cost: Option<f64>,
    pub other_costs: Option<f64>,
    pub asking_price: Option<f64>,
    pub payment_terms: Option<String>,
    pub notes: Option<String>,
    pub expected_close_date: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct DealCostItem {
    pub description: String,
    pub amount: f64,
    pub supplier_name: Option<String>,
}

#[derive(Serialize)]
pub struct SupplierNameSuggestion {
    pub supplier_name: String,
    pub count: u32,
}

fn map_deal_row(r: &rusqlite::Row) -> rusqlite::Result<Deal> {
    Ok(Deal {
        id: r.get(0)?, client_id: r.get(1)?, title: r.get(2)?, stage: r.get(3)?,
        line_items_json: r.get(4)?, supplier_costs_json: r.get(5)?,
        shipping_cost: r.get(6)?, other_costs: r.get(7)?, asking_price: r.get(8)?,
        payment_terms: r.get(9)?, notes: r.get(10)?, expected_close_date: r.get(11)?,
        created_at: r.get(12)?, updated_at: r.get(13)?,
        won_at: r.get(14)?, lost_at: r.get(15)?, lost_reason: r.get(16)?,
        converted_invoice_id: r.get(17)?, metadata: r.get(18)?,
    })
}

#[tauri::command]
pub async fn list_deals() -> Result<Vec<Deal>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| map_deal_row(r)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_deals_by_stage(stage: String) -> Result<Vec<Deal>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE stage=?1 ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&stage], |r| map_deal_row(r)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_deal(id: String) -> Result<Deal, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE id=?1",
        [&id], map_deal_row,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_deal(input: DealInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let stage = input.stage.unwrap_or_else(|| "lead".into());
    let li_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let sc_json = serde_json::to_string(&input.supplier_costs).map_err(|e| e.to_string())?;
    let shipping = input.shipping_cost.unwrap_or(0.0);
    let other = input.other_costs.unwrap_or(0.0);
    let asking = input.asking_price.unwrap_or(0.0);

    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("title".into(), Value::String(input.title.clone()));
    cols.insert("stage".into(), Value::String(stage.clone()));
    cols.insert("line_items_json".into(), Value::String(li_json.clone()));
    cols.insert("supplier_costs_json".into(), Value::String(sc_json.clone()));
    cols.insert("shipping_cost".into(), json!(shipping));
    cols.insert("other_costs".into(), json!(other));
    cols.insert("asking_price".into(), json!(asking));
    cols.insert("payment_terms".into(), to_value(input.payment_terms.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("expected_close_date".into(), to_value(input.expected_close_date.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deals", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO deals (id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)",
        rusqlite::params![id, input.client_id, input.title, stage, li_json, sc_json, shipping, other, asking, input.payment_terms, input.notes, input.expected_close_date, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_deal(id: String, input: DealInput) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let stage = input.stage.unwrap_or_else(|| "lead".into());
    let li_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let sc_json = serde_json::to_string(&input.supplier_costs).map_err(|e| e.to_string())?;
    let shipping = input.shipping_cost.unwrap_or(0.0);
    let other = input.other_costs.unwrap_or(0.0);
    let asking = input.asking_price.unwrap_or(0.0);

    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("title".into(), Value::String(input.title.clone()));
    cols.insert("stage".into(), Value::String(stage.clone()));
    cols.insert("line_items_json".into(), Value::String(li_json.clone()));
    cols.insert("supplier_costs_json".into(), Value::String(sc_json.clone()));
    cols.insert("shipping_cost".into(), json!(shipping));
    cols.insert("other_costs".into(), json!(other));
    cols.insert("asking_price".into(), json!(asking));
    cols.insert("payment_terms".into(), to_value(input.payment_terms.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("expected_close_date".into(), to_value(input.expected_close_date.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deals", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE deals SET client_id=?1,title=?2,stage=?3,line_items_json=?4,supplier_costs_json=?5,shipping_cost=?6,other_costs=?7,asking_price=?8,payment_terms=?9,notes=?10,expected_close_date=?11,updated_at=?12 WHERE id=?13",
        rusqlite::params![input.client_id, input.title, stage, li_json, sc_json, shipping, other, asking, input.payment_terms, input.notes, input.expected_close_date, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_deal_stage(id: String, stage: String, lost_reason: Option<String>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();

    let old_stage: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT stage FROM deals WHERE id=?1", [&id], |r| r.get(0)).ok()
    };

    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String(stage.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    if stage == "won" {
        cols.insert("won_at".into(), Value::String(now.clone()));
    }
    if stage == "lost" {
        cols.insert("lost_at".into(), Value::String(now.clone()));
        cols.insert("lost_reason".into(), to_value(lost_reason.clone()));
    }
    sync::record_upsert("deals", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    if stage == "lost" {
        conn.execute(
            "UPDATE deals SET stage=?1, updated_at=?2, lost_at=?2, lost_reason=?3 WHERE id=?4",
            rusqlite::params![stage, now, lost_reason, id],
        ).map_err(|e| e.to_string())?;
    } else {
        let won: Option<String> = if stage == "won" { Some(now.clone()) } else { None };
        conn.execute(
            "UPDATE deals SET stage=?1, updated_at=?2, won_at=?3 WHERE id=?4",
            rusqlite::params![stage, now, won, id],
        ).map_err(|e| e.to_string())?;
    }

    let history_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO deal_stage_history (id, deal_id, from_stage, to_stage, changed_at) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![history_id, id, old_stage, stage, now],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize, Debug, Clone)]
pub struct PipelineAnalytics {
    pub funnel_counts: std::collections::HashMap<String, u32>,
    pub funnel_values: std::collections::HashMap<String, f64>,
    pub avg_days_per_stage: std::collections::HashMap<String, f64>,
    pub conversion_rates: std::collections::HashMap<String, f64>,
    pub win_rate_overall: f64,
    pub win_rate_last_30d: f64,
    pub win_rate_last_90d: f64,
    pub avg_deal_size_won: f64,
    pub avg_deal_size_lost: f64,
    pub avg_cycle_time_days: f64,
    pub stuck_deals: Vec<StuckDeal>,
    pub top_lost_reasons: Vec<(String, u32)>,
}

#[tauri::command]
pub async fn pipeline_analytics(timeframe_days: Option<u32>) -> Result<PipelineAnalytics, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let days = timeframe_days.unwrap_or(0);
    let date_filter = if days > 0 {
        format!(" AND d.created_at >= date('now','-{} days')", days)
    } else { String::new() };

    let mut funnel_counts = std::collections::HashMap::new();
    let mut funnel_values = std::collections::HashMap::new();
    for stage in &["lead","quoted","negotiating","won","lost"] {
        let count: u32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM deals WHERE stage=?1{}", date_filter),
            [*stage], |r| r.get::<_,i64>(0)
        ).unwrap_or(0) as u32;
        let value: f64 = conn.query_row(
            &format!("SELECT COALESCE(SUM(asking_price),0) FROM deals WHERE stage=?1{}", date_filter),
            [*stage], |r| r.get(0)
        ).unwrap_or(0.0);
        funnel_counts.insert(stage.to_string(), count);
        funnel_values.insert(stage.to_string(), value);
    }

    let mut avg_days_per_stage = std::collections::HashMap::new();
    for stage in &["lead","quoted","negotiating"] {
        let next = match *stage { "lead" => "quoted", "quoted" => "negotiating", "negotiating" => "won", _ => "won" };
        let avg_days: f64 = conn.query_row(
            "SELECT COALESCE(AVG(julianday(h2.changed_at) - julianday(h1.changed_at)),0)
             FROM deal_stage_history h1 JOIN deal_stage_history h2 ON h1.deal_id=h2.deal_id
             WHERE h1.to_stage=?1 AND h2.to_stage=?2 AND h1.deal_id = h2.deal_id",
            rusqlite::params![*stage, next], |r| r.get(0)
        ).unwrap_or(0.0);
        avg_days_per_stage.insert(stage.to_string(), avg_days.max(0.0));
    }

    let mut conversion_rates = std::collections::HashMap::new();
    let stages_pairs = [("lead","quoted"),("quoted","negotiating"),("negotiating","won")];
    let dt_filter_cr = if days > 0 { format!(" AND created_at >= date('now','-{} days')", days) } else { String::new() };
    for (from, to) in &stages_pairs {
        let from_cnt: f64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM deals WHERE (stage=?1 OR stage=?2 OR stage='won' OR stage='lost'){}", dt_filter_cr),
            rusqlite::params![from, to], |r| r.get::<_,i64>(0)
        ).unwrap_or(0) as f64;
        let to_cnt: f64 = funnel_counts.get(to.to_owned()).copied().unwrap_or(0) as f64 + funnel_counts.get("won").copied().unwrap_or(0) as f64;
        let rate = if from_cnt > 0.0 { to_cnt / from_cnt * 100.0 } else { 0.0 };
        conversion_rates.insert(format!("{}_to_{}", from, to), rate);
    }

    let total_deals: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE (stage='won' OR stage='lost')", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let won_deals: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE stage='won'", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let win_rate_overall = if total_deals > 0.0 { (won_deals / total_deals) * 100.0 } else { 0.0 };

    let won_30d: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE stage='won' AND won_at >= date('now','-30 days')", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let total_30d: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE (stage='won' OR stage='lost') AND (won_at >= date('now','-30 days') OR lost_at >= date('now','-30 days'))", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let win_rate_last_30d = if total_30d > 0.0 { (won_30d / total_30d) * 100.0 } else { 0.0 };

    let won_90d: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE stage='won' AND won_at >= date('now','-90 days')", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let total_90d: f64 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE (stage='won' OR stage='lost') AND (won_at >= date('now','-90 days') OR lost_at >= date('now','-90 days'))", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as f64;
    let win_rate_last_90d = if total_90d > 0.0 { (won_90d / total_90d) * 100.0 } else { 0.0 };

    let avg_deal_size_won: f64 = conn.query_row(
        "SELECT COALESCE(AVG(asking_price),0) FROM deals WHERE stage='won'", [], |r| r.get(0)
    ).unwrap_or(0.0);
    let avg_deal_size_lost: f64 = conn.query_row(
        "SELECT COALESCE(AVG(asking_price),0) FROM deals WHERE stage='lost'", [], |r| r.get(0)
    ).unwrap_or(0.0);

    let avg_cycle_time_days: f64 = conn.query_row(
        "SELECT COALESCE(AVG(julianday(won_at) - julianday(created_at)),0) FROM deals WHERE stage='won' AND won_at IS NOT NULL",
        [], |r| r.get(0)
    ).unwrap_or(0.0);

    let stuck_deals: Vec<StuckDeal> = {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.title, d.stage, CAST(julianday('now') - julianday(d.updated_at) AS INTEGER) as days
             FROM deals d WHERE d.stage NOT IN ('won','lost') ORDER BY days DESC LIMIT 10"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(StuckDeal {
            deal_id: r.get(0)?, title: r.get(1)?, stage: r.get(2)?, days_in_stage: r.get::<_,i64>(3).unwrap_or(0).max(0) as u32,
        })).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let top_lost_reasons: Vec<(String, u32)> = {
        let mut stmt = conn.prepare(
            "SELECT lost_reason, COUNT(*) FROM deals WHERE stage='lost' AND lost_reason IS NOT NULL GROUP BY lost_reason ORDER BY COUNT(*) DESC LIMIT 5"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_,i64>(1)? as u32)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    Ok(PipelineAnalytics {
        funnel_counts, funnel_values, avg_days_per_stage, conversion_rates,
        win_rate_overall, win_rate_last_30d, win_rate_last_90d,
        avg_deal_size_won, avg_deal_size_lost, avg_cycle_time_days,
        stuck_deals, top_lost_reasons,
    })
}

#[tauri::command]
pub async fn delete_deal(id: String) -> Result<(), String> {
    sync::record_delete("deals", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM deals WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn convert_deal_to_invoice(deal_id: String) -> Result<String, String> {
    let deal = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE id=?1",
            [&deal_id], map_deal_row,
        ).map_err(|e| e.to_string())?
    };
    if deal.stage != "won" {
        return Err("Deal must be 'won' before converting to invoice".into());
    }
    if deal.converted_invoice_id.is_some() {
        return Err("Deal already has an invoice".into());
    }

    let line_items: Vec<crate::invoice::LineItem> = serde_json::from_str(&deal.line_items_json).map_err(|e| e.to_string())?;
    let supplier_costs: Vec<DealCostItem> = serde_json::from_str(&deal.supplier_costs_json).map_err(|e| e.to_string())?;

    let deal_notes = deal.notes.unwrap_or_default();
    let (subtotal, tax, _total) = crate::invoice::compute_totals(&line_items, 0.0);
    let total = subtotal + tax;

    let invoice_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let number = generate_invoice_number().map_err(|e| e.to_string())?;
    let li_json = deal.line_items_json.clone();

    let mut cost_items: Vec<CostItem> = supplier_costs.iter().map(|sc| CostItem {
        description: format!("{} ({})", sc.description, sc.supplier_name.as_deref().unwrap_or("unknown")),
        amount: sc.amount,
    }).collect();
    if deal.shipping_cost > 0.0 {
        cost_items.push(CostItem { description: "Shipping".into(), amount: deal.shipping_cost });
    }
    if deal.other_costs > 0.0 {
        cost_items.push(CostItem { description: "Other costs".into(), amount: deal.other_costs });
    }
    let cost_json = serde_json::to_string(&cost_items).map_err(|e| e.to_string())?;
    let total_cost: f64 = cost_items.iter().map(|c| c.amount).sum();
    let profit = total - total_cost;
    let margin = if total > 0.0 { (profit / total) * 100.0 } else { 0.0 };

    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(deal.client_id.clone()));
    cols.insert("number".into(), Value::String(number.clone()));
    cols.insert("issue_date".into(), Value::String(now.clone()));
    cols.insert("due_date".into(), Value::String(now.clone()));
    cols.insert("line_items_json".into(), Value::String(li_json.clone()));
    cols.insert("subtotal".into(), json!(subtotal));
    cols.insert("tax".into(), json!(tax));
    cols.insert("total".into(), json!(total));
    cols.insert("status".into(), Value::String("draft".into()));
    cols.insert("notes".into(), Value::String(deal_notes.clone()));
    cols.insert("cost_items_json".into(), Value::String(cost_json.clone()));
    cols.insert("total_cost".into(), json!(total_cost));
    cols.insert("profit".into(), json!(profit));
    cols.insert("margin".into(), json!(margin));
    cols.insert("created_at".into(), Value::String(now.clone()));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,notes,cost_items_json,total_cost,profit,margin,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?11,?12,?13,?14,?15)",
            rusqlite::params![invoice_id, deal.client_id, number, now, now, li_json, subtotal, tax, total, deal_notes, cost_json, total_cost, profit, margin, now],
        ).map_err(|e| e.to_string())?;
    }

    let mut deal_cols = Map::new();
    deal_cols.insert("converted_invoice_id".into(), Value::String(invoice_id.clone()));
    deal_cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deals", &deal_id, deal_cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deals SET converted_invoice_id=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![invoice_id, now, deal_id],
        ).map_err(|e| e.to_string())?;
    }

    Ok(invoice_id)
}

#[tauri::command]
pub async fn supplier_name_suggestions() -> Result<Vec<SupplierNameSuggestion>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut suggestions: Vec<SupplierNameSuggestion> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stmt = conn.prepare("SELECT supplier_costs_json FROM deals").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for row in rows {
        if let Ok(json_str) = row {
            if let Ok(items) = serde_json::from_str::<Vec<Value>>(&json_str) {
                for item in &items {
                    if let Some(name) = item.get("supplier_name").and_then(|v| v.as_str()) {
                        let n = name.to_string();
                        if !n.is_empty() && seen.insert(n.clone()) {
                            suggestions.push(SupplierNameSuggestion { supplier_name: n, count: 1 });
                        }
                    }
                }
            }
        }
    }
    Ok(suggestions)
}

// ============================================================
//  Deal Flows (deal lifecycle tracking — synced)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupplierPayment {
    pub id: String,
    pub supplier_name: String,
    pub supplier_id: Option<String>,
    pub amount: f64,
    pub original_amount: Option<f64>,
    pub price_changed: bool,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    pub method: Option<String>,
    pub notes: Option<String>,
    pub paid: bool,
    pub paid_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupplierPaymentInput {
    pub supplier_name: String,
    pub supplier_id: Option<String>,
    pub amount: f64,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    pub method: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DealFlow {
    pub id: String,
    pub name: Option<String>,
    pub invoice_id: String,
    pub stage: String,
    pub payment_received_amount: f64,
    pub payment_received_method: Option<String>,
    pub payment_received_at: Option<String>,
    pub supplier_payments_json: String,
    pub supplier_payments: Vec<SupplierPayment>,
    pub total_supplier_cost: f64,
    pub completed_at: Option<String>,
    pub gross_revenue: f64,
    pub total_cost: f64,
    pub net_profit: f64,
    pub profit_jack: f64,
    pub profit_ben: f64,
    pub profit_business: f64,
    pub notes: Option<String>,
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub invoice_number: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub invoice_total: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PaymentReceivedInput {
    pub amount: f64,
    pub method: Option<String>,
    pub notes: Option<String>,
    pub received_at: Option<String>,
}

fn map_deal_flow_row(r: &rusqlite::Row) -> rusqlite::Result<DealFlow> {
    let sp_json: String = r.get("supplier_payments_json")?;
    let supplier_payments: Vec<SupplierPayment> = serde_json::from_str(&sp_json).unwrap_or_default();
    Ok(DealFlow {
        id: r.get("id")?,
        name: r.get("name").ok(),
        invoice_id: r.get("invoice_id")?,
        stage: r.get("stage")?,
        payment_received_amount: r.get("payment_received_amount")?,
        payment_received_method: r.get("payment_received_method")?,
        payment_received_at: r.get("payment_received_at")?,
        supplier_payments_json: sp_json,
        supplier_payments,
        total_supplier_cost: r.get("total_supplier_cost")?,
        completed_at: r.get("completed_at")?,
        gross_revenue: r.get("gross_revenue")?,
        total_cost: r.get("total_cost")?,
        net_profit: r.get("net_profit")?,
        profit_jack: r.get("profit_jack")?,
        profit_ben: r.get("profit_ben")?,
        profit_business: r.get("profit_business")?,
        notes: r.get("notes")?,
        metadata: r.get("metadata").ok(),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        invoice_number: r.get("invoice_number").ok(),
        client_id: r.get("client_id").ok(),
        client_name: r.get("client_name").ok(),
        invoice_total: r.get("invoice_total").unwrap_or(0.0),
    })
}

const DF_JOIN: &str = "SELECT df.*, i.number as invoice_number, i.client_id, i.total as invoice_total, c.name as client_name FROM deal_flows df LEFT JOIN invoices i ON df.invoice_id=i.id LEFT JOIN clients c ON i.client_id=c.id";

fn sync_invoice_stage(invoice_id: &str, stage: &str) -> Result<(), String> {
    let mut inv_cols = Map::new();
    inv_cols.insert("deal_flow_stage".into(), Value::String(stage.into()));
    sync::record_upsert("invoices", invoice_id, inv_cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET deal_flow_stage=?1 WHERE id=?2",
        rusqlite::params![stage, invoice_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_df(id: &str) -> Result<DealFlow, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("{} WHERE df.id=?1", DF_JOIN);
    conn.query_row(&sql, [&id], map_deal_flow_row).map_err(|e| e.to_string())
}

fn get_or_create_deal_flow_for_invoice(invoice_id: &str) -> Result<String, String> {
    let existing: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT id FROM deal_flows WHERE invoice_id=?1", [invoice_id], |r| r.get(0)).ok()
    };
    if let Some(id) = existing {
        return Ok(id);
    }
    create_deal_flow_internal(invoice_id.to_string(), None, None)
}

fn write_sp(deal_flow_id: &str, payments: &[SupplierPayment], invoice_id: &str) -> Result<(), String> {
    let sp_json = serde_json::to_string(payments).map_err(|e| e.to_string())?;
    let total: f64 = payments.iter().map(|p| p.amount).sum();
    let now = Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("supplier_payments_json".into(), Value::String(sp_json.clone()));
    cols.insert("total_supplier_cost".into(), json!(total));
    cols.insert("updated_at".into(), Value::String(now));
    sync::record_upsert("deal_flows", deal_flow_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE deal_flows SET supplier_payments_json=?1, total_supplier_cost=?2, updated_at=?3 WHERE id=?4",
        rusqlite::params![sp_json, total, Utc::now().to_rfc3339(), deal_flow_id],
    ).map_err(|e| e.to_string())?;
    let _ = invoice_id;
    Ok(())
}

fn recalc_completed_deal_flow(id: &str, gross: f64, payments: &[SupplierPayment]) -> Result<(), String> {
    let split = read_profit_split()?;
    let total_cost: f64 = payments.iter().map(|p| p.amount).sum();
    let net = gross - total_cost;
    let is_loss = net < 0.0;
    let jack = (net * (split.jack_pct / 100.0) * 100.0).round() / 100.0;
    let ben = (net * (split.ben_pct / 100.0) * 100.0).round() / 100.0;
    let business = (net * (split.business_pct / 100.0) * 100.0).round() / 100.0;
    let meta_json = serde_json::to_string(&json!({"is_loss": is_loss})).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("total_supplier_cost".into(), json!(total_cost));
    cols.insert("total_cost".into(), json!(total_cost));
    cols.insert("net_profit".into(), json!(net));
    cols.insert("profit_jack".into(), json!(jack));
    cols.insert("profit_ben".into(), json!(ben));
    cols.insert("profit_business".into(), json!(business));
    cols.insert("metadata".into(), Value::String(meta_json.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE deal_flows SET total_supplier_cost=?1, total_cost=?1, net_profit=?2, profit_jack=?3, profit_ben=?4, profit_business=?5, metadata=?6, updated_at=?7 WHERE id=?8",
        rusqlite::params![total_cost, net, jack, ben, business, meta_json, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn create_deal_flow_internal(invoice_id: String, notes: Option<String>, name: Option<String>) -> Result<String, String> {
    let exists: bool = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM invoices WHERE id=?1", [&invoice_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        n > 0
    };
    if !exists { return Err("Invoice not found".into()); }

    let already: bool = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM deal_flows WHERE invoice_id=?1", [&invoice_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        n > 0
    };
    if already { return Err("Deal flow already exists for this invoice".into()); }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let sp_json = "[]".to_string();

    let mut cols = Map::new();
    cols.insert("invoice_id".into(), Value::String(invoice_id.clone()));
    cols.insert("name".into(), to_value(name.clone()));
    cols.insert("stage".into(), Value::String("invoiced".into()));
    cols.insert("supplier_payments_json".into(), Value::String(sp_json.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    cols.insert("notes".into(), to_value(notes.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO deal_flows (id,name,invoice_id,stage,supplier_payments_json,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            rusqlite::params![id, name, invoice_id, "invoiced", sp_json, notes, now],
        ).map_err(|e| e.to_string())?;
    }

    {
        let mut inv_cols = Map::new();
        inv_cols.insert("deal_flow_id".into(), Value::String(id.clone()));
        inv_cols.insert("deal_flow_stage".into(), Value::String("invoiced".into()));
        sync::record_upsert("invoices", &invoice_id, inv_cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE invoices SET deal_flow_id=?1, deal_flow_stage='invoiced' WHERE id=?2", rusqlite::params![id, invoice_id]).map_err(|e| e.to_string())?;
    }

    Ok(id)
}

#[tauri::command]
pub async fn create_deal_flow(invoice_id: String, notes: Option<String>, name: Option<String>) -> Result<String, String> {
    create_deal_flow_internal(invoice_id, notes, name)
}

#[tauri::command]
pub async fn get_deal_flow_by_invoice(invoice_id: String) -> Result<Option<DealFlow>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("{} WHERE df.invoice_id=?1", DF_JOIN);
    match conn.query_row(&sql, [&invoice_id], map_deal_flow_row) {
        Ok(df) => Ok(Some(df)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn get_deal_flow(id: String) -> Result<DealFlow, String> {
    read_df(&id)
}

#[tauri::command]
pub async fn list_deal_flows() -> Result<Vec<DealFlow>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    // Backfill: any completed deal flow whose invoice still has null profit gets it written now.
    // This repairs deals completed before the profit write-back fix was applied.
    conn.execute(
        "UPDATE invoices SET
            profit     = (SELECT net_profit   FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete'),
            total_cost = (SELECT total_cost   FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete'),
            margin     = CASE WHEN (SELECT gross_revenue FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete') > 0
                              THEN (SELECT net_profit FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete')
                                 / (SELECT gross_revenue FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete') * 100
                              ELSE 0 END
         WHERE is_complete = 1 AND (profit IS NULL OR profit = 0)
           AND EXISTS (SELECT 1 FROM deal_flows WHERE deal_flows.invoice_id = invoices.id AND deal_flows.stage = 'complete')",
        [],
    ).ok(); // silently ignore if it fails

    let sql = format!("{} ORDER BY df.updated_at DESC", DF_JOIN);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_deal_flow_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_deal_flows_by_stage(stage: String) -> Result<Vec<DealFlow>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("{} WHERE df.stage=?1 ORDER BY df.updated_at DESC", DF_JOIN);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&stage], map_deal_flow_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn mark_payment_received(id: String, input: PaymentReceivedInput) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "invoiced" && df.stage != "payment_received" { return Err("Can only mark payment received from 'invoiced' or 'payment_received' stage".into()); }

    let now = Utc::now().to_rfc3339();
    let received_at = input.received_at.unwrap_or_else(|| now.clone());

    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("payment_received".into()));
    cols.insert("payment_received_amount".into(), json!(input.amount));
    cols.insert("payment_received_method".into(), to_value(input.method.clone()));
    cols.insert("payment_received_at".into(), Value::String(received_at.clone()));
    if let Some(ref n) = input.notes {
        cols.insert("notes".into(), Value::String(n.clone()));
    }
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET stage='payment_received', payment_received_amount=?1, payment_received_method=?2, payment_received_at=?3, notes=COALESCE(?4, notes), updated_at=?5 WHERE id=?6",
            rusqlite::params![input.amount, input.method, received_at, input.notes, now, id],
        ).map_err(|e| e.to_string())?;
    }

    sync_invoice_stage(&df.invoice_id, "payment_received")?;
    let mut inv_cols = Map::new();
    inv_cols.insert("status".into(), Value::String("paid".into()));
    inv_cols.insert("paid_at".into(), Value::String(received_at.clone()));
    if let Some(ref m) = input.method {
        inv_cols.insert("payment_method_label".into(), Value::String(m.clone()));
    }
    sync::record_upsert("invoices", &df.invoice_id, inv_cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET status='paid', paid_at=?1, payment_method_label=COALESCE(?2, payment_method_label) WHERE id=?3",
        rusqlite::params![received_at, input.method, df.invoice_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Shared helper: wipe completion data from a deal_flow + its invoice.
/// Called when cascading an undo back through the 'complete' stage.
fn clear_completion(df: &DealFlow, id: &str, now: &str) -> Result<(), String> {
    let mut cols = Map::new();
    cols.insert("completed_at".into(), Value::Null);
    cols.insert("gross_revenue".into(), json!(0));
    cols.insert("net_profit".into(), json!(0));
    cols.insert("total_cost".into(), json!(0));
    cols.insert("profit_jack".into(), json!(0));
    cols.insert("profit_ben".into(), json!(0));
    cols.insert("profit_business".into(), json!(0));
    cols.insert("updated_at".into(), Value::String(now.to_string()));
    sync::record_upsert("deal_flows", id, cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET completed_at=NULL, gross_revenue=0, net_profit=0, total_cost=0, \
             profit_jack=0, profit_ben=0, profit_business=0, updated_at=?1 WHERE id=?2",
            rusqlite::params![now, id],
        ).map_err(|e| e.to_string())?;
    }
    let mut inv_cols = Map::new();
    inv_cols.insert("is_complete".into(), json!(false));
    inv_cols.insert("profit".into(), Value::Null);
    inv_cols.insert("total_cost".into(), Value::Null);
    inv_cols.insert("margin".into(), Value::Null);
    sync::record_upsert("invoices", &df.invoice_id, inv_cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE invoices SET is_complete=0, profit=NULL, total_cost=NULL, margin=NULL WHERE id=?1",
            rusqlite::params![df.invoice_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn unmark_payment_received(id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    // Nothing to undo — already at the earliest stage
    if df.stage == "invoiced" { return Ok(()); }

    let now = Utc::now().to_rfc3339();

    // Cascade: if complete, wipe completion data first
    if df.stage == "complete" {
        clear_completion(&df, &id, &now)?;
    }

    // Cascade: if supplier_paid or complete, unmark all supplier payments
    if df.stage == "supplier_paid" || df.stage == "complete" {
        let mut payments = df.supplier_payments.clone();
        for p in payments.iter_mut() {
            p.paid = false;
            p.paid_at = None;
        }
        write_sp(&id, &payments, &df.invoice_id)?;
    }

    // Reset payment fields and stage → invoiced
    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("invoiced".into()));
    cols.insert("payment_received_amount".into(), json!(0));
    cols.insert("payment_received_method".into(), Value::Null);
    cols.insert("payment_received_at".into(), Value::Null);
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET stage='invoiced', payment_received_amount=0, payment_received_method=NULL, payment_received_at=NULL, updated_at=?1 WHERE id=?2",
            rusqlite::params![now, id],
        ).map_err(|e| e.to_string())?;
    }

    sync_invoice_stage(&df.invoice_id, "invoiced")?;
    Ok(())
}

#[tauri::command]
pub async fn add_supplier_payment(id: String, input: SupplierPaymentInput) -> Result<String, String> {
    let df = read_df(&id)?;
    if df.stage == "complete" { return Err("Cannot modify completed deal flow".into()); }

    let payment_id = Uuid::new_v4().to_string();
    let mut payments = df.supplier_payments.clone();
    payments.push(SupplierPayment {
        id: payment_id.clone(),
        supplier_name: input.supplier_name,
        supplier_id: input.supplier_id,
        amount: input.amount,
        original_amount: Some(input.amount),
        price_changed: false,
        quantity: input.quantity,
        unit_price: input.unit_price,
        method: input.method,
        notes: input.notes,
        paid: false,
        paid_at: None,
    });

    write_sp(&id, &payments, &df.invoice_id)?;
    Ok(payment_id)
}

#[tauri::command]
pub async fn update_supplier_payment(id: String, payment_id: String, input: SupplierPaymentInput) -> Result<(), String> {
    let df = read_df(&id)?;

    let mut payments = df.supplier_payments.clone();
    let supplier_name_for_price: String;
    let p = payments.iter_mut().find(|p| p.id == payment_id).ok_or("Payment not found")?;
    let old_amount = p.amount;

    let mut new_amount = input.amount;
    if let (Some(qty), Some(unit)) = (input.quantity, input.unit_price) {
        new_amount = (qty * unit * 100.0).round() / 100.0;
    }

    p.supplier_name = input.supplier_name;
    p.supplier_id = input.supplier_id.clone();
    p.quantity = input.quantity;
    p.unit_price = input.unit_price;
    p.method = input.method;
    p.notes = input.notes;

    p.amount = new_amount;
    if (old_amount - new_amount).abs() > 0.001 {
        if p.original_amount.is_none() {
            p.original_amount = Some(old_amount);
        }
        p.price_changed = true;
    }
    supplier_name_for_price = p.supplier_name.clone();

    write_sp(&id, &payments, &df.invoice_id)?;
    if let Some(supplier_id) = input.supplier_id {
        let price = input.unit_price.unwrap_or(new_amount);
        let qty = input.quantity.map(|q| q.round() as i32);
        record_supplier_price(
            supplier_id,
            supplier_name_for_price,
            price,
            qty,
            Some(id.clone()),
            Some("Auto-recorded from supplier payment update".into()),
        ).await?;
    }
    if df.stage == "complete" {
        recalc_completed_deal_flow(&id, df.payment_received_amount, &payments)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn revert_supplier_price_change(id: String, payment_id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    let mut payments = df.supplier_payments.clone();
    let p = payments.iter_mut().find(|p| p.id == payment_id).ok_or("Payment not found")?;
    let original = p.original_amount.ok_or("No original amount recorded")?;
    p.amount = original;
    p.price_changed = false;
    p.original_amount = None;

    write_sp(&id, &payments, &df.invoice_id)?;
    if df.stage == "complete" {
        recalc_completed_deal_flow(&id, df.payment_received_amount, &payments)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_supplier_payment(id: String, payment_id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage == "complete" { return Err("Cannot modify completed deal flow".into()); }

    let mut payments = df.supplier_payments.clone();
    let before = payments.len();
    payments.retain(|p| p.id != payment_id);
    if payments.len() == before { return Err("Payment not found".into()); }

    write_sp(&id, &payments, &df.invoice_id)?;

    if df.stage == "supplier_paid" && payments.iter().any(|p| !p.paid) {
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("stage".into(), Value::String("payment_received".into()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET stage='payment_received', updated_at=?1 WHERE id=?2", rusqlite::params![Utc::now().to_rfc3339(), id]).map_err(|e| e.to_string())?;
        sync_invoice_stage(&df.invoice_id, "payment_received")?;
    }

    Ok(())
}

#[tauri::command]
pub async fn mark_supplier_payment_paid(id: String, payment_id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "payment_received" && df.stage != "supplier_paid" {
        return Err("Can only mark supplier payments paid from 'payment_received' or 'supplier_paid' stage".into());
    }

    let mut payments = df.supplier_payments.clone();
    let p = payments.iter_mut().find(|p| p.id == payment_id).ok_or("Payment not found")?;
    if p.paid { return Err("Payment already marked as paid".into()); }
    p.paid = true;
    p.paid_at = Some(Utc::now().to_rfc3339());

    write_sp(&id, &payments, &df.invoice_id)?;

    let all_paid = payments.iter().all(|p| p.paid);
    if all_paid && !payments.is_empty() {
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("stage".into(), Value::String("supplier_paid".into()));
        cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET stage='supplier_paid', updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
        sync_invoice_stage(&df.invoice_id, "supplier_paid")?;
    }

    Ok(())
}

#[tauri::command]
pub async fn unmark_supplier_payment_paid(id: String, payment_id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    // No supplier payments can be paid if still at 'invoiced' stage
    if df.stage == "invoiced" { return Ok(()); }

    let now = Utc::now().to_rfc3339();

    // Cascade: if complete, wipe completion data first so the deal re-opens
    if df.stage == "complete" {
        clear_completion(&df, &id, &now)?;
    }

    let mut payments = df.supplier_payments.clone();
    let p = payments.iter_mut().find(|p| p.id == payment_id).ok_or("Payment not found")?;
    p.paid = false;
    p.paid_at = None;

    write_sp(&id, &payments, &df.invoice_id)?;

    // If we came from supplier_paid or complete, step back to payment_received
    if df.stage == "supplier_paid" || df.stage == "complete" {
        let mut cols = Map::new();
        cols.insert("stage".into(), Value::String("payment_received".into()));
        cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET stage='payment_received', updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
        sync_invoice_stage(&df.invoice_id, "payment_received")?;
    }

    Ok(())
}

#[tauri::command]
pub async fn complete_deal_flow(id: String, shipping_status: Option<String>, completed_date: Option<String>) -> Result<Value, String> {
    let df = read_df(&id)?;
    if df.stage != "supplier_paid" && df.stage != "payment_received" { return Err("Can only complete after payment is received".into()); }

    let split = read_profit_split()?;

    // Use caller-supplied date (YYYY-MM-DD) if provided; otherwise use now.
    let now = match completed_date.as_deref() {
        Some(d) if !d.is_empty() => format!("{}T00:00:00Z", d),
        _ => Utc::now().to_rfc3339(),
    };
    let gross = df.payment_received_amount;
    let total_cost = df.total_supplier_cost;
    let net = gross - total_cost;
    let is_loss = net < 0.0;
    let jack = (net * (split.jack_pct / 100.0) * 100.0).round() / 100.0;
    let ben = (net * (split.ben_pct / 100.0) * 100.0).round() / 100.0;
    let business = (net * (split.business_pct / 100.0) * 100.0).round() / 100.0;

    let shipping_status = shipping_status.unwrap_or_else(|| "none".into());
    let awaiting_shipping = shipping_status == "awaiting";
    let meta_json = serde_json::to_string(&json!({"is_loss": is_loss, "shipping_status": shipping_status})).map_err(|e| e.to_string())?;

    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("complete".into()));
    cols.insert("completed_at".into(), Value::String(now.clone()));
    cols.insert("gross_revenue".into(), json!(gross));
    cols.insert("total_cost".into(), json!(total_cost));
    cols.insert("net_profit".into(), json!(net));
    cols.insert("profit_jack".into(), json!(jack));
    cols.insert("profit_ben".into(), json!(ben));
    cols.insert("profit_business".into(), json!(business));
    cols.insert("metadata".into(), Value::String(meta_json.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET stage='complete', completed_at=?1, gross_revenue=?2, total_cost=?3, net_profit=?4, profit_jack=?5, profit_ben=?6, profit_business=?7, metadata=?8, updated_at=?1 WHERE id=?9",
            rusqlite::params![now, gross, total_cost, net, jack, ben, business, meta_json, id],
        ).map_err(|e| e.to_string())?;
    }

    sync_invoice_stage(&df.invoice_id, "complete")?;
    let margin_pct = if gross > 0.0 { (net / gross) * 100.0 } else { 0.0 };
    let mut inv_cols = Map::new();
    inv_cols.insert("status".into(), Value::String("paid".into()));
    inv_cols.insert("is_complete".into(), json!(!awaiting_shipping));
    // Write profit data back to the invoice so dashboard/analytics queries see it
    inv_cols.insert("profit".into(), json!(net));
    inv_cols.insert("total_cost".into(), json!(total_cost));
    inv_cols.insert("margin".into(), json!(margin_pct));
    sync::record_upsert("invoices", &df.invoice_id, inv_cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET status='paid', is_complete=?1, profit=?2, total_cost=?3, margin=?4 WHERE id=?5",
        rusqlite::params![(!awaiting_shipping) as i64, net, total_cost, margin_pct, df.invoice_id],
    ).map_err(|e| e.to_string())?;
    // Auto-mark linked inventory lot as Sold (best-effort)
    if let Err(e) = conn.execute(
        "UPDATE inventory SET status='sold' WHERE linked_deal_id = (SELECT d.id FROM deals d WHERE d.converted_invoice_id = ?1) AND status='reserved'",
        [&df.invoice_id],
    ) {
        tracing::warn!("auto-mark inventory sold failed: {}", e);
    }
    let warning = if is_loss { Some(format!("This deal resulted in a loss of ${:.2}", net.abs())) } else { None };
    Ok(json!({ "profit": net, "is_loss": is_loss, "warning": warning }))
}

#[tauri::command]
pub async fn uncomplete_deal_flow(id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "complete" { return Ok(()); } // Already not complete — nothing to undo

    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("supplier_paid".into()));
    cols.insert("completed_at".into(), Value::Null);
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET stage='supplier_paid', completed_at=NULL, updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    }

    sync_invoice_stage(&df.invoice_id, "supplier_paid")?;

    // Critical: clear is_complete and profit data so the invoice reappears in Deal Flow
    {
        let mut inv_cols = Map::new();
        inv_cols.insert("is_complete".into(), json!(false));
        inv_cols.insert("profit".into(), Value::Null);
        inv_cols.insert("total_cost".into(), Value::Null);
        inv_cols.insert("margin".into(), Value::Null);
        sync::record_upsert("invoices", &df.invoice_id, inv_cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE invoices SET is_complete=0, profit=NULL, total_cost=NULL, margin=NULL WHERE id=?1",
            rusqlite::params![df.invoice_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Update the completed_at date on an already-completed deal flow.
/// `date` is a YYYY-MM-DD string supplied by the user.
#[tauri::command]
pub async fn update_deal_completed_at(id: String, date: String) -> Result<(), String> {
    if date.is_empty() { return Err("Date cannot be empty".into()); }
    let completed_at = format!("{}T00:00:00Z", date);
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("completed_at".into(), Value::String(completed_at.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE deal_flows SET completed_at=?1, updated_at=?2 WHERE id=?3",
        rusqlite::params![completed_at, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_deal_flow_notes(id: String, notes: Option<String>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("notes".into(), to_value(notes.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET notes=?1, updated_at=?2 WHERE id=?3", rusqlite::params![notes, now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_deal_flow_name(id: String, name: Option<String>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("name".into(), to_value(name.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET name=?1, updated_at=?2 WHERE id=?3", rusqlite::params![name, now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_deal_flow(id: String) -> Result<(), String> {
    let invoice_id: String = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT invoice_id FROM deal_flows WHERE id=?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?
    };

    sync::record_delete("deal_flows", &id).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM deal_flows WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }

    let mut inv_cols = Map::new();
    inv_cols.insert("deal_flow_id".into(), Value::Null);
    inv_cols.insert("deal_flow_stage".into(), Value::String("none".into()));
    sync::record_upsert("invoices", &invoice_id, inv_cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE invoices SET deal_flow_id=NULL, deal_flow_stage='none' WHERE id=?1", [&invoice_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Suppliers (synced table)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Supplier {
    pub id: String,
    pub name: String,
    pub contact_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
    pub payment_terms: Option<String>,
    pub typical_lead_time: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub total_paid: f64,
    pub deal_count: u32,
    pub last_deal_date: Option<String>,
    pub avg_deal_amount: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupplierInput {
    pub name: String,
    pub contact_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
    pub payment_terms: Option<String>,
    pub typical_lead_time: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupplierPriceEntry {
    pub id: String,
    pub supplier_id: String,
    pub item_description: String,
    pub price: f64,
    pub quantity: Option<i32>,
    pub recorded_at: String,
    pub deal_flow_id: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PriceAlert {
    pub supplier_id: String,
    pub supplier_name: String,
    pub item_description: String,
    pub previous_price: f64,
    pub current_price: f64,
    pub change_pct: f64,
    pub deal_flow_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SupplierNode {
    pub supplier_payment_id: String,
    pub supplier_id: Option<String>,
    pub supplier_name: String,
    pub amount: f64,
    pub original_amount: Option<f64>,
    pub price_changed: bool,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    pub paid: bool,
    pub paid_at: Option<String>,
    pub method: Option<String>,
    pub notes: Option<String>,
    pub supplier_contact: Option<String>,
    pub supplier_email: Option<String>,
    pub supplier_phone: Option<String>,
    pub payment_method: Option<String>,
    pub payment_details: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DealFlowNodeMap {
    pub deal_flow_id: String,
    pub invoice_number: String,
    pub client_name: String,
    pub client_email: Option<String>,
    pub invoice_total: f64,
    pub stage: String,
    pub payment_received: Option<f64>,
    pub supplier_nodes: Vec<SupplierNode>,
    pub net_profit: f64,
    pub profit_jack: f64,
    pub profit_ben: f64,
    pub profit_business: f64,
    pub is_loss: bool,
    pub price_alerts: Vec<PriceAlert>,
}

fn map_supplier_row(r: &rusqlite::Row) -> rusqlite::Result<Supplier> {
    Ok(Supplier {
        id: r.get("id")?,
        name: r.get("name")?,
        contact_name: r.get("contact_name")?,
        email: r.get("email")?,
        phone: r.get("phone")?,
        address: r.get("address")?,
        payment_method: r.get("payment_method")?,
        payment_details: r.get("payment_details")?,
        payment_terms: r.get("payment_terms")?,
        typical_lead_time: r.get("typical_lead_time")?,
        notes: r.get("notes")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        archived: r.get::<_, i64>("archived").unwrap_or(0) != 0,
        total_paid: r.get("total_paid").unwrap_or(0.0),
        deal_count: r.get::<_, i64>("deal_count").unwrap_or(0) as u32,
        last_deal_date: r.get("last_deal_date").ok(),
        avg_deal_amount: r.get("avg_deal_amount").unwrap_or(0.0),
    })
}

#[tauri::command]
pub async fn list_suppliers() -> Result<Vec<Supplier>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.contact_name, s.email, s.phone, s.address,
                s.payment_method, s.payment_details, s.payment_terms, s.typical_lead_time,
                s.notes, s.created_at, s.updated_at, COALESCE(s.archived, 0) as archived,
                COALESCE(stats.total_paid, 0.0) as total_paid,
                COALESCE(stats.deal_count, 0) as deal_count,
                stats.last_deal_date,
                COALESCE(stats.avg_deal_amount, 0.0) as avg_deal_amount
         FROM suppliers s
         LEFT JOIN (
             SELECT json_extract(sp.value, '$.supplier_id') as sup_id,
                    SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)) as total_paid,
                    COUNT(DISTINCT df.id) as deal_count,
                    MAX(df.completed_at) as last_deal_date,
                    SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)) / COUNT(DISTINCT df.id) as avg_deal_amount
             FROM deal_flows df, json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             WHERE df.stage='complete' AND json_extract(sp.value, '$.supplier_id') IS NOT NULL
             GROUP BY json_extract(sp.value, '$.supplier_id')
         ) stats ON stats.sup_id = s.id
         ORDER BY s.name"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_supplier_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_supplier(id: String) -> Result<Supplier, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT s.id, s.name, s.contact_name, s.email, s.phone, s.address,
                s.payment_method, s.payment_details, s.payment_terms, s.typical_lead_time,
                s.notes, s.created_at, s.updated_at, COALESCE(s.archived, 0) as archived,
                COALESCE(stats.total_paid, 0.0) as total_paid,
                COALESCE(stats.deal_count, 0) as deal_count,
                stats.last_deal_date,
                COALESCE(stats.avg_deal_amount, 0.0) as avg_deal_amount
         FROM suppliers s
         LEFT JOIN (
             SELECT json_extract(sp.value, '$.supplier_id') as sup_id,
                    SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)) as total_paid,
                    COUNT(DISTINCT df.id) as deal_count,
                    MAX(df.completed_at) as last_deal_date,
                    SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)) / COUNT(DISTINCT df.id) as avg_deal_amount
             FROM deal_flows df, json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             WHERE df.stage='complete' AND json_extract(sp.value, '$.supplier_id') IS NOT NULL
             GROUP BY json_extract(sp.value, '$.supplier_id')
         ) stats ON stats.sup_id = s.id
         WHERE s.id=?1",
        [&id], map_supplier_row,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_supplier(input: SupplierInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("contact_name".into(), to_value(input.contact_name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("address".into(), to_value(input.address.clone()));
    cols.insert("payment_method".into(), to_value(input.payment_method.clone()));
    cols.insert("payment_details".into(), to_value(input.payment_details.clone()));
    cols.insert("payment_terms".into(), to_value(input.payment_terms.clone()));
    cols.insert("typical_lead_time".into(), to_value(input.typical_lead_time.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("suppliers", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO suppliers (id,name,contact_name,email,phone,address,payment_method,payment_details,payment_terms,typical_lead_time,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)",
        rusqlite::params![id, input.name, input.contact_name, input.email, input.phone, input.address, input.payment_method, input.payment_details, input.payment_terms, input.typical_lead_time, input.notes, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_supplier(id: String, input: SupplierInput) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("name".into(), Value::String(input.name.clone()));
    cols.insert("contact_name".into(), to_value(input.contact_name.clone()));
    cols.insert("email".into(), to_value(input.email.clone()));
    cols.insert("phone".into(), to_value(input.phone.clone()));
    cols.insert("address".into(), to_value(input.address.clone()));
    cols.insert("payment_method".into(), to_value(input.payment_method.clone()));
    cols.insert("payment_details".into(), to_value(input.payment_details.clone()));
    cols.insert("payment_terms".into(), to_value(input.payment_terms.clone()));
    cols.insert("typical_lead_time".into(), to_value(input.typical_lead_time.clone()));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("suppliers", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE suppliers SET name=?1,contact_name=?2,email=?3,phone=?4,address=?5,payment_method=?6,payment_details=?7,payment_terms=?8,typical_lead_time=?9,notes=?10,updated_at=?11 WHERE id=?12",
        rusqlite::params![input.name, input.contact_name, input.email, input.phone, input.address, input.payment_method, input.payment_details, input.payment_terms, input.typical_lead_time, input.notes, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn archive_supplier(id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("archived".into(), json!(1));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("suppliers", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE suppliers SET archived=1, updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_supplier(id: String) -> Result<(), String> {
    sync::record_delete("suppliers", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM suppliers WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn search_suppliers(query: String) -> Result<Vec<Supplier>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pattern = format!("%{}%", query);
    let mut stmt = conn.prepare(
        "SELECT s.*, 0.0 as total_paid, 0 as deal_count, NULL as last_deal_date, 0.0 as avg_deal_amount FROM suppliers s WHERE s.name LIKE ?1 AND s.archived=0 ORDER BY s.name LIMIT 20"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&pattern], map_supplier_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_supplier_price_history(supplier_id: String) -> Result<Vec<SupplierPriceEntry>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, supplier_id, item_description, price, quantity, recorded_at, deal_flow_id, notes FROM supplier_price_history WHERE supplier_id=?1 ORDER BY recorded_at DESC LIMIT 50"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&supplier_id], |r| Ok(SupplierPriceEntry {
        id: r.get(0)?, supplier_id: r.get(1)?, item_description: r.get(2)?, price: r.get(3)?,
        quantity: r.get(4)?, recorded_at: r.get(5)?, deal_flow_id: r.get(6)?, notes: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn record_supplier_price(
    supplier_id: String,
    item_description: String,
    price: f64,
    quantity: Option<i32>,
    deal_flow_id: Option<String>,
    notes: Option<String>,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO supplier_price_history (id, supplier_id, item_description, price, quantity, recorded_at, deal_flow_id, notes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![id, supplier_id, item_description, price, quantity, now, deal_flow_id, notes],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn check_price_changes(deal_flow_id: String) -> Result<Vec<PriceAlert>, String> {
    let df = read_df(&deal_flow_id)?;
    let mut alerts: Vec<PriceAlert> = Vec::new();
    for sp in &df.supplier_payments {
        if sp.supplier_id.is_none() || sp.unit_price.is_none() { continue; }
        let sid = sp.supplier_id.as_ref().unwrap();
        let item = format!("{}", sp.supplier_name);
        let conn = pool().get().map_err(|e| e.to_string())?;
        let last_price: Option<f64> = conn.query_row(
            "SELECT price FROM supplier_price_history WHERE supplier_id=?1 ORDER BY recorded_at DESC LIMIT 1",
            [sid], |r| r.get(0),
        ).ok();
        if let Some(prev) = last_price {
            let unit = sp.unit_price.unwrap_or(sp.amount);
            let pct = ((unit - prev) / prev.abs()) * 100.0;
            if pct.abs() > 5.0 {
                alerts.push(PriceAlert {
                    supplier_id: sid.clone(), supplier_name: sp.supplier_name.clone(),
                    item_description: item, previous_price: prev, current_price: unit,
                    change_pct: pct, deal_flow_id: deal_flow_id.clone(),
                });
            }
        }
    }
    Ok(alerts)
}

#[tauri::command]
pub async fn get_deal_flow_node_map(deal_flow_id: String) -> Result<DealFlowNodeMap, String> {
    let df = read_df(&deal_flow_id)?;
    let mut supplier_nodes: Vec<SupplierNode> = Vec::new();
    let conn = pool().get().map_err(|e| e.to_string())?;

    for sp in &df.supplier_payments {
        let mut node = SupplierNode {
            supplier_payment_id: sp.id.clone(),
            supplier_id: sp.supplier_id.clone(),
            supplier_name: sp.supplier_name.clone(),
            amount: sp.amount,
            original_amount: sp.original_amount,
            price_changed: sp.price_changed,
            quantity: sp.quantity,
            unit_price: sp.unit_price,
            paid: sp.paid,
            paid_at: sp.paid_at.clone(),
            method: sp.method.clone(),
            notes: sp.notes.clone(),
            supplier_contact: None,
            supplier_email: None,
            supplier_phone: None,
            payment_method: None,
            payment_details: None,
        };
        if let Some(ref sid) = sp.supplier_id {
            if let Ok(()) = conn.query_row(
                "SELECT contact_name, email, phone, payment_method, payment_details FROM suppliers WHERE id=?1",
                [sid], |r| {
                    node.supplier_contact = r.get(0)?;
                    node.supplier_email = r.get(1)?;
                    node.supplier_phone = r.get(2)?;
                    node.payment_method = r.get(3)?;
                    node.payment_details = r.get(4)?;
                    Ok(())
                },
            ) {}
        }
        supplier_nodes.push(node);
    }

    let alerts = check_price_changes(deal_flow_id.clone()).await.unwrap_or_default();
    let is_loss = df.net_profit < 0.0;

    Ok(DealFlowNodeMap {
        deal_flow_id: df.id,
        invoice_number: df.invoice_number.unwrap_or_default(),
        client_name: df.client_name.unwrap_or_default(),
        client_email: None,
        invoice_total: df.invoice_total,
        stage: df.stage,
        payment_received: Some(df.payment_received_amount),
        supplier_nodes,
        net_profit: df.net_profit,
        profit_jack: df.profit_jack,
        profit_ben: df.profit_ben,
        profit_business: df.profit_business,
        is_loss,
        price_alerts: alerts,
    })
}

// ============================================================
//  Profit Split Settings (synced via settings table)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProfitSplit {
    pub business_pct: f64,
    pub jack_pct: f64,
    pub ben_pct: f64,
    pub jack_name: String,
    pub ben_name: String,
}

fn read_profit_split() -> Result<ProfitSplit, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let get = |key: &str, default: &str| -> String {
        conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_,String>(0)).unwrap_or_else(|_| default.to_string())
    };
    Ok(ProfitSplit {
        business_pct: get("profit_split_business", "40").parse::<f64>().unwrap_or(40.0),
        jack_pct: get("profit_split_jack", "30").parse::<f64>().unwrap_or(30.0),
        ben_pct: get("profit_split_ben", "30").parse::<f64>().unwrap_or(30.0),
        jack_name: get("profit_split_jack_name", "Jack"),
        ben_name: get("profit_split_ben_name", "Ben"),
    })
}

#[tauri::command]
pub async fn get_profit_split() -> Result<ProfitSplit, String> {
    read_profit_split()
}

#[tauri::command]
pub async fn save_profit_split(
    business_pct: f64,
    jack_pct: f64,
    ben_pct: f64,
    jack_name: String,
    ben_name: String,
) -> Result<(), String> {
    let total = business_pct + jack_pct + ben_pct;
    if (total - 100.0).abs() > 0.01 {
        return Err(format!("Percentages must sum to 100% (currently {:.1}%)", total));
    }
    if jack_name.trim().is_empty() || ben_name.trim().is_empty() {
        return Err("Partner names cannot be empty".into());
    }

    let pairs: &[(&str, &str)] = &[
        ("profit_split_business", &format!("{}", business_pct)),
        ("profit_split_jack", &format!("{}", jack_pct)),
        ("profit_split_ben", &format!("{}", ben_pct)),
        ("profit_split_jack_name", &jack_name),
        ("profit_split_ben_name", &ben_name),
    ];

    for (key, val) in pairs {
        let mut cols = Map::new();
        cols.insert("key".into(), Value::String(key.to_string()));
        cols.insert("value".into(), Value::String(val.to_string()));
        sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, val],
        ).map_err(|e| e.to_string())?;
    }

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
pub async fn ai_draft_reply(email_body: String, context: Option<String>, tone: Option<String>) -> Result<String, String> {
    crate::ai::draft_reply_with_tone(&email_body, context.as_deref(), &tone.unwrap_or_else(|| "neutral".into()))
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
                "SELECT COALESCE(subject,'') || ': ' || COALESCE(body,'') FROM interactions
                 WHERE client_id=?1 AND (subject IS NOT NULL OR body IS NOT NULL)
                 ORDER BY created_at DESC LIMIT 20",
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

#[tauri::command]
pub async fn get_onboarding_status() -> Result<bool, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='onboarding_completed'", [], |r| r.get(0))
        .ok();
    Ok(val.as_deref() == Some("true") || {
        let cc: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap_or(0);
        if cc > 0 {
            let _ = conn.execute(
                "INSERT INTO settings (key,value) VALUES ('onboarding_completed','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [],
            );
            true
        } else { false }
    })
}

#[tauri::command]
pub async fn complete_onboarding() -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('onboarding_completed','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Auto-Backup
// ============================================================

fn backup_dir_setting() -> Result<std::path::PathBuf, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let custom: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='backup_dir'", [], |r| r.get(0))
        .ok();
    let dir = match custom {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => dirs::document_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join("ClientHub Backups"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("create backup dir: {}", e))?;
    Ok(dir)
}

#[tauri::command]
pub async fn backup_database(custom_dir: Option<String>) -> Result<String, String> {
    let dir = match custom_dir {
        Some(d) if !d.is_empty() => {
            let p = std::path::PathBuf::from(&d);
            std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("INSERT INTO settings (key,value) VALUES ('backup_dir',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&d]).map_err(|e| e.to_string())?;
            p
        }
        _ => backup_dir_setting()?,
    };

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let filename = format!("clienthub-backup-{}.db", today);
    let dest = dir.join(&filename);

    if !dest.exists() {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|e| format!("checkpoint: {}", e))?;
        let db_path = crate::db::app_data_dir().join("clienthub.db");
        std::fs::copy(&db_path, &dest).map_err(|e| format!("copy: {}", e))?;
    }

    let now_iso = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('last_backup',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&now_iso]).map_err(|e| e.to_string())?;

    // Cleanup: delete backups older than 30 days matching exact pattern
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let cutoff = chrono::Local::now() - chrono::Duration::days(30);
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("clienthub-backup-") && name.ends_with(".db") && name.len() == 33 {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&name[18..28], "%Y-%m-%d") {
                    if date.and_hms_opt(0, 0, 0).unwrap() < cutoff.naive_local() {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
pub struct BackupEntry {
    pub filename: String,
    pub size: u64,
    pub date: String,
}

#[tauri::command]
pub async fn list_backups() -> Result<Vec<BackupEntry>, String> {
    let dir = backup_dir_setting()?;
    let mut entries = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("clienthub-backup-") && name.ends_with(".db") && name.len() == 33 {
            if let Ok(meta) = entry.metadata() {
                let date = name[18..28].to_string();
                entries.push(BackupEntry { filename: name, size: meta.len(), date });
            }
        }
    }
    entries.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(entries)
}

#[tauri::command]
pub async fn restore_database(path: String) -> Result<(), String> {
    let src = std::path::Path::new(&path);
    if !src.exists() { return Err("Backup file not found".into()); }
    let staging = crate::db::app_data_dir().join("clienthub.db.pending_restore");
    std::fs::copy(src, &staging).map_err(|e| format!("stage restore: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_backup_status() -> Result<serde_json::Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let last: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='last_backup'", [], |r| r.get(0)).ok();
    let dir: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='backup_dir'", [], |r| r.get(0)).ok();
    let dir = dir.unwrap_or_else(|| {
        dirs::document_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join("ClientHub Backups").to_string_lossy().to_string()
    });
    Ok(serde_json::json!({ "last_backup": last, "backup_dir": dir }))
}

// ============================================================
//  Multi-User / Roles
// ============================================================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
    pub invite_code: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_users() -> Result<Vec<User>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, name, email, role, invite_code, is_active, created_at FROM users ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(User {
        id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, role: r.get(3)?,
        invite_code: r.get(4)?, is_active: r.get::<_, i64>(5)? != 0, created_at: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_owner_user(name: String, email: String) -> Result<User, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO users (id, name, email, role, is_active, created_at) VALUES (?1, ?2, ?3, 'owner', 1, ?4)",
        rusqlite::params![id, name, email, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('current_user_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [&id],
    ).map_err(|e| e.to_string())?;
    Ok(User { id, name, email, role: "owner".into(), invite_code: None, is_active: true, created_at: now })
}

#[tauri::command]
pub async fn invite_user(name: String, email: String, role: String) -> Result<User, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let valid = ["owner", "sales_rep", "viewer"];
    if !valid.contains(&role.as_str()) { return Err("Invalid role".into()); }
    let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO users (id, name, email, role, invite_code, is_active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
        rusqlite::params![id, name, email, role, code, now],
    ).map_err(|e| e.to_string())?;
    let cols = {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), serde_json::Value::String(name.clone()));
        m.insert("email".into(), serde_json::Value::String(email.clone()));
        m.insert("role".into(), serde_json::Value::String(role.clone()));
        m.insert("invite_code".into(), serde_json::Value::String(code.clone()));
        m.insert("is_active".into(), serde_json::Value::Bool(true));
        m.insert("created_at".into(), serde_json::Value::String(now.clone()));
        m
    };
    crate::sync::record_upsert("users", &id, cols).map_err(|e| e.to_string())?;
    Ok(User { id, name, email, role, invite_code: Some(code), is_active: true, created_at: now })
}

#[tauri::command]
pub async fn claim_invite(code: String) -> Result<User, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let user: Option<User> = conn.query_row(
        "SELECT id, name, email, role, invite_code, is_active, created_at FROM users WHERE invite_code = ?1 AND is_active = 1",
        [&code], |r| Ok(User {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, role: r.get(3)?,
            invite_code: r.get(4)?, is_active: r.get::<_, i64>(5)? != 0, created_at: r.get(6)?,
        }),
    ).ok();
    let user = user.ok_or("Invalid or already claimed invite code")?;
    conn.execute("UPDATE users SET invite_code = NULL WHERE id = ?1", [&user.id]).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('current_user_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [&user.id],
    ).map_err(|e| e.to_string())?;
    let cols = {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), serde_json::Value::String(user.name.clone()));
        m.insert("email".into(), serde_json::Value::String(user.email.clone()));
        m.insert("role".into(), serde_json::Value::String(user.role.clone()));
        m.insert("is_active".into(), serde_json::Value::Bool(true));
        m.insert("created_at".into(), serde_json::Value::String(user.created_at.clone()));
        crate::sync::record_upsert("users", &user.id, m).map_err(|e| e.to_string())?;
    };
    Ok(User { id: user.id, name: user.name, email: user.email, role: user.role, invite_code: None, is_active: user.is_active, created_at: user.created_at })
}

#[tauri::command]
pub async fn remove_user(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    let cols = {
        let existing: Option<User> = conn.query_row(
            "SELECT id, name, email, role, invite_code, is_active, created_at FROM users WHERE id = ?1",
            [&id], |r| Ok(User {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, role: r.get(3)?,
                invite_code: r.get(4)?, is_active: r.get::<_, i64>(5)? != 0, created_at: r.get(6)?,
            }),
        ).ok();
        if let Some(u) = existing {
            let mut m = serde_json::Map::new();
            m.insert("name".into(), serde_json::Value::String(u.name));
            m.insert("email".into(), serde_json::Value::String(u.email));
            m.insert("role".into(), serde_json::Value::String(u.role));
            m.insert("is_active".into(), serde_json::Value::Bool(false));
            m.insert("created_at".into(), serde_json::Value::String(u.created_at));
            crate::sync::record_upsert("users", &id, m).map_err(|e| e.to_string())?;
        }
    };
    Ok(())
}

#[tauri::command]
pub async fn update_user_role(id: String, role: String) -> Result<(), String> {
    let valid = ["owner", "sales_rep", "viewer"];
    if !valid.contains(&role.as_str()) { return Err("Invalid role".into()); }
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE users SET role = ?1 WHERE id = ?2", rusqlite::params![role, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_current_user() -> Result<Option<User>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let uid: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='current_user_id'", [], |r| r.get(0)).ok();
    let uid = match uid {
        Some(id) => id,
        None => {
            let users: Vec<User> = conn.prepare("SELECT id, name, email, role, invite_code, is_active, created_at FROM users WHERE is_active = 1 ORDER BY created_at")
                .map_err(|e| e.to_string())?
                .query_map([], |r| Ok(User {
                    id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, role: r.get(3)?,
                    invite_code: r.get(4)?, is_active: r.get::<_, i64>(5)? != 0, created_at: r.get(6)?,
                })).map_err(|e| e.to_string())?
                .filter_map(|r| r.ok()).collect();
            if users.len() == 1 {
                conn.execute("INSERT INTO settings (key,value) VALUES ('current_user_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&users[0].id]).map_err(|e| e.to_string())?;
                return Ok(Some(users.into_iter().next().unwrap()));
            }
            // Existing installs: no user record yet but has client data → auto-create Owner
            if users.is_empty() {
                let has_clients: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap_or(0);
                if has_clients > 0 {
                    let name = conn.query_row::<String, _, _>("SELECT value FROM settings WHERE key='company_info'", [], |r| r.get(0)).ok()
                        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                        .and_then(|ci| ci.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                        .unwrap_or_else(|| "Owner".to_string());
                    let email = String::new();
                    let id = uuid::Uuid::new_v4().to_string();
                    let now = chrono::Utc::now().to_rfc3339();
                    conn.execute("INSERT INTO users (id, name, email, role, is_active, created_at) VALUES (?1, ?2, ?3, 'owner', 1, ?4)", rusqlite::params![id, name, email, now]).map_err(|e| e.to_string())?;
                    conn.execute("INSERT INTO settings (key,value) VALUES ('current_user_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&id]).map_err(|e| e.to_string())?;
                    return Ok(Some(User { id, name, email, role: "owner".into(), invite_code: None, is_active: true, created_at: now }));
                }
            }
            return Ok(None);
        }
    };
    let user = conn.query_row(
        "SELECT id, name, email, role, invite_code, is_active, created_at FROM users WHERE id = ?1",
        [&uid], |r| Ok(User {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, role: r.get(3)?,
            invite_code: r.get(4)?, is_active: r.get::<_, i64>(5)? != 0, created_at: r.get(6)?,
        }),
    ).ok();
    Ok(user)
}

#[tauri::command]
pub async fn set_current_user(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('current_user_id',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Inventory / Lots Board
// ============================================================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct InventoryLot {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub quantity: i64,
    pub total_cost: f64,
    pub asking_price: f64,
    pub status: String,
    pub linked_deal_id: Option<String>,
    pub photos_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn list_inventory(status: Option<String>) -> Result<Vec<InventoryLot>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, params): (String, Vec<String>) = match &status {
        Some(s) => ("SELECT * FROM inventory WHERE status = ?1 ORDER BY created_at DESC".into(), vec![s.clone()]),
        None => ("SELECT * FROM inventory ORDER BY created_at DESC".into(), vec![]),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| Ok(InventoryLot {
        id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, category: r.get(3)?,
        quantity: r.get(4)?, total_cost: r.get(5)?, asking_price: r.get(6)?,
        status: r.get(7)?, linked_deal_id: r.get(8)?, photos_json: r.get(9)?,
        created_at: r.get(10)?, updated_at: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_lot(name: String, quantity: i64, total_cost: f64, asking_price: f64, description: Option<String>, category: Option<String>, photos: Option<Vec<String>>) -> Result<InventoryLot, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let photos_json = serde_json::to_string(&photos.unwrap_or_default()).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO inventory (id,name,description,category,quantity,total_cost,asking_price,status,photos_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'available',?8,?9,?9)",
        rusqlite::params![id, name, description, category, quantity, total_cost, asking_price, photos_json, now],
    ).map_err(|e| e.to_string())?;
    Ok(InventoryLot { id, name, description, category, quantity, total_cost, asking_price, status: "available".into(), linked_deal_id: None, photos_json, created_at: now.clone(), updated_at: now })
}

#[tauri::command]
pub async fn update_lot(id: String, name: Option<String>, description: Option<String>, category: Option<String>, quantity: Option<i64>, total_cost: Option<f64>, asking_price: Option<f64>, photos: Option<Vec<String>>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
    if let Some(v) = name { sets.push("name = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = description { sets.push("description = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = category { sets.push("category = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = quantity { sets.push("quantity = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = total_cost { sets.push("total_cost = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = asking_price { sets.push("asking_price = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = photos { sets.push("photos_json = ?".to_string()); params.push(Box::new(serde_json::to_string(&v).map_err(|e| e.to_string())?)); }
    let sql = format!("UPDATE inventory SET {} WHERE id = ?", sets.join(", "));
    params.push(Box::new(id));
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn archive_lot(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let status: String = conn.query_row("SELECT status FROM inventory WHERE id = ?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if status == "reserved" { return Err("Cannot archive a reserved lot. Remove the deal link first.".into()); }
    conn.execute("UPDATE inventory SET status = 'archived', updated_at = ?1 WHERE id = ?2", rusqlite::params![chrono::Utc::now().to_rfc3339(), id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn link_lot_to_deal(lot_id: String, deal_id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM deals WHERE id = ?1", [&deal_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if exists == 0 { return Err("Deal not found".into()); }
    conn.execute("UPDATE inventory SET linked_deal_id = ?1, status = 'reserved', updated_at = ?2 WHERE id = ?3", rusqlite::params![deal_id, chrono::Utc::now().to_rfc3339(), lot_id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Follow-Up Rules Automation
// ============================================================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FollowUpRule {
    pub id: String,
    pub name: String,
    pub trigger_type: String,
    pub trigger_value: i64,
    pub action_type: String,
    pub email_subject: Option<String>,
    pub email_body: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_followup_rules() -> Result<Vec<FollowUpRule>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,name,trigger_type,trigger_value,action_type,email_subject,email_body,is_active,created_at FROM followup_rules ORDER BY created_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(FollowUpRule {
        id: r.get(0)?, name: r.get(1)?, trigger_type: r.get(2)?, trigger_value: r.get(3)?,
        action_type: r.get(4)?, email_subject: r.get(5)?, email_body: r.get(6)?,
        is_active: r.get::<_,i64>(7)? != 0, created_at: r.get(8)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_followup_rule(name: String, trigger_type: String, trigger_value: i64, action_type: String, email_subject: Option<String>, email_body: Option<String>) -> Result<FollowUpRule, String> {
    let valid_triggers = ["no_order", "no_contact", "overdue_invoice", "stale_deal"];
    let valid_actions = ["email", "reminder", "both"];
    if !valid_triggers.contains(&trigger_type.as_str()) { return Err("Invalid trigger_type".into()); }
    if !valid_actions.contains(&action_type.as_str()) { return Err("Invalid action_type".into()); }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO followup_rules (id,name,trigger_type,trigger_value,action_type,email_subject,email_body,is_active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)",
        rusqlite::params![id, name, trigger_type, trigger_value, action_type, email_subject, email_body, now],
    ).map_err(|e| e.to_string())?;
    Ok(FollowUpRule { id, name, trigger_type, trigger_value, action_type, email_subject, email_body, is_active: true, created_at: now })
}

#[tauri::command]
pub async fn update_followup_rule(id: String, name: Option<String>, trigger_type: Option<String>, trigger_value: Option<i64>, action_type: Option<String>, email_subject: Option<String>, email_body: Option<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut sets = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(v) = name { sets.push("name = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = trigger_type { sets.push("trigger_type = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = trigger_value { sets.push("trigger_value = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = action_type { sets.push("action_type = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = email_subject { sets.push("email_subject = ?".to_string()); params.push(Box::new(v)); }
    if let Some(v) = email_body { sets.push("email_body = ?".to_string()); params.push(Box::new(v)); }
    if sets.is_empty() { return Ok(()); }
    let sql = format!("UPDATE followup_rules SET {} WHERE id = ?", sets.join(", "));
    params.push(Box::new(id));
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_followup_rule(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM followup_log WHERE rule_id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM followup_rules WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_followup_rule(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE followup_rules SET is_active = 1 - is_active WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct FollowUpLogEntry {
    pub id: String,
    pub rule_id: String,
    pub client_id: Option<String>,
    pub triggered_at: String,
    pub action_taken: String,
    pub details: Option<String>,
}

#[tauri::command]
pub async fn process_followup_rules() -> Result<Vec<FollowUpLogEntry>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now();
    let now_str = now.to_rfc3339();

    let rules: Vec<FollowUpRule> = conn.prepare("SELECT id,name,trigger_type,trigger_value,action_type,email_subject,email_body,is_active,created_at FROM followup_rules WHERE is_active=1")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok(FollowUpRule {
            id: r.get(0)?, name: r.get(1)?, trigger_type: r.get(2)?, trigger_value: r.get(3)?,
            action_type: r.get(4)?, email_subject: r.get(5)?, email_body: r.get(6)?,
            is_active: r.get::<_,i64>(7)? != 0, created_at: r.get(8)?,
        })).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok()).collect();

    let mut log_entries: Vec<FollowUpLogEntry> = Vec::new();

    for rule in &rules {
        let cutoff = (now - chrono::Duration::days(rule.trigger_value)).to_rfc3339();

        let matched: Vec<(String, Option<String>, Option<String>, Option<String>)> = match rule.trigger_type.as_str() {
            "no_order" => {
                let sql = "SELECT c.id, c.name, c.email, MAX(i.issue_date) as last_order FROM clients c LEFT JOIN invoices i ON i.client_id=c.id GROUP BY c.id HAVING last_order IS NULL OR last_order < ?1";
                conn.prepare(sql).map_err(|e| e.to_string())?
                    .query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_,Option<String>>(3).ok().flatten())))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok()).collect()
            }
            "no_contact" => {
                let sql = "SELECT c.id, c.name, c.email, ic.mc FROM clients c LEFT JOIN (SELECT client_id, MAX(created_at) as mc FROM interactions GROUP BY client_id) ic ON ic.client_id=c.id WHERE ic.mc IS NULL OR ic.mc < ?1";
                conn.prepare(sql).map_err(|e| e.to_string())?
                    .query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_,Option<String>>(3).ok().flatten())))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok()).collect()
            }
            "overdue_invoice" => {
                let sql = "SELECT c.id, c.name, c.email, i.due_date FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status='overdue' AND i.due_date < ?1 GROUP BY c.id";
                conn.prepare(sql).map_err(|e| e.to_string())?
                    .query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_,Option<String>>(3).ok().flatten())))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok()).collect()
            }
            "stale_deal" => {
                let sql = "SELECT c.id, c.name, c.email, d.updated_at FROM deals d JOIN clients c ON c.id=d.client_id WHERE d.stage NOT IN ('won','lost') AND d.updated_at < ?1 GROUP BY c.id";
                conn.prepare(sql).map_err(|e| e.to_string())?
                    .query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_,Option<String>>(3).ok().flatten())))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok()).collect()
            }
            _ => Vec::new(),
        };

        for (client_id, client_name, client_email, _) in &matched {
            let already_done: i64 = conn.query_row(
                "SELECT COUNT(*) FROM followup_log WHERE rule_id=?1 AND client_id=?2 AND triggered_at > ?3",
                rusqlite::params![rule.id, client_id, cutoff],
                |r| r.get(0),
            ).unwrap_or(0);
            if already_done > 0 { continue; }

            let should_email = rule.action_type == "email" || rule.action_type == "both";
            let should_remind = rule.action_type == "reminder" || rule.action_type == "both";

            let mut details_bits: Vec<String> = Vec::new();

            if should_email {
                let subject = rule.email_subject.clone().unwrap_or_else(|| "Follow-up".into());
                let body = rule.email_body.clone().unwrap_or_default().replace("{client_name}", client_name.as_ref().unwrap_or(&String::new()));
                match crate::email::send(client_email.as_ref().unwrap_or(&String::new()), &subject, &body, None).await {
                    Ok(()) => { details_bits.push("email sent".into()); }
                    Err(e) => { details_bits.push(format!("SMTP error: {}", e)); }
                }
            }

            if should_remind {
                let iid = uuid::Uuid::new_v4().to_string();
                if let Err(e) = conn.execute(
                    "INSERT INTO interactions (id,client_id,kind,subject,body,created_at) VALUES (?1,?2,'reminder','Automated follow-up',?3,?4)",
                    rusqlite::params![iid, client_id, format!("Rule: {}", rule.name), now_str],
                ) {
                    details_bits.push(format!("reminder insert failed: {}", e));
                }
                if let Err(e) = conn.execute(
                    "UPDATE clients SET metadata = json_set(COALESCE(metadata,'{}'), '$.next_follow_up_date', json('clear')) WHERE id=?1",
                    [client_id],
                ) {
                    details_bits.push(format!("metadata update failed: {}", e));
                }
            }

            let action_label = if should_email && should_remind { "email+reminder" } else if should_email { "email" } else { "reminder" };
            let log_id = uuid::Uuid::new_v4().to_string();
            let details_str = if details_bits.is_empty() { None } else { Some(details_bits.join("; ")) };
            conn.execute(
                "INSERT INTO followup_log (id,rule_id,client_id,triggered_at,action_taken,details) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![log_id, rule.id, client_id, now_str, action_label, details_str],
            ).map_err(|e| e.to_string())?;
            log_entries.push(FollowUpLogEntry { id: log_id, rule_id: rule.id.clone(), client_id: Some(client_id.clone()), triggered_at: now_str.clone(), action_taken: action_label.into(), details: details_str });
        }
    }

    // Cleanup: delete log entries older than 90 days
    let old_cutoff = (now - chrono::Duration::days(90)).to_rfc3339();
    let _ = conn.execute("DELETE FROM followup_log WHERE triggered_at < ?1", [&old_cutoff]);

    // Record last run time
    conn.execute("INSERT INTO settings (key,value) VALUES ('last_rules_run',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&now_str]).map_err(|e| e.to_string())?;

    Ok(log_entries)
}

#[tauri::command]
pub async fn get_followup_log() -> Result<Vec<FollowUpLogEntry>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id,rule_id,client_id,triggered_at,action_taken,details FROM followup_log ORDER BY triggered_at DESC LIMIT 50").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(FollowUpLogEntry {
        id: r.get(0)?, rule_id: r.get(1)?, client_id: r.get(2)?,
        triggered_at: r.get(3)?, action_taken: r.get(4)?, details: r.get(5)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ============================================================
//  Client Portal Tokens
// ============================================================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct PortalLink {
    pub id: String,
    pub client_id: String,
    pub token: String,
    pub expires_at: String,
    pub is_active: bool,
    pub created_at: String,
    pub client_name: Option<String>,
    pub portal_url: String,
}

fn portal_base_url(conn: &rusqlite::Connection) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key='portal_base_url'", [], |r| r.get::<_, String>(0)).ok()
}

fn build_portal_url(base: Option<String>, token: &str) -> String {
    match base {
        Some(b) if !b.is_empty() => {
            let stripped = b.trim_end_matches('/');
            format!("{}/portal/{}", stripped, token)
        }
        _ => format!("<configure portal URL in Settings>", ),
    }
}

#[tauri::command]
pub async fn get_portal_base_url() -> Result<Option<String>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(portal_base_url(&conn))
}

#[tauri::command]
pub async fn save_portal_base_url(url: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('portal_base_url',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [&url],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn generate_portal_link(client_id: String) -> Result<PortalLink, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let base = portal_base_url(&conn);
    let existing: Option<PortalLink> = conn.query_row(
        "SELECT t.id, t.client_id, t.token, t.expires_at, t.is_active, t.created_at, c.name FROM client_portal_tokens t JOIN clients c ON c.id=t.client_id WHERE t.client_id=?1 AND t.is_active=1 AND t.expires_at > datetime('now') ORDER BY t.created_at DESC LIMIT 1",
        [&client_id], |r| Ok(PortalLink {
            id: r.get(0)?, client_id: r.get(1)?, token: r.get(2)?, expires_at: r.get(3)?,
            is_active: r.get::<_,i64>(4)? != 0, created_at: r.get(5)?, client_name: r.get(6)?,
            portal_url: String::new(),
        }),
    ).ok();
    if let Some(mut link) = existing { link.portal_url = build_portal_url(base, &link.token); return Ok(link); }

    let id = uuid::Uuid::new_v4().to_string();
    let token = uuid::Uuid::new_v4().to_string().replace("-", "");
    let now = chrono::Utc::now().to_rfc3339();
    let expires = (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339();
    let client_name: Option<String> = conn.query_row("SELECT name FROM clients WHERE id=?1", [&client_id], |r| r.get(0)).ok();
    conn.execute(
        "INSERT INTO client_portal_tokens (id,client_id,token,expires_at,is_active,created_at) VALUES (?1,?2,?3,?4,1,?5)",
        rusqlite::params![id, client_id, token, expires, now],
    ).map_err(|e| e.to_string())?;
    let portal_url = build_portal_url(base, &token);
    Ok(PortalLink { id, client_id, token, expires_at: expires, is_active: true, created_at: now, client_name, portal_url })
}

#[tauri::command]
pub async fn revoke_portal_link(token: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let updated = conn.execute("UPDATE client_portal_tokens SET is_active=0 WHERE token=?1", [&token]).map_err(|e| e.to_string())?;
    if updated == 0 { return Err("Token not found".into()); }
    Ok(())
}

#[tauri::command]
pub async fn list_portal_links(client_id: Option<String>) -> Result<Vec<PortalLink>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, params): (String, Vec<String>) = match &client_id {
        Some(cid) => ("SELECT t.id, t.client_id, t.token, t.expires_at, t.is_active, t.created_at, c.name FROM client_portal_tokens t JOIN clients c ON c.id=t.client_id WHERE t.client_id=?1 ORDER BY t.created_at DESC".into(), vec![cid.clone()]),
        None => ("SELECT t.id, t.client_id, t.token, t.expires_at, t.is_active, t.created_at, c.name FROM client_portal_tokens t JOIN clients c ON c.id=t.client_id ORDER BY t.created_at DESC".into(), vec![]),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| Ok(PortalLink {
        id: r.get(0)?, client_id: r.get(1)?, token: r.get(2)?, expires_at: r.get(3)?,
        is_active: r.get::<_,i64>(4)? != 0, created_at: r.get(5)?, client_name: r.get(6)?,
        portal_url: String::new(),
    })).map_err(|e| e.to_string())?;
    let base = portal_base_url(&conn);
    Ok(rows.filter_map(|r| r.ok()).map(|mut l| { l.portal_url = build_portal_url(base.clone(), &l.token); l }).collect())
}

// ============================================================
//  Manifest Analyzer
// ============================================================

#[tauri::command]
pub async fn analyze_manifest(path: String) -> Result<crate::manifest::ManifestAnalysis, String> {
    crate::manifest::analyze(&path).map_err(|e| e.to_string())
}

// ============================================================
//  Profit Forecasting
// ============================================================

#[derive(serde::Serialize)]
pub struct ProfitForecast {
    pub actual_profit_mtd: f64,
    pub projected_profit: f64,
    pub total_forecast: f64,
    pub pipeline_value: f64,
    pub open_deal_count: i64,
    pub overall_win_rate: f64,
    pub win_rate_label: String,
}

#[tauri::command]
pub async fn get_profit_forecast() -> Result<ProfitForecast, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().date_naive();
    let month_start = format!("{}-01", now.format("%Y-%m"));

    let profit_mtd: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1",
        [&month_start], |r| r.get(0),
    ).unwrap_or(0.0);

    let cutoff = (now - chrono::Duration::days(90)).format("%Y-%m-%d").to_string();
    let (total_closed, won_closed): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN stage='won' THEN 1 ELSE 0 END),0) FROM deals WHERE stage IN ('won','lost') AND updated_at >= ?1",
        [&cutoff], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap_or((0, 0));

    let overall_win_rate = if total_closed > 0 {
        won_closed as f64 / total_closed as f64
    } else { 0.40 };
    let win_rate_label = if total_closed == 0 { "default 40% (no closed deals)" } else { "" };

    let open_deals: Vec<(f64, Option<f64>)> = conn.prepare(
        "SELECT d.asking_price, i.margin FROM deals d LEFT JOIN invoices i ON i.id = d.converted_invoice_id WHERE d.stage NOT IN ('won','lost')"
    ).map_err(|e| e.to_string())?
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok()).collect();

    let open_deal_count = open_deals.len() as i64;
    let mut sum_weighted = 0.0;
    let mut pipeline_value = 0.0;
    for (ask, margin) in &open_deals {
        pipeline_value += ask;
        let margin_pct = margin.unwrap_or(30.0) / 100.0;
        sum_weighted += ask * overall_win_rate * margin_pct;
    }

    let projected_profit = sum_weighted * 0.85;
    let total_forecast = profit_mtd + projected_profit;

    Ok(ProfitForecast {
        actual_profit_mtd: profit_mtd,
        projected_profit,
        total_forecast,
        pipeline_value,
        open_deal_count,
        overall_win_rate: (overall_win_rate * 100.0 * 100.0).round() / 100.0,
        win_rate_label: win_rate_label.into(),
    })
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

    let revenue_this_week: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM invoices
             WHERE status='paid' AND paid_at >= date('now', '-7 days')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    let clients_this_week: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM clients WHERE created_at >= date('now', '-7 days')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let interactions_this_week: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM interactions WHERE created_at >= date('now', '-7 days')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_cost: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total_cost),0) FROM invoices WHERE is_complete=1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let total_profit: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(profit),0) FROM invoices WHERE is_complete=1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let avg_margin: f64 = conn
        .query_row(
            "SELECT COALESCE(AVG(CASE WHEN total>0 THEN (profit/total)*100 END),0) FROM invoices WHERE is_complete=1 AND profit IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    let monthly_profit: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m', df.completed_at) as m, COALESCE(SUM(df.gross_revenue),0), COALESCE(SUM(df.total_cost),0), COALESCE(SUM(df.net_profit),0)
             FROM deal_flows df WHERE df.stage='complete' GROUP BY m ORDER BY m"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "month": r.get::<_, String>(0)?,
                "revenue": r.get::<_, f64>(1)?,
                "cost": r.get::<_, f64>(2)?,
                "profit": r.get::<_, f64>(3)?,
            }))
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let top_clients_by_profit: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT c.name, COALESCE(SUM(i.total),0), COALESCE(SUM(i.profit),0),
                    CASE WHEN COALESCE(SUM(i.total),0)>0 THEN (COALESCE(SUM(i.profit),0)/SUM(i.total))*100 ELSE 0 END
             FROM invoices i JOIN clients c ON c.id=i.client_id
             WHERE i.is_complete=1 AND i.profit IS NOT NULL
             GROUP BY i.client_id ORDER BY SUM(i.profit) DESC LIMIT 5"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "total_revenue": r.get::<_, f64>(1)?,
                "total_profit": r.get::<_, f64>(2)?,
                "margin": r.get::<_, f64>(3)?,
            }))
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let pipeline_value: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(asking_price),0) FROM deals WHERE stage NOT IN ('won','lost')",
            [], |r| r.get(0),
        ).unwrap_or(0.0);
    let pipeline_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deals WHERE stage NOT IN ('won','lost')",
            [], |r| r.get(0),
        ).unwrap_or(0);

    let incomplete_shipping: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE status='paid' AND is_complete=0",
            [], |r| r.get(0),
        ).unwrap_or(0);

    let category_breakdown: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(json_extract(metadata,'$.category'),'Uncategorized') as cat,
                    COUNT(*) as cnt,
                    COALESCE(SUM(CASE WHEN i.status='paid' THEN i.total ELSE 0 END),0) as paid_rev
             FROM clients c LEFT JOIN invoices i ON i.client_id=c.id
             GROUP BY cat ORDER BY paid_rev DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "category": r.get::<_,String>(0)?,
            "client_count": r.get::<_,i64>(1)?,
            "revenue": r.get::<_,f64>(2)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let invoice_status_breakdown: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*), COALESCE(SUM(total),0) FROM invoices GROUP BY status"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "status": r.get::<_,String>(0)?,
            "count": r.get::<_,i64>(1)?,
            "total": r.get::<_,f64>(2)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let top_spenders: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT c.name, c.company, COUNT(i.id) as inv_count,
                    COALESCE(SUM(i.total),0) as total_spent,
                    COALESCE(SUM(i.profit),0) as total_profit,
                    MAX(i.issue_date) as last_invoice
             FROM clients c JOIN invoices i ON i.client_id=c.id
             WHERE i.is_complete=1
             GROUP BY i.client_id ORDER BY total_spent DESC LIMIT 10"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "name": r.get::<_,String>(0)?,
            "company": r.get::<_,Option<String>>(1)?,
            "invoice_count": r.get::<_,i64>(2)?,
            "total_spent": r.get::<_,f64>(3)?,
            "total_profit": r.get::<_,f64>(4)?,
            "last_invoice": r.get::<_,Option<String>>(5)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let month_start = format!("{}-01", Utc::now().format("%Y-%m"));

    // MTD revenue and profit (for dashboard month-focus)
    let revenue_mtd: f64 = conn.query_row(
        "SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0.0);
    let profit_mtd: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0.0);
    let deals_mtd: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0);

    // Top suppliers by total paid — payments are stored as JSON in deal_flows
    let top_suppliers: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT json_extract(sp.value, '$.supplier_name') as name,
                    COALESCE(MAX(s.contact_name), '') as contact_name,
                    COUNT(DISTINCT df.id) as deal_count,
                    COALESCE(SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)), 0) as total_paid
             FROM deal_flows df,
                  json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             LEFT JOIN suppliers s ON json_extract(sp.value, '$.supplier_id') = s.id
             WHERE df.stage = 'complete'
               AND json_extract(sp.value, '$.supplier_name') IS NOT NULL
             GROUP BY json_extract(sp.value, '$.supplier_name')
             ORDER BY total_paid DESC
             LIMIT 6"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "name":         r.get::<_, String>(0)?,
            "contact_name": r.get::<_, String>(1)?,
            "deal_count":   r.get::<_, i64>(2)?,
            "total_paid":   r.get::<_, f64>(3)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let loss_deals_this_month: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND net_profit < 0",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0);
    let loss_total_this_month: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND net_profit < 0",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0.0);

    // All-time totals from completed deal flows
    let all_time_revenue: f64 = conn.query_row(
        "SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows WHERE stage='complete'",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let all_time_profit: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete'",
        [], |r| r.get(0)
    ).unwrap_or(0.0);

    Ok(json!({
        "clients": total_clients,
        "invoices": total_invoices,
        "outstanding": outstanding,
        "paid_ytd": paid_this_year,
        "revenue_this_week": revenue_this_week,
        "clients_this_week": clients_this_week,
        "interactions_this_week": interactions_this_week,
        "total_cost": total_cost,
        "total_profit": total_profit,
        "avg_margin": avg_margin,
        "monthly_profit": monthly_profit,
        "top_clients_by_profit": top_clients_by_profit,
        "pipeline_value": pipeline_value,
        "pipeline_count": pipeline_count,
        "incomplete_shipping": incomplete_shipping,
        "category_breakdown": category_breakdown,
        "invoice_status_breakdown": invoice_status_breakdown,
        "top_spenders": top_spenders,
        "loss_deals_this_month": loss_deals_this_month,
        "loss_total_this_month": loss_total_this_month,
        "revenue_mtd": revenue_mtd,
        "profit_mtd": profit_mtd,
        "deals_mtd": deals_mtd,
        "top_suppliers": top_suppliers,
        "all_time_revenue": all_time_revenue,
        "all_time_profit": all_time_profit,
    }))
}

/// List all deal flows that include a given supplier (matched by supplier_id in JSON).
#[tauri::command]
pub async fn list_deals_for_supplier(supplier_id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT df.id, df.completed_at, df.gross_revenue, df.net_profit, df.stage,
                i.number as invoice_number, c.name as client_name,
                (SELECT COALESCE(SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)), 0)
                 FROM json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
                 WHERE json_extract(sp.value, '$.supplier_id') = ?1) as supplier_amount
         FROM deal_flows df
         LEFT JOIN invoices i ON i.id = df.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE EXISTS (
             SELECT 1 FROM json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp2
             WHERE json_extract(sp2.value, '$.supplier_id') = ?1
         )
         ORDER BY df.completed_at DESC, df.created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&supplier_id], |r| {
        Ok(json!({
            "id":             r.get::<_,String>(0)?,
            "completed_at":   r.get::<_,Option<String>>(1)?,
            "gross_revenue":  r.get::<_,f64>(2)?,
            "net_profit":     r.get::<_,f64>(3)?,
            "stage":          r.get::<_,String>(4)?,
            "invoice_number": r.get::<_,Option<String>>(5)?,
            "client_name":    r.get::<_,Option<String>>(6)?,
            "supplier_amount": r.get::<_,f64>(7)?,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_monthly_profit(month: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT date(df.completed_at) as d, COALESCE(SUM(df.net_profit),0)
         FROM deal_flows df
         WHERE df.stage='complete' AND strftime('%Y-%m', df.completed_at) = ?1
         GROUP BY d ORDER BY d"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&month], |r| {
        Ok(json!({ "day": r.get::<_, String>(0)?, "profit": r.get::<_, f64>(1)? }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Return analytics data filtered to [start_date, end_date] (YYYY-MM-DD).
/// Empty strings mean "no bound" (all-time).
#[tauri::command]
pub async fn get_analytics_range(start_date: String, end_date: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let has_start = !start_date.is_empty();
    let has_end   = !end_date.is_empty();

    // Build WHERE clauses for deal_flows
    let df_where = match (has_start, has_end) {
        (true,  true)  => format!("stage='complete' AND date(completed_at)>='{start_date}' AND date(completed_at)<='{end_date}'"),
        (true,  false) => format!("stage='complete' AND date(completed_at)>='{start_date}'"),
        (false, true)  => format!("stage='complete' AND date(completed_at)<='{end_date}'"),
        (false, false) => "stage='complete'".to_string(),
    };

    let total_revenue: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows WHERE {df_where}"),
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let total_cost: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(total_cost),0) FROM deal_flows WHERE {df_where}"),
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let net_profit: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE {df_where}"),
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let avg_margin: f64 = conn.query_row(
        &format!("SELECT COALESCE(AVG(CASE WHEN gross_revenue>0 THEN (net_profit/gross_revenue)*100 END),0) FROM deal_flows WHERE {df_where}"),
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let deal_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM deal_flows WHERE {df_where}"),
        [], |r| r.get(0)
    ).unwrap_or(0);

    // Monthly buckets for the bar chart
    let monthly: Vec<Value> = {
        let mut stmt = conn.prepare(
            &format!("SELECT strftime('%Y-%m', completed_at) as m, COALESCE(SUM(gross_revenue),0), COALESCE(SUM(total_cost),0), COALESCE(SUM(net_profit),0)
             FROM deal_flows WHERE {df_where} GROUP BY m ORDER BY m")
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "month": r.get::<_,String>(0)?, "revenue": r.get::<_,f64>(1)?,
            "cost":  r.get::<_,f64>(2)?,   "profit":  r.get::<_,f64>(3)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Top clients by profit in range
    let inv_where = match (has_start, has_end) {
        (true,  true)  => format!("df2.stage='complete' AND date(df2.completed_at)>='{start_date}' AND date(df2.completed_at)<='{end_date}'"),
        (true,  false) => format!("df2.stage='complete' AND date(df2.completed_at)>='{start_date}'"),
        (false, true)  => format!("df2.stage='complete' AND date(df2.completed_at)<='{end_date}'"),
        (false, false) => "df2.stage='complete'".to_string(),
    };
    let top_clients: Vec<Value> = {
        let mut stmt = conn.prepare(
            &format!("SELECT c.name, COALESCE(SUM(df2.gross_revenue),0), COALESCE(SUM(df2.net_profit),0),
                    CASE WHEN COALESCE(SUM(df2.gross_revenue),0)>0 THEN (COALESCE(SUM(df2.net_profit),0)/SUM(df2.gross_revenue))*100 ELSE 0 END
             FROM deal_flows df2 JOIN invoices i ON i.id=df2.invoice_id JOIN clients c ON c.id=i.client_id
             WHERE {inv_where}
             GROUP BY i.client_id, c.name ORDER BY SUM(df2.net_profit) DESC LIMIT 5")
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "name": r.get::<_,String>(0)?, "total_revenue": r.get::<_,f64>(1)?,
            "total_profit": r.get::<_,f64>(2)?, "margin": r.get::<_,f64>(3)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    Ok(json!({
        "total_revenue": total_revenue, "total_cost": total_cost,
        "total_profit": net_profit,     "avg_margin": avg_margin,
        "deal_count": deal_count,       "monthly_profit": monthly,
        "top_clients_by_profit": top_clients,
    }))
}

// ============================================================
//  Client Tiers
// ============================================================

#[derive(Serialize, Debug, Clone)]
pub struct BuyerTier {
    pub client_id: String,
    pub client_name: String,
    pub tier: String,
    pub effective_annual: f64,
    pub spend_per_frequency: Option<String>,
    pub actual_paid: f64,
    pub invoices_sent: u32,
    pub last_invoice_date: Option<String>,
    pub purchase_frequency: Option<String>,
    pub avg_commission_pct: f64,
}

fn tier_label(s: &str) -> &str {
    match s { "S" => "Diamond", "A" => "Gold", "B" => "Silver", "C" => "Bronze", _ => "Prospect" }
}

#[tauri::command]
pub async fn buyer_tiers() -> Result<Vec<BuyerTier>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    let invoice_data: Vec<(String, f64, u32, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT client_id, COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0),
                    COUNT(CASE WHEN status IN ('sent','paid') THEN 1 END),
                    MAX(CASE WHEN status IN ('sent','paid') THEN issue_date END)
             FROM invoices GROUP BY client_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_,i64>(2)? as u32, r.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let invoice_map: std::collections::HashMap<String, (f64, u32, Option<String>)> =
        invoice_data.into_iter().map(|(id, p, s, d)| (id, (p, s, d))).collect();

    let client_rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, name, metadata FROM clients ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_,Option<String>>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Avg commission % (margin) per client from completed deal flows
    let commission_map: std::collections::HashMap<String, f64> = {
        let mut stmt = conn.prepare(
            "SELECT i.client_id,
                    COALESCE(AVG(CASE WHEN df.gross_revenue > 0 THEN (df.net_profit / df.gross_revenue) * 100 END), 0)
             FROM deal_flows df
             JOIN invoices i ON i.id = df.invoice_id
             WHERE df.stage = 'complete'
             GROUP BY i.client_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,f64>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let mut results = Vec::new();
    for (client_id, client_name, metadata_str) in &client_rows {
        let meta: Option<Value> = metadata_str.as_ref().and_then(|s| serde_json::from_str(s).ok());
        let frequency = meta.as_ref().and_then(|m| m.get("purchase_frequency")).and_then(|v| v.as_str());
        let spend_raw = meta.as_ref().and_then(|m| m.get("estimated_annual_spend")).and_then(|v| v.as_str()).unwrap_or("0");
        let annual_spend: f64 = spend_raw.parse().unwrap_or(0.0);
        let freq_mult = match frequency.unwrap_or("").to_lowercase().as_str() {
            "weekly" => 52.0, "bi-weekly" => 26.0, "monthly" => 12.0,
            "quarterly" => 4.0, "annually" => 1.0, _ => 0.0,
        };
        let effective_annual = freq_mult * annual_spend;

        let (actual_paid, invoices_sent, last_inv) = invoice_map.get(client_id)
            .map(|(p, s, d)| (*p, *s, d.clone())).unwrap_or((0.0, 0, None));

        let tier = if effective_annual > 100000.0 || actual_paid > 50000.0 { "S" }
        else if effective_annual > 50000.0 || actual_paid > 20000.0 || (actual_paid > 5000.0 && invoices_sent >= 3) { "A" }
        else if effective_annual > 10000.0 || actual_paid > 5000.0 || (actual_paid > 1000.0 && invoices_sent >= 1) { "B" }
        else if effective_annual > 0.0 || actual_paid > 0.0 || invoices_sent >= 1 { "C" }
        else { "Prospect" };

        let avg_commission_pct = commission_map.get(client_id).copied().unwrap_or(0.0);
        results.push(BuyerTier {
            client_id: client_id.clone(), client_name: client_name.clone(), tier: tier.into(),
            effective_annual, spend_per_frequency: if spend_raw != "0" && !spend_raw.is_empty() { Some(spend_raw.to_string()) } else { None },
            actual_paid, invoices_sent, last_invoice_date: last_inv,
            purchase_frequency: frequency.map(|s| s.to_string()),
            avg_commission_pct,
        });
    }
    results.sort_by(|a, b| {
        let tier_order = |t: &str| match t { "S" => 0, "A" => 1, "B" => 2, "C" => 3, _ => 4 };
        tier_order(&a.tier).cmp(&tier_order(&b.tier))
            .then_with(|| b.actual_paid.partial_cmp(&a.actual_paid).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| b.invoices_sent.cmp(&a.invoices_sent))
    });
    Ok(results)
}

#[tauri::command]
pub async fn get_buyer_tier(client_id: String) -> Result<BuyerTier, String> {
    let tiers = buyer_tiers().await?;
    tiers.into_iter().find(|t| t.client_id == client_id)
        .ok_or_else(|| "Client not found".into())
}

// ============================================================
//  Weekly Brief
// ============================================================

#[derive(Serialize, Debug, Clone)]
pub struct DealHighlight {
    pub deal_id: String,
    pub client_name: String,
    pub title: String,
    pub asking_price: f64,
    pub margin_pct: f64,
}

#[derive(Serialize, Debug, Clone)]
pub struct InvoiceHighlight {
    pub invoice_id: String,
    pub client_name: String,
    pub number: String,
    pub total: f64,
}

#[derive(Serialize, Debug, Clone)]
pub struct StuckDeal {
    pub deal_id: String,
    pub title: String,
    pub stage: String,
    pub days_in_stage: u32,
}

#[derive(Serialize, Debug, Clone)]
pub struct WeeklyBrief {
    pub generated_at: String,
    pub week_start: String,
    pub week_end: String,
    pub revenue_this_week: f64,
    pub revenue_last_week: f64,
    pub revenue_change_pct: f64,
    pub profit_this_week: f64,
    pub profit_last_week: f64,
    pub profit_change_pct: f64,
    pub avg_margin_this_week: f64,
    pub deals_by_stage: Vec<Value>,
    pub pipeline_value: f64,
    pub deals_closed_this_week: u32,
    pub deals_lost_this_week: u32,
    pub win_rate_this_week: f64,
    pub at_risk_customers: Vec<BuyerTier>,
    pub overdue_invoices_count: u32,
    pub overdue_invoices_value: f64,
    pub follow_ups_due: u32,
    pub best_margin_deal: Option<DealHighlight>,
    pub worst_margin_deal: Option<DealHighlight>,
    pub biggest_invoice: Option<InvoiceHighlight>,
    pub stuck_deals: Vec<StuckDeal>,
    pub new_clients_this_week: u32,
    pub interactions_this_week: u32,
    pub completed_deals_this_week: u32,
    pub completed_deals_last_week: u32,
    pub net_profit_this_week: f64,
    pub net_profit_last_week: f64,
    pub net_profit_change_pct: f64,
    pub profit_jack_this_week: f64,
    pub profit_ben_this_week: f64,
    pub profit_business_this_week: f64,
    pub profit_jack_all_time: f64,
    pub profit_ben_all_time: f64,
    pub profit_business_all_time: f64,
    pub net_profit_this_month: f64,
    pub profit_jack_this_month: f64,
    pub profit_ben_this_month: f64,
    pub profit_business_this_month: f64,
    pub loss_deals_this_week: u32,
    pub loss_total_this_week: f64,
}

#[tauri::command]
pub async fn generate_weekly_brief(for_date: Option<String>) -> Result<WeeklyBrief, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now();

    // Use caller-supplied date or today to anchor the week
    let anchor: chrono::NaiveDate = match for_date.as_deref() {
        Some(d) if !d.is_empty() => d.parse().unwrap_or_else(|_| Utc::now().date_naive()),
        _ => Utc::now().date_naive(),
    };
    let now_date = anchor;
    let wd = chrono::Datelike::weekday(&now_date).num_days_from_sunday() as i64;

    let week_start = format!("{}", (now_date - chrono::Duration::days(wd)).format("%Y-%m-%d"));
    let week_end = format!("{}", (now_date + chrono::Duration::days(6 - wd)).format("%Y-%m-%d"));
    let last_week_start = format!("{}", (now_date - chrono::Duration::days(wd + 7)).format("%Y-%m-%d"));
    let last_week_end = format!("{}", (now_date - chrono::Duration::days(wd + 1)).format("%Y-%m-%d"));

    let revenue_this_week: f64 = conn.query_row(
        "SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&week_start, &week_end], |r| r.get(0)
    ).unwrap_or(0.0);
    let revenue_last_week: f64 = conn.query_row(
        "SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);
    let profit_this_week: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&week_start, &week_end], |r| r.get(0)
    ).unwrap_or(0.0);
    let profit_last_week: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);
    let avg_margin_this_week: f64 = conn.query_row(
        "SELECT COALESCE(AVG(CASE WHEN gross_revenue>0 THEN (net_profit/gross_revenue)*100 END),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&week_start, &week_end], |r| r.get(0)
    ).unwrap_or(0.0);

    let month_start = format!("{}-01", now.format("%Y-%m"));

    struct DfProfit { count: u32, net_profit: f64, jack: f64, ben: f64, business: f64, loss_count: u32, loss_total: f64 }
    let df_this_week: DfProfit = conn.query_row(
        "SELECT COUNT(*) as count, COALESCE(SUM(net_profit),0), COALESCE(SUM(profit_jack),0), COALESCE(SUM(profit_ben),0), COALESCE(SUM(profit_business),0), COUNT(CASE WHEN net_profit < 0 THEN 1 END), COALESCE(SUM(CASE WHEN net_profit < 0 THEN net_profit ELSE 0 END),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&week_start, &week_end],
        |r| Ok(DfProfit { count: r.get::<_,i64>(0).unwrap_or(0) as u32, net_profit: r.get(1)?, jack: r.get(2)?, ben: r.get(3)?, business: r.get(4)?, loss_count: r.get::<_,i64>(5).unwrap_or(0) as u32, loss_total: r.get(6)? })
    ).unwrap_or(DfProfit { count: 0, net_profit: 0.0, jack: 0.0, ben: 0.0, business: 0.0, loss_count: 0, loss_total: 0.0 });

    let df_last_week_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&last_week_start, &week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let df_last_week_profit: f64 = conn.query_row(
        "SELECT COALESCE(SUM(net_profit),0) FROM deal_flows WHERE stage='complete' AND completed_at >= ?1 AND completed_at < ?2",
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);

    let df_mtd: DfProfit = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(net_profit),0), COALESCE(SUM(profit_jack),0), COALESCE(SUM(profit_ben),0), COALESCE(SUM(profit_business),0), 0, 0 FROM deal_flows WHERE stage='complete' AND completed_at >= ?1",
        [&month_start],
        |r| Ok(DfProfit { count: r.get::<_,i64>(0).unwrap_or(0) as u32, net_profit: r.get(1)?, jack: r.get(2)?, ben: r.get(3)?, business: r.get(4)?, loss_count: 0, loss_total: 0.0 })
    ).unwrap_or(DfProfit { count: 0, net_profit: 0.0, jack: 0.0, ben: 0.0, business: 0.0, loss_count: 0, loss_total: 0.0 });

    let df_all_jack: f64 = conn.query_row(
        "SELECT COALESCE(SUM(profit_jack),0) FROM deal_flows WHERE stage='complete'", [], |r| r.get(0)
    ).unwrap_or(0.0);
    let df_all_ben: f64 = conn.query_row(
        "SELECT COALESCE(SUM(profit_ben),0) FROM deal_flows WHERE stage='complete'", [], |r| r.get(0)
    ).unwrap_or(0.0);
    let df_all_biz: f64 = conn.query_row(
        "SELECT COALESCE(SUM(profit_business),0) FROM deal_flows WHERE stage='complete'", [], |r| r.get(0)
    ).unwrap_or(0.0);

    let pipeline_value: f64 = conn.query_row(
        "SELECT COALESCE(SUM(asking_price),0) FROM deals WHERE stage NOT IN ('won','lost')", [], |r| r.get(0)
    ).unwrap_or(0.0);

    let deals_by_stage: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT stage, COUNT(*), COALESCE(SUM(asking_price),0) FROM deals WHERE stage NOT IN ('won','lost') GROUP BY stage"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({ "stage": r.get::<_,String>(0)?, "count": r.get::<_,i64>(1)?, "value": r.get::<_,f64>(2)? })))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let deals_closed: u32 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE won_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let deals_lost: u32 = conn.query_row(
        "SELECT COUNT(*) FROM deals WHERE lost_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let win_rate = if deals_closed + deals_lost > 0 { (deals_closed as f64 / (deals_closed + deals_lost) as f64) * 100.0 } else { 0.0 };

    let at_risk_customers: Vec<BuyerTier> = buyer_tiers().await?.into_iter()
        .filter(|h| h.tier == "C" || h.tier == "Prospect").take(5).collect();

    let overdue_invoices_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM invoices WHERE status='sent' AND due_date < date('now')", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let overdue_invoices_value: f64 = conn.query_row(
        "SELECT COALESCE(SUM(total),0) FROM invoices WHERE status='sent' AND due_date < date('now')", [], |r| r.get(0)
    ).unwrap_or(0.0);

    let follow_ups: Vec<Client> = due_followups().await?;
    let follow_ups_due = follow_ups.len() as u32;

    let best_margin_deal: Option<DealHighlight> = {
        let mut stmt = conn.prepare(
            "SELECT d.id, c.name, d.title, d.asking_price, CASE WHEN d.asking_price>0 THEN (d.asking_price - d.shipping_cost - d.other_costs - (SELECT COALESCE(SUM(json_extract(value,'$.amount')),0) FROM json_each(d.supplier_costs_json)))/d.asking_price*100 ELSE 0 END as margin
             FROM deals d JOIN clients c ON c.id=d.client_id
             WHERE d.won_at >= ?1 ORDER BY margin DESC LIMIT 1"
        ).map_err(|e| e.to_string())?;
        stmt.query_row([&week_start], |r| Ok(DealHighlight {
            deal_id: r.get(0)?, client_name: r.get(1)?, title: r.get(2)?,
            asking_price: r.get(3)?, margin_pct: r.get(4)?,
        })).ok()
    };

    let worst_margin_deal: Option<DealHighlight> = {
        let mut stmt = conn.prepare(
            "SELECT d.id, c.name, d.title, d.asking_price, CASE WHEN d.asking_price>0 THEN (d.asking_price - d.shipping_cost - d.other_costs - (SELECT COALESCE(SUM(json_extract(value,'$.amount')),0) FROM json_each(d.supplier_costs_json)))/d.asking_price*100 ELSE 0 END as margin
             FROM deals d JOIN clients c ON c.id=d.client_id
             WHERE d.won_at >= ?1 AND d.stage='won' ORDER BY margin ASC LIMIT 1"
        ).map_err(|e| e.to_string())?;
        stmt.query_row([&week_start], |r| Ok(DealHighlight {
            deal_id: r.get(0)?, client_name: r.get(1)?, title: r.get(2)?,
            asking_price: r.get(3)?, margin_pct: r.get(4)?,
        })).ok()
    };

    let biggest_invoice: Option<InvoiceHighlight> = {
        let mut stmt = conn.prepare(
            "SELECT i.id, c.name, i.number, i.total FROM invoices i JOIN clients c ON c.id=i.client_id
             WHERE i.status='paid' AND i.issue_date >= ?1 ORDER BY i.total DESC LIMIT 1"
        ).map_err(|e| e.to_string())?;
        stmt.query_row([&week_start], |r| Ok(InvoiceHighlight {
            invoice_id: r.get(0)?, client_name: r.get(1)?, number: r.get(2)?, total: r.get(3)?,
        })).ok()
    };

    let stuck_deals: Vec<StuckDeal> = {
        let mut stmt = conn.prepare(
            "SELECT d.id, d.title, d.stage, CAST(julianday('now') - julianday(d.updated_at) AS INTEGER) as days
             FROM deals d WHERE d.stage NOT IN ('won','lost') ORDER BY days DESC LIMIT 5"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(StuckDeal {
            deal_id: r.get(0)?, title: r.get(1)?, stage: r.get(2)?, days_in_stage: r.get::<_,i64>(3).unwrap_or(0).max(0) as u32,
        })).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let new_clients_this_week: u32 = conn.query_row(
        "SELECT COUNT(*) FROM clients WHERE created_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;

    let interactions_this_week: u32 = conn.query_row(
        "SELECT COUNT(*) FROM interactions WHERE created_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;

    Ok(WeeklyBrief {
        generated_at: now.to_rfc3339(),
        week_start: week_start.clone(),
        week_end,
        revenue_this_week,
        revenue_last_week,
        revenue_change_pct: if revenue_last_week > 0.0 { ((revenue_this_week - revenue_last_week) / revenue_last_week) * 100.0 } else { 0.0 },
        profit_this_week,
        profit_last_week,
        profit_change_pct: if profit_last_week > 0.0 { ((profit_this_week - profit_last_week) / profit_last_week) * 100.0 } else { 0.0 },
        avg_margin_this_week,
        deals_by_stage,
        pipeline_value,
        deals_closed_this_week: deals_closed,
        deals_lost_this_week: deals_lost,
        win_rate_this_week: win_rate,
        at_risk_customers,
        overdue_invoices_count,
        overdue_invoices_value,
        follow_ups_due,
        best_margin_deal,
        worst_margin_deal,
        biggest_invoice,
        stuck_deals,
        new_clients_this_week,
        interactions_this_week,
        completed_deals_this_week: df_this_week.count,
        completed_deals_last_week: df_last_week_count,
        net_profit_this_week: df_this_week.net_profit,
        net_profit_last_week: df_last_week_profit,
        net_profit_change_pct: if df_last_week_profit != 0.0 { ((df_this_week.net_profit - df_last_week_profit) / df_last_week_profit.abs()) * 100.0 } else { 0.0 },
        profit_jack_this_week: df_this_week.jack,
        profit_ben_this_week: df_this_week.ben,
        profit_business_this_week: df_this_week.business,
        profit_jack_all_time: df_all_jack,
        profit_ben_all_time: df_all_ben,
        profit_business_all_time: df_all_biz,
        net_profit_this_month: df_mtd.net_profit,
        profit_jack_this_month: df_mtd.jack,
        profit_ben_this_month: df_mtd.ben,
        profit_business_this_month: df_mtd.business,
        loss_deals_this_week: df_this_week.loss_count,
        loss_total_this_week: df_this_week.loss_total,
    })
}

#[derive(Serialize, Debug, Clone)]
pub struct DuplicateGroup {
    pub key: String,
    pub count: u32,
    pub client_ids: Vec<String>,
    pub names: Vec<String>,
}

#[tauri::command]
pub async fn detect_duplicate_clients() -> Result<Vec<DuplicateGroup>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT LOWER(email) as k, COUNT(*), GROUP_CONCAT(id), GROUP_CONCAT(name)
         FROM clients WHERE email IS NOT NULL AND email != ''
         GROUP BY LOWER(email) HAVING COUNT(*) > 1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(DuplicateGroup {
            key: r.get(0)?, count: r.get::<_,i64>(1)? as u32,
            client_ids: r.get::<_,String>(2)?.split(',').map(|s| s.to_string()).collect(),
            names: r.get::<_,String>(3)?.split(',').map(|s| s.to_string()).collect(),
        })
    }).map_err(|e| e.to_string())?;
    for r in rows { if let Ok(g) = r { groups.push(g); } }
    Ok(groups)
}

#[derive(Serialize)]
pub struct CleanupResult {
    duplicates_merged: u32,
    ghosts_removed: u32,
    remaining_clients: u32,
}

#[derive(Debug)]
struct ClientRow {
    id: String,
    name: String,
    email: Option<String>,
    phone: Option<String>,
    company: Option<String>,
    has_invoices: bool,
}

fn normalize_phone(p: &str) -> String {
    p.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn is_date_like(p: &str) -> bool {
    let s = p.trim();
    (s.contains('/') && s.chars().filter(|c| *c == '/').count() == 2)
        || (s.contains('-') && s.len() == 10 && s.chars().filter(|c| *c == '-').count() == 2)
}

fn name_parts(name: &str) -> Vec<String> {
    name.to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
}

fn first_name_of(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.split_whitespace().collect();
    if parts.is_empty() { return None; }
    let first = parts[0].to_lowercase();
    if first.len() >= 2 { Some(first) } else { None }
}

fn last_word_of(name: &str) -> Option<String> {
    let parts: Vec<&str> = name.split_whitespace().collect();
    if parts.is_empty() { return None; }
    let last = parts.last().unwrap().to_lowercase();
    if last.len() >= 2 { Some(last) } else { None }
}

fn fuzzy_score(ghost: &ClientRow, real: &ClientRow) -> i32 {
    let mut score: i32 = 0;
    let ghost_name = ghost.name.to_lowercase();
    let real_name = real.name.to_lowercase();
    let real_company = real.company.as_deref().unwrap_or("").to_lowercase();
    let ghost_company = ghost.company.as_deref().unwrap_or("").to_lowercase();

    if !real_company.is_empty() && ghost_name.contains(&real_company) {
        score += 10;
    }

    if !real_name.is_empty() && ghost_name.contains(&real_name) {
        score += 8;
    }

    if let Some(ref rp) = real.phone {
        let gphone = normalize_phone(ghost.phone.as_deref().unwrap_or(""));
        let rphone = normalize_phone(rp);
        if !gphone.is_empty() && !rphone.is_empty() && gphone == rphone {
            score += 10;
        }
    }

    if let Some(gf) = last_word_of(&ghost.name) {
        if let Some(rf) = first_name_of(&real.name) {
            if gf == rf { score += 5; }
        }
    }

    if ghost_company == "ben" && real_company != "ben" && !real_company.is_empty() {
        if ghost_name.starts_with(&real_company) || ghost_name.contains(&real_company) {
            score += 8;
        }
    }

    if !real_name.is_empty() && !ghost_name.is_empty() && ghost_name != real_name {
        let real_words: Vec<&str> = real_name.split_whitespace().collect();
        let ghost_words: Vec<&str> = ghost_name.split_whitespace().collect();
        let mut shared = 0;
        for rw in &real_words {
            for gw in &ghost_words {
                if rw == gw && rw.len() >= 3 { shared += 1; }
            }
        }
        if shared > 0 { score += shared as i32 * 3; }
    }

    score
}

#[tauri::command]
pub async fn cleanup_clients() -> Result<CleanupResult, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut duplicates_merged: u32 = 0;

    let mut email_dups: Vec<(String, Vec<String>)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT LOWER(email), GROUP_CONCAT(id) FROM clients WHERE email IS NOT NULL AND email != '' GROUP BY LOWER(email) HAVING COUNT(*) > 1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows {
            if let Ok((key, ids)) = r {
                let id_list: Vec<String> = ids.split(',').map(|s| s.to_string()).collect();
                if id_list.len() > 1 { email_dups.push((key, id_list)); }
            }
        }
    }

    for (_key, ids) in &email_dups {
        let keeper = &ids[0];
        for dup_id in &ids[1..] {
            let _ = conn.execute("UPDATE interactions SET client_id=?1 WHERE client_id=?2", rusqlite::params![keeper, dup_id]);
            let _ = conn.execute("UPDATE invoices SET client_id=?1 WHERE client_id=?2", rusqlite::params![keeper, dup_id]);
            let _ = conn.execute("DELETE FROM clients WHERE id=?1", rusqlite::params![dup_id]);
            duplicates_merged += 1;
        }
    }

    let mut exact_name_dups: Vec<(String, Vec<String>)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT LOWER(TRIM(name)), GROUP_CONCAT(id) FROM clients WHERE (email IS NULL OR email = '') GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows {
            if let Ok((key, ids)) = r {
                let id_list: Vec<String> = ids.split(',').map(|s| s.to_string()).collect();
                if id_list.len() > 1 { exact_name_dups.push((key, id_list)); }
            }
        }
    }

    for (_key, ids) in &exact_name_dups {
        let keeper = &ids[0];
        for dup_id in &ids[1..] {
            let _ = conn.execute("UPDATE interactions SET client_id=?1 WHERE client_id=?2", rusqlite::params![keeper, dup_id]);
            let _ = conn.execute("UPDATE invoices SET client_id=?1 WHERE client_id=?2", rusqlite::params![keeper, dup_id]);
            let _ = conn.execute("DELETE FROM clients WHERE id=?1", rusqlite::params![dup_id]);
            duplicates_merged += 1;
        }
    }

    let mut all_clients: Vec<ClientRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, c.email, c.phone, c.company,
                    CASE WHEN EXISTS(SELECT 1 FROM invoices WHERE client_id=c.id) THEN 1 ELSE 0 END
             FROM clients c ORDER BY c.name"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(ClientRow {
                id: r.get(0)?,
                name: r.get::<_,String>(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                has_invoices: r.get::<_,i64>(5)? != 0,
            })
        }).map_err(|e| e.to_string())?;
        for r in rows { if let Ok(c) = r { all_clients.push(c); } }
    }

    let mut ghost_ids: Vec<String> = Vec::new();

    for (i, c) in all_clients.iter().enumerate() {
        let company_lower = c.company.as_deref().unwrap_or("").to_lowercase();
        let phone_str = c.phone.as_deref().unwrap_or("");
        let email_str = c.email.as_deref().unwrap_or("");
        let is_ghost_pattern = (company_lower == "ben" || company_lower.is_empty())
            && email_str.is_empty()
            && (phone_str.is_empty() || is_date_like(phone_str));

        if !is_ghost_pattern { continue; }

        let mut best_match: Option<(usize, i32)> = None;
        for (j, other) in all_clients.iter().enumerate() {
            if i == j { continue; }
            if ghost_ids.contains(&other.id) { continue; }
            let other_email = other.email.as_deref().unwrap_or("");
            if other_email.is_empty() && !other.has_invoices { continue; }

            let score = fuzzy_score(c, other);
            if score >= 8 {
                match best_match {
                    None => best_match = Some((j, score)),
                    Some((_, best_s)) if score > best_s => best_match = Some((j, score)),
                    _ => {}
                }
            }
        }

        if best_match.is_some() {
            ghost_ids.push(c.id.clone());
        }
    }

    for ghost_id in &ghost_ids {
        let _ = conn.execute("UPDATE interactions SET client_id=NULL WHERE client_id=?1", rusqlite::params![ghost_id]);
        let _ = conn.execute("DELETE FROM clients WHERE id=?1", rusqlite::params![ghost_id]);
    }
    let ghosts_removed = ghost_ids.len() as u32;

    let remaining_clients: u32 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get::<_,i64>(0)).unwrap_or(0) as u32;

    Ok(CleanupResult { duplicates_merged, ghosts_removed, remaining_clients })
}

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
//  Newsletters (local-only — not synced)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Newsletter {
    pub id: String,
    pub subject: String,
    pub body: String,
    pub status: String,
    pub recipient_count: i64,
    pub sent_count: i64,
    pub created_at: String,
    pub sent_at: Option<String>,
}

#[derive(Serialize)]
pub struct NewsletterSendResult {
    pub sent: u32,
    pub failed: u32,
    pub skipped: u32,
    pub errors: Vec<NewsletterSendError>,
}

#[derive(Serialize)]
pub struct NewsletterSendError {
    pub client_name: String,
    pub error: String,
}

#[tauri::command]
pub async fn list_newsletters() -> Result<Vec<Newsletter>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, subject, body, status, recipient_count, sent_count, created_at, sent_at FROM newsletters ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(Newsletter {
            id: r.get(0)?, subject: r.get(1)?, body: r.get(2)?, status: r.get(3)?,
            recipient_count: r.get(4)?, sent_count: r.get(5)?, created_at: r.get(6)?, sent_at: r.get(7)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn save_newsletter(id: Option<String>, subject: String, body: String) -> Result<Newsletter, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let nid = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO newsletters (id, subject, body, status, created_at) VALUES (?1, ?2, ?3, 'draft', ?4)
         ON CONFLICT(id) DO UPDATE SET subject=excluded.subject, body=excluded.body",
        rusqlite::params![nid, subject, body, now],
    ).map_err(|e| e.to_string())?;
    Ok(Newsletter {
        id: nid, subject, body, status: "draft".into(),
        recipient_count: 0, sent_count: 0, created_at: now, sent_at: None,
    })
}

#[tauri::command]
pub async fn delete_newsletter(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM newsletter_sends WHERE newsletter_id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM newsletters WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn send_newsletter(
    newsletter_id: String,
    client_ids: Vec<String>,
    subject_template: String,
    body_template: String,
    attachment_path: Option<String>,
) -> Result<NewsletterSendResult, String> {
    crate::email::test_smtp().await.map_err(|e| format!("SMTP connection failed: {}", e))?;

    if let Some(ref path) = attachment_path {
        let meta = std::fs::metadata(path).map_err(|e| format!("Attachment error: {}", e))?;
        if meta.len() > 25 * 1024 * 1024 {
            return Err("Attachment too large (max 25 MB)".into());
        }
    }

    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut sent: u32 = 0;
    let mut failed: u32 = 0;
    let mut skipped: u32 = 0;
    let mut errors: Vec<NewsletterSendError> = Vec::new();
    let total = client_ids.len() as u32;

    for cid in &client_ids {
        let sid = Uuid::new_v4().to_string();
        let (name, email): (String, Option<String>) = conn.query_row(
            "SELECT name, email FROM clients WHERE id=?1", [cid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| e.to_string())?;

        let first = name.split_whitespace().next().unwrap_or(&name);
        let subj = subject_template.replace("{{first_name}}", first);
        let body = body_template.replace("{{first_name}}", first);

        match &email {
            Some(addr) if !addr.is_empty() => {
                match crate::email::send(addr, &subj, &body, attachment_path.as_deref()).await {
                    Ok(()) => {
                        sent += 1;
                        let _ = conn.execute(
                            "INSERT INTO newsletter_sends (id, newsletter_id, client_id, status, sent_at) VALUES (?1, ?2, ?3, 'sent', ?4)",
                            rusqlite::params![sid, &newsletter_id, cid, &now],
                        );
                    }
                    Err(e) => {
                        failed += 1;
                        let err_str = format!("{}", e);
                        errors.push(NewsletterSendError { client_name: name.clone(), error: err_str.clone() });
                        let _ = conn.execute(
                            "INSERT INTO newsletter_sends (id, newsletter_id, client_id, status, error) VALUES (?1, ?2, ?3, 'failed', ?4)",
                            rusqlite::params![sid, &newsletter_id, cid, &err_str],
                        );
                    }
                }
            }
            _ => {
                skipped += 1;
                errors.push(NewsletterSendError { client_name: name.clone(), error: "No email address".into() });
                let _ = conn.execute(
                    "INSERT INTO newsletter_sends (id, newsletter_id, client_id, status, error) VALUES (?1, ?2, ?3, 'skipped', ?4)",
                    rusqlite::params![sid, &newsletter_id, cid, "No email address"],
                );
            }
        }
    }

    conn.execute(
        "UPDATE newsletters SET status='sent', recipient_count=?1, sent_count=?2, sent_at=?3 WHERE id=?4",
        rusqlite::params![total, sent, &now, &newsletter_id],
    ).map_err(|e| e.to_string())?;

    Ok(NewsletterSendResult { sent, failed, skipped, errors })
}

#[tauri::command]
pub async fn ai_draft_newsletter(prompt: String, tone: String) -> Result<String, String> {
    crate::ai::draft_newsletter(&prompt, &tone)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================
//  Scheduled Sends (processed by Pi scheduler)
// ============================================================

#[derive(Serialize)]
pub struct ScheduledSend {
    pub id: String,
    pub newsletter_id: String,
    pub subject: String,
    pub body: String,
    pub attachment_path: Option<String>,
    pub scheduled_at: String,
    pub interval_seconds: i64,
    pub total_recipients: i64,
    pub recipients_json: String,
    pub sent_count: i64,
    pub failed_count: i64,
    pub skipped_count: i64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ScheduledSendProgress {
    pub sent_count: i64,
    pub failed_count: i64,
    pub skipped_count: i64,
    pub total_recipients: i64,
    pub status: String,
}

#[tauri::command]
pub async fn schedule_newsletter_send(
    subject: String,
    body: String,
    client_ids: Vec<String>,
    interval_seconds: i64,
    scheduled_at: String,
    attachment_path: Option<String>,
) -> Result<ScheduledSend, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let scheduled_time = chrono::DateTime::parse_from_rfc3339(&scheduled_at)
        .map_err(|e| format!("Invalid scheduled_at: {}", e))?;
    let min_time = Utc::now() + chrono::Duration::seconds(60);
    let effective_at = if scheduled_time > min_time {
        scheduled_at.clone()
    } else {
        now.clone()
    };

    let nid = Uuid::new_v4().to_string();
    let id = Uuid::new_v4().to_string();
    let recipients_json = serde_json::to_string(&client_ids).map_err(|e| e.to_string())?;
    let total = client_ids.len() as i64;

    conn.execute(
        "INSERT INTO newsletters (id, subject, body, status, created_at) VALUES (?1, ?2, ?3, 'draft', ?4)",
        rusqlite::params![nid, &subject, &body, &now],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO scheduled_sends (id, newsletter_id, subject, body, attachment_path, scheduled_at, interval_seconds, total_recipients, recipients_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![id, nid, &subject, &body, &attachment_path, &effective_at, interval_seconds, total, &recipients_json, &now],
    ).map_err(|e| e.to_string())?;

    let mut cols = serde_json::Map::new();
    cols.insert("newsletter_id".into(), serde_json::Value::String(nid.clone()));
    cols.insert("subject".into(), serde_json::Value::String(subject.clone()));
    cols.insert("body".into(), serde_json::Value::String(body.clone()));
    cols.insert("scheduled_at".into(), serde_json::Value::String(effective_at.clone()));
    cols.insert("interval_seconds".into(), serde_json::json!(interval_seconds));
    cols.insert("total_recipients".into(), serde_json::json!(total));
    cols.insert("recipients_json".into(), serde_json::Value::String(recipients_json.clone()));
    cols.insert("status".into(), serde_json::Value::String("pending".into()));
    cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
    if let Some(ref ap) = attachment_path {
        cols.insert("attachment_path".into(), serde_json::Value::String(ap.clone()));
    }
    crate::sync::record_upsert("scheduled_sends", &id, cols).map_err(|e| e.to_string())?;

    Ok(ScheduledSend {
        id,
        newsletter_id: nid,
        subject,
        body,
        attachment_path,
        scheduled_at: effective_at,
        interval_seconds,
        total_recipients: total,
        recipients_json,
        sent_count: 0,
        failed_count: 0,
        skipped_count: 0,
        status: "pending".into(),
        error: None,
        created_at: now,
    })
}

#[tauri::command]
pub async fn cancel_scheduled_send(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let status: String = conn.query_row(
        "SELECT status FROM scheduled_sends WHERE id=?1", [&id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if status != "pending" && status != "running" {
        return Err("Can only cancel pending or running sends".into());
    }
    conn.execute(
        "UPDATE scheduled_sends SET status='cancelled' WHERE id=?1", [&id],
    ).map_err(|e| e.to_string())?;

    let mut cols = serde_json::Map::new();
    cols.insert("status".into(), serde_json::Value::String("cancelled".into()));
    crate::sync::record_upsert("scheduled_sends", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_scheduled_sends() -> Result<Vec<ScheduledSend>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, newsletter_id, subject, body, attachment_path, scheduled_at, interval_seconds,
                total_recipients, recipients_json, sent_count, failed_count, skipped_count,
                status, error, created_at
         FROM scheduled_sends ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(ScheduledSend {
            id: r.get(0)?, newsletter_id: r.get(1)?, subject: r.get(2)?, body: r.get(3)?,
            attachment_path: r.get(4)?, scheduled_at: r.get(5)?, interval_seconds: r.get(6)?,
            total_recipients: r.get(7)?, recipients_json: r.get(8)?,
            sent_count: r.get(9)?, failed_count: r.get(10)?, skipped_count: r.get(11)?,
            status: r.get(12)?, error: r.get(13)?, created_at: r.get(14)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_scheduled_send_progress(id: String) -> Result<ScheduledSendProgress, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT sent_count, failed_count, skipped_count, total_recipients, status FROM scheduled_sends WHERE id=?1",
        [&id],
        |r| Ok(ScheduledSendProgress {
            sent_count: r.get(0)?, failed_count: r.get(1)?, skipped_count: r.get(2)?,
            total_recipients: r.get(3)?, status: r.get(4)?,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_smtp_settings_for_pi(settings: serde_json::Value) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pairs = [("smtp_host", "smtp_host"), ("smtp_port", "smtp_port"), ("smtp_username", "smtp_username"), ("smtp_password", "smtp_password"), ("smtp_from_name", "smtp_from_name"), ("smtp_from_email", "smtp_from_email")];
    for (key, field) in &pairs {
        if let Some(val) = settings.get(field) {
            let val_str = match val {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![key, val_str],
            ).map_err(|e| e.to_string())?;

            let mut cols = serde_json::Map::new();
            cols.insert("key".into(), serde_json::Value::String(key.to_string()));
            cols.insert("value".into(), serde_json::Value::String(val_str));
            crate::sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_smtp_settings_for_pi() -> Result<serde_json::Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut result = serde_json::Map::new();
    for key in &["smtp_host", "smtp_port", "smtp_username", "smtp_from_name", "smtp_from_email"] {
        let val: Option<String> = conn.query_row(
            "SELECT value FROM settings WHERE key=?1", [*key], |r| r.get(0),
        ).ok();
        if let Some(v) = val {
            result.insert(key.to_string(), serde_json::Value::String(v));
        }
    }
    let has_pw: bool = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key='smtp_password' AND value != ''", [],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;
    result.insert("smtp_password_set".into(), serde_json::Value::Bool(has_pw));
    Ok(serde_json::Value::Object(result))
}

// ============================================================
//  Categories (local-only — not synced)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub sort_order: i64,
}

#[derive(Deserialize)]
pub struct CategoryInput {
    pub label: String,
}

#[tauri::command]
pub async fn list_categories() -> Result<Vec<Category>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, label, sort_order FROM categories ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(Category { id: r.get(0)?, label: r.get(1)?, sort_order: r.get(2)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_category(input: CategoryInput) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let max_sort: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM categories", [],
        |r| r.get(0),
    ).unwrap_or(-1);
    conn.execute(
        "INSERT INTO categories (id, label, sort_order) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, input.label, max_sort + 1],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_category(id: String, input: CategoryInput) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE categories SET label=?1 WHERE id=?2",
        rusqlite::params![input.label, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_category(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM categories WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_categories(ids: Vec<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET sort_order=?1 WHERE id=?2",
            rusqlite::params![i as i64, id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
//  Line Item Templates (local-only — not synced)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LineItemTemplate {
    pub id: String,
    pub description: String,
    pub rate: f64,
    pub qty: f64,
    pub sort_order: i32,
}

#[tauri::command]
pub async fn list_line_item_templates() -> Result<Vec<LineItemTemplate>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,description,rate,qty,sort_order FROM line_item_templates ORDER BY sort_order, description",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(LineItemTemplate { id: r.get(0)?, description: r.get(1)?, rate: r.get(2)?, qty: r.get(3)?, sort_order: r.get(4)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_line_item_template(description: String, rate: f64, qty: f64) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO line_item_templates (id,description,rate,qty, sort_order) VALUES (?1,?2,?3,?4,0)",
        rusqlite::params![id, description, rate, qty],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn delete_line_item_template(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM line_item_templates WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_line_item_templates(ids: Vec<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE line_item_templates SET sort_order=?1 WHERE id=?2", rusqlite::params![i as i32, id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============================================================
//  Sheet Sync (Google Sheets -> ClientHub, local-only)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SheetSyncConfig {
    pub id: i64,
    pub sheet_url: Option<String>,
    pub name_col: String,
    pub first_name_col: String,
    pub last_name_col: String,
    pub email_col: String,
    pub phone_col: String,
    pub company_col: String,
    pub category_col: String,
    pub lead_status_col: String,
    pub notes_col: String,
    pub skip_header_rows: i64,
    pub last_synced_at: Option<String>,
    pub last_synced_count: i64,
}

#[derive(Serialize)]
pub struct SheetSyncResult {
    pub new_clients: u32,
    pub skipped_duplicates: u32,
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SheetSyncLogEntry {
    pub id: String,
    pub synced_at: String,
    pub new_clients: i64,
    pub skipped_duplicates: i64,
    pub errors: Option<String>,
}

fn col_index(col: &str) -> usize {
    let mut idx = 0usize;
    for c in col.chars() {
        if c < 'A' || c > 'Z' { break; }
        idx = idx * 26 + (c as usize) - ('A' as usize) + 1;
    }
    idx.saturating_sub(1)
}

#[tauri::command]
pub async fn get_sheet_sync_config() -> Result<SheetSyncConfig, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO sheet_sync_config (id) VALUES (1)",
        [],
    ).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows, last_synced_at, last_synced_count FROM sheet_sync_config WHERE id=1",
        [],
        |r| Ok(SheetSyncConfig {
            id: r.get(0)?, sheet_url: r.get(1)?, name_col: r.get(2)?,
            first_name_col: r.get(3)?, last_name_col: r.get(4)?,
            email_col: r.get(5)?, phone_col: r.get(6)?, company_col: r.get(7)?,
            category_col: r.get(8)?, lead_status_col: r.get(9)?,
            notes_col: r.get(10)?, skip_header_rows: r.get(11)?,
            last_synced_at: r.get(12)?, last_synced_count: r.get(13)?,
        }),
    ).map_err(|e| e.to_string())
    .map(|mut c| {
        if c.first_name_col.is_empty() { c.first_name_col = "E".into(); }
        if c.last_name_col.is_empty() { c.last_name_col = "F".into(); }
        if c.lead_status_col.is_empty() { c.lead_status_col = "W".into(); }
        if c.notes_col.is_empty() { c.notes_col = "AA".into(); }
        if c.email_col.is_empty() { c.email_col = "I".into(); }
        if c.phone_col.is_empty() { c.phone_col = "L".into(); }
        if c.company_col.is_empty() { c.company_col = "D".into(); }
        if c.category_col.is_empty() { c.category_col = "J".into(); }
        c
    })
}

#[tauri::command]
pub async fn save_sheet_sync_config(config: SheetSyncConfig) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO sheet_sync_config (id, sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![config.sheet_url, config.name_col, config.first_name_col, config.last_name_col, config.email_col, config.phone_col, config.company_col, config.category_col, config.lead_status_col, config.notes_col, config.skip_header_rows],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sync_from_sheet() -> Result<SheetSyncResult, String> {
    let config = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows FROM sheet_sync_config WHERE id=1",
            [],
            |r| Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, String>(3)?, r.get::<_, String>(4)?,
                r.get::<_, String>(5)?, r.get::<_, String>(6)?,
                r.get::<_, String>(7)?, r.get::<_, String>(8)?,
                r.get::<_, String>(9)?, r.get::<_, i64>(10)?,
            )),
        ).map_err(|e| e.to_string())?
    };
    let (sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows) = config;
    let (mut first_name_col, mut last_name_col, mut email_col, mut phone_col, mut company_col, mut category_col, mut lead_status_col, mut notes_col) =
        (first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col);
    if first_name_col.is_empty() { first_name_col = "F".into(); }
    if last_name_col.is_empty() { last_name_col = "G".into(); }
    if email_col.is_empty() { email_col = "I".into(); }
    if phone_col.is_empty() { phone_col = "J".into(); }
    if company_col.is_empty() { company_col = "E".into(); }
    if category_col.is_empty() { category_col = "P".into(); }
    if lead_status_col.is_empty() { lead_status_col = "V".into(); }
    if notes_col.is_empty() { notes_col = "AA".into(); }
    let sheet_url = sheet_url.ok_or("No sheet URL configured")?;

    let csv_url = {
        let base = sheet_url
            .split('?').next().unwrap_or(&sheet_url)
            .split('#').next().unwrap_or(&sheet_url)
            .trim_end_matches('/');
        if base.contains("/edit") {
            base.replace("/edit", "/export?format=csv")
        } else {
            format!("{}/export?format=csv", base)
        }
    };

    let resp = reqwest::get(&csv_url).await
        .map_err(|e| format!("Failed to fetch sheet: {}. Is the sheet set to 'Anyone with link can view'?", e))?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    let name_idx = col_index(&name_col);
    let first_idx = col_index(&first_name_col);
    let last_idx = col_index(&last_name_col);
    let email_idx = col_index(&email_col);
    let phone_idx = col_index(&phone_col);
    let company_idx = col_index(&company_col);
    let cat_idx = col_index(&category_col);
    let lead_status_idx = col_index(&lead_status_col);
    let notes_idx = col_index(&notes_col);
    let street_idx = col_index("K");
    let city_idx = col_index("L");
    let state_idx = col_index("M");
    let zip_idx = col_index("N");
    let other_cat_idx = col_index("Q");
    let purchase_freq_idx = col_index("R");
    let buy_spend_idx = col_index("S");

    let mut new_clients: u32 = 0;
    let mut skipped: u32 = 0;
    let mut errors: Vec<String> = Vec::new();

    let mut reader = csv::ReaderBuilder::new().has_headers(false).from_reader(text.as_bytes());
    for (row_num, row) in reader.records().enumerate() {
        if (row_num as i64) < skip_header_rows { continue; }
        let record = match row {
            Ok(r) => r,
            Err(e) => { errors.push(format!("Row {}: {}", row_num + 1, e)); continue; }
        };

        let first = record.get(first_idx).unwrap_or("").trim().to_string();
        let last = record.get(last_idx).unwrap_or("").trim().to_string();
        let name = if !first.is_empty() || !last.is_empty() {
            format!("{} {}", first, last).trim().to_string()
        } else {
            record.get(name_idx).unwrap_or("").trim().to_string()
        };
        let email = record.get(email_idx).unwrap_or("").trim().to_string();
        let phone = record.get(phone_idx).unwrap_or("").trim().to_string();
        let company = record.get(company_idx).unwrap_or("").trim().to_string();
        let category = record.get(cat_idx).unwrap_or("").trim().to_string();
        let lead_status = record.get(lead_status_idx).unwrap_or("").trim().to_string();
        let notes = record.get(notes_idx).unwrap_or("").trim().to_string();
        let street = record.get(street_idx).unwrap_or("").trim().to_string();
        let city = record.get(city_idx).unwrap_or("").trim().to_string();
        let state = record.get(state_idx).unwrap_or("").trim().to_string();
        let zip = record.get(zip_idx).unwrap_or("").trim().to_string();
        let other_cats = record.get(other_cat_idx).unwrap_or("").trim().to_string();
        let purchase_freq = record.get(purchase_freq_idx).unwrap_or("").trim().to_string();
        let buy_spend = record.get(buy_spend_idx).unwrap_or("").trim().to_string();

        if name.is_empty() && email.is_empty() { continue; }

        if !email.is_empty() && !email.contains('@') {
            skipped += 1;
            continue;
        }

        let phone_like_date = !phone.is_empty() && phone.contains('/') && phone.chars().filter(|c| *c == '/').count() == 2;
        if email.is_empty() && phone_like_date {
            skipped += 1;
            continue;
        }

        let existing_id: Option<String> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            if !email.is_empty() {
                conn.query_row(
                    "SELECT id FROM clients WHERE LOWER(email)=LOWER(?1)", [&email],
                    |r| r.get(0),
                ).ok()
            } else {
                conn.query_row(
                    "SELECT id FROM clients WHERE LOWER(name)=LOWER(?1)", [&name],
                    |r| r.get(0),
                ).ok()
            }
        };

        if let Some(ref eid) = existing_id {
            let update_now = Utc::now().to_rfc3339();
            let mut meta = serde_json::json!({});
            if !category.is_empty() { meta["category"] = Value::String(category.clone()); }
            if !street.is_empty() { meta["street_address"] = Value::String(street.clone()); }
            if !city.is_empty() { meta["city"] = Value::String(city.clone()); }
            if !state.is_empty() { meta["state"] = Value::String(state.clone()); }
            if !zip.is_empty() { meta["zip_code"] = Value::String(zip.clone()); }
            if !other_cats.is_empty() { meta["other_categories"] = Value::String(other_cats.clone()); }
            if !purchase_freq.is_empty() { meta["purchase_frequency"] = Value::String(purchase_freq.clone()); }
            if !buy_spend.is_empty() { meta["estimated_annual_spend"] = Value::String(buy_spend.clone()); }
            let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());
            let conn2 = pool().get().map_err(|e| e.to_string())?;
            let _ = conn2.execute(
                "UPDATE clients SET name=COALESCE(NULLIF(?1,''),name), email=COALESCE(NULLIF(?2,''),email), phone=COALESCE(NULLIF(?3,''),phone), company=COALESCE(NULLIF(?4,''),company), notes=COALESCE(NULLIF(?5,''),notes), lead_status=COALESCE(NULLIF(?6,''),lead_status), metadata=CASE WHEN ?7 != '{}' THEN ?7 ELSE metadata END, updated_at=?8 WHERE id=?9",
                rusqlite::params![name, email, phone, company, notes, lead_status, meta_str, update_now, eid],
            );
            skipped += 1;
            continue;
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let ls = if lead_status.is_empty() { "prospect".to_string() } else { lead_status.clone() };

        let mut meta = serde_json::json!({});
        if !category.is_empty() { meta["category"] = Value::String(category.clone()); }
        if !street.is_empty() { meta["street_address"] = Value::String(street.clone()); }
        if !city.is_empty() { meta["city"] = Value::String(city.clone()); }
        if !state.is_empty() { meta["state"] = Value::String(state.clone()); }
        if !zip.is_empty() { meta["zip_code"] = Value::String(zip.clone()); }
        if !other_cats.is_empty() { meta["other_categories"] = Value::String(other_cats.clone()); }
        if !purchase_freq.is_empty() { meta["purchase_frequency"] = Value::String(purchase_freq.clone()); }
        if !buy_spend.is_empty() { meta["estimated_annual_spend"] = Value::String(buy_spend.clone()); }
        let metadata_str = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());

        let mut cols = Map::new();
        cols.insert("name".into(), Value::String(name.clone()));
        cols.insert("email".into(), if email.is_empty() { Value::Null } else { Value::String(email.clone()) });
        cols.insert("phone".into(), if phone.is_empty() { Value::Null } else { Value::String(phone.clone()) });
        cols.insert("company".into(), if company.is_empty() { Value::Null } else { Value::String(company.clone()) });
        cols.insert("notes".into(), if notes.is_empty() { Value::Null } else { Value::String(notes.clone()) });
        cols.insert("billing_status".into(), Value::String("active".into()));
        cols.insert("lead_status".into(), Value::String(ls.clone()));
        cols.insert("created_at".into(), Value::String(now.clone()));
        cols.insert("updated_at".into(), Value::String(now.clone()));
        cols.insert("metadata".into(), Value::String(metadata_str.clone()));

        match sync::record_upsert("clients", &id, cols) {
            Ok(()) => {},
            Err(e) => { errors.push(format!("{}: sync error: {}", name, e)); continue; }
        }

        let insert_res = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,lead_status,created_at,updated_at,metadata) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                rusqlite::params![id, name, if email.is_empty() { None::<String> } else { Some(email) }, if phone.is_empty() { None::<String> } else { Some(phone) }, if company.is_empty() { None::<String> } else { Some(company) }, if notes.is_empty() { None::<String> } else { Some(notes) }, "active", ls, now, now, metadata_str],
            ).map_err(|e| e.to_string())
        };

        match insert_res {
            Ok(_) => new_clients += 1,
            Err(e) => { errors.push(format!("{}: {}", name, e)); }
        }
    }

    let now = Utc::now().to_rfc3339();
    let log_id = Uuid::new_v4().to_string();
    let errors_json = if errors.is_empty() { None } else { Some(serde_json::to_string(&errors).unwrap_or_default()) };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sheet_sync_log (id, synced_at, new_clients, skipped_duplicates, errors) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![log_id, now, new_clients, skipped, errors_json],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sheet_sync_config SET last_synced_at=?1, last_synced_count=?2 WHERE id=1",
            rusqlite::params![now, new_clients],
        ).map_err(|e| e.to_string())?;
    }

    Ok(SheetSyncResult { new_clients, skipped_duplicates: skipped, errors })
}

#[tauri::command]
pub async fn get_sheet_sync_log() -> Result<Vec<SheetSyncLogEntry>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, synced_at, new_clients, skipped_duplicates, errors FROM sheet_sync_log ORDER BY synced_at DESC LIMIT 10"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(SheetSyncLogEntry {
            id: r.get(0)?, synced_at: r.get(1)?,
            new_clients: r.get(2)?, skipped_duplicates: r.get(3)?,
            errors: r.get(4)?,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn spawn_periodic_sheet_sync(interval_secs: u64) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        loop {
            interval.tick().await;
            if let Err(e) = sync_from_sheet().await {
                tracing::warn!("periodic sheet sync failed: {}", e);
            }
        }
    });
}

// ============================================================
//  Geocoding
// ============================================================

#[derive(Serialize)]
pub struct GeocodeResult {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Serialize)]
pub struct GeocodeSummary {
    pub total: u32,
    pub matched: u32,
    pub skipped: u32,
    pub not_found: u32,
    pub message: String,
}

#[tauri::command]
pub async fn geocode_client(client_id: String) -> Result<GeocodeResult, String> {
    let lookup = crate::geocode::get().ok_or("geocode not initialized")?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    let (meta_str,): (Option<String>,) = conn
        .query_row("SELECT metadata FROM clients WHERE id=?1", [&client_id], |r| Ok((r.get(0)?,)))
        .map_err(|e| e.to_string())?;

    let mut meta: serde_json::Map<String, Value> = match &meta_str {
        Some(s) => serde_json::from_str(s).unwrap_or_else(|_| serde_json::Map::new()),
        None => serde_json::Map::new(),
    };

    if let Some(lat) = meta.get("lat").and_then(|v| v.as_f64()) {
        let lng = meta.get("lng").and_then(|v| v.as_f64()).unwrap_or(0.0);
        return Ok(GeocodeResult { lat, lng });
    }

    let city = meta.get("city").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state = meta.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if city.is_empty() || state.is_empty() {
        return Err("client has no city/state".into());
    }

    let (lat, lng) = lookup.lookup(&city, &state).ok_or("city not found in dataset")?;

    meta.insert("lat".into(), json!(lat));
    meta.insert("lng".into(), json!(lng));
    let metadata_str = serde_json::to_string(&meta).map_err(|e| e.to_string())?;

    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("metadata".into(), Value::String(metadata_str.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("clients", &client_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE clients SET metadata=?1, updated_at=?2 WHERE id=?3",
        rusqlite::params![metadata_str, now, client_id],
    ).map_err(|e| e.to_string())?;

    Ok(GeocodeResult { lat, lng })
}

#[tauri::command]
pub async fn geocode_all_clients() -> Result<GeocodeSummary, String> {
    let lookup = match crate::geocode::get() {
        Some(l) => l,
        None => return Err("geocode not initialized — CSV may not have loaded".into()),
    };

    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, metadata FROM clients")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let total = rows.len();
    let mut matched = 0u32;
    let mut skipped = 0u32;
    let mut not_found = 0u32;
    let mut sample_logged = false;

    for (id, meta_str) in &rows {
        let mut meta: serde_json::Map<String, Value> = match meta_str {
            Some(s) => serde_json::from_str(s).unwrap_or_else(|_| serde_json::Map::new()),
            None => serde_json::Map::new(),
        };

        if meta.get("lat").and_then(|v| v.as_f64()).is_some() {
            skipped += 1;
            continue;
        }

        let city = meta.get("city").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let state = meta.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if city.is_empty() || state.is_empty() {
            skipped += 1;
            if !sample_logged && !city.is_empty() {
                tracing::info!("geocode sample: city={:?}, state={:?}", city, state);
                sample_logged = true;
            }
            continue;
        }

        if !sample_logged {
            tracing::info!("geocode sample: city={:?}, state={:?}", city, state);
            sample_logged = true;
        }

        match lookup.lookup(&city, &state) {
            Some((lat, lng)) => {
                meta.insert("lat".into(), json!(lat));
                meta.insert("lng".into(), json!(lng));
                let metadata_str = serde_json::to_string(&meta).map_err(|e| e.to_string())?;

                let now = Utc::now().to_rfc3339();
                let mut cols = Map::new();
                cols.insert("metadata".into(), Value::String(metadata_str.clone()));
                cols.insert("updated_at".into(), Value::String(now.clone()));
                if let Err(e) = sync::record_upsert("clients", id, cols) {
                    tracing::warn!("geocode: sync failed for client {}: {}", id, e);
                    continue;
                }

                let conn = pool().get().map_err(|e| e.to_string())?;
                if let Err(e) = conn.execute(
                    "UPDATE clients SET metadata=?1, updated_at=?2 WHERE id=?3",
                    rusqlite::params![metadata_str, now, id],
                ) {
                    tracing::warn!("geocode: db update failed for client {}: {}", id, e);
                    continue;
                }

                matched += 1;
            }
            None => {
                tracing::debug!("geocode: not found for city={:?}, state={:?}", city, state);
                not_found += 1;
            }
        }
    }

    let msg = format!(
        "geocode: matched {}/{}, skipped {} (already geocoded or no city/state), {} not found in dataset",
        matched, total, skipped, not_found
    );
    tracing::info!("{}", msg);
    Ok(GeocodeSummary { total: total as u32, matched, skipped, not_found, message: msg })
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
