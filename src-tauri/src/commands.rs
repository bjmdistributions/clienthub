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
    pub country: Option<String>,
    pub next_follow_up_date: Option<String>,
    pub needs_review: bool,
    pub is_blacklisted: bool,
    pub approval_status: String,
    /// Real columns (promoted out of metadata so later metadata writes can't clear
    /// them). The UI reads these; metadata still mirrors them for older readers.
    pub high_value: bool,
    pub exclusive: bool,
    /// True when we have NEVER sent this client any email: no sent newsletter, no
    /// invoice/quote with a sent date, and no outbound-email interaction. Incoming
    /// email does NOT clear it. Computed in SQL (see `FIRST_CONTACT_SQL`).
    #[serde(default)]
    pub first_contact: bool,
}

/// SQL boolean (1/0) that is true when the client (alias `c`) has never been
/// emailed by us. Correlated `NOT EXISTS` subqueries — no N+1. Append as
/// `, {FIRST_CONTACT_SQL} AS first_contact` to any `... FROM clients c` select and
/// read with `r.get::<_, i64>("first_contact")? != 0`.
/// Deal-flow stages considered COMMITTED for the DASHBOARD cash-position math: the
/// deal has progressed past the speculative start (`none` / `invoiced`) so its
/// money is real. Jack's complaint was that early speculative invoices (still at
/// `invoiced`) inflate the "owed / you owe" hero. Change this ONE list to move the
/// threshold. Void invoices are excluded separately. The detailed Receivables /
/// Payables VIEWS still show everything — only the dashboard summary uses this.
/// Used for AP (deal-flow payables): you owe a supplier only once the deal is real.
const COMMITTED_DEAL_STAGES: &str = "'supplier_paid','payment_received','complete'";
/// AR (invoices) variant. Invoices default to `deal_flow_stage='none'` when they are
/// standalone bills NOT tied to a deal-flow pipeline — those are REAL receivables, so
/// `none` counts as committed. The ONLY speculative AR stage is `invoiced` (a deal-flow
/// quote whose customer has not paid yet). So AR-committed = everything except `invoiced`.
const COMMITTED_AR_STAGES: &str = "'none','supplier_paid','payment_received','complete'";

const FIRST_CONTACT_SQL: &str = "CASE WHEN \
    NOT EXISTS (SELECT 1 FROM newsletter_sends ns WHERE ns.client_id=c.id AND ns.status='sent') \
    AND NOT EXISTS (SELECT 1 FROM invoices iv WHERE iv.client_id=c.id AND COALESCE(iv.sent_at,'') <> '' AND COALESCE(iv.archived,0)=0) \
    AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.client_id=c.id AND COALESCE(q.sent_at,'') <> '') \
    AND NOT EXISTS (SELECT 1 FROM interactions ix WHERE ix.client_id=c.id AND ix.kind='email_out') \
    THEN 1 ELSE 0 END";

fn extract_meta_str(meta: &Option<Value>, key: &str) -> Option<String> {
    meta.as_ref()?.get(key)?.as_str().map(|s| s.to_string())
}

/// Read a boolean flag from metadata, tolerating JSON bool, 1/0, or "true".
/// Used as a fallback for high_value/exclusive so rows that only ever had the flag
/// in metadata (e.g. synced from an older peer) still read as true.
fn meta_flag(meta: &Option<Value>, key: &str) -> bool {
    match meta.as_ref().and_then(|m| m.get(key)) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true") || s == "1",
        _ => false,
    }
}

fn extract_client_fields(meta: &Option<Value>) -> (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, bool) {
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
        extract_meta_str(meta, "country"),
        extract_meta_str(meta, "next_follow_up_date"),
        needs_review,
    )
}

#[derive(serde::Serialize)]
pub struct ClientActivity {
    pub client_id: String,
    pub kind: String,
    pub at: String,
}

/// The single most-recent activity per client (kind + timestamp) across sent
/// invoices, sent quotes, sent newsletters, and logged interactions. Returned
/// separately from the client list so the UI can show what the last touch was
/// (Invoice / Quote / Newsletter / Call …) without reshaping the Client row.
#[tauri::command]
pub async fn client_last_activity() -> Result<Vec<ClientActivity>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT client_id, kind, at FROM (
               SELECT client_id, kind, at,
                      ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY at DESC) rn
               FROM (
                 SELECT client_id, 'invoice' AS kind, sent_at AS at FROM invoices WHERE COALESCE(sent_at,'') <> '' AND COALESCE(archived,0)=0
                 UNION ALL SELECT client_id, 'quote', sent_at FROM quotes WHERE COALESCE(sent_at,'') <> ''
                 UNION ALL SELECT client_id, 'newsletter', sent_at FROM newsletter_sends WHERE status='sent' AND COALESCE(sent_at,'') <> ''
                 UNION ALL SELECT client_id, kind, created_at FROM interactions
                          WHERE kind IN ('checkup','call','note','meeting','email_in','email_out') AND COALESCE(created_at,'') <> ''
               )
             ) WHERE rn = 1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(ClientActivity { client_id: r.get(0)?, kind: r.get(1)?, at: r.get(2)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn list_clients() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
            "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                    NULLIF(MAX(COALESCE((SELECT MAX(sent_at) FROM invoices WHERE client_id=c.id AND COALESCE(archived,0)=0),''),
                               COALESCE((SELECT MAX(sent_at) FROM quotes WHERE client_id=c.id),''),
                    COALESCE((SELECT MAX(created_at) FROM interactions WHERE client_id=c.id AND kind IN ('checkup','call','note','meeting')),'')),''),
                    MAX(0, COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0) - {refunded}),
                    COALESCE(c.is_blacklisted,0),
                    COALESCE(c.approval_status,'active'),
                    COALESCE(c.high_value,0),
                    COALESCE(c.exclusive,0),
                    ({fc}) AS first_contact
             FROM clients c
             ORDER BY c.name", fc = FIRST_CONTACT_SQL, refunded = CLIENT_REFUNDED_SQL);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            let high_value = r.get::<_, i64>(16)? != 0 || meta_flag(&meta, "high_value");
            let exclusive = r.get::<_, i64>(17)? != 0 || meta_flag(&meta, "exclusive");
            let first_contact = r.get::<_, i64>("first_contact")? != 0;
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
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: r.get::<_, i64>(14)? != 0,
                approval_status: r.get(15)?,
                high_value,
                exclusive,
                first_contact,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Distinct sales-rep names present on clients (lead_representative / source_rep),
/// for the clients rep filter.
#[tauri::command]
pub async fn list_client_reps() -> Result<Vec<String>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT rep FROM (
           SELECT json_extract(metadata,'$.lead_representative') AS rep FROM clients
           UNION
           SELECT json_extract(metadata,'$.source_rep') FROM clients
         ) WHERE rep IS NOT NULL AND rep != '' ORDER BY rep COLLATE NOCASE",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_client(id: String) -> Result<Option<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                NULLIF(MAX(COALESCE((SELECT MAX(sent_at) FROM invoices WHERE client_id=c.id AND COALESCE(archived,0)=0),''),
                           COALESCE((SELECT MAX(sent_at) FROM quotes WHERE client_id=c.id),''),
                    COALESCE((SELECT MAX(created_at) FROM interactions WHERE client_id=c.id AND kind IN ('checkup','call','note','meeting')),'')),''),
                MAX(0, COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0) - {refunded}),
                COALESCE(c.is_blacklisted,0),
                COALESCE(c.approval_status,'active'),
                COALESCE(c.high_value,0),
                COALESCE(c.exclusive,0),
                ({fc}) AS first_contact
         FROM clients c
         WHERE c.id=?1", fc = FIRST_CONTACT_SQL, refunded = CLIENT_REFUNDED_SQL);
    let res: rusqlite::Result<Client> = conn.query_row(
        &sql,
        [&id],
        |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            let high_value = r.get::<_, i64>(16).unwrap_or(0) != 0 || meta_flag(&meta, "high_value");
            let exclusive = r.get::<_, i64>(17).unwrap_or(0) != 0 || meta_flag(&meta, "exclusive");
            let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
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
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: r.get::<_, i64>(14).unwrap_or(0) != 0,
                approval_status: r.get::<_, String>(15).unwrap_or_else(|_| "active".into()),
                high_value,
                exclusive,
                first_contact,
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
    pub country: Option<String>,
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
    if let Some(v) = &input.country { meta["country"] = Value::String(v.clone()); }
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

    // Non-admin reps create pending clients that an admin must approve — UNLESS
    // this add duplicates a client already in the database (same email, or same
    // name when no email). A returning/existing customer must NEVER land in the
    // pending-review queue, so in that case we skip the pending flag + approval and
    // leave the client active (it's already known to the business).
    let is_duplicate = find_duplicate_client(&input.email, &input.name, &id).is_some();
    let approval_status = if !is_duplicate
        && !crate::employees::session_is_privileged()
        && crate::employees::approval_required("require_client_add_approval")
    {
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("UPDATE clients SET approval_status='pending' WHERE id=?1", rusqlite::params![id])
                .map_err(|e| e.to_string())?;
        }
        let mut acols = Map::new();
        acols.insert("approval_status".into(), Value::String("pending".into()));
        sync::record_upsert("clients", &id, acols).map_err(|e| e.to_string())?;
        queue_client_approval("client_add", &id, &format!("New client: {}", input.name))?;
        "pending"
    } else {
        "active"
    };

    Ok(Client {
        id, name: input.name, email: input.email, phone: input.phone,
        company: input.company, notes: input.notes, billing_status: "active".into(),
        lead_status: lead_status_val, created_at: now.clone(), updated_at: now,
        metadata: Some(meta), invoice_count: 0, last_contact_at: None,
        total_revenue: 0.0,
        category: input.category, tags: input.tags,
        street_address: input.street_address, city: input.city,
        state: input.state, zip_code: input.zip_code, country: input.country,
        next_follow_up_date: input.next_follow_up_date,
        needs_review: input.needs_review.unwrap_or(false),
        is_blacklisted: false,
        approval_status: approval_status.into(),
        high_value: false,
        exclusive: false,
        // A just-created client has never been emailed.
        first_contact: true,
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

    // Preserve metadata keys this form doesn't manage (high_value, exclusive,
    // credit_limit, lead_representative, …): start from the STORED metadata and
    // overlay only what the caller explicitly provided. (Previously this started
    // from {} and silently wiped those keys on every client edit.)
    let mut meta = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let existing: String = conn
            .query_row("SELECT COALESCE(metadata,'{}') FROM clients WHERE id=?1", [&id], |r| r.get(0))
            .unwrap_or_else(|_| "{}".into());
        let mut m: Value = serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}));
        if let (Some(mo), Some(io)) = (m.as_object_mut(), input.metadata.as_ref().and_then(|v| v.as_object())) {
            for (k, v) in io { mo.insert(k.clone(), v.clone()); }
        }
        m
    };
    if let Some(v) = &input.category { meta["category"] = Value::String(v.clone()); }
    if let Some(v) = &input.tags { meta["tags"] = Value::String(v.clone()); }
    if let Some(v) = &input.street_address { meta["street_address"] = Value::String(v.clone()); }
    if let Some(v) = &input.city { meta["city"] = Value::String(v.clone()); }
    if let Some(v) = &input.state { meta["state"] = Value::String(v.clone()); }
    if let Some(v) = &input.zip_code { meta["zip_code"] = Value::String(v.clone()); }
    if let Some(v) = &input.country { meta["country"] = Value::String(v.clone()); }
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

/// Set (or clear, when 0) a client's credit limit — stored in metadata.credit_limit.
#[tauri::command]
pub async fn set_client_credit_limit(id: String, limit: f64) -> Result<(), String> {
    let existing: String = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COALESCE(metadata,'{}') FROM clients WHERE id=?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?
    };
    let mut m: Value = serde_json::from_str(&existing).unwrap_or_else(|_| json!({}));
    if let Some(o) = m.as_object_mut() {
        if limit > 0.0 { o.insert("credit_limit".into(), json!(limit)); } else { o.remove("credit_limit"); }
    }
    let meta_str = serde_json::to_string(&m).unwrap_or_else(|_| "{}".into());
    let mut cols = Map::new();
    cols.insert("metadata".into(), Value::String(meta_str.clone()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE clients SET metadata=?1 WHERE id=?2", rusqlite::params![meta_str, id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// A client's credit status: their limit, current exposure (open AR = sent/overdue
/// invoice totals), available headroom, and whether they're over the limit.
#[tauri::command]
pub async fn get_client_credit_status(id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let meta: String = conn.query_row("SELECT COALESCE(metadata,'{}') FROM clients WHERE id=?1", [&id], |r| r.get(0)).unwrap_or_else(|_| "{}".into());
    let limit = serde_json::from_str::<Value>(&meta).ok()
        .and_then(|m| m.get("credit_limit").and_then(|v| v.as_f64())).unwrap_or(0.0);
    let exposure: f64 = conn.query_row(
        "SELECT COALESCE(SUM(total),0) FROM invoices WHERE client_id=?1 AND status IN ('sent','overdue') AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0",
        [&id], |r| r.get(0)).unwrap_or(0.0);
    Ok(json!({
        "credit_limit": limit, "exposure": exposure,
        "available": limit - exposure, "over": limit > 0.0 && exposure > limit,
    }))
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
pub async fn toggle_client_blacklist(id: String) -> Result<bool, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE clients SET is_blacklisted = CASE WHEN is_blacklisted THEN 0 ELSE 1 END WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    let val: i64 = conn.query_row("SELECT is_blacklisted FROM clients WHERE id=?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("is_blacklisted".into(), Value::Number(serde_json::Number::from(val)));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    Ok(val != 0)
}

/// "Exclusive" clients (e.g. VIPs) are kept off mass sends + auto-add — softer than a
/// blacklist. Stored in the real `exclusive` column (so later metadata writes can't
/// clobber it); metadata.exclusive is kept mirrored for server/mobile readers.
#[tauri::command]
pub async fn toggle_client_exclusive(id: String) -> Result<bool, String> {
    toggle_client_flag(&id, "exclusive")
}

/// A "High-Value" badge. Stored in the real `high_value` column; metadata mirror
/// kept in sync. Purely cosmetic — no effect on sends (unlike `exclusive`).
#[tauri::command]
pub async fn toggle_client_high_value(id: String) -> Result<bool, String> {
    toggle_client_flag(&id, "high_value")
}

/// Flip a boolean client flag that lives in a real column (`high_value` /
/// `exclusive`) AND is mirrored into metadata. Writes + syncs both the column and
/// the metadata mirror so every reader (desktop column, older metadata readers on
/// server/mobile) stays consistent. Returns the new value.
fn toggle_client_flag(id: &str, col: &str) -> Result<bool, String> {
    debug_assert!(col == "high_value" || col == "exclusive");
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (cur, meta): (i64, String) = conn.query_row(
        &format!("SELECT COALESCE({col},0), COALESCE(metadata,'{{}}') FROM clients WHERE id=?1"),
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let next = cur == 0;
    let mut m: Value = serde_json::from_str(&meta).unwrap_or_else(|_| json!({}));
    if let Some(o) = m.as_object_mut() { o.insert(col.into(), json!(next)); }
    let meta_str = serde_json::to_string(&m).unwrap_or_else(|_| "{}".into());
    conn.execute(
        &format!("UPDATE clients SET {col}=?1, metadata=?2 WHERE id=?3"),
        rusqlite::params![next as i64, meta_str, id],
    ).map_err(|e| e.to_string())?;
    // Sync BOTH the column and the metadata mirror so all readers converge.
    let mut cols = Map::new();
    cols.insert(col.into(), json!(next as i64));
    cols.insert("metadata".into(), Value::String(meta_str));
    sync::record_upsert("clients", id, cols).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Whether tier-ranked clients are included by default in mass "select all" sends.
#[tauri::command]
pub async fn get_newsletter_include_ranked() -> Result<bool, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let v: String = conn.query_row("SELECT value FROM settings WHERE key='newsletter_include_ranked'", [], |r| r.get(0)).unwrap_or_else(|_| "1".into());
    Ok(v != "0" && !v.eq_ignore_ascii_case("false"))
}

#[tauri::command]
pub async fn set_newsletter_include_ranked(value: bool) -> Result<(), String> {
    let v = if value { "1" } else { "0" };
    { let conn = pool().get().map_err(|e| e.to_string())?;
      conn.execute("INSERT INTO settings (key,value) VALUES ('newsletter_include_ranked',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [v]).map_err(|e| e.to_string())?; }
    let mut cols = Map::new();
    cols.insert("value".into(), Value::String(v.to_string()));
    sync::record_upsert("settings", "newsletter_include_ranked", cols).map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether newsletters include the CAN-SPAM unsubscribe footer. Defaults ON — a missing
/// key reads as enabled so a fresh install is compliant out of the box.
#[tauri::command]
pub async fn get_newsletter_unsubscribe_enabled() -> Result<bool, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let v: String = conn.query_row("SELECT value FROM settings WHERE key='newsletter_unsubscribe_enabled'", [], |r| r.get(0)).unwrap_or_else(|_| "1".into());
    Ok(v != "0" && !v.eq_ignore_ascii_case("false"))
}

#[tauri::command]
pub async fn set_newsletter_unsubscribe_enabled(value: bool) -> Result<(), String> {
    let v = if value { "1" } else { "0" };
    { let conn = pool().get().map_err(|e| e.to_string())?;
      conn.execute("INSERT INTO settings (key,value) VALUES ('newsletter_unsubscribe_enabled',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [v]).map_err(|e| e.to_string())?; }
    let mut cols = Map::new();
    cols.insert("value".into(), Value::String(v.to_string()));
    sync::record_upsert("settings", "newsletter_unsubscribe_enabled", cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn approve_client(id: String) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE clients SET approval_status='active', updated_at=?1 WHERE id=?2", rusqlite::params![Utc::now().to_rfc3339(), id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("approval_status".into(), Value::String("active".into()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    // Resolve the synced approval queue row so the server + mobile/web stop
    // showing this already-approved lead as pending.
    resolve_client_approvals(&id, "approved")?;
    // Write the approved lead back to the connected sheet + archive its source
    // email (both best-effort — a failure never blocks approval).
    match crate::sheet_writeback::upsert_approved_client(&id).await {
        Ok(true) => tracing::info!("wrote approved client {} back to sheet", id),
        Ok(false) => {}
        Err(e) => tracing::warn!("sheet write-back for {} failed: {}", id, e),
    }
    archive_source_email_for_client(&id).await;
    // Push the approval to the server promptly so other devices reflect it.
    crate::netsync::push_now();
    Ok(())
}

#[tauri::command]
pub async fn reject_client(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE clients SET approval_status='rejected', updated_at=?1 WHERE id=?2", rusqlite::params![Utc::now().to_rfc3339(), id]).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("approval_status".into(), Value::String("rejected".into()));
    sync::record_upsert("clients", &id, cols).map_err(|e| e.to_string())?;
    // Resolve the synced approval queue row so the server + mobile/web stop
    // showing this already-rejected lead as pending.
    resolve_client_approvals(&id, "rejected")?;
    // Push the rejection to the server promptly so other devices reflect it.
    crate::netsync::push_now();
    Ok(())
}

#[tauri::command]
pub async fn get_pending_approvals() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                NULL,
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                COALESCE(c.is_blacklisted,0),
                COALESCE(c.approval_status,'active'),
                ({fc}) AS first_contact
         FROM clients c
         WHERE c.approval_status = 'pending'
         ORDER BY c.created_at ASC", fc = FIRST_CONTACT_SQL);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        let high_value = meta_flag(&meta, "high_value");
        let exclusive = meta_flag(&meta, "exclusive");
        let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
            total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
            needs_review,
            is_blacklisted: r.get::<_, i64>(14).unwrap_or(0) != 0,
            approval_status: r.get::<_, String>(15).unwrap_or_else(|_| "active".into()),
            high_value,
            exclusive,
            first_contact,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ── Admin approval queue (rep client add/delete requests) ───────────────────

#[tauri::command]
pub async fn list_approval_requests() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,kind,entity_id,summary,requested_by_name,created_at
         FROM pending_approvals WHERE status='pending' ORDER BY created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "id": r.get::<_, String>(0)?,
        "kind": r.get::<_, String>(1)?,
        "entity_id": r.get::<_, Option<String>>(2)?,
        "summary": r.get::<_, String>(3)?,
        "requested_by_name": r.get::<_, Option<String>>(4)?,
        "created_at": r.get::<_, String>(5)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn approval_requests_count() -> Result<i64, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(conn.query_row("SELECT COUNT(*) FROM pending_approvals WHERE status='pending'", [], |r| r.get(0)).unwrap_or(0))
}

fn delete_client_row(id: &str) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM clients WHERE id=?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    }
    sync::record_delete("clients", id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve any synced `pending_approvals` rows (kind='client_add') queued for a
/// client so the amber-banner approve/reject path converges with the server +
/// mobile/web queue. Idempotent: zero matching rows is a clean no-op.
fn resolve_client_approvals(client_id: &str, status: &str) -> Result<(), String> {
    let ids: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id FROM pending_approvals WHERE entity_id=?1 AND kind='client_add' AND status='pending'",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![client_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in ids {
        let now = Utc::now().to_rfc3339();
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("UPDATE pending_approvals SET status=?1, resolved_at=?2 WHERE id=?3",
                rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
        }
        let mut cols = Map::new();
        cols.insert("status".into(), Value::String(status.into()));
        cols.insert("resolved_at".into(), Value::String(now));
        sync::record_upsert("pending_approvals", &id, cols).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Approve or reject a queued request. Approving an add activates the pending
/// client; approving a delete removes the client; rejecting an add discards the
/// pending client; rejecting a delete leaves it.
#[tauri::command]
pub async fn resolve_approval_request(id: String, approve: bool) -> Result<(), String> {
    let (kind, entity): (String, Option<String>) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT kind, entity_id FROM pending_approvals WHERE id=?1 AND status='pending'",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|_| "request not found".to_string())?
    };
    if let Some(eid) = entity.as_deref() {
        match (kind.as_str(), approve) {
            ("client_add", true) => {
                {
                    let conn = pool().get().map_err(|e| e.to_string())?;
                    conn.execute("UPDATE clients SET approval_status='active', updated_at=?1 WHERE id=?2",
                        rusqlite::params![Utc::now().to_rfc3339(), eid]).map_err(|e| e.to_string())?;
                }
                let mut cols = Map::new();
                cols.insert("approval_status".into(), Value::String("active".into()));
                sync::record_upsert("clients", eid, cols).map_err(|e| e.to_string())?;
                // Ensure any categories captured on this client exist in the system
                // category list (case-insensitive dedup) — idempotent if already added.
                let cats: Vec<String> = {
                    let conn = pool().get().map_err(|e| e.to_string())?;
                    let meta: Option<String> = conn.query_row("SELECT metadata FROM clients WHERE id=?1", [eid], |r| r.get(0)).ok().flatten();
                    meta.and_then(|m| serde_json::from_str::<Value>(&m).ok())
                        .and_then(|v| v.get("categories").and_then(|c| c.as_array()).map(|a| {
                            a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
                        }))
                        .unwrap_or_default()
                };
                if !cats.is_empty() { ensure_system_categories(&cats); }
                // Write the approved lead back to the connected Google Sheet (new
                // direction). Best-effort: silently skips if no sheet/token is set,
                // and never blocks the approval on a sheet error.
                match crate::sheet_writeback::upsert_approved_client(eid).await {
                    Ok(true) => tracing::info!("wrote approved client {} back to sheet", eid),
                    Ok(false) => {}
                    Err(e) => tracing::warn!("sheet write-back for {} failed: {}", eid, e),
                }
                // Archive the source email from its inbox now that the lead is
                // approved (best-effort — never blocks approval).
                archive_source_email_for_client(eid).await;
            }
            ("client_add", false) | ("client_delete", true) => delete_client_row(eid)?,
            _ => {}
        }
    }
    let status = if approve { "approved" } else { "rejected" };
    let now = Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE pending_approvals SET status=?1, resolved_at=?2 WHERE id=?3",
            rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String(status.into()));
    cols.insert("resolved_at".into(), Value::String(now));
    sync::record_upsert("pending_approvals", &id, cols).map_err(|e| e.to_string())?;
    // Push the resolution to the server immediately so other devices stop showing
    // this lead as pending (rather than waiting for the next 20s poll tick).
    crate::netsync::push_now();
    Ok(())
}

/// Read a captured lead's stored source-email identity from its metadata:
/// `src_inbox` (inbox label) + `src_uid` (IMAP uid). Returns None when the client
/// wasn't captured from an inbox (nothing to archive).
fn client_source_email(client_id: &str) -> Option<(String, u32)> {
    let conn = pool().get().ok()?;
    let meta: Option<String> = conn
        .query_row("SELECT metadata FROM clients WHERE id=?1", [client_id], |r| r.get(0))
        .ok()
        .flatten();
    let v: Value = serde_json::from_str(&meta?).ok()?;
    let inbox = v.get("src_inbox").and_then(|x| x.as_str())?.to_string();
    let uid = v.get("src_uid").and_then(|x| x.as_u64())? as u32;
    if inbox.is_empty() || uid == 0 { return None; }
    Some((inbox, uid))
}

/// Archive the source email of a captured lead (best-effort). Marks the original
/// inbox message Seen + moves it to Archive + Deleted/expunge. Never errors on an
/// IMAP failure — approving a lead must not be blocked by mail-server issues.
/// No-op when the client has no recorded source email.
async fn archive_source_email_for_client(client_id: &str) {
    let (inbox, uid) = match client_source_email(client_id) {
        Some(x) => x,
        None => return,
    };
    match crate::email::archive_source_email(&inbox, uid).await {
        Ok(()) => tracing::info!("archived source email (uid {}) for client {}", uid, client_id),
        Err(e) => tracing::warn!("archive source email for {} failed: {}", client_id, e),
    }
}

/// Archive the source email of a captured lead on demand. Exposed for the UI;
/// also invoked automatically on the approve path. Best-effort: returns Ok even
/// when there's nothing to archive or IMAP is unreachable (the failure is logged).
#[tauri::command]
pub async fn archive_client_source_email(client_id: String) -> Result<(), String> {
    archive_source_email_for_client(&client_id).await;
    Ok(())
}

#[tauri::command]
pub async fn get_approval_policy() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let g = |k: &str| -> bool {
        conn.query_row("SELECT value FROM settings WHERE key=?1", [k], |r| r.get::<_, String>(0))
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
    };
    let vis: String = conn.query_row("SELECT value FROM settings WHERE key='checkup_visibility'", [], |r| r.get(0))
        .unwrap_or_else(|_| "team".into());
    Ok(json!({
        "require_client_add_approval": g("require_client_add_approval"),
        "require_client_delete_approval": g("require_client_delete_approval"),
        "checkup_visibility": vis,
    }))
}

#[tauri::command]
pub async fn set_checkup_visibility(visibility: String) -> Result<(), String> {
    let val = if visibility == "private" { "private" } else { "team" };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO settings (key,value) VALUES ('checkup_visibility',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [val]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("value".into(), Value::String(val.into()));
    sync::record_upsert("settings", "checkup_visibility", cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_approval_policy(require_add: bool, require_delete: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (k, v) in [("require_client_add_approval", require_add), ("require_client_delete_approval", require_delete)] {
        let val = if v { "1" } else { "0" };
        conn.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![k, val]).map_err(|e| e.to_string())?;
        let mut cols = Map::new();
        cols.insert("value".into(), Value::String(val.into()));
        sync::record_upsert("settings", k, cols).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a URL in the user's default browser (used by in-app "Setup guide" links).
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// Send a product feature request / bug report to the Ecliptr server.
#[tauri::command]
pub async fn submit_feedback(kind: String, title: String, body: String, name: Option<String>, email: Option<String>) -> Result<(), String> {
    let base = crate::netsync::config()
        .map(|c| c.url.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://ecliptr.app".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "kind": kind, "title": title, "body": body, "app": "desktop",
        "name": name.unwrap_or_default(), "email": email.unwrap_or_default(),
    });
    let resp = client.post(format!("{base}/api/feedback")).json(&payload)
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Server returned {}", resp.status()));
    }
    Ok(())
}

// ── Custom lead forms ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_forms() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,name,title,intro,fields_json,active,created_at,updated_at FROM forms ORDER BY created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "id": r.get::<_, String>(0)?,
        "name": r.get::<_, String>(1)?,
        "title": r.get::<_, String>(2)?,
        "intro": r.get::<_, String>(3)?,
        "fields_json": r.get::<_, String>(4)?,
        "active": r.get::<_, i64>(5)? != 0,
        "created_at": r.get::<_, String>(6)?,
        "updated_at": r.get::<_, String>(7)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn save_form(id: Option<String>, name: String, title: String, intro: String, fields_json: String, active: bool) -> Result<String, String> {
    let now = Utc::now().to_rfc3339();
    let fid = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let act: i64 = if active { 1 } else { 0 };
    let created = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO forms (id,org_id,name,title,intro,fields_json,active,created_at,updated_at)
             VALUES (?1,'org_default',?2,?3,?4,?5,?6,?7,?7)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, title=excluded.title, intro=excluded.intro,
                fields_json=excluded.fields_json, active=excluded.active, updated_at=excluded.updated_at",
            rusqlite::params![fid, name, title, intro, fields_json, act, now],
        ).map_err(|e| e.to_string())?;
        conn.query_row("SELECT created_at FROM forms WHERE id=?1", [&fid], |r| r.get::<_, String>(0)).unwrap_or_else(|_| now.clone())
    };
    let mut cols = Map::new();
    cols.insert("org_id".into(), Value::String("org_default".into()));
    cols.insert("name".into(), Value::String(name));
    cols.insert("title".into(), Value::String(title));
    cols.insert("intro".into(), Value::String(intro));
    cols.insert("fields_json".into(), Value::String(fields_json));
    cols.insert("active".into(), Value::from(act));
    cols.insert("created_at".into(), Value::String(created));
    cols.insert("updated_at".into(), Value::String(now));
    sync::record_upsert("forms", &fid, cols).map_err(|e| e.to_string())?;
    Ok(fid)
}

#[tauri::command]
pub async fn delete_form(id: String) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM forms WHERE id=?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    }
    sync::record_delete("forms", &id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Queue an admin approval row (rep add/delete requests). Returns its id.
/// Find an EXISTING client (other than `exclude_id`) that a new add would
/// duplicate: trimmed + case-insensitive email match first; if no email was
/// given, an exact trimmed (case-insensitive) name match. Mirrors the server's
/// `find_duplicate_client`. Used so a rep manually re-adding someone already in
/// the database does NOT create a second client that lands in pending review.
pub(crate) fn find_duplicate_client(email: &Option<String>, name: &str, exclude_id: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    let email = email.as_deref().map(|e| e.trim()).unwrap_or("");
    if !email.is_empty() {
        return conn
            .query_row(
                "SELECT id FROM clients WHERE LOWER(TRIM(email))=LOWER(TRIM(?1)) AND id<>?2 LIMIT 1",
                rusqlite::params![email, exclude_id],
                |r| r.get::<_, String>(0),
            )
            .ok();
    }
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT id FROM clients WHERE LOWER(TRIM(name))=LOWER(TRIM(?1)) AND id<>?2 LIMIT 1",
        rusqlite::params![name, exclude_id],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

pub(crate) fn queue_client_approval(kind: &str, entity_id: &str, summary: &str) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let (rb, rbn) = match crate::employees::session_actor() {
        Some((i, n)) => (Some(i), Some(n)),
        None => (None, None),
    };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pending_approvals (id,org_id,kind,entity_id,summary,requested_by,requested_by_name,status,created_at)
             VALUES (?1,'org_default',?2,?3,?4,?5,?6,'pending',?7)",
            rusqlite::params![id, kind, entity_id, summary, rb, rbn, now],
        ).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("org_id".into(), Value::String("org_default".into()));
    cols.insert("kind".into(), Value::String(kind.into()));
    cols.insert("entity_id".into(), Value::String(entity_id.into()));
    cols.insert("summary".into(), Value::String(summary.into()));
    if let Some(ref v) = rb { cols.insert("requested_by".into(), Value::String(v.clone())); }
    if let Some(ref v) = rbn { cols.insert("requested_by_name".into(), Value::String(v.clone())); }
    cols.insert("status".into(), Value::String("pending".into()));
    cols.insert("created_at".into(), Value::String(now));
    sync::record_upsert("pending_approvals", &id, cols).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn delete_client(id: String) -> Result<(), String> {
    // Non-admin reps can't delete directly when the org requires approval — queue
    // it for an admin instead (owner PIN / admins delete immediately).
    if !crate::employees::session_is_privileged()
        && crate::employees::approval_required("require_client_delete_approval")
    {
        let name: String = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.query_row("SELECT name FROM clients WHERE id=?1", [&id], |r| r.get(0))
                .map_err(|_| "Client not found".to_string())?
        };
        queue_client_approval("client_delete", &id, &format!("Delete client: {name}"))?;
        return Ok(());
    }
    // Delete locally FIRST. The invoices FK (foreign_keys=ON, NO ACTION) blocks
    // deleting a client that still has invoices; if we recorded the sync delete
    // before this, a phantom delete event would broadcast to other devices even
    // though the client was never actually removed here.
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM clients WHERE id=?1", [&id]).map_err(|e| {
        if e.to_string().contains("FOREIGN KEY") {
            "Cannot delete: this client has invoices. Delete or reassign them first.".to_string()
        } else {
            e.to_string()
        }
    })?;
    sync::record_delete("clients", &id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn bulk_delete_clients(ids: Vec<String>) -> Result<u32, String> {
    let mut count: u32 = 0;
    for id in &ids {
        // Delete locally first; only broadcast the sync delete if it actually
        // succeeded. A client with invoices is FK-blocked and skipped.
        let conn = pool().get().map_err(|e| e.to_string())?;
        if conn.execute("DELETE FROM clients WHERE id=?1", [id]).is_ok() {
            if let Err(e) = sync::record_delete("clients", id) {
                tracing::warn!("sync record_delete for {}: {}", id, e);
            }
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn bulk_update_category(ids: Vec<String>, category: String) -> Result<u32, String> {
    let mut count: u32 = 0;
    for id in &ids {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let meta_str: Option<String> = conn.query_row("SELECT metadata FROM clients WHERE id=?1", [id], |r| r.get(0)).ok();
        let mut meta: Value = meta_str.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(json!({}));
        meta["category"] = Value::String(category.clone());
        let new_meta = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("metadata".into(), Value::String(new_meta.clone()));
        cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("clients", id, cols).map_err(|e| e.to_string())?;
        if conn.execute("UPDATE clients SET metadata=?1, updated_at=?2 WHERE id=?3", rusqlite::params![new_meta, now, id]).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn bulk_update_lead_status(ids: Vec<String>, lead_status: String) -> Result<u32, String> {
    let mut count: u32 = 0;
    for id in &ids {
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("lead_status".into(), Value::String(lead_status.clone()));
        cols.insert("updated_at".into(), Value::String(now.clone()));
        sync::record_upsert("clients", id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        if conn.execute("UPDATE clients SET lead_status=?1, updated_at=?2 WHERE id=?3", rusqlite::params![lead_status, now, id]).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn export_clients_csv(ids: Vec<String>, output_path: String) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    wtr.write_record(["name","company","email","phone","street_address","city","state","zip_code","category","lead_status","tier","total_revenue","last_contact_at"]).map_err(|e| e.to_string())?;

    let mut count: u32 = 0;
    for id in &ids {
        let row: Option<(String,Option<String>,Option<String>,Option<String>,Option<String>,String)> = conn.query_row(
            "SELECT c.name,c.email,c.phone,c.company,c.metadata,c.lead_status FROM clients c WHERE c.id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))
        ).ok();

        if let Some((name,email,phone,company,meta_str,lead_status)) = row {
            let meta: Option<Value> = meta_str.as_deref().and_then(|s| serde_json::from_str(s).ok());
            let street_address = meta.as_ref().and_then(|m|m.get("street_address")).and_then(|v|v.as_str()).unwrap_or("");
            let city = meta.as_ref().and_then(|m|m.get("city")).and_then(|v|v.as_str()).unwrap_or("");
            let state = meta.as_ref().and_then(|m|m.get("state")).and_then(|v|v.as_str()).unwrap_or("");
            let zip_code = meta.as_ref().and_then(|m|m.get("zip_code")).and_then(|v|v.as_str()).unwrap_or("");
            let cat = meta.as_ref().and_then(|m|m.get("category")).and_then(|v|v.as_str()).unwrap_or("");

            let total_rev: f64 = conn.query_row(
                "SELECT COALESCE(SUM(total),0) FROM invoices WHERE client_id=?1 AND status='paid'", [id], |r| r.get(0)
            ).unwrap_or(0.0);

            let last_contact: Option<String> = conn.query_row(
                "SELECT MAX(created_at) FROM interactions WHERE client_id=?1", [id], |r| r.get(0)
            ).ok();

            wtr.write_record(&[
                &name,
                company.as_deref().unwrap_or(""),
                email.as_deref().unwrap_or(""),
                phone.as_deref().unwrap_or(""),
                street_address, city, state, zip_code, cat, &lead_status, "",
                &format!("{:.2}", total_rev),
                last_contact.as_deref().unwrap_or(""),
            ]).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn export_invoices_csv(output_path: String) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    wtr.write_record(["number","client","issue_date","due_date","status","subtotal","tax","total","cost","profit","margin"]).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT i.number,COALESCE(c.name,''),i.issue_date,i.due_date,i.status,i.subtotal,i.tax,i.total,i.total_cost,i.profit,i.margin
         FROM invoices i LEFT JOIN clients c ON c.id=i.client_id ORDER BY i.issue_date DESC"
    ).map_err(|e| e.to_string())?;
    let mut count: u32 = 0;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,f64>(5)?,r.get::<_,f64>(6)?,r.get::<_,f64>(7)?,r.get::<_,Option<f64>>(8)?,r.get::<_,Option<f64>>(9)?,r.get::<_,Option<f64>>(10)?))
    }).map_err(|e| e.to_string())?;
    for r in rows.filter_map(|r| r.ok()) {
        let cost_str = r.8.map(|v| format!("{:.2}", v)).unwrap_or_default();
        let profit_str = r.9.map(|v| format!("{:.2}", v)).unwrap_or_default();
        let margin_str = r.10.map(|v| format!("{:.1}%", v)).unwrap_or_default();
        wtr.write_record(&[&r.0, &r.1, &r.2, &r.3, &r.4, &format!("{:.2}", r.5), &format!("{:.2}", r.6), &format!("{:.2}", r.7), &cost_str, &profit_str, &margin_str]).map_err(|e| e.to_string())?;
        count += 1;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn export_deals_csv(output_path: String) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    wtr.write_record(["title","client","stage","asking_price","created_at","updated_at"]).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT d.title,COALESCE(c.name,''),d.stage,d.asking_price,d.created_at,d.updated_at
         FROM deals d LEFT JOIN clients c ON c.id=d.client_id ORDER BY d.updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let mut count: u32 = 0;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,f64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?))
    }).map_err(|e| e.to_string())?;
    for r in rows.filter_map(|r| r.ok()) {
        wtr.write_record(&[&r.0,&r.1,&r.2,&format!("{:.2}",r.3),&r.4,&r.5]).map_err(|e| e.to_string())?;
        count += 1;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn export_deal_flows_csv(output_path: String) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    wtr.write_record(["name","client","stage","gross_revenue","total_cost","net_profit","created_at"]).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT df.name,COALESCE(c.name,''),df.stage,COALESCE(df.gross_revenue,0),COALESCE(df.total_cost,0),COALESCE(df.net_profit,0),df.created_at
         FROM deal_flows df LEFT JOIN clients c ON c.id=df.client_id ORDER BY df.updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let mut count: u32 = 0;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,f64>(3)?,r.get::<_,f64>(4)?,r.get::<_,f64>(5)?,r.get::<_,String>(6)?))
    }).map_err(|e| e.to_string())?;
    for r in rows.filter_map(|r| r.ok()) {
        wtr.write_record(&[&r.0,&r.1,&r.2,&format!("{:.2}",r.3),&format!("{:.2}",r.4),&format!("{:.2}",r.5),&r.6]).map_err(|e| e.to_string())?;
        count += 1;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn export_inventory_csv(status_filter: Option<String>, output_path: String) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wtr = csv::Writer::from_path(&output_path).map_err(|e| e.to_string())?;
    wtr.write_record(["name","category","quantity","total_cost","asking_price","status","created_at"]).map_err(|e| e.to_string())?;
    let sql = match &status_filter {
        Some(_) => "SELECT name,category,quantity,total_cost,asking_price,status,created_at FROM inventory WHERE status=?1 ORDER BY created_at DESC",
        None => "SELECT name,category,quantity,total_cost,asking_price,status,created_at FROM inventory ORDER BY created_at DESC",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut count: u32 = 0;
    let rows: Vec<_> = match &status_filter {
        Some(s) => stmt.query_map([s], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,f64>(3)?,r.get::<_,f64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect(),
        None => stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,f64>(3)?,r.get::<_,f64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect(),
    };
    for r in rows {
        wtr.write_record(&[&r.0,&r.1.unwrap_or_default(),&r.2.to_string(),&format!("{:.2}",r.3),&format!("{:.2}",r.4),&r.5,&r.6]).map_err(|e| e.to_string())?;
        count += 1;
    }
    wtr.flush().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub async fn export_analytics_xlsx(output_path: String) -> Result<(), String> {
    use rust_xlsxwriter::*;
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut wb = Workbook::new();

    // Sheet 1: Summary
    let ws1 = wb.add_worksheet().set_name("Summary").map_err(|e| e.to_string())?;
    let bold = Format::new().set_bold();
    let currency = Format::new().set_num_format("$#,##0.00");
    ws1.write_with_format(0, 0, "ClientHub Analytics Export", &bold).map_err(|e| e.to_string())?;
    ws1.write_string(1, 0, format!("Generated: {}", Utc::now().format("%Y-%m-%d %H:%M UTC"))).map_err(|e| e.to_string())?;
    let total_clients: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap_or(0);
    let total_invoices: i64 = conn.query_row("SELECT COUNT(*) FROM invoices WHERE COALESCE(archived,0)=0", [], |r| r.get(0)).unwrap_or(0);
    let outstanding: f64 = conn.query_row("SELECT COALESCE(SUM(total),0) FROM invoices WHERE status IN ('sent','overdue') AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0", [], |r| r.get(0)).unwrap_or(0.0);
    let paid_ytd: f64 = conn.query_row("SELECT COALESCE(SUM(total),0) FROM invoices WHERE status='paid' AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND issue_date >= ?1", [format!("{}-01-01",Utc::now().format("%Y"))], |r| r.get(0)).unwrap_or(0.0);
    let pipeline_val: f64 = conn.query_row("SELECT COALESCE(SUM(asking_price),0) FROM deals WHERE stage NOT IN ('won','lost') AND COALESCE(archived,0)=0", [], |r| r.get(0)).unwrap_or(0.0);
    let pipeline_cnt: i64 = conn.query_row("SELECT COUNT(*) FROM deals WHERE stage NOT IN ('won','lost') AND COALESCE(archived,0)=0", [], |r| r.get(0)).unwrap_or(0);

    ws1.write_with_format(3, 0, "Total Clients", &bold).map_err(|e| e.to_string())?;
    ws1.write_number(3, 1, total_clients as f64).map_err(|e| e.to_string())?;
    ws1.write_with_format(4, 0, "Total Invoices", &bold).map_err(|e| e.to_string())?;
    ws1.write_number(4, 1, total_invoices as f64).map_err(|e| e.to_string())?;
    ws1.write_with_format(5, 0, "Outstanding", &bold).map_err(|e| e.to_string())?;
    ws1.write_number_with_format(5, 1, outstanding, &currency).map_err(|e| e.to_string())?;
    ws1.write_with_format(6, 0, "Paid YTD", &bold).map_err(|e| e.to_string())?;
    ws1.write_number_with_format(6, 1, paid_ytd, &currency).map_err(|e| e.to_string())?;
    ws1.write_with_format(7, 0, "Pipeline Value", &bold).map_err(|e| e.to_string())?;
    ws1.write_number_with_format(7, 1, pipeline_val, &currency).map_err(|e| e.to_string())?;
    ws1.write_with_format(8, 0, "Pipeline Count", &bold).map_err(|e| e.to_string())?;
    ws1.write_number(8, 1, pipeline_cnt as f64).map_err(|e| e.to_string())?;

    // Sheet 2: Revenue by Month
    let ws2 = wb.add_worksheet().set_name("Revenue by Month").map_err(|e| e.to_string())?;
    ws2.write_string_with_format(0, 0, "Month", &bold).map_err(|e| e.to_string())?;
    ws2.write_string_with_format(0, 1, "Revenue", &bold).map_err(|e| e.to_string())?;
    ws2.write_string_with_format(0, 2, "Cost", &bold).map_err(|e| e.to_string())?;
    ws2.write_string_with_format(0, 3, "Profit", &bold).map_err(|e| e.to_string())?;
    ws2.write_string_with_format(0, 4, "Margin %", &bold).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m',issue_date) as month, COALESCE(SUM(total),0), COALESCE(SUM(total_cost),0), COALESCE(SUM(profit),0)
         FROM invoices WHERE status='paid' AND is_complete=1 AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0 GROUP BY month ORDER BY month DESC"
    ).map_err(|e| e.to_string())?;
    let month_rows: Vec<(String,f64,f64,f64)> = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    for (i, (m, rev, cost, profit)) in month_rows.iter().enumerate() {
        let row = (i + 1) as u32;
        ws2.write_string(row, 0, m.as_str()).map_err(|e| e.to_string())?;
        ws2.write_number_with_format(row, 1, *rev, &currency).map_err(|e| e.to_string())?;
        ws2.write_number_with_format(row, 2, *cost, &currency).map_err(|e| e.to_string())?;
        ws2.write_number_with_format(row, 3, *profit, &currency).map_err(|e| e.to_string())?;
        let margin_pct = if *rev > 0.0 { *profit / *rev * 100.0 } else { 0.0 };
        ws2.write_string(row, 4, format!("{:.1}%", margin_pct).as_str()).map_err(|e| e.to_string())?;
    }

    // Sheet 3: Top Clients
    let ws3 = wb.add_worksheet().set_name("Top Clients").map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 0, "Name", &bold).map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 1, "Company", &bold).map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 2, "Invoices", &bold).map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 3, "Total Spent", &bold).map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 4, "Total Profit", &bold).map_err(|e| e.to_string())?;
    ws3.write_string_with_format(0, 5, "Margin %", &bold).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT c.name, COALESCE(c.company,''), COUNT(i.id), COALESCE(SUM(i.total),0), COALESCE(SUM(i.profit),0)
         FROM clients c JOIN invoices i ON i.client_id=c.id
         WHERE i.status='paid' AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0
         GROUP BY c.id ORDER BY SUM(i.total) DESC LIMIT 50"
    ).map_err(|e| e.to_string())?;
    let client_rows: Vec<(String,String,i64,f64,f64)> = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    for (i, (name, co, invs, spent, profit)) in client_rows.iter().enumerate() {
        let row = (i + 1) as u32;
        ws3.write_string(row, 0, name.as_str()).map_err(|e| e.to_string())?;
        ws3.write_string(row, 1, co.as_str()).map_err(|e| e.to_string())?;
        ws3.write_number(row, 2, *invs as f64).map_err(|e| e.to_string())?;
        ws3.write_number_with_format(row, 3, *spent, &currency).map_err(|e| e.to_string())?;
        ws3.write_number_with_format(row, 4, *profit, &currency).map_err(|e| e.to_string())?;
        let margin_pct = if *spent > 0.0 { *profit / *spent * 100.0 } else { 0.0 };
        ws3.write_string(row, 5, format!("{:.1}%", margin_pct).as_str()).map_err(|e| e.to_string())?;
    }

    // Sheet 4: Deal Pipeline — from the REAL pipeline (deal_flows, one per invoice,
    // fell-through excluded), not the dead deals CRM table which is always empty.
    let ws4 = wb.add_worksheet().set_name("Deal Pipeline").map_err(|e| e.to_string())?;
    ws4.write_string_with_format(0, 0, "Stage", &bold).map_err(|e| e.to_string())?;
    ws4.write_string_with_format(0, 1, "Count", &bold).map_err(|e| e.to_string())?;
    ws4.write_string_with_format(0, 2, "Value", &bold).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT df.stage, COUNT(DISTINCT df.invoice_id), COALESCE(SUM(df.gross_revenue),0) \
         FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
         GROUP BY df.stage ORDER BY df.stage").map_err(|e| e.to_string())?;
    let pipeline_rows: Vec<(String,i64,f64)> = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    for (i, (stage, cnt, val)) in pipeline_rows.iter().enumerate() {
        let row = (i + 1) as u32;
        ws4.write_string(row, 0, stage.as_str()).map_err(|e| e.to_string())?;
        ws4.write_number(row, 1, *cnt as f64).map_err(|e| e.to_string())?;
        ws4.write_number_with_format(row, 2, *val, &currency).map_err(|e| e.to_string())?;
    }

    wb.save(&output_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn search_clients(query: String) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pattern = format!("%{}%", query.to_lowercase());
    let sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                MAX(i.created_at),
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                COALESCE(c.is_blacklisted,0),
                COALESCE(c.approval_status,'active'),
                ({fc}) AS first_contact
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id
         WHERE LOWER(c.name) LIKE ?1 OR LOWER(c.email) LIKE ?1 OR LOWER(c.company) LIKE ?1 OR LOWER(c.metadata) LIKE ?1
         GROUP BY c.id
         ORDER BY c.name LIMIT 50", fc = FIRST_CONTACT_SQL);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([pattern], |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        let high_value = meta_flag(&meta, "high_value");
        let exclusive = meta_flag(&meta, "exclusive");
        let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
            needs_review,
            is_blacklisted: r.get::<_, i64>(14)? != 0,
            approval_status: r.get(15)?,
            high_value,
            exclusive,
            first_contact,
            })
        }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Serialize, Debug, Clone)]
pub struct GlobalSearchResults {
    pub clients: Vec<SearchClient>,
    pub invoices: Vec<SearchInvoice>,
    pub deals: Vec<SearchDeal>,
    pub suppliers: Vec<SearchSupplier>,
}

#[derive(Serialize, Debug, Clone)]
pub struct SearchClient { pub id: String, pub name: String, pub company: Option<String>, pub email: Option<String> }
#[derive(Serialize, Debug, Clone)]
pub struct SearchInvoice { pub id: String, pub number: String, pub client_name: String }
#[derive(Serialize, Debug, Clone)]
pub struct SearchDeal { pub id: String, pub title: String, pub client_name: String }
#[derive(Serialize, Debug, Clone)]
pub struct SearchSupplier { pub id: String, pub name: String }

#[tauri::command]
pub async fn global_search(query: String) -> Result<GlobalSearchResults, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let pat = format!("%{}%", query.to_lowercase());

    let mut stmt_c = conn.prepare(
        "SELECT id, name, company, email FROM clients WHERE LOWER(name) LIKE ?1 OR LOWER(company) LIKE ?1 OR LOWER(email) LIKE ?1 ORDER BY name LIMIT 5"
    ).map_err(|e| e.to_string())?;
    let clients: Vec<SearchClient> = stmt_c.query_map([&pat], |r| Ok(SearchClient { id: r.get(0)?, name: r.get(1)?, company: r.get(2)?, email: r.get(3)? }))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let mut stmt_i = conn.prepare(
        "SELECT i.id, i.number, COALESCE(c.name,'') FROM invoices i LEFT JOIN clients c ON c.id=i.client_id WHERE (LOWER(i.number) LIKE ?1 OR LOWER(c.name) LIKE ?1) AND COALESCE(i.archived,0)=0 ORDER BY i.issue_date DESC LIMIT 5"
    ).map_err(|e| e.to_string())?;
    let invoices: Vec<SearchInvoice> = stmt_i.query_map([&pat], |r| Ok(SearchInvoice { id: r.get(0)?, number: r.get(1)?, client_name: r.get(2)? }))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let mut stmt_d = conn.prepare(
        "SELECT d.id, d.title, COALESCE(c.name,'') FROM deals d LEFT JOIN clients c ON c.id=d.client_id WHERE (LOWER(d.title) LIKE ?1 OR LOWER(c.name) LIKE ?1) AND COALESCE(d.archived,0)=0 ORDER BY d.updated_at DESC LIMIT 5"
    ).map_err(|e| e.to_string())?;
    let deals: Vec<SearchDeal> = stmt_d.query_map([&pat], |r| Ok(SearchDeal { id: r.get(0)?, title: r.get(1)?, client_name: r.get(2)? }))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let mut stmt_s = conn.prepare(
        "SELECT id, name FROM suppliers WHERE LOWER(name) LIKE ?1 ORDER BY name LIMIT 5"
    ).map_err(|e| e.to_string())?;
    let suppliers: Vec<SearchSupplier> = stmt_s.query_map([&pat], |r| Ok(SearchSupplier { id: r.get(0)?, name: r.get(1)? }))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    Ok(GlobalSearchResults { clients, invoices, deals, suppliers })
}

#[tauri::command]
pub async fn list_stale_clients(days: u32) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let cutoff = format!("-{} days", days);
    let sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                MAX(i.created_at),
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                ({fc}) AS first_contact
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id
         GROUP BY c.id
     HAVING MAX(i.created_at) IS NULL OR MAX(i.created_at) < datetime('now', ?1)
     ORDER BY MAX(i.created_at) ASC", fc = FIRST_CONTACT_SQL);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([cutoff], |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        let high_value = meta_flag(&meta, "high_value");
        let exclusive = meta_flag(&meta, "exclusive");
        let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta,
            invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
            category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
            needs_review,
            is_blacklisted: false,
            approval_status: "active".into(),
            high_value,
            exclusive,
            first_contact,
            })
        }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn due_followups() -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
            "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                    (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                    NULL,
                    COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                    ({fc}) AS first_contact
             FROM clients c
             WHERE json_extract(c.metadata, '$.next_follow_up_date') IS NOT NULL
             AND json_extract(c.metadata, '$.next_follow_up_date') <= date('now')
             ORDER BY json_extract(c.metadata, '$.next_follow_up_date') ASC", fc = FIRST_CONTACT_SQL);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            let high_value = meta_flag(&meta, "high_value");
            let exclusive = meta_flag(&meta, "exclusive");
            let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
                metadata: meta,
                invoice_count: r.get(11)?,
                last_contact_at: None,
                total_revenue: r.get(12)?,
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: false,
                approval_status: "active".into(),
                high_value,
                exclusive,
                first_contact,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Deserialize)]
pub struct ClientFilter {
    pub category: Option<String>,
    pub tiers: Option<Vec<String>>,
    pub tag: Option<String>,
    pub state: Option<String>,
    pub stale_days: Option<u32>,
    pub missing: Option<String>,
    pub needs_review: Option<bool>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    /// Filter to clients whose lead_representative / source_rep matches this name.
    pub rep: Option<String>,
    /// Lead-status filter. Exact value (e.g. "inactive") matches that status;
    /// the special value "active_not_dormant" returns everyone who is NOT dormant.
    pub lead_status: Option<String>,
}

#[tauri::command]
pub async fn list_clients_filtered(filter: ClientFilter) -> Result<Vec<Client>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    let mut sql = format!(
        "SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                NULLIF(MAX(COALESCE((SELECT MAX(sent_at) FROM invoices WHERE client_id=c.id AND COALESCE(archived,0)=0),''),
                           COALESCE((SELECT MAX(sent_at) FROM quotes WHERE client_id=c.id),''),
                    COALESCE((SELECT MAX(created_at) FROM interactions WHERE client_id=c.id AND kind IN ('checkup','call','note','meeting')),'')),''),
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                COALESCE(c.is_blacklisted,0),
                COALESCE(c.approval_status,'active'),
                ({fc}) AS first_contact
         FROM clients c
         LEFT JOIN interactions i ON i.client_id = c.id", fc = FIRST_CONTACT_SQL
    );
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1;

    if let Some(ref s) = filter.search {
        let pat = format!("%{}%", s.to_lowercase());
        // Phone search is format-agnostic: strip every non-digit from BOTH the stored
        // phone and the typed query, then substring-match. So "847-393-6858",
        // "8473936858" and "393-6858" all find the same client regardless of how the
        // number was saved. Only kicks in when the query itself contains a digit, so a
        // name/email search isn't dragged through the phone column.
        let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            conds.push(format!(
                "(LOWER(c.name) LIKE ?{p} OR LOWER(c.email) LIKE ?{p} OR LOWER(c.company) LIKE ?{p})",
                p = param_idx
            ));
            params.push(Box::new(pat));
            param_idx += 1;
        } else {
            // strip ( ) - space . + from c.phone, leaving digits to compare against.
            const PHONE_DIGITS: &str =
                "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(c.phone,''),'(',''),')',''),'-',''),' ',''),'.',''),'+','')";
            conds.push(format!(
                "(LOWER(c.name) LIKE ?{p} OR LOWER(c.email) LIKE ?{p} OR LOWER(c.company) LIKE ?{p} \
                  OR c.phone LIKE ?{p} OR {pd} LIKE ?{pdig})",
                p = param_idx, pd = PHONE_DIGITS, pdig = param_idx + 1
            ));
            params.push(Box::new(pat));
            params.push(Box::new(format!("%{}%", digits)));
            param_idx += 2;
        }
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
    if let Some(ref s) = filter.rep {
        if !s.is_empty() {
            conds.push(format!(
                "(json_extract(c.metadata,'$.lead_representative') = ?{p} OR json_extract(c.metadata,'$.source_rep') = ?{p})",
                p = param_idx
            ));
            params.push(Box::new(s.clone()));
            param_idx += 1;
        }
    }
    if let Some(ref s) = filter.lead_status {
        if s == "active_not_dormant" {
            conds.push("COALESCE(c.lead_status,'') != 'inactive'".into());
        } else if !s.is_empty() {
            conds.push(format!("c.lead_status = ?{}", param_idx));
            params.push(Box::new(s.clone()));
            param_idx += 1;
        }
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

    match filter.sort_by.as_deref() {
        Some("revenue_desc") => sql.push_str(" ORDER BY total_revenue DESC"),
        _ => sql.push_str(" ORDER BY c.name"),
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows: Vec<Client> = stmt.query_map(param_refs.as_slice(), |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            let high_value = meta_flag(&meta, "high_value");
            let exclusive = meta_flag(&meta, "exclusive");
            let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
                metadata: meta,
                invoice_count: r.get(11)?, last_contact_at: r.get(12)?,
                total_revenue: r.get(13)?,
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: r.get::<_, i64>(14).unwrap_or(0) != 0,
                approval_status: r.get::<_, String>(15).unwrap_or_else(|_| "active".into()),
                high_value,
                exclusive,
                first_contact,
            })
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    if let Some(ref tiers) = filter.tiers {
        let tiers_map = build_client_tier_map(&conn)?;
        Ok(rows.into_iter().filter(|c| {
            tiers_map.get(&c.id).map_or(false, |t| tiers.contains(t))
        }).collect())
    } else {
        Ok(rows)
    }
}

/// The ONE tier-threshold definition, shared by `buyer_tiers()` (display) and
/// `build_client_tier_map()` (filter + automation) so the two can never drift.
/// `net_paid` = paid invoices minus refunds; `invoices_sent` counts sent/overdue/paid.
fn tier_for(effective_annual: f64, net_paid: f64, invoices_sent: i64, quotes_sent: i64) -> &'static str {
    if effective_annual > 100000.0 || net_paid > 50000.0 { "S" }
    else if effective_annual > 50000.0 || net_paid > 20000.0 || (net_paid > 5000.0 && invoices_sent >= 3) { "A" }
    else if effective_annual > 10000.0 || net_paid > 5000.0 || (net_paid > 1000.0 && invoices_sent >= 1) { "B" }
    // Quoting a client is active engagement: it lifts a bare prospect to C.
    else if effective_annual > 0.0 || net_paid > 0.0 || invoices_sent >= 1 || quotes_sent >= 1 { "C" }
    else { "Prospect" }
}

/// Total refunded per client, via deal_flow→invoice. Counts non-bank-linked
/// `refunds` rows + every `refund_out` allocation (the `refund_status_all` rule) so
/// a bank-linked refund — which lives in BOTH tables — is counted exactly once.
/// Used to net refunds out of tier revenue so a fully refunded client can't hold a
/// tier or show phantom revenue.
fn refunded_by_client(conn: &rusqlite::Connection) -> std::collections::HashMap<String, f64> {
    let mut m = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT iv.client_id, COALESCE(SUM(x.amt),0) FROM ( \
            SELECT r.amount AS amt, r.deal_flow_id AS dfid FROM refunds r WHERE COALESCE(r.bank_txn_id,'')='' \
            UNION ALL \
            SELECT a.amount, a.deal_flow_id FROM bank_allocation a WHERE a.role='refund_out' \
         ) x JOIN deal_flows df ON df.id=x.dfid JOIN invoices iv ON iv.id=df.invoice_id \
         GROUP BY iv.client_id"
    ) {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))) {
            for row in rows.flatten() { m.insert(row.0, row.1); }
        }
    }
    m
}

/// Correlated SQL fragment (returns a client's refunded total) for netting refunds
/// out of `total_revenue` in list_clients/get_client. `c.id` must be in scope.
const CLIENT_REFUNDED_SQL: &str =
    "COALESCE((SELECT SUM(x.amt) FROM ( \
        SELECT r.amount AS amt, r.deal_flow_id AS dfid FROM refunds r WHERE COALESCE(r.bank_txn_id,'')='' \
        UNION ALL \
        SELECT a.amount, a.deal_flow_id FROM bank_allocation a WHERE a.role='refund_out' \
     ) x JOIN deal_flows df ON df.id=x.dfid JOIN invoices iv ON iv.id=df.invoice_id \
     WHERE iv.client_id=c.id),0)";

fn build_client_tier_map(conn: &rusqlite::Connection) -> Result<std::collections::HashMap<String, String>, String> {
    let mut map = std::collections::HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT client_id, COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0),
                COUNT(CASE WHEN status IN ('sent','overdue','paid') THEN 1 END)
         FROM invoices WHERE COALESCE(archived,0)=0 AND COALESCE(voided,0)=0 GROUP BY client_id"
    ).map_err(|e| e.to_string())?;
    let invoice_data: Vec<(String, f64, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_,i64>(2)?)))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let refunded_map = refunded_by_client(conn);

    let mut client_stmt = conn.prepare("SELECT id, metadata FROM clients").map_err(|e| e.to_string())?;
    let clients: Vec<(String, Option<String>)> = client_stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let invoice_map: std::collections::HashMap<String, (f64, i64)> = invoice_data.into_iter().map(|(id, p, s)| (id, (p, s))).collect();

    // Quotes count per client — must match buyer_tiers() so the filter tier equals
    // the displayed tier (a quote-only client is "C", not "Prospect").
    let quotes_map: std::collections::HashMap<String, i64> = {
        let mut qs = conn.prepare(
            "SELECT client_id, COUNT(*) FROM quotes WHERE status IN ('sent','accepted','declined','expired') GROUP BY client_id"
        ).map_err(|e| e.to_string())?;
        let rows = qs.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for (client_id, meta_str) in &clients {
        let (actual_paid, invoices_sent) = invoice_map.get(client_id).copied().unwrap_or((0.0, 0));
        let net_paid = (actual_paid - refunded_map.get(client_id).copied().unwrap_or(0.0)).max(0.0);
        let quotes_sent = quotes_map.get(client_id).copied().unwrap_or(0);
        let meta: Option<Value> = meta_str.as_deref().and_then(|s| serde_json::from_str(s).ok());
        let frequency = meta.as_ref().and_then(|m| m.get("purchase_frequency")).and_then(|v| v.as_str());
        let spend_raw = meta.as_ref().and_then(|m| m.get("estimated_annual_spend")).and_then(|v| v.as_str()).unwrap_or("0");
        let annual_spend: f64 = spend_raw.parse().unwrap_or(0.0);
        let freq_mult = match frequency.unwrap_or("").to_lowercase().as_str() {
            "weekly" => 52.0, "bi-weekly" => 26.0, "monthly" => 12.0,
            "quarterly" => 4.0, "annually" => 1.0, _ => 0.0,
        };
        let effective_annual = freq_mult * annual_spend;
        let tier = tier_for(effective_annual, net_paid, invoices_sent, quotes_sent);
        map.insert(client_id.clone(), tier.to_string());
    }
    Ok(map)
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
                (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                NULL,
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                COALESCE(c.is_blacklisted,0),
                COALESCE(c.approval_status,'active'),
                ({fc}) AS first_contact
         FROM clients c
         WHERE {where_clause}", fc = FIRST_CONTACT_SQL, where_clause = where_clause
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, |r| {
        let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
        let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
        let high_value = meta_flag(&meta, "high_value");
        let exclusive = meta_flag(&meta, "exclusive");
        let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
        Ok(Client {
            id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
            company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
            lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
            metadata: meta, invoice_count: r.get(11)?, last_contact_at: None,
            total_revenue: r.get(13)?,
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: r.get::<_, i64>(14).unwrap_or(0) != 0,
                approval_status: r.get::<_, String>(15).unwrap_or_else(|_| "active".into()),
                high_value,
                exclusive,
                first_contact,
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
        let sql = format!("SELECT c.id,c.name,c.email,c.phone,c.company,c.notes,c.billing_status,c.lead_status,c.created_at,c.updated_at,c.metadata,
                          (SELECT COUNT(*) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0),
                          NULL,
                COALESCE((SELECT SUM(total) FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0), 0),
                COALESCE(c.is_blacklisted,0),
                ({fc}) AS first_contact
         FROM clients c
                   LEFT JOIN interactions i ON i.client_id = c.id
                   WHERE i.id IS NULL", fc = FIRST_CONTACT_SQL);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            let meta: Option<Value> = r.get::<_, Option<String>>(10)?.and_then(|s| serde_json::from_str(&s).ok());
            let (category, tags, street_address, city, state, zip_code, country, next_follow_up_date, needs_review) = extract_client_fields(&meta);
            let high_value = meta_flag(&meta, "high_value");
            let exclusive = meta_flag(&meta, "exclusive");
            let first_contact = r.get::<_, i64>("first_contact").unwrap_or(0) != 0;
            Ok(Client {
                id: r.get(0)?, name: r.get(1)?, email: r.get(2)?, phone: r.get(3)?,
                company: r.get(4)?, notes: r.get(5)?, billing_status: r.get(6)?,
                lead_status: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)?,
                metadata: meta, invoice_count: r.get(11)?, last_contact_at: None,
                total_revenue: r.get(12)?,
                category, tags, street_address, city, state, zip_code, country, next_follow_up_date,
                needs_review,
                is_blacklisted: false,
                approval_status: "active".into(),
                high_value,
                exclusive,
                first_contact,
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
    /// "Deal fell through" flag. Kept (never deleted) but excluded from the working
    /// invoice lists, AR/receivables, dashboard, and client ranking.
    #[serde(default)]
    pub voided: bool,
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
            "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage,COALESCE(voided,0)
             FROM invoices WHERE COALESCE(archived,0)=0 ORDER BY issue_date DESC",
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
                voided: r.get::<_, i64>(25).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_invoice(id: String) -> Result<Invoice, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage,COALESCE(voided,0)
         FROM invoices WHERE id=?1 AND COALESCE(archived,0)=0",
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
            voided: r.get::<_, i64>(25).unwrap_or(0) != 0,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_invoices_for_client(client_id: String) -> Result<Vec<Invoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,cost_items_json,total_cost,profit,margin,carrier,tracking_number,shipping_charged,pickup_date,delivery_date,is_complete,deal_flow_id,deal_flow_stage,COALESCE(voided,0)
         FROM invoices WHERE client_id=?1 AND COALESCE(archived,0)=0 ORDER BY issue_date DESC",
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
            voided: r.get::<_, i64>(25).unwrap_or(0) != 0,
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

/// Parse the trailing run of digits off a document number ("INV-0042" -> 42, "Q-7" -> 7).
fn trailing_number(s: &str) -> Option<u32> {
    let start = s.rfind(|c: char| !c.is_ascii_digit()).map(|i| i + 1).unwrap_or(0);
    let tail = &s[start..];
    if tail.is_empty() { None } else { tail.parse().ok() }
}

/// Next number for a document `table` that has a UNIQUE `number` column.
///
/// The old scheme handed out `{prefix}{stored_counter}` and bumped the counter. That
/// counter lives in `settings` and does NOT reliably reach a second device before it
/// generates its own document, so switching PC↔Mac produced a stale counter and a
/// duplicate/rewound number (Jack had to fix these by hand). Instead we assign
/// `max(configured counter, highest number already present + 1)` and skip past any exact
/// collision — so the number is always ahead of everything already synced onto this
/// device, regardless of counter drift. The stored counter is still advanced so the
/// settings preview stays in step.
fn next_document_number(
    conn: &rusqlite::Connection,
    table: &str,
    prefix_key: &str,
    padding_key: &str,
    counter_key: &str,
    default_prefix: &str,
) -> anyhow::Result<String> {
    let prefix: String = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [prefix_key], |r| r.get(0))
        .ok().unwrap_or_else(|| default_prefix.into());
    let padding: usize = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [padding_key], |r| r.get::<_, String>(0))
        .ok().and_then(|s| s.parse().ok()).unwrap_or(4);
    let configured: u32 = conn
        .query_row("SELECT value FROM settings WHERE key=?1", [counter_key], |r| r.get::<_, String>(0))
        .ok().and_then(|s| s.parse().ok()).unwrap_or(1);

    // Highest numeric suffix already present, so a stale counter can never hand out a
    // number at or below one that's already been used and synced onto this device.
    let mut highest_used = 0u32;
    if let Ok(mut stmt) = conn.prepare(&format!("SELECT number FROM {}", table)) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for n in rows.flatten() {
                if let Some(v) = trailing_number(&n) { highest_used = highest_used.max(v); }
            }
        }
    }

    let mut assigned = configured.max(highest_used + 1);
    loop {
        let candidate = format!("{}{:0>width$}", prefix, assigned, width = padding);
        let taken = conn
            .query_row(&format!("SELECT 1 FROM {} WHERE number=?1 LIMIT 1", table), [&candidate], |_| Ok(()))
            .is_ok();
        if !taken {
            conn.execute(
                "INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![counter_key, (assigned + 1).to_string()],
            )?;
            return Ok(candidate);
        }
        assigned += 1;
    }
}

fn generate_invoice_number() -> anyhow::Result<String> {
    let conn = pool().get()?;
    next_document_number(&conn, "invoices", "invoice_prefix", "invoice_padding", "invoice_next_number", "INV-")
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct InvoiceNumberingConfig {
    pub prefix: String,
    pub next_number: u32,
    pub padding: u32,
    pub preview: String,
}

#[tauri::command]
pub async fn get_invoice_numbering_config() -> Result<InvoiceNumberingConfig, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let prefix: String = conn.query_row("SELECT value FROM settings WHERE key='invoice_prefix'", [], |r| r.get(0)).ok().unwrap_or_else(|| "INV-".into());
    let next_number: u32 = conn.query_row("SELECT value FROM settings WHERE key='invoice_next_number'", [], |r| r.get::<_,String>(0)).ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let padding: u32 = conn.query_row("SELECT value FROM settings WHERE key='invoice_padding'", [], |r| r.get::<_,String>(0)).ok().and_then(|s| s.parse().ok()).unwrap_or(4);
    let preview = format!("{}{:0>width$}", prefix, next_number, width = padding as usize);
    Ok(InvoiceNumberingConfig { prefix, next_number, padding, preview })
}

#[tauri::command]
pub async fn save_invoice_numbering_config(prefix: String, next_number: u32, padding: u32) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('invoice_prefix',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&prefix]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('invoice_next_number',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&next_number.to_string()]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('invoice_padding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&padding.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Quotes — customer-facing estimates (no deal flow / shipping)
// ============================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Quote {
    pub id: String,
    pub client_id: String,
    pub number: String,
    pub issue_date: String,
    pub valid_until: String,
    pub line_items_json: String,
    pub subtotal: f64,
    pub tax: f64,
    pub total: f64,
    pub status: String,
    pub pdf_path: Option<String>,
    pub sent_at: Option<String>,
    pub notes: Option<String>,
    pub converted_invoice_id: Option<String>,
    pub created_at: String,
}

const QUOTE_COLS: &str = "id,client_id,number,issue_date,valid_until,line_items_json,subtotal,tax,total,status,pdf_path,sent_at,notes,converted_invoice_id,created_at";

fn row_to_quote(r: &rusqlite::Row) -> rusqlite::Result<Quote> {
    Ok(Quote {
        id: r.get(0)?, client_id: r.get(1)?, number: r.get(2)?, issue_date: r.get(3)?,
        valid_until: r.get(4)?, line_items_json: r.get(5)?, subtotal: r.get(6)?,
        tax: r.get(7)?, total: r.get(8)?, status: r.get(9)?, pdf_path: r.get(10)?,
        sent_at: r.get(11)?, notes: r.get(12)?, converted_invoice_id: r.get(13)?, created_at: r.get(14)?,
    })
}

#[tauri::command]
pub async fn list_quotes() -> Result<Vec<Quote>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&format!("SELECT {} FROM quotes ORDER BY issue_date DESC", QUOTE_COLS)).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_quote).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_quotes_for_client(client_id: String) -> Result<Vec<Quote>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&format!("SELECT {} FROM quotes WHERE client_id=?1 ORDER BY issue_date DESC", QUOTE_COLS)).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([client_id], row_to_quote).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_quote(id: String) -> Result<Quote, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(&format!("SELECT {} FROM quotes WHERE id=?1", QUOTE_COLS), [&id], row_to_quote).map_err(|e| e.to_string())
}

fn generate_quote_number() -> anyhow::Result<String> {
    let conn = pool().get()?;
    next_document_number(&conn, "quotes", "quote_prefix", "quote_padding", "quote_next_number", "QUO-")
}

#[derive(Deserialize)]
pub struct QuoteInput {
    pub client_id: String,
    pub valid_until: String,
    pub issue_date: Option<String>,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub tax_rate: f64,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn create_quote(input: QuoteInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let number = generate_quote_number().map_err(|e| e.to_string())?;
    let issue = input.issue_date.clone().unwrap_or_else(|| now.to_rfc3339());
    let line_items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();

    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("number".into(), Value::String(number.clone()));
    cols.insert("issue_date".into(), Value::String(issue.clone()));
    cols.insert("valid_until".into(), Value::String(input.valid_until.clone()));
    cols.insert("line_items_json".into(), Value::String(line_items_json.clone()));
    cols.insert("subtotal".into(), json!(subtotal));
    cols.insert("tax".into(), json!(tax));
    cols.insert("total".into(), json!(total));
    cols.insert("status".into(), Value::String("draft".into()));
    cols.insert("notes".into(), Value::String(notes.clone()));
    cols.insert("created_at".into(), Value::String(issue.clone()));
    sync::record_upsert("quotes", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO quotes (id,client_id,number,issue_date,valid_until,line_items_json,subtotal,tax,total,status,notes,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?4)",
        rusqlite::params![id, input.client_id, number, issue, input.valid_until, line_items_json, subtotal, tax, total, notes],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_quote(id: String, input: QuoteInput) -> Result<(), String> {
    let line_items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let (subtotal, tax, total) = crate::invoice::compute_totals(&input.line_items, input.tax_rate);
    let notes = input.notes.unwrap_or_default();

    let mut cols = Map::new();
    cols.insert("valid_until".into(), Value::String(input.valid_until.clone()));
    cols.insert("line_items_json".into(), Value::String(line_items_json.clone()));
    cols.insert("subtotal".into(), json!(subtotal));
    cols.insert("tax".into(), json!(tax));
    cols.insert("total".into(), json!(total));
    cols.insert("notes".into(), Value::String(notes.clone()));
    sync::record_upsert("quotes", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE quotes SET valid_until=?1, line_items_json=?2, subtotal=?3, tax=?4, total=?5, notes=?6 WHERE id=?7",
        rusqlite::params![input.valid_until, line_items_json, subtotal, tax, total, notes, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_quote(id: String) -> Result<(), String> {
    sync::record_delete("quotes", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM quotes WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_quote_status(id: String, status: String) -> Result<(), String> {
    if !["draft", "sent", "accepted", "declined", "expired"].contains(&status.as_str()) {
        return Err("Invalid quote status".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE quotes SET status=?1 WHERE id=?2", rusqlite::params![status, id]).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String(status));
    sync::record_upsert("quotes", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn generate_quote_pdf(quote_id: String) -> Result<String, String> {
    crate::invoice::generate_quote_pdf(&quote_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_quote(quote_id: String, thread: Option<bool>) -> Result<(), String> {
    crate::invoice::send_quote(&quote_id, thread.unwrap_or(false)).await.map_err(|e| e.to_string())
}

/// Mark a quote accepted and link it to the invoice it was converted into.
/// The invoice itself is created via the normal create_invoice flow (prefilled
/// on the frontend), which is what actually drives the client's score.
#[tauri::command]
pub async fn mark_quote_converted(quote_id: String, invoice_id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE quotes SET status='accepted', converted_invoice_id=?1 WHERE id=?2", rusqlite::params![invoice_id, quote_id]).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("status".into(), Value::String("accepted".into()));
    cols.insert("converted_invoice_id".into(), Value::String(invoice_id));
    sync::record_upsert("quotes", &quote_id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct QuoteNumberingConfig {
    pub prefix: String,
    pub next_number: u32,
    pub padding: u32,
    pub preview: String,
}

#[tauri::command]
pub async fn get_quote_numbering_config() -> Result<QuoteNumberingConfig, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let prefix: String = conn.query_row("SELECT value FROM settings WHERE key='quote_prefix'", [], |r| r.get(0)).ok().unwrap_or_else(|| "QUO-".into());
    let next_number: u32 = conn.query_row("SELECT value FROM settings WHERE key='quote_next_number'", [], |r| r.get::<_,String>(0)).ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let padding: u32 = conn.query_row("SELECT value FROM settings WHERE key='quote_padding'", [], |r| r.get::<_,String>(0)).ok().and_then(|s| s.parse().ok()).unwrap_or(4);
    let preview = format!("{}{:0>width$}", prefix, next_number, width = padding as usize);
    Ok(QuoteNumberingConfig { prefix, next_number, padding, preview })
}

#[tauri::command]
pub async fn save_quote_numbering_config(prefix: String, next_number: u32, padding: u32) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('quote_prefix',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&prefix]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('quote_next_number',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&next_number.to_string()]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('quote_padding',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&padding.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================
//  Payments (Stripe — bare bones)
// ============================================================

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Payment {
    pub id: String,
    pub invoice_id: String,
    pub amount: f64,
    pub currency: String,
    pub status: String,
    pub payment_method: Option<String>,
    pub stripe_payment_intent_id: Option<String>,
    pub stripe_charge_id: Option<String>,
    pub stripe_customer_id: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(serde::Serialize)]
pub struct StripeConfigStatus {
    pub configured: bool,
    pub publishable_key_present: bool,
    pub secret_key_present: bool,
    pub webhook_secret_present: bool,
}

#[tauri::command]
pub async fn list_payments(invoice_id: Option<String>) -> Result<Vec<Payment>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, params): (String, Vec<String>) = match &invoice_id {
        Some(iid) => ("SELECT * FROM payments WHERE invoice_id=?1 ORDER BY created_at DESC".into(), vec![iid.clone()]),
        None => ("SELECT * FROM payments ORDER BY created_at DESC".into(), vec![]),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| Ok(Payment {
        id: r.get(0)?, invoice_id: r.get(1)?, amount: r.get(2)?, currency: r.get(3)?,
        status: r.get(4)?, payment_method: r.get(5)?, stripe_payment_intent_id: r.get(6)?,
        stripe_charge_id: r.get(7)?, stripe_customer_id: r.get(8)?, error_message: r.get(9)?,
        created_at: r.get(10)?, updated_at: r.get(11)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_payment(id: String) -> Result<Option<Payment>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let p = conn.query_row("SELECT * FROM payments WHERE id=?1", [&id], |r| Ok(Payment {
        id: r.get(0)?, invoice_id: r.get(1)?, amount: r.get(2)?, currency: r.get(3)?,
        status: r.get(4)?, payment_method: r.get(5)?, stripe_payment_intent_id: r.get(6)?,
        stripe_charge_id: r.get(7)?, stripe_customer_id: r.get(8)?, error_message: r.get(9)?,
        created_at: r.get(10)?, updated_at: r.get(11)?,
    })).ok();
    Ok(p)
}

#[tauri::command]
pub async fn create_payment_request(invoice_id: String) -> Result<Payment, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let total: f64 = conn.query_row("SELECT total FROM invoices WHERE id=?1", [&invoice_id], |r| r.get(0)).map_err(|e| format!("invoice not found: {}", e))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    // TODO(stripe): replace with stripe::PaymentIntent::create when keys are configured
    conn.execute(
        "INSERT INTO payments (id,invoice_id,amount,currency,status,created_at,updated_at) VALUES (?1,?2,?3,'usd','pending',?4,?4)",
        rusqlite::params![id, invoice_id, total, now],
    ).map_err(|e| e.to_string())?;
    let cols = {
        let mut m = serde_json::Map::new();
        m.insert("invoice_id".into(), serde_json::Value::String(invoice_id.clone()));
        m.insert("amount".into(), serde_json::json!(total));
        m.insert("currency".into(), serde_json::Value::String("usd".into()));
        m.insert("status".into(), serde_json::Value::String("pending".into()));
        m.insert("created_at".into(), serde_json::Value::String(now.clone()));
        m.insert("updated_at".into(), serde_json::Value::String(now.clone()));
        m
    };
    crate::sync::record_upsert("payments", &id, cols).map_err(|e| e.to_string())?;
    Ok(Payment { id, invoice_id, amount: total, currency: "usd".into(), status: "pending".into(), payment_method: None, stripe_payment_intent_id: None, stripe_charge_id: None, stripe_customer_id: None, error_message: None, created_at: now.clone(), updated_at: now })
}

#[tauri::command]
pub async fn update_payment_status(id: String, status: String, stripe_id: Option<String>) -> Result<(), String> {
    let valid = ["pending", "paid", "failed", "refunded"];
    if !valid.contains(&status.as_str()) { return Err("Invalid status".into()); }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(sid) = &stripe_id {
        conn.execute("UPDATE payments SET status=?1, stripe_payment_intent_id=?2, updated_at=?3 WHERE id=?4", rusqlite::params![status, sid, now, id]).map_err(|e| e.to_string())?;
    } else {
        conn.execute("UPDATE payments SET status=?1, updated_at=?2 WHERE id=?3", rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mark_payment_failed(id: String, error: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("UPDATE payments SET status='failed', error_message=?1, updated_at=?2 WHERE id=?3", rusqlite::params![error, now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn refund_payment(id: String, reason: Option<String>) -> Result<(), String> {
    // TODO(stripe): replace with stripe::Refund::create when keys are configured
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let err = reason.unwrap_or_else(|| "Manual refund".into());
    conn.execute("UPDATE payments SET status='refunded', error_message=?1, updated_at=?2 WHERE id=?3 AND status='paid'", rusqlite::params![err, now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn save_stripe_keys(publishable: String, secret: String, webhook_secret: String) -> Result<(), String> {
    crate::email::save_cred("stripe_publishable_key", &publishable).map_err(|e| e.to_string())?;
    crate::email::save_cred("stripe_secret_key", &secret).map_err(|e| e.to_string())?;
    crate::email::save_cred("stripe_webhook_secret", &webhook_secret).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES ('stripe_configured','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_stripe_config() -> Result<StripeConfigStatus, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let configured: bool = conn.query_row("SELECT value FROM settings WHERE key='stripe_configured'", [], |r| r.get::<_,String>(0)).ok().map_or(false, |v| v == "1");
    let pk = crate::email::cred_opt("stripe_publishable_key").is_some();
    let sk = crate::email::cred_opt("stripe_secret_key").is_some();
    let wh = crate::email::cred_opt("stripe_webhook_secret").is_some();
    Ok(StripeConfigStatus { configured, publishable_key_present: pk, secret_key_present: sk, webhook_secret_present: wh })
}

#[tauri::command]
pub async fn delete_stripe_keys() -> Result<(), String> {
    crate::email::delete_cred("stripe_publishable_key").map_err(|e| e.to_string())?;
    crate::email::delete_cred("stripe_secret_key").map_err(|e| e.to_string())?;
    crate::email::delete_cred("stripe_webhook_secret").map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings WHERE key='stripe_configured'", []).map_err(|e| e.to_string())?;
    Ok(())
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
    // Soft-delete (archive) instead of a hard DELETE: avoids the FK crash
    // (payments → invoices, no cascade), syncs reliably, and feeds the Archive.
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("archived".into(), Value::from(1));
    cols.insert("archived_at".into(), Value::String(now.clone()));
    sync::record_upsert("invoices", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE invoices SET archived=1, archived_at=?1 WHERE id=?2", rusqlite::params![now, id])
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RecurringInvoice {
    pub id: String,
    pub client_id: String,
    pub client_name: String,
    pub template_name: String,
    pub line_items_json: String,
    pub tax_rate: f64,
    pub notes: Option<String>,
    pub payment_method_label: Option<String>,
    pub frequency: String,
    pub next_due_date: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RecurringInvoiceInput {
    pub client_id: String,
    pub template_name: String,
    pub line_items: Vec<crate::invoice::LineItem>,
    pub tax_rate: f64,
    pub notes: Option<String>,
    pub payment_method_label: Option<String>,
    pub frequency: String,
}

#[tauri::command]
pub async fn list_recurring_invoices() -> Result<Vec<RecurringInvoice>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT r.id, r.client_id, COALESCE(c.name,''), r.template_name, r.line_items_json, r.tax_rate, r.notes,
                r.payment_method_label, r.frequency, r.next_due_date, r.is_active, r.created_at, r.updated_at
         FROM recurring_invoices r LEFT JOIN clients c ON c.id = r.client_id
         ORDER BY r.is_active DESC, r.next_due_date ASC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(RecurringInvoice {
        id: r.get(0)?, client_id: r.get(1)?, client_name: r.get(2)?,
        template_name: r.get(3)?, line_items_json: r.get(4)?, tax_rate: r.get(5)?,
        notes: r.get(6)?, payment_method_label: r.get(7)?, frequency: r.get(8)?,
        next_due_date: r.get(9)?, is_active: r.get::<_, bool>(10)?,
        created_at: r.get(11)?, updated_at: r.get(12)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_recurring_invoice(input: RecurringInvoiceInput) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let next_due = compute_next_recurring(&now, &input.frequency);
    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("template_name".into(), Value::String(input.template_name.clone()));
    cols.insert("line_items_json".into(), Value::String(items_json.clone()));
    cols.insert("tax_rate".into(), json!(input.tax_rate));
    if let Some(n) = &input.notes { cols.insert("notes".into(), Value::String(n.clone())); }
    if let Some(p) = &input.payment_method_label { cols.insert("payment_method_label".into(), Value::String(p.clone())); }
    cols.insert("frequency".into(), Value::String(input.frequency.clone()));
    cols.insert("next_due_date".into(), Value::String(next_due.clone()));
    cols.insert("is_active".into(), json!(1));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("recurring_invoices", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO recurring_invoices (id, client_id, template_name, line_items_json, tax_rate, notes, payment_method_label, frequency, next_due_date, is_active, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10)",
        rusqlite::params![id, input.client_id, input.template_name, items_json, input.tax_rate, input.notes, input.payment_method_label, input.frequency, next_due, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_recurring_invoice(id: String, input: RecurringInvoiceInput) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let items_json = serde_json::to_string(&input.line_items).map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(input.client_id.clone()));
    cols.insert("template_name".into(), Value::String(input.template_name.clone()));
    cols.insert("line_items_json".into(), Value::String(items_json.clone()));
    cols.insert("tax_rate".into(), json!(input.tax_rate));
    cols.insert("notes".into(), to_value(input.notes.clone()));
    cols.insert("payment_method_label".into(), to_value(input.payment_method_label.clone()));
    cols.insert("frequency".into(), Value::String(input.frequency.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("recurring_invoices", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE recurring_invoices SET client_id=?2, template_name=?3, line_items_json=?4, tax_rate=?5, notes=?6, payment_method_label=?7, frequency=?8, updated_at=?9 WHERE id=?1",
        rusqlite::params![id, input.client_id, input.template_name, items_json, input.tax_rate, input.notes, input.payment_method_label, input.frequency, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pause_recurring_invoice(id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("is_active".into(), json!(0));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("recurring_invoices", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE recurring_invoices SET is_active=0, updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn resume_recurring_invoice(id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let next_due = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let (freq, existing_due): (String, String) = conn.query_row(
            "SELECT frequency, next_due_date FROM recurring_invoices WHERE id=?1", [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| e.to_string())?;
        let date = chrono::DateTime::parse_from_rfc3339(&existing_due).unwrap_or_else(|_| Utc::now().fixed_offset());
        if date <= Utc::now().fixed_offset() {
            compute_next_recurring(&now, &freq)
        } else {
            existing_due
        }
    };
    let mut cols = Map::new();
    cols.insert("is_active".into(), json!(1));
    cols.insert("next_due_date".into(), Value::String(next_due.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("recurring_invoices", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE recurring_invoices SET is_active=1, next_due_date=?2, updated_at=?3 WHERE id=?1", rusqlite::params![id, next_due, now]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_recurring_invoice(id: String) -> Result<(), String> {
    sync::record_delete("recurring_invoices", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM recurring_invoices WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn generate_recurring_invoices() -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, client_id, line_items_json, tax_rate, frequency FROM recurring_invoices
         WHERE is_active=1 AND next_due_date <= date('now')"
    ).map_err(|e| e.to_string())?;
    let ids: Vec<(String, String, String, f64, String)> = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    drop(stmt);
    drop(conn);

    let mut count = 0u32;
    for (template_id, client_id, items_json, tax_rate, freq) in &ids {
        let items: Vec<crate::invoice::LineItem> = serde_json::from_str(items_json).unwrap_or_default();
        let (subtotal, tax, total) = crate::invoice::compute_totals(&items, *tax_rate as f64);
        let inv_id = Uuid::new_v4().to_string();
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
        sync::record_upsert("invoices", &inv_id, cols).map_err(|e| e.to_string())?;

        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO invoices (id,client_id,number,issue_date,due_date,line_items_json,subtotal,tax,total,status,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?4)",
            rusqlite::params![inv_id, client_id, number, issue, due, line_items_json, subtotal, tax, total],
        ).map_err(|e| e.to_string())?;

        let next = compute_next_recurring(&now.to_rfc3339(), freq);
        let _ = conn.execute("UPDATE recurring_invoices SET next_due_date=?1 WHERE id=?2", rusqlite::params![next, template_id]);

        count += 1;
    }
    Ok(count)
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

fn compute_next_due(freq: &str) -> String {
    let now = Utc::now();
    let next = match freq {
        "monthly" => now + chrono::Duration::days(30),
        "quarterly" => now + chrono::Duration::days(90),
        _ => now + chrono::Duration::days(30),
    };
    next.to_rfc3339()
}

#[tauri::command]
pub async fn generate_invoice_pdf(invoice_id: String) -> Result<String, String> {
    crate::invoice::generate_pdf(&invoice_id)
        .await
        .map_err(|e| e.to_string())
}

// ── Invoice branding / template ─────────────────────────────────────────────

/// Current invoice branding template (defaults if unset; `show_company_name`
/// migrates from company_info when the template key is absent).
#[tauri::command]
pub async fn get_invoice_template() -> Result<crate::invoice::InvoiceTemplate, String> {
    Ok(crate::invoice::load_template())
}

/// Save the invoice branding template (upsert into settings `invoice_template`).
/// Does NOT touch company_info.
#[tauri::command]
pub async fn save_invoice_template(template: crate::invoice::InvoiceTemplate) -> Result<(), String> {
    crate::invoice::save_template(&template).map_err(|e| e.to_string())
}

/// Current quote branding template (defaults to the invoice shape with a "QUOTE" title).
#[tauri::command]
pub async fn get_quote_template() -> Result<crate::invoice::InvoiceTemplate, String> {
    Ok(crate::invoice::load_quote_template())
}

/// Save the quote branding template (upsert into settings `quote_template`).
#[tauri::command]
pub async fn save_quote_template(template: crate::invoice::InvoiceTemplate) -> Result<(), String> {
    crate::invoice::save_quote_template(&template).map_err(|e| e.to_string())
}

/// Render a sample quote PDF (current company_info + quote_template + dummy data) and open
/// it in the OS viewer, so the quote branding editor can preview the real layout.
#[tauri::command]
pub async fn render_sample_quote_pdf(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = crate::invoice::render_sample_quote_pdf().map_err(|e| e.to_string())?;
    use tauri_plugin_shell::ShellExt;
    app_handle.shell().open(path.clone(), None).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Render a sample invoice PDF (current company_info + template + dummy data) and
/// return its path, so the branding editor can open the actual PDF.
#[tauri::command]
pub async fn render_sample_invoice_pdf(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = crate::invoice::render_sample_pdf().map_err(|e| e.to_string())?;
    // Open it in the OS viewer, mirroring preview_invoice_pdf — the frontend just
    // awaits and expects the PDF to appear (no separate open step on that side).
    use tauri_plugin_shell::ShellExt;
    app_handle.shell().open(path.clone(), None).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Render the invoice PDF for `invoice_id` (any status) and open it in the OS
/// viewer, so an invoice can be viewed from the detail panel in any state.
#[tauri::command]
pub async fn open_invoice_pdf(app_handle: tauri::AppHandle, invoice_id: String) -> Result<String, String> {
    let path = crate::invoice::generate_pdf(&invoice_id).await.map_err(|e| e.to_string())?;
    use tauri_plugin_shell::ShellExt;
    app_handle.shell().open(path.clone(), None).map_err(|e| e.to_string())?;
    Ok(path)
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
        &notes, "draft", "invoice",
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

/// Mark an invoice VOID (the deal fell through) or clear the flag. A void invoice
/// is kept (never deleted) but excluded from receivables/AR "owed", the dashboard
/// cash position, and revenue/profit rollups. The original `status` is untouched,
/// so unvoiding restores the invoice exactly. Synced.
#[tauri::command]
pub async fn set_invoice_void(invoice_id: String, void: bool) -> Result<(), String> {
    let flag = if void { 1 } else { 0 };
    // Stamp when the void happened (cleared on un-void) so periodic stats can
    // count deals lost per period, not just the flag.
    let voided_at: Option<String> = if void { Some(Utc::now().to_rfc3339()) } else { None };
    let mut cols = Map::new();
    cols.insert("voided".into(), Value::from(flag));
    cols.insert("voided_at".into(), voided_at.clone().map(Value::from).unwrap_or(Value::Null));
    sync::record_upsert("invoices", &invoice_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE invoices SET voided=?1, voided_at=?2 WHERE id=?3", rusqlite::params![flag, voided_at, invoice_id])
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
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE COALESCE(archived,0)=0 ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| map_deal_row(r)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_deals_by_stage(stage: String) -> Result<Vec<Deal>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE stage=?1 AND COALESCE(archived,0)=0 ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&stage], |r| map_deal_row(r)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn get_deal(id: String) -> Result<Deal, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id,client_id,title,stage,line_items_json,supplier_costs_json,shipping_cost,other_costs,asking_price,payment_terms,notes,expected_close_date,created_at,updated_at,won_at,lost_at,lost_reason,converted_invoice_id,metadata FROM deals WHERE id=?1 AND COALESCE(archived,0)=0",
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


#[tauri::command]
pub async fn delete_deal(id: String) -> Result<(), String> {
    // Soft-delete (archive) instead of a hard DELETE — reversible + sync-safe.
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("archived".into(), Value::from(1));
    cols.insert("archived_at".into(), Value::String(now.clone()));
    sync::record_upsert("deals", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deals SET archived=1, archived_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
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
    /// Cost type so net_profit can be broken down: supplier (default) | freight | wire_in | wire_out | other.
    #[serde(default)]
    pub category: Option<String>,
    /// "Didn't pay — kept it": you're keeping this supplier's cut rather than paying
    /// it, so it is NOT a real cost. Excluded from total_supplier_cost (and therefore
    /// from profit and from Free Cash payables). Distinct from `paid` (a cash-flow
    /// status for money you still owe).
    #[serde(default)]
    pub kept: bool,
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
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DealFlow {
    pub id: String,
    pub name: Option<String>,
    pub invoice_id: String,
    pub stage: String,
    pub payment_received_amount: f64,
    #[serde(default)]
    pub deposit_amount: f64,
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
        deposit_amount: r.get("deposit_amount").unwrap_or(0.0),
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
    // "kept" payments (you didn't pay — you're keeping the cut) are NOT a real cost.
    let total: f64 = payments.iter().filter(|p| !p.kept).map(|p| p.amount).sum();
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

/// Mark a supplier payment as "kept" (you didn't pay it — you're keeping the cut),
/// or clear it. A kept payment stops counting as a cost, so the deal's profit is what
/// you actually kept. `kept` implies not-paid. On an already-completed deal the
/// recorded profit is re-derived (bank-truth, with the kept amount excluded).
#[tauri::command]
pub async fn set_supplier_payment_kept(id: String, payment_id: String, kept: bool) -> Result<(), String> {
    let df = read_df(&id)?;
    let mut payments = df.supplier_payments.clone();
    {
        let p = payments.iter_mut().find(|p| p.id == payment_id).ok_or("Payment not found")?;
        p.kept = kept;
        if kept { p.paid = false; p.paid_at = None; }
    }
    write_sp(&id, &payments, &df.invoice_id)?;
    if df.stage == "complete" {
        resync_completed_deal(&id)?;
    }
    Ok(())
}

fn recalc_completed_deal_flow(id: &str, gross: f64, payments: &[SupplierPayment]) -> Result<(), String> {
    let split = read_profit_split()?;
    // "kept" supplier payments aren't a real cost — exclude from the recalc.
    let total_cost: f64 = payments.iter().filter(|p| !p.kept).map(|p| p.amount).sum();
    let net = gross - total_cost;
    let is_loss = net < 0.0;

    // Read the STORED metadata so we honor the payout decision made at completion.
    // A deal completed 100%-to-business (payout_included=false) must NOT be silently
    // re-split to partners just because a supplier payment was edited/deleted. We also
    // preserve shipping_status and any other keys already on the metadata.
    let mut meta_obj: Map<String, Value> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT metadata FROM deal_flows WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0))
            .ok().flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    };
    let include_payout = meta_obj.get("payout_included").and_then(|v| v.as_bool()).unwrap_or(false);

    // Mirror complete_deal_flow's branch: split by pct only when payout is included,
    // otherwise everything goes to the business.
    let (jack, ben, business) = if include_payout {
        ( (net * (split.jack_pct / 100.0) * 100.0).round() / 100.0,
          (net * (split.ben_pct / 100.0) * 100.0).round() / 100.0,
          (net * (split.business_pct / 100.0) * 100.0).round() / 100.0 )
    } else {
        (0.0, 0.0, net)
    };

    // Preserve existing metadata (payout_included, shipping_status, ...) and only
    // refresh is_loss — do NOT overwrite the whole object with just {is_loss}.
    meta_obj.insert("is_loss".into(), Value::Bool(is_loss));
    // Recompute the per-deal recipients breakdown against the new net, reusing
    // the shares captured at completion (the split the deal was agreed under);
    // deals completed before breakdowns existed pick up the current config.
    let shares = shares_from_breakdown(&meta_obj).unwrap_or_else(read_profit_split_shares_raw);
    meta_obj.insert("payout_recipients".into(), Value::Array(build_payout_breakdown(&shares, net, include_payout)));
    let meta_json = serde_json::to_string(&Value::Object(meta_obj)).map_err(|e| e.to_string())?;
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

    // Exclude archived deal flows, and deal flows whose invoice was voided/archived
    // ("deal fell through" / deleted) — they drop out of the active pipeline.
    let sql = format!(
        "{} WHERE COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 ORDER BY df.updated_at DESC",
        DF_JOIN
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_deal_flow_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn list_deal_flows_by_stage(stage: String) -> Result<Vec<DealFlow>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!(
        "{} WHERE df.stage=?1 AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 ORDER BY df.updated_at DESC",
        DF_JOIN
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&stage], map_deal_flow_row).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn mark_payment_received(id: String, input: PaymentReceivedInput) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "invoiced" && df.stage != "payment_received" { return Err("Can only mark payment received from 'invoiced' or 'payment_received' stage".into()); }

    let has_supplier = df.supplier_payments.iter().any(|p| p.amount > 0.0 || p.category != Some("wire_fee".into()));
    if !has_supplier {
        return Err("Please add at least one supplier cost before marking payment received".into());
    }

    let now = Utc::now().to_rfc3339();
    let received_at = input.received_at.unwrap_or_else(|| now.clone());

    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("payment_received".into()));
    cols.insert("payment_received_amount".into(), json!(input.amount));
    // The full payment absorbs any earlier deposit — clear it so the two figures
    // are never both live (balance owed is now 0).
    cols.insert("deposit_amount".into(), json!(0));
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
            "UPDATE deal_flows SET stage='payment_received', payment_received_amount=?1, deposit_amount=0, payment_received_method=?2, payment_received_at=?3, notes=COALESCE(?4, notes), updated_at=?5 WHERE id=?6",
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

/// Record a partial up-front deposit on a deal, SEPARATE from the full
/// "payment received" amount. Does NOT advance the stage — the balance owed
/// (invoice total − deposit) stays outstanding until the full payment is marked.
/// Pass amount=0 to clear the deposit.
#[tauri::command]
pub async fn set_deposit(id: String, amount: f64) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "invoiced" {
        return Err("Deposits can only be recorded before the full payment is marked received".into());
    }
    let amount = if amount < 0.0 { 0.0 } else { (amount * 100.0).round() / 100.0 };
    let now = Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("deposit_amount".into(), json!(amount));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET deposit_amount=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![amount, now, id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shared helper: wipe completion data from a deal_flow + its invoice.
/// Called when cascading an undo back through the 'complete' stage.
fn clear_completion(df: &DealFlow, id: &str, now: &str) -> Result<(), String> {
    // Drop the completion-time recipients breakdown too — the deal is no longer
    // complete, so a stale per-deal split must not linger in metadata. Other
    // metadata keys (shipping_status, payout_included, ...) are preserved.
    let meta_json: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT metadata FROM deal_flows WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).ok().flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .filter(|o| o.contains_key("payout_recipients"))
            .map(|mut o| { o.remove("payout_recipients"); serde_json::to_string(&Value::Object(o)).unwrap_or_else(|_| "{}".into()) })
    };
    let mut cols = Map::new();
    cols.insert("completed_at".into(), Value::Null);
    cols.insert("gross_revenue".into(), json!(0));
    cols.insert("net_profit".into(), json!(0));
    cols.insert("total_cost".into(), json!(0));
    cols.insert("profit_jack".into(), json!(0));
    cols.insert("profit_ben".into(), json!(0));
    cols.insert("profit_business".into(), json!(0));
    if let Some(ref m) = meta_json { cols.insert("metadata".into(), Value::String(m.clone())); }
    cols.insert("updated_at".into(), Value::String(now.to_string()));
    sync::record_upsert("deal_flows", id, cols).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE deal_flows SET completed_at=NULL, gross_revenue=0, net_profit=0, total_cost=0, \
             profit_jack=0, profit_ben=0, profit_business=0, metadata=COALESCE(?3, metadata), updated_at=?1 WHERE id=?2",
            rusqlite::params![now, id, meta_json],
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
        category: input.category,
        kept: false,
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
pub async fn complete_deal_flow(id: String, shipping_status: Option<String>, completed_date: Option<String>, payout_included: Option<bool>) -> Result<Value, String> {
    let df = read_df(&id)?;
    if df.stage != "supplier_paid" && df.stage != "payment_received" { return Err("Can only complete after payment is received".into()); }

    let split = read_profit_split()?;
    let include_payout = payout_included.unwrap_or(false);

    // Use caller-supplied date (YYYY-MM-DD) if provided; otherwise use now.
    let now = match completed_date.as_deref() {
        Some(d) if !d.is_empty() => format!("{}T00:00:00Z", d),
        _ => Utc::now().to_rfc3339(),
    };
    // Bank actuals win: if the deal has linked bank transactions, its recorded
    // revenue / cost / profit come from those real transactions (per money leg),
    // falling back to the entered figures only where nothing is linked.
    let (gross, total_cost, net) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let (g, c, n, _) = deal_bank_actuals(&conn, &id, df.payment_received_amount, df.total_supplier_cost);
        (g, c, n)
    };
    let is_loss = net < 0.0;
    let (jack, ben, business) = if include_payout {
        ( (net * (split.jack_pct / 100.0) * 100.0).round() / 100.0,
          (net * (split.ben_pct / 100.0) * 100.0).round() / 100.0,
          (net * (split.business_pct / 100.0) * 100.0).round() / 100.0 )
    } else {
        (0.0, 0.0, net)
    };

    let shipping_status = shipping_status.unwrap_or_else(|| "none".into());
    let awaiting_shipping = shipping_status == "awaiting";
    // Persist the N-way recipients breakdown alongside the legacy 3-way columns.
    // This is the authoritative per-deal split going forward; the jack/ben
    // columns above remain only so already-shipped readers keep working.
    let breakdown = build_payout_breakdown(&read_profit_split_shares_raw(), net, include_payout);
    // Snapshot the linked bank transactions onto the deal so the record (and the
    // profit) survives even if the bank statements are later deleted / re-imported.
    let bank_snapshot = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        bank_snapshot_value(&conn, &id)
    };
    let meta_json = serde_json::to_string(&json!({"is_loss": is_loss, "shipping_status": shipping_status, "payout_included": include_payout, "payout_recipients": breakdown, "bank_snapshot": bank_snapshot})).map_err(|e| e.to_string())?;

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
    // Auto-mark linked inventory lot as Sold (best-effort). Capture the affected
    // lot ids first so the status change can be synced to other devices.
    let sold_lot_ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM inventory WHERE linked_deal_id = (SELECT d.id FROM deals d WHERE d.converted_invoice_id = ?1) AND status='reserved'"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&df.invoice_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if let Err(e) = conn.execute(
        "UPDATE inventory SET status='sold' WHERE linked_deal_id = (SELECT d.id FROM deals d WHERE d.converted_invoice_id = ?1) AND status='reserved'",
        [&df.invoice_id],
    ) {
        tracing::warn!("auto-mark inventory sold failed: {}", e);
    } else {
        for lot_id in &sold_lot_ids {
            let mut cols = Map::new();
            cols.insert("status".into(), json!("sold"));
            if let Err(e) = crate::sync::record_upsert("inventory", lot_id, cols) {
                tracing::warn!("sync auto-sold inventory {}: {}", lot_id, e);
            }
        }
    }
    let warning = if is_loss { Some(format!("This deal resulted in a loss of ${:.2}", net.abs())) } else { None };
    Ok(json!({ "profit": net, "is_loss": is_loss, "warning": warning }))
}

/// Bank-precedence actuals for a deal. When a money leg has ANY linked bank
/// transaction, that leg's real bank total is the truth and wins over the
/// manually-entered figure; a leg with no bank link falls back to what was
/// entered. This is the single definition of a deal's recorded revenue / cost /
/// profit — used at completion, whenever an allocation changes, and behind the
/// reconciliation section — so Deal Flow and analytics always agree. Refunds are
/// accounted for separately (the refunds table + the analytics refund
/// subtraction), so `net` here is deliberately PRE-refund (revenue − cost),
/// matching the stored net_profit contract every report already relies on.
/// Returns (revenue, cost, net, has_any_bank_link).
fn deal_bank_actuals(
    conn: &rusqlite::Connection, deal_flow_id: &str, manual_gross: f64, manual_cost: f64,
) -> (f64, f64, f64, bool) {
    // Only ever count an allocation whose bank transaction still exists. A deleted /
    // re-imported statement can leave allocation rows pointing at a gone txn; those
    // dead rows must never inflate a deal's numbers (they were doubling actuals).
    let role_sum = |role: &str| -> f64 {
        conn.query_row(
            "SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a
             WHERE a.deal_flow_id=?1 AND a.role=?2
               AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)",
            rusqlite::params![deal_flow_id, role], |r| r.get(0),
        ).unwrap_or(0.0)
    };
    let exists = |sql: &str| -> bool { conn.query_row(sql, [deal_flow_id], |_| Ok(())).is_ok() };

    let buyer     = role_sum("buyer_payment");
    let supplier  = role_sum("supplier_payment");
    let fee       = role_sum("fee");
    let refund_in = role_sum("refund_in"); // supplier reversal → lowers our real cost
    let has_rev_link  = exists("SELECT 1 FROM bank_allocation a WHERE a.deal_flow_id=?1 AND a.role='buyer_payment' AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id) LIMIT 1");
    let has_cost_link = exists("SELECT 1 FROM bank_allocation a WHERE a.deal_flow_id=?1 AND a.role IN ('supplier_payment','fee') AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id) LIMIT 1");
    let any_link      = exists("SELECT 1 FROM bank_allocation a WHERE a.deal_flow_id=?1 AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id) LIMIT 1");

    let r2 = |x: f64| (x * 100.0).round() / 100.0;
    let rev  = if has_rev_link  { buyer } else { manual_gross };
    let cost = if has_cost_link { (supplier + fee - refund_in).max(0.0) } else { manual_cost };
    (r2(rev), r2(cost), r2(rev - cost), any_link)
}

/// Snapshot of the bank transactions currently linked to a deal — a plain copy
/// of role / amount / direction / counterparty / date captured onto the deal.
/// Recorded at completion (and refreshed as links change) so the deal's record
/// survives even if the underlying bank statements are later deleted or
/// re-imported. The stored net_profit remains the authoritative number; this
/// preserves the "which transactions built it" detail so profits never vanish.
fn bank_snapshot_value(conn: &rusqlite::Connection, deal_flow_id: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT a.role, a.amount, a.note, bt.direction, bt.counterparty_name, bt.posted_at, bt.id
         FROM bank_allocation a JOIN bank_txn bt ON bt.id=a.bank_txn_id
         WHERE a.deal_flow_id=?1 ORDER BY a.role, bt.posted_at",
    ) {
        if let Ok(rows) = stmt.query_map([deal_flow_id], |r| Ok(json!({
            "role":         r.get::<_, String>(0)?,
            "amount":       r.get::<_, f64>(1)?,
            "note":         r.get::<_, Option<String>>(2)?,
            "direction":    r.get::<_, String>(3)?,
            "counterparty": r.get::<_, Option<String>>(4)?,
            "posted_at":    r.get::<_, Option<String>>(5)?,
            "txn_id":       r.get::<_, String>(6)?,
        }))) {
            out = rows.filter_map(|r| r.ok()).collect();
        }
    }
    Value::Array(out)
}

/// Re-derive a COMPLETED deal's recorded revenue / cost / profit from bank
/// actuals (bank-precedence) and persist to deal_flows + invoices, preserving
/// the deal's existing payout-split choice. No-op unless the deal is complete.
///
/// FAIL-PROOF: the fallback for a money leg with no live bank link is the deal's
/// LAST RECORDED figure (not the originally-entered one), so losing a bank
/// statement can only ever leave a completed deal's profit untouched — never
/// erase or reset it. A live link refines the number; a missing one preserves it.
/// The linked transactions are also snapshotted into metadata for the record.
fn resync_completed_deal(id: &str) -> Result<(), String> {
    let df = read_df(id)?;
    if df.stage != "complete" { return Ok(()); }

    let (gross, total_cost, net, _has_bank, snapshot, supplier_date) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        // Fallback = already-recorded gross/cost (the completion snapshot), so a
        // vanished bank link keeps what's on the books instead of zeroing it.
        let (g, c, n, hb) = deal_bank_actuals(&conn, id, df.gross_revenue, df.total_cost);
        // When the supplier was paid via a linked bank transaction, THAT date is when
        // the deal actually finalized — use it as the completion date so weekly /
        // financial breakdowns reflect what really happened and when (not the day it
        // was entered). Only overrides when we actually have that date.
        let sup_date: Option<String> = conn.query_row(
            "SELECT MAX(bt.posted_at) FROM bank_allocation a JOIN bank_txn bt ON bt.id=a.bank_txn_id
             WHERE a.deal_flow_id=?1 AND a.role='supplier_payment' AND COALESCE(bt.posted_at,'') != ''",
            [id], |r| r.get::<_, Option<String>>(0),
        ).ok().flatten();
        (g, c, n, hb, bank_snapshot_value(&conn, id), sup_date)
    };

    let split = read_profit_split()?;
    let mut meta_map = serde_json::from_str::<Value>(df.metadata.as_deref().unwrap_or("{}"))
        .ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let include_payout = meta_map.get("payout_included").and_then(|v| v.as_bool()).unwrap_or(false);
    meta_map.insert("bank_snapshot".into(), snapshot);
    let meta_json = serde_json::to_string(&Value::Object(meta_map)).unwrap_or_else(|_| "{}".into());

    let (jack, ben, business) = if include_payout {
        ((net * (split.jack_pct / 100.0) * 100.0).round() / 100.0,
         (net * (split.ben_pct / 100.0) * 100.0).round() / 100.0,
         (net * (split.business_pct / 100.0) * 100.0).round() / 100.0)
    } else { (0.0, 0.0, net) };
    let margin_pct = if gross > 0.0 { (net / gross * 100.0 * 100.0).round() / 100.0 } else { 0.0 };
    let now = Utc::now().to_rfc3339();

    let mut cols = Map::new();
    cols.insert("gross_revenue".into(), json!(gross));
    cols.insert("total_cost".into(), json!(total_cost));
    cols.insert("net_profit".into(), json!(net));
    cols.insert("profit_jack".into(), json!(jack));
    cols.insert("profit_ben".into(), json!(ben));
    cols.insert("profit_business".into(), json!(business));
    cols.insert("metadata".into(), json!(meta_json));
    cols.insert("updated_at".into(), json!(now.clone()));
    if let Some(d) = &supplier_date { cols.insert("completed_at".into(), json!(d)); }
    sync::record_upsert("deal_flows", id, cols).map_err(|e| e.to_string())?;

    let mut inv_cols = Map::new();
    inv_cols.insert("profit".into(), json!(net));
    inv_cols.insert("total_cost".into(), json!(total_cost));
    inv_cols.insert("margin".into(), json!(margin_pct));
    sync::record_upsert("invoices", &df.invoice_id, inv_cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE deal_flows SET gross_revenue=?1, total_cost=?2, net_profit=?3, profit_jack=?4, profit_ben=?5, profit_business=?6, metadata=?7, updated_at=?8 WHERE id=?9",
        rusqlite::params![gross, total_cost, net, jack, ben, business, meta_json, now, id],
    ).map_err(|e| e.to_string())?;
    if let Some(d) = &supplier_date {
        conn.execute("UPDATE deal_flows SET completed_at=?1 WHERE id=?2", rusqlite::params![d, id]).ok();
    }
    conn.execute(
        "UPDATE invoices SET profit=?1, total_cost=?2, margin=?3 WHERE id=?4",
        rusqlite::params![net, total_cost, margin_pct, df.invoice_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Recalculate a completed deal's recorded numbers from its linked bank
/// transactions (bank-precedence). Exposed as the "Recalculate from bank" action
/// and called automatically whenever an allocation is added or removed.
#[tauri::command]
pub async fn recalc_deal_from_bank(id: String) -> Result<Value, String> {
    resync_completed_deal(&id)?;
    let df = read_df(&id)?;
    let (gross, cost, net, has_bank) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        deal_bank_actuals(&conn, &id, df.payment_received_amount, df.total_supplier_cost)
    };
    crate::netsync::push_now();
    Ok(json!({ "gross_revenue": gross, "supplier_cost": cost, "net_profit": net, "from_bank": has_bank }))
}

#[tauri::command]
pub async fn uncomplete_deal_flow(id: String) -> Result<(), String> {
    let df = read_df(&id)?;
    if df.stage != "complete" { return Ok(()); }

    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("stage".into(), Value::String("invoiced".into()));
    cols.insert("completed_at".into(), Value::Null);
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;

    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET stage='invoiced', completed_at=NULL, updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    }

    sync_invoice_stage(&df.invoice_id, "invoiced")?;

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

// ──────────────────────── Refunds, customer credits, rep payouts ────────────────────────

fn r2(x: f64) -> f64 { (x * 100.0).round() / 100.0 }

/// Lead rep's cut: gross_pct = % of sale, profit_pct = % of profit, fixed = flat $.
fn rep_cut(pay_type: &str, value: f64, gross: f64, net: f64) -> f64 {
    r2(match pay_type { "gross_pct" => gross * value / 100.0, "fixed" => value, _ => net * value / 100.0 })
}
/// Cut after a refund ("only what's left"): % on the reduced figures; fixed capped
/// at the profit that remains.
fn rep_cut_after_refund(pay_type: &str, value: f64, eff_gross: f64, eff_net: f64) -> f64 {
    r2(match pay_type { "gross_pct" => eff_gross.max(0.0) * value / 100.0, "fixed" => value.min(eff_net.max(0.0)), _ => eff_net.max(0.0) * value / 100.0 })
}
fn setting_bool(key: &str) -> bool {
    pool().get().ok()
        .and_then(|c| c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0)).ok())
        .map(|v| v == "1" || v == "true").unwrap_or(false)
}

#[tauri::command]
pub async fn create_refund(deal_flow_id: String, amount: f64, method: Option<String>, source: Option<String>, source_supplier_ref: Option<String>, keep_rep_cut: Option<bool>, reason: Option<String>, bank_txn_id: Option<String>) -> Result<String, String> {
    if !(amount > 0.0) { return Err("Refund amount must be positive".into()); }
    let amt = r2(amount);
    let keep: i64 = if keep_rep_cut.unwrap_or(false) { 1 } else { 0 };
    let txn = bank_txn_id.clone().filter(|s| !s.trim().is_empty());
    // If this refund was paid from a real bank transaction, link it first — this
    // validates direction (money out) + exclusivity and books it into Financials.
    // It fails cleanly, before any refund row is written, if the txn can't take it.
    if let Some(ref t) = txn {
        allocate_bank_txn(t.clone(), deal_flow_id.clone(), amt, "refund_out".to_string(),
            reason.clone().unwrap_or_else(|| "Refund".into()), None).await?;
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let client_id: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT i.client_id FROM deal_flows df LEFT JOIN invoices i ON df.invoice_id=i.id WHERE df.id=?1", [&deal_flow_id], |r| r.get::<_, Option<String>>(0)).map_err(|_| "Deal not found".to_string())?
    };
    let mut cols = Map::new();
    cols.insert("deal_flow_id".into(), Value::String(deal_flow_id.clone()));
    cols.insert("client_id".into(), to_value(client_id.clone()));
    cols.insert("amount".into(), json!(amt));
    cols.insert("method".into(), to_value(method.clone()));
    cols.insert("source".into(), to_value(source.clone()));
    cols.insert("source_supplier_ref".into(), to_value(source_supplier_ref.clone()));
    cols.insert("keep_rep_cut".into(), json!(keep));
    cols.insert("reason".into(), to_value(reason.clone()));
    cols.insert("bank_txn_id".into(), to_value(txn.clone()));
    cols.insert("refunded_at".into(), Value::String(now.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("refunds", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO refunds (id,deal_flow_id,client_id,amount,method,source,source_supplier_ref,keep_rep_cut,reason,bank_txn_id,refunded_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?11)",
        rusqlite::params![id, deal_flow_id, client_id, amt, method, source, source_supplier_ref, keep, reason, txn, now]).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(id)
}

#[tauri::command]
pub async fn list_refunds(deal_flow_id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, amount, COALESCE(method,''), COALESCE(source,''), COALESCE(source_supplier_ref,''), keep_rep_cut, COALESCE(reason,''), COALESCE(refunded_at,''), COALESCE(bank_txn_id,'') FROM refunds WHERE deal_flow_id=?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&deal_flow_id], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "amount": r.get::<_, f64>(1)?, "method": r.get::<_, String>(2)?,
        "source": r.get::<_, String>(3)?, "source_supplier_ref": r.get::<_, String>(4)?,
        "keep_rep_cut": r.get::<_, i64>(5)? != 0, "reason": r.get::<_, String>(6)?, "refunded_at": r.get::<_, String>(7)?,
        "bank_txn_id": r.get::<_, String>(8)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

#[tauri::command]
pub async fn set_refund_owed(deal_flow_id: String, amount: f64) -> Result<(), String> {
    let owed = r2(amount.max(0.0));
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("refund_owed".into(), json!(owed));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &deal_flow_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET refund_owed=?1, updated_at=?2 WHERE id=?3", rusqlite::params![owed, now, deal_flow_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_refund(id: String) -> Result<(), String> {
    // If this refund was paid from a linked bank transaction, unlink that allocation
    // too so the money frees back up in Financials (and can be re-paired elsewhere).
    let linked: Option<(String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT deal_flow_id, COALESCE(bank_txn_id,'') FROM refunds WHERE id=?1", [&id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).ok()
    };
    if let Some((deal_flow_id, txn)) = linked {
        if !txn.is_empty() {
            let alloc_ids: Vec<String> = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                let mut stmt = conn.prepare("SELECT id FROM bank_allocation WHERE bank_txn_id=?1 AND deal_flow_id=?2 AND role='refund_out'").map_err(|e| e.to_string())?;
                let ids = stmt.query_map(rusqlite::params![txn, deal_flow_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
                ids.filter_map(|x| x.ok()).collect()
            };
            for aid in &alloc_ids {
                sync::record_delete("bank_allocation", aid).map_err(|e| e.to_string())?;
            }
            let conn = pool().get().map_err(|e| e.to_string())?;
            for aid in &alloc_ids {
                conn.execute("DELETE FROM bank_allocation WHERE id=?1", [aid]).map_err(|e| e.to_string())?;
            }
        }
    }
    sync::record_delete("refunds", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM refunds WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// Money RECEIVED on a deal that isn't in the bank feed — a custom/manual line.
/// Bank-linked receipts are booked as bank_allocation(buyer_payment) via
/// allocate_bank_txn; this table is only the manual side, so the refund workspace
/// can total everything the customer paid.
#[tauri::command]
pub async fn add_deal_receipt(deal_flow_id: String, amount: f64, label: Option<String>) -> Result<String, String> {
    if !(amount > 0.0) { return Err("Amount must be positive".into()); }
    let id = format!("rcpt_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let amt = r2(amount);
    let lbl = label.unwrap_or_default();
    // Author's org, for the same reason as bank_allocation. (This table has no
    // created_by column, so there is no authorship stamp to record here.)
    let org = crate::employees::session_org_id();
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(org));
    cols.insert("deal_flow_id".into(), json!(deal_flow_id));
    cols.insert("amount".into(), json!(amt));
    cols.insert("label".into(), json!(lbl));
    cols.insert("received_at".into(), json!(now));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("deal_receipts", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO deal_receipts (id,org_id,deal_flow_id,amount,label,received_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6,?6)",
        rusqlite::params![id, org, deal_flow_id, amt, lbl, now]).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(id)
}

#[tauri::command]
pub async fn list_deal_receipts(deal_flow_id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, amount, COALESCE(label,''), COALESCE(received_at,'') FROM deal_receipts WHERE deal_flow_id=?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&deal_flow_id], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "amount": r.get::<_, f64>(1)?, "label": r.get::<_, String>(2)?, "received_at": r.get::<_, String>(3)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

#[tauri::command]
pub async fn delete_deal_receipt(id: String) -> Result<(), String> {
    sync::record_delete("deal_receipts", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM deal_receipts WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// Dynamic owner-split shares (name, pct, is_business). Reads `profit_split_json`.
/// Returns an empty list when the org has not configured a split — we never fall
/// back to a default split or partner names. Each share takes pct% of the profit.
fn read_profit_split_shares() -> Vec<(String, f64, bool)> {
    read_profit_split_shares_raw().into_iter().map(|(n, p, b, _)| (n, p, b)).collect()
}

/// Same as `read_profit_split_shares` but keeps the optional `kind` field
/// (person | business | investment | other) so completion can persist it in
/// the per-deal breakdown.
fn read_profit_split_shares_raw() -> Vec<(String, f64, bool, String)> {
    if let Ok(conn) = pool().get() {
        if let Ok(j) = conn.query_row("SELECT value FROM settings WHERE key='profit_split_json'", [], |r| r.get::<_, String>(0)) {
            if !j.trim().is_empty() {
                if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&j) {
                    let shares = parse_split_shares(&arr);
                    if !shares.is_empty() { return shares; }
                }
            }
        }
    }
    // No configured split → unconfigured. We never assume a default split or
    // partner names; callers treat an empty list as "payouts not set up yet".
    Vec::new()
}

/// Parse split-share rows ([{name,pct,is_business,kind}]) into tuples, applying
/// the same skip/label rules everywhere: nameless non-business rows are dropped,
/// a nameless business row is labeled "Business".
fn parse_split_shares(arr: &[Value]) -> Vec<(String, f64, bool, String)> {
    arr.iter().filter_map(|e| {
        let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let pct = e.get("pct").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let is_biz = e.get("is_business").and_then(|x| x.as_bool()).unwrap_or(false);
        if name.is_empty() && !is_biz { return None; }
        let name = if is_biz && name.is_empty() { "Business".to_string() } else { name };
        let kind = e.get("kind").and_then(|x| x.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| if is_biz { "business".into() } else { "person".into() });
        Some((name, pct, is_biz, kind))
    }).collect()
}

/// Build the per-deal recipients breakdown persisted at completion
/// (metadata.payout_recipients). Splits this deal's net across the N-way
/// configured shares via `allocate_payout`: payout_included=true divides by
/// pct; false routes 100% of net to the business share(s) (the net_excl rule).
/// Empty when the split is unconfigured — display sites then fall back to the
/// legacy profit columns for old deals.
pub fn build_payout_breakdown(shares: &[(String, f64, bool, String)], net: f64, include_payout: bool) -> Vec<Value> {
    let tuples: Vec<(String, f64, bool)> = shares.iter().map(|(n, p, b, _)| (n.clone(), *p, *b)).collect();
    let (net_incl, net_excl) = if include_payout { (net, 0.0) } else { (0.0, net) };
    allocate_payout(net_incl, net_excl, &tuples).into_iter().zip(shares.iter())
        .map(|((name, is_biz, amount), (_, pct, _, kind))| json!({
            "name": name, "pct": pct, "is_business": is_biz, "kind": kind, "amount": amount
        })).collect()
}

/// Shares captured in a deal's stored breakdown (metadata.payout_recipients).
/// None when the deal predates per-deal breakdowns or the array is empty, so
/// callers can fall back to the current org config.
fn shares_from_breakdown(meta_obj: &Map<String, Value>) -> Option<Vec<(String, f64, bool, String)>> {
    let arr = meta_obj.get("payout_recipients")?.as_array()?;
    let shares = parse_split_shares(arr);
    if shares.is_empty() { None } else { Some(shares) }
}

/// Split a period's net profit across the configured recipients.
/// `net_incl` = net from deals where partners were cut in (payout_included=true);
/// `net_excl` = net from deals kept 100% by the business (payout_included=false).
/// Returns (name, is_business, amount) in the recipients' order. Empty when
/// unconfigured. The included portion is divided by each recipient's pct (which
/// the editor forces to sum to 100); the excluded portion goes to the business
/// recipient(s), or — if none is marked business — is split like the included part.
pub fn allocate_payout(net_incl: f64, net_excl: f64, recipients: &[(String, f64, bool)]) -> Vec<(String, bool, f64)> {
    if recipients.is_empty() { return Vec::new(); }
    let biz_pct_sum: f64 = recipients.iter().filter(|(_, _, b)| *b).map(|(_, p, _)| *p).sum();
    let biz_count = recipients.iter().filter(|(_, _, b)| *b).count();
    let any_biz = biz_count > 0;
    recipients.iter().map(|(name, pct, is_biz)| {
        let base = net_incl * pct / 100.0;
        let extra = if net_excl.abs() < 0.000001 {
            0.0
        } else if any_biz {
            if *is_biz {
                if biz_pct_sum > 0.0 { net_excl * pct / biz_pct_sum } else { net_excl / biz_count as f64 }
            } else { 0.0 }
        } else {
            net_excl * pct / 100.0
        };
        (name.clone(), *is_biz, ((base + extra) * 100.0).round() / 100.0)
    }).collect()
}

/// Flip a completed deal's payout_included flag in place (metadata JSON), so past
/// deals can adopt or leave the configured split without uncomplete→recomplete.
/// Drops any stored payout_recipients breakdown so displays re-derive it from the
/// live split config (matching the migration's fallback behavior).
#[tauri::command]
pub async fn set_deal_payout_included(id: String, included: bool) -> Result<(), String> {
    let meta_json: String = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COALESCE(metadata,'{}') FROM deal_flows WHERE id=?1", [&id], |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    let mut meta: Value = serde_json::from_str(&meta_json).unwrap_or_else(|_| json!({}));
    if !meta.is_object() { meta = json!({}); }
    let obj = meta.as_object_mut().unwrap();
    obj.insert("payout_included".into(), json!(included));
    obj.remove("payout_recipients");
    let new_meta = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET metadata=?1 WHERE id=?2", rusqlite::params![new_meta, id])
            .map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("metadata".into(), Value::String(new_meta));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_payout_split() -> Result<Vec<Value>, String> {
    // Read the raw setting (not the 3-tuple helper) so the optional `kind` field
    // survives the round-trip. Downstream payout math still only reads name/pct/is_business.
    let conn = pool().get().map_err(|e| e.to_string())?;
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key='profit_split_json'", [], |r| r.get(0)).ok();
    let Some(j) = raw.filter(|s| !s.trim().is_empty()) else { return Ok(Vec::new()); };
    let arr: Vec<Value> = serde_json::from_str(&j).unwrap_or_default();
    Ok(arr.iter().filter_map(|e| {
        let name = e.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let pct = e.get("pct").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let is_business = e.get("is_business").and_then(|x| x.as_bool()).unwrap_or(false);
        if name.is_empty() && !is_business { return None; }
        let name = if is_business && name.is_empty() { "Business".to_string() } else { name };
        let kind = e.get("kind").and_then(|x| x.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| if is_business { "business".into() } else { "person".into() });
        Some(json!({ "name": name, "pct": pct, "is_business": is_business, "kind": kind }))
    }).collect())
}

/// Save the dynamic owner split. Also back-fills the legacy jack/ben/business settings
/// from the first ≤2 people + the business entity, so complete_deal_flow + any legacy
/// reader stays consistent for the common case.
#[tauri::command]
pub async fn save_payout_split(shares: Vec<Value>) -> Result<(), String> {
    let json = serde_json::to_string(&shares).map_err(|e| e.to_string())?;
    let put = |key: &str, val: String| -> Result<(), String> {
        { let conn = pool().get().map_err(|e| e.to_string())?;
          conn.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![key, val]).map_err(|e| e.to_string())?; }
        let mut cols = Map::new();
        cols.insert("value".into(), Value::String(val));
        sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
        Ok(())
    };
    put("profit_split_json", json)?;
    let biz_pct = shares.iter().find(|s| s.get("is_business").and_then(|x| x.as_bool()).unwrap_or(false)).and_then(|s| s.get("pct")).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let non_biz: Vec<&Value> = shares.iter().filter(|s| !s.get("is_business").and_then(|x| x.as_bool()).unwrap_or(false)).collect();
    let share_at = |i: usize| -> (String, f64) {
        non_biz.get(i).map(|s| (s.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(), s.get("pct").and_then(|x| x.as_f64()).unwrap_or(0.0))).unwrap_or((String::new(), 0.0))
    };
    let (jn, jp) = share_at(0);
    let (bn, bp) = share_at(1);
    put("profit_split_jack", jp.to_string())?;
    put("profit_split_ben", bp.to_string())?;
    put("profit_split_business", biz_pct.to_string())?;
    if !jn.is_empty() { put("profit_split_jack_name", jn)?; }
    if !bn.is_empty() { put("profit_split_ben_name", bn)?; }
    Ok(())
}

/// The full pay breakdown for one deal flow (refund-aware): lead rep, cut, dynamic owner
/// splits of the remaining effective net, refunded total, and owed-back.
#[tauri::command]
pub async fn deal_flow_payout(deal_flow_id: String) -> Result<Value, String> {
    let enabled = setting_bool("rep_payouts_enabled");
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (net, gross, refund_owed, payout_included, meta_raw): (f64, f64, f64, bool, Option<String>) = conn.query_row(
        "SELECT COALESCE(net_profit,0), COALESCE(gross_revenue,0), COALESCE(refund_owed,0), COALESCE(json_extract(metadata,'$.payout_included'),0), metadata FROM deal_flows WHERE id=?1",
        [&deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0, r.get(4)?))).map_err(|_| "Deal not found".to_string())?;
    // Resolve the rep: a manual per-deal override (deal_reps) wins; otherwise the
    // deal earns for its CLIENT's assigned rep (client.metadata.lead_representative),
    // matched to an active employee by name. If the client has a rep name that isn't
    // an employee, flag it (rep_unmatched) so the UI can prompt to fix/invite.
    let override_rep: Option<(String, String, f64, String, i64)> = conn.query_row(
        "SELECT dr.lead_rep_id, COALESCE(u.display_name,''), COALESCE(u.commission_pct,0), COALESCE(u.pay_type,'profit_pct'), COALESCE(u.hide_pay_cuts,0)
         FROM deal_reps dr JOIN staff_accounts u ON u.id=dr.lead_rep_id WHERE dr.deal_flow_id=?1",
        [&deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).ok();
    let client_rep_name: Option<String> = conn.query_row(
        "SELECT json_extract(c.metadata,'$.lead_representative') FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id JOIN clients c ON c.id=i.client_id WHERE df.id=?1",
        [&deal_flow_id], |r| r.get::<_, Option<String>>(0)).ok().flatten().filter(|s| !s.trim().is_empty());
    let (rep_id, rep_name, pct, pay_type, hide, rep_unmatched): (Option<String>, String, f64, String, i64, bool) =
        if let Some((id, name, p, pt, h)) = override_rep {
            (Some(id), name, p, pt, h, false)
        } else if let Some(rn) = client_rep_name.clone() {
            match conn.query_row(
                "SELECT id, COALESCE(commission_pct,0), COALESCE(pay_type,'profit_pct'), COALESCE(hide_pay_cuts,0) FROM staff_accounts WHERE display_name=?1 AND status='active' LIMIT 1",
                [&rn], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))) {
                Ok((id, p, pt, h)) => (Some(id), rn, p, pt, h, false),
                Err(_) => (None, rn, 0.0, "profit_pct".into(), 0, true),
            }
        } else {
            (None, String::new(), 0.0, "profit_pct".into(), 0, false)
        };
    let unmatched_name = if rep_unmatched { client_rep_name.clone() } else { None };
    // Refund-aware payout: refunded = non-bank-linked refunds + refund_out
    // allocations paired straight in Financials (the rule_4 formula). The old
    // query read the refunds table only, so a bank-paired refund never reduced the
    // rep cut or owner split. `keep_rep_cut` still reads across all refunds.
    let keep: i64 = conn.query_row(
        "SELECT COALESCE(MAX(keep_rep_cut),0) FROM refunds WHERE deal_flow_id=?1",
        [&deal_flow_id], |r| r.get(0)).unwrap_or(0);
    let refunded: f64 = conn.query_row(
        "SELECT COALESCE((SELECT SUM(amount) FROM refunds WHERE deal_flow_id=?1 AND COALESCE(bank_txn_id,'')=''),0) \
              + COALESCE((SELECT SUM(amount) FROM bank_allocation WHERE deal_flow_id=?1 AND role='refund_out'),0)",
        [&deal_flow_id], |r| r.get(0)).unwrap_or(0.0);
    let eff_net = net - refunded;
    let eff_gross = gross - refunded;
    let has_cut = enabled && rep_id.is_some() && hide == 0;
    let cut = if !has_cut { 0.0 } else if keep != 0 { rep_cut(&pay_type, pct, gross, net) } else { rep_cut_after_refund(&pay_type, pct, eff_gross, eff_net) };
    let remaining = eff_net - cut;
    // Split the remaining net across the shares captured at completion
    // (metadata.payout_recipients) so the deal keeps the split it was agreed
    // under; deals completed before breakdowns existed use the current config.
    let shares = meta_raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .and_then(|o| shares_from_breakdown(&o))
        .unwrap_or_else(read_profit_split_shares_raw);
    let split_amounts = build_payout_breakdown(&shares, remaining, payout_included);
    Ok(json!({
        "rep_payouts_enabled": enabled,
        "lead_rep_id": rep_id, "lead_rep_name": rep_name, "commission_pct": pct, "pay_type": pay_type, "hide_pay_cuts": hide != 0,
        "net_profit": net, "refunded": r2(refunded), "effective_net": r2(eff_net),
        "refund_owed": r2(refund_owed), "owed_remaining": r2((refund_owed - refunded).max(0.0)),
        "keep_rep_cut": keep != 0,
        "rep_unmatched": rep_unmatched,
        "unmatched_rep_name": unmatched_name,
        "rep_cut": if has_cut { r2(cut) } else { 0.0 },
        "remaining_profit": r2(remaining),
        // Honor the deal's payout decision: when payout_included is false the deal
        // was completed 100%-to-business (allocate_payout's net_excl rule); only
        // split by pct when payout was included at completion.
        "splits": split_amounts.iter().map(|s| json!({
            "name": s.get("name").cloned().unwrap_or(Value::Null),
            "amount": r2(s.get("amount").and_then(|a| a.as_f64()).unwrap_or(0.0)),
            "is_business": s.get("is_business").and_then(|b| b.as_bool()).unwrap_or(false),
            "kind": s.get("kind").cloned().unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn list_deal_reps() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, display_name FROM staff_accounts WHERE status='active' ORDER BY display_name").map_err(|e| e.to_string())?;
    let reps: Vec<Value> = stmt.query_map([], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "display_name": r.get::<_, String>(1)? }))).map_err(|e| e.to_string())?.filter_map(|x| x.ok()).collect();
    Ok(reps)
}

#[tauri::command]
pub async fn set_deal_lead_rep(deal_flow_id: String, lead_rep_id: Option<String>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    if let Some(rep) = lead_rep_id {
        let mut cols = Map::new();
        cols.insert("lead_rep_id".into(), Value::String(rep.clone()));
        cols.insert("assigned_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_reps", &deal_flow_id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO deal_reps (deal_flow_id,lead_rep_id,assigned_at) VALUES (?1,?2,?3) ON CONFLICT(deal_flow_id) DO UPDATE SET lead_rep_id=excluded.lead_rep_id, assigned_at=excluded.assigned_at",
            rusqlite::params![deal_flow_id, rep, now]).map_err(|e| e.to_string())?;
    } else {
        sync::record_delete("deal_reps", &deal_flow_id).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM deal_reps WHERE deal_flow_id=?1", [&deal_flow_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn add_client_credit(client_id: String, amount: f64, kind: Option<String>, note: Option<String>, source_deal_flow_id: Option<String>, applied_deal_flow_id: Option<String>) -> Result<String, String> {
    if amount < 0.0 {
        let bal: f64 = { let conn = pool().get().map_err(|e| e.to_string())?; conn.query_row("SELECT COALESCE(SUM(amount),0) FROM client_credits WHERE client_id=?1", [&client_id], |r| r.get(0)).unwrap_or(0.0) };
        if -amount > bal + 0.001 { return Err("Not enough credit balance".into()); }
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let amt = r2(amount);
    let k = match kind.as_deref() { Some("adjustment") => "adjustment", Some("applied") => "applied", _ => if amount < 0.0 { "applied" } else { "issued" } };
    let mut cols = Map::new();
    cols.insert("client_id".into(), Value::String(client_id.clone()));
    cols.insert("amount".into(), json!(amt));
    cols.insert("kind".into(), Value::String(k.into()));
    cols.insert("source_deal_flow_id".into(), to_value(source_deal_flow_id.clone()));
    cols.insert("applied_deal_flow_id".into(), to_value(applied_deal_flow_id.clone()));
    cols.insert("note".into(), to_value(note.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    sync::record_upsert("client_credits", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO client_credits (id,client_id,amount,kind,source_deal_flow_id,applied_deal_flow_id,note,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![id, client_id, amt, k, source_deal_flow_id, applied_deal_flow_id, note, now]).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn get_client_credit(client_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let balance: f64 = conn.query_row("SELECT COALESCE(SUM(amount),0) FROM client_credits WHERE client_id=?1", [&client_id], |r| r.get(0)).unwrap_or(0.0);
    let mut stmt = conn.prepare("SELECT id, amount, kind, COALESCE(note,''), COALESCE(created_at,'') FROM client_credits WHERE client_id=?1 ORDER BY created_at DESC").map_err(|e| e.to_string())?;
    let entries: Vec<Value> = stmt.query_map([&client_id], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "amount": r.get::<_, f64>(1)?, "kind": r.get::<_, String>(2)?, "note": r.get::<_, String>(3)?, "created_at": r.get::<_, String>(4)? }))).map_err(|e| e.to_string())?.filter_map(|x| x.ok()).collect();
    Ok(json!({ "balance": r2(balance), "entries": entries }))
}

#[tauri::command]
pub async fn list_rep_payouts(start: Option<String>, end: Option<String>) -> Result<Value, String> {
    let enabled = setting_bool("rep_payouts_enabled");
    if !enabled { return Ok(json!({ "enabled": false, "payouts": [] })); }
    let start = start.unwrap_or_default();
    let end = end.unwrap_or_else(|| "9999-12-31".into());
    let conn = pool().get().map_err(|e| e.to_string())?;

    // Every active employee shows — $0 until a deal closes for one of their clients.
    let mut staff: std::collections::HashMap<String, (String, f64, String)> = std::collections::HashMap::new(); // id -> (name, pct, pay_type)
    let mut by_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();               // display_name -> id
    {
        let mut s = conn.prepare("SELECT id, display_name, COALESCE(commission_pct,0), COALESCE(pay_type,'profit_pct') FROM staff_accounts WHERE status='active' AND COALESCE(hide_pay_cuts,0)=0").map_err(|e| e.to_string())?;
        let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, String>(3)?))).map_err(|e| e.to_string())?;
        for (id, name, pct, pt) in rows.flatten() {
            by_name.insert(name.clone(), id.clone());
            staff.insert(id, (name, pct, pt));
        }
    }

    // Completed deals in the period: override rep (deal_reps) + the client's rep name + figures.
    let mut totals: std::collections::HashMap<String, (f64, i64, i64)> = std::collections::HashMap::new(); // rep_id -> (owed, deals, refunded_deals)
    {
        let mut s = conn.prepare(
            "SELECT dr.lead_rep_id, json_extract(c.metadata,'$.lead_representative'),
                    COALESCE(df.net_profit,0), COALESCE(df.gross_revenue,0),
                    (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.deal_flow_id=df.id),
                    (SELECT COALESCE(MAX(keep_rep_cut),0) FROM refunds rf WHERE rf.deal_flow_id=df.id)
             FROM deal_flows df
             LEFT JOIN deal_reps dr ON dr.deal_flow_id=df.id
             LEFT JOIN invoices i ON i.id=df.invoice_id
             LEFT JOIN clients c ON c.id=i.client_id
             WHERE df.stage='complete' AND COALESCE(df.completed_at,'') >= ?1 AND COALESCE(df.completed_at,'') < ?2",
        ).map_err(|e| e.to_string())?;
        let rows = s.query_map(rusqlite::params![start, end], |r| Ok((
            r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?,
            r.get::<_, f64>(2)?, r.get::<_, f64>(3)?, r.get::<_, f64>(4)?, r.get::<_, i64>(5)?,
        ))).map_err(|e| e.to_string())?;
        for (override_id, client_rep, net, gross, refunded, keep) in rows.flatten() {
            let rid = override_id.filter(|s| !s.is_empty())
                .or_else(|| client_rep.and_then(|n| if n.trim().is_empty() { None } else { by_name.get(&n).cloned() }));
            let rid = match rid { Some(r) => r, None => continue };
            if let Some((_, pct, pt)) = staff.get(&rid) {
                let cut = if keep != 0 { rep_cut(pt, *pct, gross, net) } else { rep_cut_after_refund(pt, *pct, gross - refunded, net - refunded) };
                let e = totals.entry(rid).or_insert((0.0, 0, 0));
                e.0 += cut; e.1 += 1; if refunded > 0.0 { e.2 += 1; }
            }
        }
    }

    let mut payouts: Vec<Value> = staff.into_iter().map(|(id, (name, _, _))| {
        let (owed, deals, rf) = totals.get(&id).cloned().unwrap_or((0.0, 0, 0));
        json!({ "rep_id": id, "name": name, "owed": r2(owed), "deals": deals, "refunded_deals": rf })
    }).collect();
    payouts.sort_by(|a, b| b["owed"].as_f64().unwrap_or(0.0).partial_cmp(&a["owed"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({ "enabled": true, "start": start, "end": end, "payouts": payouts }))
}

#[tauri::command]
pub async fn mark_rep_payout_paid(rep_id: String, period_start: String, period_end: String, amount: f64) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let amt = r2(amount);
    let mut cols = Map::new();
    cols.insert("rep_id".into(), Value::String(rep_id.clone()));
    cols.insert("period_start".into(), Value::String(period_start.clone()));
    cols.insert("period_end".into(), Value::String(period_end.clone()));
    cols.insert("amount".into(), json!(amt));
    cols.insert("status".into(), Value::String("paid".into()));
    cols.insert("paid_at".into(), Value::String(now.clone()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now.clone()));
    sync::record_upsert("rep_payouts", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO rep_payouts (id,rep_id,period_start,period_end,amount,status,paid_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'paid',?6,?6,?6)",
        rusqlite::params![id, rep_id, period_start, period_end, amt, now]).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn get_rep_payout_settings() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let get = |k: &str, d: &str| conn.query_row("SELECT value FROM settings WHERE key=?1", [k], |r| r.get::<_, String>(0)).unwrap_or_else(|_| d.to_string());
    Ok(json!({
        "enabled": get("rep_payouts_enabled", "0") == "1",
        "period": get("rep_payout_period", "monthly"),
        "anchor": get("rep_payout_anchor", ""),
        "custom_days": get("rep_payout_custom_days", "0").parse::<i64>().unwrap_or(0),
    }))
}

#[tauri::command]
pub async fn set_rep_payout_settings(enabled: Option<bool>, period: Option<String>, anchor: Option<String>, custom_days: Option<i64>) -> Result<(), String> {
    fn put(key: &str, val: String) -> Result<(), String> {
        let mut cols = Map::new();
        cols.insert("value".into(), Value::String(val.clone()));
        sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![key, val]).map_err(|e| e.to_string())?;
        Ok(())
    }
    if let Some(v) = enabled { put("rep_payouts_enabled", if v { "1".into() } else { "0".into() })?; }
    if let Some(v) = period { let v = match v.as_str() { "weekly" | "biweekly" | "monthly" | "custom" => v, _ => "monthly".into() }; put("rep_payout_period", v)?; }
    if let Some(v) = anchor { put("rep_payout_anchor", v)?; }
    if let Some(v) = custom_days { put("rep_payout_custom_days", v.max(1).to_string())?; }
    Ok(())
}

// ──────────────────────── Shopify customer sync ────────────────────────

#[tauri::command]
pub async fn get_shopify_config() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let secret = conn.query_row("SELECT value FROM settings WHERE key='shopify_webhook_secret'", [], |r| r.get::<_, String>(0)).unwrap_or_default();
    Ok(json!({
        "configured": !secret.trim().is_empty(),
        "webhook_url": "https://ecliptr.app/api/integrations/shopify/customers?org=org_default",
    }))
}

#[tauri::command]
pub async fn set_shopify_secret(secret: String) -> Result<(), String> {
    let s = secret.trim().to_string();
    // Device-local only — the Shopify webhook secret must NEVER enter the sync
    // oplog (it would ship in plaintext to every device). It travels via the
    // authed org-secret bridge (share_connections_with_team) instead.
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params!["shopify_webhook_secret", s]).map_err(|e| e.to_string())?;
    Ok(())
}

// ──────────────────────── Inbound intake sources (custom forms/sites) ────────────────────────

#[tauri::command]
pub async fn create_intake_source(name: String) -> Result<Value, String> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().simple().to_string();
    let nm = if name.trim().is_empty() { "Web form".to_string() } else { name.trim().to_string() };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO intake_sources (id,org_id,name,kind,token,mapping_json,sample_json,created_at,updated_at)
             VALUES (?1,'org_default',?2,'website',?3,'{}','{}',?4,?4)",
            rusqlite::params![id, nm, token, now],
        ).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("org_id".into(), Value::String("org_default".into()));
    cols.insert("name".into(), Value::String(nm.clone()));
    cols.insert("kind".into(), Value::String("website".into()));
    cols.insert("token".into(), Value::String(token.clone()));
    cols.insert("mapping_json".into(), Value::String("{}".into()));
    cols.insert("sample_json".into(), Value::String("{}".into()));
    cols.insert("created_at".into(), Value::String(now.clone()));
    cols.insert("updated_at".into(), Value::String(now));
    sync::record_upsert("intake_sources", &id, cols).map_err(|e| e.to_string())?;
    Ok(json!({ "id": id, "name": nm, "token": token, "url": format!("https://ecliptr.app/api/intake/{}", token) }))
}

#[tauri::command]
pub async fn list_intake_sources() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, name, kind, token, COALESCE(mapping_json,'{}'), COALESCE(sample_json,'{}'), created_at
         FROM intake_sources WHERE COALESCE(kind,'')!='deleted' ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let token: String = r.get(3)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "kind": r.get::<_, String>(2)?,
            "token": token.clone(),
            "url": format!("https://ecliptr.app/api/intake/{}", token),
            "mapping_json": r.get::<_, String>(4)?,
            "sample_json": r.get::<_, String>(5)?,
            "created_at": r.get::<_, String>(6)?,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// One call for the Automation dashboard: follow-up rule counts, signup rule
/// counts, and every intake source with how many pending clients it captured.
/// Identical shape to the server `GET /api/automations/summary`. All data is
/// local (intake_sources sync down; follow-up + signup rules are desktop-local).
#[tauri::command]
pub async fn automations_summary() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    // Follow-up rules (column `is_active`).
    let fu_total: i64 = conn.query_row("SELECT COUNT(*) FROM followup_rules", [], |r| r.get(0)).unwrap_or(0);
    let fu_active: i64 = conn.query_row("SELECT COUNT(*) FROM followup_rules WHERE is_active=1", [], |r| r.get(0)).unwrap_or(0);

    // Signup rules (column `active`).
    let su_total: i64 = conn.query_row("SELECT COUNT(*) FROM signup_rules", [], |r| r.get(0)).unwrap_or(0);
    let su_active: i64 = conn.query_row("SELECT COUNT(*) FROM signup_rules WHERE active=1", [], |r| r.get(0)).unwrap_or(0);

    // Intake sources + pending clients captured per source.
    let mut sources: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, COALESCE(kind,'website'), token FROM intake_sources \
             WHERE COALESCE(kind,'')!='deleted' ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
        ))).map_err(|e| e.to_string())?;
        for row in rows.filter_map(|x| x.ok()) {
            let (id, name, kind, token) = row;
            let captured: i64 = conn.query_row(
                "SELECT COUNT(*) FROM clients WHERE approval_status='pending' \
                   AND json_extract(metadata,'$.intake_source_id')=?1",
                [&id], |r| r.get(0),
            ).unwrap_or(0);
            sources.push(json!({
                "id": id, "name": name, "token": token, "kind": kind,
                "captured_count": captured,
                "url": format!("https://ecliptr.app/api/intake/{}", token),
            }));
        }
    }

    Ok(json!({
        "followup_rules": { "total": fu_total, "active": fu_active },
        "signup_rules": { "total": su_total, "active": su_active },
        "intake_sources": sources,
        "intake_base_url": "https://ecliptr.app/api/intake/",
    }))
}

#[tauri::command]
pub async fn save_intake_mapping(id: String, mapping_json: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE intake_sources SET mapping_json=?1, updated_at=?2 WHERE id=?3", rusqlite::params![mapping_json, now, id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("mapping_json".into(), Value::String(mapping_json));
    cols.insert("updated_at".into(), Value::String(now));
    sync::record_upsert("intake_sources", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_intake_source(id: String) -> Result<(), String> {
    // Soft-delete: clears the token (kills the public URL) and hides it locally.
    let now = Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE intake_sources SET kind='deleted', token='', updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("kind".into(), Value::String("deleted".into()));
    cols.insert("token".into(), Value::String("".into()));
    cols.insert("updated_at".into(), Value::String(now));
    sync::record_upsert("intake_sources", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

/// The canonical fields any incoming form field can map to: built-ins + the org's custom fields.
#[tauri::command]
pub async fn get_intake_fields() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut out = vec![
        json!({"value":"name","label":"Full name"}),
        json!({"value":"first_name","label":"First name"}),
        json!({"value":"last_name","label":"Last name"}),
        json!({"value":"email","label":"Email"}),
        json!({"value":"phone","label":"Phone"}),
        json!({"value":"company","label":"Company"}),
        json!({"value":"category","label":"Category"}),
        json!({"value":"notes","label":"Notes"}),
    ];
    if let Ok(mut stmt) = conn.prepare("SELECT field_key, label FROM custom_fields ORDER BY sort_order, label") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (key, label) in rows.filter_map(|r| r.ok()) {
                out.push(json!({"value": format!("cf:{}", key), "label": label}));
            }
        }
    }
    out.push(json!({"value":"ignore","label":"(ignore this field)"}));
    Ok(out)
}

#[tauri::command]
pub async fn delete_deal_flow(id: String) -> Result<(), String> {
    // Soft-delete (archive) — reversible + sync-safe. The deal_flow↔invoice link is
    // intentionally LEFT INTACT so restore is lossless (list_deal_flows filters out
    // archived rows, so the deal leaves the active pipeline regardless).
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("archived".into(), Value::from(1));
    cols.insert("archived_at".into(), Value::String(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET archived=1, archived_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark a deal flow as "fell through" (or reverse it) by voiding/unvoiding its
/// invoice. Since `list_deal_flows` hides deal flows whose invoice is voided, this
/// removes the deal from the active pipeline. Reversible — the deal_flow and its
/// invoice link are untouched, so clearing it restores everything.
#[tauri::command]
pub async fn set_deal_flow_fell_through(deal_flow_id: String, fell_through: bool) -> Result<(), String> {
    let invoice_id: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT invoice_id FROM deal_flows WHERE id=?1", [&deal_flow_id], |r| r.get(0)).ok().flatten()
    };
    let invoice_id = invoice_id.filter(|s| !s.is_empty())
        .ok_or_else(|| "This deal flow has no linked invoice to mark.".to_string())?;
    // Reuse the existing void logic (syncs + excludes from AR/dashboard/pipeline).
    set_invoice_void(invoice_id, fell_through).await
}

// ============================================================
//  Archive (soft-deleted + fell-through) list + restore
// ============================================================

/// One row in the Archive view: a soft-deleted invoice/deal/deal_flow ("deleted")
/// or a fell-through invoice / its deal_flow ("fell_through").
#[derive(Serialize, Debug, Clone)]
pub struct ArchiveItem {
    /// "invoice" | "deal" | "deal_flow"
    pub kind: String,
    pub id: String,
    /// Invoice number / deal name.
    pub title: String,
    pub client_name: Option<String>,
    pub amount: f64,
    /// "deleted" | "fell_through"
    pub reason: String,
    pub archived_at: Option<String>,
}

/// Everything currently hidden from active views: archived (soft-deleted)
/// invoices/deals/deal_flows, voided (fell-through) invoices, and deal flows whose
/// invoice was voided. Newest first.
#[tauri::command]
pub async fn list_archive() -> Result<Vec<ArchiveItem>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = "
        SELECT 'invoice' AS kind, i.id, i.number AS title, c.name AS client_name, i.total AS amount,
               'deleted' AS reason, i.archived_at AS at, i.archived_at AS sort_ts
        FROM invoices i LEFT JOIN clients c ON c.id=i.client_id
        WHERE COALESCE(i.archived,0)=1
        UNION ALL
        SELECT 'invoice', i.id, i.number, c.name, i.total, 'fell_through',
               NULL, COALESCE(i.archived_at, i.sent_at, i.issue_date)
        FROM invoices i LEFT JOIN clients c ON c.id=i.client_id
        WHERE COALESCE(i.voided,0)=1 AND COALESCE(i.archived,0)=0
        UNION ALL
        SELECT 'deal', d.id, d.title, c.name, COALESCE(d.asking_price,0), 'deleted', d.archived_at, d.archived_at
        FROM deals d LEFT JOIN clients c ON c.id=d.client_id
        WHERE COALESCE(d.archived,0)=1
        UNION ALL
        SELECT 'deal_flow', df.id, COALESCE(NULLIF(df.name,''), i.number, 'Deal flow'), c.name,
               COALESCE(i.total, df.gross_revenue, 0), 'deleted', df.archived_at, df.archived_at
        FROM deal_flows df LEFT JOIN invoices i ON i.id=df.invoice_id LEFT JOIN clients c ON c.id=i.client_id
        WHERE COALESCE(df.archived,0)=1
        UNION ALL
        SELECT 'deal_flow', df.id, COALESCE(NULLIF(df.name,''), i.number, 'Deal flow'), c.name,
               COALESCE(i.total, df.gross_revenue, 0), 'fell_through', NULL, COALESCE(df.archived_at, df.updated_at)
        FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id LEFT JOIN clients c ON c.id=i.client_id
        WHERE COALESCE(i.voided,0)=1 AND COALESCE(df.archived,0)=0
    ";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut items: Vec<(String, ArchiveItem)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(7)?.unwrap_or_default(), // sort_ts
                ArchiveItem {
                    kind: r.get(0)?,
                    id: r.get(1)?,
                    title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    client_name: r.get(3)?,
                    amount: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                    reason: r.get(5)?,
                    archived_at: r.get(6)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    // Newest first by the resolved sort timestamp.
    items.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(items.into_iter().map(|(_, it)| it).collect())
}

/// Restore an archived/fell-through item to active. For a soft-deleted item, clear
/// `archived`; for a fell-through invoice, clear `voided`. Synced.
/// Columns of a live table as a set — to intersect with an older backup's schema.
fn live_table_columns(conn: &rusqlite::Connection, table: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    if let Ok(mut s) = conn.prepare(&format!("PRAGMA table_info({})", table)) {
        if let Ok(rows) = s.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.filter_map(|r| r.ok()) { out.insert(c); }
        }
    }
    out
}

fn rq_value_to_json(v: &rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as V;
    match v {
        V::Null => Value::Null,
        V::Integer(i) => json!(i),
        V::Real(f) => json!(f),
        V::Text(t) => json!(t),
        V::Blob(_) => Value::Null,
    }
}

/// Recover deals + invoices that exist in the local daily backups but were deleted
/// from the live database, restoring them ARCHIVED so they land in the Archive.
/// SAFETY: purely additive — only IDs NOT already present are inserted (INSERT OR
/// IGNORE never overwrites an existing row), and each is re-registered through
/// record_upsert with a fresh HLC so the original delete can't win it back on the
/// next sync. Existing data is never modified. Returns the count restored per table.
#[tauri::command]
pub async fn recover_deleted_from_backups() -> Result<Value, String> {
    let dir = backup_dir_setting()?;
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str())
            .map(|n| n.starts_with("clienthub-backup-") && n.ends_with(".db")).unwrap_or(false))
        .collect();
    files.sort();
    files.reverse(); // newest first (filename sorts by date), so we keep the latest version
    if files.is_empty() { return Err("No backup files were found in your backups folder.".into()); }

    let now = Utc::now().to_rfc3339();
    let mut out = Map::new();

    for table in ["deal_flows", "invoices"] {
        let live_cols = { let conn = pool().get().map_err(|e| e.to_string())?; live_table_columns(&conn, table) };
        let current: std::collections::HashSet<String> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let mut s = conn.prepare(&format!("SELECT id FROM {}", table)).map_err(|e| e.to_string())?;
            let rows = s.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut restored: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut count = 0i64;

        for f in &files {
            let bconn = match rusqlite::Connection::open_with_flags(
                f, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ) { Ok(c) => c, Err(_) => continue };
            // Columns in BOTH the backup and the live table, and safe as identifiers.
            let cols: Vec<String> = {
                let mut v = Vec::new();
                if let Ok(mut s) = bconn.prepare(&format!("PRAGMA table_info({})", table)) {
                    if let Ok(rows) = s.query_map([], |r| r.get::<_, String>(1)) {
                        for c in rows.filter_map(|r| r.ok()) {
                            let safe = !c.is_empty() && !c.as_bytes()[0].is_ascii_digit()
                                && c.bytes().all(|b| b == b'_' || b.is_ascii_alphanumeric());
                            if safe && live_cols.contains(&c) { v.push(c); }
                        }
                    }
                }
                v
            };
            let id_idx = match cols.iter().position(|c| c == "id") { Some(i) => i, None => continue };
            let sel = cols.join(",");
            let mut s = match bconn.prepare(&format!("SELECT {} FROM {}", sel, table)) { Ok(s) => s, Err(_) => continue };
            let mut rows = match s.query([]) { Ok(r) => r, Err(_) => continue };
            while let Ok(Some(row)) = rows.next() {
                let id: String = match row.get(id_idx) { Ok(v) => v, Err(_) => continue };
                if id.is_empty() || current.contains(&id) || restored.contains(&id) { continue; }
                let mut vals: Vec<rusqlite::types::Value> = Vec::with_capacity(cols.len());
                let mut colmap = Map::new();
                let mut ok = true;
                for (i, c) in cols.iter().enumerate() {
                    match row.get::<_, rusqlite::types::Value>(i) {
                        Ok(v) => { if c != "id" { colmap.insert(c.clone(), rq_value_to_json(&v)); } vals.push(v); }
                        Err(_) => { ok = false; break; }
                    }
                }
                if !ok { continue; }
                // Force archived=1 (+ archived_at) directly into the INSERT column set
                // so a restored row always lands in the Archive — never in the active
                // lists — even if a separate follow-up update were to be skipped.
                let mut ins_cols = cols.clone();
                if let Some(i) = ins_cols.iter().position(|c| c == "archived") {
                    vals[i] = rusqlite::types::Value::Integer(1);
                } else if live_cols.contains("archived") {
                    ins_cols.push("archived".to_string());
                    vals.push(rusqlite::types::Value::Integer(1));
                }
                if live_cols.contains("archived_at") {
                    if let Some(i) = ins_cols.iter().position(|c| c == "archived_at") {
                        vals[i] = rusqlite::types::Value::Text(now.clone());
                    } else {
                        ins_cols.push("archived_at".to_string());
                        vals.push(rusqlite::types::Value::Text(now.clone()));
                    }
                }
                let insert_sel = ins_cols.join(",");
                let conn = pool().get().map_err(|e| e.to_string())?;
                let ph: Vec<String> = (1..=vals.len()).map(|i| format!("?{}", i)).collect();
                let ins = format!("INSERT OR IGNORE INTO {} ({}) VALUES ({})", table, insert_sel, ph.join(","));
                if conn.execute(&ins, rusqlite::params_from_iter(vals.iter())).unwrap_or(0) > 0 {
                    colmap.insert("archived".into(), json!(1));
                    if live_cols.contains("archived_at") { colmap.insert("archived_at".into(), json!(now)); }
                    let _ = sync::record_upsert(table, &id, colmap);
                    restored.insert(id.clone());
                    count += 1;
                }
            }
        }
        out.insert(table.to_string(), json!(count));
    }
    Ok(Value::Object(out))
}

#[tauri::command]
pub async fn restore_archived(kind: String, id: String) -> Result<(), String> {
    let table = match kind.as_str() {
        "invoice" => "invoices",
        "deal" => "deals",
        "deal_flow" => "deal_flows",
        _ => return Err("Unknown archive kind.".into()),
    };
    let conn = pool().get().map_err(|e| e.to_string())?;
    // Is this row archived (deleted) or just voided (fell_through)?
    let archived: i64 = conn
        .query_row(&format!("SELECT COALESCE(archived,0) FROM {} WHERE id=?1", table), [&id], |r| r.get(0))
        .map_err(|_| "Item not found.".to_string())?;
    drop(conn);

    if archived == 1 {
        // Un-archive.
        let mut cols = Map::new();
        cols.insert("archived".into(), Value::from(0));
        cols.insert("archived_at".into(), Value::Null);
        sync::record_upsert(table, &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(&format!("UPDATE {} SET archived=0, archived_at=NULL WHERE id=?1", table), [&id])
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        // Fell-through: clear the void on the invoice. For a deal_flow, resolve its
        // invoice first (voiding the invoice is what hid the deal).
        let invoice_id = if kind == "deal_flow" {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.query_row("SELECT invoice_id FROM deal_flows WHERE id=?1", [&id], |r| r.get::<_, Option<String>>(0))
                .ok().flatten().filter(|s| !s.is_empty())
                .ok_or_else(|| "No linked invoice to restore.".to_string())?
        } else {
            id.clone()
        };
        set_invoice_void(invoice_id, false).await
    }
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
             FROM deal_flows df
                  JOIN invoices i ON i.id = df.invoice_id,
                  json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             WHERE df.stage='complete' AND json_extract(sp.value, '$.supplier_id') IS NOT NULL
               AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 AND COALESCE(df.archived,0)=0
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
             FROM deal_flows df
                  JOIN invoices i ON i.id = df.invoice_id,
                  json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             WHERE df.stage='complete' AND json_extract(sp.value, '$.supplier_id') IS NOT NULL
               AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 AND COALESCE(df.archived,0)=0
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
    // Delete locally FIRST; only broadcast the sync delete if it actually succeeded.
    // If we recorded the delete first and the DELETE were FK-blocked, a phantom
    // delete would propagate to other devices even though the row still exists here
    // (mirrors delete_client's deliberate ordering).
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM suppliers WHERE id=?1", [&id]).map_err(|e| {
        if e.to_string().contains("FOREIGN KEY") {
            "Cannot delete: this supplier is referenced by deals. Remove or reassign them first.".to_string()
        } else {
            e.to_string()
        }
    })?;
    sync::record_delete("suppliers", &id).map_err(|e| e.to_string())?;
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
    // Sync the full row so price history propagates with its parent supplier.
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!("org_default"));
    cols.insert("supplier_id".into(), json!(supplier_id));
    cols.insert("item_description".into(), json!(item_description));
    cols.insert("price".into(), json!(price));
    cols.insert("quantity".into(), json!(quantity));
    cols.insert("recorded_at".into(), json!(now));
    cols.insert("deal_flow_id".into(), json!(deal_flow_id));
    cols.insert("notes".into(), json!(notes));
    sync::record_upsert("supplier_price_history", &id, cols).map_err(|e| e.to_string())?;
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
        jack_name: get("profit_split_jack_name", "Partner 1"),
        ben_name: get("profit_split_ben_name", "Partner 2"),
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

/// Shared helper: persist a single setting locally and emit a sync event so it
/// propagates to the server. Mirrors the upsert pattern in save_profit_split.
fn write_setting(key: &str, val: &str) -> Result<(), String> {
    let mut cols = Map::new();
    cols.insert("key".into(), Value::String(key.to_string()));
    cols.insert("value".into(), Value::String(val.to_string()));
    sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, val],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_setting(key: &str) -> Option<String> {
    let conn = pool().get().ok()?;
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0)).ok()
}

#[tauri::command]
pub async fn get_brief_frequency() -> Result<i64, String> {
    Ok(read_setting("brief_frequency_days").and_then(|v| v.parse::<i64>().ok()).unwrap_or(7))
}

#[tauri::command]
pub async fn set_brief_frequency(days: i64) -> Result<(), String> {
    if days < 1 { return Err("Frequency must be at least 1 day".into()); }
    write_setting("brief_frequency_days", &days.to_string())
}

#[tauri::command]
pub async fn get_organization_name() -> Result<String, String> {
    // Prefer the explicit org-name setting; fall back to the onboarding company name
    // (stored as JSON under the `company_info` setting key).
    if let Some(n) = read_setting("organization_name") {
        if !n.trim().is_empty() { return Ok(n); }
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let name: String = conn.query_row(
        "SELECT COALESCE(json_extract(value, '$.name'), '') FROM settings WHERE key='company_info'",
        [], |r| r.get(0),
    ).unwrap_or_default();
    Ok(name)
}

#[tauri::command]
pub async fn set_organization_name(name: String) -> Result<(), String> {
    write_setting("organization_name", name.trim())
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
pub async fn get_email_inboxes() -> Result<Vec<crate::email::EmailInbox>, String> {
    Ok(crate::email::load_inboxes())
}

/// Add or update a monitor-only inbound mailbox (password stored in the keyring).
///
/// `scope` = `"org"` (default) writes a shared inbox that syncs to — and is watched
/// by — every admin/device in the org; `"me"` writes a personal inbox that stays
/// on this device only. Adding an org inbox is an admin action.
#[tauri::command]
pub async fn save_email_inbox(id: Option<String>, label: String, host: String, port: u16, user: String, password: Option<String>, scope: Option<String>) -> Result<String, String> {
    let scope = match scope.as_deref() { Some("me") => "me", _ => "org" };
    if scope == "org" && !crate::employees::session_is_privileged() {
        return Err("Admin permission required to set up the shared inbox.".into());
    }
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let inbox = crate::email::EmailInbox { id: id.clone(), label, host, port, user, scope: scope.into(), demo: false };
    // Edit the list that matches the target scope so org/personal stay separate.
    let mut list = if scope == "me" { crate::email::load_personal_inboxes() } else { crate::email::load_org_inboxes() };
    match list.iter_mut().find(|i| i.id == id) {
        Some(existing) => *existing = inbox,
        None => list.push(inbox),
    }
    if scope == "me" {
        crate::email::save_personal_inboxes(&list).map_err(|e| e.to_string())?;
    } else {
        crate::email::save_inboxes(&list).map_err(|e| e.to_string())?;
    }
    if let Some(pw) = password {
        if !pw.is_empty() {
            crate::email::save_cred(&format!("imap_pass_{id}"), &pw).map_err(|e| e.to_string())?;
            // Share the org inbox's password to the server so sibling admins can
            // materialize it (personal inboxes keep the secret on this device).
            if scope == "org" {
                let _ = crate::netsync::push_inbox_secret_to_server(&id, &pw).await;
            }
        }
    }
    Ok(id)
}

#[tauri::command]
pub async fn delete_email_inbox(id: String) -> Result<(), String> {
    // Remove from whichever scoped list holds it. Deleting a shared (org) inbox is
    // an admin action; personal inboxes anyone can remove from their own device.
    let in_org = crate::email::load_org_inboxes().iter().any(|i| i.id == id);
    if in_org && !crate::employees::session_is_privileged() {
        return Err("Admin permission required to remove the shared inbox.".into());
    }
    if in_org {
        let mut list = crate::email::load_org_inboxes();
        list.retain(|i| i.id != id);
        crate::email::save_inboxes(&list).map_err(|e| e.to_string())?;
    } else {
        let mut list = crate::email::load_personal_inboxes();
        list.retain(|i| i.id != id);
        crate::email::save_personal_inboxes(&list).map_err(|e| e.to_string())?;
    }
    let _ = crate::email::delete_cred(&format!("imap_pass_{id}"));
    Ok(())
}

/// Whether this device is using the org default send config (true) or a personal
/// override (false). Drives the "Use my own inbox" toggle in Settings.
#[tauri::command]
pub async fn get_email_use_org_default() -> Result<bool, String> {
    Ok(crate::email::use_org_default())
}

/// Toggle this device between the org default and a personal send override.
/// Device-local — never synced, so one admin flipping to "my own" doesn't affect
/// anyone else.
#[tauri::command]
pub async fn set_email_use_org_default(on: bool) -> Result<(), String> {
    crate::email::set_use_org_default(on).map_err(|e| e.to_string())
}

/// Transfer the org's shared inbox to a different email admin: rewrite the
/// `owner_staff_id` on the org send config (and every org monitor inbox) to the
/// target staff member and re-sync. Admin-gated. Credentials are unchanged, so the
/// target admin's device materializes them via the server round-trip on next scan —
/// no password re-entry needed unless the underlying mailbox itself changes.
#[tauri::command]
pub async fn transfer_org_inbox(target_staff_id: String) -> Result<(), String> {
    if !crate::employees::session_is_privileged() {
        return Err("Admin permission required to transfer the shared inbox.".into());
    }
    if target_staff_id.trim().is_empty() {
        return Err("Pick an admin to transfer to.".into());
    }
    // Reassign the send/monitor account owner.
    let mut settings = crate::email::load_org_settings()
        .ok_or_else(|| "No shared inbox is set up yet.".to_string())?;
    settings.owner_staff_id = target_staff_id.clone();
    crate::email::save_settings(&settings).map_err(|e| e.to_string())?;
    // Make sure the shared secrets are on the server so the new owner's device can
    // pull them without re-typing.
    let _ = crate::netsync::push_email_secrets_to_server().await;
    Ok(())
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
    crate::oauth_flow::start_consent_flow(app_handle, client_id, client_secret, "https://mail.google.com/ https://www.googleapis.com/auth/spreadsheets", "oauth")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn google_contacts_oauth_start(
    app_handle: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    crate::oauth_flow::start_consent_flow(app_handle, client_id, client_secret, "https://www.googleapis.com/auth/contacts.readonly", "gcontacts")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn google_contacts_list() -> Result<Vec<crate::google_contacts::GoogleContact>, String> {
    let client_id = crate::email::cred("gcontacts_client_id").map_err(|e| format!("Not connected: {}", e))?;
    let client_secret = crate::email::cred("gcontacts_client_secret").map_err(|e| format!("Not connected: {}", e))?;
    let refresh_token = crate::email::cred("gcontacts_refresh_token").map_err(|e| format!("Not connected: {}", e))?;
    let access_token = crate::google_contacts::refresh_access_token(&client_id, &client_secret, &refresh_token)
        .await
        .map_err(|e| format!("Token refresh: {}", e))?;
    crate::google_contacts::list_contacts(&access_token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn google_contacts_import(
    contacts: Vec<crate::google_contacts::GoogleContact>,
) -> Result<crate::csv_import::ImportSummary, String> {
    use crate::csv_import::ImportSummary;
    let mut summary = ImportSummary { imported: 0, skipped: 0, errors: Vec::new() };

    let mut existing = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT LOWER(email), LOWER(name) FROM clients").map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_,Option<String>>(0)?, r.get::<_,Option<String>>(1)?))) {
            for r in rows.filter_map(|r| r.ok()) {
                if let Some(ref email) = r.0 { map.insert(email.to_lowercase(), true); }
                if let Some(ref name) = r.1 { map.insert(name.to_lowercase(), true); }
            }
        }
        map
    };

    for c in &contacts {
        let email_lower = c.email.as_ref().map(|e| e.to_lowercase());
        let name_lower = c.name.as_ref().map(|n| n.to_lowercase());

        if email_lower.as_ref().map_or(false, |e| existing.contains_key(e)) ||
           name_lower.as_ref().map_or(false, |n| existing.contains_key(n)) {
            summary.skipped += 1;
            continue;
        }

        let cid = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        let mut meta = serde_json::json!({});
        if let Some(ref s) = c.street_address { meta["street_address"] = serde_json::Value::String(s.clone()); }
        if let Some(ref s) = c.city { meta["city"] = serde_json::Value::String(s.clone()); }
        if let Some(ref s) = c.state { meta["state"] = serde_json::Value::String(s.clone()); }
        if let Some(ref s) = c.zip_code { meta["zip_code"] = serde_json::Value::String(s.clone()); }
        let meta_str = serde_json::to_string(&meta).unwrap_or_default();

        let mut cols = serde_json::Map::new();
        cols.insert("name".into(), serde_json::Value::String(c.name.clone().unwrap_or_default()));
        cols.insert("email".into(), serde_json::Value::String(c.email.clone().unwrap_or_default()));
        cols.insert("phone".into(), serde_json::Value::String(c.phone.clone().unwrap_or_default()));
        cols.insert("company".into(), serde_json::Value::String(c.organization.clone().unwrap_or_default()));
        cols.insert("metadata".into(), serde_json::Value::String(meta_str.clone()));
        cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
        cols.insert("updated_at".into(), serde_json::Value::String(now.clone()));
        if let Err(e) = sync::record_upsert("clients", &cid, cols.clone()) {
            summary.errors.push(format!("{}: sync failed: {}", c.name.as_deref().unwrap_or("unknown"), e));
            continue;
        }

        let conn = pool().get().map_err(|e| e.to_string())?;
        if let Err(e) = conn.execute(
            "INSERT INTO clients (id, name, email, phone, company, metadata, lead_status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,'prospect',?7,?7)",
            rusqlite::params![cid, c.name.as_deref().unwrap_or(""), c.email.as_deref().unwrap_or(""), c.phone.as_deref().unwrap_or(""), c.organization.as_deref().unwrap_or(""), meta_str, now],
        ) {
            summary.errors.push(format!("{}: insert failed: {}", c.name.as_deref().unwrap_or("unknown"), e));
            continue;
        }

        if let Some(ref e) = c.email { existing.insert(e.to_lowercase(), true); }
        if let Some(ref n) = c.name { existing.insert(n.to_lowercase(), true); }
        summary.imported += 1;
    }

    Ok(summary)
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

/// Paste-to-load: parse a supplier load message (+ optional image) into structured
/// lot fields. `image_base64` is the raw base64 (no data: prefix).
#[tauri::command]
pub async fn parse_load(text: String, image_base64: Option<String>, image_media_type: Option<String>) -> Result<Value, String> {
    crate::ai::parse_load(&text, image_base64.as_deref(), image_media_type.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Parse a pasted blob (often several WhatsApp messages) into a LIST of lots.
/// Free + deterministic: calls the hosted rule-based parser (no AI, no API key).
#[tauri::command]
pub async fn parse_loads(text: String, image_base64: Option<String>, _image_media_type: Option<String>) -> Result<Vec<Value>, String> {
    if text.trim().is_empty() {
        return Err(if image_base64.is_some() {
            "Paste the message text — the free parser reads text, not screenshots.".into()
        } else {
            "Paste one or more load messages first.".into()
        });
    }
    let base = crate::netsync::config()
        .map(|c| c.url.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://ecliptr.app".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build().map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{base}/api/tools/parse-loads"))
        .json(&serde_json::json!({ "text": text }))
        .send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Parser service returned {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("loads").and_then(|l| l.as_array()).cloned().unwrap_or_default())
}

/// Whether an Anthropic API key is configured (never returns the key itself).
#[tauri::command]
pub async fn load_ai_status() -> Result<bool, String> {
    Ok(crate::ai::has_load_ai_key())
}

/// Save (or clear, when empty) the Anthropic API key. Device-local, never synced.
#[tauri::command]
pub async fn set_anthropic_key(key: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let k = key.trim();
    if k.is_empty() {
        conn.execute("DELETE FROM settings WHERE key='anthropic_api_key'", []).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('anthropic_api_key', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [k],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- Public storefront config (synced settings, read by the server) ----------

#[derive(Serialize)]
pub struct StorefrontConfig {
    pub enabled: bool,
    pub token: String,
    pub url: Option<String>,
    pub show_prices: bool,
    pub show_logo: bool,
    pub title: String,
    pub subtitle: String,
    pub contact_wa: String,
    pub contact_email: String,
    pub accent: String,
    pub bg: String,
}

fn sf_get(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
fn sf_bool(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    match sf_get(conn, key) { Some(v) => v == "1" || v.eq_ignore_ascii_case("true"), None => default }
}

#[tauri::command]
pub async fn get_storefront_config() -> Result<StorefrontConfig, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let token = sf_get(&conn, "storefront_token").unwrap_or_default();
    Ok(StorefrontConfig {
        enabled: sf_bool(&conn, "storefront_enabled", false),
        url: if token.is_empty() { None } else { Some(format!("https://ecliptr.app/i/{}", token)) },
        token,
        show_prices: sf_bool(&conn, "storefront_show_prices", false),
        show_logo: sf_bool(&conn, "storefront_show_logo", true),
        title: sf_get(&conn, "storefront_title").unwrap_or_default(),
        subtitle: sf_get(&conn, "storefront_subtitle").unwrap_or_default(),
        contact_wa: sf_get(&conn, "storefront_contact_wa").unwrap_or_default(),
        contact_email: sf_get(&conn, "storefront_contact_email").unwrap_or_default(),
        accent: sf_get(&conn, "storefront_accent").unwrap_or_else(|| "#FF6520".into()),
        bg: sf_get(&conn, "storefront_bg").unwrap_or_else(|| "charcoal".into()),
    })
}

/// Save storefront config (synced so the server serves it). Mints a stable public
/// token the first time it's enabled.
#[tauri::command]
pub async fn save_storefront_config(enabled: bool, show_prices: bool, show_logo: bool, title: String, subtitle: String, contact_wa: String, contact_email: String, accent: Option<String>, bg: Option<String>) -> Result<StorefrontConfig, String> {
    write_setting("storefront_enabled", if enabled { "1" } else { "0" })?;
    write_setting("storefront_show_prices", if show_prices { "1" } else { "0" })?;
    write_setting("storefront_show_logo", if show_logo { "1" } else { "0" })?;
    write_setting("storefront_title", title.trim())?;
    write_setting("storefront_subtitle", subtitle.trim())?;
    write_setting("storefront_contact_wa", contact_wa.trim())?;
    write_setting("storefront_contact_email", contact_email.trim())?;
    write_setting("storefront_accent", accent.as_deref().unwrap_or("#FF6520").trim())?;
    write_setting("storefront_bg", bg.as_deref().unwrap_or("charcoal").trim())?;
    let has_token = { let conn = pool().get().map_err(|e| e.to_string())?; sf_get(&conn, "storefront_token").is_some() };
    if enabled && !has_token {
        let token: String = Uuid::new_v4().to_string().replace('-', "").chars().take(16).collect();
        write_setting("storefront_token", &token)?;
    }
    get_storefront_config().await
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

/// Save the send/monitor account. `scope` = `"org"` (default) writes the shared
/// org config that all admins inherit (admin action, synced) and shares its
/// secrets to the server; `"me"` writes a personal override for this device only.
#[tauri::command]
pub async fn save_email_settings(settings: crate::email::EmailSettings, scope: Option<String>) -> Result<(), String> {
    let scope = match scope.as_deref() { Some("me") => "me", _ => "org" };
    if scope == "org" && !crate::employees::session_is_privileged() {
        return Err("Admin permission required to set up the shared send account.".into());
    }
    let mut settings = settings;
    if scope == "org" {
        // Stamp the current admin as the owner if none is set yet, so the shared
        // inbox always has an accountable owner after first setup.
        if settings.owner_staff_id.trim().is_empty() {
            if let Some((id, _)) = crate::employees::session_actor() {
                settings.owner_staff_id = id;
            }
        }
    }
    crate::email::save_settings_scoped(scope, &settings).map_err(|e| e.to_string())?;
    if scope == "org" {
        // Share the send/monitor secrets so sibling admins can materialize them.
        let _ = crate::netsync::push_email_secrets_to_server().await;
    }
    Ok(())
}

/// Send a real test email to the configured account — verifies outbound email works
/// end-to-end (connection + auth + delivery). Returns the address it sent to.
#[tauri::command]
pub async fn send_test_email() -> Result<String, String> {
    let settings = crate::email::load_settings().map_err(|e| format!("No email configured: {}", e))?;
    let to = settings.user.clone();
    crate::email::send(
        &to,
        "Ecliptr test email",
        "This is a test from Ecliptr. If you're reading this, your outbound email is connected and working correctly.",
        None,
    ).await.map_err(|e| format!("Send failed: {}", e))?;
    Ok(to)
}

/// Map a low-level SMTP/IMAP error into a short, user-facing message. Keeps the
/// test commands' `message` field human-readable regardless of the crate error.
fn friendly_conn_error(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("auth") || e.contains("username and password") || e.contains("credential")
        || e.contains("login") || e.contains("535") || e.contains("534") || e.contains("invalid")
    {
        "Authentication failed — check the username / app password.".to_string()
    } else if e.contains("dns") || e.contains("resolve") || e.contains("not known")
        || e.contains("no such host") || e.contains("connect") || e.contains("connection refused")
        || e.contains("timed out") || e.contains("timeout") || e.contains("unreachable")
    {
        "Couldn't reach the mail server — check the host and port.".to_string()
    } else if e.contains("tls") || e.contains("certificate") || e.contains("ssl") {
        "Secure connection (TLS) failed — check the port / security settings.".to_string()
    } else if e.contains("not configured") || e.contains("not found") || e.contains("no imap host")
        || e.contains("no password") || e.contains("no email")
    {
        // Configuration gap — surface the underlying message as-is (it's already clear).
        err.to_string()
    } else {
        format!("Connection failed: {}", err)
    }
}

/// Test the configured outbound SMTP account: open a connection and authenticate
/// (no email is sent). Reuses the existing SMTP config loader + `email::test_smtp`.
/// Returns `{ "ok": bool, "message": String }`.
#[tauri::command]
pub async fn test_smtp_connection() -> Result<Value, String> {
    match crate::email::test_smtp().await {
        Ok(()) => Ok(json!({ "ok": true, "message": "Connected — outbound email is working." })),
        Err(e) => Ok(json!({ "ok": false, "message": friendly_conn_error(&e.to_string()) })),
    }
}

/// Test one configured IMAP inbox by id: connect + LOGIN with its stored creds
/// (reuses the IMAP client behind `scan_inbox`). Returns `{ "ok": bool, "message": String }`.
#[tauri::command]
pub async fn test_inbox_connection(id: String) -> Result<Value, String> {
    match crate::email::test_inbox(&id).await {
        Ok(()) => Ok(json!({ "ok": true, "message": "Connected — inbox reachable and login succeeded." })),
        Err(e) => Ok(json!({ "ok": false, "message": friendly_conn_error(&e.to_string()) })),
    }
}

/// Whether a Google OAuth token (cred_prefix "oauth") is stored, and — best-effort —
/// which account/scopes it belongs to. Returns `{ "connected": bool, "email": String, "scopes": String }`.
/// `email` is derived from Google's userinfo endpoint when possible; blank otherwise.
#[tauri::command]
pub async fn google_email_status() -> Result<Value, String> {
    let connected = crate::email::cred_opt("oauth_refresh_token")
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    if !connected {
        return Ok(json!({ "connected": false, "email": "", "scopes": "" }));
    }
    // The "oauth" flow always requests full-Gmail access.
    let scopes = "https://mail.google.com/".to_string();
    // Best-effort account email: exchange the refresh token for an access token and
    // query Google's userinfo. Any failure just leaves the email blank.
    let email = google_oauth_email().await.unwrap_or_default();
    Ok(json!({ "connected": true, "email": email, "scopes": scopes }))
}

/// Best-effort: the Google account email for the stored "oauth" token, via
/// userinfo. Returns None on any failure (no token, refresh failed, request failed).
async fn google_oauth_email() -> Option<String> {
    let access = crate::email::oauth2_access_token().await.ok()?;
    let resp = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    body.get("email").and_then(|e| e.as_str()).map(|s| s.to_string())
}

/// The EFFECTIVE send/monitor account for this device (personal override if this
/// admin opted out and has one, else the org default). This is what the Settings
/// send card shows and what `send()` uses.
#[tauri::command]
pub async fn get_email_settings() -> Result<Option<crate::email::EmailSettings>, String> {
    Ok(crate::email::load_settings().ok())
}

#[tauri::command]
pub async fn save_company_info(mut info: crate::invoice::CompanyInfo) -> Result<(), String> {
    let logo_dir = crate::db::app_data_dir().clone();
    let target = logo_dir.join("company_logo.png");

    if let Some(ref src) = info.logo_path {
        let src_path = std::path::Path::new(src);
        // Guard against copying the stored logo onto itself: after a save+reload,
        // `logo_path` comes back as the target (`company_logo.png`), so a later save
        // (e.g. toggling `show_company_name`) would call fs::copy(target, target),
        // which errors/truncates on macOS and fails the whole autosave. Skip the copy
        // when the source is already the stored target; only copy a genuinely new file.
        let already_stored = src_path == target.as_path()
            || std::fs::canonicalize(src_path).ok() == std::fs::canonicalize(&target).ok();
        if !already_stored {
            std::fs::create_dir_all(&logo_dir).map_err(|e| e.to_string())?;
            std::fs::copy(src_path, &target).map_err(|e| e.to_string())?;
        }
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

    // Push the logo bytes to the server so the hosted invoice-PDF renderer can
    // draw it (the server never has this local path). Fire-and-forget: a sync
    // hiccup must not fail the save. Only when a logo exists + a server is
    // connected.
    if info.logo_path.is_some() && crate::netsync::is_enabled() {
        tokio::spawn(async {
            if let Err(e) = crate::netsync::upload_company_logo().await {
                tracing::warn!("company logo sync to server failed: {e}");
            }
        });
    }
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
    if val.as_deref() == Some("true") {
        return Ok(true);
    }
    // Skip onboarding for any signed-in SaaS store: if the store is claimed to a
    // server org, or an active staff account exists locally, this is a
    // website-created account (its company info already lives server-side and is
    // pulled) — the "Welcome to Ecliptr" company-info wizard must NOT run.
    if crate::db::active_store_org().map(|o| !o.is_empty()).unwrap_or(false) {
        return Ok(true);
    }
    let has_account: i64 = conn
        .query_row("SELECT COUNT(*) FROM staff_accounts WHERE status='active'", [], |r| r.get(0))
        .unwrap_or(0);
    if has_account > 0 {
        return Ok(true);
    }
    // Fallback: an existing store with clients is already set up.
    let cc: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap_or(0);
    if cc > 0 {
        let _ = conn.execute(
            "INSERT INTO settings (key,value) VALUES ('onboarding_completed','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [],
        );
        return Ok(true);
    }
    Ok(false)
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
            if name.starts_with("clienthub-backup-") && name.ends_with(".db") && name.len() == 30 {
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
    pub is_valid: bool,
}

fn verify_backup_integrity(path: &str) -> bool {
    rusqlite::Connection::open(path)
        .ok()
        .and_then(|c| c.query_row("PRAGMA integrity_check", [], |r| r.get::<_,String>(0)).ok())
        .map_or(false, |s| s == "ok")
}

#[tauri::command]
pub async fn list_backups() -> Result<Vec<BackupEntry>, String> {
    let dir = backup_dir_setting()?;
    let mut entries = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("clienthub-backup-") && name.ends_with(".db") && name.len() == 30 {
            if let Ok(meta) = entry.metadata() {
                let date = name[18..28].to_string();
                let full_path = entry.path();
                let is_valid = verify_backup_integrity(&full_path.to_string_lossy());
                entries.push(BackupEntry { filename: name, size: meta.len(), date, is_valid });
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
    pub notes: Option<String>,
    pub sent_whatsapp: bool,
    pub sent_email: bool,
    pub supplier: Option<String>,
    pub location: Option<String>,
    pub price_type: String,
    pub manifest_path: Option<String>,
    /// JSON blob of extra structured fields: {pallets, msrp, avg_msrp, moq, size_run:[{size,qty}]}.
    pub details_json: Option<String>,
}

#[tauri::command]
pub async fn list_inventory(status: Option<String>) -> Result<Vec<InventoryLot>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let (sql, params): (String, Vec<String>) = match &status {
        Some(s) => ("SELECT id,name,description,category,quantity,total_cost,asking_price,status,linked_deal_id,photos_json,created_at,updated_at,COALESCE(notes,''),COALESCE(sent_whatsapp,0)!=0,COALESCE(sent_email,0)!=0,COALESCE(supplier,''),COALESCE(location,''),COALESCE(price_type,'per_unit'),manifest_path,details_json FROM inventory WHERE status = ?1 ORDER BY created_at DESC".into(), vec![s.clone()]),
        None => ("SELECT id,name,description,category,quantity,total_cost,asking_price,status,linked_deal_id,photos_json,created_at,updated_at,COALESCE(notes,''),COALESCE(sent_whatsapp,0)!=0,COALESCE(sent_email,0)!=0,COALESCE(supplier,''),COALESCE(location,''),COALESCE(price_type,'per_unit'),manifest_path,details_json FROM inventory ORDER BY created_at DESC".into(), vec![]),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |r| Ok(InventoryLot {
        id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, category: r.get(3)?,
        quantity: r.get(4)?, total_cost: r.get(5)?, asking_price: r.get(6)?,
        status: r.get(7)?, linked_deal_id: r.get(8)?, photos_json: r.get(9)?,
        created_at: r.get(10)?, updated_at: r.get(11)?, notes: r.get(12)?,
        sent_whatsapp: r.get(13)?, sent_email: r.get(14)?, supplier: r.get(15)?,
        location: r.get(16)?, price_type: r.get(17)?, manifest_path: r.get(18)?,
        details_json: r.get(19)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_lot(name: String, quantity: i64, total_cost: f64, asking_price: f64, description: Option<String>, category: Option<String>, photos: Option<Vec<String>>, notes: Option<String>, supplier: Option<String>, location: Option<String>, price_type: Option<String>, details_json: Option<String>) -> Result<InventoryLot, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let photos_json = serde_json::to_string(&photos.unwrap_or_default()).map_err(|e| e.to_string())?;
    let pt = price_type.unwrap_or_else(|| "per_unit".into());
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO inventory (id,name,description,category,quantity,total_cost,asking_price,status,photos_json,created_at,updated_at,notes,sent_whatsapp,sent_email,supplier,location,price_type,details_json) VALUES (?1,?2,?3,?4,?5,?6,?7,'available',?8,?9,?9,?10,0,0,?11,?12,?13,?14)",
        rusqlite::params![id, name, description, category, quantity, total_cost, asking_price, photos_json, now, notes, supplier, location, pt, details_json],
    ).map_err(|e| e.to_string())?;

    // Sync the full row so other devices can reconstruct it.
    let mut cols = serde_json::Map::new();
    cols.insert("name".into(), serde_json::json!(name));
    cols.insert("description".into(), serde_json::json!(description));
    cols.insert("category".into(), serde_json::json!(category));
    cols.insert("quantity".into(), serde_json::json!(quantity));
    cols.insert("total_cost".into(), serde_json::json!(total_cost));
    cols.insert("asking_price".into(), serde_json::json!(asking_price));
    cols.insert("status".into(), serde_json::json!("available"));
    cols.insert("photos_json".into(), serde_json::json!(photos_json));
    cols.insert("created_at".into(), serde_json::json!(now));
    cols.insert("updated_at".into(), serde_json::json!(now));
    cols.insert("notes".into(), serde_json::json!(notes));
    cols.insert("sent_whatsapp".into(), serde_json::json!(0));
    cols.insert("sent_email".into(), serde_json::json!(0));
    cols.insert("supplier".into(), serde_json::json!(supplier));
    cols.insert("location".into(), serde_json::json!(location));
    cols.insert("price_type".into(), serde_json::json!(pt));
    cols.insert("details_json".into(), serde_json::json!(details_json));
    crate::sync::record_upsert("inventory", &id, cols).map_err(|e| e.to_string())?;

    Ok(InventoryLot { id, name, description, category, quantity, total_cost, asking_price, status: "available".into(), linked_deal_id: None, photos_json, created_at: now.clone(), updated_at: now, notes, sent_whatsapp: false, sent_email: false, supplier, location, price_type: pt, manifest_path: None, details_json })
}

#[tauri::command]
pub async fn update_lot(id: String, name: Option<String>, description: Option<String>, category: Option<String>, quantity: Option<i64>, total_cost: Option<f64>, asking_price: Option<f64>, photos: Option<Vec<String>>, notes: Option<String>, sent_whatsapp: Option<bool>, sent_email: Option<bool>, supplier: Option<String>, location: Option<String>, price_type: Option<String>, details_json: Option<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
    // Sync columns mirror the SET clause so changes propagate per-column.
    let mut cols = serde_json::Map::new();
    cols.insert("updated_at".into(), serde_json::json!(now));
    if let Some(v) = name { sets.push("name = ?".to_string()); cols.insert("name".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = description { sets.push("description = ?".to_string()); cols.insert("description".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = category { sets.push("category = ?".to_string()); cols.insert("category".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = quantity { sets.push("quantity = ?".to_string()); cols.insert("quantity".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = total_cost { sets.push("total_cost = ?".to_string()); cols.insert("total_cost".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = asking_price { sets.push("asking_price = ?".to_string()); cols.insert("asking_price".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = photos { let pj = serde_json::to_string(&v).map_err(|e| e.to_string())?; sets.push("photos_json = ?".to_string()); cols.insert("photos_json".into(), serde_json::json!(pj)); params.push(Box::new(pj)); }
    if let Some(v) = notes { sets.push("notes = ?".to_string()); cols.insert("notes".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = sent_whatsapp { sets.push("sent_whatsapp = ?".to_string()); cols.insert("sent_whatsapp".into(), serde_json::json!(v as i64)); params.push(Box::new(v as i64)); }
    if let Some(v) = sent_email { sets.push("sent_email = ?".to_string()); cols.insert("sent_email".into(), serde_json::json!(v as i64)); params.push(Box::new(v as i64)); }
    if let Some(v) = supplier { sets.push("supplier = ?".to_string()); cols.insert("supplier".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = location { sets.push("location = ?".to_string()); cols.insert("location".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = price_type { sets.push("price_type = ?".to_string()); cols.insert("price_type".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    if let Some(v) = details_json { sets.push("details_json = ?".to_string()); cols.insert("details_json".into(), serde_json::json!(v)); params.push(Box::new(v)); }
    let sql = format!("UPDATE inventory SET {} WHERE id = ?", sets.join(", "));
    params.push(Box::new(id.clone()));
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, refs.as_slice()).map_err(|e| e.to_string())?;
    crate::sync::record_upsert("inventory", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn archive_lot(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let status: String = conn.query_row("SELECT status FROM inventory WHERE id = ?1", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if status == "reserved" { return Err("Cannot archive a reserved lot. Remove the deal link first.".into()); }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("UPDATE inventory SET status = 'archived', updated_at = ?1 WHERE id = ?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    let mut cols = serde_json::Map::new();
    cols.insert("status".into(), serde_json::json!("archived"));
    cols.insert("updated_at".into(), serde_json::json!(now));
    crate::sync::record_upsert("inventory", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn link_lot_to_deal(lot_id: String, deal_id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM deals WHERE id = ?1", [&deal_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if exists == 0 { return Err("Deal not found".into()); }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("UPDATE inventory SET linked_deal_id = ?1, status = 'reserved', updated_at = ?2 WHERE id = ?3", rusqlite::params![deal_id, now, lot_id]).map_err(|e| e.to_string())?;
    let mut cols = serde_json::Map::new();
    cols.insert("linked_deal_id".into(), serde_json::json!(deal_id));
    cols.insert("status".into(), serde_json::json!("reserved"));
    cols.insert("updated_at".into(), serde_json::json!(now));
    crate::sync::record_upsert("inventory", &lot_id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

/// Directory where a specific lot's media lives: <app_data>/sync/media/inventory/<lot_id>/
fn lot_media_dir(lot_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = crate::db::app_data_dir().join("sync").join("media").join("inventory").join(lot_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Copy image files into the lot's media directory, named photo_001.jpg etc.
/// Continues numbering from existing photos. Returns relative paths.
#[tauri::command]
pub async fn import_lot_photos(lot_id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let dir = lot_media_dir(&lot_id)?;
    let photo_dir = dir.join("photos");
    std::fs::create_dir_all(&photo_dir).map_err(|e| e.to_string())?;

    let mut max_n: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(&photo_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("photo_") && name.ends_with(".jpg") {
                if let Some(num_str) = name.strip_prefix("photo_").and_then(|s| s.strip_suffix(".jpg")) {
                    if let Ok(n) = num_str.parse::<u32>() { max_n = max_n.max(n); }
                }
            }
        }
    }
    if max_n == 0 { max_n = 1; } else { max_n += 1; }

    let mut out = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        if p.starts_with("media/") || p.starts_with("media\\") {
            out.push(p.replace('\\', "/"));
            continue;
        }
        let src = std::path::Path::new(p);
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("img").to_lowercase();
        let num = max_n + i as u32;
        let fname = format!("photo_{:03}.{}", num, ext);
        let dest = photo_dir.join(&fname);
        std::fs::copy(src, &dest).map_err(|e| format!("Couldn't copy photo: {}", e))?;
        out.push(format!("media/inventory/{}/photos/{}", lot_id, fname));
    }
    // Push each photo's bytes to the server so the hosted storefront can show it from
    // ANY device (photo files don't ride the DB sync oplog). Best-effort: a network
    // failure never fails the local import — the startup backfill re-uploads later.
    for rel in &out {
        let _ = crate::netsync::upload_inventory_photo(&lot_id, rel).await;
    }
    Ok(out)
}

/// Upload every locally-present inventory photo to the server (idempotent). Backfills
/// lots whose photos were added before per-photo upload existed, or from a device that
/// never had a media bridge to the host — the fix for "shows in inventory but not the
/// storefront". Run from a device that holds the files (the media-bridged host has them
/// all). Returns the number of photos successfully uploaded.
#[tauri::command]
pub async fn backfill_inventory_photos() -> Result<u32, String> {
    let base = crate::db::app_data_dir().join("sync").join("media").join("inventory");
    let mut n = 0u32;
    let lots = match std::fs::read_dir(&base) { Ok(l) => l, Err(_) => return Ok(0) };
    for lot in lots.flatten() {
        if !lot.path().is_dir() { continue; }
        let lot_id = lot.file_name().to_string_lossy().to_string();
        let pdir = lot.path().join("photos");
        if let Ok(photos) = std::fs::read_dir(&pdir) {
            for ph in photos.flatten() {
                if !ph.path().is_file() { continue; }
                let fname = ph.file_name().to_string_lossy().to_string();
                let rel = format!("media/inventory/{}/photos/{}", lot_id, fname);
                match crate::netsync::upload_inventory_photo(&lot_id, &rel).await {
                    Ok(_) => n += 1,
                    // Retryable (not signed in / server unreachable / 5xx): abort so the
                    // caller can try again later instead of marking the backfill done.
                    Err(e) if e.contains("sign") || e.contains("reach") || e.contains("server returned 5") => {
                        return Err(e);
                    }
                    // Per-file issue (missing file, 4xx): skip and keep going.
                    Err(_) => {}
                }
            }
        }
    }
    Ok(n)
}

/// Run the photo backfill once per install, guarded by a local marker so it doesn't
/// re-upload everything each launch. A retryable failure (offline / signed out) leaves
/// the marker unset so it runs again next time. New photos upload at save time.
pub async fn startup_backfill_inventory_photos() {
    if read_setting("inv_photo_backfill_v1").is_some() { return; }
    match backfill_inventory_photos().await {
        Ok(n) => {
            tracing::info!("storefront photo backfill: uploaded {}", n);
            let _ = write_setting("inv_photo_backfill_v1", "done");
        }
        Err(e) => tracing::warn!("photo backfill deferred: {}", e),
    }
}

/// Remove a single photo — deletes the file from disk and returns updated photo list path.
#[tauri::command]
pub async fn remove_lot_photo(lot_id: String, photo_path: String) -> Result<Vec<String>, String> {
    let full = crate::db::app_data_dir().join("sync").join(&photo_path.replace('\\', "/"));
    let _ = std::fs::remove_file(&full);

    let conn = pool().get().map_err(|e| e.to_string())?;
    let photos_str: String = conn.query_row("SELECT photos_json FROM inventory WHERE id=?1", [&lot_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut photos: Vec<String> = serde_json::from_str(&photos_str).unwrap_or_default();
    photos.retain(|p| p != &photo_path.replace('\\', "/"));
    let new_json = serde_json::to_string(&photos).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute("UPDATE inventory SET photos_json=?1, updated_at=?2 WHERE id=?3", rusqlite::params![new_json, now, &lot_id])
        .map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("photos_json".into(), json!(new_json));
    cols.insert("updated_at".into(), json!(now));
    crate::sync::record_upsert("inventory", &lot_id, cols).map_err(|e| e.to_string())?;
    Ok(photos)
}

/// Attach a manifest file (PDF/CSV). Deletes old manifest if one exists.
#[tauri::command]
pub async fn attach_lot_manifest(lot_id: String, file_path: String) -> Result<String, String> {
    let dir = lot_media_dir(&lot_id)?;
    let src = std::path::Path::new(&file_path);
    let fname = src.file_name().and_then(|f| f.to_str()).unwrap_or("manifest");
    let dest = dir.join("manifest");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let dest_path = if !ext.is_empty() { format!("{}.{}", dest.to_string_lossy(), ext) } else { dest.to_string_lossy().to_string() };
    let rel_path = format!("media/inventory/{}/manifest.{}", lot_id, ext);

    let old_manifest: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT manifest_path FROM inventory WHERE id=?1", [&lot_id], |r| r.get(0)).ok()
    };
    if let Some(ref old) = old_manifest {
        let old_full = crate::db::app_data_dir().join("sync").join(old.replace('\\', "/"));
        let _ = std::fs::remove_file(&old_full);
    }

    std::fs::copy(src, &dest_path).map_err(|e| format!("Couldn't copy manifest: {}", e))?;

    let now = Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE inventory SET manifest_path=?1, updated_at=?2 WHERE id=?3", rusqlite::params![rel_path, now, &lot_id])
        .map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("manifest_path".into(), json!(rel_path));
    cols.insert("updated_at".into(), json!(now));
    crate::sync::record_upsert("inventory", &lot_id, cols).map_err(|e| e.to_string())?;
    // Push the FILE to the server (the oplog only carries the path text) so the
    // public storefront can serve it. Best-effort — a failure here still keeps the
    // local attach; a later Repair/re-attach re-uploads.
    let _ = crate::netsync::upload_inventory_manifest(&lot_id, &rel_path).await;
    Ok(rel_path)
}

/// Remove attached manifest — deletes file from disk.
#[tauri::command]
pub async fn remove_lot_manifest(lot_id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let rel: Option<String> = conn.query_row("SELECT manifest_path FROM inventory WHERE id=?1", [&lot_id], |r| r.get(0)).ok();
    if let Some(ref p) = rel {
        let full = crate::db::app_data_dir().join("sync").join(p.replace('\\', "/"));
        let _ = std::fs::remove_file(&full);
    }
    let now = Utc::now().to_rfc3339();
    conn.execute("UPDATE inventory SET manifest_path=NULL, updated_at=?1 WHERE id=?2", rusqlite::params![now, &lot_id])
        .map_err(|e| e.to_string())?;
    let mut cols = Map::new();
    cols.insert("manifest_path".into(), Value::Null);
    cols.insert("updated_at".into(), json!(now));
    crate::sync::record_upsert("inventory", &lot_id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

/// Absolute path of the synced folder that relative media paths resolve against.
#[tauri::command]
pub fn media_base_dir() -> Result<String, String> {
    Ok(crate::db::app_data_dir().join("sync").to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct LotMediaFile {
    pub path: String,
    pub lot_name: String,
}

#[derive(Serialize)]
pub struct LotMediaFiles {
    pub photos: Vec<LotMediaFile>,
    pub manifests: Vec<LotMediaFile>,
}

#[tauri::command]
pub async fn generate_whatsapp_message(lot_ids: Vec<String>) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    // Business name always comes from company_info — never hardcoded.
    let company_name: String = conn.query_row(
        "SELECT COALESCE(json_extract(value, '$.name'), '') FROM settings WHERE key='company_info'",
        [], |r| r.get(0),
    ).unwrap_or_default();
    let business_name = if company_name.trim().is_empty() { "Available Inventory".to_string() } else { company_name };

    let template   = wa_setting(&conn, "whatsapp_message_template", DEFAULT_WA_TEMPLATE);
    let lot_format = wa_setting(&conn, "whatsapp_lot_format",       DEFAULT_WA_LOT_FORMAT);
    let footer     = wa_setting(&conn, "whatsapp_footer",           DEFAULT_WA_FOOTER);
    let phone      = wa_setting(&conn, "whatsapp_phone",            "");

    // Build the lot list by substituting each lot into the lot-format template.
    let mut lot_list = String::new();
    let mut idx = 1;
    for lid in &lot_ids {
        let (name, qty, ask, cat): (String, i64, f64, Option<String>) = conn.query_row(
            "SELECT name, quantity, asking_price, category FROM inventory WHERE id=?1",
            [lid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?;
        let entry = lot_format
            .replace("{number}", &idx.to_string())
            .replace("{lot_name}", &name)
            .replace("{quantity}", &qty.to_string())
            .replace("{asking_price}", &fmt_money(ask))
            .replace("{category}", cat.as_deref().unwrap_or(""));
        lot_list.push_str(&entry);
        lot_list.push('\n');
        idx += 1;
    }
    let lot_list = lot_list.trim_end().to_string();

    let msg = template
        .replace("{business_name}", &business_name)
        .replace("{lot_list}", &lot_list)
        .replace("{footer}", &footer)
        .replace("{phone}", &phone);
    Ok(msg)
}

const DEFAULT_WA_TEMPLATE: &str = "*{business_name}*\n\n{lot_list}\n{footer}";
const DEFAULT_WA_LOT_FORMAT: &str = "{number}\u{fe0f}\u{20e3} *{lot_name}*\n   {quantity} units · Asking: {asking_price} · {category}";
const DEFAULT_WA_FOOTER: &str = "Reply to claim or for more info";

fn wa_setting(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
        .unwrap_or_else(|_| default.to_string())
}

#[derive(serde::Serialize)]
pub struct WhatsappSettings {
    pub template: String,
    pub lot_format: String,
    pub footer: String,
    pub phone: String,
}

#[tauri::command]
pub async fn get_whatsapp_settings() -> Result<WhatsappSettings, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(WhatsappSettings {
        template:   wa_setting(&conn, "whatsapp_message_template", DEFAULT_WA_TEMPLATE),
        lot_format: wa_setting(&conn, "whatsapp_lot_format",       DEFAULT_WA_LOT_FORMAT),
        footer:     wa_setting(&conn, "whatsapp_footer",           DEFAULT_WA_FOOTER),
        phone:      wa_setting(&conn, "whatsapp_phone",            ""),
    })
}

#[tauri::command]
pub async fn save_whatsapp_settings(template: String, lot_format: String, footer: String, phone: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (k, v) in [
        ("whatsapp_message_template", &template),
        ("whatsapp_lot_format",       &lot_format),
        ("whatsapp_footer",           &footer),
        ("whatsapp_phone",            &phone),
    ] {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![k, v],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a lot's media folder in the OS file manager (Explorer/Finder) so files
/// can be dragged straight into WhatsApp Web.
#[tauri::command]
pub async fn open_lot_folder(app: tauri::AppHandle, lot_id: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let dir = lot_media_dir(&lot_id)?;
    app.shell()
        .open(dir.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Quick reachability check for WhatsApp Web (TCP connect, no HTTP). Drives the
/// "no internet" error + retry in the share panel without any third-party API.
#[tauri::command]
pub fn whatsapp_web_reachable() -> bool {
    use std::net::ToSocketAddrs;
    let addrs = match ("web.whatsapp.com", 443u16).to_socket_addrs() {
        Ok(a) => a,
        Err(_) => return false,
    };
    for addr in addrs {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(4)).is_ok() {
            return true;
        }
    }
    false
}

/// Open WhatsApp Web in a dedicated Tauri webview window (WebviewUrl::External).
/// A real browser engine — required because web.whatsapp.com refuses to be
/// embedded in an iframe (frame-ancestors). No script injection, no automation;
/// the persistent login session lives in this window.
#[tauri::command]
pub async fn open_whatsapp_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("whatsapp") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = "https://web.whatsapp.com".parse().map_err(|e| format!("bad url: {e}"))?;
    tauri::WebviewWindowBuilder::new(&app, "whatsapp", tauri::WebviewUrl::External(url))
        .title("WhatsApp Web — ClientHub")
        .inner_size(1100.0, 820.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy the WhatsApp webview window — called when the share panel closes so
/// there is no lingering webview / memory leak.
#[tauri::command]
pub async fn close_whatsapp_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("whatsapp") {
        let _ = w.close();
    }
    Ok(())
}

/// Embed WhatsApp Web as a second webview *inside* the main window, positioned
/// over the share panel's right pane (logical/CSS pixels relative to the window).
/// Creating-or-repositioning is the same call so the frontend can keep it pinned
/// to the pane on resize. Requires Tauri's `unstable` multi-webview feature.
/// web.whatsapp.com can't be iframed, so this is the only way to embed it.
#[tauri::command]
pub async fn whatsapp_embed_show(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    let pos = tauri::LogicalPosition::new(x, y);
    let size = tauri::LogicalSize::new(width.max(1.0), height.max(1.0));
    if let Some(wv) = app.get_webview("whatsapp") {
        let _ = wv.set_position(pos);
        let _ = wv.set_size(size);
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let url = "https://web.whatsapp.com"
        .parse()
        .map_err(|e| format!("bad url: {e}"))?;
    // `disable_drag_drop_handler` is essential: otherwise Tauri intercepts OS
    // file drops on this webview and emits its own event, so the dropped photo
    // never reaches WhatsApp's web page. Disabling it lets the drop fall through
    // to WhatsApp's own "drop to attach" handler.
    let builder = tauri::webview::WebviewBuilder::new("whatsapp", tauri::WebviewUrl::External(url))
        .disable_drag_drop_handler();
    window
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy the embedded WhatsApp webview — called when the share panel closes.
#[tauri::command]
pub async fn whatsapp_embed_close(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(wv) = app.get_webview("whatsapp") {
        let _ = wv.close();
    }
    Ok(())
}

fn fmt_money(n: f64) -> String {
    let int = n.trunc() as i64;
    let frac = ((n.fract().abs() * 100.0).round() as i64) % 100;
    let s = format!("{}", int.abs());
    let mut out = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 { out.push(','); }
        out.push(c);
    }
    let int_str: String = out.chars().rev().collect();
    let sign = if int < 0 { "-" } else { "" };
    format!("${}{}.{:02}", sign, int_str, frac)
}

#[tauri::command]
pub async fn get_lot_media_files(lot_ids: Vec<String>) -> Result<LotMediaFiles, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let base = crate::db::app_data_dir().join("sync");
    let mut photos = Vec::new();
    let mut manifests = Vec::new();

    for lid in &lot_ids {
        let (name, photos_json, manifest): (String, String, Option<String>) = conn.query_row(
            "SELECT name, photos_json, manifest_path FROM inventory WHERE id=?1",
            [lid], |r| Ok((r.get(0)?, r.get::<_,String>(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?;

        let photo_paths: Vec<String> = serde_json::from_str(&photos_json).unwrap_or_default();
        for pp in &photo_paths {
            let full = base.join(pp.replace('\\', "/"));
            if full.exists() {
                photos.push(LotMediaFile { path: full.to_string_lossy().to_string(), lot_name: name.clone() });
            }
        }
        if let Some(ref mp) = manifest {
            let full = base.join(mp.replace('\\', "/"));
            if full.exists() {
                manifests.push(LotMediaFile { path: full.to_string_lossy().to_string(), lot_name: name.clone() });
            }
        }
    }
    Ok(LotMediaFiles { photos, manifests })
}

#[tauri::command]
pub async fn save_whatsapp_footer(footer: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings (key, value) VALUES ('whatsapp_footer', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&footer])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_whatsapp_footer() -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let val: String = conn.query_row("SELECT value FROM settings WHERE key='whatsapp_footer'", [], |r| r.get(0))
        .unwrap_or_else(|_| "💬 Reply to claim or for more info".into());
    Ok(val)
}

#[tauri::command]
pub async fn set_lot_status(id: String, status: String) -> Result<(), String> {
    if !["available", "reserved", "sold", "archived"].contains(&status.as_str()) {
        return Err("Invalid status".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    // Returning to "available" also clears any deal link.
    let mut cols = serde_json::Map::new();
    cols.insert("status".into(), serde_json::json!(status));
    cols.insert("updated_at".into(), serde_json::json!(now));
    if status == "available" {
        conn.execute("UPDATE inventory SET status = ?1, linked_deal_id = NULL, updated_at = ?2 WHERE id = ?3", rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
        cols.insert("linked_deal_id".into(), serde_json::Value::Null);
    } else {
        conn.execute("UPDATE inventory SET status = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
    }
    crate::sync::record_upsert("inventory", &id, cols).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_lot(id: String) -> Result<(), String> {
    let media_dir = crate::db::app_data_dir().join("sync").join("media").join("inventory").join(&id);
    let _ = std::fs::remove_dir_all(&media_dir);
    crate::sync::record_delete("inventory", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM inventory WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_lots(ids: Vec<String>) -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut n = 0u32;
    for id in &ids {
        crate::sync::record_delete("inventory", id).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM inventory WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

#[derive(serde::Serialize)]
pub struct Offer {
    pub id: String,
    pub lot_id: String,
    pub name: String,
    pub email: String,
    pub amount: Option<f64>,
    pub message: String,
    pub status: String,
    pub created_at: String,
}

/// Buyer offers submitted from the public storefront ("Make an offer"), newest first.
/// Written server-side and synced down; the inventory view groups them per lot.
#[tauri::command]
pub async fn list_offers() -> Result<Vec<Offer>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, lot_id, name, email, amount, message, status, created_at FROM offers ORDER BY created_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(Offer {
        id: r.get(0)?, lot_id: r.get(1)?, name: r.get(2)?, email: r.get(3)?,
        amount: r.get(4)?, message: r.get(5)?, status: r.get(6)?, created_at: r.get(7)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Mark an offer new | accepted | declined (synced so it reflects on every device).
#[tauri::command]
pub async fn set_offer_status(id: String, status: String) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE offers SET status=?1, updated_at=?2 WHERE id=?3", rusqlite::params![status, now, id]).map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("status".into(), json!(status));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("offers", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

#[tauri::command]
pub async fn delete_offer(id: String) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM offers WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    sync::record_delete("offers", &id).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// Re-record every inventory row as a sync upsert. Fixes lots that aren't
/// propagating to other devices (e.g. created before inventory was synced, or
/// before a device joined). Safe to run repeatedly — last-writer-wins resolves.
#[tauri::command]
pub async fn resync_inventory() -> Result<u32, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,name,description,category,quantity,total_cost,asking_price,status,linked_deal_id,photos_json,created_at,updated_at,notes,sent_whatsapp,sent_email,supplier,location FROM inventory"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<serde_json::Map<String, serde_json::Value>> = stmt.query_map([], |r| {
        let mut c = serde_json::Map::new();
        c.insert("id".into(), serde_json::json!(r.get::<_, String>(0)?));
        c.insert("name".into(), serde_json::json!(r.get::<_, String>(1)?));
        c.insert("description".into(), serde_json::json!(r.get::<_, Option<String>>(2)?));
        c.insert("category".into(), serde_json::json!(r.get::<_, Option<String>>(3)?));
        c.insert("quantity".into(), serde_json::json!(r.get::<_, i64>(4)?));
        c.insert("total_cost".into(), serde_json::json!(r.get::<_, f64>(5)?));
        c.insert("asking_price".into(), serde_json::json!(r.get::<_, f64>(6)?));
        c.insert("status".into(), serde_json::json!(r.get::<_, String>(7)?));
        c.insert("linked_deal_id".into(), serde_json::json!(r.get::<_, Option<String>>(8)?));
        c.insert("photos_json".into(), serde_json::json!(r.get::<_, String>(9)?));
        c.insert("created_at".into(), serde_json::json!(r.get::<_, String>(10)?));
        c.insert("updated_at".into(), serde_json::json!(r.get::<_, String>(11)?));
        c.insert("notes".into(), serde_json::json!(r.get::<_, Option<String>>(12)?));
        c.insert("sent_whatsapp".into(), serde_json::json!(r.get::<_, i64>(13)?));
        c.insert("sent_email".into(), serde_json::json!(r.get::<_, i64>(14)?));
        c.insert("supplier".into(), serde_json::json!(r.get::<_, Option<String>>(15)?));
        c.insert("location".into(), serde_json::json!(r.get::<_, Option<String>>(16)?));
        Ok(c)
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let mut n = 0u32;
    for cols in rows {
        let id = cols.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() { continue; }
        crate::sync::record_upsert("inventory", &id, cols).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
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
    let valid_triggers = ["no_order", "no_contact", "overdue_invoice", "stale_deal", "tier_drop", "birthday"];
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

    let tier_map = build_client_tier_map(&conn)?;

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
            "tier_drop" => {
                // Tiers are stored/compared as CODES (S/A/B/C), not labels — the old
                // label match made every rank 0, so tier-drop never fired and
                // tier_history stayed empty.
                let tier_rank = |t: &str| -> i32 { match t { "S"=>4,"A"=>3,"B"=>2,"C"=>1,_=>0 } };
                let mut results = Vec::new();
                let mut stmt_c = conn.prepare("SELECT id, name, email, metadata FROM clients").map_err(|e| e.to_string())?;
                let clients: Vec<(String, Option<String>, Option<String>, Option<String>)> = stmt_c.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,Option<String>>(1)?, r.get::<_,Option<String>>(2)?, r.get::<_,Option<String>>(3)?)))
                    .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
                for (cid, cname, cemail, meta_str) in clients {
                    let current_tier = tier_map.get(&cid).cloned().unwrap_or_else(|| "Prospect".into());
                    let meta: Option<Value> = meta_str.as_deref().and_then(|s| serde_json::from_str(s).ok());
                    let stored_tier = meta.as_ref().and_then(|m| m.get("buyer_tier")).and_then(|v| v.as_str());
                    if let Some(stored) = stored_tier {
                        let current_rank = tier_rank(&current_tier);
                        let stored_rank = tier_rank(stored);
                        if stored_rank > current_rank {
                            results.push((cid.clone(), cname, cemail, Some(format!("{} → {}", stored, current_tier))));
                            let hid = uuid::Uuid::new_v4().to_string();
                            let _ = conn.execute(
                                "INSERT INTO tier_history (id, client_id, from_tier, to_tier, changed_at) VALUES (?1,?2,?3,?4,?5)",
                                rusqlite::params![hid, &cid, stored, &current_tier, &now_str],
                            );
                        }
                    }
                    if stored_tier.map_or(true, |s| s != current_tier) {
                        let mut meta_update = meta.unwrap_or(json!({}));
                        meta_update["buyer_tier"] = Value::String(current_tier);
                        let updated_json = serde_json::to_string(&meta_update).unwrap_or_default();
                        let _ = conn.execute("UPDATE clients SET metadata=?1 WHERE id=?2", rusqlite::params![updated_json, &cid]);
                    }
                }
                results
            }
            "birthday" => {
                let today_mmdd = now.format("%m-%d").to_string();
                let like_pat = format!("%{}", today_mmdd);
                let mut stmt_b = conn.prepare(
                    "SELECT id, name, email FROM clients WHERE json_extract(metadata, '$.birthday') LIKE ?1"
                ).map_err(|e| e.to_string())?;
                let rows: Vec<_> = stmt_b.query_map([&like_pat], |r| Ok((r.get(0)?, r.get::<_,Option<String>>(1)?, r.get::<_,Option<String>>(2)?, Some(today_mmdd.clone()))))
                    .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
                rows
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
                let raw_subject = rule.email_subject.clone().unwrap_or_else(|| "Follow-up".into());
                let raw_body = rule.email_body.clone().unwrap_or_default();
                let subject = crate::template::substitute_variables(&raw_subject, client_id, &conn);
                let body = crate::template::substitute_variables(&raw_body, client_id, &conn);
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
        .query_row("SELECT COUNT(*) FROM invoices WHERE COALESCE(archived,0)=0", [], |r| r.get(0))
        .unwrap_or(0);
    // Dashboard "owed to you" (AR / cash position): open invoices that are NOT
    // void AND whose deal has committed (past the speculative `invoiced` stage).
    // Speculative early invoices no longer inflate the hero. The detailed
    // Receivables VIEW still shows everything.
    let outstanding: f64 = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(total),0) FROM invoices
                 WHERE status IN ('sent','overdue') AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0
                   AND COALESCE(deal_flow_stage,'none') IN ({stages})",
                stages = COMMITTED_AR_STAGES
            ),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let paid_this_year: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM invoices
             WHERE status='paid' AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND issue_date >= ?1",
            [format!("{}-01-01", Utc::now().format("%Y"))],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    let revenue_this_week: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(total),0) FROM invoices
             WHERE status='paid' AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND paid_at >= date('now', '-7 days')",
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
            "SELECT COALESCE(SUM(total_cost),0) FROM invoices WHERE is_complete=1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let total_profit: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(profit),0) FROM invoices WHERE is_complete=1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    let avg_margin: f64 = conn
        .query_row(
            "SELECT COALESCE(AVG(CASE WHEN total>0 THEN (profit/total)*100 END),0) FROM invoices WHERE is_complete=1 AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 AND profit IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0.0);

    let monthly_profit: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m', df.completed_at) as m, COALESCE(SUM(df.gross_revenue),0), COALESCE(SUM(df.total_cost),0), \
                    COALESCE(SUM(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0)),0)
             FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
             WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 \
               AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 GROUP BY m ORDER BY m"
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
             WHERE i.is_complete=1 AND i.profit IS NOT NULL AND COALESCE(i.archived,0)=0 AND COALESCE(i.voided,0)=0
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
            "SELECT COALESCE(SUM(asking_price),0) FROM deals WHERE stage NOT IN ('won','lost') AND COALESCE(archived,0)=0",
            [], |r| r.get(0),
        ).unwrap_or(0.0);
    let pipeline_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deals WHERE stage NOT IN ('won','lost') AND COALESCE(archived,0)=0",
            [], |r| r.get(0),
        ).unwrap_or(0);

    // New hero stats: active (open) deal flows and deal flows completed this month.
    // `open_deals` mirrors the active-pipeline filter (archived + voided/archived
    // invoice excluded); `completed_this_month` counts non-archived completions in
    // the current calendar month.
    // One open deal per INVOICE, and only when its best (survivor) flow hasn't
    // completed. COUNT(*) over raw rows counted duplicate ghost flows and orphans
    // (invoice deleted, LEFT JOIN passing NULLs) — inflating the hero severalfold.
    let open_deals: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ( \
               SELECT df.invoice_id, MAX(CASE df.stage WHEN 'complete' THEN 4 WHEN 'supplier_paid' THEN 3 \
                      WHEN 'payment_received' THEN 2 ELSE 1 END) AS best \
               FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
               WHERE COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
               GROUP BY df.invoice_id) WHERE best < 4",
            [], |r| r.get(0),
        ).unwrap_or(0);
    let completed_this_month: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deal_flows WHERE stage='complete' AND COALESCE(archived,0)=0 AND strftime('%Y-%m', completed_at) = ?1",
            [Utc::now().format("%Y-%m").to_string()], |r| r.get(0),
        ).unwrap_or(0);

    let incomplete_shipping: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM invoices WHERE status='paid' AND is_complete=0 AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0",
            [], |r| r.get(0),
        ).unwrap_or(0);

    let category_breakdown: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT COALESCE(json_extract(metadata,'$.category'),'Uncategorized') as cat,
                    COUNT(*) as cnt,
                    COALESCE(SUM(CASE WHEN i.status='paid' AND COALESCE(i.archived,0)=0 AND COALESCE(i.voided,0)=0 THEN i.total ELSE 0 END),0) as paid_rev
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

    // Voided (fell-through) invoices get their own bucket instead of vanishing —
    // the rows now sum to the headline invoice count, and a sent invoice's history
    // stays visible even after the deal dies.
    let invoice_status_breakdown: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT CASE WHEN COALESCE(voided,0)=1 THEN 'void' ELSE status END AS st, COUNT(*), COALESCE(SUM(total),0) \
             FROM invoices WHERE COALESCE(archived,0)=0 GROUP BY st"
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
             WHERE i.is_complete=1 AND COALESCE(i.archived,0)=0 AND COALESCE(i.voided,0)=0
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

    // Hero Revenue + Profit with [This month | All time] toggle + prev-month delta.
    // Revenue = PAID invoice totals (non-void, non-archived), month-matched on
    // paid_at with an issue_date fallback for old rows that never set paid_at.
    // Profit = completed deal_flows net_profit (non-archived) by completed_at.
    let this_month = Utc::now().format("%Y-%m").to_string();
    let prev_month = {
        let now = Utc::now().date_naive();
        let (y, m) = (now.year(), now.month());
        if m == 1 { format!("{}-12", y - 1) } else { format!("{}-{:02}", y, m - 1) }
    };
    const REV_MONTH_SQL: &str =
        "SELECT COALESCE(SUM(total),0) FROM invoices \
         WHERE status='paid' AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 \
           AND strftime('%Y-%m', COALESCE(NULLIF(paid_at,''), issue_date)) = ?1";
    let revenue_mtd: f64 = conn.query_row(REV_MONTH_SQL, [&this_month], |r| r.get(0)).unwrap_or(0.0);
    let revenue_prev_month: f64 = conn.query_row(REV_MONTH_SQL, [&prev_month], |r| r.get(0)).unwrap_or(0.0);
    let revenue_all_time: f64 = conn.query_row(
        "SELECT COALESCE(SUM(total),0) FROM invoices WHERE status='paid' AND COALESCE(voided,0)=0 AND COALESCE(archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    // Profit is refund-aware (refunds come off the deal's profit) and fell-through
    // deals (voided/archived invoice) are excluded — the same accuracy rules as the
    // brief, so the two surfaces can never disagree by construction.
    const PROFIT_MONTH_SQL: &str =
        "SELECT COALESCE(SUM(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0)),0) \
         FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 \
           AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 AND strftime('%Y-%m', df.completed_at) = ?1";
    let profit_mtd: f64 = conn.query_row(PROFIT_MONTH_SQL, [&this_month], |r| r.get(0)).unwrap_or(0.0);
    let profit_prev_month: f64 = conn.query_row(PROFIT_MONTH_SQL, [&prev_month], |r| r.get(0)).unwrap_or(0.0);
    let profit_all_time: f64 = conn.query_row(
        "SELECT COALESCE(SUM(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0)),0) \
         FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let deals_mtd: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT df.invoice_id) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 \
           AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 AND df.completed_at >= ?1",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0);

    // Top suppliers by total paid — payments are stored as JSON in deal_flows
    let top_suppliers: Vec<Value> = {
        let mut stmt = conn.prepare(
            "SELECT json_extract(sp.value, '$.supplier_name') as name,
                    COALESCE(MAX(s.contact_name), '') as contact_name,
                    COUNT(DISTINCT df.id) as deal_count,
                    COALESCE(SUM(CAST(json_extract(sp.value, '$.amount') AS REAL)), 0) as total_paid
             FROM deal_flows df
             JOIN invoices i ON i.id = df.invoice_id,
                  json_each(COALESCE(NULLIF(df.supplier_payments_json,''), '[]')) sp
             LEFT JOIN suppliers s ON json_extract(sp.value, '$.supplier_id') = s.id
             WHERE df.stage = 'complete' AND COALESCE(df.archived,0)=0
               AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0
               AND json_extract(sp.value, '$.supplier_name') IS NOT NULL
               AND COALESCE(json_extract(sp.value, '$.category'), 'supplier') = 'supplier'
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
        "SELECT COUNT(*) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
           AND df.completed_at >= ?1 AND df.net_profit < 0",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0);
    let loss_total_this_month: f64 = conn.query_row(
        "SELECT COALESCE(SUM(df.net_profit),0) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
           AND df.completed_at >= ?1 AND df.net_profit < 0",
        [&month_start], |r| r.get(0)
    ).unwrap_or(0.0);
    // All-time deal outcomes for the analytics dashboard: won = distinct invoices
    // with a completed live flow; lost = fell-through (voided) invoices.
    let deals_won_all: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT df.invoice_id) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0);
    let deals_lost_all: i64 = conn.query_row(
        "SELECT COUNT(*) FROM invoices WHERE COALESCE(voided,0)=1 AND COALESCE(archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0);

    // All-time totals from completed deal flows — fell-through excluded, profit
    // refund-aware (revenue stays gross; refunds are surfaced as their own stat).
    let all_time_revenue: f64 = conn.query_row(
        "SELECT COALESCE(SUM(df.gross_revenue),0) FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let all_time_profit: f64 = conn.query_row(
        "SELECT COALESCE(SUM(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0)),0) \
         FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    // Refund story for the analytics dashboard: total refunded (rule: non-bank-linked
    // refunds rows + every refund_out allocation, so bank-linked ones count once) and
    // what's still owed back to customers.
    let refunded_total: f64 = conn.query_row(
        "SELECT COALESCE((SELECT SUM(amount) FROM refunds WHERE COALESCE(bank_txn_id,'')=''),0) \
              + COALESCE((SELECT SUM(amount) FROM bank_allocation WHERE role='refund_out'),0)",
        [], |r| r.get(0)
    ).unwrap_or(0.0);
    let refund_owed_remaining: f64 = conn.query_row(
        "SELECT COALESCE(SUM(MAX(owed - refunded, 0)),0) FROM ( \
           SELECT COALESCE(df.refund_owed,0) AS owed, \
                  COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id AND COALESCE(r.bank_txn_id,'')=''),0) \
                + COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='refund_out'),0) AS refunded \
           FROM deal_flows df WHERE COALESCE(df.archived,0)=0 AND COALESCE(df.refund_owed,0) > 0.01)",
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
        "open_deals": open_deals,
        "completed_this_month": completed_this_month,
        "incomplete_shipping": incomplete_shipping,
        "category_breakdown": category_breakdown,
        "invoice_status_breakdown": invoice_status_breakdown,
        "top_spenders": top_spenders,
        "loss_deals_this_month": loss_deals_this_month,
        "loss_total_this_month": loss_total_this_month,
        "revenue_mtd": revenue_mtd,
        "revenue_all_time": revenue_all_time,
        "revenue_prev_month": revenue_prev_month,
        "profit_mtd": profit_mtd,
        "profit_all_time": profit_all_time,
        "profit_prev_month": profit_prev_month,
        "deals_mtd": deals_mtd,
        "top_suppliers": top_suppliers,
        "all_time_revenue": all_time_revenue,
        "all_time_profit": all_time_profit,
        "refunded_total": refunded_total,
        "refund_owed_remaining": refund_owed_remaining,
        "deals_won_all": deals_won_all,
        "deals_lost_all": deals_lost_all,
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
         JOIN invoices i ON i.id = df.invoice_id
         LEFT JOIN clients c ON c.id = i.client_id
         WHERE df.stage = 'complete'
           AND COALESCE(df.archived,0)=0
           AND COALESCE(i.voided,0)=0
           AND COALESCE(i.archived,0)=0
           AND EXISTS (
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
        "SELECT date(df.completed_at) as d, COALESCE(SUM(df.net_profit),0), COALESCE(SUM(df.gross_revenue),0)
         FROM deal_flows df
         WHERE df.stage='complete' AND strftime('%Y-%m', df.completed_at) = ?1
         GROUP BY d ORDER BY d"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&month], |r| {
        Ok(json!({ "day": r.get::<_, String>(0)?, "profit": r.get::<_, f64>(1)?, "revenue": r.get::<_, f64>(2)? }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Accounts-receivable aging: open invoices (sent/overdue) bucketed by days past
/// due_date, per client + grand totals. Payment is binary here (an invoice flips to
/// 'paid' on receipt), so there is no partial-payment netting — open = full total.
#[tauri::command]
pub async fn get_receivables_aging() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    // The VIEW shows every open, non-void invoice. Void invoices (deal fell through)
    // are excluded entirely. `deal_flow_stage` is carried so we can also compute a
    // committed-only total for the dashboard hero without changing the view total.
    let mut stmt = conn.prepare(
        "SELECT i.id, i.number, i.deal_flow_id, i.client_id, COALESCE(c.name,'(unknown)'), COALESCE(i.due_date,''), i.total, COALESCE(i.deal_flow_stage,'none')
         FROM invoices i LEFT JOIN clients c ON c.id=i.client_id
         WHERE i.status IN ('sent','overdue') AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?,
        r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, f64>(6)?,
        r.get::<_, String>(7)?,
    ))).map_err(|e| e.to_string())?;

    let today = Utc::now().date_naive();
    // AR committed = everything except the speculative `invoiced` deal-flow quote.
    // Standalone invoices (`none`) are real bills and count (mirrors COMMITTED_AR_STAGES).
    let committed_stages = ["none", "supplier_paid", "payment_received", "complete"];
    // client_id -> (name, [current,1-30,31-60,61-90,90+], oldest_days)
    let mut map: std::collections::HashMap<String, (String, [f64; 5], i64)> = std::collections::HashMap::new();
    let mut items: Vec<Value> = Vec::new();
    let mut tot = [0f64; 5];
    let mut due_soon = 0f64; // open invoices coming due within the next 7 days
    let mut committed_total = 0f64; // dashboard hero: only committed deals count
    let mut count = 0i64;
    for (inv_id, inv_number, deal_flow_id, cid, cname, due, amt, df_stage) in rows.filter_map(|x| x.ok()) {
        let days = chrono::NaiveDate::parse_from_str(&due, "%Y-%m-%d")
            .map(|d| (today - d).num_days())
            .unwrap_or(0);
        if days >= -7 && days <= 0 { due_soon += amt; }
        if committed_stages.contains(&df_stage.as_str()) { committed_total += amt; }
        let idx = if days <= 0 { 0 } else if days <= 30 { 1 } else if days <= 60 { 2 } else if days <= 90 { 3 } else { 4 };
        let bucket = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"][idx];
        items.push(json!({
            "invoice_id": inv_id, "invoice_number": inv_number, "deal_flow_id": deal_flow_id,
            "client_id": cid, "client_name": cname, "amount": amt,
            "due_date": if due.is_empty() { Value::Null } else { json!(due) },
            "days_overdue": days.max(0), "bucket": bucket,
            // Committed = deal past the speculative start. The detailed VIEW defaults
            // to committed-only with a toggle to reveal speculative (early) invoices.
            "committed": committed_stages.contains(&df_stage.as_str()),
            "deal_flow_stage": df_stage,
        }));
        let e = map.entry(cid).or_insert((cname, [0.0; 5], 0));
        e.1[idx] += amt;
        if days > e.2 { e.2 = days; }
        tot[idx] += amt;
        count += 1;
    }
    let mut by_client: Vec<Value> = map.into_iter().map(|(cid, (name, b, oldest))| {
        json!({
            "client_id": cid, "client_name": name,
            "current": b[0], "d1_30": b[1], "d31_60": b[2], "d61_90": b[3], "d90_plus": b[4],
            "total": b.iter().sum::<f64>(), "oldest_days": oldest,
        })
    }).collect();
    by_client.sort_by(|a, b| b["total"].as_f64().unwrap_or(0.0).partial_cmp(&a["total"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = tot.iter().sum();
    let summary = json!({
        "current": tot[0], "d1_30": tot[1], "d31_60": tot[2], "d61_90": tot[3], "d90_plus": tot[4],
        // `total` = everything open (the VIEW). `committed_total` = only committed
        // deals (dashboard hero — speculative early invoices excluded).
        "total": total, "committed_total": committed_total, "open_count": count, "due_soon": due_soon,
    });
    Ok(json!({
        "summary": summary,
        "by_client": by_client.clone(),
        "items": items,
        // Legacy aggregate fields (kept so nothing regresses).
        "clients": by_client,
        "current": tot[0], "d1_30": tot[1], "d31_60": tot[2], "d61_90": tot[3], "d90_plus": tot[4],
        "total": total, "open_count": count, "due_soon": due_soon,
    }))
}

/// Accounts-payable aging: unpaid cost lines (paid=false) on active deals, grouped by
/// payee, aged by days since the deal was funded (payment_received_at, else created_at).
/// Includes freight/wire fees — real outgoing obligations. No supplier due-date yet
/// (wire-based, paid promptly); explicit Net-terms is a later refinement.
#[tauri::command]
pub async fn get_payables_aging() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT json_extract(sp.value,'$.supplier_name') AS payee, \
                CAST(json_extract(sp.value,'$.amount') AS REAL) AS amount, \
                COALESCE(NULLIF(df.payment_received_at,''), df.created_at) AS anchor, \
                df.id AS deal_flow_id, df.invoice_id AS invoice_id, \
                i.number AS invoice_number, i.client_id AS client_id, c.name AS client_name, \
                json_extract(sp.value,'$.id') AS payment_id, df.stage AS df_stage \
         FROM deal_flows df \
         JOIN json_each(COALESCE(NULLIF(df.supplier_payments_json,''),'[]')) sp \
         LEFT JOIN invoices i ON i.id = df.invoice_id \
         LEFT JOIN clients c ON c.id = i.client_id \
         WHERE df.stage != 'complete' AND COALESCE(df.archived,0)=0 \
           AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
           AND COALESCE(json_extract(sp.value,'$.paid'),0)=0 \
           AND json_extract(sp.value,'$.supplier_name') IS NOT NULL",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((
        r.get::<_, Option<String>>(0)?.unwrap_or_default(),
        r.get::<_, f64>(1)?,
        r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        r.get::<_, String>(3)?,
        r.get::<_, Option<String>>(4)?,
        r.get::<_, Option<String>>(5)?,
        r.get::<_, Option<String>>(6)?,
        r.get::<_, Option<String>>(7)?,
        r.get::<_, Option<String>>(8)?,
        r.get::<_, Option<String>>(9)?.unwrap_or_default(),
    ))).map_err(|e| e.to_string())?;

    let today = Utc::now().date_naive();
    // Committed = deal past the speculative start (mirrors COMMITTED_DEAL_STAGES).
    let committed_stages = ["supplier_paid", "payment_received", "complete"];
    // payee -> ([≤30,31-60,61-90,90+], oldest_days)
    let mut map: std::collections::HashMap<String, ([f64; 4], i64)> = std::collections::HashMap::new();
    let mut items: Vec<Value> = Vec::new();
    let mut tot = [0f64; 4];
    let mut committed_total = 0f64; // dashboard hero: only committed deals count
    let mut count = 0i64;
    for (payee, amount, anchor, deal_flow_id, invoice_id, invoice_number, client_id, client_name, payment_id, df_stage) in rows.filter_map(|x| x.ok()) {
        if committed_stages.contains(&df_stage.as_str()) { committed_total += amount; }
        let days = chrono::NaiveDate::parse_from_str(anchor.get(0..10).unwrap_or(""), "%Y-%m-%d")
            .map(|d| (today - d).num_days())
            .unwrap_or(0);
        let idx = if days <= 30 { 0 } else if days <= 60 { 1 } else if days <= 90 { 2 } else { 3 };
        let bucket = ["d0_30", "d31_60", "d61_90", "d90_plus"][idx];
        items.push(json!({
            "deal_flow_id": deal_flow_id, "invoice_id": invoice_id, "invoice_number": invoice_number,
            "payment_id": payment_id,
            "payee": payee, "amount": amount, "client_id": client_id, "client_name": client_name,
            "anchor_date": if anchor.is_empty() { Value::Null } else { json!(anchor) },
            "days": days, "bucket": bucket,
            // Committed = deal past the speculative start. The detailed VIEW defaults
            // to committed-only with a toggle to reveal speculative (early) payables.
            "committed": committed_stages.contains(&df_stage.as_str()),
            "deal_flow_stage": df_stage,
        }));
        let e = map.entry(payee).or_insert(([0.0; 4], 0));
        e.0[idx] += amount;
        if days > e.1 { e.1 = days; }
        tot[idx] += amount;
        count += 1;
    }
    let mut by_payee: Vec<Value> = map.into_iter().map(|(name, (b, oldest))| {
        json!({
            "payee": name,
            "d0_30": b[0], "d31_60": b[1], "d61_90": b[2], "d90_plus": b[3],
            "total": b.iter().sum::<f64>(), "oldest_days": oldest,
        })
    }).collect();
    by_payee.sort_by(|a, b| b["total"].as_f64().unwrap_or(0.0).partial_cmp(&a["total"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = tot.iter().sum();
    let summary = json!({
        "d0_30": tot[0], "d31_60": tot[1], "d61_90": tot[2], "d90_plus": tot[3],
        // `total` = everything owed (the VIEW). `committed_total` = only committed
        // deals (dashboard hero — speculative early payables excluded).
        "total": total, "committed_total": committed_total, "open_count": count,
    });
    Ok(json!({
        "summary": summary,
        "by_payee": by_payee.clone(),
        "items": items,
        // Legacy aggregate fields (kept so nothing regresses).
        "suppliers": by_payee,
        "d0_30": tot[0], "d31_60": tot[1], "d61_90": tot[2], "d90_plus": tot[3],
        "total": total, "committed_total": committed_total, "open_count": count,
    }))
}

/// Return analytics data filtered to [start_date, end_date] (YYYY-MM-DD).
/// Empty strings mean "no bound" (all-time).
#[tauri::command]
pub async fn get_analytics_range(start_date: String, end_date: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    // Every aggregate obeys the accuracy contract: archived flows out, fell-through
    // (voided/archived invoice) out, refunds off the profit, dates parameterized
    // (empty string = unbounded). Duplicate flow rows are archived by the ghost
    // cleanup, so plain SUMs over live rows are safe; counts still dedupe by invoice.
    const DF: &str =
        "FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id \
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 \
           AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0 \
           AND (?1='' OR date(df.completed_at) >= ?1) AND (?2='' OR date(df.completed_at) <= ?2)";
    const NP: &str = "(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0))";
    let p = rusqlite::params![start_date, end_date];

    let (total_revenue, total_cost, net_profit): (f64, f64, f64) = conn.query_row(
        &format!("SELECT COALESCE(SUM(df.gross_revenue),0), COALESCE(SUM(df.total_cost),0), COALESCE(SUM({NP}),0) {DF}"),
        p, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    ).unwrap_or((0.0, 0.0, 0.0));
    // Volume-weighted blended margin — a $100 deal at 90% can't offset a $100k deal at 5%.
    let avg_margin: f64 = if total_revenue > 0.0 { (net_profit / total_revenue) * 100.0 } else { 0.0 };
    let deal_count: i64 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT df.invoice_id) {DF}"),
        p, |r| r.get(0)
    ).unwrap_or(0);

    // Deals lost (fell through) + refunds inside the same window, for the win-rate
    // and refund cards. Lost is bounded by voided_at (historical voids without a
    // stamp only show in all-time).
    let deals_lost: i64 = conn.query_row(
        "SELECT COUNT(*) FROM invoices WHERE COALESCE(voided,0)=1 AND COALESCE(archived,0)=0 \
           AND (?1='' OR (voided_at IS NOT NULL AND date(voided_at) >= ?1)) \
           AND (?2='' OR voided_at IS NULL OR date(voided_at) <= ?2)",
        p, |r| r.get(0)
    ).unwrap_or(0);
    let refunded_in_range: f64 = conn.query_row(
        "SELECT COALESCE((SELECT SUM(amount) FROM refunds WHERE COALESCE(bank_txn_id,'')='' \
                           AND (?1='' OR date(created_at) >= ?1) AND (?2='' OR date(created_at) <= ?2)),0) \
              + COALESCE((SELECT SUM(amount) FROM bank_allocation WHERE role='refund_out' \
                           AND (?1='' OR date(created_at) >= ?1) AND (?2='' OR date(created_at) <= ?2)),0)",
        p, |r| r.get(0)
    ).unwrap_or(0.0);

    // Monthly buckets for the bar chart (refund-aware profit)
    let monthly: Vec<Value> = {
        let mut stmt = conn.prepare(
            &format!("SELECT strftime('%Y-%m', df.completed_at) as m, COALESCE(SUM(df.gross_revenue),0), \
                             COALESCE(SUM(df.total_cost),0), COALESCE(SUM({NP}),0) {DF} GROUP BY m ORDER BY m")
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, |r| Ok(json!({
            "month": r.get::<_,String>(0)?, "revenue": r.get::<_,f64>(1)?,
            "cost":  r.get::<_,f64>(2)?,   "profit":  r.get::<_,f64>(3)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Top clients by refund-aware profit in range
    let top_clients: Vec<Value> = {
        let mut stmt = conn.prepare(
            &format!("SELECT c.name, COALESCE(SUM(df.gross_revenue),0), COALESCE(SUM({NP}),0), \
                    CASE WHEN COALESCE(SUM(df.gross_revenue),0)>0 THEN (COALESCE(SUM({NP}),0)/SUM(df.gross_revenue))*100 ELSE 0 END \
             {DF_JOIN} GROUP BY i.client_id, c.name ORDER BY SUM({NP}) DESC LIMIT 5",
             DF_JOIN = DF.replacen("JOIN invoices i ON i.id=df.invoice_id",
                                   "JOIN invoices i ON i.id=df.invoice_id JOIN clients c ON c.id=i.client_id", 1))
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, |r| Ok(json!({
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
        "deals_lost": deals_lost,
        "refunded_in_range": refunded_in_range,
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
    pub quotes_sent: u32,
    pub quotes_won: u32,
    pub reliability: String,
    pub reliability_pct: f64,
}

fn tier_label(s: &str) -> &str {
    match s { "S" => "Diamond", "A" => "Gold", "B" => "Silver", "C" => "Bronze", _ => "Prospect" }
}

#[tauri::command]
pub async fn buyer_tiers() -> Result<Vec<BuyerTier>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;

    // "Sent" always includes overdue — an invoice going overdue can't erase the
    // fact it was sent, and dropping it here could demote a client a full tier.
    let invoice_data: Vec<(String, f64, u32, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT client_id, COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END),0),
                    COUNT(CASE WHEN status IN ('sent','overdue','paid') THEN 1 END),
                    MAX(CASE WHEN status IN ('sent','overdue','paid') THEN issue_date END)
             FROM invoices WHERE COALESCE(voided,0)=0 AND COALESCE(archived,0)=0 GROUP BY client_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_,i64>(2)? as u32, r.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let invoice_map: std::collections::HashMap<String, (f64, u32, Option<String>)> =
        invoice_data.into_iter().map(|(id, p, s, d)| (id, (p, s, d))).collect();
    let refunded_map = refunded_by_client(&conn);

    // Quotes per client: (total sent, accepted/converted). Used for engagement
    // signal AND buyer-reliability scoring (how often quotes turn into deals).
    let quotes_map: std::collections::HashMap<String, (u32, u32)> = {
        let mut stmt = conn.prepare(
            "SELECT client_id,
                    COUNT(*),
                    COUNT(CASE WHEN status='accepted' THEN 1 END)
             FROM quotes WHERE status IN ('sent','accepted','declined','expired') GROUP BY client_id"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, (r.get::<_,i64>(1)? as u32, r.get::<_,i64>(2)? as u32))))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let client_rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, name, metadata FROM clients ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_,Option<String>>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Avg commission % (margin) per client from completed deal flows — same
    // accuracy contract as every other stat: archived deals, fell-through (voided
    // invoice) deals, and archived invoices are excluded so they can't skew margin.
    let commission_map: std::collections::HashMap<String, f64> = {
        let mut stmt = conn.prepare(
            "SELECT i.client_id,
                    COALESCE(AVG(CASE WHEN df.gross_revenue > 0 THEN (df.net_profit / df.gross_revenue) * 100 END), 0)
             FROM deal_flows df
             JOIN invoices i ON i.id = df.invoice_id
             WHERE df.stage = 'complete' AND COALESCE(df.archived,0)=0
               AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0
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

        let (paid, invoices_sent, last_inv) = invoice_map.get(client_id)
            .map(|(p, s, d)| (*p, *s, d.clone())).unwrap_or((0.0, 0, None));
        // Net of refunds — a fully refunded buyer can't hold a tier on money we
        // gave back. This becomes the "actually paid" figure shown in the UI.
        let actual_paid = (paid - refunded_map.get(client_id).copied().unwrap_or(0.0)).max(0.0);
        let (quotes_sent, quotes_won) = quotes_map.get(client_id).copied().unwrap_or((0, 0));
        // Buyer reliability: of the quotes we've sent, how many converted to a
        // deal. Only meaningful once we've sent a few — flagged after 3.
        let reliability_pct = if quotes_sent > 0 { (quotes_won as f64 / quotes_sent as f64) * 100.0 } else { 0.0 };
        let reliability = if quotes_sent < 3 { "unrated" }
            else if reliability_pct >= 50.0 { "reliable" }
            else if reliability_pct >= 25.0 { "mixed" }
            else { "low" };

        let tier = tier_for(effective_annual, actual_paid, invoices_sent as i64, quotes_sent as i64);

        let avg_commission_pct = commission_map.get(client_id).copied().unwrap_or(0.0);
        results.push(BuyerTier {
            client_id: client_id.clone(), client_name: client_name.clone(), tier: tier.into(),
            effective_annual, spend_per_frequency: if spend_raw != "0" && !spend_raw.is_empty() { Some(spend_raw.to_string()) } else { None },
            actual_paid, invoices_sent, last_invoice_date: last_inv,
            purchase_frequency: frequency.map(|s| s.to_string()),
            avg_commission_pct,
            quotes_sent,
            quotes_won,
            reliability: reliability.to_string(),
            reliability_pct,
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

/// One configured payout recipient's cut across the brief's periods. The whole
/// list is empty when the org has not set up a payout split, so the UI shows no
/// breakdown (never an assumed split or partner names).
#[derive(Serialize, Debug, Clone)]
pub struct PayoutTotal {
    pub name: String,
    pub is_business: bool,
    pub this_week: f64,
    pub this_month: f64,
    pub all_time: f64,
}

#[derive(Serialize, Debug, Clone)]
pub struct MonthStat {
    pub month: String,       // "YYYY-MM"
    pub count: u32,
    pub revenue: f64,
    pub net_profit: f64,     // refund-aware
    pub margin_pct: f64,
}

#[derive(Serialize, Debug, Clone)]
pub struct WeeklyBrief {
    pub generated_at: String,
    pub week_start: String,
    pub week_end: String,
    /// Explicit margins per bucket (weighted, refund-aware): current period / calendar
    /// month / all-time. `revenue_*` are their denominators for context.
    pub avg_margin_this_month: f64,
    pub avg_margin_all_time: f64,
    pub revenue_this_month: f64,
    pub revenue_all_time: f64,
    /// All-time per-calendar-month history (every month you closed deals).
    pub monthly_breakdown: Vec<MonthStat>,
    pub revenue_this_week: f64,
    pub revenue_last_week: f64,
    pub revenue_change_pct: f64,
    pub profit_this_week: f64,
    pub profit_last_week: f64,
    pub profit_change_pct: f64,
    pub avg_margin_this_week: f64,
    pub deals_closed_this_week: u32,
    pub deals_lost_this_week: u32,
    pub win_rate_this_week: f64,
    pub overdue_invoices_count: u32,
    pub overdue_invoices_value: f64,
    pub follow_ups_due: u32,
    pub best_margin_deal: Option<DealHighlight>,
    pub worst_margin_deal: Option<DealHighlight>,
    pub biggest_invoice: Option<InvoiceHighlight>,
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
    pub refunded_deals_this_week: u32,
    pub refunded_total_this_week: f64,
    pub rep_earnings_this_week: f64,
    /// Config-driven payout split per recipient; empty when payouts aren't set up.
    pub payout_totals: Vec<PayoutTotal>,
}

#[tauri::command]
pub async fn generate_weekly_brief(for_date: Option<String>, rep_name: Option<String>) -> Result<WeeklyBrief, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now();

    // If rep_name is set, filter deal_flow queries to only include deals where the client has source_rep matching
    let rep_join = rep_name.as_ref().map(|_| "JOIN invoices i ON i.id=df.invoice_id JOIN clients c ON c.id=i.client_id").unwrap_or("");
    let rep_filter = rep_name.as_ref().map(|r| { let e = r.replace('\'', "''"); format!(" AND (json_extract(c.metadata,'$.lead_representative')='{e}' OR json_extract(c.metadata,'$.source_rep')='{e}')") }).unwrap_or_default();

    // Use caller-supplied date or today to anchor the week
    let anchor: chrono::NaiveDate = match for_date.as_deref() {
        Some(d) if !d.is_empty() => d.parse().unwrap_or_else(|_| Utc::now().date_naive()),
        _ => Utc::now().date_naive(),
    };
    let now_date = anchor;

    // Brief period length is user-configurable (default weekly). The window is a
    // rolling `period_days`-day span ending on the anchor day (inclusive).
    let period_days: i64 = conn
        .query_row("SELECT value FROM settings WHERE key='brief_frequency_days'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| *d >= 1)
        .unwrap_or(7);

    // Calendar-aligned windows (per Jack): weeks are Monday–Sunday, months 1st–last.
    // period_days>=28 → the current CALENDAR MONTH; otherwise N whole calendar weeks
    // (7 → this week Mon–Sun, 14 → this + previous week). "Last period" is the equal-
    // length window immediately before. Upper bounds are exclusive (start of next).
    use chrono::Datelike;
    let (ws_date, end_excl_date, lws_date) = if period_days >= 28 {
        let first = now_date.with_day(1).unwrap_or(now_date);
        let next_first = (if first.month() == 12 { chrono::NaiveDate::from_ymd_opt(first.year() + 1, 1, 1) }
                          else { chrono::NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1) }).unwrap_or(first);
        let prev_first = (if first.month() == 1 { chrono::NaiveDate::from_ymd_opt(first.year() - 1, 12, 1) }
                          else { chrono::NaiveDate::from_ymd_opt(first.year(), first.month() - 1, 1) }).unwrap_or(first);
        (first, next_first, prev_first)
    } else {
        let weeks = (period_days / 7).max(1);
        let this_monday = now_date - chrono::Duration::days(now_date.weekday().num_days_from_monday() as i64);
        let start = this_monday - chrono::Duration::days(7 * (weeks - 1));
        let end_excl = this_monday + chrono::Duration::days(7);
        let last_start = start - chrono::Duration::days(7 * weeks);
        (start, end_excl, last_start)
    };
    let week_start = ws_date.format("%Y-%m-%d").to_string();
    let end_excl = end_excl_date.format("%Y-%m-%d").to_string();
    let week_end = (end_excl_date - chrono::Duration::days(1)).format("%Y-%m-%d").to_string(); // inclusive last day (display)
    let last_week_start = lws_date.format("%Y-%m-%d").to_string();
    let last_week_end = week_start.clone();
    let _ = &last_week_end;

    // Data-accuracy guards shared by every deal_flow stat below:
    // - `live` keeps archived (soft-deleted) deals AND fell-through deals (voided
    //   or archived invoice) out of all stats — a completed deal that later fell
    //   through must not keep counting as won revenue.
    // - `np` is refund-aware net profit — a deal's refunds come straight off its
    //   profit (locked P&L rule: refunds reduce profit), so a refunded deal can't
    //   keep inflating the brief.
    let live = " AND COALESCE(df.archived,0)=0 AND NOT EXISTS (SELECT 1 FROM invoices iv \
                 WHERE iv.id=df.invoice_id AND (COALESCE(iv.voided,0)=1 OR COALESCE(iv.archived,0)=1))";
    let np = "(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0))";

    let revenue_this_week: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| r.get(0)
    ).unwrap_or(0.0);
    let revenue_last_week: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);
    let profit_this_week: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM({np}),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| r.get(0)
    ).unwrap_or(0.0);
    let profit_last_week: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM({np}),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);
    // Weighted, refund-aware margin (SUM(np)/SUM(revenue)) — consistent with the
    // best/worst-margin cards, unlike the old unweighted AVG(net/rev).
    let margin_q = |from: &str| -> String {
        format!("SELECT COALESCE(SUM({np}) / NULLIF(SUM(gross_revenue),0) * 100, 0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{from}{rep_filter}")
    };
    let rev_q = |from: &str| -> String {
        format!("SELECT COALESCE(SUM(gross_revenue),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{from}{rep_filter}")
    };
    let avg_margin_this_week: f64 = conn.query_row(
        &margin_q(" AND df.completed_at >= ?1 AND df.completed_at < ?2"), [&week_start, &end_excl], |r| r.get(0)
    ).unwrap_or(0.0);

    let month_start = format!("{}-01", now.format("%Y-%m"));

    // Explicit margins per bucket (Jack's ask): calendar month + all-time.
    let avg_margin_this_month: f64 = conn.query_row(&margin_q(" AND df.completed_at >= ?1"), [&month_start], |r| r.get(0)).unwrap_or(0.0);
    let avg_margin_all_time: f64  = conn.query_row(&margin_q(""), [], |r| r.get(0)).unwrap_or(0.0);
    let revenue_this_month: f64   = conn.query_row(&rev_q(" AND df.completed_at >= ?1"), [&month_start], |r| r.get(0)).unwrap_or(0.0);
    let revenue_all_time: f64     = conn.query_row(&rev_q(""), [], |r| r.get(0)).unwrap_or(0.0);

    // All-time per-calendar-month history — fixes the Brief only ever showing the
    // two rolling windows. Every month with a completed deal appears.
    let monthly_breakdown: Vec<MonthStat> = {
        let sql = format!(
            "SELECT strftime('%Y-%m', df.completed_at) AS m, COUNT(*), COALESCE(SUM(gross_revenue),0), COALESCE(SUM({np}),0) \
             FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{rep_filter} GROUP BY m ORDER BY m");
        conn.prepare(&sql).ok().and_then(|mut stmt| {
            stmt.query_map([], |r| {
                let rev: f64 = r.get(2)?; let net: f64 = r.get(3)?;
                Ok(MonthStat { month: r.get(0)?, count: r.get::<_, i64>(1)? as u32, revenue: rev, net_profit: net,
                    margin_pct: if rev > 0.0 { net / rev * 100.0 } else { 0.0 } })
            }).map(|rows| rows.filter_map(|r| r.ok()).collect()).ok()
        }).unwrap_or_default()
    };

    struct DfProfit { count: u32, net_profit: f64, jack: f64, ben: f64, business: f64, loss_count: u32, loss_total: f64 }
    let df_this_week: DfProfit = conn.query_row(
        &format!("SELECT COUNT(*) as count, COALESCE(SUM({np}),0), COALESCE(SUM(profit_jack),0), COALESCE(SUM(profit_ben),0), COALESCE(SUM(profit_business),0), COUNT(CASE WHEN net_profit < 0 THEN 1 END), COALESCE(SUM(CASE WHEN net_profit < 0 THEN net_profit ELSE 0 END),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl],
        |r| Ok(DfProfit { count: r.get::<_,i64>(0).unwrap_or(0) as u32, net_profit: r.get(1)?, jack: r.get(2)?, ben: r.get(3)?, business: r.get(4)?, loss_count: r.get::<_,i64>(5).unwrap_or(0) as u32, loss_total: r.get(6)? })
    ).unwrap_or(DfProfit { count: 0, net_profit: 0.0, jack: 0.0, ben: 0.0, business: 0.0, loss_count: 0, loss_total: 0.0 });

    let df_last_week_count: u32 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT df.invoice_id) FROM deal_flows df WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2"),
        [&last_week_start, &week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let df_last_week_profit: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM({np}),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&last_week_start, &week_start], |r| r.get(0)
    ).unwrap_or(0.0);

    let df_mtd: DfProfit = conn.query_row(
        &format!("SELECT COUNT(*), COALESCE(SUM({np}),0), COALESCE(SUM(profit_jack),0), COALESCE(SUM(profit_ben),0), COALESCE(SUM(profit_business),0), 0, 0 FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1{rep_filter}"),
        [&month_start],
        |r| Ok(DfProfit { count: r.get::<_,i64>(0).unwrap_or(0) as u32, net_profit: r.get(1)?, jack: r.get(2)?, ben: r.get(3)?, business: r.get(4)?, loss_count: 0, loss_total: 0.0 })
    ).unwrap_or(DfProfit { count: 0, net_profit: 0.0, jack: 0.0, ben: 0.0, business: 0.0, loss_count: 0, loss_total: 0.0 });

    let df_all_jack: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(profit_jack),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{rep_filter}"), [], |r| r.get(0)
    ).unwrap_or(0.0);
    let df_all_ben: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(profit_ben),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{rep_filter}"), [], |r| r.get(0)
    ).unwrap_or(0.0);
    let df_all_biz: f64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(profit_business),0) FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{rep_filter}"), [], |r| r.get(0)
    ).unwrap_or(0.0);

    // Config-driven payout breakdown: split net profit across the org's configured
    // recipients (empty when unconfigured). Included vs. excluded net is bucketed by
    // each completed deal's payout_included flag (default false → business keeps all).
    let net_incl = format!("COALESCE(SUM(CASE WHEN COALESCE(json_extract(df.metadata,'$.payout_included'),0)=1 THEN {np} ELSE 0 END),0)");
    let net_excl = format!("COALESCE(SUM(CASE WHEN COALESCE(json_extract(df.metadata,'$.payout_included'),0)=1 THEN 0 ELSE {np} END),0)");
    let split_week: (f64, f64) = conn.query_row(
        &format!("SELECT {net_incl}, {net_excl} FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap_or((0.0, 0.0));
    let split_month: (f64, f64) = conn.query_row(
        &format!("SELECT {net_incl}, {net_excl} FROM deal_flows df {rep_join} WHERE df.stage='complete'{live} AND df.completed_at >= ?1{rep_filter}"),
        [&month_start], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap_or((0.0, 0.0));
    let split_all: (f64, f64) = conn.query_row(
        &format!("SELECT {net_incl}, {net_excl} FROM deal_flows df {rep_join} WHERE df.stage='complete'{live}{rep_filter}"),
        [], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap_or((0.0, 0.0));
    let payout_recipients = read_profit_split_shares();
    let alloc_week = allocate_payout(split_week.0, split_week.1, &payout_recipients);
    let alloc_month = allocate_payout(split_month.0, split_month.1, &payout_recipients);
    let alloc_all = allocate_payout(split_all.0, split_all.1, &payout_recipients);
    let payout_totals: Vec<PayoutTotal> = payout_recipients.iter().enumerate().map(|(i, (name, _pct, is_biz))| PayoutTotal {
        name: name.clone(),
        is_business: *is_biz,
        this_week: alloc_week.get(i).map(|x| x.2).unwrap_or(0.0),
        this_month: alloc_month.get(i).map(|x| x.2).unwrap_or(0.0),
        all_time: alloc_all.get(i).map(|x| x.2).unwrap_or(0.0),
    }).collect();

    // Closed/lost come from the REAL pipeline (deal_flows + voided invoices), not
    // the standalone deals CRM table — that table's won_at/lost_at are never set by
    // the invoice→deal-flow workflow, which left these stats permanently at zero.
    // Closed = live deal flows completed in the window (distinct invoices, so
    // duplicate flow rows can't inflate it; `live` keeps a completed-then-fell-
    // through deal from counting as both). Lost = invoices voided (deal fell
    // through) in the window, via the voided_at stamp. Both honor the rep scope,
    // so a rep's brief shows their own win rate, not the org's.
    let deals_closed: u32 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT df.invoice_id) FROM deal_flows df {rep_join} \
         WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let lost_join = if rep_name.is_some() { "JOIN clients c ON c.id=i.client_id" } else { "" };
    let deals_lost: u32 = conn.query_row(
        &format!("SELECT COUNT(*) FROM invoices i {lost_join} \
         WHERE COALESCE(i.voided,0)=1 AND COALESCE(i.archived,0)=0 AND i.voided_at >= ?1 AND i.voided_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let win_rate = if deals_closed + deals_lost > 0 { (deals_closed as f64 / (deals_closed + deals_lost) as f64) * 100.0 } else { 0.0 };

    let overdue_invoices_count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM invoices WHERE status='sent' AND due_date < date('now')", [], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;
    let overdue_invoices_value: f64 = conn.query_row(
        "SELECT COALESCE(SUM(total),0) FROM invoices WHERE status='sent' AND due_date < date('now')", [], |r| r.get(0)
    ).unwrap_or(0.0);

    let follow_ups: Vec<Client> = due_followups().await?;
    let follow_ups_due = follow_ups.len() as u32;

    // Best/worst margin come from the REAL pipeline (completed deal_flows in the
    // window, refund-aware, rep-scoped), not the dead deals CRM table's won_at —
    // which is never written, so these cards used to never render.
    let margin_deal = |order: &str| -> Option<DealHighlight> {
        let sql = format!(
            "SELECT df.id, c.name, COALESCE(NULLIF(i.number,''), c.name), df.gross_revenue, \
                    CASE WHEN df.gross_revenue>0 THEN \
                      (df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0))/df.gross_revenue*100 \
                    ELSE 0 END as margin \
             FROM deal_flows df JOIN invoices i ON i.id=df.invoice_id JOIN clients c ON c.id=i.client_id \
             WHERE df.stage='complete'{live} AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter} \
             ORDER BY margin {order} LIMIT 1");
        let mut stmt = conn.prepare(&sql).ok()?;
        stmt.query_row([&week_start, &end_excl], |r| Ok(DealHighlight {
            deal_id: r.get(0)?, client_name: r.get(1)?, title: r.get(2)?,
            asking_price: r.get(3)?, margin_pct: r.get(4)?,
        })).ok()
    };
    let best_margin_deal = margin_deal("DESC");
    let worst_margin_deal = margin_deal("ASC");

    let biggest_invoice: Option<InvoiceHighlight> = {
        let mut stmt = conn.prepare(
            "SELECT i.id, c.name, i.number, i.total FROM invoices i JOIN clients c ON c.id=i.client_id
             WHERE i.status='paid' AND COALESCE(i.voided,0)=0 AND COALESCE(i.archived,0)=0
               AND i.issue_date >= ?1 AND i.issue_date < ?2 ORDER BY i.total DESC LIMIT 1"
        ).map_err(|e| e.to_string())?;
        stmt.query_row([&week_start, &end_excl], |r| Ok(InvoiceHighlight {
            invoice_id: r.get(0)?, client_name: r.get(1)?, number: r.get(2)?, total: r.get(3)?,
        })).ok()
    };

    let new_clients_this_week: u32 = conn.query_row(
        "SELECT COUNT(*) FROM clients WHERE created_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;

    let interactions_this_week: u32 = conn.query_row(
        "SELECT COUNT(*) FROM interactions WHERE created_at >= ?1", [&week_start], |r| r.get::<_,i64>(0)
    ).unwrap_or(0) as u32;

    // Refunds on deals completed in the period (rep-filtered) — "deals that fell through".
    let (refunded_deals_this_week, refunded_total_this_week): (u32, f64) = conn.query_row(
        &format!("SELECT COUNT(DISTINCT rf.deal_flow_id), COALESCE(SUM(rf.amount),0) FROM refunds rf JOIN deal_flows df ON df.id=rf.deal_flow_id {rep_join} WHERE COALESCE(df.archived,0)=0 AND df.completed_at >= ?1 AND df.completed_at < ?2{rep_filter}"),
        [&week_start, &end_excl], |r| Ok((r.get::<_,i64>(0)? as u32, r.get::<_,f64>(1)?))
    ).unwrap_or((0, 0.0));

    // Rep earnings (their cut) for the period — only when viewing a specific rep and
    // rep payouts are on. Maps the rep name to their staff pay config, then sums the
    // refund-aware cut over deals where they're the assigned lead (deal_reps).
    let rep_earnings_this_week: f64 = if rep_name.is_some() && setting_bool("rep_payouts_enabled") {
        let rn = rep_name.as_ref().unwrap();
        let staff: Option<(String, f64, String, i64)> = conn.query_row(
            "SELECT id, COALESCE(commission_pct,0), COALESCE(pay_type,'profit_pct'), COALESCE(hide_pay_cuts,0) FROM staff_accounts WHERE display_name=?1 AND status='active' LIMIT 1",
            [rn], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        ).ok();
        match staff {
            Some((sid, pct, pt, hide)) if hide == 0 => {
                let mut stmt = conn.prepare(
                    "SELECT COALESCE(df.net_profit,0), COALESCE(df.gross_revenue,0),
                            (SELECT COALESCE(SUM(amount),0) FROM refunds rf WHERE rf.deal_flow_id=df.id),
                            (SELECT COALESCE(MAX(keep_rep_cut),0) FROM refunds rf WHERE rf.deal_flow_id=df.id)
                     FROM deal_flows df JOIN deal_reps dr ON dr.deal_flow_id=df.id
                     WHERE dr.lead_rep_id=?1 AND df.stage='complete' AND df.completed_at >= ?2 AND df.completed_at < ?3"
                ).map_err(|e| e.to_string())?;
                let rows: Vec<(f64, f64, f64, i64)> = stmt
                    .query_map(rusqlite::params![sid, week_start, end_excl], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(|x| x.ok())
                    .collect();
                rows.iter().map(|(net, gross, refunded, keep)| {
                    if *keep != 0 { rep_cut(&pt, pct, *gross, *net) } else { rep_cut_after_refund(&pt, pct, gross - refunded, net - refunded) }
                }).sum()
            }
            _ => 0.0,
        }
    } else { 0.0 };

    Ok(WeeklyBrief {
        generated_at: now.to_rfc3339(),
        week_start: week_start.clone(),
        week_end,
        avg_margin_this_month,
        avg_margin_all_time,
        revenue_this_month,
        revenue_all_time,
        monthly_breakdown,
        revenue_this_week,
        revenue_last_week,
        revenue_change_pct: if revenue_last_week > 0.0 { ((revenue_this_week - revenue_last_week) / revenue_last_week) * 100.0 } else { 0.0 },
        profit_this_week,
        profit_last_week,
        profit_change_pct: if profit_last_week > 0.0 { ((profit_this_week - profit_last_week) / profit_last_week) * 100.0 } else { 0.0 },
        avg_margin_this_week,
        deals_closed_this_week: deals_closed,
        deals_lost_this_week: deals_lost,
        win_rate_this_week: win_rate,
        overdue_invoices_count,
        overdue_invoices_value,
        follow_ups_due,
        best_margin_deal,
        worst_margin_deal,
        biggest_invoice,
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
        refunded_deals_this_week,
        refunded_total_this_week,
        rep_earnings_this_week,
        payout_totals,
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

/// Tables carrying a `client_id` (all keyed by `id`) that must be REASSIGNED — not
/// orphaned or cascade-deleted — when two clients are merged.
const CLIENT_CHILD_TABLES: &[&str] = &[
    "interactions", "invoices", "email_drafts", "newsletter_sends", "deals",
    "followup_log", "client_portal_tokens", "recurring_invoices", "tier_history",
    "quotes", "checkup_items", "refunds", "client_credits",
];

/// Merge `loser` into `keeper`: backfill the keeper's empty contact fields from the
/// loser, reassign every child row to the keeper, then delete the loser — recording
/// EVERY change to sync so other devices converge. Sequential (no wrapping txn) to
/// match delete_client and avoid deadlocking record_* on a second pooled connection.
///
/// Previously the merge did raw DELETEs with no sync record (the deleted client
/// resurrected on other devices) and only reassigned interactions/invoices (deals,
/// quotes, refunds, credits… were stranded on the deleted client).
fn merge_client_into(conn: &rusqlite::Connection, loser: &str, keeper: &str, now: &str) -> Result<(), String> {
    if loser == keeper { return Ok(()); }

    // 1) Backfill the keeper's empty contact fields from the loser so nothing is lost.
    if let Ok((k_email, k_phone, k_company)) = conn.query_row(
        "SELECT COALESCE(email,''), COALESCE(phone,''), COALESCE(company,'') FROM clients WHERE id=?1",
        [keeper],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
    ) {
        let (l_email, l_phone, l_company) = conn.query_row(
            "SELECT COALESCE(email,''), COALESCE(phone,''), COALESCE(company,'') FROM clients WHERE id=?1",
            [loser],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        ).unwrap_or_default();
        let mut filled = serde_json::Map::new();
        if k_email.trim().is_empty() && !l_email.trim().is_empty() {
            let _ = conn.execute("UPDATE clients SET email=?1, updated_at=?2 WHERE id=?3", rusqlite::params![l_email, now, keeper]);
            filled.insert("email".into(), Value::String(l_email));
        }
        if k_phone.trim().is_empty() && !l_phone.trim().is_empty() {
            let _ = conn.execute("UPDATE clients SET phone=?1, updated_at=?2 WHERE id=?3", rusqlite::params![l_phone, now, keeper]);
            filled.insert("phone".into(), Value::String(l_phone));
        }
        if k_company.trim().is_empty() && !l_company.trim().is_empty() {
            let _ = conn.execute("UPDATE clients SET company=?1, updated_at=?2 WHERE id=?3", rusqlite::params![l_company, now, keeper]);
            filled.insert("company".into(), Value::String(l_company));
        }
        if !filled.is_empty() {
            filled.insert("updated_at".into(), Value::String(now.to_string()));
            let _ = sync::record_upsert("clients", keeper, filled);
        }
    }

    // 2) Reassign every child row to the keeper, recording each so peers converge.
    for t in CLIENT_CHILD_TABLES {
        let ids: Vec<String> = {
            let mut stmt = match conn.prepare(&format!("SELECT id FROM {t} WHERE client_id=?1")) {
                Ok(s) => s,
                Err(_) => continue, // table absent on this build — skip
            };
            let mapped = match stmt.query_map([loser], |r| r.get::<_, String>(0)) {
                Ok(m) => m,
                Err(_) => continue,
            };
            mapped.filter_map(|r| r.ok()).collect()
        };
        if ids.is_empty() { continue; }
        conn.execute(&format!("UPDATE {t} SET client_id=?1 WHERE client_id=?2"), rusqlite::params![keeper, loser])
            .map_err(|e| e.to_string())?;
        // Broadcast the reassignment ONLY for tables peers actually apply. Emitting for
        // a non-synced table (e.g. newsletter_sends, which the server relays but the
        // desktop apply-side rejects) produces an event that stalls every peer's pull
        // loop. The local UPDATE above already keeps THIS device consistent.
        if sync::is_synced_table(t) {
            for rid in &ids {
                let mut cols = serde_json::Map::new();
                cols.insert("client_id".into(), Value::String(keeper.to_string()));
                let _ = sync::record_upsert(t, rid, cols);
            }
        }
    }

    // 3) Delete the loser and broadcast the delete (children reassigned → no FK block).
    conn.execute("DELETE FROM clients WHERE id=?1", [loser]).map_err(|e| e.to_string())?;
    sync::record_delete("clients", loser).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cleanup_clients() -> Result<CleanupResult, String> {
    // Permanently merges/removes clients — admins (or owner PIN) only.
    if !crate::employees::session_is_privileged() {
        return Err("Only an admin can run duplicate cleanup.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut duplicates_merged: u32 = 0;

    // Merge clients that share an email.
    let mut email_dups: Vec<Vec<String>> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT GROUP_CONCAT(id) FROM clients WHERE email IS NOT NULL AND email != '' GROUP BY LOWER(email) HAVING COUNT(*) > 1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            let ids: Vec<String> = r.split(',').map(|s| s.to_string()).collect();
            if ids.len() > 1 { email_dups.push(ids); }
        }
    }
    for ids in &email_dups {
        let keeper = ids[0].clone();
        for dup_id in &ids[1..] {
            match merge_client_into(&conn, dup_id, &keeper, &now) {
                Ok(()) => duplicates_merged += 1,
                Err(e) => tracing::warn!("cleanup: merge {} -> {} failed (skipped): {}", dup_id, keeper, e),
            }
        }
    }

    // Merge emailless clients that share an exact (trimmed, case-insensitive) name.
    let mut name_dups: Vec<Vec<String>> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT GROUP_CONCAT(id) FROM clients WHERE (email IS NULL OR email = '') GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            let ids: Vec<String> = r.split(',').map(|s| s.to_string()).collect();
            if ids.len() > 1 { name_dups.push(ids); }
        }
    }
    for ids in &name_dups {
        let keeper = ids[0].clone();
        for dup_id in &ids[1..] {
            match merge_client_into(&conn, dup_id, &keeper, &now) {
                Ok(()) => duplicates_merged += 1,
                Err(e) => tracing::warn!("cleanup: merge {} -> {} failed (skipped): {}", dup_id, keeper, e),
            }
        }
    }

    // Merge "ghost" placeholders (no company, no email, blank/date-like phone) into
    // the real client they clearly duplicate. NO hard-coded names — the old code
    // special-cased company=="ben" (a partner's name), which would flag any customer
    // whose client is literally named "Ben" for deletion.
    let mut all_clients: Vec<ClientRow> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name, c.email, c.phone, c.company,
                    CASE WHEN EXISTS(SELECT 1 FROM invoices WHERE client_id=c.id AND status='paid' AND COALESCE(archived,0)=0 AND COALESCE(voided,0)=0) THEN 1 ELSE 0 END
             FROM clients c ORDER BY c.name"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(ClientRow {
                id: r.get(0)?,
                name: r.get::<_, String>(1)?,
                email: r.get(2)?,
                phone: r.get(3)?,
                company: r.get(4)?,
                has_invoices: r.get::<_, i64>(5)? != 0,
            })
        }).map_err(|e| e.to_string())?;
        for r in rows { if let Ok(c) = r { all_clients.push(c); } }
    }

    let mut ghost_merges: Vec<(String, String)> = Vec::new(); // (ghost_id, keeper_id)
    let mut ghost_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, c) in all_clients.iter().enumerate() {
        let company_lower = c.company.as_deref().unwrap_or("").to_lowercase();
        let phone_str = c.phone.as_deref().unwrap_or("");
        let email_str = c.email.as_deref().unwrap_or("");
        let is_ghost_pattern = company_lower.is_empty()
            && email_str.is_empty()
            && (phone_str.is_empty() || is_date_like(phone_str));
        if !is_ghost_pattern { continue; }

        let mut best_match: Option<(usize, i32)> = None;
        for (j, other) in all_clients.iter().enumerate() {
            if i == j { continue; }
            if ghost_set.contains(&other.id) { continue; }
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
        if let Some((j, _)) = best_match {
            ghost_set.insert(c.id.clone());
            ghost_merges.push((c.id.clone(), all_clients[j].id.clone()));
        }
    }
    let mut ghosts_removed: u32 = 0;
    for (ghost_id, keeper_id) in &ghost_merges {
        match merge_client_into(&conn, ghost_id, keeper_id, &now) {
            Ok(()) => ghosts_removed += 1,
            Err(e) => tracing::warn!("cleanup: ghost merge {} -> {} failed (skipped): {}", ghost_id, keeper_id, e),
        }
    }

    let remaining_clients: u32 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u32;
    Ok(CleanupResult { duplicates_merged, ghosts_removed, remaining_clients })
}

#[tauri::command]
pub async fn csv_preview(path: String) -> Result<crate::csv_import::CsvPreview, String> {
    crate::csv_import::preview(&path).map_err(|e| e.to_string())
}

/// Distinct values of one column in a CSV — used to detect categories from a
/// spreadsheet before bulk-adding them.
#[tauri::command]
pub async fn csv_distinct_column(path: String, column: usize) -> Result<Vec<String>, String> {
    crate::csv_import::distinct_column(&path, column).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn csv_import(
    path: String,
    mapping: crate::csv_import::ColumnMapping,
) -> Result<crate::csv_import::ImportSummary, String> {
    crate::csv_import::import(&path, &mapping).map_err(|e| e.to_string())
}

/// Preview a Chase statement (OFX/QBO/CSV) — parsed sample + detected format so the
/// user can confirm before importing.
#[tauri::command]
pub async fn bank_preview(path: String) -> Result<crate::bank_import::BankPreview, String> {
    crate::bank_import::preview(&path).map_err(|e| e.to_string())
}

/// Import a Chase statement into the immutable bank_txn ledger (deduped, synced).
#[tauri::command]
pub async fn bank_import(path: String, account_id: String) -> Result<crate::bank_import::BankImportSummary, String> {
    let summary = crate::bank_import::import(&path, &account_id).map_err(|e| e.to_string())?;
    let _ = apply_txn_rules_impl(false); // best-effort pre-tag of newly imported rows
    Ok(summary)
}

/// Replace an implausible year (e.g. an AI-hallucinated 2051) with the statement's
/// inferred year, keeping the month/day. Leaves a plausible year (hint or hint-1
/// for a December date on a January statement) alone.
fn fix_year(date: &str, hint: i32) -> String {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() == 3 {
        if let Ok(y) = parts[0].parse::<i32>() {
            if y < hint - 1 || y > hint {
                return format!("{}-{}-{}", hint, parts[1], parts[2]);
            }
        }
    }
    date.to_string()
}

/// Convert AI-extracted statement transactions into ParsedRows.
fn ai_txns_to_rows(txns: &[Value], year_hint: i32) -> Vec<crate::bank_import::ParsedRow> {
    let mut rows = Vec::new();
    for t in txns {
        let amount = t.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0).abs();
        if amount == 0.0 { continue; }
        let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let dir = t.get("direction").and_then(|v| v.as_str()).unwrap_or("out");
        rows.push(crate::bank_import::ParsedRow {
            posted_at: fix_year(t.get("date").and_then(|v| v.as_str()).unwrap_or(""), year_hint),
            amount,
            direction: if dir == "in" { "in".into() } else { "out".into() },
            description: desc.clone(),
            memo_raw: desc,
            rail: String::new(),
            category: t.get("category").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            counterparty_name: t.get("counterparty").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
            fitid: String::new(),
            wire_ref: String::new(),
            check_num: String::new(),
            balance: 0.0,
        });
    }
    rows
}

/// SMART import — AI-extract transactions from ANY statement (credit cards, other
/// banks, messy layouts) then dedupe + persist. Returns counts + the statement's
/// ending balance for a reconciliation check.
#[tauri::command]
pub async fn bank_preview_ai(path: String) -> Result<Value, String> {
    let text = crate::bank_import::statement_text(&path).map_err(|e| e.to_string())?;
    let year = crate::bank_import::infer_statement_year(&text);
    let out = crate::ai::extract_statement(&text, year).await.map_err(|e| e.to_string())?;
    let txns = out.get("transactions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    // Apply the same year clamp to the sample so the preview shows correct dates.
    let sample: Vec<Value> = txns.iter().take(10).map(|t| {
        let mut t = t.clone();
        if let Some(d) = t.get("date").and_then(|v| v.as_str()) {
            t["date"] = json!(fix_year(d, year));
        }
        t
    }).collect();
    Ok(json!({
        "total": txns.len(),
        "ending_balance": out.get("ending_balance").cloned().unwrap_or(Value::Null),
        "sample": sample,
    }))
}

#[tauri::command]
pub async fn bank_import_ai(path: String, account_id: String) -> Result<Value, String> {
    let text = crate::bank_import::statement_text(&path).map_err(|e| e.to_string())?;
    let year = crate::bank_import::infer_statement_year(&text);
    let out = crate::ai::extract_statement(&text, year).await.map_err(|e| e.to_string())?;
    let txns = out.get("transactions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let rows = ai_txns_to_rows(&txns, year);
    let summary = crate::bank_import::persist_rows(&rows, &account_id, "ai").map_err(|e| e.to_string())?;
    let _ = apply_txn_rules_impl(false); // best-effort pre-tag of newly imported rows
    Ok(json!({
        "imported": summary.imported,
        "skipped": summary.skipped,
        "errors": summary.errors,
        "extracted": txns.len(),
        "ending_balance": out.get("ending_balance").cloned().unwrap_or(Value::Null),
    }))
}

// ── Financial engine: transactions, classification, allocation ──────────────

/// All bank transactions with their allocated total + remaining unallocated.
#[tauri::command]
pub async fn list_bank_txns() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT bt.id, bt.posted_at, bt.amount, bt.direction, bt.description, bt.rail, bt.category,
                bt.counterparty_name, bt.counterparty_type, bt.counterparty_id, bt.wire_ref, bt.reviewed, bt.account_id,
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id), 0) AS allocated,
                (SELECT COUNT(*) FROM bank_allocation a WHERE a.bank_txn_id=bt.id) AS alloc_count
         FROM bank_txn bt ORDER BY bt.posted_at DESC, bt.created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let amount: f64 = r.get(2)?;
        let allocated: f64 = r.get(13)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "posted_at": r.get::<_, String>(1)?,
            "amount": amount,
            "direction": r.get::<_, String>(3)?,
            "description": r.get::<_, String>(4)?,
            "rail": r.get::<_, String>(5)?,
            "category": r.get::<_, String>(6)?,
            "counterparty_name": r.get::<_, String>(7)?,
            "counterparty_type": r.get::<_, String>(8)?,
            "counterparty_id": r.get::<_, String>(9)?,
            "wire_ref": r.get::<_, String>(10)?,
            "reviewed": r.get::<_, i64>(11)? != 0,
            "account_id": r.get::<_, String>(12)?,
            "allocated": allocated,
            "alloc_count": r.get::<_, i64>(14)?,
            "unallocated": ((amount - allocated) * 100.0).round() / 100.0,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Headline counts for the Financials review area.
#[tauri::command]
pub async fn bank_txn_summary() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let one = |sql: &str| -> f64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0.0) };
    let total = one("SELECT COUNT(*) FROM bank_txn");
    let reviewed = one("SELECT COUNT(*) FROM bank_txn WHERE reviewed=1");
    let sum_in = one("SELECT COALESCE(SUM(amount),0) FROM bank_txn WHERE direction='in'");
    let sum_out = one("SELECT COALESCE(SUM(amount),0) FROM bank_txn WHERE direction='out'");
    // Money-in transactions not yet fully tied to a deal (excludes internal transfers,
    // which are not deal money).
    let unallocated_in = one(
        "SELECT COUNT(*) FROM bank_txn bt WHERE bt.direction='in' AND bt.category!='internal_transfer'
           AND COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id),0) < bt.amount - 0.01",
    );
    // Money-out not yet tied to a deal (supplier payments / refunds out to reconcile).
    let unallocated_out = one(
        "SELECT COUNT(*) FROM bank_txn bt WHERE bt.direction='out' AND bt.category!='internal_transfer'
           AND COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id),0) < bt.amount - 0.01",
    );
    // Not yet classified at all (no category) — the raw cleanup backlog.
    let unclassified = one("SELECT COUNT(*) FROM bank_txn WHERE COALESCE(category,'')=''");
    Ok(json!({
        "total": total, "reviewed": reviewed,
        "sum_in": sum_in, "sum_out": sum_out,
        "unallocated_in": unallocated_in, "unallocated_out": unallocated_out,
        "unclassified": unclassified,
    }))
}

/// The columns a review save writes: ONLY the fields actually supplied. `None`
/// when nothing was, so a no-op save emits no event instead of bumping a clock
/// for a change that didn't happen.
///
/// This is the rule that matters for sync correctness. Writes are per-column
/// last-write-wins, so naming a column re-stamps its clock with a fresh HLC —
/// even when the value is unchanged. This function used to be inline and always
/// named all six columns, which meant a category save also re-asserted
/// `reviewed`; a stale device re-classifying a transaction would win LWW on
/// `reviewed=0` and silently un-book work another device had booked. Kept as its
/// own function so that rule is directly testable (see `review_cols_tests`).
fn review_cols(
    category: &Option<String>, counterparty_name: &Option<String>,
    counterparty_type: &Option<String>, counterparty_id: &Option<String>,
    flag: Option<i64>, now: &str,
) -> Option<Map<String, Value>> {
    let mut cols = Map::new();
    if let Some(v) = category { cols.insert("category".into(), json!(v)); }
    if let Some(v) = counterparty_name { cols.insert("counterparty_name".into(), json!(v)); }
    if let Some(v) = counterparty_type { cols.insert("counterparty_type".into(), json!(v)); }
    if let Some(v) = counterparty_id { cols.insert("counterparty_id".into(), json!(v)); }
    if let Some(v) = flag { cols.insert("reviewed".into(), json!(v)); }
    if cols.is_empty() { return None; }
    cols.insert("updated_at".into(), json!(now));
    Some(cols)
}

/// Mirrors `review_cols` locally: a NULL (omitted) field COALESCEs to the column's
/// current value, so the local row changes exactly what the sync event does. Named
/// so the test exercises the same string the command runs.
const REVIEW_UPDATE_SQL: &str =
    "UPDATE bank_txn SET category=COALESCE(?1,category), counterparty_name=COALESCE(?2,counterparty_name),
       counterparty_type=COALESCE(?3,counterparty_type), counterparty_id=COALESCE(?4,counterparty_id),
       reviewed=COALESCE(?5,reviewed), updated_at=?6 WHERE id=?7";

/// Set a transaction's classification (category + counterparty) and/or reviewed
/// flag. Every field is optional and only the ones supplied are written, like
/// `tag_bank_txn_to_loan`. An explicit un-book/re-classify still works: it sends
/// `reviewed` alone.
#[tauri::command]
pub async fn set_bank_txn_review(
    id: String, category: Option<String>, counterparty_name: Option<String>,
    counterparty_type: Option<String>, counterparty_id: Option<String>, reviewed: Option<bool>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let flag = reviewed.map(|r| if r { 1i64 } else { 0i64 });
    let Some(cols) = review_cols(&category, &counterparty_name, &counterparty_type, &counterparty_id, flag, &now)
    else { return Ok(()); };
    sync::record_upsert("bank_txn", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        REVIEW_UPDATE_SQL,
        rusqlite::params![category, counterparty_name, counterparty_type, counterparty_id, flag, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Allocate part (or all) of a bank transaction to a deal. Enforces
/// SUM(allocations) <= txn.amount (spec invariant). Returns the allocation id.
#[tauri::command]
pub async fn allocate_bank_txn(
    bank_txn_id: String, deal_flow_id: String, amount: f64, role: String, note: String,
    allow_split: Option<bool>,
) -> Result<String, String> {
    let (txn_amount, allocated, direction): (f64, f64, String) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT bt.amount, COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id),0), bt.direction
             FROM bank_txn bt WHERE bt.id=?1",
            [&bank_txn_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|_| "Transaction not found".to_string())?
    };
    // Exclusive links: a transaction already tied to a DIFFERENT deal can't be paired
    // here (enforces "shouldn't show up for any other deal" even against a stale picker
    // or a second window/device).
    let linked_elsewhere: bool = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT 1 FROM bank_allocation WHERE bank_txn_id=?1 AND deal_flow_id != ?2 LIMIT 1",
            rusqlite::params![bank_txn_id, deal_flow_id], |_| Ok(()),
        ).is_ok()
    };
    // The split flow (explicit "Split across deals") deliberately lifts this single-deal
    // guard so one payment can be divided across multiple deals. The SUM invariant below
    // (amt <= remaining across ALL allocations) still keeps the split balanced, and the
    // deal-side pickers stay exclusive, so a split txn never leaks into unrelated deals.
    if linked_elsewhere && !allow_split.unwrap_or(false) {
        return Err("This transaction is already linked to another deal.".into());
    }
    // A role has to match the transaction's direction, or role-based reconciliation
    // (supplier payables, refund liability) would book money against the wrong side.
    let role_ok = match direction.as_str() {
        "in" => matches!(role.as_str(), "buyer_payment" | "refund_in" | "adjustment"),
        _    => matches!(role.as_str(), "supplier_payment" | "refund_out" | "fee" | "adjustment"),
    };
    if !role_ok {
        return Err(format!("\"{}\" can't be applied to a money-{} transaction", role, direction));
    }
    let remaining = ((txn_amount - allocated) * 100.0).round() / 100.0;
    let amt = (amount * 100.0).round() / 100.0;
    if amt <= 0.0 { return Err("Allocation amount must be positive".into()); }
    if amt > remaining + 0.001 {
        return Err(format!("Only {:.2} is left unallocated on this transaction", remaining));
    }
    let id = format!("alloc_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    // Money rows record who booked them and for which org, at the author. Leaving these
    // to the schema default silently files every tenant's allocation under 'org_default'.
    let org = crate::employees::session_org_id();
    let by = crate::employees::session_actor().map(|(sid, _)| sid).unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!(org));
    cols.insert("bank_txn_id".into(), json!(bank_txn_id));
    cols.insert("deal_flow_id".into(), json!(deal_flow_id));
    cols.insert("amount".into(), json!(amt));
    cols.insert("role".into(), json!(role));
    cols.insert("note".into(), json!(note));
    cols.insert("created_by".into(), json!(by));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("bank_allocation", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO bank_allocation (id, org_id, bank_txn_id, deal_flow_id, amount, role, note, created_by, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        rusqlite::params![id, org, bank_txn_id, deal_flow_id, amt, role, note, by, now],
    ).map_err(|e| e.to_string())?;
    drop(conn); // release before recalc acquires its own connection

    // Any bank link (buyer payment, supplier payment, fee, refund) feeds the deal's
    // recorded numbers. For a completed deal, re-derive + persist now so Deal Flow
    // and every report that reads those numbers reflect the link immediately.
    let _ = resync_completed_deal(&deal_flow_id);

    crate::netsync::push_now(); // reach the other device promptly, not on the next poll
    Ok(id)
}

/// Remove an allocation.
#[tauri::command]
pub async fn remove_bank_allocation(id: String) -> Result<(), String> {
    // Capture the deal before deleting so we can re-derive its numbers after.
    let deal_flow_id: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT deal_flow_id FROM bank_allocation WHERE id=?1", [&id], |r| r.get(0)).ok()
    };
    sync::record_delete("bank_allocation", &id).map_err(|e| e.to_string())?;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM bank_allocation WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    // Unlinking a transaction from a completed deal must move its numbers back too.
    if let Some(dfid) = deal_flow_id { let _ = resync_completed_deal(&dfid); }
    crate::netsync::push_now();
    Ok(())
}

/// Delete allocation rows whose bank transaction no longer exists — e.g. a bank
/// statement was re-imported and the old txn ids were replaced, leaving the
/// allocation pointing at a gone transaction. These dead links were double-counting
/// deals' actuals. They reference nothing real, so removing them corrupts no money
/// data; it just stops the bleed. Idempotent, synced, and re-derives any completed
/// deal that was affected. Returns how many were removed.
#[tauri::command]
pub async fn cleanup_orphan_allocations() -> Result<i64, String> {
    let rows: Vec<(String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT a.id, a.deal_flow_id FROM bank_allocation a
             WHERE NOT EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)",
        ).map_err(|e| e.to_string())?;
        // Bind into a Vec so the row iterator (which borrows stmt/conn) is fully
        // consumed before this block drops stmt and conn.
        let v: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        v
    };
    if rows.is_empty() { return Ok(0); }
    let mut deals: Vec<String> = rows.iter().map(|(_, d)| d.clone()).collect();
    deals.sort(); deals.dedup();
    for (id, _) in &rows {
        sync::record_delete("bank_allocation", id).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM bank_allocation WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    }
    for d in &deals { let _ = resync_completed_deal(d); }
    crate::netsync::push_now();
    Ok(rows.len() as i64)
}

/// Re-derive EVERY completed deal from its linked bank transactions — recorded
/// numbers AND completion date (set to the supplier-payment bank date when linked).
/// Powers "Sync completed from bank" so backlogged deals land on the date the money
/// actually moved, not the day they were entered. Returns how many were processed.
#[tauri::command]
pub async fn resync_all_completed_deals() -> Result<i64, String> {
    let ids: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id FROM deal_flows WHERE stage='complete' AND COALESCE(archived,0)=0")
            .map_err(|e| e.to_string())?;
        let v: Vec<String> = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        v
    };
    let n = ids.len() as i64;
    for id in &ids { let _ = resync_completed_deal(id); }
    crate::netsync::push_now();
    Ok(n)
}

/// Mark a completed deal's money legs as "no bank record to link" — a cash-only
/// deal, or a leg that legitimately never happened — so it stops being flagged as
/// needing financials. Stored in metadata and synced.
#[tauri::command]
pub async fn set_deal_link_na(id: String, no_buyer: bool, no_supplier: bool) -> Result<(), String> {
    let df = read_df(&id)?;
    let mut meta = serde_json::from_str::<Value>(df.metadata.as_deref().unwrap_or("{}"))
        .ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    meta.insert("no_buyer_link".into(), json!(no_buyer));
    meta.insert("no_supplier_link".into(), json!(no_supplier));
    let meta_json = serde_json::to_string(&Value::Object(meta)).unwrap_or_else(|_| "{}".into());
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("metadata".into(), json!(meta_json.clone()));
    cols.insert("updated_at".into(), json!(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET metadata=?1, updated_at=?2 WHERE id=?3", rusqlite::params![meta_json, now, id])
        .map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// Mark a refund as fully done (closed out) or reopen it. A done refund stays out of
/// the active pipeline and drops from the Refunds list unless "Show done" is on.
/// Stored in metadata, synced.
#[tauri::command]
pub async fn set_refund_done(id: String, done: bool) -> Result<(), String> {
    let df = read_df(&id)?;
    let mut meta = serde_json::from_str::<Value>(df.metadata.as_deref().unwrap_or("{}"))
        .ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
    meta.insert("refund_done".into(), json!(done));
    let meta_json = serde_json::to_string(&Value::Object(meta)).unwrap_or_else(|_| "{}".into());
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("metadata".into(), json!(meta_json.clone()));
    cols.insert("updated_at".into(), json!(now.clone()));
    sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE deal_flows SET metadata=?1, updated_at=?2 WHERE id=?3", rusqlite::params![meta_json, now, id])
        .map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

/// Allocations on one transaction, with the deal name / invoice number.
#[tauri::command]
pub async fn list_bank_allocations_for_txn(bank_txn_id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.deal_flow_id, a.amount, a.role, a.note,
                COALESCE(df.name,''), COALESCE(i.number,''), COALESCE(c.name,'')
         FROM bank_allocation a
         LEFT JOIN deal_flows df ON df.id=a.deal_flow_id
         LEFT JOIN invoices i ON i.id=df.invoice_id
         LEFT JOIN clients c ON c.id=i.client_id
         WHERE a.bank_txn_id=?1 ORDER BY a.created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&bank_txn_id], |r| Ok(json!({
        "id": r.get::<_, String>(0)?,
        "deal_flow_id": r.get::<_, String>(1)?,
        "amount": r.get::<_, f64>(2)?,
        "role": r.get::<_, String>(3)?,
        "note": r.get::<_, String>(4)?,
        "deal_name": r.get::<_, String>(5)?,
        "invoice_number": r.get::<_, String>(6)?,
        "client_name": r.get::<_, String>(7)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// All bank allocations tied to one deal, joined to the underlying transaction
/// (date, direction, counterparty, wire ref) so the deal panel can show exactly
/// what's paired per money-leg and derive an actual profit. `direction` per row
/// lets the UI render money-in green / money-out red without re-deriving sign;
/// `bank_txn.amount` is always positive.
#[tauri::command]
pub async fn deal_allocations(deal_flow_id: String) -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.bank_txn_id, a.amount, a.role, a.note,
                bt.posted_at, bt.direction, bt.counterparty_name, bt.description,
                bt.wire_ref, bt.rail, bt.amount AS txn_amount
         FROM bank_allocation a
         JOIN bank_txn bt ON bt.id = a.bank_txn_id
         WHERE a.deal_flow_id = ?1
         ORDER BY bt.posted_at DESC, a.created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&deal_flow_id], |r| Ok(json!({
        "id":                r.get::<_, String>(0)?,
        "bank_txn_id":       r.get::<_, String>(1)?,
        "amount":            r.get::<_, f64>(2)?,
        "role":              r.get::<_, String>(3)?,
        "note":              r.get::<_, String>(4)?,
        "posted_at":         r.get::<_, String>(5)?,
        "direction":         r.get::<_, String>(6)?,
        "counterparty_name": r.get::<_, String>(7)?,
        "description":       r.get::<_, String>(8)?,
        "wire_ref":          r.get::<_, String>(9)?,
        "rail":              r.get::<_, String>(10)?,
        "txn_amount":        r.get::<_, f64>(11)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Heal allocations stranded on a duplicate ("ghost") deal_flow row. Some invoices
/// carry more than one deal_flow row; the deal-flow view collapses them to the
/// single highest-stage survivor, but the Financials allocator historically listed
/// every row, so a payment could be paired to a ghost the deal view never shows —
/// making the deal look like it has "no linked payment". This re-points every such
/// allocation onto the same survivor the UI displays (highest stage, newest on a
/// tie), through the sync layer so the fix reaches the server and other devices.
/// Idempotent: once healed it finds nothing and returns 0.
#[tauri::command]
pub async fn reattach_orphaned_deal_allocations() -> Result<i64, String> {
    // Stage rank must match the deal-flow UI's dedup (invoiced<payment_received<
    // supplier_paid<complete). Survivor per invoice = highest rank, newest on a tie.
    const SURV: &str =
        "SELECT id FROM deal_flows WHERE invoice_id=?1 AND COALESCE(archived,0)=0 \
         ORDER BY (CASE stage WHEN 'complete' THEN 3 WHEN 'supplier_paid' THEN 2 \
         WHEN 'payment_received' THEN 1 ELSE 0 END) DESC, created_at DESC LIMIT 1";
    let orphans: Vec<(String, String, f64, String, String, String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT a.id, a.bank_txn_id, a.amount, a.role, COALESCE(a.note,''), df.invoice_id, COALESCE(a.created_at,'') \
             FROM bank_allocation a JOIN deal_flows df ON df.id=a.deal_flow_id \
             WHERE COALESCE(df.archived,0)=0 AND df.invoice_id IS NOT NULL \
               AND df.id <> (SELECT d2.id FROM deal_flows d2 \
                             WHERE d2.invoice_id=df.invoice_id AND COALESCE(d2.archived,0)=0 \
                             ORDER BY (CASE d2.stage WHEN 'complete' THEN 3 WHEN 'supplier_paid' THEN 2 \
                             WHEN 'payment_received' THEN 1 ELSE 0 END) DESC, d2.created_at DESC LIMIT 1)",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?,
            r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?,
        ))).map_err(|e| e.to_string())?;
        rows.filter_map(|x| x.ok()).collect()
    };
    if orphans.is_empty() { return Ok(0); }
    let mut fixed = 0i64;
    for (id, bank_txn_id, amount, role, note, invoice_id, created_at) in orphans {
        let survivor: Option<String> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.query_row(SURV, [&invoice_id], |r| r.get::<_, String>(0)).ok()
        };
        let Some(survivor) = survivor else { continue };
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("bank_txn_id".into(), json!(bank_txn_id));
        cols.insert("deal_flow_id".into(), json!(survivor));
        cols.insert("amount".into(), json!(amount));
        cols.insert("role".into(), json!(role));
        cols.insert("note".into(), json!(note));
        cols.insert("created_at".into(), json!(created_at));
        cols.insert("updated_at".into(), json!(now));
        sync::record_upsert("bank_allocation", &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE bank_allocation SET deal_flow_id=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![survivor, now, id]).map_err(|e| e.to_string())?;
        fixed += 1;
    }
    if fixed > 0 { crate::netsync::push_now(); }
    Ok(fixed)
}

/// Archive duplicate ("ghost") and orphaned deal_flow rows so raw SQL aggregates
/// (dashboard open-deals, free-cash reserves, payables, analytics) stop counting
/// rows the deal-flow view already hides. Ghost = a non-archived row that is not
/// its invoice's survivor (highest stage, newest on a tie — the row every picker
/// and list shows). Orphan = a non-archived row whose invoice no longer exists.
/// Allocations are re-pointed to the survivor first, and any row still carrying
/// refunds/receipts/rep/allocation data is left alone — so archiving is lossless
/// and reversible from the Archive view. Synced; idempotent (finds 0 once clean).
#[tauri::command]
pub async fn cleanup_ghost_deal_flows() -> Result<i64, String> {
    // Move stranded payments onto survivors before ghosts leave the picture.
    let _ = reattach_orphaned_deal_allocations().await?;
    let ghosts: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT df.id FROM deal_flows df \
             WHERE COALESCE(df.archived,0)=0 AND ( \
               df.invoice_id IS NULL OR df.invoice_id='' \
               OR NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id=df.invoice_id) \
               OR df.id <> (SELECT d2.id FROM deal_flows d2 \
                            WHERE d2.invoice_id=df.invoice_id AND COALESCE(d2.archived,0)=0 \
                            ORDER BY (CASE d2.stage WHEN 'complete' THEN 3 WHEN 'supplier_paid' THEN 2 \
                            WHEN 'payment_received' THEN 1 ELSE 0 END) DESC, d2.created_at DESC LIMIT 1))",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|x| x.ok()).collect()
    };
    if ghosts.is_empty() { return Ok(0); }
    let mut archived = 0i64;
    for id in ghosts {
        // Conservative guard: never archive a row that still owns money/rep data.
        let has_data: bool = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT 1 WHERE EXISTS (SELECT 1 FROM bank_allocation WHERE deal_flow_id=?1) \
                    OR EXISTS (SELECT 1 FROM refunds WHERE deal_flow_id=?1) \
                    OR EXISTS (SELECT 1 FROM deal_receipts WHERE deal_flow_id=?1) \
                    OR EXISTS (SELECT 1 FROM deal_reps WHERE deal_flow_id=?1)",
                [&id], |_| Ok(()),
            ).is_ok()
        };
        if has_data { continue; }
        let now = Utc::now().to_rfc3339();
        let mut cols = Map::new();
        cols.insert("archived".into(), Value::from(1));
        cols.insert("archived_at".into(), Value::String(now.clone()));
        sync::record_upsert("deal_flows", &id, cols).map_err(|e| e.to_string())?;
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE deal_flows SET archived=1, archived_at=?1 WHERE id=?2",
            rusqlite::params![now, id]).map_err(|e| e.to_string())?;
        archived += 1;
    }
    if archived > 0 { crate::netsync::push_now(); }
    Ok(archived)
}

/// Heal transactions whose allocations exceed the transaction amount. allocate_bank_txn
/// enforces SUM(allocations) <= amount LOCALLY, but two devices allocating the same txn
/// concurrently each pass their own check, and after the sync merge the SUM can exceed
/// the amount — double-booking that money on two deals and skewing every actuals figure.
/// This trims the NEWEST allocations (synced) until the invariant holds again.
/// Idempotent; returns how many allocations were removed.
#[tauri::command]
pub async fn heal_overallocated_txns() -> Result<i64, String> {
    let bad: Vec<(String, f64)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT bt.id, bt.amount FROM bank_txn bt JOIN bank_allocation a ON a.bank_txn_id=bt.id \
             GROUP BY bt.id HAVING COALESCE(SUM(a.amount),0) > bt.amount + 0.01",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|x| x.ok()).collect()
    };
    if bad.is_empty() { return Ok(0); }
    let mut removed = 0i64;
    for (txn_id, amount) in bad {
        let allocs: Vec<(String, f64)> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare(
                "SELECT id, amount FROM bank_allocation WHERE bank_txn_id=?1 ORDER BY created_at DESC, id DESC",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([&txn_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|x| x.ok()).collect()
        };
        let mut running: f64 = allocs.iter().map(|(_, a)| *a).sum();
        for (aid, amt) in allocs {
            if running <= amount + 0.01 { break; }
            sync::record_delete("bank_allocation", &aid).map_err(|e| e.to_string())?;
            let conn = pool().get().map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM bank_allocation WHERE id=?1", [&aid]).map_err(|e| e.to_string())?;
            running -= amt;
            removed += 1;
        }
    }
    if removed > 0 { crate::netsync::push_now(); }
    Ok(removed)
}

/// Bank transactions available to pair to a deal, split by direction. A txn is
/// offered iff it has NO allocation to a deal other than this one (exclusive
/// links — once linked anywhere it's gone from every other deal's picker) and it
/// isn't an internal transfer. `money_in` feeds the buyer-payment picker;
/// `money_out` feeds the supplier / fee / refund-out pickers. When `deal_flow_id`
/// is omitted (browse mode) only txns with no allocation at all are returned.
#[tauri::command]
pub async fn unallocated_bank_txns(deal_flow_id: Option<String>) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let this = deal_flow_id.unwrap_or_default();
    let mut stmt = conn.prepare(
        "SELECT bt.id, bt.posted_at, bt.amount, bt.direction, bt.description,
                bt.counterparty_name, bt.wire_ref, bt.rail, bt.category,
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a
                          WHERE a.bank_txn_id = bt.id AND a.deal_flow_id = ?1), 0) AS mine,
                -- SUM over ALL allocations, exactly as allocate_bank_txn measures
                -- 'remaining', so the picker never offers money the allocator rejects.
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a
                          WHERE a.bank_txn_id = bt.id), 0) AS total_alloc
         FROM bank_txn bt
         WHERE bt.category != 'internal_transfer'
           -- Show a transaction as long as it still has money left to allocate — even
           -- if part of it is already on OTHER deals (so a $40k cash receipt split $20k
           -- to deal A still shows $20k remaining when you open deal B).
           AND (bt.amount - COALESCE((SELECT SUM(a.amount) FROM bank_allocation a
                          WHERE a.bank_txn_id = bt.id), 0)) > 0.005
         ORDER BY bt.posted_at DESC, bt.created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = stmt.query_map([&this], |r| {
        let amount: f64 = r.get(2)?;
        let mine: f64 = r.get(9)?;
        let total_alloc: f64 = r.get(10)?;
        let round2 = |v: f64| (v * 100.0).round() / 100.0;
        Ok(json!({
            "id":                r.get::<_, String>(0)?,
            "posted_at":         r.get::<_, String>(1)?,
            "amount":            amount,
            "direction":         r.get::<_, String>(3)?,
            "description":       r.get::<_, String>(4)?,
            "counterparty_name": r.get::<_, String>(5)?,
            "wire_ref":          r.get::<_, String>(6)?,
            "rail":              r.get::<_, String>(7)?,
            "category":          r.get::<_, String>(8)?,
            // original transaction amount (never changes)
            "original":          round2(amount),
            // already allocated to THIS deal
            "mine":              round2(mine),
            // total claimed across all deals (matches allocate_bank_txn's remaining)
            "allocated":         round2(total_alloc),
            // money still free to allocate anywhere (original − allocated everywhere)
            "unallocated":       round2(amount - total_alloc),
        }))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    let (money_in, money_out): (Vec<_>, Vec<_>) =
        rows.into_iter().partition(|t| t["direction"] == "in");
    Ok(json!({ "money_in": money_in, "money_out": money_out }))
}

/// Record a manual CASH transaction (cash you took in or paid out, outside the bank
/// feed) so it can be allocated across deals just like a bank transaction. It lands
/// as a normal bank_txn (source_format 'manual_cash'), so the existing allocation
/// engine handles the split + remaining ("only X left unallocated") + original amount.
#[tauri::command]
pub async fn add_cash_transaction(
    amount: f64,
    direction: String,
    posted_at: String,
    counterparty: Option<String>,
    note: Option<String>,
) -> Result<String, String> {
    if !(amount > 0.0) {
        return Err("Enter a cash amount greater than zero".into());
    }
    let dir = if direction == "out" { "out" } else { "in" };
    let date = if posted_at.trim().is_empty() {
        Utc::now().format("%Y-%m-%d").to_string()
    } else {
        posted_at
    };
    let cp = counterparty.unwrap_or_default();
    let note = note.unwrap_or_default();
    let desc = if note.trim().is_empty() {
        format!("Cash {}", if dir == "out" { "paid out" } else { "received" })
    } else {
        note
    };
    let cat = if dir == "out" { "cash_out" } else { "cash_in" };
    let id = format!("btc_{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();

    let s = |v: &str| Value::String(v.to_string());
    let mut cols = Map::new();
    cols.insert("account_id".into(), s("Cash"));
    cols.insert("posted_at".into(), s(&date));
    cols.insert("amount".into(), json!(amount));
    cols.insert("direction".into(), s(dir));
    cols.insert("description".into(), s(&desc));
    cols.insert("memo_raw".into(), s(&desc));
    cols.insert("category".into(), s(cat));
    cols.insert("counterparty_name".into(), s(&cp));
    cols.insert("source_format".into(), s("manual_cash"));
    cols.insert("reviewed".into(), json!(1));
    cols.insert("imported_at".into(), s(&now));
    cols.insert("created_at".into(), s(&now));
    cols.insert("updated_at".into(), s(&now));
    sync::record_upsert("bank_txn", &id, cols).map_err(|e| e.to_string())?;

    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO bank_txn (id, account_id, posted_at, amount, direction, description, memo_raw, category, counterparty_name, source_format, reviewed, imported_at, created_at, updated_at)
         VALUES (?1,'Cash',?2,?3,?4,?5,?5,?6,?7,'manual_cash',1,?8,?8,?8)",
        rusqlite::params![id, date, amount, dir, desc, cat, cp, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Reconciliation rollup for one deal: expected profit (from the deal flow) vs.
/// ACTUAL profit derived from paired bank transactions, plus the per-role pieces
/// and paired/unpaired flags for the two required legs. Fully reconciled when
/// both the buyer payment and the supplier payment have at least one paired txn;
/// fees/refunds are optional and only adjust the number.
#[tauri::command]
pub async fn deal_reconciliation(deal_flow_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let r2 = |x: f64| (x * 100.0).round() / 100.0;

    // Guard against orphaned allocations (bank_txn deleted / re-imported) so a dead
    // link can't double a leg. Matches deal_bank_actuals.
    let role_sum = |role: &str| -> f64 {
        conn.query_row(
            "SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a
             WHERE a.deal_flow_id = ?1 AND a.role = ?2
               AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)",
            rusqlite::params![deal_flow_id, role], |r| r.get(0),
        ).unwrap_or(0.0)
    };

    let buyer_paired    = role_sum("buyer_payment");
    let supplier_paired = role_sum("supplier_payment");
    let fee_paired      = role_sum("fee");
    let refund_out      = role_sum("refund_out");
    // Money-in refund FROM a supplier (a supplier reversal) — offsets supplier
    // cost, so it lifts actual profit. Previously accepted + pickable but never
    // read, so a supplier refund silently vanished from the deal's actuals.
    let refund_in       = role_sum("refund_in");

    // NON-bank-linked cash refunds only — a bank-linked refund also has a
    // refund_out allocation (counted above), so counting it here too would
    // double it. Matches the refund_status_all rule.
    let refunds: f64 = conn.query_row(
        "SELECT COALESCE(SUM(amount),0) FROM refunds WHERE deal_flow_id = ?1 AND COALESCE(bank_txn_id,'')=''",
        [&deal_flow_id], |r| r.get(0)).unwrap_or(0.0);

    // Expected figures off the deal flow, plus the invoice total the buyer owes and
    // the supplier cost — so "fully reconciled" is judged on AMOUNTS, not just the
    // presence of one paired transaction (BJM deals routinely have a deposit + balance
    // and multiple supplier wires).
    let (gross_revenue, total_cost, total_supplier_cost, invoice_total): (f64, f64, f64, f64) = conn.query_row(
        "SELECT COALESCE(df.gross_revenue,0), COALESCE(df.total_cost,0),
                COALESCE(df.total_supplier_cost,0), COALESCE(i.total,0)
         FROM deal_flows df LEFT JOIN invoices i ON i.id = df.invoice_id
         WHERE df.id = ?1",
        [&deal_flow_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|_| "Deal not found".to_string())?;

    // Expected profit is the PLAN — what you'd make at the entered cost (revenue −
    // supplier cost). The stored net_profit can be stale before completion (it may
    // still equal gross if cost was added later), so derive it fresh here.
    let expected_profit = (if invoice_total > 0.01 { invoice_total } else { gross_revenue }) - total_supplier_cost;

    // refund_out = bank-paired refunds; refunds = cash refunds with no bank link.
    // They describe DIFFERENT money, so sum them (the old max() undercounted a deal
    // that had both a cash refund and a separate bank-paired one). Matches
    // refund_status_all and financials_overview.
    let refund_total = refund_out + refunds;
    // + refund_in: a supplier reversal came back to us, reducing net supplier cost.
    let actual_profit = buyer_paired - supplier_paired - fee_paired - refund_total + refund_in;

    // Reconciled = paired AMOUNTS cover what's owed (within 50¢), not just "a txn exists".
    let buyer_target = if invoice_total > 0.01 { invoice_total } else { gross_revenue };
    let payment_received_paired = if buyer_target > 0.01 { buyer_paired >= buyer_target - 0.5 } else { buyer_paired > 0.01 };
    let supplier_paid_paired    = if total_supplier_cost > 0.01 { supplier_paired >= total_supplier_cost - 0.5 } else { supplier_paired > 0.01 };
    let fully_reconciled = payment_received_paired && supplier_paid_paired;

    Ok(json!({
        "expected_profit":  r2(expected_profit),
        "gross_revenue":    r2(gross_revenue),
        "total_cost":       r2(total_cost),
        "actual_profit":    r2(actual_profit),
        "pieces": {
            "buyer_paired":    r2(buyer_paired),
            "supplier_paired": r2(supplier_paired),
            "fee_paired":      r2(fee_paired),
            "refund_total":    r2(refund_total),
            "refund_in":       r2(refund_in),
        },
        "payment_received_paired": payment_received_paired,
        "supplier_paid_paired":    supplier_paid_paired,
        "fully_reconciled":        fully_reconciled,
    }))
}

/// Reconciliation status for every completed deal at once — powers at-a-glance
/// badges in the deal-flow / completed lists ("what still needs paired").
#[tauri::command]
pub async fn reconciliation_status_all() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT df.id, COALESCE(i.total,0), COALESCE(df.total_supplier_cost,0), COALESCE(df.gross_revenue,0),
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='buyer_payment' AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)),0),
                COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='supplier_payment' AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)),0),
                EXISTS (SELECT 1 FROM bank_allocation a WHERE a.deal_flow_id=df.id AND EXISTS (SELECT 1 FROM bank_txn bt WHERE bt.id=a.bank_txn_id)),
                COALESCE(df.metadata,'')
         FROM deal_flows df LEFT JOIN invoices i ON i.id=df.invoice_id
         WHERE df.stage='complete' AND COALESCE(df.archived,0)=0",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let invoice_total: f64 = r.get(1)?;
        let supplier_cost: f64 = r.get(2)?;
        let gross_revenue: f64 = r.get(3)?;
        let buyer_paired: f64 = r.get(4)?;
        let supplier_paired: f64 = r.get(5)?;
        let has_financials: bool = r.get(6)?;
        let metadata: String = r.get(7)?;
        // "no bank records expected" acknowledgement — a completed deal the user has
        // marked as having no buyer / no supplier money to link (cash-only, etc.).
        let meta: Value = serde_json::from_str(&metadata).unwrap_or(Value::Null);
        let no_buyer    = meta.get("no_buyer_link").and_then(|v| v.as_bool()).unwrap_or(false);
        let no_supplier = meta.get("no_supplier_link").and_then(|v| v.as_bool()).unwrap_or(false);
        let buyer_target = if invoice_total > 0.01 { invoice_total } else { gross_revenue };
        let pr = if buyer_target > 0.01 { buyer_paired >= buyer_target - 0.5 } else { buyer_paired > 0.01 };
        let sp = if supplier_cost > 0.01 { supplier_paired >= supplier_cost - 0.5 } else { supplier_paired > 0.01 };
        let acknowledged = no_buyer && no_supplier;
        // Per-leg "potentially missing payment link": the leg has money expected but no
        // linked bank transaction AND hasn't been marked "no record". Lets the completed
        // list flag exactly which side needs attention, while the user can still add the
        // link or check the "no record" box to clear it.
        let buyer_linked    = buyer_paired > 0.01;
        let supplier_linked = supplier_paired > 0.01;
        let buyer_missing    = !buyer_linked    && !no_buyer    && buyer_target  > 0.01;
        let supplier_missing = !supplier_linked && !no_supplier && supplier_cost > 0.01;
        let needs_review = buyer_missing || supplier_missing;
        Ok(json!({
            "deal_flow_id": id,
            "payment_received_paired": pr,
            "supplier_paid_paired": sp,
            "fully_reconciled": pr && sp,
            "has_payment": buyer_paired > 0.01,
            "has_financials": has_financials,
            "no_buyer_link": no_buyer,
            "no_supplier_link": no_supplier,
            "needs_financials": !has_financials && !acknowledged,
            "buyer_missing": buyer_missing,
            "supplier_missing": supplier_missing,
            "needs_review": needs_review,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Refund status for every deal with refund activity — powers the "refund mode"
/// pill + numbers on deal-flow / invoice rows, at ANY stage. A deal is in refund
/// mode when refund_owed > 0 OR it has one or more refund payments recorded.
#[tauri::command]
pub async fn refund_status_all() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        // Refunded = custom refunds (refunds table, NOT bank-linked) + EVERY refund_out
        // bank allocation. A bank-linked refund lives in both refunds AND bank_allocation,
        // so we count it on the allocation side and exclude bank-linked refunds rows to
        // avoid double-counting. This makes a refund_out paired straight in Financials
        // count here too — not just refunds recorded in the refund workspace.
        "SELECT df.id, COALESCE(df.refund_owed,0),
                COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id AND COALESCE(r.bank_txn_id,'')=''),0)
                + COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='refund_out'),0),
                COALESCE(df.metadata,'')
         FROM deal_flows df
         WHERE COALESCE(df.archived,0)=0
           AND (COALESCE(df.refund_owed,0) > 0.01
                OR EXISTS (SELECT 1 FROM refunds r WHERE r.deal_flow_id=df.id)
                OR EXISTS (SELECT 1 FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='refund_out'))",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let owed: f64 = r.get(1)?;
        let refunded: f64 = r.get(2)?;
        let metadata: String = r.get(3)?;
        // "Fully done" — the user has closed out this refund; it stays out of the
        // active pipeline and drops from the Refunds list (unless Show done is on).
        let done = serde_json::from_str::<Value>(&metadata).ok()
            .and_then(|m| m.get("refund_done").and_then(|v| v.as_bool())).unwrap_or(false);
        Ok(json!({
            "deal_flow_id": id,
            "refund_owed": r2(owed),
            "refunded": r2(refunded),
            "remaining": r2((owed - refunded).max(0.0)),
            "done": done,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Finished work: a transaction that's been reviewed, or that's already linked to
/// a deal. Bulk wipes and the bank feed must not destroy these behind Jack's back
/// — once they're done they don't reopen. A missing row counts as not-finished so
/// callers still no-op cleanly on it.
fn bank_txn_is_finished(conn: &rusqlite::Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT reviewed=1 OR EXISTS(SELECT 1 FROM bank_allocation WHERE bank_txn_id=?1) FROM bank_txn WHERE id=?1",
        [id],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) != 0
}

/// Bulk-remove bank transactions (and their allocations) by source, synced so the
/// delete propagates to other devices/the server (a raw DB delete would resurrect
/// via sync). scope: "statements" (everything NOT from the Plaid feed — pdf/ofx/
/// csv/ai), "plaid", or "all". Use "statements" to drop manual imports once the
/// live feed is connected.
///
/// Reviewed or deal-linked transactions are KEPT and reported (`kept`) unless
/// `force` — a bulk wipe must not silently take finished books with it. Callers
/// re-invoke with force=true once the user has been told exactly what's at stake.
#[tauri::command]
pub async fn clear_bank_txns(scope: String, force: bool) -> Result<Value, String> {
    let where_sql = match scope.as_str() {
        "plaid" => "source_format = 'plaid'",
        "all" => "1=1",
        _ => "source_format != 'plaid'",
    };
    let ids: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(&format!("SELECT id FROM bank_txn WHERE {}", where_sql)).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut deleted = 0i64;
    let mut alloc_removed = 0i64;
    let mut kept: Vec<String> = Vec::new();
    for id in &ids {
        if !force {
            let conn = pool().get().map_err(|e| e.to_string())?;
            if bank_txn_is_finished(&conn, id) { kept.push(id.clone()); continue; }
        }
        let alloc_ids: Vec<String> = {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT id FROM bank_allocation WHERE bank_txn_id=?1").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        for aid in &alloc_ids {
            let _ = sync::record_delete("bank_allocation", aid);
            let conn = pool().get().map_err(|e| e.to_string())?;
            let _ = conn.execute("DELETE FROM bank_allocation WHERE id=?1", [aid]);
            alloc_removed += 1;
        }
        let _ = sync::record_delete("bank_txn", id);
        let conn = pool().get().map_err(|e| e.to_string())?;
        if conn.execute("DELETE FROM bank_txn WHERE id=?1", [id]).unwrap_or(0) > 0 { deleted += 1; }
    }
    if deleted + alloc_removed > 0 { crate::netsync::push_now(); } // reach peers now, not on the next poll
    if !kept.is_empty() {
        tracing::warn!(
            "clear_bank_txns({}): kept {} reviewed/deal-linked transaction(s), deleted {} — kept ids: {}",
            scope, kept.len(), deleted, kept.join(", ")
        );
    }
    Ok(json!({ "deleted": deleted, "allocations_removed": alloc_removed, "kept": kept.len() }))
}

// ── Plaid live bank/card feed ───────────────────────────────────────────────

fn plaid_txn_id(transaction_id: &str) -> String {
    let clean: String = transaction_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("btpl_{}", clean)
}

/// Map Plaid's personal_finance_category.primary to our coarse category vocabulary.
fn plaid_category(pfc: &str, direction: &str) -> String {
    let p = pfc.to_uppercase();
    if p.contains("INCOME") { "receipt" }
    else if p.contains("TRANSFER") { "internal_transfer" }
    else if p.contains("LOAN_PAYMENTS") { "card_payment" }
    else if p.contains("BANK_FEES") { "fee" }
    else if p.contains("FOOD_AND_DRINK") { "meals" }
    else if p.contains("GENERAL_MERCHANDISE") { "merchandise" }
    else if p.contains("TRANSPORTATION") { "auto" }
    else if p.contains("TRAVEL") { "travel" }
    else if p.contains("RENT_AND_UTILITIES") { "utilities" }
    else if p.contains("GENERAL_SERVICES") { "professional" }
    else if p.contains("ENTERTAINMENT") { "meals" }
    else if p.contains("PERSONAL_CARE") || p.contains("MEDICAL") || p.contains("HOME_IMPROVEMENT") { "other_expense" }
    else if p.contains("GOVERNMENT_AND_NON_PROFIT") { "taxes" }
    else if direction == "in" { "receipt" } else { "other_expense" }.to_string()
}

#[tauri::command]
pub async fn plaid_set_keys(client_id: String, secret: String, env: String) -> Result<(), String> {
    crate::plaid::set_keys(&client_id, &secret, &env).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plaid_has_keys() -> Result<bool, String> { Ok(crate::plaid::has_keys()) }

/// Keys-set flag + current environment, for the settings UI.
#[tauri::command]
pub async fn plaid_config() -> Result<Value, String> {
    Ok(json!({ "has_keys": crate::plaid::has_keys(), "env": crate::plaid::get_env() }))
}

/// Verify the client_id + secret work against the selected environment BEFORE
/// connecting a bank — creates (and discards) a Link token. Clear pass/fail.
#[tauri::command]
pub async fn plaid_test_keys() -> Result<String, String> {
    crate::plaid::create_link_token().await
        .map(|_| format!("Connected to Plaid {} — keys are valid.", crate::plaid::get_env()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plaid_link_token() -> Result<String, String> {
    crate::plaid::create_link_token().await.map_err(|e| e.to_string())
}

/// Start a HOSTED-Link connect: returns { hosted_link_url, link_token }. The UI
/// opens the URL in the system browser, then polls plaid_connect_poll(link_token).
#[tauri::command]
pub async fn plaid_connect_start() -> Result<Value, String> {
    let (link_token, url) = crate::plaid::create_hosted_link().await.map_err(|e| e.to_string())?;
    Ok(json!({ "link_token": link_token, "hosted_link_url": url }))
}

/// Poll a hosted-link session. Returns {status:"pending"} until the user finishes
/// in the browser; once a public_token appears, exchanges it, stores the bank
/// (deduped on item_id) and returns {status:"connected", institution}.
#[tauri::command]
pub async fn plaid_connect_poll(link_token: String) -> Result<Value, String> {
    let v = crate::plaid::link_token_get(&link_token).await.map_err(|e| e.to_string())?;
    let sessions = v.get("link_sessions").and_then(|s| s.as_array()).cloned().unwrap_or_default();
    for s in &sessions {
        let public_token = s.get("results")
            .and_then(|r| r.get("item_add_results"))
            .and_then(|a| a.as_array())
            .and_then(|arr| arr.iter().find_map(|it| it.get("public_token").and_then(|p| p.as_str())))
            .or_else(|| s.get("on_success").and_then(|o| o.get("public_token")).and_then(|p| p.as_str()));
        let public_token = match public_token { Some(p) => p, None => continue };

        let inst = s.get("on_success").and_then(|o| o.get("metadata")).and_then(|m| m.get("institution")).and_then(|i| i.get("name")).and_then(|n| n.as_str())
            .or_else(|| s.get("results").and_then(|r| r.get("item_add_results")).and_then(|a| a.as_array()).and_then(|arr| arr.first())
                .and_then(|it| it.get("institution")).and_then(|i| i.get("name")).and_then(|n| n.as_str()))
            .unwrap_or("Bank").to_string();

        let (access, item_id) = crate::plaid::exchange(public_token).await.map_err(|e| e.to_string())?;
        let accounts = crate::plaid::accounts_get(&access).await.map_err(|e| e.to_string())?;
        let accounts_json = accounts.get("accounts").cloned().unwrap_or(json!([])).to_string();
        let now = Utc::now().to_rfc3339();
        let env = crate::plaid::get_env();
        {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let exists: bool = conn.query_row("SELECT 1 FROM plaid_items WHERE item_id=?1", [&item_id], |_| Ok(())).is_ok();
            if !exists {
                let id = format!("pi_{}", uuid::Uuid::new_v4().simple());
                conn.execute(
                    "INSERT INTO plaid_items (id, item_id, access_token, institution, cursor, accounts_json, created_at, env)
                     VALUES (?1,?2,?3,?4,'',?5,?6,?7)",
                    rusqlite::params![id, item_id, access, inst, accounts_json, now, env],
                ).map_err(|e| e.to_string())?;
            }
        }
        // Best-effort: hand the token to the server so teammates + hosted sync can use it.
        let _ = crate::netsync::push_plaid_item_to_server(&item_id, &access, &inst, &accounts_json, &env).await;
        return Ok(json!({ "status": "connected", "institution": inst }));
    }
    Ok(json!({ "status": "pending" }))
}

/// Exchange a Link public_token, fetch the item's accounts (for labeling), and
/// store the enrollment device-local.
#[tauri::command]
pub async fn plaid_exchange(public_token: String, institution: String) -> Result<(), String> {
    let (access, item_id) = crate::plaid::exchange(&public_token).await.map_err(|e| e.to_string())?;
    let accounts = crate::plaid::accounts_get(&access).await.map_err(|e| e.to_string())?;
    let accounts_json = accounts.get("accounts").cloned().unwrap_or(json!([])).to_string();
    let id = format!("pi_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let env = crate::plaid::get_env();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        // Dedup on item_id — relinking the same institution must NOT insert a second
        // row, or plaid_balances would sum its accounts twice and double the bank
        // balance in Free Cash. Refresh the token/accounts on the existing row instead.
        let existing: Option<String> = conn.query_row(
            "SELECT id FROM plaid_items WHERE item_id=?1", [&item_id], |r| r.get(0)).ok();
        if let Some(eid) = existing {
            conn.execute(
                "UPDATE plaid_items SET access_token=?1, accounts_json=?2, env=?3 WHERE id=?4",
                rusqlite::params![access, accounts_json, env, eid],
            ).map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO plaid_items (id, item_id, access_token, institution, cursor, accounts_json, created_at, env)
                 VALUES (?1,?2,?3,?4,'',?5,?6,?7)",
                rusqlite::params![id, item_id, access, institution, accounts_json, now, env],
            ).map_err(|e| e.to_string())?;
        }
    }
    // Best-effort: hand the token to the server so teammates + hosted sync can use it.
    let _ = crate::netsync::push_plaid_item_to_server(&item_id, &access, &institution, &accounts_json, &env).await;
    Ok(())
}

#[tauri::command]
pub async fn plaid_list_items() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, institution, accounts_json, created_at FROM plaid_items ORDER BY created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let accts: Vec<Value> = serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default();
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "institution": r.get::<_, String>(1)?,
            "account_count": accts.len(),
            "created_at": r.get::<_, String>(3)?,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn plaid_remove_item(id: String) -> Result<(), String> {
    let access: Option<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT access_token FROM plaid_items WHERE id=?1", [&id], |r| r.get(0)).ok()
    };
    if let Some(a) = access { let _ = crate::plaid::remove_item(&a).await; }
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM plaid_items WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pull new/changed transactions from every connected bank into the bank_txn
/// ledger (dedup on Plaid's transaction_id; cursor-based incremental sync).
#[tauri::command]
pub async fn plaid_sync() -> Result<Value, String> {
    let items: Vec<(String, String, String, String, String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, access_token, cursor, accounts_json, env, institution FROM plaid_items")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, r.get::<_, String>(5)?,
        ))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if items.is_empty() {
        return Err("No banks connected yet — click Connect a bank first.".into());
    }
    let now = Utc::now().to_rfc3339();
    let mut imported = 0i64;
    let mut removed = 0i64;
    let mut unlinked_removed: Vec<String> = Vec::new(); // bank retracted them AFTER they were reviewed/linked
    let mut preparing = false;  // at least one item still extracting after we waited
    let mut results: Vec<Value> = Vec::new(); // per-bank outcome, surfaced in the UI
    // Shared budget (seconds) for waiting on freshly-linked items whose initial
    // extraction is still running — bounds total command time regardless of count.
    let mut wait_budget = 150u64;

    for (item_pk, access, mut cursor, accounts_json, item_env, institution) in items {
        // Sync each item under the environment it was LINKED in (not the current UI
        // setting) so a bank still pulls even if the app is left on the other env.
        // A per-item error is recorded and reported, never failing the whole sync.
        let mut item_imported = 0i64;
        let mut status = "ok";
        let mut error_msg = String::new();
        let accts: Vec<Value> = serde_json::from_str(&accounts_json).unwrap_or_default();
        let label_of = |aid: &str| -> String {
            for a in &accts {
                if a.get("account_id").and_then(|v| v.as_str()) == Some(aid) {
                    let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let mask = a.get("mask").and_then(|v| v.as_str()).unwrap_or("");
                    return if mask.is_empty() { name.to_string() } else { format!("{} \u{00b7}\u{00b7}{}", name, mask) };
                }
            }
            aid.to_string()
        };
        let mut pages = 0;
        loop {
            let outcome = match crate::plaid::transactions_sync(&access, &cursor, &item_env).await {
                Ok(o) => o,
                Err(e) => { status = "error"; error_msg = e.to_string(); break; }
            };
            let page = match outcome {
                crate::plaid::SyncOutcome::Page(p) => p,
                crate::plaid::SyncOutcome::NotReady => {
                    // Extraction still running — back off and retry within the budget.
                    if wait_budget == 0 { status = "preparing"; preparing = true; break; }
                    let delay = wait_budget.min(6);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                    wait_budget -= delay;
                    continue;
                }
            };
            // A fresh item (no cursor yet) that returns an empty first page with no
            // cursor issued is also still preparing — wait+retry rather than exit at 0.
            let added_empty = page.get("added").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true);
            let removed_empty = page.get("removed").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true);
            let next_cursor_now = page.get("next_cursor").and_then(|v| v.as_str()).unwrap_or("");
            let has_more_now = page.get("has_more").and_then(|v| v.as_bool()).unwrap_or(false);
            // First sync of a fresh item: an empty page means Plaid is still
            // preparing the initial extraction — it can hand back a next_cursor
            // BEFORE any history is ready. Wait+retry WITHOUT persisting that
            // cursor; persisting it skips past the history and leaves the item
            // permanently empty (the "connected but 0 transactions" bug).
            if cursor.is_empty() && added_empty && removed_empty && !has_more_now {
                if wait_budget == 0 { status = "preparing"; preparing = true; break; }
                let delay = wait_budget.min(6);
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                wait_budget -= delay;
                continue;
            }
            pages += 1;
            if pages > 60 { break; } // safety cap
            let conn = pool().get().map_err(|e| e.to_string())?;
            if let Some(added) = page.get("added").and_then(|v| v.as_array()) {
                for t in added {
                    let tid = t.get("transaction_id").and_then(|v| v.as_str()).unwrap_or("");
                    if tid.is_empty() { continue; }
                    let id = plaid_txn_id(tid);
                    if conn.query_row("SELECT 1 FROM bank_txn WHERE id=?1", [&id], |_| Ok(())).is_ok() { continue; }
                    let amt = t.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let direction = if amt > 0.0 { "out" } else { "in" };
                    let amount = amt.abs();
                    let label = label_of(t.get("account_id").and_then(|v| v.as_str()).unwrap_or(""));
                    // `name` is the true bank memo (e.g. "Zelle payment to Walmart
                    // Loads JPM…"); Plaid's `merchant_name` over-collapses transfers to
                    // a retailer. Show the real memo as the description so a Zelle to a
                    // business isn't mistaken for a store purchase; keep the clean
                    // merchant as the counterparty (falling back to the memo).
                    let merchant = t.get("merchant_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let raw_name = t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let desc = if raw_name.is_empty() { merchant.clone() } else { raw_name };
                    let cp = if merchant.is_empty() { desc.clone() } else { merchant };
                    let pfc = t.get("personal_finance_category").and_then(|c| c.get("primary")).and_then(|v| v.as_str()).unwrap_or("");
                    let cat = plaid_category(pfc, direction);
                    let date = t.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let s = |v: &str| Value::String(v.to_string());
                    let mut cols = Map::new();
                    cols.insert("account_id".into(), s(&label));
                    cols.insert("posted_at".into(), s(&date));
                    cols.insert("amount".into(), json!(amount));
                    cols.insert("direction".into(), s(direction));
                    cols.insert("description".into(), s(&desc));
                    cols.insert("memo_raw".into(), s(&desc));
                    cols.insert("category".into(), s(&cat));
                    cols.insert("counterparty_name".into(), s(&cp));
                    cols.insert("source_format".into(), s("plaid"));
                    cols.insert("imported_at".into(), s(&now));
                    cols.insert("created_at".into(), s(&now));
                    cols.insert("updated_at".into(), s(&now));
                    if sync::record_upsert("bank_txn", &id, cols).is_err() { continue; }
                    if let Err(e) = conn.execute(
                        "INSERT OR IGNORE INTO bank_txn (id, account_id, posted_at, amount, direction, description, memo_raw, category, counterparty_name, source_format, imported_at, created_at, updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?11)",
                        rusqlite::params![id, label, date, amount, direction, desc, desc, cat, cp, "plaid", now],
                    ) {
                        // Surface an insert failure instead of counting a row that
                        // never landed (previously swallowed → "synced N" but empty).
                        status = "error";
                        error_msg = format!("save failed: {e}");
                        break;
                    }
                    item_imported += 1;
                }
            }
            if let Some(rem) = page.get("removed").and_then(|v| v.as_array()) {
                for r in rem {
                    let tid = r.get("transaction_id").and_then(|v| v.as_str()).unwrap_or("");
                    if tid.is_empty() { continue; }
                    let id = plaid_txn_id(tid);
                    // The bank retracted this transaction — most often a PENDING row
                    // being replaced by its posted twin under a NEW transaction_id.
                    // Honour it. Keeping a retracted row that is reviewed/allocated
                    // would leave TWO rows for one real transaction: the stale one
                    // still holding the allocation and the posted one looking unbooked
                    // and inviting a second — i.e. the double-counted profit this all
                    // exists to prevent. Its allocations go through the SAME synced
                    // delete, so no orphan is minted either.
                    // A completed deal's recorded profit is NOT at risk: it is stored
                    // on the deal, and resync_completed_deal falls back to the last
                    // RECORDED figures for a leg that has no live link — losing a link
                    // can never erase it.
                    let was_finished = bank_txn_is_finished(&conn, &id);
                    let allocs: Vec<String> = conn
                        .prepare("SELECT id FROM bank_allocation WHERE bank_txn_id=?1")
                        .and_then(|mut st| {
                            st.query_map([&id], |r| r.get::<_, String>(0))
                                .map(|rows| rows.filter_map(|x| x.ok()).collect())
                        })
                        .unwrap_or_default();
                    for a in &allocs {
                        let _ = sync::record_delete("bank_allocation", a);
                        let _ = conn.execute("DELETE FROM bank_allocation WHERE id=?1", [a]);
                    }
                    let _ = sync::record_delete("bank_txn", &id);
                    if conn.execute("DELETE FROM bank_txn WHERE id=?1", [&id]).unwrap_or(0) > 0 { removed += 1; }
                    // Finished work disappearing must never be silent — Jack needs to
                    // re-link the posted replacement.
                    if was_finished { unlinked_removed.push(id); }
                }
            }
            // A row failed to persist — do NOT advance the cursor, or Plaid never
            // re-serves this page and those transactions vanish from the ledger.
            // Break here (cursor unchanged) so the next sync retries the same page;
            // the id-exists check + INSERT OR IGNORE make the replay safe.
            if status == "error" { break; }
            cursor = next_cursor_now.to_string();
            let _ = conn.execute("UPDATE plaid_items SET cursor=?1 WHERE id=?2", rusqlite::params![cursor, item_pk]);
            if !has_more_now { break; }
        }
        // Refresh this item's stored balances so Free Cash reflects the CURRENT bank
        // balance instead of the snapshot from link day (which never updated, so the
        // headline silently drifted every day). Best-effort; a failure leaves the
        // prior balance in place. /accounts/get carries balances.current.
        if status != "error" {
            if let Ok(acc) = crate::plaid::accounts_get(&access).await {
                if let Some(list) = acc.get("accounts") {
                    let conn = pool().get().map_err(|e| e.to_string())?;
                    let _ = conn.execute("UPDATE plaid_items SET accounts_json=?1 WHERE id=?2",
                        rusqlite::params![list.to_string(), item_pk]);
                }
            }
        }
        imported += item_imported;
        results.push(json!({
            "institution": institution,
            "env": item_env,
            "imported": item_imported,
            "status": status,
            "error": error_msg,
        }));
    }
    // Best-effort: pre-tag freshly pulled activity with memorized rules. A rules
    // failure must not fail the sync.
    let _ = apply_txn_rules_impl(false);
    crate::netsync::push_now(); // freshly imported bank activity reaches other devices now
    if !unlinked_removed.is_empty() {
        tracing::warn!(
            "plaid_sync: bank retracted {} transaction(s) that were reviewed or linked to a deal — removed and unlinked (usually a pending row replaced by its posted twin; re-link the replacement): {}",
            unlinked_removed.len(), unlinked_removed.join(", ")
        );
    }
    Ok(json!({ "imported": imported, "removed": removed, "unlinked": unlinked_removed.len(), "preparing": preparing, "results": results }))
}

/// Force a full re-pull: reset every bank's sync cursor to the start, then sync.
/// Fixes items whose cursor was advanced past their history (leaving them empty).
#[tauri::command]
pub async fn plaid_resync_all() -> Result<Value, String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE plaid_items SET cursor=''", []).map_err(|e| e.to_string())?;
    }
    plaid_sync().await
}

/// Ask each connected bank for its very latest activity (today's wires / spend),
/// then sync. `/transactions/sync` alone only returns Plaid's cached copy, so
/// same-day items need a forced `/transactions/refresh` first. The refresh is
/// asynchronous at Plaid, so we wait a few seconds, then sync (the 20-min auto-sync
/// backfills anything that lands later).
#[tauri::command]
pub async fn plaid_refresh_sync() -> Result<Value, String> {
    let items: Vec<(String, String)> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT access_token, env FROM plaid_items").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if items.is_empty() { return Err("No banks connected yet — connect a bank first.".into()); }
    for (access, env) in &items {
        let _ = crate::plaid::transactions_refresh(access, env).await;
    }
    // Give Plaid a few seconds to land the fresh pull before we read it.
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    plaid_sync().await
}

// ── Financial engine: money config, Free Cash, loans, AI categorize ─────────

fn read_setting_f64(conn: &rusqlite::Connection, key: &str, default: f64) -> f64 {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .ok().and_then(|s| s.trim().parse().ok()).unwrap_or(default)
}

/// Live balances from connected Plaid banks, captured in each item's accounts_json
/// at link time: depository accounts (checking/savings) sum to the bank balance,
/// credit accounts to the card owed. Returns (bank, card, any_bank_connected).
fn plaid_balances(conn: &rusqlite::Connection) -> (f64, f64, bool) {
    let mut bank = 0.0;
    let mut card = 0.0;
    let mut any = false;
    let mut stmt = match conn.prepare("SELECT accounts_json FROM plaid_items") {
        Ok(s) => s, Err(_) => return (0.0, 0.0, false),
    };
    let rows = match stmt.query_map([], |r| r.get::<_, String>(0)) {
        Ok(r) => r, Err(_) => return (0.0, 0.0, false),
    };
    for aj in rows.filter_map(|r| r.ok()) {
        any = true;
        let accts: Vec<Value> = serde_json::from_str(&aj).unwrap_or_default();
        for a in &accts {
            let cur = a.get("balances").and_then(|b| b.get("current")).and_then(|v| v.as_f64()).unwrap_or(0.0);
            match a.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "credit" => card += cur.abs(),
                "depository" => bank += cur,
                _ => {}
            }
        }
    }
    (bank, card, any)
}

#[tauri::command]
pub async fn get_money_config() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    Ok(json!({
        "bank_balance": read_setting_f64(&conn, "money_bank_balance", 0.0),
        "credit_card_balance": read_setting_f64(&conn, "money_credit_card_balance", 0.0),
        "cash_floor": read_setting_f64(&conn, "money_cash_floor", 0.0),
        "tax_sweep_pct": read_setting_f64(&conn, "money_tax_sweep_pct", 0.30),
        "refund_reserve_pct": read_setting_f64(&conn, "money_refund_reserve_pct", 0.30),
        "war_chest": read_setting_f64(&conn, "money_war_chest", 25000.0),
    }))
}

#[tauri::command]
pub async fn set_money_config(bank_balance: f64, credit_card_balance: f64, cash_floor: f64, tax_sweep_pct: f64, refund_reserve_pct: f64, war_chest: f64) -> Result<(), String> {
    write_setting("money_bank_balance", &format!("{}", bank_balance))?;
    write_setting("money_credit_card_balance", &format!("{}", credit_card_balance))?;
    write_setting("money_cash_floor", &format!("{}", cash_floor))?;
    write_setting("money_tax_sweep_pct", &format!("{}", tax_sweep_pct))?;
    write_setting("money_refund_reserve_pct", &format!("{}", refund_reserve_pct))?;
    write_setting("money_war_chest", &format!("{}", war_chest))?;
    Ok(())
}

/// The Free Cash engine: bank balance minus the liabilities the bank can't see.
#[tauri::command]
pub async fn financials_overview() -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    // Prefer live balances from connected banks (Plaid); fall back to the manual
    // figures only when no bank is linked. Makes Free Cash real automatically.
    let (plaid_bank, plaid_card, has_plaid) = plaid_balances(&conn);
    // Balance sharing: a device WITH the Plaid link publishes its fresh balance so
    // devices without it (Mac, mobile) can show it; a device WITHOUT the link reads
    // that last-known balance, falling back to the manual figure. The Plaid token
    // never leaves the connected device — only these numbers travel.
    let mut balance_source = "manual";
    let mut balance_as_of: Option<String> = None;
    let (bank_balance, credit_card_balance) = if has_plaid {
        let (b, c) = (plaid_bank, plaid_card.max(0.0));
        balance_source = "live";
        tokio::spawn(async move { crate::netsync::publish_bank_balance(b, c).await; });
        (b, c)
    } else if let Some((b, c, at)) = crate::netsync::fetch_published_bank_balance().await {
        balance_source = "synced";
        balance_as_of = Some(at);
        (b, c.max(0.0))
    } else {
        (
            read_setting_f64(&conn, "money_bank_balance", 0.0),
            read_setting_f64(&conn, "money_credit_card_balance", 0.0).max(0.0),
        )
    };
    let cash_floor = read_setting_f64(&conn, "money_cash_floor", 0.0);

    // Supplier payables: unpaid supplier cost on deals where the buyer HAS paid but
    // the deal isn't complete (never ours — ring-fenced). Netted per deal against any
    // supplier-payment the user has already allocated from the bank feed (actuals),
    // clamped at 0 so an over-allocation on one deal can't erase another's payable.
    let supplier_payables: f64 = conn.query_row(
        "SELECT COALESCE(SUM(MAX(0,
            (SELECT COALESCE(SUM(CAST(json_extract(sp.value,'$.amount') AS REAL)),0)
               FROM json_each(COALESCE(NULLIF(df.supplier_payments_json,''),'[]')) sp
              WHERE COALESCE(json_extract(sp.value,'$.paid'),0) != 1)
            - (SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a
                 WHERE a.deal_flow_id=df.id AND a.role='supplier_payment')
         )),0)
         FROM deal_flows df
         WHERE COALESCE(df.archived,0)=0 AND df.stage IN ('payment_received','supplier_paid')
           AND NOT EXISTS (SELECT 1 FROM invoices iv WHERE iv.id=df.invoice_id
                           AND (COALESCE(iv.voided,0)=1 OR COALESCE(iv.archived,0)=1))",
        [], |r| r.get(0)).unwrap_or(0.0);

    // Refund liability (we owe buyers back): per deal, refund_owed minus refunds
    // already paid AND minus refund-out actuals allocated from the bank feed, clamped
    // per deal so an overpaid/archived-deal refund can't cancel another's owed amount.
    // A bank-linked refund lives in BOTH refunds (with bank_txn_id) and
    // bank_allocation (role refund_out) — count it once, on the allocation side,
    // matching refund_status_all. Counting both double-subtracted every linked
    // refund and overstated Free Cash.
    let refund_liability: f64 = conn.query_row(
        "SELECT COALESCE(SUM(MAX(0,
            df.refund_owed
            - (SELECT COALESCE(SUM(amount),0) FROM refunds r WHERE r.deal_flow_id=df.id AND COALESCE(r.bank_txn_id,'')='')
            - (SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a
                 WHERE a.deal_flow_id=df.id AND a.role='refund_out')
         )),0)
         FROM deal_flows df
         WHERE COALESCE(df.archived,0)=0 AND COALESCE(df.refund_owed,0) > 0.01",
        [], |r| r.get(0)).unwrap_or(0.0);

    // Reserves: a slice of THIS YEAR's realized (completed-deal) NET PROFIT set aside
    // for taxes, and another slice set aside against future refunds — i.e. the amount
    // to move into a separate refunds account. Percentages are fractions (0.30 = 30%).
    // Refund reserve is on PROFIT, not revenue: reserving 10% of gross revenue
    // over-reserved by a mile and crushed Free Cash.
    let tax_sweep_pct = read_setting_f64(&conn, "money_tax_sweep_pct", 0.30);
    let refund_reserve_pct = read_setting_f64(&conn, "money_refund_reserve_pct", 0.30);
    // Accuracy contract: archived + fell-through deals out; refunds netted off profit
    // so we don't reserve against money already handed back.
    let year_profit: f64 = conn.query_row(
        "SELECT COALESCE(SUM(df.net_profit - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id),0)),0) \
         FROM deal_flows df WHERE df.stage='complete' AND COALESCE(df.archived,0)=0 \
           AND NOT EXISTS (SELECT 1 FROM invoices iv WHERE iv.id=df.invoice_id AND (COALESCE(iv.voided,0)=1 OR COALESCE(iv.archived,0)=1)) \
           AND df.completed_at >= date('now','start of year')",
        [], |r| r.get::<_, f64>(0)).unwrap_or(0.0).max(0.0);
    let tax_reserve = (year_profit * tax_sweep_pct).max(0.0);
    // 30% of what we've actually netted this year — the target to park in a separate
    // refunds account. Link that account later and reconcile against this number.
    let refund_reserve = (year_profit * refund_reserve_pct).max(0.0);

    // Loans still owed (principal − set aside) for open loans.
    let loan_outstanding: f64 = conn.query_row(
        "SELECT COALESCE(SUM(CASE WHEN principal - set_aside > 0 THEN principal - set_aside ELSE 0 END),0) FROM loan WHERE status='open'",
        [], |r| r.get(0)).unwrap_or(0.0);

    let free_cash = round2(bank_balance - credit_card_balance - supplier_payables - refund_liability - tax_reserve - refund_reserve - cash_floor - loan_outstanding);

    // Trailing monthly opex (last 90 days / 3) for the runway/status.
    let opex_3mo: f64 = conn.query_row(
        "SELECT COALESCE(SUM(amount),0) FROM business_expense WHERE date >= date('now','-90 days')", [], |r| r.get(0)).unwrap_or(0.0);
    let trailing_opex = opex_3mo / 3.0;
    let runway = if trailing_opex > 0.0 { free_cash / trailing_opex } else { f64::INFINITY };
    let status = if free_cash > 0.0 && (trailing_opex <= 0.0 || runway >= 3.0) { "green" }
                 else if free_cash > 0.0 { "yellow" } else { "red" };

    // Only ACTIVE refunds (still owed after payments + bank refund-outs) — a fully
    // refunded deal is done and shouldn't count as outstanding.
    let refund_deals: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deal_flows df WHERE COALESCE(df.archived,0)=0 AND df.refund_owed > 0.01
           AND (df.refund_owed
                - COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.deal_flow_id=df.id AND COALESCE(r.bank_txn_id,'')=''),0)
                - COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.deal_flow_id=df.id AND a.role='refund_out'),0)
               ) > 0.01",
        [], |r| r.get(0)).unwrap_or(0);
    let stale_unallocated: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bank_txn bt WHERE bt.direction='in' AND bt.category != 'internal_transfer'
           AND bt.posted_at != '' AND bt.posted_at <= date('now','-7 days')
           AND COALESCE((SELECT SUM(a.amount) FROM bank_allocation a WHERE a.bank_txn_id=bt.id),0) < bt.amount - 0.01",
        [], |r| r.get(0)).unwrap_or(0);

    // Actuals reconciled from the bank feed via allocations (totals by role), so the
    // dashboard can show how much of the money math is backed by real transactions.
    let war_chest = read_setting_f64(&conn, "money_war_chest", 25000.0).max(0.0);
    // Actuals exclude allocations whose deal was archived (soft-deleted) — a dead
    // deal's paired money shouldn't count toward buyer-in / supplier-paid / refunds.
    let alloc_role_sum = |role: &str| -> f64 {
        conn.query_row(
            "SELECT COALESCE(SUM(a.amount),0) FROM bank_allocation a \
             JOIN deal_flows d ON d.id=a.deal_flow_id WHERE a.role=?1 AND COALESCE(d.archived,0)=0",
            [role], |r| r.get(0)).unwrap_or(0.0)
    };

    Ok(json!({
        "bank_balance": round2(bank_balance),
        "credit_card_balance": round2(credit_card_balance),
        "supplier_payables": round2(supplier_payables),
        "refund_liability": round2(refund_liability),
        "tax_reserve": round2(tax_reserve),
        "refund_reserve": round2(refund_reserve),
        "refund_reserve_base": round2(year_profit),
        "refund_reserve_pct": refund_reserve_pct,
        "cash_floor": round2(cash_floor),
        "loan_outstanding": round2(loan_outstanding),
        "war_chest": round2(war_chest),
        "free_cash": free_cash,
        // True when a bank is connected via Plaid — the bank/card balances are then
        // live from the feed, so the manual Adjust fields are display-only.
        "has_plaid": has_plaid,
        // "live" = Plaid on this device; "synced" = last-known balance from the
        // connected device (balance_as_of set); "manual" = the entered figure.
        "balance_source": balance_source,
        "balance_as_of": balance_as_of,
        "status": status,
        "runway_months": if runway.is_finite() { round2(runway) } else { -1.0 },
        "alerts": { "refund_deals": refund_deals, "stale_unallocated_in": stale_unallocated },
        "allocated_actuals": {
            "buyer_in": round2(alloc_role_sum("buyer_payment")),
            "supplier_paid": round2(alloc_role_sum("supplier_payment")),
            "refunds_out": round2(alloc_role_sum("refund_out")),
        },
    }))
}

#[tauri::command]
pub async fn list_loans() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id,name,lender,principal,set_aside,received_at,bank_txn_id,status,paid_at,note FROM loan ORDER BY received_at DESC, created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        let principal: f64 = r.get(3)?;
        let set_aside: f64 = r.get(4)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "lender": r.get::<_, String>(2)?,
            "principal": principal,
            "set_aside": set_aside,
            "received_at": r.get::<_, String>(5)?,
            "bank_txn_id": r.get::<_, String>(6)?,
            "status": r.get::<_, String>(7)?,
            "paid_at": r.get::<_, String>(8)?,
            "note": r.get::<_, String>(9)?,
            "outstanding": ((principal - set_aside).max(0.0) * 100.0).round() / 100.0,
        }))
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_loan(name: String, lender: String, principal: f64, received_at: String, bank_txn_id: String, note: String) -> Result<String, String> {
    let id = format!("loan_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("lender".into(), json!(lender));
    cols.insert("principal".into(), json!(principal));
    cols.insert("set_aside".into(), json!(0.0));
    cols.insert("received_at".into(), json!(received_at));
    cols.insert("bank_txn_id".into(), json!(bank_txn_id));
    cols.insert("status".into(), json!("open"));
    cols.insert("note".into(), json!(note));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("loan", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO loan (id,name,lender,principal,set_aside,received_at,bank_txn_id,status,note,created_at,updated_at)
         VALUES (?1,?2,?3,?4,0,?5,?6,'open',?7,?8,?8)",
        rusqlite::params![id, name, lender, principal, received_at, bank_txn_id, note, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn update_loan(id: String, name: String, lender: String, principal: f64, set_aside: f64, status: String, note: String, received_at: Option<String>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let paid_at = if status == "paid" { now.clone() } else { String::new() };
    // received_at is optional — a typo'd disbursement date can now be corrected in
    // edit; only overwrite when a non-empty value is supplied.
    let rec = received_at.unwrap_or_default();
    let mut cols = Map::new();
    cols.insert("name".into(), json!(name));
    cols.insert("lender".into(), json!(lender));
    cols.insert("principal".into(), json!(principal));
    cols.insert("set_aside".into(), json!(set_aside));
    cols.insert("status".into(), json!(status));
    cols.insert("paid_at".into(), json!(paid_at));
    cols.insert("note".into(), json!(note));
    cols.insert("updated_at".into(), json!(now));
    if !rec.is_empty() { cols.insert("received_at".into(), json!(rec)); }
    sync::record_upsert("loan", &id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE loan SET name=?1,lender=?2,principal=?3,set_aside=?4,status=?5,paid_at=?6,note=?7,updated_at=?8, \
                received_at=CASE WHEN ?9<>'' THEN ?9 ELSE received_at END WHERE id=?10",
        rusqlite::params![name, lender, principal, set_aside, status, paid_at, note, now, rec, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_loan(id: String) -> Result<(), String> {
    sync::record_delete("loan", &id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM loan WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// AI-categorize unreviewed transactions (suggestions — does not mark reviewed).
/// Uses the configured AI model; errors clearly if none is set up.
#[tauri::command]
pub async fn ai_categorize_bank_txns() -> Result<Value, String> {
    let items: Vec<Value> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            // Only UNcategorized rows — the caller loops until "remaining" (reviewed=0
            // AND category='') stops falling. Without this filter the batch kept
            // re-sending the same 40 already-categorized rows, burning AI calls
            // without ever reaching the real backlog.
            "SELECT id, description, direction FROM bank_txn WHERE reviewed=0 AND COALESCE(category,'')='' ORDER BY posted_at DESC LIMIT 40",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({
            "id": r.get::<_, String>(0)?,
            "description": r.get::<_, String>(1)?,
            "direction": r.get::<_, String>(2)?,
        }))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if items.is_empty() {
        return Ok(json!({ "updated": 0, "remaining": 0 }));
    }
    let out = crate::ai::categorize_transactions(&json!(items)).await.map_err(|e| e.to_string())?;
    let results = out.get("results").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let now = Utc::now().to_rfc3339();
    let mut updated = 0;
    for r in results {
        let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cat = r.get("category").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cp = r.get("counterparty").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() || cat.is_empty() { continue; }
        let mut cols = Map::new();
        cols.insert("category".into(), json!(cat));
        if !cp.is_empty() { cols.insert("counterparty_name".into(), json!(cp)); }
        cols.insert("updated_at".into(), json!(now));
        if sync::record_upsert("bank_txn", &id, cols).is_err() { continue; }
        let conn = pool().get().map_err(|e| e.to_string())?;
        let _ = if !cp.is_empty() {
            conn.execute("UPDATE bank_txn SET category=?1, counterparty_name=?2, updated_at=?3 WHERE id=?4", rusqlite::params![cat, cp, now, id])
        } else {
            conn.execute("UPDATE bank_txn SET category=?1, updated_at=?2 WHERE id=?3", rusqlite::params![cat, now, id])
        };
        updated += 1;
    }
    // How many still need categorizing after this batch, so the UI can loop to zero.
    let remaining: i64 = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COUNT(*) FROM bank_txn WHERE reviewed=0 AND COALESCE(category,'')=''",
            [], |r| r.get(0)).unwrap_or(0)
    };
    Ok(json!({ "updated": updated, "remaining": remaining }))
}

// ── Loan tagging + memorized auto-tag rules ─────────────────────────────────

/// Tag a whole bank transaction to a loan: sets counterparty_type='loan' + the
/// loan id/name on the txn itself (no synced-schema change) and derives the
/// category from the txn's direction — money-in books as loan_received, money-out
/// as loan_repayment. Mirrors set_bank_txn_review's sync (record_upsert + local
/// execute). Leaves `reviewed` alone, like allocate_bank_txn.
#[tauri::command]
pub async fn tag_bank_txn_to_loan(bank_txn_id: String, loan_id: String) -> Result<(), String> {
    let direction: String = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        // Validate the loan exists so we never create a dangling tag.
        conn.query_row("SELECT 1 FROM loan WHERE id=?1", [&loan_id], |_| Ok(()))
            .map_err(|_| "Loan not found".to_string())?;
        conn.query_row("SELECT direction FROM bank_txn WHERE id=?1", [&bank_txn_id], |r| r.get(0))
            .map_err(|_| "Transaction not found".to_string())?
    };
    let category = if direction == "in" { "loan_received" } else { "loan_repayment" };
    let now = Utc::now().to_rfc3339();
    // Keep the original payee (counterparty_name) — the loan link lives in
    // counterparty_type/id and the UI derives the loan label from those. Overwriting
    // the name destroyed the bank memo (breaking payee display + rule matching) and
    // untag then couldn't restore it.
    let mut cols = Map::new();
    cols.insert("category".into(), json!(category));
    cols.insert("counterparty_type".into(), json!("loan"));
    cols.insert("counterparty_id".into(), json!(loan_id));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("bank_txn", &bank_txn_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE bank_txn SET category=?1, counterparty_type='loan', counterparty_id=?2, updated_at=?3 WHERE id=?4",
        rusqlite::params![category, loan_id, now, bank_txn_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a loan tag from a transaction — clears the loan counterparty and resets
/// its category so it returns to the review queue unclassified.
#[tauri::command]
pub async fn untag_bank_txn_loan(bank_txn_id: String) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    // Leave counterparty_name intact — tag no longer overwrites it, so the original
    // bank payee is still there and untag just clears the loan link + category.
    let mut cols = Map::new();
    cols.insert("category".into(), json!(""));
    cols.insert("counterparty_type".into(), json!(""));
    cols.insert("counterparty_id".into(), json!(""));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("bank_txn", &bank_txn_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE bank_txn SET category='', counterparty_type='', counterparty_id='', updated_at=?1 WHERE id=?2",
        rusqlite::params![now, bank_txn_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// The transactions tagged to one loan, plus received / repaid totals (kind is
/// derived from each txn's direction — money-in received, money-out repaid).
#[tauri::command]
pub async fn loan_ledger(loan_id: String) -> Result<Value, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT posted_at, description, amount, direction FROM bank_txn
         WHERE counterparty_type='loan' AND counterparty_id=?1
         ORDER BY posted_at DESC, created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, f64, String)> = stmt.query_map([&loan_id], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, String>(3)?,
    ))).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let mut received = 0.0;
    let mut repaid = 0.0;
    let entries: Vec<Value> = rows.iter().map(|(posted, desc, amt, dir)| {
        let kind = if dir == "in" { received += amt; "received" } else { repaid += amt; "repayment" };
        json!({ "posted_at": posted, "description": desc, "amount": amt, "kind": kind })
    }).collect();
    Ok(json!({
        "entries": entries,
        "received_total": (received * 100.0).round() / 100.0,
        "repaid_total": (repaid * 100.0).round() / 100.0,
    }))
}

/// Bridge the loan's feed-tagged repayments into its `set_aside` field (which
/// drives outstanding = principal − set_aside). SETS set_aside to the total repaid
/// via the feed (not additive) so the manual editor and the feed stay consistent.
/// Returns the new set_aside.
#[tauri::command]
pub async fn apply_loan_repayments_to_set_aside(loan_id: String) -> Result<f64, String> {
    let repaid: f64 = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COALESCE(SUM(amount),0) FROM bank_txn WHERE counterparty_type='loan' AND counterparty_id=?1 AND direction='out'",
            [&loan_id], |r| r.get(0)).unwrap_or(0.0)
    };
    let set_aside = (repaid * 100.0).round() / 100.0;
    let now = Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("set_aside".into(), json!(set_aside));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("loan", &loan_id, cols).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE loan SET set_aside=?1, updated_at=?2 WHERE id=?3",
        rusqlite::params![set_aside, now, loan_id]).map_err(|e| e.to_string())?;
    Ok(set_aside)
}

/// Create a memorized auto-tag rule (device-local, not synced). `match_counterparty`
/// is matched at apply time against a txn's counterparty (exact) or description
/// (contains), case-insensitive. target_type is "deal" | "loan" | "expense"; for a
/// loan rule target_id is the loan id (deal rules memorize category + counterparty
/// only, so target_id is empty — a one-off deal id shouldn't auto-apply forward).
#[tauri::command]
pub async fn create_txn_rule(
    match_counterparty: String, category: String, target_type: String, target_id: String, role: String,
    direction: String,
) -> Result<String, String> {
    if match_counterparty.trim().is_empty() {
        return Err("A rule needs a counterparty to match on".into());
    }
    // '' = any direction, 'in' = money in only, 'out' = money out only.
    let dir = match direction.trim() { "in" => "in", "out" => "out", _ => "" };
    let id = format!("txnrule_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let conn = pool().get().map_err(|e| e.to_string())?;
    // One rule per (counterparty, direction): replace any existing so re-tagging
    // the same payer just updates the rule instead of stacking duplicates.
    conn.execute(
        "DELETE FROM txn_rule WHERE lower(trim(match_counterparty))=lower(trim(?1)) AND direction=?2",
        rusqlite::params![match_counterparty, dir],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO txn_rule (id, match_counterparty, category, target_type, target_id, role, direction, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![id, match_counterparty, category, target_type, target_id, role, dir, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

/// List memorized auto-tag rules, resolving the loan name for loan-target rules.
#[tauri::command]
pub async fn list_txn_rules() -> Result<Vec<Value>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT r.id, r.match_counterparty, r.category, r.target_type, r.target_id, r.role, r.created_at,
                COALESCE((SELECT name FROM loan WHERE id=r.target_id),''), r.direction
         FROM txn_rule r ORDER BY r.created_at",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(json!({
        "id": r.get::<_, String>(0)?,
        "match_counterparty": r.get::<_, String>(1)?,
        "category": r.get::<_, String>(2)?,
        "target_type": r.get::<_, String>(3)?,
        "target_id": r.get::<_, String>(4)?,
        "role": r.get::<_, String>(5)?,
        "created_at": r.get::<_, String>(6)?,
        "loan_name": r.get::<_, String>(7)?,
        "direction": r.get::<_, String>(8)?,
    }))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Delete a memorized auto-tag rule (device-local).
#[tauri::command]
pub async fn delete_txn_rule(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM txn_rule WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply memorized rules to un-reviewed, un-categorized transactions — first
/// matching rule wins. Pre-fills category (and, for loan-target rules, the loan
/// tag with a direction-derived loan_received/loan_repayment category) but LEAVES
/// reviewed=0 so the row stays in the review queue. The resulting bank_txn edits
/// are synced; the rules themselves are device-local. Returns the count updated.
fn apply_txn_rules_impl(override_existing: bool) -> Result<i64, String> {
    let rules: Vec<(String, String, String, String, String)> = {
        // (match_counterparty, category, target_type, target_id, direction)
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT match_counterparty, category, target_type, target_id, direction FROM txn_rule ORDER BY created_at",
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    if rules.is_empty() { return Ok(0); }
    let candidates: Vec<(String, String, String, String)> = {
        // (id, counterparty_name, description, direction)
        // Manual apply (override_existing) re-tags ANY unbooked row so a rule can
        // overwrite Plaid's auto-guessed category — every import already has a
        // category, so blank-only matching found nothing. The automatic post-sync
        // pass keeps blank-only so it can't clobber categories you've set.
        let conn = pool().get().map_err(|e| e.to_string())?;
        let sql = if override_existing {
            "SELECT id, counterparty_name, description, direction FROM bank_txn WHERE reviewed=0"
        } else {
            "SELECT id, counterparty_name, description, direction FROM bank_txn WHERE reviewed=0 AND COALESCE(category,'')=''"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((
            r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
        ))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let now = Utc::now().to_rfc3339();
    let mut updated = 0i64;
    for (id, cp, desc, direction) in candidates {
        let cp_l = cp.to_lowercase();
        let desc_l = desc.to_lowercase();
        let rule = rules.iter().find(|(m, _, _, _, dir)| {
            let m = m.trim().to_lowercase();
            // Direction-scoped: '' matches either way, 'in'/'out' must equal the txn's.
            let dir_ok = dir.is_empty() || dir.as_str() == direction.as_str();
            dir_ok && !m.is_empty() && (cp_l == m || desc_l.contains(&m))
        });
        let (_, rule_cat, target_type, target_id, _) = match rule { Some(r) => r, None => continue };
        let is_loan = target_type == "loan" && !target_id.is_empty();
        // A category-less non-loan rule has nothing to apply — skipping it keeps a
        // blank rule from mass-clearing categories on every matching transaction.
        if !is_loan && rule_cat.trim().is_empty() { continue; }
        // Loan rules derive the category from direction so a mixed set books each
        // side correctly; other rules use the memorized category verbatim.
        let (category, loan_name) = if is_loan {
            let conn = pool().get().map_err(|e| e.to_string())?;
            let name: String = conn.query_row("SELECT name FROM loan WHERE id=?1", [target_id], |r| r.get(0)).unwrap_or_default();
            let cat = if direction == "in" { "loan_received" } else { "loan_repayment" };
            (cat.to_string(), name)
        } else {
            (rule_cat.clone(), String::new())
        };
        let mut cols = Map::new();
        cols.insert("category".into(), json!(category));
        if is_loan {
            cols.insert("counterparty_type".into(), json!("loan"));
            cols.insert("counterparty_id".into(), json!(target_id));
            cols.insert("counterparty_name".into(), json!(loan_name));
        }
        cols.insert("updated_at".into(), json!(now));
        if sync::record_upsert("bank_txn", &id, cols).is_err() { continue; }
        let conn = pool().get().map_err(|e| e.to_string())?;
        let res = if is_loan {
            conn.execute(
                "UPDATE bank_txn SET category=?1, counterparty_type='loan', counterparty_id=?2, counterparty_name=?3, updated_at=?4 WHERE id=?5",
                rusqlite::params![category, target_id, loan_name, now, id],
            )
        } else {
            conn.execute(
                "UPDATE bank_txn SET category=?1, updated_at=?2 WHERE id=?3",
                rusqlite::params![category, now, id],
            )
        };
        if res.unwrap_or(0) > 0 { updated += 1; }
    }
    Ok(updated)
}

/// Manually apply memorized auto-tag rules now. Returns { updated }.
#[tauri::command]
pub async fn apply_txn_rules() -> Result<Value, String> {
    let n = apply_txn_rules_impl(true)?;
    Ok(json!({ "updated": n }))
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
pub async fn update_signup_rule(
    id: String,
    input: crate::signup_rules::RuleInput,
) -> Result<(), String> {
    crate::signup_rules::update_rule(&id, input).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_signup_rule(id: String) -> Result<(), String> {
    crate::signup_rules::delete_rule(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_signup_rule(id: String, active: bool) -> Result<(), String> {
    crate::signup_rules::toggle_rule(&id, active).map_err(|e| e.to_string())
}

/// Preview what a form-capture rule would extract: fetch the most recent email in
/// `inbox_id` matching the (optional) sender/subject regexes, run the deterministic
/// form parser, and return the structured customer. Returns
/// `{ found, customer, matched_from, matched_subject }`.
#[tauri::command]
pub async fn preview_form_capture(
    inbox_id: String,
    sender_pattern: Option<String>,
    subject_pattern: Option<String>,
) -> Result<Value, String> {
    let email = crate::email::fetch_latest_matching(&inbox_id, sender_pattern, subject_pattern)
        .await
        .map_err(|e| e.to_string())?;
    match email {
        None => Ok(json!({
            "found": false, "customer": Value::Null,
            "matched_from": "", "matched_subject": "",
        })),
        Some(em) => {
            let customer = crate::form_parser::parse_form_email(&em.body_text);
            Ok(json!({
                "found": true,
                "customer": customer,
                "matched_from": em.from,
                "matched_subject": em.subject,
            }))
        }
    }
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

/// Append the CAN-SPAM opt-out footer to a marketing email. Prefers the server-signed
/// one-click link; falls back to a reply-to-unsubscribe line so every email carries an
/// opt-out even if the link couldn't be minted (offline).
fn append_unsub_footer(body: &str, business: &str, url: Option<&str>) -> String {
    let who = { let b = business.trim(); if b.is_empty() { "us".to_string() } else { b.to_string() } };
    match url {
        Some(u) => format!("{body}\n\n—\nYou're receiving this from {who} because you asked us to send you deals.\nTo unsubscribe: {u}"),
        None => format!("{body}\n\n—\nYou're receiving this from {who} because you asked us to send you deals.\nTo stop receiving these, reply to this email with \"unsubscribe\"."),
    }
}

#[tauri::command]
pub async fn send_newsletter(
    app: tauri::AppHandle,
    newsletter_id: String,
    client_ids: Vec<String>,
    subject_template: String,
    body_template: String,
    attachment_path: Option<String>,
) -> Result<NewsletterSendResult, String> {
    use tauri::Emitter;
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
    // Mark the newsletter as actively sending so it shows in history as still-working
    // (not just in the composer) — you can close out and watch it finish.
    let _ = conn.execute("UPDATE newsletters SET status='sending', recipient_count=?1, sent_count=0 WHERE id=?2", rusqlite::params![total, &newsletter_id]);

    // Compliance: every marketing email gets an opt-out footer (CAN-SPAM), unless the
    // user explicitly turned it off in the newsletter settings (default ON). The one-
    // click link is server-signed, so collect the sendable recipients' emails and mint
    // the URLs in one batch up front; a reply-to-unsubscribe line is the offline fallback.
    let unsub_enabled: bool = conn
        .query_row("SELECT value FROM settings WHERE key='newsletter_unsubscribe_enabled'", [], |r| r.get::<_, String>(0))
        .ok()
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    let business_name: String = conn
        .query_row("SELECT value FROM settings WHERE key='business_name'", [], |r| r.get::<_, String>(0))
        .unwrap_or_default();
    let unsub_urls: std::collections::HashMap<String, String> = if unsub_enabled {
        let mut emails: Vec<String> = Vec::new();
        for cid in &client_ids {
            if let Ok(Some(email)) = conn.query_row(
                "SELECT email FROM clients WHERE id=?1 \
                   AND (is_blacklisted IS NULL OR is_blacklisted = 0) \
                   AND COALESCE(exclusive,0) = 0 \
                   AND COALESCE(json_extract(metadata,'$.exclusive'),0) NOT IN (1,'true')",
                [cid], |r| r.get::<_, Option<String>>(0),
            ) {
                if !email.trim().is_empty() { emails.push(email); }
            }
        }
        crate::netsync::fetch_unsubscribe_urls(emails).await
    } else {
        std::collections::HashMap::new()
    };

    for cid in &client_ids {
        let sid = Uuid::new_v4().to_string();
        // Final line of defense: never mass-email a blacklisted or "No bulk email"
        // (exclusive) client, no matter how their id reached this list (Add-all,
        // Clients-view preselect, manual add, a stale selection). The flag lives in
        // BOTH the `exclusive` column and `metadata.$.exclusive`, so check both —
        // mirrors the server scheduler's resolve_recipients. A filtered-out client
        // returns no row → skipped, exactly like a blacklisted one.
        let client_row: Option<(String, Option<String>)> = conn.query_row(
            "SELECT name, email FROM clients WHERE id=?1 \
               AND (is_blacklisted IS NULL OR is_blacklisted = 0) \
               AND COALESCE(exclusive,0) = 0 \
               AND COALESCE(json_extract(metadata,'$.exclusive'),0) NOT IN (1,'true')", [cid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).ok();
        let (name, email) = match client_row {
            Some(v) => v,
            None => { skipped += 1; continue; }
        };

        let subj = crate::template::substitute_variables(&subject_template, cid, &conn);
        let body = crate::template::substitute_variables(&body_template, cid, &conn);

        match &email {
            Some(addr) if !addr.is_empty() => {
                let body_out = if unsub_enabled {
                    append_unsub_footer(&body, &business_name, unsub_urls.get(addr).map(|s| s.as_str()))
                } else {
                    body.clone()
                };
                match crate::email::send(addr, &subj, &body_out, attachment_path.as_deref()).await {
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
        // Live progress for the compose view (works for immediate sends, not just scheduled).
        let _ = app.emit("newsletter_send_progress", json!({
            "sent": sent, "failed": failed, "skipped": skipped, "total": total,
            "done": sent + failed + skipped,
        }));
        // Persist progress so the history view shows it live even with the composer closed.
        let _ = conn.execute("UPDATE newsletters SET sent_count=?1 WHERE id=?2", rusqlite::params![sent + failed + skipped, &newsletter_id]);
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

// ---- Recurring newsletter schedules ----

#[derive(serde::Serialize)]
pub struct NewsletterSchedule {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub recipient_filter: String,
    pub interval_type: String,
    pub interval_value: i64,
    pub send_hour: i64,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub active: i64,
    pub created_at: String,
}

const NL_SCHED_COLS: &str = "id, name, subject, body, recipient_filter, interval_type, interval_value, send_hour, next_run_at, last_run_at, active, created_at";

fn map_nl_schedule(r: &rusqlite::Row) -> rusqlite::Result<NewsletterSchedule> {
    Ok(NewsletterSchedule {
        id: r.get(0)?, name: r.get(1)?, subject: r.get(2)?, body: r.get(3)?,
        recipient_filter: r.get(4)?, interval_type: r.get(5)?, interval_value: r.get(6)?,
        send_hour: r.get(7)?, next_run_at: r.get(8)?, last_run_at: r.get(9)?,
        active: r.get(10)?, created_at: r.get(11)?,
    })
}

/// Next run timestamp after `from`, at the chosen hour, advanced by the cadence.
fn nl_compute_next_run(from: chrono::DateTime<Utc>, interval_type: &str, interval_value: i64, send_hour: i64) -> String {
    use chrono::Timelike;
    let step = interval_value.max(1);
    let mut next = match interval_type {
        "daily" => from + chrono::Duration::days(step),
        "monthly" => from + chrono::Duration::days(30 * step),
        _ => from + chrono::Duration::weeks(step),
    };
    let hour = send_hour.clamp(0, 23) as u32;
    next = next.with_hour(hour).and_then(|d| d.with_minute(0)).and_then(|d| d.with_second(0)).unwrap_or(next);
    next.to_rfc3339()
}

#[tauri::command]
pub async fn list_newsletter_schedules() -> Result<Vec<NewsletterSchedule>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {} FROM newsletter_schedules ORDER BY created_at DESC", NL_SCHED_COLS);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_nl_schedule).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_newsletter_schedule(
    name: String,
    subject: String,
    body: String,
    recipient_filter: String,
    interval_type: String,
    interval_value: i64,
    send_hour: i64,
) -> Result<NewsletterSchedule, String> {
    if name.trim().is_empty() || subject.trim().is_empty() {
        return Err("Name and subject are required.".into());
    }
    let conn = pool().get().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let now_str = now.to_rfc3339();
    let next_run = nl_compute_next_run(now, &interval_type, interval_value, send_hour);

    conn.execute(
        "INSERT INTO newsletter_schedules
            (id, name, subject, body, recipient_filter, interval_type, interval_value, send_hour, next_run_at, last_run_at, active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 1, ?10)",
        rusqlite::params![id, name, subject, body, recipient_filter, interval_type, interval_value, send_hour, next_run, now_str],
    ).map_err(|e| e.to_string())?;

    let mut cols = serde_json::Map::new();
    cols.insert("name".into(), serde_json::Value::String(name.clone()));
    cols.insert("subject".into(), serde_json::Value::String(subject.clone()));
    cols.insert("body".into(), serde_json::Value::String(body.clone()));
    cols.insert("recipient_filter".into(), serde_json::Value::String(recipient_filter.clone()));
    cols.insert("interval_type".into(), serde_json::Value::String(interval_type.clone()));
    cols.insert("interval_value".into(), serde_json::json!(interval_value));
    cols.insert("send_hour".into(), serde_json::json!(send_hour));
    cols.insert("next_run_at".into(), serde_json::Value::String(next_run.clone()));
    cols.insert("active".into(), serde_json::json!(1));
    cols.insert("created_at".into(), serde_json::Value::String(now_str.clone()));
    crate::sync::record_upsert("newsletter_schedules", &id, cols).map_err(|e| e.to_string())?;

    Ok(NewsletterSchedule {
        id, name, subject, body, recipient_filter, interval_type, interval_value,
        send_hour, next_run_at: next_run, last_run_at: None, active: 1, created_at: now_str,
    })
}

#[tauri::command]
pub async fn update_newsletter_schedule(
    id: String,
    name: Option<String>,
    subject: Option<String>,
    body: Option<String>,
    recipient_filter: Option<String>,
    interval_type: Option<String>,
    interval_value: Option<i64>,
    send_hour: Option<i64>,
    active: Option<i64>,
) -> Result<NewsletterSchedule, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut cols = serde_json::Map::new();
    if let Some(v) = &name { cols.insert("name".into(), serde_json::Value::String(v.clone())); }
    if let Some(v) = &subject { cols.insert("subject".into(), serde_json::Value::String(v.clone())); }
    if let Some(v) = &body { cols.insert("body".into(), serde_json::Value::String(v.clone())); }
    if let Some(v) = &recipient_filter { cols.insert("recipient_filter".into(), serde_json::Value::String(v.clone())); }
    if let Some(v) = &interval_type { cols.insert("interval_type".into(), serde_json::Value::String(v.clone())); }
    if let Some(v) = interval_value { cols.insert("interval_value".into(), serde_json::json!(v)); }
    if let Some(v) = send_hour { cols.insert("send_hour".into(), serde_json::json!(v)); }
    if let Some(v) = active { cols.insert("active".into(), serde_json::json!(v)); }

    if interval_type.is_some() || interval_value.is_some() || send_hour.is_some() {
        let (it, iv, sh): (String, i64, i64) = conn.query_row(
            "SELECT interval_type, interval_value, send_hour FROM newsletter_schedules WHERE id=?1",
            [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|e| e.to_string())?;
        let it = interval_type.clone().unwrap_or(it);
        let iv = interval_value.unwrap_or(iv);
        let sh = send_hour.unwrap_or(sh);
        let next = nl_compute_next_run(Utc::now(), &it, iv, sh);
        cols.insert("next_run_at".into(), serde_json::Value::String(next));
    }

    if cols.is_empty() {
        return Err("Nothing to update.".into());
    }

    let sets: Vec<String> = cols.keys().enumerate().map(|(i, k)| format!("{}=?{}", k, i + 1)).collect();
    let sql = format!("UPDATE newsletter_schedules SET {} WHERE id=?{}", sets.join(", "), cols.len() + 1);
    let mut params: Vec<rusqlite::types::Value> = cols.values().map(|v| match v {
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        serde_json::Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
        _ => rusqlite::types::Value::Null,
    }).collect();
    params.push(rusqlite::types::Value::Text(id.clone()));
    conn.execute(&sql, rusqlite::params_from_iter(params.iter())).map_err(|e| e.to_string())?;

    crate::sync::record_upsert("newsletter_schedules", &id, cols).map_err(|e| e.to_string())?;

    let sql = format!("SELECT {} FROM newsletter_schedules WHERE id=?1", NL_SCHED_COLS);
    conn.query_row(&sql, [&id], map_nl_schedule).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_newsletter_schedule(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM newsletter_schedules WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    crate::sync::record_delete("newsletter_schedules", &id).map_err(|e| e.to_string())?;
    Ok(())
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

/// Proper fix for "SMTP works on desktop but not the Pi": copy the desktop's
/// working email login to the Syncthing-synced `settings` rows the Pi reads,
/// pulling the password straight from the OS keychain so the user never has to
/// re-type (or hardcode) it. The plaintext password is written to the DB (which
/// the Pi needs for basic-auth SMTP) but is never returned to the frontend.
#[tauri::command]
pub async fn push_desktop_smtp_to_pi(from_name: String) -> Result<bool, String> {
    // Load the desktop email settings (host / port / user).
    let settings = get_email_settings().await?
        .ok_or_else(|| "No email settings configured on this device yet. Set up Email first.".to_string())?;

    // Pull the working SMTP password from the OS keychain.
    let password = crate::email::cred_opt("smtp_pass")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "No SMTP password found in your keychain. Save your email password under Email → SMTP password first.".to_string())?;

    let pairs: Vec<(&str, String)> = vec![
        ("smtp_host", settings.smtp_host.clone()),
        ("smtp_port", settings.smtp_port.to_string()),
        ("smtp_username", settings.user.clone()),
        ("smtp_password", password),
        ("smtp_from_name", from_name),
        ("smtp_from_email", settings.user.clone()),
    ];

    let conn = pool().get().map_err(|e| e.to_string())?;
    for (key, val_str) in &pairs {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, val_str],
        ).map_err(|e| e.to_string())?;

        let mut cols = serde_json::Map::new();
        cols.insert("key".into(), serde_json::Value::String(key.to_string()));
        cols.insert("value".into(), serde_json::Value::String(val_str.clone()));
        crate::sync::record_upsert("settings", key, cols).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// One-click "make the server use my working email login". Reads the SMTP password
/// already in THIS device's keychain (no re-typing, no new Gmail app password) and
/// pushes it to the server's per-org settings via an authed round-trip, overwriting
/// the stale password that makes mobile invoice sends + the newsletter scheduler
/// fail Gmail auth with 535. Guarded so a device that never held the password can't
/// silently no-op and look like success.
#[tauri::command]
pub async fn push_email_login_to_server() -> Result<bool, String> {
    let has_pass = crate::email::cred_opt("smtp_pass").map(|p| !p.trim().is_empty()).unwrap_or(false);
    if !has_pass {
        return Err("No email password is saved on this device. Open Email settings, enter your working SMTP password, click Save, then try again.".to_string());
    }
    crate::netsync::push_email_secrets_to_server().await?;
    Ok(true)
}

/// One-click "share every connection saved on this device with my team": pushes all
/// sharable secrets (email/Stripe/Google/Shopify/Plaid keys + linked banks) to the
/// org's server store so sibling admins inherit them without re-typing. Returns a
/// short human summary for the toast.
#[tauri::command]
pub async fn share_connections_with_team() -> Result<String, String> {
    if crate::netsync::config().is_none() {
        return Err("Sign in to the server first to share connections with your team.".into());
    }
    let n = crate::netsync::push_all_secrets_to_server().await?;
    if n == 0 {
        return Ok("No shareable connections found on this device yet.".into());
    }
    Ok(format!("Shared {} connection{} with your team.", n, if n == 1 { "" } else { "s" }))
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
//  Categories (synced — propagate to server + other devices)
// ============================================================

/// Emit a sync upsert for one category row. `org_id` is always included so the
/// server can org-scope the row on arrival (the desktop is single-org).
fn sync_category_upsert(id: &str, label: &str, sort_order: i64, parent_id: Option<&str>) {
    let mut cols = Map::new();
    cols.insert("org_id".into(), json!("org_default"));
    cols.insert("label".into(), json!(label));
    cols.insert("sort_order".into(), json!(sort_order));
    cols.insert("parent_id".into(), json!(parent_id));
    if let Err(e) = sync::record_upsert("categories", id, cols) {
        tracing::warn!("sync record_upsert for category {}: {}", id, e);
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub sort_order: i64,
    /// Non-null → this is a subcategory of the given parent category.
    pub parent_id: Option<String>,
}

#[derive(Deserialize)]
pub struct CategoryInput {
    pub label: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[tauri::command]
pub async fn list_categories() -> Result<Vec<Category>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, label, sort_order, parent_id FROM categories ORDER BY sort_order"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(Category { id: r.get(0)?, label: r.get(1)?, sort_order: r.get(2)?, parent_id: r.get(3)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_category(input: CategoryInput) -> Result<String, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let label = input.label.trim().to_string();
    if label.is_empty() { return Err("label required".into()); }
    // A subcategory can only nest under a top-level category (one level deep).
    let parent = input.parent_id.filter(|p| !p.is_empty());
    // Reject an exact-duplicate label among siblings (case/whitespace-insensitive)
    // — this is what let the same category get added twice and show as repeats
    // everywhere (newsletter recipient picker, client editor, etc).
    let dup_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM categories WHERE lower(trim(label))=lower(trim(?1)) \
         AND ((parent_id IS NULL AND ?2 IS NULL) OR parent_id=?2)",
        rusqlite::params![label, parent],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;
    if dup_exists { return Err(format!("\"{}\" already exists", label)); }
    let id = Uuid::new_v4().to_string();
    let max_sort: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM categories", [],
        |r| r.get(0),
    ).unwrap_or(-1);
    let sort_order = max_sort + 1;
    conn.execute(
        "INSERT INTO categories (id, label, sort_order, parent_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, label, sort_order, parent],
    ).map_err(|e| e.to_string())?;
    sync_category_upsert(&id, &label, sort_order, parent.as_deref());
    Ok(id)
}

/// Reassign every category's sort_order by label (A→Z, or Z→A when `desc`).
/// Sub-categories keep their label order within each parent because the UI
/// groups by parent_id and renders each group in sort_order.
#[tauri::command]
pub async fn sort_categories(desc: bool) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut cats: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, label, parent_id FROM categories").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    cats.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    if desc { cats.reverse(); }
    for (i, (id, label, parent_id)) in cats.iter().enumerate() {
        conn.execute("UPDATE categories SET sort_order=?1 WHERE id=?2", rusqlite::params![i as i64, id])
            .map_err(|e| e.to_string())?;
        sync_category_upsert(id, label, i as i64, parent_id.as_deref());
    }
    Ok(())
}

/// Bulk-create top-level system categories from a list of labels, deduplicated
/// CASE-INSENSITIVELY against existing categories (skips blanks + dupes). Each
/// added row is synced. Returns how many were actually added. Shared by the
/// `import_categories` command and the form-capture flow (auto-add detected
/// categories to the system list).
pub(crate) fn ensure_system_categories(labels: &[String]) -> usize {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return 0 };
    let mut seen: std::collections::HashSet<String> = {
        match conn.prepare("SELECT label FROM categories") {
            Ok(mut stmt) => stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).map(|s| s.trim().to_lowercase()).collect())
                .unwrap_or_default(),
            Err(_) => std::collections::HashSet::new(),
        }
    };
    let mut max_sort: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM categories", [], |r| r.get(0),
    ).unwrap_or(-1);
    let mut added = 0usize;
    for raw in labels {
        let label = raw.trim();
        if label.is_empty() { continue; }
        if !seen.insert(label.to_lowercase()) { continue; }
        max_sort += 1;
        let id = Uuid::new_v4().to_string();
        if conn.execute(
            "INSERT INTO categories (id, label, sort_order) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, label, max_sort],
        ).is_ok() {
            sync_category_upsert(&id, label, max_sort, None);
            added += 1;
        }
    }
    added
}

/// Bulk-create top-level categories from a list of labels (e.g. detected from a
/// spreadsheet column). Skips blanks and labels that already exist
/// (case-insensitive). Returns how many were actually added.
#[tauri::command]
pub async fn import_categories(labels: Vec<String>) -> Result<usize, String> {
    Ok(ensure_system_categories(&labels))
}

#[tauri::command]
pub async fn update_category(id: String, input: CategoryInput) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let label = input.label.trim().to_string();
    if label.is_empty() { return Err("label required".into()); }
    // Same duplicate guard as create: don't let a rename collide with a sibling.
    let current_parent: Option<String> = conn.query_row(
        "SELECT parent_id FROM categories WHERE id=?1", [&id], |r| r.get(0),
    ).unwrap_or(None);
    let dup_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM categories WHERE id!=?1 AND lower(trim(label))=lower(trim(?2)) \
         AND ((parent_id IS NULL AND ?3 IS NULL) OR parent_id=?3)",
        rusqlite::params![id, label, current_parent],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;
    if dup_exists { return Err(format!("\"{}\" already exists", label)); }
    conn.execute(
        "UPDATE categories SET label=?1 WHERE id=?2",
        rusqlite::params![label, id],
    ).map_err(|e| e.to_string())?;
    // Sync the full row so label + existing sort_order/parent_id round-trip.
    let (sort_order, parent_id): (i64, Option<String>) = conn.query_row(
        "SELECT sort_order, parent_id FROM categories WHERE id=?1", [&id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    sync_category_upsert(&id, &label, sort_order, parent_id.as_deref());
    Ok(())
}

#[tauri::command]
pub async fn delete_category(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    // Promote any subcategories to top-level so they aren't orphaned. Capture the
    // affected children first so each promotion can be synced.
    let children: Vec<(String, String, i64)> = {
        let mut stmt = conn.prepare("SELECT id, label, sort_order FROM categories WHERE parent_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    conn.execute("UPDATE categories SET parent_id=NULL WHERE parent_id=?1", [&id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM categories WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    for (child_id, label, sort_order) in &children {
        sync_category_upsert(child_id, label, *sort_order, None);
    }
    sync::record_delete("categories", &id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Merge exact-duplicate category labels (same parent, case/whitespace-
/// insensitive) — a one-time repair for rows created before `create_category`
/// rejected duplicates. Clients reference a category only by its label string
/// (never by id), so merging is just: keep the earliest row, reparent any of the
/// duplicate's children onto it, delete the rest. Returns how many were removed.
#[tauri::command]
pub async fn dedupe_categories() -> Result<usize, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut cats: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, label, parent_id FROM categories ORDER BY sort_order")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut kept: std::collections::HashMap<(Option<String>, String), String> = std::collections::HashMap::new();
    let mut removed = 0usize;
    for (id, label, parent_id) in cats.drain(..) {
        let key = (parent_id.clone(), label.trim().to_lowercase());
        if let Some(keep_id) = kept.get(&key) {
            let children: Vec<(String, String, i64)> = {
                let mut stmt = conn.prepare("SELECT id, label, sort_order FROM categories WHERE parent_id=?1")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok()).collect()
            };
            conn.execute("UPDATE categories SET parent_id=?1 WHERE parent_id=?2", rusqlite::params![keep_id, id])
                .map_err(|e| e.to_string())?;
            for (cid, clabel, csort) in &children {
                sync_category_upsert(cid, clabel, *csort, Some(keep_id.as_str()));
            }
            conn.execute("DELETE FROM categories WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
            sync::record_delete("categories", &id).map_err(|e| e.to_string())?;
            removed += 1;
        } else {
            kept.insert(key, id);
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn reorder_categories(ids: Vec<String>) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET sort_order=?1 WHERE id=?2",
            rusqlite::params![i as i64, id],
        ).map_err(|e| e.to_string())?;
        // Sync the new order along with the row's existing label/parent_id.
        if let Ok((label, parent_id)) = conn.query_row(
            "SELECT label, parent_id FROM categories WHERE id=?1", [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        ) {
            sync_category_upsert(id, &label, i as i64, parent_id.as_deref());
        }
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
pub struct CustomField {
    pub id: String,
    pub field_key: String,
    pub label: String,
    pub field_type: String,
    pub options_json: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct SheetHeader {
    pub column_letter: String,
    pub header_text: String,
}

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
    pub field_mapping_json: Option<String>,
    /// When true (default), approving a lead appends a row to the connected sheet.
    pub writeback_enabled: bool,
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
        "SELECT id, sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows, last_synced_at, last_synced_count, COALESCE(field_mapping_json,'{}'), COALESCE(writeback_enabled,1) FROM sheet_sync_config WHERE id=1",
        [],
        |r| Ok(SheetSyncConfig {
            id: r.get(0)?, sheet_url: r.get(1)?, name_col: r.get(2)?,
            first_name_col: r.get(3)?, last_name_col: r.get(4)?,
            email_col: r.get(5)?, phone_col: r.get(6)?, company_col: r.get(7)?,
            category_col: r.get(8)?, lead_status_col: r.get(9)?,
            notes_col: r.get(10)?, skip_header_rows: r.get(11)?,
            last_synced_at: r.get(12)?, last_synced_count: r.get(13)?,
            field_mapping_json: r.get(14)?,
            writeback_enabled: r.get::<_, i64>(15)? != 0,
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
        "INSERT OR REPLACE INTO sheet_sync_config (id, sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows, field_mapping_json, writeback_enabled) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![config.sheet_url, config.name_col, config.first_name_col, config.last_name_col, config.email_col, config.phone_col, config.company_col, config.category_col, config.lead_status_col, config.notes_col, config.skip_header_rows, config.field_mapping_json.unwrap_or_default(), if config.writeback_enabled { 1 } else { 0 }],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Live status of the "approved lead → append to Google Sheet" write-back, so the
/// Settings UI can show a clear reason why it is (or is not) active — the feature is
/// deliberately best-effort and silent at approval time, so this is the ONLY place a
/// user finds out whether it's armed.
///
/// Returns `{ enabled, sheet_configured, google_connected, active, state, message }`
/// where `state` is one of: `active` | `disabled` | `no_sheet` | `not_connected`.
#[tauri::command]
pub async fn sheet_writeback_status() -> Result<Value, String> {
    // Toggle + sheet URL come from sheet_sync_config (defaults: enabled on).
    let (enabled, sheet_configured): (bool, bool) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COALESCE(writeback_enabled,1), \
                    CASE WHEN sheet_url IS NOT NULL AND TRIM(sheet_url) <> '' THEN 1 ELSE 0 END \
             FROM sheet_sync_config WHERE id=1",
            [],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0)),
        ).unwrap_or((true, false))
    };
    // Write-back needs the Google OAuth token (carries the Sheets scope) — the same
    // "Connect Google" connection used for Gmail. An app-password email setup does NOT
    // provide a Sheets-scoped token, so a stored refresh token is the requirement.
    let google_connected = crate::email::cred_opt("oauth_refresh_token")
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    let (state, message) = if !enabled {
        ("disabled", "Write-back is turned off. Approved leads will not be added to the sheet.")
    } else if !sheet_configured {
        ("no_sheet", "No Google Sheet is configured. Add a sheet URL above to enable write-back.")
    } else if !google_connected {
        ("not_connected", "Connect Google (OAuth) under Settings → Email to grant Sheets write access. Until then approvals won't reach the sheet.")
    } else {
        ("active", "Active — approving a lead appends a row to the connected sheet.")
    };
    let active = state == "active";

    Ok(json!({
        "enabled": enabled,
        "sheet_configured": sheet_configured,
        "google_connected": google_connected,
        "active": active,
        "state": state,
        "message": message,
    }))
}

#[tauri::command]
pub async fn sync_from_sheet() -> Result<SheetSyncResult, String> {
    let config = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows, COALESCE(field_mapping_json,'{}') FROM sheet_sync_config WHERE id=1",
            [],
            |r| Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, String>(3)?, r.get::<_, String>(4)?,
                r.get::<_, String>(5)?, r.get::<_, String>(6)?,
                r.get::<_, String>(7)?, r.get::<_, String>(8)?,
                r.get::<_, String>(9)?, r.get::<_, i64>(10)?,
                r.get::<_, String>(11)?,
            )),
        ).map_err(|e| e.to_string())?
    };
    let (sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, skip_header_rows, field_mapping) = config;
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
    // Country column position varies between forms — auto-detect by header name
    // so we pull it regardless of where it sits in the sheet.
    let country_idx: Option<usize> = csv::ReaderBuilder::new().has_headers(false).from_reader(text.as_bytes())
        .records().next().and_then(|r| r.ok())
        .and_then(|rec| rec.iter().position(|c| c.trim().to_lowercase().contains("country")));

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
        let country = country_idx.and_then(|i| record.get(i)).unwrap_or("").trim().to_string();

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
            if !country.is_empty() { meta["country"] = Value::String(country.clone()); }
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
        if !country.is_empty() { meta["country"] = Value::String(country.clone()); }
        if !other_cats.is_empty() { meta["other_categories"] = Value::String(other_cats.clone()); }
        if !purchase_freq.is_empty() { meta["purchase_frequency"] = Value::String(purchase_freq.clone()); }
        if !buy_spend.is_empty() { meta["estimated_annual_spend"] = Value::String(buy_spend.clone()); }

        if let Ok(map) = serde_json::from_str::<serde_json::Value>(&field_mapping) {
            if let Some(obj) = map.as_object() {
                for (col_letter, field_name_val) in obj {
                    if let Some(field_name) = field_name_val.as_str() {
                        let idx = col_index(col_letter);
                        let val = record.get(idx).unwrap_or("").trim().to_string();
                        if !val.is_empty() {
                            // "cf:<key>" → metadata keyed by the custom field's key (matches forms/intake/CSV).
                            let key = field_name.strip_prefix("cf:").unwrap_or(field_name);
                            meta[key] = Value::String(val);
                        }
                    }
                }
            }
        }

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

#[tauri::command]
pub async fn list_custom_fields() -> Result<Vec<CustomField>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT id, field_key, label, field_type, options_json, sort_order, created_at FROM custom_fields ORDER BY sort_order, label")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok(CustomField {
        id: r.get(0)?, field_key: r.get(1)?, label: r.get(2)?,
        field_type: r.get(3)?, options_json: r.get(4)?,
        sort_order: r.get(5)?, created_at: r.get(6)?,
    })).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn save_custom_field(id: Option<String>, field_key: String, label: String, field_type: String, options_json: Option<String>) -> Result<CustomField, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    if let Some(existing_id) = id {
        conn.execute(
            "UPDATE custom_fields SET field_key=?1, label=?2, field_type=?3, options_json=?4 WHERE id=?5",
            rusqlite::params![field_key, label, field_type, options_json, existing_id],
        ).map_err(|e| e.to_string())?;
        Ok(CustomField { id: existing_id, field_key, label, field_type, options_json, sort_order: 0, created_at: now })
    } else {
        let new_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO custom_fields (id, field_key, label, field_type, options_json, sort_order, created_at) VALUES (?1,?2,?3,?4,?5,0,?6)",
            rusqlite::params![new_id, field_key, label, field_type, options_json, now],
        ).map_err(|e| e.to_string())?;
        Ok(CustomField { id: new_id, field_key, label, field_type, options_json, sort_order: 0, created_at: now })
    }
}

#[tauri::command]
pub async fn delete_custom_field(id: String) -> Result<(), String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM custom_fields WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_sheet_headers(sheet_url: String) -> Result<Vec<SheetHeader>, String> {
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
        .map_err(|e| format!("Failed to fetch sheet: {}", e))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let mut reader = csv::ReaderBuilder::new().has_headers(false).from_reader(text.as_bytes());
    let first = reader.records().next().ok_or("Sheet is empty")?.map_err(|e| e.to_string())?;
    let headers: Vec<SheetHeader> = first.iter().enumerate().map(|(i, h)| {
        let col = if i < 26 { format!("{}", (b'A' + i as u8) as char) } else { format!("{}{}", (b'A' + (i / 26 - 1) as u8) as char, (b'A' + (i % 26) as u8) as char) };
        SheetHeader { column_letter: col, header_text: h.trim().to_string() }
    }).collect();
    Ok(headers)
}

/// Distinct non-empty values of the configured Google Sheet's category column,
/// sorted case-insensitively. Used by the UI to detect categories from the
/// connected sheet so they can be imported. Reuses the same CSV export plumbing
/// and `category_col` config as `sync_from_sheet`.
#[tauri::command]
pub async fn sheet_category_column_values() -> Result<Vec<String>, String> {
    let (sheet_url, mut category_col, skip_header_rows): (Option<String>, String, i64) = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT sheet_url, category_col, skip_header_rows FROM sheet_sync_config WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|e| e.to_string())?
    };
    if category_col.is_empty() { category_col = "P".into(); }
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

    let cat_idx = col_index(&category_col);
    // De-dupe case-insensitively while preserving the first-seen original casing.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut values: Vec<String> = Vec::new();
    let mut reader = csv::ReaderBuilder::new().has_headers(false).from_reader(text.as_bytes());
    for (row_num, row) in reader.records().enumerate() {
        if (row_num as i64) < skip_header_rows { continue; }
        let record = match row { Ok(r) => r, Err(_) => continue };
        let val = record.get(cat_idx).unwrap_or("").trim().to_string();
        if val.is_empty() { continue; }
        if seen.insert(val.to_lowercase()) {
            values.push(val);
        }
    }
    values.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(values)
}

/// The inbound Google Sheets pull is OPT-IN and defaults OFF.
///
/// `sync_from_sheet` rebuilds a matched client's metadata from an empty object and
/// re-imports through whatever column mapping THIS device happens to hold. Run
/// unattended every 10 minutes that meant: geocoded lat/lng (and high_value,
/// exclusive, tags, cf:* …) were wiped on every tick — reverting the geocoder's own
/// work and emptying the globe — while a drifted per-device column mapping wrote
/// wrong names into the org-shared client book. Until the importer merges metadata
/// and the mapping is a single shared source of truth, this stays off unless the
/// user explicitly turns it on.
fn sheet_sync_enabled() -> bool {
    let conn = match pool().get() { Ok(c) => c, Err(_) => return false };
    conn.query_row("SELECT value FROM settings WHERE key='sheet_sync_enabled'", [], |r| r.get::<_, String>(0))
        .map(|v| { let v = v.trim(); v == "1" || v.eq_ignore_ascii_case("true") })
        .unwrap_or(false)
}

/// Periodic inbound sheet pull. The enable check is INSIDE the loop so the setting
/// can be flipped without restarting the app.
pub fn spawn_periodic_sheet_sync(interval_secs: u64) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        loop {
            interval.tick().await;
            if !sheet_sync_enabled() {
                continue;
            }
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
    let country = meta.get("country").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if city.is_empty() && state.is_empty() {
        return Err("client has no city/state".into());
    }

    let (lat, lng) = lookup.lookup(&city, &state)
        .or_else(|| crate::geocode::lookup_international(&city, &state, &country))
        .ok_or("location not found in dataset")?;

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
        let country = meta.get("country").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if city.is_empty() && state.is_empty() {
            skipped += 1;
            continue;
        }

        if !sample_logged {
            tracing::info!("geocode sample: city={:?}, state={:?}, country={:?}", city, state, country);
            sample_logged = true;
        }

        match lookup.lookup(&city, &state).or_else(|| crate::geocode::lookup_international(&city, &state, &country)) {
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

// ──────────────────────── Sticky notes ────────────────────────

#[derive(Serialize)]
pub struct Note {
    pub id: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub editing_by: String,
    pub editing_at: String,
    pub urgency: String,
    pub reviewed_at: String,
}

fn row_to_note(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        body: r.get(1)?,
        color: r.get(2)?,
        pinned: r.get::<_, i64>(3)? != 0,
        author: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        x: r.get(7)?,
        y: r.get(8)?,
        w: r.get(9)?,
        h: r.get(10)?,
        editing_by: r.get(11)?,
        editing_at: r.get(12)?,
        urgency: r.get(13)?,
        reviewed_at: r.get(14)?,
    })
}

const NOTE_COLS: &str = "id, body, color, pinned, author, created_at, updated_at, COALESCE(x,0), COALESCE(y,0), COALESCE(w,226), COALESCE(h,190), COALESCE(editing_by,''), COALESCE(editing_at,''), COALESCE(urgency,'normal'), COALESCE(reviewed_at, created_at)";

/// Pull remote sync events on demand (in addition to the background 20s loop) so a
/// live board — e.g. the shared notes board — reflects the other user's changes in
/// ~seconds. Emits `netsync-applied` when anything landed so every open view
/// refreshes. Cheap no-op when nothing is queued or no server is configured.
#[tauri::command]
pub async fn pull_now(app: tauri::AppHandle) -> Result<usize, String> {
    let n = crate::netsync::pull_apply().await.map_err(|e| e.to_string())?;
    if n > 0 {
        use tauri::Emitter;
        let _ = app.emit("netsync-applied", n);
    }
    Ok(n)
}

#[tauri::command]
pub async fn list_notes() -> Result<Vec<Note>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("SELECT {NOTE_COLS} FROM notes ORDER BY pinned DESC, updated_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_note).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn create_note(body: String, color: Option<String>, x: Option<f64>, y: Option<f64>) -> Result<Note, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let color = color.unwrap_or_else(|| "yellow".into());
    let author = crate::employees::current_display_name();
    let x = x.unwrap_or(0.0);
    let y = y.unwrap_or(0.0);
    let w = 226.0;
    let h = 190.0;
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO notes (id, body, color, pinned, author, x, y, w, h, created_at, updated_at, urgency, reviewed_at) VALUES (?1,?2,?3,0,?4,?5,?6,?7,?8,?9,?9,'normal',?9)",
            rusqlite::params![id, body, color, author, x, y, w, h, now],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("body".into(), json!(body));
    cols.insert("color".into(), json!(color));
    cols.insert("pinned".into(), json!(0));
    cols.insert("author".into(), json!(author));
    cols.insert("x".into(), json!(x));
    cols.insert("y".into(), json!(y));
    cols.insert("w".into(), json!(w));
    cols.insert("h".into(), json!(h));
    cols.insert("created_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    cols.insert("urgency".into(), json!("normal"));
    cols.insert("reviewed_at".into(), json!(now));
    sync::record_upsert("notes", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now(); // reach the other device promptly, not on the next poll
    Ok(Note { id, body, color, pinned: false, author, created_at: now.clone(), updated_at: now.clone(), x, y, w, h,
              editing_by: String::new(), editing_at: String::new(), urgency: "normal".into(), reviewed_at: now })
}

/// Acquire or release the advisory edit-lock on a note. Acquire stamps the current
/// user + now; release clears it but ONLY if this user holds it (so a late acquirer
/// isn't cleared by an earlier editor's blur). Synced + pushed so peers see the lock
/// within a pull tick; readers TTL-expire it, so a crashed editor never locks a note
/// forever.
#[tauri::command]
pub async fn set_note_editing(id: String, editing: bool) -> Result<(), String> {
    let me = crate::employees::current_display_name();
    let now = chrono::Utc::now().to_rfc3339();
    let (editing_by, editing_at) = if editing { (me.clone(), now.clone()) } else { (String::new(), String::new()) };
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let changed = if editing {
            conn.execute("UPDATE notes SET editing_by=?1, editing_at=?2, updated_at=?3 WHERE id=?4",
                rusqlite::params![editing_by, editing_at, now, id]).map_err(|e| e.to_string())?
        } else {
            // Only clear our own lock.
            conn.execute("UPDATE notes SET editing_by='', editing_at='', updated_at=?1 WHERE id=?2 AND editing_by=?3",
                rusqlite::params![now, id, me]).map_err(|e| e.to_string())?
        };
        if changed == 0 { return Ok(()); } // nothing to do (release of a lock we don't hold)
    }
    let mut cols = Map::new();
    cols.insert("editing_by".into(), json!(editing_by));
    cols.insert("editing_at".into(), json!(editing_at));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("notes", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

#[tauri::command]
pub async fn update_note(id: String, body: Option<String>, color: Option<String>, pinned: Option<bool>, x: Option<f64>, y: Option<f64>, w: Option<f64>, h: Option<f64>, urgency: Option<String>) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut cols = Map::new();
    cols.insert("updated_at".into(), json!(now));
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        if let Some(u) = &urgency {
            cols.insert("urgency".into(), json!(u));
            conn.execute("UPDATE notes SET urgency=?1 WHERE id=?2", rusqlite::params![u, id]).map_err(|e| e.to_string())?;
        }
        if let Some(b) = &body {
            cols.insert("body".into(), json!(b));
            conn.execute("UPDATE notes SET body=?1 WHERE id=?2", rusqlite::params![b, id]).map_err(|e| e.to_string())?;
        }
        if let Some(c) = &color {
            cols.insert("color".into(), json!(c));
            conn.execute("UPDATE notes SET color=?1 WHERE id=?2", rusqlite::params![c, id]).map_err(|e| e.to_string())?;
        }
        if let Some(p) = pinned {
            cols.insert("pinned".into(), json!(if p { 1 } else { 0 }));
            conn.execute("UPDATE notes SET pinned=?1 WHERE id=?2", rusqlite::params![if p {1} else {0}, id]).map_err(|e| e.to_string())?;
        }
        if let Some(xv) = x {
            cols.insert("x".into(), json!(xv));
            conn.execute("UPDATE notes SET x=?1 WHERE id=?2", rusqlite::params![xv, id]).map_err(|e| e.to_string())?;
        }
        if let Some(yv) = y {
            cols.insert("y".into(), json!(yv));
            conn.execute("UPDATE notes SET y=?1 WHERE id=?2", rusqlite::params![yv, id]).map_err(|e| e.to_string())?;
        }
        if let Some(wv) = w {
            cols.insert("w".into(), json!(wv));
            conn.execute("UPDATE notes SET w=?1 WHERE id=?2", rusqlite::params![wv, id]).map_err(|e| e.to_string())?;
        }
        if let Some(hv) = h {
            cols.insert("h".into(), json!(hv));
            conn.execute("UPDATE notes SET h=?1 WHERE id=?2", rusqlite::params![hv, id]).map_err(|e| e.to_string())?;
        }
        conn.execute("UPDATE notes SET updated_at=?1 WHERE id=?2", rusqlite::params![now, id]).map_err(|e| e.to_string())?;
    }
    sync::record_upsert("notes", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now(); // live-share the change to the other device now
    Ok(())
}

/// "Still needed" confirmation — the keep-active check on a note that's been up a while.
/// Stamps reviewed_at = now, which resets its staleness clock (and bumps updated_at so
/// the sync merge keeps it). Synced + pushed so the other device stops flagging it too.
#[tauri::command]
pub async fn keep_note(id: String) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("UPDATE notes SET reviewed_at=?1, updated_at=?1 WHERE id=?2", rusqlite::params![now, id])
            .map_err(|e| e.to_string())?;
    }
    let mut cols = Map::new();
    cols.insert("reviewed_at".into(), json!(now));
    cols.insert("updated_at".into(), json!(now));
    sync::record_upsert("notes", &id, cols).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

#[tauri::command]
pub async fn delete_note(id: String) -> Result<(), String> {
    {
        let conn = pool().get().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM notes WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
    }
    sync::record_delete("notes", &id).map_err(|e| e.to_string())?;
    crate::netsync::push_now();
    Ok(())
}

// ============================================================
//  Data safety — cross-device integrity scan + manual converge
//  (superadmin-only surface). Surfaces rows that are inconsistent
//  ACROSS devices — a resurrected invoice (row + tombstone), a
//  payment/deal-flow whose invoice is gone — and lets the operator
//  converge each to deleted EVERYWHERE via the sync path
//  (record_delete emits a fresh-HLC tombstone that pushes to the
//  server and every device), instead of a raw local delete that a
//  newer clock would simply resurrect again.
// ============================================================

#[derive(serde::Serialize)]
pub struct IntegrityTarget {
    pub table: String,
    pub id: String,
    pub label: String,
}

#[derive(serde::Serialize)]
pub struct IntegrityItem {
    /// resurrected_invoice | orphan_payment | orphan_deal_flow
    pub kind: String,
    /// The row `converge_integrity_item` is keyed on.
    pub id: String,
    pub title: String,
    pub detail: String,
    pub amount: Option<f64>,
    /// Every row a converge would delete — shown in the confirm dialog.
    pub targets: Vec<IntegrityTarget>,
}

#[tauri::command]
pub async fn scan_data_integrity() -> Result<Vec<IntegrityItem>, String> {
    let conn = pool().get().map_err(|e| e.to_string())?;
    let mut items: Vec<IntegrityItem> = Vec::new();

    // 1) Resurrected invoices — an invoice row that ALSO carries a tombstone (another device
    //    deleted it, but a newer local write out-clocked the delete so the row survives).
    //    Cascade targets: its payments + deal flows.
    {
        let mut stmt = conn
            .prepare(
                "SELECT i.id, COALESCE(i.number,''), COALESCE(i.voided,0), COALESCE(i.archived,0), COALESCE(i.total,0) \
                 FROM invoices i JOIN tombstones t ON t.tbl='invoices' AND t.row_id=i.id",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, i64, i64, f64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        for (iid, number, voided, archived, total) in rows {
            let num_label = if number.is_empty() { "(no number)".to_string() } else { number.clone() };
            let mut targets = vec![IntegrityTarget {
                table: "invoices".into(),
                id: iid.clone(),
                label: format!("Invoice {}", num_label),
            }];
            let mut pay_total = 0.0;
            {
                let mut s = conn
                    .prepare("SELECT id, COALESCE(amount,0) FROM payments WHERE invoice_id=?1")
                    .map_err(|e| e.to_string())?;
                let pr: Vec<(String, f64)> = s
                    .query_map([&iid], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(|x| x.ok())
                    .collect();
                for (pid, amt) in pr {
                    pay_total += amt;
                    targets.push(IntegrityTarget { table: "payments".into(), id: pid, label: format!("Payment (${:.2})", amt) });
                }
            }
            {
                let mut s = conn
                    .prepare("SELECT id FROM deal_flows WHERE invoice_id=?1")
                    .map_err(|e| e.to_string())?;
                let dr: Vec<String> = s
                    .query_map([&iid], |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|x| x.ok())
                    .collect();
                for did in dr {
                    targets.push(IntegrityTarget { table: "deal_flows".into(), id: did, label: "Deal flow".into() });
                }
            }
            let status = if voided == 1 { "voided" } else if archived == 1 { "archived" } else { "active" };
            let ndeps = targets.len() - 1;
            items.push(IntegrityItem {
                kind: "resurrected_invoice".into(),
                id: iid,
                title: format!("Invoice {} — deleted on another device but still here", num_label),
                detail: format!(
                    "This {} invoice carries a tombstone (another device deleted it) yet the row still exists here, with {} linked row(s). It will not converge on its own. Converging deletes it and its dependents everywhere through the sync path.",
                    status, ndeps
                ),
                amount: Some(if pay_total > 0.0 { pay_total } else { total }),
                targets,
            });
        }
    }

    // 2) Orphan payments — invoice missing/voided/archived, EXCLUDING any whose invoice is
    //    tombstoned (already covered as a resurrected-invoice dependent in section 1).
    {
        let mut stmt = conn
            .prepare(
                "SELECT p.id, COALESCE(p.amount,0), COALESCE(i.number,''), CASE WHEN i.id IS NULL THEN 1 ELSE 0 END, COALESCE(i.voided,0), COALESCE(i.archived,0) \
                 FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id \
                 WHERE (i.id IS NULL OR i.voided=1 OR i.archived=1) \
                   AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.tbl='invoices' AND t.row_id=p.invoice_id)",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, f64, String, i64, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        for (pid, amt, number, missing, voided, _archived) in rows {
            let num = if number.is_empty() { "(no number)".to_string() } else { number };
            let why = if missing == 1 {
                "its invoice no longer exists".to_string()
            } else if voided == 1 {
                format!("its invoice {} is voided", num)
            } else {
                format!("its invoice {} is archived", num)
            };
            items.push(IntegrityItem {
                kind: "orphan_payment".into(),
                title: format!("Payment (${:.2}) with no live invoice", amt),
                detail: format!("This payment is linked to an invoice where {} — money recorded against a deal that is not live. Converging deletes the payment everywhere.", why),
                amount: Some(amt),
                targets: vec![IntegrityTarget { table: "payments".into(), id: pid.clone(), label: format!("Payment (${:.2})", amt) }],
                id: pid,
            });
        }
    }

    // 3) Orphan deal flows — an ACTIVE deal flow whose invoice_id points at an invoice row
    //    that is gone here. Archived orphans are excluded: they're expected residue of a
    //    deleted invoice (soft-deleted, off the pipeline), and surfacing dozens of them would
    //    bury the anomalies that actually need action.
    {
        let mut stmt = conn
            .prepare(
                "SELECT d.id FROM deal_flows d \
                 WHERE d.invoice_id IS NOT NULL AND d.invoice_id<>'' \
                   AND COALESCE(d.archived,0)=0 \
                   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id=d.invoice_id)",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        for did in rows {
            items.push(IntegrityItem {
                kind: "orphan_deal_flow".into(),
                title: "Deal flow with no invoice".into(),
                detail: "This deal flow points at an invoice that no longer exists here — a stray left behind when the invoice was removed. Converging deletes the deal flow everywhere.".into(),
                amount: None,
                targets: vec![IntegrityTarget { table: "deal_flows".into(), id: did.clone(), label: "Deal flow".into() }],
                id: did,
            });
        }
    }

    Ok(items)
}

/// Delete one row through the sync path: a fresh-HLC tombstone (record_delete) that pushes
/// to the server + every device, then remove the local row. Whitelisted tables only.
fn converge_delete_row(table: &str, id: &str) -> Result<(), String> {
    if !matches!(table, "invoices" | "deal_flows" | "payments") {
        return Err(format!("refusing to converge unknown table {}", table));
    }
    sync::record_delete(table, id).map_err(|e| e.to_string())?;
    let conn = pool().get().map_err(|e| e.to_string())?;
    conn.execute(&format!("DELETE FROM {} WHERE id=?1", table), [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn converge_integrity_item(kind: String, id: String) -> Result<Vec<String>, String> {
    let mut deleted: Vec<String> = Vec::new();
    match kind.as_str() {
        "resurrected_invoice" => {
            // Re-confirm the anomaly independent of the UI: the invoice must still carry a
            // tombstone, so a legitimately-restored invoice can never be reaped here.
            let has_tomb = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                conn.query_row(
                    "SELECT COUNT(*) FROM tombstones WHERE tbl='invoices' AND row_id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                    > 0
            };
            if !has_tomb {
                return Err("This invoice no longer looks resurrected — rescan.".into());
            }
            let pays: Vec<String> = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                let mut s = conn.prepare("SELECT id FROM payments WHERE invoice_id=?1").map_err(|e| e.to_string())?;
                let v: Vec<String> = s.query_map([&id], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|x| x.ok()).collect();
                v
            };
            let dfs: Vec<String> = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                let mut s = conn.prepare("SELECT id FROM deal_flows WHERE invoice_id=?1").map_err(|e| e.to_string())?;
                let v: Vec<String> = s.query_map([&id], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(|x| x.ok()).collect();
                v
            };
            // Dependents first, then the invoice.
            for p in &pays { converge_delete_row("payments", p)?; }
            if !pays.is_empty() { deleted.push(format!("{} payment(s)", pays.len())); }
            for d in &dfs { converge_delete_row("deal_flows", d)?; }
            if !dfs.is_empty() { deleted.push(format!("{} deal flow(s)", dfs.len())); }
            converge_delete_row("invoices", &id)?;
            deleted.push("the invoice".into());
        }
        "orphan_payment" => {
            // Re-confirm it's still an orphan so a stale scan can't delete a payment whose
            // invoice came back to life.
            let still = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                conn.query_row(
                    "SELECT CASE WHEN i.id IS NULL OR i.voided=1 OR i.archived=1 THEN 1 ELSE 0 END \
                     FROM payments p LEFT JOIN invoices i ON i.id=p.invoice_id WHERE p.id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
            };
            if still == 0 {
                return Err("This payment now has a live invoice — rescan.".into());
            }
            converge_delete_row("payments", &id)?;
            deleted.push("the payment".into());
        }
        "orphan_deal_flow" => {
            // Re-confirm the linked invoice is still gone before deleting.
            let still = {
                let conn = pool().get().map_err(|e| e.to_string())?;
                conn.query_row(
                    "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id=d.invoice_id) THEN 1 ELSE 0 END \
                     FROM deal_flows d WHERE d.id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
            };
            if still == 0 {
                return Err("This deal flow's invoice exists again — rescan.".into());
            }
            converge_delete_row("deal_flows", &id)?;
            deleted.push("the deal flow".into());
        }
        other => return Err(format!("unknown integrity item kind: {}", other)),
    }
    // Push the deletes now so the server converges without waiting for the next poll tick.
    crate::netsync::push_now();
    Ok(deleted)
}

#[cfg(test)]
mod payout_tests {
    use super::{allocate_payout, build_payout_breakdown, parse_split_shares, shares_from_breakdown};
    use serde_json::{json, Map, Value};

    // Real-shaped config: an investment share + two people + the business —
    // the exact case the legacy jack/ben columns could not represent.
    fn shares() -> Vec<(String, f64, bool, String)> {
        vec![
            ("Jack".into(), 30.0, false, "person".into()),
            ("Ben".into(), 25.0, false, "person".into()),
            ("Fund".into(), 10.0, false, "investment".into()),
            ("Business".into(), 35.0, true, "business".into()),
        ]
    }

    fn amounts(b: &[Value]) -> Vec<f64> {
        b.iter().map(|s| s.get("amount").and_then(|a| a.as_f64()).unwrap()).collect()
    }

    #[test]
    fn included_splits_by_pct_across_all_recipients() {
        let b = build_payout_breakdown(&shares(), 1000.0, true);
        assert_eq!(amounts(&b), vec![300.0, 250.0, 100.0, 350.0]);
        assert_eq!(amounts(&b).iter().sum::<f64>(), 1000.0);
        assert_eq!(b[2].get("kind").unwrap(), "investment");
        assert_eq!(b[3].get("is_business").unwrap(), true);
    }

    #[test]
    fn excluded_routes_everything_to_business() {
        let b = build_payout_breakdown(&shares(), 1000.0, false);
        assert_eq!(amounts(&b), vec![0.0, 0.0, 0.0, 1000.0]);
    }

    #[test]
    fn loss_deal_splits_negative_net() {
        let b = build_payout_breakdown(&shares(), -500.0, true);
        assert_eq!(amounts(&b), vec![-150.0, -125.0, -50.0, -175.0]);
        let b = build_payout_breakdown(&shares(), -500.0, false);
        assert_eq!(amounts(&b), vec![0.0, 0.0, 0.0, -500.0]);
    }

    #[test]
    fn unconfigured_split_yields_empty_breakdown() {
        assert!(build_payout_breakdown(&[], 1000.0, true).is_empty());
        assert!(build_payout_breakdown(&[], 1000.0, false).is_empty());
    }

    #[test]
    fn excluded_net_divided_among_multiple_business_shares_by_pct() {
        let s = vec![
            ("Jack".to_string(), 40.0, false, "person".to_string()),
            ("Ops LLC".to_string(), 45.0, true, "business".to_string()),
            ("Holdings".to_string(), 15.0, true, "business".to_string()),
        ];
        let b = build_payout_breakdown(&s, 1000.0, false);
        assert_eq!(amounts(&b), vec![0.0, 750.0, 250.0]);
    }

    #[test]
    fn no_business_share_excluded_falls_back_to_pct_split() {
        let s = vec![
            ("Jack".to_string(), 60.0, false, "person".to_string()),
            ("Ben".to_string(), 40.0, false, "person".to_string()),
        ];
        let b = build_payout_breakdown(&s, 1000.0, false);
        assert_eq!(amounts(&b), vec![600.0, 400.0]);
    }

    #[test]
    fn amounts_round_to_cents() {
        let b = build_payout_breakdown(&shares(), 100.01, true);
        assert_eq!(amounts(&b), vec![30.0, 25.0, 10.0, 35.0]);
        let a = allocate_payout(0.10, 0.0, &[("A".into(), 33.0, false), ("B".into(), 67.0, true)]);
        assert_eq!(a[0].2, 0.03);
        assert_eq!(a[1].2, 0.07);
    }

    #[test]
    fn parse_drops_nameless_people_and_labels_nameless_business() {
        let rows = vec![
            json!({"name": "", "pct": 10, "is_business": false}),
            json!({"name": "Jack", "pct": 55}),
            json!({"name": "", "pct": 35, "is_business": true}),
        ];
        let s = parse_split_shares(&rows);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], ("Jack".to_string(), 55.0, false, "person".to_string()));
        assert_eq!(s[1], ("Business".to_string(), 35.0, true, "business".to_string()));
    }

    #[test]
    fn breakdown_round_trips_through_metadata() {
        let breakdown = build_payout_breakdown(&shares(), 1000.0, true);
        let mut meta = Map::new();
        meta.insert("payout_recipients".into(), Value::Array(breakdown));
        let restored = shares_from_breakdown(&meta).unwrap();
        assert_eq!(restored, shares());
        let empty = Map::new();
        assert!(shares_from_breakdown(&empty).is_none());
    }
}

#[cfg(test)]
mod review_cols_tests {
    use super::{review_cols, REVIEW_UPDATE_SQL};

    fn s(v: &str) -> Option<String> { Some(v.to_string()) }
    const NONE: Option<String> = None;

    // The regression. Booking a transaction is real work Jack does once; a save
    // that merely re-classifies it must not be able to say anything about
    // `reviewed`, because naming the column re-stamps its LWW clock and a stale
    // device would then win with reviewed=0 and un-book it.
    #[test]
    fn category_save_cannot_touch_reviewed() {
        let cols = review_cols(&s("supplier_payment"), &NONE, &NONE, &NONE, None, "T").unwrap();
        assert!(!cols.contains_key("reviewed"), "category save must never emit reviewed");
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["category", "updated_at"]);
    }

    // Jack's requirement: un-booking / re-classifying by hand must still work.
    #[test]
    fn explicit_unbook_emits_reviewed_alone() {
        let cols = review_cols(&NONE, &NONE, &NONE, &NONE, Some(0), "T").unwrap();
        let mut keys: Vec<&str> = cols.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["reviewed", "updated_at"]);
        assert_eq!(cols["reviewed"], 0);
        // ...and booking it, which must not disturb the classification.
        let booked = review_cols(&NONE, &NONE, &NONE, &NONE, Some(1), "T").unwrap();
        assert_eq!(booked["reviewed"], 1);
        assert!(!booked.contains_key("category"));
    }

    #[test]
    fn nothing_supplied_emits_nothing() {
        assert!(review_cols(&NONE, &NONE, &NONE, &NONE, None, "T").is_none());
    }

    // The local write must agree with the event: re-classifying leaves the row
    // booked. Runs the exact SQL the command runs.
    #[test]
    fn coalesce_update_leaves_unsupplied_columns_alone() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE bank_txn (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '',
               counterparty_name TEXT NOT NULL DEFAULT '', counterparty_type TEXT NOT NULL DEFAULT '',
               counterparty_id TEXT NOT NULL DEFAULT '', reviewed INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL DEFAULT '');
             INSERT INTO bank_txn (id,category,counterparty_name,reviewed) VALUES ('t1','wire_fee','ACME',1);",
        ).unwrap();

        // Re-classify only — reviewed and counterparty_name must survive.
        conn.execute(
            REVIEW_UPDATE_SQL,
            rusqlite::params![s("supplier_payment"), NONE, NONE, NONE, None::<i64>, "T2", "t1"],
        ).unwrap();
        let (cat, name, rev): (String, String, i64) = conn
            .query_row("SELECT category,counterparty_name,reviewed FROM bank_txn WHERE id='t1'", [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(cat, "supplier_payment");
        assert_eq!(name, "ACME", "an untouched field must not be blanked");
        assert_eq!(rev, 1, "re-classifying must not un-book the transaction");

        // Explicit un-book — clears the flag, keeps the new classification.
        conn.execute(
            REVIEW_UPDATE_SQL,
            rusqlite::params![NONE, NONE, NONE, NONE, Some(0i64), "T3", "t1"],
        ).unwrap();
        let (cat2, rev2): (String, i64) = conn
            .query_row("SELECT category,reviewed FROM bank_txn WHERE id='t1'", [],
                |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(cat2, "supplier_payment");
        assert_eq!(rev2, 0);
    }
}
