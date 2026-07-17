//! Write-back to the connected Google Sheet.
//!
//! Sheet SYNC historically only READS from the sheet (via its public CSV export
//! URL, no auth). This adds the opposite direction: when a captured lead is
//! APPROVED, write it to the same sheet, mapped to the columns configured in
//! `sheet_sync_config` (the same column letters used to read).
//!
//! The write is an UPSERT, not a blind append: we read the sheet's identifying
//! columns first, and if the lead is already there we UPDATE that row in place —
//! writing ONLY our mapped cells, so columns the sheet owns (and any manual edit)
//! survive untouched. Only a genuinely new lead is appended.
//!
//! Writing REQUIRES the Google Sheets API, which needs an
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

/// Convert a 0-based column index back to its letter(s) (0 → A, 26 → AA), so a
/// resolved row can be addressed cell-by-cell (`F1155`).
fn col_letter(mut idx: usize) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    s
}

/// A configured column letter as a 0-based index; `None` when unmapped.
fn col_opt(col: &str) -> Option<usize> {
    let c = col.trim();
    if c.is_empty() { None } else { Some(col_index(c)) }
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
    /// Row creation timestamp (RFC3339), for a mapped "Date Added" column.
    pub created_at: String,
    pub meta: serde_json::Value,
}

/// RFC3339 (`2026-03-02T14:22:01+00:00`) → `3/2/2026`, matching the date format the
/// sheet's existing rows already carry. Unparseable → empty (never written).
fn date_added(created_at: &str) -> String {
    let mut parts = created_at.get(..10).unwrap_or("").split('-');
    let year = parts.next().unwrap_or("");
    let month: u32 = parts.next().unwrap_or("").parse().unwrap_or(0);
    let day: u32 = parts.next().unwrap_or("").parse().unwrap_or(0);
    if year.len() != 4 || !year.chars().all(|c| c.is_ascii_digit()) || month == 0 || day == 0 {
        return String::new();
    }
    format!("{}/{}/{}", month, day, year)
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
            "created_at" => date_added(&self.created_at),
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
    let (name, email, phone, company, lead_status, notes, created_at, metadata): (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = conn.query_row(
        "SELECT name, email, phone, company, lead_status, notes, created_at, metadata FROM clients WHERE id=?1",
        [client_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
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
        created_at: created_at.unwrap_or_default(),
        meta,
    })
}

/// The cells this client owns: `(0-based column index, value)` for every column the
/// config maps — the SAME columns the reader consumes: the built-in `*_col` fields
/// plus every entry in `field_mapping` (custom-field / extra columns like tax id +
/// rep). A column we have no value for produces NO cell at all, which is what keeps
/// an in-place update from ever blanking data the sheet already holds.
fn build_cells(mapping: &SheetMapping, c: &ClientRow) -> Vec<(usize, String)> {
    let mut cells: Vec<(usize, String)> = Vec::new();
    let mut push = |col: &str, val: &str| {
        if !col.trim().is_empty() && !val.is_empty() {
            cells.push((col_index(col.trim()), val.to_string()));
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
    cells
}

/// Flatten the mapped cells into a positional row for APPEND (a brand-new row, so
/// there is nothing to preserve). The vec is sized to the highest mapped column;
/// unmapped cells are left blank.
fn build_row(mapping: &SheetMapping, c: &ClientRow) -> Vec<String> {
    let cells = build_cells(mapping, c);
    let width = cells.iter().map(|(i, _)| *i + 1).max().unwrap_or(0);
    let mut row = vec![String::new(); width];
    for (i, v) in cells {
        // Later pushes for the same column win (field_mapping can override a
        // built-in column if the user mapped both — last one wins, which is fine).
        row[i] = v;
    }
    row
}

/// The columns that identify a client on the sheet (0-based; `None` = unmapped).
struct MatchCols {
    email: Option<usize>,
    first: Option<usize>,
    last: Option<usize>,
    phone: Option<usize>,
}

/// The last 4 digits of a phone number, ignoring formatting. Empty when there
/// aren't 4 digits to compare — which makes the name+phone fallback refuse to match.
fn last4(phone: &str) -> String {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 4 {
        String::new()
    } else {
        digits[digits.len() - 4..].to_string()
    }
}

/// Locate this client's existing row (1-based sheet row number) in the grid read
/// back from the sheet. Email (trimmed, case-insensitive) identifies a client; a
/// client with NO email falls back to first+last name AND last-4-of-phone all
/// matching. Anything ambiguous (more than one hit) or unidentifiable → `None`, and
/// the caller appends instead of guessing which of Jack's rows to overwrite.
fn find_client_row(rows: &[Vec<String>], cols: &MatchCols, c: &ClientRow) -> Option<usize> {
    let cell = |row: &Vec<String>, idx: Option<usize>| -> String {
        idx.and_then(|i| row.get(i)).map(|s| s.trim().to_string()).unwrap_or_default()
    };
    let mut hits: Vec<usize> = Vec::new();
    let email = c.email.trim().to_lowercase();
    if !email.is_empty() {
        cols.email?;
        for (i, row) in rows.iter().enumerate() {
            if cell(row, cols.email).to_lowercase() == email {
                hits.push(i + 1);
            }
        }
    } else {
        let (first, last) = (c.first_name.trim().to_lowercase(), c.last_name.trim().to_lowercase());
        let tail = last4(&c.phone);
        if first.is_empty() || last.is_empty() || tail.is_empty()
            || cols.first.is_none() || cols.last.is_none() || cols.phone.is_none()
        {
            return None; // nothing identifying → append
        }
        for (i, row) in rows.iter().enumerate() {
            if cell(row, cols.first).to_lowercase() == first
                && cell(row, cols.last).to_lowercase() == last
                && last4(&cell(row, cols.phone)) == tail
            {
                hits.push(i + 1);
            }
        }
    }
    if hits.len() == 1 { Some(hits[0]) } else { None }
}

/// Column A is the sheet's IDENTITY column: it is not a client field and is
/// deliberately not in the config mapping, so it is hardcoded here. Every one of the
/// sheet's existing rows carries this formula, which derives the Lead ID
/// ("Cole-B.6858") from the first-name / last-name / phone cells on its OWN row. A
/// row we write must look identical to the rows that came before, so we stamp the
/// same formula with this row's number (USER_ENTERED makes Sheets store it as a
/// formula, not text). `None` when the columns it references aren't mapped.
fn lead_id_formula(m: &SheetMapping, row: usize) -> Option<String> {
    let first = m.first_name_col.trim();
    let last = m.last_name_col.trim();
    let phone = m.phone_col.trim();
    if first.is_empty() || last.is_empty() || phone.is_empty() {
        return None;
    }
    Some(format!(
        "=IF(OR(TRIM({first}{row})=\"\", TRIM({last}{row})=\"\"), \"\", \
         PROPER(TRIM({first}{row})) & \"-\" & UPPER(LEFT(TRIM({last}{row}),1)) & \".\" & \
         RIGHT(TRIM({phone}{row}),4))"
    ))
}

/// Pull the row number out of an API range like `Sheet1!A1156:AA1156` (the
/// `updatedRange` an append reports), so we know which row it landed on.
fn row_from_range(range: &str) -> Option<usize> {
    let cell = range.rsplit('!').next()?.split(':').next()?;
    let digits: String = cell.chars().skip_while(|c| !c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Read a range back as a grid of strings (missing/short rows simply come back
/// short — Sheets omits trailing empties).
async fn get_values(
    http: &reqwest::Client,
    spreadsheet: &str,
    access: &str,
    range: &str,
) -> Result<Vec<Vec<String>>> {
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/{}",
        spreadsheet, range
    );
    let resp = http
        .get(&url)
        .bearer_auth(access)
        .send()
        .await
        .context("sheets read request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets read failed: HTTP {} {}", status, text));
    }
    let body: serde_json::Value = resp.json().await.context("sheets read parse")?;
    Ok(body
        .get("values")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect()
                        })
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Write individual cells (`{"range": "F1155", "values": [["x"]]}`). Every other
/// cell on those rows is untouched — this is what makes the update non-destructive.
async fn batch_update(
    http: &reqwest::Client,
    spreadsheet: &str,
    access: &str,
    data: Vec<serde_json::Value>,
) -> Result<()> {
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values:batchUpdate",
        spreadsheet
    );
    let body = serde_json::json!({ "valueInputOption": "USER_ENTERED", "data": data });
    let resp = http
        .post(&url)
        .bearer_auth(access)
        .json(&body)
        .send()
        .await
        .context("sheets update request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets update failed: HTTP {} {}", status, text));
    }
    Ok(())
}

