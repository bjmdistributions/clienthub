//! Google Sheet clone — "read-and-rebuild" copy of a view-only supplier load
//! sheet into a brand-new spreadsheet the user owns.
//!
//! A wholesale broker receives a supplier "load" sheet shared view-only with
//! "make a copy" disabled. This tool reads the data the user is ALREADY
//! authorized to VIEW (via their Google OAuth token + the `spreadsheets` scope
//! they've already granted) and rebuilds it into a new spreadsheet they own, so
//! they can re-price and forward it.
//!
//! It works ONLY on sheets the user's Google account can view — it relies on
//! real Google permissions (the Drive "disable copy" flag does not block
//! structured Sheets-API reads) and must NOT scrape or circumvent auth. We do
//! NOT add a Drive scope or change the OAuth consent; the already-granted
//! `spreadsheets` scope is sufficient for both the read and the create.
//!
//! Access is gated to the top "unlimited" plan, enforced SERVER-side here (not
//! just the UI): before any Google work we fetch the org's plan from the server.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

/// Result of a successful clone. `#[serde(rename_all = "camelCase")]` so JS sees
/// `{ title, newUrl, sheetCount, warnings }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub title: String,
    pub new_url: String,
    pub sheet_count: usize,
    pub warnings: Vec<String>,
}

/// Extract the spreadsheet id from a Google Sheets URL
/// (`https://docs.google.com/spreadsheets/d/<ID>/edit...`).
/// Mirrors `sheet_writeback::spreadsheet_id`.
fn spreadsheet_id(url: &str) -> Option<String> {
    let after = url.split("/d/").nth(1)?;
    let id = after.split('/').next()?.split('?').next()?.split('#').next()?;
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// An HTTP client with a sane timeout (mirrors `netsync::http`). Sheets grid
/// reads/creates can be large, so we allow a generous window.
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_default()
}

/// Server-authoritative plan gate. Fetches the signed-in workspace's plan from
/// the server and returns Ok(()) only when it's the top "unlimited" tier.
/// Reuses `netsync::config()` for the base url + session token, and calls the
/// same `GET {base}/api/org` endpoint `netsync::get_my_plan` uses.
async fn require_unlimited_plan() -> Result<(), String> {
    let cfg = crate::netsync::config()
        .ok_or("Sign in to your workspace to use this tool.")?;

    let resp = http()
        .get(format!("{}/api/org", cfg.url.trim_end_matches('/')))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|_| "Sign in to your workspace to use this tool.".to_string())?;

    if !resp.status().is_success() {
        return Err("Sign in to your workspace to use this tool.".into());
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|_| "Sign in to your workspace to use this tool.".to_string())?;

    let plan = body.get("plan").and_then(Value::as_str).unwrap_or_default();
    if plan != "unlimited" {
        return Err("Sheet copy is available on the Unlimited plan.".into());
    }
    Ok(())
}

/// Whitelist of cell fields we keep when rebuilding a cell. Everything else
/// (`effectiveValue`, `effectiveFormat`, `pivotTable`, …) is dropped so
/// `spreadsheets.create` accepts the body and can round-trip it.
fn clean_cell(cell: &Value, warnings: &mut WarnFlags) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(v) = cell.get("userEnteredValue") {
        out.insert("userEnteredValue".into(), v.clone());
    }
    if let Some(v) = cell.get("userEnteredFormat") {
        out.insert("userEnteredFormat".into(), v.clone());
    }
    if let Some(v) = cell.get("note") {
        out.insert("note".into(), v.clone());
    }
    if let Some(v) = cell.get("textFormatRuns") {
        out.insert("textFormatRuns".into(), v.clone());
    }
    if let Some(v) = cell.get("dataValidation") {
        // Data validation is kept optimistically; if create later 400s we can't
        // know which cell caused it, so we just flag that validation exists so
        // the caller can warn. (Kept simple per the spec's robustness guidance.)
        out.insert("dataValidation".into(), v.clone());
        warnings.data_validation = true;
    }
    // pivotTable lives on the cell and is not creatable via .create.
    if cell.get("pivotTable").is_some() {
        warnings.pivot_tables = true;
    }
    Value::Object(out)
}

