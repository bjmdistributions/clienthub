//! CSV importer for Google Sheets / Excel exports.
//!
//! Workflow:
//!   1. UI calls `csv_preview(path)` → returns headers + first N rows
//!   2. User maps CSV columns → ClientHub fields in the UI
//!   3. UI calls `csv_import(path, mapping)` → creates clients, returns summary

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct CsvPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnMapping {
    /// Map of ClientHub field → CSV column name.
    /// Standard fields: "first_name", "last_name", "email", "phone", "company", "notes"
    /// If both first_name and last_name are mapped, name becomes "First Last".
    /// If only one is mapped, that becomes name.
    /// If neither, uses the legacy "name" mapping directly.
    pub fields: HashMap<String, String>,
    /// CSV column names whose values go into the metadata JSON column.
    pub metadata_keys: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

pub fn preview(path: &str) -> Result<CsvPreview> {
    let mut rdr = csv::Reader::from_path(path).context("open csv")?;
    let headers: Vec<String> = rdr
        .headers()?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let mut rows = Vec::new();
    let mut total = 0;
    for (i, result) in rdr.records().enumerate() {
        total += 1;
        if i < 5 {
            if let Ok(record) = result {
                rows.push(record.iter().map(|s| s.to_string()).collect());
            }
        }
    }
    Ok(CsvPreview {
        headers,
        rows,
        total_rows: total,
    })
}

pub fn import(path: &str, mapping: &ColumnMapping) -> Result<ImportSummary> {
    let mut rdr = csv::Reader::from_path(path).context("open csv")?;
    let headers: Vec<String> = rdr
        .headers()?
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let header_idx: HashMap<&str, usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect();

    let get_idx = |field: &str| -> Option<usize> {
        mapping
            .fields
            .get(field)
            .and_then(|col| header_idx.get(col.as_str()).copied())
    };

    let first_name_idx = get_idx("first_name");
    let last_name_idx = get_idx("last_name");
    let legacy_name_idx = get_idx("name");
    let email_idx = get_idx("email");
    let phone_idx = get_idx("phone");
    let company_idx = get_idx("company");
    let notes_idx = get_idx("notes");
    let category_idx = get_idx("category");
    let lead_status_idx = get_idx("lead_status");
    let street_address_idx = get_idx("street_address");
    let city_idx = get_idx("city");
    let state_idx = get_idx("state");
    let zip_code_idx = get_idx("zip_code");

    let metadata_indices: Vec<(String, usize)> = mapping
        .metadata_keys
        .iter()
        .filter_map(|col| {
            header_idx
                .get(col.as_str())
                .map(|&i| (col.clone(), i))
        })
        .collect();

    let has_name = first_name_idx.is_some() || last_name_idx.is_some() || legacy_name_idx.is_some();
    if !has_name {
        anyhow::bail!("At least one name mapping is required (first_name + last_name, or name)");
    }

    let mut summary = ImportSummary {
        imported: 0,
        skipped: 0,
        errors: Vec::new(),
    };

    let conn = crate::db::pool().get()?;
    let now = chrono::Utc::now().to_rfc3339();

    for (row_num, result) in rdr.records().enumerate() {
        let record = match result {
            Ok(r) => r,
            Err(e) => {
                summary.errors.push(format!("Row {}: {}", row_num + 2, e));
                continue;
            }
        };

        let name = build_name(&record, first_name_idx, last_name_idx, legacy_name_idx);
        if name.is_empty() {
            summary.skipped += 1;
            continue;
        }

        let email = email_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let phone = phone_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let company = company_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let notes = notes_idx
            .and_then(|i| record.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let category = category_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let lead_status_raw = lead_status_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        let valid_statuses = ["prospect", "active", "inactive", "vip"];
        let lead_status = lead_status_raw.filter(|s| valid_statuses.contains(&s.as_str())).unwrap_or_else(|| "prospect".to_string());

        let mut metadata = build_metadata(&record, &metadata_indices);
        if let Some(v) = street_address_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) { metadata.insert("street_address".into(), serde_json::Value::String(v)); }
        if let Some(v) = city_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) { metadata.insert("city".into(), serde_json::Value::String(v)); }
        if let Some(v) = state_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) { metadata.insert("state".into(), serde_json::Value::String(v)); }
        if let Some(v) = zip_code_idx.and_then(|i| record.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) { metadata.insert("zip_code".into(), serde_json::Value::String(v)); }

        // Custom-field targets ("cf:<key>") map a column into metadata keyed by the
        // custom field's key — same convention as forms/intake, so the data lines up.
        for (target, col) in &mapping.fields {
            if let Some(key) = target.strip_prefix("cf:") {
                if let Some(v) = header_idx.get(col.as_str())
                    .and_then(|&i| record.get(i))
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                {
                    metadata.insert(key.to_string(), serde_json::Value::String(v));
                }
            }
        }

        if let Some(em) = &email {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM clients WHERE LOWER(email)=LOWER(?1)",
                    [em],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists > 0 {
                summary.skipped += 1;
                continue;
            }
        } else {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM clients WHERE LOWER(TRIM(name))=LOWER(TRIM(?1))",
                    [&name],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if exists > 0 {
                summary.skipped += 1;
                continue;
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let mut cols = serde_json::Map::new();
        cols.insert("name".into(), serde_json::Value::String(name.clone()));
        cols.insert(
            "email".into(),
            email.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        );
        cols.insert(
            "phone".into(),
            phone.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        );
        cols.insert(
            "company".into(),
            company.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        );
        cols.insert(
            "notes".into(),
            notes.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        );
        cols.insert("billing_status".into(), serde_json::Value::String("active".into()));
        cols.insert("category".into(), category.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        cols.insert("lead_status".into(), serde_json::Value::String(lead_status.clone()));
        cols.insert("created_at".into(), serde_json::Value::String(now.clone()));
        cols.insert("updated_at".into(), serde_json::Value::String(now.clone()));
        cols.insert(
            "metadata".into(),
            serde_json::Value::String(serde_json::to_string(&metadata).unwrap_or_default()),
        );

        if let Err(e) = crate::sync::record_upsert("clients", &id, cols) {
            summary.errors.push(format!("Row {}: sync record failed: {}", row_num + 2, e));
            continue;
        }

        if let Err(e) = conn.execute(
            "INSERT INTO clients (id,name,email,phone,company,notes,billing_status,category,lead_status,created_at,updated_at,metadata)
             VALUES (?1,?2,?3,?4,?5,?6,'active',?9,?10,?7,?7,?8)",
            rusqlite::params![id, name, email, phone, company, notes, now, serde_json::to_string(&metadata).unwrap_or_default(), category, lead_status],
        ) {
            summary.errors.push(format!("Row {}: db insert: {}", row_num + 2, e));
            continue;
        }
        summary.imported += 1;
    }

    Ok(summary)
}

fn build_name(
    record: &csv::StringRecord,
    first_name_idx: Option<usize>,
    last_name_idx: Option<usize>,
    legacy_name_idx: Option<usize>,
) -> String {
    match (first_name_idx, last_name_idx) {
        (Some(fi), Some(li)) => {
            let first = record.get(fi).map(|s| s.trim()).unwrap_or("");
            let last = record.get(li).map(|s| s.trim()).unwrap_or("");
            let combined = format!("{} {}", first, last).trim().to_string();
            if !combined.is_empty() {
                return combined;
            }
        }
        (Some(fi), None) => {
            let s = record.get(fi).map(|s| s.trim()).unwrap_or("");
            if !s.is_empty() {
                return s.to_string();
            }
        }
        (None, Some(li)) => {
            let s = record.get(li).map(|s| s.trim()).unwrap_or("");
            if !s.is_empty() {
                return s.to_string();
            }
        }
        (None, None) => {}
    }
    if let Some(ni) = legacy_name_idx {
        record.get(ni).map(|s| s.trim().to_string()).unwrap_or_default()
    } else {
        String::new()
    }
}

fn build_metadata(
    record: &csv::StringRecord,
    indices: &[(String, usize)],
) -> serde_json::Map<String, serde_json::Value> {
    let mut meta = serde_json::Map::new();
    for (col, idx) in indices {
        if let Some(val) = record.get(*idx) {
            let trimmed = val.trim().to_string();
            if !trimmed.is_empty() {
                let key = col.to_lowercase().replace(' ', "_").replace('-', "_");
                meta.insert(key, serde_json::Value::String(trimmed));
            }
        }
    }
    meta
}