/// Write an approved client to the connected sheet: UPDATE their existing row in
/// place when we can identify it, otherwise APPEND a new one. Best-effort: returns
/// Ok(false) (skipped) when no sheet is configured or no Google token is available;
/// Err only on an actual API failure (which callers log, not surface).
pub async fn upsert_approved_client(client_id: &str) -> Result<bool> {
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

    let cells = build_cells(&mapping, &client);
    if cells.is_empty() {
        return Ok(false);
    }
    let http = reqwest::Client::new();

    // ONE read to locate the client: column A (the Lead ID, so we can tell whether a
    // row already has one) through the last identifying column.
    let cols = MatchCols {
        email: col_opt(&mapping.email_col),
        first: col_opt(&mapping.first_name_col),
        last: col_opt(&mapping.last_name_col),
        phone: col_opt(&mapping.phone_col),
    };
    let span = [cols.email, cols.first, cols.last, cols.phone].into_iter().flatten().max();
    let grid = match span {
        Some(end) => get_values(&http, &spreadsheet, &access, &format!("A:{}", col_letter(end))).await?,
        None => Vec::new(), // nothing identifying is mapped → we can only append
    };

    if let Some(row) = find_client_row(&grid, &cols, &client) {
        // UPDATE IN PLACE. We address each mapped cell individually rather than
        // writing a full-width row, so every column we don't own on this row (buyer
        // type, interest level, last contact, any manual edit) is left exactly as it
        // is. `build_cells` omits fields we have no value for, so an empty value can
        // never land on top of existing data either.
        let mut data: Vec<serde_json::Value> = cells
            .iter()
            .map(|(i, v)| serde_json::json!({
                "range": format!("{}{}", col_letter(*i), row),
                "values": [[v]],
            }))
            .collect();
        // Backfill the Lead ID only when this row has none — never clobber an
        // existing id or formula.
        let has_lead_id = grid
            .get(row - 1)
            .and_then(|r| r.first())
            .map(|a| !a.trim().is_empty())
            .unwrap_or(false);
        if !has_lead_id {
            if let Some(f) = lead_id_formula(&mapping, row) {
                data.push(serde_json::json!({ "range": format!("A{}", row), "values": [[f]] }));
            }
        }
        batch_update(&http, &spreadsheet, &access, data).await?;
        return Ok(true);
    }

    // APPEND: genuinely new (or not identifiable — we never guess).
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
        spreadsheet
    );
    let body = serde_json::json!({ "values": [build_row(&mapping, &client)] });
    let resp = http
        .post(&url)
        .bearer_auth(&access)
        .json(&body)
        .send()
        .await
        .context("sheets append request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("sheets append failed: HTTP {} {}", status, text));
    }
    // The append reports the row it landed on; stamp that row's Lead ID formula so
    // the new row is identical in shape to every row already on the sheet.
    let landed: serde_json::Value = resp.json().await.context("sheets append parse")?;
    let row = landed
        .get("updates")
        .and_then(|u| u.get("updatedRange"))
        .and_then(|r| r.as_str())
        .and_then(row_from_range);
    if let Some(f) = row.and_then(|r| lead_id_formula(&mapping, r).map(|f| (r, f))) {
        batch_update(
            &http,
            &spreadsheet,
            &access,
            vec![serde_json::json!({ "range": format!("A{}", f.0), "values": [[f.1]] })],
        )
        .await?;
    }
    Ok(true)
}