/// Rebuild one data block (a `GridData`) keeping only round-trippable fields.
fn clean_data_block(block: &Value, warnings: &mut WarnFlags) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(v) = block.get("startRow") {
        out.insert("startRow".into(), v.clone());
    }
    if let Some(v) = block.get("startColumn") {
        out.insert("startColumn".into(), v.clone());
    }
    if let Some(rows) = block.get("rowData").and_then(Value::as_array) {
        let new_rows: Vec<Value> = rows
            .iter()
            .map(|row| {
                let mut row_out = serde_json::Map::new();
                if let Some(values) = row.get("values").and_then(Value::as_array) {
                    let new_values: Vec<Value> = values
                        .iter()
                        .map(|c| clean_cell(c, warnings))
                        .collect();
                    row_out.insert("values".into(), Value::Array(new_values));
                }
                Value::Object(row_out)
            })
            .collect();
        out.insert("rowData".into(), Value::Array(new_rows));
    }
    // Row heights + column widths.
    if let Some(v) = block.get("rowMetadata") {
        out.insert("rowMetadata".into(), v.clone());
    }
    if let Some(v) = block.get("columnMetadata") {
        out.insert("columnMetadata".into(), v.clone());
    }
    Value::Object(out)
}

/// Rebuild one sheet's `properties`, assigning a fresh stable `sheet_id` (used to
/// re-anchor this sheet's merges below) and keeping only the round-trippable
/// property fields. We deliberately do NOT reuse the source sheetId — create
/// would still accept it, but re-stamping every sheet 0..n keeps ids unique and
/// lets us rewrite merges to match without tracking the original id map.
fn clean_sheet_properties(props: &Value, sheet_id: i64) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("sheetId".into(), json!(sheet_id));
    if let Some(v) = props.get("title") {
        out.insert("title".into(), v.clone());
    }
    if let Some(v) = props.get("index") {
        out.insert("index".into(), v.clone());
    }
    if let Some(grid) = props.get("gridProperties").and_then(Value::as_object) {
        let mut g = serde_json::Map::new();
        for key in [
            "rowCount",
            "columnCount",
            "frozenRowCount",
            "frozenColumnCount",
            "hideGridlines",
        ] {
            if let Some(v) = grid.get(key) {
                g.insert(key.into(), v.clone());
            }
        }
        out.insert("gridProperties".into(), Value::Object(g));
    }
    if let Some(v) = props.get("tabColor") {
        out.insert("tabColor".into(), v.clone());
    }
    if let Some(v) = props.get("tabColorStyle") {
        out.insert("tabColorStyle".into(), v.clone());
    }
    if let Some(v) = props.get("rightToLeft") {
        out.insert("rightToLeft".into(), v.clone());
    }
    Value::Object(out)
}

/// Rebuild one sheet, keeping properties/merges/data and stripping everything
/// `.create` rejects or can't round-trip (charts, banded ranges, conditional
/// formats, protected ranges, filter views, basic filter, slicers, developer
/// metadata, …). Detected features flip `warnings` flags.
fn clean_sheet(sheet: &Value, sheet_id: i64, warnings: &mut WarnFlags) -> Value {
    let mut out = serde_json::Map::new();

    match sheet.get("properties") {
        Some(props) => {
            out.insert("properties".into(), clean_sheet_properties(props, sheet_id));
        }
        // Even a property-less sheet needs a sheetId so its merges resolve.
        None => {
            out.insert("properties".into(), json!({ "sheetId": sheet_id }));
        }
    }
    // Re-anchor every merge to THIS sheet's freshly-assigned id. Source merges
    // carry the original sheetId; without this rewrite, create returns
    // "No sheet with id: N" for any sheet whose id changed (a common 400 on
    // multi-tab load sheets with merged header cells).
    if let Some(merges) = sheet.get("merges").and_then(Value::as_array) {
        let remapped: Vec<Value> = merges
            .iter()
            .map(|m| {
                let mut mm = m.clone();
                if let Some(obj) = mm.as_object_mut() {
                    obj.insert("sheetId".into(), json!(sheet_id));
                }
                mm
            })
            .collect();
        if !remapped.is_empty() {
            out.insert("merges".into(), Value::Array(remapped));
        }
    }
    if let Some(data) = sheet.get("data").and_then(Value::as_array) {
        let new_data: Vec<Value> = data
            .iter()
            .map(|block| clean_data_block(block, warnings))
            .collect();
        out.insert("data".into(), Value::Array(new_data));
    }

    // Detect (and drop) anything create can't take.
    if non_empty_array(sheet, "charts") {
        warnings.charts = true;
    }
    if non_empty_array(sheet, "bandedRanges") {
        warnings.banded_ranges = true;
    }
    if non_empty_array(sheet, "conditionalFormats") {
        warnings.conditional_formats = true;
    }
    if non_empty_array(sheet, "protectedRanges") {
        warnings.protected_ranges = true;
    }
    if non_empty_array(sheet, "filterViews") {
        warnings.filter_views = true;
    }
    if sheet.get("basicFilter").is_some() {
        warnings.filter_views = true;
    }
    if non_empty_array(sheet, "slicers") {
        warnings.slicers = true;
    }
    if non_empty_array(sheet, "developerMetadata") {
        warnings.developer_metadata = true;
    }

    Value::Object(out)
}

