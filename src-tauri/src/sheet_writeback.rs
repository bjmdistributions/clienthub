//! Write-back to the connected Google Sheet.
//!
//! Sheet SYNC historically only READS from the sheet (via its public CSV export
//! URL, no auth). This adds the opposite direction: when a captured lead is
//! APPROVED, append a row to the same sheet, mapped to the columns configured in
//! `sheet_sync_config` (the same column letters used to read).
//!
//! Appending REQUIRES the Google Sheets API (`values:append`), which needs an
//! OAuth access token carrying the `spreadsheets` scope. We reuse the existing
//! "oauth" Google token (`crate::email::oauth2_access_token`). If the sheet isn't
//! configured, no token is available, or the API rejects the call (e.g. the token
//! lacks the Sheets scope), we SKIP SILENTLY — write-back is best-effort and must
//! never block an approval.

use anyhow::{anyhow, Context, Result};

use crate::db::pool;

/// Convert a spreadsheet column letter (A, B, …, AA) to a 0-based index.
fn col_index(col: &str) -> usize {
    let mut idx = 0usize;
    for c in col.chars() {
        if !c.is_ascii_uppercase() {
            break;
        }
        idx = idx * 26 + (c as usize) - ('A' as usize) + 1;
    }
    idx.saturating_sub(1)
}

/// Extract the spreadsheet id from a Google Sheets URL
/// (`https://docs.google.com/spreadsheets/d/<ID>/edit...`).
fn spreadsheet_id(url: &str) -> Option<String> {
    let after = url.split("/d/").nth(1)?;
    let id = after.split('/').next()?.split('?').next()?.split('#').next()?;
    if id.is_empty() { None } else { Some(id.to_string()) }
}

/// The sheet-sync column mapping we can write into. Mirrors the READER
/// (`sheet_sync_config` + `field_mapping_json`) so an appended row lines up with
/// the same columns the sync reads. `field_mapping` maps a column letter → a field
/// key (as saved by the UI, e.g. `"cf:tax_id"` or `"lead_representative"`), the
/// same structure the reader consumes.
struct SheetMapping {
    /// User toggle (Settings → Google Sheets). When false, write-back is off even
    /// if a sheet + Google token exist. Defaults on for existing configs.
    writeback_enabled: bool,
    sheet_url: String,
    name_col: String,
    first_name_col: String,
    last_name_col: String,
    email_col: String,
    phone_col: String,
    company_col: String,
    category_col: String,
    lead_status_col: String,
    notes_col: String,
    /// column-letter → field key (custom-field / extra columns).
    field_mapping: std::collections::BTreeMap<String, String>,
}

fn load_mapping() -> Option<SheetMapping> {
    let conn = pool().get().ok()?;
    let row = conn.query_row(
        "SELECT sheet_url, COALESCE(name_col,''), COALESCE(first_name_col,''), COALESCE(last_name_col,''), \
                COALESCE(email_col,''), COALESCE(phone_col,''), COALESCE(company_col,''), \
                COALESCE(category_col,''), COALESCE(lead_status_col,''), COALESCE(notes_col,''), \
                COALESCE(field_mapping_json,'{}'), COALESCE(writeback_enabled,1) \
         FROM sheet_sync_config WHERE id=1",
        [],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
                r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?,
                r.get::<_, String>(7)?, r.get::<_, String>(8)?, r.get::<_, String>(9)?,
                r.get::<_, String>(10)?, r.get::<_, i64>(11)?,
            ))
        },
    ).ok()?;
    let (sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, lead_status_col, notes_col, field_mapping_json, writeback_enabled) = row;
    let sheet_url = sheet_url.filter(|s| !s.trim().is_empty())?;
    // Parse the reader's custom-field mapping: { "<col letter>": "<field key>" }.
    let field_mapping: std::collections::BTreeMap<String, String> =
        serde_json::from_str::<serde_json::Value>(&field_mapping_json)
            .ok()
            .and_then(|v| v.as_object().map(|o| {
                o.iter()
                    .filter_map(|(col, name)| name.as_str().map(|n| (col.clone(), n.to_string())))
                    .collect()
            }))
            .unwrap_or_default();
    Some(SheetMapping {
        writeback_enabled: writeback_enabled != 0,
        sheet_url, name_col, first_name_col, last_name_col,
        email_col, phone_col, company_col, category_col, lead_status_col, notes_col,
        field_mapping,
    })
}

/// One approved client's fields, resolved for sheet write-back. `meta` carries the
/// raw metadata so custom-field columns (tax id, rep, address parts, …) can be
/// filled by key, matching the reader.
pub struct ClientRow {
    pub name: String,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub phone: String,
    pub company: String,
    pub category: String,
    pub lead_status: String,
    pub notes: String,
    pub meta: serde_json::Value,
}