/// Bulk push: append EVERY active client that isn't already on the connected sheet.
///
/// Unlike `upsert_approved_client` (best-effort, silent, per-approval), this is an
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The real sheet's mapping: A Lead ID (formula, unmapped) | B Lead Source |
    /// C Date Added | D Rep | E Company | F First | G Last | H Title | I Email |
    /// J Phone | K..O address | P Primary category | Q Other | R..U | V Status |
    /// W Buyer Type | X Last Contact | Y Interest | Z Follow-up | AA Notes.
    fn mapping() -> SheetMapping {
        SheetMapping {
            writeback_enabled: true,
            sheet_url: "https://docs.google.com/spreadsheets/d/SHEET/edit".into(),
            name_col: "".into(), // A is the Lead ID formula, NOT the client name
            first_name_col: "F".into(),
            last_name_col: "G".into(),
            email_col: "I".into(),
            phone_col: "J".into(),
            company_col: "E".into(),
            category_col: "P".into(),
            lead_status_col: "V".into(),
            notes_col: "AA".into(),
            field_mapping: [("C", "created_at"), ("D", "lead_representative"), ("H", "title")]
                .into_iter()
                .map(|(c, f)| (c.to_string(), f.to_string()))
                .collect(),
        }
    }

    fn client(email: &str, first: &str, last: &str, phone: &str) -> ClientRow {
        ClientRow {
            name: format!("{} {}", first, last),
            first_name: first.into(),
            last_name: last.into(),
            email: email.into(),
            phone: phone.into(),
            company: "Acme".into(),
            category: "Phones".into(),
            lead_status: "New".into(),
            notes: "".into(),
            created_at: "2026-03-02T14:22:01.123456+00:00".into(),
            meta: serde_json::json!({ "title": "Buyer", "lead_representative": "Jack" }),
        }
    }

    /// Rows 1..4 of a sheet shaped like the real one (only the columns we read back).
    fn grid() -> Vec<Vec<String>> {
        let row = |a: &str, f: &str, g: &str, i: &str, j: &str| {
            let mut r = vec![String::new(); 10];
            r[0] = a.into();
            r[5] = f.into();
            r[6] = g.into();
            r[8] = i.into();
            r[9] = j.into();
            r
        };
        vec![
            row("Lead ID", "First Name", "Last Name", "Email", "Phone"), // header
            row("Cole-B.6858", "Cole", "Brown", "cole@acme.com", "(555) 123-6858"),
            row("Dana-W.1111", "Dana", "White", "", "555-999-1111"),
            row("Cole-B.2222", "Cole", "Brown", "", "555-000-2222"),
        ]
    }

    fn cols() -> MatchCols {
        MatchCols { email: Some(8), first: Some(5), last: Some(6), phone: Some(9) }
    }

    #[test]
    fn matches_row_by_email_case_insensitively() {
        let c = client("  COLE@Acme.com ", "Cole", "Brown", "555-123-6858");
        assert_eq!(find_client_row(&grid(), &cols(), &c), Some(2));
    }

    #[test]
    fn falls_back_to_name_and_last4_phone_when_client_has_no_email() {
        // Dana has no email on either side; name + last-4 pins row 3.
        let c = client("", "dana", "WHITE", "+1 (555) 999-1111");
        assert_eq!(find_client_row(&grid(), &cols(), &c), Some(3));
        // Same name, different last-4 → not this row → append, don't overwrite Dana.
        let other = client("", "Dana", "White", "555-999-4321");
        assert_eq!(find_client_row(&grid(), &cols(), &other), None);
    }

    #[test]
    fn no_match_when_unknown_ambiguous_or_unidentifiable() {
        // Unknown email → new lead → append.
        assert_eq!(find_client_row(&grid(), &cols(), &client("new@x.com", "New", "Guy", "555-000-0000")), None);
        // Two "Cole Brown" rows and no email to disambiguate → never guess.
        let mut g = grid();
        g[3][9] = "555-123-6858".into(); // same last-4 as row 2 → two hits
        assert_eq!(find_client_row(&g, &cols(), &client("", "Cole", "Brown", "555-123-6858")), None);
        // Nothing identifying at all.
        assert_eq!(find_client_row(&grid(), &cols(), &client("", "Cole", "", "555-123-6858")), None);
        assert_eq!(find_client_row(&grid(), &cols(), &client("", "Cole", "Brown", "")), None);
        // Email column unmapped → can't match on the email we have.
        let unmapped = MatchCols { email: None, ..cols() };
        assert_eq!(find_client_row(&grid(), &unmapped, &client("cole@acme.com", "Cole", "Brown", "555-123-6858")), None);
    }

    #[test]
    fn duplicate_emails_are_ambiguous() {
        let mut g = grid();
        g[3][8] = "cole@acme.com".into();
        assert_eq!(find_client_row(&g, &cols(), &client("cole@acme.com", "Cole", "Brown", "555-1")), None);
    }

    #[test]
    fn update_touches_only_mapped_cells_and_never_writes_a_blank() {
        // A client missing most fields: no notes, no title/rep metadata.
        let mut c = client("cole@acme.com", "Cole", "Brown", "555-123-6858");
        c.notes = "".into();
        c.company = "".into();
        c.meta = serde_json::json!({});
        let cells = build_cells(&mapping(), &c);

        // No cell may carry an empty value — that is what would blank Jack's data.
        assert!(cells.iter().all(|(_, v)| !v.is_empty()), "empty cell would blank existing data: {:?}", cells);

        let written: Vec<String> = cells.iter().map(|(i, _)| col_letter(*i)).collect();
        // Only the columns we actually have data for.
        assert_eq!(written, vec!["F", "G", "I", "J", "P", "V", "C"]);
        // Columns the sheet owns are never addressed: A (Lead ID), W (Buyer Type),
        // X (Last Contact), Y (Interest Level) — nor E/AA/D/H, blank on this client.
        for owned in ["A", "W", "X", "Y", "E", "AA", "D", "H"] {
            assert!(!written.contains(&owned.to_string()), "would overwrite column {}", owned);
        }
    }

    #[test]
    fn update_writes_the_full_mapped_set_when_data_is_present() {
        let cells = build_cells(&mapping(), &client("cole@acme.com", "Cole", "Brown", "555-123-6858"));
        let mut written: Vec<String> = cells.iter().map(|(i, _)| col_letter(*i)).collect();
        written.sort();
        assert_eq!(written, vec!["C", "D", "E", "F", "G", "H", "I", "J", "P", "V"]);
        // Notes (AA) is empty on this client → absent, as is the unmapped A.
        assert!(!written.contains(&"AA".to_string()));
        assert!(!written.contains(&"A".to_string()));
    }

    #[test]
    fn lead_id_formula_matches_the_sheets_existing_rows() {
        // Byte-for-byte the formula Jack's column A already carries, at row 2.
        assert_eq!(
            lead_id_formula(&mapping(), 2).unwrap(),
            r#"=IF(OR(TRIM(F2)="", TRIM(G2)=""), "", PROPER(TRIM(F2)) & "-" & UPPER(LEFT(TRIM(G2),1)) & "." & RIGHT(TRIM(J2),4))"#
        );
        // A newly appended row references its OWN row's cells.
        let f = lead_id_formula(&mapping(), 1155).unwrap();
        assert!(f.contains("TRIM(F1155)") && f.contains("TRIM(G1155)") && f.contains("RIGHT(TRIM(J1155),4)"), "{}", f);
        assert!(!f.contains("1156") && !f.contains("F2)"), "{}", f);
        // Semantics: Cole / Brown / (555) 123-6858 → "Cole-B.6858".
        assert_eq!(
            format!("{}-{}.{}", "Cole", "B", last4("(555) 123-6858")),
            "Cole-B.6858"
        );
        // Unmapped source column → no formula rather than a broken one.
        let m = SheetMapping { phone_col: "".into(), ..mapping() };
        assert_eq!(lead_id_formula(&m, 5), None);
    }

    #[test]
    fn date_added_matches_the_sheets_format() {
        assert_eq!(date_added("2026-03-02T14:22:01.123456+00:00"), "3/2/2026");
        assert_eq!(date_added("2026-12-25 00:00:00"), "12/25/2026");
        assert_eq!(date_added(""), "");
        assert_eq!(date_added("not-a-date"), "");
    }

    #[test]
    fn column_letters_round_trip() {
        for (idx, letter) in [(0usize, "A"), (2, "C"), (25, "Z"), (26, "AA"), (26 * 2, "BA")] {
            assert_eq!(col_letter(idx), letter);
            assert_eq!(col_index(letter), idx);
        }
    }

    #[test]
    fn reads_the_landed_row_from_an_append_response() {
        assert_eq!(row_from_range("Sheet1!A1156:AA1156"), Some(1156));
        assert_eq!(row_from_range("'My Leads'!A2:AA2"), Some(2));
        assert_eq!(row_from_range("A7"), Some(7));
        assert_eq!(row_from_range("bogus"), None);
    }
}
