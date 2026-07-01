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

/// The sheet-sync column mapping we can write into: (column-letter, value) pairs.
/// Reads the saved `sheet_sync_config` row (defaults mirror `get_sheet_sync_config`).
struct SheetMapping {
    sheet_url: String,
    name_col: String,
    first_name_col: String,
    last_name_col: String,
    email_col: String,
    phone_col: String,
    company_col: String,
    category_col: String,
    notes_col: String,
}

fn load_mapping() -> Option<SheetMapping> {
    let conn = pool().get().ok()?;
    let row = conn.query_row(
        "SELECT sheet_url, COALESCE(name_col,''), COALESCE(first_name_col,''), COALESCE(last_name_col,''), \
                COALESCE(email_col,''), COALESCE(phone_col,''), COALESCE(company_col,''), \
                COALESCE(category_col,''), COALESCE(notes_col,'') \
         FROM sheet_sync_config WHERE id=1",
        [],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
                r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?,
                r.get::<_, String>(7)?, r.get::<_, String>(8)?,
            ))
        },
    ).ok()?;
    let (sheet_url, name_col, first_name_col, last_name_col, email_col, phone_col, company_col, category_col, notes_col) = row;
    let sheet_url = sheet_url.filter(|s| !s.trim().is_empty())?;
    Some(SheetMapping {
        sheet_url, name_col, first_name_col, last_name_col,
        email_col, phone_col, company_col, category_col, notes_col,
    })
}

/// One approved client's fields, resolved for sheet write-back.
pub struct ClientRow {
    pub name: String,
    pub first_name: String,
    pub last_name: String,
    pub email: String,
    pub phone: String,
    pub company: String,
    pub category: String,
    pub notes: String,
}

/// Load an approved client's fields (built-ins + metadata) for the sheet row.
fn load_client_row(client_id: &str) -> Option<ClientRow> {
    let conn = pool().get().ok()?;
    let (name, email, phone, company, notes, metadata): (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = conn.query_row(
        "SELECT name, email, phone, company, notes, metadata FROM clients WHERE id=?1",
        [client_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).ok()?;
    let meta: serde_json::Value = metadata
        .and_then(|m| serde_json::from_str(&m).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let ms = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    // Category: first of the captured `categories` array, or the `category` field.
    let category = meta
        .get("categories")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ms("category"));
    Some(ClientRow {
        name,
        first_name: ms("first_name"),
        last_name: ms("last_name"),
        email: email.unwrap_or_default(),
        phone: phone.unwrap_or_default(),
        company: company.unwrap_or_default(),
        category,
        notes: notes.unwrap_or_default(),
    })
}

/// Build a row (Vec of cell strings) positioned by the configured column letters.
/// The vec is sized to the highest mapped column; unmapped cells are left blank.
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
    push(&mapping.notes_col, &c.notes);

    let width = cells.iter().map(|(i, _)| *i + 1).max().unwrap_or(0);
    let mut row = vec![String::new(); width];
    for (i, v) in cells {
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
