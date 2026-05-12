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
    pub cost_items_json: Option<String>,
    pub total_cost: Option<f64>,
    pub profit: Option<f64>,
    pub margin: Option<f64>,
}

#[tauri::command]
pub async fn list_invoices() -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin
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
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_invoice(id: String) -> Result<Invoice, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin
         FROM invoices WHERE id=?1",
        [&id],
        |r| Ok(Invoice {
            id: r.get(0)?, client_id: r.get(1)?, number: r.get(2)?,
            issue_date: r.get(3)?, due_date: r.get(4)?, line_items_json: r.get(5)?,
            subtotal: r.get(6)?, tax: r.get(7)?, total: r.get(8)?, status: r.get(9)?,
            pdf_path: r.get(10)?, sent_at: r.get(11)?, notes: r.get(12)?,
            cost_items_json: r.get(13)?, total_cost: r.get(14)?,
            profit: r.get(15)?, margin: r.get(16)?,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_invoices_for_client(client_id: String) -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin
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
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct InvoiceInput {
    pub client_id: String,
    pub due_date: String,
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
    let issue = now.to_rfc3339();
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
    Ok(())
}

#[tauri::command]
pub async fn mark_invoice_deposit_pending(invoice_id: String) -> Result<(), String> {
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String("deposit_pending".into()));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE invoices SET status='deposit_pending' WHERE id=?1",
        [&invoice_id],
    )
    .map_err(|e| e.to_string())?;
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
            "SELECT COALESCE(SUM(total),0) FROM invoices WHERE status IN ('sent','overdue','deposit_pending')",
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
            "SELECT COALESCE(SUM(total_cost),0) FROM invoices WHERE status='paid'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let total_profit: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(profit),0) FROM invoices WHERE status='paid'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let avg_margin: f64 = conn
        .query_row(
            "SELECT COALESCE(AVG(CASE WHEN total>0 THEN (profit/total)*100 END),0) FROM invoices WHERE status='paid' AND profit IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    let monthly_profit: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m', issue_date) as m, COALESCE(SUM(total),0), COALESCE(SUM(total_cost),0), COALESCE(SUM(profit),0)
             FROM invoices WHERE status='paid' AND issue_date >= date('now','-6 months') GROUP BY m ORDER BY m"
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
             WHERE i.status='paid' AND i.profit IS NOT NULL
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
    }))
}

#[tauri::command]
pub async fn get_monthly_profit(month: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT date(issue_date) as d, COALESCE(SUM(profit),0)
         FROM invoices WHERE status='paid' AND strftime('%Y-%m', issue_date) = ?1
         GROUP BY d ORDER BY d"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&month], |r| {
        Ok(json!({ "day": r.get::<_, String>(0)?, "profit": r.get::<_, f64>(1)? }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
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
    pub errors: Vec<String>,
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
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut sent: u32 = 0;
    let mut failed: u32 = 0;
    let mut errors: Vec<String> = Vec::new();
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
                        let err_msg = format!("{}: {}", name, e);
                        errors.push(err_msg.clone());
                        let _ = conn.execute(
                            "INSERT INTO newsletter_sends (id, newsletter_id, client_id, status, error) VALUES (?1, ?2, ?3, 'failed', ?4)",
                            rusqlite::params![sid, &newsletter_id, cid, &err_msg],
                        );
                    }
                }
            }
            _ => {
                failed += 1;
                let err_msg = format!("{}: no email address", name);
                errors.push(err_msg.clone());
                let _ = conn.execute(
                    "INSERT INTO newsletter_sends (id, newsletter_id, client_id, status, error) VALUES (?1, ?2, ?3, 'failed', ?4)",
                    rusqlite::params![sid, &newsletter_id, cid, &err_msg],
                );
            }
        }
    }

    conn.execute(
        "UPDATE newsletters SET status='sent', recipient_count=?1, sent_count=?2, sent_at=?3 WHERE id=?4",
        rusqlite::params![total, sent, &now, &newsletter_id],
    ).map_err(|e| e.to_string())?;

    Ok(NewsletterSendResult { sent, failed, errors })
}

#[tauri::command]
pub async fn ai_draft_newsletter(prompt: String, tone: String) -> Result<String, String> {
    crate::ai::draft_newsletter(&prompt, &tone)
        .await
        .map_err(|e| e.to_string())
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
    if first_name_col.is_empty() { first_name_col = "E".into(); }
    if last_name_col.is_empty() { last_name_col = "F".into(); }
    if email_col.is_empty() { email_col = "I".into(); }
    if phone_col.is_empty() { phone_col = "L".into(); }
    if company_col.is_empty() { company_col = "D".into(); }
    if category_col.is_empty() { category_col = "J".into(); }
    if lead_status_col.is_empty() { lead_status_col = "W".into(); }
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

        if name.is_empty() && email.is_empty() { continue; }

        if !email.is_empty() && !email.contains('@') {
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

        if existing_id.is_some() {
            skipped += 1;
            continue;
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let ls = if lead_status.is_empty() { "prospect".to_string() } else { lead_status.clone() };

        let mut meta = serde_json::json!({});
        if !category.is_empty() { meta["category"] = Value::String(category.clone()); }
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
//  Helpers
// ============================================================

fn to_value(opt: Option<String>) -> Value {
    match opt {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}