fn non_empty_array(v: &Value, key: &str) -> bool {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| !a.is_empty())
        .unwrap_or(false)
}

/// Which strippable features were detected in the source. Rendered to
/// human-readable warnings only for features actually present.
#[derive(Default)]
struct WarnFlags {
    charts: bool,
    banded_ranges: bool,
    conditional_formats: bool,
    protected_ranges: bool,
    filter_views: bool,
    slicers: bool,
    developer_metadata: bool,
    pivot_tables: bool,
    data_validation: bool,
}

impl WarnFlags {
    fn into_messages(self) -> Vec<String> {
        let mut w = Vec::new();
        if self.charts {
            w.push("Charts were not copied".into());
        }
        if self.conditional_formats {
            w.push("Conditional formatting was not copied".into());
        }
        if self.pivot_tables {
            w.push("Pivot tables were not copied".into());
        }
        if self.banded_ranges {
            w.push("Alternating-color banding was not copied".into());
        }
        if self.protected_ranges {
            w.push("Protected ranges were not copied".into());
        }
        if self.filter_views {
            w.push("Filters were not copied".into());
        }
        if self.slicers {
            w.push("Slicers were not copied".into());
        }
        if self.developer_metadata {
            w.push("Developer metadata was not copied".into());
        }
        if self.data_validation {
            w.push("Data validation rules may not have copied".into());
        }
        w
    }
}

/// Read a view-only Google Sheet the user is authorized to see and rebuild it
/// into a NEW spreadsheet they own. Gated to the Unlimited plan (server-checked).
#[tauri::command]
pub async fn clone_google_sheet(url: String) -> Result<CloneResult, String> {
    // 1. Plan gate FIRST — server-authoritative, before any Google work.
    require_unlimited_plan().await?;

    // 2. Access token (already-granted spreadsheets scope).
    let token = crate::email::oauth2_access_token()
        .await
        .map_err(|_| "Connect your Google account in Settings → Email first, then try again.".to_string())?;

    // 3. Parse the source spreadsheet id.
    let id = spreadsheet_id(&url)
        .ok_or("That doesn't look like a Google Sheets link.")?;

    let client = http();

    // 4. Read the source sheet WITH grid data.
    let read_resp = client
        .get(format!(
            "https://sheets.googleapis.com/v4/spreadsheets/{}?includeGridData=true",
            id
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| {
            "Can't read that sheet. Make sure it's shared with your Google account (view access) and the link is correct.".to_string()
        })?;

    if !read_resp.status().is_success() {
        return Err("Can't read that sheet. Make sure it's shared with your Google account (view access) and the link is correct.".into());
    }

    let source: Value = read_resp.json().await.map_err(|_| {
        "Can't read that sheet. Make sure it's shared with your Google account (view access) and the link is correct.".to_string()
    })?;

    // 5. Transform into a NEW create body.
    let mut warnings = WarnFlags::default();

    let source_title = source
        .get("properties")
        .and_then(|p| p.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Untitled");
    let new_title = format!("{} — copy", source_title);

    let new_sheets: Vec<Value> = source
        .get("sheets")
        .and_then(Value::as_array)
        .map(|sheets| {
            sheets
                .iter()
                .enumerate()
                .map(|(i, s)| clean_sheet(s, i as i64, &mut warnings))
                .collect()
        })
        .unwrap_or_default();

    if new_sheets.is_empty() {
        return Err("That sheet appears to be empty or couldn't be read.".into());
    }

    let create_body = json!({
        "properties": { "title": new_title },
        "sheets": new_sheets,
    });

    // 6. Create the new spreadsheet.
    let create_resp = client
        .post("https://sheets.googleapis.com/v4/spreadsheets")
        .bearer_auth(&token)
        .json(&create_body)
        .send()
        .await
        .map_err(|_| {
            "That sheet is too large or complex to copy automatically — try copying one tab at a time.".to_string()
        })?;

    if !create_resp.status().is_success() {
        return Err("That sheet is too large or complex to copy automatically — try copying one tab at a time.".into());
    }

    let created: Value = create_resp.json().await.map_err(|_| {
        "The copy was created but the server response couldn't be read — check your Google Drive.".to_string()
    })?;

    let new_url = created
        .get("spreadsheetUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = created
        .get("properties")
        .and_then(|p| p.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(source_title)
        .to_string();
    let sheet_count = created
        .get("sheets")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(new_sheets.len());

    Ok(CloneResult {
        title,
        new_url,
        sheet_count,
        warnings: warnings.into_messages(),
    })
}