impl ClientRow {
    /// Resolve a value for a mapped field key. Handles the built-in metadata keys
    /// used across capture (`tax_id`, `lead_representative`/`sales_rep`, address
    /// parts, first/last name) and falls back to any metadata key of that name, so
    /// whatever column the reader maps we can fill. `cf:` prefixes are stripped to
    /// match the reader.
    fn field_value(&self, raw_key: &str) -> String {
        let key = raw_key.strip_prefix("cf:").unwrap_or(raw_key);
        let ms = |k: &str| self.meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        match key {
            "name" => self.name.clone(),
            "first_name" => self.first_name.clone(),
            "last_name" => self.last_name.clone(),
            "email" => self.email.clone(),
            "phone" => self.phone.clone(),
            "company" => self.company.clone(),
            "category" => self.category.clone(),
            "lead_status" => self.lead_status.clone(),
            "notes" => self.notes.clone(),
            // Rep column may be mapped under either metadata key the app writes.
            "lead_representative" | "rep" | "sales_rep" => {
                let v = ms("lead_representative");
                if v.is_empty() { ms("sales_rep") } else { v }
            }
            // Any other key → look it up directly in metadata (tax_id, street_address,
            // city, state, zip_code, country, title, and any custom `cf:` field).
            other => ms(other),
        }
    }
}

/// Load an approved client's fields (built-ins + metadata) for the sheet row.
fn load_client_row(client_id: &str) -> Option<ClientRow> {
    let conn = pool().get().ok()?;
    let (name, email, phone, company, lead_status, notes, metadata): (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = conn.query_row(
        "SELECT name, email, phone, company, lead_status, notes, metadata FROM clients WHERE id=?1",
        [client_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
    ).ok()?;
    let meta: serde_json::Value = metadata
        .and_then(|m| serde_json::from_str(&m).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let ms = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Category cell: all captured categories, comma-joined + deduped
    // case-insensitively; falls back to the single `category` field.
    let category = {
        let mut seen = std::collections::HashSet::new();
        let joined: Vec<String> = meta
            .get("categories")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty() && seen.insert(s.to_lowercase()))
                    .collect()
            })
            .unwrap_or_default();
        if joined.is_empty() { ms("category") } else { joined.join(", ") }
    };
    Some(ClientRow {
        name,
        first_name: ms("first_name"),
        last_name: ms("last_name"),
        email: email.unwrap_or_default(),
        phone: phone.unwrap_or_default(),
        company: company.unwrap_or_default(),
        category,
        lead_status: lead_status.unwrap_or_default(),
        notes: notes.unwrap_or_default(),
        meta,
    })
}

/// Build a row (Vec of cell strings) positioned by the configured column letters —
/// the SAME columns the reader consumes: the built-in `*_col` fields plus every
/// entry in `field_mapping` (custom-field / extra columns like tax id + rep). The
/// vec is sized to the highest mapped column; unmapped cells are left blank.
fn build_row(mapping: &SheetMapping, c: &ClientRow) -> Vec<String> {
    let mut cells: Vec<(usize, String)> = Vec::new();
    let mut push = |col: &str, val: &str| {
        if !col.is_empty() && !val.is_empty() {
            cells.push((col_index(col), val.to_string()));
        }
    };
    push(&mapping.name_col, &c.name);
    push(&mapping.first_name_col, &c.first_name);
    push(&mapping.last_name_col, &c.last_name);
    push(&mapping.email_col, &c.email);
    push(&mapping.phone_col, &c.phone);
    push(&mapping.company_col, &c.company);
    push(&mapping.category_col, &c.category);
    push(&mapping.lead_status_col, &c.lead_status);
    push(&mapping.notes_col, &c.notes);
    // Custom-field / extra columns: fill each mapped column from the client's data
    // by the mapped field key (tax id, rep, address parts, custom fields, …).
    for (col, field_key) in &mapping.field_mapping {
        let val = c.field_value(field_key);
        push(col, &val);
    }

    let width = cells.iter().map(|(i, _)| *i + 1).max().unwrap_or(0);
    let mut row = vec![String::new(); width];
    for (i, v) in cells {
        // Later pushes for the same column win (field_mapping can override a
        // built-in column if the user mapped both — last one wins, which is fine).
        row[i] = v;
    }
    row
}

/// Append an approved client as a new row on the connected sheet. Best-effort:
/// returns Ok(false) (skipped) when no sheet is configured or no Google token is
/// available; Err only on an actual API failure (which callers log, not surface).
pub async fn append_approved_client(client_id: &str) -> Result<bool> {
    let mapping = match load_mapping() {
        Some(m) => m,
        None => return Ok(false), // no sheet configured → skip silently
    };
    if !mapping.writeback_enabled {
        return Ok(false); // user turned write-back off in Settings → skip silently
    }
    let spreadsheet = match spreadsheet_id(&mapping.sheet_url) {
        Some(s) => s,
        None => return Ok(false),
    };
    let client = match load_client_row(client_id) {
        Some(c) => c,
        None => return Ok(false),
    };
    // Reuse the existing Google OAuth token. Absent → skip silently (the user
    // hasn't connected Google, or connected without the Sheets scope).
    let access = match crate::email::oauth2_access_token().await {
        Ok(t) => t,
        Err(_) => return Ok(false),
    };

    let row = build_row(&mapping, &client);
    if row.is_empty() {
        return Ok(false);
    }

    // Sheets API: append after the last row of the first sheet tab.
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
        spreadsheet
    );
    let body = serde_json::json!({ "values": [row] });
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(access)
        .json(&body)
        .send()
        .await
        .context("sheets append request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets append failed: HTTP {} {}", status, text));
    }
    Ok(true)
}

/// Bulk push: append EVERY active client that isn't already on the connected sheet.
///
/// Unlike `append_approved_client` (best-effort, silent, per-approval), this is an
/// explicit user action from Settings, so it returns loud errors and does NOT require
/// `writeback_enabled` — the button click IS the consent. Deduplicates against the
/// sheet by reading the mapped email column first, so re-running is safe.
///
/// Returns `{ added, skipped, total }` where `skipped` = clients already present.
#[tauri::command]
pub async fn sync_all_clients_to_sheet() -> Result<serde_json::Value, String> {
    let mapping = load_mapping()
        .ok_or_else(|| "Connect a Google Sheet in Settings → Google Sheets first.".to_string())?;
    let spreadsheet = spreadsheet_id(&mapping.sheet_url)
        .ok_or_else(|| "Connect a Google Sheet in Settings → Google Sheets first.".to_string())?;
    let access = crate::email::oauth2_access_token()
        .await
        .map_err(|_| "Connect your Google account in Settings → Google Sheets first.".to_string())?;

    let http = reqwest::Client::new();

    // DEDUP: read the mapped email column and collect existing addresses (lowercased).
    // If no email column is mapped, dedup is off — we append every active client.
    let dedup_on = !mapping.email_col.trim().is_empty();
    let mut existing_emails: std::collections::HashSet<String> = std::collections::HashSet::new();
    if dedup_on {
        let col = mapping.email_col.trim();
        let url = format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}:{}",
            spreadsheet, col, col
        );
        let resp = http
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| format!("Failed to read the sheet's email column: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Failed to read the sheet (HTTP {}): {}", status, text));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse the sheet's email column: {}", e))?;
        // `values` is a 2-D array of rows; each row is an array of cells. Add every
        // non-empty cell lowercased — matching by exact lowercased email is safe, so we
        // don't need to special-case a header row (a header like "Email" simply won't
        // collide with a real address).
        if let Some(rows) = body.get("values").and_then(|v| v.as_array()) {
            for row in rows {
                if let Some(cells) = row.as_array() {
                    for cell in cells {
                        if let Some(s) = cell.as_str() {
                            let e = s.trim().to_lowercase();
                            if !e.is_empty() {
                                existing_emails.insert(e);
                            }
                        }
                    }
                }
            }
        }
    }

    // Gather all active (approved) client ids — skip pending/rejected. The clients
    // table has no `archived` column (only invoices/deals/deal_flows do), so
    // approval_status alone selects the accepted book.
    let ids: Vec<String> = {
        let conn = pool().get().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM clients WHERE COALESCE(approval_status,'active')='active'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r.map_err(|e| e.to_string())?);
        }
        v
    };

    // Build rows for clients not already in the sheet. Dedup within this batch too, so
    // two clients sharing an email don't both get appended.
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut skipped = 0usize;
    let mut batch_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for id in &ids {
        let client = match load_client_row(id) {
            Some(c) => c,
            None => continue,
        };
        if dedup_on {
            let e = client.email.trim().to_lowercase();
            if !e.is_empty() && (existing_emails.contains(&e) || !batch_seen.insert(e)) {
                skipped += 1;
                continue;
            }
        }
        let row = build_row(&mapping, &client);
        if row.is_empty() {
            continue;
        }
        rows.push(row);
    }

    let added = rows.len();

    // Append in chunks of <=500 rows per request.
    for chunk in rows.chunks(500) {
        let url = format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
            spreadsheet
        );
        let body = serde_json::json!({ "values": chunk });
        let resp = http
            .post(&url)
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to append to the sheet: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Sheets append failed (HTTP {}): {}", status, text));
        }
    }

    Ok(serde_json::json!({
        "added": added,
        "skipped": skipped,
        "total": added + skipped,
        "dedup": dedup_on,
    }))
}
